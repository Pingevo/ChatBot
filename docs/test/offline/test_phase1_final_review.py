"""Phase 1 final-review corrections F1–F5 — executable contracts.

F1  provider down + greeting/thanks must NOT become a real admin handoff —
    social/ack is a deterministic turn owned by a pure detector shared by
    `turn_decision` and `web_search` (vocabulary moved verbatim, no new words).
F2  chat_v2 must not convert provider exception/malformed result into
    semantic `other` — operational failure parity with legacy `_chat_impl`.
F3  mongo doubles must enforce real Mongo semantics (copy-on-read, known
    operators only, opt-in unique keys, equality-only upsert materialization)
    so tenant tests expose — not hide — production write defects.
F4  timeline write failures (unique collision vs legacy/foreign doc) must be
    observable and must not return fake-success documents to callers.

Offline boundary identical to other docs/test suites (conftest stubs .env /
admin-config reads; _install wires all network/LLM seams).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs" / "test" / "live"))
sys.path.insert(0, str(ROOT / "docs" / "test" / "tools"))

from test_legacy_turn_incident_replay import _install  # noqa: E402
from shopeechat import app, intent_classifier, turn_decision  # noqa: E402


# ── F1 — deterministic social/ack owner ──────────────────────────────────────

_SOCIAL_MSGS = ["สวัสดีค่ะ", "หวัดดีครับ", "ขอบคุณค่ะ", "โอเค", "รับทราบ"]


@pytest.mark.parametrize("msg", _SOCIAL_MSGS)
def test_f1_provider_down_social_turn_is_greeting_not_needs(msg):
    """Provider proposal empty (down) + pure social text → greeting action,
    needs=() — ห้ามไหลเข้า operational handoff gate."""
    plan = turn_decision.decide_turn(msg, intent_result={})
    assert plan.primary_action == "greeting", (
        f"{msg!r} provider down → {plan.primary_action} (ต้อง greeting)")
    assert plan.needs == (), f"{msg!r} ต้องไม่มี need: {plan.needs}"


def test_f1_mixed_social_messages_keep_actionable_owner():
    """social detector ห้ามกลืน actionable need — owner เดิมต้องชนะ."""
    cases = [
        # (message, expected action, expected need-kind ถ้ามี)
        ("ขอบคุณค่ะ ขอ CTC620P", "execute_needs", "product"),
        ("สวัสดีค่ะ มีสายชาร์จไหม", "execute_needs", "product"),
        ("โอเค ส่งวันนี้ไหม", "execute_needs", None),
        ("รับทราบ ขอคุยกับแอดมิน", "handoff", "human"),
        ("ขอบคุณ รุ่นนี้รับประกันกี่ปี", "execute_needs", "policy"),
    ]
    for msg, action, kind in cases:
        plan = turn_decision.decide_turn(msg, intent_result={})
        assert plan.primary_action == action, (
            f"{msg!r} → {plan.primary_action} (ต้อง {action}); "
            f"needs={[(n.kind, n.operation) for n in plan.needs]}")
        if kind is not None:
            assert any(n.kind == kind for n in plan.needs), (
                f"{msg!r} ต้องมี {kind} need: {plan.needs}")


def test_f1_provider_ok_intent_greeting_unchanged():
    """Provider OK + intent=greeting ≥0.7 → greeting เหมือนเดิม."""
    plan = turn_decision.decide_turn(
        "ขอบคุณค่ะ",
        intent_result={"intent": "greeting", "confidence": 0.9})
    assert plan.primary_action == "greeting"
    assert plan.needs == ()


def test_f1_web_search_reuses_social_detector():
    """web_search.should_use_web_search ต้องใช้ detector owner เดียวกัน —
    pure social → skip search; mixed social+ask ห้ามถูกป้าย greeting."""
    from shopeechat import web_search
    mp = MonkeyPatch()
    try:
        mp.setattr(web_search, "is_configured", lambda: True)
        for msg in _SOCIAL_MSGS:
            ok, reason = web_search.should_use_web_search(
                "", message=msg)
            assert (ok, reason) == (False, "greeting_or_thanks"), (
                f"{msg!r} → {(ok, reason)}")
        ok, reason = web_search.should_use_web_search(
            "", message="ขอบคุณค่ะ ขอ CTC620P")
        assert reason != "greeting_or_thanks", (
            "mixed social+product ask ห้าม skip ด้วยเหตุ greeting")
    finally:
        mp.undo()


def test_f1_chat_boundary_provider_down_greeting_no_handoff(monkeypatch):
    """customer boundary: provider raise + ขอบคุณค่ะ → deterministic
    greeting reply — ไม่มี handoff POST, ไม่มี products, ไม่มี error wording."""
    fx = {"id": "p1f1", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "p1f1-c1", "turns": []}
    _client, _cap, handoffs = _install(monkeypatch, fx)

    def _raise(message, history=None, shop=None):
        raise RuntimeError("intent provider down")

    monkeypatch.setattr(intent_classifier, "classify_intent", _raise)
    resp = app.chat(app.ChatRequest(
        message="ขอบคุณค่ะ", shop="TestShop", platform="shopee",
        conversation_id="p1f1-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f"))
    assert handoffs == [], f"social turn ห้ามยิง handoff: {handoffs}"
    assert not getattr(resp, "handoff_to_admin", None), (
        f"handoff_to_admin ต้อง falsy: {resp.handoff_to_admin!r}")
    assert not resp.products, f"social turn ห้ามมี products: {resp.products}"
    assert resp.source == "greeting", f"source ต้อง greeting: {resp.source!r}"
    assert "สวัสดี" in resp.answer, f"answer ต้อง greeting text: {resp.answer!r}"
    assert "แอดมิน" not in resp.answer and "ขัดข้อง" not in resp.answer, (
        f"answer ห้ามใช้ error/handoff wording: {resp.answer!r}")


def test_f1_chat_boundary_provider_down_unresolvable_still_handoffs(
        monkeypatch):
    """provider down + ข้อความที่ deterministic owner ทุกตัวรับไม่ได้
    → operational handoff เดิมยังทำงาน (กัน regression ของ gate เดิม)."""
    fx = {"id": "p1f2", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "p1f2-c1", "turns": []}
    _client, _cap, handoffs = _install(monkeypatch, fx)

    def _raise(message, history=None, shop=None):
        raise RuntimeError("intent provider down")

    monkeypatch.setattr(intent_classifier, "classify_intent", _raise)
    resp = app.chat(app.ChatRequest(
        message="ส่งวันนี้ไหม", shop="TestShop", platform="shopee",
        conversation_id="p1f2-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f"))
    assert handoffs, "provider down + unresolvable ต้อง operational handoff"
    assert resp.handoff_to_admin is True
    assert resp.source == "intent_provider_handoff"


# ── F2 — chat_v2 provider-failure parity ─────────────────────────────────────

def _v2_call(monkeypatch, fx_id: str, msg: str, *,
             fx_extra: dict | None = None, cls_fn=None):
    """Production v2 path: app.chat(use_v2=True) ผ่าน _install harness."""
    fx = {"id": fx_id, "shop": "TestShop", "platform": "shopee",
          "conversation_id": f"{fx_id}-c1", "turns": [],
          **(fx_extra or {})}
    _client, _cap, handoffs = _install(monkeypatch, fx)
    if cls_fn is not None:
        monkeypatch.setattr(intent_classifier, "classify_intent", cls_fn)
    resp = app.chat(app.ChatRequest(
        message=msg, shop="TestShop", platform="shopee",
        conversation_id=f"{fx_id}-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f", use_v2=True))
    return resp, _cap, handoffs


def _provider_raise(message, history=None, shop=None):
    raise RuntimeError("intent provider down")


@pytest.mark.parametrize("msg", ["โอเค รับทราบ", "สวัสดี โอเค"])
def test_f2_v2_provider_raise_social_is_greeting_not_handoff(
        monkeypatch, msg):
    """v2: provider raise + pure social (≥2 tokens → Pass1 ถึง provider
    จริง; token ทุกตัว social → detector ยืนยัน) → deterministic
    greeting — ห้าม operational handoff."""
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-soc", msg, cls_fn=_provider_raise)
    assert handoffs == [], f"v2 social ห้ามยิง handoff: {handoffs}"
    assert not getattr(resp, "handoff_to_admin", None)
    assert resp.source == "greeting", f"source: {resp.source!r}"
    assert "สวัสดี" in resp.answer and "ขัดข้อง" not in resp.answer, (
        f"answer ต้อง greeting ไม่ใช่ error: {resp.answer!r}")
    assert not resp.products


@pytest.mark.parametrize("msg", ["ขอบคุณค่ะ", "สวัสดีครับ"])
def test_f2_v2_provider_raise_one_token_social_is_greeting(
        monkeypatch, msg):
    """v2: 1-whitespace-token social + provider raise → deterministic
    social owner ตอบ greeting (detector ทำงานได้โดยไม่ต้องมี provider)
    — ห้าม no-info/handoff."""
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-skip", msg, cls_fn=_provider_raise)
    assert handoffs == [], f"social ห้าม handoff: {handoffs}"
    assert not getattr(resp, "handoff_to_admin", None)
    assert resp.source == "greeting", (
        f"social ต้อง greeting: {resp.source!r}")


def test_f2_v2_provider_raise_unresolvable_handoffs_shared_contract(
        monkeypatch):
    """v2 parity: provider raise + unresolvable (≥2 tokens → provider
    ถูกเรียกจริง) → operational handoff owner เดียวกับ legacy."""
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-unr", "งง มาก", cls_fn=_provider_raise)
    assert handoffs, "v2 provider down + unresolvable ต้อง operational handoff"
    assert handoffs[0]["reason"] == "intent_provider_failure"
    assert resp.handoff_to_admin is True
    assert resp.source == "intent_provider_handoff"
    assert "ส่งต่อแชทนี้ให้แอดมิน" in resp.answer


def test_f2_v2_provider_called_shipping_intent_used(monkeypatch):
    """v2: "ส่งวันนี้ไหม" (1 whitespace token แต่เป็น actionable sentence)
    → provider ต้องถูกเรียกจริง (whitespace count ไม่ใช่ semantic gate)
    และ shipping_policy จาก intent ต้องถูกใช้ — ห้ามลง no_product_found."""
    _calls = []

    def _ship(message, history=None, shop=None):
        _calls.append(message)
        return {"intent": "general_question",
                "general_qtype": "shipping_policy", "confidence": 0.9}

    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-ship", "ส่งวันนี้ไหม", cls_fn=_ship)
    assert _calls, "intent provider ต้องถูกเรียกสำหรับ non-social Thai text"
    for h in handoffs:
        assert h["reason"] != "no_product_found", (
            f"shipping intent ถูกใช้แล้ว ห้ามลง no_product_found: {handoffs}")
    assert resp.source == "general:shipping_policy", (
        f"general_qtype จาก intent ต้องถูกใช้: source={resp.source!r}")


def test_f2_v2_provider_raise_shipping_operational_parity(monkeypatch):
    """v2: "ส่งวันนี้ไหม" + provider raise → operational failure contract
    เดียวกับ legacy (intent_provider_failure) — ห้ามเป็น no_product_found."""
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-shipr", "ส่งวันนี้ไหม", cls_fn=_provider_raise)
    assert handoffs and handoffs[0]["reason"] == "intent_provider_failure", (
        f"provider down + unresolvable ต้อง operational handoff: {handoffs}")
    assert resp.handoff_to_admin is True
    assert resp.source == "intent_provider_handoff"


def test_f2_v2_provider_raise_human_request_still_handoffs(monkeypatch):
    """v2: deterministic human-request stage ทำงานก่อน intent —
    provider down ห้ามหายไป."""
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-hum", "ขอคุยกับแอดมิน", cls_fn=_provider_raise)
    assert handoffs and handoffs[0]["reason"] == "human_request"
    assert resp.handoff_to_admin is True
    assert resp.source == "human_request_handoff"


def test_f2_v2_provider_raise_item_share_still_returns_product(monkeypatch):
    """v2: explicit item tag + provider down → product need → pipeline
    ต่อ → exact product card (deterministic route ห้ามหาย)."""
    doc = {"item_id": 888001, "item_name": "CTC620P cable",
           "shopname": "TestShop", "price": 390, "item_status": "NORMAL",
           "stock": 5, "cat_name": "สายชาร์จ",
           "brand": {"brand_id": 1, "original_brand_name": "CTC"}}
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-item", "[สินค้า: 888001] ตัวนี้เหลือไหม",
        fx_extra={"catalog": [doc]}, cls_fn=_provider_raise)
    assert handoffs == [], f"item-share ห้าม operational handoff: {handoffs}"
    ids = [str(p.get("item_id")) for p in (resp.products or [])]
    assert "888001" in ids, (
        f"item-share ต้องคืน exact product: {ids} / src={resp.source!r}")


def test_f2_v2_valid_semantic_other_unchanged(monkeypatch):
    """v2: valid provider result intent=other ≠ failure — ห้ามเข้า
    operational handoff; pipeline contract เดิม (no products →
    no_product_found — v2 contract ที่มีอยู่ก่อน F2, ไม่ใช่
    intent_provider_failure)."""
    def _other(message, history=None, shop=None):
        return {"intent": "other", "confidence": 0.9}
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-other", "วันนี้อากาศดีจังเลยนะ", cls_fn=_other)
    for h in handoffs:
        assert h["reason"] != "intent_provider_failure", (
            f"semantic other จริง ห้าม operational failure handoff: {handoffs}")
    assert resp.source != "intent_provider_handoff", (
        f"semantic other ห้าม source เป็น failure path: {resp.source!r}")


def test_f2_v2_malformed_intent_result_is_operational_failure(monkeypatch):
    """v2: provider คืน non-dict (malformed) = operational failure
    เหมือน raise — ห้ามแปลงเป็น semantic other → unresolvable turn
    ต้อง operational handoff ไม่ใช่ no-info."""
    def _garbage(message, history=None, shop=None):
        return "GARBAGE-NOT-A-DICT"
    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f2-mal", "งง มาก", cls_fn=_garbage)
    assert handoffs and handoffs[0]["reason"] == "intent_provider_failure"
    assert resp.handoff_to_admin is True
    assert resp.source == "intent_provider_handoff"


def test_f2_legacy_v2_provider_failure_parity(monkeypatch):
    """legacy ↔ v2 parity: probes เดียวกันต้อง classify เป็น class
    เดียวกัน — social→greeting, unresolvable→operational handoff."""
    probes = [("โอเค รับทราบ", "greeting"), ("งง มาก", "intent_provider_handoff")]
    seen = {}
    for eng in ("legacy", "v2"):
        for j, (msg, want_source) in enumerate(probes):
            fx_id = f"p1f2-par-{eng}-{j}"
            fx = {"id": fx_id, "shop": "TestShop", "platform": "shopee",
                  "conversation_id": f"{fx_id}-c1", "turns": []}
            _client, _cap, handoffs = _install(monkeypatch, fx)
            monkeypatch.setattr(
                intent_classifier, "classify_intent", _provider_raise)
            resp = app.chat(app.ChatRequest(
                message=msg, shop="TestShop", platform="shopee",
                conversation_id=f"{fx_id}-c1", history=[], limit=5,
                simulate_assignment=True, test_source="phase1f",
                use_v2=(eng == "v2")))
            seen[(eng, msg)] = (resp.source, resp.handoff_to_admin,
                                bool(handoffs))
            if want_source == "greeting":
                assert resp.source == "greeting" and not handoffs, (
                    f"{eng} {msg!r} → {resp.source!r} (ต้อง greeting)")
            else:
                assert resp.source == "intent_provider_handoff" and handoffs, (
                    f"{eng} {msg!r} → {resp.source!r} (ต้อง operational "
                    f"handoff)")


# ── C1 — Thai no-space social detection (lexical token owner) ────────────────

_C1_PURE_SOCIAL = [
    "สวัสดีค่ะ", "ขอบคุณครับ", "ขอบคุณนะคะ", "โอเค", "โอเค รับทราบ",
]
_C1_ACTIONABLE_NO_SPACE = [
    "โอเคเช็คออเดอร์ให้หน่อย",
    "รับทราบยกเลิกให้ด้วย",
    "ขอบคุณครับขอราคา",
    "สวัสดีค่ะมีสายชาร์จไหม",
    "โอเคส่งวันนี้ไหม",
]


@pytest.mark.parametrize("msg", _C1_PURE_SOCIAL)
def test_c1_pure_social_detected(msg):
    """pure social (รวม no-space + particle tail) → detector ต้องเป็น True."""
    from shopeechat import message_detectors
    assert message_detectors.detect_social_turn(msg) is True, (
        f"{msg!r} ต้องเป็น social")


@pytest.mark.parametrize("msg", _C1_ACTIONABLE_NO_SPACE)
def test_c1_actionable_no_space_not_social(msg):
    """actionable ภาษาไทยไม่มีช่องว่าง แต่มี social substring กลาง token
    → detector ห้ามตีเป็น social (substring กลาง token ไม่ใช่คำ social)."""
    from shopeechat import message_detectors
    assert message_detectors.detect_social_turn(msg) is False, (
        f"{msg!r} ห้ามถูกตีเป็น social")


@pytest.mark.parametrize("msg", _C1_ACTIONABLE_NO_SPACE)
def test_c1_plan_level_actionable_owner_wins(msg):
    """decide_turn: actionable no-space ห้ามไหลเข้า greeting action —
    typed owner (execute_needs/clarify/handoff) ต้องชนะ."""
    plan = turn_decision.decide_turn(msg, intent_result={})
    assert plan.primary_action != "greeting", (
        f"{msg!r} ห้ามเป็น greeting: {plan.primary_action}")


@pytest.mark.parametrize("msg", ["โอเคเช็คออเดอร์ให้หน่อย",
                                 "รับทราบยกเลิกให้ด้วย"])
def test_c1_chat_boundary_no_greeting_for_actionable(monkeypatch, msg):
    """customer boundary (legacy): provider down + actionable no-space
    → ห้ามตอบ greeting; outcome = operational handoff (unresolvable)
    หรือ typed owner อื่น — ห้าม swallow เป็น social."""
    fx = {"id": f"c1-{msg[:6]}", "shop": "TestShop", "platform": "shopee",
          "conversation_id": f"c1-{msg[:6]}-c", "turns": []}
    _client, _cap, handoffs = _install(monkeypatch, fx)
    monkeypatch.setattr(intent_classifier, "classify_intent", _provider_raise)
    resp = app.chat(app.ChatRequest(
        message=msg, shop="TestShop", platform="shopee",
        conversation_id=f"c1-{msg[:6]}-c", history=[], limit=5,
        simulate_assignment=True, test_source="phase1c"))
    assert resp.source != "greeting", (
        f"{msg!r} actionable ห้ามตอบ greeting: source={resp.source!r} "
        f"answer={resp.answer!r}")


def test_c1_pure_social_still_greeting_at_boundary(monkeypatch):
    """regression guard: pure social ยังตอบ greeting (provider down)."""
    fx = {"id": "c1-soc", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "c1-soc-c", "turns": []}
    _client, _cap, handoffs = _install(monkeypatch, fx)
    monkeypatch.setattr(intent_classifier, "classify_intent", _provider_raise)
    resp = app.chat(app.ChatRequest(
        message="ขอบคุณนะคะ", shop="TestShop", platform="shopee",
        conversation_id="c1-soc-c", history=[], limit=5,
        simulate_assignment=True, test_source="phase1c"))
    assert resp.source == "greeting" and handoffs == []


# ── F3 — mongo doubles fidelity ──────────────────────────────────────────────

def test_f3_find_one_returns_copy_not_stored_doc():
    """copy-on-read: mutate returned doc (ไม่ call update) → stored doc
    ต้องไม่เปลี่ยน — เดิม find_one คืน object เดียวกับ store ปิดบัง
    mutation-defects."""
    from mongo_doubles import FakeColl
    coll = FakeColl([{"conversation_id": "c1", "nested": {"x": [1]}}])
    got = coll.find_one({"conversation_id": "c1"})
    got["nested"]["x"].append(2)
    got["new_field"] = True
    assert coll._docs[0] == {"conversation_id": "c1", "nested": {"x": [1]}}, (
        "mutation ผ่าน read result ห้ามเปลี่ยน stored doc")


def test_f3_find_and_insert_one_copy_boundaries():
    """find() cursor + insert_one store: ทั้งสองด้านต้องเป็น copy —
    caller แก้ seed/result ห้ามไหลเข้า store หรือกลับกัน."""
    from mongo_doubles import FakeColl
    seed = {"tags": ["a"], "v": 1}
    coll = FakeColl([seed])
    seed["tags"].append("injected")  # caller mutates seed หลังส่งเข้า fake
    assert coll._docs[0]["tags"] == ["a"], "seed mutation ห้ามเข้า store"
    out = coll.find({"v": 1})[0]
    out["tags"].append("leak")
    assert coll._docs[0]["tags"] == ["a"], "find result mutation ห้ามเข้า store"
    doc = {"arr": {"deep": []}}
    coll.insert_one(doc)
    doc["arr"]["deep"].append(9)
    assert coll._docs[-1] == {"arr": {"deep": []}}, (
        "insert_one ต้อง deepcopy — shallow copy ปล่อย nested alias")


def test_f3_exists_operator_is_field_presence_not_value():
    """$exists = field presence (Mongo จริง) — field ที่มีค่า None
    ยังนับว่า 'มี field' — เดิมเช็ค value ทำให้ a=None ผิดเป็น absent."""
    from mongo_doubles import FakeColl
    coll = FakeColl([{"a": None, "id": 1}, {"id": 2}, {"a": 0, "id": 3}])
    assert sorted(d["id"] for d in coll.find({"a": {"$exists": True}})) \
        == [1, 3]
    assert sorted(d["id"] for d in coll.find({"a": {"$exists": False}})) \
        == [2]


def test_f3_unknown_operator_raises_never_silent_match():
    """operator ที่ไม่รองรับ ต้อง raise (Mongo: OperationFailure code 2) —
    เดิม dict cond ที่ไม่มี op รู้จัก → unconditional match ปิดบัง defects."""
    from mongo_doubles import FakeColl
    coll = FakeColl([{"x": 1}])
    with pytest.raises(Exception, match="unknown operator"):
        coll.find_one({"x": {"$gt": 5}})
    with pytest.raises(Exception, match="unknown operator"):
        coll.find_one({"$elemMatch": {"y": 1}})


def test_f3_unique_key_insert_collision_raises_duplicate_key():
    """opt-in unique key (config เฉพาะ collection) — insert_one ชน
    conversation_id ต้อง raise DuplicateKey-compatible — ห้าม duplicate
    เงียบ (timeline มี unique index จริงใน production)."""
    from mongo_doubles import FakeColl
    coll = FakeColl([{"conversation_id": "c1", "v": 1}],
                    unique_keys=("conversation_id",))
    with pytest.raises(Exception) as ei:
        coll.insert_one({"conversation_id": "c1", "v": 2})
    assert "DuplicateKey" in type(ei.value).__name__, (
        f"ต้องเป็น duplicate-key-compatible error: {type(ei.value)}")
    # collection อื่นที่ไม่เปิด unique → duplicates ยังอนุญาต
    other = FakeColl([{"conversation_id": "c1"}])
    other.insert_one({"conversation_id": "c1"})
    assert len(other._docs) == 2


def test_f3_scoped_upsert_on_legacy_doc_raises_not_silent_dup():
    """F4 pre-condition: scoped upsert ชน legacy doc (conv_id เดียวกันแต่
    ไม่มี platform/shop) → ไม่ match → insert → unique collision →
    E11000 — ห้ามสร้าง duplicate เงียบ (Mongo จริง raise)."""
    from mongo_doubles import FakeColl
    coll = FakeColl(
        [{"conversation_id": "c1", "products": []}],  # legacy unscoped
        unique_keys=("conversation_id",))
    with pytest.raises(Exception) as ei:
        coll.update_one(
            {"conversation_id": "c1", "platform": "shopee", "shop": "S"},
            {"$set": {"products": [{"item_id": "1"}]}},
            upsert=True)
    assert "DuplicateKey" in type(ei.value).__name__
    assert len(coll._docs) == 1, "collision ต้องไม่สร้าง duplicate doc"


def test_f3_failed_update_collision_leaves_doc_unmutated():
    """update_one ชน unique → raise + doc ต้องไม่ถูก mutate (real Mongo
    atomic per doc — เดิม _apply บน stored doc ก่อน _check_unique ทำให้
    failed write ยังเขียนทับค่าจริง)."""
    from mongo_doubles import FakeColl
    from pymongo.errors import DuplicateKeyError
    coll = FakeColl([{"id": 1, "u": "a"}, {"id": 2, "u": "b"}],
                    unique_keys=("u",))
    with pytest.raises(DuplicateKeyError):
        coll.update_one({"id": 1}, {"$set": {"u": "b"}})
    assert coll.find_one({"id": 1}) == {"id": 1, "u": "a"}, (
        "failed update ต้องไม่ mutate stored doc")
    # successful update ยัง commit candidate ปกติ
    coll.update_one({"id": 1}, {"$set": {"u": "c", "x": 9}})
    assert coll.find_one({"id": 1}) == {"id": 1, "u": "c", "x": 9}


def test_f3_update_many_collision_keeps_colliding_doc():
    """update_many: doc ที่ชน unique ต้องไม่ถูก mutate — real Mongo abort
    ที่ doc นั้นโดยไม่ rollback docs ก่อนหน้า."""
    from mongo_doubles import FakeColl
    from pymongo.errors import DuplicateKeyError
    coll = FakeColl([{"id": 1, "u": "a", "g": 1},
                     {"id": 2, "u": "b", "g": 1}], unique_keys=("u",))
    with pytest.raises(DuplicateKeyError):
        coll.update_many({"g": 1}, {"$set": {"u": "b"}})
    assert coll.find_one({"id": 1})["u"] == "a", "colliding doc ห้าม mutate"
    assert coll.find_one({"id": 2})["u"] == "b"


def test_f3_bulk_write_collision_leaves_doc_unmutated():
    """GenColl.bulk_write (UpdateOne matched) ชน unique → raise —
    stored doc ต้องไม่ถูก mutate."""
    from mongo_doubles import GenColl
    from pymongo import UpdateOne
    from pymongo.errors import DuplicateKeyError
    coll = GenColl([{"_id": "x", "u": "a"}, {"_id": "y", "u": "b"}],
                   unique_keys=("u",))
    with pytest.raises(DuplicateKeyError):
        coll.bulk_write([UpdateOne({"_id": "x"}, {"$set": {"u": "b"}})])
    assert coll.find_one({"_id": "x"}) == {"_id": "x", "u": "a"}, (
        "failed bulk update ต้องไม่ mutate stored doc")


def test_f3_update_set_id_immutable_no_mutation():
    """$set _id → immutable-field error (real Mongo code 66) + doc เดิม
    ต้องอยู่ครบ — validate _id ก่อน commit candidate."""
    from mongo_doubles import FakeColl
    coll = FakeColl([{"_id": "a", "v": 1}])
    with pytest.raises(Exception, match="immutable"):
        coll.update_one({"_id": "a"}, {"$set": {"_id": "b"}})
    assert coll.find_one({"_id": "a"}) == {"_id": "a", "v": 1}
    assert coll.find_one({"_id": "b"}) is None


def test_f3_upsert_materializes_equality_predicates_only():
    """upsert insert doc = equality predicates เท่านั้น — operator dict
    เช่น {"platform": {"$in": [...]}} เป็น query predicate ห้าม copy เข้า
    document เป็น literal field (Mongo semantics)."""
    from mongo_doubles import FakeColl
    coll = FakeColl()
    coll.update_one(
        {"conversation_id": "c1", "platform": {"$in": ["shopee", None]}},
        {"$set": {"x": 1}}, upsert=True)
    assert coll._docs[0] == {"conversation_id": "c1", "x": 1}, (
        f"operator predicate ห้าม materialize: {coll._docs[0]}")


# ── F4 — timeline write failure observability ────────────────────────────────

def _tl_fake_coll(monkeypatch, docs):
    """conversation_products FakeColl + unique {conversation_id:1} —
    production index ที่ real Mongo enforce จริง (opt-in config)."""
    from mongo_doubles import FakeColl
    from shopeechat import conversation_products as _cp
    coll = FakeColl(docs, unique_keys=("conversation_id",))
    monkeypatch.setattr(_cp, "_coll", lambda: coll)
    return _cp, coll


def test_f4_scoped_save_timeline_on_legacy_doc_fails_closed(monkeypatch,
                                                            capsys):
    """scoped write ชน legacy doc (conv_id เดียวกัน ไม่มี scope) → E11000
    → False + sanitized log — ห้ามดูเหมือนสำเร็จ/ห้ามทับ legacy."""
    _cp, coll = _tl_fake_coll(
        monkeypatch, [{"conversation_id": "c-f4", "products": [{"item_id": "old"}]}])
    ok = _cp.save_timeline("c-f4", "shopee", "TestShop",
                           [{"item_id": "new"}], "new")
    assert ok is False, "unique collision ต้อง report False"
    assert coll._docs[0] == {
        "conversation_id": "c-f4", "products": [{"item_id": "old"}]}, (
        "legacy doc ห้ามถูก stamp/touch: %r" % coll._docs[0])
    out = capsys.readouterr()
    assert "[CONV-PRODUCTS]" in out.err and "save_timeline" in out.err


def test_f4_scoped_write_on_foreign_tenant_doc_fails(monkeypatch):
    """scoped write ชน foreign tenant doc (conv_id เดียวกัน scope ต่าง)
    → E11000 → False — doc ร้านอื่นต้องไม่เปลี่ยน."""
    _cp, coll = _tl_fake_coll(
        monkeypatch, [{"conversation_id": "c-f4", "platform": "tiktok",
                       "shop": "OtherShop", "products": []}])
    ok = _cp.save_timeline("c-f4", "shopee", "TestShop",
                           [{"item_id": "x"}], "x")
    assert ok is False
    assert coll._docs[0]["platform"] == "tiktok" and not coll._docs[0]["products"]


def test_f4_add_product_no_fake_success_on_collision(monkeypatch):
    """add_product scoped บน legacy doc → write ล้ม → ห้ามคืน mutated
    in-memory doc เหมือน persist สำเร็จ."""
    _cp, coll = _tl_fake_coll(
        monkeypatch, [{"conversation_id": "c-f4", "products": []}])
    out = _cp.add_product("c-f4", "shopee", "TestShop",
                          item_id="777", name="P", source="user_item_card")
    assert out is None, f"write fail ต้องคืน None ไม่ใช่ doc: {out!r}"
    assert len(coll._docs) == 1  # foreign/legacy untouched


def test_f4_add_order_anchor_no_fake_success_on_collision(monkeypatch,
                                                          capsys):
    """add_order_anchor scoped บน legacy doc → E11000 → None + log —
    ห้ามคืน doc เหมือน persist."""
    _cp, coll = _tl_fake_coll(
        monkeypatch, [{"conversation_id": "c-f4", "products": []}])
    out = _cp.add_order_anchor("c-f4", "shopee", "TestShop", "SN-1")
    assert out is None, f"order anchor write fail ต้อง None: {out!r}"
    assert coll._docs[0].get("order_anchors") is None, (
        "legacy doc ห้ามได้ order_anchors")
    assert "add_order_anchor" in capsys.readouterr().err


def test_f4_claim_transition_on_foreign_doc_never_reports_commit(
        monkeypatch):
    """claim CAS scoped บน foreign doc → fence miss → insert ชน E11000 →
    reread scoped ไม่เจอ → None — ห้าม report committed state."""
    _cp, coll = _tl_fake_coll(
        monkeypatch, [{"conversation_id": "c-f4", "platform": "tiktok",
                       "shop": "OtherShop",
                       "claim_state": {"episode_id": "ep-x", "stage": "open"}}])
    out = _cp.transition_claim_state(
        "c-f4", "shopee", "TestShop", expected_episode_id=None,
        expected_stage=None,
        claim_state={"episode_id": "ep-new", "stage": "collecting"})
    assert out is None, (
        f"foreign doc + scoped write ต้อง fail closed: {out!r}")
    assert coll._docs[0]["claim_state"]["episode_id"] == "ep-x", (
        "foreign claim_state ห้ามถูกเขียนทับ")


def test_f4_successful_scoped_write_returns_true(monkeypatch):
    """scoped write ปกติ (empty coll) → upsert สำเร็จ → True."""
    _cp, coll = _tl_fake_coll(monkeypatch, [])
    assert _cp.save_timeline("c-f4", "shopee", "TestShop",
                             [{"item_id": "1"}], "1") is True
    assert coll._docs[0]["platform"] == "shopee"


def test_f4_write_failure_log_sanitized_once_no_pii(monkeypatch, capsys):
    """log write failure: เกิดครั้งเดียวต่อ op, ไม่มี raw conversation_id /
    customer message / PII — มีเฉพาะ op + scope + error class."""
    _cp, coll = _tl_fake_coll(
        monkeypatch, [{"conversation_id": "SECRET-CONV-001", "products": []}])
    _cp.save_timeline("SECRET-CONV-001", "shopee", "TestShop", [], None)
    err = capsys.readouterr().err
    lines = [l for l in err.splitlines() if "[CONV-PRODUCTS]" in l]
    assert len(lines) == 1, f"ต้อง log ครั้งเดียว: {lines}"
    assert "SECRET-CONV-001" not in lines[0], "log ห้ามมี raw conv id"
    for pii in ("สมชาย", "081", "ที่อยู่"):
        assert pii not in lines[0]
    assert "err=" in lines[0] and "DuplicateKeyError" in lines[0]


# ── F5 — caller write-truth: log/count เฉพาะ write ที่ persist จริง ────────

def test_f5_order_anchor_count_ignores_failed_add_product(
        monkeypatch, capsys):
    """order_flow item anchor: add_product คืน None (write ล้ม) →
    _anchored_count ห้ามนับ → ห้าม log 'anchored N order items' เหมือน
    persist สำเร็จ."""
    from shopeechat import conversation_products as _cp
    fx = {"id": "p1f5", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "p1f5-c1", "turns": [],
          "orders": [{"order_sn": "SN-T5", "order_status": "completed",
                      "item_count": 1,
                      "items": [{"item_id": "it-9", "name": "Cable",
                                 "price": 10}]}]}
    _client, _cap, _h = _install(monkeypatch, fx)
    monkeypatch.setattr(_cp, "add_product", lambda *a, **k: None)
    app.chat(app.ChatRequest(
        message="[คำสั่งซื้อ: SN-T5]", shop="TestShop", platform="shopee",
        conversation_id="p1f5-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f"))
    err = capsys.readouterr().err
    assert "[ORDER-ANCHOR] anchored" not in err, (
        f"write ล้มทั้งหมด ห้าม log ว่า anchored: "
        f"{[l for l in err.splitlines() if 'ANCHOR' in l]}")


def test_f5_order_anchor_count_reflects_successful_writes(
        monkeypatch, capsys):
    """add_product คืน doc (persist สำเร็จ) → count ต้องนับ + log anchored
    — caller เดิมยังรายงาน write ที่สำเร็จ."""
    from shopeechat import conversation_products as _cp
    fx = {"id": "p1f5s", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "p1f5s-c1", "turns": [],
          "orders": [{"order_sn": "SN-T5", "order_status": "completed",
                      "item_count": 1,
                      "items": [{"item_id": "it-9", "name": "Cable",
                                 "price": 10}]}]}
    _client, _cap, _h = _install(monkeypatch, fx)
    monkeypatch.setattr(_cp, "add_product",
                        lambda *a, **k: {"item_id": k.get("item_id")})
    app.chat(app.ChatRequest(
        message="[คำสั่งซื้อ: SN-T5]", shop="TestShop", platform="shopee",
        conversation_id="p1f5s-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f"))
    err = capsys.readouterr().err
    assert "[ORDER-ANCHOR] anchored 1 order items" in err, (
        f"write สำเร็จ 1 ชิ้น ต้อง log: "
        f"{[l for l in err.splitlines() if 'ANCHOR' in l]}")


def test_f5_item_tag_anchor_log_distinguishes_write_failure(
        monkeypatch, capsys):
    """app item-tag anchor: add_product คืน None → ห้าม log 'anchor added'
    เหมือน persist — caller ต้อง distinguish success/failure."""
    from shopeechat import conversation_products as _cp
    fx = {"id": "p1f5b", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "p1f5b-c1", "turns": [],
          "catalog": [{"item_id": 1001, "item_name": "Cable 100W",
                       "shopname": "TestShop", "price": 199,
                       "item_status": "NORMAL", "stock": 5,
                       "cat_name": "สายชาร์จ",
                       "brand": {"brand_id": 1,
                                 "original_brand_name": "CTC"}}]}
    _client, _cap, _h = _install(monkeypatch, fx)
    monkeypatch.setattr(_cp, "add_product", lambda *a, **k: None)
    app.chat(app.ChatRequest(
        message="[สินค้า: 1001] ตัวนี้เหลือไหม", shop="TestShop", platform="shopee",
        conversation_id="p1f5b-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f"))
    err = capsys.readouterr().err
    assert "anchor added" not in err, (
        f"write ล้ม ห้าม log 'anchor added': "
        f"{[l for l in err.splitlines() if 'anchor' in l.lower()]}")


def test_f5_return_refund_anchor_log_distinguishes_failure(
        monkeypatch, capsys):
    """return/refund path: item anchor writes ล้ม → ห้าม log 'anchored
    order items' เหมือน persist."""
    from shopeechat import conversation_products as _cp
    fx = {"id": "p1f5r", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "p1f5r-c1", "turns": [],
          "orders": [{"order_sn": "SN-T5", "order_status": "completed",
                      "item_count": 1,
                      "items": [{"item_id": "it-9", "name": "Cable",
                                 "price": 10}]}]}
    _client, _cap, _h = _install(monkeypatch, fx)
    monkeypatch.setattr(_cp, "add_product", lambda *a, **k: None)
    app.chat(app.ChatRequest(
        message="ขอคืนเงิน [คำสั่งซื้อ: SN-T5]", shop="TestShop",
        platform="shopee", conversation_id="p1f5r-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f"))
    err = capsys.readouterr().err
    assert "anchored order items" not in err, (
        f"write ล้ม ห้าม log 'anchored order items': "
        f"{[l for l in err.splitlines() if 'anchor' in l.lower()]}")


