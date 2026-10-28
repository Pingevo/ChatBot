"""Phase 10B r10A — exact item identity end-to-end (opaque string, ทุก layer).

Contract: item ID เป็น opaque string — ผ่าน decide_turn → slot → request →
canonical card → selection → AnswerContext → ConversationSubjectSet โดยไม่
float-coerce / ไม่หาย / ไม่กลายเป็น "other"; explicit item identity ชนะ
inferred product type เสมอ.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import route_context as rc  # noqa: E402
from shopeechat import conversation_products as cp  # noqa: E402
from shopeechat import retrieval_runtime as rrt  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat.retrieval_executor import _bucket  # noqa: E402
from shopeechat.retrieval_planner import RetrievalRequest  # noqa: E402
from shopeechat.retrieval_policy import make_evidence_card  # noqa: E402

ITEM = "27639651334"
SYNTH = ("ลูกค้าส่งการ์ดสินค้าชิ้นนี้มาในแชท "
         "สนใจสอบถามว่ามีของไหม และอยากดูรายละเอียดสินค้า")


def _card(name="CUKTECH CMC615P สายชาร์จ", item_id=ITEM, **kw):
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


def _need(plan, kind):
    return next((n for n in plan.needs if n.kind == kind), None)


def _chain(msg, needs, anchor=()):
    profile = rc.build_retrieval_profile(
        msg, history=None, intent_result=None, shop="t",
        anchor_cards=list(anchor))
    slots = rc.build_retrieval_slots(profile, needs=needs)
    rels = rc.build_retrieval_relations(profile, slots)
    from shopeechat.retrieval_planner import build_grouped_retrieval_requests
    return profile, slots, build_grouped_retrieval_requests(
        profile, slots, rels)


# ── owner boundary ────────────────────────────────────────────────────────

def test_tagged_turn_item_id_in_subject_refs():
    """[สินค้า:id] — tag-extracted identity รอดจาก synthetic-message
    rewrite → TurnNeed.subject_refs พก exact id (opaque string)"""
    plan = td.decide_turn(SYNTH, intent_result=None,
                          active_anchor={"item_id": ITEM},
                          tag_item_ids=(ITEM,))
    n = _need(plan, "product")
    assert n is not None, plan.needs
    assert n.subject_refs == (ITEM,), n.subject_refs
    assert all(isinstance(r, str) for r in n.subject_refs)


def test_untagged_message_unchanged():
    """ข้อความปกติไม่มี tag → item_ids=() default; subject refs เป็น
    code/device เดิมเท่านั้น"""
    plan = td.decide_turn("ขอมือถือ s25", intent_result=None)
    n = _need(plan, "product")
    assert n is not None and n.subject_refs == ("S25",), n.subject_refs


# ── propagation boundary ──────────────────────────────────────────────────

def test_slot_and_request_carry_exact_item_id():
    """item id ใน need → slot/request subject_refs เป็น string เดิม
    (verbatim) — ไม่ float, ไม่หาย"""
    plan = td.decide_turn(SYNTH, intent_result=None,
                          active_anchor={"item_id": ITEM},
                          tag_item_ids=(ITEM,))
    card = _card()
    _, slots, reqs = _chain(SYNTH, plan.needs, anchor=[card])
    item_refs = [r for s in slots for r in s.subject_refs]
    assert ITEM in item_refs, [s.subject_refs for s in slots]
    req_refs = [r for q in reqs for r in q.subject_refs]
    assert ITEM in req_refs, [q.subject_refs for q in reqs]
    assert all(isinstance(r, str) for r in req_refs)


# ── canonical card boundary (float coercion source) ───────────────────────

def test_evidence_card_normalizes_float_item_id():
    """mongo float item_id → canonical card item_id = str ตัวเดิม
    (normalize ที่ emit boundary ไม่ใช่ strip .0 ทีหลัง)"""
    c = make_evidence_card({"name": "x", "item_id": float(ITEM)},
                           source="legacy", requested=())
    assert c["item_id"] == ITEM, (type(c["item_id"]), c["item_id"])
    assert isinstance(c["item_id"], str)


def test_evidence_card_normalizes_str_float_item_id():
    """mongo export str-float '27639651334.0' → '27639651334'"""
    c = make_evidence_card({"name": "x", "item_id": f"{ITEM}.0"},
                           source="legacy", requested=())
    assert c["item_id"] == ITEM, c["item_id"]


# ── selection boundary ────────────────────────────────────────────────────

def test_exact_item_outranks_type_other_and_mismatch():
    """_bucket: card ที่ item_id ∈ req.subject_refs = exact item —
    ชนะ inferred type เสมอ (type 'other'/missing/mismatch ตัดไม่ได้)"""
    card = _card()
    assert card["item_id"] == ITEM  # normalized at emit
    for ptypes in (frozenset({"other"}), frozenset({"case"}), frozenset()):
        b, why = _bucket(card, _req(product_types=ptypes,
                                    subject_refs=(ITEM,)))
        assert b == "eligible", (ptypes, b, why)


def test_grouped_units_down_exact_card_survives():
    """grouped ON + units source พัง → subjects-channel exact card
    ยังถูก select (source failure ไม่ลบ source อื่น)"""
    card = _card()
    plan = td.decide_turn(SYNTH, intent_result=None,
                          active_anchor={"item_id": ITEM},
                          tag_item_ids=(ITEM,))
    profile, _, _ = _chain(SYNTH, plan.needs, anchor=[card])
    def dead_fetcher(*a, **k):
        raise RuntimeError("units down")
    out = rrt.run_grouped_selection(
        profile, message=SYNTH, shop="t", platform="shopee",
        fetcher=dead_fetcher, legacy_fetcher=None,
        subject_cards=[card], needs=plan.needs)
    assert out is not None
    sel_ids = [str(s.card.get("item_id")) for s in out["selection"].selected]
    assert ITEM in sel_ids, sel_ids


def test_exact_card_beats_fuzzy_alternative():
    """exact card ไม่ถูกแทนที่ด้วย ranked alternative ของ source เดียวกัน"""
    exact = _card()
    alt = _card(name="CUKTECH CTL301 สายชาร์จ Lightning", item_id="111")
    plan = td.decide_turn(SYNTH, intent_result=None,
                          active_anchor={"item_id": ITEM},
                          tag_item_ids=(ITEM,))
    profile, _, _ = _chain(SYNTH, plan.needs, anchor=[exact])
    out = rrt.run_grouped_selection(
        profile, message=SYNTH, shop="t", platform="shopee",
        fetcher=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("u")),
        legacy_fetcher=None, subject_cards=[exact, alt], needs=plan.needs)
    sel_ids = [str(s.card.get("item_id")) for s in out["selection"].selected]
    assert ITEM in sel_ids, sel_ids


# ── AnswerContext boundary ────────────────────────────────────────────────

def test_answer_context_keeps_exact_item_id():
    """selected exact card → ctx.products พก item_id='27639651334' (str)
    และ product need ถูก cover (ไม่เข้า unanswered)"""
    card = _card()
    plan = td.decide_turn(SYNTH, intent_result=None,
                          active_anchor={"item_id": ITEM},
                          tag_item_ids=(ITEM,))
    profile, _, _ = _chain(SYNTH, plan.needs, anchor=[card])
    out = rrt.run_grouped_selection(
        profile, message=SYNTH, shop="t", platform="shopee",
        fetcher=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("u")),
        legacy_fetcher=None, subject_cards=[card], needs=plan.needs)
    ctx = acx.compile_answer_context(
        needs=plan.needs, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=profile)
    ids = [str(p.get("item_id")) for p in ctx.products]
    assert ITEM in ids, ids
    assert all(not str(p.get("item_id")).endswith(".0")
               for p in ctx.products)
    prod_idx = {i for i, n in enumerate(plan.needs) if n.kind == "product"}
    unans = {u.need_index for u in ctx.unanswered_needs}
    assert not (prod_idx & unans), ctx.unanswered_needs


# ── conversation boundary (follow-up identity) ────────────────────────────

def test_subject_set_persists_exact_string_id():
    """Q1 → ConversationSubjectSet เก็บ '27639651334' (str, ไม่ float);
    Q2 resolve คืน set เดิม → ต้นทาง subject_cards ของ turn ถัดไป"""
    s1 = cp.decide_subject_set(None, explicit_ids=(ITEM,),
                               requested_operations=("item_card",))
    assert s1 is not None and s1.subject_ids == (ITEM,)
    assert all(isinstance(i, str) for i in s1.subject_ids)
    res = cp.resolve_subjects(s1, "speed data เท่าไหร่?ครับ",
                              subject_scope="current_single")
    assert res.outcome == "resolved" and res.subject_set == s1
    again = cp.decide_subject_set(s1, resolved=res.subject_set)
    assert again is None  # consume-only — subject ยืน


# ── PART 2 — Q2 claim attribution (evidence ต้องเป็นของ exact item) ────────

Q2 = "Speed data เท่าไหร่?ครับ"


def test_q2_deictic_need_with_inferred_types_gets_subject():
    """Q2 เมื่อ intent emit subject_scope=current_single + infer type:
    need มี types={charger} แต่ referent คือ resolved subject — subjects
    channel ต้อง cover need นี้ (inferred type เป็น context ไม่ใช่ identity)
    → ctx = exact item เท่านั้น"""
    ir = {"intent": "product_spec", "product_type": "charger",
          "charger_subtype": "cable", "target_device": None,
          "needs_description": True, "general_qtype": None,
          "confidence": 0.95, "subject_scope": "current_single"}
    plan = td.decide_turn(Q2, intent_result=ir)
    need = plan.needs[0]
    assert need.subject_scope == "current_single"
    assert need.product_types  # inferred types poisoned scope — regression case
    exact = _card()
    alts = [_card(name=f"ALT{i} สายชาร์จ", item_id=str(900 + i))
            for i in range(30)]
    profile, _, _ = _chain(Q2, plan.needs, anchor=[exact])
    out = rrt.run_grouped_selection(
        profile, message=Q2, shop="t", platform="shopee",
        fetcher=lambda *a, **k: list(alts),
        legacy_fetcher=None, subject_cards=[exact], needs=plan.needs)
    ctx = acx.compile_answer_context(
        needs=plan.needs, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=profile)
    ids = [str(p.get("item_id")) for p in ctx.products]
    assert ids == [ITEM], ids


def test_q2_ctx_scoped_to_exact_subject_only():
    """Q2 follow-up + subject resolved: subject_cards=[exact] + fetcher
    คืนสาย 30 ตัว → ctx.products = exact item เท่านั้น (ไม่มี cable อื่น)"""
    exact = _card()
    alts = [_card(name=f"ALT{i} สายชาร์จ", item_id=str(900 + i))
            for i in range(30)]
    plan = td.decide_turn(Q2, intent_result=None)
    profile, _, _ = _chain(Q2, plan.needs, anchor=[exact])
    out = rrt.run_grouped_selection(
        profile, message=Q2, shop="t", platform="shopee",
        fetcher=lambda *a, **k: list(alts),
        legacy_fetcher=None, subject_cards=[exact], needs=plan.needs)
    ctx = acx.compile_answer_context(
        needs=plan.needs, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=profile)
    ids = [str(p.get("item_id")) for p in ctx.products]
    assert ITEM in ids, ids
    assert all(i == ITEM for i in ids), ids


def test_q2_card_fields_self_attributed():
    """ctx card ของ exact item พก spec ของตัวเองเท่านั้น — spec ของ
    candidate อื่นไม่ merge/ทับเข้ามา"""
    exact = _card(canonical_specs={"data_speed": "480Mbps"})
    alt = _card(name="ALT สายชาร์จ", item_id="999",
                canonical_specs={"data_speed": "10Gbps"})
    plan = td.decide_turn(Q2, intent_result=None)
    profile, _, _ = _chain(Q2, plan.needs, anchor=[exact])
    out = rrt.run_grouped_selection(
        profile, message=Q2, shop="t", platform="shopee",
        fetcher=lambda *a, **k: [alt],
        legacy_fetcher=None, subject_cards=[exact], needs=plan.needs)
    ctx = acx.compile_answer_context(
        needs=plan.needs, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=profile)
    mine = next(p for p in ctx.products if str(p.get("item_id")) == ITEM)
    assert (mine.get("canonical_specs") or {}).get("data_speed") == "480Mbps"
    blob = ctx.context_text()
    assert "10Gbps" not in blob, blob


def test_q2_exact_item_evidence_answerable_fields():
    """exact card มี speed evidence (desc excerpt ตอน op admit) →
    serialized ctx มีค่านั้น — claim ตอบได้เฉพาะที่ evidence มีจริง"""
    exact = _card(description_excerpt="รับส่งข้อมูลสูงถึง 480Mbps")
    plan = td.decide_turn(
        "ขอดูรายละเอียดสายชาร์จตัวนี้", intent_result=None)
    ops = {n.operation for n in plan.needs if n.kind == "product"}
    if not (ops & acx._DESC_OPS):
        # op ปัจจุบันไม่ admit desc → ctx ต้องไม่หลุด speed claim
        # (fail-closed: ตอบเฉพาะ field ที่ reach ctx)
        profile, _, _ = _chain("ขอดูรายละเอียด", plan.needs, anchor=[exact])
        out = rrt.run_grouped_selection(
            profile, message="ขอดูรายละเอียด", shop="t", platform="shopee",
            fetcher=lambda *a, **k: [], legacy_fetcher=None,
            subject_cards=[exact], needs=plan.needs)
        ctx = acx.compile_answer_context(
            needs=plan.needs, selection=out["selection"], pool=out["pool"],
            requests=out["requests"], profile=profile)
        assert "480" not in ctx.context_text()
    else:
        profile, _, _ = _chain("ขอดูรายละเอียด", plan.needs, anchor=[exact])
        out = rrt.run_grouped_selection(
            profile, message="ขอดูรายละเอียด", shop="t", platform="shopee",
            fetcher=lambda *a, **k: [], legacy_fetcher=None,
            subject_cards=[exact], needs=plan.needs)
        ctx = acx.compile_answer_context(
            needs=plan.needs, selection=out["selection"], pool=out["pool"],
            requests=out["requests"], profile=profile)
        assert "480Mbps" in ctx.context_text()


def test_q2_speed_evidence_absent_fails_closed():
    """exact card ไม่มี speed field → serialized ctx ไม่มี speed ใดๆ
    → claim ใดๆ เกี่ยวกับ speed = unattributable (deterministic
    no-confirmation ที่ answer layer เท่านั้นที่ถูก)"""
    exact = _card()  # ไม่มี canonical_specs/description_excerpt
    plan = td.decide_turn(Q2, intent_result=None)
    profile, _, _ = _chain(Q2, plan.needs, anchor=[exact])
    out = rrt.run_grouped_selection(
        profile, message=Q2, shop="t", platform="shopee",
        fetcher=lambda *a, **k: [], legacy_fetcher=None,
        subject_cards=[exact], needs=plan.needs)
    ctx = acx.compile_answer_context(
        needs=plan.needs, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=profile)
    blob = ctx.context_text()
    mine = next(p for p in ctx.products if str(p.get("item_id")) == ITEM)
    assert "480" not in blob and "Mbps" not in blob and "Gbps" not in blob
    assert not (mine.get("canonical_specs") or {}).get("data_speed")
