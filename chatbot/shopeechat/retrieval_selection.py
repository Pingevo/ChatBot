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
from .retrieval_policy import strip_private_evidence, _SUBTYPE_ROLES
from .turn_decision import PRODUCTISH_NEED_KINDS as _PRODISH_NEED_KINDS

# keys ที่เป็น routing metadata — ไม่ใช่ product evidence ไม่ให้ score
# (public — Phase 7 compiler กรอง key เดียวกันออกจาก task constraints)
META_HINT_KEYS = frozenset(
    {"query_hint", "target_subtype", "source_subtype"})


def _code_match(card: dict, codes) -> bool:
    """card ตรงกับ model code ที่ถามถึงไหม — unit card ใช้ model_codes field;
    legacy card ไม่มี field → boundary-match จากชื่อ (กัน 'AC65B' เชี่ยน 'AC65B2')"""
    want = {str(m).upper() for m in codes or ()}
    if not want:
        return False
    have = {str(m).upper() for m in (card.get("model_codes") or [])}
    if have & want:
        return True
    name = (card.get("name") or "").upper()
    return any(re.search(rf"(?<![A-Z0-9]){re.escape(m)}(?![A-Z0-9])", name)
               for m in want)


@dataclass(frozen=True)
class SelectedCandidate:
    """candidate ที่ผ่าน selection — card strip private evidence แล้ว"""
    role: str                         # "subject" | "alternative" | "slot" |
                                      #   "relation_target" | "historical_evidence"
                                      #   | channel name ("kb" ฯลฯ)
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
    trace: tuple[str, ...] = ()


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


def _request_score(c: PooledCandidate, req: RetrievalRequest) -> float:
    """score ของ candidate ภายใต้ request นี้ — per-request facts คง (Phase 4A
    global pool: candidate เดียวอาจมี score ต่างกันต่อ contributing request)"""
    for rid, s in c.request_scores:
        if rid == req.request_id:
            return s
    return c.score


# role precedence สำหรับ identity dedupe — identity เดียวกันอาจถูกเลือก
# ใต้หลาย request; เก็บ role ที่มี semantics มากสุด
# (subject=อ้างถึงตรง > relation_target=สิ่งที่ขอผ่าน relation >
#  historical_evidence=หลักฐานอดีต > alternative=ตัวทดแทน > slot=generic)
# public — Phase 7 compiler ใช้ precedence เดียวกันสำหรับ per-need ordering
ROLE_RANK = {"subject": 5, "relation_target": 4, "historical_evidence": 3,
             "alternative": 2, "slot": 1}
# card state → role override (หลัง subject/channel) — snapshot-stale
# evidence (persisted mention ที่ไม่มี live record) เป็น role แยก ไม่ใช่
# recommendation; discontinued live record ยังเป็น subject ได้ตามปกติ
def _is_historical(card: dict) -> bool:
    return bool(card.get("_snapshot_only"))


# hidden mentions (UNLIST-only/customer_hidden) ไม่มีวันเข้า selected —
# ปรากฏใน rejected summary ภายใต้ label นี้เท่านั้น (role ที่แยกชัด)
_HIDDEN_MENTION_REASON = "customer_hidden"
_HIDDEN_MENTION_LABEL = "hidden_mention"


