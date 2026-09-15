#!/usr/bin/env python3
"""Live test — katess.nk scenario (5 questions).

จำลองแชทจริง:
  Q1: ลูกค้าส่ง item card Run → bot ตอบ Run
  Q2: "รุ่นนี้กับตัว swim แนะนำตัวไหนดีคะ" → ควรเปรียบเทียบ Run vs Swim
  Q3: ลูกค้าส่ง item card Swim → bot ตอบ Swim
  Q4: "คุณภาพเสียงหล่ะคะต่างกันไหมเอ่ย" → ควรเปรียบเทียบ Run vs Swim
  Q5: "อยากทราบคุณภาพเสียงค่ะ" → ควรตอบทั้งสองรุ่น (post-comparison follow-up)
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid

import requests

BOT_URL = "http://127.0.0.1:8010/chat"
INTERNAL_SECRET = os.environ.get("CHATBOT_INTERNAL_SECRET", "")

# item_id จาก DB
RUN_ITEM_ID = "55317060880"  # iSUPER SoundActiv Run
SWIM_ITEM_ID = "19277219084"  # iSUPER SoundActiv Swim


def call_bot(message, history, conversation_id, item_id=None):
    body = {
        "message": message,
        "history": history,
        "limit": 5,
        "conversation_id": conversation_id,
        "platform": "shopee",
    }
    if item_id:
        body["item_id"] = item_id
    headers = {"Content-Type": "application/json"}
    if INTERNAL_SECRET:
        headers["X-Internal-Secret"] = INTERNAL_SECRET
    resp = requests.post(BOT_URL, json=body, headers=headers, timeout=120)
    if not resp.ok:
        return {"error": f"http {resp.status_code}", "answer": ""}
    return resp.json()


def run_test():
    conv_id = f"test_katess_{uuid.uuid4().hex[:8]}"
    history = []

    cases = [
        {"label": "Q1", "message": "[item]", "item_id": RUN_ITEM_ID,
         "expect": "product (Run)"},
        {"label": "Q2", "message": "รุ่นนี้กับตัว swim แนะนำตัวไหนดีคะ",
         "expect": "comparison Run vs Swim"},
        {"label": "Q3", "message": "[item]", "item_id": SWIM_ITEM_ID,
         "expect": "product (Swim)"},
        {"label": "Q4", "message": "คุณภาพเสียงหล่ะคะต่างกันไหมเอ่ย",
         "expect": "comparison Run vs Swim"},
        {"label": "Q5", "message": "อยากทราบคุณภาพเสียงค่ะ",
         "expect": "both Run + Swim (post-comparison follow-up)"},
    ]

    print(f"conversation_id: {conv_id}")
    print(f"Run item_id: {RUN_ITEM_ID}")
    print(f"Swim item_id: {SWIM_ITEM_ID}")
    print()

    for case in cases:
        label = case["label"]
        msg = case["message"]
        item_id = case.get("item_id")
        expect = case["expect"]

        t0 = time.time()
        result = call_bot(msg, history, conv_id, item_id=item_id)
        elapsed = time.time() - t0

        answer = result.get("answer", "")
        products = result.get("products", [])
        error = result.get("error")

        # สะสม history
        history.append({"role": "user", "text": msg})
        history.append({"role": "model", "text": answer})

        print(f"── {label} ({elapsed:.1f}s) ──")
        print(f"  ลูกค้า: {msg}")
        if item_id:
            print(f"  item_id: {item_id}")
        if error:
            print(f"  ❌ ERROR: {error}")
        else:
            # ตรวจว่ามี Run และ Swim ใน products ไหม
            product_names = [p.get("name", "")[:50] for p in products]
            has_run = any("Run" in n for n in product_names)
            has_swim = any("Swim" in n for n in product_names)
            print(f"  products ({len(products)}): {product_names}")
            print(f"  has_run={has_run}  has_swim={has_swim}")
            print(f"  Bot: {answer[:200]}")
            if label in ("Q2", "Q4") and has_run and has_swim:
                print(f"  ✅ {label}: มีทั้ง Run + Swim ใน context → เปรียบเทียบได้")
            elif label == "Q5" and has_run and has_swim:
                print(f"  ✅ {label}: post-comparison follow-up → มีทั้ง Run + Swim")
            elif label in ("Q2", "Q4", "Q5"):
                if not has_run:
                    print(f"  ⚠️ {label}: ไม่มี Run ใน context")
                if not has_swim:
                    print(f"  ⚠️ {label}: ไม่มี Swim ใน context")
        print(f"  expect: {expect}")
        print()


if __name__ == "__main__":
    run_test()
