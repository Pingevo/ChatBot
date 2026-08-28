"""ดึง/กรองสินค้าจาก MongoDB live เพื่อใช้เป็น context ส่งให้ LLM.

ออกแบบตามแนว RAG: กรองเฉพาะสินค้าที่น่าจะเกี่ยวข้องกับคำถามลูกค้าก่อน
แล้วจึงส่ง context ย่อเข้า LLM เพื่อประหยัด token และตอบได้แม่นยำขึ้น.
"""

from __future__ import annotations

import os
import sys
import re
from pathlib import Path
from typing import Any, Iterable

from bson import ObjectId  # type: ignore
from pymongo import MongoClient
from pymongo.errors import PyMongoError

# fuzzy matching สำหรับจับคำพิมพ์ผิด (เช่น "โทสับ" → "โทรศัพท์")
# ใช้ rapidfuzz + pythainlp word_tokenize
try:
    from rapidfuzz import fuzz, process
    from pythainlp.tokenize import word_tokenize
    _FUZZY_AVAILABLE = True
except ImportError:
    _FUZZY_AVAILABLE = False


# ---- vector store (embeddings) ------------------------------------------------
#
# โหลด product embeddings จากไฟล์ .npz ที่สร้างโดย scripts/build_embeddings.py
# ใช้สำหรับ semantic search (similarity ระหว่างคำถามลูกค้ากับสินค้า)
# โหลด lazy ครั้งเดียวตอนใช้งาน แล้ว cache ไว้ตลอด session

_VECTOR_STORE: dict[str, Any] | None = None
_EMBEDDINGS_PATH = Path(__file__).resolve().parent.parent.parent / "exports" / "product_embeddings.npz"


def _load_vector_store() -> dict[str, Any] | None:
    """โหลด product embeddings จาก .npz (lazy singleton).

    คืน dict ที่มี:
    - item_ids: numpy array ของ item_id (str)
    - embeddings: numpy array shape (n, 1024) normalize แล้ว
    - texts: numpy array ของ text ที่ embed

    ถ้าไฟล์ไม่มี หรือ numpy ไม่ได้ติดตั้ง คืน None.
    """
    global _VECTOR_STORE
    if _VECTOR_STORE is not None:
        return _VECTOR_STORE
    if not _EMBEDDINGS_PATH.exists():
        return None
    try:
        import numpy as np
        data = np.load(_EMBEDDINGS_PATH, allow_pickle=True)
        _VECTOR_STORE = {
            "item_ids": data["item_ids"],
            "embeddings": data["embeddings"],  # shape (n, 1024) float32
            "texts": data["texts"],
        }
        return _VECTOR_STORE
    except Exception as exc:
        print(f"WARN: cannot load vector store: {exc}")
        return None


def vector_search(
    query: str,
    top_k: int = 30,
    item_status: str | None = "NORMAL",
) -> list[str]:
    """ค้นสินค้าที่ใกล้เคียงกับ query ด้วย cosine similarity.

    คืน list ของ item_id (str) ที่เรียงตามความใกล้เคียงจากมากไปน้อย.
    ถ้า vector store ไม่พร้อม คืน list ว่าง.

    Args:
        query: คำถามลูกค้า
        top_k: จำนวนสินค้าที่จะคืน
        item_status: (deprecated, กรองใน fetch_products แทน)

    คืน list ของ (item_id_str, similarity_score) เรียงจาก score สูงไปต่ำ.
    """
    vs = _load_vector_store()
    if vs is None:
        return []

    try:
        import numpy as np
        from chatbot.shopeechat.embedding import embed_query
    except ImportError:
        return []

    # embed คำถาม
    q_vec = embed_query(query)  # shape (1024,)

    # คำนวณ cosine similarity (dot product เพราะ normalize แล้ว)
    sims = vs["embeddings"] @ q_vec  # shape (n,)

    # เรียงลำดับ
    top_idx = np.argsort(sims)[::-1][:top_k]

    # คืน list ของ (item_id, similarity_score) เพื่อให้ fetch_products ใช้ re-rank ได้
    result = [(str(vs["item_ids"][i]), float(sims[i])) for i in top_idx]
    return result


# ---- connection ---------------------------------------------------------------

def build_connection_string() -> str:
    """สร้าง mongodb URI จาก env vars.

    ถ้าตั้ง MONGO_URI ไว้จะใช้ค่านั้นโดยตรง (override ค่าอื่นทั้งหมด).
    """
    uri = os.environ.get("MONGO_URI", "").strip()
    if uri:
        return uri

    host = os.environ.get("MONGO_HOST", "").strip()
    if not host:
        raise SystemExit("ERROR: กรุณาตั้ง MONGO_URI หรือ MONGO_HOST ใน .env")

    user = os.environ.get("MONGO_USERNAME", "").strip()
    password = os.environ.get("MONGO_PASSWORD", "").strip()
    auth_source = os.environ.get("MONGO_AUTH_SOURCE", "admin").strip() or "admin"
    use_tls = os.environ.get("MONGO_TLS", "false").strip().lower() == "true"

    if user and password:
        creds = f"{user}:{password}@"
    elif user:
        creds = f"{user}@"
    else:
        creds = ""

    if "://" in host:
        return host

    scheme = "mongodb+srv" if host.endswith(".mongodb.net") else "mongodb"
    uri = f"{scheme}://{creds}{host}/?authSource={auth_source}"
    if use_tls:
        uri += "&tls=true"
    return uri


_cached_client: MongoClient | None = None

def get_client() -> MongoClient:
    global _cached_client
    if _cached_client is not None:
        try:
            _cached_client.admin.command("ping")
            return _cached_client
        except Exception:
            _cached_client = None
    uri = build_connection_string()
    try:
        client = MongoClient(uri, serverSelectionTimeoutMS=10000)
        client.admin.command("ping")
        _cached_client = client
        return client
    except PyMongoError as exc:
        raise SystemExit(f"ERROR: ไม่สามารถเชื่อมต่อ MongoDB ได้: {exc}")


# ---- serialization ------------------------------------------------------------

