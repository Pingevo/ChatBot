#!/usr/bin/env python3
"""Live test — เคสสำหรับโมดูลที่ย้ายออกจาก app.py (refactor).

ครอบคลุม:
- order_flow.py:  order lookup (found/not-found), order anchor follow-up,
                  tracking lookup, return/refund + follow-up, address request
- handoffs.py:    human request, tax invoice, มอก. (TISI)
- device_compat.py: compat question + follow-up (เส้นทางที่เคยเจอ _re_w regression)

วิธีรัน:
    server ต้องรันอยู่ที่ 127.0.0.1:8010 (uvicorn shopeechat.app:app)
    .venv/bin/python test/test_extracted_modules_live.py

หมายเหตุ: เคสที่ยิง LLM จริง (compat/product) อาจ miss ถ้า quota หมด (429)
— ดู server log แยก quota vs code error
"""
from __future__ import annotations

import os
import sys
import time
import uuid

import requests

BOT_URL = "http://127.0.0.1:8010/chat"
SHOP = "KingGadgets"
INTERNAL_SECRET = os.environ.get("CHATBOT_INTERNAL_SECRET", "")

# order จริงใน DB (KingGadgets) — ใช้เทส path "found"
REAL_ORDER_SN = "220725DCDR7DBN"
REAL_TRACKING_NO = "SHP5161519258"
FAKE_ORDER_SN = "240215ZZZZZZ99"


def call_bot(message: str, history: list, conversation_id: str,
             item_id: str | None = None) -> dict:
    body = {
        "message": message,
        "history": history,
        "limit": 5,
        "shop": SHOP,
        "conversation_id": conversation_id,
        "platform": "shopee",
    }
    if item_id:
        body["item_id"] = item_id
    headers = {"Content-Type": "application/json"}
    if INTERNAL_SECRET:
        headers["X-Internal-Secret"] = INTERNAL_SECRET
    try:
        resp = requests.post(BOT_URL, json=body, headers=headers, timeout=120)
        if not resp.ok:
            return {"error": f"http {resp.status_code}", "answer": ""}
        return resp.json()
    except Exception as e:
        return {"error": str(e), "answer": ""}


def check(result: dict, expect: str) -> tuple[bool, str]:
    """คืน (ok, note) ตาม expect type."""
    answer = result.get("answer", "")
    handoff = result.get("handoff_to_admin", False)
    source = result.get("source", "")
    products = result.get("products", [])

    if expect == "order_found":
        if "ไม่พบ" in answer or not answer:
            return False, f"คาดว่าเจอ order แต่ตอบ: {answer[:80]}"
        return True, f"source={source}"
    if expect == "order_not_found":
        if "ไม่พบ" in answer or "ไม่เจอ" in answer or not result.get("order"):
            return True, f"source={source}"
        return False, "คาดว่าไม่เจอ order แต่ดูเหมือนเจอ"
    if expect == "handoff":
        if handoff:
            return True, f"source={source} reason={result.get('handoff_reason')}"
        return False, f"คาด handoff แต่ไม่ได้ (source={source})"
    if expect == "product":
        if products:
            return True, f"source={source} products={len(products)}"
        return False, f"คาดสินค้าแต่ไม่มี (source={source})"
    # any — ขอแค่ไม่ error + มีคำตอบ
    if answer:
        return True, f"source={source}"
    return False, "ไม่มีคำตอบ"


