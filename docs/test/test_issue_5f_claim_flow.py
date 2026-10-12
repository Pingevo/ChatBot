"""test_issue_5f_claim_flow.py — Phase 5F-B: claim state + extraction hygiene.

pin:
- extract_customer_info: glued particles (นะคะ/นะครับ), label-as-name,
  honorific prefix ต้องไม่รั่วเข้า name ที่เก็บลง claim_state
- multi-message merge: name+phone+order แยกหลายข้อความ → _merge_claim_slots รวมถูก
- ticket_state="handoff" → detect_human_request ห้าม re-fire handoff POST
  (ลูกค้าโมโหระหว่างรอแอดมิน = ไม่ใช่ handoff ใหม่ → post-handoff lock ตอบแทน)
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

import dotenv as _dotenv  # noqa: E402

# .env purity — shopeechat.app runs load_dotenv() at import; if this module is
# collected before the replay harness's own import boundary, the real .env
# would be read. Trap it for the import block only (stub lives solely inside
# try/finally — restored immediately after, no env values read or printed).
_orig_load_dotenv = _dotenv.load_dotenv
_dotenv.load_dotenv = lambda *a, **k: False
try:
    from shopeechat import warranty, warranty_flow  # noqa: E402
    from shopeechat.handoffs import detect_human_request  # noqa: E402
    import shopeechat.app as _app_mod  # noqa: E402
finally:
    _dotenv.load_dotenv = _orig_load_dotenv
    # bound aliases: `from dotenv import load_dotenv` inside app/knowledge_base
    # bound the stub during import — restoring only the provider global would
    # leave the dead lambda reachable; restore whichever modules were created
    _app_ref = sys.modules.get("shopeechat.app")
    if _app_ref is not None:
        _app_ref.load_dotenv = _orig_load_dotenv
    _kb_ref = sys.modules.get("shopeechat.knowledge_base")
    if _kb_ref is not None:
        _kb_ref.load_dotenv = _orig_load_dotenv

# Phase 2B.2 — flag/reason emit เฉพาะ confirmed transport outcome (offline ไม่มี
# admin server → stub success ที่ transport owner เดียว; callers resolve per-call)
# monkeypatch fixture: restore หลังแต่ละ test → ห้ามรั่วข้าม module
import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _stub_handoff_transport(monkeypatch):
    monkeypatch.setattr(_app_mod, "_send_handoff", lambda *a, **k: {
        "outcome": {"state": "assigned"},
        "assigned_to": "a1", "assigned_to_name": "Admin One",
        "assignment_reason": "round_robin",
    })


# ---------- name extraction hygiene ----------

def test_glued_particle_suffix_stripped():
    info = warranty.extract_customer_info("สมชาย ใจดีนะคะ")
    assert info["name"] == "สมชาย ใจดี"


def test_glued_na_stripped():
    info = warranty.extract_customer_info("ผมชื่อสมชายนะ")
    assert info["name"] == "สมชาย"


def test_honorific_and_particle_stripped():
    info = warranty.extract_customer_info("ชื่อคุณสมชายนะคะ")
    assert info["name"] == "สมชาย"


def test_field_label_not_a_name():
    # NER จับ label "เลขคำสั่งซื้อ" เป็นชื่อ — ต้อง reject
    info = warranty.extract_customer_info("เลขคำสั่งซื้อ 123456789012")
    assert info["name"] != "เลขคำสั่งซื้อ"
    assert info["order_id"] == "123456789012"


def test_normal_name_unchanged():
    info = warranty.extract_customer_info("สมชาย ใจดี")
    assert info["name"] == "สมชาย ใจดี"
    info = warranty.extract_customer_info("ชื่อ สมชาย ใจดี ครับ")
    assert info["name"] == "สมชาย ใจดี"


# ---------- multi-message merge (fill-once) ----------

def test_merge_slots_across_messages():
    # turn1: name / turn2: phone+order — merge กับ claim_state ต้องครบ
    state = {"customer_name": "สมชาย ใจดี", "stage": "collecting"}
    info2 = warranty.extract_customer_info("0812345678 2508088B5T4W1D")
    slots = warranty_flow._merge_claim_slots(info2, claim_state=state)
    assert slots["name"] == "สมชาย ใจดี"
    assert slots["phone"] == "0812345678"
    assert slots["order_id"] == "2508088B5T4W1D"


def test_merge_current_message_wins():
    # ลูกค้าแก้เบอร์ → ค่าปัจจุบันชนะ claim_state
    state = {"customer_phone": "0800000000", "stage": "collecting"}
    info = {"name": "", "phone": "0899999999", "order_id": ""}
    slots = warranty_flow._merge_claim_slots(info, claim_state=state)
    assert slots["phone"] == "0899999999"


def test_claim_lifecycle_view():
    # 2B.4 — single evaluator: stage persist เท่านั้นที่เป็น authority;
    # retained slots (เช่น phone อย่างเดียว) ไม่ใช่ activation อีกต่อไป
    view = warranty_flow._claim_lifecycle({"stage": "collecting", "episode_id": "e1"})
    assert view.lifecycle_open and view.accepts_claim_fields
    view = warranty_flow._claim_lifecycle({"customer_phone": "081"})
    assert view.stage == "absent" and not view.lifecycle_open
    assert warranty_flow._claim_lifecycle({}).stage == "absent"
    assert warranty_flow._claim_lifecycle(None).stage == "absent"


# ---------- post-handoff: ห้าม re-fire handoff ----------

def test_anger_during_active_handoff_no_refire():
    # ticket_state="handoff" + ลูกค้าโมโห → ไม่ใช่ handoff ใหม่
    req = SimpleNamespace(message="กากมาก", conversation_id="c1",
                          shop=None, ticket_state="handoff")
    out = detect_human_request(req, {})
    assert out is None  # → ให้ post-handoff lock ใน warranty_flow ตอบ


def test_human_request_during_active_handoff_no_refire():
    req = SimpleNamespace(message="ขอคุยกับคน", conversation_id="c1",
                          shop=None, ticket_state="handoff")
    assert detect_human_request(req, {}) is None


def test_anger_normal_ticket_still_handoff():
    # ticket ยังไม่ handoff → anger ต้อง escalate ปกติ
    req = SimpleNamespace(message="กากมาก", conversation_id="c1",
                          shop=None, ticket_state=None)
    out = detect_human_request(req, {})
    assert out is not None and out["handoff_reason"] == "customer_frustration"


# ---------- H4: ticket_state = source of truth สำหรับ post-handoff lock ----------

def test_active_handoff_state_helper():
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="handoff"), history_marker=False) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="open"), history_marker=False) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="pending"), history_marker=False) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="closed"), history_marker=True) is False
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="resolved"), history_marker=True) is False
    # fallback เฉพาะตอนไม่ทราบ state
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state=None), history_marker=True) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state=None), history_marker=False) is False


def test_active_handoff_without_history_marker_still_locks():
    # ticket_state="handoff" + history ไม่มี handoff marker → lock ต้องทำงาน
    req = SimpleNamespace(
        message="ทำไมยังไม่มีคนตอบ", conversation_id=None, shop=None,
        platform=None, ticket_state="handoff", simulate_assignment=False,
    )
    history = [{"role": "model", "text": "สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ"}]
    out = warranty_flow.handle_warranty_flow_legacy(
        req, {"total_start": 0.0, "t0": 0.0, "steps": []}, history=history, db=None)
    assert out is not None
    assert out["handoff_to_admin"] is True
    assert out["handoff_reason"] == "post_handoff_waiting"


def test_active_handoff_empty_history_still_locks():
    # ticket_state="handoff" + history ว่าง (history fetch fail) → ยังต้อง lock
    req = SimpleNamespace(
        message="ทำไมยังไม่มีคนตอบ", conversation_id=None, shop=None,
        platform=None, ticket_state="handoff", simulate_assignment=False,
    )
    out = warranty_flow.handle_warranty_flow_legacy(
        req, {"total_start": 0.0, "t0": 0.0, "steps": []}, history=[], db=None)
    assert out is not None
    assert out["handoff_reason"] == "post_handoff_waiting"


def test_open_state_locks_too():
    # open = แอดมินรับงานจริงแล้ว (botWorkerService: assign สำเร็จ → open)
    req = SimpleNamespace(
        message="แล้วไงต่อ", conversation_id=None, shop=None,
        platform=None, ticket_state="open", simulate_assignment=False,
    )
    out = warranty_flow.handle_warranty_flow_legacy(
        req, {"total_start": 0.0, "t0": 0.0, "steps": []}, history=[], db=None)
    assert out is not None
    assert out["handoff_reason"] == "post_handoff_waiting"


def test_active_handoff_claim_info_still_accepted():
    # ticket handoff แต่ลูกค้าส่งเบอร์/order → gate ปล่อยผ่าน (เก็บข้อมูลต่อ)
    req = SimpleNamespace(
        message="เบอร์ 0812345678 order 2508088B5T4W1D", conversation_id=None,
        shop=None, platform=None, ticket_state="handoff", simulate_assignment=False,
    )
    out = warranty_flow.handle_warranty_flow_legacy(
        req, {"total_start": 0.0, "t0": 0.0, "steps": []}, history=[], db=None)
    # gate ปล่อยผ่าน → ไม่ใช่ post_handoff_waiting (ตกไป pipeline ปกติ/claim collect)
    assert out is None or out.get("handoff_reason") != "post_handoff_waiting"


def test_module_import_never_reads_dotenv(tmp_path=None):
    """M2 (.env import purity) — importing this module must not run
    load_dotenv() regardless of collection order.

    In-process the app module is already cached, so the honest check is a
    subprocess: trap `dotenv.load_dotenv` with a counter BEFORE importing
    this file — the module's own import-time stub must intercept the app's
    `from dotenv import load_dotenv` binding, so the outer trap sees zero
    calls. No env values are read or printed.
    """
    import os
    import subprocess
    import sys

    code = (
        "import sys\n"
        "sys.path.insert(0, 'docs/test')\n"
        "sys.path.insert(0, 'chatbot')\n"
        "import os\n"
        "os.environ['HF_HUB_OFFLINE'] = '1'\n"
        "os.environ['TRANSFORMERS_OFFLINE'] = '1'\n"
        "import dotenv\n"
        "calls = []\n"
        "def trap(*a, **k):\n"
        "    calls.append(1)\n"
        "    return False\n"
        "dotenv.load_dotenv = trap\n"
        "import test_issue_5f_claim_flow  # noqa: F401\n"
        "assert not calls, f'load_dotenv called {len(calls)}x during import'\n"
    )
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    res = subprocess.run(
        [sys.executable, "-c", code], cwd=str(ROOT), env=env,
        capture_output=True, text=True, timeout=180)
    assert res.returncode == 0, res.stderr[-3000:]


def test_load_dotenv_aliases_restored_after_import():
    """Finding A — module-bound `from dotenv import load_dotenv` aliases.

    The import-time trap patches `dotenv.load_dotenv` so shopeechat.app's
    `from ... import` binds the stub — restoring only the provider global
    leaves `app.load_dotenv`/`knowledge_base.load_dotenv` pointing at the
    dead stub forever (leaked fake state into the shared process).
    """
    import dotenv
    assert _app_mod.load_dotenv is dotenv.load_dotenv, (
        "app.load_dotenv ยังชี้ stub ของ import trap — ไม่ได้ restore")
    import shopeechat.knowledge_base as _kb
    assert _kb.load_dotenv is dotenv.load_dotenv, (
        "knowledge_base.load_dotenv ยังชี้ stub — ไม่ได้ restore")
