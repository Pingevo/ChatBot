"""Phase 7 — review-correction tests: typed answer boundary hardening.

พิสูจน์ในระดับ leaf (`llm._generate` capture) ว่า:

  A) raw prose (history / QA blob / unattributed text) ไม่ข้าม boundary
  B) evidence เข้าบริบทเฉพาะชนิดปิด + ต้องมี typed attribution
     (need_index / request_id / target / subject_refs / linked identity)
     — record ที่ prove ไม่ได้ว่าของ need ไหนต้องถูก omit + trace
  C) need A ไม่รับ product/evidence ของ need B
  D) web admission ต้องการ resolved local identity + external evidence
     ที่หายจริง (selected card = identity evidence เท่านั้น)
  E) admission ห้ามเรียก `device_compat._resolve_device_spec` ซ้ำ
  F) admission query สร้างจาก typed fields เท่านั้น — ห้าม hardcoded suffix
  G) policy-only / mixed product+policy → product answer-model calls = 0
  H) typed path offline จริง — load_dotenv/MongoClient traps (subprocess)
  I) cost/context evidence — fixture sample, labeled estimates เท่านั้น
"""
from __future__ import annotations

import inspect
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(TEST_DIR))

from test_phase7_answer_context import (  # noqa: E402  — reuse typed builders
    _req, _sel_card, _selection, _pool, _pooled, _profile, _compile,
)
from shopeechat import answer_context as acx  # noqa: E402
from shopeechat import candidate_pool as cpool  # noqa: E402
from shopeechat import llm, turn_decision as td  # noqa: E402

TurnNeed = td.TurnNeed

SENT_HIST = "SENTINEL_HISTORY_แชทรอบก่อน"
SENT_BOT = "SENTINEL_BOT_REPLY_คำตอบเก่า"
SENT_QA = "SENTINEL_QA_PROSE_บริบทถามตอบ"
SENT_POL = "SENTINEL_POLICY_PROSE_เงื่อนไขเคลม"
GHOST = "unattributed ghost text"
HARD_SUFFIX = "charging spec port watt"

FIXTURES = ROOT / "docs" / "test" / "fixtures" / "legacy_turn_incidents.jsonl"


@pytest.fixture(autouse=True)
def _offline_guard(monkeypatch):
    """ห้าม network/Mongo ในชุดนี้ — แบบเดียวกับ replay harness."""
    import socket
    import urllib.request

    def _fail(what):
        def _g(*a, **k):
            pytest.fail(f"OFFLINE LEAK: {what}", pytrace=False)
        return _g
    monkeypatch.setattr(socket.socket, "connect", _fail("socket.connect"))
    monkeypatch.setattr(urllib.request, "urlopen", _fail("urllib.urlopen"))
    import pymongo
    monkeypatch.setattr(pymongo.MongoClient, "__init__",
                        _fail("MongoClient.__init__"))
    yield


def _import_app(monkeypatch):
    """import shopeechat.app โดย stub dotenv.load_dotenv ก่อนเสมอ —
    .env ไม่ถูกเปิดจริง (stub คืน False; counter นับ invocation)."""
    import dotenv
    calls = {"dotenv": 0}

    def _stub(*a, **k):
        calls["dotenv"] += 1
        return False
    monkeypatch.setattr(dotenv, "load_dotenv", _stub)
    if "shopeechat.app" in sys.modules:
        return sys.modules["shopeechat.app"], calls
    import shopeechat.app as _app
    return _app, calls


def _need_product(op="recommend", types=("earphone",), refs=()):
    return TurnNeed(kind="product", operation=op, subject_refs=tuple(refs),
                    product_types=frozenset(types))


def _need_compat(refs=("AC65B",), types=("cable",)):
    return TurnNeed(kind="compat", operation="compat",
                    subject_refs=tuple(refs), product_types=frozenset(types))


def _need_policy():
    return TurnNeed(kind="policy", operation="unknown")


def _capture_generate(monkeypatch):
    """patch llm leaf — capture contents+system ที่ answer_typed ส่งจริง;
    get_model → Mongo (get_llm_config) จึง patch ด้วย (offline seam)."""
    captured = {}
    monkeypatch.setattr(llm, "_client", lambda *a, **k: object())
    monkeypatch.setattr(llm, "get_model", lambda role: "test-model")

    def _fake_generate(model, contents, config=None, **kw):
        captured["contents"] = contents
        captured["system"] = (config or {}).get("system_instruction", "")
        return SimpleNamespace(text="ok", usage_metadata=None)
    monkeypatch.setattr(llm, "_generate", _fake_generate)
    return captured


def _payload_text(captured):
    return repr(captured.get("contents")) + repr(captured.get("system"))


# ---------------------------------------------------------------------------
# A — actual answer payload purity
# ---------------------------------------------------------------------------

def test_boundary_signature_has_no_prose_channels(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    boundary = inspect.signature(_app._typed_answer_boundary).parameters
    typed = inspect.signature(llm.answer_typed).parameters
    for forbidden in ("history", "message", "products", "merged_products",
                      "extra_context", "policy_decisions"):
        assert forbidden not in boundary, f"boundary still takes {forbidden}"
        assert forbidden not in typed, f"answer_typed still takes {forbidden}"


def test_answer_typed_rejects_history_kwarg(monkeypatch):
    _capture_generate(monkeypatch)
    need = _need_product()
    ctx = _compile((need,), _selection(
        (_sel_card("i:1", "slot", "req-0", "Earphone"), "req-0")),
        _pool(), (_req(),), _profile())
    with pytest.raises(TypeError):
        llm.answer_typed(context=ctx,
                         history=[{"role": "user", "text": SENT_HIST},
                                  {"role": "model", "text": SENT_BOT}])


def test_boundary_generate_payload_purity(monkeypatch):
    """typed artifact จริง → boundary → capture _generate contents/system —
    sentinel ใน record ที่เข้าไม่ได้ (raw blob / kind นอก schema /
    unattributed) ต้องไม่ถึง payload."""
    _app, _ = _import_app(monkeypatch)
    captured = _capture_generate(monkeypatch)
    need = _need_product()
    req = _req(rid="req-0", types=("earphone",))
    card = _sel_card("i:1", "slot", "req-0", "Earphone X")
    sel = _selection((card, "req-0"))
    pool = _pool(
        eligible=(_pooled("i:1", "1", request_ids=("req-0",),
                          name="Earphone X"),),
        supporting=(
            {"kind": "qa", "text": SENT_QA},
            {"kind": "policy_brief", "text": SENT_POL},
            {"kind": "vision", "text": GHOST},   # ไม่มี subject_refs
        ))
    out = _app._typed_answer_boundary(
        {"selection": sel, "pool": pool, "requests": (req,)},
        needs=(need,), profile=_profile(), web_configured=False)
    assert out["answer_calls"] == 1
    text = _payload_text(captured)
    for s in (SENT_QA, SENT_POL, GHOST):
        assert s not in text, f"sentinel leaked into _generate payload: {s!r}"


def test_generate_payload_is_single_user_turn(monkeypatch):
    """contents = user turn เดียว — ไม่มี history entries เลย."""
    captured = _capture_generate(monkeypatch)
    need = _need_product()
    ctx = _compile((need,), _selection(
        (_sel_card("i:1", "slot", "req-0", "Earphone"), "req-0")),
        _pool(), (_req(),), _profile())
    llm.answer_typed(context=ctx)
    contents = captured["contents"]
    assert len(contents) == 1 and contents[0]["role"] == "user"


# ---------------------------------------------------------------------------
# B — structured evidence retention with typed attribution
# ---------------------------------------------------------------------------

def test_device_spec_evidence_attributed_by_target():
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target", target="iphone 15",
               types=("cable",))
    sel = _selection(
        (_sel_card("i:7", "relation_target", "req-0", "Cable"), "req-0"))
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"port": "usb-c", "watt": 20}},))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    spec = [e for e in ctx.evidence if e["kind"] == "device_spec"]
    assert len(spec) == 1 and spec[0]["need_indices"] == (0,), ctx.evidence


