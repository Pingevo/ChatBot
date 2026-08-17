"""ดึง/กรองสินค้าจาก MongoDB live เพื่อใช้เป็น context ส่งให้ LLM.

ออกแบบตามแนว RAG: กรองเฉพาะสินค้าที่น่าจะเกี่ยวข้องกับคำถามลูกค้าก่อน
แล้วจึงส่ง context ย่อเข้า LLM เพื่อประหยัด token และตอบได้แม่นยำขึ้น.
"""

from __future__ import annotations

import os
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

    ถ้า attribute_list ไม่มี → สกัดจาก item_name (เช่น "ประกันศูนย์ไทย 15 เดือน").
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

    # fallback: สกัด warranty จาก item_name (เช่น "ประกันศูนย์ไทย 15 เดือน", "1 Year Warranty")
    if not info:
        import re as _re
        item_name = doc.get("item_name") or ""
        # pattern: "ประกัน...X เดือน/ปี" หรือ "X เดือน/ปี" ใกล้คำว่าประกัน
        m = _re.search(r"ประกัน[^\d]{0,20}(\d+)\s*(เดือน|ปี|year|month)", item_name, _re.IGNORECASE)
        if m:
            num = m.group(1)
            unit = m.group(2)
            info["duration"] = f"{num} {unit}"
            # สกัด type ด้วย (เช่น "ศูนย์ไทย")
            m2 = _re.search(r"ประกัน(\S+?)\s*\d+", item_name)
            if m2:
                info["type"] = m2.group(1).strip()
        # pattern: "X Year Warranty" หรือ "X Month Warranty"
        elif _re.search(r"\d+\s*(year|month)s?\s*warranty", item_name, _re.IGNORECASE):
            m3 = _re.search(r"(\d+)\s*(year|month)s?\s*warranty", item_name, _re.IGNORECASE)
            if m3:
                info["duration"] = f"{m3.group(1)} {m3.group(2)}"

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
               "เปรียบเทียบ", " vs ", "เทียบ", "compare", "เทียบกับ")
    shipping_kw = ("จัดส่ง", "ส่งสินค้า", "เวลาทำการ", "บริการแชท",
                   "shipping", "delivery", "เปิดทำการ", "ตัดรอบ")

    want_warranty = any(kw in msg_lower for kw in warranty_kw)
    want_spec = any(kw in msg_lower for kw in spec_kw)
    want_shipping = any(kw in msg_lower for kw in shipping_kw)

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
    # หัวชาร์จ/สายชาร์จ/adapter
    ("charger",
     ("หัวชาร์จ", "สายชาร์จ", "สายชาร์ต", "charger", "cable", "คาเบิล",
      "adapter", "แอ็ดอปเตอร์", "สาย type-c", "สาย type c", "สาย micro",
      "สาย usb", "gan"),
     r"(?:หัวชาร์จ|สายชาร์จ|สายชาร์ต|charger|\bcable\b|คาเบิล|"
     r"adapter|แอ็ดอปเตอร์|type[\s-]*c|micro\s*usb|usb[-\s]*a|"
     r"\bgan\b|\bqc\s*3|pd\s*fast)"),
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
)


def _detect_product_types(message: str) -> set[str]:
    """ตรวจว่าลูกค้าอ้างถึง product type ใดบ้าง (เพื่อกรอง item_name แบบละเอียด).

    ตรวจ 2 ขั้น:
    1. exact match กับ user_kws (เช่น "โทรศัพท์", "มือถือ", "phone")
    2. ถ้าไม่ match ในขั้น 1 ให้ลอง regex (เช่น "redmi 8a" match phone regex)
       เพื่อจับกรณีลูกค้าพิมพ์แค่ชื่อรุ่นโดยไม่ระบุประเภท
    """
    low = message.lower()
    found: set[str] = set()
    for type_name, user_kws, _regex in PRODUCT_TYPES:
        if any(kw in low for kw in user_kws):
            found.add(type_name)
        elif _regex and re.search(_regex, low):
            found.add(type_name)
    return found


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

    q: dict = {"item_status": "NORMAL"}

    # ถ้าเป็นคำถามเรื่องรับประกัน ไม่จำกัดเฉพาะ NORMAL (ลูกค้าอาจถามสินค้าเก่า)
    if "warranty" in intents:
        q.pop("item_status", None)

    if shop_filter:
        q["shopname"] = shop_filter
    elif shops:
        q["shopname"] = {"$in": shops}

    if brands:
        q["brand.original_brand_name"] = {"$in": brands}

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
        # เน้นสินค้าที่มีข้อมูล Warranty ใน attribute_list หรือ description
        # ใช้ $or เพื่อให้ครอบคลุมสินค้าที่เก็บ warranty ใน description แทน attribute
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


