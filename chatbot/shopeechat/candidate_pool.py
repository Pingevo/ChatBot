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
    identity: str                     # candidate key ที่ชนะ (v:/u:/i:/n:)
    item_id: str | None
    model_id: str | None
    unit_id: str | None
    sources: tuple[str, ...]          # _evidence.sources รวมทุก source
    request_ids: tuple[str, ...]      # ทุก request ที่ contribute identity นี้
    slot_id: str                      # slot ของ request ที่ score ดีสุด (per-request slot → ดู req ใน selector)
    relation_id: str | None
    product_type: str | None
    subtype: str | None
    bucket: str                       # eligible/unavailable/rejected
    reason: str
    score: float                      # max per-request score
    trace: tuple[str, ...]
    card: dict
    is_anchor: bool = False
    identity_quality: str = ""        # "name_only" เมื่อ key=n: (low confidence)
    linked_item_id: str | None = None  # item_id ของ variant candidates
    request_scores: tuple[tuple[str, float], ...] = ()  # (request_id, score) ต่อ contributing request


@dataclass(frozen=True)
class EvidenceAttachment:
    """group-B evidence — anchor/KB/image-text/listing ที่ผูกกับ candidate/identity"""
    kind: str                         # "anchor" | "kb_product" | "image_text" | "listing" | "subject_snapshot"
    identity: str                     # attachment identity key (i:/v:/n:)
    item_id: str | None
    linked_candidate: str | None      # identity ของ candidate ที่ attach
    identity_domain: str = ""         # "item" | "model" | "name" | "" (self)
    payload: dict | None = None       # bounded evidence (specs/snapshot)
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


def _identity_key(card: dict) -> tuple[str, str]:
    """candidate identity (owner เดียว) — finest-grained key เดียวต่อ card.

    unit_id → u:{uid} (unit_id รูป item:model → v:{iid}#{mid} canonical
    เดียวกับ item_id+model_id) · item_id+model_id → v:{iid}#{mid} ·
    item_id เดี่ยว → i:{iid} (listing-level เท่านั้น) · ไม่มี stable id
    → n:{shop}:{norm_name} (low confidence) · model_id เดี่ยวไม่เคยเป็น
    identity (model_sku ชนข้าม item ได้) · merge iff key เดียวกันเท่านั้น

    Returns (key, domain) — domain ∈ {"variant","item","name"} ·
    key="" = ไม่มี identity (ไม่ merge กับใคร)
    """
    from .retrieval_policy import _norm_id
    uid, mid, iid = _card_ids(card)
    if uid:
        if ":" in uid:
            p, m = uid.split(":", 1)
            return f"v:{_norm_id(p)}#{_norm_id(m)}", "variant"
        return f"u:{uid}", "variant"
    if iid and mid:
        return f"v:{iid}#{mid}", "variant"
    if iid:
        return f"i:{iid}", "item"
    name = _norm_name(card)
    if name:
        return f"n:{card.get('shop') or ''}:{name}", "name"
    return "", ""


def _join_attachment(att: EvidenceAttachment, pooled: list[PooledCandidate]
                     ) -> list[EvidenceAttachment]:
    """resolve attachment → candidate identities ตาม identity_domain —
    item → ทุก variant ของ item · model → variant ที่ตรง (fallback listing
    i:) · name → candidate key เดียวกันเท่านั้น · join ไม่เคย collapse"""
    import dataclasses
    dom = att.identity_domain or ""
    ident = att.identity or ""
    iid = att.item_id or (ident[2:] if ident.startswith("i:") else None)
    targets: list[PooledCandidate] = []
    if dom == "item" and iid:
        targets = [c for c in pooled if c.item_id == iid]
    elif dom in ("model", "variant") and ident:
        targets = [c for c in pooled if c.identity == ident]
        if not targets and iid:
            targets = [c for c in pooled if c.identity == f"i:{iid}"]
    elif ident:
        targets = [c for c in pooled if c.identity == ident]
    if targets:
        return [dataclasses.replace(att, linked_candidate=t.identity,
                                    trace=att.trace + ("linked",))
                for t in targets]
    return [dataclasses.replace(att, trace=att.trace + ("unlinked",))]


# customer_visibility → merge preference — visible > historical > hidden:
# product เดียวกันที่มีทั้ง UNLIST record และ visible record ต้องใช้ของที่มองเห็น
_VIS_ORDER = {"visible": 2, "historical_only": 1, "hidden": 0}


