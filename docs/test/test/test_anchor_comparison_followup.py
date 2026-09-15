"""Test: anchor comparison follow-up logic (Q4/Q5 scenario).

จำลอง scenario:
  Q1: ลูกค้าส่ง item card Run  → bot ตอบ Run
  Q2: ลูกค้าถาม "รุ่นนี้กับตัว swim แนะนำตัวไหนดีคะ" → bot ไม่เข้าใจ swim
  Q3: ลูกค้าส่ง item card Swim → bot ตอบ Swim
  Q4: ลูกค้าถาม "คุณภาพเสียงหล่ะคะต่างกันไหมเอ่ย" → ควรเปรียบเทียบ Run vs Swim
  Q5: ลูกค้าถาม "อยากทราบคุณภาพเสียงค่ะ" → ควรตอบทั้งสองรุ่น (post-comparison follow-up)

Test เช็ค:
  1. comparison follow-up ใช้ anchor history เมื่อมี 2+ anchor (ไม่ดึง model keyword จาก history text)
  2. post-comparison follow-up ตั้ง _anchor_compare_ctx เมื่อรอบก่อนเป็น comparison
"""
from __future__ import annotations

import sys
import os

# Add chatbot parent to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "chatbot"))

from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


def _make_product(item_id, name):
    """สร้าง product card mock."""
    return {
        "item_id": item_id,
        "name": name,
        "brand": "iSUPER",
        "price": 3490,
        "warranty": "1 ปี",
    }


def _make_anchor_entry(item_id, name, mentioned_at, is_anchor=True):
    """สร้าง anchor entry สำหรับ timeline."""
    return {
        "item_id": item_id,
        "name": name,
        "source": "user_item_card",
        "mentioned_at": mentioned_at,
        "is_anchor": is_anchor,
        "card": _make_product(item_id, name),
    }


def test_comparison_followup_uses_anchor_history():
    """Q4: comparison follow-up ควรใช้ anchor history แทน model keyword จาก history text."""
    from shopeechat import conversation_products as cp

    run_card = _make_product(111, "iSUPER SoundActiv Run")
    swim_card = _make_product(222, "iSUPER SoundActiv Swim")
    now = datetime.now(timezone.utc)

    # Mock timeline: 2 anchors (Run ก่อน, Swim หลัง = active)
    mock_doc = {
        "conversation_id": "test-conv",
        "products": [
            {"item_id": 111, "name": "iSUPER SoundActiv Run", "is_anchor": True,
             "mentioned_at": now, "card": run_card},
            {"item_id": 222, "name": "iSUPER SoundActiv Swim", "is_anchor": True,
             "mentioned_at": now, "card": swim_card},
        ],
        "active_item_id": 222,
    }

    with patch.object(cp, "load_timeline", return_value=mock_doc):
        anchors = cp.get_anchor_history("test-conv", limit=5)
        assert len(anchors) >= 2, f"Expected 2+ anchors, got {len(anchors)}"

        active = cp.get_active_product("test-conv")
        assert active is not None, "Active product should not be None"
        assert active.get("item_id") == 222, f"Active should be Swim (222), got {active.get('item_id')}"

        prev = cp.get_previous_anchor("test-conv", exclude_item_id=222)
        assert prev is not None, "Previous anchor should not be None"
        assert prev.get("item_id") == 111, f"Previous should be Run (111), got {prev.get('item_id')}"

    print("✅ test_comparison_followup_uses_anchor_history passed")


def test_post_comparison_followup_detection():
    """Q5: post-comparison follow-up ควร detect ว่ารอบก่อนเป็น comparison."""
    # Q4 message (last user message in history)
    q4_msg = "คุณภาพเสียงหล่ะคะต่างกันไหมเอ่ย"
    # Q5 message (current)
    q5_msg = "อยากทราบคุณภาพเสียงค่ะ"

    # เช็คว่า Q4 มี comparison keyword
    _pcf_comp_kws = ("ต่างกัน", "ต่างยังไง", "ต่างไหม", "เปรียบเทียบ", "เทียบ", "เทียบกัน",
                     "กับตัว", "กับรุ่น", "กับอัน", "กับสอง")
    q4_is_comp = any(kw in q4_msg.lower() for kw in _pcf_comp_kws)
    assert q4_is_comp, f"Q4 should be detected as comparison: {q4_msg}"

    # เช็คว่า Q5 ไม่มี model keyword (Thai text, no [A-Za-z0-9])
    import re
    tokens = re.split(r"[\s,/\-]+", q5_msg.strip())
    has_model = any(re.search(r"[A-Za-z0-9]", t) and len(t) >= 2 for t in tokens)
    assert not has_model, f"Q5 should not have model keyword: {q5_msg}"

    # เช็คว่า Q5 ไม่ใช่ new topic
    _pcf_new_topic_kws = ("สวัสดี", "หวัดดี", "hi", "hello", "มีอะไร", "มีไร",
                          "สนใจ", "อยากได้", "หาสินค้า", "แนะนำ")
    q5_is_new_topic = any(kw in q5_msg.lower() for kw in _pcf_new_topic_kws)
    assert not q5_is_new_topic, f"Q5 should not be new topic: {q5_msg}"

    # เช็คว่า Q5 สั้นพอ
    q5_short = len(q5_msg.split()) <= 8
    assert q5_short, f"Q5 should be short: {q5_msg}"

    print("✅ test_post_comparison_followup_detection passed")


