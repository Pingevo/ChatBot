"""chat_v2 — Pipeline ใหม่ สะอาด ชัดเจน แก้ง่าย.

แทนที่ chat() เดิมที่ 5000+ บรรทัด ด้วย pipeline 7 stages:
  1. _build_context()       — setup + history + persona + vision
  2. _check_deterministic() — order/tracking/warranty/tax/human (เก็บเดิม)
  3. _classify_intent()     — LLM เป็นหลัก ไม่ใช่ hardcode keyword
  4. _detect_anchor()        — เก็บข้อมูลครบ (type, subtype, desc)
  5. _retrieve_products()   — RAG (KB + DB) ไม่กรอง sold_out
  6. _search_if_needed()    — search → RAG → LLM2 (ไม่ตอบตรง)
  7. _no_product_guard()    — ด่านสุดท้าย หลัง search แล้วยังไม่เจอ
  8. _build_answer()        — LLM2 ตอบ

กฎสำคัญ:
- แนะนำขายเฉพาะ normal + stock>0 (LLM prompt กรอง ไม่กรองใน RAG)
- ตอบเคลม/ใบกำกับ/ประกัน (deterministic flow เก็บไว้)
- ห้ามบอกไม่มีข้อมูล → search (NO-PRODUCT-GUARD ย้ายไปหลัง search)
- search สกัด keywords + spec → RAG → LLM2 (ไม่ตอบตรง)
- RAG ไม่ตัด non-normal (ลูกค้าถามสินค้าเก่าได้)
- ห้ามกุคำตอบ / ห้าม external URL / ห้ามแนะนำตอนเคลม
"""
from __future__ import annotations

import os
import re
import sys
import time as _time
from typing import Any

from fastapi import HTTPException

# ⚡ chat_v2 imports — ใช้ module ที่มีอยู่แล้ว ไม่สร้างใหม่
from . import (
    app as _app_module,
    conversation_products as _cp,
    intent_classifier as _ic,
    knowledge_base,
    llm,
    order_store as _order_store,
    persona,
    product_store,
    web_search as _ws,
)


# ── Robust Extraction Helpers ────────────────────────────────────────────────
# สกัดข้อมูลจาก message/history อย่างถูกต้อง — รองรับทุก format

# Pattern สำหรับสกัด item_id จาก [สินค้า: XXX]
_ITEM_TAG_RE = re.compile(r"\[สินค้า:\s*(\d+)\]")
# Pattern สำหรับสกัด order_sn จาก [order: XXX]
_ORDER_TAG_RE = re.compile(r"\[order:\s*([^\]]+)\]")
# Pattern สำหรับสกัด image/video placeholder
_IMAGE_PLACEHOLDER_RE = re.compile(
    r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]",
    re.IGNORECASE,
)
# Pattern สำหรับสกัด tracking number
_TRACKING_RE = re.compile(r"\b([A-Z]{2,4}\d{8,20})\b")


def _extract_item_id(message: str | None) -> str:
    """สกัด item_id จาก [สินค้า: XXX] tag ใน message."""
    if not message:
        return ""
    _m = _ITEM_TAG_RE.search(message)
    return _m.group(1) if _m else ""


def _extract_order_sn(message: str | None) -> str:
    """สกัด order_sn จาก [order: XXX] tag หรือ pattern อื่น."""
    if not message:
        return ""
    _m = _ORDER_TAG_RE.search(message)
    if _m:
        return _m.group(1).strip()
    # fallback: ใช้ order_store helper
    return _order_store.extract_order_sn(message) or ""


def _extract_tracking(message: str | None) -> str:
    """สกัด tracking number จาก message."""
    if not message:
        return ""
    return _order_store.extract_tracking_number(message) or ""


def _has_image_placeholder(message: str | None) -> bool:
    """ตรวจว่า message มี image/video placeholder ไหม."""
    if not message:
        return False
    return bool(_IMAGE_PLACEHOLDER_RE.search(message))


def _is_image_only(message: str | None) -> bool:
    """ตรวจว่า message เป็นแค่ image/video placeholder ไหม (ไม่มี text อื่น)."""
    if not message:
        return False
    _clean = _IMAGE_PLACEHOLDER_RE.sub("", message).strip()
    return not _clean


def _extract_product_subtype(message: str | None) -> str:
    """สกัด charger subtype จาก message — ใช้ helper ที่มีแล้ว."""
    if not message:
        return ""
    return product_store._detect_charger_subtype(message) or ""


def _extract_product_types(message: str | None) -> set[str]:
    """สกัด product types จาก message — ใช้ helper ที่มีแล้ว."""
    if not message:
        return set()
    _types = product_store._detect_product_types(message)
    if not _types:
        _types = product_store._detect_product_types_fuzzy(message)
    return _types or set()


# ── Superlative / Multi-use-case / Charging Spec Detection ───────────────────
# ย้ายจาก legacy app.py บรรทัด 2525-2532, 3097-3110, 4129-4141

# Superlative keywords (จาก legacy app.py บรรทัด 2527-2531)
_SUPERLATIVE_KW = (
    "สุด", "ที่สุด", "แรงสุด", "ไวสุด", "เร็วสุด", "มากสุด", "น้อยสุด",
    "แรงที่สุด", "ไวที่สุด", "เร็วที่สุด", "มากที่สุด", "น้อยที่สุด",
    "เบาสุด", "จุมากสุด", "คุ้มสุด", "คุ้มที่สุด",
    "กว่านี้", "เร็วกว่า", "แรงกว่า", "ไวกว่า", "ดีกว่า", "มากกว่า",
    "ไวๆ", "เร็วๆ", "แรงๆ", "ชาร์จไว", "ชาร์จเร็ว",
)

# Charging spec keywords (จาก legacy app.py บรรทัด 4130-4139)
_CHARGING_SPEC_KW = (
    "ใช้สายชาร์จอะไร", "ใช้สายอะไรชาร์จ", "ใช้สายอะไร",
    "ชาร์จยังไง", "ชาร์จอะไร", "ชาร์จ type c", "ชาร์จ type-c",
    "ชาร์จได้ไหม", "ชาร์จกี่วัต", "ชาร์จกี่แอม", "ชาร์จกี่w",
    "พอร์ตอะไร", "พอร์ตชาร์จ", "พอร์ตไหน",
    "wireless ได้ไหม", "ชาร์จไร้สาย", "ชาร์จไม่ต้องเสียบ",
    "ใช้สาย c to c", "ใช้สาย c to a", "ใช้สาย usb",
    "ชาร์จเร็วไหม", "ชาร์จเร็วกี่", "แทนอันเดิม", "แทนของเดิม",
    "สายชาร์จเดิม", "สายเดิมเสีย", "สายชาร์จใหม่",
    "ใช้สายชาร์จแบบไหน", "สายชาร์จแบบไหน",
)

# Multi-use-case keywords — ลูกค้าต้องการสินค้าที่ใช้ได้หลาย场景
# ⚡ ตัด "ชาร์จ" ออกจาก features ของ "ในรถ" เพราะ "หัวชาร์จในรถ" เป็น car_charger subtype
#    ไม่ใช่ multi-usecase (สินค้า type เดียว)
_MULTI_USECASE_KW = (
    # กีฬา + ฟังก์ชัน
    ("วิ่ง", ("anc", "noise cancel", "เกร่อย")),
    ("ออกกำลังกาย", ("กันน้ำ", "หนัก", "เบา")),
    # รถ + ฟังก์ชัน (ไม่รวม "ชาร์จ" เพราะเป็น car_charger subtype)
    ("ในรถ", ("แม่เหล็ก", "ดูด", "จอ")),
    ("มอเตอร์ไซค์", ("กันน้ำ", "แม่เหล็ก")),
    ("รถยนต์", ("แม่เหล็ก", "จอ")),
    # ท่องเที่ยว
    ("เที่ยว", ("พับได้", "เบา", "พกพา")),
    ("เดินทาง", ("พับได้", "เบา", "พกพา")),
    # ทำงาน + ฟังก์ชัน
    ("ทำงาน", ("ไมโครโฟน", "microphone", "mic", "โทรศัพท์")),
    ("ประชุม", ("ไมโครโฟน", "microphone", "mic")),
    # นอน + ฟังก์ชัน
    ("นอน", ("กันเสียง", "anc", "สบาย")),
    # เล่นเกม + ฟังก์ชัน
    ("เล่นเกม", ("latency", "ดีเลย์ต่ำ", "เสียงชัด")),
    ("gaming", ("latency", "ดีเลย์ต่ำ", "เสียงชัด")),
)


def _is_superlative_question(message: str | None) -> bool:
    """ตรวจว่า message เป็น superlative question ไหม.

    Superlative = ลูกค้าอยากได้สินค้าที่ "สุด" ในบาง aspect
    เช่น "แรงสุด", "ไวสุด", "ดีสุด", "เบาสุด", "คุ้มสุด"

    ถ้าเป็น superlative → ต้องดึงสินค้าเยอะขึ้น (limit * 5) เพื่อให้ LLM เปรียบเทียบได้
    """
    if not message:
        return False
    _msg_lower = message.lower()
    return any(kw in _msg_lower for kw in _SUPERLATIVE_KW)


