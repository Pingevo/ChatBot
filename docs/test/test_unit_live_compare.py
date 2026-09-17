"""Live compare: :8010 (prod, flag OFF) vs :8015 (flag=charger) — same cases.

รัน: PYTHONPATH=chatbot .venv/bin/python docs/test/test_unit_live_compare.py
ครอบ: shop-scoped, order_sn, item_id, history, images, non-charger types
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

import requests  # noqa: E402
from chatbot.shopeechat import knowledge_base  # noqa: E402

knowledge_base._load_env()
SECRET = os.environ.get("CHATBOT_INTERNAL_SECRET", "")
PORTS = {"prod(off)": 8010, "unit(charger)": 8015}

CASES = [
    # ── shop-scoped charger family (unit path engage เมื่อ flag on) ──
    ("charger+shop", "สายชาร์จ AL870 มีไหม", {"shop": "CukTechThailand"}),
    ("charger+shop", "HA835 พร้อมสาย มีไหม", {"shop": "CukTechThailand"}),
    ("car charger+shop", "มีหัวชาร์จในรถไหม", {"shop": "CukTechThailand"}),
    ("adapter+shop", "หัวชาร์จ 65w รุ่นไหนดี", {"shop": "CukTechThailand"}),
    # ── non-charger ทั่วไป (flag on ก็ต้องยัง legacy) ──
    ("powerbank", "พาวเวอร์แบงค์แนะนำหน่อย", {"shop": "CukTechThailand"}),
    ("camera", "มีกล้องวงจรปิดแนะนำไหม", {"shop": "IMILabThailand"}),
    ("หมอนรองหลัง", "มีหมอนรองหลังไหม", {}),
    ("หม้อหุงข้าว", "หม้อหุงข้าวมีไหม", {}),
    ("เก้าอี้นวด", "เก้าอี้นวดราคาเท่าไหร่", {}),
    ("เบาะรองหลัง", "เบาะรองหลังในรถมีไหม", {}),
    # ── order_sn ──
    ("order", "order นี้ถึงไหนแล้ว", {"order_sn": "220725DCDR7DBN", "shop": "KingGadgets"}),
    # ── item_id card ──
    ("item_id", "[item]", {"item_id": "55317060880", "shop": "iSuperStore"}),
    # ── history follow-up ──
    ("history", "ตัวนี้ราคาเท่าไหร่คะ", {
        "shop": "CukTechThailand",
        "history": [
            {"role": "user", "content": "HA835 พร้อมสาย มีไหม"},
            {"role": "assistant", "content": "HA835 พร้อมสายชาร์จ 65W หมดสต็อกชั่วคราวค่ะ"},
        ],
    }),
    # ── image (ส่งรูปสินค้าเข้ามา) ──
    ("image", "รุ่นนี้รับประกันกี่ปี", {
        "shop": "CukTechThailand",
        "images": ["https://cf.shopee.co.th/file/th-11134208-81zth-mnf4x9mije2t0d"],
    }),
]


def call(port: int, msg: str, extra: dict) -> dict:
    body = {"message": msg, "history": extra.pop("history", []),
            "limit": 5, "conversation_id": "test-cmp", "platform": "shopee", **extra}
    h = {"Content-Type": "application/json", "X-Internal-Secret": SECRET}
    try:
        r = requests.post(f"http://127.0.0.1:{port}/chat", json=body, headers=h, timeout=180)
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def main() -> int:
    print(f"{'case':<20} {'port':<14} {'source':<22} answer")
    print("=" * 110)
    fails = 0
    for label, msg, extra in CASES:
        for pname, port in PORTS.items():
            j = call(port, msg, dict(extra))
            if "error" in j or not j.get("answer"):
                fails += 1
                print(f"{label:<20} {pname:<14} {'ERROR':<22} {j.get('error') or j}")
                continue
            ans = " ".join((j.get("answer") or "").split())[:75]
            print(f"{label:<20} {pname:<14} {str(j.get('source')):<22} {ans}")
        print("-" * 110)
    print(f"\n{'FAIL' if fails else 'ALL RESPONDED'}: {fails} errors / {len(CASES)*2} calls")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
