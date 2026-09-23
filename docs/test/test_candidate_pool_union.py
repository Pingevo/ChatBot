from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult  # noqa: E402
from shopeechat.retrieval_planner import build_grouped_retrieval_requests  # noqa: E402
from shopeechat.retrieval_executor import (  # noqa: E402
    RetrievalExecutionResult, execute_grouped_retrieval_requests)
from shopeechat.candidate_pool import build_candidate_pool  # noqa: E402


def _card(name="card", ptype="case", avail=True, src="units", **kw):
    c = {"name": name, "product_type": ptype,
         "_available_for_sale": avail,
         "availability_reason": "" if avail else "sold_out",
         "catalog_status": "active" if avail else "out_of_stock",
         "total_stock": 5 if avail else 0,
         "_evidence_source": src}
    c.update(kw)
    return c


def _pipeline(message: str):
    prof = route_context.build_retrieval_profile(
        message, history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    return build_grouped_retrieval_requests(prof, slots, rels)


def _exec(reqs, units_docs=(), legacy_docs=()):
    def units_fetcher(message, **kw):
        return UnitEvidenceFetchResult(
            cards=tuple(units_docs), raw_count=len(units_docs),
            sellable_count=sum(1 for c in units_docs
                               if c.get("_available_for_sale")),
            unavailable_count=0, trace=("u",))

    def legacy_fetcher(message, **kw):
        return list(legacy_docs)

    return execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets",
        fetcher=units_fetcher, legacy_fetcher=legacy_fetcher)


def test_two_source_attempts_per_request():
    reqs = _pipeline("มีเคส iPhone 15 ไหม")
    results = _exec(reqs, units_docs=[_card("เคสยูนิต", "case", unit_id="u1")],
                    legacy_docs=[_card("เคสเลกาซี", "case", item_id="i9",
                                       src="legacy")])
    r = results[0]
    srcs = {a.source for a in r.source_attempts}
    assert srcs == {"units", "legacy"}
    seen_src = {tuple((c.get("_evidence") or {}).get("sources", ()))
                for c in r.eligible_candidates}
    assert seen_src == {("units",), ("legacy",)}


def test_same_item_unit_and_legacy_merges_sources():
    reqs = _pipeline("มีเคส iPhone 15 ไหม")
    results = _exec(
        reqs,
        units_docs=[_card("เคส X", "case", unit_id="u1", item_id="i1")],
        legacy_docs=[_card("เคส X", "case", item_id="i1", src="legacy")])
    pool = build_candidate_pool(results)
    assert len(pool.eligible) == 1
    merged = pool.eligible[0]
    assert set(merged.sources) == {"units", "legacy"}
    assert merged.item_id == "i1"


def test_variants_different_unit_ids_not_deduped():
    reqs = _pipeline("มีเคส iPhone 15 ไหม")
    results = _exec(reqs, units_docs=[
        _card("เคส X สีดำ", "case", unit_id="u1", model_id="m1", item_id="i1"),
        _card("เคส X สีขาว", "case", unit_id="u2", model_id="m2", item_id="i1")])
    pool = build_candidate_pool(results)
    assert len(pool.eligible) == 2
    assert {c.unit_id for c in pool.eligible} == {"u1", "u2"}


def test_multi_slot_quota_not_shared():
    reqs = _pipeline("มีเคสกับฟิล์มสำหรับ iPhone 15 ไหม")

    def units_fetcher(message, **kw):
        prof = kw["retrieval_profile"]
        docs = ([_card("เคส iPhone 15", "case", unit_id="c1")]
                if "case" in prof.product_types else [])
        return UnitEvidenceFetchResult(
            cards=tuple(docs), raw_count=len(docs),
            sellable_count=len(docs), unavailable_count=0, trace=("u",))

    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets",
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [])
    pool = build_candidate_pool(results)
    by_req = dict(pool.by_request)
    case_req = next(k for k, v in by_req.items()
                    if any(c.product_type == "case" for c in v))
    sp_req = next(k for k in by_req if k != case_req)
    assert len(by_req[case_req]) >= 1
    assert by_req[sp_req] == ()  # film slot ว่างแต่ยังอยู่ใน map — ไม่หายเงียบ


def test_relation_base_and_target_groups():
    reqs = _pipeline("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน")

    def units_fetcher(message, **kw):
        prof = kw["retrieval_profile"]
        docs = ([_card("สายชาร์จ CTC620W", "cable", charger_subtype="cable",
                       unit_id="cb1")]
                if prof.subtype == "cable"
                else [_card("หัวชาร์จ AD1404T", "charger",
                            charger_subtype="adapter", unit_id="ad1")])
        return UnitEvidenceFetchResult(
            cards=tuple(docs), raw_count=len(docs), sellable_count=len(docs),
            unavailable_count=0, trace=("u",))

    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets",
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [])
    pool = build_candidate_pool(results)
    types = {c.product_type for c in pool.eligible}
    assert "charger" in types and "cable" in types
    cable = next(c for c in pool.eligible if c.product_type == "cable")
    assert cable.relation_id is not None


def test_dead_product_stays_unavailable_evidence():
    reqs = _pipeline("รุ่น AD1404T ยังมีขายไหม")
    results = _exec(reqs, units_docs=[
        _card("AD1404T dead", "charger", avail=False, unit_id="d1")])
    pool = build_candidate_pool(results)
    assert pool.eligible == ()
    assert len(pool.unavailable) == 1
    assert pool.unavailable[0].reason


