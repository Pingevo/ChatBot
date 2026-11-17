"""test_blackshark_claim_regression.py — BlackShark claim/vision/handoff regression (RED).

Behavioral pins for defects observed in conversation shp_2914916050682852821
(23-turn shadow replay): symptom image → fan upsell, symptom text parsed as
customer name, item card sold during open claim, repeated admin-wait text,
image unread because post-handoff lock ran before vision, order SN bound to
wrong-shop fallback.

Each test asserts the contract the fix must satisfy — they FAIL on current
code (some via signature evolution: decide_turn must accept typed
image_desc evidence for the current turn).

Boundary: offline only — no Mongo, no LLM, no network.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))

import dotenv as _dotenv  # noqa: E402

_orig_load_dotenv = _dotenv.load_dotenv
_dotenv.load_dotenv = lambda *a, **k: False
try:
    from shopeechat import warranty, warranty_flow, order_store  # noqa: E402
    from shopeechat import turn_decision as td  # noqa: E402
    import shopeechat.app as _app_mod  # noqa: E402
    from shopeechat import kb_zaapi_files as zkf  # noqa: E402
    from shopeechat import conversation_products as _cp  # noqa: E402
finally:
    _dotenv.load_dotenv = _orig_load_dotenv
    _app_ref = sys.modules.get("shopeechat.app")
    if _app_ref is not None:
        _app_ref.load_dotenv = _orig_load_dotenv
    _kb_ref = sys.modules.get("shopeechat.knowledge_base")
    if _kb_ref is not None:
        _kb_ref.load_dotenv = _orig_load_dotenv

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════════════════
# A. Current-turn image is primary evidence (Q1/Q5)
# ══════════════════════════════════════════════════════════════════════

def test_symptom_image_routes_to_claim_not_product():
    """Q1: image-only turn whose vision desc shows a damaged screen must
    produce claim/troubleshoot handling — never a product-selling need."""
    plan = td.decide_turn(
        "[รูปภาพ]",
        has_visual_media=True,
        image_desc="นาฬิกาสมาร์ทวอทช์สีดำ หน้าจอแสดงผลผิดปกติ "
                   "มีรอยด่างสีเขียวและสีขาว ปุ่ม HOME และ MODE",
    )
    assert plan.needs, "media turn must not be silently dropped"
    kinds = {(n.kind, n.operation) for n in plan.needs}
    assert ("product", "describe") not in kinds and not any(
        k == "product" for k, _ in kinds), (
        f"symptom image must not become a product need: {kinds}")
    assert any(k in ("claim", "troubleshoot") for k, _ in kinds), (
        f"symptom image must yield claim/troubleshoot need: {kinds}")


def test_unreadable_current_image_asks_not_sells():
    """Current image that could not be described → the turn must ask for
    info / acknowledge the unreadable image — a product/describe need fed
    by stale history evidence is forbidden."""
    plan = td.decide_turn(
        "[รูปภาพ]",
        has_visual_media=True,
        image_desc="",          # vision ran, produced nothing
    )
    kinds = {(n.kind, n.operation) for n in plan.needs}
    assert ("product", "describe") not in kinds, (
        f"unreadable image must not default to product/describe: {kinds}")
    assert plan.primary_action in ("clarify", "execute_needs")


def test_normal_product_image_stays_product():
    """Negative control: a normal (undamaged) product image with no claim
    context still produces the usual describe/browsing need."""
    plan = td.decide_turn(
        "[รูปภาพ]",
        has_visual_media=True,
        image_desc="นาฬิกาสมาร์ทวอทช์ Black Shark GS3 สีดำ สภาพปกติ "
                   "วางบนโต๊ะ",
    )
    assert any(n.kind == "product" for n in plan.needs)


def test_history_image_desc_does_not_hijack_text_question():
    """Negative control: a new text question must be answered by its own
    semantics even when history carries image_desc."""
    plan = td.decide_turn(
        "สายชาร์จราคาเท่าไหร่ครับ",
        history=[{"role": "user", "text": "",
                  "image_desc": "นาฬิกาสมาร์ทวอทช์จอเสีย"}],
    )
    assert plan.needs and all(n.kind != "claim" for n in plan.needs)
    assert any(n.kind in ("product", "price", "policy") for n in plan.needs)


def test_media_during_open_claim_still_collects():
    """Control: media while claim collecting keeps binding to the claim."""
    plan = td.decide_turn(
        "[รูปภาพ]",
        has_visual_media=True,
        image_desc="รอยดำที่หน้าจอนาฬิกา",
        claim_state={"stage": "collecting", "episode_id": "e1"},
    )
    assert any(n.kind == "claim" for n in plan.needs)


# ══════════════════════════════════════════════════════════════════════
# B. Claim field extraction (Q3)
# ══════════════════════════════════════════════════════════════════════

def test_symptom_sentence_is_not_customer_name():
    """Q3: 'จอเป็นแบบนี้สะแล้ว' is a symptom statement, never a name."""
    assert warranty.extract_customer_info("จอเป็นแบบนี้สะแล้ว")["name"] == ""


def test_real_name_still_extracted():
    """Control: genuine names must survive the same parser."""
    assert warranty.extract_customer_info("ชื่อสมชาย ใจดี")["name"] == "สมชาย ใจดี"


# ══════════════════════════════════════════════════════════════════════
# C. Item card during open claim (Q4)
# ══════════════════════════════════════════════════════════════════════

def test_item_card_during_open_claim_is_evidence_not_sale():
    """Q4: an item card while claim is collecting identifies the claimed
    product — it must bind as claim evidence, not emit a selling need."""
    plan = td.decide_turn(
        "[สินค้า: 25064823709]",
        claim_state={"stage": "collecting", "episode_id": "e1"},
    )
    assert plan.needs, "item card must still be understood"
    for n in plan.needs:
        assert n.kind != "product", (
            f"selling need {n.kind}/{n.operation} forbidden during open claim")
    assert any(n.kind == "claim" for n in plan.needs), (
        f"item card should bind to claim: {[(n.kind, n.operation) for n in plan.needs]}")


def test_item_card_without_claim_still_browses():
    """Negative control: card + question with no open claim stays a product turn."""
    plan = td.decide_turn("ตัวนี้มีสีอื่นไหมครับ",
                          tag_item_ids=("25064823709",))
    assert plan.needs


# ══════════════════════════════════════════════════════════════════════
# D. Post-handoff turn semantics (Q6–Q23)
# ══════════════════════════════════════════════════════════════════════

def test_post_handoff_order_sn_binds_as_claim_info():
    """Q9/Q10: an order SN after handoff is supplemental claim info —
    needs must be extracted (claim/collect), not collapsed to human_wait."""
    plan = td.decide_turn(
        "260913VD3Q4RAC",
        ticket_state="handoff",
        claim_state={"stage": "collecting", "episode_id": "e1"},
    )
    assert plan.ownership == "human"
    assert plan.needs, "supplemental claim info must not be dropped"
    assert any(n.kind == "claim" for n in plan.needs)


def test_post_handoff_status_question_is_claim_status():
    """Q17/Q20/Q21: 'ตรวจสอบยังครับ' after handoff asks claim status —
    a claim-status need, not a generic human_wait."""
    plan = td.decide_turn("ตรวจสอบยังครับ", ticket_state="handoff")
    assert plan.ownership == "human"
    assert plan.needs, "status question must be answered, not parked"
    assert any(n.kind == "claim" for n in plan.needs)


def test_post_handoff_answerable_question_evaluated():
    """A new product question during handoff is still answerable —
    needs extracted, ownership stays human (no re-handoff)."""
    plan = td.decide_turn("มีสายชาร์จ type c ไหมครับ", ticket_state="handoff")
    assert plan.ownership == "human"
    assert plan.needs
    assert any(n.kind == "product" for n in plan.needs)


def test_post_handoff_pure_noise_still_waits():
    """Control: a message carrying no need keeps waiting for the human."""
    plan = td.decide_turn("โอเคครับ", ticket_state="handoff")
    assert plan.ownership == "human"
    if plan.primary_action == "human_wait":
        assert not plan.needs


# ══════════════════════════════════════════════════════════════════════
# E. Handoff dedupe + transport truth
# ══════════════════════════════════════════════════════════════════════

def _req(msg, **kw):
    base = dict(message=msg, conversation_id="c1", platform="shopee",
                shop="BlackShark", ticket_state=None, simulate_assignment=True,
                item_id=None, order_sn=None, images=None, history=None,
                claim_outcome=None)
    base.update(kw)
    return SimpleNamespace(**base)


def test_claim_supplemental_does_not_repost_handoff(monkeypatch):
    """Supplemental info on an open claim that was already handed off must
    bind fields but not POST handoff again (duplicate-attempt guard)."""
    calls = []
    monkeypatch.setattr(_app_mod, "_send_handoff",
                        lambda *a, **k: calls.append(k) or {
                            "outcome": {"state": "assigned"}})
    monkeypatch.setattr(_cp, "load_claim_state",
                        lambda *a, **k: {"stage": "collecting",
                                         "episode_id": "e1"})
    merged = {}
    monkeypatch.setattr(_cp, "merge_claim_fields",
                        lambda *a, **k: merged.update(k.get("fields") or {})
                        or {"stage": "collecting", "episode_id": "e1"})
    monkeypatch.setattr(_cp, "transition_claim_state",
                        lambda *a, **k: k.get("claim_state")
                        or {"stage": "collecting", "episode_id": "e1"})
    req = _req("260913VD3Q4RAC")
    history = [
        {"role": "user", "text": "สินค้าเสียครับ"},
        {"role": "model", "text": "รบกวนรอการติดต่อกลับจากแอดมินอีกครั้งนะคะ"},
    ]
    out = warranty_flow.handle_warranty_flow(req, {"total_start": 0.0},
                                           history, db=None)
    if out is not None:
        # bound info may persist, but no second POST once already handed off
        assert not calls, f"duplicate handoff POST: {calls}"


# ══════════════════════════════════════════════════════════════════════
# F. Order lookup shop boundary (Q9)
# ══════════════════════════════════════════════════════════════════════

class _OrderColl:
    """find_one honours only queries that carry the requested shopname."""
    def __init__(self, doc):
        self.doc = doc
        self.queries = []

    def find_one(self, query):
        self.queries.append(query)
        if "shopname" in query and query["shopname"] != self.doc.get("shopname"):
            return None
        if query.get("order_sn") == self.doc.get("order_sn"):
            return self.doc
        return None


def test_order_lookup_never_crosses_shop(monkeypatch):
    """lookup_order must not fall back to an unscoped query — an order SN
    belonging to another shop returns None, not the other shop's order."""
    coll = _OrderColl({"order_sn": "260913VD3Q4RAC", "shopname": "OtherShop",
                       "item_list": [], "package_list": []})
    monkeypatch.setattr(order_store, "_get_order_collection", lambda: coll)
    out = order_store.lookup_order("260913VD3Q4RAC", shop_filter="BlackShark")
    assert out is None, "cross-shop order must not be returned"
    assert all("shopname" in q for q in coll.queries), (
        f"unscoped fallback query observed: {coll.queries}")


