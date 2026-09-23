from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402


def _profile(message: str):
    return route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )


def test_adapter_code_to_cable_request_relation():
    msg = ("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้างในร้านเรา "
           "ขอแบบมีจอ ยาว 2 เมตรและได้เต็มสปีด")
    prof = _profile(msg)
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)

    assert prof.model_codes == ("AD1404T",)
    assert any("cable" in s.subtypes or "cable" in s.product_types
               for s in slots)
    assert len(rels) == 1
    rel = rels[0]
    assert rel.relation_type in {"works_with", "compatible_with"}
    assert "AD1404T" in rel.evidence_span or "ใช้กับ" in rel.evidence_span
    assert ("display", "required") in rel.constraints
    assert ("length_m", "2") in rel.constraints
    assert ("speed", "full") in rel.constraints


def test_exact_model_question_without_target_product_has_no_relation():
    prof = _profile("รุ่น AD1404T ยังมีขายไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert prof.model_codes == ("AD1404T",)
    assert route_context.build_retrieval_relations(prof, slots) == ()


def test_device_compat_question_has_no_product_relation():
    prof = _profile("หัวชาร์จ AD653T ใช้กับ ip14 ได้ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert prof.model_codes == ("AD653T",)
    assert prof.target_device == "iphone 14"
    assert route_context.build_retrieval_relations(prof, slots) == ()


def test_pairing_relation_without_model_code():
    msg = "หัวชาร์จกับสายชาร์จใช้คู่กันรุ่นไหนดี"
    prof = _profile(msg)
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert len(rels) == 1
    assert rels[0].relation_type in {"works_with", "compatible_with"}


def test_product_list_without_connector_has_no_relation():
    prof = _profile("มีเคสกับฟิล์มสำหรับ iPhone 15 ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert route_context.build_retrieval_relations(prof, slots) == ()


def test_device_brand_is_not_product_brand_for_accessory():
    prof = _profile("มีเคส xiaomi mi watch 8 ไหม")
    slots = route_context.build_retrieval_slots(prof)
    assert len(slots) == 1
    assert slots[0].product_types == frozenset({"case"})
    assert slots[0].target_device in {"xiaomi mi watch 8", "mi watch 8"}
    assert "xiaomi" not in {b.lower() for b in slots[0].brand_hints}


def test_ambiguous_device_without_product_keyword_is_low_confidence():
    prof = _profile("หัวชาร์จกับ Mi Watch 8")
    slots = route_context.build_retrieval_slots(prof)
    charger = next(s for s in slots if "charger" in s.product_types)
    assert charger.target_device in (None, "mi watch 8")
    assert charger.confidence < 0.8


def test_adapter_code_to_bare_cable_word_relation():
    prof = _profile("หัวชาร์จ AD1404T ใช้กับสายไหน")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert prof.model_codes == ("AD1404T",)
    assert len(rels) == 1
    assert rels[0].relation_type == "works_with"


def test_bare_head_with_adapter_code_to_bare_cable_relation():
    prof = _profile("หัวอันนี้ AD1404T ใช้กับสายไหน")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert prof.model_codes == ("AD1404T",)
    assert len(rels) == 1


def test_watch_strap_phrase_is_not_charger_cable_relation():
    prof = _profile("นาฬิกาใช้กับสายนาฬิกาอะไร")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert not any("cable" in r.target_slot_id for r in rels)


def test_bare_cable_shorthand_blacklist_compounds():
    for msg in (
        "หัวชาร์จ AD1404T ใช้กับสายไฟอะไร",
        "หัวชาร์จ AD1404T ใช้กับสายรัดอะไร",
        "หัวชาร์จ AD1404T ใช้กับสายตาอะไร",
    ):
        prof = _profile(msg)
        slots = route_context.build_retrieval_slots(prof)
        rels = route_context.build_retrieval_relations(prof, slots)
        assert rels == ()


def test_strap_compound_is_not_inferred_as_cable():
    # "สายคล้อง" เป็น case kw จริงใน taxonomy (สายคล้องคอ = product) —
    # relation ไปหา case ผ่าน kw path ถูกต้อง ต้องไม่ถูก infer เป็น charger/cable
    prof = _profile("หัวชาร์จ AD1404T ใช้กับสายคล้องอะไร")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert not any("charger" in r.target_slot_id for r in rels)
    assert not any(k == "target_subtype" and v == "cable"
                   for r in rels for k, v in r.constraints)


def test_full_cable_keyword_still_relation():
    prof = _profile("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert len(rels) == 1


def test_bare_head_without_code_or_anchor_has_no_relation():
    prof = _profile("หัวอันนี้ใช้กับสายไหน")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert prof.model_codes == ()
    assert prof.product_types == frozenset()
    assert rels == ()


def test_watch_strap_compound_does_not_create_smartwatch_self_relation():
    prof = _profile("นาฬิกาใช้กับสายนาฬิกาอะไร")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert rels == ()


def test_bare_head_with_model_code_still_builds_relation():
    prof = _profile("หัวอันนี้ AD1404T ใช้กับสายไหน")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert prof.model_codes == ("AD1404T",)
    assert len(rels) == 1
    assert ("target_subtype", "cable") in rels[0].constraints


def test_full_cable_keyword_still_builds_relation_after_guard():
    prof = _profile("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert len(rels) == 1