def test_kb_channel_evidence_attributed_by_request():
    need = _need_product()
    req_slot = _req(rid="req-0", types=("earphone",))
    req_kb = _req(rid="ch:kb", source="kb")
    card = _sel_card("i:1", "slot", "req-0", "Earphone X")
    sel = _selection((card, "req-0"))
    pool = _pool(supporting=(
        {"kind": "kb", "request_id": "ch:kb",
         "payload": {"note": "kb product note"}},))
    ctx = _compile((need,), sel, pool, (req_slot, req_kb), _profile())
    kb = [e for e in ctx.evidence if e["kind"] == "kb"]
    assert len(kb) == 1 and kb[0]["need_indices"] == (0,), ctx.evidence


def test_attachment_evidence_attributed_by_linked_identity():
    need = _need_product()
    req = _req(rid="req-0", types=("earphone",))
    card = _sel_card("i:1", "slot", "req-0", "Earphone X")
    sel = _selection((card, "req-0"))
    att = cpool.EvidenceAttachment(
        kind="image_text", identity="i:1", item_id="1",
        linked_candidate="i:1", payload={"text": "[i:1] ภาพชุดแปลง"})
    pool = _pool(
        eligible=(_pooled("i:1", "1", request_ids=("req-0",),
                          name="Earphone X"),),
        evidence_pool=(att,))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    img = [e for e in ctx.evidence if e["kind"] == "image_text"]
    assert len(img) == 1 and img[0]["need_indices"] == (0,), ctx.evidence


def test_vision_evidence_attributed_by_subject_refs():
    need = TurnNeed(kind="product", operation="describe",
                    subject_refs=("AC65B",))
    req = _req(rid="req-0", source="subjects", codes=("AC65B",))
    card = _sel_card("i:1", "subject", "req-0", "หูฟัง AC65B",
                     codes=["AC65B"])
    sel = _selection((card, "req-0"))
    pool = _pool(supporting=(
        {"kind": "vision", "subject_refs": ("AC65B", "i:1"),
         "text": "ภาพแสดงพอร์ต usb-c"},))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    vis = [e for e in ctx.evidence if e["kind"] == "vision"]
    assert len(vis) == 1 and vis[0]["need_indices"] == (0,), ctx.evidence


def test_web_evidence_attributed_by_need_index():
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target", target="galaxy z99",
               types=("cable",))
    web = ({"kind": "web", "target": "galaxy z99",
            "results": [{"title": "t", "snippet": "s"}],
            "need_index": 0},)
    ctx = _compile((need,), _selection(), _pool(), (req,), _profile(),
                   web_evidence=web)
    w = [e for e in ctx.evidence if e["kind"] == "web"]
    assert len(w) == 1 and w[0]["need_indices"] == (0,), ctx.evidence


def test_unattributed_and_raw_records_dropped_with_trace():
    need = _need_product()
    req = _req(rid="req-0", types=("earphone",))
    card = _sel_card("i:1", "slot", "req-0", "Earphone X")
    sel = _selection((card, "req-0"))
    pool = _pool(supporting=(
        {"kind": "qa", "text": SENT_QA},                        # unknown kind
        {"kind": "vision", "text": "no attribution"},           # no refs
        {"kind": "kb", "text": "blob ไม่มี request_id"},        # no request_id
        {"kind": "device_spec", "target": "totally-other"},     # other target
        {"kind": "web", "target": "totally-other",
         "results": []},                                        # unattributed
    ))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    assert ctx.evidence == (), ctx.evidence
    drops = [t for t in ctx.trace if t.startswith("evidence_dropped:")]
    assert len(drops) == 5, ctx.trace


# ---------------------------------------------------------------------------
# C — cross-need isolation
# ---------------------------------------------------------------------------

def test_cross_need_isolation_products_and_evidence():
    need_a = _need_product(types=("earphone",))
    need_b = _need_compat(refs=("AC65B",), types=("cable",))
    req_a = _req(rid="req-a", types=("earphone",))
    req_b = _req(rid="req-b", source="relation_target",
                 target="galaxy z99 fakephone", types=("cable",))
    card_a = _sel_card("i:1", "slot", "req-a", "Earphone A")
    card_b = _sel_card("i:2", "relation_target", "req-b", "Cable B")
    sel = _selection((card_a, "req-a"), (card_b, "req-b"))
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "galaxy z99 fakephone",
         "data": {"watt": 25}},))
    ctx = _compile((need_a, need_b), sel, pool, (req_a, req_b), _profile())
    ev = [e for e in ctx.evidence if e["kind"] == "device_spec"]
    assert len(ev) == 1 and ev[0]["need_indices"] == (1,), (
        "evidence ของ need B ห้าม attribute เข้า need A")
    # compile เฉพาะ need A → card/evidence ของ B ต้องไม่เข้า
    ctx_a = _compile((need_a,), sel, pool, (req_a, req_b), _profile())
    assert [p["name"] for p in ctx_a.products] == ["Earphone A"]
    assert ctx_a.evidence == ()


