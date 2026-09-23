"""Grouped-retrieval executor — Task 5B1 observe mode (evidence-preserving).

แปลง RetrievalRequest (จาก retrieval_planner) → fetch calls ผ่าน units path
แล้วแยก evidence เป็น bucket ต่อ request — observe-only: ไม่มี runtime caller,
ไม่แตะ ranking/prompt, error ต่อ request ไม่ทำทั้งชุดล้ม
"""
from __future__ import annotations

from dataclasses import dataclass

from .retrieval_planner import RetrievalRequest
from .route_context import RetrievalProfile


@dataclass(frozen=True)
class SourceAttempt:
    """บันทึก 1 fetch attempt — evidence ต้องไม่หายเงียบแม้ raw=0"""
    source: str                       # "units"
    raw_count: int
    eligible_count: int
    unavailable_count: int
    rejected_count: int
    trace: tuple[str, ...]


@dataclass(frozen=True)
class RetrievalExecutionResult:
    """ผล execute ของ request เดียว — bucket แยกตามความพร้อมใช้."""
    request_id: str
    source: str                       # "slot" | "relation_target"
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


def _bucket(card: dict, req: RetrievalRequest) -> tuple[str, str]:
    """card → (bucket, reason) — eligible / unavailable / rejected"""
    from .units import _SUBTYPE_TO_TYPES
    eff_types = set(req.product_types)
    for s in req.subtypes:
        eff_types |= _SUBTYPE_TO_TYPES.get(s, set())
    if eff_types and (card.get("product_type") or "") not in eff_types:
        return "rejected", "wrong_type"
    if req.subtypes:
        expanded = set()
        for s in req.subtypes:
            expanded |= _SUBTYPE_TO_TYPES.get(s, set())
        csub = (card.get("charger_subtype") or card.get("cable_subtype"))
        # reject เฉพาะเมื่อ subtype evidence ชัดและไม่ตรง — unit type เช่น
        # cable ที่เป็น expansion ของ req subtype ถือว่าตรง (csub อาจว่าง)
        if csub and csub not in req.subtypes \
                and (card.get("product_type") or "") not in expanded:
            return "rejected", "subtype_mismatch"
    if req.target_device:
        from .device_compat import _extract_device_token
        dev = _extract_device_token(card.get("name") or "")
        if dev and dev != req.target_device:
            return "rejected", f"device_mismatch:{dev}"
    if card.get("_available_for_sale"):
        return "eligible", "ok"
    return "unavailable", card.get("availability_reason") or "unavailable"


def execute_grouped_retrieval_requests(
    requests: tuple[RetrievalRequest, ...],
    *,
    message: str,
    shop: str | None,
    platform: str = "shopee",
    limit_per_request: int = 20,
    observe_only: bool = True,
    fetcher=None,
) -> tuple[RetrievalExecutionResult, ...]:
    """execute request plan ทีละชิ้น — evidence-preserving observe-only.

    fetcher ต้อง match signature units.fetch_unit_evidence(message, *,
    retrieval_profile, shop, limit) → obj ที่มี .cards/.raw_count
    (รับ list ธรรมดาได้สำหรับ mock) — default = fetch_unit_evidence จริง
    (units path มี live-availability ใน to_unit_card อยู่แล้ว ไม่ bypass)
    """
    if fetcher is None:
        from . import units as _units
        fetcher = _units.fetch_unit_evidence
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
        try:
            res = fetcher(
                query,
                retrieval_profile=prof,
                shop=shop,
                limit=limit_per_request,
            )
        except Exception as exc:
            results.append(RetrievalExecutionResult(
                request_id=req.request_id, source=req.source,
                hard_filters=req.hard_filters, soft_hints=req.soft_hints,
                trace=tuple(trace + [f"error={exc}"]),
                error=str(exc)))
            continue
        cards = tuple(res.cards) if hasattr(res, "cards") else tuple(res)
        raw = getattr(res, "raw_count", len(cards))
        elig: list[dict] = []
        unav: list[dict] = []
        rej: list[dict] = []
        for c in cards:
            b, why = _bucket(c, req)
            cc = {**c, "_bucket_reason": why}
            (elig if b == "eligible" else
             unav if b == "unavailable" else rej).append(cc)
        trace.append(f"candidates={len(cards)} "
                     f"eligible={len(elig)} unavailable={len(unav)} "
                     f"rejected={len(rej)}")
        attempt = SourceAttempt(
            source="units", raw_count=raw, eligible_count=len(elig),
            unavailable_count=len(unav), rejected_count=len(rej),
            trace=tuple(getattr(res, "trace", ()) or ()))
        results.append(RetrievalExecutionResult(
            request_id=req.request_id, source=req.source,
            eligible_candidates=tuple(elig),
            unavailable_evidence=tuple(unav),
            rejected_evidence=tuple(rej),
            source_attempts=(attempt,),
            hard_filters=req.hard_filters, soft_hints=req.soft_hints,
            trace=tuple(trace), error=None))
    return tuple(results)
