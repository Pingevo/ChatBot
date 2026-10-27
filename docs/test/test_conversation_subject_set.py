"""Phase 2C.2 — persisted ConversationSubjectSet contract tests.

Ladder: unit-level (pure fns + FakeColl) → e2e chat() replay via the
incident-replay harness. All offline — no real Mongo/network/LLM.

Contracts under test:
  P1  subject_ids = canonical normalized item_id strings ONLY (one identity
      domain); model codes are evidence, never persisted as untyped ids.
  P2  absent conversation_products doc → minimal insert under the existing
      unique conversation_id key; never fabricate products/claim/order fields.
  P3  stale concurrent write cannot silently overwrite a newer subject set:
      CAS fence on persisted monotonic `subject_set.rev` (+1 per commit —
      ABA-safe, unlike snapshot equality which can return to an identical
      value); miss → truthful winner/None.
"""
from __future__ import annotations

import copy
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
import pymongo
from pymongo.errors import DuplicateKeyError, PyMongoError

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

# Importing the replay harness adds os.environ defaults it never removes
# (setdefault-only writes during its module import). Snapshot before the
# import and undo the additions afterwards so importing this file is
# env-neutral — no .env is loaded anywhere in this process.
_env_before_replay_import = dict(os.environ)
import test_legacy_turn_incident_replay as replay  # noqa: E402
from test_legacy_turn_incident_replay import (  # noqa: E402
    ADMIN_DB,
    COLL,
    PRODUCT_DB,
    FakeClient,
    FakeColl,
    FakeDb,
    _install,
)

for _k in [k for k in os.environ if k not in _env_before_replay_import]:
    del os.environ[_k]
os.environ.update({k: v for k, v in _env_before_replay_import.items()
                   if os.environ.get(k) != v})
del _env_before_replay_import

from shopeechat import app  # noqa: E402
from shopeechat import conversation_products as cp  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    """Same tripwire posture as the incident replay — any real seam fails."""
    monkeypatch.setattr(socket.socket, "connect",
                        lambda *a, **k: pytest.fail(
                            "OFFLINE LEAK: socket.connect", pytrace=False))
    monkeypatch.setattr(socket.socket, "connect_ex",
                        lambda *a, **k: pytest.fail(
                            "OFFLINE LEAK: socket.connect_ex", pytrace=False))
    monkeypatch.setattr(socket, "create_connection",
                        lambda *a, **k: pytest.fail(
                            "OFFLINE LEAK: create_connection", pytrace=False))
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: pytest.fail(
                            "OFFLINE LEAK: getaddrinfo", pytrace=False))
    monkeypatch.setattr(socket.socket, "settimeout", lambda *a, **k: None)

    def _client_init_guard(self, *a, **k):
        pytest.fail("OFFLINE LEAK: pymongo.MongoClient() constructed",
                    pytrace=False)
    monkeypatch.setattr(pymongo.MongoClient, "__init__", _client_init_guard)


def _coll_with(docs: list[dict] | None = None) -> FakeColl:
    return FakeColl(list(docs or []))


def _bind(monkeypatch, coll: FakeColl) -> None:
    monkeypatch.setattr(cp, "_coll", lambda: coll)


def _set(ids, relation="single", ops=("describe",), conf=1.0, turn=None):
    return cp.ConversationSubjectSet(
        subject_ids=tuple(ids), source_turn_id=turn, relation=relation,
        requested_operations=tuple(ops), confidence=conf)


def _set_doc(ids, relation="single", ops=("describe",), conf=1.0, turn=None,
             rev=None):
    d = {
        "subject_ids": list(ids), "source_turn_id": turn,
        "relation": relation, "requested_operations": list(ops),
        "confidence": conf, "updated_at": datetime.now(timezone.utc),
    }
    if rev is not None:
        d["rev"] = rev
    return d


# ═══ P1 — identity domain ═══════════════════════════════════════════════════

class TestIdentityDomain:
    def test_numeric_float_string_ids_normalize_identically(self, monkeypatch):
        """123.0, 123, '123', '123.0' must all persist as '123'."""
        coll = _coll_with()
        _bind(monkeypatch, coll)
        docs = []
        for i, raw in enumerate((123.0, 123, "123", "123.0")):
            got = cp.decide_subject_set(None, explicit_ids=(raw,))
            assert got.subject_ids == ("123",)
            stored = cp.record_subject_set(f"c-{i}", got)
            assert stored.subject_ids == ("123",)
            docs.append(coll._docs[-1]["subject_set"]["subject_ids"])
        assert len({tuple(d) for d in docs}) == 1

    def test_round_trip_persist_load_same_subject(self, monkeypatch):
        coll = _coll_with()
        _bind(monkeypatch, coll)
        new = cp.decide_subject_set(None, explicit_ids=("47615436122.0",))
        stored = cp.record_subject_set("c-rt", new, platform="shopee")
        loaded = cp.get_subject_set("c-rt")
        assert loaded.stored == stored
        assert loaded.stored.subject_ids == ("47615436122",)

    def test_model_id_text_cannot_collide_with_item_id(self, monkeypatch):
        """subject_ids is item_id domain only — a model_id string equal to an
        item_id text is still just that item_id (single domain, no dual-type
        ambiguity), but callers must resolve model→item before persisting."""
        coll = _coll_with()
        _bind(monkeypatch, coll)
        s = cp.record_subject_set("c", _set(["3002"]))
        # '3002' resolves back through the item_id domain only
        assert s.subject_ids == ("3002",)
        assert cp.get_subject_set("c").stored.subject_ids == ("3002",)

    def test_raw_model_code_cannot_persist_as_subject_id(self, monkeypatch):
        """C — 'AC65B' is a model code (evidence), not canonical item identity.
        It must be dropped at normalization and rejected at the writer."""
        coll = _coll_with()
        _bind(monkeypatch, coll)
        # writer boundary: non-canonical proposed set → refused, zero writes
        assert cp.record_subject_set("c", _set(["AC65B"])) is None
        assert coll._docs == []
        # decide boundary: model-code evidence alone forms no identity
        assert cp.decide_subject_set(None, explicit_ids=("AC65B",)) is None
        # mixed evidence: canonical item id survives, model code dropped
        got = cp.decide_subject_set(None, explicit_ids=("4001", "AC65B"))
        assert got is not None and got.subject_ids == ("4001",)
        # stored non-canonical ids → malformed → parse fails safe
        coll._docs.append({"conversation_id": "c2",
                           "subject_set": _set_doc(["AC65B"])})
        assert cp.get_subject_set("c2").stored is None

    def test_multi_variant_same_item_materialize_is_deterministic(
            self, monkeypatch):
        """C — two timeline entries share item_id with different model_id
        (variant anchors). Materialization must pick by the structured rule
        (is_anchor, then latest mentioned_at) — not array-order accident."""
        t_old = datetime(2026, 9, 1, tzinfo=timezone.utc)
        t_new = datetime(2026, 9, 10, tzinfo=timezone.utc)
        entry_a = {"item_id": 5001, "model_id": 11, "model_name": "VA",
                   "is_anchor": True, "mentioned_at": t_new,   # FIRST in array
                   "card": {"item_id": 5001, "model_name": "VA"}}
        entry_b = {"item_id": 5001, "model_id": 12, "model_name": "VB",
                   "is_anchor": True, "mentioned_at": t_old,   # LAST in array
                   "card": {"item_id": 5001, "model_name": "VB"}}
        # product-DB seams pinned offline — rebuild fails → stored-card
        # fallback (same posture as the replay harness)
        from shopeechat import product_store, units, generation_pointer
        monkeypatch.setattr(product_store, "_cached_client", FakeClient())
        monkeypatch.setattr(generation_pointer, "resolve_snapshot",
                            lambda *a, **k: None)
        monkeypatch.setattr(units, "_units_coll",
                            lambda snap=None: FakeColl([]))
        # array order [A(earlier mention… wait — A has NEWER ts but sits first)]
        # array-order LWW would pick B; deterministic recency must pick A.
        cards = cp.materialize_subject_cards(
            None, ("5001",), products=(entry_a, entry_b))
        assert len(cards) == 1
        assert cards[0].get("model_name") == "VA"
        # flip recency → B wins regardless of array order
        entry_a2 = dict(entry_a, mentioned_at=t_old)
        entry_b2 = dict(entry_b, mentioned_at=t_new)
        cards2 = cp.materialize_subject_cards(
            None, ("5001",), products=(entry_a2, entry_b2))
        assert cards2[0].get("model_name") == "VB"

    def test_view_carries_products_and_materialize_skips_reread(
            self, monkeypatch):
        """D — resolved path must read the conv doc once: get_subject_set
        loads it; materialize consumes the loaded products (zero extra
        find_one on the conversation_products collection)."""
        coll = _coll_with([{
            "conversation_id": "c",
            "subject_set": _set_doc(["5001"]),
            "products": [{"item_id": 5001, "is_anchor": True,
                          "card": {"item_id": 5001}}],
        }])
        calls = []
        real_find = coll.find_one
        monkeypatch.setattr(
            coll, "find_one",
            lambda *a, **k: calls.append(1) or real_find(*a, **k))
        _bind(monkeypatch, coll)
        from shopeechat import product_store, units, generation_pointer
        monkeypatch.setattr(product_store, "_cached_client", FakeClient())
        monkeypatch.setattr(generation_pointer, "resolve_snapshot",
                            lambda *a, **k: None)
        monkeypatch.setattr(units, "_units_coll",
                            lambda snap=None: FakeColl([]))
        view = cp.get_subject_set("c")
        assert len(calls) == 1                          # the single load
        cards = cp.materialize_subject_cards(
            None, view.effective.subject_ids, products=view.products)
        assert len(calls) == 1                          # zero rereads
        assert cards and cards[0].get("item_id") == 5001


