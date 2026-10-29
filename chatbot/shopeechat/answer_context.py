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
from dataclasses import dataclass, field, replace as _dc_replace
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from .policy_resolver import CompatDecision

from .retrieval_planner import RetrievalRequest
from .retrieval_selection import (
    META_HINT_KEYS, SelectionResult, needs_for_request)
from .candidate_pool import CandidatePool
from .turn_decision import PRODUCTISH_NEED_KINDS, _FACT_DESCRIBE

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
    "name", "item_id", "shop", "price", "warranty", "short_link", "image_url",
    "has_promotion", "is_flash_sale", "variants", "tier_variation",
    "brand", "category", "sold_out", "total_stock", "status",
    "catalog_status", "_available_for_sale", "sellable",
    "canonical_specs", "kb_specs", "kb_highlights", "kb_box_contents",
    "kb_description", "_source", "oos_in_name", "has_description",
    "has_warranty_info", "requested_variant_state",
})
_DESC_OPS = frozenset({"describe", "compare", "compat", "lookup", "collect"})
_DESC_FIELDS = frozenset({"description_excerpt", "weight", "dimension"})
# typed requested_facts (describe-family) admit evidence fields ของ item
#   นั้นเองแม้ op เป็น fact-op (stock/price) — owner: TurnNeed.requested_facts
_FACT_DESC_FIELDS = _DESC_FIELDS | frozenset({"raw_description"})
_FACT_DESC_FAMILY = _FACT_DESCRIBE
# intent requested_facts → FieldEvidence fact_key (join ของ 2 contract —
# consumer boundary เจ้าเดียว: card fields/evidence ที่ cover อยู่แล้ว
# (price/stock/link/description/compatibility) ไม่ต้อง emit ซ้ำ)
_REQUESTED_FACT_KEYS = {
    "data_transfer_speed": ("data_transfer_mbps",),
    "charging_speed": ("output_power_w",),
}

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
    "historical_evidence":
        "สินค้าที่เคยคุยกันก่อนหน้า — ใช้เป็นข้อมูลอ้างอิงเท่านั้น "
        "ไม่ใช่สินค้าที่แนะนำในคำตอบนี้",
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
    requested_facts: tuple[str, ...] = ()        # intent contract keys verbatim
    # source-grounded asks ที่มี exact-subject attributed evidence —
    #   model แยก subclaim ตามหลักฐาน (partial evidence ≠ blanket
    #   cannot-confirm); ไม่มี subject evidence → UnansweredNeed เดิม
    capability_asks: tuple[str, ...] = ()


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
            if t.requested_facts:
                parts.append(
                    "เรื่อง " + "/".join(
                        _FACT_LABEL.get(f, f) for f in t.requested_facts))
            if t.capability_asks:
                parts.append(
                    "คำถามความสามารถ: " + " / ".join(t.capability_asks)
                    + " — ตอบเฉพาะส่วนที่หลักฐานใน context ยืนยัน "
                      "ส่วนที่ไม่มีหลักฐานให้แจ้งตรงๆ ว่ายังไม่มีข้อมูล"
                      "ยืนยัน ห้ามตอบว่า \"ไม่รองรับ\"")
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
    reason: Literal["no_selection", "deferred", "no_answer",
                    "no_evidence", "clarify"]
    # capability asks ที่ unresolved (typed verbatim จาก TurnNeed —
    #   renderer name ได้ทุกตัวโดยไม่ parse prose); ว่าง = unresolved
    #   ทั้ง need
    capability_asks: tuple[str, ...] = ()
    # reason="clarify" เท่านั้น — canonical types ของ decided candidates
    #   ที่ทำให้ scope กว้างเกิน (≥2 types, ไม่มี requested type/subtype) —
    #   renderer name ผ่าน _type_query_word (ไม่ใช่ prose inference)
    clarify_types: tuple[str, ...] = ()


