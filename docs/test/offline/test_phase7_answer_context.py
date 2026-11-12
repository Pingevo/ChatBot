"""test_phase7_answer_context.py — Phase 7: bounded typed AnswerContext + pre-answer web gate.

pin:
- AnswerTask/NeedTask = typed task contract (no customer prose crosses the
  grouped-ON answer boundary — mixed product+policy keeps policy text out)
- AnswerContext = sole bounded product-answer payload (per-need quota,
  identity dedupe, hard cap, typed evidence/notes/policy separation)
- RetrievalProfile.value_constraints = single typed owner of price/budget
  constraints (product_store._extract_price_range parsed once at the
  interpretation boundary; retrieval + AnswerTask consume the same result)
- needs_for_request (public) = one canonical request→need attribution owner
- WebAdmission(allowed, reason, need_index, query) = closed typed pre-answer
  web gate — kind alone never admits; unknown → deny
- flag ON: zero-or-one answer-model call; compile failure/empty context →
  deterministic reply with 0 calls; web runs before the only answer call
"""
from __future__ import annotations

import inspect
import json
import sys
from copy import deepcopy
from dataclasses import replace as _dcreplace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
TEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from shopeechat import route_context as rc  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import retrieval_selection as rsel  # noqa: E402
from shopeechat import retrieval_planner as rpl  # noqa: E402
from shopeechat import retrieval_executor as rexec  # noqa: E402
from shopeechat import candidate_pool as cpool  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402  (RED: module new)
from shopeechat import product_store as ps  # noqa: E402
from shopeechat import llm  # noqa: E402

RetrievalRequest = rpl.RetrievalRequest
TurnNeed = td.TurnNeed


@pytest.mark.parametrize("brand,category", [
    ("CukTech", "charger"), ("YOBYBO", "earphone"), ("Xiaomi", "air_purifier"),
])
@pytest.mark.parametrize("count", [1, 10])
def test_compact_product_context_is_lossless_and_keeps_safety_sections(brand, category, count):
    products = tuple({
        "item_id": str(i), "name": f'{brand} สินค้าทดสอบ "รุ่น" {i}',
        "brand": brand, "category": category, "need_indices": [3],
        "price": {"min": 199, "max": 299}, "sold_out": False,
        "variants": [{"name": "ขาว\\ดำ\nรุ่นย่อย", "stock": 0, "price": None}],
        "canonical_specs": {"fixture_fact": "ข้อมูลทดสอบ ไม่ใช่สเปคจริง"},
    } for i in range(count))
    original = deepcopy(products)
    ctx = acx.AnswerContext(
        task=acx.AnswerTask(tasks=(acx.NeedTask(
            kind="product", operation="describe", need_index=3),)),
        products=products,
        evidence=({"kind": "kb", "need_indices": [3], "identity": "i:0",
                   "payload": "หลักฐานทดสอบ ห้ามแต่งสเปค"},),
        availability_notes=({"name": "สินค้าหมดทดสอบ"},),
        constraint_notes=({"item": "สินค้าทดสอบ", "detail": "ยังพิสูจน์ไม่ได้"},),
        unanswered_needs=(), estimated_tokens=0)
    rendered = ctx.context_text(shop_hint="ร้านทดสอบ")
    header, body = rendered.split("\n\n", 1)
    payload, end = json.JSONDecoder().raw_decode(body)
    expected = [{**p, "need_indices": [1]} for p in products]
    assert payload == expected
    assert products == original
    compact = json.dumps(expected, ensure_ascii=False, separators=(",", ":"))
    assert body[:end] == compact
    suffix = body[end:]
    for text in ("หลักฐานทดสอบ ห้ามแต่งสเปค", "สินค้าหมดทดสอบ", "ยังพิสูจน์ไม่ได้"):
        assert text in suffix
    assert "ห้ามเสนอ/แนะนำ/เปรียบเทียบสินค้าจากร้านอื่น" in header
    before = header + "\n\n" + json.dumps(expected, ensure_ascii=False, indent=2) + suffix
    assert len(rendered.encode()) < len(before.encode())
    assert acx.estimate_tokens(rendered) < acx.estimate_tokens(before)
    print(f"{brand}/{category}/{count}: bytes {len(before.encode())}->{len(rendered.encode())}; "
          f"estimated_tokens {acx.estimate_tokens(before)}->{acx.estimate_tokens(rendered)}")


# ── builders ────────────────────────────────────────────────────────────────

def _req(rid="req-0", slot="slot-a", source="slot", types=("earphone",),
         subs=(), codes=(), target=None, soft=(), hard=(), rel=None,
         rel_type=None, cm="none", variants=(), vc=()):
    return RetrievalRequest(
        request_id=rid, slot_id=slot, source=source,
        product_types=frozenset(types), subtypes=frozenset(subs),
        model_codes=tuple(codes), target_device=target,
        availability_mode="sellable_first", compat_mode=cm,
        hard_filters=tuple(hard), soft_hints=tuple(soft), relation_id=rel,
        relation_type=rel_type,
        variant_terms=tuple(variants), value_constraints=tuple(vc))


def _sel_card(identity, role, rid, name, score=1.0, **card_kw):
    card = {"name": name, "item_id": identity.split(":")[-1],
            "model_codes": [], "sellable": True,
            "customer_visibility": "visible", "price": {"min": 300, "max": 300}}
    card.update(card_kw)
    return rsel.SelectedCandidate(
        role=role, request_id=rid, slot_id="s", relation_id=None,
        identity=identity, score=score, constraint_hits=(), reason="ok",
        card=card)


def _selection(*entries):
    """entries = (SelectedCandidate, request_id) — by_request grouped."""
    selected = tuple(e[0] for e in entries)
    by_req: dict[str, list] = {}
    for sc, rid in entries:
        by_req.setdefault(rid, []).append(sc)
    return rsel.SelectionResult(
        selected=selected,
        by_request=tuple((rid, tuple(cs)) for rid, cs in by_req.items()),
        unavailable_evidence=(), rejected_summary=(), trace=())


def _pooled(identity, item_id="1", bucket="eligible", codes=(),
            request_ids=("req-0",), name="P"):
    card = {"name": name, "item_id": item_id, "model_codes": list(codes),
            "customer_visibility": "visible"}
    return cpool.PooledCandidate(
        identity=identity, item_id=item_id, model_id=None, unit_id=None,
        sources=("legacy",), request_ids=tuple(request_ids), slot_id="s",
        relation_id=None, product_type="earphone", subtype=None,
        bucket=bucket, reason="ok", score=1.0, trace=(), card=card)


def _pool(eligible=(), unavailable=(), rejected=(), supporting=(),
          evidence_pool=()):
    return cpool.CandidatePool(
        eligible=tuple(eligible), unavailable=tuple(unavailable),
        rejected=tuple(rejected), by_request=(), evidence_pool=tuple(evidence_pool),
        supporting_evidence=tuple(supporting), trace=())