# ── F6 — responses self-contained: provider-failure handoff seam ────────────

def test_f6_provider_failure_handoff_uses_local_send_seam(monkeypatch):
    """intent_provider_failure_handoff ต้องเรียก _send_handoff ใน module
    เดียวกัน (canonical seam ที่ tests patch) — ไม่ใช่ import app →
    app._send_handoff (cycle responses→app→responses)."""
    from types import SimpleNamespace
    from shopeechat import responses as _resp
    calls = []

    def _fake(req, ctx=None, *, reason="", **kw):
        calls.append({"reason": reason})
        return {"outcome": {"state": "assigned"}}

    monkeypatch.setattr(_resp, "_send_handoff", _fake)
    req = SimpleNamespace(conversation_id="c-f6", shop="S",
                          platform="shopee", message="m", history=[])
    out = _resp.intent_provider_failure_handoff(req)
    assert calls and calls[0]["reason"] == "intent_provider_failure", (
        f"canonical responses._send_handoff ต้องถูกเรียก: {calls}")
    assert out["handoff_reason"] == "intent_provider_failure"
    assert "ส่งต่อ" in out["answer"]


def test_f6_provider_failure_handoff_outcome_wording(monkeypatch):
    """outcome-sensitive wording: assigned→ส่งแล้ว / queued→เข้าคิว /
    ไม่ยืนยัน→HANDOFF_FAILED_REPLY — contract เดิมต้องคงอยู่."""
    from types import SimpleNamespace
    from shopeechat import responses as _resp
    req = SimpleNamespace(conversation_id="c-f6w", shop="S",
                          platform="shopee", message="m", history=[])
    for state, frag in (("assigned", "ส่งต่อแชทนี้ให้แอดมินแล้ว"),
                        ("queued", "เข้าคิวให้แอดมินแล้ว")):
        monkeypatch.setattr(_resp, "_send_handoff",
                            lambda *a, **k: {"outcome": {"state": state}})
        out = _resp.intent_provider_failure_handoff(req)
        assert frag in out["answer"], f"{state} → {out['answer']!r}"
    monkeypatch.setattr(_resp, "_send_handoff", lambda *a, **k: None)
    out = _resp.intent_provider_failure_handoff(req)
    assert out["answer"] == _resp.HANDOFF_FAILED_REPLY
    assert out["handoff_ok"] is False and out["handoff_reason"] == ""


