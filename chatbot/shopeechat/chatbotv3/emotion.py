"""emotion — ตรวจจับอารมณ์เสีย/ไม่พอใจของลูกค้า → handoff admin.

กฎ (ตามที่ user ขอ):
- ถ้าลูกค้าอารมณ์เสีย/อารมณ์ไม่ดี → ส่งต่อแอดมิน

⚠️ แยก "อารมณ์เสียจริง" จาก "บ่นเล่นๆ":
- "กาก ของแย่" → อารมณ์เสีย (โจมตีร้าน/สินค้า)
- "อืดจัง รอนาน" → อารมณ์เสีย (บ่นรอคอย)
- "โอเค ไม่เป็นไร" → ไม่ใช่อารมณ์เสีย
- "แพงไหม" → ไม่ใช่อารมณ์เสีย (ถามราคา)

⚠️ ต้องมีความรุนแรงพอ — ไม่ใช่แค่คำเดียว เช่น "บัค" ลอยๆ
   ต้องมี context บ่นจริง เช่น "บัคจัง ใช้ไม่ได้" หรือ "รอนานมาก ไม่ตอบ"
"""
from __future__ import annotations

import re


# ---- คำบอกอารมณ์เสีย (negative emotion) ----------------------------------------
# แบ่งเป็น 2 ระดับ: strong (ชัดเจน) + moderate (ต้องมี context)

# Strong — ชัดเจนว่าโกรธ/อารมณ์เสีย ไม่ต้องมี context เพิ่ม
_STRONG_NEGATIVE_KWS = (
    # คำหยาบ/ด่า
    "โกง", "โกงเงิน", "ลวง", "หลอก", "หลอกลวง", "หลอกกิน",
    "ควาย", "บ้า", "เวร", "ตาย", "ชั่ว",
    "ทุเราะ", "ทุเรศ", "ห่วย", "ขยะ", "ขยะแห้ง", "กาก", "กากมาก",
    "หลอกลวง", "มิจฉาชีพ", "ฉ้อโกง",
    # ข่มขู่/เรียกร้อง
    "ร้องเรียน", "ร้องทุกข์", "แจ้งความ", "ฟ้อง", "รายงาน",
    "ปิดร้าน", "แบน", "บล็อก",
    # ด่าร้าน/สินค้า รุนแรง
    "ร้านกาก", "ร้านห่วย", "ร้านขยะ", "ร้านโกง",
    "ของกาก", "ของห่วย", "ของขยะ", "ของปลอม",
    "ส่งของเสีย", "ส่งของพัง", "ส่งขยะ",
    # อารมณ์เสียรุนแรง
    "โกรธ", "โมโห", "ฉุน", "เดือด", "หน้าต่อตา",
    "ไม่พอใจมาก", "ไม่ยอม", "ไม่ปล่อย",
    "เรียกแอดมิน", "เรียกผู้จัดการ", "คุยกับเจ้าของ",
    "ขอเบอร์", "ขอเบอร์โทร", "ขอเบอร์ติดต่อ",
)

# Moderate — อารมณ์เสียปานกลาง ต้องมี context อื่นเสริม (เช่น ซ้ำ 2 ครั้งขึ้นไป)
_MODERATE_NEGATIVE_KWS = (
    "อืด", "ช้า", "รอนาน", "รอนานมาก", "รอตั้งนาน",
    "ไม่ตอบ", "ไม่ตอบข้อความ", "อ่านไม่ตอบ", "เห็นไม่ตอบ",
    "บัค", "error", "แอปแฮง", "แอปค้าง", "ระบบค้าง",
    "ใช้ไม่ได้", "ใช้ไม่ได้เลย", "ไม่ work",
    "เซอร์วิสแย่", "บริการแย่", "service แย่",
    "ไม่พอใจ", "ผิดหวัง", "ไม่คุ้ม", "เสียดาย",
    "เลิกซื้อ", "ไม่ซื้อแล้ว", "ไม่กล้าซื้อ",
    "ส่งช้า", "จัดส่งช้า", "กล่องบุบ", "กล่องพัง",
    "ของไม่ตรง", "ส่งผิด", "ส่งไม่ครบ",
)

# Negative context — คำที่เสริมว่าเป็นการบ่นจริง (ไม่ใช่ถาม)
_NEGATIVE_CONTEXT_KWS = (
    "มาก", "จัง", "มากเลย", "จริง", "จริงๆ",
    "เลย", "เลยนะ", "นะ", "ว่ะ", "วะ",
    "ไม่", "ไม่ได้", "ไม่เคย",
    "อีก", "อีกแล้ว", "ตลอด", "ทุกที",
)


