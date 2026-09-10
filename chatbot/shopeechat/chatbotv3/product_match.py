"""product_match — match OpenRouter output กับสินค้าจริงใน ShpProducts.

OpenRouter ตอบพร้อม list สินค้าที่อ้างถึง (เช่น "Xiaomi 14T Pro", "CUKTECH 30W")
เราเอา list นี้มาค้นใน ShpProducts เพื่อ:
1. ยืนยันว่าสินค้ามีจริงในร้านนั้น
2. ดึงข้อมูลจริง: image_url, short_link, price, warranty, status, sold_out
3. แทนที่สินค้าที่ไม่มีจริงด้วยข้อความ "ไม่พบในระบบ"

⚠️ กรองเฉพาะสินค้าในร้านที่ลูกค้าทัก (shop_filter) — กัน cross-shop
"""
from __future__ import annotations

import os
import re
from typing import Any

# ⚡ lazy import product_store — หลีกเลี่ยงการโหลด pymongo ตอน import
_product_store = None


def _get_product_store():
    global _product_store
    if _product_store is None:
        from .. import product_store as _ps
        _product_store = _ps
    return _product_store


def _extract_product_names_from_answer(answer: str) -> list[str]:
    """สกัดชื่อสินค้าที่ OpenRouter อ้างถึงในคำตอบ.

    Heuristic:
    - หา pattern ใน markdown: **ชื่อสินค้า** หรือ [สั่งซื้อ ชื่อสินค้า](link)
    - หาบรรทัดที่ขึ้นต้นด้วย - หรือ • ตามด้วยชื่อสินค้า
    - หาชื่อใน alt text ของรูป ![ชื่อสั้น](url)

    Returns:
        list ของชื่อสินค้าที่สกัดได้ (อาจซ้ำ — caller dedup เอง)
    """
    if not answer:
        return []

    names: list[str] = []

    # Pattern 1: **ชื่อสินค้า** (bold)
    for m in re.finditer(r"\*\*([A-Za-z0-9][A-Za-z0-9\s\-\.]{2,60})\*\*", answer):
        name = m.group(1).strip()
        if name and len(name) >= 3:
            names.append(name)

    # Pattern 2: [สั่งซื้อ ชื่อสินค้า](link) หรือ [ชื่อสินค้า](link)
    for m in re.finditer(r"\[(?:สั่งซื้อ\s+)?([A-Za-z0-9][A-Za-z0-9\s\-\.]{2,60})\]\(", answer):
        name = m.group(1).strip()
        if name and len(name) >= 3:
            names.append(name)

    # Pattern 3: ![ชื่อสั้น](url) — alt text ของรูป
    for m in re.finditer(r"!\[([A-Za-z0-9][A-Za-z0-9\s\-\.]{2,60})\]\(", answer):
        name = m.group(1).strip()
        if name and len(name) >= 3:
            names.append(name)

    # Pattern 4: บรรทัดที่ขึ้นต้นด้วย - หรือ • ตามด้วยชื่อ
    for line in answer.split("\n"):
        line = line.strip()
        if line.startswith(("-", "•", "* ")):
            # ตัด prefix ออก
            name = re.sub(r"^[-•*]\s+", "", line).strip()
            # ตัด markdown ที่เหลือ
            name = re.sub(r"\*\*([^*]+)\*\*", r"\1", name)
            # ตัดที่ | หรือ — หรือ : (เอาแค่ส่วนชื่อ)
            name = re.split(r"\s*[|—:–]\s*", name)[0].strip()
            if name and len(name) >= 3 and not name.startswith(("https://", "http://")):
                names.append(name)

    return names


def _normalize_name(name: str) -> str:
    """normalize ชื่อสินค้าสำหรับเปรียบเทียบ — lowercase + ลบ space และอักขระพิเศษ."""
    if not name:
        return ""
    n = name.lower().strip()
    # ลบ prefix ที่ไม่จำเป็น
    n = re.sub(r"^(สินค้า|product|item|แนะนำ|recommend)\s*[:：]?\s*", "", n)
    # ลบ space และอักขระพิเศษ เก็บแค่ alphanumeric
    n = re.sub(r"[^a-z0-9]", "", n)
    return n


