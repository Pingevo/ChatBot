#!/usr/bin/env python3
"""Unit tests for QA batch 2026-09-11 — BUG-P / BUG-M / OBS-3 / BUG-D.

รัน: cd chatbot && PYTHONPATH=. python3 ../test/test_qa_batch_20260911.py

ทดสอบ:
- Language policy (2026-09-18, แทน BUG-P): _lang_instruction — ตอบไทยเสมอ
  เว้นแต่ลูกค้าขอภาษาอื่น → ตอบอังกฤษ (detect เฉพาะ explicit request)
- BUG-M: _strip_kb_markup post-check กันอ้างเท็จ "แอดมินมาแล้ว"
- OBS-3: prompt rule อยู่ใน SYSTEM_INSTRUCTION / KB_SYSTEM_INSTRUCTION / general_instruction
- BUG-D: conversation_products.load/update/clear_claim_state
"""
from __future__ import annotations

import os
import sys
import re
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "chatbot"))

from shopeechat import llm  # noqa: E402
from shopeechat import conversation_products as _cp  # noqa: E402

_passed = 0
_failed = 0


def _ok(name: str, cond: bool, detail: str = ""):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✅ {name} passed")
    else:
        _failed += 1
        print(f"  ❌ {name} FAILED {detail}")


# ─── Language policy: ไทยเสมอ เว้นแต่ขอภาษาอื่น → อังกฤษ ───

def test_lang_no_request_thai():
    # ข้อความไทยปกติ → ตอบไทย (instruction ว่าง)
    for msg in ("สวัสดีค่ะ มีสายชาร์จไหม", "รับประกันกี่ปีคะ",
                "Mi 17 ultra ใช้พาวเวอร์แบงค์ไหน"):
        assert llm._lang_instruction(msg) == "", f"expected Thai, got: {msg!r}"


def test_lang_no_request_other_scripts():
    # ลูกค้าพิมพ์ภาษาอื่นแต่ไม่ได้ขอภาษา → ตอบไทยเสมอ (policy ใหม่)
    for msg in ("Hello, do you have a charger?", "你好，有充电器吗",
                "こんにちは", "iPhone 15 Pro Max", "1", ""):
        assert llm._lang_instruction(msg) == "", f"expected Thai, got: {msg!r}"


def test_lang_request_thai_phrasing():
    # ขอภาษาอื่นภาษาไทย → ตอบอังกฤษ
    for msg in ("ตอบเป็นภาษาจีนได้ไหม", "พูดภาษาอังกฤษได้ไหมคะ",
                "ช่วยตอบภาษามาเลย์หน่อย", "คุยภาษาอาหรับได้ไหม",
                "ขอภาษาไต้หวันหน่อยค่ะ"):
        inst = llm._lang_instruction(msg)
        assert "English" in inst, f"expected English, got: {msg!r}"


def test_lang_request_english_phrasing():
    for msg in ("please reply in chinese", "can you speak english",
                "answer in malay please", "in arabic please",
                "english please", "translate to japanese"):
        inst = llm._lang_instruction(msg)
        assert "English" in inst, f"expected English, got: {msg!r}"


def test_lang_request_other_scripts():
    # ขอในภาษานั้นๆ → ตอบอังกฤษ
    for msg in ("請用中文回答", "用英文回覆", "dalam bahasa melayu",
                "هل تتكلم العربية", "ответьте на русском"):
        inst = llm._lang_instruction(msg)
        assert "English" in inst, f"expected English, got: {msg!r}"


def test_lang_product_question_no_trigger():
    # คำถามสินค้าที่มีชื่อภาษาปน — ไม่ใช่ language request → ตอบไทย
    for msg in ("app ภาษาจีนใช้ได้ไหม", "รองรับภาษาอังกฤษไหมคะ",
                "เมนูเป็นภาษาอังกฤษหรือเปล่า", "มี english manual ไหม",
                "ใช้กับ app xiaomi จีนได้ไหม"):
        assert llm._lang_instruction(msg) == "", f"expected Thai, got: {msg!r}"


def test_lang_request_thai_not_triggered():
    # ขอตอบไทย/พูดไทย → default ไทยอยู่แล้ว ไม่สลับอังกฤษ
    for msg in ("ตอบภาษาไทยนะ", "speak thai please", "answer in thai"):
        assert llm._lang_instruction(msg) == "", f"expected Thai, got: {msg!r}"


# ─── BUG-M: false admin claim post-check ────────────────────

