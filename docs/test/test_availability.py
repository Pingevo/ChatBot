"""Test availability resolver — Task 2 (single owner of stock semantics).

รัน: .venv/bin/python -m pytest docs/test/test_availability.py -v

Stock truth policy:
- stock_info_v2.summary_info.total_available_stock คือ stock truth ของ variant/model
- field มีและเป็นตัวเลข → ใช้ทันที (รวม 0) — 0 = out_of_stock ห้าม fallback
- fallback shopee_stock[] เฉพาะเมื่อ summary หาย/อ่านไม่ได้
- fallback saleable seller_stock[] เฉพาะเมื่อทั้งคู่หาย/อ่านไม่ได้
- ไม่มี source อ่านได้ → unknown stock ไม่ใช่ sold out
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import product_store


def _doc(status: str = "NORMAL") -> dict:
    return {"item_status": status}


def _model(stock_info: dict, status: str = "MODEL_NORMAL") -> dict:
    return {"model_status": status, "stock_info_v2": stock_info}


# ── 1. positive summary stock → active ──
def test_normal_positive_summary_stock_is_active():
    model = _model({"summary_info": {"total_available_stock": 3}})
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["answerable"] is True
    assert got["total_stock"] == 3


# ── 2. summary=0 → out_of_stock ──
def test_normal_zero_stock_is_out_of_stock_but_answerable():
    model = _model({"summary_info": {"total_available_stock": 0}})
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "out_of_stock"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True
    assert got["total_stock"] == 0


# ── 3. summary=0 ห้าม fallback ไป shopee/seller ──
def test_present_zero_summary_does_not_fallback_to_other_stock_fields():
    model = _model({
        "summary_info": {"total_available_stock": 0, "total_reserved_stock": 0},
        "shopee_stock": [{"location_id": "", "stock": 99}],
        "seller_stock": [{"location_id": "THZ", "stock": 99, "if_saleable": True}],
    })
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "out_of_stock"
    assert got["available_for_sale"] is False
    assert got["total_stock"] == 0


def test_shopee_stock_numeric_zero_is_not_fallback():
    # _shopee_stock โดยตรง: summary=0 ต้องคืน 0 ไม่ไหลไป shopee_stock=99
    model = _model({
        "summary_info": {"total_available_stock": 0},
        "shopee_stock": [{"stock": 99}],
        "seller_stock": [{"stock": 99, "if_saleable": True}],
    })
    assert product_store._shopee_stock(model) == 0


# ── 4. summary missing → fallback shopee_stock ──
def test_missing_summary_can_fallback_to_shopee_stock():
    model = _model({"shopee_stock": [{"location_id": "", "stock": 4}]})
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["total_stock"] == 4


# ── 5. summary+shopee missing → fallback saleable seller_stock ──
def test_missing_summary_and_shopee_stock_can_fallback_to_seller_stock():
    model = _model({"seller_stock": [{"location_id": "THZ", "stock": 2, "if_saleable": True}]})
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["total_stock"] == 2


def test_seller_stock_if_saleable_false_is_not_usable():
    # seller_stock ทั้งหมด if_saleable=False → ไม่ใช่ source ที่อ่านได้ → unknown
    model = _model({"seller_stock": [{"location_id": "THZ", "stock": 7, "if_saleable": False}]})
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "active_unknown_stock"
    assert got["available_for_sale"] is False
    assert got["total_stock"] is None


def test_unreadable_summary_falls_back_to_shopee_stock():
    # summary field มีแต่ไม่ใช่ตัวเลข → ถือว่าอ่านไม่ได้ → fallback
    model = _model({
        "summary_info": {"total_available_stock": "n/a"},
        "shopee_stock": [{"stock": 5}],
    })
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["total_stock"] == 5


def test_empty_shopee_stock_list_falls_back_to_seller_stock():
    model = _model({
        "shopee_stock": [],
        "seller_stock": [{"stock": 6, "if_saleable": True}],
    })
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "active"
    assert got["total_stock"] == 6


# ── 6. stock_info_v2 ว่าง → unknown stock ไม่ใช่ sold out ──
def test_normal_unknown_stock_is_answerable_but_not_sellable():
    model = _model({})
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "active_unknown_stock"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True
    assert got["total_stock"] is None


# ── 7. UNLIST → unlisted ──
def test_unlist_is_not_sellable_but_answerable_for_history():
    got = product_store.resolve_availability(_doc("UNLIST"), model_doc={})
    assert got["catalog_status"] == "unlisted"
    assert got["available_for_sale"] is False
    assert got["answerable"] is True


# ── 8. deleted/banned statuses → discontinued ──
def test_deleted_statuses_are_discontinued():
    for status in ("SELLER_DELETE", "DELETED", "SHOPEE_DELETE", "BANNED"):
        got = product_store.resolve_availability(_doc(status), model_doc={})
        assert got["catalog_status"] == "discontinued", status
        assert got["available_for_sale"] is False
        assert got["answerable"] is True


# ── 9. model_status ไม่ใช่ MODEL_NORMAL → unlisted/model_not_normal ──
def test_model_not_normal_is_unlisted():
    model = _model({"summary_info": {"total_available_stock": 5}}, status="MODEL_DELETE")
    got = product_store.resolve_availability(_doc(), model_doc=model)
    assert got["catalog_status"] == "unlisted"
    assert got["available_for_sale"] is False
    assert got["reason"] == "model_not_normal"


# ── listing-level: doc มี model[] รวมเฉพาะ MODEL_NORMAL ──
def test_listing_sums_only_normal_models():
    doc = _doc()
    doc["model"] = [
        _model({"summary_info": {"total_available_stock": 0}}),
        _model({"summary_info": {"total_available_stock": 4}}),
        _model({"summary_info": {"total_available_stock": 99}}, status="MODEL_DELETE"),
    ]
    got = product_store.resolve_availability(doc)
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["total_stock"] == 4


def test_listing_all_models_non_normal_is_out_of_stock():
    doc = _doc()
    doc["model"] = [_model({"summary_info": {"total_available_stock": 9}}, status="MODEL_DELETE")]
    got = product_store.resolve_availability(doc)
    assert got["catalog_status"] == "out_of_stock"
    assert got["available_for_sale"] is False
    assert got["total_stock"] == 0


def test_listing_models_without_any_stock_source_is_unknown():
    doc = _doc()
    doc["model"] = [_model({}), _model({})]
    got = product_store.resolve_availability(doc)
    assert got["catalog_status"] == "active_unknown_stock"
    assert got["available_for_sale"] is False
    assert got["total_stock"] is None


def test_doc_level_stock_info_without_models():
    doc = _doc()
    doc["stock_info_v2"] = {"summary_info": {"total_available_stock": 8}}
    got = product_store.resolve_availability(doc)
    assert got["catalog_status"] == "active"
    assert got["total_stock"] == 8


# ── card input: fallback ไป total_stock/stock ของ card ──
def test_card_with_positive_total_stock_is_active():
    got = product_store.resolve_availability({"status": "NORMAL", "total_stock": 5})
    assert got["catalog_status"] == "active"
    assert got["available_for_sale"] is True
    assert got["total_stock"] == 5


def test_card_with_zero_total_stock_is_out_of_stock():
    got = product_store.resolve_availability({"status": "NORMAL", "total_stock": 0})
    assert got["catalog_status"] == "out_of_stock"
    assert got["available_for_sale"] is False


def test_card_with_unknown_total_stock_is_unknown():
    got = product_store.resolve_availability({"status": "NORMAL", "total_stock": None})
    assert got["catalog_status"] == "active_unknown_stock"
    assert got["available_for_sale"] is False


# ── status อื่นที่ไม่รู้จัก → unknown ไม่ answerable ──
def test_unknown_status_is_not_answerable():
    got = product_store.resolve_availability({"status": "REVIEWING"}, model_doc={})
    assert got["catalog_status"] == "unknown"
    assert got["available_for_sale"] is False
    assert got["answerable"] is False
