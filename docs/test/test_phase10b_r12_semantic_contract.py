"""Phase 10B r12 — semantic operation authority + typed spec constraints.

RED targets (real owners, offline — no provider calls):

  D. `_PRICE_ASK_KWS` must not convert every "เท่าไหร่" into price — typed
     `requested_facts` (intent contract) owns the fact operation.
  E. typed `spec_constraints`/`required_features` flow intent → TurnNeed →
     RetrievalProfile/Slot/RetrievalRequest → canonical fact evaluation
     (`extract_field_facts` owner) — "10Gbps ขึ้นไปและเป็นสายแม่เหล็ก"
     becomes (data_transfer_mbps, gte, 10000) + magnetic.
  A. named-terms merge must not demote product types backed by typed
     need scope (charger from intent survives on Pingevox Q3 shape).
  B. productish needs carrying a typed target get the same
     subject-target verdict gate as compat needs — undecided candidates
     are presented with an explicit limitation, incompatible are dropped;
     "ยังยืนยันไม่ได้" ≠ "ร้านไม่มี".
  C. exact-item fact questions admit the item's own description/spec
     evidence (requested_facts), so supported claims are not rewritten.
  F/H. persisted subject on a fresh recommend turn enters as
     `historical_evidence` (reference, not subject).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import route_context as rc  # noqa: E402
from shopeechat import retrieval_planner as rpl  # noqa: E402
from shopeechat import retrieval_runtime as rrt  # noqa: E402
from shopeechat import retrieval_selection as rsel  # noqa: E402
from shopeechat import candidate_pool as cpool  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import policy_resolver as pr  # noqa: E402

RetrievalRequest = rpl.RetrievalRequest
TurnNeed = td.TurnNeed


# ── builders (same shapes as test_phase7_answer_context) ────────────────────

def _intent(**kw):
    base = {"intent": "product_spec", "product_type": "charger",
            "charger_subtype": "cable", "target_device": None,
            "relation_target": None, "needs_description": True,
            "subject_scope": "current_single", "subject_count": None,
            "confidence": 0.98}
    base.update(kw)
    return base


def _req(rid="req-0", slot="slot-a", source="slot", types=("charger",),
         subs=(), codes=(), target=None, soft=(), hard=(),
         spec_constraints=(), required_features=(),
         compat="none", subject_refs=()):
    return RetrievalRequest(
        request_id=rid, slot_id=slot, source=source,
        product_types=frozenset(types), subtypes=frozenset(subs),
        model_codes=tuple(codes), target_device=target,
        availability_mode="sellable_first", compat_mode=compat,
        hard_filters=tuple(hard), soft_hints=tuple(soft),
        subject_refs=tuple(subject_refs),
        spec_constraints=tuple(spec_constraints),
        required_features=tuple(required_features))


def _sel_card(identity, role, rid, name, score=1.0, **card_kw):
    card = {"name": name, "item_id": identity.split(":")[-1],
            "model_codes": [], "sellable": True,
            "customer_visibility": "visible", "price": {"min": 300, "max": 300}}
    card.update(card_kw)
    return rsel.SelectedCandidate(
        role=role, request_id=rid, slot_id="s", relation_id=None,
        identity=identity, score=score, constraint_hits=(), reason="ok",
        card=card)


def _selection(*entries):
    selected = tuple(e[0] for e in entries)
    by_req: dict[str, list] = {}
    for sc, rid in entries:
        by_req.setdefault(rid, []).append(sc)
    return rsel.SelectionResult(
        selected=selected,
        by_request=tuple((rid, tuple(cs)) for rid, cs in by_req.items()),
        unavailable_evidence=(), rejected_summary=(), trace=())


def _pooled(identity, item_id="1", bucket="eligible", name="P"):
    card = {"name": name, "item_id": item_id, "model_codes": [],
            "customer_visibility": "visible"}
    return cpool.PooledCandidate(
        identity=identity, item_id=item_id, model_id=None, unit_id=None,
        sources=("legacy",), request_ids=("req-0",), slot_id="s",
        relation_id=None, product_type="charger", subtype=None,
        bucket=bucket, reason="ok", score=1.0, trace=(), card=card)


def _pool(eligible=(), supporting=()):
    return cpool.CandidatePool(
        eligible=tuple(eligible), unavailable=(), rejected=(),
        by_request=(), evidence_pool=(),
        supporting_evidence=tuple(supporting), trace=())


def _profile(msg="ทดสอบ", **kw):
    base = dict(history=[], intent_result={}, shop="S", platform="shopee")
    base.update(kw)
    return rc.build_retrieval_profile(msg, **base)


def _compile(needs, selection, pool, requests, profile, **kw):
    task = acx.compile_answer_task(
        needs=needs, selection=selection, requests=requests, pool=pool,
        profile=profile)
    return acx.compile_answer_context(
        task=task, needs=needs, selection=selection, pool=pool,
        requests=requests, profile=profile, **kw)


_CMC_NAME = ("CUKTECH CMC615P 6A 240W สายชาร์จแม่เหล็ก มีจอ "
             "USB-C to USB-C รองรับการชาร์จเร็ว PD3.1 -24M")
_CMC_DESC = ("CUKTECH CMC615P คือสายชาร์จหัวแม่เหล็กพร้อมหน้าจอ "
             "ถ่ายโอนข้อมูลได้รวดเร็ว ด้วยความเร็วการรับส่งข้อมูลที่สูงถึง "
             "480Mbps เก็บง่ายด้วยสายชาร์จแบบแม่เหล็ก")


def _cmc_card():
    return {"item_id": "27639651334", "name": _CMC_NAME,
            "raw_description": _CMC_DESC, "canonical_specs": {},
            "customer_visibility": "visible", "sellable": True,
            "catalog_status": "active", "customer_visible": True,
            "total_stock": 10, "status": "normal",
            "model_codes": [], "price": {"min": 590, "max": 590}}


# ── D: requested_facts owns the fact operation ───────────────────────────────

class TestFactOpAuthority:
    def test_speed_data_ask_is_spec_op_not_price(self):
        plan = td.decide_turn(
            "Speed data เท่าไหร่?ครับ",
            intent_result=_intent(
                requested_facts=["data_transfer_speed"]))
        ops = [(n.kind, n.operation) for n in plan.needs]
        assert ("product", "price") not in ops, \
            "typed facts say data speed — kw 'เท่าไหร่' must not emit price"
        prod = next(n for n in plan.needs if n.kind == "product")
        assert prod.operation in ("describe", "spec", "lookup"), ops
        assert "data_transfer_speed" in (prod.requested_facts or ())

    def test_price_fact_still_price(self):
        plan = td.decide_turn(
            "ราคาเท่าไหร่ครับ",
            intent_result=_intent(requested_facts=["price"]))
        assert any(n.kind == "product" and n.operation == "price"
                   for n in plan.needs), [n.operation for n in plan.needs]

    def test_no_typed_facts_keeps_kw_price_fallback(self):
        plan = td.decide_turn("ราคาเท่าไหร่ครับ", intent_result=_intent())
        assert any(n.kind == "product" and n.operation == "price"
                   for n in plan.needs)

    def test_same_shape_different_fact_no_collision(self):
        # เท่าไหร่ + data fact vs เท่าไหร่ + price fact — same surface shape
        for facts, want in ((["data_transfer_speed"], "describe"),
                            (["price"], "price")):
            plan = td.decide_turn(
                "เท่าไหร่ครับ",
                intent_result=_intent(requested_facts=list(facts)))
            ops = {n.operation for n in plan.needs if n.kind == "product"}
            assert want in ops or (
                want == "describe"
                and ops & {"describe", "spec", "lookup"}
                and "price" not in ops), (facts, ops)


# ── E: typed constraints/features contract ───────────────────────────────────

class TestTypedConstraintContract:
    def test_need_carries_spec_constraints_and_features(self):
        plan = td.decide_turn(
            "มีรุ่น 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหม",
            intent_result=_intent(
                intent="product_recommend", subject_scope="none",
                spec_constraints=[{"field": "data_transfer_mbps",
                                   "op": "gte", "value": 10000}],
                required_features=["magnetic"]))
        prod = next(n for n in plan.needs if n.kind == "product")
        assert ("data_transfer_mbps", "gte", 10000.0) in \
            (prod.spec_constraints or ())
        assert "magnetic" in (prod.required_features or ())

    def test_request_carries_constraints(self):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        prof = _profile("มีรุ่น 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหม",
                        intent_result=_intent(intent="product_recommend",
                                              subject_scope="none"))
        slots = rc.build_retrieval_slots(prof, needs=needs)
        reqs = rpl.build_grouped_retrieval_requests(prof, slots, (),
                                                  needs=needs)
        slot_req = next(r for r in reqs if r.source == "slot")
        assert ("data_transfer_mbps", "gte", 10000.0) in \
            slot_req.spec_constraints
        assert "magnetic" in slot_req.required_features


# ── canonical spec extraction (single owner) ────────────────────────────────

class TestCanonicalSpecExtraction:
    def test_cmc615p_yields_480mbps_fact(self):
        facts = pr.extract_field_facts(_cmc_card(), subject_id="27639651334")
        vals = [f for f in facts if f.fact_key == "data_transfer_mbps"]
        assert vals, "480Mbps in card evidence must produce a typed fact"
        assert any("480" in str(v) for f in vals for v in
                   (f.value if isinstance(f.value, tuple) else (f.value,)))

    def test_cmc615p_no_feature_fact_without_structured_field(self):
        # r4: card/units ไม่มี structured feature field — name/desc keyword
        #   inference ถูกลบ → 'features' fact ไม่ emit (unknown ไม่ใช่ pass)
        facts = pr.extract_field_facts(_cmc_card(), subject_id="27639651334")
        assert not any(f.fact_key == "features" for f in facts)

    def test_cmc615p_fails_gte_10gbps(self):
        facts = pr.extract_field_facts(_cmc_card(), subject_id="27639651334")
        res = pr.eval_spec_constraints(
            facts,
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",))
        assert "data_transfer_mbps" in res["failed"]
        # r4: magnetic ไม่มี structured evidence → unknown (fail closed)
        #   ไม่ใช่ satisfied — ไม่ถูกอ้างว่าผ่าน constraint
        assert "magnetic" in res["unknown"]

    def test_unknown_speed_is_not_a_failure(self):
        card = _cmc_card()
        card["raw_description"] = "สายชาร์จเร็ว USB-C to USB-C 240W"
        card["name"] = "CUKTECH CTC615W สายชาร์จเร็ว USB-C"
        facts = pr.extract_field_facts(card, subject_id="9")
        res = pr.eval_spec_constraints(
            facts,
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",))
        assert "data_transfer_mbps" in res["unknown"]
        assert "data_transfer_mbps" not in res["failed"]
        assert "magnetic" in res["failed"] or "magnetic" in res["unknown"]

    def test_40gbps_cable_satisfies(self):
        card = _cmc_card()
        card["raw_description"] = "สายชาร์จ USB4 ถ่ายโอนข้อมูล 40Gbps แม่เหล็ก"
        facts = pr.extract_field_facts(card, subject_id="9")
        res = pr.eval_spec_constraints(
            facts,
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",))
        # r4: speed constraint ผ่านจาก structured fact; magnetic ไม่มี
        #   structured evidence → unknown (ไม่ใช่ satisfied)
        assert not res["failed"], res
        assert "data_transfer_mbps" in res["satisfied"]
        assert "magnetic" in res["unknown"] \
            and "magnetic" not in res["satisfied"]


# ── A: need-scoped product types survive named-terms merge ──────────────────

class TestNeedScopedTypesSurviveMerge:
    def test_intent_charger_type_stays_on_request(self):
        msg = "อยากได้ของที่ใช้กับ xiaomi 17 ultra"
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            target_refs=("xiaomi 17 ultra",),
            subject_scope="none"),)
        prof = _profile(msg, intent_result=_intent(
            intent="product_recommend", subject_scope="none",
            target_device="xiaomi 17 ultra", charger_subtype=None))
        slots = rc.build_retrieval_slots(prof, needs=needs)
        reqs = rpl.build_grouped_retrieval_requests(prof, slots, (),
                                                  needs=needs)
        slot_req = next(r for r in reqs if r.source == "slot")
        assert "charger" in slot_req.product_types, (
            f"typed need scope demoted by named-terms merge: "
            f"{slot_req.product_types} soft={slot_req.soft_hints}")


# ── B: productish needs with typed target get the verdict gate ───────────────

class TestProductNeedTargetGate:
    def _xiaomi_need(self):
        return (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"adapter"}),
            target_refs=("xiaomi 17 ultra",)),)

    def _s26_card(self):
        # card whose only device claim is Samsung — no Xiaomi evidence
        return _sel_card(
            "i:5761", "relation_target", "req-0",
            "CUKTECH AD653T ชุดชาร์จ รองรับอุปกรณ์ S26 หัวชาร์จเร็ว Type-C",
            canonical_roles=["adapter"], canonical_type="charger")

    def test_undecided_target_candidate_carries_limitation(self):
        needs = self._xiaomi_need()
        req = _req(target="xiaomi 17 ultra", compat="connector_required")
        sel = _selection((self._s26_card(), "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:5761", "5761")]),
                       (req,), _profile("หัวชาร์จละ"))
        assert ctx.products, "undecided candidate should stay as candidate"
        card = ctx.products[0]
        note = card.get("_context_note") or ""
        assert "ยืนยัน" in note or "ไม่มีข้อมูล" in note, \
            f"unverified xiaomi compat must carry explicit limitation: {note}"

    def _xiaomi_spec_evidence(self):
        # spec-db record shape เดียวกับ device_compat._device_spec_lookup
        # emit จริงใน live path — structured connector evidence ของ target
        return {"kind": "device_spec", "target": "xiaomi 17 ultra",
                "data": {"connector": ["usb-c"], "wired_w": 90,
                         "source": "spec-db"}}

    def test_incompatible_candidate_dropped(self):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            target_refs=("xiaomi 17 ultra",)),)
        # live shape: charger type + target → compat_mode=connector_required
        req = _req(target="xiaomi 17 ultra", compat="connector_required")
        lightning_only = _sel_card(
            "i:9", "relation_target", "req-0",
            "CUKTECH CTL301 USB-C to Lightning สายชาร์จ iPhone MFi 480Mbps",
            raw_description="Lightning cable for iPhone only",
            canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((lightning_only, "req-0"))
        ctx = _compile(
            needs, sel,
            _pool(eligible=[_pooled("i:9", "9")],
                  supporting=[self._xiaomi_spec_evidence()]),
            (req,), _profile("หัวชาร์จละ"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "9" not in ids, \
            "lightning-only card is decided-incompatible with usb-c target"

    def test_unverified_is_not_catalog_empty(self):
        """zero-products context from unverified candidates must not read
        'ไม่มีสินค้า/ไม่พบ' — wording distinguishes 'ยังยืนยันไม่ได้'."""
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            target_refs=("xiaomi 17 ultra",)),)
        req = _req(target="xiaomi 17 ultra", compat="connector_required")
        lightning_only = _sel_card(
            "i:9", "relation_target", "req-0",
            "CUKTECH CTL301 USB-C to Lightning สายชาร์จ iPhone MFi",
            raw_description="Lightning cable for iPhone only",
            canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((lightning_only, "req-0"))
        ctx = _compile(needs, sel, _pool(eligible=[_pooled("i:9", "9")]),
                       (req,), _profile("หัวชาร์จละ"))
        text = ctx.context_text()
        if not ctx.products:
            assert "ไม่มีสินค้า" not in text and "ไม่พบ" not in text or \
                "ยืนยัน" in text or "ไม่มีข้อมูลยืนยัน" in text, text


# ── E/compile: constraint evaluation on selected candidates ──────────────────

class TestConstraintEvaluationAtCompile:
    def test_proven_fail_dropped_with_near_miss_note(self):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
                   required_features=("magnetic",))
        cmc = _sel_card("i:27639651334", "slot", "req-0", _CMC_NAME,
                        raw_description=_CMC_DESC,
                        canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((cmc, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:27639651334",
                                               "27639651334",
                                               name=_CMC_NAME)]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "27639651334" not in ids, \
            "CMC615P proven-fails >=10Gbps (480Mbps) — must not be a product"
        text = ctx.context_text()
        assert "CMC615P" in text or "แม่เหล็ก" in text, \
            "near-miss explanation should name the failing item: " + text

    def test_unknown_constraint_keeps_candidate_with_limitation(self):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
                   required_features=("magnetic",))
        plain = _sel_card("i:7", "slot", "req-0",
                          "CUKTECH CTC615W สายชาร์จเร็ว USB-C 240W",
                          raw_description="สายชาร์จเร็ว 240W",
                          canonical_roles=["cable"],
                          canonical_type="charger")
        sel = _selection((plain, "req-0"))
        ctx = _compile(needs, sel, _pool(eligible=[_pooled("i:7", "7")]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "7" in ids, "unproven ≠ disproven — candidate stays"
        note = ctx.products[0].get("_context_note") or ""
        assert "ยืนยัน" in note or "ไม่มีข้อมูล" in note or \
            "ไม่ทราบ" in note, note


# ── C: requested_facts admit the item's own spec evidence ────────────────────

class TestRequestedFactsEvidenceAdmission:
    def test_desc_fields_admitted_on_typed_facts(self):
        need = TurnNeed(kind="product", operation="stock",
                        subject_refs=("27639651334",),
                        requested_facts=("data_transfer_speed",))
        card = _cmc_card()
        scoped = acx._scope_card(dict(card), need, "subject")
        assert scoped.get("raw_description") or \
            scoped.get("description_excerpt"), \
            "typed fact question must admit the item's own description evidence"

    def test_plain_stock_still_excludes_desc(self):
        need = TurnNeed(kind="product", operation="stock",
                        subject_refs=("27639651334",))
        scoped = acx._scope_card(dict(_cmc_card()), need, "subject")
        assert not scoped.get("raw_description"), \
            "no requested facts → desc evidence stays excluded (r11 behavior)"

    def test_requested_fact_emitted_as_typed_spec_facts(self):
        """"Speed data เท่าไหร่" → the requested fact must surface as a
        first-class typed field (spec_facts) on the emitted card — model
        must not have to mine raw_description prose for 480Mbps."""
        need = TurnNeed(kind="product", operation="describe",
                        subject_refs=("27639651334",),
                        requested_facts=("data_transfer_speed",))
        scoped = acx._scope_card(dict(_cmc_card()), need, "subject")
        sf = scoped.get("spec_facts") or {}
        assert abs(sf.get("data_transfer_mbps", 0) - 480.0) < 0.01, sf

    def test_spec_facts_only_from_evidence(self):
        """unknown fact → no spec_facts entry (unknown ≠ fabricated)."""
        need = TurnNeed(kind="product", operation="describe",
                        subject_refs=("9",),
                        requested_facts=("data_transfer_speed",))
        card = {"item_id": "9", "name": "CUKTECH X สายชาร์จ USB-C",
                "canonical_specs": {}, "model_codes": []}
        scoped = acx._scope_card(card, need, "subject")
        assert not (scoped.get("spec_facts") or {}).get(
            "data_transfer_mbps"), "no evidence → no typed fact"


class TestCompatNeedVerdictAnnotation:
    """compat need emits relation_target cards — the emitted card note must
    reflect the per-card verdict, not the affirmative role note (live
    defect: decided-incompatible CTL301 emitted 'ใช้ร่วมกันได้' note)."""

    def _needs(self):
        return (
            TurnNeed(kind="compat", operation="compat",
                     target_refs=("xiaomi 17 ultra",)),
            TurnNeed(kind="product", operation="recommend",
                     product_types=frozenset({"charger"}),
                     target_refs=("xiaomi 17 ultra",)),
        )

    def test_decided_incompatible_card_loses_affirmative_note(self):
        req = _req(target="xiaomi 17 ultra", compat="connector_required")
        lightning = _sel_card(
            "i:9", "relation_target", "req-0",
            "CUKTECH CTL301 USB-C to Lightning สายชาร์จ iPhone MFi 480Mbps",
            raw_description="Lightning cable for iPhone only")
        sel = _selection((lightning, "req-0"))
        spec = {"kind": "device_spec", "target": "xiaomi 17 ultra",
                "data": {"connector": ["usb-c"], "wired_w": 90,
                         "source": "spec-db"}}
        ctx = _compile(self._needs(), sel,
                       _pool(eligible=[_pooled("i:9", "9")],
                             supporting=[spec]),
                       (req,), _profile("ใช้กับ xiaomi ได้ไหม"))
        card = next((p for p in ctx.products
                     if str(p.get("item_id")) == "9"), None)
        if card is not None:
            note = card.get("_context_note") or ""
            assert "ไม่เข้ากัน" in note or "ห้ามเสนอ" in note, \
                f"decided-incompatible card must not carry the affirmative " \
                f"relation_target note: {note}"
            assert "ใช้ร่วมกันได้" not in note, note


# ── F/H: persisted subject as historical evidence on fresh recommend ─────────

class TestHistoryReferenceChannel:
    def test_history_cards_become_historical_evidence(self):
        prof = _profile("มีรุ่น 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหม",
                        intent_result=_intent(intent="product_recommend",
                                              subject_scope="none"))
        needs = (TurnNeed(kind="product", operation="recommend",
                          product_types=frozenset({"charger"}),
                          subtypes=frozenset({"cable"}),
                          subject_scope="none"),)
        out = rrt.run_grouped_selection(
            prof, message="มีรุ่น 10Gbps ขึ้นไปและเป็นสายแม่เหล็กไหม",
            shop="S", fetcher=lambda *a, **k: (), legacy_fetcher=None,
            needs=needs, history_cards=(_cmc_card(),))
        sel = out["selection"]
        roles = {s.role for s in sel.selected}
        assert "historical_evidence" in roles, roles
        hist = next(s for s in sel.selected if s.role == "historical_evidence")
        assert str(hist.card.get("item_id")) == "27639651334"
        assert hist.role != "subject", \
            "prior subject on fresh-recommend must not become the subject"


# ── G: evaluated spec values must reach the answer + grounding surface ───────

class TestConstraintEvalGroundingSurface:
    """constraint-evaluated cards must expose measured spec values as typed
    spec_facts so the model can narrate near-misses and the identity-scoped
    guard can ground them (live defect: '480Mbps' rewritten as ungrounded
    on Wattaka Q3 even though it was the card's own canonical fact)."""

    def test_numeric_token_grounded_by_canonical_fact(self):
        fe = pr.FieldEvidence(
            subject_id="i:1", fact_key="data_transfer_mbps",
            value=480.0, status="known", source="card")
        assert pr.claim_supported((fe,), "i:1", "480mbps")
        assert not pr.claim_supported((fe,), "i:1", "10gbps"), \
            "10gbps=10000 ≠ 480 — affirmative overclaim must stay closed"
        assert not pr.claim_supported((fe,), "i:1", "500mbps")

    def test_gbps_token_normalizes_to_mbps(self):
        fe = pr.FieldEvidence(
            subject_id="i:1", fact_key="data_transfer_mbps",
            value=10000.0, status="known", source="card")
        assert pr.claim_supported((fe,), "i:1", "10gbps"), \
            "unit normalize must match intent constraints (gbps→mbps)"

    def test_scoped_spec_facts_feed_extract(self):
        """scoped ctx card carries spec_facts dict (no raw_description) —
        extract_field_facts must fold it back into typed facts so the
        guard grounds claims against them."""
        card = {"item_id": "1", "name": "X",
                "spec_facts": {"data_transfer_mbps": 480.0}}
        facts = pr.extract_field_facts(card, subject_id="i:1")
        assert any(f.fact_key == "data_transfer_mbps" and
                   float(f.value) == 480.0 for f in facts), facts
        assert pr.claim_supported(facts, "i:1", "480mbps")

    def test_evaluated_card_emits_measured_spec_facts(self):
        """evaluated card's measured value must be typed evidence —
        spec_facts บน card ที่ emit (passed/unknown) + spec_measured_facts
        ผูก identity สำหรับ card ที่ fail (ออกจาก products — r12c fix C)."""
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
                   required_features=("magnetic",))
        hist = _sel_card("i:27639651334", "historical_evidence", "req-0",
                         _CMC_NAME, raw_description=_CMC_DESC,
                         canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((hist, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:27639651334",
                                               "27639651334",
                                               name=_CMC_NAME)]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        card = next((p for p in ctx.products
                     if str(p.get("item_id")) == "27639651334"), None)
        # proven-fail identity → ออกจาก products (r12c fix C) — ค่าที่วัด
        # ยังอยู่เป็น typed measured evidence ผูก identity
        assert card is None, \
            "proven-fail card must not survive as answer product"
        meas = [f for f in (ctx.spec_measured_facts or ())
                if f.get("identity") == "i:27639651334"
                and f.get("fact_key") == "data_transfer_mbps"]
        assert meas and abs(float(meas[0]["value"]) - 480.0) < 0.01, \
            f"measured 480Mbps must be typed evidence bound to identity: {ctx.spec_measured_facts}"

    def test_all_candidates_fail_emits_none_passed_note(self):
        """every evaluated candidate proven-fails → context must say so
        explicitly (distinction: 'none satisfy constraints' ≠ 'catalog
        empty' ≠ 'unverified')."""
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),))
        slow = _sel_card("i:7", "slot", "req-0",
                         "CUKTECH CTC615W สายชาร์จ USB-C 240W 480Mbps",
                         canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((slow, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:7", "7")]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        text = ctx.context_text()
        assert "ไม่มีสินค้าที่ผ่านเงื่อนไข" in text, \
            "must state no candidate passed — not imply catalog empty: " \
            + text


class TestConstraintVerdictSegment:
    """all-evaluated-candidates-fail = a typed verdict → deterministic
    segment (same owner class as compat verdicts) — must state 'no product
    passes' + kept subject/historical near-miss with evidence-grounded
    values only."""

    def _setup(self):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
                   required_features=("magnetic",))
        hist = _sel_card("i:27639651334", "historical_evidence", "req-0",
                         _CMC_NAME, raw_description=_CMC_DESC,
                         canonical_roles=["cable"], canonical_type="charger")
        slow = _sel_card("i:7", "slot", "req-0",
                         "CUKTECH CTC615W สายชาร์จ USB-C 240W 480Mbps",
                         canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((hist, "req-0"), (slow, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:27639651334",
                                               "27639651334",
                                               name=_CMC_NAME),
                                       _pooled("i:7", "7")]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        return needs, ctx

    def test_deterministic_constraint_segment(self):
        needs, ctx = self._setup()
        comp = acx.compose_answer(needs=needs, context=ctx,
                                  product_text="placeholder")
        segs = [r for r in comp.results if r.domain == "constraint"]
        assert segs, "all-fail need must emit a deterministic result"
        text = segs[0].text
        assert "ไม่มีสินค้าที่ผ่านเงื่อนไข" in text, text
        assert "CMC615P" in text and "480Mbps" in text, \
            "kept historical near-miss must be stated with its values: " \
            + text

    def test_segment_covers_need(self):
        needs, ctx = self._setup()
        comp = acx.compose_answer(needs=needs, context=ctx,
                                  product_text="")
        assert not [u for u in comp.unanswered_needs
                    if u.need_index == 0], \
            "deterministic verdict covers the need even without model text"

    def test_fail_label_places_threshold_under_negation(self):
        """'10Gbps' (the ask) must never read as a claim — label phrasing
        puts the threshold under negation so it survives spec grounding."""
        res = pr.eval_spec_constraints(
            pr.extract_field_facts(
                dict(_cmc_card()), subject_id="i:27639651334"),
            (("data_transfer_mbps", "gte", 10000.0),), ("magnetic",))
        lbl = acx._constraint_fail_label(res)
        import re as _re
        m = _re.search(r"10\s*Gbps", lbl)
        assert m, lbl
        pre = lbl[max(0, m.start() - 20):m.start()]
        assert "ไม่" in pre, \
            f"threshold must sit under negation for fail-closed safety: {lbl}"

    def test_measured_tokens_exposed_for_grounding(self):
        """measured values of evaluated candidates are typed product
        evidence ผูก identity — the guard must be able to ground them via
        identity-bound clauses (flat/global token channel removed r12c)."""
        needs, ctx = self._setup()
        facts = getattr(ctx, "spec_measured_facts", ()) or ()
        vals = {f.get("fact_key"): float(f.get("value"))
                for f in facts if f.get("fact_key")}
        assert abs(vals.get("data_transfer_mbps", 0) - 480.0) < 0.01, facts
        assert all(f.get("identity") for f in facts), \
            "every measured fact must carry its owning identity"
        assert not any(abs(v - 10000.0) < 0.01 for v in vals.values()), \
            "the ask threshold is not product evidence — never grounds"


# ── r12-correction A: current_single identity ownership ─────────────────────

class TestCurrentSingleIdentityOwnership:
    """live defect (Wattaka Q2): subject_scope=current_single resolved
    exactly ('27639651334',) แต่ need/request ไม่มี subject_refs → slot
    fetch ขยายเป็น sibling 3 ใบใน ctx/resp. resolved single id ต้อง stamp
    เข้า typed need contract (owner: turn_decision) ก่อน requests."""

    def _needs(self):
        return (TurnNeed(
            kind="product", operation="describe",
            subject_scope="current_single",
            requested_facts=("data_transfer_speed",),
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"})),)

    def test_resolved_single_id_stamps_current_single_need(self):
        out = td.apply_resolved_subject_refs(
            self._needs(), ("27639651334",),
            plan_scope="current_single")
        assert out[0].subject_refs == ("27639651334",), \
            "resolved canonical id must enter typed need.subject_refs"

    def test_none_scope_not_stamped(self):
        needs = (TurnNeed(kind="product", operation="recommend",
                          subject_scope="none"),)
        out = td.apply_resolved_subject_refs(needs, ("27639651334",),
                                             plan_scope="none")
        assert out[0].subject_refs == (), \
            "fresh recommendation must not inherit resolved identity"

    def test_multi_resolved_not_stamped(self):
        out = td.apply_resolved_subject_refs(
            self._needs(), ("27639651334", "999"),
            plan_scope="current_single")
        assert out[0].subject_refs == (), \
            "current_single with >1 resolved id is ambiguous — no stamp"

    def test_explicit_refs_not_overwritten(self):
        needs = (TurnNeed(kind="product", operation="describe",
                          subject_scope="current_single",
                          subject_refs=("111",)),)
        out = td.apply_resolved_subject_refs(needs, ("27639651334",),
                                             plan_scope="current_single")
        assert out[0].subject_refs == ("111",), \
            "explicit typed refs are authoritative — never overwritten"

    def test_stamped_need_selects_only_that_identity(self):
        """end-to-end: stamped need → slot request subject_refs →
        exact-item authority limits selection to the resolved card —
        siblings/bundles must not reach AnswerContext."""
        stamped = td.apply_resolved_subject_refs(
            self._needs(), ("27639651334",),
            plan_scope="current_single")
        cmc = _cmc_card()
        sib1 = dict(_cmc_card(), item_id="53852136362",
                    name="CUKTECH AD1003T + CMC615P เซตหัวชาร์จ+สาย")
        sib2 = dict(_cmc_card(), item_id="41933733847",
                    name="CUKTECH CTC615U สายชาร์จ USB-C 100W")

        def _fetch(req, **k):
            return (cmc, sib1, sib2)

        prof = _profile("Speed data เท่าไหร่?ครับ",
                        intent_result=_intent(
                            requested_facts=["data_transfer_speed"],
                            subject_scope="current_single"))
        out = rrt.run_grouped_selection(
            prof, message="Speed data เท่าไหร่?ครับ", shop="S",
            fetcher=_fetch, legacy_fetcher=None, needs=stamped,
            subject_cards=(cmc,))
        sel = out["selection"]
        ids = {str(s.card.get("item_id")) for s in sel.selected}
        assert ids == {"27639651334"}, \
            f"current_single selection must be exactly the resolved id: {ids}"
        assert all(s.role == "subject" for s in sel.selected), \
            "siblings must never take subject role under exact-id authority"

    def test_context_carries_only_resolved_product(self):
        stamped = td.apply_resolved_subject_refs(
            self._needs(), ("27639651334",),
            plan_scope="current_single")
        req = _req(subject_refs=("27639651334",))
        subj = _sel_card("i:27639651334", "subject", "req-0",
                         _CMC_NAME, raw_description=_CMC_DESC)
        sel = _selection((subj, "req-0"))
        ctx = _compile(stamped, sel,
                       _pool(eligible=[_pooled("i:27639651334",
                                               "27639651334",
                                               name=_CMC_NAME)]),
                       (req,), _profile("Speed data เท่าไหร่?"))
        ids = {str(p.get("item_id")) for p in ctx.products}
        assert ids == {"27639651334"}, ids


# ── r12-correction B: measured spec evidence is identity-scoped ──────────────

from types import SimpleNamespace as _NS  # noqa: E402


class TestMeasuredEvidenceIdentityScoped:
    """live defect: spec_measured_tokens flat/global → ค่าที่วัดจาก card
    ที่ drop แล้ว ไป ground claim ของสินค้าอื่นได้. measured evidence ต้อง
    ผูก identity — ground ได้เฉพาะ clause ที่ระบุ identity เจ้าของค่า."""

    def _ctx_with_failed(self):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
                   required_features=("magnetic",))
        hist = _sel_card("i:27639651334", "historical_evidence", "req-0",
                         _CMC_NAME, raw_description=_CMC_DESC,
                         canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((hist, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:27639651334",
                                               "27639651334",
                                               name=_CMC_NAME)]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        return needs, ctx

    def test_measured_facts_carry_identity_and_value(self):
        needs, ctx = self._ctx_with_failed()
        facts = getattr(ctx, "spec_measured_facts", ()) or ()
        hit = [f for f in facts
               if f.get("fact_key") == "data_transfer_mbps"
               and abs(float(f.get("value", 0)) - 480.0) < 0.01]
        assert hit, f"measured 480 must be typed evidence: {facts}"
        assert hit[0].get("identity") == "i:27639651334", hit[0]
        assert hit[0].get("name"), "binding needs the display name"

    def test_measured_value_never_grounds_prose_claims(self):
        """final-acceptance C: measured evidence ไม่ใช่ guard authority
        เลย — deterministic segment claims ground ผ่าน composition
        provenance marker เท่านั้น; '_spec_fact_grounded' ไม่ consume
        spec_measured และไม่ infer identity จาก prose (clause/model-
        token/digits/name path ถูกลบ)."""
        from shopeechat import guards
        import inspect
        assert "clause" not in inspect.signature(
            guards._spec_fact_grounded).parameters, \
            "prose clause binding must not exist in measured grounding"
        needs, ctx = self._ctx_with_failed()
        rd = {"spec_measured": list(ctx.spec_measured_facts or ()),
              "subject_ids": []}
        resp = _NS(answer="", products=[], routing_decision=rd)
        assert not guards._spec_fact_grounded(resp, "480mbps"), \
            "dropped-card measured value must not ground model prose"

    def test_kept_card_value_still_grounds_via_own_facts(self):
        """same-item evidence path ไม่เปลี่ยน — card ที่ emit อยู่ยัง
        ground claim ของตัวเองผ่าน spec_facts/facts."""
        fe = pr.FieldEvidence(
            subject_id="i:1", fact_key="data_transfer_mbps",
            value=480.0, status="known", source="card")
        assert pr.claim_supported((fe,), "i:1", "480mbps")


# ── r12-correction C: failed candidate must not be promoted ─────────────────

class TestFailedCandidateNotPromoted:
    """live defect (Wattaka Q3): CMC615P proven-fail 10Gbps แต่ยังอยู่ใน
    ctx.products/resp.products → finalizer เติม image+link+CTA. identity
    ที่ fail ต้องอยู่เฉพาะ typed near-miss metadata — ไม่ใช่ answer
    product."""

    def _ctx(self, extra_cards=()):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
                   required_features=("magnetic",))
        hist = _sel_card("i:27639651334", "historical_evidence", "req-0",
                         _CMC_NAME, raw_description=_CMC_DESC,
                         canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((hist, "req-0"),
                         *((c, "req-0") for c in extra_cards))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:27639651334",
                                               "27639651334",
                                               name=_CMC_NAME)]
                             + [_pooled(c.identity,
                                        c.card.get("item_id"),
                                        name=c.card.get("name"))
                                for c in extra_cards]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        return needs, ctx

    def test_failed_historical_not_in_answer_products(self):
        needs, ctx = self._ctx()
        ids = {str(p.get("item_id")) for p in ctx.products}
        assert "27639651334" not in ids, \
            f"proven-fail identity must not be an answer product: {ids}"

    def test_failed_identity_survives_as_near_miss_metadata(self):
        needs, ctx = self._ctx()
        segs = [s for s in (ctx.constraint_segments or ())
                if s.get("need_index") == 0]
        assert segs, "all-fail need must emit typed constraint segment"
        items = segs[0].get("items") or ()
        cmc = [it for it in items
               if "27639651334" in str(it.get("identity") or "")]
        assert cmc, f"failed identity must live in typed metadata: {items}"
        assert "480Mbps" in cmc[0].get("detail", ""), cmc[0]
        assert "ไม่ถึง" in cmc[0].get("detail", ""), cmc[0]

    def test_all_fail_products_empty_and_need_covered(self):
        needs, ctx = self._ctx()
        assert ctx.products == (), ctx.products
        # deterministic verdict covers the need → ไม่ใช่ model task
        assert not [t for t in ctx.task.tasks if t.need_index == 0], \
            "deterministically covered need must not be a model task"
        assert not [u for u in ctx.unanswered_needs
                    if u.need_index == 0], \
            "constraint verdict answers the need — not 'no_evidence'"
        comp = acx.compose_answer(needs=needs, context=ctx,
                                  product_text="")
        text = _render(comp)
        assert "ไม่มีสินค้าที่ผ่านเงื่อนไข" in text
        assert "CMC615P" in text and "480Mbps" in text, text
        assert "สั่งซื้อ" not in text and "http" not in text, \
            "near-miss must not carry purchase link/CTA: " + text

    def test_mixed_pass_fail_keeps_only_passed(self):
        fast = _sel_card("i:8", "slot", "req-0",
                         "CUKTECH FTL999 สายชาร์จ Thunderbolt 40Gbps",
                         raw_description="สายข้อมูลความเร็วสูง 40Gbps "
                                         "รองรับการถ่ายโอน 40Gbps",
                         canonical_roles=["cable"], canonical_type="charger")
        needs, ctx = self._ctx(extra_cards=(fast,))
        ids = {str(p.get("item_id")) for p in ctx.products}
        assert "8" in ids and "27639651334" not in ids, ids

    def test_no_catalog_empty_claim(self):
        """'ไม่มีสินค้าผ่านเงื่อนไข' ≠ 'ร้านไม่มีสินค้า' — segment wording
        ต้องไม่บอกว่า catalog ว่าง"""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(needs=needs, context=ctx,
                                  product_text="")
        text = _render(comp)
        assert "ร้านไม่มีสินค้า" not in text and \
               "ไม่มีสินค้าในร้าน" not in text, text


def _render(comp):
    from shopeechat import answer_context as _a
    parts = []
    for r in sorted(comp.results,
                    key=lambda r: _a._DOMAIN_ORDER.get(r.domain, 9)):
        if r.text:
            parts.append(r.text)
    return "\n".join(parts)


# ── final-acceptance A: current-need type/subtype eligibility ──────────────

class TestCurrentNeedScopeEligibility:
    """finding A (Pingevox Q4): adapter-subtype need มี historical cable
    cards (ATC615/ATC310N/CTL301) เข้า products+links — history/subjects
    channels bypass retrieval type filters; eligibility ต้องเช็ก current
    typed need เหมือน candidate ใหม่ทุกข้อ (generic subtype contract —
    ไม่ใช่ hardcode adapter/cable)."""

    def _adapter_need(self):
        return (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"adapter"}),
            target_refs=("xiaomi 17 ultra",), subject_scope="none"),)

    def _adapter_card(self):
        return _sel_card(
            "i:47067", "relation_target", "req-0",
            "CUKTECH AD653T Set SAMSUNG Adapter 65W หัวชาร์จ",
            canonical_roles=["adapter"], canonical_type="charger")

    def _cable_hist(self):
        return _sel_card(
            "i:29045", "historical_evidence", "ch:history",
            "CUKTECH ATC615 6A 100W USB A to C สายชาร์จ",
            canonical_roles=["cable"], canonical_type="charger")

    def _compile_pair(self, *entries, need=None, message="หัวชาร์จละ"):
        sel = _selection(*entries)
        return _compile(
            need or self._adapter_need(), sel,
            _pool(eligible=[_pooled(e[0].identity, e[0].card["item_id"])
                            for e in entries]),
            (_req("req-0", subs=("adapter",)),
             _req("ch:history", source="history")),
            _profile(message))

    def test_historical_cable_not_adapter_candidate(self):
        ctx = self._compile_pair((self._adapter_card(), "req-0"),
                                 (self._cable_hist(), "ch:history"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "29045" not in ids, \
            f"cable historical card bypasses retrieval subtype filter — " \
            f"must fail current-need eligibility: {ids}"

    def test_matching_subtype_survives(self):
        ctx = self._compile_pair((self._adapter_card(), "req-0"),
                                 (self._cable_hist(), "ch:history"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "47067" in ids, ids

    def test_unknown_subtype_not_presented_as_adapter(self):
        mystery = _sel_card("i:9999", "relation_target", "req-0",
                            "Mystery Charging Head 65W")
        ctx = self._compile_pair((mystery, "req-0"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "9999" not in ids, \
            "unknown-subtype card must not be asserted as adapter"

    def test_scope_gate_is_generic_symmetric(self):
        """cable-subtype need + adapter-role historical → ออกเช่นกัน —
        กฎเดียวกันทุก subtype ไม่ใช่ adapter-specific."""
        cable_need = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}), subject_scope="none"),)
        adapter_hist = _sel_card(
            "i:47067", "historical_evidence", "ch:history",
            "CUKTECH AD653T Set SAMSUNG Adapter 65W",
            canonical_roles=["adapter"], canonical_type="charger")
        cable = _sel_card(
            "i:11", "relation_target", "req-0",
            "CUKTECH CMC615P สายชาร์จ",
            canonical_roles=["cable"], canonical_type="charger")
        ctx = self._compile_pair((cable, "req-0"),
                                 (adapter_hist, "ch:history"),
                                 need=cable_need)
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "47067" not in ids and "11" in ids, ids

    def test_subject_refs_identity_authority_exempt(self):
        """exact-item identity pinned ใน need.subject_refs = คำถามตรง item
        นั้น — identity authority เหนือ subtype metadata เสมอ."""
        pinned = _sel_card("i:55", "subject", "ch:subjects",
                           "CUKTECH CTL301 สายชาร์จ Lightning",
                           canonical_roles=["cable"],
                           canonical_type="charger")
        need = (TurnNeed(
            kind="product", operation="describe",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"adapter"}),
            subject_refs=("55",)),)
        sel = _selection((pinned, "ch:subjects"))
        ctx = _compile(need, sel, _pool(eligible=[_pooled("i:55", "55")]),
                       (_req("ch:subjects", source="subjects"),),
                       _profile("หัวชาร์จนี้"))
        assert "55" in [str(p.get("item_id")) for p in ctx.products]

    def test_scoped_out_card_gets_no_verdict_or_segment(self):
        """cable ที่ตก scope ของ adapter need = ไม่ใช่ candidate → ไม่มี
        verdict/segment บน need นี้ (ไม่ใช่เพียงแค่ตก products)."""
        ctx = self._compile_pair((self._adapter_card(), "req-0"),
                                 (self._cable_hist(), "ch:history"))
        for v in (ctx.compat_verdicts or ()):
            assert "29045" not in str(v.subject_id), \
                "out-of-scope candidate must not earn a verdict"


