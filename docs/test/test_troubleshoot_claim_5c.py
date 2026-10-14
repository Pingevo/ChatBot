"""test_troubleshoot_claim_5c.py — Task 5C-F: malfunction detection + safe answer.

pin:
- "ใช้งานไม่ได้"/"ชาร์จไฟไม่ได้" style = claim request (เดิมหลุดไป product flow)
- warranty-policy questions ("เคลมได้ไหม") ไม่ใช่ claim
- first-claim answer สำหรับ malfunction ต้องมี safe checks (เปลี่ยนสาย/ปลั๊ก/
  เครื่องอื่น, เช็กพอร์ต, หยุดใช้ถ้าร้อน/กลิ่นไหม้) และห้ามเดาสเปค
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import warranty, warranty_flow  # noqa: E402


def test_malfunction_phrases_are_claim_requests():
    for msg in ("หัวชาร์จ a18t ใช้งานไม่ได้",
                "สายชาร์จชาร์จไฟไม่ได้",
                "หัวชาร์จใช้งานไม่ได้",
                "a18t ใช้ไม่ได้",
                "ชาร์จไฟไม่เข้าเลย"):
        assert warranty.detect_claim_request(msg), msg


def test_policy_questions_not_claims():
    for msg in ("เคลมได้ไหม", "ถ้ามีปัญหาเคลมได้ไหม",
                "รับประกันกี่เดือน", "มีประกันไหม"):
        assert not warranty.detect_claim_request(msg), msg


def test_safe_check_content_no_spec_guess():
    note = warranty.malfunction_safe_check("หัวชาร์จ a18t ใช้งานไม่ได้")
    assert note
    assert "ลอง" in note or "เช็ก" in note
    assert "ชาร์จด่วน" not in note and "3.0" not in note
    # safety stop ต้องมี
    assert "หยุด" in note


def test_safe_check_empty_for_non_malfunction():
    assert warranty.malfunction_safe_check("เคลมได้ไหม") == ""
    assert warranty.malfunction_safe_check("ส่งเคลมสินค้า") == ""


def test_first_claim_answer_has_safe_checks():
    """first-message malfunction claim → acknowledge + safe checks + ขอข้อมูลเคลม"""
    from shopeechat import app as _app_module, llm
    req = SimpleNamespace(message="หัวชาร์จ a18t ใช้งานไม่ได้",
                          conversation_id=None, platform="shopee",
                          shop="KingGadgets", simulate_assignment=False,
                          item_id=None)
    ctx = {"bot_name": "ทางร้าน", "steps": [], "timing_breakdown": {},
           "total_start": 0.0, "image_desc_out": "", "model_name": "test"}
    out = warranty_flow._handle_first_message_claim(
        req, ctx, True, warranty, llm, _app_module)
    assert out
    ans = out["answer"]
    assert "ขออภัย" in ans                       # acknowledge
    assert "ลอง" in ans or "เช็ก" in ans          # safe checks
    assert "เลขที่คำสั่งซื้อ" in ans              # claim path intact
    assert "ชาร์จด่วน" not in ans                 # ไม่เดาสเปค
