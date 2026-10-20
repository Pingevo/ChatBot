"""Phase 4A — evidence-preserving source union contract suite.

Pins the corrected Phase 4A contracts against the real owners:

- candidate identity domain (v:/i:/n:) — variants of one item never merge;
  model_id alone is never an identity; listing i: converts to item-domain
  attachments only while ≥1 non-rejected variant candidate exists
- attachment identity domains (item/model/name) — joins enrich candidates
  without collapsing them
- stale subject snapshots — identity+history only; live truth owns
  publish/stock/link/sellable; missing live → historical_only + no sale link
- KB-only safety — item/model identity may join candidates; name-only stays
  supporting and can never become a sellable candidate
- one bounded subject batch — no find_one×N
- one grouped-selection execution per eligible turn — branch callsites are
  mutually exclusive; flag OFF untouched; flag ON fail-closed
"""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pymongo
import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

_env_before_replay_import = dict(os.environ)
import test_legacy_turn_incident_replay as replay  # noqa: E402
from test_legacy_turn_incident_replay import (  # noqa: E402
    _install, ADMIN_DB, PRODUCT_DB, COLL, FakeDb, FakeColl, FakeClient)

for _k in [k for k in os.environ if k not in _env_before_replay_import]:
    del os.environ[_k]
os.environ.update({k: v for k, v in _env_before_replay_import.items()
                   if os.environ.get(k) != v})
del _env_before_replay_import

from shopeechat import (  # noqa: E402
    app, candidate_pool, conversation_products, knowledge_base,
    product_store, retrieval_executor, retrieval_runtime, units)
from shopeechat.candidate_pool import (  # noqa: E402
    CandidatePool, EvidenceAttachment, PooledCandidate, build_candidate_pool)
from shopeechat.retrieval_executor import (  # noqa: E402
    RetrievalExecutionResult, execute_grouped_retrieval_requests)
from shopeechat.retrieval_planner import RetrievalRequest  # noqa: E402
from shopeechat.retrieval_policy import make_evidence_card  # noqa: E402
from shopeechat.retrieval_selection import select_for_llm_context  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult  # noqa: E402


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    """Same tripwire posture as the incident replay — any real seam fails."""
    monkeypatch.setattr(socket.socket, "connect",
                        lambda *a, **k: pytest.fail(
                            "OFFLINE LEAK: socket.connect", pytrace=False))
    monkeypatch.setattr(socket.socket, "connect_ex",
                        lambda *a, **k: pytest.fail(
                            "OFFLINE LEAK: connect_ex", pytrace=False))
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


# ── card/request/pipeline helpers ────────────────────────────────────────────

SHOP = "KingGadgets"


def _card(item_id=None, *, unit_id=None, model_id=None, name="X",
          catalog_status="active", customer_visible=True,
          product_type=None, shop=SHOP, **kw):
    """card ที่ canonicalize เป็น sellable (active) ตาม contract เดิมของ tests."""
    c = {"item_id": item_id, "name": name, "shop": shop,
         "status": "NORMAL", "total_stock": 5,
         "catalog_status": catalog_status,
         "customer_visible": customer_visible,
         "_available_for_sale": catalog_status == "active" and customer_visible,
         "availability_reason": "normal_positive_stock",
         "sellable": catalog_status == "active" and customer_visible}
    if unit_id is not None:
        c["unit_id"] = unit_id
    if model_id is not None:
        c["model_id"] = model_id
    if product_type is not None:
        c["product_type"] = product_type
    c.update(kw)
    return c


def _req(rid="r0", source="slot", types=(), subs=(), codes=()):
    return RetrievalRequest(
        request_id=rid, slot_id="s", source=source,
        product_types=frozenset(types), subtypes=frozenset(subs),
        model_codes=tuple(codes), target_device=None,
        availability_mode="", compat_mode="")


def _ures(cards):
    return UnitEvidenceFetchResult(
        cards=tuple(cards), raw_count=len(cards),
        sellable_count=sum(1 for c in cards if c.get("_available_for_sale")),
        unavailable_count=0, trace=("fake",))


def _union(reqs=(_req(),), units_cards=(), legacy_cards=(),
           channels=(), supporting=(), profile=None):
    """execute + pool — channels = ((channel_name, cards_or_result), ...)"""
    from shopeechat.retrieval_planner import channel_request
    chans = []
    for name, payload in channels:
        if isinstance(payload, (list, tuple)):
            data = tuple(payload)
            fn = lambda *a, _d=data, **k: _d
        else:
            fn = lambda *a, _d=payload, **k: _d
        chans.append((channel_request(name), fn))
    results = execute_grouped_retrieval_requests(
        tuple(reqs), message="m", shop=SHOP,
        # snap=None → standalone/hermetic: ไม่ resolve generation pointer
        #   (เดิมพึ่ง module-cache จาก test ก่อนหน้า — order-dependent)
        snap=None,
        fetcher=lambda m, **k: _ures(units_cards),
        legacy_fetcher=lambda m, **k: list(legacy_cards),
        channels=chans)
    all_reqs = tuple(reqs) + tuple(r for r, _ in chans)
    pool = build_candidate_pool(results, profile=profile,
                                supporting_evidence=tuple(supporting))
    sel = select_for_llm_context(pool, all_reqs, profile)
    return results, pool, sel