# ── F7 — pure social ห้ามเรียก intent provider (V2 latency/cost parity) ─────

_V2_PURE_SOCIAL = ["สวัสดีค่ะ", "ขอบคุณนะคะ", "โอเค", "โอเค รับทราบ"]


@pytest.mark.parametrize("msg", _V2_PURE_SOCIAL)
def test_f7_v2_pure_social_never_calls_intent_provider(monkeypatch, msg):
    """v2: pure social → detect_social_turn ตัดก่อน provider —
    intent provider calls=0 (token/cost/latency=0) → deterministic
    greeting owner ตอบ — ไม่มี failure surface จาก provider."""
    resp, cap, handoffs = _v2_call(monkeypatch, "p1f7-soc", msg)
    assert len(cap.intent_calls) == 0, (
        f"{msg!r} pure social ห้ามเรียก provider: {cap.intent_calls}")
    assert handoffs == [], f"pure social ห้าม handoff: {handoffs}"
    assert not getattr(resp, "handoff_to_admin", None)
    assert resp.source == "greeting", (
        f"source ต้อง greeting: {resp.source!r}")
    assert not resp.products, (
        f"pure social ห้ามมี products: {resp.products}")


@pytest.mark.parametrize("msg", [
    "โอเคเช็คออเดอร์ให้หน่อย",
    "รับทราบยกเลิกให้ด้วย",
    "ขอบคุณครับขอราคา",
    "สวัสดีค่ะมีสายชาร์จไหม",
    "โอเคส่งวันนี้ไหม",
])
def test_f7_v2_actionable_no_space_still_calls_intent_provider(
        monkeypatch, msg):
    """v2: actionable no-space (Thai sentence = 1 whitespace token)
    → detect_social_turn=False → provider ต้องถูกเรียกจริง —
    ห้ามกลืนเป็น greeting."""
    resp, cap, _h = _v2_call(
        monkeypatch, "p1f7-act", msg,
        fx_extra={"intent_result": {"intent": "other",
                                    "confidence": 0.5}})
    assert len(cap.intent_calls) == 1, (
        f"{msg!r} actionable ต้องเรียก provider: {cap.intent_calls}")
    assert resp.source != "greeting", (
        f"{msg!r} ห้ามกลายเป็น greeting: {resp.source!r}")


