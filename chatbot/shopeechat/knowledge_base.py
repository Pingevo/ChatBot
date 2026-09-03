"""เชื่อม knowledge_base จาก DB admin (read-only) สำหรับ Shopee chatbot.

Flow:
1. ลูกค้าถาม → ตรวจว่าถามถึงรุ่นใด (model detection)
2. ค้นใน knowledge_base (DB admin) ตาม model + brand
3. ถ้าเจอ → ดึงข้อมูลจาก KB (ไม่ต้องใช้ product_store)
4. ถ้าไม่เจอ → คืน None เพื่อให้ app.py ใช้ product_store เดิม

รองรับ:
- ถามแค่ชื่อรุ่น → คืน ชื่อ + รายละเอียด + ลิงก์ (ไม่มีราคา)
- ถาม topic (รับประกัน/สเปก/...) → คืนเฉพาะ field ที่ match
- ถามรับประกัน → รวม product warranty + general FAQ (ถ้ามี)
"""

from __future__ import annotations

import os
import re
from datetime import datetime
from typing import Any

from dotenv import load_dotenv
from pathlib import Path
from pymongo import MongoClient


def _load_env() -> None:
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    load_dotenv(env_path, override=False)


_load_env()


# ---- เงื่อนไขการรับประกันสินค้าเบื้องต้น (แนบทุกครั้งที่ถามเรื่องประกัน) ----

_BASE_WARRANTY_CACHE: str | None = None


def get_base_warranty_text() -> str:
    """ดึงเงื่อนไขการรับประกันสินค้าเบื้องต้น.

    ลำดับความสำคัญ:
    1. จาก KB general_faq (topic=รับประกัน) — แอดมินแก้ไขได้
    2. ค่า default ในโค้ด

    คืนข้อความเงื่อนไขการรับประกันสินค้าเบื้องต้น.
    """
    global _BASE_WARRANTY_CACHE
    if _BASE_WARRANTY_CACHE is not None:
        return _BASE_WARRANTY_CACHE

    # 1. ลองดึงจาก KB general_faq ก่อน
    try:
        faq = get_general_faq("รับประกัน")
        if faq and faq.get("answer"):
            _BASE_WARRANTY_CACHE = faq["answer"].strip()
            return _BASE_WARRANTY_CACHE
    except Exception:
        pass

    # 2. default
    _BASE_WARRANTY_CACHE = (
        "เงื่อนไขการรับประกันสินค้าเบื้องต้น\n"
        "1.กรุณาถ่ายวิดีโอขณะแกะกล่องพัสดุสินค้า เพื่อใช้เป็นหลักฐานในการพิจารณาการเคลม\n"
        "2.สินค้ารับประกันตามเงื่อนไข ภายในระยะเวลาที่ระบุไว้ในรายละเอียดของสินค้าแต่ละรุ่น\n"
        "3.กรณีที่พบปัญหาสินค้าชิ้นส่วนชำรุดเสียหายจากการผลิต โปรดแจ้งรายละเอียดให้ทางร้านตรวจสอบภายใน 7 วันหลังจากได้รับสินค้า หากเกินระยะเวลานี้จะไม่เข้าเงื่อนไขการรับประกัน\n"
        "4.หากสินค้าสูญหาย จะถือว่าสินค้าสิ้นสุดการรับประกันทันที\n"
        "5.ผู้ซื้อต้องเก็บกล่องบรรจุภัณฑ์ไว้เพื่อใช้ในการยืนยันการซื้อสินค้ากับทางร้านกรณีที่อยู่ในระยะการรับประกัน หากไม่มีกล่องหรือเอกสารของทางร้าน ทางร้านขอสงวนสิทธิ์ถือเป็นที่สิ้นสุดการรับประกันสินค้า\n"
        "6.สินค้าที่หมดระยะเวลาการรับประกันแล้ว สามารถซ่อมได้ในบางกรณีเท่านั้นและจะมีค่าใช้จ่ายเพิ่มเติม โดยทางเจ้าหน้าที่จะแจ้งรายละเอียดให้ลูกค้าทราบเพื่อตัดสินใจก่อนทุกครั้ง ทั้งนี้สินค้าบางประเภทจะไม่สามารถซ่อมได้ เช่น หัวชาร์จ สายชาร์จ\n"
        "หมายเหตุ: ข้อมูลนี้เป็นเพียงรายละเอียดเบื้องต้นเท่านั้น หากต้องการข้อมูลฉบับเต็มหรือสอบถามเพิ่มเติม สามารถติดต่อเจ้าหน้าที่แอดมินได้"
    )
    return _BASE_WARRANTY_CACHE


def is_warranty_question(message: str) -> bool:
    """ตรวจว่าคำถามเกี่ยวกับประกัน/เคลม หรือไม่."""
    low = message.lower()
    warranty_kws = [
        "รับประกัน", "ประกัน", "เคลม", "warranty", "claim",
        "ศูนย์", "ซ่อม", "เปลี่ยนสินค้า", "เปลี่ยนใหม่", "เปลี่ยนตัว",
        "garantee", "guarantee",
        "นโยบายรับประกัน", "นโยบายเคลม", "เงื่อนไขรับประกัน",
    ]
    return any(kw in low for kw in warranty_kws)


