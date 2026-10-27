"""Phase 10B D1 — canonical_specs card contract (incident: grouped canary A2).

Root cause: ``to_unit_card`` copies ``unit["canonical_specs"]`` verbatim into
the canonical card. Mongo unit docs carry ``canonical_specs: None`` (all
11,783 ShpProducts docs) → card field is ``None`` →
``device_compat._extract_data_transfer_mbps`` does
``p.get("canonical_specs", {}).get(...)`` → AttributeError →
``compile_answer_context`` raises → fail-closed deterministic defer even
though ``480Mbps`` evidence exists in the item's description.

Contract (single owner — ``units.to_unit_card``):

- ``canonical_specs`` missing / None / non-dict → ``{}`` on the card
- ``canonical_specs`` dict → preserved
- downstream consumers (extract_field_facts, spec extractors,
  compile_answer_context) never raise on the normalized card
- description facts still reach the typed AnswerContext (spec_facts)
- no cross-item fact leakage
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import units as _units  # noqa: E402
from shopeechat import device_compat as dc  # noqa: E402
from shopeechat import policy_resolver as pr  # noqa: E402
from shopeechat import route_context as rc  # noqa: E402
from shopeechat import retrieval_selection as rsel  # noqa: E402
from shopeechat import retrieval_planner as rpl  # noqa: E402
from shopeechat import candidate_pool as cpool  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402

RetrievalRequest = rpl.RetrievalRequest

ITEM = "27639651334"
DESC_480 = "CUKTECH CMC615P สายชาร์จแม่เหล็ก รองรับการถ่ายโอนข้อมูล 480Mbps"


def _unit(canonical_specs=..., **kw):
    """minimal sellable unit doc — canonical_specs knob controls the field."""
    u = {
        "item_id": ITEM, "unit_id": f"u:{ITEM}:0", "model_id": "m1",
        "model_name": "CMC615P", "shop": "t", "platform": "shopee",
        "display_name": "CUKTECH CMC615P สายชาร์จแม่เหล็ก",
        "item_status": "NORMAL", "model_status": "MODEL_NORMAL",
        "sellable": True, "kind": "model",
        "product_type": "cable", "model_codes": ["CMC615P"],
        "desc_sections": {"specs": DESC_480},
        "image_ids": [],
        "_listing": {
            "item_status": "NORMAL",
            "model": [{"model_id": "m1", "model_name": "CMC615P",
                       "model_status": "MODEL_NORMAL",
                       "stock_info_v2": {"summary_info": {
                           "total_available_stock": 3}}}],
            "tier_variation": [],
        },
    }
    if canonical_specs is not ...:
        u["canonical_specs"] = canonical_specs
    u.update(kw)
    return u


def _card_from_unit(u):
    return _units.to_unit_card(u)


# ── PART 1: to_unit_card normalization contract ──────────────────────────────

def test_missing_key_normalizes_to_empty_dict():
    c = _card_from_unit(_unit())  # no canonical_specs key at all
    assert c["canonical_specs"] == {}


def test_none_normalizes_to_empty_dict():
    c = _card_from_unit(_unit(canonical_specs=None))
    assert c["canonical_specs"] == {}


def test_valid_dict_preserved():
    specs = {"data_transfer_mbps": 480, "output_w": 240}
    c = _card_from_unit(_unit(canonical_specs=specs))
    assert c["canonical_specs"] == specs


@pytest.mark.parametrize("bad", [
    ["a", "b"], "480Mbps", True, 0, (1, 2), {"x"}, 4.5,
])
def test_non_dict_normalizes_to_empty_dict(bad):
    c = _card_from_unit(_unit(canonical_specs=bad))
    assert c["canonical_specs"] == {}


# ── downstream extractors must not raise on normalized card ──────────────────

def test_extract_data_transfer_mbps_no_raise_on_none_source():
    c = _card_from_unit(_unit(canonical_specs=None))
    assert dc._extract_data_transfer_mbps(c) == 480.0  # from desc text


def test_extract_max_wattage_no_raise_on_none_source():
    c = _card_from_unit(_unit(canonical_specs=None))
    v = dc._extract_max_wattage(c)
    assert isinstance(v, (int, float))


def test_extract_field_facts_no_raise_and_emits_speed():
    c = _card_from_unit(_unit(canonical_specs=None))
    facts = pr.extract_field_facts(c, subject_id=str(c.get("item_id") or ""))
    speed = next((f for f in facts if f.fact_key == "data_transfer_mbps"), None)
    assert speed is not None and speed.value == 480.0


# ── e2e: compile_answer_context does not raise + fact reaches spec_facts ─────

def _need():
    return td.TurnNeed(
        kind="product", operation="describe",
        subject_refs=(ITEM,), confidence=1.0,
        requested_facts=("data_transfer_speed",))


def _req():
    return RetrievalRequest(
        request_id="req-0", slot_id="s", source="slot",
        product_types=frozenset({"cable"}), subtypes=frozenset(),
        model_codes=("CMC615P",), target_device=None,
        availability_mode="", compat_mode="none",
        hard_filters=(), soft_hints=(), relation_id=None,
        relation_type=None, confidence=1.0, variant_terms=(),
        value_constraints=(), subject_refs=(ITEM,))


def _selection(card):
    sc = rsel.SelectedCandidate(
        role="subject", request_id="req-0", slot_id="s", relation_id=None,
        identity=f"i:{ITEM}", score=1.0, constraint_hits=(),
        reason="exact", card=card)
    return rsel.SelectionResult(
        selected=(sc,), by_request=(("req-0", (sc,)),),
        unavailable_evidence=(), rejected_summary=(), trace=())


def _pool(card):
    pc = cpool.PooledCandidate(
        identity=f"i:{ITEM}", item_id=ITEM, model_id="m1", unit_id="u:0",
        sources=("unit",), request_ids=("req-0",), slot_id="s",
        relation_id=None, product_type="cable", subtype=None,
        bucket="eligible", reason="ok", score=1.0, trace=(), card=card)
    return cpool.CandidatePool(
        eligible=(pc,), unavailable=(), rejected=(), by_request=(),
        evidence_pool=(), supporting_evidence=(), trace=())


def _profile():
    return rc.build_retrieval_profile(
        "Speed data เท่าไหร่ครับ", history=None, intent_result=None,
        shop="t")


def test_compile_answer_context_no_raise_on_none_canonical_specs():
    card = _card_from_unit(_unit(canonical_specs=None))
    needs = (_need(),)
    sel, pool, reqs, prof = _selection(card), _pool(card), (_req(),), _profile()
    task = acx.compile_answer_task(
        needs=needs, selection=sel, requests=reqs, pool=pool, profile=prof)
    ctx = acx.compile_answer_context(
        needs=needs, selection=sel, pool=pool, requests=reqs,
        profile=prof, task=task)
    assert ctx is not None
    scoped = [p for p in ctx.products if str(p.get("item_id")) == ITEM]
    assert scoped, "subject card missing from context"
    sf = scoped[0].get("spec_facts") or {}
    assert sf.get("data_transfer_mbps") == 480.0, (
        f"480Mbps description evidence must reach spec_facts: {sf}")


def test_cross_item_no_fact_leak():
    """other item's card must not carry CMC615P's 480Mbps fact."""
    card_a = _card_from_unit(_unit(canonical_specs=None))
    card_b = _card_from_unit(_unit(
        canonical_specs=None, item_id="999", unit_id="u:999:0",
        model_id="m9", display_name="OTHER ITEM no speed",
        desc_sections={"specs": "no speed info"}))
    fa = {f.fact_key: f.value
          for f in pr.extract_field_facts(card_a, subject_id=ITEM)}
    fb = {f.fact_key: f.value
          for f in pr.extract_field_facts(card_b, subject_id="999")}
    assert fa.get("data_transfer_mbps") == 480.0
    assert fb.get("data_transfer_mbps") in (None, 0.0)


# ── positive controls: real spec dicts keep working ───────────────────────────

def test_valid_spec_dict_still_feeds_extractor():
    c = _card_from_unit(_unit(
        canonical_specs={"data_transfer_mbps": 480}))
    assert dc._extract_data_transfer_mbps(c) == 480.0
    facts = pr.extract_field_facts(c, subject_id=ITEM)
    assert any(f.fact_key == "data_transfer_mbps" and f.value == 480.0
               and f.source in ("canonical_specs", "card") for f in facts)