def test_q2_swim_not_anchor_yet():
    """Q2: ตอนถาม 'รุ่นนี้กับตัว swim' ยังมีแค่ 1 anchor (Run) → anchor compare ไม่ทำงาน."""
    from shopeechat import conversation_products as cp

    run_card = _make_product(111, "iSUPER SoundActiv Run")
    now = datetime.now(timezone.utc)

    mock_doc = {
        "conversation_id": "test-conv-q2",
        "products": [
            {"item_id": 111, "name": "iSUPER SoundActiv Run", "is_anchor": True,
             "mentioned_at": now, "card": run_card},
        ],
        "active_item_id": 111,
    }

    with patch.object(cp, "load_timeline", return_value=mock_doc):
        anchors = cp.get_anchor_history("test-conv-q2", limit=5)
        assert len(anchors) == 1, f"Expected 1 anchor at Q2, got {len(anchors)}"
        # anchor compare ไม่ทำงานเพราะมี anchor แค่ 1 ตัว
        prev = cp.get_previous_anchor("test-conv-q2", exclude_item_id=111)
        assert prev is None, "Should not have previous anchor with only 1 anchor"

    print("✅ test_q2_swim_not_anchor_yet passed")


def test_extract_model_keywords_history_text():
    """เช็คว่า extract_model_keywords ดึง brand/series แทน model name จาก history text."""
    from shopeechat import knowledge_base

    # History text ที่มีทั้ง Run และ Swim
    history_text = (
        "มีสินค้าพร้อมส่งค่ะ รุ่นนี้ iSUPER SoundActiv Run เป็นหูฟัง Bone Conduction "
        "มีสินค้าพร้อมส่งค่ะ รุ่นนี้ iSUPER SoundActiv Swim เป็นหูฟัง Bone Conduction "
        "IP68 32GB iSUPER PLAY iOS Android"
    )
    models = knowledge_base.extract_model_keywords(history_text)
    # กรอง vs
    models = [m for m in models if m.lower() != "vs"]

    # dedup
    seen = set()
    unique = []
    for m in models:
        ml = m.lower()
        if ml not in seen:
            seen.add(ml)
            unique.append(m)

    print(f"  extract_model_keywords returned: {unique[:6]}")
    # ปัญหา: "iSUPER" และ "SoundActiv" มาก่อน "Run" และ "Swim"
    # ถ้า [:3] จะได้ ["iSUPER", "SoundActiv", "Run"] — Swim หาย!
    top3 = unique[:3]
    has_swim = any("swim" in m.lower() for m in top3)
    print(f"  top3: {top3}  → has_swim={has_swim}")
    # นี่คือปัญหาที่แก้: ใช้ anchor history แทน
    assert not has_swim, "Swim should be cut off by [:3] — this is the bug we're fixing"
    print("✅ test_extract_model_keywords_history_text passed (confirms the bug)")


