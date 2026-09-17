#!/usr/bin/env python3
"""Unit tests for QA batch 2026-09-11 — BUG-P / BUG-M / OBS-3 / BUG-D.

รัน: cd chatbot && PYTHONPATH=. python3 ../test/test_qa_batch_20260911.py

ทดสอบ:
- BUG-P: _detect_lang + _lang_instruction (ไทย/อังกฤษ/จีน/ไต้หวัน/ญี่ปุ่น)
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


# ─── BUG-P: language detection ─────────────────────────────

def test_detect_lang_thai():
    assert llm._detect_lang("สวัสดีค่ะ มีสายชาร์จไหม") == "th"
    assert llm._detect_lang("รับประกันกี่ปีคะ") == "th"
    assert llm._detect_lang("Mi 17 ultra ใช้พาวเวอร์แบงค์ไหน") == "th"  # มีไทย → ไทย


def test_detect_lang_english():
    assert llm._detect_lang("Hello, do you have a charger?") == "en"
    assert llm._detect_lang("What is the warranty period?") == "en"
    assert llm._detect_lang("iPhone 15 Pro Max") == "en"


def test_detect_lang_chinese():
    assert llm._detect_lang("你好，有充电器吗") == "zh"
    assert llm._detect_lang("請問有保固嗎") == "zh"  # Taiwanese traditional


def test_detect_lang_japanese():
    assert llm._detect_lang("こんにちは") == "ja"
    assert llm._detect_lang("充電器はありますか") == "ja"


def test_detect_lang_empty():
    assert llm._detect_lang("") == "th"  # default
    assert llm._detect_lang("   ") == "th"


def test_lang_instruction_thai():
    inst = llm._lang_instruction("th")
    assert inst == "", f"Thai should have empty instruction, got: {inst!r}"


def test_lang_instruction_english():
    inst = llm._lang_instruction("en")
    assert "English" in inst
    assert "ค่ะ" in inst  # ห้ามใช้คำลงท้ายไทย


def test_lang_instruction_chinese_japanese():
    for lang in ("zh", "ja", "other"):
        inst = llm._lang_instruction(lang)
        assert "English" in inst
        assert "Chinese/Japanese" in inst or "Chinese" in inst


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
    ("BUG-P detect_lang thai", test_detect_lang_thai),
    ("BUG-P detect_lang english", test_detect_lang_english),
    ("BUG-P detect_lang chinese", test_detect_lang_chinese),
    ("BUG-P detect_lang japanese", test_detect_lang_japanese),
    ("BUG-P detect_lang empty", test_detect_lang_empty),
    ("BUG-P lang_instruction thai", test_lang_instruction_thai),
    ("BUG-P lang_instruction english", test_lang_instruction_english),
    ("BUG-P lang_instruction zh/ja/other", test_lang_instruction_chinese_japanese),
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
