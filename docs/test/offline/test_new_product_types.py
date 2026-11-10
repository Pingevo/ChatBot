#!/usr/bin/env python3
"""
test_new_product_types.py — ทดสอบ PRODUCT_TYPES ใหม่ที่เพิ่มจาก audit ShpProducts

ตรวจ:
1. type ใหม่ detect ได้จากชื่อสินค้าจริงใน DB
2. type ใหม่ไม่ทำให้ type เดิมพัง (no false positive)
3. cat_name mapping ครอบคลุม cat_name ที่เคยเป็น gap
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot"))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import product_store
from shopeechat.product_store import (
    _detect_product_types,
    _PRODUCT_TYPE_CATEGORIES,
    _product_type_categories,
)


def _check(label: str, actual, expected) -> bool:
    ok = actual == expected
    mark = "✅" if ok else "❌"
    print(f"  {mark} {label}: actual={actual!r} expected={expected!r}")
    return ok


def main() -> int:
    passed = 0
    failed = 0

    def test(label, actual, expected):
        nonlocal passed, failed
        if _check(label, actual, expected):
            passed += 1
        else:
            failed += 1

    print("=== 1. type ใหม่ detect ได้จากชื่อสินค้าจริง ===")
    # bag
    test("กระเป๋าเป้", "bag" in _detect_product_types("มีกระเป๋าเป้ไหม"), True)
    test("backpack", "bag" in _detect_product_types("มี backpack ไหม"), True)
    test("suitcase", "bag" in _detect_product_types("มี suitcase ไหม"), True)
    test("กระเป๋าเดินทาง", "bag" in _detect_product_types("กระเป๋าเดินทาง"), True)
    # shoes
    test("รองเท้า", "shoes" in _detect_product_types("มีรองเท้าไหม"), True)
    test("sneakers", "shoes" in _detect_product_types("sneakers รุ่นไหนดี"), True)
    test("เครื่องหุ้มรองเท้า", "shoes" in _detect_product_types("เครื่องหุ้มรองเท้า"), True)
    # stationery
    test("ซองพลาสติก", "stationery" in _detect_product_types("ซองพลาสติก"), True)
    test("ปากกาลูกลื่น", "stationery" in _detect_product_types("ปากกาลูกลื่น"), True)
    # gamepad
    test("จอยสติ๊ก", "gamepad" in _detect_product_types("จอยสติ๊ก"), True)
    test("gamepad", "gamepad" in _detect_product_types("gamepad"), True)
    # electric_bike
    test("มอเตอร์ไซค์ไฟฟ้า", "electric_bike" in _detect_product_types("มอเตอร์ไซค์ไฟฟ้า"), True)
    test("himo", "electric_bike" in _detect_product_types("himo"), True)
    # scooter
    test("สกู๊ตเตอร์ไฟฟ้า", "scooter" in _detect_product_types("สกู๊ตเตอร์ไฟฟ้า"), True)
    # clothing
    test("เสื้อยืด", "clothing" in _detect_product_types("เสื้อยืด"), True)
    test("กางเกงยีนส์", "clothing" in _detect_product_types("กางเกงยีนส์"), True)
    # sunglasses
    test("แว่นกันแดด", "sunglasses" in _detect_product_types("แว่นกันแดด"), True)
    # cap
    test("หมวกเบสบอล", "cap" in _detect_product_types("หมวกเบสบอล"), True)
    test("หมวกปลูกผม", "cap" in _detect_product_types("หมวกปลูกผม"), True)
    # mask
    test("หน้ากากอนามัย", "mask" in _detect_product_types("หน้ากากอนามัย"), True)
    # luggage
    test("กระเป๋าเดินทาง travel", "luggage" in _detect_product_types("travel luggage"), True)
    # nail_polisher
    test("เครื่องขัดเล็บ", "nail_polisher" in _detect_product_types("เครื่องขัดเล็บ"), True)
    # pet_bowl
    test("ชามข้าวแมว", "pet_bowl" in _detect_product_types("ชามข้าวแมว"), True)
    # pet_bed
    test("ที่นอนแมว", "pet_bed" in _detect_product_types("ที่นอนแมว"), True)
    # pet_odor_eliminator
    test("เครื่องดับกลิ่น", "pet_odor_eliminator" in _detect_product_types("เครื่องดับกลิ่น"), True)
    # monitor_light
    test("โคมไฟแขวนจอ", "monitor_light" in _detect_product_types("โคมไฟแขวนจอ"), True)
    # dental_flusher
    test("dental flusher", "dental_flusher" in _detect_product_types("dental flusher"), True)
    # home_theater
    test("ชุดเครื่องเสียง", "home_theater" in _detect_product_types("ชุดเครื่องเสียง"), True)
    # ultrasonic_cleaner
    test("ultrasonic cleaner", "ultrasonic_cleaner" in _detect_product_types("ultrasonic cleaner"), True)
    # video_capture
    test("วีดีโอแคปเจอร์", "video_capture" in _detect_product_types("วีดีโอแคปเจอร์"), True)
    # fitness_gear
    test("แท่นวิดพื้น", "fitness_gear" in _detect_product_types("แท่นวิดพื้น"), True)
    # nightlight
    test("nightlight", "nightlight" in _detect_product_types("nightlight"), True)
    # coffee_capsule
    test("coffee capsule", "coffee_capsule" in _detect_product_types("coffee capsule"), True)
    # facial_brush
    test("แปรงทำความสะอาดผิวหน้า", "facial_brush" in _detect_product_types("แปรงทำความสะอาดผิวหน้า"), True)
    # dock
    test("switch dock", "dock" in _detect_product_types("switch dock"), True)
    # green_screen
    test("green screen", "green_screen" in _detect_product_types("green screen"), True)
    # solar_panel
    test("solar panel", "solar_panel" in _detect_product_types("solar panel"), True)
    # webcam
    test("webcam", "webcam" in _detect_product_types("webcam"), True)
    # wifi_extender
    test("ขยายสัญญาณเน็ต", "wifi_extender" in _detect_product_types("ขยายสัญญาณเน็ต"), True)
    # tpms
    test("เครื่องวัดลมยาง", "tpms" in _detect_product_types("เครื่องวัดลมยาง"), True)
    # cat_litter_box
    test("ส้วมแมว", "cat_litter_box" in _detect_product_types("ส้วมแมว"), True)

    print("\n=== 2. existing types ไม่พัง (no false negative) ===")
    test("phone ยัง detect", "phone" in _detect_product_types("โทรศัพท์"), True)
    test("smartwatch ยัง detect", "smartwatch" in _detect_product_types("สมาร์ทวอช"), True)
    test("powerbank ยัง detect", "powerbank" in _detect_product_types("แบตสำรอง"), True)
    test("charger ยัง detect", "charger" in _detect_product_types("หัวชาร์จ 65w"), True)
    test("earphone ยัง detect", "earphone" in _detect_product_types("หูฟัง"), True)
    test("speaker ยัง detect", "speaker" in _detect_product_types("ลำโพง"), True)
    test("vacuum ยัง detect", "vacuum" in _detect_product_types("เครื่องดูดฝุ่น"), True)
    test("massager ยัง detect", "massager" in _detect_product_types("เครื่องนวด"), True)
    test("toothbrush แปรงสีฟัน", "toothbrush" in _detect_product_types("แปรงสีฟันไฟฟ้า"), True)
    test("car_seat คาร์ซีท", "car_seat" in _detect_product_types("คาร์ซีท"), True)
    test("voucher อ้ายฉีอี้", "voucher" in _detect_product_types("อ้ายฉีอี้ VIP"), True)

    print("\n=== 3. _PRODUCT_TYPE_CATEGORIES mapping ครอบคลุม cat_name ที่เคยเป็น gap ===")
    # ทุก cat_name ที่เคยเป็น gap ต้องมี type mapped
    gap_cats = [
        "Men Shoes", "Women Shoes", "Stationery", "Women Bags", "Men Bags",
        "Fashion Accessories", "Gaming & Consoles", "Motorcycles",
        "Baby & Kids Fashion", "Women Clothes", "Men Clothes",
        "Food & Beverages", "Travel & Luggage",
    ]
    for cat in gap_cats:
        types = [t for t, cats in _PRODUCT_TYPE_CATEGORIES.items() if cat in cats]
        test(f"cat '{cat}' มี type mapped", len(types) > 0, True)

    print("\n=== 4. false positive check — คำทั่วไปไม่ควรจับ type ใหม่ผิด ===")
    # "นวด" ไม่ควรจับเป็น massager subtype อื่น — แต่ massager จับได้
    test("'นวด' → massager (ไม่ใช่ type ใหม่)", "massager" in _detect_product_types("นวดหลัง"), True)
    # "หน้ากาก" ในบริบทอื่น — ยังจับ mask ได้ (acceptable)
    # "กระเป๋า" ใน "กระเป๋าสตางค์" — bag จับ (acceptable, cat_name filter กรอง)
    # "รองเท้า" ใน "ที่ถนอมรองเท้า" — ยังจับ shoes (acceptable)

    print(f"\n=== ผล: ผ่าน {passed} / ล้มเหลว {failed} ===")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