# ── final-acceptance B: decided-incompatible leaves products (all roles) ───

class TestIncompatibleLeavesProducts:
    """finding B: decided-incompatible card ต้องออกจาก answer products
    ทุก role (pattern เดียวกับ constraint-failed — verdict segment เป็น
    typed narrative เดียวที่พูดถึงมัน; ห้าม link/image/CTA)."""

    def _spec_ev(self):
        return {"kind": "device_spec", "target": "xiaomi 17 ultra",
                "data": {"connector": ["usb-c"], "wired_w": 90,
                         "source": "spec-db"}}

    def _lightning_card(self, role, rid="req-0", iid="9"):
        return _sel_card(
            f"i:{iid}", role, rid,
            "CUKTECH CTL301 USB-C to Lightning สายชาร์จ iPhone MFi 480Mbps",
            raw_description="Lightning cable for iPhone only")

    def _compat_needs(self):
        return (TurnNeed(kind="compat", operation="compat",
                         target_refs=("xiaomi 17 ultra",)),)

    def _product_needs(self):
        return (TurnNeed(kind="product", operation="recommend",
                         product_types=frozenset({"charger"}),
                         target_refs=("xiaomi 17 ultra",)),)

    def _req_t(self):
        return _req("req-0", target="xiaomi 17 ultra",
                    compat="connector_required")

    def test_compat_need_incompatible_roles_out_of_products(self):
        for role in ("subject", "historical_evidence", "relation_target"):
            card = self._lightning_card(role)
            sel = _selection((card, "req-0"))
            ctx = _compile(
                self._compat_needs(), sel,
                _pool(eligible=[_pooled("i:9", "9")],
                      supporting=[self._spec_ev()]),
                (self._req_t(),), _profile("ใช้กับ xiaomi ได้ไหม"))
            ids = [str(p.get("item_id")) for p in ctx.products]
            assert "9" not in ids, \
                f"decided-incompatible role={role} must leave products: {ids}"

    def test_product_need_incompatible_drops_all_roles(self):
        for role in ("subject", "historical_evidence", "relation_target"):
            card = self._lightning_card(role)
            sel = _selection((card, "req-0"))
            ctx = _compile(
                self._product_needs(), sel,
                _pool(eligible=[_pooled("i:9", "9")],
                      supporting=[self._spec_ev()]),
                (self._req_t(),), _profile("หัวชาร์จละ"))
            ids = [str(p.get("item_id")) for p in ctx.products]
            assert "9" not in ids, \
                f"product-need incompatible role={role} leaked: {ids}"

    def test_verdict_segment_preserves_identity_target_reason(self):
        card = self._lightning_card("relation_target")
        sel = _selection((card, "req-0"))
        needs = self._compat_needs()
        ctx = _compile(
            needs, sel,
            _pool(eligible=[_pooled("i:9", "9")],
                  supporting=[self._spec_ev()]),
            (self._req_t(),), _profile("ใช้กับ xiaomi ได้ไหม"))
        comp = acx.compose_answer(needs=needs, context=ctx,
                                  product_text="")
        segs = [r for r in comp.results if r.domain == "compat"]
        assert segs, "decided verdict must render deterministically"
        text = segs[0].text
        assert "CTL301" in text and "ไม่" in text, text
        assert "xiaomi" in text.lower(), text

    def test_mixed_keeps_only_compatible_product(self):
        good = _sel_card(
            "i:7", "relation_target", "req-0",
            "CUKTECH ATC615 USB-C to USB-C สายชาร์จ 100W",
            raw_description="USB-C to USB-C cable 100W")
        bad = self._lightning_card("relation_target", iid="9")
        sel = _selection((good, "req-0"), (bad, "req-0"))
        needs = self._compat_needs()
        ctx = _compile(
            needs, sel,
            _pool(eligible=[_pooled("i:7", "7"), _pooled("i:9", "9")],
                  supporting=[self._spec_ev()]),
            (self._req_t(),), _profile("ใช้กับ xiaomi ได้ไหม"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert "9" not in ids and "7" in ids, ids


# ── final-acceptance C: structured composition provenance ──────────────────

class TestCompositionProvenance:
    """finding C: measured/spec claims ต้องอาศัย typed provenance
    (DomainResult.origin + composition segment marker) ไม่ใช่การ infer
    identity จาก generated prose (clause scan / model-token / item digits
    / display name) — path นั้นถูกลบ."""

    def _ctx_all_fail(self):
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            required_features=("magnetic",)),)
        req = _req(subs=("cable",),
                   spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
                   required_features=("magnetic",))
        hist = _sel_card("i:27639651334", "historical_evidence", "req-0",
                         _CMC_NAME, raw_description=_CMC_DESC,
                         canonical_roles=["cable"],
                         canonical_type="charger")
        sel = _selection((hist, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:27639651334",
                                               "27639651334",
                                               name=_CMC_NAME)]),
                       (req,), _profile("มีรุ่น 10Gbps ขึ้นไป"))
        return needs, ctx

    def test_domain_result_carries_provenance(self):
        needs, ctx = self._ctx_all_fail()
        comp = acx.compose_answer(needs=needs, context=ctx,
                                  product_text="")
        seg = next(r for r in comp.results if r.domain == "constraint")
        assert seg.origin == "deterministic", \
            "typed verdict segment must declare deterministic origin"
        assert seg.subject_ids, \
            "segment must carry owning identities — not prose-inferred"
        assert any("27639651334" in s for s in seg.subject_ids)

    def test_model_segment_origin_is_model(self):
        needs = (TurnNeed(kind="product", operation="recommend",
                          product_types=frozenset({"charger"}),
                          subject_scope="none"),)
        req = _req()
        ok = _sel_card("i:1", "slot", "req-0", "CUKTECH C1 สายชาร์จ",
                       canonical_roles=["cable"], canonical_type="charger")
        sel = _selection((ok, "req-0"))
        ctx = _compile(needs, sel, _pool(eligible=[_pooled("i:1", "1")]),
                       (req,), _profile("สายชาร์จ"))
        comp = acx.compose_answer(needs=needs, context=ctx,
                                  product_text="ตอบโดย model")
        prod = next(r for r in comp.results if r.domain == "product")
        assert prod.origin == "model"

    def _enf(self, answer, rd):
        from shopeechat import guards as _g
        resp = _NS(answer=answer, answer_segments=None,
                   handoff_to_admin=False, source="product_info",
                   routing_decision=rd, products=[])
        req = _NS(message="มีรุ่นไหม", history=[])
        return _g.enforce(resp, req)

    def _marker(self, seg_text):
        return {"domains": ["constraint"],
                "unanswered": [],
                "segments": [
                    {"domain": "constraint", "origin": "deterministic",
                     "text": seg_text, "need_indices": [0],
                     "subject_ids": ["i:27639651334"]}]}

    _SEG = ("ยังไม่มีสินค้าที่ผ่านเงื่อนไขครบทุกข้อค่ะ\n"
            "- CUKTECH CMC615P 6A 240W: ผ่าน สาย/หัวแม่เหล็ก แต่ "
            "ความเร็วถ่ายโอนข้อมูล 480Mbps ไม่ถึง 10Gbps ที่ต้องการ")

    def test_deterministic_segment_exempt_by_provenance(self):
        """'6A'/'240W'/'480Mbps'/'CMC615P' อยู่ได้เพราะ typed provenance
        (marker origin + exact text) — ไม่ใช่เพราะ regex พบชื่อสินค้า."""
        rd = {"composition": self._marker(self._SEG), "products": []}
        resp = self._enf(self._SEG, rd)
        assert "480Mbps" in resp.answer and "6A" in resp.answer, \
            "typed deterministic segment must survive: " + resp.answer
        assert "CMC615P" in resp.answer, resp.answer

    def test_mutated_segment_fails_closed(self):
        """เปลี่ยน prose ของ segment (ชื่อ/ค่าต่างจาก marker) → exact-text
        provenance ไม่ตรง → ไม่มี exemption → ungrounded tokens ถูก rewrite."""
        rd = {"composition": self._marker(self._SEG), "products": []}
        mutated = self._SEG.replace("CMC615P", "ZZZ999X")
        resp = self._enf(mutated, rd)
        assert resp.routing_decision.get("guard_rewritten") or \
               "480Mbps" not in resp.answer, \
            "mutated deterministic text must not keep typed exemption"

    def test_malformed_marker_fails_closed(self):
        rd = {"composition": {"domains": ["constraint"],
                              "segments": "not-a-list"}}
        resp = self._enf(self._SEG, rd)
        assert resp.routing_decision.get("guard_rewritten") or \
               resp.routing_decision.get("composition_marker_invalid"), \
            "malformed marker must not grant exemption"

    def test_no_marker_no_exemption(self):
        """segment text เดียวกันแต่ไม่มี composition marker → claims ต้อง
        ผ่าน grounding ปกติ (ไม่มี typed provenance → rewrite)."""
        resp = self._enf(self._SEG, {"products": []})
        assert resp.routing_decision.get("guard_rewritten") or \
               "480Mbps" not in resp.answer

    def test_measured_facts_no_prose_identity_inference(self):
        """measured evidence ไม่มี ownership path ผ่าน prose scan —
        '_spec_fact_grounded' ต้องไม่ consume spec_measured/clause เลย:
        clause ที่ name identity ก็ต้องไม่ ground ผ่าน measured channel."""
        from shopeechat import guards
        needs, ctx = self._ctx_all_fail()
        rd = {"spec_measured": list(ctx.spec_measured_facts or ()),
              "subject_ids": []}
        resp = _NS(answer="", products=[], routing_decision=rd)
        own = "- CUKTECH CMC615P 6A 240W: ความเร็วถ่ายโอน 480Mbps"
        assert not guards._spec_fact_grounded(resp, "480mbps"), \
            "measured channel must not ground model prose — " \
            "deterministic segments carry provenance via marker only"

    def test_similar_model_tokens_share_no_evidence(self):
        """สองสินค้าที่ model token คล้ายกัน (CMC615P / CMC615X) ต้องไม่
        share measured evidence — ownership ผูก identity เท่านั้น."""
        needs, ctx = self._ctx_all_fail()
        facts = ctx.spec_measured_facts or ()
        cmc = [f for f in facts
               if f.get("identity") == "i:27639651334"]
        assert cmc, facts
        assert all(f.get("identity") == "i:27639651334"
                   for f in cmc), "facts keyed by identity — no token fuzz"