def _is_charging_spec_question(message: str | None) -> bool:
    """ตรวจว่า message เป็น charging spec question ไหม.

    Charging spec = ลูกค้าถามว่าสินค้า X ชาร์จยังไง/ใช้สายอะไร/พอร์ตอะไร
    ไม่ใช่ถามหาสินค้า charger — ต้องดึงสินค้า X มาตอบ ไม่ใช่ดึง charger มาขาย

    เช่น "biokoop ใช้สายชาร์จอะไร", "iphone 13 ชาร์จกี่w"
    """
    if not message:
        return False
    _msg_lower = message.lower()
    return any(kw in _msg_lower for kw in _CHARGING_SPEC_KW)


def _detect_multi_usecase(message: str | None) -> list[str]:
    """ตรวจว่า message เป็น multi-use-case question ไหม.

    Multi-use-case = ลูกค้าต้องการสินค้าที่ใช้ได้ในหลาย场景
    เช่น "วิ่ง + ANC", "ในรถ + ชาร์จ", "เที่ยว + พับได้"

    คืน list ของ use-case strings ที่ตรง (เช่น ["วิ่ง+ANC", "ในรถ+ชาร์จ"])
    ถ้าไม่ใช่ multi-use-case → คืน []
    """
    if not message:
        return []
    _msg_lower = message.lower()
    _usecases: list[str] = []
    for _scenario, _features in _MULTI_USECASE_KW:
        if _scenario in _msg_lower:
            for _feat in _features:
                if _feat in _msg_lower:
                    _usecases.append(f"{_scenario}+{_feat}")
                    break
    return _usecases


def _extract_wattage(message: str | None) -> int:
    """สกัด wattage จาก message (เช่น "65w", "100w", "90 วัตต์").

    คืน wattage เป็น int (0 ถ้าไม่เจอ)
    """
    if not message:
        return 0
    _m = re.search(r"(\d+)\s*[wW](?:att|attage|atts)?\b", message)
    if _m:
        return int(_m.group(1))
    _m = re.search(r"(\d+)\s*วัตต์", message)
    if _m:
        return int(_m.group(1))
    return 0


def _adjust_fetch_limit_for_superlative(fetch_limit: int, message: str,
                                          intent: dict, history: list[dict]) -> int:
    """ปรับ fetch_limit สำหรับ superlative question.

    ถ้าเป็น superlative → ดึงสินค้าเยอะขึ้น (limit * 5, สูงสุด 50)
    เพื่อให้ LLM เห็นทุกรุ่นแล้วเปรียบเทียบหาอันที่สุดจริง

    ถ้าเป็น superlative + "ชาร์จ" ที่ไม่มี history → ดึงทั้ง charger และ powerbank
    เพราะ "ชาร์จไวสุด" อาจหมายถึง หัวชาร์จ สายชาร์จ หรือพาวเวอร์แบงค์
    """
    if not _is_superlative_question(message):
        return fetch_limit
    _new_limit = max(fetch_limit * 5, 50)
    print(f"[SUPERLATIVE-V2] fetch_limit {fetch_limit} → {_new_limit}", file=sys.stderr)
    return _new_limit


def _augment_retrieval_for_superlative(retrieval_msg: str, message: str,
                                         history: list[dict]) -> str:
    """เพิ่ม keywords ใน retrieval message สำหรับ superlative + "ชาร์จ".

    ถ้าเป็น superlative + "ชาร์จ" ที่ไม่มี history → เพิ่ม "พาวเวอร์แบงค์ แบตสำรอง"
    เพื่อให้ดึง powerbank ด้วย (ไม่คิดแทนลูกค้า — ดึงทั้งหมดแล้วให้ LLM ตอบ)
    """
    if not _is_superlative_question(message):
        return retrieval_msg
    _has_charge = "ชาร์จ" in message or "charger" in message.lower()
    _has_pb = "พาวเวอร์แบงค์" in message or "แบตสำรอง" in message or "powerbank" in message.lower()
    _has_history = bool(history and any(
        (h.get("text") or "").strip() for h in history if h.get("role") == "user"
    ))
    if _has_charge and not _has_pb and not _has_history:
        retrieval_msg = f"พาวเวอร์แบงค์ แบตสำรอง {retrieval_msg}"
        print(f"[SUPERLATIVE-CHARGE-V2] เพิ่ม powerbank ใน retrieval: {retrieval_msg!r}", file=sys.stderr)
    return retrieval_msg


# ── Stage 1: Build Context ─────────────────────────────────────────────────

def _build_context(req) -> tuple[dict, list[dict], Any, Any]:
    """Stage 1: setup + history + persona + vision.

    คืน (ctx_dict, history, client, db) — ctx_dict เก็บค่าที่ใช้ต่อทั้ง pipeline
    ไม่ mutate shared state ทุกอย่างอยู่ใน ctx_dict
    """
    from .chat_models import ContextData, HistoryEntry

    _total_start = _time.time()
    _steps: list[dict] = []
    _timing: dict[str, float] = {}

    # 1.1 DB
    client, db = _app_module._db()

    # 1.2 History → list[dict] (legacy format สำหรับ helper เดิม)
    history = [
        {"role": m.role, "text": m.text, "images": m.images, "image_desc": m.image_desc}
        for m in req.history
    ]

    # record history step
    _steps.append({
        "name": "history",
        "model": None,
        "tokens_in": 0, "tokens_out": 0, "time_s": 0,
        "cost_usd": 0, "cost_thb": 0,
        "input": {
            "history_count": len(history),
            "history_preview": [
                {"role": h.get("role"), "text": (h.get("text") or "")[:120],
                 "has_images": bool(h.get("images")),
                 "has_image_desc": bool(h.get("image_desc"))}
                for h in history[-10:]
            ],
        },
        "output": None,
    })

    # 1.3 Persona
    _persona_doc = persona.get_persona(req.shop, platform="shopee")
    _persona_extra = persona.build_persona_instruction(_persona_doc, req.shop)
    _bot_name = ((_persona_doc or {}).get("bot_name") or "เรา").strip() or "เรา"

    # 1.4 Vision pass (ย้ายจาก legacy บรรทัด 472-578)
    _vision_context, _vision_usage, _image_desc_out = _run_vision(req, history, _steps, _timing)

    ctx = {
        "shop": req.shop,
        "platform": req.platform or "shopee",
        "conversation_id": req.conversation_id,
        "history": history,
        "persona_extra": _persona_extra,
        "bot_name": _bot_name,
        "vision_context": _vision_context,
        "vision_usage": _vision_usage,
        "image_desc_out": _image_desc_out,
        "steps": _steps,
        "timing": _timing,
        "total_start": _total_start,
        "limit": req.limit,
        "ticket_state": req.ticket_state,
        "simulate_assignment": req.simulate_assignment,
    }
    return ctx, history, client, db


def _run_vision(req, history: list[dict], _steps: list[dict], _timing: dict) -> tuple[str, dict, str]:
    """Vision pass — ย้ายจาก legacy บรรทัด 472-578."""
    _vision_context = ""
    _vision_usage = {"prompt": 0, "output": 0, "total": 0}
    _vision_desc_parts: list[str] = []
    _image_desc_out = ""

    # history context ส่งให้ vision
    _history_ctx_for_vision = ""
    if history:
        _hist_lines = []
        for h in history[-6:]:
            _h_role = "ลูกค้า" if h.get("role") == "user" else "บอท"
            _h_text = h.get("text", "")[:100]
            if _h_text:
                _hist_lines.append(f"{_h_role}: {_h_text}")
            _h_desc = h.get("image_desc", "")
            if _h_desc:
                _vision_desc_parts.append(f"[รูปเก่าจาก history] {_h_desc}")
        _history_ctx_for_vision = "\n".join(_hist_lines)

    # URLs ที่ต้องอ่านใหม่
    _urls_to_read: list[str] = []
    if history:
        for h in history[-2:]:
            _h_imgs = h.get("images") or []
            _h_desc = h.get("image_desc") or ""
            if _h_imgs and not _h_desc:
                _urls_to_read.extend(_h_imgs)
    _urls_to_read.extend(req.images or [])

    if _urls_to_read:
        try:
            from . import llm as _llm_vision
            _max_imgs = int(os.environ.get("BOT_MAX_IMAGES_PER_TURN", "5"))
            _new_desc, _vision_usage = _llm_vision.describe_images(
                _urls_to_read,
                shop_hint=req.shop,
                max_images=_max_imgs,
                history_context=_history_ctx_for_vision,
            )
            if _new_desc:
                _vision_desc_parts.append(_new_desc)
        except Exception as _ve:
            print(f"[VISION-PASS] error: {_ve}", file=sys.stderr)

    if _vision_desc_parts:
        _all_desc = "\n".join(_vision_desc_parts)
        _vision_context = (
            f"=== รูปภาพที่ลูกค้าส่งมา ===\n{_all_desc}\n"
            f"⚠️ สำคัญ: ลูกค้าส่งรูปนี้มาเพราะสนใจสินค้า/เรื่องในรูป "
            f"ถ้ารูปเป็นสินค้า → ตอบเกี่ยวกับสินค้านั้น "
            f"ถ้ารูปเป็นเลขพัสดุ → ตอบเกี่ยวกับสถานะ "
            f"ถ้ารูปเป็นสินค้าเสีย **และลูกค้าบอกชัดว่าเคลม** → ถามรายละเอียดเพื่อเคลม "
            f"ห้ามตีว่ารูปเป็น claim ถ้าลูกค้าไม่ได้พิมพ์บอก\n"
        )
        _image_desc_out = _new_desc if _urls_to_read and _new_desc else ""

    # record vision step
    _vision_model = os.environ.get("GEMINI_VISION_MODEL", "gemini-3.1-flash-lite")
    _vision_prompt_t = _vision_usage.get("prompt", 0)
    _vision_output_t = _vision_usage.get("output", 0)
    _vision_cost = (_vision_prompt_t * 0.25 + _vision_output_t * 0.50) / 1_000_000
    _steps.append({
        "name": "vision",
        "model": _vision_model if _urls_to_read else None,
        "tokens_in": _vision_prompt_t, "tokens_out": _vision_output_t,
        "time_s": round(_timing.get("vision", 0), 2),
        "cost_usd": round(_vision_cost, 6), "cost_thb": round(_vision_cost * 36, 2),
        "input": {
            "urls_to_read": _urls_to_read,
            "history_images": [h.get("images") for h in (history or [])[-2:] if h.get("images")],
            "history_context_for_vision": _history_ctx_for_vision[:500] if _history_ctx_for_vision else "",
            "cached_desc_from_history": [d for d in _vision_desc_parts if d.startswith("[รูปเก่าจาก history]")],
        },
        "output": {
            "new_description": _image_desc_out[:500] if _image_desc_out else "",
            "all_descriptions": _vision_desc_parts,
            "vision_context_length": len(_vision_context),
        },
    })
    return _vision_context, _vision_usage, _image_desc_out


