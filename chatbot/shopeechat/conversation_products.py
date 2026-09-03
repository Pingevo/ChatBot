"""Conversation product timeline — จำสินค้าที่กล่าวถึงในแชท.

เก็บ timeline ของสินค้าทุกชิ้นที่ถูกกล่าวถึงในแชทหนึ่ง:
  - anchor product: สินค้าที่ลูกค้าส่งเข้ามาเอง ([item], [variation_card], [order])
  - suggestion product: สินค้าที่ bot แนะนำ

กฎ active product:
  - active = anchor ล่าสุด (ไม่ใช่ suggestion ล่าสุด)
  - ถ้าลูกค้าพูดชื่อรุ่นเฉพาะ → override active เป็นสินค้านั้น
  - ถ้าลูกค้าพูด "ตัวเดิม/อันเดิม/ของเดิม" → active = anchor ล่าสุด
  - ถ้าลูกค้าถาม generic ("มีรูปไหม", "ราคาเท่าไหร่") → ใช้ active product
  - ถ้าลูกค้าพูด "อันที่แนะนำ/อันที่ส่งมา" → ใช้ suggestion ล่าสุด

Storage: MongoDB admin DB, collection `conversation_products`
Schema: เก็บถาวร (ไม่มี TTL)
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

# Lazy import knowledge_base เพื่อใช้ _build_admin_client
_kb = None


def _admin_db():
    """DB สำหรับ conversation_products — ใช้ admin client."""
    global _kb
    if _kb is None:
        from . import knowledge_base
        _kb = knowledge_base
    db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    return _kb._build_admin_client()[db_name]


def _coll():
    """Collection conversation_products."""
    return _admin_db()["conversation_products"]


# ─── Indicators ────────────────────────────────────────────

# คำที่ลูกค้าพูดแล้วหมายถึง "สินค้าเดิมที่เคยคุย"
_SAME_PRODUCT_KWS = (
    "ตัวเดิม", "อันเดิม", "ของเดิม", "รุ่นเดิม", "แบบเดิม",
    "สินค้าเดิม", "อันที่ดู", "อันที่ถาม", "อันนั้น", "ตัวนั้น",
    "รุ่นนั้น", "แบบนั้น",
)

# คำที่ลูกค้าพูดแล้วหมายถึง "สินค้าที่ bot แนะนำ"
_SUGGESTION_REF_KWS = (
    "อันที่แนะนำ", "อันที่ส่งมา", "อันที่แปะ", "อันที่ให้ดู",
    "ที่แนะนำ", "ที่ส่งมา", "ที่แปะ", "ที่ให้ดู",
    "แนะนำมา", "ส่งมาให้", "แปะมา",
)

# คำถาม generic ที่ไม่ระบุสินค้า — ควรใช้ active product
_GENERIC_Q_KWS = (
    "มีรูป", "มีวีดีโอ", "มีวิดีโอ", "มีคลิป", "ราคา", "กี่บาท",
    "เท่าไหร่", "เท่าไร", "รับประกัน", "ประกัน", "เคลม",
    "จัดส่ง", "กี่วัน", "กี่ปี", "ส่งจาก", "ส่งไว", "ส่งเร็ว",
    "มีสินค้า", "พร้อมส่ง", "มีของ", "stock", "สต็อก",
    "สเปก", "spec", "รายละเอียด", "ขนาด", "น้ำหนัก",
    "สี", "color", "ตัวเลือก", "variant", "model",
    "ใช้งานยังไง", "วิธีใช้", "คู่มือ", "แอป", "app",
    "เชื่อมต่อ", "เชื่อมต่อยังไง", "pairing", "จับคู่",
    "เสีย", "พัง", "ไม่ทำงาน", "ปัญหา",
    "ดีไหม", "ดีไหมครับ", "ดีป่าว", "แนะนำ",
    "ส่งฟรี", "ฟรี", "ส่วนลด", "โปร", "โปรโมชั่น",
)


# ─── CRUD ──────────────────────────────────────────────────

def _to_serializable(obj: Any) -> Any:
    """แปลงค่าให้ serializable สำหรับ Mongo (float → int ถ้าเป็น .0)."""
    if isinstance(obj, float) and obj == int(obj):
        return int(obj)
    # แปลง string ที่เป็นตัวเลข เช่น "47615436122.0" → int 47615436122
    if isinstance(obj, str):
        try:
            f = float(obj)
            if f == int(f):
                return int(f)
        except (ValueError, TypeError):
            pass
    return obj


def load_timeline(conversation_id: str) -> dict | None:
    """โหลด product timeline ของแชท.

    Returns:
        doc ที่มี products list + active_item_id หรือ None ถ้าไม่มี
    """
    if not conversation_id:
        return None
    try:
        doc = _coll().find_one({"conversation_id": conversation_id})
        return doc
    except Exception:
        return None


def save_timeline(conversation_id: str, platform: str | None, shop: str | None,
                  products: list[dict], active_item_id: str | int | None) -> None:
    """บันทึก product timeline.

    Args:
        conversation_id: ID ของแชท
        platform: shopee/tiktok/lazada
        shop: ชื่อร้าน
        products: list ของ {item_id, name, source, mentioned_at, is_anchor, card}
        active_item_id: item_id ของ active product
    """
    if not conversation_id:
        return
    try:
        now = datetime.now(timezone.utc)
        _coll().update_one(
            {"conversation_id": conversation_id},
            {
                "$set": {
                    "conversation_id": conversation_id,
                    "platform": platform,
                    "shop": shop,
                    "products": products,
                    "active_item_id": _to_serializable(active_item_id),
                    "last_updated": now,
                },
            },
            upsert=True,
        )
    except Exception:
        pass


def add_product(
    conversation_id: str,
    platform: str | None,
    shop: str | None,
    item_id: str | int | None,
    name: str,
    source: str,  # "user_item_card" | "user_variation_card" | "user_order" | "bot_suggestion"
    card: dict | None = None,
    is_anchor: bool = False,
) -> dict | None:
    """เพิ่มสินค้าเข้า timeline + คำนวณ active ใหม่.

    Returns:
        timeline doc ที่อัปเดตแล้ว หรือ None ถ้า error
    """
    if not conversation_id or not item_id:
        return None
    try:
        doc = load_timeline(conversation_id) or {
            "conversation_id": conversation_id,
            "platform": platform,
            "shop": shop,
            "products": [],
            "active_item_id": None,
        }
        products = doc.get("products", [])
        item_id_ser = _to_serializable(item_id)

        # ถ้าสินค้านี้มีอยู่แล้ว → อัปเดต mentioned_at + card (ไม่เพิ่มซ้ำ)
        existing = None
        for p in products:
            if _to_serializable(p.get("item_id")) == item_id_ser:
                existing = p
                break
        now = datetime.now(timezone.utc)
        if existing:
            existing["mentioned_at"] = now
            existing["source"] = source  # อัปเดต source ล่าสุด
            if card:
                existing["card"] = _strip_card_for_storage(card)
            # ถ้าเป็น anchor ครั้งนี้ → อัปเดต is_anchor
            if is_anchor:
                existing["is_anchor"] = True
        else:
            products.append({
                "item_id": item_id_ser,
                "name": name,
                "source": source,
                "mentioned_at": now,
                "is_anchor": is_anchor,
                "card": _strip_card_for_storage(card) if card else None,
            })

        # คำนวณ active: anchor ล่าสุด (ถ้ามี) ไม่ใช่ suggestion ล่าสุด
        active_item_id = _compute_active(products)
        save_timeline(conversation_id, platform, shop, products, active_item_id)
        doc["products"] = products
        doc["active_item_id"] = active_item_id
        return doc
    except Exception:
        return None


def _strip_card_for_storage(card: dict) -> dict:
    """ตัด card ให้เก็บแค่ fields ที่จำเป็น (ประหยัดพื้นที่)."""
    if not card or not isinstance(card, dict):
        return {}
    return {
        "item_id": _to_serializable(card.get("item_id")),
        "name": card.get("name"),
        "brand": card.get("brand"),
        "category": card.get("category"),
        "shop": card.get("shop"),
        "price": card.get("price"),
        "warranty": card.get("warranty"),
        "short_link": card.get("short_link"),
        "image_url": card.get("image_url"),
        "total_stock": card.get("total_stock"),
        "sold_out": card.get("sold_out"),
        "has_promotion": card.get("has_promotion"),
        "is_flash_sale": card.get("is_flash_sale"),
        "description_excerpt": (card.get("description_excerpt") or "")[:2000],
        "variants": (card.get("variants") or [])[:10],
        "tier_variation": (card.get("tier_variation") or [])[:5],
    }


def _compute_active(products: list[dict]) -> str | int | None:
    """คำนวณ active product = anchor ล่าสุด.

    ถ้าไม่มี anchor → ใช้ suggestion ล่าสุด (fallback)
    """
    anchors = [p for p in products if p.get("is_anchor")]
    if anchors:
        anchors.sort(key=lambda p: p.get("mentioned_at", datetime.min) if isinstance(p.get("mentioned_at"), datetime) else datetime.min, reverse=True)
        return _to_serializable(anchors[0].get("item_id"))
    # fallback: suggestion ล่าสุด
    if products:
        sorted_p = sorted(products, key=lambda p: p.get("mentioned_at", datetime.min) if isinstance(p.get("mentioned_at"), datetime) else datetime.min, reverse=True)
        return _to_serializable(sorted_p[0].get("item_id"))
    return None


# ─── Query helpers ─────────────────────────────────────────

def get_active_product(conversation_id: str) -> dict | None:
    """ดึง active product card ของแชท.

    Returns:
        product card (dict) หรือ None ถ้าไม่มี
    """
    doc = load_timeline(conversation_id)
    if not doc:
        return None
    active_id = doc.get("active_item_id")
    if not active_id:
        return None
    active_id_ser = _to_serializable(active_id)
    for p in doc.get("products", []):
        if _to_serializable(p.get("item_id")) == active_id_ser:
            return p.get("card") or {"item_id": p.get("item_id"), "name": p.get("name")}
    return None


def get_suggestion_latest(conversation_id: str) -> dict | None:
    """ดึง suggestion product ล่าสุด (สินค้าที่ bot แนะนำ)."""
    doc = load_timeline(conversation_id)
    if not doc:
        return None
    suggestions = [p for p in doc.get("products", []) if not p.get("is_anchor")]
    if not suggestions:
        return None
    suggestions.sort(key=lambda p: p.get("mentioned_at", datetime.min) if isinstance(p.get("mentioned_at"), datetime) else datetime.min, reverse=True)
    s = suggestions[0]
    return s.get("card") or {"item_id": s.get("item_id"), "name": s.get("name")}


def resolve_active_by_message(
    conversation_id: str,
    message: str,
    model_keywords: list[str] | None = None,
) -> dict | None:
    """resolve active product ตามกฎ:
    1. ถ้า message มีชื่อรุ่นเฉพาะ → หาสินค้าที่ match ใน timeline
    2. ถ้า message พูด "ตัวเดิม/อันเดิม" → anchor ล่าสุด
    3. ถ้า message พูด "อันที่แนะนำ/ที่ส่งมา" → suggestion ล่าสุด
    4. ถ้า message เป็น generic question → active product (anchor ล่าสุด)
    5. ถ้าไม่ตรงเงื่อนไขไหน → active product (default)

    Args:
        conversation_id: ID ของแชท
        message: คำถามลูกค้าปัจจุบัน
        model_keywords: model keywords ที่ extract ได้จาก message (optional)

    Returns:
        product card (dict) หรือ None ถ้าไม่มี timeline
    """
    doc = load_timeline(conversation_id)
    if not doc or not doc.get("products"):
        return None

    products = doc.get("products", [])
    msg_lower = (message or "").lower().strip()

    # 1. ถ้ามี model keyword → หาสินค้าที่ match ชื่อ
    if model_keywords:
        for kw in model_keywords:
            kw_lower = kw.lower()
            for p in products:
                name = (p.get("name") or "").lower()
                if kw_lower in name:
                    return p.get("card") or {"item_id": p.get("item_id"), "name": p.get("name")}

    # 2. "ตัวเดิม/อันเดิม" → anchor ล่าสุด
    if any(kw in msg_lower for kw in _SAME_PRODUCT_KWS):
        return get_active_product(conversation_id)

    # 3. "อันที่แนะนำ/ที่ส่งมา" → suggestion ล่าสุด
    if any(kw in msg_lower for kw in _SUGGESTION_REF_KWS):
        return get_suggestion_latest(conversation_id)

    # 4 & 5. default → active product
    return get_active_product(conversation_id)


def is_generic_question(message: str) -> bool:
    """ตรวจว่าคำถามเป็น generic (ไม่ระบุสินค้า) หรือไม่.

    ใช้ตัดสินใจว่าควรใช้ active product หรือควร RAG ใหม่.
    """
    msg_lower = (message or "").lower().strip()
    if not msg_lower:
        return False
    # ถ้ามี model keyword → ไม่ใช่ generic
    # (caller เช็คเอง ที่นี่เช็คแค่ keyword)
    return any(kw in msg_lower for kw in _GENERIC_Q_KWS)