def _identities(pool):
    return {c.identity for c in pool.eligible + pool.unavailable + pool.rejected}


def _eligible_ids(pool):
    return {c.identity for c in pool.eligible}


def _attachments(pool, kind=None, domain=None):
    return [a for a in pool.evidence_pool
            if (kind is None or a.kind == kind)
            and (domain is None or a.identity_domain == domain)]


# ── 1-7: candidate/attachment identity domains ───────────────────────────────

def test_two_units_one_item_stay_two_candidates():
    """สอง unit ของ item เดียว = variant ต่างกัน → ห้าม merge (คง 2 candidates)."""
    u1 = _card("i1", unit_id="i1:m1", model_id="m1", name="เคส X ดำ")
    u2 = _card("i1", unit_id="i1:m2", model_id="m2", name="เคส X ขาว")
    _, pool, _ = _union(units_cards=[u1, u2])
    assert len(pool.eligible) == 2
    assert len({c.unit_id for c in pool.eligible}) == 2


def test_same_model_id_different_items_do_not_merge():
    """model_id เดียวกันข้าม item — ไม่ใช่ identity เดียวกัน → ไม่ merge."""
    a = _card("i1", unit_id="i1:m9", model_id="m9", name="A")
    b = _card("i2", unit_id="i2:m9", model_id="m9", name="B")
    _, pool, _ = _union(units_cards=[a, b])
    assert len(pool.eligible) == 2
    assert {c.item_id for c in pool.eligible} == {"i1", "i2"}


def test_listing_plus_variant_variant_only_selectable():
    """listing i:X + variant ของ X → เฉพาะ variant เป็น candidate —
    listing evidence แปลงเป็น item attachment."""
    u = _card("i1", unit_id="i1:m1", model_id="m1", name="เคส X ดำ")
    listing = _card("i1", name="เคส X (listing)")
    _, pool, sel = _union(units_cards=[u], legacy_cards=[listing])
    assert _eligible_ids(pool) == {pool.eligible[0].identity}
    assert pool.eligible[0].unit_id == "i1:m1"
    # listing ไม่ใช่ selectable candidate → identity ของมันไม่อยู่ใน output
    assert not any(c.identity == "i:i1" for c in
                   pool.eligible + pool.unavailable)
    assert not any(s.card.get("item_id") == "i1"
                   and s.card.get("unit_id") is None for s in sel.selected)


def test_listing_evidence_attaches_to_every_variant():
    """listing evidence attach ไปทุก variant ของ item เดียวกัน."""
    u1 = _card("i1", unit_id="i1:m1", model_id="m1", name="X ดำ")
    u2 = _card("i1", unit_id="i1:m2", model_id="m2", name="X ขาว")
    listing = _card("i1", name="เคส X (listing)")
    _, pool, _ = _union(units_cards=[u1, u2], legacy_cards=[listing])
    atts = _attachments(pool, kind="listing", domain="item")
    linked = {a.linked_candidate for a in atts}
    assert linked == {c.identity for c in pool.eligible}


def test_listing_stays_candidate_when_no_variant():
    """ไม่มี variant → listing i: เป็น candidate ปกติ."""
    listing = _card("i1", name="เคส X")
    _, pool, _ = _union(legacy_cards=[listing])
    assert _eligible_ids(pool) == {"i:i1"}


def test_item_attachment_fans_out_without_collapse():
    """attachment domain item join ทุก variant — ไม่ collapse candidates."""
    u1 = _card("i1", unit_id="i1:m1", model_id="m1")
    u2 = _card("i1", unit_id="i1:m2", model_id="m2")
    att = EvidenceAttachment(
        kind="kb_product", identity="i:i1", item_id="i1",
        linked_candidate=None, identity_domain="item",
        payload={"specs": {"w": "65W"}})
    kbres = SimpleNamespace(
        cards=(), raw_count=0,
        supporting_evidence=(), attachment_evidence=(att,), trace=())
    _, pool, _ = _union(units_cards=[u1, u2], channels=[("kb", kbres)])
    assert len(pool.eligible) == 2
    links = {a.linked_candidate for a in _attachments(pool, domain="item")}
    assert links == {c.identity for c in pool.eligible}


def test_model_attachment_joins_exact_variant_only():
    """attachment domain model join เฉพาะ v:{iid}#{mid} — ไม่ใช่ variant อื่น."""
    u1 = _card("i1", unit_id="i1:m1", model_id="m1", name="X ดำ")
    u2 = _card("i1", unit_id="i1:m2", model_id="m2", name="X ขาว")
    _, pool0, _ = _union(units_cards=[u1, u2])
    key2 = next(c.identity for c in pool0.eligible
                if c.unit_id == "i1:m2")
    att = EvidenceAttachment(
        kind="kb_product", identity=key2, item_id="i1",
        linked_candidate=None, identity_domain="model",
        payload={"specs": {"w": "65W"}})
    kbres = SimpleNamespace(
        cards=(), raw_count=0,
        supporting_evidence=(), attachment_evidence=(att,), trace=())
    _, pool, _ = _union(units_cards=[u1, u2], channels=[("kb", kbres)])
    linked = {a.linked_candidate for a in _attachments(pool, domain="model")}
    assert linked == {key2}


# ── 8/13/14: name-only + KB-only safety ──────────────────────────────────────

