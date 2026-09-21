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
        "ขอคุยกับคน", "ขอคุยกับแอดมิน", "ขอแอดมิน", "มีคนตอบไหม",
        "มีคนไหม", "มีมนุษย์ไหม", "มนุษย์ตอบ", "มนุษย์มาตอบ", "คนตอบหน่อย",
        "admin มา", "admin ตอบ", "แอดมินมา", "แอดมินตอบ", "แอดมินไม่ทำงาน",
        "ไม่มีคนตอบ", "ไม่มีแอดมิน", "เมื่อไหร่จะมีคน", "เมื่อไหร่จะมีแอดมิน",
        "เมื่อไหร่จะมีมนุษย์", "อยากคุยกับคน", "อยากคุยกับแอดมิน",
        "ให้คนตอบ", "ให้แอดมินตอบ", "ติดต่อแอดมิน",
        "พูดกับแอดมิน", "ส่งต่อแอดมิน",
        # ⚡ "ขอคน"/"ติดต่อคน"/"พูดกับคน"/"ส่งต่อคน" ย้ายไป composition (มี guard กัน "คนละ"/"คนขับ")
        # BUG-M fix — เพิ่มคำที่ลูกค้าไทยใช้จริงแต่หลุด (จาก QA 2026-09-11)
        "กรุณาตอบกลับ", "ตอบหน่อย", "มีใครอยู่ไหม", "ยังอยู่ไหม",
        "แอดดด", "ทำไมไม่ตอบ", "หายไปไหน", "แอดมินยังไม่ตอบ",
        "คนยังไม่ตอบ", "รอแอดมิน", "รอคน", "แอดมินยังไม่มา",
        "ทำไมไม่มีคน", "ทำไมไม่มีแอดมิน", "ขอเบอร์แอดมิน",
        "ติดต่อกลับด่วน", "ติดต่อกลับหน่อย", "กลับหน่อย",
    )
    _msg_low = (req.message or "").lower().replace("ำ", "ัม")
    _is_human_request = any(kw in _msg_low for kw in _HUMAN_REQUEST_KWS)
    # ⚡ BUG-M phase 2 — composition: (verb + target) ครอบ phrasing ใหม่โดยไม่ต้องเพิ่มทีละเคส
    #   เคส QA ที่หลุด: "ติดต่อเจ้าหน้าที่" / "แชทกับเจ้าหน้าที่" / "ติดต่อร้านค้า"
    #   gap [กับหาด่วน]{0,6} รองรับ "ขอคุยกับแอดมิน" / "โทรหาเจ้าหน้าที่" / "แชทกับพนักงาน"
    _HUMAN_VERB_RE = (
        r"(?:ติดต่อ|โทรหา|โทร|คุยกับ|คุย|แชทกับ|แชท|พูดคุยกับ|พูดคุย|พูดกับ|พูด"
        r"|ขอคุย|ขอพูด|ขอแชท|ขอ|ส่งต่อ|ให้|อยากคุย|อยากพูด|อยากแชท|อยาก)"
    )
    #   target "คน" ต้องกัน "คนละ"/"คนขับ"/"คนส่ง" (คำทั่วไป ไม่ใช่ขอคุยกับคน)
    _HUMAN_TARGET_RE = r"(?:เจ้าหน้าที่|พนักงาน|ทีมงาน|แอดมิน|admin|มนุษย์|human|agent|staff|คนจริง|ตัวคน|คน(?!ละ|ขับ|ส่ง|รับ))"
    if not _is_human_request and re.search(
        _HUMAN_VERB_RE + r"[กับหาด่วน]{0,6}\s*" + _HUMAN_TARGET_RE, _msg_low
    ):
        _is_human_request = True
    # "ร้าน" เป็น target เฉพาะ contact-verbs — "คุยเรื่องร้าน" ไม่ใช่ขอคุยกับคน
    if not _is_human_request and re.search(r"(?:ติดต่อ|โทรหา|โทร|ขอเบอร์)\S{0,6}ร้าน", _msg_low):
        _is_human_request = True
    # English — "talk to human" / "speak to agent" / "contact staff" / "real person"
    if not _is_human_request and re.search(
        r"(?:talk|speak|chat|call|contact|connect)\W{0,5}(?:to\W{0,5})?(?:a\W{0,5})?"
        r"(?:human|agent|staff|admin|person|someone|real)",
        _msg_low,
    ):
        _is_human_request = True
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
    # ⚡ BUG-M part D — ลูกค้าโกรธ/ผิดหวัง → escalate ให้คนจริง
    #   เคส QA: "เห้ยช้าว่ะ จำไม่ได้เว้ย" / "ผิดหวังมากกกกกค่ะ" / "หัวร้อนแล้วนะ"
    #   composition ไม่ใช่ flat kw:
    #   - strong marker เดี่ยวพอ ("ผิดหวัง", "หัวร้อน", "ตีของกลับ")
    #   - mild marker ต้องมากับคำหยาบ/คำเน้นบ่น ("ช้ามากว่ะ", "นานมากกก") —
    #     กัน "ส่งช้าไหม" (คำถาม) หลุดเป็น anger
    _is_angry = False
    _STRONG_ANGER = (
        "เห้ย", "เฮ้ย", "หัวร้อน", "โกรธ", "โมโห", "ผิดหวัง", "เซ็ง",
        "รำคาญ", "ห่วย", "กาก", "แย่มาก", "แย่จริง", "แย่จัง", "แย่สุด",
        "แย่ที่สุด", "ไม่ไหวแล้ว", "ตีของกลับ", "ไม่เอาแล้ว",
        "เลวร้าย", "แย่เอามาก", "worst",
    )
    _MILD_ANGER = (
        "ช้ามาก", "ช้าจัง", "ช้าเกิน", "ช้าสุด", "นานมาก", "นานเกิน",
        "รอนาน", "ไม่ตอบเลย", "ตอบช้า", "เงียบหาย", "ไม่มีคนตอบ",
        "ไม่มีใครตอบ", "ไม่มีการตอบ", "ช้าว่ะ", "ช้าเว้ย",
    )
    if any(kw in _msg_low for kw in _STRONG_ANGER):
        _is_angry = True
    elif any(kw in _msg_low for kw in _MILD_ANGER):
        _is_angry = True
    # question-guard — ถามจริง ("ช้ามากไหม" / "รอนานไหมคะ") ไม่ใช่บ่น → ไม่ escalate
    #   (ใช้เฉพาะ mild marker; strong marker เช่น "ผิดหวังไหม" แทบไม่มีในการใช้จริง)
    if _is_angry and not any(kw in _msg_low for kw in _STRONG_ANGER):
        if re.search(
            r"(ไหม|มั้ย|หรอ|เหรอ|รึเปล่า|หรือเปล่า|ป่าว|บ้าง|แค่ไหน|เท่าไหร่|เท่าไหน|กี่วัน|กี่ชั่วโมง|เมื่อไหร่|เมื่อไหน|ตอนไหน|รึ)[คะค่ะครับ\s\?]*$",
            _msg_low,
        ):
            _is_angry = False

    if _is_human_request or _is_angry:
        _reason = "human_request" if _is_human_request else "customer_frustration"
        _topic = "ลูกค้าขอคุยกับแอดมิน" if _is_human_request else "ลูกค้าไม่พอใจ/โกรธ"
        _human_answer = (
            f"ขออภัยที่ให้รอนะคะ เดี๋ยวส่งต่อแชทนี้ให้แอดมินดูแลให้นะคะ "
            f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            if _is_human_request else
            f"ขออภัยที่ทำให้ไม่พอใจนะคะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
            f"ดูแลให้โดยเร็วนะคะ รบกวนรอการติดต่อกลับอีกครั้งนะคะ"
        )
        _total_elapsed = _time.time() - _total_start

        # ส่งต่อแอดมิน (best-effort) — เหมือน tax invoice handoff
        if req.conversation_id:
            _app_module._send_handoff(req, None, reason=_reason,
                          claim={"topic": _topic}, log_tag="HUMAN-HANDOFF")
        print(f"[TIMING] HUMAN-HANDOFF({_reason}): {_total_elapsed:.2f}s", file=sys.stderr)
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
            handoff_reason=_reason,
            timing=_timing_breakdown,
            steps=_steps,
            routing_decision=_app_module._routing(
                "handoff", f"{_reason}: {_topic} → ส่งแอดมิน",
                handoff_reason=_reason,
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

    # ===== cert standards question handler (มอก./CE/CCC/FCC/RoHS/GB) =====
    # ถ้าลูกค้าถามเรื่องมาตรฐาน → ค้นสินค้าใน DB (description + image_texts)
    # - ถ้าเจอ → ตอบว่ามี รุ่นไหนบ้าง (หรือรุ่นที่เจาะจงถาม)
    # - ถ้าไม่เจอ → ส่งเรื่องให้แอดมิน + handoff
    _certs = warranty.detect_cert_question(req.message)
    if _certs:
        _cert_label = "/".join({"tisi": "มอก."}.get(c, c.upper()) for c in _certs)
        _tisi_model_kw = warranty.extract_tisi_model_keyword(req.message)
        # หมวดสินค้าที่ลูกค้าระบุ (เช่น "พาวแบง มี มอก ไหม" → {"powerbank"})
        # ใช้กรองผล cert search — กันเคสตอบ surge module/จักรยาน สำหรับคำถาม powerbank
        # ใช้เฉพาะคำถามทั่วไป (ไม่มี model_keyword — เจาะจงรุ่นอยู่แล้วไม่ต้องกรองหมวด)
        _cert_types = product_store._detect_product_types(req.message) if not _tisi_model_kw else set()
        print(f"[CERT] cert question detected certs={_certs}, model_keyword={_tisi_model_kw!r}, types={_cert_types}", file=sys.stderr)
        _cert_fallback_products = []
        try:
            _tisi_products = product_store.search_cert_products(
                db,
                _certs,
                shop_filter=req.shop,
                model_keyword=_tisi_model_kw or None,
                limit=30,
                type_filter=_cert_types or None,
            )
            if not _tisi_products and _cert_types:
                # ไม่เจอในหมวดที่ถาม → ค้นไม่จำกัดหมวด เพื่อตอบ "ไม่พบในหมวดนี้ แต่มีอันอื่น"
                _cert_fallback_products = product_store.search_cert_products(
                    db,
                    _certs,
                    shop_filter=req.shop,
                    model_keyword=None,
                    limit=30,
                )
        except Exception as _te:
            print(f"[TISI] search error: {_te}", file=sys.stderr)
            _tisi_products = []

        _TYPE_TH = {
            "powerbank": "พาวเวอร์แบงค์", "charger": "อุปกรณ์ชาร์จ",
            "phone": "โทรศัพท์", "earphone": "หูฟัง", "smartwatch": "สมาร์ทวอช",
            "smartband": "สมาร์ทแบนด์", "case": "เคส", "camera": "กล้อง",
            "speaker": "ลำโพง", "tablet": "แท็บเล็ต", "memory_card": "เมมโมรี่การ์ด",
        }
        _type_th = "/".join(_TYPE_TH.get(t, t) for t in sorted(_cert_types))

        if _tisi_products or _cert_fallback_products:
            # สร้างคำตอบ — แสดงรุ่นที่มี cert ที่ถาม
            _tisi_names = []
            for p in (_tisi_products or _cert_fallback_products):
                _name = p.get("name", "")
                # ตัด prefix ราคา/โค้ดออกจากชื่อ (เช่น "[ราคาพิเศษ 1990บ.] PowerConnex..." → "PowerConnex...")
                _clean_name = re.sub(r"^\[.*?\]\s*", "", _name).strip()
                _tisi_names.append(_clean_name)
            if _tisi_model_kw:
                # ลูกค้าเจาะจงรุ่น → ตอบเฉพาะรุ่นนั้น
                if len(_tisi_names) == 1:
                    # stock DB มีเลข มอก./ใบอนุญาตจริง → แสดงเฉพาะตอนถาม มอก.
                    # (cert_ids เป็น metadata รวม — คำถาม CE/CCC ไม่แปะเลข มอก. กันสับสน)
                    _cids = (_tisi_products[0].get("cert_ids") or {}) if _tisi_products else {}
                    _cids_txt = ""
                    if _cids.get("tis_id") and "tisi" in _certs:
                        _cids_txt = f" (เลข มอก. {_cids['tis_id']}"
                        if _cids.get("tis_license_id"):
                            _cids_txt += f" ใบอนุญาต {_cids['tis_license_id']}"
                        _cids_txt += ")"
                    _tisi_answer = (
                        f"ค่ะ สินค้า{_tisi_names[0]} มี {_cert_label}{_cids_txt} ค่ะ "
                        f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                    )
                else:
                    _tisi_list = "\n".join(f"• {n}" for n in _tisi_names)
                    _tisi_answer = (
                        f"ค่ะ สินค้าที่มี {_cert_label} ในร้าน ได้แก่:\n{_tisi_list}\n\n"
                        f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                    )
            elif not _tisi_products and _cert_fallback_products:
                # ไม่เจอในหมวดที่ถาม → ตอบตรงๆ + เสนอสินค้าหมวดอื่นที่มี cert
                _tisi_list = "\n".join(f"• {n}" for n in _tisi_names)
                _tisi_answer = (
                    f"ค่ะ สำหรับ{_type_th} ยังไม่พบข้อมูล {_cert_label} ในระบบค่ะ "
                    f"แต่สินค้าอื่นที่มี {_cert_label} ได้แก่:\n"
                    f"{_tisi_list}\n\n"
                    f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                )
            else:
                # ลูกค้าถามทั่วไป "รุ่นไหนมี X บ้าง" → แสดงรุ่นทั้งหมด
                _tisi_list = "\n".join(f"• {n}" for n in _tisi_names)
                _tisi_answer = (
                    f"ค่ะ สินค้าที่มี {_cert_label} ในร้าน ได้แก่:\n"
                    f"{_tisi_list}\n\n"
                    f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
                )
            _total_elapsed = _time.time() - _total_start

            _cert_n = len(_tisi_products) if _tisi_products else len(_cert_fallback_products)
            print(f"[CERT] found {_cert_n} products with {_cert_label}"
                  f"{' (fallback: นอกหมวดที่ถาม)' if not _tisi_products else ''}", file=sys.stderr)
            return dict(
                answer=_tisi_answer,
                answer_segments=llm.split_segments(_tisi_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="cert_answer",
                usage={},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                handoff_to_admin=False,
                timing=_timing_breakdown,
                steps=_steps,
                routing_decision=_app_module._routing(
                    "cert", f"{_cert_label}: เจอ {_cert_n} สินค้า → ตอบ",
                ),
                image_desc=_image_desc_out,
            )
        else:
            # ไม่พบสินค้าที่มี cert ที่ถาม → ส่งเรื่องให้แอดมิน + handoff
            _tisi_handoff_answer = (
                f"ขออภัยค่ะ {_bot_name} ไม่พบข้อมูล {_cert_label} ของสินค้าในระบบ "
                f"เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
                f"เพื่อตรวจสอบข้อมูล {_cert_label} ให้นะคะ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
            _total_elapsed = _time.time() - _total_start

            # ส่งต่อแอดมิน (best-effort)
            if req.conversation_id:
                _app_module._send_handoff(req, None, reason="cert_not_found",
                              claim={"topic": f"สอบถาม {_cert_label}"}, log_tag="CERT-HANDOFF")
            print(f"[CERT] no products with {_cert_label} found → handoff to admin", file=sys.stderr)
            return dict(
                answer=_tisi_handoff_answer,
                answer_segments=llm.split_segments(_tisi_handoff_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="cert_handoff",
                usage={},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                handoff_to_admin=True,
                handoff_reason="cert_not_found",
                timing=_timing_breakdown,
                steps=_steps,
                routing_decision=_app_module._routing(
                    "handoff", f"{_cert_label}: ไม่พบสินค้าที่มี {_cert_label} → ส่งแอดมิน",
                    handoff_reason="cert_not_found",
                ),
                image_desc=_image_desc_out,
            )
    return None
