#!/usr/bin/env python3
"""Test handoff transport truth + caller honesty — Phase 2B.2 final root-cause.

Findings covered:
A/B/C — `_send_handoff` = transport owner เดียว: typed-outcome truth (ไม่ใช่
HTTP 200 เฉยๆ), bounded retry ด้วย payload/identity เดิม, ไม่ retry บน
permanent failure, caller ทุก site ห้าม claim "ส่งแอดมินแล้ว" เมื่อ authoritative
outcome ไม่ใช่ assigned/queued

Contract:
- 2xx + outcome.state ∈ {assigned, queued} → success (คืน body)
- 2xx + failed/ไม่มี outcome → failure ทันที (ห้าม retry — contract violation)
- 401/403/404/422 → failure ทันที (no retry)
- 408/429/5xx/network/timeout → bounded retry ≤ max_attempts, payload เดิม
- exhausted → falsy — caller ห้ามตั้ง handoff_to_admin=True

รัน:  python3 docs/test/test_handoff_transport.py   (offline — mock urllib เท่านั้น)
"""
from __future__ import annotations

import json
import sys
import types
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "chatbot"))

import shopeechat.responses as _responses

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}  {detail}")


# ── urlopen harness ──────────────────────────────────────────────────────────

def _body(outcome_state: str | None = "assigned", **extra) -> bytes:
    payload = {"ok": True}
    if outcome_state is not None:
        payload["outcome"] = {
            "state": outcome_state,
            "assigned_to": "admin-1" if outcome_state == "assigned" else None,
            "assigned_to_name": "Admin One" if outcome_state == "assigned" else None,
            "persisted": outcome_state in ("assigned", "queued"),
            "reason": "round_robin",
            "error_code": None,
            "reopened": False,
        }
        payload["assigned_to"] = payload["outcome"]["assigned_to"]
        payload["assigned_to_name"] = payload["outcome"]["assigned_to_name"]
        payload["assignment_reason"] = "round_robin"
    payload.update(extra)
    return json.dumps(payload).encode("utf-8")


class _Resp:
    def __init__(self, raw: bytes):
        self._raw = raw

    def read(self) -> bytes:
        return self._raw


def _http(code: int):
    return urllib.error.HTTPError("http://x/handoff", code, f"e{code}", {}, None)


def _req(**kw):
    base = dict(conversation_id="c1", shop="s1", platform="shopee",
                simulate_assignment=False, test_source=None)
    base.update(kw)
    return types.SimpleNamespace(**base)


def _run(script: list, **kw):
    """run _send_handoff with scripted urlopen outcomes → (result, calls, payloads)."""
    calls: list[bytes] = []

    def _fake_urlopen(request, timeout=None):
        calls.append(request.data)
        item = script[min(len(calls) - 1, len(script) - 1)]
        if isinstance(item, Exception):
            raise item
        return _Resp(item)

    with patch("urllib.request.urlopen", side_effect=_fake_urlopen), \
         patch("time.sleep", lambda *_a, **_k: None):
        result = _responses._send_handoff(_req(), None, reason="test", **kw)
    return result, calls


# ═══ T. _send_handoff transport contract ═══

print("== T1-T4 outcome truth ==")

r, calls = _run([_body("assigned")])
check("T1 2xx+assigned → success body", bool(r) and r["outcome"]["state"] == "assigned",
      f"result={r}")
check("T1b 1 call only", len(calls) == 1, f"calls={len(calls)}")

r, calls = _run([_body("queued")])
check("T2 2xx+queued (pending persisted) → success", bool(r), f"result={r}")

r, calls = _run([_body("failed")])
check("T3 2xx+failed outcome → falsy (typed truth ไม่ใช่ HTTP เฉยๆ)",
      not r and len(calls) == 1, f"result={r} calls={len(calls)}")

r, calls = _run([_body(None)])
check("T4 2xx ไม่มี outcome field → falsy (ห้าม derive จาก compat fields)",
      not r and len(calls) == 1, f"result={r} calls={len(calls)}")

print("== T5-T10 retry matrix ==")

r, calls = _run([_http(503), _http(503), _body("assigned")])
check("T5 503,503,200 → bounded retry → success", bool(r) and len(calls) == 3,
      f"result={r} calls={len(calls)}")

r, calls = _run([_http(503)] * 5)
check("T6 503 always → exhausted bounded → falsy", not r and len(calls) == 3,
      f"calls={len(calls)}")

