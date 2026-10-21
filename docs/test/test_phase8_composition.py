"""Phase 8 — typed answer composition + single finalizer.

contract:
- `compose_answer` (answer_context) = composition owner เดียว — typed
  per-need results (claim→product→policy canonical order) + unanswered
  needs (missing authoritative result = unanswered/deferred, ห้าม invent)
- `_typed_answer_boundary` returns one AnswerComposition (ไม่ใช่ dict อีก)
  — deferred kinds ไม่ kill ทั้ง turn; productish tasks ทำงานต่อ
- `_finalize_answer` (app) = production finalizer เดียว — composition →
  ChatResponse เดียว (render/join/dedupe/warranty-append/segments/marker)
- `guards.policy_outcome_text` = policy outcome→text render owner เดียว;
  enforce composition branch = canonical segment คงอยู่ + strip foreign
  return-claim ทั้งสอง polarity (idempotent)
- app `_pdec` gate: flag ON + mixed + eligible/ineligible → typed
  composition แทน fail-closed handoff; unknown/admin_review/flag OFF →
  precedence เดิม (handoff / pure render)
"""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pymongo
import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from test_phase7_answer_context import (  # noqa: E402 — reuse typed builders
    _req, _sel_card, _selection, _pool, _pooled, _profile, _compile,
)
from test_phase7_boundary_review import (  # noqa: E402 — reuse app harness
    _import_app, _capture_generate, _need_product, _need_compat,
    _need_policy,
)

_env_before_replay_import = dict(os.environ)
import test_legacy_turn_incident_replay as replay  # noqa: E402
from test_legacy_turn_incident_replay import _install, ADMIN_DB  # noqa: E402

for _k in [k for k in os.environ if k not in _env_before_replay_import]:
    del os.environ[_k]
os.environ.update({k: v for k, v in _env_before_replay_import.items()
                   if os.environ.get(k) != v})
del _env_before_replay_import

from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import guards  # noqa: E402
from shopeechat import llm  # noqa: E402
from shopeechat import policy_resolver as pr  # noqa: E402
from shopeechat import retrieval_runtime as rr  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402

