"""FastAPI app สำหรับแชทบอทสินค้า.

Endpoints:
- GET  /health        : ตรวจสุขภาพ + แสดงร้าน/หมวดทั้งหมด
- GET  /shops         : รายชื่อร้านในเครือ
- GET  /categories    : รายชื่อหมวดหมู่
- POST /chat          : รับ {shop, message, history?} -> {answer, products}
"""

from __future__ import annotations

import os
import re
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel, Field

from . import llm, product_store, knowledge_base


# โหลด .env จาก root ของ repo (เดียวกับที่เก็บ GEMINI_API_KEY_1..9)
# ไม่ใช้ cwd เพราะอาจรันจาก directory อื่น
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

app = FastAPI(
    title="ChatBotProductMS",
    description="แชทบอทตอบคำถาม/เปรียบเทียบ/แนะนำสินค้า และเรื่องเคลม-รับประกัน ของร้านในเครือ",
    version="0.1.0",
)

_STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


# ---- internal secret middleware ------------------------------------------------
# All endpoints (except /health and /static/*) require X-Internal-Secret
# header matching CHATBOT_INTERNAL_SECRET env var. This ensures only the
# Next.js BFF (running on the same machine) can call the chatbot directly.
# Webhook endpoints will be added later with their own platform signature
# verification.

_INTERNAL_SECRET = os.environ.get("CHATBOT_INTERNAL_SECRET", "").strip()
_PUBLIC_PATHS = {"/health", "/"}


@app.middleware("http")
async def _require_internal_secret(request: Request, call_next):
    path = request.url.path
    # Allow health, index, and static assets without secret
    if path in _PUBLIC_PATHS or path.startswith("/static"):
        return await call_next(request)
    # If no secret is configured (dev), allow but warn
    if not _INTERNAL_SECRET:
        return await call_next(request)
    provided = request.headers.get("X-Internal-Secret", "").strip()
    if provided != _INTERNAL_SECRET:
        return JSONResponse(
            status_code=401,
            content={"detail": "missing or invalid internal secret"},
        )
    return await call_next(request)


@app.on_event("startup")
def _warmup():
    """Pre-warm caches ตอน startup เพื่อลด cold start latency."""
    import sys
    try:
        # 1. โหลด embedding model
        from .embedding import _get_model
        _get_model()
        print("[WARMUP] embedding model loaded", file=sys.stderr)
    except Exception as e:
        print(f"[WARMUP] embedding model failed: {e}", file=sys.stderr)
    try:
        # 2. โหลด vector store
        product_store._load_vector_store()
        print("[WARMUP] vector store loaded", file=sys.stderr)
    except Exception as e:
        print(f"[WARMUP] vector store failed: {e}", file=sys.stderr)
    try:
        # 3. เชื่อม MongoDB (cache connection)
        product_store.get_client()
        print("[WARMUP] MongoDB connected", file=sys.stderr)
    except Exception as e:
        print(f"[WARMUP] MongoDB failed: {e}", file=sys.stderr)
    try:
        # 4. เชื่อม admin MongoDB
        knowledge_base._build_admin_client()
        print("[WARMUP] admin MongoDB connected", file=sys.stderr)
    except Exception as e:
        print(f"[WARMUP] admin MongoDB failed: {e}", file=sys.stderr)


# ---- schemas ------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str = Field("user", description="user | model")
    text: str


class ChatRequest(BaseModel):
    message: str = Field(..., description="คำถาม/ข้อความลูกค้ารอบปัจจุบัน")
    shop: str | None = Field(None, description="ชื่อร้านที่ลูกค้าทักเข้ามา (ถ้ามี) เช่น IMILabThailand")
    item_id: str | int | None = Field(
        None,
        description="item_id ของสินค้าที่ลูกค้าอ้างถึง (เช่น แชร์การ์ดสินค้ามาในแชท) "
                    "ถ้าระบุ จะตอบจากสินค้านี้โดยตรง แม่นยำกว่าการค้นด้วยข้อความ",
    )
    history: list[ChatMessage] = Field(default_factory=list, description="ประวัติแชทก่อนหน้า")
    limit: int = Field(20, ge=1, le=50, description="จำนวนสินค้าสูงสุดที่จะส่งเป็น context")


class ChatResponse(BaseModel):
    answer: str
    products: list[dict[str, Any]]
    shop: str | None
    model: str
    source: str = Field("product_store", description="knowledge_base | product_store")
    usage: dict[str, int] = Field(default_factory=dict, description="token usage: prompt, output, total")
    elapsed: float = Field(0.0, description="เวลาที่ใช้ (วินาที)")
    cost: float = Field(0.0, description="ต้นทุนประมาณ (USD)")


class FeedbackRequest(BaseModel):
    answer: str = Field(..., description="คำตอบที่ลูกค้าให้ feedback (สูงสุด 500 ตัวอักษร)")
    rating: str = Field(..., description="up | down | clear")


# ---- helpers ------------------------------------------------------------------

def _db():
    """เปิด client + เลือก db ใหม่ทุกครั้ง (stateless สำหรับ API แบบง่าย).

    หากต้องการ reuse connection ข้าม request ใช้ app.state หรือ dependency injection.
    """
    client = product_store.get_client()
    db_name = os.environ.get("MONGO_DB", "").strip()
    if not db_name:
        raise SystemExit("ERROR: MONGO_DB ไม่ถูกตั้งใน .env")
    return client, client[db_name]


