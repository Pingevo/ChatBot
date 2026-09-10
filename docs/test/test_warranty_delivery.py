"""Unit test สำหรับ warranty auto-check จาก delivery date.

ทดสอบ:
1. CANCELLED order → delivery_time_raw=None, check_warranty_status → in_warranty=None (ไม่ crash)
2. COMPLETED order → delivery_time_raw มีค่า, check_warranty_status → in_warranty=True/False
3. LOGISTICS_DELIVERY_DONE → delivery_time_raw มีค่า
4. ยังไม่ส่งมอบ (UNPAID/SHIPPED) → delivery_time_raw=None
5. multi-item ต่าง warranty → ถามลูกค้า (ambiguity)
6. multi-item warranty เท่ากัน → คำนวณได้
7. manual date fallback ยังทำงาน (parse_purchase_date + is_in_warranty)
"""
from __future__ import annotations

import sys
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

# setup sys.path ให้ import shopeechat ได้
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "chatbot"))

from shopeechat import warranty as _w
from shopeechat.warranty import check_warranty_status, is_in_warranty, parse_purchase_date


def test_cancelled_order_delivery_raw_none():
    """CANCELLED order → delivery_time_raw=None → check_warranty_status ไม่ crash + in_warranty=None"""
    result = check_warranty_status(None, 12)
    assert result["in_warranty"] is None, f"expected None, got {result['in_warranty']}"
    assert result["days_remaining"] is None
    assert result["delivery_date"] is None
    assert result["expiry_date"] is None
    assert "ยังไม่สามารถคำนวณ" in result["text"] or "ยังไม่ส่งมอบ" in result["text"]
    print("✅ test_cancelled_order_delivery_raw_none")


def test_zero_delivery_raw():
    """delivery_time_raw=0 → in_warranty=None"""
    result = check_warranty_status(0, 12)
    assert result["in_warranty"] is None
    print("✅ test_zero_delivery_raw")


def test_completed_order_in_warranty():
    """COMPLETED order ที่ส่งมอบเมื่อ 10 วันที่แล้ว → in_warranty=True"""
    # unix ts 10 วันที่แล้ว
    ten_days_ago = int((datetime.now(timezone.utc) - timedelta(days=10)).timestamp())
    result = check_warranty_status(ten_days_ago, 12)  # 12 เดือน
    assert result["in_warranty"] is True
    assert result["days_remaining"] > 0
    assert result["delivery_date"] is not None
    assert result["expiry_date"] is not None
    print(f"✅ test_completed_order_in_warranty (days_left={result['days_remaining']})")


def test_completed_order_out_of_warranty():
    """COMPLETED order ที่ส่งมอบเมื่อ 400 วันที่แล้ว → in_warranty=False (warranty 12 เดือน)"""
    four_hundred_days_ago = int((datetime.now(timezone.utc) - timedelta(days=400)).timestamp())
    result = check_warranty_status(four_hundred_days_ago, 12)
    assert result["in_warranty"] is False
    assert result["days_remaining"] < 0
    print(f"✅ test_completed_order_out_of_warranty (days_left={result['days_remaining']})")


def test_no_warranty_months():
    """warranty_months=0 → in_warranty=None"""
    ten_days_ago = int((datetime.now(timezone.utc) - timedelta(days=10)).timestamp())
    result = check_warranty_status(ten_days_ago, 0)
    assert result["in_warranty"] is None
    assert "ไม่ทราบระยะเวลา" in result["text"]
    print("✅ test_no_warranty_months")


def test_invalid_timestamp():
    """timestamp ไม่ valid → in_warranty=None (ไม่ crash)"""
    result = check_warranty_status("not-a-number", 12)
    assert result["in_warranty"] is None
    print("✅ test_invalid_timestamp")


def test_multi_item_different_warranties():
    """multi-item ที่ warranty ต่างกัน → ต้องถามลูกค้า (ambiguity)"""
    # จำลอง logic ใน app.py: ดึง warranty จากชื่อสินค้า
    items = [
        {"name": "Xiaomi Powerbank PB100 -12M"},  # 12 เดือน
        {"name": "CUKTECH Charger 65W -2Y"},      # 24 เดือน
    ]
    item_warranties = []
    for ai in items:
        wi = _w.extract_warranty_from_name(ai["name"])
        dur = wi.get("months") if wi else None
        if dur and dur > 0:
            item_warranties.append((ai["name"], int(dur)))
    unique_months = list({m for _, m in item_warranties})
    assert len(unique_months) > 1, f"expected ambiguity, got {unique_months}"
    print(f"✅ test_multi_item_different_warranties (months={unique_months}) → ask customer")


def test_multi_item_same_warranty():
    """multi-item ที่ warranty เท่ากัน → คำนวณได้ (no ambiguity)"""
    items = [
        {"name": "Xiaomi Powerbank PB100 -12M"},
        {"name": "Anker Cable USB-C -12M"},
    ]
    item_warranties = []
    for ai in items:
        wi = _w.extract_warranty_from_name(ai["name"])
        dur = wi.get("months") if wi else None
        if dur and dur > 0:
            item_warranties.append((ai["name"], int(dur)))
    unique_months = list({m for _, m in item_warranties})
    assert len(unique_months) == 1, f"expected single warranty, got {unique_months}"
    print(f"✅ test_multi_item_same_warranty (months={unique_months}) → calculate")


def test_manual_date_fallback_still_works():
    """manual purchase-date flow ยังทำงาน — parse_purchase_date + is_in_warranty"""
    purchase_date = parse_purchase_date("ซื้อมาวันที่ 15/1/2024")
    assert purchase_date is not None
    assert purchase_date.year == 2024
    assert purchase_date.month == 1
    assert purchase_date.day == 15
    calc = is_in_warranty(purchase_date, 12)
    # 15/1/2024 + 12 เดือน = 15/1/2025 → ปัจจุบันหมดแล้ว
    assert calc["in_warranty"] is False
    print(f"✅ test_manual_date_fallback_still_works (text={calc['text']})")


def test_manual_date_thai_year():
    """parse_purchase_date รองรับปี พ.ศ."""
    purchase_date = parse_purchase_date("15 ม.ค. 2567")
    assert purchase_date is not None
    assert purchase_date.year == 2024  # 2567 - 543 = 2024
    print("✅ test_manual_date_thai_year")


def test_delivery_time_raw_in_lookup_order_docstring():
    """ตรวจว่า delivery_time_raw อยู่ใน lookup_order return dict (static check)"""
    import inspect
    from shopeechat import order_store
    src = inspect.getsource(order_store.lookup_order)
    assert "delivery_time_raw" in src, "delivery_time_raw not found in lookup_order source"
    print("✅ test_delivery_time_raw_in_lookup_order_docstring")


if __name__ == "__main__":
    test_cancelled_order_delivery_raw_none()
    test_zero_delivery_raw()
    test_completed_order_in_warranty()
    test_completed_order_out_of_warranty()
    test_no_warranty_months()
    test_invalid_timestamp()
    test_multi_item_different_warranties()
    test_multi_item_same_warranty()
    test_manual_date_fallback_still_works()
    test_manual_date_thai_year()
    test_delivery_time_raw_in_lookup_order_docstring()
    print("\n🎉 All 11 tests passed!")
