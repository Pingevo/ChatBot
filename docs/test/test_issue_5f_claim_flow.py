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


# ---------- Phase 2B.5: name validity = extract_customer_info final output ----------

def test_final_name_lone_thai_accepted():
    # ชื่อเดี่ยวใช้ได้ — กติกาไม่บังคับ space อีกต่อไป
    assert warranty.extract_customer_info("สมชาย")["name"] == "สมชาย"


def test_final_name_english_accepted():
    assert warranty.extract_customer_info("John Doe")["name"] == "John Doe"


def test_final_name_digit_rejected():
    # NER อาจคืนชื่อที่ติดตัวเลข — final sanitation ต้อง reject
    assert warranty.extract_customer_info("สมชาย ใจดี9")["name"] == ""
    assert warranty.extract_customer_info("ชื่อสมชาย9")["name"] == ""


def test_final_name_over_40_rejected():
    # English fallback ผลิตชื่อเกิน 40 ตัว → final sanitation ต้อง reject
    info = warranty.extract_customer_info(
        "Christopher Alexander Benjamin Montgomery")
    assert info["name"] == ""


def test_final_fields_unchanged():
    # phone/order extraction ไม่เปลี่ยน
    info = warranty.extract_customer_info("0812345678 2508088B5T4W1D")
    assert info["phone"] == "0812345678"
    assert info["order_id"] == "2508088B5T4W1D"


def test_merge_slots_lone_name_persists():
    # _merge_claim_slots = merge precedence เท่านั้น — ไม่ re-judge shape
    # (parser รับผิดชอบ validity แล้ว): ชื่อเดี่ยวต้องไม่ถูกทิ้ง
    slots = warranty_flow._merge_claim_slots(
        {"name": "สมชาย", "phone": "", "order_id": ""}, claim_state={})
    assert slots["name"] == "สมชาย"


def test_merge_slots_lone_name_survives_next_turn():
    # lone name ที่ persist แล้วต้องไม่หายใน turn ต่อไป (precedence เก็บของเก่า)
    state = {"customer_name": "สมชาย", "stage": "collecting"}
    slots = warranty_flow._merge_claim_slots(
        {"name": "", "phone": "0812345678", "order_id": ""}, claim_state=state)
    assert slots["name"] == "สมชาย"
    assert slots["phone"] == "0812345678"


# ---------- Phase 2B.5: history scan = contextual denylist เท่านั้น ----------

def _review_out_for(history_texts):
    """Drive _handle_review_request with user-text history; return its dict."""
    from shopeechat import llm
    req = SimpleNamespace(
        message="ทวนข้อมูลเคลมหน่อย", conversation_id=None, shop=None,
        platform=None, ticket_state=None, simulate_assignment=False)
    history = [{"role": "user", "text": t} for t in history_texts]
    return warranty_flow._handle_review_request(
        req, {"total_start": 0.0, "t0": 0.0, "steps": []},
        history, warranty, llm, _app_mod)


def test_history_scan_contextual_denylist_kept():
    # contextual denylist ยังทำงาน: ข้อความเก่าเรื่องพัสดุ/ส่งของ/รูป
    # ต้องไม่ถูกยกเป็น customer_name ใน review answer
    out = _review_out_for(["ทวนเลขพัสดุ", "ส่งรูปสินค้ามาแล้วนะ"])
    assert "ทวนเลขพัสดุ" not in out["answer"]
    assert "ชื่อ-นามสกุล" not in out["answer"]


def test_history_scan_valid_name_still_used():
    # ชื่อจริงใน history ยังถูกใช้ใน review (shape checks ถูกลบ แต่
    # contextual admissibility คงอยู่ — parser เป็นผู้ validate)
    out = _review_out_for(["ผมชื่อสมชาย ใจดี"])
    assert "สมชาย ใจดี" in out["answer"]


def test_history_scan_lone_name_used():
    # lone name ใน history ต้องถูกยอมรับเช่นกัน — space rule ที่ history scan
    # ซ้ำกับ parser ถูกลบแล้ว (denylist ยังคุม context อยู่)
    out = _review_out_for(["ผมชื่อสมชายนะ"])
    assert "สมชาย" in out["answer"]


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
    # ticket_state="handoff" + plan decided frustration → ไม่ใช่ handoff ใหม่
    req = SimpleNamespace(message="กากมาก", conversation_id="c1",
                          shop=None, ticket_state="handoff")
    out = detect_human_request(req, {}, plan_decided_reason="customer_frustration")
    assert out is None  # → ให้ post-handoff lock ใน warranty_flow ตอบ


