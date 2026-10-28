"""test_phase6_need_selection.py — Phase 6: one selector + structured per-need coverage.

pin: TurnNeed เป็น selector contract (product_types/subtypes/ranking บน need) ·
intent product_type ใน subtype domain normalize เป็น charger_subtype ·
reversed-order `ที่ใช้กับ` relation parse · selector per-need attribution +
identity dedupe + role truth table (subject / relation_target / alternative /
historical_evidence / slot; hidden_mention = rejected-only) · per-need
scope ไม่ inherit กัน · selector เรียกครั้งเดียวต่อ turn
"""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402
from shopeechat import turn_decision  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult  # noqa: E402
from shopeechat.retrieval_planner import (  # noqa: E402
    RetrievalRequest, build_grouped_retrieval_requests)
from shopeechat.retrieval_executor import (  # noqa: E402
    RetrievalExecutionResult, SourceAttempt,
    execute_grouped_retrieval_requests)
from shopeechat.candidate_pool import build_candidate_pool  # noqa: E402
from shopeechat.retrieval_selection import (  # noqa: E402
    select_for_llm_context)
from shopeechat.retrieval_policy import make_evidence_card  # noqa: E402
from shopeechat import retrieval_runtime  # noqa: E402

AD1404T_MSG = ("อยากได้สายที่ใช้กับ AD1404T แบบมีจอ ยาว 2 เมตร เต็มสปีด")
AD1404T_INTENT = {"intent": "recommendation", "confidence": 0.85,
                  "product_type": "cable"}


def _decide(msg, intent=None, **kw):
    return turn_decision.decide_turn(msg, intent_result=intent or {}, **kw)


def _stamped(avail=True, **kw):
    return {"status": "NORMAL", "total_stock": 5 if avail else 0,
            "catalog_status": "active" if avail else "out_of_stock",
            "customer_visible": True, "_available_for_sale": avail,
            "availability_reason": ("normal_positive_stock" if avail
                                    else "normal_zero_stock"), **kw}


def _adapter(name="CUKTECH AD1404T หัวชาร์จ 140W", **kw):
    c = {"name": name, "product_type": "charger", "charger_subtype": "adapter",
         "item_id": "a1", "unit_id": "ua1", "model_codes": ["AD1404T"],
         **_stamped(kw.pop("_available_for_sale", True))}
    c.update(kw)
    return c


def _cable(name, unit_id, **kw):
    c = {"name": name, "product_type": "cable", "cable_subtype": "cable",
         "item_id": unit_id, "unit_id": unit_id,
         **_stamped(kw.pop("_available_for_sale", True))}
    c.update(kw)
    return c


def _need(kind="product", operation="describe", **kw):
    return turn_decision.TurnNeed(kind=kind, operation=operation, **kw)


def _pool_for(msg, intent=None, adapter_cards=(), cable_cards=()):
    prof = route_context.build_retrieval_profile(
        msg, history=[], intent_result=intent or {}, shop="KingGadgets")
    slots = route_context.build_retrieval_slots(prof)
    needs = turn_decision.decide_turn(
        msg, history=[], intent_result=intent or {}).needs
    rels = route_context.build_retrieval_relations(
        prof, slots, allow_reversed=any(
            n.kind in ("product", "compare", "compat") for n in needs))
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    def units_fetcher(message, **kw):
        docs = tuple(adapter_cards) + tuple(cable_cards)
        return UnitEvidenceFetchResult(
            cards=docs, raw_count=len(docs),
            sellable_count=sum(1 for c in docs if c.get("_available_for_sale")),
            unavailable_count=0, trace=("u",))

    results = execute_grouped_retrieval_requests(
        reqs, message=msg, shop="KingGadgets",
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [],
        snap=None)
    return build_candidate_pool(results, profile=prof), reqs, prof