# ---- DB connection (read-only) ----


_cached_admin_client: MongoClient | None = None

def _build_admin_client() -> MongoClient:
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


def _kb_coll():
    """คืน collection knowledge_base จาก DB admin."""
    db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    coll_name = os.environ.get("ADMIN_MONGO_COLLECTION_KB", "knowledge_base").strip()
    return _build_admin_client()[db_name][coll_name]


# ---- topic detection ----

TOPIC_KEYWORDS: dict[str, list[str]] = {
    "warranty": ["รับประกัน", "ประกัน", "เคลม", "warranty", "claim", "ศูนย์", "ซ่อม", "เปลี่ยน", "garantee", "guarantee"],
    "specs": ["สเปก", "spec", "specification", "คุณสมบัติ", "รายละเอียด", "ขนาด", "น้ำหนัก", "driver", "bluetooth", "battery", "แบต", "ram", "rom", "camera", "จอ", "screen"],
    "box_contents": ["ในกล่อง", "อุปกรณ์", "box", "package", "แพ็กเกจ", "accessories", "อุปกรณ์ในกล่อง"],
    "highlights": ["จุดเด่น", "feature", "ความพิเศษ", "ดี", "เด่น"],
    "description": ["ข้อมูลสินค้า", "รายละเอียดสินค้า", "detail", "description", "info", "ข้อมูล"],
    "comparison": ["เปรียบเทียบ", "compare", "vs", "ต่าง", "เทียบ"],
}

# ---- general question detection (คำถามทั่วไปที่ไม่ได้ถามรุ่นเฉพาะ) ----

GENERAL_QUESTION_KEYWORDS: dict[str, list[str]] = {
    "warranty_policy": [
        "นโยบายรับประกัน", "นโยบายการรับประกัน", "เงื่อนไขรับประกัน",
        "เงื่อนไขการรับประกัน", "มีรับประกันไหม", "มีประกันไหม",
        "รับประกันสินค้า", "ประกันสินค้า", "การรับประกัน",
        "เคลมสินค้า", "นโยบายเคลม", "เงื่อนไขเคลม",
        "มีนโยบายเคลม", "มีนโยบายรับประกัน",
        "รับประกัน", "เคลม", "ประกัน",
    ],
    "return_policy": [
        "นโยบายรับคืน", "นโยบายการรับคืน", "เงื่อนไขรับคืน",
        "เงื่อนไขการรับคืน", "มีรับคืนไหม", "รับคืนสินค้า",
        "คืนสินค้า", "การคืนสินค้า", "มีนโยบายคืน",
        "มีนโยบายรับคืน", "คืนของ", "เปลี่ยนสินค้า",
    ],
    "shipping_policy": [
        "นโยบายจัดส่ง", "เงื่อนไขจัดส่ง", "รอบจัดส่ง",
        "เวลาจัดส่ง", "เวลาทำการ", "เวลาส่ง",
        "จัดส่งสินค้า", "การจัดส่ง", "ส่งสินค้า",
        "มีนโยบายจัดส่ง", "กี่วัน", "ส่งกี่วัน",
        "เมื่อไหร่ส่ง", "เมื่อไหร่ได้ของ",
        "จัดส่ง", "ส่งของ", "นโยบายส่ง",
    ],
    "brands": [
        "มีแบรนด์อะไร", "มีแบรนด์อะไรบ้าง", "แบรนด์อะไรบ้าง",
        "มียี่ห้ออะไร", "มียี่ห้ออะไรบ้าง", "ยี่ห้ออะไรบ้าง",
        "แบรนด์อะไร", "มีกี่แบรนด์", "มีกี่ยี่ห้อ",
        "แบรนด์ทั้งหมด", "ยี่ห้อทั้งหมด",
    ],
    "categories": [
        "หมวดหมู่สินค้า", "หมวดหมู่", "ประเภทสินค้า",
        "มีหมวดหมู่อะไร", "มีหมวดหมู่อะไรบ้าง",
        "มีประเภทอะไร", "มีประเภทอะไรบ้าง",
        "ขายอะไรบ้าง", "มีอะไรขายบ้าง", "มีสินค้าอะไรบ้าง",
    ],
    "shops": [
        "มีร้านอะไร", "มีร้านอะไรบ้าง", "ร้านอะไรบ้าง",
        "มีร้านค้าอะไร", "ร้านค้าอะไรบ้าง",
        "มีกี่ร้าน", "ร้านในเครือ", "ร้านในเครืออะไรบ้าง",
        "มีร้านค้าในเครือ", "ร้านค้าในเครือ", "มีร้านค้าในเครืออะไร",
    ],
    "tax_invoice": [
        "ใบกำกับภาษี", "ใบกำกับ", "ภาษี", "e-tax", "etax",
        "tax invoice", "invoice", "ใบเสร็จ", "ใบกำกับภาษีออกได้ไหม",
        "ออกใบกำกับภาษี", "ขอใบกำกับภาษี", "มีใบกำกับภาษีไหม",
        "มีใบกำกับภาษี", "ออกใบกำกับ", "ขอใบเสร็จ",
        "ใบกำกับภาษีได้ไหม", "ออกภาษีได้ไหม", "มีภาษีไหม",
    ],
}


