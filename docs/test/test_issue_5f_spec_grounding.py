"""test_issue_5f_spec_grounding.py — Phase 5F-D: spec/warranty/compat grounding.

Root cause 2 ชั้น:
1) SYSTEM_INSTRUCTION มีตัวอย่างคำตอบที่ใส่ literal จริง (5200mAh, IP68, iOS 13,
   22 มม., ชื่อรุ่นจริงในร้าน) → LLM ยืมเลข/ชื่อไปตอบแม้ context ไม่มี = hallucinate
2) guards.enforce มี model_claim (token รุ่น) แต่ไม่มีเช็กเลข+หน่วย spec —
   เลข spec ที่ไม่มีใน context pool ผ่าน guard ได้

Fix: ตัวอย่างต้องเป็น placeholder + spec_claim check เทียบ context pool
(cards/grounding_text/message/history) — generic ไม่ hardcode รุ่น/ค่าใด
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import guards, llm  # noqa: E402


def _resp(answer, products=None, grounding="", source="product_info"):
    return SimpleNamespace(
        answer=answer,
        answer_segments=None,
        handoff_to_admin=False,
        source=source,
        routing_decision={"grounding_text": grounding} if grounding else {},
        products=products or [],
    )


def _req(message="", history=None):
    return SimpleNamespace(message=message, history=history or [])


# ---------- 1) prompt hygiene: ตัวอย่างห้ามมี literal ที่ยืมไปตอบได้ ----------

_PROMPTS = (llm.SYSTEM_INSTRUCTION, llm.KB_SYSTEM_INSTRUCTION)


@pytest.mark.parametrize("lit", [
    "5200mAh", "IP68", "iOS 13", "6.7 นิ้ว", "22 มม", "100 วัน",
    "รับประกัน 1 ปี", "รับประกัน 2 ปี",
    # H3 — reasoning guidance ก็ห้ามมีเลข spec ที่ยืมไปตอบได้
    "45W", "65W", "100W", "140W", "20W", "30W",
])
def test_prompt_no_borrowable_spec_literals(lit):
    for i, p in enumerate(_PROMPTS):
        assert lit not in p, (
            f"prompt[{i}] ยังมี spec literal {lit!r} ในตัวอย่าง — LLM ยืมไปตอบได้")


@pytest.mark.parametrize("lit", [
    "CUKTECH P23", "PB200N", "LPB100", "Lagenio K9", "Lagenio K3",
    "IMILAB EC4", "SC230", "BioKoop",
])
def test_prompt_no_real_product_names(lit):
    for i, p in enumerate(_PROMPTS):
        assert lit not in p, (
            f"prompt[{i}] ยังมีชื่อสินค้าจริง {lit!r} — LLM ยืมชื่อไปตอบได้")


# ---------- 2) spec_claim guard: เลข+หน่วย spec ต้องอยู่ใน context pool ----------

def test_ungrounded_ip_rating_rewritten():
    r = _resp(
        "รุ่นนี้กันน้ำมาตรฐาน IP68 ค่ะ ใส่ว่ายน้ำได้เลย",
        products=[{"name": "Watch A",
                   "description_excerpt": "สมาร์ทวอทช์ หน้าจอ AMOLED"}])
    guards.enforce(r, _req("นาฬิกากันน้ำไหม"))
    assert "IP68" not in r.answer
    assert r.routing_decision.get("guard_rewritten") == "spec_claim"


def test_ungrounded_battery_claim_rewritten():
    # pattern เดียวกับ prompt example เดิม — เลข mAh + วัน ที่ context ไม่มี
    r = _resp(
        "รุ่นนี้แบต 5200mAh ค่ะ ชาร์จครั้งเดียวใช้ได้ 100 วัน",
        products=[{"name": "Watch A", "description_excerpt": "สมาร์ทวอทช์"}])
    guards.enforce(r, _req("แบตใช้ได้นานไหม"))
    assert "5200" not in r.answer
    assert "100 วัน" not in r.answer
    assert r.routing_decision.get("guard_rewritten") == "spec_claim"


def test_ungrounded_warranty_duration_rewritten():
    r = _resp("รับประกันศูนย์ 2 ปีค่ะ",
              products=[{"name": "Watch A", "description_excerpt": "สมาร์ทวอทช์"}])
    guards.enforce(r, _req("ประกันกี่ปี"))
    assert "2 ปี" not in r.answer
    assert r.routing_decision.get("guard_rewritten") == "spec_claim"


def test_ungrounded_protocol_claim_rewritten():
    r = _resp("หัวชาร์จนี้รองรับ PD3.0 กับ PPS ค่ะ",
              products=[{"name": "Charger A",
                         "description_excerpt": "หัวชาร์จ USB-C"}])
    guards.enforce(r, _req("รองรับชาร์จเร็วไหม"))
    assert "PD3.0" not in r.answer.replace(" ", "")
    assert r.routing_decision.get("guard_rewritten") == "spec_claim"


def test_grounded_spec_from_card_passes():
    r = _resp(
        "รุ่นนี้แบต 500mAh ค่ะ ใช้งานได้ประมาณ 3 วัน",
        products=[{"name": "Watch A",
                   "description_excerpt": "แบตเตอรี่ 500mAh ใช้งานได้ 3 วัน"}])
    guards.enforce(r, _req("แบตกี่ mAh ใช้ได้กี่วัน"))
    assert "500mAh" in r.answer.replace(" ", "") or "500mAh" in r.answer
    assert not r.routing_decision.get("guard_rewritten")


def test_grounded_spec_comma_format_passes():
    # "20,000mAh" ใน context vs "20000mAh" ใน answer = spec เดียวกัน
    # — normalize ต้องตัดทั้ง space และ comma ไม่งั้น rewrite ผิด (FP)
    r = _resp(
        "รุ่นนี้แบต 20000mAh ค่ะ",
        products=[{"name": "PB X",
                   "description_excerpt": "ความจุ 20,000mAh ชาร์จเร็ว"}])
    guards.enforce(r, _req("แบตจุเท่าไหร่"))
    assert "20000" in r.answer.replace(",", "")
    assert not r.routing_decision.get("guard_rewritten")


def test_grounded_spec_from_grounding_text_passes():
    r = _resp("รับประกัน 1 ปีค่ะ", grounding="สินค้ารับประกันศูนย์ไทย 1 ปี")
    guards.enforce(r, _req("ประกันนานไหม"))
    assert "1 ปี" in r.answer
    assert not r.routing_decision.get("guard_rewritten")


def test_negated_spec_not_rewritten():
    # "ไม่รองรับ X" เป็นการปฏิเสธ spec ไม่ใช่ claim — ห้ามแตะ
    r = _resp("รุ่นนี้ไม่รองรับมาตรฐาน IP68 นะคะ",
              products=[{"name": "Watch A", "description_excerpt": "สมาร์ทวอทช์"}])
    guards.enforce(r, _req("กันน้ำไหม"))
    assert "IP68" in r.answer
    assert not r.routing_decision.get("guard_rewritten")


def test_plain_numbers_without_spec_unit_untouched():
    r = _resp("มี 3 รุ่นให้เลือกค่ะ ราคาเริ่มต้น 590 บาท",
              products=[{"name": "A"}])
    guards.enforce(r, _req("มีรุ่นไหนบ้าง"))
    assert r.answer == "มี 3 รุ่นให้เลือกค่ะ ราคาเริ่มต้น 590 บาท"


def test_handoff_active_skips_spec_check():
    r = _resp("รับประกัน 99 ปีค่ะ")
    r.handoff_to_admin = True
    guards.enforce(r, _req("x"))
    assert "99 ปี" in r.answer


# ---------- H2: คำถามลูกค้า/history ห้ามเป็น evidence สำหรับ spec claim ----------

def test_customer_question_spec_is_not_evidence():
    r = _resp(
        "รองรับ 65W ค่ะ",
        products=[{"name": "Charger A", "description_excerpt": "หัวชาร์จ USB-C"}],
    )
    guards.enforce(r, _req("หัวชาร์จนี้รองรับ 65W ไหม"))
    assert "65w" not in r.answer.replace(" ", "").lower()
    assert r.routing_decision.get("guard_rewritten") == "spec_claim"


def test_history_spec_is_not_evidence_for_new_answer():
    r = _resp(
        "รุ่นนี้รองรับ 100W ค่ะ",
        products=[{"name": "Charger A", "description_excerpt": "หัวชาร์จ USB-C"}],
    )
    guards.enforce(r, _req("รองรับกี่วัตต์",
                           history=[{"role": "user", "text": "100W ใช่ไหม"}]))
    assert "100w" not in r.answer.replace(" ", "").lower()
    assert r.routing_decision.get("guard_rewritten") == "spec_claim"


def test_product_context_spec_is_evidence():
    r = _resp(
        "รองรับ 65W ค่ะ",
        products=[{"name": "Charger A", "description_excerpt": "รองรับชาร์จเร็ว 65W"}],
    )
    guards.enforce(r, _req("รองรับกี่วัตต์"))
    assert "65w" in r.answer.replace(" ", "").lower()
    assert not r.routing_decision.get("guard_rewritten")


def test_message_still_grounds_model_identity():
    # identity pool คงเดิม — รุ่นที่ลูกค้าพิมพ์เอง echo กลับได้ (model_claim ใช้ message)
    r = _resp(
        "รุ่น WPB100L ตัวนี้รองรับค่ะ",
        products=[{"name": "Powerbank X", "description_excerpt": "พาวเวอร์แบงค์"}],
    )
    guards.enforce(r, _req("WPB100L ใช้กับโทรศัพท์ได้ไหม"))
    assert "WPB100L" in r.answer
    assert not r.routing_decision.get("guard_rewritten")