def _profile(msg="ทดสอบ", **kw):
    base = dict(history=[], intent_result={}, shop="S", platform="shopee")
    base.update(kw)
    return rc.build_retrieval_profile(msg, **base)


def _compile(needs, selection, pool, requests, profile, **kw):
    task = acx.compile_answer_task(
        needs=needs, selection=selection, requests=requests, pool=pool,
        profile=profile)
    return acx.compile_answer_context(
        task=task, needs=needs, selection=selection, pool=pool,
        requests=requests, profile=profile, **kw)


# ── 1/2/3: task purity — no customer prose crosses the boundary ─────────────

def test_raw_customer_prose_cannot_reach_answer_typed():
    sig = inspect.signature(llm.answer_typed)
    for forbidden in ("message", "products", "extra_context"):
        assert forbidden not in sig.parameters, (
            f"answer_typed must not accept {forbidden!r}")
    # task render is generated from typed fields — a sentinel phrase that
    # exists ONLY in the customer message must never appear in the task text
    sentinel = "SENTINEL_PROSE_คืนสินค้าช่องทางไหน"
    msg = f"AC65B ราคาเท่าไหร่ {sentinel}"
    plan = td.decide_turn(msg, history=[], intent_result={"intent": "product_spec",
                                                        "confidence": 0.9})
    sc = _sel_card("i:1", "subject", "req-0", "AC65B Adapter", codes=["AC65B"])
    req = _req(codes=("AC65B",))
    sel = _selection((sc, "req-0"))
    ctx = _compile(plan.needs, sel,
                   _pool((_pooled("i:1", "1", codes=("AC65B",)),)),
                   (req,), _profile(msg))
    rendered = ctx.task.render() + ctx.context_text()
    assert sentinel not in rendered


def test_product_task_carries_only_typed_need_info():
    need = TurnNeed(kind="product", operation="price",
                    subject_refs=("AC65B",),
                    product_types=frozenset({"charger"}))
    sc = _sel_card("i:1", "subject", "req-0", "AC65B 65W Adapter")
    sel = _selection((sc, "req-0"))
    ctx = _compile((need,), sel, _pool((_pooled("i:1", "1"),)),
                   (_req(codes=("AC65B",), types=("charger",)),), _profile())
    assert len(ctx.task.tasks) == 1
    t = ctx.task.tasks[0]
    assert t.kind == "product" and t.operation == "price"
    assert t.subject_refs == ("AC65B",)
    rendered = ctx.task.render()
    assert "AC65B" in rendered            # typed subject ref
    assert "AC65B 65W Adapter" in rendered  # resolved card name (DB data)


def test_mixed_product_policy_task_has_no_policy_prose():
    plan = td.decide_turn(
        "แนะนำหูฟังงบ 500 แล้วคืนสินค้าได้ไหม", history=[],
        intent_result={"intent": "general_question",
                       "general_qtype": "return_policy", "confidence": 0.9})
    kinds = {n.kind for n in plan.needs}
    assert "policy" in kinds and kinds & td.PRODUCTISH_NEED_KINDS, (
        f"fixture must produce a real mixed plan, got {plan.needs}")
    ctx = _compile(plan.needs, _selection(), _pool(), (), _profile())
    for t in ctx.task.tasks:
        assert t.kind in td.PRODUCTISH_NEED_KINDS
    rendered = ctx.task.render()
    for policy_word in ("คืนสินค้า", "return", "เปลี่ยน", "เคลม"):
        assert policy_word not in rendered
    # policy decisions ไม่มี consumer ใน Phase 7 product context (Phase 8
    # เจ้าของ) — field ถูกถอดออกแล้ว
    assert not hasattr(ctx, "policy_decisions")


# ── 4/5/6: typed value constraints — one parser, one typed result ───────────

def test_value_constraints_carried_into_need_task():
    msg = "แนะนำหูฟัง งบ 500"
    prof = _profile(msg, intent_result={"intent": "product_recommend",
                                        "product_type": "earphone",
                                        "confidence": 0.9})
    assert prof.value_constraints, "profile must carry typed price constraint"
    assert ("price_max", 500) in prof.value_constraints
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"earphone"}))
    req = _req(types=("earphone",), vc=prof.value_constraints)
    sel = _selection(
        (_sel_card("i:1", "subject", "req-0", "Earphone X",
                   model_codes=["EAR-1"]), "req-0"),)
    ctx = _compile((need,), sel, _pool(), (req,), prof)
    assert ("price_max", 500) in ctx.task.tasks[0].value_constraints
    assert "500" in ctx.task.render()


def test_retrieval_and_task_share_same_value_result():
    msg = "สายชาร์จ งบ 300-800"
    prof = _profile(msg)
    slots = rc.build_retrieval_slots(prof)
    reqs = rpl.build_grouped_retrieval_requests(prof, slots, ())
    assert reqs, "browse message must produce slot requests"
    for r in reqs:
        assert r.value_constraints == prof.value_constraints
        # executor synthetic profile carries the same typed result
        assert rexec._request_profile(r, msg, "S", "shopee").value_constraints \
            == prof.value_constraints
    # product_store resolver: typed profile value wins over prose re-parse
    lo, hi = ps._price_bounds(prof, "งบ 99999")
    assert (lo, hi) == tuple(
        dict(prof.value_constraints).get(k)
        for k in ("price_min", "price_max")), (lo, hi)


def test_value_extraction_not_duplicated():
    src = inspect.getsource(ps.fetch_products)
    assert "_extract_price_range(" not in src, (
        "fetch_products must consume the typed value via _price_bounds, "
        "not re-parse the message")
    resolver_src = inspect.getsource(ps._price_bounds)
    assert "_extract_price_range" in resolver_src, (
        "the single existing parser remains the profile-less fallback")
    # one typed owner: profile field produced once at interpretation boundary
    assert "value_constraints" in {f.name for f in
                                   rc.RetrievalProfile.__dataclass_fields__.values()}


# ── 7/8/19: attribution + ordering + isolation ──────────────────────────────

def test_explicit_subject_outranks_contextual():
    need = TurnNeed(kind="product", operation="describe",
                    subject_refs=("AC65B",),
                    product_types=frozenset({"charger"}))
    subj = _sel_card("i:1", "subject", "req-0", "AC65B Subject Card",
                     score=1.0, codes=["AC65B"])
    alt = _sel_card("i:2", "slot", "req-0", "Generic Slot Card", score=9.0)
    sel = _selection((subj, "req-0"), (alt, "req-0"))
    ctx = _compile((need,), sel, _pool(), (_req(codes=("AC65B",)),), _profile())
    names = [p["name"] for p in ctx.products]
    assert names[0] == "AC65B Subject Card", names