def _select_one(c: PooledCandidate, req: RetrievalRequest,
                text_cache: dict) -> SelectedCandidate:
    """PooledCandidate → SelectedCandidate (constraint score + strip)"""
    card = c.card
    cid = c.identity
    if cid not in text_cache:
        text_cache[cid] = _card_text(card)
    text = text_cache[cid]
    hints = [(k, v) for k, v in req.soft_hints if k not in META_HINT_KEYS]
    hits = tuple(k for k, v in hints if _constraint_hit(k, v, text))
    score = _request_score(c, req) + len(hits)
    why = [t[4:] for t in c.trace if t.startswith("why:")]
    why += [f"hint:{k}" for k in hits]
    # exact item-id refs = subject authority: typed ids เป็น owner ของ
    #   subject role — grouping-time narrowing รับประกันว่า candidate ของ
    #   pinned request ผ่าน exact item/linked เท่านั้น (sibling ที่แชร์
    #   model code เดียวกันห้าม promote ผ่าน _code_match)
    if any(str(r).isdigit() for r in (req.subject_refs or ())):
        role = "subject"
    elif _code_match(card, req.model_codes):
        role = "subject"
    elif req.source == "subjects":
        role = "subject"  # resolved persisted subjects
    elif req.source == "history" or _is_historical(card):
        # history channel = prior-subject reference (live record จริง) —
        #   role เดียวกับ snapshot-stale: หลักฐานอดีต ไม่ใช่ recommendation
        role = "historical_evidence"
    elif req.source in ("relation_target", "compat"):
        role = "relation_target"
    elif req.model_codes and req.source == "slot":
        role = "alternative"
    else:
        role = req.source
    return SelectedCandidate(
        role=role, request_id=req.request_id, slot_id=req.slot_id,
        relation_id=req.relation_id, identity=cid,
        score=round(score, 3), constraint_hits=hits,
        reason="; ".join(why) or "eligible",
        card=strip_private_evidence(card))


def _need_scope(need) -> set:
    """scope ของ need — types ∪ subtypes ∪ subject_refs ∪ target_refs
    (union semantics เหมือน _bucket eff_types — ไม่ expand subtype→unit
    type ตรงนี้)"""
    return (set(getattr(need, "product_types", ()) or ())
            | set(getattr(need, "subtypes", ()) or ())
            | set(getattr(need, "subject_refs", ()) or ())
            | set(getattr(need, "target_refs", ()) or ()))


def _req_scope(req: RetrievalRequest) -> set:
    return (set(req.product_types or ()) | set(req.subtypes or ())
            | set(req.model_codes or ()) | set(req.subject_refs or ())
            | set(req.target_refs or ())
            | ({req.target_device} if req.target_device else set()))


def needs_for_request(req: RetrievalRequest, needs: tuple) -> tuple:
    """request → productish needs ที่มันคลุม — a request อาจ serve หลาย need
    (coverage ไม่ใช่ exclusive ownership)

    canonical request→need attribution owner เดียว (public — Phase 7
    answer_context compiler consume function เดียวกันนี้ ห้าม copy)"""
    prodish = [n for n in needs if n.kind in _PRODISH_NEED_KINDS]
    if req.source in ("relation_target", "compat"):
        out = [n for n in prodish if n.kind == "compat"]
        if out or req.source == "compat":
            return tuple(out)
    if req.source == "history":
        # reference channel — attribute เข้า product/compare needs เท่านั้น
        #   (history card ไม่ใช่ compat-need subject — ห้ามเข้า verdict pass)
        return tuple(n for n in prodish if n.kind != "compat")
    if req.source == "subjects":
        # subjects channel = persisted subject materialization — คลุมเฉพาะ
        # need ที่อ้าง subject_refs (identity ตรง) · deictic scope
        # (current_single/current_set = referent คือ resolved subject,
        # inferred types เป็น context ไม่ใช่ identity) · หรือ need ไร้ scope
        out = [n for n in prodish
               if getattr(n, "subject_refs", ()) or not _need_scope(n)
               or getattr(n, "subject_scope", "none")
                  in ("current_single", "current_set")]
    elif req.source in ("slot", "relation_target"):
        out = [n for n in prodish
               if not _need_scope(n) or _need_scope(n) & _req_scope(req)]
    else:
        out = list(needs)  # kb/อื่นๆ = context channel ทุก need
    return tuple(out)