# ── Stage 2: Deterministic Fast Paths ────────────────────────────────────────

def _check_deterministic(req, ctx: dict, history: list[dict], db) -> dict | None:
    """Stage 2: deterministic flows ที่ตอบก่อนเข้า pipeline หลัก.

    รวม: order lookup, tracking lookup, tax invoice handoff, human request handoff,
         warranty state machine, brand question, general question (policy/brands/categories)

    คืน ChatResponse dict ถ้าจับเคสได้ หรือ None ถ้าต้องไป pipeline หลัก
    """
    # ⚡ ย้าย logic จาก legacy บรรทัด 758-2440 มาเป็น helper
    #    เก็บ logic เดิมไว้ ไม่แก้ เพราะ deterministic flow ทำงานถูกแล้ว
    #    แค่ย้ายมาเป็น function แยก ไม่ mutate shared state
    from . import warranty as _warranty_mod

    # 2.1 Order lookup
    _resp = _check_order_lookup(req, ctx, history, db)
    if _resp:
        return _resp

    # 2.2 Tracking lookup
    _resp = _check_tracking_lookup(req, ctx, history, db)
    if _resp:
        return _resp

    # 2.3 Tax invoice handoff
    _resp = _check_tax_invoice(req, ctx)
    if _resp:
        return _resp

    # 2.4 Human request handoff
    _resp = _check_human_request(req, ctx)
    if _resp:
        return _resp

    # 2.5 Warranty state machine
    _resp = _check_warranty_state_machine(req, ctx, history, db)
    if _resp:
        return _resp

    # 2.6 General question (policy/brands/categories)
    _resp = _check_general_question(req, ctx, history, db)
    if _resp:
        return _resp

    # 2.7 Brand question
    _resp = _check_brand_question(req, ctx, history, db)
    if _resp:
        return _resp

    return None