def detect_general_question(message: str) -> str | None:
    """ตรวจว่าลูกค้าถามคำถามทั่วไป (ไม่เจาะรุ่น) หรือไม่.

    คืน general question type หรือ None.
    ถ้าเป็น general question → ไม่ต้องไป KB/product_store ให้ตอบจาก policy/meta โดยตรง.
    """
    low = message.lower().strip()
    # ต้องเป็นคำถามสั้น ไม่มี model keyword (ตัวเลข+ตัวอักษรผสม)
    # ถ้ามี model keyword → น่าจะถามรุ่นเฉพาะ ไม่ใช่ general question
    keywords = extract_model_keywords(message)
    if len(keywords) >= 2:
        # มี model keyword เยอะ → น่าจะถามรุ่น
        return None

    # เช็ค brand-specific ก่อน (เช่น "xiaomi ขายอะไรบ้าง")
    # ถ้ามีชื่อแบรนด์ + "ขายอะไร" → ไม่ใช่ general categories แต่เป็น brand question
    brand_indicators = ["ขายอะไร", "มีอะไร", "สินค้าอะไร", "มีสินค้าอะไร"]
    known_brands = [
        "xiaomi", "redmi", "poco", "imilab", "black shark", "blackshark",
        "cuktech", "ztec", "isuper", "deerma", "leravan",
        "mili", "kospet", "lydsto", "eloop", "yaber", "1more",
        "kieslect", "zmi", "lagenio", "70mai", "viomi", "qcy",
    ]
    has_brand = any(b in low for b in known_brands)
    has_brand_indicator = any(ind in low for ind in brand_indicators)
    if has_brand and has_brand_indicator:
        return None  # ให้ brand handler ใน app.py จัดการ

    for qtype, kws in GENERAL_QUESTION_KEYWORDS.items():
        if any(kw in low for kw in kws):
            return qtype
    return None


def detect_topic(message: str) -> str | None:
    """ตรวจว่าลูกค้าถามเรื่องอะไร — คืน topic key หรือ None."""
    low = message.lower()
    for topic, keywords in TOPIC_KEYWORDS.items():
        if any(kw in low for kw in keywords):
            return topic
    return None


# ---- model detection (จากข้อความลูกค้า) ----


def extract_model_keywords(message: str) -> list[str]:
    """สกัดคำที่น่าจะเป็นชื่อรุ่นจากข้อความ.

    ใช้ regex หา pattern ที่ดูเหมือนชื่อรุ่น:
    - มีตัวเลข + ตัวอักษร (เช่น Redmi 9, Note 11, A52)
    - มีคำที่เป็นแบรนด์/รุ่นที่รู้จัก
    """
    # ลบคำที่ไม่ใช่ชื่อรุ่น
    stop_words = {"งบ", "บาท", "ราคา", "มีไหม", "มีไหมครับ", "มีไหมคะ", "แนะนำ", "หา", "ดู", "ให้หน่อย",
                  "สั่งซื้อ", "ลิงก์", "ลิ้งค์", "link", "ช่วย", "อยากได้", "ต้องการ", "โทสับ", "โทรศัพท์",
                  "มือถือ", "phone", "สมาร์ทโฟน", "smartphone", "งบประมาณ", "ประมาณ", "เท่าไหร่",
                  "กี่บาท", "ถูก", "แพง", "รับประกัน", "เคลม", "สเปก", "ข้อมูล",
                  # ⚡ คำทั่วไปที่ไม่ใช่ชื่อรุ่นแต่มีตัวอักษร — กัน false positive
                  "app", "apps", "แอป", "แอพ", "แอปพลิเคชัน", "application",
                  "wifi", "wi-fi", "bluetooth", "gps", "nfc", "usb", "type-c", "typec",
                  "ios", "android", "windows", "mac", "linux",
                  "วิธี", "ตั้งค่า", "ติดตั้ง", "ใช้งาน", "เชื่อมต่อ", "การเชื่อมต่อ",
                  "รีวิว", "review", "รูป", "ภาพ", "วิดีโอ", "วิดิโอ", "video",
                  "สอบถาม", "ถาม", "อยาก", "สนใจ", "ขอ", "ขอดู", "ขอรายละเอียด",
                  "กี่", "ชิ้น", "ตัว", "อัน", "ชุด", "พร้อม", "ส่ง", "เก็บ", "ดีลิเวอรี"}

    # ถ้าข้อความมีคำว่างบ/บาท/ราคา → ตัดตัวเลขล้วนออก (เพราะน่าจะเป็นงบประมาณ ไม่ใช่ชื่อรุ่น)
    low_msg = message.lower()
    has_budget_word = any(w in low_msg for w in ("งบ", "บาท", "ราคา", "budget", "price"))

    # แบ่งคำด้วย whitespace + เครื่องหมาย
    tokens = re.split(r"[\s,/\-]+", message.strip())
    candidates = []
    for t in tokens:
        t = t.strip()
        if not t or len(t) < 2:
            continue
        if t.lower() in stop_words:
            continue
        # ถ้ามีงบ/บาท ในข้อความ และ token เป็นเลขล้วน → ข้าม (เป็นงบประมาณ ไม่ใช่ชื่อรุ่น)
        if has_budget_word and re.fullmatch(r"\d+", t):
            continue
        # ถ้ามีตัวเลขหรือตัวอักษรผสม → น่าจะเป็นรุ่น
        if re.search(r"[A-Za-z0-9]", t) and len(t) >= 2:
            candidates.append(t)

    return candidates


