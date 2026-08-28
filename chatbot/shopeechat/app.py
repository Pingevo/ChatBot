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

# โหลด .env ก่อน import llm — llm.py อ่าน GEMINI_API_KEY_1..9 ตอน import
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

from . import llm, product_store, knowledge_base, persona

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
    limit: int = Field(10, ge=1, le=50, description="จำนวนสินค้าสูงสุดที่จะส่งเป็น context")
    # ── Warranty claim handoff ──
    # conversation_id ของแชทในระบบ admin (ถ้ามี) — ใช้ตอนบอทส่งต่อแอดมิน
    conversation_id: str | None = Field(None, description="conversation_id ในระบบ admin (สำหรับ handoff)")
    platform: str | None = Field(None, description="platform ของแชท (shopee/tiktok/lazada) — สำหรับ handoff")
    # ⚡ simulate mode — จำลองการจ่ายงานโดยไม่กระทบ conversations จริง (ใช้ใน test chat)
    simulate_assignment: bool = Field(False, description="ถ้า true → handoff จะเก็บลง test_chat_sessions ไม่ใช่ conversations")


class ChatResponse(BaseModel):
    answer: str
    products: list[dict[str, Any]]
    shop: str | None
    model: str
    source: str = Field("product_store", description="knowledge_base | product_store")
    usage: dict[str, int] = Field(default_factory=dict, description="token usage: prompt, output, total")
    elapsed: float = Field(0.0, description="เวลาที่ใช้ (วินาที)")
    cost: float = Field(0.0, description="ต้นทุนประมาณ (USD)")
    # Phase 1 — multi-bubble: LLM แยกคำตอบเป็นหลาย segment ด้วย delimiter |||
    # ฝั่ง caller (Next.js/admin) แยกด้วย ||| เพื่อส่งเป็นหลาย bubble ในแชท
    # ถ้า LLM สร้าง segment เดียว → answer_segments = [answer] (มีค่าเดียวกับ answer)
    # ถ้าไม่มีการใช้งาน multi-bubble → caller ใช้ answer อย่างเดียวได้ (backward-compat)
    answer_segments: list[str] = Field(
        default_factory=list,
        description="คำตอบแยกเป็นหลาย segment (สำหรับ multi-bubble) — ถ้าว่าง caller ใช้ field answer",
    )
    # ── Warranty claim handoff ──
    # บอทตั้งค่านี้เป็น true เมื่อถึงจุดที่ต้องส่งต่อแอดมิน
    # caller (Next.js/admin) ใช้ flag นี้ trigger UI/notify แอดมิน
    handoff_to_admin: bool = Field(False, description="บอทขอส่งต่อแอดมิน (warranty claim)")
    handoff_reason: str | None = Field(None, description="เหตุผลที่ส่งต่อ เช่น 'warranty_claim_in_warranty' | 'warranty_claim_out_of_warranty'")
    # ข้อมูล claim ที่บอทรวบรวมจากลูกค้า (ส่งให้แอดมิน)
    handoff_claim: dict[str, Any] = Field(default_factory=dict, description="ข้อมูล warranty claim: name, phone, order_id, topic, product, warranty_status")
    # ── Pass 1 intent classification (debug/observability) ──
    intent: dict[str, Any] = Field(default_factory=dict, description="ผล Pass 1 intent classification: intent, product_type, charger_subtype, target_device, needs_description, confidence")
    timing: dict[str, float] = Field(default_factory=dict, description="timing breakdown: pass1, retrieval, llm, total")
    retrieval_info: dict[str, Any] = Field(default_factory=dict, description="ข้อมูล retrieval: path, product_count, fallback_used")
    # ── Web search fallback (ด่านสุดท้าย) ──
    web_search_used: bool = Field(False, description="ใช้ OpenRouter + Google Search หรือไม่")
    web_search_reason: str | None = Field(None, description="เหตุผลที่ใช้ web search เช่น 'answer_uncertain' | 'pass1_low_confidence'")
    web_search_model: str | None = Field(None, description="โมเดล OpenRouter ที่ใช้")
    # ── Per-step breakdown (สำหรับ log panel) ──
    steps: list[dict[str, Any]] = Field(
        default_factory=list,
        description="แต่ละ step: {name, model, tokens_in, tokens_out, time_s, cost_usd, cost_thb, detail}",
    )
    # ── Routing decision (observability) ──
    # อธิบายว่าทำไมคำตอบนี้เข้าบอท หรือ ส่งต่อแอดมิน
    # ใช้แสดงใน TestChat + Shadow Inbox เพื่อ debug routing
    routing_decision: dict[str, Any] = Field(
        default_factory=dict,
        description="routing decision: {path, reason, trigger_matched, shop_settings_action, assigned_admin}",
    )


class FeedbackRequest(BaseModel):
    answer: str = Field(..., description="คำตอบที่ลูกค้าให้ feedback (สูงสุด 500 ตัวอักษร)")
    rating: str = Field(..., description="up | down | clear")


# ---- helpers ------------------------------------------------------------------

def _routing(
    path: str,
    reason: str,
    *,
    trigger_matched: str | None = None,
    shop_settings_action: str | None = None,
    assigned_admin: str | None = None,
    assigned_admin_name: str | None = None,
    handoff_reason: str | None = None,
) -> dict:
    """สร้าง routing_decision dict สำหรับ observability"""
    return {
        "path": path,
        "reason": reason,
        "trigger_matched": trigger_matched,
        "shop_settings_action": shop_settings_action,
        "assigned_admin": assigned_admin,
        "assigned_admin_name": assigned_admin_name,
        "handoff_reason": handoff_reason,
    }


def _db():
    """เปิด client + เลือก db ใหม่ทุกครั้ง (stateless สำหรับ API แบบง่าย).

    หากต้องการ reuse connection ข้าม request ใช้ app.state หรือ dependency injection.
    """
    client = product_store.get_client()
    db_name = os.environ.get("MONGO_DB", "").strip()
    if not db_name:
        raise SystemExit("ERROR: MONGO_DB ไม่ถูกตั้งใน .env")
    return client, client[db_name]


def _admin_db():
    """DB สำหรับ admin data (test_chat_sessions, etc.) — ใช้ admin client."""
    db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    return knowledge_base._build_admin_client()[db_name]


