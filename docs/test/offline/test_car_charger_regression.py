"""Regression test: car charger fix + existing charger subtype cases.

รัน: cd chatbot && python3 -m test.test_car_charger_regression

ตรวจ:
1. เคสใหม่ (car charger):
   - "มีหัวชาจในรถไหม" (typo) → product_types มี car_charger, subtype=car_charger
   - "มีหัวชาร์จในรถไหม" → product_types มี car_charger, subtype=car_charger
   - fetch_products ดึง CC903P + WCJ153 ได้
2. เคสเก่า (adapter/cable/set) ต้องไม่พัง:
   - "หัวชาร์จ 65w รุ่นไหนดี" → subtype=adapter
   - "สายชาร์จ type c" → subtype=cable
   - "ชุดชาร์จ 65w" → subtype=set
   - "ไม่มีหัวชาร์จหรอ" → subtype=adapter (ไม่มี "ในรถ")
3. เคส iPhone 13 (knowledge_base — ไม่ได้แก้ แต่เช็คว่าไม่พัง):
   - extract_model_keywords("สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ") → []
4. "ในรถ" keyword กว้างเกิน ต้องไม่ match สายชาร์จทั่วไป:
   - "CTC310N ... ใช้งานในรถยนต์" → ไม่ถูก classify เป็น car_charger
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot"))
from shopeechat import knowledge_base  # noqa: E402
knowledge_base._load_env()
from shopeechat import product_store  # noqa: E402


def _check(label: str, actual, expected) -> bool:
    ok = actual == expected
    mark = "✅" if ok else "❌"
    print(f"  {mark} {label}: actual={actual!r} expected={expected!r}")
    return ok


def main() -> None:
    passed = 0
    failed = 0

    print("=== 1) เคสใหม่: car charger detection ===")
    # typo "หัวชาจในรถ" → ต้อง detect เป็น car_charger
    pts = product_store._detect_product_types("มีหัวชาจในรถไหม")
    sub = product_store._detect_charger_subtype("มีหัวชาจในรถไหม")
    if _check("typo product_types มี car_charger", "car_charger" in pts, True):
        passed += 1
    else:
        failed += 1
    if _check("typo subtype=car_charger", sub, "car_charger"):
        passed += 1
    else:
        failed += 1

    # ถูกต้อง "หัวชาร์จในรถ"
    pts2 = product_store._detect_product_types("มีหัวชาร์จในรถไหม")
    sub2 = product_store._detect_charger_subtype("มีหัวชาร์จในรถไหม")
    if _check("correct product_types มี car_charger", "car_charger" in pts2, True):
        passed += 1
    else:
        failed += 1
    if _check("correct subtype=car_charger", sub2, "car_charger"):
        passed += 1
    else:
        failed += 1

    print("\n=== 2) เคสเก่า: adapter/cable/set ต้องไม่พัง ===")
    old_cases = [
        ("หัวชาร์จ 65w รุ่นไหนดี", "adapter"),
        ("สายชาร์จ type c", "cable"),
        ("ชุดชาร์จ 65w", "set"),
        ("ไม่มีหัวชาร์จหรอ", "adapter"),  # follow-up ไม่มี "ในรถ"
        ("หัวชาร์จเร็ว 30w", "adapter"),
        ("สายชาร์จ USB-C to USB-C", "cable"),
    ]
    for msg, expected_sub in old_cases:
        sub = product_store._detect_charger_subtype(msg)
        if _check(f'subtype({msg!r})={expected_sub}', sub, expected_sub):
            passed += 1
        else:
            failed += 1

    print("\n=== 3) เคส iPhone 13 (knowledge_base — ไม่ได้แก้) ===")
    mk = knowledge_base.extract_model_keywords("สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ")
    if _check("extract_model_keywords(iPhone 13คะ)=[]", mk, []):
        passed += 1
    else:
        failed += 1

    print("\n=== 4) 'ในรถ' keyword กว้างเกิน ต้องไม่ match สายชาร์จทั่วไป ===")
    # CTC310N มี "ใช้งานในรถยนต์" ในชื่อ → ต้องไม่ถูก classify เป็น car_charger
    fake_doc = {"item_name": "CUKTECH CTC310N สายชาร์จ USB-C to USB-C 3A 60W ใช้งานในรถยนต์ -2Y"}
    docs = [fake_doc]
    filtered = product_store._filter_charger_subtype(docs, "car_charger")
    if _check("CTC310N ไม่ถูก classify เป็น car_charger", len(filtered), 0):
        passed += 1
    else:
        failed += 1

    # CC903P มี "Car Charger หัวชาร์จในรถ" → ต้องถูก classify เป็น car_charger
    real_doc = {"item_name": "CUKTECH CC903P Car Charger หัวชาร์จในรถ 100W Max พร้อมสายชาร์จ USB-C ในตัว จ่ายไฟได้ 90W -2Y"}
    docs2 = [real_doc]
    filtered2 = product_store._filter_charger_subtype(docs2, "car_charger")
    if _check("CC903P ถูก classify เป็น car_charger", len(filtered2), 1):
        passed += 1
    else:
        failed += 1

    print("\n=== 5) fetch_products จริง (CukTechThailand) ===")
    client = product_store.get_client()
    db = client[os.environ.get("MONGO_DB", "")]
    cards = product_store.fetch_products(db, message="มีหัวชาร์จในรถไหม", shop_filter="CukTechThailand", limit=20)
    names = [c.get("name", "") for c in cards]
    has_cc903 = any("CC903P" in n for n in names)
    has_wcj153 = any("WCJ153" in n for n in names)
    if _check("fetch ได้ CC903P", has_cc903, True):
        passed += 1
    else:
        failed += 1
    if _check("fetch ได้ WCJ153", has_wcj153, True):
        passed += 1
    else:
        failed += 1

    # generic charger ต้องยังดึงได้ปกติ
    cards2 = product_store.fetch_products(db, message="หัวชาร์จ 65w รุ่นไหนดี", shop_filter="CukTechThailand", limit=20)
    if _check("fetch adapter ได้ >0", len(cards2) > 0, True):
        passed += 1
    else:
        failed += 1

    print(f"\n{'='*50}")
    print(f"ผล: ผ่าน {passed} / ล้มเหลว {failed}")
    if failed:
        print("❌ มีเคสล้มเหลว — ต้องตรวจสอบ")
        sys.exit(1)
    else:
        print("✅ ผ่านทุกเคส")


if __name__ == "__main__":
    main()