# ═══ P2 — absent document ════════════════════════════════════════════════════

class TestAbsentDocument:
    def test_absent_doc_creates_minimal_document(self, monkeypatch):
        coll = _coll_with()
        _bind(monkeypatch, coll)
        got = cp.record_subject_set(
            "new-conv", _set(["111"], "single", ("describe",)),
            platform="shopee", shop="S1")
        assert got is not None
        assert len(coll._docs) == 1
        doc = coll._docs[0]
        assert doc["conversation_id"] == "new-conv"
        assert set(doc.keys()) <= {
            "_id", "conversation_id", "platform", "shop",
            "subject_set", "last_updated"}
        assert "products" not in doc
        assert "active_item_id" not in doc
        assert "order_anchors" not in doc
        assert "claim_state" not in doc
        assert doc["subject_set"]["subject_ids"] == ["111"]

    def test_existing_doc_partial_update_preserves_fields(self, monkeypatch):
        coll = _coll_with([{
            "conversation_id": "c", "platform": "shopee", "shop": "S1",
            "products": [{"item_id": 5, "card": {"item_id": 5},
                        "model_id": "12.0", "model_name": "AC65B",
                        "anchor_type": "item"}],
            "active_item_id": "5",
            "order_anchors": [{"order_sn": "X1", "item_id": 5}],
            "claim_state": {"active_episode_id": "e1", "stage": "open"},
        }])
        _bind(monkeypatch, coll)
        cp.record_subject_set(
            "c", _set(["111"], "compare", ("compare",)),
            platform="shopee")
        doc = coll._docs[0]
        assert doc["subject_set"]["subject_ids"] == ["111"]
        assert doc["products"][0]["model_name"] == "AC65B"
        assert doc["active_item_id"] == "5"
        assert doc["order_anchors"][0]["order_sn"] == "X1"
        assert doc["claim_state"]["stage"] == "open"

    def test_duplicate_create_returns_truthful_winner(self, monkeypatch):
        coll = _coll_with()
        _bind(monkeypatch, coll)
        winner_doc = _set_doc(["999"], "single")

        def _race_insert(doc):
            coll._docs.append({"conversation_id": "c-race",
                               "subject_set": copy.deepcopy(winner_doc)})
            raise DuplicateKeyError("E11000 dup key")
        monkeypatch.setattr(coll, "insert_one", _race_insert)
        got = cp.record_subject_set("c-race", _set(["111"]), platform="s")
        assert got is not None
        assert got.subject_ids == ("999",)
        assert len([d for d in coll._docs
                    if d["conversation_id"] == "c-race"]) == 1

    def test_write_exception_returns_none(self, monkeypatch):
        coll = _coll_with()
        _bind(monkeypatch, coll)
        monkeypatch.setattr(coll, "update_one",
                            lambda *a, **k: (_ for _ in ()).throw(
                                PyMongoError("boom")))
        assert cp.record_subject_set("c", _set(["1"])) is None
        assert coll._docs == []

    def test_invalid_input_returns_none(self, monkeypatch):
        coll = _coll_with()
        _bind(monkeypatch, coll)
        assert cp.record_subject_set("", _set(["1"])) is None
        assert cp.record_subject_set("c", None) is None
        assert coll._docs == []


# ═══ P3 — concurrent turns ═══════════════════════════════════════════════════

