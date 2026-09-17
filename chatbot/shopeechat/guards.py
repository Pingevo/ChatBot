"""guards.py — output guard + unit card flags (Task 9).

build_flags(card) — รวม flag fields ของ unit card เป็น dict เดียว (ไว้ใส่ context/decision)
check_output(answer, *, handoff_sent) — จับคำตอบที่ยืนยันเคลม/คืนเงิน/จัดส่ง
    โดยไม่มี handoff → return list ของ violation labels (ว่าง = ผ่าน)
"""
from __future__ import annotations

import re

_FLAG_KEYS = ("sellable", "has_warranty_info", "has_description", "oos_in_name")

# คำยืนยันเชิงผลลัพธ์ที่ bot ไม่ควรพูดเอง — ต้องมาจาก handoff/แอดมินเท่านั้น
# (เจาะจงคำยืนยัน "ให้แล้ว/จะคืน/ส่งแล้ว" — ไม่ใช่ข้อมูลเงื่อนไขทั่วไปอย่าง "รับประกัน 2 ปี")
_VIOLATION_RES = (
    ("claim_confirmed", re.compile(
        r"(ยืนยัน|อนุมัติ|รับเรื่อง|ดำเนินการ)\s*(การ)?(เคลม|claim)")),
    ("refund_confirmed", re.compile(
        r"(คืนเงิน|refund).{0,25}(ให้แล้ว|เรียบร้อย|ภายใน|เข้าบัญชี|จะได้รับ)"
        r"|(รอรับ|รับคืน)เงิน")),
    ("shipping_confirmed", re.compile(
        r"(จัดส่ง|ส่งของ|ส่งสินค้า|แพ็ค).{0,20}(แล้ว|เรียบร้อย|วันนี้|พรุ่งนี้)"
        r"|เลข\s*(พัสดุ|tracking)\s*[:：]")),
)


def build_flags(card: dict) -> dict:
    """ดึง flag fields จาก unit/product card → dict เดียว (ใช้ตัดสินใจ context/guard)."""
    return {k: bool(card.get(k)) for k in _FLAG_KEYS}


def check_output(answer: str, *, handoff_sent: bool = False) -> list[str]:
    """คืน list ของ violation ที่เจอใน answer — ว่าง = ผ่าน.

    handoff_sent=True → ข้ามเช็คทั้งหมด (แอดมินรับเรื่องแล้ว bot สื่อสารต่อได้)
    """
    if handoff_sent or not answer:
        return []
    return [name for name, rx in _VIOLATION_RES if rx.search(answer)]