@dataclass(frozen=True)
class CompatVerdict:
    """typed compat conclusion ที่ผ่าน exact (subject,target,relation)
    gate แล้ว — composition input เดียวของ verdict segment;
    `decision` = CompatDecision เดิมทั้งก้อน (proof identity+reason
    ไม่หาย) — model ไม่เห็น raw proof dict"""
    need_index: int
    subject_id: str
    subject_name: str                  # display name จาก selected card
    target: str                        # normalized verdict target
    relation: str                      # exact typed relation เดียว
    decision: CompatDecision


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
    # typed compat decisions ที่ผ่าน exact (subject,target,relation)
    # proof — deterministic verdict segment ที่ composition (ไม่ใช่
    # model task / ไม่ใช่ evidence context ของ model)
    compat_verdicts: tuple[CompatVerdict, ...] = ()
    # typed constraint/target gate notes — near-miss (proven-fail dropped)
    # และ unverified-target summary; evidence-bound เท่านั้น
    #   {"need_index", "item", "detail"} — renderer อยู่ใน context_text
    constraint_notes: tuple[dict, ...] = ()
    # need ที่ evaluated candidates ทั้งหมด proven-fail → typed verdict
    #   → deterministic segment ที่ composition (เช่นเดียวกับ compat
    #   verdict — model ไม่ต้อง render conclusion เอง)
    #   {"need_index", "items": [{"identity","item","detail"}]}
    constraint_segments: tuple[dict, ...] = ()
    # eval-measured spec values = typed product evidence ผูก identity
    #   เจ้าของค่าเสมอ — {"identity","name","fact_key","value"}; ค่าที่
    #   ลูกค้าถามไม่เข้าช่องนี้ (measured ≠ ask). guard ตรวจ claim กับ
    #   evidence ของ identity เดียวกันที่ clause ระบุเท่านั้น — ห้ามเป็น
    #   flat/global authority (ค่าของ A ห้ามรับรอง claim ของ B)
    spec_measured_facts: tuple[dict, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not (self.products or self.evidence
                    or self.availability_notes or self.constraint_notes)

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
        # original need_index → visible ordinal — owner เดียวกับ
        # AnswerTask.render (position ใน surviving tasks); internal
        # need_index/need_indices ไม่ renumber — translate เฉพาะตอน
        # serialize (canonical records ไม่ถูก mutate)
        ordinal = {t.need_index: pos
                   for pos, t in enumerate(self.task.tasks, 1)}
        ser_products = [
            {**p, "need_indices": ords}
            for p in self.products
            if (ords := [ordinal[i] for i in p.get("need_indices") or ()
                         if i in ordinal])]
        header += f"จำนวนสินค้าใน context: {len(ser_products)}\n\n"
        if ser_products:
            body = json.dumps(ser_products, ensure_ascii=False, indent=2)
        else:
            body = ("ไม่พบข้อมูลสินค้าที่ตรงกับคำถามในระบบค้นหา\n"
                    "ห้ามสรุปว่าสินค้าหมดสต็อก เลิกขาย หรือไม่มีจำหน่าย "
                    "ให้บอกลูกค้าว่าไม่พบข้อมูลรุ่นนี้ในระบบ")
        out = header + body
        if self.evidence:
            ev_lines = []
            for e in self.evidence:
                ords = "+".join(str(ordinal[i])
                                for i in e.get("need_indices") or ()
                                if i in ordinal)
                if not ords:
                    continue  # ไม่มี surviving model-task owner → ไม่เข้า context
                kind = e.get("kind", "evidence")
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
        if self.constraint_notes:
            lines = [(f"- {str(n.get('item'))}: {str(n.get('detail') or '')}"
                      if n.get('item')
                      else f"- {str(n.get('detail') or '')}").rstrip()
                     for n in self.constraint_notes]
            out += ("\n\nข้อจำกัดที่ตรวจพบจาก evidence "
                    "(ห้ามสรุปเกิน — สินค้าที่ไม่ผ่านเงื่อนไข/พิสูจน์ว่า"
                    "ไม่เข้ากันถูกตัดออกแล้ว):\n" + "\n".join(lines))
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


def device_spec_for_target(specs, target) -> dict | None:
    """เลือก device_spec dict ที่ device normalize ตรง target เดียว —
    first-match deterministic (contract เดียวกับ boundary web record);
    non-dict/malformed → ข้าม; ไม่พบ → None (producer ไม่ emit evidence)"""
    tn = _norm_target(target)
    if not tn:
        return None
    for sp in specs or ():
        if isinstance(sp, dict) and _norm_target(sp.get("device")) == tn:
            return sp
    return None


def _req_needs_map(requests: tuple, needs: tuple) -> dict[str, tuple]:
    return {r.request_id: needs_for_request(r, needs) for r in requests}


def _need_requests(need, requests, req_needs) -> list[RetrievalRequest]:
    return [r for r in requests if need in req_needs.get(r.request_id, ())]


def _need_scope(need) -> tuple[str, ...]:
    return tuple(sorted(
        set(need.product_types or ()) | set(need.subtypes or ())))


def _need_target(need, reqs, profile) -> str | None:
    """external target = semantic property ของ compat/relation need
    เท่านั้น (owner ของ external-relation work) — request/profile target
    ที่ propagate เข้า product/describe/recommend need ไม่ทำให้ task
    นั้นกลายเป็น compatibility claim"""
    if need.kind != "compat":
        return None
    for r in reqs:
        if r.target_device:
            return r.target_device
    # non-device target (app/service label — route_context เก็บ device
    #   view เท่านั้นใน target_device): typed target_refs ของ need เป็น
    #   authoritative verbatim — ต้องไหลเข้า verdict/unresolved machinery
    #   มิฉะนั้น need ถูก cover ด้วย product candidates แล้วหายเงียบ
    return (getattr(profile, "target_device", None)
            or next(iter(need.target_refs or ()), None))


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


# request sources ที่เป็น products-for-device channel — target ที่นี่
# คือ shopping semantic (selection คือคำตอบอยู่แล้ว) ไม่ใช่ verdict claim
_RELATION_REQ_SOURCES = frozenset({"relation_target", "compat"})

def _need_relation(reqs_n, tn: str) -> str | None:
    """exact typed relation ของ verdict target tn — แหล่งที่ยอมรับเท่านั้น:
    `RetrievalRequest.relation_type` (RetrievalRelation → request ตรงๆ)
    หรือ `compat_mode` ผ่าน canonical owner (`policy_resolver
    .compat_relation_for_mode`) — distinct set ต้อง == 1 ไม่งั้น None
    (missing/ambiguous/explicit-conflict → fail closed, ห้ามเดา)"""
    from . import policy_resolver as _pr
    rels: set[str] = set()
    for r in reqs_n:
        if _norm_target(getattr(r, "target_device", None)) != tn:
            continue
        rt = getattr(r, "relation_type", None)
        if rt not in (None, ""):
            if str(rt) not in _pr.COMPAT_RELATIONS:
                return None   # malformed explicit relation → fail closed
            rels.add(str(rt))
        rm = _pr.compat_relation_for_mode(
            getattr(r, "compat_mode", "") or "")
        if rm:
            rels.add(rm)
    return next(iter(rels)) if len(rels) == 1 else None


# ── typed spec-constraint labels (display เท่านั้น — field keys เป็นของ
#   intent_classifier contract; Thai label = renderer ไม่ใช่ interpreter) ──
_SPEC_FIELD_LABEL = {
    "data_transfer_mbps": "ความเร็วถ่ายโอนข้อมูล",
    "output_power_w": "กำลังชาร์จ",
    "capacity_mah": "ความจุแบตเตอรี่",
    "cable_length_m": "ความยาวสาย",
}
_FEATURE_LABEL = {"magnetic": "สาย/หัวแม่เหล็ก"}
_OP_LABEL = {"gte": "อย่างน้อย", "lte": "ไม่เกิน", "gt": "มากกว่า",
             "lt": "น้อยกว่า", "eq": "เท่ากับ"}
# fail phrasing ที่วาง threshold ใต้ negation "ไม่" — customer-facing line
# ผ่าน spec_claim grounding (ค่าที่ถามไม่ใช่ product evidence)
_OP_NEG_LABEL = {"gte": "ไม่ถึง", "lte": "ไม่ได้ต่ำกว่า", "gt": "ไม่เกิน",
                 "lt": "ไม่น้อยกว่า", "eq": "ไม่เท่ากับ"}
# requested_facts key → Thai label (render เท่านั้น — keys เป็นของ
#   intent_classifier closed enum)
_FACT_LABEL = {
    "price": "ราคา", "stock": "สต็อก", "link": "ลิงก์สินค้า",
    "description": "รายละเอียดสินค้า", "warranty": "ระยะเวลารับประกัน",
    "data_transfer_speed": "ความเร็วถ่ายโอนข้อมูล",
    "charging_speed": "ความเร็วชาร์จ/กำลังไฟ",
    "compatibility": "ความเข้ากันได้",
}


def _spec_label(key: str) -> str:
    return _SPEC_FIELD_LABEL.get(key) or _FEATURE_LABEL.get(key) or key


def _constraint_fail_label(res: dict) -> str:
    """eval fail → near-miss detail text (evidence-bound เท่านั้น)."""
    from . import policy_resolver as _pr
    parts: list[str] = []
    for k in res.get("failed") or ():
        d = (res.get("detail") or {}).get(k)
        if d:
            op, want, got = d
            parts.append(
                f"{_spec_label(k)} {_pr.format_constraint_value(k, got)} "
                f"{_OP_NEG_LABEL.get(op, 'ไม่ตรง')} "
                f"{_pr.format_constraint_value(k, want)} ที่ต้องการ")
        else:
            parts.append(_spec_label(k))
    sat = [_spec_label(k) for k in res.get("satisfied") or ()]
    head = f"ผ่าน {'/'.join(sat)} แต่ " if sat else ""
    return head + "; ".join(parts)


def _constraint_unknown_label(res: dict) -> str:
    """eval unknown → limitation note (unproven ≠ disproven — ห้ามยืนยัน)"""
    labels = [_spec_label(k) for k in res.get("unknown") or ()]
    return ("ยังไม่มีข้อมูลยืนยัน " + "/".join(labels) +
            " ของรุ่นนี้ — ห้ามยืนยันเงื่อนไขนั้น") if labels else ""


def _verdict_target_decisions(i: int, tn: str, need, reqs_n, *, by_req,
                              pool, web_evidence, req_needs, idx_of,
                              prodish_idx, target_of, ref_needs
                              ) -> tuple[tuple[CompatVerdict, ...],
                                         tuple[str, ...]]:
    """(subject,target,relation)-scoped verdict ของทุก subject ใน compat
    need เดียว — `resolve_compat` ครั้งเดียวต่อ subject ด้วย relation
    เดียวที่ typed contract ระบุ (`_need_relation`); decided iff outcome
    ∈ {compatible,incompatible}; คืน (verdicts, unresolved_names) —
    subject ที่ decide ไม่ได้/ไม่มี card ต้องไม่หายเงียบ และ evidence
    ของ subject หนึ่งไม่ cover อีก subject:

    - declared proof: record ที่ attribute เข้า need นี้ผ่าน
      `compat_proof_from_dict` เท่านั้น (malformed/unknown source →
      reject fail closed; resolver filter subject/target/relation ตรง)
    - derived: device_field_facts(target data) + extract_field_facts
      (subject card) ผ่าน resolve_compat owner เดิม

    target-only record / record ของ subject อื่น / target อื่น /
    relation อื่น / web prose ไม่มี structured data → ไม่ใช่ coverage"""
    from . import candidate_pool as _cpool
    from . import policy_resolver as _pr

    rel = _need_relation(reqs_n, tn)
    refs = {_norm_ref(r) for r in (need.subject_refs or ())}
    subjects: list[tuple[str, dict, tuple[str, ...]]] = []
    seen_s: set[str] = set()
    for r in reqs_n:
        for s in by_req.get(r.request_id, ()):
            card = s.card or {}
            keys = _cand_keys(s.identity, card.get("item_id"),
                              card.get("model_id"), card)
            matched = tuple(x for x in (need.subject_refs or ())
                            if _norm_ref(x) in keys)
            if refs and not matched:
                continue  # card นี้ไม่ใช่ subject ของ need นี้
            sid = _cpool._identity_key(card)[0] if card else ""
            if sid and sid not in seen_s:
                seen_s.add(sid)
                subjects.append((sid, card, matched))
    named = {x for _, _, m in subjects for x in m}
    # subject_ref ที่ไม่มี selected card เลย = subject ที่ resolve ไม่ได้
    unres: list[str] = [r for r in (need.subject_refs or ())
                        if r not in named]
    if not rel or not subjects:
        for sid, _card, m in subjects:
            unres.extend(m or (sid,))
        return (), tuple(dict.fromkeys(unres))

    def _declared(rec: dict) -> None:
        if rec.get("subject_id") and rec.get("relation") \
                and rec.get("verdict"):
            try:
                declared.append(_pr.compat_proof_from_dict({
                    "subject_id": str(rec["subject_id"]),
                    "target": f"device:{tn}",
                    "relation": rec["relation"],
                    "verdict": rec["verdict"],
                    "facts": tuple(rec.get("facts") or ()),
                    "source": rec.get("source"),
                    "source_version": rec.get("source_version") or ""}))
            except (ValueError, TypeError):
                pass   # malformed/unknown source → ไม่ใช่ proof (fail closed)

    declared: list = []
    t_facts: list = []
    for rec in pool.supporting_evidence or ():
        if not isinstance(rec, dict) \
                or _norm_target(rec.get("target")) != tn:
            continue
        if i not in _attribute(rec, req_needs=req_needs, idx_of=idx_of,
                               prodish_idx=prodish_idx,
                               target_of=target_of, ref_needs=ref_needs):
            continue
        _declared(rec)
        data = rec.get("data")
        if isinstance(data, dict):
            t_facts.extend(_pr.device_field_facts(tn, data))
    for e in web_evidence or ():
        if not isinstance(e, dict) \
                or _norm_target(e.get("target")) != tn:
            continue
        if i not in _attribute(e, req_needs=req_needs, idx_of=idx_of,
                               prodish_idx=prodish_idx,
                               target_of=target_of, ref_needs=ref_needs):
            continue
        _declared(e)
        data = e.get("data")
        if isinstance(data, dict):
            t_facts.extend(_pr.device_field_facts(tn, data))
    verdicts: list[CompatVerdict] = []
    for sid, card, matched in subjects:
        card_keys = _cand_keys(sid, card.get("item_id"),
                               card.get("model_id"), card)
        decl_n = tuple(_pr.CompatProof(
                sid, p.target, p.relation, p.verdict, p.facts,
                p.source, p.source_version)
            for p in declared
            if _norm_ref(p.subject_id) in card_keys)
        s_facts = _pr.extract_field_facts(card, subject_id=sid,
                                          mentions=(tn,))
        dec = _pr.resolve_compat(
            subject_id=sid, target=f"device:{tn}", relation=rel,
            subject_facts=s_facts, target_facts=tuple(t_facts),
            declared=decl_n)
        if dec.outcome in ("compatible", "incompatible"):
            verdicts.append(CompatVerdict(
                need_index=i, subject_id=sid,
                subject_name=(card.get("name")
                              or card.get("item_name") or sid),
                target=tn, relation=rel, decision=dec))
        else:
            unres.extend(matched or (sid,))
    return tuple(verdicts), tuple(dict.fromkeys(unres))


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
            ranking=n.ranking,
            requested_facts=tuple(
                getattr(n, "requested_facts", ()) or ()),
            capability_asks=tuple(
                getattr(n, "capability_asks", ()) or ()
                if any(
                    s.role == "subject" or s.identity in {
                        _s.identity for _r in reqs_n
                        for _s in by_req.get(_r.request_id, ())
                        if _s.role == "subject"}
                    for s in cands) else ())))
        trace.append(f"task[{i}] {n.kind}/{n.operation} "
                     f"reqs={[r.request_id for r in reqs_n]}")
    return AnswerTask(tasks=tuple(tasks), deferred=tuple(deferred),
                      trace=tuple(trace))


