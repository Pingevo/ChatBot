#!/usr/bin/env python3
"""Parity test — _detect_charger_subtype() before/after token-match fix.

ทดสอบ:
1. คำที่ต้องได้ None (false positive ที่ต้องแก้)
2. คำที่ต้องยัง match ได้เหมือนเดิม (ห้าม regression)
3. คำเฉพาะที่ต้องได้ wireless ไม่ใช่ cable
"""
from __future__ import annotations
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "chatbot"))

from shopeechat.product_store import _detect_charger_subtype

# ── คำที่ต้องได้ None (false positive ที่ต้องแก้) ──
MUST_BE_NONE = [
    # หัว + คำผสม
    "หัวเตียง", "หัวใจ", "หัวฉีด", "หัวพ่น", "หัวข้อ", "หัวปลี", "หัวโต๊ะ",
    "หัวเข่า", "หัวไหล่", "หัวนม", "หัวหน้า", "หัวโขน", "หัวคิว",
    "หัวรถจักร", "หัวล้าน", "หัวหอย", "หัวเลี้ยว",
    # สาย + คำผสม
    "สายไฟ", "สายยาง", "สายเบ็ด", "สายพาน", "สายรุ้ง", "สายลม", "สายฝน",
    "สายการบิน", "สายตรวจ", "สายธุรกิจ", "สายอาชีพ", "สายตา",
    "สายรัด", "สายคล้อง", "สายนาฬิกา", "สายเชือก",
]

# ── คำที่ต้องยัง match ได้เหมือนเดิม (ห้าม regression) ──
MUST_MATCH = [
    ("มีหัวไหม", "adapter"),
    ("ขอหัว", "adapter"),
    ("หัว 140w", "adapter"),
    ("หัวชาร์จ", "adapter"),
    ("มีสายไหม", "cable"),
    ("ขอสาย", "cable"),
    ("สาย 1.5 เมตร", "cable"),
    ("สายชาร์จ", "cable"),
]

# ── ไร้สาย ต้องไม่ใช่ cable (ต้องเป็น wireless หรือ None) ──
MUST_NOT_CABLE = [
    "ไร้สาย",
]


def run_test() -> int:
    passed = 0
    failed = 0

    print("=== 1) ต้องได้ None (false positive ที่ต้องแก้) ===")
    for msg in MUST_BE_NONE:
        result = _detect_charger_subtype(msg)
        if result is None:
            print(f"  ✅ {msg:20s} → None")
            passed += 1
        else:
            print(f"  ❌ {msg:20s} → {result!r} (expected None)")
            failed += 1

    print("\n=== 2) ต้องยัง match ได้เหมือนเดิม (ห้าม regression) ===")
    for msg, expected in MUST_MATCH:
        result = _detect_charger_subtype(msg)
        if result == expected:
            print(f"  ✅ {msg:20s} → {result!r}")
            passed += 1
        else:
            print(f"  ❌ {msg:20s} → {result!r} (expected {expected!r})")
            failed += 1

    print("\n=== 3) ไร้สาย ต้องไม่ใช่ cable ===")
    for msg in MUST_NOT_CABLE:
        result = _detect_charger_subtype(msg)
        if result != "cable":
            print(f"  ✅ {msg:20s} → {result!r} (not cable)")
            passed += 1
        else:
            print(f"  ❌ {msg:20s} → {result!r} (must NOT be cable)")
            failed += 1

    total = passed + failed
    print(f"\n{'='*60}")
    print(f"ผล: {passed}/{total} ผ่าน, {failed} ไม่ผ่าน")
    print(f"{'='*60}")
    return failed


if __name__ == "__main__":
    sys.exit(run_test())