def _merge_group(group: list[dict]) -> dict:
    """รวม cards identity เดียวกัน — keep card ที่ visible/sellable/richer +
    merge sources (canonical fields มาจาก card ที่ชนะเท่านั้น)"""
    def _rich(c):
        return (_VIS_ORDER.get(c.get("customer_visibility"), -1),
                bool(c.get("sellable")),
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
    sub_hit = set(card.get("canonical_roles") or ()) & set(res.subtypes)
    if sub_hit:
        s += 1.0
        why.append(f"subtype:{sorted(sub_hit)[0]}")
    if res.target_device:
        from .device_compat import _extract_device_token
        if _extract_device_token(card.get("name") or "") == res.target_device:
            s += 1.0
            why.append("device")
    if res.relation_id:
        s += 0.5
        why.append("relation_target")
    if card.get("sellable"):
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
    supporting_evidence: tuple = (),
) -> CandidatePool:
    """execution results → pool กลาง (observe-only, ไม่ mutate input).

    dedupe identity = _identity_key (finest key เดียว/card — merge iff key
    เดียวกัน) **global ข้ามทุก result ของ turn** — identity เดียวกันจากหลาย
    request/channel เป็น PooledCandidate row เดียวที่สะสม request_ids;
    variant ต่าง key ไม่ merge · listing i:X แปลงเป็น item attachment เมื่อ
    item X มี non-rejected variant candidate (variant ที่ rejected เพียว
    ไม่ suppress listing) · ต่าง item ไม่ merge · attachment join ตาม
    domain ไม่เคย collapse candidates
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
    supporting: list[dict] = list(supporting_evidence or ())
    trace: list[str] = []

    # ── pass 1: GLOBAL dedupe groups — identity เดียวกันข้ามทุก result อยู่
    #    group เดียว (owner เดียวต่อ turn — ไม่ใช่ต่อ request) ──
    groups: dict[str, list[tuple[dict, str, RetrievalExecutionResult]]] = {}
    domains: dict[str, str] = {}
    seq = 0
    for res in results:
        cards_by_bucket = (
            [(c, "eligible") for c in res.eligible_candidates]
            + [(c, "unavailable") for c in res.unavailable_evidence]
            + [(c, "rejected") for c in res.rejected_evidence])
        for card, bkt in cards_by_bucket:
            key, dom = _identity_key(card)
            if not key:
                key = f"?:{seq}"       # ไม่มี identity — ไม่ merge กับใคร
                seq += 1
            groups.setdefault(key, []).append((card, bkt, res))
            domains[key] = dom
        # channel supporting records ผูก request_id ของผู้ผลิต — typed
        # attribution สำหรับ answer_context compiler (record ที่มีอยู่แล้วไม่เขียนทับ)
        for _e in res.supporting_evidence or ():
            if isinstance(_e, dict) and not _e.get("request_id"):
                _e = {**_e, "request_id": res.request_id}
            supporting.append(_e)

    variant_items: set[str] = set()
    for key, group in groups.items():
        if domains[key] != "variant":
            continue
        if any(b != "rejected" for _, b, _ in group):
            _, _, iid0 = _card_ids(group[0][0])
            if iid0:
                variant_items.add(iid0)

    # listing i:X → item attachment เมื่อ X มี non-rejected variant ใน
    # pool (union เดียวต่อ turn); variant ที่ rejected เพียวไม่ suppress listing
    listing_cards: dict[str, dict] = {}
    for key in [k for k, g in groups.items()
                if domains[k] == "item"
                and _card_ids(g[0][0])[2] in variant_items]:
        lc = _merge_group([c for c, _, _ in groups.pop(key)])
        listing_cards[_card_ids(lc)[2]] = lc

    # ── pass 2: PooledCandidate เดียวต่อ global identity — card merge ครั้ง
    #    เดียว, score/request facts คง per-request ผ่าน request_scores ──
    all_pooled: list[PooledCandidate] = []
    key_cand: dict[str, PooledCandidate] = {}
    key_scores: dict[str, dict[str, float]] = {}
    pending_atts: list[EvidenceAttachment] = []
    for key, group in groups.items():
        card = _merge_group([c for c, _, _ in group])
        uid, mid, iid = _card_ids(card)
        identity = key if not key.startswith("?:") else (
            iid or f"n:{card.get('shop') or ''}:{_norm_name(card)}")
        lcard = listing_cards.get(iid) if domains[key] == "variant" else None
        if lcard is not None:
            # listing evidence merge เข้า variant card — live listing
            # fields ที่ variant ไม่มี (variants rows/short_link ฯลฯ)
            # แต่ canonical availability ของ variant ชนะเสมอ
            lsrc = (lcard.get("_evidence") or {}).get("sources") or ()
            ev = dict(card.get("_evidence") or {})
            srcs = list(ev.get("sources") or [])
            for s in lsrc:
                if s not in srcs:
                    srcs.append(s)
            ev["sources"] = srcs
            card["_evidence"] = ev
            for f in ("short_link", "image_url", "tier_variation",
                      "variants"):
                if not card.get(f) and lcard.get(f):
                    card[f] = lcard[f]
        sources = tuple(
            (card.get("_evidence") or {}).get("sources") or ["unknown"])
        reasons = [c.get("_selection_reason") or "" for c, _, _ in group]
        # bucket = ดีที่สุดในกลุ่ม (eligible > unavailable > rejected)
        buckets = {b for _, b, _ in group}
        bucket = ("eligible" if "eligible" in buckets else
                  "unavailable" if "unavailable" in buckets else "rejected")
        is_anchor = bool(anchor_ids) and iid in anchor_ids
        # per-request scoring — res facts ของแต่ละ contributing request
        contrib: dict[str, RetrievalExecutionResult] = {}
        for _, _, res in group:
            contrib.setdefault(res.request_id, res)
        scores: dict[str, float] = {}
        why_all: list[str] = []
        for rid, res in contrib.items():
            sc, why = _score(card, res, is_anchor, anchor_priority)
            scores[rid] = sc
            for w in why:
                if w not in why_all:
                    why_all.append(w)
        best_rid = max(scores, key=lambda r: scores[r])
        best_res = contrib[best_rid]
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
        for scard in (c for c, _, _ in group if c.get("_snapshot_only")):
            evidence.append(EvidenceAttachment(
                kind="subject_snapshot", identity=identity, item_id=iid,
                linked_candidate=identity,
                payload={k: scard.get(k) for k in
                         ("name", "specs", "price") if scard.get(k) is not None},
                trace=("snapshot_merged",)))
        roles = set(card.get("canonical_roles") or ())
        csub = next(iter(sorted(
            (roles & set(best_res.subtypes)) or roles)), None)
        cand = PooledCandidate(
            identity=identity, item_id=iid, model_id=mid, unit_id=uid,
            sources=sources, request_ids=tuple(contrib),
            slot_id=best_res.slot_id,
            relation_id=next((r.relation_id for r in contrib.values()
                              if r.relation_id), None),
            product_type=(card.get("canonical_type")
                        or card.get("product_type")), subtype=csub,
            bucket=bucket,
            reason=next((r for r in reasons if r not in ("ok", "")), "ok"),
            score=scores[best_rid],
            trace=tuple([f"why:{w}" for w in why_all]
                        + [f"req:{rid}={round(s, 3)}"
                           for rid, s in scores.items()]
                        + ([f"merged:{len(group)}"] if len(group) > 1 else [])),
            card=card, is_anchor=is_anchor,
            identity_quality=("name_only" if identity.startswith("n:")
                              else ""),
            linked_item_id=(iid if domains[key] == "variant" else None),
            request_scores=tuple((rid, s) for rid, s in scores.items()))
        key_cand[key] = cand
        all_pooled.append(cand)
        key_scores[key] = scores

    for iid, lcard in listing_cards.items():
        pending_atts.append(EvidenceAttachment(
            kind="listing", identity=f"i:{iid}", item_id=iid,
            linked_candidate=None, identity_domain="item",
            payload=lcard,
            trace=("listing→item-attachment",)))
    for res in results:
        for att in res.attachment_evidence:
            if isinstance(att, EvidenceAttachment):
                pending_atts.append(att)
            elif isinstance(att, dict):
                pending_atts.append(EvidenceAttachment(
                    kind=att.get("kind", "evidence"),
                    identity=att.get("identity") or "",
                    item_id=att.get("item_id"),
                    linked_candidate=att.get("linked_candidate"),
                    identity_domain=att.get("identity_domain") or "",
                    payload=att.get("payload"),
                    trace=tuple(att.get("trace") or ())))

    # ── pass 3: per-request membership + quota — request ตัดเฉพาะ membership
    #    ของตัวเอง (rank ด้วย per-request score); candidate รอดใน ≥1 request
    #    จึงเข้า global buckets (identity เดียวกันไม่ตายเพราะ quota request เดียว) ──
    seen_out: set[str] = set()
    for res in results:
        mems = [(key_cand[k], key_scores[k][res.request_id])
                for k, g in groups.items()
                if any(r is res for _, _, r in g)]
        mems.sort(key=lambda t: t[1], reverse=True)
        if per_request_limit is not None:
            mems = mems[:per_request_limit]
        for c, _ in mems:
            if c.identity in seen_out:
                continue
            seen_out.add(c.identity)
            (elig_out if c.bucket == "eligible"
             else unav_out if c.bucket == "unavailable"
             else rej_out).append(c)
        by_req.append((res.request_id,
                       tuple(c for c, _ in mems if c.bucket == "eligible")))
        trace.append(f"{res.request_id}: merged={len(mems)} "
                     f"elig={sum(1 for c, _ in mems if c.bucket == 'eligible')}")

    # ── attachment join รวดเดียว — pool-wide (attachments จาก channel หนึ่ง
    #    link ไป candidate ของ request อื่นได้เสมอ — union เดียวต่อ turn) ──
    for att in pending_atts:
        evidence.extend(_join_attachment(att, all_pooled))

    elig_out.sort(key=lambda c: c.score, reverse=True)
    unav_out.sort(key=lambda c: c.score, reverse=True)
    rej_out.sort(key=lambda c: c.score, reverse=True)
    return CandidatePool(
        eligible=tuple(elig_out), unavailable=tuple(unav_out),
        rejected=tuple(rej_out), by_request=tuple(by_req),
        evidence_pool=tuple(evidence),
        supporting_evidence=tuple(supporting),
        trace=tuple(trace))
