"""Test route_context — resolve_route + normalize_message (typo_dict).

รัน: .venv/bin/python docs/test/test_route_context.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import route_context as rc


def main() -> int:
    # ── resolve_route: subtype + codes + needs ──
    r = rc.resolve_route("HA835 พร้อมสาย ชาร์จกี่วัตต์")
    assert r.charger_subtype == "set", r.charger_subtype
    assert "HA835" in r.model_codes and "charger" in r.product_types
    assert r.needs_spec and not r.needs_warranty
    print("PASS HA835 พร้อมสาย → set + code + needs_spec")

    r = rc.resolve_route("สายชาร์จ AL870 ยาวเท่าไหร่")
    assert r.charger_subtype == "cable" and "AL870" in r.model_codes, r
    r = rc.resolve_route("ประกันกี่ปี")
    assert r.needs_warranty and not r.needs_spec
    print("PASS cable/warranty routing")

    # intent fallback — msg ไม่มี subtype แต่ intent บอก
    r = rc.resolve_route("มีแบบไหนบ้าง", {"product_type": "charger", "charger_subtype": "adapter"})
    assert r.charger_subtype == "adapter", r.charger_subtype
    print("PASS intent fallback subtype")

    # ── normalize_message: latin typo ──
    fixed, corr = rc.normalize_message("biokop ราคาเท่าไหร่")
    assert corr.get("biokop") == "biokoop", corr
    # คำถูกอยู่แล้ว → ไม่แก้
    fixed, corr = rc.normalize_message("cuktech ราคา")
    assert not corr, corr
    # คำสั้น/รหัสสั้น → ไม่แตะ
    fixed, corr = rc.normalize_message("ec4 มีไหม")
    assert not corr.get("ec4"), corr
    print("PASS latin typo: biokop→biokoop, คำถูกไม่แก้, คำสั้นไม่แตะ")

    # ── normalize_message: thai typo (threshold สูง) ──
    fixed, corr = rc.normalize_message("พาวเวอแบงค์ 20000")
    assert corr.get("พาวเวอแบงค์") == "พาวเวอร์แบงค์", corr
    print("PASS thai typo: พาวเวอแบงค์→พาวเวอร์แบงค์")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
