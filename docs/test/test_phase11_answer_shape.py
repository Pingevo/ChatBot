"""Phase 11 FIX-3/FIX-4 — answer-shape composition at existing typed owners.

contract:
- need ที่ typed outcome ครอบคลุมแล้ว (capability asks ไร้ subject
  evidence → UnansweredNeed deterministic) ไม่ส่ง model task อีก —
  task เหลือแต่ framing → drop ออกจาก AnswerTask; tasks ว่างหมด →
  zero llm.answer_typed call (boundary path เดิม)
- deterministic segments (claim/compat/constraint/unanswered) render
  ก่อน model prose เสมอ; unanswered multi-ask aggregate เป็น cannot-
  confirm clause เดียวต่อ class — ไม่มี repetitive paragraphs
- model-emitted card markup (`](`/`**`/name-echo) drop ที่ compose
  contract เดิม — การ์ดแสดงผ่าน deterministic product results เท่านั้น
- FIX-4 attachment follows decisions: comp.products = decided support
  เท่านั้น (cards ของ covered needs + decided-compatible verdicts +
  labeled near-miss จาก constraint segments); emitted-only cards ของ
  unresolved needs ไม่แนบ/ไม่ bubble; handoff_to_admin เกิดจาก real
  transport ที่ enforce เท่านั้น — ห้าม set ล่วงหน้า (bug#14)
"""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

import pymongo
import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from test_phase7_answer_context import (  # noqa: E402 — reuse typed builders
    _req, _sel_card, _selection, _pool, _pooled, _profile, _compile,
)

_env_before_replay_import = dict(os.environ)
import test_legacy_turn_incident_replay as replay  # noqa: E402,F401

for _k in [k for k in os.environ if k not in _env_before_replay_import]:
    del os.environ[_k]
os.environ.update({k: v for k, v in _env_before_replay_import.items()
                   if os.environ.get(k) != v})
del _env_before_replay_import

from dataclasses import replace as _dc_replace  # noqa: E402
from types import SimpleNamespace as _NS  # noqa: E402

import shopeechat.app as app  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import guards as _guards  # noqa: E402
from shopeechat import llm  # noqa: E402
from shopeechat import policy_resolver as _pr  # noqa: E402
from shopeechat import responses as _resp_mod  # noqa: E402
from shopeechat import retrieval_planner as _rpl  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402

TurnNeed = td.TurnNeed


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    """ห้าม network/Mongo — posture เดียวกับ composition suites."""
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


# ── builders ────────────────────────────────────────────────────────────────

def _need_asks(refs=("W01",), asks=("เชื่อมเข้ากับแอปสตาวา",),
               types=("smartwatch",)):
    return TurnNeed(kind="product", operation="describe",
                    subject_refs=tuple(refs),
                    product_types=frozenset(types),
                    capability_asks=tuple(asks))


def _need_describe(types=("smartwatch",), refs=()):
    return TurnNeed(kind="product", operation="describe",
                    subject_refs=tuple(refs),
                    product_types=frozenset(types))


def _artifact(needs, sel, pool, requests, **kw):
    kw.setdefault("web_configured", False)
    return app._typed_answer_boundary(
        {"selection": sel, "pool": pool, "requests": tuple(requests)},
        needs=needs, profile=_profile(), **kw)


def _answer_spy(monkeypatch, text="model prose ค่ะ"):
    """stub llm.answer_typed leaf — capture payload ที่ model ถูกขอจริง."""
    captured = {}

    def _fake(**kw):
        captured["called"] = True
        captured["context"] = kw.get("context")
        return text, {"prompt": 1, "output": 1, "total": 2}
    monkeypatch.setattr(llm, "answer_typed", _fake)
    return captured


def _ask_fixture(need, *, role="candidate", rid="req-0",
                 name="IMILAB W01"):
    """need ที่มี capability_asks + candidate card ไม่ใช่ subject —
    compile ต้องเข้า _ask_unanswered (deterministic UnansweredNeed)."""
    types = tuple(need.product_types or ("smartwatch",))
    req = _req(rid=rid, types=types)
    sel = _selection((_sel_card("i:1", role, rid, name), rid))
    return req, sel, _pool((_pooled("i:1", "1", name=name),))


