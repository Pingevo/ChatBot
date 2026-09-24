"""Test evidence card contract — Task 3 (observe-only contract, no behavior change).

รัน: .venv/bin/python -m pytest docs/test/test_retrieval_evidence.py -v

Contract:
- _evidence.sources/item_ids/model_ids/facts — metadata ภายใน
- _selection_reason — short machine reason
- ห้ามหลุด 2 keys นี้ไป public response (strip_private_evidence)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import retrieval_policy


def _card() -> dict:
    return {"item_id": 123, "name": "ZMI Powerbank", "catalog_status": "active",
            "price": {"min": 590, "max": 590}}


# ── make_evidence_card ──
def test_make_evidence_card_does_not_mutate_input():
    card = _card()
    snapshot = dict(card)
    retrieval_policy.make_evidence_card(card, source="legacy")
    assert card == snapshot


def test_adds_source_to_evidence_sources():
    got = retrieval_policy.make_evidence_card(_card(), source="legacy")
    assert got["_evidence"]["sources"] == ["legacy"]


def test_merge_duplicate_source_does_not_duplicate():
    card = retrieval_policy.make_evidence_card(_card(), source="kb")
    got = retrieval_policy.make_evidence_card(card, source="kb")
    assert got["_evidence"]["sources"] == ["kb"]


def test_merge_multiple_sources_keeps_all():
    card = retrieval_policy.make_evidence_card(_card(), source="unit")
    got = retrieval_policy.make_evidence_card(card, source="anchor")
    assert got["_evidence"]["sources"] == ["unit", "anchor"]


def test_preserves_existing_evidence_fields():
    card = _card()
    card["_evidence"] = {"sources": ["order"], "facts": {"order_sn": "2209"}}
    got = retrieval_policy.make_evidence_card(card, source="anchor",
                                              evidence={"seen": ["timeline"]})
    assert got["_evidence"]["sources"] == ["order", "anchor"]
    assert got["_evidence"]["facts"]["order_sn"] == "2209"
    assert got["_evidence"]["facts"]["seen"] == ["timeline"]


def test_normalizes_item_id_and_model_id_to_string():
    card = _card()
    card["model_id"] = 130177903540.0   # float จาก mongo export
    got = retrieval_policy.make_evidence_card(card, source="unit")
    assert got["_evidence"]["item_ids"] == ["123"]
    assert got["_evidence"]["model_ids"] == ["130177903540"]
    for v in got["_evidence"]["item_ids"] + got["_evidence"]["model_ids"]:
        assert isinstance(v, str)


def test_missing_ids_give_empty_lists():
    card = {"name": "no ids"}
    got = retrieval_policy.make_evidence_card(card, source="web")
    assert got["_evidence"]["item_ids"] == []
    assert got["_evidence"]["model_ids"] == []


def test_evidence_param_lands_in_facts():
    got = retrieval_policy.make_evidence_card(
        _card(), source="compat", evidence={"spec": ["ShpProducts.description"]})
    assert got["_evidence"]["facts"]["spec"] == ["ShpProducts.description"]


def test_selection_reason_set_when_passed():
    got = retrieval_policy.make_evidence_card(
        _card(), source="anchor", selection_reason="exact_model_match")
    assert got["_selection_reason"] == "exact_model_match"


def test_selection_reason_absent_when_not_passed():
    got = retrieval_policy.make_evidence_card(_card(), source="legacy")
    assert "_selection_reason" not in got


def test_public_fields_preserved():
    got = retrieval_policy.make_evidence_card(_card(), source="legacy")
    for k in ("item_id", "name", "catalog_status", "price"):
        assert got[k] == _card()[k]


# ── strip_private_evidence ──
def test_strip_private_evidence_removes_internal_keys():
    card = retrieval_policy.make_evidence_card(
        _card(), source="kb", selection_reason="exact")
    got = retrieval_policy.strip_private_evidence(card)
    assert "_evidence" not in got
    assert "_selection_reason" not in got
    assert got["item_id"] == 123
    assert got["name"] == "ZMI Powerbank"


def test_strip_private_evidence_does_not_mutate_input():
    card = retrieval_policy.make_evidence_card(
        _card(), source="kb", selection_reason="exact")
    before = set(card.keys())
    retrieval_policy.strip_private_evidence(card)
    assert set(card.keys()) == before


def test_strip_private_evidence_accepts_list():
    cards = [retrieval_policy.make_evidence_card(_card(), source="legacy"),
             retrieval_policy.make_evidence_card(_card(), source="kb")]
    got = retrieval_policy.strip_private_evidence(cards)
    assert all("_evidence" not in c and "_selection_reason" not in c for c in got)
    assert len(got) == 2
