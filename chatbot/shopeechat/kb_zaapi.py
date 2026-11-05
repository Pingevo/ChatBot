"""kb_zaapi.py — Workstream E P2: Zaapi KB evidence adapter (imported corpus).

Phase 4 artifact-only contract (Task 5):
- อ่าน active generation artifacts ผ่าน kb_zaapi_retrieval เท่านั้น —
  ห้ามอ่าน canonical `zaapi_kb` collection ต่อคำถาม
- active gen schema_version < 2 → decline (loadable ≠ answer-eligible:
  v1 มีไว้ rollback แต่ไม่มี typed routing fields)
- ค้นตาม need.subject_refs/target_refs (typed index channels) และ
  need.capability_asks (semantic) — ไม่ scan ข้อความทั้ง turn กว้าง
- evidence kind="kb_zaapi" + meta (typed routing channel เดียว)
- item_id resolved → item-domain attachment; ไม่มี identity → supporting
- คืน evidence เท่านั้น — imported KB ไม่สร้าง sellable candidate
- ทำงานก็ต่อเมื่อ runtime_config: pool_sources.kb ON และ kb_source="zaapi"
"""
from __future__ import annotations

import os

from .runtime_config import kb_enabled, kb_source

_COLL = os.environ.get(
    "ADMIN_MONGO_COLLECTION_ZAAPI_KB", "zaapi_kb").strip()

_PRODUCTISH = frozenset({"product", "compare", "compat"})


def _zaapi_allowed() -> bool:
    """อ่าน zaapi_kb ได้ก็ต่อเมื่อ kb source เปิด และ selector เลือก zaapi —
    fail-closed: config error/absent → legacy (ห้ามอ่าน)"""
    try:
        return kb_enabled() and kb_source() == "zaapi"
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
    from . import kb_zaapi_retrieval as _retr

    if not _zaapi_allowed():
        return KbEvidenceResult(trace=("zaapi_gate_closed",))

    prodish = [n for n in (needs or ())
               if getattr(n, "kind", None) in _PRODUCTISH]
    if not prodish:
        return KbEvidenceResult(trace=("zaapi_no_productish_need",))

    try:
        snap = _retr.load_active_generation(
            db if db is not None else _kb._admin_db(),
            exports_root=exports_root)
    except Exception:
        snap = None
    if snap is None:
        return KbEvidenceResult(trace=("zaapi_no_active",))
    # v1 artifact = loadable (rollback) แต่ไม่มี typed routing —
    # fail closed: evidence ไม่เข้า pool (เท่าสถานะก่อน integration)
    if snap.schema_version < 2:
        return KbEvidenceResult(trace=("zaapi_v1_ineligible",))

    sup: list[dict] = []
    atts: list[dict] = []
    seen: set[str] = set()
    for n in prodish:
        # typed roles แยกชัด — subject refs → subject-side namespaces;
        #   target refs → target_ids เท่านั้น (ไม่สลับ role; ไม่ parse
        #   prose — refs มาจาก TurnNeed typed fields เท่านั้น)
        srefs = tuple(getattr(n, "subject_refs", ()) or ())
        trefs = tuple(getattr(n, "target_refs", ()) or ())
        item_ids = tuple(str(r) for r in srefs if str(r).isdigit())
        others = tuple(str(r) for r in srefs if not str(r).isdigit())
        target_ids = tuple(str(r) for r in trefs)
        asks = tuple(getattr(n, "capability_asks", ()) or ())
        res = _retr.retrieve(
            snap, shop=shop, platform=platform,
            item_ids=item_ids, model_codes=others, aliases=others,
            subject_ids=others, target_ids=target_ids,
            semantic_query=" ".join(asks) or None,
            request_id=request_id)
        for ev in res.supporting_evidence:
            rid = (ev.get("meta") or {}).get("record_id")
            if rid and rid in seen:
                continue
            if rid:
                seen.add(rid)
            iid = ev.get("item_id")
            if iid is not None:
                # resolved item → item-domain attachment (joins ทุก variant
                # ของ item นั้นใน pool — ไม่สร้าง candidate เอง)
                # model-bound record (model_id ตั้ง) scope = variant
                #   เดียว: identity = variant identity เดิมของ record
                #   (subject_id|model_id projection) + domain model —
                #   item-level identity จะทำให้ record ของรุ่น A เล็งเป็น
                #   หลักฐานของรุ่น B ที่แชร์ item
                # target = typed canonical projection (target_id verbatim
                #   จาก producer record — compat gate ต้องเห็นมิฉะนั้น
                #   wrong-device record ผูก item เดียวกันหลุดเข้า need อื่น)
                mid = ev.get("model_id")
                vident = (str(ev.get("identity") or "").strip()
                          or str(mid or "").strip())
                atts.append({"kind": "kb_zaapi",
                             "identity": (vident if mid else f"i:{iid}"),
                             "item_id": iid,
                             "identity_domain": ("model" if mid
                                                 else "item"),
                             "meta": ev.get("meta"),
                             "target": ev.get("target"),
                             "model_id": mid,
                             "payload": ev.get("payload")})
            else:
                sup.append(ev)
    return KbEvidenceResult(
        supporting_evidence=tuple(sup),
        attachment_evidence=tuple(atts),
        raw_count=len(sup) + len(atts),
        trace=(f"zaapi_artifact={len(sup)}sup+{len(atts)}att",))