def _scope_card(card: dict, need, role: str) -> dict:
    """field-scope ตาม operation ของ need + role note (hidden never passes —
    caller skip ก่อนแล้ว แต่กันซ้ำที่นี่อีกชั้น)."""
    if card.get("customer_visibility") == "hidden":
        return {}
    # typed fact request = describe-family evidence admission บน fact-op
    #   ด้วย ("speed เท่าไหร่" op อาจ stock/describe — evidence เดียวกัน)
    _facts = set(getattr(need, "requested_facts", ()) or ())
    allowed = _BASE_CARD_FIELDS | (
        _DESC_FIELDS if need.operation in _DESC_OPS else frozenset()) | (
        _FACT_DESC_FIELDS if _facts & _FACT_DESC_FAMILY else frozenset())
    out = {k: card[k] for k in card if k in allowed}
    # requested facts → typed spec_facts เจาะจง (first-class field —
    # model ไม่ต้องขุด prose; emit เฉพาะ fact ที่ evidence มีจริง —
    # extract_field_facts ไม่มี fact = unknown ไม่ใช่ 0)
    wanted = {fk for f in _facts
              for fk in _REQUESTED_FACT_KEYS.get(f, ())}
    if wanted:
        from . import policy_resolver as _pr
        sf = {fe.fact_key: fe.value
              for fe in _pr.extract_field_facts(
                  card, subject_id=str(card.get("item_id") or ""))
              if fe.fact_key in wanted and fe.status == "known"}
        if sf:
            out["spec_facts"] = sf
    note = _ROLE_NOTE.get(role)
    _pre = card.get("_context_note")        # selection-stamped label
    if _pre:
        note = f"{_pre} — {note}" if note else _pre
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
    ref_needs = _ref_needs_map(needs, requests, selection, pool,
                               prodish_idx)
    target_of: dict[int, str | None] = {}
    products: list[dict] = []
    emitted: dict[str, dict] = {}   # identity → card ที่อยู่ใน payload
    unanswered: list[UnansweredNeed] = list(task.deferred)
    _ask_unanswered: set[int] = set()   # asks → deterministic tail (strip task)
    trace: list[str] = []
    cnotes: list[dict] = []         # typed gate notes (constraint/target)
    note_extra: dict[str, list[str]] = {}   # identity → limitation notes
    sf_extra: dict[str, dict] = {}          # identity → measured spec values
    # eval-measured spec values — typed evidence ผูก identity เจ้าของค่า
    #   ({identity,name,fact_key,value}) — guard ground เฉพาะ clause-bound
    measured_facts: list[dict] = []
    det_segments: list[dict] = []           # no-match verdict segments
    no_match: set[int] = set()   # need ที่ candidates ทุกใบ proven-fail
    clarify: set[int] = set()   # need ที่ outcome = typed scope clarify
    note_replace: dict[str, str] = {}  # identity → note แทน role note ทั้งก้อน
    product_verdicts: list[CompatVerdict] = []  # decided proofs บน product needs
    # pass 1 — target ownership: compat need เท่านั้นที่มี external
    # target; verdict target (slot/profile source — ไม่ใช่
    # products-for-device channel) ต้องมี subject-target coverage ผ่าน
    # resolve_compat; ไม่มี → need+task หาย และ request ที่ carry target
    # นั้นของ subject-owner เดียวกันถือเป็น relation context ที่พิสูจน์
    # ไม่ได้ (tainted — products ของมัน drop จากทุก need)
    for i, n in enumerate(needs):
        if n.kind in PRODUCTISH_NEED_KINDS:
            reqs_i = _need_requests(n, requests, req_needs)
            # evidence/context target = task target (compat เท่านั้น) หรือ
            # request-carried target (attribution context — ไม่ใช่ claim)
            target_of[i] = _need_target(n, reqs_i, profile) or next(
                (r.target_device for r in reqs_i if r.target_device),
                None)
    uncovered: set[int] = set()
    decided: dict[int, tuple[CompatVerdict, ...]] = {}
    partial_refs: dict[int, tuple[str, ...]] = {}
    tainted_reqs: set[str] = set()
    tainted_idents: set[str] = set()
    for i, n in enumerate(needs):
        if n.kind != "compat" or i not in prodish_idx:
            continue
        tn = _norm_target(target_of.get(i))
        if not tn:
            continue
        reqs_n = _need_requests(n, requests, req_needs)
        carriers = [r for r in reqs_n
                    if _norm_target(r.target_device) == tn]
        verdict = (not carriers) or any(
            r.source not in _RELATION_REQ_SOURCES for r in carriers)
        if not verdict:
            continue  # products-for-device — selection คือคำตอบอยู่แล้ว
        verdicts, unres = _verdict_target_decisions(
                i, tn, n, reqs_n, by_req=by_req, pool=pool,
                web_evidence=web_evidence, req_needs=req_needs,
                idx_of=idx_of, prodish_idx=prodish_idx,
                target_of=target_of, ref_needs=ref_needs)
        for v in verdicts:
            trace.append(f"need[{i}] verdict target={tn!r} "
                         f"subject={v.subject_id} "
                         f"relation={v.relation} → "
                         f"{v.decision.outcome}")
        if verdicts:
            decided[i] = verdicts
            if not unres:
                continue  # ทุก subject decided
            partial_refs[i] = unres
        uncovered.add(i)
        refs_i = {_norm_ref(x) for x in (n.subject_refs or ())}
        unres_refs = {_norm_ref(x) for x in unres}
        # taint scope = unresolved subject refs เท่านั้น (need ไม่มี refs →
        # {} → carrier ทุกตัว tainted เหมือนเดิม — sid ไม่ใช่ ref space)
        scope_refs = unres_refs & refs_i
        for r in carriers:
            if r.source in _RELATION_REQ_SOURCES:
                continue
            codes = {_norm_ref(x) for x in (r.model_codes or ())}
            if codes and scope_refs and not (codes & scope_refs):
                continue  # request นี้เป็น context ของ subject อื่น
            if refs_i:
                tainted_reqs.add(r.request_id)
            else:
                # ไม่มี declared subject — unres คือ anonymous candidates ที่
                #   verdict ไม่ได้ (missing connector evidence ฯลฯ): drop
                #   เฉพาะ card เหล่านั้น ไม่ poison request ทั้งก้อน —
                #   decided-compatible cards ยังเป็นคำตอบของ turn ได้
                for _s in by_req.get(r.request_id, ()):
                    if (_cand_keys(_s.identity, _s.card.get("item_id"),
                                   _s.card.get("model_id"), _s.card)
                            & unres_refs):
                        tainted_idents.add(_s.identity)
        trace.append(f"need[{i}] verdict target={tn!r} "
                     + (f"unresolved={list(unres)} → partial "
                        if verdicts else "")
                     + "no_evidence → dropped")
    for i, n in enumerate(needs):
        scope = tuple(sorted(set(n.product_types or ())
                             | set(n.subtypes or ())))
        if n.kind not in PRODUCTISH_NEED_KINDS:
            continue   # deferred จัดการแล้วบน task (classification owner เดียว)
        reqs_n = _need_requests(n, requests, req_needs)
        if i in uncovered:
            unanswered.append(UnansweredNeed(
                i, n.kind, n.operation,
                tuple(partial_refs.get(i) or n.subject_refs or ()),
                scope, target_of[i], "no_evidence",
                capability_asks=tuple(
                    getattr(n, "capability_asks", ()) or ())))
            continue
        tainted = False
        cands = [s for r in reqs_n for s in by_req.get(r.request_id, ())]
        if ((n.operation in LOCAL_FACT_OPS
             or any(str(r).isdigit() for r in (n.subject_refs or ())))
                and any(r.source == "subjects" for r in reqs_n)):
            # fact-op (price/stock/link) หรือ exact-item pinned need —
            #   คำตอบเป็นของ resolved subject เท่านั้น; slot/history/
            #   context candidates ไม่ใช่ fact ของ item นี้ (sibling
            #   ห้ามข้าม exact-item boundary)
            cands = [s for s in cands if s.role == "subject"]
        if n.operation != "recommend" and any(
                s.role == "subject" for s in cands):
            # alternative = typed substitute ของ selection owner —
            #   subject coverage อยู่แล้ว → เพิ่ม alternative = sibling
            #   drift ที่ลูกค้าไม่ได้ขอ (W02 ใน W01 follow-up); subject
            #   ไม่มี card เลย → alternative = substitute answer เจตนา
            #   (มี WPB100L ไหม → เสนอ AC65B แทน — ห้าม filter)
            cands = [s for s in cands if s.role != "alternative"]
        if tainted_reqs or tainted_idents:
            kept = [s for s in cands
                    if s.request_id not in tainted_reqs
                    and s.identity not in tainted_idents]
            tainted = len(kept) < len(cands)
            cands = kept
        # ── current-need type/subtype eligibility — card ต้องเข้ากับ
        #   scope ที่ need declare; channels ที่ข้าม retrieval filters
        #   (history/subjects/context) ต้องผ่าน current need เหมือน
        #   candidate ใหม่ทุกข้อ — subject_refs-pinned = explicit identity
        #   authority → exempt; subtype evidence ขาด → ยืนยัน subtype
        #   ไม่ได้ → ออก (fail closed); compare/compat needs ไม่ gate
        #   (scope fields ของมันว่างตาม contract — relation ไม่ใช่
        #   product-type boundary). อยู่ก่อน constraint/verdict ทั้งหมด —
        #   card ที่ตก scope = ไม่ใช่ candidate ของ need นี้ → ไม่มี
        #   constraint note/verdict/deterministic segment/model evidence
        #   (adapter turn ไม่ narrate cable — canonical subtype contract
        #   เป็น authority ของ eligibility ไม่ใช่เหตุข้าม gate)
        if n.kind == "product" and (n.subtypes or n.product_types):
            _nsubs = set(n.subtypes or ())
            _ntypes = set(n.product_types or ())
            _nrefs = {str(x) for x in (n.subject_refs or ())}
            _kept = []
            for s in cands:
                _c = s.card or {}
                _cid = str(_c.get("item_id")
                           or _c.get("linked_item_id") or "")
                if _cid and _cid in _nrefs:
                    _kept.append(s)
                    continue
                _roles = set(_c.get("canonical_roles") or ())
                _ctype = str(_c.get("canonical_type")
                             or _c.get("product_type") or "")
                if _nsubs and not (_roles & _nsubs):
                    trace.append(f"need[{i}] scope_mismatch {s.identity}")
                    continue
                if _ntypes and _ctype and _ctype not in _ntypes:
                    trace.append(f"need[{i}] scope_mismatch {s.identity}")
                    continue
                _kept.append(s)
            cands = _kept
        # ── compat need: decided-incompatible = typed verdict เท่านั้น —
        #   ออกจาก products ทุก role (compat segment render conclusion;
        #   ห้าม image/link/CTA เหมือน constraint-failed); compatible →
        #   role note ถูกต้องอยู่แล้ว; undecided → need ถูก uncovered กั้น
        #   ก่อนถึงตรงนี้
        if n.kind == "compat":
            from . import candidate_pool as _cpool
            vmap = {v.subject_id: v for v in decided.get(i, ())}
            tn_i = _norm_target(target_of.get(i))
            kept = []
            for s in cands:
                sid = (_cpool._identity_key(s.card or {})[0]
                       or s.identity)
                v = vmap.get(sid)
                if v and v.decision.outcome == "incompatible":
                    cnotes.append({
                        "need_index": i,
                        "item": (s.card or {}).get("name") or s.identity,
                        "detail": f"หลักฐานยืนยันว่าไม่เข้ากันกับ {tn_i}"
                                  f" — ไม่นำเสนอเป็นคำตอบ"})
                    trace.append(
                        f"need[{i}] verdict_incompatible {s.identity}")
                    continue
                kept.append(s)
            cands = kept
        # ── typed spec/feature constraint gate — canonical eval owner
        #   (policy_resolver.eval_spec_constraints ← extract_field_facts):
        #   proven-fail candidates drop + near-miss note; unknown = keep +
        #   limitation (unproven ≠ disproven); subject/historical roles ไม่
        #   drop — annotate แทน (identity/reference ไม่ใช่ candidate ใหม่)
        from . import candidate_pool as _cpool
        from . import policy_resolver as _pr
        cons = tuple(dict.fromkeys(
            list(getattr(n, "spec_constraints", ()) or ())
            + [c for r in reqs_n for c in (r.spec_constraints or ())]))
        feats = tuple(dict.fromkeys(
            list(getattr(n, "required_features", ()) or ())
            + [f for r in reqs_n for f in (r.required_features or ())]))
        if cons or feats:
            kept = []
            dropped_c = 0
            failed_refs: dict[str, dict] = {}   # identity → near-miss meta
            for s in cands:
                sid = (_cpool._identity_key(s.card or {})[0]
                       or s.identity)
                res = _pr.eval_spec_constraints(
                    _pr.extract_field_facts(
                        s.card or {}, subject_id=sid), cons, feats)
                # measured spec values → typed spec_facts บน card ที่ emit
                #   + identity-scoped measured evidence (guard ground เฉพาะ
                #   clause ที่ระบุ identity เจ้าของค่า — ไม่ใช่ flat/global)
                if res.get("detail"):
                    sf_extra.setdefault(s.identity, {}).update(
                        {f_: d[2] for f_, d in res["detail"].items()
                         if len(d) > 2})
                    for f_, d in res["detail"].items():
                        if len(d) > 2:
                            measured_facts.append({
                                "identity": s.identity,
                                "name": (s.card or {}).get("name") or "",
                                "fact_key": f_, "value": d[2]})
                if res["status"] == "fail":
                    # proven-fail = typed diagnostic เท่านั้น — ทุก role
                    #   ออกจาก answer products (ห้าม image/link/CTA);
                    #   ทุก decided-fail candidate เก็บเป็น near-miss
                    #   metadata + scoped alternative card ของตัวเอง —
                    #   segment/attachment ใช้ decided verdict เท่านั้น
                    #   (unknown/unverified ไม่เคยเป็น near-miss)
                    lbl = _constraint_fail_label(res)
                    cnotes.append({
                        "need_index": i,
                        "item": (s.card or {}).get("name") or s.identity,
                        "detail": lbl})
                    _nm = _scope_card(s.card, n, "alternative")
                    if _nm:
                        _nm["need_indices"] = (i,)
                    failed_refs[s.identity] = {
                        "identity": s.identity,
                        "item": (s.card or {}).get("name") or s.identity,
                        "detail": lbl,
                        "card": _nm or None}
                    dropped_c += 1
                    trace.append(
                        f"need[{i}] constraint_fail {s.identity}")
                    continue
                if res["status"] == "unknown":
                    lbl = _constraint_unknown_label(res)
                    if lbl:
                        note_extra.setdefault(s.identity, []).append(lbl)
                kept.append(s)
            if dropped_c and not kept:
                cnotes.append({
                    "need_index": i,
                    "item": None,
                    "detail": "ไม่มีสินค้าที่ผ่านเงื่อนไขครบทุกข้อใน"
                              " catalog — แจ้งสถานะตรงๆ ห้ามเสนอสินค้า"
                              "ที่ไม่ผ่านเงื่อนไขเป็นคำตอบ"})
                # typed verdict → deterministic segment (owner เดียวกับ
                #   compat verdict — model ไม่ต้อง render conclusion เอง);
                #   near-miss items = proven-fail identities เท่านั้น
                det_segments.append({
                    "need_index": i,
                    "items": list(failed_refs.values())})
                no_match.add(i)
            cands = kept
        # ── product/compare need + typed target → verdict gate เดียวกับ
        #   compat need (resolve_compat per (subject,target,relation)):
        #   decided-incompatible → drop (+note); undecided → เก็บเป็น
        #   candidate พร้อม limitation (unverified ≠ catalog-empty);
        #   decided-compatible verdicts ไหลเป็น typed proof artifact
        ptn = _norm_target(target_of.get(i))
        if ptn and n.kind != "compat":
            verdicts_t, _unres_t = _verdict_target_decisions(
                i, ptn, n, reqs_n, by_req=by_req, pool=pool,
                web_evidence=web_evidence, req_needs=req_needs,
                idx_of=idx_of, prodish_idx=prodish_idx,
                target_of=target_of, ref_needs=ref_needs)
            # verdicts เฉพาะ candidates ที่ผ่าน current-need eligibility —
            #   card ที่ตก scope ไม่ใช่ candidate → ไม่สมควรได้ verdict/
            #   segment บน need นี้ (adapter turn ไม่ narrate cable)
            _cand_sids = {
                (_cpool._identity_key(s.card or {})[0] or s.identity)
                for s in cands}
            verdicts_t = [v for v in verdicts_t
                          if v.subject_id in _cand_sids]
            vmap = {v.subject_id: v for v in verdicts_t}
            product_verdicts.extend(verdicts_t)
            unres_ids = set(_unres_t)
            kept = []
            for s in cands:
                sid = (_cpool._identity_key(s.card or {})[0]
                       or s.identity)
                v = vmap.get(sid)
                oc = v.decision.outcome if v else ""
                if oc == "incompatible":
                    # decided-incompatible = typed diagnostic เท่านั้น —
                    #   ทุก role ออกจาก products (verdict segment render
                    #   conclusion; ห้าม image/link/CTA เหมือน constraint-
                    #   failed — ไม่ใช่ recommendation product)
                    cnotes.append({
                        "need_index": i,
                        "item": (s.card or {}).get("name")
                                or s.identity,
                        "detail": f"หลักฐานยืนยันว่าไม่เข้ากันกับ {ptn}"
                                  f" — ไม่นำเสนอเป็นคำตอบ"})
                    trace.append(
                        f"need[{i}] target_incompatible {s.identity}")
                    continue
                if oc != "compatible" and (
                        sid in unres_ids or s.identity in unres_ids):
                    # evaluated แต่ decide ไม่ได้ (ไม่ใช่ unevaluated)
                    note_extra.setdefault(s.identity, []).append(
                        f"ยังไม่มีข้อมูลยืนยันว่าเข้ากันกับ {ptn}"
                        f" โดยตรง — นำเสนอเป็นตัวเลือกเท่านั้น")
                kept.append(s)
            cands = kept
        # presentation order = canonical selection order verbatim —
        #   selection (retrieval_selection) เป็น ordering owner เดียว:
        #   request-iteration precedence + pick order (subject-first
        #   partition + form tier ใน pick loop) — ctx ไม่ re-derive
        #   form/role semantics
        if not cands:
            if i in decided or i in no_match:
                # verdict ยืนอยู่บน typed evidence — products หายเพราะ
                # gate ของ need เอง/need อื่นแต่ deterministic decision
                # (compat / no-match constraint) ครอบคลุม need แล้ว
                trace.append(f"need[{i}] verdict kept (products dropped)")
            else:
                unanswered.append(UnansweredNeed(
                    i, n.kind, n.operation, tuple(n.subject_refs or ()),
                    scope, target_of[i],
                    "no_evidence" if tainted else "no_selection",
                    capability_asks=tuple(
                        getattr(n, "capability_asks", ()) or ())))
            continue
        # ── FIX-5 type-ambiguous compat/recommend ask → typed clarify
        #   outcome (D2): need ไม่ declare product scope — need-level
        #   fields ว่างตาม contract ของแต่ละ kind + request ที่ attribute
        #   มาไม่พก type/subtype (compat need ไม่มี scope บนตัวเอง —
        #   relation scope เป็นของ request) — แต่ candidates ที่ผ่าน gate
        #   (selection/verdict-decided) กระจาย ≥2 canonical types →
        #   outcome = ถาม scope กลับ ไม่เลือก type ให้เอง — candidates
        #   ไม่ emit (scope undecided → cards ห้ามแนบตาม FIX-4); decided
        #   verdicts ของ need นี้ถูก clarify แทนที่ → pop (เซ็กเมนต์
        #   verdict ไม่ render เมื่อยังไม่รู้ว่าลูกค้าต้องการ type ไหน)
        if (n.kind == "compat"
                or (n.kind == "product" and n.operation == "recommend")):
            _scope_req = any(
                r.product_types or r.subtypes for r in reqs_n)
            if not (n.product_types or n.subtypes or _scope_req):
                _ctypes = tuple(sorted({
                    str((s.card or {}).get("canonical_type")
                        or (s.card or {}).get("product_type") or "")
                    for s in cands} - {""}))
                if len(_ctypes) >= 2:
                    unanswered.append(UnansweredNeed(
                        i, n.kind, n.operation,
                        tuple(n.subject_refs or ()), scope, target_of[i],
                        "clarify", clarify_types=_ctypes))
                    clarify.add(i)
                    decided.pop(i, None)
                    trace.append(f"need[{i}] clarify types={list(_ctypes)}")
                    continue
        # ── capability asks (typed contract: TurnNeed.capability_asks ←
        #   intent_classifier) — source-grounded spans: exact-subject
        #   attributed evidence มี → asks ride task (model แยก subclaim
        #   ตามหลักฐาน — partial evidence ไม่ใช่ blanket cannot-confirm);
        #   ไม่มี subject evidence → limitation note (ห้ามยืนยัน) +
        #   deterministic UnansweredNeed ที่ name ทุก ask — missing
        #   evidence = cannot-confirm เสมอ ไม่ใช่ negative claim
        _asks = tuple(getattr(n, "capability_asks", ()) or ())
        if _asks and not any(
                s.role == "subject" or s.identity in {
                    _s.identity for _r in reqs_n
                    for _s in by_req.get(_r.request_id, ())
                    if _s.role == "subject"}
                for s in cands):
            _lbl = ("ยังไม่มีข้อมูลยืนยัน " + "/".join(_asks) +
                    " ของรุ่นนี้ — ห้ามยืนยันเงื่อนไขนั้น")
            for s in cands:
                note_extra.setdefault(s.identity, []).append(_lbl)
            unanswered.append(UnansweredNeed(
                i, n.kind, n.operation, tuple(n.subject_refs or ()),
                scope, target_of[i], "no_evidence",
                capability_asks=_asks))
            _ask_unanswered.add(i)
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
            if s.identity in note_replace:
                card["_context_note"] = note_replace[s.identity]
            for extra in note_extra.get(s.identity, ()):
                card["_context_note"] = (
                    (card.get("_context_note") or "") + " — " + extra
                ).strip(" —")
            if s.identity in sf_extra:
                card["spec_facts"] = {
                    **sf_extra[s.identity],
                    **(card.get("spec_facts") or {})}
            card["need_indices"] = (i,)   # structural task ownership
            emitted[s.identity] = card
            took += 1
            products.append(card)
        trace.append(f"need[{i}] {n.kind}/{n.operation} "
                     f"cand={len(cands)} took={took}")
    # uncovered (no_evidence) + decided (verdict → deterministic segment)
    # ทั้งหมดไม่เป็น model task; evidence ที่ attribute เฉพาะ needs เหล่านี้
    # ไม่เข้า model context (proof/verdict ถูก consume โดย decision แล้ว) —
    #   no_match = candidates ทุกใบ proven-fail → deterministic constraint
    #   verdict ครอบคลุม (model ไม่ตัดสิน pass/fail เอง)
    # asks-only needs ที่ typed outcome ครอบคลุมแล้ว (UnansweredNeed
    # deterministic) ไม่ส่ง model task อีก — task เหลือแต่ framing
    # (subject/scope/target) → model freestyle hedge ซ้ำกับ segment;
    # เซ็ตเดิม + field เดิมเท่านั้น (facts/constraints/value/ranking
    # ที่เหลือ = model work จริง → task ยังอยู่)
    dropped = (uncovered | set(decided) | no_match | clarify
               | {t.need_index for t in task.tasks
                  if t.need_index in _ask_unanswered
                  and not (t.requested_facts or t.constraints
                           or t.value_constraints or t.ranking)})
    if dropped or _ask_unanswered:
        task = AnswerTask(
            tasks=tuple(
                (_dc_replace(t, capability_asks=())
                 if t.need_index in _ask_unanswered else t)
                for t in task.tasks
                if t.need_index not in dropped),
            deferred=task.deferred, trace=task.trace)
    evidence = _compile_evidence(
        pool, web_evidence, req_needs=req_needs, idx_of=idx_of,
        prodish_idx=prodish_idx, target_of=target_of,
        ref_needs=ref_needs, trace=trace)
    if dropped:
        kept_ev: list[dict] = []
        for e in evidence:
            idxs = tuple(j for j in e.get("need_indices", ())
                         if j not in dropped)
            if not idxs and e.get("need_indices"):
                trace.append(
                    f"evidence_dropped:uncovered_need "
                    f"kind={e.get('kind')}")
                continue
            e["need_indices"] = idxs
            kept_ev.append(e)
        evidence = kept_ev
    notes = tuple(dict(u) for u in (selection.unavailable_evidence or ()))
    payload = json.dumps(
        {"products": products, "evidence": evidence,
         "availability_notes": notes, "constraint_notes": cnotes,
         "task": task.render()},
        ensure_ascii=False, default=str)
    return AnswerContext(
        task=task, products=tuple(products), evidence=tuple(evidence),
        availability_notes=notes, unanswered_needs=tuple(unanswered),
        estimated_tokens=estimate_tokens(payload),
        trace=tuple(trace) + tuple(selection.trace or ()),
        compat_verdicts=tuple(v for i in sorted(decided)
                              for v in decided[i])
                         + tuple(product_verdicts),
        constraint_notes=tuple(cnotes),
        constraint_segments=tuple(det_segments),
        spec_measured_facts=tuple(
            {f"{f['identity']}|{f['fact_key']}": f
             for f in measured_facts}.values()))


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
        if e.get("kind") == "device_spec" \
                and isinstance(e.get("data"), dict):
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
            target = _need_target(n, reqs_n, profile) or next(
                (r.target_device for r in reqs_n if r.target_device),
                None)
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


