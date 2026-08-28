"""ดึง persona ของร้านจาก admin MongoDB.

ใช้สำหรับตั้งชื่อตัวแทนบอทของแต่ละร้าน (admin ตั้งในหน้า /persona ของ ChatAdminWeb)
ถ้าร้านยังไม่ได้ตั้ง persona → คืน None แล้ว chatbot จะใช้ "ชื่อร้าน" แบบเดิม
"""
from __future__ import annotations

import os
import sys
from typing import Optional

from pymongo import MongoClient


_cached_admin_client: MongoClient | None = None


def _build_admin_client() -> MongoClient:
    """Singleton admin client — ใช้ connection ร่วมกับ knowledge_base.py.

    ทำซ้ำจาก knowledge_base._build_admin_client() เพื่อให้ persona.py ไม่พึ่งพา
    knowledge_base ในกรณีที่โหลดเฉพาะ persona (decoupling)
    """
    global _cached_admin_client
    if _cached_admin_client is not None:
        try:
            _cached_admin_client.admin.command("ping")
            return _cached_admin_client
        except Exception:
            _cached_admin_client = None
    uri = os.environ.get("ADMIN_MONGO_URI", "").strip()
    if uri:
        _cached_admin_client = MongoClient(uri)
        return _cached_admin_client
    host = os.environ.get("ADMIN_MONGO_HOST", "127.0.0.1:27017").strip()
    username = os.environ.get("ADMIN_MONGO_USERNAME", "").strip()
    password = os.environ.get("ADMIN_MONGO_PASSWORD", "").strip()
    auth_source = os.environ.get("ADMIN_MONGO_AUTH_SOURCE", "admin").strip()
    tls = os.environ.get("ADMIN_MONGO_TLS", "false").strip().lower() == "true"
    params: dict = {"host": host, "authSource": auth_source, "tls": tls}
    if username:
        params["username"] = username
    if password:
        params["password"] = password
    _cached_admin_client = MongoClient(**params)
    return _cached_admin_client


def _persona_coll():
    """คืน collection shop_personas จาก admin DB."""
    db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    coll_name = os.environ.get(
        "ADMIN_MONGO_COLLECTION_SHOP_PERSONAS", "shop_personas"
    ).strip()
    return _build_admin_client()[db_name][coll_name]


def get_persona(
    shopname: str | None,
    platform: str = "shopee",
) -> Optional[dict]:
    """ดึง persona ของร้าน (shopname + platform).

    Args:
        shopname: ชื่อร้านที่ลูกค้าทักเข้ามา (เช่น "IMILabThailand")
        platform: "shopee" | "tiktok" | "lazada" (default shopee)

    Returns:
        dict {bot_name, enabled, notes} หรือ None ถ้า:
        - ไม่ได้ส่ง shopname
        - ไม่พบ persona ของร้านนี้
        - persona ของร้านนี้ถูกปิดการใช้งาน (enabled=False) หรือ soft-deleted

    Fallback: ถ้าหา exact match ไม่เจอ จะลอง case-insensitive เผื่อ shopname
    ใน admin shops collection กับ product collection เก็บ format ต่างกัน
    """
    if not shopname or not shopname.strip():
        return None
    shopname_clean = shopname.strip()
    try:
        # พยายาม exact match ก่อน (soft-deleted ไม่แสดง)
        doc = _persona_coll().find_one(
            {"shopname": shopname_clean, "platform": platform, "is_deleted": {"$ne": True}},
            {"_id": 0, "bot_name": 1, "enabled": 1, "notes": 1},
        )
        # Fallback: case-insensitive match (เผื่อ shopname ใน product DB กับ admin DB ต่าง case)
        if not doc:
            doc = _persona_coll().find_one(
                {
                    "shopname": {"$regex": f"^{shopname_clean}$", "$options": "i"},
                    "platform": platform,
                    "is_deleted": {"$ne": True},
                },
                {"_id": 0, "bot_name": 1, "enabled": 1, "notes": 1},
            )
            if doc:
                print(
                    f"[PERSONA] พบ persona ด้วย case-insensitive match "
                    f"(shopname ที่ส่งมา='{shopname_clean}')",
                    file=sys.stderr,
                )
    except Exception as exc:
        print(f"[PERSONA] ดึง persona ไม่ได้ (shopname={shopname_clean}, {exc})", file=sys.stderr)
        return None
    if not doc:
        print(
            f"[PERSONA] ไม่พบ persona ของร้าน '{shopname_clean}' (platform={platform}) "
            f"— ใช้ default (ชื่อร้าน)",
            file=sys.stderr,
        )
        return None
    if not doc.get("enabled", True):
        print(f"[PERSONA] persona ของร้าน '{shopname_clean}' ถูกปิดใช้งาน — ใช้ default", file=sys.stderr)
        return None
    bot_name = (doc.get("bot_name") or "").strip()
    if not bot_name:
        return None
    print(
        f"[PERSONA] ใช้ persona '{bot_name}' สำหรับร้าน '{shopname_clean}'",
        file=sys.stderr,
    )
    return {
        "bot_name": bot_name,
        "notes": doc.get("notes") or "",
    }