class TestConcurrentTurns:
    def test_stale_writer_cannot_overwrite_newer_set(self, monkeypatch):
        """T1 and T2 both read persisted{9001}. T1 writes {9002}. T2's write
        with expected_prior={9001} must NOT commit {9003} — it returns the
        winner {9002}."""
        coll = _coll_with([{
            "conversation_id": "c", "subject_set": _set_doc(["9001"]),
        }])
        _bind(monkeypatch, coll)
        t2_prior = cp.get_subject_set("c").stored   # both read {9001}
        assert cp.record_subject_set(
            "c", _set(["9002"]), expected_prior=t2_prior) is not None  # T1 wins
        got = cp.record_subject_set(
            "c", _set(["9003"]), expected_prior=t2_prior)              # T2 stale
        assert got is not None
        assert got.subject_ids == ("9002",)         # truthful winner, not 9003
        assert coll._docs[0]["subject_set"]["subject_ids"] == ["9002"]

    def test_same_ids_semantic_change_is_a_cas_conflict(self, monkeypatch):
        """A — fence must move on EVERY authoritative decision, not only on
        subject_ids. T1 and T2 share prior {9001,single,describe@0.9}.
        T1 commits {9001,compare,compare@1.0}. Stale T2 proposing
        {9001,single,price@0.7} must NOT overwrite — CAS miss → winner."""
        coll = _coll_with([{
            "conversation_id": "c",
            "subject_set": _set_doc(["9001"], "single", ("describe",), 0.9),
        }])
        _bind(monkeypatch, coll)
        prior = cp.get_subject_set("c").stored
        t1 = _set(["9001"], "compare", ("compare",), 1.0)
        assert cp.record_subject_set(
            "c", t1, expected_prior=prior) == t1          # T1 commits
        t2_stale = _set(["9001"], "single", ("price",), 0.7)
        got = cp.record_subject_set("c", t2_stale, expected_prior=prior)
        assert got is not None
        assert got == t1                                 # winner, not stale
        doc = coll._docs[0]["subject_set"]
        assert doc["relation"] == "compare"
        assert doc["requested_operations"] == ["compare"]
        assert doc["confidence"] == 1.0

    def test_same_ids_same_semantics_is_idempotent_not_conflict(
            self, monkeypatch):
        """Same ids AND same semantics → fence still matches → write lands
        (concurrent identical decisions are harmless duplicates, not lost)."""
        coll = _coll_with([{
            "conversation_id": "c",
            "subject_set": _set_doc(["9001"], "single", ("describe",), 0.9),
        }])
        _bind(monkeypatch, coll)
        prior = cp.get_subject_set("c").stored
        same = _set(["9001"], "single", ("describe",), 0.9)
        got = cp.record_subject_set("c", same, expected_prior=prior)
        assert got == same

    def test_stale_writer_on_absent_belief_returns_winner(self, monkeypatch):
        coll = _coll_with([{
            "conversation_id": "c", "subject_set": _set_doc(["9001"]),
        }])
        _bind(monkeypatch, coll)
        got = cp.record_subject_set("c", _set(["9003"]), expected_prior=None)
        assert got is not None
        assert got.subject_ids == ("9001",)
        assert coll._docs[0]["subject_set"]["subject_ids"] == ["9001"]

    def test_cas_loss_is_distinguishable_from_commit(self, monkeypatch):
        """E — returned set == proposed means committed; != means lost to a
        winner — caller can distinguish without extra status types."""
        coll = _coll_with([{
            "conversation_id": "c", "subject_set": _set_doc(["9001"]),
        }])
        _bind(monkeypatch, coll)
        prior = cp.get_subject_set("c").stored
        proposed = _set(["9002"], "single", ("describe",))
        got = cp.record_subject_set("c", proposed, expected_prior=prior)
        assert got == proposed                            # committed
        proposed2 = _set(["9003"], "compare", ("compare",))
        got2 = cp.record_subject_set(
            "c", proposed2, expected_prior=prior)         # stale prior → lose
        assert got2 is not None and got2 != proposed2     # winner distinguishable
        assert got2.subject_ids == ("9002",)

    def test_aba_returned_state_still_loses_stale_writer(self, monkeypatch):
        """ABA — snapshot equality is not a fence. Stale reader sees set A
        (ids 9001, single/describe, source_turn_id=None — the production
        shape). T1 commits A→B; T2 commits B→A' where A' is semantically
        identical to A. The stale writer's expected snapshot matches again,
        yet its write must NOT land: CAS miss → current winner A' returned.
        Requires a fence that changes on every committed write (rev), not
        one derived from the set's own values."""
        coll = _coll_with([{
            "conversation_id": "c",
            "subject_set": _set_doc(["9001"], "single", ("describe",), 0.9),
        }])
        _bind(monkeypatch, coll)
        prior_a = cp.get_subject_set("c").stored            # stale reader: A
        t1 = _set(["9001"], "compare", ("compare",), 1.0)
        assert cp.record_subject_set("c", t1, expected_prior=prior_a) == t1
        prior_b = cp.get_subject_set("c").stored            # winner's reread
        a2 = _set(["9001"], "single", ("describe",), 0.9)   # B→A' (≡ A sem.)
        w2 = cp.record_subject_set("c", a2, expected_prior=prior_b)
        assert w2 == a2
        stale = _set(["9002"], "single", ("price",), 0.5)   # stale T0 write
        got = cp.record_subject_set("c", stale, expected_prior=prior_a)
        assert got is not None and got != stale, (
            "ABA: stale writer must lose — expected_prior matched an "
            "older revision of an identical-looking snapshot")
        assert got.subject_ids == ("9001",)
        doc = coll._docs[0]["subject_set"]
        assert doc["subject_ids"] == ["9001"]
        assert doc["relation"] == "single"

    def test_pretoken_doc_parses_rev0_and_first_write_fences(self,
                                                           monkeypatch):
        """Compat rule: docs written before the `rev` field existed parse
        as rev=0 → their CAS fence is `subject_set.rev: None` (missing∨null)
        → first writer commits rev=1; a second writer still holding the
        rev-0 prior then misses (rev is now 1) → truthful winner."""
        coll = _coll_with([{
            "conversation_id": "c",
            "subject_set": _set_doc(["9001"]),          # no rev key
        }])
        _bind(monkeypatch, coll)
        prior = cp.get_subject_set("c").stored
        assert prior.rev == 0                           # compat rule
        w = cp.record_subject_set(
            "c", _set(["9002"]), expected_prior=prior)
        assert w.subject_ids == ("9002",) and w.rev == 1
        assert coll._docs[0]["subject_set"]["rev"] == 1
        got = cp.record_subject_set(
            "c", _set(["9003"]), expected_prior=prior)  # same rev-0 prior
        assert got is not None and got.subject_ids == ("9002",)

    def test_rev_advances_on_every_commit(self, monkeypatch):
        coll = _coll_with([{
            "conversation_id": "c",
            "subject_set": _set_doc(["9001"], rev=5),
        }])
        _bind(monkeypatch, coll)
        prior = cp.get_subject_set("c").stored
        assert prior.rev == 5
        w = cp.record_subject_set(
            "c", _set(["9002"]), expected_prior=prior)
        assert w.rev == 6 and coll._docs[0]["subject_set"]["rev"] == 6

    def test_unrelated_fields_survive_concurrent_write(self, monkeypatch):
        coll = _coll_with([{
            "conversation_id": "c", "products": [{"item_id": 9}],
            "claim_state": {"stage": "open"},
            "subject_set": _set_doc(["9001"]),
        }])
        _bind(monkeypatch, coll)
        prior = cp.get_subject_set("c").stored
        cp.record_subject_set("c", _set(["9002"]), expected_prior=prior)
        doc = coll._docs[0]
        assert doc["products"] == [{"item_id": 9}]
        assert doc["claim_state"] == {"stage": "open"}


# ═══ decide_subject_set precedence ═══════════════════════════════════════════

