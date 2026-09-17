"""FastAPI app สำหรับแชทบอทสินค้า.

Endpoints:
- GET  /health        : ตรวจสุขภาพ + แสดงร้าน/หมวดทั้งหมด
- GET  /shops         : รายชื่อร้านในเครือ
- GET  /categories    : รายชื่อหมวดหมู่
- POST /chat          : รับ {shop, message, history?} -> {answer, products}
"""

from __future__ import annotations

import json
import os
import re
import sys
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

from . import llm, product_store, knowledge_base, persona, conversation_products, test_chat_api, device_compat
from .responses import _routing, _send_handoff

app = FastAPI(
    title="ChatBotProductMS",
    description="แชทบอทตอบคำถาม/เปรียบเทียบ/แนะนำสินค้า และเรื่องเคลม-รับประกัน ของร้านในเครือ",
    version="0.1.0",
)

_STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")
app.include_router(test_chat_api.router)


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
    # If no secret is configured (dev), allow but warn loudly
    # 🔒 Security: previously this silently allowed all requests when no secret
    # was set. We still allow in dev for convenience, but log a prominent warning.
    if not _INTERNAL_SECRET:
        print("[SECURITY WARNING] CHATBOT_INTERNAL_SECRET not set — all requests allowed (dev mode only!)", file=sys.stderr)
        return await call_next(request)
    provided = request.headers.get("X-Internal-Secret", "").strip()
    # 🔒 Use constant-time compare to prevent timing side-channel (M2)
    import hmac as _hmac
    if not _hmac.compare_digest(provided, _INTERNAL_SECRET):
        return JSONResponse(
            status_code=401,
            content={"detail": "missing or invalid internal secret"},
        )
    return await call_next(request)


@app.on_event("startup")
def _warmup():
    """Pre-warm caches ตอน startup เพื่อลด cold start latency."""
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
    # ⚡ multimodal — URL รูปที่ลูกค้าส่งใน message นี้ (ถ้ามี)
    images: list[str] = Field(default_factory=list, description="URL รูปภาพใน message นี้ (ถ้ามี)")
    # ⚡ multimodal — description ที่สกัดจากรูปใน message นี้ (ถ้ามี — ส่งกลับจาก turn ก่อนหน้า)
    #    ถ้ามี field นี้ → vision pass จะใช้ desc เดิม ไม่อ่านรูปซ้ำ (ประหยัด token + latency)
    image_desc: str = Field("", description="text description ที่สกัดจากรูปใน message นี้ (cache จาก turn ก่อนหน้า)")


class ChatRequest(BaseModel):
    message: str = Field(..., description="คำถาม/ข้อความลูกค้ารอบปัจจุบัน")
    shop: str | None = Field(None, description="ชื่อร้านที่ลูกค้าทักเข้ามา (ถ้ามี) เช่น IMILabThailand")
    item_id: str | int | None = Field(
        None,
        description="item_id ของสินค้าที่ลูกค้าอ้างถึง (เช่น แชร์การ์ดสินค้ามาในแชท) "
                    "ถ้าระบุ จะตอบจากสินค้านี้โดยตรง แม่นยำกว่าการค้นด้วยข้อความ",
    )
    # ⚡ Phase 3C — order_sn จาก order card ที่ลูกค้าส่งมา (เหมือน item_id แต่สำหรับ order)
    #    ถ้าระบุ จะใช้ order_sn นี้โดยตรง ไม่ต้อง extract จาก message
    order_sn: str | None = Field(
        None,
        description="order_sn ของคำสั่งซื้อที่ลูกค้าอ้างถึง (เช่น ส่งการ์ดคำสั่งซื้อมาในแชท) "
                    "ถ้าระบุ จะใช้เป็น order_sn หลัก ไม่ต้อง extract จาก message",
    )
    history: list[ChatMessage] = Field(default_factory=list, description="ประวัติแชทก่อนหน้า")
    limit: int = Field(10, ge=1, le=50, description="จำนวนสินค้าสูงสุดที่จะส่งเป็น context")
    # ⚡ multimodal — URL รูปที่ลูกค้าส่งใน message ปัจจุบัน (สูงสุด 3 รูป/turn)
    images: list[str] = Field(default_factory=list, description="URL รูปภาพที่ลูกค้าส่งใน turn นี้ (สูงสุด 3 รูป)")
    # ── Warranty claim handoff ──
    # conversation_id ของแชทในระบบ admin (ถ้ามี) — ใช้ตอนบอทส่งต่อแอดมิน
    conversation_id: str | None = Field(None, description="conversation_id ในระบบ admin (สำหรับ handoff)")
    platform: str | None = Field(None, description="platform ของแชท (shopee/tiktok/lazada) — สำหรับ handoff")
    # ⚡ simulate mode — จำลองการจ่ายงานโดยไม่กระทบ conversations จริง (ใช้ใน test chat)
    simulate_assignment: bool = Field(False, description="ถ้า true → handoff จะเก็บลง test_chat_sessions ไม่ใช่ conversations")
    # ⚡ Phase 2A — state-driven handoff: สถานะ ticket จาก DB (open|closed|handoff|...)
    #    ถ้า "closed" → บอทตอบปกติ (ข้าม post-handoff lock)
    #    ถ้า "handoff"/"open" + มี handoff marker → ล็อค (ยกเว้น exceptions ใน KB)
    #    ถ้า None → fallback ใช้ history scan แบบเดิม (backward compat)
    ticket_state: str | None = Field(None, description="สถานะ ticket จาก DB: open|closed|handoff|resolved|pending (None = ไม่ทราบ ใช้ history scan)")
    # ⚡ per-request chat_v2 override — shadowbot/replay ส่ง use_v2=true เพื่อทดสอบ chat_v2
    #    โดยไม่กระทบ traffic จริง (ที่ยังใช้ legacy ตาม USE_LEGACY_CHAT env)
    use_v2: bool | None = Field(None, description="ถ้า true → บังคับใช้ chat_v2 แม้ USE_LEGACY_CHAT=1 (สำหรับ shadowbot/replay)")
    # ⚡ chatbotv3 — OpenRouter-first paradigm (2026-09-20)
    #   ส่ง raw context ให้ OpenRouter ตอบ → match สินค้ากับ ShpProducts
    #   เปิดใช้ผ่าน env USE_CHAT_V3=1 หรือ per-request req.use_v3=True
    #   ไม่กระทบ legacy/v2 (default ยังใช้ legacy/v2 ตาม USE_LEGACY_CHAT)
    use_v3: bool | None = Field(None, description="ถ้า true → บังคับใช้ chatbotv3 (สำหรับ shadowbot/replay โดยไม่กระทบ traffic จริง)")
    # ⚡ Phase 8 — LLM context limit (จำนวนสินค้าสูงสุดที่ส่งเข้า LLM เป็น context)
    #    แยกจาก limit (frontend display) — ปรับได้จากหน้า config (default 30, range 10-50)
    #    ถ้า None → ใช้ _LLM_CONTEXT_LIMIT (30) ตาม default
    llm_context_limit: int | None = Field(None, ge=10, le=50, description="จำนวนสินค้าสูงสุดที่ส่งเป็น LLM context (แยกจาก frontend display limit)")


class ChatResponse(BaseModel):
    answer: str
    products: list[dict[str, Any]]
    shop: str | None
    model: str
    source: str = Field("product_store", description="knowledge_base | product_store")
    # ⚡ chat_engine — บันทึกว่าคำตอบนี้ใช้ engine ไหน (legacy / v2)
    chat_engine: str = Field("legacy", description="legacy | v2 — engine ที่ตอบคำถามนี้")
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
    # ⚡ Phase 1A multimodal — description ที่สกัดจากรูปใน turn นี้
    #    caller (Next.js) เก็บไว้ใน message doc เพื่อส่งกลับใน history ของ turn ถัดไป
    #    ทำให้ turn ถัดไปไม่ต้องอ่านรูปซ้ำ (ประหยัด token + latency)
    image_desc: str = Field("", description="text description ที่สกัดจากรูปใน turn นี้ (ส่งกลับให้ caller เก็บใน message doc)")
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

    # ⚡ Task 9 — output guard: flag คำตอบที่ยืนยันเคลม/คืนเงิน/จัดส่งโดยไม่มี handoff
    #   จุดเดียวครอบทุก return path; log เท่านั้น ไม่แก้คำตอบ (observability ก่อน)
    def model_post_init(self, __context) -> None:
        try:
            from . import guards as _guards
            _v = _guards.check_output(self.answer, handoff_sent=self.handoff_to_admin)
            if _v:
                print(f"[GUARD] violations={_v} answer={self.answer[:120]!r}", file=sys.stderr)
        except Exception:
            pass


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


def _get_post_handoff_exceptions(shop: str | None, platform: str | None) -> list[str]:
    """⚡ Phase 2A — ดึง post_handoff_exceptions จาก shop_settings ใน admin DB.

    แอดมินตั้งได้ต่อร้าน — รายการ keywords ที่บอทยังตอบได้หลัง handoff (ก่อนปิดแชท)
    เช่น ["ทวนข้อมูลเคลม", "ส่งลิงก์กรอกฟอร์ม", "เปลี่ยนเบอร์", "แก้ที่อยู่"]

    ถ้า message match exception → บอทตอบปกติ ไม่ล็อค post-handoff
    ถ้าไม่พบร้านหรือไม่มี field → คืน [] (ไม่มี exception)
    """
    if not shop:
        return []
    try:
        db = conversation_products._admin_db()
        # shop_settings เก็บด้วย shopname + platform
        _plat = platform or "shopee"
        doc = db["shop_settings"].find_one({
            "shopname": shop,
            "platform": _plat,
            "is_deleted": {"$ne": True},
        })
        exceptions = (doc or {}).get("post_handoff_exceptions") or []
        if isinstance(exceptions, list):
            return [str(e) for e in exceptions if e]
        return []
    except Exception as _e:
        print(f"[POST-HANDOFF-EXCEPTIONS] error: {_e}", file=sys.stderr)
        return []


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

# ⚡ Phase 8 — LLM context limit (แยกจาก frontend display limit = req.limit)
#   สินค้าที่ส่งเข้า llm.answer() เป็น context ใช้ limit นี้ (30) ไม่ใช่ req.limit (10)
#   frontend display ยังใช้ req.limit ตามเดิม (products[:req.limit] ใน ChatResponse)
#   เพิ่มจาก 10 → 30 เพื่อให้ LLM เห็นสินค้าเยอะพอที่จะเลือกแนะนำได้แม่นยำขึ้น
_LLM_CONTEXT_LIMIT = 30


def _extract_item_id_tag(text: str) -> str | None:
    """ดึง item_id จาก tag ที่แนบมาในข้อความ (เช่น '[สินค้า: 43360743407]')."""
    m = _ITEM_TAG_RE.search(text or "")
    return m.group(1) if m else None


# ⚡ keyword ที่บ่ง new topic (ใช้ร่วมกัน item_tag block + carry-forward block)
#   ⚠️ อย่าเอา "สอบถาม" กลับเข้ามา — ใช้ได้ทั้งคำถามใหม่และต่อเนื่อง
_NEW_TOPIC_KWS = ("สวัสดี", "หวัดดี", "hi", "hello", "แนะนำ", "มีอะไร", "มีไร",
                  "สนใจ", "อยากได้", "หาสินค้า", "ดูสินค้า")

# คำถาม "ชุดสินค้า" — เปรียบเทียบ/superlative อ้างหลายชิ้น ไม่ใช่ anchor เดี่ยว
#   ใช้ร่วมกัน: ITEM-TAG shortcut bypass (~895) + FOLLOWUP-COMP trigger (~1244)
_COMPARISON_FOLLOWUP_KW = ("ต่างกัน", "ต่างยังไง", "ต่างไหม", "เปรียบเทียบ", "เทียบ", "เทียบกัน",
                           "แนะนำตัวไหนดี", "ตัวไหนดีกว่า", "อันไหนดีกว่า", "ซื้อตัวไหนดี",
                           "เลือกตัวไหนดี", "ตัวไหนน่าซื้อ", "อันไหนน่าซื้อ",
                           # คำเปรียบเทียบโดยนัย — "อันไหนใหม่กว่า/ถูกกว่า/ล่าสุด"
                           "ใหม่กว่า", "ถูกกว่า", "ล่าสุด")
_SUPERLATIVE_KW = ("สุด", "ที่สุด", "แรงสุด", "ไวสุด", "เร็วสุด", "มากสุด", "น้อยสุด",
                   "แรงที่สุด", "ไวที่สุด", "เร็วที่สุด", "มากที่สุด", "น้อยที่สุด",
                   "เบาสุด", "จุมากสุด", "คุ้มสุด", "คุ้มที่สุด",
                   "กว่านี้", "เร็วกว่า", "แรงกว่า", "ไวกว่า", "ดีกว่า", "มากกว่า",
                   "ไวๆ", "เร็วๆ", "แรงๆ", "ชาร์จไว", "ชาร์จเร็ว")
# คำอ้าง "ชิ้นเดียว" (deictic) — ถ้ามี = ถามเกี่ยวกับ anchor ไม่ใช่เทียบชุด
#   กัน false positive ของ _SUPERLATIVE_KW เช่น "ตัวนี้ชาร์จเร็วไหม" (ไม่ใช่ set question)
_SINGLE_ITEM_REF_KW = ("ตัวนี้", "รุ่นนี้", "อันนี้", "ชิ้นนี้", "สินค้านี้", "เรือนนี้")


def _add_context_note(products: list, note: str) -> None:
    """append note ลง products[0]['_context_note'] (คั่นด้วย space ถ้ามีอยู่แล้ว)."""
    if not products:
        return
    if "_context_note" not in products[0]:
        products[0]["_context_note"] = note
    else:
        products[0]["_context_note"] = products[0]["_context_note"] + " " + note


