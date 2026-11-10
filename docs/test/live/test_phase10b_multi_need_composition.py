"""Phase 10B — Multi-Need Answer Composition Correctness.

contract (one customer message, needs A+B+C):
- covered need ทุกตัวต้องมี explicit typed outcome — DomainResult หรือ
  UnansweredNeed — ห้าม mark covered แล้วหายเงียบ (need ที่ไม่มี emitted
  card attribute ถึง = ไม่มี evidence ใน context → cannot-confirm ไม่ใช่
  coverage ปลอมให้ model แต่ง)
- verdict/segment order ตาม TurnNeed order เสมอ — evidence/verdict
  collection order (decided dict vs product_verdicts list) ห้ามกำหนด
  ลำดับ segment
- need-local cannot-confirm: covered need อยู่รอบข้าง unanswered need;
  whole-answer fallback เฉพาะเมื่อไม่มี outcome เลย
- ทุก outcome อย่างละหนึ่งครั้ง — shared identity union เป็น card เดียว;
  same-subject fallback merge ตาม structural key เดิม
- terminal: LLM_ERROR_REPLY ชนะทั้งคำตอบ; compose/finalize/enforce
  idempotent byte-stable
"""
from __future__ import annotations

import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pymongo
import pytest

ROOT = Path(__file__).resolve().parents[3]
TEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from test_phase7_answer_context import (  # noqa: E402 — reuse typed builders
    _req, _sel_card, _selection, _pool, _profile, _compile,
)
from test_phase7_boundary_review import (  # noqa: E402 — reuse app harness
    _import_app,
)
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import guards  # noqa: E402
from shopeechat import llm  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402

TurnNeed = td.TurnNeed


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    """ห้าม network/Mongo ในชุดนี้ — posture เดียวกับ composition suite."""
    import urllib.request

    def _fail(what):
        def _g(*a, **k):
            pytest.fail(f"OFFLINE LEAK: {what}", pytrace=False)
        return _g
    monkeypatch.setattr(socket.socket, "connect", _fail("socket.connect"))
    monkeypatch.setattr(socket.socket, "connect_ex", _fail("connect_ex"))
    monkeypatch.setattr(socket, "create_connection", _fail("create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", _fail("getaddrinfo"))
    monkeypatch.setattr(urllib.request, "urlopen", _fail("urllib.urlopen"))
    monkeypatch.setattr(pymongo.MongoClient, "__init__",
                        _fail("MongoClient.__init__"))
    yield


def _app_mod():
    import sys as _s
    return _s.modules["shopeechat.app"]


def _render(comp):
    return _app_mod()._render_composition(comp)


def _finalize(comp, **kw):
    args = dict(message="m", limit=5, products=[], source="product_store",
                shop="S", model="m", elapsed=0.0, cost=0.0, intent={},
                timing={}, steps=[], routing_decision={}, image_desc="")
    args.update(kw)
    return _app_mod()._finalize_answer(comp, **args)


def _need_describe(refs=(), types=("earphone",)):
    return TurnNeed(kind="product", operation="describe",
                    subject_refs=tuple(refs),
                    product_types=frozenset(types))


def _need_compat(refs=(), types=("powerbank",)):
    return TurnNeed(kind="compat", operation="compat",
                    subject_refs=tuple(refs),
                    product_types=frozenset(types))


# ── F: verdict/segment order = TurnNeed order (ไม่ใช่ collection order) ──────

def _verdict_setup(sel_order="normal"):
    """need 0 (product/describe, request-carried target → product verdict)
    + need 1 (compat → decided verdict) — ทั้งคู่ decided compatible."""
    n0 = TurnNeed(kind="product", operation="describe",
                  subject_refs=("AC65B",),
                  product_types=frozenset({"cable"}))
    n1 = _need_compat(refs=("WPB100L",))
    req0 = _req(rid="req-0", types=("cable",), codes=("AC65B",),
                target="iphone 15", cm="connector_required")
    req1 = _req(rid="req-1", types=("powerbank",), codes=("WPB100L",),
                target="iphone 15", cm="connector_required")
    c0 = _sel_card("i:1", "subject", "req-0", "สายชาร์จ AC65B",
                   model_codes=["AC65B"],
                   canonical_specs={"connector": "usb-c"})
    c1 = _sel_card("i:2", "subject", "req-1", "WPB100L Powerbank",
                   model_codes=["WPB100L"],
                   canonical_specs={"connector": "usb-c"})
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:1",)},
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:2",)},
    ))
    entries = ((c0, "req-0"), (c1, "req-1")) if sel_order == "normal" \
        else ((c1, "req-1"), (c0, "req-0"))
    reqs = (req0, req1) if sel_order == "normal" else (req1, req0)
    return (n0, n1), _selection(*entries), pool, reqs


