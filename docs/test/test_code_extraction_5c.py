"""test_code_extraction_5c.py — Task 5C-B: model-code extraction gap fix.

pin: _extract_codes ต้องรับ pattern letter→digit→letter→digit (AC65B2)
     + codes เดิมทั้งหมดยังเข้า · device aliases (i14/ip14/s25/a56)
     ยังถูก filter ออกจาก profile.model_codes และเป็น target_device
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat.scripts.unit_classifier import _extract_codes  # noqa: E402
from shopeechat import route_context  # noqa: E402


def test_letter_digit_letter_digit_codes():
    # pattern AC65B2 (letters→digits→letter→digit) เคยหลุดจาก _CODE_RE
    assert "AC65B2" in _extract_codes("AC65B เทียบกับ AC65B2 ต่างกันยังไง")


def test_existing_code_patterns_unchanged():
    msg = "AC65B AD1404T CTC620P HA835 CMC615 PB100P WPB100L LPB200NC A18T"
    codes = set(_extract_codes(msg))
    for c in ("AC65B", "AD1404T", "CTC620P", "HA835", "CMC615",
              "PB100P", "WPB100L", "LPB200NC", "A18T"):
        assert c in codes, f"missing {c}: {codes}"


def test_both_compare_codes_in_profile():
    # "AC65B เทียบกับ AC65B2" ต้องได้ codes ทั้งคู่ใน profile (ไม่ใช่แค่ AC65B)
    p = route_context.build_retrieval_profile(
        "AC65B เทียบกับ AC65B2 ต่างกันยังไง",
        history=[], intent_result=None, shop="KingGadgets")
    assert "AC65B" in p.model_codes
    assert "AC65B2" in p.model_codes


def test_device_aliases_stay_devices_not_codes():
    # i14/ip14/s25/a56 = target device ไม่ใช่ model code (guard ที่ profile level)
    cases = [
        ("สายชาร์จสำหรับ i14", "iphone 14"),
        ("หัวชาร์จใช้กับ ip14 ได้ไหม", "iphone 14"),
        ("มีเคส s25 ไหม", "s25"),
        ("a56 ใช้กับอะไรได้บ้าง", "a56"),
    ]
    for msg, dev in cases:
        p = route_context.build_retrieval_profile(
            msg, history=[], intent_result=None, shop="KingGadgets")
        assert p.target_device == dev, f"{msg}: device={p.target_device}"
        assert not p.model_codes, f"{msg}: codes leaked {p.model_codes}"


def test_no_v2_v3_caller():
    for mod in ("chatbotv2", "chatbotv3"):
        p = ROOT / "chatbot" / "shopeechat" / f"{mod}.py"
        if p.exists():
            src = p.read_text()
            assert "_extract_codes" not in src