def test_request_to_need_attribution_single_owner():
    assert not hasattr(rsel, "_needs_for_request"), (
        "private copy must be removed — public owner only")
    assert callable(rsel.needs_for_request)
    assert "needs_for_request(" in inspect.getsource(
        rsel.select_for_llm_context), "selector must consume the same owner"
    assert not hasattr(acx, "_needs_for_request"), (
        "no attribution copy inside the compiler")


def test_pseudo_intent_type_does_not_scope_gate_candidates():
    # q182-shaped live defect: intent product_spec conf 0.95 +
    # product_type="other" (classifier catch-all — ไม่ใช่ canonical sellable
    # type) — need ต้อง scope ว่าง; selected card ที่ valid ต้องไม่ถูก
    # product scope gate ทิ้ง → evidence ต้องถึง AnswerContext
    msg = ("CUKTECH A18T 30W GaN หัวชาร์จ / CTC กับ "
           "[ลดเหลือ 50] สายสำรอง Huawei Band 6 ต่างกันยังไง")
    plan = td.decide_turn(msg, history=[], intent_result={
        "intent": "product_spec", "product_type": "other",
        "charger_subtype": None, "subject_scope": "current_set",
        "subject_count": 2, "confidence": 0.95})
    prodish = [n for n in plan.needs if n.kind in ("product", "compare")]
    assert prodish, plan.needs
    assert all("other" not in n.product_types for n in prodish), (
        f"pseudo-type 'other' ห้ามเป็น need scope — "
        f"{[(n.kind, n.product_types) for n in prodish]}")
    sc = _sel_card("i:1", "subject", "req-0", "CUKTECH A18T 30W GaN",
                   canonical_type="charger", model_codes=["A18T"])
    sel = _selection((sc, "req-0"))
    ctx = _compile(plan.needs, sel,
                   _pool((_pooled("i:1", "1", codes=("A18T",)),)),
                   (_req(types=("charger",), codes=("A18T",)),),
                   _profile(msg))
    assert ctx.products, (
        "valid selected card ต้องไม่ถูกทิ้งเพราะ pseudo-type scope")


def test_pseudo_intent_type_unscoped_need_attributes_and_reaches_context():
    # q184-shaped live defect: intent product_recommend conf 0.95 +
    # product_type="other" — need ต้อง attribute แบบ unscoped เข้า
    # dashcam/camera slot requests และ selected evidence ต้องไปถึง
    # AnswerContext (ก่อนแก้: {'other'} ∩ {'dashcam','camera'} = ∅ →
    # ไม่ attribute → no_selection)
    msg = ("[ลดเหลือ 1649] iSUPER Dash Cam Lite กับ "
           "[ลดเหลือ 1649] iSUPER Dash Cam Lite เลือกตัวไหนดี")
    plan = td.decide_turn(msg, history=[], intent_result={
        "intent": "product_recommend", "product_type": "other",
        "charger_subtype": None, "confidence": 0.95})
    prodish = [n for n in plan.needs if n.kind in ("product", "compare")]
    assert prodish, plan.needs
    dash = _req(rid="req-0", slot="slot-dashcam", types=("dashcam",))
    cam = _req(rid="req-1", slot="slot-camera", types=("camera",))
    for n in prodish:
        assert n in rsel.needs_for_request(dash, plan.needs), (
            f"unscoped need ต้อง attribute เข้า dashcam request — {n}")
        assert n in rsel.needs_for_request(cam, plan.needs), (
            f"unscoped need ต้อง attribute เข้า camera request — {n}")
    sc = _sel_card("i:1", "slot", "req-0", "iSUPER Dash Cam Lite",
                   canonical_type="dashcam")
    sel = _selection((sc, "req-0"))
    ctx = _compile(plan.needs, sel, _pool(), (dash, cam), _profile(msg))
    assert ctx.products, (
        "selected evidence ต้องไปถึง AnswerContext — ไม่ใช่ no_selection")


def test_unrelated_need_gets_no_other_products():
    # selection produced under need A's request; compile with unrelated need B
    need_b = TurnNeed(kind="product", operation="recommend",
                      product_types=frozenset({"smartwatch"}))
    sc = _sel_card("i:9", "slot", "req-0", "Earphone Card")
    sel = _selection((sc, "req-0"))
    ear_req = _req(types=("earphone",))
    ctx = _compile((need_b,), sel, _pool(), (ear_req,), _profile())
    assert ctx.products == (), (
        "products attributed only via needs_for_request must not leak "
        "into an unrelated need's context")
    assert ctx.unanswered_needs and ctx.unanswered_needs[0].kind == "product"


# ── 9/10/11/12/13: flag + answer-call truth table ───────────────────────────

def _final_text(out):
    """customer-visible text ของ composition — finalizer render owner
    (_render_composition + EMPTY fallback); Phase 8 migration จาก
    _final_text(out) dict access."""
    from shopeechat import app as _a
    return _a._render_composition(out) or acx.EMPTY_CONTEXT_REPLY


def _fake_grouped_sel(needs, profile, cards=(), supporting=()):
    prodish = [n for n in needs if n.kind in td.PRODUCTISH_NEED_KINDS]
    reqs = tuple(
        _req(types=tuple(sorted(n.product_types) or ["earphone"]))
        for n in prodish) or (_req(),)
    sel = rsel.SelectionResult(
        selected=tuple(cards),
        by_request=((reqs[0].request_id, tuple(cards)),) if cards else (),
        unavailable_evidence=(), rejected_summary=(), trace=())
    return {"selection": sel, "pool": _pool(supporting=supporting),
            "requests": reqs, "summary": {"selected_total": len(cards)}}


def test_flag_off_preserves_legacy_boundary():
    src = inspect.getsource(
        __import__("shopeechat.app", fromlist=["app"])._chat_impl)
    assert "if _sel_flag:" in src
    assert "_typed_answer_boundary(" in src, (
        "flag-ON boundary must route through the typed owner")
    # legacy call still present for flag OFF
    assert "llm.answer(" in src


def test_flag_on_compiler_once_answer_once(monkeypatch):
    from shopeechat import app as _app
    calls = {"typed": 0}
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **k: (calls.__setitem__("typed",
                                                     calls["typed"] + 1),
                                     ("ok", {"prompt": 1, "output": 1,
                                             "total": 2}))[1])
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"earphone"}))
    sc = _sel_card("i:1", "slot", "req-0", "EP Card")
    gs = _fake_grouped_sel((need,), _profile(), cards=(sc,))
    out = _app._typed_answer_boundary(
        gs, needs=(need,), profile=_profile(), web_configured=False)
    assert calls["typed"] == 1 and out.answer_calls == 1


