"""Task 4D pins — profile-backed callsites use RetrievalProfile as canonical
retrieval hints (conservative recall), while retrieval_profile=None keeps the
legacy detection path byte-identical. No Mongo/LLM needed (fake db)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import product_store, route_context, units  # noqa: E402


class _FakeCursor(list):
    def __init__(self, docs, limit_log=None, query=None):
        super().__init__(docs)
        self._limit_log = limit_log
        self._query = query

    def limit(self, n):
        if self._limit_log is not None:
            self._limit_log.append((self._query, n))
        return self


class _FakeColl:
    def __init__(self, docs):
        self.docs = list(docs)
        self.queries = []
        self.limit_log = []

    def find(self, q=None, *_a, **_k):
        q = q or {}
        self.queries.append(q)
        return _FakeCursor(self.docs, self.limit_log, q)

    def find_one(self, *_a, **_k):
        return self.docs[0] if self.docs else None


class _FakeDB:
    def __init__(self, docs):
        self.coll = _FakeColl(docs)

    def __getitem__(self, _name):
        return self.coll


def _doc(iid, name, stock=5, status="NORMAL"):
    return {"item_id": iid, "item_name": name, "item_status": status,
            "shopname": "KingGadgets", "price": 199,
            "stock_info_v2": {"summary_info": {"total_available_stock": stock}}}


def _mi17_profile():
    # "อยากได้ที่ใช้กับ mi 17 ultra" + history "มีสายชาร์จไหม"
    return route_context.build_retrieval_profile(
        "อยากได้ที่ใช้กับ mi 17 ultra",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets",
    )


def _queries_text(coll):
    return " | ".join(str(q) for q in coll.queries)


def test_profile_types_drive_retrieval_query(monkeypatch):
    """Message alone detects no charger; profile charger+cable must drive query."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = _mi17_profile()
    assert prof.product_types == frozenset({"charger"})
    db = _FakeDB([_doc(1, "สายชาร์จ Type-C 100W")])
    product_store.fetch_products(db, "อยากได้ที่ใช้กับ mi 17 ultra",
                                 shop_filter="KingGadgets",
                                 retrieval_profile=prof)
    qt = _queries_text(db.coll).lower()
    assert "charger" in qt or "ชาร์จ" in qt or "สาย" in qt, qt


def test_none_profile_keeps_legacy_detection(monkeypatch):
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    db = _FakeDB([_doc(1, "สายชาร์จ Type-C 100W")])
    product_store.fetch_products(db, "อยากได้ที่ใช้กับ mi 17 ultra",
                                 shop_filter="KingGadgets")
    qt = _queries_text(db.coll).lower()
    assert "charger" not in qt and "ชาร์จ" not in qt


