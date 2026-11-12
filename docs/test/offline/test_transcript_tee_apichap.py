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
            for t in turns:
                if t.get("vision_desc") is not None:
                    desc = t["vision_desc"]
                    mp.setattr(_llm, "describe_images",
                               lambda *a, **k: (desc,
                                                {"prompt": 0, "output": 0}))
                resp = app.chat(app.ChatRequest(
                    message=t["msg"], shop=shop, platform="shopee",
                    images=list(t.get("images") or ()),
                    item_id=t.get("item_id"),
                    history=list(hist),
                    conversation_id=conversation_id, limit=5,
                    simulate_assignment=True,
                    test_source="customer-answer-quality"))
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
    """typed AnswerContext ของ turn ที่ n (answer_typed calls ตามลำดับ)."""
    calls = [c for c in captured.calls if c["fn"] == "answer_typed"]
    return calls[n_turn - 1]["context"] if len(calls) >= n_turn else None


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
    assert len(resp.products or ()) <= 1
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
    if ctx is not None:
        # image identity ไม่ authorize compat verdict — decided claim ต้อง
        #   มาจาก typed evidence เท่านั้น
        for v in (ctx.compat_verdicts or ()):
            assert v.target and "4 lite" in v.target.lower()
    # candidates ต้อง bound กับหลักฐาน compatibility เท่านั้น → ≤1
    assert len(resp.products or ()) <= 1, (
        f"Q3 attach {len(resp.products or ())} products (guessing)")
    ans = resp.answer or ""
    assert ans.count("|||\n**") <= 1


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
    assert prof.get("fact_sources", {}).get("target_device") == "history"
    ctx = _ctx_of(captured, 4)
    if ctx is not None:
        for t in ctx.task.tasks:
            if t.target:
                assert "4 lite" in str(t.target).lower(), (
                    f"Q4 target หล่น: {t.target!r}")
        # ไม่ลืมบริบทภาพ → ไม่ควร clarify-ว่างที่ถามว่าสินค้าตัวไหน
    assert "ตัวไหน" not in (resp.answer or ""), (
        "Q4 ลืม visual target — ถามว่าสินค้าตัวไหนทั้งที่เครื่องอยู่ในภาพ")
