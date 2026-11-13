"""Phase 1 correction — executable repro of the tee_apichap transcript.

4-turn flow (Task A — RED only, no production change):
  Q1 "[item]" (item-share ของไส้กรอง) → ≤1 product/card
  Q2 "มีไส้กรองใส่กับรุ่น 6 ได้มั้ยครับ" (device กำกวม) → ไม่เดา/ไม่แนบ
  Q3 "[รูปภาพ]" เครื่องฟอกอากาศ (vision อ่านรุ่นได้) → device เป็น compat
     target; evidence-bound candidates เท่านั้น; ≤1 card
  Q4 "รุ่นนี้ครับ" → visual target เดิมต้องยังอยู่

assertions ตรง contract ที่ต้องการ — failure แต่ละจุดระบุ root cause.
"""

from pathlib import Path
import sys
import tempfile

import pytest
from _pytest.monkeypatch import MonkeyPatch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "live"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from test_legacy_turn_incident_replay import _install, ADMIN_DB  # noqa: E402
from shopeechat import app  # noqa: E402
from shopeechat import llm as _llm  # noqa: E402


SHOP = "tee_apichap"
CID = "tee-4turn"


def _doc(item_id, name, codes, ptype="filter", price=390.0):
    return {"item_id": item_id, "item_name": name, "item_status": "NORMAL",
            "shopname": SHOP, "cat_name": ptype, "product_type": ptype,
            "condition": "new", "gen_price": price,
            "short_link": f"https://s.shopee.co.th/{item_id}",
            "image": {"image_url_list": ["https://img.example/i.jpg"],
                      "image_id_list": ["img1"]},
            "description": name,
            "model": [{"name": c, "price": price,
                       "model_status": "MODEL_NORMAL",
                       "stock_info_v2": {"summary_info": {
                           "total_available_stock": 5}}}
                      for c in codes] or [],
            "tier_variation": [], "standardise_tier_variation": [],
            "model_codes": list(codes)}


CATALOG = [
    # item-share Q1 — listing เดียวหลาย variant (Q1 transcript: 3 cards
    #   มี short_link เดียวกัน 2 ใบ)
    _doc("9001", "iSUPER ไส้กรอง HEPA สำหรับ Xiaomi Air Purifier 4 Lite",
         ("FLT-4L-BLUE", "FLT-4L-GRAY")),
    _doc("9002", "iSUPER ไส้กรอง HEPA สำหรับ Xiaomi Air Purifier 2S 3H Pro",
         ("FLT-2S-MED",)),
    _doc("9003", "iSUPER Cartridge Hygienic Filter H13 สำหรับ Xiaomi 4 Lite",
         ("FLT-4L-H13",)),
]


def _multi_turn(turns, *, catalog=CATALOG, shop=SHOP, conversation_id=CID):
    """N turns ใน conversation เดียวกัน — FakeDb persistence จริง.
    turn dict: msg, intent_result, item_id, images, vision_desc.
    คืน (resps, captured, admindb)."""
    mp = MonkeyPatch()
    fx = {"id": conversation_id, "shop": shop, "platform": "shopee",
          "conversation_id": conversation_id,
          "catalog": catalog,
          "turns": [{"text": t["msg"],
                     "intent_result": t.get("intent_result")}
                    for t in turns],
          "llm_reply": "",
          "runtime_flags": {"grouped_selection": True}}
    with tempfile.TemporaryDirectory():
        client, captured, _ = _install(mp, fx)
        admindb = client[ADMIN_DB]
        hist = []
        resps = []
        try:
            # per-turn call slice — answer_typed call-order ≠ turn เมื่อ
            #   deterministic path ไม่เรียก LLM (guard ctx ผูก turn ถูก)
            captured.turn_slices = []
            for t in turns:
                if t.get("vision_desc") is not None:
                    desc = t["vision_desc"]
                    mp.setattr(_llm, "describe_images",
                               lambda *a, **k: (desc,
                                                {"prompt": 0, "output": 0}))
                _pre = len(captured.calls)
                resp = app.chat(app.ChatRequest(
                    message=t["msg"], shop=shop, platform="shopee",
                    images=list(t.get("images") or ()),
                    item_id=t.get("item_id"),
                    history=list(hist),
                    conversation_id=conversation_id, limit=5,
                    simulate_assignment=True,
                    test_source="customer-answer-quality"))
                captured.turn_slices.append((_pre, len(captured.calls)))
                resps.append(resp)
                # ChatMessage serialization contract — client persists
                #   images + image_desc (vision cache) บน user message เดิม
                hist.append({"role": "user", "text": t["msg"],
                             "images": list(t.get("images") or ()),
                             "image_desc": getattr(resp, "image_desc", "")
                             or ""})
                hist.append({"role": "model",
                             "text": getattr(resp, "answer", "") or ""})
        finally:
            mp.undo()
        return resps, captured, admindb