def test_f7_v2_provider_down_actionable_not_swallowed(monkeypatch):
    """v2: actionable no-space + provider raise → provider ถูกเรียกจริง
    → operational intent_provider_failure (decide_turn needs=() —
    ห้าม greeting ห้าม no_product_found)."""
    _calls = []

    def _raise(message, history=None, shop=None):
        _calls.append(message)
        raise RuntimeError("intent provider down")

    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f7-down", "โอเคเช็คออเดอร์ให้หน่อย", cls_fn=_raise)
    assert _calls, "actionable ต้องเรียก provider แม้ provider ล้ม"
    assert resp.source != "greeting", (
        f"actionable ห้ามกลืนเป็น greeting: {resp.source!r}")
    assert handoffs and handoffs[0]["reason"] == "intent_provider_failure", (
        f"provider down + actionable ต้อง operational handoff: {handoffs}")
    for h in handoffs:
        assert h["reason"] != "no_product_found", (
            f"provider down ห้ามลง no_product_found: {handoffs}")


# ── F8 — product-type token boundary + original provider-down acceptance ──
# root cause: _detect_product_types ใช้ `kw in low` — "เคส" match ข้าม token
# boundary ใน "โอเค|ส่ง" → false case → product/describe need → provider-down
# ลง no_product_found แทน intent_provider_failure (worker รอบก่อนเปลี่ยน
# acceptance input ไปเป็น โอเคเช็คออเดอร์ให้หน่อย — block นี้คืน exact message)