TurnNeed = td.TurnNeed


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    """ห้าม network/Mongo ในชุดนี้ — posture เดียวกับ fail-closed suite."""
    import urllib.request

    def _fail(what):
        def _g(*a, **k):
            pytest.fail(f"OFFLINE LEAK: {what}", pytrace=False)
        return _g
    monkeypatch.setattr(socket.socket, "connect", _fail("socket.connect"))
    monkeypatch.setattr(socket.socket, "connect_ex", _fail("connect_ex"))
    monkeypatch.setattr(socket, "create_connection", _fail("create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", _fail("getaddrinfo"))
    monkeypatch.setattr(urllib.request, "urlopen", _fail("urllib.urlopen"))
    monkeypatch.setattr(pymongo.MongoClient, "__init__",
                        _fail("MongoClient.__init__"))
    yield


# ── builders ────────────────────────────────────────────────────────────────

def _pdec(outcome="eligible", **kw):
    return pr.PolicyDecision(
        outcome=outcome, matched_rule_ids=("r1",),
        required_evidence=(), reason_codes=("test",),
        source_versions=("v1",), **kw)


def _need_claim(refs=("WPB100L",)):
    return TurnNeed(kind="claim", operation="collect",
                    subject_refs=tuple(refs))


def _need_order():
    return TurnNeed(kind="order", operation="lookup")


def _need_compare(refs=("AC65B", "WPB100L")):
    return TurnNeed(kind="compare", operation="compare",
                    subject_refs=tuple(refs))


def _product_ctx(needs=(), rid="req-0", name="Earphone X"):
    """ctx ที่มี product task + selected card ตรง need แรก."""
    needs = needs or (_need_product(),)
    req = _req(rid=rid, types=("earphone",))
    sel = _selection((_sel_card("i:1", "subject", rid, name), rid))
    return _compile(needs, sel,
                    _pool((_pooled("i:1", "1", name=name),)),
                    (req,), _profile())


def _boundary(needs, sel=None, pool=None, requests=(), **kw):
    _app = _import_app_cached()
    sel = sel if sel is not None else _selection()
    kw.setdefault("web_configured", False)
    return _app._typed_answer_boundary(
        {"selection": sel, "pool": pool if pool is not None else _pool(),
         "requests": tuple(requests)},
        needs=needs, profile=_profile(), **kw)


_app_cache = {}


def _import_app_cached():
    if "app" not in _app_cache:
        if "shopeechat.app" in sys.modules:
            _app_cache["app"] = sys.modules["shopeechat.app"]
        else:
            import shopeechat.app as _a
            _app_cache["app"] = _a
    return _app_cache["app"]


def _finalize(comp, **kw):
    app = _app_cache["app"]
    args = dict(message="m", limit=5, products=[], source="product_store",
                shop="S", model="m", elapsed=0.0, cost=0.0, intent={},
                timing={}, steps=[], routing_decision={}, image_desc="")
    args.update(kw)
    return app._finalize_answer(comp, **args)


def _sel_for(msg, ir, cards, shop="FilterShopTH"):
    """real grouped artifact dict via real pipeline + stub fetchers."""
    from shopeechat import route_context
    from shopeechat.units import UnitEvidenceFetchResult
    prof = route_context.build_retrieval_profile(
        msg, history=[], intent_result=ir, shop=shop)
    needs = td.decide_turn(msg, history=[], intent_result=ir).needs
    return rr.run_grouped_selection(
        prof, message=msg, shop=shop, platform="shopee",
        fetcher=lambda m, **kw: UnitEvidenceFetchResult(
            cards=tuple(cards), raw_count=len(cards),
            sellable_count=sum(
                1 for c in cards if c.get("_available_for_sale")),
            unavailable_count=0, trace=("t",)),
        legacy_fetcher=lambda m, **k: [], needs=needs, snap=None)


def _wpb_unit():
    return {"name": "WOPOW WPB100L Powerbank 10000mAh",
            "product_type": "powerbank", "unit_id": "u-wpb100l",
            "item_id": "5001", "model_id": "WPB100L",
            "model_codes": ["WPB100L"], "_available_for_sale": True,
            "status": "NORMAL", "total_stock": 4,
            "catalog_status": "active", "customer_visible": True,
            "availability_reason": ""}


_WPB_DOC = {
    "item_id": 5001.0,
    "item_name": "WOPOW WPB100L Powerbank 10000mAh",
    "item_status": "NORMAL",
    "shopname": "FilterShopTH",
    "cat_name": "พาวเวอร์แบงค์",
    "condition": "new",
    "brand": {"brand_id": 1, "original_brand_name": "WOPOW"},
    "gen_price": 990.0,
    "short_link": "https://s.shopee.co.th/fx5001",
    "image": {"image_url_list": ["https://img.example/fx.jpg"],
              "image_id_list": ["fximg"]},
    "description": "power bank wopow wpb100l",
    "tier_variation": [{"name": "สี", "option_list": [{"option": "Black"}]}],
    "model": [{"model_id": 11.0, "model_name": "WPB100L", "model_sku": "",
               "model_status": "MODEL_NORMAL",
               "stock_info_v2": {"summary_info": {"total_available_stock": 4}},
               "tier_index": [0],
               "price_info": [{"current_price": 99000}]}],
    "standardise_tier_variation": [],
    "weight": "0.2",
    "dimension": {"package_height": 5, "package_length": 10,
                  "package_width": 5},
}

_MIXED_MSG = "ถ้าซื้อ WPB100L ผิดรุ่นเอง ขอเปลี่ยนได้ไหมคะ"
_MIXED_IR = {"intent": "general_question", "confidence": 0.9,
             "general_qtype": "return_policy",
             "policy_reason": "customer_wrong_model",
             "policy_item_condition": "sealed"}
_RULE_INELIGIBLE = {"rule_id": "fx-return-wrong-model-prohibit",
                   "version": "fx-2026-01", "policy_type": "return_exchange",
                   "outcome": "ineligible", "reason": "customer_wrong_model",
                   "shops": ["FilterShopTH"], "priority": 10,
                   "source": "fixture-policy"}
_RULE_ELIGIBLE = {"rule_id": "fx-return-generic-allow",
                 "version": "fx-2026-01", "policy_type": "return_exchange",
                 "outcome": "eligible",
                 "shops": ["FilterShopTH"], "priority": 5,
                 "source": "fixture-policy"}


def _fx_mixed(fid, *, grouped, records, llm_reply):
    return {
        "id": fid, "shop": "FilterShopTH", "platform": "shopee",
        "conversation_id": f"fx-{fid}",
        "catalog": [_WPB_DOC],
        "intent_result": dict(_MIXED_IR),
        "runtime_flags": {"grouped_selection": grouped},
        "policy_records": records,
        "llm_reply": llm_reply,
    }


def _chat(monkeypatch, fx, message, sel_artifact=None):
    """one real chat() turn; sel_artifact=None → spy run→None."""
    client, captured, handoffs = _install(monkeypatch, fx)
    calls = {"n": 0}

    def _fake_run(*a, **kw):
        calls["n"] += 1
        return sel_artifact
    monkeypatch.setattr(rr, "run_grouped_selection", _fake_run)
    from shopeechat import app as _app
    resp = _app.chat(_app.ChatRequest(
        message=message, shop=fx["shop"], platform="shopee",
        history=[], conversation_id=fx["conversation_id"],
        limit=5, simulate_assignment=True,
        test_source="phase8_composition"))
    return resp, captured, handoffs, calls


def _typed_calls(captured):
    return [c for c in captured.calls if c["fn"] == "answer_typed"]


# ────────────────────────────────────────────────────────────────────────────
# A — compose_answer (pure typed combine — composition owner เดียว)
# ────────────────────────────────────────────────────────────────────────────

class TestComposeAnswer:

    def test_product_only_single_result(self):
        needs = (_need_product(),)
        ctx = _product_ctx(needs)
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="prod answer",
            usage={"prompt": 1}, answer_calls=1)
        assert isinstance(comp, acx.AnswerComposition)
        assert [r.domain for r in comp.results] == ["product"]
        assert comp.results[0].need_indices == (0,)
        assert comp.results[0].text == "prod answer"
        assert comp.unanswered_needs == ()
        assert comp.products == ctx.products

    def test_policy_only_result_covers_need(self):
        needs = (_need_policy(),)
        comp = acx.compose_answer(
            needs=needs, context=None, policy_decision=_pdec("eligible"))
        assert [r.domain for r in comp.results] == ["policy"]
        assert comp.results[0].need_indices == (0,)
        assert comp.results[0].outcome == "eligible"
        assert comp.unanswered_needs == ()

    def test_mixed_product_policy_preserves_both(self):
        """product + policy ต้องอยู่คนละ segment — ไม่มีการเขียนทับกัน."""
        needs = (_need_product(), _need_policy())
        ctx = _product_ctx(needs)
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="prod answer",
            policy_decision=_pdec("ineligible"), answer_calls=1)
        domains = [r.domain for r in comp.results]
        assert domains == ["product", "policy"], domains
        assert comp.results[0].need_indices == (0,)
        assert comp.results[1].need_indices == (1,)
        assert comp.results[1].outcome == "ineligible"
        assert comp.unanswered_needs == ()

    def test_claim_guidance_comes_first(self):
        needs = (_need_claim(), _need_product())
        ctx = _product_ctx(needs)
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="prod",
            claim_guidance="กรุณาส่งวิดีโอตอนแกะกล่องค่ะ", answer_calls=1)
        assert [r.domain for r in comp.results] == ["claim", "product"]
        assert comp.results[0].need_indices == (0,)
        assert comp.results[0].text.startswith("กรุณาส่งวิดีโอ")
        assert comp.unanswered_needs == ()

    def test_order_need_stays_unanswered(self):
        """order เป็น deferred kind — ไม่มี typed result → unanswered."""
        needs = (_need_product(), _need_order())
        ctx = _product_ctx(needs)
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="p", answer_calls=1)
        assert [r.domain for r in comp.results] == ["product"]
        assert [(u.need_index, u.kind, u.reason)
                for u in comp.unanswered_needs] == [(1, "order", "deferred")]

    def test_three_productish_needs_one_product_result(self):
        """compare+compat+describe = productish → ONE product result ที่
        attribute ทุก covered need (answer model ≤1)."""
        needs = (_need_compare(refs=("AC65B",)), _need_compat(),
                 _need_product())
        req = _req(rid="req-0", types=("earphone", "cable"),
                   codes=("AC65B",))
        sel = _selection((_sel_card("i:1", "subject", "req-0", "Earphone"),
                          "req-0"))
        ctx = _compile(needs, sel,
                       _pool((_pooled("i:1", "1", name="Earphone"),)),
                       (req,), _profile())
        assert len(ctx.task.tasks) == 3
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="p", answer_calls=1)
        assert len(comp.results) == 1
        r = comp.results[0]
        assert r.domain == "product"
        assert set(r.need_indices) == {0, 1, 2}
        assert comp.unanswered_needs == ()

    def test_unanswered_alongside_answered(self):
        """productish need ไร้ coverage → unanswered คงอยู่ข้าง policy result."""
        needs = (_need_product(), _need_policy())
        req = _req(rid="req-0", types=("earphone",))
        sel = _selection()   # ไม่มี selected → product need no_selection
        ctx = _compile(needs, sel, _pool(), (req,), _profile())
        assert any(u.reason == "no_selection" and u.need_index == 0
                   for u in ctx.unanswered_needs)
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="",
            policy_decision=_pdec("eligible"))
        assert [r.domain for r in comp.results] == ["policy"]
        assert [u.need_index for u in comp.unanswered_needs] == [0]

    def test_missing_product_context_marks_unanswered(self):
        """ctx=None (selection พัง) + ไม่มี product result → ทุก productish
        need = no_selection unanswered; deferred kinds = deferred."""
        needs = (_need_product(), _need_policy())
        comp = acx.compose_answer(needs=needs, context=None)
        assert comp.results == ()
        reasons = {u.need_index: (u.kind, u.reason)
                   for u in comp.unanswered_needs}
        assert reasons[0] == ("product", "no_selection")
        assert reasons[1] == ("policy", "deferred")

    def test_missing_policy_decision_stays_deferred(self):
        """policy need ไม่มี typed decision → deferred (ห้าม invent)."""
        needs = (_need_product(), _need_policy())
        ctx = _product_ctx(needs)
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="p", answer_calls=1)
        assert [r.domain for r in comp.results] == ["product"]
        assert [(u.kind, u.reason) for u in comp.unanswered_needs] == [
            ("policy", "deferred")]

    def test_open_claim_without_guidance_not_resolved(self):
        """claim need ที่ไม่มี guidance → deferred (open collection ≠ resolved)."""
        needs = (_need_claim(), _need_product())
        ctx = _product_ctx(needs)
        comp = acx.compose_answer(
            needs=needs, context=ctx, product_text="p", answer_calls=1)
        assert [r.domain for r in comp.results] == ["product"]
        assert [(u.kind, u.reason) for u in comp.unanswered_needs] == [
            ("claim", "deferred")]

    def test_compose_is_deterministic(self):
        needs = (_need_product(), _need_policy())
        ctx = _product_ctx(needs)
        kw = dict(needs=needs, context=ctx, product_text="p",
                  policy_decision=_pdec("eligible"), answer_calls=1)
        assert acx.compose_answer(**kw) == acx.compose_answer(**kw)