SCENARIOS = [
    # ── order_flow.py ──────────────────────────────────────────────
    {
        "name": "A: order lookup — found + anchor follow-up",
        "conv": "extracted_order_a",
        "cases": [
            {"msg": f"ขอดูสถานะคำสั่งซื้อ {REAL_ORDER_SN}", "expect": "order_found"},
            {"msg": "order ถึงยัง", "expect": "any"},  # anchor follow-up
        ],
    },
    {
        "name": "B: order lookup — not found",
        "conv": "extracted_order_b",
        "cases": [
            {"msg": f"สถานะคำสั่งซื้อ {FAKE_ORDER_SN}", "expect": "order_not_found"},
        ],
    },
    {
        # หมายเหตุ: lookup_by_tracking ค้น package_list.* เท่านั้น แต่ Shopee
        # เก็บ tracking_no ไว้ top-level → path นี้ miss เสมอกับ data shape ปัจจุบัน
        # (behavior เดิมก่อน refactor — order_store.py ไม่ได้แตะ)
        # → bot ตอบขอเลขคำสั่งซื้อ (shipping_policy) แทน
        "name": "C: tracking lookup (fallback — tracking อยู่ top-level)",
        "conv": "extracted_track_c",
        "cases": [
            {"msg": f"เลขพัสดุ {REAL_TRACKING_NO} ถึงยัง", "expect": "any"},
        ],
    },
    {
        "name": "D: return/refund → ask order_sn → follow-up handoff",
        "conv": "extracted_rr_d",
        "cases": [
            {"msg": "ขอคืนเงินค่ะ", "expect": "any"},  # ถามเลข order หรือ handoff
            {"msg": f"{REAL_ORDER_SN}", "expect": "handoff"},  # rr follow-up → handoff
        ],
    },
    {
        "name": "E: address request → handoff ทันที",
        "conv": "extracted_addr_e",
        "cases": [
            {"msg": "ขอที่อยู่ส่งคืนสินค้าค่ะ", "expect": "handoff"},
        ],
    },
    # ── handoffs.py ────────────────────────────────────────────────
    {
        "name": "F: human request → handoff",
        "conv": "extracted_human_f",
        "cases": [
            {"msg": "ขอคุยกับแอดมินค่ะ", "expect": "handoff"},
        ],
    },
    {
        "name": "G: tax invoice → handoff",
        "conv": "extracted_tax_g",
        "cases": [
            {"msg": "ขอใบกำกับภาษีค่ะ", "expect": "handoff"},
        ],
    },
    {
        "name": "H: มอก. question (TISI)",
        "conv": "extracted_tisi_h",
        "cases": [
            {"msg": "รุ่นไหนมี มอก. บ้าง", "expect": "any"},
        ],
    },
    # ── device_compat.py ───────────────────────────────────────────
    {
        "name": "I: device compat + follow-up (เคยพัง _re_w)",
        "conv": "extracted_compat_i",
        "cases": [
            {"msg": "สนใจหัวชาร์จที่ใช้กับ iphone 17 pro max", "expect": "product"},
            {"msg": "หัวชาร์จละ", "expect": "any"},  # compat follow-up — regression path
            {"msg": "ราคาเท่าไหร่", "expect": "any"},
        ],
    },
]


def run_scenario(sc: dict) -> tuple[int, int, int]:
    conv_id = f"{sc['conv']}_{uuid.uuid4().hex[:8]}"
    history: list = []
    passed = failed = errors = 0
    print(f"\n{'='*70}\n# {sc['name']}\n# conv={conv_id}\n{'='*70}")
    for i, case in enumerate(sc["cases"], 1):
        t0 = time.time()
        result = call_bot(case["msg"], history, conv_id, item_id=case.get("item_id"))
        elapsed = time.time() - t0
        if "error" in result:
            print(f"── Q{i} ── ERROR ({elapsed:.1f}s)  ลูกค้า: {case['msg'][:60]}")
            print(f"   ERROR: {result['error']}")
            errors += 1
            continue
        answer = result.get("answer", "")
        history.append({"role": "user", "text": case["msg"]})
        history.append({"role": "model", "text": answer})
        ok, note = check(result, case["expect"])
        passed += ok
        failed += not ok
        status = "✅" if ok else "❌"
        print(f"── Q{i} ── {status} ({elapsed:.1f}s) {note} handoff={result.get('handoff_to_admin')}")
        print(f"   ลูกค้า: {case['msg'][:80]}")
        print(f"   เรา: {answer[:160]}")
    return passed, failed, errors


def main():
    total_p = total_f = total_e = 0
    for sc in SCENARIOS:
        p, f, e = run_scenario(sc)
        total_p += p
        total_f += f
        total_e += e
    print(f"\n{'='*70}")
    print(f"# รวมทั้งหมด: {total_p} ผ่าน, {total_f} ไม่ผ่าน, {total_e} error")
    print(f"{'='*70}")
    sys.exit(1 if (total_f or total_e) else 0)


if __name__ == "__main__":
    main()
