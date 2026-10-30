"""live_matrix_abc — Phase 10B LIVE A/B/C acceptance matrix (test-side only).

3 combos × canonical corpus on real Mongo (read-only) + real Gemini:
  A_legacy_off  — grouped selection OFF · legacy KB · all pools
  B_grouped_zaapi — grouped ON · Zaapi KB · all pools
  C_grouped_legacy — grouped ON · legacy KB · all pools

Reuses pool_matrix_audit seams (import installs them) then extends:
- process-local NEW_GID EvidenceSnapshot pin (resolve_snapshot override —
  shared Mongo pointer untouched; OLD pointer recorded read-only)
- extra die-spies: ws.reanswer / should_use_web_search / describe_image(s) /
  chatbotv3.chat_v3 + llm.get_provider → "gemini" (OpenRouter OFF hard pin)
- multi-turn conversations (per-conv in-memory history + subject/timeline)
- per-call token usage capture + 429 → QUOTA_DEAD → abort matrix (invalid)
- error sanitization (no URIs/keys persisted)
- round-robin per case: A(case) → B(case) → C(case)

Usage:
  .venv/bin/python docs/test/live_matrix_abc.py --smoke     # 3 convs × A/B/C then stop
  .venv/bin/python docs/test/live_matrix_abc.py             # smoke gate → gold 26
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs" / "test"))

import pool_matrix_audit as PM           # installs base seams on import
from shopeechat import conversation_products as cp
from shopeechat import generation_pointer as gp
from shopeechat import llm
from shopeechat import runtime_config as rc
from shopeechat import web_search as ws
from shopeechat import turn_decision as td
from shopeechat import retrieval_runtime as rrt
from shopeechat import answer_context as acx
from shopeechat import intent_classifier as ic
import shopeechat.app as appmod

NEW_GID = "g20261027-025541-563ca0f0"
OLD_GID = PM.GID                        # real active pointer (read once by PM)
TS = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
OUT_JSON = ROOT / "docs/test/results" / f"live_matrix_abc_{TS}.json"
OUT_MD = ROOT / "docs/test/results" / f"live_matrix_abc_{TS}.md"

COMBOS = {
    "A": {"grouped_retrieval_selection_enabled": False,
          "kb_source": "legacy", "pool_sources": dict(PM.ALL_POOLS)},
    "B": {"grouped_retrieval_selection_enabled": True,
          "kb_source": "zaapi", "pool_sources": dict(PM.ALL_POOLS)},
    "C": {"grouped_retrieval_selection_enabled": True,
          "kb_source": "legacy", "pool_sources": dict(PM.ALL_POOLS)},
}

counts = {"gemini": 0, "attempts": 0, "e503": 0, "e429": 0,
          "web": 0, "openrouter": 0, "mongo_write": 0, "tokens_in": 0,
          "tokens_out": 0}
QUOTA_DEAD = {"dead": False, "at": None}
_cur: dict = {}
results: list[dict] = []

# ── NEW_GID process-local pin (shared pointer untouched) ─────────────────
SNAP = gp.EvidenceSnapshot(
    generation_id=NEW_GID,
    units_collection=f"sellable_units_{NEW_GID}",
    image_texts_collection=f"image_texts_{NEW_GID}",
    units_npz=str(ROOT / f"exports/gen/{NEW_GID}/unit_embeddings.npz"),
    product_npz=str(ROOT / f"exports/gen/{NEW_GID}/product_embeddings.npz"),
    units_jsonl=str(ROOT / f"exports/gen/{NEW_GID}/sellable_units.jsonl"),
    manifest_path=str(ROOT / f"exports/gen/{NEW_GID}/manifest.json"),
    manifest_sha256="local-pin-no-manifest",
    activated_at="local-pin")
gp.resolve_snapshot = lambda *a, **k: SNAP
gp.reset_cache()

# ── extra fail-fast spies (on top of PM's web/or die-spies) ──────────────
def _die(name):
    def f(*a, **k):
        counts[name] += 1
        raise RuntimeError(f"MATRIX DENIED: {name}")
    return f


ws.reanswer = _die("web")
ws.should_use_web_search = _die("web")
llm.get_provider = lambda *a, **k: "gemini"
try:
    from shopeechat import chatbotv3
    chatbotv3.chat_v3 = _die("engine_v3")
    counts["engine_v3"] = 0
except Exception:
    pass

# ── mongo-write counter shares PM's barrier (PM counts; mirror here) ─────
# PM._ReadOnly already raises+counts every write attempt — mirror count into
# local dict for the artifact by wrapping PM.counts reader later.
_resp_mod = __import__("shopeechat.responses", fromlist=["x"])


def _fake_send_handoff(req, ctx=None, *, reason, claim_topic="",
                       claim=None, simulate=False, timeout=3.0,
                       log_tag="HANDOFF", episode_id=None):
    _cur["handoff_call"] = {"reason": reason,
                            "claim": claim or {"topic": claim_topic},
                            "episode_id": episode_id}
    return {"outcome": {"state": "queued"}, "simulated_handoff": True}


_resp_mod._send_handoff = _fake_send_handoff
appmod._send_handoff = _fake_send_handoff

# ── Gemini bounded calls + per-call token capture + quota-dead flag ──────
_real_client = PM._real_client          # true original llm._client


def _client(api_key: str | None = None):
    c = _real_client(api_key)
    orig = c.models.generate_content

    def gen(*a, **k):
        counts["gemini"] += 1
        for attempt in range(4):
            counts["attempts"] += 1
            t0 = time.time()
            try:
                r = orig(*a, **k)
                u = getattr(r, "usage_metadata", None)
                tin = int(getattr(u, "prompt_token_count", 0) or 0)
                tout = int(getattr(u, "candidates_token_count", 0) or 0)
                counts["tokens_in"] += tin
                counts["tokens_out"] += tout
                _cur.setdefault("gemini_log", []).append({
                    "model": k.get("model") or (a[0] if a else "?"),
                    "latency_s": round(time.time() - t0, 2),
                    "attempt": attempt + 1, "tin": tin, "tout": tout})
                return r
            except Exception as e:
                code = str(getattr(e, "code", "") or "")
                msg = str(e)
                if "503" in code or "503" in msg or "UNAVAILABLE" in msg:
                    counts["e503"] += 1
                    if attempt < 3:
                        time.sleep(5)
                        continue
                elif "429" in code or "429" in msg \
                        or "RESOURCE_EXHAUSTED" in msg:
                    # transient key/model-fallback 429 (live service shares
                    # quota) — count + let llm's own rotation/fallback handle;
                    # NOT quota death. Real death = escapes to run_turn error
                    # or sustained events (checked in run_turn).
                    counts["e429"] += 1
                raise
    c.models.generate_content = gen
    return c


llm._client = _client

# ── instrumentation (wrap PM's installed spies → richer records) ─────────
_pm_decide = td.decide_turn
_pm_gs = rrt.run_grouped_selection
_pm_ctx = acx.compile_answer_context
_pm_res = cp.resolve_subjects
_pm_cls = getattr(ic, "classify_intent", None)


def _cls(*a, **k):
    r = _pm_cls(*a, **k)
    _cur["intent"] = dict(r) if isinstance(r, dict) else {"raw": str(r)}
    return r


if _pm_cls is not None:
    ic.classify_intent = _cls


def _decide(msg, **k):
    plan = _pm_decide(msg, **k)
    _cur["plan"] = [
        {"i": i, "kind": n.kind, "op": n.operation,
         "subj": tuple(n.subject_refs or ()),
         "tgt": tuple(n.target_refs or ()),
         "types": sorted(n.product_types or ()),
         "subs": sorted(getattr(n, "subtypes", ()) or ()),
         "facts": tuple(getattr(n, "requested_facts", ()) or ()),
         "feats": tuple(getattr(n, "required_features", ()) or ()),
         "cons": [list(c) for c in
                  (getattr(n, "spec_constraints", ()) or ())],
         "asks": tuple(getattr(n, "capability_asks", ()) or ()),
         "conf": getattr(n, "confidence", None)}
        for i, n in enumerate(plan.needs)]
    _cur["action"] = plan.primary_action
    _cur["plan_flags"] = sorted(plan.flags or ())
    return plan


td.decide_turn = _decide


def _gs(*a, **k):
    out = _pm_gs(*a, **k)
    if out is None:
        _cur["grouped"] = "None"
        return out
    _cur["snap_gid"] = getattr(k.get("snap"), "generation_id", None)
    _cur["requests"] = [
        {"id": getattr(r, "request_id", None), "src": getattr(r, "source", None),
         "subj": tuple(getattr(r, "subject_refs", ()) or ()),
         "tgt": tuple(getattr(r, "target_refs", ()) or ()),
         "tgt_dev": getattr(r, "target_device", None),
         "types": sorted(getattr(r, "product_types", ()) or ()),
         "subs": sorted(getattr(r, "subtypes", ()) or ()),
         "compat": getattr(r, "compat_mode", None),
         "facts": tuple(getattr(r, "requested_facts", ()) or ()),
         "feats": tuple(getattr(r, "required_features", ()) or ())}
        for r in out.get("requests", ())]
    pool = out["pool"]

    def _cid(c):
        iid = getattr(c, "item_id", None)
        if iid is None and isinstance(getattr(c, "card", None), dict):
            iid = c.card.get("item_id")
        return str(iid) if iid is not None else None

    _cur["pool"] = {
        "eligible": [{"item_id": _cid(c),
                      "unit_id": getattr(c, "unit_id", None),
                      "model_id": getattr(c, "model_id", None),
                      "sources": list(getattr(c, "sources", ()) or ()),
                      "bucket": getattr(c, "bucket", None),
                      "score": getattr(c, "score", None)}
                     for c in pool.eligible],
        "unavailable": [{"item_id": _cid(c),
                         "reason": getattr(c, "reason", None)}
                        for c in pool.unavailable],
        "rejected": [{"item_id": _cid(c),
                      "reason": getattr(c, "reason", None)}
                     for c in pool.rejected],
        "evidence": [{"kind": getattr(e, "kind", None),
                      "item_id": getattr(e, "item_id", None),
                      "identity": getattr(e, "identity", None),
                      "linked": getattr(e, "linked_candidate", None),
                      "trace": list(getattr(e, "trace", ()) or ())}
                     for e in pool.evidence_pool],
    }
    sel = out["selection"]
    _cur["selected"] = [
        {"item_id": str((getattr(s, "card", None) or {}).get("item_id")),
         "role": getattr(s, "role", None),
         "request_id": getattr(s, "request_id", None),
         "reason": getattr(s, "reason", None),
         "hits": list(getattr(s, "constraint_hits", ()) or ())}
        for s in sel.selected]
    _cur["sel_unavailable"] = len(getattr(sel, "unavailable_evidence", ()) or ())
    _cur["rejected_summary"] = list(getattr(sel, "rejected_summary", ()) or ())
    _cur["summary"] = out.get("summary")
    return out


rrt.run_grouped_selection = _gs


def _ctx(*a, **k):
    ctx = _pm_ctx(*a, **k)
    _cur["ctx_ids"] = [str(p.get("item_id")) for p in ctx.products]
    _cur["ctx_cards"] = [
        {"item_id": str(p.get("item_id")), "name": p.get("item_name"),
         "need_indices": list(p.get("need_indices") or ())}
        for p in ctx.products]
    evs = []
    for e in (getattr(ctx, "evidence", ()) or ()):
        if isinstance(e, dict):
            rec = {k: e.get(k) for k in
                   ("kind", "item_id", "target", "identity", "chunk_id",
                    "chunk_ids") if e.get(k) is not None}
            rec["need_indices"] = list(e.get("need_indices") or ())
            evs.append(rec)
    _cur["ctx_evidence"] = evs
    _cur["unanswered"] = [{"i": getattr(u, "need_index", None),
                           "reason": getattr(u, "reason", None),
                           "asks": tuple(getattr(u, "capability_asks", ()) or ())}
                          for u in ctx.unanswered_needs]
    _cur["constraint_notes"] = [dict(n) for n in
                              (getattr(ctx, "constraint_notes", ()) or ())]
    _cur["compat_verdicts"] = [
        {"need": getattr(v, "need_index", None),
         "subj": getattr(v, "subject_id", None),
         "target": getattr(v, "target", None),
         "outcome": getattr(getattr(v, "decision", None), "outcome", None),
         "reasons": tuple(getattr(getattr(v, "decision", None),
                                "reason_codes", ()) or ())}
        for v in (getattr(ctx, "compat_verdicts", ()) or ())]
    _cur["spec_measured"] = getattr(ctx, "spec_measured_facts", None)
    _cur["task"] = ctx.task.render() if hasattr(ctx.task, "render") \
        else str(ctx.task)
    return ctx


acx.compile_answer_context = _ctx


def _res(*a, **k):
    r = _pm_res(*a, **k)
    _cur["subject_res"] = {
        "outcome": getattr(r, "outcome", None),
        "ids": tuple(getattr(getattr(r, "subject_set", None),
                            "subject_ids", ()) or ())}
    return r


cp.resolve_subjects = _res

# ── secret-safe error ────────────────────────────────────────────────────
_SECRET_RE = re.compile(
    r"(mongodb(\+srv)?://\S+|Bearer\s+\S+|api[_-]?key=\S+|"
    r"AIza[\w-]{10,}|x-service-token\S*)", re.I)


def _safe_err(e: BaseException) -> str:
    return _SECRET_RE.sub("[redacted]", f"{type(e).__name__}: {e}")[:500]


def _prod_brief(products):
    return [{"item_id": str(p.get("item_id")), "name": p.get("item_name")}
            for p in (products or []) if isinstance(p, dict)]


def run_turn(combo: str, case_id: str, conv: str, *, message: str,
             shop=None, item_id=None, order_sn=None, history=None,
             expect=None, turn_i=0) -> dict:
    global _cur
    _cur = {"case_id": case_id}
    g0, a0, q0 = counts["gemini"], counts["attempts"], counts["e429"]
    req = appmod.ChatRequest(
        message=message, shop=shop, item_id=item_id, order_sn=order_sn,
        conversation_id=conv, history=list(history or []), limit=10,
        platform="shopee")
    t0, err, resp = time.time(), None, None
    try:
        resp = appmod.chat(req)
    except Exception as e:
        err = _safe_err(e)
    rec = {
        "combo": combo, "case": case_id, "conv": conv, "turn": turn_i,
        "shop": shop, "msg": message,
        "answer": (resp.answer if resp else None),
        "segments": (list(resp.answer_segments) if resp else None),
        "source": (resp.source if resp else None),
        "model": (getattr(resp, "model", None) if resp else None),
        "usage": (dict(resp.usage) if resp else None),
        "chat_engine": (getattr(resp, "chat_engine", None) if resp else None),
        "retrieval_info": (dict(resp.retrieval_info)
                           if resp and getattr(resp, "retrieval_info", None)
                           else None),
        "routing_composition": (
            (resp.routing_decision or {}).get("composition")
            if resp and getattr(resp, "routing_decision", None) else None),
        "vision_usage": (dict(getattr(resp, "vision_usage", {}) or {})
                         if resp else None),
        "cost": (getattr(resp, "cost", None) if resp else None),
        "elapsed": (getattr(resp, "elapsed", None) if resp else None),
        "latency_s": round(time.time() - t0, 2),
        "products": _prod_brief(resp.products if resp else []),
        "intent_resp": (resp.intent if resp else None),
        "handoff": (resp.handoff_to_admin if resp else None),
        "handoff_reason": (resp.handoff_reason if resp else None),
        "handoff_call": _cur.get("handoff_call"),
        "step_names": [s.get("name") for s in (resp.steps or [])
                       if isinstance(s, dict)] if resp else None,
        "gemini_calls": counts["gemini"] - g0,
        "gemini_attempts": counts["attempts"] - a0,
        "e429_delta": counts["e429"] - q0,
        "gemini_log": _cur.get("gemini_log"),
        "error": err, "expect": expect or {},
        "intent": _cur.get("intent"), "plan": _cur.get("plan"),
        "action": _cur.get("action"), "plan_flags": _cur.get("plan_flags"),
        "subject_res": _cur.get("subject_res"),
        "requests": _cur.get("requests"), "pool": _cur.get("pool"),
        "selected": _cur.get("selected"),
        "rejected_summary": _cur.get("rejected_summary"),
        "summary": _cur.get("summary"), "snap_gid": _cur.get("snap_gid"),
        "grouped": _cur.get("grouped"),
        "ctx_ids": _cur.get("ctx_ids"), "ctx_cards": _cur.get("ctx_cards"),
        "ctx_evidence": _cur.get("ctx_evidence"),
        "unanswered": _cur.get("unanswered"),
        "constraint_notes": _cur.get("constraint_notes"),
        "compat_verdicts": _cur.get("compat_verdicts"),
        "spec_measured": _cur.get("spec_measured"),
        "task": _cur.get("task"),
        "mongo_writes": PM.counts["mongo_write"],
        "web_calls": PM.counts["web"] + counts["web"],
        "or_calls": PM.counts["openrouter"] + counts["openrouter"],
    }
    _i = rec.get("intent") or {}
    rec["dead_intent"] = _i.get("intent") == "other" \
        and not _i.get("confidence")
    rec["provider_affected"] = bool(
        rec["e429_delta"] or rec["dead_intent"]
        or (err and ("429" in err or "RESOURCE_EXHAUSTED" in err)))
    # quota death = provider actually cannot serve: turn-level error, or
    # dead-intent streak (intent call unrecoverable across turns).
    # Transient per-key 429 recovered by rotation ≠ death (shared quota).
    if err and ("429" in err or "RESOURCE_EXHAUSTED" in err):
        QUOTA_DEAD["dead"] = True
        QUOTA_DEAD["at"] = f"{combo}|{case_id} (turn error)"
    QUOTA_DEAD["streak"] = QUOTA_DEAD.get("streak", 0) + 1 \
        if rec["dead_intent"] else 0
    if QUOTA_DEAD["streak"] >= 3:
        QUOTA_DEAD["dead"] = True
        QUOTA_DEAD["at"] = f"{combo}|{case_id} (dead-intent streak x3)"
    results.append(rec)
    _persist()
    time.sleep(8)                    # provider pacing (not a retry)
    return rec


def _persist():
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(
        {"new_gid": NEW_GID, "old_gid": OLD_GID, "ts": TS,
         "combos": COMBOS, "counts": counts, "pm_counts": PM.counts,
         "quota_dead": QUOTA_DEAD,
         "base_cfg": PM.BASE_CFG and {k: PM.BASE_CFG.get(k) for k in (
             "grouped_retrieval_selection_enabled", "kb_source",
             "pool_sources", "web_search_enabled", "chat_engine")},
         "results": results},
        ensure_ascii=False, indent=1, default=str))


# ── corpus ──────────────────────────────────────────────────────────────
CONVS = {
    "wattaka": {"shop": "CukTechThailand", "turns": [
        {"message": "[สินค้า: 27639651334]", "item_id": "27639651334",
         "expect": {"kind": "exact_item", "id": "27639651334"}},
        {"message": "Speed data เท่าไหร่?ครับ",
         "expect": {"kind": "spec_answer", "id": "27639651334"}},
        {"message": "มีรุ่น 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหม",
         "expect": {"kind": "constraint_discovery"}},
    ]},
    "pingevox": {"shop": "KingGadgets", "turns": [
        {"message": "[สินค้า: 49267582152]", "item_id": "49267582152",
         "expect": {"kind": "exact_item", "id": "49267582152"}},
        {"message": "ซาหวัดดีจ้า", "expect": {"kind": "greeting"}},
        {"message": "อยากได้ของที่ใช้กับ xiaomi 17 ultra",
         "expect": {"kind": "compat_target"}},
        {"message": "หัวชาร์จละ", "expect": {"kind": "subtype_adapter"}},
        {"message": "ดีจ้า", "expect": {"kind": "greeting"}},
    ]},
    "aumporn_w01": {"shop": "IMILabThailand", "turns": [
        {"message": "[สินค้า: 18408364022]", "item_id": "18408364022",
         "expect": {"kind": "exact_item", "id": "18408364022"}},
        {"message": "ขอสอบถามค่ะ รุ่น IMILAB W01 เวลาใช้โหมดวิ่ง สามารถเชื่อมต่อ GPS จากมือถือเพื่อบันทึกระยะทางและเพซวิ่งได้ไหมคะ แล้วระหว่างวิ่งสามารถดูชีพจร เวลา ระยะทาง และเพซบนหน้าจอนาฬิกาได้หรือไม่คะ",
         "expect": {"kind": "multifact_spec"}},
        {"message": "แล้วเชื่อมเข้ากับแอปสตาวาไหม",
         "expect": {"kind": "spec_answer"}},
    ]},
}


def gold_cases() -> list[dict]:
    rows = PM.pick_questions(None)
    return [{"id": f"gold-{r['id']}", "shop": r.get("shop"),
             "message": r["message"], "history": r.get("history") or [],
             "expect": {"kind": "gold", "mode": r.get("expected_answer_mode"),
                        "acceptable": r.get("acceptable_item_ids"),
                        "must_not_items": r.get("must_not_item_ids"),
                        "must_not_phrases": r.get("must_not_phrases")}}
            for r in rows]


def run_conv(combo: str, name: str, convdef: dict) -> list[dict]:
    conv = f"matrix-{combo}-{name}-{TS}"
    hist: list[dict] = []
    out = []
    for i, t in enumerate(convdef["turns"], 1):
        rec = run_turn(combo, f"{name}-t{i}", conv, message=t["message"],
                       shop=convdef["shop"], item_id=t.get("item_id"),
                       history=hist, expect=t.get("expect"), turn_i=i)
        if rec["answer"] is not None:
            hist.append({"role": "user", "text": t["message"]})
            hist.append({"role": "model", "text": rec["answer"]})
        out.append(rec)
        if QUOTA_DEAD["dead"] or rec["error"]:
            break
    return out


def run_case(combo: str, case: dict) -> list[dict]:
    """gold single-turn (history inside request)."""
    conv = f"matrix-{combo}-{case['id']}-{TS}"
    return [run_turn(combo, case["id"], conv, message=case["message"],
                     shop=case["shop"], history=case["history"],
                     expect=case["expect"], turn_i=1)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true",
                    help="run 3 conversations × A/B/C then stop")
    ap.add_argument("--skip-convs", action="store_true",
                    help="skip conversation smoke phase (resume)")
    ap.add_argument("--cases", default="",
                    help="comma-separated case-id substrings — gold filter")
    args = ap.parse_args()

    print(f"new_gid={NEW_GID} old_gid={OLD_GID} ts={TS}")
    smoke_fails: list[str] = []

    # ── smoke: conversations, round-robin per conversation ──────────────
    if not args.skip_convs:
      for name, cdef in CONVS.items():
        for cname in ("A", "B", "C"):
            PM._COMBO = {**COMBOS[cname], "web_search_enabled": False}
            recs = run_conv(cname, name, cdef)
            for r in recs:
                sel = [s["item_id"] for s in (r["selected"] or [])]
                ans = (r["answer"] or "")[:80].replace("\n", " ")
                print(f"[{cname}|{r['case']}] src={r['source']} "
                      f"g={r['gemini_calls']} sel={sel[:3]} "
                      f"err={r['error']} :: {ans}", flush=True)
            for r in recs:
                if r["error"]:
                    smoke_fails.append(f"{cname}|{r['case']}: {r['error']}")
                if r.get("snap_gid") and r["snap_gid"] != NEW_GID:
                    smoke_fails.append(
                        f"{cname}|{r['case']}: snap_gid={r['snap_gid']}")
        if QUOTA_DEAD["dead"]:
            break

    infra = {
        "mongo_write": PM.counts["mongo_write"],
        "web": PM.counts["web"] + counts["web"],
        "openrouter": PM.counts["openrouter"] + counts["openrouter"],
        "e429": counts["e429"], "quota_dead": QUOTA_DEAD["dead"],
    }
    print(f"=== SMOKE GATE === {json.dumps(infra, ensure_ascii=False)}")
    if infra["mongo_write"] > 0:
        smoke_fails.append("mongo_write>0")
    if infra["web"] > 0:
        smoke_fails.append("web calls>0")
    if infra["openrouter"] > 0:
        smoke_fails.append("openrouter calls>0")
    if QUOTA_DEAD["dead"]:
        smoke_fails.append(f"provider quota dead at {QUOTA_DEAD['at']}")
    if smoke_fails:
        print("SMOKE FAIL → matrix invalid, stopping:")
        for f in smoke_fails:
            print("  -", f)
        _persist()
        _write_md(invalid=True)
        sys.exit(2)
    print("SMOKE PASS")
    if args.smoke:
        _persist()
        _write_md()
        print(f"artifacts: {OUT_JSON.name}")
        return

    # ── full matrix: gold 26, round-robin per case ───────────────────────
    _filt = [s.strip() for s in args.cases.split(",") if s.strip()]
    for case in [c for c in gold_cases()
                 if not _filt or any(f in c["id"] for f in _filt)]:
        for cname in ("A", "B", "C"):
            if QUOTA_DEAD["dead"]:
                break
            PM._COMBO = {**COMBOS[cname], "web_search_enabled": False}
            for r in run_case(cname, case):
                sel = [s["item_id"] for s in (r["selected"] or [])]
                ans = (r["answer"] or "")[:80].replace("\n", " ")
                print(f"[{cname}|{r['case']}] src={r['source']} "
                      f"g={r['gemini_calls']} sel={sel[:3]} "
                      f"err={r['error']} :: {ans}", flush=True)
        if QUOTA_DEAD["dead"]:
            print(f"STOP: quota dead at {QUOTA_DEAD['at']} — run invalid")
            break

    _persist()
    _write_md()
    print("=== COUNTS ===")
    print(json.dumps(counts, indent=1))
    print(json.dumps({"pm": PM.counts}, indent=1))
    print(f"artifacts: {OUT_JSON.name}")


def _write_md(invalid: bool = False):
    lines = [f"# Phase 10B LIVE A/B/C matrix — {TS}",
             f"new_gid={NEW_GID} · old_pointer={OLD_GID} · "
             f"invalid={invalid or QUOTA_DEAD['dead']}", ""]
    for r in results:
        lines.append(f"## [{r['combo']}] {r['case']} (conv={r['conv']})")
        lines.append(f"**Q:** {r['msg']}")
        if r["error"]:
            lines.append(f"**ERROR:** {r['error']}")
        lines.append(f"- src={r['source']} model={r['model']} "
                     f"intent={(r.get('intent') or {}).get('intent')}/"
                     f"{(r.get('intent') or {}).get('confidence')} "
                     f"gemini={r['gemini_calls']} latency={r['latency_s']}s "
                     f"usage={r.get('usage')} cost={r.get('cost')}")
        lines.append(f"- selected={[s['item_id'] for s in (r['selected'] or [])]} "
                     f"ctx={r.get('ctx_ids')} unanswered={r.get('unanswered')}")
        lines.append("")
        lines.append(r["answer"] or "(no answer)")
        lines.append("")
    lines.append(f"counts: {json.dumps(counts)} | pm: {json.dumps(PM.counts)}")
    OUT_MD.write_text("\n".join(lines))


if __name__ == "__main__":
    main()
