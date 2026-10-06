"""test_issue_5f_handoff.py — Phase 5F-A: anger substring false positive.

pin:
- short toxic token "กาก" ต้องไม่ match substring กลางคำ ("นาฬิกากัน" = นาฬิกา+กัน)
- "หน้ากาก" (product type จริง — product_store 1618) ต้องไม่ handoff
- strong phrase + anger จริง ("กากมาก","ห่วยมาก","ผิดหวังมาก","ของกาก") ยัง handoff
- question guard เดิม: "ส่งช้ามากไหม" ไม่ handoff
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat.handoffs import detect_human_request  # noqa: E402


def _req(message: str):
    return SimpleNamespace(message=message, conversation_id=None, shop=None)


def _handoff(message: str) -> dict | None:
    return detect_human_request(_req(message), {})


# ---------- false positives: "กาก" substring กลางคำ ----------

def test_watch_compound_no_handoff():
    assert _handoff("นาฬิกากันน้ำรุ่นไหนมีไหม") is None


def test_watch_compat_no_handoff():
    assert _handoff("นาฬิกากับมือถือใช้ด้วยกันได้ไหม") is None


def test_mask_product_query_no_handoff():
    # "หน้ากาก" เป็น product type จริงของร้าน — ถามสินค้าไม่ใช่บ่น
    assert _handoff("หน้ากากอนามัยราคาเท่าไหร่") is None


def test_mask_bare_no_handoff():
    assert _handoff("หน้ากาก") is None


def test_mask_polite_no_handoff():
    assert _handoff("หน้ากากมีไหมครับ") is None


# ---------- real anger still detected ----------

def test_gak_intensifier_handoff():
    out = _handoff("กากมาก")
    assert out is not None and out["handoff_reason"] == "customer_frustration"


def test_gak_after_noun_handoff():
    out = _handoff("ของกาก")
    assert out is not None and out["handoff_reason"] == "customer_frustration"


def test_gak_strong_after_dependent_handoff():
    # prev เป็นสระ (คำก่อนจบสระ) แต่ต่อด้วย intensifier จริง → ยังบ่น
    out = _handoff("สินค้ากากเลย")
    assert out is not None and out["handoff_reason"] == "customer_frustration"


def test_huay_handoff():
    out = _handoff("ห่วยมาก")
    assert out is not None and out["handoff_reason"] == "customer_frustration"


def test_phitwang_handoff():
    out = _handoff("ผิดหวังมาก")
    assert out is not None and out["handoff_reason"] == "customer_frustration"


# ---------- question guard เดิม ----------

def test_question_guard_still_works():
    assert _handoff("ส่งช้ามากไหม") is None


# ---------- H1: generic follower FPs (reviewer probe 2026-09-24) ----------
# คำทั่วไป (อะไร/แล้ว/ละ/อีก) ไม่ใช่ intensifier — "หน้ากากอะไร" = ถามสินค้า

def test_mask_question_arai_no_handoff():
    assert _handoff("หน้ากากอะไรใช้ดี") is None


def test_mask_question_laeo_no_handoff():
    assert _handoff("หน้ากากแล้วมีขายไหม") is None


def test_mask_question_la_no_handoff():
    assert _handoff("หน้ากากละมีไหม") is None


def test_product_mask_with_question_no_handoff():
    assert _handoff("หน้ากากอะไรเหมาะกับเด็ก") is None


def test_subject_gak_still_handoff():
    out = _handoff("สินค้ากากมาก")
    assert out is not None and out["handoff_reason"] == "customer_frustration"


def test_shop_gak_still_handoff():
    out = _handoff("ร้านกากมาก")
    assert out is not None and out["handoff_reason"] == "customer_frustration"
