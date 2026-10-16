"""responses.py — helper การตอบ/routing ที่ย้ายออกจาก app.py (Task 9).

รวมฟังก์ชันสร้าง response/routing ที่เป็น module-level และ self-contained
เพื่อให้ app.py บางลง และ module อื่น (units/guards) ใช้ได้โดยไม่ import app
"""
from __future__ import annotations

import json
import os
import sys


def _routing(
    path: str,
    reason: str,
    *,
    trigger_matched: str | None = None,
    shop_settings_action: str | None = None,
    assigned_admin: str | None = None,
    assigned_admin_name: str | None = None,
    handoff_reason: str | None = None,
) -> dict:
    """สร้าง routing_decision dict สำหรับ observability"""
    return {
        "path": path,
        "reason": reason,
        "trigger_matched": trigger_matched,
        "shop_settings_action": shop_settings_action,
        "assigned_admin": assigned_admin,
        "assigned_admin_name": assigned_admin_name,
        "handoff_reason": handoff_reason,
    }


# คำตอบกลางเมื่อ handoff ไม่สำเร็จ — caller ทุก site ใช้ชุดเดียว
#   (ไม่มีคำว่า "ส่งต่อ/ส่งแอดมิน" — ห้าม claim เมื่อ authoritative outcome ไม่ใช่ assigned/queued)
HANDOFF_FAILED_REPLY = (
    "ขออภัยค่ะ ตอนนี้ระบบติดต่อแอดมินไม่สำเร็จชั่วคราว "
    "รบกวนลองส่งข้อความอีกครั้งในสักครู่นะคะ"
)

_HANDOFF_MAX_ATTEMPTS = 3
# retryable = 408/429/5xx + network/timeout; HTTP code อื่น (401/403/404/422/4xx) = permanent


def _send_handoff(req, ctx: dict | None = None, *, reason: str, claim_topic: str = "",
                  claim: dict | None = None, simulate: bool = False,
                  timeout: float = 3.0, log_tag: str = "HANDOFF",
                  episode_id: str | None = None) -> dict | None:
    """ส่ง handoff ไปแอดมิน — transport owner เดียวของฝั่ง Python.

    Contract (typed outcome เป็น authority — ไม่ใช่ HTTP status เฉยๆ):
      - 2xx + outcome.state ∈ {assigned, queued} → คืน response dict (persisted แล้ว)
      - 2xx + failed/ไม่มี outcome → None ทันที (contract violation — retry ก็ได้คำตอบเดิม)
      - 401/403/404/422/4xx อื่น → None ทันที (permanent — ห้าม blind retry)
      - 408/429/5xx/network/timeout → bounded retry ≤3 attempts ด้วย payload เดิม
        (identity เดิม → eid dedupe ฝั่ง server ทำให้ audit exactly-once)
      - exhausted → None — caller ห้ามตั้ง handoff_to_admin=True / บอกลูกค้าว่าส่งแล้ว

    Args:
        req: ChatRequest (มี conversation_id, shop, platform, simulate_assignment, test_source)
        ctx: context dict จาก chat_v2 (ไม่ใช้ในฟังก์ชันนี้ แต่รับไว้เพื่อ signature consistency)
        reason: เหตุผล handoff (เช่น 'tax_invoice_request', 'human_request')
        claim_topic: หัวข้อ claim — shortcut ของ claim={"topic": claim_topic}
        claim: dict claim เต็ม (override claim_topic)
        simulate: ใส่ key "simulate" ใน payload (ค่าจาก req.simulate_assignment)
        timeout: urllib timeout ต่อ attempt (วินาที)
        log_tag: prefix ของ log line
        episode_id: open claim episode ที่ caller derive จาก authoritative
            claim_state เอง — transport owner ไม่อ่าน claim state/Mongo เอง
    Returns:
        parsed response dict เมื่อ authoritative handoff ยืนยัน, None เมื่อไม่สำเร็จ
    """
    if not req.conversation_id:
        return None
    if claim is None:
        claim = {"topic": claim_topic} if claim_topic else {}
    try:
        import time
        import urllib.request
        import urllib.error
        _handoff_url = os.environ.get(
            "ADMIN_HANDOFF_URL",
            "http://127.0.0.1:3000/api/admin/conversations/bot-handoff",
        )
        _payload = {
            "conversation_id": req.conversation_id,
            "shop_id": req.shop or "",
            "platform": req.platform or "shopee",
            "reason": reason,
            "claim": claim,
        }
        if simulate:
            _payload["simulate"] = req.simulate_assignment
        # ⚡ botworker parallel — ส่ง test_source ให้ admin route เขียน test_status_conversation
        _test_source = getattr(req, "test_source", None)
        if _test_source:
            _payload["test_source"] = _test_source
        # ⚡ Phase 2B.6 — open claim episode_id (explicit — caller ที่ถือ
        #   authoritative claim_state ส่งมา; transport ไม่อ่าน claim state เอง)
        #   → status_conversation.active_claim_episode_id = เป้าหมายของ admin outcome
        if episode_id:
            _payload["episode_id"] = episode_id
        # body เดิมทุก attempt — identity เดิม (request retry = converge เดิม)
        _body = json.dumps(_payload).encode("utf-8")
        _headers = {
            "Content-Type": "application/json",
            "X-Internal-Secret": os.environ.get("CHATBOT_INTERNAL_SECRET", ""),
        }
        for _attempt in range(1, _HANDOFF_MAX_ATTEMPTS + 1):
            _handoff_req = urllib.request.Request(
                _handoff_url, data=_body, headers=_headers, method="POST",
            )
            try:
                _resp = urllib.request.urlopen(_handoff_req, timeout=timeout)
            except urllib.error.HTTPError as _he:
                _retryable = _he.code in (408, 429) or _he.code >= 500
                if not _retryable or _attempt >= _HANDOFF_MAX_ATTEMPTS:
                    print(f"[{log_tag}] handoff HTTP {_he.code}"
                          f"{' exhausted' if _retryable else ' permanent'}: {_he.reason}",
                          file=sys.stderr)
                    return None
                print(f"[{log_tag}] handoff HTTP {_he.code} → retry {_attempt}/{_HANDOFF_MAX_ATTEMPTS}",
                      file=sys.stderr)
                time.sleep(0.2 * _attempt)
                continue
            except Exception as _he:
                # network/DNS/timeout — retryable
                if _attempt >= _HANDOFF_MAX_ATTEMPTS:
                    print(f"[{log_tag}] handoff failed exhausted: {_he}", file=sys.stderr)
                    return None
                print(f"[{log_tag}] handoff error → retry {_attempt}/{_HANDOFF_MAX_ATTEMPTS}: {_he}",
                      file=sys.stderr)
                time.sleep(0.2 * _attempt)
                continue
            try:
                _result = json.loads(_resp.read().decode("utf-8"))
            except Exception:
                _result = {}
            _state = str(((_result.get("outcome") or {}).get("state")) or "").lower()
            if _state in ("assigned", "queued"):
                print(f"[{log_tag}] handoff confirmed: reason={reason} state={_state}",
                      file=sys.stderr)
                return _result
            # 2xx แต่ outcome ไม่ยืนยัน → truth ไม่ได้ persist — retry ก็ได้คำตอบเดิม
            print(f"[{log_tag}] handoff 2xx but outcome.state={_state or 'missing'} → not confirmed",
                  file=sys.stderr)
            return None
    except Exception as _e:
        print(f"[{log_tag}] handoff setup error: {_e}", file=sys.stderr)
    return None
