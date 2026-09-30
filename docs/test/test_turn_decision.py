"""Revised Phase 1 — TurnDecision contract tests (audit-confirmed order).

decide_turn is a PURE contract owner: no DB, no LLM, no network, no
mutation. Order: normalize → post-handoff lock → noise → human → claim →
service anger → follow-up → product/general → unknown.

These tests pin the contract only — they do NOT prove chat() behaves this
way yet (runtime wiring is a later, separately-approved step).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat.turn_decision import TurnDecision, decide_turn  # noqa: E402


# ── purity gate (Phase 1A hardening) ─────────────────────────────────────────
# decide_turn claims pure/no-env: its whole import+call chain must never run
# dotenv.load_dotenv — knowledge_base._load_env used to leak the repo .env at
# import. Probe runs in a fresh subprocess so module cache can't hide it.

_PURITY_PROBE = """
import sys
sys.path.insert(0, {chatbot!r})
import dotenv


def _trap(*a, **k):
    raise AssertionError("dotenv.load_dotenv called — purity leak")


dotenv.load_dotenv = _trap  # before target import (from-import binds the trap)

import shopeechat.turn_decision as td
d = td.decide_turn("มีสายชาร์จ type c ไหม")
assert d.action == "answer_product", d
d = td.decide_turn("รับประกันกี่ปีครับ")
assert d.action == "answer_general", d
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



def _decide(msg, **kw):
    return decide_turn(msg, **kw)


# ── 3. system/noise/placeholder ─────────────────────────────────────────────

@pytest.mark.parametrize("msg", [
    "[faq_liveagent]", "[bundle_message]", "[bundle_deal]", "[bundle]",
    "[order]", "[คำสั่งซื้อ]",
])
def test_system_placeholders_are_noise(msg):
    d = _decide(msg)
    assert d.action == "noise"
    assert not d.normalized_message.strip()


@pytest.mark.parametrize("msg", [
    "[item]", "[itemid]", "[สินค้า]", "[variation_card]", "[ตัวเลือกสินค้า]",
])
def test_bare_item_placeholders_not_product_query(msg):
    """Bare [item]-family placeholders must never become a product query
    built from the literal placeholder text."""
    d = _decide(msg)
    assert d.action == "noise"


@pytest.mark.parametrize("msg", [
    "[รูปภาพ]", "[image]", "[วิดีโอ]", "[video]", "[sticker]", "[สติกเกอร์]",
    "[รูปภาพ] [รูปภาพ]",
])
def test_media_placeholders_are_noise(msg):
    d = _decide(msg)
    assert d.action == "noise"


def test_placeholder_with_real_text_keeps_text():
    d = _decide("[สินค้า: 123456] มีไหมครับ")
    assert "has_item_tag" in d.flags
    assert d.action != "noise"


# ── 5. product issue / claim must not be swallowed by anger ─────────────────

def test_product_issue_not_anger_handoff():
    d = _decide("ชาร์จแล้วไฟไม่เข้าเป็นที่อะไรครับ")
    assert d.action in ("claim_request", "answer_product")
    assert d.action != "handoff"


def test_charge_slow_claim_is_claim_request():
    d = _decide("ชาร์จช้ามากขอเคลม")
    assert d.action == "claim_request"


def test_tried_fix_still_broken_claim():
    d = _decide("ทำแล้วไม่หายเคลมได้ไหม")
    assert d.action == "claim_request"


# ── 4. explicit human request ────────────────────────────────────────────────

def test_explicit_human_request_handoff():
    d = _decide("ขอคุยกับแอดมิน")
    assert d.action == "handoff"


# ── 6. service anger (legacy parity) ────────────────────────────────────────

def test_service_frustration_handoff():
    d = _decide("ร้านไม่ตอบเลย")
    assert d.action == "handoff"


def test_product_word_not_anger():
    """product noun containing a service-ish substring must not escalate."""
    d = _decide("ไม่มีการตอบสนองของปุ่มกด")
    assert d.action != "handoff"


# ── 2. post-handoff lock ─────────────────────────────────────────────────────

def test_active_ticket_locks_greeting():
    d = _decide("สวัสดีครับ", ticket_state={"state": "handoff"})
    assert d.action == "locked"


@pytest.mark.parametrize("state", ["handoff", "open", "pending"])
def test_active_ticket_states_lock(state):
    assert _decide("สวัสดีครับ", ticket_state={"state": state}).action == "locked"


@pytest.mark.parametrize("state", ["closed", "resolved", "bot"])
def test_closed_ticket_states_unlock(state):
    assert _decide("สวัสดีครับ", ticket_state={"state": state}).action != "locked"


