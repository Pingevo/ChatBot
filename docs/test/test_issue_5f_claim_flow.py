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

from shopeechat import warranty, warranty_flow  # noqa: E402
from shopeechat.handoffs import detect_human_request  # noqa: E402


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


def test_claim_collecting_marker():
    assert warranty_flow._claim_collecting({"stage": "collecting"})
    assert warranty_flow._claim_collecting({"customer_phone": "081"})
    assert not warranty_flow._claim_collecting({})
    assert not warranty_flow._claim_collecting(None)


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