def test_verdicts_follow_need_order_not_collection_path(monkeypatch):
    """need 0 verdict (product-need) ต้องมาก่อน need 1 verdict (compat) —
    merge ของ decided+product_verdicts ต้อง sort ตาม need_index ไม่ใช่
    แยก collection ต่อท้ายกัน."""
    _import_app(monkeypatch)
    needs, sel, pool, reqs = _verdict_setup()
    ctx = _compile(needs, sel, pool, reqs, _profile())
    assert len(ctx.compat_verdicts) == 2, (
        f"setup: ทั้งสอง need ต้อง decided — got {ctx.compat_verdicts}")
    assert [v.need_index for v in ctx.compat_verdicts] == [0, 1], (
        "verdict order ต้องตาม TurnNeed order (0 ก่อน 1)")
    comp = acx.compose_answer(
        needs=needs, context=ctx, product_text="รายละเอียด AC65B ครบค่ะ",
        answer_calls=1)
    compat_idx = [r.need_indices[0] for r in comp.results
                  if r.domain == "compat"]
    assert compat_idx == [0, 1], (
        f"compat segment order ต้องตาม need order — got {compat_idx}")
    answer = _render(comp)
    v0 = "สายชาร์จ AC65B ใช้งานร่วมกับ iphone 15 ได้ค่ะ"
    v1 = "WPB100L Powerbank ใช้งานร่วมกับ iphone 15 ได้ค่ะ"
    assert v0 in answer and v1 in answer
    assert answer.index(v0) < answer.index(v1), (
        "need-0 verdict ต้อง render ก่อน need-1 verdict")


def test_verdict_order_stable_under_evidence_arrival_swap():
    """selection/request arrival order ห้ามเปลี่ยน verdict order — need
    order เดียวเป็น authority."""
    needs, sel, pool, reqs = _verdict_setup(sel_order="swapped")
    ctx = _compile(needs, sel, pool, reqs, _profile())
    assert [v.need_index for v in ctx.compat_verdicts] == [0, 1]


# ── A/D: covered need อยู่รอด + uncovered need = cannot-confirm per-need ─────

def test_zero_emitted_coverage_need_is_unanswered_not_silent(monkeypatch):
    """need 1 (subject=HID-1) มี selected card แต่ทุกใบ hidden → ไม่มี
    emitted card attribute ถึง → ต้องเป็น typed unanswered
    (cannot-confirm) ไม่ใช่ covered-ปลอม — need 0 ยังตอบปกติ."""
    _import_app(monkeypatch)
    n0 = _need_describe(refs=("VIS-1",), types=("earphone",))
    n1 = _need_describe(refs=("HID-1",), types=("cable",))
    req0 = _req(rid="req-0", types=("earphone",))
    req1 = _req(rid="req-1", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["VIS-1"]), "req-0"),
        (_sel_card("i:9", "subject", "req-1", "Hidden Cable",
                   model_codes=["HID-1"],
                   customer_visibility="hidden"), "req-1"))
    ctx = _compile((n0, n1), sel, _pool(), (req0, req1), _profile())
    unans = {u.need_index: u for u in ctx.unanswered_needs}
    assert 1 in unans, (
        "need ที่ไม่มี emitted card ต้องเป็น unanswered — ห้าม silent "
        "covered (marker บอกตอบแล้วแต่ context ไม่มีข้อมูลของมัน)")
    assert unans[1].reason == "no_selection"
    assert [t.need_index for t in ctx.task.tasks] == [0], (
        "task ที่ไม่มี evidence ใน context ต้องถูกตัด — ห้ามให้ model "
        "แต่งคำตอบโดยไม่มี card")
    comp = acx.compose_answer(
        needs=(n0, n1), context=ctx,
        product_text="Earphone X เป็นรุ่นไร้สายค่ะ", answer_calls=1)
    prod = [r for r in comp.results if r.domain == "product"
            and r.origin == "model"]
    assert prod and prod[0].need_indices == (0,)
    assert [u.need_index for u in comp.unanswered_needs] == [1]
    answer = _render(comp)
    assert "Earphone X เป็นรุ่นไร้สายค่ะ" in answer
    assert "HID-1" in answer and "ไม่พบข้อมูลในระบบของร้าน" in answer


def test_multi_fact_shared_card_covered_once_unanswered_named(monkeypatch):
    """A(ราคา)+B(สต็อก) share card เดียว → covered ครั้งเดียวผ่าน union;
    C(describe ไม่มี card) = cannot-confirm เฉพาะตัว — ไม่ใช่ generic
    whole-answer fallback."""
    _import_app(monkeypatch)
    n0 = TurnNeed(kind="product", operation="price",
                  product_types=frozenset({"earphone"}))
    n1 = TurnNeed(kind="product", operation="stock",
                  product_types=frozenset({"earphone"}))
    n2 = _need_describe(refs=("CB-9",), types=("cable",))
    req0 = _req(rid="req-0", types=("earphone",))
    req2 = _req(rid="req-2", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["EP-1"]), "req-0"),)
    ctx = _compile((n0, n1, n2), sel, _pool(), (req0, req2), _profile())
    comp = acx.compose_answer(
        needs=(n0, n1, n2), context=ctx,
        product_text="Earphone X ราคา 300 บาท มีสต็อกพร้อมส่งค่ะ",
        answer_calls=1)
    prod = [r for r in comp.results
            if r.domain == "product" and r.origin == "model"]
    assert len(prod) == 1 and prod[0].need_indices == (0, 1), (
        "A+B covered ครั้งเดียวผ่าน product result เดียว")
    assert [u.need_index for u in comp.unanswered_needs] == [2]
    assert comp.unanswered_needs[0].reason == "no_selection"
    answer = _render(comp)
    assert answer.count("Earphone X ราคา 300 บาท") == 1
    assert "CB-9" in answer and "ไม่พบข้อมูลในระบบของร้าน" in answer
    assert answer != acx.EMPTY_CONTEXT_REPLY, (
        "need-local outcome — ห้าม whole-answer generic fallback")