# ── RED: handled needs ไม่กลับไปหา model ────────────────────────────────────

def test_ask_only_turn_makes_zero_llm_call(monkeypatch):
    """Strava-shape: need เดียวที่มีแต่ capability asks ไร้หลักฐาน —
    typed UnansweredNeed ตอบแล้ว → ไม่มี model work → 0 call."""
    need = _need_asks()
    req, sel, pool = _ask_fixture(need)
    ctx = _compile((need,), sel, pool, (req,), _profile())
    assert [u.reason for u in ctx.unanswered_needs] == ["no_evidence"]
    captured = _answer_spy(monkeypatch)
    comp = _artifact((need,), sel, pool, (req,))
    assert comp.answer_calls == 0
    assert not captured
    answer = app._render_composition(comp)
    assert answer.count("ไม่มีข้อมูลยืนยัน") == 1
    assert "สตาวา" in answer


def test_handled_need_dropped_from_model_task(monkeypatch):
    """W01 Q2-shape: describe need (มีหลักฐาน → model ทำงาน) + asks-only
    need (typed ตอบแล้ว) → model ถูกเรียกครั้งเดียว แต่ task ไม่มี
    งานของ need ที่ตัดสินแล้ว."""
    n0 = _need_describe()
    n1 = _need_asks(refs=(), asks=("เชื่อมต่อ GPS จากมือถือ",),
                    types=("strap",))
    reqs = (_req(rid="a", types=("smartwatch",)),
            _req(rid="b", types=("strap",)))
    sel = _selection(
        (_sel_card("i:1", "subject", "a", "IMILAB W01"), "a"),
        (_sel_card("i:2", "candidate", "b", "Strap S"), "b"))
    pool = _pool((_pooled("i:1", "1", name="IMILAB W01"),
                  _pooled("i:2", "2", name="Strap S")))
    ctx = _compile((n0, n1), sel, pool, reqs, _profile())
    assert [t.need_index for t in ctx.task.tasks] == [0]
    assert [u.need_index for u in ctx.unanswered_needs] == [1]
    captured = _answer_spy(monkeypatch)
    comp = _artifact((n0, n1), sel, pool, reqs)
    assert comp.answer_calls == 1
    payload = captured["context"].task.render()
    assert "งานที่ 1" in payload and "งานที่ 2" not in payload
    answer = app._render_composition(comp)
    assert "model prose ค่ะ" in answer
    assert answer.count("ไม่มีข้อมูลยืนยัน") == 1
    assert "GPS" in answer


# ── RED: multi-ask aggregate — cannot-confirm clause เดียว ───────────────────

def test_same_subject_unanswered_needs_aggregate_one_clause():
    """หลาย ask-needs subject เดียวกัน ไร้หลักฐาน → cannot-confirm เดียว
    (ไม่ใช่ paragraph ซ้ำต่อ need); per-need audit ยังอยู่ใน comp."""
    n1 = _need_asks(asks=("เชื่อมต่อ GPS จากมือถือ",))
    n2 = _need_asks(asks=("ใช้กับ Strava ได้ไหม",))
    req = _req(rid="r", types=("smartwatch",))
    sel = _selection((_sel_card("i:1", "candidate", "r", "IMILAB W01"), "r"))
    pool = _pool((_pooled("i:1", "1", name="IMILAB W01"),))
    ctx = _compile((n1, n2), sel, pool, (req,), _profile())
    comp = acx.compose_answer(needs=(n1, n2), context=ctx)
    assert len(comp.unanswered_needs) == 2
    answer = app._render_composition(comp)
    assert answer.count("ไม่มีข้อมูลยืนยัน") == 1
    assert "GPS" in answer and "Strava" in answer


# ── contract pins (machinery เดิม — กัน regression ระหว่าง FIX-3) ────────────