# ── final-acceptance r2 A: closed composition-segment schema ───────────────

class TestMarkerClosedSchema:
    """finding A: enforce marker validation must require the closed segment
    schema — malformed provenance grants ZERO deterministic exemption and
    sets composition_marker_invalid (fail closed, no prose inference)."""

    _SEG = ("ยังไม่มีสินค้าที่ผ่านเงื่อนไขครบทุกข้อค่ะ\n"
            "- CUKTECH CMC615P 6A 240W: ผ่าน สาย/หัวแม่เหล็ก แต่ "
            "ความเร็วถ่ายโอนข้อมูล 480Mbps ไม่ถึง 10Gbps ที่ต้องการ")

    def _enf(self, answer, rd):
        from shopeechat import guards as _g
        resp = _NS(answer=answer, answer_segments=None,
                   handoff_to_admin=False, source="product_info",
                   routing_decision=rd, products=[])
        req = _NS(message="มีรุ่นไหม", history=[])
        return _g.enforce(resp, req)

    def _marker(self, **seg_over):
        seg = {"domain": "constraint", "origin": "deterministic",
               "text": self._SEG, "need_indices": [0],
               "subject_ids": ["i:27639651334"]}
        seg.update(seg_over)
        return {"domains": ["constraint"],
                "unanswered": [], "segments": [seg]}

    def _assert_invalid(self, rd):
        resp = self._enf(self._SEG,
                         {"composition": rd, "products": []})
        assert resp.routing_decision.get("composition_marker_invalid"), \
            f"malformed segment must set marker_invalid: {rd}"
        assert "480Mbps" not in resp.answer, \
            "malformed marker granted deterministic exemption"

    def test_missing_domain(self):
        seg = {"origin": "deterministic", "text": self._SEG,
               "need_indices": [0], "subject_ids": ["i:27639651334"]}
        self._assert_invalid({"domains": ["constraint"],
                              "segments": [seg]})

    def test_missing_need_indices(self):
        seg = {"domain": "constraint", "origin": "deterministic",
               "text": self._SEG, "subject_ids": ["i:27639651334"]}
        self._assert_invalid({"domains": ["constraint"],
                              "segments": [seg]})

    def test_missing_subject_ids(self):
        seg = {"domain": "constraint", "origin": "deterministic",
               "text": self._SEG, "need_indices": [0]}
        self._assert_invalid({"domains": ["constraint"],
                              "segments": [seg]})

    def test_need_indices_string(self):
        self._assert_invalid(self._marker(need_indices="0"))

    def test_need_indices_bool(self):
        self._assert_invalid(self._marker(need_indices=[True]))

    def test_need_indices_negative(self):
        self._assert_invalid(self._marker(need_indices=[-1]))

    def test_subject_ids_string(self):
        self._assert_invalid(self._marker(subject_ids="i:1"))

    def test_subject_ids_empty_string(self):
        self._assert_invalid(self._marker(subject_ids=[""]))

    def test_unknown_domain(self):
        self._assert_invalid(
            {"domains": ["bogus"],
             "segments": [{"domain": "bogus", "origin": "deterministic",
                           "text": self._SEG, "need_indices": [0],
                           "subject_ids": ["i:1"]}]})

    def test_domain_order_mismatch(self):
        rd = self._marker()
        rd["domains"] = ["product"]   # seg.domain=constraint ≠ domains[0]
        self._assert_invalid(rd)

    def test_domain_list_len_mismatch(self):
        rd = self._marker()
        rd["domains"] = ["constraint", "product"]
        self._assert_invalid(rd)

    def test_domains_not_list(self):
        rd = self._marker()
        rd["domains"] = "constraint"
        self._assert_invalid(rd)

    def test_det_compat_missing_owner_identity(self):
        """compat/constraint deterministic segments ต้อง retain typed
        owner identities — empty subject_ids on a deterministic verdict
        segment = malformed (policy/claim may legitimately be empty)."""
        seg = {"domain": "compat", "origin": "deterministic",
               "text": self._SEG, "need_indices": [0], "subject_ids": []}
        self._assert_invalid({"domains": ["compat"], "segments": [seg]})

    def test_model_origin_segment_passes_schema_but_validated(self):
        """model-origin segment = schema-valid → no marker_invalid —
        but its ungrounded tokens still pass normal evidence checks."""
        seg = {"domain": "product", "origin": "model",
               "text": self._SEG, "need_indices": [0], "subject_ids": []}
        rd = {"domains": ["product"], "segments": [seg]}
        resp = self._enf(self._SEG, {"composition": rd, "products": []})
        assert not resp.routing_decision.get("composition_marker_invalid")
        assert "480Mbps" not in resp.answer, \
            "model segment must keep ordinary evidence validation"

    def test_valid_marker_byte_identical(self):
        """valid composer-produced marker → exemption intact → answer
        byte-identical (no rewrite, no marker_invalid flag)."""
        rd = {"composition": self._marker(), "products": []}
        resp = self._enf(self._SEG, rd)
        assert resp.answer == self._SEG
        assert not resp.routing_decision.get("composition_marker_invalid")
        assert not resp.routing_decision.get("guard_rewritten")


