#!/usr/bin/env python3
"""testQA2 — Test plan generator สำหรับทดสอบ chatbot กับสินค้า NORMAL ทั้งหมด.

โครงสร้างไฟล์นี้:
- ดึงรายการสินค้า status=NORMAL ทั้งหมดจาก MongoDB ตรงๆ (ไม่ผ่าน /chat)
- สร้าง test plan (list ของ dict) ครบทุกเคสที่ผู้ใช้ระบุ
- บันทึก test plan ลง JSON file (ยังไม่รันส่งคำถามจริง)
- พร้อมฟังก์ชัน run_tests() สำหรับรันทีหลังเมื่อผู้ใช้บอก

เคสทดสอบทั้งหมด (ครบทุกเคส):
  1. per_product_detail   — ถาม "ชื่อสินค้า ขอรายละเอียด" ทีละรายการ (3221 เคส)
  2. per_product_warranty — ถาม "ชื่อสินค้า ขอข้อมูลการรับประกัน" ทีละรายการ (3221 เคส)
  3. ambiguous_cross      — ถามชื่อ A แต่ขอรายละเอียดของ B (สลับคู่ วนลูป)
  4. topic_offtopic       — ถามตาม topic ที่หยิบจาก description (เช่น นาฬิกาแบตอึด, โทรศัพท์เล่นเกม ROV)
  5. followup_abcda       — follow-up: ถาม A→B→C→D→กลับ A (เช็ค context switching)
  6. no_followup          — ถามแบบไม่ต่อเนื่อง (history ว่างทุกครั้ง)
  7. complex_conditions   — คำถามซับซ้อนหลายเงื่อนไข (เช่น "โทรศัพท์งบ 5000 RAM 8GB กล้องดี")
  8. teen_slang           — คำถามภาษาวัยรุ่น ("แจ่มแมว เฟี้ยวๆ มันจะเบิ้มๆ")

Usage:
    # สร้าง test plan (default — ยังไม่รันส่งคำถาม)
    python scripts/testQA2.py --generate

    # รัน test จริง (ส่งคำถามไป /chat) — รันเมื่อผู้ใช้บอกเท่านั้น
    python scripts/testQA2.py --run --batch per_product_detail
    python scripts/testQA2.py --run --batch all
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# ---- path setup (รันจาก root หรือ scripts/ ก็ได้) ----
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "chatbot" / "shopeechat"))

# ---- constants ----
CHAT_URL = os.environ.get("TEST_CHAT_URL", "http://127.0.0.1:8011/chat")
CHAT_HEADERS = {"X-Internal-Secret": os.environ.get("CHATBOT_INTERNAL_SECRET", "")}
DELAY = 4.2  # วินาทีระหว่าง request (15 reqs/min)
PLAN_FILE = ROOT / "scripts" / "testQA2_plan.json"
RESULTS_FILE = ROOT / "scripts" / "testQA2_results.json"
WRONG_FILE = ROOT / "scripts" / "testQA2_wrong.json"
SUMMARY_FILE = ROOT / "scripts" / "testQA2_summary.json"

# จำนวนสินค้าสูงสุดที่จะโหลด (None = ทั้งหมด, ตั้งค่าเพื่อทดสอบแบบย่อ)
MAX_PRODUCTS: int | None = None

# ============================================================
# 1. ดึงสินค้า NORMAL ทั้งหมดจาก MongoDB
# ============================================================

def load_normal_products() -> list[dict]:
    """ดึงสินค้า item_status=NORMAL ทั้งหมดจาก MongoDB โดยตรง.

    คืน list ของ dict ที่มี field:
        item_id, item_name, brand, cat_name, shopname, price, description_excerpt
    เรียงตาม item_id
    """
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")

    import product_store

    client = product_store.get_client()
    try:
        db_name = os.environ.get("MONGO_DB", "").strip()
        if not db_name:
            raise SystemExit("ERROR: MONGO_DB ไม่ถูกตั้งใน .env")
        coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
        coll = client[db_name][coll_name]

        projection = {
            "_id": 0,
            "item_id": 1,
            "item_name": 1,
            "brand.original_brand_name": 1,
            "cat_name": 1,
            "shopname": 1,
            "description": 1,
        }
        cursor = coll.find({"item_status": "NORMAL"}, projection).sort("item_id", 1)
        products: list[dict] = []
        for d in cursor:
            brand = d.get("brand") or {}
            if isinstance(brand, dict):
                brand_name = brand.get("original_brand_name", "") or ""
            else:
                brand_name = str(brand) if brand else ""
            # ตัด description ให้สั้น (เอาแค่ 500 ตัวอักษรแรก พอใช้สกัด topic)
            desc = (d.get("description") or "")[:500]
            products.append({
                "item_id": d.get("item_id"),
                "item_name": d.get("item_name") or "",
                "brand": brand_name.strip(),
                "cat_name": d.get("cat_name") or "",
                "shopname": d.get("shopname") or "",
                "description_excerpt": desc,
            })
        return products
    finally:
        client.close()


# ============================================================
# 2. helpers — สกัด keyword/topic จากสินค้า
# ============================================================

# คำที่บ่งบอกประเภทสินค้า (ใช้สำหรับ topic_offtopic)
PRODUCT_TYPE_KEYWORDS: dict[str, list[str]] = {
    "phone": ["โทรศัพท์", "phone", "smartphone", "redmi", "xiaomi", "poco"],
    "smartwatch": ["นาฬิกา", "watch", "smartwatch", "สมาร์ทวอช", "mi band", "amazfit"],
    "earphone": ["หูฟัง", "earphone", "earbuds", "tws", "หูฟังบลูทูธ"],
    "powerbank": ["แบตสำรอง", "powerbank", "power bank"],
    "charger": ["ชาร์จ", "charger", "หัวชาร์จ", "gan"],
    "cable": ["สายชาร์จ", "cable", "สาย type c", "สาย usb"],
    "cctv": ["กล้องวงจรปิด", "cctv", "camera", "imilab"],
    "fan": ["พัดลม", "fan"],
    "vacuum": ["เครื่องดูดฝุ่น", "vacuum", "ดูดฝุ่น"],
    "projector": ["โปรเจคเตอร์", "projector"],
    "massager": ["นวด", "massage", "หมอน"],
    "speaker": ["ลำโพง", "speaker", "ซาวด์บาร์"],
    "scale": ["เครื่องชั่ง", "scale", "ชั่งน้ำหนัก"],
    "gps": ["gps", "tracker", "ติดตาม"],
    "dashcam": ["dashcam", "กล้องติดรถยนต์", "dash cam"],
    "filter": ["ไส้กรอง", "filter", "air purifier"],
    "inverter": ["อินเวอร์เตอร์", "inverter", "แปลงไฟ"],
    "mic": ["ไมโครโฟน", "microphone", "ไมค์"],
    "flashdrive": ["แฟลชไดร์ฟ", "flash drive", "usb"],
    "sdcard": ["sd card", "memory card", "การ์ดหน่วยความจำ"],
}

# คำศัพท์วัยรุ่น/แสลง → คำที่ chatbot ควรเข้าใจ
TEEN_SLANG_MAP: list[dict] = [
    {"slang": "แจ่มแมว", "meaning": "ดีเยี่ยม", "context": "สินค้าคุณภาพดี"},
    {"slang": "เฟี้ยวๆ", "meaning": "ทันสมัย สวย", "context": "ดีไซน์สวยทันสมัย"},
    {"slang": "เบิ้มๆ", "meaning": "ยิ่งใหญ่ ใหญ่", "context": "จอใหญ่ แบตใหญ่"},
    {"slang": "อินเทรนด์", "meaning": "ทันกระแส", "context": "สินค้ามาใหม่"},
    {"slang": "สายมู", "meaning": "เชื่อโชคลาภ", "context": "สินค้าเสริมดวง"},
    {"slang": "ติดดาว", "meaning": "ดีเยี่ยม", "context": "คุณภาพสูง"},
    {"slang": "ปังๆ", "meaning": "ดีมาก", "context": "สินค้าดี"},
    {"slang": "เด็ด", "meaning": "ดีเยี่ยม", "context": "สินค้าเด่น"},
    {"slang": "ฮิต", "meaning": "ยอดนิยม", "context": "ขายดี"},
    {"slang": "คุ้ม", "meaning": "ราคาเหมาะ", "context": "ราคาถูก"},
    {"slang": "ฟรุ้งฟริ้ง", "meaning": "สวยสดใส", "context": "ดีไซน์สวย"},
    {"slang": "จี๊ด", "meaning": "พอดี ตรงใจ", "context": "ตรงความต้องการ"},
    {"slang": "เริ่ด", "meaning": "ดีเยี่ยม", "context": "สินค้าดี"},
    {"slang": "สุดยอด", "meaning": "ดีที่สุด", "context": "สินค้าพรีเมียม"},
    {"slang": "แรง", "meaning": "ประสิทธิภาพสูง", "context": "สเปคแรง"},
    {"slang": "ลื่นไหล", "meaning": "เร็ว ไม่กระตุก", "context": "ประมวลผลเร็ว"},
    {"slang": "อึด", "meaning": "ทน ใช้งานนาน", "context": "แบตอึด ทนทาน"},
    {"slang": "หรูหรา", "meaning": "พรีเมียม", "context": "สินค้าระดับพรีเมียม"},
    {"slang": "เบาสบาย", "meaning": "น้ำหนักเบา", "context": "น้ำหนักเบา"},
    {"slang": "คมชัด", "meaning": "ความชัดสูง", "context": "จอคม กล้องชัด"},
]

# คำถาม topic ที่หยิบจาก description (off-topic แต่เกี่ยวกับสินค้า)
TOPIC_QUESTION_TEMPLATES: list[dict] = [
    {"topic": "แบตอึด", "question": "นาฬิกาแบตอึด ใช้งานได้นานๆ มีไหม", "type": "smartwatch"},
    {"topic": "สายลุยเหมาะเดินป่า", "question": "นาฬิกาสายลุยเหมาะเดินป่า ทนทาน มีไหม", "type": "smartwatch"},
    {"topic": "เล่นเกมลื่น", "question": "โทรศัพท์เล่นเกมลื่นๆ เล่น rov ไม่กระตุก มีไหม", "type": "phone"},
    {"topic": "เล่นเกมส์", "question": "โทรศัพท์เล่นเกมส์ไหว แรมเยอะ มีไหม", "type": "phone"},
    {"topic": "กล้องคม", "question": "โทรศัพท์กล้องคมชัด ถ่ายรูปสวย มีไหม", "type": "phone"},
    {"topic": "แบตถ่าย", "question": "โทรศัพท์แบตถ่ายทน ชาร์จครั้งใช้ 2 วัน มีไหม", "type": "phone"},
    {"topic": "จอใหญ่", "question": "โทรศัพท์จอใหญ่ ดูหนังสบายตา มีไหม", "type": "phone"},
    {"topic": "หูฟังเบส", "question": "หูฟังเบสหนัก เสียงดุ ฟังเพลงมัน มีไหม", "type": "earphone"},
    {"topic": "หูฟังเกม", "question": "หูฟังเล่นเกมดีเลยต่ำ ไม่มีดีเลย์ มีไหม", "type": "earphone"},
    {"topic": "หูฟังกันน้ำ", "question": "หูฟังกันน้ำ ใส่วิ่งฝนตกได้ มีไหม", "type": "earphone"},
    {"topic": "แบตสำรองจุ", "question": "แบตสำรองจุ 20000mAh ขึ้นไป มีไหม", "type": "powerbank"},
    {"topic": "ชาร์จไว", "question": "หัวชาร์จไว ชาร์จ 100W มีไหม", "type": "charger"},
    {"topic": "กล้อง cctv คม", "question": "กล้องวงจรปิดคม 2K 4K มีไหม", "type": "cctv"},
    {"topic": "กล้อง cctv กันน้ำ", "question": "กล้องวงจรปิดกันน้ำ ติดกลางแจ้งได้ มีไหม", "type": "cctv"},
    {"topic": "พัดลมเงียบ", "question": "พัดลมเงียบ ไม่ดัง นอนหลับสบาย มีไหม", "type": "fan"},
    {"topic": "ดูดฝุ่นแรง", "question": "เครื่องดูดฝุ่นแรง ดูดสะอาด มีไหม", "type": "vacuum"},
    {"topic": "โปรเจคเตอร์สว่าง", "question": "โปรเจคเตอร์สว่าง ดูกลางวันได้ มีไหม", "type": "projector"},
    {"topic": "เครื่องนวดแรง", "question": "เครื่องนวดแรง กดลึก คลายเมื่อย มีไหม", "type": "massager"},
    {"topic": "ลำโพงเบส", "question": "ลำโพงเบสหนัก เสียงดัง ฟังเพลงมัน มีไหม", "type": "speaker"},
    {"topic": "เครื่องชั่งแม่น", "question": "เครื่องชั่งแม่น วัดได้ละเอียด มีไหม", "type": "scale"},
    {"topic": "gps แม่น", "question": "gps tracker แม่น ติดตามรถแม่นยำ มีไหม", "type": "gps"},
    {"topic": "dashcam คม", "question": "dashcam คม บันทึกชัด กลางคืนก็เห็น มีไหม", "type": "dashcam"},
    {"topic": "ไส้กรอง hepa", "question": "ไส้กรอง hepa กรอง pm2.5 มีไหม", "type": "filter"},
    {"topic": "อินเวอร์เตอร์แรง", "question": "อินเวอร์เตอร์แรง ใช้กับอุปกรณ์ไฟฟ้าได้ มีไหม", "type": "inverter"},
    {"topic": "ไมค์เสียงดี", "question": "ไมโครโฟนเสียงดี รับเสียงชัด มีไหม", "type": "mic"},
    {"topic": "แฟลชไดร์ฟจุ", "question": "แฟลชไดร์ฟจุ 128gb ขึ้นไป มีไหม", "type": "flashdrive"},
    {"topic": "sd card ไว", "question": "sd card ไว อ่านเขียนเร็ว มีไหม", "type": "sdcard"},
]

# คำถามซับซ้อนหลายเงื่อนไข
COMPLEX_CONDITION_QUESTIONS: list[dict] = [
    {"q": "โทรศัพท์งบ 5000-7000 RAM 8GB กล้องดี แบต 5000mAh ขึ้นไป", "type": "phone"},
    {"q": "โทรศัพท์งบไม่เกิน 10000 จอ AMOLED 120Hz ชาร์จไว", "type": "phone"},
    {"q": "นาฬิกาสมาร์ทวอช ราคาไม่เกิน 2000 แบตอึด 7 วัน กันน้ำ", "type": "smartwatch"},
    {"q": "หูฟัง TWS ราคา 500-1500 กันน้ำ เบสดี มีไมค์", "type": "earphone"},
    {"q": "แบตสำรอง 10000-20000mAh ชาร์จไว PD มีหน้าจอ ราคาไม่เกิน 1000", "type": "powerbank"},
    {"q": "หัวชาร์จ GaN 65W ขึ้นไป พอร์ต 2 ช่อง ขนาดเล็ก", "type": "charger"},
    {"q": "กล้องวงจรปิด WiFi 2K กันน้ำ IP66 มีสี ราคาไม่เกิน 2000", "type": "cctv"},
    {"q": "พัดลมไร้ใบ เงียบ ลมแรง ราคาไม่เกิน 3000", "type": "fan"},
    {"q": "เครื่องดูดฝุ่นไร้สาย แรงดูด 20000Pa ขึ้นไป แบต 60 นาที ขึ้นไป", "type": "vacuum"},
    {"q": "โปรเจคเตอร์ 1080p สว่าง 500 ANSI ขึ้นไป มีลำโพง ราคาไม่เกิน 15000", "type": "projector"},
    {"q": "เครื่องนวดคอ แรง 12 โหมด ขึ้นไป ความร้อน ราคาไม่เกิน 2000", "type": "massager"},
    {"q": "ลำโพงบลูทูธ 20W ขึ้นไป กันน้ำ แบต 10 ชม ขึ้นไป", "type": "speaker"},
    {"q": "เครื่องชั่ง ราคาไม่เกิน 500 วัดไขมัน มีแอป ชาร์จ USB-C", "type": "scale"},
    {"q": "gps tracker ราคาไม่เกิน 1500 แบต 7 วัน ขึ้นไป กันน้ำ", "type": "gps"},
    {"q": "dashcam 2K มี GPS กล้องหลัง ราคาไม่เกิน 3000", "type": "dashcam"},
    {"q": "ไส้กรอง HEPA H13 ขึ้นไป สำหรับเครื่องกรอง Xiaomi", "type": "filter"},
    {"q": "อินเวอร์เตอร์ 1000W ขึ้นไป พอร์ต AC 2 ช่อง USB 2 ช่อง", "type": "inverter"},
    {"q": "ไมโครโฟน USB คอนเดนเซอร์ ราคาไม่เกิน 1500 มี pop filter", "type": "mic"},
    {"q": "แฟลชไดร์ฟ USB-C 128GB ขึ้นไป อ่าน 200MB/s ขึ้นไป", "type": "flashdrive"},
    {"q": "sd card U3 V30 128GB ขึ้นไป สำหรับกล้อง", "type": "sdcard"},
]


def detect_product_type(product: dict) -> str | None:
    """ตรวจประเภทสินค้าจาก item_name + cat_name."""
    text = f"{product.get('item_name','')} {product.get('cat_name','')}".lower()
    for ptype, keywords in PRODUCT_TYPE_KEYWORDS.items():
        if any(kw.lower() in text for kw in keywords):
            return ptype
    return None


def extract_desc_keywords(description: str) -> list[str]:
    """สกัด keyword ที่น่าสนใจจาก description (เพื่อใช้สร้างคำถาม off-topic)."""
    if not description:
        return []
    # หา keyword ที่น่าสนใจ
    interesting = [
        "แบตอึด", "แบตถ่าย", "กันน้ำ", "เล่นเกม", "เล่นเกมส์", "rov", "pubg",
        "คมชัด", "จอใหญ่", "เบส", "เสียงดี", "เงียบ", "แรง", "ลื่น", "ไว",
        "ชาร์จไว", "fast charg", "quick charg", "hypercharg", "turbocharg",
        "amoled", "oled", "120hz", "90hz", "144hz",
        "กล้อง", "ถ่ายรูป", "ถ่ายวิดีโอ", "4k", "8k", "ois",
        "nfc", "wireless charg", "reverse charg",
        "ip68", "ip67", "ip66", "กันฝุ่น",
        "หน้าจอ", "display", "screen",
        "ram", "rom", "storage", "ความจุ",
        "snapdragon", "mediatek", "helio", "dimensity",
        "เบา", "ทนทาน", "หรู", "พรีเมียม", "premium",
        "hepa", "pm2.5", "กรองอากาศ",
        "ดูดฝุ่น", "suction", "pa",
        "สว่าง", "ansi lumen", "lumen",
        "นวด", "massage", "ความร้อน",
        "บลูทูธ", "bluetooth", "tws",
        "wifi", "5g", "4g",
    ]
    desc_low = description.lower()
    found = [kw for kw in interesting if kw.lower() in desc_low]
    return found


def short_name(item_name: str, max_len: int = 60) -> str:
    """ตัดชื่อสินค้าให้สั้น ใช้ในคำถาม (รักษาตัวอักษรไทย/สระไทยทั้งหมด)."""
    # ลบ prefix ที่ไม่จำเป็น เช่น "[ลดเหลือ 3,599 บ.]"
    cleaned = re.sub(r"\[.*?\]", "", item_name).strip()
    # ลบเฉพาะ emoji และสัญลักษณ์พิเศษที่ไม่ใช่ตัวอักษร/ตัวเลข/สระไทย
    # ใช้ whitelist แบบ unicode-aware: เก็บตัวอักษรทุกภาษา ตัวเลข วรรคตอนทั่วไป
    # ลบ emoji ที่อยู่ใน ranges ทั่วไป (Misc Symbols, Emoticons, Transport, etc.)
    cleaned = re.sub(
        r"[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F300-\U0001F9FF"
        r"\U0001F600-\U0001F64F\U0001F680-\U0001F6FF\U0001F700-\U0001F77F]",
        "",
        cleaned,
    ).strip()
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rsplit(" ", 1)[0]
    return cleaned.strip()


# ============================================================
# 3. สร้าง test plan (ยังไม่ส่งคำถามจริง)
# ============================================================

def build_test_plan(products: list[dict]) -> dict:
    """สร้าง test plan ครบทุกเคส.

    คืน dict:
    {
        "meta": {...},
        "batches": {
            "per_product_detail": [...],
            "per_product_warranty": [...],
            "ambiguous_cross": [...],
            "topic_offtopic": [...],
            "followup_abcda": [...],
            "no_followup": [...],
            "complex_conditions": [...],
            "teen_slang": [...],
        },
        "stats": {...},
    }
    """
    if MAX_PRODUCTS:
        products = products[:MAX_PRODUCTS]

    n = len(products)
    batches: dict[str, list[dict]] = {}
    ts = datetime.now().isoformat()

    # ---- Batch 1: per_product_detail (ถามชื่อสินค้า ขอรายละเอียด) ----
    # 3221 เคส: แต่ละสินค้าถาม "ชื่อสินค้า ขอรายละเอียด"
    per_detail = []
    for i, p in enumerate(products):
        name = short_name(p["item_name"])
        per_detail.append({
            "test_id": f"detail-{i+1:05d}",
            "batch": "per_product_detail",
            "item_id": p["item_id"],
            "item_name": p["item_name"],
            "shop": p["shopname"],
            "message": f"{name} ขอรายละเอียดสินค้าหน่อยค่ะ",
            "history": [],
            "expected": f"ตอบรายละเอียดของ {name} จาก context",
            "check": "answer_mentions_product_name",
        })
    batches["per_product_detail"] = per_detail

    # ---- Batch 2: per_product_warranty (ถามชื่อสินค้า ขอข้อมูลการรับประกัน) ----
    # 3221 เคส: แต่ละสินค้าถาม "ชื่อสินค้า ขอข้อมูลการรับประกัน"
    per_warranty = []
    for i, p in enumerate(products):
        name = short_name(p["item_name"])
        per_warranty.append({
            "test_id": f"warranty-{i+1:05d}",
            "batch": "per_product_warranty",
            "item_id": p["item_id"],
            "item_name": p["item_name"],
            "shop": p["shopname"],
            "message": f"{name} ขอข้อมูลการรับประกันค่ะ",
            "history": [],
            "expected": f"ตอบเงื่อนไขรับประกันของ {name}",
            "check": "answer_mentions_warranty",
        })
    batches["per_product_warranty"] = per_warranty

    # ---- Batch 3: ambiguous_cross (ถามชื่อ A แต่ขอรายละเอียด B) ----
    # สลับคู่: A ถามรายละเอียด B, B ถามรายละเอียด C, ... วนลูป
    # ใช้ทุกคู่ที่เป็นไปได้แบบ adjacent (i, i+1) และ (i, i+2) เพื่อให้ครบ
    ambiguous = []
    for i in range(n):
        p_a = products[i]
        # เลือก B เป็นสินค้าถัดไป (วนลูปกลับ)
        p_b = products[(i + 1) % n]
        name_a = short_name(p_a["item_name"])
        name_b = short_name(p_b["item_name"])
        # ถามชื่อ A แต่ขอรายละเอียด B
        ambiguous.append({
            "test_id": f"ambig-{i+1:05d}",
            "batch": "ambiguous_cross",
            "item_id_a": p_a["item_id"],
            "item_name_a": p_a["item_name"],
            "item_id_b": p_b["item_id"],
            "item_name_b": p_b["item_name"],
            "message": f"{name_a} ขอรายละเอียดของ {name_b} หน่อยค่ะ",
            "history": [],
            "expected": f"ตอบรายละเอียดของ {name_b} (ที่ลูกค้าถามรายละเอียด) ไม่ใช่ {name_a}",
            "check": "answer_mentions_b_not_a",
        })
    batches["ambiguous_cross"] = ambiguous

    # ---- Batch 4: topic_offtopic (ถามตาม topic ที่หยิบจาก description) ----
    # หยิบ keyword จาก description ของสินค้าแต่ละรายการมาถาม
    # ใช้ทั้ง template questions และ dynamic questions จาก description
    topic_cases = []
    # 4a: template questions (28 templates)
    for tpl in TOPIC_QUESTION_TEMPLATES:
        topic_cases.append({
            "test_id": f"topic-tpl-{topic_cases.__len__()+1:04d}",
            "batch": "topic_offtopic",
            "message": tpl["question"],
            "history": [],
            "expected": f"ตอบสินค้าประเภท {tpl['type']} ที่ตรง topic '{tpl['topic']}'",
            "check": "answer_product_type",
            "product_type": tpl["type"],
            "topic": tpl["topic"],
        })
    # 4b: dynamic questions จาก description ของสินค้า (สุ่ม 300 รายการเพื่อความหลากหลาย)
    # ใช้ step เพื่อกระจาย ไม่เอาแค่ 300 รายการแรก
    step = max(1, n // 300) if n > 300 else 1
    dyn_count = 0
    for i in range(0, n, step):
        if dyn_count >= 300:
            break
        p = products[i]
        kws = extract_desc_keywords(p["description_excerpt"])
        if not kws:
            continue
        ptype = detect_product_type(p)
        if not ptype:
            continue
        # สร้างคำถามจาก keyword ที่หยิบได้
        kw_sample = kws[:3]
        kw_str = " ".join(kw_sample)
        msg = f"{ptype} {kw_str} มีไหม แนะนำหน่อยค่ะ"
        topic_cases.append({
            "test_id": f"topic-dyn-{dyn_count+1:04d}",
            "batch": "topic_offtopic",
            "item_id": p["item_id"],
            "item_name": p["item_name"],
            "message": msg,
            "history": [],
            "expected": f"ตอบสินค้าประเภท {ptype} ที่เกี่ยวกับ {kw_str}",
            "check": "answer_product_type",
            "product_type": ptype,
            "topic": kw_str,
            "source_keywords": kw_sample,
        })
        dyn_count += 1
    batches["topic_offtopic"] = topic_cases

    # ---- Batch 5: followup_abcda (follow-up: A→B→C→D→กลับ A) ----
    # สร้าง sequence แบบ 4 สินค้า + กลับ A
    # ใช้ทุกกลุ่ม 5 สินค้า (i, i+1, i+2, i+3, กลับ i)
    # เพื่อให้ครบ จะสร้าง sequence ทุก 5 สินค้า
    followup = []
    seq_count = 0
    for i in range(0, n - 4, 5):  # ก้านละ 5 สินค้า
        p_a = products[i]
        p_b = products[i + 1]
        p_c = products[i + 2]
        p_d = products[i + 3]
        seq_count += 1
        seq_id = f"followup-{seq_count:05d}"
        history: list[dict] = []
        steps = [
            ("a", p_a, f"{short_name(p_a['item_name'])} ขอรายละเอียดหน่อยค่ะ"),
            ("b", p_b, f"{short_name(p_b['item_name'])} ขอรายละเอียดหน่อยค่ะ"),
            ("c", p_c, f"{short_name(p_c['item_name'])} ขอรายละเอียดหน่อยค่ะ"),
            ("d", p_d, f"{short_name(p_d['item_name'])} ขอรายละเอียดหน่อยค่ะ"),
            ("a-back", p_a, f"{short_name(p_a['item_name'])} รับประกันยังไงคะ"),
        ]
        for step_idx, (step_label, p, msg) in enumerate(steps):
            followup.append({
                "test_id": f"{seq_id}-step{step_idx+1}-{step_label}",
                "batch": "followup_abcda",
                "sequence_id": seq_id,
                "step": step_idx + 1,
                "step_label": step_label,
                "item_id": p["item_id"],
                "item_name": p["item_name"],
                "message": msg,
                "history": [h.copy() for h in history],  # history ก่อนหน้า
                "expected": f"ตอบเกี่ยวกับ {short_name(p['item_name'])} (step {step_label})",
                "check": "answer_mentions_product_name",
            })
            # เพิ่ม history สำหรับ step ถัดไป (mock — จริงตอนรันจะใส่ answer จริง)
            history.append({"role": "user", "text": msg})
            history.append({"role": "model", "text": f"(mock answer for {short_name(p['item_name'])})"})
    batches["followup_abcda"] = followup

    # ---- Batch 6: no_followup (ถามแบบไม่ต่อเนื่อง history ว่าง) ----
    # ถามสินค้าเดียวกับ followup แต่ history ว่าง (เช็คว่าไม่ต้องอ้าง history)
    no_followup = []
    for i in range(0, n, 10):  # ทุก 10 สินค้า เพื่อจำนวนพอเหมาะ
        p = products[i]
        no_followup.append({
            "test_id": f"nofollow-{len(no_followup)+1:05d}",
            "batch": "no_followup",
            "item_id": p["item_id"],
            "item_name": p["item_name"],
            "message": f"{short_name(p['item_name'])} รับประกันยังไงคะ",
            "history": [],
            "expected": f"ตอบรับประกันของ {short_name(p['item_name'])} โดยไม่อ้าง history",
            "check": "answer_mentions_warranty",
        })
    batches["no_followup"] = no_followup

    # ---- Batch 7: complex_conditions (คำถามซับซ้อนหลายเงื่อนไข) ----
    complex_cases = []
    for i, cq in enumerate(COMPLEX_CONDITION_QUESTIONS):
        complex_cases.append({
            "test_id": f"complex-{i+1:04d}",
            "batch": "complex_conditions",
            "message": cq["q"],
            "history": [],
            "expected": f"ตอบสินค้าประเภท {cq['type']} ที่ตรงเงื่อนไขทั้งหมด",
            "check": "answer_product_type",
            "product_type": cq["type"],
            "conditions": cq["q"],
        })
    batches["complex_conditions"] = complex_cases

    # ---- Batch 8: teen_slang (คำถามภาษาวัยรุ่น) ----
    teen_cases = []
    for i, slang in enumerate(TEEN_SLANG_MAP):
        # แต่ละ slang ถาม 3 แบบ: ถามทั่วไป, ถามเจาะประเภท, ถามเจาะสินค้า
        # 8a: ถามทั่วไป
        teen_cases.append({
            "test_id": f"teen-gen-{i+1:04d}",
            "batch": "teen_slang",
            "message": f"มีสินค้า{slang['slang']} {slang['context']} ไหม แนะนำหน่อยค่ะ",
            "history": [],
            "expected": f"เข้าใจคำว่า '{slang['slang']}' แปลว่า '{slang['meaning']}' แล้วตอบเกี่ยวกับ {slang['context']}",
            "check": "answer_not_empty",
            "slang": slang["slang"],
            "meaning": slang["meaning"],
        })
        # 8b: ถามเจาะประเภท (ใช้ product type จาก template)
        for ptype in ["phone", "smartwatch", "earphone"]:
            type_label = {
                "phone": "โทรศัพท์",
                "smartwatch": "นาฬิกา",
                "earphone": "หูฟัง",
            }[ptype]
            teen_cases.append({
                "test_id": f"teen-{ptype}-{i+1:04d}",
                "batch": "teen_slang",
                "message": f"{type_label}{slang['slang']} {slang['context']} มีไหม",
                "history": [],
                "expected": f"เข้าใจคำว่า '{slang['slang']}' แล้วตอบ{type_label}ที่{slang['context']}",
                "check": "answer_product_type",
                "product_type": ptype,
                "slang": slang["slang"],
                "meaning": slang["meaning"],
            })
    batches["teen_slang"] = teen_cases

    # ---- stats ----
    stats = {batch_name: len(cases) for batch_name, cases in batches.items()}
    stats["total"] = sum(stats.values())
    stats["product_count"] = n

    return {
        "meta": {
            "generated_at": ts,
            "product_count": n,
            "max_products": MAX_PRODUCTS,
            "chat_url": CHAT_URL,
            "delay": DELAY,
            "description": "Test plan สำหรับทดสอบ chatbot กับสินค้า NORMAL ทั้งหมด",
        },
        "batches": batches,
        "stats": stats,
    }


# ============================================================
# 4. บันทึก/โหลด test plan
# ============================================================

def save_plan(plan: dict, path: Path = PLAN_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=2)
    print(f"บันทึก test plan ที่: {path}")
    print(f"  ขนาด: {path.stat().st_size / 1024 / 1024:.1f} MB")


def load_plan(path: Path = PLAN_FILE) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ============================================================
# 5. รัน test (ส่งคำถามจริงไป /chat) — เรียกเมื่อผู้ใช้บอกเท่านั้น
# ============================================================

def run_tests(
    plan: dict,
    batch_name: str = "all",
    max_reqs: int = 445,
    delay: float = DELAY,
    resume: bool = False,
) -> dict:
    """รัน test จริง ส่งคำถามไป /chat.

    Args:
        plan: test plan จาก build_test_plan()
        batch_name: ชื่อ batch ที่จะรัน ("all" = ทั้งหมด)
        max_reqs: จำนวน request สูงสุดต่อรอบ (quota)
        delay: วินาทีระหว่าง request
        resume: ถ้า True จะข้าม test_id ที่มีใน results แล้ว (รันต่อ)

    คืน summary dict.
    """
    import time
    import requests

    batches = plan["batches"]
    if batch_name == "all":
        to_run = []
        for bn, cases in batches.items():
            for c in cases:
                c["_batch"] = bn
                to_run.append(c)
    else:
        if batch_name not in batches:
            print(f"ERROR: batch '{batch_name}' ไม่มีใน plan")
            return {}
        to_run = [{"_batch": batch_name, **c} for c in batches[batch_name]]

    total = len(to_run)

    # ---- resume: โหลด results เดิม ข้าม test_id ที่รันแล้ว ----
    existing_results: list[dict] = []
    done_ids: set[str] = set()
    if resume and RESULTS_FILE.exists():
        try:
            with open(RESULTS_FILE, "r", encoding="utf-8") as f:
                existing_results = json.load(f)
            done_ids = {r["test_id"] for r in existing_results if "test_id" in r}
            print(f"📥 Resume: พบ {len(done_ids)} เคสที่รันแล้ว จะข้าม")
        except Exception as e:
            print(f"⚠️  โหลด results เดิมไม่สไหล: {e} — เริ่มรันใหม่")
            existing_results = []

    # กรองเฉพาะเคสที่ยังไม่ได้รัน
    pending = [c for c in to_run if c.get("test_id", "") not in done_ids]
    skipped = total - len(pending)
    print(f"\n{'='*60}")
    print(f"เริ่มรัน test: {len(pending)} เคส จากทั้งหมด {total} (ข้าม {skipped})")
    print(f"  batch={batch_name}, max={max_reqs}, resume={resume}")
    print(f"{'='*60}\n")

    results: list[dict] = list(existing_results)  # ต่อจากของเดิม
    wrong: list[dict] = []
    req_count = 0

    for idx, case in enumerate(pending):
        if req_count >= max_reqs:
            print(f"\n⚠️  ถึงจำนวน request สูงสุด ({max_reqs}) หยุดที่เคสที่ {idx+1}")
            print(f"   รันแล้ว {req_count} เคสในรอบนี้ (รวม {len(results)}/{total})")
            print(f"   คำสั่งรันต่อ: python scripts/testQA2.py --run --batch {batch_name} --max-reqs {max_reqs} --resume")
            break

        test_id = case.get("test_id", f"case-{idx+1}")
        msg = case["message"]
        history = case.get("history", [])
        shop = case.get("shop")

        # ส่ง request
        payload = {"message": msg, "limit": 10, "history": history}
        if shop:
            payload["shop"] = shop

        try:
            r = requests.post(CHAT_URL, json=payload, headers=CHAT_HEADERS, timeout=180)
            j = r.json()
            answer = j.get("answer", "")
            products = j.get("products", [])
            source = j.get("source", "?")
            elapsed = j.get("elapsed", 0)
        except Exception as e:
            answer = f"ERROR: {e}"
            products = []
            source = "error"
            elapsed = 0

        req_count += 1

        # บันทึกผล
        entry = {
            "test_id": test_id,
            "batch": case.get("_batch", batch_name),
            "message": msg,
            "answer_preview": answer[:300],
            "answer_full": answer,
            "product_names": [p.get("name", "")[:50] for p in products[:5]],
            "product_count": len(products),
            "source": source,
            "elapsed": elapsed,
            "expected": case.get("expected", ""),
            "check": case.get("check", ""),
            "timestamp": datetime.now().isoformat(),
        }
        results.append(entry)

        # แสดง progress (idx+skipped = ลำดับจริงใน to_run)
        global_idx = idx + skipped + 1
        status_icon = "✅" if products else "❌"
        print(
            f"[{global_idx}/{total}] {status_icon} {test_id} | {msg[:50]} → "
            f"src={source} prods={len(products)} {elapsed:.1f}s",
            flush=True,
        )

        # save ทุก 50 เคส (กันข้อมูลหาย)
        if (idx + 1) % 50 == 0:
            _save_results(results, wrong)

        time.sleep(delay)

    # save สุดท้าย
    _save_results(results, wrong)

    # summary
    summary = {
        "batch": batch_name,
        "total_cases": total,
        "run_cases_this_round": req_count,
        "completed_total": len(results),
        "remaining": total - len(results),
        "completed_at": datetime.now().isoformat(),
        "results_file": str(RESULTS_FILE),
        "wrong_file": str(WRONG_FILE),
        "by_source": {},
    }
    for r in results:
        src = r["source"]
        summary["by_source"][src] = summary["by_source"].get(src, 0) + 1

    with open(SUMMARY_FILE, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"\n{'='*60}")
    print(f"เสร็จสิ้นรอบนี้: {req_count} เคส | รวมสะสม {len(results)}/{total}")
    print(f"  เหลืออีก: {total - len(results)} เคส")
    print(f"  results: {RESULTS_FILE}")
    print(f"  wrong:   {WRONG_FILE}")
    print(f"  summary: {SUMMARY_FILE}")
    if total - len(results) > 0:
        print(f"\n📌 รันต่อ: python scripts/testQA2.py --run --batch {batch_name} --max-reqs {max_reqs} --resume")
    print(f"{'='*60}")

    return summary


def _save_results(results: list[dict], wrong: list[dict]) -> None:
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    if wrong:
        with open(WRONG_FILE, "w", encoding="utf-8") as f:
            json.dump(wrong, f, ensure_ascii=False, indent=2)


# ============================================================
# 6. CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="testQA2 — Test plan + runner สำหรับ chatbot")
    parser.add_argument("--generate", action="store_true", help="สร้าง test plan (default)")
    parser.add_argument("--run", action="store_true", help="รัน test จริง (ส่งคำถามไป /chat)")
    parser.add_argument("--resume", action="store_true", help="รันต่อจากที่ค้างไว้ (ข้าม test_id ที่มีใน results แล้ว)")
    parser.add_argument("--progress", action="store_true", help="แสดงความคืบหน้าการรัน (จาก results file)")
    parser.add_argument("--batch", default="all", help="batch ที่จะรัน (default: all)")
    parser.add_argument("--max-reqs", type=int, default=500, help="จำนวน request สูงสุดต่อรอบ (default: 500)")
    parser.add_argument("--delay", type=float, default=DELAY, help="วินาทีระหว่าง request")
    parser.add_argument("--plan-file", default=str(PLAN_FILE), help="path ไฟล์ test plan")
    parser.add_argument("--stats-only", action="store_true", help="แสดงแค่ stats ของ plan ที่มี")
    args = parser.parse_args()

    plan_path = Path(args.plan_file)

    # ---- progress: ดูความคืบหน้า ----
    if args.progress:
        if not plan_path.exists():
            print(f"ไม่พบ plan file: {plan_path}")
            return
        plan = load_plan(plan_path)
        total = plan["stats"]["total"]
        # โหลด results
        done = 0
        by_batch: dict[str, dict] = {}
        if RESULTS_FILE.exists():
            with open(RESULTS_FILE, "r", encoding="utf-8") as f:
                results = json.load(f)
            done = len(results)
            for r in results:
                bn = r.get("batch", "?")
                if bn not in by_batch:
                    by_batch[bn] = {"done": 0, "errors": 0, "no_prods": 0}
                by_batch[bn]["done"] += 1
                if r.get("source") == "error":
                    by_batch[bn]["errors"] += 1
                if r.get("product_count", 0) == 0:
                    by_batch[bn]["no_prods"] += 1
        pct = (done / total * 100) if total else 0
        print(f"\n📊 ความคืบหน้า: {done}/{total} ({pct:.1f}%)")
        print(f"   เหลือ: {total - done} เคส")
        print(f"\n   แต่ละ batch:")
        print(f"   {'batch':25s} {'plan':>6s} {'done':>6s} {'left':>6s} {'err':>5s} {'no_prod':>8s}")
        print(f"   {'-'*25} {'-'*6} {'-'*6} {'-'*6} {'-'*5} {'-'*8}")
        for bn, count in plan["stats"].items():
            if bn in ("total", "product_count"):
                continue
            d = by_batch.get(bn, {"done": 0, "errors": 0, "no_prods": 0})
            left = count - d["done"]
            print(f"   {bn:25s} {count:6d} {d['done']:6d} {left:6d} {d['errors']:5d} {d['no_prods']:8d}")
        return

    if args.stats_only:
        if not plan_path.exists():
            print(f"ไม่พบ plan file: {plan_path}")
            print("รัน: python scripts/testQA2.py --generate ก่อน")
            return
        plan = load_plan(plan_path)
        print("\n📊 Stats ของ test plan:")
        print(f"  สินค้าทั้งหมด: {plan['meta']['product_count']}")
        print(f"  สร้างเมื่อ: {plan['meta']['generated_at']}")
        print(f"\n  แต่ละ batch:")
        for bn, count in plan["stats"].items():
            if bn in ("total", "product_count"):
                continue
            print(f"    {bn:25s}: {count:6d} เคส")
        print(f"\n  รวมทั้งหมด: {plan['stats']['total']} เคส")
        return

    if args.run:
        if not plan_path.exists():
            print(f"ไม่พบ plan file: {plan_path}")
            print("รัน: python scripts/testQA2.py --generate ก่อน")
            return
        plan = load_plan(plan_path)
        run_tests(
            plan,
            batch_name=args.batch,
            max_reqs=args.max_reqs,
            delay=args.delay,
            resume=args.resume,
        )
        return

    # default: generate
    print("กำลังดึงสินค้า NORMAL จาก MongoDB...")
    products = load_normal_products()
    print(f"  พบสินค้า NORMAL: {len(products)} รายการ")

    print("\nกำลังสร้าง test plan...")
    plan = build_test_plan(products)

    print(f"\n📊 Stats:")
    print(f"  สินค้าทั้งหมด: {plan['stats']['product_count']}")
    for bn, count in plan["stats"].items():
        if bn in ("total", "product_count"):
            continue
        print(f"    {bn:25s}: {count:6d} เคส")
    print(f"  รวมทั้งหมด: {plan['stats']['total']} เคส")

    save_plan(plan, plan_path)

    print(f"\n✅ สร้าง test plan เสร็จแล้ว")
    print(f"   ไฟล์: {plan_path}")
    print(f"\nพร้อมรัน? ใช้คำสั่ง:")
    print(f"  python scripts/testQA2.py --run --batch all --max-reqs 500")
    print(f"  python scripts/testQA2.py --run --batch all --max-reqs 500 --resume  # รันต่อ")
    print(f"  python scripts/testQA2.py --progress  # ดูความคืบหน้า")


if __name__ == "__main__":
    main()