# ── Phase 8 — typed answer composition (owner เดียว) ────────────────────────
# render order ของ segments: claim guidance ก่อน (collection-state message
#   จาก warranty flow — customer ต้องเห็นก่อน) → product answer → policy
#   conclusion ท้าย (ข้อสรุป eligibility ไม่นำหน้าคำตอบสินค้า)
_DOMAIN_ORDER = {"claim": 0, "compat": 1, "constraint": 2,
                 "product": 3, "policy": 4}


def _compat_segment(v: CompatVerdict) -> str:
    """deterministic verdict segment — subject display + target +
    outcome เท่านั้น (typed fields; ไม่มี proof dict/prose เสริม);
    wattage reason codes = connector fit แต่กำลังชาร์จยังไม่ครบสเปค →
    caveat clause ต่อท้าย segment เดิม (ห้าม render bare ใช้ได้):
    insufficient_wattage = รู้ watt ต่ำกว่า / wattage_variant_unconfirmed
    = หลาย variant ไม่ยืนยัน / missing_wattage_evidence = ไม่มี watt เลย"""
    if v.decision.outcome == "compatible":
        seg = f"{v.subject_name} ใช้งานร่วมกับ {v.target} ได้ค่ะ"
        _rc = set(v.decision.reason_codes or ())
        if "insufficient_wattage" in _rc:
            seg += (" — หัวต่อเข้ากันได้ แต่กำลังไฟที่ยืนยันได้ต่ำกว่า"
                    "สเปคของอุปกรณ์ จึงอาจชาร์จได้ช้ากว่าค่ะ")
        elif "wattage_variant_unconfirmed" in _rc:
            seg += (" — หัวต่อเข้ากันได้ แต่มีหลายตัวเลือกกำลังไฟ ยังไม่"
                    "ยืนยันตัวเลือกที่จะได้รับ จึงยืนยันเต็มสเปคไม่ได้ค่ะ")
        elif "missing_wattage_evidence" in _rc:
            seg += (" — หัวต่อเข้ากันได้ แต่ยังยืนยันไม่ได้ว่าชาร์จ"
                    "เต็มสเปคตามที่อุปกรณ์ต้องการ อาจชาร์จช้ากว่าปกติค่ะ")
        return seg
    if v.decision.outcome == "incompatible":
        return f"{v.subject_name} ใช้งานร่วมกับ {v.target} ไม่ได้ค่ะ"
    return ""   # outcome นอก whitelist → ไม่ render compat claim


