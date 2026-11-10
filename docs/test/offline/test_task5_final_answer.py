"""Task 5 — final customer-visible answer acceptance + typed compat
verdict truth table, through the real `app.chat()` path.

Model is `_CapturedLLM` (deterministic stub) — these tests assert the
PIPELINE (typed verdict → deterministic segment → guard → final text)
not stub luck: compat outcome comes from canonical `facts[compatible]`
through `compat_proof_from_dict`/`resolve_compat`, and blobs restating
a decided (subject,target) pair are deduped — a canned reply cannot
flip a typed verdict.
"""
import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "chatbot"))
sys.path.insert(0, str(REPO / "docs" / "test"))
sys.path.insert(0, str(REPO / "docs"))

import pytest  # noqa: E402
from _pytest.monkeypatch import MonkeyPatch  # noqa: E402

from test_legacy_turn_incident_replay import (  # noqa: E402
    _install, ADMIN_DB)
from test_zaapi_task5_contract import _gen_db  # noqa: E402
from zaapi_phase4_helpers import record  # noqa: E402

from shopeechat import app, kb_zaapi as kz, runtime_config  # noqa: E402


def _unit(unit_id, item_id, model_id, name, codes, ptype, shop="ShopA",
          price=390.0, stock=5):
    return {"unit_id": unit_id, "item_id": item_id, "model_id": model_id,
            "model_name": name, "display_name": name, "item_name": name,
            "model_codes": list(codes), "product_type": ptype,
            "shop": shop, "cat_name": ptype, "item_status": "NORMAL",
            "model_status": "NORMAL", "sellable": True, "stock": stock,
            "price": price,
            "search_text": " ".join((name, " ".join(codes))).lower(),
            "brand": "ANKER", "kind": "unit", "answerable": True,
            "oos_in_name": False, "has_description": False,
            "has_warranty_info": False, "image_ids": [],
            "confidence": 1.0}