def test_name_only_never_sellable_candidate():
    """name-only card → identity_quality=name_only + ไม่ eligible (ไม่มี live
    status → publish unknown → sellable=False)."""
    n = {"name": "สายชาร์จลึกลับ", "shop": SHOP}
    _, pool, _ = _union(legacy_cards=[n])
    assert not pool.eligible
    assert all(c.identity_quality == "name_only"
               for c in pool.unavailable + pool.rejected)


def test_kb_name_only_stays_supporting_not_candidate():
    """kb doc ไม่มี item_id/model ที่ resolve ได้ → supporting เท่านั้น —
    ไม่ใช่ candidate และขายไม่ได้เด็ดขาด."""
    docs = [{"_id": "kb1", "type": "product_spec", "brand": "FX",
             "model": "", "category": "เคส",
             "specs": {"color": "black"}}]
    db = FakeDb({COLL: []})
    ev = knowledge_base.kb_product_evidence(db, docs, shop=SHOP)
    assert not ev.cards
    assert ev.supporting_evidence


def test_kb_text_cannot_set_stock_or_publish():
    """KB/raw prose ไม่มีสิทธิ์บอก publish/stock — card จาก KB text
    canonicalize เป็น unknown → sellable=False."""
    kb_card = knowledge_base._kb_doc_to_card(
        {"_id": "kb1", "type": "product_spec", "brand": "FX",
         "model": "K9", "specs": {"w": "65W"},
         "description": "stock ว่างเยอะมาก ขายดี"})
    cc = make_evidence_card(kb_card, source="kb")
    assert cc.get("publish_state") == "unknown"
    assert cc.get("stock_state") == "unknown"
    assert not cc.get("sellable")


# ── 9-10/18: stale subject snapshots ─────────────────────────────────────────

def _timeline_entry(item_id, stored_card=None, model_name=None):
    e = {"item_id": item_id, "is_anchor": True,
         "card": stored_card or {"item_id": item_id,
                                 "name": f"snap-{item_id}",
                                 "short_link": "https://s.shopee.co.th/old"}}
    if model_name:
        e["model_name"] = model_name
    return e


def _stub_clients(monkeypatch, db):
    """materialize/attach seams → FakeClient(db) — hermetic, ไม่แตะ real client."""
    client = FakeClient({PRODUCT_DB: db, ADMIN_DB: FakeDb()})
    monkeypatch.setattr(product_store, "_cached_client", client)
    monkeypatch.setattr(knowledge_base, "_cached_admin_client", client)
    monkeypatch.setattr("shopeechat.generation_pointer.resolve_snapshot",
                        lambda *a, **k: None)
    monkeypatch.setattr(units, "_units_coll",
                        lambda snap=None: client[ADMIN_DB]["sellable_units"])
    monkeypatch.setenv("MONGO_DB", PRODUCT_DB)
    monkeypatch.setenv("MONGO_COLLECTION", COLL)
    return client


def test_subject_snapshot_uses_live_truth_when_live_exists(monkeypatch):
    """subject ที่ live doc ยังอยู่ → live card (status/link สด) ไม่ใช่ snapshot."""
    doc = {"item_id": 5001, "item_name": "เคสสด", "item_status": "NORMAL",
           "shopname": SHOP, "stock_info_v2": {"stock": 7},
           "short_link": "https://s.shopee.co.th/live",
           "model": [], "tier_variation": []}
    db = FakeDb({COLL: [doc]})
    _stub_clients(monkeypatch, db)
    conversation_products._LIVE_CARD_CACHE.clear()
    entry = _timeline_entry(5001)
    cards = conversation_products.materialize_subject_cards(
        db, ["5001"], products=[entry], shop_filter=SHOP)
    assert len(cards) == 1
    assert not cards[0].get("_snapshot_only")
    cc = make_evidence_card(cards[0], source="subjects")
    assert cc.get("publish_state") == "published"


def test_missing_live_subject_is_historical_only_no_link(monkeypatch):
    """subject ที่ live หายไป → snapshot: historical_only + sellable=False
    + ไม่มีลิงก์ขาย — ตอบ spec/history ได้แต่ห้ามขาย."""
    db = FakeDb({COLL: []})
    _stub_clients(monkeypatch, db)
    conversation_products._LIVE_CARD_CACHE.clear()
    entry = _timeline_entry(9999)
    cards = conversation_products.materialize_subject_cards(
        db, ["9999"], products=[entry], shop_filter=SHOP)
    assert len(cards) == 1
    assert cards[0].get("_snapshot_only")
    assert not cards[0].get("short_link")
    cc = make_evidence_card(cards[0], source="subjects")
    assert cc.get("customer_visibility") == "historical_only"
    assert cc.get("publish_state") == "unknown"
    assert not cc.get("sellable")


def test_snapshot_and_live_merge_live_wins():
    """snapshot + live card identity เดียวกัน → merge แล้ว live ชนะ
    (_VIS_ORDER visible > historical_only) + snapshot evidence ไม่หาย."""
    live = _card("i9", name="สด", catalog_status="active")
    snap = {"item_id": "i9", "name": "เก่า", "_snapshot_only": True,
            "specs": {"w": "65W"}}
    _, pool, _ = _union(
        legacy_cards=[live],
        channels=[("subjects", [snap])])
    cand = next(c for c in pool.eligible + pool.unavailable
                if c.item_id == "i9")
    assert cand.card.get("customer_visibility") == "visible"
    snaps = _attachments(pool, kind="subject_snapshot")
    assert snaps and snaps[0].payload