# ---- search KB ----


def search_kb_by_model(message: str, limit: int = 5) -> list[dict[str, Any]]:
    """ค้น knowledge_base ตามชื่อรุ่นที่สกัดจากข้อความ.

    กฎการ match (strict — กัน false positive):
    - ทุก keyword ที่สกัดได้ ต้องอยู่ใน "brand + model" รวมกัน
    - ถ้า keyword ไหนอยู่แค่ใน brand แต่ไม่อยู่ใน model → ไม่นับ (กัน "Xiaomi" match ทุกรุ่น Xiaomi)
    - อย่างน้อย 1 keyword ต้องอยู่ใน model (ไม่ใช่แค่ brand)
    - ทนต่อการเว้นวรรคผิด: เปรียบเทียบแบบลบ whitespace ออกด้วย
      (เช่น "BlackShark T11" จะ match "Black Shark T11")
    - กรณี comparison (มี "vs"): แยกค้นแต่ละรุ่นแล้วรวมกัน
      (เพราะ "ec4 vs ec5" ไม่ควร require ทั้ง ec4 และ ec5 อยู่ในรุ่นเดียวกัน)

    คืน list ของ KB docs (product_spec) ที่ match.
    """
    # กรณี comparison: แยกค้นแต่ละรุ่น
    msg_lower = message.lower()
    # ตรวจ comparison: "vs", "เปรียบเทียบ", "เทียบ", "กับ...ต่างกัน", "ต่างกันยังไง"
    # หรือ implicit comparison: message สั้นๆ ที่มี 2+ model keywords (เช่น "k5 k9")
    _is_comparison = (
        " vs " in msg_lower
        or "เปรียบเทียบ" in msg_lower
        or "เทียบ" in msg_lower
        or ("กับ" in msg_lower and "ต่าง" in msg_lower)
        or "ต่างกัน" in msg_lower
        or "ต่างกันยังไง" in msg_lower
    )
    # implicit comparison: message สั้นๆ มี 2+ model keywords
    # แต่ต้องไม่มีคำถามอื่น (เช่น "สเปค", "รับประกัน", "spec") เพราะอาจเป็น "brand + model" ของรุ่นเดียว
    if not _is_comparison:
        _models_check = extract_model_keywords(message)
        _models_check = [m for m in _models_check if m.lower() != "vs"]
        _non_model_words = [w for w in message.split() if w.lower() not in [m.lower() for m in _models_check] and w.lower() != "vs"]
        # implicit comparison เฉพาะเมื่อไม่มีคำอื่นนอกจาก model keywords (เช่น "k5 k9")
        if len(_models_check) >= 2 and len(_non_model_words) == 0:
            _is_comparison = True
    if _is_comparison:
        # แยกตาม " vs ", "เปรียบเทียบ", "เทียบ", "กับ", "ต่างกัน"
        parts = re.split(
            r"\s+vs\s+|\s*เปรียบเทียบ\s*|\s*เทียบ\s*|\s+กับ\s+|\s*ต่างกัน.*",
            message, flags=re.IGNORECASE
        )
        # ถ้าแยกแล้วได้แค่ 1 part (เช่น "K3 k5 k2 k9 ต่างกันยังไง")
        # ให้ใช้ model keywords แยกแต่ละรุ่นแทน
        _valid_parts = [p.strip() for p in parts if p.strip()]
        if len(_valid_parts) <= 1:
            # ใช้ extract_model_keywords เพื่อแยกแต่ละรุ่น
            _models = extract_model_keywords(message)
            # กรอง "vs" ออก
            _models = [m for m in _models if m.lower() != "vs"]
            if len(_models) >= 2:
                _valid_parts = _models
        all_docs: list[dict] = []
        seen_ids: set = set()
        for part in _valid_parts:
            sub_docs = _search_kb_single(part, limit=limit)
            for d in sub_docs:
                if d["_id"] not in seen_ids:
                    seen_ids.add(d["_id"])
                    all_docs.append(d)
                    if len(all_docs) >= limit * 3:
                        break
        return all_docs[:limit * 3]

    return _search_kb_single(message, limit=limit)