def test_deterministic_segments_render_before_model_prose():
    needs = (td.TurnNeed(kind="claim", operation="collect",
                         subject_refs=("X",)), _need_describe())
    req = _req(rid="r", types=("smartwatch",))
    sel = _selection((_sel_card("i:1", "subject", "r", "IMILAB W01"), "r"))
    pool = _pool((_pooled("i:1", "1", name="IMILAB W01"),))
    ctx = _compile(needs, sel, pool, (req,), _profile())
    comp = acx.compose_answer(
        needs=needs, context=ctx, claim_guidance="claim seg ค่ะ",
        product_text="model prose ค่ะ")
    answer = app._render_composition(comp)
    assert answer.index("claim seg ค่ะ") < answer.index("model prose ค่ะ")


def test_model_emitted_card_markup_dropped_at_compose():
    needs = (_need_describe(),)
    req = _req(rid="r", types=("smartwatch",))
    sel = _selection((_sel_card("i:1", "subject", "r", "IMILAB W01"), "r"))
    pool = _pool((_pooled("i:1", "1", name="IMILAB W01"),))
    ctx = _compile(needs, sel, pool, (req,), _profile())
    comp = acx.compose_answer(
        needs=needs, context=ctx,
        product_text=("รุ่นนี้ดีมากค่ะ ||| "
                      "[สั่งซื้อ IMILAB W01](https://x) ||| "
                      "**IMILAB W01**"))
    answer = app._render_composition(comp)
    assert "รุ่นนี้ดีมากค่ะ" in answer
    assert "](" not in answer
    assert "**" not in answer


# ── FIX-4: attachment follows decisions ─────────────────────────────────────

def _req_cons(rid="req-0", types=("charger",), subs=("cable",),
              spec_constraints=(), required_features=()):
    """retrieval request ที่มี typed spec contract (phase7 `_req` ยังไม่
    รับพารามิเตอร์นี้ — fields เดิมของ RetrievalRequest เท่านั้น)."""
    return _rpl.RetrievalRequest(
        request_id=rid, slot_id="slot-a", source="slot",
        product_types=frozenset(types), subtypes=frozenset(subs),
        model_codes=(), target_device=None,
        availability_mode="sellable_first", compat_mode="none",
        spec_constraints=tuple(spec_constraints),
        required_features=tuple(required_features))


def _constraint_fixture():
    """wattaka-Q3 shape — decided candidates ทุกใบ proven-fail typed
    spec constraints (measured 480Mbps < 10000Mbps) → no_match segment."""
    need = TurnNeed(
        kind="product", operation="recommend",
        product_types=frozenset({"charger"}),
        subtypes=frozenset({"cable"}),
        spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
        required_features=("magnetic",))
    req = _req_cons(
        spec_constraints=(("data_transfer_mbps", "gte", 10000.0),),
        required_features=("magnetic",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-0",
                   "CUKTECH CMC615P สายชาร์จแม่เหล็ก",
                   raw_description="สายชาร์จแม่เหล็ก 480Mbps",
                   canonical_type="charger",
                   canonical_roles=["cable"]), "req-0"),
        (_sel_card("i:2", "slot", "req-0",
                   "CUKTECH CTC615W สายชาร์จเร็ว",
                   raw_description="สายชาร์จเร็ว 480Mbps",
                   canonical_type="charger",
                   canonical_roles=["cable"]), "req-0"))
    pool = _pool((_pooled("i:1", "1", name="CUKTECH CMC615P"),
                  _pooled("i:2", "2", name="CUKTECH CTC615W")))
    return (need,), sel, pool, (req,)


def _finalize(comp, products):
    """minimal ChatResponse ผ่าน production finalizer — flag ต้องยังไม่ถูก
    set ล่วงหน้า (bug#14 pin: เกิดจาก transport ที่ enforce เท่านั้น)."""
    return app._finalize_answer(
        comp, message="มีสายชาร์จ 10Gbps ไหม", limit=5,
        products=products, source="test", shop="s", model="m",
        elapsed=0.0, cost=0.0, intent={}, timing={}, steps=[],
        routing_decision={})


