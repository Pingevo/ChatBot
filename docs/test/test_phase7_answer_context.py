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
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
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


# ── builders ────────────────────────────────────────────────────────────────

def _req(rid="req-0", slot="slot-a", source="slot", types=("earphone",),
         subs=(), codes=(), target=None, soft=(), hard=(), rel=None,
         variants=(), vc=()):
    return RetrievalRequest(
        request_id=rid, slot_id=slot, source=source,
        product_types=frozenset(types), subtypes=frozenset(subs),
        model_codes=tuple(codes), target_device=target,
        availability_mode="sellable_first", compat_mode="none",
        hard_filters=tuple(hard), soft_hints=tuple(soft), relation_id=rel,
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
    ctx = _compile((need,), _selection(), _pool(), (req,), prof)
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
                 target="galaxy z99 fakephone" if target else None),)
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
    gs = {"selection": _selection(), "pool": pool, "requests": reqs,
          "summary": {}}

    def _web(**kw):
        order.append("web")
        return {"search_info": "galaxy z99 fakephone spec: usb-c",
                "device_specs": [{"device": "galaxy z99 fakephone",
                                  "connector": "usb-c"}]}

    out = _app._typed_answer_boundary(
        gs, needs=(n,), profile=_profile(), web_configured=True,
        web_search_fn=lambda **kw: _web(**kw))
    assert order == ["web", "answer"], order
    assert out.answer_calls == 1 and out.web_used


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