def _search_kb_single(message: str, limit: int = 5) -> list[dict[str, Any]]:
    """ค้น KB แบบ single query (ไม่ใช่ comparison)."""
    keywords = extract_model_keywords(message)
    if not keywords:
        return []

    coll = _kb_coll()

    # ดึงแค่ brand+model ก่อน (เร็ว ~0.5s) เพื่อหา doc ที่ match
    # แล้วค่อยดึงฟิลด์เต็มเฉพาะที่ match (ไม่ดึง description/specs ทั้งหมด ~8s)
    light_docs = list(
        coll.find(
            {"type": "product_spec", "active": {"$ne": False}},
            {"brand": 1, "model": 1},
        )
    )

    keywords_lower = [k.lower() for k in keywords]
    # สร้าง version ที่ลบ whitespace ออก (สำหรับ match แบบไม่สนใจวรรค)
    keywords_nospace = [re.sub(r"\s+", "", k) for k in keywords_lower]
    matched_ids: list[tuple[Any, int]] = []  # (ObjectId, score)

    for doc in light_docs:
        model_str = (doc.get("model") or "").lower().strip()
        brand_str = (doc.get("brand") or "").lower().strip()
        combined = f"{brand_str} {model_str}"
        combined_nospace = re.sub(r"\s+", "", combined)
        model_nospace = re.sub(r"\s+", "", model_str)

        # ทุก keyword ต้องอยู่ใน combined (brand + model)
        # เช็คทั้งแบบมีวรรคและไม่มีวรรค
        all_in_combined = all(
            kl in combined or kn in combined_nospace
            for kl, kn in zip(keywords_lower, keywords_nospace)
        )
        if not all_in_combined:
            continue

        # อย่างน้อย 1 keyword ต้องอยู่ใน model (ไม่ใช่แค่ brand)
        any_in_model = any(
            kl in model_str or kn in model_nospace
            for kl, kn in zip(keywords_lower, keywords_nospace)
        )
        if not any_in_model:
            continue

        # scoring: keyword ที่อยู่ใน model ได้คะแนนสูงกว่า brand
        score = 0
        for kl, kn in zip(keywords_lower, keywords_nospace):
            if kl in model_str or kn in model_nospace:
                score += 2
            elif kl in brand_str:
                score += 1

        # bonus: ถ้า model มี keyword ติดกัน (เช่น "redmi 8a" อยู่ติดกันใน "redmi 8a")
        # ลองรวม keyword เป็น phrase แล้วเช็ค (ทั้งแบบมีวรรคและไม่มีวรรค)
        phrase = " ".join(keywords_lower)
        phrase_nospace = re.sub(r"\s+", "", phrase)
        if phrase in model_str or phrase_nospace in model_nospace:
            score += 5  # match ทั้ง phrase → คะแนนสูงมาก

        matched_ids.append((doc["_id"], score))

    if not matched_ids:
        return []

    # เรียงตาม score descending แล้วเอาแค่ limit
    matched_ids.sort(key=lambda x: x[1], reverse=True)
    top_ids = [oid for oid, _ in matched_ids[:limit]]

    # ดึงฟิลด์เต็มเฉพาะที่ match
    results = list(
        coll.find(
            {"_id": {"$in": top_ids}},
            {"brand": 1, "model": 1, "category": 1, "category_id": 1,
             "highlights": 1, "description": 1, "box_contents": 1,
             "warranty_period": 1, "warranty_note": 1, "notes": 1,
             "weight": 1, "dimensions": 1, "specs": 1, "extra_fields": 1,
             "source_file": 1, "source_row": 1},
        )
    )
    # ใส่ score กลับ
    score_map = {oid: sc for oid, sc in matched_ids}
    for doc in results:
        doc["_match_score"] = score_map.get(doc["_id"], 0)
    results.sort(key=lambda x: x.get("_match_score", 0), reverse=True)
    return results


def get_general_faq(topic: str = "รับประกัน") -> dict[str, Any] | None:
    """ดึง general_faq ตาม topic (เช่น เงื่อนไขรับประกันทั่วไป)."""
    coll = _kb_coll()
    return coll.find_one({"type": "general_faq", "topic": topic, "active": {"$ne": False}})