def test_same_subject_unanswered_needs_render_single_fallback(monkeypatch):
    """หลาย need ต่อ subject เดียวกันที่ไม่มี evidence → structural merge
    เป็น cannot-confirm segment เดียว (key = reason+subject_refs —
    ไม่ใช่ prose dedupe)."""
    _import_app(monkeypatch)
    n0 = _need_describe(refs=("ZZZ-9",), types=("earphone",))
    n1 = _need_describe(refs=("ZZZ-9",), types=("cable",))
    comp = acx.compose_answer(
        needs=(n0, n1),
        context=_compile((n0, n1), _selection(), _pool(),
                         (_req(rid="req-0", types=("earphone",)),
                          _req(rid="req-1", types=("cable",))),
                         _profile()))
    answer = _render(comp)
    assert answer.count("ไม่พบข้อมูลในระบบของร้าน") == 1, (
        "same-subject fallback ต้องเหลือประโยคเดียว")
    assert "ZZZ-9" in answer


# ── E: ทุก need ไม่มี evidence → deterministic + zero answer-model call ───────

def test_all_needs_uncovered_zero_answer_calls_no_fabrication(monkeypatch):
    """เทิร์นที่ไม่มี coverage เลย → 0 answer-model call, results ว่าง,
    cannot-confirm ต่อ need ด้วย typed fields — ไม่มีสินค้าปลอม."""
    _import_app(monkeypatch)
    app = _app_mod()
    typed_calls = []
    monkeypatch.setattr(
        llm, "answer_typed",
        lambda **kw: typed_calls.append(kw) or ("x", {}))
    n0 = _need_describe(refs=("VIS-9",), types=("earphone",))
    n1 = _need_describe(refs=("CB-9",), types=("cable",))
    reqs = (_req(rid="req-0", types=("earphone",)),
            _req(rid="req-1", types=("cable",)))
    gs = {"selection": _selection(), "pool": _pool(),
          "requests": reqs, "summary": {}}
    comp = app._typed_answer_boundary(
        gs, needs=(n0, n1), profile=_profile(), web_configured=False)
    assert typed_calls == [] and comp.answer_calls == 0
    assert comp.results == ()
    assert [u.need_index for u in comp.unanswered_needs] == [0, 1]
    assert not comp.products, "ต้องไม่มีสินค้าปลอมแนบ"
    answer = app._render_composition(comp)
    assert "VIS-9" in answer and "CB-9" in answer
    assert "ไม่พบข้อมูลในระบบของร้าน" in answer


def test_greeting_plan_has_no_productish_needs_no_composition():
    """greeting-only → decide_turn ไม่สร้าง productish need → boundary
    ไม่ produce product result/model call (ไม่บังคับเข้า product
    composition)."""
    plan = td.decide_turn("สวัสดีค่ะ", history=[], intent_result={})
    assert not any(n.kind in acx.PRODUCTISH_NEED_KINDS
                   for n in plan.needs)
    comp = acx.compose_answer(needs=plan.needs)
    assert comp.results == () and comp.answer_calls == 0


# ── D/F: shared identity → card เดียว (union attribution) ────────────────────

def test_shared_identity_single_card_single_segment(monkeypatch):
    """identity เดียวข้าม 2 needs → emitted card เดียว + card segment
    เดียว (union need_indices — ไม่ใช่ card ซ้ำ)."""
    _import_app(monkeypatch)
    n0 = _need_describe(refs=("EP-1",), types=("earphone",))
    n1 = TurnNeed(kind="product", operation="stock",
                  product_types=frozenset({"earphone"}))
    req0 = _req(rid="req-0", types=("earphone",))
    card = _sel_card("i:1", "subject", "req-0", "Shared X",
                     model_codes=["EP-1"],
                     image_url="https://img.example/x.jpg",
                     short_link="https://s.example/x")
    ctx = _compile((n0, n1), _selection((card, "req-0")), _pool(),
                   (req0,), _profile())
    assert [p.get("item_id") for p in ctx.products].count("1") == 1
    comp = acx.compose_answer(
        needs=(n0, n1), context=ctx,
        product_text="Shared X พร้อมส่งค่ะ", answer_calls=1)
    card_results = [r for r in comp.results
                    if r.domain == "product" and r.origin == "deterministic"]
    assert len(card_results) == 1, (
        f"shared identity ต้องเป็น card segment เดียว — got "
        f"{len(card_results)}")
    answer = _render(comp)
    assert answer.count("**Shared X**") == 1
    assert answer.count("สั่งซื้อ Shared X") == 1