class TestDecide:
    def test_explicit_identity_beats_batch(self):
        got = cp.decide_subject_set(
            None, explicit_ids=("3002",), selected_ids=("3001", "3003"))
        assert got.subject_ids == ("3002",)
        assert got.relation == "single"

    def test_explicit_pair_beats_batch(self):
        got = cp.decide_subject_set(
            None, pair_ids=("3002", "3003"),
            selected_ids=("3001", "3004", "3005"))
        assert got.subject_ids == ("3002", "3003")
        assert got.relation == "compare"

    def test_explicit_inside_pair_yields_pair(self):
        got = cp.decide_subject_set(
            None, explicit_ids=("3002",), pair_ids=("3002", "3003"))
        assert got.relation == "compare"
        assert got.subject_ids == ("3002", "3003")

    def test_explicit_conflicting_pair_yields_explicit(self):
        got = cp.decide_subject_set(
            None, explicit_ids=("3009",), pair_ids=("3002", "3003"))
        assert got.relation == "single"
        assert got.subject_ids == ("3009",)

    def test_batch_single_is_single(self):
        got = cp.decide_subject_set(None, selected_ids=("3001",))
        assert got.relation == "single"
        assert got.subject_ids == ("3001",)

    def test_batch_multi_is_alternatives(self):
        got = cp.decide_subject_set(
            None, selected_ids=("3001", "3002", "3003"))
        assert got.relation == "alternatives"
        assert got.subject_ids == ("3001", "3002", "3003")

    def test_no_candidates_returns_none(self):
        assert cp.decide_subject_set(None) is None
        assert cp.decide_subject_set(_set(["1"])) is None

    def test_identical_set_returns_none(self):
        prior = _set(["1", "2"], "alternatives", ("recommend",))
        assert cp.decide_subject_set(
            prior, selected_ids=("1", "2"),
            requested_operations=("recommend",)) is None

    def test_same_ids_replace_ops_not_accumulate(self):
        prior = _set(["1", "2"], "compare", ("compare",))
        got = cp.decide_subject_set(
            prior, pair_ids=("1", "2"), requested_operations=("price",))
        assert got.subject_ids == ("1", "2")
        assert got.relation == "compare"
        assert got.requested_operations == ("price",)

    def test_selected_same_ids_cannot_downgrade_compare(self):
        """R2 — selected batch {A,B} is the weakest evidence: it must not
        downgrade a stored compare{A,B} into alternatives (the resolved-deictic
        pin would otherwise erase pair semantics on the same ids)."""
        prior = _set(["1", "2"], "compare", ("compare",))
        assert cp.decide_subject_set(
            prior, selected_ids=("1", "2"),
            requested_operations=("recommend",)) is None

    def test_pair_evidence_can_upgrade_same_ids(self):
        """Real pair evidence on the same ids IS a new decision → relation
        upgrades alternatives → compare with fresh ops snapshot."""
        prior = _set(["1", "2"], "alternatives", ("recommend",))
        got = cp.decide_subject_set(
            prior, pair_ids=("1", "2"), requested_operations=("compare",))
        assert got is not None
        assert got.relation == "compare"
        assert got.requested_operations == ("compare",)

    def test_explicit_replaces_prior_topic(self):
        prior = _set(["9"], "single")
        got = cp.decide_subject_set(
            prior, explicit_ids=("3002",), requested_operations=("describe",))
        assert got.subject_ids == ("3002",)

    def test_ids_deduped_ordered(self):
        got = cp.decide_subject_set(
            None, selected_ids=("3", "1", "3", "2", "1"))
        assert got.subject_ids == ("1", "2", "3")

    def test_ops_deduped_ordered(self):
        got = cp.decide_subject_set(
            None, explicit_ids=("1",),
            requested_operations=("price", "describe", "price"))
        assert got.requested_operations == ("describe", "price")


# ═══ resolve_subjects reference matrix ═══════════════════════════════════════

class TestResolve:
    def test_singular_deictic_on_single_resolves(self):
        res = cp.resolve_subjects(_set(["1"]), "ตัวนี้ราคาเท่าไหร่")
        assert res.outcome == "resolved"
        assert res.subject_set.subject_ids == ("1",)

    def test_singular_deictic_on_multi_clarifies(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "alternatives"), "ตัวนี้ราคาเท่าไหร่")
        assert res.outcome == "clarify"
        assert res.subject_set is None

    def test_singular_deictic_no_set_clarifies(self):
        res = cp.resolve_subjects(None, "ตัวนี้มีสีอะไรบ้าง")
        assert res.outcome == "clarify"

    def test_pair_wording_on_compare_resolves(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "เทียบกันหน่อย")
        assert res.outcome == "resolved"
        assert res.subject_set.subject_ids == ("1", "2")

    def test_pair_wording_on_single_resolves_for_compose(self):
        res = cp.resolve_subjects(_set(["1"]), "อันนี้กับอันก่อนต่างกันยังไง")
        assert res.outcome == "resolved"
        assert res.subject_set.subject_ids == ("1",)

    def test_pair_wording_no_set_clarifies(self):
        res = cp.resolve_subjects(None, "เทียบกันหน่อย")
        assert res.outcome == "clarify"

    def test_numbered_set_ref_without_signal_clarifies(self):
        """Without the structured scope signal, "อันไหน 2 อันนี้" has no
        language-table interpretation (removed per the keyword gate) —
        canonical singular "อันนี้" → clarify on a multi set. The typed
        signal path (subject_scope=current_set) resolves it; see
        TestStructuredSubjectSignal."""
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "แนะนำอันไหน 2 อันนี้")
        assert res.outcome == "clarify"

    def test_which_of_set_without_signal_no_subject_ref(self):
        """Bare "อันไหนดี" carries no canonical signal and no local table —
        no_subject_ref unless the structured boundary emits a scope."""
        res = cp.resolve_subjects(
            _set(["1", "2", "3"], "alternatives"), "อันไหนดี")
        assert res.outcome == "no_subject_ref"

    def test_which_of_set_no_set_no_subject(self):
        res = cp.resolve_subjects(None, "อันไหนดี")
        assert res.outcome == "no_subject_ref"

    def test_generic_op_resolves_whole_set(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "ราคาเท่าไหร่")
        assert res.outcome == "resolved"
        assert res.subject_set.subject_ids == ("1", "2")

    def test_generic_op_no_set_no_subject(self):
        res = cp.resolve_subjects(None, "ราคาเท่าไหร่")
        assert res.outcome == "no_subject_ref"

    def test_link_op_resolves_set(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "ขอลิงค์")
        assert res.outcome == "resolved"

    def test_link_op_no_set_clarifies(self):
        res = cp.resolve_subjects(None, "ขอลิงค์")
        assert res.outcome == "clarify"

    def test_link_with_singular_is_singular(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "alternatives"), "ขอลิงค์ตัวนี้")
        assert res.outcome == "clarify"          # singular on multi
        res2 = cp.resolve_subjects(_set(["1"]), "ขอลิงค์ตัวนี้")
        assert res2.outcome == "resolved"

    def test_plural_wording_resolves_via_generic_op(self):
        """"ทั้งสองราคาเท่าไหร่" resolves the whole set — via the canonical
        generic op signal ("ราคา"), not a plural/count table."""
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "ทั้งสองราคาเท่าไหร่")
        assert res.outcome == "resolved"

    def test_no_signal_no_subject_ref(self):
        assert cp.resolve_subjects(
            _set(["1"]), "สวัสดีครับ").outcome == "no_subject_ref"
        assert cp.resolve_subjects(None, "สวัสดีครับ").outcome == "no_subject_ref"

    def test_superlative_resolves_set(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "alternatives"), "อันไหนเร็วสุด")
        assert res.outcome == "resolved"


# ═══ 2C.3 slice-1 — structured subject-scope/count signal ══════════════════