def test_deleted_subject_unavailable_bucket_not_rejected():
    """snapshot-only card → unavailable bucket (ไม่ใช่ rejected/hidden)."""
    snap = {"item_id": "i9", "name": "เก่า", "_snapshot_only": True}
    _, pool, _ = _union(channels=[("subjects", [snap])])
    assert pool.unavailable and not pool.eligible
    assert pool.unavailable[0].reason


def test_hidden_unlist_rejected_historical_never_sellable():
    """UNLIST/hidden → rejected; historical_only → unavailable — ไม่มีทาง sellable."""
    hidden = _card("i1", name="ลับ", catalog_status="unlisted",
                   customer_visible=False)
    hist = _card("i2", name="เก่า", catalog_status="discontinued")
    _, pool, _ = _union(legacy_cards=[hidden, hist])
    rej = {c.item_id for c in pool.rejected}
    unav = {c.item_id for c in pool.unavailable}
    assert "i1" in rej and "i2" in unav
    assert not pool.eligible
    assert all(not c.card.get("sellable")
               for c in pool.rejected + pool.unavailable)


# ── 11-13: KB channel (bounded owner) ────────────────────────────────────────

def _kb_doc(brand="FX", model="K9", item_id=None):
    d = {"_id": f"kb-{model}", "type": "product_spec", "active": True,
         "brand": brand, "model": model, "category": "เคส",
         "specs": {"w": "65W"}, "warranty_period": "1y"}
    if item_id is not None:
        d["item_id"] = item_id
    return d


def _shop_doc(item_id, name, shop=SHOP):
    return {"item_id": item_id, "item_name": name, "item_status": "NORMAL",
            "shopname": shop, "stock_info_v2": {"stock": 3},
            "model": [], "tier_variation": []}


def test_kb_item_id_joins_matching_candidate():
    """kb doc มี item_id → attachment domain item join candidate เดิม —
    ไม่สร้าง candidate ใหม่."""
    u = _card("i1", unit_id="i1:m1", model_id="m1", name="FX K9")
    ev = knowledge_base.kb_product_evidence(
        FakeDb({COLL: []}), [_kb_doc(item_id="i1")], shop=SHOP)
    assert not ev.cards
    atts = [a for a in ev.attachment_evidence
            if a.identity_domain == "item" and a.item_id == "i1"]
    assert atts
    _, pool, _ = _union(units_cards=[u], channels=[("kb", ev)])
    links = {a.linked_candidate for a in _attachments(pool, kind="kb_product")}
    assert links == {pool.eligible[0].identity}


def test_kb_model_lookup_is_shop_scoped_and_bounded():
    """kb doc model → bounded lookup เดียว scoped ร้าน — ของร้านอื่นห้ามเข้า."""
    docs = [
        _shop_doc(7001, "FX K9 เคส", shop=SHOP),
        _shop_doc(7002, "FX K9 เคส ร้านอื่น", shop="OtherShop"),
    ]
    db = FakeDb({COLL: docs})
    find_calls = {"n": 0}
    coll = db[COLL]
    _orig = coll.find
    coll.find = lambda *a, **k: (find_calls.__setitem__(
        "n", find_calls["n"] + 1) or _orig(*a, **k))
    ev = knowledge_base.kb_product_evidence(
        db, [_kb_doc()], shop=SHOP)
    assert find_calls["n"] == 1, "kb model lookup ต้องเป็น query batch เดียว"
    assert ev.cards
    assert all(str(c.get("shop", "")).lower() == SHOP.lower()
               or not c.get("shop") for c in ev.cards)
    assert all(int(float(c["item_id"])) != 7002 for c in ev.cards)


def test_kb_unmatched_model_is_supporting_only():
    """kb doc model ไม่มี listing ในร้าน → supporting เท่านั้น (ไม่ใช่ candidate)."""
    ev = knowledge_base.kb_product_evidence(
        FakeDb({COLL: []}), [_kb_doc()], shop=SHOP)
    assert not ev.cards
    assert ev.supporting_evidence


# ── 15-16: compat + image/supporting evidence ────────────────────────────────

def test_compat_attach_no_duplicate_candidate():
    """compat card identity เดียวกับ unit → merge (sources += compat);
    compat card item ใหม่ → candidate แยกที่มี source compat — ไม่ซ้ำ."""
    u = _card("i1", unit_id="i1:m1", model_id="m1", name="X")
    compat_same = _card("i1", unit_id="i1:m1", model_id="m1", name="X")
    compat_new = _card("i7", name="Y", product_type="charger")
    _, pool, _ = _union(units_cards=[u],
                        channels=[("compat", [compat_same, compat_new])])
    ids = _eligible_ids(pool)
    assert len(ids) == 2
    srcs = {s for c in pool.eligible for s in c.sources}
    assert "compat" in srcs