def test_ticket_state_string_form():
    assert _decide("สวัสดีครับ", ticket_state="open").action == "locked"


# ── 5. claim resume requires a fresh claim signal ────────────────────────────

def test_stale_claim_state_greeting_not_collect():
    d = _decide("สวัสดีครับ", claim_state={"name": "สมชาย", "phone": "081"})
    assert d.action != "claim_collect"


def test_stale_claim_state_product_question_not_collect():
    d = _decide("มีหัวชาร์จ iphone ไหมครับ",
                claim_state={"name": "สมชาย"},
                intent_result={"intent": "product_question"})
    assert d.action != "claim_collect"


def test_claim_state_plus_claim_signal_collects():
    d = _decide("ส่งเบอร์โทรมาแล้ว 0812345678 เคลม",
                claim_state={"name": "สมชาย"})
    assert d.action == "claim_collect"


# ── 7-9. follow-up / product / general / unknown ─────────────────────────────

def test_comparison_followup_with_history():
    d = _decide("ต่างกันยังไงครับ",
                history=[{"role": "user", "text": "สนใจ X1 กับ X2"}])
    assert d.action == "followup"


def test_intent_product_question():
    d = _decide("มีสายชาร์จ type c ไหม",
                intent_result={"intent": "product_question"})
    assert d.action == "answer_product"


def test_general_question_keyword():
    d = _decide("รับประกันกี่ปีครับ")
    assert d.action == "answer_general"


def test_unknown_fallback():
    d = _decide("x")
    assert d.action in ("unknown", "answer_product", "answer_general")


# ── Phase 1C: price/link follow-up needs context ────────────────────────────
_PROD_HISTORY = [
    {"role": "user", "text": "มีพาวเวอร์แบงค์แนะนำไหมครับ"},
    {"role": "model", "text": "มี AC65B กับ AC65B2 ค่ะ"},
]


def test_price_ask_with_history_is_followup():
    d = _decide("ราคาเท่าไหร่", history=_PROD_HISTORY)
    assert d.action == "followup", d
    assert "price_followup" in d.flags


def test_link_ask_with_history_is_followup():
    d = _decide("ขอลิงค์", history=_PROD_HISTORY)
    assert d.action == "followup", d
    assert "link_followup" in d.flags


def test_price_ask_without_history_not_product():
    # bare price ask ลอยๆ — ไม่มี anchor/context → ไม่ใช่ product/followup
    d = _decide("ราคาเท่าไหร่")
    assert d.action not in ("followup", "answer_product"), d


def test_link_ask_non_product_link_not_followup():
    # "ขอลิงค์สมัครสมาชิก" — link ที่ไม่ใช่ product link (exclusion family)
    d = _decide("ขอลิงค์สมัครสมาชิก", history=_PROD_HISTORY)
    assert not (d.action == "followup" and "link_followup" in d.flags), d


def test_price_adjective_without_history_not_followup():
    d = _decide("ราคาแพงไหม")
    assert d.action != "followup", d


# ── Phase 1C gate: price/link needs *product* context, not any history ──────

def test_price_ask_after_greeting_history_not_followup():
    d = _decide("ราคาเท่าไหร่",
                history=[{"role": "user", "text": "สวัสดีครับ"}])
    assert d.action != "followup", d


def test_link_ask_after_human_request_history_not_followup():
    d = _decide("ขอลิงค์",
                history=[{"role": "user", "text": "ขอคุยกับแอดมิน"}])
    assert d.action != "followup", d


def test_price_ask_after_claim_history_not_followup():
    d = _decide("ราคาเท่าไหร่",
                history=[{"role": "user", "text": "สินค้าเสียขอเคลม"}])
    assert d.action != "followup", d


def test_price_ask_after_product_history_is_followup():
    d = _decide("ราคาเท่าไหร่",
                history=[{"role": "model", "text": "มี AC65B กับ AC65B2 ค่ะ"}])
    assert d.action == "followup", d


def test_link_ask_after_product_history_is_followup():
    d = _decide("ขอลิงค์",
                history=[{"role": "model", "text": "มี CTC615P สายชาร์จค่ะ"}])
    assert d.action == "followup", d


# ── Phase 1C: contact-info fill is not a product query ───────────────────────

def test_phone_only_with_claim_state_collects():
    d = _decide("0812345678", claim_state={"customer_name": "สมชาย"})
    assert d.action == "claim_collect", d


def test_phone_only_without_claim_state_not_product():
    d = _decide("0812345678")
    assert d.action != "answer_product", d
    assert "contact_info" in d.flags


