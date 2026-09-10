#!/usr/bin/env python3
"""Unit test สำหรับ get_anchor_history + get_previous_anchor (Phase 7).

ทดสอบ:
1. เคสมี anchor แค่ 1 ตัว → get_previous_anchor คืน None (graceful)
2. เคสสินค้าซ้ำ (A → B → A) → get_anchor_history เรียงตาม mentioned_at ล่าสุดจริง
3. เคสมี anchor 2 ตัว → get_previous_anchor คืน anchor อันดับ 2
4. เคส exclude_item_id → ข้าม anchor ที่ระบุ
5. เคสไม่มี timeline → คืน [] / None
6. เคสมีแต่ suggestion (ไม่มี anchor) → คืน [] / None

Usage:
    cd chatbot && PYTHONPATH=. ../.venv/bin/python ../docs/test/test_anchor_compare.py
"""
from __future__ import annotations

import sys
import os
import time
from datetime import datetime, timezone, timedelta

# path setup
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CHATBOT = os.path.join(_REPO_ROOT, "chatbot")
if _CHATBOT not in sys.path:
    sys.path.insert(0, _CHATBOT)

from shopeechat import conversation_products as cp

# ใช้ test conversation_id ที่ไม่ชนกับของจริง
_TEST_PREFIX = f"test-anchor-compare-{int(time.time())}"


def _make_card(item_id: int, name: str) -> dict:
    return {
        "item_id": item_id,
        "name": name,
        "shop": "TestShop",
        "price": 100,
        "warranty": {"duration": "1 Year"},
    }


def _add_anchor(conv_id: str, item_id: int, name: str, delay: float = 0.05):
    """เพิ่ม anchor product พร้อม delay เพื่อให้ mentioned_at ต่างกันชัดเจน."""
    cp.add_product(
        conversation_id=conv_id,
        platform="shopee",
        shop="TestShop",
        item_id=item_id,
        name=name,
        source="user_item_card",
        card=_make_card(item_id, name),
        is_anchor=True,
    )
    time.sleep(delay)  # ให้ mentioned_at ห่างกันพอ


def _clear(conv_id: str):
    """ลบ timeline ทดสอบ."""
    try:
        cp._coll().delete_many({"conversation_id": conv_id})
    except Exception:
        pass


def test_single_anchor():
    """เคสมี anchor แค่ 1 ตัว → get_previous_anchor คืน None."""
    conv = f"{_TEST_PREFIX}-single"
    _clear(conv)
    _add_anchor(conv, 1001, "Product A")
    try:
        history = cp.get_anchor_history(conv)
        assert len(history) == 1, f"expected 1 anchor, got {len(history)}"
        prev = cp.get_previous_anchor(conv)
        assert prev is None, f"expected None for single anchor, got {prev}"
        print("  ✅ test_single_anchor passed")
        return True
    except AssertionError as e:
        print(f"  ❌ test_single_anchor FAILED: {e}")
        return False
    finally:
        _clear(conv)


def test_two_anchors():
    """เคสมี anchor 2 ตัว → get_previous_anchor คืน anchor อันดับ 2 (เก่ากว่า)."""
    conv = f"{_TEST_PREFIX}-two"
    _clear(conv)
    _add_anchor(conv, 2001, "Product B (first)")  # ก่อน
    _add_anchor(conv, 2002, "Product A (second)")  # หลัง (ล่าสุด)
    try:
        history = cp.get_anchor_history(conv)
        assert len(history) == 2, f"expected 2 anchors, got {len(history)}"
        # ล่าสุดต้องเป็น A (second)
        assert "A (second)" in (history[0].get("name") or ""), f"expected A (second) first, got {history[0].get('name')}"
        prev = cp.get_previous_anchor(conv)
        assert prev is not None, "expected previous anchor, got None"
        assert "B (first)" in (prev.get("name") or ""), f"expected B (first), got {prev.get('name')}"
        print("  ✅ test_two_anchors passed")
        return True
    except AssertionError as e:
        print(f"  ❌ test_two_anchors FAILED: {e}")
        return False
    finally:
        _clear(conv)


def test_repeat_anchor():
    """เคสสินค้าซ้ำ (A → B → A) → get_anchor_history เรียงตาม mentioned_at ล่าสุดจริง."""
    conv = f"{_TEST_PREFIX}-repeat"
    _clear(conv)
    _add_anchor(conv, 3001, "Product A")  # ครั้ง 1
    _add_anchor(conv, 3002, "Product B")  # ครั้ง 2
    _add_anchor(conv, 3001, "Product A")  # ครั้ง 3 (ซ้ำ A → mentioned_at อัปเดต)
    try:
        history = cp.get_anchor_history(conv)
        # A ต้องเป็นอันดับ 1 (mentioned_at ล่าสุด) B อันดับ 2
        assert len(history) == 2, f"expected 2 unique anchors, got {len(history)}"
        assert "Product A" in (history[0].get("name") or ""), f"expected A first (latest), got {history[0].get('name')}"
        assert "Product B" in (history[1].get("name") or ""), f"expected B second, got {history[1].get('name')}"
        # get_previous_anchor ต้องคืน B (เพราะ A คือ active ล่าสุด)
        active = cp.get_active_product(conv)
        assert "Product A" in (active.get("name") or ""), f"expected A as active, got {active.get('name')}"
        prev = cp.get_previous_anchor(conv, exclude_item_id=active.get("item_id"))
        assert prev is not None, "expected previous (B), got None"
        assert "Product B" in (prev.get("name") or ""), f"expected B as previous, got {prev.get('name')}"
        print("  ✅ test_repeat_anchor passed")
        return True
    except AssertionError as e:
        print(f"  ❌ test_repeat_anchor FAILED: {e}")
        return False
    finally:
        _clear(conv)