def test_image_and_supporting_records_flow_to_pool():
    """vision/qa supporting records → pool.supporting_evidence;
    unit card image_text → image_text attachment (kind เดิม)."""
    u = _card("i1", unit_id="i1:m1", model_id="m1",
              image_text="OCR spec 65W")
    sup = [{"kind": "vision", "text": "รูปลูกค้า"},
           {"kind": "kb_qa", "text": "วิธีเคลม"}]
    _, pool, _ = _union(units_cards=[u], supporting=sup)
    assert {s["kind"] for s in pool.supporting_evidence} == {"vision", "kb_qa"}
    assert _attachments(pool, kind="image_text")


# ── 17: multi-need union keeps independent evidence ──────────────────────────

def test_multi_request_union_keeps_independent_sources():
    """slot + relation_target requests ต่างกัน → evidence ของทั้งคู่เข้า union."""
    r1 = _req("r1", types=("charger",))
    r2 = _req("r2", source="relation_target", types=("cable",))
    ad = _card("i1", unit_id="i1:m1", model_id="m1",
               product_type="charger", name="หัวชาร์จ")
    cb = _card("i2", unit_id="i2:m2", model_id="m2",
               product_type="cable", name="สาย")
    results, pool, sel = _union(reqs=(r1, r2), units_cards=[ad, cb])
    assert len(pool.eligible) == 2
    kinds = {a.source for res in results for a in res.source_attempts}
    assert "units" in kinds and "legacy" in kinds


# ── 19: one bounded subject batch (no find_one×N) ────────────────────────────

def test_subjects_materialize_one_batched_lookup(monkeypatch):
    """subject ids หลายตัว → ShpProducts query เดียว (strict scoped — F4
    review-fix: ไม่มี unscoped fallback) — ไม่ใช่ find_one ต่อ subject."""
    docs = [_shop_doc(5001, "A"), _shop_doc(5002, "B")]
    db = FakeDb({COLL: docs})
    _stub_clients(monkeypatch, db)
    counts = {"find": 0, "find_one": 0}
    coll = db[COLL]
    _of, _ofo = coll.find, coll.find_one
    coll.find = lambda *a, **k: (counts.__setitem__(
        "find", counts["find"] + 1) or _of(*a, **k))
    coll.find_one = lambda *a, **k: (counts.__setitem__(
        "find_one", counts["find_one"] + 1) or _ofo(*a, **k))
    conversation_products._LIVE_CARD_CACHE.clear()
    entries = [_timeline_entry(5001), _timeline_entry(5002),
               _timeline_entry(9999)]
    cards = conversation_products.materialize_subject_cards(
        db, ["5001", "5002", "9999"], products=entries, shop_filter=SHOP)
    assert len(cards) == 3
    assert counts["find_one"] == 0, (
        f"find_one×N เดิม ({counts['find_one']}) — ต้อง batch")
    assert counts["find"] == 1, (
        f"ShpProducts queries={counts['find']} — scoped ต้อง query เดียว")
    snap = [c for c in cards if c.get("_snapshot_only")]
    assert len(snap) == 1 and str(snap[0].get("item_id")) == "9999"


# ── 20-24: one execution per eligible turn + boundary fail-closed ────────────

def _fx(fid: str, *, grouped: bool, kb: bool = False) -> dict:
    d = {
        "id": fid,
        "shop": SHOP,
        "platform": "shopee",
        "conversation_id": f"fx-{fid}",
        "catalog": [_unlist_wpb100l()],
        "intent_result": {"intent": "other", "confidence": 0.5},
        "runtime_flags": {"grouped_selection": grouped},
    }
    if kb:
        d["kb"] = True
    return d


def _unlist_wpb100l() -> dict:
    return {
        "item_id": 3001.0,
        "item_name": "WPB100L เครื่องทำน้ำอุ่น 4500W",
        "item_status": "UNLIST",
        "shopname": SHOP,
        "cat_name": "เครื่องทำน้ำอุ่น",
        "condition": "new",
        "gen_price": 5900.0,
        "short_link": "https://s.shopee.co.th/wpb100l",
        "image": {"image_url_list": ["https://img.example/wpb.jpg"],
                  "image_id_list": ["wpbimg"]},
        "description": "WPB100L เครื่องทำน้ำอุ่น",
        "tier_variation": [],
        "model": [],
        "standardise_tier_variation": [],
    }


_KB_DOC = {"_id": "kb-wpb100l", "type": "product_spec", "active": True,
           "brand": "FX", "model": "WPB100L",
           "category": "เครื่องทำน้ำอุ่น",
           "specs": {"wattage": "4500W"}}


def _spy_run(monkeypatch, result=None, exc=None) -> dict:
    calls = {"n": 0, "kwargs": []}

    def _fake(*a, **kw):
        calls["n"] += 1
        calls["kwargs"].append(dict(kw))
        if exc is not None:
            raise exc
        return result

    monkeypatch.setattr(retrieval_runtime, "run_grouped_selection", _fake)
    return calls


def _chat(monkeypatch, fx: dict, message: str):
    client, captured, _ = _install(monkeypatch, fx)
    if fx.get("kb"):
        client[ADMIN_DB]["kb_products"].insert_one(_KB_DOC)
    resp = app.chat(app.ChatRequest(
        message=message, shop=fx["shop"], platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        limit=5, simulate_assignment=True,
        test_source="phase4a_union"))
    return resp, captured


def _payloads(captured):
    return [c["products"] for c in captured.calls]


