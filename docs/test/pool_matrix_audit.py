"""pool_matrix_audit — offline pool-combo regression matrix (real Mongo + real Gemini).

Sweep runtime_config combos (selection flag × kb_source × pool_sources) over
gold_retrieval.jsonl questions, in-proc appmod.chat(), web/openrouter forbidden.

Safety (same model as canary_phase10b_grouped.py):
- web/openrouter = die-spies; web_search_enabled forced False in patched config
- cp._coll → read-only barrier; conversation state fully in-memory
- runtime config patched in-process (persisted base read once, merged per combo)
  → zero DB writes, zero config mutations
- results persisted per turn to docs/test/results/ (gitignored)

Usage:
  .venv/bin/python docs/test/pool_matrix_audit.py --smoke        # 2 qs × 1 combo
  .venv/bin/python docs/test/pool_matrix_audit.py                # full sweep
  .venv/bin/python docs/test/pool_matrix_audit.py --combos B,F --limit 8
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from dataclasses import replace  # noqa: E402
from shopeechat import conversation_products as cp  # noqa: E402
from shopeechat import runtime_config as rc  # noqa: E402
from shopeechat import web_search as ws  # noqa: E402
from shopeechat import llm  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import retrieval_runtime as rrt  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import generation_pointer as gp  # noqa: E402
import shopeechat.app as appmod  # noqa: E402

TS = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
OUT_JSON = ROOT / "docs/test/results" / f"pool_matrix_{TS}.json"
GOLD = ROOT / "docs/test/gold_retrieval.jsonl"

ALL_POOLS = {"kb": True, "mongo_catalog": True, "units": True, "image_text": True}

# combo name → runtime_config overrides merged over persisted base
COMBOS: dict[str, dict] = {
    "A_oldkb_seloff": {
        "grouped_retrieval_selection_enabled": False,
        "kb_source": "legacy", "pool_sources": dict(ALL_POOLS)},
    "B_live_selon_zaapi": {
        "grouped_retrieval_selection_enabled": True,
        "kb_source": "zaapi", "pool_sources": dict(ALL_POOLS)},
    "C_selon_legacy": {
        "grouped_retrieval_selection_enabled": True,
        "kb_source": "legacy", "pool_sources": dict(ALL_POOLS)},
    "D_selon_zaapi_nokb": {
        "grouped_retrieval_selection_enabled": True,
        "kb_source": "zaapi",
        "pool_sources": {**ALL_POOLS, "kb": False}},
    "E_selon_zaapi_nounits": {
        "grouped_retrieval_selection_enabled": True,
        "kb_source": "zaapi",
        "pool_sources": {**ALL_POOLS, "units": False}},
    "F_oldkb_only": {
        "grouped_retrieval_selection_enabled": False,
        "kb_source": "legacy",
        "pool_sources": {"kb": True, "mongo_catalog": False,
                          "units": False, "image_text": False}},
}

counts = {"gemini": 0, "attempts": 0, "e503": 0, "e429": 0,
          "web": 0, "openrouter": 0, "mongo_write": 0}
_cur: dict = {}
results: list[dict] = []

# ── persisted base config (read once — never mutated) ──────────────────────
BASE_CFG = rc.get_runtime_config(force_refresh=True)
_COMBO: dict = {}


def _patched_cfg(force_refresh: bool = False) -> dict:
    return {**BASE_CFG, **_COMBO}


rc.get_runtime_config = _patched_cfg

snap0 = gp.resolve_snapshot(force=True)
GID = getattr(snap0, "generation_id", None)

# ── fail-fast spies ────────────────────────────────────────────────────────
def _die(name):
    def f(*a, **k):
        counts[name] += 1
        raise RuntimeError(f"AUDIT DENIED: {name}")
    return f


ws.search_and_extract = _die("web")
if hasattr(ws, "search_and_answer"):
    ws.search_and_answer = _die("web")
llm._openrouter_generate = _die("openrouter")

# ── handoff transport stub — offline admin endpoint ไม่มีจริง: stub ชั้น
#   HTTP boundary เพื่อจับ "การตัดสินใจ handoff" (เหมือน admin ตอบ queued)
from shopeechat import responses as _resp_mod  # noqa: E402


def _fake_send_handoff(req, ctx=None, *, reason, claim_topic="",
                       claim=None, simulate=False, timeout=3.0,
                       log_tag="HANDOFF", episode_id=None):
    _cur["handoff_call"] = {"reason": reason,
                            "claim": claim or {"topic": claim_topic},
                            "episode_id": episode_id}
    return {"outcome": {"state": "queued"}, "simulated_handoff": True}


_resp_mod._send_handoff = _fake_send_handoff
appmod._send_handoff = _fake_send_handoff

# ── Mongo write barrier + in-memory conversation state ─────────────────────
_real_coll = cp._coll


class _ReadOnly:
    def __init__(self, c):
        self._c = c

    def __getattr__(self, k):
        v = getattr(self._c, k)
        if k in ("update_one", "insert_one", "update_many", "replace_one",
                 "delete_one", "delete_many", "bulk_write",
                 "find_one_and_update", "find_one_and_replace",
                 "find_one_and_delete"):
            def w(*a, **k):
                counts["mongo_write"] += 1
                raise RuntimeError(f"AUDIT DENIED mongo {k}")
            return w
        return v


cp._coll = lambda: _ReadOnly(_real_coll())

_mem: dict = {}
_tl: dict = {}
_claim: dict = {}


def _get(cid):
    st = _mem.get(cid)
    timeline = _tl.get(cid) or {}
    products = tuple(timeline.get("products") or ())
    active_item_id = timeline.get("active_item_id")
    claim_state = _claim.get(cid)
    if st is not None:
        return cp.SubjectSetView(
            st, st, products, claim_state, active_item_id)
    anchor_ids = cp._norm_subject_ids(
        p.get("item_id") for p in products
        if p.get("is_anchor") and p.get("item_id") is not None)
    if not anchor_ids:
        return cp.SubjectSetView(
            None, None, products, claim_state, active_item_id)
    relation = "single" if len(anchor_ids) == 1 else "alternatives"
    effective = cp.ConversationSubjectSet(
        anchor_ids, None, relation, (), 0.5)
    return cp.SubjectSetView(
        effective, None, products, claim_state, active_item_id)


cp.get_subject_set = _get


def _rec(cid, ss, *, expected_prior=None, platform=None, shop=None):
    if ss is None:
        return None
    prior = expected_prior.rev if expected_prior is not None else None
    ss2 = replace(ss, rev=(prior or 0) + 1)
    _mem[cid] = ss2
    return ss2


cp.record_subject_set = _rec
cp.load_timeline = lambda cid: _tl.get(cid)


def _save_tl(cid, platform, shop, products, active_item_id):
    _tl[cid] = {"conversation_id": cid, "platform": platform, "shop": shop,
                "products": products, "active_item_id": active_item_id}


cp.save_timeline = _save_tl
cp.load_claim_state = lambda cid: _claim.get(cid)


def _transition(cid, platform, shop, *, expected_episode_id, expected_stage,
                claim_state):
    cur = _claim.get(cid)
    if cur and (cur.get("episode_id") != expected_episode_id
                or cur.get("stage") != expected_stage):
        return cur
    _claim[cid] = dict(claim_state or {})
    return _claim[cid]


cp.transition_claim_state = _transition


def _merge(cid, *, episode_id, expected_stage, fields):
    cur = _claim.get(cid)
    if not cur or cur.get("episode_id") != episode_id \
            or (expected_stage is not None
                and cur.get("stage") != expected_stage):
        return cur
    for k, v in (fields or {}).items():
        if v not in (None, "", {}, []):
            cur[k] = v
    return cur


cp.merge_claim_fields = _merge


def _order_anchor(conversation_id, platform=None, shop=None, order_sn=None,
                  order=None, **kw):
    doc = _tl.setdefault(conversation_id, {"products": []})
    doc.setdefault("order_anchor", {"order_sn": order_sn, "order": order})
    return doc


cp.add_order_anchor = _order_anchor

# ── Gemini bounded calls ───────────────────────────────────────────────────
_real_client = llm._client


def _client(api_key: str | None = None):
    c = _real_client(api_key)
    orig = c.models.generate_content

    def gen(*a, **k):
        counts["gemini"] += 1
        waits = (5, 5, 5)
        for attempt in range(4):
            counts["attempts"] += 1
            t0 = time.time()
            try:
                r = orig(*a, **k)
                _cur.setdefault("gemini_log", []).append(
                    {"model": k.get("model") or (a[0] if a else "?"),
                     "latency_s": round(time.time() - t0, 2),
                     "attempt": attempt + 1})
                return r
            except Exception as e:
                msg = str(e)
                if "503" in msg or "UNAVAILABLE" in msg:
                    counts["e503"] += 1
                    if attempt < 3:
                        time.sleep(waits[attempt])
                        continue
                elif "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                    counts["e429"] += 1
                raise
    c.models.generate_content = gen
    return c


llm._client = _client

# ── instrumentation ────────────────────────────────────────────────────────
_real_decide = td.decide_turn


def _decide(msg, **k):
    plan = _real_decide(msg, **k)
    _cur["plan"] = [
        {"kind": n.kind, "op": n.operation,
         "subj": tuple(n.subject_refs or ()),
         "tgt": tuple(n.target_refs or ()),
         "types": sorted(n.product_types or ())} for n in plan.needs]
    return plan


td.decide_turn = _decide
appmod.td = td

_real_gs = rrt.run_grouped_selection


def _gs(*a, **k):
    out = _real_gs(*a, **k)
    if out is None:
        _cur["grouped"] = "None"
        return out
    pool = out["pool"]
    _cur["requests"] = [{"id": r.request_id, "src": r.source,
                         "types": sorted(r.product_types or ())}
                        for r in out.get("requests", ())]
    _cur["pool_stats"] = {
        "eligible": len(pool.eligible),
        "unavailable": len(pool.unavailable),
        "rejected": len(pool.rejected),
        "evidence": len(pool.evidence_pool),
        "eligible_sources": sorted(
            {s for c in pool.eligible for s in c.sources}),
        "eligible_items": [c.item_id for c in pool.eligible][:30],
    }
    sel = out["selection"]
    _cur["selected"] = [{"item_id": str(s.card.get("item_id")),
                         "role": s.role}
                        for s in sel.selected]
    return out


rrt.run_grouped_selection = _gs

_real_ctx = acx.compile_answer_context


def _ctx(*a, **k):
    ctx = _real_ctx(*a, **k)
    _cur["ctx_ids"] = [str(p.get("item_id")) for p in ctx.products]
    _cur["unanswered"] = [{"i": u.need_index, "reason": u.reason}
                          for u in ctx.unanswered_needs]
    _cur["task"] = ctx.task.render() if hasattr(ctx.task, "render") \
        else str(ctx.task)
    return ctx


acx.compile_answer_context = _ctx

_real_res = cp.resolve_subjects


def _res(*a, **k):
    r = _real_res(*a, **k)
    _cur["subject_res"] = {"outcome": r.outcome}
    return r


cp.resolve_subjects = _res


def _prod_ids(products) -> list[str]:
    out = []
    for p in products or []:
        if isinstance(p, dict):
            v = p.get("item_id") or p.get("product_id") or p.get("id")
            if v is not None:
                out.append(str(v))
    return out


def run_turn(combo: str, row: dict) -> dict:
    global _cur
    _cur = {}
    conv = f"mx-{combo}-{row['id']}-{TS}"
    req = appmod.ChatRequest(
        message=row["message"], shop=row.get("shop"),
        item_id=row.get("item_id"), conversation_id=conv,
        history=list(row.get("history") or []), limit=10)
    g0 = counts["gemini"]
    t0 = time.time()
    err = None
    resp = None
    try:
        resp = appmod.chat(req)
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
    lat = round(time.time() - t0, 2)
    rec = {
        "combo": combo, "qid": row["id"], "shop": row.get("shop"),
        "msg": row["message"],
        "expected_mode": row.get("expected_answer_mode"),
        "answer": (resp.answer if resp else None),
        "source": (resp.source if resp else None),
        "handoff": (resp.handoff_to_admin if resp else None),
        "handoff_reason": (resp.handoff_reason if resp else None),
        "handoff_call": _cur.get("handoff_call"),
        "product_item_ids": _prod_ids(resp.products if resp else []),
        "products_n": len(resp.products or []) if resp else 0,
        "intent": (resp.intent if resp else None),
        "step_names": [s.get("name") for s in (resp.steps or [])
                       if isinstance(s, dict)] if resp else None,
        "latency_s": lat, "gemini_calls": counts["gemini"] - g0,
        "error": err,
        "plan": _cur.get("plan"), "subject_res": _cur.get("subject_res"),
        "requests": _cur.get("requests"), "pool_stats": _cur.get("pool_stats"),
        "grouped": _cur.get("grouped"), "selected": _cur.get("selected"),
        "ctx_ids": _cur.get("ctx_ids"), "unanswered": _cur.get("unanswered"),
        "task": _cur.get("task"),
        "fails": _score(row, resp, err),
    }
    results.append(rec)
    _persist()
    return rec


def _score(row: dict, resp, err: str | None) -> list[str]:
    fails = []
    if err:
        fails.append("error")
        return fails
    ans = resp.answer or ""
    ids = set(_prod_ids(resp.products)) | set(_cur.get("ctx_ids") or [])
    for p in (row.get("must_not_phrases") or []):
        if p and p in ans:
            fails.append(f"phrase:{p}")
    for i in (row.get("must_not_item_ids") or []):
        if str(i) in ids:
            fails.append(f"bad_item:{i}")
    acc = [str(x) for x in (row.get("acceptable_item_ids") or [])]
    if acc and not any(i in ids for i in acc):
        fails.append("no_acceptable_item")
    exp = row.get("expected_answer_mode")
    if exp == "handoff" and not resp.handoff_to_admin:
        fails.append("expected_handoff")
    if exp in ("recommend", "products") and not (resp.products or []):
        fails.append("expected_products")
    if exp in ("handoff", "policy", "inform_only") and (resp.products or []):
        fails.append("unexpected_products")
    return fails


def _persist():
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(
        {"gid": GID, "ts": TS, "counts": counts,
         "base_cfg_interesting": {k: BASE_CFG.get(k) for k in (
             "grouped_retrieval_selection_enabled", "kb_source",
             "pool_sources", "web_search_enabled", "chat_engine")},
         "results": results},
        ensure_ascii=False, indent=1, default=str))


REVIEWED = ("accepted", "corrected")


def pick_questions(limit: int | None) -> list[dict]:
    rows = [json.loads(l) for l in GOLD.read_text().splitlines() if l.strip()]
    # stratified sample: reviewed rows for common modes, provisional fill-in
    # for modes that exist only as provisional (inform_only/discontinued/oos)
    per_mode = {"handoff": 5, "policy": 4, "no_such_type": 3,
                "inform_only": 2, "discontinued": 2, "out_of_stock": 2,
                "products": 2}
    picked: list[dict] = []
    for m, n in per_mode.items():
        bucket = [r for r in rows if r.get("expected_answer_mode") == m
                  and r.get("review_status") in REVIEWED]
        if len(bucket) < n:
            bucket += [r for r in rows
                       if r.get("expected_answer_mode") == m
                       and r.get("review_status") == "provisional"]
        picked.extend(bucket[:n])
    recs = [r for r in rows if r.get("expected_answer_mode") == "recommend"
            and r.get("review_status") in REVIEWED]
    compat = [r for r in recs if str(r["id"]).startswith("compat")]
    tagged = [r for r in recs if "[สินค้า:" in r.get("message", "")
              or "[สินค้า:" in json.dumps(r.get("history") or [],
                                          ensure_ascii=False)]
    plain = [r for r in recs if r not in compat and r not in tagged]
    picked.extend(compat[:4] + tagged[:3] + plain[:6])
    if limit:
        picked = picked[:limit]
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--combos", default=",".join(COMBOS))
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--qids", default=None, help="comma-separated gold ids")
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()

    combos = args.combos.split(",")
    if args.smoke:
        combos = ["B_live_selon_zaapi"]
    questions = pick_questions(args.limit)
    if args.qids:
        want = set(args.qids.split(","))
        rows = [json.loads(l) for l in GOLD.read_text().splitlines()
                if l.strip()]
        questions = [r for r in rows if r["id"] in want]
    if args.smoke:
        questions = questions[:2]

    print(f"gid={GID} combos={combos} questions={len(questions)}")
    global _COMBO
    for cname in combos:
        assert cname in COMBOS, f"unknown combo {cname}"
        _COMBO = {**COMBOS[cname], "web_search_enabled": False}
        # sanity: flag resolves as intended in-process
        assert rc.grouped_retrieval_selection_enabled() == \
            _COMBO["grouped_retrieval_selection_enabled"]
        assert rc.kb_source() == _COMBO["kb_source"]
        assert rc.pool_sources() == _COMBO["pool_sources"]
        assert rc.web_search_enabled() is False
        print(f"=== combo {cname} ===")
        for row in questions:
            rec = run_turn(cname, row)
            ans = (rec["answer"] or "")[:80].replace("\n", " ")
            sel = [s["item_id"] for s in (rec["selected"] or [])]
            print(f"[{cname}|{row['id']}] src={rec['source']} "
                  f"ho={rec['handoff']} g={rec['gemini_calls']} "
                  f"sel={sel[:3]} fails={rec['fails']} :: {ans}")
    _persist()
    print("=== COUNTS ===")
    print(json.dumps(counts, indent=1))
    print(f"artifact: {OUT_JSON}")


if __name__ == "__main__":
    main()