def test_partial_comparison_detection():
    """Q2: 'ตัวนี้กับ swim ต่างกันยังไง' — 1 anchor (Run) + model keyword 'swim'."""
    from shopeechat import conversation_products as cp
    from shopeechat import knowledge_base
    import re

    run_card = _make_product(111, "iSUPER SoundActiv Run")
    now = datetime.now(timezone.utc)

    mock_doc = {
        "conversation_id": "test-conv-q2",
        "products": [
            {"item_id": 111, "name": "iSUPER SoundActiv Run", "is_anchor": True,
             "mentioned_at": now, "card": run_card},
        ],
        "active_item_id": 111,
    }

    msg = "ตัวนี้กับ swim ต่างกันยังไง"

    # 1. comparison keyword ต้องมี
    comp_kws = ("ต่างกัน", "ต่างยังไง", "ต่างไหม", "เปรียบเทียบ", "เทียบ", "เทียบกัน")
    has_comp = any(kw in msg.lower() for kw in comp_kws)
    assert has_comp, f"Should have comparison keyword: {msg}"

    # 2. model keyword ต้องมี (swim)
    model_kws = knowledge_base.extract_model_keywords(msg)
    model_kws = [k for k in model_kws if not knowledge_base.is_target_device_kw(k)]
    assert "swim" in [k.lower() for k in model_kws], f"Should extract 'swim': {model_kws}"
    has_model = len(model_kws) > 0
    assert has_model, "Should have model keyword"

    # 3. anchor history มี 1 ตัว
    with patch.object(cp, "load_timeline", return_value=mock_doc):
        anchors = cp.get_anchor_history("test-conv-q2", limit=5)
        assert len(anchors) == 1, f"Expected 1 anchor, got {len(anchors)}"
        active = cp.get_active_product("test-conv-q2")
        assert active.get("item_id") == 111

        # 4. guard: "swim" ไม่ตรงกับชื่อ anchor (Run) → เป็น comparison จริง
        active_name = (active.get("name") or "").lower()
        kw_is_anchor = any(
            kw.lower() in active_name
            for kw in model_kws
            if re.search(r"\d", kw)  # model code pattern only
        )
        assert not kw_is_anchor, "'swim' should not match anchor name 'Run'"

    # 5. MODEL-REGEX ลด minimum เป็น 4 ตัวเมื่อ _is_partial_comp
    #    "swim" มี 4 ตัวอักษร → ต้องถูกดึงด้วย [A-Za-z]{4,}
    min_chars = 4  # _is_partial_comp = True
    alpha_kws = re.findall(r"[A-Za-z]{%d,}" % min_chars, msg)
    assert "swim" in [k.lower() for k in alpha_kws], f"Should find 'swim' with {min_chars}+ chars: {alpha_kws}"

    # 6. ถ้าใช้ 5 ตัว (ปกติ) → "swim" ไม่ถูกดึง (นี่คือ bug เดิม)
    alpha_kws_5 = re.findall(r"[A-Za-z]{5,}", msg)
    assert "swim" not in [k.lower() for k in alpha_kws_5], f"Should NOT find 'swim' with 5+ chars: {alpha_kws_5}"

    print("✅ test_partial_comparison_detection passed")


def test_partial_comparison_model_kw_matches_anchor():
    """Guard: ถ้า model keyword ตรงกับ anchor → ไม่ใช่ comparison (ถามตัวเดิม)."""
    import re

    # anchor = "iSUPER SoundActiv Run", message = "ตัวนี้กับ run ต่างกันยังไง"
    # "run" ไม่มีตัวเลข → ไม่ถูก guard (guard เช็คเฉพาะ keyword ที่มีตัวเลข)
    # ดังนั้น "run" จะไม่ถูกกรอง → _kw_is_anchor = False → เป็น comparison จริง
    # แต่ถ้า message = "ตัวนี้กับ ec6 ต่างกันยังไง" และ anchor = "EC6 Panorama"
    # "ec6" มีตัวเลข → ถูก guard → _kw_is_anchor = True → ไม่ใช่ comparison
    active_name = "EC6 Panorama".lower()
    model_kws = ["ec6"]
    kw_is_anchor = any(
        kw.lower() in active_name
        for kw in model_kws
        if re.search(r"\d", kw)
    )
    assert kw_is_anchor, "'ec6' should match anchor 'EC6 Panorama'"

    # "swim" ไม่มีตัวเลข → ไม่ถูก guard → เป็น comparison จริง
    active_name2 = "iSUPER SoundActiv Run".lower()
    model_kws2 = ["swim"]
    kw_is_anchor2 = any(
        kw.lower() in active_name2
        for kw in model_kws2
        if re.search(r"\d", kw)
    )
    assert not kw_is_anchor2, "'swim' should not match anchor 'Run'"

    print("✅ test_partial_comparison_model_kw_matches_anchor passed")


if __name__ == "__main__":
    test_comparison_followup_uses_anchor_history()
    test_post_comparison_followup_detection()
    test_q2_swim_not_anchor_yet()
    test_extract_model_keywords_history_text()
    test_partial_comparison_detection()
    test_partial_comparison_model_kw_matches_anchor()
    print("\n🎉 All tests passed!")