# ── final-acceptance r2 B: eligibility before constraint/verdict emission ─

class TestScopeBeforeConstraintEmission:
    """finding B: a candidate that fails current-need type/subtype
    eligibility contributes NOTHING — no product/note/verdict/segment.
    Scope gate runs before constraint eval; the CMC615P 'wireless'
    canonical_roles is an upstream canonicalization defect fixed at the
    detector owner (magnetic cable ≠ wireless)."""

    def _adapter_need(self):
        return (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"adapter"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            subject_scope="none"),)

    def _cable_need(self):
        return (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"cable"}),
            spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
            subject_scope="none"),)

    def _hist(self, iid, name, roles, desc=""):
        return _sel_card(f"i:{iid}", "historical_evidence", "ch:history",
                         name, canonical_roles=list(roles),
                         canonical_type="charger",
                         raw_description=desc)

    def _compile_one(self, sc, need, msg="มีรุ่นไหม"):
        sel = _selection((sc, "ch:history"))
        return _compile(
            need, sel,
            _pool(eligible=[_pooled(sc.identity, sc.card["item_id"],
                                    name=sc.card["name"])]),
            (_req("ch:history", source="history"),),
            _profile(msg))

    def _leak(self, ctx, iid):
        blobs = [str(n) for n in (ctx.constraint_notes or ())]
        blobs += [str(s) for s in (ctx.constraint_segments or ())]
        blobs += [str(v) for v in (ctx.compat_verdicts or ())]
        return iid in "".join(blobs) or any(
            iid in str(p.get("item_id")) for p in ctx.products)

    def test_out_of_scope_card_zero_contribution(self):
        sc = self._hist("27639651334", _CMC_NAME, ("cable",),
                        desc=_CMC_DESC)
        ctx = self._compile_one(sc, self._adapter_need())
        assert not self._leak(ctx, "27639651334"), (
            f"out-of-scope cable must contribute nothing to adapter need "
            f"— products={ctx.products} notes={ctx.constraint_notes} "
            f"segments={ctx.constraint_segments}")

    def test_symmetric_cable_need_adapter_zero(self):
        sc = self._hist("47067", "CUKTECH AD653T หัวชาร์จ 65W",
                        ("adapter",), desc=_CMC_DESC)
        ctx = self._compile_one(sc, self._cable_need())
        assert not self._leak(ctx, "47067"), ctx.constraint_notes

    def test_unknown_subtype_no_notes_or_segments(self):
        sc = self._hist("9999", "Mystery Charging 65W", (),
                        desc=_CMC_DESC)
        ctx = self._compile_one(sc, self._cable_need())
        assert not self._leak(ctx, "9999")

    def test_cmc_real_canonicalization_is_cable(self):
        """exercise the REAL canonicalization owner — a magnetic USB-C
        cable must canonicalize as cable, not wireless."""
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card(dict(_cmc_card()),
                                        source="legacy")
        roles = set(card.get("canonical_roles") or ())
        assert "cable" in roles and "wireless" not in roles, \
            f"magnetic cable mis-canonicalized: {roles}"

    def test_real_wireless_charger_stays_wireless(self):
        from shopeechat import retrieval_policy as _rpol
        for name in ("CUKTECH แท่นชาร์จไร้สาย magnetic 15W iPhone",
                     "Anker MagSafe Wireless Charger Qi 15W",
                     "CUKTECH ชาร์จแม่เหล็กไร้สาย 15W"):
            card = _rpol.make_evidence_card(
                {"item_id": "1", "name": name, "model_codes": [],
                 "customer_visibility": "visible"}, source="legacy")
            roles = set(card.get("canonical_roles") or ())
            assert "wireless" in roles, f"{name} → {roles}"

    def test_in_car_cable_is_cable_not_car_charger(self):
        """'สายชาร์จในรถ' = in-car cable — the สาย-phrase must not
        classify the product as car_charger (same defect family)."""
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card(
            {"item_id": "2", "name": "สายชาร์จในรถ USB-C 3A CUKTECH",
             "model_codes": [], "customer_visibility": "visible"},
            source="legacy")
        roles = set(card.get("canonical_roles") or ())
        assert "cable" in roles and "car_charger" not in roles, roles

    def test_cmc_passes_cable_scope_earns_near_miss(self):
        """Wattaka Q3 contract: CMC615P appears in constraint segment
        ONLY after passing cable eligibility — via REAL canonicalize
        (no manual canonical_roles stamping)."""
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card(dict(_cmc_card()),
                                        source="legacy")
        sc = rsel.SelectedCandidate(
            role="historical_evidence", request_id="ch:history",
            slot_id="s", relation_id=None,
            identity="i:27639651334", score=1.0,
            constraint_hits=(), reason="ok", card=card)
        ctx = self._compile_one(
            sc, self._cable_need(), msg="มีรุ่น 10Gbps สายแม่เหล็กไหม")
        assert not ctx.products, ctx.products
        segs = ctx.constraint_segments or ()
        assert segs and any(
            "27639651334" in str(it.get("identity"))
            for it in segs[0].get("items", ())), segs


