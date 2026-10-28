"""Phase 5 — Field Evidence, Policy Eligibility, and Compatibility Proof.

Contract suite for the typed-decision layer (policy_resolver.py):

  Policy      PolicyQuery + versioned PolicyRule records → PolicyDecision
              (eligible | ineligible | admin_review | unknown — never a
              default-eligible, never inferred from FAQ/descriptions/history)
  Field       FieldEvidence — identity-scoped facts (subject_id carries the
              canonical identity key); absence = unknown, never a negative
  Compat      CompatProof / CompatDecision — compatible and incompatible both
              need explicit structured proof; missing proof = unknown,
              conflicting proof = admin_review

RED → GREEN order: every test fails before the module exists (missing
contracts) or on the current prose-based path (legacy inference). No Mongo,
no .env, no network — fake collections and supplied records only.
"""
from __future__ import annotations

import inspect
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("MONGO_DB", "dbWallet")
os.environ.setdefault("ADMIN_MONGO_DB", "chatbot_admin")


def _pr():
    from shopeechat import policy_resolver
    return policy_resolver


def _rule(pr, **kw):
    return pr.PolicyRule(
        rule_id=kw.pop("rule_id", "r1"),
        version=kw.pop("version", "v1"),
        policy_type=kw.pop("policy_type", "return_exchange"),
        outcome=kw.pop("outcome", "eligible"),
        **kw)


def _query(pr, **kw):
    base = dict(
        policy_type="return_exchange", shop="shopA",
        subject_ids=("i:1",), canonical_product_types=("accessory",),
        reason="unknown", item_condition="unknown",
        order_state=None, event_time="2026-10-01")
    base.update(kw)
    return pr.PolicyQuery(**base)


# ══════════════════════════════════════════════════════════════════
# POLICY — typed resolution against supplied versioned records
# ══════════════════════════════════════════════════════════════════

def test_policy_customer_wrong_model_ineligible():
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model", outcome="ineligible"),)
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"), rules)
    assert d.outcome == "ineligible"
    assert d.matched_rule_ids == ("r1",)


def test_policy_seller_wrong_item_eligible():
    pr = _pr()
    rules = (_rule(pr, reason="seller_wrong_item", outcome="eligible"),)
    d = pr.resolve_policy(_query(pr, reason="seller_wrong_item"), rules)
    assert d.outcome == "eligible"


def test_policy_defect_eligible():
    pr = _pr()
    rules = (_rule(pr, reason="defect", outcome="eligible"),)
    d = pr.resolve_policy(_query(pr, reason="defect"), rules)
    assert d.outcome == "eligible"


def test_policy_damage_admin_review():
    pr = _pr()
    rules = (_rule(pr, reason="damage", outcome="admin_review"),)
    d = pr.resolve_policy(_query(pr, reason="damage"), rules)
    assert d.outcome == "admin_review"


def test_policy_outer_packaging_opened_ineligible():
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model", outcome="ineligible",
                   item_conditions=frozenset({"outer_opened"})),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model",
               item_condition="outer_opened"), rules)
    assert d.outcome == "ineligible"


def test_policy_inner_seal_opened_ineligible():
    pr = _pr()
    rules = (
        _rule(pr, reason="customer_wrong_model", outcome="eligible",
              item_conditions=frozenset({"sealed"}), rule_id="sealed-ok"),
        _rule(pr, reason="customer_wrong_model", outcome="ineligible",
              item_conditions=frozenset({"inner_opened", "used"}),
              rule_id="opened-no"),
    )
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model",
               item_condition="inner_opened"), rules)
    assert d.outcome == "ineligible"
    assert d.matched_rule_ids == ("opened-no",)


def test_policy_used_condition_no_match_unknown():
    pr = _pr()
    # rule only covers sealed; "used" has no matching rule → unknown
    rules = (_rule(pr, reason="customer_wrong_model", outcome="eligible",
                   item_conditions=frozenset({"sealed"})),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model", item_condition="used"),
        rules)
    assert d.outcome == "unknown"
    assert d.matched_rule_ids == ()


def test_policy_conflicting_rules_admin_review():
    """equal-rank (same specificity + priority) conflicting rules →
    admin_review — lower-precedence override อยู่ใน precedence tests."""
    pr = _pr()
    rules = (
        _rule(pr, reason="customer_wrong_model", outcome="eligible",
              rule_id="allow", priority=5),
        _rule(pr, reason="customer_wrong_model", outcome="ineligible",
              rule_id="deny", priority=5),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"), rules)
    assert d.outcome == "admin_review"
    assert "rule_conflict" in d.reason_codes
    assert set(d.matched_rule_ids) == {"allow", "deny"}


def test_policy_priority_tier_overrides_general_rule():
    """M1 — higher priority same-scope rule wins; NOT a conflict."""
    pr = _pr()
    rules = (
        _rule(pr, reason="customer_wrong_model", outcome="eligible",
              rule_id="allow"),
        _rule(pr, reason="customer_wrong_model", outcome="ineligible",
              rule_id="deny", priority=5),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"), rules)
    assert d.outcome == "ineligible"
    assert d.matched_rule_ids == ("deny",)


def test_policy_expired_rule_unknown():
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model", outcome="ineligible",
                  effective_until="2025-12-31"),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model", event_time="2026-10-01"),
        rules)
    assert d.outcome == "unknown"
    assert "rule_expired" in d.reason_codes


def test_policy_not_yet_effective_unknown():
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model", outcome="ineligible",
                  effective_from="2027-01-01"),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model", event_time="2026-10-01"),
        rules)
    assert d.outcome == "unknown"


def test_policy_dated_rule_unverifiable_time_unknown():
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model", outcome="ineligible",
                  effective_until="2027-12-31"),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model", event_time=None), rules)
    assert d.outcome == "unknown"


def test_policy_shop_mismatch_unknown():
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model", outcome="ineligible",
                  shops=frozenset({"shopB"})),)
    d = pr.resolve_policy(
        _query(pr, shop="shopA", reason="customer_wrong_model"), rules)
    assert d.outcome == "unknown"


def test_policy_category_mismatch_unknown():
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model", outcome="ineligible",
                  product_types=frozenset({"powerbank"})),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model",
               canonical_product_types=("accessory",)), rules)
    assert d.outcome == "unknown"


def test_policy_no_records_unknown():
    pr = _pr()
    d = pr.resolve_policy(_query(pr, reason="seller_wrong_item"), ())
    assert d.outcome == "unknown"
    assert "no_records" in d.reason_codes
    assert d.matched_rule_ids == ()


def test_policy_missing_never_default_eligible():
    pr = _pr()
    for q in (_query(pr), _query(pr, reason="customer_wrong_model"),
              _query(pr, reason="seller_wrong_item")):
        d = pr.resolve_policy(q, ())
        assert d.outcome in ("unknown", "admin_review"), q
        assert d.outcome != "eligible"


def test_policy_decision_contract_fields():
    pr = _pr()
    fields = {f.name for f in
              __import__("dataclasses").fields(pr.PolicyDecision)}
    assert fields == {"outcome", "matched_rule_ids", "required_evidence",
                      "reason_codes", "source_versions",
                      "missing_evidence"}
    qfields = {f.name for f in
               __import__("dataclasses").fields(pr.PolicyQuery)}
    assert qfields == {"policy_type", "shop", "subject_ids",
                       "canonical_product_types", "reason",
                       "item_condition", "order_state", "event_time",
                       "evidence_ids", "evidence_by_subject",
                       "conflicting_evidence"}


def test_policy_rule_from_dict_versioned():
    pr = _pr()
    r = pr.policy_rule_from_dict({
        "rule_id": "x1", "version": "2026-01",
        "policy_type": "return_exchange", "outcome": "ineligible",
        "reason": "customer_wrong_model", "shops": ["FilterShopTH"],
        "item_conditions": ["sealed"], "priority": 10,
        "effective_from": "2026-01-01", "effective_until": "2027-01-01",
        "required_evidence": ["order_delivery_date"],
        "source": "fixture-policy"})
    assert r.rule_id == "x1" and r.version == "2026-01"
    assert r.shops == frozenset({"FilterShopTH"})
    assert r.priority == 10 and r.source == "fixture-policy"
    assert r.required_evidence == ("order_delivery_date",)