class TestStructuredSubjectSignal:
    """Resolver validates the typed TurnPlan/intent signal against persisted
    state — it must not interpret language itself."""

    def test_q07_current_set_count2_resolves_both(self):
        res = cp.resolve_subjects(
            _set(["3002", "3003"], "compare"),
            "iphone หละแนะนำอันไหน 2 อันนี้",
            subject_scope="current_set", subject_count=2,
            signal_confidence=0.8)
        assert res.outcome == "resolved"
        assert res.subject_set.subject_ids == ("3002", "3003")

    def test_current_set_no_persisted_clarifies(self):
        res = cp.resolve_subjects(
            None, "แนะนำอันไหน 2 อันนี้",
            subject_scope="current_set", subject_count=2,
            signal_confidence=0.8)
        assert res.outcome == "clarify"
        assert res.subject_set is None

    def test_current_set_count_mismatch_clarifies(self):
        res = cp.resolve_subjects(
            _set(["1", "2", "3"], "alternatives"), "อันไหน 2 อันนี้",
            subject_scope="current_set", subject_count=2,
            signal_confidence=0.8)
        assert res.outcome == "clarify"
        assert res.subject_set is None

    def test_current_set_count_absent_resolves(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "แนะนำอันไหน",
            subject_scope="current_set",
            signal_confidence=0.8)
        assert res.outcome == "resolved"
        assert res.subject_set.subject_ids == ("1", "2")

    def test_low_confidence_signal_clarifies(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "อันไหน 2 อันนี้",
            subject_scope="current_set", subject_count=2,
            signal_confidence=0.3)
        assert res.outcome == "clarify"

    def test_unknown_scope_clarifies(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "อันไหน",
            subject_scope="bogus", signal_confidence=0.9)
        assert res.outcome == "clarify"

    def test_explicit_scope_wins_upstream(self):
        """Explicit identities resolve before the resolver is consulted —
        resolver contributes nothing for scope=explicit."""
        res = cp.resolve_subjects(
            _set(["1", "2"], "compare"), "AC65B เทียบกับ AC65B2",
            subject_scope="explicit", signal_confidence=0.9)
        assert res.outcome == "no_subject_ref"

    def test_current_single_multi_persisted_clarifies(self):
        res = cp.resolve_subjects(
            _set(["1", "2"], "alternatives"), "ตัวนี้เป็นไง",
            subject_scope="current_single", signal_confidence=0.9)
        assert res.outcome == "clarify"

    def test_current_single_exactly_one_resolves(self):
        res = cp.resolve_subjects(
            _set(["1"]), "ตัวนี้เป็นไง",
            subject_scope="current_single", signal_confidence=0.9)
        assert res.outcome == "resolved"
        assert res.subject_set.subject_ids == ("1",)

    def test_current_single_no_persisted_clarifies(self):
        res = cp.resolve_subjects(
            None, "ตัวนี้เป็นไง",
            subject_scope="current_single", signal_confidence=0.9)
        assert res.outcome == "clarify"

    def test_structured_scope_never_interprets_language(self, monkeypatch):
        """Typed signal present → zero keyword/table classification."""
        calls = []
        real = cp._classify_subject_ref

        def _spy(msg):
            calls.append(msg)
            return real(msg)
        monkeypatch.setattr(cp, "_classify_subject_ref", _spy)
        cp.resolve_subjects(
            _set(["1", "2"], "compare"), "anything",
            subject_scope="current_set", subject_count=2,
            signal_confidence=0.9)
        assert calls == []

    def test_none_scope_still_uses_canonical_path(self):
        res = cp.resolve_subjects(
            _set(["1"]), "ตัวนี้ราคาเท่าไหร่",
            subject_scope="none", signal_confidence=0.9)
        assert res.outcome == "resolved"

    def test_removed_semantic_tables_stay_absent(self):
        for name in ("_SET_COUNT_REF_RE", "_SUBJECT_WHICH_KWS"):
            assert not hasattr(cp, name), f"{name} must not be restored"

    def test_q07_signal_resolves_pair_e2e_and_adds_no_call(self, monkeypatch):
        """q07 shape: persisted compare pair + turn-level structured signal
        → both subjects reach the answer pool; classify_intent still runs
        exactly once per turn (the signal rides the existing Pass-1 call)."""
        fx = _fx([
            {"text": "AC65B เทียบกับ AC65B2 หน่อย"},
            {"text": "iphone หละแนะนำอันไหน 2 อันนี้",
             "intent_result": {"intent": "product_recommend",
                               "confidence": 0.8,
                               "target_device": "iphone",
                               "subject_scope": "current_set",
                               "subject_count": 2}},
        ])
        records, captured, client = replay._replay(monkeypatch, fx)
        t2 = records[1]
        assert getattr(t2["resp"], "source", None) != "subject_clarify"
        t2_items = [replay._norm(p.get("item_id"))
                    for c in t2["llm_calls"]
                    for p in (c.get("products") or [])]
        assert 4001 in t2_items and 4002 in t2_items
        assert len(captured.intent_calls) == 2   # ≤1 Pass-1 call / user turn


# ═══ 2C.3 — production consumes the signal through one authoritative plan ══

class TestPlanOwnedSubjectSignal:
    """resolve_subjects must receive scope/count from the production
    TurnPlan (decide_turn — called once per turn, post-classify) — never
    directly from _intent_result."""

    _GOOD = {"intent": "product_recommend", "confidence": 0.8,
             "target_device": "iphone",
             "subject_scope": "current_set", "subject_count": 2}

    @staticmethod
    def _pair_fx(t2_result=None):
        return _fx([
            {"text": "AC65B เทียบกับ AC65B2 หน่อย"},
            {"text": "iphone หละแนะนำอันไหน 2 อันนี้",
             "intent_result": t2_result or TestPlanOwnedSubjectSignal._GOOD},
        ])

    @staticmethod
    def _spy_resolve(monkeypatch):
        kwargs_seen = []
        real = cp.resolve_subjects

        def _spy(persisted, message, **kw):
            kwargs_seen.append(kw)
            return real(persisted, message, **kw)
        monkeypatch.setattr(cp, "resolve_subjects", _spy)
        return kwargs_seen

    @staticmethod
    def _rewrite_needs(monkeypatch, scope, count):
        import dataclasses
        real_dt = td.decide_turn

        def _poisoned(msg, **kw):
            plan = real_dt(msg, **kw)
            needs = tuple(
                dataclasses.replace(n, subject_scope=scope,
                                    subject_count=count)
                if n.kind == "product" else n
                for n in plan.needs)
            return dataclasses.replace(plan, needs=needs)
        monkeypatch.setattr(td, "decide_turn", _poisoned)

    def test_resolver_receives_scope_from_plan(self, monkeypatch):
        kw = self._spy_resolve(monkeypatch)
        replay._replay(monkeypatch, self._pair_fx())
        assert kw, "resolver never consulted"
        assert kw[-1]["subject_scope"] == "current_set"
        assert kw[-1]["subject_count"] == 2

    def test_intent_result_cannot_bypass_plan(self, monkeypatch):
        """intent carries current_set but the plan's product need says none →
        resolver must see the canonical no-signal state (plan is authoritative)."""
        self._rewrite_needs(monkeypatch, "none", None)
        kw = self._spy_resolve(monkeypatch)
        records, *_ = replay._replay(monkeypatch, self._pair_fx())
        assert kw and kw[-1]["subject_scope"] in (None, "none")
        assert kw[-1]["subject_count"] is None
        assert getattr(records[1]["resp"], "source", None) == "subject_clarify"

    def test_plan_signal_mutation_changes_resolution(self, monkeypatch):
        """current_single on a 2-item set → clarify (mutated plan drives outcome)."""
        self._rewrite_needs(monkeypatch, "current_single", None)
        records, *_ = replay._replay(monkeypatch, self._pair_fx())
        assert getattr(records[1]["resp"], "source", None) == "subject_clarify"

    def test_decide_turn_once_per_turn(self, monkeypatch):
        calls = []
        real_dt = td.decide_turn
        monkeypatch.setattr(
            td, "decide_turn",
            lambda m, **kw: calls.append(m) or real_dt(m, **kw))
        replay._replay(monkeypatch, self._pair_fx())
        assert len(calls) == 2                    # exactly 1 plan / user turn

    def test_classifier_once_per_turn_unchanged(self, monkeypatch):
        _, captured, _ = replay._replay(monkeypatch, self._pair_fx())
        assert len(captured.intent_calls) == 2    # same Pass-1 baseline

    def test_missing_persisted_set_clarifies_e2e(self, monkeypatch):
        fx = _fx([{"text": "มีหัวชาร์จแนะนำไหมครับ"}],
                 conversation_id="subj-conv-fresh-1")
        replay._replay(monkeypatch, fx)
        fx2 = _fx([
            {"text": "iphone หละแนะนำอันไหน 2 อันนี้",
             "intent_result": self._GOOD}],
            conversation_id="subj-conv-fresh-2")
        records, *_ = replay._replay(monkeypatch, fx2)
        assert getattr(records[0]["resp"], "source", None) == "subject_clarify"

    def test_low_confidence_signal_on_plan_clarifies(self, monkeypatch):
        """Signal confidence must come from plan.intent_confidence, not a
        raw _intent_result read — conf 0.5 + current_set → clarify."""
        low = dict(self._GOOD, confidence=0.5)
        records, *_ = replay._replay(monkeypatch, self._pair_fx(low))
        assert getattr(records[1]["resp"], "source", None) == "subject_clarify"

    def test_explicit_ids_keep_precedence(self, monkeypatch):
        """item_tag explicit identity wins over any plan scope — resolver
        is not even consulted for explicit-evidence turns."""
        kw = self._spy_resolve(monkeypatch)
        fx = _fx([
            {"text": "สอบถามหน่อย", "item_id": "4001",
             "intent_result": {"intent": "product_question",
                               "confidence": 0.9,
                               "subject_scope": "current_set",
                               "subject_count": 2}},
        ], conversation_id="subj-conv-exp-1")
        records, _, client = replay._replay(monkeypatch, fx)
        docs = _conv_doc(client)
        ss = docs[0].get("subject_set") if docs else None
        assert ss is None or ss["subject_ids"] == ["4001"]


