"""Test guards.py + spec inheritance + context flags (Task 9).

รัน: PYTHONPATH=chatbot .venv/bin/python docs/test/test_guards.py
ต้องมี Mongo (kb_products + sellable_units import แล้ว)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import guards, units, knowledge_base  # noqa: E402
knowledge_base._load_env()  # noqa: E402
from chatbot.shopeechat import llm  # noqa: E402


def main() -> int:
    # ── build_flags: รวม flags เป็น dict เดียว ──
    card = {
        "sellable": True, "has_warranty_info": True, "has_description": False,
        "oos_in_name": False, "item_status": "NORMAL", "total_stock": 5,
    }
    f = guards.build_flags(card)
    for k in ("sellable", "has_warranty_info", "has_description", "oos_in_name"):
        assert k in f, f"flag missing {k}"
    assert f["sellable"] is True and f["has_description"] is False
    print("PASS build_flags")

    # ── check_output: ยืนยันเคลม/คืนเงิน/จัดส่งโดยไม่ handoff → flag ──
    bad = guards.check_output(
        "ได้เลยค่ะ ทางร้านยืนยันการเคลมให้แล้วนะคะ รอรับเงินคืนภายใน 3 วันค่ะ",
        handoff_sent=False)
    assert bad, "ควร flag คำยืนยันเคลมที่ไม่มี handoff"
    ok1 = guards.check_output(
        "ได้เลยค่ะ ทางร้านยืนยันการเคลมให้แล้วนะคะ", handoff_sent=True)
    assert not ok1, "มี handoff แล้วไม่ควร flag"
    ok2 = guards.check_output(
        "สินค้ารุ่นนี้รับประกัน 2 ปีค่ะ", handoff_sent=False)
    assert not ok2, "ตอบข้อมูลรับประกันปกติไม่ควร flag"
    print("PASS check_output")

    # ── spec inheritance: unit ไม่มี desc → ยืม canonical_specs จาก kb ──
    coll = units._units_coll()
    no_desc = list(coll.find(
        {"has_description": {"$ne": True}, "model_codes": {"$exists": True, "$ne": []},
         "sellable": True}).limit(3))
    if no_desc:
        cards = units.attach_kb_specs(no_desc)
        inherited = [c for c in cards if c.get("canonical_specs")]
        print(f"PASS attach_kb_specs ran ({len(inherited)}/{len(cards)} units ได้ specs จาก kb)")
    else:
        print("SKIP attach_kb_specs (ไม่มี sellable unit ที่ desc ว่าง)")

    # ── _build_context: unit card flags + canonical_specs ต้องอยู่ใน context ──
    ucard = units.to_unit_card({"item_id": 1, "display_name": "X", "stock": 3,
                                "item_status": "NORMAL", "sellable": True,
                                "oos_in_name": False, "has_warranty_info": True,
                                "has_description": False,
                                "desc_sections": {}})
    ucard["canonical_specs"] = {"วัตต์": "65W", "พอร์ต": "1C/2A"}
    ctx = llm._build_context([ucard], include_description=True)
    assert "canonical_specs" in ctx, "canonical_specs ต้องเข้า context"
    assert "sellable" in ctx and "oos_in_name" in ctx, "unit flags ต้องเข้า context"
    print("PASS _build_context flags + canonical_specs")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