# ── G/H: idempotency + terminal ──────────────────────────────────────────────

_PDEC_RD = {"policy_decision": {"policy_type": "return_exchange",
                                "outcome": "ineligible",
                                "matched_rule_ids": ("r1",),
                                "required_evidence": (),
                                "reason_codes": (), "source_versions": ()}}


def _resp(answer, rd):
    return SimpleNamespace(
        answer=answer, answer_segments=answer.split("\n\n"),
        products=[], handoff_to_admin=False, source="product_store",
        routing_decision=dict(rd))


def _multi_comp():
    return acx.AnswerComposition(
        results=(
            acx.DomainResult("product", (0,), text="Earphone X 300 บาทค่ะ"),
            acx.DomainResult("policy", (1,), outcome="ineligible"),
        ),
        unanswered_needs=(
            acx.UnansweredNeed(2, "product", "describe", ("CB-9",),
                               (), None, "no_selection"),))


def test_finalize_enforce_idempotent_byte_stable(monkeypatch):
    _import_app(monkeypatch)
    comp = _multi_comp()
    r1 = _finalize(comp)
    r2 = _finalize(comp)
    for f in ("answer", "answer_segments", "routing_decision"):
        assert getattr(r1, f) == getattr(r2, f), f
    resp = _resp(r1.answer, {**_PDEC_RD,
                             "composition": dict(
                                 r1.routing_decision["composition"])})
    once = guards.enforce(resp, SimpleNamespace(message="m", history=[]))
    twice = guards.enforce(once, SimpleNamespace(message="m", history=[]))
    assert twice.answer == once.answer == r1.answer, (
        "valid marker → enforce คืน byte-identical ทั้งสองรอบ")
    assert r1.answer.count("ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืน") == 1


def test_llm_error_sentinel_still_terminal_multi_need(monkeypatch):
    """provider error → sentinel เดี่ยว (ไม่ถูกกลืนด้วย segment อื่น) —
    terminal behavior เดิมต้องไม่เปลี่ยน."""
    _import_app(monkeypatch)
    app = _app_mod()
    n0 = _need_describe(refs=("EP-1",), types=("earphone",))
    req0 = _req(rid="req-0", types=("earphone",))
    sel = _selection(
        (_sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["EP-1"]), "req-0"),)
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **kw: (llm.LLM_ERROR_REPLY, {}))
    comp = app._typed_answer_boundary(
        {"selection": sel, "pool": _pool(), "requests": (req0,)},
        needs=(n0,), profile=_profile(), web_configured=False)
    resp = _finalize(comp)
    assert resp.answer == llm.LLM_ERROR_REPLY


# ── J: final customer-visible order = TurnNeed order ข้าม domain ──────────
# structural order = comp.results เรียงตาม earliest original need_index;
# `_DOMAIN_ORDER` เป็น tie-break เฉพาะ results หลาย domain ของ need เดียว;
# result ที่ไม่มี need_indices อยู่หลัง indexed results เสมอ (anchor =
# len(needs) — structural ไม่ใช่ sentinel)

_V_SEG = "WPB100L Powerbank ใช้งานร่วมกับ iphone 15 ได้ค่ะ"
_P_SEG = "Earphone X เป็นรุ่นไร้สายค่ะ"


def _dom_idx(comp):
    return [(r.domain, r.need_indices) for r in comp.results]


def _order_fixtures():
    """need0 product/describe + card | need1 compat decided-compatible —
    คืน (needs, selection, pool, requests) สำหรับ ordering probes."""
    n0 = _need_describe(refs=("EAR-1",))
    n1 = _need_compat(refs=("WPB100L",))
    req0 = _req(rid="req-0", types=("earphone",), codes=("EAR-1",))
    req1 = _req(rid="req-1", types=("powerbank",), codes=("WPB100L",),
                target="iphone 15", cm="connector_required")
    c0 = _sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["EAR-1"],
                   image_url="https://img.example/e.jpg",
                   short_link="https://s.example/e")
    c1 = _sel_card("i:2", "subject", "req-1", "WPB100L Powerbank",
                   model_codes=["WPB100L"],
                   canonical_specs={"connector": "usb-c"})
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:2",)},
    ))
    return (n0, n1), _selection((c0, "req-0"), (c1, "req-1")), \
        pool, (req0, req1)


def test_need_order_product_then_compat_cross_domain(monkeypatch):
    """ลูกค้าถาม product(0) ก่อน compat(1) → segment ของ need0 ต้องมา
    ก่อน need1 แม้ domain rank ของ compat ต่ำกว่า (strict need order)."""
    _import_app(monkeypatch)
    needs, sel, pool, reqs = _order_fixtures()
    ctx = _compile(needs, sel, pool, reqs, _profile())
    comp = acx.compose_answer(
        needs=needs, context=ctx, product_text=_P_SEG, answer_calls=1)
    assert _dom_idx(comp) == [
        ("product", (0,)), ("product", (0,)), ("compat", (1,))], (
        f"results ต้องเรียง need-major — got {_dom_idx(comp)}")
    answer = _render(comp)
    assert answer.index(_P_SEG) < answer.index(_V_SEG), (
        "คำตอบ need0 ต้องแสดงก่อนคำตอบ need1")


