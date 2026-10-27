"""Phase 10B r11 — Pingevox conversation-transition contracts.

RED targets (real owners, offline — replay harness drives real chat()):

  A. exact item tag → only that item is subject/context; bundle siblings
     whose *name contains* the same model code are not promoted to subject
     (`_select_one` `_code_match` promotion must not override explicit
     item-id subject_refs).
  B. typed greeting intent → greeting action: zero retrieval, zero product
     cards, subject set untouched, greeting reply — not EMPTY_CONTEXT_REPLY.
  C. fresh recommendation (subject_scope=none + new target) must not
     inherit the previous turn's item id as a need subject — the history
     anchor scan must not re-inject it into `tag_item_ids` on the grouped
     path.
  D. subtype pivot (charger → adapter) keeps typed target, drops the old
     item subject.
  E. guard spec-claim rewrite emits the defer sentence at most once per
     answer, not once per ungrounded token/segment.
"""
from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

import test_legacy_turn_incident_replay as replay  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import retrieval_selection as rsel  # noqa: E402
from shopeechat import conversation_products as cp  # noqa: E402


def _doc(iid, name, subtype="cable", ptype="อุปกรณ์ชาร์จ"):
    return {"item_id": float(iid), "item_name": name,
            "item_status": "NORMAL", "shopname": "KingGadgets",
            "cat_name": ptype, "condition": "new",
            "brand": {"brand_id": 1, "original_brand_name": "CUKTECH"},
            "gen_price": 490.0, "short_link": "https://s.shopee.co.th/x",
            "image": {"image_url_list": ["https://img.example/x.jpg"],
                      "image_id_list": ["x"]},
            "description": f"{name} spec text",
            "charger_subtype": subtype,
            "model": [{"model_id": float(iid), "model_name": name.split()[1],
                       "model_sku": "", "model_status": "MODEL_NORMAL",
                       "stock_info_v2": {"summary_info":
                                        {"total_available_stock": 5}},
                       "tier_index": [0],
                       "price_info": [{"current_price": 49000}]}],
            "tier_variation": [{"name": "สี",
                                "option_list": [{"option": "Black"}]}],
            "standardise_tier_variation": [], "weight": "0.2",
            "dimension": {"package_height": 5, "package_length": 10,
                          "package_width": 5}}


_CATALOG = [
    _doc(9001, "CUKTECH CTL301 USB-C to Lightning MFi 480Mbps"),
    _doc(9002, "CUKTECH CTC615W USB-C to C + CTL301 Lightning bundle"),
    _doc(9003, "CUKTECH CTC615P 6A 240W USB-C to USB-C"),
    _doc(9004, "CUKTECH AD652S 65W GaN หัวชาร์จ USB-C 2 พอร์ต",
         subtype="adapter"),
    _doc(9005, "CUKTECH AD653T ชุดชาร์จเร็ว Adapter 65W",
         subtype="adapter"),
]


def _fx(turns, **kw):
    fx = {"id": "pingevox-r11", "shop": "KingGadgets", "platform": "shopee",
          "conversation_id": "pgx-conv-1", "catalog": copy.deepcopy(_CATALOG),
          "turns": turns,
          "runtime_flags": {"grouped_selection": True},
          "intent_result": kw.get("intent_result",
                                  {"intent": "other", "confidence": 0.5})}
    fx.update(kw)
    return fx


def _subj_ids(client):
    docs = client[replay.ADMIN_DB]["conversation_products"]._docs
    for d in docs:
        ss = d.get("subject_set") or {}
        ids = ss.get("subject_ids")
        if ids:
            return tuple(str(i) for i in ids)
    return ()


def _plan_spy(monkeypatch):
    plans = []
    real = td.decide_turn

    def _spy(msg, **kw):
        plan = real(msg, **kw)
        plans.append(plan)
        return plan
    monkeypatch.setattr(td, "decide_turn", _spy)
    return plans


# ═══ A — exact item ownership ═══════════════════════════════════════════════

