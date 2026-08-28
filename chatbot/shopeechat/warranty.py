r"""ดึงระยะเวลารับประกันจากชื่อสินค้า.

ชื่อสินค้าใน Shopee มักมีรหัสรับประกันฝังอยู่ เช่น:
  - "Realme 5i ... ประกันศูนย์ไทย 1Y"
  - "LOGITECH G PRO X ... -2Y"
  - "Xiaomi Mi Note 10 Lite ... -15M"
  - "Tile Mate ... -12M"
  - "Xiaomi Mijia ... - 1Y"
  - "Xiaomi Mijia ... -12M"

Pattern ที่รองรับ:
  - ท้ายชื่อ: `[-\s]?(\d+)([yYmM])$` (เช่น -2Y, -15M, -12M, - 1Y, 1Y)
  - ใกล้คำ "ประกัน"/"warranty": `ประกัน.{0,15}?(\\d+)\\s*([yYmM])` หรือ `warranty.{0,15}?(\\d+)\\s*([yYmM])`

แปลงเป็นเดือน:
  - 1Y = 12 เดือน, 2Y = 24 เดือน, 3Y = 36 เดือน
  - 12M = 12 เดือน, 15M = 15 เดือน, 6M = 6 เดือน

หลีกเลี่ยง false positive:
  - ตัวเลขที่ไม่ใช่ warranty เช่น "5260mAh", "4/64GB", "3.5 นิ้ว", "65W"
  - ใช้ heuristic: ตัวเลขต้องตามด้วย Y/M ที่ท้ายชื่อ หรือใกล้คำว่า "ประกัน"
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Optional


# Pattern หลัก: ท้ายชื่อ เช่น "-2Y", "-15M", "- 1Y", " 1Y"
# รองรับ: optional space/dash ก่อนตัวเลข, ตัวเลข 1-3 หลัก, Y/y หรือ M/m ตัวเดียว
_TAIL_PATTERN = re.compile(
    r"[\-\s]+(\d{1,3})\s*([yYmM])\s*$"
)

# Pattern รอง: ใกล้คำ "ประกัน" หรือ "warranty" เช่น "ประกันศูนย์ไทย 1Y"
_NEAR_WARRANTY_PATTERN = re.compile(
    r"(?:ประกัน|warranty)[^0-9]{0,20}(\d{1,3})\s*([yYmM])\b",
    re.IGNORECASE,
)

# Pattern สำหรับกรณี "ประกัน 1 ปี" / "ประกัน 12 เดือน" (ภาษาไทย)
_THAI_WARRANTY_PATTERN = re.compile(
    r"ประกัน[^0-9]{0,20}(\d{1,3})\s*(ปี|เดือน|year|month)",
    re.IGNORECASE,
)

# ตัวเลขที่ตามด้วย unit อื่นที่ไม่ใช่ warranty — ใช้ตรวจเพื่อหลีกเลี่ยง false positive
# เช่น 5260mAh, 4/64GB, 3.5นิ้ว, 65W, 10000mAh
_FALSE_POSITIVE_PATTERN = re.compile(
    r"\d+(?:mAh|GB|mm|นิ้ว|W|kg|g|hz|Hz|MP|กรัม|กระ)",
    re.IGNORECASE,
)


def _unit_to_months(value: int, unit: str) -> int:
    """แปลง unit Y/M หรือ ปี/เดือน เป็นจำนวนเดือน."""
    u = unit.lower()
    if u in ("y", "year", "ปี"):
        return value * 12
    if u in ("m", "month", "เดือน"):
        return value
    return 0


def extract_warranty_from_name(item_name: str) -> Optional[dict]:
    """ดึงระยะเวลารับประกันจากชื่อสินค้า.

    Args:
        item_name: ชื่อสินค้า เช่น "Realme 5i ... ประกันศูนย์ไทย 1Y"

    Returns:
        dict ที่มี:
        - months: จำนวนเดือน (int) เช่น 24
        - raw: pattern ที่ match เช่น "2Y"
        - text: ข้อความที่อ่านง่าย เช่น "2 ปี" หรือ "15 เดือน"
        - source: "tail" | "near_warranty" | "thai"
        หรือ None ถ้าดึงไม่ได้
    """
    if not item_name or not item_name.strip():
        return None

    name = item_name.strip()

    # 1) ลอง pattern ท้ายชื่อก่อน (เช่น "-2Y", "-15M", "- 1Y")
    m = _TAIL_PATTERN.search(name)
    if m:
        value = int(m.group(1))
        unit = m.group(2)
        # ตรวจ false positive: ถ้าตัวเลขเกิน 60 ปี หรือเกิน 120 เดือน น่าจะไม่ใช่ warranty
        if 1 <= value <= 10 and unit.lower() == "y":
            months = _unit_to_months(value, unit)
            return {
                "months": months,
                "raw": f"{value}{unit}",
                "text": f"{value} ปี" if value > 1 else "1 ปี",
                "source": "tail",
            }
        if 1 <= value <= 60 and unit.lower() == "m":
            months = _unit_to_months(value, unit)
            years = months // 12
            rem = months % 12
            if rem == 0 and years > 0:
                text = f"{years} ปี" if years > 1 else "1 ปี"
            else:
                text = f"{months} เดือน"
            return {
                "months": months,
                "raw": f"{value}{unit}",
                "text": text,
                "source": "tail",
            }

    # 2) ลอง pattern ใกล้คำ "ประกัน"/"warranty" (เช่น "ประกันศูนย์ไทย 1Y")
    m = _NEAR_WARRANTY_PATTERN.search(name)
    if m:
        value = int(m.group(1))
        unit = m.group(2)
        if 1 <= value <= 10 and unit.lower() == "y":
            months = _unit_to_months(value, unit)
            return {
                "months": months,
                "raw": f"{value}{unit}",
                "text": f"{value} ปี" if value > 1 else "1 ปี",
                "source": "near_warranty",
            }
        if 1 <= value <= 60 and unit.lower() == "m":
            months = _unit_to_months(value, unit)
            years = months // 12
            rem = months % 12
            if rem == 0 and years > 0:
                text = f"{years} ปี" if years > 1 else "1 ปี"
            else:
                text = f"{months} เดือน"
            return {
                "months": months,
                "raw": f"{value}{unit}",
                "text": text,
                "source": "near_warranty",
            }

    # 3) ลอง pattern ภาษาไทย "ประกัน 1 ปี" / "ประกัน 12 เดือน"
    m = _THAI_WARRANTY_PATTERN.search(name)
    if m:
        value = int(m.group(1))
        unit = m.group(2).lower()
        months = _unit_to_months(value, unit)
        if months > 0 and months <= 120:
            if unit in ("y", "year", "ปี"):
                text = f"{value} ปี" if value > 1 else "1 ปี"
            else:
                text = f"{value} เดือน"
            return {
                "months": months,
                "raw": f"{value} {unit}",
                "text": text,
                "source": "thai",
            }

    return None


def is_in_warranty(purchase_date: datetime, warranty_months: int, now: Optional[datetime] = None) -> dict:
    """คำนวณว่ายังอยู่ในช่วงประกันไหม.

    Args:
        purchase_date: วันที่ลูกค้าซื้อสินค้า
        warranty_months: ระยะเวลาประกัน (เดือน)
        now: วันปัจจุบัน (default = today)

    Returns:
        dict:
        - in_warranty: bool
        - expiry_date: datetime (วันที่ประกันหมด)
        - days_remaining: int (จำนวนวันที่เหลือ ถ้ายังอยู่ในช่วง; ถ้าหมดแล้วเป็นลบ)
        - text: ข้อความสรุป เช่น "ยังอยู่ในช่วงประกัน (เหลือ 45 วัน)" หรือ "หมดช่วงประกันแล้ว"
    """
    if now is None:
        now = datetime.now()
    expiry = purchase_date + timedelta(days=warranty_months * 30)
    delta = (expiry - now).days
    in_warranty = delta > 0
    if in_warranty:
        if delta > 60:
            months_left = delta // 30
            text = f"ยังอยู่ในช่วงประกัน (เหลือประมาณ {months_left} เดือน)"
        else:
            text = f"ยังอยู่ในช่วงประกัน (เหลือ {delta} วัน)"
    else:
        text = f"หมดช่วงประกันแล้ว (หมดเมื่อวันที่ {expiry.strftime('%d/%m/%Y')})"
    return {
        "in_warranty": in_warranty,
        "expiry_date": expiry,
        "days_remaining": delta,
        "text": text,
    }


def parse_purchase_date(text: str) -> Optional[datetime]:
    """แปลงข้อความวันที่เป็น datetime — รองรับหลายรูปแบบ.

    รองรับ:
    - 15/1/2024, 15-01-2024, 2024-01-15
    - 15 ม.ค. 2024, 15 มกราคม 2567
    - 15 Jan 2024, January 15 2024
    - "ซื้อมาวันที่ 15/1/2024" (strip คำนำหน้าออกก่อน)
    """
    if not text:
        return None
    text = text.strip()
    # strip คำนำหน้าที่ไม่ใช่วันที่ ออกก่อน
    # เช่น "ซื้อมาวันที่ 24/6/2026" → "24/6/2026"
    # เช่น "ซื้อวันที่ 15 มกราคม 2567" → "15 มกราคม 2567"
    prefixes = [
        "ซื้อมาวันที่", "ซื้อวันที่", "วันที่ซื้อ", "วันที่ ซื้อ",
        "ซื้อเมื่อวันที่", "ตอนซื้อ", "purchase date", "bought on",
        "bought", "ซื้อ", "วันที่", "เมื่อ", "ชื้อมา", "ชื้อ",
    ]
    cleaned = text
    for p in prefixes:
        if cleaned.lower().startswith(p.lower()):
            cleaned = cleaned[len(p):].strip()
    # ถ้ายังมีคำนำหน้าอยู่ ลองหา pattern วันที่ในข้อความโดยตรง
    # ลองหา pattern วันที่ในข้อความ — ใช้ cleaned ก่อน ถ้าไม่เจอลอง text เต็ม
    m = re.search(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b", cleaned)
    if m:
        cleaned = m.group(0)
    else:
        m = re.search(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b", text)
        if m:
            cleaned = m.group(0)
        else:
            # ลองหา pattern "X เดือน Y" หรือ "X month year"
            m = re.search(r"\d{1,2}\s+\S+\s+\d{2,4}", cleaned)
            if m:
                cleaned = m.group(0)
            else:
                m = re.search(r"\d{1,2}\s+\S+\s+\d{2,4}", text)
                if m:
                    cleaned = m.group(0)
    # แปลงเดือนภาษาไทยก่อน
    thai_months = {
        "ม.ค.": "01", "มกราคม": "01", "ก.พ.": "02", "กุมภาพันธ์": "02",
        "มี.ค.": "03", "มีนาคม": "03", "เม.ย.": "04", "เมษายน": "04",
        "พ.ค.": "05", "พฤษภาคม": "05", "มิ.ย.": "06", "มิถุนายน": "06",
        "ก.ค.": "07", "กรกฎาคม": "07", "ส.ค.": "08", "สิงหาคม": "08",
        "ก.ย.": "09", "กันยายน": "09", "ต.ค.": "10", "ตุลาคม": "10",
        "พ.ย.": "11", "พฤศจิกายน": "11", "ธ.ค.": "12", "ธันวาคม": "12",
    }
    text_lower = cleaned.lower()
    for thai, num in thai_months.items():
        if thai in text_lower:
            text_lower = text_lower.replace(thai, num)
    # แปลงปี พ.ศ. → ค.ศ. (ถ้าปี > 2500)
    formats = [
        "%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d",
        "%d/%m/%y", "%d-%m-%y",
        "%d %m %Y", "%d %m %y",
        "%d.%m.%Y", "%d.%m.%y",
    ]
    for fmt in formats:
        try:
            dt = datetime.strptime(text_lower, fmt)
            # แปลงปี พ.ศ. → ค.ศ. (ถ้าปี > 2500)
            if dt.year > 2500:
                dt = dt.replace(year=dt.year - 543)
            return dt
        except ValueError:
            continue
    return None


# ---- คำที่เกี่ยวกับ warranty/claim ที่ต้อง strip ออกจากคำถาม ----
# ใช้ตอน build_query เพื่อแยก "ชื่อสินค้า" ออกจาก "คำถามรับประกัน"
_WARRANTY_KEYWORDS = [
    # ไทย
    "รับประกัน", "ประกัน", "เคลม", "การรับประกัน", "ระยะเวลารับประกัน",
    "กี่ปี", "กี่เดือน", "นานแค่ไหน", "ระยะเวลา", "ศูนย์ไทย", "ศูนย์บริการ",
    "การเคลม", "เคลมยังไง", "เคลมไง", "ส่งเคลม", "เคลมได้ไหม",
    # อังกฤษ
    "warranty", "claim", "guarantee", "how long",
]
# คำถามสั้นที่มีแค่ warranty keyword ไม่มีชื่อสินค้า
_PURE_WARRANTY_QUERIES = {
    "รับประกัน", "ประกัน", "เคลม", "รับประกันไหม", "รับประกันกี่ปี",
    "รับประกันกี่เดือน", "เคลมยังไง", "เคลมไง", "warranty", "claim",
}


def strip_warranty_keywords(message: str) -> str:
    """ตัดคำ warranty/claim ออกจากคำถาม เพื่อให้เหลือแค่ "ชื่อสินค้า".

    ใช้ใน build_query ตอน warranty intent เพื่อแยกชื่อสินค้าออกจากคำถามรับประกัน
    เช่น "LOGITECH G PRO X รับประกันกี่ปีคะ" → "LOGITECH G PRO X"

    Args:
        message: คำถามลูกค้า เช่น "LOGITECH G PRO X รับประกันกี่ปีคะ"

    Returns:
        ชื่อสินค้าที่ strip แล้ว หรือ "" ถ้าคำถามมีแค่ warranty keyword ไม่มีชื่อสินค้า
    """
    if not message:
        return ""
    msg = message.strip()
    # ถ้าคำถามสั้นและเป็น pure warranty query → คืน ""
    if msg.lower() in _PURE_WARRANTY_QUERIES:
        return ""
    # strip warranty keywords (เรียงจากยาว → สั้น เพื่อกันตัดผิด)
    sorted_kw = sorted(_WARRANTY_KEYWORDS, key=len, reverse=True)
    cleaned = msg
    for kw in sorted_kw:
        # ตัดทั้งแบบมี space และไม่มี space รอบๆ
        cleaned = re.sub(r"\s*" + re.escape(kw) + r"\s*", " ", cleaned, flags=re.IGNORECASE)
    # ตัดคำถามทั่วไปออก (กี่/ไหม/ไง/คะ/ครับ/นะ/จ้ะ/ไหม/บ้าง)
    cleaned = re.sub(r"\s*(กี่|ไหม|ไง|คะ|ครับ|นะ|จ้ะ|บ้าง|อะไร|ยังไง|เท่าไหร่|ได้ไหม)\s*", " ", cleaned, flags=re.IGNORECASE)
    # collapse multiple spaces
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # ถ้าเหลือแค่คำสั้นๆ (1-2 ตัวอักษร) หรือ empty → คืน ""
    if len(cleaned) < 3:
        return ""
    return cleaned


# ============================================================================
# Warranty Claim State Machine
# ============================================================================
# Flow ใหม่สำหรับ warranty claim:
#   1. duration_question: "imilab ec4 รับประกันกี่ปี" → บอทตอบ "2 ปีค่ะ"
#   2. claim_request: ลูกค้าบอกสินค้าเสีย/ปัญหา/อยากเคลม/ซ่อม
#      → บอทถาม "ซื้อมาตอนไหนคะ และขอเลขที่คำสั่งซื้อด้วยค่ะ"
#   3. date_collected: ลูกค้าให้วันที่ + เลขคำสั่งซื้อ
#      → บอทคำนวณใน/นอกช่วงประกัน
#      → ถ้าในช่วง: ถาม "ขอชื่อ-นามสกุล เบอร์โทร เลขที่คำสั่งซื้อ และหัวข้อที่ลูกค้าทักมาค่ะ"
#      → ถ้านอกช่วง: บอก "ไม่อยู่ในช่วงประกันแล้วนะคะ สนใจปรึกษาแอดมินก่อนไหมคะ"
#   4. out_of_warranty_consult: ลูกค้าตอบสนใจ → บอทส่งต่อแอดมิน
#   5. info_collection: ลูกค้าให้ข้อมูล → บอททวน + ถามยืนยัน
#   6. confirm_review: ลูกค้ายืนยัน → บอทส่งต่อแอดมิน
# ============================================================================

from typing import Literal
from dataclasses import dataclass, field as _field

WarrantyClaimState = Literal[
    "idle",                       # ไม่ได้อยู่ใน warranty claim flow
    "duration_question",          # ถาม "รับประกันกี่ปี" (ตอบไปแล้ว)
    "awaiting_claim_request",     # ตอบ duration แล้ว รอลูกค้าบอกปัญหา/เคลม
    "awaiting_purchase_date",     # บอทถามวันที่ซื้อ รอลูกค้าตอบ
    "awaiting_customer_info",     # บอทถาม ชื่อ+เบอร์+เลขคำสั่งซื้อ+หัวข้อ รอลูกค้าตอบ
    "awaiting_confirmation",      # บอททวนข้อมูล รอลูกค้ายืนยัน
    "out_of_warranty_consult",    # นอกช่วงประกัน ถามลูกค้าว่าสนใจปรึกษาแอดมินไหม
    "handoff_complete",           # ส่งต่อแอดมินแล้ว
]


@dataclass
class WarrantyClaimContext:
    """เก็บ state ของ warranty claim flow ระหว่าง conversation."""
    state: WarrantyClaimState = "idle"
    product_name: str = ""           # ชื่อสินค้าที่ลูกค้าถาม
    warranty_months: int = 0         # ระยะเวลาประกัน (เดือน)
    warranty_text: str = ""          # "2 ปี" ฯลฯ
    purchase_date: str = ""          # วันที่ซื้อ (string ที่ลูกค้าให้มา)
    order_id: str = ""               # เลขที่คำสั่งซื้อ
    customer_name: str = ""          # ชื่อ-นามสกุล
    customer_phone: str = ""         # เบอร์โทร
    claim_topic: str = ""            # หัวข้อ: เคลม/ซ่อม/ประกัน
    in_warranty: bool | None = None  # ผลการคำนวณ
    days_remaining: int = 0
    expiry_date: str = ""

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "product_name": self.product_name,
            "warranty_months": self.warranty_months,
            "warranty_text": self.warranty_text,
            "purchase_date": self.purchase_date,
            "order_id": self.order_id,
            "customer_name": self.customer_name,
            "customer_phone": self.customer_phone,
            "claim_topic": self.claim_topic,
            "in_warranty": self.in_warranty,
            "days_remaining": self.days_remaining,
            "expiry_date": self.expiry_date,
        }


# คำที่บอกว่าลูกค้าอยากเคลม/ซ่อม/สินค้าเสีย
_CLAIM_REQUEST_INDICATORS = [
    "เคลม", "ซ่อม", "เสีย", "พัง", "ไม่ทำงาน", "ใช้ไม่ได้",
    "มีปัญหา", "เสียหาย", "ไม่เปิด", "ไม่ติด", "ค้าง",
    "แบตเสีย", "จอเสีย", "ปุ่มเสีย", "น้ำเข้า", "ตก",
    "ส่งเคลม", "เคลมยังไง", "เคลมไง", "ซ่อมยังไง", "ซ่อมไง",
    "ประกันสินค้า", "เรื่องประกัน", "สอบถามเรื่องประกัน",
    "สอบถามประกัน", "เรื่องเคลม", "เรื่องซ่อม",
]

# คำที่บอกว่าลูกค้าสนใจปรึกษาแอดมิน (หลังนอกช่วงประกัน)
_CONSENT_INDICATORS = [
    "สนใจ", "โอเค", "ok", "okay", "ค่ะ", "ครับ", "ได้ค่ะ", "ได้ครับ",
    "ดีค่ะ", "ดีครับ", "อยาก", "ช่วย", "ปรึกษา", "ว่าไง",
    "yes", "y", "ตกลง", "ยินดี", "ลอง",
]

# คำที่บอกว่าลูกค้าปฏิเัต (ไม่สนใจ)
_DECLINE_INDICATORS = [
    "ไม่", "ไม่สนใจ", "ไม่เป็นไร", "ไม่ต้อง", "ป่าว", "no", "n",
    "ไม่ดี", "ไม่อยาก", "ไม่ละ", "ไม่ก็ได้",
]


def detect_claim_request(message: str) -> bool:
    """ตรวจว่าลูกค้าอยากเคลม/ซ่อม/สินค้าเสีย หรือไม่."""
    msg_lower = message.lower()
    return any(ind in msg_lower for ind in _CLAIM_REQUEST_INDICATORS)


def detect_consent(message: str) -> bool:
    """ตรวจว่าลูกค้าสนใจ/ยินยอม หรือไม่."""
    msg_lower = message.lower().strip()
    # ถ้าปฏิเสธชัดเจน → ไม่สนใจ
    if any(ind in msg_lower for ind in _DECLINE_INDICATORS):
        return False
    return any(ind in msg_lower for ind in _CONSENT_INDICATORS)


def detect_confirmation(message: str) -> bool:
    """ตรวจว่าลูกค้ายืนยันข้อมูลถูกต้อง หรือไม่."""
    msg_lower = message.lower().strip()
    if any(ind in msg_lower for ind in _DECLINE_INDICATORS):
        return False
    confirm_words = [
        "ถูกต้อง", "ใช่", "ค่ะ", "ครับ", "yes", "y", "ok", "okay",
        "โอเค", "ใช่แล้ว", "ถูกแล้ว", "ตกลง", "ยืนยัน", "ได้ค่ะ", "ได้ครับ",
        "ดีค่ะ", "ดีครับ", "ครับผม", "ค่ะคุณ",
    ]
    return any(w in msg_lower for w in confirm_words)


# Pattern สำหรับดึงข้อมูลจากข้อความลูกค้า
_PHONE_PATTERN = re.compile(r"\b0\d{8,9}\b")
# เลขคำสั่งซื้อ Shopee มัก 9-16 หลัก อาจมี suffix เช่น "123456789shp"
_ORDER_ID_PATTERN = re.compile(r"\b\d{9,16}(?:[a-zA-Z]{1,5})?\b")

# โหลด NER (lazy load — โหลดครั้งแรกที่เรียกใช้)
_NER_INSTANCE = None


def _get_ner():
    """โหลด ThaiNameTagger แบบ lazy (โหลดครั้งเดียว)."""
    global _NER_INSTANCE
    if _NER_INSTANCE is None:
        try:
            from pythainlp.tag import NER
            _NER_INSTANCE = NER(engine="thainer")
        except Exception:
            _NER_INSTANCE = False  # mark as unavailable
    return _NER_INSTANCE if _NER_INSTANCE is not False else None


def _extract_name_ner(message: str) -> str:
    """ดึงชื่อบุคคลจากข้อความด้วย pythainlp NER.

    Returns:
        ชื่อที่ NER จับได้ (รวม B-PERSON/I-PERSON) หรือ "" ถ้าไม่พบ
    """
    ner = _get_ner()
    if ner is None:
        return ""
    try:
        entities = ner.tag(message)
    except Exception:
        return ""
    # รวม B-PERSON/I-PERSON ที่ติดกันเป็นชื่อเดียว
    person_parts = []
    for t, tag in entities:
        if tag in ("B-PERSON", "I-PERSON"):
            person_parts.append(t)
        elif person_parts and tag != "I-PERSON":
            break
    name = "".join(person_parts).strip()
    # ── post-process ชื่อที่ NER ส่งกลับ ──
    # 1) ลบคำสุภาพ/คำอุทานท้ายชื่อ (NER อาจจับ "ครับผม" ติดมา)
    name = re.sub(
        r"\s+[้่๊๋ั]?คร[่้๊๋ัิ]?[บ]+\s*ผม\s*$|"
        r"\s+[้่๊๋ั]?คร[่้๊๋ัิ]?[บ]+\s*$|"
        r"\s+[้่๊๋ั]?ค[่้๊๋ั]?ะ*\s*$|"
        r"\s+น[่้๊๋ัะ]?ะ+\s*$|"
        r"\s+จ[่้๊๋ัะ]?ะ+\s*$|"
        r"\s+ผม\s*$|"
        r"\s+ครับผม\s*$",
        "", name
    ).strip()
    # 2) ถ้าชื่อยาวเกิน 40 ตัวอักษร → น่าจะจับผิด (เป็นประโยค) ให้คืน ""
    if len(name) > 40:
        return ""
    # 3) ถ้าชื่อมีคำว่า "มัน"/"ต้อง"/"มี"/"ทำ"/"บ้าง" → ไม่ใช่ชื่อ คืน ""
    _non_name_words = ("มัน", "ต้อง", "มี", "ทำ", "บ้าง", "หรือ", "ยัง", "อยาก")
    if any(w in name for w in _non_name_words):
        return ""
    # 4) กรอง: ชื่อต้องมีอย่างน้อย 2 ตัวอักษร และไม่ใช่แค่ตัวเลข
    if len(name) < 2 or name.isdigit():
        return ""
    return name


# Pattern สำหรับชื่ออังกฤษ (fallback ถ้า NER ไม่จับ)
# รูปแบบ: Firstname Lastname (2 คำ ที่เป็นตัวอักษรอังกฤษ ขึ้นต้นด้วยตัวใหญ่)
_ENGLISH_NAME_PATTERN = re.compile(
    r"\b([A-Z][a-zA-Z]{1,20}(?:\s+[A-Z][a-zA-Z]{1,20}){1,3})\b"
)


def extract_customer_info(message: str) -> dict:
    """ดึงข้อมูลลูกค้าจากข้อความ: ชื่อ, เบอร์โทร, เลขคำสั่งซื้อ.

    ใช้ pythainlp NER เป็นหลักในการดึงชื่อ (จับมั่นยิ่งกว่า regex)
    ถ้า NER ไม่พบ จะ fallback ไปใช้ regex แบบเดิม

    Returns:
        dict: {name, phone, order_id} — ค่าที่ดึงไม่ได้เป็น ""
    """
    if not message:
        return {"name": "", "phone": "", "order_id": ""}
    msg = message.strip()
    # ดึงเบอร์โทร (0xxxxxxxxx หรือ 0xx-xxx-xxxx)
    phone_match = _PHONE_PATTERN.search(msg.replace("-", ""))
    phone = phone_match.group(0) if phone_match else ""
    # ดึงเลขคำสั่งซื้อ (เลข 9-16 หลัก ที่ไม่ใช่เบอร์โทร)
    order_id = ""
    for m in _ORDER_ID_PATTERN.finditer(msg.replace("-", "")):
        candidate = m.group(0)
        if candidate != phone and len(candidate) >= 10:
            order_id = candidate
            break

    # ── ดึงชื่อด้วย NER (หลัก) ──
    name = _extract_name_ner(msg)

    # ── Fallback: ชื่ออังกฤษ (NER ไทยอาจไม่จับ) ──
    if not name:
        en_match = _ENGLISH_NAME_PATTERN.search(msg)
        if en_match:
            name = en_match.group(1).strip()

    # ── Fallback: regex แบบเดิม (กรณี NER ไม่ทำงาน/ไม่จับ) ──
    if not name:
        cleaned = msg
        if phone:
            cleaned = cleaned.replace(phone, "")
        if order_id:
            cleaned = cleaned.replace(order_id, "")
        # ลบคำเชื่อมต่อทั่วไป และคำที่ไม่ใช่ชื่อ
        cleaned = re.sub(
            r"\s*(ชื่อ|name|เบอร์|phone|tel|เลขที่คำสั่งซื้อ|order|คำสั่งซื้อ|เลขคำสั่งซื้อ|หัวข้อ|topic|เรื่อง|:|ประกัน|เคลม|ซ่อม|เสีย|พัง|claim|warranty|แจ้ง|รบกวน|สินค้า|อาการ|ปัญหา)\s*",
            " ", cleaned, flags=re.IGNORECASE
        )
        # ลบคำอุทาน/คำสุภาพ (จับกว้าง รวมพิมพ์ผิด/พิมพ์ยาว)
        cleaned = re.sub(
            r"\s*[้่๊๋ั]?คร[่้๊๋ัิ]?[บ]+\s*|"
            r"\s*[้่๊๋ั]?คร[่้๊๋ั]?า[ยบ]+\s*|"
            r"\s*[้่๊๋ั]?ค[ั่้๊๋]?[บ]+\s*|"
            r"\s*[้่๊๋ั]?ค[่้๊๋]?า[บ]+\s*|"
            r"\s*[้่๊๋ั]?ค[่้๊๋ั]?ะ*\s*|"
            r"\s*น[่้๊๋ัะ]?ะ+\s*คร[่้๊๋ัิ]?[บ]+\s*|"
            r"\s*น[่้๊๋ัะ]?ะ+\s*ค[่้๊๋ั]?ะ*\s*|"
            r"\s*น[่้๊๋ัะ]?ะ+\s*|"
            r"\s*จ[่้๊๋ัะ]?ะ+\s*|"
            r"\s*[้่๊๋ั]?คร[่้๊๋ัิ]?(?!\S)\s*",
            " ", cleaned
        )
        # ลบคำพูดทั่วไป
        _noise_phrases = [
            "ผมชื่อแค่", "ชื่อแค่", "ผมชื่อ", "ชื่อผม", "ฉันชื่อ", "ชื่อฉัน",
            "ก็ข้างบนไง", "ข้างบนไง", "แต้งไปแล้ว", "แต้ง", "ข้างบน",
            "บอกไปแล้ว", "บอกไป", "แจ้งไปแล้ว", "แจ้งไป", "ส่งไปแล้ว",
            "ไง", "อะ", "ครัย",
            "ผม", "ฉัน", "แค่", "คือ", "อ่ะ", "เอ่อ",
        ]
        for phrase in _noise_phrases:
            cleaned = cleaned.replace(phrase, " ")
        # ลบวันที่ออกจากชื่อ
        cleaned = re.sub(r"\b\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}\b", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        # ถ้า cleaned ยาวเกิน 40 ตัวอักษร หรือมีคำที่ไม่ใช่ชื่อ → ไม่ใช่ชื่อ
        _non_name_words = ("มัน", "ต้อง", "มี", "ทำ", "บ้าง", "หรือ", "ยัง", "อยาก", "กลิ่น", "ไหม้")
        if (
            len(cleaned) >= 2
            and not cleaned.isdigit()
            and len(cleaned) <= 40
            and not any(w in cleaned for w in _non_name_words)
        ):
            name = cleaned

    return {"name": name, "phone": phone, "order_id": order_id}


def detect_purchase_date_and_order(message: str) -> dict:
    """ดึงวันที่ซื้อและเลขคำสั่งซื้อจากข้อความลูกค้า.

    Returns:
        dict: {purchase_date: datetime|None, order_id: str}
    """
    if not message:
        return {"purchase_date": None, "order_id": ""}
    purchase_date = parse_purchase_date(message)
    order_id = ""
    # ดึงเลขคำสั่งซื้อ — เป็นเลขล้วน 10-16 หลัก (ไม่ใช่วันที่)
    # ตัดวันที่ออกก่อน เพื่อกัน pattern ไปจับตัวเลขในวันที่
    msg_cleaned = re.sub(r"\b\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}\b", "", message)
    msg_cleaned = msg_cleaned.replace("-", "")
    for m in _ORDER_ID_PATTERN.finditer(msg_cleaned):
        candidate = m.group(0)
        if len(candidate) >= 10:
            order_id = candidate
            break
    return {"purchase_date": purchase_date, "order_id": order_id}


def detect_warranty_duration_question(message: str) -> bool:
    """ตรวจว่าเป็นคำถาม "รับประกันกี่ปี" หรือไม่."""
    msg_lower = message.lower()
    # ต้องมี warranty keyword + คำถาม "กี่ปี/กี่เดือน/นานแค่ไหน" หรือ "รับประกัน" อย่างเดียว
    has_warranty = any(kw in msg_lower for kw in ["รับประกัน", "ประกัน", "warranty", "เคลม", "claim"])
    has_duration_q = any(kw in msg_lower for kw in ["กี่ปี", "กี่เดือน", "นานแค่ไหน", "ระยะเวลา", "how long"])
    # กรณี "imilab ec4 รับประกันกี่ปี" — มีทั้งสินค้าและ warranty
    return has_warranty and (has_duration_q or "รับประกัน" in msg_lower or "ประกัน" in msg_lower)

