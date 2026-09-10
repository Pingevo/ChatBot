"""rich_parse — parse rich message tags สำหรับ chatbotv3.

Copy จาก legacy:
- app.py: _ITEM_TAG_RE (บรรทัด ~421), _extract_item_id_tag, placeholder list
- chat_v2.py: _ORDER_TAG_RE, _IMAGE_PLACEHOLDER_RE, _TRACKING_RE
- order_store.py: extract_order_sn, extract_tracking_number

รองรับ tags:
- [สินค้า: 12345] / [item: 12345] / [item_id: 12345] / [product: 12345]
- [order: 240215MCEQMT60] / [คำสั่งซื้อ: 240215MCEQMT60]
- [item] / [variation_card] / [bundle_message] / [bundle_deal] / [bundle]
  / [order] / [คำสั่งซื้อ] / [สินค้า] (placeholder ลอยๆ — ไม่มี id)
- [รูปภาพ] / [image] / [วิดีโอ] / [video] / [sticker] / [สติกเกอร์]
- tracking number (SPX/Kerry/Flash/J&T/ไปรษณีย์)
"""
from __future__ import annotations

import re

# ⚡ lazy import order_store — หลีกเลี่ยงการโหลด pymongo ตอน import
_order_store = None


def _get_order_store():
    global _order_store
    if _order_store is None:
        from .. import order_store as _os
        _order_store = _os
    return _order_store


# ---- Patterns (copy จาก legacy) ---------------------------------------------

# tag ที่ Shopee/Zaapi แนบมาเมื่อลูกค้าแชร์การ์ดสินค้าในแชท เช่น "🛍️ [สินค้า: 43360743407]"
_ITEM_TAG_RE = re.compile(
    r"\[(?:สินค้า|item|item_id|product)\s*[:：]\s*(\d+)\]",
    re.IGNORECASE,
)

# Pattern สำหรับ [order: XXX] tag (เหมือน [สินค้า: item_id])
_ORDER_TAG_RE = re.compile(
    r"\[(?:order|คำสั่งซื้อ)[:\s]*([^\]]+)\]",
    re.IGNORECASE,
)

# Pattern สำหรับ image/video/sticker placeholder
_IMAGE_PLACEHOLDER_RE = re.compile(
    r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]",
    re.IGNORECASE,
)

# Pattern สำหรับ tracking number (คัดลอกจาก order_store)
_TRACKING_RE = re.compile(r"\b([A-Z]{2,4}\d{8,20})\b")


# ---- Placeholder list (copy จาก app.py บรรทัด 1309-1311) --------------------
# ถ้า message เป็นแค่ placeholder เปล่าๆ (ไม่มี id ต่อท้าย) → ถือว่าว่าง
_PLACEHOLDERS_EMPTY = (
    "[item]", "[itemid]", "[สินค้า]",
    "[variation_card]", "[ตัวเลือกสินค้า]",
    "[bundle_message]", "[bundle_deal]", "[bundle]",
    "[order]", "[คำสั่งซื้อ]",
)


# ---- Extract functions ------------------------------------------------------

def extract_item_id(text: str | None) -> str | None:
    """ดึง item_id จาก tag ที่แนบมาในข้อความ (เช่น '[สินค้า: 43360743407]').

    Returns:
        item_id (str) หรือ None ถ้าไม่มี
    """
    if not text:
        return None
    m = _ITEM_TAG_RE.search(text)
    return m.group(1) if m else None


def extract_order_sn(text: str | None) -> str | None:
    """ดึง order_sn จาก [order: XXX] tag หรือ pattern อื่น.

    Returns:
        order_sn (str) หรือ None ถ้าไม่มี
    """
    if not text:
        return None
    # ลอง tag format ก่อน
    m = _ORDER_TAG_RE.search(text)
    if m:
        sn = m.group(1).strip()
        if sn:
            return sn
    # fallback: ใช้ order_store helper
    return _get_order_store().extract_order_sn(text) or None


def extract_tracking(text: str | None) -> str | None:
    """ดึง tracking number จาก message.

    Returns:
        tracking number (str) หรือ None ถ้าไม่มี
    """
    if not text:
        return None
    return _get_order_store().extract_tracking_number(text) or None


def has_image_placeholder(text: str | None) -> bool:
    """ตรวจว่า message มี image/video/sticker placeholder ไหม."""
    if not text:
        return False
    return bool(_IMAGE_PLACEHOLDER_RE.search(text))


def is_image_only(text: str | None) -> bool:
    """ตรวจว่า message เป็นแค่ image/video placeholder ไหม (ไม่มี text อื่น)."""
    if not text:
        return False
    _clean = _IMAGE_PLACEHOLDER_RE.sub("", text).strip()
    return not _clean


def strip_item_tag(text: str | None) -> str:
    """ตัด [สินค้า: XXX] tag ออกจากข้อความ → เหลือแค่คำถามที่เหลือ.

    Returns:
        ข้อความที่ตัด tag ออกแล้ว (strip)
    """
    if not text:
        return ""
    return _ITEM_TAG_RE.sub("", text).strip()


def is_placeholder_only(text: str | None) -> bool:
    """ตรวจว่า message เป็นแค่ placeholder ลอยๆ (ไม่มี id ไม่มีคำถาม) ไหม.

    เช่น "[item]", "[variation_card]", "[bundle_message]" → True
    ใช้สำหรับกัน LLM ได้รับ placeholder เปล่าๆ เป็นคำถาม

    Returns:
        True ถ้า message หลัง strip tag แล้วเป็น placeholder ลอยๆ หรือว่าง
    """
    if not text:
        return True
    cleaned = strip_item_tag(text)
    if cleaned in _PLACEHOLDERS_EMPTY:
        return True
    return not cleaned


def parse_rich_message(text: str | None) -> dict:
    """parse rich message ครบทุก tag → คืน dict สรุป.

    Args:
        text: ข้อความดิบจากลูกค้า (อาจมี tag แนบมา)

    Returns:
        dict:
        - item_id: str | None — item_id จาก [สินค้า: XXX]
        - order_sn: str | None — order_sn จาก [order: XXX] หรือ pattern
        - tracking: str | None — tracking number
        - has_image: bool — มี image/video/sticker placeholder ไหม
        - is_image_only: bool — message เป็นแค่ image placeholder ไหม
        - clean_message: str — ข้อความหลังตัด tag ออก (สำหรับส่ง LLM)
        - is_placeholder_only: bool — message เป็น placeholder ลอยๆ ไหม
    """
    return {
        "item_id": extract_item_id(text),
        "order_sn": extract_order_sn(text),
        "tracking": extract_tracking(text),
        "has_image": has_image_placeholder(text),
        "is_image_only": is_image_only(text),
        "clean_message": strip_item_tag(text),
        "is_placeholder_only": is_placeholder_only(text),
    }
