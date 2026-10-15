"""Phase 2C.1/2C.3 — TurnPlan shadow wiring tests (observe-only).

Shadow contract: app.chat() computes ONE authoritative TurnPlan post-classify
(consumed by production); the "TurnDecisionShadow" step serializes that same
plan behind USE_TURN_DECISION_SHADOW=1 (default OFF) — it never plans again.
Turns returning before classify carry no step (boundary lock, human request,
item-tag, order). Subject-view read failures yield empty plan inputs
(ok=True); decide_turn errors are fail-closed — chat() raises the existing
500 boundary, and the shadow step records ok=False (plan_unavailable).

PII contract: the trace carries ok/primary_action/needs[{kind,operation,
confidence,provenance}]/ownership/claim_stage/requires_clarification/flags/
message_len (or error type when ok=False) only — never raw customer text,
history, or subject_refs.

Run:  .venv/bin/python -m pytest docs/test/test_turn_decision_shadow.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "docs" / "test"))
sys.path.insert(0, str(ROOT / "chatbot"))

# harness module installs its own import-time offline guards (dotenv trap,
# socket/mongo/urlopen tripwires) — importing it first makes this file safe
import test_legacy_turn_incident_replay as replay  # noqa: E402
import validate_legacy_turn_fixtures as vfx  # noqa: E402
from shopeechat import conversation_products as _cp_shadow  # noqa: E402
from shopeechat import turn_decision as _td_mod  # noqa: E402

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
    assert s["primary_action"] in {
        "no_reply", "human_wait", "execute_needs", "handoff", "clarify",
    }
    assert isinstance(s["needs"], list)
    assert s["ownership"] in {"bot", "human", "unknown"}
    assert isinstance(s["requires_clarification"], bool)
    assert "action" not in s, "one-action shadow field must be deleted"
    assert "reason" not in s, "one-action reason field must be deleted"


def test_shadow_error_never_breaks_chat(monkeypatch):
    """decide_turn raising → fail closed: the turn dies at the existing 500
    boundary (no planless legacy execution). The shadow step still records
    ok=False (plan_unavailable) for observability."""
    from fastapi import HTTPException
    fx = _fx("err", "สวัสดีครับ")
    replay._install(monkeypatch, fx)
    monkeypatch.setenv("USE_TURN_DECISION_SHADOW", "1")
    from shopeechat import turn_decision as _td
    monkeypatch.setattr(_td, "decide_turn",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(HTTPException) as exc:
        app.chat(app.ChatRequest(
            message="สวัสดีครับ", shop="testshop", platform="shopee",
            conversation_id="sh-err", limit=5, simulate_assignment=True,
            test_source="phase1b_shadow"))
    assert exc.value.status_code == 500


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

def test_shadow_placeholder_is_no_reply(monkeypatch):
    for ph in ("[faq_liveagent]", "[bundle_message]"):
        resp = _run(monkeypatch, _fx(f"ph-{ph}", ph))
        s = _shadow_steps(resp)[0]
        assert s["ok"] is True and s["primary_action"] == "no_reply", (ph, s)
        assert s["needs"] == []


def test_shadow_product_issue_not_handoff(monkeypatch):
    resp = _run(monkeypatch, _fx("prod", "ชาร์จแล้วไฟไม่เข้าเป็นที่อะไรครับ"))
    s = _shadow_steps(resp)[0]
    assert s["primary_action"] == "execute_needs", s
    pairs = {(n["kind"], n["operation"]) for n in s["needs"]}
    assert ("claim", "collect") in pairs
    assert ("troubleshoot", "describe") in pairs
    assert ("human", "handoff") not in pairs


def test_shadow_human_request_is_handoff(monkeypatch):
    """⚡ Phase 2C.3 — human-request turn now flows through the post-classify
    TurnPlan gate: the plan carries primary_action="handoff" and the gate
    dispatches to the existing handoff owner. The response must carry the
    plan step AND the handoff signal (need content stays pinned in
    test_turn_decision.py)."""
    resp = _run(monkeypatch, _fx("hr", "ขอคุยกับแอดมิน"))
    assert resp.handoff_to_admin is True
    steps = _shadow_steps(resp)
    assert steps and steps[0]["ok"], steps
    assert steps[0]["primary_action"] == "handoff", steps[0]


def test_shadow_ticket_active_is_locked(monkeypatch):
    """active ticket → boundary lock returns wait-only BEFORE the shadow
    runs — no TurnDecisionShadow step, no handoff-command fields.
    (pure `human_wait` classification stays pinned in test_turn_decision.py)"""
    resp = _run(monkeypatch, _fx("lock", "ยังไม่มีใครตอบเลย",
                                 ticket_state="open"))
    assert resp.handoff_to_admin is False
    assert resp.handoff_reason is None
    assert (resp.routing_decision or {}).get("path") == "human_wait"
    assert _shadow_steps(resp) == [], \
        "boundary lock must run before the TurnDecision shadow"


# ── fixture sweep — observe-only comparison data for Phase 2C.1 ───────────
# Runs EVERY fixture turn through chat() with shadow on. Asserts that
# the shadow executed (ok=True step exists) and checks per-turn TurnPlan
# expectations via tde_entry_error.


def _legacy_family(rec) -> str:
    """Coarse legacy outcome family from a replay record (boundary only)."""
    resp = rec["resp"]
    if getattr(resp, "handoff_to_admin", False):
        return "handoff"
    return "answer"


def test_shadow_sweep_all_fixtures(monkeypatch, capsys):
    rows, bad = [], 0
    mismatches: list[str] = []
    for fx in replay._load_fixtures():
        if (fx.get("expected") or {}).get("pending_live_replay"):
            continue
        records, _cap, _client = _run_records(monkeypatch, fx)
        tde = fx.get("turn_decision_expect")
        if tde is not None and len(tde) != len(records):
            mismatches.append(
                f"{fx['id']}: turn_decision_expect={len(tde)} entries "
                f"but {len(records)} user turns")
        for i, rec in enumerate(records):
            steps = _shadow_steps(rec["resp"])
            _resp = rec["resp"]
            # Phase 2B.5 boundary — the active-ticket lock runs at /chat
            # entry BEFORE the shadow executes, so boundary-locked turns
            # legitimately carry no TurnDecisionShadow step (wait-only
            # contract is asserted instead).
            if ((getattr(_resp, "routing_decision", None) or {})
                    .get("path") == "human_wait"
                    and getattr(_resp, "handoff_to_admin", False) is False):
                rows.append((fx["id"], rec["turn"][:40],
                             "boundary_lock", "-", ""))
                continue
            # Phase 2C.3 — the production TurnPlan is computed after the
            # Pass-1 interpretation boundary; turns that early-return before
            # it (item_tag / order flow / human-request handoff) have no
            # intent-informed plan and legitimately carry no shadow step.
            if not any(s.get("name") == "Intent"
                       for s in (getattr(_resp, "steps", None) or ())):
                rows.append((fx["id"], rec["turn"][:40],
                             "pre_pass1_return", "-", ""))
                continue
            if not steps:
                bad += 1
                rows.append((fx["id"], rec["turn"][:40], "MISSING", "", ""))
                continue
            s = steps[0]
            legacy = _legacy_family(rec)
            shadow = (s.get("primary_action") if s.get("ok")
                      else f"ERROR:{s.get('error')}")
            rows.append((fx["id"], rec["turn"][:40], legacy, shadow,
                         "" if s.get("ok") else "ERR"))
            if tde is not None and i < len(tde):
                err = vfx.tde_entry_error(
                    tde[i], s, s.get("flags") or [],
                    incident=fx.get("status") == "incident")
                if err:
                    mismatches.append(f"{fx['id']}[{i}]: {err}")
    with capsys.disabled():
        print("\n=== TurnDecisionShadow sweep (observe-only) ===")
        for r in rows:
            print(" | ".join(str(x) for x in r))
        print(f"turns={len(rows)} missing={bad}")
    assert bad == 0, f"{bad} fixture turns produced no shadow trace"
    assert not mismatches, "turn_decision_expect mismatches:\n" + \
        "\n".join(mismatches)


def test_shadow_phase1c_hardened_cases(monkeypatch):
    """Pin the contract hardening at the shadow boundary —
    fixture turns that used to mismatch are now asserted on TurnPlan."""
    want = {
        "tx-q08-price-followup": {
            "ราคาเท่าไหร่": ("execute_needs", {("product", "price")}),
        },
        "tx-q09-link-followup": {
            "ขอลิงค์": ("execute_needs", {("product", "link")}),
        },
        "tx-q10-cert-scope": {
            "ตัวไหนมี มอก. บ้าง": ("execute_needs", {("product", "describe")}),
        },
        "tx-q22q25-claim-persist": {
            # ⚡ 2C.3 — needs=() + text → execute_needs (clarify สงวนให้
            #   unanchored follow-up เท่านั้น)
            "0812345678": ("execute_needs", set()),
        },
    }
    seen = set()
    for fx in replay._load_fixtures():
        if fx["id"] not in want:
            continue
        records, _cap, _client = _run_records(monkeypatch, fx)
        for rec in records:
            for text, (want_pa, want_needs) in want[fx["id"]].items():
                if rec["turn"].startswith(text):
                    steps = _shadow_steps(rec["resp"])
                    assert steps and steps[0]["ok"], (fx["id"], text, steps)
                    assert steps[0]["primary_action"] == want_pa, (
                        fx["id"], text, steps[0])
                    got_needs = {(n["kind"], n["operation"])
                                 for n in steps[0]["needs"]}
                    assert want_needs <= got_needs, (
                        fx["id"], text, got_needs, want_needs)
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


# ── Phase 1F — shadow callsite forwarding / minimal snapshot ────────────────


def _capture_decide(monkeypatch):
    captured: dict = {}
    def _fake(msg, **kw):
        captured["message"] = msg
        captured.update(kw)
        from shopeechat import warranty_flow as _wf
        return _td_mod.TurnPlan(
            primary_action="clarify", needs=(), ownership="unknown",
            claim=_wf._claim_lifecycle(kw.get("claim_state")),
            requires_clarification=True, normalized_message="x",
            flags=frozenset(), intent_confidence=0.5)
    monkeypatch.setattr(_td_mod, "decide_turn", _fake)
    return captured


def test_plan_claim_and_anchor_come_from_subject_view(monkeypatch):
    """claim_state + active_anchor ของ decide_turn ต้องมาจาก subject view
    doc เดียว (≤1 get_subject_set/turn) — ห้ามเรียก
    load_claim_state/get_active_product แยกสำหรับ plan inputs."""
    monkeypatch.setenv("USE_TURN_DECISION_SHADOW", "1")
    calls = {"view": 0}
    def _view(cid):
        calls["view"] += 1
        return _cp_shadow.SubjectSetView(
            None, None, (),
            claim_state={"stage": "collecting"},
            active_item_id="3004")
    monkeypatch.setattr(_cp_shadow, "get_subject_set", _view)
    # load_claim_state/get_active_product ยังถูกเรียกโดย claim lifecycle
    # (warranty_flow) — owner คนละตัวกับ plan inputs; ที่ pin คือ
    # decide_turn kwargs มาจาก view doc เดียวกัน + view ≤1 call/turn
    captured = _capture_decide(monkeypatch)
    resp = _run(monkeypatch, _fx("view", "สวัสดีครับ"), flag="1")
    assert resp is not None
    assert calls["view"] == 1, calls
    assert captured.get("claim_state") == {"stage": "collecting"}
    anchor = captured.get("active_anchor")
    assert anchor is not None and anchor.get("item_id") == "3004", anchor
    assert "description" not in anchor and "products" not in anchor


def test_plan_no_anchor_no_claim_passes_none(monkeypatch):
    """ไม่มี conversation doc → view ว่าง → decide_turn รับ None ทั้งคู่."""
    captured = _capture_decide(monkeypatch)
    resp = _run(monkeypatch, _fx("none", "สวัสดีครับ"))
    assert resp is not None
    assert captured.get("claim_state") is None
    assert captured.get("active_anchor") is None


def test_plan_never_forwards_post_handoff_exceptions(monkeypatch):
    """Phase 2B.5 — content override ถูกลบ: production plan ต้องไม่ส่ง
    post_handoff_exceptions เข้า decide_turn; open-ticket turn ถูก
    boundary-lock ก่อน classify → decide_turn ไม่ถูกเรียกเลย."""
    captured = _capture_decide(monkeypatch)
    resp = _run(monkeypatch,
                _fx("lock2", "ยังไม่มีใครตอบเลย", ticket_state="open"))
    assert resp is not None
    assert captured == {}, "locked turn must not reach decide_turn"
    captured = _capture_decide(monkeypatch)
    resp = _run(monkeypatch, _fx("tick", "สวัสดีครับ",
                                 ticket_state=None))
    assert resp is not None
    assert captured, "normal turn must reach decide_turn"
    assert "post_handoff_exceptions" not in captured, captured


def test_subject_view_failure_yields_empty_plan_inputs(monkeypatch):
    """subject-view DB read พัง → get_subject_set คืน view ว่าง (catch
    ภายใน) → decide_turn ทำงานต่อด้วย claim/anchor=None, step ok=True."""
    monkeypatch.setenv("USE_TURN_DECISION_SHADOW", "1")
    def _boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(_cp_shadow, "_coll", _boom)
    captured = _capture_decide(monkeypatch)
    resp = _run(monkeypatch, _fx("boom", "สวัสดีครับ"))
    assert resp is not None
    assert captured.get("claim_state") is None
    assert captured.get("active_anchor") is None
    steps = _shadow_steps(resp)
    assert steps and steps[0]["ok"] is True


def test_shadow_trace_carries_no_snapshot_payload(monkeypatch):
    """trace ต้อง PII-safe — serializer รับ plan object เท่านั้น, step
    มีเฉพาะ key ที่อนุญาต."""
    monkeypatch.setenv("USE_TURN_DECISION_SHADOW", "1")
    plan = SimpleNamespace(
        primary_action="clarify", needs=(), ownership="unknown",
        claim=SimpleNamespace(stage="collecting"),
        requires_clarification=True, normalized_message="x" * 10,
        flags=frozenset({"some_flag"}))
    steps: list = []
    app._turn_decision_shadow(plan, steps)
    step = steps[0]
    allowed = {"name", "ok", "primary_action", "needs", "ownership",
               "claim_stage", "requires_clarification", "flags",
               "message_len", "error"}
    assert set(step) <= allowed, step
    blob = str(step)
    for leak in ("0812345678", "สมชาย", "ประวัติ", "3004",
                 "customer_name", "active_item_id"):
        assert leak not in blob