def _extract_policy_from_descriptions(mongo_coll, policy_type: str, limit: int = 200) -> str:
    """ดึงนโยบายจาก description ของสินค้าใน Mongo (warranty/return/shipping).

    ดึงสินค้า NORMAL จำนวน limit แล้วหา section ที่เกี่ยวข้อง
    คืนข้อความนโยบายที่พบ (unique) หรือ "" ถ้าไม่เจอ.
    """
    markers_map = {
        "warranty": ["เงื่อนไขการรับประกัน", "เงื่อนไขรับประกัน", "นโยบายการรับประกัน"],
        "return": ["นโยบายการรับคืน", "เงื่อนไขการรับคืน", "นโยบายรับคืน"],
        "shipping": ["เงื่อนไขการจัดส่ง", "นโยบายการจัดส่ง", "รอบจัดส่ง", "เวลาทำการ"],
    }
    markers = markers_map.get(policy_type, [])
    if not markers:
        return ""

    docs = list(mongo_coll.find(
        {"item_status": "NORMAL"},
        {"description": 1, "shopname": 1}
    ).limit(limit))

    seen_sections: set[str] = set()
    sections: list[str] = []
    for d in docs:
        desc = d.get("description", "") or ""
        shop = d.get("shopname", "")
        for marker in markers:
            idx = desc.find(marker)
            if idx < 0:
                continue
            # หาจุดจบ section (บรรทัดว่าง หรือ marker ถัดไป)
            end = desc.find("\n\n", idx)
            if end < 0:
                end = idx + 800
            section = desc[idx:end].strip()
            # ทำความสะอาด — กรองบรรทัดที่เป็น separator
            lines = [l for l in section.split("\n") if l.strip() and "---" not in l]
            section = "\n".join(lines)
            if section and section not in seen_sections:
                seen_sections.add(section)
                sections.append(f"[ร้าน {shop}]\n{section}")

    return "\n\n".join(sections[:5])  # เก็บแค่ 5 sections แรก


