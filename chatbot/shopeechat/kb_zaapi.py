"""kb_zaapi.py — Workstream E P2: Zaapi KB evidence adapter (imported corpus).

File-backed serving (spec v4 — 2026-11-07): `zaapi_kb_evidence` ค้น active
file rows ใน `zaapi_kb` ผ่าน kb_zaapi_files.zaapi_search (registry
`zaapi_kb_files` = visibility owner) — ไม่แปลงผ่าน LLM, kind="kb" +
meta file/sheet/row provenance. Canonical-artifact path
(`kb_zaapi_retrieval`/`zaapi_kb_records`) dormant — เก็บไว้ rollback/cleanup แยก.

- ค้นตาม need.subject_refs/target_refs (typed) + message — refs-substring +
  trigram prefilter → lazy-embed cosine บน top-K เท่านั้น
- คืน supporting evidence เท่านั้น — imported KB ไม่สร้าง sellable candidate
- ทำงานก็ต่อเมื่อ runtime_config: pool_sources.kb ON และ kb_source="zaapi"
"""
from __future__ import annotations

import os

from . import runtime_config as _rc

_COLL = os.environ.get(
    "ADMIN_MONGO_COLLECTION_ZAAPI_KB", "zaapi_kb").strip()

_PRODUCTISH = frozenset({"product", "compare", "compat"})

# ⚡ evidence ขอทุกชนิดที่ประกาศได้ (ชุดปิดเดียวกับ _CONTENT_TYPES ใน
#   kb_zaapi_files) — แถวที่ admin จัดชนิดไว้ต้องค้นเจอครบ ไม่ใช่เฉพาะ product
_CONTENT_TYPES_ALL = ("product", "troubleshooting", "faq", "warranty")


def _zaapi_allowed() -> bool:
    """อ่าน zaapi_kb ได้ก็ต่อเมื่อ kb source เปิด และ selector เลือก zaapi —
    fail-closed: config error/absent → legacy (ห้ามอ่าน)"""
    try:
        return _rc.kb_enabled() and _rc.kb_source() == "zaapi"
    except Exception:
        return False


def zaapi_kb_evidence(
    *,
    shop: str | None = None,
    platform: str | None = None,
    message: str = "",
    limit: int = 20,
    needs: tuple = (),
    request_id: str = "ch:kb",
    db=None,
    exports_root=None,
):
    """ค้น active Zaapi generation artifacts → KbEvidenceResult

    needs = TurnNeeds ของ turn (productish เท่านั้นที่ใช้); ไม่มี → ไม่มี
    evidence (general troubleshooting ยังไม่มี owner ใน path นี้)
    message คง signature สำหรับ callsites เดิม — ไม่ใช้ keyword scan แล้ว
    db/exports_root = injectable สำหรับ tests; default = admin DB เดิม
    """
    from .knowledge_base import KbEvidenceResult
    from . import knowledge_base as _kb

    if not _zaapi_allowed():
        return KbEvidenceResult(trace=("zaapi_gate_closed",))

    prodish = [n for n in (needs or ())
               if getattr(n, "kind", None) in _PRODUCTISH]
    if not prodish:
        return KbEvidenceResult(trace=("zaapi_no_productish_need",))

    from . import kb_zaapi_files as _zkf
    # typed roles เดิม — subject/target refs + capability_asks จาก TurnNeed
    # เท่านั้น (ไม่ parse prose); query = message + typed terms
    refs: list[str] = []
    asks: list[str] = []
    for n in prodish:
        refs += [str(r) for r in (getattr(n, "subject_refs", ()) or ())]
        refs += [str(r) for r in (getattr(n, "target_refs", ()) or ())]
        asks += [str(a) for a in (getattr(n, "capability_asks", ()) or ())]
    query = " ".join(x for x in ([message] + asks + refs) if x).strip()
    hits, trace = _zkf.zaapi_search(
        db if db is not None else _kb._admin_db(),
        shop=shop, platform=platform, query=query, refs=refs,
        limit=limit, types=_CONTENT_TYPES_ALL)
    sup = [{"kind": "kb", "record_id": h["record_id"],
            "request_id": request_id,
            "payload": {"text": h["a"], "fields": h.get("fields") or {}},
            "meta": h.get("meta") or {},
            "score": h.get("_qa_sim")}
           for h in hits]
    return KbEvidenceResult(
        supporting_evidence=tuple(sup),
        raw_count=len(sup),
        trace=(f"zaapi_files={len(sup)}sup",) + tuple(trace))
