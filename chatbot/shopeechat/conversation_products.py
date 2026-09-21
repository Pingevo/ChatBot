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
    # ⚡ Phase 2Z+++ — เพิ่ม "อันนี้", "ตัวนี้", "รุ่นนี้" เพื่อให้ resolve_active_by_message
    #    match ที่ข้อ 2 (anchor ล่าสุด) แทน default
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


def _rebuild_card(p: dict, message: str = "") -> dict | None:
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
            u = _units._units_coll().find_one(
                {"item_id": item_id, "model_name": model_name})
            if u:
                # helper chain เดียวกับ fetch_unit_cards — unit card สดครบทุก field
                u = _units.attach_image_texts(_units.attach_kb_specs([u]))[0]
                u["_listing"] = doc
                return _units.to_unit_card(u)
        except Exception:
            pass
    return _ps.to_product_card(doc, message)


def _materialize_card(p: dict, message: str = "") -> dict:
    """คืน card ของ timeline entry — rebuild สดจาก DB ถ้าทำได้, fallback = stored card."""
    stored = p.get("card") or {"item_id": p.get("item_id"), "name": p.get("name")}
    try:
        key = (str(_to_serializable(p.get("item_id"))),
               str(p.get("model_name") or ""))
        hit = _LIVE_CARD_CACHE.get(key)
        if hit and (time.monotonic() - hit[0]) < _LIVE_CARD_TTL:
            return hit[1]
        fresh = _rebuild_card(p, message=message)
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
            return _materialize_card(p)
    return None


def get_suggestion_latest(conversation_id: str) -> dict | None:
    """ดึง suggestion product ล่าสุด (สินค้าที่ bot แนะนำ)."""
    doc = load_timeline(conversation_id)
    if not doc:
        return None
    suggestions = [p for p in doc.get("products", []) if not p.get("is_anchor")]
    if not suggestions:
        return None
    suggestions.sort(key=lambda p: _normalize_dt(p.get("mentioned_at")), reverse=True)
    s = suggestions[0]
    return _materialize_card(s)


def get_latest_suggestion_batch(conversation_id: str) -> list[dict]:
    """ดึง suggestion batch ล่าสุด — สินค้าที่ bot แนะนำใน response เดิียวกัน.

    bot บันทึก suggestions ทีละชุดต่อเทิร์น (_record_suggestion_products append ต่อท้าย)
    → batch ล่าสุด = trailing run ของ non-anchor entries ท้าย products list
    ถ้า entry ท้ายเป็น anchor (ลูกค้าส่ง item card มาหลังสุด) → คืน []

    Returns:
        list ของ cards (ใหม่→เก่า) หรือ [] ถ้าไม่มี suggestion ท้ายลิสต์
        (caller ตัดสินใจเองว่าต้องการกี่ตัว — batch ตัวเดียวอาจ pair กับ anchor ล่าสุด)
    """
    doc = load_timeline(conversation_id)
    if not doc:
        return []
    batch: list[dict] = []
    for p in reversed(doc.get("products") or []):
        if p.get("is_anchor"):
            break
        batch.append(p)
    return [_materialize_card(p) for p in batch]


