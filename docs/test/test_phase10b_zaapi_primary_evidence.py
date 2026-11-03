"""Task 2 — type-correct charging evidence (cable capacity != power-source output).

Contract (owners: policy_resolver.extract_field_facts / resolve_compat,
units.to_unit_card, build_sellable_units._build_unit):
- power source (adapter/powerbank): `output_power_w` -> `output_w_structured`
- cable: typed `power_capacity_w` / `max_current_a` / `charging_protocols`
  = capability the cable supports, never an output claim
- typed values only (canonical_specs/spec_facts); no title/description parse
- invalid/missing typed value -> no fact row (unknown, fail closed)
"""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import policy_resolver as pr  # noqa: E402
from shopeechat import units as _units  # noqa: E402
from shopeechat.scripts import build_sellable_units as bsu  # noqa: E402

SID = "i:1"
XIAOMI = "xiaomi 17 ultra"
SPECS_240 = {"power_capacity_w": 240, "max_current_a": 6,
             "charging_protocols": ["pd3.1"]}


def _cable(specs=None, name="CTC620P สายชาร์จ USB-C to USB-C 2m", **kw):
    c = {"name": name, "item_id": "1", "product_type": "cable",
         "canonical_specs": SPECS_240 if specs is None else specs}
    c.update(kw)
    return c


def _adapter(specs, name="หัวชาร์จ USB-C GaN"):
    return {"name": name, "item_id": "1", "product_type": "charger",
            "canonical_specs": specs}


def _facts(card, sid=SID):
    return pr.extract_field_facts(card, subject_id=sid)


def _vals(facts, key):
    return [f.value for f in facts if f.fact_key == key]


def _device(min_watt=90, connector="usb-c", **extra):
    return pr.device_field_facts(
        XIAOMI, {"connector": connector, "min_watt": min_watt,
                 "source": "spec-db", **extra})


def _decide(card, sid=SID, **dev):
    return pr.resolve_compat(
        subject_id=sid, target=f"device:{XIAOMI}", relation="charges",
        subject_facts=_facts(card, sid), target_facts=_device(**dev))


# 1 -------------------------------------------------------------------------
def test_cable_capacity_is_not_power_source_output():
    f = _facts(_cable())
    assert _vals(f, "power_capacity_w") == [240]
    assert _vals(f, "max_current_a") == [6]
    assert _vals(f, "charging_protocols") == [("pd3.1",)]
    assert not _vals(f, "output_w_structured")


# 2 -------------------------------------------------------------------------
def test_cable_capacity_covers_target_without_output_claim():
    d = _decide(_cable())
    assert d.outcome == "compatible"
    assert "cable_capacity_covers_target" in d.reason_codes
    assert "missing_wattage_evidence" not in d.reason_codes
    assert "insufficient_wattage" not in d.reason_codes


# 3 -------------------------------------------------------------------------
def test_adapter_and_powerbank_keep_output_power_contract():
    for ptype in ("charger", "powerbank"):
        card = {**_adapter({"output_power_w": 120}), "product_type": ptype}
        f = _facts(card)
        assert _vals(f, "output_w_structured") == [("120.0",)]
        assert not _vals(f, "power_capacity_w")
        d = _decide(card)
        assert d.outcome == "compatible"
        assert "cable_capacity_covers_target" not in d.reason_codes
        assert "missing_wattage_evidence" not in d.reason_codes
    low = _decide(_adapter({"output_power_w": 30}))
    assert "insufficient_wattage" in low.reason_codes
    unk = _decide(_adapter({}))
    assert "missing_wattage_evidence" in unk.reason_codes


def test_adapter_ignores_power_capacity_key():
    d = _decide(_adapter({"power_capacity_w": 240}))
    assert "missing_wattage_evidence" in d.reason_codes
    assert "cable_capacity_covers_target" not in d.reason_codes


@pytest.mark.parametrize("facts_key", ["canonical_specs", "spec_facts"])
def test_product_type_from_specs_cannot_impersonate_cable(facts_key):
    card = _adapter({"output_power_w": 120})
    card[facts_key] = {"product_type": ["cable"] if facts_key == "spec_facts"
                       else "cable", "power_capacity_w": 240}
    if facts_key == "canonical_specs":
        card["output_power_w"] = 120
    f = _facts(card)
    types = [x for x in f if x.fact_key == "product_type"]
    assert [(x.value, x.source, x.provenance) for x in types] == [
        ("charger", "card", "product_type")]
    d = _decide(card)
    assert d.outcome == "compatible"
    assert "cable_capacity_covers_target" not in d.reason_codes
    assert "missing_wattage_evidence" not in d.reason_codes


@pytest.mark.parametrize("invalid", [[], ["cable"], {}, {"type": "cable"}, "", "  "])
def test_malformed_structural_product_type_cannot_become_cable(invalid):
    card = _cable({"power_capacity_w": 240, "product_type": "cable"},
                  product_type=invalid)
    f = _facts(card)
    assert not _vals(f, "product_type")
    d = _decide(card)
    assert d.outcome == "compatible"
    assert "cable_capacity_covers_target" not in d.reason_codes
    assert "missing_wattage_evidence" in d.reason_codes