def test_profile_subtype_drives_charger_filter(monkeypatch):
    """subtype=cable from profile → cable survives, adapter filtered out."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = _mi17_profile()
    assert prof.subtype == "cable"
    docs = [_doc(1, "สายชาร์จ Type-C 100W Cable"),
            _doc(2, "หัวชาร์จ Adapter 65W GaN")]
    db = _FakeDB(docs)
    out = product_store.fetch_products(db, "อยากได้ที่ใช้กับ mi 17 ultra",
                                       shop_filter="KingGadgets",
                                       retrieval_profile=prof)
    names = [str(p.get("name") or "") for p in out]
    assert any("สายชาร์จ" in n or "cable" in n.lower() for n in names)


def test_profile_model_codes_direct_recall(monkeypatch):
    """codes absent from message (follow-up) still hit item_name regex recall."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "ตัวนี้ยังมีไหม",
        history=[{"role": "user", "text": "HA835 พร้อมสายราคาเท่าไหร่"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets",
    )
    assert "HA835" in prof.model_codes
    db = _FakeDB([_doc(1, "Anker HA835 พร้อมสาย")])
    product_store.fetch_products(db, "ตัวนี้ยังมีไหม", shop_filter="KingGadgets",
                                 retrieval_profile=prof)
    # code → bounded item_name regex — เทียบค่า $regex ตรงๆ (str(dict) escape \ เป็นสองตัว)
    needle = product_store._model_token_regex_str("HA835")
    assert any(needle == (q.get("item_name") or {}).get("$regex")
               for q in db.coll.queries)


def test_compat_profile_widens_pool(monkeypatch):
    """compat_mode!=none → is_compat_check → unit index skipped even when flag on."""
    monkeypatch.setenv("USE_UNIT_INDEX", "1")
    called = []
    monkeypatch.setattr(units, "fetch_unit_cards",
                        lambda *a, **k: called.append(k) or [])
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = _mi17_profile()
    assert prof.compat_mode == "connector_required"
    db = _FakeDB([_doc(1, "สายชาร์จ Type-C 100W")])
    product_store.fetch_products(db, "อยากได้ที่ใช้กับ mi 17 ultra",
                                 shop_filter="KingGadgets",
                                 retrieval_profile=prof)
    assert not called, "compat profile must skip unit-index path"


def test_answerable_all_never_drops_unavailable(monkeypatch):
    """availability_mode=answerable_all → filter_unavailable forced off."""
    monkeypatch.setenv("USE_UNIT_INDEX", "1")
    seen = {}
    monkeypatch.setattr(units, "fetch_unit_cards",
                        lambda *a, **k: seen.update(k) or [])
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "HA835 ยังมีประกันไหม", history=[],
        intent_result={"intent": "warranty_duration", "confidence": 0.9},
        shop="KingGadgets")
    assert prof.availability_mode == "answerable_all"
    db = _FakeDB([_doc(1, "Anker HA835")])
    product_store.fetch_products(db, "HA835 ยังมีประกันไหม",
                                 shop_filter="KingGadgets",
                                 filter_unavailable=True,
                                 retrieval_profile=prof)
    assert seen.get("sellable_only") is False


def test_fetch_units_uses_profile_codes(monkeypatch):
    coll = _FakeColl([])
    monkeypatch.setattr(units, "_units_coll", lambda: coll)
    monkeypatch.setattr(units, "_vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "HA835 ยังมีประกันไหม", history=[],
        intent_result={"intent": "warranty_duration", "confidence": 0.9},
        shop="KingGadgets")
    units.fetch_units("HA835 ยังมีประกันไหม", retrieval_profile=prof)
    assert any("HA835" in str(q).upper() for q in coll.queries)


def test_fetch_units_profile_skips_resolve_route(monkeypatch):
    coll = _FakeColl([])
    monkeypatch.setattr(units, "_units_coll", lambda: coll)
    monkeypatch.setattr(units, "_vector_search", lambda *a, **k: [])
    calls = []
    orig = route_context.resolve_route
    monkeypatch.setattr(route_context, "resolve_route",
                        lambda m: (calls.append(m), orig(m))[1])
    units.fetch_units("สายชาร์จ", retrieval_profile=_mi17_profile())
    assert calls == []
    units.fetch_units("สายชาร์จ")
    assert calls == ["สายชาร์จ"]


def test_fetch_unit_cards_profile_skips_resolve_route(monkeypatch):
    coll = _FakeColl([])
    monkeypatch.setattr(units, "_units_coll", lambda: coll)
    monkeypatch.setattr(units, "_vector_search", lambda *a, **k: [])
    calls = []
    monkeypatch.setattr(route_context, "resolve_route",
                        lambda m: (calls.append(m), None))
    units.fetch_unit_cards("สายชาร์จ", retrieval_profile=_mi17_profile())
    assert calls == []


def test_sellable_first_keeps_fallback(monkeypatch):
    """sellable_first: sellable first via existing rerank — non-sellable kept."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "มีสายชาร์จไหม", history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="KingGadgets")
    assert prof.availability_mode == "sellable_first"
    docs = [_doc(1, "สายชาร์จ Type-C 100W หมด", stock=0),
            _doc(2, "สายชาร์จ Type-C 60W มีของ", stock=5)]
    db = _FakeDB(docs)
    out = product_store.fetch_products(db, "มีสายชาร์จไหม",
                                       shop_filter="KingGadgets",
                                       retrieval_profile=prof)
    assert out, "pool must not empty out"


# ---- Phase 4D Hardening: subtype fail-open + supplement audit ----------------


def test_subtype_wrong_fails_open(monkeypatch):
    """Profile subtype=cable แต่ pool มีแต่ adapter → filter ว่าง → คืน docs เดิม."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = _mi17_profile()
    assert prof.subtype == "cable"
    db = _FakeDB([_doc(1, "หัวชาร์จ Adapter 65W GaN")])
    out = product_store.fetch_products(db, "อยากได้ที่ใช้กับ mi 17 ultra",
                                       shop_filter="KingGadgets",
                                       retrieval_profile=prof)
    assert out, "fail-open: empty filter must restore docs"


