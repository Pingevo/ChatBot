"""Round 11 — pingevox/mistorethailand live regression, in-process.

Reuses the canary harness stubs (grouped ON, in-memory subject/timeline,
_coll write barrier, web/OR spies, bounded 503 retry 5/5/5) and runs
transcripts from test_pingevox_mistore.py through appmod.chat() directly —
NOT through the user's port-8010 server (which runs older code).

Usage:
  python live_pingevox_mistore_inproc.py pingevox --tag before
    → docs/test/results/phase10b/pingevox_<ts>_before.{json,md}
  python live_pingevox_mistore_inproc.py            → legacy /tmp dump
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR))

import canary_exact_item_attribution as H          # applies all stubs
from test_pingevox_mistore import PINGEVOX_CASES, MISTORE_CASES

import shopeechat.app as appmod
from shopeechat import turn_decision as td
from shopeechat import retrieval_runtime as rrt
from shopeechat import answer_context as acx
from shopeechat import intent_classifier as ic
import shopeechat.conversation_products as cp
import shopeechat.llm as llmmod

TS = int(time.time())
RESULTS_DIR = TEST_DIR / "results" / "phase10b"

# Wattaka conversation (CukTechThailand) — r12 spec:
#   exact magnetic-cable item → data-speed fact ask → magnetic+>=10Gbps browse
WATTAKA_CASES = [
    {"message": "[สินค้า: 27639651334]", "item_id": "27639651334",
     "expect": "product", "shop": "CukTechThailand"},
    {"message": "Speed data เท่าไหร่?ครับ",
     "expect": "spec_answer", "shop": "CukTechThailand"},
    {"message": "มีรุ่น 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหม",
     "expect": "product", "shop": "CukTechThailand"},
]

# ── per-turn instrumentation (module-level — applies to every transcript) ──
_turns: dict[str, list[dict]] = {}
_cur_t: dict = {}


def _intent_spy(*a, **k):
    r = H._cls(*a, **k)          # canary wrapper already counts + dry/live
    _cur_t["intent"] = dict(r)   # complete structured intent result
    return r


def _decide_spy(msg, **k):
    plan = H._decide(msg, **k)   # canary wrapper writes into its own _cur
    _cur_t["planning_msg"] = msg
    _cur_t["plan"] = [{"kind": n.kind, "op": n.operation,
                       "subj": tuple(n.subject_refs or ()),
                       "tgt": tuple(n.target_refs or ()),
                       "types": sorted(n.product_types or ()),
                       "subs": sorted(n.subtypes or ()),
                       "facts": tuple(getattr(n, "requested_facts", ()) or ()),
                       "feats": tuple(getattr(n, "required_features", ()) or ()),
                       "cons": [list(c) for c in
                                (getattr(n, "spec_constraints", ()) or ())],
                       "asks": tuple(getattr(n, "capability_asks", ()) or ()),
                       "subject_scope": n.subject_scope,
                       "subject_count": n.subject_count,
                       "confidence": n.confidence,
                       "provenance": tuple(n.provenance or ())}
                      for n in plan.needs]
    _cur_t["action"] = plan.primary_action
    _cur_t["plan_flags"] = sorted(plan.flags or ())
    return plan


def _gs_spy(*a, **k):
    _cur_t["grouped_path"] = True
    out = H._gs(*a, **k)
    if out is None:                      # fail-closed None → trace untouched
        return out
    sel = out["selection"]
    _cur_t["requests"] = [{"id": r.request_id, "src": r.source,
                           "subj": tuple(r.subject_refs or ()),
                           "tgt": tuple(r.target_refs or ()),
                           "tgt_dev": r.target_device,
                           "types": sorted(r.product_types or ()),
                           "subs": sorted(r.subtypes or ()),
                           "compat_mode": r.compat_mode,
                           "facts": tuple(
                               getattr(r, "requested_facts", ()) or ()),
                           "feats": tuple(
                               getattr(r, "required_features", ()) or ()),
                           "cons": [list(c) for c in
                                    (getattr(r, "spec_constraints", ())
                                     or ())]}
                          for r in out.get("requests", ())]
    _cur_t["selected"] = [{"id": str(s.card.get("item_id")),
                           "id_type": type(s.card.get("item_id")).__name__,
                           "role": s.role, "request_id": s.request_id,
                           "slot_id": s.slot_id, "reason": s.reason,
                           "score": s.score,
                           "constraint_hits": list(s.constraint_hits)}
                          for s in sel.selected]
    _cur_t["rejected_summary"] = list(sel.rejected_summary)
    _cur_t["sel_trace"] = list(sel.trace)
    return out


def _ctx_spy(*a, **k):
    ctx = H._ctx(*a, **k)
    _cur_t["ctx_count"] = len(ctx.products)
    _cur_t["ctx_ids"] = [str(p.get("item_id")) for p in ctx.products]
    _cur_t["ctx_cards"] = [
        {"item_id": str(p.get("item_id")), "name": p.get("item_name"),
         "fields": sorted(p.keys())} for p in ctx.products]
    _cur_t["ctx_text"] = ctx.context_text()
    _cur_t["unanswered"] = [{"i": u.need_index, "reason": u.reason,
                             "asks": tuple(
                                 getattr(u, "capability_asks", ()) or ())}
                            for u in ctx.unanswered_needs]
    _cur_t["constraint_notes"] = [
        dict(n) for n in (getattr(ctx, "constraint_notes", ()) or ())]
    _cur_t["compat_verdicts"] = [
        {"need": v.need_index, "subj": v.subject_id,
         "name": (v.subject_name or "")[:60], "target": v.target,
         "outcome": v.decision.outcome,
         "reasons": tuple(v.decision.reason_codes or ())}
        for v in (getattr(ctx, "compat_verdicts", ()) or ())]
    return ctx


def _res_spy(*a, **k):
    r = H._res(*a, **k)
    _cur_t["subject_res"] = {"outcome": r.outcome,
        "ids": tuple(r.subject_set.subject_ids) if r.subject_set else ()}
    return r


def _tb_spy(*a, **k):
    _cur_t["typed_boundary"] = True
    return _tb_real(*a, **k)
_tb_real = appmod._typed_answer_boundary


# r12-F: truthful answer-model counter — answer_typed IS the answer model on
# the grouped path; counting only legacy llm.answer reported a false zero
_ans_typed_real = llmmod.answer_typed
def _ans_typed_spy(*a, **k):
    H.counts["answer_typed"] = H.counts.get("answer_typed", 0) + 1
    return _ans_typed_real(*a, **k)


def _card_media(p: dict) -> dict:
    keep = {}
    for k, v in (p or {}).items():
        kl = str(k).lower()
        if k in ("item_id", "item_name", "shop_name", "shopname",
                 "status", "stock") or "link" in kl or "url" in kl \
                or "image" in kl or kl.startswith("img"):
            keep[k] = v
    return keep


def run_transcript(name: str, cases: list[dict], conv_id: str):
    global _cur_t
    history: list[dict] = []
    turns = _turns.setdefault(name, [])
    for i, case in enumerate(cases, 1):
        _cur_t = {}
        g0 = H.counts["gemini"]
        a0 = H.counts.get("attempts", 0)
        l0 = H.counts.get("legacy_answer", 0)
        subj_before = tuple(
            (H._mem.get(conv_id).subject_ids if H._mem.get(conv_id) else ()))
        t0 = time.time()
        try:
            resp = appmod.chat(appmod.ChatRequest(
                message=case["message"],
                shop=case.get("shop", "KingGadgets"),
                item_id=case.get("item_id"), order_sn=case.get("order_sn"),
                images=case.get("images") or [], platform="shopee",
                conversation_id=conv_id, history=list(history), limit=5))
            answer = resp.answer or ""
            _cur_t["source"] = resp.source
            _cur_t["model"] = resp.model
            _cur_t["usage"] = resp.usage or {}
            _cur_t["elapsed"] = resp.elapsed
            _cur_t["cost"] = resp.cost
            _cur_t["answer_full"] = answer
            _cur_t["answer_segments"] = list(resp.answer_segments or [])
            _cur_t["resp_products"] = [_card_media(p)
                                       for p in (resp.products or [])]
            _cur_t["handoff"] = resp.handoff_to_admin
            _cur_t["handoff_reason"] = resp.handoff_reason
        except Exception as e:
            turns.append({"q": i, "msg": case["message"],
                          "fatal": f"{type(e).__name__}: {e}"[:300],
                          **_cur_t})
            print(f"[{name} Q{i}] FATAL {type(e).__name__}: {e}"[:150],
                  flush=True)
            return turns     # sequential integrity — do not continue
        elapsed = round(time.time() - t0, 2)
        rec = {"q": i, "msg": case["message"], "expect": case.get("expect"),
               **_cur_t,
               "latency": elapsed,
               "gemini": H.counts["gemini"] - g0,
               "attempts": H.counts.get("attempts", 0) - a0,
               "legacy_answer_calls": H.counts.get("legacy_answer", 0) - l0,
               "subj_before": subj_before,
               "subj_after": tuple(
                   H._mem.get(conv_id).subject_ids
                   if H._mem.get(conv_id) else ())}
        turns.append(rec)
        history.append({"role": "user", "text": case["message"]})
        history.append({"role": "model", "text": answer})
        print(f"[{name} Q{i}] {elapsed}s gem={rec['gemini']} "
              f"att={rec['attempts']} intent={(_cur_t.get('intent') or {}).get('intent')} "
              f"src={_cur_t.get('source')} "
              f"sel={[s['id'] for s in _cur_t.get('selected', [])]}",
              flush=True)
    return turns


def _md(turns: list[dict], name: str, tag: str) -> str:
    out = [f"# {name} — {tag} (ts={TS})", ""]
    for t in turns:
        out.append(f"## Q{t['q']}: {t['msg']}")
        if t.get("fatal"):
            out.append(f"FATAL: {t['fatal']}")
            continue
        inten = t.get("intent") or {}
        out.append(f"- intent: `{inten.get('intent')}` "
                   f"conf={inten.get('confidence')} "
                   f"scope={inten.get('subject_scope')} "
                   f"count={inten.get('subject_count')} "
                   f"type={inten.get('product_type')} "
                   f"subtype={inten.get('charger_subtype')} "
                   f"target={inten.get('target_device')} "
                   f"rel={inten.get('relation_target')} "
                   f"facts={inten.get('requested_facts')} "
                   f"feats={inten.get('required_features')} "
                   f"cons={inten.get('spec_constraints')}")
        out.append(f"- action={t.get('action')} plan={t.get('plan')}")
        out.append(f"- subject_res={t.get('subject_res')} "
                   f"subj {t.get('subj_before')} → {t.get('subj_after')}")
        out.append(f"- requests={t.get('requests')}")
        out.append(f"- selected={[(s['id'], s['role']) for s in t.get('selected', [])]}")
        out.append(f"- rejected={t.get('rejected_summary')}")
        out.append(f"- ctx={t.get('ctx_ids')} unanswered={t.get('unanswered')} "
                   f"constraint_notes={t.get('constraint_notes')}")
        out.append(f"- grouped={t.get('grouped_path')} "
                   f"typed_boundary={t.get('typed_boundary')} "
                   f"legacy_answer_calls={t.get('legacy_answer_calls')}")
        out.append(f"- gemini={t.get('gemini')} attempts={t.get('attempts')} "
                   f"latency={t.get('latency')}s usage={t.get('usage')}")
        out.append(f"- resp_products={t.get('resp_products')}")
        out.append(f"- handoff={t.get('handoff')} {t.get('handoff_reason')}")
        out.append("")
        out.append("### Answer")
        out.append(t.get("answer_full") or "")
        out.append("")
        if t.get("answer_segments"):
            out.append("### Segments")
            for s in t["answer_segments"]:
                out.append(f"- {s}")
        out.append("")
    out.append(f"counts: {json.dumps(H.counts)}")
    return "\n".join(out)


def _bind_live_spies():
    """bind live spies on top of H's installed seams; returns saved list."""
    saved = [(m, n, getattr(m, n)) for m, n in (
        (ic, "classify_intent"), (td, "decide_turn"),
        (rrt, "run_grouped_selection"), (acx, "compile_answer_context"),
        (cp, "resolve_subjects"), (appmod, "_typed_answer_boundary"),
        (llmmod, "answer_typed"))]
    ic.classify_intent = _intent_spy
    td.decide_turn = _decide_spy
    rrt.run_grouped_selection = _gs_spy
    acx.compile_answer_context = _ctx_spy
    cp.resolve_subjects = _res_spy
    appmod._typed_answer_boundary = _tb_spy
    llmmod.answer_typed = _ans_typed_spy
    return saved


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else None
    tag = "run"
    if "--tag" in sys.argv:
        tag = sys.argv[sys.argv.index("--tag") + 1]
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    _h_restore = H.install()          # harness seams (grouped flag, in-mem
                                    # stores, _coll barrier, retry client)
    _live_saved = _bind_live_spies()  # live spies on top of H seams
    if only == "pingevox_wattaka":
        run_transcript("pingevox", PINGEVOX_CASES, f"r12-pingevox-{TS}")
        run_transcript("wattaka", WATTAKA_CASES, f"r12-wattaka-{TS}")
    else:
        if only == "pingevox" or only is None:
            run_transcript("pingevox", PINGEVOX_CASES, f"r11-pingevox-{TS}")
        if only == "wattaka":
            run_transcript("wattaka", WATTAKA_CASES, f"r12-wattaka-{TS}")
        if only == "mistore" or only is None:
            run_transcript("mistore", MISTORE_CASES, f"r11-mistore-{TS}")
    if only:
        turns = ([t for tr in ("pingevox", "wattaka")
                  for t in _turns.get(tr, [])]
                 if only == "pingevox_wattaka" else _turns.get(only, []))
        base = RESULTS_DIR / f"{only}_{TS}_{tag}"
        Path(str(base) + ".json").write_text(json.dumps(
            {"name": only, "tag": tag, "ts": TS,
             "transcripts": _turns if only == "pingevox_wattaka" else None,
             "turns": turns, "counts": H.counts},
            ensure_ascii=False, indent=1, default=str))
        md_parts = [_md(_turns.get(n, []), n, tag)
                    for n in (("pingevox", "wattaka")
                              if only == "pingevox_wattaka" else (only,))]
        Path(str(base) + ".md").write_text("\n\n".join(md_parts))
        print(f"JSON: {base}.json")
        print(f"MD:   {base}.md")
    else:
        Path("/tmp/live_r11_results.json").write_text(json.dumps(
            {"turns": _turns, "counts": H.counts}, ensure_ascii=False,
            indent=1, default=str))
    print("=== COUNTS ===")
    print(json.dumps(H.counts))
    for _m, _n, _o in _live_saved:    # live spies → back to H seams
        setattr(_m, _n, _o)
    _h_restore()                      # H seams → back to production originals
