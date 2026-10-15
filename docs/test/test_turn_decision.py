"""Phase 2C.1 — Multi-Need TurnPlan contract tests (in-place evolution).

decide_turn is a PURE contract owner returning TurnPlan(primary_action, needs,
ownership, claim, requires_clarification, normalized_message, flags):
no DB, no LLM, no network, no mutation, no retrieval slot/relation/device-spec
helpers, and zero new semantic keyword tables.

Order & ownership rules:
1. normalize + claim lifecycle view + ownership evaluation
2. active human ownership (handoff|open|pending) -> primary_action="human_wait",
   needs=() immediately (zero need-extraction side effects)
3. placeholder/media-only -> claim collect if claim.accepts_claim_fields +
   visual media; otherwise primary_action="no_reply", needs=()
4. independent need evaluation across canonical producers (human, claim,
   troubleshoot, order, policy, compare, compat, product) without collapsing
   multiple customer needs into one action.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

import validate_legacy_turn_fixtures as vfx  # noqa: E402
from shopeechat import turn_decision as _td_mod  # noqa: E402
from shopeechat.turn_decision import TurnNeed, TurnPlan, decide_turn  # noqa: E402


# ── purity gate (Phase 1A hardening + Phase 2C.1 H1 boundary) ────────────────
# decide_turn claims pure/no-env: its whole import+call chain must never run
# dotenv.load_dotenv, and must not call retrieval slot/relation/profile or
# device-spec helpers (Phase 2C.1 H1).

_PURITY_PROBE = """
import sys
sys.path.insert(0, {chatbot!r})
import dotenv


def _trap(*a, **k):
    raise AssertionError("dotenv.load_dotenv called — purity leak")


dotenv.load_dotenv = _trap  # before target import (from-import binds the trap)

import shopeechat.turn_decision as td
assert not hasattr(td, "TurnDecision"), "one-action TurnDecision must be deleted"
p = td.decide_turn("มีสายชาร์จ type c ไหม")
assert isinstance(p, td.TurnPlan), p
assert p.primary_action == "execute_needs", p
assert any(n.kind == "product" for n in p.needs), p
p = td.decide_turn("รับประกันกี่ปีครับ")
assert p.primary_action == "execute_needs", p
assert any(n.kind == "policy" and n.operation == "policy" for n in p.needs), p
print("PURE-OK")
"""


def test_turn_decision_pure_import_and_call():
    import subprocess
    probe = _PURITY_PROBE.format(chatbot=str(ROOT / "chatbot"))
    out = subprocess.run([sys.executable, "-c", probe],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, f"purity probe failed:\n{out.stderr}"
    assert "PURE-OK" in out.stdout


def test_knowledge_base_detector_compat_unchanged():
    """backward-compat pin: knowledge_base must keep exposing the moved
    detectors with identical behavior (callers use knowledge_base.*).
    Runs in subprocess with load_dotenv suppressed — never reads .env."""
    import subprocess
    probe = """
import sys
sys.path.insert(0, %r)
import dotenv
dotenv.load_dotenv = lambda *a, **k: False  # suppress — do NOT read real .env
from shopeechat import knowledge_base, message_detectors
msg = "รับประกันกี่ปีครับ"
assert knowledge_base.detect_general_question(msg) == \\
    message_detectors.detect_general_question(msg)
assert knowledge_base.extract_model_keywords("Xiaomi 17 Ultra") == \\
    message_detectors.extract_model_keywords("Xiaomi 17 Ultra")
assert knowledge_base.is_target_device_kw("iphone15") is \\
    message_detectors.is_target_device_kw("iphone15")
