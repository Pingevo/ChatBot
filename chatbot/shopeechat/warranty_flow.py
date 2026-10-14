"""warranty_flow — ห่อ warranty state machine จาก legacy app.py ให้ chat_v2 เรียกได้.

Logic ทั้งหมดย้ายจาก `app.py` บรรทัด 1413-2351 (Warranty Claim State Machine)
มาเป็น function เดียว `handle_warranty_flow()` ที่คืน dict หรือ None

การออกแบบ:
- ไม่เขียน logic ใหม่ — ย้าย legacy logic มาเป็น helper ที่ chat_v2 เรียก
- รักษา behavior เดิมทุก state (verify ผ่าน 12 แชทใน ledger)
- คืน dict ที่ chat_v2 ใช้สร้าง ChatResponse ได้เลย
- คืน None ถ้าไม่ใช่ warranty flow → ไป pipeline หลักต่อ

States ที่จัดการ:
1. Review request — ลูกค้าขอทวนข้อมูล
2. Post-handoff lock — บอทเคย handoff แล้ว ลูกค้าทักใหม่
3. Awaiting claim info — ลูกค้าส่งรูป/วิดีโอ/ข้อมูลบางส่วน
4. Awaiting customer info — ลูกค้าให้ชื่อ/เบอร์/order
5. Awaiting confirmation — ลูกค้ายืนยันหรือแก้ข้อมูล
6. Out of warranty consult — ลูกค้าสนใจปรึกษาแอดมิน
7. Duration answered + claim request — ถามวันที่ซื้อ + handoff
8. Warranty date follow-up — คำนวณช่วงประกัน
9. Tax invoice follow-up — บอทเคยตอบใบกำกับ ลูกค้าตอบต่อ
10. First-message claim — claim request ไม่มี history
"""
from __future__ import annotations

import json
import os
import re
import sys
import time as _time
import uuid as _uuid
from dataclasses import dataclass
from typing import Any


# ─── Claim-slot helpers (fill-once) ─────────────────────────────────────────
# ใช้ร่วมกัน handle_warranty_flow (v2) + handle_warranty_flow_legacy (app.py)
def _merge_claim_slots(info: dict, *, has_date: bool = False, has_image: bool = False,
                       claim_state: dict | None = None) -> dict:
    """รวม claim slots: ข้อความปัจจุบัน ∪ claim_state ที่ persist (fill-once).

    ค่าจากข้อความปัจจุบันชนะเสมอ (ลูกค้าแก้ข้อมูลได้) — ถ้าข้อความไม่มีใช้ค่าที่เคยเก็บ
    กันบอทถามข้อมูลที่ลูกค้าให้ไปแล้วซ้ำ (root cause ของ "ถามซ้ำ").
    ⚡ 2B.5 — merge ทำ precedence เท่านั้น: name validity เป็นงานของ
    warranty.extract_customer_info (owner เดียว — 2-40 ตัว, ไม่มี digit)
    """
    cs = claim_state or {}
    return {
        "name": info.get("name") or cs.get("customer_name"),
        "phone": info.get("phone") or cs.get("customer_phone"),
        "order_id": info.get("order_id") or cs.get("customer_order_id"),
        "date": has_date or bool(cs.get("purchase_date")),
        "image": has_image or bool(cs.get("has_image") or cs.get("has_video")),
    }


# ─── Claim lifecycle owner (Phase 2B.4) ─────────────────────────────────────
# episode/stage เป็น authority เดียว — retained slots เป็น audit/reuse data
# เท่านั้น ไม่ใช่ activation signal; handoff/ticket close ไม่ใช่ claim
# resolution (ownership axis คนละแกน); valid terminal producer ตอนนี้มีเฉพาะ
# customer ยืนยันแก้สำเร็จหลัง troubleshoot + persisted terminal stage
# (admin resolved|cancelled event = Phase 2B.6)

_CLAIM_OPEN_STAGES = frozenset(("collecting", "ts_suggested"))
_CLAIM_TERMINAL_STAGES = frozenset(("resolved", "cancelled"))
# identity allowlist — copy ข้าม episode ได้ (reuse เท่านั้น); case evidence
# (customer_order_id, purchase_date, has_image, has_video) ไม่ข้าม episode
_CLAIM_IDENTITY_FIELDS = ("customer_name", "customer_phone")


@dataclass(frozen=True)
class ClaimLifecycleView:
    """snapshot ของ claim lifecycle ที่ evaluator เดียวคำนวณจาก claim_state."""
    episode_id: str | None
    stage: str  # absent | collecting | ts_suggested | resolved | cancelled
    lifecycle_open: bool
    accepts_claim_fields: bool


def _claim_lifecycle(claim_state: dict | None) -> ClaimLifecycleView:
    """evaluator เดียว — stage persist เท่านั้นที่นับ; slots ไม่มี authority."""
    cs = claim_state or {}
    stage = cs.get("stage")
    if stage not in _CLAIM_OPEN_STAGES and stage not in _CLAIM_TERMINAL_STAGES:
        stage = "absent"
    open_ = stage in _CLAIM_OPEN_STAGES
    return ClaimLifecycleView(
        episode_id=cs.get("episode_id"),
        stage=stage,
        lifecycle_open=open_,
        # collecting only — ts_suggested เป็น episode เปิด แต่ยังไม่รับข้อมูล
        # (verdict หลัง troubleshoot ผ่าน ts-followup branch เท่านั้น)
        accepts_claim_fields=stage == "collecting",
    )


def _claim_transition(req, claim_state: dict, to: str,
                      fields: dict | None = None,
                      fresh_claim: bool = False) -> dict:
    """transition owner เดียวของ claim episode — คืน authoritative claim_state.

    - open episode + to open stage → merge เข้า episode เดิม (fenced)
    - absent/terminal + fresh claim → episode ใหม่ (identity allowlist เท่านั้น
      ข้าม; case evidence ของ episode เก่าไม่ปน)
    - terminal + fresh_claim=False → refuse (คืน state เดิม) — marker/field
      stale เปิด episode terminal ไม่ได้
    - to resolved → เก็บ evidence เป็น terminal record + resolved_at
    CAS miss → reread ครั้งเดียวผ่าน storage → คืน state ของผู้ชนะ
    """
    cs = dict(claim_state or {})
    view = _claim_lifecycle(cs)
    if view.stage in _CLAIM_TERMINAL_STAGES and not fresh_claim:
        return cs
    fields = {k: v for k, v in (fields or {}).items() if v is not None and v != ""}
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    from . import conversation_products as _cp

    new_episode = view.stage == "absent" or (
        view.stage in _CLAIM_TERMINAL_STAGES and fresh_claim)
    if new_episode:
        nxt = {
            "episode_id": str(_uuid.uuid4()),
            "stage": to,
            "started_at": now,
            "updated_at": now,
        }
        for k in _CLAIM_IDENTITY_FIELDS:
            if cs.get(k):
                nxt[k] = cs[k]
        nxt.update(fields)
        return _cp.transition_claim_state(
            req.conversation_id, req.platform, req.shop,
            expected_episode_id=(view.episode_id
                                 if view.stage != "absent" else None),
            expected_stage=(view.stage
                            if view.stage != "absent" else None),
            claim_state=nxt) or cs

    if to in _CLAIM_TERMINAL_STAGES:
        # terminal = same-episode partial $set — episode_id/evidence คงอยู่;
        # whole-state replace ห้ามใช้ (concurrent evidence write จะหาย)
        term = {"stage": to, "resolved_at": now,
                "resolution_reason": "troubleshoot_confirmed"}
        term.update(fields)
        return _cp.merge_claim_fields(
            req.conversation_id, episode_id=view.episode_id,
            expected_stage=view.stage, fields=term) or cs

    merge = dict(fields)
    merge["stage"] = to
    if view.episode_id is None:
        # legacy episode-less open doc → promote ด้วย episode_id ใหม่ใน merge เดียว
        merge["episode_id"] = str(_uuid.uuid4())
    return _cp.merge_claim_fields(
        req.conversation_id, episode_id=view.episode_id,
        expected_stage=view.stage, fields=merge) or cs


def _consume_claim_outcome(req, claim_state: dict | None) -> dict:
    """apply explicit admin claim outcome (Phase 2B.6) — episode-scoped, idempotent.

    req.claim_outcome = {episode_id, outcome: resolved|cancelled, actor_id,
    occurred_at (ISO)} — transport จาก status_conversation ผ่าน /chat payload.
    apply เฉพาะเมื่อ episode ตรงกับ active episode + lifecycle เปิดอยู่ —
    ผ่าน _claim_transition เดียว (fencing เดิมครอบ race/replay/terminal);
    malformed/stale/absent → no-op, คืน state เดิม.
    """
    oc = getattr(req, "claim_outcome", None)
    if not isinstance(oc, dict):
        return claim_state or {}
    outcome = oc.get("outcome")
    episode = oc.get("episode_id")
    if (outcome not in _CLAIM_TERMINAL_STAGES
            or not isinstance(episode, str) or not episode):
        return claim_state or {}
    cs = dict(claim_state or {})
    view = _claim_lifecycle(cs)
    if not view.lifecycle_open or view.episode_id != episode:
        return cs
    from datetime import datetime, timezone
    occurred = oc.get("occurred_at")
    resolved_at = None
    if isinstance(occurred, str):
        try:
            resolved_at = datetime.fromisoformat(
                occurred.replace("Z", "+00:00")).isoformat()
        except ValueError:
            resolved_at = None
    fields = {
        "resolution_reason": f"admin_{outcome}",
        "resolved_by": oc.get("actor_id"),
        "resolved_at": resolved_at or datetime.now(timezone.utc).isoformat(),
    }
    return _claim_transition(req, cs, outcome, fields=fields)


# ─── Post-handoff lock helpers (5F-H4) ───────────────────────────────────────
# ticket_state เป็น source of truth — ไม่พึ่ง history marker อย่างเดียว
# (history fetch fail/marker missing ตอน ticket ยังเปิด = bot ตอบเองผิดจังหวะ)
_POST_HANDOFF_PRODUCT_KWS = (
    "สายชาร์จ", "หัวชาร์จ", "ชุดชาร์จ", "แท่นชาร์จ", "พาวเวอร์แบงค์", "แบตสำรอง",
    "แบตเตอรี่", "สาย usb", "สาย c", "สาย type", "หาสาย", "หาหัว", "หาแบต",
    "มีสาย", "มีหัว", "มีแบต", "มีพาวเวอร์", "มีสินค้า", "ดูสินค้า", "แนะนำ",
    "สอบถามสินค้า", "รุ่นไหนดี", "ราคา", "กี่บาท", "ชาร์จเร็ว", "watt", "วัตต์",
    "สายแรง", "หัวแรง", "แบตแรง", "ชาร์จแรง", "pd 3.1", "gan", "wireless",
    "สวัสดี", "hello", "hi ", "ขอดูสินค้า", "ขอสอบถาม",
)
_POST_HANDOFF_WARRANTY_KWS = (
    "เคลม", "ประกัน", "ทวนข้อมูล", "ส่งสินค้า", "พัสดุ", "tracking", "EMS",
    "เบอร์", "เลขคำสั่ง", "วันที่ซื้อ", "รูปสินค้า", "แสดงอาการ", "ความเสียหาย",
    "เปลี่ยนสินค้า", "คืนสินค้า", "refund", "return", "เคลมสาย", "เคลมหัว",
    "ใช้ไม่ได้", "ไม่ทำงาน", "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด",
    "เสีย", "พัง", "ซ่อม", "ไม่ติด", "ค้าง",
)


def _is_active_post_handoff(req, history: list | None = None) -> bool:
    """ticket_state = source of truth เดียวของ post-handoff lock.

    - "handoff"/"open"/"pending" → active — ล็อคทุกข้อความ (content
      ไม่มีสิทธิ์ override ownership — Phase 2B.5 unconditional)
    - "closed"/"resolved"/"bot" → ไม่ active → pipeline ปกติ
    - ไม่ทราบ state (None/อื่น) → fallback handoff marker ใน last model
      text (backward compat — กรณี admin ไม่ส่ง ticket_state)
    """
    _ts = getattr(req, "ticket_state", None)
    _state = (_ts.get("state") if isinstance(_ts, dict) else _ts) or ""
    _state = str(_state).lower()
    if _state in ("handoff", "open", "pending"):
        return True
    if _state in ("closed", "resolved", "bot"):
        return False
    _last_model = ""
    for _h in reversed(list(history or [])):
        _role = ((_h.get("role") if isinstance(_h, dict)
                  else getattr(_h, "role", "")) or "")
        if _role != "model":
            continue
        _last_model = ((_h.get("text") if isinstance(_h, dict)
                        else getattr(_h, "text", "")) or "")
        break
    return any(m in _last_model for m in (
        "มอบหมายงาน", "รอการติดต่อกลับ", "ดำเนินการเรื่อง", "แอดมินดูแล"))