# ---------------------------------------------------------------------------
# A2 — product→need structural ownership in the ACTUAL serialized payload
# ---------------------------------------------------------------------------

def _ctx_products(ctx) -> list[dict]:
    """parse product JSON block ออกจาก serialized context_text() จริง —
    พิสูจน์ ownership ใน payload ที่ส่ง LLM ไม่ใช่แค่ internal field."""
    txt = ctx.context_text()
    body = txt.split("จำนวนสินค้าใน context: ", 1)[1].split("\n\n", 1)[1]
    return json.loads(body.split("\n\n", 1)[0])


def test_products_carry_need_ownership_in_serialized_context():
    """two disjoint needs — serialized payload ต้องบอกชัด product ไหนของ
    task ไหน (ownership = typed need index ไม่ใช่การเดาจากชื่อ)."""
    need_a = _need_product(op="recommend", types=("earphone",))
    need_b = _need_compat(refs=("AC65B",), types=("cable",))
    req_a = _req(rid="req-a", types=("earphone",))
    req_b = _req(rid="req-b", source="relation_target",
                 target="galaxy z99 fakephone", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-a", "Earphone A"), "req-a"),
        (_sel_card("i:2", "relation_target", "req-b", "Cable B"), "req-b"))
    ctx = _compile((need_a, need_b), sel, _pool(), (req_a, req_b),
                   _profile())
    prods = _ctx_products(ctx)
    by_name = {p.get("name"): p for p in prods}
    assert "Earphone A" in by_name and "Cable B" in by_name, prods
    # serialized payload = visible task numbers (1-based — เลขเดียวกับ
    # งานที่ N / evidence (งานที่ N)); internal 0-based คงเดิม
    assert by_name["Earphone A"]["need_indices"] == [1], by_name
    assert by_name["Cable B"]["need_indices"] == [2], by_name
    r = ctx.task.render()
    assert "งานที่ 1" in r and "งานที่ 2" in r


def test_shared_identity_unions_need_ownership():
    """identity เดียวถูกเลือกให้ 2 needs → ปรากฏครั้งเดียว และ structurally
    ถือ ownership ทั้งสอง need (union — ไม่เงียบตกเป็นของ need แรก)."""
    need_a = _need_product(op="recommend", types=("earphone",))
    need_b = _need_product(op="describe", types=("earphone",))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-0", "Shared EP"), "req-0"))
    ctx = _compile((need_a, need_b), sel, _pool(), (req,), _profile())
    prods = _ctx_products(ctx)
    assert len(prods) == 1, prods
    assert prods[0]["need_indices"] == [1, 2], prods
    # canonical card/internal ownership ยัง 0-based — translate เฉพาะตอน render
    assert ctx.products[0]["need_indices"] == (0, 1)


# ---------------------------------------------------------------------------
# B2 — evidence closed FIELD schema + size bounds (kind filter is not enough)
# ---------------------------------------------------------------------------

SENT_EVIDENCE = "SENTINEL_EVIDENCE_FIELD_ค่าลับ"
EVIDENCE_OUT_FIELDS = frozenset({
    "kind", "need_indices", "target", "identity",
    "linked_candidate", "item_id", "payload"})


def _sentinel_evidence_pool():
    """record ทุก supported kind + unknown-field sentinel ในแต่ละตัว."""
    return _pool(
        eligible=(_pooled("i:1", "1", request_ids=("req-0",),
                          name="Earphone X"),),
        supporting=(
            {"kind": "device_spec", "target": "iphone 15",
             "data": {"watt": 20}, "leak": SENT_EVIDENCE},
            {"kind": "kb", "request_id": "ch:kb",
             "payload": {"text": "kb note"}, "leak": SENT_EVIDENCE},
            {"kind": "vision", "subject_refs": ("i:1",),
             "text": "vis note", "leak": SENT_EVIDENCE},
        ),
        evidence_pool=(cpool.EvidenceAttachment(
            kind="image_text", identity="i:1", item_id="1",
            linked_candidate="i:1",
            payload={"text": "img note", "leak": SENT_EVIDENCE}),))


def test_evidence_unknown_fields_never_reach_context():
    """kind ผ่านแล้ว แต่ field นอก schema ห้ามข้าม — emitted record ต้องเป็น
    closed schema เท่านั้น (ไม่ใช่ whole-dict copy)."""
    need = _need_product(op="describe", refs=("i:1",))
    req = _req(rid="req-0", types=("earphone",), target="iphone 15")
    req_kb = _req(rid="ch:kb", source="kb", types=())
    sel = _selection(
        (_sel_card("i:1", "slot", "req-0", "Earphone X"), "req-0"))
    ctx = _compile((need,), sel, _sentinel_evidence_pool(),
                   (req, req_kb), _profile())
    assert len(ctx.evidence) == 4, ctx.evidence
    txt = ctx.context_text()
    assert SENT_EVIDENCE not in txt
    for e in ctx.evidence:
        assert SENT_EVIDENCE not in repr(e), e
        assert set(e) <= EVIDENCE_OUT_FIELDS, (
            f"field นอก schema รั่ว: {set(e) - EVIDENCE_OUT_FIELDS}")
    # identity/target/payload ของจริงยังอยู่
    spec = next(e for e in ctx.evidence if e["kind"] == "device_spec")
    assert spec.get("target") == "iphone 15" and spec.get("payload")


def test_evidence_text_deterministically_bounded():
    """payload ใหญ่เกิน remaining record budget → ตัดที่ byte boundary
    เดิมเสมอ + trace; record json ทั้งก้อน ≤ _EVIDENCE_RECORD_BYTES."""
    need = _need_product(op="describe", refs=("i:1",))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-0", "Earphone X"), "req-0"))
    big = "สเปคยาวมาก" * 4000  # ~160KB utf-8
    pool = _pool(
        eligible=(_pooled("i:1", "1", request_ids=("req-0",)),),
        supporting=({"kind": "vision", "subject_refs": ("i:1",),
                     "text": big},))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    ev = [e for e in ctx.evidence if e["kind"] == "vision"]
    assert len(ev) == 1, ctx.evidence
    assert len(ev[0]["payload"].encode("utf-8")) <= acx._EVIDENCE_RECORD_BYTES
    # record ทั้งก้อน (รวม structural fields) ต้อง ≤ record cap จริง
    assert len(json.dumps(ev[0], ensure_ascii=False,
                          default=str).encode("utf-8")) \
        <= acx._EVIDENCE_RECORD_BYTES
    # deterministic: compile ซ้ำได้ผล byte-identical
    ctx2 = _compile((need,), sel, pool, (req,), _profile())
    assert ctx2.evidence == ctx.evidence
    assert any(t.startswith("evidence_truncated:") for t in ctx.trace), \
        ctx.trace
    # identity fields ห้ามถูกตัด
    assert "subject_refs" not in ev[0]  # consumed เป็น need_indices แล้ว


