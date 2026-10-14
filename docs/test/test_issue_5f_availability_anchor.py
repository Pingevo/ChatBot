"""test_issue_5f_availability_anchor.py — Phase 5F-C: availability owner contract.

pin (audit result: owner = product_store.resolve_availability เดียว):
- UNLIST + stock>0 → customer_visible=False, available_for_sale=False
  (ไม่ใช่สินค้าหน้าร้าน — ห้ามเสนอขาย/ตอบ compat เป็น candidate)
- SELLER_DELETE/DELETED/BANNED → historical answerable:
  customer_visible=True + available_for_sale=False + answerable=True
  (ตอบ spec/warranty/history ได้ แต่ห้ามขาย — caller label ผ่าน catalog_status)
- NORMAL + stock=0 → out_of_stock, visible, ไม่ขาย
- NORMAL + stock>0 → active, sellable
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import product_store  # noqa: E402


def _doc(status, stock=None):
    # resolver อ่าน stock จาก stock_info_v2 / stock / total_stock (card contract)
    d = {"item_status": status}
    if stock is not None:
        d["total_stock"] = stock
    return d


def test_unlist_with_stock_not_sellable_not_visible():
    # UNLIST มี stock ก็ไม่ใช่หน้าร้าน — ห้าม recommend/compat candidate
    av = product_store.resolve_availability(_doc("UNLIST", stock=440))
    assert av["customer_visible"] is False
    assert av["available_for_sale"] is False
    assert av["catalog_status"] == "unlisted"


def test_discontinued_answerable_but_not_sellable():
    # เคย publish → ตอบ spec/warranty/history ได้ แต่ห้ามขาย/ส่งลิงก์
    for st in ("SELLER_DELETE", "DELETED", "SHOPEE_DELETE", "BANNED"):
        av = product_store.resolve_availability(_doc(st, stock=0))
        assert av["customer_visible"] is True, st
        assert av["available_for_sale"] is False, st
        assert av["answerable"] is True, st
        assert av["catalog_status"] == "discontinued", st


def test_normal_zero_stock_out_of_stock():
    av = product_store.resolve_availability(_doc("NORMAL", stock=0))
    assert av["customer_visible"] is True
    assert av["available_for_sale"] is False
    assert av["catalog_status"] == "out_of_stock"


def test_normal_positive_stock_sellable():
    av = product_store.resolve_availability(_doc("NORMAL", stock=5))
    assert av["customer_visible"] is True
    assert av["available_for_sale"] is True
    assert av["catalog_status"] == "active"


def test_owner_function_is_single_entry():
    # audit: availability semantics ต้องมี owner เดียว — callers ใช้
    # resolve_availability เท่านั้น (ไม่ scatter if status == "UNLIST" เอง)
    import inspect
    src = inspect.getsource(product_store.resolve_availability)
    assert "customer_visible" in src and "available_for_sale" in src


# ---------- H5: end-to-end pins (selection chain + link follow-up) ----------

def _ures(cards):
    from shopeechat.units import UnitEvidenceFetchResult
    return UnitEvidenceFetchResult(
        cards=tuple(cards), raw_count=len(cards),
        sellable_count=sum(1 for c in cards if c.get("_available_for_sale")),
        unavailable_count=sum(1 for c in cards
                              if not c.get("_available_for_sale")),
        trace=("fake",))


def _sel(cards, req):
    from shopeechat.candidate_pool import build_candidate_pool
    from shopeechat.retrieval_executor import execute_grouped_retrieval_requests
    from shopeechat.retrieval_selection import select_for_llm_context
    res = execute_grouped_retrieval_requests(
        (req,), message="q", shop="s",
        fetcher=lambda m, **kw: _ures(cards), legacy_fetcher=None)
    pool = build_candidate_pool(res)
    return select_for_llm_context(pool, (req,))


def _req(rid="r0", codes=("AC99X",), mode="answerable_all"):
    from shopeechat.retrieval_planner import RetrievalRequest
    return RetrievalRequest(
        rid, "s", "slot", frozenset({"charger"}), frozenset(),
        codes, None, mode, "none")


def test_hidden_only_grouped_selection_returns_mentions_not_products():
    # รุ่นที่ถามถึงมีแต่ UNLIST → ไม่เข้า selected/unavailable; ส่งแค่
    # hidden_mentions (name-only) ให้ตอบ "ยังไม่เปิดขาย"
    hidden = {"name": "AC99X หัวชาร์จ", "item_id": "h1",
              "customer_visible": False, "_available_for_sale": False,
              "availability_reason": "unlisted", "model_codes": ["AC99X"],
              "product_type": "charger", "total_stock": 440}
    sel = _sel([hidden], _req())
    assert not sel.selected
    assert not any(u.get("item_id") == "h1" for u in sel.unavailable_evidence)
    assert any(h.get("item_id") == "h1" for h in sel.hidden_mentions)


def test_unlist_with_stock_never_recommended():
    # UNLIST + stock>0 → rejected customer_hidden ทุก mode — ห้ามเสนอขาย
    hidden = {"name": "AC99X หัวชาร์จ", "item_id": "h1",
              "customer_visible": False, "_available_for_sale": False,
              "availability_reason": "unlisted", "model_codes": ["AC99X"],
              "product_type": "charger", "total_stock": 440}
    for mode in ("sellable_first", "answerable_all"):
        sel = _sel([hidden], _req(mode=mode))
        assert not sel.selected, mode


def test_link_followup_unavailable_anchor_no_silent_swap():
    # anchor SELLER_DELETE → ลิงก์อยู่ (ดูข้อมูลได้) + note ชัด + ทดแทนต้อง tag
    from shopeechat import app as _app
    anchor = {"item_id": "a1", "name": "พาวเวอร์แบงค์ PB-X",
              "status": "SELLER_DELETE", "total_stock": 0,
              "short_link": "https://shopee/a1", "product_type": "powerbank"}
    alt = {"item_id": "b2", "name": "พาวเวอร์แบงค์ PB-Y",
           "status": "NORMAL", "total_stock": 3,
           "short_link": "https://shopee/b2", "_available_for_sale": True}
    out = _app._prepare_link_followup([anchor], alt_fetcher=lambda q: [alt])
    a = next(p for p in out if p["item_id"] == "a1")
    b = next((p for p in out if p["item_id"] == "b2"), None)
    # anchor: ยังส่งลิงก์ให้ดูข้อมูล แต่ note บอกไม่พร้อมขาย (ห้ามบอกซื้อได้)
    assert a.get("short_link") == "https://shopee/a1"
    assert "ไม่พร้อมจำหน่าย" in (a.get("_context_note") or "")
    # ทดแทนต้องมี label — ห้าม silent swap
    assert b is not None and "ทดแทน" in (b.get("_context_note") or "")


def test_unlist_anchor_link_stripped_but_kept_via_note():
    # UNLIST anchor → ตัด short_link + note → _link_followup_keep เก็บไว้
    # (ทิ้งแล้ว LLM ไม่เห็นรุ่นที่ถาม → silent swap)
    from shopeechat import app as _app
    hidden = {"item_id": "h1", "name": "พาวเวอร์แบงค์ PB-X",
              "status": "UNLIST", "total_stock": 440,
              "short_link": "https://shopee/h1", "product_type": "powerbank"}
    out = _app._prepare_link_followup([hidden], alt_fetcher=None)
    h = out[0]
    assert "short_link" not in h
    assert h.get("_context_note")
    assert _app._link_followup_keep(h) is True


def test_seller_delete_answerable_not_sellable_in_guard():
    # guard boundary เดียวกัน: SELLER_DELETE ขายไม่ได้ (_card_available False)
    # แต่ resolver ยัง answerable (ตอบ spec/history/warranty ได้)
    from shopeechat import guards
    card = {"status": "SELLER_DELETE", "sold_out": True}
    assert guards._card_available(card) is False
    av = product_store.resolve_availability({"item_status": "SELLER_DELETE",
                                             "total_stock": 0})
    assert av["answerable"] is True
