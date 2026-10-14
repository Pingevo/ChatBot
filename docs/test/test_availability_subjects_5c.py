"""test_availability_subjects_5c.py — Task 5C-A/C: UNLIST=customer_hidden +
unavailable compare subjects + substitute role semantics.

pin:
- resolve_availability → customer_visible=False เฉพาะ UNLIST/unknown status
- to_product_card/to_unit_card propagate customer_visible
- executor _bucket: customer_visible=False → rejected("customer_hidden")
- selection: code-matching unavailable-but-visible → role "subject" เข้า context
  (answerable_all mode) พร้อม availability label
- eligible ที่ไม่ match code → role "alternative" (ไม่ใช่ "สินค้าที่ถามถึง")
- UNLIST-only → ไม่ใช่ subject ไม่มี link — hidden mention เป็น name-level note
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import product_store, route_context  # noqa: E402
from shopeechat.units import UnitEvidenceFetchResult, to_unit_card  # noqa: E402
from shopeechat.retrieval_planner import build_grouped_retrieval_requests  # noqa: E402
from shopeechat.retrieval_executor import execute_grouped_retrieval_requests  # noqa: E402
from shopeechat.candidate_pool import build_candidate_pool  # noqa: E402
from shopeechat.retrieval_selection import select_for_llm_context  # noqa: E402
from shopeechat import retrieval_runtime  # noqa: E402


# ---------- resolver ----------

def _doc(status, stock=None):
    d = {"item_status": status, "item_name": "X"}
    if stock is not None:
        d["stock"] = stock
    return d


def test_customer_visible_flag():
    for st in ("NORMAL", "SELLER_DELETE", "DELETED", "SHOPEE_DELETE", "BANNED"):
        av = product_store.resolve_availability(_doc(st))
        assert av["customer_visible"] is True, st
    av = product_store.resolve_availability(_doc("UNLIST"))
    assert av["customer_visible"] is False
    assert av["available_for_sale"] is False
    # NORMAL stock=0 → visible historical (out_of_stock)
    av = product_store.resolve_availability(_doc("NORMAL", stock=0))
    assert av["customer_visible"] is True and av["catalog_status"] == "out_of_stock"


def test_card_carries_customer_visible():
    card = product_store.to_product_card(
        {"item_status": "UNLIST", "item_name": "X", "item_id": 1})
    assert card["customer_visible"] is False
    card = product_store.to_product_card(
        {"item_status": "NORMAL", "item_name": "X", "item_id": 2, "stock": 3})
    assert card["customer_visible"] is True


# ---------- pipeline helpers ----------

def _profile(msg, history=()):
    return route_context.build_retrieval_profile(
        msg, history=list(history), intent_result=None, shop="KingGadgets")


def _run(msg, unit_cards=(), legacy_cards=(), history=()):
    prof = _profile(msg, history)
    slots = route_context.build_retrieval_slots(prof)
    rels = route_context.build_retrieval_relations(prof, slots)
    reqs = build_grouped_retrieval_requests(prof, slots, rels)

    def units_fetcher(message, **kw):
        return UnitEvidenceFetchResult(
            cards=tuple(unit_cards), raw_count=len(unit_cards),
            sellable_count=sum(1 for c in unit_cards
                               if c.get("_available_for_sale")),
            unavailable_count=sum(1 for c in unit_cards
                                  if not c.get("_available_for_sale")),
            trace=("fake",))

    results = execute_grouped_retrieval_requests(
        reqs, message=msg, shop="KingGadgets",
        fetcher=units_fetcher,
        legacy_fetcher=lambda m, **kw: list(legacy_cards))
    pool = build_candidate_pool(results, profile=prof)
    sel = select_for_llm_context(pool, reqs, prof)
    return prof, reqs, results, pool, sel


def _unit(name, code, *, status="NORMAL", stock=5, item_id=None):
    """fake unit card — shape เหมือน to_unit_card output"""
    vis = status != "UNLIST"
    sell = status == "NORMAL" and stock > 0
    return {
        "name": name, "item_id": item_id or f"i-{code}",
        "unit_id": f"u-{code}-{name[-4:]}", "model_codes": [code],
        "product_type": "charger", "charger_subtype": "adapter",
        "status": status, "catalog_status": (
            "active" if sell else "unlisted" if status == "UNLIST"
            else "discontinued" if "DELETE" in status or status == "BANNED"
            else "out_of_stock"),
        "customer_visible": vis,
        "_available_for_sale": sell,
        "availability_reason": "test", "total_stock": stock,
    }


# ---------- A: customer_hidden bucketing ----------

def test_unlist_unit_never_eligible_even_if_stale_sellable():
    """UNLIST + sellable_units=True (stale) → ไม่เข้า eligible (live status ชนะ)"""
    c = _unit("WPB100L powerbank", "WPB100L", status="UNLIST", stock=440)
    prof, reqs, results, pool, sel = _run("สนใจ PB WPB100L", unit_cards=[c])
    assert not pool.eligible
    assert not any(s.card.get("item_id") == c["item_id"] for s in sel.selected)


def test_unlist_goes_rejected_customer_hidden():
    c = _unit("WPB100L powerbank", "WPB100L", status="UNLIST")
    prof, reqs, results, pool, sel = _run("WPB100L สเปค", unit_cards=[c])
    rej = [r for r in pool.rejected if r.item_id == c["item_id"]]
    assert rej and rej[0].reason == "customer_hidden"


def test_unlist_only_model_hidden_mention():
    """UNLIST-only model → mention ชื่อระดับ name เพื่อตอบ 'ยังไม่เปิดขาย' (ไม่ใช่ spec evidence)"""
    c = _unit("WPB100L powerbank", "WPB100L", status="UNLIST")
    prof, reqs, results, pool, sel = _run("สนใจ WPB100L", unit_cards=[c])
    names = [h.get("name") for h in getattr(sel, "hidden_mentions", ())]
    assert any("WPB100L" in (n or "") for n in names), sel


def test_visible_duplicate_preferred_over_unlist():
    """model เดียวกัน 2 listing: NORMAL stock=0 (visible) + UNLIST → subject ใช้ตัว visible"""
    vis = _unit("AD653C charger", "AD653C", status="NORMAL", stock=0,
                item_id="i-vis")
    hid = _unit("AD653C charger", "AD653C", status="UNLIST",
                item_id="i-hid")
    prof, reqs, results, pool, sel = _run("AD653C สเปคอะไรบ้าง",
                                        unit_cards=[vis, hid])
    subj_ids = [s.card.get("item_id") for s in sel.selected
                if s.role == "subject"]
    assert "i-vis" in subj_ids and "i-hid" not in subj_ids


# ---------- C: subject vs alternative ----------

def test_compare_unavailable_subjects_enter_context():
    """compare 2 codes ทั้งคู่ customer-visible แต่ไม่ขาย → ทั้งคู่เป็น subject พร้อม label"""
    a = _unit("CUKTECH AC65B GaN 65W", "AC65B", status="SELLER_DELETE",
              stock=0, item_id="i-ac65b")
    b = _unit("CUKTECH AC65B2 GaN 65W", "AC65B2", status="NORMAL",
              stock=0, item_id="i-ac65b2")
    alt = _unit("CUKTECH AD653T 65W", "AD653T", item_id="i-alt")
    prof, reqs, results, pool, sel = _run(
        "AC65B เทียบกับ AC65B2 ต่างกันยังไง", unit_cards=[a, b, alt])
    by_id = {s.card.get("item_id"): s for s in sel.selected}
    assert "i-ac65b" in by_id and "i-ac65b2" in by_id
    assert by_id["i-ac65b"].role == "subject"
    assert by_id["i-ac65b2"].role == "subject"
    # subject card ต้องพก availability label
    assert by_id["i-ac65b"].card.get("catalog_status") == "discontinued"
    assert by_id["i-ac65b"].card.get("_available_for_sale") is False


def test_substitute_tagged_alternative_not_subject():
    """ของที่ขายได้แต่ไม่ใช่รุ่นที่ถาม → role alternative (ห้ามแอบเป็น subject)"""
    a = _unit("CUKTECH AC65B GaN 65W", "AC65B", status="SELLER_DELETE",
              stock=0)
    alt = _unit("CUKTECH AD653T 65W", "AD653T", item_id="i-alt")
    prof, reqs, results, pool, sel = _run("AC65B สเปค", unit_cards=[a, alt])
    roles = {s.card.get("item_id"): s.role for s in sel.selected}
    assert roles.get("i-alt") == "alternative"


def test_unlist_compare_target_not_subject():
    """UNLIST-only target ของ compare → ไม่ใช่ subject (ห้าม spec/link evidence)"""
    a = _unit("CUKTECH AC65B GaN 65W", "AC65B", status="SELLER_DELETE",
              stock=0, item_id="i-ac65b")
    b = _unit("CUKTECH AC65B2 GaN 65W", "AC65B2", status="UNLIST",
              item_id="i-ac65b2")
    prof, reqs, results, pool, sel = _run(
        "AC65B เทียบกับ AC65B2 ต่างกันยังไง", unit_cards=[a, b])
    ids = [s.card.get("item_id") for s in sel.selected]
    assert "i-ac65b" in ids and "i-ac65b2" not in ids
    # แต่ชื่อต้องถูก mention เป็น hidden (ตอบ "ยังไม่เปิดขาย" ได้)
    assert any("AC65B2" in (h.get("name") or "")
               for h in getattr(sel, "hidden_mentions", ()))


def test_role_notes_in_runtime():
    """role note: subject=ถามถึงโดยตรง · alternative=ทดแทน · unavailable subject มีเตือน"""
    assert "ทดแทน" in retrieval_runtime._ROLE_NOTE.get("alternative", "")
    assert "ถามถึง" in retrieval_runtime._ROLE_NOTE.get("subject", "")


def test_price_followup_keeps_compare_subjects():
    """'ราคาเท่าไหร่' หลัง compare — codes จาก history → subjects ไม่หาย"""
    hist = [{"role": "user", "text": "AC65B เทียบกับ AC65B2 ต่างกันยังไง"}]
    a = _unit("CUKTECH AC65B GaN 65W", "AC65B", status="SELLER_DELETE",
              stock=0, item_id="i-ac65b")
    b = _unit("CUKTECH AC65B2 GaN 65W", "AC65B2", status="NORMAL", stock=0,
              item_id="i-ac65b2")
    prof, reqs, results, pool, sel = _run("ราคาเท่าไหร่", unit_cards=[a, b],
                                        history=hist)
    ids = [s.card.get("item_id") for s in sel.selected]
    assert "i-ac65b" in ids or "i-ac65b2" in ids


def test_hidden_only_grouped_selection_keeps_note():
    # regression hardening: ลูกค้าถามเฉพาะรุ่น UNLIST → sel.selected ว่าง
    # แต่ hidden_mentions มี → run_grouped_selection ต้องไม่คืน None
    # เพื่อให้ LLM ตอบ "ยังไม่เปิดขาย" แทนที่จะ fallback เส้นทางอื่นเงียบๆ
    hidden = _unit("WPB100L powerbank 20000mAh", "WPB100L", status="UNLIST")
    prof = _profile("สนใจพาวแบงก์ WPB100L")
    out = retrieval_runtime.run_grouped_selection(
        prof, message="สนใจพาวแบงก์ WPB100L", shop="KingGadgets",
        fetcher=lambda m, **kw: UnitEvidenceFetchResult(
            cards=(hidden,), raw_count=1, sellable_count=0,
            unavailable_count=0, trace=("fake",)),
        legacy_fetcher=lambda m, **kw: [])
    assert out is not None
    assert out["selected_cards"] == []
    assert "WPB100L" in (out["extra_context"] or "")
    assert "ยังไม่เปิดขาย" in out["extra_context"]


def test_model_not_normal_listing_normal_not_customer_visible():
    # listing NORMAL แต่ model_status ไม่ใช่ MODEL_NORMAL → variant นี้
    # ไม่ customer-visible (ไม่เทียบเท่า listing-level SELLER_DELETE ที่เคย publish)
    av = product_store.resolve_availability(
        {"item_status": "NORMAL"}, model_doc={"model_status": "MODEL_UNLIST"})
    assert av["customer_visible"] is False
    assert av["available_for_sale"] is False


def test_model_missing_unit_card_not_customer_visible():
    # unit snapshot มีข้อมูลแต่ model_id ไม่อยู่ใน live listing.models
    # → variant ไม่ customer-visible แม้ listing NORMAL
    u = {"unit_id": "u1", "unit_name": "hidden-variant", "stock": 5,
         "sellable": True, "model_id": "m1",
         "_listing": {"item_id": 1, "item_status": "NORMAL",
                      "model": [{"model_id": "m2", "name": "other-variant"}]}}
    card = to_unit_card(u)
    assert card["customer_visible"] is False
    assert card["availability_reason"] == "model_missing"
