"""Phase 2C.3 — action-switch consumption tests.

TurnPlan.primary_action/needs must own the post-classify action switch and
ConversationSubjectSet stays the single subject-decision owner. Contract pins:

  G1  human_wait → wait-shaped response, no retrieval/LLM, no handoff POST
  G2  no_reply   → silent ack (answer==""), no retrieval/LLM
  G3  clarify    → deterministic clarification, no LLM
  G4  handoff    → existing handoff transport via the plan gate (plan exists)
  G5  execute_needs → every independent need dispatched; mixed needs not dropped
  S1  exactly one decide_turn + one resolve_subjects per eligible turn
  S2  zero duplicate retrieval/action execution for one turn
  M1  image / image_text / video turns keep working through the same plan

All offline — reuses the incident-replay harness (_install/_replay/FakeDb).
"""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

import pytest
import pymongo
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

# Same env-neutral import posture as test_conversation_subject_set.py —
# importing the replay harness sets os.environ defaults; undo the additions.
_env_before_replay_import = dict(os.environ)
import test_legacy_turn_incident_replay as replay  # noqa: E402
from test_legacy_turn_incident_replay import _install  # noqa: E402

for _k in [k for k in os.environ if k not in _env_before_replay_import]:
    del os.environ[_k]
os.environ.update({k: v for k, v in _env_before_replay_import.items()
                   if os.environ.get(k) != v})
del _env_before_replay_import

from shopeechat import app  # noqa: E402
from shopeechat import conversation_products as cp  # noqa: E402
from shopeechat import llm as _llm_mod  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402


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


# ── helpers ─────────────────────────────────────────────────────────────────

SHOP = "KingGadgets"


def _pdoc(item_id: int, name: str, *, cat: str = "อุปกรณ์ชาร์จ",
          desc_extra: str = "") -> dict:
    """Minimal real-shape ShpProducts doc (to_product_card compatible)."""
    return {
        "item_id": float(item_id),
        "item_name": name,
        "item_status": "NORMAL",
        "shopname": SHOP,
        "cat_name": cat,
        "condition": "new",
        "brand": {"brand_id": 1, "original_brand_name": "FX"},
        "gen_price": 490.0,
        "short_link": f"https://s.shopee.co.th/fx{item_id}",
        "image": {"image_url_list": ["https://img.example/fx.jpg"],
                  "image_id_list": ["fximg"]},
        "description": f"{name} {desc_extra}".strip(),
        "tier_variation": [
            {"name": "สี", "option_list": [{"option": "Black"}]}],
        "model": [{
            "model_id": float(item_id) * 10,
            "model_name": name.split()[-1],
            "model_status": "MODEL_NORMAL",
            "stock_info_v2": {"summary_info": {"total_available_stock": 5}},
            "tier_index": [0],
            "price_info": [{"current_price": 49000}],
        }],
        "standardise_tier_variation": [],
    }


def _fx(fid: str, **over) -> dict:
    d = {
        "id": fid,
        "shop": SHOP,
        "platform": "shopee",
        "conversation_id": f"fx-{fid}",
        "catalog": [_pdoc(3001, "FX Charger 65W AC65B"),
                    _pdoc(3002, "FX Charger 100W AC100W"),
                    _pdoc(3003, "FX Cable Type-C 1M", cat="สายชาร์จ")],
        "intent_result": {"intent": "other", "confidence": 0.5},
    }
    d.update(over)
    return d


def _turn(monkeypatch, fx: dict, *, message: str, history=None,
          item_id=None, ticket_state=None, images=None):
    """Install seams for fx, run ONE chat() turn, return captures."""
    client, captured, handoff_calls = _install(monkeypatch, fx)
    kw = dict(message=message, shop=fx.get("shop"),
              platform=fx.get("platform", "shopee"),
              history=list(history or []),
              conversation_id=fx.get("conversation_id"),
              ticket_state=ticket_state,
              limit=5, simulate_assignment=True,
              test_source="phase2c3_action_switch")
    if item_id is not None:
        kw["item_id"] = item_id
    if images is not None:
        kw["images"] = images
    resp = app.chat(app.ChatRequest(**kw))
    return resp, captured, handoff_calls, client


def _spy(monkeypatch, module, name: str) -> list:
    """Count + capture results of module.name (called via module attr)."""
    calls: list = []
    orig = getattr(module, name)
    def _w(*a, **k):
        out = orig(*a, **k)
        calls.append(out)
        return out
    monkeypatch.setattr(module, name, _w)
    return calls


CLARIFY_TEXT = ("ขอโทษค่ะ ลูกค้าหมายถึงสินค้าตัวไหนคะ "
                "ช่วยแจ้งชื่อรุ่นหรือส่งการ์ดสินค้าให้หน่อยนะคะ")


# ── G1 human_wait ────────────────────────────────────────────────────────────

def test_human_wait_locks_turn_no_work(monkeypatch):
    """Active ticket → wait-only response; no LLM, no handoff POST."""
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("g1-lock"),
        message="แอดมินยังไม่ตอบเลยครับ", ticket_state="handoff")
    assert getattr(resp, "routing_decision", {}).get("path") == "human_wait"
    assert not getattr(resp, "handoff_to_admin", False)
    assert captured.calls == []
    assert handoffs == []


# ── G2 no_reply ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("msg", ["[สติกเกอร์]", "[sticker]", "[วิดีโอ]"])
def test_no_reply_media_placeholder_silent(monkeypatch, msg):
    """Bare media/sticker placeholder → no answer text, no LLM, no products."""
    resp, captured, handoffs, _ = _turn(monkeypatch, _fx("g2-noise"),
                                        message=msg)
    assert (resp.answer or "").strip() == "", (
        f"{msg}: expected silent no_reply, got {resp.answer!r}")
    assert captured.calls == []
    assert getattr(resp, "products", []) == []


