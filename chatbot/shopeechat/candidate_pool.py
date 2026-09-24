"""candidate_pool.py — central candidate pool (Task 5B2, observe-only).

รวม evidence จากทุก source (units/legacy/…) ที่ executor เก็บต่อ request
→ dedupe ตาม identity → rank อธิบายได้ → แยก A/B boundary:

A) candidate_pool — product candidates ต่อ request (eligible/unavailable/rejected)
B) evidence_pool — anchor/KB/image-text attachments (ต้องมี product identity)
   + supporting_evidence (kb_qa/kb_raw — contract เท่านั้น ยังไม่ populate)

private evidence (``_evidence``/``_selection_reason``) อยู่ใน card —
LLM boundary ใช้ ``llm_ready()`` ที่ strip ผ่าน retrieval_policy
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .retrieval_executor import RetrievalExecutionResult


@dataclass(frozen=True)
class PooledCandidate:
    """candidate เดียวหลัง dedupe+rank — ไม่ mutate card ต้นทาง"""
    identity: str                     # dedupe key ที่ชนะ
    item_id: str | None
    model_id: str | None
    unit_id: str | None
    sources: tuple[str, ...]          # _evidence.sources รวมทุก source
    request_ids: tuple[str, ...]
    slot_id: str
    relation_id: str | None
    product_type: str | None
    subtype: str | None
    bucket: str                       # eligible/unavailable/rejected
    reason: str
    score: float
    trace: tuple[str, ...]
    card: dict
    is_anchor: bool = False


@dataclass(frozen=True)
class EvidenceAttachment:
    """group-B evidence — anchor/KB/image-text ที่ผูกกับ candidate/identity"""
    kind: str                         # "anchor" | "kb_product" | "image_text"
    identity: str
    item_id: str | None
    linked_candidate: str | None      # identity ของ candidate ที่ attach
    trace: tuple[str, ...] = ()


@dataclass(frozen=True)
class CandidatePool:
    """output กลาง — candidates แยก bucket + evidence attachments + supporting"""
    eligible: tuple[PooledCandidate, ...]
    unavailable: tuple[PooledCandidate, ...]
    rejected: tuple[PooledCandidate, ...]
    by_request: tuple[tuple[str, tuple[PooledCandidate, ...]], ...]
    evidence_pool: tuple[EvidenceAttachment, ...]
    supporting_evidence: tuple[dict, ...]   # kb_qa/kb_raw — 5B3 populate
    trace: tuple[str, ...]

    def llm_ready(self) -> list[dict]:
        """eligible cards ที่ strip private evidence แล้ว — boundary เดียว"""
        from .retrieval_policy import strip_private_evidence
        return strip_private_evidence([c.card for c in self.eligible])


def _card_ids(card: dict) -> tuple[str | None, str | None, str | None]:
    """(unit_id, model_id, item_id) — float-int normalized เหมือน _evidence"""
    from .retrieval_policy import _norm_id
    def _s(v):
        return _norm_id(v) if v is not None else None
    return _s(card.get("unit_id")), _s(card.get("model_id")), \
        _s(card.get("item_id"))


def _norm_name(card: dict) -> str:
    return re.sub(r"\s+", " ", (card.get("name") or "").lower()).strip()


def _merge_group(group: list[dict]) -> dict:
    """รวม cards identity เดียวกัน — keep card ที่ sellable/richer + merge sources"""
    def _rich(c):
        return (bool(c.get("_available_for_sale")),
                bool(c.get("canonical_specs") or c.get("image_text")),
                len(c))
    best = max(group, key=_rich)
    sources: list[str] = []
    for c in group:
        for s in (c.get("_evidence") or {}).get("sources", []):
            if s not in sources:
                sources.append(s)
    merged = dict(best)
    if len(sources) > 1 or (best.get("_evidence") or {}).get("sources") != sources:
        ev = dict(best.get("_evidence") or {})
        ev["sources"] = sources
        merged["_evidence"] = ev
    return merged


def _score(card: dict, res: RetrievalExecutionResult, anchor: bool,
           anchor_priority: bool) -> tuple[float, list[str]]:
    """rank score อธิบายได้ — hard reject ไม่เข้ามาแล้ว"""
    s, why = 0.0, []
    if anchor:
        s += 3.0 if anchor_priority else 1.0
        why.append("anchor")
    codes = set(res.model_codes) & set(card.get("model_codes") or [])
    if codes:
        s += 2.0
        why.append(f"code:{next(iter(codes))}")
    csub = card.get("charger_subtype") or card.get("cable_subtype")
    if csub and csub in res.subtypes:
        s += 1.0
        why.append(f"subtype:{csub}")
    if res.target_device:
        from .device_compat import _extract_device_token
        if _extract_device_token(card.get("name") or "") == res.target_device:
            s += 1.0
            why.append("device")
    if res.relation_id:
        s += 0.5
        why.append("relation_target")
    if card.get("_available_for_sale"):
        s += 0.5
        why.append("sellable")
    ns = len((card.get("_evidence") or {}).get("sources", []))
    if ns > 1:
        s += 0.2 * (ns - 1)
        why.append(f"sources:{ns}")
    s += float(card.get("_score") or 0.0)
    return s, why


def build_candidate_pool(
    results: tuple[RetrievalExecutionResult, ...],
    *,
    profile=None,
    per_request_limit: int | None = None,
) -> CandidatePool:
    """execution results → pool กลาง (observe-only, ไม่ mutate input).

    dedupe identity: unit_id/model_id (variant) → item_id (listing) →
    norm name+shop · variant ต่าง unit/model id ไม่ merge · item-level card
    merge เข้า variant ของ item เดียวกัน · ต่าง item ไม่ merge
    """
    from .retrieval_policy import _norm_id
    anchor_ids = {_norm_id(i) for i in
                  (getattr(profile, "anchor_item_ids", ()) or ())}
    intent = (getattr(profile, "intent", "") or "").lower()
    anchor_priority = bool(anchor_ids) and any(
        k in intent for k in ("spec", "warrant", "compar", "histor", "follow"))
    elig_out: list[PooledCandidate] = []
    unav_out: list[PooledCandidate] = []
    rej_out: list[PooledCandidate] = []
    by_req: list[tuple[str, tuple[PooledCandidate, ...]]] = []
    evidence: list[EvidenceAttachment] = []
    trace: list[str] = []
    for res in results:
        # ── dedupe ภายใน request (รวม cross-source) — พก bucket ที่ executor
        #    ตัดสินไว้ ห้าม re-derive จาก _available_for_sale ──
        merged: list[list[tuple[dict, str]]] = []
        var_idx: dict[str, int] = {}      # unit/model id → merged idx
        item_owner: dict[str, int] = {}   # item_id → merged idx
        cards_by_bucket = (
            [(c, "eligible") for c in res.eligible_candidates]
            + [(c, "unavailable") for c in res.unavailable_evidence]
            + [(c, "rejected") for c in res.rejected_evidence])
        for card, bkt in cards_by_bucket:
            uid, mid, iid = _card_ids(card)
            keys = [k for k in (f"u:{uid}" if uid else None,
                              f"m:{mid}" if mid else None) if k]
            idx = None
            for k in keys:
                if k in var_idx:
                    idx = var_idx[k]
                    break
            if idx is None and not keys and iid and iid in item_owner:
                # listing-level card (ไม่มี unit/model id) merge เข้า variant เดิม
                idx = item_owner[iid]
            if idx is None:
                idx = len(merged)
                merged.append([(card, bkt)])
                for k in keys:
                    var_idx[k] = idx
                if iid and iid not in item_owner:
                    item_owner[iid] = idx
            else:
                merged[idx].append((card, bkt))
        pooled: list[PooledCandidate] = []
        for group in merged:
            card = _merge_group([c for c, _ in group])
            uid, mid, iid = _card_ids(card)
            identity = uid or mid or iid \
                or f"name:{_norm_name(card)}:{card.get('shop') or ''}"
            ev = card.get("_evidence") or {}
            sources = tuple(ev.get("sources") or ["unknown"])
            reasons = [c.get("_selection_reason") or "" for c, _ in group]
            # bucket = ดีที่สุดในกลุ่ม (eligible > unavailable > rejected)
            buckets = {b for _, b in group}
            bucket = ("eligible" if "eligible" in buckets else
                      "unavailable" if "unavailable" in buckets else "rejected")
            is_anchor = bool(anchor_ids) and iid in anchor_ids
            sc, why = _score(card, res, is_anchor, anchor_priority)
            if is_anchor:
                evidence.append(EvidenceAttachment(
                    kind="anchor", identity=identity, item_id=iid,
                    linked_candidate=identity,
                    trace=(f"profile.anchor_item_ids:{iid}",)))
            if card.get("canonical_specs"):
                evidence.append(EvidenceAttachment(
                    kind="kb_product", identity=identity, item_id=iid,
                    linked_candidate=identity, trace=("canonical_specs",)))
            if card.get("image_text"):
                evidence.append(EvidenceAttachment(
                    kind="image_text", identity=identity, item_id=iid,
                    linked_candidate=identity, trace=("image_text",)))
            csub = card.get("charger_subtype") or card.get("cable_subtype")
            pooled.append(PooledCandidate(
                identity=identity, item_id=iid, model_id=mid, unit_id=uid,
                sources=sources, request_ids=(res.request_id,),
                slot_id=res.slot_id, relation_id=res.relation_id,
                product_type=card.get("product_type"), subtype=csub,
                bucket=bucket,
                reason=next((r for r in reasons if r not in ("ok", "")), "ok"),
                score=sc,
                trace=tuple([f"why:{w}" for w in why]
                            + ([f"merged:{len(group)}"] if len(group) > 1 else [])),
                card=card, is_anchor=is_anchor))
        pooled.sort(key=lambda c: c.score, reverse=True)
        if per_request_limit is not None:
            pooled = pooled[:per_request_limit]
        for c in pooled:
            (elig_out if c.bucket == "eligible"
             else unav_out if c.bucket == "unavailable" else rej_out).append(c)
        by_req.append((res.request_id,
                       tuple(c for c in pooled if c.bucket == "eligible")))
        trace.append(f"{res.request_id}: merged={len(merged)} "
                     f"elig={sum(1 for c in pooled if c.bucket == 'eligible')}")
    elig_out.sort(key=lambda c: c.score, reverse=True)
    unav_out.sort(key=lambda c: c.score, reverse=True)
    rej_out.sort(key=lambda c: c.score, reverse=True)
    return CandidatePool(
        eligible=tuple(elig_out), unavailable=tuple(unav_out),
        rejected=tuple(rej_out), by_request=tuple(by_req),
        evidence_pool=tuple(evidence), supporting_evidence=(),
        trace=tuple(trace))