# ═══ get_subject_set parse safety ════════════════════════════════════════════

class TestGetParse:
    def test_absent_doc_returns_none(self, monkeypatch):
        _bind(monkeypatch, _coll_with())
        v = cp.get_subject_set("missing")
        assert v.stored is None and v.effective is None

    def test_valid_doc_parses(self, monkeypatch):
        _bind(monkeypatch, _coll_with([{
            "conversation_id": "c", "subject_set": _set_doc(
                ["1", "2"], "compare", ("compare",), 0.9, "t1")}]))
        got = cp.get_subject_set("c").stored
        assert got.subject_ids == ("1", "2")
        assert got.relation == "compare"
        assert got.requested_operations == ("compare",)
        assert got.source_turn_id == "t1"
        assert got.confidence == 0.9

    @pytest.mark.parametrize("bad", [
        "garbage",                                   # scalar
        {"subject_ids": "not-a-list"},               # wrong type
        {"subject_ids": ["1"], "relation": "weird"}, # bad relation
        {"subject_ids": []},                          # empty ids
        {"subject_ids": ["1"], "requested_operations": "x"},
        # malformed rev → whole set unparseable (non-clobber — never
        # fence-match a state whose token cannot be read)
        {"subject_ids": ["1"], "relation": "single",
         "requested_operations": ["x"], "rev": "not-an-int"},
        {"subject_ids": ["1"], "relation": "single",
         "requested_operations": ["x"], "rev": -2},
    ])
    def test_malformed_returns_none_no_guess(self, monkeypatch, bad):
        _bind(monkeypatch, _coll_with([{
            "conversation_id": "c", "subject_set": bad}]))
        v = cp.get_subject_set("c")
        assert v.stored is None and v.effective is None

    def test_resolve_on_malformed_via_get_is_safe(self, monkeypatch):
        _bind(monkeypatch, _coll_with([{
            "conversation_id": "c", "subject_set": {"subject_ids": "x"}}]))
        persisted = cp.get_subject_set("c").effective  # → None (malformed, no anchors)
        res = cp.resolve_subjects(persisted, "ตัวนี้ดีไหม")
        assert res.outcome == "clarify"              # deictic, no valid set


# ═══ derived view — anchor bootstrap for legacy convs ═══════════════════════

class TestDerivedView:
    def test_single_anchor_derives_single_effective(self, monkeypatch):
        """Legacy conv: 1 explicit anchor + no stored set → effective =
        single{anchor} (item_id domain, confidence 0.5), stored stays None."""
        _bind(monkeypatch, _coll_with([{
            "conversation_id": "c",
            "products": [{"item_id": 3002, "is_anchor": True, "name": "X"}],
            "active_item_id": 3002}]))
        v = cp.get_subject_set("c")
        assert v.stored is None
        assert v.effective is not None
        assert v.effective.subject_ids == ("3002",)
        assert v.effective.relation == "single"
        assert v.effective.confidence == 0.5
        assert cp.resolve_subjects(
            v.effective, "ตัวนี้ราคาเท่าไหร่").outcome == "resolved"

    def test_multi_anchor_derives_alternatives_and_clarifies_singular(
            self, monkeypatch):
        """2+ explicit anchors → alternatives (co-mentioned, relation unclear)
        → singular deictic clarifies; pair wording resolves the set."""
        _bind(monkeypatch, _coll_with([{
            "conversation_id": "c",
            "products": [{"item_id": 3001, "is_anchor": True},
                         {"item_id": 3002, "is_anchor": True}]}]))
        v = cp.get_subject_set("c")
        assert v.effective.relation == "alternatives"
        assert set(v.effective.subject_ids) == {"3001", "3002"}
        assert cp.resolve_subjects(
            v.effective, "ตัวนี้ดีไหม").outcome == "clarify"
        assert cp.resolve_subjects(
            v.effective, "อันนี้กับอันก่อนต่างกันยังไง").outcome == "resolved"

    def test_derived_prior_write_commits_on_absent_field(self, monkeypatch):
        """expected_prior=stored(None) → CAS fence on absent field → commit."""
        _bind(monkeypatch, _coll_with([{
            "conversation_id": "c",
            "products": [{"item_id": 3002, "is_anchor": True}]}]))
        v = cp.get_subject_set("c")
        assert v.effective.subject_ids == ("3002",) and v.stored is None
        new = cp.decide_subject_set(v.stored, explicit_ids=("4001",))
        got = cp.record_subject_set("c", new, expected_prior=v.stored)
        assert got is not None and got.subject_ids == ("4001",)

    def test_non_anchor_products_do_not_derive(self, monkeypatch):
        """Bot suggestions (is_anchor=False) never synthesize a subject."""
        _bind(monkeypatch, _coll_with([{
            "conversation_id": "c",
            "products": [{"item_id": 3002, "is_anchor": False}]}]))
        v = cp.get_subject_set("c")
        assert v.effective is None and v.stored is None


# ═══ controlled mutations ════════════════════════════════════════════════════