r, calls = _run([_http(404)] * 5)
check("T7 404 → zero retry", not r and len(calls) == 1, f"calls={len(calls)}")

r401, c401 = _run([_http(401)] * 5)
r422, c422 = _run([_http(422)] * 5)
check("T8 401/422 → zero retry", not r401 and len(c401) == 1 and not r422 and len(c422) == 1,
      f"401={len(c401)} 422={len(c422)}")

r, calls = _run([urllib.error.URLError("conn refused")] * 5)
check("T9 network error → bounded retry → falsy", not r and len(calls) == 3,
      f"calls={len(calls)}")

r, calls = _run([_http(429), _body("assigned")])
check("T10 429 → retried once → success", bool(r) and len(calls) == 2,
      f"calls={len(calls)}")

check("T10b retry payload = bytes เดิม (same identity)", len(set(calls)) == 1,
      f"payloads={calls}")

# ═══ C. caller honesty — ห้ามบอกลูกค้าว่าส่งแอดมินเมื่อ failed ═══

print("== C. caller-level: stub app/llm modules ==")

# stub shopeechat.app / llm / product_store / warranty / conversation_products —
# caller modules import ภายใน function → resolve จาก sys.modules
_llm_stub = types.ModuleType("shopeechat.llm")
_llm_stub.split_segments = lambda s: [s] if s else []
_llm_stub.LLM_ERROR_REPLY = "__llm_error__"
sys.modules["shopeechat.llm"] = _llm_stub

_app_stub = types.ModuleType("shopeechat.app")
_app_stub._send_handoff = _responses._send_handoff   # real transport (urlopen patched)
_app_stub._routing = _responses._routing
sys.modules["shopeechat.app"] = _app_stub

sys.modules.setdefault("shopeechat.product_store", types.ModuleType("shopeechat.product_store"))
sys.modules.setdefault("shopeechat.warranty", types.ModuleType("shopeechat.warranty"))

_cp_stub = types.ModuleType("shopeechat.conversation_products")
_cp_calls: list[str] = []
_cp_stub.update_claim_state = lambda *a, **k: _cp_calls.append("update")
_cp_stub.clear_claim_state = lambda *a, **k: _cp_calls.append("clear")
sys.modules["shopeechat.conversation_products"] = _cp_stub

import shopeechat.handoffs as _handoffs_mod
import shopeechat.warranty_flow as _wf_mod
import shopeechat.guards as _guards_mod
import shopeechat.chatbotv3.engine as _v3_mod


def _script_urlopen(script: list):
    calls: list[bytes] = []

    def _fake(request, timeout=None):
        calls.append(request.data)
        item = script[min(len(calls) - 1, len(script) - 1)]
        if isinstance(item, Exception):
            raise item
        return _Resp(item)

    return calls, _fake


print("== C1 human_request caller (handoffs.detect_human_request) ==")

_ctx = {"steps": [], "timing_breakdown": {}, "total_start": 0.0,
        "image_desc_out": "", "model_name": "m"}

calls, fake = _script_urlopen([_body("assigned")])
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _handoffs_mod.detect_human_request(
        _req(message="ขอคุยกับแอดมินหน่อย", ticket_state=None), dict(_ctx))
check("C1a success → handoff_to_admin=True + claim answer",
      res is not None and res.get("handoff_to_admin") is True
      and "ส่งต่อ" in (res.get("answer") or ""),
      f"res={res and res.get('handoff_to_admin')} answer={res and res.get('answer')}")

calls, fake = _script_urlopen([_http(503)] * 5)
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _handoffs_mod.detect_human_request(
        _req(message="ขอคุยกับแอดมินหน่อย", ticket_state=None), dict(_ctx))
check("C1b exhausted → handoff_to_admin=False + ไม่ claim ส่งแอดมิน",
      res is not None and res.get("handoff_to_admin") is False
      and "ส่งต่อ" not in (res.get("answer") or ""),
      f"flag={res and res.get('handoff_to_admin')} answer={res and res.get('answer')}")
check("C1c transport retried bounded (3)", len(calls) == 3, f"calls={len(calls)}")

print("== C2 tax_invoice caller (handoffs.post_intent_handoffs) ==")

_tax_ctx = dict(_ctx, is_tax_invoice=True, bot_name="ทางร้าน")

calls, fake = _script_urlopen([_body("assigned")])
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _handoffs_mod.post_intent_handoffs(
        _req(message="ขอใบกำกับภาษี", ticket_state=None), dict(_tax_ctx), None)