@pytest.mark.parametrize("msg", [
    "โอเคส่งวันนี้ไหม",
    "โอเคเช็คออเดอร์ให้หน่อย",
    "รับทราบยกเลิกให้ด้วย",
    "ขอบคุณครับขอราคา",
])
def test_f8_product_type_detector_no_cross_token_boundary(msg):
    """kw ต้อง match เป็น lexical token/contiguous sequence เท่านั้น —
    'เคส' ใน 'โอเค|ส่ง' ข้าม boundary → ห้าม product type."""
    from shopeechat import product_store
    assert product_store._detect_product_types(msg) == set(), (
        f"{msg!r} ต้องไม่มี product type (boundary crossing): "
        f"{product_store._detect_product_types(msg)}")


@pytest.mark.parametrize("msg", [
    "มีเคสไหม",
    "มีเคสโทรศัพท์ไหม",
    "ขอเคส iphone 15",
    "case iphone 15",
])
def test_f8_product_type_detector_keeps_real_case_mentions(msg):
    """positive control — case ที่เป็น token จริง/English token ต้อง match."""
    from shopeechat import product_store
    assert "case" in product_store._detect_product_types(msg), (
        f"{msg!r} ต้อง detect case: {product_store._detect_product_types(msg)}")


def test_f8_product_type_detector_multi_type():
    """multi-type control — เคส + ฟิล์ม ทั้งคู่เป็น token."""
    from shopeechat import product_store
    result = product_store._detect_product_types("ขอเคสกับฟิล์ม")
    assert "case" in result and "screen_protector" in result, result


