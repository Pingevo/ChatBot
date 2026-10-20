"""answer_context.py — Phase 7: bounded typed answer boundary (compiler owner เดียว).

Input = typed Phase-6 artifacts เท่านั้น (TurnNeed / SelectionResult /
CandidatePool / RetrievalRequest / RetrievalProfile) — ไม่เคยอ่าน customer
prose/history, ไม่ parse, ไม่มี semantic keyword table:

  needs + selection + pool + requests + profile
      → AnswerTask (NeedTask ต่อ productish need — closed-template render)
      → AnswerContext {task, products, evidence, availability_notes,
                       unanswered_needs, estimated_tokens, trace}

products contract: ทุก product card ถูก stamp `need_indices` (typed need
ownership — serialize เข้า payload จริงผ่าน context_text); identity เดียว
ข้ามหลาย need → union indices ลง card เดิม (ไม่เพิ่ม payload)

evidence contract (closed schema — ไม่ copy arbitrary dicts):
  kinds = device_spec|kb|kb_product|vision|image_text|video|web +
          attachment kinds (anchor|listing|subject_snapshot)
  ทุก record ต้อง attribute ได้ด้วย typed fields เท่านั้น:
  need_index/need_indices · request_id→needs_for_request · target→need
  target · subject_refs/identity/linked_candidate/item_id→pool identity
  map — record ที่ prove ไม่ได้ว่าของ need ไหนถูก omit + trace
  `evidence_dropped:*` ทุกครั้ง (ห้ามเดา)
  emitted fields ปิด = {kind, need_indices, target?, identity?,
  linked_candidate?, item_id?, payload?} — unknown fields ไม่ข้าม;
  serialized record ทั้งก้อน ≤ _EVIDENCE_RECORD_BYTES (structural fields
  เกิน budget → omit ทั้ง record + evidence_dropped:record_too_large —
  identity ห้ามถูกตัด); payload ตัดที่ byte boundary ให้พอดี budget +
  evidence_truncated:* trace; rendered evidence block ≤
  _EVIDENCE_BLOCK_BYTES

web gate = decide_web_admission() — pre-answer, typed, deny-by-default:
admit เฉพาะเมื่อ productish need เดียวยังขาด external evidence จริง —
ต้องมี resolved local identity (subject_refs resolve ใน pool หรือมี
selected candidate ที่ attribute กลับ need นั้น) + typed external target
+ local pool evidence ไม่มี spec/web record ของ target นั้น + web ยังไม่
เคยถูก supply + configured. selected card = identity evidence เท่านั้น —
ไม่ใช่ spec/compat coverage. admission decide จาก pool/context evidence
ที่ produce แล้วเท่านั้น — ห้าม re-run spec resolver หรือ retrieval.

policy/claim/order/troubleshoot needs = deferred kinds — Phase 7 product
context ไม่ consume policy decisions (composition = Phase 8 owner).
deferred-kind classification owner เดียว = compile_answer_task (typed
`AnswerTask.deferred`) — boundary defer ก่อน AnswerContext compile
เสมอ (deferred turn: task compile 1, context compile 0, web 0, answer 0).

token estimate = ceil(utf8_bytes / 3) — conservative labeled-estimate
(Thai ~3B/char ⇒ ≥1 token/char bound), system prompt วัดแยกฝั่ง llm.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Literal

from .retrieval_planner import RetrievalRequest
from .retrieval_selection import (
    META_HINT_KEYS, ROLE_RANK, SelectionResult, needs_for_request)
from .candidate_pool import CandidatePool
from .turn_decision import PRODUCTISH_NEED_KINDS

# bounds — products ต่อ need แล้ว hard cap รวม; evidence bounded ทั้ง
# count + per-record serialized bytes (ทั้ง record ไม่ใช่แค่ payload —
# structural metadata เกิน budget → omit + trace, ห้ามตัด identity) และ
# declared rendered-block bound ที่ context_text() render จริง
PER_NEED_LIMIT = 4
HARD_CAP = 15
EVIDENCE_LIMIT = 8
_EVIDENCE_RECORD_BYTES = 1500   # serialized record cap (structural+payload)
# rendered block ≤ count cap × record cap + line markers + section header
_EVIDENCE_BLOCK_BYTES = EVIDENCE_LIMIT * _EVIDENCE_RECORD_BYTES + 256

LOCAL_FACT_OPS = frozenset({"price", "stock", "link"})
_POLICY_NEED_KINDS = frozenset({"policy", "claim", "order", "troubleshoot"})

# deterministic customer reply เมื่อ flag-ON pipeline ไม่มี typed product
# context (compile fail / selection none / context ว่าง / deferred needs)
# — zero answer-model call
EMPTY_CONTEXT_REPLY = (
    "ขออภัยค่ะ ตอนนี้ระบบหาข้อมูลสินค้าที่ตรงกับคำถามไม่ได้ "
    "ทักแอดมินให้ช่วยตรวจสอบเพิ่มเติมได้เลยนะคะ")

# card fields ที่เข้า customer context — closed set; desc หนักเฉพาะ op ที่ต้อง
# (recommend/price/link/stock = slim เสมอ — ตัด full-desc-per-product เดิม)
_BASE_CARD_FIELDS = frozenset({
    "name", "shop", "price", "warranty", "short_link", "image_url",
    "has_promotion", "is_flash_sale", "variants", "tier_variation",
    "brand", "category", "sold_out", "total_stock", "status",
    "catalog_status", "_available_for_sale", "sellable",
    "canonical_specs", "kb_specs", "kb_highlights", "kb_box_contents",
    "kb_description", "_source", "oos_in_name", "has_description",
    "has_warranty_info", "requested_variant_state",
})
_DESC_OPS = frozenset({"describe", "compare", "compat", "lookup", "collect"})
_DESC_FIELDS = frozenset({"description_excerpt", "weight", "dimension"})

# closed evidence schema — kinds ที่เข้า product context ได้เท่านั้น
_SUPPORTING_KINDS = frozenset({
    "device_spec", "kb", "kb_product", "vision", "image_text",
    "video", "web",
})
_ATTACHMENT_KINDS = frozenset({
    "anchor", "kb_product", "image_text", "listing", "subject_snapshot",
})
_EVIDENCE_KINDS = _SUPPORTING_KINDS | _ATTACHMENT_KINDS

# emitted evidence record = closed FIELD schema — ทุกอย่างนอก set นี้
# ไม่ข้าม boundary (unknown fields/diagnostics/prose blobs ถูกทิ้งตอน
# compile — ไม่ใช่ sanitizer แยก แต่เป็น emit contract ของ compiler)
_EVIDENCE_OUT_FIELDS = frozenset({
    "kind", "need_indices", "target", "identity",
    "linked_candidate", "item_id", "payload",
})
# producer text keys ที่ normalize เข้า payload เดียว (precedence เดิม)
_EVIDENCE_TEXT_KEYS = ("payload", "data", "text", "search_info",
                       "results")

# role → context note (semantics ย้ายมาจาก retrieval_runtime — owner ใหม่)
_ROLE_NOTE = {
    "subject": "สินค้าที่ลูกค้าถามถึงหรืออ้างอิงโดยตรง",
    "slot": "สินค้าที่ลูกค้าถามถึงหรืออ้างอิงโดยตรง",
    "alternative": "สินค้าแนะนำทดแทน — ไม่ใช่รุ่นที่ลูกค้าถามถึงโดยตรง "
                   "ให้บอกว่าเป็นรุ่นทดแทน",
    "relation_target": "สินค้าที่ใช้ร่วมกันได้ตามความสัมพันธ์ของคำถาม",
}

# closed render templates keyed by typed operation เท่านั้น (generation —
# ไม่ใช่ extraction/keyword matching)
_OP_PHRASE = {
    "price": "ตอบราคา",
    "link": "ให้ลิงก์สินค้า",
    "stock": "ตอบสถานะสต็อก/การมีจำหน่าย",
    "describe": "อธิบายรายละเอียด/สเปค",
    "compare": "เปรียบเทียบ",
    "recommend": "แนะนำสินค้าที่ตรงเงื่อนไข",
    "compat": "ตอบความเข้ากันได้",
    "lookup": "ตอบข้อมูล",
    "collect": "ตอบคำถามเกี่ยวกับสินค้า",
}

WebAdmissionReason = Literal[
    "admitted_external_evidence_need",
    "no_productish_need", "covered", "local_fact_operation",
    "local_catalog_existence", "unresolved_local_identity",
    "no_external_target", "local_evidence_sufficient",
    "web_already_supplied", "not_configured", "internal_error",
]


# ── typed task contract ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class NeedTask:
    """productish need หนึ่งรายการ — compiled จาก typed fields เท่านั้น."""
    kind: str                                    # product|compare|compat
    operation: str                               # TurnNeedOp verbatim
    need_index: int = -1                         # index ใน needs tuple เดิม
    subject_names: tuple[str, ...] = ()          # resolved card names (DB)
    subject_refs: tuple[str, ...] = ()           # structured refs verbatim
    scope: tuple[str, ...] = ()                  # product_types ∪ subtypes
    constraints: tuple[tuple[str, str], ...] = ()  # typed pairs only
    value_constraints: tuple[tuple[str, int], ...] = ()  # profile owner
    target: str | None = None                    # external device/relation tgt
    ranking: tuple[str, str] | None = None


@dataclass(frozen=True)
class AnswerTask:
    """sole instruction contract ของ grouped answer path — render deterministic
    จาก typed fields เท่านั้น (closed template ต่อ kind/operation).
    `deferred` = typed signal ว่า turn มี deferred needs (owner เดียวของ
    deferred-kind classification — boundary consume โดยตรง ไม่ classify
    kind string เอง; compile_answer_context seed เข้า unanswered_needs)."""
    tasks: tuple[NeedTask, ...] = ()
    deferred: tuple[UnansweredNeed, ...] = ()
    trace: tuple[str, ...] = ()

    def render(self) -> str:
        lines: list[str] = []
        for i, t in enumerate(self.tasks, 1):
            parts = [f"งานที่ {i}:",
                     _OP_PHRASE.get(t.operation, "ตอบคำถามเกี่ยวกับสินค้า")]
            what = t.subject_names or t.subject_refs or t.scope
            if what:
                parts.append("ของ " + " / ".join(what))
            if t.target:
                parts.append(f"ใช้กับ {t.target}")
            parts += [f"({k}={v})" for k, v in t.constraints]
            parts += [
                (f"งบขั้นต่ำ {v} บาท" if k == "price_min"
                 else f"งบไม่เกิน {v} บาท")
                for k, v in t.value_constraints]
            if t.ranking:
                parts.append(f"เรียงตาม {t.ranking[0]} "
                             f"{'มากสุด' if t.ranking[1] == 'max' else 'น้อยสุด'}")
            lines.append(" ".join(parts))
        return "\n".join(lines)


@dataclass(frozen=True)
class UnansweredNeed:
    need_index: int
    kind: str
    operation: str
    subject_refs: tuple[str, ...]
    scope: tuple[str, ...]
    target: str | None
    reason: Literal["no_selection", "deferred"]


@dataclass(frozen=True)
class WebAdmission:
    allowed: bool
    reason: WebAdmissionReason
    need_index: int | None = None
    query: str = ""                 # deterministic render จาก typed fields
    target: str = ""


@dataclass(frozen=True)
class AnswerContext:
    """bounded product-answer payload — sole input ของ llm.answer_typed."""
    task: AnswerTask
    products: tuple[dict, ...]
    evidence: tuple[dict, ...]
    availability_notes: tuple[dict, ...]
    unanswered_needs: tuple[UnansweredNeed, ...]
    estimated_tokens: int           # ceil(utf8_bytes/3) — estimate เท่านั้น
    trace: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not (self.products or self.evidence
                    or self.availability_notes)

    def context_text(self, shop_hint: str | None = None) -> str:
        """serialize products+evidence+notes เป็น prompt context —
        task ไม่เข้า product context (render แยกเป็น instruction)."""
        header = "ข้อมูลสินค้าที่เกี่ยวข้อง (จาก MongoDB ของร้านในเครือ):\n"
        if shop_hint:
            header += (
                f"ลูกค้าทักจากร้าน: {shop_hint}\n"
                f"⚠️ สำคัญอย่างยิ่ง: ลูกค้าทักเข้ามาที่ร้าน {shop_hint} โดยเฉพาะ "
                f"ให้ตอบเฉพาะสินค้าจากร้าน {shop_hint} เท่านั้น "
                f"ห้ามเสนอ/แนะนำ/เปรียบเทียบสินค้าจากร้านอื่นในเครือเด็ดขาด\n")
        header += f"จำนวนสินค้าใน context: {len(self.products)}\n\n"
        if self.products:
            # visible numbering = 1-based งานที่ N เดียวกับ task/evidence
            # render — internal need_indices ยัง 0-based; translate เฉพาะ
            # serialized copy (canonical card ไม่ถูก mutate)
            body = json.dumps(
                [{**p, "need_indices": [i + 1 for i in p["need_indices"]]}
                 if p.get("need_indices") else p
                 for p in self.products],
                ensure_ascii=False, indent=2)
        else:
            body = ("ไม่พบข้อมูลสินค้าที่ตรงกับคำถามในระบบค้นหา\n"
                    "ห้ามสรุปว่าสินค้าหมดสต็อก เลิกขาย หรือไม่มีจำหน่าย "
                    "ให้บอกลูกค้าว่าไม่พบข้อมูลรุ่นนี้ในระบบ")
        out = header + body
        if self.evidence:
            ev_lines = []
            for e in self.evidence:
                kind = e.get("kind", "evidence")
                ords = "+".join(str(i + 1)
                                for i in e.get("need_indices") or ())
                tgt = e.get("target") or e.get("identity") or ""
                ev_lines.append(
                    f"- [{kind}](งานที่ {ords}) {tgt} "
                    f"{e.get('payload') or ''}".strip())
            out += "\n\nหลักฐานเพิ่มเติม (typed evidence):\n" + "\n".join(
                ev_lines)
        if self.availability_notes:
            names = [str(u.get("name") or "") for u in self.availability_notes
                     if u.get("name")]
            if names:
                out += ("\n\nหมายเหตุ: พบสินค้าที่เกี่ยวข้องในร้านแต่ยังไม่"
                        "พร้อมจำหน่าย (หมดสต็อก/เลิกขาย/ถูกลบ) — "
                        "ใช้เป็นข้อมูลเท่านั้น ห้ามแนะนำเป็นสินค้าที่ซื้อได้: "
                        + ", ".join(dict.fromkeys(names)))
        return out


# ── helpers ─────────────────────────────────────────────────────────────────

def estimate_tokens(text: str) -> int:
    """conservative token estimate — ceil(utf8 bytes / 3).
    labeled estimate เท่านั้น (Thai ~3B/char → ประมาณ ≥1 token/char upper bound;
    ASCII → overestimate ~33%)."""
    return math.ceil(len((text or "").encode("utf-8")) / 3)


def _norm_ref(v) -> str:
    return str(v or "").strip().upper()


def _norm_target(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip().lower()


def _req_needs_map(requests: tuple, needs: tuple) -> dict[str, tuple]:
    return {r.request_id: needs_for_request(r, needs) for r in requests}


def _need_requests(need, requests, req_needs) -> list[RetrievalRequest]:
    return [r for r in requests if need in req_needs.get(r.request_id, ())]


def _need_scope(need) -> tuple[str, ...]:
    return tuple(sorted(
        set(need.product_types or ()) | set(need.subtypes or ())))


def _need_target(need, reqs, profile) -> str | None:
    for r in reqs:
        if r.target_device:
            return r.target_device
    if need.kind == "compat":
        return getattr(profile, "target_device", None)
    return None


def _cand_keys(identity, item_id, model_id, card) -> set[str]:
    """normalized identity aliases ของ candidate — ใช้ join evidence
    records/attachments กลับ need ผ่าน request_ids (attribution เดิม
    ของ pool — ไม่สร้าง owner ใหม่)"""
    keys = {_norm_ref(identity)}
    if item_id:
        keys.add(_norm_ref(f"i:{item_id}"))
        keys.add(_norm_ref(item_id))
    if model_id:
        keys.add(_norm_ref(model_id))
    for m in (card or {}).get("model_codes") or ():
        keys.add(_norm_ref(m))
    return {k for k in keys if k}


def _ref_needs_map(needs, requests, selection, pool,
                   prodish_idx) -> dict[str, set[int]]:
    """normalized identity/ref → need indices — typed attribution owner
    เดียว: needs_for_request (request→need) + TurnNeed.subject_refs +
    pool candidate request_ids; ไม่ parse prose เพื่อเดา attribution"""
    idx_of = {id(n): i for i, n in enumerate(needs)}
    req_needs = _req_needs_map(requests, needs)
    by_req = dict(selection.by_request)
    out: dict[str, set[int]] = {}

    def _link(key, i):
        if key and i in prodish_idx:
            out.setdefault(key, set()).add(i)

    for i, n in enumerate(needs):
        if i in prodish_idx:
            for r in n.subject_refs or ():
                _link(_norm_ref(r), i)
    for rid, neds in req_needs.items():
        for n2 in neds:
            i = idx_of.get(id(n2))
            if i is None:
                continue
            for s in by_req.get(rid, ()) or ():
                for k in _cand_keys(s.identity, s.card.get("item_id"),
                                    s.card.get("model_id"), s.card):
                    _link(k, i)
    for c in tuple(pool.eligible or ()) + tuple(pool.unavailable or ()) \
            + tuple(pool.rejected or ()):
        keys = _cand_keys(c.identity, c.item_id, c.model_id, c.card)
        for rid in c.request_ids or ():
            for n2 in req_needs.get(rid, ()):
                i = idx_of.get(id(n2))
                if i is None:
                    continue
                for k in keys:
                    _link(k, i)
    return out


def _attribute(e: dict, *, req_needs, idx_of, prodish_idx,
               target_of, ref_needs) -> tuple[int, ...]:
    """typed attribution เท่านั้น — need_index/need_indices ·
    request_id→needs_for_request · target→need target ·
    subject_refs/identity/linked_candidate/item_id→identity map;
    ไม่มี → () (caller omit + trace, ห้ามเดา)"""
    idxs: set[int] = set()
    ni = e.get("need_index")
    if isinstance(ni, int):
        idxs.add(ni)
    for v in e.get("need_indices") or ():
        if isinstance(v, int):
            idxs.add(v)
    rid = e.get("request_id")
    if rid:
        idxs.update(idx_of[id(n2)] for n2 in req_needs.get(rid, ())
                    if id(n2) in idx_of)
    tgt = _norm_target(e.get("target"))
    if tgt:
        idxs.update(i for i in prodish_idx
                    if _norm_target(target_of.get(i)) == tgt)
    keys = {_norm_ref(v) for v in e.get("subject_refs") or ()}
    keys.add(_norm_ref(e.get("identity")))
    keys.add(_norm_ref(e.get("linked_candidate")))
    if e.get("item_id") is not None:
        keys.add(_norm_ref(f"i:{e['item_id']}"))
        keys.add(_norm_ref(e["item_id"]))
    for k in keys:
        if k:
            idxs.update(ref_needs.get(k, ()))
    return tuple(sorted(idxs & prodish_idx))


def _compile_evidence(pool: CandidatePool, web_evidence: tuple, *,
                      req_needs, idx_of, prodish_idx, target_of,
                      ref_needs, trace: list) -> list[dict]:
    """closed-schema evidence — typed-attributed records เท่านั้น;
    emit เฉพาะ `_EVIDENCE_OUT_FIELDS` (kind ผ่านแล้ว แต่ field นอก schema
    ไม่ข้าม); text payload normalize → `payload` เดียว; serialized record
    ทั้งก้อน bounded ≤ `_EVIDENCE_RECORD_BYTES` — structural fields
    (target/identity/...) เกิน budget → omit record + trace (identity
    ห้ามถูกตัด), payload ตัดที่ byte boundary ให้พอดี remaining budget +
    trace; raw prose blobs ไม่มีวันเข้า."""
    out: list[dict] = []

    def _take(e, kind, idxs):
        rec = {"kind": kind, "need_indices": tuple(idxs)}
        for k in _EVIDENCE_OUT_FIELDS - {
                "kind", "need_indices", "payload"}:
            v = e.get(k)
            if v not in (None, "", ()):
                rec[k] = v
        # structural fields alone เกิน record budget → omit ทั้ง record
        # (identity ตัดไม่ได้ — ตัดแล้วกลายเป็น identity อื่นเงียบๆ)
        struct_b = len(json.dumps(rec, ensure_ascii=False,
                                  default=str).encode("utf-8"))
        if struct_b >= _EVIDENCE_RECORD_BYTES:
            trace.append(
                f"evidence_dropped:record_too_large kind={kind} "
                f"struct_bytes={struct_b}")
            return
        v = None
        for k in _EVIDENCE_TEXT_KEYS:
            cand = e.get(k)
            if cand not in (None, "", (), [], {}):
                v = cand
                break
        # dict payload: producers ใส่ text ใน {"text": ...} — emit เฉพาะ
        # text นั้น (field contract ของ producer เอง — ไม่ใช่ semantic
        # match); dict อื่น (spec/data) → dumps ทั้งก้อน
        if isinstance(v, dict):
            t = v.get("text")
            v = t if isinstance(t, str) and t else json.dumps(
                v, ensure_ascii=False, default=str)
        elif isinstance(v, (list, tuple)):
            v = json.dumps(v, ensure_ascii=False, default=str)
        s = str(v or "")
        if s:
            rec["payload"] = s
            orig_b = len(s.encode("utf-8"))
            # ตัด payload ให้ serialized record พอดี budget — byte-prefix
            # cut; json escaping อาจ inflate ซ้ำ → วัดจริงทุกรอบ (keep
            # ลด strictly → terminate; deterministic; trace เสมอ)
            while True:
                total_b = len(json.dumps(rec, ensure_ascii=False,
                                         default=str).encode("utf-8"))
                if total_b <= _EVIDENCE_RECORD_BYTES:
                    break
                pb = rec["payload"].encode("utf-8")
                keep = len(pb) - (total_b - _EVIDENCE_RECORD_BYTES)
                if keep <= 0:
                    del rec["payload"]
                    trace.append(
                        f"evidence_truncated:kind={kind} "
                        f"payload_dropped bytes={orig_b}→0")
                    break
                rec["payload"] = pb[:keep].decode("utf-8", "ignore")
                if len(rec["payload"].encode("utf-8")) == len(pb):
                    break  # cut ไม่ลด (ไม่ควรเกิด) — กัน loop ค้าง
            if "payload" in rec and len(
                    rec["payload"].encode("utf-8")) != orig_b:
                trace.append(
                    f"evidence_truncated:kind={kind} "
                    f"payload_bytes={orig_b}→"
                    f"{len(rec['payload'].encode('utf-8'))}")
        out.append(rec)

    for e in pool.supporting_evidence or ():
        kind = e.get("kind") if isinstance(e, dict) else None
        if kind not in _EVIDENCE_KINDS:
            trace.append(f"evidence_dropped:kind={kind!r}")
            continue
        idxs = _attribute(e, req_needs=req_needs, idx_of=idx_of,
                          prodish_idx=prodish_idx, target_of=target_of,
                          ref_needs=ref_needs)
        if not idxs:
            trace.append(f"evidence_dropped:unattributed kind={kind}")
            continue
        _take(e, kind, idxs)
    for att in pool.evidence_pool or ():
        if att.kind not in _ATTACHMENT_KINDS:
            trace.append(f"evidence_dropped:attach_kind={att.kind!r}")
            continue
        rec = {"kind": att.kind, "identity": att.identity,
               "linked_candidate": att.linked_candidate,
               "item_id": att.item_id, "payload": att.payload}
        idxs = _attribute(rec, req_needs=req_needs, idx_of=idx_of,
                          prodish_idx=prodish_idx, target_of=target_of,
                          ref_needs=ref_needs)
        if not idxs:
            trace.append(f"evidence_dropped:unattributed kind={att.kind}")
            continue
        _take(rec, att.kind, idxs)
    for e in web_evidence or ():
        kind = e.get("kind") if isinstance(e, dict) else None
        if kind != "web":
            trace.append(f"evidence_dropped:kind={kind!r}")
            continue
        idxs = _attribute(e, req_needs=req_needs, idx_of=idx_of,
                          prodish_idx=prodish_idx, target_of=target_of,
                          ref_needs=ref_needs)
        if not idxs:
            trace.append(f"evidence_dropped:unattributed kind=web")
            continue
        _take(e, kind, idxs)
    return out[:EVIDENCE_LIMIT]


def compile_answer_task(*, needs: tuple, selection: SelectionResult,
                        requests: tuple, pool: CandidatePool,
                        profile) -> AnswerTask:
    """needs → AnswerTask — typed fields เท่านั้น (ไม่แตะ customer prose).
    owner เดียวของ deferred-kind classification: non-productish need ใน
    _POLICY_NEED_KINDS → typed `deferred` entries (boundary/compile
    consume signal นี้ — ไม่มีการ classify kind string ที่อื่น)."""
    tasks: list[NeedTask] = []
    deferred: list[UnansweredNeed] = []
    trace: list[str] = []
    req_needs = _req_needs_map(requests, needs)
    by_req = dict(selection.by_request)
    vc = tuple(getattr(profile, "value_constraints", ()) or ())
    for i, n in enumerate(needs):
        if n.kind not in PRODUCTISH_NEED_KINDS:
            if n.kind in _POLICY_NEED_KINDS:
                deferred.append(UnansweredNeed(
                    i, n.kind, n.operation, tuple(n.subject_refs or ()),
                    _need_scope(n), None, "deferred"))
            continue
        reqs_n = _need_requests(n, requests, req_needs)
        cands = [s for r in reqs_n for s in by_req.get(r.request_id, ())]
        subject_names = tuple(dict.fromkeys(
            (s.card.get("name") or "").strip() for s in cands
            if s.role == "subject" and (s.card.get("name") or "").strip()))
        cons: list[tuple[str, str]] = []
        seen: set = set()
        for r in reqs_n:
            for k, v in r.hard_filters:
                if (k, v) not in seen:
                    seen.add((k, v))
                    cons.append((k, v))
            for k, v in r.soft_hints:
                if k in META_HINT_KEYS or (k, v) in seen:
                    continue
                seen.add((k, v))
                cons.append((k, v))
            for v in r.variant_terms or ():
                kv = ("variant", v)
                if kv not in seen:
                    seen.add(kv)
                    cons.append(kv)
        tasks.append(NeedTask(
            kind=n.kind, operation=n.operation, need_index=i,
            subject_names=subject_names,
            subject_refs=tuple(n.subject_refs or ()),
            scope=_need_scope(n),
            constraints=tuple(cons),
            value_constraints=vc,
            target=_need_target(n, reqs_n, profile),
            ranking=n.ranking))
        trace.append(f"task[{i}] {n.kind}/{n.operation} "
                     f"reqs={[r.request_id for r in reqs_n]}")
    return AnswerTask(tasks=tuple(tasks), deferred=tuple(deferred),
                      trace=tuple(trace))


def _scope_card(card: dict, need, role: str) -> dict:
    """field-scope ตาม operation ของ need + role note (hidden never passes —
    caller skip ก่อนแล้ว แต่กันซ้ำที่นี่อีกชั้น)."""
    if card.get("customer_visibility") == "hidden":
        return {}
    allowed = _BASE_CARD_FIELDS | (
        _DESC_FIELDS if need.operation in _DESC_OPS else frozenset())
    out = {k: card[k] for k in card if k in allowed}
    note = _ROLE_NOTE.get(role)
    if note:
        out["_context_note"] = note
    if role == "subject" and not card.get("sellable", False):
        out["_context_note"] = (
            f"{note or ''} — สินค้านี้ยังไม่พร้อมจำหน่าย "
            "(หมดสต็อก/เลิกขาย/ถูกลบ) ให้แจ้งสถานะตรงๆ "
            "ห้ามบอกว่าซื้อได้หรือส่งลิงค์ซื้อ").strip()
    return out


def compile_answer_context(*, needs: tuple, selection: SelectionResult,
                           pool: CandidatePool, requests: tuple, profile,
                           task: AnswerTask | None = None,
                           web_evidence: tuple = (),
                           per_need_limit: int = PER_NEED_LIMIT,
                           hard_cap: int = HARD_CAP) -> AnswerContext:
    """typed pipeline output → bounded AnswerContext (ครั้งเดียวต่อ turn).

    - products: per-need quota → identity dedupe → hard cap; เฉพาะ
      attributed selected (canonical owner: needs_for_request); role
      precedence subject>relation_target>historical>alternative>slot;
      hidden/unavailable ไม่มีวันเป็น recommendation
    - evidence: closed-schema + typed-attributed records เท่านั้น
      (supporting/evidence_pool/web) — unattributed → omit + trace
    - unanswered_needs: productish need ไร้ coverage + task.deferred
      (deferred-kind classification = owner เดียว compile_answer_task)
    """
    task = task or compile_answer_task(
        needs=needs, selection=selection, requests=requests, pool=pool,
        profile=profile)
    req_needs = _req_needs_map(requests, needs)
    by_req = dict(selection.by_request)
    prodish_idx = {i for i, n in enumerate(needs)
                   if n.kind in PRODUCTISH_NEED_KINDS}
    idx_of = {id(n): i for i, n in enumerate(needs)}
    target_of: dict[int, str | None] = {}
    products: list[dict] = []
    emitted: dict[str, dict] = {}   # identity → card ที่อยู่ใน payload
    unanswered: list[UnansweredNeed] = list(task.deferred)
    trace: list[str] = []
    for i, n in enumerate(needs):
        scope = tuple(sorted(set(n.product_types or ())
                             | set(n.subtypes or ())))
        if n.kind not in PRODUCTISH_NEED_KINDS:
            continue   # deferred จัดการแล้วบน task (classification owner เดียว)
        reqs_n = _need_requests(n, requests, req_needs)
        target_of[i] = _need_target(n, reqs_n, profile)
        cands = [s for r in reqs_n for s in by_req.get(r.request_id, ())]
        cands.sort(key=lambda s: (ROLE_RANK.get(s.role, 0), s.score),
                   reverse=True)
        if not cands:
            unanswered.append(UnansweredNeed(
                i, n.kind, n.operation, tuple(n.subject_refs or ()),
                scope, target_of[i], "no_selection"))
            continue
        took = 0
        for s in cands:
            prev = emitted.get(s.identity)
            if prev is not None:
                # identity เดียวถูกเลือกให้หลาย need → union ownership
                # ลง card ใบเดิม (ไม่เพิ่ม payload; quota ไม่กั้น union)
                if i not in prev["need_indices"]:
                    prev["need_indices"] = tuple(sorted(
                        set(prev["need_indices"]) | {i}))
                    trace.append(
                        f"need[{i}] union {s.identity} → "
                        f"need_indices={prev['need_indices']}")
                continue
            if took >= per_need_limit or len(products) >= hard_cap:
                continue  # intake ใหม่ถูก quota/cap กั้น — union ยังทำได้
            card = _scope_card(s.card, n, s.role)
            if not card:
                continue  # hidden — ห้ามเข้า products
            card["need_indices"] = (i,)   # structural task ownership
            emitted[s.identity] = card
            took += 1
            products.append(card)
        trace.append(f"need[{i}] {n.kind}/{n.operation} "
                     f"cand={len(cands)} took={took}")
    ref_needs = _ref_needs_map(needs, requests, selection, pool,
                               prodish_idx)
    evidence = _compile_evidence(
        pool, web_evidence, req_needs=req_needs, idx_of=idx_of,
        prodish_idx=prodish_idx, target_of=target_of,
        ref_needs=ref_needs, trace=trace)
    notes = tuple(dict(u) for u in (selection.unavailable_evidence or ()))
    payload = json.dumps(
        {"products": products, "evidence": evidence,
         "availability_notes": notes, "task": task.render()},
        ensure_ascii=False, default=str)
    return AnswerContext(
        task=task, products=tuple(products), evidence=tuple(evidence),
        availability_notes=notes, unanswered_needs=tuple(unanswered),
        estimated_tokens=estimate_tokens(payload),
        trace=tuple(trace) + tuple(selection.trace or ()))


# ── pre-answer typed web gate ───────────────────────────────────────────────

def _pool_identity_refs(pool: CandidatePool) -> set[str]:
    """identities/refs ที่ resolve ใน pool ทุก bucket (eligible+unavailable+
    rejected = เคยเห็นใน local catalog — unresolved = ไม่เคยเห็นเลย)"""
    out: set[str] = set()
    for c in tuple(pool.eligible) + tuple(pool.unavailable) \
            + tuple(pool.rejected):
        for v in (c.identity, c.item_id, c.model_id, c.unit_id):
            if v:
                out.add(str(v).upper())
        for m in (c.card.get("model_codes") or ()):
            out.add(str(m).upper())
    return out


def _external_targets(pool: CandidatePool) -> tuple[set, set]:
    """normalized targets ที่ pool มี external evidence แล้ว —
    (device_spec records, web records) — decide จาก produced evidence
    เท่านั้น (ห้าม re-run spec resolver / retrieval)"""
    spec: set[str] = set()
    web: set[str] = set()
    for e in pool.supporting_evidence or ():
        if not isinstance(e, dict):
            continue
        t = _norm_target(e.get("target"))
        if not t:
            continue
        if e.get("kind") == "device_spec":
            spec.add(t)
        elif e.get("kind") == "web":
            web.add(t)
    return spec, web


def _admission_query(need, target: str) -> str:
    """deterministic search query จาก typed fields เท่านั้น —
    target + operation + scope + subject_refs (ไม่มี keyword template)."""
    parts = [target, need.operation, *_need_scope(need),
             *[str(r) for r in need.subject_refs or ()]]
    return " ".join(p for p in parts if p).strip()


def decide_web_admission(*, needs: tuple, selection: SelectionResult,
                         pool: CandidatePool, requests: tuple, profile,
                         web_configured: bool | None = None) -> WebAdmission:
    """pre-answer web gate — total function (unknown/error → deny เสมอ).

    admit เฉพาะ productish need ที่ external evidence ยังขาดจริง:
    - coverage: target มี device_spec/web record ใน pool แล้ว = answered
      (selected card = identity evidence เท่านั้น ไม่ใช่ spec coverage);
      need ไม่มี target + มี selected = catalog answered แล้ว
    - identity: selected candidate ที่ attribute กลับ need หรือ
      subject_refs ทั้งหมด resolve ใน pool — ไม่งั้น unresolved
    - operation: local facts / catalog existence deny เสมอ
    """
    def deny(reason) -> WebAdmission:
        return WebAdmission(allowed=False, reason=reason)
    try:
        prodish = [(i, n) for i, n in enumerate(needs)
                   if n.kind in PRODUCTISH_NEED_KINDS]
        if not prodish:
            return deny("no_productish_need")
        req_needs = _req_needs_map(requests, needs)
        by_req = dict(selection.by_request)
        pool_refs = _pool_identity_refs(pool)
        spec_targets, web_targets = _external_targets(pool)
        first_deny: WebAdmission | None = None
        for i, n in prodish:
            reqs_n = _need_requests(n, requests, req_needs)
            selected_n = [s for r in reqs_n
                          for s in by_req.get(r.request_id, ())]
            target = _need_target(n, reqs_n, profile)
            tn = _norm_target(target)
            if tn and tn in spec_targets:
                if first_deny is None:
                    first_deny = deny("local_evidence_sufficient")
                continue
            if tn and tn in web_targets:
                if first_deny is None:
                    first_deny = deny("web_already_supplied")
                continue
            if not tn and selected_n:
                continue  # catalog answered — no external need
            # uncovered need → deny-ordered evaluation
            if n.operation in LOCAL_FACT_OPS:
                d = deny("local_fact_operation")
            elif n.operation == "recommend":
                # catalog existence — catalog answered (incl. empty result)
                d = deny("local_catalog_existence")
            elif not selected_n and not (
                    n.subject_refs and all(
                        _norm_ref(r) in pool_refs
                        for r in n.subject_refs)):
                d = deny("unresolved_local_identity")
            elif not tn:
                d = deny("no_external_target")
            else:
                if web_configured is None:
                    try:
                        from . import web_search as _ws
                        web_configured = _ws.is_configured()
                    except Exception:
                        web_configured = False
                if not web_configured:
                    d = deny("not_configured")
                else:
                    return WebAdmission(
                        allowed=True,
                        reason="admitted_external_evidence_need",
                        need_index=i,
                        query=_admission_query(n, target),
                        target=target)
            if first_deny is None:
                first_deny = d
        if first_deny is not None:
            return first_deny
        return deny("covered")  # ทุก productish need มี coverage แล้ว
    except Exception:
        return deny("internal_error")