check("C2a success → flag True + tax claim answer",
      res is not None and res.get("handoff_to_admin") is True
      and "ใบกำกับ" in (res.get("answer") or ""),
      f"res={res and res.get('handoff_to_admin')}")

calls, fake = _script_urlopen([_http(503)] * 5)
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _handoffs_mod.post_intent_handoffs(
        _req(message="ขอใบกำกับภาษี", ticket_state=None), dict(_tax_ctx), None)
check("C2b exhausted → flag False + ไม่ claim",
      res is not None and res.get("handoff_to_admin") is False
      and "ส่งต่อ" not in (res.get("answer") or ""),
      f"flag={res and res.get('handoff_to_admin')} answer={res and res.get('answer')}")

print("== C3 warranty tax follow-up (warranty_flow._handle_tax_invoice_followup — canonical owner) ==")

_warranty_mod = types.SimpleNamespace(detect_consent=lambda m: False)
_history = [{"role": "model", "text": "เรื่องใบกำกับภาษี รบกวนแจ้งข้อมูลนะคะ"}]

calls, fake = _script_urlopen([_body("assigned")])
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _wf_mod._handle_tax_invoice_followup(
        _req(message="เลขผู้เสียภาษี 0123456789012"), dict(_ctx), _history,
        _warranty_mod, _app_stub, _llm_stub)
check("C3a success → flag True", res is not None and res.get("handoff_to_admin") is True,
      f"res={res and res.get('handoff_to_admin')}")

calls, fake = _script_urlopen([_http(503)] * 5)
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _wf_mod._handle_tax_invoice_followup(
        _req(message="เลขผู้เสียภาษี 0123456789012"), dict(_ctx), _history,
        _warranty_mod, _app_stub, _llm_stub)
check("C3b exhausted → flag False + ไม่ claim ส่งแอดมิน",
      res is not None and res.get("handoff_to_admin") is False
      and "ส่งต่อ" not in (res.get("answer") or ""),
      f"flag={res and res.get('handoff_to_admin')} answer={res and res.get('answer')}")
check("C3c transport = bounded retry owner เดียว (3 calls, ไม่ fire-and-forget)",
      len(calls) == 3, f"calls={len(calls)}")

print("== C4 warranty claim response builder (canonical owner + claim_state) ==")

_claim_ctx = {"handoff_reason": "warranty_claim_in_warranty", "order_id": "o1"}
# answer ต้องไม่มี "รบกวนแจ้งข้อมูล"/"ได้รับข้อมูล" — marker พวกนั้นคือ keep-collecting
# guard ของ _maybe_clear_claim_state (clear ถูก skip โดยเจตนา)

_cp_calls.clear()
calls, fake = _script_urlopen([_body("assigned")])
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _wf_mod._build_warranty_claim_response(
        _req(), dict(_ctx), "แจ้งแอดมินดำเนินการเคลมให้แล้วนะคะ", True, dict(_claim_ctx),
        _app_stub, _llm_stub)
check("C4a success → flag True + claim_state cleared (terminal จริง)",
      res.get("handoff_to_admin") is True and "clear" in _cp_calls,
      f"flag={res.get('handoff_to_admin')} cp={_cp_calls}")

_cp_calls.clear()
calls, fake = _script_urlopen([_http(503)] * 5)
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _wf_mod._build_warranty_claim_response(
        _req(), dict(_ctx), "แจ้งแอดมินดำเนินการเคลมให้แล้วนะคะ", True, dict(_claim_ctx),
        _app_stub, _llm_stub)
check("C4b exhausted → flag False + claim_state ห้าม clear (terminal flag โกหก)",
      res.get("handoff_to_admin") is False and "clear" not in _cp_calls,
      f"flag={res.get('handoff_to_admin')} cp={_cp_calls}")
check("C4c exhausted → ไม่ claim ส่งแอดมินใน answer",
      "ส่งต่อ" not in (res.get("answer") or ""),
      f"answer={res.get('answer')}")

print("== C5 guards._escalate (claim-consistency boundary) ==")

def _mk_resp():
    return types.SimpleNamespace(
        answer="แอดมินมาดูแลแล้วค่ะ", answer_segments=["แอดมินมาดูแลแล้วค่ะ"],
        handoff_to_admin=False, handoff_reason=None, routing_decision={})