def test_need_order_compat_then_product_cross_domain(monkeypatch):
    """ลูกค้าถาม compat(0) ก่อน product(1) → verdict ก่อน segment
    product (need order ตรง domain rank — preserved behavior)."""
    _import_app(monkeypatch)
    needs, sel, pool, reqs = _order_fixtures()
    needs = (needs[1], needs[0])
    n0c, n1p = needs
    c1 = _sel_card("i:2", "subject", "req-1", "WPB100L Powerbank",
                   model_codes=["WPB100L"],
                   canonical_specs={"connector": "usb-c"})
    c0 = _sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["EAR-1"],
                   image_url="https://img.example/e.jpg",
                   short_link="https://s.example/e")
    sel = _selection((c1, "req-1"), (c0, "req-0"))
    ctx = _compile(needs, sel, pool, reqs, _profile())
    comp = acx.compose_answer(
        needs=needs, context=ctx, product_text=_P_SEG, answer_calls=1)
    assert _dom_idx(comp) == [
        ("compat", (0,)), ("product", (1,)), ("product", (1,))], (
        f"results ต้องเรียง need-major — got {_dom_idx(comp)}")
    answer = _render(comp)
    assert answer.index(_V_SEG) < answer.index(_P_SEG)


def test_need_order_product_policy_compat_three_domains(monkeypatch):
    """product(0)+policy(1)+compat(2) → ลำดับ [0,1,2] ไม่ใช่
    domain-major (compat ก่อน policy ก่อน product)."""
    _import_app(monkeypatch)
    n0 = _need_describe(refs=("EAR-1",))
    n1p = TurnNeed(kind="policy", operation="unknown")
    n2c = _need_compat(refs=("WPB100L",))
    req0 = _req(rid="req-0", types=("earphone",), codes=("EAR-1",))
    req2 = _req(rid="req-2", types=("powerbank",), codes=("WPB100L",),
                target="iphone 15", cm="connector_required")
    c0 = _sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["EAR-1"],
                   image_url="https://img.example/e.jpg",
                   short_link="https://s.example/e")
    c2 = _sel_card("i:2", "subject", "req-2", "WPB100L Powerbank",
                   model_codes=["WPB100L"],
                   canonical_specs={"connector": "usb-c"})
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:2",)},
    ))
    needs = (n0, n1p, n2c)
    ctx = _compile(needs, _selection((c0, "req-0"), (c2, "req-2")),
                   pool, (req0, req2), _profile())
    comp = acx.compose_answer(
        needs=needs, context=ctx, product_text=_P_SEG, answer_calls=1,
        policy_decision=SimpleNamespace(outcome="ineligible"))
    assert _dom_idx(comp) == [
        ("product", (0,)), ("product", (0,)),
        ("policy", (1,)), ("compat", (2,))], (
        f"results ต้องเรียง [0,1,2] — got {_dom_idx(comp)}")
    answer = _render(comp)
    assert (answer.index(_P_SEG)
            < answer.index("ยังไม่เข้าเงื่อนไข")
            < answer.index(_V_SEG)), (
        "customer-visible order ต้องตาม TurnNeed order [0,1,2]")


def test_need_order_stable_under_evidence_arrival_swap(monkeypatch):
    """สลับ selection/request arrival order → final answer byte-identical
    (need order เป็น authority เดียว ไม่ใช่ collection order)."""
    _import_app(monkeypatch)
    needs, sel, pool, reqs = _order_fixtures()
    ctx_a = _compile(needs, sel, pool, reqs, _profile())
    ans_a = _render(acx.compose_answer(
        needs=needs, context=ctx_a, product_text=_P_SEG, answer_calls=1))
    c0 = _sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["EAR-1"],
                   image_url="https://img.example/e.jpg",
                   short_link="https://s.example/e")
    c1 = _sel_card("i:2", "subject", "req-1", "WPB100L Powerbank",
                   model_codes=["WPB100L"],
                   canonical_specs={"connector": "usb-c"})
    sel_b = _selection((c1, "req-1"), (c0, "req-0"))
    reqs_b = (reqs[1], reqs[0])
    ctx_b = _compile(needs, sel_b, pool, reqs_b, _profile())
    ans_b = _render(acx.compose_answer(
        needs=needs, context=ctx_b, product_text=_P_SEG, answer_calls=1))
    assert ans_a == ans_b


