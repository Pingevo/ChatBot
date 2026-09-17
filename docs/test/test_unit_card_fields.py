"""Test Task 6 — per-variation fields ใน product card + model_id ใน timeline anchor.

รัน: .venv/bin/python docs/test/test_unit_card_fields.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import product_store as ps
from chatbot.shopeechat import conversation_products as cp


def main() -> int:
    docs = json.load(open(ROOT / "exports" / "ShpProducts.export.json", encoding="utf-8"))

    # ── variants มี model_id/stock/model_status/price ──
    d = next(x for x in docs if x.get("item_name", "").startswith("IMILAB EC4"))
    card = ps.to_product_card(d, "มีสต็อกไหม")
    v = card["variants"][0]
    for k in ("model_id", "stock", "model_status", "price"):
        assert k in v, f"variant missing {k}"
    by_name = {x["name"]: x for x in card["variants"]}
    assert by_name["EC4 เฉพาะกล้อง"]["stock"] == 0, by_name["EC4 เฉพาะกล้อง"]
    assert by_name["EC4 + Smart Hub"]["stock"] == 10, by_name["EC4 + Smart Hub"]
    print("PASS variants carry model_id/stock/model_status (EC4 mixed stock ถูก)")

    # ── add_product เก็บ model_id + dedupe ด้วย (item_id, model_id) ──
    saved, loaded = [], None
    cp.load_timeline = lambda cid: loaded
    cp.save_timeline = lambda *a, **k: saved.append(a)
    cp._coll = lambda: None  # กันเรียก DB จริง (ไม่ถึงเพราะ mock ข้างบน)

    r = cp.add_product("conv1", "shopee", "shop", "it1", "EC4", "user_order",
                       is_anchor=True, model_id="m1", model_name="EC4 เฉพาะกล้อง")
    assert r["products"][0]["model_id"] == "m1", r["products"]
    loaded = r
    # อีก model ของ item เดียวกัน → entry ใหม่ (ไม่ merge)
    r = cp.add_product("conv1", "shopee", "shop", "it1", "EC4", "user_order",
                       is_anchor=True, model_id="m2", model_name="EC4 + Smart Hub")
    loaded = r
    assert len(r["products"]) == 2, r["products"]
    # model เดิม → update entry เดิม ไม่เพิ่ม
    r = cp.add_product("conv1", "shopee", "shop", "it1", "EC4", "bot_suggestion",
                       model_id="m1")
    assert len(r["products"]) == 2 and r["products"][0]["source"] == "bot_suggestion"
    # ไม่ส่ง model_id → match entry แรกของ item เดิม (backward compat)
    r = cp.add_product("conv1", "shopee", "shop", "it1", "EC4", "user_order")
    assert len(r["products"]) == 2
    print("PASS add_product model_id dedupe/backfill/backward-compat")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
