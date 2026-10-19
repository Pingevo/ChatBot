"""test_canonical_evidence_card.py — Revised Phase 3 canonical contract.

pin canonical evidence-card fields ที่ make_evidence_card() (adapter เจ้าเดียว)
ต้องผลิตก่อน pool/selection:

    canonical_type / canonical_roles / variant_facets
    publish_state     = published | unpublished | deleted | unknown
    stock_state       = in_stock | out_of_stock | unknown
    requested_variant_state = not_requested | available | out_of_stock
                            | not_offered | unknown
    customer_visibility = visible | historical_only | hidden
    availability_reason / sellable / _evidence.facts trace

vocab ที่ใช้ใน test = ค่าจริงจาก exports/sellable_units.jsonl
(charger_subtype: adapter/cable_only/set/car_charger/wireless/desktop,
 cable_subtype: c-to-c/usb-c/type-a/c-to-l/lightning/micro,
 item_status: NORMAL/UNLIST/SELLER_DELETE/BANNED/DELETED/SHOPEE_DELETE/REVIEWING)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat.retrieval_policy import make_evidence_card  # noqa: E402


# ── fixtures (shape เดียวกับ to_unit_card / to_product_card output) ─────────

def _unit_card(**over):
    """unit card shape เดียวกับ to_unit_card — resolver fields stamped เหมือน production"""
    card = {
        "item_id": "i1", "unit_id": "u1", "model_id": "m1",
        "name": "ZMI AL803 สายชาร์จ Type-C สีแดง ยาว 1.5 เมตร",
        "model_name": "AL803 สีแดง",
        "status": "NORMAL", "total_stock": 5,
        "catalog_status": "active",
        "availability_reason": "normal_positive_stock",
        "sold_out": False, "_available_for_sale": True,
        "customer_visible": True, "sellable": True,
        "variants": [{"name": "AL803 สีแดง", "model_id": "m1", "stock": 5,
                      "model_status": "MODEL_NORMAL", "price": 100}],
        "tier_variation": [],
        "product_type": "cable", "charger_subtype": "cable_only",
        "cable_subtype": "type-a", "camera_subtype": None,
        "components": ["cable"],
        "model_codes": ["AL803"],
    }
    card.update(over)
    return card


def _listing_card(**over):
    """listing card หลาย variant — one dead + one live (shape to_product_card)"""
    card = {
        "item_id": "L1",
        "name": "ZMI AL881 สายชาร์จ Type-C ยาว 2 เมตร",
        "status": "NORMAL", "total_stock": 12,
        "catalog_status": "active",
        "availability_reason": "normal_positive_stock",
        "customer_visible": True, "_available_for_sale": True,
        "variants": [
            {"name": "AL881 สีแดง", "model_id": "v1", "stock": 3,
             "model_status": "MODEL_NORMAL", "price": 90, "tier_index": [0]},
            {"name": "AL881 สีดำ", "model_id": "v2", "stock": 0,
             "model_status": "MODEL_NORMAL", "price": 90, "tier_index": [1]},
        ],
        "tier_variation": [{"name": "สี", "options": ["สีแดง", "สีดำ"]}],
    }
    card.update(over)
    return card


def _ures(cards):
    from shopeechat.units import UnitEvidenceFetchResult
    return UnitEvidenceFetchResult(
        cards=tuple(cards), raw_count=len(cards),
        sellable_count=sum(1 for c in cards if c.get("_available_for_sale")),
        unavailable_count=sum(1 for c in cards
                              if not c.get("_available_for_sale")),
        trace=("fake",))


def _req(rid="r0", types=("charger",), subs=(), codes=(), vterms=(),
         mode="sellable_first"):
    from shopeechat.retrieval_planner import RetrievalRequest
    return RetrievalRequest(
        rid, "s0", "slot", frozenset(types), frozenset(subs), tuple(codes),
        None, mode, "none", variant_terms=tuple(vterms))


def _run(cards, req, legacy_cards=()):
    from shopeechat.retrieval_executor import execute_grouped_retrieval_requests
    return execute_grouped_retrieval_requests(
        (req,), message="q", shop="s",
        fetcher=lambda m, **kw: _ures(cards),
        legacy_fetcher=(lambda m, **kw: _ures(legacy_cards))
        if legacy_cards else None)


# ── A) type/role normalization ───────────────────────────────────────────────

def test_cable_only_unit_normalizes_role_and_connector():
    # ค่าจริง: (product_type=cable, charger_subtype=cable_only, cable_subtype=type-a)
    c = make_evidence_card(_unit_card(), source="units")
    assert c["canonical_type"] == "cable"
    assert set(c["canonical_roles"]) == {"cable"}
    assert c["variant_facets"]["connector"] == "type-a"


def test_adapter_unit_role_not_cable():
    c = make_evidence_card(_unit_card(
        product_type="charger", charger_subtype="adapter",
        cable_subtype=None, components=["adapter"],
        name="หัวชาร์จ 65W", model_name="65W"), source="units")
    assert c["canonical_type"] == "charger"
    assert set(c["canonical_roles"]) == {"adapter"}


def test_set_unit_has_adapter_and_cable_roles():
    # ค่าจริง: components=['adapter','cable'] + charger_subtype='set'
    c = make_evidence_card(_unit_card(
        product_type="charger", charger_subtype="set",
        cable_subtype="c-to-c", components=["adapter", "cable"],
        name="ชุดชาร์จ หัว+สาย", model_name="หัว+สาย iP"), source="units")
    assert {"set", "adapter", "cable"} <= set(c["canonical_roles"])
    assert c["variant_facets"]["connector"] == "c-to-c"


def test_c_to_c_is_connector_facet_not_role():
    c = make_evidence_card(_unit_card(cable_subtype="c-to-c"), source="units")
    assert c["variant_facets"]["connector"] == "c-to-c"
    assert "c-to-c" not in set(c["canonical_roles"])


def test_unknown_subtype_stays_unknown_and_traced():
    # ค่า subtype ที่ไม่อยู่ใน vocab → ห้ามเดา role; trace ไว้ใน facts
    c = make_evidence_card(_unit_card(
        product_type="charger", charger_subtype="rotary",
        cable_subtype=None, components=None,
        name="ZMI ZX99 ชาร์จเร็ว", model_name="ZX99"), source="units")
    facts = c["_evidence"]["facts"]["canonical"]
    assert "rotary" in str(facts)


def test_unknown_product_type_fails_closed():
    # product_type=None มีจริง 2,641 recs — ชื่อ detect ไม่ได้ → canonical_type ว่าง
    c = make_evidence_card(_unit_card(
        product_type=None, charger_subtype=None, cable_subtype=None,
        components=None, name="สินค้า XYZ พิเศษ 999", model_name="XYZ"),
        source="units")
    assert not c["canonical_type"]


# ── B) publication/visibility ────────────────────────────────────────────────

def test_normal_in_stock_published_visible_sellable():
    c = make_evidence_card(
        {"name": "พาวเวอร์แบงค์ PB", "status": "NORMAL", "total_stock": 5,
         "item_id": "p1"}, source="legacy")
    assert c["publish_state"] == "published"
    assert c["stock_state"] == "in_stock"
    assert c["customer_visibility"] == "visible"
    assert c["sellable"] is True


def test_unlist_unpublished_hidden_never_sellable():
    # WPB100L shape: UNLIST + stock 440 — stock ไม่ทำให้มองเห็น/ขายได้
    c = make_evidence_card(
        {"name": "WPB100L พาวเวอร์แบงค์", "status": "UNLIST",
         "total_stock": 440, "item_id": "h1"}, source="units")
    assert c["publish_state"] == "unpublished"
    assert c["customer_visibility"] == "hidden"
    assert c["sellable"] is False
    assert c["stock_state"] != "in_stock"


def test_deleted_statuses_historical_only():
    for st in ("SELLER_DELETE", "DELETED", "SHOPEE_DELETE", "BANNED"):
        c = make_evidence_card(
            {"name": "X", "status": st, "total_stock": 0, "item_id": "d1"},
            source="legacy")
        assert c["publish_state"] == "deleted", st
        assert c["customer_visibility"] == "historical_only", st
        assert c["sellable"] is False, st


def test_reviewing_unknown_fails_closed():
    c = make_evidence_card(
        {"name": "X", "status": "REVIEWING", "total_stock": 3,
         "item_id": "r1"}, source="legacy")
    assert c["publish_state"] == "unknown"
    assert c["customer_visibility"] == "hidden"
    assert c["sellable"] is False


def test_normal_zero_stock_out_of_stock_not_unknown():
    c = make_evidence_card(
        {"name": "X", "status": "NORMAL", "total_stock": 0, "item_id": "o1"},
        source="legacy")
    assert c["publish_state"] == "published"
    assert c["stock_state"] == "out_of_stock"
    assert c["customer_visibility"] == "visible"
    assert c["sellable"] is False


def test_stamped_resolver_fields_win_over_recompute():
    # to_unit_card stamp catalog_status จาก model-level resolve (variant ตาย
    # แต่ listing ยัง NORMAL) — adapter ต้องใช้ stamped ไม่ resolve ซ้ำระดับ card
    c = make_evidence_card(_unit_card(
        catalog_status="out_of_stock", total_stock=0, _available_for_sale=False,
        customer_visible=True, sellable=False), source="units")
    assert c["stock_state"] == "out_of_stock"
    assert c["publish_state"] == "published"


# ── C) stock + requested variant ─────────────────────────────────────────────

def test_variant_rows_get_per_row_stock_state():
    c = make_evidence_card(_listing_card(), source="legacy")
    by_name = {v["name"]: v for v in c["variants"]}
    assert by_name["AL881 สีแดง"]["stock_state"] == "in_stock"
    assert by_name["AL881 สีดำ"]["stock_state"] == "out_of_stock"
    # one dead variant ไม่ใช่ all-dead — card-level ยัง in_stock
    assert c["stock_state"] == "in_stock"
    assert c["sellable"] is True


def test_requested_color_available():
    c = make_evidence_card(_listing_card(), source="legacy",
                           requested=("สีแดง",))
    assert c["requested_variant_state"] == "available"
    assert c["sellable"] is True


def test_requested_color_dead_is_not_whole_product_sold_out():
    # สีดำหมดแต่สีแดงเหลือ — missing color ≠ product sold out
    c = make_evidence_card(_listing_card(), source="legacy",
                           requested=("สีดำ",))
    assert c["requested_variant_state"] == "out_of_stock"
    assert c["stock_state"] == "in_stock"
    assert c["sellable"] is False   # requested option หมด → ไม่ eligible


def test_requested_color_not_offered_is_not_out_of_stock():
    c = make_evidence_card(_listing_card(), source="legacy",
                           requested=("สีม่วง",))
    assert c["requested_variant_state"] == "not_offered"
    assert c["stock_state"] == "in_stock"


def test_no_requested_variant():
    c = make_evidence_card(_listing_card(), source="legacy")
    assert c["requested_variant_state"] == "not_requested"


def test_missing_option_data_stays_unknown():
    card = {"name": "พาวเวอร์แบงค์ X", "status": "NORMAL", "total_stock": 3,
            "catalog_status": "active", "customer_visible": True,
            "_available_for_sale": True, "item_id": "k1"}
    c = make_evidence_card(card, source="legacy", requested=("สีแดง",))
    assert c["requested_variant_state"] == "unknown"
    assert c["sellable"] is False   # option ที่ขอไม่มี evidence → fail closed


def test_requested_variant_on_unit_card():
    c = make_evidence_card(_unit_card(), source="units",
                           requested=("สีแดง",))
    assert c["requested_variant_state"] == "available"
    assert c["sellable"] is True


def test_requested_other_color_unit_unknown():
    # unit "AL803 สีแดง" ไม่มี tier vocab — name ไม่พิสูจน์ absence ของ "ดำ"
    # (not_offered ต้องมาจาก structured option vocab เท่านั้น)
    c = make_evidence_card(_unit_card(), source="units",
                           requested=("สีดำ",))
    assert c["requested_variant_state"] == "unknown"


def test_iss29_requested_option_state():
    # issue #29 shape: variant "กล้องอย่างเดียว" หมด — state ต้องชี้ variant นั้น
    c = make_evidence_card(_unit_card(
        product_type="camera", charger_subtype=None, cable_subtype=None,
        components=["camera"], name="กล้องวงจรปิด IMILAB",
        model_name="กล้องอย่างเดียว",
        variants=[{"name": "กล้องอย่างเดียว", "model_id": "m1", "stock": 0,
                   "model_status": "MODEL_NORMAL"}],
        total_stock=0, catalog_status="out_of_stock",
        _available_for_sale=False, sellable=False),
        source="units", requested=("กล้องอย่างเดียว",))
    assert c["requested_variant_state"] == "out_of_stock"


# ── D) retrieval behavior ────────────────────────────────────────────────────

def test_executor_hidden_card_rejected_with_canonical_fields():
    cards = [_unit_card(status="UNLIST", catalog_status="unlisted",
                        customer_visible=False, _available_for_sale=False,
                        sellable=False, total_stock=440)]
    res = _run(cards, _req(types=("cable",), subs=("cable",)))[0]
    assert not res.eligible_candidates
    rej = res.rejected_evidence[0]
    assert rej["customer_visibility"] == "hidden"
    assert rej["publish_state"] == "unpublished"
    assert rej["_selection_reason"] == "customer_hidden"


def test_cable_only_unit_passes_cable_subtype_request():
    res = _run([_unit_card()], _req(types=("charger",), subs=("cable",)))[0]
    assert len(res.eligible_candidates) == 1
    card = res.eligible_candidates[0]
    assert "cable" in set(card["canonical_roles"])


def test_adapter_unit_rejected_in_cable_request():
    cards = [_unit_card(product_type="charger", charger_subtype="adapter",
                        cable_subtype=None, components=["adapter"],
                        name="หัวชาร์จ 65W", model_name="65W")]
    res = _run(cards, _req(types=("charger",), subs=("cable",)))[0]
    assert not res.eligible_candidates
    assert res.rejected_evidence[0]["_selection_reason"] == "subtype_mismatch"


def test_multi_subtype_coverage_uses_canonical_roles():
    # live bug: charger_subtype="cable_only" ไม่เคยนับเป็น cable coverage —
    # adapter score สูงกว่าเต็ม quota แต่ cable ต้องได้ ≥1 ที่
    from shopeechat.candidate_pool import build_candidate_pool
    from shopeechat.retrieval_selection import select_for_llm_context
    cards = [_unit_card(unit_id=f"ua{i}", item_id=f"ia{i}", model_id=f"ma{i}",
                        product_type="charger", charger_subtype="adapter",
                        cable_subtype=None, components=["adapter"],
                        name="หัวชาร์จ A", model_name="A", _score=5.0)
             for i in range(3)]
    cards.append(_unit_card(unit_id="uc", item_id="ic", model_id="mc",
                            _score=0.1))
    req = _req(types=("charger",), subs=("adapter", "cable"))
    res = _run(cards, req)[0]
    pool = build_candidate_pool((res,))
    sel = select_for_llm_context(pool, (req,), per_request_limit=3)
    kinds = {s.card.get("charger_subtype") for s in sel.selected}
    assert "cable_only" in kinds   # cable ต้องได้ coverage แม้ score ต่ำกว่า


def test_mixed_unlist_and_visible_same_item_uses_visible_card():
    # identity เดียวกัน: UNLIST unit (hidden แต่มี image_text) + NORMAL OOS
    # listing — merge ต้องเลือก visible ไม่ใช่ hidden-richer
    from shopeechat.candidate_pool import build_candidate_pool
    un = _unit_card(item_id="x1", unit_id="ux1", status="UNLIST",
                    catalog_status="unlisted", customer_visible=False,
                    _available_for_sale=False, sellable=False,
                    total_stock=440, image_text="OCR spec ยาวมาก")
    leg = {"item_id": "x1", "name": "สายชาร์จ ZMI", "status": "NORMAL",
           "total_stock": 0, "catalog_status": "out_of_stock",
           "customer_visible": True, "_available_for_sale": False,
           "availability_reason": "normal_zero_stock"}
    res = _run([un], _req(types=("charger",), subs=("cable",)),
               legacy_cards=[leg])[0]
    pool = build_candidate_pool((res,))
    cand = pool.unavailable[0]
    assert cand.card["customer_visibility"] == "visible"
    assert cand.card["publish_state"] == "published"
    assert cand.card["stock_state"] == "out_of_stock"


def test_requested_dead_option_unavailable_not_rejected():
    res = _run([_listing_card()],
               _req(types=("charger",), subs=("cable",),
                    vterms=("สีดำ",)))[0]
    assert not res.eligible_candidates
    assert not res.rejected_evidence
    un = res.unavailable_evidence[0]
    assert un["requested_variant_state"] == "out_of_stock"
    assert "requested_variant" in (un["_selection_reason"] or "")


def test_image_text_is_evidence_not_state_decider():
    # OCR/cert text ต้องติดมาเป็น evidence — ห้ามตัดสิน publish/stock เอง
    c = make_evidence_card(_unit_card(
        status="UNLIST", catalog_status="unlisted", customer_visible=False,
        _available_for_sale=False, sellable=False, total_stock=440,
        image_text="ใบรับรอง มอก. พร้อมส่ง 100 ชิ้น"), source="units")
    assert c["image_text"].startswith("ใบรับรอง")
    assert c["customer_visibility"] == "hidden"
    assert c["stock_state"] != "in_stock"


def test_slot_and_request_carry_variant_terms():
    from shopeechat.route_context import (
        RetrievalProfile, build_retrieval_slots)
    from shopeechat.retrieval_planner import build_grouped_retrieval_requests
    prof = RetrievalProfile(
        platform="shopee", shop="s", message="มีสายชาร์จสีแดงไหม",
        intent="shopping", product_types=frozenset({"charger"}),
        subtype="cable", model_codes=(), variant_terms=("สีแดง",),
        target_device=None, availability_mode="sellable_first",
        compat_mode="none")
    slots = build_retrieval_slots(prof)
    assert getattr(slots[0], "variant_terms", ()) == ("สีแดง",)
    reqs = build_grouped_retrieval_requests(prof, slots, ())
    assert getattr(reqs[0], "variant_terms", ()) == ("สีแดง",)


# ── A) real message → requested variant signal (production parser เท่านั้น) ──

def _real_path(msg):
    """build_retrieval_profile → slots → relations → requests — no injection"""
    from shopeechat import route_context
    from shopeechat.retrieval_planner import build_grouped_retrieval_requests
    prof = route_context.build_retrieval_profile(
        msg, history=[],
        intent_result={"intent": "product_recommend", "confidence": 0.9},
        shop="s")
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    reqs = build_grouped_retrieval_requests(prof, slots, rels)
    return prof, slots, reqs


def _two_dim_listing(**over):
    """listing 2 tier dims — สี×ความยาว (shape to_product_card)"""
    card = {
        "item_id": "L2", "name": "สายชาร์จ ZMI",
        "status": "NORMAL", "total_stock": 8, "catalog_status": "active",
        "availability_reason": "normal_positive_stock",
        "customer_visible": True, "_available_for_sale": True,
        "tier_variation": [
            {"name": "สี", "options": ["แดง", "น้ำเงิน"]},
            {"name": "ความยาว", "options": ["1 เมตร", "2 เมตร"]},
        ],
        "variants": [
            {"name": "แดง/1 เมตร", "model_id": "r1", "stock": 5,
             "model_status": "MODEL_NORMAL", "tier_index": [0, 0]},
            {"name": "น้ำเงิน/2 เมตร", "model_id": "b2", "stock": 3,
             "model_status": "MODEL_NORMAL", "tier_index": [1, 1]},
        ],
    }
    card.update(over)
    return card


def test_real_message_color_term_resolves_to_available():
    # "มีสายชาร์จสีแดงไหม" — parser อาจกิน "ไหม" ติด term แต่ option "แดง"
    # ต้องยัง resolve ได้ (containment ทิศ option∈term) ไม่กลายเป็น not_offered
    prof, slots, reqs = _real_path("มีสายชาร์จสีแดงไหม")
    assert reqs, "มี product type → ต้องมี request"
    assert reqs[0].variant_terms, "term ต้อง propagate ถึง request"
    res = _run([_listing_card()], reqs[0])[0]
    assert res.eligible_candidates
    assert res.eligible_candidates[0]["requested_variant_state"] == "available"


def test_real_message_length_only_not_fabricated():
    # "มีสายชาร์จยาว 2 เมตรไหม" — parser เดิมไม่จับ length → ห้ามเดา
    prof, slots, reqs = _real_path("มีสายชาร์จยาว 2 เมตรไหม")
    assert prof.variant_terms == ()
    for r in reqs:
        assert r.variant_terms == ()
    c = make_evidence_card(_listing_card(), source="legacy")
    assert c["requested_variant_state"] == "not_requested"


def test_real_message_color_junk_term_still_resolves():
    # "ขอสีแดงยาว 2 เมตร" — ไม่มี product type → ไม่มี request (honest gap)
    # แต่ slot term "สีแดงยาว" ที่ parser ให้ต้องยัง map กลับหา option "แดง" ได้
    prof, slots, reqs = _real_path("ขอสีแดงยาว 2 เมตร")
    assert reqs == ()
    assert slots and slots[0].variant_terms
    c = make_evidence_card(_listing_card(), source="legacy",
                           requested=slots[0].variant_terms)
    assert c["requested_variant_state"] == "available"


# ── B) multi-dimensional SKU intersection ────────────────────────────────────

def test_sku_intersection_red_2m_not_offered():
    # มีแค่ แดง-1ม + น้ำเงิน-2ม — combination แดง+2ม ไม่มี SKU → not_offered
    # (per-term aggregation เดิมตอบ available ผิด — term ละ row ต่างกัน)
    c = make_evidence_card(_two_dim_listing(), source="legacy",
                           requested=("สีแดง", "2 เมตร"))
    assert c["requested_variant_state"] == "not_offered"
    assert c["sellable"] is False


def test_sku_intersection_matching_row_available():
    c = make_evidence_card(_two_dim_listing(
        variants=[
            {"name": "แดง/2 เมตร", "model_id": "r2", "stock": 4,
             "model_status": "MODEL_NORMAL", "tier_index": [0, 1]},
            {"name": "น้ำเงิน/1 เมตร", "model_id": "b1", "stock": 9,
             "model_status": "MODEL_NORMAL", "tier_index": [1, 0]},
        ]), source="legacy", requested=("สีแดง", "2 เมตร"))
    assert c["requested_variant_state"] == "available"
    assert c["sellable"] is True


def test_sku_intersection_all_matching_rows_dead():
    c = make_evidence_card(_two_dim_listing(
        variants=[
            {"name": "แดง/2 เมตร", "model_id": "r2", "stock": 0,
             "model_status": "MODEL_NORMAL", "tier_index": [0, 1]},
        ]), source="legacy", requested=("สีแดง", "2 เมตร"))
    assert c["requested_variant_state"] == "out_of_stock"
    assert c["stock_state"] == "in_stock"   # ของชิ้นอื่นยังมี — ไม่ใช่ของหมดทั้งใบ


def test_tier_index_dimension_no_collision():
    # term "น้ำเงิน" → dim0 opt1 — row tier_index=[0,1] มี 1 ที่ dim1 เท่านั้น
    # index ข้าม dimension ห้ามชนกัน → row นี้ไม่ satisfy
    c = make_evidence_card(_two_dim_listing(
        variants=[
            {"name": "แดง/2 เมตร", "model_id": "r2", "stock": 5,
             "model_status": "MODEL_NORMAL", "tier_index": [0, 1]},
        ]), source="legacy", requested=("สีน้ำเงิน",))
    assert c["requested_variant_state"] == "not_offered"


def test_tier_vocab_exists_but_row_index_missing_unknown():
    # structured vocab มี "แดง" แต่ rows ไม่มี tier_index → evidence ไม่ครบ
    c = make_evidence_card(_two_dim_listing(
        variants=[
            {"name": "แดง", "model_id": "r", "stock": 5,
             "model_status": "MODEL_NORMAL"},
        ]), source="legacy", requested=("สีแดง",))
    assert c["requested_variant_state"] == "unknown"
    assert c["sellable"] is False


def test_requested_option_absent_from_vocab_multi_dim():
    # dims มี structured vocab แต่ "เขียว" ไม่อยู่ใน dim ไหนเลย → not_offered
    c = make_evidence_card(_two_dim_listing(), source="legacy",
                           requested=("สีเขียว",))
    assert c["requested_variant_state"] == "not_offered"


# ── C) UNLIST-only invisibility — zero identity leak ─────────────────────────

def _select(cards, req):
    from shopeechat.candidate_pool import build_candidate_pool
    from shopeechat.retrieval_selection import select_for_llm_context
    res = _run(cards, req)[0]
    pool = build_candidate_pool((res,))
    return select_for_llm_context(pool, (req,))


def _unlist_card(**over):
    c = {"item_id": "h1", "name": "สายชาร์จ WPB100L เลิกขาย",
         "product_type": "cable", "model_codes": ["WPB100L"],
         "status": "UNLIST", "catalog_status": "unlisted",
         "customer_visible": False, "_available_for_sale": False,
         "availability_reason": "item_unlisted", "total_stock": 440}
    c.update(over)
    return c


def test_unlist_only_leaks_no_identity():
    # UNLIST-only identity → ไม่มี name/item_id/evidence/mention ใน output ใดๆ
    sel = _select([_unlist_card()], _req(types=("cable",), codes=("WPB100L",)))
    assert not getattr(sel, "hidden_mentions", ())
    assert not sel.selected
    for u in sel.unavailable_evidence:
        assert u.get("item_id") != "h1"
        assert "WPB100L" not in str(u.get("name") or "")
    # rejected summary = reason+count เท่านั้น — ไม่มี identity
    for r in sel.rejected_summary:
        assert "item_id" not in r and "name" not in r


def test_unlist_only_run_grouped_selection_returns_empty_not_none():
    # hidden-only → pipeline รันได้แต่ selected ว่าง → dict(selected_cards=[])
    # — caller ใช้แทน products (zero context) ไม่ใช่ fallback legacy
    from shopeechat.retrieval_runtime import run_grouped_selection
    out = run_grouped_selection(
        _real_path("สายชาร์จ WPB100L มีไหม")[0],
        message="สายชาร์จ WPB100L มีไหม", shop="s",
        fetcher=lambda m, **kw: _ures([_unlist_card()]),
        legacy_fetcher=lambda m, **kw: [])
    assert out is not None
    assert out["selected_cards"] == []
    # hidden identity ห้ามรั่ว — ไม่มี unavailable evidence ของ UNLIST
    assert "WPB100L" not in str(out)


# ── Correction Round 2 — RED probes (probe-verified ก่อนเขียน) ───────────────

# ── A) unit card: real message → structured tier evidence ────────────────────

def _unit_doc_red():
    """unit doc + joined _listing (attach_listing_fields output shape)."""
    return {
        "unit_id": "u-red", "item_id": 1001, "model_id": 501,
        "model_name": "AL803 สีแดง",
        "display_name": "สายชาร์จ ZMI AL803 Type-C",
        "product_type": "cable", "components": ["cable"],
        "cable_subtype": "c-to-c",
        "item_status": "NORMAL", "model_status": "MODEL_NORMAL",
        "price": 90, "brand": {"original_brand_name": "ZMI"},
        "cat_name": "สายชาร์จ", "shop": "s",
        "desc_sections": {}, "image_ids": [], "model_codes": ["AL803"],
        "_listing": {
            "item_id": 1001, "item_status": "NORMAL",
            "name": "สายชาร์จ ZMI AL803",
            "image": {"image_id_list": ["img1"]},
            "condition": 1, "price_info": [{"current_price": 90}],
            "model": [
                {"model_id": 501, "model_name": "AL803 สีแดง",
                 "tier_index": [0], "model_status": "MODEL_NORMAL",
                 "stock_info_v2": {"summary_info":
                                   {"total_available_stock": 5}}},
                {"model_id": 502, "model_name": "AL803 สีดำ",
                 "tier_index": [1], "model_status": "MODEL_NORMAL",
                 "stock_info_v2": {"summary_info":
                                   {"total_available_stock": 0}}},
            ],
            "tier_variation": [
                {"name": "สี",
                 "option_list": [{"option": "สีแดง"}, {"option": "สีดำ"}]},
            ],
        },
    }


def test_unit_card_carries_listing_tier_evidence():
    # to_unit_card ต้อง preserve tier_variation ของ listing + tier_index ของ model
    from shopeechat.units import to_unit_card
    card = to_unit_card(_unit_doc_red())
    opts = [o for tv in (card.get("tier_variation") or [])
            for o in (tv.get("options") or [])]
    assert opts == ["สีแดง", "สีดำ"]
    assert card["variants"][0].get("tier_index") == [0]


def test_real_message_to_unit_card_requested_variant_available():
    # real chain: message → profile → slot → request → unit card → adapter
    from shopeechat.route_context import (
        build_retrieval_profile, build_retrieval_slots)
    from shopeechat.retrieval_planner import build_grouped_retrieval_requests
    from shopeechat.units import to_unit_card
    profile = build_retrieval_profile(
        "มีสายชาร์จสีแดงไหม", history=None, intent_result=None, shop="s")
    reqs = build_grouped_retrieval_requests(
        profile, build_retrieval_slots(profile), [])
    vterms = tuple(t for r in reqs for t in (r.variant_terms or ()))
    assert vterms
    card = make_evidence_card(
        to_unit_card(_unit_doc_red()), source="unit", requested=vterms)
    assert card["requested_variant_state"] == "available"
    assert card["sellable"] is True


# ── B) overlapping option names — one option per term/dim, never union ───────

def _overlap_listing(**over):
    card = {
        "item_id": "L9", "name": "สายชาร์จ", "status": "NORMAL",
        "catalog_status": "active", "availability_reason": "s",
        "customer_visible": True, "_available_for_sale": True,
        "tier_variation": [{"name": "สี", "options": ["แดง", "แดงอิฐ"]}],
        "variants": [
            {"name": "แดง", "tier_index": [0], "stock": 5,
             "model_status": "MODEL_NORMAL"},
            {"name": "แดงอิฐ", "tier_index": [1], "stock": 0,
             "model_status": "MODEL_NORMAL"},
        ],
    }
    card.update(over)
    return card


def test_overlap_term_resolves_most_specific_not_union():
    # "สีแดงอิฐ" ต้อง resolve เฉพาะ idx1 (OOS) — ห้าม union {0,1} แล้วตี available
    c = make_evidence_card(_overlap_listing(), source="unit",
                           requested=("สีแดงอิฐ",))
    assert c["requested_variant_state"] == "out_of_stock"


def test_overlap_plain_red_not_absorbed_by_brick():
    # "แดง" exact → idx0 (in stock) — ห้ามกิน "แดงอิฐ"
    c = make_evidence_card(_overlap_listing(), source="unit",
                           requested=("แดง",))
    assert c["requested_variant_state"] == "available"


def test_overlap_exact_match_wins_over_containment():
    c = make_evidence_card(_overlap_listing(), source="unit",
                           requested=("แดงอิฐ",))
    assert c["requested_variant_state"] == "out_of_stock"


def test_overlap_contained_tie_is_unknown():
    # term มี 2 option ยาวเท่ากันใน dim เดียว → ไม่พิสูจน์เจาะจง → unknown
    card = _overlap_listing(
        tier_variation=[{"name": "สี", "options": ["แดง", "ทอง"]}],
        variants=[{"name": "แดง", "tier_index": [0], "stock": 5,
                   "model_status": "MODEL_NORMAL"}])
    c = make_evidence_card(card, source="unit", requested=("แดงทอง",))
    assert c["requested_variant_state"] == "unknown"


def test_same_dim_two_values_not_or_ed():
    # "แดง"+"น้ำเงิน" คนละค่าใน dim เดียว → ขัดกัน ไม่ union → unknown
    card = {
        "item_id": "L10", "name": "สายชาร์จ", "status": "NORMAL",
        "catalog_status": "active", "customer_visible": True,
        "tier_variation": [{"name": "สี", "options": ["แดง", "น้ำเงิน"]}],
        "variants": [
            {"name": "แดง", "tier_index": [0], "stock": 5,
             "model_status": "MODEL_NORMAL"},
            {"name": "น้ำเงิน", "tier_index": [1], "stock": 5,
             "model_status": "MODEL_NORMAL"},
        ],
    }
    c = make_evidence_card(card, source="unit",
                           requested=("แดง", "น้ำเงิน"))
    assert c["requested_variant_state"] == "unknown"


def test_multidim_intersection_still_exact():
    # แดง+2ม ไม่มี row → not_offered (แดง+1ม, น้ำเงิน+2ม มีอยู่)
    card = {
        "item_id": "L11", "name": "สายชาร์จ", "status": "NORMAL",
        "catalog_status": "active", "customer_visible": True,
        "tier_variation": [
            {"name": "สี", "options": ["แดง", "น้ำเงิน"]},
            {"name": "ความยาว", "options": ["1 เมตร", "2 เมตร"]},
        ],
        "variants": [
            {"name": "แดง 1ม", "tier_index": [0, 0], "stock": 5,
             "model_status": "MODEL_NORMAL"},
            {"name": "น้ำเงิน 2ม", "tier_index": [1, 1], "stock": 5,
             "model_status": "MODEL_NORMAL"},
        ],
    }
    c = make_evidence_card(card, source="unit",
                           requested=("แดง", "2 เมตร"))
    assert c["requested_variant_state"] == "not_offered"


# ── C) answer-context boundary — flag ON = replace, OFF = legacy ─────────────

def _app_source():
    from pathlib import Path
    import shopeechat
    p = Path(shopeechat.__file__).parent / "app.py"
    return p.read_text()


def test_flag_on_callsites_replace_not_merge():
    # ทั้ง 2 boundary ต้องอยู่ใต้ _sel_flag (flag ownership — fail closed เมื่อ
    # selection None) — ห้าม merge_selected_products (UNLIST/legacy re-entry)
    src = _app_source()
    assert "merge_selected_products" not in src
    lines = src.splitlines()
    hits = [i for i, l in enumerate(lines)
            if 'selected_cards"][:_llm_ctx_limit]' in l]
    assert len(hits) == 2, f"expected 2 answer boundaries, found {len(hits)}"
    for i in hits:
        ctx = "\n".join(lines[i - 3:i + 2])
        assert "if _sel_flag:" in ctx
        assert "else [])" in ctx      # run→None → products=[] (fail closed)


def test_run_grouped_selection_empty_returns_dict_not_none():
    # pipeline รันได้แต่ selected ว่าง → dict — None สงวนไว้เฉพาะ pipeline
    # exception (flag-ON caller fail closed → product context ว่าง)
    from shopeechat.retrieval_runtime import run_grouped_selection
    out = run_grouped_selection(
        _real_path("มีสายชาร์จไหม")[0],
        message="มีสายชาร์จไหม", shop="s",
        fetcher=lambda m, **kw: _ures([]),
        legacy_fetcher=lambda m, **kw: [])
    assert out is not None
    assert out["selected_cards"] == []


# ── D) publication-map ownership direction ───────────────────────────────────

def test_product_store_imports_no_retrieval_policy():
    import inspect
    import shopeechat.product_store as ps
    src = inspect.getsource(ps)
    assert "retrieval_policy" not in src


def test_publication_maps_owned_by_product_store():
    import shopeechat.product_store as ps
    assert ps.PUBLISH_STATE["unlisted"] == "unpublished"
    assert ps.PUBLISH_STATE["discontinued"] == "deleted"
    assert ps.PUBLISH_RANK["published"] > ps.PUBLISH_RANK["deleted"]
    # retrieval_policy consume owner เดียวกัน — ค่าต้องตรงกันเสมอ
    from shopeechat.retrieval_policy import make_evidence_card as _m
    c = _m({"status": "UNLIST", "customer_visible": False,
            "catalog_status": "unlisted"}, source="unit")
    assert c["publish_state"] == ps.PUBLISH_STATE["unlisted"]


def test_visible_sibling_of_unlist_continues():
    # identity เดียวกัน: UNLIST (hidden) + NORMAL visible → ใช้ visible เท่านั้น
    vis = _unlist_card(item_id="x2", name="สายชาร์จ WPB100L",
                     status="NORMAL", catalog_status="active",
                     customer_visible=True, _available_for_sale=True,
                     availability_reason="normal_positive_stock",
                     total_stock=3)
    hid = _unlist_card(item_id="x2", unit_id="u2")
    sel = _select([vis, hid], _req(types=("cable",), codes=("WPB100L",)))
    assert not getattr(sel, "hidden_mentions", ())
    ids = {s.card.get("item_id") for s in sel.selected}
    assert ids == {"x2"}
    for s in sel.selected:
        assert s.card["customer_visibility"] == "visible"


# ── D) current listing precedence in dedupe ──────────────────────────────────

def test_dedupe_active_current_outranks_deleted_stale():
    # active OOS (current listing) ต้องชนะ deleted stale stock=100
    from shopeechat.product_store import _dedupe_sell_score
    cur_oos = {"status": "NORMAL", "total_stock": 0,
               "catalog_status": "out_of_stock", "customer_visible": True,
               "price": {"min": 100, "max": 100}}
    deleted_stale = {"status": "SELLER_DELETE", "total_stock": 100,
                     "catalog_status": "discontinued",
                     "customer_visible": True, "price": {"min": 50, "max": 50}}
    assert _dedupe_sell_score(cur_oos) > _dedupe_sell_score(deleted_stale)


def test_dedupe_hidden_never_outranks_visible():
    from shopeechat.product_store import _dedupe_sell_score
    cur = {"status": "NORMAL", "total_stock": 0,
           "catalog_status": "out_of_stock", "customer_visible": True,
           "price": {}}
    hid = {"status": "UNLIST", "total_stock": 999,
           "catalog_status": "unlisted", "customer_visible": False,
           "price": {"min": 1, "max": 1}}
    assert _dedupe_sell_score(cur) > _dedupe_sell_score(hid)
