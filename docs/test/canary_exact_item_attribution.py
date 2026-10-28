"""Round 10A canary — exact-item attribution, 2 turns, read-only Mongo.

Q1 [สินค้า: 27639651334] → Q2 Speed data — process-local grouped ON,
subject persistence in-memory (zero Mongo writes), fail-fast spies for
web search / OpenRouter / Mongo writes. ≤4 Gemini calls sequential.

Import-safe: no production binding is patched at import; install() applies
all seams and returns restore() (main() calls it in finally).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from dataclasses import replace  # noqa: E402
from shopeechat import conversation_products as cp  # noqa: E402
from shopeechat import runtime_config as rcfg  # noqa: E402
from shopeechat import web_search as ws  # noqa: E402
from shopeechat import llm  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import retrieval_runtime as rrt  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
import shopeechat.app as appmod  # noqa: E402

ITEM = "27639651334"
CONV = "canary-r10a-exact-item-001"
SHOP = "CukTechThailand"

counts = {"gemini": 0, "intent": 0, "answer": 0, "web": 0, "openrouter": 0,
          "mongo_write": 0}
trace: list[dict] = []
_cur: dict = {}

# ── fail-fast spies (defs only — installed by install()) ─────────────────
def _die(name):
    def f(*a, **k):
        counts[name] += 1
        raise RuntimeError(f"CANARY DENIED: {name}")
    return f

# legacy answer counter — grouped path must never reach it (record-only;
# count>0 on a product turn is a finding, not a denial)
_real_answer = llm.answer
def _answer_spy(*a, **k):
    counts["legacy_answer"] = counts.get("legacy_answer", 0) + 1
    return _real_answer(*a, **k)

# ── Mongo write barrier: reads pass, writes die ──────────────────────────
_real_coll = cp._coll
class _ReadOnly:
    def __init__(self, c): self._c = c
    def __getattr__(self, k):
        v = getattr(self._c, k)
        if k in ("update_one", "insert_one", "update_many", "replace_one",
                 "delete_one", "delete_many", "bulk_write",
                 "find_one_and_update", "find_one_and_replace"):
            def w(*a, **k):
                counts["mongo_write"] += 1
                raise RuntimeError(f"CANARY DENIED mongo {k}")
            return w
        return v

# ── in-memory subject persistence (semantics identical to record_subject_set)
_mem: dict = {}
_real_get = cp.get_subject_set
def _get(cid):
    st = _mem.get(cid)
    if st is None:
        return cp.SubjectSetView(None, None, ())
    return cp.SubjectSetView(st, st, (), None,
                             st.subject_ids[0] if st.subject_ids else None)
def _rec(cid, ss, *, expected_prior=None, platform=None, shop=None):
    if ss is None:
        return None
    prior = expected_prior.rev if expected_prior is not None else None
    ss2 = replace(ss, rev=(prior or 0) + 1)
    _mem[cid] = ss2
    return ss2

# ── in-memory timeline (add_product → save_timeline owner replaced; real
#    add_product logic preserved — semantics identical, zero _coll writes)
_tl: dict = {}
def _save_tl(cid, platform, shop, products, active_item_id):
    _tl[cid] = {"conversation_id": cid, "platform": platform, "shop": shop,
                "products": products, "active_item_id": active_item_id}

# ── in-memory claim state (transition/merge owners replaced; fence checks
#    simplified — single-threaded harness has no CAS race)
_claim: dict = {}
def _transition(cid, platform, shop, *, expected_episode_id, expected_stage,
                claim_state):
    cur = _claim.get(cid)
    if cur and (cur.get("episode_id") != expected_episode_id
                or cur.get("stage") != expected_stage):
        return cur          # fence miss → current authoritative state
    _claim[cid] = dict(claim_state or {})
    return _claim[cid]
def _merge(cid, *, episode_id, expected_stage, fields):
    cur = _claim.get(cid)
    if not cur or cur.get("episode_id") != episode_id \
            or (expected_stage is not None
                and cur.get("stage") != expected_stage):
        return cur          # fence miss → current state
    for k, v in (fields or {}).items():
        if v not in (None, "", {}, []):
            cur[k] = v
    return cur
def _order_anchor(conversation_id, platform=None, shop=None, order_sn=None,
                  order=None, **kw):
    doc = _tl.setdefault(conversation_id, {"products": []})
    doc.setdefault("order_anchor", {"order_sn": order_sn, "order": order})
    return doc

# ── Gemini call counter + bounded 503 retry (harness-only; 1 attempt + ≤3
#    retries, wait exactly 5s/5s/5s; 429 counted, no retry — existing key
#    rotation only)
_real_client = llm._client
def _client():
    c = _real_client()
    orig = c.models.generate_content
    def gen(*a, **k):
        counts["gemini"] += 1          # logical call
        waits = (5, 5, 5)
        for attempt in range(4):
            counts["attempts"] = counts.get("attempts", 0) + 1
            t0 = time.time()
            try:
                r = orig(*a, **k)
                trace.append({"__gemini__": 1, "gemini": {
                    "model": k.get("model") or (a[0] if a else "?"),
                    "latency_s": round(time.time() - t0, 2),
                    "attempt": attempt + 1}})
                return r
            except Exception as e:
                code = str(getattr(e, "code", "") or "")
                msg = str(e)
                if "503" in code or "503" in msg or "UNAVAILABLE" in msg:
                    counts["e503"] = counts.get("e503", 0) + 1
                    if attempt < 3:
                        time.sleep(waits[attempt])
                        continue
                elif "429" in code or "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                    counts["e429"] = counts.get("e429", 0) + 1
                raise
    c.models.generate_content = gen
    return c

# intent classifier counter (classify function name may vary)
import os
_DRY = os.environ.get("CANARY_DRY", "")  # "healthy" | "down" | "" (live)
try:
    from shopeechat import intent_classifier as ic
    _real_cls = ic.classify_intent
    _HEALTHY_Q1 = {"intent": "product_inquiry", "product_type": None,
                   "charger_subtype": None, "target_device": None,
                   "relation_target": None, "device_connector": None,
                   "device_min_watt": None, "needs_description": True,
                   "general_qtype": None, "subject_scope": "explicit",
                   "subject_count": None, "policy_reason": "unknown",
                   "policy_item_condition": "unknown",
                   "policy_order_state": "unknown", "confidence": 0.9}
    _HEALTHY_Q2 = {"intent": "product_inquiry", "product_type": None,
                   "charger_subtype": None, "target_device": None,
                   "relation_target": None, "device_connector": None,
                   "device_min_watt": None, "needs_description": True,
                   "general_qtype": None, "subject_scope": "current_single",
                   "subject_count": None, "policy_reason": "unknown",
                   "policy_item_condition": "unknown",
                   "policy_order_state": "unknown", "confidence": 0.9}
    def _cls(*a, **k):
        counts["intent"] += 1
        if _DRY == "healthy":
            m = (k.get("message") or (a[0] if a else ""))
            return dict(_HEALTHY_Q2 if "Speed data" in m else _HEALTHY_Q1)
        if _DRY == "down":
            return dict(ic._DEFAULT_RESULT)
        return _real_cls(*a, **k)
except Exception:
    ic = None  # defs kept; install() skips missing module

# dry mode: answer model replaced by context-capture stub (zero provider calls)
if _DRY:
    def _ans(*, context, shop_hint=None, model=None, persona_extra=""):
        t = _cur
        t["ans_products"] = [str(p.get("item_id")) for p in context.products]
        t["ans_ctx_text"] = context.context_text()
        t["ans_task"] = context.task.render()
        return "DRY_ANSWER", {"prompt": 0, "output": 0, "total": 0}

# ── turn instrumentation ─────────────────────────────────────────────────
_real_decide = td.decide_turn
def _decide(msg, **k):
    plan = _real_decide(msg, **k)
    _cur["planning_msg"] = msg
    _cur["plan"] = [
        {"kind": n.kind, "op": n.operation,
         "subj": tuple(n.subject_refs or ()),
         "tgt": tuple(n.target_refs or ()),
         "types": sorted(n.product_types or ())} for n in plan.needs]
    _cur["tag_item_ids"] = k.get("tag_item_ids")
    return plan

_real_gs = rrt.run_grouped_selection
def _gs(*a, **k):
    out = _real_gs(*a, **k)
    if out is None:                      # fail-closed None → trace untouched
        return out
    t = _cur
    t["requests"] = [{"id": r.request_id, "src": r.source,
                      "subj": tuple(r.subject_refs or ()),
                      "types": sorted(r.product_types or ())}
                     for r in out.get("requests", ())]
    t["selected"] = [{"id": str(s.card.get("item_id")),
                      "id_type": type(s.card.get("item_id")).__name__,
                      "role": s.role} for s in out["selection"].selected]
    t["pool_counts"] = {}
    return out

_real_ctx = acx.compile_answer_context
def _ctx(*a, **k):
    ctx = _real_ctx(*a, **k)
    t = _cur
    t["ctx_ids"] = [{"id": str(p.get("item_id")),
                     "id_type": type(p.get("item_id")).__name__}
                    for p in ctx.products]
    t["ctx_count"] = len(ctx.products)
    t["ctx_text"] = ctx.context_text()
    t["unanswered"] = [{"i": u.need_index, "reason": u.reason}
                       for u in ctx.unanswered_needs]
    t["est_tokens"] = getattr(ctx, "estimated_tokens", None)
    return ctx

_real_resolve = cp.resolve_subjects
def _res(*a, **k):
    r = _real_resolve(*a, **k)
    _cur["subject_res"] = {"outcome": r.outcome,
        "ids": tuple(r.subject_set.subject_ids) if r.subject_set else ()}
    return r


_history: list[dict] = []


def run_turn(msg, item_id=None):
    global _cur
    _cur = {"msg": msg, "subj_before": tuple(
        (_mem.get(CONV).subject_ids if _mem.get(CONV) else ()))}
    trace.append(_cur)
    req = appmod.ChatRequest(message=msg, shop=SHOP, item_id=item_id,
                           conversation_id=CONV, history=list(_history),
                           limit=10)
    g0 = counts["gemini"]
    t0 = time.time()
    resp = appmod.chat(req)
    _history.append({"role": "user", "text": msg})
    _history.append({"role": "model", "text": resp.answer or ""})
    _cur["latency"] = round(time.time() - t0, 2)
    _cur["gemini_calls"] = counts["gemini"] - g0
    _cur["subj_after"] = tuple(
        _mem.get(CONV).subject_ids if _mem.get(CONV) else ())
    _cur["answer"] = resp.answer
    _cur["source"] = resp.source
    _cur["products_n"] = len(resp.products or [])
    return resp


def install():
    """Apply all canary seams (process-local). Returns restore() that puts
    every captured original binding back — call from finally."""
    targets = [
        (rcfg, "grouped_retrieval_selection_enabled"),
        (ws, "search_and_extract"),
        (llm, "_openrouter_generate"), (llm, "answer"), (llm, "_client"),
        (td, "decide_turn"), (rrt, "run_grouped_selection"),
        (acx, "compile_answer_context"),
        (cp, "_coll"), (cp, "get_subject_set"), (cp, "record_subject_set"),
        (cp, "load_timeline"), (cp, "save_timeline"), (cp, "load_claim_state"),
        (cp, "transition_claim_state"), (cp, "merge_claim_fields"),
        (cp, "add_order_anchor"), (cp, "resolve_subjects")]
    if _DRY:
        targets.append((llm, "answer_typed"))
    if ic is not None:
        targets.append((ic, "classify_intent"))
    saved = [(m, n, getattr(m, n)) for m, n in targets]

    rcfg.grouped_retrieval_selection_enabled = lambda: True
    ws.search_and_extract = _die("web")
    llm._openrouter_generate = _die("openrouter")
    llm.answer = _answer_spy
    cp._coll = lambda: _ReadOnly(_real_coll())
    cp.get_subject_set = _get
    cp.record_subject_set = _rec
    cp.load_timeline = lambda cid: _tl.get(cid)
    cp.save_timeline = _save_tl
    cp.load_claim_state = lambda cid: _claim.get(cid)
    cp.transition_claim_state = _transition
    cp.merge_claim_fields = _merge
    cp.add_order_anchor = _order_anchor
    llm._client = _client
    if ic is not None:
        ic.classify_intent = _cls
    if _DRY:
        llm.answer_typed = _ans
    td.decide_turn = _decide
    rrt.run_grouped_selection = _gs
    acx.compile_answer_context = _ctx
    cp.resolve_subjects = _res

    def restore():
        for m, n, old in saved:
            setattr(m, n, old)
    return restore


def main():
    restore = install()
    try:
        import json
        print("=== Q1 ===")
        r1 = run_turn(f"[สินค้า: {ITEM}]")
        print("=== Q2 ===")
        r2 = run_turn("Speed data เท่าไหร่?ครับ")
        Path("/tmp/canary_trace.json").write_text(
            json.dumps({"trace": trace, "counts": counts},
                       ensure_ascii=False, indent=1, default=str))
        print("=== COUNTS ===")
        print(json.dumps(counts))
        print("=== Q1 answer ==="); print(r1.answer[:600])
        print("=== Q2 answer ==="); print(r2.answer[:600])
    finally:
        restore()


if __name__ == "__main__":
    main()