def _ctx_of(captured, n_turn):
    """typed AnswerContext ของ turn ที่ n — เฉพาะ answer_typed calls ที่
    เกิดใน slice ของ turn นั้น (deterministic 0-call turn → None)."""
    slices = getattr(captured, "turn_slices", None)
    if not slices or n_turn > len(slices):
        return None
    start, end = slices[n_turn - 1]
    typed = [c for c in captured.calls[start:end]
             if c["fn"] == "answer_typed"]
    return typed[0]["context"] if typed else None


TURNS = [
    {"msg": "[item]", "item_id": "9001",
     "intent_result": {"intent": "product_spec", "confidence": 0.9,
                       "needs_description": True}},
    {"msg": "มีไส้กรองใส่กับรุ่น 6 ได้มั้ยครับ",
     "intent_result": {"intent": "compatibility_check", "confidence": 0.9,
                       "relation_target": "รุ่น 6"}},
    {"msg": "[รูปภาพ]", "images": ["https://img.example/purifier.jpg"],
     # vision_desc ต้องผ่าน `_dc._device_candidates` extractor เดิม —
     #   regex ปัจจุบันไม่ match ผ่าน "รุ่น" (ไม่แก้ extraction ตาม budget);
     #   "Xiaomi Air Purifier 4 Lite" = output จริงที่ extractor รับ
     "vision_desc": "เครื่องฟอกอากาศ Xiaomi Air Purifier 4 Lite",
     "intent_result": {"intent": "compatibility_check", "confidence": 0.9}},
    {"msg": "รุ่นนี้ครับ",
     "intent_result": {"intent": "product_question", "confidence": 0.9,
                       "subject_scope": "current_single"}},
]


def test_q1_item_share_shows_at_most_one_product_and_card():
    resps, captured, _ = _multi_turn(TURNS[:1])
    resp = resps[0]
    assert len(resp.products or ()) <= 1, (
        f"Q1 attach {len(resp.products or ())} products")
    ans = resp.answer or ""
    assert ans.count("|||\n**") <= 1, "Q1 แนบ card prose หลายใบ"


def test_q2_ambiguous_device_does_not_guess_or_attach_many():
    resps, captured, _ = _multi_turn(TURNS[:2])
    resp = resps[1]
    # Task 8 — non-vacuous: typed artifact ต้องมีจริง + 0 cards + ไม่มี
    #   decided verdict + unresolved compat outcome อยู่ใน composition
    assert not (resp.products or ()), (
        f"Q2 attach cards โดยไม่มี typed proof: {resp.products}")
    # Task 8 — non-vacuous: Q2 = deterministic 0-call path → serialized
    #   composition คือ typed artifact ของ turn นี้ (ctx ไม่ถูก expose)
    comp = (resp.routing_decision or {}).get("composition") or {}
    assert "compat" not in (comp.get("domains") or ()), (
        f"Q2 ต้องไม่มี decided compat result: {comp}")
    assert comp.get("unanswered"), (
        f"Q2 ต้องมี unresolved need marker — {comp}")
    ctx = _ctx_of(captured, 2)
    if ctx is not None:
        for v in (ctx.compat_verdicts or ()):
            assert v.decision.outcome not in (
                "compatible", "incompatible"), (
                "รุ่น 6 กำกวม — ห้าม decided verdict โดยไม่มีหลักฐาน")


def test_q3_visual_device_becomes_compat_target_with_single_evidence_bound():
    resps, captured, _ = _multi_turn(TURNS[:3])
    resp = resps[2]
    ctx = _ctx_of(captured, 3)
    # device ในภาพต้องเป็น typed target_device (compat-target slot —
    #   retrieval/clarification context เท่านั้น ไม่ใช่ sellable product /
    #   compat authorization); approved mechanism = profile image_desc
    #   merge → ตรวจที่ profile step + provenance stamp
    prof = next((s["output"] for s in (resp.steps or ())
                 if s.get("name") == "RetrievalProfile"), {})
    assert "4 lite" in str(prof.get("target_device") or "").lower(), (
        f"visual device ไม่เข้า typed target_device: {prof}")
    assert prof.get("fact_sources", {}).get("target_device") == "image_desc"
    # Task 8 — non-vacuous: ctx อาจเป็น None บน deterministic 0-call path
    #   → assert ที่ composition marker + steps (typed artifacts ที่มีจริง)
    if ctx is not None:
        # image identity ไม่ authorize compat verdict — decided claim ต้อง
        #   มาจาก typed evidence เท่านั้น
        for v in (ctx.compat_verdicts or ()):
            assert v.target and "4 lite" in v.target.lower()
    comp = (resp.routing_decision or {}).get("composition") or {}
    assert "compat" not in (comp.get("domains") or ()), (
        f"Q3 ต้องไม่มี decided compat result: {comp}")
    assert comp.get("unanswered"), (
        f"Q3 ต้องมี unresolved need marker (image ≠ proof): {comp}")
    # candidates ต้อง bound กับหลักฐาน compatibility เท่านั้น → 0
    assert not (resp.products or ()), (
        f"Q3 attach {len(resp.products or ())} products (guessing)")
    ans = resp.answer or ""
    assert ans.count("|||\n**") <= 1
    assert "ไม่สามารถยืนยัน" in ans or "ไม่มีข้อมูล" in ans, (
        f"Q3 ต้องเป็น cannot-confirm ไม่ใช่ positive claim: {ans!r}")


