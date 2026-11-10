"""Test route_context — resolve_route + normalize_message (typo_dict).

รัน: .venv/bin/python docs/test/test_route_context.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
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

    # ── intent_product_scope: pseudo/non-canonical type → no scope ──
    # "other" คือ catch-all label ของ classifier (declared domain —
    #   ไม่ใช่ canonical sellable type) — ห้ามกลายเป็น product scope
    assert rc.intent_product_scope({"product_type": "other"}) == (None, None)
    assert rc.intent_product_scope({"product_type": "bogus_type"}) == (None, None)
    assert rc.intent_product_scope({"product_type": "gadget"}) == (None, None)
    # canonical top-level type ผ่านเหมือนเดิม (รวมชื่อนอก declared prompt
    #   domain แต่อยู่ใน PRODUCT_TYPES registry — เช่น dashcam)
    assert rc.intent_product_scope({"product_type": "charger"}) == ("charger", None)
    assert rc.intent_product_scope({"product_type": "earphone"}) == ("earphone", None)
    assert rc.intent_product_scope({"product_type": "dashcam"}) == ("dashcam", None)
    # subtype-domain precedence เดิม (car_charger เป็นทั้ง subtype key และ
    #   canonical name — subtype domain ต้องชนะเหมือนเดิม)
    assert rc.intent_product_scope({"product_type": "cable"}) == (None, "cable")
    assert rc.intent_product_scope({"product_type": "car_charger"}) == (None, "car_charger")
    assert rc.intent_product_scope(
        {"product_type": "charger", "charger_subtype": "adapter"}
    ) == ("charger", "adapter")
    # malformed/missing/non-str → fail closed
    for bad in (None, {}, {"product_type": None}, {"product_type": 7},
                {"product_type": ["charger"]}, {"product_type": ""}):
        assert rc.intent_product_scope(bad) == (None, None), bad
    print("PASS intent_product_scope canonical gate")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