# ── G3 clarify ───────────────────────────────────────────────────────────────

def test_clarify_unanchored_link_ask(monkeypatch):
    """Follow-up ask with no subject context → deterministic clarify."""
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("g3-clarify"), message="ขอลิงค์หน่อยครับ")
    assert resp.answer == CLARIFY_TEXT
    assert captured.calls == []
    assert getattr(resp, "products", []) == []


def test_clarify_subject_ambiguity_singular_ref_on_pair(monkeypatch):
    """Singular ref on a multi-subject set → clarify (no guessing)."""
    fx = _fx("g3-ambig", timeline_seed={"products": [
        {"item_id": 3001, "name": "FX Charger 65W AC65B", "is_anchor": True},
        {"item_id": 3002, "name": "FX Charger 100W AC100W", "is_anchor": True},
    ]})
    resp, captured, handoffs, _ = _turn(
        monkeypatch, fx, message="ตัวนี้มีสีอะไรบ้างคะ")
    assert resp.answer == CLARIFY_TEXT
    assert captured.calls == []


# ── G4 handoff via plan ─────────────────────────────────────────────────────

def test_handoff_dispatched_by_plan(monkeypatch):
    """Explicit admin request → plan.primary_action=handoff drives transport.

    RED: today detect_human_request returns before intent/plan → the turn
    has no TurnPlan at all (decide_turn never runs)."""
    plans = _spy(monkeypatch, td, "decide_turn")
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("g4-handoff"),
        message="ขอคุยกับแอดมินหน่อยค่ะ")
    assert getattr(resp, "handoff_to_admin", False)
    assert len(plans) == 1, "exactly one TurnPlan per eligible turn"
    assert plans[0].primary_action == "handoff"
    assert captured.calls == []


def test_admin_request_plus_information_need(monkeypatch):
    """Admin ask + product ask in one turn → handoff wins; plan keeps both
    needs recorded (human+product) instead of silently dropping the info need."""
    plans = _spy(monkeypatch, td, "decide_turn")
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("g4-mixed"),
        message="ขอคุยกับแอดมิน แล้วพาวเวอร์แบงค์มีไหมครับ")
    assert getattr(resp, "handoff_to_admin", False)
    assert len(plans) == 1
    kinds = {n.kind for n in plans[0].needs}
    assert {"human", "product"} <= kinds


# ── G5 execute_needs / mixed dispatch ────────────────────────────────────────

def test_mixed_product_and_policy_both_served(monkeypatch):
    """product+policy in one turn → product cards AND policy context reach the
    same answer call. RED: today general_qtype early-returns answer_general
    with products=[] (product need silently dropped)."""
    shipping = "นโยบายการจัดส่ง\nจัดส่งฟรีทั่วประเทศ รอบจัดส่งทุกวัน"
    fx = _fx("g5-mixed", catalog=[
        _pdoc(3001, "FX Cable Type-C 1M", cat="สายชาร์จ",
              desc_extra=shipping),
    ], intent_result={"intent": "general_question",
                      "general_qtype": "shipping_policy",
                      "confidence": 0.9})
    resp, captured, handoffs, _ = _turn(
        monkeypatch, fx, message="สายชาร์จ type c มีไหมครับ ส่งฟรีไหม")
    product_calls = [c for c in captured.calls
                     if c.get("fn") == "answer" and c.get("products")]
    assert product_calls, (
        f"product need dropped — llm calls: {[c.get('fn') for c in captured.calls]}")
    blob = " ".join(str(c.get("extra_context") or "") for c in captured.calls)
    assert "จัดส่ง" in blob, "policy need dropped — no shipping context carried"


def test_claim_plus_product_plan_records_both(monkeypatch):
    """claim signal + product ask → plan keeps claim+product needs; claim
    lifecycle owner (warranty_flow) still consumes the turn (no new claim
    architecture — product part stays on the plan record)."""
    plans = _spy(monkeypatch, td, "decide_turn")
    resp, captured, handoffs, client = _turn(
        monkeypatch, _fx("g5-claim-product"),
        message="สินค้าเสียอยากเคลม แล้วก็อยากดูพาวเวอร์แบงค์ด้วยครับ")
    assert len(plans) == 1
    kinds = {(n.kind, n.operation) for n in plans[0].needs}
    assert ("claim", "collect") in kinds
    assert any(k == "product" for k, _ in kinds), (
        f"product need dropped at planning: {kinds}")


def test_compare_and_compat_needs_coexist(monkeypatch):
    """Explicit pair compare + compat ask → both item ids reach the LLM."""
    fx = _fx("g5-cmp-compat", intent_result={
        "intent": "compatibility_check", "confidence": 0.9,
        "target_device": "iphone"})
    resp, captured, handoffs, _ = _turn(
        monkeypatch, fx,
        message="AC65B กับ AC100W ต่างกันยังไง ใช้กับ iphone ได้ไหม")
    ids = {_norm_id(p.get("item_id"))
           for c in captured.calls for p in c.get("products") or []}
    assert ids & {"3001"} and ids & {"3002"}, (
        f"compare pair not in llm input: {sorted(ids)}")


def _norm_id(v):
    s = str(v)
    return s[:-2] if s.endswith(".0") else s


