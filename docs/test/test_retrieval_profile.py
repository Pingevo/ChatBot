"""Test RetrievalProfile contract — Task 4A (owner กลางของ request facts, observe-only).

รัน: .venv/bin/python -m pytest docs/test/test_retrieval_profile.py -v

Contract:
- RetrievalProfile frozen dataclass — โจทย์กลางก่อนดึงสินค้า
- shop/platform มาจาก function arg เท่านั้น
- current message ชนะ intent/history; intent = proposal เท่านั้น
- history bounded (user ≤4 ใหม่สุด) และ carry เฉพาะกรณี follow-up/elliptical
- target_device แยกจาก product_types เสมอ (iphone 13 ไม่ใช่ product_type=phone)
"""
from __future__ import annotations

import dataclasses
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import route_context

build_retrieval_profile = route_context.build_retrieval_profile


# ── required cases (plan Task 4A) ──

def test_iphone_cable_current_message():
    got = build_retrieval_profile(
        "สายชาร์จใช้กับ iPhone 13 ได้ไหม",
        history=[],
        intent_result={"intent": "compatibility_check", "confidence": 0.95},
        shop="ZMIThailand",
    )
    assert got.platform == "shopee"
    assert got.shop == "ZMIThailand"
    assert got.product_types == frozenset({"charger"})
    assert got.subtype == "cable"
    assert got.target_device.lower() == "iphone 13"
    assert got.compat_mode == "connector_required"
    assert got.availability_mode == "sellable_first"
    assert "phone" not in got.product_types


def test_mi17_carry_cable_from_history():
    got = build_retrieval_profile(
        "อยากได้ที่ใช้กับ mi 17 ultra",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets",
    )
    assert got.product_types == frozenset({"charger"})
    assert got.subtype == "cable"
    assert got.target_device.lower() == "xiaomi 17 ultra"  # canonical (4F)
    assert got.compat_mode == "connector_required"
    assert ("subtype", "history") in got.fact_sources


def test_current_message_beats_wrong_intent_and_old_history():
    got = build_retrieval_profile(
        "หัวชาร์จใช้กับ mi 17 ultra",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={
            "intent": "product_recommend",
            "product_type": "phone",
            "charger_subtype": "cable",
            "target_device": "mi 17 ultra",
            "confidence": 0.99,
        },
        shop="KingGadgets",
    )
    assert got.product_types == frozenset({"charger"})
    assert got.subtype == "adapter"
    assert "phone" not in got.product_types


def test_explicit_new_topic_does_not_carry_charger_history():
    got = build_retrieval_profile(
        "หูฟังใช้กับ mi 17 ultra ได้ไหม",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "compatibility_check", "confidence": 0.9},
        shop="KingGadgets",
    )
    assert got.product_types == frozenset({"earphone"})
    assert got.subtype is None
    assert got.compat_mode == "bluetooth_general"


def test_shop_never_comes_from_history_or_intent():
    got = build_retrieval_profile(
        "มีสายชาร์จไหม",
        history=[{"role": "user", "text": "ร้าน OtherShop มีอะไร"}],
        intent_result={"shop": "WrongShop", "intent": "product_recommend"},
        shop="KingGadgets",
    )
    assert got.shop == "KingGadgets"


def test_exact_old_model_profile_is_answerable_even_when_unavailable():
    got = build_retrieval_profile(
        "HA835 ยังมีประกันไหม",
        history=[],
        intent_result={"intent": "warranty_duration", "confidence": 0.9},
        shop="AnyShop",
    )
    assert "HA835" in got.model_codes
    assert got.availability_mode == "answerable_all"


def test_compare_profile_is_resolved_deterministically_not_by_classifier_label():
    anchors = [{"item_id": 1, "name": "Run"}, {"item_id": 2, "name": "Swim"}]
    got = build_retrieval_profile(
        "อันไหนดีกว่า",
        history=[],
        intent_result={"intent": "other", "confidence": 0.4},
        shop="AnyShop",
        anchor_cards=anchors,
    )
    assert got.intent == "compare"
    assert got.availability_mode == "answerable_all"
    assert got.anchor_item_ids == ("1", "2")


# ── pins ──

def test_profile_is_frozen_and_message_preserved():
    got = build_retrieval_profile(
        "มีสายชาร์จไหม",
        history=[],
        intent_result=None,
        shop="KingGadgets",
    )
    assert got.message == "มีสายชาร์จไหม"
    with pytest.raises(dataclasses.FrozenInstanceError):
        got.shop = "Other"  # type: ignore[misc]