def test_compiler_failure_zero_model_calls(monkeypatch):
    from shopeechat import app as _app
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **k: pytest.fail("answer_typed must not run"))
    out = _app._typed_answer_boundary(
        None, needs=(), profile=_profile(), web_configured=False)
    assert out.answer_calls == 0 and _final_text(out)
    out2 = _app._typed_answer_boundary(
        {"selection": None}, needs=(), profile=_profile(),
        web_configured=False)
    assert out2.answer_calls == 0


def test_fully_empty_context_zero_calls(monkeypatch):
    from shopeechat import app as _app
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **k: pytest.fail("answer_typed must not run"))
    gs = _fake_grouped_sel((), _profile())  # no needs → no tasks/products
    out = _app._typed_answer_boundary(gs, needs=(), profile=_profile(),
                                      web_configured=False)
    assert out.answer_calls == 0 and _final_text(out) == acx.EMPTY_CONTEXT_REPLY


def test_empty_products_with_evidence_one_typed_call(monkeypatch):
    from shopeechat import app as _app
    calls = {"typed": 0}
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **k: (calls.__setitem__("typed",
                                                     calls["typed"] + 1),
                                     ("ok", {}))[1])
    need = TurnNeed(kind="product", operation="describe",
                    subject_refs=("AC65B",))
    gs = _fake_grouped_sel((need,), _profile(),
                           supporting=({"kind": "vision",
                                        "subject_refs": ("AC65B",),
                                        "text": "รูปสายชาร์จ"},))
    out = _app._typed_answer_boundary(
        gs, needs=(need,), profile=_profile(), web_configured=False)
    assert calls["typed"] == 1 and out.answer_calls == 1


# ── 14/15: typed web admission truth table ──────────────────────────────────

def _ext_need(op="compat", kind="compat", refs=("AC65B",), target=True):
    n = TurnNeed(kind=kind, operation=op, subject_refs=tuple(refs))
    reqs = (_req(codes=("AC65B",),
                 target="galaxy z99 fakephone" if target else None,
                 cm="connector_required"),)
    pool = _pool((_pooled("i:1", "1", codes=("AC65B",)),))
    return n, reqs, pool


@pytest.mark.parametrize("op", ["price", "stock", "link"])
def test_web_deny_local_fact_ops(op):
    n, reqs, pool = _ext_need(op=op, kind="product")
    adm = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=pool, requests=reqs,
        profile=_profile(), web_configured=True)
    assert not adm.allowed and adm.reason == "local_fact_operation"


def test_web_deny_catalog_existence():
    n = TurnNeed(kind="product", operation="recommend",
                 product_types=frozenset({"earphone"}))
    adm = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=_pool(),
        requests=(_req(types=("earphone",)),), profile=_profile(),
        web_configured=True)
    assert not adm.allowed and adm.reason == "local_catalog_existence"


def test_web_deny_unresolved_identity():
    n = TurnNeed(kind="compat", operation="compat",
                 subject_refs=("ZZZ-NOPE",))
    adm = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=_pool(),
        requests=(_req(codes=("ZZZ-NOPE",), target="galaxy z99 fakephone"),),
        profile=_profile(), web_configured=True)
    assert not adm.allowed and adm.reason == "unresolved_local_identity"


def test_web_deny_missing_target_and_variant():
    n = TurnNeed(kind="compat", operation="compat", subject_refs=("AC65B",))
    _, reqs, pool = _ext_need(target=False)
    adm = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=pool, requests=reqs,
        profile=_profile(), web_configured=True)
    assert not adm.allowed and adm.reason == "no_external_target"
    # variant ask = local fact — variant_terms present, no external target
    nv = TurnNeed(kind="product", operation="describe",
                  subject_refs=("AC65B",))
    reqv = _req(codes=("AC65B",), variants=("สีแดง",))
    adm2 = acx.decide_web_admission(
        needs=(nv,), selection=_selection(), pool=pool, requests=(reqv,),
        profile=_profile(), web_configured=True)
    assert not adm2.allowed


def test_web_deny_local_evidence_sufficient():
    # pool-only evidence: device_spec record ของ target เดียวกันต้องมาจาก
    # supporting evidence ที่ produce แล้ว — admission ไม่ re-call spec
    # resolver อีก (Phase 7 review finding E)
    n = TurnNeed(kind="compat", operation="compat", subject_refs=("AC65B",))
    reqs = (_req(codes=("AC65B",), target="iphone 15"),)
    pool = _pool((_pooled("i:1", "1", codes=("AC65B",)),),
                 supporting=({"kind": "device_spec", "target": "iphone 15",
                              "data": {"port": "usb-c"}},))
    adm = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=pool, requests=reqs,
        profile=_profile(), web_configured=True)
    assert not adm.allowed and adm.reason == "local_evidence_sufficient"
    # ไม่มี spec record ใน pool → external evidence ยังขาด → admit
    pool_no_spec = _pool((_pooled("i:1", "1", codes=("AC65B",)),))
    adm2 = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=pool_no_spec,
        requests=reqs, profile=_profile(), web_configured=True)
    assert adm2.allowed


def test_web_deny_already_supplied_and_unconfigured_and_covered():
    n, reqs, pool = _ext_need()
    pool_web = _pool((_pooled("i:1", "1", codes=("AC65B",)),),
                     supporting=({"kind": "web",
                                  "target": "galaxy z99 fakephone"},))
    adm = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=pool_web, requests=reqs,
        profile=_profile(), web_configured=True)
    assert not adm.allowed and adm.reason == "web_already_supplied"
    adm2 = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=pool, requests=reqs,
        profile=_profile(), web_configured=False)
    assert not adm2.allowed and adm2.reason == "not_configured"
    # covered need → never admits (no-target need + selected catalog card)
    n3 = TurnNeed(kind="product", operation="describe",
                  subject_refs=("AC65B",))
    reqs3 = (_req(codes=("AC65B",), target=None),)
    sc = _sel_card("i:1", "subject", "req-0", "AC65B")
    adm3 = acx.decide_web_admission(
        needs=(n3,), selection=_selection((sc, "req-0")), pool=pool,
        requests=reqs3, profile=_profile(), web_configured=True)
    assert not adm3.allowed and adm3.reason == "covered"


def test_web_allow_unanswered_external_evidence_need():
    n, reqs, pool = _ext_need()
    adm = acx.decide_web_admission(
        needs=(n,), selection=_selection(), pool=pool, requests=reqs,
        profile=_profile(), web_configured=True)
    assert adm.allowed and adm.reason == "admitted_external_evidence_need"
    assert adm.need_index == 0 and "galaxy z99 fakephone" in adm.query


# ── 16/17: web-before-answer + at-most-one call ─────────────────────────────

