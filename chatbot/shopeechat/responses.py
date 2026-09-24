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


def _send_handoff(req, ctx: dict | None = None, *, reason: str, claim_topic: str = "",
                  claim: dict | None = None, simulate: bool = False,
                  timeout: float = 3.0, log_tag: str = "HANDOFF") -> dict:
    """ส่ง handoff ไปแอดมิน (best-effort) — ใช้ร่วม legacy chat() + chat_v2.

    Args:
        req: ChatRequest (มี conversation_id, shop, platform, simulate_assignment)
        ctx: context dict จาก chat_v2 (ไม่ใช้ในฟังก์ชันนี้ แต่รับไว้เพื่อ signature consistency)
        reason: เหตุผล handoff (เช่น 'tax_invoice_request', 'human_request')
        claim_topic: หัวข้อ claim — shortcut ของ claim={"topic": claim_topic}
        claim: dict claim เต็ม (override claim_topic)
        simulate: ใส่ key "simulate" ใน payload (ค่าจาก req.simulate_assignment)
        timeout: urllib timeout (วินาที)
        log_tag: prefix ของ log line
    Returns:
        parsed response dict จาก admin API หรือ {} ถ้าไม่ได้ส่ง/ส่งไม่สำเร็จ
    """
    if not req.conversation_id:
        return {}
    if claim is None:
        claim = {"topic": claim_topic} if claim_topic else {}
    try:
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
        _body = json.dumps(_payload).encode("utf-8")
        _handoff_req = urllib.request.Request(
            _handoff_url,
            data=_body,
            headers={
                "Content-Type": "application/json",
                "X-Internal-Secret": os.environ.get("CHATBOT_INTERNAL_SECRET", ""),
            },
            method="POST",
        )
        try:
            _resp = urllib.request.urlopen(_handoff_req, timeout=timeout)
            try:
                _result = json.loads(_resp.read().decode("utf-8"))
            except Exception:
                _result = {}
            print(f"[{log_tag}] handoff sent: reason={reason}", file=sys.stderr)
            return _result
        except urllib.error.HTTPError as _he:
            print(f"[{log_tag}] handoff HTTP error: {_he.code} {_he.reason}", file=sys.stderr)
        except Exception as _he:
            print(f"[{log_tag}] handoff failed: {_he}", file=sys.stderr)
    except Exception as _e:
        print(f"[{log_tag}] handoff setup error: {_e}", file=sys.stderr)
    return {}
