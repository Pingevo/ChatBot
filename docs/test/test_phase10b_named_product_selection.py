"""test_phase10b_named_product_selection.py — Phase 10B grouped named-product
identity/target-ownership tests.

contract (r3): lexical tokens are candidates only —
- model_codes = trusted code-shape identity (_extract_codes) เท่านั้น
- model_terms = unverified phrase evidence (soft hints on requests)
- target_device = compat target เฉพาะเมื่อ connector/relation position +
  authoritative device index (_SPEC_INDEX) ยืนยัน
- spec text ไม่ใช่ product/device identity
- request เดียวต่อ source/query — soft evidence merge เข้า existing request
  (ไม่สร้าง physical fetch ซ้ำ); open request เฉพาะเมื่อไม่มี request เลย
- _bucket explicit-identity precedence = resolved identity เท่านั้น
  (trusted code หรือ card ที่ name-match term ที่ recall resolve มาจริง)

offline only — snap=None เสมอ; fetcher stub แทน boundary เดียว;
production-fetch proof ใช้ fetch_products จริงกับ fake collection leaf
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import route_context as rc  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402
from shopeechat import retrieval_runtime as rrt  # noqa: E402
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import runtime_config as rcfg  # noqa: E402
from shopeechat import product_store as ps  # noqa: E402
from shopeechat.retrieval_planner import RetrievalRequest  # noqa: E402
from shopeechat.retrieval_executor import _bucket  # noqa: E402
from shopeechat.retrieval_policy import make_evidence_card  # noqa: E402

MSG_SPEC = "YOBYBO Sugar 20 สเปคเป็นยังไง รองรับบลูทูธเวอร์ชันไหน"
MSG_TYPED_NAMED = "หูฟัง YOBYBO Sugar 20 สเปคเป็นยังไง"
MSG_PRICE = "YOBYBO Sugar 20 ราคาเท่าไหร่ มีของไหม ขอลิงก์"
MSG_CMP = "YOBYBO Sugar 20 กับ IMILAB W01 ต่างกันยังไง"
MSG_STOCK = "YOBYBO Sugar 20 ยังมีของไหม"
MSG_W01 = "W01 รองรับ Strava ไหม"
MSG_USB = "สาย USB 2.0 มีไหม"
MSG_IP68 = "หูฟัง IP68 กันน้ำไหม"
MSG_CHG_IPHONE = "หัวชาร์จใช้กับ iphone 15 ได้ไหม"
MSG_WATCH_PHONE = "นาฬิกา mi watch 8 เชื่อมกับ iphone 15 ได้ไหม"
MSG_AD1404T = "สายชาร์จใช้กับ AD1404T"

_INTENT_OTHER = {"intent": "other", "confidence": 0}


def _card(name, item_id, *, status="NORMAL", stock=3, **kw):
    """legacy listing card shape เดียวกับ to_product_card output —
    stock truth ผ่าน stock_info_v2 (resolver เจ้าของเดิม)"""
    c = {"name": name, "item_id": item_id, "shop": "canary-shop",
         "status": status, "total_stock": stock,
         "model": [{"name": name, "model_status": "MODEL_NORMAL",
                    "stock_info_v2": {"summary_info": {
                        "total_available_stock": stock}}}]}
    c.update(kw)
    return c


YOBYBO = _card("YOBYBO Sugar 20 หูฟังไร้สาย TWS Bluetooth 5.3", "9001")
IMILAB = _card("IMILAB W01 สมาร์ทวอช", "9002")
CABLE_USB2 = _card("สายชาร์จ USB 2.0 Type-C 1m", "9003")
MIWATCH = _card("Mi Watch 8 สมาร์ทวอช", "9004")


# ---------- executor fetch-boundary instrumentation ----------

def _fetch(cards, calls: list):
    """fetcher stub ที่ executor boundary — honors retrieval_profile +
    recall semantics; บันทึกทุก physical fetch call (dedupe proof)"""
    def f(query, *, retrieval_profile, shop, limit, snap=None):
        calls.append((query, shop))
        prof = retrieval_profile
        toks = {t.lower() for t in ps._raw_model_tokens(query)}
        toks |= {str(c).lower()
                 for c in (getattr(prof, "model_codes", ()) or ())}
        ptypes = set(getattr(prof, "product_types", ()) or ())
        out = []
        for c in cards:
            if shop and c.get("shop") != shop:
                continue
            name = c.get("name") or ""
            if (any(ps._model_token_in_name(name, t) for t in toks)
                    or (ptypes and ps._detect_product_types(name) & ptypes)):
                out.append(c)
        return out
    return f


def _chain(msg, cards, intent_result=_INTENT_OTHER):
    """production chain เดียวกับ app.py grouped callsite:
    decide_turn → build_retrieval_profile → run_grouped_selection →
    compile_answer_context — fetcher stub เท่านั้นที่ถูกแทน.
    คืน (plan, prof, out, ctx, fetch_calls)"""
    calls: list = []
    plan = td.decide_turn(msg, history=None, ticket_state=None,
                          claim_state=None, intent_result=intent_result)
    prof = rc.build_retrieval_profile(
        msg, history=None, intent_result=intent_result,
        shop="canary-shop", platform="shopee", anchor_cards=[])
    out = rrt.run_grouped_selection(
        prof, message=msg, shop="canary-shop", platform="shopee",
        fetcher=_fetch(cards, calls), legacy_fetcher=_fetch(cards, calls),
        needs=plan.needs, snap=None)
    assert out is not None, "grouped pipeline must not raise"
    ctx = acx.compile_answer_context(
        needs=plan.needs, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=prof)
    return plan, prof, out, ctx, calls


def _idents(sel):
    return {s.identity for s in sel.selected}


# ---------- production-owner fetch proof (PART 3) ----------
# leaf boundary เดียวที่ถูกแทน: collection.find — production query
# construction / recall union / card conversion (to_product_card) จริงทั้งหมด

def _get_path(doc: dict, path: str):
    cur = doc
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _match_op(val, cond) -> bool:
    if isinstance(cond, dict):
        for op, v in cond.items():
            if op == "$options":
                continue
            if op == "$regex":
                flags = re.IGNORECASE if "i" in (cond.get("$options") or "") else 0
                if not isinstance(val, str) or not re.search(v, val, flags):
                    return False
            elif op == "$in":
                if val not in v:
                    return False
            elif op == "$ne":
                if val == v:
                    return False
            elif op == "$exists":
                if (val is not None) != bool(v):
                    return False
            elif op in ("$gt", "$gte", "$lt", "$lte"):
                if val is None:
                    return False
                cmp = {"$gt": val > v, "$gte": val >= v,
                       "$lt": val < v, "$lte": val <= v}[op]
                if not cmp:
                    return False
            else:
                raise AssertionError(f"fake-mongo: unsupported op {op}")
        return True
    if isinstance(val, list):
        return cond in val
    return val == cond


def _doc_match(doc: dict, query: dict) -> bool:
    for key, cond in (query or {}).items():
        if key == "$or":
            if not any(_doc_match(doc, c) for c in cond):
                return False
        elif key == "$and":
            if not all(_doc_match(doc, c) for c in cond):
                return False
        elif key == "$nor":
            if any(_doc_match(doc, c) for c in cond):
                return False
        elif not _match_op(_get_path(doc, key), cond):
            return False
    return True


class _FakeCursor(list):
    def limit(self, n):
        return _FakeCursor(self[:n])


class _FakeColl:
    """collection leaf — find(query, proj) applies the REAL production query"""

    def __init__(self, docs):
        self.docs = docs
        self.queries: list = []

    def find(self, query, proj=None):
        self.queries.append(query)
        return _FakeCursor([d for d in self.docs if _doc_match(d, query)])

    def find_one(self, query, proj=None):
        return next(iter(self.find(query, proj)), None)


class _FakeDb:
    def __init__(self, colls: dict):
        self._colls = colls

    def __getitem__(self, name):
        return self._colls[name]


def _doc(name, item_id, shop="canary-shop", cat="Mobile & Gadgets",
         stock=5, status="NORMAL", brand="YOBYBO"):
    """mongo doc shape เดียวกับ ShpProducts ที่ fetch_products อ่านจริง"""
    return {
        "item_id": int(item_id), "item_name": name, "item_status": status,
        "shopname": shop, "cat_name": cat, "description": "",
        "brand": {"original_brand_name": brand},
        "attribute_list": [],
        "stock_info_v2": {"summary_info": {"total_available_stock": stock}},
        "model": [{"name": name, "model_status": "MODEL_NORMAL",
                   "price_info": [{"current_price": [{"price": 990}]}],
                   "stock_info_v2": {"summary_info": {
                       "total_available_stock": stock}}}],
    }


# ---------- tests ----------

def test_named_product_emits_request_and_selects_identity():
    """untyped named product → profile.model_terms ∋ SUGAR20 (soft evidence,
    ไม่ใช่ code) → open request เดียว → message recall resolve → selected"""
    plan, prof, out, ctx, calls = _chain(MSG_SPEC, [YOBYBO])
    assert "SUGAR20" in getattr(prof, "model_terms", ()), (
        "first divergence: named-product phrase ไม่เข้า profile.model_terms")
    assert "SUGAR20" not in prof.model_codes, (
        "phrase candidate promoted into hard identity")
    assert len(out["requests"]) == 1, (
        f"expected one bounded request, got {len(out['requests'])}")
    term_reqs = [r for r in out["requests"]
                 if ("model_term", "SUGAR20") in r.soft_hints]
    assert term_reqs, "request must carry SUGAR20 as soft model_term evidence"
    assert len(calls) == len(out["requests"]) * 2, (
        f"duplicate physical fetch: {len(calls)} calls for "
        f"{len(out['requests'])} requests")
    assert "i:9001" in _idents(out["selection"]), (
        f"selected={[(s.identity, s.role) for s in out['selection'].selected]}")
    assert any("Sugar 20" in (p.get("name") or "") for p in ctx.products)


def test_typed_named_single_fetch_path():
    """typed+named ('หูฟัง YOBYBO Sugar 20'): soft evidence merge เข้า slot
    request เดิม — ห้ามสร้าง physical fetch ที่สองสำหรับ source/query เดียวกัน"""
    plan, prof, out, ctx, calls = _chain(MSG_TYPED_NAMED, [YOBYBO])
    assert "earphone" in prof.product_types
    assert "SUGAR20" in getattr(prof, "model_terms", ())
    assert len(out["requests"]) == 1, (
        f"typed+named must share one request path, got {len(out['requests'])}")
    req = out["requests"][0]
    assert ("model_term", "SUGAR20") in req.soft_hints, (
        "soft evidence not attached to the existing request")
    assert len(calls) == 2, (
        f"duplicate same-source fetch: {len(calls)} calls (1 req × 2 sources)")
    assert "i:9001" in _idents(out["selection"])


def test_named_compare_keeps_both_explicit_products():
    """compare: W01 trusted code + Sugar 20 soft term — ทั้งคู่ resolve ผ่าน
    request เดียวกัน (merge) — ห้าม duplicate fetch, ห้าม candidate อื่น"""
    plan, prof, out, ctx, calls = _chain(MSG_CMP, [YOBYBO, IMILAB])
    assert "W01" in prof.model_codes, f"codes={prof.model_codes}"
    assert "SUGAR20" in getattr(prof, "model_terms", ()), (
        f"model_terms={getattr(prof, 'model_terms', ())} — Sugar 20 dropped")
    assert "SUGAR20" not in prof.model_codes
    assert len(out["requests"]) == 1, (
        f"compare must share one request, got {len(out['requests'])}")
    assert len(calls) == 2, f"duplicate fetch: {len(calls)} calls"
    idents = _idents(out["selection"])
    assert "i:9001" in idents, "Sugar 20 subject dropped"
    assert "i:9002" in idents, "W01 subject dropped"
    assert idents <= {"i:9001", "i:9002"}, f"unrelated admitted: {idents}"


def test_spec_tokens_never_become_identity_or_target():
    """USB 2.0 / IP68 = specifications — ห้ามเป็น model_codes หรือ
    target_device; typed retrieval ยังทำงาน"""
    plan, prof, out, ctx, calls = _chain(MSG_USB, [CABLE_USB2])
    assert not prof.model_codes, f"spec became hard code: {prof.model_codes}"
    assert prof.target_device is None, (
        f"spec became device target: {prof.target_device}")
    assert len(out["requests"]) > 0, "typed request must still emit"
    for r in out["requests"]:
        assert ("model_code", "USB2") not in r.hard_filters
    assert "i:9003" in _idents(out["selection"]), "cable retrieval broken"

    plan2, prof2, out2, ctx2, calls2 = _chain(MSG_IP68, [YOBYBO])
    assert "IP68" not in prof2.model_codes, (
        f"IP rating became hard code: {prof2.model_codes}")
    assert prof2.target_device is None, (
        f"IP68 alias-fabricated into device target: {prof2.target_device}")
    assert len(out2["requests"]) > 0, "earphone request must emit"
    assert "i:9001" in _idents(out2["selection"]), (
        "earphone type retrieval broken")


def test_compat_target_device_never_product_identity():
    """'ใช้กับ iphone 15' → target_device exactly 'iphone 15' —
    ห้ามเป็น product identity หรือ term"""
    prof = rc.build_retrieval_profile(
        MSG_CHG_IPHONE, history=None, intent_result=_INTENT_OTHER,
        shop="s", platform="shopee", anchor_cards=[])
    assert prof.target_device == "iphone 15"
    assert "IPHONE15" not in prof.model_codes
    assert "IPHONE15" not in getattr(prof, "model_terms", ())


def test_watch_phone_product_and_target_stay_separate():
    """'นาฬิกา mi watch 8 เชื่อมกับ iphone 15' — watch phrase = product side,
    iphone 15 = authoritative compat target; roles must not cross"""
    plan, prof, out, ctx, calls = _chain(MSG_WATCH_PHONE, [MIWATCH])
    assert prof.target_device == "iphone 15", (
        f"connector target lost: {prof.target_device}")
    assert "IPHONE15" not in prof.model_codes, (
        f"target leaked into product identity: {prof.model_codes}")
    assert "IPHONE15" not in getattr(prof, "model_terms", ())
    assert len(out["requests"]) > 0, "watch-side request must emit"
    assert "i:9004" in _idents(out["selection"]), "watch product lost"
    # target ไม่ถูก select เป็น product; compat evidence ไม่มี → fail-closed
    assert ctx.compat_verdicts == (), "compat claim fabricated"


def test_ad1404t_stays_trusted_model_code():
    """regression: contiguous code (letters+digits glued) = trusted
    model_codes; reversed-compat behavior เดิม (สายชาร์จใช้กับ AD1404T)"""
    prof = rc.build_retrieval_profile(
        MSG_AD1404T, history=None, intent_result=_INTENT_OTHER,
        shop="s", platform="shopee", anchor_cards=[])
    assert "AD1404T" in prof.model_codes
    assert prof.target_device is None  # AD1404T คือ product ไม่ใช่ device


def test_wrong_type_gate_ignores_bare_term_hints():
    """_bucket: soft model_term hint ที่ card ไม่ได้ resolve (name ไม่ตรง)
    ต้องไม่ bypass type policy"""
    req = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"smartwatch"}), subtypes=frozenset(),
        model_codes=(), target_device=None, availability_mode="",
        compat_mode="", soft_hints=(("model_term", "USB2"),))
    cc = make_evidence_card(_card("Anker Nano หัวชาร์จ 100W", "9100"),
                            source="legacy", requested=())
    assert _bucket(cc, req) == ("rejected", "wrong_type")


def test_wrong_type_gate_yields_to_trusted_code_only():
    """_bucket: เฉพาะ trusted model_codes identity เท่านั้นที่ชนะ inferred
    type gate — soft model_term match ไม่ใช่ authoritative identity
    (unverified recall evidence ห้าม bypass policy เลย)"""
    req_code = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"smartwatch"}), subtypes=frozenset(),
        model_codes=("SUGAR20",), target_device=None,
        availability_mode="", compat_mode="")
    req_term = RetrievalRequest(
        request_id="r2", slot_id="s", source="slot",
        product_types=frozenset({"smartwatch"}), subtypes=frozenset(),
        model_codes=(), target_device=None, availability_mode="",
        compat_mode="", soft_hints=(("model_term", "SUGAR20"),))
    cc = make_evidence_card(YOBYBO, source="legacy", requested=())
    assert _bucket(cc, req_code) == ("eligible", "ok")
    assert _bucket(cc, req_term) == ("rejected", "wrong_type"), (
        "soft term must never bypass type policy")


def test_soft_term_cannot_bypass_wrong_type():
    """H1-A: earphone request + model_term=IP68/USB2 — card name match
    บน soft term ไม่ใช่ authority → wrong_type reject เสมอ"""
    req = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"earphone"}), subtypes=frozenset(),
        model_codes=(), target_device=None, availability_mode="",
        compat_mode="", soft_hints=(("model_term", "IP68"),))
    cc = make_evidence_card(_card("IP68 Smartwatch กันน้ำ", "9201"),
                            source="legacy", requested=())
    assert _bucket(cc, req) == ("rejected", "wrong_type"), (
        "IP68 term match bypassed wrong_type")
    req2 = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"earphone"}), subtypes=frozenset(),
        model_codes=(), target_device=None, availability_mode="",
        compat_mode="", soft_hints=(("model_term", "USB2"),))
    cc2 = make_evidence_card(_card("USB 2 Cable Hub", "9202"),
                             source="legacy", requested=())
    assert _bucket(cc2, req2) == ("rejected", "wrong_type"), (
        "USB2 term match bypassed wrong_type")


def test_soft_term_cannot_bypass_device_mismatch():
    """H1-B: request target=iphone 15 + term SUGAR20 — card ชื่อ match term
    แต่ device evidence ขัด target → device_mismatch เสมอ (term ไม่ใช่ own-model
    proof); own-model exemption เฉพาะ device family ตรง card type เดียวกัน"""
    req = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"case"}), subtypes=frozenset(),
        model_codes=(), target_device="iphone 15", availability_mode="",
        compat_mode="", soft_hints=(("model_term", "SUGAR20"),))
    cc = make_evidence_card(_card("Sugar 20 เคสสำหรับ Galaxy S21", "9203"),
                            source="legacy", requested=())
    b, why = _bucket(cc, req)
    assert b == "rejected" and why.startswith("device_mismatch"), (
        f"soft term bypassed device_mismatch: {b}:{why}")


def test_family_overlap_is_not_identity_or_compat():
    """H1 (r5): device token บน card ที่ share แค่ family กับ target —
    same-family ≠ same identity ≠ compat proof — iPhone 14 card ใน
    phone request ที่มี target iphone 15 → device_mismatch เสมอ"""
    req = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"phone"}), subtypes=frozenset(),
        model_codes=(), target_device="iphone 15", availability_mode="",
        compat_mode="")
    cc = make_evidence_card(_card("iPhone 14 Smartphone", "9205"),
                            source="legacy", requested=())
    b, why = _bucket(cc, req)
    assert b == "rejected" and why.startswith("device_mismatch"), (
        f"same-family card admitted as compat evidence: {b}:{why}")


def test_subject_refs_are_typed_identity_not_compat_claim():
    """subject_refs (typed subject ของ request — owner = TurnNeed.
    subject_refs) — card dev == subject ref = self-identity ไม่ใช่
    compat claim → eligibility เดิม; compat verdict แยก — fail-closed
    ที่ resolve_compat"""
    req = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"smartwatch"}), subtypes=frozenset(),
        model_codes=(), target_device="iphone 15", availability_mode="",
        compat_mode="", subject_refs=("MI WATCH 8",))
    cc = make_evidence_card(MIWATCH, source="legacy", requested=())
    assert _bucket(cc, req) == ("eligible", "ok"), (
        "named source product lost")


def test_watch_request_keeps_product_and_target_separate():
    """'นาฬิกา mi watch 8 เชื่อมกับ iphone 15' — watch = typed subject
    (validated device name = asked product, r8 roles), compat target =
    iphone 15 typed separately — retrievable ผ่าน type+subject channel;
    ไม่มี structured evidence → ไม่มี verdict"""
    plan, prof, out, ctx, calls = _chain(MSG_WATCH_PHONE, [MIWATCH])
    assert prof.target_device == "iphone 15"
    reqs = [r for r in out["requests"] if r.source == "slot"]
    assert reqs and all("mi watch 8" in r.subject_refs for r in reqs), (
        f"watch subject lost: {[r.subject_refs for r in reqs]}")
    assert all(r.target_refs == ("iphone 15",) for r in reqs), (
        f"watch target wrong: {[r.target_refs for r in reqs]}")
    assert any("smartwatch" in r.product_types for r in reqs)
    assert "i:9004" in _idents(out["selection"])
    assert ctx.compat_verdicts == (), "compat claim fabricated"


def _prof(msg):
    return rc.build_retrieval_profile(
        msg, history=None, intent_result=_INTENT_OTHER,
        shop="s", platform="shopee", anchor_cards=[])


def _reqs(prof, needs=()):
    from shopeechat import retrieval_planner as rpl
    slots = rc.build_retrieval_slots(prof, needs=needs)
    rels = rc.build_retrieval_relations(prof, slots)
    return slots, rels, rpl.build_grouped_retrieval_requests(prof, slots, rels)


def _needs(msg, intent_result=_INTENT_OTHER):
    """real TurnPlan boundary — typed subject owner เดียว (decide_turn);
    test ต้องไม่ synthesize subject_refs เอง"""
    return td.decide_turn(msg, history=None, ticket_state=None,
                          claim_state=None, intent_result=intent_result).needs


# ---------- r7: explicit subject ownership via TurnNeed.subject_refs ----------

def test_direct_named_product_is_typed_subject_not_target():
    """H1+H3 (r7): explicit subject มาจาก TurnNeed.subject_refs (decide_turn)
    เท่านั้น — 'อยากได้ s25'/'มี s25 ไหม' ต้องพก S25 เป็น typed subject
    ของ request เดียว ไม่ใช่ compat target; wording อื่นๆ ที่ semantic
    เดียวกันต้องให้ subject_refs เดียวกัน (equivalence)"""
    for msg in ("อยากได้ s25", "มี s25 ไหม", "ขอมือถือ s25",
                "โทรศัพท์ s25 มีไหม", "ขอสมาร์ทโฟน s25", "รุ่น s25 มีไหม"):
        prof = _prof(msg)
        assert prof.target_device is None, (
            f"{msg}: subject misclassified as compat target: "
            f"{prof.target_device}")
        slots, rels, reqs = _reqs(prof, _needs(msg))
        assert len(reqs) == 1, (
            f"{msg}: expected exactly 1 retrieval request for the named "
            f"subject, got {len(reqs)}")
        assert reqs[0].subject_refs == ("S25",), (
            f"{msg}: explicit subject identity lost: "
            f"subject_refs={reqs[0].subject_refs}")


def test_direct_named_product_reaches_selection():
    """H1 end-to-end: 'อยากได้ s25' — subject ต้องถึง selection (r5 คืน
    0 request → retrieve ไม่ได้เลย); subject identity ผ่าน subject_refs"""
    s25 = _card("Samsung Galaxy S25 5G", "9200")
    plan, prof, out, ctx, calls = _chain("อยากได้ s25", [s25])
    assert "i:9200" in _idents(out["selection"]), (
        f"named subject not selected: {_idents(out['selection'])}")
    assert len(out["requests"]) == 1, (
        f"expected 1 request for named subject: {len(out['requests'])}")
    # 1 request → units + legacy dual-source pattern เท่านั้น (ไม่มี request
    # ซ้ำที่ fetch ซ้ำ query เดียวกัน)
    assert len(calls) == 2, f"expected 2 source fetches, got {calls}"


def test_direct_phone_named_product_has_no_typed_subject():
    """'ขอ iPhone 14' — device name (ไม่ใช่ trusted code) → subject_refs
    ว่างตาม typed contract (fail-closed ไม่ guess); product need ยังคง
    retrievable ผ่าน type+soft-term channel เดิม (named-terms merge
    demotes regex-inferred type เป็น soft — pre-existing) — ไม่ใช่
    compat target"""
    prof = _prof("ขอ iPhone 14")
    assert prof.target_device is None
    slots, rels, reqs = _reqs(prof, _needs("ขอ iPhone 14"))
    assert len(reqs) == 1
    assert reqs[0].subject_refs == (), (
        f"device name promoted into typed subject: {reqs[0].subject_refs}")
    phone_carried = ("phone" in reqs[0].product_types or
                     ("product_type", "phone") in reqs[0].soft_hints)
    assert phone_carried, "phone product type lost entirely"


def test_direct_code_named_product_request():
    """'มี W01 ไหม' — trusted code identity → typed subject ของ request"""
    prof = _prof("มี W01 ไหม")
    assert prof.model_codes == ("W01",)
    assert prof.target_device is None
    slots, _, reqs = _reqs(prof, _needs("มี W01 ไหม"))
    assert len(reqs) == 1
    assert reqs[0].subject_refs == ("W01",)


def test_subject_device_question_role():
    """'a56 ใช้กับอะไรได้บ้าง' — a56 คือ typed subject ที่ถาม compat ของ
    ตัวเอง (question เปิด ไม่มี target) → subject_refs ไม่ใช่ target"""
    prof = _prof("a56 ใช้กับอะไรได้บ้าง")
    assert prof.target_device is None
    slots, _, reqs = _reqs(prof, _needs("a56 ใช้กับอะไรได้บ้าง"))
    assert len(reqs) == 1
    assert reqs[0].subject_refs == ("A56",)


# ---------- r7: source/target pairs — typed subjects, no prose inference ----------

def test_case_request_keeps_s25_as_typed_target():
    """'มีเคส s25 ไหม'/'s25 มีเคสไหม'/'ขอเคสสำหรับ s25' — product need =
    case; S25 = typed target constraint (target_refs → target_device)
    ไม่ใช่ subject (ไม่มี fake source subject); request เดียว"""
    for msg in ("มีเคส s25 ไหม", "s25 มีเคสไหม", "ขอเคสสำหรับ s25"):
        prof = _prof(msg)
        slots, _, reqs = _reqs(prof, _needs(msg))
        assert len(reqs) == 1, f"{msg}: reqs={len(reqs)}"
        req = reqs[0]
        assert "case" in req.product_types, f"{msg}: {req.product_types}"
        assert req.subject_refs == (), (
            f"{msg}: fake source subject: {req.subject_refs}")
        assert req.target_refs == ("s25",), (
            f"{msg}: S25 must stay the typed target of the case need: "
            f"{req.target_refs}")
        assert req.target_device == "s25", f"{msg}: {req.target_device}"


def test_subject_refs_own_model_exemption_with_target():
    """typed subject (subject_refs) = own-model identity เมื่อ card พก
    device token เดียวกัน — 'S25 เคสสำหรับ iPhone 15' card ใน request
    target=iphone 15 + refs=(S25,): dev=s25 ∈ refs → own_model → eligible
    (admission-only semantics — ไม่เพิ่ม rejection class ใหม่)"""
    req = RetrievalRequest(
        request_id="r", slot_id="s", source="slot",
        product_types=frozenset({"case"}), subtypes=frozenset(),
        model_codes=(), target_device="iphone 15", availability_mode="",
        compat_mode="", subject_refs=("S25",))
    subj = make_evidence_card(_card("S25 เคสสำหรับ iPhone 15", "9201"),
                              source="legacy", requested=())
    b, why = _bucket(subj, req)
    assert b == "eligible", f"typed subject card lost: {b}:{why}"
    # card พก device identity อื่นที่ไม่ตรง subject/target →
    # device_mismatch เดิมยังทำงาน (HEAD parity — ไม่มี rejection ใหม่
    # จาก subject refs; mismatch handling = need-attribution downstream)
    other = make_evidence_card(_card("เคสสำหรับ iPhone 14", "9202"),
                               source="legacy", requested=())
    b2, why2 = _bucket(other, req)
    assert b2 == "rejected" and why2.startswith("device_mismatch"), (
        f"target-mismatch card admitted: {b2}:{why2}")


def test_pre_connector_subject_stays_source_not_target():
    """'S25 ใช้กับ iPhone 15' — S25 = typed subject (subject_refs);
    iPhone 15 = compat target (connector domain) — แยกกันเด็ดขาด"""
    prof = _prof("S25 ใช้กับ iPhone 15 ได้ไหม")
    assert prof.target_device == "iphone 15"
    slots, _, reqs = _reqs(prof, _needs("S25 ใช้กับ iPhone 15 ได้ไหม"))
    assert len(reqs) == 1
    assert reqs[0].subject_refs == ("S25",), (
        f"source subject lost: {reqs[0].subject_refs}")
    assert reqs[0].subject_refs != (reqs[0].target_device,), (
        "source subject merged into target")


def test_same_family_no_subject_promotion_or_merge():
    """'iPhone 14 ใช้กับ iPhone 15' — device names ไม่ใช่ typed subjects
    (refs ว่าง) → same-family ไม่ merge ก็ไม่ promote; compat ต้อง
    fail-closed โดยไม่มี structured evidence"""
    prof = _prof("iPhone 14 ใช้กับ iPhone 15 ได้ไหม")
    assert prof.target_device == "iphone 15"
    slots, _, reqs = _reqs(prof, _needs("iPhone 14 ใช้กับ iPhone 15 ได้ไหม"))
    for r in reqs:
        assert "IPHONE 14" not in r.subject_refs
        assert "IPHONE 15" not in r.subject_refs, (
            "compat target promoted into subject")


def test_standalone_watch_is_typed_product_subject():
    """'นาฬิกา mi watch 8' — watch = asked product → typed subject
    (self_compat: validated device name คือสิ่งที่ถาม — r8 roles);
    retrievable ผ่าน smartwatch type + subject channel"""
    prof = _prof("นาฬิกา mi watch 8")
    slots, _, reqs = _reqs(prof, _needs("นาฬิกา mi watch 8"))
    assert len(reqs) == 1
    assert reqs[0].subject_refs == ("mi watch 8",)
    assert reqs[0].target_refs == ()
    assert "smartwatch" in reqs[0].product_types


def test_multi_slot_refs_do_not_flatten():
    """'เคส s25 กับฟิล์ม ip14' — need scope ว่าง (intent=None → ไม่มี
    typed per-slot association) → fail closed: refs ไม่ stamp ลง slot
    ไหนเลย แทนที่จะ flatten ข้าม slots"""
    prof = _prof("เคส s25 กับฟิล์ม ip14")
    slots, _, reqs = _reqs(prof, _needs("เคส s25 กับฟิล์ม ip14"))
    by_type = {}
    for s in slots:
        for t in s.product_types:
            by_type[t] = s
    assert by_type["case"].subject_refs == (), (
        f"refs stamped without association: "
        f"{by_type['case'].subject_refs}")
    assert by_type["screen_protector"].subject_refs == (), (
        f"subject flattened across slots: "
        f"{by_type['screen_protector'].subject_refs}")


def test_connector_grammar_is_single_owner():
    """H2: connector ที่อยู่ใน _REL_CONN_RE canonical grammar แต่ไม่เคยอยู่ใน
    local tuple ('ใช้ร่วมกับ') ต้อง drive target detection — พิสูจน์ว่า
    _local_target_device consume grammar เดียวกับ relation parser"""
    prof = rc.build_retrieval_profile(
        "หัวชาร์จใช้ร่วมกับ iphone 15 ได้ไหม", history=None,
        intent_result=_INTENT_OTHER, shop="s", platform="shopee",
        anchor_cards=[])
    assert prof.target_device == "iphone 15", (
        f"canonical connector 'ใช้ร่วมกับ' must resolve target: "
        f"{prof.target_device}")


def test_named_price_stock_link_reaches_canonical_context():
    """price/stock/link ของ named product — explicit subject ต้องไปถึง
    canonical AnswerContext (ไม่ใช่ unanswered no_selection)"""
    plan, prof, out, ctx, calls = _chain(MSG_PRICE, [YOBYBO])
    assert len(out["requests"]) > 0
    assert "i:9001" in _idents(out["selection"])
    assert any("Sugar 20" in (p.get("name") or "") for p in ctx.products)
    unanswered = {(u.kind, u.operation) for u in ctx.unanswered_needs}
    assert not unanswered, f"needs still unanswered: {unanswered}"


def test_sold_out_named_product_stays_unavailable_evidence():
    """named product ที่หมด → unavailable evidence เท่านั้น —
    ห้ามกลายเป็น available recommendation"""
    dead = _card("YOBYBO Sugar 20 หูฟังไร้สาย TWS", "9001",
                 stock=0, model=[])  # total_stock=0 → out_of_stock canonical
    plan, prof, out, ctx, calls = _chain(MSG_STOCK, [dead])
    assert len(out["requests"]) > 0
    sel = out["selection"]
    idents = _idents(sel)
    promoted = [s for s in sel.selected if s.identity == "i:9001"]
    unav = [u for u in sel.unavailable_evidence if u.get("item_id") == "9001"]
    assert promoted or unav, "sold-out identity lost entirely"
    for s in promoted:
        assert s.reason.startswith("unavailable_subject"), s.reason
        assert not s.card.get("sellable"), "sold-out became sellable"
    elig_ids = {c.identity for c in out["pool"].eligible}
    assert "i:9001" not in elig_ids or any(
        u.get("item_id") == "9001" for u in sel.unavailable_evidence), (
        "sold-out card promoted as available")


def test_device_pair_without_structured_evidence_stays_unanswered():
    """PART1-C3: compat target typed (iphone 15) แต่ไม่มี structured
    compat evidence → compat_verdicts ต้องว่าง (fail closed) — card
    name/soft term ไม่ใช่ proof"""
    ip14 = _card("Apple iPhone 14", "9100")
    ip15 = _card("Apple iPhone 15", "9101")
    plan, prof, out, ctx, calls = _chain(
        "iPhone 14 ใช้กับ iPhone 15 ได้ไหม", [ip14, ip15])
    assert prof.target_device == "iphone 15"
    assert ctx.compat_verdicts == (), (
        f"compat verdict fabricated without structured proof: "
        f"{[(v.subject_id, v.target, v.decision.outcome)
            for v in ctx.compat_verdicts]}")


def test_w01_strava_stays_fail_closed():
    """W01/Strava ไม่มี structured compat evidence → ห้าม fabricate verdict —
    compat_verdicts ว่างเสมอ; product subject ยังไหลถึง context"""
    w01 = _card("IMILAB W01 สมาร์ทวอช", "9002")
    plan, prof, out, ctx, calls = _chain(MSG_W01, [w01])
    assert ctx.compat_verdicts == (), (
        "compat verdict fabricated without structured proof")
    assert "i:9002" in _idents(out["selection"])


def test_flag_off_legacy_path_unchanged(monkeypatch):
    """USE_GROUPED_RETRIEVAL_SELECTION default/DB-absent → OFF —
    grouped callsite ไม่ทำงาน (legacy path เดิม)"""
    monkeypatch.delenv("USE_GROUPED_RETRIEVAL_SELECTION", raising=False)
    monkeypatch.setattr(rcfg, "get_runtime_config", lambda *a, **k: {})
    assert rcfg.grouped_retrieval_selection_enabled() is False


def test_named_product_tokens_do_not_break_real_codes():
    """regression: 'W01 รองรับ Strava' ยังพก W01 (ไม่ถูก device-claim ตัด)"""
    plan, prof, out, ctx, calls = _chain(MSG_W01, [IMILAB])
    assert "W01" in prof.model_codes
    prof2 = rc.build_retrieval_profile(
        "หัวชาร์จใช้กับ iphone 15 ได้ไหม", history=None,
        intent_result=_INTENT_OTHER, shop="s", platform="shopee",
        anchor_cards=[])
    assert prof2.target_device == "iphone 15"
    assert prof2.compat_mode == "connector_required"


# ---------- r7: contract pins ----------

def test_spec_tokens_carry_no_device_or_code_identity():
    """'หูฟัง IP68 กันน้ำไหม'/'สาย USB 2.0 มีไหม' — spec tokens ไม่ใช่
    device/product identity: target ว่างเสมอ, model_codes ว่าง,
    alias-fabricated 'iphone 68' ไม่ผ่าน authoritative index"""
    for msg in ("หูฟัง IP68 กันน้ำไหม", "สาย USB 2.0 มีไหม"):
        prof = _prof(msg)
        assert prof.target_device is None, f"{msg}: {prof.target_device}"
        assert not any(c.startswith(("IP68", "USB"))
                       for c in prof.model_codes), (
            f"{msg}: spec token in codes {prof.model_codes}")
        slots, _, _ = _reqs(prof, _needs(msg))
        for s in slots:
            assert s.target_device is None


def test_i14_pro_does_not_leak_i14_code():
    """'เคส i14 pro' — code token ภายใน device span ต้องไม่รั่วเป็น
    model_codes/subject_refs (containment filter owner เดิม)"""
    prof = _prof("เคส i14 pro มีไหม")
    assert "I14" not in prof.model_codes
    slots, _, reqs = _reqs(prof, _needs("เคส i14 pro มีไหม"))
    for r in reqs:
        assert "I14" not in r.subject_refs


def test_exact_product_codes_stay_explicit_subjects():
    """W01/AD1404T = exact product identities — typed subject refs
    ผ่าน chain เดิม (ไม่ใช่ soft terms) — r9: ใช้ non-connector phrasing
    (post-connector code = target domain)"""
    for msg, code in (("มี W01 ไหม", "W01"),
                      ("มี AD1404T ไหม", "AD1404T")):
        slots, _, reqs = _reqs(_prof(msg), _needs(msg))
        assert any(code in r.subject_refs for r in reqs), (
            f"{msg}: {code} lost as typed subject: "
            f"{[r.subject_refs for r in reqs]}")


def test_one_turnplan_one_subject_resolution_per_turn(monkeypatch):
    """call-count ownership: grouped path consume TurnPlan เดียวที่สร้าง
    แล้ว — ห้าม rerun decide_turn/subject extraction ใน retrieval"""
    calls = []
    orig = td.decide_turn
    monkeypatch.setattr(td, "decide_turn",
                        lambda *a, **k: (calls.append(1), orig(*a, **k))[1])
    _chain("อยากได้ s25", [_card("Samsung Galaxy S25 5G", "9200")])
    assert calls == [1], f"decide_turn called {len(calls)}x per turn"


def test_media_placeholder_keeps_typed_subjects():
    """image/image_text/video subject path: '[รูปภาพ] อยากได้ s25' —
    media placeholder ไม่ทำลาย typed subject ของ product need"""
    plan = td.decide_turn("[รูปภาพ] อยากได้ s25", history=None,
                          ticket_state=None, claim_state=None,
                          intent_result=_INTENT_OTHER)
    prod = [n for n in plan.needs if n.kind == "product"]
    assert prod and prod[0].subject_refs == ("S25",), (
        f"media turn lost typed subject: "
        f"{[n.subject_refs for n in plan.needs]}")


def test_production_fetch_owner_resolves_named_product():
    """PART 3 — production fetch owner proof: fetch_products จริงกับ fake
    collection leaf (query/recall/card-conversion production-real) —
    SUGAR20 ต้อง resolve ผ่าน recall path ของ fetch เอง ไม่ใช่ stub"""
    prof = rc.build_retrieval_profile(
        MSG_SPEC, history=None, intent_result=_INTENT_OTHER,
        shop="canary-shop", platform="shopee", anchor_cards=[])
    coll = _FakeColl([
        _doc("YOBYBO Sugar 20 หูฟังไร้สาย TWS Bluetooth 5.3", 9001),
        _doc("Baseus Bowie MA10 หูฟังบลูทูธ", 9002, brand="Baseus"),
    ])
    fake_db = _FakeDb({"ShpProducts": coll})
    cards = ps.fetch_products(
        fake_db, MSG_SPEC, shop_filter="canary-shop", limit=8,
        retrieval_profile=prof, snap=None)
    names = [c.get("name") or "" for c in cards]
    assert any("Sugar 20" in n for n in names), (
        f"production fetch did not resolve named product: {names}")
    # shop scoping ผ่าน production query จริง
    other = _FakeColl([_doc("YOBYBO Sugar 20 clone", 9003, shop="other-shop")])
    cards2 = ps.fetch_products(
        _FakeDb({"ShpProducts": other}), MSG_SPEC,
        shop_filter="canary-shop", limit=8,
        retrieval_profile=prof, snap=None)
    assert not any("9003" == str(c.get("item_id")) for c in cards2), (
        "cross-shop result leaked through production fetch")