def test_web_runs_before_only_answer_call(monkeypatch):
    from shopeechat import app as _app
    order: list[str] = []
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **k: (order.append("answer"), ("ok", {}))[1])
    n, reqs, pool = _ext_need()
    # subject card ที่ web-structured spec พิสูจน์ verdict ได้จริง
    # (connector usb-c ทั้งสองฝั่ง → resolve_compat → compatible)
    card = _sel_card("i:1", "slot", "req-0", "AC65B C to C cable",
                     model_codes=["AC65B"])
    gs = {"selection": _selection((card, "req-0")), "pool": pool,
          "requests": reqs, "summary": {}}

    def _web(**kw):
        order.append("web")
        return {"search_info": "galaxy z99 fakephone spec: usb-c",
                "device_specs": [{"device": "galaxy z99 fakephone",
                                  "connector": "usb-c"}]}

    out = _app._typed_answer_boundary(
        gs, needs=(n,), profile=_profile(), web_configured=True,
        web_search_fn=lambda **kw: _web(**kw))
    # connector match → exact-relation verdict → deterministic compat
    # segment (answer model ไม่ถูกเรียก — compat-only authoritative)
    assert order == ["web"], order
    assert out.answer_calls == 0 and out.web_used
    res = [r for r in out.results if r.domain == "compat"]
    assert res and "ใช้งานร่วมกับ" in res[0].text


def test_web_no_new_evidence_still_one_answer_call(monkeypatch):
    from shopeechat import app as _app
    calls = {"typed": 0, "web": 0}
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **k: (calls.__setitem__("typed",
                                                     calls["typed"] + 1),
                                     ("ok", {}))[1])
    n, reqs, pool = _ext_need()
    gs = {"selection": _selection(), "pool": pool, "requests": reqs,
          "summary": {}}
    out = _app._typed_answer_boundary(
        gs, needs=(n,), profile=_profile(), web_configured=True,
        web_search_fn=lambda **kw: (calls.__setitem__(
            "web", calls["web"] + 1), {})[1])
    # web ไม่ให้ evidence → context ว่าง → deterministic (0 calls) หรืออย่างมาก
    # typed call เดียว — invariant คือ "never more than one answer call"
    assert calls["web"] == 1 and calls["typed"] <= 1
    assert out.answer_calls <= 1 and not out.web_used


# ── 18/20: media paths + mixed fail-closed ──────────────────────────────────

def test_media_paths_retain_typed_task_and_evidence():
    # evidence ต้องมี typed attribution: vision → subject_refs ของ need;
    # attachment → linked_candidate → pooled cand (request_ids→need)
    need = TurnNeed(kind="product", operation="describe",
                    subject_refs=("AC65B",))
    req = _req(rid="req-0", source="subjects", codes=("AC65B",))
    sel = _selection((_sel_card("i:1", "subject", "req-0", "AC65B",
                              codes=["AC65B"]), "req-0"))
    att = cpool.EvidenceAttachment(
        kind="image_text", identity="i:1", item_id="1",
        linked_candidate="i:1", payload={"text": "AC65B label"})
    pool = _pool(eligible=(_pooled("i:1", "1", codes=("AC65B",),
                                   request_ids=("req-0",)),),
                 supporting=({"kind": "vision", "text": "รูปสินค้า",
                              "subject_refs": ("AC65B",)},),
                 evidence_pool=(att,))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    kinds = {e.get("kind") for e in ctx.evidence}
    assert {"vision", "image_text"} <= kinds, kinds
    assert all(e["need_indices"] == (0,) for e in ctx.evidence)
    assert ctx.task.tasks[0].subject_refs == ("AC65B",)


def test_mixed_product_policy_stays_fail_closed():
    # contract level: policy kind can never become a NeedTask; deferred
    # kinds ไม่มี consumer ใน product context → unanswered (Phase 8 owns)
    plan = td.decide_turn(
        "แนะนำหูฟังงบ 500 แล้วคืนสินค้าได้ไหม", history=[],
        intent_result={"intent": "general_question",
                       "general_qtype": "return_policy", "confidence": 0.9})
    ctx = _compile(plan.needs, _selection(), _pool(), (), _profile())
    assert all(t.kind != "policy" for t in ctx.task.tasks)
    assert not hasattr(ctx, "policy_decisions")
    deferred = [u for u in ctx.unanswered_needs if u.reason == "deferred"]
    assert deferred, ctx.unanswered_needs
    # production fail-closed gate still precedes the boundary (source order)
    src = inspect.getsource(
        __import__("shopeechat.app", fromlist=["app"])._chat_impl)
    assert src.index("_pdec") < src.index("_typed_answer_boundary(")


# ── misc contract: bounds + dedupe + hidden + estimate ──────────────────────

def test_per_need_quota_and_hard_cap_and_dedupe():
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"earphone"}))
    cards = [_sel_card(f"i:{i}", "slot", "req-0", f"EP{i}", score=i)
             for i in range(20)]
    sel = _selection(*[(c, "req-0") for c in cards])
    ctx = _compile((need,), sel, _pool(), (_req(),), _profile())
    assert len(ctx.products) <= 4  # per-need quota
    # same identity served under two needs → once
    n2 = TurnNeed(kind="product", operation="describe",
                  product_types=frozenset({"earphone"}))
    shared = _sel_card("i:1", "slot", "req-0", "Shared")
    sel2 = _selection((shared, "req-0"))
    ctx2 = _compile((need, n2), sel2, _pool(), (_req(),), _profile())
    assert [p["name"] for p in ctx2.products].count("Shared") == 1


def test_hidden_identity_never_enters_context():
    need = TurnNeed(kind="product", operation="describe",
                    product_types=frozenset({"earphone"}))
    hid = _sel_card("i:9", "slot", "req-0", "Hidden UNLIST",
                    customer_visibility="hidden")
    ctx = _compile((need,), _selection((hid, "req-0")), _pool(), (_req(),),
                   _profile())
    assert all("UNLIST" not in str(p.get("name")) for p in ctx.products)


def test_estimated_tokens_conservative_and_labeled():
    ctx = _compile((TurnNeed(kind="product", operation="recommend",
                             product_types=frozenset({"earphone"})),
                    ), _selection(), _pool(), (_req(),), _profile())
    assert ctx.estimated_tokens >= 0
    thai = "หูฟังบลูทูธงบห้าร้อย"
    est = acx.estimate_tokens(thai)
    assert est >= len(thai) - 1  # conservative: Thai ≥~1 token/char bound


def test_estimated_tokens_counts_payload():
    cards = [_sel_card(f"i:{i}", "slot", "req-0", f"EP{i}")
             for i in range(4)]
    sel = _selection(*[(c, "req-0") for c in cards])
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"earphone"}))
    ctx = _compile((need,), sel, _pool(), (_req(),), _profile())
    assert ctx.estimated_tokens > 100, "cards must contribute to estimate"


