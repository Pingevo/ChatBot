"""retrieval_selection.py — Task 5B3-B: CandidatePool → LLM context selection.

เลือก product cards จาก pool แบบ per-request quota (relation target ไม่ถูก
source กิน quota) + constraint-aware ranking (soft_hints เป็น evidence score)
→ strip private evidence ก่อน output — contract/offline เท่านั้น ยังไม่ wire
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .candidate_pool import CandidatePool, PooledCandidate
from .retrieval_planner import RetrievalRequest
from .retrieval_policy import strip_private_evidence

# keys ที่เป็น routing metadata — ไม่ใช่ product evidence ไม่ให้ score
_META_HINT_KEYS = frozenset(
    {"query_hint", "target_subtype", "source_subtype"})


@dataclass(frozen=True)
class SelectedCandidate:
    """candidate ที่ผ่าน selection — card strip private evidence แล้ว"""
    role: str                         # "slot" | "relation_target"
    request_id: str
    slot_id: str
    relation_id: str | None
    identity: str
    score: float
    constraint_hits: tuple[str, ...]  # soft_hints ที่ match card evidence
    reason: str
    card: dict


@dataclass(frozen=True)
class SelectionResult:
    selected: tuple[SelectedCandidate, ...]
    by_request: tuple[tuple[str, tuple[SelectedCandidate, ...]], ...]
    unavailable_evidence: tuple[dict, ...]   # stripped summaries (มีแต่หมด/เลิก)
    rejected_summary: tuple[dict, ...]       # counts by reason — debug เท่านั้น
    trace: tuple[str, ...]


def _card_text(card: dict) -> str:
    """text รวมสำหรับ constraint matching — name + variant names + specs"""
    parts = [card.get("name") or ""]
    for v in card.get("variants") or []:
        if isinstance(v, dict):
            parts.append(v.get("name") or "")
    for v in card.get("tier_variation") or []:
        parts.append(str(v))
    specs = card.get("canonical_specs")
    if specs:
        parts.append(str(specs))
    return " ".join(parts).lower()


def _constraint_hit(key: str, val: str, text: str) -> bool:
    """soft_hint (key,val) match card text ไหม — generic evidence เท่านั้น"""
    if key == "display":
        return bool(re.search(r"จอ|oled|display|หน้าจอ|จอแสดง", text, re.I))
    if key == "length_m":
        return bool(re.search(
            rf"{re.escape(val)}\s*(?:เมตร|ม\.|m(?![a-z]))", text, re.I))
    if key == "speed":
        return bool(re.search(
            r"\d{2,3}\s*w\b|\d+\s*a\b|pd\s*\d|เต็มสปีด|เต็มกำลัง|full|fast|เร็ว",
            text, re.I))
    if key == "power_w":
        return bool(re.search(rf"{re.escape(val)}\s*w\b", text, re.I))
    if key in ("pd", "qc", "pps", "ufcs"):
        return bool(re.search(rf"{key}\s*{re.escape(val)}", text, re.I))
    return False


def _select_one(c: PooledCandidate, req: RetrievalRequest,
                text_cache: dict) -> SelectedCandidate:
    """PooledCandidate → SelectedCandidate (constraint score + strip)"""
    card = c.card
    cid = c.identity
    if cid not in text_cache:
        text_cache[cid] = _card_text(card)
    text = text_cache[cid]
    hints = [(k, v) for k, v in req.soft_hints if k not in _META_HINT_KEYS]
    hits = tuple(k for k, v in hints if _constraint_hit(k, v, text))
    score = c.score + len(hits)
    why = [t[4:] for t in c.trace if t.startswith("why:")]
    why += [f"hint:{k}" for k in hits]
    return SelectedCandidate(
        role=req.source, request_id=req.request_id, slot_id=c.slot_id,
        relation_id=c.relation_id, identity=cid,
        score=round(score, 3), constraint_hits=hits,
        reason="; ".join(why) or "eligible",
        card=strip_private_evidence(card))


def select_for_llm_context(
    pool: CandidatePool,
    requests: tuple[RetrievalRequest, ...],
    profile=None,
    *,
    per_request_limit: int = 3,
    unavailable_limit: int = 5,
) -> SelectionResult:
    """pool → selected cards สำหรับ LLM context (observe/contract เท่านั้น).

    per-request quota: แต่ละ request ได้ quota ของตัวเอง — relation target
    ไม่ถูก source product กิน quota · constraint hints เพิ่ม score ไม่ตัดทิ้ง
    · unavailable เก็บเป็น evidence summary · rejected เป็น summary counts
    """
    req_by_id = {r.request_id: r for r in requests}
    text_cache: dict[str, str] = {}
    selected: list[SelectedCandidate] = []
    by_req: list[tuple[str, tuple[SelectedCandidate, ...]]] = []
    trace: list[str] = []
    elig_by_req: dict[str, list[PooledCandidate]] = {}
    for c in pool.eligible:
        for rid in c.request_ids:
            elig_by_req.setdefault(rid, []).append(c)
    for req in requests:
        cands = elig_by_req.get(req.request_id, [])
        ranked = sorted(
            (_select_one(c, req, text_cache) for c in cands),
            key=lambda s: (len(s.constraint_hits), s.score), reverse=True)
        picked = tuple(ranked[:per_request_limit])
        selected.extend(picked)
        by_req.append((req.request_id, picked))
        trace.append(f"{req.request_id}: elig={len(cands)} "
                     f"selected={len(picked)}")
    # unavailable — evidence ว่ามีของแต่หมด/เลิก (stripped, จำกัดต่อ request)
    unav_by_req: dict[str, list[PooledCandidate]] = {}
    for c in pool.unavailable:
        for rid in c.request_ids:
            unav_by_req.setdefault(rid, []).append(c)
    unav_out: list[dict] = []
    for rid, cands in unav_by_req.items():
        for c in cands[:unavailable_limit]:
            u = strip_private_evidence(c.card)
            unav_out.append({
                "request_id": rid, "name": u.get("name"),
                "item_id": c.item_id, "reason": c.reason,
                "unavailable": True})
    # rejected — summary counts เท่านั้น ไม่ส่ง card เข้า LLM
    rej_counts: dict[tuple[str, str], int] = {}
    for c in pool.rejected:
        for rid in c.request_ids:
            key = (rid, c.reason.split(":")[0])
            rej_counts[key] = rej_counts.get(key, 0) + 1
    rej_out = [{"request_id": rid, "reason": why, "count": n}
               for (rid, why), n in sorted(rej_counts.items())]
    return SelectionResult(
        selected=tuple(selected), by_request=tuple(by_req),
        unavailable_evidence=tuple(unav_out),
        rejected_summary=tuple(rej_out), trace=tuple(trace))
