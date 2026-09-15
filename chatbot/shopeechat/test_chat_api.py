"""Test Chat Sessions API — ย้ายออกจาก app.py (refactor 2026-09-15).

เก็บประวัติแชทจากหน้า testchat ลง MongoDB collection "test_chat_sessions"
⚡ ใช้ env var ADMIN_MONGO_COLLECTION_TEST_CHAT_SESSIONS (default: test_chat_sessions)
   ต้องตรงกับ Next.js COLLECTIONS.testChatSessions

admin DB ใช้ conversation_products._admin_db (wrapper ของ knowledge_base._build_admin_client)
— ไม่ import app.py เพื่อกัน circular import
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel as _BM, Field as _F

from .conversation_products import _admin_db

router = APIRouter()

_TEST_CHAT_SESSIONS_COLL = os.environ.get("ADMIN_MONGO_COLLECTION_TEST_CHAT_SESSIONS", "test_chat_sessions").strip() or "test_chat_sessions"


def _validate_object_id(oid: str) -> str:
    """🔒 L4: Validate ObjectId format before passing to MongoDB — prevents 500 + info leak."""
    from bson import ObjectId
    if not oid or not isinstance(oid, str) or len(oid) != 24:
        raise HTTPException(status_code=400, detail="invalid id format")
    try:
        ObjectId(oid)  # validate parseable
        return oid
    except Exception:
        raise HTTPException(status_code=400, detail="invalid id format")


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


class TestChatMessage(_BM):
    role: str = _F(..., description="user | model")
    text: str = _F(...)
    timestamp: str = _F(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # metadata สำหรับ bot response
    stats: dict[str, Any] = _F(default_factory=dict, description="source, timing, usage, cost, intent, steps, products")
    # ⚡ Phase 1F — images URL ที่ลูกค้าส่งใน message นี้ (persist สำหรับ reload)
    images: list[str] = _F(default_factory=list, description="URL รูปภาพใน message นี้ (ถ้ามี)")


class CreateSessionRequest(_BM):
    shop: str = _F("", description="ชื่อร้าน (optional — เลือกทีหลังได้)")
    title: str | None = _F(None, description="ชื่อ session (optional — auto from first message)")


class AddMessageRequest(_BM):
    session_id: str = _F(...)
    message: TestChatMessage


class UpdateSessionRequest(_BM):
    shop: str | None = _F(None, description="เปลี่ยนร้านของ session")
    title: str | None = _F(None, description="เปลี่ยนชื่อ session")


@router.get("/test-chat/sessions")
def list_test_chat_sessions(request: Request, shop: str | None = None, limit: int = 50):
    """list sessions — ถ้ามี shop กรองเฉพาะร้านนั้น

    ⚡ Phase 3 — กรองตาม admin_id จาก header X-Admin-Id
    - session ที่มี admin_id == ผู้เรียก → เห็น
    - session legacy (ไม่มี field admin_id) → เห็นทุกคน (backward compat)
    """
    try:
        db = _admin_db()
        admin_id = (request.headers.get("X-Admin-Id") or "").strip()
        query: dict[str, Any] = {}
        if shop:
            query["shop"] = shop
        if admin_id:
            # เห็น session ของตัวเอง + legacy session (ไม่มี admin_id field)
            # ⚡ + script_test sessions (shadow bot — ให้ทุกคนเห็น)
            query["$or"] = [
                {"admin_id": admin_id},
                {"admin_id": {"$exists": False}},
                {"admin_id": None},
                {"admin_id": ""},
                {"source": "script_test"},
            ]
        cursor = db[_TEST_CHAT_SESSIONS_COLL].find(query).sort("updated_at", -1).limit(limit)
        sessions = []
        for doc in cursor:
            sessions.append({
                "id": str(doc["_id"]),
                "shop": doc.get("shop", ""),
                "title": doc.get("title", "ไม่มีชื่อ"),
                "message_count": len(doc.get("messages", [])),
                "created_at": doc.get("created_at"),
                "updated_at": doc.get("updated_at"),
                "admin_id": doc.get("admin_id", ""),
                "admin_name": doc.get("admin_name", ""),
                # ⚡ script_test badge — mark ว่ามาจาก shadow script
                "source": doc.get("source", ""),
                "script_test": doc.get("script_test", False),
            })
        return {"sessions": sessions}
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


@router.post("/test-chat/sessions")
def create_test_chat_session(req: CreateSessionRequest, request: Request) -> dict:
    """สร้าง session ใหม่

    ⚡ Phase 3 — เก็บ admin_id + admin_name ของผู้สร้างลง doc
    """
    try:
        from urllib.parse import unquote
        db = _admin_db()
        now = datetime.now(timezone.utc)
        admin_id = (request.headers.get("X-Admin-Id") or "").strip() or "anonymous"
        admin_name_raw = (request.headers.get("X-Admin-Name") or "").strip()
        admin_name = unquote(admin_name_raw) if admin_name_raw else "anonymous"
        doc = {
            "shop": req.shop,
            "title": req.title or "แชทใหม่",
            "messages": [],
            "created_at": now,
            "updated_at": now,
            "admin_id": admin_id,
            "admin_name": admin_name,
        }
        result = db[_TEST_CHAT_SESSIONS_COLL].insert_one(doc)
        session_id = str(result.inserted_id)
        _log_testchat_action("create_session", request, session_id, shop=req.shop, title=doc["title"])
        return {"id": session_id, "shop": req.shop, "title": doc["title"]}
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


@router.get("/test-chat/sessions/{session_id}")
def get_test_chat_session(session_id: str) -> dict:
    _validate_object_id(session_id)  # 🔒 L4
    """ดึง session พร้อม messages"""
    try:
        from bson import ObjectId
        db = _admin_db()
        doc = db[_TEST_CHAT_SESSIONS_COLL].find_one({"_id": ObjectId(session_id)})
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
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


@router.post("/test-chat/sessions/{session_id}/messages")
def add_test_chat_message(session_id: str, req: AddMessageRequest, request: Request) -> dict:
    _validate_object_id(session_id)  # 🔒 L4
    """เพิ่ม message ลง session"""
    try:
        from bson import ObjectId
        db = _admin_db()
        now = datetime.now(timezone.utc)
        msg_doc = req.message.model_dump()
        result = db[_TEST_CHAT_SESSIONS_COLL].update_one(
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
            doc = db[_TEST_CHAT_SESSIONS_COLL].find_one({"_id": ObjectId(session_id)})
            if doc and doc.get("title", "แชทใหม่") == "แชทใหม่":
                title = req.message.text[:40] + ("..." if len(req.message.text) > 40 else "")
                db[_TEST_CHAT_SESSIONS_COLL].update_one(
                    {"_id": ObjectId(session_id)},
                    {"$set": {"title": title}},
                )
        # ⚡ log การส่งข้อความ (เก็บเฉพาะ role + text preview)
        _log_testchat_action(
            "add_message", request, session_id,
            role=req.message.role,
            text_preview=req.message.text[:120],
            shop=(db[_TEST_CHAT_SESSIONS_COLL].find_one({"_id": ObjectId(session_id)}) or {}).get("shop", ""),
        )
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


@router.delete("/test-chat/sessions/{session_id}")
def delete_test_chat_session(session_id: str, request: Request) -> dict:
    _validate_object_id(session_id)  # 🔒 L4
    """ลบ session"""
    try:
        from bson import ObjectId
        db = _admin_db()
        # เก็บ info ก่อนลบ เพื่อ log
        doc = db[_TEST_CHAT_SESSIONS_COLL].find_one({"_id": ObjectId(session_id)})
        result = db[_TEST_CHAT_SESSIONS_COLL].delete_one({"_id": ObjectId(session_id)})
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
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


@router.put("/test-chat/sessions/{session_id}")
def update_test_chat_session(session_id: str, req: UpdateSessionRequest, request: Request) -> dict:
    _validate_object_id(session_id)  # 🔒 L4
    """อัปเดต session (เช่น เปลี่ยนร้าน)"""
    try:
        from bson import ObjectId
        db = _admin_db()
        # เก็บค่าเดิมก่อนอัปเดต เพื่อ log
        old_doc = db[_TEST_CHAT_SESSIONS_COLL].find_one({"_id": ObjectId(session_id)})
        old_shop = (old_doc or {}).get("shop", "")
        old_title = (old_doc or {}).get("title", "")
        update_fields: dict[str, Any] = {"updated_at": datetime.now(timezone.utc)}
        if req.shop is not None:
            # 🔒 L5: Limit shop field length to prevent abuse
            update_fields["shop"] = str(req.shop)[:100]
        if req.title is not None:
            # 🔒 L5: Limit title field length to prevent abuse
            update_fields["title"] = str(req.title)[:200]
        result = db[_TEST_CHAT_SESSIONS_COLL].update_one(
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
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


# ── Test chat session close/reopen — state-driven handoff reset ──
# ⚡ Phase 2A — ปุ่ม "ปิดแชท (ให้บอทตอบต่อ)" ใน TestChatClient เรียก endpoint นี้
#    อัปเดต test_chat_sessions.status = "closed" → botCallService ดึง status ส่งให้บอท
#    บอทเห็น ticket_state="closed" → ข้าม post-handoff lock → ตอบปกติ
@router.post("/test-chat/sessions/{session_id}/close")
def close_test_chat_session(session_id: str, request: Request) -> dict:
    _validate_object_id(session_id)  # 🔒 L4
    """ปิดแชท — อัปเดต status เป็น 'closed' + closed_at + closed_by (simulate mode)

    หลังปิด → บอทจะตอบปกติ (ไม่ล็อค post-handoff) เพราะ botCallService ดึง status นี้ส่งให้บอท
    """
    try:
        from bson import ObjectId
        db = _admin_db()
        now = datetime.now(timezone.utc)
        # ดึง admin id จาก header (proxy แนบมา)
        closed_by = request.headers.get("x-admin-id", "test_chat_user")
        result = db[_TEST_CHAT_SESSIONS_COLL].update_one(
            {"_id": ObjectId(session_id)},
            {
                "$set": {
                    "status": "closed",
                    "closed_at": now,
                    "closed_by": closed_by,
                    "updated_at": now,
                },
            },
        )
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="session not found")
        _log_testchat_action("close_session", request, session_id, status="closed")
        return {"ok": True, "status": "closed", "closed_at": now.isoformat()}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


@router.post("/test-chat/sessions/{session_id}/reopen")
def reopen_test_chat_session(session_id: str, request: Request) -> dict:
    _validate_object_id(session_id)  # 🔒 L4
    """เปิดแชทใหม่ — อัปเดต status เป็น 'open' + clear closed_at (simulate mode)

    ใช้ตอนแอดมินอยากให้บอทหยุดตอบอีกครั้งหลังปิดไปแล้ว
    """
    try:
        from bson import ObjectId
        db = _admin_db()
        now = datetime.now(timezone.utc)
        result = db[_TEST_CHAT_SESSIONS_COLL].update_one(
            {"_id": ObjectId(session_id)},
            {
                "$set": {
                    "status": "open",
                    "closed_at": None,
                    "updated_at": now,
                },
            },
        )
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="session not found")
        _log_testchat_action("reopen_session", request, session_id, status="open")
        return {"ok": True, "status": "open"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")


class RateMessageRequest(_BM):
    star_rating: float | None = _F(None, description="ดาว 0-5")
    comment: str | None = _F(None, description="คอมเมนต์")
    rating: str | None = _F(None, description="better|worse|tie|unrated")


# ⚡ rate/stats ย้ายไป Next.js (admin mongo) แล้ว — ไม่ต้องยุ่งกับ Python


@router.get("/test-chat/logs")
def list_test_chat_logs(request: Request, limit: int = 100, action: str | None = None, admin_id: str | None = None):
    """ดู log การใช้งาน testchat — ใคร ทำอะไร แชทไหน เมื่อไหร่.

    ⚡ Phase 3 — รองรับ filter ตาม admin_id
    - ถ้าส่ง query param `admin_id` มา → กรองเฉพาะ admin นั้น
    - ถ้าไม่ส่ง → ดึงจาก header X-Admin-Id (default: เห็นเฉพาะของตัวเอง)
    - ถ้าส่ง `admin_id=all` → ดูทุกคน (สำหรับ superadmin)
    """
    try:
        db = _admin_db()
        query: dict[str, Any] = {}
        if action:
            query["action"] = action
        # resolve admin_id filter
        effective_admin_id = admin_id
        if not effective_admin_id:
            effective_admin_id = (request.headers.get("X-Admin-Id") or "").strip()
        if effective_admin_id and effective_admin_id != "all":
            query["admin_id"] = effective_admin_id
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
        print(f"[ERROR] {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="internal server error")
