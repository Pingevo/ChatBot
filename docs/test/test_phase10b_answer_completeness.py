"""Phase 10B — answer-completeness data contract (need → explicit outcome).

contract ที่พิสูจน์ (W01 live incident aumporn_w01_1793090004):
- ทุก answerable need ต้องถึง explicit outcome หนึ่งอย่าง: grounded result /
  explicit cannot-confirm — ห้ามหายเงียบที่ composition/render boundary
- compat need กับ arbitrary external target (typed target_refs verbatim —
  app/service ที่ไม่ใช่ device เช่น "Example Sync"/"สตาวา") ต้องไหลเป็น
  unresolved UnansweredNeed เมื่อไม่มี evidence — ห้ามถูก cover ด้วย
  generic product candidates
- exact-subject follow-up: non-recommend need ไม่ admit alternative-role
  candidates (sibling drift) — alternatives เฉพาะ op == "recommend"
- missing evidence → "ไม่มีข้อมูลยืนยัน/ไม่สามารถยืนยัน" — ห้าม "ไม่รองรับ"
- ทุกอย่าง generic จาก typed fields — ไม่มี keyword/regex ของ incident
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from test_phase7_answer_context import (  # noqa: E402 — reuse typed builders
    _sel_card, _selection, _pool, _pooled, _profile, _compile,
)
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import retrieval_planner as rpl  # noqa: E402
from shopeechat import retrieval_selection as rsel  # noqa: E402
from shopeechat import route_context as rc  # noqa: E402
from shopeechat import turn_decision as td  # noqa: E402

TurnNeed = td.TurnNeed


def _req(rid, *, slot="slot-smartwatch", source="slot", types=(), subs=(),
         codes=(), subj=(), trefs=(), target=None, cm="none",
         rel_type=None):
    return rpl.RetrievalRequest(
        request_id=rid, slot_id=slot, source=source,
        product_types=frozenset(types), subtypes=frozenset(subs),
        model_codes=tuple(codes), target_device=target,
        availability_mode="sellable_first", compat_mode=cm,
        subject_refs=tuple(subj), target_refs=tuple(trefs),
        relation_type=rel_type)


def _render(comp):
    """canonical composition renderer ของ app (production owner เดียว)."""
    from shopeechat import app as _app
    return _app._render_composition(comp)


def _compose(needs, ctx, product_text=""):
    return acx.compose_answer(needs=needs, context=ctx,
                              product_text=product_text)


def _need_describe(subj=(), trefs=(), types=(), facts=(), scope="explicit"):
    return TurnNeed(kind="product", operation="describe",
                    subject_refs=tuple(subj), target_refs=tuple(trefs),
                    product_types=frozenset(types),
                    subject_scope=scope, requested_facts=tuple(facts))


def _need_compat(subj=(), trefs=()):
    return TurnNeed(kind="compat", operation="compat",
                    subject_refs=tuple(subj), target_refs=tuple(trefs))


_W1 = "i:18408364022"      # exact-subject identity (replay fidelity)
_W2 = "i:20069873881"      # sibling alternative identity


def _w01_sel(*, w02=True, extra=()):
    rows = [(_sel_card(_W1, "subject", "req-0", "Generic Watch A",
                      model_codes=["W01"]), "req-0")]
    if w02:
        rows.append((_sel_card(_W2, "alternative", "req-0",
                               "Generic Watch B", model_codes=["W02"]),
                     "req-0"))
    rows += list(extra)
    return _selection(*rows)


def _w01_pool():
    return _pool((
        _pooled(_W1, "18408364022", codes=("W01",), name="Generic Watch A"),
        _pooled(_W2, "20069873881", codes=("W02",), name="Generic Watch B"),
    ))


# ── A: unanswered no-evidence need must render explicitly ─────────────────────

def test_no_evidence_unanswered_renders_cannot_confirm():
    """Q2 shape: device-target compat need undecided → no_evidence —
    tracking มีอยู่แล้ว แต่ outcome ต้องไม่หายที่ render boundary."""
    needs = (
        _need_describe(subj=("W01",), trefs=("IMILAB W01",),
                       types=("smartwatch",), facts=("description",)),
        _need_compat(subj=("W01",), trefs=("IMILAB W01",)),
    )
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",), trefs=("IMILAB W01",),
                target="IMILAB W01", cm="bluetooth_general")
    # description channel (serves every need) ให้ need[0] รอดจาก req-0
    #   taint — shape เดียวกับ live (ch:description carry subject)
    chdesc = _req("ch:description", slot="description",
                  source="description")
    sel = _w01_sel(extra=[
        (_sel_card(_W1, "subject", "ch:description", "Generic Watch A",
                   model_codes=["W01"]), "ch:description")])
    ctx = _compile(needs, sel, _w01_pool(), (req0, chdesc), _profile())

    unans = [u for u in ctx.unanswered_needs if u.need_index == 1]
    assert unans and unans[0].reason == "no_evidence", (
        f"compat need ต้องเป็น no_evidence — got {ctx.unanswered_needs}")
    assert [p.get("item_id") for p in ctx.products] == ["18408364022"], (
        "exact subject เท่านั้นที่อยู่ใน products")

    comp = _compose(needs, ctx, product_text="spec ของ Generic Watch A")
    assert [u.need_index for u in comp.unanswered_needs] == [1]
    answer = _render(comp)
    assert "spec ของ Generic Watch A" in answer        # grounded part คงอยู่
    assert "ไม่สามารถยืนยัน" in answer, (
        "no_evidence outcome ต้อง render ชัด — ห้ามหายเงียบ")
    assert "ไม่รองรับ" not in answer, (
        "missing evidence ห้ามกลายเป็น negative claim")


# ── B: arbitrary external-app target must survive as unresolved need ──────────

def _app_target_case(target: str):
    """Q3 shape: describe(scope=explicit) + compat ต่อ arbitrary app label —
    typed seams เท่านั้น (ไม่มี keyword/regex ของ label)."""
    needs = (
        _need_describe(trefs=(target,), types=("smartwatch",),
                       facts=("compatibility",)),
        _need_compat(trefs=(target,)),
    )
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                trefs=(target,), target=None)
    ctx = _compile(needs, _w01_sel(), _w01_pool(), (req0,), _profile())
    return needs, ctx


def test_external_app_target_survives_as_unresolved_need():
    needs, ctx = _app_target_case("Example Sync")
    unans = [u for u in ctx.unanswered_needs if u.need_index == 1]
    assert unans, (
        f"compat need ห้ามถูก cover ด้วย product candidates — "
        f"unanswered={ctx.unanswered_needs}")
    u = unans[0]
    assert u.target == "Example Sync", (
        f"typed target ต้องไหลเข้า AnswerContext verbatim — got {u.target!r}")
    assert u.reason == "no_evidence"
    assert "20069873881" not in [p.get("item_id") for p in ctx.products], (
        "alternative/sibling ห้ามเข้า ctx products ใน describe+compat turn")

    comp = _compose(needs, ctx, product_text="spec ของ Generic Watch A")
    answer = _render(comp)
    assert "Example Sync" in answer, (
        "คำตอบต้อง name requested target จาก typed data — ไม่ generic-dump")
    assert "ไม่สามารถยืนยัน" in answer
    assert "ใช้งานร่วมกับ Example Sync ได้" not in answer
    assert "ใช้งานร่วมกับ Example Sync ไม่ได้" not in answer


def test_arbitrary_target_labels_generalize():
    """contract เดียวกันกับ label ที่ไม่อยู่ใน production table อีก 2 ตัว."""
    for target in ("Garmin Connect", "Example Sync Pro"):
        _needs, ctx = _app_target_case(target)
        unans = [u for u in ctx.unanswered_needs if u.need_index == 1]
        assert unans and unans[0].target == target, (
            f"target {target!r} ต้องไหลเป็น unresolved need verbatim")


# ── C: exact-subject follow-up — no sibling drift on non-recommend needs ──────

def test_describe_need_admits_exact_subject_only():
    needs = (_need_describe(subj=("W01",), types=("smartwatch",)),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",))
    ctx = _compile(needs, _w01_sel(), _w01_pool(), (req0,), _profile())
    ids = [p.get("item_id") for p in ctx.products]
    assert ids == ["18408364022"], (
        f"non-recommend need ห้าม admit alternative — got {ids}")
    assert not ctx.unanswered_needs


def test_recommend_need_still_admits_alternatives():
    """กัน over-correction: recommend = alternatives-asking op เดียว."""
    needs = (TurnNeed(kind="product", operation="recommend",
                      product_types=frozenset({"smartwatch"})),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",))
    ctx = _compile(needs, _w01_sel(), _w01_pool(), (req0,), _profile())
    ids = {p.get("item_id") for p in ctx.products}
    assert {"18408364022", "20069873881"} <= ids, (
        f"recommend turn ต้องเห็น alternatives — got {ids}")


def test_alternative_substitute_when_subject_absent():
    """alternative = substitute เจตนา: subject ที่ถามไม่มี card เลย →
    alternative เป็น answer ได้ (WPB100L→AC65B fail-closed boundary case);
    drift filter ตัดเฉพาะเมื่อ subject coverage อยู่แล้ว."""
    needs = (_need_describe(subj=("WPB100L",), types=("charger",)),)
    req0 = _req("req-0", types=("charger",), codes=("WPB100L",))
    # AC65B = alternative เดียว (WPB100L ไม่มี card — hidden/absent)
    sub = _selection(
        (_sel_card("i:4001", "alternative", "req-0",
                   "AC65B FX Charger 65W",
                   model_codes=["AC65B"]), "req-0"))
    pool = _pool((
        _pooled("i:4001", "4001", codes=("AC65B",),
                name="AC65B FX Charger 65W"),))
    ctx = _compile(needs, sub, pool, (req0,), _profile())
    ids = [p.get("item_id") for p in ctx.products]
    assert ids == ["4001"], (
        f"substitute alternative ต้องรอดเมื่อ subject ไม่มี — got {ids}")
    assert not ctx.unanswered_needs


# ── D: need completeness invariant ────────────────────────────────────────────

def test_every_productish_need_has_exactly_one_outcome():
    """answerable need ทุกตัว → DomainResult หรือ UnansweredNeed (no neither,
    no both — partial-coverage no_evidence+subject_refs ยกเว้นตาม contract
    เดิม); unresolved outcome ต้อง visible ใน render."""
    needs, ctx = _app_target_case("Example Sync")
    comp = _compose(needs, ctx, product_text="grounded")
    res_idx = {i for r in comp.results for i in r.need_indices}
    unans_idx = {u.need_index for u in comp.unanswered_needs}
    productish = {i for i, n in enumerate(needs)
                  if n.kind in acx.PRODUCTISH_NEED_KINDS}
    missing = productish - res_idx - unans_idx
    assert not missing, f"needs {missing} หายจากทั้งสอง set"
    assert 0 in res_idx and 1 in unans_idx
    answer = _render(comp)
    assert "Example Sync" in answer and "ไม่สามารถยืนยัน" in answer


# ── E2: partial unresolved compat — scoped render ห้าม blanket-claim ──────────

def test_partial_unresolved_renders_scoped_not_blanket():
    """compat need ที่มี decided verdict + unresolved subject (id/sid refs)
    — segment ต้อง scope กับส่วนที่ตรวจไม่ได้ ไม่ blanket ทั้ง target
    (pingevox Q3 live shape: 2 compatible + 1 undecided)."""
    from shopeechat import app as _app
    u = acx.UnansweredNeed(
        0, "compat", "compat", ("i:13015434958",), (),
        "xiaomi 17 ultra", "no_evidence")
    seg = acx._unanswered_segment(u)
    assert "ตรวจสอบไม่ได้" in seg and "xiaomi 17 ultra" in seg
    assert "i:13015434958" not in seg, "raw sid ห้ามไหลเข้า customer text"
    # named subject_ref → scope ชัดด้วยชื่อ
    u2 = acx.UnansweredNeed(
        0, "compat", "compat", ("W01",), (),
        "Example Sync", "no_evidence")
    seg2 = acx._unanswered_segment(u2)
    assert seg2.startswith("สำหรับW01 — การเชื่อมต่อ") \
        and "Example Sync" in seg2
    comp = acx.AnswerComposition(
        results=(), unanswered_needs=(u,), products=(),
        usage={}, answer_calls=0)
    answer = _app._render_composition(comp)
    assert "ตรวจสอบไม่ได้" in answer


# ── E: W01 three-turn incident replay (typed seams — offline) ─────────────────

def test_w01_q3_replay_no_drift_no_fabrication():
    """shape เดียวกับ live Q3: describe(explicit, tgt=สตาวา) + compat(สตาวา)."""
    needs = (
        _need_describe(trefs=("สตาวา",), types=("smartwatch",),
                       facts=("compatibility",)),
        _need_compat(trefs=("สตาวา",)),
    )
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                trefs=("สตาวา",))
    chhist = _req("ch:history", slot="history", source="history")
    chdesc = _req("ch:description", slot="description",
                  source="description")
    ctx = _compile(needs, _w01_sel(), _w01_pool(),
                   (req0, chhist, chdesc), _profile())

    unans = [u for u in ctx.unanswered_needs if u.need_index == 1]
    assert unans and unans[0].target == "สตาวา" \
        and unans[0].reason == "no_evidence"
    ids = [p.get("item_id") for p in ctx.products]
    assert "20069873881" not in ids, "W02 ห้าม drift เข้า follow-up ของ W01"

    comp = _compose(needs, ctx, product_text="spec ของ Generic Watch A")
    answer = _render(comp)
    assert "สตาวา" in answer
    assert "ไม่สามารถยืนยัน" in answer
    assert "ไม่รองรับ" not in answer          # missing ≠ negative
    # no fabricated integration claim
    assert "ใช้งานร่วมกับ สตาวา ได้" not in answer
    assert "รองรับ สตาวา" not in answer


# ── F: capability asks — typed multi-fact contract (W01 Q2 live incident) ────

_W01_Q2_MSG = (
    "ขอสอบถามค่ะ รุ่น IMILAB W01 เวลาใช้โหมดวิ่ง "
    "สามารถเชื่อมต่อ GPS จากมือถือเพื่อบันทึกระยะทางและเพซวิ่งได้ไหมคะ "
    "แล้วระหว่างวิ่งสามารถดูชีพจร เวลา ระยะทาง "
    "และเพซบนหน้าจอนาฬิกาได้หรือไม่คะ")

_W01_Q2_ASKS = (
    "เชื่อมต่อ GPS จากมือถือเพื่อบันทึกระยะทางและเพซ",
    "ดูชีพจร เวลา ระยะทาง และเพซบนหน้าจอขณะวิ่ง")

_W01_Q2_INTENT = {
    "intent": "product_spec", "product_type": "smartwatch",
    # live mis-slot: model ใส่ subject product เองเป็น target_device —
    #   typed owner ต้องไม่ยอมให้ product กลายเป็น counterpart ของตัวเอง
    "target_device": "IMILAB W01", "relation_target": None,
    "needs_description": True, "requested_facts": ["description"],
    "capability_asks": list(_W01_Q2_ASKS),
    "subject_scope": "explicit", "confidence": 0.98,
}


def test_w01_q2_capability_asks_survive_intent_to_need():
    """W01 Q2 incident boundary (aumporn_w01_1793093613): subject=W01,
    asks เป็น typed data, product ไม่เป็น compat target ของตัวเอง."""
    plan = td.decide_turn(_W01_Q2_MSG, intent_result=dict(_W01_Q2_INTENT))
    prod = [n for n in plan.needs if n.kind == "product"]
    assert prod, "ต้องมี product need จาก requested_facts"
    for n in plan.needs:
        assert "IMILAB W01" not in n.target_refs, (
            f"subject กลายเป็น counterpart ของตัวเอง — "
            f"{n.kind}/{n.operation} trefs={n.target_refs}")
    asks = {a for n in plan.needs
            for a in (getattr(n, "capability_asks", ()) or ())}
    assert asks == set(_W01_Q2_ASKS), (
        f"capability asks หายที่ intent→TurnNeed boundary — got {asks}")
    assert prod[0].subject_refs == ("W01",), (
        f"product subject ต้องเป็น W01 — got {prod[0].subject_refs}")


def test_capability_asks_unresolved_outcome_names_each_ask():
    """asks บน need ที่มี subject coverage: r16 — asks ride task ให้ model
    แยก subclaim (partial evidence) — task ต้อง name ทุก ask + instruction
    แยก confirmed/unconfirmed (ไม่ใช่ spec-dump ทดแทน)."""
    asks = ("เชื่อมต่อ GPS จากมือถือ", "ดูชีพจรและเพซบนหน้าจอขณะวิ่ง")
    needs = (TurnNeed(
        kind="product", operation="describe",
        subject_refs=("W01",), product_types=frozenset({"smartwatch"}),
        subject_scope="explicit", requested_facts=("description",),
        capability_asks=asks),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",))
    ctx = _compile(needs, _w01_sel(w02=False), _w01_pool(), (req0,),
                   _profile())
    task_asks = tuple(a for t in ctx.task.tasks
                      for a in t.capability_asks)
    assert set(task_asks) == set(asks), (
        f"asks ที่มี subject evidence ต้องไหลเข้า task — got {task_asks}")
    rendered = ctx.task.render()
    for a in asks:
        assert a in rendered, f"task ต้อง name ask {a!r} เป็นรายตัว"
    assert "ไม่มีข้อมูลยืนยัน" in rendered and "ไม่รองรับ" in rendered, (
        "task instruction ต้องบอกแยก subclaim + ห้าม negative claim")


def test_generic_subject_never_its_own_compat_target():
    """generic separation: arbitrary code/labels — subject ต้องไม่ไหลไปเป็น
    counterpart ของตัวเอง; asks survive verbatim (ไม่มี keyword gate)."""
    msg = ("รุ่น ZX200 เชื่อมต่อกับ Alpha Sync Mode ได้ไหม "
           "แล้วรองรับ Beta Trace ไหม")
    intent = {"intent": "product_spec", "product_type": "smartwatch",
              "target_device": "ZX200", "relation_target": None,
              "requested_facts": ["description"],
              "capability_asks": ["Alpha Sync Mode", "Beta Trace"],
              "subject_scope": "explicit", "confidence": 0.95}
    plan = td.decide_turn(msg, intent_result=intent)
    for n in plan.needs:
        assert "ZX200" not in n.target_refs, (
            f"subject ZX200 เป็น target ของตัวเอง — {n.target_refs}")
    asks = {a for n in plan.needs
            for a in (getattr(n, "capability_asks", ()) or ())}
    assert asks == {"Alpha Sync Mode", "Beta Trace"}
    prod = next(n for n in plan.needs if n.kind == "product")
    assert "ZX200" in prod.subject_refs


def test_capability_asks_named_when_whole_need_uncovered():
    """need ไม่มี coverage เลย (subject ไม่อยู่ในระบบ) — asks ยังถูก name
    ใน outcome เดิม ไม่หายไปพร้อม need."""
    needs = (TurnNeed(
        kind="product", operation="describe",
        subject_refs=("W01",), product_types=frozenset({"smartwatch"}),
        subject_scope="explicit", requested_facts=("description",),
        capability_asks=("เชื่อมต่อ GPS จากมือถือ",)),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",))
    empty_sel = _selection()
    ctx = _compile(needs, empty_sel, _w01_pool(), (req0,), _profile())
    unans = [u for u in ctx.unanswered_needs if u.need_index == 0]
    assert unans and unans[0].capability_asks == (
        "เชื่อมต่อ GPS จากมือถือ",), (
        f"asks ต้องไหลเข้า UnansweredNeed แม้ need ไร้ coverage — "
        f"got {ctx.unanswered_needs}")


# ── G: capability_asks source-grounding + typed ownership dedupe (r15) ────────

def _classify_stubbed(monkeypatch, message, payload):
    """ขับ classify_intent ด้วย model response ที่ stub — production
    normalization เท่านั้นที่ทำงาน (ไม่มี provider call)."""
    import json as _json
    from shopeechat import intent_classifier as ic
    from shopeechat import llm as _llm

    class _Resp:
        text = _json.dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(_llm, "get_model", lambda *a, **k: "stub-model")
    monkeypatch.setattr(_llm, "_generate", lambda *a, **k: _Resp())
    return ic.classify_intent(message)


def test_capability_ask_ungrounded_dropped_at_producer(monkeypatch):
    """M1: ask ที่ model แต่งขึ้นเอง (ไม่อยู่ใน message) → drop fail-closed
    ที่ producer — hallucinated label ห้ามไหลถึง customer text."""
    res = _classify_stubbed(
        monkeypatch, "รุ่น Watch Alpha ใช้งานได้นานไหม",
        {"intent": "product_spec", "product_type": "smartwatch",
         "requested_facts": ["description"], "subject_scope": "explicit",
         "confidence": 0.9,
         "capability_asks": ["รองรับดาวเทียมสองระบบ", "ใช้งานได้นาน"]})
    asks = res.get("capability_asks") or []
    assert not any("ดาวเทียม" in a for a in asks), (
        f"ask ที่ไม่มีใน message ห้ามรอด — got {asks}")
    assert any("ใช้งานได้นาน" in a for a in asks), (
        f"ask ที่มาจาก message จริงต้องรอด — got {asks}")


def test_capability_ask_display_text_from_customer_source(monkeypatch):
    """M1: structural normalization เท่านั้น (case/whitespace) — display
    text ต้องเป็น span ต้นฉบับของลูกค้า ไม่ใช่ casing ที่ model แต่ง."""
    res = _classify_stubbed(
        monkeypatch,
        "Does Band X9 auto pause when I stop running",
        {"intent": "product_spec", "product_type": "smartwatch",
         "requested_facts": ["description"], "subject_scope": "explicit",
         "confidence": 0.9,
         "capability_asks": ["  AUTO PAUSE When   I Stop Running "]})
    asks = res.get("capability_asks") or []
    assert asks == ["auto pause when I stop running"], (
        f"display text ต้องเป็น source span ของลูกค้า — got {asks}")


def test_intent_prompt_has_no_incident_example():
    """M2: prompt ห้ามมี incident-specific few-shot (pin เชิงโครงสร้าง)."""
    from shopeechat import intent_classifier as ic
    for tok in ("W01", "IMILAB", "18408364022", "เพซ"):
        assert tok not in ic._INTENT_PROMPT, (
            f"incident token {tok!r} หลงเหลือใน classifier prompt")


def _asks_of(plan):
    return sorted({a for n in plan.needs
                   for a in (getattr(n, "capability_asks", ()) or ())})


def test_relation_target_owns_overlapping_capability_ask():
    """B(r16): ask ที่ span มี typed compat target → compat need own
    ครั้งเดียว (span ต้นฉบับคงเดิม) — ไม่ใช่ drop ทิ้ง ไม่ใช่ซ้ำ product."""
    msg = "รุ่น Watch Alpha เชื่อมต่อ Example Sync ได้ไหม"
    intent = {"intent": "compatibility_check", "product_type": "smartwatch",
              "relation_target": "Example Sync",
              "capability_asks": ["เชื่อมต่อ Example Sync ได้ไหม"],
              "subject_scope": "explicit", "confidence": 0.9}
    plan = td.decide_turn(msg, intent_result=intent)
    compat = [n for n in plan.needs if n.kind == "compat"]
    prod = [n for n in plan.needs if n.kind == "product"]
    assert compat and "Example Sync" in compat[0].target_refs
    assert compat[0].capability_asks == ("เชื่อมต่อ Example Sync ได้ไหม",), (
        f"relation ask ต้องอยู่ compat need ครั้งเดียว — "
        f"got {compat[0].capability_asks}")
    assert not any(a == "เชื่อมต่อ Example Sync ได้ไหม"
                   for n in prod for a in n.capability_asks), (
        "relation ask ห้ามคงค้างบน product need (outcome ซ้ำ)")

    # outcome เดียวที่ name target — render ผ่าน canonical pipeline
    needs = plan.needs
    req0 = _req("req-0", types=("smartwatch",), trefs=("Example Sync",))
    ctx = _compile(needs, _w01_sel(), _w01_pool(), (req0,), _profile())
    answer = _render(_compose(needs, ctx,
                              product_text="spec ของ Generic Watch A"))
    assert answer.count("Example Sync") == 1, (
        f"ต้องมี outcome เดียวที่ name Example Sync — answer:\n{answer}")
    assert "ไม่สามารถยืนยัน" in answer


def test_independent_ask_survives_alongside_owned_ask():
    """B(r16): relation target own เฉพาะ ask ที่มี target ใน span — ask
    อิสระ (capability อื่น) ต้องคงอยู่ product need เป็น outcome ตัวเอง."""
    msg = "เชื่อมต่อ Example Sync ได้ไหม และแสดงค่าการวิ่งบนหน้าจอได้ไหม"
    intent = {"intent": "compatibility_check", "product_type": "smartwatch",
              "relation_target": "Example Sync",
              "capability_asks": ["เชื่อมต่อ Example Sync ได้ไหม",
                                  "แสดงค่าการวิ่งบนหน้าจอได้ไหม"],
              "subject_scope": "explicit", "confidence": 0.9}
    plan = td.decide_turn(msg, intent_result=intent)
    prod = [n for n in plan.needs if n.kind == "product"]
    compat = [n for n in plan.needs if n.kind == "compat"]
    assert prod and prod[0].capability_asks == (
        "แสดงค่าการวิ่งบนหน้าจอได้ไหม",), (
            f"ask อิสระต้องอยู่ product need — "
            f"got {[n.capability_asks for n in prod]}")
    assert compat and compat[0].capability_asks == (
        "เชื่อมต่อ Example Sync ได้ไหม",), (
            f"relation ask ต้องอยู่ compat need — "
            f"got {[n.capability_asks for n in compat]}")


def test_w01_q3_relation_target_single_outcome():
    """B(r16): Q3 live shape — ask มี target สตาวา → compat own →
    outcome เดียว name ครั้งเดียว (ไม่ใช่ ask tail + compat tail ซ้อน)."""
    msg = "แล้วเชื่อมเข้ากับแอปสตาวาไหม"
    intent = {"intent": "product_spec", "product_type": "smartwatch",
              "relation_target": "สตาวา", "requested_facts": ["description"],
              "capability_asks": ["เชื่อมเข้ากับแอปสตาวา"],
              "subject_scope": "explicit", "confidence": 0.98}
    plan = td.decide_turn(msg, intent_result=intent)
    compat = [n for n in plan.needs if n.kind == "compat"]
    assert compat and compat[0].capability_asks == (
        "เชื่อมเข้ากับแอปสตาวา",), (
            f"strava ask ต้องอยู่ compat need — "
            f"got {[n.capability_asks for n in compat]}")
    needs = plan.needs
    req0 = _req("req-0", types=("smartwatch",), trefs=("สตาวา",))
    ctx = _compile(needs, _w01_sel(), _w01_pool(), (req0,), _profile())
    answer = _render(_compose(needs, ctx,
                              product_text="spec ของ Generic Watch A"))
    assert answer.count("สตาวา") == 1, (
        f"outcome เดียวที่ name สตาวา — answer:\n{answer}")
    assert "ไม่สามารถยืนยัน" in answer


def test_open_asks_never_enter_canonical_feature_eval(monkeypatch):
    """M4: open labels ไม่ใช่ canonical required_features — compile ห้าม
    ส่ง ask เข้า eval_spec_constraints ช่อง features เด็ดขาด."""
    from shopeechat import policy_resolver as _pr
    calls = []
    orig = _pr.eval_spec_constraints

    def _spy(facts, constraints, features, *a, **k):
        calls.append(tuple(features or ()))
        return orig(facts, constraints, features, *a, **k)

    monkeypatch.setattr(_pr, "eval_spec_constraints", _spy)
    asks = ("magnetic",)   # label ที่ชนกับ canonical key โดยบังเอิญ
    needs = (TurnNeed(kind="product", operation="describe",
                      subject_refs=("W01",),
                      product_types=frozenset({"smartwatch"}),
                      subject_scope="explicit",
                      requested_facts=("description",),
                      capability_asks=asks),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",))
    ctx = _compile(needs, _w01_sel(w02=False), _w01_pool(), (req0,),
                   _profile())
    for feats in calls:
        assert not set(feats) & set(asks), (
            f"open ask ห้ามไหลเข้า canonical feature channel — {feats}")
    task_asks = tuple(a for t in ctx.task.tasks
                      for a in t.capability_asks)
    assert task_asks == asks, (
        f"asks ที่มี subject evidence ต้องอยู่บน task — got {task_asks}")


# ── H: r16 — partial evidence / typed relation ownership / adequacy ranking /
#       exact-item isolation ────────────────────────────────────────────────

def _watt_cand(iid, name, watt, score=1.0, variants=(), rid="req-0",
               ptype="charger"):
    card = {"name": name, "item_id": iid, "model_codes": [],
            "customer_visibility": "visible"}
    if watt is not None:
        card["output_power_w"] = watt
    if variants:
        card["variants"] = [{"output_power_w": w} for w in variants]
        card.pop("output_power_w", None)
    from shopeechat import candidate_pool as cpool
    return cpool.PooledCandidate(
        identity=f"i:{iid}", item_id=iid, model_id=None, unit_id=None,
        sources=("legacy",), request_ids=(rid,), slot_id="s",
        relation_id=None, product_type=ptype, subtype=None,
        bucket="eligible", reason="ok", score=score, trace=(), card=card)


def test_capability_asks_reach_task_with_subject_evidence():
    """A: asks + subject-role evidence → asks ride NeedTask (model แยก
    confirmed/unconfirmed per subclaim) — ไม่ใช่ blanket cannot-confirm."""
    asks = ("ดูชีพจร เวลา ระยะทาง และเพซบนหน้าจอนาฬิกา",)
    needs = (TurnNeed(
        kind="product", operation="describe",
        subject_refs=("W01",), product_types=frozenset({"smartwatch"}),
        subject_scope="explicit", requested_facts=("description",),
        capability_asks=asks),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",))
    ctx = _compile(needs, _w01_sel(w02=False), _w01_pool(), (req0,),
                   _profile())
    t0 = ctx.task.tasks[0]
    assert t0.capability_asks == asks, (
        f"asks ต้องไหลเข้า task เมื่อมี exact-subject evidence — "
        f"got {t0.capability_asks}")
    unans = [u for u in ctx.unanswered_needs
             if u.need_index == 0 and u.capability_asks]
    assert not unans, (
        f"asks ที่มี subject evidence ห้ามเป็น blanket cannot-confirm — "
        f"got {unans}")
    rendered_task = ctx.task.render()
    assert "ดูชีพจร" in rendered_task, "task ต้อง name ask ให้ model ตอบ"
    assert "ไม่มีข้อมูลยืนยัน" in rendered_task, (
        "instruction ต้องสั่งแยก subclaim ที่ไม่มีหลักฐาน")
    assert "ไม่รองรับ" in rendered_task, (
        "instruction ต้องห้ามเปลี่ยน missing evidence → negative claim")


def test_capability_asks_without_subject_evidence_stay_deterministic():
    """A กลับด้าน: asks + ไม่มี subject-role cand → UnansweredNeed
    no_evidence เดิม (deterministic cannot-confirm เท่านั้น)."""
    asks = ("เชื่อมต่อ Example Sync ได้ไหม",)
    needs = (TurnNeed(
        kind="product", operation="describe",
        subject_refs=("W01",), product_types=frozenset({"smartwatch"}),
        subject_scope="explicit", requested_facts=("description",),
        capability_asks=asks),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",))
    # subject หลุดทั้งหมด (W02 alternative เท่านั้น) — ไม่มี exact-subject
    #   attributed evidence → deterministic tail
    sel = _selection((
        _sel_card(_W2, "alternative", "req-0", "Generic Watch B",
                  model_codes=["W02"]), "req-0"))
    ctx = _compile(needs, sel, _w01_pool(), (req0,), _profile())
    unans = [u for u in ctx.unanswered_needs if u.need_index == 0]
    assert unans and unans[0].reason == "no_evidence" \
        and unans[0].capability_asks == asks, (
            f"asks ที่ไม่มี subject evidence ต้องเป็น deterministic "
            f"cannot-confirm — got {ctx.unanswered_needs}")


def test_ask_with_compat_target_moves_to_compat_need_once():
    """B: ask ที่ span มี typed compat target → compat need own ครั้งเดียว
    (span ต้นฉบับคงเดิม); ask อิสระอยู่ product need — ไม่มี heuristic."""
    msg = ("ขอสอบถามค่ะ รุ่น Watch Alpha เวลาใช้โหมดวิ่ง สามารถเชื่อมต่อ "
           "Example Sat จากมือถือเพื่อบันทึกระยะทางได้ไหมคะ "
           "แล้วดูชีพจรบนหน้าจอได้ไหมคะ")
    intent = {"intent": "product_spec", "product_type": "smartwatch",
              "relation_target": "Example Sat",
              "requested_facts": ["description"],
              "capability_asks": [
                  "เชื่อมต่อ Example Sat จากมือถือเพื่อบันทึกระยะทาง",
                  "ดูชีพจรบนหน้าจอ"],
              "subject_scope": "explicit", "confidence": 0.95}
    plan = td.decide_turn(msg, intent_result=intent)
    compat = [n for n in plan.needs if n.kind == "compat"]
    prod = [n for n in plan.needs if n.kind == "product"]
    assert compat and prod
    c_asks = tuple(a for n in compat for a in n.capability_asks)
    p_asks = tuple(a for n in prod for a in n.capability_asks)
    assert c_asks == ("เชื่อมต่อ Example Sat จากมือถือเพื่อบันทึกระยะทาง",), (
        f"relation ask ต้องอยู่ compat need ครั้งเดียว — got {c_asks}")
    assert p_asks == ("ดูชีพจรบนหน้าจอ",), (
        f"ask อิสระต้องอยู่ product need — got {p_asks}")


def test_w01_q2_shape_produces_two_scoped_outcomes():
    """B: Q2 shape — GPS ask → compat tail เดียว; display ask → task —
    outcome เดียวต่อ ask (ไม่ซ้ำ, target named once)."""
    msg = _W01_Q2_MSG
    intent = {"intent": "product_spec", "product_type": "smartwatch",
              "relation_target": "GPS",
              "requested_facts": ["description"],
              "capability_asks": list(_W01_Q2_ASKS),
              "subject_scope": "explicit", "confidence": 0.98}
    plan = td.decide_turn(msg, intent_result=intent)
    compat = [n for n in plan.needs if n.kind == "compat"]
    assert compat and "GPS" in compat[0].target_refs
    # GPS ask อยู่ compat; display ask อยู่ product — ไม่ซ้ำกัน
    c_asks = tuple(a for n in compat for a in n.capability_asks)
    assert c_asks == (_W01_Q2_ASKS[0],), f"got {c_asks}"
    needs = plan.needs
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",), trefs=("GPS",))
    ctx = _compile(needs, _w01_sel(w02=False), _w01_pool(), (req0,),
                   _profile())
    # display ask → task (subject evidence มี)
    t_asks = [a for t in ctx.task.tasks for a in t.capability_asks]
    assert _W01_Q2_ASKS[1] in t_asks, f"display ask ต้องอยู่ใน task — {t_asks}"
    # compat unresolved → deterministic tail name GPS ask span ครั้งเดียว
    unans = [u for u in ctx.unanswered_needs if u.capability_asks]
    assert len(unans) == 1 and unans[0].capability_asks == (
        _W01_Q2_ASKS[0],), f"compat tail ต้อง name GPS ask ตัวเดียว — {unans}"
    answer = _render(_compose(needs, ctx, product_text="spec"))
    assert answer.count("GPS") == 1, (
        f"GPS outcome เดียว — answer:\n{answer}")


def test_rel_owned_helper_removed():
    """B (source): char-threshold helper ต้องถูกลบ — typed ownership
    เท่านั้น (ไม่มี residue-length logic เหลือ)."""
    import inspect
    src = inspect.getsource(td.decide_turn)
    assert "_rel_owned" not in src, "_rel_owned ต้องถูกลบทั้งก้อน"
    assert "<= 12" not in src and "<= 10" not in src, (
        "char thresholds 12/10 ต้องหายไป")


def test_adequacy_ranking_before_truncation_from_typed_spec(monkeypatch):
    """C: 65W score สูงกว่า แต่ adequate candidates (≥spec) ต้องเข้า picks
    ก่อน — ranking ก่อน truncate; min_watt มาจาก typed spec ไม่ใช่ literal."""
    from shopeechat import device_compat as dc
    calls = []

    def _spy(name):
        calls.append(name)
        return {"device": "dev-x", "min_watt": 90.0,
                "connector": "usb-c", "wired_w": 90.0} \
            if name == "dev-x" else None
    monkeypatch.setattr(dc, "_lookup_spec_db", _spy)
    pool = _pool((
        _watt_cand("p65", "SlowCell AD 65W charger", 65, score=9.0),
        _watt_cand("p120", "BoostCell AD 120W charger", 120, score=1.0),
        _watt_cand("p90", "BaseCell AD 90W charger", 90, score=1.0),
    ))
    req = _req("req-0", types=("charger",), subs=("adapter",),
               target="dev-x")
    sel = rsel.select_for_llm_context(
        pool, (req,), _profile(), needs=(), per_request_limit=2)
    picked = [s.identity for s in sel.by_request[0][1]]
    assert "dev-x" in calls, "spec lookup ต้องถูกเรียก (typed spec)"
    assert picked == ["i:p90", "i:p120"], (
        f"adequate-first เรียงก่อน truncate: 90W ก่อน 120W — got {picked}")


def test_below_target_pick_gets_slower_label(monkeypatch):
    """C: below-target อาจอยู่เป็นตัวเลือก — แต่ต้องติด label ช้ากว่าปกติ
    ห้ามเสนอเป็น primary full-speed."""
    from shopeechat import device_compat as dc
    monkeypatch.setattr(dc, "_lookup_spec_db",
                        lambda name: {"min_watt": 90.0}
                        if name == "dev-x" else None)
    pool = _pool((
        _watt_cand("p65", "SlowCell AD 65W charger", 65, score=9.0),
        _watt_cand("p100", "BoostCell AD 100W charger", 100, score=1.0),
    ))
    req = _req("req-0", types=("charger",), subs=("adapter",),
               target="dev-x")
    sel = rsel.select_for_llm_context(
        pool, (req,), _profile(), needs=(), per_request_limit=3)
    by_id = {s.identity: s for s in sel.selected}
    assert list(by_id) and by_id["i:p65"].card.get("_context_note"), (
        "below-target ต้องติด slower-charging label")
    assert "ช้า" in by_id["i:p65"].card["_context_note"]
    assert not by_id["i:p100"].card.get("_context_note"), (
        "adequate primary ห้ามติด slower label")


def test_mixed_listing_not_full_speed_primary(monkeypatch):
    """C: listing ที่ variants มีหลาย watt + ไม่มี selected variant →
    ห้ามโฆษณาเป็น full-speed primary — ต้องติด variant-power note."""
    from shopeechat import device_compat as dc
    monkeypatch.setattr(dc, "_lookup_spec_db",
                        lambda name: {"min_watt": 90.0}
                        if name == "dev-x" else None)
    pool = _pool((
        _watt_cand("pMix", "SetCell 65W / 100W / 140W set", None,
                   variants=(65, 100, 140), score=5.0),
        _watt_cand("p90", "BaseCell AD 90W charger", 90, score=1.0),
    ))
    req = _req("req-0", types=("charger",), subs=("adapter",),
               target="dev-x")
    sel = rsel.select_for_llm_context(
        pool, (req,), _profile(), needs=(), per_request_limit=3)
    by_id = {s.identity: s for s in sel.selected}
    note = by_id["i:pMix"].card.get("_context_note") or ""
    assert "ตัวเลือก" in note or "variant" in note.lower(), (
        f"mixed listing ไม่มี selected variant → ต้องติด ambiguity "
        f"note ไม่ใช่ full-speed claim — note={note!r}")


def test_need_ranking_applies_before_truncation():
    """C: need.ranking ต้อง sort บน ranked ก่อน truncate — ตัวที่ rank ชนะ
    ต้องเข้า picks แม้ score ต่ำกว่า."""
    need = TurnNeed(kind="product", operation="recommend",
                    product_types=frozenset({"charger"}),
                    ranking=("output_power_w", "max"))
    pool = _pool((
        _watt_cand("pSlow", "SlowCell AD 65W charger", 65, score=9.0),
        _watt_cand("pFast", "BoostCell AD 140W charger", 140, score=1.0),
    ))
    req = _req("req-0", types=("charger",))
    sel = rsel.select_for_llm_context(
        pool, (req,), _profile(), needs=(need,), per_request_limit=1)
    picked = [s.identity for s in sel.by_request[0][1]]
    assert picked == ["i:pFast"], (
        f"ranking=max watt ต้องเลือกตัว watt สูงสุดก่อน truncate — "
        f"got {picked}")


def test_ungrounded_explicit_fact_need_normalizes_scope():
    """D: explicit scope + ไม่มี refs + fact need → current_single —
    resolver consume persisted single ผ่าน machinery เดิม."""
    plan = td.decide_turn(
        "Speed data เท่าไหร่?ครับ",
        intent_result={"intent": "product_spec",
                       "requested_facts": ["data_transfer_speed"],
                       "subject_scope": "explicit", "confidence": 0.9})
    prod = [n for n in plan.needs if n.kind == "product"]
    assert prod, "ต้องมี product need"
    assert prod[0].subject_scope == "current_single", (
        f"explicit ไร้ refs + fact-question → current_single — "
        f"got {prod[0].subject_scope}")


def test_explicit_scope_preserved_when_refs_exist():
    """D กัน over-repair: explicit ที่มี identity จริง (tag/code) →
    ไม่เปลี่ยน."""
    plan = td.decide_turn(
        "[สินค้า: 12345] ราคาเท่าไหร่",
        intent_result={"intent": "product_spec",
                       "requested_facts": ["price"],
                       "subject_scope": "explicit", "confidence": 0.9})
    prod = [n for n in plan.needs if n.kind == "product"]
    assert prod and prod[0].subject_scope == "explicit", (
        f"explicit ที่มี refs ต้องคงเดิม — got {prod[0].subject_scope}")


def test_explicit_scope_on_recommend_need_not_narrowed():
    """D กัน over-repair: recommend need (ไม่มี facts) + explicit ไร้ refs
    → scope คงเดิม (ไม่ narrow ไป current_single)."""
    plan = td.decide_turn(
        "อยากได้ของที่ใช้กับ dev-x",
        intent_result={"intent": "product_recommend",
                       "product_type": "charger",
                       "subject_scope": "explicit", "confidence": 0.9})
    prod = [n for n in plan.needs
            if n.kind == "product" and n.operation == "recommend"]
    assert prod and prod[0].subject_scope == "explicit", (
        f"recommend ห้ามถูก narrow — got {prod[0].subject_scope}")


def test_exact_item_resolution_stamps_subject_refs():
    """D chain: current_single + persisted single → resolved →
    apply_resolved_subject_refs stamp → slot request แบก refs."""
    from shopeechat import conversation_products as cp
    persisted = cp.ConversationSubjectSet(
        subject_ids=("27639651334",), source_turn_id="t1",
        relation="single", requested_operations=(), confidence=1.0)
    res = cp.resolve_subjects(persisted, "speed data เท่าไหร่",
                              subject_scope="current_single",
                              subject_count=None, signal_confidence=0.9)
    assert res.outcome == "resolved"
    needs = (TurnNeed(kind="product", operation="describe",
                      subject_scope="current_single",
                      requested_facts=("data_transfer_speed",)),)
    stamped = td.apply_resolved_subject_refs(needs, ("27639651334",),
                                             plan_scope="current_single")
    assert stamped[0].subject_refs == ("27639651334",)
    slots = rc.build_retrieval_slots(
        _profile("Speed data เท่าไหร่", anchor_cards=()),
        needs=stamped)
    assert any("27639651334" in (s.subject_refs or ()) for s in slots), (
        f"slot ต้องแบก typed subject_refs — {slots}")


def test_exact_item_ctx_keeps_anchor_only():
    """D: anchored local-fact — AnswerContext/cards/task ใช้ anchor
    เดียว; sibling/history/description ของรุ่นอื่นห้ามรั่ว."""
    needs = (TurnNeed(kind="product", operation="describe",
                      subject_refs=("27639651334",),
                      product_types=frozenset({"charger"}),
                      subject_scope="current_single",
                      requested_facts=("data_transfer_speed",)),)
    req0 = _req("req-0", types=("charger",), subj=("27639651334",))
    chsub = _req("ch:subjects", slot="subjects", source="subjects")
    chdesc = _req("ch:description", slot="description",
                  source="description",
                  subj=("27639651334",))
    anchor = _sel_card("i:27639651334", "subject", "ch:subjects",
                       "CUKTECH CMC615P 240W", codes=["CMC615P"],
                       data_transfer_mbps=480)
    sib1 = _sel_card("i:51810334388", "slot", "ch:description",
                     "CUKTECH C2C615 480Mbps CarPlay",
                     codes=["C2C615"])
    sib2 = _sel_card("i:41933733847", "slot", "ch:description",
                     "CUKTECH CTC615U", codes=["CTC615U"])
    sel = _selection((anchor, "ch:subjects"), (sib1, "ch:description"),
                     (sib2, "ch:description"))
    pool = _pool((
        _pooled("i:27639651334", "27639651334", codes=("CMC615P",),
                name="CUKTECH CMC615P 240W"),
        _pooled("i:51810334388", "51810334388", codes=("C2C615",),
                name="CUKTECH C2C615 480Mbps CarPlay"),
        _pooled("i:41933733847", "41933733847", codes=("CTC615U",),
                name="CUKTECH CTC615U"),
    ))
    ctx = _compile(needs, sel, pool, (req0, chsub, chdesc), _profile())
    ids = [p.get("item_id") for p in ctx.products]
    assert ids == ["27639651334"], (
        f"anchored local-fact ต้องเหลือ anchor เดียว — got {ids}")
    txt = ctx.context_text()
    for leaked in ("C2C615", "CTC615U", "ATC310N", "CarPlay"):
        assert leaked not in txt, (
            f"{leaked} หลุดเข้า exact-item context — {txt!r}")


def test_current_single_clarify_when_no_or_multi_subjects():
    """D edge: current_single + persisted ว่าง → clarify; n>1 → clarify."""
    from shopeechat import conversation_products as cp
    res0 = cp.resolve_subjects(None, "speed data เท่าไหร่",
                               subject_scope="current_single",
                               subject_count=None, signal_confidence=0.9)
    assert res0.outcome == "clarify"
    multi = cp.ConversationSubjectSet(
        subject_ids=("1", "2"), source_turn_id="t1",
        relation="alternatives", requested_operations=(), confidence=1.0)
    res2 = cp.resolve_subjects(multi, "speed data เท่าไหร่",
                               subject_scope="current_single",
                               subject_count=None, signal_confidence=0.9)
    assert res2.outcome == "clarify"


# ── J: pre-commit review LOW-1..4 — executable offline proof ────────────────
#   hypotheses จาก review (test-only round — ยังไม่แก้ production):
#   LOW-1: capability_asks หายจาก customer-visible deterministic unanswered
#          output (no_selection render / no_answer synth / context=None)
#   LOW-2: explicit scope ไร้ refs ไม่ repair→current_single เมื่อ need แบก
#          เฉพาะ spec_constraints / required_features / capability_asks
#   LOW-3: charger ไม่มี wattage evidence + target มี structured min_watt
#          → ไม่มี caveat ที่ไหนเลย (unknown ≠ proven-below-target)
#   LOW-4: intrinsic-capability ask ที่ span มี typed compat target ถูก move
#          ไป compat need — decided verdict อาจทำ ask หายเงียบ


# ── LOW-1: asks ต้องถึง customer-visible unanswered outcome เสมอ ────────────

def test_no_selection_answer_names_capability_asks():
    """LOW-1a: no_selection — asks ไหลเข้า UnansweredNeed แล้ว แต่ rendered
    outcome ต้อง name ask เหมือน no_evidence (contract ที่
    _unanswered_segment ประกาศเอง: unresolved ask ทุกตัวถูก name ใน
    outcome ของตัวเอง — early-return ก่อน asks block = suspected defect)."""
    asks = ("เชื่อมต่อ Example Dock ได้ไหม",)
    needs = (TurnNeed(
        kind="product", operation="describe",
        subject_refs=("W01",), product_types=frozenset({"smartwatch"}),
        subject_scope="explicit", requested_facts=("description",),
        capability_asks=asks),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",))
    ctx = _compile(needs, _selection(), _w01_pool(), (req0,), _profile())
    unans = [u for u in ctx.unanswered_needs if u.need_index == 0]
    assert unans and unans[0].reason == "no_selection" \
        and unans[0].capability_asks == asks, (
            f"premise: asks ต้องถึง UnansweredNeed(no_selection) — "
            f"got {ctx.unanswered_needs}")
    answer = _render(_compose(needs, ctx))
    assert asks[0] in answer, (
        f"no_selection outcome ต้อง name ask ที่ลูกค้าถาม — "
        f"answer:\n{answer}")


def test_no_answer_unanswered_keeps_capability_asks():
    """LOW-1b: NeedTask แบก asks (subject evidence มี) + product_text=""
    → synth UnansweredNeed(no_answer) ต้อง carry asks — outcome ต้อง
    name ask ไม่ใช่ generic cannot-confirm โดยไม่บอกว่าถามเรื่องอะไร."""
    asks = ("ดูชีพจรบนหน้าจอขณะวิ่ง",)
    needs = (TurnNeed(
        kind="product", operation="describe",
        subject_refs=("W01",), product_types=frozenset({"smartwatch"}),
        subject_scope="explicit", requested_facts=("description",),
        capability_asks=asks),)
    req0 = _req("req-0", types=("smartwatch",), codes=("W01",),
                subj=("W01",))
    ctx = _compile(needs, _w01_sel(w02=False), _w01_pool(), (req0,),
                   _profile())
    assert ctx.task.tasks[0].capability_asks == asks, (
        f"premise: asks ต้องอยู่บน task — {ctx.task.tasks}")
    comp = _compose(needs, ctx, product_text="")
    unans = [u for u in comp.unanswered_needs if u.need_index == 0]
    assert unans and unans[0].reason == "no_answer", (
        f"premise: task need + answer ว่าง → no_answer — "
        f"{comp.unanswered_needs}")
    assert unans[0].capability_asks == asks, (
        f"no_answer synth ต้อง carry asks จาก NeedTask — {unans}")
    answer = _render(comp)
    assert asks[0] in answer, (
        f"no_answer outcome ต้อง name ask — answer:\n{answer}")


def test_context_absent_answer_names_capability_asks():
    """LOW-1c: compose_answer(context=None) (reachable ผ่าน app._done()
    — sel is None / artifacts ล้ม / task compile ล้ม) — need แบก asks
    ต้องไม่หาย ask ที่ outcome."""
    asks = ("เชื่อมต่อ Example Dock ได้ไหม",)
    needs = (TurnNeed(
        kind="product", operation="describe",
        subject_refs=("W01",), product_types=frozenset({"smartwatch"}),
        subject_scope="explicit", requested_facts=("description",),
        capability_asks=asks),)
    comp = acx.compose_answer(needs=needs, context=None, product_text="")
    unans = [u for u in comp.unanswered_needs if u.need_index == 0]
    assert unans and unans[0].reason == "no_selection", (
        f"premise: context-absent → no_selection — {comp.unanswered_needs}")
    assert unans[0].capability_asks == asks, (
        f"context-absent synth ต้อง carry asks — {unans}")
    answer = _render(comp)
    assert asks[0] in answer, (
        f"context-absent outcome ต้อง name ask — answer:\n{answer}")


# ── LOW-2: ungrounded explicit scope repair ต้องครอบทุก typed carrier ───────

@pytest.mark.xfail(strict=False, reason="LOW-2 — awaiting separate approval")
def test_spec_only_explicit_scope_normalizes_current_single():
    """LOW-2a: explicit ไร้ refs + need แบก spec_constraints เพียงอย่างเดียว
    → repair เดียวกับ facts (r16) ต้องเป็น current_single — มิฉะนั้น
    resolver เห็น explicit → no_subject_ref → persisted single ไม่ถูก
    consume (Wattaka Q2 fan-out shape ผ่าน carrier อื่น)."""
    plan = td.decide_turn(
        "10Gbps + แม่เหล็ก",
        intent_result={"intent": "product_spec",
                       "spec_constraints": [{"field": "data_transfer_mbps",
                                             "op": "gte", "value": 10000}],
                       "subject_scope": "explicit", "confidence": 0.9})
    prod = [n for n in plan.needs if n.kind == "product"]
    assert prod and prod[0].spec_constraints, (
        f"premise: product need ต้องแบก spec_constraints — {plan.needs}")
    assert not prod[0].subject_refs, (
        f"premise: ต้องไม่มี subject refs — {prod[0].subject_refs}")
    assert prod[0].subject_scope == "current_single", (
        f"ungrounded explicit + spec carrier → current_single — "
        f"got {prod[0].subject_scope}")


@pytest.mark.xfail(strict=False, reason="LOW-2 — awaiting separate approval")
def test_feature_only_explicit_scope_normalizes_current_single():
    """LOW-2b: required_features carrier — contract เดียวกับ spec."""
    plan = td.decide_turn(
        "แม่เหล็กมีไหม",
        intent_result={"intent": "product_spec",
                       "required_features": ["magnetic"],
                       "subject_scope": "explicit", "confidence": 0.9})
    prod = [n for n in plan.needs if n.kind == "product"]
    assert prod and prod[0].required_features, (
        f"premise: product need ต้องแบก required_features — {plan.needs}")
    assert not prod[0].subject_refs, (
        f"premise: ต้องไม่มี subject refs — {prod[0].subject_refs}")
    assert prod[0].subject_scope == "current_single", (
        f"ungrounded explicit + feature carrier → current_single — "
        f"got {prod[0].subject_scope}")


@pytest.mark.xfail(strict=False, reason="LOW-2 — awaiting separate approval")
def test_ask_only_explicit_scope_normalizes_current_single():
    """LOW-2c: capability_asks carrier — follow-up capability question
    (shape เดียวกับ fact follow-up) ต้อง repair เหมือนกัน."""
    plan = td.decide_turn(
        "ใช้โหมดวิ่งบนหน้าจอได้ไหม",
        intent_result={"intent": "product_spec",
                       "capability_asks": ["ใช้โหมดวิ่งบนหน้าจอได้ไหม"],
                       "subject_scope": "explicit", "confidence": 0.9})
    prod = [n for n in plan.needs if n.kind == "product"]
    assert prod and prod[0].capability_asks, (
        f"premise: product need ต้องแบก capability_asks — {plan.needs}")
    assert not prod[0].subject_refs, (
        f"premise: ต้องไม่มี subject refs — {prod[0].subject_refs}")
    assert prod[0].subject_scope == "current_single", (
        f"ungrounded explicit + ask carrier → current_single — "
        f"got {prod[0].subject_scope}")


# ── LOW-3: unknown wattage ≠ below-target — ต้องมี uncertainty channel ──────

@pytest.mark.xfail(strict=False, reason="LOW-3 — awaiting separate approval")
def test_unknown_wattage_pick_gets_uncertainty_note(monkeypatch):
    """LOW-3a: pick ที่ wattage ไม่รู้เลย (ไม่มี output_power_w / variants
    / name-watt) + device มี structured min_watt → ต้องติด uncertainty
    label (unknown ≠ proven-below-target — เดิม label เฉพาะ watt ที่
    พิสูจน์ว่าต่ำกว่า หรือ mixed variants เท่านั้น)."""
    from shopeechat import device_compat as dc
    monkeypatch.setattr(dc, "_lookup_spec_db",
                        lambda name: {"device": "dev-x", "min_watt": 90.0}
                        if name == "dev-x" else None)
    pool = _pool((
        _watt_cand("p90", "BaseCell AD 90W charger", 90, score=1.0),
        _watt_cand("pU", "MysteryCell travel adapter", None, score=5.0),
    ))
    req = _req("req-0", types=("charger",), subs=("adapter",),
               target="dev-x")
    sel = rsel.select_for_llm_context(
        pool, (req,), _profile(), needs=(), per_request_limit=3)
    by_id = {s.identity: s for s in sel.selected}
    assert "i:pU" in by_id, (
        f"premise: unknown-watt cand ต้องถูกเลือก — {list(by_id)}")
    assert by_id["i:pU"].card.get("_context_note"), (
        "unknown-watt pick ต้องติด uncertainty note ไม่ใช่นำเสนอเงียบๆ "
        f"— note={by_id['i:pU'].card.get('_context_note')!r}")


@pytest.mark.xfail(strict=False, reason="LOW-3 — awaiting separate approval")
def test_decided_compat_unknown_wattage_surfaces_power_caveat():
    """LOW-3b: charges verdict decided จาก connector match เพียงอย่างเดียว
    (resolve_compat ไม่ consult min_watt) — subject ไม่มี watt evidence +
    device มี structured min_watt → ต้องมี typed caveat ว่า full-speed
    ยืนยันไม่ได้ (_context_note ของ card หรือ verdict reason —
    role note ทั่วไปไม่นับ)."""
    need = _need_compat(subj=("AC65B",), trefs=("dev-x",))
    req = _req("req-0", types=("cable",), codes=("AC65B",),
               target="dev-x", cm="connector_required")
    card = _sel_card("i:1", "subject", "req-0",
                     "สายชาร์จ C to C 1m", model_codes=["AC65B"],
                     connector="usb-c")
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "dev-x",
         "data": {"connector": "usb-c", "min_watt": 90.0,
                  "source": "spec-db"},
         "subject_refs": ("i:1",)},))
    ctx = _compile((need,), _selection((card, "req-0")), pool, (req,),
                   _profile())
    v = [x for x in ctx.compat_verdicts]
    assert v and v[0].decision.outcome == "compatible", (
        f"premise: connector match → compatible — {ctx.compat_verdicts}")
    note = " ".join(str(p.get("_context_note") or "")
                    for p in ctx.products)
    reasons = {r for x in v for r in x.decision.reason_codes}
    power_note = any(k in note for k in
                     ("ช้า", "ชาร์จ", "ไฟ", "กำลัง", "ทราบ", "ยืนยัน"))
    assert power_note or reasons & {"missing_wattage_evidence"}, (
        f"full-speed ไม่ได้ถูกพิสูจน์ → ต้องมี typed caveat ที่ไหนสักที่ "
        f"— note={note!r} reasons={reasons}")


# ── LOW-4: intrinsic ask ใน compat-target span — decided ห้ามทำหาย ──────────

def _intrinsic_ask_plan(target: str):
    """ask ที่ถาม intrinsic capability แต่ span มี typed relation target —
    arbitrary label เท่านั้น (ไม่มี incident keyword)."""
    msg = f"นาฬิกาแสดง {target} บนหน้าจอได้ไหม"
    intent = {"intent": "compatibility_check",
              "product_type": "smartwatch",
              "relation_target": target,
              "capability_asks": [f"แสดง {target} บนหน้าจอ"],
              "subject_scope": "explicit", "confidence": 0.9}
    return td.decide_turn(msg, intent_result=intent)


def test_intrinsic_ask_named_when_compat_undecided():
    """LOW-4b: intrinsic ask ถูก move ไป compat (ownership containment);
    compat undecided → outcome ต้อง name ask verbatim (bounded)."""
    plan = _intrinsic_ask_plan("Example Dock")
    compat = [n for n in plan.needs if n.kind == "compat"]
    assert compat and "Example Dock" in compat[0].target_refs
    c_asks = tuple(a for n in compat for a in n.capability_asks)
    assert c_asks == ("แสดง Example Dock บนหน้าจอ",), (
        f"premise: intrinsic ask → compat ownership — got {c_asks}")
    needs = plan.needs
    req0 = _req("req-0", types=("smartwatch",), trefs=("Example Dock",))
    ctx = _compile(needs, _w01_sel(), _w01_pool(), (req0,), _profile())
    answer = _render(_compose(needs, ctx,
                              product_text="spec ของ Generic Watch A"))
    assert "แสดง Example Dock บนหน้าจอ" in answer, (
        f"undecided compat outcome ต้อง name ask verbatim — "
        f"answer:\n{answer}")


def test_intrinsic_ask_named_when_compat_undecided_second_label():
    """LOW-4b generalization: arbitrary label ที่สอง — shape เดียวกัน."""
    plan = _intrinsic_ask_plan("Alpha Sync")
    compat = [n for n in plan.needs if n.kind == "compat"]
    assert compat and "Alpha Sync" in compat[0].target_refs
    needs = plan.needs
    req0 = _req("req-0", types=("smartwatch",), trefs=("Alpha Sync",))
    ctx = _compile(needs, _w01_sel(), _w01_pool(), (req0,), _profile())
    answer = _render(_compose(needs, ctx,
                              product_text="spec ของ Generic Watch A"))
    assert "แสดง Alpha Sync บนหน้าจอ" in answer, (
        f"undecided compat outcome ต้อง name ask verbatim — "
        f"answer:\n{answer}")


@pytest.mark.xfail(strict=False, reason="LOW-4c — awaiting separate approval")
def test_decided_compat_intrinsic_ask_still_reaches_outcome():
    """LOW-4c: intrinsic ask ถูก move ไป compat + compat decided (declared
    works_with proof) → verdict segment cover need — ask ต้องยังมี
    explicit outcome (need-completeness: verdict ตอบ relation แต่ไม่
    ตอบ intrinsic capability — ห้ามหายเงียบ)."""
    plan = _intrinsic_ask_plan("Example Dock")
    compat = [n for n in plan.needs if n.kind == "compat"]
    assert compat and compat[0].capability_asks == (
        "แสดง Example Dock บนหน้าจอ",), (
            f"premise: intrinsic ask ต้องอยู่ compat need — "
            f"{[n.capability_asks for n in plan.needs]}")
    needs = plan.needs
    req0 = _req("req-0", types=("smartwatch",), trefs=("Example Dock",),
                target="Example Dock", cm="bluetooth_general")
    card = _sel_card("i:1", "subject", "req-0", "Generic Watch A",
                     model_codes=["W01"])
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "Example Dock",
         "subject_id": "i:1", "relation": "works_with",
         "verdict": "compatible", "source": "spec-db",
         "subject_refs": ("i:1",)},))
    ctx = _compile(needs, _selection((card, "req-0")), pool, (req0,),
                   _profile())
    v = [x for x in ctx.compat_verdicts]
    assert v and v[0].decision.outcome == "compatible", (
        f"premise: compat ต้อง decided — {ctx.compat_verdicts}")
    answer = _render(_compose(needs, ctx,
                              product_text="spec ของ Generic Watch A"))
    assert "แสดง Example Dock บนหน้าจอ" in answer, (
        f"decided-compat ห้ามทำ intrinsic ask หายเงียบ — "
        f"answer:\n{answer}")


# ── M: FIX A — code-ref ≡ persisted subject identity (W01 Q2 incident) ─────
#   approved contract: explicit subject_refs แบบ code-shape (model code ไม่ใช่
#   item id) + persisted subject → resolver ผูก identity ผ่าน persisted
#   card-name codes ด้วย canonical _extract_codes (owner เดิม reuse ไม่ใช่
#   mechanism ใหม่) → resolved → union-stamp → subjects channel เดิม
#   เคสจริงจาก artifact: Q1 persist {18408364022}; Q2 ถาม "รุ่น IMILAB W01…"
#   → refs ('W01',) ต้องผูก item เดิม ไม่ใช่ no_selection ปลอม

_W01_NAME = ("[ลดเหลือ 699] IMILAB W01 ศูนย์ไทย สมาร์ทวอทช์ 1.69นิ้ว "
             "แจ้งเตือนไทย หน้าจอ100แบบ SpO2 รองรับแอปฯ Imilab Fit -30D")
_W01_MSG = ("ขอสอบถามค่ะ รุ่น IMILAB W01 เวลาใช้โหมดวิ่ง สามารถเชื่อมต่อ "
            "GPS จากมือถือเพื่อบันทึกระยะทางและเพซวิ่งได้ไหมคะ "
            "แล้วระหว่างวิ่งสามารถดูชีพจร เวลา ระยะทาง "
            "และเพซบนหน้าจอนาฬิกาได้หรือไม่คะ")
_GPS_ASK = "เชื่อมต่อ GPS จากมือถือเพื่อบันทึกระยะทางและเพซวิ่ง"
_DISP_ASK = "ดูชีพจร เวลา ระยะทาง และเพซบนหน้าจอนาฬิกา"
_W01_INTENT = {"intent": "product_spec", "product_type": "smartwatch",
               "target_device": "มือถือ", "relation_target": "GPS",
               "needs_description": True,
               "requested_facts": ["description"],
               "capability_asks": [_GPS_ASK, _DISP_ASK],
               "subject_scope": "explicit", "subject_count": None,
               "confidence": 0.98}


def _w01_persisted():
    from shopeechat import conversation_products as cp
    return cp.ConversationSubjectSet(
        subject_ids=("18408364022",), source_turn_id="t1",
        relation="single", requested_operations=(), confidence=1.0)


def _w01_code_index():
    """code index จาก persisted card name — shape เดียวกับที่ app สร้าง
    จาก _subject_products timeline (canonical _extract_codes เจ้าเดิม)."""
    from shopeechat.scripts.unit_classifier import _extract_codes
    return {"18408364022": tuple(_extract_codes(_W01_NAME))}


def test_code_ref_resolves_persisted_subject():
    """FIX A (case A): explicit code-ref 'W01' ≡ persisted card codes →
    resolved narrowed set — root cause ของ W01 Q2 no_selection."""
    from shopeechat import conversation_products as cp
    res = cp.resolve_subjects(
        _w01_persisted(), _W01_MSG, subject_scope="explicit",
        subject_refs=("W01",), persisted_code_index=_w01_code_index())
    assert res.outcome == "resolved", res
    assert res.subject_set.subject_ids == ("18408364022",)


def test_code_ref_resolution_truth_table():
    """FIX A: code-ref ต่างกัน/ digit ref / ไม่มี persisted / codes พิสูจน์
    ไม่ได้ / partial / multi-match — ห้าม substitute ผิดตัวเด็ดขาด."""
    from shopeechat import conversation_products as cp

    def res(refs, index=None, persisted="default"):
        return cp.resolve_subjects(
            _w01_persisted() if persisted == "default" else persisted,
            _W01_MSG, subject_scope="explicit",
            subject_refs=refs, persisted_code_index=index)

    idx = _w01_code_index()
    assert res(("W02",), idx).outcome == "no_subject_ref"          # B
    assert res(("999",), idx).outcome == "no_subject_ref"          # C
    assert res(("999", "W01"), idx).outcome == "no_subject_ref"    # mixed
    assert res(("W01",), idx, persisted=None).outcome \
        == "no_subject_ref"                                      # D
    assert res(("W01",), {"18408364022": ()}).outcome \
        == "no_subject_ref"                                      # F
    assert res(("W01",), None).outcome == "no_subject_ref"         # F'
    assert res(("W01", "W02"), idx).outcome == "no_subject_ref"    # partial
    multi = cp.ConversationSubjectSet(
        subject_ids=("18408364022", "2"), source_turn_id="t1",
        relation="alternatives", requested_operations=(),
        confidence=1.0)
    r = res(("W01",), {"18408364022": ("W01",), "2": ("W02",)},
            persisted=multi)
    assert r.outcome == "resolved"                                 # E
    assert r.subject_set.subject_ids == ("18408364022",)
    r = res(("W01",), {"18408364022": ("W01",), "2": ("W01",)},
            persisted=multi)
    assert r.outcome == "clarify"                                  # G


def test_code_ref_resolution_union_stamps_needs():
    """FIX A: resolved ผ่าน explicit-code equivalence → union stamp
    (item id + code) บน productish needs; resolution ชนิดอื่นไม่แตะ
    explicit refs (ห้ามผูก code กับ item ที่ไม่ได้พิสูจน์)."""
    from shopeechat import conversation_products as cp
    plan = td.decide_turn(_W01_MSG, intent_result=dict(_W01_INTENT))
    all_refs = tuple(dict.fromkeys(
        r for n in plan.needs for r in n.subject_refs))
    assert all_refs == ("W01",), all_refs
    res = cp.resolve_subjects(
        _w01_persisted(), _W01_MSG, subject_scope="explicit",
        subject_refs=all_refs, persisted_code_index=_w01_code_index())
    assert res.outcome == "resolved", res
    stamped = td.apply_resolved_subject_refs(
        plan.needs, res.subject_set.subject_ids, plan_scope="explicit")
    for n in stamped:
        if n.subject_refs:
            assert n.subject_refs == ("18408364022", "W01"), (
                n.kind, n.subject_refs)
    # control — plan ที่ scoped-need แรกไม่ใช่ explicit → resolution ไม่
    #   ผ่าน equivalence → explicit refs ต้องคงเดิม (ไม่ substitute)
    other = (TurnNeed(kind="product", operation="lookup",
                      subject_scope="current_single",
                      requested_facts=("price",)),
             TurnNeed(kind="product", operation="describe",
                      subject_scope="explicit",
                      subject_refs=("W02",)))
    st = td.apply_resolved_subject_refs(other, ("18408364022",),
                                        plan_scope="current_single")
    assert st[0].subject_refs == ("18408364022",)
    assert st[1].subject_refs == ("W02",), (
        f"explicit refs ที่ไม่ผ่าน equivalence ห้ามถูกผูก item อื่น — "
        f"{st[1].subject_refs}")


def test_code_ref_resolution_end_to_end_subjects_channel():
    """FIX A e2e (W01 Q2): persisted {18408364022} + code-ref plan →
    resolved → union-stamped → ch:subjects เลือก exact card → ctx ผูก
    item → asks ทุกตัวถึง explicit outcome channel; sibling ไม่รั่ว."""
    from shopeechat import conversation_products as cp
    from shopeechat import retrieval_runtime as rrt
    plan = td.decide_turn(_W01_MSG, intent_result=dict(_W01_INTENT))
    all_refs = tuple(dict.fromkeys(
        r for n in plan.needs for r in n.subject_refs))
    res = cp.resolve_subjects(
        _w01_persisted(), _W01_MSG, subject_scope="explicit",
        subject_refs=all_refs, persisted_code_index=_w01_code_index())
    assert res.outcome == "resolved", res
    stamped = td.apply_resolved_subject_refs(
        plan.needs, res.subject_set.subject_ids, plan_scope="explicit")
    profile = _profile(_W01_MSG, intent_result=dict(_W01_INTENT))
    from shopeechat.retrieval_policy import make_evidence_card
    w01 = make_evidence_card(
        {"item_id": "18408364022", "name": _W01_NAME, "shop": "t",
         "status": "NORMAL", "total_stock": 3,
         "model": [{"name": _W01_NAME, "model_status": "MODEL_NORMAL",
                    "stock_info_v2": {"summary_info": {
                        "total_available_stock": 3}}}]},
        source="legacy", requested=())

    def dead(*a, **k):
        raise RuntimeError("units unavailable")

    out = rrt.run_grouped_selection(
        profile, message=_W01_MSG, shop="t", platform="shopee",
        fetcher=dead, legacy_fetcher=None, subject_cards=[w01],
        needs=stamped)
    assert out is not None
    sel_ids = [str(s.card.get("item_id"))
               for s in out["selection"].selected]
    assert sel_ids == ["18408364022"], sel_ids
    assert any(getattr(r, "request_id", "") == "ch:subjects"
               for r in out["requests"]), "subjects channel ต้อง emit"
    ctx = acx.compile_answer_context(
        needs=stamped, selection=out["selection"], pool=out["pool"],
        requests=out["requests"], profile=profile)
    assert [str(p.get("item_id")) for p in ctx.products] == [
        "18408364022"], "context ต้องผูก exact item เดียว"
    unans_asks = {a for u in ctx.unanswered_needs
                  for a in u.capability_asks}
    task_asks = {a for t in getattr(ctx.task, "tasks", ())
                 for a in (getattr(t, "capability_asks", ()) or ())}
    assert _DISP_ASK in (unans_asks | task_asks), (
        "display ask ต้องถึง explicit outcome channel — "
        f"unanswered={ctx.unanswered_needs}")
    compat_u = [u for u in ctx.unanswered_needs
                if _GPS_ASK in u.capability_asks]
    assert compat_u and compat_u[0].reason == "no_evidence", (
        f"GPS ask ต้องเป็น cannot-confirm ที่ name ask — "
        f"{ctx.unanswered_needs}")
    txt = ctx.context_text()
    for sib in ("W02", "20069873881"):
        assert sib not in txt, f"sibling {sib} รั่วเข้า context"
