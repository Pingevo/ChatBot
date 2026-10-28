"""test_retrieval_selection.py — Task 5B3-B: candidate-pool → LLM selection.

pin: per-request quota · relation target ไม่ถูก source กิน quota ·
constraint ranking (display/length/speed) · unavailable fallback ·
rejected excluded · private evidence stripped
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult  # noqa: E402
from shopeechat.retrieval_planner import build_grouped_retrieval_requests  # noqa: E402
from shopeechat.retrieval_executor import execute_grouped_retrieval_requests  # noqa: E402
from shopeechat.candidate_pool import build_candidate_pool  # noqa: E402
from shopeechat.retrieval_selection import select_for_llm_context  # noqa: E402
from shopeechat.retrieval_policy import make_evidence_card  # noqa: E402

AD1404T_MSG = ("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้างในร้านเรา "
               "ขอแบบมีจอ ยาว 2 เมตรและได้เต็มสปีด")


def _profile(msg=AD1404T_MSG):
    return route_context.build_retrieval_profile(
        msg, history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="KingGadgets")


def _pool(msg=AD1404T_MSG, adapter_cards=(), cable_cards=()):
    """profile → requests → execute(fake units) → pool"""
    prof = _profile(msg)
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    def units_fetcher(message, **kw):
        p = kw["retrieval_profile"]
        docs = cable_cards if p.subtype == "cable" else adapter_cards
        return UnitEvidenceFetchResult(
            cards=tuple(docs), raw_count=len(docs),
            sellable_count=sum(1 for c in docs if c.get("_available_for_sale")),
            unavailable_count=0, trace=("u",))

    results = execute_grouped_retrieval_requests(
        reqs, message=msg, shop="KingGadgets",
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [], snap=None)
    return build_candidate_pool(results, profile=prof), reqs, prof


def _stamped(avail=True, **kw):
    """resolver fields ที่ to_unit_card/to_product_card stamp เสมอใน production"""
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


def _names(sel):
    return [s.card.get("name") for s in sel.selected]


def test_relation_source_and_target_both_selected():
    # CTC620P มีจอ OLED + variant 2 เมตร + 240W — ต้องติด context พร้อม adapter
    pool, reqs, prof = _pool(
        adapter_cards=[_adapter()],
        cable_cards=[
            _cable("CUKTECH CTC615P/CTC620P สายชาร์จมีจอ OLED 6A 240W", "u-p",
                   variants=[{"name": "CTC620P 2 เมตร", "model_id": "m2"}]),
            _cable("CUKTECH CTC620W สายชาร์จ 2 เมตร PD3.1", "u-w"),
        ])
    sel = select_for_llm_context(pool, reqs, prof)
    names = _names(sel)
    assert any("AD1404T" in n for n in names)          # source product ติด
    assert any("CTC620P" in n for n in names)          # target ที่ตรง constraint
    roles = {s.role for s in sel.selected}
    # Task 5C — card ที่ match code ที่ถาม = "subject" (เดิม "slot")
    assert "subject" in roles and "relation_target" in roles


def test_per_request_quota_source_cannot_eat_target():
    # adapter หลายตัว score สูง — cable ยังต้องได้ quota ของตัวเอง
    pool, reqs, prof = _pool(
        adapter_cards=[_adapter(item_id=f"a{i}", unit_id=f"ua{i}",
                                name=f"AD1404T v{i}")
                       for i in range(6)],
        cable_cards=[_cable("สายชาร์จมีจอ OLED 240W", "u-c",
                            variants=[{"name": "2 เมตร"}])])
    sel = select_for_llm_context(pool, reqs, prof)
    cable = [s for s in sel.selected if s.role == "relation_target"]
    assert cable, "relation_target ต้องได้ quota แยกจาก slot"


def test_constraint_ranking_display_length_speed():
    # มีจอ+2m+240W ชนะ 2m ไม่มีจอ ชนะ มีจอแต่ไม่ใช่ 2m
    pool, reqs, prof = _pool(
        adapter_cards=[_adapter()],
        cable_cards=[
            _cable("สาย C มีจอ OLED 1 เมตร 240W", "u-short",
                   variants=[{"name": "1 เมตร"}]),
            _cable("สาย B 2 เมตร ธรรมดา", "u-plain",
                   variants=[{"name": "2 เมตร"}]),
            _cable("สาย A มีจอ OLED 240W", "u-full",
                   variants=[{"name": "2 เมตร"}]),
        ])
    sel = select_for_llm_context(pool, reqs, prof)
    targets = [s for s in sel.selected if s.role == "relation_target"]
    # Phase 4A — identity = candidate key ที่มี domain prefix (owner:
    # candidate_pool._identity_key) — raw unit_id ไม่ใช่ identity อีกต่อไป
    assert targets[0].identity == "u:u-full"
    assert targets[0].constraint_hits
    assert "display" in targets[0].constraint_hits


def test_unavailable_evidence_when_no_eligible():
    pool, reqs, prof = _pool(
        adapter_cards=[_adapter()],
        cable_cards=[_cable("สายตาย", "u-dead", _available_for_sale=False,
                            availability_reason="seller_delete")])
    sel = select_for_llm_context(pool, reqs, prof)
    targets = [s for s in sel.selected if s.role == "relation_target"]
    assert not targets
    unav = [u for u in sel.unavailable_evidence]
    assert unav and any("สายตาย" in (u.get("name") or "") for u in unav)


def test_rejected_never_in_selected():
    pool, reqs, prof = _pool(
        msg="มีฟิล์มสำหรับ iPhone 15 ไหม",
        adapter_cards=[  # subtype=None → helper ใช้ branch นี้
            _cable("ฟิล์ม Mi Band 8", "u-wrong",
                   product_type="screen_protector", cable_subtype=None),
            _cable("ฟิล์ม iPhone 15", "u-right",
                   product_type="screen_protector", cable_subtype=None),
        ])
    sel = select_for_llm_context(pool, reqs, prof)
    names = _names(sel)
    assert "ฟิล์ม iPhone 15" in names
    assert not any("Mi Band" in n for n in names)


def test_private_evidence_stripped():
    pool, reqs, prof = _pool(
        adapter_cards=[_adapter()],
        cable_cards=[_cable("สายมีจอ", "u-c")])
    sel = select_for_llm_context(pool, reqs, prof)
    for s in sel.selected:
        assert "_evidence" not in s.card
        assert "_selection_reason" not in s.card
    for u in sel.unavailable_evidence:
        assert "_evidence" not in u
        assert "_selection_reason" not in u


def test_selection_summary_explainable():
    pool, reqs, prof = _pool(
        adapter_cards=[_adapter()],
        cable_cards=[_cable("สายมีจอ OLED 240W", "u-c",
                            variants=[{"name": "2 เมตร"}])])
    sel = select_for_llm_context(pool, reqs, prof)
    assert sel.by_request
    target = next(s for s in sel.selected if s.role == "relation_target")
    assert target.reason  # เหตุผลที่ถูกเลือกอธิบายได้
    assert target.request_id


def test_multi_subtype_quota_one_subtype_cannot_eat_all():
    # request เดียว subtypes={adapter,cable} — adapter score สูงกว่าเต็ม quota
    # cable ต้องได้อย่างน้อย 1 ที่ (ลูกค้าถามทั้งคู่ — subtype เดียวกิน quota
    # หมด = สายชาร์จที่ขายได้หายจาก context)
    from shopeechat.retrieval_planner import RetrievalRequest
    from shopeechat.retrieval_executor import (
        RetrievalExecutionResult, SourceAttempt)

    req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"charger"}), frozenset({"adapter", "cable"}),
        (), None, "sellable_first", "none")
    cards = [_adapter(name=f"adapter rank{i}", item_id=f"a{i}",
                      unit_id=f"ua{i}", model_codes=())
             for i in range(3)]
    cards.append(_cable("สายชาร์จ B", "uc"))
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=req.subtypes, model_codes=(),
        # executor emits canonical cards เสมอ — simulate output ผ่าน adapter
        eligible_candidates=tuple(
            make_evidence_card(c, source="units") for c in cards),
        source_attempts=(SourceAttempt("units", 4, 4, 0, 0, ("t",)),))
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (req,), None, per_request_limit=3)
    subs = {s.card.get("charger_subtype") or s.card.get("cable_subtype")
            for s in sel.selected}
    assert "cable" in subs


def test_no_v2_v3_caller():
    for mod in ("chatbotv2", "chatbotv3"):
        p = ROOT / "chatbot" / "shopeechat" / f"{mod}.py"
        if p.exists():
            src = p.read_text()
            assert "retrieval_selection" not in src
            assert "select_for_llm_context" not in src


def test_unavailable_subject_promotion_respects_item_pin():
    """live repro (W-Q2 after10): request pinned to exact item via
    subject_refs — a SELLER_DELETE sibling listing sharing the model code
    must NOT promote into subjects (bound เดียวกับ eligible selection:
    sibling/bundle ไม่เข้า context เงียบๆ — _code_match ไม่ใช่ identity
    authority เมื่อ item-id pin อยู่)."""
    from shopeechat.retrieval_planner import RetrievalRequest
    from shopeechat.retrieval_executor import (
        RetrievalExecutionResult, SourceAttempt)

    req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"cable", "charger"}), frozenset({"cable"}),
        ("CMC615P",), None, "answerable_all", "none",
        subject_refs=("27639651334",))
    pinned = _cable(
        "CUKTECH CMC615P 6A 240W สายชาร์จแม่เหล็ก USB-C -24M",
        "u-live", item_id="27639651334", model_codes=["CMC615P"])
    deleted_sibling = _cable(
        "CUKTECH CMC615P 6A 240W สายชาร์จแม่เหล็ก USB-C (ล็อตเก่า)",
        "u-dead", item_id="28312539696", model_codes=["CMC615P"],
        _available_for_sale=False)
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=req.subtypes, model_codes=req.model_codes,
        eligible_candidates=(make_evidence_card(pinned, source="units"),),
        unavailable_evidence=(
            make_evidence_card(deleted_sibling, source="units"),),
        source_attempts=(SourceAttempt("units", 2, 2, 0, 0, ("t",)),))
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (req,), None)
    ids = {str(s.card.get("item_id")) for s in sel.selected}
    assert ids == {"27639651334"}, \
        f"pinned request must not promote sibling listing: {ids}"


def test_eligible_sibling_blocked_by_item_pin():
    """regression pin (r3-C): exact item pin narrows request candidates
    once at grouping — an eligible sibling sharing the model code must
    never reach selection (bound ก่อน eligible/unavailable branches)."""
    from shopeechat.retrieval_planner import RetrievalRequest
    from shopeechat.retrieval_executor import (
        RetrievalExecutionResult, SourceAttempt)

    req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"cable", "charger"}), frozenset({"cable"}),
        ("CMC615P",), None, "sellable_first", "none",
        subject_refs=("27639651334",))
    pinned = _cable("CUKTECH CMC615P 6A 240W สายชาร์จแม่เหล็ก -24M",
                    "u-live", item_id="27639651334", model_codes=["CMC615P"])
    sibling = _cable("CUKTECH CMC615P 6A 240W (อีกล็อต)", "u-sib",
                     item_id="28312539696", model_codes=["CMC615P"])
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=req.subtypes, model_codes=req.model_codes,
        eligible_candidates=(make_evidence_card(pinned, source="units"),
                             make_evidence_card(sibling, source="units")),
        source_attempts=(SourceAttempt("units", 2, 2, 0, 0, ("t",)),))
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (req,), None)
    ids = {str(s.card.get("item_id")) for s in sel.selected}
    assert ids == {"27639651334"}, ids


def test_linked_variant_admitted_by_item_pin():
    """variant candidates carry linked_item_id = parent item — a pin
    on the parent admits the variant (contract kept: linked_item_id is
    the identity link)."""
    from shopeechat.candidate_pool import PooledCandidate, CandidatePool
    from shopeechat.retrieval_planner import RetrievalRequest

    req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"cable"}), frozenset({"cable"}),
        ("CMC615P",), None, "sellable_first", "none",
        subject_refs=("27639651334",))
    variant = PooledCandidate(
        identity="m:var1", item_id="999888", model_id="var1",
        unit_id="u-var1", sources=("units",), request_ids=("req-0",),
        slot_id="slot-charger", relation_id=None, product_type="cable",
        subtype="cable", bucket="eligible", reason="ok", score=1.0,
        trace=(), card={"name": "CMC615P สีขาว", "item_id": "999888",
                        "linked_item_id": "27639651334",
                        "model_codes": ["CMC615P"]},
        linked_item_id="27639651334")
    pool = CandidatePool(
        eligible=(variant,), unavailable=(), rejected=(),
        by_request=(), evidence_pool=(), supporting_evidence=(), trace=())
    sel = select_for_llm_context(pool, (req,), None)
    assert {s.identity for s in sel.selected} == {"m:var1"}, \
        [s.identity for s in sel.selected]


def test_no_pin_keeps_model_code_behavior():
    """no exact item-id in subject_refs → model-code matching retains
    existing behavior (siblings sharing a code are candidates)."""
    from shopeechat.retrieval_planner import RetrievalRequest
    from shopeechat.retrieval_executor import (
        RetrievalExecutionResult, SourceAttempt)

    req = RetrievalRequest(
        "req-0", "slot-charger", "slot",
        frozenset({"cable", "charger"}), frozenset({"cable"}),
        ("CMC615P",), None, "sellable_first", "none")
    a = _cable("CUKTECH CMC615P 6A 240W -24M", "u-1",
               item_id="27639651334", model_codes=["CMC615P"])
    b = _cable("CUKTECH CMC615P 6A 240W (อีกล็อต)", "u-2",
               item_id="28312539696", model_codes=["CMC615P"])
    res = RetrievalExecutionResult(
        request_id="req-0", source="slot", slot_id="slot-charger",
        subtypes=req.subtypes, model_codes=req.model_codes,
        eligible_candidates=(make_evidence_card(a, source="units"),
                             make_evidence_card(b, source="units")),
        source_attempts=(SourceAttempt("units", 2, 2, 0, 0, ("t",)),))
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (req,), None)
    assert len(sel.selected) >= 2, [s.card.get("item_id")
                                    for s in sel.selected]
