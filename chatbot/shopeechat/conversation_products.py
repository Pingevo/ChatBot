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
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Literal, NamedTuple

from . import generation_pointer as _gen
from . import route_context as _rc

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
    # ⚡ Phase 2Z+++ — เพิ่ม "อันนี้", "ตัวนี้", "รุ่นนี้" ให้ deictic singular
    #    match anchor ล่าสุดแทน default (owner ปัจจุบัน = resolve_subjects)
    "อันนี้", "ตัวนี้", "รุ่นนี้", "ชิ้นนี้", "สินค้านี้",
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
    # ⚡ link follow-up — ลูกค้าขอลิงค์/ช่องทางซื้อ → ใช้สินค้าก่อนหน้า
    "ลิงค์", "ลิงก์", "ลิ้งค์", "ลิ้งก์", "link", "ขอลิงค์", "ขอลิงก์",
    "ขอลิ้งค์", "ขอลิ้งก์", "ขอ link", "ขอ url", "url",
    "ช่องทางซื้อ", "สั่งซื้อ", "ขอสั่ง", "ขอซื้อ", "สั่งได้เลย",
    "ส่งลิงค์", "ส่งลิงก์", "ส่ง link", "ขอเว็บ", "เว็บสินค้า",
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
    model_id: str | int | None = None,
    model_name: str | None = None,
) -> dict | None:
    """เพิ่มสินค้าเข้า timeline + คำนวณ active ใหม่.

    model_id/model_name (⚡ Task 6): variation ที่ลูกค้าหมายถึง (เช่น จาก order item)
    — anchor ระดับรุ่นย่อย ไม่ใช่แค่ระดับ listing

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
        model_id_ser = _to_serializable(model_id) if model_id is not None else None

        # ถ้าสินค้านี้มีอยู่แล้ว → อัปเดต mentioned_at + card (ไม่เพิ่มซ้ำ)
        # match ด้วย item_id + model_id (model_id ว่างฝั่งใดฝั่งหนึ่งถือว่าตัวเดียวกัน)
        existing = None
        for p in products:
            if _to_serializable(p.get("item_id")) != item_id_ser:
                continue
            p_mid = p.get("model_id")
            if model_id_ser is None or p_mid is None or _to_serializable(p_mid) == model_id_ser:
                existing = p
                break
        now = datetime.now(timezone.utc)
        if existing:
            existing["mentioned_at"] = now
            existing["source"] = source  # อัปเดต source ล่าสุด
            if card:
                existing["card"] = _strip_card_for_storage(card)
            if model_id_ser is not None:
                existing["model_id"] = model_id_ser
            if model_name:
                existing["model_name"] = model_name
            # ถ้าเป็น anchor ครั้งนี้ → อัปเดต is_anchor
            if is_anchor:
                existing["is_anchor"] = True
        else:
            products.append({
                "item_id": item_id_ser,
                "model_id": model_id_ser,
                "model_name": model_name,
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
        "status": card.get("status"),
        "total_stock": card.get("total_stock"),
        "sold_out": card.get("sold_out"),
        "_available_for_sale": card.get("_available_for_sale"),
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
    def _sort_key(p: dict) -> datetime:
        return _normalize_dt(p.get("mentioned_at"))

    anchors = [p for p in products if p.get("is_anchor")]
    if anchors:
        anchors.sort(key=_sort_key, reverse=True)
        return _to_serializable(anchors[0].get("item_id"))
    # fallback: suggestion ล่าสุด
    if products:
        sorted_p = sorted(products, key=_sort_key, reverse=True)
        return _to_serializable(sorted_p[0].get("item_id"))
    return None


# ─── Live card refresh ────────────────────────────────────
# card ที่เก็บใน timeline เป็น snapshot ตอน build — image_url/name/stock/price
# ค้างตามโค้ด+ข้อมูลตอนนั้น (เช่น desc banner จาก to_unit_card เก่า) และไม่มี TTL
# → restore ทุกครั้ง rebuild จาก DB สด; doc หาย/query พัง → คืน stored card เดิม

_LIVE_CARD_TTL = 30.0  # ponytail: cache 30s ต่อ (item_id, model_name) — กัน rebuild ซ้ำหลายครั้งใน request เดียว
_LIVE_CARD_CACHE: dict = {}


def _rebuild_card(p: dict, message: str = "", snap=_gen.SNAP_UNSET) -> dict | None:
    """สร้าง card ใหม่จาก live data — unit card ถ้า entry ระดับรุ่นย่อย, listing card ถ้าไม่ใช่.

    unit detection: entry.model_name (user anchors ระบุรุ่นย่อย) หรือ stored card
    ที่มี variants ตัวเดียว (to_unit_card เก็บ model_name ไว้ใน variants[0].name)
    """
    item_id = _to_serializable(p.get("item_id"))
    if item_id is None:
        return None
    from . import product_store as _ps
    db_name = os.environ.get("MONGO_DB", "").strip()
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    doc = _ps.get_client()[db_name][coll_name].find_one({"item_id": item_id})
    if not doc:
        return None
    card = p.get("card") or {}
    vlist = card.get("variants") or []
    model_name = p.get("model_name") or (
        vlist[0].get("name") if len(vlist) == 1 else None)
    if model_name:
        try:
            from . import units as _units
            snap = _gen.resolve_snapshot() if snap is _gen.SNAP_UNSET else snap
            u = _units._units_coll(snap).find_one(
                {"item_id": item_id, "model_name": model_name})
            if u:
                # helper chain เดียวกับ fetch_unit_cards — unit card สดครบทุก field
                u = _units.attach_image_texts(
                    _units.attach_kb_specs([u]), snap)[0]
                u["_listing"] = doc
                return _units.to_unit_card(u)
        except Exception:
            pass
    return _ps.to_product_card(doc, message)


def _materialize_card(p: dict, message: str = "", snap=_gen.SNAP_UNSET) -> dict:
    """คืน card ของ timeline entry — rebuild สดจาก DB ถ้าทำได้, fallback = stored card."""
    stored = p.get("card") or {"item_id": p.get("item_id"), "name": p.get("name")}
    try:
        # cache identity รวม captured generation — card ที่สร้างจาก gen A
        # ห้ามถูก reuse โดย request ที่ capture gen B/None (SNAP_UNSET =
        # standalone → resolve ครั้งเดียวที่ entry นี้ ก่อนสร้าง key)
        snap = _gen.resolve_snapshot() if snap is _gen.SNAP_UNSET else snap
        key = (str(_to_serializable(p.get("item_id"))),
               str(p.get("model_name") or ""),
               snap.generation_id if snap is not None else None)
        hit = _LIVE_CARD_CACHE.get(key)
        if hit and (time.monotonic() - hit[0]) < _LIVE_CARD_TTL:
            return hit[1]
        fresh = _rebuild_card(p, message=message, snap=snap)
        if fresh:
            _LIVE_CARD_CACHE[key] = (time.monotonic(), fresh)
            return fresh
    except Exception:
        pass
    return stored


# ─── Query helpers ─────────────────────────────────────────

def _normalize_dt(dt: Any) -> datetime:
    """แปลง mentioned_at เป็น naive datetime สำหรับ sort (กัน TypeError offset-naive vs aware)."""
    if not isinstance(dt, datetime):
        return datetime.min
    if dt.tzinfo is not None:
        return dt.replace(tzinfo=None)
    return dt


def get_active_product(conversation_id: str, snap=_gen.SNAP_UNSET) -> dict | None:
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
            return _materialize_card(p, snap=snap)
    return None


# ─── Order anchor (Phase 3C) ──────────────────────────────
# เก็บ order_sn ที่ลูกค้าส่งเข้ามา (order card / พิมพ์เลข) เป็น anchor
# ใช้สำหรับ follow-up: ลูกค้าถาม "order เดิม" / "คำสั่งซื้อเดิม" → ใช้ active order
# เก็บใน doc เดียวกับ product timeline (field `order_anchors` + `active_order_sn`)

# คำที่ลูกค้าพูดแล้วหมายถึง "order เดิม"
_SAME_ORDER_KWS = (
    "order เดิม", "ออเดอร์เดิม", "ออเดอร์เดิม",
    "คำสั่งซื้อเดิม", "คำสั่งซื้อเดิม",
    "order อันเดิม", "order ตัวเดิม",
    "ออเดอร์อันเดิม", "ออเดอร์ตัวเดิม",
    "คำสั่งซื้ออันเดิม", "คำสั่งซื้อตัวเดิม",
    "order นั้น", "ออเดอร์นั้น", "คำสั่งซื้อนั้น",
    "order นี้", "ออเดอร์นี้", "คำสั่งซื้อนี้",
    "order ที่ถาม", "ออเดอร์ที่ถาม", "คำสั่งซื้อที่ถาม",
)

# คำถาม order generic — ถามเรื่อง order แต่ไม่ระบุเลข
_ORDER_GENERIC_KWS = (
    "สถานะ order", "สถานะออเดอร์", "สถานะคำสั่งซื้อ",
    "order ถึงไหน", "ออเดอร์ถึงไหน", "คำสั่งซื้อถึงไหน",
    "order ส่งถึง", "ออเดอร์ส่งถึง", "คำสั่งซื้อส่งถึง",
    "order ส่งยัง", "ออเดอร์ส่งยัง", "คำสั่งซื้อส่งยัง",
    "order ถึงยัง", "ออเดอร์ถึงยัง", "คำสั่งซื้อถึงยัง",
    "order อยู่ไหน", "ออเดอร์อยู่ไหน", "คำสั่งซื้ออยู่ไหน",
    "พัสดุถึง", "พัสดุส่ง", "พัสดุอยู่",
    "จัดส่งยัง", "ส่งของยัง", "ส่งแล้วยัง",
    "วันที่ส่ง", "วันที่ถึง", "วันที่ได้รับ",
    "ขนส่งอะไร", "ขนส่งตัวไหน", "ใครจัดส่ง",
    "ที่อยู่จัดส่ง", "ส่งที่ไหน", "ส่งไปไหน",
)


def add_order_anchor(
    conversation_id: str,
    platform: str | None,
    shop: str | None,
    order_sn: str,
    order_info: dict | None = None,
) -> dict | None:
    """บันทึก order_sn เป็น anchor ใน conversation timeline.

    Args:
        conversation_id: ID ของแชท
        platform: shopee/tiktok/lazada
        shop: ชื่อร้าน
        order_sn: เลขคำสั่งซื้อ
        order_info: dict ข้อมูล order จาก lookup_order() (optional — เก็บ summary ไว้)

    Returns:
        timeline doc ที่อัปเดตแล้ว หรือ None ถ้า error
    """
    if not conversation_id or not order_sn:
        return None
    try:
        doc = load_timeline(conversation_id) or {
            "conversation_id": conversation_id,
            "platform": platform,
            "shop": shop,
            "products": [],
            "active_item_id": None,
        }
        order_anchors = doc.get("order_anchors", [])
        now = datetime.now(timezone.utc)

        # สร้าง summary จาก order_info (เก็บแค่ข้อมูลจำเป็น ไม่เก็บทั้ง dict)
        _summary = {}
        if order_info:
            _summary = {
                "order_status": order_info.get("order_status", ""),
                "shipping_carrier": order_info.get("shipping_carrier", ""),
                "total_amount": order_info.get("total_amount", 0),
                "item_count": order_info.get("item_count", 0),
                "create_time": order_info.get("create_time", ""),
            }

        # ถ้า order_sn นี้มีอยู่แล้ว → อัปเดต mentioned_at + summary
        existing = None
        for oa in order_anchors:
            if oa.get("order_sn") == order_sn:
                existing = oa
                break
        if existing:
            existing["mentioned_at"] = now
            if _summary:
                existing["summary"] = _summary
        else:
            order_anchors.append({
                "order_sn": order_sn,
                "mentioned_at": now,
                "summary": _summary,
            })

        # active_order_sn = order ล่าสุด (เสมอ — เพราะ order anchor ใหม่ = ลูกค้าส่งมาใหม่)
        active_order_sn = order_sn

        # บันทึก
        _coll().update_one(
            {"conversation_id": conversation_id},
            {
                "$set": {
                    "conversation_id": conversation_id,
                    "platform": platform,
                    "shop": shop,
                    "order_anchors": order_anchors,
                    "active_order_sn": active_order_sn,
                    "last_updated": now,
                },
            },
            upsert=True,
        )
        doc["order_anchors"] = order_anchors
        doc["active_order_sn"] = active_order_sn
        return doc
    except Exception:
        return None


def get_active_order_sn(conversation_id: str) -> str | None:
    """ดึง active order_sn ของแชท (order ล่าสุดที่ลูกค้าส่งมา).

    Returns:
        order_sn หรือ None ถ้าไม่มี
    """
    doc = load_timeline(conversation_id)
    if not doc:
        return None
    return doc.get("active_order_sn")


def resolve_active_order_sn(
    conversation_id: str,
    message: str,
    order_sn_in_message: str | None = None,
) -> str | None:
    """resolve active order_sn ตามกฎ:

    1. ถ้า message มี order_sn อยู่แล้ว → ใช้ order_sn นั้น
    2. ถ้า message พูด "order เดิม/คำสั่งซื้อเดิม" → active order (ล่าสุด)
    3. ถ้า message เป็น order generic question ("สถานะ order", "order ถึงยัง") → active order
    4. ถ้าไม่ตรงเงื่อนไขไหน → None (ไม่ใช่คำถามเรื่อง order)

    Args:
        conversation_id: ID ของแชท
        message: คำถามลูกค้าปัจจุบัน
        order_sn_in_message: order_sn ที่ extract ได้จาก message (optional)

    Returns:
        order_sn หรือ None
    """
    # 1. ถ้ามี order_sn ใน message → ใช้เลย
    if order_sn_in_message:
        return order_sn_in_message

    msg_lower = (message or "").lower().strip()
    if not msg_lower:
        return None

    # 2. "order เดิม/คำสั่งซื้อเดิม" → active order
    if any(kw in msg_lower for kw in _SAME_ORDER_KWS):
        return get_active_order_sn(conversation_id)

    # 3. order generic question → active order
    if any(kw in msg_lower for kw in _ORDER_GENERIC_KWS):
        return get_active_order_sn(conversation_id)

    # 4. ไม่ใช่คำถามเรื่อง order
    return None


def is_order_question(message: str) -> bool:
    """ตรวจว่าคำถามเกี่ยวกับ order หรือไม่ (มี order keyword หรือ order generic question).

    ใช้ตัดสินใจว่าควรลอง order anchor lookup หรือไม่.
    """
    msg_lower = (message or "").lower().strip()
    if not msg_lower:
        return False
    if any(kw in msg_lower for kw in _SAME_ORDER_KWS):
        return True
    if any(kw in msg_lower for kw in _ORDER_GENERIC_KWS):
        return True
    # มีคำว่า order/ออเดอร์/คำสั่งซื้อ ในข้อความ
    if "order" in msg_lower or "ออเดอร์" in msg_lower or "คำสั่งซื้อ" in msg_lower:
        return True
    return False


# ─── Anchor history (comparison support) ──────────────────
# ⚡ Phase 7 — สำหรับคำถามเปรียบเทียบ "อันนี้กับอันก่อนต่างกันยังไง"
#    ดึง anchor products จาก timeline เรียงตาม mentioned_at (ใหม่→เก่า)
#    ไม่แก้ schema เดิม — ใช้ field is_anchor + mentioned_at ที่มีอยู่แล้ว


def get_anchor_history(
    conversation_id: str,
    limit: int = 10,
) -> list[dict]:
    """ดึง anchor products ของแชท เรียงจากใหม่→เก่าตาม mentioned_at.

    Args:
        conversation_id: ID ของแชท
        limit: จำนวนสูงสุดที่จะคืน (default 10)

    Returns:
        list ของ {item_id, name, source, mentioned_at, is_anchor, card}
        เรียงจากใหม่→เก่า ถ้าไม่มี timeline หรือไม่มี anchor → คืน []
    """
    doc = load_timeline(conversation_id)
    if not doc:
        return []
    products = doc.get("products", [])
    anchors = [p for p in products if p.get("is_anchor")]
    if not anchors:
        return []
    # sort ใหม่→เก่า ตาม mentioned_at
    anchors.sort(key=lambda p: _normalize_dt(p.get("mentioned_at")), reverse=True)
    return anchors[:limit]


def get_previous_anchor(
    conversation_id: str,
    exclude_item_id: str | int | None = None,
) -> dict | None:
    """ดึง anchor อันดับ 2 ล่าสุด (anchor ก่อนหน้า).

    ใช้สำหรับคำถามเปรียบเทียบ "อันนี้กับอันก่อนต่างกันยังไง"
    โดย "อันนี้" = anchor ล่าสุด (active) และ "อันก่อน" = anchor อันดับ 2

    Args:
        conversation_id: ID ของแชท
        exclude_item_id: item_id ที่จะข้าม (ถ้าระบุ) — ปกติคือ active product
                         ที่ลูกค้ากำลังถามถึง จะได้ไม่คืนตัวเดียวกัน

    Returns:
        product card (dict) ของ anchor อันดับ 2 หรือ None ถ้ามี anchor แค่ 1 ตัว
        (หรือไม่มีเลย หรือมีแค่ตัวเดียวที่ตรง exclude_item_id)
    """
    anchors = get_anchor_history(conversation_id, limit=20)
    if len(anchors) < 2:
        return None
    # กรอง exclude_item_id ออก (ถ้าระบุ)
    if exclude_item_id is not None:
        exclude_ser = _to_serializable(exclude_item_id)
        anchors = [a for a in anchors if _to_serializable(a.get("item_id")) != exclude_ser]
    if not anchors:
        return None
    if exclude_item_id is not None:
        # มี exclude → คืน anchor ล่าสุดที่เหลือ (อันดับ 1 หลังกรอง = อันก่อนหน้าตัวที่ exclude)
        prev = anchors[0]
    else:
        # ไม่มี exclude → คืน anchor อันดับ 2 (index 1 = อันก่อนหน้า active ล่าสุด)
        if len(anchors) < 2:
            return None
        prev = anchors[1]
    return prev.get("card") or {"item_id": prev.get("item_id"), "name": prev.get("name")}


# ─── BUG-D fix — Warranty claim state persistence ───────────
# เก็บข้อมูลเคลมที่ลูกค้าให้มาข้าม turn เพื่อกันบอทขอข้อมูลซ้ำ
# Storage: field `claim_state` ใน conversation_products document (เดียวกับ timeline)


def load_claim_state(conversation_id: str) -> dict | None:
    """โหลด persisted `claim_state` dict ของแชท (canonical schema ใน docs/schema.md).

    Returns:
        dict ของ episode ล่าสุด — lifecycle (`episode_id`, `stage`,
        `started_at`, `updated_at`, `resolved_at`, `resolution_reason`,
        `resolved_by`) + customer slots (`customer_name`, `customer_phone`,
        `customer_order_id`) + evidence (`purchase_date`, `has_image`)
        หรือ None ถ้าไม่มี
    """
    if not conversation_id:
        return None
    try:
        doc = _coll().find_one({"conversation_id": conversation_id})
        if not doc:
            return None
        return doc.get("claim_state")
    except Exception:
        return None


def transition_claim_state(
    conversation_id: str,
    platform: str | None,
    shop: str | None,
    *,
    expected_episode_id: str | None,
    expected_stage: str | None,
    claim_state: dict,
) -> dict | None:
    """new-episode whole-state write เท่านั้น — fenced CAS (storage primitive).

    ใช้เฉพาะ absent→episode ใหม่ / terminal→fresh episode; same-episode field
    merge และ terminal transition ต้องผ่าน merge_claim_fields (partial $set).
    fence = exact episode + exact stage ที่ caller คาด (None = missing∨null —
    Mongo null-equality). miss → reread ครั้งเดียว คืน state ผู้ชนะ — ไม่ retry.

    doc ยังไม่มีจริง → create ผ่าน insert_one; unique index {conversation_id:1}
    (declared ที่ TS index owner) ทำให้ concurrent create แพ้ E11000 →
    reread ครั้งเดียว คืน doc ของผู้ชนะ.

    Returns:
        claim_state ที่ commit แล้ว หรือ state ของผู้ชนะ หรือ None ถ้า error
    """
    if not conversation_id:
        return None
    filt = {
        "conversation_id": conversation_id,
        "claim_state.episode_id": expected_episode_id,
        "claim_state.stage": expected_stage,
    }
    try:
        res = _coll().update_one(
            filt,
            {"$set": {
                "claim_state": claim_state,
                "platform": platform or "",
                "shop": shop or "",
            }},
        )
        if getattr(res, "matched_count", 0):
            return claim_state
        doc = _coll().find_one({"conversation_id": conversation_id})
        if doc is not None:
            return doc.get("claim_state")
        # doc ยังไม่มีจริง → insert (ไม่ใช่ upsert — upsert จะ match doc ของ
        # rival ที่เพิ่ง insert แล้วทับ claim_state เงียบๆ); unique index
        # {conversation_id:1} ทำให้ concurrent insert แพ้ E11000 → reread
        try:
            _coll().insert_one({
                "conversation_id": conversation_id,
                "claim_state": claim_state,
                "platform": platform or "",
                "shop": shop or "",
            })
            return claim_state
        except Exception as e:
            from pymongo.errors import DuplicateKeyError
            if not isinstance(e, DuplicateKeyError):
                raise
            # E11000 — writer อื่นชนะ insert race → reread ครั้งเดียว
            doc = _coll().find_one({"conversation_id": conversation_id})
            return doc.get("claim_state") if doc else None
    except Exception:
        return None


def merge_claim_fields(
    conversation_id: str,
    *,
    episode_id: str | None,
    expected_stage: str | None,
    fields: dict | None,
) -> dict | None:
    """same-episode partial update — dotted $set เท่านั้น (storage primitive).

    เขียนได้ก็ต่อเมื่อ episode_id AND stage ยังตรงที่ caller คาด — stale
    writer (stage เดิม) เขียนทับ episode ที่เปลี่ยน stage แล้วไม่ได้.
    $set เฉพาะ field ที่ส่งมา (skip None/empty — fill-once) + updated_at;
    ใช้สำหรับ field merge และ same-episode stage transition (รวม terminal:
    stage/resolved_at/resolution_reason) — ห้าม $set claim_state ทั้งก้อน.
    miss → reread ครั้งเดียว คืน state ปัจจุบัน (authoritative).

    Returns:
        claim_state หลังเขียน (หรือของผู้ชนะถ้า fence miss) หรือ None ถ้า error
    """
    if not conversation_id:
        return None
    fields = fields or {}
    filt = {
        "conversation_id": conversation_id,
        "claim_state.episode_id": episode_id,
        "claim_state.stage": expected_stage,
    }
    try:
        from datetime import datetime, timezone
        sets = {
            f"claim_state.{k}": v
            for k, v in fields.items()
            if v is not None and v != ""
        }
        sets["claim_state.updated_at"] = datetime.now(timezone.utc).isoformat()
        _coll().update_one(filt, {"$set": sets})
        doc = _coll().find_one({"conversation_id": conversation_id})
        return doc.get("claim_state") if doc else None
    except Exception:
        return None


# ─── Conversation subject set (Phase 2C.2) ──────────────────────────────
# `subject_set` = snapshot ของ authoritative subject decision ปัจจุบันใน
# conversation_products doc เดียวกัน — ไม่ใช่ history accumulator
#
# Identity domain: normalized item_id เท่านั้น (str(_to_serializable(v)) —
# form เดียวกับ retrieval_policy._norm_id) · model code/keyword เป็น evidence
# resolve → item_id ก่อน persist · variant detail (model_id/model_name)
# อยู่บน timeline products[] entry เดิม
#
# Reads: get_subject_set ≤1/turn (caller ส่ง persisted ให้ resolver/decider)
# Writes: record_subject_set 0-1/turn — CAS fence = persisted monotonic
#         `subject_set.rev` (+1 ต่อ commit) — snapshot equality อย่างเดียว
#         ปิด ABA ไม่ได้ (state กลับมาเท่าเดิมได้) → rev เปลี่ยนทุก write

_SUBJECT_RELATIONS = ("single", "compare", "alternatives", "bundle")


@dataclass(frozen=True)
class ConversationSubjectSet:
    """Snapshot ของ subject decision — item_id domain เท่านั้น.

    rev = persisted CAS fence (server-side write counter, +1 ต่อ commit) —
    caller/constructor ไม่เคย set เอง (decide/propose ใช้ rev=0 เสมอ; parse
    อ่านจาก doc — pre-token doc ≡ 0). compare=False เพื่อให้ equality
    ยังเป็น semantic (committed-vs-winner ตัดสินด้วย == proposed)"""
    subject_ids: tuple[str, ...]
    source_turn_id: str | None
    relation: Literal["single", "compare", "alternatives", "bundle"]
    requested_operations: tuple[str, ...]
    confidence: float
    rev: int = field(default=0, compare=False)


class SubjectResolution(NamedTuple):
    """ผล resolve deictic/follow-up ref — caller แยก 3 outcome ได้."""
    outcome: Literal["resolved", "clarify", "no_subject_ref"]
    subject_set: ConversationSubjectSet | None


class SubjectSetView(NamedTuple):
    """Read view ของ subject set — 1 DB read ต่อ turn.

    effective: set ที่ resolver ใช้ — stored subject_set ถ้ามี ไม่งั้น
      derive จาก explicit anchor entries (is_anchor=True — item_id
      domain เดียวกัน; confidence 0.5 = derived ไม่ใช่ decided)
      ครอบเคส conversation เก่าที่มี anchor แต่ยังไม่มี field
    stored: raw persisted set (None = ไม่มี/ malformed) — CAS prior
      สำหรับ record_subject_set.expected_prior เท่านั้น
    products: timeline entries จาก doc เดียวกัน — ส่งให้
      materialize_subject_cards (ห้ามอ่าน doc ซ้ำ)
    claim_state / active_item_id: fields จาก doc เดียวกัน — context
      สำหรับ TurnPlan (ห้ามอ่าน doc ซ้ำ; None เมื่อไม่มี doc)"""
    effective: ConversationSubjectSet | None
    stored: ConversationSubjectSet | None
    products: tuple[dict, ...]
    claim_state: dict | None = None
    active_item_id: str | None = None


# ── ref-signal tables (canonical kw owners — moved 1:1, no new semantics) ──
#
# Set-count deixis ("2 อันนี้","ทั้งสอง") / bare which-of-set resolve via the
# structured subject_scope signal (intent Pass-1 → TurnNeed) validated in
# resolve_subjects — never via a language table here.

# pair ref — moved จาก app.py _anchor_compare_kws (canonical pair words)
_SUBJECT_PAIR_KWS = (
    "อันนี้กับอันก่อน", "อันนี้กับอันก่อนหน้า", "อันนี้กับอันนั้น",
    "ตัวนี้กับตัวก่อน", "ตัวนี้กับตัวก่อนหน้า", "ตัวนี้กับตัวนั้น",
    "อันนี้กับอันเดิม", "ตัวนี้กับตัวเดิม", "รุ่นนี้กับรุ่นก่อน",
    "รุ่นนี้กับรุ่นก่อนหน้า", "อันนี้กับอันที่แล้ว", "ตัวนี้กับตัวที่แล้ว",
)

# link/set-demanding op — moved จาก app.py _link_followup_kws
_SUBJECT_LINK_KWS = (
    "ลิงค์", "ลิงก์", "ลิ้งค์", "ลิ้งก์", "link", "ขอลิงค์", "ขอลิงก์",
    "ขอลิ้งค์", "ขอลิ้งก์", "ขอ link", "ขอ url", "url",
    "ช่องทางซื้อ", "สั่งซื้อ", "ขอสั่ง", "ขอซื้อ", "สั่งได้เลย",
    "ส่งลิงค์", "ส่งลิงก์", "ส่ง link", "ขอเว็บ", "เว็บสินค้า",
)


def _norm_subject_ids(ids) -> tuple[str, ...]:
    """Normalize+dedupe เป็น canonical item_id strings, sort deterministic.

    item_id domain เท่านั้น — value ที่ไม่ใช่ digit canonical form
    (model code / arbitrary string) ไม่ใช่ item identity → drop"""
    out = set()
    for v in (ids or ()):
        if v is None:
            continue
        s = str(_to_serializable(v))
        if s.isdigit():
            out.add(s)
    return tuple(sorted(out, key=int))


def _norm_ops(ops) -> tuple[str, ...]:
    return tuple(sorted({str(o) for o in (ops or ()) if o}))


def _subject_set_doc(ss: ConversationSubjectSet,
                     now: datetime) -> dict:
    return {
        "subject_ids": list(ss.subject_ids),
        "source_turn_id": ss.source_turn_id,
        "relation": ss.relation,
        "requested_operations": list(ss.requested_operations),
        "confidence": float(ss.confidence),
        "rev": int(ss.rev),
        "updated_at": now,
    }


def _parse_subject_set(raw: Any) -> ConversationSubjectSet | None:
    """Parse stored subject_set — malformed → None (fail safe, no guess).

    Compatibility rule (เดียว): doc ที่เขียนก่อนมี rev field → missing/null
    rev ≡ 0; rev ที่ cast เป็น int ≥0 ไม่ได้ → set ทั้งก้อน unparseable
    → None (non-clobber — expected_prior ไม่ match, write refused)"""
    if not isinstance(raw, dict):
        return None
    ids = raw.get("subject_ids")
    rel = raw.get("relation")
    ops = raw.get("requested_operations")
    if not isinstance(ids, (list, tuple)) or not ids:
        return None
    if rel not in _SUBJECT_RELATIONS:
        return None
    if not isinstance(ops, (list, tuple)):
        return None
    try:
        conf = float(raw.get("confidence", 0.0))
        rev = raw.get("rev")
        rev = 0 if rev is None else int(rev)
    except (TypeError, ValueError):
        return None
    if rev < 0:
        return None
    nids = _norm_subject_ids(ids)
    if not nids:
        return None                      # stored ids ไม่ใช่ item_id domain
    return ConversationSubjectSet(
        subject_ids=nids,
        source_turn_id=raw.get("source_turn_id"),
        relation=rel,
        requested_operations=tuple(str(o) for o in ops if o),
        confidence=conf,
        rev=rev,
    )


def get_subject_set(conversation_id: str) -> SubjectSetView:
    """โหลด subject view — DB read owner (≤1 call/turn).

    effective = stored subject_set ถ้า parse ได้; ถ้าไม่มี field ให้ derive
    จาก explicit customer anchors (is_anchor=True — identity domain เดียวกับ
    subject_set; suggestion ไม่ derive) เพื่อให้ deictic resolve บน
    conversation เก่าที่ยังไม่มี subject_set — 1 anchor → single,
    หลาย anchor → alternatives (co-mentioned, relation ไม่ชัด)
    """
    empty = SubjectSetView(None, None, ())
    if not conversation_id:
        return empty
    try:
        doc = _coll().find_one({"conversation_id": conversation_id})
    except Exception:
        return empty
    if not doc:
        return empty
    prods = tuple(doc.get("products") or ())
    stored = _parse_subject_set(doc.get("subject_set"))
    claim = doc.get("claim_state")
    aid = doc.get("active_item_id")
    if stored is not None:
        return SubjectSetView(stored, stored, prods, claim, aid)
    ids = _norm_subject_ids(
        p.get("item_id") for p in prods
        if p.get("is_anchor") and p.get("item_id") is not None)
    if not ids:
        # doc มีแต่ไม่มี subject identity — claim/anchor/products ของ doc
        # ยังต้องไหลเข้า TurnPlan (claim resume, active anchor context)
        return SubjectSetView(None, None, prods, claim, aid)
    rel = "single" if len(ids) == 1 else "alternatives"
    return SubjectSetView(
        ConversationSubjectSet(ids, None, rel, (), 0.5), None, prods,
        claim, aid)


def _classify_subject_ref(msg: str) -> str:
    """จำแนก ref form ในข้อความ: pair/singular/set_hard/set_soft/generic/none.

    Canonical signals เท่านั้น — bare which-of-set / set-count deixis ไม่มี
    structured owner จนกว่า TurnPlan consumption (2C.3) → ตก none/singular
    ตาม canonical tables (deferred — ดู comment เหนือตาราง)"""
    if not msg:
        return "none"
    if (any(kw in msg for kw in _SUBJECT_PAIR_KWS)
            or any(kw in msg for kw in _rc._COMPARISON_FOLLOWUP_KW)):
        return "pair"
    if any(kw in msg for kw in
           _SAME_PRODUCT_KWS + _SUGGESTION_REF_KWS + _rc._SINGLE_ITEM_REF_KW):
        return "singular"
    if any(kw in msg for kw in _SUBJECT_LINK_KWS):
        return "set_hard"
    if any(kw in msg for kw in _rc._SUPERLATIVE_KW):
        return "set_soft"
    if any(kw in msg for kw in _GENERIC_Q_KWS):
        return "generic"
    return "none"


_SUBJECT_SCOPES = ("none", "explicit", "current_single", "current_set")
_SUBJECT_SIGNAL_MIN_CONF = 0.7


def resolve_subjects(
    persisted: ConversationSubjectSet | None,
    message: str,
    *,
    subject_scope: str | None = None,
    subject_count: int | None = None,
    signal_confidence: float | None = None,
    subject_refs: tuple = (),
    persisted_code_index: dict | None = None,
) -> SubjectResolution:
    """Pure resolver — รับ persisted set ที่ load แล้ว (no hidden DB read).

    Structured signal (planner/intent boundary) มาก่อน — resolver validate
    typed input กับ persisted state เท่านั้น ไม่ interpret ภาษาเอง:
      current_set + persisted + (count absent หรือ == set size) → resolved ทั้ง set
      current_single + persisted n==1 → resolved
      explicit + item-id refs (digit) → no_subject_ref (explicit identities
        ชนะ upstream แล้ว)
      explicit + code-shaped refs → equivalence กับ persisted_code_index
        (item_id → codes จาก canonical _extract_codes บน card name — caller
        สร้างจาก timeline data ที่ load อยู่แล้ว): refs ทุกตัว ⊆ codes ของ
        persisted item เดียว → resolved narrowed set · ไม่ match/unprovable
        → no_subject_ref (ห้าม substitute) · match >1 item → clarify
      missing set / count mismatch / unknown scope / signal conf < 0.7
        → clarify (zero guessing)
    ไม่มี structured signal → canonical language path:
      singular deictic → resolved เฉพาะ single-subject set (multi → clarify)
      pair/set ops → resolved ทั้ง set · no set → clarify (set-demanding) หรือ
      no_subject_ref (open question / ไม่มี ref signal)
    """
    n = len(persisted.subject_ids) if persisted else 0
    if subject_scope:
        if subject_scope not in _SUBJECT_SCOPES:
            return SubjectResolution("clarify", None)
        if subject_scope == "explicit":
            _refs = tuple(
                str(r).strip() for r in (subject_refs or ())
                if str(r).strip())
            if any(r.isdigit() for r in _refs):
                return SubjectResolution("no_subject_ref", None)
            _want = {r.upper() for r in _refs}
            if _want and persisted and persisted_code_index:
                _matched = tuple(
                    str(sid) for sid in persisted.subject_ids
                    if _want <= {str(c).strip().upper()
                                 for c in persisted_code_index.get(sid)
                                 or ()})
                if len(_matched) == 1:
                    return SubjectResolution(
                        "resolved", ConversationSubjectSet(
                            subject_ids=_matched,
                            source_turn_id=persisted.source_turn_id,
                            relation="single",
                            requested_operations=(),
                            confidence=persisted.confidence))
                if len(_matched) > 1:
                    return SubjectResolution("clarify", None)
            return SubjectResolution("no_subject_ref", None)
        if subject_scope in ("current_single", "current_set"):
            if (signal_confidence is not None
                    and signal_confidence < _SUBJECT_SIGNAL_MIN_CONF):
                return SubjectResolution("clarify", None)
            if subject_scope == "current_set":
                if n and (subject_count is None or subject_count == n):
                    return SubjectResolution("resolved", persisted)
                return SubjectResolution("clarify", None)
            return SubjectResolution(
                "resolved" if n == 1 else "clarify",
                persisted if n == 1 else None)
        # scope == "none" → canonical path
    sig = _classify_subject_ref((message or "").lower())
    if sig == "pair":
        return SubjectResolution(
            "resolved" if n else "clarify", persisted if n else None)
    if sig == "singular":
        return SubjectResolution(
            "resolved" if n == 1 else "clarify",
            persisted if n == 1 else None)
    if sig in ("set_hard", "set_soft", "generic"):
        if n:
            return SubjectResolution("resolved", persisted)
        return SubjectResolution(
            "clarify" if sig == "set_hard" else "no_subject_ref", None)
    return SubjectResolution("no_subject_ref", None)


def decide_subject_set(
    persisted: ConversationSubjectSet | None,
    *,
    explicit_ids=(),
    pair_ids=(),
    resolved: ConversationSubjectSet | None = None,
    selected_ids=(),
    requested_operations=(),
    source_turn_id=None,
    confidence: float = 1.0,
) -> ConversationSubjectSet | None:
    """Single decision owner — explicit > pair > resolved consume > batch > none.

    resolved = set ที่ resolver เพิ่ง consume ใน turn นี้ (deictic/generic ref)
    — turn นั้นใช้ subject เดิมตอบ ไม่ใช่ตัดสิน subject ใหม่ → ห้ามให้
    selected batch (สินค้าที่แสดง) ทับ set ที่ resolve มา

    Returns:
        set ใหม่ที่ควร persist หรือ None (ไม่มี subject / set ปัจจุบันเหมือน
        persisted → idempotent, ไม่ต้องเขียน)
    """
    e = _norm_subject_ids(explicit_ids)
    p = _norm_subject_ids(pair_ids)
    s = _norm_subject_ids(selected_ids)
    if e:
        if len(p) >= 2 and set(e) <= set(p):
            ids, rel = p, "compare"
        elif len(e) == 1:
            ids, rel = e, "single"
        else:
            ids, rel = e, "alternatives"
    elif len(p) >= 2:
        ids, rel = p, "compare"
    elif resolved is not None:
        # consume-only turn — subject ชุดเดิมยืน; ops snapshot เป็นของ turn ที่
        #   ตัดสิน (consume turn ไม่เขียนทับ ops ของ decision เดิม)
        r = resolved
        if (persisted is not None
                and r.subject_ids == persisted.subject_ids
                and r.relation == persisted.relation):
            return None
        return ConversationSubjectSet(
            subject_ids=r.subject_ids, source_turn_id=source_turn_id,
            relation=r.relation,
            requested_operations=_norm_ops(requested_operations)
            or r.requested_operations,
            confidence=r.confidence)
    elif s:
        ids, rel = s, ("single" if len(s) == 1 else "alternatives")
    else:
        return None
    new = ConversationSubjectSet(
        subject_ids=ids, source_turn_id=source_turn_id, relation=rel,
        requested_operations=_norm_ops(requested_operations),
        confidence=float(confidence))
    if persisted and new.subject_ids == persisted.subject_ids and not e and not p:
        # selected batch ชุดเดิม = ไม่มี decision ใหม่ — ห้ามให้ weakest
        # evidence downgrade relation (เช่น compare → alternatives)
        return None
    return None if new == persisted else new


def record_subject_set(
    conversation_id: str,
    subject_set: ConversationSubjectSet | None,
    *,
    expected_prior: ConversationSubjectSet | None = None,
    platform: str | None = None,
    shop: str | None = None,
) -> ConversationSubjectSet | None:
    """Persist subject_set — truthful outcome; ห้าม fabricate success.

    CAS fence = `subject_set.rev` — persisted monotonic token (+1 ต่อ
    committed write; semantic snapshot อย่างเดียวปิด ABA ไม่ได้เพราะ state
    กลับมาเท่าเดิมได้ — convention เดียวกับ fencing_token ของ lease):
      expected_prior.rev > 0  → {subject_set.rev: <rev>}
      expected_prior.rev = 0  → {subject_set.rev: None}   (pre-token doc —
                                missing∨null เท่านั้น; write ไม่ persist 0)
      expected_prior = None   → {subject_set: None}       (absent∨null —
                                doc ที่มี set อยู่แล้วไม่ match → คืน winner)
    miss → reread ครั้งเดียว คืน winner จริง
    (pattern เดียวกับ transition_claim_state — no retry)

    doc ยังไม่มี → insert_one minimal ใต้ unique {conversation_id:1} →
    E11000 → reread winner · ห้ามสร้าง products/active_item_id/
    order_anchors/claim_state ปลอม

    Returns:
        set ที่ commit (rev+1) หรือ set ของผู้ชนะ (แยกได้ด้วย != proposed —
        rev ไม่มีผลต่อ equality) หรือ None
        (invalid input / write error / unparseable current state)
    """
    if not conversation_id or not isinstance(subject_set, ConversationSubjectSet):
        return None
    if subject_set.relation not in _SUBJECT_RELATIONS:
        return None
    if _norm_subject_ids(subject_set.subject_ids) != subject_set.subject_ids:
        return None                      # non-canonical identity → refuse
    now = datetime.now(timezone.utc)
    prior_rev = expected_prior.rev if expected_prior is not None else None
    new_rev = (prior_rev or 0) + 1
    committed = replace(subject_set, rev=new_rev)
    sdoc = _subject_set_doc(committed, now)
    if expected_prior is not None:
        filt = {"conversation_id": conversation_id,
                "subject_set.rev": prior_rev if prior_rev else None}
    else:
        filt = {"conversation_id": conversation_id,
                "subject_set": None}
    try:
        res = _coll().update_one(
            filt, {"$set": {"subject_set": sdoc, "last_updated": now}})
        if getattr(res, "matched_count", 0):
            return committed
        doc = _coll().find_one({"conversation_id": conversation_id})
        if doc is not None:
            return _parse_subject_set(doc.get("subject_set"))
        try:
            ins = {"conversation_id": conversation_id,
                   "subject_set": sdoc, "last_updated": now}
            if platform:
                ins["platform"] = platform
            if shop:
                ins["shop"] = shop
            _coll().insert_one(ins)
            return committed
        except Exception as e:
            from pymongo.errors import DuplicateKeyError
            if not isinstance(e, DuplicateKeyError):
                raise
            doc = _coll().find_one({"conversation_id": conversation_id})
            return _parse_subject_set(doc.get("subject_set")) if doc else None
    except Exception:
        return None


def materialize_subject_cards(
    db,
    subject_ids,
    *,
    products,
    shop_filter: str | None = None,
    message: str = "",
    snap=_gen.SNAP_UNSET,
) -> list[dict]:
    """Subject ids → product cards (materialization owner — แทน timeline-getter
    path ของ subject resolver เก่าที่ถูกลบใน 2C.2).

    products = timeline entries ที่ load มากับ SubjectSetView — conv doc
    ถูกอ่านครั้งเดียวที่ get_subject_set (ฟังก์ชันนี้ไม่มี DB read ของ doc)
    per id: entry ใน timeline → _materialize_card (rebuild สด → fallback
    stored card — legacy conversations ที่ item หายจาก catalog ยัง resolve
    ได้ตามสัญญาเดิม) · id ไม่อยู่ timeline → fetch_product_by_id
    (status-agnostic — unavailable/historical subject ยัง materialize)
    same-item multi-variant → เลือก deterministic เหมือน _compute_active:
    is_anchor ก่อน แล้ว latest mentioned_at (structured evidence — ไม่ใช่
    array-order accident)
    """
    from . import product_store as _ps
    ids = _norm_subject_ids(subject_ids)
    if not ids:
        return []
    # cache identity รวม captured generation (resolve ครั้งเดียวที่ entry —
    # card ที่ cache จาก gen อื่นห้าม reuse; captured None = identity ของมันเอง)
    snap = _gen.resolve_snapshot() if snap is _gen.SNAP_UNSET else snap
    _gen_id = snap.generation_id if snap is not None else None
    entries: dict[str, dict] = {}
    for p in products or ():
        pid = p.get("item_id")
        if pid is None:
            continue
        sid = str(_to_serializable(pid))
        cur = entries.get(sid)
        cand = (bool(p.get("is_anchor")),
                _normalize_dt(p.get("mentioned_at")))
        cur_key = (bool(cur.get("is_anchor")),
                   _normalize_dt(cur.get("mentioned_at"))) if cur else None
        if cur_key is None or cand > cur_key:
            entries[sid] = p
    # ── Phase 4A — one bounded identity batch (แทน find_one×N ของ
    #    _rebuild_card): live listing doc เป็นเจ้าของ publish/stock/link
    #    truth; หายจาก catalog → snapshot เท่านั้น (ขายไม่ได้/ไม่มีลิงก์)
    docs_by_id: dict[str, dict] = {}
    try:
        docs_by_id = _ps.fetch_product_docs_by_ids(
            db, ids, shop_filter=shop_filter)
    except Exception as _e:
        print(f"[SUBJECT-RES] batch resolve error: {_e}")
    # ── at most one bounded units batch — เฉพาะ entries ระดับรุ่นย่อย ──
    from . import units as _units
    units_by_key: dict[tuple[str, str], dict] = {}
    try:
        wanted_iids: list = []
        for sid in ids:
            entry = entries.get(sid)
            doc = docs_by_id.get(sid)
            if entry is None or doc is None:
                continue
            card_stored = entry.get("card") or {}
            vlist = card_stored.get("variants") or []
            model_name = entry.get("model_name") or (
                vlist[0].get("name") if len(vlist) == 1 else None)
            if model_name:
                wanted_iids.append(doc.get("item_id"))
        if wanted_iids:
            udocs = list(_units._units_coll(snap).find(
                {"item_id": {"$in": wanted_iids}}).limit(50))
            udocs = _units.attach_image_texts(
                _units.attach_kb_specs(udocs), snap)
            for u in udocs:
                key = (str(_to_serializable(u.get("item_id"))),
                       str(u.get("model_name") or ""))
                units_by_key[key] = u
    except Exception:
        pass
    out: list[dict] = []
    for sid in ids:
        card = None
        entry = entries.get(sid)
        doc = docs_by_id.get(sid)
        ckey = (sid, str((entry or {}).get("model_name") or ""), _gen_id)
        hit = _LIVE_CARD_CACHE.get(ckey)
        if hit and (time.monotonic() - hit[0]) < _LIVE_CARD_TTL:
            card = hit[1]
        if card is None and doc is not None:
            try:
                card_stored = (entry or {}).get("card") or {}
                vlist = card_stored.get("variants") or []
                model_name = (entry or {}).get("model_name") or (
                    vlist[0].get("name") if len(vlist) == 1 else None)
                ukey = (str(_to_serializable(doc.get("item_id"))),
                        str(model_name or ""))
                u = units_by_key.get(ukey) if model_name else None
                if u is not None:
                    u = dict(u)
                    u["_listing"] = doc
                    card = _units.to_unit_card(u)
                else:
                    card = _ps.to_product_card(doc, message)
                _LIVE_CARD_CACHE[ckey] = (time.monotonic(), card)
            except Exception:
                card = None
        if card is None:
            # live หาย/พัง → stored snapshot เท่านั้น: identity+history —
            # ห้าม claim live state, ขายไม่ได้, ไม่มีลิงก์ขาย
            if entry is not None:
                stored = dict(entry.get("card") or {
                    "item_id": entry.get("item_id"),
                    "name": entry.get("name")})
                if stored:
                    stored.pop("short_link", None)
                    stored.pop("link", None)
                    stored["_snapshot_only"] = True
                    card = stored
        if card:
            out.append(card)
    return out
