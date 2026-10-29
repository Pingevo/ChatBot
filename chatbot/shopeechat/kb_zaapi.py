"""kb_zaapi.py — Workstream E P2: Zaapi KB evidence adapter (imported corpus).

อ่าน collection `zaapi_kb` ใน admin DB (importer: docs/zaapi/script/import_zaapi_kb.py)
- doc = 1 row ของ Zaapi knowledge source (xlsx row / txt doc)
- scope = accounts[].name เทียบ shopname (zaapi account → shop เดิม)
- คืน supporting_evidence เท่านั้น — imported KB ไม่สร้าง sellable candidate
- ทำงานก็ต่อเมื่อ runtime_config: pool_sources.kb ON และ kb_source="zaapi"
"""
from __future__ import annotations

import os
import re
from typing import Any

from .runtime_config import kb_enabled, kb_source

_COLL = os.environ.get(
    "ADMIN_MONGO_COLLECTION_ZAAPI_KB", "zaapi_kb").strip()

# field ที่ใช้ match model/brand (ชื่อคอลัมน์ตาม xlsx export จริง)
_MATCH_COLS = ("รุ่นสินค้า", "ชื่อรุ่นสินค้าย่อ", "ชื่อแบรนด์", "รุ่น",
               "model", "brand", "ประเภทสินค้า", "คำถามเกี่ยวสินค้า")


def _zaapi_allowed() -> bool:
    """อ่าน zaapi_kb ได้ก็ต่อเมื่อ kb source เปิด และ selector เลือก zaapi —
    fail-closed: config error/absent → legacy (ห้ามอ่าน)"""
    try:
        return kb_enabled() and kb_source() == "zaapi"
    except Exception:
        return False


def _zaapi_coll():
    from . import knowledge_base as _kb  # lazy — admin client เจ้าของเดียวกัน
    return _kb._admin_db()[_COLL]


def _shop_clause(shop: str | None, platform: str | None) -> dict:
    """scope ตาม accounts: name เทียบ shopname (case-insensitive) —
    platform ให้เป็นบวกเท่านั้น (ชื่อชนกันข้าม platform ไม่เอามา);
    `unscoped` doc (สร้างผ่าน admin UI) ไม่ผูกร้าน → ใช้ได้ทุกร้าน"""
    if not shop:
        return {"$or": [{"accounts.name": {"$exists": True, "$ne": ""}},
                        {"unscoped": True}]}
    scoped: dict = {"accounts.name":
                    {"$regex": f"^{re.escape(str(shop).strip())}$",
                     "$options": "i"}}
    if platform:
        scoped["accounts.platform"] = platform
    return {"$or": [scoped, {"unscoped": True}]}


def zaapi_kb_evidence(
    *,
    shop: str | None = None,
    platform: str | None = None,
    message: str = "",
    limit: int = 20,
):
    """ค้น zaapi_kb → KbEvidenceResult (supporting rows เท่านั้น)

    light-pass: ดึง fields เบาๆ ของ docs ที่ scope เข้าร้าน → bounded match
    ด้วย _model_token_in_name เหมือน legacy (กันข้ามรุ่น) → ดึง text เต็ม
    เฉพาะ top hits; ไม่มี keyword match → [] (ไม่ scan ทั้ง collection)
    """
    from .knowledge_base import KbEvidenceResult, extract_model_keywords
    from . import product_store as _ps

    if not _zaapi_allowed():
        return KbEvidenceResult(trace=("zaapi_gate_closed",))

    keywords = extract_model_keywords(message or "")
    if not keywords:
        return KbEvidenceResult(trace=("zaapi_no_keywords",))

    coll = _zaapi_coll()
    query = {"active": {"$ne": False}, **_shop_clause(shop, platform)}
    light = list(coll.find(
        query, {"fields": 1, "source_name": 1}).limit(4000))

    keywords_l = [k.lower() for k in keywords]
    scored: list[tuple[int, dict]] = []
    for doc in light:
        fields = doc.get("fields") or {}
        hay_parts = [str(fields[c]).lower() for c in _MATCH_COLS
                     if fields.get(c)]
        hay = " ".join(hay_parts)
        if not hay:
            continue
        if not all(_ps._model_token_in_name(hay, k) for k in keywords):
            continue
        score = 0
        model_cols = " ".join(
            str(fields[c]).lower() for c in _MATCH_COLS[:3] if fields.get(c))
        for k, kl in zip(keywords, keywords_l):
            if _ps._model_token_in_name(model_cols, k):
                score += 2
            elif kl in hay:
                score += 1
        phrase = " ".join(keywords_l)
        if phrase in hay or re.sub(r"\s+", "", phrase) in \
                re.sub(r"\s+", "", hay):
            score += 5
        scored.append((score, doc))

    if not scored:
        return KbEvidenceResult(raw_count=len(light),
                                trace=("zaapi_no_match",
                                       f"scanned={len(light)}"))

    scored.sort(key=lambda x: x[0], reverse=True)
    top_ids = [d["_id"] for _, d in scored[:limit]]
    full = {d["_id"]: d for d in coll.find(
        {"_id": {"$in": top_ids}}, {"text": 1, "fields": 1,
                                   "source_name": 1, "row_index": 1})}

    sup = []
    for _, d in scored[:limit]:
        f = full.get(d["_id"]) or {}
        fields = f.get("fields") or {}
        label = " ".join(str(fields.get(c) or "") for c in _MATCH_COLS[:3]
                         ).strip() or f.get("source_name") or "zaapi_kb"
        sup.append({"kind": "kb_zaapi",
                    "text": label,
                    "payload": {"text": f.get("text", ""),
                                "fields": fields,
                                "source": f.get("source_name", "")},
                    "reason": "zaapi_kb_match"})
    return KbEvidenceResult(
        supporting_evidence=tuple(sup),
        raw_count=len(light),
        trace=(f"zaapi_match={len(sup)}/{len(scored)}",
               f"scanned={len(light)}"))