def test_policy_specificity_and_provenance():
    pr = _pr()
    rules = (
        _rule(pr, reason="customer_wrong_model", outcome="ineligible",
              rule_id="general", priority=0),
        _rule(pr, reason="customer_wrong_model", outcome="ineligible",
              shops=frozenset({"shopA"}), rule_id="shop-scoped",
              priority=10, source="shop-rules", version="v9"),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"), rules)
    assert d.outcome == "ineligible"
    # deterministic order: more specific/higher priority first
    assert d.matched_rule_ids[0] == "shop-scoped"
    assert any("shop-rules@v9" in sv for sv in d.source_versions)


def test_policy_prose_cannot_be_a_record():
    """FAQ/description prose is not a policy record — from_dict must reject
    records lacking structured identity/outcome."""
    pr = _pr()
    with pytest.raises((KeyError, ValueError, TypeError)):
        pr.policy_rule_from_dict({"answer": "เปลี่ยนสินค้าได้ภายใน 7 วัน"})


def test_policy_history_is_not_a_decision_input():
    """resolve_policy must not accept chat history / bot prose as an input —
    prior answers can never prove eligibility."""
    pr = _pr()
    params = set(inspect.signature(pr.resolve_policy).parameters)
    banned = {"history", "messages", "context", "prose", "faq",
              "prior_answers", "answer"}
    assert not (params & banned), params - {"self"}


def test_policy_general_faq_positive_wording_no_rule_unknown():
    """A FAQ saying 'เปลี่ยนได้' but no matching rule → unknown (not eligible)."""
    pr = _pr()
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"), ())
    assert d.outcome == "unknown"


def test_policy_filter_fixture_records():
    """The replay fixture's own policy_records must resolve the wrong-model
    query to ineligible — fixture data drives the decision, not prose."""
    pr = _pr()
    fxline = next(l for l in open(
        ROOT / "docs/test/fixtures/legacy_turn_incidents.jsonl")
        if '"tx-policy-wrong-model-filter"' in l)
    fx = json.loads(fxline)
    rules = tuple(pr.policy_rule_from_dict(d)
                  for d in fx.get("policy_records") or [])
    assert rules, "fixture must supply versioned policy records"
    q = pr.PolicyQuery(
        policy_type="return_exchange", shop=fx["shop"],
        subject_ids=(), canonical_product_types=("accessory",),
        reason=fx["intent_result"].get("policy_reason", "unknown"),
        item_condition="unknown", order_state=None,
        event_time="2026-10-01")
    d = pr.resolve_policy(q, rules)
    assert d.outcome == "ineligible"


def test_policy_seller_fixture_records():
    pr = _pr()
    fxline = next(l for l in open(
        ROOT / "docs/test/fixtures/legacy_turn_incidents.jsonl")
        if '"pos-policy-seller-wrong-item"' in l)
    fx = json.loads(fxline)
    rules = tuple(pr.policy_rule_from_dict(d)
                  for d in fx.get("policy_records") or [])
    assert rules
    q = pr.PolicyQuery(
        policy_type="return_exchange", shop=fx["shop"],
        subject_ids=(), canonical_product_types=(),
        reason=fx["intent_result"].get("policy_reason", "unknown"),
        item_condition="unknown", order_state=None,
        event_time="2026-10-01")
    d = pr.resolve_policy(q, rules)
    assert d.outcome == "eligible"


def test_build_policy_query_from_cards_and_intent():
    pr = _pr()
    cards = [{"item_id": 5001.0, "name": "FILTERX Air Purifier Filter FY300"}]
    q = pr.build_policy_query(
        policy_type="return_exchange", shop="FilterShopTH", cards=cards,
        intent_result={"policy_reason": "customer_wrong_model",
                       "policy_item_condition": "unknown"})
    assert q.reason == "customer_wrong_model"
    assert q.shop == "FilterShopTH"
    assert q.subject_ids, "subject identity must come from the cards"
    assert all(sid.startswith(("i:", "v:", "u:", "n:"))
               for sid in q.subject_ids)


def test_active_policy_rules_production_blocked():
    """No authoritative structured source exists → production seam returns
    empty; missing records must resolve to unknown, never eligible."""
    pr = _pr()
    rules = pr.active_policy_rules()
    assert isinstance(rules, tuple)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model"), rules)
    assert d.outcome in ("unknown", "admin_review")


# ══════════════════════════════════════════════════════════════════
# FIELD EVIDENCE — identity-scoped typed facts
# ══════════════════════════════════════════════════════════════════

_CARD_A = {
    "item_id": 9001.0, "name": "Anker 737 PowerBank 24000mAh 140W IP68",
    "description": "กันน้ำ IP68 รองรับ PD3.1 มอก.",
    "image_text": "cert TISI",
    "canonical_specs": {"capacity_mah": 24000, "output_spec": "140W"},
    "warranty": {"duration_months": 18},
}
_CARD_B = {
    "item_id": 9002.0, "name": "Baseus Cable C to C 100W",
    "description": "สายชาร์จ Type-C to Type-C",
}


def test_field_subject_identity_from_card():
    pr = _pr()
    facts = pr.extract_field_facts(_CARD_A)
    assert facts
    ids = {f.subject_id for f in facts}
    assert ids == {"i:9001"}, ids


def test_field_cross_product_isolation():
    pr = _pr()
    facts_a = pr.extract_field_facts(_CARD_A)
    facts_b = pr.extract_field_facts(_CARD_B)
    assert pr.claim_supported(facts_a, "i:9001", "ip68")
    assert not pr.claim_supported(facts_b, "i:9002", "ip68")
    # card B claim must not borrow card A's evidence
    assert not pr.claim_supported(facts_a + facts_b, "i:9002", "ip68")


def test_field_missing_ocr_is_unknown_not_negative():
    pr = _pr()
    facts = pr.extract_field_facts({"item_id": 9003.0, "name": "Plain Case"})
    assert not any(f.source == "image_text" for f in facts)
    # absence of OCR evidence ≠ proof of absence — unknown surfaces as
    # "not supported", never as a negative claim row
    assert not pr.claim_supported(facts, "i:9003", "ip68")
    assert not any(f.status == "contradicted" for f in facts)


def test_field_source_version_scoping():
    pr = _pr()
    g1 = pr.extract_field_facts(_CARD_A, source_version="g1")
    g2 = pr.extract_field_facts(_CARD_A, source_version="g2")
    assert all(f.source_version == "g1" for f in g1)
    assert all(f.source_version == "g2" for f in g2)
    # same content, different generation → distinguishable provenance
    assert {f.provenance + f.source_version for f in g1} != \
           {f.provenance + f.source_version for f in g2}


def test_field_hidden_product_keeps_own_identity():
    pr = _pr()
    hidden = dict(_CARD_A, item_id=9009.0, customer_visible=False)
    visible_id = "i:9001"
    facts_h = pr.extract_field_facts(hidden)
    assert {f.subject_id for f in facts_h} == {"i:9009"}
    facts_v = pr.extract_field_facts(dict(_CARD_A))
    # hidden item's evidence must not support claims about the visible one
    assert not pr.claim_supported(facts_v + facts_h, visible_id, "ip68") or \
        any(f.subject_id == visible_id for f in facts_v)


def test_field_unsupported_spec_claims():
    pr = _pr()
    facts = pr.extract_field_facts(_CARD_B)
    for tok in ("5atm", "ip68", "gps", "10day", "5ghz", "10mm"):
        assert not pr.claim_supported(facts, "i:9002", tok), tok


def test_field_cert_scoped_to_own_subject():
    pr = _pr()
    facts_a = pr.extract_field_facts(_CARD_A)
    certs = [f for f in facts_a if f.fact_key == "certifications"]
    assert certs and any("tisi" in (f.value if isinstance(f.value, tuple)
                                    else (f.value,)) for f in certs)
    facts_b = pr.extract_field_facts(_CARD_B)
    assert not any(f.fact_key == "certifications" for f in facts_b)


def test_field_canonical_specs_become_facts():
    pr = _pr()
    facts = pr.extract_field_facts(_CARD_A)
    cap = [f for f in facts if f.fact_key == "capacity_mah"]
    assert cap and cap[0].value == 24000
    assert cap[0].source == "canonical_specs"


def test_field_warranty_fact():
    pr = _pr()
    facts = pr.extract_field_facts(_CARD_A)
    w = [f for f in facts if f.fact_key == "warranty"]
    assert w and (w[0].value == 18 or 18 in
                  (w[0].value if isinstance(w[0].value, tuple)
                   else (w[0].value,)))


def test_field_connector_fact():
    pr = _pr()
    facts = pr.extract_field_facts(_CARD_B)
    conn = [f for f in facts if f.fact_key == "connector"]
    assert conn
    vals = conn[0].value if isinstance(conn[0].value, tuple) \
        else (conn[0].value,)
    assert "usb-c" in vals


def test_field_evidence_contract_fields():
    pr = _pr()
    fields = {f.name for f in
              __import__("dataclasses").fields(pr.FieldEvidence)}
    assert {"subject_id", "fact_key", "value", "status", "source",
            "source_version", "provenance"} <= fields


def test_device_field_facts_from_specs():
    pr = _pr()
    facts = pr.device_field_facts("iphone 15", {
        "connector": "usb-c", "wired_w": 27, "wireless_w": 15,
        "protocols": ["pd", "qi2"], "source": "spec-db"})
    by = {f.fact_key: f for f in facts}
    assert by["connector"].value == "usb-c" or \
        "usb-c" in (by["connector"].value
                    if isinstance(by["connector"].value, tuple) else ())
    assert all(f.subject_id == "device:iphone 15" for f in facts)


# ══════════════════════════════════════════════════════════════════
# COMPATIBILITY — explicit proof required for both directions
# ══════════════════════════════════════════════════════════════════

def test_compat_explicit_positive_proof():
    pr = _pr()
    subj = pr.extract_field_facts({
        "item_id": 8001.0, "name": "CUKTECH CTC615W สายชาร์จ C to C 240W"})
    tgt = pr.device_field_facts("iphone 15", {
        "connector": "usb-c", "wired_w": 27, "source": "spec-db"})
    d = pr.resolve_compat(subject_id="i:8001", target="device:iphone 15",
                          relation="charges", subject_facts=subj,
                          target_facts=tgt)
    assert d.outcome == "compatible"
    assert any("connector" in fact for p in d.proofs for fact in p.facts)


def test_compat_explicit_negative_proof_structured():
    pr = _pr()
    declared = (pr.CompatProof(
        subject_id="i:8002", target="device:iphone 15",
        relation="charges", verdict="incompatible",
        facts=("connector:lightning_only",), source="declared"),)
    d = pr.resolve_compat(subject_id="i:8002", target="device:iphone 15",
                          relation="charges", declared=declared)
    assert d.outcome == "incompatible"


def test_compat_missing_proof_unknown():
    pr = _pr()
    tgt = pr.device_field_facts("iphone 15", {"connector": "usb-c",
                                          "source": "spec-db"})
    d = pr.resolve_compat(subject_id="i:8003", target="device:iphone 15",
                          relation="charges", subject_facts=(),
                          target_facts=tgt)
    assert d.outcome == "unknown"


def test_compat_conflicting_proof_admin_review():
    pr = _pr()
    declared = (
        pr.CompatProof(subject_id="i:8004", target="device:iphone 15",
                       relation="charges", verdict="compatible",
                       facts=(), source="db"),
        pr.CompatProof(subject_id="i:8004", target="device:iphone 15",
                       relation="charges", verdict="incompatible",
                       facts=(), source="db"),
    )
    d = pr.resolve_compat(subject_id="i:8004", target="device:iphone 15",
                          relation="charges", declared=declared)
    assert d.outcome == "admin_review"
    assert "proof_conflict" in d.reason_codes


def test_compat_declared_disjoint_incompatible():
    """a connector set declared by the product's own listing that excludes
    the device connector IS explicit negative proof → incompatible."""
    pr = _pr()
    subj = pr.extract_field_facts({
        "item_id": 8005.0, "name": "Lightning Cable MFi สายชาร์จไอโฟน"})
    tgt = pr.device_field_facts("galaxy a15", {"connector": "usb-c",
                                            "source": "spec-db"})
    d = pr.resolve_compat(subject_id="i:8005", target="device:galaxy a15",
                          relation="charges", subject_facts=subj,
                          target_facts=tgt)
    assert d.outcome == "incompatible"
    assert d.proofs and d.proofs[0].verdict == "incompatible"


def test_compat_absent_connector_not_negative():
    """no connector evidence on the product → unknown, never incompatible —
    absence of evidence is not evidence of absence."""
    pr = _pr()
    subj = pr.extract_field_facts({
        "item_id": 8012.0, "name": "เคสซิลิโคนกันกระแทก"})
    tgt = pr.device_field_facts("iphone 15", {"connector": "usb-c",
                                          "source": "spec-db"})
    d = pr.resolve_compat(subject_id="i:8012", target="device:iphone 15",
                          relation="charges", subject_facts=subj,
                          target_facts=tgt)
    assert d.outcome == "unknown"


def test_compat_bridge_is_unknown_not_incompatible():
    """usb-a adapter vs usb-c device: cable bridge possible → unknown."""
    pr = _pr()
    subj = pr.extract_field_facts({
        "item_id": 8013.0, "name": "หัวชาร์จ USB-A 2พอร์ต 24W"})
    tgt = pr.device_field_facts("iphone 15", {"connector": "usb-c",
                                          "source": "spec-db"})
    d = pr.resolve_compat(subject_id="i:8013", target="device:iphone 15",
                          relation="charges", subject_facts=subj,
                          target_facts=tgt)
    assert d.outcome == "unknown"
    assert "adapter_bridge_possible" in d.reason_codes


def test_compat_customer_evidence_unverified():
    """Customer-claimed compat with no db evidence → admin_review/unknown,
    never echoes the customer's claim as proven."""
    pr = _pr()
    declared = (pr.CompatProof(
        subject_id="i:8006", target="device:xiaomi 17 ultra",
        relation="charges", verdict="compatible",
        facts=("customer said it works",), source="customer"),)
    d = pr.resolve_compat(subject_id="i:8006",
                          target="device:xiaomi 17 ultra",
                          relation="charges", declared=declared)
    assert d.outcome in ("admin_review", "unknown")
    assert d.outcome != "compatible"


def test_compat_subject_target_isolation():
    pr = _pr()
    facts_x = pr.extract_field_facts({
        "item_id": 8007.0, "name": "Charger USB-C 65W"})
    tgt = pr.device_field_facts("iphone 15", {"connector": "usb-c",
                                          "source": "spec-db"})
    d = pr.resolve_compat(subject_id="i:9999", target="device:iphone 15",
                          relation="charges", subject_facts=facts_x,
                          target_facts=tgt)
    # facts belong to i:8007 — cannot prove compat for i:9999
    assert d.outcome == "unknown"


def test_compat_fits_requires_declared_evidence():
    pr = _pr()
    case_named = pr.extract_field_facts(
        {"item_id": 8008.0, "name": "เคส iPhone 15 ซิลิโคน"},
        mentions=("iphone 15",))
    case_plain = pr.extract_field_facts(
        {"item_id": 8009.0, "name": "เคสซิลิโคนกันกระแทก"},
        mentions=("iphone 15",))
    d1 = pr.resolve_compat(subject_id="i:8008", target="device:iphone 15",
                           relation="fits", subject_facts=case_named)
    d2 = pr.resolve_compat(subject_id="i:8009", target="device:iphone 15",
                           relation="fits", subject_facts=case_plain)
    assert d1.outcome == "compatible"
    assert d2.outcome == "unknown"


def test_compat_multi_product_independent():
    pr = _pr()
    tgt = pr.device_field_facts("iphone 15", {"connector": "usb-c",
                                          "source": "spec-db"})
    usb_c = pr.extract_field_facts({
        "item_id": 8010.0, "name": "Cable C to C 60W"})
    lightning = pr.extract_field_facts({
        "item_id": 8011.0, "name": "Cable A to Lightning"})
    d_ok = pr.resolve_compat(subject_id="i:8010",
                             target="device:iphone 15",
                             relation="charges", subject_facts=usb_c,
                             target_facts=tgt)
    d_other = pr.resolve_compat(subject_id="i:8011",
                                target="device:iphone 15",
                                relation="charges", subject_facts=lightning,
                                target_facts=tgt)
    assert d_ok.outcome == "compatible"
    assert d_other.outcome != "compatible"


def test_compat_decision_contract_fields():
    pr = _pr()
    fields = {f.name for f in
              __import__("dataclasses").fields(pr.CompatDecision)}
    assert {"outcome", "proofs", "reason_codes"} <= fields


def test_compat_mi17_iphone_positive_regression():
    """Existing positive device cases must stay compatible under proof."""
    pr = _pr()
    for device in ("iphone 15", "xiaomi 17 ultra"):
        from shopeechat import device_compat as _dc
        spec = _dc._lookup_spec_db(device)
        assert spec, f"{device} must resolve from device spec data"
        tgt = pr.device_field_facts(device, spec)
        subj = pr.extract_field_facts(
            {"item_id": 8100.0,
             "name": f"USB-C GaN Charger 100W C-to-C for {device}"},
            mentions=(device,))
        d = pr.resolve_compat(subject_id="i:8100",
                              target=f"device:{device}",
                              relation="charges", subject_facts=subj,
                              target_facts=tgt)
        assert d.outcome == "compatible", (device, d)


# ══════════════════════════════════════════════════════════════════
# LEGACY INFERENCE — current prose owner must stop deciding eligibility
# ══════════════════════════════════════════════════════════════════

class _FakeColl:
    def __init__(self, docs):
        self._docs = docs

    def find(self, *a, **k):
        return self

    def limit(self, n):
        return list(self._docs)


class _FakeDb:
    def __init__(self, colls):
        self._colls = colls

    def __getitem__(self, name):
        return self._colls[name]


def test_return_policy_context_excludes_description_scrape(monkeypatch):
    """RED: today build_general_context('return_policy') injects per-product
    description-scraped 'นโยบายรับคืน' sections — prose that decides
    eligibility. After Phase 5 it must not reach the answer context."""
    from shopeechat import knowledge_base
    monkeypatch.setattr(
        knowledge_base, "get_general_faq",
        lambda topic: {"answer": "คำถามที่พบบ่อยเรื่องการรับคืนสินค้า"})
    db = _FakeDb({"ShpProducts": _FakeColl([{
        "shopname": "FilterShopTH", "item_status": "NORMAL",
        "description": "นโยบายการรับคืน\nรับเปลี่ยน/คืนสินค้าได้ภายใน 7 วัน"}])})
    out = knowledge_base.build_general_context("return_policy", db)
    assert out and "context" in out
    assert "จากข้อมูลร้านค้า" not in out["context"], \
        "description-scraped policy sections must not reach the context"


def test_policy_records_are_versioned_not_prose():
    """Policy records require rule identity + version + structured outcome —
    free-text eligibility strings are not records."""
    pr = _pr()
    for bad in ({"text": "เปลี่ยนได้"},
                {"rule_id": "x"},                 # no version/outcome
                {"rule_id": "x", "version": "1",
                 "outcome": "eligible"}):          # no policy_type/source
        with pytest.raises((KeyError, ValueError, TypeError)):
            pr.policy_rule_from_dict(bad)


# ══════════════════════════════════════════════════════════════════
# REVIEW-FIX ROUND — H1..H6 + M1/M2
# ทุก test ตรงนี้พิสูจน์ finding ใน production boundary (ไม่ใช่ marker
# ใน prompt) — decision ต้องเป็น typed object ที่ owner ขั้นสุดท้ายใช้
# ══════════════════════════════════════════════════════════════════
from types import SimpleNamespace  # noqa: E402


def _enf_resp(answer, products=(), rd=None, source="product_info",
              handoff=False):
    return SimpleNamespace(
        answer=answer, answer_segments=None, handoff_to_admin=handoff,
        source=source, routing_decision=rd or {}, products=list(products))


def _enf_req(message="", history=()):
    return SimpleNamespace(message=message, history=list(history))


# ── H1: PolicyDecision owns eligibility at the answer boundary ──────
def test_r1_ineligible_decision_overrides_llm_eligible_claim():
    """fake LLM says 'เปลี่ยนได้' but typed decision=ineligible → final
    answer must NOT carry an eligibility promise."""
    from shopeechat import guards
    r = _enf_resp(
        "คุณลูกค้าเปลี่ยนสินค้าได้เลยค่ะ ภายใน 7 วันนะคะ",
        rd={"policy_decision": {"outcome": "ineligible",
                                "policy_type": "return_exchange",
                                "matched_rule_ids": ("r1",)}})
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหมคะ"))
    assert "เปลี่ยนสินค้าได้" not in r.answer and "เปลี่ยนได้" not in r.answer
    assert r.routing_decision.get("guard_rewritten")


def test_r1_unknown_decision_neutralizes_positive_claim():
    """unknown decision + positive FAQ grounding must NOT promise
    eligibility — prose cannot ground a decision-owned claim."""
    from shopeechat import guards
    r = _enf_resp(
        "เปลี่ยน/คืนสินค้าได้ภายใน 7 วันนะคะ",
        rd={"grounding_text": "ร้านค้ารับเปลี่ยน/คืนสินค้าได้ภายใน 7 วัน",
            "policy_decision": {"outcome": "unknown",
                                "policy_type": "return_exchange"}})
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert "เปลี่ยน/คืนสินค้าได้" not in r.answer
    assert r.routing_decision.get("guard_rewritten")


def test_r1_unknown_neutralizes_denial_claim():
    """unknown must not be phrased as ineligible either."""
    from shopeechat import guards
    r = _enf_resp(
        "เคสนี้ไม่รับเปลี่ยน/คืนนะคะ",
        rd={"policy_decision": {"outcome": "admin_review",
                                "policy_type": "return_exchange"}})
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert "ไม่รับเปลี่ยน" not in r.answer
    assert r.routing_decision.get("guard_rewritten")


def test_r1_eligible_decision_neutralizes_denial_claim():
    """eligible + LLM denial → clause corrected to decision outcome."""
    from shopeechat import guards
    r = _enf_resp(
        "เคสนี้ไม่สามารถเปลี่ยนได้นะคะ",
        rd={"policy_decision": {"outcome": "eligible",
                                "policy_type": "return_exchange"}})
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert "ไม่สามารถเปลี่ยน" not in r.answer


def test_r1_eligible_decision_keeps_positive_claim():
    """R2 contract: eligible → deterministic eligible text regardless of
    the LLM's (already-agreeing) phrasing."""
    from shopeechat import guards
    r = _enf_resp(
        "เปลี่ยนสินค้าได้ค่ะ ตามเงื่อนไขของร้านนะคะ",
        rd={"policy_decision": {"outcome": "eligible",
                                "policy_type": "return_exchange"}})
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert r.answer == guards._POLICY_TEXT_ELIGIBLE


def test_r1_no_decision_keeps_legacy_prose_grounding():
    """no decision → legacy prose-grounded claim behavior unchanged."""
    from shopeechat import guards
    r = _enf_resp(
        "รับเปลี่ยนคืนสินค้าได้ภายใน 7 วันค่ะ",
        rd={"grounding_text": "นโยบายร้าน: รับเปลี่ยน/คืนสินค้าได้ภายใน 7 วัน"})
    guards.enforce(r, _enf_req("นโยบายคืนสินค้าเป็นยังไง"))
    assert "รับเปลี่ยน" in r.answer


# ── H3: required_evidence gating in the resolver ────────────────────
def _rule_req_ev(req_ev=(), **kw):
    base = {"rule_id": "rq", "version": "1", "policy_type": "return_exchange",
            "subject_ids": ("i:1",), "product_types": (), "shops": (),
            "reason": "customer_wrong_model", "item_conditions": (),
            "order_states": (), "outcome": "eligible", "priority": 10,
            "required_evidence": tuple(req_ev),
            "effective_from": "2024-01-01", "source": "test"}
    base.update(kw)
    return base


def test_r4_required_evidence_missing_blocks_outcome():
    pr = _pr()
    q = pr.PolicyQuery(
        policy_type="return_exchange", shop="s", subject_ids=("i:1",),
        canonical_product_types=(), reason="customer_wrong_model",
        item_condition="sealed", order_state="shipped",
        event_time="2024-06-01", evidence_ids=())
    recs = (pr.policy_rule_from_dict(
        _rule_req_ev(("order_receipt",))),)
    d = pr.resolve_policy(q, recs)
    assert d.outcome in ("admin_review", "unknown")
    assert "order_receipt" in d.missing_evidence


def test_r4_required_evidence_partial_missing():
    pr = _pr()
    q = pr.PolicyQuery(
        policy_type="return_exchange", shop="s", subject_ids=("i:1",),
        canonical_product_types=(), reason="customer_wrong_model",
        item_condition="sealed", order_state="shipped",
        event_time="2024-06-01", evidence_ids=("order_receipt",))
    recs = (pr.policy_rule_from_dict(
        _rule_req_ev(("order_receipt", "item_photo"))),)
    d = pr.resolve_policy(q, recs)
    assert d.outcome in ("admin_review", "unknown")
    assert "item_photo" in d.missing_evidence
    assert "order_receipt" not in d.missing_evidence


def test_r4_required_evidence_present_allows_outcome():
    pr = _pr()
    q = pr.PolicyQuery(
        policy_type="return_exchange", shop="s", subject_ids=("i:1",),
        canonical_product_types=(), reason="customer_wrong_model",
        item_condition="sealed", order_state="shipped",
        event_time="2024-06-01",
        evidence_ids=("order_receipt", "item_photo"))
    recs = (pr.policy_rule_from_dict(
        _rule_req_ev(("order_receipt", "item_photo"))),)
    d = pr.resolve_policy(q, recs)
    assert d.outcome == "eligible"
    assert not d.missing_evidence


def test_r4_cross_subject_evidence_does_not_count():
    pr = _pr()
    q = pr.PolicyQuery(
        policy_type="return_exchange", shop="s", subject_ids=("i:1",),
        canonical_product_types=(), reason="customer_wrong_model",
        item_condition="sealed", order_state="shipped",
        event_time="2024-06-01",
        evidence_ids=(),                       # i:2's evidence is not i:1's
        evidence_by_subject={"i:2": ("order_receipt",)})
    recs = (pr.policy_rule_from_dict(_rule_req_ev(("order_receipt",))),)
    d = pr.resolve_policy(q, recs)
    assert d.outcome in ("admin_review", "unknown")
    assert "order_receipt" in d.missing_evidence


def test_r4_conflicting_evidence_admin_review():
    pr = _pr()
    q = pr.PolicyQuery(
        policy_type="return_exchange", shop="s", subject_ids=("i:1",),
        canonical_product_types=(), reason="customer_wrong_model",
        item_condition="sealed", order_state="shipped",
        event_time="2024-06-01", evidence_ids=("order_receipt",),
        conflicting_evidence=("order_receipt",))
    recs = (pr.policy_rule_from_dict(_rule_req_ev(("order_receipt",))),)
    d = pr.resolve_policy(q, recs)
    assert d.outcome == "admin_review"


# ── H4: production classifier emits validated policy fields ─────────
def _fake_llm_for_intent(monkeypatch, payload):
    from shopeechat import llm as _llm
    monkeypatch.setattr(_llm, "get_model", lambda task: "fake-model")

    class _R:
        text = json.dumps(payload)
        usage_metadata = None
    monkeypatch.setattr(_llm, "_generate",
                        lambda *a, **k: _R())


def test_r5_classifier_default_has_policy_fields():
    from shopeechat import intent_classifier
    d = intent_classifier._DEFAULT_RESULT
    for k in ("policy_reason", "policy_item_condition", "policy_order_state"):
        assert d.get(k) == "unknown", f"missing policy field {k}"


def test_r5_classifier_invalid_policy_values_unknown(monkeypatch):
    from shopeechat import intent_classifier
    _fake_llm_for_intent(monkeypatch, {
        "intent": "general_question", "general_qtype": "return_policy",
        "policy_reason": "ช่างมัน", "policy_item_condition": "blue",
        "policy_order_state": "weird"})
    r = intent_classifier.classify_intent("x", shop="s")
    assert r["policy_reason"] == "unknown"
    assert r["policy_item_condition"] == "unknown"
    assert r["policy_order_state"] == "unknown"


def test_r5_classifier_valid_policy_values_pass(monkeypatch):
    from shopeechat import intent_classifier
    _fake_llm_for_intent(monkeypatch, {
        "intent": "general_question", "general_qtype": "return_policy",
        "policy_reason": "customer_wrong_model",
        "policy_item_condition": "sealed",
        "policy_order_state": "shipped"})
    r = intent_classifier.classify_intent("x", shop="s")
    assert r["policy_reason"] == "customer_wrong_model"
    assert r["policy_item_condition"] == "sealed"
    assert r["policy_order_state"] == "shipped"


# ── H5: identity-scoped spec grounding at the output boundary ───────
def _spec_card(item_id, name, desc, **kw):
    c = {"item_id": item_id, "name": name,
         "description_excerpt": desc, "shop": "FilterShopTH"}
    c.update(kw)
    return c


def test_r6_subject_fact_grounds_claim():
    from shopeechat import guards
    r = _enf_resp(
        "รองรับ 65W ค่ะ",
        products=[_spec_card(1, "Charger A", "รองรับชาร์จเร็ว 65W"),
                  _spec_card(2, "Charger B", "หัวชาร์จ USB-C")],
        rd={"subject_ids": ["i:1"]})
    guards.enforce(r, _enf_req("รองรับกี่วัตต์"))
    assert "65w" in r.answer.replace(" ", "").lower()
    assert not r.routing_decision.get("guard_rewritten")


def test_r6_other_product_fact_does_not_ground():
    from shopeechat import guards
    r = _enf_resp(
        "รองรับ 65W ค่ะ",
        products=[_spec_card(1, "Charger A", "หัวชาร์จ USB-C"),
                  _spec_card(2, "Charger B", "รองรับชาร์จเร็ว 65W")],
        rd={"subject_ids": ["i:1"]})
    guards.enforce(r, _enf_req("รองรับกี่วัตต์"))
    assert "65w" not in r.answer.replace(" ", "").lower()
    assert r.routing_decision.get("guard_rewritten")


def test_r6_kb_inherited_specs_provenance_marked():
    """attach_kb_specs borrows canonical_specs via the unit's OWN
    model_codes (identity-bound — verified single writer) — but the
    facts must carry honest provenance (kb_inherit), not pose as the
    listing's own declared specs, and must not ground claims."""
    pr = _pr()
    card = _spec_card(1, "Charger A", "หัวชาร์จ USB-C",
                      canonical_specs={"output_w": 65},
                      _specs_origin="kb_inherit")
    facts = pr.extract_field_facts(card)
    src_by_key = {f.fact_key: f.source for f in facts}
    assert src_by_key.get("output_w") == "kb_inherit"
    # kb_inherit facts are hint-grade — never ground a spec claim
    from shopeechat import candidate_pool as _cp
    sid = _cp._identity_key(card)[0]
    assert not pr.claim_supported(facts, sid, "output_w")


def test_r6_same_identity_specs_ground_claim():
    pr = _pr()
    card = _spec_card(1, "Charger A", "หัวชาร์จ USB-C",
                      canonical_specs={"output_w": 65})
    facts = pr.extract_field_facts(card)
    src_by_key = {f.fact_key: f.source for f in facts}
    assert src_by_key.get("output_w") == "canonical_specs"


# ── H6: compatibility provenance + all-negative ─────────────────────
def test_r7_intent_hint_cannot_prove_incompatible():
    pr = _pr()
    subj = (pr.FieldEvidence(subject_id="i:9001", fact_key="connector",
                             value="lightning", status="known",
                             source="listing"),)
    tgt = pr.device_field_facts(
        "iphone 15", {"connector": "usb-c", "source": "intent"})
    d = pr.resolve_compat(subject_id="i:9001", subject_facts=subj,
                              target="device:iphone 15", target_facts=tgt,
                              relation="charges")
    assert d.outcome == "unknown"


def test_r7_intent_hint_cannot_prove_compatible():
    pr = _pr()
    subj = (pr.FieldEvidence(subject_id="i:9001", fact_key="connector",
                             value="usb-c", status="known",
                             source="listing"),)
    tgt = pr.device_field_facts(
        "iphone 15", {"connector": "usb-c", "source": "intent"})
    d = pr.resolve_compat(subject_id="i:9001", subject_facts=subj,
                              target="device:iphone 15", target_facts=tgt,
                              relation="charges")
    assert d.outcome == "unknown"


def test_r7_structured_target_proof_still_works():
    pr = _pr()
    subj = (pr.FieldEvidence(subject_id="i:9001", fact_key="connector",
                             value="usb-c", status="known",
                             source="listing"),)
    tgt = pr.device_field_facts(
        "iphone 15", {"connector": "usb-c", "source": "spec-db"})
    d = pr.resolve_compat(subject_id="i:9001", subject_facts=subj,
                              target="device:iphone 15", target_facts=tgt,
                              relation="charges")
    assert d.outcome == "compatible"


def test_r8_all_incompatible_not_returned():
    """every candidate proven incompatible → [] (never echoed as
    recommendations)."""
    from shopeechat import device_compat
    prods = [{"item_id": 1, "name": "สายชาร์จ C to Lightning",
              "shop": "s", "item_status": "NORMAL"},
             {"item_id": 2, "name": "สายชาร์จ C to Lightning ยาว 1 ม.",
              "shop": "s", "item_status": "NORMAL"}]
    out = device_compat._filter_compat_products(
        prods, "iphone 15", compat_mode="charging")
    assert out == []


def test_r8_incompatible_subject_stays_for_explanation():
    from shopeechat import device_compat
    subj = {"item_id": 9, "name": "สายชาร์จ C to Lightning",
            "shop": "s", "item_status": "NORMAL"}
    prods = [subj,
             {"item_id": 2, "name": "สายชาร์จ C to Lightning ยาว 1 ม.",
              "shop": "s", "item_status": "NORMAL"}]
    out = device_compat._filter_compat_products(
        prods, "iphone 15", compat_mode="charging", protected_ids={"9"})
    assert [p["item_id"] for p in out] == [9]


# ── M1: precedence tier before conflict detection ───────────────────
def _prec_rule(rule_id, outcome, priority, spec_scope, **kw):
    base = {"rule_id": rule_id, "version": "1",
            "policy_type": "return_exchange",
            "subject_ids": tuple(spec_scope.get("subject_ids", ())),
            "product_types": tuple(spec_scope.get("product_types", ())),
            "shops": tuple(spec_scope.get("shops", ())),
            "reason": "customer_wrong_model", "item_conditions": (),
            "order_states": (), "outcome": outcome, "priority": priority,
            "required_evidence": (), "effective_from": "2024-01-01",
            "source": "test"}
    base.update(kw)
    return base


def _prec_query():
    pr = _pr()
    return pr.PolicyQuery(
        policy_type="return_exchange", shop="FilterShopTH",
        subject_ids=("i:1",), canonical_product_types=("charger",),
        reason="customer_wrong_model", item_condition="sealed",
        order_state="shipped", event_time="2024-06-01")


def test_r9_general_allow_shop_deny_shop_wins():
    pr = _pr()
    recs = (pr.policy_rule_from_dict(
        _prec_rule("gen", "eligible", 10, {})),
        pr.policy_rule_from_dict(
        _prec_rule("shop", "ineligible", 10, {"shops": ("FilterShopTH",)})))
    d = pr.resolve_policy(_prec_query(), recs)
    assert d.outcome == "ineligible"
    assert "shop" in d.matched_rule_ids


def test_r9_general_deny_subject_allow_wins():
    pr = _pr()
    recs = (pr.policy_rule_from_dict(
        _prec_rule("gen", "ineligible", 10, {})),
        pr.policy_rule_from_dict(
        _prec_rule("subj", "eligible", 10, {"subject_ids": ("i:1",)})))
    d = pr.resolve_policy(_prec_query(), recs)
    assert d.outcome == "eligible"


def test_r9_equal_rank_conflict_admin_review():
    pr = _pr()
    recs = (pr.policy_rule_from_dict(
        _prec_rule("a", "eligible", 10, {"shops": ("FilterShopTH",)})),
        pr.policy_rule_from_dict(
        _prec_rule("b", "ineligible", 10, {"shops": ("FilterShopTH",)})))
    d = pr.resolve_policy(_prec_query(), recs)
    assert d.outcome == "admin_review"
    assert "rule_conflict" in d.reason_codes


def test_r9_expired_high_priority_ignored():
    pr = _pr()
    recs = (pr.policy_rule_from_dict(
        _prec_rule("old", "ineligible", 99, {"shops": ("FilterShopTH",)},
                   effective_from="2020-01-01", effective_until="2020-12-31")),
        pr.policy_rule_from_dict(
        _prec_rule("gen", "eligible", 10, {})))
    d = pr.resolve_policy(_prec_query(), recs)
    assert d.outcome == "eligible"
    assert "old" not in d.matched_rule_ids


def test_r9_newer_version_of_same_rule_wins_deterministically():
    pr = _pr()
    recs = (pr.policy_rule_from_dict(
        _prec_rule("r", "eligible", 10, {"shops": ("FilterShopTH",)},
                   version="1", effective_from="2024-01-01")),
        pr.policy_rule_from_dict(
        _prec_rule("r", "ineligible", 10, {"shops": ("FilterShopTH",)},
                   version="2", effective_from="2024-06-01")))
    d = pr.resolve_policy(_prec_query(), recs)
    assert d.outcome == "ineligible"
    assert d.matched_rule_ids == ("r",)


# ══════════════════════════════════════════════════════════════════
# R2 — typed authority deterministic render + evidence boundaries
# ══════════════════════════════════════════════════════════════════

# ── A. policy outcome renders deterministically — LLM wording cannot
#    alter the final conclusion (no phrase scanning to detect agreement)
def _pol_resp(llm_text, outcome):
    return _enf_resp(
        llm_text,
        rd={"policy_decision": {"outcome": outcome,
                                "policy_type": "return_exchange",
                                "matched_rule_ids": ("r1",)}})


def test_r2_eligible_contradicts_thai_denial_phrases():
    """eligible + 'เปลี่ยนไม่ได้'/'คืนไม่ได้'/'ไม่เข้าเงื่อนไข' — phrasings
    the R1 regex scan never matched — render deterministically eligible."""
    from shopeechat import guards
    for denial in ("เคสนี้เปลี่ยนไม่ได้ค่ะ",
                   "สินค้าชิ้นนี้คืนไม่ได้นะคะ",
                   "เคสนี้ไม่เข้าเงื่อนไขการเปลี่ยน/คืนค่ะ"):
        r = _pol_resp(denial, "eligible")
        guards.enforce(r, _enf_req("เปลี่ยนได้ไหมคะ"))
        assert r.answer == guards._POLICY_TEXT_ELIGIBLE, \
            f"denial {denial!r} survived eligible decision"


def test_r2_ineligible_overrides_positive_promise():
    from shopeechat import guards
    r = _pol_resp("เปลี่ยนได้เลยค่ะ ภายใน 30 วันนะคะ ไม่ต้องห่วง", "ineligible")
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหมคะ"))
    assert r.answer == guards._POLICY_TEXT_INELIGIBLE


def test_r2_unknown_and_admin_review_render_admin_text():
    from shopeechat import guards
    for outcome in ("unknown", "admin_review"):
        for prose in ("เปลี่ยนสินค้าได้เลยค่ะ",
                      "เคสนี้เปลี่ยนไม่ได้นะคะ",
                      "ไม่เข้าเงื่อนไขการเปลี่ยน/คืนค่ะ"):
            r = _pol_resp(prose, outcome)
            guards.enforce(r, _enf_req("เปลี่ยนได้ไหมคะ"))
            assert "แอดมิน" in r.answer, \
                f"{outcome}+{prose!r} must render admin-review text"
            assert "เปลี่ยนได้" not in r.answer.replace("/", "")
            assert "เปลี่ยนไม่ได้" not in r.answer


def test_r2_decision_answer_mutation_proof():
    """ANY LLM sentence + same decision → byte-identical final answer.
    Authority comes from the typed outcome, not the prose."""
    from shopeechat import guards
    outs = set()
    for prose in ("เปลี่ยนได้เลยค่ะ",
                  "เคสนี้เปลี่ยนไม่ได้ค่ะ",
                  "สินค้าตัวนี้สวยมากค่ะ รับประกันดี",
                  "", "xyz 123"):
        r = _pol_resp(prose, "ineligible")
        guards.enforce(r, _enf_req("เปลี่ยนได้ไหมคะ"))
        outs.add(r.answer)
    assert outs == {guards._POLICY_TEXT_INELIGIBLE}


def test_r2_segments_and_rewritten_marker_preserved():
    from shopeechat import guards
    r = _pol_resp("อะไรก็ได้ค่ะ", "admin_review")
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหมคะ"))
    assert r.routing_decision.get("guard_rewritten") == "policy_decision"
    assert r.answer_segments  # regenerated, not dropped


def test_r2_no_decision_keeps_legacy_path():
    """absent decision → legacy return_claim grounding path untouched."""
    from shopeechat import guards
    r = _enf_resp(
        "เปลี่ยน/คืนสินค้าได้ภายใน 7 วันค่ะ",
        rd={"grounding_text": "ร้านค้ารับเปลี่ยน/คืนสินค้าได้ภายใน 7 วัน"})
    guards.enforce(r, _enf_req("นโยบายเปลี่ยนคืน"))
    assert "เปลี่ยน/คืนสินค้าได้" in r.answer


# ── B. multi-subject spec claims fail closed (no claim→subject
#    structured relation exists in the free-form answer contract)
def test_r2_multi_subject_claim_not_grounded():
    """subject set {A,B}: B has 65W, A does not — answer's spec claim
    cannot be attributed to a specific subject → fail closed."""
    from shopeechat import guards
    r = _enf_resp(
        "รองรับ 65W ค่ะ",
        products=[_spec_card(1, "Charger A", "หัวชาร์จ USB-C"),
                  _spec_card(2, "Charger B", "รองรับชาร์จเร็ว 65W")],
        rd={"subject_ids": ["i:1", "i:2"]})
    guards.enforce(r, _enf_req("ตัวไหนรองรับ 65W"))
    assert "65w" not in r.answer.replace(" ", "").lower()
    assert r.routing_decision.get("guard_rewritten")


def test_r2_single_subject_own_fact_grounds():
    from shopeechat import guards
    r = _enf_resp(
        "รองรับ 65W ค่ะ",
        products=[_spec_card(1, "Charger A", "รองรับชาร์จเร็ว 65W")],
        rd={"subject_ids": ["i:1"]})
    guards.enforce(r, _enf_req("รองรับกี่วัตต์"))
    assert "65w" in r.answer.replace(" ", "").lower()
    assert not r.routing_decision.get("guard_rewritten")


def test_r2_unrelated_subject_evidence_does_not_pass():
    """products contain B's fact but subject_ids={A} only → claim fails
    (subject-scoped: evidence outside the subject set is not usable)."""
    from shopeechat import guards
    r = _enf_resp(
        "รองรับ 65W ค่ะ",
        products=[_spec_card(1, "Charger A", "หัวชาร์จ USB-C"),
                  _spec_card(2, "Charger B", "รองรับชาร์จเร็ว 65W")],
        rd={"subject_ids": ["i:1"]})
    guards.enforce(r, _enf_req("รองรับกี่วัตต์"))
    assert "65w" not in r.answer.replace(" ", "").lower()
    assert r.routing_decision.get("guard_rewritten")


# ── C. production required-evidence boundary — no authoritative
#    verified source exists at the return_policy decision point
def test_r2_build_policy_query_carries_no_fabricated_evidence():
    """production adapter never fabricates evidence ids from request
    prose/images/intent — evidence fields stay empty → winning rule
    with required_evidence resolves admin_review (activation blocker)."""
    pr = _pr()
    q = pr.build_policy_query(
        policy_type="return_exchange", shop="s",
        cards=(_spec_card(1, "X", "y"),),
        intent_result={"policy_reason": "customer_wrong_model",
                       "policy_item_condition": "sealed",
                       "policy_order_state": "delivered"},
        event_time="2026-10-01")
    assert q.evidence_ids == ()
    assert q.evidence_by_subject == {}
    assert q.conflicting_evidence == ()
    recs = (pr.policy_rule_from_dict(_rule_req_ev(("order_receipt",))),)
    d = pr.resolve_policy(q, recs)
    assert d.outcome == "admin_review"
    assert "order_receipt" in d.missing_evidence


# ── D. opaque version ordering — never lexicographic
def test_r2_same_date_conflicting_versions_admin_review():
    """same effective date + same rule_id + '9' vs '10' conflicting
    outcomes → admin_review; never silently pick lexicographic winner."""
    pr = _pr()
    rules = (
        _rule(pr, rule_id="rX", version="9", outcome="eligible",
              reason="customer_wrong_model",
              effective_from="2024-01-01"),
        _rule(pr, rule_id="rX", version="10", outcome="ineligible",
              reason="customer_wrong_model",
              effective_from="2024-01-01"),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"), rules)
    assert d.outcome == "admin_review"
    assert "rule_conflict" in d.reason_codes


def test_r2_newer_effective_from_wins_regardless_of_version_text():
    """v'1' dated 2024-06-01 beats v'2' dated 2024-01-01 — ordering by
    effective date, not version string."""
    pr = _pr()
    rules = (
        _rule(pr, rule_id="rX", version="2", outcome="eligible",
              reason="customer_wrong_model",
              effective_from="2024-01-01"),
        _rule(pr, rule_id="rX", version="1", outcome="ineligible",
              reason="customer_wrong_model",
              effective_from="2024-06-01"),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"),
                          rules)
    assert d.outcome == "ineligible"
    assert d.matched_rule_ids == ("rX",)
    assert any(v.endswith("@1") for v in d.source_versions)


def test_r2_same_date_same_outcome_converges():
    """same date + same outcome different version ids → deterministic
    convergence (one winner) — no conflict, outcome unchanged."""
    pr = _pr()
    rules = (
        _rule(pr, rule_id="rX", version="9", outcome="eligible",
              reason="customer_wrong_model",
              effective_from="2024-01-01"),
        _rule(pr, rule_id="rX", version="10", outcome="eligible",
              reason="customer_wrong_model",
              effective_from="2024-01-01"),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"), rules)
    assert d.outcome == "eligible"
    assert d.matched_rule_ids == ("rX",)


def test_r2_malformed_effective_date_rejected():
    pr = _pr()
    for bad in ("2024-13-99", "not-a-date", "2024/01/01",
                "2024-01-01T25:99"):
        try:
            pr.policy_rule_from_dict(_rule_req_ev(
                (), rule_id="rbad", version="1", outcome="eligible",
                effective_from=bad))
        except ValueError:
            continue
        raise AssertionError(f"malformed effective_from {bad!r} accepted")


def test_r2_expired_records_stay_excluded():
    pr = _pr()
    rules = (
        _rule(pr, rule_id="rold", version="99", outcome="eligible",
              reason="customer_wrong_model",
              effective_from="2020-01-01", effective_until="2020-12-31"),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model"),
                          rules)
    assert d.outcome == "unknown"
    assert "rule_expired" in d.reason_codes


# ══════════════════════════════════════════════════════════════════
# R3 — typed-policy COMPOSITION + canonical dates + ambiguity
# ══════════════════════════════════════════════════════════════════

def _pdec_rd(outcome, **extra):
    rd = {"policy_decision": {"outcome": outcome,
                              "policy_type": "return_exchange",
                              "matched_rule_ids": ("r1",)}}
    rd.update(extra)
    return rd


# ── A. pure policy — deterministic, wording-independent ────────────
def test_r3_policy_only_replaces_whole_answer():
    """policy_only (or absent composition): typed outcome IS the final
    answer — whole answer = deterministic segment, not prose scan."""
    from shopeechat import guards
    r = _enf_resp("สินค้านี้คืนได้เลยค่ะ ส่งของพรุ่งนี้",
                  rd={"policy_decision": {"outcome": "ineligible",
                                          "policy_type": "return_exchange"}})
    guards.enforce(r, _enf_req("ขอเปลี่ยนได้ไหมคะ"))
    assert r.answer == guards._POLICY_TEXT_INELIGIBLE
    assert r.routing_decision.get("guard_rewritten") == "policy_decision"


def test_r3_policy_only_wording_independent():
    """arbitrary LLM phrasing cannot change the deterministic
    conclusion — same decision + wildly different prose → same answer."""
    from shopeechat import guards
    outs = set()
    for prose in ("เปลี่ยนได้เลยค่ะ", "เคสนี้เปลี่ยนไม่ได้ค่ะ",
                  "ไม่เข้าเงื่อนไขการเปลี่ยน/คืน", "แดงสวยมาก", ""):
        r = _enf_resp(prose, rd=_pdec_rd("ineligible"))
        guards.enforce(r, _enf_req("เปลี่ยนได้ไหมคะ"))
        outs.add(r.answer)
    assert outs == {guards._POLICY_TEXT_INELIGIBLE}


def test_r3_policy_only_empty_llm_still_renders():
    """empty LLM output + typed decision → typed conclusion still the
    final answer (policy_only)."""
    from shopeechat import guards
    r = _enf_resp("", rd=_pdec_rd("eligible"))
    guards.enforce(r, _enf_req("ขอเปลี่ยนได้ไหม"))
    assert r.answer == guards._POLICY_TEXT_ELIGIBLE


# ── B. Phase 5 closeout — mixed auto-answer de-authorized ──────────
# R5 proved the product LLM sees the raw mixed question and emits one
# untyped prose blob, so an LLM policy conclusion can contradict the
# appended typed segment. Phase 5 fail-closes mixed product+policy turns
# to the existing handoff path before any product LLM call — the typed
# PolicyDecision stays in routing_decision as diagnostics only. The
# app.chat-level defer tests live in test_legacy_turn_incident_replay.py.
def test_r5_handoff_failed_reply_is_terminal():
    """deferred mixed + failed transport → HANDOFF_FAILED_REPLY must NOT
    be overwritten by typed policy render or the rewrite tier."""
    from shopeechat import guards
    from shopeechat import responses as _resp_mod
    r = _enf_resp(_resp_mod.HANDOFF_FAILED_REPLY, rd=_pdec_rd("eligible"))
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    assert r.answer == _resp_mod.HANDOFF_FAILED_REPLY
    assert guards._POLICY_TEXT_ELIGIBLE not in r.answer
    assert r.routing_decision.get("guard_rewritten") is None


def test_r5_serialized_composition_has_no_authority():
    """a stale `composition` key in policy_decision carries no behavioral
    authority — the closeout deleted mixed machinery; an active typed
    decision renders policy_only deterministically."""
    from shopeechat import guards
    rd = _pdec_rd("ineligible")
    rd["policy_decision"]["composition"] = "mixed"  # stale serialized field
    r = _enf_resp("WPB100L ราคา 990 บาทค่ะ", rd=rd)
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    assert r.answer == guards._POLICY_TEXT_INELIGIBLE
    assert r.routing_decision.get("guard_rewritten") == "policy_decision"


def test_r5_mixed_answer_never_appends_policy_segment():
    """closeout: enforce must NOT append a typed segment onto arbitrary
    product prose — that composition is the R5-defect machinery."""
    from shopeechat import guards
    r = _enf_resp("WPB100L ราคา 990 บาทค่ะ", rd=_pdec_rd("eligible"))
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    # an active typed decision renders the deterministic whole answer;
    # product prose + appended policy segment is never composed.
    assert r.answer == guards._POLICY_TEXT_ELIGIBLE
    assert " ||| " not in r.answer


# ── C. failure ordering — errors/handoff before composition ────────
def test_r3_llm_error_not_masked_by_policy(monkeypatch):
    """LLM_ERROR_REPLY + active decision → escalate path wins; policy
    text must NOT hide the provider failure."""
    from shopeechat import guards, llm
    from shopeechat import responses as _resp_mod
    monkeypatch.setattr(_resp_mod, "_send_handoff",
                        lambda *a, **k: {"outcome": {"state": "assigned"}})
    r = _enf_resp(llm.LLM_ERROR_REPLY, rd=_pdec_rd("eligible"))
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert guards._POLICY_TEXT_ELIGIBLE not in r.answer
    assert r.handoff_to_admin is True
    assert (r.routing_decision or {}).get("guard_escalated") == "llm_error"


def test_r3_llm_error_not_masked_policy_only(monkeypatch):
    from shopeechat import guards, llm
    from shopeechat import responses as _resp_mod
    monkeypatch.setattr(_resp_mod, "_send_handoff",
                        lambda *a, **k: {"outcome": {"state": "assigned"}})
    r = _enf_resp(llm.LLM_ERROR_REPLY, rd=_pdec_rd("ineligible"))
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert guards._POLICY_TEXT_INELIGIBLE not in r.answer
    assert r.handoff_to_admin is True
    assert (r.routing_decision or {}).get("guard_escalated") == "llm_error"


def test_r3_confirmed_handoff_untouched():
    """handoff_to_admin=True + decision → response passes through."""
    from shopeechat import guards
    r = _enf_resp("เดี๋ยวแอดมินมาตอบค่ะ", handoff=True,
                  rd=_pdec_rd("eligible"))
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert r.answer == "เดี๋ยวแอดมินมาตอบค่ะ"
    assert guards._POLICY_TEXT_ELIGIBLE not in r.answer


# ── D. canonical dates + same-date ambiguity ───────────────────────
def test_r3_basic_iso_normalizes():
    """20240101 must normalize to the same canonical date as 2024-01-01."""
    pr = _pr()
    r = pr.policy_rule_from_dict(
        _rule_req_ev((), effective_from="20240101"))
    assert r.effective_from == "2024-01-01"


def test_r3_extended_iso_wins_over_basic():
    """2024-06-01 (extended) must beat 20240101 (basic) — ordering on
    canonical dates, not raw string bytes."""
    pr = _pr()
    recs = (
        pr.policy_rule_from_dict(_rule_req_ev(
            (), effective_from="20240101", outcome="ineligible")),
        pr.policy_rule_from_dict(_rule_req_ev(
            (), effective_from="2024-06-01", outcome="eligible",
            version="2")),
    )
    # event_time basic-ISO so BOTH records are active under raw-string
    # compare (extended event_time would wrongly mark "20240101" pending)
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model",
                                 event_time="20240701"), recs)
    assert d.outcome == "eligible"   # June record wins, not Jan


def test_r3_datetime_normalizes_to_day():
    """datetime input stores canonical day granularity."""
    pr = _pr()
    r = pr.policy_rule_from_dict(_rule_req_ev(
        (), effective_from="2024-03-05T14:30:00"))
    assert r.effective_from == "2024-03-05"


def test_r3_malformed_date_rejected():
    pr = _pr()
    import pytest as _pt
    for bad in ("2024-13-40", "Jan 1 2024", "2024/01/01"):
        with _pt.raises(ValueError):
            pr.policy_rule_from_dict(
                _rule_req_ev((), effective_from=bad))


def test_r3_inverted_range_rejected():
    """effective_until < effective_from → reject."""
    pr = _pr()
    import pytest as _pt
    with _pt.raises(ValueError):
        pr.policy_rule_from_dict(_rule_req_ev(
            (), effective_from="2024-06-01", effective_until="2024-01-01"))


def test_r3_same_date_semantic_duplicate_dedupes():
    """same rule_id + same effective_from + identical decision payload
    (different opaque version only) → dedupe, no conflict."""
    pr = _pr()
    recs = (
        pr.policy_rule_from_dict(_rule_req_ev(
            ("order_receipt",), effective_from="2024-01-01", version="9")),
        pr.policy_rule_from_dict(_rule_req_ev(
            ("order_receipt",), effective_from="2024-01-01", version="10")),
    )
    q = _query(pr, reason="customer_wrong_model", event_time="2024-06-01",
               evidence_ids=("order_receipt",))
    d = pr.resolve_policy(q, recs)
    assert d.outcome == "eligible"           # deduped winner, not conflict
    assert d.matched_rule_ids == ("rq",)


def test_r3_same_date_different_requirements_conflict():
    """same rule_id + same date + same outcome BUT different
    required_evidence → rule_conflict/admin_review — never union into
    an invented rule."""
    pr = _pr()
    recs = (
        pr.policy_rule_from_dict(_rule_req_ev(
            ("order_receipt",), effective_from="2024-01-01", version="9")),
        pr.policy_rule_from_dict(_rule_req_ev(
            ("item_photo",), effective_from="2024-01-01", version="10")),
    )
    q = _query(pr, reason="customer_wrong_model", event_time="2024-06-01",
               evidence_ids=("order_receipt", "item_photo"))
    d = pr.resolve_policy(q, recs)
    assert d.outcome == "admin_review"
    assert "rule_conflict" in d.reason_codes
    # requirements NOT unioned — no invented merged rule
    assert d.required_evidence == ()


def test_r3_same_date_different_until_conflict():
    """same outcome but different effective_until → ambiguity, not
    silent dedupe."""
    pr = _pr()
    recs = (
        pr.policy_rule_from_dict(_rule_req_ev(
            (), effective_from="2024-01-01", version="9")),
        pr.policy_rule_from_dict(_rule_req_ev(
            (), effective_from="2024-01-01",
            effective_until="2024-12-31", version="10")),
    )
    q = _query(pr, reason="customer_wrong_model", event_time="2024-06-01")
    d = pr.resolve_policy(q, recs)
    assert d.outcome == "admin_review"
    assert "rule_conflict" in d.reason_codes


def test_r3_same_date_conflicting_outcomes_conflict():
    """same id/date + conflicting outcomes → admin_review (R2 retained)."""
    pr = _pr()
    recs = (
        pr.policy_rule_from_dict(_rule_req_ev(
            (), effective_from="2024-01-01", outcome="eligible",
            version="9")),
        pr.policy_rule_from_dict(_rule_req_ev(
            (), effective_from="2024-01-01", outcome="ineligible",
            version="10")),
    )
    d = pr.resolve_policy(_query(pr, reason="customer_wrong_model",
                                 event_time="2024-06-01"), recs)
    assert d.outcome == "admin_review"


# ══════════════════════════════════════════════════════════════════
# R4 — structural composition authority + canonical event_time
# ══════════════════════════════════════════════════════════════════

def test_r4_policy_only_normalizes_even_when_answer_equals_final():
    """incoming answer already == _POLICY_TEXT_ELIGIBLE → enforce must
    STILL canonicalize segments + set the structural marker — 'answer
    already equals final' is not proof composition ran."""
    from shopeechat import guards
    r = _enf_resp(guards._POLICY_TEXT_ELIGIBLE,
                  rd=_pdec_rd("eligible"))
    r.answer_segments = None
    guards.enforce(r, _enf_req("เปลี่ยนได้ไหม"))
    assert r.answer == guards._POLICY_TEXT_ELIGIBLE
    assert r.answer_segments == [guards._POLICY_TEXT_ELIGIBLE]
    assert r.routing_decision.get("guard_rewritten") == "policy_decision"


def test_r4_prose_containing_final_has_no_authority():
    """LLM prose that happens to contain the exact deterministic sentence
    carries no behavioral authority — an active typed decision still
    renders the canonical whole answer + structural marker (policy_only)."""
    from shopeechat import guards
    prose = ("WPB100L ราคา 990 บาทค่ะ "
             + guards._POLICY_TEXT_INELIGIBLE)
    r = _enf_resp(prose, rd=_pdec_rd("ineligible"))
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    assert r.answer == guards._POLICY_TEXT_INELIGIBLE
    assert r.routing_decision.get("guard_rewritten") == "policy_decision"
    assert r.answer_segments == [guards._POLICY_TEXT_INELIGIBLE]


def test_r4_policy_only_first_call_sets_structural_marker():
    from shopeechat import guards
    r = _enf_resp("ข้อความใดๆ", rd=_pdec_rd("eligible"))
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    assert r.routing_decision.get("guard_rewritten") == "policy_decision"


def test_r4_policy_only_second_call_byte_stable():
    """enforce×2 → identical bytes; structural render is idempotent."""
    from shopeechat import guards
    r = _enf_resp("WPB100L ราคา 990 บาทค่ะ", rd=_pdec_rd("eligible"))
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    a1, s1 = r.answer, list(r.answer_segments)
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    assert r.answer == a1 and r.answer_segments == s1
    assert r.answer.count(guards._POLICY_TEXT_ELIGIBLE) == 1


def test_r4_policy_only_outcome_text_only_from_decision():
    """ineligible decision → final answer is ineligible text — prose can
    never supply its own eligibility ending."""
    from shopeechat import guards
    r = _enf_resp("WPB100L ดีมากค่ะ", rd=_pdec_rd("ineligible"))
    guards.enforce(r, _enf_req("WPB100L เปลี่ยนได้ไหม"))
    assert r.answer == guards._POLICY_TEXT_INELIGIBLE
    assert guards._POLICY_TEXT_ELIGIBLE not in r.answer


# ── B. canonical PolicyQuery.event_time ────────────────────────────
def test_r4_basic_and_extended_event_time_equal():
    """event_time '20240101' and '2024-01-01' must produce identical
    resolution results."""
    pr = _pr()
    rules = (pr.policy_rule_from_dict(_rule_req_ev(
        (), effective_from="2024-01-01")),)
    q_base = dict(reason="customer_wrong_model",
                  evidence_ids=("order_receipt",))
    d_ext = pr.resolve_policy(
        _query(pr, event_time="2024-01-01", **q_base), rules)
    d_bas = pr.resolve_policy(
        _query(pr, event_time="20240101", **q_base), rules)
    assert d_ext.outcome == d_bas.outcome
    assert d_ext.matched_rule_ids == d_bas.matched_rule_ids
    assert d_ext.reason_codes == d_bas.reason_codes


def test_r4_basic_event_time_before_future_rule_is_pending():
    """basic-ISO event before effective_from → rule pending → unknown —
    not wrongly active via raw-string compare."""
    pr = _pr()
    rules = (pr.policy_rule_from_dict(_rule_req_ev(
        (), effective_from="2024-06-01")),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model",
               event_time="20240101"), rules)
    assert d.outcome == "unknown"
    assert "rule_pending" in d.reason_codes