def test_q4_this_model_retains_visual_target():
    resps, captured, _ = _multi_turn(TURNS)
    resp = resps[3]
    # visual target จาก image_desc ที่ persist ใน history (turn 3) ต้อง
    #   ไหลเข้า profile.target_device ของ turn 4 (source="history" —
    #   retrieval/clarification context เท่านั้น)
    prof = next((s["output"] for s in (resp.steps or ())
                 if s.get("name") == "RetrievalProfile"), {})
    assert "4 lite" in str(prof.get("target_device") or "").lower(), (
        f"Q4 visual target หล่น — historical image_desc ไม่ถูกอ่าน: {prof}")
    assert prof.get("fact_sources", {}).get(
        "target_device") == "history_image_desc"
    ctx = _ctx_of(captured, 4)
    if ctx is not None:
        for t in ctx.task.tasks:
            if t.target:
                assert "4 lite" in str(t.target).lower(), (
                    f"Q4 target หล่น: {t.target!r}")
        # ไม่ลืมบริบทภาพ → ไม่ควร clarify-ว่างที่ถามว่าสินค้าตัวไหน
    # Task 8 — non-vacuous: 0 cards (image ≠ compat proof) + ไม่มี compat
    #   domain result ที่ claim verdict + ไม่มี positive endorsement
    assert not (resp.products or ()), (
        f"Q4 attach cards จาก history-image target โดยไม่มี proof: "
        f"{resp.products}")
    comp = (resp.routing_decision or {}).get("composition") or {}
    assert "compat" not in (comp.get("domains") or ()), (
        f"Q4 ต้องไม่มี decided compat result: {comp}")
    assert "ตัวไหน" not in (resp.answer or ""), (
        "Q4 ลืม visual target — ถามว่าสินค้าตัวไหนทั้งที่เครื่องอยู่ในภาพ")


# ── Task 1 — exact item-share contract (acceptance) ─────────────────────────
#  item ที่ลูกค้าแชร์ resolve ได้ตรงตัว + scope ถูก + sellable → card เดียว
#  ของ item นั้นเท่านั้น (ห้าม sibling/substitute); resolve ไม่ได้/wrong
#  shop/unsellable → 0 cards ตรงๆ

def test_task1_exact_item_share_returns_exact_card():
    resps, _, _ = _multi_turn(TURNS[:1])
    ids = [str(p.get("item_id")) for p in (resps[0].products or ())]
    assert ids == ["9001"], (
        f"Q1 exact shared item ต้องได้ card เดียวของ item นั้น — got {ids}")


def test_task1_item_share_never_substitutes_sibling():
    # catalog มี sibling filter listings (9002/9003) — ห้ามแทนที่ exact item
    resps, _, _ = _multi_turn(TURNS[:1])
    ids = {str(p.get("item_id")) for p in (resps[0].products or ())}
    assert ids <= {"9001"}, f"sibling หลุดมา: {ids}"


def test_task1_unresolvable_item_returns_zero_cards():
    # item_id ไม่มีใน catalog เลย — resolve ไม่ได้ → 0 cards ตรงๆ ห้ามเดา/
    #   substitute (fetch_product_by_id มี documented cross-shop fallback
    #   เป็น owner contract อยู่แล้ว — boundary ที่ทดสอบคือ "ไม่เจอจริง")
    resps, _, _ = _multi_turn(
        [dict(TURNS[0], item_id="999999")])
    assert not (resps[0].products or ()), resps[0].products


def test_task1_unsellable_item_returns_zero_cards():
    # item unlisted → ไม่ sellable → 0 cards (ไม่ substitute ด้วยตัวอื่น)
    cat = [dict(CATALOG[0], item_status="UNLIST")] + CATALOG[1:]
    resps, _, _ = _multi_turn([dict(TURNS[0])], catalog=cat)
    assert not (resps[0].products or ()), resps[0].products


SHOP_B = "other_shop_x"


def test_task1_cross_shop_item_share_returns_zero_cards():
    # ลูกค้าร้าน A (SHOP) ส่ง item_id ที่มีเฉพาะในร้าน B — ห้ามคืน card ร้าน B
    catalog = CATALOG + [dict(_doc("7777", "Cross-Shop Only Item", ("XB-1",)),
                             shopname=SHOP_B)]
    resps, _, _ = _multi_turn([dict(TURNS[0], item_id="7777")],
                             catalog=catalog)
    assert not (resps[0].products or ()), resps[0].products


def test_task1_same_item_id_resolves_own_shop():
    # item_id ชนกัน 2 ร้าน — ต้องได้ doc ของร้านตัวเอง (A) ไม่ใช่ B
    catalog = CATALOG + [dict(_doc("9001", "B SHOP FILTER 9001", ("XB-9",)),
                             shopname=SHOP_B)]
    resps, _, _ = _multi_turn(TURNS[:1], catalog=catalog)
    names = [str(p.get("name") or p.get("item_name") or "")
             for p in (resps[0].products or ())]
    assert any("iSUPER" in n for n in names), names
    assert not any("B SHOP" in n for n in names), names


