"""Diagnostic: ตรวจสินค้า car charger ใน DB ของร้าน CukTech.

รัน: cd chatbot && python -m test.diag_car_charger
     หรือ: python test/diag_car_charger.py (จาก root)

แสดง:
1. สินค้าที่ชื่อมี car_charger keywords (ในร้าน CukTech)
2. สินค้าที่ชื่อมี "charger"/"ชาร์จ" แต่ไม่ match car_charger keywords (อาจเป็น car charger ที่ classify ผิด)
3. ผลลัพธ์ของ _detect_charger_subtype และ _filter_charger_subtype สำหรับคำถาม "มีหัวชาร์จในรถไหม"
"""
from __future__ import annotations

import os
import sys

# โหลด env ผ่าน knowledge_base (ไม่อ่าน .env โดยตรง)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "chatbot"))
from shopeechat import knowledge_base  # noqa: E402
knowledge_base._load_env()

from shopeechat import product_store  # noqa: E402


def main() -> None:
    client = product_store.get_client()
    db_name = os.environ.get("MONGO_DB", "").strip()
    if not db_name:
        print("ERROR: MONGO_DB ไม่ถูกตั้งใน .env")
        sys.exit(1)
    db = client[db_name]
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    coll = db[coll_name]

    shop = "CukTechThailand"
    print(f"=== ตรวจสินค้า car charger ในร้าน {shop} ===\n")

    # 1. สินค้าที่ชื่อมี car_charger keywords
    car_kw = [
        "car charger", "หัวชาร์จในรถ", "หัวชาร์จรถ", "ชาร์จในรถ", "ชาร์จรถ",
        "ที่ชาร์จในรถ", "ที่ชาร์จรถ", "cigarette lighter", "ชาร์จบุหรี่", "ในรถ",
    ]
    print("--- 1) สินค้าที่ชื่อมี car_charger keywords ---")
    for kw in car_kw:
        q = {
            "shopname": {"$regex": f"^{shop}$", "$options": "i"},
            "item_name": {"$regex": kw, "$options": "i"},
        }
        docs = list(coll.find(q, {"item_id": 1, "item_name": 1, "item_status": 1, "cat_name": 1}).limit(20))
        if docs:
            print(f'  keyword "{kw}": {len(docs)} รายการ')
            for d in docs:
                print(f'    [{d.get("item_status")}] {d.get("item_name")} (cat={d.get("cat_name")}, id={d.get("item_id")})')

    # 2. สินค้าที่ชื่อมี "charger"/"ชาร์จ" แต่ไม่ match car_charger keywords (ทั้งหมดในร้าน)
    print("\n--- 2) สินค้า charger ทั้งหมดในร้าน (ดูว่ามี car charger แต่ชื่อไม่ match ไหม) ---")
    q_charger = {
        "shopname": {"$regex": f"^{shop}$", "$options": "i"},
        "item_name": {"$regex": "charger|ชาร์จ", "$options": "i"},
    }
    docs = list(coll.find(q_charger, {"item_id": 1, "item_name": 1, "item_status": 1, "cat_name": 1}).limit(50))
    print(f"  พบ {len(docs)} รายการ")
    car_kw_lower = [k.lower() for k in car_kw]
    for d in docs:
        name = (d.get("item_name") or "").lower()
        is_car = any(kw in name for kw in car_kw_lower)
        marker = "[CAR]" if is_car else "[???]"
        print(f'  {marker} [{d.get("item_status")}] {d.get("item_name")} (cat={d.get("cat_name")}, id={d.get("item_id")})')

    # 3. ทดสอบ _detect_charger_subtype และ _filter_charger_subtype
    print("\n--- 3) ทดสอบ subtype detection ---")
    test_msgs = [
        "มีหัวชาจในรถไหม",      # พิมพ์ตก ร์ (เหมือนลูกค้า)
        "มีหัวชาร์จในรถไหม",    # ถูกต้อง
        "ไม่มีหัวชาร์จหรอ",     # follow-up ไม่มี "ในรถ"
    ]
    for msg in test_msgs:
        sub = product_store._detect_charger_subtype(msg)
        pts = product_store._detect_product_types(msg)
        print(f'  msg="{msg}" → subtype={sub!r}  product_types={pts}')

    # 4. จำลอง fetch_products สำหรับ "มีหัวชาร์จในรถไหม"
    print('\n--- 4) จำลอง fetch_products("มีหัวชาร์จในรถไหม", shop=CukTechThailand) ---')
    cards = product_store.fetch_products(
        db,
        message="มีหัวชาร์จในรถไหม",
        shop_filter=shop,
        limit=20,
    )
    print(f"  ได้ {len(cards)} สินค้า")
    for c in cards[:10]:
        print(f'    [{c.get("item_status", "?")}] {c.get("name", "?")} (id={c.get("item_id")})')
        if c.get("_context_note"):
            print(f'      NOTE: {c["_context_note"]}')


if __name__ == "__main__":
    main()