def test_kb_branch_executes_union_once_with_branch_evidence(monkeypatch):
    """KB path: run_grouped_selection ต้องถูกเรียก 1 ครั้ง หลัง branch evidence
    พร้อม (subject_cards/compat_cards/kb_fetcher kwargs)."""
    calls = _spy_run(monkeypatch,
                     result={"selected_cards": [], "summary": {}})
    resp, _ = _chat(monkeypatch, _fx("kb", grouped=True, kb=True),
                    "wpb100l สเปค")
    assert resp.source.startswith("knowledge_base"), resp.source
    assert calls["n"] == 1
    kw = calls["kwargs"][0]
    assert "subject_cards" in kw, f"missing channel kwargs: {sorted(kw)}"
    assert "compat_cards" in kw
    assert "kb_fetcher" in kw
    assert "supporting" in kw


def test_main_branch_executes_union_once_with_branch_evidence(monkeypatch):
    """Main path: run_grouped_selection 1 ครั้งพร้อม subject/compat/supporting
    channels — ไม่ใช่ก่อน evidence พร้อม."""
    calls = _spy_run(monkeypatch,
                     result={"selected_cards": [], "summary": {}})
    resp, _ = _chat(monkeypatch, _fx("main", grouped=True), "มี WPB100L ไหม")
    assert resp.source == "product_store", resp.source
    assert calls["n"] == 1
    kw = calls["kwargs"][0]
    assert "subject_cards" in kw, f"missing channel kwargs: {sorted(kw)}"
    assert "compat_cards" in kw
    assert "supporting" in kw


def test_flag_off_skips_union_and_preserves_legacy_payload(monkeypatch):
    """flag OFF → pipeline ไม่รัน + legacy payload เหมือนเดิมเป๊ะ (WPB100L)."""
    calls = _spy_run(monkeypatch, result={"selected_cards": []})
    resp, captured = _chat(monkeypatch, _fx("off", grouped=False),
                           "มี WPB100L ไหม")
    assert calls["n"] == 0
    found = False
    for pl in _payloads(captured):
        for p in pl or []:
            try:
                iid = int(float(p.get("item_id") or 0))
            except (TypeError, ValueError):
                iid = 0
            if "WPB100L" in str(p.get("name", "")) and iid == 3001:
                found = True
    assert found, "legacy identity pin failed — WPB100L/3001 missing"


def test_flag_on_source_failure_fails_closed(monkeypatch):
    """flag ON + pipeline raise → products=[] fail closed — legacy ไม่ re-enter."""
    calls = _spy_run(monkeypatch, exc=RuntimeError("boom"))
    resp, captured = _chat(monkeypatch, _fx("on", grouped=True),
                           "มี WPB100L ไหม")
    assert calls["n"] == 1
    payloads = _payloads(captured)
    assert payloads
    for pl in payloads:
        assert pl == [], pl
        for p in pl:
            assert "WPB100L" not in str(p.get("name", ""))


# ══════════════════════════════════════════════════════════════════════════
# Review-fix round — F1 global pool / F2 KB model ownership /
# F3 supporting shape / F4 strict shop scope
# ══════════════════════════════════════════════════════════════════════════

# ── F1: global candidate identity (dedupe ข้าม results ไม่ใช่ต่อ result) ────

def test_global_identity_single_row_across_request_and_channel():
    """identity เดียวกันจาก units request + compat channel → PooledCandidate
    เดียว — sources/request_ids ต้องรวมทั้งสองฝั่ง (ไม่ใช่ row คู่)."""
    card = _card("i1", model_id="m1", name="VarM1")
    _, pool, _ = _union(
        reqs=(_req("r1"),), units_cards=[card],
        channels=(("compat", [dict(card)]),))
    rows = [c for c in pool.eligible if c.identity == "v:i1#m1"]
    assert len(rows) == 1, (
        f"duplicate candidate rows: {[c.identity for c in pool.eligible]}")
    c = rows[0]
    assert {"units", "compat"} <= set(c.sources)
    assert {"r1", "ch:compat"} <= set(c.request_ids)


def test_global_identity_single_row_across_two_requests():
    """identity เดียวกันใต้ 2 ordinary requests → 1 canonical candidate ที่
    มี request_ids ทั้งคู่ และยังถูกเลือกได้ทั้งสอง request."""
    shared = _card("i1", model_id="m1", name="VarM1")
    _, pool, sel = _union(
        reqs=(_req("r1"), _req("r2")), units_cards=[shared])
    rows = [c for c in pool.eligible if c.identity == "v:i1#m1"]
    assert len(rows) == 1, (
        f"duplicate candidate rows: {[c.identity for c in pool.eligible]}")
    assert set(rows[0].request_ids) == {"r1", "r2"}
    # Phase 6: selected = deduped final output (identity 1 row);
    #   per-request plays ดูที่ by_request attribution
    sel_rids = {s.request_id for _rid, picks in sel.by_request
                for s in picks if s.identity == "v:i1#m1"}
    assert sel_rids == {"r1", "r2"}, "candidate ต้องเล่นได้ทั้ง 2 requests"
    sel_rows = [s for s in sel.selected if s.identity == "v:i1#m1"]
    assert len(sel_rows) == 1, "selected ต้อง dedupe identity เหลือ 1 row"