def test_task1_fetch_product_by_id_scoped_only():
    """unit: `fetch_product_by_id` ห้าม retry unscoped และห้าม lookup
    เมื่อไม่มี shop_filter (fail-closed) — item ที่มีเฉพาะร้าน B ต้อง None"""
    from mongo_doubles import FakeDb
    from shopeechat import product_store as _ps
    mp = MonkeyPatch()
    try:
        mp.setenv("MONGO_COLLECTION", "ShpProducts")
        db = FakeDb({"ShpProducts": [
            dict(_doc("7777", "B Item", ("X",)), shopname=SHOP_B)]})
        assert _ps.fetch_product_by_id(
            db, "7777", shop_filter=SHOP) is None
        assert _ps.fetch_product_by_id(db, "7777") is None
    finally:
        mp.undo()


def test_task1_rebuild_card_scoped_to_entry_shop():
    """timeline card rebuild ต้อง scope ร้านจาก stored card — entry
    item_id ชนกับ doc ร้าน B → คืน stored card ไม่ใช่ rebuild จากร้าน B"""
    from mongo_doubles import FakeClient, FakeDb
    from shopeechat import conversation_products as cp
    from shopeechat import product_store as ps
    mp = MonkeyPatch()
    try:
        mp.setenv("MONGO_DB", "shopdb")
        mp.setenv("MONGO_COLLECTION", "ShpProducts")
        proddb = FakeDb({"ShpProducts": [
            dict(_doc("7777", "B Item", ("X",)), shopname=SHOP_B)]})
        mp.setattr(ps, "_cached_client", FakeClient({"shopdb": proddb}))
        cp._LIVE_CARD_CACHE.clear()
        entry = {"item_id": "7777",
                 "card": {"item_id": "7777", "name": "STORED-A",
                          "shop": SHOP}}
        out = cp._materialize_card(entry, snap=None)
        assert (out or {}).get("name") == "STORED-A", out
    finally:
        cp._LIVE_CARD_CACHE.clear()
        mp.undo()


# ── Task 1 (independent review) — timeline tenant isolation ──────────────
#  Timeline identity = (platform, shop, conversation_id): ทุก read/write/
#  CAS/materialize ต้องใช้ scope เดียวกัน — doc ของร้าน A ห้ามไหลเข้า B
#  (cache key, conv-id reads, unit refresh, stored fallback)

_TEN_CID = "tenant-collide-conv"


def _tenant_seed():
    """conversation_products doc ของ shop A (มี shop/platform field จริง)."""
    return {
        "conversation_id": _TEN_CID,
        "platform": "shopee",
        "shop": SHOP,
        "products": [{
            "item_id": "5555", "model_id": None,
            "model_name": "M-A", "name": "A Product",
            "source": "user_item_card", "is_anchor": True,
            "card": {"item_id": "5555", "name": "A Product Card",
                     "shop": SHOP},
        }],
        "active_item_id": "5555",
        "order_anchors": [{"order_sn": "ORDER-A"}],
        "active_order_sn": "ORDER-A",
        "claim_state": {"episode_id": "epA", "stage": "collecting",
                        "customer_name": "A-Customer"},
    }


def _bind_cp_coll(mp, docs):
    from mongo_doubles import FakeDb
    from shopeechat import conversation_products as cp
    admindb = FakeDb({"conversation_products": list(docs)})
    mp.setattr(cp, "_coll", lambda: admindb["conversation_products"])
    return admindb


def test_tenant_timeline_read_scoped():
    """load_timeline / get_subject_set / claim / order อ่านด้วย shop B
    บน doc ของ shop A → fail closed (ห้ามอ่าน doc คนละ tenant)."""
    from shopeechat import conversation_products as cp
    mp = MonkeyPatch()
    try:
        _bind_cp_coll(mp, [_tenant_seed()])
        for label, val in [
            ("load_timeline", cp.load_timeline(
                _TEN_CID, platform="shopee", shop=SHOP_B)),
            ("get_subject_set.products",
             cp.get_subject_set(
                 _TEN_CID, platform="shopee", shop=SHOP_B).products),
            ("load_claim_state", cp.load_claim_state(
                _TEN_CID, platform="shopee", shop=SHOP_B)),
            ("get_active_order_sn", cp.get_active_order_sn(
                _TEN_CID, platform="shopee", shop=SHOP_B)),
            ("get_anchor_history", cp.get_anchor_history(
                _TEN_CID, platform="shopee", shop=SHOP_B)),
        ]:
            assert not val, f"{label} อ่าน doc ร้าน A ด้วย scope B: {val!r}"
        # scope ตรง → อ่านได้ตามเดิม
        assert cp.load_timeline(
            _TEN_CID, platform="shopee", shop=SHOP) is not None
        assert cp.get_subject_set(
            _TEN_CID, platform="shopee", shop=SHOP).products
        assert cp.load_claim_state(
            _TEN_CID, platform="shopee", shop=SHOP) is not None
    finally:
        mp.undo()