def build_persona_instruction(persona: dict | None, shop_hint: str | None) -> str:
    """สร้าง instruction เพิ่มเติมจาก persona ที่จะแทรกต่อท้าย SYSTEM_INSTRUCTION.

    ถ้าไม่มี persona → คืน "" (ใช้ system instruction เดิมที่อ้างถึง "ชื่อร้าน")
    ถ้ามี persona → คืน block ที่บอก LLM ว่าชื่ออะไร ให้แนะนำตัวบางกรณี

    Args:
        persona: ผลจาก get_persona()
        shop_hint: ชื่อร้านที่ลูกค้าทัก (ใช้ในบริบท "ร้าน X")
    """
    if not persona:
        return ""
    bot_name = persona["bot_name"]
    lines = [
        "",
        "=== ตัวตนของคุณ (Persona ของร้านนี้) ===",
        f"ชื่อของคุณคือ \"{bot_name}\" — คุณเป็นผู้ช่วยขายของร้าน {shop_hint or '(ร้านที่ลูกค้าทักเข้ามา)'}",
    ]
    if persona.get("notes"):
        lines.append(f"หมายเหตุจากแอดมิน: {persona['notes']}")
    lines.extend(
        [
            "",
            "วิธีใช้ชื่อตัวเอง (สำคัญมาก — อ่านให้จบ):",
            "- **ทุกคำตอบ** ต้องมีการแทนตัว/อ้างถึงชื่อตัวเองอย่างน้อย 1 ครั้ง — บังคับ",
            "- ตัวอย่างการแทนตัวที่เป็นธรรมชาติ (ไม่ต้องต้นประโยคเสมอ):",
            '  • "สินค้ารุ่นนี้ราคา 299 บาทค่ะ — {} เป็นคนแนะนำเลยนะคะ"',
            '  • "ร้านเรามีหัวชาร์จ 65W หลายรุ่นเลยค่ะ ถ้าสนใจ {} จะสรุปให้ได้เลยนะคะ"',
            '  • "รับประกัน 2 ปีค่ะ หากมีปัญหา {} พร้อมช่วยดูให้นะคะ"',
            '  • "ทางร้านเรามีสินค้าตามที่ถามค่ะ — {} ขอสรุปรุ่นน่าสนใจให้นะคะ"',
            '- ห้ามเริ่มต้นประโยคด้วย "ชื่อ{}" หรือ "สวัสดีค่ะ ชื่อ{}" เด็ดขาด (ยกเว้นลูกค้าถามชื่อโดยตรง)',
            "- ให้แทรกชื่อตัวเองตามธรรมชาติกลางประโยคหรือท้ายประโยค เพื่อให้ลูกค้ารู้สึกว่ากำลังคุยกับคนจริง",
            '- ถ้าลูกค้าถามชื่อคุณโดยตรง ให้ตอบว่า "ชื่อ...{} ค่ะ"',
            '- ถ้าลูกค้าเรียกชื่ออื่น ให้แนะนำตัวสั้นๆ ว่า "เอ่อ...ชื่อ{} ค่ะ"',
            "- บุคลิก (ค่ะ/นะคะ/ผู้หญิง) เหมือนเดิม — ไม่เปลี่ยน",
        ]
    )
    return "\n".join(lines).format(bot_name, bot_name, bot_name, bot_name, bot_name, bot_name, bot_name, bot_name, bot_name, bot_name)