def _rerank_by_promo_latest(
    docs: list[dict],
    similarity_scores: dict[str, float] | None = None,
    limit: int = 20,
) -> list[dict]:
    """เรียงสินค้าตาม: มีโปรขึ้นก่อน → ใหม่ล่าสุด → similarity สูง.

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
        has_promo = _has_active_promotion(d)
        recency = _get_recency_score(d)
        iid = str(d.get("item_id", ""))
        sim = (similarity_scores or {}).get(iid, 0.0)
        # เรียงจากมากไปน้อย: (has_promo, recency, sim)
        # has_promo เป็น bool → True > False อัตโนมัติเวลาเรียงจากมากไปน้อย
        return (has_promo, recency, sim)

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
    if "powerbank" in product_types:
        not_powerbank_kw = (
            "เครื่องดูดฝุ่น", "ดูดฝุ่น", "ปั๊มลม", "จั้มสตาร์ท", "จั้ม",
            "หุ่นยนต์กวาด", "กวาดพื้น", "robot vacuum",
            "หูฟัง", "earphone", "earbuds", "tws",
        )
        docs = [d for d in docs
                if not any(kw in (d.get("item_name") or "").lower() for kw in not_powerbank_kw)]

    # กรอง false positive สำหรับ charger: ตัดสินค้าที่มี "Type-C/USB" ในชื่อ
    # แต่เป็นอุปกรณ์อื่น (เครื่องนวด/พัดลม ที่มี Type-C เป็นพอร์ตชาร์จ)
    if "charger" in product_types:
        not_charger_kw = (
            "เครื่องนวด", "นวด", "พัดลม", "fan", "เครื่องดูดฝุ่น",
            "หุ่นยนต์กวาด", "กวาดพื้น", "หูฟัง", "earphone", "earbuds",
            "แบตสำรอง", "powerbank", "power bank",
        )
        docs = [d for d in docs
                if not any(kw in (d.get("item_name") or "").lower() for kw in not_charger_kw)]

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
) -> list[dict]:
    """กรองและดึงสินค้าที่เกี่ยวข้อง แล้วย่อเป็น product card ส่งให้ LLM.

    Args:
        message: คำถามสำหรับค้นสินค้า (ใช้ตรวจ product type, brand, model, etc.)
        shop_filter: กรองเฉพาะร้านที่ระบุ
        limit: จำนวนสินค้าสูงสุด
        desc_message: คำถามสำหรับกรอง description (ถ้าไม่ระบุ ใช้ message)
            ใช้ตอน follow-up: ค้นสินค้าด้วย "redmi 8a" แต่กรอง description ด้วย "รับประกัน"

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
    exact_product_types = _detect_product_types(message)
    fuzzy_product_types: set[str] = set()
    if not exact_product_types:
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
                        "item_status": "NORMAL",
                        "item_id": {"$in": id_values},
                    }
                    if shop_filter:
                        id_filter["shopname"] = shop_filter

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
                                "item_status": "NORMAL",
                                "item_name": {"$regex": token_regex.pattern, "$options": "i"},
                            }
                            if shop_filter:
                                model_filter["shopname"] = shop_filter
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
            cursor = cursor.limit(max(limit * 5, 100))
        else:
            # fallback: text search บน item_name + description
            words = [w for w in re.split(r"\s+", message.strip()) if len(w) >= 2]
            if words:
                text_q = {
                    "item_status": "NORMAL",
                    "$or": [
                        {"item_name": {"$regex": "|".join(re.escape(w) for w in words[:5]), "$options": "i"}},
                        {"description": {"$regex": "|".join(re.escape(w) for w in words[:5]), "$options": "i"}},
                    ],
                }
                cursor = collection.find(text_q, PRODUCT_PROJECTION).limit(limit * 2)
            else:
                cursor = cursor.limit(limit)

        docs = list(cursor)

    # กรอง false positive ใน Python (สำหรับ regex fallback path)
    # ถ้าใช้ vector search อยู่แล้ว กรองไปแล้วด้านบน ไม่ต้องทำซ้ำ
    if not used_vector_search:
        docs = _filter_false_positives(docs, product_types)

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
        if rest_docs:
            if model_tokens:
                rest_docs = _rerank_with_diversity(rest_docs, model_tokens, limit=limit)
            else:
                rest_docs = _rerank_by_promo_latest(rest_docs, similarity_scores=None, limit=limit)

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
            docs = docs[:limit]

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
                docs = docs[:limit]

    cards = [to_product_card(d, desc_message or message) for d in docs]

    # จำกัดสุดท้าย (ถ้ายังไม่ถูกตัดจาก _rerank_by_promo_latest)
    cards = cards[:limit]

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


def list_shops(db) -> list[str]:
    """รายชื่อร้านในเครือทั้งหมด."""
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    return sorted(db[coll_name].distinct("shopname"))


def list_categories(db) -> list[str]:
    coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
    return sorted(c for c in db[coll_name].distinct("cat_name") if c)
