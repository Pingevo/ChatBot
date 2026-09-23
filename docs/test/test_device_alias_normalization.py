from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import device_compat, route_context  # noqa: E402


def _profile(message: str):
    return route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )


def test_compact_xiaomi_phone_alias_becomes_target_device():
    assert device_compat.normalize_device_alias("mi14pro") == "xiaomi 14 pro"
    assert device_compat._extract_device_token("สายชาร์จใช้กับ mi14pro") == "xiaomi 14 pro"
    prof = _profile("สายชาร์จใช้กับ mi14pro")
    assert prof.target_device == "xiaomi 14 pro"
    assert prof.compat_mode == "connector_required"


def test_iphone_shorthand_aliases_normalize_to_iphone_family():
    assert device_compat.normalize_device_alias("ip14") == "iphone 14"
    assert device_compat.normalize_device_alias("i14 pro") == "iphone 14 pro"
    assert device_compat._lookup_spec_db("iphone 14 pro")["connector"] == "lightning"


def test_thai_iphone_alias_normalizes():
    assert device_compat.normalize_device_alias("ไอโฟน14โปร") == "iphone 14 pro"
    prof = _profile("มีสายชาร์จใช้กับไอโฟน14โปรไหม")
    assert prof.target_device == "iphone 14 pro"


def test_product_model_codes_are_not_target_devices():
    for value in ("HA835", "AD1203P", "CMC615", "CTC615W"):
        assert device_compat.normalize_device_alias(value) is None
        assert device_compat._extract_device_token(f"มีรุ่น {value} ไหม") is None


def test_device_aliases_do_not_become_product_model_codes():
    for msg, expected in (
        ("สายชาร์จใช้กับ mi14pro", "xiaomi 14 pro"),
        ("สายชาร์จใช้กับ ip14", "iphone 14"),
        ("สายชาร์จใช้กับ i14 pro", "iphone 14 pro"),
    ):
        prof = _profile(msg)
        assert prof.target_device == expected
        assert prof.compat_mode == "connector_required"
        assert prof.model_codes == ()
        assert prof.intent != "exact_model"
        assert prof.availability_mode == "sellable_first"


def test_known_short_spec_aliases_remain_target_devices_not_product_codes():
    for msg, expected in (
        ("สายชาร์จใช้กับ s25", "s25"),
        ("สายชาร์จใช้กับ a56", "a56"),
    ):
        assert device_compat._lookup_spec_db(expected)
        prof = _profile(msg)
        assert prof.target_device == expected
        assert prof.compat_mode == "connector_required"
        assert prof.model_codes == ()
        assert prof.intent != "exact_model"


def test_real_product_codes_stay_product_codes_not_devices():
    for msg, code in (
        ("มีรุ่น HA835 ไหม", "HA835"),
        ("มีรุ่น AD1203P ไหม", "AD1203P"),
        ("มีรุ่น CMC615 ไหม", "CMC615"),
        ("มีรุ่น CMC615P ไหม", "CMC615P"),
        ("มีรุ่น CTC615W ไหม", "CTC615W"),
        ("มีรุ่น AD653T ไหม", "AD653T"),
    ):
        prof = _profile(msg)
        assert prof.target_device is None
        assert code in prof.model_codes
        assert prof.intent == "exact_model"
