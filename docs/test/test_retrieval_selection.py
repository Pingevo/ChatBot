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
        fetcher=units_fetcher, legacy_fetcher=lambda m, **kw: [])
    return build_candidate_pool(results, profile=prof), reqs, prof


def _adapter(name="CUKTECH AD1404T หัวชาร์จ 140W", **kw):
    c = {"name": name, "product_type": "charger", "charger_subtype": "adapter",
         "_available_for_sale": True, "item_id": "a1", "unit_id": "ua1",
         "model_codes": ["AD1404T"]}
    c.update(kw)
    return c


def _cable(name, unit_id, **kw):
    c = {"name": name, "product_type": "cable", "cable_subtype": "cable",
         "_available_for_sale": True, "item_id": unit_id, "unit_id": unit_id}
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
    assert "slot" in roles and "relation_target" in roles


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
    assert targets[0].identity == "u-full"
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


def test_no_v2_v3_caller():
    for mod in ("chatbotv2", "chatbotv3"):
        p = ROOT / "chatbot" / "shopeechat" / f"{mod}.py"
        if p.exists():
            src = p.read_text()
            assert "retrieval_selection" not in src
            assert "select_for_llm_context" not in src