# ────────────────────────────────────────────────────────────────────────────
# B — _typed_answer_boundary returns AnswerComposition
# ────────────────────────────────────────────────────────────────────────────

class TestBoundaryComposition:

    def test_boundary_returns_composition_product(self, monkeypatch):
        _import_app(monkeypatch)
        _capture_generate(monkeypatch)
        need = _need_product()
        req = _req(rid="req-0", types=("earphone",))
        sel = _selection((_sel_card("i:1", "subject", "req-0", "Earphone"),
                          "req-0"))
        comp = _boundary((need,), sel,
                         _pool((_pooled("i:1", "1", name="Earphone"),)),
                         (req,))
        assert isinstance(comp, acx.AnswerComposition)
        assert comp.answer_calls == 1
        assert [r.domain for r in comp.results] == ["product"]
        assert comp.results[0].text

    def test_boundary_mixed_composes_both_segments(self, monkeypatch):
        """product+policy กับ typed decision → compose 2 segments;
        answer model ทำงานครั้งเดียว (product เท่านั้น — policy เป็น typed)."""
        _import_app(monkeypatch)
        typed_calls = []
        monkeypatch.setattr(llm, "answer_typed",
                            lambda **kw: typed_calls.append(kw) or ("p", {}))
        need = _need_product()
        req = _req(rid="req-0", types=("earphone",))
        sel = _selection((_sel_card("i:1", "subject", "req-0", "Earphone"),
                          "req-0"))
        comp = _boundary((need, _need_policy()), sel,
                         _pool((_pooled("i:1", "1", name="Earphone"),)),
                         (req,), policy_decision=_pdec("ineligible"))
        assert comp.answer_calls == 1 and len(typed_calls) == 1
        assert [r.domain for r in comp.results] == ["product", "policy"]
        assert comp.unanswered_needs == ()

    def test_boundary_mixed_without_decision_defers_policy(self, monkeypatch):
        _import_app(monkeypatch)
        monkeypatch.setattr(llm, "answer_typed", lambda **kw: ("p", {}))
        need = _need_product()
        req = _req(rid="req-0", types=("earphone",))
        sel = _selection((_sel_card("i:1", "subject", "req-0", "Earphone"),
                          "req-0"))
        comp = _boundary((need, _need_policy()), sel,
                         _pool((_pooled("i:1", "1", name="Earphone"),)),
                         (req,))
        assert comp.answer_calls == 1
        assert [r.domain for r in comp.results] == ["product"]
        assert [(u.kind, u.reason) for u in comp.unanswered_needs] == [
            ("policy", "deferred")]

    def test_boundary_claim_guidance_result(self, monkeypatch):
        _import_app(monkeypatch)
        monkeypatch.setattr(llm, "answer_typed", lambda **kw: ("p", {}))
        need = _need_product()
        req = _req(rid="req-0", types=("earphone",))
        sel = _selection((_sel_card("i:1", "subject", "req-0", "Earphone"),
                          "req-0"))
        comp = _boundary((_need_claim(), need), sel,
                         _pool((_pooled("i:1", "1", name="Earphone"),)),
                         (req,), claim_guidance="ส่งวิดีโอแกะกล่องค่ะ")
        assert [r.domain for r in comp.results] == ["claim", "product"]
        assert comp.unanswered_needs == ()

    def test_boundary_policy_only_zero_calls(self, monkeypatch):
        _import_app(monkeypatch)
        typed_calls = []
        monkeypatch.setattr(llm, "answer_typed",
                            lambda **kw: typed_calls.append(kw) or ("x", {}))
        comp = _boundary((_need_policy(),),
                         policy_decision=_pdec("eligible"))
        assert comp.answer_calls == 0 and typed_calls == []
        assert [r.domain for r in comp.results] == ["policy"]

    def test_boundary_deferred_kind_does_not_kill_productish(
            self, monkeypatch):
        """policy need อยู่ข้าง compat need — deferred ไม่ kill turn:
        compat admission ทำงานปกติ; web ≤1; policy unanswered."""
        _import_app(monkeypatch)
        web_calls = []
        typed_calls = []
        monkeypatch.setattr(
            llm, "answer_typed",
            lambda **kw: typed_calls.append(kw) or ("x", {}))
        req = _req(rid="req-0", source="relation_target",
                   target="galaxy z99 fakephone", types=("cable",))
        sel = _selection(
            (_sel_card("i:1", "relation_target", "req-0", "Cable"), "req-0"))
        comp = _boundary((_need_compat(), _need_policy()), sel,
                         _pool(), (req,),
                         web_search_fn=lambda **kw: web_calls.append(kw) or {},
                         web_configured=True)
        assert len(web_calls) <= 1
        assert comp.answer_calls <= 1
        assert any(u.kind == "policy" for u in comp.unanswered_needs)

    def test_boundary_answer_model_at_most_once(self, monkeypatch):
        """3 productish needs → answer_typed ≤1 เสมอ."""
        _import_app(monkeypatch)
        typed_calls = []
        monkeypatch.setattr(llm, "answer_typed",
                            lambda **kw: typed_calls.append(kw) or ("x", {}))
        needs = (_need_product(), _need_compare(), _need_compat())
        req = _req(rid="req-0", types=("earphone",))
        sel = _selection((_sel_card("i:1", "subject", "req-0", "Earphone"),
                          "req-0"))
        comp = _boundary(needs, sel,
                         _pool((_pooled("i:1", "1", name="Earphone"),)),
                         (req,))
        assert comp.answer_calls <= 1 and len(typed_calls) <= 1

    def test_boundary_media_evidence_attributed(self, monkeypatch):
        """image_text/vision evidence ติด need_index → ผ่านเข้า ctx ใน
        composition โดยไม่กลายเป็น answer segment แยก."""
        _import_app(monkeypatch)
        monkeypatch.setattr(llm, "answer_typed", lambda **kw: ("p", {}))
        need = _need_product()
        req = _req(rid="req-0", types=("earphone",))
        sel = _selection((_sel_card("i:1", "subject", "req-0", "Earphone"),
                          "req-0"))
        pool = _pool(
            eligible=(_pooled("i:1", "1", name="Earphone"),),
            supporting=(
                {"kind": "image_text", "need_index": 0,
                 "request_id": "req-0", "subject_refs": ("AC65B",),
                 "text": "SENTINEL_MEDIA spec image"},
                {"kind": "vision", "need_index": 0,
                 "request_id": "req-0", "subject_refs": ("AC65B",),
                 "text": "customer image shows model AC65B"},
            ))
        comp = _boundary((need, _need_policy()), sel, pool, (req,))
        kinds = {e.get("kind") for e in (comp.context.evidence
                                         if comp.context else ())}
        assert "image_text" in kinds or "vision" in kinds, (
            f"media evidence must reach ctx: {kinds}")


