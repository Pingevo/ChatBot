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
    "subject": "สินค้าที่ลูกค้าถามถึงหรืออ้างอิงโดยตรง",
    "slot": "สินค้าที่ลูกค้าถามถึงหรืออ้างอิงโดยตรง",
    "alternative": "สินค้าแนะนำทดแทน — ไม่ใช่รุ่นที่ลูกค้าถามถึงโดยตรง "
                   "ให้บอกว่าเป็นรุ่นทดแทน",
    "relation_target": "สินค้าที่ใช้ร่วมกันได้ตามความสัมพันธ์ของคำถาม",
}


def _item_id(card: dict) -> str | None:
    """item_id canonical — float/int-float-str normalize เหมือน candidate_pool"""
    from .retrieval_policy import _norm_id
    v = card.get("item_id")
    return _norm_id(v) if v is not None else None


def _identity_keys(card: dict) -> list[str]:
    """dedupe keys ของ card — item_id → unit_id → model_id (canonical เหมือน
    candidate_pool._norm_id); ไม่มี identity เลย → [] (dedupe ไม่ได้ เก็บหมด)"""
    from .retrieval_policy import _norm_id

    def _key(prefix, v):
        # "" / whitespace / None → ไม่ใช่ identity จริง — ไม่สร้าง key
        if v is None:
            return None
        nv = _norm_id(v)
        return f"{prefix}:{nv}" if nv and nv.strip() else None

    return [k for k in (
        _key("i", card.get("item_id")),
        _key("u", card.get("unit_id")),
        _key("m", card.get("model_id")),
    ) if k]


def merge_selected_products(
    selected_cards: list[dict],
    base_products: list[dict] | None,
    limit: int,
) -> list[dict]:
    """selected มาก่อน + base ที่ไม่ซ้ำ identity — dedupe (selected ตัวแรกชนะ) + cap.

    selected ซ้ำกันเองก็ถูกคัด (card เดียวกัน eligible ใต้หลาย request →
    select_for_llm_context extend ต่อ request อาจซ้ำ) — ไม่งั้น LLM เห็นซ้ำ
    """
    merged: list[dict] = []
    seen: set[str] = set()
    for c in selected_cards or []:
        keys = _identity_keys(c)
        if keys and any(k in seen for k in keys):
            continue
        seen.update(keys)
        merged.append(c)
    for p in base_products or []:
        keys = _identity_keys(p)
        if keys and any(k in seen for k in keys):
            continue
        seen.update(keys)
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
    # ไม่มีของขายได้ ≠ ไม่มีคำตอบ — hidden_mentions (รุ่นที่ถามแต่ยังไม่ publish)
    # ยังต้องไปถึง LLM เป็น extra_context เพื่อตอบ "ยังไม่เปิดขาย" ตรงๆ
    if not sel.selected and not sel.hidden_mentions:
        return None

    # selected cards — role tag ผ่าน _context_note (stripped แล้วจาก selector)
    selected_cards: list[dict] = []
    for s in sel.selected:
        card = dict(s.card)
        note = _ROLE_NOTE.get(s.role)
        if note:
            card["_context_note"] = note
        if s.role == "subject" and not card.get("_available_for_sale"):
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
    # UNLIST-only รุ่นที่ถามถึง — name-level note (ไม่ใช่ spec/link evidence)
    hnames: list[str] = []
    for h in sel.hidden_mentions:
        n = (h.get("name") or "").strip()
        if n and n not in hnames:
            hnames.append(n)
    if hnames:
        hnote = ("หมายเหตุ: รุ่นที่ลูกค้าถามถึงบางรุ่นยังไม่เปิดขาย/ยังไม่มีจำหน่าย"
                 "ในร้านตอนนี้ (listing ยังไม่ publish): " + ", ".join(hnames)
                 + " — ให้แจ้งลูกค้าตรงๆ ห้ามส่งลิงค์หรือบอกว่าซื้อได้ "
                 "และเสนอรุ่นทดแทนชนิดเดียวกันได้")
        extra_context = f"{extra_context}\n{hnote}" if extra_context else hnote

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