def test_evidence_count_and_total_size_bounded():
    """record count ≤ EVIDENCE_LIMIT และ rendered evidence block จริง ≤
    declared _EVIDENCE_BLOCK_BYTES (record เดียวเอาชนะ cap ไม่ได้)."""
    need = _need_product(op="describe", refs=("i:1",))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-0", "Earphone X"), "req-0"))
    pool = _pool(
        eligible=(_pooled("i:1", "1", request_ids=("req-0",)),),
        supporting=tuple(
            {"kind": "vision", "subject_refs": ("i:1",),
             "text": "x" * 9000} for _ in range(12)))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    assert len(ctx.evidence) <= acx.EVIDENCE_LIMIT
    total = sum(len(str(e.get("payload") or "").encode("utf-8"))
                for e in ctx.evidence)
    assert total <= acx.EVIDENCE_LIMIT * acx._EVIDENCE_RECORD_BYTES


# ---------------------------------------------------------------------------
# D — web admission truth table (corrected contract)
# ---------------------------------------------------------------------------

def _admission(needs, sel, pool, reqs, **kw):
    return acx.decide_web_admission(needs=needs, selection=sel, pool=pool,
                                    requests=reqs, profile=_profile(), **kw)


def test_web_deny_scopeless_no_selected_identity():
    """need ไม่มี refs + ไม่มี selected card → unresolved identity."""
    need = TurnNeed(kind="product", operation="describe",
                    product_types=frozenset())
    req = _req(rid="req-0", target="earphone")
    adm = _admission((need,), _selection(), _pool(), (req,),
                     web_configured=True)
    assert not adm.allowed and adm.reason == "unresolved_local_identity", adm


def test_web_admit_selected_card_missing_external_evidence():
    """selected card = identity evidence — external target ยังไม่มี
    evidence → admit (card เดียวไม่ใช่ spec coverage)."""
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target",
               target="galaxy z99 fakephone", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "Cable"), "req-0"))
    adm = _admission((need,), sel, _pool(), (req,), web_configured=True)
    assert adm.allowed and adm.reason == "admitted_external_evidence_need", adm
    assert "galaxy z99 fakephone" in adm.query


def test_web_deny_device_spec_record_same_target():
    """pool มี device_spec ของ target เดียวกัน → local evidence พอแล้ว."""
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target", target="iphone 15",
               types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "Cable"), "req-0"))
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15",
         "data": {"watt": 20}},))
    adm = _admission((need,), sel, pool, (req,), web_configured=True)
    assert not adm.allowed and adm.reason == "local_evidence_sufficient", adm


def test_web_deny_web_supplied_same_target():
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target", target="galaxy z99",
               types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "C"), "req-0"))
    pool = _pool(supporting=(
        {"kind": "web", "target": "galaxy z99",
         "results": [{"title": "t"}]},))
    adm = _admission((need,), sel, pool, (req,), web_configured=True)
    assert not adm.allowed and adm.reason == "web_already_supplied", adm


def test_web_evidence_different_target_does_not_deny():
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target", target="galaxy z99",
               types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "C"), "req-0"))
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "iphone 15", "data": {}},
        {"kind": "web", "target": "iphone 15", "results": [{"t": 1}]}))
    adm = _admission((need,), sel, pool, (req,), web_configured=True)
    assert adm.allowed, "evidence ของ target อื่นห้าม deny target นี้"


def test_web_deny_operations_table():
    pool = _pool(eligible=(_pooled("i:1", "1", codes=("AC65B",),
                                   request_ids=("req-0",)),))
    # resolved refs (AC65B อยู่ใน pool) แต่ op เป็น local fact → deny
    for op in ("price", "stock", "link"):
        need = _need_product(op=op, types=(), refs=("AC65B",))
        adm = _admission((need,), _selection(), pool, (_req(),),
                         web_configured=True)
        assert not adm.allowed and adm.reason == "local_fact_operation", \
            (op, adm)
    # recommend ไม่มี refs → catalog existence; describe/variant resolved
    # refs + ไม่มี target → no external target
    adm = _admission((_need_product(op="recommend", types=()),),
                     _selection(), pool, (_req(),), web_configured=True)
    assert not adm.allowed and adm.reason == "local_catalog_existence", adm
    for op in ("describe", "variant"):
        need = _need_product(op=op, types=(), refs=("AC65B",))
        adm = _admission((need,), _selection(), pool, (_req(),),
                         web_configured=True)
        assert not adm.allowed and adm.reason == "no_external_target", \
            (op, adm)


def test_web_deny_not_configured_and_internal_error():
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target", target="galaxy z99",
               types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "C"), "req-0"))
    adm = _admission((need,), sel, _pool(), (req,), web_configured=False)
    assert not adm.allowed and adm.reason == "not_configured", adm
    # malformed inputs → deny internal_error, ไม่ raise
    adm2 = acx.decide_web_admission(needs=None, selection=None, pool=None,
                                    requests=None, profile=None,
                                    web_configured=True)
    assert not adm2.allowed and adm2.reason == "internal_error", adm2


def test_web_deny_unresolved_refs():
    need = _need_compat(refs=("AC65B",))
    req = _req(rid="req-0", source="relation_target", target="galaxy z99",
               types=("cable",))
    adm = _admission((need,), _selection(), _pool(), (req,),
                     web_configured=True)
    assert not adm.allowed and adm.reason == "unresolved_local_identity", adm


# ---------------------------------------------------------------------------
# E — no duplicate device/spec lookup
# ---------------------------------------------------------------------------

def test_admission_never_calls_resolve_device_spec(monkeypatch):
    from shopeechat import device_compat
    calls = {"n": 0}

    def _spy(*a, **k):
        calls["n"] += 1
        return {"port": "usb-c"}
    monkeypatch.setattr(device_compat, "_resolve_device_spec", _spy)
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target", target="iphone 15",
               types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "C"), "req-0"))
    adm = _admission((need,), sel, _pool(), (req,), web_configured=True)
    assert calls["n"] == 0, "admission ห้ามเรียก spec resolver ซ้ำ"
    assert adm.allowed, "pool ไม่มี spec record → external evidence ยังขาด"


