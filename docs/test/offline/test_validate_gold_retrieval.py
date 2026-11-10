"""Tests for docs/test/validate_gold_retrieval.py."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from validate_gold_retrieval import validate_gaps, validate_rows


def _full_gold() -> list[dict]:
    rows = []
    base = {
        "shop": "S", "message": "m", "acceptable_item_ids": [],
        "must_not_item_ids": [], "must_not_phrases": ["x"],
        "expected_product_type": "", "expected_catalog_status": "",
        "requires_evidence": [],
    }
    for i in range(8):
        rows.append(dict(base, id=f"hist-{i}", intent="recommend",
                         expected_answer_mode="recommend",
                         history=[{"role": "user", "text": "ก่อนหน้า"}]))
    for i in range(3):
        rows.append(dict(base, id=f"oos-{i}", intent="exact_model",
                         expected_answer_mode="out_of_stock",
                         expected_catalog_status="active"))
    for i, st in enumerate(("unlisted", "unlisted", "discontinued")):
        rows.append(dict(base, id=f"unl-{i}", intent="exact_model",
                         expected_answer_mode="discontinued",
                         expected_catalog_status=st))
    for i in range(3):
        rows.append(dict(base, id=f"ref-{i}", intent="refund",
                         expected_answer_mode="policy"))
    for i in range(3):
        rows.append(dict(base, id=f"tax-{i}", intent="tax_invoice",
                         expected_answer_mode="handoff"))
    for i in range(3):
        rows.append(dict(base, id=f"ho-{i}", intent="claim",
                         expected_answer_mode="handoff"))
    rows.append(dict(base, id="old-1", intent="claim",
                     expected_answer_mode="handoff", tags=["old_order_item"]))
    rows.append(dict(base, id="mi17", intent="compatibility",
                     expected_answer_mode="products",
                     expected_target_device="mi 17 ultra",
                     history=[{"role": "user", "text": "มีสายชาร์จไหม"}]))
    return rows


def test_validate_gaps_passes_on_complete_gold():
    assert validate_gaps(_full_gold()) == []


def test_validate_gaps_reports_missing_quotas():
    errors = validate_gaps([{
        "id": "only", "shop": "S", "message": "m", "intent": "recommend",
        "expected_answer_mode": "recommend", "acceptable_item_ids": [],
        "must_not_item_ids": [], "expected_product_type": "",
        "expected_catalog_status": "", "requires_evidence": [],
    }])
    assert len(errors) >= 8
    assert any("history" in e for e in errors)
    assert any("out_of_stock" in e for e in errors)


def test_negative_case_requires_must_not_phrases():
    rows = _full_gold()
    rows[0]["expected_answer_mode"] = "handoff"
    rows[0]["must_not_phrases"] = []
    errors = validate_gaps(rows)
    assert any("must_not_phrases" in e for e in errors)


def test_valid_gold_row_passes():
    rows = [{
        "id": "compat-powerbank-macbook-001",
        "shop": "CukTech",
        "message": "พาวเวอร์แบงค์ใช้กับ macbook air ได้ไหม",
        "intent": "compatibility",
        "expected_answer_mode": "recommend",
        "acceptable_item_ids": [123],
        "must_not_item_ids": [456],
        "expected_product_type": "powerbank",
        "expected_catalog_status": "active",
        "requires_evidence": ["compatibility"],
    }]
    assert validate_rows(rows) == []


def test_no_info_cannot_require_min_power():
    rows = [{
        "id": "bad-001",
        "shop": "Any",
        "message": "มีสายรุ่นนี้ไหม",
        "intent": "compatibility",
        "expected_answer_mode": "no_info",
        "acceptable_item_ids": [],
        "must_not_item_ids": [],
        "expected_product_type": "cable",
        "expected_catalog_status": "",
        "requires_evidence": ["compatibility"],
        "min_output_power_w": 60,
    }]
    errors = validate_rows(rows)
    assert errors and "min_output_power_w" in errors[0]