def test_strip_kb_markup_replaces_false_admin_claims():
    text = "แอดมินมาดูแลแล้วค่ะ รบกวนรอการติดต่อกลับ"
    result = llm._strip_kb_markup(text)
    assert "แอดมินมาดูแลแล้ว" not in result, f"Should replace false claim, got: {result!r}"
    assert "ส่งต่อให้แอดมิน" in result, f"Should contain truthful fallback, got: {result!r}"


def test_strip_kb_markup_replaces_admin_arrived():
    text = "แอดมินมาแล้วค่ะ"
    result = llm._strip_kb_markup(text)
    assert "แอดมินมาแล้ว" not in result, f"got: {result!r}"


def test_strip_kb_markup_replaces_claim_completed():
    text = "ทางร้านรับเรื่องประสานงานตรวจสอบและดูแลเรื่องการส่งเคลมสินค้าให้เรียบร้อยแล้ว"
    result = llm._strip_kb_markup(text)
    assert "เรียบร้อยแล้ว" not in result, f"got: {result!r}"
    assert "ส่งต่อให้แอดมิน" in result


def test_strip_kb_markup_preserves_truthful_handoff():
    text = "เดี๋ยวส่งต่อให้แอดมินดูแลให้นะคะ รบกวนรอการติดต่อกลับ"
    result = llm._strip_kb_markup(text)
    assert result == text, f"Truthful handoff should be preserved, got: {result!r}"


def test_strip_kb_markup_replaces_received_case():
    text = "แอดมินได้รับเรื่องแล้วค่ะ"
    result = llm._strip_kb_markup(text)
    assert "รับเรื่องแล้ว" not in result, f"got: {result!r}"


# ─── OBS-3: prompt rules present ───────────────────────────

def test_obs3_rule_in_system_instruction():
    assert "OBS-3" in llm.SYSTEM_INSTRUCTION, "OBS-3 rule missing from SYSTEM_INSTRUCTION"
    assert "ตรวจสอบสถานะ" in llm.SYSTEM_INSTRUCTION


def test_obs3_rule_in_kb_system_instruction():
    assert "OBS-3" in llm.KB_SYSTEM_INSTRUCTION, "OBS-3 rule missing from KB_SYSTEM_INSTRUCTION"


# ─── BUG-D: claim state persistence ────────────────────────

def test_claim_state_functions_exist():
    assert callable(_cp.load_claim_state)
    assert callable(_cp.update_claim_state)
    assert callable(_cp.clear_claim_state)


def test_claim_state_load_none_for_missing():
    # Should not raise; returns None for missing conversation
    result = _cp.load_claim_state("nonexistent-conv-id-12345")
    assert result is None, f"Expected None, got: {result!r}"


def test_claim_state_clear_no_error():
    # Should not raise for missing conversation
    _cp.clear_claim_state("nonexistent-conv-id-12345")


# ─── Run ───────────────────────────────────────────────────

_TESTS = [
    ("LANG no-request thai", test_lang_no_request_thai),
    ("LANG no-request other scripts", test_lang_no_request_other_scripts),
    ("LANG request thai phrasing", test_lang_request_thai_phrasing),
    ("LANG request english phrasing", test_lang_request_english_phrasing),
    ("LANG request other scripts", test_lang_request_other_scripts),
    ("LANG product question no trigger", test_lang_product_question_no_trigger),
    ("LANG request thai not triggered", test_lang_request_thai_not_triggered),
    ("BUG-M strip false admin claim", test_strip_kb_markup_replaces_false_admin_claims),
    ("BUG-M strip admin arrived", test_strip_kb_markup_replaces_admin_arrived),
    ("BUG-M strip claim completed", test_strip_kb_markup_replaces_claim_completed),
    ("BUG-M preserve truthful handoff", test_strip_kb_markup_preserves_truthful_handoff),
    ("BUG-M strip received case", test_strip_kb_markup_replaces_received_case),
    ("OBS-3 rule in SYSTEM_INSTRUCTION", test_obs3_rule_in_system_instruction),
    ("OBS-3 rule in KB_SYSTEM_INSTRUCTION", test_obs3_rule_in_kb_system_instruction),
    ("BUG-D functions exist", test_claim_state_functions_exist),
    ("BUG-D load None for missing", test_claim_state_load_none_for_missing),
    ("BUG-D clear no error", test_claim_state_clear_no_error),
]


def main():
    print("=== QA batch 2026-09-11 unit tests ===\n")
    for name, fn in _TESTS:
        try:
            fn()
            _ok(name, True)
        except AssertionError as e:
            _ok(name, False, str(e))
        except Exception as e:
            _ok(name, False, f"EXCEPTION: {type(e).__name__}: {e}")
    print(f"\n=== Result: {_passed} passed, {_failed} failed, {_passed + _failed} total ===")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