def select_for_llm_context(
    pool: CandidatePool,
    requests: tuple[RetrievalRequest, ...],
    profile=None,
    *,
    needs: tuple = (),
    per_request_limit: int = 3,
    unavailable_limit: int = 5,
) -> SelectionResult:
    """pool → selected cards สำหรับ LLM context (observe/contract เท่านั้น).

    per-request quota: แต่ละ request ได้ quota ของตัวเอง — relation target
    ไม่ถูก source product กิน quota · constraint hints เพิ่ม score ไม่ตัดทิ้ง
    · unavailable เก็บเป็น evidence summary · rejected เป็น summary counts

    Phase 6: needs (TurnNeed tuple) → request→need attribution (identity
    dedupe role precedence + need.ranking ordering)
    """
    req_by_id = {r.request_id: r for r in requests}
    text_cache: dict[str, str] = {}
    selected: list[SelectedCandidate] = []
    by_req: list[tuple[str, tuple[SelectedCandidate, ...]]] = []
    trace: list[str] = []
    req_needs = {r.request_id: needs_for_request(r, needs)
                 for r in requests} if needs else {}
    # exact item-id subject_refs — request ถามถึง item เฉพาะตัว: typed
    #   ids เป็น identity authority ของ request นั้น ทุก channel —
    #   narrowing จุดเดียวที่ candidate-grouping (eligible + unavailable
    #   promotion): sibling/delisted listings ที่แชร์ model code ไม่เข้า
    #   scope ของ pinned request; variants ผ่าน linked_item_id
    req_refs = {
        r.request_id: frozenset(
            str(x) for x in (r.subject_refs or ()) if str(x).isdigit())
        for r in requests}
    elig_by_req: dict[str, list[PooledCandidate]] = {}
    unav_by_req: dict[str, list[PooledCandidate]] = {}
    for bucket, src in ((elig_by_req, pool.eligible),
                        (unav_by_req, pool.unavailable)):
        for c in src:
            for rid in c.request_ids:
                refs = req_refs.get(rid)
                if refs and str(c.item_id or "") not in refs \
                        and str(c.linked_item_id or "") not in refs:
                    continue
                bucket.setdefault(rid, []).append(c)
    for req in requests:
        cands = elig_by_req.get(req.request_id, [])
        ranked = sorted(
            (_select_one(c, req, text_cache) for c in cands),
            key=lambda s: (len(s.constraint_hits), s.score), reverse=True)
        # form-exact preference: request (หรือ need ที่ map — compat channel
        #   ไม่มี subs ของตัวเอง) ถาม form subtype เดียว → stable partition
        #   ด้วย typed facts เท่านั้น (ordering owner เดียว — ไม่มี tier
        #   helper/magic numbers):
        #   (a) form non-match หลังสุด  (b) proven-form ก่อน / proven-non-match
        #       หลังสุด = XOR ของ form-match กับ roles_source=='field'
        #   (c) standalone shape (roles ⊆ scope∪intrinsic) ก่อน composite —
        #       composite = fallback ไม่ถูก ban; structured ก่อน detect
        #   scope ไม่ใช่ form subtype เดียว → ไม่ reorder (hits,score คงเดิม)
        _fscope = set(req.subtypes)
        if not _fscope:
            for _n in req_needs.get(req.request_id, ()):
                _fscope |= set(getattr(_n, "subtypes", ()) or ())
        _fs_set = _fscope & set(_SUBTYPE_ROLES)
        if len(_fs_set) == 1:
            _fs = next(iter(_fs_set))
            _ok_roles = set(_SUBTYPE_ROLES[_fs]) | (
                {"adapter"} if set(_SUBTYPE_ROLES[_fs]) - {"cable"}
                else set())
            ranked = sorted(ranked, key=lambda s: (
                _fs not in (s.card.get("canonical_roles") or ()),
                (_fs in (s.card.get("canonical_roles") or ()))
                    != (s.card.get("roles_source") == "field"),
                not set(s.card.get("canonical_roles") or ()) <= _ok_roles,
            ))
            if ranked and not any(
                    s.card.get("roles_source") == "field" for s in ranked):
                trace.append(
                    f"{req.request_id}: missing_structured_form "
                    f"(eligible={len(ranked)} all name-detect)")
        # need.ranking → sort ranked ก่อน truncate (owner เดิม — canonical
        #   spec field บน pool เต็ม ไม่ใช่ prefix ที่ตัดแล้ว); device
        #   adequacy — owner เดียวกับ filter_compatible_products
        #   (_wattage_asc_key + _lookup_spec_db, typed spec เท่านั้น):
        #   adequate (watt ≥ spec) ก่อน / ตัวเล็กพอ spec ก่อน / below-target
        #   ท้าย — ตัดก่อนเรียงทำให้ตัวพอ spec หลุดก่อน ranking เห็น
        rank = next((getattr(n, "ranking", None)
                     for n in req_needs.get(req.request_id, ())
                     if getattr(n, "ranking", None)), None)
        _dev = req.target_device or (
            getattr(profile, "target_device", None)
            if req.source == "compat" else None)
        _minw = None
        _spec = None
        if rank or _dev:
            from . import device_compat as _dc
            if rank:
                keyfn = _dc.spec_rank_key(rank[0])
                if keyfn:
                    ranked = sorted(
                        ranked,
                        key=lambda s: (keyfn(s.card), s.score),
                        reverse=(rank[1] == "max"))
            if _dev:
                _spec = _dc._lookup_spec_db(_dev)
                _minw = (_spec or {}).get("min_watt") if _spec else None
                if _minw:
                    ranked = sorted(
                        ranked,
                        key=lambda s: _dc._wattage_asc_key(s.card, _minw))
        picked = list(ranked[:per_request_limit])
        if len(req.subtypes) > 1:
            # coverage: subtype ที่ถามและมี candidate ต้องได้ ≥1 ที่ —
            # subtype เดียวห้ามกิน quota ทั้ง request (canonical_roles —
            # cable_only/set นับเป็น cable/adapter coverage ตามจริง)
            present: set[str] = set()
            protected: set[int] = set()
            req_subs = set(req.subtypes)
            for i, s in enumerate(picked):
                covered = set(s.card.get("canonical_roles") or ()) & req_subs
                for sub in covered:
                    if sub not in present:
                        present.add(sub)
                        protected.add(i)
            for sub in req.subtypes:
                if sub in present:
                    continue
                alt = next((s for s in ranked
                            if sub in set(s.card.get("canonical_roles")
                                          or ())), None)
                if alt is None:
                    continue
                if len(picked) < per_request_limit:
                    picked.append(alt)
                else:
                    evict = next((i for i in range(len(picked) - 1, -1, -1)
                                  if i not in protected), None)
                    if evict is None:
                        break
                    picked[evict] = alt
                    protected.add(evict)
                present.add(sub)
        # subject = identity authority → นำหน้า picks ของ request เสมอ
        #   (stable partition — membership/ORDER ภายในฝั่งเดิมคงที่;
        #   presentation precedence อยู่ที่นี่ไม่ใช่ AnswerContext)
        picked = tuple(sorted(
            picked, key=lambda s: 0 if s.role == "subject" else 1))
        if _minw:
            # below-target อาจอยู่เป็นตัวเลือก — แต่ต้องติด label ช้ากว่า
            #   ปกติ (_context_note เดิม); mixed-variant listing ที่ไม่มี
            #   typed power เดี่ยว ห้ามเสนอเป็น full-speed primary
            _devname = (_spec or {}).get("device") or _dev
            for s in picked:
                _w = _dc._extract_max_wattage(s.card)
                if _w and _w < _minw:
                    s.card["_context_note"] = (
                        f"จ่ายไฟ {_w:g}W ต่ำกว่าสเปค {_devname} "
                        f"({_minw:g}W) — ชาร์จได้แต่ช้ากว่าปกติ")
                elif not (
                        s.card.get("output_power_w")
                        or (s.card.get("specs") or {}).get(
                            "output_power_w")):
                    _vw = sorted({
                        float(v["output_power_w"])
                        for v in (s.card.get("variants") or ())
                        if isinstance(v.get("output_power_w"), (int, float))
                        and v["output_power_w"] > 0})
                    if len(_vw) > 1:
                        s.card["_context_note"] = (
                            "มีหลายตัวเลือกกำลังไฟ "
                            f"({'/'.join(f'{v:g}W' for v in _vw)}) — "
                            "ยืนยันตัวเลือกที่ลูกค้าต้องการก่อน ห้ามสรุป"
                            "ว่าชาร์จเต็มสเปคเมื่อยังไม่ได้เลือกรุ่น")
        selected.extend(picked)
        by_req.append((req.request_id, picked))
        trace.append(f"{req.request_id}: elig={len(cands)} "
                     f"selected={len(picked)}")
    # compare/spec (answerable_all) + ถามถึง model code ตรงๆ → ยก unavailable
    # ที่ customer-visible ขึ้นเป็น subject (ตอบ spec/compare ได้พร้อม label)
    # — ไม่กิน quota ของ alternative, cap ตามจำนวน codes ที่ถาม
    promoted: set[str] = set()
    for req in requests:
        if req.availability_mode != "answerable_all" or not req.model_codes:
            continue
        cands = [c for c in unav_by_req.get(req.request_id, [])
                 if _code_match(c.card, req.model_codes)]
        if not cands:
            continue
        ranked = sorted(cands, key=lambda c: _request_score(c, req),
                        reverse=True)
        subjects: list[SelectedCandidate] = []
        for c in ranked[:len(req.model_codes)]:
            if c.identity in promoted:
                continue
            promoted.add(c.identity)
            subjects.append(SelectedCandidate(
                role=("historical_evidence" if _is_historical(c.card)
                      else "subject"),
                request_id=req.request_id, slot_id=req.slot_id,
                relation_id=req.relation_id, identity=c.identity,
                score=round(_request_score(c, req), 3), constraint_hits=(),
                reason=f"unavailable_subject:{c.reason}",
                card=strip_private_evidence(c.card)))
        if subjects:
            selected.extend(subjects)
            # promoted subject นำหน้า picks ของ request (identity
            #   authority — presentation precedence ที่ selection)
            by_req = [(rid, tuple(list(subjects) + list(cs))
                       if rid == req.request_id
                       else cs) for rid, cs in by_req]
            trace.append(f"{req.request_id}: unavailable_subjects="
                         f"{len(subjects)}")
    # unavailable — evidence ว่ามีของแต่หมด/เลิก (stripped, จำกัดต่อ request)
    # subject ที่ promote แล้วไม่ซ้ำใน note
    unav_out: list[dict] = []
    for rid, cands in unav_by_req.items():
        left = [c for c in cands if c.identity not in promoted]
        for c in left[:unavailable_limit]:
            u = strip_private_evidence(c.card)
            unav_out.append({
                "request_id": rid, "name": u.get("name"),
                "item_id": c.item_id, "reason": c.reason,
                "unavailable": True})
    # hidden (UNLIST-only) → rejected 'hidden_mention' เท่านั้น — identity
    # ห้ามรั่วเข้า customer context; เหลือแค่ aggregate count ใน summary
    rej_counts: dict[tuple[str, str], int] = {}
    for c in pool.rejected:
        for rid in c.request_ids:
            key = (rid, c.reason.split(":")[0])
            rej_counts[key] = rej_counts.get(key, 0) + 1
    rej_out = [{"request_id": rid,
                "reason": (_HIDDEN_MENTION_LABEL
                           if why == _HIDDEN_MENTION_REASON else why),
                "count": n}
               for (rid, why), n in sorted(rej_counts.items())]

    # identity dedupe — identity เดียวกันอาจถูกเลือกใต้หลาย request;
    # role precedence สูงสุดชนะ → zero duplicate selected identities
    best: dict[str, SelectedCandidate] = {}
    order: list[str] = []
    for s in selected:
        cur = best.get(s.identity)
        if cur is None or ROLE_RANK.get(s.role, 0) > ROLE_RANK.get(
                cur.role, 0):
            best[s.identity] = s
        if s.identity not in order:
            order.append(s.identity)
    if len(order) != len(selected):
        # selected = final output (deduped); by_request = per-request
        #   attribution เต็ม — candidate เดียวกันเล่นได้หลาย request
        selected = [best[i] for i in order]
        trace.append(f"dedupe: {len(selected)} unique identities")

    return SelectionResult(
        selected=tuple(selected), by_request=tuple(by_req),
        unavailable_evidence=tuple(unav_out),
        rejected_summary=tuple(rej_out), trace=tuple(trace))