def test_product_code_is_not_a_target_device():
    # HA835 = model code ของสินค้า ไม่ใช่ device → target_device=None → compat none
    got = build_retrieval_profile(
        "HA835 ยังมีประกันไหม",
        history=[],
        intent_result={"intent": "warranty_duration", "confidence": 0.9},
        shop="AnyShop",
    )
    assert got.target_device is None
    assert got.compat_mode == "none"


def test_stock_only_words_give_sellable_only():
    got = build_retrieval_profile(
        "สายชาร์จพร้อมส่งไหม",
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="AnyShop",
    )
    assert got.availability_mode == "sellable_only"


def test_superlative_intent_still_sellable_first():
    got = build_retrieval_profile(
        "สายชาร์จตัวไหนเร็วสุด",
        history=[],
        intent_result={"intent": "other", "confidence": 0.3},
        shop="AnyShop",
    )
    assert got.intent == "superlative"
    assert got.availability_mode == "sellable_first"


def test_bare_model_code_query_is_exact_model():
    got = build_retrieval_profile(
        "HA835",
        history=[],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="AnyShop",
    )
    assert got.intent == "exact_model"
    assert got.model_codes == ("HA835",)
    assert got.availability_mode == "answerable_all"


def test_history_bounded_to_four_newest_and_user_only():
    # entry เก่าสุด (powerbank) อยู่นอก window 4 — ต้องไม่ carry
    history = [
        {"role": "user", "text": "มีพาวเวอร์แบงค์ไหม"},
        {"role": "bot", "text": "มีหูฟังครับ"},          # bot ไม่ใช่ source
        {"role": "user", "text": "ราคาเท่าไหร่"},
        {"role": "user", "text": "ส่งกี่วัน"},
        {"role": "user", "text": "มีสายชาร์จไหม"},
    ]
    got = build_retrieval_profile(
        "อยากได้ที่ใช้กับ mi 17 ultra",
        history=history,
        intent_result={"intent": "other", "confidence": 0.0},
        shop="AnyShop",
    )
    assert got.product_types == frozenset({"charger"})
    assert "powerbank" not in got.product_types


def test_no_target_device_gives_compat_none():
    got = build_retrieval_profile(
        "มีสายชาร์จไหม",
        history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="AnyShop",
    )
    assert got.target_device is None
    assert got.compat_mode == "none"


def test_history_not_carried_when_current_names_other_family():
    # กรณี follow-up ที่เปลี่ยน family — subtype ของ charger ห้ามตามมา
    got = build_retrieval_profile(
        "หูฟังตัวไหนดี",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="AnyShop",
    )
    assert got.product_types == frozenset({"earphone"})
    assert got.subtype is None
    assert ("subtype", "history") not in got.fact_sources


# ── Task 4B: profile_debug + app.py wiring structural pins ──

def test_profile_debug_shape():
    got = build_retrieval_profile(
        "สายชาร์จใช้กับ iPhone 13 ได้ไหม",
        history=[],
        intent_result={"intent": "compatibility_check", "confidence": 0.95},
        shop="ZMIThailand",
    )
    dbg = route_context.profile_debug(got, source="app_chat",
                                      used_fields=("shop", "product_types"))
    assert dbg["source"] == "app_chat"
    assert dbg["shop"] == "ZMIThailand"
    assert dbg["product_types"] == ["charger"]
    assert dbg["subtype"] == "cable"
    assert dbg["target_device"] == "iphone 13"
    assert dbg["compat_mode"] == "connector_required"
    assert dbg["availability_mode"] == "sellable_first"
    assert dbg["used_fields"] == ["shop", "product_types"]
    assert isinstance(dbg["fact_sources"], dict)
    # debug เป็น facts เท่านั้น — ไม่มี history/message dump
    assert "history" not in dbg


def test_app_builds_profile_once_before_kb_lookup():
    # structural pin: profile build ต้องอยู่ก่อน lookup_kb และก่อน fetch_products แรก
    src = (ROOT / "chatbot" / "shopeechat" / "app.py").read_text(encoding="utf-8")
    build_at = src.index("build_retrieval_profile(")
    assert 0 < build_at < src.index("lookup_kb(kb_query")


def test_resolve_active_by_message_called_exactly_once():
    # timeline resolver ต้องถูกเรียกจุดเดียว (hoisted ก่อน KB) — CONV-ACTIVE reuse ผล
    src = (ROOT / "chatbot" / "shopeechat" / "app.py").read_text(encoding="utf-8")
    assert src.count("resolve_active_by_message(") == 1