def test_order_lookup_same_shop_still_found(monkeypatch):
    """Control: in-scope order still resolves normally."""
    coll = _OrderColl({"order_sn": "260913VD3Q4RAC", "shopname": "BlackShark",
                       "item_list": [{"item_name": "Black Shark GS3 / GS3 Ultra",
                                      "model_name": "GS3 (Black)",
                                      "item_id": "25064823709.0",
                                      "model_quantity_purchased": 1}],
                       "package_list": []})
    monkeypatch.setattr(order_store, "_get_order_collection", lambda: coll)
    out = order_store.lookup_order("260913VD3Q4RAC", shop_filter="BlackShark")
    assert out and out["items"][0]["model_name"] == "GS3 (Black)"


# ══════════════════════════════════════════════════════════════════════
# G. Zaapi KB identity boundary (GS3 vs GS3 Ultra)
# ══════════════════════════════════════════════════════════════════════

_F017 = "017 - ประกันรายรุ่น.xlsx"


@pytest.fixture
def kb_db(monkeypatch):
    """Memory db + gate/pairs stubbed to admit only file-017 rev-1 rows."""
    from test_zaapi_kb_files import MemoryDb  # noqa: E402
    db = MemoryDb()
    monkeypatch.setattr(zkf, "_zaapi_files_allowed", lambda: True)
    monkeypatch.setattr(zkf, "_visible_pairs",
                        lambda *a, **k: ([{"source_file": _F017,
                                           "file_rev": 1}], 1))
    return db


