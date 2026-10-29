"""Grouped-retrieval executor — Task 5B1/5B2 observe mode (evidence-preserving).

แปลง RetrievalRequest (จาก retrieval_planner) → fetch calls หลาย source
(units + legacy product_store) แล้วแยก evidence เป็น bucket ต่อ request —
observe-only: ไม่มี runtime caller, ไม่แตะ ranking/prompt,
error ต่อ source ไม่ทำทั้งชุดล้ม
"""
from __future__ import annotations

import os
from dataclasses import dataclass

from . import generation_pointer as _gen
from . import runtime_config as _rc
from .retrieval_planner import RetrievalRequest
from .retrieval_policy import make_evidence_card
from .route_context import RetrievalProfile


@dataclass(frozen=True)
class SourceAttempt:
    """บันทึก 1 fetch attempt — evidence ต้องไม่หายเงียบแม้ raw=0/error"""
    source: str                       # "units" | "legacy"
    raw_count: int
    eligible_count: int
    unavailable_count: int
    rejected_count: int
    trace: tuple[str, ...]
    error: str | None = None


@dataclass(frozen=True)
class RetrievalExecutionResult:
    """ผล execute ของ request เดียว — bucket แยกตามความพร้อมใช้."""
    request_id: str
    source: str                       # "slot" | "relation_target"
    slot_id: str = ""
    relation_id: str | None = None
    subtypes: frozenset[str] = frozenset()
    model_codes: tuple[str, ...] = ()
    target_device: str | None = None
    eligible_candidates: tuple[dict, ...] = ()
    unavailable_evidence: tuple[dict, ...] = ()
    rejected_evidence: tuple[dict, ...] = ()
    source_attempts: tuple[SourceAttempt, ...] = ()
    hard_filters: tuple[tuple[str, str], ...] = ()
    soft_hints: tuple[tuple[str, str], ...] = ()
    supporting_evidence: tuple = ()
    attachment_evidence: tuple = ()
    trace: tuple[str, ...] = ()
    error: str | None = None

    @property
    def candidates(self) -> tuple[dict, ...]:
        """alias เดิมของ eligible_candidates (backward compat กับ 5B1 tests)"""
        return self.eligible_candidates


def _request_profile(req: RetrievalRequest, query: str, shop: str | None,
                     platform: str) -> RetrievalProfile:
    """synthetic profile ต่อ request — fetch_* ใช้ facts จากที่นี่ชุดเดียว"""
    # subtype เป็น hard filter ฝั่ง fetch — request ที่ขอหลาย subtype
    # ต้องไม่ narrow เหลือตัวเดียว (bucket ยัง reject subtype_mismatch อยู่)
    subtype = next(iter(req.subtypes), None) if len(req.subtypes) == 1 else None
    ptypes = set(req.product_types)
    if len(req.subtypes) > 1:
        # unit product_type ไม่ตรง listing type (สายชาร์จอยู่ใน listing charger
        # แต่ unit type="cable") — expand ตาม subtype ทั้งหมดที่ขอ
        from .units import _SUBTYPE_TO_TYPES
        for s in req.subtypes:
            ptypes |= _SUBTYPE_TO_TYPES.get(s, set())
    return RetrievalProfile(
        platform=platform,
        shop=shop,
        message=query,
        intent="",
        product_types=frozenset(ptypes),
        subtype=subtype,
        model_codes=req.model_codes,
        variant_terms=req.variant_terms,
        target_device=req.target_device,
        availability_mode=req.availability_mode,
        compat_mode=req.compat_mode,
        value_constraints=req.value_constraints,
    )


def _legacy_evidence_fetcher(message: str, *, retrieval_profile, shop, limit,
                             snap=None):
    """legacy product_store path เป็น evidence source (observe-only) —
    fetch_products behavior เดิมไม่เปลี่ยน; SystemExit จาก client → error ต่อ attempt"""
    from . import product_store as _ps
    try:
        db_name = os.environ.get("MONGO_DB", "").strip()
        db = _ps.get_client()[db_name]
    except (Exception, SystemExit) as exc:
        raise RuntimeError(f"legacy db unavailable: {exc}")
    return _ps.fetch_products(db, message, shop_filter=shop, limit=limit,
                              retrieval_profile=retrieval_profile, snap=snap)


