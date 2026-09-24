"""test_anger_detection_regression.py — 5F routing hardening: routing before retrieval.

pin (จาก probe จริง + QA รอบ 5, 2026-09-24 — ข้อความลูกค้า shopee จริง):
- product issue/troubleshoot ห้ามกลายเป็น customer_frustration handoff
  (mild marker "ช้ามาก/นานมาก/ไม่มีการตอบ" ผูกกับอาการสินค้า ไม่ใช่บ่นบริการ)
- neutral question ห้ามกลายเป็น human_request (รวม "แอด" vocative ท้ายคำถาม)
- greeting ร้าน/affiliate spam ห้ามกลายเป็น anger
- service complaint/human request จริงยังต้อง handoff
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat.handoffs import detect_human_request  # noqa: E402


def _handoff(message: str) -> dict | None:
    req = SimpleNamespace(message=message, conversation_id=None,
                          shop=None, ticket_state=None)
    return detect_human_request(req, {})


# ---------- ต้อง escalate: service complaint / anger จริง ----------

MUST_ESCALATE = [
    "รอมาสามวันแล้ว ไม่มีใครตอบเลย แย่มากครับ",
    "บริการหลังการขายแย่มากครับ",
    "ผิดหวังมากกกกกค่ะ และะต้องเสียเวลาอีก",
    "เห้ยช้าว่ะ จำไม่ได้เว้ย",
    "ตำไม่ได้ เช็คหน่อย หัวร้อนแล้วนะ",
    "คือระบบกากนะแบบนี้",
    "ภาพลักษณ์บริษัทคุณมันแย่มากเลยนะครับ ขาดความรับผิดชอบต่อลูกค้า",
    "ไม่มีใครตอบ จะไปซื้อร้านอื่นแล้วนะครับ",
    "ทักไปแล้วไม่มีคนตอบเลยครับ",
    "ส่งของช้ามากเลยครับ",          # service slowness — ต้องยังจับ
    "ตอบช้ามาก",                    # reply slowness bare → fire
]


@pytest.mark.parametrize("msg", MUST_ESCALATE)
def test_real_service_complaint_escalates(msg):
    out = _handoff(msg)
    assert out is not None and out["handoff_to_admin"] is True


# ---------- ห้าม escalate: อาการสินค้า (→ troubleshoot/claim) ----------

MUST_NOT_PRODUCT = [
    "ได้ชุดชาร์จ iPhone และลองเอามาชาร์จแล้วแต่ชาร์จช้ามากเลยผิดปกติ",
    "ชาร์จไม่ได้ช้ามากขอเคลม",
    "ทำไมชาร์จช้าจังครับ ทั้งที่ก็ขึ้นชาร์จด่วน 2.0",
    "มันกดได้ปกติครับแต่ไม่มีการตอบสนองของปุ่มกด",
    "เสียบชาร์จ นิ่งไม่มีการตอบสนองครับ",
    "หมุนนานมาก เชื่อมต่อไม่ได้คะ",
    "กว่าจะดึงภาพได้นานมาก",
    "ไม่มีการตอบสนอง",
    "เครื่องไม่ตอบสนองเลย",
    "ทำไมไม่ตอบสนองเลย",          # human-kw "ทำไมไม่ตอบ" จบกลางคำ "ตอบสนอง"
]


@pytest.mark.parametrize("msg", MUST_NOT_PRODUCT)
def test_product_issue_no_frustration_handoff(msg):
    assert _handoff(msg) is None


# ---------- ห้าม escalate: neutral / history / question ----------

MUST_NOT_NEUTRAL = [
    "เคยซื้อรุ่นนี้นานมากแล้ว ลืมวิธีการเข้าnetflixค่ะ",
    "ส่งช้าไหมครับ",
    "รอนานไหมคะ",
    "รอนานไหมครับแอด",            # คำถาม + vocative — ไม่ใช่ขอคุยกับคน
    "นาฬิกากันน้ำ ว่ายน้ำได้ไหมครับ",
    "นาฬิกากันรอยไหมครับ",
    "นาฬิกากี่กรัมครับ",
    "นาฬิกากล่องมีอะไรบ้างครับ",
    "นาฬิกากับกล้องเชื่อมกันได้ไหมครับ",
    "ขอเลขพัสดุที่ส่งนาฬิกากลับมาหน่อยครับ",
    "ควรใช้ที่ชาร์ทนาฬิกากระแสเท่าไรครับ",
    "วีธีเชื่อมนาฬิกากับไอโฟนต้องนำยังไง",
    "สอบถามครับตัวนาฬิกากันน้ำได้ประมาณไหนครับ",
    "เมื่อไรจะส่งนาฬิกากลับมาครับ",
]


@pytest.mark.parametrize("msg", MUST_NOT_NEUTRAL)
def test_neutral_question_no_handoff(msg):
    assert _handoff(msg) is None


# ---------- ห้าม escalate: greeting ร้าน / affiliate spam ----------

MUST_NOT_NOISE = [
    # auto-greeting ของร้านที่ถูกเก็บเป็นข้อความขาเข้า
    "สวัสดี ครับ ยินดีต้อนรับ มีอะไรสอบถามได้ครับ อาจจะตอบช้าหน่อยนะครับ",
    # affiliate spam — "เฮ้ย" จับตา ไม่ใช่โมโห
    "เฮ้ย imilabthailandofficial!รับคอมมิชชั่นง่าย ไม่ต้องถ่ายคลิป",
]


@pytest.mark.parametrize("msg", MUST_NOT_NOISE)
def test_noise_no_handoff(msg):
    assert _handoff(msg) is None


# ---------- claim intent ต้องไหลไป warranty flow ไม่ใช่ anger ----------

def test_claim_request_not_stolen_by_anger():
    # "ขอเคลม" ต้องไหลต่อไป warranty_flow (detect_human_request รันก่อน) —
    # ถ้า anger handoff กลืน claim จะไม่ถึง state machine
    assert _handoff("ชาร์จช้ามากขอเคลม") is None
    assert _handoff("ของเสียขอเคลม") is None


def test_service_slowness_still_fires_with_product_word():
    # product noun + service complaint ปนกัน → บริการชนะ (บ่นจริง)
    out = _handoff("สั่งสายชาร์จไปแล้วร้านส่งช้ามาก")
    assert out is not None
