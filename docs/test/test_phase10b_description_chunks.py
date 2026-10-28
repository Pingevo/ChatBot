"""Phase 10B — description-chunk retrieval (design B) contract tests.

Offline — no Mongo/provider/model download.  All vector/doc seams are
monkeypatched (`_desc_vectors`, `_desc_item_docs`, `embedding.embed_query`).

Contract under test:
- description-chunk npz rows carry canonical item_id; chunk metadata never
  substitutes for item identity
- chunk hits aggregate to ONE item candidate via max chunk score
- exact-item requests restrict hits to anchored item_ids (no cross-item)
- emitted cards are to_product_card item cards → _evidence.sources gains
  "description"; pool/selection remain ranking owners
- missing/malformed artifact → empty result (fail closed, never raises)
- channel exists only inside grouped runtime — flag-off path untouched

Run: .venv/bin/python -m pytest docs/test/test_phase10b_description_chunks.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import product_store as _ps
from chatbot.shopeechat import retrieval_policy as _rp
from chatbot.shopeechat import retrieval_planner as _rpl
from chatbot.shopeechat import retrieval_executor as _rx
from chatbot.shopeechat.route_context import RetrievalProfile

ITEM_A = "27639651334"   # CMC615P-like (desc-only 480Mbps fact)
ITEM_B = "49267582152"   # CTL301-like
DESC_480 = ("CUKTECH CMC615P สายชาร์จแม่เหล็ก 240W PD3.1 "
            "รองรับการถ่ายโอนข้อมูล 480Mbps สายถัก")


def _profile(**kw):
    base = dict(platform="shopee", shop=None, message="q", intent="",
                product_types=frozenset(), subtype=None, model_codes=(),
                variant_terms=(), target_device=None,
                availability_mode="", compat_mode="")
    base.update(kw)
    return RetrievalProfile(**base)


def _npz(rows):
    """rows: [(item_id_str, chunk_index, chunk_text, np_vector)]"""
    item_ids, chunk_ids, emb, shops, texts = [], [], [], [], []
    for iid, ci, t, v in rows:
        item_ids.append(iid)
        chunk_ids.append(f"{iid}:{ci}")
        emb.append(v)
        shops.append("shopX")
        texts.append(t)
    return {"item_ids": np.array(item_ids, dtype=object),
            "chunk_ids": np.array(chunk_ids, dtype=object),
            "emb": np.array(emb, dtype=np.float32),
            "shops": np.array(shops, dtype=object),
            "texts": np.array(texts, dtype=object)}


def _doc(iid, desc="desc", name="Item", status="NORMAL"):
    return {"item_id": int(iid), "item_name": name,
            "item_status": status, "cat_name": "cable", "shopname": "shopX",
            "description": desc, "tier_variation": [], "brand": {},
            "model": [{"model_id": f"m{iid}", "model_name": name,
                       "model_status": "MODEL_NORMAL",
                       "stock_info_v2": {"summary_info": {
                           "total_available_stock": 3}},
                       "price_info": [{"current_price": 100}]}]}


def _wire(monkeypatch, npz, docs_by_item, qvec=None):
    """patch _desc_vectors/_desc_item_docs/embed_query → isolated fetcher."""
    monkeypatch.setattr(_ps, "_desc_vectors", lambda snap=None: npz)
    monkeypatch.setattr(_ps, "_desc_item_docs",
                        lambda ids: {i: docs_by_item[i]
                                     for i in ids if i in docs_by_item})
    qv = (qvec if qvec is not None else np.array([1.0, 0.0], np.float32))
    from chatbot.shopeechat import embedding as _embmod
    monkeypatch.setattr(_embmod, "embed_query", lambda *a, **k: qv)


# ── A: chunk identity ──────────────────────────────────────────────────────

def test_missing_artifact_returns_empty_fail_closed(monkeypatch):
    _wire(monkeypatch, None, {})
    res = _ps.fetch_description_evidence("speed เท่าไหร่",
                                       retrieval_profile=_profile())
    assert res.cards == () and res.raw_count == 0


def test_malformed_rows_fail_closed(monkeypatch):
    bad = {"item_ids": np.array([ITEM_A], dtype=object),
           "chunk_ids": np.array(["x"], dtype=object),
           "emb": np.zeros((3, 2), np.float32),          # len mismatch
           "shops": np.array(["s"], dtype=object),
           "texts": np.array(["t"], dtype=object)}
    _wire(monkeypatch, bad, {})
    res = _ps.fetch_description_evidence("q", retrieval_profile=_profile())
    assert res.cards == () and res.raw_count == 0


def test_every_card_has_canonical_item_id(monkeypatch):
    npz = _npz([(ITEM_A, 0, "a", np.array([1.0, 0.0], np.float32))])
    _wire(monkeypatch, npz, {int(ITEM_A): _doc(ITEM_A)})
    res = _ps.fetch_description_evidence("q", retrieval_profile=_profile())
    assert len(res.cards) == 1
    c = res.cards[0]
    assert str(c["item_id"]) == ITEM_A
    assert c["_desc_hit"]["item_id"] == ITEM_A


def test_chunk_index_is_provenance_not_identity(monkeypatch):
    npz = _npz([(ITEM_A, 3, "a", np.array([1.0, 0.0], np.float32))])
    _wire(monkeypatch, npz, {int(ITEM_A): _doc(ITEM_A)})
    c = _ps.fetch_description_evidence("q", retrieval_profile=_profile()).cards[0]
    assert c["_desc_hit"]["chunk_index"] == 3
    assert c["item_id"] == int(ITEM_A) or str(c["item_id"]) == ITEM_A
    assert c["_desc_hit"]["item_id"] == ITEM_A


# ── B: item-level aggregation ──────────────────────────────────────────────

def test_multiple_chunks_collapse_to_one_card(monkeypatch):
    rows = [(ITEM_A, 0, "a0", np.array([0.9, 0.1], np.float32)),
            (ITEM_A, 1, "a1", np.array([0.5, 0.5], np.float32)),
            (ITEM_A, 2, "a2", np.array([0.4, 0.6], np.float32))]
    _wire(monkeypatch, _npz(rows), {int(ITEM_A): _doc(ITEM_A)})
    res = _ps.fetch_description_evidence("q", retrieval_profile=_profile())
    assert len(res.cards) == 1
    c = res.cards[0]
    # max chunk score represents the item — existing _score field
    assert c["_score"] == pytest.approx(0.9, abs=1e-4)
    assert c["_desc_hit"]["chunk_index"] == 0


def test_two_items_two_cards_no_duplicates(monkeypatch):
    rows = [(ITEM_A, 0, "a", np.array([0.9, 0.1], np.float32)),
            (ITEM_B, 0, "b", np.array([0.8, 0.2], np.float32))]
    _wire(monkeypatch, _npz(rows),
          {int(ITEM_A): _doc(ITEM_A), int(ITEM_B): _doc(ITEM_B)})
    res = _ps.fetch_description_evidence("q", retrieval_profile=_profile())
    assert len(res.cards) == 2
    ids = [str(c["item_id"]) for c in res.cards]
    assert sorted(ids) == sorted([ITEM_A, ITEM_B])


def test_low_score_chunk_still_returned_no_semantic_floor(monkeypatch):
    # review: 0.3 floor was an uncalibrated hidden relevance owner — bounded
    # recall only; pool/selection own relevance. sim 0.2 < old floor → card.
    rows = [(ITEM_A, 0, "a", np.array([0.2, 0.8], np.float32))]
    _wire(monkeypatch, _npz(rows), {int(ITEM_A): _doc(ITEM_A)})
    res = _ps.fetch_description_evidence("q", retrieval_profile=_profile())
    assert len(res.cards) == 1
    assert res.cards[0]["_desc_hit"]["score"] < 0.3


def test_anchor_below_old_floor_still_returned(monkeypatch):
    # exact anchored item must not be dropped by a semantic gate even when
    # a follow-up question embeds far below any calibrated boundary
    rows = [(ITEM_A, 0, "a", np.array([0.05, 0.05], np.float32)),
            (ITEM_B, 0, "b stronger", np.array([0.99, 0.01], np.float32))]
    _wire(monkeypatch, _npz(rows),
          {int(ITEM_A): _doc(ITEM_A), int(ITEM_B): _doc(ITEM_B)})
    prof = _profile(anchor_item_ids=(ITEM_A,))
    res = _ps.fetch_description_evidence("q", retrieval_profile=prof)
    ids = [str(c["item_id"]) for c in res.cards]
    assert ids == [ITEM_A]
    assert res.cards[0]["_desc_hit"]["score"] < 0.1


def test_nonfinite_scores_rejected_as_invalid(monkeypatch):
    # NaN/±inf = schema/math invalid — rejected; masked/non-anchor must not
    # leak back as a "finite" -1.0 sentinel
    rows = [(ITEM_A, 0, "a", np.array([float("nan"), 0.0], np.float32)),
            (ITEM_A, 1, "a2", np.array([float("inf"), 0.0], np.float32)),
            (ITEM_B, 0, "b finite", np.array([0.5, 0.5], np.float32))]
    _wire(monkeypatch, _npz(rows),
          {int(ITEM_A): _doc(ITEM_A), int(ITEM_B): _doc(ITEM_B)})
    res = _ps.fetch_description_evidence("q", retrieval_profile=_profile())
    ids = [str(c["item_id"]) for c in res.cards]
    assert ids == [ITEM_B]
    for c in res.cards:
        assert np.isfinite(c["_desc_hit"]["score"])


def test_generic_recall_bounded_by_limit(monkeypatch):
    item_rows = [(str(1000 + i), 0, f"c{i}",
                  np.array([1.0 - i * 0.01, 0.0], np.float32))
                 for i in range(12)]
    _wire(monkeypatch, _npz(item_rows),
          {1000 + i: _doc(str(1000 + i)) for i in range(12)})
    res = _ps.fetch_description_evidence(
        "q", retrieval_profile=_profile(), limit=4)
    assert len(res.cards) == 4
    scores = [c["_desc_hit"]["score"] for c in res.cards]
    assert scores == sorted(scores, reverse=True)   # top-K, not all hits


# ── C: cross-item isolation ────────────────────────────────────────────────

def test_anchor_restricts_to_anchored_item(monkeypatch):
    rows = [(ITEM_A, 0, "a", np.array([0.5, 0.5], np.float32)),
            (ITEM_B, 0, "b stronger", np.array([0.99, 0.01], np.float32))]
    _wire(monkeypatch, _npz(rows),
          {int(ITEM_A): _doc(ITEM_A), int(ITEM_B): _doc(ITEM_B)})
    prof = _profile(anchor_item_ids=(ITEM_A,))
    res = _ps.fetch_description_evidence("q", retrieval_profile=prof)
    ids = [str(c["item_id"]) for c in res.cards]
    assert ids == [ITEM_A]
    assert all(c["_desc_hit"]["item_id"] == ITEM_A for c in res.cards)


def test_item_b_chunk_never_populates_item_a(monkeypatch):
    rows = [(ITEM_A, 0, "a", np.array([0.6, 0.4], np.float32)),
            (ITEM_B, 0, "b", np.array([0.95, 0.05], np.float32))]
    _wire(monkeypatch, _npz(rows),
          {int(ITEM_A): _doc(ITEM_A), int(ITEM_B): _doc(ITEM_B)})
    res = _ps.fetch_description_evidence("q", retrieval_profile=_profile())
    for c in res.cards:
        assert c["_desc_hit"]["item_id"] == str(c["item_id"])


# ── D: description-only evidence reaches the card ──────────────────────────

def test_480mbps_desc_only_fact_on_card(monkeypatch):
    npz = _npz([(ITEM_A, 0, DESC_480, np.array([1.0, 0.0], np.float32))])
    _wire(monkeypatch, npz,
          {int(ITEM_A): _doc(ITEM_A, desc=DESC_480)})
    res = _ps.fetch_description_evidence("Speed data เท่าไหร่",
                                         retrieval_profile=_profile())
    c = res.cards[0]
    blob = (c.get("description_excerpt") or "") + (c.get("raw_description") or "")
    assert "480Mbps" in blob
    ec = _rp.make_evidence_card(c, source="description")
    assert "description" in ec["_evidence"]["sources"]
    assert ITEM_A in ec["_evidence"]["item_ids"]


def test_executor_channel_tags_description_source(monkeypatch):
    npz = _npz([(ITEM_A, 0, "a", np.array([1.0, 0.0], np.float32))])
    _wire(monkeypatch, npz, {int(ITEM_A): _doc(ITEM_A)})
    req = _rpl.channel_request("description")
    out = _rx.execute_grouped_retrieval_requests(
        (), message="q", shop=None,
        channels=((req, _ps.fetch_description_evidence),), snap=None)
    res = out[0]
    assert res.source == "description"
    assert res.source_attempts[0].source == "description"
    assert len(res.eligible_candidates) == 1
    c = res.eligible_candidates[0]
    assert c["_evidence"]["sources"] == ["description"]
    assert str(c["item_id"]) == ITEM_A


# ── E/F: isolation + flag-off ──────────────────────────────────────────────

def test_no_description_attempt_when_channel_absent():
    out = _rx.execute_grouped_retrieval_requests(
        (), message="q", shop=None, channels=(), snap=None)
    assert all(r.source != "description" for r in out)


def test_desc_cards_merge_into_shared_item_identity():
    """pool merges i:{iid} cards across sources — sources union, no dup."""
    c_desc = _rp.make_evidence_card(
        {"item_id": int(ITEM_A), "name": "n", "catalog_status": "active"},
        source="description")
    c_unit = _rp.make_evidence_card(
        {"item_id": int(ITEM_A), "name": "n", "catalog_status": "active"},
        source="units")
    assert c_desc["_evidence"]["item_ids"] == c_unit["_evidence"]["item_ids"]


def test_float_item_ids_canonicalized(monkeypatch):
    """export/Mongo item_id = double → npz เก็บ "x.0" (convention เดียวกับ
    product npz) — fetcher ต้อง canonicalize → digit string; anchor "x"
    ต้อง match npz "x.0" (full-gen smoke พบจริง)"""
    rows = [("28018035569.0", 0, "a", np.array([0.5, 0.5], np.float32)),
            ("49267582152.0", 0, "b stronger", np.array([0.99, 0.01], np.float32))]
    _wire(monkeypatch, _npz(rows),
          {28018035569: _doc("28018035569"), 49267582152: _doc("49267582152")})
    prof = _profile(anchor_item_ids=("28018035569",))
    res = _ps.fetch_description_evidence("q", retrieval_profile=prof)
    ids = [str(c["item_id"]) for c in res.cards]
    assert ids == ["28018035569"]
    assert res.cards[0]["_desc_hit"]["item_id"] == "28018035569"
    assert res.cards[0]["_desc_hit"]["chunk_id"] == "28018035569:0"


# ── G: fail-closed identity canonicalization ───────────────────────────────
# export/Mongo item_id = double → npz rows "x.0"; fetcher ต้อง canonicalize
# ด้วย digit-only parse — ห้าม float() (precision >2^53 / exponent / fraction
# alias) — malformed → ข้าม (fail closed, ห้าม alias เป็น item จริง)

def _fetch_one(monkeypatch, rows, docs, **prof):
    npz = {"item_ids": np.array([r[0] for r in rows], dtype=object),
           "chunk_ids": np.array([f"{r[0]}:{r[1]}" for r in rows],
                                 dtype=object),
           "emb": np.array([r[3] for r in rows], dtype=np.float32),
           "shops": np.array(["shopX"] * len(rows), dtype=object),
           "texts": np.array([r[2] for r in rows], dtype=object)}
    _wire(monkeypatch, npz, docs)
    return _ps.fetch_description_evidence(
        "q", retrieval_profile=_profile(**prof))


@pytest.mark.parametrize("raw", ["28018035569", "28018035569.0",
                                 "28018035569.00"])
def test_integral_id_forms_accepted(monkeypatch, raw):
    res = _fetch_one(monkeypatch,
                     [(raw, 0, "a", np.array([0.5, 0.5], np.float32))],
                     {28018035569: _doc("28018035569")})
    assert len(res.cards) == 1
    assert res.cards[0]["_desc_hit"]["item_id"] == "28018035569"


@pytest.mark.parametrize("raw", [28018035569, np.int64(28018035569),
                                 28018035569.0, np.float64(28018035569.0)])
def test_integral_numeric_id_types_accepted(monkeypatch, raw):
    # npz object array อาจเก็บ int/float ตรง (ไม่ใช่ str) → canon เดียวกัน
    res = _fetch_one(monkeypatch,
                     [(raw, 0, "a", np.array([0.5, 0.5], np.float32))],
                     {28018035569: _doc("28018035569")})
    assert len(res.cards) == 1
    assert res.cards[0]["_desc_hit"]["item_id"] == "28018035569"


def test_float_form_anchor_matches_through_same_canon_owner(monkeypatch):
    # anchor "x.0" ต้อง match npz "x.0" — ผ่าน canonical owner ตัวเดียวกัน
    res = _fetch_one(
        monkeypatch,
        [("28018035569.0", 0, "a", np.array([0.5, 0.5], np.float32))],
        {28018035569: _doc("28018035569")},
        anchor_item_ids=("28018035569.0",))
    assert [c["_desc_hit"]["item_id"] for c in res.cards] == ["28018035569"]


@pytest.mark.parametrize("raw", ["28018035569.5", "1e3", "NaN", "Infinity",
                                 "-1", "", " ", "abc", None, True, False])
def test_malformed_item_ids_rejected_fail_closed(monkeypatch, raw):
    # malformed row → ข้าม — ห้าม alias เป็น item จริงที่มี doc อยู่
    docs = {28018035569: _doc("28018035569"), 1000: _doc("1000"),
            -1: _doc("1"), 1: _doc("1"), 0: _doc("1")}
    res = _fetch_one(monkeypatch,
                     [(raw, 0, "a", np.array([0.5, 0.5], np.float32))],
                     docs)
    assert res.cards == ()


def test_beyond_float53_precision_id_not_corrupted(monkeypatch):
    # 2^53+1 — float() ปัดเป็น ...992 → ต้อง canon ตรง ไม่เพี้ยนเป็น item อื่น
    big = "9007199254740993"
    res = _fetch_one(monkeypatch,
                     [(f"{big}.0", 0, "a",
                       np.array([0.5, 0.5], np.float32))],
                     {int(big): _doc(big)})
    assert [c["_desc_hit"]["item_id"] for c in res.cards] == [big]


def test_fractional_row_cannot_satisfy_valid_anchor(monkeypatch):
    # row malformed ที่ score แรงกว่า ห้าม alias เข้า anchor ที่ valid
    res = _fetch_one(
        monkeypatch,
        [("28018035569.5", 0, "strong", np.array([0.99, 0.01], np.float32))],
        {28018035569: _doc("28018035569")},
        anchor_item_ids=("28018035569",))
    assert res.cards == ()


def test_malformed_anchor_yields_empty_not_unrestricted(monkeypatch):
    # raw anchor มีอยู่แต่ canon ไม่ได้ → restrict เป็น ∅ (fail closed)
    res = _fetch_one(
        monkeypatch,
        [("28018035569.0", 0, "a", np.array([0.5, 0.5], np.float32)),
         ("49267582152.0", 0, "b", np.array([0.9, 0.1], np.float32))],
        {28018035569: _doc("28018035569"),
         49267582152: _doc("49267582152")},
        anchor_item_ids=("garbage",))
    assert res.cards == ()


def test_productish_gate_required_in_runtime():
    """run_grouped_selection must expose desc_fetcher param (wired in impl)."""
    import inspect
    from chatbot.shopeechat import retrieval_runtime as _rt
    sig = inspect.signature(_rt.run_grouped_selection)
    assert "desc_fetcher" in sig.parameters