# ---------------------------------------------------------------------------
# F — typed web query
# ---------------------------------------------------------------------------

def test_admission_query_built_from_typed_fields_only():
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target",
               target="galaxy z99 fakephone", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "Cable"), "req-0"))
    adm = _admission((need,), sel, _pool(), (req,), web_configured=True)
    assert adm.allowed
    assert HARD_SUFFIX not in adm.query
    # query = typed fields เท่านั้น: target + operation + scope + subject refs
    assert adm.query == "galaxy z99 fakephone compat cable AC65B"


# ---------------------------------------------------------------------------
# G — policy-only / mixed zero product-model calls
# ---------------------------------------------------------------------------

def test_policy_only_needs_zero_answer_calls(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    _capture_generate(monkeypatch)
    typed_calls = []
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **kw: typed_calls.append(kw) or ("pol", {}))
    out = _app._typed_answer_boundary(
        {"selection": _selection(), "pool": _pool(), "requests": ()},
        needs=(_need_policy(),), profile=_profile(), web_configured=False)
    assert out["answer_calls"] == 0 and typed_calls == []
    assert out["answer"]


def test_mixed_product_policy_needs_zero_answer_calls(monkeypatch):
    """mixed turn → deterministic defer — Phase 8 เจ้าของ composition."""
    _app, _ = _import_app(monkeypatch)
    typed_calls = []
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **kw: typed_calls.append(kw) or ("mix", {}))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection((_sel_card("i:1", "slot", "req-0", "Earphone"), "req-0"))
    out = _app._typed_answer_boundary(
        {"selection": sel, "pool": _pool(), "requests": (req,)},
        needs=(_need_product(), _need_policy()), profile=_profile(),
        web_configured=False)
    assert out["answer_calls"] == 0 and typed_calls == []
    assert out["answer"]


# ---------------------------------------------------------------------------
# D2 — single deferred-kind owner (compiler emits typed signal; boundary
#      consumes it — no private cross-module constant, no duplicate set)
# ---------------------------------------------------------------------------

def test_boundary_has_no_private_deferred_kind_access(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    src = inspect.getsource(_app._typed_answer_boundary)
    assert "_POLICY_NEED_KINDS" not in src, (
        "boundary ห้าม classify deferred kinds เอง — owner = compiler "
        "(UnansweredNeed.reason='deferred')")


def test_deferred_turn_never_invokes_web_search(monkeypatch):
    """defer ต้องก่อน admission/web — compat need ที่ admissible จริง
    + policy need → web_search_fn ต้องไม่ถูกเรียก (0 calls)."""
    _app, _ = _import_app(monkeypatch)
    web_calls = []
    typed_calls = []
    monkeypatch.setattr(
        llm, "answer_typed",
        lambda **kw: typed_calls.append(kw) or ("x", {}))
    req = _req(rid="req-0", source="relation_target",
               target="galaxy z99 fakephone", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "Cable"), "req-0"))
    out = _app._typed_answer_boundary(
        {"selection": sel, "pool": _pool(), "requests": (req,)},
        needs=(_need_compat(), _need_policy()), profile=_profile(),
        web_search_fn=lambda **kw: web_calls.append(kw) or {},
        web_configured=True)
    assert out["answer_calls"] == 0 and typed_calls == []
    assert web_calls == [], "deferred turn ห้ามเรียก web search"


# ---------------------------------------------------------------------------
# W — web device_specs must reach the final context (producer normalizes
#     search_info + device_specs → closed `payload` field before compile)
# ---------------------------------------------------------------------------

def _web_admissible():
    """compat need + relation_target selected + external target → admitted."""
    need = _need_compat()
    req = _req(rid="req-0", source="relation_target",
               target="galaxy z99 fakephone", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "Cable"), "req-0"))
    return ({"selection": sel, "pool": _pool(), "requests": (req,)},
            (need,))


def test_web_device_specs_only_reach_captured_context(monkeypatch):
    """web result มีแต่ device_specs → specs ต้องถึง ctx + captured
    _generate payload; web 1 call, answer 1 call."""
    _app, _ = _import_app(monkeypatch)
    captured = _capture_generate(monkeypatch)
    web_calls = []
    sel_dict, needs = _web_admissible()

    def _web(**kw):
        web_calls.append(kw)
        return {"search_info": "",
                "device_specs": [{"port": "usb-c", "watt": 25}]}
    out = _app._typed_answer_boundary(
        sel_dict, needs=needs, profile=_profile(),
        web_search_fn=_web, web_configured=True)
    assert len(web_calls) == 1 and out["answer_calls"] == 1
    web_ev = [e for e in out["context"].evidence if e["kind"] == "web"]
    assert len(web_ev) == 1 and web_ev[0]["need_indices"] == (0,), \
        out["context"].evidence
    payload = web_ev[0].get("payload") or ""
    assert "usb-c" in payload and "25" in payload, web_ev
    assert "usb-c" in _payload_text(captured)


def test_web_info_and_specs_survive_in_one_bounded_payload(monkeypatch):
    """search_info + device_specs → payload เดียว bounded; unknown provider
    fields + URL sentinel ไม่ข้าม boundary."""
    _app, _ = _import_app(monkeypatch)
    _capture_generate(monkeypatch)
    sel_dict, needs = _web_admissible()

    def _web(**kw):
        return {"search_info": "found spec sheet https://evil.example/x",
                "device_specs": [{"port": "usb-pd", "watt": 45}],
                "api_key": SENT_EVIDENCE, "provider_trace": SENT_EVIDENCE,
                "url": "https://evil.example/leak"}
    out = _app._typed_answer_boundary(
        sel_dict, needs=needs, profile=_profile(),
        web_search_fn=_web, web_configured=True)
    web_ev = [e for e in out["context"].evidence if e["kind"] == "web"]
    assert len(web_ev) == 1, out["context"].evidence
    payload = web_ev[0].get("payload") or ""
    assert "found spec sheet" in payload and "usb-pd" in payload, payload
    assert SENT_EVIDENCE not in repr(web_ev[0])
    assert "evil.example" not in repr(web_ev[0])
    assert set(web_ev[0]) <= EVIDENCE_OUT_FIELDS
    assert len(payload.encode("utf-8")) <= acx._EVIDENCE_RECORD_BYTES


# ---------------------------------------------------------------------------
# J — single-compile contract: task compile → defer? → admission/web →
#     AnswerContext compile exactly once → answer ≤1
# ---------------------------------------------------------------------------