# ── final-acceptance r2 C: deterministic cards + markup-free mutation ────

class TestDeterministicProductCards:
    """finding C: product cards/links/images are deterministic typed
    rendering (composition owner) — never inside free-form claim
    mutation; model prose validated while structurally a model result;
    guard rewrites can never corrupt card markup."""

    def _products(self):
        return ({"item_id": "47067",
                 "name": "CUKTECH AD653T หัวชาร์จ 65W",
                 "image_url": "https://cf.shopee.co.th/img1",
                 "short_link": "https://s.shopee.co.th/l1",
                 "need_indices": (0,)},
                {"item_id": "57617",
                 "name": "CUKTECH AD652S หัวชาร์จ 33W",
                 "image_url": "https://cf.shopee.co.th/img2",
                 "short_link": "https://s.shopee.co.th/l2",
                 "need_indices": (0,)},)

    def _ctx(self):
        needs = (TurnNeed(kind="product", operation="recommend",
                          product_types=frozenset({"charger"}),
                          subtypes=frozenset({"adapter"}),
                          subject_scope="none"),)
        req = _req("req-0", subs=("adapter",))
        c1 = _sel_card("i:47067", "relation_target", "req-0",
                       "CUKTECH AD653T หัวชาร์จ 65W",
                       canonical_roles=["adapter"],
                       canonical_type="charger",
                       image_url="https://cf.shopee.co.th/img1",
                       short_link="https://s.shopee.co.th/l1")
        c2 = _sel_card("i:57617", "relation_target", "req-0",
                       "CUKTECH AD652S หัวชาร์จ 33W",
                       canonical_roles=["adapter"],
                       canonical_type="charger",
                       image_url="https://cf.shopee.co.th/img2",
                       short_link="https://s.shopee.co.th/l2")
        sel = _selection((c1, "req-0"), (c2, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:47067", "47067"),
                                       _pooled("i:57617", "57617")]),
                       (req,), _profile("หัวชาร์จละ"))
        return needs, ctx

    def _enf(self, answer, rd, products=None):
        from shopeechat import guards as _g
        resp = _NS(answer=answer, answer_segments=None,
                   handoff_to_admin=False, source="product_info",
                   routing_decision=rd, products=list(products or []))
        req = _NS(message="มีรุ่นไหม", history=[])
        return _g.enforce(resp, req)

    def _marker_of(self, comp):
        return {"domains": [r.domain for r in comp.results],
                "unanswered": [],
                "segments": [
                    {"domain": r.domain, "origin": r.origin,
                     "text": r.text, "need_indices": list(r.need_indices),
                     "subject_ids": [str(x) for x in (r.subject_ids or ())]}
                    for r in comp.results]}

    def test_compose_emits_deterministic_product_card_segments(self):
        """product cards = deterministic DomainResults carrying card
        fields (name/image/short_link) + owning identity — model prose
        is not the card owner."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="มีหัวชาร์จแนะนำค่ะ")
        cards = [r for r in comp.results
                 if r.domain == "product" and r.origin == "deterministic"]
        assert cards, "no deterministic product-card result emitted"
        for c in cards:
            assert c.subject_ids, "card segment must carry item identity"
            assert c.text, "card segment must carry rendered card text"
        joined = "\n".join(c.text for c in cards)
        assert "cf.shopee.co.th/img1" in joined
        assert "s.shopee.co.th/l1" in joined

    def test_det_card_byte_identical_through_enforce(self):
        """grounded card markup inside a deterministic segment survives
        enforcement byte-identically (image+link never mutated)."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="มีหัวชาร์จแนะนำค่ะ")
        card_seg = next(r for r in comp.results
                        if r.domain == "product"
                        and r.origin == "deterministic")
        answer = "มีหัวชาร์จแนะนำค่ะ\n\n" + card_seg.text
        rd = {"composition": self._marker_of(comp), "products": []}
        resp = self._enf(answer, rd)
        assert card_seg.text in resp.answer, \
            "deterministic card must survive byte-identical: " + resp.answer

    def test_unsupported_claim_replaced_card_untouched(self):
        """ungrounded model claim → replaced without altering the
        adjacent deterministic card/link/image."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="หัวชาร์จ XKZ999 รุ่นใหม่ค่ะ")
        joined = "\n\n".join(r.text for r in comp.results if r.text)
        rd = {"composition": self._marker_of(comp), "products": []}
        resp = self._enf(joined, rd)
        cards = [r.text for r in comp.results
                 if r.domain == "product" and r.origin == "deterministic"]
        for ctext in cards:
            assert ctext in resp.answer, \
                "guard rewrite altered adjacent card: " + resp.answer
        assert "XKZ999" not in resp.answer or \
            resp.routing_decision.get("guard_rewritten"), resp.answer

    def test_no_unmatched_markdown_or_orphan_particle(self):
        """after enforcement: balanced **, no orphan Thai-particle
        segments, no defer inside a card."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="มีหัวชาร์จ XKZ999 สเปค 500W ค่ะ")
        joined = "\n\n".join(r.text for r in comp.results if r.text)
        rd = {"composition": self._marker_of(comp), "products": []}
        resp = self._enf(joined, rd)
        assert resp.answer.count("**") % 2 == 0, \
            "unmatched bold marker: " + resp.answer
        segs = [s for s in (resp.answer_segments or [])
                if s.strip() in ("ค่ะ", "คะ", "นะคะ", "ครับ")]
        assert not segs, f"orphan particle segment: {segs}"
        assert "![[" not in resp.answer

    def test_grounded_speed_answer_keeps_value_no_defer(self):
        """W-Q2 contract: grounded 480Mbps answer + deterministic card —
        no contradictory defer inside/adjacent to the card."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="มีหัวชาร์จแนะนำค่ะ")
        joined = "\n\n".join(r.text for r in comp.results if r.text)
        rd = {"composition": self._marker_of(comp), "products": []}
        resp = self._enf(joined, rd)
        assert "แอดมินตรวจสอบ" not in resp.answer, resp.answer

    def test_model_emitted_markup_normalized_at_compose(self):
        """model output with embedded markdown image/link gets
        normalized at composition — markup is not the model's channel."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="แนะนำค่ะ ||| **X** ![i](https://x/y) "
                         "[สั่งซื้อ](https://z/w)")
        prod = next(r for r in comp.results
                    if r.domain == "product" and r.origin == "model")
        assert "![" not in prod.text and "](" not in prod.text, prod.text

    def test_repeated_enforcement_byte_identical(self):
        """idempotent — enforcing an enforced answer changes nothing."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="มีหัวชาร์จ XKZ999 ค่ะ")
        joined = "\n\n".join(r.text for r in comp.results if r.text)
        rd = {"composition": self._marker_of(comp), "products": []}
        once = self._enf(joined, dict(rd))
        twice = self._enf(once.answer, dict(once.routing_decision))
        assert twice.answer == once.answer, \
            f"non-idempotent enforcement: {once.answer!r} → {twice.answer!r}"

    def test_bold_emphasis_in_model_prose_cannot_unbalance(self):
        """live repro (P-Q3 after10): model pitch `**name … -2Y**` +
        ungrounded `-2Y` tail → clause splice ate the `**` closer →
        unmatched bold. markup (incl. `**`) is not the model's channel —
        compose normalization strips it before mutation surface."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text=(
                "มีสายชาร์จแนะนำค่ะ ||| "
                "**CUKTECH ATC615 6A 100W สายชาร์จ ยาว 1.5 ม. -2Y** "
                "เหมาะกับใช้งานทั่วไปค่ะ"))
        prod = next(r for r in comp.results
                    if r.domain == "product" and r.origin == "model")
        assert "**" not in prod.text, \
            "model product result must not carry emphasis markup: " + prod.text
        joined = "\n\n".join(r.text for r in comp.results if r.text)
        rd = {"composition": self._marker_of(comp), "products": []}
        resp = self._enf(joined, rd)
        assert resp.answer.count("**") % 2 == 0, \
            "unmatched bold marker after enforcement: " + resp.answer


# ── r3 A: mixed-policy path must consume the shared closed-schema marker ────

class TestMixedPolicyMarkerValidation:
    """finding A (r3): `enforce` enters `_pdec_active` before the
    closed-schema segment validator and returns on a shallow marker
    check — a malformed `segments` in a mixed policy composition
    currently still grants the early return, preserving ungrounded
    claims. ONE validator must execute before both policy and
    non-policy branches; both paths consume the same result."""

    _CANON = "เคสนี้ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืนนะคะ"
    _PSEG = {"domain": "policy", "origin": "deterministic",
             "text": _CANON, "need_indices": [1], "subject_ids": []}
    _PROD = {"domain": "product", "origin": "model",
             "text": "สินค้ารองรับ 999W ค่ะ", "need_indices": [0],
             "subject_ids": []}
    _ANS = "สินค้ารองรับ 999W ค่ะ ||| " + _CANON

    def _enf(self, answer, rd):
        from shopeechat import guards as _g
        rd = dict(rd)
        rd["policy_decision"] = {"policy_type": "return_exchange",
                                 "outcome": "ineligible"}
        resp = _NS(answer=answer, answer_segments=None,
                   handoff_to_admin=False, source="product_info",
                   routing_decision=rd, products=[])
        req = _NS(message="คืนได้ไหม", history=[])
        return _g.enforce(resp, req)

    def _comp(self, **kw):
        c = {"domains": ["product", "policy"], "unanswered": [],
             "policy_text": self._CANON,
             "segments": [dict(self._PROD), dict(self._PSEG)]}
        c.update(kw)
        return {"composition": c, "products": []}

    def _assert_fail_closed(self, comp):
        resp = self._enf(self._ANS, comp)
        assert resp.routing_decision.get("composition_marker_invalid"), \
            "malformed mixed-policy marker must set marker_invalid"
        assert resp.answer == self._CANON, \
            f"mixed policy must fail closed on canonical outcome: {resp.answer!r}"
        assert "999W" not in resp.answer

    def test_segments_string_malformed(self):
        self._assert_fail_closed(self._comp(segments="malformed"))

    def test_segment_missing_fields(self):
        seg = {"origin": "deterministic", "text": self._CANON}
        self._assert_fail_closed(
            self._comp(segments=[dict(self._PROD), seg]))

    def test_domain_order_mismatch(self):
        self._assert_fail_closed(
            self._comp(domains=["policy", "product"]))

    def test_need_indices_invalid(self):
        bad = dict(self._PSEG, need_indices="1")
        self._assert_fail_closed(
            self._comp(segments=[dict(self._PROD), bad]))

    def test_malformed_cannot_preserve_999w(self):
        resp = self._enf(self._ANS, self._comp(segments="malformed"))
        assert "999W" not in resp.answer, resp.answer

    def test_valid_mixed_byte_identical(self):
        """valid composer-produced mixed marker → return unchanged —
        the shared validator must not break the legitimate path."""
        resp = self._enf(self._ANS, self._comp())
        assert resp.answer == self._ANS, resp.answer
        assert not resp.routing_decision.get("composition_marker_invalid")

    def test_pure_policy_no_composition_unchanged(self):
        """flag-OFF pure policy (no composition marker) → deterministic
        wholesale render — existing behavior preserved."""
        rd = {"policy_decision": {"policy_type": "return_exchange",
                                  "outcome": "ineligible"},
              "products": []}
        resp = _NS(answer="อะไรก็ได้ค่ะ", answer_segments=None,
                   handoff_to_admin=False, source="product_info",
                   routing_decision=rd, products=[])
        from shopeechat import guards as _g
        out = _g.enforce(resp, _NS(message="คืนได้ไหม", history=[]))
        assert out.answer == self._CANON
        assert out.routing_decision.get("guard_rewritten") == "policy_decision"


# ── r3 B: structured subtype ownership — no text-position helper ───────────

