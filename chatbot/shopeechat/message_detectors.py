"""Pure message detectors สำหรับ Shopee chatbot (side-effect-free).

รวม detector/data ที่เป็น pure (ไม่แตะ DB/env/LLM/network) เพื่อให้ contract
module เช่น turn_decision.py ใช้ได้โดยไม่ดึง side effect ของ knowledge_base
(import-time _load_env) ติดมาด้วย.

Caller เดิมที่เรียกผ่าน knowledge_base.* ยังใช้ได้เหมือนเดิม — knowledge_base.py
re-export symbols ที่อยู่ที่นี่.
"""

from __future__ import annotations

import re


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


# ---- model detection (จากข้อความลูกค้า) ----


# ⚡ Phase 3 — target device keywords
# แบรนด์/รุ่นอุปกรณ์ที่ลูกค้ามักถามว่า "ใช้กับ ... ได้ไหม" หรือ "... อันไหน"
# ไม่ใช่ชื่อสินค้าในร้าน → ไม่ควรถูกจับเป็น model keyword
# (เช่น "ไอโฟน 11โปรแม๊กอันไหนคับ" → "11โปรแม๊ก" เป็น target device ไม่ใช่ model สินค้า)
_TARGET_DEVICE_KWS = {
    # Apple
    "iphone", "ไอโฟน", "ipad", "ไอแพด", "airpods", "apple", "แอปเปิล", "แอปเปิ้ล",
    "โปรแม็ก", "โปรแม๊ก", "promax", "โปร", "pro", "mini", "มินิ", "พลัส", "plus",
    "11", "12", "13", "14", "15", "16", "17",  # รุ่น iPhone เฉยๆ (ตัวเลขล้วน)
    # Samsung
    "samsung", "ซัมซุง", "galaxy", "กาแล็คซี่", "ultra", "อัลตร้า",
    # Xiaomi
    "xiaomi", "หมี่", "redmi", "poco",
    # อื่นๆ
    "huawei", "oppo", "vivo", "realme", "pixel", "oneplus",
    "note", "edge", "fe", "se",
}


def is_target_device_kw(kw: str) -> bool:
    """ตรวจว่า token นี้เป็นชื่ออุปกรณ์ (target device) ไม่ใช่ model สินค้าในร้าน.

    ใช้ใน CONV-ACTIVE check เพื่อแยก "11โปรแม๊ก" (target device)
    ออกจาก "AL870" (model สินค้าในร้าน) — กันไม่ให้ target device
    ถูกจับเป็น model keyword แล้วข้าม CONV-ACTIVE.

    Called by:
    - app.py CONV-ACTIVE block (บรรทัด ~2892) — กรอง target device ออกจาก _cur_model_kw
    - extract_model_keywords (ในไฟล์นี้) — กรอง target device ออกจาก candidates
    """
    low = kw.lower().strip()
    if low in _TARGET_DEVICE_KWS:
        return True
    # รุ่น iPhone เฉยๆ เช่น "11โปรแม็ก", "15พลัส", "13มินิ", "14pro"
    # ⚡ Phase 3 — ใช้ search แทน fullmatch เพื่อจับ token ที่มี target device อยู่ข้างใน
    # เช่น "11โปรแม๊กอันไหนคับ" (token เดียวไม่มี space แยก) ก็ถือว่าเป็น target device
    if re.search(r"\d+\s*(?:โปรแม็ก|โปรแม๊ก|promax|pro\b|mini|มินิ|พลัส|plus|อัลตร้า|ultra)", low):
        return True
    # "iphone" + ตัวเลข เช่น "iphone11", "iphone15promax", "ไอโฟน11โปรแม๊กอันไหนคับ"
    if re.search(r"iphone\s*\d+", low):
        return True
    # ⚡ "ไอโฟน" (Thai) + ตัวเลข เช่น "ไอโฟน13", "ไอโฟน13คะ", "ไอโฟน15โปรแม็ก"
    # (regex ด้านบนจับแค่ "iphone" ภาษาอังกฤษ ไม่จับ "ไอโฟน" ภาษาไทย)
    if re.search(r"ไอโฟน\s*\d+", low):
        return True
    # ⚡ ตัวเลขรุ่น iPhone (11-17) + คำลงท้ายไทย เช่น "13คะ", "15ครับ", "17นะ"
    # → ถือว่าเป็น target device (ลูกค้าพิมพ์เลขรุ่นติดกับคำสุภาพ/คำเสริม)
    # แต่ไม่จับตัวอักษรอังกฤษ เพราะ "A13" อาจเป็น model สินค้า
    if re.match(r"^1[1-7][\u0E00-\u0E7F]+$", low):
        return True
    return False


def extract_model_keywords(message: str) -> list[str]:
    """สกัดคำที่น่าจะเป็นชื่อรุ่นจากข้อความ.

    ใช้ regex หา pattern ที่ดูเหมือนชื่อรุ่น:
    - มีตัวเลข + ตัวอักษร (เช่น Redmi 9, Note 11, A52)
    - มีคำที่เป็นแบรนด์/รุ่นที่รู้จัก

    ⚡ Phase 3 — กรอง target device ออกจาก candidates
    (เช่น "11โปรแม๊ก" เป็นชื่ออุปกรณ์ ไม่ใช่ model สินค้าในร้าน)
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
                  "กี่", "ชิ้น", "ตัว", "อัน", "ชุด", "พร้อม", "ส่ง", "เก็บ", "ดีลิเวอรี",
                  # ⚡ version/region words — ไม่ใช่ชื่อรุ่น (กัน "Version" ดึง TP-Link "Global Version")
                  "version", "global", "china", "จีน", "ไทย", "cn", "us", "eu",
                  "korea", "เกาหลี", "ฮ่องกง", "hongkong", "hong", "kong",
                  "international", "local", "origin", "original", "authentic",
                  "ของ", "ของจริง", "แท้", "ลอก", "ของปลอม", "ปลอม", "รุ่น",
                  "อยากได้ของ", "ของจีน", "ของไทย", "ของglobal"}

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

    # ⚡ Phase 3 — กรอง target device ออกจาก candidates
    # "11โปรแม๊ก" เป็นชื่ออุปกรณ์ ไม่ใช่ model สินค้าในร้าน
    candidates = [c for c in candidates if not is_target_device_kw(c)]

    return candidates