# ---- routes -------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, Any]:
    try:
        client, db = _db()
        shops = product_store.list_shops(db)
        cats = product_store.list_categories(db)
        client.close()
        return {"ok": True, "shops": len(shops), "categories": len(cats)}
    except SystemExit as exc:
        return {"ok": False, "error": str(exc)}


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    """หน้าเว็บแชทแบบง่าย สำหรับทดลอง."""
    return HTMLResponse((_STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/shops")
def shops() -> dict[str, Any]:
    client, db = _db()
    try:
        return {"shops": product_store.list_shops(db)}
    finally:
        client.close()


@app.get("/categories")
def categories() -> dict[str, Any]:
    client, db = _db()
    try:
        return {"categories": product_store.list_categories(db)}
    finally:
        client.close()


@app.get("/brands")
def brands(
    page: int = 1,
    per_page: int = 20,
    search: str = "",
) -> dict[str, Any]:
    """รายการแบรนด์ทั้งหมด พร้อม pagination.

    Args:
        page: หน้า (เริ่มที่ 1)
        per_page: จำนวนต่อหน้า (default 20)
        search: ค้นหาด้วยชื่อแบรนด์ (optional)

    คืน:
    {
        "brands": [{"name": str, "count": int, "categories": [str]}, ...],
        "total": int,
        "page": int,
        "per_page": int,
        "total_pages": int,
    }
    """
    import os
    from collections import Counter

    client, db = _db()
    try:
        coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
        coll = db[coll_name]

        brand_counts = Counter()
        brand_cats: dict[str, set[str]] = {}
        for d in coll.find({"item_status": "NORMAL"}, {"brand": 1, "cat_name": 1}).limit(10000):
            b = d.get("brand", "")
            if isinstance(b, dict):
                bname = (b.get("original_brand_name", "") or "").strip()
            else:
                bname = str(b).strip() if b else ""
            c = d.get("cat_name", "")
            if bname:
                brand_counts[bname] += 1
                if c:
                    brand_cats.setdefault(bname, set()).add(str(c))

        # สร้าง list
        all_brands = [
            {
                "name": bname,
                "count": count,
                "categories": sorted(brand_cats.get(bname, set())),
            }
            for bname, count in brand_counts.most_common()
        ]

        # filter by search
        if search:
            search_low = search.lower().strip()
            all_brands = [b for b in all_brands if search_low in b["name"].lower()]

        total = len(all_brands)
        total_pages = max(1, (total + per_page - 1) // per_page)
        page = max(1, min(page, total_pages))
        start = (page - 1) * per_page
        end = start + per_page
        page_brands = all_brands[start:end]

        return {
            "brands": page_brands,
            "total": total,
            "page": page,
            "per_page": per_page,
            "total_pages": total_pages,
        }
    finally:
        client.close()


# tag ที่ Shopee/Zaapi แนบมาเมื่อลูกค้าแชร์การ์ดสินค้าในแชท เช่น "🛍️ [สินค้า: 43360743407]"
_ITEM_TAG_RE = re.compile(r"\[(?:สินค้า|item|item_id|product)\s*[:：]\s*(\d+)\]", re.IGNORECASE)


def _extract_item_id_tag(text: str) -> str | None:
    """ดึง item_id จาก tag ที่แนบมาในข้อความ (เช่น '[สินค้า: 43360743407]')."""
    m = _ITEM_TAG_RE.search(text or "")
    return m.group(1) if m else None


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    import time as _time
    import sys
    _total_start = _time.time()
    client, db = _db()
    try:
        history = [{"role": m.role, "text": m.text} for m in req.history]

        # ===== ขั้นที่ -1: ลูกค้าแชร์การ์ดสินค้ามาในแชท (มี item_id ชัดเจน) =====
        # กรณีนี้ตอบจากสินค้านั้นโดยตรง แม่นยำกว่าการค้นด้วยข้อความมาก
        # รองรับ 3 ทาง: (1) req.item_id ที่ระบบส่งมาเป็น field ตรง ๆ
        #              (2) tag ฝังอยู่ในข้อความปัจจุบัน เช่น "🛍️ [สินค้า: 43360743407]"
        #              (3) tag เคยปรากฏใน history (ลูกค้าแชร์การ์ดไว้ก่อนหน้า แล้วถามต่อ
        #                  เช่น "โหลดแอปอื่นมาดูได้ไหม") — ใช้เป็น anchor ต่อ ถ้าคำถามปัจจุบัน
        #                  ไม่ได้เอ่ยถึงรุ่น/แบรนด์อื่นที่ชัดเจน (ไม่ใช่การเปลี่ยนหัวข้อ)
        _tagged_item_id = req.item_id or _extract_item_id_tag(req.message)
        _is_from_history_anchor = False
        if not _tagged_item_id and history:
            _current_model_kw = knowledge_base.extract_model_keywords(req.message)
            _looks_like_new_topic = bool(_current_model_kw) or len(req.message.split()) > 15
            if not _looks_like_new_topic:
                for h in reversed(req.history):
                    if h.role == "user":
                        found = _extract_item_id_tag(h.text)
                        if found:
                            _tagged_item_id = found
                            _is_from_history_anchor = True
                            break
        # ข้อความที่เหลือหลังตัด tag ออก (ถ้ามีคำถามต่อท้าย เช่น "[สินค้า: 123] มีไหม")
        _clean_message = _ITEM_TAG_RE.sub("", req.message).strip()
        if not _tagged_item_id and not _clean_message and history:
            # ข้อความปัจจุบันไม่มี tag และว่างเปล่า (ไม่ควรเกิด แต่กันไว้)
            _clean_message = req.message
        if _tagged_item_id:
            print(f"[ITEM-TAG] พบ item_id={_tagged_item_id} ในข้อความ", file=sys.stderr)
            anchor_card = product_store.fetch_product_by_id(
                db, _tagged_item_id, shop_filter=req.shop,
                desc_message=_clean_message or req.message,
            )
            if anchor_card:
                # ถ้าลูกค้าไม่ได้พิมพ์คำถามเพิ่ม (ส่งแค่การ์ดสินค้ามาเฉย ๆ)
                # ให้ตั้งคำถามแทน โดยบอกชัดว่าลูกค้าระบุสินค้านี้แล้ว (ผ่านการแชร์การ์ดสินค้า)
                # ป้องกัน LLM เข้าใจผิดว่า "ยังไม่ได้ระบุสินค้า"
                _followup_q = (
                    _clean_message
                    or "ลูกค้าส่งการ์ดสินค้าชิ้นนี้มาในแชท สนใจสอบถามว่ามีของไหม ราคาเท่าไหร่ และรับประกันแบบไหน"
                )
                try:
                    answer, usage_info = llm.answer(
                        message=_followup_q,
                        products=[anchor_card],
                        shop_hint=req.shop,
                        history=history,
                    )
                except RuntimeError as exc:
                    raise HTTPException(status_code=500, detail=str(exc))
                _total_elapsed = _time.time() - _total_start
                model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
                prompt_t = usage_info.get("prompt", 0)
                output_t = usage_info.get("output", 0)
                cost = (prompt_t * 0.30 + output_t * 2.50) / 1_000_000
                answer = _append_base_warranty(answer, _followup_q, source="item_tag")
                return ChatResponse(
                    answer=answer,
                    products=[anchor_card],
                    shop=req.shop,
                    model=model_name,
                    source="item_tag",
                    usage=usage_info,
                    elapsed=round(_total_elapsed, 2),
                    cost=round(cost, 6),
                )
            else:
                print(f"[ITEM-TAG] ไม่พบสินค้า item_id={_tagged_item_id} ในระบบ", file=sys.stderr)
            # ถ้าไม่เจอสินค้า (ถูกลบ/item_id ผิด) ให้ตกไปใช้ flow ปกติต่อด้วยข้อความที่ตัด tag แล้ว
            if _clean_message:
                req.message = _clean_message

        # ===== ขั้นที่ 0: ตรวจคำถามทั่วไป (policy/brands/categories/shops) =====
        # ถ้าลูกค้าถามคำถามทั่วไปที่ไม่เจาะรุ่น → ตอบจาก policy/meta โดยตรง
        # แต่ถ้าเป็น warranty/return/shipping question และ history มีสินค้า → ถือว่าเป็น follow-up
        # ให้ดึงสินค้าจาก history มาตอบแทน
        _t0 = _time.time()
        general_qtype = knowledge_base.detect_general_question(req.message)
        # ตรวจ follow-up: ถ้าเป็น warranty/return/shipping question สั้นๆ และ history มีสินค้า
        # แต่ถ้า message ปัจจุบันมี model keyword อยู่แล้ว (เช่น "lagenio k9 รับประกัน")
        # ให้ถือว่าเป็นคำถามใหม่ ไม่ใช่ follow-up
        _current_has_model = bool(knowledge_base.extract_model_keywords(req.message))
        _is_followup_policy = (
            general_qtype in ("warranty_policy", "return_policy")
            and history
            and not _current_has_model  # message ปัจจุบันไม่มี model keyword
            and len(req.message.split()) <= 4  # คำถามสั้นๆ
        )
        if _is_followup_policy:
            # ดึง model words จาก history (ทั้ง user และ model messages)
            # เพราะ user อาจพิมพ์ "โทสับงบ 2000" (ไม่มี model keyword)
            # แต่ model answer มักมีชื่อสินค้าจริง เช่น "Xiaomi Redmi 8A"
            history_text = " ".join(
                h.get("text", "") for h in history
            )
            # หา pattern ที่เป็น "brand/word + model number" เช่น "Redmi 8A", "Xiaomi 12", "Lagenio K9"
            # ไม่ใช่แค่ตัวเลขเดี่ยวๆ เช่น "8A" หรือ "2000"
            import re as _re2
            # pattern: word(2+) + space + alphanumeric(2+) ที่มีตัวเลข
            model_patterns = _re2.findall(
                r"\b([A-Za-z]{2,})\s+([A-Za-z]*\d+[A-Za-z]*)\b",
                history_text
            )
            # กรอง: ตัวที่ 2 ต้องมีตัวเลข และตัวแรกไม่ใช่ stop word
            _stop = {"งบ", "บาท", "ราคา", "โค้ด", "พิเศษ", "ลด", "เหลือ", "ใช้", "พร้อม", "ส่ง",
                     "ศูนย์", "ไทย", "เดือน", "ปี", "วัน", "ชั่วโมง", "GB", "RAM", "ROM"}
            valid_models = []
            for brand_part, model_part in model_patterns:
                if brand_part.lower() in _stop:
                    continue
                if not _re2.search(r"\d", model_part):
                    continue
                # ไม่เอาตัวเลขล้วน (เช่น "2000")
                if _re2.fullmatch(r"\d+", model_part):
                    continue
                valid_models.append(f"{brand_part} {model_part}")
            if valid_models:
                print(f"[FOLLOWUP] warranty follow-up detected, models={valid_models[:3]}", file=sys.stderr)
                general_qtype = None
                # สร้าง message ใหม่: ใช้แค่ model name (ไม่รวม "การรับประกัน")
                # เพราะ "การรับประกัน" ทำให้ search score เปลี่ยน ดึงสินค้าผิด
                _original_msg = req.message
                req.message = valid_models[0]
                # เก็บ original message ไว้ในตัวแปรเพื่อส่งเป็น desc_message
                req._followup_original = _original_msg
                print(f"[FOLLOWUP] new message: {req.message!r}  desc={_original_msg!r}", file=sys.stderr)

        if general_qtype:
            print(f"[TIMING] General question detected: {general_qtype}  ({_time.time()-_t0:.2f}s)", file=sys.stderr)
            # ถ้ารู้ว่าลูกค้าทักมาจากร้านไหน (req.shop) ให้จำกัด categories/brands
            # เฉพาะร้านนั้น ไม่ปนร้านอื่นในเครือ (shops question ยังคงตอบภาพรวมทั้งเครือ)
            _gen_shop_filter = req.shop if general_qtype in ("categories", "brands") else None
            gen_result = knowledge_base.build_general_context(
                general_qtype, mongo_db=db, shop_filter=_gen_shop_filter,
            )
            if _gen_shop_filter and not gen_result:
                # ร้านนี้ไม่มีสินค้า NORMAL เลย → fallback เป็นคำตอบทั้งเครือแทน 0 ผลลัพธ์
                gen_result = knowledge_base.build_general_context(general_qtype, mongo_db=db)
                _gen_shop_filter = None  # ไม่ใช่คำตอบเฉพาะร้านแล้ว ไม่ต้องบอก LLM ว่าจำกัดร้าน
            if gen_result and gen_result.get("context"):
                gen_context = gen_result["context"]
                try:
                    answer, usage_info = llm.answer_general(
                        message=req.message,
                        context=gen_context,
                        qtype=general_qtype,
                        history=history,
                        shop_hint=_gen_shop_filter,
                    )
                except RuntimeError as exc:
                    raise HTTPException(status_code=500, detail=str(exc))
                _total_elapsed = _time.time() - _total_start
                model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
                prompt_t = usage_info.get("prompt", 0)
                output_t = usage_info.get("output", 0)
                cost = (prompt_t * 0.30 + output_t * 2.50) / 1_000_000
                answer = _append_base_warranty(answer, req.message, source=f"general:{general_qtype}")
                return ChatResponse(
                    answer=answer,
                    products=[],
                    shop=req.shop,
                    model=model_name,
                    source=f"general:{general_qtype}",
                    usage=usage_info,
                    elapsed=round(_total_elapsed, 2),
                    cost=round(cost, 6),
                )

        # ===== ขั้นที่ 0b: ตรวจ brand-specific question (เช่น "Xiaomi ขายอะไรบ้าง") =====
        brand_q = _detect_brand_question(req.message)
        if brand_q and not general_qtype:
            print(f"[TIMING] Brand question detected: {brand_q}  ({_time.time()-_t0:.2f}s)", file=sys.stderr)
            # ถ้ารู้ว่าลูกค้าทักมาจากร้านไหน ให้จำกัดเฉพาะสินค้าแบรนด์นี้ในร้านนั้น
            # (ลูกค้าซื้อได้แค่จากร้านที่กำลังคุยอยู่ ไม่ใช่ร้านอื่นในเครือ)
            brand_result = _build_brand_context(db, brand_q, shop_filter=req.shop)
            if req.shop and not brand_result:
                brand_result = _build_brand_context(db, brand_q)
            if brand_result and brand_result.get("context"):
                try:
                    answer, usage_info = llm.answer_general(
                        message=req.message,
                        context=brand_result["context"],
                        qtype="brand_info",
                        history=history,
                        shop_hint=req.shop if brand_result.get("meta", {}).get("shop_scoped") else None,
                    )
                except RuntimeError as exc:
                    raise HTTPException(status_code=500, detail=str(exc))
                _total_elapsed = _time.time() - _total_start
                model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
                prompt_t = usage_info.get("prompt", 0)
                output_t = usage_info.get("output", 0)
                cost = (prompt_t * 0.30 + output_t * 2.50) / 1_000_000
                return ChatResponse(
                    answer=answer,
                    products=[],
                    shop=req.shop,
                    model=model_name,
                    source="general:brand_info",
                    usage=usage_info,
                    elapsed=round(_total_elapsed, 2),
                    cost=round(cost, 6),
                )

        # ===== ขั้นที่ 1: เช็ค Knowledge Base ก่อน =====
        # ถ้าเป็น follow-up (เช่น "เคลมยังไง", "รับประกัน") ให้เอา model จาก history มาค้น KB ด้วย
        kb_query = req.message
        if req.history:
            # สกัด model words จาก user messages ใน history
            import re as _re
            history_user_text = " ".join(
                m.text for m in req.history if m.role == "user"
            )
            # ถ้าข้อความปัจจุบันเป็น follow-up (สั้น ไม่มี model name)
            followup_indicators = [
                "เคลม", "รับประกัน", "ประกัน", "จัดส่ง", "รายละเอียด",
                "สเปก", "สี", "ของแถม", "ในกล่อง", "เงื่อนไข",
            ]
            is_followup = any(ind in req.message for ind in followup_indicators)
            if is_followup and history_user_text:
                kb_query = f"{history_user_text} {req.message}"
        _t0 = _time.time()
        kb_result = knowledge_base.lookup_kb(kb_query)
        print(f"[TIMING] KB lookup: {_time.time()-_t0:.2f}s  query={kb_query[:60]!r}", file=sys.stderr)
        if kb_result and kb_result.get("found"):
            kb_context = kb_result.get("context", "")
            kb_docs = kb_result.get("kb_docs", [])
            if kb_context:
                # ดึง Mongo มาผสม — เอาราคา/ร้าน/ลิงก์/image/status จาก Mongo
                # ใช้ model keywords จาก KB docs แทน req.message เพื่อค้นให้ตรง
                kb_models = []
                for kd in kb_docs:
                    model = (kd.get("model") or "").strip()
                    brand = (kd.get("brand") or "").strip()
                    if model:
                        kb_models.append(f"{brand} {model}".strip())
                mongo_query = " ".join(kb_models[:5]) if kb_models else req.message
                # ถ้า req.message มี product type ชัดเจน (เช่น "นาฬิกา") แต่ mongo_query ไม่มี
                # ให้เพิ่ม type keyword เข้าไป เพื่อให้ fetch_products กรอง false positive ได้
                # (เช่น กรองสายนาฬิกาออกเมื่อถาม "นาฬิกา")
                req_types = product_store._detect_product_types(req.message)
                if not req_types:
                    req_types = product_store._detect_product_types_fuzzy(req.message)
                if req_types:
                    type_keywords_map = {
                        "phone": "โทรศัพท์ มือถือ smartphone",
                        "smartwatch": "สมาร์ทวอช smartwatch นาฬิกา",
                        "earphone": "หูฟัง earphone earbuds",
                        "powerbank": "แบตสำรอง powerbank",
                        "charger": "ชาร์จ charger สายชาร์จ",
                        "case": "เคส case ซอง",
                        "speaker": "ลำโพง speaker",
                    }
                    for pt in req_types:
                        if pt in type_keywords_map:
                            mongo_query = mongo_query + " " + type_keywords_map[pt]
                            break

                # ตรวจว่า KB docs ตรงกับรุ่นที่ลูกค้าถามจริงไหม
                # ถ้า KB เจอแบรนด์แต่ไม่ตรงรุ่น (เช่น ถาม "ks3" แต่ KB มีแค่ Elite2/Actor)
                # ต้องค้น Mongo ด้วยคำถามเดิมด้วย เพื่อหาสินค้าที่มีใน Mongo แต่ไม่มีใน KB
                user_model_tokens = knowledge_base.extract_model_keywords(req.message)
                kb_model_text = " ".join(kb_models).lower()
                kb_missing_model = False
                if user_model_tokens:
                    # ถ้ามี model token ที่ไม่อยู่ใน KB docs เลย → KB ไม่มีรุ่นนี้
                    missing = [t for t in user_model_tokens if t.lower() not in kb_model_text]
                    if missing:
                        kb_missing_model = True
                        print(f"[KB] model tokens ไม่มีใน KB: {missing}  → ค้น Mongo เพิ่มด้วยคำถามเดิม", file=sys.stderr)

                _t1 = _time.time()
                # desc_message ใช้ original message (ที่มี "การรับประกัน" ฯลฯ)
                # เพื่อให้ _clean_description กรอง section ที่เกี่ยวข้องได้ถูก
                _desc_msg = getattr(req, "_followup_original", None) or req.message
                mongo_products = product_store.fetch_products(
                    db,
                    message=mongo_query,
                    shop_filter=req.shop,
                    limit=10,
                    desc_message=_desc_msg,
                )
                print(f"[TIMING] Mongo (KB merge): {_time.time()-_t1:.2f}s  query={mongo_query[:60]!r}  products={len(mongo_products)}", file=sys.stderr)

                # ถ้า KB ไม่มีรุ่นที่ถาม → ค้น Mongo ด้วยคำถามเดิมด้วย แล้วเอามาต่อท้าย
                if kb_missing_model:
                    _t2 = _time.time()
                    extra_products = product_store.fetch_products(
                        db,
                        message=req.message,
                        shop_filter=req.shop,
                        limit=10,
                        desc_message=_desc_msg,
                    )
                    print(f"[TIMING] Mongo (original query): {_time.time()-_t2:.2f}s  query={req.message[:60]!r}  products={len(extra_products)}", file=sys.stderr)
                    # ต่อท้าย products ที่ไม่ซ้ำ
                    existing_names = {(p.get("name","") or "").lower() for p in mongo_products}
                    for p in extra_products:
                        pname = (p.get("name","") or "").lower()
                        if pname and pname not in existing_names:
                            mongo_products.append(p)
                            existing_names.add(pname)

                # Direct regex search: ค้นสินค้าที่ชื่อตรงกับ KB model โดยตรง
                # (fix: text/vector search อาจไม่คืนสินค้าที่ชื่อตรงที่สุด)
                import os as _os
                _coll_name = _os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
                _mongo_coll = db[_coll_name]
                existing_names = {(p.get("name","") or "").lower() for p in mongo_products}
                # กรอง false positive ใน Direct regex search ด้วย
                # (กันสายนาฬิกา/อุปกรณ์เสริม ปนเข้ามา)
                _direct_filter_kw = (
                    "สายนาฬิกา", "สาย นาฬิกา", "strap", "deployant",
                    "screen protector", "ฟิล์ม", "เคสนาฬิกา", "watch case",
                    "ชาร์จนาฬิกา", "watch charger",
                )
                for kd in kb_docs[:3]:
                    kb_model = (kd.get("model") or "").strip()
                    kb_brand = (kd.get("brand") or "").strip()
                    if not kb_model:
                        continue
                    # สกัด model keyword สั้นๆ จาก KB model name (เช่น "KS3" จาก "Kieslect KS3 / KS3 Elite")
                    model_short = kb_model.replace(kb_brand, "").strip()
                    # แยกเอาแต่ละ token — เก็บเฉพาะ token ที่เป็นชื่อรุ่นจริง (มีตัวอักษร+ตัวเลข หรือเป็นคำเฉพาะ)
                    # ตัด token ที่เป็นแค่ตัวเลขล้วน (เช่น "3", "2") หรือสั้นเกินไป (เช่น "3K", "2.0")
                    # หรือเป็นคำทั่วไป (เช่น "Pro", "Dual", "Elite")
                    _generic_tokens = {"pro", "dual", "elite", "lite", "max", "plus", "mini", "air",
                                       "noir", "lumina", "panorama", "edition", "smart", "watch",
                                       "band", "earbuds", "note", "pods"}
                    model_tokens = []
                    for t in re.split(r"[\s/]+", model_short):
                        t = t.strip()
                        if not t or len(t) < 2:
                            continue
                        # ต้องมีตัวอักษร+ตัวเลข และไม่ใช่ generic token
                        if t.lower() in _generic_tokens:
                            continue
                        # ตัด token ที่เป็นแค่ตัวเลขล้วน หรือมีแค่ตัวเลข+จุด (เช่น "2.0", "3K")
                        if not any(c.isalpha() for c in t):
                            continue
                        # ต้องมีตัวเลขผสมอยู่ด้วย (เช่น KS3, EC6, KS2)
                        if not any(c.isdigit() for c in t):
                            continue
                        # ต้องมีอย่างน้อย 2 ตัวอักษร (กัน "3K", "4K", "C22" ฯลฯ)
                        alpha_count = sum(1 for c in t if c.isalpha())
                        if alpha_count < 2:
                            continue
                        model_tokens.append(t)
                    if not model_tokens:
                        # fallback: ใช้ model_short ทั้งหมด ถ้าไม่มี token ที่ผ่านเงื่อนไข
                        model_tokens = [model_short] if model_short and len(model_short) >= 3 else []
                    for token in model_tokens[:2]:
                        # ค้นใน Mongo ด้วย regex ตรงใน item_name (word boundary)
                        # ⚠️ ถ้ามี shop_filter ต้องกรองเฉพาะร้านนั้น — ห้ามค้นข้ามร้าน
                        direct_q = {"item_status": "NORMAL", "item_name": {"$regex": re.escape(token), "$options": "i"}}
                        if req.shop:
                            direct_q["shopname"] = {"$regex": f"^{re.escape(req.shop)}$", "$options": "i"}
                        direct_docs = list(_mongo_coll.find(
                            direct_q,
                            limit=5
                        ))
                        for d in direct_docs:
                            # แปลงเป็น product card format
                            pname = (d.get("item_name","") or "").lower()
                            # กรองสายนาฬิกา/อุปกรณ์เสริม ออก
                            if pname and any(kw in pname for kw in _direct_filter_kw):
                                continue
                            if pname and pname not in existing_names:
                                p = product_store.to_product_card(d, message=req.message)
                                if p:
                                    mongo_products.insert(0, p)  # ใส่ต้น list เพราะตรงที่สุด
                                    existing_names.add(pname)
                print(f"[TIMING] Direct regex search: total products={len(mongo_products)}", file=sys.stderr)

                # merge: KB ให้ warranty/specs/highlights, Mongo ให้ ราคา/ร้าน/ลิงก์/image
                merged_products = _merge_kb_mongo(kb_docs, mongo_products)
                # ⚠️ ถ้ามี shop_filter ให้กรองสินค้าที่ไม่ใช่ร้านนั้นออก
                # (KB docs ไม่ถูกกรอง by shop ตอน lookup — ต้องกรองที่นี่)
                if req.shop and merged_products:
                    filtered = []
                    for p in merged_products:
                        pshop = (p.get("shop") or "").strip()
                        # เก็บเฉพาะสินค้าที่ shop ตรงกับร้านที่ลูกค้าทักมา
                        # (KB-only cards ที่ไม่มี shop field ก็ตัดออกด้วย เพราะไม่ใช่สินค้าร้านนี้)
                        if pshop and pshop.lower() == req.shop.lower():
                            filtered.append(p)
                    merged_products = filtered
                    print(f"[SHOP-FILTER] KB merge filtered to {len(merged_products)} products (shop={req.shop})", file=sys.stderr)
                # ⚠️ ถ้ากรองแล้วเหลือ 0 (ร้านนี้ไม่มีสินค้าที่ถาม) ให้ skip KB path
                # แล้ว fall through ไปค้นสินค้าอื่นในร้านเดียวกันแทน (เพื่อแนะนำทางเลือก)
                if merged_products:
                    # สร้าง context ใหม่ที่รวม KB + Mongo
                    merged_context = llm._build_context(merged_products, shop_hint=req.shop,
                                                         include_description=True)

                    try:
                        answer, usage_info = llm.answer(
                            message=getattr(req, "_followup_original", None) or req.message,
                            products=merged_products,
                            shop_hint=req.shop,
                            history=history,
                        )
                    except RuntimeError as exc:
                        raise HTTPException(status_code=500, detail=str(exc))
                    _total_elapsed = _time.time() - _total_start
                    model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
                    prompt_t = usage_info.get("prompt", 0)
                    output_t = usage_info.get("output", 0)
                    cost = (prompt_t * 0.30 + output_t * 2.50) / 1_000_000
                    # ส่ง merged_products เป็น products (เพื่อให้ frontend แสดงได้)
                    products = [_kb_doc_to_card(d) if "_kb_only" in d else d for d in merged_products]
                    answer = _append_base_warranty(answer, getattr(req, "_followup_original", None) or req.message)
                    return ChatResponse(
                        answer=answer,
                        products=products,
                        shop=req.shop,
                        model=model_name,
                        source="knowledge_base+mongo",
                        usage=usage_info,
                        elapsed=round(_total_elapsed, 2),
                        cost=round(cost, 6),
                    )

        # ===== ขั้นที่ 2: ไม่เจอใน KB → ใช้ product_store เดิม =====
        # แยก 2 ส่วน:
        # 1. retrieval_message: สำหรับค้นสินค้า (ใช้ model words จาก history ถ้าเป็น follow-up)
        # 2. desc_message: สำหรับกรอง description (ใช้คำถามปัจจุบันเสมอ)
        #
        # ตัวอย่าง:
        # - รอบ 1: "redmi 8a" → retrieval="redmi 8a", desc="redmi 8a"
        # - รอบ 2: "รายละเอียด" → retrieval="redmi 8a", desc="รายละเอียด"
        # - รอบ 3: "รับประกัน" → retrieval="redmi 8a", desc="รับประกัน"
        # สินค้าเดิมทุกรอบ แต่ description เปลี่ยนตามคำถาม
        # ถ้าเป็น followup policy (warranty/return/shipping) ที่เรา override message
        # ให้ desc_message เป็น original message (ที่มี "การรับประกัน" ฯลฯ)
        _followup_orig = getattr(req, "_followup_original", None)
        desc_message = _followup_orig or req.message
        retrieval_message = req.message
        if req.history:
            # เช็คว่าข้อความปัจจุบันมี product type ชัดเจนไหม (exact match เท่านั้น)
            current_types = product_store._detect_product_types(req.message)
            # ถ้าไม่มี exact type → เช็ค fuzzy
            # แต่ถ้า message สั้น (1-5 คำ) และมี follow-up indicator → ไม่เช็ค fuzzy
            # เพราะ "แบตอึด" อาจ match fuzzy เป็น "แบตสำรอง" ทั้งที่เป็นคำถามต่อเรื่องแบตของสินค้าเดิม
            # หรือ "เหมาะสำหรับการเดินป่า" อาจ match fuzzy เป็น "memory_card" ทั้งที่เป็น follow-up
            _msg_words = req.message.split()
            _is_short_followup = len(_msg_words) <= 5 and any(
                ind in req.message for ind in [
                    "อึด", "แบต", "ดี", "ดีกว่า", "ถูก", "แพง", "เท่าไหร่",
                    "ราคา", "สี", "ขนาด", "น้ำหนัก",
                    "เหมาะ", "เลือก", "แนะนำ", "รายละเอียด", "สเปก",
                    "รับประกัน", "ประกัน", "เคลม", "จัดส่ง", "เปรียบเทียบ",
                    "1080p", "4k", "2k", "3k", "1080", "720",
                    "amoled", "oled", "lcd", "ips",
                    "mah", "watt", "gan", "pd",
                    "bluetooth", "wifi", "gps",
                    "กันน้ำ", "กันฝุ่น", "ip68", "ip69",
                    "กี่โมง", "กี่วัน", "นานไหม", "ชาร์จ", "โทรได้ไหม",
                    "โทรได้", "ใช้งานได้", "รองรับไหม",
                ]
            )
            if not current_types and not _is_short_followup:
                current_types = product_store._detect_product_types_fuzzy(req.message)

            # ตรวจว่าเป็น "คำถามต่อ" (follow-up) หรือ "คำถามใหม่"
            # คำถามต่อ = ถามเกี่ยวกับสินค้าเดิม เช่น "ตัวไหนดี", "เอามาเป็นยามเฝ้าบ้าน", "เลือกตัวไหน"
            # คำถามใหม่ = เปลี่ยนหัวข้อไปเลย เช่น "โทสับงบ 2000", "มีมือถือไหม"
            followup_indicators = [
                "ตัวไหน", "เลือก", "แนะนำ", "เอามาเป็น", "ใช้ทำ", "เหมาะ",
                "เฝ้า", "ยาม", "ครบจบ", "ดีกว่า", "สุดคุ้ม", "น่าซื้อ",
                "รายละเอียด", "สเปก", "รับประกัน", "จัดส่ง", "เคลม",
            ]
            # "ขอรุ่นอื่น" = ถามรุ่นอื่นในหมวดเดิม เช่น "เอารุ่นอื่นๆ", "มีอีกไหม", "อันอื่นๆ"
            other_model_indicators = [
                "รุ่นอื่น", "อันอื่น", "อื่นๆ", "อีกไหม", "มีอีกไหม",
                "ตัวอื่น", "เพิ่มเติม", "อีกบ้าง", "แนะนำไหม", "แนะนำอีก",
            ]
            # "reference indicator" = คำที่อ้างถึงสินค้าล่าสุดที่แนะนำ
            # เช่น "ขอรายละเอียดเรือนนี้", "ตัวนี้ราคาเท่าไหร่", "รุ่นนี้รับประกันไหม"
            # รวมถึง "ขอรายละเอียด" ล้วน ๆ (ไม่ระบุรุ่น) เพราะลูกค้าพิมพ์สั้น ๆ
            # หมายถึงสินค้าล่าสุดที่ bot แนะนำ
            reference_indicators = [
                "เรือนนี้", "ตัวนี้", "รุ่นนี้", "อันนี้", "นาฬิกาเรือนนี้",
                "สินค้านี้", "ชิ้นนี้", "รุ่นที่แนะนำ", "ที่แนะนำ",
                "ขอรายละเอียด", "ขอสเปก", "ขอข้อมูลเพิ่มเติม",
                "ขอรายละเอียดเพิ่มเติม", "ขอดูสเปก", "ขอดูรายละเอียด",
                "ขอข้อมูลสินค้า", "ขอรายละเอียดสินค้า",
            ]
            # "new topic indicator" = คำที่บอกว่าลูกค้าเปลี่ยนหัวข้อไปแล้ว ไม่ใช่ follow-up
            # เช่น "อุปกรณ์ป้องกันตัว", "โทสับ", "มีโทสับไหม", "อยากได้กล้อง"
            # ถ้ามีคำเหล่านี้ → เป็นคำถามใหม่ ไม่ใช้ history context
            new_topic_indicators = [
                "อุปกรณ์", "อยากได้", "หา", "มีไหมขาย", "มี...ไหม",
                "เปลี่ยนเรื่อง", "ถามใหม่", "อีกเรื่อง",
                "กล้อง", "โทสับ", "ป้องกันตัว", "ไม้ตี", "กระบอง",
                "สเปรย์", "ปืน", "มีด", "ระเบิด",
                "เครื่องใช้ไฟฟ้า", "เครื่องใช้", "เครื่องดูด",
                "เครื่องซัก", "เตา", "หม้อ", "กาต้ม",
                "ของเล่น", "เด็กเล่น",
                "อาหาร", "ยา", "เสริมอาหาร", "วิตามิน",
                "เสื้อ", "กางเกง", "รองเท้า", "กระเป๋า",
                "เครื่องสำอาง", "ครีม", "สบู่",
            ]
            is_followup_question = any(ind in req.message for ind in followup_indicators)
            is_other_model_question = any(ind in req.message for ind in other_model_indicators)
            is_new_topic = any(ind in req.message for ind in new_topic_indicators)
            is_reference_question = any(ind in req.message for ind in reference_indicators)

            # ถ้าเป็น reference question ("เรือนนี้", "ตัวนี้", "รุ่นนี้", "ขอรายละเอียด")
            # หรือ short followup ("ประกัน", "เคลม", "กันน้ำไหม", "แบต", "ราคาเท่าไหร่")
            # ให้ดึงชื่อสินค้าจากคำตอบ bot ล่าสุดมาเป็น retrieval keyword
            # เช่น "ขอรายละเอียดเรือนนี้ได้ไหม" หลังจาก bot แนะนำ Black Shark GS3
            # → retrieval = "Black Shark GS3 ขอรายละเอียดเรือนนี้ได้ไหม"
            # หรือ "ประกัน" ล้วน ๆ หลัง bot แนะนำ KOSPET TANK M3
            # → retrieval = "KOSPET TANK M3 ประกัน"
            # ยกเว้นถ้าเป็น other_model_question ("ขอรายละเอียดรุ่นอื่น") → ไม่ใช่ reference
            _is_ref_like = is_reference_question or (_is_short_followup and not is_other_model_question and not is_new_topic)
            if _is_ref_like and not is_new_topic and not is_other_model_question:
                all_model_texts_ref = [
                    m.text for m in req.history
                    if m.role == "model" and m.text.strip()
                ]
                if all_model_texts_ref:
                    latest_bot_answer = all_model_texts_ref[-1]
                    # ดึง brand + model pattern จากคำตอบ bot
                    # เช่น "Black Shark GS3", "KOSPET TANK M3", "Kieslect KS3"
                    import re as _re_ref
                    # pattern: word(2+) + space + alphanumeric(2+) ที่มีตัวเลข
                    # หรือ known brand + model
                    ref_brands = {
                        "kospet", "lagenio", "kieslect", "imilab", "xiaomi",
                        "redmi", "black shark", "blackshark", "imiki", "heyplus",
                        "zmi", "cuktech", "70mai", "viomi", "qcy", "yaber",
                        "1more", "leravan", "deerma", "mili", "lydsto", "eloop",
                        "isuper", "ztec", "anker", "baseus", "ugreen", "oraimo",
                        "jbl", "sony", "samsung", "oppo", "vivo", "realme",
                    }
                    # หา pattern "brand model" ในคำตอบ
                    ref_models = []
                    # pattern 1: known brand + alphanumeric model
                    for brand in ref_brands:
                        pattern = rf"\b{re.escape(brand)}\s+([A-Za-z]*\d+[A-Za-z]*)\b"
                        matches = _re_ref.findall(pattern, latest_bot_answer, re.IGNORECASE)
                        for m in matches:
                            full = f"{brand} {m}"
                            if full.lower() not in [x.lower() for x in ref_models]:
                                ref_models.append(full)
                    # pattern 2: word(2+) + space + alphanumeric(2+) ที่มีตัวเลข
                    all_patterns = _re_ref.findall(
                        r"\b([A-Za-z]{2,})\s+([A-Za-z]*\d+[A-Za-z]*)\b",
                        latest_bot_answer
                    )
                    _stop_ref = {"งบ", "บาท", "ราคา", "โค้ด", "พิเศษ", "ลด", "เหลือ",
                                 "ใช้", "พร้อม", "ส่ง", "ศูนย์", "ไทย", "เดือน", "ปี",
                                 "วัน", "ชั่วโมง", "GB", "RAM", "ROM", "ATM", "IP",
                                 "AMOLED", "Bluetooth", "Smartwatch", "สมาร์ทวอทช์",
                                 "นาฬิกา", "ร้าน", "ของ", "จาก", "หน้าจอ", "ความ",
                                 "นิ้ว", "กรัม", "มิลลิ", "เมตร", "วัสดุ", "สาย",
                                 "แบตเตอรี่", "ความจุ", "โหมด", "ฟังก์ชัน", "ขนาด",
                                 "น้ำหนัก", "อุปกรณ์", "กล่อง", "คู่มือ", "สี",
                                 "รับประกัน", "เงื่อนไข", "นโยบาย", "บริการ",
                                 "แนะนำ", "สนใจ", "สั่งซื้อ", "ลิงก์", "ทัก",
                                 "แอดมิน", "ยินดี", "ขออภัย", "สอบถาม", "เพิ่มเติม",
                                 "ข้อมูล", "รายละเอียด", "สเปก", "คุณสมบัติ", "จุดเด่น",
                                 "ดีไซน์", "ความแข็งแรง", "ทนทาน", "กลางแจ้ง",
                                 "เดินป่า", "สายลุย", "กันน้ำ", "กันฝุ่น",
                                 "หน้าจอ", "เชื่อมต่อ", "วัสดุ", "ตัวเรือน",
                                 "สายนาฬิกา", "แบตเตอรี่", "โหมดกีฬา", "สุขภาพ",
                                 "ระบบ", "รองรับ", "มาตรฐาน", "ความละเอียด",
                                 "ความสว่าง", "ระบบปฏิบัติการ", "เครือข่าย",
                                 "ฟังก์ชันโทร", "สนทนา", "เม็ดมะยม", "ซิลิโคน",
                                 "โครงสรีร", "สรีรศาสตร์", "Refresh", "Rate",
                                 "Supplier", "Manufacturer", "Warranty",
                                 "Months", "Year", "Month", "Day", "Hours",
                                 "Standby", "Mode", "AOD", "GPS", "SpO2",
                                 "Heart", "Rate", "Stress", "Sleep",
                                 "Aluminum", "Stainless", "steel", "Polyamide",
                                 "Glass", "Fiber", "Zinc", "alloy",
                                 "Liquid", "silicone", "rubber", "Nylon",
                                 "Leather", "Deployant", "Strap", "Band",
                                 "Type", "USB", "HDMI", "LAN", "Hub",
                                 "Pad", "Shark", "Black", "Special", "Edition",
                                 "Rugged", "Smart", "Watch", "Phone",
                                 "Tank", "Ultra", "Lite", "Active", "Elite",
                                 "Magic", "Pulse", "Orb", "Air", "Loop",
                                 "Alpha", "Camouflage", "Archlan",
                    }
                    for brand_part, model_part in all_patterns:
                        if brand_part.lower() in _stop_ref:
                            continue
                        if not _re_ref.search(r"\d", model_part):
                            continue
                        if _re_ref.fullmatch(r"\d+", model_part):
                            continue
                        full = f"{brand_part} {model_part}"
                        if full.lower() not in [x.lower() for x in ref_models]:
                            ref_models.append(full)
                    if ref_models:
                        # ใช้ model name แรกที่เจอ + คำถามปัจจุบัน
                        retrieval_message = f"{ref_models[0]} {req.message}"
                        print(f"[REFERENCE] ดึงสินค้าจากคำตอบล่าสุด: {ref_models[0]}", file=sys.stderr)

            # ถ้า fuzzy เจอ type แต่เป็นคำถามต่อ → ถือว่า false positive ให้เป็น follow-up
            # ถ้า fuzzy เจอ type และไม่ใช่คำถามต่อ → เป็นคำถามใหม่
            if current_types and (is_followup_question or is_other_model_question):
                current_types = set()  # ถือว่า false positive ของ fuzzy

            # ถ้าเป็น "ขอรุ่นอื่น" → ดึง product type จากคำถามก่อนหน้า แล้ว query สินค้าในหมวดเดิม
            if is_other_model_question and not current_types:
                all_user_msgs = [
                    m.text for m in req.history
                    if m.role == "user" and m.text.strip()
                ]
                # หา product type จากคำถามก่อนหน้า
                prev_product_type = None
                for hmsg in reversed(all_user_msgs):
                    pt = product_store._detect_product_types(hmsg)
                    if not pt:
                        pt = product_store._detect_product_types_fuzzy(hmsg)
                    if pt:
                        prev_product_type = pt
                        break
                if prev_product_type:
                    # ใช้ keyword ของ product type นั้นเป็น retrieval message
                    # เช่น phone → "โทรศัพท์ มือถือ phone"
                    type_keywords = {
                        "phone": "โทรศัพท์ มือถือ smartphone",
                        "smartwatch": "สมาร์ทวอช smartwatch นาฬิกา",
                        "earphone": "หูฟัง earphone earbuds",
                        "powerbank": "แบตสำรอง powerbank",
                        "charger": "ชาร์จ charger สายชาร์จ",
                        "case": "เคส case ซอง",
                        "screen_protector": "ฟิล์ม screen protector",
                    }
                    type_name = next(iter(prev_product_type))
                    retrieval_message = type_keywords.get(type_name, req.message)
                    # ขยาย limit เพื่อให้ได้สินค้าหลายตัว
                    # (จะตัดสินค้าที่ตอบไปแล้วในภายหลัง)

            # ถ้าปัจจุบันไม่มี product type → เป็น follow-up ให้ใช้ history ค้นสินค้า
            # ยกเว้นถ้าเป็น new topic (เช่น "อุปกรณ์ป้องกันตัว", "โทสับ") → ไม่ใช้ history
            # ยกเว้นถ้าเป็น reference question (เช่น "เรือนนี้") → ใช้ retrieval จาก reference logic แล้ว
            # ยกเว้นถ้า message ปัจจุบันมี model keyword (เช่น "lagenio k9 รับประกัน") → เป็นคำถามใหม่
            if not current_types and not is_other_model_question and not is_new_topic and not is_reference_question and not _current_has_model:
                all_user_msgs = [
                    m.text for m in req.history
                    if m.role == "user" and m.text.strip()
                ]
                all_model_texts = [
                    m.text for m in req.history
                    if m.role == "model" and m.text.strip()
                ]
                if all_user_msgs:
                    # ดึง model words จาก history ทั้งหมด (user + model)
                    # เพราะ "redmi 8a" อาจอยู่ในคำถามแรก หรือในคำตอบ model
                    # ถ้าเกิน 10 รอบ คำถามแรกที่มี model name อาจถูกตัดออก
                    # แต่คำตอบ model มักจะมี model name อยู่
                    known_brands = {"redmi", "xiaomi", "mi", "iphone", "galaxy",
                                    "samsung", "oppo", "vivo", "realme", "poco",
                                    "note", "pro", "max", "ultra", "lite", "plus",
                                    "mini", "air", "band", "watch", "bud", "pods",
                                    "tws", "shark", "blackshark", "imilab", "ec",
                                    "t11", "t2c", "a53", "kospet", "lagenio",
                                    "kieslect", "zmi", "cuktech", "70mai", "viomi",
                                    "qcy", "yaber", "1more", "leravan", "deerma",
                                    "mili", "lydsto", "eloop", "isuper", "ztec",
                                    "imiki", "heyplus", "qkz", "jbl", "sony",
                                    "anker", "baseus", "ugreen", "oraimo"}
                    # คำที่ไม่ควรเป็น keyword (เลขรายการ, คำทั่วไป)
                    _bad_words = {"1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9.", "10.",
                                  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
                                  "-", "*", "**", "***", "•", "–", "—",
                                  "บาท", "ราคา", "ร้าน", "จาก", "ของ", "จะ", "ได้",
                                  "และ", "หรือ", "เป็น", "มี", "ไม่", "ให้", "กับ"}

                    def _is_good_keyword(w: str) -> bool:
                        """ตรวจว่าคำนี้เหมาะเป็น keyword สำหรับค้นสินค้าไหม."""
                        if w in _bad_words:
                            return False
                        if len(w) < 2:
                            return False
                        # ไม่เอาตัวเลขล้วนหรือตัวเลข+จุด
                        if re.fullmatch(r"\d+\.?", w):
                            return False
                        # ไม่เอาตัวเลขมี comma (เช่น 2,099)
                        if re.fullmatch(r"[\d,]+\.?", w):
                            return False
                        return True

                    history_words = []
                    # ดึงจาก user messages ก่อน
                    for hmsg in all_user_msgs:
                        for w in re.split(r"\s+", hmsg.lower().strip()):
                            if (any(c.isdigit() for c in w) or w in known_brands) and _is_good_keyword(w):
                                if w not in history_words:
                                    history_words.append(w)
                    # ถ้ายังไม่เจอ ดึงจาก model answers (คำตอบมักมีชื่อสินค้า)
                    if not history_words:
                        for hmsg in all_model_texts:
                            for w in re.split(r"\s+", hmsg.lower().strip()):
                                if (any(c.isdigit() for c in w) or w in known_brands) and _is_good_keyword(w):
                                    if w not in history_words:
                                        history_words.append(w)

                    # ดึง product type keywords จาก history ด้วยเสมอ
                    # (แม้ว่าจะมี history_words แล้ว ก็ต้องเพิ่ม type เพื่อให้กรองสินค้าถูกประเภท)
                    history_text = " ".join(all_user_msgs)
                    prev_types = product_store._detect_product_types(history_text)
                    if not prev_types:
                        prev_types = product_store._detect_product_types_fuzzy(history_text)
                    type_keywords_map = {
                        "phone": "โทรศัพท์ มือถือ smartphone",
                        "smartwatch": "สมาร์ทวอช smartwatch นาฬิกา",
                        "earphone": "หูฟัง earphone earbuds",
                        "powerbank": "แบตสำรอง powerbank",
                        "charger": "ชาร์จ charger สายชาร์จ",
                        "case": "เคส case ซอง",
                        "speaker": "ลำโพง speaker",
                        "memory_card": "sd card memory card",
                        "camera": "กล้องวงจรปิด cctv กล้อง",
                        "projector": "โปรเจคเตอร์ projector",
                        "vacuum": "เครื่องดูดฝุ่น vacuum ดูดฝุ่น",
                        "massager": "เครื่องนวด นวด massage",
                        "soundbar": "ซาวด์บาร์ soundbar ลำโพง",
                        "scale": "เครื่องชั่ง ชั่งน้ำหนัก scale",
                        "gps_tracker": "gps tracker ติดตาม",
                        "inverter": "อินเวอร์เตอร์ inverter แปลงไฟ",
                        "microphone": "ไมโครโฟน microphone ไมค์",
                        "flash_drive": "แฟลชไดร์ฟ flash drive",
                        "air_filter": "ไส้กรอง filter",
                        "car_accessory": "70mai ปั้มลม air compressor",
                        "fan": "พัดลม fan",
                    }
                    type_words = []
                    for pt in prev_types:
                        if pt in type_keywords_map:
                            type_words.append(type_keywords_map[pt])

                    if history_words or type_words:
                        # รวม: type_words (สำคัญสุด) + history_words (brand/model) + current message
                        # แต่ถ้า current message มี type อยู่แล้ว ไม่ต้องเพิ่ม type_words
                        # ใช้แค่ exact match (ไม่ใช้ fuzzy) เพราะ fuzzy อาจตรวจผิด
                        # เช่น "เหมาะสำหรับการเดินป่า" อาจ match เป็น memory_card
                        current_types_check = product_store._detect_product_types(req.message)
                        parts = []
                        # เพิ่ม type keywords ก่อน (สำคัญสุด เพื่อให้กรองประเภทสินค้าถูก)
                        if type_words and not current_types_check:
                            parts.extend(type_words[:1])
                        # เพิ่ม history words (brand/model) — แค่จาก user messages
                        # ไม่เอาจาก model answers เพราะทำให้ bias ไปแบรนด์ที่ตอบไปก่อนหน้า
                        # ยกเว้นถ้าไม่มี type_words เลย ถึงจะใช้ history_words จาก model answers
                        if type_words:
                            # มี type_words แล้ว ใช้แค่ history_words จาก user messages
                            # (history_words จาก user messages อยู่ต้น list แล้ว เพราะดึง user ก่อน model)
                            # แยก user_words ออกจาก model_words
                            user_words = []
                            for hmsg in all_user_msgs:
                                for w in re.split(r"\s+", hmsg.lower().strip()):
                                    if (any(c.isdigit() for c in w) or w in known_brands) and _is_good_keyword(w):
                                        if w not in user_words:
                                            user_words.append(w)
                            parts.extend(user_words[:3])
                        else:
                            # ไม่มี type_words ใช้ history_words ทั้งหมด (รวมจาก model answers)
                            parts.extend(history_words[:3])
                        # เพิ่มคำถามปัจจุบันเสมอ
                        parts.append(req.message)
                        retrieval_message = " ".join(parts)
                    else:
                        # fallback: ใช้ history ล่าสุด
                        recent = all_user_msgs[-2:]
                        retrieval_message = " ".join(recent) + " " + req.message

        _t1 = _time.time()
        products = product_store.fetch_products(
            db,
            message=retrieval_message,
            shop_filter=req.shop,
            limit=req.limit,
            desc_message=desc_message,
        )
        print(f"[TIMING] fetch_products: {_time.time()-_t1:.2f}s  (retrieval={retrieval_message!r})", file=sys.stderr)

        # ⚠️ Fallback: ถ้าไม่เจอสินค้าเลย และลูกค้าทักจากร้านใดร้านหนึ่ง
        # ให้ดึงสินค้าอื่นจากร้านเดียวกันมาเป็นทางเลือกให้ LLM แนะนำ
        # (เช่น ถาม "imilab ec4" ที่ร้าน BlackShark → ไม่มี → ดึงสินค้าอื่นของ BlackShark มาแนะนำ)
        if not products and req.shop:
            _t_alt = _time.time()
            alt_products = product_store.fetch_products(
                db,
                message="สินค้า แนะนำ มาใหม่ โปรด",  # คำค้นกว้างๆ เพื่อดึงสินค้าทั่วไปของร้าน
                shop_filter=req.shop,
                limit=5,
            )
            if alt_products:
                products = alt_products
                # ใส่ note ให้ LLM รู้ว่าเป็นสินค้าทางเลือก (ไม่ใช่สินค้าที่ลูกค้าถาม)
                if products:
                    products[0]["_context_note"] = (
                        f"⚠️ สินค้าเหล่านี้เป็นสินค้าอื่นจากร้าน {req.shop} "
                        f"ที่นำมาเสนอเป็นทางเลือก เพราะร้าน {req.shop} ไม่มีสินค้าที่ลูกค้าถาม "
                        f"ให้บอกลูกค้าก่อนว่าร้านนี้ไม่มีสินค้าที่ถาม แล้วค่อยแนะนำสินค้าเหล่านี้แทน"
                    )
                print(f"[TIMING] Shop fallback (alt products): {_time.time()-_t_alt:.2f}s  products={len(products)}", file=sys.stderr)
        # ถ้าเป็น follow-up (retrieval_message != req.message) ให้เก็บแค่สินค้า top 1
        # ที่ตรงกับ model ที่ลูกค้าถาม ไม่ส่งสินค้าอื่นปน เพื่อให้ LLM ตอบตรงจุด
        if retrieval_message != req.message and products:
            # หา model words จาก retrieval_message
            known_brands = {"redmi", "xiaomi", "mi", "iphone", "galaxy",
                            "samsung", "oppo", "vivo", "realme", "poco",
                            "note", "pro", "max", "ultra", "lite", "plus",
                            "mini", "air", "band", "watch", "bud", "pods",
                            "tws", "shark", "blackshark", "imilab", "ec",
                            "t11", "t2c", "a53"}
            model_words = [w for w in re.split(r"\s+", retrieval_message.lower().strip())
                           if (any(c.isdigit() for c in w) or w in known_brands) and len(w) >= 2]
            if model_words:
                # เก็บเฉพาะสินค้าที่ชื่อมีทุก model word (exact match)
                exact = [p for p in products
                         if all(w in (p.get("name","") or "").lower() for w in model_words)]
                if exact:
                    products = exact[:3]  # เก็บแค่ 3 ตัวแรกที่ตรงที่สุด

        # ถ้าเป็น comparison query (มี "vs" หรือ "เปรียบเทียบ")
        # ให้เก็บแค่ 1 ตัวต่อรุ่น เพื่อลด token และเร็วขึ้น
        msg_lower = req.message.lower()
        is_comparison = (" vs " in msg_lower or "เปรียบเทียบ" in msg_lower
                         or "เทียบ" in msg_lower or "compare" in msg_lower)
        if is_comparison and products:
            model_tokens = product_store._extract_model_tokens(req.message)
            if model_tokens:
                # เก็บ 1 ตัวต่อรุ่น (เอาตัวแรกที่ชื่อขึ้นต้นด้วย model name)
                # ใช้ word boundary เพื่อกัน match ผิด (เช่น EC5 ไม่ควร match "EC3/EC4/EC5/EC6")
                seen_tokens: set[str] = set()
                unique_products: list[dict] = []
                for p in products:
                    name = (p.get("name","") or "").lower()
                    # ข้ามสินค้าที่เป็น accessories (adapter, panel, stand, case, etc.)
                    if any(acc in name for acc in ["adapter", "panel", "stand", "case",
                                                    "แผงโซล่า", "ชั้นวาง", "ที่ชาร์จ"]):
                        continue
                    for token in model_tokens:
                        token_lower = token.lower()
                        # ใช้ word boundary และต้องอยู่ในคำแรกๆ ของชื่อ
                        if re.search(r"\b" + re.escape(token_lower) + r"\b", name):
                            if token_lower not in seen_tokens:
                                seen_tokens.add(token_lower)
                                unique_products.append(p)
                                break
                if len(seen_tokens) >= 2:  # เปรียบเทียบ 2+ รุ่น
                    products = unique_products
                    # เติมรุ่นที่ไม่มีใน Mongo ด้วย KB (เช่น EC6 ตัวเปล่า อาจมีแค่ใน KB)
                    missing_tokens = [t for t in model_tokens if t.lower() not in seen_tokens]
                    if missing_tokens:
                        _t_kb = _time.time()
                        kb_comp = knowledge_base.lookup_kb(" ".join(missing_tokens))
                        if kb_comp and kb_comp.get("found"):
                            for kd in kb_comp.get("kb_docs", []):
                                model = (kd.get("model") or "").lower()
                                # เช็คว่า model ตรงกับ missing token ไหม
                                for mt in missing_tokens:
                                    if mt.lower() in model and mt.lower() not in seen_tokens:
                                        card = _kb_doc_to_card(kd)
                                        card["_kb_only"] = True
                                        card["_source"] = "kb"
                                        products.append(card)
                                        seen_tokens.add(mt.lower())
                                        break
                        print(f"[TIMING] KB comparison fill: {_time.time()-_t_kb:.2f}s  missing={missing_tokens}", file=sys.stderr)

        # ถ้ามีสินค้า UNLIST/SELLER_DELETE ปนอยู่ (จากคำถามเรื่องรับประกัน)
        # ให้ดึงสินค้า NORMAL รุ่นอื่นมาเพิ่ม เพื่อให้ LLM มีทางเลือกแนะนำลูกค้า
        has_unlist = any(p.get("status") != "NORMAL" for p in products)
        if has_unlist and products:
            # ดึงสินค้า NORMAL ที่เป็นประเภทเดียวกัน มาเป็นทางเลือก
            # ใช้ product type detection เพื่อหาประเภท
            ptypes = product_store._detect_product_types(retrieval_message)
            if ptypes:
                # สร้าง query ใหม่ที่กรองเฉพาะ NORMAL ของประเภทเดียวกัน
                alt_msg = " ".join(ptypes)  # เช่น "phone"
                alt_products = product_store.fetch_products(
                    db,
                    message=alt_msg,
                    shop_filter=req.shop,
                    limit=5,
                )
                # แยกกลุ่ม: UNLIST (ตอบ warranty) + NORMAL (แนะนำทางเลือก)
                unlist_products = [p for p in products if p.get("status") != "NORMAL"]
                normal_products = [p for p in products if p.get("status") == "NORMAL"]
                # จำกัด UNLIST ให้เหลือแค่ 2 ตัวแรก (พอตอบ warranty)
                # เว้นที่ให้ NORMAL เป็นทางเลือก
                unlist_products = unlist_products[:2]
                # รวม: UNLIST ก่อน (เป็นสินค้าที่ถาม) + NORMAL จาก alt (ทางเลือก)
                seen_ids = set()
                merged = []
                for p in unlist_products + normal_products + alt_products:
                    pid = p.get("item_id") or p.get("name")
                    if pid in seen_ids:
                        continue
                    seen_ids.add(pid)
                    merged.append(p)
                products = merged[:req.limit]

            # ใส่ context note ชัดๆ
            unlist_note = (
                "สินค้าที่ status != NORMAL (UNLIST/SELLER_DELETE) เลิกขายแล้ว — "
                "ห้ามเสนอขาย/แสดงราคา/แสดงลิงก์สั่งซื้อ "
                "ตอบเฉพาะเงื่อนไขรับประกันของสินค้านั้น แล้วบอกว่ารุ่นนี้เลิกขายแล้ว "
                "ถ้าลูกค้าอยากซื้อ ให้แนะนำเฉพาะสินค้า status=NORMAL เท่านั้น"
            )
            if products:
                if "_context_note" not in products[0]:
                    products[0]["_context_note"] = unlist_note
                else:
                    products[0]["_context_note"] = products[0]["_context_note"] + " " + unlist_note

        import time as _time
        _llm_start = _time.time()
        try:
            answer, usage_info = llm.answer(
                message=desc_message,
                products=products,
                shop_hint=req.shop,
                history=history,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        _llm_elapsed = _time.time() - _llm_start
        _total_elapsed = _time.time() - _total_start
        print(f"[TIMING] LLM: {_llm_elapsed:.2f}s  TOTAL: {_total_elapsed:.2f}s", file=sys.stderr)
        model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
        # คำนวณต้นทุนประมาณ (gemini-3.5-flash-lite: $0.30/M input, $2.50/M output)
        prompt_t = usage_info.get("prompt", 0)
        output_t = usage_info.get("output", 0)
        cost = (prompt_t * 0.30 + output_t * 2.50) / 1_000_000
        answer = _append_base_warranty(answer, desc_message)
        return ChatResponse(
            answer=answer,
            products=products,
            shop=req.shop,
            model=model_name,
            source="product_store",
            usage=usage_info,
            elapsed=round(_total_elapsed, 2),
            cost=round(cost, 6),
        )
    finally:
        pass  # ไม่ปิด client เพราะใช้ cache


def _append_base_warranty(answer: str, message: str, source: str = "") -> str:
    """ถ้าคำถามเกี่ยวกับประกัน/เคลม → แนบเงื่อนไขการรับประกันสินค้าเบื้องต้นท้ายคำตอบ.

    แนบเฉพาะถ้า:
    - คำถามเกี่ยวประกัน/เคลม
    - คำตอบยังไม่มีเงื่อนไขเบื้องต้นอยู่แล้ว (กันซ้ำ)
    - ไม่ใช่ general:warranty_policy (เพราะ context มี general_faq อยู่แล้ว)
    """
    if not answer:
        return answer
    if not knowledge_base.is_warranty_question(message):
        return answer
    # ถ้าเป็น general:warranty_policy → context มี general_faq อยู่แล้ว ไม่ต้องแนบซ้ำ
    if source == "general:warranty_policy":
        return answer
    base_text = knowledge_base.get_base_warranty_text()
    # ตรวจว่าคำตอบมีเงื่อนไขเบื้องต้นอยู่แล้วไหม (กันซ้ำ)
    # ตรวจเฉพาะข้อความจำเพาะของ base warranty ไม่ใช่คำทั่วไป เช่น "เงื่อนไขการรับประกัน"
    # เพราะคำตอบสินค้าเฉพาะมักมีคำว่า "เงื่อนไขการรับประกัน" อยู่แล้ว แต่ไม่ใช่ base warranty
    duplicate_markers = [
        "เงื่อนไขการรับประกันสินค้าเบื้องต้น",
        "กรุณาถ่ายวิดีโอขณะแกะกล่องพัสดุสินค้า",
        "กรุณาถ่ายวิดีโอขณะแกะกล่อง",
    ]
    if any(marker in answer for marker in duplicate_markers):
        return answer
    # แนบท้าย
    return f"{answer}\n\n---\n**เงื่อนไขการรับประกันสินค้าเบื้องต้น**\n{base_text}"


def _detect_brand_question(message: str) -> str | None:
    """ตรวจว่าลูกค้าถามเกี่ยวกับแบรนด์เฉพาะหรือไม่ (เช่น "Xiaomi ขายอะไรบ้าง").

    คืนชื่อแบรนด์ หรือ None.
    """
    import re
    low = message.lower().strip()
    # ต้องมีคำว่า "ขายอะไร" หรือ "มีอะไร" หรือ "สินค้าอะไร" ฯลฯ
    brand_indicators = [
        "ขายอะไร", "มีอะไร", "สินค้าอะไร", "มีสินค้าอะไร",
        "ผลิตภัณฑ์อะไร", "ทำอะไร", "มีกี่รุ่น", "มีอะไรบ้าง",
    ]
    if not any(ind in low for ind in brand_indicators):
        return None

    # แบรนด์ที่รู้จัก (เช็คจากชื่อที่พบบ่อย)
    known_brands = [
        "xiaomi", "redmi", "poco", "imilab", "black shark", "blackshark",
        "cuktech", "ztec", "ztec", "isuper", "deerma", "leravan",
        "mili", "kospet", "lydsto", "eloop", "yaber", "1more",
        "kieslect", "zmi", "lagenio", "70mai", "viomi", "qcy",
        "ticwatch", "pioneer", "hoco", "adata", "apacer", "asus",
        "bear", "freetie", "binnifa", "godung", "ice",
    ]
    for brand in known_brands:
        if brand in low:
            return brand
    return None


def _build_brand_context(db, brand: str, shop_filter: str | None = None) -> dict[str, Any] | None:
    """สร้าง context สำหรับ brand-specific question (เช่น Xiaomi ขายอะไรบ้าง).

    Args:
        shop_filter: ถ้าระบุ (ลูกค้าทักมาจากร้านนี้) จำกัดเฉพาะสินค้าแบรนด์นี้ในร้านนั้น
    """
    import os
    import re
    from collections import Counter

    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    coll = db[coll_name]

    # ดึงสินค้าของแบรนด์นี้ (จำกัดร้าน ถ้ามี shop_filter)
    brand_lower = brand.lower()
    query: dict[str, Any] = {"item_status": "NORMAL"}
    if shop_filter:
        query["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}
    docs = list(coll.find(
        query,
        {"brand": 1, "cat_name": 1, "item_name": 1}
    ).limit(10000))

    brand_cats: dict[str, set[str]] = {}
    brand_products: list[str] = []
    product_count = 0
    for d in docs:
        b = d.get("brand", "")
        if isinstance(b, dict):
            bname = (b.get("original_brand_name", "") or "").lower()
        else:
            bname = str(b).lower() if b else ""
        if brand_lower not in bname:
            continue
        product_count += 1
        c = d.get("cat_name", "")
        if c:
            brand_cats.setdefault(str(c), set())
        name = d.get("item_name", "")
        if name and len(brand_products) < 10:
            brand_products.append(str(name)[:60])

    if product_count == 0:
        return None

    cats = sorted(brand_cats.keys())
    scope_label = f"ร้าน {shop_filter}" if shop_filter else f"แบรนด์ {brand}"
    parts = [
        f"=== สินค้าของแบรนด์ {brand} ใน{scope_label} ({product_count} สินค้า) ===",
        f"หมวดหมู่ที่มี: {', '.join(cats)}",
        f"\nตัวอย่างสินค้า:",
    ]
    for name in brand_products:
        parts.append(f"- {name}")

    context = "\n".join(parts)
    return {
        "qtype": "brand_info",
        "context": context,
        "meta": {"product_count": product_count, "categories": cats, "shop_scoped": bool(shop_filter)},
    }


def _merge_kb_mongo(kb_docs: list[dict], mongo_products: list[dict]) -> list[dict]:
    """รวม KB + Mongo — KB ให้ warranty/specs/highlights, Mongo ให้ ราคา/ร้าน/ลิงก์/image.

    กฎ:
    - ถ้ารุ่นมีใน Mongo → ใช้ Mongo card เป็นหลัก + เติม warranty/highlights/specs จาก KB
    - ถ้ารุ่นมีแค่ใน KB (ไม่มีใน Mongo) → สร้าง card จาก KB อย่างเดียว 标记 _kb_only
    - ถ้ารุ่นมีแค่ใน Mongo → ใช้ Mongo card เดิม
    """
    import re

    def _norm(s: str) -> str:
        return re.sub(r"\s+", "", (s or "").lower().strip())

    # index KB docs by normalized model
    kb_by_model: dict[str, dict] = {}
    for d in kb_docs:
        key = _norm(f"{d.get('brand','')} {d.get('model','')}")
        kb_by_model[key] = d
        # ใส่ key แบบ model only ด้วย
        model_key = _norm(d.get("model", ""))
        if model_key and model_key not in kb_by_model:
            kb_by_model[model_key] = d
        # ใส่ key แบบ model token ย่อย (เช่น "k9" จาก "Lagenio K 9")
        # เพื่อ match กับสินค้าที่มีคำอื่นคั่น (เช่น "Lagenio Watch Phone K9 Ai")
        model_str = (d.get("model") or "").strip()
        brand_str = (d.get("brand") or "").strip()
        full_norm = _norm(f"{brand_str} {model_str}")
        brand_norm = _norm(brand_str)
        # สกัด model โดยตัด brand ออก
        model_only_norm = full_norm.replace(brand_norm, "", 1).strip() if brand_norm else full_norm
        # หา pattern ที่เป็นตัวอักษร+ตัวเลข อย่างน้อย 2 ตัว (เช่น k9, ec6, ks3)
        import re as _re
        # pattern 1: full token (เช่น lageniok9, ec6, ks3)
        full_tokens = _re.findall(r"[a-z]+\d+[a-z]*", model_only_norm)
        # pattern 2: short code ท้าย (เช่น k9 จาก lageniok9, ec6 จาก imilabec6)
        short_codes = _re.findall(r"[a-z]{1,3}\d+[a-z]*", model_only_norm)
        all_tokens = full_tokens + short_codes
        for st in all_tokens:
            if st and len(st) >= 2 and st not in kb_by_model:
                kb_by_model[st] = d

    merged: list[dict] = []
    matched_kb_keys: set[str] = set()

    for p in mongo_products:
        card = dict(p)  # copy Mongo card
        p_name = _norm(p.get("name", ""))
        p_brand = _norm(p.get("brand", "") or "")
        # หา KB doc ที่ match — เรียงตามความยาว key (ยาวกว่า = จำเพาะกว่า)
        best_kb = None
        best_key = None
        for key, kd in sorted(kb_by_model.items(), key=lambda x: len(x[0]), reverse=True):
            if not key or len(key) < 2:
                continue
            if key in p_name:
                # ถ้า key สั้น (เช่น "k9") ต้องเช็ค brand ด้วยเพื่อกัน false positive
                kb_brand = _norm(kd.get("brand", ""))
                if len(key) <= 4 and kb_brand and kb_brand not in p_name and p_brand and kb_brand not in p_brand:
                    continue
                best_kb = kd
                best_key = key
                break
        if best_kb:
            matched_kb_keys.add(best_key)
            # เติม warranty จาก KB (ถ้า Mongo ไม่มี หรือ KB ละเอียดกว่า)
            kb_wp = best_kb.get("warranty_period", "")
            kb_wn = best_kb.get("warranty_note", "")
            if kb_wp or kb_wn:
                card["warranty"] = {
                    "type": "KB",
                    "duration": kb_wp,
                    "note": kb_wn,
                }
            # เติม highlights จาก KB
            if best_kb.get("highlights"):
                card["kb_highlights"] = best_kb["highlights"]
            # เติม specs จาก KB
            if best_kb.get("specs"):
                card["kb_specs"] = best_kb["specs"]
            # เติม box_contents จาก KB
            if best_kb.get("box_contents"):
                card["kb_box_contents"] = best_kb["box_contents"]
            card["_source"] = "kb+mongo"
        else:
            card["_source"] = "mongo"
        merged.append(card)

    # เพิ่ม KB docs ที่ไม่มีใน Mongo
    for key, kd in kb_by_model.items():
        if key in matched_kb_keys:
            continue
        if not kd.get("model"):
            continue
        card = _kb_doc_to_card(kd)
        card["_kb_only"] = True
        card["_source"] = "kb"
        merged.append(card)

    return merged


def _kb_doc_to_card(doc: dict) -> dict:
    """แปลง KB doc → product card format (สำหรับ frontend)."""
    return {
        "name": f"{doc.get('brand', '')} {doc.get('model', '')}".strip(),
        "brand": doc.get("brand", ""),
        "model": doc.get("model", ""),
        "category": doc.get("category", ""),
        "category_id": doc.get("category_id", ""),
        "highlights": doc.get("highlights", ""),
        "description": doc.get("description", ""),
        "warranty_period": doc.get("warranty_period", ""),
        "warranty_note": doc.get("warranty_note", ""),
        "box_contents": doc.get("box_contents", ""),
        "specs": doc.get("specs", {}),
        "source": "knowledge_base",
        "source_file": doc.get("source_file", ""),
    }


@app.post("/feedback")
def feedback(req: FeedbackRequest) -> dict[str, str]:
    """รับ feedback (thumbs up/down) จากลูกค้า.

    ตอนนี้แค่ log ไว้ ไม่เก็บ DB (สามารถเพิ่ม collection สำหรับเก็บได้ภายหลัง).
    """
    rating = req.rating if req.rating in ("up", "down", "clear") else "unknown"
    if rating != "clear":
        print(f"[FEEDBACK] rating={rating}  answer='{req.answer[:80]}...'")
    return {"status": "ok", "rating": rating}
