"""retrieval_shadow.py — Task 5B3-A: grouped-retrieval shadow runner.

observe-only: รัน pipeline ใหม่ข้างๆ runtime เดิมแล้วคืน log-safe summary —
ไม่แตะ products/ranking/LLM context; error คืน {"ok": False} ไม่ raise
app.py เรียกหลัง USE_GROUPED_RETRIEVAL_SHADOW=1 เท่านั้น
"""
from __future__ import annotations

from .route_context import build_retrieval_slots, build_retrieval_relations
from .retrieval_planner import build_grouped_retrieval_requests
from .retrieval_executor import execute_grouped_retrieval_requests
from .candidate_pool import build_candidate_pool


def _summary(results, pool) -> dict:
    """pool+results → log-safe dict — สร้างจาก field สาธารณะเท่านั้น
    (ไม่มี _evidence/_selection_reason โดย construction, ไม่ log history)"""
    attempts = [
        {"request_id": r.request_id, "source": a.source,
         "raw": a.raw_count, "eligible": a.eligible_count,
         "unavailable": a.unavailable_count, "rejected": a.rejected_count,
         "error": a.error}
        for r in results for a in r.source_attempts
    ]
    return {
        "ok": True,
        "request_count": len(results),
        "requests": [{"request_id": r.request_id, "source": r.source,
                      "slot_id": r.slot_id, "relation_id": r.relation_id,
                      "subtypes": sorted(r.subtypes),
                      "model_codes": list(r.model_codes),
                      "error": r.error} for r in results],
        "counts": {"eligible": len(pool.eligible),
                   "unavailable": len(pool.unavailable),
                   "rejected": len(pool.rejected)},
        "attempts": attempts,
        "by_request": {req_id: len(cands)
                       for req_id, cands in pool.by_request},
        "top_eligible": [
            {"name": (c.card.get("name") or "")[:80],
             "item_id": c.item_id, "sources": list(c.sources),
             "score": round(c.score, 2), "is_anchor": c.is_anchor}
            for c in pool.eligible[:5]],
        "evidence_attachments": len(pool.evidence_pool),
    }


def run_grouped_retrieval_shadow(
    profile,
    *,
    message: str,
    shop: str | None,
    platform: str = "shopee",
    limit_per_request: int = 20,
    fetcher=None,
    legacy_fetcher="auto",
) -> dict:
    """profile → slots→relations→requests→executor(union)→pool → summary.

    observe-only เท่านั้น — caller ใช้ output สำหรับ log/debug;
    error ใดๆ คืน {"ok": False, "error": ...} ไม่ทำ runtime ล้ม
    """
    try:
        slots = build_retrieval_slots(profile)
        relations = build_retrieval_relations(profile, slots)
        requests = build_grouped_retrieval_requests(profile, slots, relations)
        results = execute_grouped_retrieval_requests(
            requests, message=message, shop=shop, platform=platform,
            limit_per_request=limit_per_request,
            fetcher=fetcher, legacy_fetcher=legacy_fetcher)
        pool = build_candidate_pool(results, profile=profile)
        return _summary(results, pool)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