calls, fake = _script_urlopen([_body("assigned")])
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    resp = _mk_resp()
    _guards_mod._escalate(resp, _req(), reason="guard_admin_came", rule_name="admin_came",
                          new_answer="เดี๋ยวส่งต่อให้แอดมินดูแลให้นะคะ")
check("C5a success → handoff_to_admin=True", resp.handoff_to_admin is True,
      f"flag={resp.handoff_to_admin}")

calls, fake = _script_urlopen([_http(503)] * 5)
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    resp = _mk_resp()
    _guards_mod._escalate(resp, _req(), reason="guard_admin_came", rule_name="admin_came",
                          new_answer="เดี๋ยวส่งต่อให้แอดมินดูแลให้นะคะ")
check("C5b exhausted → handoff_to_admin=False (ห้าม claim)",
      resp.handoff_to_admin is False, f"flag={resp.handoff_to_admin}")
check("C5c exhausted → answer ไม่ claim ส่งแอดมิน",
      "ส่งต่อ" not in (resp.answer or ""), f"answer={resp.answer}")

print("== C6 chatbotv3 transport (shared owner) ==")

calls, fake = _script_urlopen([_http(503), _body("assigned")])
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    ok = _v3_mod._send_handoff_to_admin("c1", "s1", "shopee", "test_reason")
check("C6a 503→200 → truthy (bounded retry shared transport)", bool(ok) and len(calls) == 2,
      f"ok={ok} calls={len(calls)}")

calls, fake = _script_urlopen([_http(404)] * 5)
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    ok = _v3_mod._send_handoff_to_admin("c1", "s1", "shopee", "test_reason")
check("C6b 404 → falsy + zero retry (permanent)", not ok and len(calls) == 1,
      f"ok={ok} calls={len(calls)}")

calls, fake = _script_urlopen([_http(503)] * 5)
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    ok = _v3_mod._send_handoff_to_admin("c1", "s1", "shopee", "test_reason")
check("C6c exhausted → falsy + bounded (3)", not ok and len(calls) == 3,
      f"ok={ok} calls={len(calls)}")

# ═══ L. legacy path closure — production entry handle_warranty_flow_legacy ═══
#   legacy duplicates ต้อง delegate ไป canonical owner — ห้าม crash/claim เมื่อ transport fail
#
# warranty module stub — handle_warranty_flow_legacy ทำ `from . import warranty`
# ภายใน function → resolve sys.modules["shopeechat.warranty"] (empty ModuleType)
# → populate attrs ที่ SM เรียกจริงก่อนถึง branches ที่ทดสอบ
_warranty_stub = sys.modules["shopeechat.warranty"]
_warranty_stub.parse_purchase_date = lambda _m: None
_warranty_stub.extract_customer_info = lambda _m: {"name": None, "phone": None, "order_id": None}
_warranty_stub.detect_confirmation = lambda _m: False
_warranty_stub.detect_consent = lambda _m: False
_warranty_stub.detect_claim_request = lambda _m: False
_warranty_stub.detect_tax_invoice_request = lambda _m: False
_warranty_stub.malfunction_safe_check = lambda _m: ""
_warranty_stub.is_in_warranty = lambda *_a: {}

# knowledge_base stub — first-message claim block เรียก qa_troubleshoot_tips
_kb_stub = types.ModuleType("shopeechat.knowledge_base")
_kb_stub.qa_troubleshoot_tips = lambda *a, **k: None
sys.modules["shopeechat.knowledge_base"] = _kb_stub

# conversation_products stub เพิ่ม load_claim_state (collecting gate อ่าน)
_cp_stub.load_claim_state = lambda *a, **k: {}

_legacy_ctx = dict(_ctx, is_tax_invoice=False, is_claim_request=False,
                   is_followup_policy=False, warranty_auto_answer="",
                   warranty_auto_ctx="", qa10=[], intent_result={},
                   anchor_compare_ctx=None, bot_name="ทางร้าน")

print("== L1 legacy tax follow-up (handle_warranty_flow_legacy — production entry) ==")

_history_tax = [{"role": "model", "text": "เรื่องใบกำกับภาษี รบกวนแจ้งข้อมูลนะคะ"}]

calls, fake = _script_urlopen([_body("assigned")])
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _wf_mod.handle_warranty_flow_legacy(
        _req(message="เลขผู้เสียภาษี 0123456789012", ticket_state=None),
        dict(_legacy_ctx), _history_tax, None)
check("L1a success → handoff_to_admin=True + tax answer",
      res is not None and res.get("handoff_to_admin") is True
      and "ใบกำกับ" in (res.get("answer") or ""),
      f"res={res and res.get('handoff_to_admin')} answer={res and res.get('answer')}")