def test_exclude_item_id():
    """เคส exclude_item_id → ข้าม anchor ที่ระบุ."""
    conv = f"{_TEST_PREFIX}-exclude"
    _clear(conv)
    _add_anchor(conv, 4001, "Product X")
    _add_anchor(conv, 4002, "Product Y")
    _add_anchor(conv, 4003, "Product Z")
    try:
        # exclude X (ตัวเก่าสุด) → previous ของ Z คือ Y
        prev = cp.get_previous_anchor(conv, exclude_item_id=4003)  # exclude Z (active)
        assert prev is not None, "expected Y, got None"
        assert "Product Y" in (prev.get("name") or ""), f"expected Y, got {prev.get('name')}"
        # exclude ทั้ง Z และ Y → คืน X
        prev2 = cp.get_previous_anchor(conv, exclude_item_id=4003)
        # แต่ get_previous_anchor รับ exclude แค่ 1 ตัว → คืน Y อีกครั้ง (เพราะ Y ยังอยู่)
        # ทดสอบ: exclude Z → คืน Y (อันดับ 2 หลังกรอง)
        assert "Product Y" in (prev2.get("name") or ""), f"expected Y, got {prev2.get('name')}"
        print("  ✅ test_exclude_item_id passed")
        return True
    except AssertionError as e:
        print(f"  ❌ test_exclude_item_id FAILED: {e}")
        return False
    finally:
        _clear(conv)


def test_no_timeline():
    """เคสไม่มี timeline → คืน [] / None."""
    conv = f"{_TEST_PREFIX}-empty"
    _clear(conv)
    try:
        history = cp.get_anchor_history(conv)
        assert history == [], f"expected [], got {history}"
        prev = cp.get_previous_anchor(conv)
        assert prev is None, f"expected None, got {prev}"
        print("  ✅ test_no_timeline passed")
        return True
    except AssertionError as e:
        print(f"  ❌ test_no_timeline FAILED: {e}")
        return False
    finally:
        _clear(conv)


def test_suggestions_only():
    """เคสมีแต่ suggestion (ไม่มี anchor) → คืน [] / None."""
    conv = f"{_TEST_PREFIX}-suggestions"
    _clear(conv)
    # เพิ่ม suggestion (is_anchor=False)
    cp.add_product(
        conversation_id=conv, platform="shopee", shop="TestShop",
        item_id=5001, name="Suggestion A", source="bot_suggestion",
        card=_make_card(5001, "Suggestion A"), is_anchor=False,
    )
    cp.add_product(
        conversation_id=conv, platform="shopee", shop="TestShop",
        item_id=5002, name="Suggestion B", source="bot_suggestion",
        card=_make_card(5002, "Suggestion B"), is_anchor=False,
    )
    try:
        history = cp.get_anchor_history(conv)
        assert history == [], f"expected [] (no anchors), got {history}"
        prev = cp.get_previous_anchor(conv)
        assert prev is None, f"expected None, got {prev}"
        print("  ✅ test_suggestions_only passed")
        return True
    except AssertionError as e:
        print(f"  ❌ test_suggestions_only FAILED: {e}")
        return False
    finally:
        _clear(conv)


def test_limit():
    """เคส limit parameter → จำกัดจำนวนผลลัพธ์."""
    conv = f"{_TEST_PREFIX}-limit"
    _clear(conv)
    for i in range(5):
        _add_anchor(conv, 6000 + i, f"Product {i}", delay=0.02)
    try:
        history_all = cp.get_anchor_history(conv, limit=100)
        assert len(history_all) == 5, f"expected 5, got {len(history_all)}"
        history_limited = cp.get_anchor_history(conv, limit=3)
        assert len(history_limited) == 3, f"expected 3, got {len(history_limited)}"
        # ล่าสุดต้องเป็น Product 4 (ตัวสุดท้ายที่ add)
        assert "Product 4" in (history_limited[0].get("name") or ""), f"expected Product 4 first, got {history_limited[0].get('name')}"
        print("  ✅ test_limit passed")
        return True
    except AssertionError as e:
        print(f"  ❌ test_limit FAILED: {e}")
        return False
    finally:
        _clear(conv)


if __name__ == "__main__":
    print("=== Phase 7: get_anchor_history + get_previous_anchor unit tests ===\n")
    # โหลด env ก่อน (เพื่อเชื่อม MongoDB)
    from shopeechat import knowledge_base
    knowledge_base._load_env()

    tests = [
        test_single_anchor,
        test_two_anchors,
        test_repeat_anchor,
        test_exclude_item_id,
        test_no_timeline,
        test_suggestions_only,
        test_limit,
    ]
    passed = 0
    failed = 0
    for t in tests:
        if t():
            passed += 1
        else:
            failed += 1
    print(f"\n{'='*50}")
    print(f"Result: {passed} passed, {failed} failed, {len(tests)} total")
    sys.exit(0 if failed == 0 else 1)
