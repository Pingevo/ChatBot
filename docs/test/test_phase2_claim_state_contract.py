"""Phase 2A — claim lifecycle desired contract baseline.

Scope: claim-state lifecycle ownership only (stage / persisted slots /
terminal precedence / fill-once merge / clear). No runtime changes in this
phase — RED results document gaps for Phase 2B.

Offline & deterministic: `warranty_flow` top-level imports are stdlib-only;
`conversation_products` lazily builds its Mongo client inside `_coll()`,
so tests inject a tiny in-memory collection — no network, no .env, no LLM.

Target under test is the lifecycle owner `_claim_lifecycle` /
`_claim_transition` in `warranty_flow` (Phase 2B.4) plus the fenced CAS
primitives in `conversation_products` — no network, no .env, no LLM.
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


def _lc(state):
    return warranty_flow._claim_lifecycle(state)


# ── in-memory conversation_products collection ─────────────────────────────

def _get_path(doc: dict, path: str):
    """Resolve a dotted Mongo path — returns (value, present)."""
    cur = doc
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return None, False
        cur = cur[p]
    return cur, True


def _match(doc: dict, filt: dict) -> bool:
    """Equality + $exists matching on dotted paths (real Mongo semantics).

    Mongo null-equality: `field: None` matches missing OR null — the absent
    fence relies on this (no `claim_state` key / no episode / no stage)."""
    for k, cond in (filt or {}).items():
        val, present = _get_path(doc, k)
        if isinstance(cond, dict):
            if "$exists" in cond and present != bool(cond["$exists"]):
                return False
        elif cond is None:
            if present and val is not None:
                return False
        elif not present or val != cond:
            return False
    return True


class _FakeColl:
    """Minimal Mongo surface used by load/transition/merge claim-state.

    Race-model additions (Phase 2B.4 review-fix):
    - `docs`: doc list enforcing unique `conversation_id` on upsert insert
      (raises pymongo DuplicateKeyError = E11000) — models the declared
      unique index at the TS index owner
    - `interleave`: FIFO hook queue fired inside `update_one` BEFORE the
      write applies — deterministic writer interleaving, no threads
    - `calls`: op log for bounded-reread assertions
    """

    def __init__(self, doc: dict | None = None):
        self.calls: list = []
        self.interleave: list = []
        self.doc = doc  # property → docs list

    @property
    def doc(self):
        return self.docs[0] if self.docs else None

    @doc.setter
    def doc(self, v):
        self.docs = [dict(v)] if v else []

    def find_one(self, q, *_a, **_k):
        self.calls.append(("find_one",))
        for d in self.docs:
            if _match(d, q):
                return dict(d)
        return None

    def update_one(self, q, u, upsert=False, **_k):
        from types import SimpleNamespace
        if self.interleave:
            # a rival writer lands between our read and our write — fire the
            # queued interleave once, then evaluate the fence on the new doc
            self.interleave.pop(0)()
        for d in self.docs:
            if _match(d, q):
                self._apply(d, u)
                self.calls.append(("update_one", 1))
                return SimpleNamespace(matched_count=1, upserted_id=None)
        if upsert:
            doc = {k: v for k, v in (q or {}).items() if not k.startswith("$")}
            self._apply(doc, u)
            self.insert_one(doc)
            self.calls.append(("update_one", 0))
            return SimpleNamespace(matched_count=0, upserted_id=len(self.docs))
        self.calls.append(("update_one", 0))
        return SimpleNamespace(matched_count=0, upserted_id=None)

    def insert_one(self, doc, *_a, **_k):
        from types import SimpleNamespace
        from pymongo.errors import DuplicateKeyError
        if self.interleave:
            # rival commits inside our insert window → unique index decides
            self.interleave.pop(0)()
        conv = doc.get("conversation_id")
        if conv is not None and any(
                d.get("conversation_id") == conv for d in self.docs):
            # unique {conversation_id:1} index violation — E11000
            raise DuplicateKeyError(f"E11000 dup conversation_id={conv}")
        self.docs.append(dict(doc))
        self.calls.append(("insert_one",))
        return SimpleNamespace(inserted_id=len(self.docs))

    @staticmethod
    def _apply(doc, u):
        for k, v in (u.get("$set") or {}).items():
            tgt = doc
            parts = k.split(".")
            for p in parts[:-1]:
                tgt = tgt.setdefault(p, {})
            tgt[parts[-1]] = v
        for k in (u.get("$unset") or {}):
            doc.pop(k, None)


@pytest.fixture()
def coll(monkeypatch):
    """Inject fake collection; returns it for post-state inspection."""
    fake = _FakeColl()
    monkeypatch.setattr(conversation_products, "_coll", lambda: fake)
    return fake


# ── lifecycle-view invariants (parity pins on the single evaluator) ────────

def test_no_state_is_absent():
    view = _lc(None)
    assert view.stage == "absent" and view.lifecycle_open is False


def test_empty_state_is_absent():
    view = _lc({})
    assert view.stage == "absent" and view.lifecycle_open is False


def test_stage_collecting_is_open():
    view = _lc({"stage": "collecting", "episode_id": "e1"})
    assert view.lifecycle_open and view.accepts_claim_fields


def test_collecting_with_slots_is_open():
    view = _lc({"stage": "collecting", "episode_id": "e1",
                "customer_phone": "0812345678"})
    assert view.lifecycle_open


def test_resolved_is_terminal():
    view = _lc({"stage": "resolved", "episode_id": "e1"})
    assert view.stage == "resolved" and view.lifecycle_open is False


def test_ts_suggested_is_open_but_not_collecting():
    # 2B.4 contract decision: ts_suggested = open episode — troubleshoot
    # advice sent, episode alive — but it accepts only the ts verdict via the
    # follow-up branch, not bare claim fields.
    view = _lc({"stage": "ts_suggested", "episode_id": "e1"})
    assert view.lifecycle_open and not view.accepts_claim_fields


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
    # Phase 2B.5 — merge is precedence-only: parser (extract_customer_info)
    # owns name validity, so a lone name must survive merge; over-40/digit
    # rejection is pinned at the parser, not re-judged here
    s = merge({"name": "สมชาย", "phone": "", "order_id": ""},
              claim_state={})
    assert s["name"] == "สมชาย"


def test_merge_claim_fields_skips_none_and_empty(coll):
    conversation_products.transition_claim_state(
        "c1", "shopee", "Shop", expected_episode_id=None,
        expected_stage=None,
        claim_state={"episode_id": "e1", "stage": "collecting",
                     "customer_name": "สมชาย ใจดี"})
    conversation_products.merge_claim_fields(
        "c1", episode_id="e1", expected_stage="collecting",
        fields={"customer_name": None, "customer_phone": "0812345678"})
    state = conversation_products.load_claim_state("c1")
    assert state["customer_name"] == "สมชาย ใจดี"  # not overwritten by None
    assert state["customer_phone"] == "0812345678"
    assert state["stage"] == "collecting"


def test_no_clear_path_exists():
    # 2B.4: nothing clears claim_state — ticket close/handoff never resolve;
    # removal of clear_claim_state is the contract, not a missing helper.
    assert not hasattr(conversation_products, "clear_claim_state")
    assert not hasattr(conversation_products, "update_claim_state")


# ── Phase 2B.4 — episode/lifecycle owner contract (GREEN: owner landed) ────
#
# (the old `_XFAIL_RESOLVED` slot-precedence xfail was retired — its desired
#  contract is now a normal positive test: test_view_terminal_beats_*)
#
# Desired authority, from review Corrections A–E:
#   - `_claim_lifecycle(state) -> ClaimLifecycleView` is the only evaluator;
#     retained slots and stale history markers never activate a claim.
#   - `_claim_transition(req, state, to, fields=..., fresh_claim=...)` is the
#     only transition owner; storage (`transition_claim_state`) is a fenced
#     CAS primitive — miss → single reread → authoritative winner.
#   - terminal evidence = ts-success producer or persisted terminal stage
#     only; handoff reasons / ticket close / answer text never resolve.
#   - fresh claim after terminal = new episode_id + identity allowlist only.
#   - concurrent/stale writers cannot clobber a newer episode.

from types import SimpleNamespace  # noqa: E402


def _req(cid: str = "c1"):
    return SimpleNamespace(conversation_id=cid, platform="shopee", shop="Shop")


def _seed(coll, cid: str, claim_state: dict):
    coll.doc = {"conversation_id": cid, "claim_state": dict(claim_state)}


# A. terminal precedence — resolved/cancelled never open; slots never activate

@pytest.mark.parametrize("terminal", ["resolved", "cancelled"])
@pytest.mark.parametrize("retained_slots", [
    {"customer_name": "สมชาย ใจดี"},
    {"customer_phone": "0812345678"},
    {"customer_name": "สมชาย ใจดี", "customer_phone": "0812345678",
     "customer_order_id": "2508088B5T4W1D", "purchase_date": "2026-08-10",
     "has_image": True},
])
def test_view_terminal_beats_retained_slots(terminal, retained_slots):
    view = _lc({"stage": terminal, "episode_id": "e1", **retained_slots})
    assert view.stage == terminal
    assert view.lifecycle_open is False
    assert view.accepts_claim_fields is False


def test_view_slot_only_state_is_absent_not_collecting():
    # legacy slot-bearing doc without stage = retained audit data, never live
    view = _lc({"customer_name": "สมชาย ใจดี", "customer_phone": "0812345678"})
    assert view.stage == "absent"
    assert view.lifecycle_open is False
    assert view.accepts_claim_fields is False


def test_view_collecting_and_ts_suggested_are_open():
    for stage in ("collecting", "ts_suggested"):
        view = _lc({"stage": stage, "episode_id": "e1"})
        assert view.lifecycle_open is True
    assert _lc({"stage": "collecting", "episode_id": "e1"}).accepts_claim_fields is True
    assert _lc({"stage": "ts_suggested", "episode_id": "e1"}).accepts_claim_fields is False


# B. fresh episode — explicit claim request after terminal = new episode_id

@pytest.mark.parametrize("terminal", ["resolved", "cancelled"])
def test_fresh_claim_after_terminal_mints_new_episode(coll, terminal):
    old = {"episode_id": "e-old", "stage": terminal,
           "customer_name": "สมชาย ใจดี", "customer_phone": "0812345678",
           "customer_order_id": "2508088B5T4W1D", "purchase_date": "2026-08-10",
           "has_image": True, "has_video": True, "started_at": "2026-01-01"}
    _seed(coll, "c1", old)
    state = warranty_flow._claim_transition(
        _req(), old, "collecting", fresh_claim=True)
    assert state["stage"] == "collecting"
    assert state["episode_id"] and state["episode_id"] != "e-old"
    # identity allowlist retained across episodes (reuse, never activation)
    assert state["customer_name"] == "สมชาย ใจดี"
    assert state["customer_phone"] == "0812345678"
    # case evidence of the old episode must not leak into the new one
    for k in ("customer_order_id", "purchase_date", "has_image", "has_video"):
        assert k not in state, k
    # new episode gets its own started_at, not the old terminal record's
    assert state["started_at"] != "2026-01-01"
    stored = conversation_products.load_claim_state("c1")
    assert stored["episode_id"] == state["episode_id"]


def test_fresh_claim_on_open_episode_continues_same_episode(coll):
    # retry/explicit request during an open episode must not fork episodes
    cur = {"episode_id": "e-live", "stage": "collecting",
           "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", cur)
    state = warranty_flow._claim_transition(
        _req(), cur, "collecting", fresh_claim=True)
    assert state["episode_id"] == "e-live"


def test_fresh_claim_retry_after_new_episode_is_idempotent(coll):
    old = {"episode_id": "e-old", "stage": "resolved"}
    _seed(coll, "c1", old)
    first = warranty_flow._claim_transition(
        _req(), old, "collecting", fresh_claim=True)
    again = warranty_flow._claim_transition(
        _req(), first, "collecting", fresh_claim=True)
    assert again["episode_id"] == first["episode_id"]


# C. same episode — continuation merges keep the episode

def test_continuation_merges_same_episode(coll):
    cur = {"episode_id": "e-live", "stage": "collecting",
           "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", cur)
    state = warranty_flow._claim_transition(
        _req(), cur, "collecting",
        fields={"customer_phone": "0812345678"})
    assert state["episode_id"] == "e-live"
    assert state["customer_phone"] == "0812345678"
    stored = conversation_products.load_claim_state("c1")
    assert stored["customer_name"] == "สมชาย ใจดี"
    assert stored["customer_phone"] == "0812345678"


def test_ts_suggested_to_collecting_same_episode(coll):
    cur = {"episode_id": "e-live", "stage": "ts_suggested"}
    _seed(coll, "c1", cur)
    state = warranty_flow._claim_transition(
        _req(), cur, "collecting", fields={"customer_phone": "0812345678"})
    assert state["episode_id"] == "e-live"
    assert state["stage"] == "collecting"


# D/E. authority — terminal + marker/continuation evidence cannot reopen;
#   absent + submitted fields transitions to collecting via the owner

@pytest.mark.parametrize("terminal", ["resolved", "cancelled"])
def test_terminal_refuses_continuation_evidence(coll, terminal):
    old = {"episode_id": "e-old", "stage": terminal,
           "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", old)
    state = warranty_flow._claim_transition(
        _req(), old, "collecting",
        fields={"customer_phone": "0812345678"})
    # stale marker / bare field after terminal must not reopen or write
    assert state["stage"] == terminal
    assert state["episode_id"] == "e-old"
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == terminal
    assert "customer_phone" not in stored or stored["customer_phone"] != "0812345678"


def test_absent_plus_fields_mints_episode_via_owner(coll):
    # history-marker resume path: absent + genuine field submission →
    # persist a collecting episode (transition owner), then fields apply
    state = warranty_flow._claim_transition(
        _req(), {}, "collecting",
        fields={"customer_phone": "0812345678"})
    assert state["stage"] == "collecting"
    assert state["episode_id"]
    assert state["customer_phone"] == "0812345678"
    stored = conversation_products.load_claim_state("c1")
    assert stored["episode_id"] == state["episode_id"]


def test_resolved_transition_preserves_evidence_as_terminal_record(coll):
    cur = {"episode_id": "e-live", "stage": "ts_suggested",
           "customer_name": "สมชาย ใจดี",
           "customer_order_id": "2508088B5T4W1D", "has_image": True}
    _seed(coll, "c1", cur)
    state = warranty_flow._claim_transition(_req(), cur, "resolved")
    assert state["stage"] == "resolved"
    assert state["episode_id"] == "e-live"
    # collected claim fields stay as the episode's terminal record
    assert state["customer_order_id"] == "2508088B5T4W1D"
    assert state["has_image"] is True
    assert state["resolved_at"]
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "resolved"


# F. race/idempotency — fenced CAS, single winner, bounded reread

def test_concurrent_fresh_claim_single_winner(coll):
    # two turns racing the same terminal episode: both must land on the
    # winner's episode — the loser's candidate is never persisted
    old = {"episode_id": "e-old", "stage": "resolved",
           "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", old)
    winner = warranty_flow._claim_transition(
        _req(), old, "collecting", fresh_claim=True)
    loser = warranty_flow._claim_transition(
        _req(), old, "collecting", fresh_claim=True)
    assert loser["episode_id"] == winner["episode_id"]
    stored = conversation_products.load_claim_state("c1")
    assert stored["episode_id"] == winner["episode_id"]


def test_stale_episode_writer_cannot_overwrite_newer(coll):
    # writer holding E1 must not clobber E2 (fresh episode committed since)
    stale = {"episode_id": "e-1", "stage": "collecting",
             "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", {"episode_id": "e-2", "stage": "collecting"})
    state = warranty_flow._claim_transition(
        _req(), stale, "collecting",
        fields={"customer_phone": "0812345678"})
    assert state["episode_id"] == "e-2"
    stored = conversation_products.load_claim_state("c1")
    assert stored["episode_id"] == "e-2"
    assert "customer_phone" not in stored


# ── Phase 2B.4 review-fix — expected-stage fence + real interleaves ──────────
# (deterministic interleave via _FakeColl.interleave — no threads)
#
# R1: stale same-episode merge lands AFTER terminal — must not reopen
# R2: terminal transition preserves evidence a concurrent writer added
# R3: caller holding stale expected stage loses CAS, rereads winner once
# R4: concurrent absent-doc create → unique index → single doc, loser rereads
# R5: unique index declaration lives at the TS index owner only
# R6: importing test_issue_5f_claim_flow never calls load_dotenv (.env purity)


def test_r1_stale_same_episode_merge_cannot_reopen_terminal(coll):
    # writer reads {e1, collecting}; terminal commits before the stale merge lands
    cur = {"episode_id": "e-1", "stage": "collecting",
           "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", cur)

    def _terminal_wins():
        conversation_products.merge_claim_fields(
            "c1", episode_id="e-1", expected_stage="collecting",
            fields={"stage": "resolved", "resolved_at": "t0",
                    "resolution_reason": "troubleshoot_confirmed"})

    coll.interleave.append(_terminal_wins)
    state = warranty_flow._claim_transition(
        _req(), cur, "collecting",
        fields={"customer_phone": "0812345678"})
    # stale merge must surface the authoritative terminal state, not reopen it
    assert state["stage"] == "resolved"
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "resolved"
    assert stored.get("customer_phone") != "0812345678"


def test_r2_terminal_transition_preserves_concurrent_evidence(coll):
    # evidence write lands between terminal fence-check and commit — a partial
    # $set terminal transition must not drop it (whole-state replace would)
    cur = {"episode_id": "e-1", "stage": "collecting",
           "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", cur)

    def _evidence_lands_first():
        conversation_products.merge_claim_fields(
            "c1", episode_id="e-1", expected_stage="collecting",
            fields={"customer_phone": "0812345678",
                    "customer_order_id": "ORD-9"})

    coll.interleave.append(_evidence_lands_first)
    state = warranty_flow._claim_transition(_req(), cur, "resolved")
    assert state["stage"] == "resolved"
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "resolved"
    assert stored["customer_phone"] == "0812345678"
    assert stored["customer_order_id"] == "ORD-9"
    assert stored["resolved_at"]


def test_r3_expected_stage_cas_loss_bounded_reread(coll):
    cur = {"episode_id": "e-1", "stage": "collecting"}
    _seed(coll, "c1", cur)
    # winner advances the episode first; stale caller still expects collecting
    coll.doc = {"conversation_id": "c1",
                "claim_state": {"episode_id": "e-1", "stage": "resolved",
                                "resolved_at": "t0"}}
    state = warranty_flow._claim_transition(
        _req(), cur, "collecting", fields={"customer_phone": "x"})
    assert state["stage"] == "resolved"
    writes = [c for c in coll.calls if c[0] == "update_one"]
    assert writes == [("update_one", 0)]  # stale CAS matched nothing
    reads = [c for c in coll.calls if c[0] == "find_one"]
    assert len(reads) == 1  # one bounded reread — no retry loop
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "resolved"


def test_r4_concurrent_absent_create_single_document(coll):
    # empty collection; rival writer commits inside the loser's upsert window —
    # the unique {conversation_id:1} index must yield exactly one document and
    # the loser must reread the winner's episode (E11000 → reconcile)
    def _rival_inserts():
        coll.docs.append({"conversation_id": "c1",
                          "claim_state": {"episode_id": "e-A",
                                          "stage": "collecting"}})

    # call order inside transition_claim_state: fence update_one (miss) →
    # find_one (absent) → upsert update_one → interleave fires rival insert →
    # insert itself hits the unique index → E11000 → single reread
    coll.interleave.extend([lambda: None, _rival_inserts])
    loser = conversation_products.transition_claim_state(
        "c1", "shopee", "Shop",
        expected_episode_id=None, expected_stage=None,
        claim_state={"episode_id": "e-B", "stage": "collecting"})
    assert loser["episode_id"] == "e-A"
    docs = [d for d in coll.docs if d.get("conversation_id") == "c1"]
    assert len(docs) == 1
    assert docs[0]["claim_state"]["episode_id"] == "e-A"


def test_r5_unique_index_declaration_owner_pin():
    # the unique index must live at the existing TS index owner — a canonical
    # COLLECTIONS entry in config.ts + one safeCreateIndex call — never in the
    # Python request path
    cfg = (ROOT / "ChatAdminWeb/src/backend/lib/config.ts").read_text()
    mc = (ROOT / "ChatAdminWeb/src/backend/db/mongoClient.ts").read_text()
    assert "conversationProducts" in cfg
    assert '"conversation_products"' in cfg
    lines = [ln for ln in mc.splitlines()
             if "COLLECTIONS.conversationProducts" in ln
             and "conversation_id" in ln]
    assert len(lines) == 1, lines
    assert "unique: true" in lines[0]
    # Python runtime must never create indexes in the request path
    import pathlib
    for p in (ROOT / "chatbot/shopeechat").glob("*.py"):
        src = p.read_text()
        assert "create_index" not in src and "createIndex" not in src, p.name


# ── Phase 2B.2 review-fix — cross-module transport stub isolation ────────────
# 5f test files เคย patch `shopeechat.app._send_handoff` ที่ module level
# (lambda ไม่ restore) → process เดียวกันเห็น stub ถาวร; ตอนนี้ต้อง scoped
# (monkeypatch restore) — file นี้รันหลัง 5f files ตาม alphabetical order.
# ห้าม import app เอง — standalone run ต้องไม่แตะ .env; combined suite
# (issue_5f ก่อน) ทำให้ app ถูกโหลดอยู่แล้ว → assert ทำงานเต็มที่นั่น
def test_handoff_transport_owner_not_globally_stubbed():
    _app = sys.modules.get("shopeechat.app")
    if _app is None:
        pytest.skip("app not loaded; leakage is exercised in combined suite")
    fn = _app._send_handoff
    assert getattr(fn, "__name__", "") == "_send_handoff", (
        f"transport owner ถูก stub รั่วข้าม module: {fn!r}")


# ── Phase 2B.6 — explicit admin claim outcome (episode-scoped, idempotent) ──
# Contract: admin สั่ง resolved|cancelled ผูก episode_id ผ่าน status_conversation
# → ChatRequest.claim_outcome → consume ใน SM heads หลัง load_claim_state
# ก่อน _claim_lifecycle — apply เฉพาะเมื่อ episode ตรง + lifecycle open
# stale/mismatch/replay = no-op; first terminal wins; ห้าม infer จาก text/reason

def _outcome_req(cid="c1", **outcome):
    oc = {"episode_id": "e-live", "outcome": "resolved",
          "occurred_at": "2026-10-01T00:00:00+00:00", "actor_id": "admin-1"}
    oc.update(outcome)
    return SimpleNamespace(conversation_id=cid, platform="shopee",
                           shop="Shop", claim_outcome=oc)


def test_admin_outcome_resolved_applies_to_matching_episode(coll):
    cur = {"episode_id": "e-live", "stage": "collecting",
           "customer_name": "สมชาย ใจดี", "customer_phone": "0812345678"}
    _seed(coll, "c1", cur)
    state = warranty_flow._consume_claim_outcome(_outcome_req(), dict(cur))
    assert state["stage"] == "resolved" and state["episode_id"] == "e-live"
    assert state["resolution_reason"] == "admin_resolved"
    assert state["resolved_by"] == "admin-1"
    # resolved_at = admin occurred_at (ISO string — claim_state convention)
    assert state["resolved_at"] == "2026-10-01T00:00:00+00:00"
    # evidence of the episode survives the terminal transition
    assert state["customer_name"] == "สมชาย ใจดี"
    assert state["customer_phone"] == "0812345678"
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "resolved" and stored["episode_id"] == "e-live"


def test_admin_outcome_cancelled_applies(coll):
    cur = {"episode_id": "e-live", "stage": "ts_suggested",
           "customer_name": "สมชาย ใจดี"}
    _seed(coll, "c1", cur)
    state = warranty_flow._consume_claim_outcome(
        _outcome_req(outcome="cancelled"), dict(cur))
    assert state["stage"] == "cancelled" and state["episode_id"] == "e-live"
    assert state["resolution_reason"] == "admin_cancelled"
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "cancelled"


def test_admin_outcome_stale_episode_cannot_terminate(coll):
    # event ของ episode เก่า ห้ามจบ active episode ใหม่
    cur = {"episode_id": "e-new", "stage": "collecting"}
    _seed(coll, "c1", cur)
    state = warranty_flow._consume_claim_outcome(
        _outcome_req(episode_id="e-old"), dict(cur))
    assert state["stage"] == "collecting" and state["episode_id"] == "e-new"
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "collecting" and stored["episode_id"] == "e-new"


def test_admin_outcome_repeat_delivery_is_idempotent(coll):
    cur = {"episode_id": "e-live", "stage": "collecting"}
    _seed(coll, "c1", cur)
    first = warranty_flow._consume_claim_outcome(_outcome_req(), dict(cur))
    again = warranty_flow._consume_claim_outcome(_outcome_req(), dict(first))
    assert again["stage"] == "resolved" and again["episode_id"] == "e-live"
    assert again["resolved_at"] == first["resolved_at"]


def test_admin_outcome_conflicting_replay_keeps_first_terminal(coll):
    # resolved applied แล้ว → cancelled replay ต้องไม่ flip terminal
    cur = {"episode_id": "e-live", "stage": "collecting"}
    _seed(coll, "c1", cur)
    first = warranty_flow._consume_claim_outcome(
        _outcome_req(outcome="resolved"), dict(cur))
    again = warranty_flow._consume_claim_outcome(
        _outcome_req(outcome="cancelled"), dict(first))
    assert again["stage"] == "resolved"


def test_admin_outcome_no_claim_is_fail_closed_no_write(coll):
    # non-claim conversation — ห้ามสร้าง doc/claim_state
    state = warranty_flow._consume_claim_outcome(_outcome_req(), None)
    assert not state or state.get("stage") in (None, "absent")
    assert not any(c[0] in ("insert_one", "update_one") for c in coll.calls)


def test_admin_outcome_on_terminal_episode_is_noop(coll):
    cur = {"episode_id": "e-live", "stage": "resolved",
           "resolved_at": "2026-09-01"}
    _seed(coll, "c1", cur)
    state = warranty_flow._consume_claim_outcome(
        _outcome_req(episode_id="e-live", outcome="cancelled"), dict(cur))
    assert state["stage"] == "resolved" and state["resolved_at"] == "2026-09-01"


@pytest.mark.parametrize("bad", [
    None, "resolved", 42,
    {"episode_id": "e-live"},                        # outcome missing
    {"outcome": "resolved"},                         # episode missing
    {"episode_id": "e-live", "outcome": "bogus"},    # unknown outcome
    {"episode_id": 42, "outcome": "resolved"},       # wrong type
    {"episode_id": "e-live", "outcome": "Resolved"}, # case-sensitive enum
])
def test_admin_outcome_malformed_is_noop(coll, bad):
    cur = {"episode_id": "e-live", "stage": "collecting"}
    _seed(coll, "c1", cur)
    req = SimpleNamespace(conversation_id="c1", platform="shopee",
                          shop="Shop", claim_outcome=bad)
    state = warranty_flow._consume_claim_outcome(req, dict(cur))
    assert state["stage"] == "collecting"
    stored = conversation_products.load_claim_state("c1")
    assert stored["stage"] == "collecting"


def test_admin_outcome_missing_request_field_is_noop(coll):
    # req ที่ไม่มี claim_outcome attr (ChatRequest เก่า/duck-type) → no-op
    cur = {"episode_id": "e-live", "stage": "collecting"}
    _seed(coll, "c1", cur)
    state = warranty_flow._consume_claim_outcome(_req(), dict(cur))
    assert state["stage"] == "collecting"


def test_admin_outcome_consumed_at_both_sm_heads_before_lifecycle():
    # source pin — consume ใน SM heads ทั้งสอง ก่อน _claim_lifecycle evaluate
    import inspect
    for name in ("handle_warranty_flow", "handle_warranty_flow_legacy"):
        src = inspect.getsource(getattr(warranty_flow, name))
        i_consume = src.find("_consume_claim_outcome")
        i_lifecycle = src.find("_claim_lifecycle(")
        assert i_consume != -1 and i_lifecycle != -1 and i_consume < i_lifecycle, name


def test_chat_request_wire_field_declared():
    # source pin — ChatRequest ต้องรับ claim_outcome (wire dict; ISO occurred_at)
    src = (ROOT / "chatbot/shopeechat/app.py").read_text()
    assert "claim_outcome" in src