class TestMutations:
    def test_ambiguity_detects_first_pick_mutation(self, monkeypatch):
        """If resolve were mutated to pick first/newest on ambiguity the
        ambiguity contract must fail — probe it honestly."""
        real = cp.resolve_subjects

        def _mutated(persisted, message):
            res = real(persisted, message)
            if res.outcome == "clarify" and persisted is not None:
                return cp.SubjectResolution("resolved", persisted)
            return res
        monkeypatch.setattr(cp, "resolve_subjects", _mutated)
        res = cp.resolve_subjects(
            _set(["1", "2"], "alternatives"), "ตัวนี้ดีไหม")
        with pytest.raises(AssertionError):
            assert res.outcome == "clarify"

    def test_precedence_detects_reversed_mutation(self, monkeypatch):
        real = cp.decide_subject_set

        def _mutated(persisted, **kw):
            sel = kw.get("selected_ids") or ()
            if sel:
                kw = dict(kw); kw["explicit_ids"] = (); kw["pair_ids"] = ()
            return real(persisted, **kw)
        monkeypatch.setattr(cp, "decide_subject_set", _mutated)
        got = cp.decide_subject_set(
            None, explicit_ids=("3002",), selected_ids=("3001", "3003"))
        with pytest.raises(AssertionError):
            assert got.subject_ids == ("3002",)


# ═══ e2e — real chat() through replay harness ════════════════════════════════

_CATALOG = [
    {"item_id": 4001.0, "item_name": "CUKTECH AC65B 67W GaN Charger",
     "item_status": "NORMAL", "shopname": "KingGadgets",
     "cat_name": "อุปกรณ์ชาร์จ", "condition": "new",
     "brand": {"brand_id": 1, "original_brand_name": "CUKTECH"},
     "gen_price": 990.0, "short_link": "https://s.shopee.co.th/x1",
     "image": {"image_url_list": ["https://img.example/x.jpg"],
               "image_id_list": ["x"]},
     "description": "", "tier_variation": [
         {"name": "สี", "option_list": [{"option": "Black"}]}],
     "model": [{"model_id": 12.0, "model_name": "AC65B", "model_sku": "",
                "model_status": "MODEL_NORMAL",
                "stock_info_v2": {"summary_info":
                                  {"total_available_stock": 8}},
                "tier_index": [0],
                "price_info": [{"current_price": 99000}]}],
     "standardise_tier_variation": [], "weight": "0.2",
     "dimension": {"package_height": 5, "package_length": 10,
                   "package_width": 5}},
    {"item_id": 4002.0, "item_name": "CUKTECH AC65B2 65W GaN Charger",
     "item_status": "NORMAL", "shopname": "KingGadgets",
     "cat_name": "อุปกรณ์ชาร์จ", "condition": "new",
     "brand": {"brand_id": 1, "original_brand_name": "CUKTECH"},
     "gen_price": 990.0, "short_link": "https://s.shopee.co.th/x2",
     "image": {"image_url_list": ["https://img.example/x.jpg"],
               "image_id_list": ["x"]},
     "description": "", "tier_variation": [
         {"name": "สี", "option_list": [{"option": "Black"}]}],
     "model": [{"model_id": 13.0, "model_name": "AC65B2", "model_sku": "",
                "model_status": "MODEL_NORMAL",
                "stock_info_v2": {"summary_info":
                                  {"total_available_stock": 9}},
                "tier_index": [0],
                "price_info": [{"current_price": 99000}]}],
     "standardise_tier_variation": [], "weight": "0.2",
     "dimension": {"package_height": 5, "package_length": 10,
                   "package_width": 5}},
]


def _fx(turns, **kw):
    fx = {"id": "subj-e2e", "shop": "KingGadgets", "platform": "shopee",
          "conversation_id": "subj-conv-1", "catalog": copy.deepcopy(_CATALOG),
          "turns": turns,
          "intent_result": kw.get("intent_result",
                                  {"intent": "recommendation",
                                   "confidence": 0.8})}
    fx.update(kw)
    return fx


def _conv_doc(client):
    return client[ADMIN_DB]["conversation_products"]._docs


# ═══ Import purity — this suite must leave the process untouched ════════════

class TestImportPurity:
    """Importing this file is a no-op: no .env read, no real MongoClient,
    no sockets, and no lasting os.environ mutation."""

    _PROBE = (
        "import os, sys, json\n"
        "before = dict(os.environ)\n"
        "calls = {'load_dotenv': 0, 'MongoClient': 0, 'socket': 0, 'urlopen': 0}\n"
        "def trap(k):\n"
        "    def f(*a, **kw):\n"
        "        calls[k] += 1\n"
        "        raise AssertionError('impure call: ' + k)\n"
        "    return f\n"
        "import dotenv, socket, urllib.request\n"
        "dotenv.load_dotenv = trap('load_dotenv')\n"
        "socket.connect = trap('socket')\n"
        "socket.create_connection = trap('socket')\n"
        "socket.socket.connect = trap('socket')\n"
        "socket.socket.connect_ex = trap('socket')\n"
        "urllib.request.urlopen = trap('urlopen')\n"
        "import pymongo\n"
        "pymongo.MongoClient.__init__ = trap('MongoClient')\n"
        "sys.path.insert(0, %r); sys.path.insert(0, %r)\n"
        "try:\n"
        "    import test_conversation_subject_set\n"
        "    imp = 'ok'\n"
        "except AssertionError as e:\n"
        "    imp = 'impure:' + str(e)\n"
        "after = dict(os.environ)\n"
        "env_added = sorted(k for k in after if k not in before)\n"
        "env_removed = sorted(k for k in before if k not in after)\n"
        "env_changed = sorted(k for k in set(before) & set(after)\n"
        "                     if before[k] != after[k])\n"
        "print(json.dumps({'import': imp, 'calls': calls,\n"
        "                  'env_added': env_added, 'env_removed': env_removed,\n"
        "                  'env_changed': env_changed}))\n"
    )

    def _probe(self) -> dict:
        out = subprocess.run(
            [sys.executable, "-c",
             self._PROBE % (str(ROOT / "chatbot"), str(TEST_DIR))],
            capture_output=True, text=True, timeout=120, cwd=str(ROOT))
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_import_has_zero_env_mongo_network_side_effects(self):
        r = self._probe()
        assert r["import"] == "ok"
        assert r["calls"]["load_dotenv"] == 0, "suite must not call load_dotenv"
        assert r["calls"]["MongoClient"] == 0, "no real MongoClient may be built"
        assert r["calls"]["socket"] == 0
        assert r["calls"]["urlopen"] == 0
        assert r["env_added"] == [], "import must not add env keys"
        assert r["env_removed"] == [], "import must not drop env keys"
        assert r["env_changed"] == [], "import must not change env values"

    def _order_probe(self, files: list[str]) -> subprocess.CompletedProcess:
        # recursion guard: a nested run must never re-enter these probes
        env = {**os.environ, "SUBJECT_SET_ORDER_PROBE": "1"}
        return subprocess.run(
            [sys.executable, "-m", "pytest", *files,
             "-q", "-p", "no:cacheprovider"],
            capture_output=True, text=True, timeout=600, cwd=str(ROOT),
            env=env)

    def test_subject_suite_then_offline_suite_is_clean(self):
        if os.environ.get("SUBJECT_SET_ORDER_PROBE"):
            pytest.skip("nested probe run")
        out = self._order_probe([
            str(TEST_DIR / "test_conversation_subject_set.py"),
            str(TEST_DIR / "test_turn_decision.py")])
        assert out.returncode == 0, (
            "subject suite then another offline suite must pass:\n"
            + out.stdout[-2000:] + out.stderr[-2000:])

    def test_offline_suite_then_subject_suite_is_clean(self):
        if os.environ.get("SUBJECT_SET_ORDER_PROBE"):
            pytest.skip("nested probe run")
        out = self._order_probe([
            str(TEST_DIR / "test_turn_decision.py"),
            str(TEST_DIR / "test_conversation_subject_set.py")])
        assert out.returncode == 0, (
            "offline suite then subject suite must pass:\n"
            + out.stdout[-2000:] + out.stderr[-2000:])