# ────────────────────────────────────────────────────────────────────────────
# C — _finalize_answer (single production finalizer)
# ────────────────────────────────────────────────────────────────────────────

class TestFinalizeAnswer:

    def test_finalize_joins_in_canonical_order(self, monkeypatch):
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(
            results=(
                acx.DomainResult("product", (0,), text="prod text"),
                acx.DomainResult("claim", (1,), text="claim text"),
                acx.DomainResult("policy", (2,), outcome="eligible"),
            ))
        resp = _finalize(comp)
        a = resp.answer
        assert a.index("claim text") < a.index("prod text") < a.index(
            "เปลี่ยน/คืนได้ตามเงื่อนไข")

    def test_finalize_dedupes_identical_segments(self, monkeypatch):
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(
            results=(
                acx.DomainResult("claim", (0,), text="same"),
                acx.DomainResult("product", (1,), text="same"),
            ))
        resp = _finalize(comp)
        assert resp.answer.count("same") == 1

    def test_finalize_empty_results_deterministic_reply(self, monkeypatch):
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(results=())
        resp = _finalize(comp)
        assert resp.answer == acx.EMPTY_CONTEXT_REPLY

    def test_finalize_exactly_one_canonical_policy_segment(
            self, monkeypatch):
        """finalizer เป็น owner เดียวที่ render+insert policy segment —
        canonical text ต้องปรากฏพอดีครั้งเดียว (dedupe ตัดซ้ำแม้ product
        text มีประโยคเดียวกัน)."""
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(
            results=(
                acx.DomainResult("product", (0,), text="prod text"),
                acx.DomainResult("policy", (1,), outcome="ineligible"),
            ))
        resp = _finalize(comp)
        assert resp.answer.count(
            "ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืน") == 1
        # product text = canonical sentence เดียวกัน → dedupe กัน segment
        #   ซ้ำ — canonical ยังคงครั้งเดียว (ไม่ใช่ enforce ที่ strip)
        comp2 = acx.AnswerComposition(
            results=(
                acx.DomainResult(
                    "product", (0,),
                    text=guards._POLICY_TEXT_INELIGIBLE),
                acx.DomainResult("policy", (1,), outcome="ineligible"),
            ))
        resp2 = _finalize(comp2)
        assert resp2.answer.count(
            "ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืน") == 1

    def test_finalize_byte_stable_applied_twice(self, monkeypatch):
        """finalizer เป็น pure function ของ comp — เรียกซ้ำ byte-identical."""
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(
            results=(
                acx.DomainResult("product", (0,), text="prod"),
                acx.DomainResult("policy", (1,), outcome="ineligible"),
            ), unanswered_needs=(), usage={"prompt": 1})
        r1 = _finalize(comp)
        r2 = _finalize(comp)
        for f in ("answer", "answer_segments", "products", "source",
                  "usage", "routing_decision"):
            assert getattr(r1, f) == getattr(r2, f), f

    def test_finalize_stamps_composition_marker(self, monkeypatch):
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(
            results=(
                acx.DomainResult("product", (0,), text="p"),
                acx.DomainResult("policy", (1,), outcome="eligible"),
            ))
        resp = _finalize(comp)
        marker = resp.routing_decision.get("composition")
        assert marker is not None, "composition marker required for enforce"
        assert marker["domains"] == ["product", "policy"]
        assert marker["policy_text"] == guards._POLICY_TEXT_ELIGIBLE

    def test_finalize_error_sentinel_suppresses_other_segments(
            self, monkeypatch):
        """provider error → error reply alone (enforce escalate ต้องจับได้ —
        ห้ามกลืนด้วย policy/claim text)."""
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(
            results=(
                acx.DomainResult("product", (0,), text=llm.LLM_ERROR_REPLY),
                acx.DomainResult("policy", (1,), outcome="eligible"),
            ))
        resp = _finalize(comp)
        assert resp.answer == llm.LLM_ERROR_REPLY

    def test_finalize_products_respect_limit(self, monkeypatch):
        _import_app(monkeypatch)
        comp = acx.AnswerComposition(
            results=(acx.DomainResult("product", (0,), text="p"),))
        prods = [{"name": f"p{i}"} for i in range(8)]
        resp = _finalize(comp, products=prods, limit=5)
        assert len(resp.products) == 5


