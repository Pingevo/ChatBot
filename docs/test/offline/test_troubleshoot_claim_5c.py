"""test_troubleshoot_claim_5c.py — Task 5C-F: malfunction detection + safe answer.

pin:
- "ใช้งานไม่ได้"/"ชาร์จไฟไม่ได้" style = claim request (เดิมหลุดไป product flow)
- warranty-policy questions ("เคลมได้ไหม") ไม่ใช่ claim
- first-claim answer สำหรับ malfunction ต้องมี safe checks (เปลี่ยนสาย/ปลั๊ก/
  เครื่องอื่น, เช็กพอร์ต, หยุดใช้ถ้าร้อน/กลิ่นไหม้) และห้ามเดาสเปค
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import warranty, warranty_flow  # noqa: E402


def test_malfunction_phrases_are_claim_requests():
    for msg in ("หัวชาร์จ a18t ใช้งานไม่ได้",
                "สายชาร์จชาร์จไฟไม่ได้",
                "หัวชาร์จใช้งานไม่ได้",
                "a18t ใช้ไม่ได้",
                "ชาร์จไฟไม่เข้าเลย"):
        assert warranty.detect_claim_request(msg), msg


def test_policy_questions_not_claims():
    for msg in ("เคลมได้ไหม", "ถ้ามีปัญหาเคลมได้ไหม",
                "รับประกันกี่เดือน", "มีประกันไหม"):
        assert not warranty.detect_claim_request(msg), msg


def test_safe_check_content_no_spec_guess():
    note = warranty.malfunction_safe_check("หัวชาร์จ a18t ใช้งานไม่ได้")
    assert note
    assert "ลอง" in note or "เช็ก" in note
    assert "ชาร์จด่วน" not in note and "3.0" not in note
    # safety stop ต้องมี
    assert "หยุด" in note


def test_safe_check_empty_for_non_malfunction():
    assert warranty.malfunction_safe_check("เคลมได้ไหม") == ""
    assert warranty.malfunction_safe_check("ส่งเคลมสินค้า") == ""


def test_safe_check_keyword_boundaries():
    """keyword สั้นห้าม match substring ของคำอื่น — 'ระดับ' มี 'ดับ',
    'เสียง' มี 'เสีย' — spec/audio questions ต้องไม่ถูกกลืนเป็น malfunction"""
    for msg in ("GS3 Ultra กันน้ำระดับไหน",
                "กันน้ำระดับ IP68 ไหม",
                "ปรับระดับความสว่างได้ไหม",
                "หูฟังเสียงดีไหม",
                "ลำโพงเสียงดังพอไหม",
                "งงไม่เข้าใจว่าทำไมต้อง 20W"):
        assert warranty.malfunction_safe_check(msg) == "", msg


def test_safe_check_still_matches_real_symptoms():
    for msg in ("เครื่องดับเอง", "จอดับค้าง", "ไฟดับ",
                "สินค้าเสีย", "เสียหายแล้ว", "เสียแล้วค่ะ",
                "พังแล้ว", "ของพังงับ", "ชาร์จไม่เข้า",
                "ใช้งานไม่ได้", "เสียบแล้วไม่ชาร์จ", "หน้าจอค้าง",
                "เสียบสายแล้วไม่ชาร์จ"):
        assert warranty.malfunction_safe_check(msg), msg


def test_watch_control_problem_does_not_get_charging_advice():
    note = warranty.malfunction_safe_check(
        "ปุ่มเม็ดมะยมหมุนติดบ้างไม่ติดบ้าง", product_type="smartwatch")
    assert note
    assert "สายชาร์จ" not in note
    assert "ปลั๊กไฟ" not in note
    assert "พอร์ตชาร์จ" not in note
    assert "หยุดใช้งาน" in note


def test_charger_problem_keeps_charging_safe_check():
    note = warranty.malfunction_safe_check(
        "หัวชาร์จ A18T ใช้งานไม่ได้", product_type="charger")
    assert "สายชาร์จ" in note
    assert "พอร์ตชาร์จ" in note


def test_first_claim_answer_has_safe_checks():
    """first-message malfunction claim → acknowledge + safe checks + ขอข้อมูลเคลม"""
    from shopeechat import app as _app_module, llm
    req = SimpleNamespace(message="หัวชาร์จ a18t ใช้งานไม่ได้",
                          conversation_id=None, platform="shopee",
                          shop="KingGadgets", simulate_assignment=False,
                          item_id=None)
    ctx = {"bot_name": "ทางร้าน", "steps": [], "timing_breakdown": {},
           "total_start": 0.0, "image_desc_out": "", "model_name": "test"}
    out = warranty_flow._handle_first_message_claim(
        req, ctx, True, warranty, llm, _app_module)
    assert out
    ans = out["answer"]
    assert "ขออภัย" in ans                       # acknowledge
    assert "ลอง" in ans or "เช็ก" in ans          # safe checks
    assert "เลขที่คำสั่งซื้อ" in ans              # claim path intact
    assert "ชาร์จด่วน" not in ans                 # ไม่เดาสเปค


# ── malfunction troubleshoot-first coverage (unbound-Zaapi KB fix) ──

def _wf_req(msg, conv=None, shop="ThaiSuperPhone"):
    return SimpleNamespace(message=msg, conversation_id=conv,
                           platform="shopee", shop=shop, item_id=None,
                           ticket_state=None, claim_outcome=None,
                           simulate_assignment=False)


def _wf_ctx(claim=False):
    return {"bot_name": "ทางร้าน", "steps": [], "timing_breakdown": {},
            "total_start": 0.0, "t0": 0.0, "image_desc_out": "",
            "model_name": "test", "is_claim_request": claim,
            "is_followup_policy": False, "is_tax_invoice": False,
            "qa10": [], "warranty_auto_answer": "", "warranty_auto_ctx": "",
            "intent_result": {}, "anchor_compare_ctx": None, "snap": None}


def test_nonclaim_malfunction_gets_tips_not_product_fallthrough(monkeypatch):
    """อาการที่ไม่ใช่ claim request ("เครื่องติดดับเอง" — ไม่มีเคลม/ซ่อม keyword)
    ต้องได้ troubleshoot tips + episode ts_suggested — เดิมคืน None →
    หล่นไป product pipeline "หาข้อมูลสินค้าไม่ได้"."""
    from shopeechat import knowledge_base as kb
    monkeypatch.setattr(kb, "qa_troubleshoot_tips",
                        lambda *a, **k: ["กดปุ่มค้าง 10 วินาทีเพื่อรีสตาร์ทเครื่อง"])
    minted = []
    monkeypatch.setattr(
        warranty_flow, "_claim_transition",
        lambda req, cs, to, fields=None, fresh_claim=False:
            minted.append(to) or dict(cs, stage=to))
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("เครื่องติดดับเอง"), _wf_ctx(claim=False), [], None)
    assert out is not None, "malfunction ต้องไม่หล่นไป product pipeline"
    assert out["source"] == "warranty_troubleshoot"
    assert "รีสตาร์ท" in out["answer"]
    assert "ลองทำตามนี้ก่อน" in out["answer"]
    assert minted == ["ts_suggested"], \
        "ต้อง mint ts_suggested เพื่อให้ 'ไม่หาย' turn ถัดไปเข้า claim intake"


def test_nonclaim_malfunction_no_tips_safe_check_floor(monkeypatch):
    """ไม่มี KB tip → floor = malfunction safe-check + เส้นทางเคลม —
    ยังดีกว่า 'หาสินค้าไม่เจอ' แต่ไม่ขอข้อมูลเคลมก่อนเหตุ."""
    from shopeechat import knowledge_base as kb
    monkeypatch.setattr(kb, "qa_troubleshoot_tips", lambda *a, **k: [])
    monkeypatch.setattr(warranty_flow, "_claim_transition",
                        lambda req, cs, to, fields=None, fresh_claim=False:
                            dict(cs, stage=to))
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("เครื่องติดดับเอง"), _wf_ctx(claim=False), [], None)
    assert out is not None
    assert "เช็ก" in out["answer"] or "ลอง" in out["answer"]
    assert "เลขที่คำสั่งซื้อ" not in out["answer"]  # ยังไม่ขอข้อมูลเคลม


def test_nonclaim_malfunction_buy_intent_passthrough(monkeypatch):
    """"เครื่องเก่าพัง อยากได้ตัวใหม่แนะนำหน่อย" = buy intent — ห้ามกลืน
    product recommendation turn."""
    from shopeechat import knowledge_base as kb
    calls = []
    monkeypatch.setattr(kb, "qa_troubleshoot_tips",
                        lambda *a, **k: calls.append(1) or ["tip"])
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("เครื่องเก่าพัง อยากได้ตัวใหม่แนะนำหน่อย"),
        _wf_ctx(claim=False), [], None)
    assert out is None and calls == [], \
        "buy-intent ต้องปล่อยไป product pipeline เดิม"


def test_post_handoff_new_symptom_supplemental_tips(monkeypatch):
    """already_handed + อาการใหม่ → tips เสริมใต้ human ownership —
    ไม่ mint episode/transition, ไม่ตอบ status reply เฉยๆ."""
    from shopeechat import knowledge_base as kb, conversation_products as cp
    monkeypatch.setattr(cp, "load_claim_state", lambda *a, **k: {
        "handed_off_at": "2026-11-20T00:00:00Z",
        "stage": "collecting", "episode_id": "e1"})
    monkeypatch.setattr(kb, "qa_troubleshoot_tips",
                        lambda *a, **k: ["รีเซ็ตตามคลิปนี้ดูนะคะ"])
    trans = []
    monkeypatch.setattr(warranty_flow, "_claim_transition",
                        lambda *a, **k: trans.append(1) or {})
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("เครื่องดับเอง ปุ่มกดไม่ได้", conv="c1"), _wf_ctx(claim=True),
        [{"role": "model", "text": "แอดมินดูแลเคสอยู่นะคะ"}], None)
    assert out is not None
    assert "รีเซ็ต" in out["answer"], "อาการใหม่ต้องได้วิธีแก้เสริม"
    assert "แอดมิน" in out["answer"], "ต้องบอกว่าเคสอยู่กับแอดมินแล้ว"
    assert trans == [], "ห้าม mint/merge episode ใหม่ post-handoff"


def test_post_handoff_status_only_keeps_status_reply(monkeypatch):
    """already_handed + ข้อความไร้อาการ (status question) → CLAIM_STATUS_REPLY
    เดิม — tips ห้ามยิง (ไม่มี malfunction evidence)."""
    from shopeechat import knowledge_base as kb, conversation_products as cp, responses
    monkeypatch.setattr(cp, "load_claim_state", lambda *a, **k: {
        "handed_off_at": "2026-11-20T00:00:00Z",
        "stage": "collecting", "episode_id": "e1"})
    calls = []
    monkeypatch.setattr(kb, "qa_troubleshoot_tips",
                        lambda *a, **k: calls.append(1) or ["tip"])
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("เคลมตรวจสอบยังครับ", conv="c1"), _wf_ctx(claim=True),
        [{"role": "model", "text": "แอดมินดูแลเคสอยู่นะคะ"}], None)
    assert out is not None
    assert calls == [], "status-only turn ห้ามเรียก tips"
    assert responses.CLAIM_STATUS_REPLY in out["answer"]


def test_post_handoff_new_symptom_without_kb_tip_is_not_status_only(monkeypatch):
    from shopeechat import knowledge_base as kb, conversation_products as cp
    monkeypatch.setattr(cp, "load_claim_state", lambda *a, **k: {
        "handed_off_at": "2026-11-20T00:00:00Z",
        "stage": "collecting", "episode_id": "e1"})
    monkeypatch.setattr(kb, "qa_troubleshoot_tips", lambda *a, **k: [])
    transitions = []
    monkeypatch.setattr(warranty_flow, "_claim_transition",
                        lambda *a, **k: transitions.append(1) or {})
    ctx = _wf_ctx(claim=True)
    ctx["intent_result"] = {"intent": "warranty_claim",
                            "product_type": "smartwatch",
                            "capability_asks": ["ปุ่มกดไม่ได้"]}
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("ปุ่มกดไม่ได้", conv="c1", shop="BlackShark"), ctx,
        [{"role": "model", "text": "แอดมินดูแลเคสอยู่นะคะ"}], None)
    assert out is not None
    assert "อาการ" in out["answer"]
    assert "สายชาร์จ" not in out["answer"]
    assert "แอดมิน" in out["answer"]
    assert transitions == []


def test_post_handoff_service_complaint_is_acknowledged(monkeypatch):
    from shopeechat import knowledge_base as kb, conversation_products as cp
    monkeypatch.setattr(cp, "load_claim_state", lambda *a, **k: {
        "handed_off_at": "2026-11-20T00:00:00Z",
        "stage": "collecting", "episode_id": "e1"})
    calls = []
    monkeypatch.setattr(kb, "qa_troubleshoot_tips",
                        lambda *a, **k: calls.append(1) or [])
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("รอมาสามวันแล้ว ไม่มีใครตอบเลย แย่มากครับ", conv="c1"),
        _wf_ctx(claim=True),
        [{"role": "model", "text": "แอดมินดูแลเคสอยู่นะคะ"}], None)
    assert out is not None
    assert "ขออภัย" in out["answer"]
    assert "รอ" in out["answer"]
    assert "แอดมิน" in out["answer"]
    assert calls == []
    assert not out["handoff_to_admin"]


def test_post_handoff_symptom_and_service_complaint_cover_both(monkeypatch):
    from shopeechat import knowledge_base as kb, conversation_products as cp
    monkeypatch.setattr(cp, "load_claim_state", lambda *a, **k: {
        "handed_off_at": "2026-11-20T00:00:00Z",
        "stage": "collecting", "episode_id": "e1"})
    monkeypatch.setattr(kb, "qa_troubleshoot_tips", lambda *a, **k: [])
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("เครื่องดับอีกแล้ว รอมาสามวัน ไม่มีใครตอบเลย แย่มาก", conv="c1"),
        _wf_ctx(claim=True),
        [{"role": "model", "text": "แอดมินดูแลเคสอยู่นะคะ"}], None)
    assert out is not None
    assert "ขออภัยที่ต้องรอ" in out["answer"]
    assert "อาการ" in out["answer"]
    assert not out["handoff_to_admin"]


def test_post_handoff_tips_also_acknowledge_service_complaint(monkeypatch):
    from shopeechat import knowledge_base as kb, conversation_products as cp
    monkeypatch.setattr(cp, "load_claim_state", lambda *a, **k: {
        "handed_off_at": "2026-11-20T00:00:00Z",
        "stage": "collecting", "episode_id": "e1"})
    monkeypatch.setattr(kb, "qa_troubleshoot_tips",
                        lambda *a, **k: ["รีเซ็ตตามคลิปนี้ดูนะคะ"])
    out = warranty_flow.handle_warranty_flow_legacy(
        _wf_req("เครื่องดับอีกแล้ว รอมาสามวัน ไม่มีใครตอบเลย แย่มาก", conv="c1"),
        _wf_ctx(claim=True),
        [{"role": "model", "text": "แอดมินดูแลเคสอยู่นะคะ"}], None)
    assert "รีเซ็ต" in out["answer"]
    assert "ขออภัย" in out["answer"]
    assert not out.get("handoff_to_admin")


def test_v2_post_handoff_new_symptom_keeps_episode_and_acknowledges(monkeypatch):
    from shopeechat import app as app_module, llm
    transitions = []
    monkeypatch.setattr(warranty_flow, "_claim_transition",
                        lambda *a, **k: transitions.append(1) or {})
    monkeypatch.setattr(warranty_flow, "_build_warranty_claim_response",
                        lambda req, ctx, answer, *a, **k:
                            {"answer": answer, "already_handed": k["already_handed"]})
    ctx = _wf_ctx(claim=True)
    ctx["intent_result"] = {"product_type": "smartwatch",
                            "capability_asks": ["ปุ่มกดไม่ได้"]}
    out = warranty_flow._handle_first_message_claim(
        _wf_req("ปุ่มกดไม่ได้ รอมาสามวัน ไม่มีใครตอบเลย", conv="c1"),
        ctx, True, warranty, llm, app_module,
        {"stage": "collecting", "episode_id": "e1"}, already_handed=True)
    assert transitions == []
    assert out["already_handed"]
    assert "อาการ" in out["answer"]
    assert "ขออภัย" in out["answer"]
    assert "แอดมิน" in out["answer"]