def test_human_request_during_active_handoff_no_refire():
    req = SimpleNamespace(message="ขอคุยกับคน", conversation_id="c1",
                          shop=None, ticket_state="handoff")
    assert detect_human_request(
        req, {}, plan_decided_reason="human_request") is None


def test_anger_normal_ticket_still_handoff():
    # ticket ยังไม่ handoff → plan-decided anger ต้อง escalate ปกติ
    req = SimpleNamespace(message="กากมาก", conversation_id="c1",
                          shop=None, ticket_state=None)
    out = detect_human_request(
        req, {}, plan_decided_reason="customer_frustration")
    assert out is not None and out["handoff_reason"] == "customer_frustration"


# ---------- H4: ticket_state = source of truth สำหรับ post-handoff lock ----------

def test_active_handoff_state_helper():
    # Phase 2B.5 — evaluator รับ history แล้วคำนวณ marker เอง (owner เดียว)
    _marker_hist = [{"role": "model",
                     "text": "รับทราบค่ะ เดี๋ยวแอดมินดูแลให้นะคะ"}]
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="handoff"), []) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="open"), []) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="pending"), []) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="closed"), _marker_hist) is False
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state="resolved"), _marker_hist) is False
    # fallback เฉพาะตอนไม่ทราบ state — marker อ่านจาก last model text
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state=None), _marker_hist) is True
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state=None), []) is False
    assert warranty_flow._is_active_post_handoff(
        SimpleNamespace(ticket_state=None),
        [{"role": "model", "text": "สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ"}]) is False


def _chat_boundary(**kw):
    """Drive the real /chat boundary — the single production lock owner."""
    return _app_mod.chat(_app_mod.ChatRequest(**kw))


def _assert_wait_only(out):
    # wait-only contract: lock ≠ handoff command — downstream callers must
    # never see a new-handoff signal from a waiting-state response
    assert out.handoff_to_admin is False
    assert out.handoff_reason is None
    assert (out.routing_decision or {}).get("path") == "human_wait"


def test_active_handoff_without_history_marker_still_locks():
    # ticket_state="handoff" + history ไม่มี handoff marker → lock ต้องทำงาน
    out = _chat_boundary(
        message="ทำไมยังไม่มีคนตอบ", conversation_id=None, shop=None,
        platform=None, ticket_state="handoff", simulate_assignment=False,
        history=[{"role": "model", "text": "สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ"}])
    _assert_wait_only(out)


def test_active_handoff_empty_history_still_locks():
    # ticket_state="handoff" + history ว่าง (history fetch fail) → ยังต้อง lock
    out = _chat_boundary(
        message="ทำไมยังไม่มีคนตอบ", conversation_id=None, shop=None,
        platform=None, ticket_state="handoff", simulate_assignment=False,
        history=[])
    _assert_wait_only(out)


def test_open_state_locks_too():
    # open = แอดมินรับงานจริงแล้ว (botWorkerService: assign สำเร็จ → open)
    out = _chat_boundary(
        message="แล้วไงต่อ", conversation_id=None, shop=None,
        platform=None, ticket_state="open", simulate_assignment=False,
        history=[])
    _assert_wait_only(out)


def test_active_handoff_claim_info_locked():
    # Phase 2B.5 — ticket active = unconditional lock: claim info
    # (เบอร์/order) ไม่ override ownership — ต้อง wait-admin, ไม่มี claim write
    out = _chat_boundary(
        message="เบอร์ 0812345678 order 2508088B5T4W1D", conversation_id=None,
        shop=None, platform=None, ticket_state="handoff",
        simulate_assignment=False, history=[])
    _assert_wait_only(out)


def test_active_handoff_image_locked():
    # รูปเคลมระหว่าง active ticket → lock เช่นกัน (ไม่มี media escape)
    out = _chat_boundary(
        message="[รูปภาพ]", conversation_id=None, shop=None, platform=None,
        ticket_state="open", simulate_assignment=False, images=[], history=[])
    _assert_wait_only(out)


def test_active_handoff_product_question_locked():
    # product question ระหว่าง active ticket → lock (ไม่มี product escape)
    out = _chat_boundary(
        message="มีสายชาร์จไหมครับ", conversation_id=None, shop=None,
        platform=None, ticket_state="pending", simulate_assignment=False,
        history=[])
    _assert_wait_only(out)


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