calls, fake = _script_urlopen([_http(503)] * 5)
_crash = None
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    try:
        res = _wf_mod.handle_warranty_flow_legacy(
            _req(message="เลขผู้เสียภาษี 0123456789012", ticket_state=None),
            dict(_legacy_ctx), _history_tax, None)
    except Exception as _e:
        res, _crash = None, _e
check("L1b exhausted → ไม่ throw + flag False + ไม่ claim ส่งแอดมิน",
      _crash is None and res is not None
      and res.get("handoff_to_admin") is False
      and not res.get("handoff_reason")
      and "ส่งต่อ" not in (res.get("answer") or ""),
      f"crash={_crash} flag={res and res.get('handoff_to_admin')} "
      f"reason={res and res.get('handoff_reason')} answer={res and res.get('answer')}")
check("L1c transport retried bounded (3)", len(calls) == 3, f"calls={len(calls)}")

print("== L2 legacy first-message claim (handle_warranty_flow_legacy) ==")

_claim_ctx_legacy = dict(_legacy_ctx, is_claim_request=True)

calls, fake = _script_urlopen([_body("assigned")])
_cp_calls.clear()
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    res = _wf_mod.handle_warranty_flow_legacy(
        _req(message="สินค้าใช้ไม่ได้เลย ขอเคลม", ticket_state=None, item_id=None),
        dict(_claim_ctx_legacy), [], None)
check("L2a success → flag True + claim ctx preserved (ask-info answer ไม่ clear)",
      res is not None and res.get("handoff_to_admin") is True
      and "clear" not in _cp_calls,
      f"flag={res and res.get('handoff_to_admin')} cp={_cp_calls}")

calls, fake = _script_urlopen([_http(503)] * 5)
_cp_calls.clear()
_crash = None
with patch("urllib.request.urlopen", side_effect=fake), \
     patch("time.sleep", lambda *_a, **_k: None):
    try:
        res = _wf_mod.handle_warranty_flow_legacy(
            _req(message="สินค้าใช้ไม่ได้เลย ขอเคลม", ticket_state=None, item_id=None),
            dict(_claim_ctx_legacy), [], None)
    except Exception as _e:
        res, _crash = None, _e
check("L2b exhausted → ห้าม AttributeError/crash",
      _crash is None, f"crash={_crash}")
check("L2c exhausted → flag False + answer ไม่ claim ส่งแอดมิน + claim_state ไม่ clear",
      res is not None and res.get("handoff_to_admin") is False
      and "ส่งต่อ" not in (res.get("answer") or "")
      and "clear" not in _cp_calls,
      f"flag={res and res.get('handoff_to_admin')} answer={res and res.get('answer')} cp={_cp_calls}")

print("== L3 legacy review request (handle_warranty_flow_legacy — production entry) ==")

# review branch: msg "ทวนข้อมูล" + last model msg มี warranty kw → delegate
#   _handle_review_request — arg order ต้องตรง signature (…,_warranty_mod,llm,_app_module)
_history_review = [
    {"role": "user", "text": "สินค้าใช้ไม่ได้เลย ขอเคลม"},
    {"role": "model", "text": "รบกวนแจ้งข้อมูลดังนี้เพื่อตรวจสอบสิทธิ์การรับประกันค่ะ"},
]
_crash = None
try:
    res = _wf_mod.handle_warranty_flow_legacy(
        _req(message="ทวนข้อมูลที่ให้ไปหน่อยค่ะ", ticket_state=None, item_id=None),
        dict(_legacy_ctx), _history_review, None)
except Exception as _e:
    res, _crash = None, _e
check("L3a review → ไม่ crash", _crash is None, f"crash={_crash}")
check("L3b review resp — segments จาก llm + routing จาก app + contract fields เดิม",
      res is not None
      and res.get("answer_segments") == [res.get("answer")]
      and res.get("handoff_to_admin") is True
      and res.get("handoff_reason") == "review_request"
      and res.get("source") == "warranty_claim_flow"
      and isinstance(res.get("routing_decision"), dict)
      and res["routing_decision"].get("path") == "handoff"
      and res["routing_decision"].get("handoff_reason") == "review_request",
      f"res={res and {k: res.get(k) for k in ('answer_segments','handoff_to_admin','handoff_reason','source','routing_decision')}}")

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(0 if FAIL == 0 else 1)
