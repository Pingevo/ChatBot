"""Test units.py — unit-level fetch path (Task 8).

รัน: .venv/bin/python docs/test/test_units.py
ต้อง import units เข้า Mongo ก่อน: scripts/import_sellable_units.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import units


def main() -> int:
    # ── exact model_code ──
    us = units.fetch_units("HA835 พร้อมสาย มีไหม", shop="CukTechThailand")
    assert us and us[0]["_matched_by"] == "code", [(u.get("model_name"), u.get("_matched_by")) for u in us[:3]]
    ha835 = us[0]
    assert ha835["kind"] == "combo" and ha835["charger_subtype"] == "set", ha835
    print(f"PASS code match: {ha835['model_name']} kind={ha835['kind']} stock={ha835['stock']}")

    # ── cable unit ใน listing หัวชาร์จ ──
    us = units.fetch_units("สายชาร์จ AL870", shop="CukTechThailand")
    al = next((u for u in us if "AL870" in (u.get("model_name") or "")), None)
    assert al and al["product_type"] == "cable", [(u.get("model_name"), u.get("product_type")) for u in us[:5]]
    print(f"PASS AL870: product_type={al['product_type']} kind={al['kind']}")

    # ── per-unit stock (EC4 mixed) + sellable_only ──
    # sellable tier ดัน variant ที่มี stock ขึ้นก่อน → OOS variant อาจหลุด top-8
    # → ขยาย limit เพื่อยังเห็น (per-unit stock ยังแยกรุ่นถูกต้อง)
    us = units.fetch_units("IMILAB EC4 กล้อง", shop=None, limit=30)
    ec4 = [u for u in us if "เฉพาะกล้อง" in (u.get("model_name") or "")]
    assert ec4 and any(u["stock"] == 0 for u in ec4), [(u.get("model_name"), u.get("stock")) for u in us]
    us_s = units.fetch_units("IMILAB EC4 กล้อง", sellable_only=True)
    assert all(u["sellable"] for u in us_s), [(u.get("model_name"), u.get("sellable")) for u in us_s]
    assert not any("เฉพาะกล้อง" in (u.get("model_name") or "") for u in us_s), "OOS unit ไม่ควรอยู่ใน sellable_only"
    print("PASS per-unit stock + sellable_only filter")

    # ── vector search (ไม่มี code ใน msg) ──
    us = units.fetch_units("กล้องวงจรปิดแนะนำหน่อย", sellable_only=True)
    assert us, "vector search ควรเจอกล้อง"
    print(f"PASS vector: {[(u.get('model_name'), round(u['_score'],2)) for u in us[:3]]}")

    # ── to_unit_card shape ──
    card = units.to_unit_card(ha835)
    for k in ("item_id", "name", "price", "total_stock", "sold_out",
              "_available_for_sale", "variants", "description_excerpt",
              "unit_id", "model_id", "kind", "components"):
        assert k in card, f"card missing {k}"
    assert card["variants"][0]["stock"] == ha835["stock"]
    assert card["sold_out"] == (ha835["stock"] == 0)
    print(f"PASS to_unit_card shape (desc_excerpt={len(card['description_excerpt'])} chars)")

    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