# ────────────────────────────────────────────────────────────────────────────
# D — guards.enforce composition branch (canonical segment survives;
#     foreign return-claims stripped — both polarities; idempotent)
# ────────────────────────────────────────────────────────────────────────────

def _resp(answer, rd):
    return SimpleNamespace(
        answer=answer, answer_segments=answer.split("\n\n"),
        products=[], handoff_to_admin=False, source="product_store",
        routing_decision=dict(rd))


_PDEC_RD = {"policy_decision": {"policy_type": "return_exchange",
                                "outcome": "ineligible",
                                "matched_rule_ids": ("r1",),
                                "required_evidence": (),
                                "reason_codes": (), "source_versions": ()}}


class TestEnforceComposition:
    """H1-final — structured-marker validation เท่านั้น: enforce ตัดสิน
    จาก composition marker (domains + policy_text == outcome text)
    ไม่ใช่ answer prose.  marker valid → return byte-identical;
    invalid/mismatch → fail closed wholesale render เดิม; ไม่มี marker
    → wholesale render เดิม (flag-OFF เสมอ)."""

    _REQ = SimpleNamespace(message="m", history=[])

    def test_valid_marker_returns_byte_identical(self):
        """marker ครบ+ตรง → answer/answer_segments ไม่แตะ (แม้ product
        segment จะมี injected clause — prose ไม่ใช่ input ของ guard)."""
        answer = ("WPB100L ราคา 990 บาทค่ะ เคสนี้เปลี่ยนได้เลยนะคะ"
                  "\n\nเคสนี้ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืนนะคะ")
        resp = _resp(
            answer,
            {**_PDEC_RD, "composition": {
                "domains": ["product", "policy"],
                "policy_text": guards._POLICY_TEXT_INELIGIBLE}})
        out = guards.enforce(resp, self._REQ)
        assert out.answer == answer
        assert out.answer_segments == resp.answer_segments
        assert "guard_rewritten" not in (out.routing_decision or {})

    def test_valid_marker_prose_content_irrelevant(self):
        """prose ไม่มี canonical sentence เลยก็ตาม — marker valid →
        enforce ไม่แก้/ไม่เติม (prose ไม่เคยถูก consult)."""
        resp = _resp(
            "WPB100L ราคา 990 บาทค่ะ พร้อมส่งค่ะ",
            {**_PDEC_RD, "composition": {
                "domains": ["product", "policy"],
                "policy_text": guards._POLICY_TEXT_INELIGIBLE}})
        out = guards.enforce(resp, self._REQ)
        assert out.answer == resp.answer == (
            "WPB100L ราคา 990 บาทค่ะ พร้อมส่งค่ะ")

    def test_canonical_sentence_in_prose_not_structural_proof(self):
        """finding H1: product prose ที่บรรจุ canonical sentence เป๊ะ ๆ
        ไม่ใช่ structural proof — marker ขาด "policy" domain → fail
        closed wholesale render (typed outcome ชนะทั้งก้อน)."""
        rd = {"policy_decision": dict(_PDEC_RD["policy_decision"]),
              "composition": {"domains": ["product"],
                              "policy_text": None}}
        resp = _resp(
            "WPB100L ราคา 990 บาทค่ะ\n\n"
            "เคสนี้ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืนนะคะ", rd)
        out = guards.enforce(resp, self._REQ)
        assert out.answer == guards._POLICY_TEXT_INELIGIBLE
        assert out.routing_decision.get("composition_marker_invalid")
        assert out.routing_decision.get("guard_rewritten") == \
            "policy_decision"

    def test_mismatched_policy_text_fails_closed(self):
        """marker มี "policy" แต่ policy_text ไม่ตรง outcome (eligible
        vs ineligible) → structural corruption → deterministic
        wholesale render, ไม่มี prose scanning."""
        rd = {"policy_decision": dict(_PDEC_RD["policy_decision"]),
              "composition": {"domains": ["product", "policy"],
                              "policy_text": guards._POLICY_TEXT_ELIGIBLE}}
        resp = _resp("WPB100L ราคา 990 บาทค่ะ\n\n"
                     + guards._POLICY_TEXT_ELIGIBLE, rd)
        out = guards.enforce(resp, self._REQ)
        # outcome = ineligible → canonical ineligible เท่านั้น
        assert out.answer == guards._POLICY_TEXT_INELIGIBLE
        assert out.answer_segments == [guards._POLICY_TEXT_INELIGIBLE]
        assert out.routing_decision.get("composition_marker_invalid")

    @pytest.mark.parametrize("bad_domains", [
        "not-policy-domain",     # substring "policy" — membership hole
        {"policy": True},        # dict-key membership
        ("policy",),             # tuple — producer contract = list only
        None,                    # absent
    ])
    def test_malformed_domains_type_fails_closed(self, bad_domains):
        """marker.domains contract = list เท่านั้น (producer ส่ง list
        ใน _finalize_answer) — non-list/missing → fail closed ด้วย
        deterministic wholesale render; ห้าม member-check บน
        string/dict/tuple."""
        rd = {"policy_decision": dict(_PDEC_RD["policy_decision"]),
              "composition": {"domains": bad_domains,
                              "policy_text": guards._POLICY_TEXT_INELIGIBLE}}
        resp = _resp("WPB100L ราคา 990 บาทค่ะ พร้อมส่งค่ะ", rd)
        out = guards.enforce(resp, self._REQ)
        assert out.answer == guards._POLICY_TEXT_INELIGIBLE
        assert out.answer_segments == [guards._POLICY_TEXT_INELIGIBLE]
        assert out.routing_decision.get("guard_rewritten") == \
            "policy_decision"
        assert out.routing_decision.get("composition_marker_invalid") is True

    def test_composition_enforce_idempotent(self):
        """valid marker → untouched (ทั้งสองรอบ) — idempotent เดิม."""
        resp = _resp(
            "WPB100L ราคา 990 บาทค่ะ\n\n"
            "เคสนี้ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืนนะคะ",
            {**_PDEC_RD, "composition": {
                "domains": ["product", "policy"],
                "policy_text": guards._POLICY_TEXT_INELIGIBLE}})
        once = guards.enforce(resp, self._REQ)
        a1 = once.answer
        twice = guards.enforce(once, self._REQ)
        assert twice.answer == a1

    def test_no_marker_wholesale_render_unchanged(self):
        """flag-OFF pure policy → wholesale deterministic render เดิม."""
        resp = _resp("anything goes here", dict(_PDEC_RD))
        out = guards.enforce(resp, SimpleNamespace(message="m", history=[]))
        assert out.answer == guards._POLICY_TEXT_INELIGIBLE