def test_request_specific_slot_and_relation_preserved():
    """candidate ร่วม 2 requests → แต่ละ selection ต้องใช้ slot/relation
    ของ request ตัวเอง (ไม่ใช่ของ request อื่น)."""
    shared = _card("i1", model_id="m1", name="VarM1")
    r1 = RetrievalRequest(
        request_id="r1", slot_id="s1", source="slot",
        product_types=frozenset(), subtypes=frozenset(),
        model_codes=(), target_device=None,
        availability_mode="", compat_mode="")
    r2 = RetrievalRequest(
        request_id="r2", slot_id="s2", source="relation_target",
        relation_id="rel-9",
        product_types=frozenset(), subtypes=frozenset(),
        model_codes=(), target_device=None,
        availability_mode="", compat_mode="")
    _, pool, sel = _union(reqs=(r1, r2), units_cards=[shared])
    # Phase 6: selected dedupe identity — per-request slot/relation
    #   คงอยู่ใน by_request attribution
    s2 = next(s for _rid, picks in sel.by_request for s in picks
              if s.request_id == "r2" and s.identity == "v:i1#m1")
    assert s2.slot_id == "s2"
    assert s2.relation_id == "rel-9"
    s1 = next(s for _rid, picks in sel.by_request for s in picks
              if s.request_id == "r1" and s.identity == "v:i1#m1")
    assert s1.slot_id == "s1"


def test_pool_has_no_duplicate_identity_rows():
    """list length == set length ทุก bucket — ห้าม set-mask ปิด duplicate."""
    card = _card("i1", model_id="m1", name="V")
    _, pool, _ = _union(
        reqs=(_req("r1"),), units_cards=[card],
        channels=(("compat", [dict(card)]),))
    rows = list(pool.eligible) + list(pool.unavailable) + list(pool.rejected)
    ids = [c.identity for c in rows]
    assert len(ids) == len(set(ids)), f"duplicate identity rows: {ids}"


def test_item_attachment_joins_unique_candidates_once():
    """item attachment ต้อง join candidate ที่ unique จริง — identity เดียวกัน
    ข้าม results ต้องไม่เกิด linked copy ซ้ำ."""
    card = _card("i1", model_id="m1", name="V")
    att = EvidenceAttachment(
        kind="kb_product", identity="i:i1", item_id="i1",
        linked_candidate=None, identity_domain="item",
        payload={"specs": {"w": "65W"}})
    kbres = SimpleNamespace(
        cards=(), raw_count=0,
        supporting_evidence=(), attachment_evidence=(att,), trace=())
    _, pool, _ = _union(
        reqs=(_req("r1"),), units_cards=[card],
        channels=(("compat", [dict(card)]), ("kb", kbres)))
    links = [a.linked_candidate
             for a in _attachments(pool, kind="kb_product", domain="item")]
    assert links == ["v:i1#m1"], (
        f"attachment joined {len(links)} targets (duplicate rows?): {links}")


def test_two_variants_same_item_still_two_global_candidates():
    """global dedupe ต้องไม่กลืน variant ที่ต่างกันของ item เดียวกัน."""
    u1 = _card("i1", model_id="m1", name="X ดำ")
    u2 = _card("i1", model_id="m2", name="X ขาว")
    _, pool, _ = _union(reqs=(_req("r1"), _req("r2")),
                        units_cards=[u1, u2])
    rows = [c.identity for c in pool.eligible]
    assert len(rows) == len(set(rows)) == 2


# ── F2: KB model ownership — attach เฉพาะ product ที่ model match จริง ──────

def test_kb_model_payload_attaches_only_matching_item():
    """kb K9+K10 + products K9/K10/K90 → payload ของแต่ละ doc ต้องไปเฉพาะ
    item ที่ match — K9 ห้ามรั่วไป K90 (substring collision)."""
    docs = [_shop_doc(7001, "FX K9 เคส"),
            _shop_doc(7002, "FX K10 เคส"),
            _shop_doc(7003, "FX K90 เคส")]
    db = FakeDb({COLL: docs})
    ev = knowledge_base.kb_product_evidence(
        db, [_kb_doc(model="K9"), _kb_doc(model="K10")], shop=SHOP)
    by_item: dict[str, list] = {}
    for a in ev.attachment_evidence:
        by_item.setdefault(a.item_id, []).append(
            (a.payload or {}).get("model"))
    assert by_item.get("7001") == ["K9"], by_item
    assert by_item.get("7002") == ["K10"], by_item
    assert "7003" not in by_item, (
        f"K9/K10 evidence ห้ามไปแปะ K90: {by_item.get('7003')}")


def test_kb_model_row_match_attaches_model_domain():
    """token match model row (item_name ไม่มี token) → attachment domain
    `model` ที่ v:{iid}#{mid} — ไม่ใช่ fan-out ทั้ง item."""
    doc = {"item_id": 7004, "item_name": "เคส FX รุ่นใหม่",
           "item_status": "NORMAL", "shopname": SHOP,
           "stock_info_v2": {"stock": 3},
           "model": [{"model_name": "K10", "model_id": 88}],
           "tier_variation": []}
    ev = knowledge_base.kb_product_evidence(
        FakeDb({COLL: [doc]}), [_kb_doc(model="K10")], shop=SHOP)
    matts = [a for a in ev.attachment_evidence
             if a.identity_domain == "model"]
    assert matts, "model-row match ต้องเป็น model-domain attachment"
    assert matts[0].identity == "v:7004#88"
    assert not [a for a in ev.attachment_evidence
                if a.identity_domain == "item"], (
                    "model-row match ไม่ควร fan-out item domain")