def test_order_id_only_without_claim_state_not_product():
    d = _decide("2508088B5T4W1D")
    assert d.action != "answer_product", d


def test_model_code_still_product():
    # numeric-looking model code ต้องไม่พังจาก contact-info rule
    d = _decide("ctc615")
    assert d.action == "answer_product", d


# ── Phase 1C: cert standards question → cert evidence path ──────────────────

def test_cert_question_is_cert_flagged_product():
    d = _decide("ตัวไหนมี มอก. บ้าง", history=_PROD_HISTORY)
    assert d.action == "answer_product", d
    assert "cert_question" in d.flags


# ── Phase 1D: stock/select questions — context-gated like price/link ─────────

def test_stock_ask_with_product_history_is_followup():
    d = _decide("รุ่นนี้ยังมีขายไหมครับ", history=_PROD_HISTORY)
    assert d.action == "followup", d
    assert "stock_followup" in d.flags


def test_select_ask_with_product_history_is_followup():
    d = _decide("มีตัวไหนบ้าง", history=_PROD_HISTORY)
    assert d.action == "followup", d
    assert "select_followup" in d.flags


def test_stock_ask_without_history_not_followup():
    d = _decide("รุ่นนี้ยังมีขายไหมครับ")
    assert d.action not in ("followup", "answer_product"), d


def test_select_ask_after_greeting_history_not_followup():
    d = _decide("มีตัวไหนบ้าง",
                history=[{"role": "user", "text": "สวัสดีครับ"}])
    assert d.action != "followup", d


def test_select_ask_after_claim_history_not_followup():
    d = _decide("มีตัวไหนบ้าง",
                history=[{"role": "user", "text": "สินค้าเสียขอเคลม"}])
    assert d.action != "followup", d


# ── Phase 1D: name-only claim fill ───────────────────────────────────────────

def test_name_only_with_claim_state_collects():
    d = _decide("ชื่อ สมชาย ใจดี", claim_state={"stage": "collecting"})
    assert d.action == "claim_collect", d


def test_name_only_without_claim_state_unknown():
    d = _decide("ชื่อ สมชาย ใจดี")
    assert d.action == "unknown", d
    assert "contact_info" in d.flags


def test_product_query_with_claim_state_not_swallowed():
    # claim_state มีอยู่ แต่ข้อความเป็น product query จริง → ห้ามกลืนเป็น collect
    d = _decide("มี AC65B ไหมครับ", claim_state={"stage": "collecting"})
    assert d.action != "claim_collect", d


# ── shadow vs real fixtures (contract level, action boundary only) ───────────

def _fixture_rows():
    path = ROOT / "docs" / "test" / "fixtures" / "legacy_turn_incidents.jsonl"
    return [json.loads(l) for l in path.open() if l.strip()]


_ACTION_FAMILY = {
    "handoff": {"handoff"},
    "locked": {"locked"},
    # contract "unknown" defers to the legacy pipeline downstream — for an
    # expected-answer fixture that IS a compatible family outcome
    "answer": {"answer_product", "answer_general", "followup", "unknown"},
    "claim_collect": {"claim_collect", "claim_request"},
    "order_info": {"answer_general", "answer_product", "unknown"},
}
# incident fixtures whose legacy behavior is known-wrong — contract is
# allowed to differ from legacy here (they are why Phase 1 exists)
_KNOWN_INCIDENT_IDS = {"tx-q22q25-claim-persist", "iss30-multi-intent-claim-plus-product"}


def test_shadow_fixture_actions_contract():
    """decide_turn on real fixture first-turns must agree with the legacy
    action family — except rows already marked incident (known-broken
    legacy behavior; the contract documents the intended decision)."""
    mismatches = []
    for fx in _fixture_rows():
        exp = (fx.get("expected") or fx.get("expectation_note") or {})
        want = _ACTION_FAMILY.get(exp.get("action"))
        if not want or not fx.get("turns"):
            continue
        turn = fx["turns"][0]
        # ticket_state lives at fixture level (request-level field in prod)
        d = _decide(turn["text"],
                    ticket_state={"state": fx["ticket_state"]}
                    if fx.get("ticket_state") else None)
        # placeholder-only turn → "noise" is the correct owner decision even
        # where legacy produced a generic answer (noise-handler answers later)
        if d.action == "noise" and not d.normalized_message.strip():
            continue
        if d.action not in want and fx["id"] not in _KNOWN_INCIDENT_IDS:
            mismatches.append((fx["id"], d.action, sorted(want)))
    assert not mismatches, f"contract/legacy family mismatches: {mismatches}"
