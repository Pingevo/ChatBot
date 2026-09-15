"""handoffs — early handoff/detection blocks ของ legacy chat().

ย้าย verbatim จาก app.py chat():
- detect_human_request — BUG-3 fix: ลูกค้าขอคุยกับคน/แอดมิน → handoff ทันที (pre-intent)
- post_intent_handoffs — tax invoice + มอก. (TISI) handler (post-intent)

คืน dict kwargs สำหรับ ChatResponse ถ้าจับ flow ได้, None ถ้าไม่ใช่ → pipeline ต่อ.
"""
from __future__ import annotations

import re
import sys
import time as _time


def detect_human_request(req, ctx: dict) -> dict | None:
    """Human-request handoff — ย้าย verbatim จาก app.py chat() (BUG-3 fix).

    ctx keys: steps, timing_breakdown, total_start, image_desc_out, model_name
    """
    from . import llm
    from . import app as _app_module

    _steps = ctx.get("steps") or []
    _timing_breakdown = ctx.get("timing_breakdown") or {}
    _total_start = ctx.get("total_start", _time.time())
    _image_desc_out = ctx.get("image_desc_out", "")
    model_name = ctx.get("model_name", "")

    # ===== BUG-3 fix — ลูกค้าขอคุยกับคน/แอดมิน → handoff ทันที ห้ามบอทตอบเอง =====
    # ก่อนหน้านี้: ลูกค้าถาม "Admin ไม่ทำงานกันหรอคะ เมื่อไหร่จะมีมนุษย์มาตอบ"
    #   → บอทตอบ "แอดมินมาดูแลแล้วค่ะ" (เท็จ) + handoff_to_admin=null (ไม่ escalate)
    # ตอนนี้: detect คำขอคุยกับคน → ส่งต่อแอดมินจริง + ตอบว่า "เดี๋ยวส่งต่อให้แอดมินนะคะ"
    _HUMAN_REQUEST_KWS = (
        "ขอคุยกับคน", "ขอคุยกับแอดมิน", "ขอแอดมิน", "ขอคน", "มีคนตอบไหม",
        "มีคนไหม", "มีมนุษย์ไหม", "มนุษย์ตอบ", "มนุษย์มาตอบ", "คนตอบหน่อย",
        "admin มา", "admin ตอบ", "แอดมินมา", "แอดมินตอบ", "แอดมินไม่ทำงาน",
        "ไม่มีคนตอบ", "ไม่มีแอดมิน", "เมื่อไหร่จะมีคน", "เมื่อไหร่จะมีแอดมิน",
        "เมื่อไหร่จะมีมนุษย์", "อยากคุยกับคน", "อยากคุยกับแอดมิน",
        "ให้คนตอบ", "ให้แอดมินตอบ", "ติดต่อแอดมิน", "ติดต่อคน",
        "พูดกับคน", "พูดกับแอดมิน", "ส่งต่อแอดมิน", "ส่งต่อคน",
        # BUG-M fix — เพิ่มคำที่ลูกค้าไทยใช้จริงแต่หลุด (จาก QA 2026-09-11)
        "กรุณาตอบกลับ", "ตอบหน่อย", "มีใครอยู่ไหม", "ยังอยู่ไหม",
        "แอดดด", "ทำไมไม่ตอบ", "หายไปไหน", "แอดมินยังไม่ตอบ",
        "คนยังไม่ตอบ", "รอแอดมิน", "รอคน", "แอดมินยังไม่มา",
        "ทำไมไม่มีคน", "ทำไมไม่มีแอดมิน", "ขอเบอร์แอดมิน",
        "ติดต่อกลับด่วน", "ติดต่อกลับหน่อย", "กลับหน่อย",
    )
    _msg_low = (req.message or "").lower().replace("ำ", "ัม")
    _is_human_request = any(kw in _msg_low for kw in _HUMAN_REQUEST_KWS)
    # BUG-M fix — "แอด" คำเรียกแอดมินที่สั้นและใช้บ่อยที่สุด แต่ต้องกัน false positive
    #   ("แอดเพื่อน", "แอดไลน์", "แอดเดรส") → ใช้เฉพาะข้อความสั้นที่ไม่มีคำต่อท้าย
    if not _is_human_request:
        _msg_stripped = _msg_low.strip()
        if (
            len(_msg_stripped) <= 15
            and "แอด" in _msg_stripped
            and not any(w in _msg_stripped for w in (
                "แอดเพื่อน", "แอดไลน์", "แอดเดรส", "แอดเคาท์",
                "แอดมิชั่น", "แอดปโน", "แอดมิน",  # แอดมิน already covered above
            ))
        ):
            _is_human_request = True
    if _is_human_request:
        _human_answer = (
            f"ขออภัยที่ให้รอนะคะ เดี๋ยวส่งต่อแชทนี้ให้แอดมินดูแลให้นะคะ "
            f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
        )
        _total_elapsed = _time.time() - _total_start

        # ส่งต่อแอดมิน (best-effort) — เหมือน tax invoice handoff
        if req.conversation_id:
            _app_module._send_handoff(req, None, reason="human_request",
                          claim={"topic": "ลูกค้าขอคุยกับแอดมิน"}, log_tag="HUMAN-HANDOFF")
        print(f"[TIMING] HUMAN-HANDOFF: {_total_elapsed:.2f}s", file=sys.stderr)
        return dict(
            answer=_human_answer,
            answer_segments=llm.split_segments(_human_answer),
            products=[],
            shop=req.shop,
            model=model_name,
            source="human_request_handoff",
            usage={},
            elapsed=round(_total_elapsed, 2),
            cost=0.0,
            handoff_to_admin=True,
            handoff_reason="human_request",
            timing=_timing_breakdown,
            steps=_steps,
            routing_decision=_app_module._routing(
                "handoff", "human_request: ลูกค้าขอคุยกับคน → ส่งแอดมิน",
                handoff_reason="human_request",
            ),
            image_desc=_image_desc_out,
        )
    return None


