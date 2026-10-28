"""Phase 11 FIX-2 — kill keyword description gate.

Owner-mandated RED spec: product turn ที่ message ไม่มี spec_kw เลย
แต่ description ของ card มี fact ที่ต้องตอบ → compiled context
ต้องมี evidence นั้นเสมอ ไม่ขึ้นกับ vocabulary ของลูกค้า — offline:
to_product_card/to_unit_card/_scope_card = pure functions, ไม่มี DB.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "chatbot"))

from shopeechat import answer_context, product_store, units  # noqa: E402

# message ไม่มี keyword ของ gate เก่าเลย (ไม่ใช่ warranty/spec/shipping/
# product/model-code) — คำถามอายุแบตที่ถามด้วยศัพท์อิสระ
_BATTERY_ASK = "ใช้ได้กี่วันคะ"
_DESC = "แบตเตอรี่อยู่ได้นานถึง 7 วัน ต่อการชาร์จหนึ่งครั้ง\nรองรับการวัดออกซิเจนในเลือด"


def _doc(desc: str = _DESC) -> dict:
    return {
        "item_id": 12345,
        "item_name": "Smart Watch X1",
        "brand": {"original_brand_name": "Acme"},
        "cat_name": "นาฬิกา",
        "shopname": "AcmeShop",
        "item_status": "NORMAL",
        "description": desc,
        "short_link": "https://shopee.co.th/x1",
        "model": [],
        "tier_variation": [],
    }


def _describe_need():
    return types.SimpleNamespace(operation="describe", requested_facts=())


def test_keyword_free_message_still_gets_desc_evidence():
    """message ไร้ keyword → card ต้องมี normalized desc ครบ (ไม่ใช่ "")."""
    card = product_store.to_product_card(_doc(), _BATTERY_ASK)
    assert "7 วัน" in card["description_excerpt"]


def test_card_emits_single_description_field():
    """D4 — card ออก field เดียว: ไม่มี raw_description channel อีก."""
    card = product_store.to_product_card(_doc(), _BATTERY_ASK)
    assert "raw_description" not in card
    assert card["description_excerpt"].strip()


def test_evidence_survives_typed_admission():
    """evidence ต้องรอด typed admission (`_scope_card` owner เดิม)."""
    card = product_store.to_product_card(_doc(), _BATTERY_ASK)
    scoped = answer_context._scope_card(card, _describe_need(), "subject")
    assert "7 วัน" in scoped.get("description_excerpt", "")


def test_promo_lines_stripped_question_independently():
    """promo/boilerplate strip + cap ยังทำงาน — ไม่ขึ้นกับ vocabulary."""
    desc = "ใช้โค้ด NEWTHAI ลดเพิ่ม 100 บาท\n" + _DESC
    card = product_store.to_product_card(_doc(desc), _BATTERY_ASK)
    excerpt = card["description_excerpt"]
    assert "7 วัน" in excerpt
    assert "NEWTHAI" not in excerpt


def test_description_length_cap_kept():
    """cap 3000 คงเดิม และต้องไม่ว่างเมื่อ desc มีเนื้อหา."""
    card = product_store.to_product_card(_doc("ข้อมูล " + "x" * 5000), _BATTERY_ASK)
    assert 0 < len(card["description_excerpt"]) <= 3000


def _unit(desc_sections: dict) -> dict:
    return {
        "item_id": 777,
        "display_name": "Cable C2C 240W",
        "brand": {"original_brand_name": "Acme"},
        "cat_name": "สายชาร์จ",
        "shop": "AcmeShop",
        "item_status": "NORMAL",
        "desc_sections": desc_sections,
    }


def test_unit_card_single_normalized_desc():
    """unit card ออก field เดียว — join desc_sections เต็ม ไม่เลือกตามคำถาม."""
    unit = _unit({"specs": "สายชาร์จเร็ว 240W", "notes": "สีดำ"})
    card = units.to_unit_card(unit)
    assert "raw_description" not in card
    assert "240W" in card["description_excerpt"]
    assert "สีดำ" in card["description_excerpt"]
