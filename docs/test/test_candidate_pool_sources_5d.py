"""test_candidate_pool_sources_5d.py — Task 5D: pin source-union behaviors
ที่ audit live-probe ยืนยันแล้ว (ไม่ใช้ DB — fake fetchers เท่านั้น).

pin:
- pool รวม units+legacy ต่อ request → dedupe ตาม unit/model/item id
- relation_target request ใช้ query_hint (target-side text) ไม่ใช่ message เต็ม
- per-request quota: slot A ไม่กิน quota ของ slot B (multi-type)
- unavailable/rejected evidence ไม่หายแม้ eligible=0 (all-dead ไม่ collapse)
- anchor card ได้ is_anchor+score boost เมื่อ fetcher ดึงมา (tag เท่านั้น —
  ไม่มี anchor fetcher — documented limitation)
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402
from shopeechat.candidate_pool import build_candidate_pool  # noqa: E402
from shopeechat.retrieval_executor import (  # noqa: E402
    RetrievalExecutionResult, execute_grouped_retrieval_requests)
from shopeechat.retrieval_planner import (  # noqa: E402
    RetrievalRequest, build_grouped_retrieval_requests)
from shopeechat.retrieval_selection import select_for_llm_context  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult  # noqa: E402


def _card(name, item_id, *, unit_id=None, model_id=None, sellable=True,
          visible=True, ptype="charger", codes=()):
    return {
        "name": name, "item_id": item_id, "unit_id": unit_id,
        "model_id": model_id, "model_codes": list(codes),
        "product_type": ptype, "total_stock": 5 if sellable else 0,
        "status": "NORMAL", "catalog_status": "active" if sellable else "out_of_stock",
        "customer_visible": visible, "_available_for_sale": sellable,
        "availability_reason": "ok" if sellable else "oos",
    }


def _res(cards):
    return UnitEvidenceFetchResult(
        cards=tuple(cards), raw_count=len(cards),
        sellable_count=sum(1 for c in cards if c.get("_available_for_sale")),
        unavailable_count=sum(1 for c in cards
                              if not c.get("_available_for_sale")),
        trace=("fake",))


def test_cross_source_dedupe_same_item():
    """units card + legacy card item เดียวกัน → merge เข้า candidate เดียว
    sources รวมทั้งคู่ใน _evidence"""
    uc = _card("AD653C หัวชาร์จ", "i1", unit_id="u1", model_id="m1")
    lc = _card("AD653C หัวชาร์จ", "i1")          # legacy: ไม่มี unit/model id
    req = RetrievalRequest(
        request_id="r0", slot_id="s", source="slot",
        product_types=frozenset({"charger"}), subtypes=frozenset(),
        model_codes=("AD653C",), target_device=None,
        availability_mode="sellable_first", compat_mode="none")
    calls = {"units": [uc], "legacy": [lc]}
    results = execute_grouped_retrieval_requests(
        (req,), message="m", shop="s",
        fetcher=lambda m, **kw: _res(calls["units"]),
        legacy_fetcher=lambda m, **kw: list(calls["legacy"]))
    pool = build_candidate_pool(results)
    assert len(pool.eligible) == 1
    assert set(pool.eligible[0].sources) == {"units", "legacy"}


def test_relation_target_uses_query_hint():
    """relation_target fetch ด้วย query_hint (ข้อความฝั่ง target) ไม่ใช่
    message เต็ม — กัน vector เอียงไปทาง source product"""
    seen: list[str] = []

    def fetcher(message, **kw):
        seen.append(message)
        return _res([])

    prof = route_context.build_retrieval_profile(
        "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้าง", history=[],
        intent_result=None, shop="KingGadgets")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    reqs = build_grouped_retrieval_requests(prof, slots, rels)
    assert any(r.source == "relation_target" for r in reqs)
    execute_grouped_retrieval_requests(
        reqs, message="หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้าง",
        shop="KingGadgets", fetcher=fetcher, legacy_fetcher=None)
    rel_req = next(r for r in reqs if r.source == "relation_target")
    qh = dict(rel_req.soft_hints).get("query_hint")
    assert qh and qh in seen  # query_hint ถูกใช้เป็น fetch query จริง


def test_per_request_quota_isolation_multi_type():
    """case slot ไม่กิน quota ของ screen_protector slot — แต่ละ request
    ได้ quota ของตัวเอง"""
    cases = [_card(f"case {i}", f"c{i}", ptype="case") for i in range(5)]
    films = [_card("film x", "f1", ptype="screen_protector", sellable=False)]
    reqs = (
        RetrievalRequest("r0", "s0", "slot", frozenset({"case"}),
                         frozenset(), (), "iphone 15", "sellable_first", "none"),
        RetrievalRequest("r1", "s1", "slot", frozenset({"screen_protector"}),
                         frozenset(), (), "iphone 15", "sellable_first", "none"),
    )
    per = {"r0": cases, "r1": films}
    it = iter(reqs)

    def fetcher(m, **kw):
        return _res(per[next(it).request_id])

    results = execute_grouped_retrieval_requests(
        reqs, message="m", shop="s", fetcher=fetcher, legacy_fetcher=None)
    pool = build_candidate_pool(results)
    sel = select_for_llm_context(pool, reqs, per_request_limit=3)
    by = dict(sel.by_request)
    assert len(by["r0"]) == 3            # case quota 3 — ไม่ถูก film กิน
    assert by["r1"] == ()                # film ไม่มีของขาย → ไม่ยัด case เข้า req-1
    assert any(u["request_id"] == "r1" for u in sel.unavailable_evidence)


def test_all_dead_request_preserves_unavailable_evidence():
    """request ที่ของตายหมด (elig=0) → unavailable evidence ยังอยู่ ไม่ collapse"""
    dead = [_card("dead item", "d1", sellable=False)]
    req = RetrievalRequest("r0", "s", "slot", frozenset({"charger"}),
                           frozenset(), ("AC65B",), None,
                           "answerable_all", "none")
    results = execute_grouped_retrieval_requests(
        (req,), message="m", shop="s",
        fetcher=lambda m, **kw: _res(dead), legacy_fetcher=None)
    pool = build_candidate_pool(results)
    assert not pool.eligible and len(pool.unavailable) == 1
    sel = select_for_llm_context(pool, (req,))
    assert sel.unavailable_evidence and sel.unavailable_evidence[0]["unavailable"]


def test_anchor_tags_only_fetched_cards():
    """anchor_item_ids tag เฉพาะ card ที่ fetcher ดึงเข้า pool —
    pin documented limitation: ไม่มี anchor fetcher (5D audit finding)"""
    anchor_card = _card("anchor item", "a1")
    prof = SimpleNamespace(anchor_item_ids=("a1",), intent="spec")
    req = RetrievalRequest("r0", "s", "slot", frozenset({"charger"}),
                           frozenset(), (), None, "sellable_first", "none")
    results = execute_grouped_retrieval_requests(
        (req,), message="m", shop="s",
        fetcher=lambda m, **kw: _res([anchor_card]), legacy_fetcher=None)
    pool = build_candidate_pool(results, profile=prof)
    assert pool.eligible[0].is_anchor is True
    assert any(e.kind == "anchor" for e in pool.evidence_pool)
    # anchor ที่ไม่ถูก fetch → ไม่เข้า pool (ไม่มี card ปรากฏ)
    prof2 = SimpleNamespace(anchor_item_ids=("a-missing",), intent="spec")
    pool2 = build_candidate_pool(results, profile=prof2)
    assert not any(e.kind == "anchor" for e in pool2.evidence_pool)