def test_f8_v2_provider_down_ok_shipping_today_never_no_product_found(
        monkeypatch):
    """EXACT original acceptance (worker รอบก่อนเปลี่ยน input แล้วประกาศผ่าน):
    'โอเคส่งวันนี้ไหม' + provider raise → provider ถูกเรียก → detect ไม่มี
    false product need → operational intent_provider_failure —
    ห้าม greeting ห้าม no_product_found."""
    _calls = []

    def _raise(message, history=None, shop=None):
        _calls.append(message)
        raise RuntimeError("intent provider down")

    resp, _cap, handoffs = _v2_call(
        monkeypatch, "p1f8-ship", "โอเคส่งวันนี้ไหม", cls_fn=_raise)
    assert _calls == ["โอเคส่งวันนี้ไหม"], (
        f"provider ต้องถูกเรียก exact message: {_calls}")
    assert resp.source != "greeting", (
        f"actionable ห้ามกลืนเป็น greeting: {resp.source!r}")
    assert resp.source == "intent_provider_handoff", (
        f"source ต้อง intent_provider_handoff: {resp.source!r}")
    assert handoffs and handoffs[0]["reason"] == "intent_provider_failure", (
        f"provider down ต้อง operational handoff: {handoffs}")
    assert all(h["reason"] != "no_product_found" for h in handoffs), (
        f"provider down ห้ามลง no_product_found: {handoffs}")
    assert not resp.products, f"provider down ห้ามมี products: {resp.products}"


