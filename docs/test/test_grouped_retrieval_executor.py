from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult  # noqa: E402
from shopeechat.retrieval_planner import build_grouped_retrieval_requests  # noqa: E402
from shopeechat.retrieval_executor import execute_grouped_retrieval_requests  # noqa: E402


def _pipeline(message: str):
    prof = route_context.build_retrieval_profile(
        message,
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.92},
        shop="KingGadgets",
    )
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    return build_grouped_retrieval_requests(prof, slots, rels)


def _card(name="card", ptype="case", avail=True, **kw):
    c = {"unit_id": kw.pop("unit_id", "u"), "item_id": "i",
         "name": name, "product_type": ptype,
         "_available_for_sale": avail,
         "availability_reason": "" if avail else "sold_out",
         "catalog_status": "active" if avail else "out_of_stock",
         "total_stock": 5 if avail else 0}
    c.update(kw)
    return c


def _res(cards, raw=None):
    cards = tuple(cards)
    n = sum(1 for c in cards if c.get("_available_for_sale"))
    return UnitEvidenceFetchResult(
        cards=cards, raw_count=len(cards) if raw is None else raw,
        sellable_count=n, unavailable_count=len(cards) - n,
        trace=("fake",))


class _FakeFetcher:
    """fetcher ปลอม signature = units.fetch_unit_evidence —
    responder(profile) เลือก docs ต่อ request ได้"""
    def __init__(self, responder=None):
        self.calls: list[dict] = []
        self.responder = responder or (lambda prof: ())

    def __call__(self, message, *, retrieval_profile=None, shop=None,
                 limit=8, **kw):
        self.calls.append({"message": message, "profile": retrieval_profile,
                           "shop": shop, "limit": limit, "kw": kw})
        out = self.responder(retrieval_profile)
        if isinstance(out, Exception):
            raise out
        return _res(out)


def test_relation_executes_base_and_target_requests():
    reqs = _pipeline(
        "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้างในร้านเรา "
        "ขอแบบมีจอ ยาว 2 เมตรและได้เต็มสปีด")
    fetcher = _FakeFetcher(lambda prof: [
        _card("AD1404T charger", "charger", charger_subtype="adapter")
        if prof.subtype != "cable"
        else _card("cable 2m", "cable", charger_subtype="cable")])
    results = execute_grouped_retrieval_requests(
        reqs, message="ignored", shop="KingGadgets", fetcher=fetcher)

    assert len(results) == 2
    base = next(r for r in results if r.source == "slot")
    target = next(r for r in results if r.source == "relation_target")
    assert ("model_code", "AD1404T") in base.hard_filters
    assert not any(k == "model_code" for k, _ in target.hard_filters)
    assert any("cable" in t for t in target.trace)
    assert any("relation_target" in t for t in target.trace)
    target_call = fetcher.calls[-1]
    assert target_call["profile"].model_codes == ()
    assert target_call["profile"].subtype == "cable"
    # target ค้นด้วย target-side text ไม่ใช่ message เต็ม
    assert "สายชาร์จ" in target_call["message"]
    assert "หัวชาร์จ AD1404T" not in target_call["message"]
    # cable card เข้า eligible ของ target request
    assert target.eligible_candidates
    assert target.eligible_candidates[0]["charger_subtype"] == "cable"


def test_exact_model_executes_identity_request_only():
    reqs = _pipeline("รุ่น AD1404T ยังมีขายไหม")
    fetcher = _FakeFetcher(lambda prof: [_card("AD1404T", "charger")])
    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=fetcher)

    assert len(results) == 1
    assert fetcher.calls[0]["profile"].model_codes == ("AD1404T",)
    assert results[0].error is None


def test_device_compat_no_relation_target():
    reqs = _pipeline("หัวชาร์จ AD653T ใช้กับ ip14 ได้ไหม")
    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=_FakeFetcher())

    assert all(r.source != "relation_target" for r in results)
    assert not any(k == "target_device" for k, _ in results[0].hard_filters)


def test_bare_head_executes_nothing():
    reqs = _pipeline("หัวอันนี้ใช้กับสายไหน")
    assert execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=_FakeFetcher()) == ()


def test_multi_slot_separate_quota_no_cross_fill():
    # เคสเจอ ฟิล์มไม่เจอ — slot-screen_protector ต้องมี evidence/trace
    # ไม่เงียบหาย และห้ามเอา case มาแทน
    reqs = _pipeline("มีเคสกับฟิล์มสำหรับ iPhone 15 ไหม")
    fetcher = _FakeFetcher(lambda prof: [
        _card("เคส iPhone 15", "case", unit_id="c1")]
        if "case" in prof.product_types else [])
    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=fetcher)

    by_slot = {}
    for r in results:
        by_slot[r.request_id] = r
    assert len(results) >= 2
    sp = next(r for r in results
              if "screen_protector" in dict(r.hard_filters).values())
    assert sp.eligible_candidates == ()
    assert sp.source_attempts  # raw=0 ยังถูกบันทึก ไม่หายเงียบ
    assert sp.source_attempts[0].raw_count == 0
    # case candidates ห้ามรั่วไป slot ฟิล์ม
    assert all(c.get("product_type") != "case"
               for c in sp.eligible_candidates)


