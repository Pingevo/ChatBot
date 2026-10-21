"""Phase 10A review findings — typed target ownership + subject-target
evidence coverage (H1/H3 RED tests).

Contract under test (compile_answer_context):
- external target = semantic property ของ compat/relation need เท่านั้น —
  non-compat NeedTask ไม่ render `ใช้กับ X` และ target ที่ propagate จาก
  request ไม่ทำให้ product/describe/recommend need กลายเป็น compat claim
- target ที่มาจาก `relation_target` request = products-for-device channel
  (selection คือคำตอบอยู่แล้ว) — ไม่ถูก evidence gate
- target ที่มาจาก slot/profile (verdict target) ต้องมี subject-target
  scoped coverage: declared proof (subject_id+target+relation+verdict)
  หรือ resolve_compat outcome ∈ {compatible,incompatible} — evidence ของ
  subject อื่น / target อื่น / target-only record ไม่เป็น proof
- products ที่เลือกผ่าน request ที่ carry uncovered verdict target =
  relation context ของ claim ที่พิสูจน์ไม่ได้ → drop จากทุก need
- ไม่มี keyword/regex/prose parser — typed fields + resolver เดิมเท่านั้น
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
    _req, _sel_card, _selection, _pool, _pooled, _profile, _compile,
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


def _describe(refs=("W01",), types=("smartwatch",)):
    return TurnNeed(kind="product", operation="describe",
                    subject_refs=tuple(refs),
                    product_types=frozenset(types))


def _unans(ctx, idx):
    return next((u for u in ctx.unanswered_needs
                 if u.need_index == idx), None)


# ── H1 — typed target ownership ─────────────────────────────────────────────

def test_describe_need_unowned_target_is_not_its_claim():
    """propagated request target ไม่ใช่ semantic target ของ describe need —
    need ต้องยัง answerable (task ไม่มี `ใช้กับ`, products คงอยู่)"""
    need = _describe()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    ctx = _compile((need,), _selection((card, "req-0")), _pool(),
                   (req,), _profile())
    assert len(ctx.task.tasks) == 1
    assert ctx.task.tasks[0].target is None, (
        "describe task ต้องไม่ render external target")
    assert [p["name"] for p in ctx.products] == ["W01 watch"]
    assert ctx.unanswered_needs == ()


def test_relation_channel_compat_target_is_products_for_device():
    """compat need ที่ target มาจาก relation_target request = ช่อง
    products-for-device — selection คือคำตอบ ไม่ใช่ verdict claim →
    ไม่ถูก gate แม้ไม่มี external evidence (Cable B contract)"""
    need = _compat(refs=("AC65B",), types=("cable",))
    req = _req(rid="req-0", source="relation_target",
               target="galaxy z99 fakephone", types=("cable",))
    card = _sel_card("i:2", "relation_target", "req-0", "Cable B")
    ctx = _compile((need,), _selection((card, "req-0")), _pool(),
                   (req,), _profile())
    assert ctx.unanswered_needs == ()
    assert len(ctx.task.tasks) == 1
    assert ctx.task.tasks[0].target == "galaxy z99 fakephone"
    assert [p["name"] for p in ctx.products] == ["Cable B"]


def test_uncovered_verdict_compat_is_no_evidence():
    """compat need + slot-source target + ไม่มี evidence →
    UnansweredNeed(no_evidence) + task หาย + products หาย + ctx empty"""
    need = _compat()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    ctx = _compile((need,), _selection((card, "req-0")), _pool(),
                   (req,), _profile())
    u = _unans(ctx, 0)
    assert u is not None and u.reason == "no_evidence"
    assert ctx.task.tasks == ()
    assert ctx.products == ()
    assert ctx.is_empty  # model ไม่ถูกเรียก — deterministic


def test_mixed_turn_keeps_unrelated_product_need():
    """product need (request สะอาด) + uncovered compat → product task+
    products อยู่, compat เท่านั้นที่ no_evidence — ไม่มี task/product ซ้ำ"""
    need_p = TurnNeed(kind="product", operation="recommend",
                      product_types=frozenset({"earphone"}))
    need_c = _compat()
    req_p = _req(rid="req-p", types=("earphone",))
    req_c = _req(rid="req-c", types=("smartwatch",), target="strava")
    card_p = _sel_card("i:1", "slot", "req-p", "Earphone A")
    card_w = _sel_card("i:2", "subject", "req-c", "W01 watch",
                       model_codes=["W01"])
    sel = _selection((card_p, "req-p"), (card_w, "req-c"))
    ctx = _compile((need_p, need_c), sel, _pool(),
                   (req_p, req_c), _profile())
    assert [t.need_index for t in ctx.task.tasks] == [0]
    assert [p["name"] for p in ctx.products] == ["Earphone A"]
    u = _unans(ctx, 1)
    assert u is not None and u.reason == "no_evidence"


def test_shared_tainted_request_products_drop_everywhere():
    """W01 shape — describe need share request เดียวกับ uncovered compat:
    products ที่เลือกผ่าน tainted request = relation context ของ claim
    ที่พิสูจน์ไม่ได้ → drop จาก describe need ด้วย; describe task คงอยู่
    (ไม่มี claim surface) แต่ไม่มี products → ctx empty → model 0 calls"""
    need_c = _compat()
    need_d = _describe()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    ctx = _compile((need_c, need_d), _selection((card, "req-0")),
                   _pool(), (req,), _profile())
    assert [t.need_index for t in ctx.task.tasks] == [1], (
        "describe task ต้องไม่ถูก drop (ไม่มี target claim) — "
        "แต่ products ต้องหายเพราะเป็น relation context")
    assert ctx.products == ()
    assert _unans(ctx, 0) is not None and _unans(ctx, 0).reason == "no_evidence"
    assert _unans(ctx, 1) is not None
    assert ctx.is_empty


def test_describe_clean_products_survive_mixed_taint():
    """describe need มี products จาก clean request + tainted request —
    เฉพาะ tainted products หาย; need ยัง answerable ด้วย clean products"""
    need_c = _compat()
    need_d = _describe(types=("smartwatch", "earphone"))
    req_t = _req(rid="req-t", types=("smartwatch",), target="strava")
    req_c = _req(rid="req-c", types=("earphone",))
    card_w = _sel_card("i:1", "subject", "req-t", "W01 watch",
                       model_codes=["W01"])
    card_e = _sel_card("i:2", "slot", "req-c", "Earphone A")
    sel = _selection((card_w, "req-t"), (card_e, "req-c"))
    ctx = _compile((need_c, need_d), sel, _pool(),
                   (req_t, req_c), _profile())
    assert [t.need_index for t in ctx.task.tasks] == [1]
    assert [p["name"] for p in ctx.products] == ["Earphone A"]
    assert _unans(ctx, 0) is not None and _unans(ctx, 0).reason == "no_evidence"
    assert _unans(ctx, 1) is None


# ── H3 — subject-target scoped evidence coverage ────────────────────────────

def test_same_target_other_subject_proof_does_not_cover():
    """declared proof ของ W02→strava ต้องไม่ cover W01→strava —
    coverage scope ตาม (need, subject, target) ไม่ใช่ target string"""
    need_w1 = _compat(refs=("W01",), types=("smartwatch",))
    need_w2 = _compat(refs=("W02",), types=("smartwatch",))
    req_1 = _req(rid="req-1", types=("smartwatch",), codes=("W01",),
                 target="strava", cm="bluetooth_general")
    req_2 = _req(rid="req-2", types=("smartwatch",), codes=("W02",),
                 target="strava", cm="bluetooth_general")
    card_w1 = _sel_card("i:1", "subject", "req-1", "W01 watch",
                        model_codes=["W01"])
    card_w2 = _sel_card("i:2", "subject", "req-2", "W02 watch",
                        model_codes=["W02"])
    sel = _selection((card_w1, "req-1"), (card_w2, "req-2"))
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "strava",
         "subject_id": "i:2", "relation": "works_with",
         "verdict": "compatible", "source": "spec-db",
         "subject_refs": ("i:2",)},
    ))
    ctx = _compile((need_w1, need_w2), sel, pool, (req_1, req_2),
                   _profile())
    # W02 covered — verdict record+products อยู่ ไม่ใช่ model task;
    # W01 → no_evidence (proof ของ subject อื่นใช้ไม่ได้)
    assert ctx.task.tasks == ()
    assert _unans(ctx, 0) is not None and _unans(ctx, 0).reason == "no_evidence"
    assert _unans(ctx, 1) is None
    assert [v.need_index for v in ctx.compat_verdicts] == [1]
    assert ctx.compat_verdicts[0].decision.outcome == "compatible"
    assert [p["name"] for p in ctx.products] == ["W02 watch"]


def test_same_subject_different_target_does_not_cover():
    """proof ของ subject เดียวกันแต่ target อื่น → ไม่ cover target ที่ถาม"""
    need = _compat()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "other-app",
         "subject_id": "i:1", "relation": "works_with",
         "verdict": "compatible", "subject_refs": ("i:1",)},
    ))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert _unans(ctx, 0) is not None and _unans(ctx, 0).reason == "no_evidence"
    assert ctx.task.tasks == ()


def test_target_only_web_record_does_not_authorize_claim():
    """web record ที่มีแต่ target (ไม่มี subject/relation proof และ
    ไม่มี structured data) → ไม่ใช่ coverage → no_evidence"""
    need = _compat()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    web = ({"kind": "web", "target": "strava", "need_index": 0,
            "payload": "bluetooth sync strava smartwatch"},)
    ctx = _compile((need,), _selection((card, "req-0")), _pool(),
                   (req,), _profile(), web_evidence=web)
    assert _unans(ctx, 0) is not None and _unans(ctx, 0).reason == "no_evidence"
    assert ctx.task.tasks == ()
    assert ctx.products == ()


def test_exact_subject_target_proof_covers_own_need():
    """declared CompatProof (subject_id+target+relation+verdict) ที่ตรง
    subject/target → covered — task+products อยู่"""
    need = _compat()
    req = _req(rid="req-0", types=("smartwatch",), codes=("W01",),
               target="strava", cm="bluetooth_general")
    card = _sel_card("i:1", "subject", "req-0", "W01 watch",
                     model_codes=["W01"])
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "strava",
         "subject_id": "i:1", "relation": "works_with",
         "verdict": "compatible", "source": "spec-db",
         "subject_refs": ("i:1",)},
    ))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert ctx.unanswered_needs == ()
    v = [x for x in ctx.compat_verdicts if x.need_index == 0]
    assert v and v[0].decision.outcome == "compatible" \
        and v[0].relation == "works_with"
    assert ctx.task.tasks == ()  # verdict → deterministic segment ไม่ใช่ task
    assert [p["name"] for p in ctx.products] == ["W01 watch"]


def test_structured_connector_facts_cover_via_resolver():
    """existing hardware compat — subject card connector + device_spec
    record (structured source) → resolve_compat → compatible → covered"""
    need = _compat(refs=("AC65B",), types=("cable",))
    req = _req(rid="req-0", types=("cable",), codes=("AC65B",),
               target="iphone 15", cm="connector_required")
    card = _sel_card("i:1", "subject", "req-0",
                     "สายชาร์จ C to C 1m", model_codes=["AC65B"])
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:1",)},
    ))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert ctx.unanswered_needs == ()
    v = [x for x in ctx.compat_verdicts if x.need_index == 0]
    assert v and v[0].decision.outcome == "compatible" \
        and v[0].relation == "charges"
    assert ctx.task.tasks == ()
    assert [p["name"] for p in ctx.products] == ["สายชาร์จ C to C 1m"]
