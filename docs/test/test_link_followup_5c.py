"""test_link_followup_5c.py — Task 5C-D: LINK-FOLLOWUP availability safety.

pin:
- anchor UNLIST-only → ตัด short_link + note ยังไม่เปิดขาย + fetch ทดแทน type เดียวกัน
- anchor NORMAL stock=0/discontinued → note สถานะตรงๆ ลิงค์ดูข้อมูลได้
- anchor sellable → ไม่เปลี่ยนพฤติกรรมเดิม
- alternatives tag 'ทดแทน' เสมอ — ห้าม silent swap
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import app  # noqa: E402


def _card(status="NORMAL", stock=5, name="X", link="https://shopee/x"):
    return {"item_id": "i1", "name": name, "status": status,
            "total_stock": stock, "short_link": link,
            "product_type": "powerbank"}


def _alt(name="ALT powerbank"):
    return {"item_id": "alt1", "name": name, "status": "NORMAL",
            "total_stock": 9, "short_link": "https://shopee/alt",
            "_available_for_sale": True}


def test_unlist_anchor_loses_link_gets_note_and_alts():
    hidden = _card(status="UNLIST", name="WPB100L powerbank")
    calls = []

    def fetcher(q):
        calls.append(q)
        return [_alt()]

    out = app._prepare_link_followup([hidden], alt_fetcher=fetcher)
    anchor = out[0]
    assert anchor.get("short_link") is None            # ห้ามส่งลิงค์ของที่ไม่ publish
    assert "ยังไม่" in (anchor.get("_context_note") or "")
    # ทุกตัวไม่ขาย → fetch ทดแทน
    assert calls
    alts = out[1:]
    assert alts and all("ทดแทน" in (a.get("_context_note") or "") for a in alts)


def test_oos_visible_anchor_keeps_link_with_status_note():
    dead = _card(status="NORMAL", stock=0, name="AC65B charger")
    out = app._prepare_link_followup([dead],
                                     alt_fetcher=lambda q: [_alt()])
    assert out[0].get("short_link")                    # ลิงค์ดูข้อมูลได้
    assert "ไม่พร้อม" in (out[0].get("_context_note") or "")
    assert any("ทดแทน" in (a.get("_context_note") or "") for a in out[1:])


def test_sellable_anchor_unchanged_no_alt_fetch():
    ok = _card(name="A18T charger")
    called = []

    def fetcher(q):
        called.append(q)
        return [_alt()]

    out = app._prepare_link_followup([ok], alt_fetcher=fetcher)
    assert len(out) == 1
    assert out[0].get("short_link")                    # link อยู่
    assert not out[0].get("_context_note")             # ไม่มี warning note
    assert not called                                  # ไม่ fetch ทดแทน


def test_mixed_anchor_sellable_plus_hidden():
    ok = _card(name="A18T charger", link="https://shopee/ok")
    hid = _card(status="UNLIST", name="WPB100L powerbank",
                link="https://shopee/hid")
    hid["item_id"] = "i2"
    called = []

    def fetcher(q):
        called.append(q)
        return [_alt()]

    out = app._prepare_link_followup([ok, hid], alt_fetcher=fetcher)
    by_name = {p["name"]: p for p in out}
    assert by_name["A18T charger"].get("short_link")
    assert by_name["WPB100L powerbank"].get("short_link") is None
    assert not called            # มีของขายได้แล้ว → ไม่ fetch เพิ่ม


def test_input_not_mutated():
    src = [_card(status="UNLIST", name="WPB100L")]
    out = app._prepare_link_followup(src, alt_fetcher=lambda q: [])
    assert src[0].get("short_link")                    # original untouched
    assert out[0].get("short_link") is None


def test_note_only_hidden_anchor_survives_caller_filter():
    # regression hardening: caller กรอง card ด้วย short_link/image_url —
    # hidden anchor ที่เหลือแต่ note ต้องรอดผ่าน predicate เดียวกับที่ caller ใช้
    # ไม่งั้น LLM ไม่เห็นรุ่นที่ถาม → silent swap
    hidden = _card(status="UNLIST", name="hidden-anchor", link=None)
    hidden["image_url"] = ""
    prepared = app._prepare_link_followup([hidden], alt_fetcher=lambda q: [])
    assert "short_link" not in prepared[0] and not prepared[0].get("image_url")
    kept = [p for p in prepared if app._link_followup_keep(p)]
    assert len(kept) == 1
    assert "ไม่มีจำหน่าย" in kept[0]["_context_note"]