def match_products(
    answer: str,
    shop_filter: str | None,
    db: Any,
    limit: int = 10,
) -> list[dict]:
    """match สินค้าที่ OpenRouter อ้างถึงในคำตอบ กับ ShpProducts จริง.

    Args:
        answer: คำตอบจาก OpenRouter
        shop_filter: ชื่อร้านที่ลูกค้าทัก (กรองเฉพาะร้านนี้)
        db: MongoDB database (product DB)
        limit: จำนวนสินค้าสูงสุดที่จะ match

    Returns:
        list ของ product cards (จาก product_store.to_product_card)
        ลำดับตามที่ปรากฏในคำตอบ
    """
    if not answer or not shop_filter:
        return []

    # 1. สกัดชื่อสินค้าจากคำตอบ
    names = _extract_product_names_from_answer(answer)
    if not names:
        return []

    # 2. dedup ชื่อ (เก็บลำดับแรกที่ปรากฏ)
    seen_normalized: set[str] = set()
    unique_names: list[str] = []
    for name in names:
        norm = _normalize_name(name)
        if norm and norm not in seen_normalized:
            seen_normalized.add(norm)
            unique_names.append(name)

    if not unique_names:
        return []

    # 3. ค้นใน ShpProducts — ใช้ regex match ชื่อ (case-insensitive)
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    coll = db[coll_name]

    matched_cards: list[dict] = []
    matched_item_ids: set[str] = set()

    for name in unique_names[:limit * 2]:  # ค้นได้เยอะกว่า limit เผื่อ duplicate
        # สกัด token สำคัญจากชื่อ (เช่น "Xiaomi 14T Pro" → ["xiaomi", "14t", "pro"])
        tokens = re.findall(r"[A-Za-z0-9]+", name.lower())
        # กรอง token สั้นเกินไป (เช่น "a", "an", "the")
        tokens = [t for t in tokens if len(t) >= 2]
        if not tokens:
            continue

        # สร้าง query: ชื่อต้องมี token หลักอย่างน้อย 1 ตัว + อยู่ในร้านที่ระบุ
        # ใช้ regex ที่มี token ยาวสุด (เฉพาะ alphanumeric) เพื่อลด false positive
        main_token = max(tokens, key=len)
        if len(main_token) < 3:
            # ถ้า token ยาวสุดสั้นเกินไป ใช้คู่ token
            if len(tokens) >= 2:
                main_token = "".join(tokens[:2])
            else:
                continue

        query: dict[str, Any] = {
            "item_name": {"$regex": re.escape(main_token), "$options": "i"},
        }
        if shop_filter:
            query["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}

        # ดึงสินค้าที่ match (เอาแค่อันแรกที่เจอ)
        doc = coll.find_one(query, projection=None)
        if doc:
            item_id = str(doc.get("item_id", ""))
            if item_id and item_id not in matched_item_ids:
                matched_item_ids.add(item_id)
                card = _get_product_store().to_product_card(doc, message=name)
                matched_cards.append(card)

        if len(matched_cards) >= limit:
            break

    return matched_cards


def get_product_by_id(
    item_id: str,
    shop_filter: str | None,
    db: Any,
) -> dict | None:
    """ดึงสินค้า 1 ชิ้นจาก item_id (เหมือน legacy fetch_product_by_id).

    Args:
        item_id: item_id ของสินค้า
        shop_filter: ชื่อร้าน (กรองเฉพาะร้านนี้)
        db: MongoDB database

    Returns:
        product card หรือ None ถ้าไม่พบ
    """
    if not item_id:
        return None
    try:
        doc = _get_product_store().fetch_product_by_id(db, item_id, shop_filter=shop_filter)
        if doc:
            return _get_product_store().to_product_card(doc, message="")
    except Exception:
        pass
    return None


def get_shop_products_summary(
    shop_filter: str | None,
    db: Any,
    message: str = "",
    limit: int = 30,
) -> list[dict]:
    """ดึงสินค้าทั้งหมดในร้าน (สำหรับส่งเป็น context เสริมให้ OpenRouter).

    Args:
        shop_filter: ชื่อร้าน
        db: MongoDB database
        message: คำถามลูกค้า (ใช้กรอง description ตาม intent — ส่งว่างได้)
        limit: จำนวนสูงสุด

    Returns:
        list ของ product cards (slim — เฉพาะ field จำเป็น)
    """
    if not shop_filter:
        return []
    try:
        # ใช้ fetch_products ของ legacy (กรองเฉพาะร้าน)
        # ⚠️ fetch_products signature: (db, message, shop_filter, limit, ...)
        docs = _get_product_store().fetch_products(
            db,
            message=message or shop_filter,  # ใช้ shop name เป็น query ถ้าไม่มี message
            shop_filter=shop_filter,
            limit=limit,
            filter_unavailable=False,  # ดึงทุก status — LLM ตัดสินใจเอง
        )
        # fetch_products คืน list[dict] ที่เป็น product card แล้ว (to_product_card ทำในนั้น)
        return docs if docs else []
    except Exception:
        return []