def _two_request_pool():
    """cable card eligible ใต้ slot request + relation request เดียวกัน"""
    slot_req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"charger"}), frozenset({"cable"}),
        ("AD1404T",), None, "sellable_first", "none")
    rel_req = RetrievalRequest(
        "req-1", "slot-charger", "relation_target",
        frozenset({"charger"}), frozenset({"cable"}),
        (), None, "sellable_first", "none",
        relation_id="rel-0",
        soft_hints=(("display", "required"),))
    cable = make_evidence_card(
        _cable("CUKTECH CTC620P สายชาร์จมีจอ 240W", "u-c",
               variants=[{"name": "CTC620P 2 เมตร"}]),
        source="units")
    adapter = make_evidence_card(_adapter(), source="units")
    res0 = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=frozenset({"cable"}), model_codes=("AD1404T",),
        eligible_candidates=(adapter, cable),
        source_attempts=(SourceAttempt("units", 2, 2, 0, 0, ("t",)),))
    res1 = RetrievalExecutionResult(
        request_id="req-1", source="relation_target",
        slot_id="slot-charger",
        subtypes=frozenset({"cable"}), model_codes=(),
        eligible_candidates=(cable,),
        source_attempts=(SourceAttempt("units", 1, 1, 0, 0, ("t",)),))
    return build_candidate_pool((res0, res1)), (slot_req, rel_req)


# ── A. TurnNeed structured scope ──────────────────────────────


def test_compat_need_scope_empty_relation_owned_downstream():
    # compat need ไม่มี honest per-need scope ใน decide_turn — relation
    # scope อยู่ที่ RetrievalRequest/relations downstream (owner แยก)
    plan = _decide("สายชาร์จใช้กับ iphone 15 ไหม",
                   intent={"intent": "compatibility_check", "confidence": 0.9,
                           "target_device": "iphone 15"})
    comp = next((n for n in plan.needs if n.kind == "compat"), None)
    assert comp is not None
    assert not comp.product_types and not comp.subtypes, (
        f"compat need scope ต้องว่าง — scope เป็นของ request layer — "
        f"{comp.product_types} {comp.subtypes}")
    assert comp.ranking == ("output_power_w", "max")


def test_intent_subtype_domain_maps_to_need_subtypes():
    plan = _decide(AD1404T_MSG, intent=AD1404T_INTENT)
    prodish = [n for n in plan.needs
               if n.kind in ("product", "compare", "compat")]
    assert prodish, "AD1404T turn ต้องมี productish need"
    assert any("cable" in n.subtypes for n in prodish), (
        f"intent product_type='cable' (subtype domain) ต้องกลายเป็น "
        f"subtype บน need — got {[(n.kind, n.subtypes) for n in prodish]}")
    assert all("cable" not in n.product_types for n in prodish), (
        "subtype-domain value ห้ามปนเป็น product_type บน need")


def test_multi_need_product_and_policy():
    plan = _decide("AC65B ราคาเท่าไหร่ รับประกันกี่ปี",
                   intent={"intent": "product_question", "confidence": 0.9})
    kinds = {(n.kind, n.operation) for n in plan.needs}
    assert ("product", "price") in kinds
    assert ("policy", "policy") in kinds
    prod = next(n for n in plan.needs if n.kind == "product")
    assert "AC65B" in prod.subject_refs
    assert not prod.product_types and not prod.subtypes, (
        "intent ไม่มี product_type → product need scope ว่าง "
        "(ห้าม stamp turn-wide route scope)")
    pol = next(n for n in plan.needs if n.kind == "policy")
    assert not pol.product_types and not pol.subtypes, (
        "non-productish need ไม่ควรแบก product scope")


def test_recommend_current_set_scope_case():
    plan = _decide("iphone แนะนำอันไหน 2 อันนี้",
                   intent={"intent": "product_recommend", "confidence": 0.9,
                           "subject_scope": "current_set",
                           "subject_count": 2})
    rec = next((n for n in plan.needs
                if n.kind == "product" and n.operation == "recommend"), None)
    assert rec is not None
    assert rec.subject_scope == "current_set"
    assert rec.subject_count == 2


def test_invalid_subject_scope_normalizes_none():
    plan = _decide("AC65B มีไหม",
                   intent={"intent": "product_question", "confidence": 0.9,
                           "subject_scope": "bogus_enum"})
    for n in plan.needs:
        assert n.subject_scope == "none"


def test_superlative_ranking_on_need():
    plan = _decide("มีหัวชาร์จตัวไหนชาร์จไวสุดไหม",
                   intent={"intent": "product_question", "confidence": 0.9})
    prodish = [n for n in plan.needs
               if n.kind in ("product", "compare", "compat")]
    assert any(n.ranking == ("output_power_w", "max") for n in prodish), (
        f"superlative watt ask ต้องมี ranking — "
        f"{[(n.kind, n.ranking) for n in prodish]}")


