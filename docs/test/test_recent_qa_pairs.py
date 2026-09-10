#!/usr/bin/env python3
"""Phase 8 — Unit test สำหรับ _recent_qa_pairs() ใน app.py.

ทดสอบ:
1. history ว่าง → []
2. คู่ครบ (user+model) 10 คู่ → 20 messages
3. คู่ครบเกิน n → ตัดเหลือ n คู่ล่าสุด
4. role ไม่ครบคู่ (2 user ติดกันจาก buffer_flush) → ไม่ crash, จับคู่ผิดไม่ได้
5. model เดี่ยว (ไม่มี user ก่อนหน้า) → คืน model เดี่ยว
6. user เดี่ยวท้ายสุด (ยังไม่ตอบ) → คืน user เดี่ยว
7. n=1 → คืน 1 คู่ล่าสุด
8. ลำดับผลลัพธ์เรียงเก่า→ใหม่
"""
import sys
import os

# เพิ่ม chatbot dir เข้า sys.path
_chatbot_dir = os.path.join(os.path.dirname(__file__), "..", "..", "chatbot")
if _chatbot_dir not in sys.path:
    sys.path.insert(0, _chatbot_dir)

from shopeechat.app import _recent_qa_pairs


def _make_history(n_pairs: int) -> list[dict]:
    """สร้าง history ที่มี n_pairs คู่ (user+model) เรียงเก่า→ใหม่."""
    hist = []
    for i in range(n_pairs):
        hist.append({"role": "user", "text": f"Q{i+1}"})
        hist.append({"role": "model", "text": f"A{i+1}"})
    return hist


def test_empty():
    """history ว่าง → []"""
    result = _recent_qa_pairs([], n=10)
    assert result == [], f"expected [], got {result}"
    print("  ✅ test_empty passed")


def test_none():
    """history=None → []"""
    result = _recent_qa_pairs(None, n=10)
    assert result == [], f"expected [], got {result}"
    print("  ✅ test_none passed")


def test_full_pairs():
    """10 คู่ครบ → 20 messages เรียงเก่า→ใหม่"""
    hist = _make_history(10)
    result = _recent_qa_pairs(hist, n=10)
    assert len(result) == 20, f"expected 20, got {len(result)}"
    # ลำดับเก่า→ใหม่
    assert result[0]["text"] == "Q1", f"expected Q1 first, got {result[0]['text']}"
    assert result[-1]["text"] == "A10", f"expected A10 last, got {result[-1]['text']}"
    print("  ✅ test_full_pairs passed")


def test_truncate():
    """15 คู่, n=10 → คืน 10 คู่ล่าสุด (20 messages)"""
    hist = _make_history(15)
    result = _recent_qa_pairs(hist, n=10)
    assert len(result) == 20, f"expected 20, got {len(result)}"
    # คู่ล่าสุด = Q6..Q15 + A6..A15
    assert result[0]["text"] == "Q6", f"expected Q6 first, got {result[0]['text']}"
    assert result[-1]["text"] == "A15", f"expected A15 last, got {result[-1]['text']}"
    print("  ✅ test_truncate passed")


def test_double_user():
    """2 user ติดกัน (buffer_flush) → ไม่ crash, จับคู่ผิดไม่ได้

    scenario: U1, U2, M1, U3, M2
    คาดหวัง:
    - M1 จับคู่กับ U2 (user ก่อนหน้า)
    - U1 เป็น user เดี่ยว (ไม่มี model ตามหลัง)
    - M2 จับคู่กับ U3
    """
    hist = [
        {"role": "user", "text": "U1"},
        {"role": "user", "text": "U2"},
        {"role": "model", "text": "M1"},
        {"role": "user", "text": "U3"},
        {"role": "model", "text": "M2"},
    ]
    result = _recent_qa_pairs(hist, n=10)
    # ควรมี 5 messages (U1 เดี่ยว + U2+M1 + U3+M2)
    assert len(result) == 5, f"expected 5, got {len(result)}: {result}"
    # ลำดับเก่า→ใหม่: U1, U2, M1, U3, M2
    assert result[0]["text"] == "U1", f"expected U1, got {result[0]['text']}"
    assert result[1]["text"] == "U2", f"expected U2, got {result[1]['text']}"
    assert result[2]["text"] == "M1", f"expected M1, got {result[2]['text']}"
    assert result[3]["text"] == "U3", f"expected U3, got {result[3]['text']}"
    assert result[4]["text"] == "M2", f"expected M2, got {result[4]['text']}"
    print("  ✅ test_double_user passed")