def _req_stub():
    return _NS(message="มีสายชาร์จ 10Gbps ไหม", history=[],
               conversation_id="c-test")


def test_no_match_names_labeled_near_miss_never_promises_admin():
    """D3 — ทุก decided candidate proven-fail: deterministic segment
    แจ้งตรงว่าไม่มีสินค้าผ่านเงื่อนไข + name near-miss ใกล้เคียง/ทดแทน;
    comp.products = near-miss ที่ตัดสินแล้วเท่านั้น (alternative label,
    no CTA ใน text); text ไม่เคยสัญญาแอดมิน — flag = transport outcome."""
    needs, sel, pool, reqs = _constraint_fixture()
    ctx = _compile(needs, sel, pool, reqs, _profile())
    assert ctx.constraint_segments, ctx.trace
    comp = acx.compose_answer(needs=needs, context=ctx)
    answer = app._render_composition(comp)
    assert "ไม่มีสินค้าที่ผ่านเงื่อนไขครบทุกข้อ" in answer
    assert "ใกล้เคียง" in answer or "ทดแทน" in answer
    assert "CMC615P" in answer and "CTC615W" in answer
    assert "แอดมิน" not in answer
    assert "สั่งซื้อ" not in answer and "http" not in answer
    ids = sorted(str(p.get("item_id")) for p in comp.products)
    assert ids == ["1", "2"]
    for p in comp.products:
        assert "ทดแทน" in str(p.get("_context_note") or ""), \
            f"near-miss card ต้องแนบ alternative label: {p}"


def test_no_match_handoff_flag_is_transport_truth_at_enforce(monkeypatch):
    """bug#14 pin — handoff_to_admin ต้อง False ก่อน enforce (ห้าม set
    ล่วงหน้า); enforce ยิง _send_handoff จริงครั้งเดียวแล้ว flag =
    outcome จริง; answer ไม่ถูกแตะ (ไม่เคยสัญญาแอดมิน → ไม่มี swap)."""
    needs, sel, pool, reqs = _constraint_fixture()
    ctx = _compile(needs, sel, pool, reqs, _profile())
    comp = acx.compose_answer(needs=needs, context=ctx)
    resp = _finalize(comp, comp.products)
    assert resp.handoff_to_admin is False
    calls = []

    def _ok(*a, **k):
        calls.append(k.get("reason"))
        return {"state": "queued"}
    monkeypatch.setattr(_resp_mod, "_send_handoff", _ok)
    out = _guards.enforce(resp, _req_stub())
    assert calls == ["constraint_no_match"]
    assert out.handoff_to_admin is True
    assert out.handoff_reason == "constraint_no_match"
    assert out.answer == resp.answer


def test_no_match_transport_failure_keeps_truthful_answer(monkeypatch):
    """transport ล้มเหลว → flag False + reason None + answer เดิม
    (near-miss + ไม่มีสินค้าผ่านเงื่อนไข — ไม่เคยบอกว่าแอดมินจะมา)."""
    needs, sel, pool, reqs = _constraint_fixture()
    ctx = _compile(needs, sel, pool, reqs, _profile())
    comp = acx.compose_answer(needs=needs, context=ctx)
    resp = _finalize(comp, comp.products)
    calls = []

    def _fail(*a, **k):
        calls.append(k.get("reason"))
        return None
    monkeypatch.setattr(_resp_mod, "_send_handoff", _fail)
    out = _guards.enforce(resp, _req_stub())
    assert calls == ["constraint_no_match"]
    assert out.handoff_to_admin is False
    assert out.handoff_reason is None
    assert out.answer == resp.answer
    assert "แอดมิน" not in out.answer