# ────────────────────────────────────────────────────────────────────────────
# E — E2E flag-ON mixed product+policy (real app.chat via _install)
# ────────────────────────────────────────────────────────────────────────────

class TestE2EMixedComposition:

    def test_flag_on_ineligible_composes_structural_segments(
            self, monkeypatch):
        """typed ineligible + product segment ที่มี injected approval —
        final: product segment ผ่านตรง (ไม่มี prose parser) + canonical
        ineligible segment อยู่ครบ; handoff ไม่ถูกเรียก.
        Residual: model อาจเขียน policy prose ใน product segment —
        activation blocker ที่ documented แล้ว (flag OFF)."""
        fx = _fx_mixed("p8-mixed-inel", grouped=True,
                       records=[_RULE_INELIGIBLE],
                       llm_reply="WPB100L ราคา 990 บาทค่ะ "
                                 "เคสนี้เปลี่ยนได้เลยนะคะ")
        sel = _sel_for(_MIXED_MSG, _MIXED_IR, [_wpb_unit()])
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=sel)
        assert calls["n"] == 1, "grouped selection exactly once"
        assert not handoffs, f"compose must not hand off: {handoffs}"
        assert len(_typed_calls(captured)) == 1, captured.calls
        assert all(c["fn"] not in ("answer", "answer_general")
                   for c in captured.calls)
        assert "WPB100L ราคา 990 บาทค่ะ" in resp.answer
        assert "ยังไม่เข้าเงื่อนไข" in resp.answer
        rd = resp.routing_decision
        assert rd.get("composition"), "composition marker missing"
        assert rd.get("policy_decision", {}).get("outcome") == "ineligible"

    def test_flag_on_eligible_composes(self, monkeypatch):
        fx = _fx_mixed("p8-mixed-elig", grouped=True,
                       records=[_RULE_ELIGIBLE],
                       llm_reply="WPB100L ราคา 990 บาทค่ะ")
        sel = _sel_for(_MIXED_MSG, _MIXED_IR, [_wpb_unit()])
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=sel)
        assert not handoffs
        assert "WPB100L ราคา 990 บาทค่ะ" in resp.answer
        assert "เปลี่ยน/คืนได้ตามเงื่อนไข" in resp.answer
        assert len(_typed_calls(captured)) == 1

    def test_flag_off_mixed_still_handoffs(self, monkeypatch):
        """flag OFF → precedence เดิม: fail-closed handoff (regression pin)."""
        fx = _fx_mixed("p8-mixed-off", grouped=False,
                       records=[_RULE_INELIGIBLE],
                       llm_reply="unused")
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=None)
        assert calls["n"] == 0
        assert len(handoffs) == 1
        assert "แอดมินตรวจสอบเงื่อนไข" in resp.answer
        assert not _typed_calls(captured)

    def test_flag_on_unknown_outcome_still_handoffs(self, monkeypatch):
        """typed unknown/admin_review → terminal handoff precedence คงเดิม."""
        fx = _fx_mixed("p8-mixed-unk", grouped=True,
                       records=[], llm_reply="unused")
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=None)
        assert len(handoffs) == 1, f"unknown must still hand off: {resp.answer}"
        assert not _typed_calls(captured)

    def test_flag_on_missing_product_evidence_policy_still_answers(
            self, monkeypatch):
        """empty selection → product need unanswered แต่ policy segment
        ยังตอบ typed outcome (ไม่ใช่ handoff)."""
        fx = _fx_mixed("p8-mixed-empty", grouped=True,
                       records=[_RULE_INELIGIBLE], llm_reply="unused")
        sel = _sel_for(_MIXED_MSG, _MIXED_IR, [])
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=sel)
        assert not handoffs
        assert not _typed_calls(captured), "empty ctx → zero model calls"
        assert "ยังไม่เข้าเงื่อนไข" in resp.answer

    def test_flag_on_one_compose_one_finalize(self, monkeypatch):
        """M1 — ต่อ turn: compose=1, render=1, finalize=1,
        split_segments=1 และไม่มี prose mutation หลัง finalizer."""
        _import_app(monkeypatch)
        from shopeechat import app as _app
        counts = {"compose": 0, "render": 0, "finalize": 0,
                  "split": 0}
        finalized: list[str] = []
        orig_compose = acx.compose_answer
        orig_render = _app._render_composition
        orig_finalize = _app._finalize_answer
        orig_split = llm.split_segments

        def _compose_spy(**kw):
            counts["compose"] += 1
            return orig_compose(**kw)

        def _render_spy(*a, **kw):
            counts["render"] += 1
            return orig_render(*a, **kw)

        def _finalize_spy(*a, **kw):
            counts["finalize"] += 1
            resp = orig_finalize(*a, **kw)
            finalized.append(resp.answer)
            return resp

        def _split_spy(*a, **kw):
            counts["split"] += 1
            return orig_split(*a, **kw)

        monkeypatch.setattr(acx, "compose_answer", _compose_spy)
        monkeypatch.setattr(_app, "_render_composition", _render_spy)
        monkeypatch.setattr(_app, "_finalize_answer", _finalize_spy)
        monkeypatch.setattr(llm, "split_segments", _split_spy)
        fx = _fx_mixed("p8-mixed-count", grouped=True,
                       records=[_RULE_INELIGIBLE],
                       llm_reply="WPB100L ราคา 990 บาทค่ะ")
        sel = _sel_for(_MIXED_MSG, _MIXED_IR, [_wpb_unit()])
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=sel)
        assert counts == {"compose": 1, "render": 1, "finalize": 1,
                          "split": 1}, counts
        # ไม่มี prose mutation หลัง finalizer (enforce เห็น canonical
        #   segment ครบ → return เดิม)
        assert finalized == [resp.answer], (
            f"post-finalizer prose mutation: {finalized!r} vs {resp.answer!r}")

    def test_flag_on_model_web_call_bounds(self, monkeypatch):
        """answer model ≤1 + web ≤1 (web disabled seam → 0)."""
        fx = _fx_mixed("p8-mixed-bounds", grouped=True,
                       records=[_RULE_INELIGIBLE],
                       llm_reply="WPB100L ราคา 990 บาทค่ะ")
        sel = _sel_for(_MIXED_MSG, _MIXED_IR, [_wpb_unit()])
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=sel)
        answer_calls = [c for c in captured.calls
                        if c["fn"] in ("answer", "answer_typed")]
        assert len(answer_calls) <= 1
        assert calls["n"] == 1, "grouped retrieval at most once"

    def test_flag_on_no_duplicated_segment(self, monkeypatch):
        fx = _fx_mixed("p8-mixed-dup", grouped=True,
                       records=[_RULE_INELIGIBLE],
                       llm_reply="WPB100L ราคา 990 บาทค่ะ")
        sel = _sel_for(_MIXED_MSG, _MIXED_IR, [_wpb_unit()])
        resp, captured, handoffs, calls = _chat(
            monkeypatch, fx, _MIXED_MSG, sel_artifact=sel)
        assert resp.answer.count("ยังไม่เข้าเงื่อนไขการเปลี่ยน/คืน") == 1
        assert resp.answer.count("WPB100L ราคา 990 บาทค่ะ") == 1