def test_weight_ranking_on_need():
    plan = _decide("มีตัวไหนเบาสุดบ้าง",
                   intent={"intent": "product_question", "confidence": 0.9})
    prodish = [n for n in plan.needs
               if n.kind in ("product", "compare", "compat")]
    assert any(n.ranking == ("package_weight", "min") for n in prodish), (
        f"weight superlative ต้องเป็น (package_weight,min) — "
        f"{[(n.kind, n.ranking) for n in prodish]}")


def test_charger_compat_intent_gets_wattage_ranking():
    plan = _decide("หัวชาร์จใช้กับ iphone 15",
                   intent={"intent": "compatibility_check", "confidence": 0.9,
                           "product_type": "charger",
                           "target_device": "iphone 15"})
    comp = next((n for n in plan.needs if n.kind == "compat"), None)
    assert comp is not None
    assert comp.ranking == ("output_power_w", "max")


def test_mixed_scope_needs_bidirectional_isolation():
    # compat ask + product ask — scope ต้องแยกตาม structured evidence ของ
    # producer เท่านั้น (ทั้งสองทิศ): product = intent product scope;
    # compat = เฉพาะ structured relation scope ของมัน (ไม่มี → ว่าง)
    plan = _decide(
        "พาวเวอร์แบงค์แนะนำหน่อย แล้วสายที่ใช้กับ AD1404T มีไหม",
        intent={"intent": "product_recommend", "confidence": 0.85,
                "product_type": "powerbank"})
    comp = next((n for n in plan.needs if n.kind == "compat"), None)
    prod = next((n for n in plan.needs if n.kind == "product"), None)
    assert comp is not None and prod is not None, (
        f"ต้องมี compat+product needs — got {[(n.kind, n.operation) for n in plan.needs]}")
    # product direction — powerbank เป็นของ recommend ask
    assert "powerbank" in prod.product_types, (
        f"product need ต้องครอบ powerbank ask — {prod.product_types}")
    assert "charger" not in prod.product_types, (
        f"product need ห้าม inherit charger scope ของ compat ask — "
        f"{prod.product_types}")
    assert "cable" not in (prod.product_types | prod.subtypes), (
        f"product need ห้าม inherit cable scope ของ compat ask — "
        f"{prod.product_types} {prod.subtypes}")
    # compat direction — เฉพาะ structured scope ของมัน (อาจว่าง) ไม่ใช่
    # powerbank ของ product ask
    assert comp.product_types <= {"charger", "cable", "adapter"}, (
        f"compat scope ต้องอยู่ใน relation domain เท่านั้น — {comp.product_types}")
    assert comp.subtypes <= {"cable", "adapter"}, (
        f"compat subtype scope ต้องอยู่ใน relation domain เท่านั้น — {comp.subtypes}")
    assert "powerbank" not in (comp.product_types | comp.subtypes), (
        f"compat need ห้าม inherit type/subtype ของ product ask — "
        f"{comp.product_types} {comp.subtypes}")
    # ranking direction — compat-parity wattage ของ compat need เท่านั้น
    assert comp.ranking == ("output_power_w", "max"), (
        f"compat need (relation ask ใน charging family) ต้องมี wattage "
        f"ranking — {comp.ranking}")
    assert prod.ranking is None, (
        f"product need ห้าม inherit compatibility ranking — {prod.ranking}")
    # subject_scope/count ผูกกับ product need เท่านั้น (contract เดิม)
    assert comp.subject_scope == "none" and comp.subject_count is None


# ── B. route_context normalization + reversed relation ───────


def test_profile_subtype_domain_normalization():
    prof = route_context.build_retrieval_profile(
        AD1404T_MSG, history=[], intent_result=AD1404T_INTENT,
        shop="KingGadgets")
    assert prof.subtype == "cable", (
        f"intent product_type='cable' ต้อง normalize เป็น subtype — "
        f"got {prof.subtype!r}")
    assert "charger" in prof.product_types