def _item_doc(item_id, name, codes, ptype, shop="ShopA", price=390.0):
    return {"item_id": item_id, "item_name": name, "item_status": "NORMAL",
            "shopname": shop, "cat_name": ptype, "product_type": ptype,
            "condition": "new",
            "gen_price": price,
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


def _seed_zaapi(admindb, tmp, recs):
    gid = "g20261105-070707-abcdef12"
    for d in _gen_db(tmp, gid, recs)[
            "zaapi_kb_embedding_generations"].find({}):
        admindb["zaapi_kb_embedding_generations"].insert_one(d)
    return gid


def _compat_rec(verdict=True, target="xiaomi 17 ultra", **kw):
    facts = () if verdict is None else ({"key": "compatible",
                                        "value": verdict},)
    return record(record_type="compatibility", topic="compatibility",
                  model_codes=("CTC620P",), subject_id="CTC620P",
                  item_id="i-ct", target_id=target, facts=facts,
                  answer_text=f"CTC620P ใช้กับ {target} ได้", **kw)


_SPEC_REC = dict(record_type="spec", topic="",
                 model_codes=("CTC620P",), subject_id="CTC620P",
                 item_id="i-ct",
                 facts=({"key": "power_capacity_w", "value": 120},
                        {"key": "max_current_a", "value": 6}),
                 answer_text="CTC620P รองรับสูงสุด 120W / 6A")

_MSG = "สาย CTC620P ใช้กับ Xiaomi 17 Ultra ได้ไหม ชาร์จเร็วสุดกี่วัตต์"


def _chat(zaapi_recs, msg=_MSG, llm_reply="", shop="ShopA",
          catalog=None, units=None, intent_result=None,
          patch=None, calls_out=None):
    mp = MonkeyPatch()
    cid = f"fa-{id(zaapi_recs) & 0xffff:x}-{len(msg)}"
    fx = {"id": cid, "shop": shop, "platform": "shopee",
          "conversation_id": cid,
          "catalog": catalog if catalog is not None else
          [_item_doc("i-ct", "CTC620P สายชาร์จ 240W",
                     ("CTC620P",), "cable")],
          "turns": [{"text": msg,
                     "intent_result": intent_result or
                     {"intent": "product_compat",
                      "confidence": 0.9,
                      "requested_facts": ["charging_speed"]}}],
          "llm_reply": llm_reply,
          "runtime_flags": {"grouped_selection": True}}
    with tempfile.TemporaryDirectory() as tmpd:
        client, captured, _ = _install(mp, fx)
        admindb = client[ADMIN_DB]
        for u in (units if units is not None else
                  [_unit("u1", "i-ct", "m-ct", "CTC620P สายชาร์จ 240W",
                         ("CTC620P",), "cable")]):
            admindb["sellable_units"].insert_one(u)
        if zaapi_recs:
            _seed_zaapi(admindb, Path(tmpd), zaapi_recs)
            mp.setattr(runtime_config, "kb_source", lambda: "zaapi")
            mp.setattr(runtime_config, "source_enabled",
                       lambda *a, **k: True)
            _orig = kz.zaapi_kb_evidence
            mp.setattr(kz, "zaapi_kb_evidence",
                       lambda **kw: _orig(
                           **{k: v for k, v in kw.items()
                              if k != "exports_root"},
                           exports_root=Path(tmpd)))
            mp.setattr(kz, "_zaapi_allowed", lambda: True)
        # provider-failure injection seam (R11 correction tests) —
        #   patch(mp) applied after _install seams, before app.chat
        if patch is not None:
            patch(mp)
        try:
            resp = app.chat(app.ChatRequest(
                message=msg, shop=shop, platform="shopee", history=[],
                conversation_id=cid, limit=5, simulate_assignment=True,
                test_source="task5-final-answer"))
        finally:
            mp.undo()  # undo เสมอ — exception ระหว่าง chat ต้องไม่ leak patch
        typed_ctx = next(
            (c["context"] for c in captured.calls
             if c["fn"] == "answer_typed"), None)
        if calls_out is not None:
            calls_out += [c["fn"] for c in captured.calls]
        return resp, typed_ctx


def _verdict(ctx, need_i):
    return [v for v in (ctx.compat_verdicts or ())
            if v.need_index == need_i] if ctx else []


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_typed_compatible_positive_segment_and_capacity():
    """facts[compatible]=True → decided verdict → deterministic positive
    segment; cable capacity (power_capacity_w) grounds the spec answer
    in CAPACITY terms — it is not charger-output/full-speed proof."""
    resp, ctx = _chat([_compat_rec(True),
                       record(**_SPEC_REC)],
                      llm_reply="สาย CTC620P รองรับกำลังไฟสูงสุด "
                                "120W / 6A ค่ะ")
    ans = resp.answer or ""
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" in ans
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ไม่ได้" not in ans
    assert "120" in ans                       # grounded capacity claim
    # cable capacity is NOT charger output / full-speed proof → a typed
    # caveat must ride the decided verdict (capacity-covered needs a
    # card-typed cable — without one the honest cannot-verify-speed
    # caveat renders instead)
    assert ("กำลังชาร์จจริงยังขึ้นกับหัวชาร์จ" in ans
            or "ยังยืนยันไม่ได้ว่าชาร์จเต็มสเปค" in ans)
    assert "เต็มสปีด" not in ans
    vs = _verdict(ctx, 1)
    assert vs and all(v.decision.outcome == "compatible" for v in vs)


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_typed_incompatible_never_positive():
    """facts[compatible]=False → typed negative verdict; even an
    adversarial canned-positive reply cannot flip it (decided pair
    blobs are deduped) — final text must carry the typed negative."""
    resp, ctx = _chat(
        [_compat_rec(False), record(**_SPEC_REC)],
        llm_reply="CTC620P ใช้กับ Xiaomi 17 Ultra ได้ค่ะแน่นอน")
    ans = resp.answer or ""
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ไม่ได้" in ans
    vs = _verdict(ctx, 1)
    assert vs and all(v.decision.outcome == "incompatible" for v in vs)


def test_empty_facts_stay_unanswered():
    """compat record without a verdict fact → unknown → cannot-confirm;
    record_type alone is never an answer."""
    resp, ctx = _chat([_compat_rec(None), record(**_SPEC_REC)])
    ans = (resp.answer or "").lower()
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in ans
    assert not _verdict(ctx, 1)
    assert any(u.need_index == 1
               for u in (ctx.unanswered_needs or ()))


def test_malformed_verdict_fails_closed():
    """verdict value that is not a real bool (\"yes\") → proof rejected
    at `compat_proof_from_dict` → cannot-confirm."""
    rec = _compat_rec.__wrapped__ if hasattr(_compat_rec,
                                             "__wrapped__") else None
    bad = record(record_type="compatibility", topic="compatibility",
                 model_codes=("CTC620P",), subject_id="CTC620P",
                 item_id="i-ct", target_id="xiaomi 17 ultra",
                 facts=({"key": "compatible", "value": "yes"},),
                 answer_text="CTC620P ใช้กับ Xiaomi 17 Ultra ได้")
    resp, ctx = _chat([bad, record(**_SPEC_REC)])
    ans = (resp.answer or "").lower()
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in ans
    assert not _verdict(ctx, 1)
    assert any(u.need_index == 1
               for u in (ctx.unanswered_needs or ()))


def test_conflicting_verdicts_fail_closed_admin_review():
    """compatible + incompatible for the same (subject,target) →
    resolve_compat admin_review → not decided → cannot-confirm."""
    resp, ctx = _chat([_compat_rec(True), _compat_rec(False),
                       record(**_SPEC_REC)])
    ans = (resp.answer or "").lower()
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in ans
    assert not _verdict(ctx, 1)
    assert any(u.need_index == 1
               for u in (ctx.unanswered_needs or ()))
    assert resp.products == [] or all(
        "ctc620p" not in (p.get("item_name") or "").lower()
        for p in resp.products)


def test_wrong_target_never_leaks():
    """item-bound record declaring a different device must not reach
    typed evidence, verdicts, final text, or cards."""
    resp, ctx = _chat([_compat_rec(True),
                       _compat_rec(True, target="iphone 17"),
                       record(**_SPEC_REC)],
                      llm_reply="สาย CTC620P รองรับ 120W ค่ะ")
    ans = (resp.answer or "").lower()
    assert "iphone" not in ans
    for e in (ctx.evidence or ()):
        assert e.get("target") != "iphone 17"
    assert all(v.target != "iphone 17"
               for v in (ctx.compat_verdicts or ()))


def _variant_fx():
    """one item, two sellable variants MA100 / MB200 sharing
    item_id i-mix (production item names carry every variant code)."""
    item = _item_doc("i-mix", "สายชาร์จ MA100 MB200",
                     ("MA100", "MB200"), "cable")
    units = [_unit("u-a", "i-mix", "m-a", "MA100 สายชาร์จ",
                   ("MA100",), "cable"),
             _unit("u-b", "i-mix", "m-b", "MB200 สายชาร์จ",
                   ("MB200",), "cable")]
    return [item], units


def _variant_rec(model_id, code):
    return record(record_type="compatibility", topic="compatibility",
                  model_codes=(code,), subject_id=code,
                  item_id="i-mix", model_id=model_id,
                  target_id="xiaomi 17 ultra",
                  facts=({"key": "compatible", "value": True},),
                  answer_text=f"{code} ใช้กับ Xiaomi 17 Ultra ได้")


def test_variant_scoped_proof_never_decides_sibling():
    """record bound to variant MB200 (model_id=m-b) must not produce a
    decided-compatible verdict for sibling variant MA100 on the same
    item — shared item_id is not variant identity."""
    item, units = _variant_fx()
    resp, ctx = _chat(
        [_variant_rec("m-b", "MB200")],
        msg="สาย MA100 ใช้กับ Xiaomi 17 Ultra ได้ไหม",
        llm_reply="สาย MA100 ใช้กับ Xiaomi 17 Ultra ได้ค่ะแน่นอน",
        catalog=item, units=units)
    ans = (resp.answer or "").lower()
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in ans
    assert all(v.decision.outcome != "compatible"
               for v in (ctx.compat_verdicts or ()))


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_variant_scoped_proof_decides_own_variant():
    """positive control — the same record DOES decide its own variant
    (MB200 asked, MB200 bound) → typed compatible verdict + segment."""
    item, units = _variant_fx()
    resp, ctx = _chat(
        [_variant_rec("m-b", "MB200")],
        msg="สาย MB200 ใช้กับ Xiaomi 17 Ultra ได้ไหม",
        catalog=item, units=units)
    ans = resp.answer or ""
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" in ans
    assert any(v.decision.outcome == "compatible"
               for v in (ctx.compat_verdicts or ()))


def test_model_bound_record_never_reaches_sibling_llm_input():
    """ROUND-5 leak: record bound to variant MB200 must not appear in
    ctx.evidence / typed LLM input of the MA100 turn at all — blocking
    the verdict is not enough, the payload must never reach the model.
    adversarial canned reply cannot manufacture a positive claim."""
    item, units = _variant_fx()
    resp, ctx = _chat(
        [_variant_rec("m-b", "MB200")],
        msg="สาย MA100 ใช้กับ Xiaomi 17 Ultra ได้ไหม",
        llm_reply="สาย MA100 ใช้กับ Xiaomi 17 Ultra ได้ค่ะแน่นอน",
        catalog=item, units=units)
    ans = (resp.answer or "").lower()
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in ans
    assert all(v.decision.outcome != "compatible"
               for v in (ctx.compat_verdicts or ()))
    # model-bound record must not sit in evidence of any need — its
    # variant scope excludes MA100 entirely
    for e in (ctx.evidence or ()):
        if e.get("kind") != "kb_zaapi":
            continue
        assert e.get("model_id") != "m-b", \
            f"MB200 record leaked into LLM input: {e.get('identity')}"
        blob = str(e.get("payload") or "") + str(e.get("meta") or "")
        assert "mb200" not in blob.lower()
    text = ctx.context_text("ShopA") if ctx else ""
    assert "MB200" not in text


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_model_bound_record_serves_own_variant_context():
    """positive control — the same record DOES reach the MB200 turn's
    evidence and decides its own variant."""
    item, units = _variant_fx()
    resp, ctx = _chat(
        [_variant_rec("m-b", "MB200")],
        msg="สาย MB200 ใช้กับ Xiaomi 17 Ultra ได้ไหม",
        catalog=item, units=units)
    ans = resp.answer or ""
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" in ans
    ev = [e for e in (ctx.evidence or ())
          if e.get("kind") == "kb_zaapi"
          and e.get("model_id") == "m-b"]
    assert ev, "MB200 record missing from its own variant context"


def test_model_bound_no_variant_candidate_no_item_fallback():
    """model-bound attachment must not fall back to the item listing —
    when no same-variant candidate exists the attachment stays
    unlinked rather than binding the whole item."""
    from shopeechat import candidate_pool as cp
    att = cp.EvidenceAttachment(
        kind="kb_zaapi", identity="MB200", item_id="i-mix",
        linked_candidate=None, identity_domain="model", payload="",
        meta=None, target=None, model_id="m-b", trace=("t",))
    item_c = _NS_Item()
    out = cp._join_attachment(att, [item_c])
    assert all(a.linked_candidate != "i:i-mix" for a in out), \
        "model-bound record must not join the item listing"


def _NS_Item():
    from shopeechat import candidate_pool as cp
    import dataclasses
    fields = {f.name: None for f in dataclasses.fields(cp.PooledCandidate)}
    fields.update(identity="i:i-mix", item_id="i-mix", card={},
                  request_ids=(), bucket="eligible")
    return cp.PooledCandidate(**fields)


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_item_level_record_still_works():
    """item-bound record (no model_id) keeps its contract — it is about
    the item as a whole and may answer an item-level turn."""
    resp, ctx = _chat([_compat_rec(True), record(**_SPEC_REC)],
                      llm_reply="สาย CTC620P รองรับกำลังไฟสูงสุด "
                                "120W / 6A ค่ะ")
    ans = resp.answer or ""
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" in ans
    assert any(e.get("kind") == "kb_zaapi"
               for e in (ctx.evidence or ()))


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_variant_verdicts_stay_separate_same_item():
    """two variants of one item with opposite verdicts — each turn sees
    only its own variant's record in evidence and final answer."""
    item, units = _variant_fx()
    rec_b = _variant_rec("m-b", "MB200")
    rec_a = record(record_type="compatibility", topic="compatibility",
                   model_codes=("MA100",), subject_id="MA100",
                   item_id="i-mix", model_id="m-a",
                   target_id="xiaomi 17 ultra",
                   facts=({"key": "compatible", "value": False},),
                   answer_text="MA100 ใช้กับ Xiaomi 17 Ultra ไม่ได้")
    resp, ctx = _chat(
        [rec_b, rec_a],
        msg="สาย MA100 ใช้กับ Xiaomi 17 Ultra ได้ไหม",
        llm_reply="สาย MA100 ใช้กับ Xiaomi 17 Ultra ได้ค่ะแน่นอน",
        catalog=item, units=units)
    ans = (resp.answer or "").lower()
    # typed negative of MA100 wins; MB200's positive must not appear
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ไม่ได้" in ans
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in \
        ans.replace("ใช้งานร่วมกับ xiaomi 17 ultra ไม่ได้", "")
    for e in (ctx.evidence or ()):
        if e.get("kind") == "kb_zaapi":
            assert e.get("model_id") != "m-b", \
                "MB200 record leaked into MA100 turn evidence"


# ── B: ATC310N USB-A→C cable + charger pairing recommendation ────────

def _pairing_fx(head_name: str, head_specs=None, cable_specs=None,
                cable_name="ATC310N สาย USB-A to C 60W",
                cable_unit_name="ATC310N สาย USB-A to C"):
    """ATC310N cable + AD1404T charger head — specs = structured
    canonical_specs (typed port proof เหมือน structured catalog data
    จริงที่ไหลผ่าน units → card → extract_field_facts source=
    canonical_specs); ชื่อสินค้าเป็น free text เสมอ ไม่ใช่ typed fact."""
    catalog = [_item_doc("i-atc", cable_name, ("ATC310N",), "cable"),
               _item_doc("i-ad", head_name, ("AD1404T",), "charger")]
    u_cable = _unit("u-atc", "i-atc", "m-atc", cable_unit_name,
                    ("ATC310N",), "cable")
    u_head = _unit("u-ad", "i-ad", "m-ad", head_name,
                   ("AD1404T",), "charger")
    if cable_specs is not None:
        u_cable["canonical_specs"] = dict(cable_specs)
    if head_specs is not None:
        u_head["canonical_specs"] = dict(head_specs)
    return catalog, [u_cable, u_head]


_PAIR_MSG = "ATC310N มีหัวชาร์จเข้าคู่ไหม"
_PAIR_INTENT = {"intent": "product_recommend", "confidence": 0.9,
                "requested_facts": ["compatibility"]}
_PAIR_REPLY = ("แนะนำ AD1404T หัวชาร์จ USB-A "
               "เข้าคู่กับสาย ATC310N ได้เลยค่ะ")
























# ── R9: variant-scoped pairing facts (sibling units under one item) ──















# ── R10: product-bound pairing verdict — verdict ผูก (subject,target)
#     เดียว; compatible ของหัวตัวหนึ่งไม่ authorize claim ของอีกตัว ────

























# ── R11: structural pairing composition ownership — model pairing
#     prose ไม่ใช่ source of truth แม้ถ้อยคำนอก _PAIRING_RE; pairing
#     need ที่ typed decision ครอบ ห้ามมี model pairing conclusion ────

_PARAPHRASES = (
    "แนะนำ BAD999 เหมาะสำหรับใช้กับสาย ATC310N ค่ะ",
    "BAD999 รองรับการใช้งานกับสาย ATC310N ค่ะ",
    "BAD999 เสียบกับสาย ATC310N ได้ค่ะ",
)










# ── C: warranty -2Y/-24M and 2m cable length ─────────────────────────

_WARRANTY_MSG = "AC65B-2Y รับประกันกี่ปี"
_WARRANTY_INTENT = {"intent": "product_spec", "confidence": 0.9,
                    "requested_facts": ["warranty"]}


def _ac65b_fx(suffix: bool):
    """AC65B charger — name carries the -2Y warranty suffix or not."""
    name = "หัวชาร์จ 65W AC65B-2Y" if suffix else "หัวชาร์จ 65W AC65B"
    codes = ("AC65B", "AC65B-2Y") if suffix else ("AC65B",)
    catalog = [_item_doc("i-ac", name, codes, "charger")]
    units = [_unit("u-ac", "i-ac", "m-ac", name, codes, "charger")]
    return catalog, units


def _ac65b_warranty_rec():
    return record(record_type="faq", topic="warranty",
                  model_codes=("AC65B", "AC65B-2Y"), subject_id="AC65B",
                  item_id="i-ac",
                  facts=({"key": "warranty", "value": "24 months"},),
                  answer_text="AC65B-2Y รับประกัน 2 ปี")


def test_warranty_suffix_2y_answers_two_years():
    """AC65B-2Y + faq warranty 24 months — final answer must state
    2 ปี from typed evidence, never collapse the -2Y/-24M suffix
    or cable length into '2 เดือน'."""
    catalog, units = _ac65b_fx(suffix=True)
    resp, ctx = _chat(
        [_ac65b_warranty_rec()], msg=_WARRANTY_MSG,
        llm_reply="AC65B-2Y รับประกัน 2 ปีค่ะ",
        catalog=catalog, units=units,
        intent_result=_WARRANTY_INTENT)
    ans = (resp.answer or "")
    assert "2 ปี" in ans, f"2-year warranty missing: {ans!r}"
    assert "2 เดือน" not in ans
    names = [(p.get("item_name") or p.get("name") or "").lower()
             for p in (resp.products or [])]
    assert any("ac65b" in n for n in names)


def test_warranty_title_path_2y_no_zaapi():
    """C1 — title path only: name carries -2Y and NO Zaapi record
    exists. '2 ปี' must still be grounded by the card's title-derived
    warranty fact — the answer must not claim Zaapi support it lacks."""
    catalog, units = _ac65b_fx(suffix=True)
    resp, ctx = _chat(
        [], msg=_WARRANTY_MSG,
        llm_reply="AC65B-2Y รับประกัน 2 ปีค่ะ",
        catalog=catalog, units=units,
        intent_result=_WARRANTY_INTENT)
    ans = (resp.answer or "")
    assert "2 ปี" in ans, \
        f"title-derived -2Y warranty must answer 2 ปี: {ans!r}"
    assert "2 เดือน" not in ans
    # proof of the title path: no kb_zaapi evidence participated at all
    assert all(e.get("kind") != "kb_zaapi"
               for e in (ctx.evidence or ())), \
        "title path must not cite Zaapi evidence"


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_warranty_zaapi_path_no_suffix():
    """C2 — Zaapi path only: name has NO -2Y suffix; a properly scoped
    Zaapi faq warranty fact ('24 months') must ground 'ประกัน 2 ปี'
    through the typed measured channel."""
    catalog, units = _ac65b_fx(suffix=False)
    resp, ctx = _chat(
        [_ac65b_warranty_rec()], msg="AC65B รับประกันกี่ปี",
        llm_reply="AC65B รับประกัน 2 ปีค่ะ",
        catalog=catalog, units=units,
        intent_result=_WARRANTY_INTENT)
    ans = (resp.answer or "")
    # Zaapi warranty fact must actually reach evidence for the claim
    # to be credited to the Zaapi path
    assert any(e.get("kind") == "kb_zaapi"
               and any(f.get("key") == "warranty"
                       for f in (e.get("facts") or ()))
               for e in (ctx.evidence or ())), \
        "Zaapi warranty fact missing from evidence"
    assert "2 ปี" in ans, \
        f"Zaapi-derived warranty must answer 2 ปี: {ans!r}"
    assert "2 เดือน" not in ans


def test_warranty_no_source_cannot_confirm():
    """C3 — neither title suffix nor Zaapi record: the canned
    'ประกัน 2 ปี' reply must be rewritten to cannot-confirm —
    warranty claims may not be manufactured by the model."""
    catalog, units = _ac65b_fx(suffix=False)
    resp, ctx = _chat(
        [], msg="AC65B รับประกันกี่ปี",
        llm_reply="AC65B รับประกัน 2 ปีค่ะ",
        catalog=catalog, units=units,
        intent_result=_WARRANTY_INTENT)
    ans = (resp.answer or "")
    assert "2 ปี" not in ans, \
        f"warranty claim survived with no evidence: {ans!r}"


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_cable_length_2m_never_two_months():
    """cable_length_m=2 spec answers 'สายยาวกี่เมตร' — the typed spec
    fact must render as length, never as a 2-month warranty claim."""
    rec = record(record_type="spec", topic="",
                 model_codes=("CTC620P",), subject_id="CTC620P",
                 item_id="i-ct",
                 facts=({"key": "cable_length_m", "value": 2},),
                 answer_text="CTC620P สายยาว 2 เมตร")
    resp, ctx = _chat(
        [rec], msg="CTC620P สายยาวกี่เมตร",
        llm_reply="CTC620P สายยาว 2 เมตรค่ะ",
        intent_result={"intent": "product_spec", "confidence": 0.9,
                       "spec_constraints": [
                           {"field": "cable_length_m", "op": "eq",
                            "value": 2}]})
    ans = (resp.answer or "")
    assert "2 เดือน" not in ans
    assert any(e.get("kind") == "kb_zaapi"
               and any(f.get("key") == "cable_length_m"
                       for f in (e.get("facts") or ()))
               for e in (ctx.evidence or ())), \
        "typed length fact must reach evidence"


# ── D: single-turn multi-need (compat + capacity + warranty) ─────────

_D_FX_CATALOG = [_item_doc("i-ct", "CTC620P สายชาร์จ 240W-2Y",
                           ("CTC620P",), "cable")]
_D_FX_UNITS = [_unit("u1", "i-ct", "m-ct", "CTC620P สายชาร์จ 240W-2Y",
                     ("CTC620P",), "cable")]
_D_MSG = ("สาย CTC620P ใช้กับ Xiaomi 17 Ultra ได้ไหม "
          "รองรับกี่วัตต์ ประกันกี่เดือน")


def _d_warranty_rec():
    return record(record_type="faq", topic="warranty",
                  model_codes=("CTC620P",), subject_id="CTC620P",
                  item_id="i-ct",
                  facts=({"key": "warranty", "value": "24 months"},),
                  answer_text="CTC620P ประกัน 2 ปี")


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_multi_need_complete_evidence_answers_each_need():
    """D1 — full evidence: typed compat verdict + Zaapi capacity spec +
    Zaapi warranty fact — every need answers from its own source.
    120W stays cable capacity, never charger output/full-speed."""
    resp, ctx = _chat(
        [_compat_rec(True), record(**_SPEC_REC), _d_warranty_rec()],
        msg=_D_MSG,
        llm_reply="สาย CTC620P รองรับกำลังไฟสูงสุด 120W / 6A ค่ะ "
                  "ประกัน 2 ปีค่ะ",
        catalog=_D_FX_CATALOG, units=_D_FX_UNITS)
    ans = (resp.answer or "")
    # compat need → typed verdict + deterministic segment
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" in ans
    assert any(v.decision.outcome == "compatible"
               for v in (ctx.compat_verdicts or ()))
    # capacity need → 120W as capacity, never full-speed proof
    assert "120" in ans
    assert "เต็มสปีด" not in ans
    # warranty need → Zaapi '24 months' fact grounds '2 ปี' through the
    # measured channel (the card itself is not emitted in this shape)
    assert "2 ปี" in ans, \
        f"Zaapi warranty must survive grounding: {ans!r}"
    rd = getattr(resp, "routing_decision", None) or {}
    assert any(f.get("fact_key") == "warranty"
               for f in (rd.get("spec_measured") or ())), \
        "Zaapi warranty fact missing from spec_measured (guard channel)"
    assert "2 เดือน" not in ans


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_multi_need_missing_compat_only_that_need_fails():
    """D2 — partial evidence: no compat record → only the compat need
    degrades to cannot-confirm; capacity and Zaapi warranty must still
    be answered — fail-closed per need, never wholesale."""
    resp, ctx = _chat(
        [record(**_SPEC_REC), _d_warranty_rec()],
        msg=_D_MSG,
        llm_reply="สาย CTC620P รองรับกำลังไฟสูงสุด 120W / 6A ค่ะ "
                  "ประกัน 2 ปีค่ะ ||| สาย CTC620P ใช้กับ "
                  "Xiaomi 17 Ultra ได้เลยค่ะ",
        catalog=_D_FX_CATALOG, units=_D_FX_UNITS)
    ans = (resp.answer or "")
    # answered needs stay answered
    assert "120" in ans
    assert "2 ปี" in ans, \
        f"Zaapi warranty must survive grounding: {ans!r}"
    # the evidence-less compat need fails closed — the canned
    # 'ใช้กับ Xiaomi 17 Ultra ได้เลย' claim may not be confirmed
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in ans
    assert "ใช้กับ xiaomi 17 ultra ได้เลย" not in ans.lower()
    assert not [v for v in (ctx.compat_verdicts or ())
                if v.decision.outcome == "compatible"]
    assert "ไม่มีข้อมูลยืนยัน" in ans or "ไม่สามารถยืนยัน" in ans \
        or "แอดมิน" in ans


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_multi_need_claims_stay_on_own_evidence():
    """compat + charging_speed + warranty in one turn WITHOUT a
    charging literal in the message — the compat relation is
    undetermined → cannot-confirm; the Zaapi warranty fact still
    grounds '12 เดือน'; capacity stays capacity; troubleshooting
    records never reach the customer channel."""
    recs = [
        _compat_rec(True),
        record(**_SPEC_REC),
        record(record_type="faq", topic="warranty",
               model_codes=("CTC620P",), subject_id="CTC620P",
               item_id="i-ct",
               facts=({"key": "warranty", "value": "12 months"},),
               answer_text="CTC620P ประกัน 12 เดือน"),
        record(record_type="troubleshooting", topic="heat",
               model_codes=("CTC620P",), subject_id="CTC620P",
               item_id="i-ct",
               facts=({"key": "symptom", "value": "warm"},),
               answer_text="อุ่นระหว่างชาร์จปกติ"),
    ]
    resp, ctx = _chat(
        recs, msg="CTC620P ใช้กับ Xiaomi 17 Ultra ได้ไหม "
                  "รองรับกี่วัตต์ ประกันกี่เดือน",
        llm_reply="สาย CTC620P รองรับกำลังไฟสูงสุด 120W / 6A ค่ะ "
                  "ประกัน 12 เดือนค่ะ")
    ans = (resp.answer or "")
    ev = [e for e in (ctx.evidence or ()) if e.get("kind") == "kb_zaapi"]
    # no troubleshooting evidence ever reaches the customer channel
    assert all(e.get("record_type") != "troubleshooting" for e in ev)
    # 120W rendered as capacity — never as charger output/full-speed
    assert "120" in ans
    assert "เต็มสปีด" not in ans
    # Zaapi path warranty: properly scoped '12 months' fact grounds the
    # claim — Zaapi evidence reached the answer owner, so it answers
    assert "12 เดือน" in ans, \
        f"scoped Zaapi warranty fact must ground its claim: {ans!r}"
    # compat relation undetermined (no charging literal → no typed
    # relation) → cannot-confirm, no fake positive
    assert "ใช้งานร่วมกับ xiaomi 17 ultra ได้" not in ans
    assert "ไม่มีข้อมูลยืนยัน" in ans or "ไม่สามารถยืนยัน" in ans
    # and no need simply vanished: every unanswered need is surfaced
    assert len(ctx.unanswered_needs or ()) >= 2


def test_legacy_source_unchanged():
    """legacy kb_source path — no Zaapi artifact — keeps its previous
    customer-visible behavior (product answer, no typed gate)."""
    resp, ctx = _chat([], msg="CTC620P สเปค")
    assert resp.answer                       # produced an answer
    assert all(e.get("kind") != "kb_zaapi"
               for e in (ctx.evidence or ()))


# ── R11 correction — pair provider failure contract (fail-closed) ──────
#   H1 RED: provider call อยู่นอก error boundary ของ
#   _typed_answer_boundary — exception เคยหลุด app.chat() ทั้ง request
#   contract: single-purpose pairing need + provider raise / units read
#   fail / malformed verdict → model ไม่ถูกถาม (0 answer calls) +
#   deterministic cannot-confirm (UnansweredNeed no_evidence owner เดิม)
#   — ไม่มี model fallback กลับไปหา pairing guess













# ── R11C — exact pair verdict scope (malformed scope → fail closed) ────
#   independent-review finding: boundary เช็ก expected targets ⊆
#   supplied targets เท่านั้น → extra subject/target/duplicate/
#   conflicting/wrong-relation verdict ผ่าน → positive claim ปลอม
#   contract: expected (subject_id,target) pairs (matched pins ×
#   emitted identities, ตัด self-pair เดิม) == supplied pairs; len/set
#   equality จับ duplicate+missing+extra; relation ต้อง "connects";
#   foreign/malformed → fail-closed path เดิม (0 model call +
#   cannot-confirm + trace)





















# ── R11D — display-name identity binding (spoofed names → fail closed) ─
#   reviewer finding: exact pair IDs ผ่าน R11C แล้ว แต่ verdict
#   subject_name/target_name ไม่ถูกผูกกับ canonical card ของ identity
#   เดียวกัน → text/identity divergence (segment กล่าวชื่อปลอมขณะ
#   marker อ้าง card จริง); names ต้องตรง canonical display name
#   (precedence เดียวกับ _pair_verdicts: item_name→name→model_name)
#   พอดี — foreign/swapped/empty/non-string/sibling-name → reject ทั้งชุด













# ── negative pairing safety canaries (deferred pairing —
#   docs/plans/deferred-pairing-contract.md) — root-behavior lock:
#   unsupported product↔product compat need must never reach
#   answer_typed AND the customer answer must carry cannot-confirm ──

def _no_pairing_claim(ans: str) -> bool:
    a = ans.lower()
    return ("เข้าคู่" not in a and "ใช้ร่วมกันได้" not in a
            and "ใช้คู่กัน" not in a)


def _cannot_confirm(ans: str) -> bool:
    return ("ไม่มีข้อมูลยืนยัน" in ans or "ไม่สามารถยืนยัน" in ans
            or "ยืนยันไม่ได้" in ans)


def test_canary_no_evidence_positive_prose_never_rendered():
    """No structured port evidence + model emits positive pairing
    prose → need declined before model call; cannot-confirm renders."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ 65W")
    calls = []
    resp, _ = _chat([], msg=_PAIR_MSG, llm_reply=_PAIR_REPLY,
                    catalog=catalog, units=units,
                    intent_result=_PAIR_INTENT, calls_out=calls)
    assert "answer_typed" not in calls, \
        f"unsupported pairing need reached model: {calls}"
    ans = resp.answer or ""
    assert _no_pairing_claim(ans), \
        f"positive pairing rendered without evidence: {ans!r}"
    assert _cannot_confirm(ans), \
        f"cannot-confirm missing for unsupported need: {ans!r}"


def test_canary_usbc_only_head_never_usb_a_pairing():
    """Structured USB-C-only head + model claims USB-A pairing →
    wrong-surface claim must not render; need declined at root."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ USB-C only 65W",
                                 head_specs={"connector": "usb-c"})
    calls = []
    resp, _ = _chat([], msg=_PAIR_MSG, llm_reply=_PAIR_REPLY,
                    catalog=catalog, units=units,
                    intent_result=_PAIR_INTENT, calls_out=calls)
    assert "answer_typed" not in calls
    ans = resp.answer or ""
    assert _no_pairing_claim(ans), \
        f"USB-A pairing rendered for USB-C-only head: {ans!r}"
    assert _cannot_confirm(ans)


