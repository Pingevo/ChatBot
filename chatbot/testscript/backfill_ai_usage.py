#!/usr/bin/env python3
"""
backfill_ai_usage.py — ส่ง log ย้อนหลังไป AI Usage Hub สำหรับ call ที่ทำไปแล้ว
                       แต่ยังไม่ได้ log (จาก test_openrouter_full_cost.py รอบแรก)

ข้อมูลมาจาก output ที่เซฟไว้ใน shell log — มี tokens + cost + duration ครบทุก step
"""
from __future__ import annotations
import os
import sys
import json
import urllib.request
from pathlib import Path

# ─── path + .env ─────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

SHOP = "CukTechThailand"

# ─── ข้อมูลจาก output รอบแรก (parse จาก log) ────────────────
#    format: (question_idx, step, model, prompt_tokens, output_tokens, cost_usd, duration_s)
LOGS = [
    # Q1: หาสายชาร์จ (มี vision)
    (1, "vision",    "google/gemini-3.1-flash-lite",    390,  59, 0.000186, 1.48),
    (1, "intent",    "google/gemini-3.1-flash-lite",   1047,  37, 0.000317, 0.99),
    (1, "llm2",      "google/gemini-3.5-flash-lite",  13592, 216, 0.004618, 2.01),
    (1, "web_search","google/gemini-2.5-flash:online", 4586, 300, 0.009126, 4.24),
    (1, "llm2_again","google/gemini-3.5-flash-lite",  13965, 328, 0.005010, 2.21),
    # Q2: หาสายชาร์จ ไอโฟน 11...
    (2, "intent",    "google/gemini-3.1-flash-lite",   1399,  43, 0.000414, 0.81),
    (2, "llm2",      "google/gemini-3.5-flash-lite",  13875, 203, 0.004670, 2.22),
    (2, "web_search","google/gemini-2.5-flash:online", 3321, 300, 0.008746, 3.54),
    (2, "llm2_again","google/gemini-3.5-flash-lite",  14808, 216, 0.002778, 2.04),
    # Q3: ไม่มีสาย ligthning หรอ
    (3, "intent",    "google/gemini-3.1-flash-lite",   1622,  38, 0.000463, 0.90),
    (3, "llm2",      "google/gemini-3.5-flash-lite",  14098, 222, 0.002582, 1.96),
    (3, "web_search","google/gemini-2.5-flash:online", 3748, 196, 0.008614, 3.85),
    (3, "llm2_again","google/gemini-3.5-flash-lite",  13955, 245, 0.002596, 1.98),
    # Q4: แล้วทำไมตะกี้บอกไม่มีอะ่
    (4, "intent",    "google/gemini-3.1-flash-lite",   1877,  37, 0.000525, 1.06),
    (4, "llm2",      "google/gemini-3.5-flash-lite",  13793, 255, 0.002575, 1.97),
    (4, "web_search","google/gemini-2.5-flash:online", 3916, 300, 0.008925, 4.64),
    (4, "llm2_again","google/gemini-3.5-flash-lite",  10970, 281, 0.001795, 2.15),
    # Q5: มีหัวชาจไหม ใช้ในรถ (มี vision)
    (5, "vision",    "google/gemini-3.1-flash-lite",    392,  76, 0.000212, 2.04),
    (5, "intent",    "google/gemini-3.1-flash-lite",   1832,  38, 0.000515, 1.01),
    (5, "llm2",      "google/gemini-3.5-flash-lite",  16908, 230, 0.003446, 2.68),
    (5, "web_search","google/gemini-2.5-flash:online", 4738, 272, 0.009101, 3.14),
    (5, "llm2_again","google/gemini-3.5-flash-lite",  10741,  96, 0.000717, 1.44),
    # Q6: CUKTECH CC903P Car Charger 100W Max อันนี้มีไหม
    (6, "intent",    "google/gemini-3.1-flash-lite",   1769,  38, 0.000499, 1.71),
    (6, "llm2",      "google/gemini-3.5-flash-lite",  11075, 275, 0.001267, 2.21),
    (6, "web_search","google/gemini-2.5-flash:online", 5878, 300, 0.009513, 5.34),
    (6, "llm2_again","google/gemini-3.5-flash-lite",  18146, 274, 0.003377, 2.19),
    # Q7: CUKTECH WCJ153 2 in 1 Car Charge
    (7, "intent",    "google/gemini-3.1-flash-lite",   1820,  45, 0.000522, 1.66),
    (7, "llm2",      "google/gemini-3.5-flash-lite",  11378, 270, 0.004088, 1.81),
    (7, "web_search","google/gemini-2.5-flash:online", 6258, 300, 0.009627, 3.83),
    (7, "llm2_again","google/gemini-3.5-flash-lite",  15955, 232, 0.002619, 1.83),
    # Q8: สรุปคือมี สรปุมีหรือไม่มี
    (8, "intent",    "google/gemini-3.1-flash-lite",   1764,  38, 0.000498, 0.96),
    (8, "llm2",      "google/gemini-3.5-flash-lite",  11613, 317, 0.001537, 2.34),
    (8, "web_search","google/gemini-2.5-flash:online", 5630, 264, 0.009349, 3.48),
    (8, "llm2_again","google/gemini-3.5-flash-lite",  16239, 109, 0.002398, 1.76),
]