# ── audit H3 — visible task ordinals vs serialized need_indices ─────────────

def _dropped_compat_need(refs, target, types, rid, card_name):
    """uncovered compat need: slot-carried target + card + ไม่มี proof →
    verdict required, dec=None → uncovered → task dropped"""
    need = TurnNeed(kind="compat", operation="compat",
                    subject_refs=tuple(refs),
                    product_types=frozenset(types))
    req = _req(rid=rid, types=tuple(types), codes=tuple(refs),
               target=target, cm="bluetooth_general")
    card = _sel_card(f"i:{rid[-1]}", "subject", rid, card_name,
                     model_codes=list(refs))
    return need, req, card


def test_dropped_need_shifts_serialized_ordinals():
    """need0 dropped → surviving need1 renders งานที่ 1 และ serialized
    need_indices ต้อง map เป็น ordinal เดียวกัน (ไม่ใช่ index เดิม+1=2)"""
    n0, req0, c0 = _dropped_compat_need(
        ("W01",), "strava", ("smartwatch",), "req-0", "W01 watch")
    n1 = TurnNeed(kind="product", operation="recommend",
                  product_types=frozenset({"earphone"}))
    sc = _sel_card("i:9", "subject", "req-1", "Earphone X")
    sel = _selection((c0, "req-0"), (sc, "req-1"))
    req1 = _req(rid="req-1", types=("earphone",))
    ctx = _compile((n0, n1), sel, _pool((_pooled("i:9", "9",
                                                request_ids=("req-1",)),)),
                   (req0, req1), _profile())
    assert ctx.task.tasks and all(
        t.need_index == 1 for t in ctx.task.tasks), (
        "surviving task ต้องเก็บ original need_index=1 (ไม่ renumber)")
    assert "งานที่ 1" in ctx.task.render() \
        and "งานที่ 2" not in ctx.task.render()
    body = ctx.context_text()
    assert "งานที่ 2" not in body, (
        "serialized need_indices ต้อง map เป็น visible ordinal — "
        "index เดิม+1=2 ชี้ผิดงาน")
    products, _ = json.JSONDecoder().raw_decode(body.split("\n\n", 1)[1])
    assert {p["item_id"]: p["need_indices"] for p in products} == {"9": [1]}


def test_multiple_drops_before_survivor_maps_to_one():
    """needs 0,1 dropped → need2 survive = งานที่ 1 เสมอ"""
    n0, req0, c0 = _dropped_compat_need(
        ("W01",), "strava", ("smartwatch",), "req-0", "W01 watch")
    n0b, req0b, c0b = _dropped_compat_need(
        ("AC9",), "gps watch", ("tv",), "req-2", "AC9 box")
    n2 = TurnNeed(kind="product", operation="recommend",
                  product_types=frozenset({"earphone"}))
    sc = _sel_card("i:9", "subject", "req-1", "Earphone X")
    sel = _selection((c0, "req-0"), (c0b, "req-2"), (sc, "req-1"))
    req1 = _req(rid="req-1", types=("earphone",))
    ctx = _compile((n0, n0b, n2), sel,
                   _pool((_pooled("i:9", "9", request_ids=("req-1",)),)),
                   (req0, req0b, req1), _profile())
    body = ctx.context_text()
    assert "งานที่ 2" not in body and "งานที่ 3" not in body
    products, _ = json.JSONDecoder().raw_decode(body.split("\n\n", 1)[1])
    assert {p["item_id"]: p["need_indices"] for p in products} == {"9": [1]}


def test_two_surviving_needs_keep_ordinals():
    """needs 0,2 survive / 1 dropped → ordinals 1,2 (ไม่ใช่ 1,3)"""
    n0 = TurnNeed(kind="product", operation="recommend",
                  product_types=frozenset({"earphone"}))
    n1, req1, c1 = _dropped_compat_need(
        ("W01",), "strava", ("smartwatch",), "req-1", "W01 watch")
    n2 = TurnNeed(kind="product", operation="describe",
                  product_types=frozenset({"cable"}))
    sc0 = _sel_card("i:9", "subject", "req-0", "Earphone X")
    sc2 = _sel_card("i:8", "subject", "req-2", "Cable Y")
    sel = _selection((sc0, "req-0"), (c1, "req-1"), (sc2, "req-2"))
    req0 = _req(rid="req-0", types=("earphone",))
    req2 = _req(rid="req-2", types=("cable",))
    ctx = _compile((n0, n1, n2), sel,
                   _pool((_pooled("i:9", "9", request_ids=("req-0",)),
                         _pooled("i:8", "8", request_ids=("req-2",)))),
                   (req0, req1, req2), _profile())
    rendered = ctx.task.render()
    assert rendered.count("งานที่") == 2
    body = ctx.context_text()
    assert "งานที่ 3" not in body
    products, _ = json.JSONDecoder().raw_decode(body.split("\n\n", 1)[1])
    assert {p["item_id"]: p["need_indices"] for p in products} == {"9": [1], "8": [2]}


def test_product_with_only_dropped_owner_excluded():
    """decided compat need → task dropped → card ที่มี owner เฉพาะ need
    นั้นต้องไม่เข้า model context (verdict deterministic อยู่แล้ว)"""
    need = TurnNeed(kind="compat", operation="compat",
                    subject_refs=("AC65B",),
                    product_types=frozenset({"cable"}))
    req = _req(types=("cable",), codes=("AC65B",), target="iphone 15",
               cm="connector_required")
    card = _sel_card("i:1", "subject", "req-0", "สายชาร์จ C to C",
                     model_codes=["AC65B"], connector="usb-c")
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"connector": "usb-c", "source": "spec-db"},
         "subject_refs": ("i:1",)},))
    ctx = _compile((need,), _selection((card, "req-0")), pool,
                   (req,), _profile())
    assert ctx.compat_verdicts, "setup: need decided → task dropped"
    body = ctx.context_text()
    assert "สายชาร์จ C to C" not in body, (
        "card ที่ own โดย decided/dropped need เท่านั้น ต้องไม่เข้า "
        "model context — verdict segment แยก deterministic อยู่แล้ว")


def test_no_drop_baseline_ordinals_unchanged():
    """baseline: ไม่มี drop → indices 0,1 → ordinals 1,2 เหมือนเดิม"""
    n0 = TurnNeed(kind="product", operation="recommend",
                  product_types=frozenset({"earphone"}))
    n1 = TurnNeed(kind="product", operation="describe",
                  product_types=frozenset({"cable"}))
    sc0 = _sel_card("i:9", "subject", "req-0", "Earphone X")
    sc1 = _sel_card("i:8", "subject", "req-1", "Cable Y")
    ctx = _compile((n0, n1),
                   _selection((sc0, "req-0"), (sc1, "req-1")),
                   _pool((_pooled("i:9", "9", request_ids=("req-0",)),
                         _pooled("i:8", "8", request_ids=("req-1",)))),
                   (_req(rid="req-0", types=("earphone",)),
                    _req(rid="req-1", types=("cable",))), _profile())
    body = ctx.context_text()
    products, _ = json.JSONDecoder().raw_decode(body.split("\n\n", 1)[1])
    assert {p["item_id"]: p["need_indices"] for p in products} == {"9": [1], "8": [2]}


