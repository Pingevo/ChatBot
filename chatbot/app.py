"""FastAPI app สำหรับแชทบอทสินค้า.

Endpoints:
- GET  /health        : ตรวจสุขภาพ + แสดงร้าน/หมวดทั้งหมด
- GET  /shops         : รายชื่อร้านในเครือ
- GET  /categories    : รายชื่อหมวดหมู่
- POST /chat          : รับ {shop, message, history?} -> {answer, products}
"""

from __future__ import annotations

import os
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from pydantic import BaseModel, Field

from . import llm, product_store


load_dotenv()

app = FastAPI(
    title="ChatBotProductMS",
    description="แชทบอทตอบคำถาม/เปรียบเทียบ/แนะนำสินค้า และเรื่องเคลม-รับประกัน ของร้านในเครือ",
    version="0.1.0",
)

_STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


# ---- schemas ------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str = Field("user", description="user | model")
    text: str


class ChatRequest(BaseModel):
    message: str = Field(..., description="คำถาม/ข้อความลูกค้ารอบปัจจุบัน")
    shop: str | None = Field(None, description="ชื่อร้านที่ลูกค้าทักเข้ามา (ถ้ามี) เช่น IMILabThailand")
    history: list[ChatMessage] = Field(default_factory=list, description="ประวัติแชทก่อนหน้า")
    limit: int = Field(20, ge=1, le=50, description="จำนวนสินค้าสูงสุดที่จะส่งเป็น context")


class ChatResponse(BaseModel):
    answer: str
    products: list[dict[str, Any]]
    shop: str | None
    model: str


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


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    client, db = _db()
    try:
        # รวมคำถามก่อนหน้าจาก history เพื่อให้ fetch_products เข้าใจบริบท
        # เช่น "มีโทสับไหม" + "มีรุ่นอื่นไหม" → "มีโทสับไหม มีรุ่นอื่นไหม"
        # ใช้แค่คำถาม user ล่าสุด 1-2 คำถาม เพื่อไม่ให้ noise เยอะเกินไป
        retrieval_message = req.message
        if req.history:
            recent_user_msgs = [
                m.text for m in req.history
                if m.role == "user" and m.text.strip()
            ][-2:]  # เอาแค่ 2 คำถามล่าสุด
            if recent_user_msgs:
                retrieval_message = " ".join(recent_user_msgs) + " " + req.message

        products = product_store.fetch_products(
            db,
            message=retrieval_message,
            shop_filter=req.shop,
            limit=req.limit,
        )
        history = [{"role": m.role, "text": m.text} for m in req.history]
        try:
            answer = llm.answer(
                message=req.message,
                products=products,
                shop_hint=req.shop,
                history=history,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        model_name = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
        return ChatResponse(answer=answer, products=products, shop=req.shop, model=model_name)
    finally:
        client.close()


@app.post("/feedback")
def feedback(req: FeedbackRequest) -> dict[str, str]:
    """รับ feedback (thumbs up/down) จากลูกค้า.

    ตอนนี้แค่ log ไว้ ไม่เก็บ DB (สามารถเพิ่ม collection สำหรับเก็บได้ภายหลัง).
    """
    rating = req.rating if req.rating in ("up", "down", "clear") else "unknown"
    if rating != "clear":
        print(f"[FEEDBACK] rating={rating}  answer='{req.answer[:80]}...'")
    return {"status": "ok", "rating": rating}
