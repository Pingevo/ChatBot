"""Phase 10B local grouped canary — subprocess harness, audit-only.

Runs 3 synthetic conversations (A wattaka/CMC615P · B pingevox/CTL301 ·
C IMILAB W01 Strava) against the live published generation with
USE_GROUPED_RETRIEVAL_SELECTION=1 process-local.

Safety:
- env flag set by launcher before import (asserted ON in-process)
- ws.search_and_extract + llm._openrouter_generate = forbidden die-spies
- llm.answer/answer_general/answer_with_kb = legacy-entry spies (count only)
- all conversation_products persistence → in-memory (zero Mongo writes)
- Mongo read-only barrier on cp._coll; product DB untouched by app anyway
- Gemini bounded: logical call count + 503-only retry (5s,5s,5s, ≤4 attempts)
- CANARY_DRY=1 → answer_typed stub captures context (0 provider calls)
- results persisted per-turn to gitignored artifacts
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("USE_GROUPED_RETRIEVAL_SELECTION", "1")

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
from shopeechat import generation_pointer as gp  # noqa: E402
import shopeechat.app as appmod  # noqa: E402

EXPECTED_GID = "g20261024-072533-2be3443e"
ITEM_A = "27639651334"   # CUKTECH CMC615P — CukTechThailand
ITEM_B = "49267582152"   # CUKTECH CTL301 — KingGadgets
SHOP_A = "CukTechThailand"
SHOP_B = "KingGadgets"
SHOP_C = "IMILabThailand"

TS = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
OUT_JSON = ROOT / "docs/test/results" / f"phase10b_grouped_canary_{TS}.json"
OUT_MD = ROOT / "docs/test/results" / f"phase10b_grouped_canary_{TS}.md"

counts = {"gemini": 0, "attempts": 0, "e503": 0, "e429": 0, "intent": 0,
          "answer_typed": 0, "legacy_answer": 0, "answer_general": 0,
          "answer_with_kb": 0, "web": 0, "openrouter": 0, "mongo_write": 0,
          "describe_image": 0}
trace: list[dict] = []
_cur: dict = {}
results: list[dict] = []

# ── flag must be ON in-process (env or persisted config) ──────────────────
assert rcfg.grouped_retrieval_selection_enabled(), \
    "grouped_retrieval_selection_enabled() is not ON in-process"

snap0 = gp.resolve_snapshot(force=True)
assert getattr(snap0, "generation_id", None) == EXPECTED_GID, \
    f"active generation {getattr(snap0,'generation_id',None)} != {EXPECTED_GID}"

# ── fail-fast spies (web/openrouter forbidden) ────────────────────────────
def _die(name):
    def f(*a, **k):
        counts[name] += 1
        raise RuntimeError(f"CANARY DENIED: {name}")
    return f

ws.search_and_extract = _die("web")
if hasattr(ws, "search_and_answer"):
    ws.search_and_answer = _die("web")
llm._openrouter_generate = _die("openrouter")

# ── other llm entry points — count-only spies ─────────────────────────────
for _name in ("answer", "answer_general", "answer_with_kb"):
    _real = getattr(llm, _name)
    def _mk(r, n):
        def _spy(*a, **k):
            counts["legacy_answer" if n == "answer" else n] += 1
            return r(*a, **k)
        return _spy
    setattr(llm, _name, _mk(_real, _name))
for _name in ("describe_image", "describe_images"):
    if hasattr(llm, _name):
        setattr(llm, _name, _die("describe_image"))

# ── Mongo write barrier ─────────────────────────────────────────────────
_real_coll = cp._coll
class _ReadOnly:
    def __init__(self, c): self._c = c
    def __getattr__(self, k):
        v = getattr(self._c, k)
        if k in ("update_one", "insert_one", "update_many", "replace_one",
                 "delete_one", "delete_many", "bulk_write",
                 "find_one_and_update", "find_one_and_replace",
                 "find_one_and_delete"):
            def w(*a, **k):
                counts["mongo_write"] += 1
                raise RuntimeError(f"CANARY DENIED mongo {k}")
            return w
        return v
cp._coll = lambda: _ReadOnly(_real_coll())

# ── in-memory conversation state (semantics identical to r10a harness) ────
_mem: dict = {}
_real_get = cp.get_subject_set
def _get(cid):
    st = _mem.get(cid)
    if st is None:
        return cp.SubjectSetView(None, None, ())
    return cp.SubjectSetView(st, st, (), None,
                             st.subject_ids[0] if st.subject_ids else None)
cp.get_subject_set = _get
def _rec(cid, ss, *, expected_prior=None, platform=None, shop=None):
    if ss is None:
        return None
    prior = expected_prior.rev if expected_prior is not None else None
    ss2 = replace(ss, rev=(prior or 0) + 1)
    _mem[cid] = ss2
    return ss2
cp.record_subject_set = _rec
_tl: dict = {}
cp.load_timeline = lambda cid: _tl.get(cid)
def _save_tl(cid, platform, shop, products, active_item_id):
    _tl[cid] = {"conversation_id": cid, "platform": platform, "shop": shop,
                "products": products, "active_item_id": active_item_id}
cp.save_timeline = _save_tl
_claim: dict = {}
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

# ── Gemini bounded calls (logical count; 503-only retry 5s×3, ≤4 attempts) ─
_real_client = llm._client
def _client():
    c = _real_client()
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
                code = str(getattr(e, "code", "") or "")
                msg = str(e)
                if "503" in code or "503" in msg or "UNAVAILABLE" in msg:
                    counts["e503"] += 1
                    if attempt < 3:
                        time.sleep(waits[attempt])
                        continue
                elif "429" in code or "429" in msg \
                        or "RESOURCE_EXHAUSTED" in msg:
                    counts["e429"] += 1
                raise
    c.models.generate_content = gen
    return c
llm._client = _client

# ── intent counter ───────────────────────────────────────────────────────
try:
    from shopeechat import intent_classifier as ic
    _real_cls = ic.classify_intent
    def _cls(*a, **k):
        counts["intent"] += 1
        return _real_cls(*a, **k)
    ic.classify_intent = _cls
except Exception:
    pass

_DRY = os.environ.get("CANARY_DRY", "")

def _answer_typed_counted(*, context, shop_hint=None, model=None,
                          persona_extra=""):
    counts["answer_typed"] += 1
    return _real_answer_typed(context=context, shop_hint=shop_hint,
                              model=model, persona_extra=persona_extra)
_real_answer_typed = llm.answer_typed
if _DRY:
    def _ans(*, context, shop_hint=None, model=None, persona_extra=""):
        counts["answer_typed"] += 1
        _cur["ans_task"] = context.task.render()
        return "DRY_ANSWER", {"prompt": 0, "output": 0, "total": 0}
    llm.answer_typed = _ans
else:
    llm.answer_typed = _answer_typed_counted

# ── turn instrumentation ─────────────────────────────────────────────────
_real_decide = td.decide_turn
def _decide(msg, **k):
    plan = _real_decide(msg, **k)
    _cur["normalized_input"] = msg
    _cur["plan"] = [
        {"kind": n.kind, "op": n.operation,
         "subj": tuple(n.subject_refs or ()),
         "tgt": tuple(n.target_refs or ()),
         "types": sorted(n.product_types or ())} for n in plan.needs]
    _cur["tag_item_ids"] = k.get("tag_item_ids")
    return plan
td.decide_turn = _decide
appmod.td = td

_real_slots = rrt.build_retrieval_slots
def _slots(profile, **k):
    s = _real_slots(profile, **k)
    _cur["slots"] = [dict(vars(x)) if hasattr(x, "__dict__") else str(x)
                     for x in s]
    return s
rrt.build_retrieval_slots = _slots

_real_gs = rrt.run_grouped_selection
def _gs(*a, **k):
    out = _real_gs(*a, **k)
    t = _cur
    if out is None:
        t["grouped"] = "None (exception → deterministic)"
        return out
    t["snap_gid"] = getattr(k.get("snap"), "generation_id", None)
    t["requests"] = [{"id": r.request_id, "src": r.source,
                      "subj": tuple(r.subject_refs or ()),
                      "types": sorted(r.product_types or ())}
                     for r in out.get("requests", ())]
    pool = out["pool"]
    t["pool"] = {
        "eligible": [{"item_id": c.item_id, "unit_id": c.unit_id,
                      "model_id": c.model_id, "sources": list(c.sources),
                      "bucket": c.bucket, "score": c.score}
                     for c in pool.eligible],
        "unavailable": [{"item_id": c.item_id, "reason": c.reason}
                        for c in pool.unavailable],
        "rejected": [{"item_id": c.item_id, "reason": c.reason}
                     for c in pool.rejected],
        "evidence": [{"kind": e.kind, "item_id": e.item_id,
                      "linked": e.linked_candidate}
                     for e in pool.evidence_pool],
    }
    sel = out["selection"]
    t["selected"] = [{"item_id": str(s.card.get("item_id")),
                      "role": s.role,
                      "hits": list(getattr(s, "constraint_hits", ()) or ())}
                     for s in sel.selected]
    t["sel_unavailable"] = len(getattr(sel, "unavailable_evidence", ()) or ())
    t["rejected_summary"] = getattr(sel, "rejected_summary", None)
    t["summary"] = out["summary"]
    return out
rrt.run_grouped_selection = _gs

_real_ctask = acx.compile_answer_task
def _ctask(*a, **k):
    try:
        task = _real_ctask(*a, **k)
    except Exception as e:
        _cur["task_error"] = f"{type(e).__name__}: {e}"
        raise
    _cur["task_obj"] = {"tasks_n": len(getattr(task, "tasks", ()) or ()),
                        "deferred": [str(d) for d in
                                     getattr(task, "deferred", ()) or ()]}
    return task
acx.compile_answer_task = _ctask

_real_ctx = acx.compile_answer_context
def _ctx(*a, **k):
    try:
        ctx = _real_ctx(*a, **k)
    except Exception as e:
        _cur["ctx_error"] = f"{type(e).__name__}: {e}"
        raise
    t = _cur
    t["ctx_ids"] = [str(p.get("item_id")) for p in ctx.products]
    t["ctx_count"] = len(ctx.products)
    t["ctx_is_empty"] = getattr(ctx, "is_empty", None)
    t["ctx_evidence_ids"] = [str(e.get("item_id") or e.get("unit_id"))
                             for e in getattr(ctx, "evidence", ()) or ()]
    t["unanswered"] = [{"i": u.need_index, "reason": u.reason}
                       for u in ctx.unanswered_needs]
    t["task"] = ctx.task.render() if hasattr(ctx.task, "render") \
        else str(ctx.task)
    return ctx
acx.compile_answer_context = _ctx

_real_resolve = cp.resolve_subjects
def _res(*a, **k):
    r = _real_resolve(*a, **k)
    _cur["subject_res"] = {"outcome": r.outcome,
        "ids": tuple(r.subject_set.subject_ids) if r.subject_set else ()}
    return r
cp.resolve_subjects = _res

_histories: dict[str, list[dict]] = {}


def run_turn(conv: str, shop: str, msg: str, item_id: str | None = None,
             expect: dict | None = None) -> dict:
    global _cur
    _cur = {"conv": conv, "msg": msg,
            "subj_before": tuple(
                (_mem.get(conv).subject_ids if _mem.get(conv) else ()))}
    trace.append(_cur)
    hist = _histories.setdefault(conv, [])
    req = appmod.ChatRequest(message=msg, shop=shop, item_id=item_id,
                           conversation_id=conv, history=list(hist),
                           limit=10)
    g0 = counts["gemini"]
    at0 = counts["answer_typed"]
    t0 = time.time()
    err = None
    resp = None
    try:
        resp = appmod.chat(req)
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
    lat = round(time.time() - t0, 2)
    if resp is not None:
        hist.append({"role": "user", "text": msg})
        hist.append({"role": "model", "text": resp.answer or ""})
    _cur["latency"] = lat
    _cur["gemini_calls"] = counts["gemini"] - g0
    _cur["answer_typed_calls"] = counts["answer_typed"] - at0
    _cur["subj_after"] = tuple(
        (_mem.get(conv).subject_ids if _mem.get(conv) else ()))
    rec = {
        "conv": conv, "msg": msg, "item_id": item_id,
        "answer": (resp.answer if resp else None),
        "source": (resp.source if resp else None),
        "products_n": (len(resp.products or []) if resp else 0),
        "latency_s": lat, "gemini_calls": _cur["gemini_calls"],
        "answer_typed_calls": _cur["answer_typed_calls"],
        "web_calls": counts["web"], "openrouter_calls": counts["openrouter"],
        "mongo_writes": counts["mongo_write"],
        "error": err, "expect": expect or {},
        "plan": _cur.get("plan"), "subject_res": _cur.get("subject_res"),
        "requests": _cur.get("requests"), "slots": _cur.get("slots"),
        "snap_gid": _cur.get("snap_gid"), "pool": _cur.get("pool"),
        "selected": _cur.get("selected"), "summary": _cur.get("summary"),
        "ctx_ids": _cur.get("ctx_ids"), "unanswered": _cur.get("unanswered"),
        "ctx_is_empty": _cur.get("ctx_is_empty"),
        "task_obj": _cur.get("task_obj"), "ctx_error": _cur.get("ctx_error"),
        "task_error": _cur.get("task_error"),
        "task": _cur.get("task") or _cur.get("ans_task"),
        "subj_before": _cur.get("subj_before"),
        "subj_after": _cur.get("subj_after"),
        "gemini_log": _cur.get("gemini_log"),
        "tag_item_ids": _cur.get("tag_item_ids"),
    }
    results.append(rec)
    _persist()
    return rec


def _persist():
    OUT_JSON.write_text(json.dumps(
        {"gid": EXPECTED_GID, "ts": TS, "dry": bool(_DRY),
         "counts": counts, "results": results},
        ensure_ascii=False, indent=1, default=str))


# ── conversation scripts ─────────────────────────────────────────────────
CONV_A = f"canary10b-a-{TS}"
CONV_B = f"canary10b-b-{TS}"
CONV_C = f"canary10b-c-{TS}"

SCRIPT = [
    (CONV_A, SHOP_A, f"[สินค้า: {ITEM_A}]", ITEM_A,
     {"name": "A1 tag CMC615P",
      "must": ["exact_item_selected", "selected_is", ITEM_A]}),
    (CONV_A, SHOP_A, "Speed data เท่าไหร่ครับ", None,
     {"name": "A2 speed-data follow-up",
      "must": ["anchor_persists", ITEM_A]}),
    (CONV_A, SHOP_A,
     "มีรุ่นที่ speed 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหมครับ", None,
     {"name": "A3 magnetic+10Gbps discovery"}),
    (CONV_B, SHOP_B, f"[สินค้า: {ITEM_B}]", ITEM_B,
     {"name": "B1 tag CTL301",
      "must": ["exact_item_selected", "selected_is", ITEM_B]}),
    (CONV_B, SHOP_B, "ซาหวัดดีจ้า", None,
     {"name": "B2 greeting"}),
    (CONV_B, SHOP_B, "อยากได้ของที่ใช้กับ Xiaomi 17 Ultra", None,
     {"name": "B3 target Xiaomi17Ultra"}),
    (CONV_B, SHOP_B, "หัวชาร์จละ", None,
     {"name": "B4 inherit-target charger"}),
    (CONV_B, SHOP_B, "ดีจ้า", None,
     {"name": "B5 greeting"}),
    (CONV_C, SHOP_C, "รุ่น IMILAB W01 เชื่อมต่อกับ Strava ได้ไหม", None,
     {"name": "C1 W01 Strava compat safety"}),
]


def main():
    print(f"gid={EXPECTED_GID} dry={bool(_DRY)} ts={TS}")
    fails_infra = 0
    for conv, shop, msg, item, expect in SCRIPT:
        if fails_infra >= 3:
            print(f"STOP: {fails_infra} consecutive infra failures")
            break
        rec = run_turn(conv, shop, msg, item_id=item, expect=expect)
        infra_fail = rec["error"] is not None or \
            (rec["answer"] is None and rec["gemini_calls"] > 0)
        fails_infra = fails_infra + 1 if infra_fail else 0
        ans = (rec["answer"] or "")[:90].replace("\n", " ")
        print(f"[{expect['name']}] src={rec['source']} "
              f"g={rec['gemini_calls']} at={rec['answer_typed_calls']} "
              f"sel={len(rec['selected'] or [])} "
              f"err={rec['error']} :: {ans}")
    _persist()
    print("=== COUNTS ===")
    print(json.dumps(counts, indent=1))
    print(f"artifacts: {OUT_JSON.name}")


if __name__ == "__main__":
    main()
