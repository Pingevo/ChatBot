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
from typing import Any


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

    # ── Pre-check: claim request detection ──
    _is_claim_request = _warranty_mod.detect_claim_request(req.message)

    # ── State machine ทำงานเฉพาะเมื่อมี history ──
    if not history:
        # First-message claim (no history) → handle ที่ท้ายฟังก์ชัน
        return _handle_first_message_claim(req, ctx, _is_claim_request, _warranty_mod, llm, _app_module)

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
    if not _bot_asked_info and _last_model_is_warranty:
        _all_model_text = " ".join(
            h.get("text", "") for h in history if h.get("role") == "model"
        ).lower()
        _bot_asked_info_ever = (
            any(kw in _all_model_text for kw in _info_request_kws)
            and any(verb in _all_model_text for verb in _ask_verbs)
        )
        if _bot_asked_info_ever:
            _pre_info = _warranty_mod.extract_customer_info(req.message)
            _pre_valid_name = (
                _pre_info["name"] and len(_pre_info["name"]) <= 40 and " " in _pre_info["name"]
                and not any(c.isdigit() for c in _pre_info["name"])
            )
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

    # ── State 6: post-handoff ──
    _history_handoff_marker = any(
        kw in _last_model_text
        for kw in ("มอบหมายงาน", "รอการติดต่อกลับ", "ดำเนินการเรื่อง", "แอดมินดูแล")
    )
    if req.ticket_state == "closed":
        _bot_handed_off = False
    elif req.ticket_state in ("handoff", "open"):
        _bot_handed_off = _history_handoff_marker
    else:
        _bot_handed_off = _history_handoff_marker

    # ── State 7: awaiting claim info ──
    _bot_asked_claim_info = (
        any(kw in _last_model_text for kw in ("วันที่ซื้อ", "ซื้อวันที่", "วันที่ ซื้อ", "purchase date", "ซื้อมาวันที่"))
        and any(kw in _last_model_text for kw in ("เลขที่คำสั่งซื้อ", "หมายเลขคำสั่งซื้อ", "order number", "คำสั่งซื้อ"))
        and any(kw in _last_model_text for kw in ("รูป", "วิดีโอ", "photo", "video", "แสดงอาการ", "ความเสียหาย"))
    )
    _msg_is_image = req.message.strip() in ("[รูปภาพ]", "[image]", "[วิดีโอ]", "[video]", "[sticker]", "[สติกเกอร์]")
    _msg_has_image_placeholder = bool(re.search(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", req.message, re.IGNORECASE))
    _msg_has_date = _warranty_mod.parse_purchase_date(req.message) is not None

    # ── Post-handoff logic ──
    _post_handoff_info = _warranty_mod.extract_customer_info(
        re.sub(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", "", req.message, flags=re.IGNORECASE).strip()
    )
    _post_handoff_has_info = (
        _msg_is_image or _msg_has_image_placeholder or _msg_has_date
        or bool(_post_handoff_info["order_id"])
        or bool(_post_handoff_info["phone"])
        or (_post_handoff_info["name"] and len(_post_handoff_info["name"]) <= 40 and " " in _post_handoff_info["name"])
    )
    _product_q_kws = (
        "สายชาร์จ", "หัวชาร์จ", "ชุดชาร์จ", "แท่นชาร์จ", "พาวเวอร์แบงค์", "แบตสำรอง",
        "แบตเตอรี่", "สาย usb", "สาย c", "สาย type", "หาสาย", "หาหัว", "หาแบต",
        "มีสาย", "มีหัว", "มีแบต", "มีพาวเวอร์", "มีสินค้า", "ดูสินค้า", "แนะนำ",
        "สอบถามสินค้า", "รุ่นไหนดี", "ราคา", "กี่บาท", "ชาร์จเร็ว", "watt", "วัตต์",
        "สายแรง", "หัวแรง", "แบตแรง", "ชาร์จแรง", "pd 3.1", "gan", "wireless",
        "สวัสดี", "hello", "hi ", "ขอดูสินค้า", "ขอสอบถาม",
    )
    _warranty_q_kws = (
        "เคลม", "ประกัน", "ทวนข้อมูล", "ส่งสินค้า", "พัสดุ", "tracking", "EMS",
        "เบอร์", "เลขคำสั่ง", "วันที่ซื้อ", "รูปสินค้า", "แสดงอาการ", "ความเสียหาย",
        "เปลี่ยนสินค้า", "คืนสินค้า", "refund", "return", "เคลมสาย", "เคลมหัว",
        "ใช้ไม่ได้", "ไม่ทำงาน", "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด",
        "เสีย", "พัง", "ซ่อม", "ไม่ติด", "ค้าง",
    )
    _msg_lower_for_check = req.message.lower()
    _has_product_kw = any(kw in _msg_lower_for_check for kw in _product_q_kws)
    _has_warranty_kw = any(kw in _msg_lower_for_check for kw in _warranty_q_kws)
    _is_post_handoff_product_q = _has_product_kw and not _has_warranty_kw
    _post_handoff_exceptions = _app_module._get_post_handoff_exceptions(req.shop, req.platform)
    _is_post_handoff_exception = bool(_post_handoff_exceptions) and any(
        exc.lower() in _msg_lower_for_check for exc in _post_handoff_exceptions
    )
    if _bot_handed_off and not _post_handoff_has_info and not _is_post_handoff_product_q and not _is_post_handoff_exception:
        return _build_post_handoff_response(req, ctx, _app_module, llm)

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
        if _warranty_ctx_in_history and _is_post_handoff_product_q:
            _warranty_ctx_in_history = False

    _warranty_claim_handoff = False
    _warranty_claim_ctx: dict = {}
    _warranty_claim_answer = ""

    if (_bot_asked_claim_info or _warranty_ctx_in_history) and not _bot_reviewed_info:
        _claim_clean_msg = re.sub(r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", "", req.message, flags=re.IGNORECASE).strip()
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
        _has_name = _info["name"] and len(_info["name"]) <= 40 and " " in _info["name"]
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
            _warranty_claim_ctx = {
                "customer_name": _info["name"],
                "customer_phone": _info["phone"],
                "customer_order_id": _info["order_id"],
                "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
            }

    # ── State: awaiting_customer_info → ลูกค้าให้ข้อมูล ──
    if _bot_asked_info and not _bot_reviewed_info and not _msg_has_date:
        _info = _warranty_mod.extract_customer_info(req.message)
        _has_valid_name = _info["name"] and len(_info["name"]) <= 40 and " " in _info["name"]
        _has_valid_phone = bool(_info["phone"])
        _has_valid_order = bool(_info["order_id"])
        if _has_valid_name and any(c.isdigit() for c in _info["name"]):
            _has_valid_name = False
        if _has_valid_name or _has_valid_phone or _has_valid_order:
            _review_lines = []
            _missing_lines = []
            if _has_valid_name:
                _review_lines.append(f"• ชื่อ-นามสกุล: {_info['name']}")
            else:
                _missing_lines.append("• ชื่อ-นามสกุล")
            if _info["phone"]:
                _review_lines.append(f"• เบอร์โทร: {_info['phone']}")
            else:
                _missing_lines.append("• เบอร์โทร")
            if _info["order_id"]:
                _review_lines.append(f"• เลขที่คำสั่งซื้อ: {_info['order_id']}")
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
                "customer_name": _info["name"],
                "customer_phone": _info["phone"],
                "customer_order_id": _info["order_id"],
                "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
            }

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
            _has_valid_name = _info["name"] and len(_info["name"]) <= 40 and " " in _info["name"]
            _has_valid_phone = bool(_info["phone"])
            _has_valid_order = bool(_info["order_id"])
            if _has_valid_name and any(c.isdigit() for c in _info["name"]):
                _has_valid_name = False
            if _has_valid_name or _has_valid_phone or _has_valid_order:
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

    # ── ถ้ามี warranty claim answer → ส่ง handoff + return ──
    if _warranty_claim_answer:
        return _build_warranty_claim_response(
            req, ctx, _warranty_claim_answer, _warranty_claim_handoff,
            _warranty_claim_ctx, _app_module, llm
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
        return _handle_first_message_claim(req, ctx, True, _warranty_mod, llm, _app_module)

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
            if (len(_hname) <= 40 and " " in _hname
                    and not any(c.isdigit() for c in _hname)
                    and not any(kw in _hname.lower() for kw in (
                        "ทวน", "ทน", "คอย", "รูป", "ภาพ", "เคลม", "ส่ง", "พัสดุ",
                        "สินค้า", "ไม่ทราบ", "ได้รับ", "หรือยัง",
                    ))):
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
        "handoff_to_admin": True,
        "handoff_reason": "review_request",
        "handoff_claim": {
            "customer_name": _hist_name,
            "customer_phone": _hist_phone,
            "customer_order_id": _hist_order,
        },
        "steps": ctx.get("steps", []) + [{"name": "warranty_review", "model": _model_name, "detail": "ทวนข้อมูลจาก history"}],
        "routing_decision": _app_module._routing(
            "handoff", "warranty_review: ทวนข้อมูลจาก history",
            handoff_reason="review_request",
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
        "handoff_to_admin": True,
        "handoff_reason": "post_handoff_waiting",
        "handoff_claim": {},
        "steps": ctx.get("steps", []) + [{"name": "post_handoff", "model": _model_name, "detail": "รอแอดมิน → ลูกค้าทักใหม่"}],
        "routing_decision": _app_module._routing(
            "handoff", "post_handoff: รอแอดมิน → บอทหยุดตอบ",
            handoff_reason="post_handoff_waiting",
        ),
        "image_desc": ctx.get("image_desc_out", ""),
    }


def _build_warranty_claim_response(req, ctx, answer, handoff, claim_ctx,
                                     _app_module, llm) -> dict:
    """สร้าง response สำหรับ warranty claim พร้อม handoff API call."""
    _model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _total = round(_time.time() - ctx.get("total_start", _time.time()), 2)
    _handoff_result: dict = {}
    _assigned_admin_name: str | None = None
    _assignment_reason: str | None = None
    if handoff and req.conversation_id:
        try:
            import urllib.request
            import urllib.error
            _handoff_url = os.environ.get(
                "ADMIN_HANDOFF_URL",
                "http://127.0.0.1:3000/api/admin/conversations/bot-handoff",
            )
            _handoff_payload = {
                "conversation_id": req.conversation_id,
                "shop_id": req.shop or "",
                "platform": req.platform or "shopee",
                "reason": claim_ctx.get("handoff_reason", "warranty_claim"),
                "simulate": req.simulate_assignment,
                "claim": {
                    k: v for k, v in claim_ctx.items()
                    if k != "handoff_reason" and v
                },
            }
            _handoff_body = json.dumps(_handoff_payload).encode("utf-8")
            _handoff_req = urllib.request.Request(
                _handoff_url,
                data=_handoff_body,
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Secret": os.environ.get("CHATBOT_INTERNAL_SECRET", ""),
                },
                method="POST",
            )
            try:
                _handoff_resp = urllib.request.urlopen(_handoff_req, timeout=5)
                _handoff_result = json.loads(_handoff_resp.read().decode("utf-8"))
                _assigned_admin_name = _handoff_result.get("assigned_to_name")
                _assignment_reason = _handoff_result.get("assignment_reason")
            except urllib.error.HTTPError as _he:
                print(f"[HANDOFF-V2] HTTP error: {_he.code} {_he.reason}", file=sys.stderr)
            except Exception as _he:
                print(f"[HANDOFF-V2] error: {_he}", file=sys.stderr)
        except Exception as _e:
            print(f"[HANDOFF-V2] setup error: {_e}", file=sys.stderr)

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

    return {
        "answer": answer,
        "answer_segments": llm.split_segments(answer),
        "products": [],
        "shop": req.shop,
        "model": _model_name,
        "source": "warranty_claim_flow",
        "usage": {},
        "elapsed": _total,
        "cost": 0.0,
        "handoff_to_admin": handoff,
        "handoff_reason": claim_ctx.get("handoff_reason"),
        "handoff_claim": claim_ctx,
        "steps": ctx.get("steps", []),
        "routing_decision": _app_module._routing(
            "handoff" if handoff else "bot_reply",
            f"warranty_claim: {claim_ctx.get('handoff_reason', 'in_progress')}",
            handoff_reason=claim_ctx.get("handoff_reason"),
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
    _answer = (
        f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
        f"เพื่อดำเนินการเรื่องใบกำกับภาษีให้นะคะ "
        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
    )
    _model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
    _total = round(_time.time() - ctx.get("total_start", _time.time()), 2)
    # handoff
    if req.conversation_id:
        try:
            import urllib.request
            _handoff_url = os.environ.get(
                "ADMIN_HANDOFF_URL",
                "http://127.0.0.1:3000/api/admin/conversations/bot-handoff",
            )
            _handoff_payload = {
                "conversation_id": req.conversation_id,
                "shop_id": req.shop or "",
                "platform": req.platform or "shopee",
                "reason": "tax_invoice_request",
                "claim": {"topic": "ใบกำกับภาษี"},
            }
            _handoff_body = json.dumps(_handoff_payload).encode("utf-8")
            _handoff_req = urllib.request.Request(
                _handoff_url, data=_handoff_body,
                headers={"Content-Type": "application/json",
                         "X-Internal-Secret": os.environ.get("CHATBOT_INTERNAL_SECRET", "")},
                method="POST",
            )
            try:
                urllib.request.urlopen(_handoff_req, timeout=3)
            except Exception as _he:
                print(f"[TAX-HANDOFF-V2] failed: {_he}", file=sys.stderr)
        except Exception as _he:
            print(f"[TAX-HANDOFF-V2] error: {_he}", file=sys.stderr)
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
        "handoff_to_admin": True,
        "handoff_reason": "tax_invoice_request",
        "steps": ctx.get("steps", []),
        "routing_decision": _app_module._routing(
            "handoff", "tax_invoice: follow-up จาก history → ส่งแอดมิน",
            handoff_reason="tax_invoice_request",
        ),
        "image_desc": ctx.get("image_desc_out", ""),
    }


def _handle_first_message_claim(req, ctx, is_claim, _warranty_mod, llm, _app_module) -> dict | None:
    """State: first-message claim — claim request ไม่มี history หรือ state machine ไม่ได้จับ."""
    if not is_claim:
        return None
    _bot_name = ctx.get("bot_name", "เรา")
    _answer = (
        f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
        f"• วันที่ซื้อสินค้า\n"
        f"• เลขที่คำสั่งซื้อ\n"
        f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
        f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
        f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
        f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ {_bot_name} จะตรวจสอบและประสานงานต่อให้ค่ะ"
    )
    _claim_ctx = {"claim_topic": "เคลม/ซ่อม/ประกันสินค้า"}
    return _build_warranty_claim_response(
        req, ctx, _answer, True, _claim_ctx, _app_module, llm
    )
