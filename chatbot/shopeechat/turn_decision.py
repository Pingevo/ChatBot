"""Revised Phase 1 — ตัวตัดสินใจกลางต่อ 1 turn (contract owner, pure).

decide_turn() คืน TurnDecision: action เดียวต่อ turn ตามลำดับ audit-confirmed:

    1. normalize/input cleanup — ตัด system/media/item placeholders
    2. post-handoff lock      — ticket_state ยังอยู่ฝั่งแอดมิน → locked
    3. system/noise/placeholder — message เหลือว่างหลัง cleanup → noise
    4. explicit human request — ขอคุยกับคน/แอดมิน → handoff
    5. claim resume/request/product issue — claim_state+signal → claim_collect;
       claim keywords/intent → claim_request (ก่อน anger เสมอ —
       product issue ห้ามโดนบริการ-anger กลืน)
    6. service anger/frustration — handoff (parity เดิม)
    7. follow-up family        — compare/follow-up ที่ต้องใช้ history → followup
    8. product/general         — intent/keyword → answer_product/answer_general
    9. unknown/fallback        — unknown

กฎ: pure function — ไม่เรียก DB/LLM/network, ไม่ mutate input, ไม่ import
app.py. detectors ของเดิม (handoffs predicates, warranty.detect_claim_request,
message_detectors.detect_general_question, route_context.resolve_route) ใช้เป็น
predicates เท่านั้น — เจ้าของ keyword/composition ยังเป็นโมดูลเดิม.
message_detectors เป็น pure module (ไม่อ่าน .env/DB) — ห้าม import
knowledge_base ที่นี่เพราะมัน _load_env() ตอน import (purity leak เคยเกิด).

หมายเหตุขอบเขต: ไฟล์นี้เป็น decision contract — ยังไม่ถูก wire เข้า chat()
(ต้องอนุมัติแยกก่อน) จึงยังไม่เปลี่ยนคำตอบจริง.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from . import handoffs as _handoffs
from . import message_detectors as _detectors
from . import warranty as _warranty

# ── placeholder families (canonical owner — mirrors the ad-hoc lists that
#   were previously duplicated inside app.py/_post_handoff_gate) ────────────
_SYSTEM_PLACEHOLDERS = (
    "[faq_liveagent]", "[bundle_message]", "[bundle_deal]", "[bundle]",
    "[order]", "[คำสั่งซื้อ]",
)
_BARE_ITEM_PLACEHOLDERS = (
    "[item]", "[itemid]", "[สินค้า]", "[variation_card]", "[ตัวเลือกสินค้า]",
)
_MEDIA_PLACEHOLDER_RE = re.compile(
    r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", re.IGNORECASE)
_ITEM_TAG_RE = re.compile(
    r"\[(?:สินค้า|item|itemid)\s*:\s*(\d+)\]", re.IGNORECASE)

# follow-up family — signals that mean "คุยต่อจากบริบทก่อน" (needs history)
_FOLLOWUP_KWS = (
    "ต่างกัน", "เปรียบเทียบ", "เทียบ", " vs ", "ดีกว่า", "อันไหนดี",
    "ตัวไหนดี", "อันไหน", "ตัวไหน",
)

_ACTIVE_TICKET_STATES = frozenset({"handoff", "open", "pending"})


@dataclass(frozen=True)
class TurnDecision:
    """ผลตัดสินใจต่อ 1 turn — action เดียว + reason ที่ตัดสินได้ย้อนกลับ."""
    action: Literal[
        "locked", "noise", "handoff", "claim_collect", "claim_request",
        "answer_product", "answer_general", "followup", "unknown",
    ]
    reason: str
    confidence: float
    normalized_message: str
    flags: frozenset[str] = field(default_factory=frozenset)


def _normalize(message: str) -> tuple[str, set[str]]:
    """ตัด placeholders/tags ออกจากข้อความลูกค้า — คืน (text, flags)."""
    flags: set[str] = set()
    msg = message or ""
    if _ITEM_TAG_RE.search(msg):
        flags.add("has_item_tag")
    msg = _ITEM_TAG_RE.sub(" ", msg)
    if _MEDIA_PLACEHOLDER_RE.search(msg):
        flags.add("media_placeholder")
    msg = _MEDIA_PLACEHOLDER_RE.sub(" ", msg)
    for ph in _SYSTEM_PLACEHOLDERS:
        if ph in msg.lower():
            flags.add("system_placeholder")
        msg = msg.replace(ph, "").replace(ph.upper(), "")
    for ph in _BARE_ITEM_PLACEHOLDERS:
        if ph in msg.lower():
            flags.add("bare_item_placeholder")
        msg = msg.replace(ph, "").replace(ph.upper(), "")
    return re.sub(r"\s+", " ", msg).strip(), flags


def _ticket_active(ticket_state: Any) -> bool:
    """ticket_state dict {"state": ...} / str / None → อยู่ฝั่งแอดมินไหม."""
    if isinstance(ticket_state, dict):
        state = ticket_state.get("state")
    else:
        state = ticket_state
    return state in _ACTIVE_TICKET_STATES


def _has_claim_signal(msg: str) -> bool:
    """message มี claim signal ใหม่ไหม (ไม่นับ claim_state เก่า)."""
    if _warranty.detect_claim_request(msg):
        return True
    info = _warranty.extract_customer_info(msg)
    return bool(
        info.get("order_id") or info.get("phone")
        or _warranty.parse_purchase_date(msg) is not None
    )


def decide_turn(
    message: str,
    *,
    history: list[dict] | None = None,
    ticket_state: dict | str | None = None,
    claim_state: dict | None = None,
    intent_result: object | None = None,
) -> TurnDecision:
    """ตัดสิน action เดียวของ turn — pure, deterministic (ยกเว้น intent_result ที่ caller ส่งมา)."""
    intent: dict = intent_result if isinstance(intent_result, dict) else {}
    intent_name = intent.get("intent")
    intent_conf = float(intent.get("confidence") or 0)

    # 1. normalize
    norm, flags = _normalize(message)

    # 2. post-handoff lock — owner เดียว: ticket_state ชนะทุกอย่าง
    if _ticket_active(ticket_state):
        return TurnDecision("locked", "ticket active → post-handoff lock",
                            1.0, norm, frozenset(flags | {"post_handoff"}))

    # 3. system/noise/placeholder — เหลือว่างหลัง cleanup = ไม่ใช่ข้อความลูกค้า
    if not norm and flags:
        return TurnDecision("noise", "placeholder-only message", 1.0, "",
                            frozenset(flags))
    if not norm:
        return TurnDecision("unknown", "empty message", 1.0, "",
                            frozenset(flags))

    low = norm.lower()

    # 4. explicit human request (predicate เจ้าของ: handoffs)
    if _handoffs.is_human_request(norm):
        return TurnDecision("handoff", "explicit human request", 1.0, norm,
                            frozenset(flags))

    # 5. claim resume / request / product issue — ก่อน anger เสมอ
    if claim_state and _has_claim_signal(norm):
        return TurnDecision("claim_collect", "claim_state + fresh claim signal",
                            1.0, norm, frozenset(flags | {"claim_resume"}))
    if _warranty.detect_claim_request(norm) or intent_name == "warranty_claim":
        return TurnDecision("claim_request", "claim request detected", 1.0,
                            norm, frozenset(flags))

    # 6. service anger/frustration — parity เดิม (handoffs composition)
    if _handoffs.is_service_anger(norm):
        return TurnDecision("handoff", "service anger/frustration", 1.0, norm,
                            frozenset(flags | {"customer_frustration"}))

    # 7. follow-up family — ต้องมี history ให้อ้างถึง
    if history and any(kw in low for kw in _FOLLOWUP_KWS):
        return TurnDecision("followup", "follow-up phrasing + history", 0.8,
                            norm, frozenset(flags | {"needs_history"}))

    # 8. product vs general — intent ก่อน (ถ้ามี), keyword fallback
    if intent_name == "product_question" and intent_conf >= 0.7:
        return TurnDecision("answer_product", "intent=product_question",
                            intent_conf, norm, frozenset(flags))
    if intent_name == "general_question" and intent_conf >= 0.7:
        return TurnDecision("answer_general",
                            f"intent=general_question ({intent.get('general_qtype')})",
                            intent_conf, norm, frozenset(flags))
    if _detectors.detect_general_question(norm):
        return TurnDecision("answer_general", "keyword general question",
                            0.8, norm, frozenset(flags))
    # production detector reuse — types/subtype/model codes เจ้าของเดิม
    # (route_context) ไม่ copy keyword list เข้ามาใหม่
    from . import route_context as _rc
    _route = _rc.resolve_route(norm, intent)
    if ("has_item_tag" in flags or _route.product_types
            or _route.charger_subtype or _route.model_codes
            or _detectors.extract_model_keywords(norm)):
        return TurnDecision("answer_product", "product signal detected",
                            0.7, norm, frozenset(flags))

    # 9. fallback
    return TurnDecision("unknown", "no decision rule matched", 0.0, norm,
                        frozenset(flags))
