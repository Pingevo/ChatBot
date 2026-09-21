#!/usr/bin/env python3
"""
test_general_qtype_guards.py — ทดสอบ _general_qtype_bypass (test_200 #143/#199)

ที่มา:
- #143: "เอาขึ้นเครื่องไปจีนด้วยได้อ่ะ" → intent general_qtype=shipping_policy
  → early return ตอบนโยบายจัดส่ง ก่อนถึง compat-followup/product flow
  (regression จาก Phase 6 intent-first — เดิม qtype มาจาก keyword เท่านั้น)
- #199: "มีสินค้า smart home ไหม" → general_qtype=categories → generic dump
  ทั้งที่ smart home = cross-type cluster ที่ค้นสินค้าได้จริง

ตรวจว่า guard คืน None (→ product flow) เฉพาะเคสที่ควร และคง qtype เดิมที่ถูกต้อง
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot"))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat.app import _general_qtype_bypass as bypass


def _check(label: str, actual, expected) -> bool:
    ok = actual == expected
    mark = "✅" if ok else "❌"
    print(f"  {mark} {label}: actual={actual!r} expected={expected!r}")
    return ok


def main() -> int:
    cases = [
        # (qtype, message, expected)
        # ---- shipping_policy: travel kw + no ship verb → product flow ----
        ("shipping_policy", "เอาขึ้นเครื่องไปจีนด้วยได้อ่ะ", None),          # #143 เดิม
        ("shipping_policy", "พาวเวอร์แบงค์ขึ้นเครื่องได้ไหม", None),        # Wh rules — เคสจริงที่พบบ่อย
        ("shipping_policy", "อันนี้ผ่าน ตม. เครื่องบินไหม", None),
        ("shipping_policy", "ใช้ต่างประเทศได้ไหม", None),
        # ---- shipping จริง: ship verb ชนะ / ไม่มี travel kw ----
        ("shipping_policy", "ส่งไปจีนได้ไหม", "shipping_policy"),          # ถามจัดส่งจริง
        ("shipping_policy", "ส่งต่างประเทศได้ไหม", "shipping_policy"),
        ("shipping_policy", "จัดส่งขึ้นเครื่องบินกี่วัน", "shipping_policy"),# ship verb ชนะ
        ("shipping_policy", "ส่งกี่วัน", "shipping_policy"),
        ("shipping_policy", "เมื่อไหร่ได้ของ", "shipping_policy"),
        ("shipping_policy", "ค่าส่งเท่าไหร่", "shipping_policy"),
        # ---- categories: noun เจาะจง → product flow ----
        ("categories", "มีสินค้า smart home ไหม", None),                   # #199 เดิม
        ("categories", "มีเครื่องชงกาแฟขายไหม", None),
        ("categories", "ขายหม้อทอดไร้น้ำมันไหม", None),
        ("categories", "มีแท่นชาร์จ magsafe ไหม", None),
        # ---- categories จริง: noun กว้าง → คงเดิม ----
        ("categories", "มีสินค้าอะไรบ้าง", "categories"),
        ("categories", "ขายอะไรบ้าง", "categories"),
        ("categories", "มีหมวดหมู่อะไรบ้าง", "categories"),
        ("categories", "มีประเภทอะไรบ้าง", "categories"),
        ("categories", "มีของขายบ้าง", "categories"),
        # ---- qtype อื่น/None → ไม่แตะ ----
        ("brands", "มีแบรนด์อะไรบ้าง", "brands"),
        ("shops", "มีร้านอะไรบ้าง", "shops"),
        ("warranty_policy", "รับประกันกี่ปี", "warranty_policy"),
        ("return_policy", "รับคืนไหม", "return_policy"),
        ("tax_invoice", "ขอใบกำกับภาษี", "tax_invoice"),
        (None, "ขึ้นเครื่องได้ไหม", None),
        (None, "มีสินค้า smart home ไหม", None),
        ("shipping_policy", "", "shipping_policy"),                       # message ว่าง → คงเดิม
    ]
    passed = 0
    for qtype, msg, expected in cases:
        label = f"{qtype!r} | {msg!r}"
        passed += 1 if _check(label, bypass(qtype, msg), expected) else 0
    print(f"\n{passed}/{len(cases)} passed")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
