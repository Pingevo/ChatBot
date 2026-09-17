"""Test sellable_units.jsonl — assert โครงสร้าง/คุณภาพของ unit index ที่ build แล้ว.

รัน: .venv/bin/python docs/test/test_sellable_units.py
     (ต้องรัน build_sellable_units.py ก่อน — สร้าง exports/sellable_units.jsonl)

assert ตามแผน Task 2 Step 1:
- total units ≈26,970, unit_id ไม่ซ้ำ
- sellable = item_status NORMAL && stock>0 เท่านั้น
- เคสจริง HA835/EC4/AL870 classify ถูก
- ทุก unit มี field ครบตาม schema
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
JSONL = ROOT / "exports" / "sellable_units.jsonl"

REQUIRED = {"unit_id", "item_id", "model_id", "display_name", "kind", "components",
            "product_type", "model_codes", "price", "stock", "item_status",
            "shop", "sellable", "answerable", "oos_in_name", "desc_sections",
            "image_ids", "search_text"}


def main() -> int:
    units = [json.loads(l) for l in open(JSONL, encoding="utf-8")]
    n = len(units)
    assert n == 26970, f"units {n} != 26970"

    ids = {u["unit_id"] for u in units}
    assert len(ids) == n, "unit_id ซ้ำ"

    missing = [(i, REQUIRED - set(u)) for i, u in enumerate(units) if REQUIRED - set(u)]
    assert not missing, f"units missing fields: {missing[:3]}"

    bad_sellable = [u for u in units if u["sellable"] != (u["item_status"] == "NORMAL" and u["stock"] > 0)]
    assert not bad_sellable, f"sellable flag ผิด {len(bad_sellable)} units"
    n_sell = sum(1 for u in units if u["sellable"])
    assert n_sell == 4969, f"sellable {n_sell} != 4969"
    print(f"PASS units={n} unique_ids, sellable={n_sell}, schema ครบ")

    # เคสจริงจาก export — HA835 combo, EC4 mixed stock, AL870 cable-in-charger-listing
    ha835 = [u for u in units if u["model_name"] == "HA835 พร้อมสาย"]
    assert ha835 and ha835[0]["kind"] == "combo" and ha835[0]["charger_subtype"] == "set", ha835[:1]
    al870 = [u for u in units if u["model_name"] == "AL870 เฉพาะสาย"]
    assert al870 and al870[0]["product_type"] == "cable" and al870[0]["kind"] == "standalone", al870[:1]
    ec4 = [u for u in units if u["model_name"].startswith("EC4")]
    assert ec4, "ไม่เจอ EC4 units"
    mixed = [u for u in ec4 if "เฉพาะกล้อง" in u["model_name"]]
    assert mixed and mixed[0]["kind"] == "standalone" and mixed[0]["stock"] == 0, mixed[:1]
    print("PASS HA835/AL870/EC4 classify + per-unit stock")

    # desc_sections มี warranty/highlights/specs ใน doc ที่รู้จัก
    sec_units = [u for u in units if u.get("has_warranty_info")]
    assert len(sec_units) > 500, f"warranty section เจอแค่ {len(sec_units)}"
    print(f"PASS desc_sections: warranty units={len(sec_units)}")

    # image_ids link ไป image_texts
    img_units = sum(1 for u in units if u["image_ids"])
    assert img_units > 4000, f"units with images {img_units} < 4000"
    print(f"PASS image_ids: {img_units} units have desc images")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