# ── F9 — regex บนข้อความต้นฉบับ + match span ต้องเริ่มที่ token boundary ──
# regression จาก F8 fix: regex ยิงบน " ".join(_seg) → PyThaiNLP แยก
# letter+digit ("galaxy s24"→[galaxy,s,24]) ทำ `galaxy s24`/`a55` หาย —
# regex ต้องยิงบน low เดิม แล้ว accept เมื่อ match.start() ตรง boundary
# (start กลาง token = glued head ข้าม boundary เช่น "เคส" ใน "โอเค|ส่ง";
# end กลาง token เมื่อ start ตรง = matched prefix ของ token สุดท้าย
# เช่น "s24"→"s2" ซึ่ง regex ออกแบบให้จับแบบนั้นอยู่แล้ว)


@pytest.mark.parametrize(("message", "expected"), [
    ("galaxy s24 ultra", "phone"),
    ("galaxy a55", "phone"),
    ("redmi 8a", "phone"),
    ("iphone15promax", "phone"),
    ("black shark 5", "phone"),
])
def test_f9_product_type_regex_preserves_alphanumeric_model_codes(
        message, expected):
    """regex model-code เดิมต้องทำงานบนข้อความต้นฉบับเหมือน HEAD —
    letter+digit ที่ tokenizer แยกห้ามทำ regex พัง."""
    from shopeechat import product_store
    assert expected in product_store._detect_product_types(message), (
        f"{message!r} ต้อง detect {expected}: "
        f"{product_store._detect_product_types(message)}")


def test_f9_xiaomi14t_glued_form_authorized_as_phone():
    """'xiaomi14t' — เดิม pin HEAD contract = set() (A-257; `xiaomi\\s+`
    ต้องการ whitespace, ให้ phone ได้ต้องอนุมัติแก้ PRODUCT_TYPES แยก)
    — user อนุมัติ semantic expansion เฉพาะ Xiaomi alternative แล้ว
    → compact code ต้อง resolve เป็น phone (suite เต็มใน F10)."""
    from shopeechat import product_store
    result = product_store._detect_product_types("xiaomi14t")
    assert "phone" in result, result


@pytest.mark.parametrize("message", [
    "โอเคส่งวันนี้ไหม",
    "โอเคเช็คออเดอร์ให้หน่อย",
    "รับทราบยกเลิกให้ด้วย",
])
def test_f9_product_type_regex_never_matches_across_thai_token_boundary(
        message):
    """regression lock — regex บน low ต้องไม่กลับไปเปิดช่องให้ 'เคส'
    match ข้าม 'โอเค|ส่ง' boundary อีก (match.start() กลาง token → reject)."""
    from shopeechat import product_store
    assert "case" not in product_store._detect_product_types(message), (
        f"{message!r} regex ห้าม match ข้าม token boundary: "
        f"{product_store._detect_product_types(message)}")


def test_f9_real_case_and_multi_type_mentions_remain_detectable():
    """positive product words เดิมต้องอยู่ทั้ง kw path และ regex path."""
    from shopeechat import product_store
    assert "case" in product_store._detect_product_types("มีเคสไหม")

    result = product_store._detect_product_types("มีเคสโทรศัพท์ไหม")
    assert {"case", "phone"} <= result

    result = product_store._detect_product_types("ขอเคสกับฟิล์ม")
    assert {"case", "screen_protector"} <= result


# ── F10 — Xiaomi compact model-code coverage (user-authorized) ──
# gap: `xiaomi\s+(?:mi\s+)?(?:note\s+|lite\s+)?(?:1[0-4]|9|8)\b` บังคับ
# whitespace หลัง brand + จบ bare digits → compact codes (xiaomi14t / 14tpro
# ทั้ง fused และ spaced) ไม่ resolve → type หลุด → retrieval scope เปลือก
# (slot product_types=∅) → อาจตอบไม่พบข้อมูล/ผิดประเภท
# authorization: semantic expansion เฉพาะ Xiaomi alternative ตัวเดิม —
# ห้าม helper/guard/heuristic/owner/keyword table/regex binding ใหม่,
# ห้ามจับ brand xiaomi เปล่า ๆ, wattage ห้ามเป็นรุ่น


@pytest.mark.parametrize("message", [
    "xiaomi14t",
    "xiaomi 14t",
    "Xiaomi14T",
    "Xiaomi 14T",
    "xiaomi14tpro",
    "xiaomi 14t pro",
    "Xiaomi 14T Pro",
])
def test_f10_xiaomi_14t_compact_model_codes_are_phone(message):
    """fused/spaced/case variants ของ Xiaomi 14T series ต้อง resolve phone."""
    from shopeechat import product_store
    result = product_store._detect_product_types(message)
    assert "phone" in result, (
        f"{message!r} ต้อง detect phone: {result}")


@pytest.mark.parametrize("message", [
    "galaxy s24 ultra",
    "galaxy a55",
    "redmi 8a",
    "iphone15promax",
    "black shark 5",
])
def test_f10_existing_phone_model_detection_stays_green(message):
    """preserve control — alternatives ของ brand อื่นห้ามเปลี่ยน."""
    from shopeechat import product_store
    assert "phone" in product_store._detect_product_types(message), (
        f"{message!r} ต้อง detect phone เหมือนเดิม: "
        f"{product_store._detect_product_types(message)}")


@pytest.mark.parametrize("message", [
    "xiaomi powerbank 10000mah",
    "xiaomi watch s4",
    "xiaomi buds 5",
    "หัวชาร์จ xiaomi 120w",
    "สายชาร์จ xiaomi type-c",
])
def test_f10_xiaomi_non_phone_products_are_not_phone(message):
    """negative contract — brand xiaomi เปล่า/wattage/accessory ห้ามเป็น
    phone (120w ห้ามเป็นรุ่น 12, 10000mah ห้ามเป็นรุ่น 10)."""
    from shopeechat import product_store
    result = product_store._detect_product_types(message)
    assert "phone" not in result, f"{message!r} ห้าม detect phone: {result}"


def test_f10_xiaomi_expansion_does_not_reopen_cross_token_case_bug():
    """regression lock — A-255/A-257 boundary contract ต้องคง."""
    from shopeechat import product_store
    result = product_store._detect_product_types("โอเคส่งวันนี้ไหม")
    assert "case" not in result and "phone" not in result, result


def test_f10_route_context_resolves_xiaomi14t_as_phone():
    """route-level contract — detection ต้องไหลถึง public
    RouteContext.product_types (ไม่ใช่แค่ private detector)."""
    from shopeechat import route_context
    route = route_context.resolve_route("xiaomi14t มีไหม")
    assert "phone" in route.product_types, route.product_types


def test_f10_decide_turn_xiaomi14t_yields_product_need():
    """typed TurnPlan — product/describe need ต้องถูก emit ตามเดิม."""
    plan = turn_decision.decide_turn("xiaomi14t มีไหม", intent_result={})
    assert plan.primary_action == "execute_needs", plan
    assert any(n.kind == "product" for n in plan.needs), plan.needs


def test_f10_retrieval_scope_xiaomi14t_requests_phone_not_accessory():
    """retrieval-scope contract — profile/slot ต้อง request phone; slot
    ห้ามเปลือก (∅ = unscoped) และห้ามดึง accessory types จาก brand เดียวกัน."""
    from shopeechat import route_context
    profile = route_context.build_retrieval_profile(
        "xiaomi14t มีไหม", history=[], intent_result={}, shop="TestShop")
    assert "phone" in profile.product_types, profile.product_types
    slots = route_context.build_retrieval_slots(profile, ())
    assert any("phone" in s.product_types for s in slots), slots
    for s in slots:
        assert not (
            s.product_types & {"charger", "powerbank", "smartwatch"}), s


# ── F11 — Thai-glued Xiaomi model boundary (user-authorized trailing-
#   boundary correction เฉพาะ Xiaomi alternative เดิม) ──
# gap: Python \w ครอบตัวอักษรไทย → trailing `\b` ไม่มี boundary ระหว่าง
# model code กับคำไทยต่อท้าย → `มีxiaomi14tไหม`/`xiaomi14ไหม` → set()
# (residual ของ A-258); fix = explicit ASCII continuation boundary
# `(?![a-z0-9_])` — reject เฉพาะ ASCII word-char, ยอม non-ASCII (ไทย)


