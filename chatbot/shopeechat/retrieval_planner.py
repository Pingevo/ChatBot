"""Offline grouped-retrieval request planner — Task 5A prototype.

รับ RetrievalProfile/RetrievalSlot/RetrievalRelation → per-slot/per-relation
RetrievalRequest (immutable) — contract/observe-only: ไม่เรียก Mongo, ไม่เรียก
LLM, ไม่ fetch จริง, ไม่มี runtime caller — wiring จริงอยู่ Task 5B
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from .route_context import (
    RetrievalProfile,
    RetrievalRelation,
    RetrievalSlot,
)


@dataclass(frozen=True)
class RetrievalRequest:
    """คำขอ retrieval หนึ่งชิ้นต่อ slot/relation — ยังไม่ execute."""
    request_id: str
    slot_id: str
    source: str                       # "slot" | "relation_target"
    product_types: frozenset[str]
    subtypes: frozenset[str]
    model_codes: tuple[str, ...]
    target_device: str | None
    availability_mode: str
    compat_mode: str
    hard_filters: tuple[tuple[str, str], ...] = ()
    soft_hints: tuple[tuple[str, str], ...] = ()
    relation_id: str | None = None
    relation_type: str | None = None   # RetrievalRelation.relation_type verbatim
    confidence: float = 1.0
    variant_terms: tuple[str, ...] = ()   # requested option(s) — canonical adapter
    # typed value constraints (งบ/ช่วงราคา) — owner: RetrievalProfile ที่
    # planner stamp ลงมา; executor ส่งต่อให้ fetch ผ่าน synthetic profile
    value_constraints: tuple[tuple[str, int], ...] = ()
    # typed roles — owner = TurnNeed.subject_refs/target_refs verbatim (r8)
    subject_refs: tuple[str, ...] = ()
    target_refs: tuple[str, ...] = ()
    # typed spec contract — verbatim จาก RetrievalSlot (owner chain:
    #   intent → TurnNeed → slot → request; eval ที่ AnswerContext ผ่าน
    #   policy_resolver.eval_spec_constraints)
    spec_constraints: tuple[tuple[str, str, float], ...] = ()
    required_features: tuple[str, ...] = ()


def _slot_types(slots: tuple[RetrievalSlot, ...], slot_id: str
                ) -> frozenset[str]:
    """product_types ของ slot_id — virtual slot (ไม่มี backing) อ่านจากชื่อ"""
    for s in slots:
        if s.slot_id == slot_id:
            return s.product_types
    if slot_id.startswith("slot-"):
        return frozenset({slot_id[5:]})
    return frozenset()


def _slot_request(req_id: str, slot: RetrievalSlot,
                  src_sub: str | None = None,
                  value_constraints: tuple = ()) -> RetrievalRequest | None:
    """base request จาก slot — skip slot ที่ไม่มีอะไรให้ค้น (ไม่มี type/code/
    typed subject refs); src_sub (จาก relation source_subtype)
    แคบ subtype เหลือฝั่ง source"""
    if (not slot.product_types and not slot.model_codes
            and not slot.subject_refs):
        return None
    subtypes = frozenset({src_sub}) if src_sub else slot.subtypes
    hard: list[tuple[str, str]] = []
    soft: list[tuple[str, str]] = []
    for c in slot.model_codes:
        hard.append(("model_code", c))
    for t in sorted(slot.product_types):
        # explicit type เป็น hard filter เฉพาะ slot confidence สูง
        (hard if slot.confidence >= 0.8 else soft).append(("product_type", t))
    if slot.target_device:
        soft.append(("target_device", slot.target_device))
    for b in slot.brand_hints:
        soft.append(("brand", b))
    for mt in slot.model_terms:
        soft.append(("model_term", mt))
    return RetrievalRequest(
        request_id=req_id,
        slot_id=slot.slot_id,
        source="slot",
        product_types=slot.product_types,
        subtypes=subtypes,
        model_codes=slot.model_codes,
        target_device=slot.target_device,
        subject_refs=slot.subject_refs,
        target_refs=slot.target_refs,
        availability_mode=slot.availability_mode,
        compat_mode=slot.compat_mode,
        hard_filters=tuple(hard),
        soft_hints=tuple(soft),
        confidence=slot.confidence,
        variant_terms=slot.variant_terms,
        value_constraints=tuple(value_constraints),
        spec_constraints=tuple(getattr(slot, "spec_constraints", ()) or ()),
        required_features=tuple(
            getattr(slot, "required_features", ()) or ()),
    )


def _relation_request(req_id: str, rel_id: str, rel: RetrievalRelation,
                      slots: tuple[RetrievalSlot, ...],
                      value_constraints: tuple = ()) -> RetrievalRequest:
    """target request จาก relation — target คือ product GROUP (ไม่ใช่ code);
    constraints เป็น soft hints, target_subtype เข้า subtypes"""
    types = _slot_types(slots, rel.target_slot_id)
    subtypes = frozenset(
        v for k, v in rel.constraints if k == "target_subtype")
    hard: list[tuple[str, str]] = []
    # source_subtype = metadata ฝั่ง source (ใช้โดย _slot_request) ไม่ใช่ hint เป้าหมาย
    soft = [(k, v) for k, v in rel.constraints if k != "source_subtype"]
    for t in sorted(types):
        (hard if rel.confidence >= 0.8 else soft).append(("product_type", t))
    target_slot = next((s for s in slots if s.slot_id == rel.target_slot_id),
                       None)
    return RetrievalRequest(
        request_id=req_id,
        slot_id=rel.target_slot_id,
        source="relation_target",
        product_types=types,
        subtypes=subtypes,
        model_codes=(),
        target_device=target_slot.target_device if target_slot else None,
        availability_mode=(target_slot.availability_mode if target_slot
                           else "sellable_first"),
        compat_mode=(target_slot.compat_mode if target_slot else "none"),
        hard_filters=tuple(hard),
        soft_hints=tuple(soft),
        relation_id=rel_id,
        relation_type=rel.relation_type,
        confidence=rel.confidence,
        variant_terms=(target_slot.variant_terms if target_slot else ()),
        value_constraints=tuple(value_constraints),
        spec_constraints=tuple(
            getattr(target_slot, "spec_constraints", ()) or ())
            if target_slot else (),
        required_features=tuple(
            getattr(target_slot, "required_features", ()) or ())
            if target_slot else (),
    )


def channel_request(name: str) -> RetrievalRequest:
    """synthetic request สำหรับ evidence channel (subjects/compat/kb/...) —
    selector iterates RetrievalRequest rows เท่านั้น จึงต้องมี row ของตัวเอง;
    filters ว่างทั้งหมด → candidate bucket ด้วย availability + type guard
    ของ card เท่านั้น (channel fetcher มีสิทธิ์ scoped อยู่แล้ว)"""
    return RetrievalRequest(
        request_id=f"ch:{name}",
        slot_id=name,
        source=name,
        product_types=frozenset(),
        subtypes=frozenset(),
        model_codes=(),
        target_device=None,
        availability_mode="",
        compat_mode="")


def build_grouped_retrieval_requests(
        profile: RetrievalProfile,
        slots: tuple[RetrievalSlot, ...],
        relations: tuple[RetrievalRelation, ...],
        needs: tuple = (),
) -> tuple[RetrievalRequest, ...]:
    """profile + slots + relations → retrieval requests (observe-only).

    policy: model_codes=hard identity · product_type hard เฉพาะ conf≥0.8 ·
    target_device/brand/model_term/subtype/constraints = soft (ห้ามตัด
    candidate ใน 5A) · relation target = product-group request (codes ว่าง)
    · shop/platform อยู่ใน profile ไม่ซ้ำใน request · ไม่ mutate input
    needs = TurnNeed tuple — type/subtype ที่ need declare เป็น typed
    evidence (ไม่ใช่ prose inference) → model_terms merge ห้าม demote
    product_type ที่ need declare
    """
    reqs: list[RetrievalRequest] = []
    vc = tuple(getattr(profile, "value_constraints", ()) or ())
    src_sub = {rel.source_slot_id: dict(rel.constraints)["source_subtype"]
               for rel in relations
               if "source_subtype" in dict(rel.constraints)}
    for i, s in enumerate(slots):
        r = _slot_request(f"req-{i}", s, src_sub.get(s.slot_id),
                          value_constraints=vc)
        if r is not None:
            reqs.append(r)
    for j, rel in enumerate(relations):
        reqs.append(_relation_request(f"req-{len(reqs)}", f"rel-{j}", rel,
                                      slots, value_constraints=vc))
    # unverified phrase evidence (profile.model_terms) — soft hints เท่านั้น:
    # merge เข้า slot request ที่มีอยู่ (fetch recall ผ่าน message อยู่แล้ว —
    # ห้ามสร้าง physical fetch ซ้ำสำหรับ source/query เดียวกัน); open request
    # เฉพาะเมื่อไม่มี slot request เลย (named-product-only turn)
    named = tuple(getattr(profile, "model_terms", ()) or ())
    if named:
        from .route_context import requested_product_types
        hints = tuple(("model_term", t) for t in named)
        # need-declared scope = typed evidence ไม่ใช่ prose inference —
        #   demote ข้างล่างป้องกัน inferred type เท่านั้น; type/subtype ที่
        #   need declare ต้องคงเป็น hard filter (owner: TurnNeed)
        from .turn_decision import PRODUCTISH_NEED_KINDS as _PK
        from .units import _SUBTYPE_TO_TYPES
        need_types: set[str] = set()
        for n in needs or ():
            if getattr(n, "kind", None) not in _PK:
                continue
            need_types |= set(getattr(n, "product_types", ()) or ())
            for s in getattr(n, "subtypes", ()) or ():
                need_types |= _SUBTYPE_TO_TYPES.get(s, set())
        if any(r.source == "slot" for r in reqs):
            merged: list[RetrievalRequest] = []
            for r in reqs:
                if r.source != "slot":
                    merged.append(r)
                    continue
                slot = next((s for s in slots if s.slot_id == r.slot_id),
                            None)
                # type provenance: kw noun = explicit product request (hard);
                # regex-inferred type (model/device phrase เช่น "W01"→watch)
                # = evidence ที่ infer มา — เมื่อ named phrase merge เข้า
                # request เดียวกัน inferred type ต้องไม่ hard-constrain
                # product ที่ type จริงยังไม่รู้ → demote เป็น soft hint
                kw_types = (requested_product_types(
                    slot.source_span, explicit_only=True)
                    if slot is not None else frozenset())
                inferred = (set(r.product_types) - set(kw_types)
                            - need_types)
                soft = list(r.soft_hints)
                hard = [h for h in r.hard_filters
                        if h[0] != "product_type" or h[1] not in inferred]
                for t in sorted(inferred):
                    if ("product_type", t) not in soft:
                        soft.append(("product_type", t))
                soft.extend(h for h in hints if h not in soft)
                merged.append(replace(
                    r,
                    product_types=frozenset(
                        t for t in r.product_types if t not in inferred),
                    hard_filters=tuple(hard), soft_hints=tuple(soft)))
            reqs = merged
        else:
            # typed roles จาก slots verbatim — open request ต้องพก target/
            # subject ของ turn ด้วย (ไม่ parse message ซ้ำ)
            _refs = tuple(dict.fromkeys(
                r for s in slots for r in s.subject_refs))
            _trefs = tuple(dict.fromkeys(
                r for s in slots for r in s.target_refs))
            reqs.append(RetrievalRequest(
                request_id=f"req-{len(reqs)}",
                slot_id="named_terms",
                source="slot",
                product_types=frozenset(),
                subtypes=frozenset(),
                model_codes=(),
                target_device=_trefs[0] if len(_trefs) == 1 else None,
                availability_mode=profile.availability_mode,
                compat_mode="none",
                soft_hints=hints,
                confidence=0.6,
                value_constraints=vc,
                subject_refs=_refs,
                target_refs=_trefs,
                spec_constraints=tuple(dict.fromkeys(
                    c for s in slots
                    for c in getattr(s, "spec_constraints", ()) or ())),
                required_features=tuple(dict.fromkeys(
                    f for s in slots
                    for f in getattr(s, "required_features", ()) or ())),
            ))
    return tuple(reqs)