def test_item_card_turn_executes_via_plan(monkeypatch):
    """[สินค้า: N] + question → plan exists and the tagged card reaches llm.

    RED: today the item-tag arm early-returns llm.answer BEFORE intent/plan —
    decide_turn never runs for item-tag turns."""
    plans = _spy(monkeypatch, td, "decide_turn")
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("g5-card"),
        message="[สินค้า: 3001] ตัวนี้กันน้ำไหมครับ")
    assert len(plans) == 1, "item-tag turn must produce exactly one TurnPlan"
    ids = {_norm_id(p.get("item_id"))
           for c in captured.calls for p in c.get("products") or []}
    assert "3001" in ids, f"tagged card missing from llm input: {sorted(ids)}"


# ── S1 one plan + one subject resolution per turn ────────────────────────────

def test_one_plan_one_resolution_per_turn(monkeypatch):
    """Eligible turn → exactly one decide_turn and ≤1 resolve_subjects."""
    plans = _spy(monkeypatch, td, "decide_turn")
    resols = _spy(monkeypatch, cp, "resolve_subjects")
    fx = _fx("s1-counts", timeline_seed={"products": [
        {"item_id": 3001, "name": "FX Charger 65W AC65B", "is_anchor": True},
    ]})
    _turn(monkeypatch, fx, message="ตัวนี้ราคาเท่าไหร่ครับ")
    assert len(plans) == 1, f"decide_turn calls={len(plans)}"
    assert len(resols) <= 1, f"resolve_subjects calls={len(resols)}"


def test_one_plan_for_handoff_turn(monkeypatch):
    """Handoff turns are plan-eligible too (post-classify gate consumes them)."""
    plans = _spy(monkeypatch, td, "decide_turn")
    _turn(monkeypatch, _fx("s1-handoff"), message="ขอคุยกับแอดมินหน่อยค่ะ")
    assert len(plans) == 1


# ── S2 zero duplicate execution ──────────────────────────────────────────────

def test_no_duplicate_retrieval_or_answer(monkeypatch):
    """One user turn → exactly one answer-producing call and bounded fetches.

    Uses the `_CapturedLLM` instance that `_install` actually wired into the
    llm.answer* seams — a locally constructed `_CapturedLLM()` is never
    attached to anything and would make this assertion vacuous."""
    from shopeechat import product_store
    fetches: list = []
    fx = _fx("s2-dup", timeline_seed={
        "products": [
            {"item_id": 3001, "name": "FX Charger 65W AC65B",
             "is_anchor": True}],
        "active_item_id": 3001,
    })
    _client, captured, _handoffs = _install(monkeypatch, fx)
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)
    resp = app.chat(app.ChatRequest(
        message="ตัวนี้ราคาเท่าไหร่ครับ", shop=SHOP, platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    answer_calls = [c for c in captured.calls
                    if c.get("fn") in ("answer", "answer_general",
                                       "answer_with_kb")]
    assert len(answer_calls) == 1, (
        f"eligible answer turn must produce exactly 1 answer call: "
        f"{len(answer_calls)} {answer_calls!r}")
    assert len(fetches) <= 1, f"duplicate retrieval: {len(fetches)} fetch calls"


# ── M1 media turns ───────────────────────────────────────────────────────────

def test_image_text_turn_uses_plan_and_vision(monkeypatch):
    """[รูปภาพ]+question+images → vision desc feeds the same plan/answer path."""
    plans = _spy(monkeypatch, td, "decide_turn")
    monkeypatch.setattr(_llm_mod, "describe_images",
                        lambda *a, **k: ("สายชาร์จสีดำเส้นขาด",
                                         {"prompt": 1, "output": 1, "total": 2}))
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("m1-image"),
        message="[รูปภาพ] แบบในรูปมีขายไหมครับ",
        images=["https://img.example/cable.jpg"])
    assert len(plans) == 1
    assert captured.calls, "image_text turn produced no llm call"


def test_video_placeholder_with_text_executes(monkeypatch):
    """[วิดีโอ]+text → media provenance + normal execute path (not no_reply)."""
    plans = _spy(monkeypatch, td, "decide_turn")
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("m1-video"),
        message="[วิดีโอ] ตัวในลิ้งนี้มีสีอะไรบ้างครับ")
    assert len(plans) == 1
    assert plans[0].primary_action != "no_reply"


def test_bare_image_placeholder_no_reply(monkeypatch):
    """Bare [รูปภาพ] without claim state → no_reply (silent), no LLM spend."""
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("m1-bare-img"), message="[รูปภาพ]")
    assert (resp.answer or "").strip() == ""
    assert captured.calls == []


# ── H1 planner failure must fail closed ──────────────────────────────────────

def test_planner_exception_fails_closed(monkeypatch):
    """decide_turn raises → turn dies at the existing 500 boundary.

    Contract: zero product retrieval, zero answer-producing LLM calls, zero
    handoff transport, zero domain execution — never the legacy pipeline."""
    from fastapi import HTTPException
    from shopeechat import product_store

    fetches: list = []
    _client, captured, handoffs = _install(
        monkeypatch, _fx("h1-fail"))
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)
    monkeypatch.setattr(td, "decide_turn",
                        lambda *a, **k: (_ for _ in ()).throw(
                            RuntimeError("planner boom")))
    with pytest.raises(HTTPException) as exc:
        app.chat(app.ChatRequest(
            message="AC65B มีไหมครับ", shop=SHOP, platform="shopee",
            history=[], conversation_id="fx-h1-fail",
            ticket_state=None, limit=5, simulate_assignment=True,
            test_source="phase2c3_action_switch"))
    assert exc.value.status_code == 500
    assert fetches == [], f"planner failure must do zero retrieval: {fetches}"
    assert captured.calls == [], (
        f"planner failure must do zero llm calls: {captured.calls}")
    assert handoffs == [], (
        f"planner failure must do zero handoff transport: {handoffs}")