def _constraint_segment(seg: dict) -> str:
    """deterministic no-match verdict segment — headline + labeled
    near-miss lines ของ decided-fail candidates ทุกใบ (evidence-bound
    labels เท่านั้น); ห้ามสัญญาแอดมินใน text (handoff = silent typed
    signal → transport ที่ enforce); ห้าม claim ร้านไม่มีสินค้า."""
    items = [f"- {it.get('item')}: {it.get('detail')}"
             for it in (seg.get("items") or ()) if it.get("item")]
    return "ยังไม่มีสินค้าที่ผ่านเงื่อนไขครบทุกข้อค่ะ" + (
        "\nใกล้เคียง/ทดแทนที่พิจารณาแล้ว:\n" + "\n".join(items)
        if items else "")


def _unanswered_segment(u: UnansweredNeed) -> str:
    """deterministic render ของ unresolved productish need — typed fields
    verbatim (target/subject_refs/scope) ไม่มี prose inference; deferred =
    domain owner อื่นรับผิดชอบ (policy/claim/order) ไม่ render ที่นี่;
    missing evidence = cannot-confirm เสมอ ไม่ใช่ negative claim;
    subject_refs = unresolved refs — named ref (model code ฯลฯ) name ได้,
    id/identity-key ref ไม่ raw-print (schema prefix/digit filter)"""
    if u.reason == "deferred":
        return ""
    refs = tuple(str(x).strip() for x in (u.subject_refs or ())
                 if str(x).strip())
    named = [x for x in refs if not x.isdigit() and ":" not in x]
    target = str(u.target or "").strip()
    if u.reason == "clarify":
        # D2 — decided candidates span ≥2 types + no requested scope:
        #   ถาม type กลับจาก canonical types เท่านั้น (name ผ่าน
        #   _type_query_word — owner เดิมของ type→Thai word; ไม่เลือก
        #   คำตอบให้เอง ไม่มี prose inference)
        from . import product_store as _ps
        _words = " หรือ ".join(dict.fromkeys(
            _ps._type_query_word(str(t))
            for t in (u.clarify_types or ()) if str(t).strip()))
        if not _words:
            return ""
        _pre = (f"สำหรับการใช้งานร่วมกับ {target}" if target
                else "สำหรับสินค้าที่ถาม")
        return f"{_pre} — อยากได้{_words}คะ"
    if u.reason == "no_selection":
        topic = named[0] if named else (
            str(u.scope[0]) if u.scope else "")
        thing = f"สินค้า {topic}" if topic else "สินค้าที่ตรงกับคำถามนี้"
        _asks_txt = " / ".join(str(a).strip() for a in (u.capability_asks or ())
                               if str(a).strip())
        if not _asks_txt:
            return f"ส่วน{thing} — ไม่พบข้อมูลในระบบของร้านค่ะ"
        # selection ว่างเทิร์นนี้ ≠ ร้านไม่มีสินค้า — name ask verbatim แล้ว
        #   บอกตรงๆ ว่าเทิร์นนี้ยังไม่มีข้อมูลตอบ (ไม่อ้าง absence/capability)
        return (f"ส่วน{thing} — {_asks_txt} — "
                f"ยังไม่พบข้อมูลของสินค้านี้ในเทิร์นนี้ จึงยังตอบไม่ได้ค่ะ")
    if u.operation == "compat" and target:
        if named:
            topic = (f"{' / '.join(named)} — "
                     f"การเชื่อมต่อหรือความเข้ากันได้กับ {target}")
        elif refs:
            # partial/whole unresolved โดยไม่มี named subject (refs เป็น
            #   id/sid) — scope กับส่วนที่ตรวจไม่ได้ ไม่ blanket ทั้ง target
            topic = (f"สินค้าที่ตรวจสอบไม่ได้ — "
                     f"การเชื่อมต่อหรือความเข้ากันได้กับ {target}")
        else:
            topic = f"การเชื่อมต่อหรือความเข้ากันได้กับ {target}"
    else:
        topic = named[0] if named else (
            str(u.scope[0]) if u.scope else "" or target)
    # capability asks = requested-area labels (typed verbatim จาก
    #   TurnNeed → UnansweredNeed — ไม่ใช่ prose re-parse): unresolved
    #   ask ทุกตัวต้องถูก name ใน outcome ของตัวเอง; ask span ที่มี target
    #   อยู่แล้ว (ownership = typed containment) → span เป็น topic หลัก —
    #   target named once ใน span เดิม ไม่ซ้ำใน clause intro
    if u.capability_asks:
        _asks_txt = " / ".join(str(a).strip() for a in u.capability_asks
                               if str(a).strip())
        if _asks_txt:
            _tn = "".join(target.split()).casefold()
            if _tn and _tn in "".join(_asks_txt.split()).casefold():
                _pre = " / ".join(named)
                topic = f"{_pre} — {_asks_txt}" if _pre else _asks_txt
            else:
                topic = f"{topic} — {_asks_txt}" if topic else _asks_txt
    when = f"สำหรับ{topic}" if topic else "สำหรับคำถามนี้"
    return (f"{when} — ไม่มีข้อมูลยืนยันจากข้อมูลสินค้าที่มี "
            f"จึงไม่สามารถยืนยันได้ค่ะ")