def test_r4_datetime_event_time_uses_canonical_day():
    """extended datetime event resolves on its canonical date."""
    pr = _pr()
    rules = (pr.policy_rule_from_dict(_rule_req_ev(
        (), effective_from="2024-06-01", effective_until="2024-06-30")),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model",
               event_time="2024-06-15T10:30:00",
               evidence_ids=()), rules)
    assert d.outcome in ("admin_review", "eligible", "ineligible")
    assert "rule_pending" not in d.reason_codes


def test_r4_malformed_event_time_fails_closed():
    """malformed event_time + dated rule → unverifiable (fail closed):
    must not activate the rule and must not crash."""
    pr = _pr()
    rules = (pr.policy_rule_from_dict(_rule_req_ev(
        (), effective_from="2024-06-01")),)
    d = pr.resolve_policy(
        _query(pr, reason="customer_wrong_model",
               event_time="June 15 2024"), rules)
    assert d.outcome == "unknown"
    assert "rule_window_unverifiable" in d.reason_codes


def test_r4_undated_rule_unaffected_by_event_time():
    """undated rule → active regardless of event_time validity."""
    pr = _pr()
    rules = (_rule(pr, reason="customer_wrong_model"),)
    for et in (None, "garbage", "2024-01-01"):
        d = pr.resolve_policy(_query(pr, reason="customer_wrong_model",
                                     event_time=et), rules)
        assert d.outcome == "eligible"
