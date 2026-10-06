"""Botworker incident — read-only backlog audit (Part A config + Part B audit).

READ-ONLY: find/find_one/count only. Prints hashed IDs and metadata only —
no text, raw_payload, customer names, phones, order numbers, secrets, or URI.
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone


def h(v):
    """Hash an ID; never print the raw value."""
    return hashlib.sha256(str(v).encode()).hexdigest()[:12] if v is not None else None


# ── Claim status contract (mirror of runtime owner) ─────────────────
# CLAIM_TERMINAL_STATUSES lives in botWorkerService.ts — pinned here so the
# audit can claim "terminal" only for statuses it has evidence for.
KNOWN_TERMINAL_STATUSES = {
    # current contract (botWorkerService.ts CLAIM_TERMINAL_STATUSES)
    "trigger_matched", "bot_answered", "handed_off", "bot_failed",
    "no_action", "workflow_actioned", "workflow_resumed",
    # legacy terminal names seen historically
    "processed", "handoff", "skipped", "answered",
}
# only status whose non-terminal semantics are contractually pinned
KNOWN_NON_TERMINAL_STATUSES = {"processing"}


def classify_claim_status(status):
    """terminal | processing | unknown (missing/empty) | unrecognized.

    unrecognized = non-empty string outside both known sets — surfaced for
    review, never claimed terminal (a future non-terminal must not become a
    false positive, a future terminal must not vanish)."""
    if status is None or status == "":
        return "unknown"
    if status in KNOWN_NON_TERMINAL_STATUSES:
        return "processing"
    if status in KNOWN_TERMINAL_STATUSES:
        return "terminal"
    return "unrecognized"


def terminal_statuses_per_mid(claims, mids):
    """Split already-fetched claim docs into per-mid terminal statuses +
    a flagged list for unknown/unrecognized (hashed ids + raw status enum —
    status strings are code enums, not customer data)."""
    per_mid = {m: [] for m in mids}
    flagged = []
    for c in claims:
        cls = classify_claim_status(c.get("status"))
        if cls == "terminal":
            mid = c.get("message_id")
            if mid in per_mid:
                per_mid[mid].append(c.get("status"))
        elif cls in ("unknown", "unrecognized"):
            flagged.append({
                "message_id_hash": h(c.get("message_id")),
                "claim_id_hash": h(c.get("_id")),
                "class": cls,
                "status": c.get("status"),
            })
    return per_mid, flagged


# ── Reply linkage contract ──────────────────────────────────────────
# Runtime writes replies with EITHER scalar inbound_message_id OR the
# batch array inbound_message_ids (current workflow replies carry scalar
# mid__wf<N> AND the array; historical wf replies may have ONLY the
# suffixed scalar). The audit must match all three shapes.
def build_reply_query(mids):
    mids = list(mids)
    wf_pat = "^(" + "|".join(re.escape(m) for m in mids) + ")__wf\\d+$" if mids else None
    clauses = [
        {"inbound_message_id": {"$in": mids}},
        {"inbound_message_ids": {"$in": mids}},
    ]
    if wf_pat:
        clauses.append({"inbound_message_id": {"$regex": wf_pat}})
    return {"$or": clauses}


def reply_references_mid(reply, mid):
    scalar = reply.get("inbound_message_id")
    if scalar == mid:
        return True
    # workflow delivered reply: scalar is <mid>__wf<N> (digits required —
    # startswith alone would wrongly match "__wfx" lookalikes)
    if isinstance(scalar, str) and re.fullmatch(re.escape(mid) + r"__wf\d+", scalar):
        return True
    return mid in (reply.get("inbound_message_ids") or [])


def iso(v):
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).isoformat() if v.tzinfo else v.replace(tzinfo=timezone.utc).isoformat()
    return str(v) if v is not None else None


def main():
    # lazy import — keeps module import pure (no .env read) so the focused
    # test can exercise helpers without touching secrets or Mongo
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from shopeechat import knowledge_base

    db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    db = knowledge_base._build_admin_client()[db_name]
    names = db.list_collection_names()

    def coll(env_key, default):
        n = os.environ.get(env_key, "").strip()
        if n and n in names:
            return db[n]
        return db[default if default in names else f"{default}_shp" if f"{default}_shp" in names else default]

    cfg_coll = coll("ADMIN_MONGO_COLLECTION_SYSTEM_CONFIGS", "system_configs")
    buf_coll = coll("ADMIN_MONGO_COLLECTION_BUFFER_MESSAGES", "buffer_messages")
    proc_coll = coll("ADMIN_MONGO_COLLECTION_CHAT_PROCESSING", "chat_processing")
    msg_coll = coll("ADMIN_MONGO_COLLECTION_MESSAGES", "messages")
    reply_coll = coll("ADMIN_MONGO_COLLECTION_SHADOW_REPLIES", "shadow_replies")
    tsc_coll = coll("ADMIN_MONGO_COLLECTION_TEST_STATUS_CONVERSATION", "test_status_conversation")
    sc_coll = coll("ADMIN_MONGO_COLLECTION_STATUS_CONVERSATION", "status_conversation")

    out = {"db": db_name}

    # ── Part A: main_config (sanitized) ──────────────────────────────
    cfg = cfg_coll.find_one({"config_key": "main_config"}) or {}
    out["config"] = {
        "bot_worker_enabled": cfg.get("bot_worker_enabled"),
        "bot_worker_interval_ms": cfg.get("bot_worker_interval_ms"),
        "bot_worker_concurrency": cfg.get("bot_worker_concurrency"),
        "bot_buffer_enabled": cfg.get("bot_buffer_enabled"),
        "bot_buffer_window_ms": cfg.get("bot_buffer_window_ms"),
        "bot_buffer_max_messages": cfg.get("bot_buffer_max_messages"),
        "bot_buffer_window_media_ms": cfg.get("bot_buffer_window_media_ms"),
        "bot_buffer_max_media_messages": cfg.get("bot_buffer_max_media_messages"),
        "workflow_enabled": cfg.get("workflow_enabled"),
    }

    # ── buffer rows ──────────────────────────────────────────────────
    rows = list(buf_coll.find({"kind": {"$ne": "conv_lock"}}))
    out["buffer_row_count"] = len(rows)
    mids = [r.get("message_id") for r in rows]
    conv_ids = sorted({r.get("conversation_id") for r in rows})
    out["buffer_duplicate_message_ids"] = len(mids) - len(set(mids))
    out["conv_hashes"] = [h(c) for c in conv_ids]

    buf_report = []
    for r in rows:
        buf_report.append({
            "message_id_hash": h(r.get("message_id")),
            "conversation_id_hash": h(r.get("conversation_id")),
            "received_at": iso(r.get("received_at")),
            "status": r.get("status"),
            "kind": r.get("kind"),
            "has_batch_id": bool(r.get("batch_id")),
            "has_claim_id": bool(r.get("claim_id") or r.get("claim_context")),
            "claim_id_is_deterministic": str(r.get("claim_id", "")).startswith("botworker:claim:") if r.get("claim_id") else None,
        })
    out["buffer_rows"] = buf_report

    # ── claims for these message ids ─────────────────────────────────
    claims = list(proc_coll.find({"message_id": {"$in": mids}}))
    claim_ids = [str(c["_id"]) for c in claims]
    out["claims_for_mids"] = len(claims)
    out["claims_duplicate_ids"] = len(claim_ids) - len(set(claim_ids))

    claim_report = []
    now = datetime.now(timezone.utc)
    for c in claims:
        cid = str(c["_id"])
        claim_report.append({
            "claim_id_hash": h(cid),
            "deterministic_id": cid.startswith("botworker:claim:"),
            "message_id_hash": h(c.get("message_id")),
            "status": c.get("status"),
            "kind": c.get("kind"),
            "has_owner_id": bool(c.get("owner_id")),
            "fencing_token": c.get("fencing_token"),
            "attempt": c.get("attempt"),
            "lease_expires_at": iso(c.get("lease_expires_at")),
            "lease_expired": bool(c.get("lease_expires_at") and (
                c["lease_expires_at"].replace(tzinfo=timezone.utc) if c["lease_expires_at"].tzinfo is None else c["lease_expires_at"]
            ) < now),
            "has_batch_id": bool(c.get("batch_id")),
            "outcome_type": c.get("outcome_type"),
            "reply_ids_count": len(c.get("reply_ids") or []),
            "created_at": iso(c.get("created_at") or c.get("created_timestamp")),
        })
    out["claims"] = claim_report

    # ── terminal records per message — classify over already-fetched claims
    #    (contract: only "processing" is non-terminal; unknown/missing reported separately)
    per_mid, flagged_claims = terminal_statuses_per_mid(claims, mids)
    out["terminal_records_per_mid"] = {h(m): sts for m, sts in per_mid.items()}
    out["claims_flagged_status"] = flagged_claims
    out["terminal_claims_with_buffer_row"] = sum(1 for sts in per_mid.values() if sts)

    # deterministic claim ids derived convention: botworker:claim:<message_id>
    det_ids = [f"botworker:claim:{m}" for m in mids]
    det = list(proc_coll.find({"_id": {"$in": det_ids}}, {"status": 1}))
    out["deterministic_claim_ids_exist"] = {h(d["_id"]): d.get("status") for d in det}

    # ── shadow replies for these mids — scalar OR batch array linkage ──
    replies = list(reply_coll.find(
        build_reply_query(mids),
        {"inbound_message_id": 1, "inbound_message_ids": 1, "reply_id": 1, "shadow_reply_id": 1,
         "batch_id": 1, "origin": 1, "mode": 1, "created_at": 1, "deleted_at": 1,
         "generated_by": 1, "outcome_envelope": 1},
    ))
    rep_report = {}
    for m in mids:
        rs = [r for r in replies if reply_references_mid(r, m)]
        rep_report[h(m)] = [{
            "reply_id_hash": h(r.get("reply_id") or r.get("_id")),
            "deterministic_reply_id": str(r.get("reply_id", "")).startswith("botworker:reply:") if r.get("reply_id") else None,
            "origin": r.get("origin"),
            "mode": r.get("mode"),
            "batch": bool(r.get("batch_id")),
            "has_outcome_envelope": bool(r.get("outcome_envelope")),
            "created_at": iso(r.get("created_at")),
            "deleted": bool(r.get("deleted_at")),
        } for r in rs]
    out["shadow_replies_per_mid"] = rep_report
    # aggregate evidence — count unique reply DOCS (a batch reply covers many mids
    # but is one document; per-mid lists are references, not document counts)
    out["reply_evidence_summary"] = {
        "unique_inbound_mids_with_reply": sum(1 for m in mids if any(reply_references_mid(r, m) for r in replies)),
        "unique_reply_docs": len({str(r.get("_id")) for r in replies}),
        "unique_batch_ids": len({r["batch_id"] for r in replies if r.get("batch_id")}),
        "deleted_reply_docs": sum(1 for r in replies if r.get("deleted_at")),
    }

    # ── inbound messages still exist + timestamps ────────────────────
    # incident window: worker output 10:33–12:22 today; compare only.
    msg_report = {}
    for m in mids:
        d = msg_coll.find_one(
            {"message_id": m},
            {"created_timestamp": 1, "role": 1, "direction": 1, "conversation_id": 1},
        )
        if not d:
            msg_report[h(m)] = {"exists": False}
            continue
        ts = d.get("created_timestamp")
        ts_u = ts.replace(tzinfo=timezone.utc) if isinstance(ts, datetime) and ts.tzinfo is None else ts
        msg_report[h(m)] = {
            "exists": True,
            "created_timestamp": iso(ts),
            "role": d.get("role"),
            "direction": d.get("direction"),
            "same_conversation": h(d.get("conversation_id")) in out["conv_hashes"],
            # incident window (user-reported worker output 10:33–12:22 on 2026-10-01):
            #   interpretation A — timestamps are UTC → 10:33–12:22Z
            #   interpretation B — local ICT (UTC+7) → 03:33–05:22Z
            "vs_incident_window_utc": (
                "before" if ts_u < datetime(2026, 10, 1, 10, 33, tzinfo=timezone.utc)
                else "in" if ts_u <= datetime(2026, 10, 1, 12, 22, tzinfo=timezone.utc)
                else "after"
            ),
            "vs_incident_window_ict": (
                "before" if ts_u < datetime(2026, 10, 1, 3, 33, tzinfo=timezone.utc)
                else "in" if ts_u <= datetime(2026, 10, 1, 5, 22, tzinfo=timezone.utc)
                else "after"
            ),
        }
    out["inbound_messages"] = msg_report

    # ── conversation state (flags only — no admin ids/names) ─────────
    state = {}
    for c in conv_ids:
        tsc = tsc_coll.find_one({"conversation_id": c}, {"status": 1, "assigned_to": 1, "source": 1})
        sc = sc_coll.find_one({"conversation_id": c}, {"status": 1, "assigned_to": 1})
        state[h(c)] = {
            "test_status_conversation": {
                "exists": bool(tsc),
                "status": (tsc or {}).get("status"),
                "has_assigned_admin": bool((tsc or {}).get("assigned_to")),
                "source": (tsc or {}).get("source"),
            },
            "status_conversation": {
                "exists": bool(sc),
                "status": (sc or {}).get("status"),
                "has_assigned_admin": bool((sc or {}).get("assigned_to")),
            },
        }
    out["conversation_state"] = state

    # ── recovery selection proof (read-only replication of boot queries) ──
    out["recovery_selection"] = {
        "recoverStaleBuffers_would_select": len(buf_coll.distinct(
            "conversation_id", {"status": "buffered", "kind": {"$ne": "conv_lock"}}
        )),
        "recoverStaleClaims_would_select": proc_coll.count_documents(
            {"status": "processing", "lease_expires_at": {"$lt": now}}
        ),
    }
    # which of the 4 rows/claims hit each query
    out["recovery_selection"]["buffer_rows_matching"] = buf_coll.count_documents(
        {"message_id": {"$in": mids}, "status": "buffered", "kind": {"$ne": "conv_lock"}}
    )
    out["recovery_selection"]["claims_matching_stale"] = proc_coll.count_documents(
        {"message_id": {"$in": mids}, "status": "processing", "lease_expires_at": {"$lt": now}}
    )

    # indexes on buffer_messages (confirm unique message_id)
    out["buffer_indexes"] = [
        {"name": n, "unique": bool(i.get("unique")), "keys": dict(i.get("key") or [])}
        for n, i in buf_coll.index_information().items()
    ]

    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