def test_same_need_multi_domain_uses_domain_tiebreak(monkeypatch):
    """need0 compat decided + card ของ need0 เอง → ภายใน need เดียว
    `_DOMAIN_ORDER` เป็น tie-break: compat(1) ก่อน product(3); card
    ของ need0 ต้องอยู่ใน slot ของ need0 ไม่ไหลไปท้ายสุดตาม domain."""
    _import_app(monkeypatch)
    n0 = _need_compat(refs=("WPB100L",))
    n1 = _need_describe(refs=("EAR-1",))
    req0 = _req(rid="req-0", types=("powerbank",), codes=("WPB100L",),
                target="iphone 15", cm="connector_required")
    req1 = _req(rid="req-1", types=("earphone",), codes=("EAR-1",))
    c0 = _sel_card("i:2", "subject", "req-0", "WPB100L Powerbank",
                   model_codes=["WPB100L"],
                   canonical_specs={"connector": "usb-c"},
                   image_url="https://img.example/w.jpg",
                   short_link="https://s.example/w")
    c1 = _sel_card("i:1", "subject", "req-1", "Earphone X",
                   model_codes=["EAR-1"],
                   image_url="https://img.example/e.jpg",
                   short_link="https://s.example/e")
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:2",)},
    ))
    needs = (n0, n1)
    ctx = _compile(needs, _selection((c0, "req-0"), (c1, "req-1")),
                   pool, (req0, req1), _profile())
    comp = acx.compose_answer(
        needs=needs, context=ctx, product_text=_P_SEG, answer_calls=1)
    assert _dom_idx(comp) == [
        ("compat", (0,)), ("product", (0,)),
        ("product", (1,)), ("product", (1,))], (
        f"need-major + intra-need domain tie-break — got {_dom_idx(comp)}")
    answer = _render(comp)
    assert (answer.index(_V_SEG)
            < answer.index("**WPB100L Powerbank**")
            < answer.index(_P_SEG)
            < answer.index("**Earphone X**")), (
        "verdict→card ของ need0 ก่อน prose→card ของ need1")


def test_no_index_result_places_after_indexed_needs(monkeypatch):
    """product prose ที่ไม่ cover need ใด (need_indices=()) ต้องอยู่
    หลัง indexed results — deterministic placement ไม่ใช่ magic rank."""
    _import_app(monkeypatch)
    n0 = TurnNeed(kind="policy", operation="unknown")
    n1 = _need_describe(refs=("CB-9",), types=("cable",))
    needs = (n0, n1)
    ctx = _compile(needs, _selection(), _pool(),
                   (_req(rid="req-1", types=("cable",)),), _profile())
    comp = acx.compose_answer(
        needs=needs, context=ctx,
        product_text="แนะนำสินค้าทั่วไปค่ะ", answer_calls=1,
        policy_decision=SimpleNamespace(outcome="ineligible"))
    assert _dom_idx(comp) == [("policy", (0,)), ("product", ())], (
        f"no-index result ต้องอยู่หลัง indexed — got {_dom_idx(comp)}")
    answer = _render(comp)
    assert (answer.index("ยังไม่เข้าเงื่อนไข")
            < answer.index("แนะนำสินค้าทั่วไปค่ะ"))


def test_multi_index_result_anchors_at_earliest_need(monkeypatch):
    """DomainResult เดียว cover (0,2) non-contiguous → anchor ที่
    earliest need index (contract: strict interleave ไม่ได้โดยไม่ split
    — earliest = deterministic placement ของ shared segment)."""
    _import_app(monkeypatch)
    n0 = TurnNeed(kind="product", operation="price",
                  product_types=frozenset({"earphone"}))
    n1 = _need_compat(refs=("WPB100L",))
    n2 = TurnNeed(kind="product", operation="stock",
                  product_types=frozenset({"earphone"}))
    req0 = _req(rid="req-0", types=("earphone",))
    req1 = _req(rid="req-1", types=("powerbank",), codes=("WPB100L",),
                target="iphone 15", cm="connector_required")
    c0 = _sel_card("i:1", "subject", "req-0", "Shared X",
                   model_codes=["EP-1"],
                   image_url="https://img.example/x.jpg",
                   short_link="https://s.example/x")
    c1 = _sel_card("i:2", "subject", "req-1", "WPB100L Powerbank",
                   model_codes=["WPB100L"],
                   canonical_specs={"connector": "usb-c"})
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:2",)},
    ))
    needs = (n0, n1, n2)
    ctx = _compile(needs, _selection((c0, "req-0"), (c1, "req-1")),
                   pool, (req0, req1), _profile())
    card_idx = [p.get("need_indices") for p in ctx.products]
    assert (0, 2) in card_idx, (
        f"setup: shared card ต้อง union (0,2) — got {card_idx}")
    comp = acx.compose_answer(
        needs=needs, context=ctx,
        product_text="Shared X ราคา 300 บาท มีสต็อกค่ะ", answer_calls=1)
    di = _dom_idx(comp)
    assert di == [
        ("product", (0, 2)), ("product", (0, 2)), ("compat", (1,))], (
        f"multi-index anchor earliest — got {di}")
    answer = _render(comp)
    assert (answer.index("Shared X ราคา 300 บาท มีสต็อกค่ะ")
            < answer.index("**Shared X**")
            < answer.index(_V_SEG)), (
        "shared (0,2) segments ต้องอยู่ก่อน compat(1)")


# ── K: not-cands branch — task ที่ไม่มี serialized evidence ต้องถูกตัด ─────