def test_canary_foreign_item_claim_never_rendered():
    """Model names a product that is not an attached candidate →
    wrong-item claim must not render; need declined at root."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ 65W")
    calls = []
    resp, _ = _chat(
        [], msg=_PAIR_MSG,
        llm_reply="แนะนำ EVIL999 เข้าคู่กับสาย ATC310N ได้เลยค่ะ",
        catalog=catalog, units=units, intent_result=_PAIR_INTENT,
        calls_out=calls)
    assert "answer_typed" not in calls
    ans = resp.answer or ""
    assert "evil999" not in ans.lower(), \
        f"foreign item claim rendered: {ans!r}"
    assert _cannot_confirm(ans)


def test_canary_card_attachment_never_endorsement():
    """Cards may attach to the answer, but attachment must not become
    a pairing assertion; unsupported need still declined at root."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ 65W")
    calls = []
    resp, _ = _chat([], msg=_PAIR_MSG, llm_reply=_PAIR_REPLY,
                    catalog=catalog, units=units,
                    intent_result=_PAIR_INTENT, calls_out=calls)
    assert "answer_typed" not in calls
    ans = resp.answer or ""
    assert _no_pairing_claim(ans), \
        f"attached card turned into endorsement: {ans!r}"
    assert _cannot_confirm(ans)


