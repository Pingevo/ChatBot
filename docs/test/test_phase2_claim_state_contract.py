"""Phase 2A — claim lifecycle desired contract baseline.

Scope: claim-state lifecycle ownership only (stage / persisted slots /
terminal precedence / fill-once merge / clear). No runtime changes in this
phase — RED results document gaps for Phase 2B.

Offline & deterministic: `warranty_flow` top-level imports are stdlib-only;
`conversation_products` lazily builds its Mongo client inside `_coll()`,
so tests inject a tiny in-memory collection — no network, no .env, no LLM.

Target under test is the CURRENT private owner `_claim_collecting`
(temporary target until a public lifecycle owner exists — Phase 2B).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from shopeechat import conversation_products, warranty_flow  # noqa: E402

_collecting = warranty_flow._claim_collecting


# ── in-memory conversation_products collection ─────────────────────────────

class _FakeColl:
    """Minimal Mongo surface used by load/update/clear_claim_state."""

    def __init__(self, doc: dict | None = None):
        self.doc = dict(doc) if doc else None

    def find_one(self, q, *_a, **_k):
        if self.doc and self.doc.get("conversation_id") == q["conversation_id"]:
            return dict(self.doc)
        return None

    def update_one(self, q, u, upsert=False, **_k):
        if self.doc is None:
            if not upsert:
                return
            self.doc = dict(q)
        for k, v in (u.get("$set") or {}).items():
            self.doc[k] = v
        for k in (u.get("$unset") or {}):
            self.doc.pop(k, None)


@pytest.fixture()
def coll(monkeypatch):
    """Inject fake collection; returns it for post-state inspection."""
    fake = _FakeColl()
    monkeypatch.setattr(conversation_products, "_coll", lambda: fake)
    return fake


# ── current invariants (must stay green — parity pins) ─────────────────────

def test_no_state_is_not_collecting():
    assert _collecting(None) is False


def test_empty_state_is_not_collecting():
    assert _collecting({}) is False


def test_stage_collecting_is_collecting():
    assert _collecting({"stage": "collecting"}) is True


def test_collecting_with_slots_is_collecting():
    assert _collecting({"stage": "collecting",
                        "customer_phone": "0812345678"}) is True


def test_resolved_without_slots_is_not_collecting():
    assert _collecting({"stage": "resolved"}) is False


def test_ts_suggested_without_slots_is_not_collecting():
    # ts_suggested = troubleshoot advice sent, not yet collecting info.
    # Current owner treats it as inactive for collection — pin as current
    # invariant; whether it counts as "active claim" is a Phase 2B contract
    # decision, recorded in the transition table.
    assert _collecting({"stage": "ts_suggested"}) is False


def test_merge_claim_slots_fill_once_and_correction():
    merge = warranty_flow._merge_claim_slots
    seed = {"customer_name": "สมชาย ใจดี", "customer_phone": "0812345678"}
    # empty turn → falls back to persisted slots (fill-once)
    s = merge({"name": "", "phone": "", "order_id": ""}, claim_state=seed)
    assert s["name"] == "สมชาย ใจดี" and s["phone"] == "0812345678"
    # fresh value wins over persisted (correction)
    s = merge({"name": "", "phone": "0999999999", "order_id": ""},
              claim_state=seed)
    assert s["phone"] == "0999999999" and s["name"] == "สมชาย ใจดี"
    # invalid name shape (>40 chars / no space / digits) is dropped
    s = merge({"name": "x" * 50, "phone": "", "order_id": ""},
              claim_state={})
    assert s["name"] is None


def test_update_claim_state_merge_skips_none_and_empty(coll):
    conversation_products.update_claim_state(
        "c1", "shopee", "Shop",
        {"stage": "collecting", "customer_name": "สมชาย ใจดี"})
    conversation_products.update_claim_state(
        "c1", "shopee", "Shop",
        {"customer_name": None, "customer_phone": "0812345678"})
    state = conversation_products.load_claim_state("c1")
    assert state["customer_name"] == "สมชาย ใจดี"  # not overwritten by None
    assert state["customer_phone"] == "0812345678"
    assert state["stage"] == "collecting"
    assert state["started_at"] and state["updated_at"]


def test_clear_claim_state_unsets(coll):
    conversation_products.update_claim_state(
        "c1", "shopee", "Shop", {"stage": "collecting"})
    assert conversation_products.load_claim_state("c1")
    conversation_products.clear_claim_state("c1")
    assert conversation_products.load_claim_state("c1") is None


# ── desired contract (RED → strict xfail; fix lands in Phase 2B) ───────────

_XFAIL_RESOLVED = pytest.mark.xfail(
    strict=True,
    reason=(
        "owner: warranty_flow._claim_collecting — slot-based active check "
        "ignores terminal stage; evidence: claim-resolved-retained-slots "
        "boundary row + Phase 1G post-state probe (phone not persisted, "
        "legacy hands off via executor divergence); delete this xfail when "
        "the Phase 2B lifecycle owner gives terminal stage precedence over "
        "retained slots"))


@_XFAIL_RESOLVED
@pytest.mark.parametrize("retained_slots", [
    {"customer_name": "สมชาย ใจดี"},
    {"customer_phone": "0812345678"},
    {"customer_name": "สมชาย ใจดี", "customer_phone": "0812345678",
     "customer_order_id": "2508088B5T4W1D"},
])
def test_desired_terminal_stage_beats_retained_slots(retained_slots):
    """Desired: stage=resolved is terminal — retained slots are audit data,
    not a resume signal, and cannot by themselves re-activate collection.
    Only an explicit new claim request may reopen. Current owner returns
    True for any retained slot (slot-based check, no terminal precedence)."""
    assert _collecting({"stage": "resolved", **retained_slots}) is False