# ── M1 authoritative handoff — no re-detection, no fallthrough ──────────────

def test_handoff_never_falls_through_when_detector_declines(monkeypatch):
    """Plan says handoff but the old detector predicate disagrees → the turn
    must still fail closed at the handoff boundary — never bot answer.

    RED: today `_hr is None` silently falls through to product retrieval and
    the LLM answers as if the handoff action never happened."""
    from shopeechat import handoffs as _handoffs_mod
    from shopeechat import product_store

    fetches: list = []
    _client, captured, handoffs = _install(
        monkeypatch, _fx("m1-decline"))
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)
    # detector outcome = "nothing detected" (predicate disagreement)
    monkeypatch.setattr(_handoffs_mod, "detect_human_request",
                        lambda req, ctx, **kw: None)
    resp = app.chat(app.ChatRequest(
        message="ขอคุยกับแอดมินหน่อยค่ะ", shop=SHOP, platform="shopee",
        history=[], conversation_id="fx-m1-decline",
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    assert captured.calls == [], (
        f"handoff action fell through to bot answering: {captured.calls}")
    assert fetches == [], f"handoff action fell through to retrieval: {fetches}"
    assert not getattr(resp, "products", []), (
        f"handoff action produced product cards: {resp.products}")


def test_handoff_dispatch_uses_plan_decision(monkeypatch):
    """The plan's handoff decision reaches the transport as an authoritative
    decision (`plan_decided_reason`), not as a re-detection request."""
    from shopeechat import handoffs as _handoffs_mod
    seen: list = []
    orig = _handoffs_mod.detect_human_request
    def _spy(req, ctx, **kw):
        seen.append(kw.get("plan_decided_reason"))
        return orig(req, ctx, **kw)
    monkeypatch.setattr(_handoffs_mod, "detect_human_request", _spy)
    resp, captured, handoffs, _ = _turn(
        monkeypatch, _fx("m1-decision"),
        message="ขอคุยกับแอดมินหน่อยค่ะ")
    assert getattr(resp, "handoff_to_admin", False)
    assert seen == ["human_request"], (
        f"transport must receive plan decision, not re-detect: {seen}")


# ── H1 handoff dominance — authoritative handoff outranks remaining needs ────

def test_claim_handoff_dominates_product_need(monkeypatch):
    """claim request + product ask in one turn → first-message claim produces
    an authoritative handoff → turn terminates: zero product retrieval, zero
    answer-producing LLM calls, zero product cards, no appended product text.

    RED: the inline warranty-boundary `fetch_products`+`llm.answer` path runs
    product work after the confirmed handoff."""
    from shopeechat import product_store
    fetches: list = []
    fx = _fx("h1-dominant", catalog=[
        _pdoc(3101, "FX Powerbank 20000mAh PB200P", cat="พาวเวอร์แบงค์"),
        _pdoc(3102, "FX Powerbank 10000mAh PB100", cat="พาวเวอร์แบงค์"),
    ])
    _client, captured, handoffs = _install(monkeypatch, fx)
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)
    plans = _spy(monkeypatch, td, "decide_turn")
    resp = app.chat(app.ChatRequest(
        message="สินค้าเสียอยากเคลม แล้วก็อยากดูพาวเวอร์แบงค์ด้วยครับ",
        shop=SHOP, platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    assert len(plans) == 1
    kinds = {(n.kind, n.operation) for n in plans[0].needs}
    assert ("claim", "collect") in kinds, kinds
    assert any(k == "product" for k, _ in kinds), kinds
    # claim owner produced authoritative handoff → ownership moved
    assert getattr(resp, "handoff_to_admin", False), (
        f"expected confirmed handoff, got {resp.answer!r}")
    assert len(handoffs) == 1, f"exactly one handoff transport: {handoffs}"
    # claim lifecycle persisted by its owner
    claim = cp.load_claim_state(fx["conversation_id"])
    assert claim, "claim need not processed — no claim_state persisted"
    # zero product work after the confirmed handoff
    answer_calls = [c for c in captured.calls
                    if c.get("fn") in ("answer", "answer_general",
                                       "answer_with_kb")]
    assert answer_calls == [], (
        f"product work ran after confirmed handoff: {answer_calls}")
    assert fetches == [], f"product retrieval after handoff: {fetches}"
    assert getattr(resp, "products", []) == [], (
        f"product cards appended after handoff: {resp.products}")


# ── H2 bot-owned claim + product → canonical product pipeline ────────────────

def test_bot_owned_claim_plus_product_canonical_path(monkeypatch):
    """claim-domain response that stays bot-owned (review request — no handoff
    attempted) + independent product need → claim guidance carries forward and
    the canonical product pipeline answers ONCE with normal metrics.

    RED: today `_wfr` returns early — no canonical retrieval/answer boundary
    runs, and no claim guidance reaches the composed response."""
    from shopeechat import product_store
    fetches: list = []
    fx = _fx("h2-carry", catalog=[
        _pdoc(3101, "FX Powerbank 20000mAh PB200P", cat="พาวเวอร์แบงค์"),
        _pdoc(3102, "FX Powerbank 10000mAh PB100", cat="พาวเวอร์แบงค์"),
    ], claim_state_seed={"stage": "collecting", "episode_id": "ep-carry1"})
    _client, captured, handoffs = _install(monkeypatch, fx)
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)
    resp = app.chat(app.ChatRequest(
        message="ขอทวนข้อมูลที่ให้ไปหน่อย แล้วก็อยากดูพาวเวอร์แบงค์ด้วยครับ",
        shop=SHOP, platform="shopee",
        history=[{"role": "model",
                  "text": ("รบกวนแจ้งข้อมูลเพื่อตรวจสอบสิทธิ์การรับประกันค่ะ "
                           "เลขที่คำสั่งซื้อ เบอร์โทร รูปหรือวิดีโอ")}],
        conversation_id=fx["conversation_id"],
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    # claim domain stayed bot-owned — no handoff transport
    assert handoffs == [], f"no handoff may fire: {handoffs}"
    assert not getattr(resp, "handoff_to_admin", False)
    # claim episode remains owned/persisted (unchanged collecting episode)
    claim = cp.load_claim_state(fx["conversation_id"])
    assert claim and claim.get("episode_id") == "ep-carry1", claim
    # canonical product pipeline executed exactly once
    answer_calls = [c for c in captured.calls
                    if c.get("fn") in ("answer", "answer_general",
                                       "answer_with_kb")]
    assert len(answer_calls) == 1, (
        f"canonical answer boundary must run once: {answer_calls}")
    assert len(fetches) >= 1, f"canonical retrieval never ran: {fetches}"
    step_names = [s.get("name") if isinstance(s, dict) else s
                  for s in (getattr(resp, "steps", []) or [])]
    assert "RAG" in step_names and "LLM2" in step_names, (
        f"canonical instrumentation missing: {step_names}")
    assert getattr(resp, "products", []), (
        "product evidence dropped — no cards in response")
    # claim guidance composed with the product answer (once, canonical shape)
    assert "ทวน" in (resp.answer or "") or "ข้อมูลที่ลูกค้า" in (
        resp.answer or ""), f"claim guidance lost: {resp.answer!r}"
    # canonical metrics describe the one real LLM call (fake usage {10,5,15})
    assert getattr(resp, "usage", {}) == {"prompt": 10, "output": 5,
                                        "total": 15}, resp.usage
    _rag = [s for s in resp.steps
            if isinstance(s, dict) and s.get("name") == "RAG"]
    _llm2 = [s for s in resp.steps
             if isinstance(s, dict) and s.get("name") == "LLM2"]
    assert len(_rag) == 1 and len(_llm2) == 1, step_names
    # response cost == the LLM2 step's cost — same canonical call
    #   (covers vision tokens folded into prompt/output counts)
    assert getattr(resp, "cost", 0) == _llm2[0]["cost_usd"], resp.cost
    assert resp.cost > 0, f"canonical cost must be non-zero: {resp.cost}"
    _timing = getattr(resp, "timing", {})
    assert "llm" in _timing and _timing["llm"] is not None, (
        f"canonical llm timing missing: {_timing}")


# ── H1 typed disposition — terminal follows disposition, not prose ───────────

def test_failed_handoff_terminal_via_typed_disposition(monkeypatch):
    """Failed/blocked claim handoff → terminal via the warranty owner's typed
    disposition — mutating the customer-facing failure copy must not change
    control flow (no retrieval, no answer call, no cards, one transport).

    RED: no typed `warranty_disposition` exists — the boundary compares
    `answer == HANDOFF_FAILED_REPLY` (prose-derived lifecycle)."""
    from shopeechat import product_store
    from shopeechat import responses as _resp_mod
    from shopeechat import warranty_flow as _wf_mod
    fetches: list = []
    fx = _fx("h1-failed", catalog=[
        _pdoc(3101, "FX Powerbank 20000mAh PB200P", cat="พาวเวอร์แบงค์"),
    ])
    _client, captured, handoffs = _install(monkeypatch, fx)
    # mutate displayed failure copy — control flow must not depend on it
    monkeypatch.setattr(_resp_mod, "HANDOFF_FAILED_REPLY",
                        "ขออภัยค่ะ ติดต่อแอดมินไม่ได้ชั่วคราว (mutated)")
    def _fail_send(req, ctx=None, *, reason="", **kw):
        handoffs.append({"reason": reason})
        return {}
    monkeypatch.setattr(app, "_send_handoff", _fail_send)
    seen: dict = {}
    _orig = _wf_mod.handle_warranty_flow_legacy
    def _spy(*a, **k):
        r = _orig(*a, **k)
        # capture BEFORE the boundary pops the internal field off the dict
        seen["disp"] = (r or {}).get("warranty_disposition")
        return r
    monkeypatch.setattr(_wf_mod, "handle_warranty_flow_legacy", _spy)
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)
    resp = app.chat(app.ChatRequest(
        message="สินค้าเสียอยากเคลม แล้วก็อยากดูพาวเวอร์แบงค์ด้วยครับ",
        shop=SHOP, platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    # typed owner signal — enum member, not a prose/string comparison
    from shopeechat.warranty_flow import _WarrantyDisposition as _WD
    assert isinstance(seen.get("disp"), _WD) and seen["disp"] is _WD.TERMINAL, (
        f"typed disposition missing/not enum: {seen!r}")
    assert not hasattr(resp, "warranty_disposition"), (
        "internal disposition leaked into the API model")
    # failed handoff keeps honest failure copy (mutated) + no ownership claim
    assert not getattr(resp, "handoff_to_admin", False)
    assert "mutated" in (resp.answer or ""), resp.answer
    assert len(handoffs) == 1, f"exactly one transport attempt: {handoffs}"
    answer_calls = [c for c in captured.calls
                    if c.get("fn") in ("answer", "answer_general",
                                       "answer_with_kb")]
    assert answer_calls == [], f"product work after failed handoff: {answer_calls}"
    assert fetches == [], f"product retrieval after failed handoff: {fetches}"
    assert getattr(resp, "products", []) == []


# ── H2 routing invariance — claim guidance composes, never re-routes ────────
#
# Contract: the same product ask selects the same product-domain branch with
# or without bot-owned claim guidance. `_mixed_claim_carry` is presentation
# data for the shared finisher only — it must never appear in branch-selection
# conditions.

_REVIEW_ASK = "ขอทวนข้อมูลที่ให้ไปหน่อย"
_CLAIM_HIST = [{"role": "model",
                "text": ("รบกวนแจ้งข้อมูลเพื่อตรวจสอบสิทธิ์การรับประกันค่ะ "
                         "เลขที่คำสั่งซื้อ เบอร์โทร รูปหรือวิดีโอ")}]
_PB_CAT = [_pdoc(3101, "FX Powerbank 20000mAh PB200P", cat="พาวเวอร์แบงค์"),
           _pdoc(3102, "FX Powerbank 10000mAh PB100", cat="พาวเวอร์แบงค์")]


def _run_invariance_pair(monkeypatch, fid, product_ask, *, catalog,
                         kb_seed=None):
    """Run `product_ask` plain vs prefixed with a bot-owned claim-review ask.

    Returns (plain_resp, mixed_resp, mixed_captured, mixed_handoffs,
    wfr_answer) — `wfr_answer` is the actual claim-guidance text produced by
    the warranty owner (mutation-proof: never asserted against a literal)."""
    from shopeechat import warranty_flow as _wf_mod

    client_p, _cap, _hd = _install(
        monkeypatch, _fx(f"inv-{fid}-p", catalog=list(catalog)))
    if kb_seed:
        client_p[replay.ADMIN_DB]["kb_products"].insert_one(kb_seed)
    plain = app.chat(app.ChatRequest(
        message=product_ask, shop=SHOP, platform="shopee",
        history=[], conversation_id=f"inv-{fid}-p",
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))

    client_m, captured, handoffs = _install(monkeypatch, _fx(
        f"inv-{fid}-m", catalog=list(catalog),
        claim_state_seed={"stage": "collecting", "episode_id": f"ep-{fid}"}))
    if kb_seed:
        client_m[replay.ADMIN_DB]["kb_products"].insert_one(kb_seed)
    wfr: dict = {}
    _orig = _wf_mod.handle_warranty_flow_legacy
    def _spy(*a, **k):
        r = _orig(*a, **k)
        wfr["answer"] = (r or {}).get("answer") or ""
        return r
    monkeypatch.setattr(_wf_mod, "handle_warranty_flow_legacy", _spy)
    mixed = app.chat(app.ChatRequest(
        message=f"{_REVIEW_ASK} {product_ask}", shop=SHOP,
        platform="shopee", history=list(_CLAIM_HIST),
        conversation_id=f"inv-{fid}-m",
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    return plain, mixed, captured, handoffs, wfr["answer"]


def _assert_invariant(plain, mixed, wfr_answer, captured, *,
                      expected_source):
    """Claim carry changes composition only — branch identity invariant."""
    assert wfr_answer, "bot-owned claim guidance expected (review carry)"
    assert getattr(plain, "source") == expected_source, (
        f"plain baseline not in family: {plain.source!r}")
    assert getattr(mixed, "source") == expected_source, (
        f"carry re-routed: {mixed.source!r} ≠ {expected_source!r}")
    # guidance composed exactly once via the actual owner-produced text
    _g = wfr_answer.strip()
    assert _g and (mixed.answer or "").count(_g) == 1, (
        f"guidance must appear exactly once: {mixed.answer!r}")
    assert _g not in (plain.answer or ""), "no claim context on plain turn"
    _ans = [c.get("fn") for c in captured.calls
            if c.get("fn") in ("answer", "answer_general", "answer_with_kb")]
    assert len(_ans) <= 1, f"no extra answer call on carry turn: {_ans}"


def test_carry_invariant_general_branch(monkeypatch):
    """general_qtype branch identical with/without carry."""
    plain, mixed, captured, _h, wfr = _run_invariance_pair(
        monkeypatch, "gen",
        "เงื่อนไขการจัดส่งเป็นไง อยากดูพาวเวอร์แบงค์ด้วยครับ",
        catalog=_PB_CAT)
    _assert_invariant(plain, mixed, wfr, captured,
                      expected_source="general:shipping_policy")
    assert [c.get("fn") for c in captured.calls] == ["answer_general"], (
        f"general branch must own the boundary: {captured.calls}")


def test_carry_invariant_brand_branch(monkeypatch):
    """brand-info branch identical with/without carry."""
    _xmi = {"brand_id": 1, "original_brand_name": "Xiaomi"}
    plain, mixed, captured, _h, wfr = _run_invariance_pair(
        monkeypatch, "brand", "xiaomi มีอะไรบ้าง อยากดูพาวเวอร์แบงค์ด้วยครับ",
        catalog=[{**_pdoc(3201, "Xiaomi Watch S3 XW3", cat="สมาร์ทวอทช์"),
                  "brand": _xmi},
                 {**_pdoc(3202, "Xiaomi Smart Band 9 XB9", cat="สมาร์ทวอทช์"),
                  "brand": _xmi}])
    _assert_invariant(plain, mixed, wfr, captured,
                      expected_source="general:brand_info")
    assert [c.get("fn") for c in captured.calls] == ["answer_general"], (
        f"brand branch must own the boundary: {captured.calls}")


def test_carry_invariant_kb_branch(monkeypatch):
    """KB model-spec branch identical with/without carry — real seeded
    kb_products evidence (not vacuous)."""
    kb_doc = {"_id": "kb-pb200p", "type": "product_spec", "active": True,
              "brand": "FX", "model": "PowerBank PB200P",
              "category": "พาวเวอร์แบงค์",
              "specs": {"capacity": "20000mAh"}}
    plain, mixed, captured, _h, wfr = _run_invariance_pair(
        monkeypatch, "kb", "pb200p สเปค อยากดูพาวเวอร์แบงค์ด้วยครับ",
        catalog=_PB_CAT, kb_seed=kb_doc)
    _assert_invariant(plain, mixed, wfr, captured,
                      expected_source="knowledge_base+mongo")


def test_carry_invariant_superlative_clarify(monkeypatch):
    """superlative clarify (deterministic, LLM-free) identical with/without
    carry — guidance composes, clarify not suppressed, no ungrounded LLM."""
    plain, mixed, captured, _h, wfr = _run_invariance_pair(
        monkeypatch, "sup", "อยากได้นาฬิกาไวสุดแรงสุดครับ", catalog=[])
    _assert_invariant(plain, mixed, wfr, captured,
                      expected_source="superlative_no_match_clarify")
    assert "ระบุประเภทสินค้า" in (mixed.answer or ""), (
        "deterministic clarify text must survive")
    assert captured.calls == [], (
        f"clarify arm must stay LLM-free: {captured.calls}")


def test_carry_invariant_no_product_guard(monkeypatch):
    """no-product guard identical with/without carry — safe outcome +
    authoritative handoff preserved; zero ungrounded LLM answer."""
    plain, mixed, captured, handoffs, wfr = _run_invariance_pair(
        monkeypatch, "npf", "มีพาวเวอร์แบงค์ไหมคะ", catalog=[])
    _assert_invariant(plain, mixed, wfr, captured,
                      expected_source="no_product_found_handoff")
    # existing safe outcome: typed handoff result + stop behavior
    assert getattr(mixed, "handoff_to_admin", False), (
        "guard's authoritative handoff must still fire")
    assert getattr(mixed, "handoff_reason") == "no_product_found"
    assert getattr(mixed, "products", []) == []
    assert len(handoffs) == 1, f"exactly one guard handoff: {handoffs}"
    assert captured.calls == [], (
        f"no ungrounded product-answer LLM: {captured.calls}")


def test_missing_disposition_fails_closed(monkeypatch):
    """A warranty dict without the typed disposition → orchestrator fails
    closed: warranty response returned, zero downstream product work
    (missing can never become continue-product)."""
    from shopeechat import warranty_flow as _wf_mod
    from shopeechat import product_store
    fetches: list = []
    fx = _fx("h1-missing", catalog=list(_PB_CAT))
    _client, captured, handoffs = _install(monkeypatch, fx)
    stub = {"answer": "STUB-CLAIM-RESPONSE", "answer_segments": [],
            "products": [], "shop": SHOP, "model": "test",
            "source": "warranty_claim_flow", "usage": {},
            "elapsed": 0.0, "cost": 0.0, "handoff_to_admin": False}
    monkeypatch.setattr(_wf_mod, "handle_warranty_flow_legacy",
                        lambda *a, **k: dict(stub))
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)
    resp = app.chat(app.ChatRequest(
        message="สินค้าเสียอยากเคลม แล้วก็อยากดูพาวเวอร์แบงค์ด้วยครับ",
        shop=SHOP, platform="shopee", history=[],
        conversation_id=fx["conversation_id"],
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    assert resp.answer == "STUB-CLAIM-RESPONSE", resp.answer
    assert captured.calls == [], f"missing disposition → zero LLM: {captured.calls}"
    assert fetches == [], f"missing disposition → zero retrieval: {fetches}"


# ── M2 transport is execution-only — never re-classifies ─────────────────────

def test_handoff_transport_never_reclassifies(monkeypatch):
    """`plan_decided_reason` is a required kwarg — omitting it raises
    TypeError before any predicate/transport call; the transport never
    re-classifies text."""
    from shopeechat import handoffs as _handoffs_mod
    pred_calls: list = []
    monkeypatch.setattr(_handoffs_mod, "is_human_request",
                        lambda m: pred_calls.append(("human", m)) or True)
    monkeypatch.setattr(_handoffs_mod, "is_service_anger",
                        lambda m: pred_calls.append(("anger", m)) or True)
    monkeypatch.setattr(
        app, "_send_handoff",
        lambda *a, **k: {"outcome": {"state": "assigned"}})
    req = SimpleNamespace(message="ขอคุยกับแอดมินหน่อยค่ะ",
                          conversation_id="c-m2", shop=None,
                          ticket_state=None)
    # no decided reason → TypeError before predicates/transport (no detect)
    with pytest.raises(TypeError):
        _handoffs_mod.detect_human_request(req, {})
    assert pred_calls == [], f"transport re-classified: {pred_calls}"
    # decided human_request → transport executes without re-detection
    out = _handoffs_mod.detect_human_request(
        req, {}, plan_decided_reason="human_request")
    assert pred_calls == [], f"transport re-classified: {pred_calls}"
    assert out is not None and out["handoff_reason"] == "human_request", out
    # decided frustration → same transport, frustration reason
    out = _handoffs_mod.detect_human_request(
        req, {}, plan_decided_reason="customer_frustration")
    assert out is not None and out["handoff_reason"] == "customer_frustration", out
    # invalid/typo decided reason → explicit failure, never reinterpreted
    # as anger (accepted set = human_request | customer_frustration)
    with pytest.raises(ValueError):
        _handoffs_mod.detect_human_request(
            req, {}, plan_decided_reason="human_requestt")
    with pytest.raises(ValueError):
        _handoffs_mod.detect_human_request(req, {}, plan_decided_reason="")
    assert pred_calls == [], f"transport re-classified: {pred_calls}"
    # active-ticket guard still prevents duplicate POST
    req_locked = SimpleNamespace(message="ขอคุยกับแอดมิน",
                                 conversation_id="c-m2", shop=None,
                                 ticket_state="handoff")
    assert _handoffs_mod.detect_human_request(
        req_locked, {}, plan_decided_reason="human_request") is None


# ── handoff reason ownership — TurnPlan flag, never provenance ──────────────

def test_handoff_reason_owned_by_plan_flag_not_provenance(monkeypatch):
    """`"customer_frustration" in TurnPlan.flags` is the sole source of the
    transport reason — `TurnNeed.provenance` is diagnostic evidence and must
    never steer behavior. Renaming the diagnostic marker must not flip the
    decided reason."""
    import dataclasses
    from shopeechat import product_store
    fetches: list = []
    decided: list = []
    pred_calls: list = []

    fx = _fx("h4-prov", catalog=[
        _pdoc(3101, "FX Powerbank 20000mAh PB200P", cat="พาวเวอร์แบงค์")])
    _client, captured, handoffs = _install(monkeypatch, fx)

    # rewrite ONLY the diagnostic provenance of the human need — the plan's
    # action/flag contract stays identical
    _real_dt = td.decide_turn
    def _renamed_plan(*a, **k):
        plan = _real_dt(*a, **k)
        return dataclasses.replace(plan, needs=tuple(
            dataclasses.replace(
                n, provenance=("handoffs.diagnostic_marker_renamed",))
            if n.kind == "human" else n
            for n in plan.needs))
    monkeypatch.setattr(td, "decide_turn", _renamed_plan)

    from shopeechat import handoffs as _hf
    _real_dhr = _hf.detect_human_request
    def _spy_dhr(req, ctx, *, plan_decided_reason):
        decided.append(plan_decided_reason)
        return _real_dhr(req, ctx, plan_decided_reason=plan_decided_reason)
    monkeypatch.setattr(_hf, "detect_human_request", _spy_dhr)

    monkeypatch.setattr(_hf, "is_human_request",
                        lambda m: pred_calls.append("is_human_request") or False)
    monkeypatch.setattr(_hf, "is_service_anger",
                        lambda m: pred_calls.append("is_service_anger") or True)
    orig_fetch = product_store.fetch_products
    def _fw(*a, **k):
        fetches.append(a)
        return orig_fetch(*a, **k)
    monkeypatch.setattr(product_store, "fetch_products", _fw)

    resp = app.chat(app.ChatRequest(
        message="ส่งของช้ามากเลยครับ แย่มาก",
        shop=SHOP, platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))

    # canonical decision: handoff action + frustration flag survived the
    # provenance rename
    assert decided == ["customer_frustration"], (
        f"reason must come from plan flags, not provenance: {decided}")
    assert getattr(resp, "handoff_to_admin", False)
    assert getattr(resp, "handoff_reason") == "customer_frustration"
    assert len(handoffs) == 1, f"exactly one transport: {handoffs}"
    # predicates ran inside decide_turn only (planning calls both once) —
    # the transport never re-called them
    assert sorted(pred_calls) == ["is_human_request", "is_service_anger"], pred_calls
    assert fetches == [] and [
        c.get("fn") for c in captured.calls
        if c.get("fn") in ("answer", "answer_general", "answer_with_kb")
    ] == [], "zero product work on handoff-dominant turn"


def test_handoff_reason_human_request_without_frustration_flag(monkeypatch):
    """Pin the sibling contract: handoff action WITHOUT the frustration flag
    → `plan_decided_reason="human_request"` — no provenance read."""
    decided: list = []
    fx = _fx("h4-human", catalog=[
        _pdoc(3101, "FX Powerbank 20000mAh PB200P", cat="พาวเวอร์แบงค์")])
    _client, captured, handoffs = _install(monkeypatch, fx)
    from shopeechat import handoffs as _hf
    _real_dhr = _hf.detect_human_request
    def _spy_dhr(req, ctx, *, plan_decided_reason):
        decided.append(plan_decided_reason)
        return _real_dhr(req, ctx, plan_decided_reason=plan_decided_reason)
    monkeypatch.setattr(_hf, "detect_human_request", _spy_dhr)
    resp = app.chat(app.ChatRequest(
        message="ขอคุยกับแอดมินหน่อยค่ะ",
        shop=SHOP, platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        ticket_state=None, limit=5, simulate_assignment=True,
        test_source="phase2c3_action_switch"))
    assert decided == ["human_request"], decided
    assert getattr(resp, "handoff_reason") == "human_request"
    assert len(handoffs) == 1


# ── incident replay coverage (required focused ids) ─────────────────────────

_FX_BY_ID = {f["id"]: f for f in replay.ALL_FX}


@pytest.mark.parametrize("fid", [
    "tx-q07-pair-continuity", "tx-q08-price-followup", "tx-q09-link-followup",
    "tx-q10-cert-scope", "tx-q12-positive-compat", "tx-q13-positive-link",
    "tx-q15-unlist-anchor", "tx-q18-link-swap",
])
def test_incident_replay_ids(monkeypatch, fid):
    """Focused incident replay under the new action switch."""
    fx = _FX_BY_ID[fid]
    records, captured, client = replay._replay(monkeypatch, fx)
    fails = replay._expectations_met(fx, records, captured)
    replay._gate(fx, fails, level=3)
