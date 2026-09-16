"""Test unit_classifier — classify_unit() เคสจริงจาก export.

รัน: .venv/bin/python docs/test/test_unit_classifier.py
     (หรือ PYTHONPATH=chatbot python docs/test/test_unit_classifier.py)

เคสทั้งหมดมาจาก model_name จริงที่ verify แล้วใน exports/ShpProducts.export.json
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from chatbot.shopeechat.scripts.unit_classifier import classify_unit  # noqa: E402


# (item_name, model_name, model_sku, expected components, kind, charger_subtype)
CASES = [
    # --- charger family: เฉพาะหัว/พร้อมสาย/เฉพาะสาย/multi-code ---
    ("ZMI HA835 หัวชาร์จ 65W GaN", "HA835 เฉพาะหัว", "ZMI-HA835-CN-BK",
     ["adapter"], "standalone", "adapter"),
    ("ZMI HA835 หัวชาร์จ 65W GaN", "HA835 พร้อมสาย", "ZMI-HA835-SET-BK",
     ["adapter", "cable"], "combo", "set"),
    ("ZMI HA716 หัวชาร์จ USB-C", "AL870 เฉพาะสาย", "ZMI-AL870-CN-WH",
     ["cable"], "standalone", "cable_only"),
    ("ZMI HA716 หัวชาร์จ USB-C", "716BK+AL870WH", "ZMI-HA716-AL870-BKWH",
     ["adapter", "cable"], "combo", "set"),
    # --- camera: เฉพาะกล้อง / +Hub / +SD ---
    ("IMILAB EC4 กล้องวงจรปิดไร้สาย", "EC4 เฉพาะกล้อง", "IMILAB-EC4-CN",
     ["camera"], "standalone", None),
    ("IMILAB EC4 กล้องวงจรปิดไร้สาย", "EC4 +Smart Hub+Solar", "IMILAB-EC4-HUB-SOLAR",
     ["camera", "hub", "solar_panel"], "combo", None),
    ("IMILAB EC5 กล้องวงจรปิด", "กล้อง + 64 GB", "IMILAB-EC5-SD64",
     ["camera", "sd_card"], "combo", None),
    # --- smartwatch: color variant / +strap ---
    ("IMILAB W01 สมาร์ทวอทช์", "สีชมพู", "IMILAB-W01-PK",
     ["watch"], "variant", None),
    ("IMILAB W01 สมาร์ทวอทช์", "สีชมพู + สายสีเทา", "IMILAB-W01-PK-STRAPGR",
     ["watch", "strap"], "combo", None),
    # --- powerbank: color+version only = variant ---
    ("CUKTECH PB100P แบตสำรอง 10000mAh", "PB100Pเทา CN.V(CCC)", "CUKT-PB100P-CNV-CNGR",
     ["powerbank"], "variant", None),
]


def main() -> int:
    fails = []
    for item_name, model_name, sku, exp_comps, exp_kind, exp_sub in CASES:
        r = classify_unit(item_name, model_name, sku)
        got_comps, got_kind, got_sub = r["components"], r["kind"], r["charger_subtype"]
        if got_comps != exp_comps or got_kind != exp_kind or got_sub != exp_sub:
            fails.append((item_name, model_name, exp_comps, got_comps,
                          exp_kind, got_kind, exp_sub, got_sub))
            print(f"FAIL {model_name!r}: comps={got_comps} (want {exp_comps}) "
                  f"kind={got_kind} (want {exp_kind}) sub={got_sub} (want {exp_sub})")
        else:
            print(f"PASS {model_name!r} → {got_comps} {got_kind} {got_sub}")

    # --- model_codes extraction ---
    r = classify_unit("ZMI HA716 หัวชาร์จ", "HA716 พร้อมสาย AL870", "ZMI-HA716-AL870-SET")
    codes = set(r["model_codes"])
    assert "HA716" in codes, f"model_codes missing HA716: {codes}"
    print(f"PASS model_codes: {sorted(codes)}")

    # --- oos_in_name ---
    r = classify_unit("IMILAB EC4 กล้อง", "EC4 เทา (สินค้าหมด)", "X")
    assert r["oos_in_name"] is True, "oos_in_name should be True"
    r = classify_unit("IMILAB EC4 กล้อง", "EC4 เทา", "X")
    assert r["oos_in_name"] is False, "oos_in_name should be False"
    print("PASS oos_in_name")

    # --- product_type unit-level ---
    r = classify_unit("ZMI HA716 หัวชาร์จ", "AL870 เฉพาะสาย", "X")
    assert r["product_type"] == "cable", f"เฉพาะสาย should be type cable, got {r['product_type']}"
    r = classify_unit("IMILAB W01 สมาร์ทวอทช์", "สีชมพู", "X")
    assert r["product_type"] == "smartwatch", f"variant watch type, got {r['product_type']}"
    r = classify_unit("CUKTECH PB100P แบตสำรอง", "PB100Pเทา CN.V(CCC)", "X")
    assert r["product_type"] == "powerbank", f"powerbank type, got {r['product_type']}"
    print("PASS product_type")

    print(f"\n{'='*40}\n{'FAIL' if fails else 'ALL PASS'} ({len(CASES)-len(fails)}/{len(CASES)} cases)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
