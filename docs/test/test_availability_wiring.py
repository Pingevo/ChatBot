"""Test availability wiring — Task 2: duplicated formulas route through resolve_availability.

รัน: .venv/bin/python -m pytest docs/test/test_availability_wiring.py -v

Pin เฉพาะ wiring ที่เปลี่ยน: _doc_sellable / to_product_card fields /
units._live_sellable / units.to_unit_card (model_doc + model_missing)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import product_store
from chatbot.shopeechat import units


def _model(stock_info: dict, model_id: int = 1, status: str = "MODEL_NORMAL") -> dict:
    return {"model_id": model_id, "model_status": status, "stock_info_v2": stock_info}


def _listing(status: str = "NORMAL", models: list | None = None) -> dict:
    return {"item_status": status, "model": models or [], "stock_info_v2": {}}


# ── _doc_sellable delegates to resolver ──
def test_doc_sellable_zero_summary_with_positive_fallback_is_not_sellable():
    # bug เดิม: summary=0 → if total_available falsy → fallback shopee_stock=99 → sellable
    doc = _listing(models=[_model({
        "summary_info": {"total_available_stock": 0},
        "shopee_stock": [{"stock": 99}],
    })])
    assert product_store._doc_sellable(doc) is False


def test_doc_sellable_positive_summary_is_sellable():
    doc = _listing(models=[_model({"summary_info": {"total_available_stock": 2}})])
    assert product_store._doc_sellable(doc) is True


def test_doc_sellable_unlist_is_not_sellable():
    doc = _listing(status="UNLIST",
                   models=[_model({"summary_info": {"total_available_stock": 2}})])
    assert product_store._doc_sellable(doc) is False


# ── to_product_card carries resolver fields ──
def test_product_card_availability_fields_from_full_model_list():
    doc = _listing(models=[_model({"summary_info": {"total_available_stock": 0}})])
    doc.update({"item_id": 1, "item_name": "X", "brand": {}, "price_info": []})
    card = product_store.to_product_card(doc)
    for key in ("catalog_status", "_available_for_sale", "sold_out", "total_stock"):
        assert key in card, key
    assert card["catalog_status"] == "out_of_stock"
    assert card["_available_for_sale"] is False
    assert card["sold_out"] is True
    assert card["total_stock"] == 0


def test_product_card_resolves_from_full_models_not_truncated_variants():
    # stock อยู่ที่ model ลำดับ 21 — variants ใน card ตัดที่ 20 แต่ resolver ต้องเห็นครบ
    doc = _listing(models=[_model({"summary_info": {"total_available_stock": 0}}, model_id=i)
                           for i in range(20)]
                   + [_model({"summary_info": {"total_available_stock": 7}}, model_id=99)])
    doc.update({"item_id": 2, "item_name": "Y", "brand": {}})
    card = product_store.to_product_card(doc)
    assert len(card["variants"]) == 20
    assert card["catalog_status"] == "active"
    assert card["_available_for_sale"] is True
    assert card["total_stock"] == 7


def test_product_card_unknown_stock_is_not_sold_out():
    doc = _listing(models=[_model({})])
    doc.update({"item_id": 3, "item_name": "Z", "brand": {}})
    card = product_store.to_product_card(doc)
    assert card["catalog_status"] == "active_unknown_stock"
    assert card["sold_out"] is False
    assert card["_available_for_sale"] is False
    assert card["total_stock"] is None


# ── units._live_sellable delegates to resolver ──
def test_live_sellable_uses_resolver_zero_summary_no_fallback():
    unit = {
        "model_id": 1, "item_status": "NORMAL", "stock": 5, "sellable": True,
        "_listing": _listing(models=[_model({
            "summary_info": {"total_available_stock": 0},
            "shopee_stock": [{"stock": 99}],
        }, model_id=1)]),
    }
    assert units._live_sellable(unit) is False


def test_live_sellable_snapshot_without_listing_uses_unit_fields():
    unit = {"model_id": 1, "item_status": "NORMAL", "stock": 5, "sellable": True,
            "model_status": "MODEL_NORMAL"}
    assert units._live_sellable(unit) is True


# ── units.to_unit_card passes exact model_doc + model_missing ──
def test_unit_card_uses_exact_model_doc_stock():
    unit = {
        "unit_id": "u1", "item_id": 10, "model_id": 2, "item_status": "NORMAL",
        "display_name": "X variant 2", "stock": 1, "sellable": True,
        "model_status": "MODEL_NORMAL",
        "_listing": _listing(models=[
            _model({"summary_info": {"total_available_stock": 50}}, model_id=1),
            _model({"summary_info": {"total_available_stock": 3}}, model_id=2),
        ]),
    }
    card = units.to_unit_card(unit)
    assert card["total_stock"] == 3
    assert card["catalog_status"] == "active"
    assert card["_available_for_sale"] is True


def test_unit_card_model_missing_in_listing_is_unavailable():
    unit = {
        "unit_id": "u2", "item_id": 11, "model_id": 99, "item_status": "NORMAL",
        "display_name": "gone variant", "stock": 5, "sellable": True,
        "model_status": "MODEL_NORMAL",
        "_listing": _listing(models=[_model({"summary_info": {"total_available_stock": 5}}, model_id=1)]),
    }
    card = units.to_unit_card(unit)
    assert card["_available_for_sale"] is False
    assert card["catalog_status"] == "unlisted"
    assert card.get("availability_reason") == "model_missing"


def test_unit_card_has_availability_fields():
    unit = {
        "unit_id": "u3", "item_id": 12, "model_id": 1, "item_status": "NORMAL",
        "display_name": "X", "stock": 2, "sellable": True,
        "model_status": "MODEL_NORMAL",
        "_listing": _listing(models=[_model({"summary_info": {"total_available_stock": 2}}, model_id=1)]),
    }
    card = units.to_unit_card(unit)
    for key in ("catalog_status", "_available_for_sale", "sold_out", "total_stock"):
        assert key in card, key
    assert card["_available_for_sale"] is True