def get_anchor_and_suggestions(conversation_id: str, limit: int = 5) -> list[dict]:
    """ดึง anchor ล่าสุด + suggestion ล่าสุด รวมกัน (dedup) สำหรับ follow-up ขอลิงค์.

    Returns:
        list ของ product cards — anchor ก่อน แล้วตามด้วย suggestions (dedup by item_id)
    """
    doc = load_timeline(conversation_id)
    if not doc:
        return []
    products = doc.get("products", []) or []
    if not products:
        return []
    # แยก anchor / suggestion
    anchors = [p for p in products if p.get("is_anchor")]
    suggestions = [p for p in products if not p.get("is_anchor")]
    anchors.sort(key=lambda p: _normalize_dt(p.get("mentioned_at")), reverse=True)
    suggestions.sort(key=lambda p: _normalize_dt(p.get("mentioned_at")), reverse=True)
    out = []
    seen_ids = set()
    # anchor ก่อน (ล่าสุดก่อน)
    for p in anchors:
        iid = _to_serializable(p.get("item_id"))
        if iid in seen_ids:
            continue
        seen_ids.add(iid)
        out.append(_materialize_card(p))
    # แล้ว suggestions (ล่าสุดก่อน)
    for p in suggestions:
        iid = _to_serializable(p.get("item_id"))
        if iid in seen_ids:
            continue
        seen_ids.add(iid)
        out.append(_materialize_card(p))
        if len(out) >= limit:
            break
    return out[:limit]


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
                    return _materialize_card(p, message=message)

    # 2. "ตัวเดิม/อันเดิม" → anchor ล่าสุด
    if any(kw in msg_lower for kw in _SAME_PRODUCT_KWS):
        return get_active_product(conversation_id)

    # 3. "อันที่แนะนำ/ที่ส่งมา" → suggestion ล่าสุด
    if any(kw in msg_lower for kw in _SUGGESTION_REF_KWS):
        return get_suggestion_latest(conversation_id)

    # 4 & 5. default → active product
    return get_active_product(conversation_id)


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


def get_order_anchors(conversation_id: str) -> list[dict]:
    """ดึง order anchors ทั้งหมดของแชท.

    Returns:
        list ของ {order_sn, mentioned_at, summary} เรียงจากใหม่→เก่า
    """
    doc = load_timeline(conversation_id)
    if not doc:
        return []
    anchors = doc.get("order_anchors", [])
    # sort ใหม่→เก่า
    anchors_sorted = sorted(
        anchors,
        key=lambda a: a.get("mentioned_at", datetime.min) if isinstance(a.get("mentioned_at"), datetime) else datetime.min,
        reverse=True,
    )
    return anchors_sorted


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
    """โหลด claim state ของแชท.

    Returns:
        dict ที่มี fields: customer_name, customer_phone, customer_order_id,
        purchase_date, has_image, has_video, started_at, updated_at
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


def update_claim_state(
    conversation_id: str,
    platform: str | None = None,
    shop: str | None = None,
    fields: dict | None = None,
) -> dict | None:
    """อัปเดต claim state — merge fields ใหม่เข้าไปใน state เดิม.

    Args:
        conversation_id: ID ของแชท
        platform: platform (shopee/lazada/tiktok)
        shop: ชื่อร้าน
        fields: fields ใหม่ที่จะ merge เช่น {"customer_name": "John", "has_image": True}

    Returns:
        claim_state หลังอัปเดต หรือ None ถ้า error
    """
    if not conversation_id:
        return None
    fields = fields or {}
    try:
        from datetime import datetime, timezone
        _now = datetime.now(timezone.utc).isoformat()
        # โหลด state เดิม
        existing = load_claim_state(conversation_id) or {}
        # merge fields ใหม่ (ไม่เขียนทับด้วย None/empty)
        merged = dict(existing)
        for k, v in fields.items():
            if v is not None and v != "":
                merged[k] = v
        merged["updated_at"] = _now
        if "started_at" not in merged:
            merged["started_at"] = _now
        # upsert ลง conversation_products
        _coll().update_one(
            {"conversation_id": conversation_id},
            {
                "$set": {
                    "claim_state": merged,
                    "platform": platform or "",
                    "shop": shop or "",
                },
            },
            upsert=True,
        )
        return merged
    except Exception:
        return None


def clear_claim_state(conversation_id: str) -> None:
    """ล้าง claim state หลัง handoff (แอดมินรับงานแล้ว)."""
    if not conversation_id:
        return
    try:
        _coll().update_one(
            {"conversation_id": conversation_id},
            {"$unset": {"claim_state": ""}},
        )
    except Exception:
        pass