class TestExactItemOwnership:
    # tag message ถูก rewrite เป็น synth ก่อน classify → per-turn intent_result
    #   (keyed by text) ไม่ match — ต้องใส่ product_spec เป็น fx-level default
    _T1 = {"text": "[สินค้า: 9001]", "item_id": "9001"}
    _SPEC = {"intent": "product_spec", "confidence": 0.95,
             "subject_scope": "explicit"}

    def test_response_products_only_tagged_item(self, monkeypatch):
        records, captured, client = replay._replay(
            monkeypatch, _fx([self._T1], intent_result=dict(self._SPEC)))
        resp = records[0]["resp"]
        ids = {replay._norm(p.get("item_id")) for p in resp.products}
        assert ids == {9001}, f"exact-item turn leaked {ids}"

    def test_persisted_subject_is_tagged_item_only(self, monkeypatch):
        records, captured, client = replay._replay(
            monkeypatch, _fx([self._T1], intent_result=dict(self._SPEC)))
        assert _subj_ids(client) == ("9001",)

    def test_llm_context_only_tagged_item(self, monkeypatch):
        records, captured, client = replay._replay(
            monkeypatch, _fx([self._T1], intent_result=dict(self._SPEC)))
        seen = {replay._norm(p.get("item_id"))
                for c in records[0]["llm_calls"]
                for p in (c.get("products") or [])}
        assert seen <= {9001}, f"llm ctx leaked {seen - {9001}}"


# ═══ B — typed greeting ═════════════════════════════════════════════════════

class TestGreeting:
    _GREET_INTENT = {"intent": "greeting", "confidence": 0.95,
                     "subject_scope": "none", "subject_count": None}

    def test_greeting_action_no_retrieval_no_subject_mutation(
            self, monkeypatch):
        records, captured, client = replay._replay(monkeypatch, _fx([
            {"text": "[สินค้า: 9001]", "item_id": "9001"},
            {"text": "ซาหวัดดีจ้า", "intent_result": dict(self._GREET_INTENT)},
        ], intent_result={"intent": "product_spec", "confidence": 0.95,
                          "subject_scope": "explicit"}))
        t2 = records[1]["resp"]
        assert t2.products == []
        assert not records[1]["llm_calls"], "greeting reached product answer path"
        from shopeechat import answer_context as acx
        assert t2.answer != acx.EMPTY_CONTEXT_REPLY
        assert _subj_ids(client) == ("9001",)   # greeting must not clobber

    def test_greeting_after_recommend_keeps_set(self, monkeypatch):
        records, captured, client = replay._replay(monkeypatch, _fx([
            {"text": "ขอสายชาร์จหน่อย",
             "intent_result": {"intent": "product_recommend",
                               "confidence": 0.9, "product_type": "charger",
                               "charger_subtype": "cable"}},
            {"text": "ดีจ้า", "intent_result": dict(self._GREET_INTENT)},
        ]))
        t2 = records[1]["resp"]
        assert t2.products == []
        assert t2.source == "greeting"
        assert not records[1]["llm_calls"]


# ═══ C+D — new-topic recommendation / subtype pivot ═════════════════════════