def build_general_context(
    qtype: str,
    mongo_db=None,
    shop_filter: str | None = None,
) -> dict[str, Any] | None:
    """สร้าง context สำหรับคำถามทั่วไป (policy/brands/categories/shops).

    Args:
        qtype: ประเภทคำถามทั่วไป
        mongo_db: mongo database handle
        shop_filter: ถ้าระบุ (ลูกค้าทักมาจากร้านนี้) ให้จำกัด categories/brands
            เฉพาะสินค้าของร้านนี้เท่านั้น ไม่ปนร้านอื่นในเครือ

    คืน dict:
    {
        "qtype": str,
        "context": str,  # context สำหรับส่ง LLM
        "meta": dict,    # ข้อมูลเพิ่มเติม (brands list, categories list, etc.)
    }
    หรือ None ถ้าไม่รองรับ.
    """
    import os
    import re

    _shop_q = (
        {"shopname": {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}}
        if shop_filter else {}
    )

    # ---- warranty/return/shipping policy ----
    if qtype in ("warranty_policy", "return_policy", "shipping_policy"):
        # 1. ดึง general_faq จาก KB ก่อน
        topic_map = {
            "warranty_policy": "รับประกัน",
            "return_policy": "รับคืน",
            "shipping_policy": "จัดส่ง",
        }
        kb_topic = topic_map.get(qtype, "")
        faq = get_general_faq(kb_topic) if kb_topic else None
        faq_answer = (faq or {}).get("answer", "") or ""

        # 2. ดึงจาก Mongo description — เฉพาะ return/shipping (ไม่ใช่ warranty)
        #    สำหรับ warranty: ใช้แค่ general_faq เพราะเป็นเงื่อนไขทั่วไป
        #    ถ้าดึงจาก description สินค้า จะทำให้ LLM ยกตัวอย่างสินค้าเฉพาะมาตอบ
        #    ทั้งที่ลูกค้ายังไม่ได้ถามสินค้าใดเฉพาะเจาะจง
        mongo_sections = ""
        if mongo_db is not None and qtype != "warranty_policy":
            coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
            mongo_coll = mongo_db[coll_name]
            policy_key = qtype.replace("_policy", "")
            mongo_sections = _extract_policy_from_descriptions(mongo_coll, policy_key)

        # 3. รวม context
        parts = []
        if faq_answer:
            parts.append(f"=== นโยบาย{kb_topic} (จาก Knowledge Base) ===\n{faq_answer}")
        if mongo_sections:
            parts.append(f"=== นโยบาย{kb_topic} (จากข้อมูลร้านค้า) ===\n{mongo_sections}")
        if not parts:
            # fallback: ดึงจาก Mongo description ถ้าไม่มี general_faq
            if mongo_db is not None and qtype == "warranty_policy":
                coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
                mongo_coll = mongo_db[coll_name]
                mongo_sections = _extract_policy_from_descriptions(mongo_coll, "warranty")
                if mongo_sections:
                    parts.append(f"=== นโยบาย{kb_topic} (จากข้อมูลร้านค้า) ===\n{mongo_sections}")
            if not parts:
                parts.append(f"ยังไม่มีข้อมูลนโยบาย{kb_topic}ในระบบ ขอแนะนำให้ทักแอดมินสอบถามได้เลยนะคะ")

        context = "\n\n".join(parts)
        return {"qtype": qtype, "context": context, "meta": {}}

    # ---- brands ----
    if qtype == "brands" and mongo_db is not None:
        coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
        mongo_coll = mongo_db[coll_name]
        from collections import Counter
        brand_counts = Counter()
        brand_cats: dict[str, set[str]] = {}
        for d in mongo_coll.find({"item_status": "NORMAL", **_shop_q}, {"brand": 1, "cat_name": 1}).limit(10000):
            b = d.get("brand", "")
            if isinstance(b, dict):
                bname = b.get("original_brand_name", "") or ""
            else:
                bname = str(b) if b else ""
            c = d.get("cat_name", "")
            if bname:
                brand_counts[bname] += 1
                if c:
                    brand_cats.setdefault(bname, set()).add(str(c))
        top_brands = brand_counts.most_common(30)
        lines = []
        for bname, count in top_brands:
            cats = sorted(brand_cats.get(bname, set()))
            lines.append(f"- {bname} ({count} สินค้า) — หมวด: {', '.join(cats[:5])}")
        context = f"=== แบรนด์สินค้าในร้าน ({len(brand_counts)} แบรนด์) ===\n" + "\n".join(lines)
        return {"qtype": qtype, "context": context, "meta": {"brand_count": len(brand_counts)}}

    # ---- categories ----
    if qtype == "categories" and mongo_db is not None:
        coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
        mongo_coll = mongo_db[coll_name]
        base_q = {"item_status": "NORMAL", **_shop_q}

        # นับสินค้าต่อหมวด (เฉพาะร้านนี้ ถ้าระบุ shop_filter)
        from collections import Counter
        cat_counts = Counter()
        sample_products: list[str] = []
        for d in mongo_coll.find(base_q, {"cat_name": 1, "item_name": 1}).limit(10000):
            c = d.get("cat_name", "")
            if c:
                cat_counts[str(c)] += 1
            name = d.get("item_name", "")
            if name and len(sample_products) < 30:
                sample_products.append(str(name)[:80])

        if shop_filter and not cat_counts:
            # ร้านนี้ไม่มีสินค้า NORMAL เลย → คืน None ให้ caller ตัดสินใจ fallback
            return None

        cats = sorted(cat_counts.keys())
        lines = [f"- {c} ({cat_counts.get(c, 0)} สินค้า)" for c in cats]
        if shop_filter:
            context = (
                f"=== หมวดหมู่สินค้าของร้าน {shop_filter} ({len(cats)} หมวด) ===\n"
                + "\n".join(lines)
                + "\n\nตัวอย่างสินค้าในร้านนี้ (เลือกแนะนำสัก 3 ชิ้นที่หลากหลาย):\n"
                + "\n".join(f"- {p}" for p in sample_products[:15])
            )
        else:
            context = f"=== หมวดหมู่สินค้า ({len(cats)} หมวด) ===\n" + "\n".join(lines)
        return {"qtype": qtype, "context": context, "meta": {"category_count": len(cats)}}

    # ---- shops ----
    if qtype == "shops" and mongo_db is not None:
        coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
        mongo_coll = mongo_db[coll_name]
        shops = sorted(str(s) for s in mongo_coll.distinct("shopname") if s)
        lines = [f"- {s}" for s in shops]
        context = f"=== ร้านค้าในเครือ ({len(shops)} ร้าน) ===\n" + "\n".join(lines)
        return {"qtype": qtype, "context": context, "meta": {"shop_count": len(shops)}}

    # ---- tax invoice ----
    if qtype == "tax_invoice":
        context = (
            "=== นโยบายใบกำกับภาษี ===\n"
            "ทางร้านสามารถออกใบกำกับภาษีได้ในรูปแบบเอกสารเท่านั้น "
            "(ไม่มีรูปแบบ electronics หรือ e-tax)\n"
            "สามารถจัดส่งไปรษณีย์เป็นเอกสารได้\n"
            "หากลูกค้าต้องการใบกำกับภาษี หรือต้องการติดต่อแอดมินเพิ่มเติม "
            "สามารถแจ้งได้เลย แล้วทางเราจะส่งต่อให้แอดมินดำเนินการต่อให้ค่ะ"
        )
        return {"qtype": qtype, "context": context, "meta": {}}

    return None


# ---- format KB doc เป็น context สำหรับ LLM ----


