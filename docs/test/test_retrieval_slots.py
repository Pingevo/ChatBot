"""Task 4E pins — build_retrieval_slots(profile) แยก multi-product request
เป็น slots โดย deterministic span parsing (ไม่เรียก LLM, ไม่สรุป compatibility).

Contract phase เท่านั้น — slots ยังไม่ wire เข้า retrieval runtime."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402


def _profile(message: str, **kw):
    args = dict(
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )
    args.update(kw)
    return route_context.build_retrieval_profile(message, **args)


def test_charger_and_watch_keep_separate_constraints():
    """หลาย product + constraint ต่างกัน → brand/model/subtype ห้ามปนข้าม slot."""
    prof = _profile(
        "อยากได้หัวชาร์จกับนาฬิกาใช้กับ mi 17 ultra "
        "brand ที่มองไว้หัวชาร์จเอา cuktech นาฬิกาเอา xiaomi mi watch 8"
    )
    assert prof.product_types == frozenset({"charger", "smartwatch"})
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 2

    charger = next(s for s in slots if "charger" in s.product_types)
    watch = next(s for s in slots if "smartwatch" in s.product_types)

    assert "adapter" in charger.subtypes
    assert "cuktech" in {b.lower() for b in charger.brand_hints}
    assert "xiaomi" not in {b.lower() for b in charger.brand_hints}
    assert "smartwatch" not in charger.product_types

    assert "xiaomi" in {b.lower() for b in watch.brand_hints}
    assert any("watch 8" in t.lower() for t in watch.model_terms)
    assert "cuktech" not in {b.lower() for b in watch.brand_hints}
    assert "adapter" not in watch.subtypes


def test_multi_subtype_charger_does_not_collapse_to_one_subtype():
    """"สายชาร์จกับหัวชาร์จ" → slot เดียวต้องเก็บทั้ง cable + adapter."""
    prof = _profile("มีสายชาร์จกับหัวชาร์จไหม")
    assert prof.subtype == "cable"  # flat profile ยัง singular (backward compat)
    slots = route_context.build_retrieval_slots(prof)
    charger = next(s for s in slots if "charger" in s.product_types)
    assert {"cable", "adapter"} <= set(charger.subtypes)
    assert charger.primary_subtype in (None, "cable", "adapter")


def test_single_product_turn_remains_one_slot():
    """single product + brand + device → 1 slot, shape เดิมไม่พัง."""
    prof = _profile("มีหัวชาร์จ CukTech ใช้กับ Mi 17 Ultra ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    s = slots[0]
    assert "charger" in s.product_types
    assert "adapter" in s.subtypes
    assert "cuktech" in {b.lower() for b in s.brand_hints}
    assert s.target_device == "xiaomi 17 ultra"  # canonical (4F normalize)


def test_ambiguous_message_falls_back_to_one_open_slot():
    """ไม่มี type span ชัด → slot เดียวแบบ open/low-confidence ไม่เดา type มั่ว."""
    prof = _profile("เอาตัวดีๆ มีไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert not slots[0].product_types
    assert slots[0].confidence <= 0.5


def test_shared_target_device_marked_shared_not_forced_compatible():
    """device ที่ใช้กับหลาย product → target_scope=shared ทุก slot ที่ได้รับ
    และ route_context ไม่สรุป compatible เอง (compat_mode เป็น hint เท่านั้น)."""
    prof = _profile(
        "อยากได้หัวชาร์จกับนาฬิกาใช้กับ mi 17 ultra "
        "brand ที่มองไว้หัวชาร์จเอา cuktech นาฬิกาเอา xiaomi mi watch 8"
    )
    slots = route_context.build_retrieval_slots(prof)
    for s in slots:
        if s.target_device:
            assert s.target_scope == "shared"
    # ไม่มี field ใดกล้าเคลม compatible=True — scope เท่านั้น
    assert not any(getattr(s, "compatible", None) for s in slots)


def test_slot_contract_shape_and_profile_unchanged():
    """RetrievalSlot เป็น frozen dataclass; build ไม่ mutate profile."""
    import dataclasses
    prof = _profile("มีสายชาร์จไหม")
    before = dataclasses.asdict(prof)
    slots = route_context.build_retrieval_slots(prof)
    assert dataclasses.asdict(prof) == before
    s = slots[0]
    assert dataclasses.is_dataclass(s)
    try:
        s.product_types = frozenset()  # frozen → must raise
        raise AssertionError("RetrievalSlot must be frozen")
    except dataclasses.FrozenInstanceError:
        pass
    assert s.slot_id and s.availability_mode == prof.availability_mode


def test_one_slot_keeps_profile_facts_for_4d_compat():
    """one-slot turn → slot เทียบเท่า profile facts (4D behavior ไม่เปลี่ยน)."""
    prof = _profile("มีสายชาร์จไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    s = slots[0]
    assert s.product_types == prof.product_types
    assert s.primary_subtype == prof.subtype
    assert s.model_codes == prof.model_codes
    assert s.target_device == prof.target_device
    assert s.availability_mode == prof.availability_mode


# ---- 4E hardening: phone pseudo-type = target device ไม่ใช่ product slot ----


def test_accessory_device_does_not_create_phone_slot():
    """'สายชาร์จ + ฟิล์ม iPhone 15' — iPhone 15 คือ target ไม่ใช่สินค้า."""
    prof = _profile("มีสายชาร์จ Anker กับฟิล์ม iPhone 15 ไหม")
    slots = route_context.build_retrieval_slots(prof)

    types = [next(iter(s.product_types), "") for s in slots]
    assert "charger" in types
    assert "screen_protector" in types
    assert "phone" not in types

    assert any(s.target_device == "iphone 15" for s in slots)
    assert all("phone" not in s.product_types for s in slots)


def test_explicit_phone_purchase_keeps_phone_slot():
    """'โทรศัพท์ iPhone 15 กับเคส' — kw ชัด → phone ยังเป็น product slot."""
    prof = _profile("มีโทรศัพท์ iPhone 15 กับเคสไหม")
    slots = route_context.build_retrieval_slots(prof)

    assert any("phone" in s.product_types for s in slots)
    assert any("case" in s.product_types for s in slots)


def test_accessory_phrase_marks_device_shared_without_compat_connector():
    """'ฟิล์ม iPhone 15 กับเคส iPhone 15' — device ไม่มี connector ก็ยังไม่เป็น slot."""
    prof = _profile("มีฟิล์ม iPhone 15 กับเคส iPhone 15 ไหม")
    slots = route_context.build_retrieval_slots(prof)

    assert not any("phone" in s.product_types for s in slots)
    assert {"screen_protector", "case"} <= set(
        next(iter(s.product_types)) for s in slots if s.product_types
    )
    assert all(
        s.target_device in (None, "iphone 15")
        for s in slots
    )


# ---- 4E provenance: explicit kw vs inferred device-regex ต้องไม่เท่ากัน ----


def test_single_accessory_keeps_inferred_phone_out_of_product_types():
    """'เคส iPhone 15' — single slot ก็ต้องกรอง pseudo-type ออกเช่นกัน."""
    prof = _profile("มีเคส iPhone 15 ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert slots[0].product_types == frozenset({"case"})
    assert slots[0].target_device == "iphone 15"


def test_inferred_device_family_rule_is_not_phone_specific():
    """กฎเดียวกันกับ family อื่น — 'เคส Mi Watch 8' ไม่สร้าง smartwatch slot."""
    prof = _profile("มีเคส Mi Watch 8 ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert slots[0].product_types == frozenset({"case"})
    assert slots[0].target_device == "mi watch 8"


def test_inferred_only_model_keeps_product_type_fallback():
    """'อยากได้ iPhone 15' — ไม่มี explicit type → inferred เป็น fallback slot."""
    prof = _profile("อยากได้ iPhone 15")
    slots = route_context.build_retrieval_slots(prof)
    assert slots[0].product_types == frozenset({"phone"})


def test_explicit_type_wins_over_same_family_inferred_model():
    """'โทรศัพท์ iPhone 15' — kw ชัด → phone เป็น product ไม่ใช่ target."""
    prof = _profile("อยากได้โทรศัพท์ iPhone 15")
    slots = route_context.build_retrieval_slots(prof)
    assert slots[0].product_types == frozenset({"phone"})
