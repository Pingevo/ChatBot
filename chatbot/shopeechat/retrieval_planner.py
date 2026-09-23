"""Offline grouped-retrieval request planner — Task 5A prototype.

รับ RetrievalProfile/RetrievalSlot/RetrievalRelation → per-slot/per-relation
RetrievalRequest (immutable) — contract/observe-only: ไม่เรียก Mongo, ไม่เรียก
LLM, ไม่ fetch จริง, ไม่มี runtime caller — wiring จริงอยู่ Task 5B
"""
from __future__ import annotations

from dataclasses import dataclass

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
    confidence: float = 1.0


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
                  src_sub: str | None = None) -> RetrievalRequest | None:
    """base request จาก slot — skip slot ที่ไม่มีอะไรให้ค้น (ไม่มี type/code);
    src_sub (จาก relation source_subtype) แคบ subtype เหลือฝั่ง source"""
    if not slot.product_types and not slot.model_codes:
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
        availability_mode=slot.availability_mode,
        compat_mode=slot.compat_mode,
        hard_filters=tuple(hard),
        soft_hints=tuple(soft),
        confidence=slot.confidence,
    )


def _relation_request(req_id: str, rel_id: str, rel: RetrievalRelation,
                      slots: tuple[RetrievalSlot, ...]) -> RetrievalRequest:
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
        confidence=rel.confidence,
    )


def build_grouped_retrieval_requests(
        profile: RetrievalProfile,
        slots: tuple[RetrievalSlot, ...],
        relations: tuple[RetrievalRelation, ...]
) -> tuple[RetrievalRequest, ...]:
    """profile + slots + relations → retrieval requests (observe-only).

    policy: model_codes=hard identity · product_type hard เฉพาะ conf≥0.8 ·
    target_device/brand/model_term/subtype/constraints = soft (ห้ามตัด
    candidate ใน 5A) · relation target = product-group request (codes ว่าง)
    · shop/platform อยู่ใน profile ไม่ซ้ำใน request · ไม่ mutate input
    """
    reqs: list[RetrievalRequest] = []
    src_sub = {rel.source_slot_id: dict(rel.constraints)["source_subtype"]
               for rel in relations
               if "source_subtype" in dict(rel.constraints)}
    for i, s in enumerate(slots):
        r = _slot_request(f"req-{i}", s, src_sub.get(s.slot_id))
        if r is not None:
            reqs.append(r)
    for j, rel in enumerate(relations):
        reqs.append(_relation_request(f"req-{len(reqs)}", f"rel-{j}", rel,
                                      slots))
    return tuple(reqs)