def handle_warranty_flow(req, ctx: dict, history: list[dict], db) -> dict | None:
    """Warranty state machine — ย้ายจาก legacy app.py บรรทัด 1413-2351.

    Args:
        req: ChatRequest (มี message, conversation_id, shop, platform, ticket_state, simulate_assignment)
        ctx: context dict จาก chat_v2 (ใช้ bot_name, vision_context, image_desc_out, steps, total_start)
        history: list[dict] ของ history messages
        db: MongoDB database handle

    Returns:
        dict ที่มี answer + metadata สำหรับ ChatResponse ถ้าจับ warranty flow ได้
        None ถ้าไม่ใช่ warranty flow → ไป pipeline หลัก
    """
    from . import warranty as _warranty_mod
    from . import llm
    from . import product_store
    from . import app as _app_module

    _bot_name = ctx.get("bot_name", "เรา")
    _image_desc_out = ctx.get("image_desc_out", "")
    _steps = ctx.get("steps", [])
    _total_start = ctx.get("total_start", _time.time())

    # ⚡ T5 — โหลด claim state ที่ persist ข้าม turn (fill-once — กันขอข้อมูลซ้ำ)
    _claim_state: dict = {}
    if req.conversation_id:
        try:
            from . import conversation_products as _cp_claim
            _claim_state = _cp_claim.load_claim_state(req.conversation_id) or {}
        except Exception:
            pass
    # ⚡ 2B.6 — explicit admin outcome ก่อน lifecycle evaluate (authoritative turn)
    _claim_state = _consume_claim_outcome(req, _claim_state)
    # ⚡ 2B.4 — lifecycle view จาก evaluator เดียว: marker/field evidence ใช้ได้
    #   เฉพาะตอนไม่ terminal (terminal ต้อง explicit fresh claim เท่านั้น)
    _view = _claim_lifecycle(_claim_state)
    _accept_evidence = _view.lifecycle_open or _view.stage == "absent"

    # ── Pre-check: claim request detection ──
    _is_claim_request = _warranty_mod.detect_claim_request(req.message)

    # ── State machine ทำงานเฉพาะเมื่อมี history หรือ episode เปิดอยู่ ──
    #   (persisted state เป็น authority — history fetch ว่างไม่ตัด resume)
    if not history and not _view.lifecycle_open:
        # First-message claim (no history, no open episode) → handle ที่ท้ายฟังก์ชัน
        return _handle_first_message_claim(req, ctx, _is_claim_request, _warranty_mod, llm, _app_module, _claim_state)

    # ⚡ 2B.4 — explicit claim request ตอนไม่มี open episode → fresh-claim path
    #   เดียวกันเสมอ (absent/terminal → episode ใหม่ผ่าน transition owner;
    #   marker เก่าบน terminal episode ห้าม reopen)
    if _is_claim_request and not _view.lifecycle_open:
        return _handle_first_message_claim(req, ctx, True, _warranty_mod, llm, _app_module, _claim_state)

    # ── ดึง last model message ──
    _last_model_msgs = [h for h in history if h.get("role") == "model"][-1:]
    _last_model_text = " ".join(h.get("text", "") for h in _last_model_msgs).lower()

    # ⚡ Guard: ถ้า last model message ไม่เกี่ยวกับ warranty เลย → ข้าม state machine
    _last_model_is_warranty = any(
        kw in _last_model_text
        for kw in ("รับประกัน", "ประกัน", "เคลม", "warranty", "claim",
                   "วันที่ซื้อ", "เลขที่คำสั่งซื้อ", "ชื่อ-นามสกุล", "เบอร์โทร",
                   "รูปหรือวิดีโอ", "แสดงอาการ", "ความเสียหาย", "มอบหมายงาน",
                   "รอการติดต่อกลับ", "ส่งต่อให้แอดมิน", "แอดมินดูแล",
                   "นอกช่วงประกัน", "หมดช่วงประกัน")
    )

    # ── State: Review request — ลูกค้าขอทวนข้อมูล ──
    _review_request_kws = (
        "ทวนข้อมูล", "ทวน ข้อมูล", "ข้อมูลที่ให้ไป", "ข้อมูลที่ผมให้",
        "ยืนยันข้อมูล", "ยืนยัน ข้อมูล", "ข้อมูลที่ส่งไป", "ข้อมูลที่แจ้งไป",
        "สรุปข้อมูล", "สรุป ข้อมูล", "ข้อมูลเคลม",
    )
    _is_review_request = any(kw in req.message for kw in _review_request_kws)
    if _is_review_request and _last_model_is_warranty:
        return _handle_review_request(req, ctx, history, _warranty_mod, llm, _app_module)

    # ── ตรวจ states จาก history ──
    _bot_answered_duration = (
        any(kw in _last_model_text for kw in ("รับประกัน", "ประกัน", "เคลม", "warranty"))
        and any(kw in _last_model_text for kw in ("ปี", "เดือน", "year", "month"))
    )
    _bot_asked_date = any(
        kw in _last_model_text
        for kw in ("วันที่ซื้อ", "ซื้อวันที่", "วันที่ ซื้อ", "purchase date", "ซื้อมาวันที่")
    )
    _info_request_kws = (
        "ชื่อ-นามสกุล", "ชื่อ นามสกุล", "ชื่อและนามสกุล",
        "เบอร์โทร", "เบอร์ติดต่อ", "หมายเลขโทร",
        "เลขที่คำสั่งซื้อ", "หมายเลขคำสั่งซื้อ", "order number",
        "phone number", "เบอร์มือถือ",
    )
    _ask_verbs = (
        "กรุณาแจ้ง", "รบกวนแจ้ง", "รบกวนขอ", "กรุณาส่ง", "รบกวนส่ง",
        "แจ้งชื่อ", "แจ้งเบอร์", "แจ้งเลข", "ส่งชื่อ", "ส่งเบอร์",
        "ขอชื่อ", "ขอเบอร์", "ขอเลข", "ขอข้อมูล",
        "please provide", "please send",
    )
    _bot_asked_info = (
        any(kw in _last_model_text for kw in _info_request_kws)
        and any(verb in _last_model_text for verb in _ask_verbs)
    )
    if not _bot_asked_info and _accept_evidence and (_last_model_is_warranty or _view.accepts_claim_fields):
        _all_model_text = " ".join(
            h.get("text", "") for h in history if h.get("role") == "model"
        ).lower()
        _bot_asked_info_ever = (
            (any(kw in _all_model_text for kw in _info_request_kws)
             and any(verb in _all_model_text for verb in _ask_verbs))
            or _view.accepts_claim_fields
        )
        if _bot_asked_info_ever:
            _pre_info = _warranty_mod.extract_customer_info(req.message)
            # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
            _pre_valid_name = bool(_pre_info["name"])
            _pre_has_info = (
                bool(_pre_info["order_id"]) or _pre_valid_name or bool(_pre_info["phone"])
            )
            if _pre_has_info:
                _bot_asked_info = True

    _bot_reviewed_info = any(
        kw in _last_model_text
        for kw in ("ทวน", "ถูกต้องไหม", "ข้อมูลถูกต้อง", "confirm", "ขอให้ยืนยัน", "กรุณายืนยัน")
    )
    _bot_said_out_of_warranty = (
        any(kw in _last_model_text for kw in ("ไม่อยู่ในช่วงประกัน", "หมดช่วงประกัน", "หมดประกัน", "out of warranty"))
        and any(kw in _last_model_text for kw in ("สนใจ", "ปรึกษา", "แอดมิน", "admin"))
    )

    # ── State 7: awaiting claim info ──
    _bot_asked_claim_info = (
        any(kw in _last_model_text for kw in ("วันที่ซื้อ", "ซื้อวันที่", "วันที่ ซื้อ", "purchase date", "ซื้อมาวันที่"))
        and any(kw in _last_model_text for kw in ("เลขที่คำสั่งซื้อ", "หมายเลขคำสั่งซื้อ", "order number", "คำสั่งซื้อ"))
        and any(kw in _last_model_text for kw in ("รูป", "วิดีโอ", "photo", "video", "แสดงอาการ", "ความเสียหาย"))
    )
    _msg_is_image = req.message.strip() in ("[รูปภาพ]", "[image]", "[วิดีโอ]", "[video]", "[sticker]", "[สติกเกอร์]")
    _msg_has_image_placeholder = bool(re.search(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", req.message, re.IGNORECASE))
    _msg_has_date = _warranty_mod.parse_purchase_date(req.message) is not None

    # ── product-question signal — ใช้เฉพาะกัน warranty-ctx ตอนส่งรูป ──
    _msg_lower = req.message.lower()
    _is_product_q = (
        any(kw in _msg_lower for kw in _POST_HANDOFF_PRODUCT_KWS)
        and not any(kw in _msg_lower for kw in _POST_HANDOFF_WARRANTY_KWS))

    # ── State 7: awaiting_claim_info → ลูกค้าส่งรูป/วิดีโอ ──
    _warranty_ctx_in_history = False
    if history and (_msg_is_image or _msg_has_image_placeholder):
        _warranty_ctx_kws = (
            "เคลม", "ประกัน", "ซ่อม", "เสีย", "พัง", "ใช้ไม่ได้", "ไม่ทำงาน",
            "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด", "รับประกัน", "warranty",
            "แอดมินดูแล", "รอการติดต่อกลับ", "ตรวจสอบ", "ส่งเคลม",
        )
        _recent_history = history[-3:] if len(history) > 3 else history
        for _h in _recent_history:
            _ht = ((_h.get("text") if isinstance(_h, dict) else _h.text) or "").lower()
            if any(kw in _ht for kw in _warranty_ctx_kws):
                _warranty_ctx_in_history = True
                break
        _current_msg_lower = req.message.lower()
        _current_has_warranty_kw = any(kw in _current_msg_lower for kw in _warranty_ctx_kws)
        if _warranty_ctx_in_history and not _current_has_warranty_kw and (_msg_is_image or _msg_has_image_placeholder):
            _msg_without_placeholder = re.sub(
                r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]",
                "", req.message, flags=re.IGNORECASE
            ).strip()
            if not _msg_without_placeholder:
                _warranty_ctx_in_history = False
        if _warranty_ctx_in_history and _is_product_q:
            _warranty_ctx_in_history = False

    _warranty_claim_handoff = False
    _warranty_claim_ctx: dict = {}
    _warranty_claim_answer = ""

    # ⚡ T5 — collecting episode (accepts_claim_fields) เพิ่มเป็นเงื่อนไขที่ 3:
    #   info submission หลังคำถามแทรกยังถูกรับเข้า flow เพราะ claim_state persist;
    #   marker ใช้ได้เฉพาะตอนไม่ terminal (_accept_evidence) — terminal ต้อง
    #   explicit fresh claim; ts_suggested ยังไม่รับ field (verdict ผ่าน ts-followup)
    if (_view.accepts_claim_fields or (_accept_evidence and (_bot_asked_claim_info or _warranty_ctx_in_history))) and not _bot_reviewed_info:
        _claim_clean_msg = re.sub(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", "", req.message, flags=re.IGNORECASE).strip()
        _parsed_date_str = None
        if _msg_has_date:
            _parsed_date_val = _warranty_mod.parse_purchase_date(req.message)
            if _parsed_date_val is not None:
                _parsed_date_str = _parsed_date_val.strftime("%Y-%m-%d") if hasattr(_parsed_date_val, "strftime") else str(_parsed_date_val)
                _claim_clean_msg = _claim_clean_msg.replace(_parsed_date_str, "")
            _claim_clean_msg = re.sub(r"(?:ซื้อวันที่|วันที่ซื้อ|วันที่ ซื้อ|ซื้อมาวันที่)\s*\d{1,2}\s*[A-Za-zก-ฮ\.]+\s*\d{2,4}", "", _claim_clean_msg, flags=re.IGNORECASE)
            _claim_clean_msg = re.sub(r"(?:ซื้อวันที่|วันที่ซื้อ|วันที่ ซื้อ|ซื้อมาวันที่)", "", _claim_clean_msg, flags=re.IGNORECASE)
        _info = _warranty_mod.extract_customer_info(_claim_clean_msg)
        _has_date = _msg_has_date
        _has_order = bool(_info["order_id"])
        # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
        _has_name = bool(_info["name"])
        _has_phone = bool(_info["phone"])
        _has_image = _msg_is_image or _msg_has_image_placeholder

        if _has_image or _has_date or _has_order or _has_name or _has_phone:
            _received_items = []
            if _has_image:
                _received_items.append("รูป/วิดีโอแสดงอาการ")
            if _has_date:
                _received_items.append("วันที่ซื้อสินค้า")
            if _has_order:
                _received_items.append("เลขที่คำสั่งซื้อ")
            if _has_name:
                _received_items.append("ชื่อ-นามสกุล")
            if _has_phone:
                _received_items.append("เบอร์โทร")
            _received_text = " · ".join(_received_items)
            _warranty_claim_answer = (
                f"ขอบคุณค่ะ ได้รับข้อมูล({_received_text}) เรียบร้อยแล้ว "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ "
                f"ทางเราจะดำเนินการโดยเร็วที่สุดค่ะ"
            )
            _warranty_claim_handoff = True
            # ⚡ T5 — merge กับ claim_state: handoff claim ได้ข้อมูลครบ (ไม่ใช่แค่ turn นี้)
            _slots = _merge_claim_slots(
                _info, has_date=_has_date, has_image=_has_image,
                claim_state=_claim_state,
            )
            _warranty_claim_ctx = {
                "customer_name": _slots["name"],
                "customer_phone": _slots["phone"],
                "customer_order_id": _slots["order_id"],
                "purchase_date": _parsed_date_str or _claim_state.get("purchase_date"),
                "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
            }
            # ⚡ T5 — persist ข้อมูลที่ได้รับ (fill-once) ผ่าน transition owner เดียว
            _claim_state = _claim_transition(req, _claim_state, "collecting", {
                "customer_name": _info.get("name") if _has_name else None,
                "customer_phone": _info.get("phone") if _has_phone else None,
                "customer_order_id": _info.get("order_id") if _has_order else None,
                "purchase_date": _parsed_date_str,
                "has_image": True if _has_image else None,
            })

    # ── State: awaiting_customer_info → ลูกค้าให้ข้อมูล ──
    if _bot_asked_info and not _bot_reviewed_info and not _msg_has_date and _accept_evidence:
        _info = _warranty_mod.extract_customer_info(req.message)
        # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
        _has_valid_name = bool(_info["name"])
        _has_valid_phone = bool(_info["phone"])
        _has_valid_order = bool(_info["order_id"])
        if _has_valid_name or _has_valid_phone or _has_valid_order:
            # ⚡ T5 — fill-once: รวม claim_state ที่ persist → ไม่ถาม slot ที่มีแล้วซ้ำ
            _slots = _merge_claim_slots(_info, claim_state=_claim_state)
            _review_lines = []
            _missing_lines = []
            if _slots["name"]:
                _review_lines.append(f"• ชื่อ-นามสกุล: {_slots['name']}")
            else:
                _missing_lines.append("• ชื่อ-นามสกุล")
            if _slots["phone"]:
                _review_lines.append(f"• เบอร์โทร: {_slots['phone']}")
            else:
                _missing_lines.append("• เบอร์โทร")
            if _slots["order_id"]:
                _review_lines.append(f"• เลขที่คำสั่งซื้อ: {_slots['order_id']}")
            else:
                _missing_lines.append("• เลขที่คำสั่งซื้อ")
            _review_text = "\n".join(_review_lines)
            if _missing_lines:
                _missing_text = "\n".join(_missing_lines)
                _warranty_claim_answer = (
                    f"รับทราบค่ะ ข้อมูลที่ลูกค้าให้มา:\n"
                    f"{_review_text}\n\n"
                    f"รบกวนแจ้งข้อมูลที่เหลือเพิ่มเติมด้วยนะคะ:\n"
                    f"{_missing_text}\n\n"
                    f"และหากมีรูปหรือวิดีโอแสดงอาการ ส่งมาได้เลยค่ะ"
                )
            else:
                _warranty_claim_answer = (
                    f"รบกวนทวนข้อมูลนะคะ ข้อมูลที่ลูกค้าให้มา:\n"
                    f"{_review_text}\n\n"
                    f"ข้อมูลถูกต้องไหมคะ ถ้าถูกต้องเดี๋ยวจะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
                )
            _warranty_claim_ctx = {
                "customer_name": _slots["name"],
                "customer_phone": _slots["phone"],
                "customer_order_id": _slots["order_id"],
                "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
            }
            # ⚡ T5 — persist slot ที่เพิ่งได้รับ (v2 เดิมไม่ save เลย)
            _claim_state = _claim_transition(req, _claim_state, "collecting", {
                "customer_name": _info.get("name") if _has_valid_name else None,
                "customer_phone": _info.get("phone") if _has_valid_phone else None,
                "customer_order_id": _info.get("order_id") if _has_valid_order else None,
            })

    # ── State: awaiting_confirmation → ลูกค้ายืนยันหรือแก้ข้อมูล ──
    elif _bot_reviewed_info:
        if _warranty_mod.detect_confirmation(req.message):
            _warranty_claim_answer = (
                f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมินดำเนินการต่อนะคะ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
            _warranty_claim_handoff = True
            _warranty_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty"}
        else:
            _info = _warranty_mod.extract_customer_info(req.message)
            # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
            _has_valid_name = bool(_info["name"])
            _has_valid_phone = bool(_info["phone"])
            _has_valid_order = bool(_info["order_id"])
            if (_has_valid_name or _has_valid_phone or _has_valid_order) and _accept_evidence:
                # ⚡ T5 — merge claim_state: ลูกค้าแก้แค่บาง field → ค่าอื่นต้องยังอยู่
                _slots = _merge_claim_slots(_info, claim_state=_claim_state)
                _review_lines = []
                if _slots["name"]:
                    _review_lines.append(f"• ชื่อ-นามสกุล: {_slots['name']}")
                if _slots["phone"]:
                    _review_lines.append(f"• เบอร์โทร: {_slots['phone']}")
                if _slots["order_id"]:
                    _review_lines.append(f"• เลขที่คำสั่งซื้อ: {_slots['order_id']}")
                _review_text = "\n".join(_review_lines)
                _warranty_claim_answer = (
                    f"รับทราบค่ะ ขออนุญาตทวนข้อมูลใหม่นะคะ:\n"
                    f"{_review_text}\n\n"
                    f"ข้อมูลถูกต้องไหมคะ ถ้าถูกต้องเดี๋ยวจะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
                )
                _warranty_claim_ctx = {
                    "customer_name": _slots["name"],
                    "customer_phone": _slots["phone"],
                    "customer_order_id": _slots["order_id"],
                    "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
                }
                _claim_state = _claim_transition(req, _claim_state, "collecting", {
                    "customer_name": _info.get("name") if _has_valid_name else None,
                    "customer_phone": _info.get("phone") if _has_valid_phone else None,
                    "customer_order_id": _info.get("order_id") if _has_valid_order else None,
                })
            else:
                _warranty_claim_answer = (
                    f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมินดำเนินการต่อนะคะ "
                    f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                )
                _warranty_claim_handoff = True
                _warranty_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty"}

    # ── State: out_of_warranty_consult ──
    elif _bot_said_out_of_warranty:
        if _warranty_mod.detect_consent(req.message):
            _warranty_claim_answer = (
                f"ได้ค่ะ เดี๋ยวจะขออนุญาตส่งต่อแชทนี้ให้แอดมินนะคะ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
            _warranty_claim_handoff = True
            _warranty_claim_ctx = {"handoff_reason": "warranty_claim_out_of_warranty"}

    # ── State: duration_answered + claim request ──
    elif _bot_answered_duration and not _msg_has_date:
        if _warranty_mod.detect_claim_request(req.message):
            _warranty_claim_answer = (
                f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
                f"• วันที่ซื้อสินค้า\n"
                f"• เลขที่คำสั่งซื้อ\n"
                f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
                f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
                f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
                f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ {_bot_name} จะตรวจสอบและประสานงานต่อให้ค่ะ"
            )
            _warranty_claim_handoff = True
            _warranty_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty"}
            # ⚡ 2B.4 — explicit claim request → fresh path ผ่าน owner (episode
            #   ใหม่เมื่อ absent/terminal; open → episode เดิม)
            _claim_state = _claim_transition(req, _claim_state, "collecting", fresh_claim=True)

    # ── ถ้ามี warranty claim answer → ส่ง handoff + return ──
    if _warranty_claim_answer:
        return _build_warranty_claim_response(
            req, ctx, _warranty_claim_answer, _warranty_claim_handoff,
            _warranty_claim_ctx, _app_module, llm, claim_state=_claim_state
        )

    # ── Warranty date follow-up ──
    _purchase_date = _warranty_mod.parse_purchase_date(req.message)
    if _purchase_date:
        _last_model_msgs = [h for h in history if h.get("role") == "model"][-2:]
        _last_text = " ".join(h.get("text", "") for h in _last_model_msgs)
        _asked_purchase_date = any(
            kw in _last_text
            for kw in ("วันที่ซื้อ", "ซื้อวันที่", "วันที่ ซื้อ", "purchase date", "ซื้อมาวันที่")
        )
        if _asked_purchase_date:
            _date_resp = _handle_warranty_date_followup(
                req, ctx, history, _purchase_date, db, _warranty_mod, product_store, _app_module
            )
            if _date_resp:
                return _date_resp

    # ── Tax invoice follow-up ──
    _tax_resp = _handle_tax_invoice_followup(req, ctx, history, _warranty_mod, _app_module, llm)
    if _tax_resp:
        return _tax_resp

    # ── First-message claim (มี history แต่ state machine ไม่ได้จับ) ──
    if _is_claim_request:
        return _handle_first_message_claim(req, ctx, True, _warranty_mod, llm, _app_module, _claim_state)

    return None


# ── Helper functions ─────────────────────────────────────────────────────────

def _handle_review_request(req, ctx, history, _warranty_mod, llm, _app_module) -> dict:
    """State: ลูกค้าขอทวนข้อมูลที่ให้ไป."""
    _bot_name = ctx.get("bot_name", "เรา")
    _hist_name = None
    _hist_phone = None
    _hist_order = None
    _hist_has_image = False
    for h in history:
        if h.get("role") != "user":
            continue
        if h.get("images") or h.get("image_desc"):
            _hist_has_image = True
        _htext = (h.get("text") or "").strip()
        if not _htext:
            continue
        _htext_clean = re.sub(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", "", _htext, flags=re.IGNORECASE).strip()
        if not _htext_clean:
            continue
        _hinfo = _warranty_mod.extract_customer_info(_htext_clean)
        if _hinfo["phone"] and not _hist_phone:
            _hist_phone = _hinfo["phone"]
        if _hinfo["order_id"] and not _hist_order:
            _hist_order = _hinfo["order_id"]
        if _hinfo["name"] and not _hist_name:
            _hname = _hinfo["name"]
            # ⚡ 2B.5 — shape/length/digit เป็นหน้าที่ parser (extract_customer_info)
            #   ตรงนี้เหลือเฉพาะ contextual denylist กันข้อความเก่าที่ถูกตีความ
            #   เป็นชื่อผิดบริบท (เช่น "ทวนเลขพัสดุ" → NER ยอมเป็นชื่อ)
            if not any(kw in _hname.lower() for kw in (
                    "ทวน", "ทน", "คอย", "รูป", "ภาพ", "เคลม", "ส่ง", "พัสดุ",
                    "สินค้า", "ไม่ทราบ", "ได้รับ", "หรือยัง",
            )):
                _hist_name = _hname
    _review_lines = []
    if _hist_name:
        _review_lines.append(f"• ชื่อ-นามสกุล: {_hist_name}")
    if _hist_phone:
        _review_lines.append(f"• เบอร์โทร: {_hist_phone}")
    if _hist_order:
        _review_lines.append(f"• เลขที่คำสั่งซื้อ: {_hist_order}")
    if _hist_has_image:
        _review_lines.append("• รูป/วิดีโอแสดงอาการ: ส่งมาแล้ว")
    if _review_lines:
        _review_text = "\n".join(_review_lines)
        _answer = (
            f"รับทราบค่ะ ทวนข้อมูลที่ลูกค้าให้ไปนะคะ:\n"
            f"{_review_text}\n\n"
            f"ข้อมูลถูกต้องไหมคะ ถ้าถูกต้องเดี๋ยวส่งต่อให้แอดมินดำเนินการต่อนะคะ "
            f"ถ้าต้องการแก้ไขหรือเพิ่มเติม แจ้ง {_bot_name} ได้เลยค่ะ"
        )
    else:
        _answer = (
            f"ขออภัยค่ะ {_bot_name} ไม่พบข้อมูลที่ลูกค้าให้ไปในประวัติแชท "
            f"รบกวนแจ้งข้อมูลใหม่อีกครั้งนะคะ: วันที่ซื้อ · เลขที่คำสั่งซื้อ · "
            f"เบอร์โทร · รูป/วิดีโอแสดงอาการ"
        )
    _model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _total = round(_time.time() - ctx.get("total_start", _time.time()), 2)
    return {
        "answer": _answer,
        "answer_segments": llm.split_segments(_answer),
        "products": [],
        "shop": req.shop,
        "model": _model_name,
        "source": "warranty_claim_flow",
        "usage": {},
        "elapsed": _total,
        "cost": 0.0,
        "handoff_to_admin": False,
        "handoff_reason": None,
        "handoff_claim": {
            "customer_name": _hist_name,
            "customer_phone": _hist_phone,
            "customer_order_id": _hist_order,
        },
        "steps": ctx.get("steps", []) + [{"name": "warranty_review", "model": _model_name, "detail": "ทวนข้อมูลจาก history"}],
        "routing_decision": _app_module._routing(
            "bot_reply", "warranty_review: ทวนข้อมูลจาก history",
        ),
        "image_desc": ctx.get("image_desc_out", ""),
    }


def _build_post_handoff_response(req, ctx, _app_module, llm) -> dict:
    """State: post-handoff lock — ลูกค้าทักใหม่ หลัง handoff."""
    _answer = (
        "ระบบได้บันทึกข้อมูลของคุณและส่งต่อให้แอดมินดูแลเรียบร้อยแล้วค่ะ "
        "รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ "
        "ทางเราจะดำเนินการโดยเร็วที่สุดค่ะ"
    )
    _model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _total = round(_time.time() - ctx.get("total_start", _time.time()), 2)
    return {
        "answer": _answer,
        "answer_segments": llm.split_segments(_answer),
        "products": [],
        "shop": req.shop,
        "model": _model_name,
        "source": "warranty_claim_flow",
        "usage": {},
        "elapsed": _total,
        "cost": 0.0,
        # ⚡ 2B.5 — wait-only state, NOT a new-handoff command: downstream
        #   callers (liveAssignmentService/replay) treat handoff_to_admin /
        #   handoff_reason / routing path "handoff" as "perform a handoff"
        #   — ต้องปล่อยทุก field ว่าง มิฉะนั้น caller POST ซ้ำ
        "handoff_to_admin": False,
        "handoff_reason": None,
        "handoff_claim": {},
        "steps": ctx.get("steps", []) + [{"name": "post_handoff", "model": _model_name, "detail": "post_handoff_waiting: รอแอดมิน → ลูกค้าทักใหม่"}],
        "routing_decision": _app_module._routing(
            "human_wait", "post_handoff_waiting: รอแอดมิน → บอทหยุดตอบ",
        ),
        "image_desc": ctx.get("image_desc_out", ""),
    }


def _build_warranty_claim_response(req, ctx, answer, handoff, claim_ctx,
                                     _app_module, llm, source="warranty_claim_flow",
                                     claim_state: dict | None = None) -> dict:
    """สร้าง response สำหรับ warranty claim พร้อม handoff API call.

    claim_state = authoritative claim lifecycle state ของ caller (เป้าหมาย:
    open episode ⟹ episode_id ส่งผ่าน transport explicitly — `_send_handoff`
    ไม่อ่าน Mongo เอง). lifecycle open แต่ไม่มี episode_id หรือ claim_state
    ไม่ทราบ → handoff ถือไม่สมบูรณ์: ไม่ POST + flag False (ห้าม false success)
    """
    _model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _total = round(_time.time() - ctx.get("total_start", _time.time()), 2)
    _handoff_result: dict = {}
    _assigned_admin_name: str | None = None
    _assignment_reason: str | None = None
    if handoff and req.conversation_id:
        # claim episode identity มาจาก evaluator เดียวบน authoritative state —
        # open ⟹ episode_id ต้องมี; ขาด = transport identity failure (fail closed)
        _ep_view = _claim_lifecycle(claim_state) if claim_state is not None else None
        _episode_id = (_ep_view.episode_id
                       if _ep_view is not None and _ep_view.lifecycle_open
                       else None)
        if _ep_view is not None and (not _ep_view.lifecycle_open or _episode_id):
            # transport owner เดียว — outcome ยืนยันเท่านั้นถึง claim/flag/clear
            _handoff_result = _app_module._send_handoff(
                req, None,
                reason=claim_ctx.get("handoff_reason", "warranty_claim"),
                claim={k: v for k, v in claim_ctx.items() if k != "handoff_reason" and v},
                simulate=True, timeout=5.0, log_tag="HANDOFF-V2",
                episode_id=_episode_id,
            ) or {}
        else:
            print("[WARRANTY-CLAIM] handoff blocked: claim episode identity "
                  "unavailable (lifecycle open แต่ไม่มี episode_id)", file=sys.stderr)
        _assigned_admin_name = _handoff_result.get("assigned_to_name")
        _assignment_reason = _handoff_result.get("assignment_reason")

        # ⚡ 2B.4 — handoff สำเร็จเปลี่ยน conversation ownership ไม่ใช่ claim
        #   resolution: claim_state คงอยู่ (lifecycle แยกจาก ticket; resolved/
        #   cancelled มาจาก valid terminal evidence เท่านั้น)

        if _assigned_admin_name:
            _reason_thai = {
                "warranty_claim_in_warranty": "อยู่ในช่วงรับประกัน",
                "warranty_claim_out_of_warranty": "หมดช่วงรับประกัน",
                "warranty_claim": "เรื่องรับประกัน/เคลม",
            }.get(claim_ctx.get("handoff_reason", ""), "เรื่องที่ต้องดำเนินการต่อ")
            _assign_thai = {
                "previous_reply_admin: ส่งคืน admin เดิมที่เคยตอบ": "แอดมินที่เคยดูแลคุณ",
                "round_robin: ไม่มี admin เดิม → จ่ายคิว": "แอดมินคนถัดไป",
                "existing_assignment: มี admin ดูแลอยู่แล้ว": "แอดมินที่ดูแลอยู่",
            }.get(_assignment_reason or "", "แอดมิน")
            answer += (
                f"\n\n📌 ขณะนี้ได้มอบหมายงานให้ {_assigned_admin_name} ({_assign_thai}) "
                f"ดำเนินการเรื่อง{_reason_thai}ต่อนะคะ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
        elif not _handoff_result:
            # outcome ไม่ยืนยัน — base answer อาจ claim admin-contact → แทนด้วยข้อความตรงๆ
            #   (queued ยืนยันแล้วแต่ไม่มีชื่อ → เก็บ base answer — claim รอแอดมินจริง)
            from . import responses as _resp_mod
            answer = _resp_mod.HANDOFF_FAILED_REPLY

    return {
        "answer": answer,
        "answer_segments": llm.split_segments(answer),
        "products": [],
        "shop": req.shop,
        "model": _model_name,
        "source": source,
        "usage": {},
        "elapsed": _total,
        "cost": 0.0,
        "intent": ctx.get("intent_result") or {},
        "timing": ctx.get("timing_breakdown") or {},
        # flag = authoritative outcome เท่านั้น (request handoff แต่ transport fail → False)
        "handoff_to_admin": bool(handoff and _handoff_result),
        "handoff_reason": claim_ctx.get("handoff_reason") if handoff and _handoff_result else None,
        "handoff_claim": claim_ctx,
        "steps": ctx.get("steps", []),
        "routing_decision": _app_module._routing(
            "handoff" if (handoff and _handoff_result) else "bot_reply",
            f"warranty_claim: {claim_ctx.get('handoff_reason', 'in_progress')}"
            + ("" if not handoff or _handoff_result else " — handoff ไม่สำเร็จ"),
            handoff_reason=claim_ctx.get("handoff_reason") if (handoff and _handoff_result) else None,
            assigned_admin=_handoff_result.get("assigned_to") if handoff and req.conversation_id else None,
            assigned_admin_name=_assigned_admin_name if handoff and req.conversation_id else None,
        ),
        "image_desc": ctx.get("image_desc_out", ""),
    }


def _handle_warranty_date_followup(req, ctx, history, purchase_date, db,
                                     _warranty_mod, product_store, _app_module) -> dict | None:
    """State: warranty date follow-up — คำนวณช่วงประกัน."""
    _bot_name = ctx.get("bot_name", "เรา")
    import re as _re3
    history_text = " ".join(h.get("text", "") for h in history)
    _valid_models = []
    _m_name = _re3.search(r"สินค้า\s+(.+?)\s+(?:รับประกัน|ประกัน|เคลม)", history_text)
    if _m_name:
        _candidate = _m_name.group(1).strip()
        _candidate = _re3.sub(r"\s*(ค่ะ|นะคะ|ครับ|จ้ะ)\s*$", "", _candidate).strip()
        if 3 <= len(_candidate) <= 60:
            _valid_models.append(_candidate)
    if not _valid_models:
        _user_msgs_text = " ".join(
            h.get("text", "") for h in history if h.get("role") == "user"
        )
        _user_codes = _re3.findall(r"\b([A-Za-z]?\d{2,4}[A-Za-z]{1,3})\b", _user_msgs_text)
        for _code in _user_codes:
            if len(_code) >= 3:
                _valid_models.append(_code)
                break
    if not _valid_models:
        _model_patterns = _re3.findall(r"\b([A-Za-z]{2,})\s+([A-Za-z]*\d+[A-Za-z]*)\b", history_text)
        _stop = {"งบ", "บาท", "ราคา", "โค้ด", "พิเศษ", "ลด", "เหลือ", "ใช้", "พร้อม", "ส่ง",
                 "ศูนย์", "ไทย", "เดือน", "ปี", "วัน", "ชั่วโมง", "GB", "RAM", "ROM",
                 "สินค้า", "รับประกัน", "ประกัน", "เคลม", "รบกวน", "แจ้ง"}
        for brand_part, model_part in _model_patterns:
            if brand_part.lower() in _stop:
                continue
            if not _re3.search(r"\d", model_part):
                continue
            if _re3.fullmatch(r"\d+", model_part):
                continue
            _valid_models.append(f"{brand_part} {model_part}")
    if not _valid_models:
        return None
    _model_query = _valid_models[0]
    try:
        _w_docs = list(db[os.environ.get("MONGO_COLLECTION", "ShpProducts")].find(
            {
                "item_name": {"$regex": _re3.escape(_model_query), "$options": "i"},
                **({"shopname": {"$regex": f"^{_re3.escape(req.shop)}$", "$options": "i"}} if req.shop else {}),
            },
            {"item_name": 1, "item_status": 1, "shopname": 1, "attribute_list": 1, "_id": 0},
        ).limit(3))
    except Exception as _e:
        print(f"[WARRANTY-DATE-V2] DB error: {_e}", file=sys.stderr)
        _w_docs = []
    _warranty_months = None
    _warranty_text = ""
    _product_name = ""
    for _wd in _w_docs:
        _wi = product_store._warranty_info(_wd)
        _dur = _wi.get("duration_months") or ""
        if _dur.isdigit():
            _warranty_months = int(_dur)
            _warranty_text = _wi.get("duration", "")
            _product_name = (_wd.get("item_name") or "")[:80]
            break
    if not (_warranty_months and _product_name):
        return None
    _calc = _warranty_mod.is_in_warranty(purchase_date, _warranty_months)
    if _calc["in_warranty"]:
        _answer = (
            f"ตรวจสอบข้อมูลเรียบร้อยแล้วค่ะ สินค้า {_product_name} "
            f"ที่ซื้อเมื่อวันที่ {purchase_date.strftime('%d/%m/%Y')} "
            f"ยังอยู่ในช่วงรับประกันนะคะ {_calc['text']} "
            f"(วันที่ประกันหมด: {_calc['expiry_date'].strftime('%d/%m/%Y')})\n\n"
            f"เพื่อดำเนินการเคลม/ซ่อมต่อ รบกวนแจ้งข้อมูลดังนี้ค่ะ:\n"
            f"• ชื่อ-นามสกุล\n"
            f"• เบอร์โทร\n\n"
            f"จากนั้นเดี๋ยว {_bot_name} จะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
        )
    else:
        _answer = (
            f"ตรวจสอบข้อมูลเรียบร้อยแล้วค่ะ สินค้า {_product_name} "
            f"ที่ซื้อเมื่อวันที่ {purchase_date.strftime('%d/%m/%Y')} "
            f"ไม่อยู่ในช่วงประกันแล้วนะคะ {_calc['text']} "
            f"(วันที่ประกันหมด: {_calc['expiry_date'].strftime('%d/%m/%Y')})\n\n"
            f"สนใจปรึกษาแอดมินก่อนไหมคะ"
        )
    _model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _total = round(_time.time() - ctx.get("total_start", _time.time()), 2)
    from . import llm
    return {
        "answer": _answer,
        "answer_segments": llm.split_segments(_answer),
        "products": [],
        "shop": req.shop,
        "model": _model_name,
        "source": "warranty_date_followup",
        "usage": {},
        "elapsed": _total,
        "cost": 0.0,
        "steps": ctx.get("steps", []),
        "routing_decision": _app_module._routing("bot_reply", "warranty_date_followup: คำนวณวันหมดประกัน"),
        "image_desc": ctx.get("image_desc_out", ""),
    }


def _handle_tax_invoice_followup(req, ctx, history, _warranty_mod, _app_module, llm) -> dict | None:
    """State: tax invoice follow-up — บอทเคยตอบใบกำกับ ลูกค้าตอบต่อ."""
    _last_model_msgs_tax = [h for h in history if h.get("role") == "model"][-1:]
    _last_model_text_tax = " ".join(h.get("text", "") for h in _last_model_msgs_tax).lower()
    _bot_answered_tax = any(
        kw in _last_model_text_tax
        for kw in ("ใบกำกับภาษี", "ใบกำกับ", "ภาษี", "tax invoice", "invoice")
    )
    if not _bot_answered_tax:
        return None
    _tax_consent = _warranty_mod.detect_consent(req.message)
    _tax_followup = any(
        kw in req.message.lower()
        for kw in ("ใบกำกับ", "ภาษี", "invoice", "เอกสาร", "จัดส่ง", "ไปรษณีย์",
                   "เลขผู้เสียภาษี", "เลขภาษี", "หจก.", "บจก.", "สนง.")
    )
    if not (_tax_consent or _tax_followup):
        return None
    _model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _total = round(_time.time() - ctx.get("total_start", _time.time()), 2)
    # handoff — transport owner เดียว; outcome ยืนยันเท่านั้นถึง claim ส่งแอดมิน
    _handoff_ok = bool(
        _app_module._send_handoff(
            req, None, reason="tax_invoice_request",
            claim={"topic": "ใบกำกับภาษี"}, log_tag="TAX-HANDOFF-V2",
        )
    ) if req.conversation_id else False
    from . import responses as _resp_mod
    _answer = (
        f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
        f"เพื่อดำเนินการเรื่องใบกำกับภาษีให้นะคะ "
        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
        if _handoff_ok else _resp_mod.HANDOFF_FAILED_REPLY
    )
    return {
        "answer": _answer,
        "answer_segments": llm.split_segments(_answer),
        "products": [],
        "shop": req.shop,
        "model": _model_name,
        "source": "tax_invoice_handoff",
        "usage": {},
        "elapsed": _total,
        "cost": 0.0,
        "handoff_to_admin": _handoff_ok,
        "handoff_reason": "tax_invoice_request" if _handoff_ok else None,
        "intent": ctx.get("intent_result") or {},
        "timing": ctx.get("timing_breakdown") or {},
        "steps": ctx.get("steps", []),
        "routing_decision": _app_module._routing(
            "handoff" if _handoff_ok else "bot_reply",
            "tax_invoice: follow-up จาก history → ส่งแอดมิน" if _handoff_ok
                else "tax_invoice: follow-up จาก history → handoff ไม่สำเร็จ",
            handoff_reason="tax_invoice_request" if _handoff_ok else None,
        ),
        "image_desc": ctx.get("image_desc_out", ""),
    }


def _handle_first_message_claim(req, ctx, is_claim, _warranty_mod, llm, _app_module,
                                claim_state: dict | None = None) -> dict | None:
    """State: first-message claim — claim request ไม่มี history หรือ state machine ไม่ได้จับ.

    explicit fresh claim request → transition owner เริ่ม episode ใหม่เมื่อ
    absent/terminal (identity allowlist ข้ามได้, case evidence ไม่ข้าม);
    open episode → ต่อ episode เดิม (retry/claim-request กลาง collect ไม่ fork).
    """
    if not is_claim:
        return None
    _bot_name = ctx.get("bot_name", "เรา")
    # ⚡ Task 5C-F — malfunction claim ต้อง acknowledge + safe checks ก่อน
    #   ขอข้อมูลเคลม (ไม่เดาสเปค/สาเหตุเฉพาะรุ่น)
    _answer = (
        _warranty_mod.malfunction_safe_check(req.message)
        + f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
        f"• วันที่ซื้อสินค้า\n"
        f"• เลขที่คำสั่งซื้อ\n"
        f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
        f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
        f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
        f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ {_bot_name} จะตรวจสอบและประสานงานต่อให้ค่ะ"
    )
    # ⚡ 2B.4 — explicit fresh claim request → episode lifecycle ผ่าน owner เดียว
    #   (capture authoritative return — episode_id ของ episode ที่เพิ่ง mint
    #   อยู่ใน state นี้ ไม่ใช่ claim_state เดิม)
    claim_state = _claim_transition(req, claim_state or {}, "collecting", fresh_claim=True)
    _claim_ctx = {"claim_topic": "เคลม/ซ่อม/ประกันสินค้า", "handoff_reason": "claim"}
    return _build_warranty_claim_response(
        req, ctx, _answer, True, _claim_ctx, _app_module, llm,
        claim_state=claim_state
    )


def handle_warranty_flow_legacy(req, ctx: dict, history: list[dict], db) -> dict | None:
    """Legacy warranty claim state machine — ย้าย verbatim จาก app.py chat().

    คืน dict kwargs สำหรับ ChatResponse ถ้า SM จับ flow ได้, None ถ้าไม่ใช่.
    ctx keys: anchor_compare_ctx, bot_name, image_desc_out, is_claim_request,
    is_followup_policy, is_tax_invoice, qa10, steps, timing_breakdown,
    total_start, t0, warranty_auto_answer, warranty_auto_ctx, intent_result, model_name
    """
    from . import warranty
    from . import llm
    from . import product_store
    from . import app as _app_module

    _anchor_compare_ctx = ctx.get("anchor_compare_ctx")
    _bot_name = ctx.get("bot_name", "ทางร้าน")
    _image_desc_out = ctx.get("image_desc_out", "")
    _is_claim_request = ctx.get("is_claim_request", False)
    _is_followup_policy = ctx.get("is_followup_policy", False)
    _is_tax_invoice = ctx.get("is_tax_invoice", False)
    _qa10 = ctx.get("qa10") or []
    _steps = ctx.get("steps") or []
    _timing_breakdown = ctx.get("timing_breakdown") or {}
    _total_start = ctx.get("total_start", _time.time())
    _t0 = ctx.get("t0", _time.time())
    _warranty_auto_answer = ctx.get("warranty_auto_answer", "")
    _warranty_auto_ctx = ctx.get("warranty_auto_ctx", "")
    _intent_result = ctx.get("intent_result") or {}
    model_name = ctx.get("model_name", "")
    _model_name = model_name  # ⚡ เดิม assign จาก os.environ GEMINI_MODEL — ค่าเดียวกับ model_name ที่ ctx ส่งมา

    # ===== warranty date follow-up =====
    # กรณี: รอบก่อนบอทถาม "วันที่ซื้อ" + รอบนี้ลูกค้าบอกวันที่
    # → ดึงสินค้าจาก history + คำนวณช่วงประกัน + ตอบตรงๆ
    # (ไม่ต้องเรียก LLM คำนวณเอง เพราะ LLM อาจคำนวณผิด)
    _warranty_date_followup = False

    # ===== Warranty Claim State Machine =====
    # Flow ใหม่: duration → claim_request → date → info → confirm → handoff
    # ตรวจ state จาก history เพื่อกำหนด action ในรอบปัจจุบัน
    _warranty_claim_handoff = False  # ถ้า True → ส่งต่อแอดมิน
    _warranty_claim_ctx: dict = {}
    _warranty_claim_answer: str = ""
    # ⚡ BUG-D fix — โหลด claim state ที่เก็บไว้ข้าม turn (กันขอข้อมูลซ้ำ)
    _claim_state: dict = {}
    if req.conversation_id:
        try:
            from . import conversation_products as _cp_claim
            _claim_state = _cp_claim.load_claim_state(req.conversation_id) or {}
        except Exception:
            pass
    # ⚡ 2B.6 — explicit admin outcome ก่อน lifecycle evaluate (authoritative turn)
    _claim_state = _consume_claim_outcome(req, _claim_state)
    # ⚡ 2B.4 — lifecycle view จาก evaluator เดียว: marker/field evidence ใช้ได้
    #   เฉพาะตอนไม่ terminal (terminal ต้อง explicit fresh claim เท่านั้น)
    _view = _claim_lifecycle(_claim_state)
    _accept_evidence = _view.lifecycle_open or _view.stage == "absent"

    # ⚡ 2B.4 — explicit claim request ตอนไม่มี open episode → ข้าม SM ทั้งก้อน
    #   ไป fresh-claim path เดียว (terminal/absent → episode ใหม่ผ่าน owner)
    _fresh_claim = _is_claim_request and not _view.lifecycle_open

    # ⚡ ถ้ามี _anchor_compare_ctx (comparison/partial-comparison/post-comparison) → ข้าม warranty state machine
    #   กัน "คุณภาพเสียง" ถูก detect เป็น claim request ("เสียง" = พัง) ทั้งที่ลูกค้าถามเปรียบเทียบ
    # ⚡ 2B.4 — open episode รับ field ได้แม้ history ว่าง (persisted state เป็น
    #   authority — marker ไม่ใช่ resume authority อยู่แล้ว)
    if (history or _view.lifecycle_open) and not _anchor_compare_ctx and not _fresh_claim:
        # ⚡ Phase 8 — state machine guard ใช้ last model message เท่านั้น (ไม่ใช่ _recent_qa_pairs)
        #   เพราะต้องเช็คแค่ "model ตอบอะไรล่าสุด" ไม่ใช่บริบทยาว
        _last_model_msgs = [h for h in history if h.get("role") == "model"][-1:]
        _last_model_text = " ".join(h.get("text", "") for h in _last_model_msgs).lower()
        # ⚡ Guard: ถ้า last model message ไม่เกี่ยวกับ warranty เลย → ข้าม state machine
        #   ป้องกัน trigger cascade (เคส Q1 warranty → Q2-Q4 product → Q5 โดนจับ)
        _last_model_is_warranty = any(
            kw in _last_model_text
            for kw in ("รับประกัน", "ประกัน", "เคลม", "warranty", "claim",
                       "วันที่ซื้อ", "เลขที่คำสั่งซื้อ", "ชื่อ-นามสกุล", "เบอร์โทร",
                       "รูปหรือวิดีโอ", "แสดงอาการ", "ความเสียหาย", "มอบหมายงาน",
                       "รอการติดต่อกลับ", "ส่งต่อให้แอดมิน", "แอดมินดูแล",
                       "นอกช่วงประกัน", "หมดช่วงประกัน")
        )
        # ⚡ Phase 8 — review request extraction ใช้ history ทั้งหมด (ไม่ใช่ _recent_qa_pairs)
        #   เพราะลูกค้าอาจให้ข้อมูลเคลมมาตั้งแต่หลายข้อความก่อนหน้า
        #   ถ้าจำกัด 10 คู่ → อาจตัดข้อมูลสำคัญออก → extract_customer_info จะไม่เจอ
        _all_history_text = " ".join(h.get("text", "") for h in history)

        # ⚡ Troubleshoot-first follow-up — รอบก่อนบอทแนะนำวิธีแก้ (stage=ts_suggested
        #   หรือ last model msg มี marker) → ลูกค้ารายงานผล
        _ts_suggested = (
            _view.stage == "ts_suggested"
            or "ลองทำตามนี้ก่อน" in _last_model_text
        )
        if _ts_suggested and not _warranty_claim_answer:
            _ts_low = req.message.lower()
            _ts_success = any(k in _ts_low for k in (
                "หายแล้ว", "ได้แล้ว", "เรียบร้อย", "ใช้ได้แล้ว", "หายไปแล้ว",
                "โอเคแล้ว", "ok แล้ว", "เวิร์คแล้ว", "work แล้ว"))
            _ts_failed = any(k in _ts_low for k in (
                "ไม่หาย", "ไม่ได้", "เหมือนเดิม", "ยังเป็น", "ไม่เวิร์ค",
                "ไม่work", "ไม่สำเร็จ", "ลองแล้ว", "ทำแล้ว", "ไม่เปลี่ยน",
                "ไม่ดีขึ้น"))
            if _ts_success:
                _warranty_claim_answer = (
                    f"ดีใจด้วยนะคะที่แก้ไขได้ ถ้ามีปัญหาอีกแจ้ง{_bot_name}ได้ตลอดเลยค่ะ")
                # ⚡ 2B.4 — valid terminal evidence เดียวตอนนี้: ลูกค้ายืนยันแก้ได้
                #   หลัง troubleshoot → resolved ผ่าน owner (เก็บ evidence ไว้)
                _claim_state = _claim_transition(req, _claim_state, "resolved")
                print("[TS-FOLLOWUP] ลูกค้าแจ้งแก้ไขได้ → ปิดเคส ไม่ handoff", file=sys.stderr)
            elif _ts_failed or _is_claim_request:
                _warranty_claim_answer = (
                    f"รับทราบค่ะ งั้นเดี๋ยว{_bot_name}ช่วยดำเนินการเรื่องเคลม/รับประกันให้นะคะ\n"
                    f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
                    f"• วันที่ซื้อสินค้า\n"
                    f"• เลขที่คำสั่งซื้อ\n"
                    f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
                    f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
                    f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
                    f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ {_bot_name} จะตรวจสอบและประสานงานต่อให้ค่ะ")
                _warranty_claim_handoff = True
                _warranty_claim_ctx = {"handoff_reason": "warranty_claim"}
                # ⚡ 2B.4 — เริ่มเก็บข้อมูล ผ่าน transition owner เดียว
                _claim_state = _claim_transition(req, _claim_state, "collecting")
                print("[TS-FOLLOWUP] วิธีแก้ไม่ได้ผล → claim info + handoff", file=sys.stderr)

        # ⚡ Phase 1F — Review request: ลูกค้าขอทวนข้อมูลที่ให้ไป
        #   ต้องเช็คก่อน State 3/6 เพราะ "ทวนข้อมูลที่ผมให้ไปหน่อย" อาจถูก extract_customer_info
        #   ตีความเป็นชื่อได้ → ตกเข้า State 6 ผิด
        _review_request_kws = (
            "ทวนข้อมูล", "ทวน ข้อมูล", "ข้อมูลที่ให้ไป", "ข้อมูลที่ผมให้",
            "ยืนยันข้อมูล", "ยืนยัน ข้อมูล", "ข้อมูลที่ส่งไป", "ข้อมูลที่แจ้งไป",
            "สรุปข้อมูล", "สรุป ข้อมูล", "ข้อมูลเคลม",
        )
        _is_review_request = any(kw in req.message for kw in _review_request_kws)
        if _is_review_request and _last_model_is_warranty:
            # canonical owner: _handle_review_request — extract/answer/response เดียวกัน
            print(f"[WARRANTY-REVIEW] ลูกค้าขอทวนข้อมูล → สรุปจาก history", file=sys.stderr)
            return _handle_review_request(req, ctx, history, warranty, llm, _app_module)

        # ตรวจ state จาก history
        # State 1: บอทเคยตอบ "รับประกัน X ปี" → ลูกค้าอาจจะถาม claim request
        _bot_answered_duration = any(
            kw in _last_model_text
            for kw in ("รับประกัน", "ประกัน", "เคลม", "warranty")
        ) and any(kw in _last_model_text for kw in ("ปี", "เดือน", "year", "month"))

        # State 2: บอทเคยถาม "วันที่ซื้อ" → ลูกค้าอาจให้วันที่
        _bot_asked_date = any(
            kw in _last_model_text
            for kw in ("วันที่ซื้อ", "ซื้อวันที่", "วันที่ ซื้อ", "purchase date", "ซื้อมาวันที่")
        )

        # State 3: บอทเคยถาม "ชื่อ-นามสกุล เบอร์โทร" → ลูกค้าอาจให้ข้อมูล
        # ต้องตรวจว่าบอท "ถาม/ขอ" ข้อมูลจริง ไม่ใช่แค่มีคำเหล่านี้อยู่ในคำตอบ
        # (เช่น บอทตอบเรื่องสเปคแล้วบังเอิญมี "รับประกัน 2 ปี ชื่อ-นามสกุล เบอร์โทร" จาก context)
        _info_request_kws = (
            "ชื่อ-นามสกุล", "ชื่อ นามสกุล", "ชื่อและนามสกุล",
            "เบอร์โทร", "เบอร์ติดต่อ", "หมายเลขโทร",
            "เลขที่คำสั่งซื้อ", "หมายเลขคำสั่งซื้อ", "order number",
            "phone number", "เบอร์มือถือ",
        )
        _ask_verbs = (
            "กรุณาแจ้ง", "รบกวนแจ้ง", "รบกวนขอ", "กรุณาส่ง", "รบกวนส่ง",
            "แจ้งชื่อ", "แจ้งเบอร์", "แจ้งเลข", "ส่งชื่อ", "ส่งเบอร์",
            "ขอชื่อ", "ขอเบอร์", "ขอเลข", "ขอข้อมูล",
            "please provide", "please send",
        )
        _bot_asked_info = (
            any(kw in _last_model_text for kw in _info_request_kws)
            and any(verb in _last_model_text for verb in _ask_verbs)
        )
        # ⚡ ถ้า last message ไม่ใช่ info request แต่ bot เคยขอข้อมูลใน history
        # (เช่น มี policy question แทรกกลาง) → ให้ตรวจ history ทั้งหมด
        # ⚡ Guard: ถ้า last model msg ไม่ใช่ warranty เลย → ไม่ใช้ fallback นี้
        #   ป้องกัน trigger cascade (Q1 warranty → Q2-Q4 product → Q5 โดนจับ)
        # ⚡ T5 — lifecycle_open เป็นเงื่อนไขเสริม: open episode persist = กำลังเก็บข้อมูล
        #   แม้ last model msg ไม่ใช่ warranty (ลูกค้าแทรกคำถามกลาง flow แล้วส่งข้อมูลต่อ)
        if not _bot_asked_info and _accept_evidence and (_last_model_is_warranty or _view.accepts_claim_fields):
            _all_model_text = " ".join(
                h.get("text", "") for h in history if h.get("role") == "model"
            ).lower()
            _bot_asked_info_ever = (
                (any(kw in _all_model_text for kw in _info_request_kws)
                 and any(verb in _all_model_text for verb in _ask_verbs))
                or _view.accepts_claim_fields
            )
            # ใช้แค่เมื่อลูกค้าให้ข้อมูลจริง (มี order_id/name/phone) ไม่ใช่ถามคำถาม
            if _bot_asked_info_ever:
                _pre_info = warranty.extract_customer_info(req.message)
                # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
                _pre_valid_name = bool(_pre_info["name"])
                _pre_has_info = (
                    bool(_pre_info["order_id"])
                    or _pre_valid_name
                    or bool(_pre_info["phone"])
                )
                if _pre_has_info:
                    _bot_asked_info = True
                    print(f"[WARRANTY-CLAIM] bot asked info earlier in history → treat as info submission", file=sys.stderr)

        # State 4: บอทเคยทวนข้อมูล → ลูกค้าอาจยืนยัน
        # ต้องมี "ทวน" หรือ "ถูกต้องไหม" หรือ "ข้อมูลถูกต้อง" อย่างน้อยหนึ่งอย่าง
        # (ไม่ใช่แค่ "ยืนยัน" เฉยๆ เพราะเงื่อนไขประกันมักมี "ยืนยันการซื้อ" อยู่แล้ว)
        _bot_reviewed_info = any(
            kw in _last_model_text
            for kw in ("ทวน", "ถูกต้องไหม", "ข้อมูลถูกต้อง", "confirm", "ขอให้ยืนยัน", "กรุณายืนยัน")
        )

        # State 5: บอทเคยบอก "นอกช่วงประกัน" → ลูกค้าอาจสนใจปรึกษาแอดมิน
        _bot_said_out_of_warranty = any(
            kw in _last_model_text
            for kw in ("ไม่อยู่ในช่วงประกัน", "หมดช่วงประกัน", "หมดประกัน", "out of warranty")
        ) and any(kw in _last_model_text for kw in ("สนใจ", "ปรึกษา", "แอดมิน", "admin"))

        # State 7: บอทเคยขอข้อมูลเคลม (วันที่+order+รูป) → ลูกค้าอาจส่งรูป/วิดีโอหรือข้อมูลบางส่วน
        # ⚡ สำคัญ: ลูกค้าส่ง [รูปภาพ] หรือ [วิดีโอ] ตามที่บอทขอ → ต้องรับและเก็บเป็นข้อมูลเคลม
        _bot_asked_claim_info = (
            any(kw in _last_model_text for kw in ("วันที่ซื้อ", "ซื้อวันที่", "วันที่ ซื้อ", "purchase date", "ซื้อมาวันที่"))
            and any(kw in _last_model_text for kw in ("เลขที่คำสั่งซื้อ", "หมายเลขคำสั่งซื้อ", "order number", "คำสั่งซื้อ"))
            and any(kw in _last_model_text for kw in ("รูป", "วิดีโอ", "photo", "video", "แสดงอาการ", "ความเสียหาย"))
        )
        # ลูกค้าส่งรูป/วิดีโอ (placeholder text จาก Shopee)
        _msg_is_image = req.message.strip() in ("[รูปภาพ]", "[image]", "[วิดีโอ]", "[video]", "[sticker]", "[สติกเกอร์]")
        # ลูกค้าส่งรูปพร้อมข้อความ (image_with_text) — มี placeholder + text อื่น
        _msg_has_image_placeholder = bool(re.search(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", req.message, re.IGNORECASE))

        # ตรวจว่าลูกค้าให้วันที่จริงไหม (ใช้ในหลาย state)
        _msg_has_date = warranty.parse_purchase_date(req.message) is not None

        # ── State 7: awaiting_claim_info → ลูกค้าส่งรูป/วิดีโอ หรือข้อมูลบางส่วน ──
        # ถ้าบอทเคยขอ วันที่+order+รูป แล้วลูกค้าส่งรูป/วิดีโอ หรือให้ข้อมูลบางส่วน
        # → รับรูป + ถามข้อมูลที่เหลือ (วันที่/order) หรือถ้าครบแล้ว → ทวน + ถามยืนยัน
        # ⚡ Phase 2B — ขยับ State 7 ให้กว้างขึ้น: ถ้า history มี warranty/claim discussion
        #    และลูกค้าส่งรูป/วิดีโอ → ถือว่าเป็น claim evidence แม้บอทไม่ได้ขอ claim info ใน last message
        #    (ป้องกัน Q11: บอทตอบเรื่องระยะเวลาเคลม → ลูกค้าส่งรูป → บอทตอบเป็น product info ผิด)
        # ⚡ Phase 2Z+ — จำกัดให้เช็คเฉพาะ history ล่าสุด (3 ข้อความ) แทนทั้งหมด
        #    กัน case: ลูกค้าถาม "ประกัน" ไป 10 ข้อความก่อน → ส่งรูปเฉยๆ ก็โดนตีเป็น claim evidence
        #    + ต้องเช็คด้วยว่า message ปัจจุบินมี warranty keyword หรือเปล่า (ถ้าไม่มีเลย → ไม่ใช่ claim)
        _warranty_ctx_in_history = False
        if history and (_msg_is_image or _msg_has_image_placeholder):
            _warranty_ctx_kws = (
                "เคลม", "ประกัน", "ซ่อม", "เสีย", "พัง", "ใช้ไม่ได้", "ไม่ทำงาน",
                "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด", "รับประกัน", "warranty",
                "แอดมินดูแล", "รอการติดต่อกลับ", "ตรวจสอบ", "ส่งเคลม",
            )
            # ⚡ Phase 2Z+ — เช็คเฉพาะ history ล่าสุด 3 ข้อความ (ไม่ใช่ทั้งหมด)
            _recent_history = history[-3:] if len(history) > 3 else history
            for _h in _recent_history:
                _ht = ((_h.get("text") if isinstance(_h, dict) else _h.text) or "").lower()
                if any(kw in _ht for kw in _warranty_ctx_kws):
                    _warranty_ctx_in_history = True
                    break
            # ⚡ Phase 2Z+ — ถ้า message ปัจจุบันเป็นแค่รูปเฉยๆ (ไม่มี warranty keyword เลย)
            #    และ history ล่าสุด 3 ข้อความก็ไม่มี warranty discussion → ไม่ใช่ claim evidence
            _current_msg_lower = req.message.lower()
            _current_has_warranty_kw = any(kw in _current_msg_lower for kw in _warranty_ctx_kws)
            if _warranty_ctx_in_history and not _current_has_warranty_kw and (_msg_is_image or _msg_has_image_placeholder):
                # ⚡ ตรวจว่า message หลังตัด image placeholder แล้วว่างไหม
                #    (ถ้าว่าง = ลูกค้าส่งแค่รูปเฉยๆ ไม่ได้พิมพ์อะไร → ไม่ใช่ claim evidence)
                _msg_without_placeholder = re.sub(
                    r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]",
                    "", req.message, flags=re.IGNORECASE
                ).strip()
                if not _msg_without_placeholder:
                    _warranty_ctx_in_history = False
                    print(f"[WARRANTY-CTX-IMAGE] skip: ลูกค้าส่งรูปเฉยๆ ไม่มี warranty keyword → ปล่อยไปเส้นทางปกติ", file=sys.stderr)
            # ⚡ Guard: ถ้า message มี product keywords และไม่มี warranty keywords → ไม่ถือเป็น claim evidence
            #    (กัน case: ลูกค้าถาม "มีสายแรงกว่านี้ไหม [รูปภาพ]" ใน context warranty → ไม่ควรเป็น claim evidence)
            #    ⚡ 2B.5 — fix latent NameError: ตัวแปรเดิมถูกประกาศเฉพาะ v2 scope
            _is_product_q = (
                any(kw in _current_msg_lower for kw in _POST_HANDOFF_PRODUCT_KWS)
                and not any(kw in _current_msg_lower for kw in _POST_HANDOFF_WARRANTY_KWS))
            if _warranty_ctx_in_history and _is_product_q:
                _warranty_ctx_in_history = False
                print(f"[WARRANTY-CTX-IMAGE] skip: message มี product keywords ไม่มี warranty keywords → ปล่อยไปเส้นทางปกติ", file=sys.stderr)
            elif _warranty_ctx_in_history:
                print(f"[WARRANTY-CTX-IMAGE] ลูกค้าส่งรูป/วิดีโอ ใน context warranty → ถือเป็น claim evidence", file=sys.stderr)
        # ⚡ T5 — collecting episode (accepts_claim_fields) เป็นเงื่อนไขที่ 3:
        #   info submission หลังคำถามแทรกยังถูกรับเข้า flow เพราะ claim_state persist;
        #   marker ใช้ได้เฉพาะตอนไม่ terminal (_accept_evidence) — terminal ต้อง
        #   explicit fresh claim; ts_suggested ยังไม่รับ field (verdict ผ่าน ts-followup)
        if (_view.accepts_claim_fields or (_accept_evidence and (_bot_asked_claim_info or _warranty_ctx_in_history))) and not _bot_reviewed_info:
            # ⚡ ตัด image placeholder ออกก่อน extract info (กัน [รูปภาพ] ถูกตีความเป็นชื่อ)
            _claim_clean_msg = re.sub(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", "", req.message, flags=re.IGNORECASE).strip()
            # ⚡ ตัด date pattern ออกอีก (กัน "ซื้อวันที่ 15 ส.ค. 2567" ถูกตีความเป็นชื่อ)
            _parsed_date_str = None
            if _msg_has_date:
                _parsed_date_val = warranty.parse_purchase_date(req.message)
                if _parsed_date_val is not None:
                    _parsed_date_str = _parsed_date_val.strftime("%Y-%m-%d") if hasattr(_parsed_date_val, "strftime") else str(_parsed_date_val)
                    _claim_clean_msg = _claim_clean_msg.replace(_parsed_date_str, "")
                # ตัด phrase นำหน้าด้วย เช่น "ซื้อวันที่ ...", "วันที่ซื้อ ..."
                _claim_clean_msg = re.sub(r"(?:ซื้อวันที่|วันที่ซื้อ|วันที่ ซื้อ|ซื้อมาวันที่)\s*\d{1,2}\s*[A-Za-zก-ฮ\.]+\s*\d{2,4}", "", _claim_clean_msg, flags=re.IGNORECASE)
                _claim_clean_msg = re.sub(r"(?:ซื้อวันที่|วันที่ซื้อ|วันที่ ซื้อ|ซื้อมาวันที่)", "", _claim_clean_msg, flags=re.IGNORECASE)
            _info = warranty.extract_customer_info(_claim_clean_msg)
            _has_date = _msg_has_date
            _has_order = bool(_info["order_id"])
            # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
            _has_name = bool(_info["name"])
            _has_phone = bool(_info["phone"])
            _has_image = _msg_is_image or _msg_has_image_placeholder

            # ⚡ Flow ใหม่: handoff แล้ว → บอทรับข้อมูลเบื้องต้น + บอกรอแอดมิน
            #   ไม่ต้องทวน/ถามยืนยัน — แอดมินมาอ่านแชทต่อ
            #   ถ้าลูกค้าส่งอะไรมา (รูป/วันที่/order/ชื่อ/เบอร์) → ขอบคุณ + บอกรอแอดมิน
            if _has_image or _has_date or _has_order or _has_name or _has_phone:
                _received_items = []
                if _has_image:
                    _received_items.append("รูป/วิดีโอแสดงอาการ")
                if _has_date:
                    _received_items.append("วันที่ซื้อสินค้า")
                if _has_order:
                    _received_items.append("เลขที่คำสั่งซื้อ")
                if _has_name:
                    _received_items.append("ชื่อ-นามสกุล")
                if _has_phone:
                    _received_items.append("เบอร์โทร")
                _received_text = " · ".join(_received_items)
                _warranty_claim_answer = (
                    f"ขอบคุณค่ะ ได้รับข้อมูล({_received_text}) เรียบร้อยแล้ว "
                    f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ "
                    f"ทางเราจะดำเนินการโดยเร็วที่สุดค่ะ"
                )
                # ⚡ handoff=True เสมอ — แอดมินต้องรู้ว่าลูกค้าส่งข้อมูลใหม่มา
                _warranty_claim_handoff = True
                # ⚡ T5 — merge กับ claim_state: handoff claim ได้ข้อมูลครบ (ไม่ใช่แค่ turn นี้)
                _slots = _merge_claim_slots(
                    _info, has_date=_has_date, has_image=_has_image,
                    claim_state=_claim_state,
                )
                _warranty_claim_ctx = {
                    "customer_name": _slots["name"],
                    "customer_phone": _slots["phone"],
                    "customer_order_id": _slots["order_id"],
                    "purchase_date": _parsed_date_str or _claim_state.get("purchase_date"),
                    "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
                }
                print(f"[WARRANTY-CLAIM] post-handoff info received: date={_has_date} order={_has_order} name={_has_name} phone={_has_phone} image={_has_image}", file=sys.stderr)
                # ⚡ BUG-D fix — save claim state ข้าม turn ผ่าน transition owner เดียว
                _claim_state = _claim_transition(req, _claim_state, "collecting", {
                    "customer_name": _info.get("name") if _has_name else None,
                    "customer_phone": _info.get("phone") if _has_phone else None,
                    "customer_order_id": _info.get("order_id") if _has_order else None,
                    "purchase_date": _parsed_date_str,
                    "has_image": True if _has_image else None,
                })

            # ⚡ 2B.5 — BUG-D catch-all ถูกลบ: ข้อความที่ไม่ใช่ข้อมูลเคลมระหว่าง
            #   collecting → fallthrough ไป normal pipeline (ไม่บังคับ handoff;
            #   episode คงอยู่ → field turn ถัดไป resume ผ่าน lifecycle view)

        # ── State: awaiting_customer_info → ลูกค้าให้ข้อมูล → ทวน + ถามยืนยัน ──
        # ต้องเป็น info request จริง (ไม่ใช่วันที่) และลูกค้าให้ข้อมูลจริง
        if _bot_asked_info and not _bot_reviewed_info and not _msg_has_date and _accept_evidence:
            _info = warranty.extract_customer_info(req.message)
            # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
            _has_valid_name = bool(_info["name"])
            _has_valid_phone = bool(_info["phone"])
            # ⚡ ต้องมี order_id ก็นับว่าเป็นข้อมูลบางส่วน (เช่น ลูกค้าให้เลขคำสั่งซื้อก่อน)
            _has_valid_order = bool(_info["order_id"])
            if _has_valid_name or _has_valid_phone or _has_valid_order:
                # ⚡ T5 — fill-once: รวม claim_state ที่ persist → ไม่ถาม slot ที่มีแล้วซ้ำ
                _slots = _merge_claim_slots(_info, claim_state=_claim_state)
                # ทวนข้อมูลที่ให้มา + ถามข้อมูลที่เหลือ
                _review_lines = []
                _missing_lines = []
                if _slots["name"]:
                    _review_lines.append(f"• ชื่อ-นามสกุล: {_slots['name']}")
                else:
                    _missing_lines.append("• ชื่อ-นามสกุล")
                if _slots["phone"]:
                    _review_lines.append(f"• เบอร์โทร: {_slots['phone']}")
                else:
                    _missing_lines.append("• เบอร์โทร")
                if _slots["order_id"]:
                    _review_lines.append(f"• เลขที่คำสั่งซื้อ: {_slots['order_id']}")
                else:
                    _missing_lines.append("• เลขที่คำสั่งซื้อ")
                _review_text = "\n".join(_review_lines)
                if _missing_lines:
                    _missing_text = "\n".join(_missing_lines)
                    _warranty_claim_answer = (
                        f"รับทราบค่ะ ข้อมูลที่ลูกค้าให้มา:\n"
                        f"{_review_text}\n\n"
                        f"รบกวนแจ้งข้อมูลที่เหลือเพิ่มเติมด้วยนะคะ:\n"
                        f"{_missing_text}\n\n"
                        f"และหากมีรูปหรือวิดีโอแสดงอาการ ส่งมาได้เลยค่ะ"
                    )
                else:
                    _warranty_claim_answer = (
                        f"รบกวนทวนข้อมูลนะคะ ข้อมูลที่ลูกค้าให้มา:\n"
                        f"{_review_text}\n\n"
                        f"ข้อมูลถูกต้องไหมคะ ถ้าถูกต้องเดี๋ยวจะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
                    )
                _warranty_claim_ctx = {
                    "customer_name": _slots["name"],
                    "customer_phone": _slots["phone"],
                    "customer_order_id": _slots["order_id"],
                    "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
                }
                print(f"[WARRANTY-CLAIM] info collected: {_info} merged={_slots}", file=sys.stderr)
                # ⚡ BUG-D fix — save claim state ข้าม turn ผ่าน transition owner เดียว
                _claim_state = _claim_transition(req, _claim_state, "collecting", {
                    "customer_name": _info.get("name") if _has_valid_name else None,
                    "customer_phone": _info.get("phone") if _has_valid_phone else None,
                    "customer_order_id": _info.get("order_id") if _has_valid_order else None,
                })

        # ── State: awaiting_confirmation → ลูกค้ายืนยันหรือแก้ข้อมูล ──
        elif _bot_reviewed_info:
            if warranty.detect_confirmation(req.message):
                _warranty_claim_answer = (
                    f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมินดำเนินการต่อนะคะ "
                    f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                )
                _warranty_claim_handoff = True
                _warranty_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty"}
                print(f"[WARRANTY-CLAIM] confirmed → handoff", file=sys.stderr)
            else:
                # ลูกค้าแก้ข้อมูล ไม่ยืนยัน → ดึงข้อมูลใหม่และทวนอีกครั้ง
                _info = warranty.extract_customer_info(req.message)
                # ⚡ 2B.5 — name validity = parser output เท่านั้น (ลบ shape re-check)
                _has_valid_name = bool(_info["name"])
                _has_valid_phone = bool(_info["phone"])
                _has_valid_order = bool(_info["order_id"])
                if (_has_valid_name or _has_valid_phone or _has_valid_order) and _accept_evidence:
                    _review_lines = []
                    if _has_valid_name:
                        _review_lines.append(f"• ชื่อ-นามสกุล: {_info['name']}")
                    if _info["phone"]:
                        _review_lines.append(f"• เบอร์โทร: {_info['phone']}")
                    if _info["order_id"]:
                        _review_lines.append(f"• เลขที่คำสั่งซื้อ: {_info['order_id']}")
                    _review_text = "\n".join(_review_lines)
                    _warranty_claim_answer = (
                        f"รับทราบค่ะ ขออนุญาตทวนข้อมูลใหม่นะคะ:\n"
                        f"{_review_text}\n\n"
                        f"ข้อมูลถูกต้องไหมคะ ถ้าถูกต้องเดี๋ยวจะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
                    )
                    _warranty_claim_ctx = {
                        "customer_name": _info["name"],
                        "customer_phone": _info["phone"],
                        "customer_order_id": _info["order_id"],
                        "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
                    }
                    # ⚡ 2B.5 — persist correction ผ่าน transition owner เดียว
                    #   (เดิม legacy rebuild ctx แต่ไม่เขียน → ข้อมูลแก้หาย)
                    _claim_state = _claim_transition(req, _claim_state, "collecting", {
                        "customer_name": _info.get("name") if _has_valid_name else None,
                        "customer_phone": _info.get("phone") if _has_valid_phone else None,
                        "customer_order_id": _info.get("order_id") if _has_valid_order else None,
                    })
                    print(f"[WARRANTY-CLAIM] info corrected: {_info}", file=sys.stderr)
                else:
                    # ลูกค้าไม่ได้ให้ข้อมูลใหม่ แต่ก็ไม่ได้ปฏิเสธ → ถือว่ายืนยัน (ส่งต่อแอดมิน)
                    _warranty_claim_answer = (
                        f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมินดำเนินการต่อนะคะ "
                        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                    )
                    _warranty_claim_handoff = True
                    _warranty_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty"}
                    print(f"[WARRANTY-CLAIM] no new info → assume confirm → handoff", file=sys.stderr)

        # ── State: out_of_warranty_consult → ลูกค้าสนใจ → ส่งต่อแอดมิน ──
        elif _bot_said_out_of_warranty:
            if warranty.detect_consent(req.message):
                _warranty_claim_answer = (
                    f"ได้ค่ะ เดี๋ยวจะขออนุญาตส่งต่อแชทนี้ให้แอดมินนะคะ "
                    f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                )
                _warranty_claim_handoff = True
                _warranty_claim_ctx = {"handoff_reason": "warranty_claim_out_of_warranty"}
                print(f"[WARRANTY-CLAIM] out-of-warranty consent → handoff", file=sys.stderr)

        # ── State: duration_answered → ลูกค้า claim request → ถามวันที่ซื้อ + handoff ทันที ──
        # ⚡ เปลี่ยน flow: ขอข้อมูลเคลม + handoff แอดมินทันที
        #   บอทตั้งคำถามเบื้องต้นทิ้งไว้ให้ลูกค้าตอบ → แอดมินมาอ่านแชทต่อ
        #   ถ้าลูกค้าตอบกลับมา → State 7 รับข้อมูล + บอกรอแอดมิน (ไม่ต้องทวน/ถามยืนยัน)
        elif _bot_answered_duration and not _msg_has_date:
            if warranty.detect_claim_request(req.message):
                _warranty_claim_answer = (
                    f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
                    f"• วันที่ซื้อสินค้า\n"
                    f"• เลขที่คำสั่งซื้อ\n"
                    f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
                    f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
                    f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
                    f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ {_bot_name} จะตรวจสอบและประสานงานต่อให้ค่ะ"
                )
                # ⚡ handoff ทันที — ส่งให้แอดมินดูแล บอทยังรับข้อมูลเบื้องต้นได้
                _warranty_claim_handoff = True
                _warranty_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty"}
                # ⚡ 2B.4 — explicit claim request → fresh path ผ่าน owner (episode
                #   ใหม่เมื่อ absent/terminal; open → episode เดิม)
                _claim_state = _claim_transition(req, _claim_state, "collecting", fresh_claim=True)
                print(f"[WARRANTY-CLAIM] claim request → ask date+order+photo + handoff immediately", file=sys.stderr)

        # ถ้ามี warranty claim answer → ส่งตอบก่อนเข้า flow อื่น
        if _warranty_claim_answer:
            _total_elapsed = _time.time() - _total_start
            print(f"[TIMING] WARRANTY-CLAIM: {_total_elapsed:.2f}s  handoff={_warranty_claim_handoff}", file=sys.stderr)
            # transport owner เดียว — outcome ยืนยันเท่านั้นถึง claim/flag/clear
            return _build_warranty_claim_response(
                req, ctx, _warranty_claim_answer, _warranty_claim_handoff,
                _warranty_claim_ctx, _app_module, llm,
                claim_state=_claim_state,
            )

    if history and not _is_followup_policy:
        # ตรวจว่า message ปัจจุบันมีวันที่ไหม
        _purchase_date = warranty.parse_purchase_date(req.message)
        if _purchase_date:
            # ตรวจว่า history ล่าสุด (model message) มีคำว่า "วันที่ซื้อ" / "ซื้อวันที่" ไหม
            _last_model_msgs = [h for h in history if h.get("role") == "model"][-2:]
            _last_text = " ".join(h.get("text", "") for h in _last_model_msgs)
            _asked_purchase_date = any(
                kw in _last_text
                for kw in ("วันที่ซื้อ", "ซื้อวันที่", "วันที่ ซื้อ", "purchase date", "ซื้อมาวันที่")
            )
            if _asked_purchase_date:
                # ดึง model name จาก history
                # ลอง 2 pattern:
                # 1) "สินค้า <name> รับประกัน" → ดึง <name>
                # 2) word + space + alphanumeric with digit (เช่น "Redmi 8A")
                history_text = " ".join(h.get("text", "") for h in _qa10)
                _valid_models = []
                # pattern 1: หา pattern ระหว่าง "สินค้า" และ "รับประกัน"/"ประกัน"
                _m_name = re.search(
                    r"สินค้า\s+(.+?)\s+(?:รับประกัน|ประกัน|เคลม)",
                    history_text,
                )
                if _m_name:
                    _candidate = _m_name.group(1).strip()
                    # ตัดคำขยะท้ายชื่อ (เช่น "ค่ะ", "นะคะ")
                    _candidate = re.sub(r"\s*(ค่ะ|นะคะ|ครับ|จ้ะ)\s*$", "", _candidate).strip()
                    if 3 <= len(_candidate) <= 60:
                        _valid_models.append(_candidate)
                # pattern 2: word + space + alphanumeric with digit (เดิม)
                if not _valid_models:
                    # pattern 2a: ดึงจาก user messages ก่อน (ลูกค้าพิมพ์เอง น่าเชื่อกว่า)
                    _user_msgs_text = " ".join(
                        h.get("text", "") for h in history if h.get("role") == "user"
                    )
                    # หา alphanumeric code เช่น "652U", "AD653T", "CMC615P"
                    _user_codes = re.findall(
                        r"\b([A-Za-z]?\d{2,4}[A-Za-z]{1,3})\b", _user_msgs_text
                    )
                    for _code in _user_codes:
                        if len(_code) >= 3:
                            _valid_models.append(_code)
                            break
                if not _valid_models:
                    _model_patterns = re.findall(
                        r"\b([A-Za-z]{2,})\s+([A-Za-z]*\d+[A-Za-z]*)\b", history_text
                    )
                    _stop = {"งบ", "บาท", "ราคา", "โค้ด", "พิเศษ", "ลด", "เหลือ", "ใช้", "พร้อม", "ส่ง",
                             "ศูนย์", "ไทย", "เดือน", "ปี", "วัน", "ชั่วโมง", "GB", "RAM", "ROM",
                             "สินค้า", "รับประกัน", "ประกัน", "เคลม", "รบกวน", "แจ้ง"}
                    for brand_part, model_part in _model_patterns:
                        if brand_part.lower() in _stop:
                            continue
                        if not re.search(r"\d", model_part):
                            continue
                        if re.fullmatch(r"\d+", model_part):
                            continue
                        _valid_models.append(f"{brand_part} {model_part}")
                if _valid_models:
                    # ดึงสินค้าจาก DB ด้วย model name (ignore status — อาจเป็น SELLER_DELETE)
                    _model_query = _valid_models[0]
                    print(f"[WARRANTY-DBG] _valid_models={_valid_models}  query={_model_query!r}", file=sys.stderr)
                    try:
                        _w_docs = list(db[os.environ.get("MONGO_COLLECTION", "ShpProducts")].find(
                            {
                                "item_name": {"$regex": re.escape(_model_query), "$options": "i"},
                                **({"shopname": {"$regex": f"^{re.escape(req.shop)}$", "$options": "i"}} if req.shop else {}),
                            },
                            {"item_name": 1, "item_status": 1, "shopname": 1, "attribute_list": 1, "_id": 0},
                        ).limit(3))
                    except Exception as _e:
                        print(f"[WARRANTY-DBG] DB error: {_e}", file=sys.stderr)
                        _w_docs = []
                    print(f"[WARRANTY-DBG] docs found: {len(_w_docs)}", file=sys.stderr)
                    # ดึง warranty จากสินค้าแรกที่เจอ
                    _warranty_months = None
                    _warranty_text = ""
                    _product_name = ""
                    for _wd in _w_docs:
                        _wi = product_store._warranty_info(_wd)
                        _dur = _wi.get("duration_months") or ""
                        print(f"[WARRANTY-DBG]   {_wd.get('item_status','?'):15} dur={_dur!r} wi={_wi}", file=sys.stderr)
                        if _dur.isdigit():
                            _warranty_months = int(_dur)
                            _warranty_text = _wi.get("duration", "")
                            _product_name = (_wd.get("item_name") or "")[:80]
                            break
                    if _warranty_months and _product_name:
                        _calc = warranty.is_in_warranty(_purchase_date, _warranty_months)
                        _warranty_date_followup = True
                        # สร้างคำตอบ deterministic แทน LLM เพื่อความชัดเจน
                        if _calc["in_warranty"]:
                            _warranty_claim_answer = (
                                f"ตรวจสอบข้อมูลเรียบร้อยแล้วค่ะ สินค้า {_product_name} "
                                f"ที่ซื้อเมื่อวันที่ {_purchase_date.strftime('%d/%m/%Y')} "
                                f"ยังอยู่ในช่วงรับประกันนะคะ {_calc['text']} "
                                f"(วันที่ประกันหมด: {_calc['expiry_date'].strftime('%d/%m/%Y')})\n\n"
                                f"เพื่อดำเนินการเคลม/ซ่อมต่อ รบกวนแจ้งข้อมูลดังนี้ค่ะ:\n"
                                f"• ชื่อ-นามสกุล\n"
                                f"• เบอร์โทร\n\n"
                                f"จากนั้นเดี๋ยว {_bot_name} จะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
                            )
                        else:
                            _warranty_claim_answer = (
                                f"ตรวจสอบข้อมูลเรียบร้อยแล้วค่ะ สินค้า {_product_name} "
                                f"ที่ซื้อเมื่อวันที่ {_purchase_date.strftime('%d/%m/%Y')} "
                                f"ไม่อยู่ในช่วงประกันแล้วนะคะ {_calc['text']} "
                                f"(วันที่ประกันหมด: {_calc['expiry_date'].strftime('%d/%m/%Y')})\n\n"
                                f"สนใจปรึกษาแอดมินก่อนไหมคะ"
                            )
                        print(
                            f"[WARRANTY-DATE] follow-up: model={_model_query!r} "
                            f"purchase={_purchase_date.date()} warranty={_warranty_months}m "
                            f"in_warranty={_calc['in_warranty']} days_left={_calc['days_remaining']}",
                            file=sys.stderr,
                        )

    # ถ้าเป็น warranty date follow-up → ใช้ deterministic answer (ไม่เรียก LLM)
    # เพื่อความชัดเจนของ flow: ในช่วงประกัน → ถาม info, นอกช่วง → ถามสนใจปรึกษาแอดมิน
    if _warranty_date_followup and _warranty_claim_answer:
        _total_elapsed = _time.time() - _total_start

        print(f"[TIMING] WARRANTY-DATE: {_total_elapsed:.2f}s", file=sys.stderr)
        return dict(
            answer=_warranty_claim_answer,
            answer_segments=llm.split_segments(_warranty_claim_answer),
            products=[],
            shop=req.shop,
            model=model_name,
            source="warranty_date_followup",
            usage={},
            elapsed=round(_total_elapsed, 2),
            cost=0.0,
            steps=_steps,
            routing_decision=_app_module._routing("bot_reply", "warranty_date_followup: คำนวณวันหมดประกัน"),
            image_desc=_image_desc_out,
        )

    # ===== Tax invoice follow-up from history =====
    # canonical owner: _handle_tax_invoice_followup — transport/result/flag/answer เดียวกัน
    if history and not _is_tax_invoice and not _is_claim_request:
        _tax_resp = _handle_tax_invoice_followup(req, ctx, history, warranty, _app_module, llm)
        if _tax_resp:
            return _tax_resp

    # ===== Deterministic warranty answer จาก delivery-date auto-check =====
    # ⚡ Warranty-Delivery — ถ้าเช็คจาก delivery date ได้ผลชัดเจน → ตอบเลย ไม่เข้า LLM
    #    กรณี: ยังไม่ส่งมอบ / อยู่ในช่วงประกัน / หมดช่วงประกัน / multi-item ambiguity
    if _warranty_auto_answer:
        _total_elapsed = _time.time() - _total_start
        print(f"[WARRANTY-AUTO] deterministic answer → return (delivery-date based)", file=sys.stderr)
        return dict(
            answer=_warranty_auto_answer,
            products=[],
            usage={},
            elapsed=round(_total_elapsed, 2),
            cost=0.0,
            timing=_timing_breakdown,
            steps=_steps,
            routing_decision=_app_module._routing(
                "deterministic",
                "warranty_auto_check: delivery-date based → ตอบเลย",
                handoff_reason=None,
            ),
            image_desc=_image_desc_out,
        )

    # ===== Claim request ที่ state machine ไม่ได้จัดการ (first message, ไม่มี history) =====
    # ถ้าเป็น claim request แต่ state machine ไม่ได้ตอบ (ไม่มี history) → ตอบเลย ห้ามแนะนำสินค้า
    # ⚡ handoff ทันที — บอทขอข้อมูลเบื้องต้นทิ้งไว้ แอดมินมาอ่านแชทต่อ
    if _is_claim_request and not _warranty_claim_answer:
        _total_elapsed = _time.time() - _total_start

        # ⚡ Task 5C-F — malfunction claim ต้อง acknowledge + safe checks ก่อน
        #   ขอข้อมูลเคลม (QA tips ถ้ามีจะชนะ — return ก่อนถึงข้อความนี้)
        _claim_first_answer = (
            warranty.malfunction_safe_check(req.message)
            + f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
            f"• วันที่ซื้อสินค้า\n"
            f"• เลขที่คำสั่งซื้อ\n"
            f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
            f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
            f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
            f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ {_bot_name} จะตรวจสอบและประสานงานต่อให้ค่ะ"
        )
        # ⚡ QA-KB troubleshoot-first — ถ้ามีวิธีแก้เบื้องต้นที่ตรงรุ่น/สินค้า
        #    → แนะนำก่อน ยังไม่ขอข้อมูลเคลม/ไม่ handoff
        #    ลูกค้าตอบ "ไม่หาย/ไม่ได้" → state machine (ts_suggested) เข้า claim info
        try:
            from . import knowledge_base as _kbmod
            _tips = _kbmod.qa_troubleshoot_tips(
                req.message, conversation_id=req.conversation_id,
                item_id=req.item_id)
            if _tips:
                _ts_lines = "\n".join(f"• {t}" for t in _tips)
                _ts_answer = (
                    f"เบื้องต้นลองทำตามนี้ก่อนนะคะ:\n{_ts_lines}\n\n"
                    f"ถ้าลองแล้วยังไม่หาย แจ้ง{_bot_name}ได้เลยค่ะ "
                    f"เดี๋ยวช่วยตรวจสอบเรื่องเคลม/รับประกันให้นะคะ")
                # ⚡ 2B.4 — troubleshoot-first ตอบ explicit claim request → episode
                #   ใหม่ที่ stage ts_suggested ผ่าน owner (fresh path เดียวกัน)
                _claim_state = _claim_transition(req, _claim_state, "ts_suggested", fresh_claim=True)
                print("[QA-KB] troubleshoot-first: แนะนำวิธีแก้ ยังไม่ handoff", file=sys.stderr)
                _total_elapsed = _time.time() - _total_start
                return dict(
                    answer=_ts_answer,
                    answer_segments=llm.split_segments(_ts_answer),
                    products=[],
                    shop=req.shop,
                    model=model_name,
                    source="warranty_troubleshoot",
                    usage={},
                    elapsed=round(_total_elapsed, 2),
                    cost=0.0,
                    timing=_timing_breakdown,
                    steps=_steps,
                    routing_decision=_app_module._routing(
                        "bot_reply",
                        "warranty_claim: troubleshoot-first (QA tips) — ยังไม่ handoff",
                    ),
                    image_desc=_image_desc_out,
                )
        except Exception as _qa_exc:
            print(f"[QA-KB] troubleshoot-first error: {_qa_exc}", file=sys.stderr)
        # ⚡ Phase 1C — ถ้ามี warranty auto-check context (เช็คจาก order_sn แล้ว) → แนบ
        if _warranty_auto_ctx:
            _claim_first_answer = f"{_warranty_auto_ctx}\n\n{_claim_first_answer}"
            print(f"[WARRANTY-AUTO] แนบ auto-check context ใน first-message claim answer", file=sys.stderr)
        print(f"[WARRANTY-CLAIM] first-message claim request → ask info + handoff immediately", file=sys.stderr)

        # ⚡ 2B.4 — explicit fresh claim request → episode ใหม่เมื่อ absent/terminal
        #   ผ่าน transition owner เดียว (open → episode เดิม)
        _claim_state = _claim_transition(req, _claim_state, "collecting", fresh_claim=True)

        # ⚡ handoff ทันที — canonical builder เป็น owner เดียวของ transport/result/flag/answer
        return _build_warranty_claim_response(
            req, ctx, _claim_first_answer, True,
            {"claim_topic": "เคลม/ซ่อม/ประกันสินค้า", "handoff_reason": "claim"},
            _app_module, llm, source="warranty_claim_first_message",
            claim_state=_claim_state,
        )