class TestOrderTerminalPrecedence:
    """M2 — early_order_flow เป็น upstream-terminal: intercept ก่อน
    TurnPlan/composition → turn ที่มีทั้ง product+order content ถูก
    order flow ตอบจบ; composer/finalizer ไม่ทำงาน (composition ไม่มี
    order business logic — order evidence เป็น owner ของ order_flow)."""

    _ORDER_INFO = {
        "found": True,
        "order_sn": "240215MCEQMT60",
        "order_status": "จัดส่งแล้ว",
        "order_status_raw": "SHIPPED",
        "logistics_status": "ขนส่งรับพัสดุแล้ว",
        "logistics_status_raw": "PICKED_UP",
        "items": [{"name": "WPB100L", "model_name": "WPB100L",
                   "quantity": 1, "price": 990.0,
                   "original_price": 990.0, "image_url": "",
                   "sku": "WPB100L", "item_id": "1101",
                   "model_id": "2201"}],
        "item_count": 1,
        "shipping_carrier": "Kerry",
        "tracking_no": "K12345678",
        "tracking_numbers": ["K12345678"],
        "create_time": "15 ก.พ. 2569", "pay_time": "15 ก.พ. 2569",
        "ship_by_date": "17 ก.พ. 2569", "pickup_done_time": "16 ก.พ. 2569",
        "delivery_time": "ไม่ระบุ", "delivery_time_raw": None,
        "update_time": "16 ก.พ. 2569",
        "recipient_address": "******",
        "total_amount": 990.0, "currency": "THB",
        "estimated_shipping_fee": 0.0, "actual_shipping_fee": 0.0,
        "payment_method": "COD",
    }

    def test_product_plus_order_message_terminal_order_flow(
            self, monkeypatch):
        _import_app(monkeypatch)
        from shopeechat import app as _app
        from shopeechat import order_store as _os
        fx = _fx_mixed("p8-order-term", grouped=True,
                       records=[_RULE_INELIGIBLE],
                       llm_reply="ORDER_SENTINEL สถานะ: จัดส่งแล้ว")
        fx["orders"] = [dict(self._ORDER_INFO)]
        client, captured, handoffs = _install(monkeypatch, fx)
        calls = {"n": 0}
        monkeypatch.setattr(
            rr, "run_grouped_selection",
            lambda *a, **k: calls.__setitem__("n", calls["n"] + 1)
            or _sel_for(_MIXED_MSG, _MIXED_IR, [_wpb_unit()]))
        counts = {"compose": 0, "finalize": 0}
        monkeypatch.setattr(
            acx, "compose_answer",
            lambda **kw: counts.__setitem__(
                "compose", counts["compose"] + 1))
        monkeypatch.setattr(
            _app, "_finalize_answer",
            lambda *a, **kw: counts.__setitem__(
                "finalize", counts["finalize"] + 1))
        lookups = {"n": 0}
        _seam = _os.lookup_order

        def _spy(order_sn, shop_filter=None):
            lookups["n"] += 1
            return _seam(order_sn, shop_filter=shop_filter)

        monkeypatch.setattr(_os, "lookup_order", _spy)
        resp = _app.chat(_app.ChatRequest(
            message="WPB100L ดีไหมคะ ออเดอร์ 240215MCEQMT60 ถึงไหม",
            shop=fx["shop"], platform="shopee",
            history=[], conversation_id=fx["conversation_id"],
            limit=5, simulate_assignment=True,
            test_source="phase8_composition"))
        assert resp.source == "order_lookup", resp.source
        assert "ORDER_SENTINEL" in resp.answer
        assert lookups["n"] == 1, "order lookup exactly once (owner ของมัน)"
        assert calls["n"] == 0, "grouped selection ไม่ถูกเรียก (terminal ก่อน plan)"
        assert counts == {"compose": 0, "finalize": 0}, counts
        assert not _typed_calls(captured), captured.calls
        assert not handoffs