@pytest.mark.parametrize("message", [
    "มีxiaomi14tไหม",
    "xiaomi14ไหม",
    "มีxiaomi14tproไหม",
    "มีXiaomi14T Proไหม",
    "xiaomi14ultraครับ",
    "xiaomi14liteมีไหม",
    "มี xiaomi14t ไหม",
    "xiaomi 14t pro",
])
def test_f11_thai_glued_xiaomi_model_codes_are_phone(message):
    """Thai text ติดกับ Xiaomi model code (ทั้งนำหน้าและต่อท้าย) ต้อง
    resolve phone — spaced controls ยืนยัน behavior เดิม."""
    from shopeechat import product_store
    result = product_store._detect_product_types(message)
    assert "phone" in result, (
        f"{message!r} ต้อง detect phone: {result}")


@pytest.mark.parametrize("message", [
    "xiaomi14th",
    "xiaomi14tablet",
    "xiaomi140",
    "xiaomi14w",
    "xiaomi14tplus",
    "xiaomi14procase",
    "xiaomi powerbank 10000mah",
    "xiaomi watch s4",
    "xiaomi buds 5",
    "หัวชาร์จ xiaomi 120w",
    "สายชาร์จ xiaomi type-c",
    "โอเคส่งวันนี้ไหม",
])
def test_f11_ascii_continuation_and_non_phone_still_rejected(message):
    """negative contract — ASCII letter/digit ต่อท้าย model code
    (14th/140/14w/tablet/tplus/procase) และ accessory/wattage ห้ามเป็น
    phone; cross-token case lock คงเดิม."""
    from shopeechat import product_store
    result = product_store._detect_product_types(message)
    assert "phone" not in result, f"{message!r} ห้าม detect phone: {result}"


def test_f11_route_context_resolves_thai_glued_xiaomi14t_as_phone():
    """typed path — Thai-glued message ต้องไหลถึง
    RouteContext.product_types."""
    from shopeechat import route_context
    route = route_context.resolve_route("มีxiaomi14tไหม")
    assert "phone" in route.product_types, route.product_types


def test_f11_retrieval_scope_thai_glued_xiaomi14t_requests_phone():
    """retrieval scope — profile/slot ต้อง request phone ไม่ใช่เปลือก
    และห้ามดึง accessory types จาก brand เดียวกัน."""
    from shopeechat import route_context
    profile = route_context.build_retrieval_profile(
        "มีxiaomi14tไหม", history=[], intent_result={}, shop="TestShop")
    assert "phone" in profile.product_types, profile.product_types
    slots = route_context.build_retrieval_slots(profile, ())
    assert any("phone" in s.product_types for s in slots), slots
    for s in slots:
        assert not (
            s.product_types & {"charger", "powerbank", "smartwatch"}), s


# ── F12 — simulated-handoff propagation (A-260 P1) ──
# gap: intent_provider_failure_handoff เรียก _send_handoff โดยไม่ส่ง
#   simulate=True → payload ขาด "simulate" → Test Chat/Shadow provider
#   failure หลุดไป live conversations route (admin: body.simulate===true)
# contract: handoff caller ทุกจุดส่ง simulate=True แล้ว (chat_v2:1398,
#   app:4656, engine v3:113) — เหลือ owner นี้จุดเดียว


def _capture_urlopen_payloads(monkeypatch):
    """capture REAL payload ณ urllib transport seam — ห้าม patch
    _send_handoff/intent_provider_failure_handoff (payload ต้องเป็น
    ของ production owner จริง เห็น byte-level เหมือน admin route)."""
    import io, json, urllib.request
    calls = []

    def _fake(req, *a, **k):
        calls.append({
            "url": getattr(req, "full_url", str(req)),
            "payload": json.loads((req.data or b"{}").decode("utf-8"))})
        return io.BytesIO(json.dumps(
            {"outcome": {"state": "assigned"}}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", _fake)
    return calls


def _ho_req(**kw):
    from types import SimpleNamespace
    base = {"conversation_id": "c-sim", "shop": "TestShop",
            "platform": "shopee", "message": "m", "history": [],
            "simulate_assignment": True, "test_source": "phase1f"}
    base.update(kw)
    return SimpleNamespace(**base)


def test_f12_simulated_provider_failure_handoff_carries_simulate(
        monkeypatch):
    """A-260 P1: simulate_assignment=True → payload ต้องมี
    simulate:true (ก่อน fix key หาย → admin ไม่เข้า test-store branch)."""
    from shopeechat import responses as _resp
    calls = _capture_urlopen_payloads(monkeypatch)
    out = _resp.intent_provider_failure_handoff(
        _ho_req(simulate_assignment=True))
    assert calls, "handoff POST ต้องเกิด"
    p = calls[0]["payload"]
    assert "bot-handoff" in calls[0]["url"]
    assert p.get("reason") == "intent_provider_failure", p
    assert p.get("simulate") is True, (
        f"payload ขาด simulate:true → หลุด live route: {p}")
    assert p.get("test_source") == "phase1f", p
    assert out["handoff_ok"] is True


def test_f12_live_provider_failure_handoff_marks_simulate_false(
        monkeypatch):
    """simulate_assignment=False → simulate:false ตาม existing caller
    convention (caller ทุกจุดส่ง simulate=True → key ติดตามค่า req)."""
    from shopeechat import responses as _resp
    calls = _capture_urlopen_payloads(monkeypatch)
    out = _resp.intent_provider_failure_handoff(
        _ho_req(simulate_assignment=False, test_source=None))
    p = calls[0]["payload"]
    assert p.get("simulate") is False, (
        f"live request ต้อง simulate:false: {p}")
    assert "test_source" not in p, (
        f"ไม่มี test_source → ห้ามส่ง key: {p}")
    assert out["handoff_ok"] is True


def test_f12_missing_test_source_never_bypasses_simulation(monkeypatch):
    """test_source=None ห้ามใช้หลบ simulation — simulate มาจาก
    simulate_assignment เท่านั้น."""
    from shopeechat import responses as _resp
    calls = _capture_urlopen_payloads(monkeypatch)
    _resp.intent_provider_failure_handoff(
        _ho_req(simulate_assignment=True, test_source=None))
    p = calls[0]["payload"]
    assert p.get("simulate") is True, p
    assert "test_source" not in p, p


@pytest.mark.parametrize("use_v2", [False, True])
def test_f12_e2e_provider_failure_handoff_payload_simulated(
        monkeypatch, use_v2):
    """e2e ทั้งสอง engine: provider raise + unresolvable → real
    _send_handoff payload มี simulate:true (restore transport จริงบน
    urlopen allowlist ของ _install — handoffs entry มี "payload")."""
    from shopeechat import responses as _resp
    real_send = _resp._send_handoff           # เก็บก่อน _install stub
    fx = {"id": "p1f12e", "shop": "TestShop", "platform": "shopee",
          "conversation_id": "p1f12e-c1", "turns": []}
    _client, _cap, handoffs = _install(monkeypatch, fx)
    monkeypatch.setattr(_resp, "_send_handoff", real_send)
    monkeypatch.setattr(intent_classifier, "classify_intent",
                        _provider_raise)
    resp = app.chat(app.ChatRequest(
        message="ส่งวันนี้ไหม", shop="TestShop", platform="shopee",
        conversation_id="p1f12e-c1", history=[], limit=5,
        simulate_assignment=True, test_source="phase1f", use_v2=use_v2))
    posts = [h for h in handoffs if "payload" in h]
    assert posts, (
        f"ต้องเห็น urlopen payload (use_v2={use_v2}): {handoffs}")
    p = posts[0]["payload"]
    assert p.get("reason") == "intent_provider_failure", p
    assert p.get("simulate") is True, (
        f"e2e payload ขาด simulate:true (use_v2={use_v2}): {p}")
    assert p.get("test_source") == "phase1f", p
