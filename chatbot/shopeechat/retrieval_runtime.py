"""retrieval_runtime.py — Task 5B3-C: grouped-retrieval selection → LLM context.

flag-gated (USE_GROUPED_RETRIEVAL_SELECTION): prepare สินค้าที่ selector
เลือก — flag ON → canonical owns context (ว่าง=ว่าง / exception→None→caller
fail closed products=[] — legacy ไม่ re-enter); output cards strip private
evidence แล้ว, role tag ผ่าน _context_note
"""
from __future__ import annotations

from .route_context import build_retrieval_slots, build_retrieval_relations
from .retrieval_planner import (
    build_grouped_retrieval_requests, channel_request)
from .retrieval_executor import execute_grouped_retrieval_requests
from .candidate_pool import _identity_key, build_candidate_pool
from .retrieval_selection import select_for_llm_context

_ROLE_NOTE = {
    "subject": "สินค้าที่ลูกค้าถามถึงหรืออ้างอิงโดยตรง",
    "slot": "สินค้าที่ลูกค้าถามถึงหรืออ้างอิงโดยตรง",
    "alternative": "สินค้าแนะนำทดแทน — ไม่ใช่รุ่นที่ลูกค้าถามถึงโดยตรง "
                   "ให้บอกว่าเป็นรุ่นทดแทน",
    "relation_target": "สินค้าที่ใช้ร่วมกันได้ตามความสัมพันธ์ของคำถาม",
}


def _identity_keys(card: dict) -> list[str]:
    """dedupe keys ของ card — candidate identity owner เดียว
    (candidate_pool._identity_key): key เดียวต่อ card (variant→v:/u:, listing
    →i:, name→n:); ไม่มี identity เลย → [] (dedupe ไม่ได้ เก็บหมด)"""
    key, _ = _identity_key(card)
    return [key] if key else []


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
) -> dict | None:
    """profile → pipeline → selection (ไม่ merge base) — รันครั้งเดียวต่อ request.

    subject_cards/compat_cards = branch evidence ที่ resolve แล้ว (owner =
    conversation_products/device_compat) · kb_fetcher = deferred KB product
    evidence fn (signature เดียวกับ fetch_fn ของ executor — run ใน executor
    เพื่อ isolate failure) · supporting = non-candidate evidence records
    (kb_qa/kb_raw/vision) เข้า pool.supporting_evidence

    Returns {"selected_cards", "extra_context", "summary"} เสมอเมื่อ pipeline
    รันสำเร็จ (selected_cards อาจว่าง — canonical owns context: ว่าง=ว่าง);
    None เฉพาะ exception — flag-ON caller fail closed (products=[])
    """
    try:
        slots = build_retrieval_slots(profile)
        relations = build_retrieval_relations(profile, slots)
        requests = build_grouped_retrieval_requests(profile, slots, relations)
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
        if kb_fetcher is not None:
            channels.append((channel_request("kb"), kb_fetcher))
        results = execute_grouped_retrieval_requests(
            requests, message=message, shop=shop, platform=platform,
            fetcher=fetcher, legacy_fetcher=legacy_fetcher,
            channels=channels)
        pool = build_candidate_pool(results, profile=profile,
                                    supporting_evidence=tuple(supporting))
        sel = select_for_llm_context(
            pool, requests + tuple(r for r, _ in channels), profile,
            per_request_limit=per_request_limit,
            unavailable_limit=unavailable_limit)
    except Exception:
        return None

    # selected cards — role tag ผ่าน _context_note (stripped แล้วจาก selector)
    # dedupe ตาม identity (card เดียวกัน eligible ใต้หลาย request → ซ้ำได้
    # — selected ตัวแรกชนะ) ไม่งั้น LLM เห็นสินค้าซ้ำ
    selected_cards: list[dict] = []
    seen: set[str] = set()
    for s in sel.selected:
        keys = _identity_keys(s.card)
        if keys and any(k in seen for k in keys):
            continue
        seen.update(keys)
        card = dict(s.card)
        note = _ROLE_NOTE.get(s.role)
        if note:
            card["_context_note"] = note
        if s.role == "subject" and not card.get("sellable", False):
            # subject ที่ไม่ขาย — ตอบ spec/compare/history ได้ แต่ห้ามบอกว่าซื้อได้
            card["_context_note"] = (
                f"{note or ''} — สินค้านี้ยังไม่พร้อมจำหน่าย "
                "(หมดสต็อก/เลิกขาย/ถูกลบ) ให้แจ้งสถานะตรงๆ "
                "ห้ามบอกว่าซื้อได้หรือส่งลิงค์ซื้อ").strip()
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
    limit: int = 30,
    per_request_limit: int = 3,
    unavailable_limit: int = 5,
    fetcher=None,
    legacy_fetcher="auto",
) -> dict | None:
    """run_grouped_selection + cap — helper แบบครบจบ (tests/probes);
    products = selected_cards เท่านั้น (canonical owns context เมื่อ pipeline
    รันได้ — ไม่ merge legacy base เด็ดขาด)"""
    out = run_grouped_selection(
        profile, message=message, shop=shop, platform=platform,
        per_request_limit=per_request_limit,
        unavailable_limit=unavailable_limit,
        fetcher=fetcher, legacy_fetcher=legacy_fetcher)
    if out is None:
        return None
    products = out["selected_cards"][:limit]
    out["summary"] = {**out["summary"], "merged_total": len(products)}
    return {"products": products, "extra_context": out["extra_context"],
            "summary": out["summary"]}