def _bucket(card: dict, req: RetrievalRequest) -> tuple[str, str]:
    """canonical card → (bucket, reason) — eligible / unavailable / rejected.

    input ต้องผ่าน make_evidence_card() แล้ว — อ่าน canonical fields เท่านั้น
    (customer_visibility/canonical_type/canonical_roles/sellable ฯลฯ)
    """
    # hidden (ยังไม่ publish — UNLIST/unknown) ห้ามใช้เป็น evidence ตอบลูกค้า
    if card.get("customer_visibility") == "hidden":
        return "rejected", "customer_hidden"
    from .units import _SUBTYPE_TO_TYPES
    eff_types = set(req.product_types)
    for s in req.subtypes:
        eff_types |= _SUBTYPE_TO_TYPES.get(s, set())
    canon = ((card.get("_evidence") or {}).get("facts") or {}).get("canonical") or {}
    ctypes = set(canon.get("type_candidates") or ())
    if card.get("canonical_type"):
        ctypes.add(card["canonical_type"])
    if eff_types and ctypes and not (ctypes & eff_types):
        return "rejected", "wrong_type"
    if req.subtypes:
        roles = set(card.get("canonical_roles") or ())
        # reject เฉพาะเมื่อ role evidence ชัดและไม่ตรง — roles ว่าง = ไม่มี
        # evidence พอจะตัด (เช่น generic listing ที่ชื่อไม่บอก subtype)
        if roles and not (roles & set(req.subtypes)):
            return "rejected", "subtype_mismatch"
    if req.target_device:
        from .device_compat import _extract_device_token
        dev = _extract_device_token(card.get("name") or "")
        if dev and dev != req.target_device:
            return "rejected", f"device_mismatch:{dev}"
    if card.get("sellable"):
        return "eligible", "ok"
    # card ขายได้แต่ requested option ไม่พร้อม → unavailable ด้วยเหตุ variant
    # (ไม่ใช่ของหมดทั้งชิ้น — ตอบ "สีที่ขอหมด/ไม่มี" ได้ตรง)
    rvs = card.get("requested_variant_state")
    if (rvs not in (None, "not_requested", "available")
            and card.get("publish_state") == "published"
            and card.get("stock_state") == "in_stock"
            and card.get("customer_visibility") == "visible"):
        return "unavailable", f"requested_variant:{rvs}"
    return "unavailable", card.get("availability_reason") or "unavailable"


def _run_attempt(source: str, fetch_fn, query: str, prof, shop: str,
                 limit: int, req: RetrievalRequest, snap=None
                 ) -> tuple[list[dict], list[dict], list[dict],
                            SourceAttempt, tuple, tuple]:
    """fetch 1 source → tag evidence + แยก bucket — error ถูกจับใน attempt;
    คืน (elig, unav, rej, attempt, supporting, attachments) — 2 tuple ท้าย
    จาก channel result ที่เป็น evidence records (ไม่ผ่าน canonicalize)"""
    try:
        res = fetch_fn(query, retrieval_profile=prof, shop=shop, limit=limit,
                       snap=snap)
    except (Exception, SystemExit) as exc:
        return [], [], [], SourceAttempt(
            source=source, raw_count=0, eligible_count=0,
            unavailable_count=0, rejected_count=0,
            trace=(f"{source} error",), error=str(exc)), (), ()
    cards = tuple(res.cards) if hasattr(res, "cards") else tuple(res)
    raw = getattr(res, "raw_count", len(cards))
    sup = tuple(getattr(res, "supporting_evidence", ()) or ())
    atts = tuple(getattr(res, "attachment_evidence", ()) or ())
    elig: list[dict] = []
    unav: list[dict] = []
    rej: list[dict] = []
    # requested options = variant_terms ของ request เท่านั้น — soft_hints
    # เป็น preference (constraint ranking) ไม่ใช่ hard option gate
    requested = tuple(req.variant_terms or ())
    for c in cards:
        # canonicalize ก่อน bucket เสมอ — _bucket อ่าน canonical fields เท่านั้น
        cc = make_evidence_card(c, source=source, requested=requested)
        b, why = _bucket(cc, req)
        cc["_selection_reason"] = why
        (elig if b == "eligible" else
         unav if b == "unavailable" else rej).append(cc)
    return elig, unav, rej, SourceAttempt(
        source=source, raw_count=raw, eligible_count=len(elig),
        unavailable_count=len(unav), rejected_count=len(rej),
        trace=tuple(getattr(res, "trace", ()) or ())), sup, atts