def test_all_dead_units_become_unavailable_evidence_not_lost():
    reqs = _pipeline("รุ่น AD1404T ยังมีขายไหม")
    fetcher = _FakeFetcher(lambda prof: [
        _card("AD1404T dead", "charger", avail=False, unit_id="dead1")])
    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=fetcher)

    r = results[0]
    assert r.eligible_candidates == ()
    assert len(r.unavailable_evidence) == 1
    assert r.source_attempts[0].raw_count > 0
    assert r.source_attempts[0].unavailable_count == 1


def test_wrong_device_card_goes_rejected_not_eligible():
    # ฟิล์ม iPhone 15 — card ชื่อชัดว่าเป็นของ device อื่นต้อง reject
    reqs = _pipeline("มีฟิล์มสำหรับ iPhone 15 ไหม")
    fetcher = _FakeFetcher(lambda prof: [
        _card("ฟิล์มกระจก Haylou Watch 8", "screen_protector"),
        _card("ฟิล์ม Mi Band 8 Pro", "screen_protector"),
        _card("ฟิล์มกันรอยสำหรับ iPhone 15", "screen_protector")])
    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=fetcher)

    r = results[0]
    names = {c["name"] for c in r.eligible_candidates}
    assert "ฟิล์มกันรอยสำหรับ iPhone 15" in names
    rej = {c["name"]: c.get("_selection_reason")
           for c in r.rejected_evidence}
    assert "ฟิล์มกระจก Haylou Watch 8" in rej
    assert "ฟิล์ม Mi Band 8 Pro" in rej
    assert all("device_mismatch" in (v or "") for v in rej.values())


def test_wrong_type_card_rejected():
    # cable unit หลุดมาใน case request → rejected ไม่ใช่ eligible
    reqs = _pipeline("มีเคส iPhone 15 ไหม")
    fetcher = _FakeFetcher(lambda prof: [
        _card("สายชาร์จ type-c", "cable", charger_subtype="cable"),
        _card("เคส iPhone 15", "case")])
    r = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=_FakeFetcher(
            lambda prof: [
                _card("สายชาร์จ type-c", "cable", charger_subtype="cable"),
                _card("เคส iPhone 15", "case")]))[0]
    assert [c["name"] for c in r.eligible_candidates] == ["เคส iPhone 15"]
    assert r.rejected_evidence[0]["name"] == "สายชาร์จ type-c"


def test_subtype_mismatch_rejected_in_cable_target():
    # adapter unit ใน cable-target request = rejected (subtype_mismatch)
    reqs = _pipeline("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน")
    fetcher = _FakeFetcher(lambda prof: [
        _card("หัวชาร์จ", "charger", charger_subtype="adapter")])
    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=fetcher)
    target = next(r for r in results if r.source == "relation_target")
    assert target.eligible_candidates == ()
    assert target.rejected_evidence


def test_source_error_isolated_not_fatal():
    reqs = _pipeline("มีเคสกับฟิล์มสำหรับ iPhone 15 ไหม")
    calls = {"n": 0}

    def flaky(message, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db down")
        return _res([_card("ฟิล์ม iPhone 15", "screen_protector")])

    results = execute_grouped_retrieval_requests(
        reqs, message="x", shop="KingGadgets", fetcher=flaky)
    assert results[0].error == "db down"
    assert any(r.error is None and r.eligible_candidates
               for r in results[1:])


def test_live_units_fetch_smoke():
    """integration — skip ถ้า Mongo/env ไม่พร้อม (read-only)"""
    try:
        from dotenv import load_dotenv
        load_dotenv()
        from shopeechat import units, product_store
        units._units_coll().find_one()
        # listing join ใช้ product DB (MONGO_*) — creds พังก็ต้อง skip ไม่ใช่ fail
        product_store.get_client().admin.command("ping")
    except (Exception, SystemExit) as exc:
        pytest.skip(f"units/product DB unavailable: {exc}")
    msg = ("หัวชาร์จ AD1404T ใช้กับสายชาร์จไหนได้บ้างในร้านเรา "
           "ขอแบบมีจอ ยาว 2 เมตรและได้เต็มสปีด")
    reqs = _pipeline(msg)
    results = execute_grouped_retrieval_requests(
        reqs, message=msg, shop="KingGadgets")
    assert len(results) == 2
    assert all(r.error is None for r in results)
    target = next(r for r in results if r.source == "relation_target")
    # cable evidence ต้องถูกเก็บ — sellable→eligible / dead→unavailable
    seen = (target.eligible_candidates + target.unavailable_evidence
            + target.rejected_evidence)
    assert any(c.get("product_type") == "cable" for c in seen)
    assert all("AD1404T" not in str(c.get("model_codes") or ())
               for c in seen)
