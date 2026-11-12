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

ROOT = Path(__file__).resolve().parent.parent.parent.parent
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
    assert got.product_types == frozenset({"charger", "cable"})
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
    assert got.product_types == frozenset({"charger", "cable"})
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
    assert got.product_types == frozenset({"charger", "cable"})
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
    assert dbg["product_types"] == ["cable", "charger"]
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


def test_resolve_subjects_called_exactly_once():
    # subject resolver ต้องถูกเรียกจุดเดียวต่อ turn (hoisted ก่อน KB) —
    # Phase 2C.2: persisted/derived subject set แทน timeline resolver เดิม
    src = (ROOT / "chatbot" / "shopeechat" / "app.py").read_text(encoding="utf-8")
    assert src.count("resolve_subjects(") == 1


# ── Phase 10B r2: pseudo-type intent scope — accessor เดียว ──

def test_pseudo_other_intent_type_not_in_profile():
    # reviewer finding: intent product_type="other" (classifier catch-all —
    #   ไม่ใช่ canonical sellable type) ต้องไม่เข้า profile.product_types;
    #   typed accessor เดียว `intent_product_scope` fail closed → unscoped
    got = build_retrieval_profile(
        "รุ่นนี้ต่างกันยังไง",
        history=[],
        intent_result={"intent": "product_spec", "product_type": "other",
                       "confidence": 0.95},
        shop="x",
    )
    assert got.product_types == frozenset()
    assert ("product_types", "intent") not in got.fact_sources


def test_unknown_intent_type_not_in_profile():
    got = build_retrieval_profile(
        "รุ่นนี้ต่างกันยังไง",
        history=[],
        intent_result={"intent": "product_spec", "product_type": "bogus_gadget",
                       "confidence": 0.95},
        shop="x",
    )
    assert got.product_types == frozenset()
    assert ("product_types", "intent") not in got.fact_sources


def test_canonical_intent_type_via_accessor_unchanged():
    # canonical ที่ accessor validate ผ่าน (dashcam อยู่ใน PRODUCT_TYPES)
    #   → intent proposal เดิมทำงานเหมือนเดิมเมื่อไม่มี current/anchor type
    got = build_retrieval_profile(
        "รุ่นนี้ต่างกันยังไง",
        history=[],
        intent_result={"intent": "product_recommend", "product_type": "dashcam",
                       "confidence": 0.95},
        shop="x",
    )
    assert got.product_types == frozenset({"dashcam"})
    assert ("product_types", "intent") in got.fact_sources


def test_subtype_domain_intent_maps_to_subtype_unchanged():
    # "cable" = subtype domain — accessor → (None, "cable") เหมือนเดิม;
    #   subtype ⇒ charger family + unit-domain expansion เดิม
    got = build_retrieval_profile(
        "รุ่นนี้ต่างกันยังไง",
        history=[],
        intent_result={"intent": "product_spec", "product_type": "cable",
                       "confidence": 0.95},
        shop="x",
    )
    assert got.subtype == "cable"
    assert got.product_types == frozenset({"charger", "cable"})
    assert ("subtype", "intent") in got.fact_sources


def test_intent_charger_plus_subtype_pair_unchanged():
    got = build_retrieval_profile(
        "รุ่นนี้ต่างกันยังไง",
        history=[],
        intent_result={"intent": "product_spec", "product_type": "charger",
                       "charger_subtype": "adapter", "confidence": 0.95},
        shop="x",
    )
    assert got.subtype == "adapter"
    assert got.product_types == frozenset({"charger"})
    assert ("product_types", "intent") in got.fact_sources


def test_current_message_type_beats_intent_proposal():
    got = build_retrieval_profile(
        "หูฟังตัวไหนดี",
        history=[],
        intent_result={"intent": "product_recommend", "product_type": "charger",
                       "confidence": 0.95},
        shop="x",
    )
    assert got.product_types == frozenset({"earphone"})
    assert "charger" not in got.product_types


def test_compatible_anchor_beats_intent_proposal():
    got = build_retrieval_profile(
        "รุ่นนี้ต่างกันยังไง",
        history=[],
        intent_result={"intent": "product_recommend", "product_type": "charger",
                       "confidence": 0.95},
        shop="x",
        anchor_cards=[{"item_id": 1,
                       "name": "Anker Soundcore R50i หูฟังบลูทูธ"}],
    )
    assert got.product_types == frozenset({"earphone"})
    assert ("product_types", "anchor") in got.fact_sources


def test_low_confidence_intent_scope_not_applied():
    # conf gate ≥0.7 เดิม — ต่ำกว่าต้องไม่รับทั้ง type/subtype จาก intent
    got = build_retrieval_profile(
        "รุ่นนี้ต่างกันยังไง",
        history=[],
        intent_result={"intent": "product_recommend", "product_type": "dashcam",
                       "charger_subtype": "cable", "confidence": 0.4},
        shop="x",
    )
    assert got.product_types == frozenset()
    assert got.subtype is None
    assert ("product_types", "intent") not in got.fact_sources


# ── Phase 1 Q3 (tee_apichap): current image-derived target device ─────────
# `image_desc` = vision description ของ turn นี้ (ผ่าน param เดียว) — merge
# เข้า target_device precedence เดิม: explicit text > intent > current image
# > historical — stamp ("target_device", "image_desc") เมื่อ image เป็น
# source; หลาย distinct device ในภาพ → fail-closed (None → clarify ข้างล่าง
# ไม่เดา arbitrary); image-derived device = retrieval/clarification context
# เท่านั้น ไม่ authorize compat verdict (typed evidence เท่านั้นที่ตัดสิน)

def test_image_desc_supplies_target_device_with_provenance():
    got = build_retrieval_profile(
        "[รูปภาพ]",
        history=[],
        intent_result={"intent": "compatibility_check", "confidence": 0.9},
        shop="AnyShop",
        image_desc="เครื่องฟอกอากาศ Xiaomi Air Purifier 4 Lite",
    )
    assert got.target_device == "purifier 4 lite"
    assert ("target_device", "image_desc") in got.fact_sources


def test_explicit_message_device_beats_image_desc():
    got = build_retrieval_profile(
        "มีเคสใช้กับ iphone 15 ไหม",
        history=[],
        intent_result={"intent": "compatibility_check", "confidence": 0.9},
        shop="AnyShop",
        image_desc="iphone 16 pro max",
    )
    assert got.target_device == "iphone 15"
    assert ("target_device", "message") in got.fact_sources
    assert ("target_device", "image_desc") not in got.fact_sources


def test_image_desc_beats_history_device():
    got = build_retrieval_profile(
        "ใช้ได้ไหมครับ",
        history=[{"role": "user", "text": "มีสายสำหรับ iphone 15 ไหม"}],
        intent_result={"intent": "compatibility_check", "confidence": 0.9},
        shop="AnyShop",
        image_desc="xiaomi air purifier 4 lite",
    )
    assert got.target_device == "purifier 4 lite"
    assert ("target_device", "image_desc") in got.fact_sources
    assert ("target_device", "history") not in got.fact_sources


def test_multiple_image_desc_devices_fail_closed():
    # vision เห็นเคสสองรุ่น — device กำกวม → ไม่เดา; downstream clarify owner
    got = build_retrieval_profile(
        "[รูปภาพ]",
        history=[],
        intent_result={"intent": "compatibility_check", "confidence": 0.9},
        shop="AnyShop",
        image_desc="เคส iphone 15 กับเคส iphone 16",
    )
    assert got.target_device is None
