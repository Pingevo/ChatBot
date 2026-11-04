"""KB evidence result contract — frozen dataclass เท่านั้น ไม่มี side effect.

Owner เดียวของ `KbEvidenceResult`: ผลผลิตโดย `knowledge_base.kb_product_evidence`,
`kb_zaapi.zaapi_kb_evidence`, `kb_zaapi_retrieval.retrieve` — บริโภคโดย
`answer_context`/`candidate_pool`. แยกออกจาก `knowledge_base` (ซึ่ง `_load_env()`
ตอน import) ตาม precedent `message_detectors` — contract module ต้อง import
ได้โดยไม่อ่าน `.env`/ไม่ลาก deps หนัก. `knowledge_base` re-export เพื่อ
compat กับ callsites เดิม.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class KbEvidenceResult:
    """ผล KB product evidence resolution — cards (live listing ที่ model
    match) + attachments (item-domain joins) + supporting (name-only/
    unmatched — ห้ามกลายเป็น candidate)"""
    cards: tuple[dict, ...] = ()
    supporting_evidence: tuple[dict, ...] = ()
    attachment_evidence: tuple = ()
    raw_count: int = 0
    trace: tuple[str, ...] = ()
