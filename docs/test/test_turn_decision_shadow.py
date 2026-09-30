"""Revised Phase 1B — TurnDecision shadow wiring tests (observe-only).

Shadow contract: app.chat() runs decide_turn() as a trace-only step
("TurnDecisionShadow") behind USE_TURN_DECISION_SHADOW=1 (default OFF).
The shadow must never change the response: no early return, no mutation,
exceptions collapse into ok=False trace — never a failed chat.

PII contract: the trace carries action/reason/confidence/flags/message_len
only — never raw customer text or history.

Run:  .venv/bin/python -m pytest docs/test/test_turn_decision_shadow.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "docs" / "test"))
sys.path.insert(0, str(ROOT / "chatbot"))

# harness module installs its own import-time offline guards (dotenv trap,
# socket/mongo/urlopen tripwires) — importing it first makes this file safe
import test_legacy_turn_incident_replay as replay  # noqa: E402

app = replay.app  # shopeechat.app already under guards


def _fx(fid: str, text: str, **over) -> dict:
    fx = {
        "id": fid,
        "shop": "testshop",
        "platform": "shopee",
        "conversation_id": f"sh-{fid}",
        "catalog": [],
        "intent_result": {"intent": "other", "confidence": 0.5},
        "turns": [{"role": "user", "text": text}],
    }
    fx.update(over)
    return fx


def _shadow_steps(resp) -> list[dict]:
    return [s for s in (getattr(resp, "steps", None) or [])
            if s.get("name") == "TurnDecisionShadow"]


def _run(monkeypatch, fx, *, flag: str | None = "1"):
    """Install seams + optional flag, replay turns, return last record."""
    replay._install(monkeypatch, fx)
    if flag is None:
        monkeypatch.delenv("USE_TURN_DECISION_SHADOW", raising=False)
    else:
        monkeypatch.setenv("USE_TURN_DECISION_SHADOW", flag)
    history = list(fx.get("history_extra") or [])
    resp = None
    for turn in fx["turns"]:
        if turn.get("role", "user") != "user":
            history.append({"role": "model", "text": turn.get("text", "")})
            continue
        resp = app.chat(app.ChatRequest(
            message=turn["text"], shop=fx.get("shop"),
            platform=fx.get("platform", "shopee"),
            history=list(history),
            conversation_id=fx.get("conversation_id"),
            ticket_state=turn.get("ticket_state", fx.get("ticket_state")),
            limit=5, simulate_assignment=True, test_source="phase1b_shadow",
        ))
        history.append({"role": "user", "text": turn["text"]})
        history.append({"role": "model", "text": getattr(resp, "answer", "") or ""})
    return resp


def test_chat_route_still_points_to_chat_endpoint():
    """Regression: /chat POST route must bind to chat(), not the shadow
    helper — a decorator-placement slip once re-bound it (Phase 1B hotfix)."""
    routes = [
        r for r in app.app.routes
        if getattr(r, "path", None) == "/chat"
        and "POST" in getattr(r, "methods", set())
    ]
    assert routes, "missing /chat POST route"
    assert routes[0].endpoint.__name__ == "chat"


# ── flag / safety contract ─────────────────────────────────────────────────

def test_shadow_off_by_default(monkeypatch):
    resp = _run(monkeypatch, _fx("off", "สวัสดีครับ"), flag=None)
    assert resp is not None
    assert _shadow_steps(resp) == []


def test_shadow_on_appends_trace(monkeypatch):
    resp = _run(monkeypatch, _fx("on", "สวัสดีครับ"))
    steps = _shadow_steps(resp)
    assert len(steps) == 1
    s = steps[0]
    assert s["ok"] is True
    assert s["action"] in {
        "locked", "noise", "handoff", "claim_collect", "claim_request",
        "answer_product", "answer_general", "followup", "unknown",
    }
    assert isinstance(s["reason"], str) and s["reason"]
    assert isinstance(s["confidence"], (int, float))


def test_shadow_error_never_breaks_chat(monkeypatch):
    """decide_turn raising must collapse to ok=False — chat() unaffected."""
    fx = _fx("err", "สวัสดีครับ")
    replay._install(monkeypatch, fx)
    monkeypatch.setenv("USE_TURN_DECISION_SHADOW", "1")
    from shopeechat import turn_decision as _td
    monkeypatch.setattr(_td, "decide_turn",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    resp = app.chat(app.ChatRequest(
        message="สวัสดีครับ", shop="testshop", platform="shopee",
        conversation_id="sh-err", limit=5, simulate_assignment=True,
        test_source="phase1b_shadow"))
    assert resp is not None
    steps = _shadow_steps(resp)
    assert len(steps) == 1 and steps[0]["ok"] is False


def test_shadow_same_answer_on_and_off(monkeypatch):
    """Flag on must not change the answer (observe-only)."""
    fx = _fx("same", "สวัสดีครับ")
    off = _run(monkeypatch, fx, flag=None)
    on = _run(monkeypatch, fx, flag="1")
    assert on.answer == off.answer
    assert on.handoff_to_admin == off.handoff_to_admin


# ── trace hygiene (no PII) ─────────────────────────────────────────────────

def test_shadow_trace_no_raw_message(monkeypatch):
    resp = _run(monkeypatch, _fx("pii", "ขอเคลม โทร 0812345678"))
    assert _shadow_steps(resp), "shadow trace missing"
    s = _shadow_steps(resp)[0]
    for banned in ("message", "normalized_message", "history", "input",
                   "output"):
        assert banned not in s, f"trace leaked field {banned!r}"
    assert "0812345678" not in repr(s)


# ── decision content at the shadow boundary ────────────────────────────────

def test_shadow_placeholder_is_noise(monkeypatch):
    for ph in ("[faq_liveagent]", "[bundle_message]"):
        resp = _run(monkeypatch, _fx(f"ph-{ph}", ph))
        s = _shadow_steps(resp)[0]
        assert s["ok"] is True and s["action"] == "noise", (ph, s)


def test_shadow_product_issue_not_handoff(monkeypatch):
    resp = _run(monkeypatch, _fx("prod", "ชาร์จแล้วไฟไม่เข้าเป็นที่อะไรครับ"))
    s = _shadow_steps(resp)[0]
    assert s["action"] in {"claim_request", "answer_product"}, s


def test_shadow_human_request_is_handoff(monkeypatch):
    resp = _run(monkeypatch, _fx("hr", "ขอคุยกับแอดมิน"))
    s = _shadow_steps(resp)[0]
    assert s["action"] == "handoff", s
    # legacy path also handoffs — parity at boundary, not forced
    assert resp.handoff_to_admin is True


def test_shadow_ticket_active_is_locked(monkeypatch):
    resp = _run(monkeypatch, _fx("lock", "สวัสดีครับ",
                                 ticket_state="open"))
    s = _shadow_steps(resp)[0]
    assert s["action"] == "locked", s


# ── fixture sweep — observe-only comparison data for Phase 1C ─────────────
# Runs EVERY fixture turn through chat() with shadow on. Asserts only that
# the shadow executed (ok=True step exists) — mismatches vs legacy outcomes
# are recorded in the printed report, never forced to pass.


def _legacy_family(rec) -> str:
    """Coarse legacy outcome family from a replay record (boundary only)."""
    resp = rec["resp"]
    if getattr(resp, "handoff_to_admin", False):
        return "handoff"
    return "answer"


def test_shadow_sweep_all_fixtures(monkeypatch, capsys):
    rows, bad = [], 0
    for fx in replay._load_fixtures():
        if (fx.get("expected") or {}).get("pending_live_replay"):
            continue
        records, _cap, _client = _run_records(monkeypatch, fx)
        for rec in records:
            steps = _shadow_steps(rec["resp"])
            if not steps:
                bad += 1
                rows.append((fx["id"], rec["turn"][:40], "MISSING", "", ""))
                continue
            s = steps[0]
            legacy = _legacy_family(rec)
            shadow = s.get("action") if s.get("ok") else f"ERROR:{s.get('error')}"
            rows.append((fx["id"], rec["turn"][:40], legacy, shadow,
                         "" if s.get("ok") else "ERR"))
    with capsys.disabled():
        print("\n=== TurnDecisionShadow sweep (observe-only) ===")
        for r in rows:
            print(" | ".join(str(x) for x in r))
        print(f"turns={len(rows)} missing={bad}")
    assert bad == 0, f"{bad} fixture turns produced no shadow trace"


def test_shadow_phase1c_hardened_cases(monkeypatch):
    """Pin the Phase 1C contract hardening at the shadow boundary —
    fixture turns that used to mismatch are now asserted."""
    want = {
        "tx-q08-price-followup": {"ราคาเท่าไหร่": "followup"},
        "tx-q09-link-followup": {"ขอลิงค์": "followup"},
        "tx-q10-cert-scope": {"ตัวไหนมี มอก. บ้าง": "answer_product"},
        "tx-q22q25-claim-persist": {"0812345678": "unknown"},
    }
    seen = set()
    for fx in replay._load_fixtures():
        if fx["id"] not in want:
            continue
        records, _cap, _client = _run_records(monkeypatch, fx)
        for rec in records:
            for text, act in want[fx["id"]].items():
                if rec["turn"].startswith(text):
                    steps = _shadow_steps(rec["resp"])
                    assert steps and steps[0]["ok"], (fx["id"], text, steps)
                    assert steps[0]["action"] == act, (fx["id"], text,
                                                     steps[0])
                    seen.add((fx["id"], text))
    missing = {(fid, t) for fid, m in want.items() for t in m} - seen
    assert not missing, f"fixture turns not found: {missing}"


def _run_records(monkeypatch, fx):
    """_install + flag on + replay; return full per-turn records."""
    replay._install(monkeypatch, fx)
    monkeypatch.setenv("USE_TURN_DECISION_SHADOW", "1")
    history = list(fx.get("history_extra") or [])
    records = []
    for turn in fx.get("turns", []):
        if turn.get("role", "user") != "user":
            history.append({"role": "model", "text": turn.get("text", "")})
            continue
        resp = app.chat(app.ChatRequest(
            message=turn["text"], shop=fx.get("shop"),
            platform=fx.get("platform", "shopee"),
            history=list(history),
            conversation_id=fx.get("conversation_id"),
            ticket_state=turn.get("ticket_state", fx.get("ticket_state")),
            limit=5, simulate_assignment=True, test_source="phase1b_shadow",
        ))
        records.append({"turn": turn["text"], "resp": resp})
        history.append({"role": "user", "text": turn["text"]})
        history.append({"role": "model", "text": getattr(resp, "answer", "") or ""})
    return records, None, None