def test_model_solo():
    """model เดี่ยวที่ต้น history (ไม่มี user ก่อนหน้า) → คืน model เดี่ยว"""
    hist = [
        {"role": "model", "text": "M0"},
        {"role": "user", "text": "U1"},
        {"role": "model", "text": "M1"},
    ]
    result = _recent_qa_pairs(hist, n=10)
    assert len(result) == 3, f"expected 3, got {len(result)}: {result}"
    assert result[0]["text"] == "M0", f"expected M0, got {result[0]['text']}"
    assert result[1]["text"] == "U1", f"expected U1, got {result[1]['text']}"
    assert result[2]["text"] == "M1", f"expected M1, got {result[2]['text']}"
    print("  ✅ test_model_solo passed")


def test_user_solo_end():
    """user เดี่ยวท้ายสุด (ยังไม่ตอบ) → คืน user เดี่ยว"""
    hist = [
        {"role": "user", "text": "U1"},
        {"role": "model", "text": "M1"},
        {"role": "user", "text": "U2"},  # ยังไม่ตอบ
    ]
    result = _recent_qa_pairs(hist, n=10)
    assert len(result) == 3, f"expected 3, got {len(result)}: {result}"
    assert result[0]["text"] == "U1", f"expected U1, got {result[0]['text']}"
    assert result[1]["text"] == "M1", f"expected M1, got {result[1]['text']}"
    assert result[2]["text"] == "U2", f"expected U2, got {result[2]['text']}"
    print("  ✅ test_user_solo_end passed")


def test_n1():
    """n=1 → คืน 1 คู่ล่าสุด (2 messages)"""
    hist = _make_history(5)
    result = _recent_qa_pairs(hist, n=1)
    assert len(result) == 2, f"expected 2, got {len(result)}: {result}"
    assert result[0]["text"] == "Q5", f"expected Q5, got {result[0]['text']}"
    assert result[1]["text"] == "A5", f"expected A5, got {result[1]['text']}"
    print("  ✅ test_n1 passed")


def test_order():
    """ลำดับผลลัพธ์เรียงเก่า→ใหม่ (พร้อมส่งเข้า LLM contents)"""
    hist = _make_history(3)
    result = _recent_qa_pairs(hist, n=10)
    expected = ["Q1", "A1", "Q2", "A2", "Q3", "A3"]
    actual = [r["text"] for r in result]
    assert actual == expected, f"expected {expected}, got {actual}"
    print("  ✅ test_order passed")


def test_preserve_fields():
    """ฟังก์ชันคืน dict เดิม (ไม่ copy) — รักษา fields อื่น เช่น images, image_desc"""
    hist = [
        {"role": "user", "text": "U1", "images": ["url1"], "image_desc": "desc1"},
        {"role": "model", "text": "M1"},
    ]
    result = _recent_qa_pairs(hist, n=10)
    assert len(result) == 2, f"expected 2, got {len(result)}"
    assert result[0].get("images") == ["url1"], f"expected images preserved, got {result[0].get('images')}"
    assert result[0].get("image_desc") == "desc1", f"expected image_desc preserved, got {result[0].get('image_desc')}"
    print("  ✅ test_preserve_fields passed")


def main():
    print("=== Phase 8: _recent_qa_pairs unit tests ===\n")
    tests = [
        test_empty,
        test_none,
        test_full_pairs,
        test_truncate,
        test_double_user,
        test_model_solo,
        test_user_solo_end,
        test_n1,
        test_order,
        test_preserve_fields,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"  ❌ {t.__name__} FAILED: {e}")
            failed += 1
    print(f"\n{'='*50}")
    print(f"Result: {passed} passed, {failed} failed, {len(tests)} total")
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