def test_unresolved_need_emitted_cards_do_not_attach():
    """Strava shape — asks-need emit candidate เข้า ctx.products แต่ need
    unresolved (no_evidence): card ไม่แนบ comp.products และไม่ bubble."""
    need = _need_asks()
    req, sel, pool = _ask_fixture(need)
    ctx = _compile((need,), sel, pool, (req,), _profile())
    assert ctx.products          # emitted แต่ยังไม่ตัดสิน
    comp = acx.compose_answer(needs=(need,), context=ctx)
    assert comp.products == ()
    answer = app._render_composition(comp)
    assert "](" not in answer


def test_mixed_turn_unresolved_need_cards_do_not_attach():
    """W01-Q2 shape — covered describe card แนบ; card ของ unresolved
    asks-need (emitted จริง มี link) ไม่แนบ/ไม่ bubble."""
    n0 = _need_describe()
    n1 = _need_asks(refs=(), asks=("เชื่อมต่อ GPS จากมือถือ",),
                    types=("strap",))
    reqs = (_req(rid="a", types=("smartwatch",)),
            _req(rid="b", types=("strap",)))
    sel = _selection(
        (_sel_card("i:1", "subject", "a", "IMILAB W01",
                   short_link="https://s/1"), "a"),
        (_sel_card("i:2", "candidate", "b", "Strap S",
                   short_link="https://s/2"), "b"))
    pool = _pool((_pooled("i:1", "1", name="IMILAB W01"),
                  _pooled("i:2", "2", name="Strap S")))
    ctx = _compile((n0, n1), sel, pool, reqs, _profile())
    comp = acx.compose_answer(needs=(n0, n1), context=ctx,
                              product_text="ตอบเรื่องนาฬิกาค่ะ")
    assert [str(p.get("item_id")) for p in comp.products] == ["1"]
    answer = app._render_composition(comp)
    assert "สั่งซื้อ IMILAB W01" in answer
    assert "Strap S" not in answer


def test_decided_verdict_card_attaches_under_unresolved_emitter():
    """decided-compatible verdict = decided support — card แนบแม้ need
    ที่ emit มัน unresolved (partial-compat: verdicted alternative ยัง
    เป็นคำตอบที่ตัดสินแล้ว); กฎเดียวกันครอบ arbitrary identity."""
    n0 = _need_describe()
    n1 = _need_asks(refs=(), asks=("เชื่อมกับ Strava",), types=("strap",))
    reqs = (_req(rid="a", types=("smartwatch",)),
            _req(rid="b", types=("strap",)))
    sel = _selection(
        (_sel_card("i:1", "subject", "a", "IMILAB W01"), "a"),
        (_sel_card("i:2", "candidate", "b", "Strap S"), "b"))
    pool = _pool((_pooled("i:1", "1", name="IMILAB W01"),
                  _pooled("i:2", "2", name="Strap S")))
    ctx = _compile((n0, n1), sel, pool, reqs, _profile())
    v = acx.CompatVerdict(
        need_index=0, subject_id="i:2", subject_name="Strap S",
        target="xiaomi 17 ultra", relation="connects",
        decision=_pr.CompatDecision(
            outcome="compatible", proofs=(), reason_codes=()))
    ctx = _dc_replace(ctx, compat_verdicts=(v,))
    comp = acx.compose_answer(needs=(n0, n1), context=ctx,
                              product_text="ตอบค่ะ")
    ids = sorted(str(p.get("item_id")) for p in comp.products)
    assert ids == ["1", "2"]


def test_covered_need_cards_attach_unchanged():
    """resolved describe turn — subject card แนบตามเดิม (decided support
    ไม่ตัด cards ของ needs ที่ typed outcome ครอบคลุมแล้ว)."""
    needs = (_need_describe(),)
    req = _req(rid="r", types=("smartwatch",))
    sel = _selection((_sel_card("i:1", "subject", "r", "IMILAB W01"), "r"))
    pool = _pool((_pooled("i:1", "1", name="IMILAB W01"),))
    ctx = _compile(needs, sel, pool, (req,), _profile())
    comp = acx.compose_answer(needs=needs, context=ctx,
                              product_text="ตอบค่ะ")
    assert [str(p.get("item_id")) for p in comp.products] == ["1"]