def _contains_word(text: str, keyword: str) -> bool:
    """ตรวจว่ามี keyword ใน text แบบไม่ใช่ substring ของคำอื่น.

    สำหรับคำสั้นที่อาจเป็น substring ของคำอื่น เช่น "บ้า" ใน "บ้าง"
    ใช้วิธี exclude คำที่มี keyword เป็น substring แต่ไม่ใช่คำนั้นจริง
    """
    if not keyword or not text:
        return False
    # คำสั้นที่มักเป็น substring ของคำอื่น → ต้องกรอง false positive
    _SHORT_WORDS = {"บ้า", "ชั่ว", "ห่วย", "กาก", "บัค", "อืด", "ช้า", "ฟ้อง", "แบน"}
    if keyword in _SHORT_WORDS:
        # ถ้า keyword เป็น substring แต่อยู่ในคำที่ไม่ใช่ความหมายเดียวกัน → ไม่นับ
        _FALSE_POSITIVES = {
            "บ้า": ["บ้าง", "บ้าน", "บ้าย", "บ้ายบาย", "อุบาท", "อุบาทว์"],
            "ชั่ว": ["ชั่วโมง", "ชั่วคราว", "เชื่อมั่น", "เชื่อ", "ช่วง"],
            "ห่วย": ["ห่วง"],
            "กาก": ["กากบา", "กากะ", "กากับ", "กากี", "ประกาก", "ผลกาก", "กากน้ำ"],
            "บัค": ["บั๊ค", "บัคเก็ต", "บักเก็ต"],
            "อืด": ["อืดมือ", "อืดเฉี่ง"],
            "ช้า": ["ช้าง", "เช้า", "ช้าไป", "ช้าครั้ง"],
            "ฟ้อง": ["อ้อนวอน", "ฟ้อน"],
            "แบน": ["แบนเนอร์", "แบนด์", "แบนาน"],
        }
        fps = _FALSE_POSITIVES.get(keyword, [])
        # หาทุกจุดที่ keyword ปรากฏ แล้วเช็คว่าอยู่ใน false positive word ไหม
        idx = 0
        while True:
            pos = text.find(keyword, idx)
            if pos == -1:
                break
            # เช็คว่า keyword ที่ตำแหน่งนี้เป็นส่วนของ false positive word ไหม
            is_fp = False
            for fp in fps:
                fp_pos = text.find(fp, max(0, pos - len(fp) + len(keyword)))
                if fp_pos != -1 and fp_pos <= pos and pos + len(keyword) <= fp_pos + len(fp):
                    is_fp = True
                    break
            if not is_fp:
                return True
            idx = pos + 1
        return False
    # คำยาว → substring match ปกติพอ
    return keyword in text


def detect_negative_emotion(message: str, history: list[dict] | None = None) -> bool:
    """ตรวจว่าลูกค้าอารมณ์เสีย/ไม่พอใจ หรือไม่.

    Args:
        message: ข้อความลูกค้ารอบปัจจุบัน
        history: ประวัติแชท (ใช้ตรวจว่าบ่นซ้ำไหม)

    Returns:
        True ถ้าอารมณ์เสีย (ควร handoff admin)
        False ถ้าปกติ

    Logic:
        1. ถ้ามี strong keyword → True (ชัดเจน)
        2. ถ้ามี moderate keyword + negative context → True
        3. ถ้ามี moderate keyword ซ้ำ 2 ครั้งขึ้นไปใน history → True
        4. อย่างอื่น → False
    """
    if not message or not message.strip():
        return False

    msg_lower = message.lower().strip()

    # 1. Strong keyword → True เลย
    for kw in _STRONG_NEGATIVE_KWS:
        if _contains_word(msg_lower, kw):
            return True

    # 2. Moderate keyword + negative context
    has_moderate = any(_contains_word(msg_lower, kw) for kw in _MODERATE_NEGATIVE_KWS)
    has_context = any(kw in msg_lower for kw in _NEGATIVE_CONTEXT_KWS)
    if has_moderate and has_context:
        return True

    # 3. Moderate keyword ซ้ำใน history (ลูกค้าบ่นหลายรอบ)
    if has_moderate and history:
        _complaint_count = 0
        for h in history[-6:]:  # ดู 6 ข้อความล่าสุด
            h_text = (h.get("text", "") or "").lower()
            if any(_contains_word(h_text, kw) for kw in _MODERATE_NEGATIVE_KWS):
                _complaint_count += 1
        if _complaint_count >= 2:
            return True

    return False


def detect_human_request(message: str) -> bool:
    """ตรวจว่าลูกค้าขอคุยแอดมิน/คนจริง หรือไม่.

    Returns:
        True ถ้าขอคุยคน, False ถ้าไม่
    """
    if not message or not message.strip():
        return False
    msg_lower = message.lower().strip()

    _human_kws = (
        "คุยแอดมิน", "แอดมินคุย", "ขอแอดมิน", "แอดมินค่ะ", "แอดมินครับ",
        "คนตอบ", "ขอคน", "พูดกับคน", "คุยกับคน",
        "ไม่คุยบอท", "ไม่คุยกับบอท", "ไม่คุยบอต",
        "เรียกแอดมิน", "เรียกคน", "เรียกพนักงาน",
        "staff", "human", "agent", "operator",
        "เจ้าหน้าที่", "พนักงาน",
    )
    return any(kw in msg_lower for kw in _human_kws)
