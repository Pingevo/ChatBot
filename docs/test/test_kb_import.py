"""Test KB re-import (Task 4) — dup columns, canonical specs, Q&A split, raw pairs.

รัน: .venv/bin/python docs/test/test_kb_import.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "docs" / "adminbase" / "script"))
sys.path.insert(0, str(ROOT))

import import_adminbase as imp


def main() -> int:
    # ── เคส 1: duplicate Q&A columns (Cuktech ZTEC ZMI.xlsx จริง) ──
    header = ["ชื่อแบรนด์", "ประเภท", "รุ่นสินค้า",
              "คำถามเกี่ยวสินค้า", "คำตอบ", "คำถามเกี่ยวสินค้า", "คำตอบ"]
    row = ("CUKTECH", "Powerbank", "LPB200NL",
           "ใช้กับ S26 ได้ไหม", "ใช้ได้", "กลับหน้าจอยังไง", "ทำไม่ได้")
    product, qas, raw = imp.parse_row(header, row, "Cuktech ZTEC ZMI.xlsx", 2, "ชีต1")
    assert len(qas) == 2, f"expected 2 qa docs, got {len(qas)}"
    assert qas[0]["q"].startswith("ใช้กับ") and qas[1]["q"].startswith("กลับหน้าจอ")
    # raw ต้องเก็บครบ 7 คอลัมน์ไม่หาย (list-of-pairs)
    vals = [p["val"] for p in raw["pairs"]]
    assert "กลับหน้าจอยังไง" in vals and "ทำไม่ได้" in vals, vals
    print("PASS dup Q&A columns → 2 kb_qa + raw ครบ")

    # ── เคส 2: canonical specs (CUKTECH Spec.xlsx จริง) ──
    header = ["ชื่อแบรนด์", "ประเภท", "รุ่นสินค้า",
              "ขนาดของแบตเตอรี่/ มิลลิแอมป์ (mAh)", "ปริมาณแบตเตอรี่/ มิลลิแอมป์ (mAh)",
              "ค่า Wh", "กำลังไฟสูงสุด", "สเปคกำลังไฟ Input", "สเปคกำลังไฟ Output",
              "ระบบชาร์จไรสาย", "น้ำหนักสินค้า", "อุปกรณ์ที่ได้รับในแพ็กเกจ"]
    row = ("CUKTECH", "Powerbank", "PB150S", "15000 mAh", "8800mAh (5V/3A)",
           "57.75Wh", "150W", "USB-C 5V/3A", "USB-C1 5V/3A", "ไม่รองรับ", "305 กรัม", "ตัวเครื่อง+สาย")
    product, qas, raw = imp.parse_row(header, row, "CUKTECH Spec.xlsx", 2, "spec")
    cs = product["canonical_specs"]
    assert cs.get("capacity_mah") == "15000 mAh", cs
    assert cs.get("rated_capacity") == "8800mAh (5V/3A)", cs
    assert cs.get("capacity_wh") == "57.75Wh", cs
    assert cs.get("max_power") == "150W", cs
    assert cs.get("input_spec", "").startswith("USB-C"), cs
    assert product["weight"] == "305 กรัม", product
    assert product["box_contents"].startswith("ตัวเครื่อง"), product
    assert "PB150S" in product["model_codes"], product["model_codes"]
    print("PASS canonical_specs + common fields + model_codes")

    # ── เคส 3: duplicate spec columns (Xiaomi ชีต2 จริง) ──
    header = ["รุ่น", "ความละเอียด", "ฟีเจอร์เด่น", "อุปกรณ์ในกล่อง", "ฟีเจอร์เด่น", "อุปกรณ์ในกล่อง"]
    row = ("C200", "1080P", "feat-A", "box-A", "feat-B", "box-B")
    product, qas, raw = imp.parse_row(header, row, "Xiaomi กล้องวงจรปิด.xlsx", 2, "ชีต2")
    vals = [p["val"] for p in raw["pairs"]]
    assert "feat-A" in vals and "feat-B" in vals and "box-A" in vals and "box-B" in vals, vals
    # specs_raw ก็ต้องไม่หาย — dup ต้องถูก disambiguate
    sr = product["specs_raw"]
    joined = " ".join(sr.values())
    assert "feat-A" in joined and "feat-B" in joined, sr
    print("PASS dup spec columns → raw pairs + specs_raw ครบ")

    # ── เคส 4: item_ids link ผ่าน model_codes ──
    code_map = imp.build_code_item_map()
    assert code_map.get("pb150s"), "pb150s ควร link ได้จาก units จริง"
    assert code_map.get("ha835"), "ha835 ควร link ได้"
    print(f"PASS code→item map ({len(code_map)} codes)")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