def test_filtered_candidates_need_drops_task_and_evidence(monkeypatch):
    """candidates ของ need ถูก taint/filter จนหมด (not cands) → typed
    unanswered(no_evidence) + NeedTask ต้องถูกตัดผ่าน dropped pipeline
    เดิม — ห้ามเหลือ task ที่ไม่มี evidence ให้ model แต่ง; covered
    need ข้างเคียงต้องคงอยู่."""
    _import_app(monkeypatch)
    n0 = TurnNeed(kind="compat", operation="compat",
                  product_types=frozenset({"powerbank"}))
    n1 = _need_describe(refs=(), types=("powerbank",))
    n2 = _need_describe(refs=("VIS-1",), types=("earphone",))
    req0 = _req(rid="req-0", types=("powerbank",), codes=("WPB-X",),
                target="iphone 15", cm="connector_required")
    req1 = _req(rid="req-1", types=("powerbank",), codes=("WPB-X",))
    req2 = _req(rid="req-2", types=("earphone",))
    sel = _selection(
        (_sel_card("i:5", "subject", "req-0", "WPB-X Powerbank",
                   model_codes=["WPB-X"]), "req-0"),
        (_sel_card("i:5", "subject", "req-1", "WPB-X Powerbank",
                   model_codes=["WPB-X"]), "req-1"),
        (_sel_card("i:1", "subject", "req-2", "Earphone X",
                   model_codes=["VIS-1"]), "req-2"))
    ctx = _compile((n0, n1, n2), sel, _pool(),
                   (req0, req1, req2), _profile())
    unans = {u.need_index: u for u in ctx.unanswered_needs}
    assert 0 in unans and unans[0].reason == "no_evidence"
    assert 1 in unans and unans[1].reason == "no_evidence", (
        f"need1 not-cands(tainted) → no_evidence — got {unans}")
    assert [t.need_index for t in ctx.task.tasks] == [2], (
        "task ของ need ที่ไม่มี serialized evidence ต้องถูกตัด — "
        f"got {[t.need_index for t in ctx.task.tasks]}")
    assert not any(
        set(e.get("need_indices") or ()) & {0, 1}
        for e in ctx.evidence), (
        "evidence ของ dropped needs ต้องไม่ serialize index ค้าง")
    assert [p.get("item_id") for p in ctx.products] == ["1"], (
        "card ของ covered need(2) ต้องคงอยู่")


def test_all_tainted_needs_zero_answer_calls(monkeypatch):
    """ทุก need ถูก taint จน not cands → tasks ว่าง → 0 model calls
    (deterministic terminal เหมือน empty selection)."""
    _import_app(monkeypatch)
    app = _app_mod()
    typed_calls = []
    monkeypatch.setattr(
        llm, "answer_typed",
        lambda **kw: typed_calls.append(kw) or ("x", {}))
    n0 = TurnNeed(kind="compat", operation="compat",
                  product_types=frozenset({"powerbank"}))
    n1 = _need_describe(refs=(), types=("powerbank",))
    req0 = _req(rid="req-0", types=("powerbank",), codes=("WPB-X",),
                target="iphone 15", cm="connector_required")
    req1 = _req(rid="req-1", types=("powerbank",), codes=("WPB-X",))
    sel = _selection(
        (_sel_card("i:5", "subject", "req-0", "WPB-X Powerbank",
                   model_codes=["WPB-X"]), "req-0"),
        (_sel_card("i:5", "subject", "req-1", "WPB-X Powerbank",
                   model_codes=["WPB-X"]), "req-1"))
    comp = app._typed_answer_boundary(
        {"selection": sel, "pool": _pool(), "requests": (req0, req1)},
        needs=(n0, n1), profile=_profile(), web_configured=False)
    assert typed_calls == [] and comp.answer_calls == 0, (
        "task ไม่มี evidence → ห้ามเรียก model")
    assert [u.need_index for u in comp.unanswered_needs] == [0, 1]


# ── L: one outcome per need — evidence-authority invariant (M-1/M-2) ──────
# invariant ต่อ need_index เดียว:
#   [task ∧ serialized evidence ∧ ¬unans] ⊕ [¬task ∧ unans ×1] ⊕
#   [typed deterministic verdict/terminal]
# ห้าม task∧unans ซ้อน, ห้าม task เปล่าไร้ evidence, ห้าม evidence ของ
# need อื่นทำให้ task รอด (shared ต้อง typed need_indices จริง)