def test_reversed_relation_target_before_connector():
    prof = route_context.build_retrieval_profile(
        AD1404T_MSG, history=[], intent_result=AD1404T_INTENT,
        shop="KingGadgets")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(
        prof, slots, allow_reversed=True)
    assert len(rels) == 1, f"reversed ที่ใช้กับ ต้อง parse ได้ 1 relation — {rels}"
    rel = rels[0]
    cons = dict(rel.constraints)
    assert cons.get("target_subtype") == "cable"
    assert cons.get("display") == "required"
    assert cons.get("length_m") == "2"
    assert cons.get("speed") == "full"


def test_reversed_relation_typed_eligibility_matrix():
    """reversed ที่ใช้กับ relation — eligibility = typed TurnPlan productish
    need เท่านั้น (claim/warranty-only, absent needs, unknown intent,
    malformed intent → fail closed; mixed product+claim → productish need
    governs — ไม่ใช่ prose keywords)"""
    _prof = lambda msg, intent: route_context.build_retrieval_profile(
        msg, history=[], intent_result=intent, shop="KingGadgets")
    _rels = lambda prof, allow=False: route_context.build_retrieval_relations(
        prof, route_context.build_retrieval_slots(prof),
        allow_reversed=allow)

    prof = _prof(AD1404T_MSG, AD1404T_INTENT)

    # productish TurnPlan (recommendation) → allowed
    productish = _decide(AD1404T_MSG, intent=AD1404T_INTENT).needs
    assert any(n.kind in ("product", "compare", "compat")
               for n in productish)
    assert len(_rels(prof, allow=True)) == 1

    # warranty/claim-only needs → absent
    claim_only = (_need(kind="claim", operation="collect"),
                  _need(kind="troubleshoot", operation="describe"))
    assert _rels(prof, allow=any(
        n.kind in ("product", "compare", "compat")
        for n in claim_only)) == ()

    # missing needs → absent (default fail closed)
    assert _rels(prof) == ()
    assert _rels(prof, allow=False) == ()

    # unknown/other intent without productish need → absent
    plan = _decide("ประกันเคลมยังไง",
                   intent={"intent": "other", "confidence": 0.4})
    assert not any(n.kind in ("product", "compare", "compat")
                   for n in plan.needs)
    assert _rels(prof, allow=False) == ()

    # malformed classifier result → confidence normalize เป็น 0.0 —
    # eligibility ยังมาจาก typed needs เท่านั้น (ดู malformed suite ข้างล่าง)
    plan = _decide(AD1404T_MSG,
                   intent={"intent": "recommendation",
                           "confidence": "garbage"})
    assert plan.intent_confidence == 0.0

    # mixed product+claim — productish need มีจริง → relation follows the
    # typed need (ไม่ใช่ claim keywords ใน prose)
    mixed_msg = "สายที่ใช้กับ AD1404T เสียไปแล้ว ชาร์จไม่เข้า"
    mixed = _decide(mixed_msg,
                    intent={"intent": "warranty_claim", "confidence": 0.9})
    assert any(n.kind in ("product", "compare", "compat")
               for n in mixed.needs)
    mprof = _prof(mixed_msg, {"intent": "warranty_claim",
                              "confidence": 0.9})
    assert _rels(mprof, allow=True), (
        "mixed turn ที่มี productish need จริง → relation eligibility "
        "ตาม typed need")


def test_forward_relation_unaffected_by_reversed_flag():
    # forward pattern (target หลัง connector) ไม่ขึ้นกับ reversed eligibility
    msg = "หัวชาร์จ AD1404T ใช้กับสายชาร์จแบบไหนดี"
    prof = route_context.build_retrieval_profile(
        msg, history=[], intent_result={"intent": "product_question",
                                        "confidence": 0.9},
        shop="KingGadgets")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    assert rels, f"forward relation ต้อง parse ได้เสมอ (ไม่ผูก flag) — {rels}"


# ── D. malformed intent normalization + shadow parity ────────