def test_tenant_timeline_write_scoped():
    """save_timeline/add_order_anchor/record_subject_set/claim CAS ของ B
    ห้ามเขียนทับ doc ของ A (และห้ามสร้าง state ปนกัน)."""
    from shopeechat import conversation_products as cp
    mp = MonkeyPatch()
    try:
        db = _bind_cp_coll(mp, [_tenant_seed()])
        coll = db["conversation_products"]
        cp.save_timeline(_TEN_CID, "shopee", SHOP_B,
                         [{"item_id": "9", "name": "B Prod"}], "9")
        cp.add_order_anchor(_TEN_CID, "shopee", SHOP_B, "ORDER-B")
        cp.transition_claim_state(
            _TEN_CID, "shopee", SHOP_B,
            expected_episode_id=None, expected_stage=None,
            claim_state={"episode_id": "epB", "stage": "collecting"})
        ss = cp.decide_subject_set(None, explicit_ids=("9",))
        assert ss is not None
        cp.record_subject_set(_TEN_CID, ss, expected_prior=None,
                              platform="shopee", shop=SHOP_B)
        # doc ของ A ต้องไม่ถูกแตะเลย
        a_doc = next(d for d in coll._docs if d.get("shop") == SHOP)
        assert a_doc["active_item_id"] == "5555"
        assert a_doc["order_anchors"] == [{"order_sn": "ORDER-A"}]
        assert a_doc["claim_state"]["customer_name"] == "A-Customer"
        assert "subject_set" not in a_doc
        assert all(d.get("name") != "B Prod"
                   for d in a_doc.get("products", []))
        # B ต้องมี doc ของตัวเอง (หรือ write ล้ม fail-closed ไม่ทับ A)
        b_doc = next((d for d in coll._docs if d.get("shop") == SHOP_B),
                     None)
        if b_doc is not None:
            assert b_doc["conversation_id"] == _TEN_CID
            assert b_doc["claim_state"]["episode_id"] == "epB"
            assert b_doc["active_order_sn"] == "ORDER-B"
    finally:
        mp.undo()


def _legacy_seed():
    """doc ที่เขียนก่อนมี tenant stamping — ไม่มี shop/platform field."""
    return {
        "conversation_id": _TEN_CID,
        "products": [{"item_id": "A100", "name": "Legacy Prod",
                      "source": "legacy", "is_anchor": True,
                      "card": {"item_id": "A100", "name": "Legacy Card",
                               "shop": SHOP}}],
        "active_item_id": "A100",
        "subject_set": {"product_ids": ["A100"]},
        "claim_state": {"episode_id": "epL", "stage": "collecting"},
        "order_anchors": [{"order_sn": "ORDER-LEG"}],
        "active_order_sn": "ORDER-LEG",
    }


def test_tenant_legacy_unscoped_doc_never_serves_scoped_request():
    """Final-blocker Task 1: doc ที่ไม่มี shop/platform field = legacy —
    scoped request (ทุก shop/platform) ห้ามอ่านมันเด็ดขาด; `$in:[x,None,""]`
    เดิมทำให้ legacy doc เป็น wildcard tenant ของทุกคน."""
    from shopeechat import conversation_products as cp
    mp = MonkeyPatch()
    try:
        _bind_cp_coll(mp, [_legacy_seed()])
        for scope in [("shopee", SHOP), ("shopee", SHOP_B),
                      ("lazada", SHOP)]:
            plat, shop = scope
            for label, val in [
                ("load_timeline", cp.load_timeline(
                    _TEN_CID, platform=plat, shop=shop)),
                ("get_subject_set.products",
                 cp.get_subject_set(
                     _TEN_CID, platform=plat, shop=shop).products),
                ("load_claim_state", cp.load_claim_state(
                    _TEN_CID, platform=plat, shop=shop)),
                ("get_active_order_sn", cp.get_active_order_sn(
                    _TEN_CID, platform=plat, shop=shop)),
                ("get_anchor_history", cp.get_anchor_history(
                    _TEN_CID, platform=plat, shop=shop)),
            ]:
                assert not val, (
                    f"{label} scoped({scope}) อ่าน legacy doc: {val!r}")
    finally:
        mp.undo()


def test_tenant_unscoped_request_cannot_read_scoped_doc():
    """Contract C: caller ไม่มี scope → ห้ามคืน scoped customer timeline
    แบบ global; legacy doc ที่ unscoped เหมือนกันอ่านได้ (internal owner
    contract — scoped doc เท่านั้นที่ห้ามรั่ว)."""
    from shopeechat import conversation_products as cp
    mp = MonkeyPatch()
    try:
        _bind_cp_coll(mp, [_tenant_seed()])
        for label, val in [
            ("load_timeline", cp.load_timeline(_TEN_CID)),
            ("get_subject_set.products",
             cp.get_subject_set(_TEN_CID).products),
            ("load_claim_state", cp.load_claim_state(_TEN_CID)),
            ("get_active_order_sn", cp.get_active_order_sn(_TEN_CID)),
            ("get_anchor_history", cp.get_anchor_history(_TEN_CID)),
        ]:
            assert not val, f"{label} unscoped req อ่าน scoped doc: {val!r}"
    finally:
        mp.undo()


