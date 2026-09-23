"""Grouped-retrieval executor — Task 5B1/5B2 observe mode (evidence-preserving).

แปลง RetrievalRequest (จาก retrieval_planner) → fetch calls หลาย source
(units + legacy product_store) แล้วแยก evidence เป็น bucket ต่อ request —
observe-only: ไม่มี runtime caller, ไม่แตะ ranking/prompt,
error ต่อ source ไม่ทำทั้งชุดล้ม
"""
from __future__ import annotations

import os
from dataclasses import dataclass

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
    trace: tuple[str, ...] = ()
    error: str | None = None

    @property
    def candidates(self) -> tuple[dict, ...]:
        """alias เดิมของ eligible_candidates (backward compat กับ 5B1 tests)"""
        return self.eligible_candidates


def _request_profile(req: RetrievalRequest, query: str, shop: str | None,
                     platform: str) -> RetrievalProfile:
    """synthetic profile ต่อ request — fetch_* ใช้ facts จากที่นี่ชุดเดียว"""
    subtype = next(iter(sorted(req.subtypes)), None)
    return RetrievalProfile(
        platform=platform,
        shop=shop,
        message=query,
        intent="",
        product_types=req.product_types,
        subtype=subtype,
        model_codes=req.model_codes,
        variant_terms=(),
        target_device=req.target_device,
        availability_mode=req.availability_mode,
        compat_mode=req.compat_mode,
    )


def _legacy_evidence_fetcher(message: str, *, retrieval_profile, shop, limit):
    """legacy product_store path เป็น evidence source (observe-only) —
    fetch_products behavior เดิมไม่เปลี่ยน; SystemExit จาก client → error ต่อ attempt"""
    from . import product_store as _ps
    try:
        db_name = os.environ.get("MONGO_DB", "").strip()
        db = _ps.get_client()[db_name]
    except (Exception, SystemExit) as exc:
        raise RuntimeError(f"legacy db unavailable: {exc}")
    return _ps.fetch_products(db, message, shop_filter=shop, limit=limit,
                              retrieval_profile=retrieval_profile)


def _bucket(card: dict, req: RetrievalRequest) -> tuple[str, str]:
    """card → (bucket, reason) — eligible / unavailable / rejected"""
    from .units import _SUBTYPE_TO_TYPES
    eff_types = set(req.product_types)
    for s in req.subtypes:
        eff_types |= _SUBTYPE_TO_TYPES.get(s, set())
    ptype = card.get("product_type")
    if not ptype and eff_types:
        # legacy card ไม่มี product_type field → detect จากชื่อ (generic taxonomy)
        from .product_store import _detect_product_types
        det = _detect_product_types(card.get("name") or "")
        ptype = next((t for t in eff_types if t in det), None) \
            or next(iter(det), None)
    if eff_types and ptype and ptype not in eff_types:
        return "rejected", "wrong_type"
    if req.subtypes:
        expanded = set()
        for s in req.subtypes:
            expanded |= _SUBTYPE_TO_TYPES.get(s, set())
        csub = (card.get("charger_subtype") or card.get("cable_subtype"))
        # reject เฉพาะเมื่อ subtype evidence ชัดและไม่ตรง — unit type เช่น
        # cable ที่เป็น expansion ของ req subtype ถือว่าตรง (csub อาจว่าง)
        if csub and csub not in req.subtypes \
                and (ptype or "") not in expanded:
            return "rejected", "subtype_mismatch"
    if req.target_device:
        from .device_compat import _extract_device_token
        dev = _extract_device_token(card.get("name") or "")
        if dev and dev != req.target_device:
            return "rejected", f"device_mismatch:{dev}"
    if card.get("_available_for_sale"):
        return "eligible", "ok"
    return "unavailable", card.get("availability_reason") or "unavailable"


def _run_attempt(source: str, fetch_fn, query: str, prof, shop: str,
                 limit: int, req: RetrievalRequest
                 ) -> tuple[list[dict], list[dict], list[dict], SourceAttempt]:
    """fetch 1 source → tag evidence + แยก bucket — error ถูกจับใน attempt"""
    try:
        res = fetch_fn(query, retrieval_profile=prof, shop=shop, limit=limit)
    except (Exception, SystemExit) as exc:
        return [], [], [], SourceAttempt(
            source=source, raw_count=0, eligible_count=0,
            unavailable_count=0, rejected_count=0,
            trace=(f"{source} error",), error=str(exc))
    cards = tuple(res.cards) if hasattr(res, "cards") else tuple(res)
    raw = getattr(res, "raw_count", len(cards))
    elig: list[dict] = []
    unav: list[dict] = []
    rej: list[dict] = []
    for c in cards:
        b, why = _bucket(c, req)
        cc = make_evidence_card(c, source=source, selection_reason=why)
        (elig if b == "eligible" else
         unav if b == "unavailable" else rej).append(cc)
    return elig, unav, rej, SourceAttempt(
        source=source, raw_count=raw, eligible_count=len(elig),
        unavailable_count=len(unav), rejected_count=len(rej),
        trace=tuple(getattr(res, "trace", ()) or ()))


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
) -> tuple[RetrievalExecutionResult, ...]:
    """execute request plan ทีละชิ้น — evidence-preserving observe-only.

    source ต่อ request: units (fetcher, default=fetch_unit_evidence)
    + legacy product_store (legacy_fetcher — None=ปิด, "auto"=adapter จริง)
    ทุก card ได้ _evidence.sources + _selection_reason (private — strip
    ด้วย retrieval_policy.strip_private_evidence ก่อนเข้า LLM)
    """
    if fetcher is None:
        from . import units as _units
        fetcher = _units.fetch_unit_evidence
    if legacy_fetcher == "auto":
        legacy_fetcher = _legacy_evidence_fetcher
    sources = [("units", fetcher)]
    if legacy_fetcher is not None:
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
        for src_name, fn in sources:
            e, u, r, att = _run_attempt(src_name, fn, query, prof, shop,
                                        limit_per_request, req)
            elig += e
            unav += u
            rej += r
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
            trace=tuple(trace), error=req_error))
    return tuple(results)