def _log_testchat_action(action: str, request, session_id: str | None = None, **extra):
    """เก็บ log การใช้งาน testchat — ใคร ทำอะไร แชทไหน เมื่อไหร่.

    Collection: test_chat_logs
    Fields: action, session_id, admin_id, admin_name, shop, timestamp, extra
    """
    try:
        db = _admin_db()
        from urllib.parse import unquote
        admin_id = (request.headers.get("X-Admin-Id") if request else None) or "anonymous"
        admin_name_raw = (request.headers.get("X-Admin-Name") if request else None) or ""
        admin_name = unquote(admin_name_raw) if admin_name_raw else "anonymous"
        doc = {
            "action": action,
            "session_id": session_id,
            "admin_id": admin_id,
            "admin_name": admin_name,
            "timestamp": datetime.now(timezone.utc),
            **extra,
        }
        db["test_chat_logs"].insert_one(doc)
    except Exception:
        pass  # logging ต้องไม่ทำให้ request fail


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
    _timing_breakdown: dict[str, float] = {}  # pass1, retrieval, llm, total
    _steps: list[dict[str, Any]] = []  # per-step breakdown for log panel
    _GEMINI_COST_PER_M = {"prompt": 0.30, "output": 2.50}  # gemini-3.5-flash-lite
    client, db = _db()
    try:
        history = [{"role": m.role, "text": m.text} for m in req.history]

        # ===== ดึง persona ของร้าน (Phase 3 — admin ตั้งชื่อตัวแทนบอทในหน้า /persona) =====
        # ถ้าร้านยังไม่ได้ตั้ง persona → persona_extra = "" → ใช้ SYSTEM_INSTRUCTION เดิม (default behavior)
        # บุคลิกหลัก (ค่ะ/นะคะ/ผู้หญิง) เหมือนกันทุกร้าน — persona แค่เพิ่มชื่อตัวแทนของร้านนั้น
        _persona_doc = persona.get_persona(req.shop, platform="shopee")
        _persona_extra = persona.build_persona_instruction(_persona_doc, req.shop)

        # ===== Phase 2 (ลบแล้ว) — เคยใช้ random variation pool แต่ทำให้คำตอบงง/ไม่เป็นธรรมชาติ =====
        # ตอนนี้ใช้แค่ persona_extra (ถ้ามี) + SYSTEM_INSTRUCTION อย่างเดียว
        # การตอบเป็นธรรมชาติอยู่ที่ temperature 0.3 + กฎ multi-bubble ใน SYSTEM_INSTRUCTION

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
            # ใช้ desc_message ที่มี keyword "รายละเอียด" เพื่อให้ _clean_description ส่ง spec section
            _desc_msg = _clean_message or "รายละเอียดสินค้า"
            anchor_card = product_store.fetch_product_by_id(
                db, _tagged_item_id, shop_filter=req.shop,
                desc_message=_desc_msg,
            )
            if anchor_card:
                # ถ้าลูกค้าไม่ได้พิมพ์คำถามเพิ่ม (ส่งแค่การ์ดสินค้ามาเฉย ๆ)
                # ให้ตั้งคำถามแทน โดยบอกชัดว่าลูกค้าระบุสินค้านี้แล้ว (ผ่านการแชร์การ์ดสินค้า)
                # ป้องกัน LLM เข้าใจผิดว่า "ยังไม่ได้ระบุสินค้า"
                _followup_q = (
                    _clean_message
                    or "ลูกค้าส่งการ์ดสินค้าชิ้นนี้มาในแชท สนใจสอบถามว่ามีของไหม และอยากดูรายละเอียดสินค้า"
                )
                try:
                    answer, usage_info = llm.answer(
                        message=_followup_q,
                        products=[anchor_card],
                        shop_hint=req.shop,
                        history=history,
                        persona_extra=_persona_extra,
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
                    answer_segments=llm.split_segments(answer),
                    products=[anchor_card],
                    shop=req.shop,
                    model=model_name,
                    source="item_tag",
                    usage=usage_info,
                    elapsed=round(_total_elapsed, 2),
                    cost=round(cost, 6),
                    steps=_steps,
                    routing_decision=_routing("bot_reply", "item_tag: ลูกค้าคลิกสินค้า → ตอบจาก tag"),
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
        # ตรวจ claim request — ถ้าเป็น claim request ไม่เข้า followup_policy
        # เพราะ claim request ต้องเข้า warranty claim state machine ไม่ใช่ดึงสินค้า
        from . import warranty as _warranty_check_mod
        _is_claim_request = _warranty_check_mod.detect_claim_request(req.message)

        # ===== Tax invoice → handoff แอดมินเลย (ก่อน general_qtype และ claim_request) =====
        # ถ้าลูกค้าขอใบกำกับภาษี หรือส่งข้อมูลใบกำกับภาษี → ส่งแอดมินโดยตรง
        # ไม่ต้องให้บอทตอบเอง เพราะใบกำกับภาษีต้องแอดมินดำเนินการ
        # ตรวจก่อน claim_request เพราะ "เลขผู้เสียภาษี" มีคำว่า "เสีย" ที่ match claim request
        _is_tax_invoice = _warranty_check_mod.detect_tax_invoice_request(req.message)
        if _is_tax_invoice:
            _tax_answer = (
                f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
                f"เพื่อดำเนินการเรื่องใบกำกับภาษีให้นะคะ "
                f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
            )
            _total_elapsed = _time.time() - _total_start
            model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
            # ส่งต่อแอดมิน (best-effort)
            if req.conversation_id:
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
                        "reason": "tax_invoice_request",
                        "claim": {"topic": "ใบกำกับภาษี"},
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
                        urllib.request.urlopen(_handoff_req, timeout=3)
                        print("[TAX-HANDOFF] sent to admin", file=sys.stderr)
                    except Exception as _he:
                        print(f"[TAX-HANDOFF] handoff failed: {_he}", file=sys.stderr)
                except Exception as _he:
                    print(f"[TAX-HANDOFF] error: {_he}", file=sys.stderr)
            print(f"[TIMING] TAX-HANDOFF: {_total_elapsed:.2f}s", file=sys.stderr)
            return ChatResponse(
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
                routing_decision=_routing(
                    "handoff", "tax_invoice: ลูกค้าขอใบกำกับภาษี → ส่งแอดมิน",
                    handoff_reason="tax_invoice_request",
                ),
            )

        # ===== Pass 1: LLM Intent Classification (เฉพาะจุดอ่อน) =====
        # เรียก LLM รอบแรกเพื่อจำแนก intent ก่อนเข้า flow หลัก
        # ใช้เฉพาะเมื่อ hardcoded detection ไม่มั่นใจ (ประหยัดเวลาในกรณีชัดเจน)
        from . import intent_classifier as _ic
        _intent_result: dict = {}
        _has_warranty_history = bool(history and any(
            any(kw in h.get("text", "").lower()
                for kw in ("รับประกัน", "ประกัน", "เคลม", "warranty", "claim"))
            for h in history if h.get("role") == "model"
        ))
        _pre_product_types = product_store._detect_product_types(req.message)
        if not _pre_product_types:
            _pre_product_types = product_store._detect_product_types_fuzzy(req.message)
        if _ic.should_run_pass1(
            message=req.message,
            claim_detected=_is_claim_request,
            product_types=_pre_product_types,
            has_warranty_history=_has_warranty_history,
        ):
            _t_intent = _time.time()
            _intent_result = _ic.classify_intent(
                message=req.message,
                history=history,
                shop=req.shop,
            )
            _timing_breakdown["pass1"] = round(_time.time() - _t_intent, 3)
            print(f"[TIMING] Pass1 intent: {_timing_breakdown['pass1']}s", file=sys.stderr)
            # record step — Intent (gemini 3.1 flash lite: $0.25/M in, $0.50/M out)
            _INTENT_COST = {"prompt": 0.25, "output": 0.50}
            _intent_usage = _intent_result.get("usage", {})
            _intent_t_in = _intent_usage.get("prompt", 0)
            _intent_t_out = _intent_usage.get("output", 0)
            _intent_cost = (_intent_t_in * _INTENT_COST["prompt"] + _intent_t_out * _INTENT_COST["output"]) / 1_000_000
            _steps.append({
                "name": "Intent",
                "model": _intent_result.get("model", "gemini-3.1-flash-lite"),
                "tokens_in": _intent_t_in,
                "tokens_out": _intent_t_out,
                "time_s": _timing_breakdown["pass1"],
                "cost_usd": round(_intent_cost, 6),
                "cost_thb": round(_intent_cost * 36, 4),
                "input": {
                    "message": req.message,
                    "history_count": len(history) if history else 0,
                    "shop": req.shop,
                },
                "output": {
                    "intent": _intent_result.get("intent"),
                    "confidence": _intent_result.get("confidence"),
                    "product_type": _intent_result.get("product_type"),
                    "charger_subtype": _intent_result.get("charger_subtype"),
                    "target_device": _intent_result.get("target_device"),
                    "needs_description": _intent_result.get("needs_description"),
                },
            })
            # ใช้ intent ปรับ hardcoded detection:
            # 1. ถ้า LLM บอกไม่ใช่ warranty_claim แต่ hardcoded บอกใช่ → ยกเลิก
            if _is_claim_request and _intent_result.get("intent") != "warranty_claim":
                if _intent_result.get("confidence", 0) >= 0.7:
                    print(f"[INTENT] override: claim_request=False (LLM says {_intent_result.get('intent')})", file=sys.stderr)
                    _is_claim_request = False
            # 2. ถ้า LLM บอกเป็น warranty_claim แต่ hardcoded ไม่บอก → เชื่อ LLM
            #    แต่ถ้า context ก่อนหน้าเป็น product recommendation และ message ไม่มี warranty keywords
            #    ให้ไม่เชื่อ LLM (ป้องกัน false positive เช่น "ทำไมเอา 3 a มาให้")
            elif not _is_claim_request and _intent_result.get("intent") == "warranty_claim":
                if _intent_result.get("confidence", 0) >= 0.7:
                    # เช็คว่า message มี warranty keywords จริงไหม
                    _warranty_kw_strong = ("เคลม", "เสีย", "ซ่อม", "พัง", "ไม่ทำงาน",
                        "เปลี่ยนสินค้า", "คืนเงิน", "warranty", "claim", "broken")
                    _has_warranty_kw = any(kw in req.message.lower() for kw in _warranty_kw_strong)
                    # เช็คว่า history ก่อนหน้าเป็น product recommendation ไหม
                    _prev_is_product = bool(history and any(
                        (m.get("role") if isinstance(m, dict) else m.role) == "user" and any(
                            pkw in ((m.get("text") if isinstance(m, dict) else m.text) or "").lower() for pkw in
                            ("สาย", "หัวชาร์จ", "ชาร์จ", "พาวเวอร์แบงค์", "แบตสำรอง",
                             "รุ่น", "สเปค", "ราคา", "มีไหม", "แนะนำ")
                        ) for m in history
                    ))
                    if _has_warranty_kw or not _prev_is_product:
                        print(f"[INTENT] override: claim_request=True (LLM says warranty_claim)", file=sys.stderr)
                        _is_claim_request = True
                    else:
                        print(f"[INTENT] skip warranty override: no warranty kw + product context (LLM false positive)", file=sys.stderr)
        else:
            # ไม่เรียก Pass 1 → ใช้ hardcoded detection ตามเดิม
            print(f"[INTENT] skip Pass1 (clear case)", file=sys.stderr)

        _is_followup_policy = (
            general_qtype in ("warranty_policy", "return_policy")
            and history
            and not _current_has_model  # message ปัจจุบันไม่มี model keyword
            and not _is_claim_request  # ไม่ใช่ claim request (เคลม/ซ่อม/เสีย)
            and len(req.message.split()) <= 4  # คำถามสั้นๆ
        )
        if _is_followup_policy:
            # ดึง model words จาก history — เน้น model answer ล่าสุดก่อน
            # เพราะ user อาจพิมพ์ "โทสับงบ 2000" (ไม่มี model keyword)
            # แต่ model answer มักมีชื่อสินค้าจริง เช่น "Xiaomi Redmi 8A", "Lagenio K9"
            # ใช้ model answer ล่าสุดเป็นหลัก เพื่อหลีกเลี่ยงการเลือกรุ่นเก่าจาก history
            _last_model_msgs = [h for h in history if h.get("role") == "model"][-2:]
            _last_model_text = " ".join(h.get("text", "") for h in _last_model_msgs)
            _all_history_text = " ".join(h.get("text", "") for h in history)
            # ใช้ model answer ล่าสุดเป็นหลัก ถ้าไม่มีค่อยใช้ history ทั้งหมด
            history_text = _last_model_text if _last_model_text.strip() else _all_history_text
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
                     "ศูนย์", "ไทย", "เดือน", "ปี", "วัน", "ชั่วโมง", "gb", "ram", "rom", "mb",
                     "vs", "กับ", "ต่าง", "ยัง", "ไง", "ไหน", "อะ", "ครับ", "ค่ะ", "นะ",
                     "usb", "type", "c", "a", "pd", "qc", "w", "mah", "mm", "นิ้ว", "กรัม"}
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
                # dedup models (เก็บเฉพาะรุ่นที่ไม่ซ้ำกัน)
                _seen_models = set()
                _unique_models = []
                for m in valid_models:
                    _ml = m.lower()
                    if _ml not in _seen_models:
                        _seen_models.add(_ml)
                        _unique_models.append(m)
                print(f"[FOLLOWUP] warranty follow-up detected, models={_unique_models[:3]}", file=sys.stderr)
                general_qtype = None
                # สร้าง message ใหม่: ใช้รุ่นล่าสุด + "รับประกัน"
                # (รุ่นล่าสุด = รุ่นที่ model answer พูดถึงล่าสุด)
                _original_msg = req.message
                _latest_model = _unique_models[0]
                # ถ้ามีหลายรุ่น ใช้รุ่นล่าสุดเป็นหลัก แต่ส่งทุกรุ่นใน message
                if len(_unique_models) > 1:
                    req.message = " รับประกัน ".join(_unique_models[:3]) + " รับประกัน"
                else:
                    req.message = _latest_model + " รับประกัน"
                # เก็บ original message ไว้ในตัวแปรเพื่อส่งเป็น desc_message
                req._followup_original = _original_msg
                print(f"[FOLLOWUP] new message: {req.message!r}  desc={_original_msg!r}", file=sys.stderr)

        # ===== Comparison follow-up =====
        # กรณี: ลูกค้าถาม "ต่างกันยังไง", "เปรียบเทียบ", "เทียบ" โดยไม่มี model keyword
        # แต่มี model ใน history → ดึง model จาก history มาเปรียบเทียบ
        _comparison_followup_kw = ("ต่างกัน", "ต่างยังไง", "ต่างไหม", "เปรียบเทียบ", "เทียบ", "เทียบกัน")
        _is_comparison_followup = (
            any(kw in req.message.lower() for kw in _comparison_followup_kw)
            and history
            and not _current_has_model  # message ปัจจุบันไม่มี model keyword
            and len(req.message.split()) <= 4  # คำถามสั้นๆ
        )
        if _is_comparison_followup:
            print(f"[FOLLOWUP-COMP] triggered: msg={req.message!r}  history={len(history)}  has_model={_current_has_model}", file=sys.stderr)
            # ดึง model keywords จาก history ทั้งหมด (user + model)
            _all_history_text2 = " ".join(h.get("text", "") for h in history)
            _history_models2 = knowledge_base.extract_model_keywords(_all_history_text2)
            # กรอง "vs" ออก
            _history_models2 = [m for m in _history_models2 if m.lower() != "vs"]
            if len(_history_models2) >= 2:
                # dedup
                _seen2 = set()
                _unique2 = []
                for m in _history_models2:
                    _ml2 = m.lower()
                    if _ml2 not in _seen2:
                        _seen2.add(_ml2)
                        _unique2.append(m)
                print(f"[FOLLOWUP-COMP] comparison follow-up detected, models={_unique2[:3]}", file=sys.stderr)
                _original_msg2 = req.message
                # สร้าง message: "K5 vs K9" เพื่อให้เข้า comparison path ใน KB lookup
                req.message = " vs ".join(_unique2[:3])
                req._followup_original = _original_msg2
                print(f"[FOLLOWUP-COMP] new message: {req.message!r}  desc={_original_msg2!r}", file=sys.stderr)

        # ===== warranty date follow-up =====
        # กรณี: รอบก่อนบอทถาม "วันที่ซื้อ" + รอบนี้ลูกค้าบอกวันที่
        # → ดึงสินค้าจาก history + คำนวณช่วงประกัน + ตอบตรงๆ
        # (ไม่ต้องเรียก LLM คำนวณเอง เพราะ LLM อาจคำนวณผิด)
        _warranty_date_followup = False
        _warranty_calc_note = ""

        # ===== Warranty Claim State Machine =====
        # Flow ใหม่: duration → claim_request → date → info → confirm → handoff
        # ตรวจ state จาก history เพื่อกำหนด action ในรอบปัจจุบัน
        _warranty_claim_handoff = False  # ถ้า True → ส่งต่อแอดมิน
        _warranty_claim_ctx: dict = {}
        _warranty_claim_answer: str = ""
        if history:
            from . import warranty as _warranty_mod
            _last_model_msgs = [h for h in history if h.get("role") == "model"][-1:]
            _last_model_text = " ".join(h.get("text", "") for h in _last_model_msgs).lower()
            _all_history_text = " ".join(h.get("text", "") for h in history)

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

            # ตรวจว่าลูกค้าให้วันที่จริงไหม (ใช้ในหลาย state)
            _msg_has_date = _warranty_mod.parse_purchase_date(req.message) is not None

            # ── State: awaiting_customer_info → ลูกค้าให้ข้อมูล → ทวน + ถามยืนยัน ──
            # ต้องเป็น info request จริง (ไม่ใช่วันที่) และลูกค้าให้ข้อมูลจริง
            if _bot_asked_info and not _bot_reviewed_info and not _msg_has_date:
                _info = _warranty_mod.extract_customer_info(req.message)
                # ต้องมี phone หรือ name ที่สั้นและดูเป็นชื่อจริง (ไม่ใช่ประโยคยาว)
                _has_valid_name = _info["name"] and len(_info["name"]) <= 40 and " " in _info["name"]
                _has_valid_phone = bool(_info["phone"])
                if _has_valid_name or _has_valid_phone:
                    # ทวนข้อมูล + ถามยืนยัน
                    _review_lines = []
                    if _info["name"]:
                        _review_lines.append(f"• ชื่อ-นามสกุล: {_info['name']}")
                    if _info["phone"]:
                        _review_lines.append(f"• เบอร์โทร: {_info['phone']}")
                    _review_text = "\n".join(_review_lines)
                    _warranty_claim_answer = (
                        f"รบกวนทวนข้อมูลนะคะ ข้อมูลที่ลูกค้าให้มา:\n"
                        f"{_review_text}\n\n"
                        f"ข้อมูลถูกต้องไหมคะ ถ้าถูกต้องเดี๋ยวจะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
                    )
                    _warranty_claim_ctx = {
                        "customer_name": _info["name"],
                        "customer_phone": _info["phone"],
                        "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
                    }
                    print(f"[WARRANTY-CLAIM] info collected: {_info}", file=sys.stderr)

            # ── State: awaiting_confirmation → ลูกค้ายืนยันหรือแก้ข้อมูล ──
            elif _bot_reviewed_info:
                if _warranty_mod.detect_confirmation(req.message):
                    _warranty_claim_answer = (
                        f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมินดำเนินการต่อนะคะ "
                        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                    )
                    _warranty_claim_handoff = True
                    _warranty_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty"}
                    print(f"[WARRANTY-CLAIM] confirmed → handoff", file=sys.stderr)
                else:
                    # ลูกค้าแก้ข้อมูล ไม่ยืนยัน → ดึงข้อมูลใหม่และทวนอีกครั้ง
                    _info = _warranty_mod.extract_customer_info(req.message)
                    _has_valid_name = _info["name"] and len(_info["name"]) <= 40 and " " in _info["name"]
                    _has_valid_phone = bool(_info["phone"])
                    if _has_valid_name or _has_valid_phone:
                        _review_lines = []
                        if _info["name"]:
                            _review_lines.append(f"• ชื่อ-นามสกุล: {_info['name']}")
                        if _info["phone"]:
                            _review_lines.append(f"• เบอร์โทร: {_info['phone']}")
                        _review_text = "\n".join(_review_lines)
                        _warranty_claim_answer = (
                            f"รับทราบค่ะ ขออนุญาตทวนข้อมูลใหม่นะคะ:\n"
                            f"{_review_text}\n\n"
                            f"ข้อมูลถูกต้องไหมคะ ถ้าถูกต้องเดี๋ยวจะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
                        )
                        _warranty_claim_ctx = {
                            "customer_name": _info["name"],
                            "customer_phone": _info["phone"],
                            "claim_topic": "เคลม/ซ่อม/ประกันสินค้า",
                        }
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
                if _warranty_mod.detect_consent(req.message):
                    _warranty_claim_answer = (
                        f"ได้ค่ะ เดี๋ยวจะขออนุญาตส่งต่อแชทนี้ให้แอดมินนะคะ "
                        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                    )
                    _warranty_claim_handoff = True
                    _warranty_claim_ctx = {"handoff_reason": "warranty_claim_out_of_warranty"}
                    print(f"[WARRANTY-CLAIM] out-of-warranty consent → handoff", file=sys.stderr)

            # ── State: duration_answered → ลูกค้า claim request → ถามวันที่ซื้อ ──
            # เงื่อนไข: บอทเคยตอบ duration + ลูกค้าไม่ได้ให้วันที่ + เป็น claim request
            # (ถ้าลูกค้าให้วันที่ → เข้า warranty_date_followup block ด้านล่าง)
            elif _bot_answered_duration and not _msg_has_date:
                if _warranty_mod.detect_claim_request(req.message):
                    _warranty_claim_answer = (
                        f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
                        f"• วันที่ซื้อสินค้า\n"
                        f"• เลขที่คำสั่งซื้อ\n"
                        f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
                        f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
                        f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
                        f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ abubu จะตรวจสอบและประสานงานต่อให้ค่ะ"
                    )
                    print(f"[WARRANTY-CLAIM] claim request → ask date+order+photo", file=sys.stderr)

            # ถ้ามี warranty claim answer → ส่งตอบก่อนเข้า flow อื่น
            if _warranty_claim_answer:
                _total_elapsed = _time.time() - _total_start
                model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
                print(f"[TIMING] WARRANTY-CLAIM: {_total_elapsed:.2f}s  handoff={_warranty_claim_handoff}", file=sys.stderr)

                # ถ้าต้องส่งต่อแอดมิน → เรียก handoff API (best-effort, ไม่ block คำตอบ)
                _handoff_result: dict = {}
                _assigned_admin_name: str | None = None
                _assignment_reason: str | None = None
                if _warranty_claim_handoff and req.conversation_id:
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
                            "reason": _warranty_claim_ctx.get("handoff_reason", "warranty_claim"),
                            "simulate": req.simulate_assignment,
                            "claim": {
                                k: v for k, v in _warranty_claim_ctx.items()
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
                            print(f"[HANDOFF] ส่งต่อแอดมินสำเร็จ: assigned_to={_handoff_result.get('assigned_to')} name={_assigned_admin_name} reason={_assignment_reason}", file=sys.stderr)
                        except urllib.error.HTTPError as _he:
                            print(f"[HANDOFF] HTTP error: {_he.code} {_he.reason}", file=sys.stderr)
                        except Exception as _he:
                            print(f"[HANDOFF] error: {_he}", file=sys.stderr)
                    except Exception as _e:
                        print(f"[HANDOFF] setup error: {_e}", file=sys.stderr)

                    # ── แก้คำตอบให้บอกลูกค้าว่า assign ให้ใคร เพราะอะไร ──
                    if _assigned_admin_name:
                        _reason_thai = {
                            "warranty_claim_in_warranty": "อยู่ในช่วงรับประกัน",
                            "warranty_claim_out_of_warranty": "หมดช่วงรับประกัน",
                            "warranty_claim": "เรื่องรับประกัน/เคลม",
                        }.get(_warranty_claim_ctx.get("handoff_reason", ""), "เรื่องที่ต้องดำเนินการต่อ")
                        _assign_thai = {
                            "previous_reply_admin: ส่งคืน admin เดิมที่เคยตอบ": "แอดมินที่เคยดูแลคุณ",
                            "round_robin: ไม่มี admin เดิม → จ่ายคิว": "แอดมินคนถัดไป",
                            "existing_assignment: มี admin ดูแลอยู่แล้ว": "แอดมินที่ดูแลอยู่",
                        }.get(_assignment_reason or "", "แอดมิน")
                        _warranty_claim_answer += (
                            f"\n\n📌 ขณะนี้ได้มอบหมายงานให้ {_assigned_admin_name} ({_assign_thai}) "
                            f"ดำเนินการเรื่อง{_reason_thai}ต่อนะคะ "
                            f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                        )

                return ChatResponse(
                    answer=_warranty_claim_answer,
                    answer_segments=llm.split_segments(_warranty_claim_answer),
                    products=[],
                    shop=req.shop,
                    model=model_name,
                    source="warranty_claim_flow",
                    usage={},
                    elapsed=round(_total_elapsed, 2),
                    cost=0.0,
                    handoff_to_admin=_warranty_claim_handoff,
                    handoff_reason=_warranty_claim_ctx.get("handoff_reason"),
                    handoff_claim=_warranty_claim_ctx,
                    steps=_steps,
                    routing_decision=_routing(
                        "handoff" if _warranty_claim_handoff else "bot_reply",
                        f"warranty_claim: {_warranty_claim_ctx.get('handoff_reason', 'in_progress')}",
                        handoff_reason=_warranty_claim_ctx.get("handoff_reason"),
                        assigned_admin=_handoff_result.get("assigned_to") if _warranty_claim_handoff and req.conversation_id else None,
                        assigned_admin_name=_assigned_admin_name if _warranty_claim_handoff and req.conversation_id else None,
                        shop_settings_action=None,
                        trigger_matched=None,
                    ),
                )

        if history and not _is_followup_policy:
            from . import warranty as _warranty_mod
            # ตรวจว่า message ปัจจุบันมีวันที่ไหม
            _purchase_date = _warranty_mod.parse_purchase_date(req.message)
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
                    import re as _re3
                    history_text = " ".join(h.get("text", "") for h in history)
                    _valid_models = []
                    # pattern 1: หา pattern ระหว่าง "สินค้า" และ "รับประกัน"/"ประกัน"
                    _m_name = _re3.search(
                        r"สินค้า\s+(.+?)\s+(?:รับประกัน|ประกัน|เคลม)",
                        history_text,
                    )
                    if _m_name:
                        _candidate = _m_name.group(1).strip()
                        # ตัดคำขยะท้ายชื่อ (เช่น "ค่ะ", "นะคะ")
                        _candidate = _re3.sub(r"\s*(ค่ะ|นะคะ|ครับ|จ้ะ)\s*$", "", _candidate).strip()
                        if 3 <= len(_candidate) <= 60:
                            _valid_models.append(_candidate)
                    # pattern 2: word + space + alphanumeric with digit (เดิม)
                    if not _valid_models:
                        # pattern 2a: ดึงจาก user messages ก่อน (ลูกค้าพิมพ์เอง น่าเชื่อกว่า)
                        _user_msgs_text = " ".join(
                            h.get("text", "") for h in history if h.get("role") == "user"
                        )
                        # หา alphanumeric code เช่น "652U", "AD653T", "CMC615P"
                        _user_codes = _re3.findall(
                            r"\b([A-Za-z]?\d{2,4}[A-Za-z]{1,3})\b", _user_msgs_text
                        )
                        for _code in _user_codes:
                            if len(_code) >= 3:
                                _valid_models.append(_code)
                                break
                    if not _valid_models:
                        _model_patterns = _re3.findall(
                            r"\b([A-Za-z]{2,})\s+([A-Za-z]*\d+[A-Za-z]*)\b", history_text
                        )
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
                    if _valid_models:
                        # ดึงสินค้าจาก DB ด้วย model name (ignore status — อาจเป็น SELLER_DELETE)
                        _model_query = _valid_models[0]
                        print(f"[WARRANTY-DBG] _valid_models={_valid_models}  query={_model_query!r}", file=sys.stderr)
                        try:
                            _w_docs = list(db[os.environ.get("MONGO_COLLECTION", "ShpProducts")].find(
                                {
                                    "item_name": {"$regex": _re3.escape(_model_query), "$options": "i"},
                                    **({"shopname": {"$regex": f"^{_re3.escape(req.shop)}$", "$options": "i"}} if req.shop else {}),
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
                            _calc = _warranty_mod.is_in_warranty(_purchase_date, _warranty_months)
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
                                    f"จากนั้นเดี๋ยว abubu จะส่งต่อให้แอดมินดำเนินการต่อให้นะคะ"
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
            model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
            print(f"[TIMING] WARRANTY-DATE: {_total_elapsed:.2f}s", file=sys.stderr)
            return ChatResponse(
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
                routing_decision=_routing("bot_reply", "warranty_date_followup: คำนวณวันหมดประกัน"),
            )

        # ===== Tax invoice follow-up from history =====
        # ถ้าบอทเคยตอบเรื่องใบกำกับภาษี และลูกค้าตอบต่อ (เช่น "ต้องการค่ะ", "ส่งข้อมูลแล้ว")
        # → ส่งต่อแอดมินเลย ไม่ต้องถามต่อ
        if history and not _is_tax_invoice and not _is_claim_request:
            _last_model_msgs_tax = [h for h in history if h.get("role") == "model"][-1:]
            _last_model_text_tax = " ".join(h.get("text", "") for h in _last_model_msgs_tax).lower()
            _bot_answered_tax = any(
                kw in _last_model_text_tax
                for kw in ("ใบกำกับภาษี", "ใบกำกับ", "ภาษี", "tax invoice", "invoice")
            )
            if _bot_answered_tax:
                # ถ้าลูกค้าตอบสั้นๆ (consent หรือ follow-up) → handoff เลย
                _tax_consent = _warranty_mod.detect_consent(req.message)
                _tax_followup = any(
                    kw in req.message.lower()
                    for kw in ("ใบกำกับ", "ภาษี", "invoice", "เอกสาร", "จัดส่ง", "ไปรษณีย์",
                               "เลขผู้เสียภาษี", "เลขภาษี", "หจก.", "บจก.", "สนง.")
                )
                # ⚡ ใช้แค่ consent + tax keywords — ไม่ใช้ short_followup เพราะจะจับ "สายชาร์จ" ที่เป็นคำถามใหม่
                if _tax_consent or _tax_followup:
                    _tax_answer = (
                        f"ได้ค่ะ เดี๋ยวขออนุญาตส่งต่อแชทนี้ให้แอดมิน "
                        f"เพื่อดำเนินการเรื่องใบกำกับภาษีให้นะคะ "
                        f"รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"
                    )
                    _total_elapsed = _time.time() - _total_start
                    model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
                    if req.conversation_id:
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
                                "reason": "tax_invoice_request",
                                "claim": {"topic": "ใบกำกับภาษี"},
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
                                urllib.request.urlopen(_handoff_req, timeout=3)
                                print("[TAX-HANDOFF] sent to admin (follow-up)", file=sys.stderr)
                            except Exception as _he:
                                print(f"[TAX-HANDOFF] handoff failed: {_he}", file=sys.stderr)
                        except Exception as _he:
                            print(f"[TAX-HANDOFF] error: {_he}", file=sys.stderr)
                    print(f"[TIMING] TAX-HANDOFF: {_total_elapsed:.2f}s (follow-up)", file=sys.stderr)
                    return ChatResponse(
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
                        routing_decision=_routing(
                            "handoff", "tax_invoice: follow-up จาก history → ส่งแอดมิน",
                            handoff_reason="tax_invoice_request",
                        ),
                    )

        # ===== Claim request ที่ state machine ไม่ได้จัดการ (first message, ไม่มี history) =====
        # ถ้าเป็น claim request แต่ state machine ไม่ได้ตอบ (ไม่มี history) → ตอบเลย ห้ามแนะนำสินค้า
        if _is_claim_request and not _warranty_claim_answer:
            _total_elapsed = _time.time() - _total_start
            model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
            _claim_first_answer = (
                f"รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ:\n"
                f"• วันที่ซื้อสินค้า\n"
                f"• เลขที่คำสั่งซื้อ\n"
                f"• รูปหรือวิดีโอแสดงอาการ/ความเสียหาย\n\n"
                f"เงื่อนไขการรับประกันเบื้องต้น: สินค้าต้องอยู่ในช่วงรับประกัน "
                f"และไม่ใช่ความเสียหายจากการใช้งานผิดวิธี น้ำเข้า หรือตกกระแทก "
                f"(ขึ้นกับเงื่อนไขเฉพาะรุ่น) หากข้อมูลครบ abubu จะตรวจสอบและประสานงานต่อให้ค่ะ"
            )
            print(f"[WARRANTY-CLAIM] first-message claim request → ask info (no products)", file=sys.stderr)
            return ChatResponse(
                answer=_claim_first_answer,
                answer_segments=llm.split_segments(_claim_first_answer),
                products=[],
                shop=req.shop,
                model=model_name,
                source="warranty_claim_first_message",
                usage={},
                elapsed=round(_total_elapsed, 2),
                cost=0.0,
                intent=_intent_result,
                timing=_timing_breakdown,
                steps=_steps,
                routing_decision=_routing("bot_reply", "warranty_claim: ขอข้อมูลลูกค้าก่อน (first message)"),
            )

        if general_qtype:
            # ถ้าเป็น warranty_policy/return_policy แต่ message มี model keyword (เช่น "P01 รับประกันกี่ปี")
            # ให้ skip general flow ไป product flow แทน เพราะลูกค้าถามรับประกันของสินค้าเฉพาะรุ่น
            # ต้องดึงสินค้า (รวม UNLIST/sold_out) มาให้ LLM ตอบสเปค/รับประกันเฉพาะรุ่นได้
            if general_qtype in ("warranty_policy", "return_policy") and _current_has_model:
                print(f"[INTENT] warranty_policy with model keyword → skip general, go to product flow", file=sys.stderr)
                general_qtype = None
            else:
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
                        persona_extra=_persona_extra,
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
                    answer_segments=llm.split_segments(answer),
                    products=[],
                    shop=req.shop,
                    model=model_name,
                    source=f"general:{general_qtype}",
                    usage=usage_info,
                    elapsed=round(_total_elapsed, 2),
                    cost=round(cost, 6),
                    steps=_steps,
                    routing_decision=_routing("bot_reply", f"general_qtype: {general_qtype} — ไม่โดน trigger/shop_settings → บอทตอบ"),
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
                        persona_extra=_persona_extra,
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
                    answer_segments=llm.split_segments(answer),
                    products=[],
                    shop=req.shop,
                    model=model_name,
                    source="general:brand_info",
                    usage=usage_info,
                    elapsed=round(_total_elapsed, 2),
                    cost=round(cost, 6),
                    steps=_steps,
                    routing_decision=_routing("bot_reply", f"brand_question: {brand_q} — บอทตอบจากข้อมูลแบรนด์"),
                )

        # ===== ขั้นที่ 1: เช็ค Knowledge Base ก่อน =====
        # ถ้าเป็น follow-up (เช่น "เคลมยังไง", "รับประกัน") ให้เอา model จาก history มาค้น KB ด้วย
        kb_query = req.message
        # ── Follow-up skip KB: ถ้าเป็น constraint/compatibility follow-up ──
        # ให้ข้าม KB ไป product_store ซึ่งมี REFERENCE extraction + subtype carry
        # เพราะ KB มักหาสินค้าผิดประเภท (เช่น หา powerbank แทนหัวชาร์จ) และ return ก่อนถึง REFERENCE
        _wattage_followup_skip_kb = False
        _compat_followup_skip_kb = False
        if req.history:
            try:
                _hist_user_texts = [
                    (m.text if hasattr(m, 'text') else m.get('text', ''))
                    for m in req.history
                    if (m.role if hasattr(m, 'role') else m.get('role', '')) == "user"
                ]
            except Exception:
                _hist_user_texts = []
            # wattage follow-up: "100 w ละ" หลังคุยเรื่องหัวชาร์จ
            if len(req.message.split()) <= 6 and re.search(r"\d+\s*w\b", req.message, re.IGNORECASE):
                for hmsg in reversed(_hist_user_texts):
                    _htypes = product_store._detect_product_types(hmsg)
                    if _htypes and "charger" in _htypes:
                        _wattage_followup_skip_kb = True
                        print(f"[WATTAGE-FOLLOWUP] skip KB — charger in history, msg has wattage", file=sys.stderr)
                        break
            # compatibility/constraint follow-up: "ขึ้นเครื่องไปจีน", "ใช้สาย c to c"
            # ถ้า message สั้น + มี compat keyword + history มี charger type → skip KB
            _compat_followup_kws = ("ขึ้นเครื่อง", "เครื่องบิน", "นำขึ้น", "ติดตัวขึ้น",
                                    "ไปจีน", "ต่างประเทศ",
                                    "ใช้สาย", "ใช้กับสาย", "c to c", "type c",
                                    "usb-c", "usb c")
            if (not _wattage_followup_skip_kb
                and len(req.message.split()) <= 8
                and any(kw in req.message.lower() for kw in _compat_followup_kws)):
                for hmsg in reversed(_hist_user_texts):
                    _htypes = product_store._detect_product_types(hmsg)
                    if _htypes and "charger" in _htypes:
                        _compat_followup_skip_kb = True
                        print(f"[COMPAT-FOLLOWUP] skip KB — charger in history, msg has compat keyword", file=sys.stderr)
                        break
        if req.history and not _wattage_followup_skip_kb and not _compat_followup_skip_kb:
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
        # superlative keywords (define ก่อนใช้ใน follow-up skip logic และ fetch_limit logic)
        _msg_lower_super = (req.message or "").lower()
        _superlative_kw = ("สุด", "ที่สุด", "แรงสุด", "ไวสุด", "เร็วสุด", "มากสุด", "น้อยสุด",
                           "แรงที่สุด", "ไวที่สุด", "เร็วที่สุด", "มากที่สุด", "น้อยที่สุด",
                           "เบาสุด", "จุมากสุด", "คุ้มสุด", "คุ้มที่สุด",
                           "กว่านี้", "เร็วกว่า", "แรงกว่า", "ไวกว่า", "ดีกว่า", "มากกว่า",
                           "ไวๆ", "เร็วๆ", "แรงๆ", "ชาร์จไว", "ชาร์จเร็ว")
        _is_superlative_q = any(kw in _msg_lower_super for kw in _superlative_kw)
        if _wattage_followup_skip_kb or _compat_followup_skip_kb:
            kb_result = None
            _skip_reason = "wattage" if _wattage_followup_skip_kb else "compat"
            print(f"[TIMING] KB lookup SKIPPED ({_skip_reason} follow-up)", file=sys.stderr)
        else:
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
                        "charger": "หัวชาร์จ สายชาร์จ charger",
                        "case": "เคส case ซอง",
                        "speaker": "ลำโพง speaker",
                    }
                    # ถ้าเป็น charger ให้ใช้ subtype keyword ที่ตรงกับคำถามจริง
                    if "charger" in req_types:
                        _req_sub = product_store._detect_charger_subtype(req.message)
                        if _req_sub == "adapter":
                            type_keywords_map["charger"] = "หัวชาร์จ adapter charger"
                        elif _req_sub == "cable":
                            type_keywords_map["charger"] = "สายชาร์จ cable charger"
                        elif _req_sub == "set":
                            type_keywords_map["charger"] = "ชุดชาร์จ set charger"
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

                # ⚡ MODEL-REGEX in KB path — ถ้า message มี model keyword ชัดเจน
                # ให้ดึงด้วย Mongo regex ก่อน vector search (แม่นยำกว่าสำหรับชื่อสินค้าเฉพาะ)
                _kb_regex_products: list[dict] = []
                _kb_model_kws = re.findall(r"[A-Za-z]+\d+[A-Za-z]*", req.message)
                _kb_model_kws = [w for w in _kb_model_kws if len(w) >= 4]
                if not _kb_model_kws:
                    _kb_alpha_kws = re.findall(r"[A-Za-z]{5,}", req.message)
                    _kb_common = {"watch", "smart", "phone", "cable", "charger", "adapter",
                                  "power", "bank", "band", "type", "usb", "wireless",
                                  "what", "how", "please", "thank", "hello", "hi"}
                    _kb_alpha_kws = [w for w in _kb_alpha_kws if w.lower() not in _kb_common]
                    _kb_model_kws = _kb_alpha_kws[:1]
                if _kb_model_kws:
                    _kb_kw = _kb_model_kws[0]
                    _kb_kw_clean = re.sub(r"(.)\1{2,}$", r"\1", _kb_kw.lower())
                    if _kb_kw_clean != _kb_kw.lower():
                        _kb_kw = _kb_kw_clean
                    _kb_alpha = re.match(r"[A-Za-z]+", _kb_kw).group(0)
                    _kb_rest = _kb_kw[len(_kb_alpha):]
                    if _kb_rest:
                        _kb_pattern = re.escape(_kb_alpha) + r".?" + re.escape(_kb_rest)
                    else:
                        _kb_prefix = _kb_kw[:6] if len(_kb_kw) >= 6 else _kb_kw
                        _kb_pattern = re.escape(_kb_prefix)
                    try:
                        _kb_coll = db[os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"]
                        _kb_filter = {
                            "item_status": "NORMAL",
                            "item_name": {"$regex": _kb_pattern, "$options": "i"},
                        }
                        if req.shop:
                            _kb_filter["shopname"] = {"$regex": f"^{re.escape(req.shop)}$", "$options": "i"}
                        _kb_docs = list(_kb_coll.find(_kb_filter, product_store.PRODUCT_PROJECTION).limit(5))
                        if _kb_docs:
                            _kb_regex_products = [product_store.to_product_card(d, req.message) for d in _kb_docs]
                            print(f"[KB-MODEL-REGEX] ดึงสินค้าตรง model keyword '{_kb_kw}' (pattern={_kb_pattern!r}): {len(_kb_regex_products)} ตัว", file=sys.stderr)
                    except Exception as _e:
                        print(f"[KB-MODEL-REGEX] error: {_e}", file=sys.stderr)

                if _kb_regex_products:
                    mongo_products = _kb_regex_products
                else:
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

                # ── กรอง charger subtype สำหรับ KB merge path ด้วย ──
                # (Direct regex search บายพาส fetch_products จึงต้องกรองที่นี่)
                if "charger" in req_types:
                    _req_sub = product_store._detect_charger_subtype(req.message)
                    if _req_sub:
                        # กรอง mongo_products (เป็น product cards แล้ว ใช้ "name" field)
                        _filtered_mp = []
                        for p in mongo_products:
                            pname = (p.get("name") or "").lower()
                            _desktop_kw = ("แท่นชาร์จ", "desktop charger", "desktop charge")
                            _is_desktop = any(kw in pname for kw in _desktop_kw)
                            _set_kw = ("ชุดชาร์จ", "ชุดชาร์ต", "ชุดหัวชาร์จ", "ชุดสายชาร์จ",
                                       "set ชาร์จ", "charging combo", "ready to go", "ชุดอุปกรณ์ชาร์จ",
                                       "ชุด ready", "set samsung", "set iphone", "combo",
                                       "premium charging set", "charge anywhere")
                            _adapter_kw = ("หัวชาร์จ", "หัวชาร์ต", "adapter", "แอ็ดอปเตอร์", "gan",
                                            "pd3", "qc3", "super fast", "sfc", "pps",
                                            "car charger", "หัวชาร์จในรถ")
                            _cable_kw = ("สายชาร์จ", "สายชาร์ต", "สาย usb", "สาย type", "สาย c to",
                                         "สาย micro", "สาย lightning", "cable", "คาเบิล",
                                         "usb-c to", "usb a to", "type-c to")
                            _is_set = (any(kw in pname for kw in _set_kw)
                                       or ("ชุด" in pname and ("ชาร์จ" in pname or "charger" in pname))
                                       or ("set" in pname and ("ชาร์จ" in pname or "charger" in pname)))
                            _is_adapter = any(kw in pname for kw in _adapter_kw) and not _is_desktop
                            _is_cable = any(kw in pname for kw in _cable_kw) or ("สาย" in pname and not _is_adapter)
                            if _req_sub == "adapter" and (_is_adapter or _is_set):
                                _filtered_mp.append(p)
                            elif _req_sub == "cable" and (_is_cable or _is_set):
                                _filtered_mp.append(p)
                            elif _req_sub == "set" and _is_set:
                                _filtered_mp.append(p)
                        if _filtered_mp:
                            mongo_products = _filtered_mp
                            print(f"[CHARGER-SUBTYPE] KB merge filtered to {len(mongo_products)} ({_req_sub})", file=sys.stderr)

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
                            persona_extra=_persona_extra,
                            intent_result=_intent_result,
                        )
                    except RuntimeError as exc:
                        raise HTTPException(status_code=500, detail=str(exc))
                    _total_elapsed = _time.time() - _total_start
                    model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
                    prompt_t = usage_info.get("prompt", 0)
                    output_t = usage_info.get("output", 0)
                    cost = (prompt_t * 0.30 + output_t * 2.50) / 1_000_000
                    # record RAG step for KB path
                    _steps.append({
                        "name": "RAG",
                        "model": "mongodb+kb",
                        "tokens_in": 0,
                        "tokens_out": 0,
                        "time_s": _timing_breakdown.get("retrieval", 0),
                        "cost_usd": 0,
                        "cost_thb": 0,
                        "input": {
                            "query": req.message,
                            "shop": req.shop,
                            "limit": req.limit,
                            "intent": _intent_result.get("intent"),
                        },
                        "output": {
                            "product_count": len(merged_products),
                            "products": [p.get("name", "")[:60] for p in merged_products[:10]],
                        },
                    })
                    # record LLM2 step for KB path
                    _steps.append({
                        "name": "LLM2",
                        "model": model_name,
                        "tokens_in": prompt_t,
                        "tokens_out": output_t,
                        "time_s": _timing_breakdown.get("llm", 0),
                        "cost_usd": cost,
                        "cost_thb": cost * 36,
                        "input": {
                            "message": (getattr(req, "_followup_original", None) or req.message)[:200],
                            "product_count": len(merged_products),
                            "intent": _intent_result.get("intent"),
                        },
                        "output": {
                            "answer": answer[:500],
                            "answer_full_length": len(answer),
                        },
                    })
                    # ส่ง merged_products เป็น products (เพื่อให้ frontend แสดงได้)
                    products = [_kb_doc_to_card(d) if "_kb_only" in d else d for d in merged_products]
                    # dedup สินค้าที่ชื่อใกล้เคียงกัน (เช่น P01 ซ้ำหลาย listing ต่าง prefix โปร)
                    import re as _re_kb_dedup
                    def _kb_base_name(name):
                        n = (name or "").strip().lower()
                        n = _re_kb_dedup.sub(r"^\[.*?\]\s*", "", n)
                        n = _re_kb_dedup.sub(r"\s*-\d+[my]\s*$", "", n)
                        # ตัด "พอร์ตเดียวแรงสุด XXXw" และ "จ่ายไฟพอร์ตเดียว XXXw"
                        n = _re_kb_dedup.sub(r"(จ่ายไฟ)?พอร์ตเดียวแรงสุด\s*\d+w\s*", "", n)
                        # ตัด "พอร์ตเดียว XXXw" (ไม่มี "แรงสุด")
                        n = _re_kb_dedup.sub(r"(จ่ายไฟ)?พอร์ตเดียว\s*\d+w\s*", "", n)
                        for s in ("ccc / ce", "ce / ccc", "usb-c / usb-a", "usb a / usb c"):
                            n = n.replace(s, " ")
                        n = _re_kb_dedup.sub(r"\s{2,}", " ", n).strip()
                        return n
                    def _kb_sell_score(p):
                        return (
                            p.get("status") == "NORMAL",
                            not p.get("sold_out", False),
                            p.get("total_stock") or 0,
                            bool(p.get("price", {}).get("min") and p.get("price", {}).get("max")
                                 and p.get("price", {}).get("min") != p.get("price", {}).get("max")),
                            -(p.get("price", {}).get("min") or 0),
                        )
                    _kb_seen = {}
                    _kb_deduped = []
                    for p in products:
                        bn = _kb_base_name(p.get("name") or "")
                        if not bn:
                            _kb_deduped.append(p)
                            continue
                        if bn not in _kb_seen:
                            _kb_seen[bn] = len(_kb_deduped)
                            _kb_deduped.append(p)
                        else:
                            _idx = _kb_seen[bn]
                            if _kb_sell_score(p) > _kb_sell_score(_kb_deduped[_idx]):
                                _kb_deduped[_idx] = p
                    if len(_kb_deduped) < len(products):
                        print(f"[DEDUP-KB] products: {len(products)} → {len(_kb_deduped)} (removed {len(products) - len(_kb_deduped)} duplicates)", file=sys.stderr)
                    products = _kb_deduped
                    # จำกัด product cards ที่ส่งให้ frontend แค่ 10 ชิ้น
                    products = products[:10] if len(products) > 10 else products
                    # ใส่ context note สำหรับสินค้า UNLIST/sold_out (เหมือน fetch_products path)
                    _kb_has_unlist = any(p.get("status") != "NORMAL" for p in products)
                    if _kb_has_unlist and products:
                        _kb_unlist_note = (
                            "สินค้าที่ status != NORMAL (UNLIST/SELLER_DELETE) เลิกขายแล้ว — "
                            "ห้ามเสนอขาย/แสดงราคา/แสดงลิงก์สั่งซื้อ "
                            "ถ้าลูกค้าถามเรื่องสเปค/รับประกัน/เคลม: ให้ตอบข้อมูลสเปค/เงื่อนไขรับประกันของสินค้านั้น "
                            "(ห้ามเสนอสินค้าอื่นแทน เพราะลูกค้าไม่ได้ถามเรื่องซื้อ) "
                            "ถ้าลูกค้าอยากซื้อ/ถามว่ามีขายไหม: ให้บอกว่ารุ่นนี้เลิกขายแล้ว "
                            "แล้วแนะนำเฉพาะสินค้า status=NORMAL เท่านั้น"
                        )
                        if "_context_note" not in products[0]:
                            products[0]["_context_note"] = _kb_unlist_note
                        else:
                            products[0]["_context_note"] = products[0]["_context_note"] + " " + _kb_unlist_note
                    answer = _append_base_warranty(answer, getattr(req, "_followup_original", None) or req.message)
                    _timing_breakdown["total"] = round(_time.time() - _total_start, 3)

                    # ── Web search fallback (ด่านสุดท้าย) ──
                    from . import web_search as _ws
                    if _ws.is_configured():
                        _should_search, _search_reason = _ws.should_use_web_search(
                            answer=answer,
                            intent_result=_intent_result,
                            products=products,
                            message=req.message,
                        )
                        if _should_search:
                            print(f"[WEB-SEARCH] triggered (kb+mongo): {_search_reason}", file=sys.stderr)
                            _ws_result = _ws.search_and_answer(
                                message=req.message,
                                shop=req.shop,
                                platform=req.platform,
                                history=history,
                                products=products,
                                persona_extra=_persona_extra,
                                reason=_search_reason,
                            )
                            if _ws_result.get("answer") and not _ws_result.get("error"):
                                _ws_answer = _ws_result["answer"]
                                _ws_answer = _append_base_warranty(_ws_answer, getattr(req, "_followup_original", None) or req.message)
                                _ws_usage = _ws_result.get("usage", {})
                                _ws_cost = _ws_result.get("cost_usd", 0.0)
                                _ws_elapsed = _ws_result.get("elapsed", 0.0)
                                _total_ws = round(_time.time() - _total_start, 2)
                                _timing_breakdown["web_search"] = _ws_elapsed
                                _timing_breakdown["total"] = _total_ws
                                return ChatResponse(
                                    answer=_ws_answer,
                                    answer_segments=llm.split_segments(_ws_answer),
                                    products=products[:req.limit],
                                    shop=req.shop,
                                    model=_ws_result.get("model", "openrouter"),
                                    source="knowledge_base+mongo+web_search",
                                    usage=_ws_usage,
                                    elapsed=_total_ws,
                                    cost=round(cost + _ws_cost, 6),
                                    intent=_intent_result,
                                    timing=_timing_breakdown,
                                    web_search_used=True,
                                    web_search_reason=_search_reason,
                                    web_search_model=_ws_result.get("model"),
                                    steps=_steps,
                                    routing_decision=_routing("bot_reply", f"web_search: {_search_reason} → ค้นเพิ่มแล้วตอบ"),
                                )

                    return ChatResponse(
                        answer=answer,
                        answer_segments=llm.split_segments(answer),
                        products=products[:req.limit],
                        shop=req.shop,
                        model=model_name,
                        source="knowledge_base+mongo",
                        usage=usage_info,
                        elapsed=round(_total_elapsed, 2),
                        cost=round(cost, 6),
                        intent=_intent_result,
                        timing=_timing_breakdown,
                        steps=_steps,
                        routing_decision=_routing("bot_reply", "kb+mongo: พบใน knowledge base + product store → บอทตอบ"),
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
        _ref_handled = False  # default — จะถูก set ใน block if req.history
        is_other_model_question = False  # default — จะถูก set ใน block if req.history

        # ⚡ App question: "ใช้แอพอะไรต่อมือถือ" → ดึงสมาร์ทวอชจากร้านมาโชว์
        # ถ้าลูกค้าถามเรื่องแอพแต่ไม่ระบุรุ่น → ให้ค้นสมาร์ทวอชของร้าน (RAG ดึง 10 ชิ้น, LLM เลือกตอบ 2-3 ชิ้น)
        _app_kws = ("แอพอะไรต่อมือถือ", "แอปอะไรต่อมือถือ", "แอพอะไรต่อ", "แอปอะไรต่อ",
                    "ใช้แอพอะไร", "ใช้แอปอะไร", "แอพอะไรบ้าง", "แอปอะไรบ้าง",
                    "app อะไร", "appอะไร", "ต่อมือถือยังไง", "เชื่อมต่อมือถือ",
                    "แอพอะไรใช้ต่อ", "แอปอะไรใช้ต่อ", "ใช้แอพอะไรต่อกับมือถือ",
                    "ใช้แอปอะไรต่อกับมือถือ", "แอพอะไรใช้ต่อกับมือถือ",
                    "แอปอะไรใช้ต่อกับมือถือ", "แอพอะไรใช้กับ", "แอปอะไรใช้กับ")
        _is_app_question = any(kw in req.message.lower() for kw in _app_kws)
        _has_model_kw = bool(knowledge_base.extract_model_keywords(req.message))
        if _is_app_question and not _has_model_kw:
            # ไม่ระบุรุ่น → ดึงสมาร์ทวอชของร้าน (RAG ดึง 10 ชิ้นเข้า LLM, LLM เลือกตอบ 2-3 ชิ้น)
            retrieval_message = "สมาร์ทวอช smartwatch นาฬิกา"
            print(f"[APP-Q] app question without model → retrieval={retrieval_message!r}", file=sys.stderr)

        # ⚡ Compatibility check: ถ้าลูกค้าถาม "พาวเวอร์แบงค์ไหนรองรับ mi 17 ultra"
        # ให้ใช้เฉพาะ product type keyword ใน retrieval (ไม่ใช่ query เต็ม)
        # เพราะ vector search ใช้ query เต็ม จะทำให้สินค้าที่ไม่มี "mi 17" ในชื่อตกไป
        # แต่จริงๆ สินค้าทุกรุ่นในหมวด powerbank อาจรองรับ mi 17 ultra ได้
        # LLM จะเป็นคนตัดสินใจว่ารุ่นไหนรองรับจริง จาก description ใน context
        # ⚡ ข้อยกเว้น: ถ้าเป็น charging spec question (เช่น "biokoop ใช้สายชาร์จอะไรได้บ้าง")
        # ต้องไม่ override retrieval เป็น charger type เพราะลูกค้าถามเรื่องสเปกชาร์จของสินค้า X
        # ไม่ใช่ถามหาสินค้า charger
        _charging_spec_kws_pre = (
            "ใช้สายชาร์จอะไร", "ใช้สายอะไรชาร์จ", "ใช้สายอะไร",
            "ชาร์จยังไง", "ชาร์จอะไร", "ชาร์จ type c", "ชาร์จ type-c",
            "ชาร์จได้ไหม", "ชาร์จกี่วัต", "ชาร์จกี่แอม", "ชาร์จกี่w",
            "พอร์ตอะไร", "พอร์ตชาร์จ", "พอร์ตไหน",
            "wireless ได้ไหม", "ชาร์จไร้สาย", "ชาร์จไม่ต้องเสียบ",
            "ใช้สาย c to c", "ใช้สาย c to a", "ใช้สาย usb",
            "ชาร์จเร็วไหม", "ชาร์จเร็วกี่", "แทนอันเดิม", "แทนของเดิม",
            "สายชาร์จเดิม", "สายเดิมเสีย", "สายชาร์จใหม่",
        )
        _is_charging_spec_pre = any(kw in req.message.lower() for kw in _charging_spec_kws_pre)
        if _intent_result.get("intent") == "compatibility_check" and _intent_result.get("product_type") and not _is_charging_spec_pre:
            _compat_type = _intent_result.get("product_type")
            _compat_device = _intent_result.get("target_device", "")
            _compat_sub = _intent_result.get("charger_subtype", "")
            _compat_sub_kw_map = {"adapter": "หัวชาร์จ", "cable": "สายชาร์จ",
                                   "set": "ชุดชาร์จ", "car_charger": "หัวชาร์จในรถ",
                                   "wireless": "แท่นชาร์จไร้สาย", "desktop": "แท่นชาร์จตั้งโต๊ะ"}
            # ใช้เฉพาะ product type keyword ไม่ใช่ device name หรือ brand ของ device
            # เพราะ vector search ใช้ query เต็ม จะทำให้สินค้าที่ไม่มี "mi 17" ในชื่อตกไป
            # แต่จริงๆ สินค้าทุกรุ่นในหมวด powerbank อาจรองรับ mi 17 ultra ได้
            # LLM จะเป็นคนตัดสินใจว่ารุ่นไหนรองรับจริง จาก description ใน context
            _compat_retrieval = _compat_type
            # ถ้ามี charger subtype ให้เพิ่ม keyword เพื่อให้ subtype detection ทำงาน
            # เช่น sub=adapter → "หัวชาร์จ charger", sub=cable → "สายชาร์จ charger"
            if _compat_sub == "adapter":
                _compat_retrieval = f"หัวชาร์จ {_compat_type}"
            elif _compat_sub == "cable":
                _compat_retrieval = f"สายชาร์จ {_compat_type}"
            elif _compat_sub == "set":
                _compat_retrieval = f"ชุดชาร์จ {_compat_type}"
            if _compat_retrieval != retrieval_message:
                print(f"[COMPAT-RETRIEVAL] type={_compat_type} sub={_compat_sub} device={_compat_device} → retrieval={_compat_retrieval!r}", file=sys.stderr)
                # ไม่ replace retrieval_message ทั้งหมด แต่เพิ่ม subtype keyword นำหน้า
                # เพื่อไม่ให้ทับซ้อน constraint carry ที่เพิ่มมาก่อน
                # เช็คว่า retrieval_message มี subtype keyword อยู่แล้วไหม
                _has_sub_kw = any(kw in retrieval_message.lower() for kw in ("หัวชาร์จ", "สายชาร์จ", "ชุดชาร์จ"))
                if not _has_sub_kw:
                    retrieval_message = f"{_compat_sub_kw_map.get(_compat_sub, '')} {retrieval_message}".strip()
                else:
                    retrieval_message = _compat_retrieval

        # ── Charger constraint extraction & carry-forward ──
        # สกัดสเปคจาก message ปัจจุบัน แล้ว carry-forward จาก history
        # เพื่อไม่ให้ลืม constraint เช่น 6A, 240W, PD 3.1, ไนลอน, Mi 17 Ultra
        def _extract_charger_constraints(text: str) -> dict:
            """สกัด charger constraints จากข้อความ.
            คืน dict ที่มี keys: amperage, wattage, protocol, material, device
            แต่ละ key เป็น string หรือ None
            """
            low = (text or "").lower()
            constraints = {}
            # amperage: 6a, 5a, 3a, 6 a, 5 a, 3 a
            _amp_match = re.search(r'\b([356])\s*a\b', low)
            if _amp_match:
                constraints["amperage"] = f"{_amp_match.group(1)}a"
            # wattage: 240w, 100w, 60w, 30w, 65w, 120w, 140w, 300w
            _watt_match = re.search(r'(\d+)\s*w\b', low)
            if _watt_match:
                constraints["wattage"] = f"{_watt_match.group(1)}w"
            # protocol: pd 3.1, pd 3.0, pd3.1
            _pd_match = re.search(r'pd\s*3\.([01])', low)
            if _pd_match:
                constraints["protocol"] = f"pd 3.{_pd_match.group(1)}"
            # material: ไนลอน, ถัก, ซิลิโคน
            for mat in ("ไนลอน", "ถัก", "ซิลิโคน", "nylon", "braided"):
                if mat in low:
                    constraints["material"] = mat
                    break
            # device: mi 17 ultra, xiaomi 17 ultra, mi17 ultra, mi 17, iphone 17, s25 ultra
            _device_patterns = [
                (r'(mi\s*17\s*ultra|xiaomi\s*17\s*ultra)', "mi 17 ultra"),
                (r'(mi\s*17\b)', "mi 17"),
                (r'(iphone\s*17)', "iphone 17"),
                (r'(s25\s*ultra|samsung\s*25\s*ultra)', "s25 ultra"),
                (r'(s24\s*ultra|samsung\s*24\s*ultra)', "s24 ultra"),
                (r'(iphone\s*16)', "iphone 16"),
                (r'(iphone\s*15)', "iphone 15"),
            ]
            for pat, label in _device_patterns:
                if re.search(pat, low):
                    constraints["device"] = label
                    break
            return constraints

        if req.history:
            # สกัด constraints จาก message ปัจจุบัน
            _cur_constraints = _extract_charger_constraints(req.message)
            # ถ้า message ปัจจุบันไม่มี constraint บางตัว → ดึงจาก history ล่าสุด
            try:
                _all_prev_user_msgs_c = [
                    (m.text if hasattr(m, 'text') else m.get('text', ''))
                    for m in req.history
                    if (m.role if hasattr(m, 'role') else m.get('role', '')) == "user"
                    and ((m.text if hasattr(m, 'text') else m.get('text', '')) or '').strip()
                ]
            except Exception:
                _all_prev_user_msgs_c = []
            _carried_constraints = {}
            for hmsg in reversed(_all_prev_user_msgs_c):
                _hcon = _extract_charger_constraints(hmsg)
                for k, v in _hcon.items():
                    if k not in _carried_constraints and k not in _cur_constraints:
                        _carried_constraints[k] = v
            # รวม constraints (current มี priority)
            _merged_constraints = {**_carried_constraints, **_cur_constraints}
            if _carried_constraints:
                print(f"[CONSTRAINT-CARRY] carried={_carried_constraints}  current={_cur_constraints}  merged={_merged_constraints}", file=sys.stderr)
                # เพิ่มเฉพาะ constraint ที่จำเป็นและไม่ซ้อนกับ message
                # เพิ่มแค่ 2 ตัวแรกที่ไม่มีใน message เพื่อไม่ให้ keyword ยากเกินไป
                _constraint_kws = []
                for k in ("amperage", "wattage", "protocol", "material", "device"):
                    if k in _cur_constraints:
                        continue  # มีใน message แล้ว
                    if k in _carried_constraints:
                        _constraint_kws.append(_carried_constraints[k])
                # จำกัดแค่ 2 constraints นำหน้า เพื่อไม่ให้ vector search ยากเกินไป
                _constraint_kws = _constraint_kws[:2]
                if _constraint_kws:
                    retrieval_message = f"{' '.join(_constraint_kws)} {retrieval_message}"
                    print(f"[CONSTRAINT-CARRY] retrieval_message={retrieval_message!r}", file=sys.stderr)

        if req.history:
            # เช็คว่าข้อความปัจจุบันมี product type ชัดเจนไหม (exact match เท่านั้น)
            current_types = product_store._detect_product_types(req.message)
            # ถ้าไม่มี exact type → เช็ค fuzzy
            # แต่ถ้า message สั้น (1-5 คำ) และมี follow-up indicator → ไม่เช็ค fuzzy
            # เพราะ "แบตอึด" อาจ match fuzzy เป็น "แบตสำรอง" ทั้งที่เป็นคำถามต่อเรื่องแบตของสินค้าเดิม
            # หรือ "เหมาะสำหรับการเดินป่า" อาจ match fuzzy เป็น "memory_card" ทั้งที่เป็น follow-up
            _msg_words = req.message.split()
            # wattage followup: "100 w ละ", "65w ไหม", "120w บ้าง" — สั้น + มี wattage pattern
            _is_wattage_followup = (
                len(_msg_words) <= 6
                and bool(re.search(r"\d+\s*w\b", req.message, re.IGNORECASE))
            )
            _is_short_followup = (len(_msg_words) <= 5 and any(
                ind in req.message for ind in [
                    "อึด", "แบต", "ดี", "ดีกว่า", "ถูก", "แพง", "เท่าไหร่",
                    "ราคา", "สี", "ขนาด", "น้ำหนัก",
                    "เหมาะ", "เลือก", "แนะนำ", "รายละเอียด", "สเปก", "สเปค",
                    "รับประกัน", "ประกัน", "เคลม", "จัดส่ง", "เปรียบเทียบ",
                    "1080p", "4k", "2k", "3k", "1080", "720",
                    "amoled", "oled", "lcd", "ips",
                    "mah", "watt", "gan", "pd",
                    "bluetooth", "wifi", "gps",
                    "กันน้ำ", "กันฝุ่น", "ip68", "ip69",
                    "กี่โมง", "กี่วัน", "นานไหม", "ชาร์จ", "โทรได้ไหม",
                    "โทรได้", "ใช้งานได้", "รองรับไหม",
                    "ละ", "ละคะ", "ละครับ", "บ้าง",
                    # constraint/compatibility follow-up
                    "ขึ้นเครื่อง", "เครื่องบิน", "นำขึ้น", "ติดตัวขึ้น",
                    "ไปจีน", "ต่างประเทศ", "เครื่อง",
                    "ใช้สาย", "ใช้กับสาย", "c to c", "type c",
                    "usb-c", "usb c",
                ]
            )) or _is_wattage_followup
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
                "ตัวอื่น", "อีกบ้าง", "แนะนำไหม", "แนะนำอีก",
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
            # superlative question ไม่ใช่ new topic แม้จะมีคำที่ match false positive (เช่น "ยา" ใน "อยากรู้")
            if is_new_topic and _is_superlative_q:
                is_new_topic = False

            # ── Phone model name ลอยๆ → เป็น follow-up ระบุรุ่นโทรศัพท์ใหม่ ──
            # เช่น "S25ultar", "iphone 17", "mi 17 ultra" หลังจากถามเรื่องหัวชาร์จ/สายชาร์จ/พาวเวอร์แบงค์
            # ลูกค้าไม่ได้เปลี่ยนหัวข้อไปเป็นโทรศัพท์ แต่บอกรุ่นโทรศัพท์ที่จะใช้กับสินค้าเดิม
            _phone_model_followup = False
            _types_from_history = False  # flag: current_types มาจาก history carry (ไม่ใช่จาก message ปัจจุบัน)
            # superlative question สามารถยาวได้ ไม่จำกัด 5 คำ
            # และ fuzzy มักจับ "ชาร์จ" เป็น charger ผิด → กรอง current_types ก่อน
            if _is_superlative_q and current_types and "charger" in current_types:
                current_types = set()
            _superlative_followup = _is_superlative_q and not current_types and not is_new_topic
            # ⚡ ถ้า message สั้นมาก (1-2 คำ) และไม่มี digit และไม่มี known phone brand
            # → น่าจะเป็นชื่อสินค้า/แบรนด์ที่ลูกค้าพิมพ์ตรงๆ (เช่น "biokoop", "elite2")
            # ไม่ใช่ phone model followup (ที่มักมี digit เช่น "iphone 17", "redmi 8a")
            _msg_has_digit = any(c.isdigit() for c in req.message)
            _msg_has_phone_brand = any(b in req.message.lower() for b in (
                "iphone", "ipad", "galaxy", "samsung", "xiaomi", "redmi",
                "huawei", "honor", "oppo", "vivo", "realme", "poco",
                "oneplus", "pixel", "mi ", "note ", "pro ", "ultra",
            ))
            _is_short_name_query = (
                len(_msg_words) <= 2 and not _msg_has_digit and not _msg_has_phone_brand
                and not any(kw in req.message.lower() for kw in (
                    "ไหม", "มั้ย", "บ้าง", "เท่าไหร่", "ราคา", "สเปค",
                    "รับประกัน", "เคลม", "ยังไง", "ไง",
                ))
            )
            if not current_types and not is_new_topic and (len(_msg_words) <= 5 or _superlative_followup) and not _is_short_name_query:
                all_user_msgs_prev = [
                    m.text for m in req.history
                    if m.role == "user" and m.text.strip()
                ]
                prev_non_phone_type = None
                # types ที่มักเป็น false positive จาก fuzzy detect → ข้าม
                _fuzzy_false_positive_types = {"case", "inverter", "massager", "shaver",
                    "blackhead_cleaner", "vacuum", "camera", "dashcam",
                    "walking_pad", "exercise_bike", "skateboard", "stroller",
                    "air_pump", "alcohol_tester", "car_seat", "keyboard", "mouse",
                    "ram", "ssd", "ems_massager", "makeup_mirror", "mini_razor"}
                for hmsg in reversed(all_user_msgs_prev):
                    pt = product_store._detect_product_types(hmsg)
                    if not pt:
                        pt = product_store._detect_product_types_fuzzy(hmsg)
                    if pt and "phone" not in pt:
                        # ข้าม type ที่เป็น false positive บ่อย (fuzzy detect ผิด)
                        if pt & _fuzzy_false_positive_types and not (pt - _fuzzy_false_positive_types):
                            continue
                        # สำหรับ superlative: ข้าม fuzzy charger เพราะมักจับ "ชาร์จ" ผิด
                        # ให้หา type ที่ชัดเจนกว่า (เช่น powerbank) จาก history ก่อนหน้า
                        if _is_superlative_q and pt == {"charger"}:
                            continue
                        prev_non_phone_type = pt
                        break
                if prev_non_phone_type:
                    current_types = prev_non_phone_type
                    _phone_model_followup = True
                    _types_from_history = True
                    print(f"[PHONE-MODEL-FOLLOWUP] ลูกค้าระบุรุ่นโทรศัพท์ → ใช้ type จาก history: {prev_non_phone_type}", file=sys.stderr)

            # ── Charger subtype carry-forward from history ──
            # ถ้า message ปัจจุบันเป็น charger type แต่ไม่มี subtype ชัด (ไม่มี "หัวชาร์จ"/"สายชาร์จ"/"ชุดชาร์จ")
            # และไม่ใช่ new topic → ดึง subtype จาก history ล่าสุดที่มี charger subtype
            # เช่น คุยเรื่องหัวชาร์จ 3 คำถาม แล้วถาม "มีชาร์จไว กว่านี้ไหม" → ใช้ adapter subtype
            if ("charger" in (current_types or set())) and not is_new_topic and not product_store._detect_charger_subtype(req.message):
                try:
                    _all_prev_user_msgs = [
                        (m.text if hasattr(m, 'text') else m.get('text', ''))
                        for m in req.history
                        if (m.role if hasattr(m, 'role') else m.get('role', '')) == "user"
                        and ((m.text if hasattr(m, 'text') else m.get('text', '')) or '').strip()
                    ]
                except Exception:
                    _all_prev_user_msgs = []
                _history_subtype = None
                for hmsg in reversed(_all_prev_user_msgs):
                    hsub = product_store._detect_charger_subtype(hmsg)
                    if hsub:
                        _history_subtype = hsub
                        break
                if _history_subtype:
                    # เพิ่ม subtype keyword ใน retrieval message เพื่อให้ subtype detection ทำงาน
                    _sub_kw_map = {"adapter": "หัวชาร์จ", "cable": "สายชาร์จ",
                                   "set": "ชุดชาร์จ", "car_charger": "หัวชาร์จในรถ",
                                   "wireless": "แท่นชาร์จไร้สาย", "desktop": "แท่นชาร์จตั้งโต๊ะ",
                                   "socket": "ปลั๊กอัจฉริยะ"}
                    _sub_kw = _sub_kw_map.get(_history_subtype, "")
                    if _sub_kw:
                        retrieval_message = f"{_sub_kw} {retrieval_message}"
                        print(f"[SUBTYPE-CARRY] carry subtype={_history_subtype} from history → retrieval={retrieval_message!r}", file=sys.stderr)

            is_reference_question = any(ind in req.message for ind in reference_indicators)

            # Heuristic ใหม่: ถ้า message ปัจจุบันไม่มี model keyword ของตัวเอง
            # (ไม่มี digit+brand) + ไม่มี product type ที่ชัดเจน + ไม่ใช่ new topic + มี history
            # → น่าจะเป็น follow-up ที่ถามต่อจากสินค้าเดิม
            # เช่น "จอกี่นิ้วเหรอคะ", "ใช้กับ iPhone ได้ไหม", "เอามาเล่นเกมได้ไหม"
            _msg_has_model_kw = any(
                (any(c.isdigit() for c in w) and len(w) >= 2 and not re.fullmatch(r"\d+\.?", w))
                for w in re.split(r"\s+", req.message.lower().strip())
            )
            # compatibility question: "ใช้กับ iPhone ได้ไหม", "รองรับ Samsung ไหม"
            # เป็นคำถามเกี่ยวกับสินค้าเดิม ไม่ใช่คำถามใหม่ที่อยากซื้อ iPhone/Samsung
            _compat_indicators = ["ใช้กับ", "รองรับ", "เชื่อมต่อ", "pair", "จับคู่", "เชื่อมกับ",
                                  "ใช้สาย", "ใช้กับสาย", "ขึ้นเครื่อง", "เครื่องบิน", "นำขึ้น",
                                  "ติดตัวขึ้น", "carry", "เครื่อง", "ไปจีน", "ต่างประเทศ"]
            _is_compat_question = any(ind in req.message for ind in _compat_indicators)
            _is_generic_followup = (
                not _msg_has_model_kw
                and (not current_types or _is_compat_question or _types_from_history)
                and not is_new_topic
                and not is_other_model_question
                and len(_msg_words) <= 10  # ไม่ยาวเกินไป
            )

            # ถ้าเป็น reference question ("เรือนนี้", "ตัวนี้", "รุ่นนี้", "ขอรายละเอียด")
            # หรือ short followup ("ประกัน", "เคลม", "กันน้ำไหม", "แบต", "ราคาเท่าไหร่")
            # หรือ generic followup (ไม่มี model keyword ของตัวเอง + ไม่มี product type)
            # ให้ดึงชื่อสินค้าจากคำตอบ bot ล่าสุดมาเป็น retrieval keyword
            # เช่น "ขอรายละเอียดเรือนนี้ได้ไหม" หลังจาก bot แนะนำ Black Shark GS3
            # → retrieval = "Black Shark GS3 ขอรายละเอียดเรือนนี้ได้ไหม"
            # หรือ "ประกัน" ล้วน ๆ หลัง bot แนะนำ KOSPET TANK M3
            # → retrieval = "KOSPET TANK M3 ประกัน"
            # ยกเว้นถ้าเป็น other_model_question ("ขอรายละเอียดรุ่นอื่น") → ไม่ใช่ reference
            _is_ref_like = (
                is_reference_question
                or (_is_short_followup and not is_other_model_question and not is_new_topic)
                or (_is_generic_followup and not is_other_model_question)
            )
            if _is_ref_like and not is_new_topic and not is_other_model_question:
                all_model_texts_ref = [
                    m.text for m in req.history
                    if m.role == "model" and m.text.strip()
                ]
                if all_model_texts_ref:
                    latest_bot_answer = all_model_texts_ref[-1]
                    import re as _re_ref
                    # ── ดึงชื่อสินค้าเต็มจาก markdown link ก่อน (แม่นยำกว่า) ──
                    # เช่น [CUKTECH AD1003T + CMC615P เซตหัวชาร์จ Adapter 100W](https://...)
                    # → ใช้ "CUKTECH AD1003T + CMC615P เซตหัวชาร์จ Adapter 100W" เป็น retrieval
                    _md_link_products = _re_ref.findall(
                        r"\[([^\]]{5,120})\]\(https?://",
                        latest_bot_answer,
                    )
                    ref_models = []
                    if _md_link_products:
                        # ใช้ product name จาก markdown link แรกที่ไม่ใช่ "สั่งซื้อ..."
                        for _pname in _md_link_products:
                            if _pname.lower().startswith(("สั่งซื้อ", "ดูรายละเอียด", "ลิงก์")):
                                continue
                            ref_models.append(_pname.strip())
                            break
                        if ref_models:
                            print(f"[REFERENCE] ดึงชื่อสินค้าจาก markdown link: {ref_models[0]}", file=sys.stderr)

                    # ── Fallback: ดึง brand + model pattern จากคำตอบ bot ──
                    if not ref_models:
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
                    if ref_models and not _is_superlative_q:
                        # เช็ค subtype ของ message ปัจจุบัน ถ้าเป็น cable และ ref_model เป็น adapter → ไม่ดึง
                        _cur_sub_ref = product_store._detect_charger_subtype(req.message)
                        _ref_is_adapter = any(kw in ref_models[0].lower() for kw in ("หัวชาร์จ", "adapter", "gan", "หัวชาร์ต"))
                        _ref_is_cable = any(kw in ref_models[0].lower() for kw in ("สายชาร์จ", "cable", "สาย type", "สาย usb", "สาย c"))
                        if _cur_sub_ref == "cable" and _ref_is_adapter and not _ref_is_cable:
                            print(f"[REFERENCE] skip: ลูกค้าถาม cable แต่ ref เป็น adapter: {ref_models[0]}", file=sys.stderr)
                        elif _cur_sub_ref == "adapter" and _ref_is_cable and not _ref_is_adapter:
                            print(f"[REFERENCE] skip: ลูกค้าถาม adapter แต่ ref เป็น cable: {ref_models[0]}", file=sys.stderr)
                        else:
                            # ใช้ model name แรกที่เจอ + คำถามปัจจุบัน
                            retrieval_message = f"{ref_models[0]} {req.message}"
                            print(f"[REFERENCE] ดึงสินค้าจากคำตอบล่าสุด: {ref_models[0]}", file=sys.stderr)

            # ถ้า fuzzy เจอ type แต่เป็นคำถามต่อ → ถือว่า false positive ให้เป็น follow-up
            # ถ้า fuzzy เจอ type และไม่ใช่คำถามต่อ → เป็นคำถามใหม่
            # สำหรับ superlative question: fuzzy มักจับ "ชาร์จ" เป็น charger ผิด → กรองออก
            if current_types and (is_followup_question or is_other_model_question or _is_superlative_q):
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

            # ── Phone model followup: ใช้ type keyword จาก history + ชื่อรุ่นโทรศัพท์ ──
            # เช่น "S25ultar" หลังถามหัวชาร์จ → retrieval = "หัวชาร์จ charger S25ultar"
            # สำคัญ: ใช้ keyword ที่เจาะจงประเภทย่อยด้วย เช่น "หัวชาร์จ" ไม่ใช่ "สายชาร์จ"
            # ถ้า history message มี "หัวชาร์จ" ให้ใช้ "หัวชาร์จ" ไม่ใช่ "สายชาร์จ"
            # ยกเว้นถ้าเป็น superlative question (สุด/แรงสุด/ไวสุด/กว่านี้) → ต้องดึงสินค้าทุกรุ่น ไม่ใช่แค่รุ่นเดิม
            #   แต่ superlative ก็ยังใช้ history type keyword ได้ (เพื่อกรองประเภท) แค่ไม่ใช้ model name
            if _phone_model_followup and retrieval_message == req.message:
                # ดึง type keyword จาก history message ล่าสุดที่มี type
                all_user_msgs_prev = [
                    m.text for m in req.history
                    if m.role == "user" and m.text.strip()
                ]
                _history_type_kw = ""
                for hmsg in reversed(all_user_msgs_prev):
                    hlow = hmsg.lower()
                    if "หัวชาร์จ" in hlow or "หัวชาร์ต" in hlow or "หัวชาจ" in hlow or "หัวชาต" in hlow:
                        _history_type_kw = "หัวชาร์จ charger"
                        break
                    elif "สายชาร์จ" in hlow or "สายชาร์ต" in hlow or "สายชาจ" in hlow or "cable" in hlow:
                        _history_type_kw = "สายชาร์จ cable"
                        break
                    elif "ชุดชาร์จ" in hlow or "ชุดชาร์ต" in hlow or "ชุดชาจ" in hlow or "combo" in hlow:
                        _history_type_kw = "ชุดชาร์จ charger set"
                        break
                    elif "แบตสำรอง" in hlow or "พาวเวอร์แบงค์" in hlow or "powerbank" in hlow:
                        _history_type_kw = "แบตสำรอง powerbank"
                        break
                    elif "หูฟัง" in hlow or "earphone" in hlow or "earbuds" in hlow:
                        _history_type_kw = "หูฟัง earphone"
                        break
                    elif "เคส" in hlow or "case" in hlow:
                        _history_type_kw = "เคส case"
                        break
                    elif "ฟิล์ม" in hlow or "screen protector" in hlow:
                        _history_type_kw = "ฟิล์ม screen protector"
                        break
                    elif "สมาร์ทวอช" in hlow or "smartwatch" in hlow or "นาฬิกา" in hlow:
                        _history_type_kw = "สมาร์ทวอช smartwatch"
                        break
                if not _history_type_kw:
                    # fallback: ใช้ type name จาก current_types
                    type_keywords_map = {
                        "phone": "โทรศัพท์ มือถือ smartphone",
                        "smartwatch": "สมาร์ทวอช smartwatch นาฬิกา",
                        "earphone": "หูฟัง earphone earbuds",
                        "powerbank": "แบตสำรอง powerbank",
                        "charger": "charger",
                        "case": "เคส case ซอง",
                        "speaker": "ลำโพง speaker",
                        "screen_protector": "ฟิล์ม screen protector",
                    }
                    type_name = next(iter(current_types), None)
                    _history_type_kw = type_keywords_map.get(type_name, "")
                if _history_type_kw:
                    retrieval_message = f"{_history_type_kw} {req.message}"
                    print(f"[PHONE-MODEL-FOLLOWUP] retrieval_message = {retrieval_message}", file=sys.stderr)

            # ถ้าปัจจุบันไม่มี product type → เป็น follow-up ให้ใช้ history ค้นสินค้า
            # ยกเว้นถ้าเป็น new topic (เช่น "อุปกรณ์ป้องกันตัว", "โทสับ") → ไม่ใช้ history
            # ยกเว้นถ้าเป็น reference question (เช่น "เรือนนี้") → ใช้ retrieval จาก reference logic แล้ว
            # ยกเว้นถ้า short followup ("ราคาเท่าไหร่") ที่ reference logic จับ model จาก history ได้แล้ว
            #   ถ้า reference logic ไม่เจอ model → ยังใช้ history-words logic ต่อ
            # ยกเว้นถ้า message ปัจจุบันมี model keyword (เช่น "lagenio k9 รับประกัน") → เป็นคำถามใหม่
            # ยกเว้นถ้าเป็น superlative question (สุด/แรงสุด/ไวสุด/กว่านี้) → ต้องดึงสินค้าทุกรุ่นในหมวด ไม่ใช่แค่รุ่นเดิมจาก history
            _ref_handled = _is_ref_like and retrieval_message != req.message
            if not current_types and not is_other_model_question and not is_new_topic and not _ref_handled and not _current_has_model and not _phone_model_followup and not _is_superlative_q:
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
                        # ⚡ ถ้า message ปัจจุบันสั้นมาก (1-2 คำ) และไม่ใช่คำถาม
                        # → น่าจะเป็นชื่อสินค้า/แบรนด์ที่ลูกค้าพิมพ์ตรงๆ (เช่น "biokoop", "elite2")
                        # ให้ใช้ message อย่างเดียว ไม่เพิ่ม type_words/history_words
                        # เพราะ type_words จาก history อาจกรองผิดประเภท
                        # (เช่น history "สายรัดข้อมือ" → fuzzy เป็น charger → กรอง BioKoop ออก)
                        _msg_word_count = len(req.message.split())
                        _msg_is_question = any(kw in req.message.lower() for kw in (
                            "ไหม", "มั้ย", "บ้าง", "เท่าไหร่", "ราคา", "สเปค",
                            "รับประกัน", "เคลม", "ยังไง", "ไง", "ดีไหม", "ดีมั้ย",
                        ))
                        if _msg_word_count <= 2 and not _msg_is_question:
                            retrieval_message = req.message
                            print(f"[SHORT-NAME] message สั้นและไม่ใช่คำถาม → ใช้ message อย่างเดียว: {retrieval_message!r}", file=sys.stderr)
                        else:
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

        # ⚡ Performance & accuracy fix:
        # ถ้าเป็น follow-up (ref_handled) ที่มี model name ชัดเจน (มี digit)
        # → ดึงด้วย Mongo regex ก่อน เพื่อความแม่นยำ (vector search semantic อาจไป match สินค้าอื่น)
        # ถ้า Mongo regex เจอ → ใช้สิ่งนั้น ถ้าไม่เจอ → ตกไปใช้ vector search ปกติ
        _ref_regex_products: list[dict] = []
        if _ref_handled and retrieval_message != req.message:
            # หา model word ที่มี digit (เช่น "A3", "EC4", "Note 13")
            _ref_model_words = [
                w for w in re.split(r"\s+", retrieval_message.lower().strip())
                if any(c.isdigit() for c in w) and len(w) >= 2
                and not re.fullmatch(r"\d+\.?", w)  # ไม่เอาตัวเลขล้วน
            ]
            if _ref_model_words:
                # ดึงสินค้าที่ชื่อมี model word แรก (regex match) + shop filter
                # ใช้ word boundary เพื่อความแม่นยำ (A3 ไม่ match A30)
                _ref_kw = _ref_model_words[0]
                try:
                    _ref_coll = db[os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"]
                    _ref_filter = {
                        "item_status": "NORMAL",
                        "item_name": {"$regex": rf"\b{re.escape(_ref_kw)}\b", "$options": "i"},
                    }
                    if req.shop:
                        _ref_filter["shopname"] = {"$regex": f"^{re.escape(req.shop)}$", "$options": "i"}
                    _ref_docs = list(_ref_coll.find(_ref_filter, product_store.PRODUCT_PROJECTION).limit(5))
                    if _ref_docs:
                        _ref_regex_products = [product_store.to_product_card(d, req.message) for d in _ref_docs]
                        print(f"[REF-REGEX] ดึงสินค้าตรง model '{_ref_kw}' ด้วย Mongo regex: {len(_ref_regex_products)} ตัว", file=sys.stderr)
                except Exception as _e:
                    print(f"[REF-REGEX] error: {_e}", file=sys.stderr)

        # ⚡ Model keyword detection สำหรับ message ปัจจุบัน (ไม่ใช่ follow-up)
        # ถ้า message มี model keyword ชัดเจน (เช่น "Watch6", "BioKoop", "KS2")
        # → ดึงด้วย Mongo regex ก่อน เพื่อความแม่นยำ (vector search semantic อาจไป match สินค้าอื่น)
        # เช่น "Watch6สามารถตอบแอพรุ้งกับแอพเขียวได้ไหมครับ" → ดึงสินค้าที่ชื่อมี "Watch 6"
        if not _ref_regex_products and not _ref_handled:
            # หา model keyword ที่เป็นคำอังกฤษ+ตัวเลข (เช่น Watch6, KS2, P23)
            # ต้องมีอย่างน้อย 4 ตัวอักษร เพื่อกัน false positive (เช่น "A3", "EC4")
            _cur_model_kws = re.findall(r"[A-Za-z]+\d+[A-Za-z]*", req.message)
            _cur_model_kws = [w for w in _cur_model_kws if len(w) >= 4]
            # ถ้าไม่มีคำอังกฤษ+ตัวเลข ลองหาคำอังกฤษยาวๆ ที่ไม่ใช่คำทั่วไป (เช่น "biokoop", "elite2")
            # ต้องมีอย่างน้อย 5 ตัวอักษร เพื่อกัน false positive
            if not _cur_model_kws:
                _cur_alpha_kws = re.findall(r"[A-Za-z]{5,}", req.message)
                # กรองคำทั่วไปที่ไม่ใช่ชื่อสินค้า
                _common_words = {"watch", "smart", "phone", "cable", "charger", "adapter",
                                 "power", "bank", "band", "type", "usb", "wireless",
                                 "what", "how", "please", "thank", "hello", "hi"}
                _cur_alpha_kws = [w for w in _cur_alpha_kws if w.lower() not in _common_words]
                _cur_model_kws = _cur_alpha_kws[:1]  # เอาแค่คำแรก
            if _cur_model_kws:
                _cur_kw = _cur_model_kws[0]
                # จัดการคำผิด (พิมพ์ซ้ำ) เช่น "biokoopp" → "biokoop", "bikooppppp" → "bikoop"
                # โดยตัด tail ที่ซ้ำกัน 3+ ครั้งออก
                _cur_kw_clean = re.sub(r"(.)\1{2,}$", r"\1", _cur_kw.lower())
                if _cur_kw_clean != _cur_kw.lower():
                    print(f"[MODEL-REGEX] ตัด tail ซ้ำ: {_cur_kw!r} → {_cur_kw_clean!r}", file=sys.stderr)
                    _cur_kw = _cur_kw_clean
                # สร้าง regex pattern:
                # - ถ้ามีตัวเลข (เช่น "Watch6") → "Watch.?6" (ยอมรับ space ระหว่างคำและตัวเลข)
                # - ถ้าเป็นคำอังกฤษล้วน (เช่น "biokoop") → "biokoop" (case-insensitive)
                _alpha_part = re.match(r"[A-Za-z]+", _cur_kw).group(0)
                _rest_part = _cur_kw[len(_alpha_part):]
                if _rest_part:  # มีตัวเลขต่อท้าย
                    _cur_kw_pattern = re.escape(_alpha_part) + r".?" + re.escape(_rest_part)
                else:  # คำอังกฤษล้วน — ใช้ prefix 6 ตัวแรกเพื่อจัดการคำผิด
                    _prefix = _cur_kw[:6] if len(_cur_kw) >= 6 else _cur_kw
                    _cur_kw_pattern = re.escape(_prefix)
                try:
                    _ref_coll = db[os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"]
                    _ref_filter = {
                        "item_status": "NORMAL",
                        "item_name": {"$regex": _cur_kw_pattern, "$options": "i"},
                    }
                    if req.shop:
                        _ref_filter["shopname"] = {"$regex": f"^{re.escape(req.shop)}$", "$options": "i"}
                    _ref_docs = list(_ref_coll.find(_ref_filter, product_store.PRODUCT_PROJECTION).limit(5))
                    if _ref_docs:
                        _ref_regex_products = [product_store.to_product_card(d, req.message) for d in _ref_docs]
                        print(f"[MODEL-REGEX] ดึงสินค้าตรง model keyword '{_cur_kw}' (pattern={_cur_kw_pattern!r}) ด้วย Mongo regex: {len(_ref_regex_products)} ตัว", file=sys.stderr)
                except Exception as _e:
                    print(f"[MODEL-REGEX] error: {_e}", file=sys.stderr)

        # ⚡ Fuzzy matching fallback — ถ้า MODEL-REGEX ไม่เจอ ให้ลอง fuzzy match
        # รับพิมพ์ผิด เช่น biokooooooooop, biokooppppppp, redmi wach 6
        if not _ref_regex_products and not _ref_handled:
            try:
                _fuzzy_products = product_store.fuzzy_match_products(
                    db, req.message, shop=req.shop, limit=5, score_threshold=75
                )
                if _fuzzy_products:
                    _ref_regex_products = _fuzzy_products
                    print(f"[FUZZY-MATCH] พิมพ์ผิด → fuzzy match: {len(_ref_regex_products)} ตัว", file=sys.stderr)
            except Exception as _e:
                print(f"[FUZZY-MATCH] error: {_e}", file=sys.stderr)

        # ⚡ Carry-forward products จาก history — ถ้า message ปัจจุบันเป็น follow-up
        # และไม่มี model keyword ชัดเจน ให้ลอง fuzzy match กับ model answer ล่าสุด
        # เพื่อหาสินค้าที่เคยตอบไปแล้ว ทำให้ถามซ้ำได้โดยไม่ลืมสินค้า
        _is_carry_forward = False
        if not _ref_regex_products and not _ref_handled and req.history:
            _cur_has_model_kw = bool(knowledge_base.extract_model_keywords(req.message))
            _cur_msg_lower = (req.message or "").lower().strip()
            # ถ้า message ปัจจุบันสั้น (<= 8 คำ) และไม่มี model keyword → น่าจะ follow-up
            _is_short_followup = len(req.message.split()) <= 8 and not _cur_has_model_kw
            # ไม่ใช่ new topic (เช่น "สวัสดี", "มีอะไรแนะนำไหม")
            _new_topic_kws = ("สวัสดี", "หวัดดี", "hi", "hello", "แนะนำ", "มีอะไร", "มีไร", "ขอดู")
            _is_new_topic = any(kw in _cur_msg_lower for kw in _new_topic_kws)
            if _is_short_followup and not _is_new_topic:
                # หา model answer ล่าสุดจาก history
                _last_model_text = ""
                for h in reversed(req.history):
                    if h.role == "model" and h.text.strip():
                        _last_model_text = h.text
                        break
                if _last_model_text:
                    try:
                        _carry_products = product_store.fuzzy_match_products(
                            db, _last_model_text, shop=req.shop, limit=5, score_threshold=70
                        )
                        if _carry_products:
                            _ref_regex_products = _carry_products
                            _is_carry_forward = True
                            print(f"[CARRY-FORWARD] ใช้สินค้าจาก model answer ล่าสุด: {len(_ref_regex_products)} ตัว", file=sys.stderr)
                    except Exception as _e:
                        print(f"[CARRY-FORWARD] error: {_e}", file=sys.stderr)

        # ⚡ Charging spec question detection (ทำก่อน if _ref_regex_products)
        # ถ้าลูกค้าถาม "สินค้าX ใช้สายชาร์จอะไรได้บ้าง" / "X ชาร์จยังไง" / "X พอร์ตอะไร"
        # → เป็นคำถามเรื่อง charging spec ของสินค้า X ไม่ใช่หาสินค้า charger
        _charging_spec_kws = (
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
        _is_charging_spec_q = any(kw in req.message.lower() for kw in _charging_spec_kws)
        if _is_charging_spec_q:
            print(f"[CHARGING-SPEC-Q] ลูกค้าถาม charging spec ของสินค้า: {req.message!r}", file=sys.stderr)

        # ถ้า Mongo regex เจอ → ใช้สิ่งนั้น (แม่นยำกว่า vector search)
        # ถ้าไม่เจอ → ใช้ vector search ปกติ
        if _ref_regex_products:
            products = _ref_regex_products
            # ⚡ ถ้าเป็น carry-forward จาก history → เพิ่ม context note บอก LLM
            # ว่าสินค้าเหล่านี้คือสินค้าที่ลูกค้าสนใจจากคำถามก่อนหน้า
            # ลูกค้าถามซ้ำเพราะอยากได้ข้อมูลเพิ่ม ไม่ใช่ถามหาสินค้าใหม่
            if _is_carry_forward and products:
                _carry_note = (
                    "⚠️ สินค้าใน context คือสินค้าที่ลูกค้าสนใจจากคำถามก่อนหน้า "
                    "ลูกค้าถามซ้ำเพราะอยากได้ข้อมูลเพิ่มเติมเกี่ยวกับสินค้าเดิม "
                    "ห้ามบอกว่าไม่มีสินค้ารุ่นนี้ หรือแนะนำสินค้าอื่นแทน "
                    "ให้ตอบข้อมูลเพิ่มเติมของสินค้าใน context เท่านั้น"
                )
                if "_context_note" not in products[0]:
                    products[0]["_context_note"] = _carry_note
                else:
                    products[0]["_context_note"] = products[0]["_context_note"] + " " + _carry_note
            # ⚡ ถ้าเป็น charging spec question → เพิ่ม context note ให้ LLM
            # บอก LLM ว่าลูกค้าถามเรื่องสเปกชาร์จของสินค้า ไม่ใช่ถามซื้อสายชาร์จ
            if _is_charging_spec_q and products:
                _charging_note = (
                    "⚠️ คำถามนี้เป็นการถามสเปกการชาร์จของสินค้าใน context "
                    "(เช่น ใช้สายชาร์จแบบไหน พอร์ตอะไร ชาร์จยังไง) "
                    "ไม่ใช่ถามซื้อสายชาร์จ/หัวชาร์จแยก — "
                    "ให้ตอบจากข้อมูล description ของสินค้าใน context "
                    "ถ้า description ระบุประเภทสายชาร์จ/พอร์ต/การชาร์จ ให้บอกข้อมูลนั้น "
                    "ถ้าไม่มีข้อมูล ให้บอกว่าไม่มีระบุในระบบ"
                )
                if "_context_note" not in products[0]:
                    products[0]["_context_note"] = _charging_note
                else:
                    products[0]["_context_note"] = products[0]["_context_note"] + " " + _charging_note
        else:
            # สำหรับ compatibility check ให้ดึงสินค้าเยอะกว่าปกติ
            # เพราะต้องการให้ LLM เห็นสินค้าทุกรุ่นในหมวด เพื่อเลือกรุ่นที่รองรับ device จริงๆ
            _fetch_limit = req.limit
            _is_compat = _intent_result.get("intent") == "compatibility_check"
            if _is_compat:
                _fetch_limit = max(req.limit * 2, 20)
            # superlative question (สุด/ที่สุด/แรงสุด/ไวสุด/มากสุด) → ดึงสินค้าเยอะขึ้น
            # เพื่อให้ LLM เห็นทุกรุ่นแล้วเปรียบเทียบหาอันที่สุดจริง
            _is_superlative = any(kw in _msg_lower_super for kw in _superlative_kw)
            # เก็บ context สำหรับ superlative clarification (ใช้ตอนเรียก LLM)
            _super_has_charge = "ชาร์จ" in retrieval_message or "charger" in retrieval_message.lower()
            _super_has_pb = "พาวเวอร์แบงค์" in retrieval_message or "แบตสำรอง" in retrieval_message or "powerbank" in retrieval_message.lower()
            _super_has_history = bool(req.history and any(m.role == "user" and m.text.strip() for m in req.history))
            if _is_superlative:
                _fetch_limit = max(_fetch_limit * 5, 50)
                # สำหรับ superlative + "ชาร์จ" ที่ไม่มี history → ดึงทั้ง charger และ powerbank
                # เพราะ "ชาร์จไวสุด" อาจหมายถึง หัวชาร์จ สายชาร์จ หรือพาวเวอร์แบงค์ที่จ่ายไฟแรง
                # ไม่คิดแทนลูกค้า — ดึงทั้งหมดแล้วให้ LLM ตอบพร้อมถามกลับถ้าไม่ชัด
                if _super_has_charge and not _super_has_pb and not _super_has_history:
                    # เพิ่มแค่ "พาวเวอร์แบงค์ แบตสำรอง" เพื่อให้ดึง powerbank ด้วย
                    # ไม่เพิ่ม "หัวชาร์จ สายชาร์จ" เพราะ "ชาร์จ" ใน message เดิมก็ match charger อยู่แล้ว
                    # ถ้าเพิ่ม "หัวชาร์จ สายชาร์จ" จะทำให้ vector search ดึงแค่ charger ไม่ดึง powerbank
                    retrieval_message = f"พาวเวอร์แบงค์ แบตสำรอง {retrieval_message}"
                    print(f"[SUPERLATIVE-CHARGE] เพิ่ม powerbank ใน retrieval: {retrieval_message!r}", file=sys.stderr)
            # skip charger subtype เฉพาะ superlative ที่ไม่ได้ระบุ subtype ชัด
            # (เช่น "ชาร์จไวสุด" ไม่มี "สาย"/"หัว") — ถ้ามี subtype ชัด ให้กรองปกติ
            _skip_sub = _is_superlative and not product_store._detect_charger_subtype(retrieval_message)

            # ── Charging spec question detection ──
            # ถ้าลูกค้าถาม "สินค้าX ใช้สายชาร์จอะไรได้บ้าง" / "X ชาร์จยังไง" / "X พอร์ตอะไร"
            # → เป็นคำถามเรื่อง charging spec ของสินค้า X ไม่ใช่หาสินค้า charger
            # ต้องดึงสินค้า X มาตอบ ไม่กรองด้วย charger type
            _charging_spec_kws = (
                "ใช้สายชาร์จอะไร", "ใช้สายอะไรชาร์จ", "ใช้สายอะไร",
                "ชาร์จยังไง", "ชาร์จอะไร", "ชาร์จ type c", "ชาร์จ type-c",
                "ชาร์จได้ไหม", "ชาร์จกี่วัต", "ชาร์จกี่แอม", "ชาร์จกี่w",
                "พอร์ตอะไร", "พอร์ตชาร์จ", "พอร์ตไหน",
                "wireless ได้ไหม", "ชาร์จไร้สาย", "ชาร์จไม่ต้องเสียบ",
                "ใช้สาย c to c", "ใช้สาย c to a", "ใช้สาย usb",
                "ชาร์จเร็วไหม", "ชาร์จเร็วกี่",
            )
            _is_charging_spec_q = any(kw in req.message.lower() for kw in _charging_spec_kws)
            # ต้องไม่ใช่คำถามที่เป็น product_recommend (เช่น "มีสายชาร์จไหม", "สายชาร์จรุ่นไหนดี")
            # ตรวจ: คำแรกของ message ต้องไม่ใช่ charger keyword
            _charger_kws_set = {"สายชาร์จ", "หัวชาร์จ", "ชุดชาร์จ", "สาย", "หัว",
                                "charger", "cable", "adapter", "แท่นชาร์จ", "สาย type",
                                "สาย usb", "สาย c", "สาย pd", "สายไนลอน", "สายถัก", "สายซิลิโคน"}
            _msg_first_word = req.message.split()[0].lower() if req.message.split() else ""
            _starts_with_charger_kw = any(_msg_first_word.startswith(kw) or kw.startswith(_msg_first_word)
                                          for kw in _charger_kws_set if len(_msg_first_word) >= 2)
            # ข้อยกเว้น: ถ้า message มีชื่อสินค้า/แบรนด์ที่ไม่ใช่ charger keyword นำหน้า
            # เช่น "biokoop ใช้สายชาร์จอะไร" → _starts_with_charger_kw=False (biokoop ไม่ใช่ charger kw)
            if _is_charging_spec_q and not _starts_with_charger_kw:
                print(f"[CHARGING-SPEC-Q] ลูกค้าถาม charging spec ของสินค้า → ไม่กรอง charger type: {req.message!r}", file=sys.stderr)
                # override product_types เป็น set() เพื่อไม่กรองด้วย charger
                # และตั้ง desc_message ให้รวม keyword เรื่องชาร์จ เพื่อดึง description ที่เกี่ยวข้อง
                if not desc_message or "ชาร์จ" not in (desc_message or "").lower():
                    desc_message = f"ชาร์จ charging port type cable wireless {req.message}"
                products = product_store.fetch_products(
                    db,
                    message=retrieval_message,
                    shop_filter=req.shop,
                    limit=_fetch_limit,
                    desc_message=desc_message,
                    is_compat_check=False,
                    skip_charger_subtype=True,
                    product_types_override=set(),
                )
            else:
                products = product_store.fetch_products(
                db,
                message=retrieval_message,
                shop_filter=req.shop,
                limit=_fetch_limit,
                desc_message=desc_message,
                is_compat_check=_is_compat,
                skip_charger_subtype=_skip_sub,
            )
        print(f"[TIMING] fetch_products: {_time.time()-_t1:.2f}s  (retrieval={retrieval_message!r})  products={len(products)}", file=sys.stderr)

        # ── Superlative ที่ไม่ match product type ใดๆ ชัดเจน ──
        # เช่น "สายฉีดน้ำแรงดันสูง แรงดันแรงๆ ไวๆ" → ไม่ใช่ charger/powerbank
        # ถ้า fetch ไม่เจอสินค้าหรือเจอน้อยมาก → ถามกลับก่อน ไม่ใช้ web search (เปลือง)
        # ให้ LLM ถามกลับว่าลูกค้าสนใจสินค้าประเภทใด
        if _is_superlative_q and len(products) == 0 and not _super_has_charge:
            print(f"[SUPERLATIVE-NO-MATCH] ไม่เจอสินค้า ถามกลับแทน web search", file=sys.stderr)
            return {
                "answer": (
                    "รบกวนช่วยระบุประเภทสินค้าที่สนใจหน่อยค่ะ "
                    "เช่น หัวชาร์จ สายชาร์จ พาวเวอร์แบงค์ เครื่องฟอกอากาศ "
                    "หรือสินค้าประเภทใดที่ต้องการแบบไวสุด/แรงสุดคะ "
                    "เพื่อให้เราแนะนำรุ่นที่ตรงกับความต้องการได้แม่นยำขึ้น"
                ),
                "products": [],
                "source": "superlative_no_match_clarify",
                "shop": req.shop,
                "platform": req.platform,
                "model": os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"),
                "usage": {"prompt": 0, "output": 0, "total": 0},
                "intent": _intent_result if isinstance(_intent_result, dict) else {},
                "intent_confidence": (_intent_result or {}).get("confidence", 0) if isinstance(_intent_result, dict) else 0,
                "web_search_used": False,
                "steps": [],
                "timing": {"total": round(_time.time() - _total_start, 3)},
            }

        # Dedup สินค้าที่ชื่อเหมือนกันหรือใกล้เคียงกันมาก
        # (เช่น P23 ซ้ำ 3 ตัว ต่างกันแค่ suffix ระยะเวลาประกัน -12M / -1Y)
        # (เช่น AURA LPB100 ซ้ำ 3 ตัว ต่างกันที่ "/ LPB200NL" vs "/ AURA LPB200N")
        # ทำหลัง fetch_products ก่อน merge/unlist logic
        # ใช้ "base name" = ตัด suffix warranty + ตัดส่วนหลัง "/" เพื่อรวมสินค้าเดียวกัน
        # เมื่อเจอซ้ำ → เลือก listing ที่ดีที่สุดสำหรับขาย (NORMAL + stock + โปร + ราคาถูก)
        import re as _re_dedup
        def _listing_sell_score(p: dict) -> tuple:
            """คะแนนสำหรับเลือก listing ที่ดีที่สุดสำหรับขาย.
            เกณฑ์ (เรียงจากสำคัญที่สุดไปน้อยที่สุด):
            1. status=NORMAL (True > False)
            2. ไม่ sold_out (True > False)
            3. stock เยอะกว่า
            4. มีโปร (True > False)
            5. ราคาต่ำสุดถูกกว่า
            """
            status_normal = p.get("status") == "NORMAL"
            not_sold_out = not p.get("sold_out", False)
            stock = p.get("total_stock") or 0
            has_promo = bool(p.get("price", {}).get("min") and p.get("price", {}).get("max")
                             and p.get("price", {}).get("min") != p.get("price", {}).get("max"))
            # ราคาต่ำสุด — ถูกกว่า = ดีกว่า (ใช้ค่าติดลบเพื่อให้ถูกกว่าได้ score สูงกว่า)
            price_info = p.get("price") or {}
            min_price = price_info.get("min") or 0
            # ถ้าไม่มีราคา ให้ score ราคาเป็น 0 (ไม่ดีไม่แย่)
            price_score = -min_price if min_price else 0
            return (status_normal, not_sold_out, stock, has_promo, price_score)

        def _base_name(name: str) -> str:
            """สกัดชื่อหลักของสินค้า เพื่อรวม listing ซ้ำของสินค้าตัวเดียวกัน.

            หลักการ:
            - ตัด suffix ระยะเวลาประกัน (-12M, -1Y, -2Y)
            - ตัด "พอร์ตเดียวแรงสุด XXXw" ที่แทรกกลางชื่อ (บาง listing เพิ่ม)
            - ตัดมาตรฐาน "CCC / CE", "CE / CCC" ที่เป็นตัวคั่นมาตรฐาน
            - **ไม่ตัด** ส่วนที่บอกว่าเป็น bundle (เช่น "/ with adapter", "/ A18T")
              เพราะ bundle กับ standalone เป็นคนละสินค้า ต้องไม่รวมกัน
            - กรองช่องว่างระหว่างคำซ้ำ
            """
            n = (name or "").strip().lower()
            # ตัด prefix โปรโมชั่นที่ Shopee แปะไว้หน้าชื่อ
            # เช่น "[ลดเหลือ 5499]", "[ราคาพิเศษ]", "[โค้ด XXX]"
            n = _re_dedup.sub(r"^\[.*?\]\s*", "", n)
            # ตัด " -12M", " -1Y", " -2Y", " -6M" ท้ายชื่อ
            # (ใช้ [my] เพราะชื่อถูก lower แล้ว)
            n = _re_dedup.sub(r"\s*-\d+[my]\s*$", "", n)
            # ตัด "พอร์ตเดียวแรงสุด XXXw" และ "จ่ายไฟพอร์ตเดียว XXXw" ที่แทรกกลางชื่อ
            n = _re_dedup.sub(r"(จ่ายไฟ)?พอร์ตเดียวแรงสุด\s*\d+w\s*", "", n)
            # ตัด "พอร์ตเดียว XXXw" (ไม่มี "แรงสุด")
            n = _re_dedup.sub(r"(จ่ายไฟ)?พอร์ตเดียว\s*\d+w\s*", "", n)
            # ตัดมาตรฐาน "CCC / CE", "CE / CCC", "USB-C / USB-A" ที่เป็นตัวคั่นมาตรฐาน
            # (ไม่ใช่ตัวบอก bundle) — แทนที่ด้วยช่องว่าง
            _standards = ("ccc / ce", "ce / ccc", "usb-c / usb-a", "usb a / usb c")
            for s in _standards:
                n = n.replace(s, " ")
            # กรองช่องว่างระหว่างคำซ้ำ
            n = _re_dedup.sub(r"\s{2,}", " ", n).strip()
            return n

        _seen_names = {}  # base_name → index ใน _deduped
        _deduped = []
        for p in products:
            pname = _base_name(p.get("name") or "")
            if not pname:
                _deduped.append(p)
                continue
            if pname not in _seen_names:
                _seen_names[pname] = len(_deduped)
                _deduped.append(p)
            else:
                # เจอซ้ำ → เลือก listing ที่ดีที่สุดสำหรับขาย
                _idx = _seen_names[pname]
                _existing = _deduped[_idx]
                _existing_score = _listing_sell_score(_existing)
                _new_score = _listing_sell_score(p)
                if _new_score > _existing_score:
                    _deduped[_idx] = p
        if len(_deduped) < len(products):
            print(f"[DEDUP] products: {len(products)} → {len(_deduped)} (removed {len(products) - len(_deduped)} duplicates)", file=sys.stderr)
        products = _deduped

        # ── Superlative ranking: เรียงสินค้าตามค่าที่ลูกค้าถาม "สุด" ──
        # เช่น "ชาร์จไวสุด/แรงสุด" → extract ค่า W จากชื่อ/spec แล้ว sort จากมากไปน้อย
        # เพื่อให้สินค้าที่แรงสุดจริงขึ้น top ของ context ที่ส่ง LLM
        # (ปัญหาเดิม: RAG sort ตาม relevance score ทั่วไป ทำให้ P23 210W ตกไปอันดับ 11+)
        # ใช้ spec fields จาก CSV schema: output_power_w, capacity_mah, package_weight
        # ⚡ ขยาย: trigger เมื่อ superlative_q หรือ compatibility_check (ถามหาสินค้าที่รองรับ device)
        # เพื่อให้สินค้าสเปคสูงสุดที่รองรับขึ้น top ของ context
        _is_compat_check = _intent_result.get("intent") == "compatibility_check"
        _is_charger_compat = _is_compat_check and _intent_result.get("product_type") in ("charger", "powerbank")
        if (_is_superlative_q or _is_charger_compat) and len(products) > 1:
            import re as _re_super
            def _extract_max_watt(p: dict) -> float:
                """extract ค่า W สูงสุดจาก spec field ก่อน ถ้าไม่มีค่อยดึงจากชื่อ.
                กรอง model number ออก เช่น CTC615W = สายชาร์จ 240W จริง (615 เป็น model number ไม่ใช่ wattage)
                """
                # 1. ลองจาก spec field ก่อน (output_power_w จาก CSV schema)
                spec_w = p.get("output_power_w") or p.get("specs", {}).get("output_power_w")
                if spec_w and isinstance(spec_w, (int, float)) and spec_w > 0:
                    return float(spec_w)
                # 2. ลองจาก variants ที่มี output_power_w
                variants = p.get("variants") or []
                max_v = 0.0
                for v in variants:
                    vw = v.get("output_power_w")
                    if vw and isinstance(vw, (int, float)) and vw > max_v:
                        max_v = float(vw)
                if max_v > 0:
                    return max_v
                # 3. fallback: extract จากชื่อสินค้า
                name = p.get("name") or p.get("item_name") or ""
                if not name:
                    return 0.0
                low_name = name.lower()
                # กรอง model number ออกก่อน: CTC615W, CMC610, AD653U, AC30S, ZA651, etc.
                # pattern: ตัวอักษร 2-4 ตัว + ตัวเลข 2-4 ตัว + ตัวอักษร 0-2 ตัว + W
                # แทนที่ด้วยช่องว่าง เพื่อไม่ให้ regex จับเป็น wattage
                _model_pat = _re_super.compile(r"\b[a-z]{2,4}\d{2,4}[a-z]?\s*w\b")
                clean_name = _model_pat.sub(" ", low_name)
                # หาทุกค่าที่ลงท้ายด้วย W (เช่น 210W, 140W, 55W, 30W) ในชื่อที่กรองแล้ว
                matches = _re_super.findall(r"(\d+(?:\.\d+)?)\s*w\b", clean_name)
                if not matches:
                    return 0.0
                return max(float(m) for m in matches)
            def _extract_max_mah(p: dict) -> float:
                """extract ค่า mAh สูงสุดจาก spec field ก่อน ถ้าไม่มีค่อยดึงจากชื่อ."""
                spec_mah = p.get("capacity_mah") or p.get("specs", {}).get("capacity_mah")
                if spec_mah and isinstance(spec_mah, (int, float)) and spec_mah > 0:
                    return float(spec_mah)
                variants = p.get("variants") or []
                max_v = 0.0
                for v in variants:
                    vm = v.get("capacity_mah")
                    if vm and isinstance(vm, (int, float)) and vm > max_v:
                        max_v = float(vm)
                if max_v > 0:
                    return max_v
                name = p.get("name") or p.get("item_name") or ""
                if not name:
                    return 0.0
                matches = _re_super.findall(r"(\d+(?:\.\d+)?)\s*mah\b", name.lower())
                if not matches:
                    return 0.0
                return max(float(m) for m in matches)
            def _extract_weight(p: dict) -> float:
                """extract น้ำหนัก (kg) จาก spec field."""
                w = p.get("package_weight") or p.get("specs", {}).get("package_weight")
                if w and isinstance(w, (int, float)) and w > 0:
                    return float(w)
                return 999.0  # ถ้าไม่มีข้อมูล ให้ตกไปอยู่ท้าย (เบาสุด = น้ำหนักน้อยสุด)
            # ตรวจว่าลูกค้าถามเรื่อง wattage (ไว/แรง) หรือ capacity (จุมากสุด) หรือ weight (เบาสุด) หรืออื่นๆ
            _super_msg_lower = (req.message or "").lower()
            _watt_kw = ("ไว", "แรง", "เร็ว", "w", "watt", "ชาร์จไว", "จ่ายไฟ")
            _cap_kw = ("จุ", "ความจุ", "mah", "capacity", "แบตเยอะ", "แบตมาก")
            _weight_kw = ("เบา", "น้ำหนัก", "weight", "เบาสุด", "น้อยสุด")
            _is_watt_q = any(kw in _super_msg_lower for kw in _watt_kw)
            _is_cap_q = any(kw in _super_msg_lower for kw in _cap_kw)
            _is_weight_q = any(kw in _super_msg_lower for kw in _weight_kw)
            # ⚡ compatibility_check สำหรับ charger/cable → sort by wattage desc เสมอ
            # เพื่อให้สินค้าสเปคสูงสุด (เช่น 6A 240W) ขึ้น top ของ context
            if _is_charger_compat and not _is_watt_q:
                products.sort(key=lambda p: _extract_max_watt(p), reverse=True)
                print(f"[COMPAT-RANK] sort by wattage (desc)  top3: {[_extract_max_watt(p) for p in products[:3]]}", file=sys.stderr)
            elif _is_watt_q:
                products.sort(key=lambda p: _extract_max_watt(p), reverse=True)
                print(f"[SUPERLATIVE-RANK] sort by wattage (desc)  top3: {[_extract_max_watt(p) for p in products[:3]]}", file=sys.stderr)
            elif _is_cap_q:
                products.sort(key=lambda p: _extract_max_mah(p), reverse=True)
                print(f"[SUPERLATIVE-RANK] sort by capacity (desc)  top3: {[_extract_max_mah(p) for p in products[:3]]}", file=sys.stderr)
            elif _is_weight_q:
                products.sort(key=lambda p: _extract_weight(p))
                print(f"[SUPERLATIVE-RANK] sort by weight (asc)  top3: {[_extract_weight(p) for p in products[:3]]}", file=sys.stderr)
            # จำกัดเหลือ req.limit หลัง sort (เพื่อประหยัด token)
            products = products[:req.limit]
            print(f"[SUPERLATIVE-RANK] products after sort+limit: {len(products)}", file=sys.stderr)

        # ⚡ ตัดสินค้าที่ตอบไปแล้วออกจาก context (เฉพาะกรณี "ขอรุ่นอื่นๆ")
        # ดึง model name จากคำตอบ bot ใน history → กรองสินค้าที่ match ออก
        # เพื่อให้ลูกค้าได้รุ่นใหม่จริงๆ ไม่ใช่รุ่นเดิมที่เคยตอบไป
        if is_other_model_question and products and req.history:
            _answered_models: list[str] = []
            for h in req.history:
                if h.role == "model" and h.text.strip():
                    # ดึง model pattern จากคำตอบ bot (brand + alphanumeric ที่มี digit)
                    _patterns = re.findall(
                        r"\b([A-Za-z]{2,})\s+([A-Za-z]*\d+[A-Za-z]*)\b",
                        h.text
                    )
                    _stop = {"งบ", "บาท", "ราคา", "โค้ด", "พิเศษ", "ลด", "เหลือ",
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
                             "Heart", "Stress", "Sleep",
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
                             "GB", "V", "Pro", "Max", "Plus", "Mini", "Note",
                             "S", "A", "E", "C", "T", "M", "X", "Z", "K",
                             "EC", "CC", "SC", "W",
                    }
                    for brand_part, model_part in _patterns:
                        if brand_part.lower() in _stop:
                            continue
                        if not re.search(r"\d", model_part):
                            continue
                        if re.fullmatch(r"\d+", model_part):
                            continue
                        full = f"{brand_part} {model_part}".lower()
                        if full not in _answered_models:
                            _answered_models.append(full)
            if _answered_models:
                _before = len(products)
                products = [
                    p for p in products
                    if not any(
                        _am in (p.get("name", "") or "").lower()
                        for _am in _answered_models
                    )
                ]
                print(f"[OTHER-MODEL] ตัดสินค้าที่ตอบไปแล้ว: {_answered_models[:3]}  เหลือ {len(products)}/{_before}", file=sys.stderr)

        # ⚠️ Fallback: ถ้าไม่เจอสินค้าเลย และลูกค้าทักจากร้านใดร้านหนึ่ง
        # ให้ดึงสินค้าอื่นจากร้านเดียวกันมาเป็นทางเลือกให้ LLM แนะนำ
        # (เช่น ถาม "imilab ec4" ที่ร้าน BlackShark → ไม่มี → ดึงสินค้าอื่นของ BlackShark มาแนะนำ)
        # แต่ถ้าเป็น charger subtype (หัวชาร์จ/สายชาร์จ/ชุดชาร์จ) ที่ไม่เจอ → ดึง charger ทั่วไปแทน
        #   (ไม่ใช่สินค้าสุ่ม เพราะอาจได้สินค้าไม่เกี่ยว เช่น พาวเวอร์แบงค์)
        if not products and req.shop:
            _t_alt = _time.time()
            # ตรวจว่าเป็น charger subtype ที่ไม่เจอไหม
            _req_charger_sub = product_store._detect_charger_subtype(retrieval_message)
            if _req_charger_sub:
                # ดึง charger ทั่วไป (ไม่กรอง subtype) เพื่อให้ LLM แนะนำชุด/สาย แทน
                # ใช้ "charger" เฉยๆ (ไม่มี subtype keyword) เพื่อไม่ให้ subtype filter ทำงาน
                alt_products = product_store.fetch_products(
                    db,
                    message="charger charging adapter cable",
                    shop_filter=req.shop,
                    limit=10,
                )
                # กรอง fallback ให้เหลือเฉพาะที่เกี่ยวข้อง:
                # - ถ้าถาม adapter → เอา set + adapter (ไม่เอา cable เดี่ยว)
                # - ถ้าถาม cable → เอา set + cable (ไม่เอา adapter เดี่ยว)
                # - ถ้าถาม set → เอา set + adapter + cable (เอาทั้งหมด)
                if alt_products and _req_charger_sub in ("adapter", "cable"):
                    _filtered_alt = []
                    for p in alt_products:
                        pname = (p.get("name") or "").lower()
                        _is_set = any(kw in pname for kw in (
                            "ชุดชาร์จ", "ชุดชาร์ต", "set", "combo", "ready to go",
                            "charge anywhere", "premium charging",
                        )) or ("ชุด" in pname and ("ชาร์จ" in pname or "charger" in pname))
                        _is_desktop = "แท่นชาร์จ" in pname or "desktop charger" in pname
                        if _is_desktop:
                            continue  # ไม่เอาแท่นชาร์จ
                        if _req_charger_sub == "adapter":
                            # เอา set + adapter ไม่เอา cable เดี่ยว
                            if _is_set or any(kw in pname for kw in ("หัวชาร์จ", "adapter", "gan")):
                                _filtered_alt.append(p)
                        elif _req_charger_sub == "cable":
                            # เอา set + cable ไม่เอา adapter เดี่ยว
                            if _is_set or any(kw in pname for kw in ("สายชาร์จ", "cable", "สาย usb", "สาย type")):
                                _filtered_alt.append(p)
                    if _filtered_alt:
                        alt_products = _filtered_alt
                if alt_products:
                    products = alt_products
                    _sub_label = {"adapter": "หัวชาร์จเดี่ยว", "cable": "สายชาร์จเดี่ยว", "set": "ชุดชาร์จ"}.get(_req_charger_sub, _req_charger_sub)
                    if products:
                        products[0]["_context_note"] = (
                            f"⚠️ ร้าน {req.shop} ไม่มี{_sub_label}ที่ลูกค้าถาม "
                            f"สินค้าด้านล่างเป็นอุปกรณ์ชาร์จอื่นๆ จากร้าน {req.shop} "
                            f"ให้บอกลูกค้าก่อนว่าร้านนี้ไม่มี{_sub_label} "
                            f"แล้วแนะนำสินค้าเหล่านี้แทน (เช่น ชุดชาร์จที่มีหัวชาร์จรวมอยู่ด้วย)"
                        )
                    print(f"[TIMING] Charger subtype fallback ({_req_charger_sub}): {_time.time()-_t_alt:.2f}s  products={len(products)}", file=sys.stderr)
            else:
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
        # ⚡ ข้ามสำหรับ app question — ต้องส่ง 10 ชิ้นเข้า LLM ให้ครบ
        # ⚡ ข้ามสำหรับ superlative question — ต้องส่งทุกรุ่นเข้า LLM เพื่อเปรียบเทียบ
        if retrieval_message != req.message and products and not _is_app_question and not _is_superlative_q:
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
                # dedup ตาม name (ไม่ใช่ item_id) เพื่อกัน P23 ซ้ำจากหลาย listing
                seen_names = set()
                merged = []
                for p in unlist_products + normal_products + alt_products:
                    pname = (p.get("name") or "").strip().lower()
                    if pname and pname in seen_names:
                        continue
                    if pname:
                        seen_names.add(pname)
                    merged.append(p)
                # สำหรับ compatibility check ให้เก็บเยอะกว่า req.limit เพื่อให้ LLM เห็นทุกรุ่น
                _merge_limit = max(req.limit * 4, 40) if _is_compat else req.limit
                products = merged[:_merge_limit]

            # ใส่ context note ชัดๆ (ทุกกรณี ไม่ใช่แค่ตอนมี ptypes)
            unlist_note = (
                "สินค้าที่ status != NORMAL (UNLIST/SELLER_DELETE) เลิกขายแล้ว — "
                "ห้ามเสนอขาย/แสดงราคา/แสดงลิงก์สั่งซื้อ "
                "ถ้าลูกค้าถามเรื่องสเปค/รายละเอียดสินค้า: ให้ตอบสเปค/รายละเอียดของสินค้านั้นได้ตามปกติ "
                "(ไม่ต้องบอกว่าเลิกขาย นอกจากลูกค้าถามว่ามีขายไหม) "
                "ถ้าลูกค้าถามเรื่องรับประกัน/เคลม: ให้ตอบเงื่อนไขรับประกันของสินค้านั้น "
                "+ ถามวันที่ซื้อ + คำนวณช่วงประกัน + ชวนทักแอดมิน "
                "(ห้ามเสนอสินค้าอื่นแทน เพราะลูกค้าไม่ได้ถามเรื่องซื้อ) "
                "ถ้าลูกค้าอยากซื้อ/ถามว่ามีขายไหม: ให้บอกว่ารุ่นนี้เลิกขายแล้ว "
                "แล้วแนะนำเฉพาะสินค้า status=NORMAL เท่านั้น"
            )
            # ใส่ note สำหรับสินค้า sold_out/stock=0 ด้วย (แม้ status=NORMAL)
            _has_sold_out = any(
                p.get("sold_out", False) or (p.get("total_stock", 0) or 0) == 0
                for p in products
            )
            sold_out_note = (
                "สินค้าที่ sold_out=True หรือ stock=0 (แม้ status=NORMAL) หมดสต็อกชั่วคราว — "
                "ห้ามเสนอขาย/แสดงลิงก์สั่งซื้อ "
                "ถ้าลูกค้าถามเรื่องสเปค/รายละเอียดสินค้า: ให้ตอบสเปค/รายละเอียดของสินค้านั้นได้ตามปกติ "
                "(ไม่ต้องบอกว่าหมดสต็อก นอกจากลูกค้าถามว่ามีขายไหม/พร้อมส่งไหม) "
                "ถ้าลูกค้าถามเรื่องรับประกัน/เคลม: ให้ตอบเงื่อนไขรับประกันของสินค้านั้น "
                "(ห้ามเสนอสินค้าอื่นแทน เพราะลูกค้าไม่ได้ถามเรื่องซื้อ) "
                "ถ้าลูกค้าอยากซื้อ/ถามว่ามีขายไหม/พร้อมส่งไหม: ให้บอกว่ารุ่นนี้หมดสต็อกชั่วคราว "
                "แล้วแนะนำเฉพาะสินค้า status=NORMAL ที่มี stock และไม่ sold_out เท่านั้น"
            ) if _has_sold_out else ""
            if products:
                _combined_note = unlist_note
                if sold_out_note:
                    _combined_note = _combined_note + " " + sold_out_note
                if "_context_note" not in products[0]:
                    products[0]["_context_note"] = _combined_note
                else:
                    products[0]["_context_note"] = products[0]["_context_note"] + " " + _combined_note

        import time as _time
        _llm_start = _time.time()
        # สำหรับ superlative question ที่ไม่ชัดว่าลูกค้าต้องการประเภทใด
        # (เช่น "ชาร์จไวสุด" อาจหมายถึง หัวชาร์จ สายชาร์จ หรือพาวเวอร์แบงค์)
        # → เพิ่ม instruction ให้ LLM ถามกลับถ้าไม่ชัด แทนการคิดแทนลูกค้า
        _superlative_clarify_extra = ""
        # default values (อาจถูก override ใน if req.history: block)
        _super_has_pb = _super_has_pb if '_super_has_pb' in dir() else (
            "พาวเวอร์แบงค์" in retrieval_message or "แบตสำรอง" in retrieval_message or "powerbank" in retrieval_message.lower()
        )
        _super_has_history = _super_has_history if '_super_has_history' in dir() else bool(req.history)
        if _is_superlative_q and not _super_has_pb and not _super_has_history:
            _superlative_clarify_extra = (
                "\nหมายเหตุ: คำถามนี้เป็นแบบ superlative (อยากได้ที่สุด/ไวสุด/แรงสุด) "
                "แต่ไม่ได้ระบุประเภทสินค้าชัดเจน และไม่มีประวัติการคุยก่อนหน้า "
                "ถ้า context มีสินค้าหลายประเภท (เช่น ทั้งหัวชาร์จและพาวเวอร์แบงค์) "
                "ให้แนะนำสินค้าที่แรง/ไวสุดจริงจาก context พร้อมถามกลับว่า "
                "ลูกค้าสนใจประเภทใดโดยเฉพาะ อย่าคิดแทนลูกค้า\n"
            )
        try:
            answer, usage_info = llm.answer(
                message=desc_message,
                products=products,
                shop_hint=req.shop,
                history=history,
                persona_extra=_persona_extra,
                intent_result=_intent_result,
                extra_context=_superlative_clarify_extra,
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
        _timing_breakdown["llm"] = round(_llm_elapsed, 3)
        # record RAG step (retrieval) — ก่อน LLM2 เพราะ RAG ดึงสินค้าก่อนส่งให้ LLM
        _product_names = [p.get("name", "")[:60] for p in products[:10]]
        _steps.append({
            "name": "RAG",
            "model": "mongodb+kb",
            "tokens_in": 0,
            "tokens_out": 0,
            "time_s": _timing_breakdown.get("retrieval", 0),
            "cost_usd": 0,
            "cost_thb": 0,
            "input": {
                "query": desc_message or req.message,
                "shop": req.shop,
                "limit": req.limit,
                "intent": _intent_result.get("intent"),
            },
            "output": {
                "product_count": len(products),
                "products": _product_names,
            },
        })
        # record LLM2 step (ตัวตอบ — gemini 3.5 flash lite)
        _steps.append({
            "name": "LLM2",
            "model": model_name,
            "tokens_in": prompt_t,
            "tokens_out": output_t,
            "time_s": round(_llm_elapsed, 3),
            "cost_usd": round(cost, 6),
            "cost_thb": round(cost * 36, 4),
            "input": {
                "message": req.message,
                "product_count": len(products),
                "products": _product_names,
                "intent": _intent_result.get("intent"),
                "history_count": len(history) if history else 0,
                "persona": _persona_extra[:100] if _persona_extra else "",
            },
            "output": {
                "answer": answer[:500],
                "answer_full_length": len(answer),
            },
        })
        answer = _append_base_warranty(answer, desc_message)
        # ส่ง product cards ทั้งหมดที่เป็น context ให้ frontend (เหมือนเดิม)
        # frontend จะโชว์ว่าคำตอบนี้ใช้สินค้าอะไรตัดสินใจบ้าง
        # LLM จะเลือกแนะนำไม่เกิน 3 รายการจาก context เอง (ตาม prompt)
        _intent_name = _intent_result.get("intent", "")
        products_for_response = products[:req.limit]
        _timing_breakdown["total"] = round(_time.time() - _total_start, 3)

        # ── Web search fallback (ด่านสุดท้าย) ──
        # Flow ใหม่: search_and_extract → query DB ใหม่ → LLM ปั้นประโยค
        from . import web_search as _ws
        _extra_context = ""
        if _ws.is_configured():
            _should_search, _search_reason = _ws.should_use_web_search(
                answer=answer,
                intent_result=_intent_result,
                products=products,
                message=req.message,
            )
            if _should_search:
                print(f"[WEB-SEARCH] triggered: {_search_reason}", file=sys.stderr)

                # Step 1+2: OpenRouter + Google Search → extract keywords
                _ws_result = _ws.search_and_extract(
                    message=req.message,
                    shop=req.shop,
                    platform=req.platform,
                    history=history,
                    reason=_search_reason,
                )

                if not _ws_result.get("error") and _ws_result.get("search_used"):
                    _ws_keywords = _ws_result.get("keywords", [])
                    _ws_search_info = _ws_result.get("search_info", "")
                    _ws_product_type = _ws_result.get("product_type", "")
                    _ws_usage = _ws_result.get("usage", {})
                    _ws_cost = _ws_result.get("cost_usd", 0.0)
                    _ws_elapsed = _ws_result.get("elapsed", 0.0)

                    print(f"[WEB-SEARCH] keywords={_ws_keywords[:5]}  product_type={_ws_product_type}", file=sys.stderr)

                    # Step 3: query DB + KB ใหม่ด้วย keywords จาก web search
                    _new_products: list[dict] = []
                    _ws_kb_context = ""
                    if _ws_keywords:
                        _search_query = " ".join(_ws_keywords[:6])
                        if _ws_product_type:
                            _search_query = f"{_ws_product_type} {_search_query}"
                        # query MongoDB ด้วย keywords
                        try:
                            _new_products = product_store.fetch_products(
                                db,
                                message=_search_query,
                                shop_filter=req.shop,
                                limit=10,
                                desc_message=req.message,
                            )
                            print(f"[WEB-SEARCH] DB re-query: {_search_query!r}  → {len(_new_products)} products", file=sys.stderr)
                        except Exception as e:
                            print(f"[WEB-SEARCH] DB re-query error: {e}", file=sys.stderr)
                        # เพิ่ม: ถ้า search_info มีรหัสรุ่น (เช่น PB100P, PB200P, P23) ให้ query แบบ exact ด้วย
                        import re as _re_ws
                        _model_codes = _re_ws.findall(r'\b(PB\d{3}[A-Z]?|P\d{2}|BA\d{3}[A-Z]?|LPB\d{3}[A-Z]?|WPB\d{3}[A-Z]?)\b', _ws_search_info)
                        if _model_codes:
                            _model_codes = list(dict.fromkeys(_model_codes))[:5]  # unique, limit 5
                            print(f"[WEB-SEARCH] model codes from search_info: {_model_codes}", file=sys.stderr)
                            for _code in _model_codes:
                                try:
                                    _code_products = product_store.fetch_products(
                                        db,
                                        message=_code,
                                        shop_filter=req.shop,
                                        limit=3,
                                        desc_message=req.message,
                                    )
                                    # ไม่ซ้ำ
                                    _existing_ids = {p.get("item_id") or p.get("name") for p in _new_products}
                                    for _cp in _code_products:
                                        _pid = _cp.get("item_id") or _cp.get("name")
                                        if _pid not in _existing_ids:
                                            _new_products.append(_cp)
                                            _existing_ids.add(_pid)
                                except Exception as e:
                                    print(f"[WEB-SEARCH] model code query error ({_code}): {e}", file=sys.stderr)
                            print(f"[WEB-SEARCH] after model code merge: {len(_new_products)} products", file=sys.stderr)
                        # query KB
                        try:
                            _ws_kb_result = knowledge_base.lookup_kb(_search_query)
                            if _ws_kb_result and _ws_kb_result.get("found"):
                                _ws_kb_context = _ws_kb_result.get("context", "") or ""
                                # รวม KB docs เข้ากับ products
                                for kd in _ws_kb_result.get("kb_docs", [])[:3]:
                                    _kb_card = _kb_doc_to_card(kd)
                                    _kb_card["_kb_only"] = True
                                    _new_products.append(_kb_card)
                                print(f"[WEB-SEARCH] KB re-query: {len(_ws_kb_result.get('kb_docs', []))} docs", file=sys.stderr)
                        except Exception as e:
                            print(f"[WEB-SEARCH] KB re-query error: {e}", file=sys.stderr)

                    # ถ้า query ใหม่ไม่เจอ → ใช้สินค้าเดิมจาก RAG
                    _final_products = _new_products if _new_products else products
                    # dedup สินค้าที่ชื่อใกล้เคียงกัน (เช่น P23 ซ้ำหลาย listing)
                    _ws_seen = {}
                    _ws_deduped = []
                    for p in _final_products:
                        _bn = _base_name(p.get("name") or "")
                        if not _bn:
                            _ws_deduped.append(p)
                            continue
                        if _bn not in _ws_seen:
                            _ws_seen[_bn] = len(_ws_deduped)
                            _ws_deduped.append(p)
                        else:
                            _idx = _ws_seen[_bn]
                            if _listing_sell_score(p) > _listing_sell_score(_ws_deduped[_idx]):
                                _ws_deduped[_idx] = p
                    if len(_ws_deduped) < len(_final_products):
                        print(f"[WEB-SEARCH] dedup: {len(_final_products)} → {len(_ws_deduped)}", file=sys.stderr)
                    _final_products = _ws_deduped
                    # rerank _final_products ตาม standalone priority (เดี่ยว > ชุด)
                    # เพื่อให้ powerbank เดี่ยวอยู่ก่อนชุด/เคส
                    if _final_products and len(_final_products) > req.limit:
                        _final_products.sort(
                            key=lambda p: not product_store._is_bundle_product(p),
                            reverse=True,
                        )

                    # Step 4: LLM ปั้นประโยคจากสินค้า DB + KB + ข้อมูล search
                    _llm2_start = _time.time()
                    if _final_products and _ws_search_info:
                        # รวม context ทั้งหมด: search info + KB
                        _extra_parts = [f"=== ข้อมูลจาก Google Search (ใช้ประกอบคำตอบ แต่ห้ามอ้างอิงลิงก์) ===\n{_ws_search_info}"]
                        if _ws_kb_context:
                            _extra_parts.append(f"=== ข้อมูลจาก Knowledge Base ===\n{_ws_kb_context}")
                        _extra_context = "\n\n".join(_extra_parts)
                        try:
                            _ws_answer, _ws_llm_usage = llm.answer(
                                message=req.message,
                                products=_final_products,
                                shop_hint=req.shop,
                                history=history,
                                persona_extra=_persona_extra,
                                intent_result=_intent_result,
                                extra_context=_extra_context,
                            )
                        except RuntimeError as exc:
                            print(f"[WEB-SEARCH] LLM re-answer error: {exc}", file=sys.stderr)
                            _ws_answer = ""
                            _ws_llm_usage = {"prompt": 0, "output": 0, "total": 0}
                    else:
                        _ws_answer = ""
                        _ws_llm_usage = {"prompt": 0, "output": 0, "total": 0}
                    _timing_breakdown["llm2"] = round(_time.time() - _llm2_start, 3)
                    # record Search step (openrouter gemini 2.5 flash: $0.30/M in, $2.50/M out)
                    _ws_t_in = _ws_usage.get("prompt", 0)
                    _ws_t_out = _ws_usage.get("output", 0)
                    _steps.append({
                        "name": "Search",
                        "model": _ws_result.get("model", "openrouter"),
                        "tokens_in": _ws_t_in,
                        "tokens_out": _ws_t_out,
                        "time_s": _ws_elapsed,
                        "cost_usd": round(_ws_cost, 6),
                        "cost_thb": round(_ws_cost * 36, 4),
                        "input": {
                            "message": req.message,
                            "reason": _search_reason,
                            "intent": _intent_result.get("intent"),
                        },
                        "output": {
                            "search_used": True,
                            "keywords": _ws_keywords[:8],
                            "product_type": _ws_product_type,
                            "search_info": _ws_search_info[:500] if _ws_search_info else "",
                        },
                    })
                    # record RAG (search) step — re-query DB ด้วย keywords จาก search
                    _final_product_names = [p.get("name", "")[:60] for p in _final_products[:10]]
                    _steps.append({
                        "name": "RAG(search)",
                        "model": "mongodb+kb",
                        "tokens_in": 0,
                        "tokens_out": 0,
                        "time_s": 0,
                        "cost_usd": 0,
                        "cost_thb": 0,
                        "input": {
                            "query": " ".join(_ws_keywords[:6]) if _ws_keywords else "",
                            "keywords": _ws_keywords[:8],
                            "shop": req.shop,
                        },
                        "output": {
                            "product_count": len(_final_products),
                            "products": _final_product_names,
                            "kb_used": bool(_ws_kb_context),
                        },
                    })
                    # record LLM2 (search) step — ตัวตอบ รอบที่ 2
                    _llm2_t_in = _ws_llm_usage.get("prompt", 0)
                    _llm2_t_out = _ws_llm_usage.get("output", 0)
                    _llm2_cost = (_llm2_t_in * _GEMINI_COST_PER_M["prompt"] + _llm2_t_out * _GEMINI_COST_PER_M["output"]) / 1_000_000
                    _steps.append({
                        "name": "LLM2(search)",
                        "model": model_name,
                        "tokens_in": _llm2_t_in,
                        "tokens_out": _llm2_t_out,
                        "time_s": _timing_breakdown["llm2"],
                        "cost_usd": round(_llm2_cost, 6),
                        "cost_thb": round(_llm2_cost * 36, 4),
                        "input": {
                            "message": req.message,
                            "product_count": len(_final_products),
                            "products": _final_product_names,
                            "intent": _intent_result.get("intent"),
                            "history_count": len(history) if history else 0,
                            "search_info_used": bool(_ws_search_info),
                            "kb_context_used": bool(_ws_kb_context),
                            "extra_context_length": len(_extra_context) if "_extra_context" in dir() and _extra_context else 0,
                        },
                        "output": {
                            "answer": _ws_answer[:500] if _ws_answer else "",
                            "answer_full_length": len(_ws_answer) if _ws_answer else 0,
                        },
                    })

                    if _ws_answer:
                        _ws_answer = _append_base_warranty(_ws_answer, desc_message)
                        _total_ws = round(_time.time() - _total_start, 2)
                        _timing_breakdown["web_search"] = _ws_elapsed
                        _timing_breakdown["total"] = _total_ws
                        _combined_usage = {
                            "prompt": usage_info.get("prompt", 0) + _ws_usage.get("prompt", 0) + _ws_llm_usage.get("prompt", 0),
                            "output": usage_info.get("output", 0) + _ws_usage.get("output", 0) + _ws_llm_usage.get("output", 0),
                            "total": usage_info.get("total", 0) + _ws_usage.get("total", 0) + _ws_llm_usage.get("total", 0),
                        }
                        print(f"[WEB-SEARCH] used web search answer  total={_total_ws}s  products={len(_final_products)}", file=sys.stderr)
                        _final_response_products = _final_products[:req.limit]
                        return ChatResponse(
                            answer=_ws_answer,
                            answer_segments=llm.split_segments(_ws_answer),
                            products=_final_response_products,
                            shop=req.shop,
                            model=_ws_result.get("model", "openrouter"),
                            source="product_store+web_search",
                            usage=_combined_usage,
                            elapsed=_total_ws,
                            cost=round(cost + _ws_cost, 6),
                            intent=_intent_result,
                            timing=_timing_breakdown,
                            steps=_steps,
                            web_search_used=True,
                            web_search_reason=_search_reason,
                            web_search_model=_ws_result.get("model"),
                            routing_decision=_routing("bot_reply", f"product_store+web_search: {_search_reason} → ค้นเพิ่มแล้วตอบ"),
                        )
                    else:
                        print(f"[WEB-SEARCH] skipped (no answer from LLM re-answer)", file=sys.stderr)
                else:
                    print(f"[WEB-SEARCH] skipped (error: {_ws_result.get('error')})", file=sys.stderr)

        return ChatResponse(
            answer=answer,
            answer_segments=llm.split_segments(answer),
            products=products_for_response,
            shop=req.shop,
            model=model_name,
            source="product_store",
            usage=usage_info,
            elapsed=round(_total_elapsed, 2),
            cost=round(cost, 6),
            intent=_intent_result,
            timing=_timing_breakdown,
            steps=_steps,
            routing_decision=_routing("bot_reply", "product_store: ค้นพบสินค้า → บอทตอบ"),
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
    # ถ้าเป็น duration question เฉพาะเจาะจง (เช่น "X รับประกันกี่ปี")
    # → แนบเงื่อนไขการรับประกันเบื้องต้นด้วย (ลูกค้าต้องรู้เงื่อนไข เช่น ถ่ายคลิปแกะกล่อง)
    # แต่ใช้รูปแบบสั้นกระชับ ไม่ใช่นโยบายเต็ม
    from . import warranty as _w_check
    if _w_check.detect_warranty_duration_question(message) and not _w_check.detect_claim_request(message):
        # แนบเงื่อนไขสั้นๆ ท้ายคำตอบ duration
        short_conditions = knowledge_base.get_base_warranty_text()
        if short_conditions and short_conditions.strip():
            # ตรวจซ้ำ
            if not any(marker in answer for marker in (
                "เงื่อนไขการรับประกันสินค้าเบื้องต้น",
                "กรุณาถ่ายวิดีโอขณะแกะกล่อง",
            )):
                return f"{answer}\n\n---\n**เงื่อนไขการรับประกันสินค้าเบื้องต้น**\n{short_conditions}"
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


# ---- Test Chat Sessions API ----
# เก็บประวัติแชทจากหน้า testchat ลง MongoDB collection "test_chat_sessions"

from pydantic import BaseModel as _BM, Field as _F
from datetime import datetime, timezone


class TestChatMessage(_BM):
    role: str = _F(..., description="user | model")
    text: str = _F(...)
    timestamp: str = _F(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # metadata สำหรับ bot response
    stats: dict[str, Any] = _F(default_factory=dict, description="source, timing, usage, cost, intent, steps, products")


class CreateSessionRequest(_BM):
    shop: str = _F("", description="ชื่อร้าน (optional — เลือกทีหลังได้)")
    title: str | None = _F(None, description="ชื่อ session (optional — auto from first message)")


class AddMessageRequest(_BM):
    session_id: str = _F(...)
    message: TestChatMessage


class UpdateSessionRequest(_BM):
    shop: str | None = _F(None, description="เปลี่ยนร้านของ session")
    title: str | None = _F(None, description="เปลี่ยนชื่อ session")


@app.get("/test-chat/sessions")
def list_test_chat_sessions(shop: str | None = None, limit: int = 50):
    """list sessions — ถ้ามี shop กรองเฉพาะร้านนั้น"""
    try:
        db = _admin_db()
        query = {"shop": shop} if shop else {}
        cursor = db["test_chat_sessions"].find(query).sort("updated_at", -1).limit(limit)
        sessions = []
        for doc in cursor:
            sessions.append({
                "id": str(doc["_id"]),
                "shop": doc.get("shop", ""),
                "title": doc.get("title", "ไม่มีชื่อ"),
                "message_count": len(doc.get("messages", [])),
                "created_at": doc.get("created_at"),
                "updated_at": doc.get("updated_at"),
            })
        return {"sessions": sessions}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/test-chat/sessions")
def create_test_chat_session(req: CreateSessionRequest, request: Request) -> dict:
    """สร้าง session ใหม่"""
    try:
        from bson import ObjectId
        db = _admin_db()
        now = datetime.now(timezone.utc)
        doc = {
            "shop": req.shop,
            "title": req.title or "แชทใหม่",
            "messages": [],
            "created_at": now,
            "updated_at": now,
        }
        result = db["test_chat_sessions"].insert_one(doc)
        session_id = str(result.inserted_id)
        _log_testchat_action("create_session", request, session_id, shop=req.shop, title=doc["title"])
        return {"id": session_id, "shop": req.shop, "title": doc["title"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/test-chat/sessions/{session_id}")
def get_test_chat_session(session_id: str) -> dict:
    """ดึง session พร้อม messages"""
    try:
        from bson import ObjectId
        db = _admin_db()
        doc = db["test_chat_sessions"].find_one({"_id": ObjectId(session_id)})
        if not doc:
            raise HTTPException(status_code=404, detail="session not found")
        # แปลง ObjectId → string
        doc["id"] = str(doc["_id"])
        del doc["_id"]
        # แปลง datetime → ISO string
        for k in ("created_at", "updated_at"):
            if k in doc and hasattr(doc[k], "isoformat"):
                doc[k] = doc[k].isoformat()
        return doc
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/test-chat/sessions/{session_id}/messages")
def add_test_chat_message(session_id: str, req: AddMessageRequest, request: Request) -> dict:
    """เพิ่ม message ลง session"""
    try:
        from bson import ObjectId
        db = _admin_db()
        now = datetime.now(timezone.utc)
        msg_doc = req.message.model_dump()
        result = db["test_chat_sessions"].update_one(
            {"_id": ObjectId(session_id)},
            {
                "$push": {"messages": msg_doc},
                "$set": {"updated_at": now},
            },
        )
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="session not found")
        # auto title from first user message
        if req.message.role == "user":
            doc = db["test_chat_sessions"].find_one({"_id": ObjectId(session_id)})
            if doc and doc.get("title", "แชทใหม่") == "แชทใหม่":
                title = req.message.text[:40] + ("..." if len(req.message.text) > 40 else "")
                db["test_chat_sessions"].update_one(
                    {"_id": ObjectId(session_id)},
                    {"$set": {"title": title}},
                )
        # ⚡ log การส่งข้อความ (เก็บเฉพาะ role + text preview)
        _log_testchat_action(
            "add_message", request, session_id,
            role=req.message.role,
            text_preview=req.message.text[:120],
            shop=(db["test_chat_sessions"].find_one({"_id": ObjectId(session_id)}) or {}).get("shop", ""),
        )
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/test-chat/sessions/{session_id}")
def delete_test_chat_session(session_id: str, request: Request) -> dict:
    """ลบ session"""
    try:
        from bson import ObjectId
        db = _admin_db()
        # เก็บ info ก่อนลบ เพื่อ log
        doc = db["test_chat_sessions"].find_one({"_id": ObjectId(session_id)})
        result = db["test_chat_sessions"].delete_one({"_id": ObjectId(session_id)})
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="session not found")
        _log_testchat_action(
            "delete_session", request, session_id,
            shop=(doc or {}).get("shop", ""),
            title=(doc or {}).get("title", ""),
            message_count=len((doc or {}).get("messages", [])),
        )
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/test-chat/sessions/{session_id}")
def update_test_chat_session(session_id: str, req: UpdateSessionRequest, request: Request) -> dict:
    """อัปเดต session (เช่น เปลี่ยนร้าน)"""
    try:
        from bson import ObjectId
        db = _admin_db()
        # เก็บค่าเดิมก่อนอัปเดต เพื่อ log
        old_doc = db["test_chat_sessions"].find_one({"_id": ObjectId(session_id)})
        old_shop = (old_doc or {}).get("shop", "")
        old_title = (old_doc or {}).get("title", "")
        update_fields: dict[str, Any] = {"updated_at": datetime.now(timezone.utc)}
        if req.shop is not None:
            update_fields["shop"] = req.shop
        if req.title is not None:
            update_fields["title"] = req.title
        result = db["test_chat_sessions"].update_one(
            {"_id": ObjectId(session_id)},
            {"$set": update_fields},
        )
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="session not found")
        _log_testchat_action(
            "update_session", request, session_id,
            old_shop=old_shop, new_shop=req.shop,
            old_title=old_title, new_title=req.title,
        )
        return {"ok": True, "shop": req.shop, "title": req.title}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class RateMessageRequest(_BM):
    star_rating: float | None = _F(None, description="ดาว 0-5")
    comment: str | None = _F(None, description="คอมเมนต์")
    rating: str | None = _F(None, description="better|worse|tie|unrated")


# ⚡ rate/stats ย้ายไป Next.js (admin mongo) แล้ว — ไม่ต้องยุ่งกับ Python


@app.get("/test-chat/logs")
def list_test_chat_logs(limit: int = 100, action: str | None = None):
    """ดู log การใช้งาน testchat — ใคร ทำอะไร แชทไหน เมื่อไหร่."""
    try:
        db = _admin_db()
        query: dict[str, Any] = {}
        if action:
            query["action"] = action
        cursor = db["test_chat_logs"].find(query).sort("timestamp", -1).limit(limit)
        logs = []
        for doc in cursor:
            doc["id"] = str(doc["_id"])
            del doc["_id"]
            if hasattr(doc.get("timestamp"), "isoformat"):
                doc["timestamp"] = doc["timestamp"].isoformat()
            logs.append(doc)
        return {"logs": logs, "count": len(logs)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/feedback")
def feedback(req: FeedbackRequest) -> dict[str, str]:
    """รับ feedback (thumbs up/down) จากลูกค้า.

    ตอนนี้แค่ log ไว้ ไม่เก็บ DB (สามารถเพิ่ม collection สำหรับเก็บได้ภายหลัง).
    """
    rating = req.rating if req.rating in ("up", "down", "clear") else "unknown"
    if rating != "clear":
        print(f"[FEEDBACK] rating={rating}  answer='{req.answer[:80]}...'")
    return {"status": "ok", "rating": rating}