def post_intent_handoffs(req, ctx: dict, db) -> dict | None:
    """Tax invoice + TISI handlers — ย้าย verbatim จาก app.py chat() (post-intent).

    ctx keys: is_tax_invoice, bot_name, steps, timing_breakdown,
    total_start, image_desc_out, model_name
    """
    from . import llm
    from . import product_store
    from . import warranty
    from . import app as _app_module

    _is_tax_invoice = ctx.get("is_tax_invoice", False)
    _bot_name = ctx.get("bot_name", "ทางร้าน")
    _steps = ctx.get("steps") or []
    _timing_breakdown = ctx.get("timing_breakdown") or {}
    _total_start = ctx.get("total_start", _time.time())
    _image_desc_out = ctx.get("image_desc_out", "")
    model_name = ctx.get("model_name", "")

    # ===== Tax invoice → handoff แอดมินเลย (หลัง intent classification) =====
    # ถ้าลูกค้าขอใบกำกับภาษี หรือส่งข้อมูลใบกำกับภาษี → ส่งแอดมินโดยตรง
    # ไม่ต้องให้บอทตอบเอง เพราะใบกำกับภาษีต้องแอดมินดำเนินการ
    # ⚡ Phase 6 — ย้ายมาหลัง intent classification เพื่อให้ intent_result มีส่วนร่วม
    #   แต่ keyword detection ยังจับ data submission (เลขผู้เสียภาษี/หจก.) ที่ intent อาจไม่จับ
    if _is_tax_invoice:
        _tax_answer = (
            f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
            f"เพื่อดำเนินการเรื่องใบกำกับภาษีให้นะคะ "
            f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
        )
        _total_elapsed = _time.time() - _total_start

        # ส่งต่อแอดมิน (best-effort)
        if req.conversation_id:
            _app_module._send_handoff(req, None, reason="tax_invoice_request",
                          claim={"topic": "ใบกำกับภาษี"}, log_tag="TAX-HANDOFF")
        print(f"[TIMING] TAX-HANDOFF: {_total_elapsed:.2f}s", file=sys.stderr)
        return dict(
            answer=_tax_answer,
            answer_segments=llm.split_segments(_tax_answer),
            products=[],
            shop=req.shop,
            model=model_name,
            source="tax_invoice_handoff",
            usage={},
            elapsed=round(_total_elapsed, 2),
            cost=0.0,
            handoff_to_admin=True,
            handoff_reason="tax_invoice_request",
            timing=_timing_breakdown,
            steps=_steps,
            routing_decision=_app_module._routing(
                "handoff", "tax_invoice: ลูกค้าขอใบกำกับภาษี → ส่งแอดมิน",
                handoff_reason="tax_invoice_request",
            ),
            image_desc=_image_desc_out,
        )

    # ===== มอก. (TISI standard) question handler =====
    # ถ้าลูกค้าถามเรื่อง มอก. → ค้นสินค้าใน DB ที่มี มอก. ใน description
    # - ถ้าเจอ → ตอบว่ามี รุ่นไหนบ้าง (หรือรุ่นที่เจาะจงถาม)
    # - ถ้าไม่เจอ → ส่งเรื่องให้แอดมิน + handoff
    if warranty.detect_tisi_question(req.message):
        _tisi_model_kw = warranty.extract_tisi_model_keyword(req.message)
        print(f"[TISI] มอก. question detected, model_keyword={_tisi_model_kw!r}", file=sys.stderr)
        try:
            _tisi_products = product_store.search_tisi_products(
                db,
                shop_filter=req.shop,
                model_keyword=_tisi_model_kw or None,
                limit=30,
            )
        except Exception as _te:
            print(f"[TISI] search error: {_te}", file=sys.stderr)
            _tisi_products = []

        if _tisi_products:
            # สร้างคำตอบ — แสดงรุ่นที่มี มอก.
            _tisi_names = []
            for p in _tisi_products:
                _name = p.get("name", "")
                # ตัด prefix ราคา/โค้ดออกจากชื่อ (เช่น "[ราคาพิเศษ 1990บ.] PowerConnex..." → "PowerConnex...")
                _clean_name = re.sub(r"^\[.*?\]\s*", "", _name).strip()
                _tisi_names.append(_clean_name)
            if _tisi_model_kw:
                # ลูกค้าเจาะจงรุ่น → ตอบเฉพาะรุ่นนั้น
                if len(_tisi_names) == 1:
                    _tisi_answer = (
                        f"ค่ะ สินค้า{_tisi_names[0]} มี มอก. (มาตรฐานผลิตภัณฑ์อุตสาหกรรม) ค่ะ "
                        f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                    )
                else:
                    _tisi_list = "\n".join(f"• {n}" for n in _tisi_names)
                    _tisi_answer = (
                        f"ค่ะ สินค้าที่มี มอก. ในร้าน ได้แก่:\n{_tisi_list}\n\n"
                        f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                    )
            else:
                # ลูกค้าถามทั่วไป "รุ่นไหนมี มอก. บ้าง" → แสดงรุ่นทั้งหมด
                _tisi_list = "\n".join(f"• {n}" for n in _tisi_names)
                _tisi_answer = (
                    f"ค่ะ สินค้าที่มี มอก. (มาตรฐานผลิตภัณฑ์อุตสาหกรรม) ในร้าน ได้แก่:\n"
                    f"{_tisi_list}\n\n"
                    f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                )
            _total_elapsed = _time.time() - _total_start

            print(f"[TISI] found {len(_tisi_products)} products with มอก.", file=sys.stderr)
            return dict(
                answer=_tisi_answer,
                answer_segments=llm.split_segments(_tisi_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="tisi_answer",
                usage={},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                handoff_to_admin=False,
                timing=_timing_breakdown,
                steps=_steps,
                routing_decision=_app_module._routing(
                    "tisi", f"มอก.: เจอ {len(_tisi_products)} สินค้า → ตอบ",
                ),
                image_desc=_image_desc_out,
            )
        else:
            # ไม่พบสินค้าที่มี มอก. → ส่งเรื่องให้แอดมิน + handoff
            _tisi_handoff_answer = (
                f"ขออภัยค่ะ {_bot_name} ไม่พบข้อมูล มอก. ของสินค้าในระบบ "
                f"เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
                f"เพื่อตรวจสอบข้อมูล มอก. ให้นะคะ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
            _total_elapsed = _time.time() - _total_start

            # ส่งต่อแอดมิน (best-effort)
            if req.conversation_id:
                _app_module._send_handoff(req, None, reason="tisi_not_found",
                              claim={"topic": "สอบถาม มอก. (TISI)"}, log_tag="TISI-HANDOFF")
            print(f"[TISI] no products with มอก. found → handoff to admin", file=sys.stderr)
            return dict(
                answer=_tisi_handoff_answer,
                answer_segments=llm.split_segments(_tisi_handoff_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="tisi_handoff",
                usage={},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                handoff_to_admin=True,
                handoff_reason="tisi_not_found",
                timing=_timing_breakdown,
                steps=_steps,
                routing_decision=_app_module._routing(
                    "handoff", "มอก.: ไม่พบสินค้าที่มี มอก. → ส่งแอดมิน",
                    handoff_reason="tisi_not_found",
                ),
                image_desc=_image_desc_out,
            )
    return None