# ── positive controls — typed decline must not close other needs ──

def test_control_non_compat_recommendation_calls_model():
    """Spec/recommendation need (no compatibility fact) → answer_typed
    still called once and model reply reaches the customer answer —
    typed decline does not shut down ordinary product answers."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ 65W")
    calls = []
    resp, _ = _chat(
        [], msg="ATC310N รองรับกี่วัตต์",
        llm_reply="สาย ATC310N รองรับกำลังไฟสูงสุด 60W ค่ะ",
        catalog=catalog, units=units,
        intent_result={"intent": "product_recommend", "confidence": 0.9,
                       "requested_facts": ["charging_speed"]},
        calls_out=calls)
    assert calls.count("answer_typed") == 1, \
        f"recommendation need lost its model call: {calls}"
    assert "60" in (resp.answer or ""), \
        f"model spec answer missing: {resp.answer!r}"


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_control_multi_need_pairing_declined_spec_answered():
    """Mixed turn: unsupported pairing need (kind=compat, no target)
    + grounded spec need → only the pairing need declines
    (cannot-confirm, no model ownership); the spec need still gets
    its model call and answer."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ 65W")
    calls = []
    resp, _ = _chat(
        [record(record_type="spec", topic="",
                model_codes=("ATC310N",), subject_id="ATC310N",
                item_id="i-atc",
                facts=({"key": "power_capacity_w", "value": 60},),
                answer_text="ATC310N รองรับสูงสุด 60W")],
        msg="ATC310N มีหัวชาร์จเข้าคู่ไหม รองรับกี่วัตต์",
        llm_reply="สาย ATC310N รองรับ 60W ค่ะ",
        catalog=catalog, units=units,
        intent_result={"intent": "product_recommend", "confidence": 0.9,
                       "requested_facts": ["compatibility",
                                           "charging_speed"]},
        calls_out=calls)
    assert calls.count("answer_typed") == 1, \
        f"model-owned spec need lost: {calls}"
    ans = resp.answer or ""
    assert "60" in ans, f"grounded spec need swallowed: {ans!r}"
    assert _no_pairing_claim(ans), \
        f"pairing claim survived in mixed turn: {ans!r}"
    assert _cannot_confirm(ans), \
        f"pairing cannot-confirm missing: {ans!r}"