def test_multi_subtype_message_pool_survives(monkeypatch):
    """'สายชาร์จกับหัวชาร์จ' → subtype เดียว (cable) ต้องไม่ฆ่า pool ทั้งก้อน."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "มีสายชาร์จกับหัวชาร์จไหม", history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="KingGadgets")
    # singular subtype — multi-subtype จริงอยู่ใน Task 4E scope
    docs = [_doc(1, "สายชาร์จ Type-C 100W Cable"),
            _doc(2, "หัวชาร์จ Adapter 65W GaN")]
    db = _FakeDB(docs)
    out = product_store.fetch_products(db, "มีสายชาร์จกับหัวชาร์จไหม",
                                       shop_filter="KingGadgets",
                                       retrieval_profile=prof)
    assert out, "multi-subtype question must not empty the pool"


def test_none_profile_keeps_hard_subtype_filter(monkeypatch):
    """profile=None → strict filter ยังฆ่า pool ได้เหมือน legacy (ไม่ fail-open)."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    db = _FakeDB([_doc(1, "หัวชาร์จ Adapter 65W GaN")])
    out = product_store.fetch_products(db, "มีสายชาร์จไหม",
                                       shop_filter="KingGadgets")
    names = [str(p.get("name") or "") for p in out]
    assert not any("adapter" in n.lower() or "หัวชาร์จ" in n for n in names), \
        "legacy strict filter must not leak adapter back"


def test_supplement_bounded_regex_shop_and_limit(monkeypatch):
    """supplement: _model_token_regex_str + shopname filter + limit(5) ต่อ code."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "ตัวนี้ยังมีไหม",
        history=[{"role": "user", "text": "HA835 พร้อมสายราคาเท่าไหร่"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets")
    assert "HA835" in prof.model_codes
    db = _FakeDB([_doc(1, "Anker HA835 พร้อมสาย")])
    product_store.fetch_products(db, "ตัวนี้ยังมีไหม", shop_filter="KingGadgets",
                                 retrieval_profile=prof)
    needle = product_store._model_token_regex_str("HA835")
    assert any((q.get("item_name") or {}).get("$regex") == needle
               and q.get("shopname")
               for q, n in db.coll.limit_log if n == 5), \
        f"no bounded-regex+shop+limit5 supplement query: {db.coll.limit_log}"


def test_supplement_dedupes_and_appends(monkeypatch):
    """code-hit ซ้ำกับ docs หลัก → dedupe ด้วย item_id; supplement append ไม่แทนที่."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "ตัวนี้ยังมีไหม",
        history=[{"role": "user", "text": "HA835 พร้อมสายราคาเท่าไหร่"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets")
    db = _FakeDB([_doc(1, "Anker HA835 พร้อมสาย")])
    out = product_store.fetch_products(db, "ตัวนี้ยังมีไหม",
                                       shop_filter="KingGadgets",
                                       retrieval_profile=prof)
    iids = [p.get("item_id") for p in out if p.get("item_id") is not None]
    assert len(iids) == len(set(iids)), f"duplicate item_id leaked: {iids}"


def test_no_supplement_without_model_codes(monkeypatch):
    """profile ไม่มี model_codes → ไม่มี bounded item_name regex query เลย."""
    monkeypatch.setattr(product_store, "vector_search", lambda *a, **k: [])
    prof = route_context.build_retrieval_profile(
        "มีสายชาร์จไหม", history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="KingGadgets")
    assert not prof.model_codes
    db = _FakeDB([_doc(1, "สายชาร์จ Type-C 100W")])
    product_store.fetch_products(db, "มีสายชาร์จไหม",
                                 shop_filter="KingGadgets",
                                 retrieval_profile=prof)
    assert not any("(?<!" in str((q.get("item_name") or {}).get("$regex", ""))
                   for q in db.coll.queries), db.coll.queries