def test_kb_matched_plus_unmatched_models_split():
    """1 matched + 1 unmatched: matched attach ถูก item; unmatched doc ไป
    supporting (ไม่ใช่ all-or-nothing)."""
    db = FakeDb({COLL: [_shop_doc(7001, "FX K9 เคส")]})
    ev = knowledge_base.kb_product_evidence(
        db, [_kb_doc(model="K9"), _kb_doc(model="NOSUCH1")], shop=SHOP)
    atts = [a for a in ev.attachment_evidence if a.item_id == "7001"]
    assert atts and all((a.payload or {}).get("model") == "K9"
                        for a in atts), atts
    sup_models = {(s.get("payload") or {}).get("model")
                  for s in ev.supporting_evidence}
    assert "NOSUCH1" in sup_models, (
        f"unmatched doc ต้องอยู่ supporting: {ev.supporting_evidence}")


def test_kb_multi_model_lookup_still_one_bounded_query():
    """หลาย kb model docs → lookup ยังเป็น bounded query เดียว scoped ร้าน."""
    db = FakeDb({COLL: [_shop_doc(7001, "FX K9 เคส"),
                       _shop_doc(7002, "FX K10 เคส")]})
    find_calls = {"n": 0}
    coll = db[COLL]
    _orig = coll.find
    coll.find = lambda *a, **k: (find_calls.__setitem__(
        "n", find_calls["n"] + 1) or _orig(*a, **k))
    knowledge_base.kb_product_evidence(
        db, [_kb_doc(model="K9"), _kb_doc(model="K10"),
             _kb_doc(model="K11")], shop=SHOP)
    assert find_calls["n"] == 1, (
        f"model lookup ต้องเป็น query batch เดียว — got {find_calls['n']}")


# ── F3: supporting evidence = sequence ของ dict records ────────────────────

def test_run_grouped_selection_supporting_records_passed_intact(monkeypatch):
    """records เข้า runtime → build_candidate_pool ได้ dict ตัวเดิม —
    ไม่ใช่ dict keys 'kind'/'text' แยกเป็น strings."""
    from shopeechat import route_context
    captured = {}
    _real = candidate_pool.build_candidate_pool

    def _spy(results, **kw):
        captured["sup"] = kw.get("supporting_evidence")
        return _real(results, **kw)

    monkeypatch.setattr(retrieval_runtime, "build_candidate_pool", _spy)
    sup = [{"kind": "kb", "text": "ctx รับประกัน 1 ปี"}]
    prof = route_context.build_retrieval_profile(
        "มี WPB100L ไหม", history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop=SHOP)
    out = retrieval_runtime.run_grouped_selection(
        prof, message="มี WPB100L ไหม", shop=SHOP, platform="shopee",
        fetcher=lambda m, **k: _ures([]),
        legacy_fetcher=lambda m, **k: [],
        supporting=sup)
    assert out is not None
    got = captured.get("sup")
    assert got is not None and all(isinstance(r, dict) for r in got), (
        f"supporting_evidence ต้องเป็น dict records: {got}")
    assert list(got) == sup


def test_kb_callsite_supporting_is_record_sequence(monkeypatch):
    """app.py KB callsite ต้องส่ง supporting เป็น list/tuple ของ dict —
    ไม่ใช่ bare dict (tuple(dict) → keys แยก)."""
    calls = _spy_run(monkeypatch,
                     result={"selected_cards": [], "summary": {}})
    resp, _ = _chat(monkeypatch, _fx("kb-sup", grouped=True, kb=True),
                    "wpb100l สเปค")
    assert resp.source.startswith("knowledge_base"), resp.source
    assert calls["n"] == 1
    sup = calls["kwargs"][0].get("supporting")
    assert isinstance(sup, (list, tuple)), (
        f"supporting ต้องเป็น record sequence ไม่ใช่ {type(sup)}")
    assert all(isinstance(r, dict) for r in sup)
    assert sup and sup[0].get("kind") == "kb"


# ── F4: strict shop scope — live lookup ห้ามข้ามร้าน ────────────────────────

def test_subject_never_pulls_other_shop_live_doc(monkeypatch):
    """subject 5001 ของ CurrentShop ไม่มี live doc → snapshot เท่านั้น —
    ห้าม fallback ไปเอา live card ของร้านอื่นมาใส่."""
    doc_other = _shop_doc(5001, "สินค้าร้านอื่น", shop="OtherShop")
    db = FakeDb({COLL: [doc_other]})
    _stub_clients(monkeypatch, db)
    conversation_products._LIVE_CARD_CACHE.clear()
    entry = _timeline_entry(5001)
    cards = conversation_products.materialize_subject_cards(
        db, ["5001"], products=[entry], shop_filter=SHOP)
    assert len(cards) == 1
    c = cards[0]
    assert c.get("_snapshot_only"), (
        f"cross-shop live doc รั่วเข้ามาเป็น live card: {c.get('name')}")
    assert c.get("name") == "snap-5001"
    assert not c.get("short_link")
    cc = make_evidence_card(c, source="subjects")
    assert cc.get("customer_visibility") == "historical_only"
    assert not cc.get("sellable")