@dataclass(frozen=True)
class DomainResult:
    """typed per-need result — domain owner เดิมผลิต (composer ไม่สร้าง
    business logic): text = rendered segment (claim guidance / product
    answer); outcome = policy outcome — finalizer render ผ่าน render
    owner เดียว (guards.policy_outcome_text)."""
    domain: str                       # claim|product|policy
    need_indices: tuple[int, ...]     # 0-based need attribution
    text: str = ""
    outcome: str = ""
    # composition provenance (final acceptance) — deterministic segments
    #   ผลิตจาก typed owner (verdict/constraint/policy/claim) ไม่ต้องให้
    #   guard infer identity จาก prose: finalizer stamp ลง composition
    #   marker, enforce validate origin+exact text แล้ว exempt claims
    #   ใน span นั้น; model segments ยังผ่าน FieldEvidence checks
    origin: str = "model"             # deterministic|model
    subject_ids: tuple = ()           # owning identities ของ segment


@dataclass(frozen=True)
class AnswerComposition:
    """one typed composition contract ต่อ turn — input เดียวของ finalizer.
    results = needs ที่ domain owner ผลิต result จริง; unanswered_needs =
    needs ที่ไม่มี authoritative result (ห้าม invent); context =
    AnswerContext เดิม (product evidence boundary ไม่เปลี่ยน);
    products = decided-support attach set (covered-need cards +
    decided-compatible verdicts + labeled near-miss) — consumer เดียว
    app._finalize_answer (resp.products); ไม่ใช่ model context."""
    results: tuple[DomainResult, ...] = ()
    unanswered_needs: tuple[UnansweredNeed, ...] = ()
    products: tuple[dict, ...] = ()
    usage: dict = field(default_factory=dict)
    answer_calls: int = 0
    web_used: dict | None = None
    admission: WebAdmission | None = None
    context: AnswerContext | None = None
    trace: tuple[str, ...] = ()