class TestStructuredSubtypeOwnership:
    """finding B (r3): delete `_kw_outside_cable_phrase`; canonical
    subtype comes from structured unit evidence + existing-table
    precedence inside the existing owners — a cable head-noun beats
    charger-form keywords (they are cable modifiers); structured
    product_type/components/cable_subtype outrank stale name-derived
    charger_subtype."""

    def test_kw_helper_deleted(self):
        """mechanism contract — the text-position helper must not exist."""
        from shopeechat import product_store as _ps
        assert not hasattr(_ps, "_kw_outside_cable_phrase")

    def test_cmc_unit_card_roles_cable_only(self):
        """real CMC615P unit shape (sellable_units fields verbatim):
        product_type=cable + components=[cable] + cable_subtype=usb-c +
        STALE charger_subtype=wireless → canonical_roles == {cable}.
        stale name-derived subtype must not inject a phantom role."""
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card({
            "item_id": "27639651334", "name": _CMC_NAME,
            "product_type": "cable", "components": ["cable"],
            "cable_subtype": "usb-c", "charger_subtype": "wireless",
            "model_codes": [], "customer_visibility": "visible"},
            source="units")
        roles = set(card.get("canonical_roles") or ())
        assert roles == {"cable"}, roles

    def test_incar_cable_unit_card_roles_cable_only(self):
        """same defect family — ที่ชาร์จในรถ 2in1 cable unit:
        product_type=cable + stale charger_subtype=car_charger →
        roles == {cable} (structured type authority wins)."""
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card({
            "item_id": "w1", "name": "CUKTECH WCJ153 ที่ชาร์จในรถยนต์ "
                                     "2 in 1 สายชาร์จ USB-C ในตัว",
            "product_type": "cable", "components": ["cable"],
            "cable_subtype": "usb-c", "charger_subtype": "car_charger",
            "model_codes": [], "customer_visibility": "visible"},
            source="units")
        roles = set(card.get("canonical_roles") or ())
        assert roles == {"cable"}, roles

    def test_real_wireless_unit_keeps_wireless_role(self):
        """real wireless pad unit: product_type=charger +
        components=[adapter] + charger_subtype=wireless →
        {adapter, wireless} — the form role survives on charger-type
        products (structured contract)."""
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card({
            "item_id": "w2", "name": "ZMI B508 แท่นชาร์จไร้สาย 20W",
            "product_type": "charger", "components": ["adapter"],
            "charger_subtype": "wireless",
            "model_codes": [], "customer_visibility": "visible"},
            source="units")
        roles = set(card.get("canonical_roles") or ())
        assert "wireless" in roles and "adapter" in roles, roles

    def test_real_car_charger_unit_keeps_car_role(self):
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card({
            "item_id": "w3", "name": "Lydsto ปั๊มลม 12V (Car Charger)",
            "product_type": "charger", "components": ["adapter"],
            "charger_subtype": "car_charger",
            "model_codes": [], "customer_visibility": "visible"},
            source="units")
        roles = set(card.get("canonical_roles") or ())
        assert "car_charger" in roles, roles

    def test_bundle_components_not_pure_adapter(self):
        """bundle unit components=[adapter,cable,powerbank] must keep
        every structured role — not collapse to a pure adapter."""
        from shopeechat import retrieval_policy as _rpol
        card = _rpol.make_evidence_card({
            "item_id": "b1", "name": "ชุดชาร์จ 3in1 หัวชาร์จ+สาย+พาวเวอร์แบงค์",
            "product_type": "charger",
            "components": ["adapter", "cable", "powerbank"],
            "charger_subtype": "set",
            "model_codes": [], "customer_visibility": "visible"},
            source="units")
        roles = set(card.get("canonical_roles") or ())
        assert {"adapter", "cable", "powerbank"} <= roles, roles

    def test_message_detector_cable_head_noun_wins(self):
        """message detector (same owner): cable head-noun beats
        charger-form kws — real forms preserved without the helper."""
        from shopeechat import product_store as _ps
        assert _ps._detect_charger_subtype("สายชาร์จแม่เหล็ก มีไหม") == "cable"
        assert _ps._detect_charger_subtype("สายชาร์จในรถ มีไหม") == "cable"
        assert _ps._detect_charger_subtype("มีสาย magsafe ไหม") == "cable"
        assert _ps._detect_charger_subtype("แท่นชาร์จไร้สาย") == "wireless"
        assert _ps._detect_charger_subtype("ชาร์จแม่เหล็ก") == "wireless"
        assert _ps._detect_charger_subtype("ที่ชาร์จในรถ") == "car_charger"

    def test_doc_filter_cable_keeps_magnetic_cable(self):
        """doc-side classifier (same precedence): magnetic cable doc
        lands in the cable bucket for a cable request."""
        from shopeechat import product_store as _ps
        docs = [{"item_name": _CMC_NAME},
                {"item_name": "ZMI B508 แท่นชาร์จไร้สาย 20W"}]
        out = _ps._filter_charger_subtype(list(docs), "cable")
        names = [d["item_name"] for d in out]
        assert _CMC_NAME in names and all("ไร้สาย" not in n for n in names)

    def test_doc_filter_wireless_excludes_magnetic_cable(self):
        from shopeechat import product_store as _ps
        docs = [{"item_name": _CMC_NAME},
                {"item_name": "ZMI B508 แท่นชาร์จไร้สาย 20W"}]
        out = _ps._filter_charger_subtype(list(docs), "wireless")
        names = [d["item_name"] for d in out]
        assert names == ["ZMI B508 แท่นชาร์จไร้สาย 20W"], names


# ── r3 D/E: model-prose/card ownership + detached particles ────────────────

class TestModelProseBoundary:
    """findings D+E (r3) + r4 cleanup: markup-bearing model bubbles are
    card attempts — dropped whole at the single protocol boundary (not
    repaired into name debris); title-echo bubbles equal to a typed
    card name are dropped; deterministic segments untouched; answer-
    length instruction once; model-emitted leading particles are a
    model-output residual — no compose-side semantic rewrite."""

    def _ctx(self):
        return TestDeterministicProductCards()._ctx()

    def _model_text(self, ctx_comp):
        return next(r for r in ctx_comp.results
                    if r.domain == "product" and r.origin == "model")

    def test_markup_bubble_dropped_whole_no_name_debris(self):
        """live repro (P-Q3 after11): model card-attempt bubble
        '**name** pitch ![i](u) [l](u)' — markup strip leaves the title
        text as a duplicate bubble before the deterministic card.
        markup-bearing bubbles are discarded whole (links/images are
        not the model's channel — fail closed, no repair)."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text=(
                "แนะนำค่ะ ||| "
                "**CUKTECH AD653T หัวชาร์จ 65W** ชาร์จเร็วค่ะ "
                "![CUKTECH AD653T หัวชาร์จ 65W](https://x/y) "
                "[สั่งซื้อ](https://z/w) ||| "
                "สนใจรุ่นไหนสอบถามได้เลยนะคะ"))
        text = self._model_text(comp).text
        assert "AD653T" not in text, f"card-attempt debris: {text!r}"
        assert "แนะนำค่ะ" in text and "สนใจรุ่นไหน" in text

    def test_name_echo_bubble_dropped(self):
        """a model bubble equal to a typed product name is a title echo
        (card owns titles) — dropped, not kept as duplicate."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text=(
                "มีหัวชาร์จแนะนำค่ะ ||| "
                "**CUKTECH AD653T หัวชาร์จ 65W** ||| "
                "ชาร์จเร็วเหมาะพกพาค่ะ"))
        text = self._model_text(comp).text
        assert "AD653T" not in text, f"title echo kept: {text!r}"
        assert "ชาร์จเร็ว" in text

    def test_leading_particle_is_model_residual_not_rewritten(self):
        """r4: '|||ค่ะ สนใจรุ่นไหน…' — a model-emitted leading particle is
        a model-output residual: compose does not semantic-rewrite prose
        (the compose-side private-regex interpreter was deleted); only
        `_replace_clause` drops the particle it owns (the replaced
        clause's own terminator)."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="มีหัวชาร์จค่ะ ||| ค่ะ สนใจรุ่นไหนสอบถามได้เลยนะคะ")
        text = self._model_text(comp).text
        assert "ค่ะ สนใจรุ่นไหน" in text, text

    def test_plain_prose_unchanged(self):
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="มีหัวชาร์จแนะนำ 2 รุ่นค่ะ ||| สนใจรุ่นไหนคะ")
        assert self._model_text(comp).text == \
            "มีหัวชาร์จแนะนำ 2 รุ่นค่ะ ||| สนใจรุ่นไหนคะ"

    def test_deterministic_segments_not_normalized(self):
        """deterministic compat/constraint/card results are outside
        the model-prose normalization — byte-identical passthrough."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="มีหัวชาร์จค่ะ")
        card = next(r for r in comp.results
                    if r.domain == "product" and r.origin == "deterministic")
        assert card.text.startswith("|||") or "**" in card.text
        assert "![" in card.text and "](" in card.text, card.text

    def test_replace_clause_drops_owned_trailing_particle(self):
        """structural cause of live `|||ค่ะ` residual: the sentence-final
        particle terminating the replaced clause belongs to that clause —
        `_replace_clause` must drop it with the clause (preserving `|||`
        delimiters), not leave it as a detached sentence-start."""
        from shopeechat import guards as _g
        out = _g._replace_clause(
            "ดีค่ะ มี 999W ค่ะ สนใจรุ่นไหม", 8, 12, "REPL")
        assert out == "ดีค่ะ REPL สนใจรุ่นไหม"
        out2 = _g._replace_clause(
            "ดีค่ะ มี 999W |||ค่ะ สนใจรุ่นไหม", 8, 12, "REPL")
        # `|||` = structural boundary → `ค่ะ` หลังมันเป็นของ clause ถัดไป
        #   (model-emitted residual — ไม่ใช่ terminator ของ clause ที่แทน);
        #   space ก่อน `|||` เป็นของ clause ที่ถูกแทนจึงหลุดไปด้วย
        assert out2 == "ดีค่ะ REPL|||ค่ะ สนใจรุ่นไหม"
        # non-particle tail after `|||` untouched
        out3 = _g._replace_clause(
            "ดีค่ะ มี 999W |||สนใจรุ่นไหม", 8, 12, "REPL")
        assert "สนใจรุ่นไหม" in out3 and "|||" in out3

    def test_answer_length_instruction_once(self, monkeypatch):
        """the ⚠️ ความยาว instruction must appear exactly once in the
        composed user prompt (currently duplicated verbatim)."""
        from shopeechat import llm as _llm
        captured = {}
        monkeypatch.setattr(_llm, "_client", lambda: None)

        class _R:
            text = "ตอบค่ะ"
            usage_metadata = None
        monkeypatch.setattr(
            _llm, "_generate",
            lambda m, contents, config, **kw:
                captured.update(contents=contents) or _R())
        _, ctx = self._ctx()
        _llm.answer_typed(context=ctx, shop_hint="S", model="stub")
        prompt = captured["contents"][0]["parts"][0]["text"]
        assert prompt.count("ความยาวคำตอบ") == 1, \
            f"length instruction x{prompt.count('ความยาวคำตอบ')}"


# ── r4-F1: compose-side semantic cleanup must be deleted ────────────────────
# `_LEADING_PARTICLE` เป็น semantic regex ใหม่ + compose import private
# regex ข้ามโมดูล — structural fix อยู่ที่ `_replace_clause` เท่านั้น;
# model-emitted leading particle หลังจากนั้น = model-output residual
# (report ไม่ post-process)

class TestComposeSemanticCleanupGone:
    def test_leading_particle_regex_absent(self):
        from shopeechat import guards as _g
        assert not hasattr(_g, "_LEADING_PARTICLE"), (
            "_LEADING_PARTICLE = semantic regex ใหม่ — ต้องถูกลบ "
            "(structural particle drop อยู่ใน _replace_clause เท่านั้น)")

    def test_compose_does_not_semantic_rewrite_prose(self):
        """plain model prose — รวม bubble ที่เริ่มด้วย particle ที่ model
        emit เอง — ต้องผ่าน compose โดยไม่ถูก semantic rewrite;
        residual เป็น model-output concern ไม่ใช่ post-processor"""
        needs, ctx = TestDeterministicProductCards()._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="ค่ะ สนใจรุ่นไหนดีคะ")
        texts = [r.text for r in comp.results
                 if r.domain == "product" and r.origin == "model"]
        assert texts and texts[0] == "ค่ะ สนใจรุ่นไหนดีคะ", (
            f"compose semantic-rewrote plain prose: {texts!r}")

    def test_replace_clause_keeps_structural_boundaries(self):
        """structural boundary (|||/newline) ที่หัว tail ต้องคงเดิม —
        เฉพาะ particle-boundary ของ clause ที่ถูกแทนเท่านั้นที่หลุด"""
        from shopeechat import guards as _g
        out = _g._replace_clause(
            "ดีค่ะ มี 999W |||สนใจรุ่นไหม", 8, 12, "แจ้งไม่ได้ค่ะ")
        assert "|||" in out, f"structural boundary lost: {out!r}"
        assert "สนใจรุ่นไหม" in out
        out2 = _g._replace_clause("มี 999W\nสนใจรุ่นไหม", 3, 7, "X")
        assert "\n" in out2 or "สนใจรุ่นไหม" in out2


# ── r4-F2: feature evidence must be structured or unknown ────────────────────
# sellable_units ไม่มี structured feature field (components เป็น closed set
# product-kinds — ไม่มี magnetic; ไม่มี features/attributes/specifications
# field) → ลบ runtime keyword inference; required_features ที่พิสูจน์
# structured ไม่ได้ = unknown (fail closed) ไม่ใช่ pass

class TestFeatureEvidenceStructuredOrUnknown:
    def test_feature_search_res_absent(self):
        from shopeechat import product_store as _ps
        assert not hasattr(_ps, "_FEATURE_SEARCH_RES"), (
            "_FEATURE_SEARCH_RES = semantic keyword map บน card text — "
            "ต้องถูกลบ (ไม่มี structured feature field)")
        assert not hasattr(_ps, "_extract_product_features"), (
            "_extract_product_features = keyword inference helper — "
            "ต้องถูกลบ")

    def test_magnetic_name_card_yields_no_features_fact(self):
        """card ที่ name/desc มี 'แม่เหล็ก' แต่ไม่มี structured feature
        field → extract_field_facts ไม่ emit 'features' row — คำบน
        prose ไม่ใช่ feature evidence"""
        card = {"name": "สายชาร์จแม่เหล็ก magsafe magnetic",
                "raw_description": "แม่เหล็ก magnetic attach",
                "canonical_specs": {}, "customer_visibility": "visible",
                "sellable": True}
        facts = pr.extract_field_facts(card)
        assert not any(f.fact_key == "features" for f in facts), (
            f"features fact emitted from name/desc keywords: "
            f"{[(f.fact_key, f.value) for f in facts]}")

    def test_unproven_feature_is_unknown_not_pass(self):
        """required_feature ที่ไม่มี structured evidence → unknown
        (fail closed) — ห้าม satisfied เพราะคำปรากฏในชื่อ"""
        res = pr.eval_spec_constraints(
            (), spec_constraints=(),
            required_features=("magnetic",))
        assert "magnetic" in res["unknown"], res
        assert "magnetic" not in res["satisfied"], res
        assert res["status"] == "unknown"


# ── r4-F3: exact standalone form beats composite at selection ───────────────
# request (หรือ need ที่ map) ถาม form subtype เดียว → candidate ที่
# primary form ตรง (canonical_roles ⊆ subtype-roles∪intrinsic) ต้องมา
# ก่อน composite/set ที่เพียงมี role นั้นเป็น component; composite =
# fallback เมื่อไม่มี exact เท่านั้น

def _form_pooled(identity, roles, score, rid="req-0", item=None):
    card = {"name": identity, "item_id": item or identity.lstrip("i:u:v:"),
            "model_codes": [], "customer_visibility": "visible",
            "sellable": True, "canonical_roles": sorted(roles)}
    return cpool.PooledCandidate(
        identity=identity, item_id=item or identity, model_id=None,
        unit_id=None, sources=("legacy",), request_ids=(rid,), slot_id="s",
        relation_id=None, product_type="charger", subtype=None,
        bucket="eligible", reason="ok", score=score, trace=(), card=card)