def test_resolver_rejects_non_card_type_fact_even_if_injected():
    card = _cable({"power_capacity_w": 240}, product_type="")
    forged = pr.FieldEvidence(SID, "product_type", "cable", "known",
                              "spec_facts", provenance="spec_facts.product_type")
    d = pr.resolve_compat(
        subject_id=SID, target=f"device:{XIAOMI}", relation="charges",
        subject_facts=_facts(card) + (forged,), target_facts=_device())
    assert d.outcome == "compatible"
    assert "cable_capacity_covers_target" not in d.reason_codes
    assert "missing_wattage_evidence" in d.reason_codes


def test_resolver_does_not_union_forged_type_with_structural_charger():
    card = _adapter({"power_capacity_w": 240})
    forged = pr.FieldEvidence(SID, "product_type", "cable", "known",
                              "spec_facts", provenance="spec_facts.product_type")
    d = pr.resolve_compat(
        subject_id=SID, target=f"device:{XIAOMI}", relation="charges",
        subject_facts=_facts(card) + (forged,), target_facts=_device())
    assert d.outcome == "compatible"
    assert "cable_capacity_covers_target" not in d.reason_codes
    assert "missing_wattage_evidence" in d.reason_codes


@pytest.mark.parametrize("malformed", [
    ["cable"], ("cable",), {"product_type": "cable"}, True, 1])
def test_resolver_malformed_card_type_fact_does_not_crash_or_prove_cable(
        malformed):
    card = _cable({"power_capacity_w": 240}, product_type="")
    injected = pr.FieldEvidence(SID, "product_type", malformed, "known",
                                "card", provenance="product_type")
    d = pr.resolve_compat(
        subject_id=SID, target=f"device:{XIAOMI}", relation="charges",
        subject_facts=_facts(card) + (injected,), target_facts=_device())
    assert d.outcome == "compatible"
    assert d.reason_codes == ("connector_match", "missing_wattage_evidence")


def test_resolver_malformed_card_type_preserves_power_source_output():
    card = _adapter({"output_power_w": 120, "power_capacity_w": 240})
    card["product_type"] = None
    injected = pr.FieldEvidence(SID, "product_type", ["cable"], "known",
                                "card", provenance="product_type")
    d = pr.resolve_compat(
        subject_id=SID, target=f"device:{XIAOMI}", relation="charges",
        subject_facts=_facts(card) + (injected,), target_facts=_device())
    assert d.outcome == "compatible"
    assert d.reason_codes == ("connector_match",)


# 4 -------------------------------------------------------------------------
def test_cable_capacity_below_target_is_typed_limitation():
    d = _decide(_cable({"power_capacity_w": 60}))
    assert d.outcome == "compatible"
    assert "insufficient_wattage" in d.reason_codes
    assert "cable_capacity_covers_target" not in d.reason_codes


# 5 -------------------------------------------------------------------------
def test_cable_without_capacity_is_unknown_not_title_parsed():
    card = _cable({}, name="CTC620P สายชาร์จ 240W USB-C to USB-C",
                  description="รองรับ 240W 6A PD3.1")
    f = _facts(card)
    assert not _vals(f, "power_capacity_w")
    assert not _vals(f, "output_w_structured")
    d = _decide(card)
    assert "missing_wattage_evidence" in d.reason_codes
    assert "cable_capacity_covers_target" not in d.reason_codes


# 6 -------------------------------------------------------------------------
def test_connector_mismatch_not_overridden_by_capacity():
    d = _decide(_cable(name="สายชาร์จ USB-C to Lightning"))
    assert d.outcome == "incompatible"
    assert d.reason_codes == ("connector_disjoint",)
    d2 = _decide(_cable(), connector="lightning")
    assert d2.outcome == "incompatible"


# 7 -------------------------------------------------------------------------
def test_protocol_evidence_not_invented():
    card = _cable({"power_capacity_w": 240})
    assert not _vals(_facts(card), "charging_protocols")
    d = _decide(card, protocols=["pd3.0"])
    assert d.outcome == "compatible"
    assert not any("protocol" in c for c in d.reason_codes)
    assert all("pd3" not in str(p.facts) for p in d.proofs)


@pytest.mark.parametrize("bad", ["pd3.1", 31, None, {"a": "pd3.1"},
                                 ["pd3.1", 5], [None]])
def test_charging_protocols_typed_list_only(bad):
    f = _facts(_cable({"power_capacity_w": 240, "charging_protocols": bad}))
    assert not _vals(f, "charging_protocols")


def test_charging_protocols_normalized_from_list_and_tuple():
    for raw in (["PD3.1 ", "pps"], ("PD3.1 ", "pps")):
        f = _facts(_cable({"charging_protocols": raw}))
        assert _vals(f, "charging_protocols") == [("PD3.1", "pps")]