def _spy_compile(monkeypatch):
    """นับจำนวน compile_answer_task / compile_answer_context ที่ boundary
    ทำต่อ turn (incl. internal call จาก compile เอง)."""
    counts = {"task": 0, "ctx": 0}
    real_task = acx.compile_answer_task
    real_ctx = acx.compile_answer_context

    def _task(**kw):
        counts["task"] += 1
        return real_task(**kw)

    def _ctx(**kw):
        counts["ctx"] += 1
        return real_ctx(**kw)

    monkeypatch.setattr(acx, "compile_answer_task", _task)
    monkeypatch.setattr(acx, "compile_answer_context", _ctx)
    return counts


def test_boundary_has_single_context_compile_call_site(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    src = inspect.getsource(_app._typed_answer_boundary)
    assert src.count("compile_answer_context(") == 1, (
        "one-final-context contract — call site เดียวเท่านั้น")
    assert src.count("compile_answer_task(") == 1


def test_single_compile_product_no_web(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    counts = _spy_compile(monkeypatch)
    ans = []
    monkeypatch.setattr(llm, "answer_typed",
                        lambda **kw: ans.append(kw) or ("a", {}))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection((_sel_card("i:1", "slot", "req-0", "EP"), "req-0"))
    out = _app._typed_answer_boundary(
        {"selection": sel, "pool": _pool(), "requests": (req,)},
        needs=(_need_product(),), profile=_profile(), web_configured=False)
    assert counts == {"task": 1, "ctx": 1}, counts
    assert out["answer_calls"] == 1 and len(ans) == 1


def test_single_compile_web_success(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    counts = _spy_compile(monkeypatch)
    monkeypatch.setattr(llm, "answer_typed", lambda **kw: ("a", {}))
    web_calls = []
    sel_dict, needs = _web_admissible()
    out = _app._typed_answer_boundary(
        sel_dict, needs=needs, profile=_profile(),
        web_search_fn=lambda **kw: web_calls.append(kw)
        or {"search_info": "spec info"}, web_configured=True)
    assert counts == {"task": 1, "ctx": 1}, counts
    assert len(web_calls) == 1 and out["answer_calls"] == 1


def test_single_compile_web_failure(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    counts = _spy_compile(monkeypatch)
    monkeypatch.setattr(llm, "answer_typed", lambda **kw: ("a", {}))
    web_calls = []
    sel_dict, needs = _web_admissible()

    def _web(**kw):
        web_calls.append(kw)
        raise RuntimeError("web down")
    out = _app._typed_answer_boundary(
        sel_dict, needs=needs, profile=_profile(),
        web_search_fn=_web, web_configured=True)
    assert counts == {"task": 1, "ctx": 1}, counts
    assert len(web_calls) == 1 and out["answer_calls"] <= 1


def test_single_compile_policy_only_no_context(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    counts = _spy_compile(monkeypatch)
    web_calls = []
    monkeypatch.setattr(llm, "answer_typed", lambda **kw: ("a", {}))
    out = _app._typed_answer_boundary(
        {"selection": _selection(), "pool": _pool(), "requests": ()},
        needs=(_need_policy(),), profile=_profile(),
        web_search_fn=lambda **kw: web_calls.append(kw) or {},
        web_configured=True)
    assert counts == {"task": 1, "ctx": 0}, counts
    assert web_calls == [] and out["answer_calls"] == 0


def test_single_compile_mixed_no_context(monkeypatch):
    _app, _ = _import_app(monkeypatch)
    counts = _spy_compile(monkeypatch)
    web_calls = []
    monkeypatch.setattr(llm, "answer_typed", lambda **kw: ("a", {}))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection((_sel_card("i:1", "slot", "req-0", "EP"), "req-0"))
    out = _app._typed_answer_boundary(
        {"selection": sel, "pool": _pool(), "requests": (req,)},
        needs=(_need_product(), _need_policy()), profile=_profile(),
        web_search_fn=lambda **kw: web_calls.append(kw) or {},
        web_configured=True)
    assert counts == {"task": 1, "ctx": 0}, counts
    assert web_calls == [] and out["answer_calls"] == 0


# ---------------------------------------------------------------------------
# K — visible task numbering: serialized payload = 1-based งานที่ N
#     (internal need_indices 0-based; no visible task 0 anywhere)
# ---------------------------------------------------------------------------

def test_no_visible_task_zero_in_llm_payload():
    """ทุก visible numbering ต้อง 1-based — products serialized need_indices
    + evidence (งานที่ N) + task render; ไม่มี task 0 หลุดไปถึง LLM."""
    need_a = _need_product(op="recommend", types=("earphone",))
    need_b = _need_compat(refs=("AC65B",), types=("cable",))
    req_a = _req(rid="req-a", types=("earphone",))
    req_b = _req(rid="req-b", source="relation_target",
                 target="galaxy z99 fakephone", types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-a", "Earphone A"), "req-a"),
        (_sel_card("i:2", "relation_target", "req-b", "Cable B"), "req-b"))
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": "galaxy z99 fakephone",
         "data": {"watt": 25}},))
    ctx = _compile((need_a, need_b), sel, pool, (req_a, req_b), _profile())
    txt = ctx.context_text()
    assert "งานที่ 0" not in txt
    for p in _ctx_products(ctx):
        assert all(i >= 1 for i in p["need_indices"]), p


# ---------------------------------------------------------------------------
# L — record-level + rendered-block bounds (payload cap alone is not enough)
# ---------------------------------------------------------------------------

def test_record_structural_overflow_omitted_not_truncated():
    """target/identity metadata เกิน record budget → omit ทั้ง record +
    trace — identity field ห้ามถูกตัดกลายเป็น identity อื่น."""
    big_t = "X" * 5000
    need = TurnNeed(kind="compat", operation="compat",
                    subject_refs=(), product_types=frozenset({"cable"}))
    req = _req(rid="req-0", source="relation_target", target=big_t,
               types=("cable",))
    sel = _selection(
        (_sel_card("i:1", "relation_target", "req-0", "C"), "req-0"))
    pool = _pool(supporting=(
        {"kind": "device_spec", "target": big_t,
         "data": {"watt": 20}},))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    assert ctx.evidence == (), ctx.evidence
    assert any(t.startswith("evidence_dropped:record_too_large")
               for t in ctx.trace), ctx.trace


def test_rendered_evidence_block_within_declared_budget():
    """8 records ~max size → วัด evidence block ที่ context_text() render
    จริง ≤ declared _EVIDENCE_BLOCK_BYTES (ไม่ใช่แค่ payload cap)."""
    need = _need_product(op="describe", refs=("i:1",))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-0", "Earphone X"), "req-0"))
    big = "ข" * (acx._EVIDENCE_RECORD_BYTES * 2)  # over per-record budget
    pool = _pool(
        eligible=(_pooled("i:1", "1", request_ids=("req-0",)),),
        supporting=tuple(
            {"kind": "vision", "subject_refs": ("i:1",),
             "text": big} for _ in range(8)))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    assert len(ctx.evidence) == 8
    txt = ctx.context_text()
    block = txt.split("หลักฐานเพิ่มเติม", 1)[1]
    assert len(block.encode("utf-8")) <= acx._EVIDENCE_BLOCK_BYTES, (
        f"rendered block {len(block.encode('utf-8'))}B exceeds "
        f"{acx._EVIDENCE_BLOCK_BYTES}B")


def test_thai_multibyte_truncation_valid_utf8():
    """Thai payload → byte-boundary cut ยัง decode ได้ (ไม่มี replacement
    char รั่วเข้า LLM context) + truncation trace."""
    need = _need_product(op="describe", refs=("i:1",))
    req = _req(rid="req-0", types=("earphone",))
    sel = _selection(
        (_sel_card("i:1", "slot", "req-0", "Earphone X"), "req-0"))
    thai = "ข้อมูลสเปคพอร์ตชาร์จ" * 800
    pool = _pool(
        eligible=(_pooled("i:1", "1", request_ids=("req-0",)),),
        supporting=({"kind": "vision", "subject_refs": ("i:1",),
                     "text": thai},))
    ctx = _compile((need,), sel, pool, (req,), _profile())
    ev = [e for e in ctx.evidence if e["kind"] == "vision"]
    assert len(ev) == 1
    assert "�" not in ev[0]["payload"]
    assert len(ev[0]["payload"].encode("utf-8")) \
        <= acx._EVIDENCE_RECORD_BYTES
    assert any(t.startswith("evidence_truncated:") for t in ctx.trace)


# ---------------------------------------------------------------------------
# H — offline purity (subprocess traps, fresh interpreter)
# ---------------------------------------------------------------------------

def test_phase7_boundary_path_is_offline():
    """fresh subprocess: trap load_dotenv/MongoClient ก่อน import typed path —
    .env ไม่ถูกเปิดจริง (stub) และไม่สร้าง Mongo connection."""
    probe = r'''
import sys, json
sys.path.insert(0, r"%s")
import dotenv, pymongo
counts = {"dotenv": 0, "mongo": 0}
def _ld(*a, **k):
    counts["dotenv"] += 1
    return False
dotenv.load_dotenv = _ld
class _Trap:
    def __init__(self, *a, **k):
        counts["mongo"] += 1
        raise RuntimeError("mongo blocked")
pymongo.MongoClient = _Trap
from shopeechat import answer_context as acx, turn_decision as td
from shopeechat.retrieval_planner import RetrievalRequest
from shopeechat.retrieval_selection import SelectionResult, SelectedCandidate
from shopeechat.candidate_pool import CandidatePool
need = td.TurnNeed(kind="product", operation="recommend",
                   product_types=frozenset({"earphone"}))
req = RetrievalRequest(request_id="req-0", slot_id="slot-a", source="slot",
                       product_types=frozenset({"earphone"}),
                       subtypes=frozenset(), model_codes=(),
                       target_device=None, availability_mode="",
                       compat_mode="")
sc = SelectedCandidate(role="slot", request_id="req-0", slot_id="s",
                       relation_id=None, identity="i:1", score=1.0,
                       constraint_hits=(), reason="ok",
                       card={"name": "E", "item_id": "1"})
sel = SelectionResult(selected=(sc,), by_request=(("req-0", (sc,)),),
                      unavailable_evidence=(), rejected_summary=())
ctx = acx.compile_answer_context(
    needs=(need,), selection=sel, pool=CandidatePool(
        eligible=(), unavailable=(), rejected=(), by_request=(),
        evidence_pool=(), supporting_evidence=(), trace=()),
    requests=(req,), profile=None)
_ = ctx.context_text()
_ = acx.decide_web_admission(needs=(need,), selection=sel,
                             pool=CandidatePool(
                                 eligible=(), unavailable=(), rejected=(),
                                 by_request=(), evidence_pool=(),
                                 supporting_evidence=(), trace=()),
                             requests=(req,), profile=None,
                             web_configured=False)
import shopeechat.app  # noqa — module import must not touch dotenv/mongo
print(json.dumps(counts))
''' % (str(ROOT / "chatbot"),)
    proc = subprocess.run([sys.executable, "-c", probe],
                          capture_output=True, text=True, timeout=60,
                          env={**os.environ})
    assert proc.returncode == 0, proc.stderr[-2000:]
    counts = json.loads(proc.stdout.strip().splitlines()[-1])
    # real .env ไม่ถูกเปิด (stub คืน False — count นับ stub invocation
    # เท่านั้น ซึ่งพิสูจน์ว่า loader จริงไม่เคยทำงาน) และ Mongo = 0
    assert counts["mongo"] == 0, counts


# ---------------------------------------------------------------------------
# I — cost/context evidence (fixture sample, labeled estimates only)
# ---------------------------------------------------------------------------

def _fixture_card(row: dict) -> dict:
    """normalize catalog row → context-card shape ที่ fetch_products คืน
    (approximation — fixture ขาด enrichment fields ของ production)."""
    models = row.get("model") or []
    price = row.get("gen_price")
    status = row.get("item_status") or "NORMAL"
    stock = sum(int((m.get("stock_info_v2") or {})
                    .get("summary_info", {}).get("total_available_stock")
                    or 0) for m in models)
    return {
        "name": row.get("item_name") or "",
        "shop": row.get("shopname") or "",
        "item_id": row.get("item_id"),
        "price": {"min": price, "max": price} if price is not None else None,
        "short_link": row.get("short_link"),
        "image_url": ((row.get("image") or {}).get("image_url_list")
                      or [None])[0],
        "variants": [{"name": m.get("model_name") or "",
                      "stock": int((m.get("stock_info_v2") or {})
                                   .get("summary_info", {})
                                   .get("total_available_stock") or 0),
                      "price": (((m.get("price_info") or [{}])[0])
                                .get("current_price"))}
                     for m in models],
        "tier_variation": row.get("tier_variation") or [],
        "brand": (row.get("brand") or {}).get("original_brand_name"),
        "category": row.get("cat_name"),
        "status": status,
        "total_stock": stock,
        "model_codes": [m.get("model_sku") for m in models
                        if m.get("model_sku")],
        "raw_description": row.get("description") or "",
        "sellable": status == "NORMAL" and stock > 0,
        "customer_visibility": "visible",
        "weight": row.get("weight"),
        "dimension": row.get("dimension"),
    }


def _p95(xs):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * 0.95))] if xs else 0