# ────────────────────────────────────────────────────────────────────────────
# F — system-prompt distillation (PART 4): typed path prompt = legacy prompt
#     minus proven-stale block; legacy SYSTEM_INSTRUCTION byte-identical
# ────────────────────────────────────────────────────────────────────────────

import hashlib  # noqa: E402

# sha256 ของ SYSTEM_INSTRUCTION เดิม (pre-split) — pin ว่า legacy caller
#   เห็น prompt เดิมเป๊ะหลัง refactor
_ORIGINAL_SYSTEM_SHA256 = (
    "9b209fe782c85eedda7a2114a2aa4d0a7aac14f4d54d2f4a89288f5ee96d5f54")


class TestPromptDistillation:

    def test_legacy_system_instruction_byte_identical(self):
        h = hashlib.sha256(
            llm.SYSTEM_INSTRUCTION.encode("utf-8")).hexdigest()
        assert h == _ORIGINAL_SYSTEM_SHA256

    def test_typed_prompt_drops_only_stale_block(self):
        assert llm.TYPED_SYSTEM_INSTRUCTION == (
            llm._SYS_CORE_A + llm._SYS_CORE_B)
        assert llm.SYSTEM_INSTRUCTION == (
            llm._SYS_CORE_A + llm._SYS_LEGACY_CLAIM_NOTE + llm._SYS_CORE_B)
        dropped = (len(llm.SYSTEM_INSTRUCTION.encode("utf-8"))
                   - len(llm.TYPED_SYSTEM_INSTRUCTION.encode("utf-8")))
        assert dropped == len(llm._SYS_LEGACY_CLAIM_NOTE.encode("utf-8"))

    def test_typed_prompt_excludes_stale_claim(self):
        assert "LLM จะไม่ถูกเรียกเลย" not in llm.TYPED_SYSTEM_INSTRUCTION
        # "state machine ส่งคำตอบให้แล้ว" ยังอยู่ — กฎขายสินค้า (live)
        #   ใช้ประโยคเดียวกันแต่คนละบริบท → ตัดเฉพาะ stale clause ไม่ได้
        #   ตัดทั้งประโยค
        assert "state machine ส่งคำตอบให้แล้ว" in llm.TYPED_SYSTEM_INSTRUCTION

    def test_typed_prompt_required_anchors(self):
        t = llm.TYPED_SYSTEM_INSTRUCTION
        for anchor in (
            "ค่ะ", "ครับ",              # persona + gendered-particle ban
            "ห้ามบอกราคา",               # price ban
            "ลูกค้าทักจากร้าน",          # shop isolation
            "status=NORMAL",             # availability gate
            "_available_for_sale",
            "เคลม", "แอดมิน",            # claim / handoff constraints
            "ภาษาไทย",                   # language constraint
            "ตารางเปรียบเทียบ",          # compare table format
            "image_url", "short_link",   # media / product links
            "description_excerpt",       # grounding field
        ):
            assert anchor in t, anchor

    def test_answer_typed_uses_typed_prompt(self, monkeypatch):
        captured = {}
        monkeypatch.setattr(llm, "_client", lambda: None)

        class _R:
            text = "ตอบค่ะ"
            usage_metadata = None

        monkeypatch.setattr(
            llm, "_generate",
            lambda m, contents, config, **kw:
                captured.update(config=config) or _R())
        ctx = _product_ctx()
        llm.answer_typed(context=ctx, shop_hint="S", model="stub-model")
        si = captured["config"]["system_instruction"]
        assert si.startswith(llm._SYS_CORE_A[:60])
        assert "LLM จะไม่ถูกเรียกเลย" not in si