@pytest.mark.parametrize("raw", [[""], ["  "], [], ["", "  "]])
def test_blank_charging_protocols_do_not_emit_fact(raw):
    assert not _vals(_facts(_cable({"charging_protocols": raw})),
                     "charging_protocols")


@pytest.mark.parametrize("raw", [
    [" PD3.1 ", "", "pps"], (" PD3.1 ", "  ", "pps")])
def test_charging_protocols_remove_blank_members(raw):
    f = _facts(_cable({"charging_protocols": raw}))
    assert _vals(f, "charging_protocols") == [("PD3.1", "pps")]


# 8 -------------------------------------------------------------------------
@pytest.mark.parametrize("key", ["power_capacity_w", "max_current_a"])
@pytest.mark.parametrize("bad", [True, False, float("nan"), float("inf"),
                                 float("-inf"), 0, 0.0, -1, -240, "240",
                                 "240W", None, [240]])
def test_numeric_capacity_rejects_invalid(key, bad):
    assert not _vals(_facts(_cable({key: bad})), key)


@pytest.mark.parametrize("good", [240, 6, 0.5, 100.0])
def test_numeric_capacity_accepts_finite_positive(good):
    f = _facts(_cable({"power_capacity_w": good}))
    assert _vals(f, "power_capacity_w") == [good]


def test_invalid_capacity_fails_closed_in_decision():
    for bad in (True, float("nan"), float("inf"), 0, -240, "240"):
        d = _decide(_cable({"power_capacity_w": bad}))
        assert "missing_wattage_evidence" in d.reason_codes
        assert "cable_capacity_covers_target" not in d.reason_codes


def test_spec_facts_path_is_validated_too():
    card = {"name": "x", "item_id": "1", "product_type": "cable",
            "spec_facts": {"power_capacity_w": float("nan"),
                           "max_current_a": 6}}
    f = _facts(card)
    assert not _vals(f, "power_capacity_w")
    assert _vals(f, "max_current_a") == [6]


# 9 -------------------------------------------------------------------------
def test_cross_item_capacity_never_answers_other_item():
    a = _cable({}, item_id="1")
    b = _cable(item_id="2")
    facts_b = _facts(b, "i:2")
    d = pr.resolve_compat(
        subject_id="i:1", target=f"device:{XIAOMI}", relation="charges",
        subject_facts=_facts(a, "i:1") + facts_b, target_facts=_device())
    assert "cable_capacity_covers_target" not in d.reason_codes
    assert "missing_wattage_evidence" in d.reason_codes
    assert {f.subject_id for f in facts_b} == {"i:2"}


def test_cross_item_product_type_never_borrowed():
    cable_f = _facts(_cable(), "i:2")
    adapter = _adapter({"power_capacity_w": 240})
    d = pr.resolve_compat(
        subject_id="i:1", target=f"device:{XIAOMI}", relation="charges",
        subject_facts=_facts(adapter, "i:1") + cable_f,
        target_facts=_device())
    assert "cable_capacity_covers_target" not in d.reason_codes


# 10 ------------------------------------------------------------------------
def _doc(**kw):
    d = {"item_id": 1, "item_name": "CTC620P สายชาร์จ", "item_status": "NORMAL",
         "shopname": "t", "model": [{"model_id": 7, "model_name": "2m"}]}
    d.update(kw)
    return d


def _unit_from_doc(doc):
    return bsu._build_unit(doc, doc["model"][0], {}, [], idx=0)


def test_generation_record_preserves_normalized_canonical_specs():
    u = _unit_from_doc(_doc(canonical_specs=SPECS_240))
    assert u["canonical_specs"] == SPECS_240
    card = _units.to_unit_card({**u, "_listing": {
        "item_status": "NORMAL", "model": doc_models(), "tier_variation": []}})
    assert card["canonical_specs"] == SPECS_240


def doc_models():
    return [{"model_id": 7, "model_name": "2m", "model_status": "MODEL_NORMAL",
             "stock_info_v2": {"summary_info": {"total_available_stock": 3}}}]


@pytest.mark.parametrize("bad", [..., None, "240W", ["x"], 240])
def test_generation_record_missing_or_non_dict_specs_fail_closed(bad):
    doc = _doc() if bad is ... else _doc(canonical_specs=bad)
    u = _unit_from_doc(doc)
    assert u["canonical_specs"] == {}
    card = _units.to_unit_card({**u, "_listing": {
        "item_status": "NORMAL", "model": doc_models(), "tier_variation": []}})
    assert card["canonical_specs"] == {}


def test_generation_does_not_extract_capacity_from_name_or_description():
    u = _unit_from_doc(_doc(item_name="CTC620P 240W 6A PD3.1",
                            description="รองรับ 240W 6A PD3.1"))
    assert u["canonical_specs"] == {}


def test_runtime_owners_have_no_model_name_hardcode():
    src = "".join(inspect.getsource(m) for m in (pr, _units, bsu))
    for tok in ("CTC620P", "17 Ultra", "xiaomi 17"):
        assert tok not in src