def test_malformed_confidence_normalizes_to_zero():
    # canonical boundary เดียว normalize — malformed confidence ห้าม raise
    # และต้องกลายเป็น 0.0 (intent scope gates ≥0.7 จึงไม่ถูก apply)
    for bad in ("garbage", object(), [0.5], {"x": 1}, None):
        plan = _decide("AC65B ราคาเท่าไหร่",
                       intent={"intent": "product_question",
                               "confidence": bad,
                               "product_type": "charger"})
        assert plan.intent_confidence == 0.0, (
            f"confidence {bad!r} ต้อง normalize เป็น 0.0 — "
            f"got {plan.intent_confidence}")
        prod = next(n for n in plan.needs if n.kind == "product")
        assert not prod.product_types, (
            f"conf<0.7 → intent scope ห้าม apply — {prod.product_types}")
        prof = route_context.build_retrieval_profile(
            "AC65B ราคาเท่าไหร่", history=[],
            intent_result={"intent": "product_question", "confidence": bad,
                           "product_type": "charger"},
            shop="KingGadgets")
        assert prof is not None, (
            f"profile ต้องรอดกับ confidence {bad!r}")


def test_confidence_boundary_values():
    # canonical contract: finite ∈ [0.0, 1.0] → float; bool/non-finite/
    # out-of-range/malformed → 0.0; ห้าม raise
    cases = (("NaN", 0.0), ("Infinity", 0.0),
             (float("nan"), 0.0), (float("inf"), 0.0),
             (float("-inf"), 0.0), (True, 0.0), (False, 0.0),
             (-0.1, 0.0), (1.1, 0.0),
             (0, 0.0), (0.7, 0.7), (1, 1.0), ("0.9", 0.9))
    for raw, want in cases:
        assert route_context.intent_confidence({"confidence": raw}) == want, (
            f"confidence {raw!r} ต้อง → {want}")
        plan = _decide("AC65B ราคาเท่าไหร่",
                       intent={"intent": "product_question",
                               "confidence": raw, "product_type": "charger"})
        assert plan.intent_confidence == want, (
            f"plan ต้องเห็น {want} สำหรับ {raw!r} — "
            f"got {plan.intent_confidence}")
        prof = route_context.build_retrieval_profile(
            "AC65B ราคาเท่าไหร่", history=[],
            intent_result={"intent": "product_question",
                           "confidence": raw, "product_type": "charger"},
            shop="KingGadgets")
        assert prof is not None, f"profile ต้องรอดกับ {raw!r}"
    # invalid confidence ห้ามเปิด intent-derived scope (gate ≥0.7) —
    # bool/non-finite/out-of-range normalize เป็น 0.0 จึงไม่มี trust
    for raw in (float("nan"), float("inf"), True, 1.1):
        plan = _decide("AC65B ราคาเท่าไหร่",
                       intent={"intent": "product_question",
                               "confidence": raw, "product_type": "charger"})
        prod = next(n for n in plan.needs if n.kind == "product")
        assert not prod.product_types, (
            f"invalid conf {raw!r} ห้าม apply intent scope — "
            f"{prod.product_types}")


def test_malformed_intent_no_trusted_productish_eligibility():
    # malformed confidence ไม่ผลิต intent trust — eligibility ยังมาจาก
    # typed needs ที่ derive จาก structured evidence เท่านั้น
    prof = route_context.build_retrieval_profile(
        AD1404T_MSG, history=[], intent_result=AD1404T_INTENT,
        shop="KingGadgets")
    slots = route_context.build_retrieval_slots(prof)
    # malformed conf → intent scope ว่าง แต่ kw-driven productish needs
    # ยังมีอยู่ → eligibility ตาม typed need (ไม่ใช่ intent เดี่ยว)
    plan = _decide(AD1404T_MSG, intent={"confidence": "garbage"})
    assert any(n.kind in ("product", "compare", "compat")
               for n in plan.needs)
    prodish = any(n.kind in ("product", "compare", "compat")
                  for n in plan.needs)
    rels = route_context.build_retrieval_relations(
        prof, slots, allow_reversed=prodish)
    assert len(rels) == 1
    # non-productish-only plan → absent เสมอ
    plan = _decide("ประกันเคลมยังไง",
                   intent={"intent": "other", "confidence": [0.9]})
    assert not any(n.kind in ("product", "compare", "compat")
                   for n in plan.needs)
    assert route_context.build_retrieval_relations(
        prof, slots, allow_reversed=False) == ()