print("COMPAT-OK")
""" % str(ROOT / "chatbot")
    out = subprocess.run([sys.executable, "-c", probe],
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, f"compat probe failed:\n{out.stderr}"
    assert "COMPAT-OK" in out.stdout


def test_one_action_turn_decision_is_deleted():
    """Superseded one-action TurnDecision dataclass must be deleted in 2C.1."""
    assert not hasattr(_td_mod, "TurnDecision")


def test_h1_no_retrieval_parser_calls(monkeypatch):
    """H1: turn_decision must not call build_retrieval_profile,
    build_retrieval_slots, build_retrieval_relations, or device_compat."""
    from shopeechat import route_context as _rc
    for fn in ("build_retrieval_profile", "build_retrieval_slots",
               "build_retrieval_relations"):
        monkeypatch.setattr(
            _rc, fn,
            lambda *a, _f=fn, **k: pytest.fail(f"forbidden call to {_f}"))
    p = decide_turn("AC65B เทียบกับ AC65B2 หน่อย แล้วใช้กับ iphone 15 ได้ไหม")
    assert p.primary_action == "execute_needs"
    assert {(n.kind, n.operation) for n in p.needs} >= {
        ("compare", "compare"), ("compat", "compat"),
    }


def _decide(msg, **kw) -> TurnPlan:
    return decide_turn(msg, **kw)


def _pairs(plan: TurnPlan) -> set[tuple[str, str]]:
    return {(n.kind, n.operation) for n in plan.needs}


# ── 3. system/noise/placeholder ─────────────────────────────────────────────

@pytest.mark.parametrize("msg", [
    "[faq_liveagent]", "[bundle_message]", "[bundle_deal]", "[bundle]",
    "[order]", "[คำสั่งซื้อ]",
])
def test_system_placeholders_are_no_reply(msg):
    p = _decide(msg)
    assert p.primary_action == "no_reply"
    assert p.needs == ()
    assert not p.normalized_message.strip()


@pytest.mark.parametrize("msg", [
    "[item]", "[itemid]", "[สินค้า]", "[variation_card]", "[ตัวเลือกสินค้า]",
])
def test_bare_item_placeholders_not_product_query(msg):
    """Bare [item]-family placeholders must never become a product query
    built from the literal placeholder text."""
    p = _decide(msg)
    assert p.primary_action == "no_reply"
    assert p.needs == ()


@pytest.mark.parametrize("msg", [
    "[รูปภาพ]", "[image]", "[วิดีโอ]", "[video]", "[sticker]", "[สติกเกอร์]",
    "[รูปภาพ] [รูปภาพ]",
])
def test_media_placeholders_are_no_reply_when_not_collecting(msg):
    p = _decide(msg)
    assert p.primary_action == "no_reply"
    assert p.needs == ()


@pytest.mark.parametrize("msg", ["[รูปภาพ]", "[image]", "[วิดีโอ]", "[video]"])
def test_visual_media_placeholder_collects_when_claim_collecting(msg):
    """Image/video placeholder during active claim collection is claim evidence."""
    p = _decide(msg, claim_state={"stage": "collecting", "episode_id": "ep-1"})
    assert p.primary_action == "execute_needs"
    assert _pairs(p) == {("claim", "collect")}
    assert "claim_resume" in p.flags
    assert "media_placeholder" in p.flags


@pytest.mark.parametrize("msg", ["[sticker]", "[สติกเกอร์]"])
def test_sticker_placeholder_remains_no_reply_even_when_collecting(msg):
    p = _decide(msg, claim_state={"stage": "collecting", "episode_id": "ep-1"})
    assert p.primary_action == "no_reply"
    assert p.needs == ()


def test_placeholder_with_real_text_keeps_text():
    p = _decide("[สินค้า: 123456] มีไหมครับ")
    assert "has_item_tag" in p.flags
    assert p.primary_action == "execute_needs"
    assert ("product", "describe") in _pairs(p)
    prod = next(n for n in p.needs if n.kind == "product")
    assert "123456" in prod.subject_refs


# ── 5. product issue / claim must not be swallowed by anger ─────────────────

def test_product_issue_not_anger_handoff():
    p = _decide("ชาร์จแล้วไฟไม่เข้าเป็นที่อะไรครับ")
    assert p.primary_action == "execute_needs"
    assert ("human", "handoff") not in _pairs(p)
    assert ("claim", "collect") in _pairs(p)
    assert ("troubleshoot", "describe") in _pairs(p)


def test_charge_slow_claim_is_claim_collect_need():
    p = _decide("ชาร์จช้ามากขอเคลม")
    assert p.primary_action == "execute_needs"
    assert ("claim", "collect") in _pairs(p)


def test_tried_fix_still_broken_claim():
    p = _decide("ทำแล้วไม่หายเคลมได้ไหม")
    assert p.primary_action == "execute_needs"
    assert ("claim", "collect") in _pairs(p)


# ── 4. explicit human request ────────────────────────────────────────────────

def test_explicit_human_request_handoff():
    p = _decide("ขอคุยกับแอดมิน")
    assert p.primary_action == "handoff"
    assert _pairs(p) == {("human", "handoff")}


# ── 6. service anger (legacy parity) ────────────────────────────────────────

def test_service_frustration_handoff():
    p = _decide("ร้านไม่ตอบเลย")
    assert p.primary_action == "handoff"
    assert _pairs(p) == {("human", "handoff")}
    assert "customer_frustration" in p.flags


def test_product_word_not_anger():
    """product noun containing a service-ish substring must not escalate."""
    p = _decide("ไม่มีการตอบสนองของปุ่มกด")
    assert p.primary_action != "handoff"
    assert ("human", "handoff") not in _pairs(p)


# ── 2. post-handoff lock (M2 human ownership contract) ──────────────────────

def test_active_ticket_locks_plain_text():
    p = _decide("ยังไม่มีใครตอบเลย", ticket_state={"state": "handoff"})
    assert p.primary_action == "human_wait"
    assert p.ownership == "human"
    assert p.needs == ()


def test_active_ticket_locks_greeting():
    p = _decide("สวัสดีครับ", ticket_state={"state": "handoff"})
    assert p.primary_action == "human_wait"
    assert p.ownership == "human"
    assert p.needs == ()


@pytest.mark.parametrize("state", ["handoff", "open", "pending"])
def test_active_ticket_states_lock(state):
    p = _decide("ยังไม่มีใครตอบเลย", ticket_state={"state": state})
    assert p.primary_action == "human_wait"
    assert p.ownership == "human"
    assert p.needs == ()


@pytest.mark.parametrize("state", ["closed", "resolved", "bot"])
def test_closed_ticket_states_unlock(state):
    p = _decide("สวัสดีครับ", ticket_state={"state": state})
    assert p.primary_action != "human_wait"
    assert p.ownership == "bot"


def test_ticket_state_string_form():
    p = _decide("ยังไม่มีใครตอบเลย", ticket_state="open")
    assert p.primary_action == "human_wait"
    assert p.ownership == "human"


def test_m2_human_ownership_stops_before_need_evaluation(monkeypatch):
    """M2: when ownership == 'human', detector intentionally stops before
    evaluating needs — zero need-extraction calls may run."""
    from shopeechat import handoffs, message_detectors, route_context, warranty
    monkeypatch.setattr(handoffs, "is_human_request",
                        lambda *a, **k: pytest.fail("is_human_request called"))
    monkeypatch.setattr(handoffs, "is_service_anger",
                        lambda *a, **k: pytest.fail("is_service_anger called"))
    monkeypatch.setattr(warranty, "detect_claim_request",
                        lambda *a, **k: pytest.fail("detect_claim_request called"))
    monkeypatch.setattr(route_context, "resolve_route",
                        lambda *a, **k: pytest.fail("resolve_route called"))
    monkeypatch.setattr(message_detectors, "detect_general_question",
                        lambda *a, **k: pytest.fail("detect_general_question called"))
    p = _decide("ขอแอดมินหน่อย มีสายชาร์จเคลมได้ไหม", ticket_state="open",
                claim_state={"stage": "collecting", "episode_id": "e1"})
    assert p.primary_action == "human_wait"
    assert p.ownership == "human"
    assert p.needs == ()
    assert p.claim.stage == "collecting"
    assert "post_handoff" in p.flags


# ── 5. claim resume requires a fresh claim signal ────────────────────────────

def test_stale_claim_state_greeting_not_collect():
    p = _decide("สวัสดีครับ", claim_state={"name": "สมชาย", "phone": "081"})
    assert ("claim", "collect") not in _pairs(p)


def test_stale_claim_state_product_question_not_collect():
    p = _decide("มีหัวชาร์จ iphone ไหมครับ",
                claim_state={"name": "สมชาย"},
                intent_result={"intent": "product_question"})
    assert ("claim", "collect") not in _pairs(p)
    assert ("product", "describe") in _pairs(p)


def test_claim_state_plus_claim_signal_collects():
    p = _decide("ส่งเบอร์โทรมาแล้ว 0812345678 เคลม",
                claim_state={"stage": "collecting", "episode_id": "e1",
                             "customer_name": "สมชาย ใจดี"})
    assert p.primary_action == "execute_needs"
    assert ("claim", "collect") in _pairs(p)
    assert "claim_resume" in p.flags


def test_slot_only_state_plus_claim_signal_is_request_not_resume():
    p = _decide("ส่งเบอร์โทรมาแล้ว 0812345678 เคลม",
                claim_state={"customer_name": "สมชาย ใจดี"})
    assert p.primary_action == "execute_needs"
    assert ("claim", "collect") in _pairs(p)
    assert "claim_resume" not in p.flags


# ── 7-9. follow-up / product / general / unknown ─────────────────────────────

def test_comparison_followup_with_history():
    p = _decide("ต่างกันยังไงครับ",
                history=[{"role": "user", "text": "สนใจ X1 กับ X2"}])
    assert p.primary_action == "execute_needs"
    assert ("compare", "compare") in _pairs(p)
    assert "needs_history" in p.flags


def test_intent_product_question():
    p = _decide("มีสายชาร์จ type c ไหม",
                intent_result={"intent": "product_question"})
    assert p.primary_action == "execute_needs"
    assert ("product", "describe") in _pairs(p)


def test_general_question_keyword():
    p = _decide("รับประกันกี่ปีครับ")
    assert p.primary_action == "execute_needs"
    assert ("policy", "policy") in _pairs(p)


def test_unknown_fallback():
    p = _decide("x")
    assert p.primary_action == "clarify"
    assert p.needs == ()
    assert p.requires_clarification is True


# ── Phase 1C: price/link follow-up needs context ────────────────────────────
_PROD_HISTORY = [
    {"role": "user", "text": "มีพาวเวอร์แบงค์แนะนำไหมครับ"},
    {"role": "model", "text": "มี AC65B กับ AC65B2 ค่ะ"},
]


def test_price_ask_with_history_is_followup():
    p = _decide("ราคาเท่าไหร่", history=_PROD_HISTORY)
    assert p.primary_action == "execute_needs", p
    assert ("product", "price") in _pairs(p)
    assert "price_followup" in p.flags


def test_link_ask_with_history_is_followup():
    p = _decide("ขอลิงค์", history=_PROD_HISTORY)
    assert p.primary_action == "execute_needs", p
    assert ("product", "link") in _pairs(p)
    assert "link_followup" in p.flags


def test_price_ask_without_history_requires_clarification():
    p = _decide("ราคาเท่าไหร่")
    assert p.primary_action == "clarify", p
    assert p.needs == ()
    assert p.requires_clarification is True


def test_link_ask_non_product_link_not_followup():
    p = _decide("ขอลิงค์สมัครสมาชิก", history=_PROD_HISTORY)
    assert ("product", "link") not in _pairs(p), p
    assert "link_followup" not in p.flags


def test_price_adjective_without_history_not_followup():
    p = _decide("ราคาแพงไหม")
    assert ("product", "price") not in _pairs(p), p


# ── Phase 1C gate: price/link needs *product* context, not any history ──────

def test_price_ask_after_greeting_history_not_followup():
    p = _decide("ราคาเท่าไหร่",
                history=[{"role": "user", "text": "สวัสดีครับ"}])
    assert p.primary_action == "clarify", p
    assert ("product", "price") not in _pairs(p)


def test_link_ask_after_human_request_history_not_followup():
    p = _decide("ขอลิงค์",
                history=[{"role": "user", "text": "ขอคุยกับแอดมิน"}])
    assert p.primary_action == "clarify", p
    assert ("product", "link") not in _pairs(p)


def test_price_ask_after_claim_history_not_followup():
    p = _decide("ราคาเท่าไหร่",
                history=[{"role": "user", "text": "สินค้าเสียขอเคลม"}])
    assert p.primary_action == "clarify", p
    assert ("product", "price") not in _pairs(p)


def test_price_ask_after_product_history_is_followup():
    p = _decide("ราคาเท่าไหร่",
                history=[{"role": "model", "text": "มี AC65B กับ AC65B2 ค่ะ"}])
    assert p.primary_action == "execute_needs", p
    assert ("product", "price") in _pairs(p)


def test_link_ask_after_product_history_is_followup():
    p = _decide("ขอลิงค์",
                history=[{"role": "model", "text": "มี CTC615P สายชาร์จค่ะ"}])
    assert p.primary_action == "execute_needs", p
    assert ("product", "link") in _pairs(p)


# ── Phase 1C: contact-info fill is not a product query ───────────────────────

def test_phone_only_with_claim_state_collects():
    p = _decide("0812345678",
                claim_state={"stage": "collecting", "episode_id": "e1",
                             "customer_name": "สมชาย"})
    assert p.primary_action == "execute_needs", p
    assert _pairs(p) == {("claim", "collect")}


def test_phone_only_with_slot_only_state_not_collect():
    p = _decide("0812345678", claim_state={"customer_name": "สมชาย"})
    assert ("claim", "collect") not in _pairs(p), p
    assert p.primary_action == "clarify"


def test_phone_only_without_claim_state_not_product():
    p = _decide("0812345678")
    assert not any(n.kind == "product" for n in p.needs), p
    assert "contact_info" in p.flags
    assert p.primary_action == "clarify"


def test_order_id_only_without_claim_state_not_product():
    p = _decide("2508088B5T4W1D")
    assert not any(n.kind == "product" for n in p.needs), p
    assert p.primary_action == "clarify"


def test_explicit_order_lookup_produces_order_need():
    p = _decide("order 2508088B5T4W1D ถึงไหนแล้ว")
    assert p.primary_action == "execute_needs", p
    assert ("order", "lookup") in _pairs(p)
    assert not any(n.kind == "product" for n in p.needs), p
    order_need = next(n for n in p.needs if n.kind == "order")
    assert order_need.subject_refs == ("2508088B5T4W1D",)


def test_model_code_still_product():
    p = _decide("ctc615")
    assert p.primary_action == "execute_needs", p
    assert ("product", "describe") in _pairs(p)


# ── Phase 1C: cert standards question → cert evidence path ──────────────────

def test_cert_question_is_cert_flagged_product():
    p = _decide("ตัวไหนมี มอก. บ้าง", history=_PROD_HISTORY)
    assert p.primary_action == "execute_needs", p
    assert ("product", "describe") in _pairs(p)
    assert "cert_question" in p.flags


# ── Phase 1D: stock/select questions — context-gated like price/link ─────────

def test_stock_ask_with_product_history_is_followup():
    p = _decide("รุ่นนี้ยังมีขายไหมครับ", history=_PROD_HISTORY)
    assert p.primary_action == "execute_needs", p
    assert ("product", "stock") in _pairs(p)
    assert "stock_followup" in p.flags


def test_select_ask_with_product_history_is_followup():
    p = _decide("มีตัวไหนบ้าง", history=_PROD_HISTORY)
    assert p.primary_action == "execute_needs", p
    assert ("product", "recommend") in _pairs(p)
    assert "select_followup" in p.flags


def test_stock_ask_without_history_not_followup():
    p = _decide("รุ่นนี้ยังมีขายไหมครับ")
    assert p.primary_action == "clarify", p
    assert p.needs == ()
    assert p.requires_clarification is True


def test_select_ask_after_greeting_history_not_followup():
    p = _decide("มีตัวไหนบ้าง",
                history=[{"role": "user", "text": "สวัสดีครับ"}])
    assert p.primary_action == "clarify", p
    assert p.needs == ()


def test_select_ask_after_claim_history_not_followup():
    p = _decide("มีตัวไหนบ้าง",
                history=[{"role": "user", "text": "สินค้าเสียขอเคลม"}])
    assert p.primary_action == "clarify", p
    assert p.needs == ()


# ── Phase 1D: name-only claim fill ───────────────────────────────────────────

def test_name_only_with_claim_state_collects():
    p = _decide("ชื่อ สมชาย ใจดี", claim_state={"stage": "collecting"})
    assert p.primary_action == "execute_needs", p
    assert _pairs(p) == {("claim", "collect")}


def test_name_only_without_claim_state_clarify():
    p = _decide("ชื่อ สมชาย ใจดี")
    assert p.primary_action == "clarify", p
    assert p.needs == ()
    assert p.requires_clarification is True
    assert "contact_info" in p.flags


def test_product_query_with_claim_state_not_swallowed():
    p = _decide("มี AC65B ไหมครับ", claim_state={"stage": "collecting"})
    assert ("claim", "collect") not in _pairs(p), p
    assert ("product", "describe") in _pairs(p)


# ── Phase 2C.1: Multi-Need TurnPlan cases ────────────────────────────────────

def test_multi_need_claim_plus_product():
    """iss30: claim + product question in one turn preserves both needs."""
    p = _decide("สินค้าเสียอยากเคลม แล้วก็อยากดูพาวเวอร์แบงค์รุ่นใหม่ด้วย")
    assert p.primary_action == "execute_needs"
    assert ("claim", "collect") in _pairs(p)
    assert ("troubleshoot", "describe") in _pairs(p)
    assert ("product", "describe") in _pairs(p)


def test_multi_need_product_plus_warranty_policy():
    """Product question + warranty policy question in one turn keeps both."""
    p = _decide("มี AC65B ไหมครับ แล้วรับประกันกี่ปี")
    assert p.primary_action == "execute_needs"
    assert ("product", "describe") in _pairs(p)
    assert ("policy", "policy") in _pairs(p)
    prod = next(n for n in p.needs if n.kind == "product")
    assert "AC65B" in prod.subject_refs


def test_multi_need_model_warranty_duration_keeps_product_and_policy():
    """'PB200P รับประกันกี่ปี' has both explicit product identity and warranty policy need."""
    p = _decide("PB200P รับประกันกี่ปี")
    assert p.primary_action == "execute_needs"
    assert ("product", "describe") in _pairs(p)
    assert ("policy", "policy") in _pairs(p)
    prod = next(n for n in p.needs if n.kind == "product")
    assert "PB200P" in prod.subject_refs


def test_multi_need_compare_plus_compat():
    """Comparison + device compatibility in one turn preserves both needs."""
    p = _decide("AC65B เทียบกับ AC65B2 หน่อย แล้วใช้กับ iphone 15 ได้ไหม")
    assert p.primary_action == "execute_needs"
    assert ("compare", "compare") in _pairs(p)
    assert ("compat", "compat") in _pairs(p)
    cmp_need = next(n for n in p.needs if n.kind == "compare")
    assert set(cmp_need.subject_refs) >= {"AC65B", "AC65B2"}


def test_multi_need_human_request_plus_product_info():
    """Explicit human request while bot owns ticket sets primary_action='handoff'
    AND preserves the independent product information need."""
    p = _decide("ขอคุยกับแอดมินหน่อยครับ แล้ว PB200P ยังมีของไหมครับ",
                ticket_state="bot")
    assert p.ownership == "bot"
    assert p.primary_action == "handoff"
    assert ("human", "handoff") in _pairs(p)
    assert ("product", "stock") in _pairs(p)


def test_multi_need_media_placeholder_plus_text():
    """Image/video placeholder + text preserves media provenance and text needs."""
    p = _decide("[รูปภาพ] สายชาร์จตัวนี้ใช้กับ iphone 15 ได้ไหมครับ")
    assert "media_placeholder" in p.flags
    assert p.primary_action == "execute_needs"
    assert ("compat", "compat") in _pairs(p)
    assert ("product", "describe") in _pairs(p)
    for n in p.needs:
        assert "media_placeholder" in n.provenance


def test_multi_need_video_placeholder_plus_claim_text():
    p = _decide("[วิดีโอ] ชาร์จไฟไม่เข้าเลยครับ ขอเคลม")
    assert "media_placeholder" in p.flags
    assert p.primary_action == "execute_needs"
    assert ("claim", "collect") in _pairs(p)
    assert ("troubleshoot", "describe") in _pairs(p)


def test_multi_need_with_partial_ambiguity():
    """Clear product need + unanchored follow-up price/comparison ambiguity ->
    executes clear need while flagging requires_clarification=True."""
    p = _decide("รับประกันกี่ปีครับ แล้วตัวนี้ราคาเท่าไหร่")
    assert p.primary_action == "execute_needs"
    assert ("policy", "policy") in _pairs(p)
    assert p.requires_clarification is True


# ── Phase 2C.1 Narrow Review-Fix: Finding A (stable subject_refs only) ──────

def test_generic_model_keyword_is_signal_not_subject_identity():
    plan = decide_turn("มีสายชาร์จ type c ไหม")
    product = next(n for n in plan.needs if n.kind == "product")
    assert "type" not in product.subject_refs
    assert product.subject_refs == ()


def test_subject_refs_item_tag_and_model_code_and_target_device_exclusion():
    # [สินค้า: 123456] -> subject_refs contains "123456"
    p_tag = decide_turn("[สินค้า: 123456] มีไหมครับ")
    prod_tag = next(n for n in p_tag.needs if n.kind == "product")
    assert prod_tag.subject_refs == ("123456",)

    # AC65B -> subject_refs contains "AC65B" from route.model_codes
    p_code = decide_turn("มี AC65B ไหมครับ")
    prod_code = next(n for n in p_code.needs if n.kind == "product")
    assert prod_code.subject_refs == ("AC65B",)

    # target device iphone 15 must NOT become product subject_ref
    p_dev = decide_turn("สายชาร์จใช้กับ iphone 15 ได้ไหมครับ")
    for n in p_dev.needs:
        assert "iphone" not in {r.lower() for r in n.subject_refs}
        assert "15" not in n.subject_refs
        assert n.subject_refs == ()


# ── Phase 2C.1 Narrow Review-Fix: Finding B (canonical compat connector) ─────

def test_compat_behavior_pins_and_provenance():
    p1 = decide_turn("AC65B ใช้กับ iphone 15 ได้ไหม")
    assert ("compat", "compat") in _pairs(p1)
    c1 = next(n for n in p1.needs if n.kind == "compat")
    assert "route_context._REL_CONN_RE" in c1.provenance
    assert "route_context.compat_signal" not in c1.provenance

    p2 = decide_turn("AC65B รองรับ iphone 15 ไหม")
    assert ("compat", "compat") in _pairs(p2)
    c2 = next(n for n in p2.needs if n.kind == "compat")
    assert "route_context._REL_CONN_RE" in c2.provenance

    # deictic wording without compat relation must NOT become compat
    p3 = decide_turn("ตัวนี้ AC65B")
    assert ("compat", "compat") not in _pairs(p3)
    assert ("product", "describe") in _pairs(p3)

    # ordinary product question without compat relation has no compat need
    p4 = decide_turn("มีสายชาร์จ AC65B ไหมครับ")
    assert ("compat", "compat") not in _pairs(p4)
    assert ("product", "describe") in _pairs(p4)


# ── shadow vs real fixtures (contract level, action boundary only) ───────────

def _fixture_rows():
    path = ROOT / "docs" / "test" / "fixtures" / "legacy_turn_incidents.jsonl"
    return [json.loads(l) for l in path.open() if l.strip()]


_ACTION_FAMILY = {
    "handoff": {"handoff"},
    "locked": {"human_wait"},
    "answer": {"execute_needs", "clarify"},
    "claim_collect": {"execute_needs"},
    "order_info": {"execute_needs"},
}
_KNOWN_INCIDENT_IDS: set[str] = set()


def _fixture_contract_check(fx):
    """Run decide_turn on a fixture's first user turn and return a mismatch
    tuple (id, actual, expected) or None."""
    user_turns = [t for t in (fx.get("turns") or [])
                  if (t or {}).get("role", "user") == "user"]
    if not user_turns:
        return None
    turn = user_turns[0]
    _tseed = fx.get("timeline_seed") or {}
    _anchor = ({"item_id": str(_tseed["active_item_id"])}
               if _tseed.get("active_item_id") else None)
    p = _decide(turn["text"],
                ticket_state={"state": fx["ticket_state"]}
                if fx.get("ticket_state") else None,
                claim_state=fx.get("claim_state_seed"),
                active_anchor=_anchor)
    tde = fx.get("turn_decision_expect")
    if tde:
        err = vfx.tde_entry_error(
            tde[0], p, p.flags,
            incident=fx.get("status") == "incident")
        if err:
            return (fx["id"], p.primary_action, [err])
        return None
    if p.primary_action == "no_reply" and not p.normalized_message.strip():
        return None
    _note = fx.get("expectation_note")
    exp = (fx.get("expected")
           or (_note if isinstance(_note, dict) else {})
           or {})
    want = _ACTION_FAMILY.get(exp.get("action"))
    if not want:
        return None
    if p.primary_action not in want and fx["id"] not in _KNOWN_INCIDENT_IDS:
        return (fx["id"], p.primary_action, sorted(want))
    return None


def test_shadow_fixture_actions_contract():
    mismatches = {fx["id"]: c for fx in _fixture_rows()
                  if (c := _fixture_contract_check(fx))}
    assert not mismatches, f"contract/legacy family mismatches: {mismatches}"


# ── Phase 1F — contract inputs: anchor / claim provenance ────────────────────

def test_active_ticket_locks_claim_info():
    p = _decide("0812345678", ticket_state="open")
    assert p.primary_action == "human_wait"


def test_active_ticket_locks_claim_name():
    p = _decide("สมชาย ใจดี", ticket_state={"state": "handoff"})
    assert p.primary_action == "human_wait"


def test_active_ticket_locks_lone_name():
    p = _decide("สมชาย", ticket_state={"state": "handoff"})
    assert p.primary_action == "human_wait"


def test_active_ticket_locks_product_question():
    p = _decide("มีสายชาร์จไหมครับ", ticket_state="pending")
    assert p.primary_action == "human_wait"


def test_active_ticket_locks_image_placeholder():
    p = _decide("[รูปภาพ]", ticket_state={"state": "open"})
    assert p.primary_action == "human_wait"


def test_decide_turn_has_no_exceptions_param():
    """post_handoff_exceptions ถูกลบ — content override ไม่มีสิทธิ์อยู่แล้ว."""
    import inspect
    assert "post_handoff_exceptions" not in \
        inspect.signature(decide_turn).parameters


def test_lone_name_is_claim_signal_when_collecting():
    p = _decide("สมชาย",
                claim_state={"stage": "collecting", "episode_id": "e1"})
    assert p.primary_action == "execute_needs"
    assert ("claim", "collect") in _pairs(p)
    assert "claim_resume" in p.flags


# active anchor → product context

def test_stock_ask_with_active_anchor_is_followup():
    p = _decide("รุ่นนี้ยังมีขายไหมครับ",
                active_anchor={"item_id": "3004", "name": "AC65B"})
    assert p.primary_action == "execute_needs"
    assert ("product", "stock") in _pairs(p)
    assert "stock_followup" in p.flags


def test_link_ask_with_active_anchor_is_followup():
    p = _decide("ขอลิงค์ตัวนี้หน่อย",
                active_anchor={"item_id": "3004", "name": "AC65B"})
    assert p.primary_action == "execute_needs"
    assert ("product", "link") in _pairs(p)
    assert "link_followup" in p.flags


def test_stock_ask_no_anchor_no_history_not_followup():
    p = _decide("รุ่นนี้ยังมีขายไหมครับ")
    assert p.primary_action == "clarify"
    assert p.needs == ()


# claim_state provenance — production _claim_lifecycle semantics

def test_name_only_with_collecting_claim_state_is_claim_collect():
    p = _decide("ชื่อ สมชาย ใจดี",
                claim_state={"stage": "collecting"})
    assert p.primary_action == "execute_needs"
    assert _pairs(p) == {("claim", "collect")}


def test_name_only_with_filled_slots_is_claim_collect():
    p = _decide("ชื่อ สมชาย ใจดี",
                claim_state={"stage": "collecting", "episode_id": "e1",
                             "customer_phone": "0812345678"})
    assert p.primary_action == "execute_needs"
    assert _pairs(p) == {("claim", "collect")}


def test_name_only_with_slot_only_state_not_collect():
    p = _decide("ชื่อ สมชาย ใจดี",
                claim_state={"customer_phone": "0812345678"})
    assert ("claim", "collect") not in _pairs(p)


def test_name_only_with_resolved_without_slots_not_collect():
    p = _decide("ชื่อ สมชาย ใจดี",
                claim_state={"stage": "resolved"})
    assert ("claim", "collect") not in _pairs(p)


def test_phone_with_resolved_without_slots_not_collect():
    p = _decide("0812345678",
                claim_state={"stage": "resolved"})
    assert ("claim", "collect") not in _pairs(p)


def test_resolved_with_retained_slots_not_collect():
    p = _decide("0812345678",
                claim_state={"stage": "resolved",
                             "customer_name": "สมชาย ใจดี"})
    assert ("claim", "collect") not in _pairs(p)


def test_explicit_noise_expectation_is_consumed_not_skipped():
    import copy
    fx = next(f for f in _fixture_rows() if f["id"] == "noise-then-product")
    assert _fixture_contract_check(fx) is None  # real expectation passes
    bad = copy.deepcopy(fx)
    bad["turn_decision_expect"][0]["primary_action"] = "human_wait"
    assert _fixture_contract_check(bad) is not None  # mutation must flag