# ── Phase 1 Q2 (tee_apichap): compat no_evidence → compat-bound carriers ────
# anonymous compat need (subject_refs=()) ที่ external target ผูก typed ผ่าน
# `request.target_refs` เท่านั้น (ไม่ผ่าน target_device — device ที่ spec-db
# validate ไม่ได้ / target label อื่น) ต้องถือ request นั้นเป็น carrier เช่น
# เดียวกับ target_device carrier: candidates ที่ถูกเลือกผ่าน carrier เพื่อ
# serve claim ที่พิสูจน์ไม่ได้ → drop จากทุก need; coverage-aware —
# identity เดียวกันที่มี coverage ผ่าน channel อื่นที่ไม่ใช่ carrier ยังรอด

def _anon_compat_setup():
    """compat need anonymous + sibling product need + carrier slot request
    (target ผูกผ่าน target_refs ไม่ใช่ target_device) เลือก 3 cards"""
    need_c = TurnNeed(kind="compat", operation="compat",
                      target_refs=("รุ่น 6",))
    need_d = TurnNeed(kind="product", operation="describe",
                      target_refs=("รุ่น 6",),
                      product_types=frozenset({"filter"}))
    req_slot = _dcreplace(_req(rid="req-0", types=("filter",)),
                          target_refs=("รุ่น 6",))
    return (need_c, need_d), req_slot


def test_anonymous_compat_taints_target_refs_carrier_keeps_history():
    """identity ที่ carrier เลือก + history channel เลือกซ้ำ → รอดผ่าน
    history instance เดียว (independent coverage — card ไม่ใช่ compat
    endorsement); 2 identity ที่ carrier เลือกเพียวๆ → drop"""
    (need_c, need_d), req_slot = _anon_compat_setup()
    req_hist = _req(rid="ch:history", source="history", types=())
    sel = _selection(
        (_sel_card("i:9001", "slot", "req-0", "F 4 Lite"), "req-0"),
        (_sel_card("i:9002", "slot", "req-0", "F 2S"), "req-0"),
        (_sel_card("i:9003", "slot", "req-0", "F 4L H13"), "req-0"),
        (_sel_card("i:9001", "historical_evidence", "ch:history",
                   "F 4 Lite"), "ch:history"),
    )
    pool = _pool(eligible=[
        _pooled("i:9001", item_id="9001",
                request_ids=("req-0", "ch:history"), name="F 4 Lite"),
        _pooled("i:9002", item_id="9002", request_ids=("req-0",),
                name="F 2S"),
        _pooled("i:9003", item_id="9003", request_ids=("req-0",),
                name="F 4L H13"),
    ])
    ctx = _compile((need_c, need_d), sel, pool,
                   (req_slot, req_hist), _profile())
    assert {p.get("item_id") for p in ctx.products} == {"9001"}, (
        "compat-only coverage ต้องหาย; history-covered identity รอด")
    assert not ctx.compat_verdicts, "no_evidence ห้ามมี decided verdict"
    assert any(u.need_index == 0 and u.reason == "no_evidence"
               for u in ctx.unanswered_needs)


def test_anonymous_compat_taints_all_sibling_candidates_when_carrier_only():
    """sibling product need ที่ candidates ทั้งหมดมาจาก compat carrier
    เท่านั้น → 0 cards (claim ที่พิสูจน์ไม่ได้ไม่สร้าง product answer)"""
    (need_c, need_d), req_slot = _anon_compat_setup()
    sel = _selection(
        (_sel_card("i:9001", "slot", "req-0", "F 4 Lite"), "req-0"),
        (_sel_card("i:9002", "slot", "req-0", "F 2S"), "req-0"),
    )
    pool = _pool(eligible=[
        _pooled("i:9001", item_id="9001", request_ids=("req-0",),
                name="F 4 Lite"),
        _pooled("i:9002", item_id="9002", request_ids=("req-0",),
                name="F 2S"),
    ])
    ctx = _compile((need_c, need_d), sel, pool, (req_slot,), _profile())
    assert ctx.products == ()
    assert any(u.need_index == 0 and u.reason == "no_evidence"
               for u in ctx.unanswered_needs)


# ── Phase 10B Round 4: charger-family scope membership ─────────────────────
# declared 'charger' type scope = family head ของ charger domain — member
# types = union(units._SUBTYPE_TO_TYPES.values()) — request attribution,
# AnswerContext scope gate และ executor bucket ต้องใช้ artifact เดียวกัน;
# explicit subtype แคบกว่า family เสมอ — member ไม่ expand เป็น sibling


def _fam_need(**kw):
    return TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"charger"}), **kw)


def _ctype_card(identity, rid, ctype, roles=(), name="X"):
    return _sel_card(identity, "slot", rid, name,
                     canonical_type=ctype, canonical_roles=list(roles))


def test_generic_charger_need_admits_cable_card_in_context():
    need = _fam_need()
    req = _req(rid="req-0", types=("charger",))
    sc = _ctype_card("i:1", "req-0", "cable", roles=("cable",),
                     name="CUKTECH Cable 240W")
    ctx = _compile((need,), _selection((sc, "req-0")), _pool(),
                   (req,), _profile())
    assert ctx.products, (
        "charger-family scope ต้องยอมรับ member card canonical_type='cable'")


def test_charger_scope_covers_all_member_types_at_gate():
    # member set derived จาก typed owner — ไม่เขียนรายชื่อซ้ำใน test
    from shopeechat import units as _u
    members = set().union(*_u._SUBTYPE_TO_TYPES.values())
    assert "cable" in members and "charger" in members
    for ctype in sorted(members):
        need = _fam_need()
        req = _req(rid="req-0", types=("charger",))
        sc = _ctype_card("i:1", "req-0", ctype, name=f"{ctype} card")
        ctx = _compile((need,), _selection((sc, "req-0")), _pool(),
                       (req,), _profile())
        assert ctx.products, (
            f"member type {ctype!r} ต้องผ่าน generic charger scope gate")


def test_generic_charger_need_attributes_cable_request():
    need = _fam_need()
    cable_req = _req(rid="req-0", slot="slot-cable",
                     types=("cable",), subs=("cable",))
    assert need in rsel.needs_for_request(cable_req, (need,)), (
        "cable-scoped request เป็น member ของ charger family — "
        "generic charger need ต้อง attribute")


