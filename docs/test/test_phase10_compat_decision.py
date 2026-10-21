"""Phase 10A correction round 2 — typed compatibility decision
(H1 exact relation / M1 proof validation / H2 decision→composition).

Contract under test:
- relation = typed identity (subject,target,relation) จาก owner เดิม
  (`RetrievalRequest.relation_type` หรือ `compat_mode` ที่ map ได้
  relation เดียว) — ห้ามเดา/ลองหลาย relation; ไม่มี/กำกวม → fail closed
- declared proof ผ่าน `compat_proof_from_dict` เท่านั้น — malformed/
  unknown source reject (fail closed); customer → resolver admin_review
- covered verdict → `CompatVerdict` record + deterministic compat segment
  ที่ composition (ไม่ใช่ model task) — compat-only → answer_calls == 0,
  mixed → ≤1; connector equality prove ได้เฉพาะ connector relation เท่านั้น
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from test_phase7_answer_context import (  # noqa: E402  — reuse typed builders
    _req, _sel_card, _selection, _pool, _profile, _compile,
)
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402

TurnNeed = td.TurnNeed


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    import socket
    import urllib.request

    def _fail(what):
        def _g(*a, **k):
            pytest.fail(f"OFFLINE LEAK: {what}", pytrace=False)
        return _g
    monkeypatch.setattr(socket.socket, "connect", _fail("socket.connect"))
    monkeypatch.setattr(urllib.request, "urlopen", _fail("urllib.urlopen"))
    import pymongo
    monkeypatch.setattr(pymongo.MongoClient, "__init__",
                        _fail("MongoClient.__init__"))
    yield


def _compat(refs=("W01",), types=("smartwatch",)):
    return TurnNeed(kind="compat", operation="compat",
                    subject_refs=tuple(refs),
                    product_types=frozenset(types))


def _unans(ctx, idx):
    return next((u for u in ctx.unanswered_needs
                 if u.need_index == idx), None)


def _proof(target="strava", subject="i:1", relation="works_with",
           verdict="compatible", source="spec-db", refs=("i:1",)):
    return {"kind": "device_spec", "target": target,
            "subject_id": subject, "relation": relation,
            "verdict": verdict, "source": source,
            "subject_refs": tuple(refs)}


def _w01(cm="bluetooth_general", target="strava", types=("smartwatch",)):
    """W01→strava compat need + slot-carried target + selected card."""
    need = _compat(types=types)
    req = _req(rid="req-0", types=types, codes=("W01",),
               target=target, cm=cm)
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    return need, (req,), _selection((card, "req-0"))


# ── H1 — exact typed relation (no guessing) ─────────────────────────────────

def test_charges_proof_does_not_cover_works_with_need():
    """works_with question (bluetooth_general) + charges proof →
    resolver filter relation ตรงเท่านั้น → ไม่ cover → no_evidence"""
    need, reqs, sel = _w01(cm="bluetooth_general")
    pool = _pool(supporting=(_proof(relation="charges"),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_works_with_proof_does_not_cover_charges_need():
    """charges question (connector_required) + works_with proof →
    no_evidence — proof ของ relation อื่นใช้ไม่ได้"""
    need = _compat(refs=("AC65B",), types=("cable",))
    req = _req(rid="req-0", types=("cable",), codes=("AC65B",),
               target="iphone 15", cm="connector_required")
    card = _sel_card("i:1", "subject", "req-0",
                     "สายชาร์จ C to C 1m", model_codes=["AC65B"])
    pool = _pool(supporting=(_proof(
        target="iphone 15", relation="works_with"),))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_missing_relation_fails_closed():
    """request ไม่มี typed relation (compat_mode=none, ไม่มี
    relation_type) + proof ถูกต้องครบก็ตาม → no_evidence — ไม่มี
    relation ไม่เดา"""
    need, reqs, sel = _w01(cm="none")
    pool = _pool(supporting=(_proof(),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_ambiguous_relation_fails_closed():
    """สอง carrier ของ target เดียวกัน map คนละ relation
    (connector_required→charges vs bluetooth_general→works_with) →
    ambiguous → fail closed no_evidence"""
    need = _compat()
    req_a = _req(rid="req-a", types=("smartwatch",), codes=("W01",),
                 target="strava", cm="connector_required")
    req_b = _req(rid="req-b", types=("smartwatch",), codes=("W01",),
                 target="strava", cm="bluetooth_general")
    card = _sel_card("i:1", "subject", "req-a", "W01 watch",
                     model_codes=["W01"])
    sel = _selection((card, "req-a"))
    pool = _pool(supporting=(_proof(relation="charges"),))
    ctx = _compile((need,), sel, pool, (req_a, req_b), _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_bluetooth_connector_does_not_prove_works_with():
    """W01→strava (works_with): connector=bluetooth ตรงกันทั้งสองฝั่ง
    ก็ไม่เป็น proof — works_with ต้องการ declares_device typed fact
    เท่านั้น → no_evidence"""
    need, _reqs, _sel = _w01(cm="bluetooth_general")
    reqs = _reqs
    sel = _selection((_sel_card("i:1", "subject", "req-0", "W01 watch",
                              model_codes=["W01"],
                              connector="bluetooth"), "req-0"))
    web = ({"kind": "web", "target": "strava", "need_index": 0,
            "payload": "strava sync",
            "data": {"connector": "bluetooth",
                     "source": "web-structured"}},)
    ctx = _compile((need,), sel, _pool(), reqs, _profile(),
                   web_evidence=web)
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_structured_connector_covers_exact_charges_relation():
    """connector equality prove ได้เฉพาะ connector relation —
    connector_required→charges + usb-c↔usb-c structured → covered
    (verdict ถูกบันทึก typed ไม่ใช่เปิด task)"""
    need = _compat(refs=("AC65B",), types=("cable",))
    req = _req(rid="req-0", types=("cable",), codes=("AC65B",),
               target="iphone 15", cm="connector_required")
    card = _sel_card("i:1", "subject", "req-0",
                     "สายชาร์จ C to C 1m", model_codes=["AC65B"],
                     connector="usb-c")
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:1",)},))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert ctx.unanswered_needs == ()
    v = [x for x in ctx.compat_verdicts if x.need_index == 0]
    assert v and v[0].relation == "charges" \
        and v[0].decision.outcome == "compatible"


# ── M1 — declared proof validation (fail closed) ────────────────────────────

def test_proof_empty_source_rejected():
    """source="" → ไม่ใช่ trusted proof → no_evidence"""
    need, reqs, sel = _w01()
    pool = _pool(supporting=(_proof(source=""),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_proof_unknown_source_rejected():
    """source นอก contract (spec-db/web-structured/customer) →
    reject → no_evidence"""
    need, reqs, sel = _w01()
    pool = _pool(supporting=(_proof(source="rumor"),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_proof_invalid_verdict_rejected():
    """verdict นอก {compatible,incompatible} → reject → no_evidence"""
    need, reqs, sel = _w01()
    pool = _pool(supporting=(_proof(verdict="maybe"),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_proof_invalid_relation_rejected():
    """relation นอก COMPAT_RELATIONS → reject → no_evidence"""
    need, reqs, sel = _w01()
    pool = _pool(supporting=(_proof(relation="teleports"),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_customer_only_proof_admin_review():
    """customer-only evidence → resolver admin_review (unverified) —
    ไม่มีทางเป็น positive coverage → no_evidence"""
    need, reqs, sel = _w01()
    pool = _pool(supporting=(_proof(source="customer"),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


# ── H2 — decision → typed composition ───────────────────────────────────────

def _covered_w01():
    """covered W01→strava works_with — declared trusted proof."""
    need, reqs, sel = _w01(cm="bluetooth_general")
    pool = _pool(supporting=(_proof(),))
    return need, reqs, sel, pool


def test_covered_compat_produces_verdict_not_task():
    """covered compat need → CompatVerdict record (typed decision +
    identity) + ไม่มี NeedTask + products ยังอยู่ (subject card)"""
    need, reqs, sel, pool = _covered_w01()
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert ctx.unanswered_needs == ()
    assert ctx.task.tasks == (), (
        "compat verdict เป็น deterministic segment ไม่ใช่ model task")
    assert [p["name"] for p in ctx.products] == ["W01 watch"]
    v = [x for x in ctx.compat_verdicts]
    assert len(v) == 1
    assert v[0].need_index == 0 and v[0].relation == "works_with"
    assert v[0].decision.outcome == "compatible"
    assert v[0].target == "strava"


def test_compat_only_turn_zero_answer_calls(monkeypatch):
    """compat-only + authoritative decision → answer_typed ไม่ถูกเรียก;
    composition มี compat result เดียว render เป็น deterministic text"""
    from test_phase7_boundary_review import _import_app
    _app, _ = _import_app(monkeypatch)
    calls = []
    from shopeechat import llm
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **kw: calls.append(kw) or ("x", {}))
    need, reqs, sel, pool = _covered_w01()
    out = _app._typed_answer_boundary(
        {"selection": sel, "pool": pool, "requests": reqs},
        needs=(need,), profile=_profile(), web_configured=False)
    assert out.answer_calls == 0 and calls == []
    res = [r for r in out.results if r.domain == "compat"]
    assert len(res) == 1 and res[0].need_indices == (0,)
    text = _app._render_composition(out)
    assert "W01 watch" in text and "strava" in text \
        and "ใช้งานร่วมกับ" in text


def test_final_answer_contains_verdict_exactly_once(monkeypatch):
    """deterministic conclusion render ครั้งเดียวต่อ need — ไม่ซ้ำ"""
    from test_phase7_boundary_review import _import_app
    _app, _ = _import_app(monkeypatch)
    need, reqs, sel, pool = _covered_w01()
    ctx = _compile((need,), sel, pool, reqs, _profile())
    comp = acx.compose_answer(needs=(need,), context=ctx)
    text = _app._render_composition(comp)
    assert text.count("ใช้งานร่วมกับ") == 1
    assert " ได้ค่ะ" in text and "ไม่ได้" not in text


def test_mixed_product_compat_one_answer_call(monkeypatch):
    """product need + covered compat → model ≤1 ครั้ง (product เท่านั้น);
    compat segment มาจาก decision ไม่ใช่ model"""
    from test_phase7_boundary_review import _import_app
    _app, _ = _import_app(monkeypatch)
    calls = []
    from shopeechat import llm
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **kw: calls.append(kw) or ("prods", {}))
    need_p = TurnNeed(kind="product", operation="recommend",
                      product_types=frozenset({"earphone"}))
    need_c, reqs_c, _sel_c, pool = _covered_w01()
    req_p = _req(rid="req-p", types=("earphone",))
    card_p = _sel_card("i:9", "slot", "req-p", "Earphone A")
    sel = _selection((card_p, "req-p"),
                     (_sel_card("i:1", "subject", "req-0", "W01 watch",
                                model_codes=["W01"]), "req-0"))
    out = _app._typed_answer_boundary(
        {"selection": sel, "pool": pool,
         "requests": (req_p,) + reqs_c},
        needs=(need_p, need_c), profile=_profile(),
        web_configured=False)
    assert out.answer_calls == 1 and len(calls) == 1
    domains = [r.domain for r in out.results]
    assert "compat" in domains and "product" in domains


def test_incompatible_verdict_renders_negative_segment(monkeypatch):
    """verdict incompatible → deterministic ไม่ได้ segment (ไม่ใช่
    compatible/unknown)"""
    from test_phase7_boundary_review import _import_app
    _app, _ = _import_app(monkeypatch)
    need, reqs, sel = _w01()
    pool = _pool(supporting=(_proof(verdict="incompatible"),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    v = [x for x in ctx.compat_verdicts]
    assert v and v[0].decision.outcome == "incompatible"
    comp = acx.compose_answer(needs=(need,), context=ctx)
    text = _app._render_composition(comp)
    assert "ไม่ได้ค่ะ" in text


# ── round 3: canonical compat_mode→relation owner (policy_resolver) ─────

def test_canonical_owner_mode_truth_table():
    """compat_relation_for_mode = owner เดียวของ mode→relation —
    typed enum translation เท่านั้น ไม่ใช่ keyword match"""
    from shopeechat import policy_resolver as pr
    assert pr.compat_relation_for_mode("connector_required") == "charges"
    assert pr.compat_relation_for_mode("power_required") == "charges"
    assert pr.compat_relation_for_mode("charging") == "charges"
    assert pr.compat_relation_for_mode("model_fit") == "fits"
    assert pr.compat_relation_for_mode("self_compat") == "connects"
    assert pr.compat_relation_for_mode("bluetooth_general") == "works_with"


def test_canonical_owner_unknown_modes_fail_closed():
    """none/skip/empty/unknown/malformed → None — ห้าม broad else→charges"""
    from shopeechat import policy_resolver as pr
    for bad in ("none", "skip", "unknown", "", None, "wifi_general",
                "random words ใช้กับได้", 123):
        assert pr.compat_relation_for_mode(bad) is None, bad


def test_device_compat_unknown_mode_no_charges_fallback():
    """duplicate-owner drift: เดิม unknown mode → else→charges → drop
    incompatible products จริง — canonical owner แล้วต้องไม่กรอง
    (filter fail-safe = คืนของทั้งหมด)"""
    from shopeechat import device_compat
    prods = [{"item_id": 1, "name": "สายชาร์จ C to Lightning",
              "shop": "s", "item_status": "NORMAL"},
             {"item_id": 2, "name": "สายชาร์จ C to C ยาว 1 ม.",
              "shop": "s", "item_status": "NORMAL"}]
    out = device_compat._filter_compat_products(
        prods, "iphone 15", compat_mode="unknown")
    assert len(out) == 2   # เดิม: charges-filter → เหลือเฉพาะ C to C


def test_device_compat_none_mode_no_filtering():
    from shopeechat import device_compat
    prods = [{"item_id": 1, "name": "สายชาร์จ C to Lightning",
              "shop": "s", "item_status": "NORMAL"}]
    out = device_compat._filter_compat_products(
        list(prods), "iphone 15", compat_mode="none")
    assert len(out) == 1


def test_device_compat_known_modes_unchanged():
    """charging/self_compat semantics เดิมหลัง consolidate — owner
    เดียวกันให้ relation เดียวกัน"""
    from shopeechat import device_compat
    prods = [{"item_id": 1, "name": "สายชาร์จ C to Lightning",
              "shop": "s", "item_status": "NORMAL"},
             {"item_id": 2, "name": "สายชาร์จ C to Lightning ยาว 1 ม.",
              "shop": "s", "item_status": "NORMAL"}]
    # charging → charges: ทุกตัว proven incompatible → [] (regression pin)
    assert device_compat._filter_compat_products(
        list(prods), "iphone 15", compat_mode="charging") == []


def test_explicit_relation_type_works_without_mode():
    """relation_type carrier แข็งแรงสุด — compat_mode ไม่มีก็ใช้ได้"""
    need = _compat()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava", cm="none", rel_type="works_with")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    pool = _pool(supporting=(_proof(),))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    v = [x for x in ctx.compat_verdicts]
    assert v and v[0].relation == "works_with"


def test_explicit_relation_matching_mode_accepted():
    """relation_type + compat_mode map เดียวกัน → accepted (rel เดียว)"""
    need = _compat(refs=("i:7",), types=("charger",))
    req = _req(rid="req-0", types=("charger",), codes=(),
               target="iphone 15", cm="connector_required",
               rel_type="charges")
    card = _sel_card("i:7", "subject", "req-0", "สายชาร์จ C to C",
                     connector="usb-c")
    pool = _pool(supporting=(_proof(target="iphone 15", subject="i:7",
                                    relation="charges"),))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    v = [x for x in ctx.compat_verdicts]
    assert v and v[0].relation == "charges"


def test_explicit_relation_conflicting_mode_fails_closed():
    """relation_type=works_with + compat_mode=connector_required →
    rels {works_with,charges} → ambiguous → fail closed no_evidence"""
    need = _compat()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava", cm="connector_required",
               rel_type="works_with")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    pool = _pool(supporting=(_proof(),))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert not ctx.compat_verdicts
    assert _unans(ctx, 0) is not None


# ── audit H1 — device-spec producer shape (data = dict เดียวหรือไม่มี) ──────

def _w01_spec_card():
    return _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"], connector="bluetooth")


def test_spec_selector_matches_normalized_target():
    """producer เลือก dict ที่ device normalize ตรง target เดียวเท่านั้น"""
    specs = [{"device": "Xiaomi 17", "connector": "usb-c"},
             {"device": "IMILAB W01", "connector": "proprietary"}]
    got = acx.device_spec_for_target(specs, " imilab   w01 ")
    assert got == {"device": "IMILAB W01", "connector": "proprietary"}


def test_spec_selector_nonmatching_returns_none():
    """nonmatching / ว่าง / target ว่าง → None (producer ไม่ emit record)"""
    specs = [{"device": "Xiaomi 17", "connector": "usb-c"}]
    assert acx.device_spec_for_target(specs, "imilab w01") is None
    assert acx.device_spec_for_target([], "w01") is None
    assert acx.device_spec_for_target(None, "w01") is None
    assert acx.device_spec_for_target(specs, "") is None


def test_spec_selector_ignores_malformed_entries():
    """non-dict / dict ไม่มี device → ข้าม; first-match deterministic"""
    specs = [None, "w01", 42, {"no_device": 1},
             {"device": " W01 ", "connector": "bt"}]
    got = acx.device_spec_for_target(specs, "w01")
    assert got == {"device": " W01 ", "connector": "bt"}


def test_dict_spec_data_produces_exact_relation_verdict():
    """producer-fixed record (data=dict + structured source) →
    t_facts → derived verdict — connector ตรง = compatible (charges)"""
    need = _compat(refs=("AC65B",), types=("cable",))
    req = _req(types=("cable",), codes=("AC65B",), target="iphone 15",
               cm="connector_required")
    card = _sel_card("i:1", "subject", "req-0", "สายชาร์จ C to C",
                     model_codes=["AC65B"], connector="usb-c")
    specs = [{"device": "samsung s24", "connector": "usb-a"},
             {"device": "iphone 15", "connector": "usb-c"}]
    data = acx.device_spec_for_target(specs, "iphone 15")
    assert data is not None
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {**data, "source": data.get("source") or "web-structured"},
         "subject_refs": ("i:1",)},))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    v = [x for x in ctx.compat_verdicts]
    assert v and v[0].relation == "charges" \
        and v[0].decision.outcome == "compatible"


def test_list_shaped_spec_data_cannot_cover_verdict():
    """list-shaped data (OLD producer bug) → t_facts ว่าง →
    verdict ไม่เกิด (consumer ไม่เคย consume list — pin)"""
    need = _compat(refs=("AC65B",), types=("cable",))
    req = _req(types=("cable",), codes=("AC65B",), target="iphone 15",
               cm="connector_required")
    card = _sel_card("i:1", "subject", "req-0", "สายชาร์จ C to C",
                     model_codes=["AC65B"], connector="usb-c")
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": [{"device": "iphone 15", "connector": "usb-c",
                   "source": "web-structured"}],
         "subject_refs": ("i:1",)},))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert not ctx.compat_verdicts
    assert _unans(ctx, 0) is not None \
        and _unans(ctx, 0).reason == "no_evidence"


def test_unusable_spec_data_does_not_mark_coverage():
    """device_spec record ที่ไม่มี usable dict data → ห้าม mark
    spec_targets → admission ไม่ใช่ local_evidence_sufficient —
    producer emit nothing ⇒ pool นี้เทียบสถานะ nonmatching list"""
    need = _compat()
    req = _req(types=("smartwatch",), codes=("W01",), target="strava",
               cm="bluetooth_general")
    card = _w01_spec_card()
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "strava",
         "data": [{"device": "strava", "connector": "x"}],
         "subject_refs": ("i:1",)},))
    adm = acx.decide_web_admission(
        needs=(need,), selection=_selection((card, "req-0")), pool=pool,
        requests=(req,), profile=_profile(), web_configured=True)
    assert adm.reason != "local_evidence_sufficient", (
        "list-shaped/unusable spec data ต้องไม่ mark local coverage — "
        "producer emit nothing + consumer เชื่อเฉพาะ dict data")


# ── r5 B — multi-subject completeness ───────────────────────────────────────

def _w01_w02(target="strava", cm="bluetooth_general"):
    """compat need เดียว 2 subjects (W01,W02) + selected card ทั้งคู่"""
    need = _compat(refs=("W01", "W02"))
    req = _req(rid="req-0", types=("smartwatch",),
               codes=("W01", "W02"), target=target, cm=cm)
    c1 = _sel_card("i:1", "subject", "req-0", "W01 watch",
                   model_codes=["W01"])
    c2 = _sel_card("i:2", "subject", "req-0", "W02 watch",
                   model_codes=["W02"])
    return need, (req,), _selection((c1, "req-0"), (c2, "req-0"))


def test_two_subjects_produce_two_typed_verdicts():
    """W01 compatible + W02 incompatible → verdict ต่อ subject
    (ไม่หยุดที่ subject แรก) + deterministic subject order +
    segment หนึ่งต่อ subject"""
    need, reqs, sel = _w01_w02()
    pool = _pool(supporting=(
        _proof(subject="i:1", verdict="compatible", refs=("i:1", "i:2")),
        _proof(subject="i:2", verdict="incompatible",
               refs=("i:1", "i:2")),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    by_sub = {v.subject_id: v.decision.outcome
              for v in ctx.compat_verdicts}
    assert by_sub == {"i:1": "compatible", "i:2": "incompatible"}, (
        "ทุก subject ต้องมี verdict ของตัวเอง — evidence ของ subject "
        "หนึ่งห้าม cover อีก subject")
    assert [v.subject_id for v in ctx.compat_verdicts] == ["i:1", "i:2"], \
        "subject order ต้อง deterministic (collection order)"
    comp = acx.compose_answer(needs=(need,), context=ctx)
    segs = [r for r in comp.results if r.domain == "compat"]
    assert len(segs) == 2, "rendered segment หนึ่งต่อ subject"
    text = " ".join(r.text for r in segs)
    assert "W01 watch" in text and "W02 watch" in text


def test_resolved_plus_unresolved_preserves_both():
    """W01 decided + W02 ไม่มี evidence → verdict ของ W01 อยู่ +
    W02 เป็น explicit no_evidence ที่ subject_refs แค่ W02
    (ไม่หายเงียบ และ unanswered ของ W02 ไม่ถูก verdict กลืน)"""
    need, reqs, sel = _w01_w02()
    pool = _pool(supporting=(
        _proof(subject="i:1", verdict="compatible", refs=("i:1",)),))
    ctx = _compile((need,), sel, pool, reqs, _profile())
    assert [v.subject_id for v in ctx.compat_verdicts] == ["i:1"]
    u = _unans(ctx, 0)
    assert u is not None and u.reason == "no_evidence", (
        "unresolved subject ต้องเป็น typed unanswered — ห้ามหายเงียบ")
    assert "W02" in u.subject_refs and "W01" not in u.subject_refs, (
        "unanswered ต้องชี้เฉพาะ subject ที่ resolve ไม่ได้")
    # evidence ของ W01 ห้ามตัดสิน W02 — และ compose ต้องไม่กลืน
    # subject-scoped unanswered เมื่อ need มี verdict
    comp = acx.compose_answer(needs=(need,), context=ctx)
    assert any(u.need_index == 0 for u in comp.unanswered_needs), (
        "partially-decided need: unresolved subject ต้องรอดใน "
        "composition ด้วย")


def test_subject_order_reversal_keeps_ownership():
    """สลับลำดับ subject_refs/selection → subject→verdict mapping
    เหมือนเดิม (order ไม่เปลี่ยน ownership)"""
    need = _compat(refs=("W02", "W01"))
    req = _req(rid="req-0", types=("smartwatch",),
               codes=("W02", "W01"), target="strava",
               cm="bluetooth_general")
    c2 = _sel_card("i:2", "subject", "req-0", "W02 watch",
                   model_codes=["W02"])
    c1 = _sel_card("i:1", "subject", "req-0", "W01 watch",
                   model_codes=["W01"])
    pool = _pool(supporting=(
        _proof(subject="i:1", verdict="compatible", refs=("i:1", "i:2")),
        _proof(subject="i:2", verdict="incompatible",
               refs=("i:1", "i:2")),))
    ctx = _compile((need,), _selection((c2, "req-0"), (c1, "req-0")),
                   pool, (req,), _profile())
    by_sub = {v.subject_id: v.decision.outcome
              for v in ctx.compat_verdicts}
    assert by_sub == {"i:1": "compatible", "i:2": "incompatible"}


# ── r5 C — malformed typed fields fail closed ────────────────────────────────

def test_malformed_relation_type_fails_closed():
    """relation_type invalid non-empty + compat_mode valid → ห้ามให้
    compat_mode repair malformed explicit typed data → no verdict"""
    need = _compat()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava", cm="bluetooth_general",
               rel_type="charges_probably")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    pool = _pool(supporting=(_proof(relation="works_with"),))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert not ctx.compat_verdicts, (
        "malformed explicit relation_type → fail closed; compat_mode "
        "ห้าม repair/override")
    u = _unans(ctx, 0)
    assert u is not None and u.reason == "no_evidence"


def test_unknown_verdict_outcome_never_renders_claim():
    """CompatVerdict outcome นอก {compatible,incompatible} → ไม่มี
    compat assertion (ห้าม render hard negative จาก outcome ปลอม)
    และ need ไม่ถูก mark covered"""
    from shopeechat import policy_resolver as _pr
    need = _compat()
    v = acx.CompatVerdict(
        need_index=0, subject_id="i:1", subject_name="W01 watch",
        target="strava", relation="works_with",
        decision=_pr.CompatDecision(outcome="unknown", proofs=(),
                                    reason_codes=()))
    task = acx.AnswerTask(tasks=(), deferred=(), trace=())
    ctx = acx.AnswerContext(
        task=task, products=(), evidence=(), availability_notes=(),
        unanswered_needs=(acx.UnansweredNeed(
            0, "compat", "compat", ("W01",), ("smartwatch",),
            "strava", "no_evidence"),),
        estimated_tokens=0, trace=(), compat_verdicts=(v,))
    comp = acx.compose_answer(needs=(need,), context=ctx)
    compat_texts = [r.text for r in comp.results if r.domain == "compat"]
    assert not any("ไม่ได้" in t or "ได้ค่ะ" in t
                   for t in compat_texts), (
        "unknown/malformed outcome ต้องไม่กลายเป็น positive/negative "
        "compat claim")
    assert any(u.need_index == 0 for u in comp.unanswered_needs), (
        "verdict ที่ render ไม่ได้ → need ต้องไม่ถูก cover")