def _recent_qa_pairs(history: list[dict] | None, n: int = 10) -> list[dict]:
    """⚡ Phase 8 — จับคู่ user+model message เป็น QA pairs แล้วคืน n คู่ล่าสุด.

    ใช้แทน history[切片] ตอนส่งเข้า llm.answer() / follow-up detection
    เพื่อให้ "10 คู่" หมายถึง 10 Q+A (20 messages) ไม่ใช่ 10 messages เดี่ยว

    Args:
        history: list ของ {"role":"user"|"model", "text":"...", ...}
        n: จำนวน QA pairs สูงสุด (default 10)

    Returns:
        list ของ messages เรียงเก่า→ใหม่ (พร้อมส่งเข้า LLM contents ได้เลย)
        ประกอบด้วย n คู่ล่าสุด (อย่างมาก 2n messages)

    Edge cases:
        - history ว่าง → []
        - role ไม่ครบคู่ (เช่น 2 user ติดกันจาก buffer_flush)
          → user ที่ไม่มี model ตามหลัง จะถูกคืนเป็นคู่เดี่ยว (user only)
          เพื่อกัน context loss (ดีกว่าตัดทิ้ง)
        - คู่สุดท้ายมี model แต่ไม่มี user ก่อนหน้า → คืน model เดี่ยว
    """
    if not history:
        return []
    # จับคู่: walk จากท้าย → ถ้าเจอ model หลัง user → คู่; ถ้า user ติดกัน → user เดี่ยว
    _pairs: list[list[dict]] = []
    _i = len(history) - 1
    while _i >= 0:
        _h = history[_i]
        _role = _h.get("role", "user")
        if _role == "model":
            # หา user ก่อนหน้า
            if _i - 1 >= 0 and history[_i - 1].get("role", "user") == "user":
                _pairs.append([history[_i - 1], _h])
                _i -= 2
            else:
                # model เดี่ยว (ไม่มี user ก่อนหน้า) → คืนเป็นคู่เดี่ยว
                _pairs.append([_h])
                _i -= 1
        else:
            # user เดี่ยว (ไม่มี model ตามหลัง หรือเป็นคู่สุดท้ายที่ยังไม่ตอบ)
            _pairs.append([_h])
            _i -= 1
        if len(_pairs) >= n:
            break
    # เรียงกลับเป็นเก่า→ใหม่ แล้ว flatten
    _pairs = list(reversed(_pairs))
    _flat: list[dict] = []
    for _pair in _pairs:
        _flat.extend(_pair)
    return _flat


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    # ⚡ chatbotv3 — OpenRouter-first paradigm (2026-09-20)
    #   USE_CHAT_V3=1 หรือ req.use_v3=True → route ไป chatbotv3.engine.chat_v3
    #   ไม่กระทบ legacy/v2 (default ยังใช้ legacy/v2 ตาม USE_LEGACY_CHAT)
    if req.use_v3 or os.environ.get("USE_CHAT_V3", "0") == "1":
        from . import chatbotv3
        _resp = chatbotv3.chat_v3(req)
        _resp["chat_engine"] = "v3"  # ⚡ บันทึกว่าใช้ chatbotv3
        return ChatResponse(**_resp)
    # ⚡ chat_v2 — pipeline ใหม่ สลับด้วย env var หรือ per-request flag
    #   USE_LEGACY_CHAT=1 (default) → legacy chat()
    #   USE_LEGACY_CHAT=0          → chat_v2 ทั้งหมด
    #   req.use_v2=True            → บังคับ chat_v2 (สำหรับ shadowbot/replay โดยไม่กระทบ traffic จริง)
    if req.use_v2 or os.environ.get("USE_LEGACY_CHAT", "1") != "1":
        from . import chat_v2
        _resp = chat_v2.chat_v2(req)
        _resp["chat_engine"] = "v2"  # ⚡ บันทึกว่าใช้ chat_v2
        return ChatResponse(**_resp)
    import time as _time
    _total_start = _time.time()
    _timing_breakdown: dict[str, float] = {}  # pass1, retrieval, llm, total
    _steps: list[dict[str, Any]] = []  # per-step breakdown for log panel
    model_name = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")

    # ⚡ QA-replay-fix (2026-09-08) — ประกาศ default ที่ function scope กัน UnboundLocalError
    #   _intent_sub เดิมประกาศใน nested block (fetch path ~4154) / _is_conv_active ใน CONV-ACTIVE block (~3109)
    #   path ที่ข้าม block เหล่านั้น (เช่น CONV-ACTIVE ใช้ active product แล้ว jump,
    #   หรือ [item] เปล่า fall through มาถึง NO-PRODUCT-GUARD ตอน products มีค่า)
    #   → ตัวแปร unbound → 500 (พบตอน replay QA 12 แชท: nt_sumittra Q2 / aroranuch Q1,Q11 ฯลฯ)
    _intent_sub: str | None = None
    _is_conv_active = False

    # ⚡ Phase 8 — resolve effective LLM context limit (per-request from admin config)
    #   ถ้า req.llm_context_limit ส่งมา → ใช้ค่านั้น (range 10-50)
    #   ถ้าไม่ส่ง → ใช้ _LLM_CONTEXT_LIMIT (30) ตาม default
    _llm_ctx_limit = req.llm_context_limit or _LLM_CONTEXT_LIMIT

    # ⚡ Charger Subtype Consolidation (2026-09-16) — resolve subtype ด้วย priority ชัดเจนจุดเดียว
    #   แทนที่การเรียก _detect_charger_subtype กระจาย 22 จุดด้วย argument ต่างกัน
    #   Priority: anchor > msg-strong > intent > msg > retrieval
    #   กรณีพิเศษ: ลูกค้าถามไม่ระบุ subtype ชัด + มี anchor → ใช้ anchor subtype
    #   เว้นแต่ msg จะพูดถึง subtype อื่นชัดเจน (strong keyword) → override
    #   ⚠️ ใช้ closure: req, _hybrid_anchor_card (ประกาศที่ ~927)
    #   ⚠️ ต้องประกาศก่อน KB branch (~2908) และ product_store branch (~4641)
    #   Strong keyword = keyword ใน _CHARGER_SUBTYPES (ไม่ใช่ "หัว"/"สาย" ลอยๆ)
    _STRONG_SUBTYPE_KWS: dict[str, tuple[str, ...]] = {
        "adapter": ("หัวชาร์จ", "หัวชาร์ต", "adapter", "แอ็ดอปเตอร์", "gan",
                    "qc 3", "qc3", "pd fast", "pd3"),
        "cable": ("สายชาร์จ", "สายชาร์ต", "cable", "คาเบิล",
                  "สาย usb", "สาย type", "สาย micro", "สาย lightning",
                  "สาย c", "สาย pd", "lightning", "ไลนิ่ง", "ไลนิง"),
    }

    def _resolve_charger_subtype(
        *,
        intent_result: dict | None = None,
        retrieval_message: str = "",
        anchor_card: dict | None = None,
        msg: str | None = None,
    ) -> str | None:
        """Resolve charger subtype ด้วย priority ชัดเจน.

        Priority (ตามที่ตกลง):
        1. anchor subtype (default) — ใช้เมื่อ msg ไม่ได้ระบุ subtype อื่นชัดเจน
        2. msg strong keyword (override) — เฉพาะเมื่อ msg มี strong keyword ชัดเจน
           ที่ต่างจาก anchor (เช่น anchor=cable แต่ msg พูด "หัวชาร์จ" → adapter)
        3. intent subtype — เมื่อไม่มี anchor และ msg ไม่มี keyword ชัด
        4. msg subtype (non-strong) — เมื่อไม่มี anchor และไม่มี intent
        5. retrieval fallback — ใช้ retrieval_message แทน

        ⚡ กรณีพิเศษ: ลูกค้าถามแบบไม่ระบุ subtype ชัดเจน (เช่น "อยากได้ของที่ใช้กับ...")
        แต่ history มีการแชร์สินค้ามาก่อน → ใช้ subtype ของสินค้าที่แชร์เป็นค่าตั้งต้น
        เว้นแต่ msg จะพูดถึง subtype อื่นชัดเจน (strong keyword)
        """
        _msg = msg or req.message or ""

        # 1. ดึง anchor subtype (anchor_card parameter > _hybrid_anchor_card closure)
        _anchor = anchor_card or _hybrid_anchor_card
        _anchor_sub: str | None = None
        if _anchor:
            _anchor_sub = product_store._detect_charger_subtype(
                _anchor.get("name") or _anchor.get("item_name") or ""
            )

        # 2. ดึง msg subtype
        _msg_sub: str | None = product_store._detect_charger_subtype(_msg)

        # 3. ถ้ามี anchor:
        if _anchor_sub:
            # ถ้า msg มี subtype ต่างจาก anchor → เช็คว่าเป็น strong keyword หรือไม่
            if _msg_sub and _msg_sub != _anchor_sub:
                _strong_kws = _STRONG_SUBTYPE_KWS.get(_msg_sub, ())
                # แก้ typo สั้นๆ (เหมือน _detect_charger_subtype)
                _low_check = _msg.lower()
                for _wrong, _right in (
                    ("หัวชาจ", "หัวชาร์จ"), ("หัวชารจ", "หัวชาร์จ"),
                    ("หัวชาจะ", "หัวชาร์จ"),
                    ("สายชาจ", "สายชาร์จ"), ("สายชารจ", "สายชาร์จ"),
                ):
                    _low_check = _low_check.replace(_wrong, _right)
                if "หัวชาร" in _low_check and "หัวชาร์จ" not in _low_check:
                    _low_check = _low_check.replace("หัวชาร", "หัวชาร์จ")
                _has_strong = any(kw in _low_check for kw in _strong_kws)
                if _has_strong:
                    return _msg_sub  # override anchor ด้วย strong keyword
            # ไม่มี strong keyword ต่างจาก anchor → ใช้ anchor
            return _anchor_sub

        # 4. ไม่มี anchor → intent
        if intent_result and intent_result.get("product_type") == "charger":
            _intent_sub_val = intent_result.get("charger_subtype")
            if _intent_sub_val in ("adapter", "cable", "set", "car_charger",
                                   "wireless", "desktop", "socket"):
                return _intent_sub_val

        # 5. ไม่มี anchor, ไม่มี intent → msg (แม้ไม่ใช่ strong keyword)
        if _msg_sub:
            return _msg_sub

        # 6. Fallback → retrieval
        if retrieval_message and retrieval_message != _msg:
            _retr_sub = product_store._detect_charger_subtype(retrieval_message)
            if _retr_sub:
                return _retr_sub

        return None

    # ⚡ Legacy Fix (2026-09-15) — unified web search reanswer
    #   รวม logic ของ KB+Mongo branch + product_store branch ที่ copy กันอยู่

    client, db = _db()
    try:
        history = [{"role": m.role, "text": m.text, "images": m.images, "image_desc": m.image_desc} for m in req.history]
        _qa10 = _recent_qa_pairs(history, 10)

        # ⚡ record history step (input context ที่ส่งเข้ามา)
        _steps.append({
            "name": "history",
            "model": None,
            "tokens_in": 0,
            "tokens_out": 0,
            "time_s": 0,
            "cost_usd": 0,
            "cost_thb": 0,
            "input": {
                "history_count": len(history),
                "history_preview": [
                    {"role": h.get("role"), "text": (h.get("text") or "")[:120], "has_images": bool(h.get("images")), "has_image_desc": bool(h.get("image_desc"))}
                    for h in history[-10:]
                ],
            },
            "output": None,
        })

        # ===== ดึง persona ของร้าน (Phase 3 — admin ตั้งชื่อตัวแทนบอทในหน้า /persona) =====
        # ถ้าร้านยังไม่ได้ตั้ง persona → persona_extra = "" → ใช้ SYSTEM_INSTRUCTION เดิม (default behavior)
        # บุคลิกหลัก (ค่ะ/นะคะ/ผู้หญิง) เหมือนกันทุกร้าน — persona แค่เพิ่มชื่อตัวแทนของร้านนั้น
        _persona_doc = persona.get_persona(req.shop, platform="shopee")
        _persona_extra = persona.build_persona_instruction(_persona_doc, req.shop)
        # ⚡ BUG-9 fix — ดึง bot_name จาก persona ของร้าน (ถ้าไม่มี persona → ใช้ "เรา")
        #   ใช้ใน warranty flow ที่เป็น deterministic f-string (ไม่ผ่าน LLM)
        #   ก่อนหน้านี้ hardcode "abubu" → หลุดข้ามร้าน (Kospet/อีกร้าน ก็ได้ abubu)
        _bot_name = ((_persona_doc or {}).get("bot_name") or "ทางร้าน").strip() or "ทางร้าน"

        # ===== Phase 2 (ลบแล้ว) — เคยใช้ random variation pool แต่ทำให้คำตอบงง/ไม่เป็นธรรมชาติ =====
        # ตอนนี้ใช้แค่ persona_extra (ถ้ามี) + SYSTEM_INSTRUCTION อย่างเดียว
        # การตอบเป็นธรรมชาติอยู่ที่ temperature 0.3 + กฎ multi-bubble ใน SYSTEM_INSTRUCTION

        # ===== Multimodal Vision Pass (Phase 1A) =====
        # ⚡ ถ้าลูกค้าส่งรูปภาพมา (req.images ไม่ว่าง) → ใช้ Gemini vision อ่านรูป
        #    ได้ text description → เก็บไว้ใน _vision_context เพื่อส่งเป็น context ให้ LLM หลัก
        #    ทำงานแบบ 2-pass: vision (gemini-3.1-flash-lite) → answer (gemini-3.5-flash-lite)
        #    ถ้า req.images ว่าง → _vision_context = "" (ไม่กระทบ flow เดิม)
        # ⚡ รวมรูปจาก history ล่าสุดด้วย — ลูกค้าอาจส่งรูปสินค้าเสียใน turn ก่อนหน้า
        #    แล้วถามต่อใน turn ปัจจุบัน (โดยเฉพาะ claim flow)
        # ⚡ ถ้า history message มี image_desc อยู่แล้ว (สกัดจาก turn ก่อนหน้า) → ใช้เลย ไม่อ่านซ้ำ
        #    ประหยัด token + latency + คงความสม่ำเสมอของ description
        # ⚡ ส่ง history_context ให้ vision ด้วย — ช่วยให้เข้าใจบริบทก่อนหน้ารูป
        #    เช่น ลูกค้าคุยเรื่องเคลมอยู่ → vision รู้ว่ารูปนี้น่าจะเป็นสินค้าเสีย
        _vision_context = ""
        _vision_usage = {"prompt": 0, "output": 0, "total": 0}
        _vision_desc_parts: list[str] = []  # description รวมจากทุกรูป
        _image_desc_out = ""  # description ใหม่ที่สกัดใน turn นี้ (ส่งกลับใน ChatResponse)

        # 1) รูปจาก history ที่มี image_desc อยู่แล้ว → ใช้เลย (ไม่อ่านซ้ำ)
        _history_ctx_for_vision = ""  # text สรุป history ส่งให้ vision
        if history:
            _hist_lines = []
            for h in history[-6:]:  # สรุป history 6 ล่าสุด ส่งให้ vision เข้าใจบริบท
                _h_role = "ลูกค้า" if h.get("role") == "user" else "บอท"
                _h_text = h.get("text", "")[:100]
                if _h_text:
                    _hist_lines.append(f"{_h_role}: {_h_text}")
                # ถ้า history message มี image_desc → ใช้เลย
                _h_desc = h.get("image_desc", "")
                if _h_desc:
                    _vision_desc_parts.append(f"[รูปเก่าจาก history] {_h_desc}")
            _history_ctx_for_vision = "\n".join(_hist_lines)

        # 2) รูปจาก history ที่ยังไม่มี image_desc → ต้องอ่านใหม่
        _urls_to_read: list[str] = []
        if history:
            for h in history[-2:]:
                _h_imgs = h.get("images") or []
                _h_desc = h.get("image_desc") or ""
                if _h_imgs and not _h_desc:
                    _urls_to_read.extend(_h_imgs)
                # ถ้ามี image_desc อยู่แล้ว → ไม่ต้องอ่านรูปซ้ำ (ใช้ desc เดิม)

        # 3) รูปจาก turn ปัจจุบัน → ต้องอ่านใหม่เสมอ
        _urls_to_read.extend(req.images or [])
        # ⚡ detect Shopee image URLs ใน text message — ลูกค้าอาจพิมพ์ URL รูปตรงๆ
        #   เช่น "https://img.sp.mms.shopee.sg/..." หรือ "https://cf.shopee.co.th/file/..."
        #   ถ้าไม่ detect → URL ไปเป็น text ธรรมดา → บอทไม่อ่านรูป
        if req.message and not (req.images or []):
            _shopee_img_pattern = re.compile(
                r'https?://(?:img\.sp\.mms\.shopee\.(?:sg|th|vn|my|ph|id)'
                r'|cf\.shopee\.(?:co\.th|sg|vn|my|ph|id|com)'
                r'|down-(?:sg|th|vn)\.sp\.mms\.shopee\.(?:sg|th|vn))'
                r'/[^\s<>"\']+',
                re.IGNORECASE,
            )
            _text_img_urls = _shopee_img_pattern.findall(req.message)
            if _text_img_urls:
                # dedup + limit
                _seen_urls = set(_urls_to_read)
                for _u in _text_img_urls[:5]:
                    if _u not in _seen_urls:
                        _urls_to_read.append(_u)
                        _seen_urls.add(_u)
                print(f"[VISION-TEXT-URL] พบ image URL ใน text: {len(_text_img_urls)} รูป → ส่ง vision", file=sys.stderr)
        print(f"[VISION-DBG] req.images={req.images} history_imgs={[h.get('images') for h in (history or [])[-2:]]} urls_to_read={_urls_to_read}", file=sys.stderr)

        if _urls_to_read:
            try:
                from . import llm as _llm_vision
                # ⚡ Phase 1F — max_images อ่านจาก env (default 5) ไม่ใช่ fixed 3
                #    ปรับได้จาก BOT_MAX_IMAGES_PER_TURN env var
                _max_imgs = int(os.environ.get("BOT_MAX_IMAGES_PER_TURN", "5"))
                _new_desc, _vision_usage = _llm_vision.describe_images(
                    _urls_to_read,
                    shop_hint=req.shop,
                    max_images=_max_imgs,
                    history_context=_history_ctx_for_vision,
                )
                if _new_desc:
                    _vision_desc_parts.append(_new_desc)
                    print(f"[VISION-PASS] {len(_urls_to_read)} รูปใหม่ → {_new_desc[:100]!r}", file=sys.stderr)
            except Exception as _ve:
                print(f"[VISION-PASS] error: {_ve}", file=sys.stderr)

        # รวม description ทั้งหมด (เก่า + ใหม่) เป็น _vision_context
        if _vision_desc_parts:
            _all_desc = "\n".join(_vision_desc_parts)
            _vision_context = (
                f"=== รูปภาพที่ลูกค้าส่งมา ===\n{_all_desc}\n"
                f"⚠️ สำคัญ: ลูกค้าส่งรูปนี้มาเพราะสนใจสินค้า/เรื่องในรูป "
                f"ถ้ารูปเป็นสินค้า → ตอบเกี่ยวกับสินค้านั้น (ถ้าร้านมีให้แนะนำ, ถ้าไม่มีให้บอกว่าไม่มี) "
                f"ถ้ารูปเป็นเลขพัสดุ/สถานะการจัดส่ง → ตอบเกี่ยวกับสถานะ "
                f"ถ้ารูปเป็นสินค้าเสีย **และลูกค้าบอกชัดว่าเคลม/สินค้าเสีย/ซ่อม** → ถามรายละเอียดเพิ่มเพื่อเคลม "
                f"ถ้ารูปเป็นสินค้าปกติ (ไม่มีอาการเสีย) → แนะนำขายปกติ ห้ามตีว่าเป็น claim "
                f"ถ้ารูปไม่เกี่ยวกับสินค้า → ตอบเป็นมิตรแล้วเชื่อมกับสินค้าในร้าน "
                f"⚠️ ห้ามตีว่ารูปเป็น 'สินค้าเสีย' หรือ 'claim warranty' ถ้าลูกค้าไม่ได้พิมพ์บอกว่าเคลม/สินค้าเสีย/ซ่อม "
                f"การส่งรูปเฉยๆ ไม่ใช่การขอเคลม — ต้องตอบตามบริบทรูปปกติ\n"
            )
            # เก็บเฉพาะ description ใหม่ (ไม่รวม history desc) ส่งกลับให้ caller
            _image_desc_out = _new_desc if _urls_to_read and _new_desc else ""
            if not _urls_to_read:
                print(f"[VISION-PASS] ใช้ image_desc จาก history ({len(_vision_desc_parts)} desc) → {_all_desc[:80]!r}", file=sys.stderr)

        # ⚡ record vision step (input/output ครบ)
        _vision_model = os.environ.get("GEMINI_VISION_MODEL", "gemini-3.1-flash-lite")
        _vision_prompt_t = _vision_usage.get("prompt", 0)
        _vision_output_t = _vision_usage.get("output", 0)
        _vision_cost = (_vision_prompt_t * 0.25 + _vision_output_t * 0.50) / 1_000_000
        _steps.append({
            "name": "vision",
            "model": _vision_model if _urls_to_read else None,
            "tokens_in": _vision_prompt_t,
            "tokens_out": _vision_output_t,
            "time_s": round(_timing_breakdown.get("vision", 0), 2),
            "cost_usd": round(_vision_cost, 6),
            "cost_thb": round(_vision_cost * 36, 2),
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

        # ===== ขั้นที่ -1: ลูกค้าแชร์การ์ดสินค้ามาในแชท (มี item_id ชัดเจน) =====
        # กรณีนี้ตอบจากสินค้านั้นโดยตรง แม่นยำกว่าการค้นด้วยข้อความมาก
        # รองรับ 3 ทาง: (1) req.item_id ที่ระบบส่งมาเป็น field ตรง ๆ
        #              (2) tag ฝังอยู่ในข้อความปัจจุบัน เช่น "🛍️ [สินค้า: 43360743407]"
        #              (3) tag เคยปรากฏใน history (ลูกค้าแชร์การ์ดไว้ก่อนหน้า แล้วถามต่อ
        #                  เช่น "โหลดแอปอื่นมาดูได้ไหม") — ใช้เป็น anchor ต่อ ถ้าคำถามปัจจุบัน
        #                  ไม่ได้เอ่ยถึงรุ่น/แบรนด์อื่นที่ชัดเจน (ไม่ใช่การเปลี่ยนหัวข้อ)
        _tagged_item_id = req.item_id or _extract_item_id_tag(req.message)
        _is_from_history_anchor = False
        _hybrid_anchor_card = None  # ⚡ 2026-09-12 — anchor สำหรับ hybrid merge (compat+target_device)
        # ⚡ 2026-09-16 — default anchor_card=None (กัน UnboundLocalError เมื่อไม่มี _tagged_item_id)
        anchor_card = None
        if not _tagged_item_id and history:
            _current_model_kw = knowledge_base.extract_model_keywords(req.message)
            # ⚡ ถ้ามี model keyword ของสินค้าอื่น → new topic (เปลี่ยนรุ่น)
            # ⚡ ถ้ามี new topic keywords → new topic
            # ⚡ ไม่จำกัดความยาว — คำถามยาวก็เป็น follow-up ได้ (เช่น "ถ้าผมซื้อแล้วผมเชื่อถือได้ใช่ไหมครับมีการรับประกันนะครับ")
            _cur_msg_lower = (req.message or "").lower().strip()
            _is_new_topic = bool(_current_model_kw) or any(kw in _cur_msg_lower for kw in _NEW_TOPIC_KWS)
            # ⚡ 2026-09-12 — guard "อยากได้" ด้วย compat indicator
            #   "อยากได้ของที่ใช้กับ xiaomi 17 ultra" มี "อยากได้" แต่มี "ใช้กับ" → เป็น compat question
            #   ไม่ใช่ new topic → เก็บ anchor ไว้ (เช่น CTL301 cable) เพื่อให้ bot บอกว่าสินค้าเดิมไม่รองรับ
            if _is_new_topic and not _current_model_kw:
                _compat_kws_early = ("ใช้กับ", "รองรับ", "สำหรับ", "compatible", "support", "works with")
                _has_compat_early = any(kw in _cur_msg_lower for kw in _compat_kws_early)
                if _has_compat_early:
                    _is_new_topic = False
                    print(f"[ITEM-TAG] 'อยากได้' + compat kw → ไม่ใช่ new topic → เก็บ anchor", file=sys.stderr)
            if not _is_new_topic:
                for h in reversed(req.history):
                    if h.role == "user":
                        found = _extract_item_id_tag(h.text)
                        if found:
                            _tagged_item_id = found
                            _is_from_history_anchor = True
                            break
        # ข้อความที่เหลือหลังตัด tag ออก (ถ้ามีคำถามต่อท้าย เช่น "[สินค้า: 123] มีไหม")
        _clean_message = _ITEM_TAG_RE.sub("", req.message).strip()
        # ⚡ ถ้า message เป็นแค่ placeholder อย่างเช่น "[item]", "[variation_card]",
        #   "[bundle_message]", "[สินค้า]" (ไม่มี item_id ต่อท้าย) → ถือว่าว่าง
        #   ไม่งั้น LLM จะได้รับ "[item]" เป็นคำถามและตอบสับสน
        if _clean_message in ("[item]", "[itemid]", "[สินค้า]", "[variation_card]",
                              "[ตัวเลือกสินค้า]", "[bundle_message]", "[bundle_deal]",
                              "[bundle]", "[order]", "[คำสั่งซื้อ]"):
            _clean_message = ""
        if not _tagged_item_id and not _clean_message and history:
            # ข้อความปัจจุบันไม่มี tag และว่างเปล่า (ไม่ควรเกิด แต่กันไว้)
            _clean_message = req.message
        if _tagged_item_id:
            # ⚡ FIX — ถ้าลูกค้าส่งรูปภาพ (ไม่ใช่การ์ดสินค้า) และ anchor มาจาก history
            #   ให้ข้าม item_tag shortcut ไป main flow (Intent → RAG → LLM2)
            #   เพราะรูปอาจเป็นสินค้า/รุ่นอื่น ต้องใช้ vision desc ค้นสินค้าผ่าน RAG
            #   ไม่ใช่ตอบจาก anchor product เดิม (ซึ่งอาจไม่ใช่สินค้าในรูป)
            _cur_is_image_placeholder = bool(re.search(
                r"\[(?:รูปภาพ|image|วิดีโอ|video)\]",
                req.message or "",
                re.IGNORECASE,
            )) or bool(req.images)
            if _is_from_history_anchor and _cur_is_image_placeholder:
                print(f"[ITEM-TAG] ลูกค้าส่งรูป + anchor จาก history → ข้าม shortcut ไป main flow (ใช้ vision + RAG)", file=sys.stderr)
                _tagged_item_id = None
                anchor_card = None
            else:
                print(f"[ITEM-TAG] พบ item_id={_tagged_item_id} ในข้อความ", file=sys.stderr)
            # ใช้ desc_message ที่มี keyword "รายละเอียด" เพื่อให้ _clean_description ส่ง spec section
            _desc_msg = _clean_message or "รายละเอียดสินค้า"
            anchor_card = product_store.fetch_product_by_id(
                db, _tagged_item_id, shop_filter=req.shop,
                desc_message=_desc_msg,
            )
            # ⚡ บันทึก anchor product ลง conversation timeline
            if anchor_card and req.conversation_id:
                try:
                    from . import conversation_products as _cp
                    _cp.add_product(
                        conversation_id=req.conversation_id,
                        platform=req.platform,
                        shop=req.shop,
                        item_id=_tagged_item_id,
                        name=anchor_card.get("name", ""),
                        source="user_item_card",
                        card=anchor_card,
                        is_anchor=True,
                    )
                    print(f"[CONV-PRODUCTS] anchor added: item_id={_tagged_item_id} conv={req.conversation_id}", file=sys.stderr)
                except Exception as _e:
                    print(f"[CONV-PRODUCTS] error adding anchor: {_e}", file=sys.stderr)
            if anchor_card:
                # ⚡ เช็ค charger subtype mismatch — ถ้า message ปัจจุบันมี charger subtype ชัด
                # และต่างจาก anchor → ลูกค้าเปลี่ยนประเภทสินค้า ไม่ใช่ follow-up ของ anchor
                # เช่น แชร์การ์ดสายชาร์จ CTL301 แล้วถาม "หัวชาร์จละ" → ไม่ตอบจาก anchor (cable)
                # ให้ fall through ไป fetch_products ที่กรอง subtype ที่ถูกต้อง
                # anchor ยังอยู่ใน conversation_products timeline ให้ CONV-ACTIVE ใช้ในอนาคต
                _cur_sub_anchor = product_store._detect_charger_subtype(req.message)
                _anchor_sub = product_store._detect_charger_subtype(
                    anchor_card.get("name") or anchor_card.get("item_name") or ""
                )
                # ⚡ 2026-09-12 — compat + target_device → hybrid anchor+fetch
                #   "อยากได้ของที่ใช้กับ xiaomi 17 ultra" มี "ใช้กับ" + phone brand
                #   → เก็บ anchor ไว้ใน context + fetch สินค้าที่ใช้กับ target_device
                #   → LLM ตอบ: "CTL301 เป็น Lightning ไม่ใช้กับ Mi 17 Ultra แนะนำสาย USB-C แทน"
                _compat_kws_anchor = ("ใช้กับ", "รองรับ", "สำหรับ", "compatible", "support", "works with")
                _has_compat_anchor = any(kw in (req.message or "").lower() for kw in _compat_kws_anchor)
                _phone_brands_anchor = ("iphone", "ipad", "samsung", "xiaomi", "redmi",
                                        "huawei", "honor", "oppo", "vivo", "realme",
                                        "poco", "oneplus", "pixel", "mi ", "note ", "ultra")
                _has_target_device_anchor = any(b in (req.message or "").lower() for b in _phone_brands_anchor)
                _is_compat_with_target = _has_compat_anchor and _has_target_device_anchor
                # ⚡ 2026-09-12 — guard "หัว" ลอยๆ เหมือน CONV-ACTIVE (บรรทัด ~3088)
                #   "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → _detect_charger_subtype=adapter
                #   แต่ไม่มี strong adapter keyword (หัวชาร์จ/adapter/gan) → ไม่ใช่การเปลี่ยนหมวดจริง
                #   → ใช้ anchor ต่อ (เหมือนเคส ZMIThailand Q10 ที่เคยผ่าน)
                _strong_adapter_kw_anchor = ("หัวชาร์จ", "หัวชาร์ต", "adapter", "แอ็ดอปเตอร์", "gan", "qc 3", "pd fast")
                _has_strong_adapter_anchor = any(kw in (req.message or "").lower() for kw in _strong_adapter_kw_anchor)
                _is_loose_head = (
                    _cur_sub_anchor == "adapter" and _anchor_sub == "cable"
                    and not _has_strong_adapter_anchor
                )
                # ⚡ คำถาม "ชุดสินค้า" (compare/superlative) + timeline มี ≥2 ชิ้น
                #   → ไม่ใช่คำถามเกี่ยวกับ anchor เดี่ยว → ไม่ควรตอบจากการ์ดเดี่ยว
                #   ยกเว้น: มีคำอ้างชิ้นเดียว ("ตัวนี้/รุ่นนี้") = ถาม anchor จริงๆ
                _is_set_q_multi = False
                _msg_l_set = (req.message or "").lower()
                if (req.conversation_id
                        and not any(kw in _msg_l_set for kw in _SINGLE_ITEM_REF_KW)
                        and any(kw in _msg_l_set
                                for kw in _COMPARISON_FOLLOWUP_KW + _SUPERLATIVE_KW)):
                    try:
                        from . import conversation_products as _cp_multi
                        _is_set_q_multi = len(_cp_multi.get_anchor_and_suggestions(
                            req.conversation_id, limit=2)) >= 2
                    except Exception:
                        _is_set_q_multi = False
                if _cur_sub_anchor and _cur_sub_anchor != _anchor_sub and not _is_loose_head:
                    print(f"[ITEM-TAG] subtype mismatch: msg={_cur_sub_anchor} anchor={_anchor_sub} → fall through to fetch_products", file=sys.stderr)
                    # ไม่ return — ปล่อยไป main flow (fetch_products จะกรอง subtype ที่ถูกต้อง)
                elif _is_compat_with_target:
                    print(f"[ITEM-TAG] compat+target_device → hybrid anchor+fetch (anchor อยู่ใน context)", file=sys.stderr)
                    # ⚡ เก็บ anchor ไว้ merge ภายหลังหลัง fetch_products
                    _hybrid_anchor_card = anchor_card
                    # ไม่ return — ปล่อยไป main flow (fetch_products + merge anchor ภายหลัง)
                elif _is_set_q_multi:
                    # ⚡ คำถามเปรียบเทียบ/superlative อ้าง "ชุดสินค้า" ไม่ใช่ anchor เดี่ยว —
                    #   เช่น ส่งการ์ด A → bot แนะนำ B → "อันไหนใหม่กว่า" ต้องเทียบ A/B
                    #   ปล่อยไป main flow ให้ FOLLOWUP-COMP/CONV-ACTIVE จัดการ context
                    print(f"[ITEM-TAG] compare/superlative + ≥2 products in timeline → fall through to main flow", file=sys.stderr)
                else:
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
                            history=_qa10,
                            persona_extra=_persona_extra,
                            extra_context=_vision_context,
                        )
                    except RuntimeError as exc:
                        raise HTTPException(status_code=500, detail=str(exc))
                    _total_elapsed = _time.time() - _total_start

                    prompt_t = usage_info.get("prompt", 0)
                    output_t = usage_info.get("output", 0)
                    cost = llm._gemini_cost(prompt_t, output_t)
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
                        image_desc=_image_desc_out,
                    )
            else:
                print(f"[ITEM-TAG] ไม่พบสินค้า item_id={_tagged_item_id} ในระบบ", file=sys.stderr)
            # ถ้าไม่เจอสินค้า (ถูกลบ/item_id ผิด) ให้ตกไปใช้ flow ปกติต่อด้วยข้อความที่ตัด tag แล้ว
            if _clean_message:
                req.message = _clean_message
        # ⚡ 2026-09-12 — hybrid anchor+fetch: เพิ่ม anchor product type ใน message
        #   ถ้าเป็น compat+target_device case → เพิ่ม product type ของ anchor ใน req.message
        #   เพื่อให้ fetch_products ดึงสินค้าประเภทเดียวกับ anchor (เช่น charger/cable)
        #   แทนดึงสินค้า Xiaomi สุ่ม (phones/routers)
        if _hybrid_anchor_card:
            _anchor_ptypes = product_store._detect_product_types(
                _hybrid_anchor_card.get("name") or _hybrid_anchor_card.get("item_name") or ""
            )
            if _anchor_ptypes:
                _ptype_kw_map = {
                    "charger": "ชาร์จ charger",
                    "cable": "สายชาร์จ cable",
                    "powerbank": "พาวเวอร์แบงค์ powerbank",
                    "earphone": "หูฟัง earphone",
                    "phone": "สมาร์ทโฟน phone",
                }
                _ptype_kws = " ".join(_ptype_kw_map.get(pt, pt) for pt in _anchor_ptypes)
                req.message = f"{_ptype_kws} {req.message}"
                print(f"[HYBRID-MERGE] เพิ่ม anchor product type ใน message: {req.message!r}", file=sys.stderr)

        # ===== Order/tracking/return-refund early flow (ย้ายไป order_flow.early_order_flow) =====
        from . import warranty
        from . import warranty_flow as _warranty_flow
        from . import order_flow as _order_flow
        _of_ctx = {
            "qa10": _qa10,
            "steps": _steps,
            "total_start": _total_start,
            "persona_extra": _persona_extra,
            "vision_context": _vision_context,
            "image_desc_out": _image_desc_out,
            "model_name": model_name,
        }
        _ofr = _order_flow.early_order_flow(req, _of_ctx, history, db)
        if _ofr is not None:
            return ChatResponse(**_ofr)
        _order_sn = _of_ctx.get("order_sn")
        _is_claim_request_pre = _of_ctx.get("is_claim_request_pre", False)

        # ===== ขั้นที่ 0: เตรียมตัวแปรก่อน intent classification =====
        # ⚡ Phase 6 — general_qtype และ _is_claim_request ย้ายไปหลัง intent classification
        #   (ใช้ intent_result เป็นหลัก, keyword เป็น fallback)
        _t0 = _time.time()
        _current_has_model = bool(knowledge_base.extract_model_keywords(req.message))
        # general_qtype และ _is_claim_request จะถูก set หลัง intent classification (ด้านล่าง)
        general_qtype: str | None = None
        _is_claim_request = False
        _is_tax_invoice = False

        # ===== Phase 1C — Warranty auto-check from order_sn (delivery-date based) =====
        # ⚡ Warranty-Delivery — ใช้ delivery_time_raw (วันที่ส่งถึง) แทน create_time_raw (วันที่สั่งซื้อ)
        #    ถ้ามี order_sn + เป็น claim request → lookup_order → check_warranty_status
        #    ถ้ายังไม่ส่งมอบ/ยกเลิก → บอกลูกค้าว่ายังไม่เริ่มนับประกัน
        #    ถ้า multi-item ที่ warranty ต่างกัน → ถามลูกค้าว่าถามเรื่องชิ้นไหน
        #    ถ้าไม่มี order_sn / lookup ไม่พบ / ไม่มี delivery date → ใช้ manual purchase-date flow เดิม
        _warranty_auto_ctx = ""
        _warranty_auto_info: dict = {}
        _warranty_auto_answer: str = ""  # deterministic answer (ถ้ามี → ตอบเลย ไม่เข้า LLM)
        if _is_claim_request_pre and _order_sn:
            # ⚡ ย้าย logic auto-check ไป warranty.py (delivery-date + legacy fallback)
            _warranty_auto_answer, _warranty_auto_info, _warranty_auto_ctx = (
                warranty.auto_check_delivery_warranty(_order_sn, req.shop, _bot_name)
            )

        # ===== Human-request handoff (ย้ายไป handoffs.detect_human_request) =====
        from . import handoffs as _handoffs
        _hr = _handoffs.detect_human_request(req, {
            "steps": _steps,
            "timing_breakdown": _timing_breakdown,
            "total_start": _total_start,
            "image_desc_out": _image_desc_out,
            "model_name": model_name,
        })
        if _hr is not None:
            return ChatResponse(**_hr)


        # ===== Pass 1: LLM Intent Classification (รันทุกข้อความ) =====
        # ⚡ Phase 6 — ยกเลิก should_run_pass1() gate
        #   ก่อนหน้านี้: รันเฉพาะ "จุดอ่อน" ที่ hardcoded detection ไม่มั่นใจ
        #   ปัญหา: hardcoded decision ตัดสินก่อน LLM → ผิดได้ในกรณีกำกวม
        #   ตอนนี้: รัน intent classification ก่อนเสมอ (หลัง deterministic checks)
        #   แล้วให้ keyword detection ใช้ intent_result เป็นหลัก, keyword เป็น fallback
        #
        #   Deterministic checks ที่ยังอยู่ก่อน intent (เพราะ 100% ชัด/regex):
        #   1. order_sn regex (บรรทัด ~1345)
        #   2. tracking_no regex (บรรทัด ~1384)
        #   3. human_request keyword (บรรทัด ~1605 — ชัด 100%)
        from . import intent_classifier as _ic
        _intent_result: dict = {}
        # ⚡ Phase 6 — รัน intent classification เสมอ (ไม่ gate ด้วย should_run_pass1)
        _t_intent = _time.time()
        try:
            _intent_result = _ic.classify_intent(
                message=req.message,
                history=history,
                shop=req.shop,
            )
        except Exception as _ie:
            # ⚡ Phase 6 — classifier exception/timeout → fallback to keyword
            print(f"[INTENT] classify_intent() threw: {_ie} → ใช้ keyword fallback", file=sys.stderr)
            _intent_result = dict(_ic._DEFAULT_RESULT) if hasattr(_ic, "_DEFAULT_RESULT") else {
                "intent": "other", "product_type": None, "charger_subtype": None,
                "target_device": None, "needs_description": False,
                "general_qtype": None, "confidence": 0.0,
            }
        _timing_breakdown["pass1"] = round(_time.time() - _t_intent, 3)
        print(f"[TIMING] Pass1 intent: {_timing_breakdown['pass1']}s  intent={_intent_result.get('intent')} conf={_intent_result.get('confidence')}", file=sys.stderr)
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
                "general_qtype": _intent_result.get("general_qtype"),
            },
        })

        # ===== Phase 6 — แก้ hardcoded detection ให้ใช้ intent_result เป็นหลัก =====
        # Confidence threshold: ใช้ 0.7 (สอดคล้องกับ warranty override เดิม)
        _INTENT_CONF_THRESHOLD = 0.7
        _intent_conf = float(_intent_result.get("confidence") or 0)
        _intent_name = _intent_result.get("intent")
        _intent_gq = _intent_result.get("general_qtype")

        # --- general_qtype: intent first, keyword fallback ---
        #   intent=general_question + general_qtype เป็นหลัก
        #   ถ้า intent ไม่ใช่ general_question หรือ confidence ต่ำ → ใช้ keyword
        if _intent_name == "general_question" and _intent_conf >= _INTENT_CONF_THRESHOLD and _intent_gq:
            general_qtype = _intent_gq
            print(f"[INTENT] general_qtype from intent: {general_qtype} (conf={_intent_conf})", file=sys.stderr)
        else:
            # fallback: keyword detection (เดิม)
            general_qtype = knowledge_base.detect_general_question(req.message)
            if general_qtype and _intent_name == "general_question" and _intent_conf >= _INTENT_CONF_THRESHOLD:
                # intent บอก general_question แต่ general_qtype ไม่ตรง keyword → เชื่อ intent (ถ้า intent ระบุ qtype)
                if _intent_gq:
                    print(f"[INTENT] general_qtype: keyword={general_qtype} → override to intent={_intent_gq}", file=sys.stderr)
                    general_qtype = _intent_gq
                else:
                    print(f"[INTENT] general_qtype: keyword={general_qtype} (intent=general_question แต่ไม่ระบุ qtype)", file=sys.stderr)
            elif general_qtype:
                print(f"[INTENT] general_qtype: keyword={general_qtype} (intent={_intent_name} conf={_intent_conf} → fallback keyword)", file=sys.stderr)

        # --- _is_claim_request: intent first, keyword fallback ---
        #   intent=warranty_claim (conf >= 0.7) → claim_request=True
        #   intent อื่น (conf >= 0.7) → claim_request=False
        #   กรณีอื่น → ใช้ keyword detection (เดิม)
        _kw_claim = warranty.detect_claim_request(req.message)
        if _intent_name == "warranty_claim" and _intent_conf >= _INTENT_CONF_THRESHOLD:
            _is_claim_request = True
            print(f"[INTENT] _is_claim_request=True from intent (conf={_intent_conf})  keyword={_kw_claim}", file=sys.stderr)
        elif _intent_name and _intent_name != "warranty_claim" and _intent_conf >= _INTENT_CONF_THRESHOLD:
            # intent บอกไม่ใช่ warranty_claim แต่ keyword บอกใช่ → เชื่อ intent (ยกเว้น strong complaint)
            _strong_complaint_kws = (
                "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด", "ชาร์จไม่ได้", "ใช้ไม่ได้",
                "ไม่ทำงาน", "ไม่ติด", "ค้าง", "ไฟไม่เข้า", "ไม่เข้าเลย",
            )
            _has_strong_complaint = any(kw in req.message.lower() for kw in _strong_complaint_kws)
            _repeated_complaint = False
            if history and _kw_claim:
                _complaint_kws = (
                    "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด", "ใช้ไม่ได้", "ไม่ทำงาน",
                    "เสีย", "พัง", "เคลม", "ซ่อม", "ไม่ติด", "ค้าง",
                )
                _prev_complaints = 0
                for _h in history:
                    _ht = ((_h.get("text") if isinstance(_h, dict) else _h.text) or "").lower()
                    if ((_h.get("role") if isinstance(_h, dict) else _h.role) == "user") and any(kw in _ht for kw in _complaint_kws):
                        _prev_complaints += 1
                if _prev_complaints >= 2:
                    _repeated_complaint = True
                    print(f"[INTENT] repeated complaint ({_prev_complaints}x in history) → ห้าม LLM override claim_request=False", file=sys.stderr)
            _skip_llm_override = _repeated_complaint or _has_strong_complaint
            if _kw_claim and not _skip_llm_override:
                print(f"[INTENT] override: claim_request=False (keyword=True but LLM says {_intent_name})", file=sys.stderr)
                _is_claim_request = False
            elif _kw_claim and _skip_llm_override:
                print(f"[INTENT] skip override (strong complaint kw={_has_strong_complaint} repeated={_repeated_complaint}) — keep claim_request=True", file=sys.stderr)
                _is_claim_request = True
            else:
                # keyword ไม่บอก claim และ intent ก็ไม่ใช่ warranty_claim → False
                _is_claim_request = False
        else:
            # confidence ต่ำ / intent=other / error → fallback keyword
            _is_claim_request = _kw_claim
            if _is_claim_request:
                print(f"[INTENT] _is_claim_request=True from keyword fallback (intent={_intent_name} conf={_intent_conf})", file=sys.stderr)

        # --- _is_tax_invoice: intent first, keyword fallback ---
        #   intent=general_question + general_qtype=tax_invoice (conf >= 0.7) → tax_invoice=True
        #   กรณีอื่น → ใช้ keyword detection (เดิม) เพราะ keyword จับ data submission ด้วย
        #   (เช่น "เลขผู้เสียภาษี", "หจก." — intent อาจไม่จับ)
        if _intent_name == "general_question" and _intent_gq == "tax_invoice" and _intent_conf >= _INTENT_CONF_THRESHOLD:
            _is_tax_invoice = True
            print(f"[INTENT] _is_tax_invoice=True from intent (conf={_intent_conf})", file=sys.stderr)
        else:
            _is_tax_invoice = warranty.detect_tax_invoice_request(req.message)
            if _is_tax_invoice:
                print(f"[INTENT] _is_tax_invoice=True from keyword fallback (intent={_intent_name} qtype={_intent_gq})", file=sys.stderr)

        # ===== Tax invoice + TISI handlers (ย้ายไป handoffs.post_intent_handoffs) =====
        _phr = _handoffs.post_intent_handoffs(req, {
            "is_tax_invoice": _is_tax_invoice,
            "bot_name": _bot_name,
            "steps": _steps,
            "timing_breakdown": _timing_breakdown,
            "total_start": _total_start,
            "image_desc_out": _image_desc_out,
            "model_name": model_name,
        }, db)
        if _phr is not None:
            return ChatResponse(**_phr)


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
            _last_model_msgs = [h for h in _qa10 if h.get("role") == "model"][-2:]
            _last_model_text = " ".join(h.get("text", "") for h in _last_model_msgs)
            _all_history_text = " ".join(h.get("text", "") for h in _qa10)
            # ใช้ model answer ล่าสุดเป็นหลัก ถ้าไม่มีค่อยใช้ history ทั้งหมด
            history_text = _last_model_text if _last_model_text.strip() else _all_history_text
            # หา pattern ที่เป็น "brand/word + model number" เช่น "Redmi 8A", "Xiaomi 12", "Lagenio K9"
            # ไม่ใช่แค่ตัวเลขเดี่ยวๆ เช่น "8A" หรือ "2000"
            # pattern: word(2+) + space + alphanumeric(2+) ที่มีตัวเลข
            model_patterns = re.findall(
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
                if not re.search(r"\d", model_part):
                    continue
                # ไม่เอาตัวเลขล้วน (เช่น "2000")
                if re.fullmatch(r"\d+", model_part):
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

        # ⚡ ประกาศ _anchor_compare_ctx ก่อน comparison follow-up (ใช้ร่วมกับ anchor compare block)
        _anchor_compare_ctx: dict = {}  # {current: card, previous: card}
        _is_partial_comp = False  # ⚡ partial comparison: 1 anchor + model keyword (เช่น "ตัวนี้กับ swim ต่างกันยังไง")

        # ===== Comparison follow-up =====
        # กรณี: ลูกค้าถาม "ต่างกันยังไง", "เปรียบเทียบ", "เทียบ" โดยไม่มี model keyword
        # แต่มี model ใน history → ดึง model จาก history มาเปรียบเทียบ
        _is_comparison_followup = (
            any(kw in req.message.lower()
                for kw in _COMPARISON_FOLLOWUP_KW + _SUPERLATIVE_KW)
            and history
            and not _current_has_model  # message ปัจจุบันไม่มี model keyword
            and not any(kw in req.message.lower() for kw in _SINGLE_ITEM_REF_KW)  # "ตัวนี้ใหม่สุดไหม" = ถามชิ้นเดียว
            and len(req.message.split()) <= 4  # คำถามสั้นๆ
        )
        if _is_comparison_followup:
            print(f"[FOLLOWUP-COMP] triggered: msg={req.message!r}  history={len(history)}  has_model={_current_has_model}", file=sys.stderr)
            # ⚡ ใช้ anchor history ก่อนดึง model keyword จาก history text
            #   เพราะ extract_model_keywords ดึงชื่อแบรนด์/ซีรีส์ (iSUPER, SoundActiv) แทนชื่อรุ่น
            #   และ [:3] ตัดทำให้รุ่นที่อยู่ด้านหลังหายไป (เช่น Swim หาย มีแค่ Run)
            #   ถ้ามี 2+ anchor ใน timeline → ใช้ anchor ทั้งสองตัว ไม่ต้อง modify req.message
            _anchor_comp_from_followup = False
            if req.conversation_id:
                try:
                    from . import conversation_products as _cp_fc
                    _fc_anchors = _cp_fc.get_anchor_history(req.conversation_id, limit=5)
                    if len(_fc_anchors) >= 2:
                        _fc_cur = _cp_fc.get_active_product(req.conversation_id)
                        _fc_prev = _cp_fc.get_previous_anchor(
                            req.conversation_id,
                            exclude_item_id=_fc_cur.get("item_id") if _fc_cur else None,
                        )
                        if _fc_cur and _fc_prev:
                            _anchor_compare_ctx = {"current": _fc_cur, "previous": _fc_prev}
                            _anchor_comp_from_followup = True
                            print(f"[FOLLOWUP-COMP] using anchor history: current={_fc_cur.get('name','')[:40]} previous={_fc_prev.get('name','')[:40]}", file=sys.stderr)
                except Exception as _e:
                    print(f"[FOLLOWUP-COMP] anchor history error: {_e}", file=sys.stderr)
            if not _anchor_comp_from_followup and req.conversation_id:
                # ⚡ ลูกค้าอาจเปรียบเทียบ "ของที่ bot เพิ่งแนะนำ" ไม่ใช่ anchor —
                #   เช่น กด Case → bot แนะนำ Run+Free → "อันไหนดีกว่า" = Run vs Free
                #   (anchor <2 จึงมาถึงจุดนี้; trailing suggestion batch = เทิร์นเดียวกัน)
                try:
                    from . import conversation_products as _cp_sug
                    _sug_batch = _cp_sug.get_latest_suggestion_batch(req.conversation_id)
                    if 0 < len(_sug_batch) < 2:
                        # ⚡ batch ตัวเดียว → เติม anchor ล่าสุดเป็นคู่เทียบ
                        #   (สินค้าที่คุยกันอยู่ 2 ชิ้นล่าสุด — เช่น ส่งการ์ด Case แล้ว bot แนะนำ Run ตัวเดียว)
                        for _a in _cp_sug.get_anchor_history(req.conversation_id, limit=3):
                            _a_card = _a.get("card") or {
                                "item_id": _a.get("item_id"), "name": _a.get("name")}
                            if all(str(c.get("item_id")) != str(_a_card.get("item_id"))
                                   for c in _sug_batch):
                                _sug_batch.append(_a_card)
                                break
                    if len(_sug_batch) >= 2:
                        _anchor_compare_ctx = {"current": _sug_batch[0],
                                               "previous": _sug_batch[1]}
                        _anchor_comp_from_followup = True
                        print(f"[FOLLOWUP-COMP] using suggestion batch: "
                              f"current={_sug_batch[0].get('name','')[:40]} "
                              f"previous={_sug_batch[1].get('name','')[:40]}", file=sys.stderr)
                except Exception as _e:
                    print(f"[FOLLOWUP-COMP] suggestion batch error: {_e}", file=sys.stderr)
            if not _anchor_comp_from_followup:
                # Fallback: ดึง model keywords จาก history text (เดิม)
                # ดึง model keywords จาก history ทั้งหมด (user + model)
                # ⚡ กรอง placeholder/tag ออกก่อน (เช่น [variation_card], [สินค้า: 123], [item])
                #   ไม้งั้น extract_model_keywords จะจับ "[variation_card]" เป็น model
                _all_history_text2 = " ".join(h.get("text", "") for h in _qa10)
                _all_history_text2 = _ITEM_TAG_RE.sub("", _all_history_text2)
                for _ph in ("[variation_card]", "[item]", "[itemid]", "[สินค้า]",
                            "[ตัวเลือกสินค้า]", "[bundle_message]", "[bundle_deal]",
                            "[bundle]", "[order]", "[คำสั่งซื้อ]"):
                    _all_history_text2 = _all_history_text2.replace(_ph, "")
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

        # ===== Anchor comparison follow-up (Phase 7) =====
        # กรณี: ลูกค้าถาม "อันนี้กับอันก่อนต่างกันยังไง", "อันนี้กับอันก่อนหน้า"
        # โดย "อันนี้" = anchor ล่าสุด (active) และ "อันก่อน" = anchor อันดับ 2
        # ดึงจาก conversation_products timeline แทนการ extract model keyword จาก history
        # (เพราะลูกค้าอ้างอิง anchor ไม่ใช่ชื่อรุ่น)
        _anchor_compare_kws = (
            "อันนี้กับอันก่อน", "อันนี้กับอันก่อนหน้า",
            "อันนี้กับอันนั้น", "ตัวนี้กับตัวก่อน",
            "ตัวนี้กับตัวก่อนหน้า", "ตัวนี้กับตัวนั้น",
            "อันนี้กับอันเดิม", "ตัวนี้กับตัวเดิม",
            "รุ่นนี้กับรุ่นก่อน", "รุ่นนี้กับรุ่นก่อนหน้า",
            "อันนี้กับอันที่แล้ว", "ตัวนี้กับตัวที่แล้ว",
        )
        _is_anchor_compare = (
            any(kw in (req.message or "").lower() for kw in _anchor_compare_kws)
            and bool(req.conversation_id)
        )
        # _anchor_compare_ctx ประกาศก่อนหน้า (ก่อน comparison follow-up) — ไม่ reset ถ้า set แล้ว
        if _is_anchor_compare and not _anchor_compare_ctx:
            try:
                from . import conversation_products as _cp_cmp
                _cur_anchor = _cp_cmp.get_active_product(req.conversation_id)
                _prev_anchor = _cp_cmp.get_previous_anchor(
                    req.conversation_id,
                    exclude_item_id=_cur_anchor.get("item_id") if _cur_anchor else None,
                )
                if _cur_anchor and _prev_anchor:
                    _anchor_compare_ctx = {"current": _cur_anchor, "previous": _prev_anchor}
                    print(f"[ANCHOR-COMP] current={_cur_anchor.get('name','')[:40]} previous={_prev_anchor.get('name','')[:40]}", file=sys.stderr)
                else:
                    print(f"[ANCHOR-COMP] ไม่มี anchor พอ (current={bool(_cur_anchor)} previous={bool(_prev_anchor)}) → ข้าม", file=sys.stderr)
            except Exception as _e:
                print(f"[ANCHOR-COMP] error: {_e}", file=sys.stderr)

        # ===== Post-comparison follow-up (Phase 7+) =====
        # กรณี: รอบก่อนลูกค้าถามเปรียบเทียบ ("ต่างกันยังไง", "เทียบ", ฯลฯ)
        # รอบนี้ถาม follow-up สั้นๆ ไม่มี model keyword (เช่น "อยากทราบคุณภาพเสียงค่ะ")
        # → ใช้ both anchors ต่อ (อย่าตัด context กลับเป็น active ตัวเดียว)
        # เงื่อนไข: มี 2+ anchor, ไม่มี model keyword, ไม่ใช่ new topic, สั้น, รอบก่อนเป็น comparison
        if (
            not _anchor_compare_ctx  # ยังไม่ได้ set (ไม่ซ้ำกับ block ด้านบน)
            and req.conversation_id
            and not _current_has_model
            and history
        ):
            try:
                from . import conversation_products as _cp_pcf
                _pcf_anchors = _cp_pcf.get_anchor_history(req.conversation_id, limit=5)
                if len(_pcf_anchors) >= 2:
                    # เช็คว่ารอบก่อน (last user msg ใน history) เป็น comparison question ไหม
                    _pcf_recent_user = [h.get("text", "") for h in (history or []) if h.get("role") == "user"][-1:]
                    _pcf_comp_kws = ("ต่างกัน", "ต่างยังไง", "ต่างไหม", "เปรียบเทียบ", "เทียบ", "เทียบกัน",
                                     "กับตัว", "กับรุ่น", "กับอัน", "กับสอง")
                    _pcf_was_comp = any(
                        any(kw in m.lower() for kw in _pcf_comp_kws)
                        for m in _pcf_recent_user
                    )
                    # เช็คว่า current message ไม่ใช่ new topic
                    _pcf_msg_lower = (req.message or "").lower().strip()
                    _pcf_new_topic = any(kw in _pcf_msg_lower for kw in
                                         ("สวัสดี", "หวัดดี", "hi", "hello", "มีอะไร", "มีไร",
                                          "สนใจ", "อยากได้", "หาสินค้า", "แนะนำ"))
                    _pcf_short = len((req.message or "").split()) <= 8
                    if _pcf_was_comp and not _pcf_new_topic and _pcf_short:
                        _pcf_cur = _cp_pcf.get_active_product(req.conversation_id)
                        _pcf_prev = _cp_pcf.get_previous_anchor(
                            req.conversation_id,
                            exclude_item_id=_pcf_cur.get("item_id") if _pcf_cur else None,
                        )
                        if _pcf_cur and _pcf_prev:
                            _anchor_compare_ctx = {"current": _pcf_cur, "previous": _pcf_prev}
                            print(f"[POST-COMP-FUP] prev was comparison → both anchors: current={_pcf_cur.get('name','')[:40]} previous={_pcf_prev.get('name','')[:40]}", file=sys.stderr)
            except Exception as _e:
                print(f"[POST-COMP-FUP] error: {_e}", file=sys.stderr)

        # ===== Partial comparison (1 anchor + model keyword) =====
        # กรณี: ลูกค้าส่ง item card Run แล้วถาม "ตัวนี้กับ swim ต่างกันยังไง"
        # มี anchor แค่ 1 ตัว (Run) + model keyword "swim" ใน message
        # → ใช้ anchor (Run) เป็น "current" + ปล่อยให้ fetch_products ค้น "swim" เป็น "other"
        # → CONV-ACTIVE ใช้ anchor (Run) แม้ _cur_model_kw ไม่ว่าง
        # → merge point เพิ่ม Run เข้า products + comparison note
        if (
            not _anchor_compare_ctx  # ยังไม่ได้ set (ไม่ซ้ำกับ block ด้านบน)
            and any(kw in (req.message or "").lower() for kw in _COMPARISON_FOLLOWUP_KW)
            and _current_has_model  # มี model keyword (ต่างจาก full comparison ที่ต้องไม่มี)
            and bool(req.conversation_id)
        ):
            try:
                from . import conversation_products as _cp_part
                _part_anchors = _cp_part.get_anchor_history(req.conversation_id, limit=5)
                if len(_part_anchors) == 1:  # มี anchor แค่ 1 ตัว (ถ้า 2+ เป็น full comparison ด้านบน)
                    _part_cur = _cp_part.get_active_product(req.conversation_id)
                    if _part_cur and _part_cur.get("item_id"):
                        # guard: ถ้า model keyword ตรงกับชื่อ anchor → ไม่ใช่ comparison (ถามตัวเดิม)
                        _part_cur_name = (_part_cur.get("name") or "").lower()
                        _part_model_kws = knowledge_base.extract_model_keywords(req.message)
                        _part_model_kws = [k for k in _part_model_kws if not knowledge_base.is_target_device_kw(k)]
                        _kw_is_anchor = any(
                            kw.lower() in _part_cur_name
                            for kw in _part_model_kws
                            if re.search(r"\d", kw)  # model code pattern only
                        )
                        if not _kw_is_anchor:
                            _anchor_compare_ctx = {"current": _part_cur}  # no "previous"
                            _is_partial_comp = True
                            print(f"[PARTIAL-COMP] current={_part_cur.get('name','')[:40]} model_kw={_part_model_kws}", file=sys.stderr)
                        else:
                            print(f"[PARTIAL-COMP] model kw ตรง anchor → ไม่ใช่ comparison (ถามตัวเดิม)", file=sys.stderr)
            except Exception as _e:
                print(f"[PARTIAL-COMP] error: {_e}", file=sys.stderr)

        # ===== Warranty claim state machine (ย้ายไป warranty_flow.handle_warranty_flow_legacy) =====
        _wfr = _warranty_flow.handle_warranty_flow_legacy(req, {
            "anchor_compare_ctx": _anchor_compare_ctx,
            "bot_name": _bot_name,
            "image_desc_out": _image_desc_out,
            "is_claim_request": _is_claim_request,
            "is_followup_policy": _is_followup_policy,
            "is_tax_invoice": _is_tax_invoice,
            "qa10": _qa10,
            "steps": _steps,
            "timing_breakdown": _timing_breakdown,
            "total_start": _total_start,
            "t0": _t0,
            "warranty_auto_answer": _warranty_auto_answer,
            "warranty_auto_ctx": _warranty_auto_ctx,
            "intent_result": _intent_result,
            "model_name": model_name,
        }, _qa10, db)
        if _wfr is not None:
            return ChatResponse(**_wfr)

        if general_qtype:
            # ถ้าเป็น warranty_policy/return_policy แต่ message มี model keyword (เช่น "P01 รับประกันกี่ปี")
            # หรือมี item_id (ลูกค้าคลิกสินค้ามา) ให้ skip general flow ไป product flow แทน
            # เพราะลูกค้าถามรับประกันของสินค้าเฉพาะรุ่น ต้องดึงสินค้า (รวม UNLIST/sold_out) มาให้ LLM ตอบ
            if general_qtype in ("warranty_policy", "return_policy") and (_current_has_model or _tagged_item_id):
                print(f"[INTENT] warranty_policy with model/item_id → skip general, go to product flow", file=sys.stderr)
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
                        history=_qa10,
                        shop_hint=_gen_shop_filter,
                        persona_extra=_persona_extra,
                    )
                except RuntimeError as exc:
                    raise HTTPException(status_code=500, detail=str(exc))
                _total_elapsed = _time.time() - _total_start

                prompt_t = usage_info.get("prompt", 0)
                output_t = usage_info.get("output", 0)
                cost = llm._gemini_cost(prompt_t, output_t)
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
                    image_desc=_image_desc_out,
                )

        # ===== ขั้นที่ 0b: ตรวจ brand-specific question (เช่น "Xiaomi ขายอะไรบ้าง") =====
        brand_q = knowledge_base._detect_brand_question(req.message)
        if brand_q and not general_qtype:
            print(f"[TIMING] Brand question detected: {brand_q}  ({_time.time()-_t0:.2f}s)", file=sys.stderr)
            # ถ้ารู้ว่าลูกค้าทักมาจากร้านไหน ให้จำกัดเฉพาะสินค้าแบรนด์นี้ในร้านนั้น
            # (ลูกค้าซื้อได้แค่จากร้านที่กำลังคุยอยู่ ไม่ใช่ร้านอื่นในเครือ)
            brand_result = knowledge_base._build_brand_context(db, brand_q, shop_filter=req.shop)
            if req.shop and not brand_result:
                brand_result = knowledge_base._build_brand_context(db, brand_q)
            if brand_result and brand_result.get("context"):
                try:
                    answer, usage_info = llm.answer_general(
                        message=req.message,
                        context=brand_result["context"],
                        qtype="brand_info",
                        history=_qa10,
                        shop_hint=req.shop if brand_result.get("meta", {}).get("shop_scoped") else None,
                        persona_extra=_persona_extra,
                    )
                except RuntimeError as exc:
                    raise HTTPException(status_code=500, detail=str(exc))
                _total_elapsed = _time.time() - _total_start

                prompt_t = usage_info.get("prompt", 0)
                output_t = usage_info.get("output", 0)
                cost = llm._gemini_cost(prompt_t, output_t)
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
                    image_desc=_image_desc_out,
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
                    m.text
                    for m in req.history
                    if m.role == "user"
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
        # ⚡ Reference indicator skip KB: ถ้า message มี reference indicator ("รุ่นนี้", "ตัวนี้" ฯลฯ)
        # และมี history (bot เคยตอบ) → skip KB merge ทั้งก้อน
        # เพราะ KB merge path จะ early-return ก่อน reference logic รัน ทำให้ดึงสินค้าผิด
        # (เช่น ถาม "รุ่นนี้ละคะ มีแบตในตัวไหม" หลัง bot คุยเรื่อง IMILAB EC4
        #  → KB merge เจอ sd card → คืน 7 SD card ก่อน → reference logic ไม่ได้ทำงาน)
        # ให้ข้าม KB ไป reference logic ซึ่งจะดึง EC4 จากคำตอบ bot ล่าสุดมาเป็น retrieval
        _ref_indicator_skip_kb = False
        _ref_indicators_kb = (
            "รุ่นนี้", "ตัวนี้", "เรือนนี้", "อันนี้", "สินค้านี้", "ชิ้นนี้",
            "รุ่นที่แนะนำ", "ที่แนะนำ", "ขอรายละเอียด", "ขอสเปก",
            "ขอข้อมูลเพิ่มเติม", "ขอรายละเอียดเพิ่มเติม", "ขอดูสเปก",
            "ขอดูรายละเอียด", "ขอข้อมูลสินค้า", "ขอรายละเอียดสินค้า",
        )
        if req.history and any(ind in req.message for ind in _ref_indicators_kb):
            # ตรวจว่า history มี model answer (bot เคยตอบ) — ถ้าไม่มีก็ skip ไม่ได้
            _has_bot_answer = any(
                m.role == "model" and (m.text or "").strip()
                for m in req.history
            )
            if _has_bot_answer:
                _ref_indicator_skip_kb = True
                print(f"[REF-INDICATOR] skip KB merge — message มี reference indicator + มี history bot answer", file=sys.stderr)
        if req.history and not _wattage_followup_skip_kb and not _compat_followup_skip_kb and not _ref_indicator_skip_kb:
            # สกัด model words จาก user messages ใน history
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
        _is_superlative_q = any(kw in _msg_lower_super for kw in _SUPERLATIVE_KW)
        if _wattage_followup_skip_kb or _compat_followup_skip_kb or _ref_indicator_skip_kb:
            kb_result = None
            _skip_reason = (
                "wattage" if _wattage_followup_skip_kb
                else "compat" if _compat_followup_skip_kb
                else "ref_indicator"
            )
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
                        _req_sub = _resolve_charger_subtype(intent_result=_intent_result, retrieval_message=req.message)
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
                # ⚡ รับ model code สั้น (>=3 ตัว) ที่มีตัวอักษร + ตัวเลข (เช่น p23, k9, x7)
                #    เดิมกรอง len>=4 ทำให้ "p23" หาย → ไม่ match P23 Powerbank
                _kb_model_kws = [w for w in _kb_model_kws if len(w) >= 3 and re.search(r"\d", w)]
                if not _kb_model_kws:
                    _kb_alpha_kws = re.findall(r"[A-Za-z]{5,}", req.message)
                    _kb_common = {"watch", "smart", "phone", "cable", "charger", "adapter",
                                  "power", "bank", "band", "type", "usb", "wireless",
                                  "what", "how", "please", "thank", "hello", "hi",
                                  "version", "global", "china", "international", "original",
                                  "authentic", "local", "origin", "korea", "hongkong"}
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
                        limit=_llm_ctx_limit,
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
                        limit=_llm_ctx_limit,
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
                _coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
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
                    _req_sub = _resolve_charger_subtype(intent_result=_intent_result, retrieval_message=req.message)
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
                    # ⚡ 2026-09-12 — hybrid anchor+fetch: merge anchor กับ merged_products
                    #   กรณี "อยากได้ของที่ใช้กับ xiaomi 17 ultra" หลังแชร์การ์ด CTL301
                    #   → LLM เห็นทั้ง anchor (CTL301 Lightning) และสินค้าที่ fetch มา
                    _hybrid_extra_ctx = ""
                    if _hybrid_anchor_card:
                        _anchor_id_kb = str(_hybrid_anchor_card.get("item_id") or "")
                        _existing_ids_kb = {str(p.get("item_id") or "") for p in merged_products}
                        if _anchor_id_kb and _anchor_id_kb not in _existing_ids_kb:
                            merged_products = [_hybrid_anchor_card] + merged_products
                            print(f"[HYBRID-MERGE-KB] merge anchor item_id={_anchor_id_kb} เข้า merged_products (now {len(merged_products)})", file=sys.stderr)
                        _anchor_name_kb = _hybrid_anchor_card.get("name") or _hybrid_anchor_card.get("item_name") or ""
                        _hybrid_extra_ctx = (
                            f"\n⚠️ สินค้าแรกใน context ({_anchor_name_kb}) คือสินค้าที่ลูกค้าสนใจจากก่อนหน้า "
                            f"ลูกค้าถามหาสินค้าที่ใช้กับอุปกรณ์รุ่นใหม่ "
                            f"ถ้าสินค้าเดิมไม่รองรับอุปกรณ์รุ่นใหม่ ให้บอกตรงๆ แล้วแนะนำสินค้าอื่นที่รองรับแทน"
                        )
                    # ⚡ anchor comparison merge ใน KB path (เหมือน main path)
                    if _anchor_compare_ctx and _anchor_compare_ctx.get("current") and _anchor_compare_ctx.get("previous"):
                        _cur_kb = _anchor_compare_ctx["current"]
                        _prev_kb = _anchor_compare_ctx["previous"]
                        _cur_kb_id = str(_cur_kb.get("item_id") or "")
                        _prev_kb_id = str(_prev_kb.get("item_id") or "")
                        _existing_ids_kb_cmp = {str(p.get("item_id") or "") for p in merged_products}
                        _kb_cmp_inserted = []
                        if _cur_kb_id and _cur_kb_id not in _existing_ids_kb_cmp:
                            _kb_cmp_inserted.append(_cur_kb)
                        if _prev_kb_id and _prev_kb_id not in _existing_ids_kb_cmp and _prev_kb_id != _cur_kb_id:
                            _kb_cmp_inserted.append(_prev_kb)
                        if _kb_cmp_inserted:
                            merged_products = _kb_cmp_inserted + merged_products
                            print(f"[ANCHOR-COMP-MERGE-KB] เพิ่ม {len(_kb_cmp_inserted)} anchor เข้า merged_products (now {len(merged_products)})", file=sys.stderr)
                        _cur_kb_name = _cur_kb.get("name") or _cur_kb.get("item_name") or ""
                        _prev_kb_name = _prev_kb.get("name") or _prev_kb.get("item_name") or ""
                        _kb_cmp_note = (
                            f"\n⚠️ ลูกค้าถามเปรียบเทียบสินค้า 2 รุ่นที่เคยสนใจในแชทนี้:\n"
                            f"  - อันนี้ (ล่าสุด): {_cur_kb_name}\n"
                            f"  - อันก่อนหน้า: {_prev_kb_name}\n"
                            f"ให้เปรียบเทียบความแตกต่างของ 2 รุ่นนี้จากข้อมูลใน context "
                            f"(สเปค ราคา การรับประกัน ความเข้ากันได้ ฯลฯ) "
                            f"ถ้าข้อมูลไม่พอ บอกตรงๆ ว่าไม่มีข้อมูลบางส่วน"
                        )
                        _hybrid_extra_ctx = (_hybrid_extra_ctx + _kb_cmp_note).strip()
                    elif _is_partial_comp and _anchor_compare_ctx.get("current"):
                        _cur_pc_kb = _anchor_compare_ctx["current"]
                        _cur_pc_kb_id = str(_cur_pc_kb.get("item_id") or "")
                        _existing_ids_pc_kb = {str(p.get("item_id") or "") for p in merged_products}
                        if _cur_pc_kb_id and _cur_pc_kb_id not in _existing_ids_pc_kb:
                            merged_products = [_cur_pc_kb] + merged_products
                            print(f"[PARTIAL-COMP-MERGE-KB] เพิ่ม anchor current เข้า merged_products (now {len(merged_products)})", file=sys.stderr)
                        _cur_pc_kb_name = _cur_pc_kb.get("name") or _cur_pc_kb.get("item_name") or ""
                        _pc_kb_note = (
                            f"\n⚠️ ลูกค้าถามเปรียบเทียบสินค้าที่สนใจ ({_cur_pc_kb_name}) "
                            f"กับสินค้าอื่นที่ลูกค้าระบุในข้อความ "
                            f"ให้เปรียบเทียบสินค้าแรก ({_cur_pc_kb_name}) กับสินค้าอื่นใน context "
                            f"(สเปค ราคา การรับประกัน ความเข้ากันได้ ฯลฯ) "
                            f"ถ้าข้อมูลไม่พอ บอกตรงๆ ว่าไม่มีข้อมูลบางส่วน"
                        )
                        _hybrid_extra_ctx = (_hybrid_extra_ctx + _pc_kb_note).strip()
                    # สร้าง context ใหม่ที่รวม KB + Mongo
                    merged_context = llm._build_context(merged_products, shop_hint=req.shop,
                                                         include_description=True)

                    # ⚡ device-spec-lookup ใน KB path — เดิม KB path return ก่อนถึง device-spec-lookup
                    #   ใน main path → LLM เห็นแค่สินค้าจาก KB+Mongo ไม่เห็น high-wattage upgrade
                    #   แก้: เรียก helper ก่อน LLM → merge high-wattage + inject spec context
                    _kb_device_extra, _kb_device_products = device_compat._device_spec_lookup(
                        db=db,
                        req=req,
                        intent_result=_intent_result,
                        history=history,
                        existing_products=merged_products,
                        retrieval_message=req.message,  # KB path ไม่มี retrieval_message → ใช้ req.message
                        anchor_card=anchor_card,
                        hybrid_anchor_card=_hybrid_anchor_card,
                        llm_ctx_limit=_llm_ctx_limit,
                        resolve_subtype_fn=_resolve_charger_subtype,
                    )
                    if _kb_device_products:
                        merged_products = merged_products + _kb_device_products
                        print(f"[DEVICE-SPEC-LOOKUP-KB] merge {len(_kb_device_products)} สินค้าจาก re-query เข้า merged_products (now {len(merged_products)})", file=sys.stderr)

                    try:
                        answer, usage_info = llm.answer(
                            message=getattr(req, "_followup_original", None) or req.message,
                            products=merged_products,
                            shop_hint=req.shop,
                            history=_qa10,
                            persona_extra=_persona_extra,
                            intent_result=_intent_result,
                            extra_context=(_vision_context + _hybrid_extra_ctx + _kb_device_extra).strip(),
                        )
                    except RuntimeError as exc:
                        raise HTTPException(status_code=500, detail=str(exc))
                    _total_elapsed = _time.time() - _total_start

                    prompt_t = usage_info.get("prompt", 0)
                    output_t = usage_info.get("output", 0)
                    cost = llm._gemini_cost(prompt_t, output_t)
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
                    products = [knowledge_base._kb_doc_to_card(d) if "_kb_only" in d else d for d in merged_products]
                    # dedup สินค้าที่ชื่อใกล้เคียงกัน (เช่น P01 ซ้ำหลาย listing ต่าง prefix โปร)
                    # ⚡ 2026-09-16 — ใช้ _dedupe_products ระดับโมดูล (รวม _kb_base_name/_kb_sell_score)
                    products = product_store._dedupe_products(products, log_label="DEDUP-KB")
                    # ⚡ Phase 8 — จำกัด product cards ที่ส่งเป็น LLM context (30 ชิ้น)
                    #   frontend display ยังใช้ req.limit ใน ChatResponse (ด้านล่าง)
                    products = products[:_llm_ctx_limit] if len(products) > _llm_ctx_limit else products
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
                        _add_context_note(products, _kb_unlist_note)
                    answer = _append_base_warranty(answer, getattr(req, "_followup_original", None) or req.message)
                    _timing_breakdown["total"] = round(_time.time() - _total_start, 3)

                    # ── Web search fallback (ด่านสุดท้าย) ──
                    # ⚡ Legacy Fix — ใช้ _web_search_reanswer ร่วมกับ product_store branch
                    #   search_and_extract → re-query DB → LLM2 ตอบ (search ไม่ตอบตรง)
                    from . import web_search as _ws_kb_check
                    _kb_ws_used = False
                    _ws_r: dict = {"search_used": False, "search_model": ""}
                    if _ws_kb_check.is_configured():
                        _kb_should_search, _kb_search_reason = _ws_kb_check.should_use_web_search(
                            answer=answer,
                            intent_result=_intent_result,
                            products=products,
                            message=req.message,
                        )
                        if _kb_should_search:
                            print(f"[WEB-SEARCH] triggered (kb+mongo): {_kb_search_reason}", file=sys.stderr)
                            _ws_r = _ws_kb_check.reanswer(
                                db=db,
                                llm_ctx_limit=_llm_ctx_limit,
                                search_message=req.message,
                                llm_message=getattr(req, "_followup_original", None) or req.message,
                                products_in=products,
                                reason=_kb_search_reason,
                                shop=req.shop,
                                platform=req.platform,
                                history_list=_qa10,
                                persona_extra=_persona_extra,
                                intent_result=_intent_result,
                                vision_context=_vision_context,
                                do_kb_lookup=False,  # KB branch ไม่ re-query KB (มี KB อยู่แล้ว)
                                do_model_code_regex=False,  # KB branch ไม่ใช้ model code regex
                                do_dedup_rerank=False,  # KB branch ไม่ dedup/rerank (ใช้ products เดิม)
                                req_limit=req.limit,
                            )
                            if _ws_r.get("search_used") and _ws_r.get("answer"):
                                # merge steps จาก _web_search_reanswer เข้า _steps
                                _steps.extend(_ws_r["steps"])
                                answer = _ws_r["answer"]
                                usage_info = _ws_r["usage"]
                                products = _ws_r["products"]
                                _ws_cost = _ws_r["cost_usd"]
                                _ws_elapsed = _ws_r["search_elapsed"]
                                _total_elapsed = _time.time() - _total_start

                                prompt_t = usage_info.get("prompt", 0)
                                output_t = usage_info.get("output", 0)
                                cost = llm._gemini_cost(prompt_t, output_t)
                                _timing_breakdown["web_search"] = _ws_elapsed
                                _timing_breakdown["total"] = round(_total_elapsed, 2)
                                _kb_ws_used = True
                                print(f"[WEB-SEARCH] KB branch reanswer done  total={_total_elapsed:.2f}s  products={len(products)}", file=sys.stderr)

                    # ⚡ Legacy Fix — source label สะท้อน web search ที่ใช้
                    _kb_source = "knowledge_base+mongo+web_search" if _kb_ws_used else "knowledge_base+mongo"
                    # ⚡ บันทึก suggestion products ลง conversation_products timeline
                    #    กัน case: kb+mongo ตอบแล้วไม่บันทึก → active product ว่าง
                    #    → คำถามถัดไป (เช่น "ขอลิงค์กับรูป") ไม่มี active ใช้ → ดึงสินค้าอื่นมาแทน
                    _record_suggestion_products(req, products[:req.limit])
                    return ChatResponse(
                        answer=answer,
                        answer_segments=llm.split_segments(answer),
                        products=products[:req.limit],
                        shop=req.shop,
                        model=model_name,
                        source=_kb_source,
                        usage=usage_info,
                        elapsed=round(_total_elapsed, 2),
                        cost=round(cost, 6),
                        intent=_intent_result,
                        timing=_timing_breakdown,
                        web_search_used=_kb_ws_used,
                        web_search_reason=_kb_search_reason if _kb_ws_used else None,
                        web_search_model=_ws_r.get("search_model") if _kb_ws_used else None,
                        steps=_steps,
                        routing_decision=_routing("bot_reply", "kb+mongo: พบใน knowledge base + product store → บอทตอบ"),
                        image_desc=_image_desc_out,
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
        # ⚡ Phase 1F — ถ้า message เป็น placeholder รูป/วิดีโอทั้งหมด + มี vision context
        #    ให้ใช้ vision description แทนใน retrieval (กัน "[รูปภาพ]" ดึงสินค้าไม่ได้)
        # ⚡ ขยาย: ถ้า message อ้างถึงรูป ("ในรูป", "รูปนี้", "ตัวนี้") + มี vision context
        #    ให้ใช้ vision desc เป็น retrieval query ด้วย (เช่น "น้องในรูปคือตัวอะไร")
        _placeholder_pattern = r'^(?:\s*\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]\s*)+$'
        _image_ref_pattern = r'(?:ในรูป|ในรุป|รูปนี้|รูปที่|ตัวนี้|ตัวในรูป|น้องในรูป|น้องในรุป|สินค้าในรูป|ของในรูป)'
        _use_vision_for_retrieval = (
            _vision_context and (
                re.match(_placeholder_pattern, req.message.strip())
                or re.search(_image_ref_pattern, req.message, re.IGNORECASE)
            )
        )
        if _use_vision_for_retrieval:
            # สกัด text จาก vision context (ตัด header/footer)
            _vision_text = re.sub(
                r'=== รูปภาพที่ลูกค้าส่งมา ===\n', '', _vision_context
            )
            _vision_text = re.sub(r'⚠️.*$', '', _vision_text, flags=re.DOTALL).strip()
            if _vision_text:
                retrieval_message = _vision_text[:200]  # จำกัดความยาว
                print(f"[VISION-RETRIEVAL] using vision desc for retrieval: {retrieval_message[:80]!r}", file=sys.stderr)
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
        # ⚡ 2026-09-14 — ถ้ามี _hybrid_anchor_card → ข้าม compat-retrieval override
        #   เพราะ hybrid augmentation (บรรทัด ~742) ใส่ subtype จาก anchor (สินค้าจริง) ไปแล้ว
        #   แม่นกว่า intent classifier ที่อาจจัด subtype ผิด (เช่น "อยากได้ของ" vague → sub=null/adapter)
        #   ถ้าให้ compat-retrieval override ทับ → subtype จาก anchor หาย → ดึงหัวชาร์จแทนสายชาร์จ
        if _hybrid_anchor_card:
            print(f"[COMPAT-RETRIEVAL] skip — hybrid_anchor_card มี subtype จาก anchor แล้ว", file=sys.stderr)
        elif _intent_result.get("intent") == "compatibility_check" and _intent_result.get("product_type") and not _is_charging_spec_pre:
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
                    m.text
                    for m in req.history
                    if m.role == "user" and (m.text or '').strip()
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

        # ⚡ LINK-FOLLOWUP — ลูกค้าขอลิงค์/ช่องทางซื้อ → ดึง anchor+suggestion ล่าสุดมาตอบ
        #   กัน case: Q1 บอทแนะนำ ZA353 → Q3 "ขอลิงค์สินค้า" → RAG ใหม่ → ดึง ZA453 ผิดรุ่น
        #   แก้: ถ้าลูกค้าขอลิงค์/ช่องทางซื้อ และมีสินค้าก่อนหน้าใน timeline → ใช้สินค้านั้น
        #   ⚡ ต้องทำก่อน CONV-ACTIVE เพราะ CONV-ACTIVE ดึง active product แค่ 1 ตัว
        #      และตั้ง _is_conv_active=True → LINK-FOLLOWUP จะไม่ทำงาน
        _is_link_followup = False
        _link_followup_kws = (
            "ลิงค์", "ลิงก์", "ลิ้งค์", "ลิ้งก์", "link", "ขอลิงค์", "ขอลิงก์",
            "ขอลิ้งค์", "ขอลิ้งก์", "ขอ link", "ขอ url", "url",
            "ช่องทางซื้อ", "สั่งซื้อ", "ขอสั่ง", "ขอซื้อ", "สั่งได้เลย",
            "ส่งลิงค์", "ส่งลิงก์", "ส่ง link", "ขอเว็บ", "เว็บสินค้า",
        )
        _is_link_followup = (
            req.conversation_id
            and any(kw in (req.message or "").lower() for kw in _link_followup_kws)
            and not any(kw in (req.message or "").lower() for kw in (
                # ห้าม trigger ในเคส warranty/refund/cancel
                "เคลม", "รับประกัน", "ประกัน", "คืนเงิน", "ขอเงินคืน",
                "ยกเลิก", "ส่งคืน", "ไม่รับ", "ใบกำกับ", "ใบเสร็จ",
            ))
        )
        if _is_link_followup:
            try:
                from . import conversation_products as _cp_link
                _link_products = _cp_link.get_anchor_and_suggestions(req.conversation_id, limit=5)
                if _link_products:
                    # กรองเฉพาะที่มี short_link หรือ image_url (มีประโยชน์ให้ LLM ส่งได้)
                    _link_products = [
                        p for p in _link_products
                        if p.get("short_link") or p.get("image_url")
                    ]
                if _link_products:
                    _ref_regex_products = _link_products
                    _is_conv_active = True
                    print(f"[LINK-FOLLOWUP] ใช้สินค้าก่อนหน้า: {len(_link_products)} ตัว  names={[p.get('name','')[:30] for p in _link_products[:3]]}", file=sys.stderr)
                else:
                    print(f"[LINK-FOLLOWUP] ไม่มีสินค้าก่อนหน้าใน timeline → fall through", file=sys.stderr)
            except Exception as _e:
                print(f"[LINK-FOLLOWUP] error: {_e}", file=sys.stderr)

        # ⚡ CONV-ACTIVE: ดึง active product จาก conversation_products timeline ก่อน history-words
        # ต้องทำก่อน history block เพราะ history-words อาจดึงสินค้าอื่นในร้านมาทับ anchor
        # เช่น "kieslect" ใน history → ดึง Ks, Lora 2, KR Pro ทั้งที่ active = BioKoop
        # ⚡ Phase 2Z+++ — อนุญาตให้ CONV-ACTIVE ทำงานแม้ _ref_handled=True
        #    กัน case: ลูกค้าส่ง [item] → bot ตอบ → ลูกค้าถาม "อันนี้..." (ref_handled)
        #    → CONV-ACTIVE ไม่ทำงาน → ดึงสินค้าอื่น → ตอบผิด
        # ⚡ ถ้า LINK-FOLLOWUP ตั้ง _is_conv_active=True แล้ว → ข้าม CONV-ACTIVE
        _cur_charger_sub = product_store._detect_charger_subtype(req.message)
        print(f"[CONV-ACTIVE-DBG] conversation_id={req.conversation_id!r} charger_sub={_cur_charger_sub!r} ref_handled={_ref_handled} link_followup={_is_link_followup}", file=sys.stderr)
        # ⚡ Phase 3 — ยกเลิกเงื่อนไข `not _cur_charger_sub` เพราะ "สายแท้" ถูก detect เป็น cable
        #   ทำให้ CONV-ACTIVE ไม่ทำงานทั้งที่ลูกค้าถามต่อเรื่องสายชาร์จเดิม
        #   แต่เช็คเพิ่ม: ถ้า _cur_charger_sub มีค่าและต่างจาก subtype ของ active_card → เปลี่ยนหมวด ไป fetch ใหม่
        if req.conversation_id and not _is_conv_active:
            try:
                from . import conversation_products as _cp
                _cur_model_kw = knowledge_base.extract_model_keywords(req.message)
                # ⚡ Phase 3 — กรอง target device ออกจาก _cur_model_kw
                _cur_model_kw = [kw for kw in _cur_model_kw if not knowledge_base.is_target_device_kw(kw)]
                _active_card = _cp.resolve_active_by_message(
                    conversation_id=req.conversation_id,
                    message=req.message,
                    model_keywords=_cur_model_kw,
                )
                if _active_card and _active_card.get("item_id"):
                    # ⚡ Phase 3 — เช็ค subtype ของ active_card ว่าตรงกับ _cur_charger_sub ไหม
                    #   ถ้าลูกค้าเปลี่ยนจาก cable → adapter จริงๆ → ไม่ใช้ active (ไป fetch ใหม่)
                    #   แต่ "หัว" ลอยๆ (เช่น "ปัญหาเรื่องหัว ชาน") ไม่ใช่การเปลี่ยนหมวด จึงต้องเช็ค
                    #   adapter keyword ชัดเจน (หัวชาร์จ/adapter/gan) ไม่ใช่แค่ "หัว" ลอยๆ
                    _active_sub = product_store._detect_charger_subtype(
                        _active_card.get("name") or _active_card.get("item_name") or ""
                    )
                    _strong_adapter_kw = ("หัวชาร์จ", "หัวชาร์ต", "adapter", "แอ็ดอปเตอร์", "gan", "qc 3", "pd fast")
                    _has_strong_adapter = any(kw in (req.message or "").lower() for kw in _strong_adapter_kw)
                    if _cur_charger_sub == "adapter" and _active_sub == "cable" and not _has_strong_adapter:
                        # "หัว" ลอยๆ ไม่ใช่การเปลี่ยนหมวด → ใช้ active ต่อ
                        print(f"[CONV-ACTIVE] 'หัว' ลอยๆ ไม่ใช่ adapter จริง → ใช้ active ต่อ", file=sys.stderr)
                        _cur_charger_sub = None  # reset เพื่อไม่ให้กรอง subtype ผิด
                    elif _cur_charger_sub and _active_sub and _cur_charger_sub != _active_sub:
                        print(f"[CONV-ACTIVE] subtype เปลี่ยน {_active_sub} → {_cur_charger_sub} → ไม่ใช้ active", file=sys.stderr)
                        # ไม่ใช้ active → ไป fetch ใหม่ (ข้าม block ด้านล่าง)
                        _active_card = None
                    # (fall through ไปเช็ค _is_new_topic_cp ข้างล่าง)
                    if _active_card:
                        # ⚡ Fix EC6 bug — กรอง model keyword ที่ตรงกับชื่อ active product ออก
                        #   เช่น "Ec6" ตรงกับ "EC6 Panorama" → ไม่ใช่ new topic → ใช้ anchor ต่อ
                        #   กรองเฉพาะ keyword ที่มีตัวเลข (model code pattern) เพื่อกัน brand name
                        #   เช่น "IMILAB" ไม่มีตัวเลข → ไม่กรอง → อาจเป็นการถามรุ่นอื่นของแบรนด์เดียวกัน
                        _kw_matched_anchor = False
                        if _cur_model_kw:
                            _active_name = (_active_card.get("name") or _active_card.get("item_name") or "").lower()
                            if _active_name:
                                _filtered_kw = [kw for kw in _cur_model_kw
                                                if not (re.search(r"\d", kw) and kw.lower() in _active_name)]
                                if len(_filtered_kw) < len(_cur_model_kw):
                                    _kw_matched_anchor = True
                                _cur_model_kw = _filtered_kw
                        _cur_msg_lower = (req.message or "").lower().strip()
                        _new_topic_kws_cp = ("สวัสดี", "หวัดดี", "hi", "hello", "แนะนำ",
                                             "มีอะไร", "มีไร",
                                             "สนใจ", "อยากได้", "หาสินค้า")
                        _is_new_topic_cp = any(kw in _cur_msg_lower for kw in _new_topic_kws_cp)
                        # ⚡ 2026-09-12 — guard "อยากได้" ด้วย compat indicator (เหมือน item_tag block)
                        #   ถ้ามี compat kw ("ใช้กับ/รองรับ") → ไม่ใช่ new topic → แต่ก็ไม่ใช้ active เป็น product เดียว
                        #   ให้ fall through ไป fetch_products + merge anchor ภายหลัง
                        _compat_kws_cp = ("ใช้กับ", "รองรับ", "สำหรับ", "compatible", "support", "works with")
                        _has_compat_cp = any(kw in _cur_msg_lower for kw in _compat_kws_cp)
                        if _is_new_topic_cp and _has_compat_cp and not _cur_model_kw:
                            _is_new_topic_cp = False  # ไม่ใช่ new topic → เข้าเงื่อนไขข้างล่าง
                        if not _is_new_topic_cp and not _cur_model_kw:
                            # ⚡ ถ้ามี compat + target_device → ไม่ใช้ active เป็น product เดียว
                            #   ให้ fall through ไป fetch_products + merge anchor ภายหลัง
                            #   ⚡ แต่ถ้า keyword ตรง anchor → ลูกค้าถามเรื่องสินค้าเดิม ไม่ใช่ขอใหม่ → ใช้ anchor
                            _phone_brands_cp = ("iphone", "ipad", "samsung", "xiaomi", "redmi",
                                               "huawei", "honor", "oppo", "vivo", "realme",
                                               "poco", "oneplus", "pixel", "mi ", "note ", "ultra")
                            _has_target_cp = any(b in _cur_msg_lower for b in _phone_brands_cp)
                            if _has_compat_cp and _has_target_cp and not _kw_matched_anchor:
                                print(f"[CONV-ACTIVE] compat+target_device → ไม่ใช้ active เป็น product เดียว → fall through", file=sys.stderr)
                                # ไม่ตั้ง _ref_regex_products → ไป fetch_products
                            elif _anchor_compare_ctx or _is_superlative_q:
                                # ⚡ compare/superlative ต้องการ pool ≥2 ใบ — pin active เดี่ยว
                                #   ทำ fetch block ข้างล่าง unreachable (superlative boost ตาย)
                                #   merge ที่ ANCHOR-COMP-MERGE จะใส่คู่เปรียบเทียบเข้า products เอง
                                print(f"[CONV-ACTIVE] compare/superlative ctx → ไม่ pin active เดี่ยว → fetch ปกติ", file=sys.stderr)
                            else:
                                _ref_regex_products = [_active_card]
                                _is_conv_active = True
                                print(f"[CONV-ACTIVE] ใช้ active product จาก timeline: item_id={_active_card.get('item_id')} name={_active_card.get('name','')[:40]}", file=sys.stderr)
            except Exception as _e:
                print(f"[CONV-ACTIVE] error: {_e}", file=sys.stderr)

        if req.history and not _is_conv_active:
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
                    "ต่างกัน", "ต่างไหม", "ต่างกันไหม", "ต่างกันยังไง",
                    "อะไรต่าง", "อะไรดี", "ดีกว่า", "สูงกว่า", "แรงกว่า",
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
                # ⚡ Phase 2Z+++ — เพิ่ม "รุ่นไหนประกัน" เป็น reference indicator
                #    กัน case: "รุ่นไหนประกันยังไงบ้าง" หลัง bot แนะนำพาวเวอร์แบงค์ → ตอบสายชาร์จผิด
                #    (เจาะจงเฉพาะ "รุ่นไหนประกัน" ไม่ใช่ "รุ่นไหน" เฉยๆ เพราะอาจเป็นคำถามใหม่)
                "รุ่นไหนประกัน", "รุ่นไหนรับประกัน", "รุ่นไหนบ้างประกัน",
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
                    # ⚡ fallback: ถ้ายังไม่จับ ลอง charger_subtype (มี logic แก้พิมพ์ผิด "หัวชาจ" → "หัวชาร์จ")
                    # ทำให้ history "หัวชาจ" (พิมพ์ตก ร์) ถูก carry เป็น charger type ได้
                    if not pt and product_store._detect_charger_subtype(hmsg):
                        pt = {"charger"}
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
            # ⚡ เพิ่ม: ถ้า message ปัจจุบันมี charger_subtype ชัด (เช่น "หัวชาจ") ก็ถือว่าเป็น charger context
            #   เพราะ _detect_product_types ไม่จับ "หัวชาจ" (พิมพ์ตก) แต่ _detect_charger_subtype จับได้
            _is_charger_ctx = (
                "charger" in (current_types or set())
                or product_store._detect_charger_subtype(req.message) is not None
            )
            if _is_charger_ctx and not is_new_topic and not product_store._detect_charger_subtype(req.message):
                try:
                    _all_prev_user_msgs = [
                        m.text
                        for m in req.history
                        if m.role == "user" and (m.text or '').strip()
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
            # ⚡ ถ้าคำถามปัจจุบันระบุ charger subtype ชัดเจน (หัวชาร์จ/สายชาร์จ/ชุดชาร์จ)
            # → เป็นคำถามใหม่เกี่ยวกับ subtype นั้น ไม่ใช่ follow-up ถึงสินค้าเดิม
            # ห้ามให้ reference logic ดึงชื่อสินค้าเก่า (ที่อาจเป็น subtype ต่างกัน) มาปนใน retrieval
            # เพราะทำให้ brand/model filter กรองสินค้า subtype ที่ลูกค้าถามออกหมด
            # (เช่น ถาม "มีหัวชาร์จไหม" หลัง bot แนะนำสายชาร์จ CTC615N → ได้แต่ CTC615N)
            _cur_charger_sub_ref = (
                (_intent_result or {}).get("charger_subtype")
                if (_intent_result or {}).get("product_type") == "charger"
                else product_store._detect_charger_subtype(req.message)
            )
            _skip_ref_due_to_subtype = _cur_charger_sub_ref in ("adapter", "cable", "set", "car_charger")
            _is_ref_like = (
                is_reference_question
                or (_is_short_followup and not is_other_model_question and not is_new_topic
                    and not _skip_ref_due_to_subtype)
                or (_is_generic_followup and not is_other_model_question
                    and not _skip_ref_due_to_subtype)
            )
            if _is_ref_like and not is_new_topic and not is_other_model_question:
                all_model_texts_ref = [
                    m.text for m in req.history
                    if m.role == "model" and m.text.strip()
                ]
                if all_model_texts_ref:
                    latest_bot_answer = all_model_texts_ref[-1]
                    # ── ดึงชื่อสินค้าเต็มจาก markdown link ก่อน (แม่นยำกว่า) ──
                    # เช่น [CUKTECH AD1003T + CMC615P เซตหัวชาร์จ Adapter 100W](https://...)
                    # → ใช้ "CUKTECH AD1003T + CMC615P เซตหัวชาร์จ Adapter 100W" เป็น retrieval
                    _md_link_products = re.findall(
                        r"\[([^\]]{5,120})\]\(https?://",
                        latest_bot_answer,
                    )
                    ref_models = []
                    # ⚡ เช็คว่าเป็น comparison question ไหม — ถ้าใช่ ดึงทุกรุ่นจาก markdown link
                    _comparison_kws_ref = ("ต่างกัน", "ต่างไหม", "เปรียบเทียบ", "vs", "ดีกว่า", "สูงกว่า", "แรงกว่า")
                    _is_comparison_ref = any(kw in req.message.lower() for kw in _comparison_kws_ref)
                    if _md_link_products:
                        # ใช้ product name จาก markdown link ที่ไม่ใช่ "สั่งซื้อ..."
                        for _pname in _md_link_products:
                            if _pname.lower().startswith(("สั่งซื้อ", "ดูรายละเอียด", "ลิงก์")):
                                continue
                            ref_models.append(_pname.strip())
                            if not _is_comparison_ref:
                                break  # กรณีปกติ เอาแค่รุ่นแรก
                        if ref_models:
                            print(f"[REFERENCE] ดึงชื่อสินค้าจาก markdown link: {ref_models}", file=sys.stderr)

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
                            matches = re.findall(pattern, latest_bot_answer, re.IGNORECASE)
                            for m in matches:
                                full = f"{brand} {m}"
                                if full.lower() not in [x.lower() for x in ref_models]:
                                    ref_models.append(full)
                        # pattern 2: word(2+) + space + alphanumeric(2+) ที่มีตัวเลข
                        all_patterns = re.findall(
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
                            if not re.search(r"\d", model_part):
                                continue
                            if re.fullmatch(r"\d+", model_part):
                                continue
                            full = f"{brand_part} {model_part}"
                            if full.lower() not in [x.lower() for x in ref_models]:
                                ref_models.append(full)
                    if ref_models and not _is_superlative_q:
                        # เช็ค subtype ของ message ปัจจุบัน ถ้าเป็น cable และ ref_model เป็น adapter → ไม่ดึง
                        _cur_sub_ref = product_store._detect_charger_subtype(req.message)
                        # ⚡ คำนวณ subtype ของ ref_models (จากชื่อสินค้าในคำตอบล่าสุด)
                        _ref_text = " ".join(ref_models)
                        _ref_sub = product_store._detect_charger_subtype(_ref_text)
                        _ref_is_cable = _ref_sub == "cable"
                        _ref_is_adapter = _ref_sub == "adapter"
                        if _cur_sub_ref == "cable" and _ref_is_adapter and not _ref_is_cable:
                            print(f"[REFERENCE] skip: ลูกค้าถาม cable แต่ ref เป็น adapter: {ref_models[0]}", file=sys.stderr)
                        elif _cur_sub_ref == "adapter" and _ref_is_cable and not _ref_is_adapter:
                            print(f"[REFERENCE] skip: ลูกค้าถาม adapter แต่ ref เป็น cable: {ref_models[0]}", file=sys.stderr)
                        elif _cur_sub_ref in ("adapter", "cable", "set") and not _ref_is_adapter and not _ref_is_cable:
                            # ⚡ ref ไม่มี charger keyword เลย (เช่น "CUKTECH CTC615N" จาก markdown link รูป)
                            # → ยืนยัน subtype ของ ref ไม่ได้ → ห้าม override กันกรองสินค้าผิดประเภท
                            print(f"[REFERENCE] skip: คำถามเป็น charger subtype={_cur_sub_ref} แต่ ref ไม่มี charger keyword: {ref_models[0]}", file=sys.stderr)
                        else:
                            # ⚡ comparison follow-up: ถ้าคำถามเป็นการเปรียบเทียบ ("ต่างกัน", "vs", "ดีกว่า")
                            # และมี ref_models มากกว่า 1 → ใช้ทุกรุ่นใน retrieval
                            _comparison_kws = ("ต่างกัน", "ต่างไหม", "เปรียบเทียบ", "vs", "ดีกว่า", "สูงกว่า", "แรงกว่า")
                            _is_comparison_q = any(kw in req.message.lower() for kw in _comparison_kws)
                            if _is_comparison_q and len(ref_models) >= 2:
                                retrieval_message = f"{' vs '.join(ref_models[:4])} {req.message}"
                                print(f"[REFERENCE] comparison follow-up: ดึง {len(ref_models[:4])} รุ่นจากคำตอบล่าสุด: {ref_models[:4]}", file=sys.stderr)
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
            # ⚡ Partial comparison: ถ้า _is_partial_comp → ไม่ถือว่า ref_handled
            #   เพราะลูกค้าตั้งใจระบุ model อื่น (เช่น "swim") ต้องไป fetch สินค้านั้นด้วย
            #   ถ้าถือว่า ref_handled → MODEL-REGEX จะถูกข้าม → ไม่เจอ Swim
            if _ref_handled and _is_partial_comp:
                _ref_handled = False
                print(f"[REFERENCE] partial comparison → ไม่ถือ ref_handled (ต้อง fetch model อื่นด้วย)", file=sys.stderr)
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
        # ⚡ อย่า reset _ref_regex_products ถ้า CONV-ACTIVE ตั้งไว้แล้ว
        if not _is_conv_active:
            _ref_regex_products: list[dict] = []
        if _ref_handled and retrieval_message != req.message:
            # หา model word ที่มี digit (เช่น "A3", "EC4", "Note 13")
            _ref_model_words = [
                w for w in re.split(r"\s+", retrieval_message.lower().strip())
                if any(c.isdigit() for c in w) and len(w) >= 2
                and not re.fullmatch(r"\d+\.?", w)  # ไม่เอาตัวเลขล้วน
            ]
            if _ref_model_words:
                # ⚡ Comparison question: ถ้ามีหลาย model words (เช่น "ctc615u", "ctc615w")
                # ให้ดึงสินค้าที่ match ทุกรุ่น ไม่ใช่แค่รุ่นแรก
                _comparison_kws_ref2 = ("ต่างกัน", "ต่างไหม", "เปรียบเทียบ", "vs", "ดีกว่า", "สูงกว่า", "แรงกว่า")
                _is_comparison_ref2 = any(kw in req.message.lower() for kw in _comparison_kws_ref2)
                _ref_kws_to_query = _ref_model_words if _is_comparison_ref2 else _ref_model_words[:1]
                # ⚡ Comparison: ถ้า message ลูกค้ามี model token ที่มี digit (เช่น "615u")
                # ให้ใช้ model token จาก req.message เป็นหลัก ไม่ใช่จาก retrieval_message
                # ที่ปนกับ reference extraction (เช่น "ctc620p" จากคำตอบก่อนหน้า)
                # เพราะลูกค้าถามเปรียบเทียบรุ่นที่ตนเองระบุ ไม่ใช่รุ่นที่ bot แนะนำ
                if _is_comparison_ref2:
                    _msg_model_words = [
                        w for w in re.split(r"\s+", req.message.lower().strip())
                        if any(c.isdigit() for c in w) and len(w) >= 2
                        and not re.fullmatch(r"\d+\.?", w)
                    ]
                    if _msg_model_words:
                        _ref_kws_to_query = _msg_model_words
                        # ⚡ ตีความตัวอักษรลอยๆ ("w", "u", "p", "s", "n") เป็น "{prefix}{letter}"
                        # (เช่น "615u กับ w" → "615w", "615w กับ u" → "615u")
                        # โดยใช้ digit prefix จาก model token อื่นใน message
                        _msg_lower = req.message.lower()
                        # หา digit prefix จาก model token แรกที่มี digit
                        _digit_prefix = None
                        for _mw in _msg_model_words:
                            _digit_part = re.match(r"(\d+)", _mw)
                            if _digit_part:
                                _digit_prefix = _digit_part.group(1)
                                break
                        if _digit_prefix:
                            # หาตัวอักษรลอยๆ ที่ตามหลัง "กับ" หรืออยู่ท้ายประโยค
                            _lone_letters = re.findall(r"\b([a-z])\b", _msg_lower)
                            # กรองตัวที่เป็นส่วนหนึ่งของ model token แล้ว
                            _existing_suffixes = set()
                            for _mw in _msg_model_words:
                                _suffix = re.match(r"\d+([a-z]+)", _mw)
                                if _suffix:
                                    _existing_suffixes.add(_suffix.group(1))
                            for _letter in _lone_letters:
                                if _letter in _existing_suffixes:
                                    continue
                                _derived = f"{_digit_prefix}{_letter}"
                                if _derived not in _ref_kws_to_query:
                                    _ref_kws_to_query.append(_derived)
                                    print(f"[REF-REGEX] ตีความ '{_letter}' ลอยๆ → {_derived!r} (จาก prefix {_digit_prefix!r})", file=sys.stderr)
                try:
                    _ref_coll = db[os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"]
                    _seen_ids: set = set()
                    for _ref_kw in _ref_kws_to_query:
                        # ⚡ model token สั้น (เช่น "615u") ไม่มี letter prefix → \b ไม่ match "CTC615U"
                        # ใช้ regex แบบไม่มี \b ที่ต้น แต่มี \b ท้าย (กัน match ผิด เช่น "615u" ไม่ match "615uu")
                        _has_alpha_prefix = bool(re.match(r"^[a-z]+", _ref_kw))
                        if _has_alpha_prefix:
                            _kw_pattern = rf"\b{re.escape(_ref_kw)}\b"
                        else:
                            _kw_pattern = rf"{re.escape(_ref_kw)}\b"
                        _ref_filter = {
                            "item_status": "NORMAL",
                            "item_name": {"$regex": _kw_pattern, "$options": "i"},
                        }
                        if req.shop:
                            _ref_filter["shopname"] = {"$regex": f"^{re.escape(req.shop)}$", "$options": "i"}
                        _ref_docs = list(_ref_coll.find(_ref_filter, product_store.PRODUCT_PROJECTION).limit(10))
                        # ⚡ Comparison: กรองเอาเฉพาะสินค้าที่ชื่อขึ้นต้นด้วย model token (standalone)
                        # ไม่เอาชุด/แถมที่มี model token แค่เป็นส่วนประกอบ (เช่น "AC30S / CTC615W หัวชาร์จ")
                        if _is_comparison_ref2:
                            _ref_docs_filtered = []
                            for d in _ref_docs:
                                _name = (d.get("item_name") or "").strip()
                                _name_lower = _name.lower()
                                # ข้ามสินค้าที่มี keyword บอกว่าเป็นชุด/แถม/หัวชาร์จ
                                _skip_kws = ("แถมฟรี", "หัวชาร์จ", "ชุดชาร์จ", "เซ็ต", "set", "combo",
                                             "adapter", "gan", "หัวชาร์ต", "พาวเวอร์แบงค์", "powerbank")
                                # ต้องมี model token อยู่ในชื่อ และไม่ใช่ชุด/แถม
                                if _ref_kw in _name_lower and not any(kw in _name_lower for kw in _skip_kws):
                                    _ref_docs_filtered.append(d)
                            _ref_docs = _ref_docs_filtered if _ref_docs_filtered else _ref_docs
                        for d in _ref_docs[:5]:
                            iid = str(d.get("item_id"))
                            if iid not in _seen_ids:
                                _seen_ids.add(iid)
                                _ref_regex_products.append(product_store.to_product_card(d, req.message))
                    if _ref_regex_products:
                        print(f"[REF-REGEX] ดึงสินค้าตรง model {_ref_kws_to_query} ด้วย Mongo regex: {len(_ref_regex_products)} ตัว", file=sys.stderr)
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
                # ⚡ Partial comparison: ลด minimum เป็น 4 ตัวอักษร (เช่น "swim", "run")
                _min_alpha_chars = 4 if _is_partial_comp else 5
                _cur_alpha_kws = re.findall(r"[A-Za-z]{%d,}" % _min_alpha_chars, req.message)
                # กรองคำทั่วไปที่ไม่ใช่ชื่อสินค้า
                _common_words = {"watch", "smart", "phone", "cable", "charger", "adapter",
                                 "power", "bank", "band", "type", "usb", "wireless",
                                 "what", "how", "please", "thank", "hello", "hi",
                                 # ⚡ version/region words — กัน "Version" ดึง TP-Link "Global Version"
                                 "version", "global", "china", "international", "original",
                                 "authentic", "local", "origin", "korea", "hongkong"}
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
        # ⚡ ห้าม carry-forward เมื่อคำถามปัจจุบันระบุ charger subtype ชัด (หัว/สาย/ชุด/ฯลฯ)
        # เพราะแปลว่าลูกค้าถามหา subtype ใหม่ ไม่ใช่ follow-up สินค้าเดิม
        # (เช่น "มีหัวไหม" หลัง bot แนะนำสายชาร์จ → ห้ามดึงสายชาร์จเดิมมา carry)
        _is_carry_forward = False
        # ⚡ _is_conv_active และ _cur_charger_sub ถูก set ก่อน history block (ที่บรรทัด ~2124)
        # ไม่ต้อง reset ที่นี่ เพราะอาจถูก set แล้วจาก CONV-ACTIVE check

        if not _ref_regex_products and not _ref_handled and req.history and not _cur_charger_sub:
            _cur_has_model_kw = bool(knowledge_base.extract_model_keywords(req.message))
            _cur_msg_lower = (req.message or "").lower().strip()
            # ⚡ ขยาย carry-forward ให้รองรับ message ยาวขึ้น (<= 25 คำ)
            # เพราะคำถาม follow-up อาจยาว เช่น "ถ้าผมซื้อแล้วผมเชื่อถือได้ใช่ไหมครับมีการรับประกันนะครับ"
            _is_short_followup = len(req.message.split()) <= 25 and not _cur_has_model_kw
            # ไม่ใช่ new topic (เช่น "สวัสดี", "มีอะไรแนะนำไหม")
            _is_new_topic = any(kw in _cur_msg_lower for kw in _NEW_TOPIC_KWS)
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
        # ⚡ set default ก่อน if block (กัน UnboundLocalError ถ้า _ref_regex_products ผ่าน path นี้)
        _super_has_charge = "ชาร์จ" in retrieval_message or "charger" in retrieval_message.lower()
        _super_has_pb = "พาวเวอร์แบงค์" in retrieval_message or "แบตสำรอง" in retrieval_message or "powerbank" in retrieval_message.lower()
        _super_has_history = bool(req.history and any(m.role == "user" and m.text.strip() for m in req.history))
        if _ref_regex_products:
            products = _ref_regex_products
            # ⚡ Phase 1F — กรอง charger subtype สำหรับ _ref_regex_products (FUZZY-MATCH/MODEL-REGEX)
            #   เพราะ path เหล่านี้บายพาส fetch_products จึงไม่กรอง subtype
            #   เช่น "สายแรงๆ กว่านี้ใช้กับ mi 17 ultra" → FUZZY-MATCH ดึงแบตสำรองที่ชื่อมี "mi"
            #   แต่ intent บอก cable → ต้องกรองเหลือเฉพาะ cable
            _ref_intent_sub = (
                (_intent_result or {}).get("charger_subtype")
                if (_intent_result or {}).get("product_type") == "charger"
                else None
            )
            if _ref_intent_sub:
                _before_ref_filter = len(products)
                products = product_store._filter_charger_subtype(products, _ref_intent_sub)
                print(f"[REF-SUBTYPE-FILTER] subtype={_ref_intent_sub} → {len(products)} products (was {_before_ref_filter})", file=sys.stderr)
                # ถ้ากรองเหลือ 0 → ไม่ใช้ _ref_regex_products ให้ไป fetch_products ปกติ
                if not products:
                    products = []
                    _ref_regex_products = None
                    print(f"[REF-SUBTYPE-FILTER] เหลือ 0 → ยกเลิก _ref_regex_products ไป fetch_products ปกติ", file=sys.stderr)
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
                _add_context_note(products, _carry_note)
            # ⚡ ถ้าใช้ active product จาก conversation_products timeline
            # บอก LLM ชัดๆ ว่าสินค้านี้คือสินค้าที่ลูกค้าสนใจ ห้ามสลับไปสินค้าอื่น
            if _is_conv_active and products:
                # ⚡ LINK-FOLLOWUP — ลูกค้าขอลิงค์/ช่องทางซื้อ → ส่งลิงค์+รูปของทุกสินค้าใน context
                if _is_link_followup and len(products) > 1:
                    _conv_note = (
                        "⚠️ ลูกค้าขอลิงค์/ช่องทางซื้อของสินค้าที่ bot แนะนำไปก่อนหน้า "
                        "สินค้าใน context คือสินค้าที่ bot แนะนำล่าสุด — "
                        "ให้ส่งลิงค์สั่งซื้อ (short_link) และรูปภาพ (image_url) ของสินค้า status=NORMAL ทุกตัวใน context "
                        "ห้ามตอบแค่ 1 ตัว ห้ามเลือกเองแค่บางตัว "
                        "ห้ามดึงสินค้าอื่นที่ไม่อยู่ใน context มาตอบ"
                    )
                else:
                    _conv_note = (
                        "⚠️ สินค้าใน context คือสินค้าที่ลูกค้าส่งมา/สนใจในแชทนี้ "
                        "ลูกค้ากำลังถามเกี่ยวกับสินค้านี้ต่อเนื่อง "
                        "ห้ามสลับไปแนะนำสินค้าอื่นที่ไม่ใช่สินค้าใน context "
                        "ถ้า bot เคยแนะนำสินค้าอื่นใน history ให้ถือว่าเป็นคำแนะนำ "
                        "ไม่ใช่สินค้าที่ลูกค้าสนใจ — ให้ตอบเกี่ยวกับสินค้าใน context เท่านั้น"
                    )
                _add_context_note(products, _conv_note)
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
                _add_context_note(products, _charging_note)
        else:
            # สำหรับ compatibility check ให้ดึงสินค้าเยอะกว่าปกติ
            # เพราะต้องการให้ LLM เห็นสินค้าทุกรุ่นในหมวด เพื่อเลือกรุ่นที่รองรับ device จริงๆ
            # ⚡ Phase 1F — ถ้า _ref_regex_products ถูกยกเลิก (กรอง subtype เหลือ 0) → ต้องเข้า block นี้ด้วย
            pass  # placeholder — logic จริงอยู่ข้างล่าง
        # ⚡ Phase 1F — ย้าย superlative/fetch logic ออกจาก else block
        #   เพื่อให้ทำงานแม้ _ref_regex_products ถูกยกเลิกใน if block ด้านบน
        if not _ref_regex_products:
            # ⚡ Phase 8 — base fetch limit ใช้ _LLM_CONTEXT_LIMIT (30) ไม่ใช่ req.limit
            #   เพราะนี่คือ RAG retrieval ที่ส่งเข้า LLM context
            _fetch_limit = _llm_ctx_limit
            _is_compat = _intent_result.get("intent") == "compatibility_check"
            # ⚡ Phase 3 — RAG ไม่กรอง status/stock ออกเลย (LLM prompt กรองตอนแนะนำขาย)
            #   ก่อนหน้านี้: filter_unavailable=True กรอง sold_out/non-NORMAL ออกจาก RAG
            #   ทำให้ลูกค้าถามสินค้าเก่าไม่ได้ + ตอบ "ไม่มีข้อมูล" ทั้งที่มีใน description
            #   แก้: ดึงทุกสินค้า (normal + non-normal + sold_out) → LLM prompt กรองตอนแนะนำขาย
            #   (LLM prompt มีกฎชัดเจน: แนะนำขายเฉพาะ status=NORMAL + stock>0)
            if _is_compat:
                _fetch_limit = max(_llm_ctx_limit * 2, 40)
            # superlative question (สุด/ที่สุด/แรงสุด/ไวสุด/มากสุด) → ดึงสินค้าเยอะขึ้น
            # เพื่อให้ LLM เห็นทุกรุ่นแล้วเปรียบเทียบหาอันที่สุดจริง
            # เก็บ context สำหรับ superlative clarification (ใช้ตอนเรียก LLM)
            # ⚡ _super_has_charge/_super_has_pb/_super_has_history ถูก set ก่อน if _ref_regex_products block แล้ว
            if _is_superlative_q:
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
            # ⚡ Phase 1F — ถ้า intent บอก charger_subtype ชัดเจน → ไม่ skip แม้เป็น superlative
            #   (เช่น "สายแรงๆ กว่านี้" → intent=cable → ต้องกรองเป็น cable ไม่ดึงแบต)
            _intent_sub_early = (
                (_intent_result or {}).get("product_type") == "charger"
                and (_intent_result or {}).get("charger_subtype") in (
                    "adapter", "cable", "set", "car_charger", "wireless", "desktop", "socket",
                )
            )
            _skip_sub = _is_superlative_q and not _resolve_charger_subtype(intent_result=_intent_result, retrieval_message=retrieval_message) and not _intent_sub_early

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
            # ⚡ กำหนด _intent_sub = None ก่อนเข้า if/else (ใช้ใน fallback ด้วย)
            _intent_sub = None
            # ⚡ ถ้ามี _ref_regex_products จาก CONV-ACTIVE หรือ MODEL-REGEX แล้ว → ข้าม fetch_products
            # เพราะสินค้าที่ลูกค้าสนใจได้ระบุแล้ว ไม่ต้องค้นใหม่ (products ถูกตั้งที่ if _ref_regex_products บรรทัด ~2975)
            # ⚡ Phase 1F — if not _ref_regex_products ถูกย้ายขึ้นไปข้างบนแล้ว (รวม superlative logic)
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
                # ⚡ ใช้ charger_subtype เป็น override เพื่อกัน retrieval_message ปนเปื้อน
                # ลำดับความสำคัญ (เดิม): intent.charger_subtype > _detect(req.message) > _detect(retrieval_message)
                # - intent แม่นสุด (LLM อ่านประโยคเข้าใจ)
                # - req.message = คำถามจริงของลูกค้า (ไม่ปนเปื้อนด้วยชื่อสินค้าจาก history)
                # - retrieval_message ใช้เป็น last resort (อาจมี "สายชาร์จ" จาก reference logic)
                # ⚡ 2026-09-14 — ถ้ามี _hybrid_anchor_card → ใช้ subtype จาก anchor แม่นกว่า intent
                #   เพราะ anchor = สินค้าจริงที่ลูกค้าสนใจ (เช่น CTL301 = cable)
                #   intent อาจจัดผิดเพราะ "อยากได้ของ" vague → sub=null/adapter → ทับ cable → ดึงหัวชาร์จแทน
                # ⚡ 2026-09-16 — รวมเป็น _resolve_charger_subtype จุดเดียว
                #   priority: anchor > msg-strong > intent > msg > retrieval
                #   กรณีพิเศษ: ลูกค้าถามไม่ระบุ subtype ชัด + มี anchor → ใช้ anchor subtype
                #   เว้นแต่ msg จะพูดถึง subtype อื่นชัดเจน (strong keyword) → override
                _intent_sub = _resolve_charger_subtype(
                    intent_result=_intent_result,
                    retrieval_message=retrieval_message,
                )
                if _intent_sub:
                    print(f"[RESOLVE-SUBTYPE] resolved={_intent_sub} (anchor={bool(_hybrid_anchor_card)}, intent={(_intent_result or {}).get('charger_subtype')})", file=sys.stderr)
                # เติม subtype keyword นำหน้า retrieval เพื่อให้ MongoDB query/vector search เจอสินค้า subtype ที่ถาม
                if _intent_sub:
                    _sub_kw = {"adapter": "หัวชาร์จ", "cable": "สายชาร์จ", "set": "ชุดชาร์จ",
                               "car_charger": "หัวชาร์จในรถ", "wireless": "ชาร์จไร้สาย",
                               "desktop": "แท่นชาร์จ", "socket": "ปลั๊กไฟอัจฉริยะ"}.get(_intent_sub, "")
                    if _sub_kw and not any(kw in retrieval_message.lower() for kw in (_sub_kw, "หัวชาร์จ", "สายชาร์จ", "ชุดชาร์จ", "แท่นชาร์จ", "ชาร์จไร้สาย", "หัวชาร์จในรถ", "ปลั๊กไฟ")):
                        retrieval_message = f"{_sub_kw} {retrieval_message}"
                        print(f"[SUBTYPE-PREFIX] retrieval_message → {retrieval_message!r}", file=sys.stderr)
                # ⚡ Phase 3 — Multi-use-case: ถ้าลูกค้าถามหลาย use case พร้อมกัน
                # เช่น "สำหรับวิ่ง และตัดเสียงรบกวน" → แยกค้นตามแต่ละ use case แล้วรวมผล
                # กันไม่ให้ดึงแค่กลุ่มเดียวแล้วบอทตอบไม่ครบ
                _multi_case_patterns = [
                    (r"สำหรับวิ่ง|วิ่ง|ออกกำลังกาย|exercise|fitness|run\b", "หูฟัง วิ่ง run sport ออกกำลังกาย"),
                    (r"ตัดเสียงรบกวน|ตัดเสียง|กันเสียง|ANC|noise\s*cancel|active\s*noise|降噪|ขึ้นเครื่อง|เครื่องบิน",
                     "หูฟัง ตัดเสียงรบกวน ANC noise cancelling ขึ้นเครื่อง"),
                ]
                _is_multi_case = (
                    re.search(r"\b2\s*รุ[น้]น?\b|สอง\s*รุ[n้]n?|ทั้ง\s*2|ทั้งสอง", req.message, re.IGNORECASE)
                    or (req.message.count("และ") + req.message.count("และรุ้น") + req.message.count(" และ ")) >= 1
                )
                _multi_case_products: list[dict] = []
                if _is_multi_case and "earphone" in (product_store._detect_product_types(req.message) or set()):
                    _seen_ids: set[str] = set()
                    for _pat, _query in _multi_case_patterns:
                        if re.search(_pat, req.message, re.IGNORECASE):
                            _sub = product_store.fetch_products(
                                db,
                                message=_query,
                                shop_filter=req.shop,
                                limit=5,
                                desc_message=desc_message,
                            )
                            for _p in _sub:
                                _iid = str(_p.get("item_id") or _p.get("id") or "")
                                if _iid and _iid not in _seen_ids:
                                    _multi_case_products.append(_p)
                                    _seen_ids.add(_iid)
                    if _multi_case_products:
                        print(f"[MULTI-CASE] แยกค้นตาม use case → products={len(_multi_case_products)}", file=sys.stderr)
                if _multi_case_products:
                    products = _multi_case_products[:_fetch_limit]
                else:
                    products = product_store.fetch_products(
                        db,
                        message=retrieval_message,
                        shop_filter=req.shop,
                        limit=_fetch_limit,
                        desc_message=desc_message,
                        # ⚡ device-compat ("ของที่ใช้กับ X") classify เป็น
                        #   product_recommend+target_device ไม่ใช่ compatibility_check —
                        #   แต่เป็น compat เชิง semantic ต้องได้ pool กว้าง + ข้าม unit index
                        is_compat_check=_is_compat or bool((_intent_result or {}).get("target_device")),
                        skip_charger_subtype=_skip_sub,
                        charger_subtype_override=_intent_sub,
                        # ⚡ Phase 3 — RAG ไม่กรอง status/stock (LLM prompt กรองตอนแนะนำขาย)
                    )
            # ⚡ ปิด block if not _ref_regex_products (ข้าม fetch ถ้ามี active product แล้ว)
        print(f"[TIMING] fetch_products: {_time.time()-_t1:.2f}s  (retrieval={retrieval_message!r})  products={len(products)}", file=sys.stderr)

        # ── Superlative ที่ไม่ match product type ใดๆ ชัดเจน ──
        # เช่น "สายฉีดน้ำแรงดันสูง แรงดันแรงๆ ไวๆ" → ไม่ใช่ charger/powerbank
        # ถ้า fetch ไม่เจอสินค้าหรือเจอน้อยมาก → ถามกลับก่อน ไม่ใช้ web search (เปลือง)
        # ให้ LLM ถามกลับว่าลูกค้าสนใจสินค้าประเภทใด
        if _is_superlative_q and len(products) == 0 and not _super_has_charge:
            print(f"[SUPERLATIVE-NO-MATCH] ไม่เจอสินค้า ถามกลับแทน web search", file=sys.stderr)
            return ChatResponse(
                answer=(
                    "รบกวนช่วยระบุประเภทสินค้าที่สนใจหน่อยค่ะ "
                    "เช่น หัวชาร์จ สายชาร์จ พาวเวอร์แบงค์ เครื่องฟอกอากาศ "
                    "หรือสินค้าประเภทใดที่ต้องการแบบไวสุด/แรงสุดคะ "
                    "เพื่อให้เราแนะนำรุ่นที่ตรงกับความต้องการได้แม่นยำขึ้น"
                ),
                products=[],
                source="superlative_no_match_clarify",
                shop=req.shop,
                model=model_name,
                usage={"prompt": 0, "output": 0, "total": 0},
                intent=_intent_result if isinstance(_intent_result, dict) else {},
                web_search_used=False,
                steps=[],
                timing={"total": round(_time.time() - _total_start, 3)},
            )

        # Dedup สินค้าที่ชื่อเหมือนกันหรือใกล้เคียงกันมาก
        # (เช่น P23 ซ้ำ 3 ตัว ต่างกันแค่ suffix ระยะเวลาประกัน -12M / -1Y)
        # (เช่น AURA LPB100 ซ้ำ 3 ตัว ต่างกันที่ "/ LPB200NL" vs "/ AURA LPB200N")
        # ทำหลัง fetch_products ก่อน merge/unlist logic
        # ใช้ "base name" = ตัด suffix warranty + ตัดส่วนหลัง "/" เพื่อรวมสินค้าเดียวกัน
        # เมื่อเจอซ้ำ → เลือก listing ที่ดีที่สุดสำหรับขาย (NORMAL + stock + โปร + ราคาถูก)
        # ⚡ 2026-09-16 — ใช้ _dedupe_products ระดับโมดูล (รวม _base_name/_listing_sell_score)
        products = product_store._dedupe_products(products, log_label="DEDUP")

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
            # ⚡ Phase 3b — _extract_max_watt ย้ายไปเป็น module-level helper `_extract_max_wattage`
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
                matches = re.findall(r"(\d+(?:\.\d+)?)\s*mah\b", name.lower())
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
                products.sort(key=lambda p: device_compat._extract_max_wattage(p), reverse=True)
                print(f"[COMPAT-RANK] sort by wattage (desc)  top3: {[device_compat._extract_max_wattage(p) for p in products[:3]]}", file=sys.stderr)
            elif _is_watt_q:
                products.sort(key=lambda p: device_compat._extract_max_wattage(p), reverse=True)
                print(f"[SUPERLATIVE-RANK] sort by wattage (desc)  top3: {[device_compat._extract_max_wattage(p) for p in products[:3]]}", file=sys.stderr)
            elif _is_cap_q:
                products.sort(key=lambda p: _extract_max_mah(p), reverse=True)
                print(f"[SUPERLATIVE-RANK] sort by capacity (desc)  top3: {[_extract_max_mah(p) for p in products[:3]]}", file=sys.stderr)
            elif _is_weight_q:
                products.sort(key=lambda p: _extract_weight(p))
                print(f"[SUPERLATIVE-RANK] sort by weight (asc)  top3: {[_extract_weight(p) for p in products[:3]]}", file=sys.stderr)
            # ⚡ Phase 8 — จำกัดเหลือ LLM context limit หลัง sort (ไม่ใช่ req.limit)
            #   เพราะ superlative ต้องการให้ LLM เห็นสินค้าเยอะพอเพื่อเปรียบเทียบ
            #   frontend display ยังใช้ req.limit ใน ChatResponse
            products = products[:_llm_ctx_limit]
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
        # ⚡ Phase 2Z++ — ถ้าเป็น follow-up ที่มี ref_models (ดึงชื่อสินค้าจากคำตอบ bot ล่าสุด)
        #    แต่ vector search ไม่เจอ → ลองดึงด้วย Mongo regex จากชื่อสินค้าเต็มก่อนไป shop fallback
        #    (กัน case: "iSUPER SoundActiv Swim" ไม่มี digit → REF-REGEX ไม่ทำงาน → ดึงสินค้าอื่น → ตอบผิด)
        # ⚡ debug Phase 2Z++
        try:
            _dbg_ref_models = ref_models
        except NameError:
            _dbg_ref_models = None
        if not products and req.shop and _ref_handled and _dbg_ref_models:
            try:
                _ref_full_coll = db[os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"]
                _ref_full_products: list[dict] = []
                _seen_ref_ids: set = set()
                for _ref_name in _dbg_ref_models[:2]:
                    # ใช้ชื่อสินค้าเต็มใน regex match กับ field "item_name"
                    # ⚡ Phase 2Z+++ — แก้ field จาก "name" เป็น "item_name" (field จริงใน DB)
                    _ref_name_esc = re.escape(_ref_name)
                    _ref_full_filter = {
                        "item_name": {"$regex": _ref_name_esc, "$options": "i"},
                    }
                    # ⚡ Phase 2Z+++ — ลองดึงด้วย shop filter ก่อน
                    #    ถ้าไม่เจอ → ลองอีกครั้งโดยไม่ใส่ shop filter
                    #    (เพราะ shopname ใน MongoDB อาจไม่ตรงกับ req.shop เลย)
                    if req.shop:
                        _ref_full_filter["shopname"] = {"$regex": re.escape(req.shop), "$options": "i"}
                    _ref_docs = list(_ref_full_coll.find(_ref_full_filter, product_store.PRODUCT_PROJECTION).limit(3))
                    # ⚡ ถ้าไม่เจอและมี shop filter → ลองอีกครั้งโดยไม่ใส่ shop filter
                    #    ชื่อสินค้าเต็มๆ มักเจาะจงพอ ไม่ต้องกลัว match ข้ามร้าน
                    if not _ref_docs and "shopname" in _ref_full_filter:
                        del _ref_full_filter["shopname"]
                        _ref_docs = list(_ref_full_coll.find(_ref_full_filter, product_store.PRODUCT_PROJECTION).limit(3))
                        print(f"[REF-NAME-FALLBACK] retry without shop filter: {len(_ref_docs)} docs", file=sys.stderr)
                    for d in _ref_docs:
                        iid = str(d.get("item_id"))
                        if iid not in _seen_ref_ids:
                            _seen_ref_ids.add(iid)
                            _ref_full_products.append(product_store.to_product_card(d, req.message))
                if _ref_full_products:
                    products = _ref_full_products
                    print(f"[REF-NAME-FALLBACK] ดึงสินค้าด้วยชื่อเต็ม {ref_models[:2]}: {len(products)} ตัว", file=sys.stderr)
            except Exception as _e:
                print(f"[REF-NAME-FALLBACK] error: {_e}", file=sys.stderr)
        if not products and req.shop:
            _t_alt = _time.time()
            # ตรวจว่าเป็น charger subtype ที่ไม่เจอไหม
            # ⚡ ใช้ subtype จาก intent ก่อน (แม่นกว่า) แล้วค่อย fallback เป็น detection จาก message
            _req_charger_sub = _intent_sub or product_store._detect_charger_subtype(req.message)
            if _req_charger_sub:
                # ดึง charger ทั่วไป (ไม่กรอง subtype) เพื่อให้ LLM แนะนำชุด/สาย แทน
                # ใช้ "charger" เฉยๆ (ไม่มี subtype keyword) เพื่อไม่ให้ subtype filter ทำงาน
                alt_products = product_store.fetch_products(
                    db,
                    message="charger charging adapter cable",
                    shop_filter=req.shop,
                    limit=_llm_ctx_limit,
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
                    else:
                        # ⚡ ถ้ากรองแล้วไม่เหลือ adapter/set เลย → ห้ามส่ง cable มาแทน
                        # (เดิม: alt_products ค้างเป็น cable ทั้งหมด ทำให้ถามหัวชาร์จแต่ได้สายชาร์จ)
                        print(f"[CHARGER-SUBTYPE-FALLBACK] ไม่มีสินค้า subtype={_req_charger_sub} ในร้าน → ไม่ส่ง subtype อื่นแทน", file=sys.stderr)
                        alt_products = []
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
                            f"ที่นำมาเสนอเป็นทางเลือก เพราะระบบค้นหาไม่พบรุ่นที่ลูกค้าถาม "
                            f"ให้บอกลูกค้าก่อนว่าไม่พบข้อมูลรุ่นที่ถามในระบบ "
                            f"(ห้ามบอกว่าหมดสต็อก/เลิกขาย — เป็นแค่ไม่พบในระบบค้นหาเท่านั้น) "
                            f"แล้วค่อยแนะนำสินค้าเหล่านี้แทน"
                        )
                    print(f"[TIMING] Shop fallback (alt products): {_time.time()-_t_alt:.2f}s  products={len(products)}", file=sys.stderr)

        # ⚡ BUG-10 guard (QA 2026-09-07) — ค้นสินค้าไม่เจอเลยหลัง fallback ทุกชั้น (REF-NAME, charger subtype, shop)
        #   ห้ามปล่อยให้ LLM ตอบด้วย context "ไม่พบสินค้า" ล้วนๆ — เคยทำให้ LLM แต่งคำอธิบาย
        #   สต็อก/แคตตาล็อกของร้านเอง (เคส QA: การ์ดออเดอร์ → "สินค้าทุกรายการหมดสต็อก",
        #   ถามอะไหล่ → "ร้านขายหัวชาร์จและสายชาร์จเป็นหลัก")
        #   → ตอบตายตัวว่าไม่พบข้อมูล + handoff แอดมินตรวจสอบ (ห้ามยืนยันสถานะสต็อกจากผลค้นว่าง)
        #   ยกเว้น: ลูกค้าส่งรูป (_vision_context) → ปล่อยไป LLM ตอบเรื่องรูปได้
        #   ยกเว้น: ไม่ใช่คำถามเรื่องสินค้าเลย (ทักทาย/ขอบคุณ — ไม่มี product type/model/ref/subtype)
        #           → ปล่อยไป LLM ตอบทั่วไปตามเดิม
        # ⚡ Legacy Fix — เพิ่มเงื่อนไข: ถ้า web search พร้อมทำงาน (ไม่ใช่ conv_active + is_configured)
        #   ให้ข้าม guard ไป web search ก่อน แล้วค่อย handoff หลัง web search จบ
        #   ก่อนหน้านี้: guard return ทันทีเมื่อ products=0 → web search ไม่ได้ทำงาน
        #   ทำให้ลูกค้าได้ "ไม่พบข้อมูล" ทั้งที่ web search อาจหาสินค้าได้
        from . import web_search as _ws_guard_check
        _guard_ws_available = (
            _ws_guard_check.is_configured()
            and not _is_conv_active
        )
        if not _vision_context and not _guard_ws_available:
            try:
                _guard_ref_models = ref_models
            except NameError:
                _guard_ref_models = None
            try:
                _guard_model_kw = _cur_model_kw
            except NameError:
                _guard_model_kw = None
            _guard_ptypes = product_store._detect_product_types(retrieval_message or req.message)
            # ⚡ เช็ค charger subtype ด้วย — "มีสายไหม"/"มีหัวไหม" (shorthand) ถูกจับที่
            #   _detect_charger_subtype ไม่ใช่ _detect_product_types → ต้องนับเป็น intent
            # ⚡ 2026-09-16 — ใช้ _resolve_charger_subtype เป็น fallback (ยึด _intent_sub ก่อน)
            _guard_charger_sub = _intent_sub or _resolve_charger_subtype(
                intent_result=_intent_result, retrieval_message=retrieval_message or req.message or "",
            )
            _guard_has_intent = bool(
                _guard_ptypes or _guard_ref_models or _guard_charger_sub
                or _guard_model_kw or _is_conv_active
            )
            # แขน 1: ค้นไม่เจอเลยหลัง fallback ทุกชั้น + (เป็นคำถามสินค้า หรือ ถามหาของเฉพาะ) → guard
            # แขน 2: เจอสินค้า แต่ผลมาจาก vector fuzzy ล้วน (ไม่มี product intent ใดๆ กำกับ)
            #        + เป็นคำถามแบบ "ถามหาสินค้าเฉพาะ" (ไม่ใช่ browse ทั่วไป) → ผลไม่น่าเชื่อ → guard
            #        (เคส QA จริง: "มีอะไหล่หัวฉีดตัวพ่นน้ำไหมคะ" → vector ดึงพัดลม 6 ตัวมา → LLM แต่งแคตตาล็อก)
            _low_guard = (req.message or "").lower()
            # browse ทั่วไป (แนะนำ/มาใหม่/โปร/ขายดี) → ปล่อยให้ vector search แนะนำได้ตามเดิม
            _guard_browse_kws = ("แนะนำ", "มาใหม่", "โปรโมชั่น", "โปร", "ลดราคา",
                                 "ขายดี", "การ์ด", "มือใหม่", "ครบ", "ดูสินค้า")
            _guard_is_browse = any(kw in _low_guard for kw in _guard_browse_kws)
            _guard_is_seeking = (
                ("มี" in _low_guard and "ไหม" in _low_guard)
                or "มีไหม" in _low_guard or "หาไหม" in _low_guard
                or "อยากได้" in _low_guard or "มีขาย" in _low_guard or "ขายไหม" in _low_guard
            )
            # ถามหาของเฉพาะ = seeking และไม่ใช่ browse ทั่วไป
            _guard_seek_specific = _guard_is_seeking and not _guard_is_browse
            _guard_arm1 = (not products) and (_guard_has_intent or _guard_seek_specific)
            _guard_arm2 = bool(products) and not _guard_has_intent and _guard_seek_specific
            if _guard_arm1 or _guard_arm2:
                if _guard_arm1:
                    print(
                        f"[NO-PRODUCT-GUARD] แขน 1: ค้นไม่เจอเลย (products=0) + คำถามสินค้า "
                        f"(ptypes={_guard_ptypes} ref={bool(_guard_ref_models)} sub={_guard_charger_sub} "
                        f"seek={_guard_seek_specific}) → ตอบไม่พบ + handoff (กัน BUG-10)",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"[NO-PRODUCT-GUARD] แขน 2: ถามหาสินค้าเฉพาะ แต่ไม่มี product intent ใดๆ กำกับ "
                        f"(vector fuzzy ล้วน products={len(products)}) → ผลไม่น่าเชื่อ → ตอบไม่พบ + handoff (กัน BUG-10)",
                        file=sys.stderr,
                    )
                return ChatResponse(
                    answer=(
                        "ขออภัยค่ะ ตอนนี้ระบบไม่พบข้อมูลสินค้าตามที่สอบถามไว้ "
                        "เดี๋ยวขอส่งเรื่องให้แอดมินช่วยตรวจสอบและตอบกลับให้ไวที่สุดนะคะ "
                        "ระหว่างนี้หากสนใจสินค้าอื่นสอบถามได้เลยค่ะ"
                    ),
                    products=[],
                    source="no_product_found_handoff",
                    shop=req.shop,
                    model=model_name,
                    usage={"prompt": 0, "output": 0, "total": 0},
                    intent=_intent_result if isinstance(_intent_result, dict) else {},
                    web_search_used=False,
                    steps=_steps,
                    timing={"total": round(_time.time() - _total_start, 3)},
                    handoff_to_admin=True,
                    handoff_reason="no_product_found",
                    routing_decision=_routing(
                        "handoff",
                        "no_product_found: ค้นสินค้าไม่เจอ/ผลค้นไม่น่าเชื่อ → ตอบไม่พบ + handoff แอดมินตรวจสอบ",
                    ),
                )
        # ถ้าเป็น follow-up (retrieval_message != req.message) ให้เก็บแค่สินค้า top 1
        # ที่ตรงกับ model ที่ลูกค้าถาม ไม่ส่งสินค้าอื่นปน เพื่อให้ LLM ตอบตรงจุด
        # ⚡ ข้ามสำหรับ app question — ต้องส่ง 10 ชิ้นเข้า LLM ให้ครบ
        # ⚡ ข้ามสำหรับ superlative question — ต้องส่งทุกรุ่นเข้า LLM เพื่อเปรียบเทียบ
        # ⚡ ข้ามสำหรับ comparison question — ต้องส่งทุกรุ่นที่ลูกค้าถามเข้า LLM
        #   (ถ้ากรองเฉพาะที่มีทุก model word จะเหลือแค่ชุด/แถม ไม่ใช่สินค้าเดี่ยว)
        _is_comparison_followup = any(kw in req.message.lower() for kw in (
            "ต่างกัน", "ต่างไหม", "เปรียบเทียบ", "vs", "ดีกว่า", "สูงกว่า", "แรงกว่า",
            "ใหม่กว่า", "ถูกกว่า", "ล่าสุด"
        ))
        if retrieval_message != req.message and products and not _is_app_question and not _is_superlative_q and not _is_comparison_followup:
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
                                        card = knowledge_base._kb_doc_to_card(kd)
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
                # ⚡ Phase 8 — _merge_limit ใช้ _LLM_CONTEXT_LIMIT (30) ไม่ใช่ req.limit
                #   สำหรับ compatibility check ให้เก็บเยอะกว่าปกติเพื่อให้ LLM เห็นทุกรุ่น
                _merge_limit = max(_llm_ctx_limit * 4, 80) if _is_compat_check else _llm_ctx_limit
                products = merged[:_merge_limit]

        # ⚡ Phase 3d (2026-09-19) — _available_for_sale mark (ทุกกรณี นอก if has_unlist)
        #   กฎ: ตอบคำถามสินค้าได้ทุก status แต่ห้ามแนะนำขาย/เสนอขาย/ส่งลิงก์สั่งซื้อ
        #   กับสินค้าที่ shopee_stock<=0 หรือ status!=NORMAL หรือ sold_out=True
        #   เคส LuckyHomeMart: สินค้า Leravan ทุกตัว status=NORMAL แต่ sold_out=True (stock=0)
        #   → note เดิมฝังอยู่ใน if has_unlist block → ไม่ถูก inject → LLM แนะนำขายสินค้าหมดสต็อก
        #   แก้: mark _available_for_sale ในทุก product (context note inject หลัง _apply_product_tiers)
        _pending_context_note = ""
        if products:
            for _p in products:
                _p["_available_for_sale"] = (
                    _p.get("status") == "NORMAL"
                    and not _p.get("sold_out", False)
                    and (_p.get("total_stock", 0) or 0) > 0
                )
            _has_unlist = any(not _p.get("_available_for_sale") and _p.get("status") != "NORMAL" for _p in products)
            _has_sold_out = any(
                not _p.get("_available_for_sale")
                and _p.get("status") == "NORMAL"
                and (_p.get("sold_out", False) or (_p.get("total_stock", 0) or 0) == 0)
                for _p in products
            )
            _avail_count = sum(1 for _p in products if _p.get("_available_for_sale"))
            print(f"[AVAIL-FOR-SALE] total={len(products)} available={_avail_count} unlist={_has_unlist} sold_out={_has_sold_out}", file=sys.stderr)

            _notes = []
            if _has_unlist:
                _notes.append(
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
            if _has_sold_out:
                _notes.append(
                    "สินค้าที่ sold_out=True หรือ stock=0 (แม้ status=NORMAL) หมดสต็อกชั่วคราว — "
                    "ห้ามเสนอขาย/แสดงลิงก์สั่งซื้อ "
                    "ถ้าลูกค้าถามเรื่องสเปค/รายละเอียดสินค้า: ให้ตอบสเปค/รายละเอียดของสินค้านั้นได้ตามปกติ "
                    "(ไม่ต้องบอกว่าหมดสต็อก นอกจากลูกค้าถามว่ามีขายไหม/พร้อมส่งไหม) "
                    "ถ้าลูกค้าถามเรื่องรับประกัน/เคลม: ให้ตอบเงื่อนไขรับประกันของสินค้านั้น "
                    "(ห้ามเสนอสินค้าอื่นแทน เพราะลูกค้าไม่ได้ถามเรื่องซื้อ) "
                    "ถ้าลูกค้าอยากซื้อ/ถามว่ามีขายไหม/พร้อมส่งไหม: ให้บอกว่ารุ่นนี้หมดสต็อกชั่วคราว "
                    "แล้วแนะนำเฉพาะสินค้า status=NORMAL ที่มี stock และไม่ sold_out เท่านั้น"
                )
            # ⚡ Phase 3d — กฎหลัก: ห้ามแนะนำขายสินค้าที่ _available_for_sale=False
            _notes.append(
                "⚡ กฎสำคัญ: ห้ามแนะนำขาย/เสนอขาย/ส่งลิงก์สั่งซื้อ กับสินค้าที่ _available_for_sale=False "
                "(สินค้าที่ shopee_stock<=0 หรือ status!=NORMAL หรือ sold_out=True) "
                "แนะนำขาย/เสนอขาย/ส่งลิงก์สั่งซื้อ ได้เฉพาะสินค้าที่ _available_for_sale=True เท่านั้น"
            )
            _pending_context_note = " ".join(_notes)

        _llm_start = _time.time()

        # ── Rejection memory: สแกน history หาสินค้าที่ลูกค้าปฏิเสธ ──
        # ถ้าลูกค้าเคยแย้ง/ปฏิเสธสินค้าที่บอทแนะนำ → ส่ง context ให้ LLM ว่าห้ามแนะนำซ้ำ
        _rejection_extra = ""
        if req.history and products:
            _neg_signals = (
                "ทำไม", "ไม่โอเค", "ไม่ดี", "ดีกว่า", "ไม่เอา", "ไม่ต้อง",
                "จ่ายได้แค่", "แค่", "ไม่พอ", "ไม่ใช่", "ผิด", "ไม่ตรง",
                "แล้วทำไมไม่", "ทำไมไม่", "ไม่เหมาะ", "ไม่เหมาะสม",
                "เลว", "แย่", "ไม่น่า", "ไม่คุ้ม",
            )
            # ดึง model codes จาก products ใน context ปัจจุบัน (เช่น C2C515, CTC615W)
            _ctx_model_codes: dict[str, str] = {}  # code (UPPER) → full name
            for _p in products:
                _pname = (_p.get("name") or "").strip()
                if not _pname:
                    continue
                # หา model code: alphanumeric token ที่ขึ้นต้นด้วยตัวอักษร และมีทั้งตัวอักษรและตัวเลข
                # (เช่น C2C515, CTC615W, PB100P, AD1404U — ไม่จับ 100W หรือ 240W)
                _tokens = re.findall(r"[A-Z][A-Z0-9]{3,11}", _pname)
                for _c in _tokens:
                    if any(ch.isdigit() for ch in _c):
                        _ctx_model_codes[_c.upper()] = _pname
            # สแกน history: model message → user message ถัดไป
            _rejected: list[tuple[str, str]] = []  # (model_code, reason_snippet)
            _hist = req.history
            for _i in range(len(_hist) - 1):
                _h = _hist[_i]
                _h_role = getattr(_h, "role", None) or (_h.get("role") if isinstance(_h, dict) else None)
                _h_text = getattr(_h, "text", None) or (_h.get("text", "") if isinstance(_h, dict) else "")
                if _h_role != "model":
                    continue
                _model_text = _h_text
                # หา model codes ที่บอทเคยแนะนำในข้อความนี้ (ขึ้นต้นด้วยตัวอักษร มีทั้งตัวอักษรและตัวเลข)
                _bot_tokens = re.findall(r"[A-Z][A-Z0-9]{3,11}", _model_text)
                _bot_codes = [c for c in _bot_tokens if any(ch.isdigit() for ch in c)]
                if not _bot_codes:
                    continue
                # ดู user message ถัดไป
                _next_user = None
                for _j in range(_i + 1, len(_hist)):
                    _nh = _hist[_j]
                    _nh_role = getattr(_nh, "role", None) or (_nh.get("role") if isinstance(_nh, dict) else None)
                    if _nh_role == "user":
                        _next_user = getattr(_nh, "text", None) or (_nh.get("text", "") if isinstance(_nh, dict) else "")
                        break
                # ⚡ ถ้าไม่มี user message ถัดไปใน history → ใช้ current message (req.message)
                if not _next_user and _i == len(_hist) - 1:
                    _next_user = req.message
                if not _next_user:
                    continue
                _has_neg = any(_sig in _next_user for _sig in _neg_signals)
                if not _has_neg:
                    continue
                # ถ้า user message มี negative signal + พูดถึงสินค้าที่บอทแนะนำ
                # ⚡ รองรับทั้ง code ตรงๆ (case-insensitive) และ indirect reference ("สายชาร์จนี้", "อันนี้")
                _next_lower = _next_user.lower()
                _matched_code = None
                for _bc in _bot_codes:
                    if _bc.lower() in _next_lower:
                        _matched_code = _bc
                        break
                # ถ้าไม่ match code ตรง แต่ user พูดถึง "สาย"/"หัว"/"อันนี้"/"รุ่นนี้" + negative → ถือว่าปฏิเสธ
                if not _matched_code and _bot_codes:
                    _indirect_kws = ("สาย", "หัว", "อันนี้", "รุ่นนี้", "ตัวนี้", "อันนั้น", "รุ่นนั้น", "ตัวนั้น", "อันเดิม", "ของเดิม")
                    if any(_kw in _next_user for _kw in _indirect_kws):
                        # พยายาม match ประเภท: "สาย" → cable code, "หัว" → adapter code
                        _has_sai = "สาย" in _next_user
                        _has_hua = "หัว" in _next_user
                        if _has_sai and not _has_hua:
                            # หา code ที่น่าจะเป็นสาย (C2C, CTC, CL)
                            _cable_codes = [c for c in _bot_codes if re.match(r"^(C2C|CTC|CL)", c)]
                            _matched_code = _cable_codes[0] if _cable_codes else _bot_codes[0]
                        elif _has_hua and not _has_sai:
                            # หา code ที่น่าจะเป็นหัวชาร์จ (AD)
                            _adapter_codes = [c for c in _bot_codes if re.match(r"^AD", c)]
                            _matched_code = _adapter_codes[0] if _adapter_codes else _bot_codes[0]
                        else:
                            _matched_code = _bot_codes[0]  # สินค้าแรกที่บอทแนะนำ
                if _matched_code:
                    _reason = _next_user[:120].replace("\n", " ")
                    _rejected.append((_matched_code, _reason))
            # debug log
            if _rejected:
                print(f"[REJECTION] detected: {[(c, r[:50]) for c, r in _rejected]}", file=sys.stderr)
                print(f"[REJECTION] ctx_model_codes: {list(_ctx_model_codes.keys())}", file=sys.stderr)
            # ส่งทุก rejected products ให้ LLM — ไม่กรองเฉพาะที่อยู่ใน context
            # เพราะถ้าสินค้าที่ถูกปฏิเสธอยู่ใน context รอบนี้ LLM ต้องรู้ว่าห้ามแนะนำ
            _rejected_in_ctx = _rejected[:]
            if _rejected_in_ctx:
                _rejection_lines = []
                for _code, _reason in _rejected_in_ctx:
                    _fname = _ctx_model_codes.get(_code, _code)
                    _rejection_lines.append(
                        f"  • {_code} ({_fname[:40]}) — ลูกค้าปฏิเสธเพราะ: {_reason}"
                    )
                _rejection_extra = (
                    "\n⚠️ สินค้าที่ลูกค้าปฏิเสธในรอบก่อน — ห้ามแนะนำซ้ำ:\n"
                    + "\n".join(_rejection_lines)
                    + "\nหากสินค้าเหล่านี้อยู่ใน context ให้ข้ามไปแนะนำรุ่นอื่นแทน\n"
                )
                print(f"[REJECTION-MEMORY] พบสินค้าที่ลูกค้าปฏิเสธ: {[c for c, _ in _rejected_in_ctx]}", file=sys.stderr)

        # สำหรับ superlative question ที่ไม่ชัดว่าลูกค้าต้องการประเภทใด
        # (เช่น "ชาร์จไวสุด" อาจหมายถึง หัวชาร์จ สายชาร์จ หรือพาวเวอร์แบงค์)
        # → เพิ่ม instruction ให้ LLM ถามกลับถ้าไม่ชัด แทนการคิดแทนลูกค้า
        _superlative_clarify_extra = ""
        if _is_superlative_q and not _super_has_pb and not _super_has_history:
            _superlative_clarify_extra = (
                "\nหมายเหตุ: คำถามนี้เป็นแบบ superlative (อยากได้ที่สุด/ไวสุด/แรงสุด) "
                "แต่ไม่ได้ระบุประเภทสินค้าชัดเจน และไม่มีประวัติการคุยก่อนหน้า "
                "ถ้า context มีสินค้าหลายประเภท (เช่น ทั้งหัวชาร์จและพาวเวอร์แบงค์) "
                "ให้แนะนำสินค้าที่แรง/ไวสุดจริงจาก context พร้อมถามกลับว่า "
                "ลูกค้าสนใจประเภทใดโดยเฉพาะ อย่าคิดแทนลูกค้า\n"
            )
        # รวม extra_context: rejection memory + superlative clarification + vision description
        _combined_extra = (_vision_context + _rejection_extra + _superlative_clarify_extra).strip()
        # ⚡ 2026-09-12 — hybrid anchor+fetch: merge anchor กับ products ที่ fetch มา
        #   กรณี "อยากได้ของที่ใช้กับ xiaomi 17 ultra" หลังแชร์การ์ด CTL301 (cable Lightning)
        #   → products = สินค้าที่ใช้กับ Mi 17 Ultra (USB-C) + anchor (CTL301)
        #   → LLM ตอบ: "CTL301 เป็น Lightning ไม่ใช้กับ Mi 17 Ultra แนะนำสาย USB-C แทน"
        if _hybrid_anchor_card and products:
            _anchor_id_h = str(_hybrid_anchor_card.get("item_id") or "")
            _existing_ids = {str(p.get("item_id") or "") for p in products}
            if _anchor_id_h and _anchor_id_h not in _existing_ids:
                # ใส่ anchor ไว้ต้น list เพื่อให้ LLM เห็นชัด
                products = [_hybrid_anchor_card] + products
                print(f"[HYBRID-MERGE] merge anchor item_id={_anchor_id_h} เข้า products (now {len(products)})", file=sys.stderr)
            # เพิ่ม context note บอก LLM ว่า anchor คือสินค้าเดิมที่ลูกค้าสนใจ
            _anchor_name_h = _hybrid_anchor_card.get("name") or _hybrid_anchor_card.get("item_name") or ""
            _hybrid_note = (
                f"\n⚠️ สินค้าแรกใน context ({_anchor_name_h}) คือสินค้าที่ลูกค้าสนใจจากก่อนหน้า "
                f"ลูกค้าถามหาสินค้าที่ใช้กับอุปกรณ์รุ่นใหม่ "
                f"ถ้าสินค้าเดิมไม่รองรับอุปกรณ์รุ่นใหม่ ให้บอกตรงๆ แล้วแนะนำสินค้าอื่นที่รองรับแทน"
            )
            _combined_extra = (_combined_extra + _hybrid_note).strip()
        # ⚡ Phase 7 — anchor comparison: ถ้าลูกค้าถาม "อันนี้กับอันก่อนต่างกันยังไง"
        #   ใส่สินค้าทั้ง 2 ตัว (current + previous anchor) เข้า products + context note
        #   ให้ LLM เปรียบเทียบได้โดยตรง ไม่ต้องพึ่ง model keyword extraction
        if _anchor_compare_ctx and _anchor_compare_ctx.get("current") and _anchor_compare_ctx.get("previous"):
            _cur_c = _anchor_compare_ctx["current"]
            _prev_c = _anchor_compare_ctx["previous"]
            _cur_id = str(_cur_c.get("item_id") or "")
            _prev_id = str(_prev_c.get("item_id") or "")
            _existing_ids_cmp = {str(p.get("item_id") or "") for p in products}
            # ใส่ current ต้น list, previous ตามหลัง (ถ้ายังไม่มี)
            _cmp_inserted = []
            if _cur_id and _cur_id not in _existing_ids_cmp:
                _cmp_inserted.append(_cur_c)
            if _prev_id and _prev_id not in _existing_ids_cmp and _prev_id != _cur_id:
                _cmp_inserted.append(_prev_c)
            if _cmp_inserted:
                products = _cmp_inserted + products
                print(f"[ANCHOR-COMP-MERGE] เพิ่ม {len(_cmp_inserted)} anchor เข้า products (now {len(products)})", file=sys.stderr)
            _cur_name_cmp = _cur_c.get("name") or _cur_c.get("item_name") or ""
            _prev_name_cmp = _prev_c.get("name") or _prev_c.get("item_name") or ""
            _cmp_note = (
                f"\n⚠️ ลูกค้าถามเปรียบเทียบสินค้า 2 รุ่นที่เคยสนใจในแชทนี้:\n"
                f"  - อันนี้ (ล่าสุด): {_cur_name_cmp}\n"
                f"  - อันก่อนหน้า: {_prev_name_cmp}\n"
                f"ให้เปรียบเทียบความแตกต่างของ 2 รุ่นนี้จากข้อมูลใน context "
                f"(สเปค ราคา การรับประกัน ความเข้ากันได้ ฯลฯ) "
                f"ถ้าข้อมูลไม่พอ บอกตรงๆ ว่าไม่มีข้อมูลบางส่วน"
            )
            _combined_extra = (_combined_extra + _cmp_note).strip()
        # ⚡ Partial comparison (1 anchor + model keyword from message)
        #   กรณี: ลูกค้าส่ง item card Run แล้วถาม "ตัวนี้กับ swim ต่างกันยังไง"
        #   → current = Run (anchor), other = Swim (จาก fetch_products/MODEL-REGEX)
        #   → ใส่ Run ต้น list + comparison note บอก LLM เปรียบเทียบ current กับสินค้าอื่นใน context
        elif _is_partial_comp and _anchor_compare_ctx.get("current"):
            _cur_pc = _anchor_compare_ctx["current"]
            _cur_pc_id = str(_cur_pc.get("item_id") or "")
            _existing_ids_pc = {str(p.get("item_id") or "") for p in products}
            if _cur_pc_id and _cur_pc_id not in _existing_ids_pc:
                products = [_cur_pc] + products
                print(f"[PARTIAL-COMP-MERGE] เพิ่ม anchor current เข้า products (now {len(products)})", file=sys.stderr)
            _cur_pc_name = _cur_pc.get("name") or _cur_pc.get("item_name") or ""
            _pc_note = (
                f"\n⚠️ ลูกค้าถามเปรียบเทียบสินค้าที่สนใจ ({_cur_pc_name}) "
                f"กับสินค้าอื่นที่ลูกค้าระบุในข้อความ "
                f"ให้เปรียบเทียบสินค้าแรก ({_cur_pc_name}) กับสินค้าอื่นใน context "
                f"(สเปค ราคา การรับประกัน ความเข้ากันได้ ฯลฯ) "
                f"ถ้าข้อมูลไม่พอ บอกตรงๆ ว่าไม่มีข้อมูลบางส่วน"
            )
            _combined_extra = (_combined_extra + _pc_note).strip()
        #   ⚡ Phase 4 — trigger เมื่อ target_device ไม่ว่าง (ไม่ผูก intent)
        #   ⚡ Phase 3b — dual-tier recommendation (baseline + upgrade) + sort by wattage asc
        _device_spec_extra, _device_additional = device_compat._device_spec_lookup(
            db=db,
            req=req,
            intent_result=_intent_result,
            history=history,
            existing_products=products,
            retrieval_message=retrieval_message,
            anchor_card=anchor_card,
            hybrid_anchor_card=_hybrid_anchor_card,
            llm_ctx_limit=_llm_ctx_limit,
            resolve_subtype_fn=_resolve_charger_subtype,
        )
        if _device_additional:
            products.extend(_device_additional)
        if _device_spec_extra:
            _combined_extra = (_combined_extra + _device_spec_extra).strip()
        # ⚡ QA-KB — คำแนะนำจาก kb_qa (trigger kw เท่านั้น; model/brand scoped ใน search_qa)
        _qa_ctx = knowledge_base.qa_context(
            req.message, conversation_id=req.conversation_id)
        if _qa_ctx:
            _combined_extra = (_combined_extra + "\n\n" + _qa_ctx).strip()
        # ⚡ CODE-level compat filter — กรองสินค้าที่ connector ไม่ตรงกับอุปกรณ์ออก
        #    ก่อน tier merge เพื่อให้ LLM เห็นเฉพาะสินค้าที่ compat จริง
        #    ถ้ากรองแล้วว่าง/เหลือน้อย → fallback คืนทั้งหมด (ปลอดภัย ไม่ over-filter)
        _compat_target_device = _intent_result.get("target_device") or ""
        if _compat_target_device and products:
            products = device_compat._filter_compat_products(
                products=products,
                device_name=_compat_target_device,
                web_search_extra=_device_spec_extra,
                intent_connector=_intent_result.get("device_connector"),
                intent_min_watt=_intent_result.get("device_min_watt"),
            )
        # ⚡ Phase 3 — Tier merge ก่อนส่งเข้า LLM
        #   Tier A (exact match): MODEL-REGEX + anchor_card + hybrid_anchor_card → ใส่เสมอ ไม่ถูกตัดด้วย limit
        #   Tier B (general): vector/keyword search → เรียง normal+stock>0 ก่อน แล้วตัด limit
        #   รวม A+B เรียก _dedupe_products
        _tier_a_ids: set[str] = set()
        # เก็บ item_id จาก _ref_regex_products (MODEL-REGEX / FUZZY-MATCH / CARRY-FORWARD)
        if _ref_regex_products:
            for p in _ref_regex_products:
                _iid = str(p.get("item_id") or "")
                if _iid:
                    _tier_a_ids.add(_iid)
        # เก็บ item_id จาก anchor_card (tagged item)
        if anchor_card:
            _iid = str(anchor_card.get("item_id") or "")
            if _iid:
                _tier_a_ids.add(_iid)
        # เก็บ item_id จาก _hybrid_anchor_card (compat+target_device hybrid)
        if _hybrid_anchor_card:
            _iid = str(_hybrid_anchor_card.get("item_id") or "")
            if _iid:
                _tier_a_ids.add(_iid)
        # ⚡ Phase 8 — Tier B limit ใช้ _LLM_CONTEXT_LIMIT (30) ไม่ใช่ req.limit
        #   เพราะนี่คือ LLM context limit (สินค้าที่ส่งเข้า llm.answer)
        #   frontend display ยังใช้ req.limit ใน products_for_response (ด้านล่าง)
        products = device_compat._apply_product_tiers(products, _tier_a_ids, _llm_ctx_limit)
        # ⚡ Phase 3d — inject context_note หลัง _apply_product_tiers (เพราะ sort เปลี่ยนลำดับ)
        #   ถ้า inject ก่อน tiers → context_note ไปอยู่ที่ product ตัวเดิม (index เดิม)
        #   แต่ LLM เห็น products[0] หลัง sort → context_note ไม่อยู่ใน products[0] → LLM ไม่เห็น
        #   แก้: inject หลัง tiers เพื่อให้ products[0] มี context_note
        if products and _pending_context_note:
            _add_context_note(products, _pending_context_note)
            print(f"[DEBUG-3D] injected context_note len={len(_pending_context_note)} products[0]_has_note=True", file=sys.stderr)
        try:
            answer, usage_info = llm.answer(
                message=desc_message,
                products=products,
                shop_hint=req.shop,
                history=_qa10,
                persona_extra=_persona_extra,
                intent_result=_intent_result,
                extra_context=_combined_extra,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        _llm_elapsed = _time.time() - _llm_start
        _total_elapsed = _time.time() - _total_start
        print(f"[TIMING] LLM: {_llm_elapsed:.2f}s  TOTAL: {_total_elapsed:.2f}s", file=sys.stderr)

        # คำนวณต้นทุนประมาณ (gemini-3.5-flash-lite: $0.30/M input, $2.50/M output)
        prompt_t = usage_info.get("prompt", 0)
        output_t = usage_info.get("output", 0)
        # ⚡ เพิ่ม vision pass tokens เข้าคำนวณด้วย
        prompt_t += _vision_usage.get("prompt", 0)
        output_t += _vision_usage.get("output", 0)
        cost = llm._gemini_cost(prompt_t, output_t)
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
        # ⚡ Phase 3 — ถ้า _is_conv_active (มี anchor จาก conversation timeline)
        #   ไม่ trigger web_search เพราะ anchor คือสินค้าที่ลูกค้าสนใจแล้ว
        #   ถ้า LLM ตอบ "ไม่มี" น่าจะเป็น LLM ตอบผิด ไม่ใช่สินค้าไม่มีจริง
        #   การดึงสินค้าอื่นมาทับจะทำให้ context loss รุนแรงขึ้น
        # ⚡ Legacy Fix (2026-09-15) — ใช้ _web_search_reanswer ร่วมกับ KB branch
        from . import web_search as _ws
        if _ws.is_configured() and not _is_conv_active:
            _should_search, _search_reason = _ws.should_use_web_search(
                answer=answer,
                intent_result=_intent_result,
                products=products,
                message=req.message,
            )
            if _should_search:
                print(f"[WEB-SEARCH] triggered: {_search_reason}", file=sys.stderr)
                # ⚠️ ถ้ามี reference (เช่น "รุ่นนี้" → IMILAB EC4) ให้ส่ง retrieval_message
                # (ที่รวมชื่อสินค้าจาก history) ไปแทน req.message
                # ไม่งั้น web_search จะตีความ "มีแบตไหม" เป็นคำถามทั่วไป แล้วไปค้น phone อื่นมาตอบ
                # (เช่น ค้น "มีแบตไหม" → ได้ Vivo Y200 ทั้งที่ลูกค้าถามเรื่อง IMILAB SC230)
                _ws_search_query = retrieval_message if (
                    retrieval_message and retrieval_message != req.message
                    and len(retrieval_message) > len(req.message)
                ) else req.message
                print(f"[WEB-SEARCH] search query: {_ws_search_query!r}", file=sys.stderr)

                _ws_r = _ws.reanswer(
                    db=db,
                    llm_ctx_limit=_llm_ctx_limit,
                    search_message=_ws_search_query,
                    llm_message=req.message,
                    products_in=products,
                    reason=_search_reason,
                    shop=req.shop,
                    platform=req.platform,
                    history_list=_qa10,
                    persona_extra=_persona_extra,
                    intent_result=_intent_result,
                    vision_context=_vision_context,
                    do_kb_lookup=True,  # product_store branch re-query KB
                    do_model_code_regex=True,  # product_store branch ใช้ model code regex
                    do_dedup_rerank=True,  # product_store branch dedup + rerank
                    req_limit=req.limit,
                )

                if _ws_r.get("search_used") and _ws_r.get("answer"):
                    # merge steps จาก _web_search_reanswer เข้า _steps
                    _steps.extend(_ws_r["steps"])
                    _ws_answer = _ws_r["answer"]
                    _ws_llm_usage = _ws_r["usage"]
                    _final_products = _ws_r["products"]
                    _ws_cost = _ws_r["cost_usd"]
                    _ws_elapsed = _ws_r["search_elapsed"]
                    _ws_usage = {"prompt": 0, "output": 0, "total": 0}  # search usage อยู่ใน steps แล้ว
                    _ws_answer = _append_base_warranty(_ws_answer, desc_message)
                    _total_ws = round(_time.time() - _total_start, 2)
                    _timing_breakdown["web_search"] = _ws_elapsed
                    _timing_breakdown["total"] = _total_ws
                    _combined_usage = {
                        "prompt": usage_info.get("prompt", 0) + _ws_llm_usage.get("prompt", 0),
                        "output": usage_info.get("output", 0) + _ws_llm_usage.get("output", 0),
                        "total": usage_info.get("total", 0) + _ws_llm_usage.get("total", 0),
                    }
                    print(f"[WEB-SEARCH] used web search answer  total={_total_ws}s  products={len(_final_products)}", file=sys.stderr)
                    _final_response_products = _final_products[:req.limit]
                    _record_suggestion_products(req, _final_response_products)
                    return ChatResponse(
                        answer=_ws_answer,
                        answer_segments=llm.split_segments(_ws_answer),
                        products=_final_response_products,
                        shop=req.shop,
                        model=_ws_r.get("search_model") or "openrouter",
                        source="product_store+web_search",
                        usage=_combined_usage,
                        elapsed=_total_ws,
                        cost=round(cost + _ws_cost, 6),
                        intent=_intent_result,
                        timing=_timing_breakdown,
                        steps=_steps,
                        web_search_used=True,
                        web_search_reason=_search_reason,
                        web_search_model=_ws_r.get("search_model"),
                        routing_decision=_routing("bot_reply", f"product_store+web_search: {_search_reason} → ค้นเพิ่มแล้วตอบ"),
                        image_desc=_image_desc_out,
                    )
                else:
                    print(f"[WEB-SEARCH] skipped (no answer from LLM re-answer or search not used)", file=sys.stderr)

        _record_suggestion_products(req, products_for_response)
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
            image_desc=_image_desc_out,
        )
    finally:
        pass  # ไม่ปิด client เพราะใช้ cache


def _record_suggestion_products(req, products: list[dict]) -> None:
    """บันทึกสินค้าที่ bot แนะนำลง conversation_products timeline.

    เรียกก่อน return ChatResponse ทุกจุดที่ bot ตอบพร้อม products.
    บันทึกเฉพาะสินค้าที่มี item_id และ req.conversation_id มีค่า.
    สินค้าที่ bot แนะนำ = is_anchor=False (suggestion).

    ⚡ Text-based anchor: ถ้าลูกค้าพิมพ์ชื่อรุ่น (model keyword) ที่ match กับสินค้าใน results
    → บันทึกสินค้าตัวแรกที่ match เป็น anchor (is_anchor=True, source="user_text")
    → ทำให้ active product เป็นสินค้าที่ลูกค้าพิมพ์ ไม่ใช่สินค้าสุดท้ายในลูป
    กัน case: ลูกค้าพิมพ์ "ctl301" → RAG คืน [CTL301, CTC615W] → ถ้าไม่ anchor
    → active = CTC615W (suggestion ล่าสุด) → follow-up ส่ง CTC615W ให้ LLM2 ผิด
    """
    if not req or not getattr(req, "conversation_id", None) or not products:
        return
    try:
        from . import conversation_products as _cp
        from . import knowledge_base as _kb_anchor

        # ⚡ Text-based anchor: สกัด model keywords จากข้อความลูกค้า
        #   กรอง target device ออก (เช่น "iphone17" เป็นอุปกรณ์ ไม่ใช่สินค้าในร้าน)
        _msg_model_kws = _kb_anchor.extract_model_keywords(req.message or "")
        _msg_model_kws = [kw for kw in _msg_model_kws
                         if not _kb_anchor.is_target_device_kw(kw)]

        # หาสินค้าตัวแรกที่ชื่อมี model keyword ของลูกค้า → anchor
        _anchor_item_id = None
        if _msg_model_kws:
            for p in products[:3]:
                _name_lower = (p.get("name") or "").lower()
                _p_item_id = p.get("item_id")
                if not _p_item_id:
                    continue
                for kw in _msg_model_kws:
                    if kw.lower() in _name_lower:
                        _anchor_item_id = _p_item_id
                        print(f"[TEXT-ANCHOR] ลูกค้าพิมพ์ '{kw}' ตรงกับสินค้า "
                              f"'{(p.get('name') or '')[:40]}' → anchor", file=sys.stderr)
                        break
                if _anchor_item_id:
                    break  # ใช้แค่ตัวแรกที่ match (สินค้าที่เกี่ยวข้องที่สุดจาก RAG)

        for p in products[:5]:  # จำกัด 5 ชิ้นแรก (เพิ่มจาก 3 เพื่อให้ link-followup มีสินค้าเพียงพอ)
            item_id = p.get("item_id")
            name = p.get("name") or ""
            if not item_id:
                continue
            _is_text_anchor = (item_id == _anchor_item_id)
            _cp.add_product(
                conversation_id=req.conversation_id,
                platform=getattr(req, "platform", None),
                shop=getattr(req, "shop", None),
                item_id=item_id,
                name=name,
                source="user_text" if _is_text_anchor else "bot_suggestion",
                card=p,
                is_anchor=_is_text_anchor,
            )
    except Exception as _e:
        print(f"[CONV-PRODUCTS] error recording suggestions: {_e}", file=sys.stderr)


def _append_base_warranty(answer: str, message: str, source: str = "") -> str:
    """ถ้าคำถามเกี่ยวกับประกัน/เคลม → แนบเงื่อนไขการรับประกันสินค้าเบื้องต้นท้ายคำตอบ.

    แนบเฉพาะถ้า:
    - คำถามเกี่ยวประกัน/เคลม
    - คำตอบยังไม่มีเงื่อนไขเบื้องต้นอยู่แล้ว (กันซ้ำ)
    - ไม่ใช่ general:warranty_policy (เพราะ context มี general_faq อยู่แล้ว)
    """
    if not answer:
        return answer
    # ⚡ BUG-2 fix — strip KB markup `[[ ]]`, `---`, `หมายเหตุ:` ที่หลุดจาก LLM ก่อนแนบ warranty
    answer = llm._strip_kb_markup(answer)
    if not knowledge_base.is_warranty_question(message):
        return answer
    # ถ้าเป็น general:warranty_policy → context มี general_faq อยู่แล้ว ไม่ต้องแนบซ้ำ
    if source == "general:warranty_policy":
        return answer
    # ถ้าเป็น duration question เฉพาะเจาะจง (เช่น "X รับประกันกี่ปี", "มีประกัน")
    # → ไม่แนบเงื่อนไขรับประกันเต็ม เพราะลูกค้าแค่ถามระยะเวลา คำตอบ LLM สั้นๆ เพียงพอ
    # ถ้าลูกค้าอยากรู้เงื่อนไขเต็ม ถามเป็นการเฉพาะได้
    from . import warranty as _w_check
    # เช็ค terms indicators ก่อน duration — เพราะ "เงื่อนไขรับประกันเป็นยังไง" มี "ประกัน"
    # และ detect_warranty_duration_question จับทุกข้อความที่มี "ประกัน"
    _warranty_terms_indicators = (
        "เงื่อนไข", "อะไรบ้าง", "ยังไง", "ยังไงคะ", "เป็นยังไง",
        "ครอบคลุม", "เคลมยังไง", "เคลมไง", "ซ่อมยังไง",
        "condition", "terms", "policy",
    )
    _msg_lower = message.lower()
    _asks_terms = any(ind in _msg_lower for ind in _warranty_terms_indicators)
    if not _asks_terms:
        # ไม่ใช่คำถามเงื่อนไข → เป็น duration หรือ statement → ไม่แนบเงื่อนไขเต็ม
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
    _result = f"{answer}\n\n---\n**เงื่อนไขการรับประกันสินค้าเบื้องต้น**\n{base_text}"
    # ⚡ BUG-2 fix — strip markup อีกครั้งหลังแนบ (กัน `[[ ]]` ที่อาจหลุดจาก base_text)
    return llm._strip_kb_markup(_result)


# alias ให้ chat_v2 เรียกผ่าน _app_module (impl ย้ายไป knowledge_base.py)
_detect_brand_question = knowledge_base._detect_brand_question
_build_brand_context = knowledge_base._build_brand_context


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
        # pattern 1: full token (เช่น lageniok9, ec6, ks3)
        full_tokens = re.findall(r"[a-z]+\d+[a-z]*", model_only_norm)
        # pattern 2: short code ท้าย (เช่น k9 จาก lageniok9, ec6 จาก imilabec6)
        short_codes = re.findall(r"[a-z]{1,3}\d+[a-z]*", model_only_norm)
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
            # ⚡ BUG-O fix — เติม description จาก KB (เดิมทิ้งไป ทำให้ข้อมูลไม่ถึง LLM)
            if best_kb.get("description"):
                card["kb_description"] = best_kb["description"][:4000]
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
        card = knowledge_base._kb_doc_to_card(kd)
        card["_kb_only"] = True
        card["_source"] = "kb"
        merged.append(card)

    return merged


@app.post("/feedback")
def feedback(req: FeedbackRequest) -> dict[str, str]:
    """รับ feedback (thumbs up/down) จากลูกค้า.

    ตอนนี้แค่ log ไว้ ไม่เก็บ DB (สามารถเพิ่ม collection สำหรับเก็บได้ภายหลัง).
    """
    rating = req.rating if req.rating in ("up", "down", "clear") else "unknown"
    if rating != "clear":
        print(f"[FEEDBACK] rating={rating}  answer='{req.answer[:80]}...'")
    return {"status": "ok", "rating": rating}
