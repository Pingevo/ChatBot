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
    subject_hints: tuple = (),
    request_id: str = "ch:kb",
    db=None,
    exports_root=None,
):
    """ค้น active Zaapi generation artifacts → KbEvidenceResult

    needs = TurnNeeds ของ turn (productish เท่านั้นที่ใช้); ไม่มี → ไม่มี
    evidence (general troubleshooting ยังไม่มี owner ใน path นี้)
    subject_hints = phrase candidates ฝั่ง subject (เช่น profile.model_terms)
    — search candidate เท่านั้น ไม่ใช่ identity; declared subject binding +
    subject_digest ของ row เป็น proof เดิม (hint ที่ตรง target_refs ถูกตัด)
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
    targets: list[str] = []
    asks: list[str] = []
    for n in prodish:
        refs += [str(r) for r in (getattr(n, "subject_refs", ()) or ())
                 if str(r).strip()]
        targets += [str(r) for r in (getattr(n, "target_refs", ()) or ())]
        asks += [str(a) for a in (getattr(n, "capability_asks", ()) or ())]
    # hints เข้า refs เฉพาะเมื่อไม่ชน target ของ need (normalize owner เดียว
    #   กับ identity filter — space-insensitive); target ไม่เคยเป็น subject
    _tgt = {"".join(str(t).casefold().split()) for t in targets}
    refs += [str(h) for h in (subject_hints or ())
             if str(h).strip()
             and "".join(str(h).casefold().split()) not in _tgt]
    refs = list(dict.fromkeys(refs))
    if not refs:
        return KbEvidenceResult(trace=("zaapi_subject_unresolved",))
    query = " ".join(x for x in ([message] + asks + refs + targets) if x).strip()
    hits, trace = _zkf.zaapi_search(
        db if db is not None else _kb._admin_db(),
        shop=shop, platform=platform, query=query, refs=refs,
        limit=limit, types=_CONTENT_TYPES_ALL)
    rank_query = message.casefold()
    for ref in refs:
        rank_query = rank_query.replace(ref.casefold(), " ")
    rank_query = " ".join(rank_query.split()) or " ".join(asks) or query
    _idnorm = lambda v: "".join(str(v).casefold().split())
    _refs_n = {_idnorm(r) for r in refs}
    sup = []
    for h in hits:
        fields = h.get("fields") or {"row": h["a"]}
        passages = []
        for name, value in fields.items():
            if not value:
                continue
            whole = f"{name}: {str(value).strip()}"
            if len(whole.encode("utf-8")) <= 900:
                passages.append(whole)
            else:
                passages.extend(
                    f"{name}: {line[i:i + 250]}"
                    for line in str(value).splitlines() if line.strip()
                    for i in range(0, len(line), 250))
        try:
            from . import embedding as _emb
            qv = _emb.embed_query(rank_query)
            vectors = _emb.embed_texts(passages)
            ranked = sorted(zip(passages, vectors),
                            key=lambda pair: _zkf._cosine(qv, pair[1]),
                            reverse=True)
            passages = [p for p, _ in ranked]
        except Exception:
            pass
        selected = []
        used = 0
        for passage in passages:
            size = len(passage.encode("utf-8"))
            if size + used + bool(selected) > 1000:
                continue
            selected.append(passage)
            used += size + 1
            if len(selected) == 3:
                break
        # identity = declared ref ที่ match จริง (row binding ผ่าน digest
        #   แล้ว — canonical identity ของ record เดียวกัน, ไม่ใช่ hint ฝั่ง
        #   request); facts += spec_tokens จาก row text ทั้งใบ — selected
        #   passages เป็นแค่ context budget ของ model แต่ทุก token ใน row
        #   ที่ผูก identity คือ measured evidence ของ subject นั้น (guard
        #   spec_claim ground ผ่าน channel เดียวกับ card facts)
        _matched = sorted(
            s for s in (h.get("subject_refs") or ())
            if _idnorm(s) in _refs_n)
        facts = list(h.get("facts") or ())
        try:
            from . import policy_resolver as _pr
            _toks = _pr._spec_tokens(
                h.get("a") or "\n".join(selected))[:64]
        except Exception:
            _toks = ()
        if _toks:
            facts.append({"key": "spec_tokens", "value": _toks})
        sup.append({"kind": "kb", "record_id": h["record_id"],
                    "request_id": request_id,
                    **({"subject_refs": tuple(h["subject_refs"])}
                       if h.get("facts") else {}),
                    **({"identity": _matched[0]} if _matched else {}),
                    **({"facts": facts} if facts else {}),
                    "payload": {"text": "\n".join(selected), "fields": fields},
                    "meta": h.get("meta") or {},
                    "score": h.get("_qa_sim")})
    return KbEvidenceResult(
        supporting_evidence=tuple(sup),
        raw_count=len(sup),
        trace=(f"zaapi_files={len(sup)}sup",) + tuple(trace))