def test_evidence_backed_not_cands_single_model_outcome(monkeypatch):
    """(M-1) need0: zero candidates แต่มี serialized evidence attribute
    ถึง need จริง → task คงอยู่ (model ตอบจาก evidence) + ไม่มี
    UnansweredNeed(0) — final bytes = model outcome เดียว ห้ามซ้อน
    cannot-confirm ขัดกัน; need1: ไม่มี evidence → task ถูกตัด +
    cannot-confirm ครั้งเดียว."""
    _import_app(monkeypatch)
    app = _app_mod()
    n0 = _need_describe(refs=("WPB-X",), types=("powerbank",))
    n1 = _need_describe(refs=("CB-9",), types=("cable",))
    reqs = (_req(rid="req-0", types=("powerbank",), codes=("WPB-X",)),
            _req(rid="req-1", types=("cable",)))
    pool = _pool(supporting=(
        {"kind": "device_spec", "need_index": 0, "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"}},))
    typed_calls = []
    monkeypatch.setattr(
        llm, "answer_typed",
        lambda **kw: typed_calls.append(kw) or (
            "WPB-X รุ่นนี้สเปค connector usb-c ค่ะ รองรับ iphone 15", {}))
    comp = app._typed_answer_boundary(
        {"selection": _selection(), "pool": pool, "requests": reqs},
        needs=(n0, n1), profile=_profile(), web_configured=False)
    assert len(typed_calls) == 1 and comp.answer_calls == 1
    ctx = comp.context
    assert [t.need_index for t in ctx.task.tasks] == [0]
    assert [u.need_index for u in ctx.unanswered_needs] == [1], (
        "evidence-backed need ห้ามมี UnansweredNeed ซ้อน task")
    assert [u.need_index for u in comp.unanswered_needs] == [1]
    answer = app._render_composition(comp)
    assert "WPB-X รุ่นนี้สเปค connector usb-c" in answer
    assert answer.count("ไม่พบข้อมูลในระบบของร้าน") == 1, (
        "cannot-confirm เฉพาะ need1 เท่านั้น — need0 outcome เดียว")
    assert answer.count("WPB-X") == 1 and "CB-9" in answer


def test_other_need_evidence_does_not_rescue_task(monkeypatch):
    """(M-1 control) evidence attribute เฉพาะ need1 → need0 (not cands,
    ไม่มี evidence) ต้องถูกตัด — typed need_indices เท่านั้นที่นับ;
    need1 (evidence-backed, not cands) คง task ตาม contract เดียวกัน."""
    n0 = _need_describe(refs=("WPB-X",), types=("powerbank",))
    n1 = _need_describe(refs=("CB-9",), types=("cable",))
    reqs = (_req(rid="req-0", types=("powerbank",), codes=("WPB-X",)),
            _req(rid="req-1", types=("cable",)))
    pool = _pool(supporting=(
        {"kind": "device_spec", "need_index": 1,
         "data": {"awg": 24, "source": "spec-db"}},))
    ctx = _compile((n0, n1), _selection(), pool, reqs, _profile())
    assert [t.need_index for t in ctx.task.tasks] == [1]
    assert [u.need_index for u in ctx.unanswered_needs] == [0]
    assert ctx.products == ()
    assert [tuple(e.get("need_indices") or ())
            for e in ctx.evidence] == [(1,)]


def test_tainted_shared_request_independent_evidence_keeps_task(monkeypatch):
    """(M-2 case A) describe need แชร์ tainted request กับ uncovered
    compat → card ถูกตัดตาม taint (relation context ของ claim ที่พิสูจน์
    ไม่ได้); แต่ need มี serialized evidence อิสระ (typed need_index) →
    task คงอยู่ + evidence คงอยู่ + ไม่ unanswered — taint ตัด card
    ไม่ตัด evidence authority ของ need."""
    n0 = _need_compat(refs=("W01",), types=("smartwatch",))
    n1 = _need_describe(refs=("W01",), types=("smartwatch",))
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    pool = _pool(supporting=(
        {"kind": "device_spec", "need_index": 1,
         "data": {"weight_g": 42, "source": "spec-db"}},))
    ctx = _compile((n0, n1), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert [t.need_index for t in ctx.task.tasks] == [1]
    assert ctx.products == ()
    u0 = next((u for u in ctx.unanswered_needs if u.need_index == 0),
              None)
    assert u0 is not None and u0.reason == "no_evidence"
    assert next((u for u in ctx.unanswered_needs
                 if u.need_index == 1), None) is None, (
        "describe need ที่มี evidence อิสระห้าม unanswered")
    assert [tuple(e.get("need_indices") or ())
            for e in ctx.evidence] == [(1,)]


def test_no_emit_evidence_backed_keeps_task(monkeypatch):
    """(M-1 no_emit path) candidates ผ่าน gate แต่ติด cap → took=0 ไม่มี
    union; serialized evidence attribute ถึง need → task คงอยู่ outcome
    เดียว (contract เดียวกับ not-cands evidence-backed) — hidden/capped
    card ไม่กลายเป็น cannot-confirm ซ้อน."""
    n0 = _need_describe(refs=("EP-1",), types=("earphone",))
    req0 = _req(rid="req-0", types=("earphone",), codes=("EP-1",))
    card = _sel_card("i:1", "subject", "req-0", "Earphone X",
                     model_codes=["EP-1"])
    pool = _pool(supporting=(
        {"kind": "device_spec", "need_index": 0,
         "data": {"driver_mm": 10, "source": "spec-db"}},))
    ctx = _compile((n0,), _selection((card, "req-0")), pool, (req0,),
                   _profile(), per_need_limit=0)
    assert ctx.products == ()
    assert [t.need_index for t in ctx.task.tasks] == [0]
    assert ctx.unanswered_needs == ()
    assert [tuple(e.get("need_indices") or ())
            for e in ctx.evidence] == [(0,)]
