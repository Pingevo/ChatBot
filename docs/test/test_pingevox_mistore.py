#!/usr/bin/env python3
"""Live regression test — pingevox + mistorethailand (ร้าน KingGadgets).

ทดสอบบอทของเรา (legacy chat()) เทียบกับคำตอบ Zaapi จริง
โดยส่งคำถามตามลำดับ conversation พร้อม history สะสม

ผู้ใช้ระบุ:
> ให้เทสเคสของ pingevox ร้าน kinggadget และ case mistore ร้าน kinggadget เสมอ

ร้าน: KingGadgets (ทั้ง 2 ลูกค้าทักเข้าร้านเดียวกัน)
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import requests

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "chatbot" / "frontendScript"))

BOT_URL = "http://127.0.0.1:8010/chat"
SHOP = "KingGadgets"
INTERNAL_SECRET = os.environ.get("CHATBOT_INTERNAL_SECRET", "")


def call_bot(message: str, history: list, conversation_id: str,
             item_id: str | None = None, order_sn: str | None = None,
             images: list[str] | None = None) -> dict:
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
    if order_sn:
        body["order_sn"] = order_sn
    if images:
        body["images"] = images
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


def run_transcript(name: str, cases: list[dict], conversation_id: str):
    """รัน transcript ทั้งหมด สะสม history ไปเรื่อยๆ"""
    print(f"\n{'='*70}")
    print(f"# {name} — ร้าน {SHOP}")
    print(f"{'='*70}")
    history: list = []
    passed = 0
    failed = 0
    errors = 0
    for i, case in enumerate(cases, 1):
        msg = case["message"]
        item_id = case.get("item_id")
        order_sn = case.get("order_sn")
        images = case.get("images")
        zaapi_answer = case.get("zaapi", "")
        expect_type = case.get("expect", "any")  # any/product/claim/handoff/greeting

        t0 = time.time()
        result = call_bot(msg, history, conversation_id, item_id=item_id,
                          order_sn=order_sn, images=images)
        elapsed = time.time() - t0

        if "error" in result:
            print(f"\n── Q{i} ── ERROR ({elapsed:.1f}s)")
            print(f"  ลูกค้า: {msg[:80]}")
            print(f"  ERROR: {result['error']}")
            errors += 1
            continue

        answer = result.get("answer", "")
        products = result.get("products", [])
        handoff = result.get("handoff_to_admin", False)
        routing = result.get("routing_decision", {})
        route_type = routing.get("type", "?") if isinstance(routing, dict) else "?"

        # สะสม history
        history.append({"role": "user", "text": msg})
        history.append({"role": "model", "text": answer})

        # ตรวจผลตาม expect_type
        ok = True
        note = ""
        if expect_type == "product":
            if not products:
                ok = False
                note = "❌ คาดว่าจะได้สินค้า แต่ไม่มี"
        elif expect_type == "claim" or expect_type == "handoff":
            if not handoff:
                ok = False
                note = "❌ คาดว่าจะ handoff แต่ไม่ได้"
        elif expect_type == "greeting":
            if not answer:
                ok = False
                note = "❌ ไม่มีคำตอบ"

        # แสดงผล
        status = "✅" if ok else "❌"
        if ok:
            passed += 1
        else:
            failed += 1
        print(f"\n── Q{i} ── {status} ({elapsed:.1f}s) route={route_type} handoff={handoff} products={len(products)}")
        if note:
            print(f"  {note}")
        print(f"  ลูกค้า: {msg[:100]}")
        print(f"  เรา: {answer[:200]}")
        if zaapi_answer:
            print(f"  Zaapi: {zaapi_answer[:200]}")

    print(f"\n{'='*70}")
    print(f"# {name} สรุป: {passed} ผ่าน, {failed} ไม่ผ่าน, {errors} error (รวม {len(cases)} เคส)")
    print(f"{'='*70}")
    return passed, failed, errors


# ──────────────────────────────────────────────────────────────────────────
# pingevox — 5 คำถาม (ร้าน KingGadgets)
# ──────────────────────────────────────────────────────────────────────────
PINGEVOX_CASES = [
    {
        "message": "[สินค้า: 49267582152]",  # CTL301 item card
        "item_id": "49267582152",
        "expect": "product",
        "zaapi": "",  # Q1 ไม่มีคำตอบ Zaapi
    },
    {
        "message": "ซาหวัดดีจ้า",
        "expect": "greeting",
        "zaapi": "สวัสดีค่ะ ร้าน kinggadgets ยินดีให้บริการค่ะ...",
    },
    {
        "message": "อยากได้ของที่ใช้กับ xiaomi 17 ultra",
        "expect": "product",
        "zaapi": "สายชาร์จรุ่น CUKTECH CTL301...ไม่สามารถใช้งานกับ Xiaomi 17 Ultra ได้...แนะนำ CTC615N, CTC615P, CMC610...",
    },
    {
        "message": "หัวชาร์จละ",
        "expect": "product",
        "zaapi": "แนะนำ AD1003T, AD1003, AD653U, AD653, AD1404U, AD1204U...",
    },
    {
        "message": "ดีจ้า",
        "expect": "greeting",
        "zaapi": "สวัสดีค่ะ ยินดีต้อนรับกลับมานะคะ...",
    },
]

# ──────────────────────────────────────────────────────────────────────────
# mistorethailand — 37 คำถาม (ร้าน KingGadgets)
# ──────────────────────────────────────────────────────────────────────────
MISTORE_CASES = [
    {"message": "สวัสดีครับ", "expect": "greeting", "zaapi": ""},
    {"message": "Bundle", "expect": "any", "zaapi": ""},  # Q2 bundle
    {"message": "[faq_liveagent]", "expect": "any", "zaapi": ""},  # Q3 — system tag ไม่ใช่ human request
    {"message": "สวัสดีครับ", "expect": "greeting", "zaapi": "ทางเราได้รับเรื่องแล้ว...เจ้าหน้าที่มนุษย์..."},  # Q4
    {
        "message": "สวัสดีครับ สนใจหัวชาร์จที่ใช้กับ iphone 17 pro max",
        "expect": "product",
        "zaapi": "รุ่น CUKTECH AD301N (30W), AC65B (65W), AC45B (45W), AC65B2 (65W), AD653 (90W), AD653U (100W)...รับประกัน 2 ปี",
    },
    {
        "message": "AC65B เทียบกับ AC65B2 ต่างกันยังไง",
        "expect": "product",
        "zaapi": "AC65B2 รองรับชาร์จ 2 อุปกรณ์...Super Fast Charge สำหรับ Samsung...ตัวบาง...",
    },
    {"message": "แล้ว iphone หละแนะนำอันไหน 2 อันนี้", "expect": "any", "zaapi": ""},  # Q7
    {"message": "แล้วราคาเท่าไหร่", "expect": "any", "zaapi": ""},  # Q8
    {
        "message": "ขอลิงค์ด้วย",
        "expect": "any",
        "zaapi": "ไม่สามารถส่งลิงก์ภายนอก...พิมพ์ CUKTECH AC65B และ CUKTECH AC65B2...",
    },  # Q9
    {
        "message": "รุ่นไหนมี มอก. บ้าง",
        "expect": "any",
        "zaapi": "เจ้าหน้าที่มนุษย์เข้ามาให้ข้อมูล...",  # Zaapi handoff
    },  # Q10
    {"message": "มีรุ่นไหแนะนำอีก", "expect": "any", "zaapi": ""},  # Q11
    {
        "message": "สวัสดีครับ สนใจ powerbank ที่ใบ่กับ MacBook air",
        "expect": "product",
        "zaapi": "หากต้องการข้อมูล มอก...ติดต่อเจ้าหน้าที่...",  # Zaapi ตอบผิดคำถาม
    },  # Q12
    {"message": "ขอลิงค์สินค้า", "expect": "any", "zaapi": ""},  # Q13
    {"message": "สวัสดีครับ", "expect": "greeting", "zaapi": ""},  # Q14
    {
        "message": "สอบถาม WPB100L ใช้กัยมือถือ xiaomi ได้ไหม",
        "expect": "any",
        "zaapi": "WPB100L ไม่รองรับชาร์จเร็ว Xiaomi...ชาร์จความเร็วมาตรฐานได้...",
    },  # Q15
    {"message": "สวัสดีครับ", "expect": "greeting", "zaapi": ""},  # Q16
    {
        "message": "สนใจ PB WPB100L",
        "expect": "any",
        "zaapi": "WPB100L ไม่รองรับชาร์จเร็ว Xiaomi...ค้นหา CUKTECH WPB100L...",
    },  # Q17
    {
        "message": "ขอลิงค์สินค้า",
        "expect": "any",
        "zaapi": "ไม่สามารถส่งลิงก์...พิมพ์ CUKTECH WPB100L...",
    },  # Q18
    {
        "message": "สินค้ารุ่นนี้หมดประกันยังที่ซื้อมา",
        "expect": "any",  # warranty policy question ไม่ใช่ claim — intent=general_question ถูกแล้ว
        "zaapi": "รับเรื่องแจ้งปัญหา...แจ้ง 3 อย่าง: หมายเลขคำสั่งซื้อ, ชื่อ+เบอร์, วิดีโอ...",
    },  # Q19 — warranty policy question (ไม่ใช่ claim)
    {"message": "สวัสดีตรับ", "expect": "any", "zaapi": "รบกวนแจ้งหมายเลขคำสั่งซื้อ ชื่อ เบอร์..."},  # Q20
    {
        "message": "จะสอบถามสเปคสินค้ารุ่น a18T",
        "expect": "product",
        "zaapi": "A18T GaN Gen 3 30W, PD3.0, QC3.0, PPS, AFC, มอก., รับประกัน 2 ปี...",
    },  # Q21
    {
        "message": "สวัาดีครับ หัวชาร์จ a18t ใช้งานไม่ได้",
        "expect": "claim",
        "zaapi": "ต้องขออภัย...แจ้ง: หมายเลขคำสั่งซื้อ, ชื่อ+เบอร์, วิดีโอ...",
    },  # Q22 — claim
    {"message": "1 77373737\n2.อู๋", "expect": "any", "zaapi": "ไม่พบหมายเลขคำสั่งซื้อ...แจ้งเบอร์โทร..."},  # Q23
    {"message": "[วิดีโอ]", "expect": "any", "zaapi": "ไม่พบหมายเลขคำสั่งซื้อ...แจ้งเบอร์โทร...", "images": ["video_placeholder"]},  # Q24
    {"message": "0830307878", "expect": "any", "zaapi": "ได้รับเบอร์...ไม่พบคำสั่งซื้อ..."},  # Q25
    {"message": "เห้ยช้าว่ะ จำไม่ได้เว้ย", "expect": "any", "zaapi": "แจ้งหมายเลขคำสั่งซื้อได้เลย..."},  # Q26
    {"message": "ตำไม่ได้ เช็คหน่อย หัวร้อนแล้วนะ", "expect": "any", "zaapi": "เจ้าหน้าที่ดำเนินการตรวจสอบ..."},  # Q27
    {"message": "สวัสดี", "expect": "greeting", "zaapi": ""},  # Q28
    {
        "message": "สอบถาม สายชาร์จ ชาร์จไฟไม่ได้",
        "expect": "claim",
        "zaapi": "ได้รับเรื่อง...ส่งเรื่องไปเจ้าหน้าที่มนุษย์...",
    },  # Q29 — claim
    {"message": ",", "expect": "any", "zaapi": ""},  # Q30
    {"message": ",", "expect": "any", "zaapi": ""},  # Q31
    {"message": ",", "expect": "any", "zaapi": ""},  # Q32
    {"message": ",,", "expect": "any", "zaapi": ""},  # Q33
    {"message": ",", "expect": "any", "zaapi": ""},  # Q34
    {"message": ",", "expect": "any", "zaapi": ""},  # Q35
    {"message": ",", "expect": "any", "zaapi": ""},  # Q36
    {
        "message": ",",
        "expect": "any",
        "zaapi": "ขออภัย...ส่งต่อเจ้าหน้าที่มนุษย์...",
    },  # Q37
]


if __name__ == "__main__":
    # ใช้ conversation_id ต่างกันเพื่อไม่ให้ timeline ทับกัน
    ts = int(time.time())
    p_pass, p_fail, p_err = run_transcript(
        "pingevox", PINGEVOX_CASES, f"test_pingevox_{ts}"
    )
    m_pass, m_fail, m_err = run_transcript(
        "mistorethailand", MISTORE_CASES, f"test_mistore_{ts}"
    )
    total_pass = p_pass + m_pass
    total_fail = p_fail + m_fail
    total_err = p_err + m_err
    total = total_pass + total_fail + total_err
    print(f"\n{'='*70}")
    print(f"# รวมทั้งหมด: {total_pass} ผ่าน, {total_fail} ไม่ผ่าน, {total_err} error (รวม {total} เคส)")
    print(f"{'='*70}")