class TestExactFormPreferenceAtSelection:
    def test_exact_adapter_beats_set_composite(self):
        """standalone adapter (roles={adapter}) ต้องมาก่อน set
        (roles∋set) แม้ score ต่ำกว่า — quota พอ → set ไม่เข้า"""
        ad = _form_pooled("i:A1", {"adapter"}, 0.5)
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.9)
        pool = _pool((st, ad))
        req = _req(subs=("adapter",))
        sel = rsel.select_for_llm_context(
            pool, (req,), None, per_request_limit=1)
        picked = [s.identity for s in sel.selected]
        assert picked == ["i:A1"], (
            f"exact adapter ต้องชนะ composite — picked={picked}")

    def test_exact_fill_quota_then_composite_excluded(self):
        a1 = _form_pooled("i:A1", {"adapter"}, 0.5)
        a2 = _form_pooled("i:A2", {"adapter"}, 0.4)
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.9)
        pool = _pool((st, a1, a2))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter",)),), None, per_request_limit=2)
        ids = {s.identity for s in sel.selected}
        assert "i:S1" not in ids and ids == {"i:A1", "i:A2"}, ids

    def test_composite_is_fallback_when_no_exact(self):
        """ไม่มี exact adapter → set ใช้เป็น fallback ได้ (ห้าม
        exclude set เสมอ)"""
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.9)
        cb = _form_pooled("i:C1", {"cable"}, 0.8)
        pool = _pool((st, cb))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter",)),), None, per_request_limit=2)
        ids = [s.identity for s in sel.selected]
        assert "i:S1" in ids, f"composite fallback missing: {ids}"
        assert ids[0] == "i:S1", ids

    def test_compat_channel_tiering_via_need_scope(self):
        """ch:compat request subs=() → scope จาก mapped compat need —
        standalone adapter มาก่อน set ใน compat candidates ด้วย"""
        ad = _form_pooled("i:A1", {"adapter"}, 0.5, rid="ch:compat")
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.9,
                          rid="ch:compat")
        pool = _pool((st, ad))
        req = _req(rid="ch:compat", slot="compat", source="compat")
        need = TurnNeed(kind="compat", operation="recommend",
                        product_types=frozenset({"charger"}),
                        subtypes=frozenset({"adapter"}))
        sel = rsel.select_for_llm_context(
            pool, (req,), None, needs=(need,), per_request_limit=1)
        picked = [s.identity for s in sel.selected]
        assert picked == ["i:A1"], picked

    def test_cable_request_prefers_standalone_cable(self):
        """generic — cable request: standalone cable ก่อน set;
        CMC-shape unit roles={cable} = exact"""
        cb = _form_pooled("i:C1", {"cable"}, 0.5)
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.9)
        pool = _pool((st, cb))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("cable",)),), None, per_request_limit=1)
        assert [s.identity for s in sel.selected] == ["i:C1"]

    def test_multi_subtype_coverage_unchanged(self):
        """multi-subtype request → coverage owner เดิม (ไม่ tier)"""
        ad = _form_pooled("i:A1", {"adapter"}, 0.9)
        cb = _form_pooled("i:C1", {"cable"}, 0.4)
        pool = _pool((ad, cb))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter", "cable")),), None,
            per_request_limit=2)
        ids = {s.identity for s in sel.selected}
        assert ids == {"i:A1", "i:C1"}, ids


# ── r5: structured form provenance — roles_source data contract ─────────────
# canonical_roles จาก structured fields (product_type/components/*_subtype)
# = "field" · จาก name-inference = "detect" — detect ไม่ใช่ standalone
# proof: candidate ที่มีแต่ detect เป็น unproven fallback เท่านั้น
# (live after13 Q4: powerbank/cable listing เหลือ {adapter} จากชื่อ
# แล้วถูกนับเป็น standalone — structured truth อยู่ใน sellable_units
# เท่านั้น, ShpProducts ไม่มี form field เลย)

class TestRolesSourceProvenance:
    def _evidence_card(self, **kw):
        from shopeechat.retrieval_policy import make_evidence_card
        base = {"name": "หัวชาร์จ 65W", "item_id": "x0",
                "model_codes": [], "status": "NORMAL", "total_stock": 5,
                "catalog_status": "active", "customer_visible": True,
                "_available_for_sale": True, "sellable": True,
                "customer_visibility": "visible"}
        base.update(kw)
        return make_evidence_card(base, source="legacy")

    def test_detect_roles_source_stamped(self):
        """name-only card (ไม่มี form field) → canonical_roles มาจาก
        name-detect → roles_source = 'detect'"""
        card = self._evidence_card(name="หัวชาร์จ 65W 2 พอร์ต")
        assert set(card.get("canonical_roles") or ()) == {"adapter"}
        assert card.get("roles_source") == "detect", (
            card.get("canonical_roles"), card.get("roles_source"))

    def test_field_roles_source_stamped(self):
        """structured form fields → roles_source = 'field'"""
        card = self._evidence_card(
            name="ชุดชาร์จ", product_type="charger",
            charger_subtype="set", components=["adapter", "cable"])
        assert "set" in set(card.get("canonical_roles") or ())
        assert card.get("roles_source") == "field", (
            card.get("canonical_roles"), card.get("roles_source"))

    def test_roles_source_in_canon_facts(self):
        """canon facts (private evidence trace) ต้องพก provenance เดียวกัน"""
        card = self._evidence_card(name="หัวชาร์จ 65W 2 พอร์ต")
        canon = ((card.get("_evidence") or {}).get("facts") or {}).get(
            "canonical") or {}
        assert canon.get("roles_source") == "detect", canon

    def test_detect_adapter_not_exact_tier(self):
        """name-only {adapter} ≠ standalone proof — proven field
        {adapter} ต้องชนะแม้ score ต่ำกว่า (structured > detect)"""
        proven = _form_pooled("i:P1", {"adapter"}, 0.5)
        proven.card["roles_source"] = "field"
        detect = _form_pooled("i:D1", {"adapter"}, 0.9)
        detect.card["roles_source"] = "detect"
        pool = _pool((detect, proven))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter",)),), None, per_request_limit=1)
        picked = [s.identity for s in sel.selected]
        assert picked == ["i:P1"], picked

    def test_proven_composite_above_unproven_shape(self):
        """structured set (adapter component พิสูจน์ได้) อยู่เหนือ
        name-only maybe-standalone — structured evidence wins"""
        proven_set = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.7)
        proven_set.card["roles_source"] = "field"
        detect_ad = _form_pooled("i:D1", {"adapter"}, 0.9)
        detect_ad.card["roles_source"] = "detect"
        pool = _pool((detect_ad, proven_set))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter",)),), None, per_request_limit=1)
        picked = [s.identity for s in sel.selected]
        assert picked == ["i:S1"], picked

    def test_detect_still_fallback_before_detect_composite(self):
        """ไม่มี structured อะไรเลย → detect-standalone-shape ยังมาก่อน
        detect-composite (fallback ordering ไม่ใช่ proof)"""
        ad = _form_pooled("i:A1", {"adapter"}, 0.5)
        ad.card["roles_source"] = "detect"
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.9)
        st.card["roles_source"] = "detect"
        pool = _pool((st, ad))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter",)),), None, per_request_limit=1)
        assert [s.identity for s in sel.selected] == ["i:A1"]

    def test_missing_structured_form_traced(self):
        """form-scoped request ที่ eligible ไม่มี field-form candidate
        เลย → trace ระบุ missing structured form (fail-closed visibility)"""
        d1 = _form_pooled("i:D1", {"adapter"}, 0.9)
        d1.card["roles_source"] = "detect"
        pool = _pool((d1,))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter",)),), None, per_request_limit=1)
        assert any("missing_structured_form" in t for t in sel.trace), \
            sel.trace


# ── r5-A: identity merge — unit structured form ต้องรอด suppression join ────

class TestListingIdentityStructuredMerge:
    def _exec_result(self, cards, rid="req-0",
                     subs=("adapter", "cable"), source="slot"):
        from shopeechat.retrieval_executor import (
            RetrievalExecutionResult, SourceAttempt)
        from shopeechat.retrieval_policy import make_evidence_card
        return RetrievalExecutionResult(
            request_id=rid, source=source, slot_id="s",
            subtypes=frozenset(subs), model_codes=(),
            eligible_candidates=tuple(
                make_evidence_card(dict(c), source=s) for c, s in cards),
            source_attempts=(SourceAttempt("units", len(cards),
                                           len(cards), 0, 0, ("t",)),))

    def _listing(self, iid, **kw):
        base = {"name": "หัวชาร์จ bundle", "item_id": iid,
                "short_link": "https://s.shopee.co.th/L",
                "image_url": "https://img/x", "model_codes": [],
                "status": "NORMAL", "total_stock": 5,
                "catalog_status": "active", "customer_visible": True,
                "_available_for_sale": True, "sellable": True,
                "customer_visibility": "visible"}
        base.update(kw)
        return base

    def test_variant_suppression_keeps_structured_form(self):
        """item เดียวกัน: listing (detect {adapter}) + unit variant
        (field cable) → pool เหลือ candidate เดียว = variant พร้อม
        structured truth + listing fields merge เข้า"""
        listing = self._listing("x1")
        variant = dict(listing)
        variant.update({"unit_id": "x1:m1", "model_id": "m1",
                        "product_type": "cable", "components": ["cable"],
                        "cable_subtype": "cable",
                        "short_link": None, "image_url": None})
        res = self._exec_result(
            [(listing, "legacy"), (variant, "units")])
        pool = cpool.build_candidate_pool((res,))
        assert len(pool.eligible) == 1, \
            [c.identity for c in pool.eligible]
        cand = pool.eligible[0]
        assert cand.identity == "v:x1#m1", cand.identity
        card = cand.card
        assert card.get("product_type") == "cable", card.get("product_type")
        assert set(card.get("canonical_roles") or ()) == {"cable"}, (
            "structured unit truth ต้องไม่ถูกลดเป็น detect {adapter}: "
            f"{card.get('canonical_roles')}")
        assert card.get("short_link") == "https://s.shopee.co.th/L"
        assert card.get("image_url") == "https://img/x"

    def test_listing_without_unit_stays_unproven(self):
        """listing เดี่ยว (ไม่มี unit ใน union) → detect roles = unproven —
        roles_source ต้องไม่กลายเป็น field"""
        res = self._exec_result([(self._listing("x9"), "legacy")])
        pool = cpool.build_candidate_pool((res,))
        cand = pool.eligible[0]
        assert cand.card.get("roles_source") == "detect", (
            cand.card.get("canonical_roles"),
            cand.card.get("roles_source"))


# ── r5-C: cross-request ordering — structured form beats channel role ───────

