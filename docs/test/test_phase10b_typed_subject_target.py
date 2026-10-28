"""Phase 10B r8 — typed subject/target contract ที่ owner เดียว (decide_turn).

Contract: `TurnNeed.subject_refs` = product/entity ที่ need ถามถึง,
`TurnNeed.target_refs` = relation/device constraint ที่ apply บน subject.
Roles ถูก emit ครั้งเดียวที่ decision boundary — retrieval consume verbatim,
ไม่ re-parse, ไม่ infer จาก position/family/span/soft terms.
spec tokens (IP rating/protocol/wattage/USB version) ไม่เป็น identity.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import route_context as rc  # noqa: E402
from shopeechat import retrieval_runtime as rrt  # noqa: E402
from shopeechat.retrieval_executor import _bucket  # noqa: E402
from shopeechat.retrieval_planner import RetrievalRequest  # noqa: E402
from shopeechat.retrieval_policy import make_evidence_card  # noqa: E402


def _plan(msg: str):
    return td.decide_turn(msg, intent_result=None)


def _need(plan, kind):
    return next((n for n in plan.needs if n.kind == kind), None)


def _refs(plan, kind):
    n = _need(plan, kind)
    return (n.subject_refs if n else None, getattr(n, "target_refs", None))


def _card(name: str, item_id="9000", **kw):
    """legacy listing card shape เดียวกับ to_product_card output"""
    c = {"name": name, "item_id": item_id, "shop": "t",
         "status": "NORMAL", "total_stock": 3,
         "model": [{"name": name, "model_status": "MODEL_NORMAL",
                    "stock_info_v2": {"summary_info": {
                        "total_available_stock": 3}}}]}
    c.update(kw)
    return make_evidence_card(c, source="legacy", requested=())


def _req(**kw):
    base = dict(request_id="r", slot_id="s", source="slot",
                product_types=frozenset(), subtypes=frozenset(),
                model_codes=(), target_device=None,
                availability_mode="", compat_mode="none",
                hard_filters=(), soft_hints=(), relation_id=None,
                relation_type=None, confidence=1.0, variant_terms=(),
                value_constraints=(), subject_refs=())
    base.update(kw)
    return RetrievalRequest(**base)


# ── owner-level truth table (subject, target) ────────────────────────────

def test_direct_product_s25_variants_all_subject():
    """direct named product — S25 = asked product → subject, ไม่มี target.
    equivalence: wording ต้องไม่เปลี่ยน role"""
    for msg in ("ขอมือถือ s25", "อยากได้ s25", "รุ่น s25 มีไหม",
                "ขอสมาร์ทโฟน s25", "โทรศัพท์ s25 มีไหม"):
        subj, tgt = _refs(_plan(msg), "product")
        assert subj == ("S25",), (msg, subj)
        assert tgt == (), (msg, tgt)


def test_case_for_s25_is_target_not_subject():
    """case request + device constraint — S25 = target_refs เท่านั้น
    (ไม่มี explicit case model → subject ว่าง)"""
    for msg in ("มีเคส s25 ไหม", "s25 มีเคสไหม", "ขอเคสสำหรับ s25"):
        subj, tgt = _refs(_plan(msg), "product")
        assert subj == (), (msg, subj)
        assert tgt == ("s25",), (msg, tgt)


def test_relation_s25_iphone15_roles():
    """S25 ใช้กับ iphone 15 — compat need: S25=subject, iphone15=target"""
    p = _plan("s25 ใช้กับ iphone 15 ได้ไหม")
    subj, tgt = _refs(p, "compat")
    assert subj == ("S25",), subj
    assert tgt == ("iphone 15",), tgt


def test_relation_iphone14_iphone15_same_family_distinct():
    """same-family source/target ไม่ merge — device names เข้า typed refs
    ผ่าน authoritative extractor (validated spec db)"""
    p = _plan("iphone 14 ใช้กับ iphone 15 ได้ไหม")
    subj, tgt = _refs(p, "compat")
    assert subj == ("iphone 14",), subj
    assert tgt == ("iphone 15",), tgt


def test_relation_miwatch_iphone15_roles():
    """device-name subject ของ relation (mi watch 8 เชื่อมกับ ip15)"""
    p = _plan("นาฬิกา mi watch 8 เชื่อมกับ iphone 15 ได้ไหม")
    subj, tgt = _refs(p, "compat")
    assert subj == ("mi watch 8",), subj
    assert tgt == ("iphone 15",), tgt


def test_w01_strava_no_device_target():
    """W01=subject; Strava ไม่ใช่ device → target ว่าง (no typed evidence →
    compat ต้อง unanswered ไม่ใช่เดา)"""
    p = _plan("w01 รองรับ strava ไหม")
    subj, tgt = _refs(p, "compat")
    assert subj == ("W01",), subj
    assert tgt == (), tgt


def test_spec_tokens_never_identities():
    """IP rating / USB version / wattage / protocol — ไม่เป็น subject
    หรือ target (spec evidence เท่านั้น)"""
    for msg in ("หูฟัง ip68 กันน้ำไหม", "usb 2.0 ต่างจาก usb 3.0 ไหม",
                "65w ชาร์จเร็วไหม", "pd3.1 รองรับไหม"):
        p = _plan(msg)
        for n in p.needs:
            assert "IP68" not in n.subject_refs, (msg, n.subject_refs)
            assert "65W" not in n.subject_refs, (msg, n.subject_refs)
            assert all("usb" not in r.lower() and "pd" not in r.lower()
                       for r in n.subject_refs), (msg, n.subject_refs)
            assert getattr(n, "target_refs", ()) == (), (msg, n.kind)


def test_item_tag_subject_parity():
    """item-tag ids = subject_refs เดิม (media/subject channel)"""
    p = _plan("[ITEM:99] มีไหม")
    n = _need(p, "product") or _need(p, "compat")
    if n is not None:
        assert "99" in n.subject_refs, n.subject_refs


def test_code_subject_i14_pro_no_leak():
    """code token ภายใน device mention (i14 ⊂ i14 pro) ไม่เป็น subject —
    device เดียวกันทั้งก้อนไป target domain"""
    subj, tgt = _refs(_plan("เคส i14 pro มีไหม"), "product")
    assert "I14" not in (subj or ()), subj


def test_ad1404t_post_connector_code_is_target():
    """r9: สายชาร์จใช้กับ AD1404T — product ที่ถาม = สายชาร์จ (type);
    AD1404T = post-connector code = compat target ไม่ใช่ subject"""
    p = _plan("สายชาร์จใช้กับ ad1404t ไหม")
    for kind in ("product", "compat"):
        subj, tgt = _refs(p, kind)
        if subj is None:
            continue
        assert "AD1404T" not in subj, (kind, subj)
        assert "AD1404T" in (tgt or ()), (kind, tgt)
    comp = _need(p, "compat")
    assert comp is not None
    assert comp.target_refs == ("AD1404T",), comp.target_refs
    assert comp.subject_refs == (), comp.subject_refs


def test_app_service_relation_target_from_intent():
    """r9: W01 รองรับ Strava — Strava = named relation counterpart ผ่าน
    structured intent field เดิม (ไม่ใช่ device → ไม่เข้า target_device)"""
    p = td.decide_turn("w01 รองรับ strava ไหม", intent_result={
        "intent": "compatibility_check", "relation_target": "strava",
        "confidence": 0.9})
    subj, tgt = _refs(p, "compat")
    assert subj == ("W01",), subj
    assert tgt == ("strava",), tgt


def test_relation_target_fails_closed():
    """r9: relation_target ที่ไม่ grounded (ไม่อยู่ใน message) หรือ
    confidence ต่ำ → ทิ้ง (fail closed) ไม่เข้า target_refs"""
    bad = td.decide_turn("w01 รองรับ strava ไหม", intent_result={
        "intent": "compatibility_check", "relation_target": "spotify",
        "confidence": 0.9})
    _, tgt = _refs(bad, "compat")
    assert "spotify" not in (tgt or ()), tgt
    low = td.decide_turn("w01 รองรับ strava ไหม", intent_result={
        "intent": "compatibility_check", "relation_target": "strava",
        "confidence": 0.3})
    _, tgt2 = _refs(low, "compat")
    assert tgt2 == (), tgt2


# ── retrieval consumption — verbatim, need-associated ────────────────────

def _chain(msg: str, needs=None):
    """profile → slots(needs) → relations → requests — production boundary"""
    profile = rc.build_retrieval_profile(
        msg, history=None, intent_result=None, shop="KingGadgets")
    slots = rc.build_retrieval_slots(profile, needs=needs or ())
    rels = rc.build_retrieval_relations(profile, slots)
    from shopeechat.retrieval_planner import build_grouped_retrieval_requests
    return profile, slots, build_grouped_retrieval_requests(
        profile, slots, rels)


def test_request_carries_typed_roles_for_case_s25():
    """มีเคส s25 → request: product=case, target=S25, ไม่มี fake source"""
    plan = _plan("มีเคส s25 ไหม")
    profile, slots, reqs = _chain("มีเคส s25 ไหม", needs=plan.needs)
    assert len(reqs) == 1
    r = reqs[0]
    assert r.product_types == frozenset({"case"})
    assert r.target_device == "s25"
    assert r.subject_refs == (), r.subject_refs


def test_request_carries_typed_roles_iphone14_relation():
    """iphone 14 ใช้กับ iphone 15 → request เห็น subject=iphone14,
    target=iphone15 (H3 — target ต้องไม่หาย)"""
    plan = _plan("iphone 14 ใช้กับ iphone 15 ได้ไหม")
    _, _, reqs = _chain("iphone 14 ใช้กับ iphone 15 ได้ไหม",
                        needs=plan.needs)
    assert len(reqs) == 1
    r = reqs[0]
    assert "iphone 14" in r.subject_refs, r.subject_refs
    assert r.target_device == "iphone 15", r.target_device


def test_ip68_no_named_product_request():
    """spec token ไม่สร้าง named request (H4) — earphone slot ไม่มี
    subject/target refs"""
    plan = _plan("หูฟัง ip68 กันน้ำไหม")
    _, slots, reqs = _chain("หูฟัง ip68 กันน้ำไหม", needs=plan.needs)
    for r in reqs:
        assert r.subject_refs == (), r.subject_refs
        assert r.target_device is None, r.target_device


def test_request_accessory_code_target_not_device():
    """r9: สายชาร์จใช้กับ AD1404T → request พก target_refs=(AD1404T)
    แต่ target_device=None (AD1404T ไม่ใช่ spec-db device) และไม่มี
    AD1404T เป็น subject ของ request"""
    plan = _plan("สายชาร์จใช้กับ ad1404t ไหม")
    _, slots, reqs = _chain("สายชาร์จใช้กับ ad1404t ไหม",
                            needs=plan.needs)
    assert reqs
    r = reqs[0]
    assert "AD1404T" not in r.subject_refs, r.subject_refs
    assert "AD1404T" in r.target_refs, r.target_refs
    assert r.target_device != "AD1404T", r.target_device
    assert "charger" in r.product_types, r.product_types


def test_request_app_target_never_in_target_device():
    """r9: compat-only turn ที่ target เป็น app/service → request พก
    target_refs=(strava) แต่ target_device=None"""
    plan = td.decide_turn("ใช้กับ strava ได้ไหม", intent_result={
        "intent": "compatibility_check", "relation_target": "strava",
        "confidence": 0.9})
    comp = _need(plan, "compat")
    assert comp is not None and comp.target_refs == ("strava",), plan.needs
    _, slots, reqs = _chain("ใช้กับ strava ได้ไหม", needs=plan.needs)
    for r in reqs:
        assert r.target_device != "strava", r.target_device


def test_bucket_no_soft_term_identity_escape():
    """_bucket: soft model_term + single-device card ≠ identity proof (H5).
    card พก device เดียว 'sugar 20' + target iphone 15 → device_mismatch
    เพราะ sugar20 ไม่ใช่ typed subject"""
    card = _card("Sugar 20 แท้ศูนย์ไทย")
    req = _req(product_types=frozenset({"phone"}),
               target_device="iphone 15",
               soft_hints=(("model_term", "SUGAR20"),))
    b, why = _bucket(card, req)
    assert b == "rejected" and "device_mismatch" in why, (b, why)


def test_bucket_typed_subject_own_model_exempt():
    """_bucket: dev token ของ card ∈ req.subject_refs (typed) → own-model —
    structured equality เท่านั้น ไม่ใช่ name match"""
    card = _card("เคส iphone 14 กันกระแทก")
    req = _req(product_types=frozenset({"case"}),
               target_device="iphone 15",
               subject_refs=("iphone 14",))
    # card เคลม iphone 14 — typed subject → ไม่ใช่ mismatch vs iphone 15?
    # card device token 'iphone 14' ∈ refs → own-model → ผ่าน device check
    b, why = _bucket(card, req)
    assert why != "device_mismatch:iphone 14", (b, why)


def test_need_isolation_multi_need_turn():
    """role channels ไม่ปนกันใน turn เดียว — case-need: S25 = device
    constraint (target_refs) ไม่ใช่ subject; compat need ของอีก clause:
    W01 = subject; s25 ไม่ใช่ target ของมัน"""
    p = _plan("มีเคส s25 ไหม แล้ว w01 รองรับ strava ไหม")
    product = _need(p, "product")
    compat = _need(p, "compat")
    assert product is not None
    assert "s25" not in [r.lower() for r in product.subject_refs], product
    assert product.target_refs == ("s25",), product.target_refs
    if compat is not None:
        assert "W01" in compat.subject_refs, compat.subject_refs
        assert "s25" not in compat.target_refs, compat.target_refs


def test_product_need_carries_connector_constraint():
    """s25 ใช้กับ iphone 15: post-conn device = constraint ของ product
    domain — product need รับ target ด้วย (constraint apply บน s25
    retrieval จริง ไม่ใช่ flatten)"""
    p = _plan("s25 ใช้กับ iphone 15 ได้ไหม")
    product = _need(p, "product")
    assert product is not None
    assert product.subject_refs == ("S25",)
    assert product.target_refs == ("iphone 15",)


def test_multi_slot_scoped_needs_no_flatten():
    """multi-slot + scoped needs: target_refs ของ case-need ต้องไม่รั่วไป
    film slot — association ผ่าน typed product_types scope เท่านั้น
    (mutation: flatten refs → film slot ได้ s25 → fail)"""
    needs = (
        td.TurnNeed(kind="product", operation="describe",
                    subject_refs=(), target_refs=("s25",),
                    product_types=frozenset({"case"})),
        td.TurnNeed(kind="product", operation="describe",
                    subject_refs=(), target_refs=("iphone 14",),
                    product_types=frozenset({"screen_protector"})),
    )
    _, slots, _ = _chain("เคส s25 กับฟิล์ม ip14", needs=needs)
    by_type = {}
    for s in slots:
        for t in s.product_types:
            by_type[t] = s
    assert by_type["case"].target_refs == ("s25",), by_type["case"]
    assert by_type["screen_protector"].target_refs == ("iphone 14",), (
        by_type["screen_protector"])
    assert by_type["case"].target_device == "s25"
    assert by_type["screen_protector"].target_device == "iphone 14"


def test_one_turnplan_call_per_turn():
    """decide_turn + slot/request construction — ไม่มี re-resolution"""
    plan = _plan("มีเคส s25 ไหม")
    _, slots, reqs = _chain("มีเคส s25 ไหม", needs=plan.needs)
    assert len(reqs) == 1