def test_tenant_platform_mismatch_read_fails_closed():
    """doc platform=shopee shop=A → request platform อื่น ห้ามอ่านได้."""
    from shopeechat import conversation_products as cp
    mp = MonkeyPatch()
    try:
        _bind_cp_coll(mp, [_tenant_seed()])
        assert cp.load_timeline(
            _TEN_CID, platform="lazada", shop=SHOP) is None
        assert not cp.get_subject_set(
            _TEN_CID, platform="lazada", shop=SHOP).products
        assert cp.load_claim_state(
            _TEN_CID, platform="lazada", shop=SHOP) is None
    finally:
        mp.undo()


def test_tenant_scoped_write_does_not_claim_legacy_doc():
    """Scoped write ห้าม stamp/ทับ legacy unscoped doc — update filter ที่
    match legacy = claim มันเป็น doc ของ tenant ใหม่เงียบๆ."""
    from shopeechat import conversation_products as cp
    mp = MonkeyPatch()
    try:
        db = _bind_cp_coll(mp, [_legacy_seed()])
        coll = db["conversation_products"]
        cp.save_timeline(_TEN_CID, "shopee", SHOP_B,
                         [{"item_id": "9", "name": "B Prod"}], "9")
        ss = cp.decide_subject_set(None, explicit_ids=("9",))
        assert ss is not None
        cp.record_subject_set(_TEN_CID, ss, expected_prior=None,
                              platform="shopee", shop=SHOP_B)
        leg = next(d for d in coll._docs
                   if d.get("active_item_id") == "A100"
                   or d.get("subject_set", {}).get("product_ids")
                   == ["A100"])
        # legacy doc ต้องไม่ถูก stamp scope ใหม่ และไม่ถูกเขียนทับเนื้อหา
        assert "shop" not in leg and "platform" not in leg, (
            f"scoped write ไป stamp legacy doc: {leg!r}")
        assert leg["products"][0]["name"] == "Legacy Prod"
        assert leg["claim_state"]["episode_id"] == "epL"
    finally:
        mp.undo()


def test_tenant_live_card_cache_includes_shop():
    """_LIVE_CARD_CACHE identity ต้องมี shop/platform — A materialize ก่อน
    แล้ว B materialize item_id+model เดียวกันโดยไม่ clear cache →
    B ห้ามได้ card ของ A."""
    from mongo_doubles import FakeClient, FakeDb
    from shopeechat import conversation_products as cp
    from shopeechat import product_store as ps
    mp = MonkeyPatch()
    try:
        mp.setenv("MONGO_DB", "shopdb")
        mp.setenv("MONGO_COLLECTION", "ShpProducts")
        proddb = FakeDb({"ShpProducts": [
            dict(_doc("5555", "A Live Card", ("X",)), shopname=SHOP),
            dict(_doc("5555", "B Live Card", ("X",)), shopname=SHOP_B)]})
        mp.setattr(ps, "_cached_client", FakeClient({"shopdb": proddb}))
        cp._LIVE_CARD_CACHE.clear()
        a = cp._materialize_card(
            {"item_id": "5555", "model_name": "M",
             "card": {"item_id": "5555", "name": "A snap", "shop": SHOP}},
            snap=None)
        b = cp._materialize_card(
            {"item_id": "5555", "model_name": "M",
             "card": {"item_id": "5555", "name": "B snap",
                      "shop": SHOP_B}},
            snap=None)
        assert (b or {}).get("name") != (a or {}).get("name"), (
            f"cache คืน card ร้าน A ให้ร้าน B: {b!r}")
        assert (b or {}).get("shop") == SHOP_B or \
            (b or {}).get("name") == "B snap", b
    finally:
        cp._LIVE_CARD_CACHE.clear()
        mp.undo()