def test_cable_need_attributes_generic_charger_request():
    need = TurnNeed(kind="product", operation="recommend",
                    subtypes=frozenset({"cable"}))
    req = _req(rid="req-0", types=("charger",))
    assert need in rsel.needs_for_request(req, (need,)), (
        "generic charger request cover family — cable need ต้อง attribute")


def test_explicit_cable_need_rejects_other_family_cards():
    need = TurnNeed(kind="product", operation="recommend",
                    subtypes=frozenset({"cable"}))
    req = _req(rid="req-0", types=("charger",), subs=("cable",))
    adapter = _ctype_card("i:a", "req-0", "charger",
                          roles=("adapter",), name="Adapter")
    wireless = _ctype_card("i:w", "req-0", "wireless_charger",
                           roles=("wireless",), name="Wireless")
    cable = _ctype_card("i:c", "req-0", "cable",
                        roles=("cable",), name="Cable")
    ctx = _compile((need,),
                   _selection((adapter, "req-0"), (wireless, "req-0"),
                              (cable, "req-0")),
                   _pool(), (req,), _profile())
    got = {str(c.get("item_id")) for c in ctx.products}
    assert got == {"c"}, (
        f"explicit cable need ต้องได้เฉพาะ cable card — got {got}")


def test_explicit_adapter_need_rejects_cable_card():
    need = TurnNeed(kind="product", operation="recommend",
                    subtypes=frozenset({"adapter"}))
    req = _req(rid="req-0", types=("charger",), subs=("adapter",))
    adapter = _ctype_card("i:a", "req-0", "charger",
                          roles=("adapter",), name="Adapter")
    cable = _ctype_card("i:c", "req-0", "cable",
                        roles=("cable",), name="Cable")
    ctx = _compile((need,),
                   _selection((adapter, "req-0"), (cable, "req-0")),
                   _pool(), (req,), _profile())
    got = {str(c.get("item_id")) for c in ctx.products}
    assert got == {"a"}, (
        f"explicit adapter need ต้องได้เฉพาะ adapter-role card — got {got}")


def test_unrelated_family_need_rejects_cable_card():
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"dashcam"}))
    req = _req(rid="req-0", types=("dashcam",))
    sc = _ctype_card("i:c", "req-0", "cable", roles=("cable",),
                     name="Cable")
    ctx = _compile((need,), _selection((sc, "req-0")), _pool(),
                   (req,), _profile())
    assert ctx.products == (), (
        "dashcam need ไม่ใช่ charger family — cable card ต้องถูกกั้น")


def test_unscoped_need_still_admits_family_card():
    # empty scope = unscoped contract เดิม — pseudo-type 'other'/unknown
    # ถูก intent_product_scope กรองก่อน stamping อยู่แล้ว (bb219fb)
    need = TurnNeed(kind="product", operation="recommend")
    req = _req(rid="req-0", types=("charger",))
    sc = _ctype_card("i:c", "req-0", "cable", roles=("cable",),
                     name="Cable")
    ctx = _compile((need,), _selection((sc, "req-0")), _pool(),
                   (req,), _profile())
    assert ctx.products, "unscoped need ต้อง admit card ตามเดิม"


def test_unknown_intent_type_stays_unscoped():
    plan = td.decide_turn("มีสายชาร์จไหม", history=[], intent_result={
        "intent": "product_recommend", "product_type": "bogus_gadget",
        "confidence": 0.9})
    prodish = [n for n in plan.needs if n.kind in ("product", "compare")]
    assert prodish, plan.needs
    assert all(not n.product_types for n in prodish), (
        "unknown type ต้อง fail closed เป็น unscoped เหมือนเดิม")
    req = _req(types=("cable",), subs=("cable",))
    for n in prodish:
        assert n in rsel.needs_for_request(req, plan.needs)


def test_attribution_and_context_share_one_family_semantic():
    from shopeechat import units as _u
    members = set().union(*_u._SUBTYPE_TO_TYPES.values())
    need = _fam_need()
    for ctype in sorted(members) + ["powerbank", "dashcam"]:
        member = ctype in members
        # request level — scope {ctype} ถูก generic charger need cover
        # ก็ต่อเมื่อ ctype เป็น member ของ family
        req_t = _req(rid=f"t-{ctype}", types=(ctype,))
        assert (need in rsel.needs_for_request(req_t, (need,))
                ) == member, (
            f"{ctype}: attribution semantic diverge — member={member}")
        # context level — card ctype=X ใต้ generic charger request
        req = _req(rid=req_t.request_id, types=("charger",))
        sc = _ctype_card("i:1", req.request_id, ctype)
        ctx = _compile((need,), _selection((sc, req.request_id)),
                       _pool(), (req,), _profile())
        assert bool(ctx.products) == member, (
            f"{ctype}: gate admission diverge — member={member} "
            f"products={bool(ctx.products)}")


def test_subject_ref_exemption_and_family_gate_coexist():
    # subject_refs-pinned identity = explicit authority → exempt เดิม;
    # card อื่นที่ไม่ pin ต้องผ่าน family gate — anchor isolation ไม่เปลี่ยน
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"charger"}),
                    subject_refs=("9",))
    pinned = _sel_card("i:9", "subject", "req-0", "Pinned Item",
                       canonical_type="powerbank")
    other = _ctype_card("i:2", "req-0", "dashcam", name="Dashcam Other")
    ctx = _compile((need,),
                   _selection((pinned, "req-0"), (other, "req-0")),
                   _pool(), (_req(types=("charger",),),), _profile())
    ids = {str(c.get("item_id")) for c in ctx.products}
    assert "9" in ids and "2" not in ids, (
        f"pinned identity ต้องผ่าน, non-member card ต้องตก — got {ids}")


def test_canonical_exact_type_match_unchanged():
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"dashcam"}))
    req = _req(rid="req-0", types=("dashcam",))
    sc = _ctype_card("i:1", "req-0", "dashcam", name="Dashcam X")
    ctx = _compile((need,), _selection((sc, "req-0")), _pool(),
                   (req,), _profile())
    assert ctx.products, "canonical exact-match เดิมต้องทำงานเหมือนเดิม"


def test_executor_bucket_accepts_member_card_under_charger_request():
    card = {"name": "Cable X", "customer_visibility": "visible",
            "canonical_type": "cable", "sellable": True,
            "_evidence": {"facts": {"canonical":
                                    {"type_candidates": ["cable"]}},
                          "item_ids": ()}}
    req = _req(types=("charger",))
    bucket, reason = rexec._bucket(card, req)
    assert (bucket, reason) != ("rejected", "wrong_type"), (
        f"member card ห้ามตก wrong_type ใต้ generic charger request — "
        f"{bucket}:{reason}")
