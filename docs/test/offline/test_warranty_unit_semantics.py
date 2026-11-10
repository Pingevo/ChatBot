"""Warranty units in product names must not confuse cable length with months."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "chatbot"))

from shopeechat import policy_resolver, product_store, warranty  # noqa: E402


@pytest.mark.parametrize(
    ("name", "months", "text", "source"),
    [
        ("CTC620P สายชาร์จ USB-C to USB-C 2m", None, None, None),
        ("สายชาร์จยาว 1m", None, None, None),
        ("สินค้า -24m", None, None, None),
        ("สายชาร์จ 240W -24M", 24, "2 ปี", "tail"),
        ("สินค้า -2Y", 24, "2 ปี", "tail"),
        ("สินค้า 1y", 12, "1 ปี", "tail"),
        ("ประกัน 24m", 24, "2 ปี", "near_warranty"),
        ("warranty 6m", 6, "6 เดือน", "near_warranty"),
        ("สายชาร์จ ประกัน 24m ยาว 2m", 24, "2 ปี", "near_warranty"),
    ],
)
def test_warranty_units_require_unambiguous_source(name, months, text, source):
    result = warranty.extract_warranty_from_name(name)
    if months is None:
        assert result is None
    else:
        assert result is not None
        assert (result["months"], result["text"], result["source"]) == (
            months, text, source
        )


def test_cable_length_does_not_become_warranty_in_product_and_policy_facts():
    name = "CTC620P สายชาร์จ USB-C to USB-C 2m"
    raw = {"item_name": name}
    assert "duration" not in product_store._warranty_info(raw)

    card = {"name": name, "item_id": "1", "product_type": "cable"}
    facts = policy_resolver.extract_field_facts(card, subject_id="i:1")
    assert not [fact for fact in facts if fact.fact_key == "warranty"]


def test_uppercase_months_survive_product_and_policy_facts():
    name = "สายชาร์จ 240W -24M"
    product_warranty = product_store._warranty_info({"item_name": name})
    assert product_warranty["duration"] == "2 ปี"
    assert product_warranty["duration_months"] == "24"

    card = {"name": name, "item_id": "1", "product_type": "cable"}
    facts = policy_resolver.extract_field_facts(card, subject_id="i:1")
    assert [fact.value for fact in facts if fact.fact_key == "warranty"] == [24]