class TestSubjectPrecedence:
    _TAG = {"text": "[สินค้า: 9001]", "item_id": "9001"}
    _SPEC = {"intent": "product_spec", "confidence": 0.95,
             "subject_scope": "explicit"}
    _RECO = {"text": "อยากได้ของที่ใช้กับ xiaomi 17 ultra",
             "intent_result": {"intent": "product_recommend",
                               "confidence": 0.98, "product_type": "charger",
                               "charger_subtype": "adapter",
                               "target_device": "xiaomi 17 ultra",
                               "relation_target": "xiaomi 17 ultra",
                               "subject_scope": "none", "subject_count": None}}
    _PIVOT = {"text": "หัวชาร์จละ",
              "intent_result": {"intent": "product_recommend",
                                "confidence": 0.98, "product_type": "charger",
                                "charger_subtype": "adapter",
                                "target_device": "xiaomi 17 ultra",
                                "subject_scope": "none", "subject_count": None}}

    def test_fresh_recommend_does_not_inherit_anchor_subject(
            self, monkeypatch):
        plans = _plan_spy(monkeypatch)
        replay._replay(monkeypatch, _fx([self._TAG, self._RECO], intent_result=dict(self._SPEC)))
        plan = plans[-1]
        prodish = [n for n in plan.needs
                   if n.kind in ("product", "compare", "compat")]
        assert prodish, "recommend turn produced no productish need"
        for n in prodish:
            assert "9001" not in {str(s) for s in n.subject_refs}, (
                f"history anchor re-injected as {n.kind}/{n.operation} "
                f"subject: {n.subject_refs}")
            assert "xiaomi 17 ultra" in {str(t).lower() for t in
                                         n.target_refs}

    def test_subtype_pivot_drops_old_subject_keeps_target(
            self, monkeypatch):
        plans = _plan_spy(monkeypatch)
        replay._replay(monkeypatch, _fx([self._TAG, self._RECO,
                                         self._PIVOT], intent_result=dict(self._SPEC)))
        plan = plans[-1]
        prodish = [n for n in plan.needs if n.kind == "product"]
        assert prodish
        for n in prodish:
            assert "9001" not in {str(s) for s in n.subject_refs}
            assert "xiaomi 17 ultra" in {str(t).lower()
                                         for t in n.target_refs}
            assert "adapter" in (n.subtypes or frozenset())

    def test_anchor_not_presented_as_selected(self, monkeypatch):
        records, captured, client = replay._replay(
            monkeypatch, _fx([self._TAG, self._RECO]))
        resp = records[1]["resp"]
        assert resp.products, "recommend turn returned no products"
        presented = {replay._norm(p.get("item_id")) for p in resp.products}
        # anchor may be context only; it must not be the presented answer set
        assert presented - {9001}, "only the stale anchor was presented"


# ═══ E — composition: defer sentence once ═══════════════════════════════════

class TestCompositionDedupe:
    def test_defer_sentence_emitted_once(self, monkeypatch):
        from shopeechat import guards
        from types import SimpleNamespace
        resp = SimpleNamespace(
            answer=("สายนี้รองรับ 65W นะคะ ||| แล้วก็โอนข้อมูล 480Mbps "
                    "ได้ครับ ||| ชาร์จเร็ว 120W แน่นอนค่ะ"),
            answer_segments=[], handoff_to_admin=False,
            routing_decision={})
        req = SimpleNamespace(message="spec?", shop="KingGadgets",
                              platform="shopee", conversation_id="c",
                              history=[])
        guards.enforce(resp, req)
        n = resp.answer.count("เดี๋ยวขอให้แอดมินตรวจสอบให้นะคะ")
        assert n <= 1, f"defer sentence emitted {n}×: {resp.answer!r}"

    def test_model_claim_rewrites_all_ungrounded_token_clauses(
            self, monkeypatch):
        """Live defect (Q3): model emitted a fabricated product name +
        compat claim in a *second* clause — single-shot rewrite fixed only
        the first clause. Every clause carrying an ungrounded model token
        must go; the defer sentence may appear at most once."""
        from shopeechat import guards
        from types import SimpleNamespace
        resp = SimpleNamespace(
            answer=("สเปค AD1003 ตัวนี้ดีมากค่ะ\n\n"
                    "CUKTECH AD1003T + CMC615P เซตหัวชาร์จ "
                    "ใช้งานร่วมกับ xiaomi 17 ultra ได้ค่ะ"),
            answer_segments=[], handoff_to_admin=False,
            products=[], routing_decision={})
        req = SimpleNamespace(message="มีอะไรแนะนำไหม", shop="KingGadgets",
                              platform="shopee", conversation_id="c",
                              history=[])
        guards.enforce(resp, req)
        for tok in ("AD1003", "AD1003T", "CMC615P"):
            assert tok not in resp.answer, \
                f"ungrounded token {tok} survived: {resp.answer!r}"
        n = resp.answer.count("เดี๋ยวขอให้แอดมินตรวจสอบให้นะคะ")
        assert n <= 1, f"defer sentence emitted {n}×: {resp.answer!r}"
