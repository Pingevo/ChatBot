"""order_flow — order/tracking/return-refund early flow ของ legacy chat().

ย้าย verbatim จาก app.py chat() (เดิม ~L969-1468):
- Order lookup — ลูกค้าส่งเลขคำสั่งซื้อ / [order: XXX] / req.order_sn / order anchor
- Return/refund + address request → handoff แอดมิน
- Tracking lookup — เลขพัสดุจากข้อความหรือ vision description

คืน dict kwargs สำหรับ ChatResponse ถ้าจับ flow ได้, None ถ้าไม่ใช่ → pipeline ต่อ.
เขียนกลับ ctx["order_sn"], ctx["is_claim_request_pre"] ให้ warranty auto-check ใช้ต่อ.
"""
from __future__ import annotations

import re
import sys
import time as _time

from fastapi import HTTPException


def early_order_flow(req, ctx: dict, history: list[dict], db) -> dict | None:
    """Order/tracking/return-refund early flow — ย้าย verbatim จาก app.py chat().

    ctx keys: qa10, steps, total_start, persona_extra, vision_context,
    image_desc_out, model_name
    """
    from . import llm
    from . import app as _app_module

    _qa10 = ctx.get("qa10") or []
    _steps = ctx.get("steps") or []
    _total_start = ctx.get("total_start", _time.time())
    _persona_extra = ctx.get("persona_extra", "")
    _vision_context = ctx.get("vision_context", "")
    _image_desc_out = ctx.get("image_desc_out", "")
    model_name = ctx.get("model_name", "")
    # ===== Order lookup — ลูกค้าส่งเลขคำสั่งซื้อ หรือ [order: XXX] =====
    # ดึงข้อมูล order จาก MongoDB (read-only) แล้วส่งให้ LLM ตอบ
    # ⚡ ข้ามถ้าอยู่ใน warranty claim flow (บอทเคยขอ วันที่+order+รูป)
    # ⚡ Phase 1C — ข้ามถ้าเป็น claim request (ลูกค้าถามเคลม + มี order_sn → ไป warranty auto-check)
    # ⚡ Phase 3C — ถ้าไม่มี order_sn ในข้อความ แต่เป็น order question → ใช้ active order anchor
    from . import order_store as _order_store
    from . import warranty
    _order_sn = _order_store.extract_order_sn(req.message)
    # ⚡ Phase 3C — ถ้า caller ส่ง order_sn มาตรงๆ (เช่น live-assignment, test-assignment, testchat) → ใช้เลย
    if not _order_sn and req.order_sn:
        _order_sn = str(req.order_sn).strip() or None
        if _order_sn:
            print(f"[ORDER] ใช้ order_sn จาก req.order_sn: {_order_sn}", file=sys.stderr)
    _order_sn_from_anchor = False  # ⚡ Phase 3C — mark ว่า order_sn มาจาก anchor ไม่ใช่จาก message
    _in_claim_flow = False
    _is_claim_request_pre = warranty.detect_claim_request(req.message) if _order_sn else False
    if _order_sn and _is_claim_request_pre:
        _in_claim_flow = True
        print(f"[ORDER] ข้าม order_lookup เพราะเป็น claim request → ไป warranty auto-check", file=sys.stderr)
    if _order_sn and not _in_claim_flow and history:
        _last_model_msgs = [h for h in history if h.get("role") == "model"][-1:]
        _last_model_text_check = " ".join(h.get("text", "") for h in _last_model_msgs).lower()
        if (any(kw in _last_model_text_check for kw in ("วันที่ซื้อ", "ซื้อวันที่", "purchase date"))
            and any(kw in _last_model_text_check for kw in ("เลขที่คำสั่งซื้อ", "หมายเลขคำสั่งซื้อ", "order number", "คำสั่งซื้อ"))
            and any(kw in _last_model_text_check for kw in ("รูป", "วิดีโอ", "photo", "video", "แสดงอาการ", "ความเสียหาย"))):
            _in_claim_flow = True
            print(f"[ORDER] ข้าม order_lookup เพราะอยู่ใน claim flow", file=sys.stderr)

    # ⚡ Phase 3C — ถ้าไม่มี order_sn ในข้อความ แต่เป็น order question → ใช้ active order anchor
    #    ตัวอย่าง: ลูกค้าส่ง order card รอบแรก → รอบสองถาม "order ถึงยัง" → ใช้ anchor
    if not _order_sn and not _in_claim_flow and req.conversation_id:
        from . import conversation_products as _cp_order
        if _cp_order.is_order_question(req.message):
            _anchor_sn = _cp_order.resolve_active_order_sn(req.conversation_id, req.message)
            if _anchor_sn:
                _order_sn = _anchor_sn
                _order_sn_from_anchor = True
                print(f"[ORDER] ใช้ order anchor: order_sn={_order_sn} (from anchor, not message)", file=sys.stderr)

    # ===== Return/refund request → handoff แอดมิน =====
    # ถ้าลูกค้าขอคืนของ/ตีกลับ/คืนเงิน → ส่งแอดมิน (เคส sensitive ลูกค้าอารมณ์เสีย)
    # ถ้ามี order_sn (จาก message หรือ anchor) → lookup order + save anchor + handoff
    # ถ้าไม่มี order_sn → ถามเลขคำสั่งซื้อก่อน (ลูกค้าให้มา → handoff ในรอบถัดไป)
    # ⚡ Follow-up: ถ้า bot เคยถามเลข order (return/refund context) + ลูกค้าส่งเลขมา → handoff
    _RETURN_REFUND_KWS = (
        # คืนของ/ตีกลับ
        "ตีกลับ", "ตีของกลับ", "ตีของ", "คืนของ", "คืนสินค้า",
        "ขอคืนของ", "ขอคืนสินค้า", "ขอตีกลับ", "ตีกลับเลย",
        "ส่งกลับ", "ส่งคืน", "return to sender",
        # คืนเงิน/ขอเงินคืน
        "คืนเงิน", "ขอคืนเงิน", "ขอเงินคืน", "เงินคืน",
        "คืนเงินให้", "ขอคืนเงินให้", "เอาเงินคืน", "ทวงเงินคืน",
        "refund", "เงินคืนให้หน่อย", "ขอเงินคืนหน่อย",
        # ไม่รับสินค้าแล้ว
        "ไม่รับของแล้ว", "ไม่รับสินค้าแล้ว", "ไม่รับแล้ว",
        "ไม่รับพัสดุแล้ว", "ไม่รับการจัดส่ง", "ไม่เอาของแล้ว",
        "ไม่เอาสินค้าแล้ว", "ไม่ต้องการสินค้าแล้ว", "ไม่ต้องการของแล้ว",
        "ปฏิเสธรับสินค้า", "ปฏิเสธรับของ", "ไม่รับพัสดุ",
        # ไม่ทัน/เลยกำหนด
        "ไม่ทันใช้", "ไม่ทันกำหนด", "ของไม่ทัน", "ไม่ทันเวลา",
        # ยกเลิก/ไม่เอาแล้ว
        "ไม่เอาแล้ว", "ยกเลิกออเดอร์", "ยกเลิกคำสั่งซื้อ",
        "ยกเลิกสินค้า", "ยกเลิกการสั่งซื้อ", "ไม่สั่งแล้ว",
    )
    _msg_lower_rr = (req.message or "").lower()
    _is_return_refund = any(kw in _msg_lower_rr for kw in _RETURN_REFUND_KWS)
    # ⚡ ขอที่อยู่ส่งกลับ/ส่งเคลม/ที่อยู่ร้าน → handoff แอดมินทันที (bot ไม่มีที่อยู่จริงของร้าน)
    #    เคสจริง: "ขอที่อยู่ส่งกลบ" / "ต้องการที่อยู่ด่วน" / "ขอที่อยู่ส่งเคลม"
    #    ลูกค้าต้องการที่อยู่เพื่อส่งสินค้ากลับ/ส่งเคลม → bot ไม่มีข้อมูลนี้ → ส่งแอดมินเลย
    #    ไม่ต้องถามเลขคำสั่งซื้อก่อน เพราะลูกค้าแค่ขอที่อยู่
    _ADDRESS_REQUEST_KWS = (
        "ขอที่อยู่", "ที่อยู่ร้าน", "ที่อยู่ส่งกลับ", "ที่อยู่ส่งกลบ",
        "ที่อยู่ส่งเคลม", "ที่อยู่ส่งคืน", "ที่อยู่ด่วน",
        "ต้องการที่อยู่", "ขอสถานที่ส่ง", "ส่งไปที่ไหน", "จะส่งไปที่ไหน",
        "ที่อยู่สำหรับส่งกลับ", "ที่อยู่สำหรับส่งเคลม",
        "address ส่งกลับ", "return address", "claim address",
    )
    _is_address_request = any(kw in _msg_lower_rr for kw in _ADDRESS_REQUEST_KWS)

    # ⚡ Follow-up check: bot เคยถามเลข order ใน return/refund context + ลูกค้าส่งเลขมา
    _is_rr_followup = False
    if not _is_return_refund and _order_sn and history and not _in_claim_flow:
        _last_model_msgs_rr = [h for h in history if h.get("role") == "model"][-1:]
        _last_model_text_rr = " ".join(h.get("text", "") for h in _last_model_msgs_rr).lower()
        if any(_rr_kw in _last_model_text_rr for _rr_kw in (
            "คืนสินค้า", "คืนของ", "คืนเงิน", "ตีกลับ",
            "ไม่รับสินค้า", "ไม่รับของ", "ไม่รับพัสดุ",
            "ยกเลิก", "เงินคืน",
        )) and "เลขคำสั่งซื้อ" in _last_model_text_rr:
            _is_rr_followup = True
            print(f"[RETURN-REFUND] follow-up: bot asked for order_sn + customer sent {_order_sn}", file=sys.stderr)

    if _is_address_request and not _in_claim_flow:
        # ⚡ ขอที่อยู่ส่งกลับ/ส่งเคลม → handoff แอดมินทันที (ไม่ต้องถามเลขคำสั่งซื้อ)
        #    bot ไม่มีที่อยู่จริงของร้าน → ส่งแอดมินเลย
        print(f"[ADDRESS-REQUEST] handoff admin immediately (no order_sn needed)", file=sys.stderr)
        _addr_answer = (
            f"เรื่องที่อยู่ร้าน/ที่อยู่ส่งสินค้ากลับ/ส่งเคลม รบกวนส่งต่อแชทนี้ให้แอดมินดูแลให้นะคะ "
            f"เดี๋ยวแอดมินจะแจ้งที่อยู่ที่ถูกต้องและดำเนินการต่อให้ "
            f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งค่ะ"
        )
        _total_elapsed = _time.time() - _total_start

        # handoff แอดมิน
        if req.conversation_id:
            _app_module._send_handoff(req, None, reason="address_request",
                          claim={"topic": "ขอที่อยู่ส่งกลับ/ส่งเคลม"}, log_tag="ADDRESS-REQUEST")
        _steps.append({
            "name": "address_request_handoff",
            "model": model_name,
            "tokens_in": 0, "tokens_out": 0,
            "time_s": round(_total_elapsed, 2),
            "cost_usd": 0.0, "cost_thb": 0.0,
            "detail": "address_request: handoff admin (no order_sn needed)",
        })
        return dict(
            answer=_addr_answer,
            answer_segments=llm.split_segments(_addr_answer),
            products=[],
            shop=req.shop,
            model=model_name,
            source="address_request_handoff",
            usage={"prompt": 0, "output": 0, "total": 0},
            elapsed=round(_total_elapsed, 2),
            cost=0.0,
            handoff_to_admin=True,
            handoff_reason="address_request",
            steps=_steps,
            routing_decision=_app_module._routing(
                "handoff", "address_request: ขอที่อยู่ส่งกลับ/ส่งเคลม → ส่งแอดมิน",
                handoff_reason="address_request",
            ),
            image_desc=_image_desc_out,
        )

    if (_is_return_refund or _is_rr_followup) and not _in_claim_flow:
        print(f"[RETURN-REFUND] detected: is_return_refund={_is_return_refund} is_followup={_is_rr_followup} order_sn={_order_sn}", file=sys.stderr)
        if _order_sn:
            # มี order_sn → lookup order + save anchor + anchor items + handoff
            _rr_order = _order_store.lookup_order(_order_sn, shop_filter=req.shop)
            if _rr_order and req.conversation_id:
                try:
                    from . import conversation_products as _cp_rr
                    _cp_rr.add_order_anchor(
                        conversation_id=req.conversation_id,
                        platform=req.platform, shop=req.shop,
                        order_sn=_order_sn, order_info=_rr_order,
                    )
                    # anchor order items as products (เหมือน order lookup block)
                    from . import product_store as _ps_rr
                    for _oi in _rr_order.get("items", []):
                        _oi_item_id = str(_oi.get("item_id", "") or "").strip()
                        _oi_name = _oi.get("name", "") or ""
                        if not _oi_item_id or not _oi_name:
                            continue
                        _oi_card = None
                        try:
                            _oi_card = _ps_rr.fetch_product_by_id(
                                db, _oi_item_id, shop_filter=req.shop,
                                desc_message="รายละเอียดสินค้า",
                            )
                        except Exception:
                            pass
                        if not _oi_card:
                            _oi_card = {
                                "item_id": _oi_item_id,
                                "name": _oi_name,
                                "price": _oi.get("price", 0),
                                "image_url": _oi.get("image_url", ""),
                            }
                        _cp_rr.add_product(
                            conversation_id=req.conversation_id,
                            platform=req.platform, shop=req.shop,
                            item_id=_oi_item_id, name=_oi_name,
                            source="user_order", card=_oi_card, is_anchor=True,
                        )
                    print(f"[RETURN-REFUND] anchored order items for order_sn={_order_sn}", file=sys.stderr)
                except Exception as _e:
                    print(f"[RETURN-REFUND] error anchoring: {_e}", file=sys.stderr)
            # handoff แอดมิน
            _rr_answer = (
                f"เรื่องคืนสินค้า/คืนเงิน/ไม่รับสินค้า ทางร้านจะดำเนินการผ่านแอดมินนะคะ "
                f"เดี๋ยวส่งต่อแชทนี้ให้แอดมินดูแลให้ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
            _total_elapsed = _time.time() - _total_start

            if req.conversation_id:
                _app_module._send_handoff(req, None, reason="return_refund_request",
                              claim={"topic": "คืนสินค้า/คืนเงิน", "order_sn": _order_sn},
                              log_tag="RETURN-REFUND")
            _steps.append({
                "name": "return_refund_handoff",
                "model": model_name,
                "tokens_in": 0, "tokens_out": 0,
                "time_s": round(_total_elapsed, 2),
                "cost_usd": 0.0, "cost_thb": 0.0,
                "detail": f"order_sn={_order_sn} return_refund_handoff",
            })
            return dict(
                answer=_rr_answer,
                answer_segments=llm.split_segments(_rr_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="return_refund_handoff",
                usage={"prompt": 0, "output": 0, "total": 0},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                handoff_to_admin=True,
                handoff_reason="return_refund_request",
                steps=_steps,
                routing_decision=_app_module._routing(
                    "handoff", f"return_refund: order_sn={_order_sn} → ส่งแอดมิน",
                    handoff_reason="return_refund_request",
                ),
                image_desc=_image_desc_out,
            )
        else:
            # ไม่มี order_sn → ถามเลขคำสั่งซื้อก่อน
            _rr_ask_answer = (
                f"เรื่องคืนสินค้า/คืนเงิน/ไม่รับสินค้า รบกวนแจ้งเลขคำสั่งซื้อให้หน่อยนะคะ "
                f"เพื่อให้ทางร้านตรวจสอบและดำเนินการต่อให้ได้ค่ะ"
            )
            _total_elapsed = _time.time() - _total_start

            _steps.append({
                "name": "return_refund_ask_order",
                "model": model_name,
                "tokens_in": 0, "tokens_out": 0,
                "time_s": round(_total_elapsed, 2),
                "cost_usd": 0.0, "cost_thb": 0.0,
                "detail": "return_refund: no order_sn → ask customer",
            })
            return dict(
                answer=_rr_ask_answer,
                answer_segments=llm.split_segments(_rr_ask_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="return_refund_ask_order",
                usage={"prompt": 0, "output": 0, "total": 0},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                steps=_steps,
                routing_decision=_app_module._routing(
                    "bot_reply", "return_refund: no order_sn → ถามเลขคำสั่งซื้อ",
                ),
                image_desc=_image_desc_out,
            )

    # ===== Phase 1B — Tracking lookup =====
    # ⚡ ถ้าไม่มี order_sn แต่มี tracking number (ในข้อความหรือ vision desc) → lookup จาก tracking
    #    รองรับ: ลูกค้าส่งรูป tracking → vision อ่านได้เลข → lookup → ตอบสถานะ
    #          ลูกค้าพิมพ์เลขพัสดุตรงๆ → lookup → ตอบสถานะ
    _tracking_no = None
    if not _order_sn and not _in_claim_flow:
        # ลองดึง tracking จากข้อความลูกค้า
        _tracking_no = _order_store.extract_tracking_number(req.message)
        # ถ้าไม่เจอในข้อความ → ลองดึงจาก vision description
        if not _tracking_no and _vision_context:
            _tracking_no = _order_store.extract_tracking_number(_vision_context)
            if _tracking_no:
                print(f"[TRACKING] พบ tracking จาก vision: {_tracking_no}", file=sys.stderr)
    if _tracking_no and not _in_claim_flow:
        print(f"[TRACKING] พบ tracking_no={_tracking_no} → lookup", file=sys.stderr)
        _tracking_order = _order_store.lookup_by_tracking(_tracking_no, shop_filter=req.shop)
        if _tracking_order:
            _order_ctx = _order_store.build_order_context(_tracking_order)
            print(f"[TRACKING] พบ order: sn={_tracking_order['order_sn']} status={_tracking_order['order_status']}", file=sys.stderr)
            _tracking_clean = re.sub(re.escape(_tracking_no), "", req.message, flags=re.IGNORECASE).strip()
            if not _tracking_clean:
                _tracking_clean = "ลูกค้าส่งเลขพัสดุมา ต้องการดูสถานะการจัดส่ง"
            try:
                _tracking_answer, _tracking_usage = llm.answer_general(
                    message=_tracking_clean,
                    context=_order_ctx,
                    qtype="order_status",
                    history=_qa10,
                    persona_extra=_persona_extra,
                )
            except RuntimeError as exc:
                raise HTTPException(status_code=500, detail=str(exc))
            _total_elapsed = _time.time() - _total_start

            prompt_t = _tracking_usage.get("prompt", 0)
            output_t = _tracking_usage.get("output", 0)
            cost = llm._gemini_cost(prompt_t, output_t)
            _steps.append({
                "name": "tracking_lookup",
                "model": model_name,
                "tokens_in": prompt_t,
                "tokens_out": output_t,
                "time_s": round(_total_elapsed, 2),
                "cost_usd": round(cost, 6),
                "cost_thb": round(cost * 36, 4),
                "detail": f"tracking_no={_tracking_no} order_sn={_tracking_order['order_sn']} status={_tracking_order['order_status']}",
            })
            return dict(
                answer=_tracking_answer,
                answer_segments=llm.split_segments(_tracking_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="tracking_lookup",
                usage=_tracking_usage,
                elapsed=round(_total_elapsed, 2),
                cost=round(cost, 6),
                steps=_steps,
                routing_decision=_app_module._routing("bot_reply", f"tracking_lookup: tracking={_tracking_no} → order={_tracking_order['order_sn']}"),
                image_desc=_image_desc_out,
            )
        else:
            print(f"[TRACKING] ไม่พบ tracking_no={_tracking_no} ในระบบ", file=sys.stderr)

    if _order_sn and not _in_claim_flow:
        print(f"[ORDER] พบ order_sn={_order_sn} ในข้อความ" + (" (from anchor)" if _order_sn_from_anchor else ""), file=sys.stderr)
        _order_info = _order_store.lookup_order(_order_sn, shop_filter=req.shop)
        if _order_info:
            _order_ctx = _order_store.build_order_context(_order_info)
            print(f"[ORDER] พบ order: status={_order_info['order_status']} items={_order_info['item_count']}", file=sys.stderr)
            # ⚡ Phase 3C — บันทึก order anchor (เก็บไว้สำหรับ follow-up)
            if req.conversation_id:
                try:
                    from . import conversation_products as _cp_save
                    _cp_save.add_order_anchor(
                        conversation_id=req.conversation_id,
                        platform=req.platform,
                        shop=req.shop,
                        order_sn=_order_sn,
                        order_info=_order_info,
                    )
                except Exception as _e:
                    print(f"[ORDER] บันทึก anchor ไม่สำเร็จ: {_e}", file=sys.stderr)
            # ⚡ Anchor order items as products — จำสินค้าใน order ไว้ใน conversation timeline
            #    เผื่อลูกค้าถามสเปคถามอะไรต่อ หรือเข้าเคสคืนเงิน/เคลม
            if req.conversation_id:
                try:
                    from . import conversation_products as _cp_items
                    from . import product_store as _ps_items
                    _anchored_count = 0
                    for _oi in _order_info.get("items", []):
                        _oi_item_id = str(_oi.get("item_id", "") or "").strip()
                        _oi_name = _oi.get("name", "") or ""
                        if not _oi_item_id or not _oi_name:
                            continue
                        # ลองดึง full product card จาก product DB
                        _oi_card = None
                        try:
                            _oi_card = _ps_items.fetch_product_by_id(
                                db, _oi_item_id, shop_filter=req.shop,
                                desc_message="รายละเอียดสินค้า",
                            )
                        except Exception:
                            pass
                        # ถ้าดึงไม่ได้ → ใช้ minimal card จาก order info
                        if not _oi_card:
                            _oi_card = {
                                "item_id": _oi_item_id,
                                "name": _oi_name,
                                "price": _oi.get("price", 0),
                                "image_url": _oi.get("image_url", ""),
                            }
                        _cp_items.add_product(
                            conversation_id=req.conversation_id,
                            platform=req.platform,
                            shop=req.shop,
                            item_id=_oi_item_id,
                            name=_oi_name,
                            source="user_order",
                            card=_oi_card,
                            is_anchor=True,
                        )
                        _anchored_count += 1
                    if _anchored_count:
                        print(f"[ORDER-ANCHOR] anchored {_anchored_count} order items as products (order_sn={_order_sn})", file=sys.stderr)
                except Exception as _e:
                    print(f"[ORDER-ANCHOR] error anchoring order items: {_e}", file=sys.stderr)
            # สร้างคำถามที่ส่งให้ LLM — ตัด order_sn ออกจาก message
            _order_msg = _order_store._ORDER_TAG_RE.sub("", req.message).strip() if _order_store._ORDER_TAG_RE.search(req.message) else req.message
            # ถ้าลูกค้าส่งแค่เลข order ไม่มีคำถาม → ตั้งคำถามเอง
            _order_clean = re.sub(r"(?:เลข)?คำสั่งซื้อ\s*" + re.escape(_order_sn), "", _order_msg, flags=re.IGNORECASE).strip()
            _order_clean = _order_clean.replace(_order_sn, "").strip()
            # ⚡ Phase 3C — ถ้าลูกค้าส่งแค่เลข order (ไม่มีคำถาม) → ตอบรับทราบสั้นๆ ไม่เรียก LLM
            #    บันทึก anchor ไว้แล้ว รอคำถามถัดไป
            if not _order_clean and not _order_sn_from_anchor:
                print(f"[ORDER] ลูกค้าส่งแค่เลข order (ไม่มีคำถาม) → ตอบรับทราบสั้นๆ + รอคำถามถัดไป", file=sys.stderr)
                _ack_answer = (
                    f"ได้รับเลขคำสั่งซื้อ {_order_sn} แล้วค่ะ 📝 "
                    f"รบกวนบอกคำถามที่อยากสอบถาม เช่น สถานะการจัดส่ง สินค้าในคำสั่งซื้อ "
                    f"หรือเรื่องรับประกัน เพื่อให้ทางร้านช่วยตอบให้ได้ค่ะ"
                )
                _total_elapsed = _time.time() - _total_start

                _steps.append({
                    "name": "order_lookup",
                    "model": model_name,
                    "tokens_in": 0,
                    "tokens_out": 0,
                    "time_s": round(_total_elapsed, 2),
                    "cost_usd": 0.0,
                    "cost_thb": 0.0,
                    "detail": f"order_sn={_order_sn} status={_order_info['order_status']} (ack only — no question)",
                })
                return dict(
                    answer=_ack_answer,
                    answer_segments=llm.split_segments(_ack_answer),
                    products=[],
                    shop=req.shop,
                    model=model_name,
                    source="order_lookup", 
                    usage={"prompt": 0, "output": 0, "total": 0},
                    elapsed=round(_total_elapsed, 2),
                    cost=0.0,
                    steps=_steps,
                    routing_decision=_app_module._routing("bot_reply", f"order_lookup: order_sn={_order_sn} → ack only (no question, anchor saved)"),
                    image_desc=_image_desc_out,
                )
            # มีคำถาม → ตอบจาก order context
            if not _order_clean:
                if _order_sn_from_anchor:
                    _order_clean = "ลูกค้าถามเกี่ยวกับคำสั่งซื้อเดิม ต้องการดูสถานะและรายละเอียด"
                else:
                    _order_clean = "ลูกค้าส่งเลขคำสั่งซื้อมา ต้องการดูสถานะและรายละเอียดสินค้าในคำสั่งซื้อนี้"
            # เรียก LLM พร้อม order context
            try:
                _order_answer, _order_usage = llm.answer_general(
                    message=_order_clean,
                    context=_order_ctx,
                    qtype="order_status",
                    history=_qa10,
                    persona_extra=_persona_extra,
                )
            except RuntimeError as exc:
                raise HTTPException(status_code=500, detail=str(exc))
            _total_elapsed = _time.time() - _total_start

            prompt_t = _order_usage.get("prompt", 0)
            output_t = _order_usage.get("output", 0)
            cost = llm._gemini_cost(prompt_t, output_t)
            _steps.append({
                "name": "order_lookup",
                "model": model_name,
                "tokens_in": prompt_t,
                "tokens_out": output_t,
                "time_s": round(_total_elapsed, 2),
                "cost_usd": round(cost, 6),
                "cost_thb": round(cost * 36, 4),
                "detail": f"order_sn={_order_sn} status={_order_info['order_status']}",
            })
            return dict(
                answer=_order_answer,
                answer_segments=llm.split_segments(_order_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="order_lookup",
                usage=_order_usage,
                elapsed=round(_total_elapsed, 2),
                cost=round(cost, 6),
                steps=_steps,
                routing_decision=_app_module._routing("bot_reply", f"order_lookup: order_sn={_order_sn} → ตอบจาก order info"),
                image_desc=_image_desc_out,
            )
        else:
            # พบ order_sn แต่ไม่พบใน DB → บอกลูกค้า
            print(f"[ORDER] ไม่พบ order_sn={_order_sn} ในระบบ", file=sys.stderr)
            _order_not_found = (
                f"ขออภัยค่ะ ไม่พบข้อมูลคำสั่งซื้อเลข {_order_sn} ในระบบ "
                f"อาจเป็นคำสั่งซื้อจากร้านอื่น หรือเลขคำสั่งซื้อไม่ถูกต้อง "
                f"รบกวนตรวจสอบเลขคำสั่งซื้ออีกครั้ง หรือทักแอดมินเพื่อสอบถามได้นะคะ"
            )
            _total_elapsed = _time.time() - _total_start

            _steps.append({
                "name": "order_lookup",
                "model": model_name,
                "tokens_in": 0,
                "tokens_out": 0,
                "time_s": round(_total_elapsed, 2),
                "cost_usd": 0.0,
                "cost_thb": 0.0,
                "detail": f"order_sn={_order_sn} not found",
            })
            return dict(
                answer=_order_not_found,
                answer_segments=llm.split_segments(_order_not_found),
                products=[],
                shop=req.shop,
                model=model_name,
                source="order_lookup",
                usage={"prompt": 0, "output": 0, "total": 0},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                steps=_steps,
                routing_decision=_app_module._routing("bot_reply", f"order_lookup: order_sn={_order_sn} not found"),
                image_desc=_image_desc_out,
            )

    ctx["order_sn"] = _order_sn
    ctx["is_claim_request_pre"] = _is_claim_request_pre
    return None
