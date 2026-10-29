"""Phase 11 FIX-3 — answer-shape composition at existing typed owners.

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

import shopeechat.app as app  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import llm  # noqa: E402
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