def test_tenant_materialize_cache_and_fallback_scope():
    """materialize_subject_cards: cache ข้ามร้านห้าม reuse; stored fallback
    ที่ shop ไม่ตรง request scope ต้องไม่ถูก reuse; scope ตรง reuse ได้."""
    from mongo_doubles import FakeDb
    from shopeechat import conversation_products as cp
    mp = MonkeyPatch()
    try:
        proddb = FakeDb({"ShpProducts": [
            dict(_doc("5555", "A Live Card", ("X",)), shopname=SHOP),
            dict(_doc("5555", "B Live Card", ("X",)), shopname=SHOP_B)]})
        b_entries = [{"item_id": "5555", "model_name": "M",
                      "is_anchor": True,
                      "card": {"item_id": "5555", "name": "B snap",
                               "shop": SHOP_B}}]
        a_entries = [{"item_id": "5555", "model_name": "M",
                      "is_anchor": True,
                      "card": {"item_id": "5555", "name": "A snap",
                               "shop": SHOP}}]
        cp._LIVE_CARD_CACHE.clear()
        # A materialize live card ก่อน → cache ถูกเติมด้วย card ของ A
        a_cards = cp.materialize_subject_cards(
            proddb, ("5555",), products=a_entries,
            shop_filter=SHOP, snap=None)
        assert a_cards and a_cards[0].get("name") == "A Live Card", a_cards
        # B ต่อโดยไม่ clear cache → live B card เท่านั้น ห้ามได้ A cache
        b_cards = cp.materialize_subject_cards(
            proddb, ("5555",), products=b_entries,
            shop_filter=SHOP_B, snap=None)
        assert b_cards and all(
            (c.get("name") or "") != "A snap" for c in b_cards), (
            f"B ได้ cache/stored ของ A: {b_cards}")
        assert b_cards[0].get("name") == "B Live Card", (
            f"cache key ไม่มี shop → B ได้ card ของ A: {b_cards}")
        # entry card ของ A + request scope B → stored snapshot ห้าม reuse;
        #   live scoped doc ของ B ต้องชนะ
        foreign = cp.materialize_subject_cards(
            proddb, ("5555",), products=a_entries,
            shop_filter=SHOP_B, snap=None)
        assert foreign and all(
            (c.get("name") or "") != "A snap" for c in foreign), (
            f"stored A snapshot reuse ผ่าน scope B: {foreign}")
        assert foreign[0].get("name") == "B Live Card", foreign
    finally:
        cp._LIVE_CARD_CACHE.clear()
        mp.undo()


def test_task4_image_only_history_entry_survives():
    """Task 4 — user entry ที่ text ว่าง (image-only turn) แต่มี persisted
    image_desc ต้องยัง yield device; early-continue เดิมข้ามทั้ง entry
    ทำให้ visual target หล่นจากทั้ง facts และ profile provenance."""
    from shopeechat.route_context import (
        _bounded_history_facts, build_retrieval_profile)
    d = "เครื่องฟอกอากาศ Xiaomi Air Purifier 4 Lite"
    facts = _bounded_history_facts(
        [{"role": "user", "text": "", "image_desc": d}])
    assert facts["device"], (
        f"image-only history device หล่น: {facts}")
    # entry ที่มี text ปกติต้องทำงานเหมือนเดิม + text ชนะ image_desc
    facts2 = _bounded_history_facts([
        {"role": "user", "text": "ใช้กับ iPhone 13 ได้ไหม",
         "image_desc": d}])
    assert facts2["device"] and "iphone" in facts2["device"].lower(), (
        f"text device ต้องชนะ image_desc: {facts2}")
    # profile level: image-only history + follow-up → target_device +
    #   history_image_desc provenance (visual ≠ compat authorization)
    prof = build_retrieval_profile(
        "รุ่นนี้ครับ",
        history=[{"role": "user", "text": "", "image_desc": d}],
        intent_result={"intent": "product_question"},
        shop="x", platform="shopee")
    assert prof.target_device, (
        f"profile target หล่นเมื่อ history entry เป็น image-only: "
        f"{prof.fact_sources}")
    assert dict(prof.fact_sources).get(
        "target_device") == "history_image_desc", (
        f"provenance ต้องเป็น history_image_desc: {prof.fact_sources}")


def test_tenant_desc_item_docs_scoped():
    """_desc_item_docs rehydrate ต้อง scope shop — item_id ชนกันข้ามร้าน
    → dict keyed by item_id last-write-wins คืน doc ร้านอื่น."""
    from mongo_doubles import FakeClient, FakeDb
    from shopeechat import product_store as ps
    mp = MonkeyPatch()
    try:
        mp.setenv("MONGO_DB", "shopdb")
        mp.setenv("MONGO_COLLECTION", "ShpProducts")
        # B doc อยู่ท้าย list → unscoped rehydrate last-write-wins = B
        proddb = FakeDb({"ShpProducts": [
            dict(_doc("5555", "A Item", ("X",)), shopname=SHOP),
            dict(_doc("5555", "B Item", ("X",)), shopname=SHOP_B)]})
        mp.setattr(ps, "_cached_client", FakeClient({"shopdb": proddb}))
        docs = ps._desc_item_docs([5555], shop=SHOP)
        assert docs.get("5555", {}).get("shopname") == SHOP, (
            f"rehydrate ไม่ scope → ได้ doc ร้าน B: {docs}")
        docs_b = ps._desc_item_docs([5555], shop=SHOP_B)
        assert docs_b.get("5555", {}).get("shopname") == SHOP_B, docs_b
    finally:
        mp.undo()


