from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402
from shopeechat.retrieval_planner import build_grouped_retrieval_requests  # noqa: E402


def _profile(message: str):
    return route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )


def _pipeline(message: str):
    prof = _profile(message)
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    return prof, slots, rels


def test_relation_builds_target_cable_request_from_adapter_code():
    prof, slots, rels = _pipeline("หัวชาร์จ AD1404T ใช้กับสายไหน")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    assert any(r.relation_id for r in reqs)
    target = next(r for r in reqs if r.relation_id)
    assert target.slot_id in {"slot-charger", "slot-cable"}
    assert "charger" in target.product_types
    assert (("target_subtype", "cable") in target.soft_hints
            or "cable" in target.subtypes)
    assert target.model_codes == ()


def test_exact_model_without_relation_builds_identity_request():
    prof, slots, rels = _pipeline("รุ่น AD1404T ยังมีขายไหม")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    assert len(reqs) >= 1
    assert any("AD1404T" in r.model_codes for r in reqs)
    assert not any(r.relation_id for r in reqs)


def test_device_compat_does_not_create_relation_request():
    prof, slots, rels = _pipeline("หัวชาร์จ AD653T ใช้กับ ip14 ได้ไหม")

    assert rels == ()
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    assert any("AD653T" in r.model_codes for r in reqs)
    assert all(r.relation_id is None for r in reqs)


def test_multi_slot_case_film_builds_separate_requests():
    prof, slots, rels = _pipeline("มีเคสกับฟิล์มสำหรับ iPhone 15 ไหม")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    assert len(reqs) >= 2
    assert any("case" in r.product_types for r in reqs)
    assert any("screen_protector" in r.product_types for r in reqs)
    assert all(r.target_device == "iphone 15"
               for r in reqs if r.product_types)


def test_bare_head_without_source_builds_no_relation_request():
    prof, slots, rels = _pipeline("หัวอันนี้ใช้กับสายไหน")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    assert rels == ()
    assert not any(r.relation_id for r in reqs)


def test_low_confidence_slot_marks_soft_hints_not_hard_filters():
    prof, slots, rels = _pipeline("หัวชาร์จกับ Mi Watch 8")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    assert any(r.confidence < 0.8 for r in reqs)
    assert not any(("target_device", "mi watch 8") in r.hard_filters
                   for r in reqs)


def test_kw_relation_target_carries_cable_subtype():
    # explicit "สายชาร์จ" ต้องให้ target_subtype=cable เหมือน shorthand "สายไหน"
    prof, slots, rels = _pipeline(
        "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้างในร้านเรา "
        "ขอแบบมีจอ ยาว 2 เมตรและได้เต็มสปีด")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    target = next(r for r in reqs if r.relation_id)
    assert "cable" in target.subtypes
    assert ("target_subtype", "cable") in target.soft_hints
    assert ("display", "required") in target.soft_hints
    assert ("length_m", "2") in target.soft_hints
    assert ("speed", "full") in target.soft_hints
    assert target.model_codes == ()


def test_source_slot_request_keeps_source_role_subtype():
    # source คือ adapter (หัวชาร์จ) — base request ต้องไม่กลืน cable เป้าหมาย
    prof, slots, rels = _pipeline(
        "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    base = next(r for r in reqs if r.relation_id is None)
    assert "AD1404T" in base.model_codes
    assert "adapter" in base.subtypes
    assert "cable" not in base.subtypes


def test_symmetric_relation_target_carries_subtype():
    prof, slots, rels = _pipeline("หัวชาร์จกับสายชาร์จใช้คู่กันรุ่นไหนดี")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    target = next(r for r in reqs if r.relation_id)
    assert "cable" in target.subtypes


def test_relation_target_soft_hints_exclude_source_subtype():
    # source_subtype = metadata ฝั่ง source — ห้ามรั่วเข้า target request
    prof, slots, rels = _pipeline(
        "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้างในร้านเรา "
        "ขอแบบมีจอ ยาว 2 เมตรและได้เต็มสปีด")
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    target = next(r for r in reqs if r.relation_id)
    assert not any(k == "source_subtype" for k, _ in target.soft_hints)
    assert ("target_subtype", "cable") in target.soft_hints
    # source side ยังแคบเป็น adapter (ใช้ source_subtype ที่ถูกที่)
    base = next(r for r in reqs if r.relation_id is None)
    assert "adapter" in base.subtypes and "cable" not in base.subtypes
