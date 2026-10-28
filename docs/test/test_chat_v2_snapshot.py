"""Phase 10A r5 — chat_v2 request-snapshot ownership.

contract: `chat_v2` resolve request snapshot ครั้งเดียวต่อ request
(standalone → `resolve_snapshot` 1 ครั้ง; explicit → 0 ครั้ง) แล้วส่ง
snapshot เดิมเข้า `_retrieve_products`/`_search_if_needed` — helpers
ต้องรับ snap เป็น parameter (ห้าม free-variable / ห้าม resolve ซ้ำ/
ห้าม global leak)

offline — socket/urlopen/MongoClient ถูกปิด; ทุก boundary stub
"""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import chat_v2 as cv2  # noqa: E402


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


def _ctx():
    return {"limit": 5, "timing": {}, "steps": [],
            "vision_context": None, "vision_usage": {},
            "persona_extra": "", "shop": "S", "total_start": 0.0}


def _req(**kw):
    base = dict(message="มีรุ่นไหนบ้าง", shop="S", platform="shopee",
                conversation_id="c1", item_id=None)
    base.update(kw)
    return SimpleNamespace(**base)


def _stub_pipeline(monkeypatch):
    """stub ทุก stage ยกเว้นตัวที่กำลังทดสอบ — ทำให้ chat_v2 วิ่งจบ
    โดยไม่แตะ DB/provider"""
    monkeypatch.setattr(cv2, "_build_context",
                        lambda req: ({"limit": 5}, [], None, None))
    monkeypatch.setattr(cv2, "_check_deterministic",
                        lambda *a, **k: None)
    monkeypatch.setattr(cv2, "_classify_intent",
                        lambda *a, **k: {"intent": "general"})
    monkeypatch.setattr(cv2, "_detect_anchor", lambda *a, **k: None)
    monkeypatch.setattr(cv2, "_no_product_guard", lambda *a, **k: None)
    monkeypatch.setattr(cv2, "_build_answer",
                        lambda *a, **k: ("ans", {}, 0.0, "m"))
    monkeypatch.setattr(cv2, "_make_response",
                        lambda *a, **k: {"answer": "ans"})
    monkeypatch.setattr(cv2._app_module, "_routing",
                        lambda *a, **k: {})


# ── explicit snapshot flows to the boundary unchanged ────────────────────────

def test_explicit_snapshot_reaches_kb_and_fetch_unchanged(monkeypatch):
    """snap ที่ส่งเข้า `_retrieve_products` ต้องถึง lookup_kb/fetch_products
    เป็น instance เดิม (ไม่ resolve ใหม่ ไม่เปลี่ยนค่า)"""
    seen = {}

    def _kb(msg, snap=None):
        seen["kb"] = snap
        return None

    def _fp(*a, **k):
        seen.setdefault("fp", []).append(k.get("snap"))
        return []

    monkeypatch.setattr(cv2.knowledge_base, "lookup_kb", _kb)
    monkeypatch.setattr(cv2.product_store, "fetch_products", _fp)
    monkeypatch.setattr(cv2, "_detect_followup_products",
                        lambda *a, **k: [])

    sentinel = object()
    cv2._retrieve_products(
        _req(), _ctx(), [], {"intent": "general"}, None, None,
        snap=sentinel)

    assert seen["kb"] is sentinel, (
        "lookup_kb ต้องได้ snap เดิม — free-variable snap = NameError")
    assert seen["fp"] and all(s is sentinel for s in seen["fp"]), (
        "fetch_products ทุก call ต้องได้ snap เดิม")


def test_search_if_needed_passes_snapshot_to_requery(monkeypatch):
    """`_search_if_needed` re-query fetch_products ต้องได้ snap เดิม"""
    seen = {}
    monkeypatch.setattr(cv2._ws, "is_configured", lambda: True)
    monkeypatch.setattr(
        cv2._ws, "search_and_extract",
        lambda **k: {"search_used": True, "keywords": ["w01"],
                     "search_info": "info", "product_type": "",
                     "usage": {}, "cost_usd": 0.0, "elapsed": 0.0,
                     "model": "m"})
    def _fp(*a, **k):
        seen["snap"] = k.get("snap")
        return []

    monkeypatch.setattr(cv2.product_store, "fetch_products", _fp)

    sentinel = object()
    cv2._search_if_needed(
        _req(), _ctx(), [], {"intent": "general"}, [], None,
        snap=sentinel)

    assert seen.get("snap") is sentinel, (
        "re-query ต้องได้ snap เดิม — free-variable snap = NameError")