def test_tenant_rebuild_unit_query_scoped():
    """unit refresh ต้อง scope shop — listing ของ A + unit doc ของ B
    (item_id+model ชน) → ห้ามดึง unit ของ B มาเป็น card ของ A."""
    from mongo_doubles import FakeClient, FakeColl, FakeDb
    from shopeechat import conversation_products as cp
    from shopeechat import product_store as ps
    from shopeechat import units as _u
    mp = MonkeyPatch()
    try:
        mp.setenv("MONGO_DB", "shopdb")
        mp.setenv("MONGO_COLLECTION", "ShpProducts")
        proddb = FakeDb({"ShpProducts": [
            dict(_doc("5555", "A Listing", ("X",)), shopname=SHOP)]})
        mp.setattr(ps, "_cached_client", FakeClient({"shopdb": proddb}))
        mp.setattr(_u, "_units_coll",
                   lambda snap=None: FakeColl([
                       {"item_id": 5555, "model_name": "M",
                        "shop": SHOP_B, "model_id": 1, "price": 1,
                        "stock": 1, "display_name": "B UNIT"}]))
        mp.setattr(_u, "attach_kb_specs", lambda docs, snap=None: docs)
        mp.setattr(_u, "attach_image_texts",
                   lambda docs, snap=None: docs)
        cp._LIVE_CARD_CACHE.clear()
        out = cp._rebuild_card(
            {"item_id": "5555", "model_name": "M",
             "card": {"item_id": "5555", "shop": SHOP,
                      "variants": [{"name": "M"}]}}, snap=None)
        # ต้องไม่ใช้ unit ของ B — fallback เป็น listing card ของ A
        assert out is not None
        assert out.get("shop") == SHOP or out.get("name") == "A Listing", out
    finally:
        cp._LIVE_CARD_CACHE.clear()
        mp.undo()


# ── Task 2 — anonymous compat-only: 0 cards + cannot-confirm ────────────────
#  compat ask เปล่า (target กำกวม/ไม่มี typed proof) + ไม่มี independent
#  product need → ไม่แนบ candidates; no_evidence ≠ incompatible

def test_task2_compat_only_turn_emits_no_cards():
    resps, captured, _ = _multi_turn(TURNS[:2])
    resp = resps[1]
    assert not (resp.products or ()), (
        f"Q2 แนบ card โดยไม่มี typed compat proof: {resp.products}")
    # deterministic path → composition คือ typed artifact; decided
    #   verdict จะ render compat-domain segment — ต้องไม่มี
    comp = (resp.routing_decision or {}).get("composition") or {}
    assert "compat" not in (comp.get("domains") or ()), (
        f"ต้องไม่มี decided compat result: {comp}")
    ctx = _ctx_of(captured, 2)
    if ctx is not None:
        for v in (ctx.compat_verdicts or ()):
            assert v.decision.outcome not in (
                "compatible", "incompatible"), (
                "ต้องไม่มี decided verdict เมื่อไม่มีหลักฐาน")


def test_task2_compat_only_renders_one_cannot_confirm_segment():
    # compat + anonymous describe companion = logical ask เดียว →
    #   cannot-confirm segment เดียว (typed fold ตาม target_refs)
    resps, _, _ = _multi_turn(TURNS[:2])
    segs = [s for s in (resps[1].answer or "").split("\n\n") if s.strip()]
    assert len(segs) == 1, (
        f"Q2 cannot-confirm ต้อง render segment เดียว — got {segs}")


def test_task2_no_evidence_never_becomes_incompatible():
    resps, captured, _ = _multi_turn(TURNS[:2])
    comp = (resps[1].routing_decision or {}).get("composition") or {}
    for seg in (comp.get("segments") or ()):
        if seg.get("domain") == "compat":
            assert "ไม่เข้ากัน" not in (seg.get("text") or ""), (
                f"no_evidence render เป็น incompatible: {seg}")
    ctx = _ctx_of(captured, 2)
    if ctx is not None:
        for v in (ctx.compat_verdicts or ()):
            assert v.decision.outcome != "incompatible", (
                "no_evidence ห้าม render เป็น incompatible")


# ── Task 3 — visual target = retrieval/clarify context เท่านั้น ─────────────
#  image/history device identity ไม่ใช่ compat proof / endorsement →
#  ไม่มี typed verdict → 0 cards (target ยังคงอยู่ — ทดสอบใน Q3/Q4 เดิม)

def test_task3_image_target_no_verdict_emits_no_cards():
    resps, _, _ = _multi_turn(TURNS[:3])
    resp = resps[2]
    assert not (resp.products or ()), (
        f"Q3 แนบ card จาก visual context โดยไม่มี compat proof: "
        f"{resp.products}")


def test_task3_history_visual_target_no_verdict_emits_no_cards():
    # Q4 — visual target จาก history ยังอยู่ (pin ไว้ที่ test เดิม) แต่
    #   ไม่มี typed proof → 0 cards
    resps, _, _ = _multi_turn(TURNS)
    resp = resps[3]
    prof = next((s["output"] for s in (resp.steps or ())
                 if s.get("name") == "RetrievalProfile"), {})
    assert "4 lite" in str(prof.get("target_device") or "").lower(), (
        "premise: visual target ต้องยังอยู่ก่อนจะพิสูจน์ card contract")
    assert not (resp.products or ()), (
        f"Q4 แนบ card โดยไม่มี compat proof: {resp.products}")
