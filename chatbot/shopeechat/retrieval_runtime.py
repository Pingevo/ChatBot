"""retrieval_runtime.py — grouped-retrieval selection → typed Phase 7 output.

flag-gated (USE_GROUPED_RETRIEVAL_SELECTION): รัน slots/relations→requests→
executor→pool→selector ครั้งเดียว แล้วคืน typed artifacts
{"selection", "pool", "requests", "summary"} — Phase 7 compiler
(answer_context) เป็น owner เดียวของ products/context/notes; exception→None
→ caller fail closed (deterministic reply, legacy ไม่ re-enter)
"""
from __future__ import annotations

from dataclasses import replace

from . import generation_pointer as _gen
from . import runtime_config as _rc
from .route_context import build_retrieval_slots, build_retrieval_relations
from .retrieval_planner import (
    build_grouped_retrieval_requests, channel_request)
from .retrieval_executor import execute_grouped_retrieval_requests
from .candidate_pool import build_candidate_pool
from .retrieval_selection import select_for_llm_context
from .turn_decision import PRODUCTISH_NEED_KINDS


def run_grouped_selection(
    profile,
    *,
    message: str,
    shop: str | None,
    platform: str = "shopee",
    per_request_limit: int = 3,
    unavailable_limit: int = 5,
    fetcher=None,
    legacy_fetcher="auto",
    subject_cards=(),
    compat_cards=(),
    kb_fetcher=None,
    supporting=(),
    needs=(),
    snap=_gen.SNAP_UNSET,
    history_cards=(),
    desc_fetcher=None,
) -> dict | None:
    """profile → pipeline → selection (ไม่ merge base) — รันครั้งเดียวต่อ request.

    subject_cards/compat_cards = branch evidence ที่ resolve แล้ว (owner =
    conversation_products/device_compat) · kb_fetcher = deferred KB product
    evidence fn (signature เดียวกับ fetch_fn ของ executor — run ใน executor
    เพื่อ isolate failure) · supporting = non-candidate evidence records
    (kb_qa/kb_raw/vision) เข้า pool.supporting_evidence

    Returns {"selection", "pool", "requests", "summary"} เสมอเมื่อ pipeline
    รันสำเร็จ (selection.selected อาจว่าง — compiler owns context จากนี้);
    None เฉพาะ exception — flag-ON caller fail closed (deterministic reply)
    """
    try:
        slots = build_retrieval_slots(profile, needs=needs)
        relations = build_retrieval_relations(
            profile, slots,
            allow_reversed=any(n.kind in PRODUCTISH_NEED_KINDS
                               for n in needs))
        requests = build_grouped_retrieval_requests(
            profile, slots, relations, needs=needs)
        # evidence channels — synthetic request rows เพื่อให้ selector iterate
        # ได้ (quota แยกต่อ channel); fetch = closure บน pre-resolved data
        channels: list = []
        if subject_cards:
            cards = tuple(subject_cards)
            channels.append((channel_request("subjects"),
                             lambda *a, _d=cards, **k: _d))
        if compat_cards:
            cards = tuple(compat_cards)
            channels.append((channel_request("compat"),
                             lambda *a, _d=cards, **k: _d))
        if history_cards:
            # prior-subject reference channel — cards ที่เคยคุยกันเข้า
            #   context เป็น historical_evidence (ไม่ใช่ candidate ของ
            #   need ปัจจุบัน — ต่างจาก subjects channel ที่ resolve identity)
            cards = tuple(history_cards)
            channels.append((channel_request("history"),
                             lambda *a, _d=cards, **k: _d))
        if kb_fetcher is not None and _rc.source_enabled("kb"):
            channels.append((channel_request("kb"), kb_fetcher))
        if desc_fetcher is not None and any(
                n.kind in PRODUCTISH_NEED_KINDS for n in needs):
            # description-chunk recall (Phase 10B) — candidate-recall source
            #   only: subject_refs ของ turn ผ่านเข้า channel request →
            #   fetcher restrict hits ตาม anchor_item_ids เดิม (exact-item
            #   isolation); pool/selection เจ้าเดิมตัดสินเสมอ
            channels.append((replace(
                channel_request("description"),
                subject_refs=tuple(
                    getattr(profile, "anchor_item_ids", ()) or ())),
                            desc_fetcher))
        results = execute_grouped_retrieval_requests(
            requests, message=message, shop=shop, platform=platform,
            fetcher=fetcher, legacy_fetcher=legacy_fetcher,
            channels=channels, snap=snap)
        pool = build_candidate_pool(results, profile=profile,
                                    supporting_evidence=tuple(supporting))
        # request-iteration order = candidate precedence contract
        #   (selection = ordering owner เดียว): subjects channel ก่อน —
        #   persisted subject = identity authority ของ need ที่มัน serve
        _sel_requests = (
            tuple(r for r, _ in channels if r.source == "subjects")
            + requests
            + tuple(r for r, _ in channels if r.source != "subjects"))
        sel = select_for_llm_context(
            pool, _sel_requests, profile,
            needs=needs,
            per_request_limit=per_request_limit,
            unavailable_limit=unavailable_limit)
    except Exception:
        return None

    role_counts: dict[str, int] = {}
    for s in sel.selected:
        role_counts[s.role] = role_counts.get(s.role, 0) + 1
    summary = {
        "selected": role_counts,
        "selected_total": len(sel.selected),
        "unavailable": len(sel.unavailable_evidence),
        "rejected": sum(r.get("count", 0) for r in sel.rejected_summary),
        "by_request": {rid: len(c) for rid, c in sel.by_request},
        "top_selected": [
            {"name": (s.card.get("name") or "")[:60], "role": s.role,
             "hits": list(s.constraint_hits)}
            for s in sel.selected[:6]],
    }
    # Phase 7 — typed artifacts เท่านั้น; products/context/notes = compiler
    # (answer_context.compile_answer_context) owner เดียว — runtime ไม่สร้าง
    # selected_cards/extra_context อีก (legacy grouped assembly ถูกลบแล้ว)
    return {"selection": sel, "pool": pool,
            "requests": _sel_requests,
            "summary": summary}


def prepare_grouped_selection(
    profile,
    *,
    message: str,
    shop: str | None,
    platform: str = "shopee",
    limit: int = 30,
    per_request_limit: int = 3,
    unavailable_limit: int = 5,
    fetcher=None,
    legacy_fetcher="auto",
    needs=(),
    snap=_gen.SNAP_UNSET,
) -> dict | None:
    """run_grouped_selection + Phase-7 compile — helper แบบครบจบ
    (tests/probes); products = AnswerContext.products เท่านั้น (canonical
    owns context เมื่อ pipeline รันได้ — ไม่ merge legacy base เด็ดขาด)"""
    out = run_grouped_selection(
        profile, message=message, shop=shop, platform=platform,
        per_request_limit=per_request_limit,
        unavailable_limit=unavailable_limit,
        fetcher=fetcher, legacy_fetcher=legacy_fetcher, needs=needs,
        snap=snap)
    if out is None:
        return None
    from . import answer_context as _acx
    ctx = _acx.compile_answer_context(
        needs=needs, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=profile)
    products = list(ctx.products)[:limit]
    out["summary"] = {**out["summary"], "merged_total": len(products)}
    return {"products": products, "context": ctx, "summary": out["summary"]}