def test_gs3_refs_never_match_gs3_ultra_rows(kb_db):
    """refs for 'black shark gs3 smart watch' must not admit the Ultra row —
    exact subject intersection, no substring leak."""
    rows = []
    for i, (subj, txt) in enumerate([
            (["black shark gs3 smart watch"], "Black Shark GS3 รับประกัน 1 ปี"),
            (["black shark gs3 ultra smart watch"], "Black Shark GS3 Ultra รับประกัน 1 ปี")]):
        d = {"source_file": _F017, "file_rev": 1,
             "sheet": "s", "row_index": i, "kind": "xlsx_row",
             "subject_refs": subj, "text": txt,
             "accounts": ["BlackShark"], "platforms": ["shopee"],
             "fields": {}, "cells": {}}
        d["subject_digest"] = zkf._subject_digest(d)
        rows.append(d)
    kb_db[zkf._COLL].docs.extend(rows)
    hits, _ = zkf.zaapi_search(
        kb_db, shop="BlackShark", platform="shopee",
        query="รับประกันกี่ปี", refs=("black shark gs3 smart watch",))
    assert hits, "in-scope GS3 warranty row must be found"
    for h in hits:
        subs = " ".join(str(s) for s in (h.get("subject_refs") or [])).lower()
        assert "ultra" not in subs, (
            f"GS3 Ultra row leaked into GS3 identity: {h}")