def test_chat_v2_resolves_snapshot_exactly_once_and_propagates(monkeypatch):
    """standalone chat_v2 → resolve_snapshot 1 ครั้ง และ snapshot นั้น
    ไหลเข้า helper ทั้งสอง; explicit snap → resolve 0 ครั้ง"""
    _stub_pipeline(monkeypatch)
    calls = {"resolve": 0}
    sentinel = object()
    real_resolve = cv2._gen.resolve_snapshot

    def _resolve():
        calls["resolve"] += 1
        return sentinel

    monkeypatch.setattr(cv2._gen, "resolve_snapshot", _resolve)
    got = {}
    monkeypatch.setattr(
        cv2, "_retrieve_products",
        lambda *a, **k: got.setdefault("ret", a[-1]) or [])
    monkeypatch.setattr(
        cv2, "_search_if_needed",
        lambda *a, **k: (got.setdefault("srch", a[-1]),
                         [], "", {"used": False, "reason": ""})[1:])

    cv2.chat_v2(_req())
    assert calls["resolve"] == 1, "standalone ต้อง resolve ครั้งเดียว"
    assert got["ret"] is sentinel and got["srch"] is sentinel, (
        "snapshot ที่ capture ต้องถึง helpers เป็น instance เดิม")

    calls["resolve"] = 0
    got.clear()
    monkeypatch.setattr(cv2._gen, "resolve_snapshot", real_resolve)
    explicit = object()
    cv2.chat_v2(_req(), snap=explicit)
    assert calls["resolve"] == 0, "explicit snap ห้าม resolve ซ้ำ"
    assert got["ret"] is explicit and got["srch"] is explicit


# ── r6 — general-question boundary + r5 owner replacements ─────────────────

def test_general_question_uses_build_general_context_owner(monkeypatch):
    """supported general question → build_general_context(mongo_db=db) →
    context จาก dict ส่งให้ answer_general → response shape เดิม"""
    calls = {}
    monkeypatch.setattr(cv2.knowledge_base, "detect_general_question",
                        lambda m: "shipping_policy")
    monkeypatch.setattr(cv2.knowledge_base, "build_general_context",
                        lambda q, mongo_db=None, shop_filter=None:
                        calls.update(qtype=q, db=mongo_db,
                                     sf=shop_filter)
                        or {"qtype": q, "context": "CTX", "meta": {}})

    def _ag(**k):
        calls["ans_ctx"] = k.get("context")
        return ("ans", {"t": 1})

    monkeypatch.setattr(cv2.llm, "answer_general", _ag)
    monkeypatch.setattr(cv2, "_make_response",
                        lambda a, p, ctx, **k: {"answer": a, "kw": k})
    monkeypatch.setattr(cv2._app_module, "_routing",
                        lambda *a, **k: {})

    db = object()
    resp = cv2._check_general_question(
        _req(shop="S"), _ctx(), [], db)
    assert calls["db"] is db, "mongo_db ต้องเป็น db argument"
    assert calls["qtype"] == "shipping_policy"
    assert calls["ans_ctx"] == "CTX", "ต้องส่ง result['context'] ไม่ใช่ dict"
    assert resp == {"answer": "ans",
                    "kw": {"source": "general:shipping_policy",
                           "usage": {"t": 1}, "routing": {}}}


def test_general_categories_scoped_then_unscoped_once(monkeypatch):
    """categories + shop → scoped call ก่อน; ว่าง → unscoped retry
    ครั้งเดียวเท่านั้น"""
    seen = []
    monkeypatch.setattr(cv2.knowledge_base, "detect_general_question",
                        lambda m: "categories")

    def _bg(q, mongo_db=None, shop_filter=None):
        seen.append(shop_filter)
        return None

    monkeypatch.setattr(cv2.knowledge_base, "build_general_context", _bg)
    monkeypatch.setattr(cv2.llm, "answer_general",
                        lambda **k: (_ for _ in ()).throw(
                            AssertionError("answer_general ห้ามถูกเรียก")))
    resp = cv2._check_general_question(
        _req(shop="MyShop"), _ctx(), [], object())
    assert resp is None
    assert seen == ["MyShop", None], (
        "scoped → unscoped ครั้งเดียว — ห้าม lookup เพิ่ม")