def format_kb_context(
    kb_docs: list[dict[str, Any]],
    topic: str | None = None,
    general_faq: dict[str, Any] | None = None,
) -> str:
    """แปลง KB docs → context text สำหรับส่งให้ LLM.

    Args:
        kb_docs: list ของ product_spec docs จาก KB
        topic: topic ที่ลูกค้าถาม (ถ้าระบุ) — จะเลือกเฉพาะ field ที่เกี่ยวข้อง
        general_faq: general FAQ doc (สำหรับเงื่อนไขรับประกันทั่วไป)
    """
    if not kb_docs:
        return ""

    parts: list[str] = []
    parts.append("ข้อมูลสินค้าจาก Knowledge Base (ข้อมูลที่ดูแลโดยแอดมิน):")
    parts.append(f"จำนวนสินค้าใน context: {len(kb_docs)}")
    parts.append("")

    for doc in kb_docs:
        brand = doc.get("brand") or ""
        model = doc.get("model") or ""
        category = doc.get("category") or ""
        category_id = doc.get("category_id") or ""

        parts.append(f"--- {brand} {model} ---")
        if category:
            parts.append(f"หมวด: {category} ({category_id})")

        # ถ้าถาม topic เฉพาะ → ส่งเฉพาะ field นั้น
        if topic == "warranty":
            warranty_period = doc.get("warranty_period") or ""
            warranty_note = doc.get("warranty_note") or ""
            if warranty_period:
                parts.append(f"ระยะเวลารับประกัน: {warranty_period}")
            if warranty_note:
                parts.append(f"เงื่อนไขรับประกัน: {warranty_note}")
            if not warranty_period and not warranty_note:
                parts.append("รับประกัน: ไม่มีข้อมูลการรับประกันสำหรับรุ่นนี้")

        elif topic == "specs":
            specs = doc.get("specs") or {}
            weight = doc.get("weight") or ""
            dimensions = doc.get("dimensions") or ""
            if specs:
                parts.append("สเปก:")
                for k, v in specs.items():
                    if v:
                        parts.append(f"  {k}: {v}")
            if weight:
                parts.append(f"น้ำหนัก: {weight}")
            if dimensions:
                parts.append(f"ขนาด: {dimensions}")

        elif topic == "box_contents":
            box = doc.get("box_contents") or ""
            if box:
                parts.append(f"อุปกรณ์ในกล่อง: {box}")
            else:
                parts.append("อุปกรณ์ในกล่อง: ไม่มีข้อมูล")

        elif topic == "highlights":
            highlights = doc.get("highlights") or ""
            if highlights:
                parts.append(f"จุดเด่น: {highlights}")

        elif topic == "description":
            desc = doc.get("description") or ""
            if desc:
                parts.append(f"ข้อมูลสินค้า: {desc}")

        else:
            # ไม่ระบุ topic → ส่งข้อมูลหลัก (สำหรับถามแค่ชื่อรุ่น)
            highlights = doc.get("highlights") or ""
            desc = doc.get("description") or ""
            if highlights:
                parts.append(f"จุดเด่น: {highlights}")
            if desc:
                parts.append(f"ข้อมูลสินค้า: {desc}")
            # ส่ง specs ด้วย (แบบสั้น)
            specs = doc.get("specs") or {}
            if specs:
                parts.append("สเปกหลัก:")
                for k, v in list(specs.items())[:5]:
                    if v:
                        parts.append(f"  {k}: {v}")

        # ส่ง extra_fields ที่เกี่ยวกับ topic ถ้ามี
        extra = doc.get("extra_fields") or {}
        if extra and topic:
            topic_kw = TOPIC_KEYWORDS.get(topic, [])
            for k, v in extra.items():
                if any(kw in k.lower() for kw in topic_kw) and v:
                    parts.append(f"{k}: {v}")

        parts.append("")

    # เพิ่ม general FAQ ถ้ามี (สำหรับเงื่อนไขรับประกันทั่วไป)
    if general_faq:
        parts.append("--- เงื่อนไขรับประกันทั่วไป ---")
        answer_text = general_faq.get("answer") or ""
        if answer_text:
            parts.append(answer_text)
        parts.append("")

    return "\n".join(parts)


# ---- main entry: ค้น KB + คืน context ----


def lookup_kb(message: str) -> dict[str, Any] | None:
    """ค้น KB ตามข้อความลูกค้า.

    คืน dict:
    {
        "found": True/False,
        "kb_docs": [...],
        "topic": "warranty" | None,
        "general_faq": {...} | None,
        "context": "..." (formatted context สำหรับ LLM)
    }

    ถ้าไม่เจอใน KB → คืน {"found": False, ...}
    """
    topic = detect_topic(message)
    kb_docs = search_kb_by_model(message, limit=5)

    if not kb_docs:
        return {"found": False, "kb_docs": [], "topic": topic, "general_faq": None, "context": ""}

    # ถ้าถามรับประกัน → ดึง general FAQ ด้วย
    general_faq = None
    if topic == "warranty":
        general_faq = get_general_faq("รับประกัน")

    # ถ้าถามรับประกัน แต่สินค้าไม่มี warranty เลย → ไม่ต้องส่ง general FAQ
    if topic == "warranty" and general_faq:
        has_any_warranty = any(
            (doc.get("warranty_period") or doc.get("warranty_note"))
            for doc in kb_docs
        )
        if not has_any_warranty:
            general_faq = None  # สินค้าไม่มี warranty → ไม่ต้องส่ง general FAQ

    context = format_kb_context(kb_docs, topic=topic, general_faq=general_faq)

    return {
        "found": True,
        "kb_docs": kb_docs,
        "topic": topic,
        "general_faq": general_faq,
        "context": context,
    }