def test_shadow_and_production_same_reversed_eligibility(monkeypatch):
    # production + shadow derive flag เดียวกันจาก typed needs —
    # ไม่มี second eligibility helper; test นี้ verify eligibility
    # เท่านั้น — executor ถูก patch เป็น offline leaf (ห้ามแตะ fetcher/
    # Mongo/unit/legacy/embedding/provider path)
    from shopeechat import retrieval_shadow as _rs

    prof = route_context.build_retrieval_profile(
        AD1404T_MSG, history=[], intent_result=AD1404T_INTENT,
        shop="KingGadgets")
    productish = _decide(AD1404T_MSG, intent=AD1404T_INTENT).needs

    seen_prod, seen_shadow = [], []

    def spy_p(profile, slots, **kw):
        seen_prod.append(kw.get("allow_reversed"))
        return ()

    def spy_s(profile, slots, **kw):
        seen_shadow.append(kw.get("allow_reversed"))
        return ()

    monkeypatch.setattr(retrieval_runtime, "build_retrieval_relations", spy_p)
    monkeypatch.setattr(retrieval_runtime,
                        "execute_grouped_retrieval_requests",
                        lambda *a, **k: ())
    monkeypatch.setattr(_rs, "build_retrieval_relations", spy_s)
    monkeypatch.setattr(_rs, "execute_grouped_retrieval_requests",
                        lambda *a, **k: ())

    retrieval_runtime.run_grouped_selection(
        prof, message=AD1404T_MSG, shop="s",
        fetcher=lambda m, **k: None,
        legacy_fetcher=lambda m, **k: [], needs=productish, snap=None)
    _rs.run_grouped_retrieval_shadow(
        prof, message=AD1404T_MSG, shop="s", needs=productish, snap=None)
    _rs.run_grouped_retrieval_shadow(
        prof, message=AD1404T_MSG, shop="s", snap=None)  # needs absent

    assert seen_prod == [True], f"production flag — {seen_prod}"
    assert seen_shadow == [True, False], (
        f"shadow ต้อง derive flag เดียวกัน: productish→True, absent→False — "
        f"{seen_shadow}")


# ── C. selector contract ─────────────────────────────────────


def test_selection_accepts_needs_param():
    pool, reqs = _two_request_pool()
    needs = (_need(kind="compat", operation="compat",
                   subject_refs=("AD1404T",), confidence=0.85,
                   provenance=("t",),
                   product_types=frozenset({"charger"}),
                   subtypes=frozenset({"cable"})),)
    sel = select_for_llm_context(pool, reqs, None, needs=needs)
    assert sel is not None


def test_selected_identity_never_duplicated():
    pool, reqs = _two_request_pool()
    sel = select_for_llm_context(pool, reqs, None)
    ids = [s.identity for s in sel.selected]
    assert len(ids) == len(set(ids)), (
        f"identity เดียวกันถูก select ซ้ำข้าม request — {ids}")


def test_role_precedence_relation_target_over_alternative():
    pool, reqs = _two_request_pool()
    sel = select_for_llm_context(pool, reqs, None)
    cable = next((s for s in sel.selected
                  if s.card.get("product_type") == "cable"), None)
    assert cable is not None
    assert cable.role == "relation_target", (
        f"cable = เป้าหมายของ relation — ห้าม degrade เป็น "
        f"alternative/slot — got {cable.role!r}")


def test_exact_subject_keeps_subject_role():
    pool, reqs = _two_request_pool()
    sel = select_for_llm_context(pool, reqs, None)
    adapter = next((s for s in sel.selected
                    if "AD1404T" in (s.card.get("model_codes") or [])),
                   None)
    assert adapter is not None and adapter.role == "subject"


def test_ranked_need_orders_picks():
    slot_req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"charger"}), frozenset({"adapter"}),
        (), None, "sellable_first", "none")
    weak = make_evidence_card(_adapter(name="CUKTECH AC30S หัวชาร์จ 30W",
                                       item_id="w1", unit_id="uw1",
                                       model_codes=["AC30S"]), source="units")
    strong = make_evidence_card(_adapter(name="CUKTECH AC65B หัวชาร์จ 65W",
                                         item_id="s1", unit_id="us1",
                                         model_codes=["AC65B"]), source="units")
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=frozenset({"adapter"}), model_codes=(),
        eligible_candidates=(weak, strong),
        source_attempts=(SourceAttempt("units", 2, 2, 0, 0, ("t",)),))
    pool = build_candidate_pool((res,))
    needs = (_need(kind="product", operation="recommend", confidence=0.8,
                   provenance=("t",), product_types=frozenset({"charger"}),
                   ranking=("output_power_w", "max")),)
    sel = select_for_llm_context(pool, (slot_req,), None, needs=needs)
    names = [s.card.get("name") for s in sel.selected]
    assert names.index("CUKTECH AC65B หัวชาร์จ 65W") < names.index(
        "CUKTECH AC30S หัวชาร์จ 30W"), (
        f"ranked need (wattage max) ต้องเรียง 65W ก่อน 30W — {names}")