def _check_order_lookup(req, ctx, history, db) -> dict | None:
    """Order lookup — ย้ายจาก legacy บรรทัด 758-999."""
    _order_sn = req.order_sn
    if not _order_sn:
        from . import order_store as _os
        _order_sn = _os.extract_order_sn(req.message)
    if not _order_sn and req.conversation_id:
        from . import conversation_products as _cp_order
        if _cp_order.is_order_question(req.message):
            _anchor_sn = _cp_order.resolve_active_order_sn(req.conversation_id, req.message)
            if _anchor_sn:
                _order_sn = _anchor_sn
    if not _order_sn:
        return None

    _order_info = _order_store.lookup_order(_order_sn, shop_filter=req.shop)
    if not _order_info:
        _answer = (
            f"ขออภัยค่ะ ไม่พบข้อมูลคำสั่งซื้อเลข {_order_sn} ในระบบ "
            f"อาจเป็นคำสั่งซื้อจากร้านอื่น หรือเลขคำสั่งซื้อไม่ถูกต้อง "
            f"รบกวนตรวจสอบอีกครั้ง หรือทักแอดมินได้นะคะ"
        )
        return _make_response(_answer, [], ctx, source="order_lookup",
                              routing=_app_module._routing("bot_reply", f"order_lookup: {_order_sn} not found"))

    _order_ctx = _order_store.build_order_context(_order_info)
    if req.conversation_id:
        try:
            from . import conversation_products as _cp_save
            _cp_save.add_order_anchor(
                conversation_id=req.conversation_id,
                platform=req.platform or "shopee",
                shop=req.shop,
                order_sn=_order_sn,
                order_info=_order_info,
            )
        except Exception as _e:
            print(f"[ORDER] anchor save failed: {_e}", file=sys.stderr)

    _order_msg = _order_store._ORDER_TAG_RE.sub("", req.message).strip() if _order_store._ORDER_TAG_RE.search(req.message) else req.message
    _order_clean = re.sub(r"(?:เลข)?คำสั่งซื้อ\s*" + re.escape(_order_sn), "", _order_msg, flags=re.IGNORECASE).strip()
    _order_clean = _order_clean.replace(_order_sn, "").strip()
    if not _order_clean:
        _order_clean = "ลูกค้าส่งเลขคำสั่งซื้อมา ต้องการดูสถานะและรายละเอียดสินค้าในคำสั่งซื้อนี้"
    try:
        _answer, _usage = llm.answer_general(
            message=_order_clean, context=_order_ctx, qtype="order_status",
            history=history, persona_extra=ctx["persona_extra"],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return _make_response(_answer, [], ctx, source="order_lookup", usage=_usage,
                          routing=_app_module._routing("bot_reply", f"order_lookup: {_order_sn}"))


def _check_tracking_lookup(req, ctx, history, db) -> dict | None:
    """Tracking lookup — ย้ายจาก legacy บรรทัด 797-859."""
    _tracking_no = _order_store.extract_tracking_number(req.message)
    if not _tracking_no and ctx["vision_context"]:
        _tracking_no = _order_store.extract_tracking_number(ctx["vision_context"])
    if not _tracking_no:
        return None
    _tracking_order = _order_store.lookup_by_tracking(_tracking_no, shop_filter=req.shop)
    if not _tracking_order:
        return None
    _order_ctx = _order_store.build_order_context(_tracking_order)
    _tracking_clean = re.sub(re.escape(_tracking_no), "", req.message, flags=re.IGNORECASE).strip()
    if not _tracking_clean:
        _tracking_clean = "ลูกค้าส่งเลขพัสดุมา ต้องการดูสถานะการจัดส่ง"
    try:
        _answer, _usage = llm.answer_general(
            message=_tracking_clean, context=_order_ctx, qtype="order_status",
            history=history, persona_extra=ctx["persona_extra"],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return _make_response(_answer, [], ctx, source="tracking_lookup", usage=_usage,
                          routing=_app_module._routing("bot_reply", f"tracking_lookup: {_tracking_no}"))


def _check_tax_invoice(req, ctx) -> dict | None:
    """Tax invoice handoff — ย้ายจาก legacy บรรทัด 1029-1095."""
    from . import warranty as _w
    if not _w.detect_tax_invoice_request(req.message):
        return None
    _answer = (
        f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
        f"เพื่อดำเนินการเรื่องใบกำกับภาษีให้นะคะ "
        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
    )
    _app_module._send_handoff(req, ctx, reason="tax_invoice_request", claim_topic="ใบกำกับภาษี")
    return _make_response(_answer, [], ctx, source="tax_invoice_handoff",
                          handoff=True, handoff_reason="tax_invoice_request",
                          routing=_app_module._routing("handoff", "tax_invoice: ส่งแอดมิน", handoff_reason="tax_invoice_request"))


def _check_human_request(req, ctx) -> dict | None:
    """Human request handoff — ย้ายจาก legacy บรรทัด 1097-1172."""
    _HUMAN_KWS = (
        "ขอคุยกับคน", "ขอคุยกับแอดมิน", "ขอแอดมิน", "ขอคน", "มีคนตอบไหม",
        "มีคนไหม", "มีมนุษย์ไหม", "มนุษย์ตอบ", "มนุษย์มาตอบ", "คนตอบหน่อย",
        "admin มา", "admin ตอบ", "แอดมินมา", "แอดมินตอบ", "แอดมินไม่ทำงาน",
        "ไม่มีคนตอบ", "ไม่มีแอดมิน", "เมื่อไหร่จะมีคน", "เมื่อไหร่จะมีแอดมิน",
        "เมื่อไหร่จะมีมนุษย์", "อยากคุยกับคน", "อยากคุยกับแอดมิน",
        "ให้คนตอบ", "ให้แอดมินตอบ", "ติดต่อแอดมิน", "ติดต่อคน",
        "พูดกับคน", "พูดกับแอดมิน", "ส่งต่อแอดมิน", "ส่งต่อคน",
    )
    _msg_low = (req.message or "").lower().replace("ำ", "ัม")
    if not any(kw in _msg_low for kw in _HUMAN_KWS):
        return None
    _answer = (
        f"ขออภัยที่ให้รอนะคะ เดี๋ยวส่งต่อแชทนี้ให้แอดมินดูแลให้นะคะ "
        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
    )
    _app_module._send_handoff(req, ctx, reason="human_request", claim_topic="ลูกค้าขอคุยกับแอดมิน")
    return _make_response(_answer, [], ctx, source="human_request_handoff",
                          handoff=True, handoff_reason="human_request",
                          routing=_app_module._routing("handoff", "human_request: ส่งแอดมิน", handoff_reason="human_request"))


def _check_warranty_state_machine(req, ctx, history, db) -> dict | None:
    """Warranty state machine — ย้ายจาก legacy บรรทัด 1408-2400.

    ⚡ เรียก warranty_flow.handle_warranty_flow() ที่ห่อ logic เดิมไว้
    คืน ChatResponse dict ถ้าจับ warranty flow ได้ หรือ None ถ้าไม่ใช่

    Note: รับ db เป็น parameter แทนที่จะสร้าง client เอง — เพราะ get_client()
    คืน singleton cached client ถ้า close แล้วจะกระทบ context หลัก
    """
    from . import warranty_flow as _wf
    return _wf.handle_warranty_flow(req, ctx, history, db)


def _check_general_question(req, ctx, history, db) -> dict | None:
    """General question (policy/brands/categories) — ย้ายจาก legacy บรรทัด 1001-1029."""
    general_qtype = knowledge_base.detect_general_question(req.message)
    if not general_qtype:
        return None
    # ⚡ ถ้าเป็น warranty/return policy + เป็น follow-up (มี history + สั้น) → ไม่ตอบ general
    #    ให้ไป pipeline หลักเพื่อดึงสินค้าจาก history มาตอบ
    _is_followup = (
        general_qtype in ("warranty_policy", "return_policy")
        and history
        and not knowledge_base.extract_model_keywords(req.message)
        and len(req.message.split()) <= 4
    )
    if _is_followup:
        return None
    # ดึง context จาก KB
    _kb_ctx = knowledge_base.get_general_context(general_qtype, shop=req.shop)
    if not _kb_ctx:
        return None
    try:
        _answer, _usage = llm.answer_general(
            message=req.message, context=_kb_ctx, qtype=general_qtype,
            history=history, persona_extra=ctx["persona_extra"],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return _make_response(_answer, [], ctx, source=f"general:{general_qtype}", usage=_usage,
                          routing=_app_module._routing("bot_reply", f"general:{general_qtype}"))


def _check_brand_question(req, ctx, history, db) -> dict | None:
    """Brand question — ย้ายจาก legacy บรรทัด 2401-2440."""
    brand_q = _app_module._detect_brand_question(req.message)
    if not brand_q:
        return None
    brand_result = _app_module._build_brand_context(db, brand_q, shop_filter=req.shop)
    if req.shop and not brand_result:
        brand_result = _app_module._build_brand_context(db, brand_q)
    if not brand_result or not brand_result.get("context"):
        return None
    try:
        _answer, _usage = llm.answer_general(
            message=req.message, context=brand_result["context"], qtype="brand_info",
            history=history,
            shop_hint=req.shop if brand_result.get("meta", {}).get("shop_scoped") else None,
            persona_extra=ctx["persona_extra"],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return _make_response(_answer, [], ctx, source="general:brand_info", usage=_usage,
                          routing=_app_module._routing("bot_reply", f"brand_question: {brand_q}"))


# ── Stage 3: Classify Intent ─────────────────────────────────────────────────

def _classify_intent(req, ctx: dict, history: list[dict]) -> dict:
    """Stage 3: intent classification — LLM เป็นหลัก.

    ใช้ intent_classifier.classify_intent (มีอยู่แล้ว) แต่ไม่ override ด้วย hardcode keyword
    คืน dict: {intent, product_type, charger_subtype, target_device, confidence, needs_description, usage}
    """
    _pre_product_types = product_store._detect_product_types(req.message)
    if not _pre_product_types:
        _pre_product_types = product_store._detect_product_types_fuzzy(req.message)
    _has_warranty_history = bool(history and any(
        any(kw in h.get("text", "").lower()
            for kw in ("รับประกัน", "ประกัน", "เคลม", "warranty", "claim"))
        for h in history if h.get("role") == "model"
    ))
    from . import warranty as _w
    _is_claim = _w.detect_claim_request(req.message)
    if not _ic.should_run_pass1(
        message=req.message, claim_detected=_is_claim,
        product_types=_pre_product_types,
        has_warranty_history=_has_warranty_history,
    ):
        print(f"[INTENT-V2] skip Pass1 (clear case)", file=sys.stderr)
        return {}
    _t_intent = _time.time()
    _intent = _ic.classify_intent(message=req.message, history=history, shop=req.shop)
    ctx["timing"]["pass1"] = round(_time.time() - _t_intent, 3)
    print(f"[TIMING-V2] Pass1 intent: {ctx['timing']['pass1']}s", file=sys.stderr)
    # record Intent step
    _INTENT_COST = {"prompt": 0.25, "output": 0.50}
    _u = _intent.get("usage", {})
    _t_in = _u.get("prompt", 0)
    _t_out = _u.get("output", 0)
    _cost = (_t_in * _INTENT_COST["prompt"] + _t_out * _INTENT_COST["output"]) / 1_000_000
    ctx["steps"].append({
        "name": "Intent",
        "model": _intent.get("model", "gemini-3.1-flash-lite"),
        "tokens_in": _t_in, "tokens_out": _t_out,
        "time_s": ctx["timing"]["pass1"],
        "cost_usd": round(_cost, 6), "cost_thb": round(_cost * 36, 4),
        "input": {"message": req.message, "history_count": len(history) if history else 0, "shop": req.shop},
        "output": {
            "intent": _intent.get("intent"),
            "confidence": _intent.get("confidence"),
            "product_type": _intent.get("product_type"),
            "charger_subtype": _intent.get("charger_subtype"),
            "target_device": _intent.get("target_device"),
            "needs_description": _intent.get("needs_description"),
        },
    })
    # ⚡ เพิ่ม superlative / multi-use-case / charging spec / wattage ใน intent
    _intent["is_superlative"] = _is_superlative_question(req.message)
    _intent["is_charging_spec"] = _is_charging_spec_question(req.message)
    _intent["multi_usecase"] = _detect_multi_usecase(req.message)
    _intent["wattage"] = _extract_wattage(req.message)
    # ⚡ charging spec question → intent เป็น product_spec (ไม่ใช่ product_recommend)
    #   เพราะลูกค้าถามสเปกชาร์จของสินค้า X ไม่ใช่ถามหาสินค้า charger
    if _intent.get("is_charging_spec") and _intent.get("intent") == "product_recommend":
        _intent["intent"] = "product_spec"
        print(f"[INTENT-V2] charging spec → override intent to product_spec", file=sys.stderr)
    return _intent


# ── Stage 4: Detect Anchor ───────────────────────────────────────────────────

def _detect_anchor(req, ctx: dict, history: list[dict], db) -> dict | None:
    """Stage 4: detect anchor — เก็บข้อมูลครบ (item_id, name, type, subtype, desc).

    คืน AnchorData dict หรือ None

    ⚡ subtype mismatch check: ถ้า anchor=สาย แต่ message=หัว → ไม่ใช้ anchor เป็น product หลัก
       แต่เก็บไว้ใน context เพื่อให้ LLM ทราบว่าลูกค้าเคยสนใจสินค้าอะไร
    """
    _item_id = req.item_id
    if not _item_id:
        # extract จาก [สินค้า: XXX] tag ใน message
        _m = re.search(r"\[สินค้า:\s*(\d+)\]", req.message or "")
        if _m:
            _item_id = _m.group(1)
    if not _item_id and history:
        # หา tag ใน history ล่าสุด
        for h in reversed(history):
            _m = re.search(r"\[สินค้า:\s*(\d+)\]", h.get("text", "") or "")
            if _m:
                _item_id = _m.group(1)
                break
    if not _item_id:
        return None

    _card = product_store.fetch_product_by_id(db, _item_id, shop_filter=req.shop)
    if not _card:
        return None
    _name = _card.get("name") or _card.get("item_name") or ""
    _product_type = _detect_product_type_from_name(_name)
    _charger_subtype = product_store._detect_charger_subtype(_name) or ""
    _description = _card.get("description") or _card.get("desc") or ""
    _status = _card.get("status") or ""
    _is_sold_out = bool(_card.get("sold_out") or _card.get("stock", 0) <= 0)

    # ⚡ subtype mismatch check — ถ้า message มี subtype ชัด และต่างจาก anchor → ไม่ใช้ anchor เป็น product หลัก
    _msg_subtype = product_store._detect_charger_subtype(req.message) or ""
    _subtype_mismatch = False
    if _msg_subtype and _charger_subtype and _msg_subtype != _charger_subtype:
        _subtype_mismatch = True
        print(f"[ANCHOR-V2] subtype mismatch: anchor={_charger_subtype} msg={_msg_subtype} → ไม่ใช้ anchor เป็น product หลัก", file=sys.stderr)

    # ⚡ compat check — ถ้า message มี "ใช้กับ/รองรับ" + target_device → เป็น compatibility question
    _compat_kws = ("ใช้กับ", "รองรับ", "สำหรับ", "compatible", "support", "works with")
    _has_compat = any(kw in (req.message or "").lower() for kw in _compat_kws)
    _is_compat_question = _has_compat and bool(_extract_target_device(req.message))

    # บันทึก anchor ลง conversation_products timeline
    if req.conversation_id:
        try:
            _cp.add_item_anchor(
                conversation_id=req.conversation_id,
                platform=req.platform or "shopee",
                shop=req.shop,
                item_id=str(_item_id),
                product_card=_card,
            )
        except Exception as _e:
            print(f"[ANCHOR-V2] save failed: {_e}", file=sys.stderr)

    return {
        "item_id": str(_item_id),
        "name": _name,
        "product_type": _product_type,
        "charger_subtype": _charger_subtype,
        "description": _description,
        "card": _card,
        "source": "user_item_card",
        "is_sold_out": _is_sold_out,
        "status": _status,
        "subtype_mismatch": _subtype_mismatch,
        "is_compat_question": _is_compat_question,
        # ⚡ ถ้า subtype mismatch → ไม่ merge anchor เข้า products (แต่เก็บไว้ใน context)
        "use_as_product": not _subtype_mismatch,
    }


def _extract_target_device(message: str) -> str:
    """Extract target device จาก message (เช่น 'Xiaomi 17 Ultra', 'iPhone 13')."""
    if not message:
        return ""
    # pattern: brand + model (เช่น Xiaomi 17 Ultra, iPhone 13, Samsung S24)
    _m = re.search(
        r"\b(Xiaomi|Redmi|iPhone|iPad|Samsung|Galaxy|Huawei|OPPO|Vivo|Realme|OnePlus|Pixel|Nothing)[\s\-]?(\d+\s?(?:Ultra|Pro|Max|Plus|Mini|Lite|FE)?)",
        message, re.IGNORECASE
    )
    if _m:
        return f"{_m.group(1)} {_m.group(2)}".strip()
    return ""


def _detect_product_type_from_name(name: str) -> str:
    """Detect product type จากชื่อสินค้า — ใช้ helper ที่มีแล้ว."""
    _types = product_store._detect_product_types(name)
    if _types:
        return next(iter(_types))
    _types = product_store._detect_product_types_fuzzy(name)
    if _types:
        return next(iter(_types))
    return ""


def _detect_followup_products(req, history: list[dict], db) -> list[dict]:
    """Detect follow-up — ถ้า message สั้น + มี history → ดึงสินค้าจาก history.

    เคสที่จับ:
    - "รับประกัน" สั้นๆ หลังคุยสินค้า → ดึงสินค้าจาก history
    - "ราคา" สั้นๆ หลังคุยสินค้า → ดึงสินค้าจาก history
    - "ต่างกันยังไง" หลังคุยสินค้า 2 ตัว → ดึงสินค้าจาก history
    - "อันนั้น" / "อันนี้" / "อันก่อนหน้า" → ดึงสินค้าจาก history

    คืน list[dict] ของสินค้าจาก history (ถ้าเจอ) หรือ [] ถ้าไม่ใช่ follow-up
    """
    if not history or not req.conversation_id:
        return []
    _msg = (req.message or "").strip()
    if not _msg:
        return []
    # เช็คว่าเป็น follow-up ไหม (message สั้น + มี reference indicator)
    _followup_indicators = (
        "รับประกัน", "ประกัน", "ราคา", "กี่บาท", "เท่าไหร่",
        "ต่างกันยังไง", "ต่างกันไหม", "แตกต่าง", "เปรียบเทียบ",
        "อันนั้น", "อันนี้", "อันก่อนหน้า", "ตัวที่ส่งไป", "ตัวเดิม",
        "สเปค", "รายละเอียด", "ข้อมูล",
    )
    _is_followup = any(ind in _msg.lower() for ind in _followup_indicators)
    if not _is_followup:
        return []
    # ดึงสินค้าจาก conversation_products timeline
    try:
        _timeline = _cp.get_timeline(req.conversation_id, platform=req.platform or "shopee")
        if not _timeline:
            return []
        _products = []
        for _entry in _timeline[-5:]:  # ดึง 5 ล่าสุด
            _card = _entry.get("product_card") or _entry.get("card")
            if _card and _card.get("item_id"):
                _products.append(_card)
        # dedup
        _seen = set()
        _unique = []
        for _p in _products:
            _pid = _p.get("item_id")
            if _pid and _pid not in _seen:
                _seen.add(_pid)
                _unique.append(_p)
        return _unique[:5]  # สูงสุด 5 ตัว
    except Exception as _e:
        print(f"[FOLLOWUP-V2] error: {_e}", file=sys.stderr)
        return []


def _rerank_products(products: list[dict], message: str, intent: dict,
                      anchor: dict | None) -> list[dict]:
    """Rerank products — เรียงตามความเกี่ยวข้อง.

    เกณฑ์การเรียง (เรียงตามลำดับ priority):
    1. anchor อยู่บนสุด (ถ้ามี + use_as_product=True)
    2. สินค้าที่ status=NORMAL + stock>0 ก่อน
    3. สินค้าที่ชื่อตรงกับ message keyword ก่อน
    4. สินค้าที่มี wattage สูงกว่า ก่อน (ถ้า message เกี่ยว charger)
    5. ⚡ superlative: สินค้าที่มี wattage สูงสุด ขึ้นบน (ถ้าเป็น "แรงสุด/ไวสุด")
    6. ⚡ multi-use-case: สินค้าที่ชื่อตรง use-case keyword ขึ้นบน
    7. ⚡ charging spec: สินค้าที่มี wattage ใกล้เคียงที่สุดขึ้นบน (ถ้ามี wattage ใน message)
    """
    if not products:
        return products
    _msg_lower = (message or "").lower()
    _intent_label = intent.get("intent", "")
    _is_charger = _intent_label in ("product_recommend", "product_spec") and (
        "หัวชาร์จ" in _msg_lower or "adapter" in _msg_lower or "charger" in _msg_lower
    )
    _is_superlative = intent.get("is_superlative", False) or _is_superlative_question(message)
    _multi_usecase = intent.get("multi_usecase", []) or _detect_multi_usecase(message)
    _req_wattage = intent.get("wattage", 0) or _extract_wattage(message)
    _is_charging_spec = intent.get("is_charging_spec", False) or _is_charging_spec_question(message)

    def _score(p: dict) -> tuple:
        """คืน tuple สำหรับ sort (คะแนนสูง = ดีกว่า → ใส่ - หน้าค่าที่ต้องการมากกว่า)."""
        _is_anchor = p.get("_is_anchor", False)
        _status = (p.get("status") or p.get("item_status") or "").upper()
        _stock = p.get("stock") or p.get("stocks") or 0
        _is_normal = _status == "NORMAL" and _stock > 0
        _name = (p.get("name") or p.get("item_name") or "").lower()
        # keyword match score
        _msg_words = [w for w in _msg_lower.split() if len(w) > 2]
        _match_score = sum(1 for w in _msg_words if w in _name)
        # wattage score (ถ้าเป็น charger)
        _watt = 0
        if _is_charger or _is_superlative:
            _watt_m = re.search(r"(\d+)\s*[wW]", _name)
            if _watt_m:
                _watt = int(_watt_m.group(1))
        # ⚡ superlative: ให้คะแนน wattage สูงสุด (ถ้าเป็น "แรงสุด/ไวสุด")
        _super_watt_score = 0
        if _is_superlative and _watt > 0:
            _super_watt_score = _watt
        # ⚡ multi-use-case: ให้คะแนนสินค้าที่ชื่อตรง use-case keyword
        _usecase_score = 0
        if _multi_usecase:
            for _uc in _multi_usecase:
                _scenario, _feat = _uc.split("+", 1)
                if _scenario in _name or _feat in _name:
                    _usecase_score += 1
        # ⚡ charging spec: ให้คะแนนสินค้าที่มี wattage ใกล้เคียงที่สุด
        _spec_watt_score = 0
        if _is_charging_spec and _req_wattage > 0 and _watt > 0:
            _diff = abs(_watt - _req_wattage)
            _spec_watt_score = max(0, 100 - _diff)  # ใกล้เคียง = คะแนนสูง
        # sort key: (anchor, normal, match_score, super_watt, usecase, spec_watt, watt)
        return (
            1 if _is_anchor else 0,
            1 if _is_normal else 0,
            _match_score,
            _super_watt_score,
            _usecase_score,
            _spec_watt_score,
            _watt,
        )

    return sorted(products, key=_score, reverse=True)


def _filter_unavailable_products(products: list[dict]) -> list[dict]:
    """Filter unavailable products — กรอง sold_out/non-NORMAL ออก.

    ถ้ากรองแล้วว่าง → ปล่อยทั้งหมด + ฝัง _context_note บอก LLM ว่าไม่มีสินค้าพร้อมขาย
    """
    if not products:
        return products
    _available = []
    for _p in products:
        _is_anchor = _p.get("_is_anchor", False)
        _status = (_p.get("status") or _p.get("item_status") or "").upper()
        _stock = _p.get("stock") or _p.get("stocks") or 0
        _sold_out = _p.get("sold_out") or _p.get("is_sold_out") or False
        # anchor ไม่กรอง (ลูกค้าส่งการ์ดมา ต้องตอบเรื่องสินค้านั้นได้)
        if _is_anchor:
            _available.append(_p)
            continue
        if _status == "NORMAL" and _stock > 0 and not _sold_out:
            _available.append(_p)
    if not _available:
        # กรองแล้วว่าง → ปล่อยทั้งหมด + ฝัง note
        for _p in products:
            _p["_context_note"] = (
                "⚠️ สินค้าทุกตัวไม่พร้อมขาย ห้ามแนะนำ/เสนอขาย "
                "ให้บอกไม่มีสต็อก + ชวนทักแอดมิน"
            )
        return products
    return _available


# ── Stage 5: Retrieve Products ───────────────────────────────────────────────

def _retrieve_products(req, ctx: dict, history: list[dict], intent: dict,
                       anchor: dict | None, db) -> list[dict]:
    """Stage 5: RAG — KB + DB ไม่กรอง sold_out.

    กฎ:
    - ดึงสินค้าทุกตัว (normal + non-normal) เพราะลูกค้าอาจถามสินค้าเก่า
    - ไม่กรอง filter_unavailable ใน RAG — ให้ LLM prompt เป็นคนกรองตอนแนะนำขาย
    - ถ้ามี anchor + เป็น compatibility check → merge anchor เข้า products
    """
    _t0 = _time.time()
    _retrieval_msg = req.message
    _desc_msg = req.message

    # 5.1 ถ้ามี anchor + เป็น compatibility check → เพิ่ม product type ของ anchor ลง retrieval
    _intent_label = intent.get("intent", "")
    _target_device = intent.get("target_device", "")
    if anchor and _target_device:
        _anchor_type = anchor.get("product_type", "")
        _anchor_sub = anchor.get("charger_subtype", "")
        if _anchor_type:
            _type_kw = {
                "charger": "ชาร์จ", "cable": "สายชาร์จ", "powerbank": "พาวเวอร์แบงค์",
                "earphone": "หูฟัง", "phone": "สมาร์ทโฟน", "smartwatch": "สมาร์ทวอช",
            }.get(_anchor_type, _anchor_type)
            _retrieval_msg = f"{_type_kw} {_anchor_type} {_retrieval_msg}"
            print(f"[ANCHOR-V2] augment retrieval with anchor type: {_retrieval_msg!r}", file=sys.stderr)

    # 5.2 ถ้าเป็น compatibility check + มี product_type จาก intent → ใช้เฉพาะ type keyword
    if _intent_label == "compatibility_check" and intent.get("product_type") and not anchor:
        _compat_type = intent.get("product_type")
        _compat_sub = intent.get("charger_subtype", "")
        _sub_kw = {
            "adapter": "หัวชาร์จ", "cable": "สายชาร์จ", "set": "ชุดชาร์จ",
            "car_charger": "หัวชาร์จในรถ", "wireless": "ชาร์จไร้สาย",
            "desktop": "แท่นชาร์จ", "socket": "เต้ารับ",
        }.get(_compat_sub, "")
        _retrieval_msg = f"{_sub_kw} {_compat_type}".strip()
        print(f"[COMPAT-V2] compat retrieval: {_retrieval_msg!r}", file=sys.stderr)

    # 5.2b Follow-up detection — ถ้า message สั้น + มี history → ดึงสินค้าจาก history
    _followup_products = _detect_followup_products(req, history, db)
    if _followup_products:
        print(f"[RAG-V2] follow-up: +{len(_followup_products)} products from history", file=sys.stderr)

    # 5.2c MODEL-REGEX pre-filter — ถ้า message มี model keyword ชัดเจน
    # ให้ดึงด้วย Mongo regex ก่อน vector search (แม่นยำกว่าสำหรับชื่อสินค้าเฉพาะ)
    # ทำเหมือน legacy app.py line 2614-2653 — กัน vector search หาสินค้าผิดรุ่น
    _model_regex_products: list[dict] = []
    _mr_model_kws = re.findall(r"[A-Za-z]+\d+[A-Za-z]*", req.message or "")
    _mr_model_kws = [w for w in _mr_model_kws if len(w) >= 4]
    if not _mr_model_kws:
        _mr_alpha_kws = re.findall(r"[A-Za-z]{5,}", req.message or "")
        _mr_common = {"watch", "smart", "phone", "cable", "charger", "adapter",
                      "power", "bank", "band", "type", "usb", "wireless",
                      "what", "how", "please", "thank", "hello",
                      "version", "global", "china", "international", "original",
                      "authentic", "local", "origin", "korea", "hongkong"}
        _mr_alpha_kws = [w for w in _mr_alpha_kws if w.lower() not in _mr_common]
        _mr_model_kws = _mr_alpha_kws[:1]
    if _mr_model_kws:
        _mr_kw = _mr_model_kws[0]
        # ทำความสะอาด repeated chars (เช่น "ctl3011" → "ctl301")
        _mr_kw_clean = re.sub(r"(.)\1{2,}$", r"\1", _mr_kw.lower())
        if _mr_kw_clean != _mr_kw.lower():
            _mr_kw = _mr_kw_clean
        _mr_alpha = re.match(r"[A-Za-z]+", _mr_kw).group(0)
        _mr_rest = _mr_kw[len(_mr_alpha):]
        if _mr_rest:
            _mr_pattern = re.escape(_mr_alpha) + r".?" + re.escape(_mr_rest)
        else:
            _mr_prefix = _mr_kw[:6] if len(_mr_kw) >= 6 else _mr_kw
            _mr_pattern = re.escape(_mr_prefix)
        try:
            _mr_coll = db[os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"]
            _mr_filter: dict = {"item_name": {"$regex": _mr_pattern, "$options": "i"}}
            if req.shop:
                _mr_filter["shopname"] = {"$regex": f"^{re.escape(req.shop)}$", "$options": "i"}
            _mr_docs = list(_mr_coll.find(_mr_filter, product_store.PRODUCT_PROJECTION).limit(5))
            if _mr_docs:
                _model_regex_products = [product_store.to_product_card(d, req.message) for d in _mr_docs]
                print(f"[MODEL-REGEX-V2] ดึงสินค้าตรง model keyword '{_mr_kw}' (pattern={_mr_pattern!r}): {len(_model_regex_products)} ตัว", file=sys.stderr)
        except Exception as _e:
            print(f"[MODEL-REGEX-V2] error: {_e}", file=sys.stderr)

    # 5.3 KB lookup
    _kb_result = knowledge_base.lookup_kb(_retrieval_msg)
    _kb_context = ""
    _products: list[dict] = []
    # เพิ่ม follow-up products ก่อน (ถ้ามี)
    if _followup_products:
        _products.extend(_followup_products)
    # ⚡ MODEL-REGEX products — ถ้าเจอจาก model keyword regex ให้ใช้เป็น products หลัก
    #    และ skip broad fetch_products (vector search ไม่แม่นพอสำหรับ model code สั้นๆ)
    if _model_regex_products:
        _products.extend(_model_regex_products)
        print(f"[RAG-V2] model-regex: {len(_products)} products (skip broad fetch)", file=sys.stderr)
    elif _kb_result and _kb_result.get("found"):
        _kb_context = _kb_result.get("context", "")
        _kb_docs = _kb_result.get("kb_docs", [])
        # ดึง Mongo มาผสม
        _kb_models = []
        for _kd in _kb_docs:
            _model = (_kd.get("model") or "").strip()
            _brand = (_kd.get("brand") or "").strip()
            if _model:
                _kb_models.append(f"{_brand} {_model}".strip())
        _mongo_q = " ".join(_kb_models[:5]) if _kb_models else _retrieval_msg
        _kb_products = product_store.fetch_products(
            db, message=_mongo_q, shop_filter=req.shop,
            limit=ctx["limit"], desc_message=_desc_msg,
        )
        _products.extend(_kb_products)
        print(f"[RAG-V2] KB+Mongo: {len(_products)} products", file=sys.stderr)

    # 5.4 ถ้า KB ไม่เจอ หรือเจอน้อย → fetch_products ตรง
    #    (skip ถ้ามี model-regex products ที่เจอจาก 5.2c)
    if len(_products) < 3 and not _model_regex_products:
        _fetch_limit = ctx["limit"]
        if _intent_label == "compatibility_check":
            _fetch_limit = max(_fetch_limit * 2, 20)
        # ⚡ superlative → ดึงสินค้าเยอะขึ้น (limit * 5, สูงสุด 50)
        _fetch_limit = _adjust_fetch_limit_for_superlative(
            _fetch_limit, req.message, intent, history
        )
        # ⚡ superlative + "ชาร์จ" ไม่มี history → เพิ่ม powerbank ใน retrieval
        _retrieval_msg = _augment_retrieval_for_superlative(_retrieval_msg, req.message, history)
        _more = product_store.fetch_products(
            db, message=_retrieval_msg, shop_filter=req.shop,
            limit=_fetch_limit, desc_message=_desc_msg,
            is_compat_check=(_intent_label == "compatibility_check"),
        )
        # dedup
        _existing_ids = {p.get("item_id") or p.get("name") for p in _products}
        for _p in _more:
            _pid = _p.get("item_id") or _p.get("name")
            if _pid not in _existing_ids:
                _products.append(_p)
                _existing_ids.add(_pid)
        print(f"[RAG-V2] fetch_products: {len(_products)} products total", file=sys.stderr)

    # 5.5 Merge anchor เข้า products (ถ้ามี + ไม่มี subtype mismatch)
    if anchor and anchor.get("card") and anchor.get("use_as_product", True):
        _anchor_card = dict(anchor["card"])
        _anchor_card["_is_anchor"] = True
        _anchor_card["_context_note"] = (
            f"⚠️ สินค้านี้คือสินค้าที่ลูกค้าส่งการ์ดมา (anchor) — "
            f"ถ้าลูกค้าถามว่าใช้กับอุปกรณ์ X ได้ไหม ให้เช็ค spec ของสินค้านี้ก่อน "
            f"ถ้าไม่รองรับ ให้บอกตรงๆ แล้วแนะนำสินค้าอื่นใน context ที่รองรับ"
        )
        _products.insert(0, _anchor_card)
        print(f"[RAG-V2] merge anchor: {len(_products)} products", file=sys.stderr)
    elif anchor and anchor.get("card") and not anchor.get("use_as_product", True):
        # subtype mismatch → เก็บ anchor ใน context note แต่ไม่ merge เป็น product หลัก
        print(f"[RAG-V2] anchor subtype mismatch → ไม่ merge anchor เป็น product หลัก", file=sys.stderr)

    # 5.6 Rerank products — เรียงตามความเกี่ยวข้อง
    _products = _rerank_products(_products, req.message, intent, anchor)

    # 5.7 Filter unavailable ถ้าเป็น product_recommend intent
    _intent_label = intent.get("intent", "")
    _filter_unavailable = _intent_label in ("product_recommend", "product_search")
    if _filter_unavailable:
        _products = _filter_unavailable_products(_products)
        print(f"[RAG-V2] filter_unavailable: {len(_products)} products remaining", file=sys.stderr)

    ctx["timing"]["retrieval"] = round(_time.time() - _t0, 3)
    # record RAG step
    ctx["steps"].append({
        "name": "RAG",
        "model": "mongodb+kb",
        "tokens_in": 0, "tokens_out": 0,
        "time_s": ctx["timing"]["retrieval"],
        "cost_usd": 0, "cost_thb": 0,
        "input": {"query": _desc_msg, "shop": req.shop, "limit": ctx["limit"], "intent": _intent_label},
        "output": {"product_count": len(_products), "products": [p.get("name", "")[:60] for p in _products[:10]]},
    })
    return _products


# ── Stage 6: Search if Needed ────────────────────────────────────────────────

def _search_if_needed(req, ctx: dict, history: list[dict], intent: dict,
                      products: list[dict], db) -> tuple[list[dict], str, dict]:
    """Stage 6: web search → RAG → (ไม่ตอบตรง — ส่งกลับไป LLM2).

    คืน (products, extra_context, search_meta)
    - products: สินค้ารวมจาก re-query (ถ้า search ได้ keywords ใหม่)
    - extra_context: spec จาก search (strip URL แล้ว) สำหรับส่งให้ LLM2
    - search_meta: {used, reason, model, usage, cost, elapsed}
    """
    _search_meta = {"used": False, "reason": "", "model": "", "usage": {}, "cost": 0, "elapsed": 0}
    if not _ws.is_configured():
        return products, "", _search_meta

    # 6.1 ตัดสินใจว่าควร search หรือไม่
    # ⚡ เงื่อนไขใหม่: search ถ้า (a) ไม่มีสินค้าเลย หรือ (b) LLM ตอบไม่มั่นใจ (negative_answer)
    #    ไม่ใช่ search ถ้ามีสินค้าเพียงพอ + intent ชัดเจน
    _should_search = False
    _reason = ""
    if not products:
        _should_search = True
        _reason = "no_products"
    elif intent.get("intent") == "compatibility_check" and intent.get("target_device"):
        # compat check + มี target_device → search เพื่อดู spec ของ device
        _should_search = True
        _reason = "compatibility_spec"
    if not _should_search:
        return products, "", _search_meta

    print(f"[SEARCH-V2] triggered: {_reason}", file=sys.stderr)
    _ws_query = req.message
    _ws_result = _ws.search_and_extract(
        message=_ws_query, shop=req.shop, platform=req.platform,
        history=history, reason=_reason,
    )
    if _ws_result.get("error") or not _ws_result.get("search_used"):
        return products, "", _search_meta

    _keywords = _ws_result.get("keywords", [])
    _search_info = _ws_result.get("search_info", "")
    _ws_product_type = _ws_result.get("product_type", "")
    _ws_usage = _ws_result.get("usage", {})
    _ws_cost = _ws_result.get("cost_usd", 0.0)
    _ws_elapsed = _ws_result.get("elapsed", 0.0)
    _ws_model = _ws_result.get("model", "")

    _search_meta = {
        "used": True, "reason": _reason, "model": _ws_model,
        "usage": _ws_usage, "cost": _ws_cost, "elapsed": _ws_elapsed,
        "keywords": _keywords, "product_type": _ws_product_type,
    }

    # 6.2 re-query DB ด้วย keywords
    _new_products: list[dict] = []
    if _keywords:
        _search_q = " ".join(_keywords[:6])
        if _ws_product_type:
            _search_q = f"{_ws_product_type} {_search_q}"
        try:
            _new_products = product_store.fetch_products(
                db, message=_search_q, shop_filter=req.shop,
                limit=10, desc_message=req.message,
            )
            print(f"[SEARCH-V2] re-query: {_search_q!r} → {len(_new_products)} products", file=sys.stderr)
        except Exception as _e:
            print(f"[SEARCH-V2] re-query error: {_e}", file=sys.stderr)

    # 6.3 merge สินค้าใหม่เข้า products (dedup)
    if _new_products:
        _existing_ids = {p.get("item_id") or p.get("name") for p in products}
        for _p in _new_products:
            _pid = _p.get("item_id") or _p.get("name")
            if _pid not in _existing_ids:
                products.append(_p)
                _existing_ids.add(_pid)

    # 6.4 strip URL ออกจาก search_info (ห้าม external URL)
    _search_info_clean = _strip_urls(_search_info)

    # 6.5 สร้าง extra_context สำหรับ LLM2 (search_info เป็นข้อมูลประกอบ ไม่ใช่คำตอบหลัก)
    _extra_context = ""
    if _search_info_clean:
        _extra_parts = [
            "=== ข้อมูลจาก Google Search (ข้อมูลประกอบเท่านั้น — ห้ามใช้เป็นแหล่งหลัก) ===",
            "คำเตือน: ข้อมูลด้านล่างเป็นข้อมูลเสริมเพื่อช่วยเติม spec ที่ขาดของสินค้าใน context เท่านั้น",
            "ห้ามนำมาเป็นหัวข้อคำตอบหลัก, ห้ามแนะนำสินค้าที่ไม่อยู่ใน context,",
            "ห้ามตอบเรื่องสินค้า/แบรนด์อื่นที่ไม่ใช่สินค้าใน context",
            "ห้ามใส่ลิงก์ใดๆ ในคำตอบ นอกจาก short_link ของสินค้าใน context",
            "---",
            _search_info_clean,
        ]
        _extra_context = "\n".join(_extra_parts)
        if ctx["vision_context"]:
            _extra_context = (ctx["vision_context"] + "\n" + _extra_context).strip()

    # record Search step
    _t_in = _ws_usage.get("prompt", 0)
    _t_out = _ws_usage.get("output", 0)
    ctx["steps"].append({
        "name": "Search",
        "model": _ws_model,
        "tokens_in": _t_in, "tokens_out": _t_out,
        "time_s": round(_ws_elapsed, 2),
        "cost_usd": round(_ws_cost, 6), "cost_thb": round(_ws_cost * 36, 4),
        "input": {"message": _ws_query, "reason": _reason, "intent": intent.get("intent")},
        "output": {
            "search_used": True, "keywords": _keywords[:8],
            "product_type": _ws_product_type,
            "search_info": _search_info_clean[:500],
        },
    })
    return products, _extra_context, _search_meta


def _strip_urls(text: str) -> str:
    """Strip external URLs ออกจาก text — ห้าม external URL ในคำตอบ."""
    if not text:
        return text
    # strip markdown link [text](url)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"", text)
    # strip plain URL
    text = re.sub(r"https?://[^\s\)\]]+", r"", text, flags=re.IGNORECASE)
    # strip empty markdown link [text]()
    text = re.sub(r"\[([^\]]*)\]\(\s*\)", r"", text).strip()
    # collapse whitespace
    text = re.sub(r"\s{2,}", r" ", text).strip()
    if len(text) < 20:
        return text
    return text


# ── Stage 7: No Product Guard (ด่านสุดท้าย หลัง search) ──────────────────────

def _no_product_guard(req, ctx: dict, intent: dict, products: list[dict],
                      search_used: bool) -> dict | None:
    """Stage 7: NO-PRODUCT-GUARD — ด่านสุดท้าย หลัง search แล้วยังไม่เจอ.

    คืน ChatResponse dict ถ้า guard ทำงาน หรือ None ถ้ามีสินค้าให้ไป LLM2
    """
    if products:
        return None
    # มีสินค้า → ไป LLM2
    # ไม่มีสินค้า + search แล้ว → ตอบไม่พบ + handoff
    print(f"[NO-PRODUCT-GUARD-V2] products=0 + search_used={search_used} → handoff", file=sys.stderr)
    _answer = (
        "ขออภัยค่ะ ตอนนี้ระบบไม่พบข้อมูลสินค้าตามที่สอบถามไว้ "
        "เดี๋ยวขอส่งเรื่องให้แอดมินช่วยตรวจสอบและตอบกลับให้ไวที่สุดนะคะ "
        "ระหว่างนี้หากสนใจสินค้าอื่นสอบถามได้เลยค่ะ"
    )
    return _make_response(_answer, [], ctx, source="no_product_found_handoff",
                          handoff=True, handoff_reason="no_product_found",
                          web_search_used=search_used,
                          routing=_app_module._routing(
                              "handoff",
                              "no_product_found: search แล้วยังไม่เจอ → handoff แอดมิน",
                              handoff_reason="no_product_found",
                          ))


# ── Stage 8: Build Answer (LLM2) ─────────────────────────────────────────────

def _build_answer(req, ctx: dict, history: list[dict], intent: dict,
                  anchor: dict | None, products: list[dict],
                  extra_context: str) -> dict:
    """Stage 8: LLM2 ตอบ — ส่ง products + extra_context ให้ LLM.

    ⚡ เพิ่ม superlative / multi-use-case / charging spec context ให้ LLM
    """
    _t_llm = _time.time()
    # ⚡ สร้าง extra context สำหรับ superlative / multi-use-case / charging spec
    _extra_hints = []
    if intent.get("is_superlative"):
        _extra_hints.append(
            "⚠️ ลูกค้าถามแบบ superlative (สุด/ที่สุด/แรงสุด/ไวสุด) — "
            "เปรียบเทียบสินค้าใน context แล้วตอบอันที่เด่นจริงตามที่ลูกค้าถาม "
            "ถ้าไม่ชัดว่าลูกค้าหมายถึงอะไร ให้ถามกลับ"
        )
    if intent.get("multi_usecase"):
        _uc_text = ", ".join(intent["multi_usecase"])
        _extra_hints.append(
            f"⚠️ ลูกค้าต้องการสินค้าที่ใช้ได้หลาย use-case: {_uc_text} — "
            f"แนะนำเฉพาะสินค้าที่ตรงทุก use-case ถ้ามี ถ้าไม่มีให้บอกตรงๆ"
        )
    if intent.get("is_charging_spec"):
        _extra_hints.append(
            "⚠️ ลูกค้าถาม charging spec ของสินค้า (ไม่ใช่ถามหาสินค้า charger) — "
            "ตอบสเปกชาร์จของสินค้าที่ลูกค้าถาม ไม่ใช่แนะนำสินค้า charger ใหม่"
        )
    if intent.get("wattage", 0) > 0:
        _extra_hints.append(
            f"⚠️ ลูกค้าระบุ wattage {intent['wattage']}W — "
            f"พิจารณาสินค้าที่รองรับ wattage ใกล้เคียงหรือสูงกว่า"
        )
    _full_extra = extra_context
    if _extra_hints:
        _full_extra = (extra_context + "\n\n" if extra_context else "") + "\n".join(_extra_hints)
    try:
        _answer, _usage = llm.answer(
            message=req.message,
            products=products,
            shop_hint=req.shop,
            history=history,
            persona_extra=ctx["persona_extra"],
            intent_result=intent,
            extra_context=_full_extra,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    _llm_elapsed = _time.time() - _t_llm
    ctx["timing"]["llm"] = round(_llm_elapsed, 3)
    # append base warranty ถ้าเป็นคำถามรับประกัน
    _answer = _app_module._append_base_warranty(_answer, req.message)
    # record LLM2 step
    _model = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _prompt_t = _usage.get("prompt", 0) + ctx["vision_usage"].get("prompt", 0)
    _output_t = _usage.get("output", 0) + ctx["vision_usage"].get("output", 0)
    _cost = (_prompt_t * 0.30 + _output_t * 2.50) / 1_000_000
    ctx["steps"].append({
        "name": "LLM2",
        "model": _model,
        "tokens_in": _prompt_t, "tokens_out": _output_t,
        "time_s": round(_llm_elapsed, 3),
        "cost_usd": round(_cost, 6), "cost_thb": round(_cost * 36, 4),
        "input": {
            "message": req.message, "product_count": len(products),
            "products": [p.get("name", "")[:60] for p in products[:10]],
            "intent": intent.get("intent"),
            "history_count": len(history) if history else 0,
            "persona": ctx["persona_extra"][:100] if ctx["persona_extra"] else "",
        },
        "output": {"answer": _answer[:500], "answer_full_length": len(_answer)},
    })
    return _answer, _usage, _cost, _model


# ── Helper: Make Response ────────────────────────────────────────────────────

def _make_response(answer: str, products: list[dict], ctx: dict, *,
                   source: str = "", usage: dict | None = None,
                   handoff: bool = False, handoff_reason: str = "",
                   web_search_used: bool = False, web_search_reason: str = "",
                   routing: dict | None = None) -> dict:
    """สร้าง ChatResponse dict — ใช้ทุก stage ทำให้สม่ำเสมอ."""
    _total = round(_time.time() - ctx["total_start"], 2)
    _usage = usage or {"prompt": 0, "output": 0, "total": 0}
    _prompt_t = _usage.get("prompt", 0) + ctx["vision_usage"].get("prompt", 0)
    _output_t = _usage.get("output", 0) + ctx["vision_usage"].get("output", 0)
    _cost = (_prompt_t * 0.30 + _output_t * 2.50) / 1_000_000
    return {
        "answer": answer,
        "answer_segments": llm.split_segments(answer),
        "products": products,
        "shop": ctx["shop"],
        "model": os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite"),
        "source": source,
        "usage": {"prompt": _prompt_t, "output": _output_t, "total": _prompt_t + _output_t},
        "elapsed": _total,
        "cost": round(_cost, 6),
        "handoff_to_admin": handoff,
        "handoff_reason": handoff_reason if handoff else None,
        "handoff_claim": {},
        "intent": {},
        "timing": {**ctx["timing"], "total": _total},
        "retrieval_info": {},
        "web_search_used": web_search_used,
        "web_search_reason": web_search_reason if web_search_used else None,
        "web_search_model": None,
        "image_desc": ctx["image_desc_out"],
        "steps": ctx["steps"],
        "routing_decision": routing or {},
    }


# ── Main Entry Point ─────────────────────────────────────────────────────────

def chat_v2(req) -> dict:
    """Pipeline หลัก — เรียก stages ตามลำดับ ไม่มี early return ในตัว.

    คืน ChatResponse dict (compatible กับ ChatResponse model ของ app.py)
    """
    # Stage 1: context
    ctx, history, client, db = _build_context(req)
    # Stage 2: deterministic fast paths
    _resp = _check_deterministic(req, ctx, history, db)
    if _resp:
        return _resp

    # Stage 3: intent
    _intent = _classify_intent(req, ctx, history)

    # Stage 4: anchor
    _anchor = _detect_anchor(req, ctx, history, db)

    # Stage 5: retrieve (RAG)
    _products = _retrieve_products(req, ctx, history, _intent, _anchor, db)

    # Stage 6: search if needed
    _products, _extra_ctx, _search_meta = _search_if_needed(
        req, ctx, history, _intent, _products, db
    )

    # Stage 7: no product guard (หลัง search)
    _resp = _no_product_guard(req, ctx, _intent, _products, _search_meta["used"])
    if _resp:
        return _resp

    # Stage 8: LLM2 answer
    _answer, _usage, _cost, _model = _build_answer(
        req, ctx, history, _intent, _anchor, _products, _extra_ctx
    )
    return _make_response(
        _answer, _products[:ctx["limit"]], ctx,
        source="product_store",
        usage=_usage,
        web_search_used=_search_meta["used"],
        web_search_reason=_search_meta["reason"] if _search_meta["used"] else "",
        routing=_app_module._routing(
            "bot_reply",
            f"product_store: {len(_products)} products" +
            (f" + search({_search_meta['reason']})" if _search_meta["used"] else ""),
        ),
    )
