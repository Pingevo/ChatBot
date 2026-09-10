"""engine — main flow สำหรับ chatbotv3.

Flow:
1. รับ ChatRequest (จาก app.py)
2. parse rich message (item_id, order_sn, image, sticker, bundle, etc.)
3. ตรวจ deterministic safety:
   a. warranty claim (จริง) → handoff admin (เหมือน legacy)
   b. emotion (อารมณ์เสีย) → handoff admin (ใหม่ v3)
   c. human request → handoff admin
4. สร้าง context block:
   - shop name + shop URL
   - persona ของร้าน (ถ้ามี)
   - สินค้าทั้งหมดในร้าน (ส่งเป็น context เสริม)
   - order context (ถ้ามี order_sn → lookup จริง)
   - คำถามลูกค้า + history
5. ส่งให้ OpenRouter
6. match สินค้าที่ OpenRouter อ้างถึง กับ ShpProducts จริง
7. คืน ChatResponse-compatible dict (รวม answer_segments, image_desc, handoff API call)

⚠️ ไม่ทำลาน warranty/claim flow — ใช้ warranty.detect_claim_request เหมือน legacy
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import urllib.error
from typing import Any

# ⚡ lazy imports — หลีกเลี่ยงการโหลด heavy modules (google.genai, pymongo) ตอน import
#   ทำให้ test ที่ไม่ได้ใช้ DB/LLM ไม่ต้องลง dependency ครบ
_warranty = None
_knowledge_base = None
_product_store = None
_persona = None
_order_store = None


def _get_warranty():
    global _warranty
    if _warranty is None:
        from .. import warranty as _w
        _warranty = _w
    return _warranty


def _get_knowledge_base():
    global _knowledge_base
    if _knowledge_base is None:
        from .. import knowledge_base as _kb
        _knowledge_base = _kb
    return _knowledge_base


def _get_product_store():
    global _product_store
    if _product_store is None:
        from .. import product_store as _ps
        _product_store = _ps
    return _product_store


def _get_persona():
    global _persona
    if _persona is None:
        from .. import persona as _p
        _persona = _p
    return _persona


def _get_order_store():
    global _order_store
    if _order_store is None:
        from .. import order_store as _os
        _order_store = _os
    return _order_store


from . import or_client
from . import system_prompt
from . import shop_link
from . import rich_parse
from . import product_match
from . import emotion


# ─── Handoff API (ข้อ 1) ───────────────────────────────────────────────────
def _send_handoff_to_admin(
    conversation_id: str | None,
    shop: str | None,
    platform: str | None,
    reason: str,
    claim: dict | None = None,
    simulate: bool = False,
) -> bool:
    """ส่ง handoff ไป ChatAdminWeb จริง (เหมือน legacy app.py 1856-1884).

    Args:
        conversation_id: ID ของแชท
        shop: ชื่อร้าน
        platform: shopee/tiktok/lazada
        reason: เหตุผล handoff (warranty_claim_detected / customer_negative_emotion / human_request)
        claim: ข้อมูล claim (ถ้ามี)
        simulate: ถ้า True → test_chat_sessions ไม่ใช่ conversations

    Returns:
        True ถ้าส่งสำเร็จ, False ถ้า fail
    """
    if not conversation_id:
        return False
    try:
        _handoff_url = os.environ.get(
            "ADMIN_HANDOFF_URL",
            "http://127.0.0.1:3000/api/admin/conversations/bot-handoff",
        )
        _payload = {
            "conversation_id": conversation_id,
            "shop_id": shop or "",
            "platform": platform or "shopee",
            "reason": reason,
            "simulate": simulate,
            "claim": claim or {},
        }
        _body = json.dumps(_payload).encode("utf-8")
        _req = urllib.request.Request(
            _handoff_url,
            data=_body,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": os.environ.get("CHATBOT_INTERNAL_SECRET", ""),
            },
            method="POST",
        )
        try:
            urllib.request.urlopen(_req, timeout=5)
            print(f"[HANDOFF-V3] sent to admin: reason={reason} conv={conversation_id}", file=sys.stderr)
            return True
        except Exception as _he:
            print(f"[HANDOFF-V3] handoff failed: {_he}", file=sys.stderr)
            return False
    except Exception as _he:
        print(f"[HANDOFF-V3] handoff error: {_he}", file=sys.stderr)
        return False


# ─── Persona (ข้อ 2) ───────────────────────────────────────────────────────
def _get_persona_extra(shop_name: str | None, platform: str | None) -> str:
    """ดึง persona instruction ของร้าน (เหมือน legacy app.py 1158-1159).

    Returns:
        persona instruction string หรือ "" ถ้าไม่มี persona
    """
    if not shop_name:
        return ""
    try:
        _p = _get_persona()
        _doc = _p.get_persona(shop_name, platform=platform or "shopee")
        return _p.build_persona_instruction(_doc, shop_name)
    except Exception as _e:
        print(f"[PERSONA-V3] error: {_e}", file=sys.stderr)
        return ""


# ─── Order lookup (ข้อ 5) ───────────────────────────────────────────────────
def _lookup_order_context(order_sn: str | None, shop: str | None) -> str:
    """Lookup order จริงและสร้าง context string (เหมือน legacy app.py 1562-1564).

    Returns:
        order context string หรือ "" ถ้าไม่พบ/ไม่มี order_sn
    """
    if not order_sn:
        return ""
    try:
        _os = _get_order_store()
        _order = _os.lookup_order(order_sn, shop_filter=shop)
        if _order:
            return _os.build_order_context(_order)
    except Exception as _e:
        print(f"[ORDER-V3] lookup error: {_e}", file=sys.stderr)
    return ""


# ─── Image description (ข้อ 3) ──────────────────────────────────────────────
def _extract_image_desc_from_answer(answer: str, has_images: bool) -> str:
    """สกัด image description จากคำตอบ LLM (ถ้ามีรูป).

    v3 ส่งรูปเข้า OpenRouter ตรง (multimodal) แล้ว LLM อาจพูดถึงรูปในคำตอบ
    แต่เราไม่ได้สกัด description แยกเหมือน legacy vision pass
    ถ้ามีรูปและ LLM ตอบเกี่ยวกับรูป → ใช้คำตอบสั้นๆ เป็น image_desc

    Returns:
        image_desc string หรือ "" ถ้าไม่มีรูป
    """
    if not has_images:
        return ""
    # v3 ส่งรูปเข้า LLM ตรง ไม่มี vision pass แยก
    # แต่ถ้า LLM ตอบสั้นๆ เกี่ยวกับรูป → ใช้เป็น image_desc
    # ปัจจุบัน return "" เพราะ v3 ไม่ได้สกัด description แยก
    return ""


def _build_history_list(history: list | None) -> list[dict]:
    """แปลง history (ChatMessage list) เป็น list[dict] สำหรับส่ง OpenRouter."""
    if not history:
        return []
    out: list[dict] = []
    for h in history:
        # ChatMessage เป็น pydantic model — ใช้ .dict() หรือ attribute
        if hasattr(h, "model_dump"):
            h = h.model_dump()
        elif hasattr(h, "dict"):
            h = h.dict()
        role = h.get("role", "user")
        text = h.get("text", "") or ""
        # ถ้ามี image_desc ใน history → แปะต่อท้าย text (ให้ LLM เข้าใจรูปเก่า)
        img_desc = h.get("image_desc", "") or ""
        if img_desc:
            text = f"{text}\n[รูปที่ส่งมาก่อนหน้า: {img_desc}]" if text else f"[รูปที่ส่งมาก่อนหน้า: {img_desc}]"
        if text:
            out.append({"role": role, "text": text})
    return out


def _build_user_prompt(
    message: str,
    shop_name: str | None,
    platform: str | None,
    history: list[dict] | None,
    images: list[str] | None,
    shop_products: list[dict] | None,
    order_sn: str | None,
    item_id: str | None,
    order_context: str = "",
) -> str:
    """สร้าง user prompt สำหรับส่งให้ OpenRouter (รวม context block)."""
    parts: list[str] = []

    # 1. shop context block
    shop_block = shop_link.build_shop_context_block(shop_name, platform)
    if shop_block:
        parts.append(shop_block)

    # 2. order context (ถ้ามี) — ใช้ context จริงจาก lookup_order (ข้อ 5)
    if order_context:
        parts.append(order_context)
    elif order_sn:
        parts.append(f"คำสั่งซื้อที่ลูกค้าอ้างถึง: {order_sn}")

    # 3. item context (ถ้ามี)
    if item_id:
        parts.append(f"สินค้าที่ลูกค้าอ้างถึง (item_id): {item_id}")

    # 4. สินค้าในร้าน (context เสริม — ส่งเป็น list สั้นๆ)
    if shop_products:
        prod_lines: list[str] = []
        for p in shop_products[:30]:  # จำกัด 30 ชิ้น
            name = p.get("name", "")
            item_id_p = p.get("item_id", "")
            status = p.get("status", "")
            stock = p.get("total_stock", 0)
            sold = " (sold out)" if p.get("sold_out") else ""
            brand = p.get("brand", "")
            category = p.get("category", "")
            warranty = p.get("warranty", "")
            # ⚡ ส่ง description_excerpt ให้ LLM ด้วย — จะได้เช็ค compatibility ได้
            desc = (p.get("description_excerpt") or "")[:500]  # จำกัด 500 ตัวอักษร/ชิ้น
            # สร้างบรรทัดสินค้าแบบมีข้อมูลครบ
            line_parts = [f"- [{item_id_p}] {name}"]
            if brand:
                line_parts.append(f"แบรนด์: {brand}")
            if category:
                line_parts.append(f"หมวด: {category}")
            line_parts.append(f"status={status}, stock={stock}{sold}")
            if warranty:
                line_parts.append(f"รับประกัน: {warranty}")
            if desc:
                line_parts.append(f"รายละเอียด: {desc}")
            prod_lines.append(" | ".join(line_parts))
        if prod_lines:
            parts.append("สินค้าในร้านนี้ (ใช้ตอบได้เท่านั้น — ห้ามแต่งลิงก์เอง):\n" + "\n".join(prod_lines))

    # 5. คำถามลูกค้า (ส่วนสำคัญที่สุด)
    parts.append(f"คำถามลูกค้า: {message}")

    return "\n\n".join(parts)


def _make_handoff_response(
    reason: str,
    answer: str,
    shop: str | None,
    model: str,
    elapsed: float,
    steps: list[dict] | None = None,
    claim: dict | None = None,
    conversation_id: str | None = None,
    platform: str | None = None,
    simulate: bool = False,
) -> dict:
    """สร้าง response dict สำหรับ handoff (compatible กับ ChatResponse).

    ⚡ ข้อ 1 — เรียก handoff API จริงไป ChatAdminWeb (เหมือน legacy)
    ⚡ ข้อ 4 — แยก answer_segments ด้วย ||| (multi-bubble)
    """
    # ส่ง handoff ไป ChatAdminWeb จริง
    if conversation_id:
        _send_handoff_to_admin(
            conversation_id=conversation_id,
            shop=shop,
            platform=platform,
            reason=reason,
            claim=claim,
            simulate=simulate,
        )

    # แยก answer เป็น segments ด้วย ||| (เหมือน legacy multi-bubble)
    segments = [s.strip() for s in answer.split("|||") if s.strip()] if answer else []
    return {
        "answer": answer,
        "products": [],
        "shop": shop,
        "model": model,
        "source": "chatbotv3",
        "chat_engine": "v3",
        "usage": {},
        "elapsed": round(elapsed, 2),
        "cost": 0.0,
        "answer_segments": segments or [answer] if answer else [],
        "handoff_to_admin": True,
        "handoff_reason": reason,
        "handoff_claim": claim or {},
        "intent": {},
        "timing": {},
        "retrieval_info": {},
        "web_search_used": False,
        "web_search_reason": None,
        "web_search_model": None,
        "image_desc": "",
        "steps": steps or [],
        "routing_decision": {"path": "handoff", "reason": reason},
    }


def _make_answer_response(
    answer: str,
    products: list[dict],
    shop: str | None,
    model: str,
    usage: dict,
    elapsed: float,
    cost: float,
    steps: list[dict] | None = None,
    image_desc: str = "",
) -> dict:
    """สร้าง response dict สำหรับคำตอบปกติ (compatible กับ ChatResponse)."""
    # แยก answer เป็น segments ด้วย ||| (เหมือน legacy multi-bubble)
    segments = [s.strip() for s in answer.split("|||") if s.strip()] if answer else []
    return {
        "answer": answer,
        "products": products,
        "shop": shop,
        "model": model,
        "source": "chatbotv3",
        "chat_engine": "v3",
        "usage": usage,
        "elapsed": round(elapsed, 2),
        "cost": round(cost, 6),
        "answer_segments": segments or [answer],
        "handoff_to_admin": False,
        "handoff_reason": None,
        "handoff_claim": {},
        "intent": {},
        "timing": {},
        "retrieval_info": {},
        "web_search_used": False,
        "web_search_reason": None,
        "web_search_model": None,
        "image_desc": image_desc,
        "steps": steps or [],
        "routing_decision": {"path": "answer", "reason": "chatbotv3_llm"},
    }


def chat_v3(req: Any) -> dict:
    """main entry สำหรับ chatbotv3.

    Args:
        req: ChatRequest (pydantic model จาก app.py)

    Returns:
        dict ที่ compatible กับ ChatResponse (app.py จะแปลงเป็น ChatResponse อีกที)
    """
    _t0 = time.time()
    _steps: list[dict] = []

    # ---- 1. extract fields จาก request ----------------------------------------
    message = (req.message or "").strip()
    shop_name = (req.shop or "").strip() or None
    platform = (req.platform or "shopee").strip() or "shopee"
    history = req.history or []
    images = req.images or []
    item_id_req = str(req.item_id) if req.item_id else None
    order_sn_req = (req.order_sn or "").strip() or None
    conversation_id = (req.conversation_id or "").strip() or None
    simulate_assignment = getattr(req, "simulate_assignment", False) or False
    limit = getattr(req, "limit", 10) or 10

    # ---- 2. parse rich message ------------------------------------------------
    parsed = rich_parse.parse_rich_message(message)
    item_id = item_id_req or parsed.get("item_id")
    order_sn = order_sn_req or parsed.get("order_sn")
    clean_message = parsed.get("clean_message") or message

    # ถ้า message เป็นแค่ placeholder เปล่า (เช่น "[item]" ลอยๆ) → ตอบรับรู้สั้นๆ
    if parsed.get("is_placeholder_only") and not item_id and not order_sn:
        return _make_answer_response(
            answer="รับฟังค่ะ มีอะไรให้ช่วยไหมคะ",
            products=[],
            shop=shop_name,
            model="chatbotv3",
            usage={},
            elapsed=time.time() - _t0,
            cost=0.0,
            steps=[{"name": "placeholder_only", "model": "rule", "detail": "message is placeholder only"}],
        )

    # ---- 3. deterministic safety checks ---------------------------------------
    history_list = _build_history_list(history)

    # 3a. warranty claim (จริง) → handoff
    try:
        if _get_warranty().detect_claim_request(clean_message):
            _steps.append({"name": "warranty_claim", "model": "warranty.detect_claim_request", "detail": "claim detected"})
            return _make_handoff_response(
                reason="warranty_claim_detected",
                answer="รบกวนแอดมินติดต่อกลับเพื่อช่วยเรื่องเคลมได้ไหมคะ",
                shop=shop_name,
                model="chatbotv3",
                elapsed=time.time() - _t0,
                steps=_steps,
                conversation_id=conversation_id,
                platform=platform,
                simulate=simulate_assignment,
            )
    except Exception as e:
        # ถ้า warranty module fail → ไม่ block flow (ยังไป LLM ได้)
        _steps.append({"name": "warranty_check_error", "model": "warranty", "detail": str(e)[:100]})

    # 3b. emotion (อารมณ์เสีย) → handoff
    try:
        if emotion.detect_negative_emotion(clean_message, history_list):
            _steps.append({"name": "emotion_handoff", "model": "emotion.detect_negative_emotion", "detail": "negative emotion detected"})
            return _make_handoff_response(
                reason="customer_negative_emotion",
                answer="รบกวนรอแอดมินติดต่อกลับนะคะ ขออภัยในความไม่สะดวกค่ะ",
                shop=shop_name,
                model="chatbotv3",
                elapsed=time.time() - _t0,
                steps=_steps,
                conversation_id=conversation_id,
                platform=platform,
                simulate=simulate_assignment,
            )
    except Exception as e:
        _steps.append({"name": "emotion_check_error", "model": "emotion", "detail": str(e)[:100]})

    # 3c. human request → handoff
    try:
        if emotion.detect_human_request(clean_message):
            _steps.append({"name": "human_request", "model": "emotion.detect_human_request", "detail": "human requested"})
            return _make_handoff_response(
                reason="human_request",
                answer="รบกวนรอแอดมินติดต่อกลับนะคะ",
                shop=shop_name,
                model="chatbotv3",
                elapsed=time.time() - _t0,
                steps=_steps,
                conversation_id=conversation_id,
                platform=platform,
                simulate=simulate_assignment,
            )
    except Exception as e:
        _steps.append({"name": "human_request_error", "model": "emotion", "detail": str(e)[:100]})

    # ---- 4. ดึงสินค้าในร้าน (context เสริม) ---------------------------------------
    shop_products: list[dict] = []
    try:
        _ps = _get_product_store()
        _client = _ps.get_client()
        db_name = os.environ.get("MONGO_DB", "dbWallet").strip() or "dbWallet"
        db = _client[db_name]
        shop_products = product_match.get_shop_products_summary(
            shop_filter=shop_name,
            db=db,
            message=clean_message,
            limit=30,
        )
        _steps.append({"name": "fetch_shop_products", "model": "product_store", "detail": f"got {len(shop_products)} products"})
    except Exception as e:
        _steps.append({"name": "fetch_shop_products_error", "model": "product_store", "detail": str(e)[:100]})

    # ถ้ามี item_id เฉพาะ → ดึงสินค้านั้นมาแนบด้วย
    if item_id:
        try:
            _ps = _get_product_store()
            _client = _ps.get_client()
            db_name = os.environ.get("MONGO_DB", "dbWallet").strip() or "dbWallet"
            db = _client[db_name]
            item_card = product_match.get_product_by_id(item_id, shop_name, db)
            if item_card:
                # แนบสินค้านี้ไว้หน้าสุด
                shop_products = [item_card] + [p for p in shop_products if str(p.get("item_id")) != str(item_id)][:29]
        except Exception as e:
            _steps.append({"name": "fetch_item_by_id_error", "model": "product_store", "detail": str(e)[:100]})

    # ---- 5. สร้าง prompt และเรียก OpenRouter -----------------------------------
    # ⚡ ข้อ 2 — ดึง persona ของร้าน (ถ้ามี)
    persona_extra = _get_persona_extra(shop_name, platform)
    if persona_extra:
        _steps.append({"name": "persona", "model": "persona.get_persona", "detail": "persona found"})

    # ⚡ ข้อ 5 — lookup order จริง (ถ้ามี order_sn)
    order_context = _lookup_order_context(order_sn, shop_name)
    if order_context:
        _steps.append({"name": "order_lookup", "model": "order_store.lookup_order", "detail": f"order_sn={order_sn} found"})

    system_instruction = system_prompt.build_system_instruction(
        shop_name=shop_name,
        shop_url=shop_link.build_shop_url(shop_name, platform),
        persona_extra=persona_extra,
    )

    user_prompt = _build_user_prompt(
        message=clean_message,
        shop_name=shop_name,
        platform=platform,
        history=history_list,
        images=images,
        shop_products=shop_products,
        order_sn=order_sn,
        order_context=order_context,
        item_id=item_id,
    )

    # เลือก model — ถ้ามี images → ใช้ vision model
    model = or_client.MODEL_VISION if images else or_client.MODEL_LLM2
    _t_llm = time.time()
    result = or_client.call_or(
        model=model,
        system=system_instruction,
        user=user_prompt,
        history=history_list,
        images=images if images else None,
        source="chatbotv3",
        step="vision" if images else "llm2",
        reference=conversation_id or "",
    )
    _llm_elapsed = time.time() - _t_llm

    _steps.append({
        "name": "openrouter_call",
        "model": model,
        "tokens_in": result.get("prompt_tokens", 0),
        "tokens_out": result.get("output_tokens", 0),
        "time_s": round(_llm_elapsed, 2),
        "cost_usd": round(result.get("cost_usd", 0), 6),
        "detail": "error" if result.get("error") else "ok",
    })

    # ถ้า OpenRouter fail → ตอบ fallback สั้นๆ
    if result.get("error") or not result.get("answer"):
        return _make_answer_response(
            answer="ขออภัยค่ะ ตอนนี้ไม่สามารถตอบคำถามได้ รบกวนลองใหม่อีกครั้งนะคะ",
            products=[],
            shop=shop_name,
            model=model,
            usage={
                "prompt": result.get("prompt_tokens", 0),
                "output": result.get("output_tokens", 0),
                "total": result.get("prompt_tokens", 0) + result.get("output_tokens", 0),
            },
            elapsed=time.time() - _t0,
            cost=result.get("cost_usd", 0),
            steps=_steps,
        )

    answer = result["answer"]

    # ---- 6. match สินค้าที่ OpenRouter อ้างถึง กับ ShpProducts จริง ----------------
    matched_products: list[dict] = []
    try:
        _ps = _get_product_store()
        _client = _ps.get_client()
        db_name = os.environ.get("MONGO_DB", "dbWallet").strip() or "dbWallet"
        db = _client[db_name]
        matched_products = product_match.match_products(
            answer=answer,
            shop_filter=shop_name,
            db=db,
            limit=limit,
        )
        _steps.append({"name": "product_match", "model": "product_match", "detail": f"matched {len(matched_products)} products"})
    except Exception as e:
        _steps.append({"name": "product_match_error", "model": "product_match", "detail": str(e)[:100]})

    # ---- 7. สร้าง response -----------------------------------------------------
    # ⚡ ข้อ 3 — สกัด image_desc (ถ้ามีรูป)
    image_desc = _extract_image_desc_from_answer(answer, bool(images))

    usage = {
        "prompt": result.get("prompt_tokens", 0),
        "output": result.get("output_tokens", 0),
        "total": result.get("prompt_tokens", 0) + result.get("output_tokens", 0),
    }
    return _make_answer_response(
        answer=answer,
        products=matched_products,
        shop=shop_name,
        model=model,
        usage=usage,
        elapsed=time.time() - _t0,
        cost=result.get("cost_usd", 0),
        steps=_steps,
        image_desc=image_desc,
    )