def test_unranked_need_keeps_score_order():
    slot_req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"charger"}), frozenset({"adapter"}),
        (), None, "sellable_first", "none")
    weak = make_evidence_card(_adapter(name="CUKTECH AC30S หัวชาร์จ 30W",
                                       item_id="w1", unit_id="uw1",
                                       model_codes=["AC30S"]), source="units")
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=frozenset({"adapter"}), model_codes=(),
        eligible_candidates=(weak,),
        source_attempts=(SourceAttempt("units", 1, 1, 0, 0, ("t",)),))
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (slot_req,), None, needs=())
    assert len(sel.selected) == 1


def test_historical_evidence_role_not_subject():
    slot_req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"charger"}), frozenset({"adapter"}),
        ("OLD9",), None, "answerable_all", "none")
    snap = make_evidence_card(
        _adapter(name="CUKTECH OLD9 หัวชาร์จเก่า", model_codes=["OLD9"],
                 _available_for_sale=False, _snapshot_only=True),
        source="units")
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=frozenset({"adapter"}), model_codes=("OLD9",),
        unavailable_evidence=(snap,),
        source_attempts=(SourceAttempt("units", 1, 1, 0, 0, ("t",)),))
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (slot_req,), None)
    promoted = [s for s in sel.selected if "OLD9" in str(
        s.card.get("model_codes") or ())]
    assert promoted, "snapshot subject ต้องได้ promote"
    assert promoted[0].role == "historical_evidence", (
        f"snapshot/historical evidence ห้ามเป็น current subject — "
        f"got {promoted[0].role!r}")


def test_hidden_mention_label_never_selected():
    slot_req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"charger"}), frozenset({"adapter"}),
        (), None, "sellable_first", "none")
    hidden = make_evidence_card(
        _adapter(name="CUKTECH HIDDEN1 หัวชาร์จ", customer_visible=False,
                 catalog_status="unlisted"), source="units",
        selection_reason="customer_hidden")
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=frozenset({"adapter"}), model_codes=(),
        rejected_evidence=(hidden,),
        source_attempts=(SourceAttempt("units", 1, 0, 0, 1, ("t",)),))
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (slot_req,), None)
    assert not sel.selected, "hidden card ห้ามเข้า selected"
    reasons = {r["reason"] for r in sel.rejected_summary}
    assert "hidden_mention" in reasons, (
        f"hidden mention ต้องเป็น role แยกใน rejected summary — {reasons}")


def test_run_grouped_selection_forwards_needs():
    assert "needs" in inspect.signature(
        retrieval_runtime.run_grouped_selection).parameters


def test_grouped_selection_calls_selector_once(monkeypatch):
    prof = route_context.build_retrieval_profile(
        AD1404T_MSG, history=[], intent_result=AD1404T_INTENT,
        shop="KingGadgets")
    calls = []

    def units_fetcher(message, **kw):
        return UnitEvidenceFetchResult(
            cards=(make_evidence_card(_cable("สาย A มีจอ", "u-c"), source="units"),),
            raw_count=1, sellable_count=1, unavailable_count=0,
            trace=("u",))

    real = retrieval_runtime.select_for_llm_context

    def spy(*a, **k):
        calls.append(k.get("needs"))
        return real(*a, **k)

    monkeypatch.setattr(retrieval_runtime, "select_for_llm_context", spy)
    needs = _decide(AD1404T_MSG, intent=AD1404T_INTENT).needs
    out = retrieval_runtime.run_grouped_selection(
        prof, message=AD1404T_MSG, shop="KingGadgets",
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [],
        needs=needs, snap=None)
    assert len(calls) == 1, f"selector ต้องถูกเรียกครั้งเดียว — {len(calls)}"
    assert calls[0] is not None and len(calls[0]) == len(needs), (
        f"needs ต้องถูกส่งเข้า selector — {calls}")