def execute_grouped_retrieval_requests(
    requests: tuple[RetrievalRequest, ...],
    *,
    message: str,
    shop: str | None,
    platform: str = "shopee",
    limit_per_request: int = 20,
    observe_only: bool = True,
    fetcher=None,
    legacy_fetcher=None,
    channels: tuple = (),
    snap=_gen.SNAP_UNSET,
) -> tuple[RetrievalExecutionResult, ...]:
    """execute request plan ทีละชิ้น — evidence-preserving observe-only.

    source ต่อ request: units (fetcher, default=fetch_unit_evidence)
    + legacy product_store (legacy_fetcher — None=ปิด, "auto"=adapter จริง)
    + channels (optional evidence channels — ((RetrievalRequest, fetch_fn),)
    จาก channel_request(); run ครั้งเดียวต่อ channel ไม่ผูก slot request,
    failure isolated ต่อ channel เหมือน source attempt ปกติ)
    ทุก card ได้ _evidence.sources + _selection_reason (private — strip
    ด้วย retrieval_policy.strip_private_evidence ก่อนเข้า LLM)

    snap = captured EvidenceSnapshot/None จาก request owner; omitted (SNAP_UNSET)
    → executor resolve ครั้งเดียวที่ entry ตัวเอง (standalone execution)
    """
    if snap is _gen.SNAP_UNSET:
        snap = _gen.resolve_snapshot()
    if fetcher is None:
        from . import units as _units
        fetcher = _units.fetch_unit_evidence
    if legacy_fetcher == "auto":
        legacy_fetcher = _legacy_evidence_fetcher
    # pool admission — source ที่ central policy ปิดไม่สร้าง fetch เลย
    # (SourceAttempt ไม่ถูกสร้างด้วย = zero reads ของ source นั้น)
    sources: list = []
    if _rc.source_enabled("units"):
        sources.append(("units", fetcher))
    if legacy_fetcher is not None and _rc.source_enabled("mongo_catalog"):
        sources.append(("legacy", legacy_fetcher))
    results: list[RetrievalExecutionResult] = []
    for req in requests:
        trace = [
            f"observe_only={observe_only}",
            f"source={req.source}",
            f"slot={req.slot_id}",
        ]
        if req.relation_id:
            trace.append(f"relation={req.relation_id}")
        for k, v in req.hard_filters:
            trace.append(f"hard:{k}={v}")
        for s in sorted(req.subtypes):
            trace.append(f"subtype={s}")
        # relation target ค้นด้วย query_hint (target-side text) — message เต็ม
        # มี source terms ปน ทำ vector เอียงไปทาง source product
        query = message
        qh = dict(req.soft_hints).get("query_hint")
        if req.source == "relation_target" and qh:
            query = qh
            trace.append(f"query_hint={qh[:60]}")
        prof = _request_profile(req, query, shop, platform)
        elig: list[dict] = []
        unav: list[dict] = []
        rej: list[dict] = []
        attempts: list[SourceAttempt] = []
        sup: list = []
        ch_atts: list = []
        for src_name, fn in sources:
            e, u, r, att, s, a = _run_attempt(src_name, fn, query, prof, shop,
                                            limit_per_request, req, snap)
            elig += e
            unav += u
            rej += r
            sup += s
            ch_atts += a
            attempts.append(att)
            if att.error:
                trace.append(f"{src_name}_error={att.error}")
        trace.append(f"candidates elig={len(elig)} unav={len(unav)} "
                     f"rej={len(rej)}")
        # error ระดับ request เฉพาะเมื่อทุก source พัง — source เดียวพังเป็น
        # attempt.error ไม่ทำทั้ง pool ล้ม
        req_error = (attempts[0].error
                     if attempts and all(a.error for a in attempts)
                     else None)
        results.append(RetrievalExecutionResult(
            request_id=req.request_id, source=req.source,
            slot_id=req.slot_id, relation_id=req.relation_id,
            subtypes=req.subtypes, model_codes=req.model_codes,
            target_device=req.target_device,
            eligible_candidates=tuple(elig),
            unavailable_evidence=tuple(unav),
            rejected_evidence=tuple(rej),
            source_attempts=tuple(attempts),
            hard_filters=req.hard_filters, soft_hints=req.soft_hints,
            supporting_evidence=tuple(sup),
            attachment_evidence=tuple(ch_atts),
            trace=tuple(trace), error=req_error))
    for req, fn in channels:
        # channel = synthetic request + fetch เดียว — evidence channels
        # (subjects/compat/kb/...) run ครั้งเดียวต่อ turn; error isolated —
        # channel ที่พังไม่ทำ channel/source อื่นหาย (attempt.error ตามเดิม)
        prof = _request_profile(req, message, shop, platform)
        e, u, r, att, sup, ch_atts = _run_attempt(
            req.source, fn, message, prof, shop, limit_per_request, req, snap)
        results.append(RetrievalExecutionResult(
            request_id=req.request_id, source=req.source,
            slot_id=req.slot_id, relation_id=req.relation_id,
            subtypes=req.subtypes, model_codes=req.model_codes,
            target_device=req.target_device,
            eligible_candidates=tuple(e),
            unavailable_evidence=tuple(u),
            rejected_evidence=tuple(r),
            source_attempts=(att,),
            supporting_evidence=tuple(sup),
            attachment_evidence=tuple(ch_atts),
            trace=(f"channel={req.source}",), error=att.error))
    return tuple(results)