@pytest.mark.skip(
    reason="canonical zaapi_kb serving superseded by file-backed rows "
           "(spec v4 2026-11-07) — dormant path; file-backed e2e = "
           "test_zaapi_files_chat_e2e below")
def test_control_mixed_fact_strips_compatibility_only():
    """Single productish need carrying compatibility + charging_speed:
    compatibility subclaim is stripped from the rendered task (model
    is never asked the relation), charging_speed stays model-owned,
    and the compat cannot-confirm still renders beside the spec
    answer."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ 65W")
    calls = []
    resp, ctx = _chat(
        [record(record_type="spec", topic="",
                model_codes=("ATC310N",), subject_id="ATC310N",
                item_id="i-atc",
                facts=({"key": "power_capacity_w", "value": 60},),
                answer_text="ATC310N รองรับสูงสุด 60W")],
        msg="ATC310N เข้าคู่กับอะไรได้บ้าง รองรับกี่วัตต์",
        llm_reply="สาย ATC310N รองรับ 60W ค่ะ",
        catalog=catalog, units=units,
        intent_result={"intent": "product_recommend", "confidence": 0.9,
                       "requested_facts": ["compatibility",
                                           "charging_speed"]},
        calls_out=calls)
    assert calls.count("answer_typed") == 1
    tasks = ctx.task.tasks if ctx else ()
    assert tasks and all(
        "compatibility" not in (t.requested_facts or ())
        for t in tasks), \
        f"compatibility subclaim reached model task: {tasks!r}"
    ans = resp.answer or ""
    assert "60" in ans, f"grounded spec answer lost: {ans!r}"
    assert _no_pairing_claim(ans)
    assert _cannot_confirm(ans)


def test_canary_asks_marked_relation_never_reaches_model():
    """_ask_unanswered must not bypass relation decline: capability
    asks + compatibility ask + no subject evidence → 0 model calls;
    asks-named and relation cannot-confirm both render via the
    existing unanswered owner."""
    catalog, units = _pairing_fx("AD1404T หัวชาร์จ 65W")
    calls = []
    resp, _ = _chat(
        [], msg="ATC310N เข้าคู่กับอะไรได้บ้าง กันน้ำไหม",
        llm_reply=_PAIR_REPLY, catalog=catalog, units=units,
        intent_result={"intent": "product_recommend", "confidence": 0.9,
                       "requested_facts": ["compatibility"],
                       "capability_asks": ["กันน้ำ"]},
        calls_out=calls)
    assert calls == [], \
        f"asks-marked relation need reached model: {calls}"
    ans = resp.answer or ""
    assert _no_pairing_claim(ans)
    assert _cannot_confirm(ans)
    assert "กันน้ำ" in ans, \
        f"capability-ask cannot-confirm lost: {ans!r}"


# ══════════════════════════════════════════════════════════════════
# File-backed Zaapi KB (spec v4) — app.chat() e2e: row → Mongo active
# rev → search → evidence → typed answer context (stub LLM captures)
# ══════════════════════════════════════════════════════════════════

def _xlsx_bytes(rows, sheet="ข้อมูลสินค้า"):
    from openpyxl import Workbook
    from io import BytesIO
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    for r in rows:
        ws.append(r)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


_FILE_XLSX = _xlsx_bytes([
    ["ชื่อสินค้า", "รายละเอียดสินค้า", "คำตอบ"],
    ["CTC620P", "สายชาร์จ CTC620P 240W ยาว 2 เมตร", "รองรับ Xiaomi 17 Ultra"],
])


def _chat_files(mp, *, file_rows, filename="test-kb.xlsx",
                content_type="product", shop="ShopA", msg=_MSG,
                intent_result=None,
                llm_reply="CTC620P ใช้ได้ค่ะ", import_fn=None):
    """file row → apply_import (real owner) → app.chat() → (resp, typed_ctx).
    import_fn(admindb) เสริม import เพิ่ม/ทำกิจก่อน chat (replace/rollback)."""
    from shopeechat import kb_zaapi_files as _zkf
    cid = f"fa-files-{id(file_rows) & 0xffff:x}-{len(msg)}"
    fx = {"id": cid, "shop": shop, "platform": "shopee",
          "conversation_id": cid,
          "catalog": [_item_doc("i-ct", "CTC620P สายชาร์จ 240W",
                                ("CTC620P",), "cable")],
          "turns": [{"text": msg,
                     "intent_result": intent_result or {
                         "intent": "product_compat",
                         "confidence": 0.9,
                         "requested_facts": ["charging_speed"]}}],
          "llm_reply": llm_reply,
          "runtime_flags": {"grouped_selection": True}}
    with tempfile.TemporaryDirectory():
        client, captured, _ = _install(mp, fx)
        admindb = client[ADMIN_DB]
        admindb["sellable_units"].insert_one(
            _unit("u1", "i-ct", "m-ct", "CTC620P สายชาร์จ 240W",
                  ("CTC620P",), "cable"))
        if file_rows is not None:
            r = _zkf.apply_import(
                admindb, filename=filename, data=file_rows,
                accounts=["ShopA"], platforms=["shopee"],
                content_type=content_type, admin="t")
            assert r["ok"]
        if import_fn is not None:
            import_fn(admindb)
        mp.setattr(runtime_config, "kb_source", lambda: "zaapi")
        mp.setattr(runtime_config, "source_enabled",
                   lambda *a, **k: True)
        try:
            resp = app.chat(app.ChatRequest(
                message=msg, shop=shop, platform="shopee",
                history=[], conversation_id=cid, limit=5,
                simulate_assignment=True, test_source="zaapi-files-e2e"))
        finally:
            mp.undo()
        typed_ctx = next(
            (c["context"] for c in captured.calls
             if c["fn"] == "answer_typed"), None)
        return resp, typed_ctx


def _ev_text(e):
    p = e.get("payload")
    if isinstance(p, dict):
        return str(p.get("text") or "")
    return str(p or "")


def _file_evid(typed_ctx, prefix=""):
    return [e for e in (typed_ctx.evidence or ())
            if e.get("kind") == "kb"
            and str(e.get("record_id") or "").startswith(prefix)]


def test_zaapi_files_chat_e2e():
    """file row → active rev → kind=kb evidence ที่ typed boundary +
    ChatResponse.answer (stub LLM parrot เนื้อหาแถว — พิสูจน์ทางเดิน
    ไม่ใช่คำตอบไทยจริงจาก provider)."""
    mp = MonkeyPatch()
    resp, typed_ctx = _chat_files(
        mp, file_rows=_FILE_XLSX,
        msg="สาย CTC620P รองรับกี่วัตต์",
        intent_result={"intent": "product_recommend", "confidence": 0.9,
                       "requested_facts": ["charging_speed"]},
        llm_reply="สาย CTC620P รองรับสูงสุด 240W ยาว 2 เมตรค่ะ")
    kbe = _file_evid(typed_ctx, "test-kb.xlsx")
    assert kbe, "file row evidence missing at typed boundary"
    assert "CTC620P" in _ev_text(kbe[0])
    ans = resp.answer or ""
    assert "240W" in ans, f"model-rendered answer lost: {ans!r}"


def test_zaapi_files_compat_need_still_cannot_confirm():
    """typed truth: file row เป็น supporting evidence ไม่ใช่ compat verdict —
    product_compat need ต้อง cannot-confirm ตาม owner เดิมแม้มี evidence."""
    mp = MonkeyPatch()
    resp, typed_ctx = _chat_files(mp, file_rows=_FILE_XLSX)
    ans = resp.answer or ""
    assert _cannot_confirm(ans), \
        f"compat need answered without typed verdict: {ans!r}"


def test_zaapi_files_wrong_shop_no_evidence():
    """ร้านผิด → registry scope ตัด → 0 kb evidence ที่ typed boundary."""
    mp = MonkeyPatch()
    resp, typed_ctx = _chat_files(
        mp, file_rows=_FILE_XLSX, shop="ShopB")
    assert _file_evid(typed_ctx, "test-kb.xlsx") == [], \
        "wrong-shop file evidence leaked"


def test_zaapi_files_replace_uses_new_value():
    """import ชื่อเดิม → evidence ใช้ค่าใหม่ ไม่ใช่ค่าเก่า; rollback → กลับค่าเดิม."""
    from shopeechat import kb_zaapi_files as _zkf
    v2 = _xlsx_bytes([
        ["ชื่อสินค้า", "รายละเอียดสินค้า", "คำตอบ"],
        ["CTC620P", "สายชาร์จ CTC620P 240W ยาว 3 เมตร", "รุ่นใหม่"],
    ])
    mp = MonkeyPatch()
    resp, typed_ctx = _chat_files(
        mp, file_rows=_FILE_XLSX,
        import_fn=lambda admindb: _zkf.apply_import(
            admindb, filename="test-kb.xlsx", data=v2,
            accounts=["ShopA"], platforms=["shopee"],
            content_type="product", admin="t"))
    kbe = _file_evid(typed_ctx, "test-kb.xlsx")
    assert kbe and "ยาว 3 เมตร" in _ev_text(kbe[0]), \
        "replaced value must reach evidence"
    # rollback → ค่าเก่ากลับมา
    mp2 = MonkeyPatch()
    resp2, typed_ctx2 = _chat_files(
        mp2, file_rows=_FILE_XLSX,
        import_fn=lambda admindb: (
            _zkf.apply_import(
                admindb, filename="test-kb.xlsx", data=v2,
                accounts=["ShopA"], platforms=["shopee"],
                content_type="product", admin="t"),
            _zkf.rollback_import(admindb, filename="test-kb.xlsx",
                                 admin="t")))
    kbe2 = _file_evid(typed_ctx2, "test-kb.xlsx")
    assert kbe2 and "ยาว 2 เมตร" in _ev_text(kbe2[0]), \
        "rollback must restore old value"


def test_zaapi_files_near_model_not_confused():
    """ไฟล์มี CTC620P + CTC620P2 → ถาม CTC620P → evidence แรกต้องเป็นแถว
    CTC620P (ref boundary; แถว CTC620P2 ไม่ได้ ref credit)."""
    both = _xlsx_bytes([
        ["ชื่อสินค้า", "รายละเอียดสินค้า"],
        ["CTC620P", "สายชาร์จ CTC620P 240W ยาว 2 เมตร"],
        ["CTC620P2", "สายชาร์จ CTC620P2 300W ยาว 5 เมตร"],
    ])
    mp = MonkeyPatch()
    resp, typed_ctx = _chat_files(mp, file_rows=both)
    ev = _file_evid(typed_ctx, "test-kb.xlsx")
    assert ev, "expected kb evidence for the CTC620P question"
    top = ev[0]
    assert "CTC620P2" not in _ev_text(top), \
        "near-model row outranked the exact-model row"
    assert top["record_id"].endswith("::0")


def test_zaapi_files_conflicting_sources_both_reach_evidence():
    """สองไฟล์ค่าขัดกัน → แถวของทั้งสองไฟล์ต้องถึง typed context
    (owner ตอบต้องเห็นความขัดแย้ง ห้ามตัดไฟล์ใดทิ้งเงียบ ๆ)."""
    from shopeechat import kb_zaapi_files as _zkf
    f2 = _xlsx_bytes([
        ["ชื่อสินค้า", "รายละเอียดสินค้า"],
        ["CTC620P", "สายชาร์จ CTC620P ยาว 99 เมตร"],
    ])
    mp = MonkeyPatch()
    resp, typed_ctx = _chat_files(
        mp, file_rows=_FILE_XLSX,
        import_fn=lambda admindb: _zkf.apply_import(
            admindb, filename="second-kb.xlsx", data=f2,
            accounts=["ShopA"], platforms=["shopee"],
            content_type="product", admin="t"))
    ev = _file_evid(typed_ctx)
    files_seen = {(e.get("record_id") or "").split("::")[0] for e in ev}
    assert "test-kb.xlsx" in files_seen
    assert "second-kb.xlsx" in files_seen, \
        "conflicting file silently dropped from evidence"