def _to_serializable(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    import datetime
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [_to_serializable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_serializable(v) for k, v in value.items()}
    return value


# ---- product shape ------------------------------------------------------------
#
# เลือกเฉพาะฟิลด์ที่จำเป็นต่อการตอบลูกค้า เพื่อลดขนาด context ที่ส่งเข้า LLM
# (ฟิลด์ดิบมี ~90 ฟิลด์ ส่วนใหญ่เป็น metadata ระบบ ไม่ใช่ข้อมูลที่ลูกค้าสนใจ)

PRODUCT_PROJECTION = {
    "_id": 0,
    "item_id": 1,
    "item_name": 1,
    "item_status": 1,
    "brand.original_brand_name": 1,
    "cat_name": 1,
    "category_id": 1,
    "shopname": 1,
    "condition": 1,
    "description": 1,
    "weight": 1,
    "dimension": 1,
    "short_link": 1,
    "image.image_id_list": 1,
    "tier_variation": 1,
    "model": 1,
    "attribute_list": 1,
    "logistic_info": 1,
    "pre_order": 1,
    "promotion": 1,
    "has_promotion": 1,
    "is_flash_sale": 1,
    # ฟิลด์สำหรับ re-rank (เรียงสินค้าตามโปรโมชั่น/ความใหม่)
    "create_time": 1,
    "update_time_unix": 1,
}


def _warranty_info(doc: dict) -> dict:
    """ดึงข้อมูลรับประกันจาก attribute_list (Warranty Type / Warranty Duration).

    ลำดับความสำคัญ:
    1. attribute_list (Warranty Type / Warranty Duration) — แอดมินดูแล, ละเอียดที่สุด
    2. สกัดจาก item_name ด้วย warranty.extract_warranty_from_name
       (รองรับ pattern ใหม่ที่พบในข้อมูลจริง: "-2Y", "-15M", "-12M", "- 1Y",
        "ประกันศูนย์ไทย 1Y", "ประกัน 2 ปี")
    3. fallback เดิม: pattern "X Year/Month Warranty" (อังกฤษ)
    """
    info: dict[str, str] = {}
    for attr in doc.get("attribute_list") or []:
        name = (attr.get("original_attribute_name") or "").strip()
        vals = [v.get("original_value_name", "") for v in attr.get("attribute_value_list") or []]
        if not vals:
            continue
        low = name.lower()
        if "warranty type" in low or "รับประกัน" in name:
            info["type"] = ", ".join(v for v in vals if v)
        elif "warranty duration" in low or "ระยะเวลารับประกัน" in name:
            info["duration"] = ", ".join(v for v in vals if v)

    # fallback 1: สกัด warranty จาก item_name ด้วย warranty module (รองรับ pattern ใหม่)
    if not info.get("duration"):
        from . import warranty as _warranty_mod
        item_name = doc.get("item_name") or ""
        w = _warranty_mod.extract_warranty_from_name(item_name)
        if w:
            info["duration"] = w["text"]
            info["duration_months"] = str(w["months"])
            info["duration_source"] = "item_name"  # บอก LLM ว่าดึงจากชื่อ ไม่ใช่ attribute
            # สกัด type ด้วยถ้ามีคำว่า "ศูนย์ไทย" ใกล้คำว่า "ประกัน"
            import re as _re
            m2 = _re.search(r"ประกัน(\S+?)\s*\d+", item_name)
            if m2 and "type" not in info:
                info["type"] = m2.group(1).strip()

    # fallback 2: pattern "X Year/Month Warranty" (อังกฤษ) — สำรอง
    if not info.get("duration"):
        import re as _re
        item_name = doc.get("item_name") or ""
        if _re.search(r"\d+\s*(year|month)s?\s*warranty", item_name, _re.IGNORECASE):
            m3 = _re.search(r"(\d+)\s*(year|month)s?\s*warranty", item_name, _re.IGNORECASE)
            if m3:
                info["duration"] = f"{m3.group(1)} {m3.group(2)}"
                info["duration_source"] = "item_name_en"

    # ถ้ามี duration แล้ว แต่ยังไม่มี duration_months → คำนวณจาก duration text
    # เช่น "24 Months" → 24, "1 Year" → 12, "2 ปี" → 24, "15 เดือน" → 15
    if info.get("duration") and not info.get("duration_months"):
        import re as _re
        dur = info["duration"]
        m = _re.search(r"(\d+)\s*(year|month|ปี|เดือน)", dur, _re.IGNORECASE)
        if m:
            val = int(m.group(1))
            unit = m.group(2).lower()
            if unit in ("year", "ปี"):
                info["duration_months"] = str(val * 12)
            else:
                info["duration_months"] = str(val)

    return info


def _price_range(doc: dict) -> dict:
    """ราคาต่ำสุด/สูงสุดจาก model[].price_info (THB)."""
    prices: list[int] = []
    for m in doc.get("model") or []:
        for p in m.get("price_info") or []:
            cp = p.get("current_price")
            if isinstance(cp, (int, float)):
                prices.append(int(cp))
    if not prices:
        return {}
    return {"min": min(prices), "max": max(prices), "currency": "THB"}


def _first_image_url(doc: dict) -> str:
    ids = (doc.get("image") or {}).get("image_id_list") or []
    if not ids:
        return ""
    return f"https://cf.shopee.co.th/file/{ids[0]}"


def _clean_description(desc: str, message: str = "") -> str:
    """กรอง description ของ Shopee ตามคำถาม — เอาเฉพาะส่วนที่เกี่ยวข้อง.

    แบ่ง description เป็น sections แล้วเลือกส่งเฉพาะส่วนที่ลูกค้าถาม:
    - ถามรับประกัน/เคลม → เงื่อนไขรับประกัน + นโยบายคืน
    - ถามสเปก/รายละเอียด/จอ/กล้อง/แบต → สเปกเครื่อง
    - ถามการจัดส่ง/เวลาทำการ → เงื่อนไขจัดส่ง + บริการแชท
    - ถามทั่วไป (ราคา/มีไหม) → ไม่ส่ง description เลย (คืน "")

    กรองออกเสมอ: โค้ดโปรโมชั่นที่หมดอายุ
    จำกัด 3000 ตัวอักษร
    """
    if not desc:
        return ""

    msg_lower = (message or "").lower()

    # แมปคำถาม → sections ที่เกี่ยวข้อง
    warranty_kw = ("รับประกัน", "ประกัน", "เคลม", "warranty", "claim",
                   "ศูนย์", "ซ่อม", "เปลี่ยน", "รับคืน", "คืนสินค้า")
    spec_kw = ("สเปก", "spec", "specification", "รายละเอียด", "detail",
               "ข้อมูลสินค้า", "จอ", "กล้อง", "แบตเตอรี่", "cpu", "ram", "rom",
               "ความจุ", "หน่วยความจำ", "ระบบปฏิบัติการ", "เชื่อมต่อ", "เครือข่าย",
               "สี", "ขนาด", "น้ำหนัก", "อุปกรณ์ในกล่อง", "ในกล่อง", "box",
               "ข้อมูลตัวเครื่อง", "มัลติมีเดีย", "เซ็นเซอร์",
               "เปรียบเทียบ", " vs ", "เทียบ", "compare", "เทียบกับ",
               "ของแถม", "แถม", "gift", "free", "โปรโมชัน", "promotion",
               "อุปกรณ์", "accessories", "ฟรี", "คู่มือ", "แท่นชาร์จ", "สายชาร์จ")
    shipping_kw = ("จัดส่ง", "ส่งสินค้า", "เวลาทำการ", "บริการแชท",
                   "shipping", "delivery", "เปิดทำการ", "ตัดรอบ")

    want_warranty = any(kw in msg_lower for kw in warranty_kw)
    want_spec = any(kw in msg_lower for kw in spec_kw)
    want_shipping = any(kw in msg_lower for kw in shipping_kw)

    # ถ้าเป็นคำถามเกี่ยวกับสินค้า (มี product keyword ใดๆ) → ส่ง spec เสมอ
    # เพราะลูกค้าถาม "สายชาร์จ 65w" หรือ "หัวชาร์จ 100w" ก็ต้องเห็นสเปก
    # จะได้ตอบได้ว่าสินค้าไหนรองรับ 65w/100w บ้าง
    product_kw = (
        "สายชาร์จ", "หัวชาร์จ", "ชุดชาร์จ", "แท่นชาร์จ", "พาวเวอร์แบงค์", "แบตเตอรี่สำรอง",
        "หูฟัง", "earbuds", "tws", "สมาร์ทวอช", "smartwatch", "นาฬิกา",
        "โทรศัพท์", "phone", "สมาร์ทโฟน", "เคส", "ฟิล์ม", "ลำโพง",
        "cable", "charger", "adapter", "powerbank", "power bank",
        "iphone", "samsung", "xiaomi", "huawei", "oppo", "vivo", "realme",
        "cuktech", "anker", "baseus", "ugreen", "romoss",
        "65w", "100w", "120w", "240w", "w ", "pd", "qc",
        "usb-c", "type-c", "usb a", "lightning", "micro usb",
        "ใช้กับ", "รองรับ", "สำหรับ", "compatible",
        # app/compatibility questions — ต้องเห็น description เพื่อบอกชื่อแอพ
        "แอพ", "แอป", "app", "ต่อมือถือ", "เชื่อมต่อมือถือ",
    )
    want_product = any(kw in msg_lower for kw in product_kw)
    if want_product:
        want_spec = True

    # ถาม "รับประกันกี่ปี" → ข้อมูลอยู่ใน warranty field ของ product card อยู่แล้ว
    # ไม่ต้องส่งเงื่อนไขรับประกันเบื้องต้น (warranty section) เพราะ LLM ตอบจาก field ได้
    # ส่ง warranty section เฉพาะเมื่อถามเรื่องเคลม/ซ่อม/เปลี่ยน เท่านั้น
    warranty_claim_kw = ("เคลม", "claim", "ซ่อม", "เปลี่ยน", "เสีย", "พัง", "ไม่ทำงาน", "ส่งเคลม")
    want_warranty_claim = any(kw in msg_lower for kw in warranty_claim_kw)
    if not want_warranty_claim:
        want_warranty = False  # ไม่ส่ง warranty section ถ้าไม่ใช่คำถามเคลม

    # ถ้าไม่ได้ถามอะไรเฉพาะเจาะจง → คืน "" (ประหยัด token)
    if not (want_warranty or want_spec or want_shipping):
        return ""

    # แบ่ง description เป็น sections ตาม header markers
    # แต่ละ section มี (header, content)
    section_markers = [
        # (marker, section_type)
        ("เงื่อนไขการจัดส่ง", "shipping"),
        ("โปรดอ่าน", "shipping"),  # มักมีเวลาทำการ + เงื่อนไขร้าน
        ("บริการแชท", "shipping"),
        ("เงื่อนไขการรับประกัน", "warranty"),  # เงื่อนไขรับประกันเฉพาะสินค้า
        ("เงื่อนไขรับประกัน", "warranty"),
        ("นโยบายการรับคืน", "warranty"),
        ("ข้อมูลตัวเครื่อง", "spec"),
        ("ข้อมูลเครือข่าย", "spec"),
        ("ระบบปฏิบัติการ", "spec"),
        ("ระบบเชื่อมต่อ", "spec"),
        ("ฟังก์ชั่นมัลติมีเดีย", "spec"),
        ("แบตเตอรี่", "spec"),
        ("Specification", "spec"),
        ("SPECIFICATION", "spec"),
        ("สเปก", "spec"),
        ("● สมาร์ทโฟน", "spec"),
        ("● จอแสดงผล", "spec"),
        ("● ระบบปฏิบัติการ", "spec"),
        ("● หน่วยประมวลผล", "spec"),
        ("● กล้อง", "spec"),
        ("● แบตเตอรี่", "spec"),
        ("● ระบบเชื่อมต่อ", "spec"),
        # English spec headers (เช่น Xiaomi 12 Pro)
        ("Performance", "spec"),
        ("Camera", "spec"),
        ("Display", "spec"),
        ("Battery", "spec"),
        ("Connectivity", "spec"),
        ("Memory", "spec"),
        ("Storage", "spec"),
        ("Processor", "spec"),
        ("Design", "spec"),
        ("Audio", "spec"),
        ("Network", "spec"),
        ("Sensors", "spec"),
        ("Box Contents", "spec"),
        ("In the box", "spec"),
    ]

    # หาตำแหน่งทั้งหมดของแต่ละ marker
    positions = []
    for marker, sec_type in section_markers:
        idx = desc.find(marker)
        if idx != -1:
            positions.append((idx, marker, sec_type))
    positions.sort(key=lambda x: x[0])

    # ถ้าไม่เจอ section ใดเลย → คืน desc เต็ม (จำกัด 3000)
    if not positions:
        return desc[:3000]

    # สร้าง sections: แต่ละ section เริ่มที่ marker ปัจจุบัน จบที่ marker ถัดไป
    sections: list[tuple[str, str]] = []  # (section_type, content)
    for i, (idx, marker, sec_type) in enumerate(positions):
        end = positions[i + 1][0] if i + 1 < len(positions) else len(desc)
        content = desc[idx:end]
        sections.append((sec_type, content))

    # ส่วนก่อน marker แรก — มักเป็นโค้ดโปรโมชั่น ข้ามไป

    # เลือก sections ตามคำถาม
    wanted_types: set[str] = set()
    if want_warranty:
        wanted_types.add("warranty")
        # warranty มักอยู่ใน "โปรดอ่าน" ด้วย (เงื่อนไขเคลม)
        wanted_types.add("shipping")  # เพราะ "โปรดอ่าน" มีทั้งเวลา + เงื่อนไขรับประกัน
    if want_spec:
        wanted_types.add("spec")
    if want_shipping:
        wanted_types.add("shipping")

    # รวม sections ที่ต้องการ (ถอดซ้ำตามตำแหน่ง)
    seen_starts: set[int] = set()
    parts: list[str] = []
    for sec_type, content in sections:
        if sec_type not in wanted_types:
            continue
        # ใช้เนื้อหาเป็น key ถอดซ้ำ
        if content in seen_starts:
            continue
        seen_starts.add(content)
        parts.append(content)

    result = "\n".join(parts)

    # fallback: ถ้า want_spec แต่ไม่เจอ spec section เลย → คืน desc เต็ม (จำกัด 3000)
    # เพราะบางสินค้าใช้ format ที่ไม่ตรง marker ใดเลย
    if not result and want_spec:
        return desc[:3000]

    # กรองบรรทัดโค้ดโปรโมชั่นที่ค้างอยู่
    lines = result.split("\n")
    promo_patterns = [
        "ใช้โค้ด", "โค้ดสำหรับลูกค้าใหม่", "โค้ดลูกค้าใหม่",
        "ลดเพิ่ม", "ลดทันที", "ลดเพิ่มอีก",
        "NEWTHAI", "GADJUN", "9EE7R46Z",
        "โค้ดมีจำนวนจำกัด",
    ]
    cleaned_lines = [ln for ln in lines
                     if not any(p in ln.strip() for p in promo_patterns)]
    result = "\n".join(cleaned_lines)

    # กรองบรรทัดว่างติดๆ กัน
    while "\n\n\n" in result:
        result = result.replace("\n\n\n", "\n\n")

    return result[:3000]


def to_product_card(doc: dict, message: str = "") -> dict:
    """ย่อสินค้า 1 รายการเป็น 'card' ขนาดเล็กใช้เป็น context ส่ง LLM.

    Args:
        doc: MongoDB document
        message: คำถามลูกค้า (ใช้กรอง description ตาม intent)
    """
    doc = _to_serializable(doc)
    brand = (doc.get("brand") or {}).get("original_brand_name", "")
    price = _price_range(doc)
    # คำนวณ total stock จาก stock_info_v2 ของทุก model
    total_stock = 0
    for m in (doc.get("model") or []):
        si = m.get("stock_info_v2") or {}
        summary = si.get("summary_info") or {}
        total_stock += summary.get("total_available_stock", 0) or 0
    return {
        "item_id": doc.get("item_id"),
        "name": doc.get("item_name"),
        "brand": brand,
        "category": doc.get("cat_name"),
        "shop": doc.get("shopname"),
        "status": doc.get("item_status"),
        "condition": doc.get("condition"),
        "price": price,
        "warranty": _warranty_info(doc),
        "short_link": doc.get("short_link"),
        "image_url": _first_image_url(doc),
        "weight": doc.get("weight"),
        "dimension": doc.get("dimension"),
        "total_stock": total_stock,
        "sold_out": total_stock == 0,
        # ข้อมูลโปรโมชั่น (ใช้ตอน re-rank และให้ LLM บอกลูกค้าได้)
        "has_promotion": _has_active_promotion(doc),
        "is_flash_sale": bool(doc.get("is_flash_sale")),
        # description กรองตามคำถาม — เก็บเฉพาะส่วนที่เกี่ยวข้อง (สเปก/รับประกัน/จัดส่ง)
        # จำกัด 3000 ตัวอักษร ประหยัด token
        "description_excerpt": _clean_description(doc.get("description") or "", message),
        "variants": [
            {
                "name": m.get("model_name"),
                "tier_index": m.get("tier_index"),
                "price": (m.get("price_info") or [{}])[0].get("current_price") if m.get("price_info") else None,
            }
            for m in (doc.get("model") or [])[:20]
        ],
        "tier_variation": [
            {"name": tv.get("name"), "options": [o.get("option") for o in tv.get("option_list") or []]}
            for tv in (doc.get("tier_variation") or [])
        ],
    }


def _is_sold_out(doc: dict) -> bool:
    """ตรวจว่าสินค้า sold out (stock=0 ทุก model) หรือไม่.

    ใช้กรองสินค้าที่ item_status=NORMAL แต่ Shopee ขึ้น sold out แล้ว
    (เพราะ stock_info_v2.summary_info.total_available_stock = 0)
    """
    for m in (doc.get("model") or []):
        si = m.get("stock_info_v2") or {}
        summary = si.get("summary_info") or {}
        if (summary.get("total_available_stock", 0) or 0) > 0:
            return False
    # ถ้าไม่มี model เลย หรือทุก model stock=0 → sold out
    return bool(doc.get("model"))


# ---- filtering ----------------------------------------------------------------

# คำเกี่ยวกับรับประกัน/เคลม ใช้จับคำถามลูกค้า
WARRANTY_KEYWORDS = (
    "รับประกัน", "ประกัน", "เคลม", "การรับประกัน", "warranty", "claim",
    "ศูนย์ไทย", "ศูนย์", "ซ่อม", "เปลี่ยน",
)

# คำเกี่ยวกับเปรียบเทียบ
COMPARE_KEYWORDS = (
    "เปรียบเทียบ", "เทียบ", "compare", "ต่างกัน", "ดีกว่า", "สูงกว่า", "ถูกกว่า", "แพงกว่า",
)

# คำเกี่ยวกับแนะนำ
RECOMMEND_KEYWORDS = (
    "แนะนำ", "แนะนำสินค้า", "recommend", "อยากได้", "หาสินค้า", "มีอะไรดี", "เลือกยังไง",
)


def _detect_intent(message: str) -> set[str]:
    """พยากรณ์ intent คร่าวๆ จากคำถาม (ใช้กรองสินค้าเบื้องต้น)."""
    msg = message.lower()
    intents: set[str] = set()
    if any(k in message.lower() for k in WARRANTY_KEYWORDS):
        intents.add("warranty")
    if any(k in message.lower() for k in COMPARE_KEYWORDS):
        intents.add("compare")
    if any(k in message.lower() for k in RECOMMEND_KEYWORDS):
        intents.add("recommend")
    return intents


def _extract_price_range(message: str) -> tuple[int | None, int | None]:
    """ดึงช่วงราคา เช่น '1000-3000', 'ไม่เกิน 2000', 'งบ 5000', 'ใบ้กว่า 5000'."""
    msg = message.lower().replace(",", "")
    # รูปแบบ a-b (เช่น 5000-10000, 3000–8000)
    m = re.search(r"(\d{3,6})\s*[-–]\s*(\d{3,6})", msg)
    if m:
        return int(m.group(1)), int(m.group(2))
    # ไม่เกิน / ภายใน / under / max / งบไม่เกิน
    m = re.search(r"(?:ไม่เกิน|ภายใน|under|max(?:imum)?)\s*(\d{3,6})", msg)
    if m:
        return None, int(m.group(1))
    # เริ่มต้น / ตั้งแต่ / from / ขึ้นไป / ใบ้กว่า / มากกว่า / over
    m = re.search(r"(?:เริ่มต้น|ตั้งแต่|from|เริ่ม|ขึ้นไป|ใบ้กว่า|มากกว่า|over|above)\s*(\d{3,6})", msg)
    if m:
        return int(m.group(1)), None
    # งบ + ตัวเลข (เช่น "งบ 5000", "งบประมาณ 5000")
    m = re.search(r"งบ(?:ประมาณ)?\s*(\d{3,6})", msg)
    if m:
        return None, int(m.group(1))
    # ตัวเลข + บาท (เช่น "2000 บาท", "ราคา 2000 บาท") → ถือว่าเป็นงบสูงสุด
    m = re.search(r"(?:ราคา|price)?\s*(\d{3,6})\s*บาท", msg)
    if m:
        return None, int(m.group(1))
    return None, None


# ร้านในเครือทั้งหมด (จากข้อมูล 32 ร้าน) — ใช้จับชื่อร้านในคำถามลูกค้า
KNOWN_SHOPS: tuple[str, ...] = (
    "ThaiSuperPhone", "YoupinOfficialStore", "XiaomiEcoSystem", "SuperITMall",
    "KingGadgets", "LuckyHomeMart", "ZMIThailand", "QKZOfficialStore",
    "CukTechThailand", "IMILabThailand", "ThaiSuperCam", "Ztec", "BlackShark",
    "iSuper", "GodungIT", "MibroThailandOfficial", "LydstoThailand",
    "KospetThailand", "LeravanOfficialStore", "Yaber", "IceShoppingMall",
    "KieslectThailand", "YunmaiThailand", "BinnifaOfficialStore", "MiLiThailand",
    "QCYThailand", "TicWatchThailand", "LagenioThailand", "FreetieThailand",
    "BearThailandOfficial", "XiaoVVThailand", "70MaiOfficialStore",
)


def _detect_shops(message: str) -> list[str]:
    # strip วรรคทั้งหมดก่อนเทียบ เพราะลูกค้าอาจพิมพ์ "xiaomi ecosystem"
    # ในขณะที่ชื่อร้านใน DB คือ "XiaomiEcoSystem" (ไม่มีวรรค)
    msg_norm = re.sub(r"\s+", "", message).lower()
    found: list[str] = []
    for shop in KNOWN_SHOPS:
        if re.sub(r"\s+", "", shop).lower() in msg_norm:
            found.append(shop)
    return found


# แบรนด์ที่พบบ่อย (ใช้จับชื่อแบรนด์ในคำถาม) — ขยายได้
KNOWN_BRANDS: tuple[str, ...] = (
    "Xiaomi", "ZMI", "CukTech", "IMILAB", "Deerma", "Ztec", "Isuper", "iSuper",
    "OPPO", "Realme", "Black Shark", "BlackShark", "QKZ", "Leravan", "Eloop",
    "Lydsto", "Mibro", "kospet", "Kospet", "1More", "70Mai", "QCY", "Yaber",
    "Kieslect", "Yunmai", "Binnifa", "MiLi", "TicWatch", "Lagenio", "Freetie",
    "Bear", "XiaoVV", "Samsung", "Apple", "iPhone", "Huawei", "Vivo", "Nokia",
)


def _detect_brands(message: str) -> list[str]:
    found: list[str] = []
    low = message.lower()
    for b in KNOWN_BRANDS:
        if b.lower() in low:
            found.append(b)
    return found


# หมวดหมู่ที่ใช้ในระบบ (cat_name)
KNOWN_CATEGORIES: tuple[str, ...] = (
    "Mobile & Gadgets", "Home Appliances", "Audio", "Computers & Accessories",
    "Cameras & Drones", "Home & Living", "Health", "Beauty", "Sports & Outdoors",
    "Pets", "Watches", "Automobiles",
)

# คำไทยที่ลูกค้าอาจใช้เรียกหมวดหมู่
CATEGORY_ALIASES: dict[str, str] = {
    "โทรศัพท์": "Mobile & Gadgets",
    "มือถือ": "Mobile & Gadgets",
    "phone": "Mobile & Gadgets",
    "แท็บเล็ต": "Mobile & Gadgets",
    "tablet": "Mobile & Gadgets",
    "เครื่องใช้ไฟฟ้า": "Home Appliances",
    "เครื่องใช้ในบ้าน": "Home Appliances",
    "เครื่องเสียง": "Audio",
    "หูฟัง": "Audio",
    "earphone": "Audio",
    "earbuds": "Audio",
    "ลำโพง": "Audio",
    "speaker": "Audio",
    "คอม": "Computers & Accessories",
    "laptop": "Computers & Accessories",
    "โน้ตบุ๊ก": "Computers & Accessories",
    "กล้อง": "Cameras & Drones",
    "camera": "Cameras & Drones",
    "วงจรปิด": "Cameras & Drones",
    "cctv": "Cameras & Drones",
    "สุขภาพ": "Health",
    "health": "Health",
    "ความงาม": "Beauty",
    "กีฬา": "Sports & Outdoors",
    "นาฬิกา": "Watches",
    "watch": "Watches",
    "รถยนต์": "Automobiles",
    "รถ": "Automobiles",
    "สัตว์เลี้ยง": "Pets",
}


def _detect_categories(message: str) -> list[str]:
    found: list[str] = []
    low = message.lower()
    for cat in KNOWN_CATEGORIES:
        if cat.lower() in low:
            found.append(cat)
    for alias, cat in CATEGORY_ALIASES.items():
        if alias.lower() in low and cat not in found:
            found.append(cat)
    return found


# ---- product type -------------------------------------------------------------
#
# cat_name ของ Shopee กว้างเกินไป เช่น "Mobile & Gadgets" ครอบทั้งโทรศัพท์
# สมาร์ทวอช แบตสำรอง สายชาร์จ เคส ฯลฯ เวลาลูกค้าถาม "มีโทรศัพท์ไหม" ต้องกรอง
# ระดับ product type บน item_name ด้วย ไม่ใช่แค่ cat_name
#
# แต่ละ type มี:
# - user_keywords: คำที่ลูกค้าอาจพิมพ์ (ใช้ตรวจ intent)
# - name_regex:    regex ใช้ match ใน item_name (Mongo $regex + re.search)
#                 ออกแบบให้ตรงชื่อสินค้าจริง เช่น "redmi note 12" ไม่ตรับแค่ "phone"
#
# ลำดับมีผลต่อ score (ด้านล่าง) แต่ไม่มีผลต่อการ detect เพราะเป็น set

PRODUCT_TYPES: tuple[tuple[str, tuple[str, ...], str], ...] = (
    # โทรศัพท์ — ใช้คำว่า smartphone/สมาร์ทโฟน/โทรศัพท์มือถือ เป็น signal หลัก
    # บวก model pattern ที่เฉพาะรุ่นโทรศัพท์ (redmi 10, redmi note 11, xiaomi 12, mi 10t)
    # ไม่ใช้แค่ชื่อแบรนด์ เพราะ "redmi" ก็มี Redmi Watch/Buds/Book, "mi" ก็มี Mi Band/TV/Pad
    # \d+(?![wW]) กันจับ "Mi 20W" (charger) เพราะ W = watt
    # ไม่ match ถ้ามีคำว่า ขาตั้ง/tripod/เคส/ฟิล์ม/สายคล้อง ข้างหน้า (เป็นอุปกรณ์เสริม ไม่ใช่โทรศัพท์)
    ("phone",
     ("โทรศัพท์", "มือถือ", "phone", "smartphone", "สมาร์ทโฟน", "มือ ถือ",
      "โทรศัพท์มือถือ", "โทสับ", "โทสัพท์", "โทสัพ", "มือถุบ", "มือถุ"),
     # negative lookahead กว้างขวาง: ตัด accessories ที่อ้างถึงโทรศัพท์ (สายชาร์จ/หัวชาร์จ/เคส/ฟิล์ม/ไมค์/pouch/SD card/ฯลฯ)
     r"(?!(?:ขาตั้ง|tripod|เคส|ฟิล์ม|สายคล้อง|ไม้เซลฟี่|แฟลช|flash\s*drive"
     r"|ชาร์จ|charger|adapter|สายชาร์จ|หัวชาร์จ|สาย\s*c\s*to\s*c|สาย\s*type\s*c"
     r"|สาย\s*usb|cable|จั้มสตาร์ท|จั้ม|ซองกันน้ำ|pouch|กระเป๋าโทรศัพท์"
     r"|สายคล้องข้อมือ|แท่นชาร์จ|charging\s*dock|wireless\s*charger"
     r"|แบตสำรอง|power\s*bank|powerbank|micro\s*sd|sd\s*card|memory\s*card"
     r"|การ์ดหน่วยความจำ|การ์ด\s*sd|cooling\s*fan|พัดลม|fan|heatsink"
     r"|ระบายความร้อน|screen\s*protector|tempered\s*glass|กระจกนิรภัย"
     r"|sim\s*card|sim\s*tray|ejector|pin\s*sim|ไมค์|ไมโครโฟน|microphone"
     r"|earphone|หูฟัง|earbuds|tws|เครื่องดูดฝุ่น|กวาดพื้น|robot\s*vacuum"
     r"|หุ่นยนต์กวาด))"
     r"(?:smart\s*phone|สมาร์ทโฟน|smarphone|โทรศัพท์มือถือ"
     r"|redmi\s+(?:note\s+)?\d|"
     r"xiaomi\s+(?:mi\s+)?(?:note\s+|lite\s+)?(?:1[0-4]|9|8)\b|"
     r"\bmi\s+(?:note\s+)?\d+(?!\d*[wW]\b)|black\s*shark\s*\d|\bpoco\b|iphone\s*\d|"
     r"galaxy\s+(?:s\d|note\s*\d|a\d|z\s*flip)|realme\s+\d|"
     r"oppo\s+(?:reno|find|a\s*\d|f\d)|vivo\s+(?:y\d|v\d|x\d)|reno\s*\d)"),
    # สมาร์ทวอช/นาฬิกาอัจฉริยะ (ไม่รวมสายนาฬิกา ซึ่งเป็นอะไหล่)
    ("smartwatch",
     ("สมาร์ทวอช", "สมาร์ทวอทช์", "สมาร์ทวอชท์", "นาฬิกาอัจฉริยะ",
      "นาฬิกา", "smartwatch", "smart watch", "mi band", "amazfit",
      "นาฬิกาข้อมือ", "นาฬิกาสปอร์ต"),
     # negative lookahead กันจับ "สายนาฬิกา" (accessory)
     r"(?!(?:สายนาฬิกา|สาย\s*นาฬิกา|strap|band\s*strap|watch\s*strap))"
     r"(?:สมาร์ทวอช(?:ทช์|ชท์)?|smart\s*watch|smartwatch|amazfit|"
     r"\bgtr\b|\bgts\b|mi\s*band\s*\d|redmi\s*watch|mibro\s*watch|"
     r"ticwatch|imilab\s*w\d|mi\s*watch|นาฬิกาสมาร์ท|"
     r"นาฬิกา(?!สาย)|\bwatch\b|tank\s*[tm]\d|kospet)"),
    # แบตสำรอง — ใช้คำว่า แบตสำรอง/แบตเตอรี่สำรอง/powerbank เป็น signal
    # ไม่ใช้ \d+mAh เพราะจับเครื่องดูดฝุ่น/พัดลม/โทรศัพท์ ที่มีแบต mAh ได้
    ("powerbank",
     ("แบตสำรอง", "พาวเวอร์แบงก์", "พาวเวอร์แบงค์", "พาวเวอร์แบ็งค์",
      "พาวเวอร์ แบงก์", "พาวเวอร์ แบงค์",
      "พาวเวอร์แบง", "พาวเวอร์แบงก", "พาวเวอร์แบงค",
      "พาวแบงก์", "พาวแบงค์",
      "พอร์เวอร์แบงค์", "พอร์เวอร์แบงก์",
      "powerbank", "power bank", "แบตเตอรี่สำรอง"),
     r"(?:แบตสำรอง|แบตเตอรี่สำรอง|"
     r"พาวเวอร์แบ็งค์|พาวเวอร์แบงค์|พาวเวอร์แบงก์|"
     r"พาวเวอร์\s*แบงค์|พาวเวอร์\s*แบงก์|"
     r"พาวเวอร์แบง(?:ค์|ก์|ค|ก)?|"
     r"พาวแบงค์|พาวแบงก์|"
     r"พอร์เวอร์แบงค์|พอร์เวอร์แบงก์|"
     r"power\s*bank|powerbank|\bpb\b\s*\d)"),
    # หัวชาร์จ/สายชาร์จ/adapter/ชุดชาร์จ
    ("charger",
     ("หัวชาร์จ", "สายชาร์จ", "สายชาร์ต", "ชุดชาร์จ", "ชุดชาร์ต",
      "charger", "cable", "คาเบิล",
      "adapter", "แอ็ดอปเตอร์", "สาย type-c", "สาย type c", "สาย micro",
      "สาย usb", "gan", "แท่นชาร์จ", "wireless charger",
      "สายไนลอน", "สายถัก", "สายซิลิโคน", "สาย c", "สาย pd",
      "สายชาร์จไนลอน", "สายชาร์จถัก", "สายชาร์จซิลิโคน",
      # ⚡ Lightning ลอยๆ (ลูกค้าถามแค่ "ไลนิ่ง" ไม่มี "สาย" นำหน้า)
      "lightning", "ไลนิ่ง", "ไลนิง",
      # ⚡ connector variants ลอยๆ (c to lightning, a to lightning ไม่มี "สาย" นำหน้า)
      "c to lightning", "a to lightning", "usb-c to lightning", "usb-a to lightning",
      "type c to lightning", "type-c to lightning",
      "c to l", "a to l",
      ),
     r"(?:หัวชาร์จ|สายชาร์จ|สายชาร์ต|ชุดชาร์จ|ชุดชาร์ต|"
     r"charger|\bcable\b|คาเบิล|"
     r"adapter|แอ็ดอปเตอร์|type[\s-]*c|micro\s*usb|usb[-\s]*a|"
     r"\bgan\b|\bqc\s*3|pd\s*fast|แท่นชาร์จ|wireless\s*charger|"
     r"สายไนลอน|สายถัก|สายซิลิโคน|สายชาร์จไนลอน|สายชาร์จถัก|สายชาร์จซิลิโคน|"
     r"\blightning\b|ไลนิ่ง|ไลนิง|"
     r"\bc\s*to\s*l(?:ightning)?\b|\ba\s*to\s*l(?:ightning)?\b|"
     r"usb[-\s]*[ca]\s*to\s*lightning|type[\s-]*c\s*to\s*lightning)"),
    # เคส/cover
    ("case",
     ("เคส", "case", "cover", "สายคล้อง", "เคสโทรศัพท์"),
     r"(?:เคส|\bcase\b|\bcover\b|สายคล้อง|flip\s*case)"),
    # หูฟัง/earbuds
    ("earphone",
     ("หูฟัง", "earphone", "earbuds", "หูฟังบลูทูธ", "airpods", "headphone"),
     r"(?:หูฟัง|earphone|earbuds|airpods|headphone|หูฟังบลูทูธ|"
     r"pods\s*pro|airbuds)"),
    # ลำโพง
    ("speaker",
     ("ลำโพง", "speaker", "บลูทูธลำโพง"),
     r"(?:ลำโพง|\bspeaker\b|bluetooth\s*speaker)"),
    # memory card
    ("memory_card",
     ("sd card", "microsd", "เมมโมรี่การ์ด", "memory card", "การ์ดหน่วยความจำ"),
     r"(?:microsd|sd\s*card|เมมโมรี่การ์ด|memory\s*card|sdhc|sdxc)"),
    # ฟิล์ม/screen protector
    ("screen_protector",
     ("ฟิล์ม", "screen protector", "tempered glass", "ฟิล์มกระจก"),
     r"(?:screen\s*protector|tempered\s*glass|ฟิล์มกระจก|ฟิล์ม\s*จอ)"),
    # พัดลมพกพา
    ("fan",
     ("พัดลม", "fan"),
     r"(?:พัดลม|\bfan\b)"),
    # ไม้เซลฟี่
    ("selfie_stick",
     ("ไม้เซลฟี่", "selfie stick", "ไม้เซลฟี"),
     r"(?:ไม้เซลฟี่|ไม้เซลฟี|selfie\s*stick)"),
    # pocket wifi / mobile router
    ("mobile_wifi",
     ("pocket wifi", "mobile wifi", "4g lte", "ตัวปล่อยwifi", "ตัวปล่อย wifi"),
     r"(?:pocket\s*wi-?fi|mobile\s*wi-?fi|4g\s*lte\s*mobile|ตัวปล่อย\s*wi-?fi)"),
    # กล้องวงจรปิด/กล้อง CCTV/กล้องติดรถยนต์
    ("camera",
     ("กล้องวงจรปิด", "cctv", "กล้อง", "camera", "dashcam", "dash cam",
      "กล้องติดรถยนต์", "กล้องนอกบ้าน", "กล้องในบ้าน", "กล้องดูแลเด็ก",
      "imilab ec", "xiaovv"),
     r"(?:กล้องวงจรปิด|cctv|กล้อง(?:ติดรถ|นอกบ้าน|ในบ้าน|ดูแลเด็ก)?|"
     r"dash\s*cam|imilab\s*ec\d|xiaovv\s*[a-z]\d)"),
    # โปรเจคเตอร์
    ("projector",
     ("โปรเจคเตอร์", "projector", "โปรเจกเตอร์", "โปรเจคเตอร"),
     r"(?:โปรเจคเตอร์|โปรเจกเตอร์|โปรเจคเตอร|projector)"),
    # เครื่องดูดฝุ่น
    ("vacuum",
     ("เครื่องดูดฝุ่น", "vacuum", "ดูดฝุ่น", "robot vacuum", "หุ่นยนต์กวาด",
      "เครื่องดูด", "เครื่องกวาด"),
     r"(?:เครื่องดูดฝุ่น|ดูดฝุ่น|vacuum|robot\s*vacuum|หุ่นยนต์กวาด|เครื่องดูด|เครื่องกวาด)"),
    # เครื่องนวด/หมอนนวด
    ("massager",
     ("เครื่องนวด", "นวด", "massage", "หมอนนวด", "หมอนรองคอ", "เครื่องนวดคอ",
      "เข็มขัดนวด", "แผ่นนวด"),
     r"(?:เครื่องนวด|หมอนนวด|หมอนรองคอ|เครื่องนวดคอ|เข็มขัดนวด|แผ่นนวด|massage)"),
    # ลำโพงซาวด์บาร์
    ("soundbar",
     ("ซาวด์บาร์", "soundbar", "sound bar", "ลำโพงซาวด์บาร์"),
     r"(?:ซาวด์บาร์|sound\s*bar|soundbar|ลำโพงซาวด์บาร์)"),
    # เครื่องชั่งน้ำหนัก
    ("scale",
     ("เครื่องชั่ง", "ชั่งน้ำหนัก", "smart scale", "เครื่องชั่งน้ำหนัก",
      "body scale", "เครื่องชั่งอัจฉริยะ"),
     r"(?:เครื่องชั่ง|ชั่งน้ำหนัก|smart\s*scale|body\s*scale|เครื่องชั่งอัจฉริยะ)"),
    # GPS tracker
    ("gps_tracker",
     ("gps tracker", "gps ติดตาม", "ติดตาม gps", "mitag", "micard", "mi tag", "mi card"),
     r"(?:gps\s*tracker|ติดตาม\s*gps|mitag|micard|mi\s*tag|mi\s*card)"),
    # อินเวอร์เตอร์/แปลงไฟ
    ("inverter",
     ("อินเวอร์เตอร์", "inverter", "แปลงไฟ", "อินเวอร์เตอร์แปลงไฟ"),
     r"(?:อินเวอร์เตอร์|inverter|แปลงไฟ)"),
    # ไมโครโฟน/ไมค์
    ("microphone",
     ("ไมโครโฟน", "microphone", "ไมค์", "ไมค์คาราโอเกะ", "karaoke mic"),
     r"(?:ไมโครโฟน|microphone|ไมค์|karaoke\s*mic)"),
    # แฟลชไดร์ฟ/USB flash
    ("flash_drive",
     ("แฟลชไดร์ฟ", "flash drive", "usb flash", "thumb drive", "แฟลช",
      "flashdrive"),
     r"(?:แฟลชไดร์ฟ|flash\s*drive|usb\s*flash|thumb\s*drive|flashdrive)"),
    # ไส้กรองอากาศ/Filter
    ("air_filter",
     ("ไส้กรอง", "filter", "ไส้กรองอากาศ", "air purifier filter", "hepa filter",
      "ไส้กรอง hepa"),
     r"(?:ไส้กรอง|filter|ไส้กรองอากาศ|air\s*purifier\s*filter|hepa\s*filter|ไส้กรอง\s*hepa)"),
    # เครื่องปั้มลม/อุปกรณ์รถยนต์
    ("car_accessory",
     ("air compressor", "ปั้มลม", "เครื่องปั้มลม", "70mai", "ทราคเจอร์",
      "อุปกรณ์รถยนต์"),
     r"(?:air\s*compressor|ปั้มลม|เครื่องปั้มลม|70mai|ทราคเจอร์|อุปกรณ์รถยนต์)"),
    # ── Power & Charging sub-types ที่เพิ่มจาก CSV schema ──
    # หัวชาร์จในรถ — แยกจาก charger เพราะลูกค้าอาจถามเฉพาะ
    ("car_charger",
     ("หัวชาร์จในรถ", "หัวชาร์จรถ", "car charger", "car charger",
      "ชาร์จในรถ", "ชาร์จรถ", "ที่ชาร์จในรถ", "ที่ชาร์จรถ",
      "cigarette lighter", "ชาร์จบุหรี่"),
     r"(?:car\s*charger|หัวชาร์จในรถ|หัวชาร์จรถ|ชาร์จในรถ|ชาร์จรถ|"
     r"ที่ชาร์จในรถ|ที่ชาร์จรถ|cigarette\s*lighter|ชาร์จบุหรี่)"),
    # แท่นชาร์จไร้สาย / wireless charger
    ("wireless_charger",
     ("แท่นชาร์จไร้สาย", "ชาร์จไร้สาย", "wireless charger",
      "ชาร์จไม่มีสาย", "qi charger", "magSafe", "แม็กเซฟ"),
     r"(?:wireless\s*charger|แท่นชาร์จไร้สาย|ชาร์จไร้สาย|"
     r"ชาร์จไม่มีสาย|qi\s*charger|magsafe|แม็กเซฟ)"),
    # แท่นชาร์จตั้งโต๊ะ / desktop charger
    ("desktop_charger",
     ("แท่นชาร์จตั้งโต๊ะ", "แท่นชาร์จเดสก์ท็อป", "desktop charger",
      "แท่นชาร์จหลายพอร์ต", "charging station", "ชาร์จสเตชัน"),
     r"(?:desktop\s*charger|แท่นชาร์จตั้งโต๊ะ|แท่นชาร์จเดสก์ท็อป|"
     r"แท่นชาร์จหลายพอร์ต|charging\s*station|ชาร์จ\s*สเตชัน)"),
    # ปลั๊กไฟอัจฉริยะ / smart socket
    ("smart_socket",
     ("ปลั๊กไฟอัจฉริยะ", "ปลั๊กอัจฉริยะ", "smart plug", "smart socket",
      "ปลั๊ก smart", "ปลั๊ก wifi", "ปลั๊กไฟ wifi", "tapo plug"),
     r"(?:smart\s*plug|smart\s*socket|ปลั๊กไฟอัจฉริยะ|ปลั๊กอัจฉริยะ|"
     r"ปลั๊ก\s*smart|ปลั๊ก\s*wifi|ปลั๊กไฟ\s*wifi|tapo\s*plug)"),
    # แบตเตอรี่ / battery (ไม่ใช่ powerbank — เป็นแบตเตอรี่เปล่า)
    ("battery",
     ("แบตเตอรี่", "battery", "แบตเตอรี่เปล่า", "แบต AA",
      "แบต AAA", "rechargeable battery", "แบตเตอรี่ชาร์จได้"),
     r"(?:rechargeable\s*battery|แบตเตอรี่ชาร์จได้|แบต\s*aa|แบต\s*aaa|"
     r"แบตเตอรี่เปล่า)"),
    # ── Home Appliances ที่ขาด ──
    # เครื่องฟอกอากาศ — แยกจาก air_filter (air_filter = ไส้กรอง, air_purifier = เครื่อง)
    ("air_purifier",
     ("เครื่องฟอกอากาศ", "เครื่องกรองอากาศ", "air purifier",
      "เครื่องฟอก", "ฟอกอากาศ", "เครื่องกรอง", "smartmi car air",
      "รอยด์มี่", "roidmi", "70mai purifier", "car air purifier",
      "เครื่องฟอกอากาศในรถ", "เครื่องฟอกอากาศรถยนต์"),
     r"(?:เครื่องฟอกอากาศ|เครื่องกรองอากาศ|air\s*purifier|"
     r"เครื่องฟอก|ฟอกอากาศ|เครื่องกรอง|"
     r"car\s*air\s*purifier|เครื่องฟอกอากาศในรถ|เครื่องฟอกอากาศรถยนต์|"
     r"roidmi|รอยด์มี่|70mai\s*purifier)"),
    # เครื่องทำความชื้น / humidifier
    ("humidifier",
     ("เครื่องทำความชื้น", "humidifier", "เครื่องเพิ่มความชื้น",
      "เครื่องดันความชื้น", "dehumidifier", "เครื่องลดความชื้น"),
     r"(?:เครื่องทำความชื้น|humidifier|เครื่องเพิ่มความชื้น|"
     r"dehumidifier|เครื่องลดความชื้น)"),
    # หลอดไฟอัจฉริยะ / smart lamp
    ("smart_lamp",
     ("หลอดไฟอัจฉริยะ", "หลอดไฟ smart", "smart lamp", "smart bulb",
      "หลอดไฟ wifi", "yeelight", "yeelight bulb", "tapo bulb",
      "หลอดไฟ yeelight", "โคมไฟอัจฉริยะ", "โคมไฟ uv", "sterilizer lamp",
      "germicidal lamp", "โคมฆ่าเชื้อ"),
     r"(?:หลอดไฟอัจฉริยะ|หลอดไฟ\s*smart|smart\s*lamp|smart\s*bulb|"
     r"หลอดไฟ\s*wifi|yeelight|tapo\s*bulb|"
     r"โคมไฟอัจฉริยะ|โคมไฟ\s*uv|sterilizer\s*lamp|germicidal\s*lamp|โคมฆ่าเชื้อ)"),
    # กลอนอัจฉริยะ / smart lock
    ("smart_lock",
     ("กลอนอัจฉริยะ", "กลอน smart", "smart lock", "กลอนประตู",
      "กลอน wifi", "กลอน fingerprint", "กลอนลายนิ้วมือ",
      "กลอนแตะบัตร", "door lock smart"),
     r"(?:smart\s*lock|กลอนอัจฉริยะ|กลอน\s*smart|กลอนประตู|"
     r"กลอน\s*wifi|กลอน\s*fingerprint|กลอนลายนิ้วมือ|กลอนแตะบัตร)"),
    # ถังขยะอัจฉริยะ / smart bin
    ("smart_bin",
     ("ถังขยะอัจฉริยะ", "ถังขยะ smart", "smart trash can", "smart bin",
      "ถังขยะอัตโนมัติ", "ถังขยะไร้สาย", "ninestars"),
     r"(?:smart\s*trash\s*can|smart\s*bin|ถังขยะอัจฉริยะ|ถังขยะ\s*smart|"
     r"ถังขยะอัตโนมัติ|ninestars)"),
    # เครื่องเป่าผม / hair dryer
    ("hair_dryer",
     ("เครื่องเป่าผม", "เครื่องเป่าผมไฟฟ้า", "hair dryer", "ไดร์เป่าผม",
      "ไดร์เป่า", "เป่าผม", "ที่เป่าผม", "trouver hair dryer"),
     r"(?:เครื่องเป่าผม|hair\s*dryer|ไดร์เป่าผม|ไดร์เป่า|"
     r"เป่าผม|ที่เป่าผม|trouver\s*hair)"),
    # เครื่องโกนหนวด / shaver
    ("shaver",
     ("เครื่องโกนหนวด", "เครื่องโกนหนวดไฟฟ้า", "shaver", "ปัตตาเลี่ยน",
      "ที่โกนหนวดไฟฟ้า", "razor electric", "enchen shaver",
      "mi shaver", "mijia hair clipper"),
     r"(?:เครื่องโกนหนวด|shaver|ปัตตาเลี่ยน|ที่โกนหนวดไฟฟ้า|"
     r"razor\s*electric|enchen|mijia\s*hair\s*clipper)"),
    # ที่ตัดขนจมูก / nose hair trimmer
    ("nose_trimmer",
     ("ที่ตัดขนจมูก", "ที่ตัดจมูก", "nose hair trimmer",
      "เครื่องตัดขนจมูก", "winben nose", "trimmer จมูก"),
     r"(?:nose\s*hair\s*trimmer|ที่ตัดขนจมูก|ที่ตัดจมูก|"
     r"เครื่องตัดขนจมูก|winben\s*nose|trimmer\s*จมูก)"),
    # เครื่องดูดสิว / blackhead cleaner
    ("blackhead_cleaner",
     ("เครื่องดูดสิว", "ที่ดูดสิว", "blackhead cleaner",
      "เครื่องดูดสิวเสี้ยน", "ที่กดสิว", "meishi godness",
      "meishi wisdom"),
     r"(?:เครื่องดูดสิว|ที่ดูดสิว|blackhead\s*cleaner|"
     r"เครื่องดูดสิวเสี้ยน|ที่กดสิว|meishi)"),
    # แปรงฟันไฟฟ้า / electric toothbrush
    ("toothbrush",
     ("แปรงฟันไฟฟ้า", "แปรงฟันอัจฉริยะ", "electric toothbrush",
      "smart toothbrush", "ที่แขวนแปรงฟัน", "toothbrush holder",
      "เครื่องแขวนแปรงฟัน", "dr meng toothbrush"),
     r"(?:แปรงฟันไฟฟ้า|แปรงฟันอัจฉริยะ|electric\s*toothbrush|"
     r"smart\s*toothbrush|toothbrush\s*holder|เครื่องแขวนแปรงฟัน|dr\s*meng)"),
    # เครื่องกรองน้ำ / water purifier
    ("water_purifier",
     ("เครื่องกรองน้ำ", "เครื่องกรองน้ำดื่ม", "water purifier",
      "เครื่องผลิตน้ำดื่ม", "water dispenser", "เครื่องจ่ายน้ำ",
      "petoneer water", "pet water fountain", "น้ำพุแมว",
      "เครื่องให้น้ำสัตว์", "pet water dispenser"),
     r"(?:water\s*purifier|เครื่องกรองน้ำ|เครื่องผลิตน้ำดื่ม|"
     r"water\s*dispenser|เครื่องจ่ายน้ำ|pet\s*water\s*fountain|น้ำพุแมว|"
     r"pet\s*water\s*dispenser|petoneer\s*water)"),
    # เครื่องให้อาหารสัตว์อัตโนมัติ / pet feeder
    ("pet_feeder",
     ("เครื่องให้อาหารสัตว์", "เครื่องให้อาหารแมว", "เครื่องให้อาหารหมา",
      "pet feeder", "automatic feeder", "เครื่องให้อาหารอัตโนมัติ",
      "petoneer nutri", "petkit feeder", "cat litter box",
      "ห้องน้ำแมว", "ตู้อุปกรณ์เลี้ยงสัตว์"),
     r"(?:pet\s*feeder|เครื่องให้อาหารสัตว์|เครื่องให้อาหารแมว|"
     r"เครื่องให้อาหารหมา|automatic\s*feeder|เครื่องให้อาหารอัตโนมัติ|"
     r"petoneer\s*nutri|petkit\s*feeder|cat\s*litter\s*box|ห้องน้ำแมว)"),
    # ตู้ปลา / fish tank
    ("fish_tank",
     ("ตู้ปลา", "ตู้ปลาอัจฉริยะ", "fish tank", "aquarium",
      "ตู้ปลาพลาสติก", "huafajihe"),
     r"(?:fish\s*tank|ตู้ปลา|aquarium|huafajihe)"),
    # จักรยานออกกำลังกาย / exercise bike
    ("exercise_bike",
     ("จักรยานออกกำลังกาย", "จักรยาน exercise", "exercise bike",
      "yesoul", "smart bike", "จักรยาน smart"),
     r"(?:exercise\s*bike|จักรยานออกกำลังกาย|yesoul|smart\s*bike)"),
    # ลู่เดิน / walking pad
    ("walking_pad",
     ("ลู่เดิน", "ลู่วิ่ง", "walking pad", "walkingpad",
      "treadmill", "kingsmith", "ลู่เดินออกกำลังกาย", "ลู่วิ่งไฟฟ้า"),
     r"(?:walking\s*pad|walkingpad|treadmill|ลู่เดิน|ลู่วิ่ง|"
     r"kingsmith|ลู่เดินออกกำลังกาย|ลู่วิ่งไฟฟ้า)"),
    # สเก็ตบอร์ด / surfskate
    ("skateboard",
     ("สเก็ตบอร์ด", "สเก็ตบอร์ด", "skateboard", "surfskate",
      "เซิร์ฟสเก็ต", "boils dragon", "longboard"),
     r"(?:skateboard|สเก็ตบอร์ด|surfskate|เซิร์ฟสเก็ต|boils\s*dragon|longboard)"),
    # รถเข็นเด็ก / stroller
    ("stroller",
     ("รถเข็นเด็ก", "รถเข็นทารก", "stroller", "baby stroller",
      "รถเข็นเด็กน้อย", "ที่นั่งรถเข็น"),
     r"(?:stroller|รถเข็นเด็ก|รถเข็นทารก|baby\s*stroller)"),
    # เครื่องปั้มลมยางพกพา / air pump (แยกจาก car_accessory เพราะมีหลายแบบ)
    ("air_pump",
     ("เครื่องปั้มลมยาง", "ปั้มลมยาง", "ปั้มลมพกพา", "air pump",
      "electric air pump", "mojietu air pump", "mijia air pump",
      "เครื่องปั้มลมไฟฟ้า", "ปั้มลม 70mai"),
     r"(?:air\s*pump|เครื่องปั้มลมยาง|ปั้มลมยาง|ปั้มลมพกพา|"
     r"electric\s*air\s*pump|mojietu|mijia\s*air\s*pump|"
     r"เครื่องปั้มลมไฟฟ้า|ปั้มลม\s*70mai)"),
    # กล้องติดรถยนต์ / dashcam
    ("dashcam",
     ("กล้องติดรถยนต์", "กล้องติดรถ", "dashcam", "dash cam",
      "yi dash", "70mai dash", "car dvr", "กล้อง dashboard"),
     r"(?:dash\s*cam|dashcam|กล้องติดรถยนต์|กล้องติดรถ|"
     r"yi\s*dash|70mai\s*dash|car\s*dvr|กล้อง\s*dashboard)"),
    # เครื่องวัดแอลกอฮอล์ / alcohol tester
    ("alcohol_tester",
     ("เครื่องวัดแอลกอฮอล์", "เครื่องเป่าแอลกอฮอล์", "alcohol tester",
      "breathalyzer", "เครื่องวัดหายใจ"),
     r"(?:alcohol\s*tester|breathalyzer|เครื่องวัดแอลกอฮอล์|"
     r"เครื่องเป่าแอลกอฮอล์|เครื่องวัดหายใจ)"),
    # คีย์บอร์ด / keyboard
    ("keyboard",
     ("คีย์บอร์ด", "keyboard", "คีย์บอร์ดไร้สาย", "wireless keyboard",
      "mechanical keyboard", "คีย์บอร์ดเกมมิ่ง", "gaming keyboard"),
     r"(?:คีย์บอร์ด|keyboard|wireless\s*keyboard|mechanical\s*keyboard|"
     r"gaming\s*keyboard)"),
    # เมาส์ / mouse
    ("mouse",
     ("เมาส์", "mouse", "เมาส์ไร้สาย", "wireless mouse",
      "เมาส์เกมมิ่ง", "gaming mouse", "logitech mouse"),
     r"(?:เมาส์|mouse|wireless\s*mouse|gaming\s*mouse|logitech\s*mouse)"),
    # แรม / RAM
    ("ram",
     ("แรม", "ram", "memory ram", "dram", "ddr4", "ddr5",
      "ram laptop", "ram pc", "ความจำแรม"),
     r"(?:\bram\b|memory\s*ram|dram|ddr[45]|ram\s*laptop|ram\s*pc|ความจำแรม)"),
    # แอสเอสดี / SSD
    ("ssd",
     ("ssd", "solid state drive", "แอสเอสดี", "hard disk ssd",
      "nvme", "m.2 ssd", "sata ssd"),
     r"(?:\bssd\b|solid\s*state\s*drive|แอสเอสดี|nvme|m\.2\s*ssd|sata\s*ssd)"),
    # หม้อทอดไร้น้ำมัน / air fryer
    ("air_fryer",
     ("หม้อทอดไร้น้ำมัน", "หม้อทอด", "air fryer", "เครื่องทอด",
      "หม้อทอดอากาศ", "airfryer"),
     r"(?:air\s*fryer|หม้อทอดไร้น้ำมัน|หม้อทอด|เครื่องทอด|"
     r"หม้อทอดอากาศ|airfryer)"),
    # เครื่องทำกาแฟ / coffee machine
    ("coffee_machine",
     ("เครื่องทำกาแฟ", "coffee machine", "เครื่องชงกาแฟ",
      "coffee maker", "เครื่องกาแฟ", "nespresso", "dolce gusto"),
     r"(?:coffee\s*machine|เครื่องทำกาแฟ|เครื่องชงกาแฟ|"
     r"coffee\s*maker|เครื่องกาแฟ|nespresso|dolce\s*gusto)"),
    # กาต้มน้ำไฟฟ้า / kettle
    ("kettle",
     ("กาต้มน้ำไฟฟ้า", "กาต้มน้ำ", "kettle", "electric kettle",
      "เตาต้มน้ำ", "เครื่องต้มน้ำ"),
     r"(?:kettle|กาต้มน้ำไฟฟ้า|กาต้มน้ำ|electric\s*kettle|"
     r"เตาต้มน้ำ|เครื่องต้มน้ำ)"),
    # เตาอบ / oven
    ("oven",
     ("เตาอบ", "oven", "เตาอบไฟฟ้า", "electric oven",
      "microwave", "ไมโครเวฟ", "เตาอบไมโครเวฟ", "เตาอบขนม"),
     r"(?:oven|เตาอบ|electric\s*oven|microwave|ไมโครเวฟ|เตาอบไมโครเวฟ|เตาอบขนม)"),
    # เครื่องปิ้งย่าง / BBQ grill
    ("grill",
     ("เครื่องปิ้งย่าง", "เตาปิ้งย่าง", "grill", "bbq",
      "เตาย่าง", "เครื่องย่าง", "barbecue"),
     r"(?:grill|เครื่องปิ้งย่าง|เตาปิ้งย่าง|bbq|เตาย่าง|เครื่องย่าง|barbecue)"),
    # เครื่องอบผ้า / cloth dryer
    ("cloth_dryer",
     ("เครื่องอบผ้า", "เครื่องอบของ", "cloth dryer", "cloth dryer",
      "เครื่องอบ", "ที่อบผ้า", "shoe dryer", "เครื่องอบรองเท้า",
      "towel dryer", "เครื่องอบผ้าขนหนู"),
     r"(?:cloth\s*dryer|เครื่องอบผ้า|เครื่องอบของ|เครื่องอบ|"
     r"ที่อบผ้า|shoe\s*dryer|เครื่องอบรองเท้า|towel\s*dryer|เครื่องอบผ้าขนหนู)"),
    # เตารีดไอน้ำ / garment steamer
    ("garment_steamer",
     ("เตารีดไอน้ำ", "เตารีด", "garment steamer", "steam iron",
      "เครื่องอัดไอน้ำ", "ที่รีดผ้า", "เตารีดไอ"),
     r"(?:garment\s*steamer|เตารีดไอน้ำ|เตารีด|steam\s*iron|"
     r"เครื่องอัดไอน้ำ|ที่รีดผ้า|เตารีดไอ)"),
    # ไม้ถูพื้น / spray mop
    ("spray_mop",
     ("ไม้ถูพื้น", "ไม้กวาด", "spray mop", "mop", "ไม้ถู",
      "deerma mop", "ไม้ถูพื้น spray", "ผ้าถูพื้น"),
     r"(?:spray\s*mop|ไม้ถูพื้น|ไม้กวาด|ไม้ถู|deerma\s*mop|ผ้าถูพื้น)"),
    # เครื่องดูดฝุ่นโซฟา / sofa cleaner
    ("sofa_cleaner",
     ("เครื่องดูดฝุ่นโซฟา", "เครื่องดูดฝุ่นที่นอน", "sofa cleaner",
      "เครื่องดูดฝุ่นของ", "bed vacuum", "เครื่องดูดฝุ่นเตียง",
      "mijia bed vacuum"),
     r"(?:sofa\s*cleaner|เครื่องดูดฝุ่นโซฟา|เครื่องดูดฝุ่นที่นอน|"
     r"เครื่องดูดฝุ่นของ|bed\s*vacuum|เครื่องดูดฝุ่นเตียง|mijia\s*bed)"),
    # เครื่องกระตุ้นสำหรับออกกำลังกาย / EMS massager (แยกจาก massager)
    ("ems_massager",
     ("เครื่องกระตุ้นกล้ามเนื้อ", "ems massager", "ems",
      "แผ่นกระตุ้นกล้ามเนื้อ", "แผ่นนวด ems", "leravan ems",
      "lejia pulse", "เครื่องนวด ems"),
     r"(?:ems\s*massager|เครื่องกระตุ้นกล้ามเนื้อ|แผ่นกระตุ้นกล้ามเนื้อ|"
     r"แผ่นนวด\s*ems|leravan\s*ems|lejia\s*pulse|เครื่องนวด\s*ems)"),
    # ที่นั่งรถยนต์ / car seat
    ("car_seat",
     ("ที่นั่งรถยนต์", "เบาะรถยนต์", "car seat", "เบาะนั่งรถ",
      "ที่นั่งรถเด็ก", "baby car seat"),
     r"(?:car\s*seat|ที่นั่งรถยนต์|เบาะรถยนต์|เบาะนั่งรถ|"
     r"ที่นั่งรถเด็ก|baby\s*car\s*seat)"),
    # กระจกแต่งหน้า / makeup mirror
    ("makeup_mirror",
     ("กระจกแต่งหน้า", "กระจก led", "makeup mirror",
      "vanity mirror", "กระจกแต่งหน้า led", "jordan judy mirror"),
     r"(?:makeup\s*mirror|vanity\s*mirror|กระจกแต่งหน้า|กระจก\s*led|"
     r"กระจกแต่งหน้า\s*led|jordan\s*judy\s*mirror)"),
    # เครื่องเป่าผมขนาดเล็ก / mini razor
    ("mini_razor",
     ("เครื่องโกนหนวดพกพา", "mini razor", "winben mini razor",
      "ที่โกนหนวดพกพา", "ปัตตาเลี่ยนพกพา"),
     r"(?:mini\s*razor|เครื่องโกนหนวดพกพา|winben\s*mini|"
     r"ที่โกนหนวดพกพา|ปัตตาเลี่ยนพกพา)"),
)


def _detect_product_types(message: str) -> set[str]:
    """ตรวจว่าลูกค้าอ้างถึง product type ใดบ้าง (เพื่อกรอง item_name แบบละเอียด).

    ตรวจ 2 ขั้น:
    1. exact match กับ user_kws (เช่น "โทรศัพท์", "มือถือ", "phone")
    2. ถ้าไม่ match ในขั้น 1 ให้ลอง regex (เช่น "redmi 8a" match phone regex)
       เพื่อจับกรณีลูกค้าพิมพ์แค่ชื่อรุ่นโดยไม่ระบุประเภท

    กรณีพิเศษ: compatibility question
    - "สายชาร์จที่ใช้กับ iphone" → สินค้าคือ charger ไม่ใช่ phone
    - "พาวเวอร์แบงค์ใช้กับ mi 17" → สินค้าคือ powerbank ไม่ใช่ phone
    - ถ้ามี non-phone type + "ใช้กับ/รองรับ" + phone brand → ลบ phone ออก
    """
    low = message.lower()
    found: set[str] = set()
    for type_name, user_kws, _regex in PRODUCT_TYPES:
        if any(kw in low for kw in user_kws):
            found.add(type_name)
        elif _regex and re.search(_regex, low):
            found.add(type_name)

    # ── compatibility question: ลบ phone เมื่อมี "ใช้กับ/รองรับ" ──
    # เช่น "สายชาร์จที่ใช้กับ iphone 17" → ลบ phone เหลือ charger
    # เช่น "พาวเวอร์แบงค์ใช้กับ mi 17 ultra" → ลบ phone เหลือ powerbank
    # เช่น "cuktech ctc612w 6a 240w ใช้กับ iphone 16 pro" → ลบ phone (เป็น compat question)
    if "phone" in found:
        _compat_kws = ("ใช้กับ", "รองรับ", "เชื่อมต่อ", "สำหรับ", "สำหรับใช้กับ")
        if any(kw in low for kw in _compat_kws):
            # phone เป็นแค่ compatibility target ไม่ใช่สินค้าที่ลูกค้าต้องการ
            found.discard("phone")

    # ── Charger model prefix/wattage detection ──
    # ถ้า message มี charger model prefix (CTC, CTL, ATC, CMC, AD, ZA, HA, AL)
    # หรือ wattage pattern (6a 240w, 5a 100w, 65w, 45w, 30w, 20w)
    # → เป็น charger type (สายหรือหัวชาร์จ)
    if "charger" not in found:
        _charger_model_prefixes = (
            r"\bctc\b", r"\bctl\b", r"\batc\b", r"\bcmc\b",  # สายชาร์จ CUKTECH
            r"\bad\d", r"\bza\d", r"\bha\d", r"\bal\d",      # หัวชาร์จ ZTEC/ZMI
            r"\bac\d", r"\ba18", r"\ba15",                    # หัวชาร์จ CUKTECH
        )
        _wattage_patterns = (
            r"\b\d+a\s*\d+w\b",  # 6a 240w
            r"\b\d+w\b",         # 65w, 45w, 30w
            r"\bgan\d?\b",       # gan, gan3
        )
        if any(re.search(p, low) for p in _charger_model_prefixes) or \
           any(re.search(p, low) for p in _wattage_patterns):
            found.add("charger")

    return found


# ── Charger subtype detection ──
# สายชาร์จ = cable only, หัวชาร์จ = adapter/head only, ชุดชาร์จ = set (head + cable)
_CHARGER_SUBTYPES = {
    "cable": ("สายชาร์จ", "สายชาร์ต", "cable", "คาเบิล",
              "สาย type-c", "สาย type c", "สาย micro", "สาย usb",
              "สาย c to c", "สาย lightning", "สาย usb-c",
              "สาย c to lightning", "สาย usb to c",
              "สายไนลอน", "สายถัก", "สายซิลิโคน", "สาย c", "สาย pd",
              "สายชาร์จไนลอน", "สายชาร์จถัก", "สายชาร์จซิลิโคน",
              # ⚡ Lightning ลอยๆ (ลูกค้าถามแค่ "ไลนิ่ง"/"lightning" ไม่มี "สาย" นำหน้า)
              "lightning", "ไลนิ่ง", "ไลนิง",
              # ⚡ connector variants ลอยๆ (c to lightning, a to lightning ไม่มี "สาย" นำหน้า)
              "c to lightning", "a to lightning",
              "usb-c to lightning", "usb-a to lightning",
              "type c to lightning", "type-c to lightning",
              "c to l", "a to l",
              ),
    "adapter": ("หัวชาร์จ", "หัวชาร์ต", "adapter", "แอ็ดอปเตอร์",
                "gan", "หัว adapter", "หัวชาร์จ gan", "qc 3", "pd fast",
                "หัวชาร์จ 65w", "หัวชาร์จ 20w", "หัวชาร์จ 30w",
                "หัวชาร์จ 100w", "หัวชาร์จ 120w", "หัวชาร์จ 140w",
                "หัวชาร์จ 240w", "หัวชาร์จ 300w"),
    "set": ("ชุดชาร์จ", "ชุดชาร์ต", "ชุดหัวชาร์จ", "ชุดสายชาร์จ",
            "ชุด adapter", "set ชาร์จ", "ชาร์จ set", "ชุดอุปกรณ์ชาร์จ",
            "set หัวชาร์จ", "set adapter", "พร้อมสาย"),
    "car_charger": ("หัวชาร์จในรถ", "หัวชาร์จรถ", "car charger",
                    "ชาร์จในรถ", "ชาร์จรถ", "ที่ชาร์จในรถ", "ที่ชาร์จรถ",
                    "cigarette lighter", "ชาร์จบุหรี่"),
    "wireless": ("แท่นชาร์จไร้สาย", "ชาร์จไร้สาย", "wireless charger",
                 "ชาร์จไม่มีสาย", "qi charger", "magSafe", "แม็กเซฟ",
                 "magnetic charger", "ชาร์จแม่เหล็ก"),
    "desktop": ("แท่นชาร์จตั้งโต๊ะ", "แท่นชาร์จเดสก์ท็อป", "desktop charger",
                "แท่นชาร์จหลายพอร์ต", "charging station", "ชาร์จสเตชัน",
                "แท่นชาร์จ desktop"),
    "socket": ("ปลั๊กไฟอัจฉริยะ", "ปลั๊กอัจฉริยะ", "smart plug", "smart socket",
               "ปลั๊ก smart", "ปลั๊ก wifi", "ปลั๊กไฟ wifi"),
}


def _detect_charger_subtype(message: str) -> str | None:
    """ตรวจ charger subtype: cable / adapter / set / None.

    ถ้าลูกค้าเรียก "สายชาร์จ" → cable
    ถ้าลูกค้าเรียก "หัวชาร์จ" → adapter
    ถ้าลูกค้าเรียก "ชุดชาร์จ" → set
    ถ้าเรียก "ชาร์จ" ทั่วไป → None (ไม่กรอง subtype)

    ถ้า message มีทั้ง "หัวชาร์จ" และ "สายชาร์จ" → เช็คว่าอันไหนเป็นประธาน
    เช่น "หาหัวชาร์จ ที่ใช้กับสายชาร์จรุ่นนี้" → adapter (หัวชาร์จเป็นประธาน)
    เช่น "เอาแค่สายชาร์จ ผมมีหัวชาร์จแล้ว" → cable (สายชาร์จเป็นประธาน)

    รองรับคำพิมพ์ผิด เช่น "สายชาาร์จ" (า เกิน), "สายชาร์จจ" (จ เกิน)
    """
    low = message.lower()
    # แก้คำพิมพ์ผิดที่พบบ่อยก่อนเช็ค keyword
    # "สายชาาร์จ" → "สายชาร์จ", "หัวชาาร์จ" → "หัวชาร์จ"
    # "สายชาร์จจ" → "สายชาร์จ", "หัวชาร์จจ" → "หัวชาร์จ"
    # "สายชารต" → "สายชาร์ต", "หัวชารต" → "หัวชาร์ต"
    _typo_fixes = [
        ("สายชาาร์จ", "สายชาร์จ"), ("หัวชาาร์จ", "หัวชาร์จ"),
        ("สายชาร์จจ", "สายชาร์จ"), ("หัวชาร์จจ", "หัวชาร์จ"),
        ("สายชารต", "สายชาร์ต"), ("หัวชารต", "หัวชาร์ต"),
        ("สายชาต", "สายชาร์ต"), ("หัวชาต", "หัวชาร์ต"),
        ("สายชารจ", "สายชาร์จ"), ("หัวชารจ", "หัวชาร์จ"),
        ("หัวชาจ", "หัวชาร์จ"),  # พิมพ์ตก ร์
        ("หัวชาจะ", "หัวชาร์จ"),  # พิมพ์ตก ร์ + ะ
        ("หัวชาร", "หัวชาร์จ"),  # พิมพ์ตก ์จ
        ("ชุดชาาร์จ", "ชุดชาร์จ"), ("ชุดชาร์จจ", "ชุดชาร์จ"),
    ]
    _low_fixed = low
    for wrong, right in _typo_fixes:
        _low_fixed = _low_fixed.replace(wrong, right)
    low = _low_fixed
    # เช็ค set ก่อน เพราะ "ชุดชาร์จ" อาจมี "ชาร์จ" อยู่ด้วย
    for sub, kws in _CHARGER_SUBTYPES.items():
        if sub in ("cable", "adapter"):
            continue  # เช็ค cable/adapter ทีหลัง เพราะต้องดู position
        if any(kw in low for kw in kws):
            return sub
    # เช็ค adapter และ cable พร้อมกัน
    adapter_kws = _CHARGER_SUBTYPES["adapter"]
    cable_kws = _CHARGER_SUBTYPES["cable"]
    # "gan" ต้องเป็น word boundary ไม่ใช่ส่วนของ "gan3"/"gan2" (ชื่อรุ่น)
    _has_adapter = any(kw in low for kw in adapter_kws if kw != "gan")
    # เช็ค "gan" เป็นคำเดี่ยวเท่านั้น (ไม่ใช่ gan3, gan2, ฯลฯ)
    if not _has_adapter and re.search(r'\bgan\b', low):
        _has_adapter = True
    _has_cable = any(kw in low for kw in cable_kws)
    # ── Compatibility constraint: "ใช้กับสาย c to c", "ใช้สาย c to c" ──
    # ถ้า message มี "ใช้กับสาย" หรือ "ใช้สาย" + cable keyword แต่ไม่มี adapter keyword
    # → ลูกค้าถามว่าหัวชาร์จที่ใช้กับสายนี้ได้ไหม (constraint) ไม่ใช่ขอซื้อสาย
    # → ไม่คืน cable subtype (ให้ subtype carry จาก history ทำงานแทน)
    _cable_compat_patterns = ("ใช้กับสาย", "ใช้สาย", "รองรับสาย", "ใช้ได้กับสาย",
                               "ใช้กับ c to c", "ใช้กับ type c", "ใช้กับ usb-c",
                               "ใช้กับสาย type", "ใช้กับสาย usb")
    _is_cable_compat = (
        not _has_adapter
        and _has_cable
        and any(p in low for p in _cable_compat_patterns)
    )
    if _is_cable_compat:
        # ไม่คืน cable — เป็น constraint ไม่ใช่ product type
        return None
    if _has_adapter and _has_cable:
        # มีทั้งคู่ → ดูว่าอันไหนเป็นประธาน
        _adapter_pos = min((low.find(kw) for kw in adapter_kws if kw in low and kw != "gan"), default=999)
        if _adapter_pos == 999 and re.search(r'\bgan\b', low):
            _adapter_pos = low.find("gan")
        _cable_pos = min((low.find(kw) for kw in cable_kws if kw in low), default=999)
        # ถ้า message มี "ผมมีหัวชาร์จแล้ว" หรือ "มีหัวแล้ว" → cable (มีหัวแล้ว เอาสาย)
        if "มีหัว" in low or "มีแล้ว" in low:
            return "cable"
        # ถ้ามี "ใช้กับ/คู่กับ/สำหรับ" ระหว่างสองคำ → อันแรกเป็นประธาน
        _between = low[_adapter_pos:_cable_pos] if _adapter_pos < _cable_pos else low[_cable_pos:_adapter_pos]
        if any(w in _between for w in ("ใช้กับ", "คู่กับ", "สำหรับ", "กับ")):
            return "adapter" if _adapter_pos < _cable_pos else "cable"
        # default: อันไหนอยู่ก่อนเป็นประธาน
        return "adapter" if _adapter_pos < _cable_pos else "cable"
    if _has_adapter:
        return "adapter"
    if _has_cable:
        return "cable"
    return None


def _filter_charger_subtype(docs: list[dict], subtype: str) -> list[dict]:
    """กรอง charger docs ตาม subtype ที่ลูกค้าถาม.

    ลำดับการตรวจ (เพื่อกันสินค้าตกหล่น):
    1. set: มี "ชุด"/"set" ในชื่อ หรือ มีทั้ง "หัวชาร์จ" และ "สายชาร์จ" ในชื่อ
    2. adapter: มี "หัวชาร์จ"/"adapter"/"gan" ในชื่อ (แม้จะมี "สาย" ด้วยก็ตาม)
    3. cable: มี "สาย" ในชื่อ และไม่มี "หัวชาร์จ"/"adapter"/"gan"

    ถ้าลูกค้าถาม "หัวชาร์จ" → เอา adapter + set (เพราะ set ก็มีหัว)
    ถ้าลูกค้าถาม "สายชาร์จ" → เอา cable + set (เพราะ set ก็มีสาย)
    ถ้าลูกค้าถาม "ชุดชาร์จ" → เอา set อย่างเดียว
    """
    if not subtype:
        return docs

    adapter_kw = ("หัวชาร์จ", "หัวชาร์ต", "adapter", "แอ็ดอปเตอร์", "gan",
                  "car charger", "หัวชาร์จในรถ")
    cable_kw = ("สายชาร์จ", "สายชาร์ต", "สาย usb", "สาย type", "สาย c to",
                "สาย micro", "สาย lightning", "cable", "คาเบิล",
                "usb-c to", "usb a to", "type-c to")
    set_kw = ("ชุดชาร์จ", "ชุดชาร์ต", "ชุดหัวชาร์จ", "ชุดสายชาร์จ", "ชุด adapter",
              "set ชาร์จ", "charging combo", "ready to go", "ชุดอุปกรณ์ชาร์จ",
              "ชุด ready", "set samsung", "set iphone", "combo",
              "premium charging set", "charge anywhere")
    # แท่นชาร์จ = desktop charger (ไม่ใช่หัวชาร์จ) ต้องแยกออก
    desktop_kw = ("แท่นชาร์จ", "desktop charger", "desktop charge")

    classified: dict[str, list[dict]] = {"cable": [], "adapter": [], "set": [], "other": []}
    for d in docs:
        name = (d.get("item_name") or "").lower()
        # แท่นชาร์จ = ไม่ใช่ adapter และไม่ใช่ set
        is_desktop = any(kw in name for kw in desktop_kw)
        # set = มี indicator ชัดเจน (ชุด/set/combo/ready to go)
        is_set = (
            any(kw in name for kw in set_kw)
            or ("ชุด" in name and ("ชาร์จ" in name or "charger" in name))
            or ("set" in name and ("ชาร์จ" in name or "charger" in name))
        )
        # adapter = มี "หัวชาร์จ"/"adapter"/"gan" ในชื่อ (ไม่ใช่แท่นชาร์จ)
        is_adapter = any(kw in name for kw in adapter_kw) and not is_desktop
        # cable = มี "สายชาร์จ"/"cable"/"สาย type" ฯลฯ ในชื่อ
        # ระวัง "ไร้สาย" (wireless) ไม่ใช่สายชาร์จ
        is_cable = any(kw in name for kw in cable_kw) or (
            "สาย" in name and not is_adapter and not is_desktop
            and "ไร้สาย" not in name and "ไร้ สาย" not in name
        )

        if is_set:
            classified["set"].append(d)
        elif is_adapter:
            classified["adapter"].append(d)
        elif is_cable:
            classified["cable"].append(d)
        else:
            classified["other"].append(d)

    # เลือกตาม subtype ที่ลูกค้าถาม
    if subtype == "cable":
        result = classified["cable"] + classified["set"]
    elif subtype == "adapter":
        result = classified["adapter"] + classified["set"]
    elif subtype == "set":
        result = classified["set"]
    else:
        result = docs

    # ถ้ากรองแล้วเหลือน้อยเกินไป ให้คืน docs เดิม (ดีกว่าไม่มีอะไรตอบ)
    # แต่ถ้าเป็น charger subtype (adapter/cable/set) ไม่ควร fallback
    # เพราะอาจส่งสินค้าผิดประเภท (เช่น แท่นชาร์จแทนหัวชาร์จ)
    if len(result) < 1 and subtype not in ("adapter", "cable", "set"):
        return docs
    return result


# ---- fuzzy product type detection (จับคำพิมพ์ผิด) ---------------------------
#
# ใช้ rapidfuzz + pythainlp word_tokenize เพื่อจับคำพิมพ์ผิด เช่น
# "โทสับ" → "โทรศัพท์", "มือถุบ" → "มือถือ", "สายชาร์ต" → "สายชาร์จ"
#
# กลไร:
# 1. word_tokenize แยก message เป็น token (ภาษาไทยไม่มีวรรคตัดคำ)
# 2. รวม token ที่อยู่ติดกันเป็น n-gram (bigram/trigram/4-gram) เพื่อจับคำที่
#    tokenize แยกผิด เช่น "โทสับ" อาจถูกแยกเป็น "โท"+"สับ" ต้องรวมกลับ
# 3. เทียบแต่ละ n-gram กับ user_keywords ของทุก product type ด้วย WRatio
# 4. ถ้า score >= threshold ให้ถือว่า match type นั้น
# 5. ถ้า match หลาย type ให้เลือก type ที่ candidate ยาวที่สุด (specific สุด)
#    เพื่อกัน false positive เช่น "สมาร์ทวอช" ไม่ควร match "สมาร์ทโฟน"

_FUZZY_THRESHOLD = 55.0  # WRatio score ขั้นต่ำที่ถือว่า match

# stopword ที่ตัดออกก่อน fuzzy match (เป็นคำถาม/คำเชื่อม ไม่ใช่สินค้า)
# ถ้าไม่ตัด "ไหม" จะ match "ไม้เซลฟี่" ได้, "มี" จะ match "มือถือ" ได้ ฯลฯ
_FUZZY_STOPWORDS: frozenset[str] = frozenset({
    "มี", "ไหม", "ไหน", "อะไร", "บ้าง", "ได้", "ไป", "และ", "หรือ", "อยาก",
    "ให้", "หน่อย", "ช่วย", "แนะ", "นำ", "หา", "ดี", "กว่า", "ที่", "อยู่",
    "ใช้", "เป็น", "เรา", "ผม", "ฉัน", "คุณ", "แอดมิน", "ร้าน", "ขอ",
    "งบ", "งบประมาณ", "ราคา", "บาท", "เงิน", "ตั้งแต่", "ขึ้นไป",
    "ไม่เกิน", "ภายใน", "ใบ้กว่า", "มากกว่า", "เริ่มต้น",
    "is", "the", "a", "an", "of", "for", "and", "or", "to", "what", "which",
    "have", "has", "any", "some", "good", "best", "recommend", "please",
    "under", "max", "min", "from", "price", "budget",
})


def _detect_product_types_fuzzy(message: str) -> set[str]:
    """ตรวจ product type แบบ fuzzy (ทนต่อคำพิมพ์ผิด).

    ใช้เฉพาะตอนที่ _detect_product_types (exact match) ไม่เจอ เพื่อเป็น fallback.
    ถ้า rapidfuzz/pythainlp ไม่ได้ติดตั้ง จะคืน set() ว่าง.
    """
    if not _FUZZY_AVAILABLE:
        return set()

    # รวม user_keywords ทั้งหมดเป็น dict {keyword: type_name}
    kw_to_type: dict[str, str] = {}
    for type_name, user_kws, _regex in PRODUCT_TYPES:
        for kw in user_kws:
            kw_to_type[kw] = type_name

    # สร้าง n-gram candidates จาก message
    tokens = word_tokenize(message, engine="newmm")
    tokens = [t.strip() for t in tokens if t.strip()]
    # ตัด stopword ออก (เช่น "มี", "ไหม", "ไหน") เพราะ match ผิดได้ เช่น "ไหม" → "ไม้เซลฟี่"
    tokens = [t for t in tokens if t not in _FUZZY_STOPWORDS]
    candidates = list(tokens)
    for n in (2, 3, 4):
        for i in range(len(tokens) - n + 1):
            candidates.append("".join(tokens[i:i + n]))
    candidates = [c for c in candidates if len(c) >= 2]
    # ตัดชื่อแบรนด์ที่รู้จักออกจาก candidates เพราะเป็นชื่อเฉพาะ ไม่ใช่คำพิมพ์ผิด
    # ป้องกัน false positive เช่น "yaber" (แบรนด์โปรเจคเตอร์) ไป fuzzy match "cable" (60 คะแนน)
    # ทำให้คำถาม "yaber t1 pro มีไหม" ถูกเข้าใจผิดเป็นคำถามเรื่องสายชาร์จ
    _known_brands_lower = {b.lower() for b in KNOWN_BRANDS}
    candidates = [c for c in candidates if c.lower() not in _known_brands_lower]

    # เทียบแต่ละ candidate กับ keywords ทั้งหมด
    matches: list[tuple[str, float, int]] = []  # (type, score, candidate_len)
    for cand in candidates:
        results = process.extract(cand, list(kw_to_type.keys()),
                                  scorer=fuzz.WRatio, limit=1)
        best = results[0]
        kw = best[0]
        # ป้องกัน false positive จากความยาวต่างกันมาก:
        # - "เครื่องดูดฝุ่น" (12 ตัว) vs "เคส" (3 ตัว) = 72 แต่ไม่ใช่เคส
        # - "นวด" (3 ตัว) vs "การ์ดหน่วยความจำ" (16 ตัว) = 60 แต่ไม่ใช่การ์ด
        # - "สาย" (3 ตัว) vs "สายชาร์จ" (7 ตัว) = 90 แต่ "สาย" อาจหมายถึง สายลุย/สายด่วน ไม่ใช่สายชาร์จ
        # วิธีแก้:
        # 1. ถ้า candidate สั้นกว่า keyword มาก (ratio < 0.6) → ข้ามเลย (hard cutoff)
        #    ป้องกัน "สาย" match "สายชาร์จ" เพราะ WRatio ให้ 90 สำหรับ prefix match
        # 2. ถ้า keyword สั้น (<= 4 ตัว) → threshold สูงขึ้น (80)
        # 3. ถ้า keyword ยาวแต่ candidate สั้น → threshold สูงขึ้น (85)
        threshold = _FUZZY_THRESHOLD
        kw_len = len(kw)
        cand_len = len(cand)
        # hard cutoff: ถ้า candidate สั้นกว่า keyword มาก → ข้ามเลย
        # "สาย" (3) / "สายชาร์จ" (8) = 0.38 < 0.65 → ข้าม
        # "สายสุย" (6) / "สาย type-c" (10) = 0.60 < 0.65 → ข้าม
        # "โทสับ" (5) / "โทรศัพท์" (7) = 0.71 ≥ 0.65 → เก็บ
        if cand_len < kw_len * 0.65:
            continue
        # hard cutoff: ถ้า candidate ยาวกว่า keyword มากเกินไป → ข้ามเลย
        # ป้องกัน n-gram ที่รวมชื่อแบรนด์/รุ่นเข้าด้วยกัน (เช่น "yabert1pro" 10 ตัว)
        # ไป fuzzy match คำสั้น ๆ อย่าง "cable" (5 ตัว) โดยบังเอิญ (ratio 2.0 แต่ score ผ่าน threshold)
        if cand_len > kw_len * 1.4:
            continue
        if kw_len <= 4:
            threshold = 80.0
        elif kw_len > 8 and cand_len < kw_len * 0.5:
            # keyword ยาวแต่ candidate สั้นมาก (เช่น "นวด" vs "การ์ดหน่วยความจำ")
            threshold = 85.0
        if best[1] >= threshold:
            t = kw_to_type[kw]
            matches.append((t, float(best[1]), len(cand)))

    if not matches:
        return set()

    # เก็บ best (score, cand_len) ของแต่ละ type
    best_by_type: dict[str, tuple[float, int]] = {}
    for t, score, clen in matches:
        prev = best_by_type.get(t)
        if prev is None or (score, clen) > (prev[0], prev[1]):
            best_by_type[t] = (score, clen)

    # เลือก type ที่ดีที่สุด:
    # - ถ้า score ต่างกัน > 5: เลือก type ที่ score สูงกว่า (score เป็นหลัก)
    # - ถ้า score ใกล้กัน (<= 5): เลือก type ที่ cand_len ยาวกว่า (specific สุด)
    #   เพราะ "สมาร์ทวอบ" (ยาว 5) ใกล้ "สมาร์ทวอช" มากกว่า "สมาร์ท" (ยาว 3) ใกล้ "สมาร์ทโฟน"
    sorted_types = sorted(best_by_type.items(),
                          key=lambda x: (x[1][0], x[1][1]), reverse=True)
    best_type, (best_score, best_clen) = sorted_types[0]

    # ถ้ามี type อื่นที่ score ใกล้กัน (<= 5) แต่ cand_len ยาวกว่า ให้เลือก type นั้นแทน
    for t, (score, clen) in sorted_types[1:]:
        if score >= best_score - 5 and clen > best_clen:
            best_type, best_score, best_clen = t, score, clen

    result = {best_type}
    for t, (score, clen) in sorted_types[1:]:
        # เก็บ type อื่นถ้า score ใกล้กัน (ภายใน 3) และ cand_len ใกล้กัน (ภายใน 2)
        if t == best_type:
            continue
        if score >= best_score - 3 and clen >= best_clen - 2:
            result.add(t)

    return result


# map product type → หมวดหมู่ที่เกี่ยวข้อง (ใช้ตอน fallback เพื่อไม่ให้ค้นกว้างเกินไป)
_PRODUCT_TYPE_CATEGORIES: dict[str, tuple[str, ...]] = {
    "phone": ("Mobile & Gadgets",),
    "smartwatch": ("Mobile & Gadgets", "Watches"),
    "powerbank": ("Mobile & Gadgets", "Home Appliances"),
    "charger": ("Mobile & Gadgets", "Computers & Accessories"),
    "case": ("Mobile & Gadgets",),
    "earphone": ("Audio", "Mobile & Gadgets"),
    "speaker": ("Audio",),
    "memory_card": ("Mobile & Gadgets", "Computers & Accessories", "Cameras & Drones"),
    "screen_protector": ("Mobile & Gadgets",),
    "fan": ("Home Appliances", "Home & Living"),
    "selfie_stick": ("Mobile & Gadgets", "Cameras & Drones"),
    "mobile_wifi": ("Mobile & Gadgets", "Computers & Accessories"),
    "camera": ("Cameras & Drones", "Home Appliances", "Automobiles"),
    "projector": ("Home Appliances",),
    "vacuum": ("Home Appliances", "Home & Living"),
    "massager": ("Health", "Home & Living", "Home Appliances"),
    "soundbar": ("Audio", "Home Appliances"),
    "scale": ("Mobile & Gadgets", "Health"),
    "gps_tracker": ("Mobile & Gadgets", "Sports & Outdoors", "Travel & Luggage"),
    "inverter": ("Automobiles", "Home Appliances"),
    "microphone": ("Audio",),
    "flash_drive": ("Computers & Accessories", "Mobile & Gadgets"),
    "air_filter": ("Home Appliances", "Home & Living"),
    "car_accessory": ("Automobiles", "Mobile & Gadgets"),
    # ── Power & Charging sub-types ──
    "car_charger": ("Mobile & Gadgets", "Automobiles"),
    "wireless_charger": ("Mobile & Gadgets",),
    "desktop_charger": ("Mobile & Gadgets", "Computers & Accessories"),
    "smart_socket": ("Home Appliances", "Home & Living", "Mobile & Gadgets"),
    "battery": ("Mobile & Gadgets",),
    # ── Home Appliances ──
    "air_purifier": ("Home Appliances", "Home & Living", "Automobiles"),
    "humidifier": ("Home Appliances", "Home & Living"),
    "smart_lamp": ("Home & Living", "Home Appliances"),
    "smart_lock": ("Home & Living", "Home Appliances", "Mobile & Gadgets"),
    "smart_bin": ("Home & Living", "Home Appliances"),
    "hair_dryer": ("Beauty", "Home Appliances"),
    "shaver": ("Beauty", "Home Appliances"),
    "nose_trimmer": ("Beauty",),
    "blackhead_cleaner": ("Beauty",),
    "toothbrush": ("Beauty", "Health", "Home & Living"),
    "water_purifier": ("Home Appliances", "Home & Living", "Pets"),
    "pet_feeder": ("Pets", "Home Appliances"),
    "fish_tank": ("Pets",),
    "exercise_bike": ("Sports & Outdoors", "Home Appliances"),
    "walking_pad": ("Sports & Outdoors", "Home Appliances"),
    "skateboard": ("Sports & Outdoors",),
    "stroller": ("Mom & Baby", "Sports & Outdoors"),
    "air_pump": ("Automobiles", "Sports & Outdoors", "Mobile & Gadgets"),
    "dashcam": ("Automobiles", "Cameras & Drones"),
    "alcohol_tester": ("Automobiles",),
    "keyboard": ("Computers & Accessories",),
    "mouse": ("Computers & Accessories",),
    "ram": ("Computers & Accessories",),
    "ssd": ("Computers & Accessories",),
    "air_fryer": ("Home Appliances",),
    "coffee_machine": ("Home Appliances",),
    "kettle": ("Home Appliances",),
    "oven": ("Home Appliances",),
    "grill": ("Home Appliances",),
    "cloth_dryer": ("Home Appliances", "Home & Living"),
    "garment_steamer": ("Home Appliances", "Home & Living"),
    "spray_mop": ("Home & Living", "Home Appliances"),
    "sofa_cleaner": ("Home Appliances", "Home & Living"),
    "ems_massager": ("Health", "Sports & Outdoors"),
    "car_seat": ("Automobiles", "Mom & Baby"),
    "makeup_mirror": ("Beauty",),
    "mini_razor": ("Beauty",),
}


def _product_type_categories(types: set[str]) -> list[str]:
    """รวมหมวดหมู่ที่เกี่ยวข้องกับ product types ที่ตรวจได้."""
    cats: set[str] = set()
    for t in types:
        cats.update(_PRODUCT_TYPE_CATEGORIES.get(t, ()))
    return sorted(cats)


def _product_type_regex(types: set[str]) -> str | None:
    """รวม regex ของ product types ที่ตรวจได้ เป็น pattern เดียว ใช้กับ Mongo $regex."""
    if not types:
        return None
    parts: list[str] = []
    for type_name in types:
        for tn, _kws, regex in PRODUCT_TYPES:
            if tn == type_name:
                parts.append(regex)
                break
    return "|".join(parts) if parts else None


def build_query(
    message: str,
    shop_filter: str | None = None,
    product_types: set[str] | None = None,
) -> dict:
    """สร้าง MongoDB query จากคำถามลูกค้า.

    กลยุทธ์:
    - กรองเฉพาะสินค้า status NORMAL (ยกเว้นคำถามเรื่องเคลม/รับประกัน ที่อาจต้องเห็นสินค้าเก่าด้วย)
    - ถ้าระบุ shop_filter (จาก API) บังคับใช้
    - ถ้าคำถามบอกชื่อร้าน/แบรนด์/หมวด กรองตาม
    - ถ้าคำถามบอกช่วงราคา กรองด้วย model.price_info.current_price
    - ถ้าเป็น intent warranty ให้เน้นสินค้าที่มี attribute Warranty
    - ถ้าตรวจได้ว่าลูกค้าถาม product type เฉพาะ (เช่น โทรศัพท์/สมาร์ทวอช) ให้กรอง
      item_name ด้วย regex เพื่อไม่ให้ cat_name กว้างๆ ดึงสินค้านอกประเด็นมา
    - ถ้าไม่ตรงเงื่อนไขพิเศษ ใช้ text search บน item_name/description
    """
    intents = _detect_intent(message)
    shops = _detect_shops(message)
    brands = _detect_brands(message)
    categories = _detect_categories(message)
    price_min, price_max = _extract_price_range(message)
    if product_types is None:
        product_types = _detect_product_types(message)

    q: dict = {}
    # ดึงสินค้าทุก status (NORMAL, UNLIST, SELLER_DELETE, BANNED, ฯลฯ)
    # เพื่อให้ LLM ตอบสเปค/รายละเอียด/รับประกัน ของสินค้าย้อนหลังได้
    # LLM จะแนะนำเฉพาะ NORMAL + stock > 0 เอง (ตาม instructions)
    # (ไม่กรอง item_status ที่นี่แล้ว)

    # shopname/brand ใน DB เก็บมาจากผู้ขาย case ไม่แน่นอน (เช่น "yaber" vs "Yaber")
    # ต้อง match แบบ case-insensitive ไม่งั้น exact $in จะพลาด แม้สินค้ามีอยู่จริง
    if shop_filter:
        q["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}
    elif shops:
        q["shopname"] = {"$regex": "|".join(f"^{re.escape(s)}$" for s in shops), "$options": "i"}

    if brands:
        q["brand.original_brand_name"] = {
            "$regex": "|".join(f"^{re.escape(b)}$" for b in brands),
            "$options": "i",
        }

    if categories:
        q["cat_name"] = {"$in": categories}

    # ถ้ามี product_types ให้ใช้ cat_name จาก _PRODUCT_TYPE_CATEGORIES แทน
    # เพราะ _detect_categories อาจจับ "นาฬิกา" → "Watches" ซึ่งส่วนใหญ่เป็นสายนาฬิกา
    # แต่นาฬิกาจริงอยู่ใน "Mobile & Gadgets"
    if product_types:
        type_cats = _product_type_categories(product_types)
        if type_cats:
            # รวม categories จากทั้งสองแหล่ง
            all_cats = set(type_cats)
            if categories:
                all_cats.update(categories)
            q["cat_name"] = {"$in": list(all_cats)}

    # กรอง item_name ตาม product type ที่ลูกค้าถาม (เช่น โทรศัพท์ vs สมาร์ทวอช)
    # ใช้ Mongo $regex ที่ case-insensitive บน item_name
    type_regex = _product_type_regex(product_types)
    if type_regex:
        q["item_name"] = {"$regex": type_regex, "$options": "i"}
        # กรอง accessories ที่อาจ match ผิด (เช่น สายชาร์จที่อ้าง "iPhone 15")
        # ใช้ $nor เพื่อตัดสินค้าที่มีคำ accessories ในชื่อ
        if "phone" in product_types:
            accessory_patterns = [
                "ชาร์จ", "charger", "adapter", "สายชาร์จ", "หัวชาร์จ",
                "สาย c to c", "สาย type c", "สาย usb", "cable",
                "จั้มสตาร์ท", "ซองกันน้ำ", "pouch", "กระเป๋าโทรศัพท์",
                "แท่นชาร์จ", "charging dock", "wireless charger",
                "แบตสำรอง", "power bank", "powerbank",
                "micro sd", "sd card", "memory card", "การ์ดหน่วยความจำ", "การ์ด sd",
                "cooling fan", "พัดลม", "heatsink", "ระบายความร้อน",
                "screen protector", "tempered glass", "กระจกนิรภัย",
                "sim card", "sim tray", "ejector", "pin sim",
                "ไมค์", "ไมโครโฟน", "microphone",
                "earphone", "หูฟัง", "earbuds", "tws",
                "เครื่องดูดฝุ่น", "กวาดพื้น", "robot vacuum", "หุ่นยนต์กวาด",
                "ฟิล์ม", "เคส", "ขาตั้ง", "tripod", "สายคล้อง", "ไม้เซลฟี่",
            ]
            q["$nor"] = [
                {"item_name": {"$regex": kw, "$options": "i"}}
                for kw in accessory_patterns
            ]

    if price_min is not None or price_max is not None:
        price_cond: dict = {}
        if price_min is not None:
            price_cond["$gte"] = price_min
        if price_max is not None:
            price_cond["$lte"] = price_max
        q["model.price_info.current_price"] = price_cond

    if "warranty" in intents:
        # แยก "ชื่อสินค้า" ออกจากคำถามรับประกัน
        # เช่น "LOGITECH G PRO X รับประกันกี่ปี" → "LOGITECH G PRO X"
        # ถ้ามีชื่อสินค้า → กรอง item_name ด้วยชื่อ + มี warranty info
        # ถ้าไม่มีชื่อสินค้า (เช่น "รับประกันไหม") → ใช้ $or warranty อย่างเดียว
        from . import warranty as _warranty_mod
        model_kw = _warranty_mod.strip_warranty_keywords(message)
        if model_kw:
            # มีชื่อสินค้า → กรองด้วยชื่อสินค้า AND มี warranty info ใน attribute/desc/name
            # ใช้ $and เพราะ $or อยู่ข้างนอก และเราต้องการ (model_kw) AND (warranty_info)
            q["$and"] = [
                {"item_name": {"$regex": re.escape(model_kw), "$options": "i"}},
                {
                    "$or": [
                        {"attribute_list.original_attribute_name": {"$regex": "warranty", "$options": "i"}},
                        {"description": {"$regex": "รับประกัน|ประกัน|เคลม|warranty", "$options": "i"}},
                        {"item_name": {"$regex": "ประกัน|รับประกัน|warranty|-\\d+[yYmM]\\s*$", "$options": "i"}},
                    ]
                },
            ]
        else:
            # ไม่มีชื่อสินค้า → ใช้ $or warranty อย่างเดียว (เหมือนเดิม)
            q["$or"] = [
                {"attribute_list.original_attribute_name": {"$regex": "warranty", "$options": "i"}},
                {"description": {"$regex": "รับประกัน|ประกัน|เคลม|warranty", "$options": "i"}},
                {"item_name": {"$regex": "ประกัน|รับประกัน|warranty", "$options": "i"}},
            ]

    return q


# ---- main fetch ---------------------------------------------------------------

# คำที่ไม่ควรนับเป็น signal ตอน score (เป็น stopword ทั่วไปในคำถามไทย/อังกฤษ)
_STOPWORDS: frozenset[str] = frozenset({
    "มี", "ไหม", "ไหน", "อะไร", "บ้าง", "ได้", "ไป", "และ", "หรือ", "อยาก",
    "ได้", "ให้", "หน่อย", "ช่วย", "แนะ", "นำ", "หา", "ดี", "กว่า", "ที่",
    "is", "the", "a", "an", "of", "for", "and", "or", "to", "what", "which",
    "have", "has", "any", "some", "good", "best", "recommend",
})


def _score_card(card: dict, message: str, product_types: set[str]) -> float:
    """ให้คะแนนความเกี่ยวข้องของ product card กับคำถามลูกค้า.

    ใช้ re-rank หลัง Mongo คืน candidates เพื่อให้สินค้าที่ตรงที่สุดขึ้นมาก่อน
    (Mongo $regex กรองหยาบ แต่ natural order ไม่ได้เรียงตาม relevance).

    น้ำหนัก:
    - ตรง product type regex บน item_name: +5 (สำคัญที่สุด)
    - ตร brand ที่ลูกค้าเอ่ย:               +3
    - ตร token ระหว่าง message ↔ item_name: +1 ต่อ token
    - ตร shop ที่ลูกค้าเอ่ย:                +2
    """
    name = (card.get("name") or "").lower()
    brand = (card.get("brand") or "").lower()
    shop = (card.get("shop") or "").lower()
    msg = message.lower()

    score = 0.0

    # 1) product type regex match บน item_name (boost สูงสุด)
    for type_name in product_types:
        for tn, _kws, regex in PRODUCT_TYPES:
            if tn == type_name and re.search(regex, name):
                score += 5.0
                break

    # 2) brand match
    if brand and len(brand) >= 2 and brand in msg:
        score += 3.0

    # 3) shop match (เผื่อลูกค้าพิมพ์ชื่อร้านในข้อความ)
    if shop and len(shop) >= 3 and re.sub(r"\s+", "", shop) in re.sub(r"\s+", "", msg):
        score += 2.0

    # 4) token overlap ระหว่าง message กับ item_name (ตัด stopword ออก)
    msg_tokens = {t for t in re.findall(r"\w+", msg) if len(t) >= 2 and t not in _STOPWORDS}
    name_tokens = set(re.findall(r"\w+", name))
    overlap = msg_tokens & name_tokens
    score += len(overlap) * 1.0

    return score


# ---- re-rank by promo + latest -----------------------------------------------
#
# หลังจากกรองสินค้าที่เกี่ยวข้องด้วย similarity/regex แล้ว อาจมีสินค้าหลายสิบรายการ
# ที่เกี่ยวข้อง เราต้องเลือก limit รายการที่จะส่งให้ LLM
# ใช้เกณฑ์: สินค้ามีโปร/แฟลชเซลขึ้นก่อน แล้วตามด้วยสินค้าใหม่ล่าสุด

def _has_active_promotion(doc: dict) -> bool:
    """เช็คว่าสินค้ามีโปรโมชั่น active อยู่หรือไม่."""
    if doc.get("is_flash_sale"):
        return True
    if doc.get("has_promotion"):
        return True
    promos = doc.get("promotion") or []
    for p in promos:
        staging = (p.get("promotion_staging") or "").lower()
        if staging == "ongoing":
            return True
    return False


def _get_recency_score(doc: dict) -> float:
    """คะแนนความใหม่ของสินค้า 0.0-1.0.

    ใช้ create_time เป็นหลัก (สินค้าที่สร้างใหม่กว่า = score สูงกว่า)
    เทียบกับเวลาปัจจุบัน โดย normalize ให้อยู่ในช่วง 0-1
    โดยอ้างอิงจาก 5 ปีที่ผ่านมา (สินค้าเก่ากว่า 5 ปี = 0).
    """
    import time
    create_time = doc.get("create_time")
    if not isinstance(create_time, (int, float)):
        # ลอง update_time_unix เป็น fallback
        create_time = doc.get("update_time_unix")
    if not isinstance(create_time, (int, float)):
        return 0.0

    now = time.time()
    five_years = 5 * 365 * 24 * 3600  # ~157M seconds
    age = now - create_time
    if age <= 0:
        return 1.0  # สินค้าใหม่กว่าปัจจุบัน (ข้อมูลผิดปกติ) ให้คะแนนเต็ม
    if age >= five_years:
        return 0.0
    return 1.0 - (age / five_years)


def _is_bundle_product(doc: dict) -> bool:
    """ตรวจว่าสินค้าเป็นชุด/แพ็คคู่ (bundle) หรือไม่.

    ชุด = มี indicator ของการรวมหลายสินค้าในชื่อ:
    - "set", "combo", "ชุด", "แพ็คคู่", "ready to go", "+", "/"
    - แต่ "/" ที่เป็นตัวคั่นขนาด/สี (เช่น "iPhone 16 Pro / Pro Max") ไม่นับ

    รองรับทั้ง product document (item_name) และ product card (name).
    """
    name = (doc.get("item_name") or doc.get("name") or "").lower()
    bundle_kw = ("set", "combo", "ชุด", "แพ็คคู่", "แพ็ค คู่", "ready to go",
                 "charge anywhere", "pack", "bundle", "พร้อมสาย", "พร้อมหัวชาร์จ")
    if any(kw in name for kw in bundle_kw):
        return True
    # มี "+" หรือ " + " ในชื่อ (เช่น "AD653T + CMC610 + PB100P")
    if " + " in name or "+" in name:
        # แต่ถ้าเป็นแค่ "2 in 1" ไม่นับเป็น bundle
        if "2 in 1" in name or "2-in-1" in name or "fusion" in name:
            return False
        return True
    # มี "/" ในชื่อ (เช่น "AURA LPB100 33W / LPB200NL" หรือ "PB100P /PB200P /PB200U")
    # ถ้ามี "/" อย่างน้อย 1 ตัว และไม่ใช่ "CCC / CE" (มาตรฐาน) ให้นับเป็น bundle
    if "/" in name:
        # ตัด "CCC / CE", "CE / CCC", "USB-C / USB-A" ที่เป็นมาตรฐานออก
        _standards = ("ccc / ce", "ce / ccc", "usb-c / usb-a", "usb a / usb c")
        _name_clean = name
        for s in _standards:
            _name_clean = _name_clean.replace(s, "")
        # ถ้ายังมี "/" เหลือ แปลว่าเป็นการรวมรุ่น
        if "/" in _name_clean:
            return True
    return False


def _rerank_by_promo_latest(
    docs: list[dict],
    similarity_scores: dict[str, float] | None = None,
    limit: int = 20,
) -> list[dict]:
    """เรียงสินค้าตาม: standalone > มีโปร > ใหม่ล่าสุด > similarity สูง.

    Args:
        docs: list ของ product documents จาก Mongo
        similarity_scores: dict {item_id_str: similarity_score} ถ้ามาจาก vector search
                           ใช้เป็นเงื่อนไขตัดสินสุดท้ายกรณีที่โปรและความใหม่เท่ากัน
        limit: จำนวนสินค้าที่จะคืน

    คืน docs ที่เรียงใหม่แล้ว จำกัดจำนวนตาม limit.
    """
    if not docs:
        return []

    def sort_key(d: dict) -> tuple:
        # standalone (ไม่ใช่ชุด) ขึ้นก่อน เพื่อให้สินค้าเดี่ยวไม่ถูกชุดแซง
        is_standalone = not _is_bundle_product(d)
        has_promo = _has_active_promotion(d)
        recency = _get_recency_score(d)
        iid = str(d.get("item_id", ""))
        sim = (similarity_scores or {}).get(iid, 0.0)
        # เรียงจากมากไปน้อย: (is_standalone, has_promo, recency, sim)
        return (is_standalone, has_promo, recency, sim)

    ranked = sorted(docs, key=sort_key, reverse=True)
    return ranked[:limit]


# ---- diversity-aware re-ranking ----------------------------------------------
#
# ปัญหา: ตอนเปรียบเทียบหลายรุ่น (เช่น "เปรียบเทียบ EC4 EC5 EC6")
# re-rank ปกติเลือกสินค้าที่ score สูงสุด ทำให้รุ่นที่มีสินค้าเยอะกว่า/โปรเยอะกว่า
# ครอง context หมด รุ่นอื่นที่ถามไม่มีเข้าไปใน context เลย
#
# วิธีแก้: ตรวจจับ "model tokens" ในคำถาม แล้วรับประกันว่าแต่ละ model
# มีอย่างน้อย 1-2 ตัวใน context ส่วนที่เหลือเติมด้วยสินค้าที่ score สูงสุด

# pattern สำหรับดักจับ model tokens:
# - EC4, EC5, EC6 Pro, EC6 Dual
# - Redmi Note 11, Mi 10, Mi 11 Lite
# - iPhone 13, iPhone 14 Pro
# - Galaxy S22, Galaxy A53
# - QCY T2C, A53, S22
_MODEL_TOKEN_RE = re.compile(
    # pattern 1: จับ "EC6 Pro", "Mi 10 Lite" (รุ่น + suffix คำเต็ม) — ลองก่อน
    r"\b([A-Z]{1,6}\d{1,4})\s+(Pro|Lite|Dual|Max|Plus|Ultra|Neo|Panorama|Active|SE)\b"
    # pattern 2: จับ "EC4", "T2C", "A53", "S22" (รุ่นเต็มในตัวเอง)
    r"|\b([A-Z]{1,6}\d{1,4}[A-Z]{0,3})\b"
    # pattern 3: จับ "Note 11", "iPhone 13", "Mi 10" (คำ + เลข)
    r"|\b([A-Z]{2,8})\s+(\d{1,4})\b",
    re.IGNORECASE,
)


def _extract_model_tokens(message: str) -> list[str]:
    """ดึง model tokens จากคำถาม เช่น ['EC4', 'EC5', 'EC6'].

    ใช้สำหรับ diversity re-ranking ตอนเปรียบเทียบหลายรุ่น.
    คืน list ของ model token (uppercase) ที่พบ ถ้าไม่พบหรือเจอแค่ 1 อัน คืน [].

    ถ้าเจอหลายรุ่นที่เป็นรุ่นย่อยของ base เดียวกัน (เช่น EC6 Pro, EC6 Dual)
    จะ collapse เป็น base token (EC6) เพื่อให้ diversity ทำงานที่ระดับรุ่นหลัก.
    """
    matches = _MODEL_TOKEN_RE.findall(message)
    raw_tokens = []
    seen = set()
    for m in matches:
        # pattern มี 3 alternatives:
        # - pattern 1: (group1)(group2) เช่น EC6 + Pro → EC6PRO
        # - pattern 2: (group3) เช่น T2C, EC4, A53
        # - pattern 3: (group4)(group5) เช่น Note + 11 → NOTE11, iPhone + 13 → IPHONE13
        if m[0] and m[1]:  # pattern 1: "EC6 Pro"
            clean = (m[0] + m[1]).upper()
        elif m[2]:  # pattern 2: "T2C"
            clean = m[2].upper()
        elif m[3] and m[4]:  # pattern 3: "Note 11"
            clean = (m[3] + m[4]).upper()
        else:
            continue
        if clean and clean not in seen:
            seen.add(clean)
            raw_tokens.append(clean)

    # collapse รุ่นย่อยเป็น base token เฉพาะเมื่อมีหลายรุ่นที่ base ซ้ำกัน
    # เช่น EC6PRO, EC6DUAL → EC6 (เพราะเป็นรุ่นย่อยของ EC6)
    # แต่ T2C, T13 ไม่ collapse เพราะ base ต่างกัน (T2 vs T13)
    base_of: dict[str, str] = {}
    for t in raw_tokens:
        base_match = re.match(r"^([A-Z]+\d+)", t)
        base = base_match.group(1) if base_match else t
        base_of[t] = base

    # นับว่าแต่ละ base มีรุ่นย่อยกี่ตัว
    base_counts: dict[str, int] = {}
    for base in base_of.values():
        base_counts[base] = base_counts.get(base, 0) + 1

    # ถ้ามี base ที่มีหลายรุ่นย่อย (เช่น EC6PRO, EC6DUAL → base EC6 มี 2)
    # ให้ collapse รุ่นย่อยเหล่านั้นเป็น base
    # แต่รุ่นที่ base มีแค่ 1 ให้เก็บเต็ม (เช่น T2C, T13)
    final_tokens = []
    final_seen = set()
    for t in raw_tokens:
        base = base_of[t]
        if base_counts[base] >= 2:
            # collapse เป็น base
            token = base
        else:
            # เก็บเต็ม
            token = t
        if token not in final_seen:
            final_seen.add(token)
            final_tokens.append(token)

    # คืนเฉพาะเมื่อมี 2 รุ่นขึ้นไป (ถ้ามี 1 รุ่นไม่ต้อง diversity)
    if len(final_tokens) >= 2:
        return final_tokens
    # ถ้า collapse แล้วเหลือ 1 แต่ raw_tokens มี 2 รุ่นย่อยของ base เดียวกัน
    # (เช่น EC6 Pro vs EC6 Dual) ให้ใช้ raw_tokens เพื่อ diversity ที่ระดับรุ่นย่อย
    if len(raw_tokens) >= 2:
        return raw_tokens
    return []


def _doc_matches_model(doc: dict, model_token: str) -> bool:
    """เช็คว่าสินค้าตรงกับ model token หรือไม่ (case-insensitive)."""
    name = (doc.get("item_name") or "").upper()
    # ลบ space ในชื่อสินค้า เพื่อเทียบแบบไม่สน space
    # เช่น "EC 4" ในชื่อ vs "EC4" ใน token
    name_nospace = re.sub(r"\s+", "", name)
    token_nospace = re.sub(r"\s+", "", model_token.upper())
    return token_nospace in name_nospace


def _rerank_with_diversity(
    docs: list[dict],
    model_tokens: list[str],
    similarity_scores: dict[str, float] | None = None,
    limit: int = 20,
    per_model_quota: int = 2,
) -> list[dict]:
    """เรียงสินค้าโดยรับประกันว่าแต่ละ model มีอย่างน้อย per_model_quota ตัว.

    Flow:
    1. เรียง docs ตาม promo + latest + similarity (re-rank ปกติ)
    2. แยก docs ตาม model token ที่ตรง
    3. จัดสรรโควต้า per_model_quota ให้แต่ละ model ก่อน
    4. เติมที่เหลือด้วย docs ที่เหลือตามลำดับ re-rank

    Args:
        docs: list ของ product documents
        model_tokens: list ของ model tokens เช่น ['EC4', 'EC5', 'EC6']
        similarity_scores: dict {item_id_str: score} สำหรับกรณีเสมอกัน
        limit: จำนวนสินค้าที่จะคืน
        per_model_quota: จำนวนสินค้าขั้นต่ำต่อ model

    คืน docs ที่เรียงใหม่แล้ว จำกัดตาม limit.
    """
    if not docs or not model_tokens:
        return _rerank_by_promo_latest(docs, similarity_scores, limit)

    # 1. เรียงตาม promo + latest + sim ก่อน
    ranked = _rerank_by_promo_latest(
        docs, similarity_scores=similarity_scores, limit=len(docs)
    )

    # 2. แยก docs ตาม model token
    used_ids: set[str] = set()
    result: list[dict] = []
    docs_per_model: dict[str, list[dict]] = {t: [] for t in model_tokens}

    for d in ranked:
        iid = str(d.get("item_id", ""))
        for token in model_tokens:
            if _doc_matches_model(d, token):
                docs_per_model[token].append(d)
                break  # สินค้า 1 ตัว เข้าได้แค่ 1 model (เอาอันแรกที่ตรง)

    # 3. จัดสรรโควต้าให้แต่ละ model ก่อน
    for token in model_tokens:
        for d in docs_per_model[token][:per_model_quota]:
            iid = str(d.get("item_id", ""))
            if iid not in used_ids:
                result.append(d)
                used_ids.add(iid)

    # 4. เติมที่เหลือด้วย docs ที่ยังไม่ถูกเลือก ตามลำดับ re-rank
    for d in ranked:
        if len(result) >= limit:
            break
        iid = str(d.get("item_id", ""))
        if iid not in used_ids:
            result.append(d)
            used_ids.add(iid)

    return result[:limit]


def _filter_false_positives(docs: list[dict], product_types: set[str]) -> list[dict]:
    """กรอง false positive ใน Python ตาม product type.

    ใช้หลังจาก vector search หรือ regex search เพื่อตัดสินค้าที่บังเอิญมีคำใกล้เคียง
    แต่ไม่ใช่สินค้าประเภทนั้นจริง (เช่น ขาตั้งโทรศัพท์ ตอนถามหาโทรศัพท์).
    """
    if not product_types:
        return docs

    # กรอง false positive สำหรับ phone: ตัดอุปกรณ์เสริม (ขาตั้ง/tripod/เคส/ฟิล์ม/ชาร์จ/สายชาร์จ/แฟลชไดร์ฟ)
    if "phone" in product_types:
        accessory_kw = (
            "ขาตั้ง", "tripod", "เคส", "ฟิล์ม", "สายคล้อง", "ไม้เซลฟี่",
            "แฟลช", "flash drive", "flashdrive", "แฟลชไดร์ฟ", "แฟลชไดรฟ์",
            "ชาร์จ", "charger", "adapter", "สายชาร์จ", "หัวชาร์จ", "สาย c to c",
            "สาย type c", "สาย usb", "cable", "จั้มสตาร์ท", "จั้ม",
            "ซองกันน้ำ", "phone pouch", "pouch", "กระเป๋าโทรศัพท์",
            "สายคล้องข้อมือ", "แท่นชาร์จ", "charging dock", "wireless charger",
            "แบตสำรอง", "power bank", "powerbank",
            "micro sd", "sd card", "memory card", "การ์ดหน่วยความจำ", "การ์ด sd",
            "cooling fan", "พัดลมระบาย", "พัดลม", "fan", "heatsink", "ระบายความร้อน",
            "screen protector", "tempered glass", "กระจกนิรภัย",
            "sim card", "sim tray", "ejector", "pin sim",
            "earphone", "หูฟัง", "earbuds", "tws",
        )
        docs = [d for d in docs
                if not any(kw in (d.get("item_name") or "").lower() for kw in accessory_kw)]

    # กรอง false positive สำหรับ powerbank: ตัดสินค้าที่มี "แบตสำรอง" ในชื่อ
    # แต่เป็นอุปกรณ์อื่น (เครื่องดูดฝุ่น/ปั๊มลม/จั้มสตาร์ทรถ/หูฟัง ที่มีแบตสำรองเป็นฟีเจอร์)
    # และตัด charger เดี่ยวที่ไม่มีแบตสำรองออก (เช่น "หัวชาร์จ 65W" ไม่ใช่ powerbank)
    # แต่เก็บชุดที่มีแบตสำรองรวมอยู่ (เช่น "Charge anywhere หัวชาร์จ+สาย+แบต")
    if "powerbank" in product_types:
        not_powerbank_kw = (
            "เครื่องดูดฝุ่น", "ดูดฝุ่น", "ปั๊มลม", "จั้มสตาร์ท", "จั้ม",
            "หุ่นยนต์กวาด", "กวาดพื้น", "robot vacuum",
            "หูฟัง", "earphone", "earbuds", "tws",
            "เคส", "case", "silicone case", "protective case",
            "สายนาฬิกา", "strap",
        )
        docs = [d for d in docs
                if not any(kw in (d.get("item_name") or "").lower() for kw in not_powerbank_kw)]
        # กรองเอาเฉพาะที่มี indicator ของ powerbank จริงในชื่อ
        powerbank_name_kw = (
            "แบตสำรอง", "แบตเตอรี่สำรอง", "powerbank", "power bank", "power-bank",
            "pb1", "pb2", "pb3", "pb4", "pb5", "pb6", "pb7", "pb8", "pb9",
            "lpb", "wpb", "mpb", "spb",
            # รุ่น 2-in-1 (หัวชาร์จ+แบตสำรอง) เช่น BA652U Fusion
            "fusion", "2 in 1", "2-in-1", "2in1",
            # model code ที่เป็น powerbank แต่ชื่อไม่มีคำว่า "แบตสำรอง"
            "ba6", "ba7", "ba8", "ba9",
            "p23", "p17", "p30", "p50",
        )
        docs = [d for d in docs
                if any(kw in (d.get("item_name") or "").lower() for kw in powerbank_name_kw)]

    # กรอง false positive สำหรับ charger: ตัดสินค้าที่มี "Type-C/USB" ในชื่อ
    # แต่เป็นอุปกรณ์อื่น (เครื่องนวด/พัดลม ที่มี Type-C เป็นพอร์ตชาร์จ)
    # ไม่ตัดชุดที่มี "แบตสำรอง" ออก เพราะชุดมี charger รวมอยู่ด้วย
    # แต่ตัด powerbank เดี่ยว (ที่ไม่มี หัวชาร์จ/สายชาร์จ/adapter ในชื่อ) ออก
    if "charger" in product_types:
        not_charger_kw = (
            "เครื่องนวด", "นวด", "พัดลม", "fan", "เครื่องดูดฝุ่น",
            "หุ่นยนต์กวาด", "กวาดพื้น", "หูฟัง", "earphone", "earbuds",
        )
        docs = [d for d in docs
                if not any(kw in (d.get("item_name") or "").lower() for kw in not_charger_kw)]
        # ตัด powerbank เดี่ยวออก (มี "แบตสำรอง"/"powerbank" แต่ไม่มี charger indicator)
        charger_indicator_kw = (
            "หัวชาร์จ", "หัวชาร์ต", "adapter", "gan", "สายชาร์จ", "สายชาร์ต",
            "cable", "ชุดชาร์จ", "ชุดชาร์ต", "set", "ชุด", "combo",
            "ready to go", "charge anywhere", "charging set",
        )
        docs = [d for d in docs
                if not (
                    any(kw in (d.get("item_name") or "").lower() for kw in ("แบตสำรอง", "powerbank", "power bank"))
                    and not any(kw in (d.get("item_name") or "").lower() for kw in charger_indicator_kw)
                )]

    # กรอง false positive สำหรับ smartwatch: ตัดสายนาฬิกา/strap/อุปกรณ์เสริม
    if "smartwatch" in product_types:
        not_watch_kw = (
            "สายนาฬิกา", "สาย นาฬิกา", "strap", "deployant",
            "camouflage strap", "silicone strap", "metal strap",
            "watch strap", "band strap", "สายข้อมือ",
            "screen protector", "ฟิล์ม", "เคสนาฬิกา", "watch case",
            "ชาร์จนาฬิกา", "watch charger", "charging dock",
            "หัวชาร์จ", "สายชาร์จ",
        )
        docs = [d for d in docs
                if not any(kw in (d.get("item_name") or "").lower() for kw in not_watch_kw)]

    return docs


def fetch_products(
    db,
    message: str,
    shop_filter: str | None = None,
    limit: int = 20,
    desc_message: str | None = None,
    is_compat_check: bool = False,
    skip_charger_subtype: bool = False,
    product_types_override: set[str] | None = None,
) -> list[dict]:
    """กรองและดึงสินค้าที่เกี่ยวข้อง แล้วย่อเป็น product card ส่งให้ LLM.

    Args:
        message: คำถามสำหรับค้นสินค้า (ใช้ตรวจ product type, brand, model, etc.)
        shop_filter: กรองเฉพาะร้านที่ระบุ
        limit: จำนวนสินค้าสูงสุด
        desc_message: คำถามสำหรับกรอง description (ถ้าไม่ระบุ ใช้ message)
            ใช้ตอน follow-up: ค้นสินค้าด้วย "redmi 8a" แต่กรอง description ด้วย "รับประกัน"
        is_compat_check: ถ้าเป็น compatibility check ให้ดึงสินค้าเยอะขึ้น
            เพื่อให้ LLM เห็นทุกรุ่นในหมวด แล้วเลือกรุ่นที่รองรับ device จริงๆ
        product_types_override: ถ้าระบุ (ไม่ใช่ None) → ใช้ค่านี้แทนการ detect อัตโนมัติ
            ใช้ตอน caller รู้ประเภทสินค้าดีกว่า (เช่น charging spec question ไม่ควรกรองเป็น charger)

    ใช้ hybrid approach:
    1. ถ้ามี product type regex (phone/smartwatch/earphone/ฯลฯ) ใช้ regex approach เดิม
       เพราะ regex กรองได้แม่นยำกว่า vector search สำหรับสินค้าที่มี keyword ชัดเจน
    2. ถ้าไม่มี product type regex (เครื่องดูดฝุ่น/หม้อหุงข้าว/เครื่องนวด/ฯลฯ)
       ใช้ vector search (semantic) เพราะไม่มี regex ให้กรอง
    3. ถ้า vector search ไม่พร้อม ใช้ regex approach เดิมเป็น fallback
    """
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    collection = db[coll_name]

    # ตรวจ product type: ลอง exact match ก่อน ถ้าไม่เจอให้ลอง fuzzy (ทนคำพิมพ์ผิด)
    # ถ้า caller ส่ง product_types_override มา → ใช้ค่านั้นแทน (เช่น charging spec question)
    if product_types_override is not None:
        exact_product_types = product_types_override
        fuzzy_product_types = set()
    else:
        exact_product_types = _detect_product_types(message)
        fuzzy_product_types: set[str] = set()
    # สำหรับ warranty intent ที่มี model keyword ชัดเจน (เช่น "Tile Mate", "LOGITECH G PRO X")
    # ให้ข้าม fuzzy detection เพราะ fuzzy อาจจับผิด (เช่น "Mate" → "filter")
    # และเราต้องการกรองด้วย model keyword เป็นหลัก ไม่ใช่ product type
    _is_warranty_with_model = False
    if "warranty" in _detect_intent(message):
        from . import warranty as _warranty_mod
        _model_kw = _warranty_mod.strip_warranty_keywords(message)
        if _model_kw and len(_model_kw) >= 3:
            _is_warranty_with_model = True
    if not exact_product_types and not _is_warranty_with_model:
        fuzzy_product_types = _detect_product_types_fuzzy(message)
    product_types = exact_product_types or fuzzy_product_types

    # ถ้าเป็นคำถามเปรียบเทียบหลายรุ่น (มี model tokens เช่น "ec4 vs ec5 vs ec6")
    # ให้ข้าม fuzzy detection ที่อาจจับผิด (เช่น จับ "ec4" เป็น screen_protector)
    # แล้วใช้ vector search + model token supplementation แทน
    if not exact_product_types and _extract_model_tokens(message):
        product_types = set()
        fuzzy_product_types = set()

    # ถ้า fuzzy detection เจอหลายประเภทที่ "ทับซ้อน" กัน (เช่น phone + earphone)
    # ให้เลือกเฉพาะประเภทที่ match คำใน message จริงๆ ไม่ใช่ false positive จาก stopword
    # เช่น "โทสับงบ 2000" อาจจับได้ทั้ง phone และ earphone เพราะ "งบ" พิมพ์ผิดใกล้ earbuds
    # แต่ "โทสับ" ชัดเจนว่าเป็น phone จึงควรเก็บแค่ phone
    if len(fuzzy_product_types) > 1:
        # เช็คว่า message มีคำที่ตรงกับแต่ละ type จริงหรือไม่
        msg_lower = message.lower()
        kept_types: set[str] = set()
        for t in fuzzy_product_types:
            # หา user keywords ของ type นี้
            for type_name, user_kws, _ in PRODUCT_TYPES:
                if type_name == t:
                    # ถ้ามี keyword ตัวไหนของ type นี้อยู่ใน message ให้เก็บ
                    if any(kw.lower() in msg_lower for kw in user_kws):
                        kept_types.add(t)
                    break
        # ถ้าเก็บได้อย่างน้อย 1 type ให้ใช้แค่ที่เก็บได้
        if kept_types:
            product_types = kept_types

    # สร้าง filter สำหรับกรองใน Mongo
    base_filter = build_query(message, shop_filter=shop_filter, product_types=product_types)

    # ตรวจ intent เพื่อใช้ใน vector search path
    # (vector search มี hardcode item_status=NORMAL เพื่อความปลอดภัย แต่ warranty intent ต้องเห็น non-NORMAL)
    _is_warranty_intent = "warranty" in _detect_intent(message)

    # ตรวจว่ามี product type regex หรือไม่
    # ใช้ regex approach เมื่อ exact หรือ fuzzy detection จับได้
    # (ถ้ารู้ประเภทสินค้าแล้ว regex บน MongoDB แม่นยำกว่า vector search)
    # ส่วน vector search ใช้สำหรับสินค้าที่ไม่มีใน PRODUCT_TYPES เลย
    has_type_regex = bool(product_types and _product_type_regex(product_types))

    # ---- เลือก strategy --------------------------------------------------
    docs: list[dict] = []
    used_vector_search = False

    # ใช้ vector search เฉพาะเมื่อไม่มี product type regex
    # (เพราะ regex กรองได้แม่นยำกว่าสำหรับสินค้าที่มี keyword ชัดเจน)
    if not has_type_regex:
        vs = _load_vector_store()
        if vs is not None:
            try:
                # ดึงเยอะกว่า limit เพื่อให้มีตัวเลือกพอสำหรับ re-rank
                top_results = vector_search(message, top_k=max(limit * 4, 30))
                if top_results:
                    # top_results เป็น list ของ (item_id_str, similarity_score)
                    # สร้าง dict สำหรับเก็บ similarity score ของแต่ละ item_id
                    sim_scores: dict[str, float] = {}
                    id_values: list = []
                    for iid, score in top_results:
                        sim_scores[iid] = score
                        try:
                            f = float(iid)
                            id_values.append(int(f))
                            id_values.append(f)
                        except (ValueError, TypeError):
                            id_values.append(iid)
                    id_filter = {
                        "item_id": {"$in": id_values},
                    }
                    # ดึงสินค้าทุก status — LLM จะแนะนำเฉพาะ NORMAL เอง
                    if shop_filter:
                        id_filter["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}

                    cursor = collection.find(id_filter, PRODUCT_PROJECTION)
                    cursor = cursor.limit(len(top_results))
                    docs = list(cursor)

                    # ถ้ามี model tokens (เปรียบเทียบหลายรุ่น) ให้เสริมด้วย MongoDB query
                    # โดยตรง เพื่อรับประกันว่าแต่ละรุ่นมีสินค้าพอ
                    # (vector search อาจไม่ครอบคลุมทุกรุ่น เพราะกรอง top_k ก่อนกรอง NORMAL)
                    model_tokens = _extract_model_tokens(message)
                    if model_tokens:
                        # ดึงสินค้าแต่ละรุ่นจาก MongoDB โดยตรง (NORMAL, จำกัด 5 ต่อรุ่น)
                        existing_ids = {str(d.get("item_id")) for d in docs}
                        for token in model_tokens:
                            # สร้าง regex สำหรับรุ่นนี้ (เช่น EC4, EC5, EC6)
                            # ใช้ word boundary เพื่อกัน match ผิด (เช่น EC4 ไม่ควร match EC40)
                            token_regex = re.compile(
                                r"\b" + re.escape(token) + r"\b", re.IGNORECASE
                            )
                            model_filter = {
                                "item_name": {"$regex": token_regex.pattern, "$options": "i"},
                            }
                            # ดึงสินค้าทุก status — LLM จะแนะนำเฉพาะ NORMAL เอง
                            if shop_filter:
                                model_filter["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}
                            model_docs = list(
                                collection.find(model_filter, PRODUCT_PROJECTION).limit(5)
                            )
                            for d in model_docs:
                                iid = str(d.get("item_id"))
                                if iid not in existing_ids:
                                    docs.append(d)
                                    existing_ids.add(iid)
                                    # ให้ similarity score กลางๆ เพราะมาจาก regex ไม่ใช่ vector
                                    sim_scores[iid] = 0.5

                    # ถ้า fuzzy detection จับได้ (แต่ exact ไม่ได้) ให้กรองด้วย regex ใน Python
                    # เพื่อเอาสินค้าที่ตรงประเภทจริงขึ้นก่อน ถ้ามีพอ
                    if fuzzy_product_types:
                        regex = _product_type_regex(fuzzy_product_types)
                        if regex:
                            matched = [d for d in docs if re.search(regex, (d.get("item_name") or ""), re.IGNORECASE)]
                            if len(matched) >= max(limit // 2, 3):
                                docs = matched

                    # กรอง false positive ใน Python (กันสินค้าที่บังเอิญมีคำใกล้เคียง)
                    if product_types:
                        docs = _filter_false_positives(docs, product_types)

                    # re-rank: ถ้าคำถามเปรียบเทียบหลายรุ่น ใช้ diversity re-rank
                    # เพื่อรับประกันว่าแต่ละรุ่นมีอย่างน้อย 2 ตัวใน context
                    model_tokens = _extract_model_tokens(message)
                    if model_tokens:
                        docs = _rerank_with_diversity(
                            docs, model_tokens,
                            similarity_scores=sim_scores, limit=limit,
                        )
                    else:
                        docs = _rerank_by_promo_latest(
                            docs, similarity_scores=sim_scores, limit=limit
                        )

                    # ── กรอง charger subtype สำหรับ vector search path ด้วย ──
                    # ยกเว้น superlative question ที่ต้องเปรียบเทียบทุกประเภท
                    if "charger" in product_types and not skip_charger_subtype:
                        _charger_sub = _detect_charger_subtype(message)
                        if _charger_sub:
                            docs = _filter_charger_subtype(docs, _charger_sub)
                            print(f"[CHARGER-SUBTYPE] subtype={_charger_sub} → {len(docs)} docs (vector)", file=sys.stderr)

                    used_vector_search = True
            except Exception as exc:
                print(f"WARN: vector search failed: {exc}")
                docs = []

    # ---- fallback: regex approach เดิม (ถ้า vector search ไม่พร้อม/ไม่ได้ผล) ----
    if not used_vector_search or not docs:
        query = base_filter
        has_specific = any(k in query for k in (
            "shopname", "brand.original_brand_name", "cat_name", "item_name",
            "model.price_info.current_price", "attribute_list.original_attribute_name",
        ))

        cursor = collection.find(query, PRODUCT_PROJECTION)
        if has_specific:
            # ดึงเยอะกว่า limit*2 เพื่อให้หลังกรอง false positive ยังเหลือพอ
            # (เช่น โทรศัพท์งบ 5000: 20 ตัวแรกเป็น accessories หมด โทรศัพท์จริงอยู่หลังจากนั้น)
            # สำหรับ compatibility check ดึงเยอะขึ้นเพื่อให้ครอบคลุมทุกรุ่นในหมวด
            _compat_limit = max(limit * 20, 500) if is_compat_check else max(limit * 5, 100)
            cursor = cursor.limit(_compat_limit)
        else:
            # fallback: text search บน item_name + description
            words = [w for w in re.split(r"\s+", message.strip()) if len(w) >= 2]
            if words:
                text_q = {
                    "$or": [
                        {"item_name": {"$regex": "|".join(re.escape(w) for w in words[:5]), "$options": "i"}},
                        {"description": {"$regex": "|".join(re.escape(w) for w in words[:5]), "$options": "i"}},
                    ],
                }
                # ⚠️ ถ้ามี shop_filter ต้องกรองเฉพาะร้านนั้น — ห้ามค้นข้ามร้าน
                if shop_filter:
                    text_q["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}
                cursor = collection.find(text_q, PRODUCT_PROJECTION).limit(limit * 2)
            else:
                cursor = cursor.limit(limit)

        docs = list(cursor)

    # กรอง false positive ใน Python (สำหรับ regex fallback path)
    # ถ้าใช้ vector search อยู่แล้ว กรองไปแล้วด้านบน ไม่ต้องทำซ้ำ
    if not used_vector_search:
        docs = _filter_false_positives(docs, product_types)

    # ⚡ Compatibility check: ถ้าเป็น compat check ให้เสริมด้วย text search
    # เพื่อให้ครอบคลุมสินค้าทุกรุ่นในหมวด (บางรุ่นอาจไม่ติด top N ตาม natural order)
    if is_compat_check and product_types and not used_vector_search:
        type_regex = _product_type_regex(product_types)
        if type_regex:
            # ค้นด้วย item_name regex อย่างเดียว (ไม่กรอง cat_name) เพื่อให้ครอบคลุมทุกรุ่น
            text_q = {"item_name": {"$regex": type_regex, "$options": "i"}}
            if shop_filter:
                text_q["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}
            extra_docs = list(collection.find(text_q, PRODUCT_PROJECTION).limit(max(limit * 10, 200)))
            # merge กับ docs เดิม (dedup by item_id)
            _docs_before = len(docs)
            existing_ids = {str(d.get("item_id")) for d in docs}
            _added = 0
            for d in extra_docs:
                iid = str(d.get("item_id"))
                if iid not in existing_ids:
                    docs.append(d)
                    existing_ids.add(iid)
                    _added += 1
            print(f"[COMPAT-SUPPLEMENT] docs_before={_docs_before} extra={len(extra_docs)} added={_added} total={len(docs)}", file=sys.stderr)

    # fallback ระดับ 2: ถ้ากรองด้วย product type (item_name regex) แล้วได้ 0
    # แปลว่าไม่มีสินค้าประเภทนั้นในสต็อก (เช่น โทรศัพท์ในร้านนี้เป็น UNLIST หมด)
    # ให้ถอด item_name regex ออกแล้วค้นใหม่ เพื่อให้ LLM ได้เห็นสินค้าอื่นในหมวดเดียวกัน
    # แล้วตอบลูกค้าว่า "ไม่มีโทรศัพท์ตอนนี้ แต่มี..." แทนที่จะคืน 0
    #
    # สำคัญ: ถ้า relaxed_q เหลือแค่ item_status=NORMAL (ไม่มี cat_name/brand/shop)
    # ต้องเพิ่ม cat_name ที่เกี่ยวข้องกับ product type เข้าไป ไม่งั้นจะได้สินค้าไม่เกี่ยวเลย
    fallback_used = False
    if not docs and not used_vector_search and "item_name" in base_filter and has_specific:
        # ลำดับการ relax:
        # 1. ถอดแค่ price filter ก่อน (หาสินค้าประเภทเดียวกัน ไม่จำกัดราคา)
        # 2. ถ้ายังไม่มี ถอด item_name ด้วย (หาสินค้าอื่นในหมวดเดียวกัน)
        price_key = "model.price_info.current_price"

        # ขั้นที่ 1: ถอดแค่ price
        relaxed_q = {k: v for k, v in base_filter.items() if k != price_key}
        # ถ้ามี price filter อยู่ก่อน แปลว่าลูกค้าถามงบ ให้เรียงตามราคาใกล้เคียงที่สุด
        if price_key in base_filter:
            pm, pM = _extract_price_range(message)
            target = pM if pM is not None else pm
            if target is not None:
                # ดึงเยอะแล้ว sort ใน Python (เพราะ model.price_info.current_price อาจเป็น array)
                docs = list(collection.find(relaxed_q, PRODUCT_PROJECTION).limit(max(limit * 5, 100)))
                docs = _filter_false_positives(docs, product_types)
                # sort ตามระยะห่างจากราคาเป้าหมาย (ใกล้สุดก่อน)
                def _price_dist(d):
                    price = _price_range(d)
                    if not price or price.get("min") is None:
                        return 9999999
                    return abs(price["min"] - target)
                docs.sort(key=_price_dist)
                docs = docs[:max(limit * 2, 20)]
            else:
                docs = list(collection.find(relaxed_q, PRODUCT_PROJECTION).limit(max(limit * 5, 50)))
                docs = _filter_false_positives(docs, product_types)
        else:
            docs = list(collection.find(relaxed_q, PRODUCT_PROJECTION).limit(max(limit * 5, 50)))
            docs = _filter_false_positives(docs, product_types)

        # ขั้นที่ 2: ถ้ายังไม่มี ถอด item_name ด้วย
        if not docs:
            fallback_used = True
            relaxed_q2 = {k: v for k, v in base_filter.items()
                          if k not in ("item_name", price_key)}
            if "cat_name" not in relaxed_q2 and product_types:
                related_cats = _product_type_categories(product_types)
                if related_cats:
                    relaxed_q2["cat_name"] = {"$in": related_cats}
            docs = list(collection.find(relaxed_q2, PRODUCT_PROJECTION).limit(max(limit * 2, 30)))
            # กรอง false positive ใน fallback ด้วย (กันสายนาฬิกา/อุปกรณ์เสริม)
            if product_types:
                docs = _filter_false_positives(docs, product_types)

    # ── กรอง charger subtype (สาย/หัว/ชุด) ก่อน re-rank ──
    # ต้องกรองก่อน re-rank เพราะ re-rank ตัดเหลือ limit แล้ว set products อาจตกไป
    # ยกเว้น superlative question ที่ต้องเปรียบเทียบทุกประเภท (charger + powerbank)
    if "charger" in product_types and not skip_charger_subtype:
        _charger_sub = _detect_charger_subtype(message)
        if _charger_sub:
            docs = _filter_charger_subtype(docs, _charger_sub)
            print(f"[CHARGER-SUBTYPE] subtype={_charger_sub} → {len(docs)} docs (pre-rerank)", file=sys.stderr)

    # re-rank ตามโปรโมชั่น + ความใหม่ (สำหรับ regex path ที่ไม่ได้ผ่าน vector search)
    # ถ้าผ่าน vector search มาแล้ว docs ถูก re-rank แล้ว ไม่ต้องทำซ้ำ
    # สำคัญ: ก่อน re-rank ให้ตรวจดูก่อนว่ามีสินค้าที่ชื่อตรงกับคำถาม (exact model match) ไหม
    # ถ้ามี ให้แยกไว้ แล้ว re-rank เฉพาะส่วนที่เหลือ เพื่อป้องกันสินค้าตรงถูกตัดทิ้ง
    if not used_vector_search and docs:
        msg_words = [w.lower() for w in re.split(r"\s+", message.strip()) if len(w) >= 2]
        # กรองเฉพาะคำที่น่าจะเป็น model name:
        # - มีตัวเลข (เช่น 8a, 10, 12pro)
        # - เป็นแบรนด์/รุ่นที่รู้จัก (เช่น redmi, xiaomi, iphone, galaxy)
        # ไม่นับคำทั่วไป เช่น "รายละเอียด", "สเปก", "รับประกัน", "จัดส่ง"
        known_brands = {"redmi", "xiaomi", "mi", "iphone", "galaxy", "samsung",
                        "oppo", "vivo", "realme", "poco", "note", "pro", "max",
                        "ultra", "lite", "plus", "mini", "air", "band", "watch",
                        "bud", "pods", "tws", "shark", "blackshark"}
        model_words = [w for w in msg_words
                       if any(c.isdigit() for c in w) or w in known_brands]
        exact_matches: list[dict] = []
        rest_docs: list[dict] = []
        if model_words:
            for d in docs:
                name = (d.get("item_name") or "").lower()
                # exact match = ทุก model word อยู่ในชื่อ
                if all(w in name for w in model_words):
                    exact_matches.append(d)
                else:
                    rest_docs.append(d)
        else:
            rest_docs = docs

        # re-rank เฉพาะส่วนที่ไม่ใช่ exact match
        model_tokens = _extract_model_tokens(message)
        # สำหรับ compatibility check ให้ดึงเยอะกว่า limit เพื่อให้ LLM เห็นทุกรุ่น
        _rerank_limit = max(limit * 3, 50) if is_compat_check else limit
        if rest_docs:
            if model_tokens:
                rest_docs = _rerank_with_diversity(rest_docs, model_tokens, limit=_rerank_limit)
            else:
                rest_docs = _rerank_by_promo_latest(rest_docs, similarity_scores=None, limit=_rerank_limit)

        # รวม exact matches ขึ้นก่อน + rest_docs
        docs = exact_matches + rest_docs

    # fallback ระดับ 3: ถ้ามี brand filter และ item_name regex
    # ให้ถอด brand filter ออกแล้วดึงเพิ่ม เพราะสินค้าบางร้านตั้ง brand เป็น NoBrand
    # ทั้งที่ชื่อสินค้ามีแบรนด์ (เช่น "Xiaomi Redmi 8A" แต่ brand=NoBrand)
    # ดึงเยอะกว่าเดิมเพราะสินค้าที่ตรงประเภทอาจอยู่หลัง sort
    # สำคัญ: สินค้าที่ชื่อตรงกับคำถามมากที่สุด ต้องขึ้นก่อน (ไม่ใช่เรียงตาม promo)
    brand_key = "brand.original_brand_name"
    if (not used_vector_search
            and brand_key in base_filter and "item_name" in base_filter):
        no_brand_q = {k: v for k, v in base_filter.items() if k != brand_key}
        extra_docs = list(collection.find(no_brand_q, PRODUCT_PROJECTION).limit(max(limit * 10, 200)))
        extra_docs = _filter_false_positives(extra_docs, product_types)
        # รวมกับ docs เดิม (ถอดซ้ำ)
        existing_ids = {str(d.get("item_id")) for d in docs}
        for d in extra_docs:
            iid = str(d.get("item_id"))
            if iid not in existing_ids:
                docs.append(d)
                existing_ids.add(iid)
        # re-rank: สินค้าที่ชื่อตรงกับคำถามมากที่สุดขึ้นก่อน
        # ใช้ text matching score (จำนวนคำใน message ที่อยู่ใน item_name)
        if docs:
            msg_words = [w.lower() for w in re.split(r"\s+", message.strip()) if len(w) >= 2]
            def _name_match_score(d):
                name = (d.get("item_name") or "").lower()
                # นับจำนวนคำใน message ที่อยู่ใน name
                score = sum(1 for w in msg_words if w in name)
                # bonus ถ้ามีคำที่ยาว (เช่น "redmi", "8a")
                score += sum(len(w) for w in msg_words if w in name) / 10
                return score
            docs.sort(key=_name_match_score, reverse=True)
            # สำหรับ compatibility check ให้ดึงเยอะกว่า limit เพื่อให้ LLM เห็นทุกรุ่น
            _sort_limit = max(limit * 3, 50) if is_compat_check else limit
            docs = docs[:_sort_limit]

    # กระทำเสมอ (ไม่ว่าจะมี brand filter หรือไม่):
    # ถ้ามีสินค้าที่ชื่อตรงกับคำถามมาก (exact model match) ให้ยกขึ้น top
    # ป้องกันสินค้าที่ชื่อตรงแต่ไม่มี promo ถูกแซงโดยสินค้าอื่น
    if not used_vector_search and len(docs) > limit:
        msg_words = [w.lower() for w in re.split(r"\s+", message.strip()) if len(w) >= 2]
        # กรองเฉพาะคำที่น่าจะเป็น model name (ตัวเลข/ตัวอักษรผสม)
        model_words = [w for w in msg_words if any(c.isdigit() for c in w) or len(w) >= 4]
        if model_words:
            def _exact_match_score(d):
                name = (d.get("item_name") or "").lower()
                # สินค้าที่มีทุก model word ในชื่อ = exact match ให้ score สูง
                matched = sum(1 for w in model_words if w in name)
                if matched == len(model_words):
                    return 100 + matched
                return matched
            # ดู top `limit` ตัวก่อน sort ตาม exact match
            # ถ้ามี exact match ใน docs ให้ยกขึ้นมาก่อน
            docs_sorted = sorted(docs, key=_exact_match_score, reverse=True)
            exact_matches = [d for d in docs_sorted if _exact_match_score(d) >= 100]
            if exact_matches:
                # เอา exact match ขึ้นมาก่อน แล้วตามด้วย docs เดิมที่เหลือ
                exact_ids = {str(d.get("item_id")) for d in exact_matches}
                rest = [d for d in docs if str(d.get("item_id")) not in exact_ids]
                docs = exact_matches + rest
                _exact_limit = max(limit * 3, 50) if is_compat_check else limit
                docs = docs[:_exact_limit]

    # ── กรอง sold out (stock=0 ทุก model) ──
    # ไม่กรองออกจาก context — ส่งให้ LLM เห็นทุกสินค้าเพื่อตอบสเปค/รายละเอียดได้
    # LLM จะไม่แนะนำ sold_out เอง (ตาม instructions)
    # แต่ถ้าลูกค้าถามเฉพาะรุ่นที่ sold_out → บอก "หมดสต็อกชั่วคราว" + แนะนำรุ่นอื่น
    # (ไม่ต้องกรองที่นี่แล้ว — to_product_card มี sold_out field ให้ LLM รู้อยู่แล้ว)

    # ── re-filter charger subtype อีกครั้งหลัง brand fallback ──
    # (brand fallback ดึงสินค้าเพิ่ม อาจนำ cable/adapter ปนเข้ามา)
    # ยกเว้น superlative question ที่ต้องเปรียบเทียบทุกประเภท
    if "charger" in product_types and not skip_charger_subtype:
        _charger_sub_final = _detect_charger_subtype(message)
        if _charger_sub_final:
            docs = _filter_charger_subtype(docs, _charger_sub_final)
            print(f"[CHARGER-SUBTYPE] re-filter after brand fallback: subtype={_charger_sub_final} → {len(docs)} docs", file=sys.stderr)

    # NOTE: charger subtype filter ถูกกรองก่อน re-rank แล้ว (ด้านบน)
    # เพื่อกัน set products ตกหล่นจาก top-N

    cards = [to_product_card(d, desc_message or message) for d in docs]

    # จำกัดสุดท้าย (ถ้ายังไม่ถูกตัดจาก _rerank_by_promo_latest)
    # สำหรับ compatibility check ให้ส่งเยอะกว่า limit เพื่อให้ LLM เห็นทุกรุ่น
    _final_limit = max(limit * 3, 50) if is_compat_check else limit
    cards = cards[:_final_limit]

    # ฝัง note ใน card แรกเพื่อให้ LLM รู้ว่าเป็น fallback (ไม่มีสินค้าประเภทที่ถาม)
    # LLM จะได้ตอบลูกค้าว่า "ไม่มีโทรศัพท์ตอนนี้ แต่มี..." แทนที่จะตอบว่ามีสมาร์ทวอชโดยไม่อธิบาย
    if fallback_used and cards:
        type_labels = {
            "phone": "โทรศัพท์", "smartwatch": "สมาร์ทวอช", "powerbank": "แบตสำรอง",
            "charger": "สาย/หัวชาร์จ", "case": "เคส", "earphone": "หูฟัง",
            "speaker": "ลำโพง", "memory_card": "การ์ดหน่วยความจำ",
            "screen_protector": "ฟิล์มจอ", "fan": "พัดลม",
            "selfie_stick": "ไม้เซลฟี่", "mobile_wifi": "pocket wifi",
        }
        asked = " หรือ ".join(type_labels.get(t, t) for t in product_types)
        cards[0]["_context_note"] = (
            f"ไม่พบ{asked}ที่มีสถานะพร้อมขาย (NORMAL) ในร้านนี้ "
            f"รายการด้านล่างเป็นสินค้าอื่นในหมวดเดียวกันที่มีจำหน่าย "
            f"กรุณาแจ้งลูกค้าว่าไม่มี{asked}ตอนนี้ แล้วเสนอทางเลือกที่เกี่ยวข้องแทน"
        )

    return cards

    # จำกัดสุดท้าย
    return cards[:limit]


def fetch_product_by_id(
    db,
    item_id: int | str,
    shop_filter: str | None = None,
    desc_message: str | None = None,
) -> dict | None:
    """ดึงสินค้า 1 ชิ้นตรงจาก item_id (เช่น ลูกค้าแชร์การ์ดสินค้ามาในแชท).

    ใช้ตอนที่รู้ item_id ชัดเจน (จาก Shopee product-share tag เช่น "[สินค้า: 43360743407]")
    แม่นยำกว่าการค้นด้วยข้อความมาก เพราะไม่ต้องเดา/เสี่ยง false positive จาก NLP retrieval

    Returns: product card (dict) หรือ None ถ้าไม่เจอ
    """
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    collection = db[coll_name]

    # item_id ใน DB อาจเก็บเป็น int หรือ float — ลองทั้งสองแบบ
    id_values: list = []
    try:
        f = float(item_id)
        id_values.append(int(f))
        id_values.append(f)
    except (ValueError, TypeError):
        id_values.append(item_id)

    query: dict[str, Any] = {"item_id": {"$in": id_values}}
    if shop_filter:
        query["shopname"] = {"$regex": f"^{re.escape(shop_filter)}$", "$options": "i"}

    doc = collection.find_one(query, PRODUCT_PROJECTION)
    if doc is None and shop_filter:
        # ถ้าไม่เจอในร้านที่ระบุ ลองหาไม่จำกัดร้าน (เผื่อ shop_filter ไม่ตรง/สินค้าย้ายร้าน)
        doc = collection.find_one({"item_id": {"$in": id_values}}, PRODUCT_PROJECTION)
    if doc is None:
        return None

    return to_product_card(doc, desc_message or "")


def list_shops(db) -> list[str]:
    """รายชื่อร้านในเครือทั้งหมด."""
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    return sorted(db[coll_name].distinct("shopname"))


def list_categories(db) -> list[str]:
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    return sorted(c for c in db[coll_name].distinct("cat_name") if c)