def test_wrong_device_rejected_not_eligible():
    reqs = _pipeline("มีฟิล์มสำหรับ iPhone 15 ไหม")
    results = _exec(reqs, units_docs=[
        _card("ฟิล์ม Mi Band 8", "screen_protector", unit_id="f1"),
        _card("ฟิล์ม iPhone 15", "screen_protector", unit_id="f2")])
    pool = build_candidate_pool(results)
    assert [c.unit_id for c in pool.eligible] == ["f2"]
    assert pool.rejected and "device_mismatch" in pool.rejected[0].reason


def test_source_error_isolated():
    reqs = _pipeline("มีเคส iPhone 15 ไหม")

    def broken(m, **kw):
        raise RuntimeError("legacy db down")

    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets",
        fetcher=lambda m, **kw: UnitEvidenceFetchResult(
            cards=(_card("เคส U", "case", unit_id="u1"),),
            raw_count=1, sellable_count=1, unavailable_count=0, trace=("u",)),
        legacy_fetcher=broken)
    r = results[0]
    assert r.eligible_candidates
    legacy = next(a for a in r.source_attempts if a.source == "legacy")
    assert legacy.error == "legacy db down"


def test_exact_code_boost_ranks_first():
    reqs = _pipeline("รุ่น AD1404T ยังมีขายไหม")
    results = _exec(reqs, units_docs=[
        _card("หัวชาร์จทั่วไป", "charger", unit_id="g1"),
        _card("AD1404T charger", "charger", unit_id="e1",
              model_codes=["AD1404T"])])
    pool = build_candidate_pool(results)
    assert pool.eligible[0].unit_id == "e1"
    assert pool.eligible[0].score > pool.eligible[1].score


def test_no_cross_request_mutation():
    reqs = _pipeline("มีเคสกับฟิล์มสำหรับ iPhone 15 ไหม")
    results = _exec(reqs)
    snapshot = [r.eligible_candidates for r in results]
    build_candidate_pool(results)
    assert [r.eligible_candidates for r in results] == snapshot


def test_anchor_priority_in_spec_intent():
    # group-B anchor: item ที่เคยคุยอยู่ต้อง priority สูงสุดใน spec/follow-up
    import dataclasses
    prof = route_context.build_retrieval_profile(
        "เคสตัวนั้นสเปคยังไง", history=[],
        intent_result={"intent": "product_spec", "confidence": 0.9},
        shop="KingGadgets")
    prof = dataclasses.replace(prof, anchor_item_ids=("i2",))
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    reqs = build_grouped_retrieval_requests(prof, slots, rels)
    results = _exec(reqs, units_docs=[
        _card("เคส A", "case", unit_id="u1", item_id="i1"),
        _card("เคส B", "case", unit_id="u2", item_id="i2")])
    pool = build_candidate_pool(results, profile=prof)
    assert pool.eligible[0].item_id == "i2"
    assert pool.eligible[0].is_anchor
    anchors = [e for e in pool.evidence_pool if e.kind == "anchor"]
    assert len(anchors) == 1 and anchors[0].item_id == "i2"


def test_kb_and_image_text_are_attachments_not_candidates():
    # kb_products/image_texts เติม evidence ให้ candidate ที่ match —
    # ไม่สร้าง candidate ใหม่เอง
    reqs = _pipeline("มีเคส iPhone 15 ไหม")
    results = _exec(reqs, units_docs=[
        _card("เคส A", "case", unit_id="u1", item_id="i1",
              canonical_specs={"warranty": "1y"}, image_text="film img")])
    pool = build_candidate_pool(results)
    assert len(pool.eligible) == 1
    kinds = {e.kind for e in pool.evidence_pool}
    assert {"kb_product", "image_text"} <= kinds
    assert all(e.linked_candidate == pool.eligible[0].identity
               for e in pool.evidence_pool)


def test_anchor_id_normalized_float_int():
    # profile anchor "123.0" (float-str) ต้อง match card item_id=123 (int)
    # — เดียวกับ _card_ids ที่ normalize ผ่าน _norm_id
    import dataclasses
    prof = route_context.build_retrieval_profile(
        "เคสตัวนั้นสเปคยังไง", history=[],
        intent_result={"intent": "product_spec", "confidence": 0.9},
        shop="KingGadgets")
    prof = dataclasses.replace(prof, anchor_item_ids=("123.0",))
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    reqs = build_grouped_retrieval_requests(prof, slots, rels)
    results = _exec(reqs, units_docs=[
        _card("เคส A", "case", unit_id="u1", item_id=456),
        _card("เคส B", "case", unit_id="u2", item_id=123)])
    pool = build_candidate_pool(results, profile=prof)
    assert pool.eligible[0].item_id == "123"
    assert pool.eligible[0].is_anchor
    anchors = [e for e in pool.evidence_pool if e.kind == "anchor"]
    assert len(anchors) == 1 and anchors[0].item_id == "123"


def test_llm_ready_strips_private_evidence():
    reqs = _pipeline("มีเคส iPhone 15 ไหม")
    results = _exec(reqs, units_docs=[_card("เคส A", "case", unit_id="u1")])
    pool = build_candidate_pool(results)
    assert pool.eligible[0].card.get("_evidence")  # internal ยังมี
    out = pool.llm_ready()
    assert out and all("_evidence" not in c and "_selection_reason" not in c
                       for c in out)
