"""Round 4 — executable answer-boundary matrix via the real ``app.chat`` path.

Drives both actual llm.answer product-context boundaries (main product_store
path + KB knowledge_base path) through ``app.chat()`` with the incident-replay
harness (``_install`` wires fake DBs + captured llm + offline guards).

Matrix per boundary — 5 cases each:
  flag OFF              → pipeline call count = 0; legacy payload keeps
                          WPB100L name + item_id 3001 + short link
  flag ON + selected    → llm payload = canonical card only (no WPB100L)
  flag ON + empty       → llm payload = []
  flag ON + run→None    → llm payload = []  (fail closed — hidden UNLIST
                          WPB100L cannot re-enter through legacy context)
  flag ON + run raises  → llm payload = []

Path-entry proof: ``resp.source`` — "product_store" for the main path and
"knowledge_base+mongo" for the KB path (existing observables; no production
instrumentation added).
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

# Same env-neutral import posture as test_phase2c3_action_switch.py —
# importing the replay harness sets os.environ defaults; undo the additions.
_env_before_replay_import = dict(os.environ)
import test_legacy_turn_incident_replay as replay  # noqa: E402
from test_legacy_turn_incident_replay import _install, ADMIN_DB  # noqa: E402

for _k in [k for k in os.environ if k not in _env_before_replay_import]:
    del os.environ[_k]
os.environ.update({k: v for k, v in _env_before_replay_import.items()
                   if os.environ.get(k) != v})
del _env_before_replay_import

from shopeechat import app  # noqa: E402
from shopeechat import retrieval_runtime as rr  # noqa: E402


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


SHOP = "KingGadgets"


def _unlist_wpb100l() -> dict:
    """UNLIST-only legacy doc — hidden identity that must never reach LLM."""
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


_CANON_CARD = {
    "item_id": "4001",
    "name": "AC65B FX Charger 65W",
    "model_id": "AC65B",
    "stock": 3,
    "price": 490,
    "sellable": True,
    "publish_state": "published",
    "stock_state": "in_stock",
    "customer_visibility": "visible",
    "requested_variant_state": "not_requested",
}

_KB_DOC = {"_id": "kb-wpb100l", "type": "product_spec", "active": True,
           "brand": "FX", "model": "WPB100L",
           "category": "เครื่องทำน้ำอุ่น",
           "specs": {"wattage": "4500W"}}


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


def _spy_run(monkeypatch, result=None, exc=None) -> dict:
    """Count run_grouped_selection calls and force its outcome."""
    calls = {"n": 0}

    def _fake(*a, **kw):
        calls["n"] += 1
        if exc is not None:
            raise exc
        return result

    monkeypatch.setattr(rr, "run_grouped_selection", _fake)
    return calls


def _typed_sel(cards, msg):
    """REAL grouped artifact dict (selection/pool/requests/summary) via the
    real pipeline with stub fetchers — the typed shape _typed_answer_boundary
    consumes. snap=None: never resolves the generation pointer (offline seam
    — see test_phase4_source_union)."""
    from shopeechat import route_context, turn_decision as _td
    from shopeechat.units import UnitEvidenceFetchResult
    _ir = {"intent": "product_recommend", "confidence": 0.9}
    prof = route_context.build_retrieval_profile(
        msg, history=[], intent_result=_ir, shop=SHOP)
    needs = _td.decide_turn(msg, history=[], intent_result=_ir).needs
    return rr.run_grouped_selection(
        prof, message=msg, shop=SHOP, platform="shopee",
        fetcher=lambda m, **kw: UnitEvidenceFetchResult(
            cards=tuple(cards), raw_count=len(cards),
            sellable_count=sum(
                1 for c in cards if c.get("_available_for_sale")),
            unavailable_count=0, trace=("t",)),
        legacy_fetcher=lambda m, **k: [], needs=needs, snap=None)


def _canon_unit():
    """_CANON_CARD as a units-evidence card (resolver fields stamped — the
    shape selection emits before the compiler scopes it for the LLM)."""
    return {"name": "AC65B FX Charger 65W", "product_type": "charger",
            "charger_subtype": "adapter", "unit_id": "u-ac65b",
            "item_id": "4001", "model_id": "AC65B",
            "model_codes": ["AC65B"], "_available_for_sale": True,
            "status": "NORMAL", "total_stock": 3, "catalog_status": "active",
            "customer_visible": True, "availability_reason": ""}


def _typed_calls(captured) -> list:
    """captured answer-model calls (typed boundary)."""
    return [c for c in captured.calls if c["fn"] == "answer_typed"]


def _answer_calls(captured) -> list:
    """any product-answer model call (legacy answer or typed)."""
    return [c for c in captured.calls
            if c["fn"] in ("answer", "answer_typed")]


def _chat(monkeypatch, fx: dict, message: str):
    """Install seams for fx and run ONE real chat() turn."""
    client, captured, _handoffs = _install(monkeypatch, fx)
    if fx.get("kb"):
        client[ADMIN_DB]["kb_products"].insert_one(_KB_DOC)
    resp = app.chat(app.ChatRequest(
        message=message, shop=fx["shop"], platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        limit=5, simulate_assignment=True,
        test_source="phase3_boundary_r4"))
    return resp, captured


def _payloads(captured) -> list:
    """Every products list any captured llm.* call received."""
    return [c["products"] for c in captured.calls]


def _assert_no_wpb100l(captured):
    for pl in _payloads(captured):
        for p in pl or []:
            assert "WPB100L" not in str(p.get("name", "")), p
            try:
                assert int(float(p.get("item_id") or 0)) != 3001, p
            except (TypeError, ValueError):
                pass
            assert "wpb100l" not in str(p.get("short_link", "")).lower(), p


def _assert_wpb100l_present(captured):
    found = False
    for pl in _payloads(captured):
        for p in pl or []:
            try:
                iid = int(float(p.get("item_id") or 0))
            except (TypeError, ValueError):
                iid = 0
            if "WPB100L" in str(p.get("name", "")) and iid == 3001:
                found = True
    assert found, (f"legacy identity pin failed — WPB100L/3001 not in "
                   f"payload: {_payloads(captured)}")


# ---------------------------------------------------------------------------
# main answer boundary (product_store path)
# ---------------------------------------------------------------------------

MAIN_MSG = "มี WPB100L ไหม"


def test_main_flag_off_legacy_payload_pinned(harness_off, monkeypatch):
    calls = _spy_run(monkeypatch, result={"selected_cards": [_CANON_CARD]})
    resp, captured = _chat(monkeypatch, harness_off, MAIN_MSG)
    assert resp.source == "product_store", resp.source
    assert calls["n"] == 0, "grouped pipeline must not run when flag OFF"
    assert _payloads(captured), "expected ≥1 llm call"
    _assert_wpb100l_present(captured)


def test_main_flag_on_selected_replaces(harness_on, monkeypatch):
    # real typed artifact — boundary must compile → ONE answer_typed call
    # carrying scoped products; legacy llm.answer must not run at all
    calls = _spy_run(monkeypatch,
                     result=_typed_sel([_canon_unit()], MAIN_MSG))
    resp, captured = _chat(monkeypatch, harness_on, MAIN_MSG)
    assert resp.source == "product_store", resp.source
    assert calls["n"] == 1
    typed = _typed_calls(captured)
    assert len(typed) == 1, f"expected ONE answer_typed call: {captured.calls}"
    names = [str(p.get("name", "")) for p in typed[0]["products"]]
    assert any("AC65B" in n for n in names), names
    assert all(c["fn"] != "answer" for c in captured.calls), (
        "legacy llm.answer must not re-enter under flag ON")
    _assert_no_wpb100l(captured)


def test_main_flag_on_empty_sends_empty(harness_on, monkeypatch):
    # empty typed context → deterministic reply, ZERO answer-model calls
    calls = _spy_run(monkeypatch, result=_typed_sel((), MAIN_MSG))
    resp, captured = _chat(monkeypatch, harness_on, MAIN_MSG)
    assert resp.source == "product_store", resp.source
    assert calls["n"] == 1
    assert not _answer_calls(captured), (
        f"empty context must not call the model: {captured.calls}")
    _assert_no_wpb100l(captured)


def test_main_flag_on_none_fails_closed(harness_on, monkeypatch):
    calls = _spy_run(monkeypatch, result=None)
    resp, captured = _chat(monkeypatch, harness_on, MAIN_MSG)
    assert resp.source == "product_store", resp.source
    assert calls["n"] == 1
    assert not _answer_calls(captured), (
        f"None artifacts must not call the model: {captured.calls}")
    _assert_no_wpb100l(captured)


def test_main_flag_on_exception_fails_closed(harness_on, monkeypatch):
    calls = _spy_run(monkeypatch, exc=RuntimeError("pipeline boom"))
    resp, captured = _chat(monkeypatch, harness_on, MAIN_MSG)
    assert resp.source == "product_store", resp.source
    assert calls["n"] == 1
    assert not _answer_calls(captured), (
        f"pipeline failure must not call the model: {captured.calls}")
    _assert_no_wpb100l(captured)


# ---------------------------------------------------------------------------
# KB answer boundary (knowledge_base path — proven by resp.source)
# ---------------------------------------------------------------------------

KB_MSG = "wpb100l สเปค"


def _assert_kb_path(resp):
    assert resp.source.startswith("knowledge_base"), (
        f"KB path not reached — source={resp.source!r}")


def test_kb_flag_off_legacy_payload_pinned(harness_off_kb, monkeypatch):
    calls = _spy_run(monkeypatch, result={"selected_cards": [_CANON_CARD]})
    resp, captured = _chat(monkeypatch, harness_off_kb, KB_MSG)
    _assert_kb_path(resp)
    assert calls["n"] == 0, "grouped pipeline must not run when flag OFF"
    assert _payloads(captured), "expected ≥1 llm call"
    _assert_wpb100l_present(captured)


def test_kb_flag_on_selected_replaces(harness_on_kb, monkeypatch):
    calls = _spy_run(monkeypatch,
                     result=_typed_sel([_canon_unit()], KB_MSG))
    resp, captured = _chat(monkeypatch, harness_on_kb, KB_MSG)
    _assert_kb_path(resp)
    assert calls["n"] == 1
    typed = _typed_calls(captured)
    assert len(typed) == 1, f"expected ONE answer_typed call: {captured.calls}"
    names = [str(p.get("name", "")) for p in typed[0]["products"]]
    assert any("AC65B" in n for n in names), names
    assert all(c["fn"] != "answer" for c in captured.calls), (
        "legacy llm.answer must not re-enter under flag ON")
    _assert_no_wpb100l(captured)


def test_kb_flag_on_empty_sends_empty(harness_on_kb, monkeypatch):
    calls = _spy_run(monkeypatch, result=_typed_sel((), KB_MSG))
    resp, captured = _chat(monkeypatch, harness_on_kb, KB_MSG)
    _assert_kb_path(resp)
    assert calls["n"] == 1
    assert not _answer_calls(captured), (
        f"empty context must not call the model: {captured.calls}")


def test_kb_flag_on_none_fails_closed(harness_on_kb, monkeypatch):
    calls = _spy_run(monkeypatch, result=None)
    resp, captured = _chat(monkeypatch, harness_on_kb, KB_MSG)
    _assert_kb_path(resp)
    assert calls["n"] == 1
    assert not _answer_calls(captured), (
        f"None artifacts must not call the model: {captured.calls}")
    _assert_no_wpb100l(captured)


def test_kb_flag_on_exception_fails_closed(harness_on_kb, monkeypatch):
    calls = _spy_run(monkeypatch, exc=RuntimeError("pipeline boom"))
    resp, captured = _chat(monkeypatch, harness_on_kb, KB_MSG)
    _assert_kb_path(resp)
    assert calls["n"] == 1
    assert not _answer_calls(captured), (
        f"pipeline failure must not call the model: {captured.calls}")
    _assert_no_wpb100l(captured)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def harness_off():
    return _fx("r4-main-off", grouped=False)


@pytest.fixture()
def harness_on():
    return _fx("r4-main-on", grouped=True)


@pytest.fixture()
def harness_off_kb():
    return _fx("r4-kb-off", grouped=False, kb=True)


@pytest.fixture()
def harness_on_kb():
    return _fx("r4-kb-on", grouped=True, kb=True)