def _median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else 0


def test_cost_context_evidence_fixture_sample(monkeypatch):
    """fixture turns → complete `_generate` payload capture BOTH paths
    (legacy `llm.answer` vs Phase-7 `llm.answer_typed`) offline — วัด
    product-context แยกจาก complete input prompt (system+contents) —
    labeled fixture estimates เท่านั้น ไม่ใช่ production p95."""
    import shopeechat.retrieval_selection as rsel
    captured = _capture_generate(monkeypatch)

    def _prompt_tokens():
        """est tokens ของ complete input payload ที่ _generate ได้รับจริง
        (system_instruction + ทุก text part ใน contents)."""
        texts = [p.get("text", "")
                 for c in captured.get("contents") or ()
                 for p in c.get("parts") or ()]
        return (acx.estimate_tokens(captured.get("system") or "")
                + sum(acx.estimate_tokens(t) for t in texts))

    rows = []
    for line in FIXTURES.read_text().splitlines():
        fx = json.loads(line)
        cat = [_fixture_card(c) for c in fx.get("catalog") or ()]
        if not cat:
            continue
        for turn in fx.get("turns") or ():
            text = turn.get("text") or ""
            if not text:
                continue
            plan = td.decide_turn(text, history=[],
                                  intent_result=fx.get("intent_result") or {})
            prodish = [n for n in plan.needs
                       if n.kind in td.PRODUCTISH_NEED_KINDS]
            if not prodish:
                continue
            # ── legacy complete prompt: real llm.answer (offline capture)
            captured.clear()
            llm.answer(message=text, products=cat[:30],
                       shop_hint=fx.get("shop"), history=[],
                       intent_result=fx.get("intent_result") or {})
            legacy_prompt = _prompt_tokens()
            # product-context-only number (same estimator, same turn)
            legacy_ctx = acx.estimate_tokens(llm._build_context(
                cat[:30], shop_hint=fx.get("shop"),
                include_description=True))
            # ── phase7: typed artifacts จาก cards เดียวกัน
            scope = sorted({t for n in prodish
                            for t in (n.product_types or ())}
                           | {s for n in prodish
                              for s in (n.subtypes or ())})
            req = _req(rid="req-0", types=tuple(scope) or ("earphone",))
            sels = []
            pooled = []
            for c in cat:
                key, _dom = cpool._identity_key(c)
                if not key:
                    continue
                sels.append(rsel.SelectedCandidate(
                    role="slot", request_id="req-0", slot_id="s",
                    relation_id=None, identity=key, score=1.0,
                    constraint_hits=(), reason="ok", card=c))
                pooled.append(cpool.PooledCandidate(
                    identity=key,
                    item_id=str(c.get("item_id") or ""),
                    model_id=None, unit_id=None, sources=("legacy",),
                    request_ids=("req-0",), slot_id="s", relation_id=None,
                    product_type=None, subtype=None, bucket="eligible",
                    reason="ok", score=1.0, trace=(), card=c))
            sel = rsel.SelectionResult(
                selected=tuple(sels), by_request=(("req-0", tuple(sels)),),
                unavailable_evidence=(), rejected_summary=(), trace=())
            pool = _pool(eligible=tuple(pooled))
            ctx = _compile(tuple(plan.needs), sel, pool, (req,),
                           _profile(text))
            captured.clear()
            llm.answer_typed(context=ctx, shop_hint=fx.get("shop"))
            phase7_prompt = _prompt_tokens()
            rows.append((legacy_ctx, ctx.estimated_tokens,
                         legacy_prompt, phase7_prompt))
    assert rows, "fixture sample must be non-empty"
    legacy_ctx = [r[0] for r in rows]
    phase7_ctx = [r[1] for r in rows]
    legacy_in = [r[2] for r in rows]
    phase7_in = [r[3] for r in rows]
    sys_toks = acx.estimate_tokens(llm.SYSTEM_INSTRUCTION)
    output_est = 300  # fixed conservative output estimate (ไม่มี production truth)
    cost_legacy = llm._gemini_cost(_p95(legacy_in), output_est) * 36
    cost_phase7 = llm._gemini_cost(_p95(phase7_in), output_est) * 36
    report = {
        "sample_turns": len(rows),
        # product-context only (46.6% ของรอบก่อน = เมตริกนี้)
        "legacy_ctx_median": _median(legacy_ctx),
        "legacy_ctx_p95": _p95(legacy_ctx),
        "phase7_ctx_median": _median(phase7_ctx),
        "phase7_ctx_p95": _p95(phase7_ctx),
        "ctx_p95_reduction_pct": round(
            (1 - (_p95(phase7_ctx) / _p95(legacy_ctx))) * 100, 1)
        if _p95(legacy_ctx) else 0,
        # complete input prompt (system+contents ที่ _generate รับจริง)
        "legacy_prompt_median": _median(legacy_in),
        "legacy_prompt_p95": _p95(legacy_in),
        "phase7_prompt_median": _median(phase7_in),
        "phase7_prompt_p95": _p95(phase7_in),
        "prompt_p95_reduction_pct": round(
            (1 - (_p95(phase7_in) / _p95(legacy_in))) * 100, 1)
        if _p95(legacy_in) else 0,
        "system_prompt_tokens_est": sys_toks,
        "est_cost_p95_thb_legacy": round(cost_legacy, 4),
        "est_cost_p95_thb_phase7": round(cost_phase7, 4),
        "est_cost_p95_diff_thb": round(cost_legacy - cost_phase7, 4),
    }
    print("\n[PHASE7-COST] " + json.dumps(report, ensure_ascii=False))
    # gates (fixture-sample estimates เท่านั้น — ไม่ใช่ production p95;
    # total-prompt reduction มีแค่ report ไม่ตั้ง threshold — system prompt
    # ใหญ่และ share กันทั้งสองฝั่ง)
    assert report["ctx_p95_reduction_pct"] >= 30, report
    assert report["est_cost_p95_thb_phase7"] < 1.0, report
