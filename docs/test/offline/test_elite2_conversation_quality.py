"""nicechakrit conversation-quality repro — Elite2 two-item subject set,
image-only compat authorization, dangerous-symptom warranty flow.

Observed production failures being reproduced (all boundary-level, through
app.chat() with FakeDb persistence — no internal patching of behavior):

- Q1 item-card A → Q3 item-card B → Q4 cart image → Q5 "2 ตัวนี้ต่างกันไหม"
  must keep BOTH customer-sent cards as the compare subject set; the bot's
  own displayed products must not replace them.
- An image-described target is retrieval/clarification context only — it
  must not produce positive compat verdicts / product_verdicts.
- "กลิ่นไหม้/ควัน/ร้อนผิดปกติ" → safety instruction (stop use, unplug,
  do not retry charging) BEFORE claim info collection; the generic
  cable/charger/outlet checklist must not be used for dangerous symptoms;
  the claim handoff must actually be invoked.
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


SHOP = "KieslectThailand"
CID = "nicechakrit-replay"


def _doc(item_id, name, codes, ptype="smart_watch", price=4490.0):
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


ITEM_A = "43881222601"
ITEM_B = "46051234150"
CATALOG = [
    _doc(ITEM_A, "Kieslect AI Smartwatch Elite2 สมาร์ทวอทช์ จอ LTPO 2.0 "
                 "รองรับ GPS", ("ELITE2-BLK",)),
    _doc(ITEM_B, "Kieslect AI Smartwatch Elite2 สมาร์ทวอทช์ หน้าจอ LTPO 2.0 "
                 "มี GPS รับสาย", ("ELITE2-BLK2",)),
    _doc("48660568023", "Kieslect AI Smartwatch Elite2 Noir Edition "
                        "สมาร์ทวอทช์", ("ELITE2-NOIR",)),
    _doc("29269994156", "Kieslect สายนาฬิกาสเตนเลส 22 mm สำหรับ Actor / "
                        "Elite2", ("STRAP-22",), ptype="strap", price=479.0),
]


def _multi_turn(turns, *, catalog=CATALOG, shop=SHOP, conversation_id=CID):
    """Multi-turn app.chat() ใน conversation เดียวกัน (FakeDb จริง).
    คืน (resps, captured, admindb, handoff_calls)."""
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
        client, captured, handoff_calls = _install(mp, fx)
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
                    test_source="elite2-conv-quality"))
                resps.append(resp)
                hist.append({"role": "user", "text": t["msg"],
                             "images": list(t.get("images") or ()),
                             "image_desc": getattr(resp, "image_desc", "")
                             or ""})
                hist.append({"role": "model",
                             "text": getattr(resp, "answer", "") or ""})
        finally:
            mp.undo()
        return resps, captured, admindb, handoff_calls


def _subject_doc(admindb):
    doc = next((d for d in admindb["conversation_products"]._docs
                if d.get("conversation_id") == CID), None)
    return (doc or {}).get("subject_set") or {}


TURNS_1_3 = [
    {"msg": "[item]", "item_id": ITEM_A,
     "intent_result": {"intent": "product_spec", "confidence": 0.9,
                       "needs_description": True}},
    {"msg": "สวัสดีครับ",
     "intent_result": {"intent": "general", "confidence": 0.9}},
    {"msg": "[item]", "item_id": ITEM_B,
     "intent_result": {"intent": "product_spec", "confidence": 0.9,
                       "needs_description": True}},
]

TURN_Q4_IMAGE = {
    "msg": "[รูปภาพ]", "images": ["https://img.example/cart.jpg"],
    "vision_desc": "หน้าตะกร้าสินค้า Kieslect Thailand มีรายการ "
                   "Kieslect Elite2 สี Black สองรายการ",
    "intent_result": {"intent": "compatibility_check", "confidence": 0.9},
}

TURN_Q5_COMPARE = {
    "msg": "2 ตัวนี้คือตัวเดียวกันไหมครับ ต่างกันยังไง",
    "intent_result": {"intent": "product_compare", "confidence": 0.9,
                      "subject_scope": "current_set"},
}


def test_two_customer_item_cards_persist_as_compare_set():
    """Q1 card A → greeting → Q3 card B → subject set ต้องเป็น compare{A,B}
    (หลักฐาน item_card ต่อเนื่อง ไม่ใช่ single{B} ที่ทำให้ Q5 ถามการ์ดซ้ำ)."""
    resps, _, admindb, _ = _multi_turn(TURNS_1_3)
    ss = _subject_doc(admindb)
    assert set(map(str, ss.get("subject_ids") or ())) == {ITEM_A, ITEM_B}, (
        f"customer card pair หล่น — subject_set={ss}")
    assert ss.get("relation") == "compare", ss


ITEM_C = "48660568023"


def test_three_customer_cards_form_unpaired_set_not_compare():
    """3 การ์ดลูกค้า = ชุดหลายรายการที่ยังไม่ระบุคู่ — ห้าม relation=compare
    และ '2 ตัวนี้' บน 3 ใบต้องถามว่าหมายถึงคู่ไหน (ไม่เลือกเอง)."""
    turns = TURNS_1_3 + [
        {"msg": "[item]", "item_id": ITEM_C,
         "intent_result": {"intent": "product_spec", "confidence": 0.9,
                           "needs_description": True}},
        TURN_Q5_COMPARE,
    ]
    resps, _, admindb, _ = _multi_turn(turns)
    ss = _subject_doc(admindb)
    ids = set(map(str, ss.get("subject_ids") or ()))
    assert ids == {ITEM_A, ITEM_B, ITEM_C}, ss
    assert ss.get("relation") != "compare", (
        f"3 ใบห้ามเรียก compare pair — {ss}")
    resp = resps[-1]
    assert (resp.source or "") == "subject_clarify" or \
        "ตัวไหน" in (resp.answer or "") or "คู่ไหน" in (resp.answer or ""), (
            f"'2 ตัวนี้' บน 3 ใบต้องถามคู่ที่หมายถึง: {resp.answer!r}")


def test_bot_recommendation_breaks_card_chain():
    """bot suggestion (ops=recommend) แทรกระหว่างการ์ดลูกค้า → ตัด chain:
    card chain (ops=item_card) → recommend batch write (ops=recommend) →
    การ์ดใหม่ต้องเป็น single{new} ไม่ใช่ merge เข้า chain เดิม —
    bot products ไม่ใช่ customer evidence. (owner-level — FakeDb ไม่
    yield recommend batch ที่ app boundary)"""
    from shopeechat import conversation_products as cp
    card_chain = cp.ConversationSubjectSet(
        subject_ids=(ITEM_A,), source_turn_id=None, relation="single",
        requested_operations=("item_card",), confidence=1.0, rev=1)
    # recommend turn แสดง batch อื่น → alternatives{Noir} ops=recommend
    batch = cp.decide_subject_set(
        card_chain, selected_ids=("48660568023", "29269994156"),
        requested_operations=("recommend",))
    assert batch is not None and batch.relation == "alternatives", batch
    assert "recommend" in (batch.requested_operations or ()), batch
    # การ์ดใบถัดไป: persisted ops ไม่ใช่ item_card → chain ขาด → single{B}
    nxt = cp.decide_subject_set(
        batch, explicit_ids=(ITEM_B,), requested_operations=("item_card",))
    assert nxt is not None and list(nxt.subject_ids) == [ITEM_B] \
        and nxt.relation == "single", nxt


def test_duplicate_card_replay_is_idempotent():
    """ลูกค้าส่งการ์ดเดิมซ้ำ → subject set เดิม ไม่เปลี่ยน."""
    _, _, admindb, _ = _multi_turn(TURNS_1_3[:1] * 2)
    ss = _subject_doc(admindb)
    assert set(map(str, ss.get("subject_ids") or ())) == {ITEM_A}, ss


def test_display_batch_does_not_overwrite_customer_pair():
    """เทิร์นที่บอทแสดง products (describe/compat — ไม่ใช่ recommend จริง)
    ห้ามเขียน alternatives{batch} ทับ pair ของลูกค้า (Q4 observed bug)."""
    resps, _, admindb, _ = _multi_turn(TURNS_1_3 + [TURN_Q4_IMAGE])
    ss = _subject_doc(admindb)
    assert set(map(str, ss.get("subject_ids") or ())) == {ITEM_A, ITEM_B}, (
        f"display batch ทับ customer subject set — {ss}")


def test_q5_compare_answers_about_the_two_cards():
    """Q5 ต้องตอบเรื่องสองรายการจริง — ไม่ใช่ subject_clarify ที่ขอการ์ดซ้ำ
    และ products (ถ้ามี) ต้องอยู่ใน {A,B} เท่านั้น"""
    resps, _, _, _ = _multi_turn(
        TURNS_1_3 + [TURN_Q4_IMAGE, TURN_Q5_COMPARE])
    resp = resps[-1]
    assert (resp.source or "") != "subject_clarify", (
        f"Q5 ลืม pair — ถามการ์ดซ้ำ: {resp.answer!r}")
    from shopeechat import responses as _resp_mod
    assert (resp.answer or "") != _resp_mod.CLARIFY_REPLY
    ids = {str(p.get("item_id")) for p in (resp.products or ())}
    assert ids <= {ITEM_A, ITEM_B}, f"Q5 products หลุด pair: {ids}"
    assert not resp.products or len(ids) == 2, (
        f"Q5 ต้องครอบทั้งสองรายการ — products={ids} answer={resp.answer!r}")


def test_image_only_target_never_authorizes_compat_claim():
    """Q4: ภาพอย่างเดียว → ห้าม positive compat verdict และห้ามสร้างคำถาม
    compat cannot-confirm ที่ลูกค้าไม่ได้ถาม — image เป็น context เท่านั้น."""
    resps, _, _, _ = _multi_turn(TURNS_1_3 + [TURN_Q4_IMAGE])
    resp = resps[-1]
    ans = resp.answer or ""
    assert "ใช้งานร่วมกับ" not in ans and "รองรับการใช้งานกับ" not in ans, (
        f"image-only target กลายเป็น compat claim: {ans!r}")
    assert "ไม่สามารถยืนยัน" not in ans and "การเชื่อมต่อ" not in ans, (
        f"image-only turn สร้าง compat cannot-confirm เอง: {ans!r}")
    comp = (resp.routing_decision or {}).get("composition") or {}
    assert "compat" not in (comp.get("domains") or ()), (
        f"decided compat domain จากภาพอย่างเดียว: {comp}")


def test_q5_q7_stay_on_pair_and_answer_is_grounded():
    """Q5–Q7: คำตอบต้องอยู่บน pair {A,B} เท่านั้น — products (ถ้ามี) ⊆ pair,
    ไม่ถามให้ส่งการ์ดซ้ำ, และห้ามยืนยันข้อเท็จจริงชนิดสายที่ catalog ไม่มี
    (ทั้งสอง listing เป็น Elite2 ตัวเลือก Black/Noir — ไม่มี strap option)."""
    q7 = {"msg": "ตัวบนเลือกสายได้ ส่วนตัวล่างระบุสายซิโคน ถูกต้องไหมครับ",
          "intent_result": {"intent": "product_question", "confidence": 0.9,
                            "subject_scope": "current_set"}}
    resps, _, admindb, _ = _multi_turn(
        TURNS_1_3 + [TURN_Q4_IMAGE, TURN_Q5_COMPARE,
                     {"msg": "เป็นตัวเดียวกันใช่ไหมครับ",
                      "intent_result": {"intent": "product_question",
                                        "confidence": 0.9,
                                        "subject_scope": "current_set"}},
                     q7])
    ss = _subject_doc(admindb)
    assert set(map(str, ss.get("subject_ids") or ())) == {ITEM_A, ITEM_B}, ss
    for i, resp in enumerate(resps[4:], start=5):
        assert (resp.source or "") != "subject_clarify", (
            f"Q{i} ถามการ์ดซ้ำ: {resp.answer!r}")
        ids = {str(p.get("item_id")) for p in (resp.products or ())}
        assert ids <= {ITEM_A, ITEM_B}, f"Q{i} products หลุด pair: {ids}"
        ans = resp.answer or ""
        assert "สายซิลิโคน" not in ans or "ไม่มีข้อมูล" in ans \
            or "ไม่สามารถ" in ans, (
                f"Q{i} ยืนยันชนิดสายโดยไม่มีหลักฐาน catalog: {ans!r}")
        assert "4,490" not in ans and "4490" not in ans, (
            f"Q{i} ราคาหลุดในคำตอบลูกค้า: {ans!r}")


def test_burning_smell_safety_before_claim_info():
    """F4: กลิ่นไหม้ → คำแนะนำปลอดภัย (หยุดใช้งาน/ถอดปลั๊ก/ไม่ชาร์จซ้ำ)
    ก่อนขอข้อมูลเคลม, ห้าม checklist เปลี่ยนสาย/หัวชาร์จ และ handoff จริง."""
    turns = [{"msg": "นาฬิกามีกลิ่นไหม้ครับ ชาร์จอยู่แล้วได้กลิ่น เคลมได้ไหม",
              "intent_result": {"intent": "warranty_claim",
                                "confidence": 0.9}}]
    resps, _, admindb, handoff_calls = _multi_turn(turns)
    resp = resps[0]
    ans = resp.answer or ""
    pos_safe = ans.find("หยุดใช้งาน")
    pos_info = ans.find("ข้อมูล")
    assert pos_safe != -1, f"ไม่มีคำสั่งหยุดใช้งาน: {ans!r}"
    assert "ปลั๊ก" in ans or "ชาร์จ" in ans.split("หยุดใช้งาน")[1][:120], ans
    assert "เปลี่ยนสายชาร์จ" not in ans and "ลองกับเครื่องอื่น" not in ans, (
        f"checklist อันตรายหลุดมาในเคสไหม้: {ans!r}")
    if pos_info != -1:
        assert pos_safe < pos_info, (
            f"ขอข้อมูลเคลมก่อนคำเตือนปลอดภัย: {ans!r}")
    # handoff ต้องถูกเรียกจริง (POST ออก) — แยกจาก flag ของ response
    assert handoff_calls, (
        f"_send_handoff ไม่ถูกเรียก: answer={ans!r}")
    assert getattr(resp, "handoff_to_admin", False), (
        f"transport ยืนยันแล้วแต่ flag ไม่ตั้ง: {ans!r}")


def test_malfunction_safe_check_hazard_branch():
    """unit: owner malfunction_safe_check — ไหม้/ควัน/ร้อนผิดปกติ → safety-
    first; อาการชาร์จทั่วไป → checklist เดิม."""
    from shopeechat import warranty
    out = warranty.malfunction_safe_check("มีกลิ่นไหม้ตอนชาร์จครับ")
    assert "หยุดใช้งาน" in out and ("ปลั๊ก" in out or "ไม่ลองชาร์จ" in out), out
    assert "เปลี่ยนสายชาร์จ" not in out
    out2 = warranty.malfunction_safe_check("ชาร์จไม่เข้าเลยครับ")
    assert "เปลี่ยนสายชาร์จ" in out2 or "เช็ก" in out2, out2


def _kieslect_xlsx():
    """xlsx 2 rows: Elite2 app Q&A (Kstyle OS) + unrelated row — โครงเดียวกับ
    105 - Kieslect.xlsx."""
    import io
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.append(["ชื่อแบรนด์", "ประเภทสินค้า", "รุ่นสินค้า", "คำถามเกี่ยวสินค้า",
               "คำตอบ"])
    ws.append(["Kieslect", "smart watch", "Kieslect Elite2",
               "ใช้กับแอปอะไร",
               "เชื่อมต่อและจัดการข้อมูลผ่านแอป Kstyle OS "
               "รองรับทั้ง iOS และ Android"])
    ws.append(["Kieslect", "smart watch", "Kieslect Actor",
               "แบตอยู่กี่วัน", "14 วัน"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_q10_item_id_binding_chain_reaches_kstyle_os_evidence():
    """Q10 contract proof: Zaapi row ผูก explicit item-ID ref (rows binding —
    contract เดิมของ bind owner) + need.subject_refs = item_id → gate ผ่าน
    และ evidence แถว Kstyle OS attribute ถึง need จริง (ไม่ใช่ fuzzy match)."""
    from mongo_doubles import FakeDb
    from _pytest.monkeypatch import MonkeyPatch
    from shopeechat import kb_zaapi, kb_zaapi_files as zkf, knowledge_base as kb
    mp = MonkeyPatch()
    try:
        db = FakeDb({})
        zkf.apply_import(
            db, filename="105 - Kieslect.xlsx", data=_kieslect_xlsx(),
            subject_bindings={"Sheet1": {"rows": {
                "0": ["kieslect elite2", "43881222601"],
                "1": ["kieslect actor"]}}},
            accounts=["KieslectThailand"], platforms=["shopee"],
            content_type="product", admin="test")
        from shopeechat import embedding as emb, runtime_config as rc
        mp.setattr(kb, "_admin_db", lambda: db)
        mp.setattr(emb, "embed_query",
                   lambda *a, **k: (_ for _ in ()).throw(
                       RuntimeError("embed off in test")))
        mp.setattr(rc, "get_runtime_config",
                   lambda *a, **k: {"kb_source": "zaapi",
                                    "pool_sources": {}})

        class N:
            kind = "product"
            subject_refs = ("43881222601",)
            target_refs = ()
            capability_asks = ()

        res = kb_zaapi.zaapi_kb_evidence(
            shop="KieslectThailand", platform="shopee",
            message="เชื่อมต่อกับแอปไหนครับ", needs=(N,), db=db)
        sup = res.supporting_evidence or ()
        texts = " ".join(str((s.get("payload") or {}).get("text") or "")
                         for s in sup)
        assert "Kstyle OS" in texts, (
            f"item-ID bound row ไม่ถึง evidence: {res.trace} sup={sup!r}")
    finally:
        mp.undo()


def test_q10_unbound_model_name_only_cannot_match_item_id():
    """negative control: row ผูก 'kieslect elite2' (model name) ต้องไม่
    match item_id digit — exact gate ไม่ใช่ substring/fuzzy."""
    from mongo_doubles import FakeDb
    from _pytest.monkeypatch import MonkeyPatch
    from shopeechat import kb_zaapi, kb_zaapi_files as zkf, knowledge_base as kb
    mp = MonkeyPatch()
    try:
        db = FakeDb({})
        zkf.apply_import(
            db, filename="105 - Kieslect.xlsx", data=_kieslect_xlsx(),
            subject_bindings={"Sheet1": {"columns": [
                {"column_index": 3, "header": "รุ่นสินค้า"}]}},
            accounts=["KieslectThailand"], platforms=["shopee"],
            content_type="product", admin="test")
        mp.setattr(kb, "_admin_db", lambda: db)
        mp.setattr(kb_zaapi, "_zaapi_allowed", lambda: True)

        class N:
            kind = "product"
            subject_refs = ("43881222601",)
            target_refs = ()
            capability_asks = ()

        res = kb_zaapi.zaapi_kb_evidence(
            shop="KieslectThailand", platform="shopee",
            message="เชื่อมต่อกับแอปไหนครับ", needs=(N,), db=db)
        texts = " ".join(str((s.get("payload") or {}).get("text") or "")
                         for s in (res.supporting_evidence or ()))
        assert "Kstyle OS" not in texts, (
            "item_id digit ต้องไม่ fuzzy-match ชื่อรุ่น")
    finally:
        mp.undo()


def test_failed_handoff_does_not_claim_success():
    """handoff transport ล้ม → ห้ามตั้ง handoff_to_admin / ห้ามบอกลูกค้าว่า
    ส่งต่อแล้ว (authoritative transport outcome เท่านั้น)."""
    from test_legacy_turn_incident_replay import _install, ADMIN_DB
    from shopeechat import responses as _resp_mod
    import tempfile
    mp = MonkeyPatch()
    turns = [{"msg": "เครื่องมีกลิ่นไหม้ครับ",
              "intent_result": {"intent": "warranty_claim",
                                "confidence": 0.9}}]
    fx = {"id": CID, "shop": SHOP, "platform": "shopee",
          "conversation_id": CID, "catalog": CATALOG,
          "turns": [{"text": t["msg"],
                     "intent_result": t["intent_result"]} for t in turns],
          "llm_reply": "", "runtime_flags": {"grouped_selection": True}}
    with tempfile.TemporaryDirectory():
        client, captured, handoff_calls = _install(mp, fx)
        called = []

        def _fail_send(req, ctx=None, *, reason="", **kw):
            called.append(reason)
            return None  # transport ล้ม — ไม่มี outcome
        mp.setattr(app, "_send_handoff", _fail_send)
        mp.setattr(_resp_mod, "_send_handoff", _fail_send)
        try:
            resp = app.chat(app.ChatRequest(
                message=turns[0]["msg"], shop=SHOP, platform="shopee",
                history=[], conversation_id=CID, limit=5,
                simulate_assignment=True,
                test_source="elite2-conv-quality"))
        finally:
            mp.undo()
    ans = resp.answer or ""
    assert not getattr(resp, "handoff_to_admin", False), (
        f"handoff ล้มแต่ flag ตั้ง: {ans!r}")
    assert "ส่งต่อ" not in ans and "แอดมินจะติดต่อ" not in ans, (
        f"handoff ล้มแต่บอกลูกค้าว่าส่งแล้ว: {ans!r}")
    # safety text ยังต้องมาก่อนแม้ transport ล้ม
    assert "หยุดใช้งาน" in ans or "ถอดปลั๊ก" in ans, ans