def main():
    hub_url = os.environ.get("AI_USAGE_HUB_URL", "").strip()
    hub_token = os.environ.get("AI_USAGE_HUB_TOKEN", "").strip()
    if not hub_url or not hub_token:
        print("❌ ไม่พบ AI_USAGE_HUB_URL หรือ AI_USAGE_HUB_TOKEN — ตั้งค่าก่อนรัน")
        sys.exit(1)

    print(f"=== Backfill AI Usage Hub ===")
    print(f"Hub: {hub_url}")
    print(f"Logs: {len(LOGS)}")
    print()

    total_cost = 0.0
    success = 0
    failed = 0

    for q_idx, step, model, p_t, o_t, cost, duration_s in LOGS:
        entry = {
            "provider": "openrouter",
            "model": model,
            "operation": "chat.completions",
            "source": f"test_full_cost:{step}",
            "user": "system:cost_test",
            "reference": f"shop:{SHOP}|step:{step}|q:{q_idx}",
            "prompt_tokens": p_t,
            "completion_tokens": o_t,
            "cost_usd": round(cost, 6),
            "duration_ms": int(duration_s * 1000),
            "attempt": 1,
            "status": "success",
            "http_status": 200,
            "metadata": {
                "shop": SHOP,
                "step": step,
                "question_index": q_idx,
                "test_script": True,
                "backfill": True,
            },
        }

        try:
            body = json.dumps(entry).encode("utf-8")
            req = urllib.request.Request(
                f"{hub_url.rstrip('/')}/internal/ai-usage/logs",
                data=body,
                headers={"Content-Type": "application/json", "x-service-token": hub_token},
                method="POST",
            )
            resp = urllib.request.urlopen(req, timeout=10)
            resp_data = json.loads(resp.read().decode("utf-8"))
            print(f"  ✓ Q{q_idx} {step:12s} {model:38s} {p_t:6d}+{o_t:4d}  ${cost:.6f}")
            total_cost += cost
            success += 1
        except Exception as e:
            print(f"  ✗ Q{q_idx} {step:12s} FAILED: {e}")
            failed += 1

    print()
    print(f"=== สรุป ===")
    print(f"Success: {success}/{len(LOGS)}")
    print(f"Failed:  {failed}/{len(LOGS)}")
    print(f"Total cost logged: ${total_cost:.6f} (฿{total_cost * 36:.4f})")


if __name__ == "__main__":
    main()