def compose_answer(*, needs: tuple, context: AnswerContext | None = None,
                   product_text: str = "", policy_decision=None,
                   claim_guidance: str = "", usage: dict | None = None,
                   answer_calls: int = 0, web_used: dict | None = None,
                   admission: WebAdmission | None = None
                   ) -> AnswerComposition:
    """typed per-need results → AnswerComposition ครั้งเดียวต่อ turn.

    - claim_guidance (warranty-flow CONTINUE_PRODUCT carry) → claim
      result covering kind=="claim" needs
    - product_text (llm.answer_typed output) → product result covering
      ctx task needs ที่มี coverage (unanswered อยู่แล้วไม่ถูก cover)
    - policy_decision (policy_resolver output) → policy result covering
      kind=="policy" needs — outcome เท่านั้น (render = finalizer)
    - need ที่ไม่มี typed result → UnansweredNeed เดิม/ใหม่
      (deferred|no_selection) — ห้าม synthesize จาก prose/raw text
    """
    results: list[DomainResult] = []
    covered: set[int] = set()
    ctx_unanswered = list(context.unanswered_needs) if context else []
    unans_idx = {u.need_index for u in ctx_unanswered}
    if claim_guidance:
        idxs = tuple(i for i, n in enumerate(needs) if n.kind == "claim")
        covered.update(idxs)
        results.append(DomainResult(
            "claim", idxs, text=claim_guidance, origin="deterministic"))
    if context is not None:
        # typed compat verdicts → deterministic segment ต่อ need (ครั้ง
        # เดียวต่อ need — decision เป็น authoritative conclusion ไม่ใช่
        # boolean permission สำหรับ model)
        for v in context.compat_verdicts or ():
            seg = _compat_segment(v)
            if not seg:
                continue   # outcome นอก whitelist → ไม่ cover ด้วย claim ปลอม
            covered.add(v.need_index)
            results.append(DomainResult(
                "compat", (v.need_index,), text=seg,
                origin="deterministic", subject_ids=(v.subject_id,)))
        # typed no-match verdicts (evaluated candidates ทั้งหมด proven-
        # fail) → deterministic segment เช่นเดียวกับ compat verdict
        for seg in context.constraint_segments or ():
            text = _constraint_segment(seg)
            if text:
                covered.add(seg["need_index"])
                results.append(DomainResult(
                    "constraint", (seg["need_index"],), text=text,
                    origin="deterministic",
                    subject_ids=tuple(
                        str(it.get("identity")) for it in
                        (seg.get("items") or ()) if it.get("identity"))))
    # attachment follows decisions — comp.products = decided support
    #   เท่านั้น: cards ของ needs ที่ typed outcome ครอบคลุม (incl.
    #   product_text coverage) + identities ที่มี decided-compatible
    #   verdict (partial-compat: item ที่ตัดสินแล้วยังเป็นคำตอบ) +
    #   labeled near-miss cards จาก constraint segments; emitted-only
    #   cards ของ unresolved needs ไม่แนบ/ไม่ bubble — card = outcome
    #   evidence, ยังไม่ตัดสิน = ยังไม่มีสิทธิ์แสดง
    _support: list[dict] = []
    _near: list[dict] = []
    if context is not None:
        from . import candidate_pool as _cpool
        _cov = set(covered) | (
            ({t.need_index for t in context.task.tasks} - unans_idx)
            if product_text else set())
        _cov = {i for i in _cov
                if needs[i].kind in PRODUCTISH_NEED_KINDS}
        _vok = {v.subject_id for v in (context.compat_verdicts or ())
                if v.decision.outcome == "compatible"}
        _seen: set[str] = set()
        for _p in context.products:
            _pid = _cpool._identity_key(_p)[0] or ""
            if _pid and _pid not in _seen and (
                    _pid in _vok
                    or set(_p.get("need_indices") or ()) & _cov):
                _support.append(_p)
                _seen.add(_pid)
        for _seg in context.constraint_segments or ():
            for _it in _seg.get("items") or ():
                _c = _it.get("card")
                if not _c:
                    continue
                _pid = _cpool._identity_key(_c)[0] or ""
                if _pid and _pid not in _seen:
                    _near.append(_c)
                    _seen.add(_pid)
    if product_text and context is not None:
        idxs = tuple(sorted(
            {t.need_index for t in context.task.tasks} - unans_idx))
        covered.update(idxs)
        # model text = prose เท่านั้น — single protocol-boundary
        #   normalization (ไม่ใช่ Markdown parser): bubble ที่มี link/
        #   image markup (`](`) = card-attempt → drop ทั้ง bubble (fail
        #   closed — strip แล้วเหลือ name debris ซ้ำกับ deterministic
        #   card); bubble ที่เหลือแต่ชื่อ product ตรง typed card = model
        #   echo → drop; `**` residual ของ model → strip (emphasis ไม่ใช่
        #   ช่องทางของ model — claim mutation ไม่เคยอยู่ใน markup);
        #   deterministic segments ไม่ผ่าน normalization นี้ —
        #   model-emitted prose อื่น (รวม leading particle) เป็น
        #   model-output residual ไม่ใช่ compose concern;
        #   H1: bubble ที่ co-mention (subject_name,target) ของ decided
        #   compat verdict = model พูดซ้ำ/ขัด domain ที่ typed owner
        #   ตัดสินแล้ว → drop เหมือน name-echo rule (typed fields เท่านั้น
        #   — co-mention อย่างเดียว ไม่ต้องอ่าน polarity; verdict segment
        #   render truth เดียวกันอยู่แล้ว)
        _names = {re.sub(r"\s+", " ", str(p.get("name") or "")).strip()
                  for p in context.products}
        _names.discard("")
        _pairs = tuple(
            (re.sub(r"\s+", " ", str(v.subject_name or "")).strip()
             .casefold(),
             re.sub(r"\s+", " ", str(v.target or "")).strip().casefold())
            for v in (context.compat_verdicts or ())
            if v.decision.outcome in ("compatible", "incompatible"))
        _out = []
        for _b in product_text.split("|||"):
            if "](" in _b:
                continue
            _b = re.sub(r"\s+", " ", _b.replace("**", "")).strip()
            _bl = _b.casefold()
            if any(_s and _t and _s in _bl and _t in _bl
                   for _s, _t in _pairs):
                continue
            if _b and _b not in _names:
                _out.append(_b)
        _ptext = " ||| ".join(_out)
        results.append(DomainResult("product", idxs, text=_ptext))
        # deterministic product cards — render owner เดียวของ card/link/
        #   image: composed จาก typed card fields ที่ eligibility เลือก
        #   แล้วเท่านั้น — model ไม่เป็นเจ้าของ CTA markup; claim
        #   validation ไม่เคยแตะ card spans (origin=deterministic +
        #   provenance identities); card ไม่ cover need เพิ่ม — ติดตาม
        #   product result (owner = card's own need_indices)
        for _p in _support:
            _pn = str(_p.get("name") or "").strip()
            _img = str(_p.get("image_url") or "").strip()
            _lnk = str(_p.get("short_link") or "").strip()
            if not _pn or not (_img or _lnk):
                continue   # card ต้องมี name + CTA evidence อย่างน้อย 1
            _lines = [f"**{_pn}**"]
            if _img:
                _lines.append(f"![{_pn}]({_img})")
            if _lnk:
                _lines.append(f"[สั่งซื้อ {_pn}]({_lnk})")
            _pid = _cpool._identity_key(_p)[0] or None
            results.append(DomainResult(
                "product", tuple(_p.get("need_indices") or ()),
                text="|||\n" + "\n".join(_lines),
                origin="deterministic",
                subject_ids=(_pid,) if _pid else ()))
    if policy_decision is not None:
        idxs = tuple(i for i, n in enumerate(needs) if n.kind == "policy")
        covered.update(idxs)
        results.append(DomainResult(
            "policy", idxs, outcome=policy_decision.outcome,
            origin="deterministic"))
    results.sort(key=lambda r: _DOMAIN_ORDER.get(r.domain, 9))
    if context is not None:
        unanswered = [u for u in ctx_unanswered
                      if u.need_index not in covered
                      or (u.reason == "no_evidence" and u.subject_refs)]
        if not product_text:
            # task need มี coverage แต่ไม่มี product result (answer เท่า
            # "") — ต้อง surface เป็น unanswered ไม่ให้หายทั้ง need
            present = {u.need_index for u in unanswered}
            unanswered += [
                UnansweredNeed(t.need_index, t.kind, t.operation,
                               t.subject_refs, t.scope, t.target,
                               "no_answer",
                               capability_asks=t.capability_asks)
                for t in context.task.tasks
                if t.need_index not in covered
                and t.need_index not in present]
        unanswered = tuple(unanswered)
    else:
        unanswered = tuple(
            UnansweredNeed(
                i, n.kind, n.operation, tuple(n.subject_refs or ()),
                _need_scope(n), None,
                "deferred" if n.kind in _POLICY_NEED_KINDS
                else "no_selection",
                capability_asks=tuple(n.capability_asks or ()))
            for i, n in enumerate(needs) if i not in covered)
    trace = tuple(context.trace if context else ()) + tuple(
        f"compose {r.domain} needs={list(r.need_indices)}"
        for r in results)
    return AnswerComposition(
        results=tuple(results), unanswered_needs=unanswered,
        products=tuple(_support + _near),
        usage=dict(usage or {}), answer_calls=answer_calls,
        web_used=web_used, admission=admission, context=context,
        trace=trace)
