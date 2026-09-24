"""retrieval_runtime.py — Task 5B3-C: grouped-retrieval selection → LLM context.

flag-gated (USE_GROUPED_RETRIEVAL_SELECTION): prepare สินค้าที่ selector
เลือก + merge กับ products เดิม — caller fallback เป็นของเดิมเมื่อคืน None;
output cards strip private evidence แล้ว, role tag ผ่าน _context_note
"""
from __future__ import annotations

from .route_context import build_retrieval_slots, build_retrieval_relations
from .retrieval_planner import build_grouped_retrieval_requests
from .retrieval_executor import execute_grouped_retrieval_requests
from .candidate_pool import build_candidate_pool
from .retrieval_selection import select_for_llm_context

_ROLE_NOTE = {
    "slot": "สินค้าที่ลูกค้าถามถึงหรืออ้างอิงโดยตรง",
    "relation_target": "สินค้าที่ใช้ร่วมกันได้ตามความสัมพันธ์ของคำถาม",
}


def _item_id(card: dict) -> str | None:
    """item_id canonical — float/int-float-str normalize เหมือน candidate_pool"""
    from .retrieval_policy import _norm_id
    v = card.get("item_id")
    return _norm_id(v) if v is not None else None


def merge_selected_products(
    selected_cards: list[dict],
    base_products: list[dict] | None,
    limit: int,
) -> list[dict]:
    """selected มาก่อน + base ที่ไม่ซ้ำ item_id — dedupe (selected ชนะ) + cap"""
    sel_ids = {_item_id(c) for c in selected_cards} - {None}
    merged = list(selected_cards)
    for p in base_products or []:
        if _item_id(p) in sel_ids:
            continue
        merged.append(p)
    return merged[:limit]


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
) -> dict | None:
    """profile → pipeline → selection (ไม่ merge base) — รันครั้งเดียวต่อ request.

    Returns {"selected_cards", "extra_context", "summary"} หรือ None เมื่อ
    error/ไม่มี selection — caller ใช้ products เดิมต่อ (fallback)
    """
    try:
        slots = build_retrieval_slots(profile)
        relations = build_retrieval_relations(profile, slots)
        requests = build_grouped_retrieval_requests(profile, slots, relations)
        results = execute_grouped_retrieval_requests(
            requests, message=message, shop=shop, platform=platform,
            fetcher=fetcher, legacy_fetcher=legacy_fetcher)
        pool = build_candidate_pool(results, profile=profile)
        sel = select_for_llm_context(
            pool, requests, profile,
            per_request_limit=per_request_limit,
            unavailable_limit=unavailable_limit)
    except Exception:
        return None
    if not sel.selected:
        return None

    # selected cards — role tag ผ่าน _context_note (stripped แล้วจาก selector)
    selected_cards: list[dict] = []
    for s in sel.selected:
        card = dict(s.card)
        note = _ROLE_NOTE.get(s.role)
        if note:
            card["_context_note"] = note
        selected_cards.append(card)

    # unavailable → evidence note (ไม่ใช่ recommendation) ผ่าน extra_context
    extra_context = None
    if sel.unavailable_evidence:
        names = []
        for u in sel.unavailable_evidence[:unavailable_limit]:
            n = (u.get("name") or "").strip()
            if n and n not in names:
                names.append(n)
        if names:
            extra_context = (
                "หมายเหตุ: พบสินค้าที่เกี่ยวข้องในร้านแต่ยังไม่พร้อมจำหน่าย "
                "(หมดสต็อก/เลิกขาย/ถูกลบ) — ใช้เป็นข้อมูลเท่านั้น "
                "ห้ามแนะนำเป็นสินค้าที่ซื้อได้: " + ", ".join(names))

    role_counts: dict[str, int] = {}
    for s in sel.selected:
        role_counts[s.role] = role_counts.get(s.role, 0) + 1
    summary = {
        "selected": role_counts,
        "selected_total": len(selected_cards),
        "unavailable": len(sel.unavailable_evidence),
        "rejected": sum(r.get("count", 0) for r in sel.rejected_summary),
        "by_request": {rid: len(c) for rid, c in sel.by_request},
        "top_selected": [
            {"name": (s.card.get("name") or "")[:60], "role": s.role,
             "hits": list(s.constraint_hits)}
            for s in sel.selected[:6]],
    }
    return {"selected_cards": selected_cards,
            "extra_context": extra_context, "summary": summary}


def prepare_grouped_selection(
    profile,
    *,
    message: str,
    shop: str | None,
    platform: str = "shopee",
    base_products: list[dict] | None = None,
    limit: int = 30,
    per_request_limit: int = 3,
    unavailable_limit: int = 5,
    fetcher=None,
    legacy_fetcher="auto",
) -> dict | None:
    """run_grouped_selection + merge base — helper แบบครบจบ (tests/probes)"""
    out = run_grouped_selection(
        profile, message=message, shop=shop, platform=platform,
        per_request_limit=per_request_limit,
        unavailable_limit=unavailable_limit,
        fetcher=fetcher, legacy_fetcher=legacy_fetcher)
    if out is None:
        return None
    merged = merge_selected_products(out["selected_cards"], base_products,
                                     limit)
    out["summary"] = {**out["summary"], "merged_total": len(merged),
                      "base_kept": len(merged) - len(out["selected_cards"])}
    return {"products": merged, "extra_context": out["extra_context"],
            "summary": out["summary"]}