def test_general_policy_qtype_no_shop_filter(monkeypatch):
    """policy qtype → shop_filter=None เสมอ + mongo_db=db"""
    seen = {}
    monkeypatch.setattr(cv2.knowledge_base, "detect_general_question",
                        lambda m: "warranty_policy")
    monkeypatch.setattr(cv2.knowledge_base, "build_general_context",
                        lambda q, mongo_db=None, shop_filter=None:
                        seen.update(db=mongo_db, sf=shop_filter)
                        or {"context": "C", "meta": {}})
    monkeypatch.setattr(cv2.llm, "answer_general",
                        lambda **k: ("ans", {}))
    monkeypatch.setattr(cv2, "_make_response",
                        lambda *a, **k: {"ok": True})
    monkeypatch.setattr(cv2._app_module, "_routing", lambda *a, **k: {})
    db = object()
    cv2._check_general_question(_req(shop="S"), _ctx(), [], db)
    assert seen["sf"] is None, "policy qtype ห้าม scope ร้าน"
    assert seen["db"] is db


def test_general_missing_result_returns_none_no_model(monkeypatch):
    """build_general_context → None / no context → return None +
    answer_general ไม่ถูกเรียก"""
    monkeypatch.setattr(cv2.knowledge_base, "detect_general_question",
                        lambda m: "categories")
    monkeypatch.setattr(cv2.knowledge_base, "build_general_context",
                        lambda *a, **k: None)
    called = {"ag": 0}
    monkeypatch.setattr(cv2.llm, "answer_general",
                        lambda **k: called.__setitem__("ag", 1))
    assert cv2._check_general_question(
        _req(), _ctx(), [], object()) is None
    assert called["ag"] == 0


def test_no_get_general_context_in_executable_source():
    """structural: ไม่มี reference ถึง nonexistent owner เหลือ"""
    import subprocess
    out = subprocess.run(
        ["grep", "-rn", "get_general_context",
         "chatbot/shopeechat/"], capture_output=True, text=True,
        cwd=ROOT)
    live = [l for l in out.stdout.splitlines()
            if ".pyc" not in l and "def build_general_context"
            not in l]
    assert live == [], f"dangling refs: {live}"


def test_detect_anchor_persists_via_add_product_owner(monkeypatch):
    """r5 owner: `_detect_anchor` → conversation_products.add_product
    ครั้งเดียวด้วย typed args (conversation_id/platform/shop/item_id/
    name/source=user_item_card/card/is_anchor=True)"""
    seen = {}

    def _ap(**k):
        seen.update(k)
        return {"ok": True}

    monkeypatch.setattr(cv2._cp, "add_product", _ap)
    monkeypatch.setattr(
        cv2.product_store, "fetch_product_by_id",
        lambda db, item_id, shop_filter=None: {
            "item_id": "123", "name": "W01 watch",
            "description": "", "status": "NORMAL",
            "stock": 5, "sold_out": False})
    req = _req(item_id="123", message="[สินค้า: 123] ตัวนี้")
    anchor = cv2._detect_anchor(req, _ctx(), [], object())
    assert anchor is not None and anchor["item_id"] == "123"
    assert seen["conversation_id"] == "c1"
    assert seen["platform"] == "shopee"
    assert seen["shop"] == "S"
    assert seen["item_id"] == "123"
    assert seen["name"] == "W01 watch"
    assert seen["source"] == "user_item_card"
    assert seen["is_anchor"] is True
    assert seen["card"]["name"] == "W01 watch"


def test_detect_followup_reads_load_timeline_cards(monkeypatch):
    """r5 owner: `_detect_followup_products` → load_timeline(...).products
    → entry['card'] เท่านั้น, dedupe item_id, ≤5 ใบ"""
    entries = [{"item_id": str(i), "card": {"item_id": str(i),
                                           "name": f"P{i}"}}
               for i in range(7)]
    entries[3] = entries[0] | {"card": entries[0]["card"]}  # dup item 0
    seen = {}

    def _lt(conv):
        seen["conv"] = conv
        return {"products": entries}

    monkeypatch.setattr(cv2._cp, "load_timeline", _lt)
    req = _req(message="ราคาเท่าไหร่", conversation_id="c1")
    out = cv2._detect_followup_products(
        req, [{"text": "ก่อนหน้า"}], object())
    assert seen["conv"] == "c1"
    ids = [p["item_id"] for p in out]
    assert len(ids) == len(set(ids)), "ต้อง dedupe item_id"
    assert len(out) <= 5
    # last-5 window = idx 2..6; dup item "0" ที่ idx3 ต้อง collapse
    assert sorted(ids) == ["0", "2", "4", "5", "6"]
    assert all(p["name"].startswith("P") for p in out), \
        "ต้องอ่าน entry['card']"