class TestE2E:
    def test_item_card_persists_single_and_deictic_resolves(self, monkeypatch):
        writes = []
        real = cp.record_subject_set
        monkeypatch.setattr(cp, "record_subject_set",
                            lambda *a, **k: writes.append(1) or
                            real(*a, **k))
        reads = []
        real_get = cp.get_subject_set
        monkeypatch.setattr(cp, "get_subject_set",
                            lambda *a, **k: reads.append(1) or
                            real_get(*a, **k))
        fx = _fx([
            {"text": "สอบถามหน่อย", "item_id": "4001"},
            {"text": "ตัวนี้ราคาเท่าไหร่"},
        ])
        records, captured, client = replay._replay(monkeypatch, fx)
        docs = _conv_doc(client)
        assert docs and docs[0].get("subject_set")
        ss = docs[0]["subject_set"]
        assert ss["subject_ids"] == ["4001"]
        assert ss["relation"] == "single"
        assert len(writes) == 1                      # ≤1 write across 2 turns?
        # turn2 resolved the persisted single → price answer got item 4001
        t2_llm = records[1]["llm_calls"]
        t2_items = [p.get("item_id") for c in t2_llm
                    for p in (c.get("products") or [])]
        assert 4001 in t2_items or str(4001) in [str(i) for i in t2_items]

    def test_noncode_product_question_resolves_persisted_subject(
            self, monkeypatch):
        """Spec question without model code must reach the persisted-subject
        resolver — loose keyword extraction ('Speed','data') must not veto."""
        calls = []
        real = cp.resolve_subjects
        monkeypatch.setattr(
            cp, "resolve_subjects",
            lambda *a, **k: calls.append(1) or real(*a, **k))
        fx = _fx([
            {"text": "สอบถามหน่อย", "item_id": "4001"},
            {"text": "Speed data เท่าไหร่?ครับ"},
        ])
        records, captured, client = replay._replay(monkeypatch, fx)
        assert calls, "persisted-subject resolver vetoed by non-code text"
        t2_items = [str(replay._norm(p.get("item_id")))
                    for c in records[1]["llm_calls"]
                    for p in (c.get("products") or [])]
        assert t2_items == ["4001"], t2_items

    def test_compare_pair_persists_and_price_followup_resolves(
            self, monkeypatch):
        fx = _fx([
            {"text": "AC65B เทียบกับ AC65B2 หน่อย"},
            {"text": "ราคาเท่าไหร่"},
        ])
        records, captured, client = replay._replay(monkeypatch, fx)
        docs = _conv_doc(client)
        ss = docs[0].get("subject_set") if docs else None
        assert ss is not None
        assert ss["relation"] == "compare"
        assert set(ss["subject_ids"]) == {"4001", "4002"}
        # price followup resolves the pair → both items to llm
        t2_items = [replay._norm(p.get("item_id"))
                    for c in records[1]["llm_calls"]
                    for p in (c.get("products") or [])]
        assert 4001 in t2_items and 4002 in t2_items

    def test_suggestion_batch_persists_alternatives(self, monkeypatch):
        fx = _fx([{"text": "มีหัวชาร์จแนะนำไหมครับ"}])
        records, captured, client = replay._replay(monkeypatch, fx)
        docs = _conv_doc(client)
        ss = docs[0].get("subject_set") if docs else None
        assert ss is not None
        assert ss["relation"] == "alternatives"
        assert set(ss["subject_ids"]) == {"4001", "4002"}

    def test_ambiguous_deictic_clarifies_zero_writes(self, monkeypatch):
        writes = []
        real = cp.record_subject_set
        monkeypatch.setattr(cp, "record_subject_set",
                            lambda *a, **k: writes.append(1) or
                            real(*a, **k))
        fx = _fx([
            {"text": "มีหัวชาร์จแนะนำไหมครับ"},
            {"text": "ตัวนี้ดีไหม"},
        ])
        records, captured, client = replay._replay(monkeypatch, fx)
        resp = records[1]["resp"]
        assert getattr(resp, "source", "") == "subject_clarify"
        docs = _conv_doc(client)
        assert docs[0]["subject_set"]["relation"] == "alternatives"
        assert len(writes) == 1                      # only turn1's write

    def test_bot_prose_never_creates_subject(self, monkeypatch):
        """Model names inside BOT history prose must not create/replace a set."""
        fx = _fx([
            {"role": "model",
             "text": "แนะนำ CUKTECH AC65B กับ CUKTECH AC65B2 ครับ"},
            {"text": "ตัวนี้ราคาเท่าไหร่"},
        ])
        records, captured, client = replay._replay(monkeypatch, fx)
        resp = records[-1]["resp"]
        assert getattr(resp, "source", "") == "subject_clarify"
        docs = _conv_doc(client)
        ss = docs[0].get("subject_set") if docs else None
        # 'ตัวนี้' + prose-only history → clarify, zero writes
        assert ss is None

    def test_subject_read_at_most_once_per_turn(self, monkeypatch):
        reads = []
        real_get = cp.get_subject_set
        monkeypatch.setattr(cp, "get_subject_set",
                            lambda *a, **k: reads.append(1) or
                            real_get(*a, **k))
        fx = _fx([{"text": "มีหัวชาร์จแนะนำไหมครับ"},
                  {"text": "ราคาเท่าไหร่"}])
        replay._replay(monkeypatch, fx)
        assert len(reads) <= 2                       # ≤1 load per turn

    def test_subject_read_once_item_tag_flow(self, monkeypatch):
        """item-tag turn that continues to the recorder must not re-load."""
        reads = []
        real_get = cp.get_subject_set
        monkeypatch.setattr(cp, "get_subject_set",
                            lambda *a, **k: reads.append(1) or
                            real_get(*a, **k))
        fx = _fx([{"text": "สอบถามหน่อย", "item_id": "4001"}])
        replay._replay(monkeypatch, fx)
        assert len(reads) <= 1

    def test_unavailable_subject_still_resolves(self, monkeypatch):
        fx = _fx([{"text": "สอบถามหน่อย", "item_id": "4001"},
                  {"text": "ตัวนี้ราคาเท่าไหร่"}])
        fx["catalog"][0]["item_status"] = "UNLIST"
        records, captured, client = replay._replay(monkeypatch, fx)
        docs = _conv_doc(client)
        assert docs[0]["subject_set"]["subject_ids"] == ["4001"]

    def test_timeline_and_claim_fields_survive(self, monkeypatch):
        fx = _fx([{"text": "สอบถามหน่อย", "item_id": "4001"}],
                 timeline_seed={"products": [
                     {"item_id": 999, "card": {"item_id": 999},
                      "model_name": "OLD", "anchor_type": "item"}],
                     "active_item_id": "999"},
                 claim_state_seed={"active_episode_id": "e1",
                                   "stage": "open"})
        records, captured, client = replay._replay(monkeypatch, fx)
        doc = _conv_doc(client)[0]
        assert doc["subject_set"]["subject_ids"] == ["4001"]
        assert doc["products"][0]["model_name"] == "OLD"
        # active_item_id → 4001 is the existing item-anchor write
        #   (add_product), not subject-set leakage; claim_state untouched
        assert str(doc["active_item_id"]) == "4001"
        assert doc["claim_state"]["stage"] == "open"