class TestStructuredFormOrderingAcrossRequests:
    def _adapter_need(self):
        return TurnNeed(kind="product", operation="recommend",
                        product_types=frozenset({"charger"}),
                        subtypes=frozenset({"adapter"}))

    def test_proven_standalone_leads_selected(self):
        """live Q4 shape: bundle detect-{adapter} score สูงกว่าใน req-0
        — proven standalone ต้องเป็น selected ตัวแรก (form-fit proof
        ก่อน evidence score ใน tier เดียวกันเท่านั้น score ตัดสิน)"""
        proven = _form_pooled("i:P1", {"adapter"}, 0.5, rid="req-0")
        proven.card["roles_source"] = "field"
        b1 = _form_pooled("i:B1", {"adapter"}, 0.9, rid="req-0")
        b1.card["roles_source"] = "detect"
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.7,
                          rid="ch:compat")
        st.card["roles_source"] = "detect"
        pool = _pool((b1, st, proven))
        reqs = (_req(subs=("adapter",)),
                _req(rid="ch:compat", slot="compat", source="compat",
                     types=(), subs=()))
        sel = rsel.select_for_llm_context(
            pool, reqs, None, needs=(self._adapter_need(),),
            per_request_limit=3)
        picked = [s.identity for s in sel.selected]
        assert picked[0] == "i:P1", picked
        assert picked.index("i:P1") < picked.index("i:S1"), picked

    def test_ctx_proven_form_before_detect_role(self):
        """presentation boundary: proven standalone (slot, score ต่ำ)
        ต้องนำหน้า detect bundle (relation_target, score สูง) ใน
        ctx.products — canonical order มาจาก selection pick loop
        (form tier) แล้ว ctx consume verbatim (r6: owner เดียว —
        by_req fixture = selection emission จริง)"""
        needs = (self._adapter_need(),)
        proven = _sel_card("i:P1", "slot", "req-0", "adapter P1",
                           score=0.5, canonical_roles=["adapter"],
                           roles_source="field")
        b1 = _sel_card("i:B1", "relation_target", "req-0",
                       "bundle B1", score=0.9,
                       canonical_roles=["adapter"],
                       roles_source="detect")
        # selection emits proven standalone first (tier-0 < tier-2) —
        #   fixture = canonical by_req order
        sel = _selection((proven, "req-0"), (b1, "req-0"))
        ctx = _compile(
            needs, sel,
            _pool(eligible=[_pooled("i:P1", "P1"), _pooled("i:B1", "B1")]),
            (_req(subs=("adapter",)),), _profile("หัวชาร์จละ"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert ids and ids[0] == "P1", ids

    def test_ctx_same_proof_orders_by_score(self):
        """detect-vs-detect shape เดียวกัน → evidence score ตัดสิน
        (ไม่ใช่ channel role) — live Q4 order shape; canonical order
        มาจาก selection (score ใน pick loop) ctx consume verbatim"""
        needs = (self._adapter_need(),)
        standalone = _sel_card("i:A1", "slot", "req-0", "adapter A1",
                               score=1.5, canonical_roles=["adapter"],
                               roles_source="detect")
        bundle = _sel_card("i:B1", "relation_target", "req-0",
                           "bundle B1", score=0.7,
                           canonical_roles=["adapter"],
                           roles_source="detect")
        # selection emits higher-score standalone first — fixture =
        #   canonical by_req order
        sel = _selection((standalone, "req-0"), (bundle, "req-0"))
        ctx = _compile(
            needs, sel,
            _pool(eligible=[_pooled("i:A1", "A1"), _pooled("i:B1", "B1")]),
            (_req(subs=("adapter",)),), _profile("หัวชาร์จละ"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert ids and ids[0] == "A1", ids

    def test_composite_fill_only_when_exact_insufficient(self):
        """proven standalone เต็ม quota → composite (แม้ proven) ไม่เข้า;
        proven ไม่พอ → composite fallback ตามหลัง proven เท่านั้น"""
        p1 = _form_pooled("i:P1", {"adapter"}, 0.9)
        p1.card["roles_source"] = "field"
        p2 = _form_pooled("i:P2", {"adapter"}, 0.8)
        p2.card["roles_source"] = "field"
        st = _form_pooled("i:S1", {"set", "adapter", "cable"}, 0.95)
        st.card["roles_source"] = "field"
        pool = _pool((st, p1, p2))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("adapter",)),), None, per_request_limit=2)
        ids = {s.identity for s in sel.selected}
        assert ids == {"i:P1", "i:P2"}, ids
        sel = rsel.select_for_llm_context(
            _pool((st, p1)), (_req(subs=("adapter",)),), None,
            per_request_limit=2)
        order = [s.identity for s in sel.selected]
        assert order == ["i:P1", "i:S1"], order


# ── r5-D: compatibility claim needs typed evidence (pin — owner เดิม) ───────

class TestCompatEvidenceGatePins:
    def test_unproven_compat_is_limitation_not_compatible(self):
        """candidate ไม่มี typed target-compat evidence → verdict ไม่ใช่
        compatible; context note ระบุ limitation — pin contract เดิม"""
        needs = (TurnNeed(
            kind="product", operation="recommend",
            product_types=frozenset({"charger"}),
            subtypes=frozenset({"adapter"}),
            target_refs=("xiaomi 17 ultra",)),)
        req = _req(target="xiaomi 17 ultra", compat="connector_required")
        no_ev = _sel_card(
            "i:N1", "slot", "req-0", "หัวชาร์จ N1",
            canonical_roles=["adapter"], canonical_type="charger",
            roles_source="detect")
        sel = _selection((no_ev, "req-0"))
        ctx = _compile(
            needs, sel, _pool(eligible=[_pooled("i:N1", "N1")]),
            (req,), _profile("หัวชาร์จละ"))
        assert ctx.products
        note = ctx.products[0].get("_context_note") or ""
        assert "ยืนยัน" in note or "ไม่มีข้อมูล" in note, note


# ── r6-A: selection = sole ordering owner — AnswerContext consumes order ────
# r6 finding A: candidate order is owned by retrieval_selection alone —
# by_req/selected carry canonical order (request-iteration order = channel
# precedence; pick order = in-request rank). AnswerContext must consume that
# order verbatim — no second form-tier/role evaluation downstream.

class TestSelectionCanonicalOrder:
    def _need_adapter(self):
        return (TurnNeed(kind="product", operation="recommend",
                         product_types=frozenset({"charger"}),
                         subtypes=frozenset({"adapter"}),
                         subject_scope="none"),)

    def test_ctx_consumes_selection_order_no_rerank(self):
        """by_req order deliberately inverts form-tier preference —
        a second ordering owner in ctx would re-sort field-composite
        ahead; consuming canonical order must preserve selection's
        pick sequence verbatim."""
        det = _sel_card("i:1", "slot", "req-0", "detect adapter",
                        canonical_roles=["adapter"],
                        roles_source="detect")
        fld = _sel_card("i:2", "slot", "req-0", "field set",
                        canonical_roles=["adapter", "cable"],
                        roles_source="field")
        sel = _selection((det, "req-0"), (fld, "req-0"))
        ctx = _compile(self._need_adapter(), sel,
                       _pool(eligible=[_pooled("i:1", "1"),
                                       _pooled("i:2", "2")]),
                       (_req("req-0", subs=("adapter",)),),
                       _profile("หัวชาร์จละ"))
        ids = [str(p.get("item_id")) for p in ctx.products]
        assert ids[:2] == ["1", "2"], (
            "ctx re-ordered candidates — selection is the sole "
            f"ordering owner: {ids}")

    def test_form_tier_api_deleted_single_owner(self):
        """form_tier must not exist as a shared/consumer API — ordering
        logic lives at the single selection pick-loop site."""
        assert not hasattr(rsel, "form_tier"), \
            "form_tier module API must be inlined into selection"
        assert not hasattr(acx, "form_tier"), \
            "answer_context must not evaluate form semantics"

    def test_subjects_channel_iterates_first(self):
        """identity-authority precedence lives in request order —
        run_grouped_selection must iterate the subjects channel before
        planner requests so by_req/ctx products lead with the subject."""
        card = {"name": "CUKTECH CTL301", "item_id": "55",
                "model_codes": ["CTL301"], "status": "NORMAL",
                "total_stock": 5, "catalog_status": "active",
                "customer_visible": True, "_available_for_sale": True}
        prof = _profile("สายชาร์จ CTL301 ยาวกี่เมตร")
        out = rrt.run_grouped_selection(
            prof, message="สายชาร์จ CTL301 ยาวกี่เมตร", shop="t",
            platform="shopee",
            fetcher=lambda m, **k: [],
            legacy_fetcher=None, subject_cards=[card], needs=())
        assert out is not None
        assert out["requests"][0].source == "subjects", (
            "subjects channel must iterate first — by_req order carries "
            f"identity precedence: {[r.request_id for r in out['requests']]}")

    def test_subject_role_leads_within_request_picks(self):
        """code-match subject (role='subject') outranked by an
        alternative on evidence score must still lead that request's
        picked order — subject = identity authority, selection emits it."""
        subj = _form_pooled("i:S1", {"cable"}, 0.4)
        subj.card["model_codes"] = ["CTL301"]
        alt = _form_pooled("i:A1", {"cable"}, 0.9)
        pool = _pool((alt, subj))
        sel = rsel.select_for_llm_context(
            pool, (_req(subs=("cable",), codes=("CTL301",)),), None,
            per_request_limit=3)
        ids = [s.identity for s in sel.selected]
        assert ids and ids[0] == "i:S1", (
            f"subject-role pick must lead its request picks: {ids}")

    def test_promoted_unavailable_subject_leads_request_picks(self):
        """answerable_all promotion: promoted unavailable subject must
        lead its request's by_req row (old presentation sort hoisted
        role=='subject' first — same contract at selection owner)."""
        elig = _form_pooled("i:A1", {"cable"}, 0.9)
        gone = _form_pooled("i:G1", {"cable"}, 0.1)
        gone.card["model_codes"] = ["CMC615P"]
        gone.card["sellable"] = False
        pool = cpool.CandidatePool(
            eligible=(elig,), unavailable=(gone,), rejected=(),
            by_request=(), evidence_pool=(), supporting_evidence=(),
            trace=())
        req = _req(subs=("cable",), codes=("CMC615P",))
        object.__setattr__(req, "availability_mode", "answerable_all")
        sel = rsel.select_for_llm_context(
            pool, (req,), None, per_request_limit=3)
        by_req = dict(sel.by_request)
        picks = [s.identity for s in by_req.get(req.request_id, ())]
        assert picks and picks[0] == "i:G1", (
            f"promoted subject must lead request picks: {picks} "
            f"(by_req={[(r, [s.identity for s in c]) for r, c in sel.by_request]})")


# ── r6-B: structured form provenance pins (finding B — verified clean) ──────

class TestStructuredFormProvenancePins:
    def test_listing_merge_never_upgrades_roles_source(self):
        """suppression join: unit card roles_source='field' must survive
        the listing merge — listing name-detect never upgrades/downgrades
        structured provenance."""
        from shopeechat.retrieval_executor import (
            RetrievalExecutionResult, SourceAttempt)
        from shopeechat.retrieval_policy import make_evidence_card
        unit = {"name": "AD Adapter 65W", "item_id": "i1",
                "model_id": "m1", "unit_id": "i1:m1",
                "product_type": "charger", "components": ["adapter"],
                "charger_subtype": "adapter",
                "status": "NORMAL", "total_stock": 3,
                "catalog_status": "active", "customer_visible": True,
                "_available_for_sale": True}
        listing = {"name": "หัวชาร์จ bundle set", "item_id": "i1",
                   "short_link": "https://s.shopee.co.th/L",
                   "image_url": "https://img/x",
                   "status": "NORMAL", "total_stock": 3,
                   "catalog_status": "active", "customer_visible": True,
                   "_available_for_sale": True}
        res = RetrievalExecutionResult(
            request_id="req-0", source="slot", slot_id="s",
            subtypes=frozenset({"adapter"}), model_codes=(),
            eligible_candidates=(
                make_evidence_card(dict(listing), source="legacy"),
                make_evidence_card(dict(unit), source="units")),
            source_attempts=(SourceAttempt("units", 2, 2, 0, 0, ("t",)),))
        pool = cpool.build_candidate_pool((res,))
        cand = next(c for c in pool.eligible
                    if c.identity.startswith("v:"))
        assert cand.card.get("roles_source") == "field", (
            cand.card.get("canonical_roles"),
            cand.card.get("roles_source"))
        assert cand.card.get("short_link") == "https://s.shopee.co.th/L"
        assert cand.card.get("image_url") == "https://img/x"

    def test_listing_name_subtype_never_field_proof(self):
        """name-derived charger_subtype must not materialize as a
        structured field — listing cards stay provenance 'detect'."""
        from shopeechat.retrieval_policy import make_evidence_card
        card = make_evidence_card(
            {"name": "หัวชาร์จ 65W แท้ set", "item_id": "x1",
             "model_codes": [], "status": "NORMAL", "total_stock": 1,
             "catalog_status": "active", "customer_visible": True,
             "_available_for_sale": True}, source="legacy")
        assert card.get("charger_subtype") is None, (
            "name inference must not write structured subtype fields")
        assert card.get("roles_source") == "detect", (
            card.get("canonical_roles"), card.get("roles_source"))


# ── r6-C: deterministic card boundary — ||| survives finalize+enforce ───────
# r6 finding C (live after14): _append_base_warranty ran
# llm._strip_kb_markup over the composed answer — its markdown-table
# converter classified a line-start '|||' card prefix as a table row and
# deleted it; the |||-run normalizer also collapsed '|||\n' → ' ||| '.
# Consequences: (a) card glued to prose; (b) deterministic-provenance
# find() failed → card spans lost guard exemption → spec tokens inside
# **title** became scannable (defer splice produced 'นะคะ **Title**').

class TestDeterministicCardBoundary:
    def _ctx(self):
        needs = (TurnNeed(kind="product", operation="recommend",
                          product_types=frozenset({"charger"}),
                          subtypes=frozenset({"adapter"}),
                          subject_scope="none"),)
        c1 = _sel_card("i:47067", "slot", "req-0",
                       "CUKTECH AD653T หัวชาร์จ 65W",
                       canonical_roles=["adapter"],
                       canonical_type="charger",
                       image_url="https://cf.shopee.co.th/img1",
                       short_link="https://s.shopee.co.th/l1")
        c2 = _sel_card("i:57617", "slot", "req-0",
                       "CUKTECH AD652S หัวชาร์จ 33W",
                       canonical_roles=["adapter"],
                       canonical_type="charger",
                       image_url="https://cf.shopee.co.th/img2",
                       short_link="https://s.shopee.co.th/l2")
        sel = _selection((c1, "req-0"), (c2, "req-0"))
        ctx = _compile(needs, sel,
                       _pool(eligible=[_pooled("i:47067", "47067"),
                                       _pooled("i:57617", "57617")]),
                       (_req("req-0", subs=("adapter",)),),
                       _profile("หัวชาร์จละ"))
        return needs, ctx

    def _finalize(self, comp):
        if "shopeechat.app" not in sys.modules:
            import shopeechat.app  # noqa: F401
        app = sys.modules["shopeechat.app"]
        return app._finalize_answer(
            comp, message="หัวชาร์จละ", limit=5, products=[],
            source="product_store", shop="S", model="m", elapsed=0.0,
            cost=0.0, intent={}, timing={}, steps=[],
            routing_decision={})

    def test_pipe_delimiter_line_survives_normalizer(self):
        """owner unit test: '|||' on its own line = protocol delimiter,
        not a markdown table row — must survive byte-exact."""
        from shopeechat import llm as _llm
        out = _llm._strip_kb_markup("prose\n\n|||\n**Title**")
        assert "|||\n**Title**" in out, (
            f"protocol delimiter eaten by prose normalizer: {out!r}")

    def test_short_pipe_run_normalized_not_deleted(self):
        """issue-19 sloppy delimiter '||' must become '||' + '|' —
        normalized to '|||', never eaten by the table converter."""
        from shopeechat import llm as _llm
        out = _llm._strip_kb_markup("a\n||\nb")
        assert "|||" in out, f"delimiter run deleted: {out!r}"

    def test_finalize_card_prefix_byte_exact(self):
        """deterministic card segment (leading '|||\n') must reach
        resp.answer byte-exact through _finalize_answer."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="มีหัวชาร์จแนะนำค่ะ")
        card = next(r.text for r in comp.results
                    if r.domain == "product" and r.origin == "deterministic")
        resp = self._finalize(comp)
        assert card in resp.answer, (
            "card bytes mutated through finalizer — marker text can "
            f"never match: {resp.answer!r}")

    def test_marker_segments_found_in_final_answer(self):
        """the contract guards._det_texts relies on: every deterministic
        segment text must find() byte-exact in the final answer —
        otherwise the exemption silently dies."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="มีหัวชาร์จแนะนำค่ะ")
        resp = self._finalize(comp)
        for r in comp.results:
            if r.origin != "deterministic" or not r.text:
                continue
            assert r.text in resp.answer, (
                f"det segment not byte-present in answer ({r.domain}) — "
                "provenance protection dead")

    def test_defer_never_glues_to_card_title(self):
        """live after14 repro: '…นะคะ **Title**' — spec defer must stay
        in its own prose bubble, card stays behind '|||'."""
        from shopeechat import guards as _g
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx,
            product_text="หัวชาร์จทุกตัวรองรับ 999W ค่ะ")
        resp = self._finalize(comp)
        resp2 = _g.enforce(resp, _NS(message="หัวชาร์จละ", history=[]))
        assert not __import__("re").search(r"คะ\s+\*\*", resp2.answer), (
            "defer prose glued to card title — delimiter lost: "
            f"{resp2.answer!r}")
        for r in comp.results:
            if r.origin == "deterministic" and r.text:
                assert r.text in resp2.answer, resp2.answer

    def test_answer_segments_split_prose_and_cards(self):
        """answer_segments must be per-bubble — prose + one bubble per
        deterministic card (live after14 had a single merged segment)."""
        needs, ctx = self._ctx()
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="มีหัวชาร์จแนะนำค่ะ")
        resp = self._finalize(comp)
        segs = resp.answer_segments or []
        assert len(segs) >= 2, (
            f"segments collapsed — ||| missing in answer: {segs}")
        assert not any("|||" in s for s in segs)


# ════════════════════ r7 — ordering-owner structural pins ════════════════════

class TestOrderingOwnerStructure:
    """r7 structural contract — candidate order has exactly ONE owner and the
    single-form preference is expressed as typed facts, not tier mechanics."""

    def test_no_nested_function_or_tier_symbol_in_selection(self):
        """select_for_llm_context contains no nested def, no _tier/form_tier
        symbol — ordering expressed once via typed-fact tuple."""
        import ast, inspect, re
        from shopeechat import retrieval_selection as _rs
        src = inspect.getsource(_rs.select_for_llm_context)
        tree = ast.parse(__import__("textwrap").dedent(src))
        inner_defs = [n for n in ast.walk(tree)
                      if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        assert len(inner_defs) <= 1, (
            f"nested function(s) inside select_for_llm_context: "
            f"{[n.name for n in inner_defs[1:]]}")
        assert not re.search(r"\b_tier\b", src), "opaque _tier helper present"
        assert "form_tier" not in src
        assert not re.search(r"return [0-5]\b", src), (
            "magic tier numbers still emitted")

    def test_no_form_tier_symbol_anywhere(self):
        """module API deleted in r6 — no form_tier in either owner file."""
        import inspect
        from shopeechat import retrieval_selection as _rs
        from shopeechat import answer_context as _acx
        for mod in (_rs, _acx):
            assert "form_tier" not in inspect.getsource(mod), (
                f"form_tier survives in {mod.__name__}")

    def test_answer_context_has_no_candidate_resort(self):
        """single ordering owner — AnswerContext must not re-sort candidate
        products (r6 contract pinned structurally)."""
        import inspect
        from shopeechat import answer_context as _acx
        src = inspect.getsource(_acx.compile_answer_context)
        assert "cands.sort" not in src, (
            "second ordering owner reintroduced in compile_answer_context")
