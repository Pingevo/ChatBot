"""Phase 2C.1 — Multi-Need TurnPlan contract owner (pure, in-place evolution).

decide_turn() คืน TurnPlan: เก็บ primary_action + independent needs[] + ownership
+ claim lifecycle view + requires_clarification ต่อ 1 turn:

    1. normalize/input cleanup — ตัด system/media/item placeholders
    2. ownership & claim lifecycle view — ticket_state ∈ {handoff,open,pending}
       → ownership="human", primary_action="human_wait", needs=() ทันที
       (หยุดก่อนประเมิน needs — zero need-extraction side effects)
    3. system/noise/placeholder — message เหลือว่างหลัง cleanup:
       - ถ้า claim.accepts_claim_fields + visual media ([รูปภาพ]/[วิดีโอ])
         → claim:collect need
       - ถ้าเป็น placeholder/sticker อื่นๆ → primary_action="no_reply", needs=()
       - ถ้าข้อความว่างเปล่า → primary_action="clarify", needs=()
    4. independent need extraction (ไม่กลืนกัน):
       - human: handoffs.is_human_request / is_service_anger
       - claim / troubleshoot: warranty_flow._claim_lifecycle,
         warranty.detect_claim_request, warranty.malfunction_safe_check
       - order: order_store.extract_order_sn
       - policy: message_detectors.detect_general_question,
         warranty.detect_warranty_duration_question, route.needs_shipping
       - compare: route_context._COMPARISON_FOLLOWUP_KW
       - compat: route_context._REL_CONN_RE + message_detectors.is_target_device_kw
         หรือ intent compatibility_check / target_device
       - product: follow-up families (link/price/stock/select/superlative),
         warranty.detect_cert_question, route_context.resolve_route,
         message_detectors.extract_model_keywords, item_tag

กฎ: pure function — ไม่เรียก DB/LLM/network, ไม่ mutate input, ไม่ import
app.py หรือ knowledge_base.py, ไม่เรียก retrieval slot/relation/profile หรือ
device-spec helpers (Phase 2C.1 H1/H2 boundary).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace as _dc_replace
from typing import Any, Literal

from . import handoffs as _handoffs
from . import message_detectors as _detectors
from . import order_store as _order_store
from . import route_context as _rc
from . import warranty as _warranty
from . import warranty_flow as _wf
from .warranty_flow import ClaimLifecycleView

# ── placeholder families (canonical owner — mirrors the ad-hoc lists that
#   were previously duplicated inside app.py/post-handoff gate) ────────────
_SYSTEM_PLACEHOLDERS = (
    "[faq_liveagent]", "[bundle_message]", "[bundle_deal]", "[bundle]",
    "[order]", "[คำสั่งซื้อ]",
)
_BARE_ITEM_PLACEHOLDERS = (
    "[item]", "[itemid]", "[สินค้า]", "[variation_card]", "[ตัวเลือกสินค้า]",
)
_MEDIA_PLACEHOLDER_RE = re.compile(
    r"\[(?:รูปภาพ|image|วิดีโอ|video|sticker|สติกเกอร์)\]", re.IGNORECASE)
_VISUAL_MEDIA_PLACEHOLDER_RE = re.compile(
    r"\[(?:รูปภาพ|image|วิดีโอ|video)\]", re.IGNORECASE)
_ITEM_TAG_RE = re.compile(
    r"\[(?:สินค้า|item|itemid)\s*:\s*(\d+)\]", re.IGNORECASE)

# follow-up families — semantic, context-gated (history หรือ item_tag)
# canonical comparison/superlative sets อยู่ที่ route_context (เจ้าของเดิม)
# link/price เป็น family ใหม่ใน contract เท่านั้น — production owner คือ
# _is_link_followup (app.py ~2726) + short-followup ใน CONV-ACTIVE
_LINK_NOUN_KWS = (
    "ลิงค์", "ลิงก์", "ลิ้งค์", "ลิ้งก์", "link",
    "ช่องทางซื้อ", "ช่องทางสั่ง", "เว็บสินค้า",
)
_LINK_OBTAIN_KWS = ("ขอ", "ส่ง", "เอา", "อยาก", "แปะ", "ให้")
# link ที่ไม่ใช่ product link — semantic exclusion family
_NON_PRODUCT_LINK_KWS = (
    "สมัคร", "สมาชิก", "เว็บไซต์", "website", "เพจ", "facebook",
    "กลุ่ม", "ไลน์", "line@", "ติดต่อ", "สอบถามแอดมิน",
)
_PRICE_ASK_KWS = ("ราคา", "เท่าไหร", "กี่บาท")
# typed requested_facts → TurnNeedOp (closed-set interpreter เดียว —
#   fact ที่ไม่อยู่ 2 sets นี้ → describe op; domain owner: intent_classifier)
_FACT_OP = {"price": "price", "stock": "stock", "link": "link"}
_FACT_DESCRIBE = frozenset({
    "description", "warranty", "data_transfer_speed",
    "charging_speed", "compatibility"})
# stock/select — ถามสถานะของ/เลือกจากชุด ต้องมี product context เหมือนกัน
_STOCK_ASK_KWS = (
    "มีขายไหม", "ขายไหม", "มีของไหม", "มีของ", "พร้อมส่ง",
    "ยังมีขาย", "ยังมีไหม", "ยังขายไหม", "เหลือไหม", "หมดไหม",
)
_SELECT_ASK_KWS = (
    "ตัวไหนบ้าง", "อันไหนบ้าง", "รุ่นไหนบ้าง", "แบบไหนบ้าง",
    "มีตัวไหน", "มีอันไหน", "มีรุ่นไหน", "มีแบบไหน",
)

_ACTIVE_TICKET_STATES = frozenset({"handoff", "open", "pending"})
_BOT_TICKET_STATES = frozenset({"closed", "resolved", "bot"})

TurnNeedKind = Literal[
    "product", "compare", "compat", "policy",
    "order", "troubleshoot", "claim", "human",
]
TurnNeedOp = Literal[
    "describe", "compare", "recommend", "price",
    "link", "stock", "compat", "policy",
    "lookup", "collect", "handoff",
]
TurnPrimaryAction = Literal[
    "no_reply", "human_wait", "execute_needs",
    "handoff", "clarify", "greeting",
]
TurnOwnership = Literal["bot", "human", "unknown"]


TurnSubjectScope = Literal[
    "none", "explicit", "current_single", "current_set"]

_TURN_SUBJECT_SCOPES = frozenset(
    {"none", "explicit", "current_single", "current_set"})

# kinds ที่ selector ต้องเลือก evidence ให้ — แบก product scope/ranking
# productish kind domain (typed TurnNeedKind contract owner — consumer:
# selector attribution, reversed-relation eligibility ฯลฯ)
PRODUCTISH_NEED_KINDS = frozenset({"product", "compare", "compat"})
_SCOPE_NEED_KINDS = frozenset({"product", "compare"})


@dataclass(frozen=True)
class TurnNeed:
    """ความต้องการอิสระ 1 รายการที่สกัดได้ใน turn เดียว.

    subject_refs = product/entity ที่ need นี้ถามถึง (typed, จาก structured
    extractors เท่านั้น); target_refs = relation/device constraint ที่
    apply บน subject (compat/device-fit domain) — roles ถูก emit ครั้งเดียว
    ที่ boundary นี้จาก route surface; retrieval consume verbatim — ห้าม
    re-parse/merge role ที่ downstream; ไม่มี role evidence → tuple ว่าง
    (fail closed)
    subject_scope/subject_count = structured deictic reference จาก
    interpretation boundary (intent Pass-1) — kind=="product" เท่านั้น;
    resolver validate กับ persisted ConversationSubjectSet
    product_types/subtypes = intent product scope (≥0.7) — เฉพาะ kinds
    ใน _SCOPE_NEED_KINDS (product/compare); compat/อื่น = ว่าง (relation
    scope เป็นของ RetrievalRequest downstream) — selector ใช้ attribute
    request → need
    ranking = (canonical spec field, "max"|"min") — owner:
    route_context.detect_ranking / compat-check intent
    requested_facts = fact ที่ลูกค้าถามโดยตรง (closed set — owner:
    intent_classifier.REQUESTED_FACTS) — op authority: typed facts มี
    precedence เหนือ ask-keyword inference (price/stock/link)
    required_features = คุณสมบัติสินค้าบังคับ (closed set —
    intent_classifier.REQUIRED_FEATURES เช่น "magnetic")
    spec_constraints = (field, op, value) canonical numeric constraints —
    shape owner: intent_classifier.norm_spec_constraints
    capability_asks = residual source-grounded excerpt ของความสามารถที่
    ลูกค้าถามว่าสินค้าทำได้/มีไหม (owner: intent_classifier —
    producer-side excerpt validation vs message; stamp เฉพาะ
    product-kind needs — subject ของ need คือ owner ของ asks; ask ที่
    residue เป็นเพียง relation clause ของ compat target ถูก dedupe
    ที่นี่; ไม่มี structured evidence → unknown → cannot-confirm
    explicit)"""
    kind: TurnNeedKind
    operation: TurnNeedOp
    subject_refs: tuple[str, ...] = ()
    target_refs: tuple[str, ...] = ()
    confidence: float = 1.0
    provenance: tuple[str, ...] = ()
    subject_scope: TurnSubjectScope = "none"
    subject_count: int | None = None
    product_types: frozenset[str] = frozenset()
    subtypes: frozenset[str] = frozenset()
    ranking: tuple[str, str] | None = None
    requested_facts: tuple[str, ...] = ()
    required_features: tuple[str, ...] = ()
    spec_constraints: tuple[tuple[str, str, float], ...] = ()
    capability_asks: tuple[str, ...] = ()


@dataclass(frozen=True)
class TurnPlan:
    """แผนการตัดสินใจต่อ 1 turn — รองรับหลายความต้องการอิสระพร้อม ownership/claim view."""
    primary_action: TurnPrimaryAction
    needs: tuple[TurnNeed, ...]
    ownership: TurnOwnership
    claim: ClaimLifecycleView
    requires_clarification: bool
    normalized_message: str = ""
    flags: frozenset[str] = field(default_factory=frozenset)
    # confidence ของ interpretation boundary ที่ผลิต plan นี้ — resolver
    # ใช้ gate signal ต่ำ-confidence (0 = ไม่มี intent_result)
    intent_confidence: float = 0.0


def _normalize(message: str) -> tuple[str, set[str], tuple[str, ...]]:
    """ตัด placeholders/tags ออกจากข้อความลูกค้า — คืน (text, flags, item_ids)."""
    flags: set[str] = set()
    msg = message or ""
    item_ids = tuple(dict.fromkeys(
        m.group(1) for m in _ITEM_TAG_RE.finditer(msg) if m.group(1)))
    if item_ids:
        flags.add("has_item_tag")
    msg = _ITEM_TAG_RE.sub(" ", msg)
    if _VISUAL_MEDIA_PLACEHOLDER_RE.search(msg):
        flags.add("visual_media_placeholder")
    if _MEDIA_PLACEHOLDER_RE.search(msg):
        flags.add("media_placeholder")
    msg = _MEDIA_PLACEHOLDER_RE.sub(" ", msg)
    for ph in _SYSTEM_PLACEHOLDERS:
        if ph in msg.lower():
            flags.add("system_placeholder")
        msg = msg.replace(ph, "").replace(ph.upper(), "")
    for ph in _BARE_ITEM_PLACEHOLDERS:
        if ph in msg.lower():
            flags.add("bare_item_placeholder")
        msg = msg.replace(ph, "").replace(ph.upper(), "")
    return re.sub(r"\s+", " ", msg).strip(), flags, item_ids


def _resolve_ownership(ticket_state: Any) -> TurnOwnership:
    """ticket_state dict {"state": ...} / str / None → ownership axis."""
    if isinstance(ticket_state, dict):
        state = ticket_state.get("state")
    else:
        state = ticket_state
    if state in _ACTIVE_TICKET_STATES:
        return "human"
    if state in _BOT_TICKET_STATES:
        return "bot"
    return "unknown"


def _history_has_product_context(history: list[dict] | None) -> bool:
    """recent history มี product signal จริงไหม — ไม่ใช่ any-history gate."""
    if not history:
        return False
    for h in list(history)[-6:]:
        text = (h or {}).get("text") or ""
        if not text.strip():
            continue
        try:
            tnorm, tflags, _ = _normalize(text)
            if "has_item_tag" in tflags:
                return True
            # ลูกค้าเคยส่งรูป/วิดีโอในเทิร์นก่อน = subject evidence
            #   (สติกเกอร์ไม่นับ — ไม่ใช่ product signal)
            if ("visual_media_placeholder" in tflags
                    or h.get("image_desc") or h.get("images")):
                return True
            if not tnorm:
                continue  # placeholder/noise turn — ไม่นับเป็น context
            if _detectors.extract_model_keywords(tnorm):
                return True
            route = _rc.resolve_route(tnorm, {})
            if route.product_types or route.charger_subtype or route.model_codes:
                return True
        except Exception:
            continue
    return False


def _anchor_has_product_context(anchor: dict | None) -> bool:
    """active anchor (product card ของแชท) ถือเป็น product context ไหม."""
    if not isinstance(anchor, dict) or not anchor:
        return False
    return bool(str(anchor.get("name") or "").strip()
                or str(anchor.get("item_id") or "").strip())


def _has_claim_signal(msg: str) -> bool:
    """message มี claim signal ใหม่ไหม (ไม่นับ claim_state เก่า)."""
    if _warranty.detect_claim_request(msg):
        return True
    info = _warranty.extract_customer_info(msg)
    return bool(
        info.get("order_id") or info.get("phone")
        or _warranty.parse_purchase_date(msg) is not None
        or info.get("name")  # ⚡ 2B.5 — parser เป็น name validity owner เดียว
    )


def decide_turn(
    message: str,
    *,
    history: list[dict] | None = None,
    ticket_state: dict | str | None = None,
    claim_state: dict | None = None,
    intent_result: object | None = None,
    active_anchor: dict | None = None,
    tag_item_ids: tuple = (),
) -> TurnPlan:
    """สร้าง TurnPlan ของ turn — pure, deterministic (ยกเว้น intent_result ที่ caller ส่งมา)."""
    intent: dict = intent_result if isinstance(intent_result, dict) else {}
    intent_name = intent.get("intent")
    intent_conf = _rc.intent_confidence(intent)
    # structured subject deictic signal — validate typed contract, no language
    # interpretation here (resolver validates against persisted set)
    _subj_scope = intent.get("subject_scope")
    if _subj_scope not in _TURN_SUBJECT_SCOPES:
        _subj_scope = "none"
    try:
        _subj_count = intent.get("subject_count")
        _subj_count = None if _subj_count is None else int(_subj_count)
    except (TypeError, ValueError):
        _subj_count = None

    # 1. normalize + lifecycle & ownership axes
    norm, flags, item_ids = _normalize(message)
    if tag_item_ids:
        # caller-extracted tag ids (upstream แยก tag ก่อน rewrite) ≡
        # message-tag ids — owner เดียวกัน: canonical str + flag เดียวกัน
        item_ids = tuple(dict.fromkeys(
            list(item_ids) + [_rc._id_str(i) for i in tag_item_ids]))
        flags.add("has_item_tag")
    has_visual_media = "visual_media_placeholder" in flags
    flags.discard("visual_media_placeholder")
    ownership = _resolve_ownership(ticket_state)
    claim = _wf._claim_lifecycle(claim_state)

    # 2. post-handoff lock — ticket_state เป็น ownership authority เดียว:
    #   active → human_wait ทุกข้อความ ไม่มี content escape (Phase 2B.5 / M2)
    #   หยุดก่อนประเมิน needs เพื่อรับประกัน zero need-extraction side effects
    if ownership == "human":
        return TurnPlan(
            primary_action="human_wait",
            needs=(),
            ownership="human",
            claim=claim,
            requires_clarification=False,
            normalized_message=norm,
            flags=frozenset(flags | {"post_handoff"}),
            intent_confidence=intent_conf,
        )

    # 3. system/noise/placeholder — เหลือว่างหลัง cleanup
    if not norm and flags:
        if claim.accepts_claim_fields and has_visual_media:
            flags.add("claim_resume")
            return TurnPlan(
                primary_action="execute_needs",
                needs=(TurnNeed(
                    kind="claim",
                    operation="collect",
                    subject_refs=(),
                    confidence=1.0,
                    provenance=("claim_state", "media_placeholder"),
                ),),
                ownership=ownership,
                claim=claim,
                requires_clarification=False,
                normalized_message="",
                flags=frozenset(flags),
                intent_confidence=intent_conf,
            )
        return TurnPlan(
            primary_action="no_reply",
            needs=(),
            ownership=ownership,
            claim=claim,
            requires_clarification=False,
            normalized_message="",
            flags=frozenset(flags),
            intent_confidence=intent_conf,
        )
    if not norm:
        return TurnPlan(
            primary_action="clarify",
            needs=(),
            ownership=ownership,
            claim=claim,
            requires_clarification=True,
            normalized_message="",
            flags=frozenset(flags),
            intent_confidence=intent_conf,
        )

    low = norm.lower()
    media_prov: tuple[str, ...] = (
        ("media_placeholder",) if "media_placeholder" in flags else ()
    )
    needs: list[TurnNeed] = []
    # productish need scope (Phase 6) — populate หลัง _route/_is_sup_kw
    # resolve แล้ว; เฉพาะ _SCOPE_NEED_KINDS แบก scope (intent evidence
    # เท่านั้น); compat/kinds อื่น scope ว่าง + ranking ตาม kind
    _need_ranking: tuple[str, str] | None = None
    _need_ranking_compat: tuple[str, str] | None = None

    def _add_need(kind: TurnNeedKind, op: TurnNeedOp,
                  refs: tuple[str, ...] = (), conf: float = 1.0,
                  prov: tuple[str, ...] = (),
                  trefs: tuple[str, ...] = (),
                  facts: tuple[str, ...] = (),
                  asks: tuple[str, ...] = ()) -> None:
        full_prov = tuple(dict.fromkeys(prov + media_prov))
        _scope = _subj_scope if kind == "product" else "none"
        _count = _subj_count if kind == "product" else None
        if kind in _SCOPE_NEED_KINDS:
            _ptypes, _subs = _intent_types, _intent_subtypes
        else:
            _ptypes, _subs = frozenset(), frozenset()
        # typed spec contract — features/constraints เป็น criterion ของตัว
        #   item → stamp บน productish needs; facts stamp เฉพาะ need ที่
        #   emit มัน (facts param) เพื่อแยก op ของแต่ละ fact ได้
        _feats, _cons = (
            (_req_features, _req_specs)
            if kind in PRODUCTISH_NEED_KINDS else ((), ()))
        if kind == "compat":
            _rank = _need_ranking_compat or _need_ranking
        elif kind in _SCOPE_NEED_KINDS:
            _rank = _need_ranking
        else:
            _rank = None
        for idx, existing in enumerate(needs):
            if existing.kind == kind and existing.operation == op:
                merged_refs = tuple(dict.fromkeys(existing.subject_refs + refs))
                merged_trefs = tuple(dict.fromkeys(
                    existing.target_refs + trefs))
                merged_prov = tuple(dict.fromkeys(existing.provenance + full_prov))
                needs[idx] = TurnNeed(
                    kind=kind,
                    operation=op,
                    subject_refs=merged_refs,
                    target_refs=merged_trefs,
                    confidence=max(existing.confidence, conf),
                    provenance=merged_prov,
                    subject_scope=("current_single"
                                   if (_scope == "explicit"
                                       and (facts
                                            or existing.requested_facts)
                                       and not merged_refs)
                                   else _scope),
                    subject_count=_count,
                    product_types=_ptypes | existing.product_types,
                    subtypes=_subs | existing.subtypes,
                    ranking=_rank or existing.ranking,
                    requested_facts=tuple(dict.fromkeys(
                        existing.requested_facts + facts)),
                    required_features=tuple(dict.fromkeys(
                        existing.required_features + _feats)),
                    spec_constraints=tuple(dict.fromkeys(
                        existing.spec_constraints + _cons)),
                    capability_asks=tuple(dict.fromkeys(
                        existing.capability_asks + asks)),
                )
                return
        needs.append(TurnNeed(
            kind=kind,
            operation=op,
            subject_refs=refs,
            target_refs=trefs,
            confidence=conf,
            provenance=full_prov,
            subject_scope=("current_single"
                           if (_scope == "explicit" and facts and not refs)
                           else _scope),
            subject_count=_count,
            product_types=_ptypes,
            subtypes=_subs,
            ranking=_rank,
            requested_facts=facts,
            required_features=_feats,
            spec_constraints=_cons,
            capability_asks=asks,
        ))

    # 4. explicit human request (predicate เจ้าของ: handoffs)
    _is_human = _handoffs.is_human_request(norm)
    if _is_human:
        _add_need("human", "handoff", conf=1.0, prov=("handoffs.is_human_request",))

    # 5. claim resume / request / troubleshoot — ก่อน anger เสมอ
    _is_claim_resume = claim.accepts_claim_fields and (
        _has_claim_signal(norm) or has_visual_media
    )
    _is_claim_req = (
        _warranty.detect_claim_request(norm)
        or intent_name == "warranty_claim"
    )
    _has_malfunction = bool(_warranty.malfunction_safe_check(norm))

    if _is_claim_resume:
        flags.add("claim_resume")
        _add_need("claim", "collect", conf=1.0,
                  prov=("warranty_flow._claim_lifecycle", "claim_signal"))
    elif _is_claim_req:
        _add_need("claim", "collect", conf=1.0,
                  prov=("warranty.detect_claim_request",))

    if _has_malfunction and not _is_claim_resume:
        _add_need("troubleshoot", "describe", conf=0.9,
                  prov=("warranty.malfunction_safe_check",))

    # 6. service anger/frustration — เฉพาะเมื่อไม่มี claim/troubleshoot signal
    if (not _is_human and not _is_claim_resume and not _is_claim_req
            and not _has_malfunction and _handoffs.is_service_anger(norm)):
        flags.add("customer_frustration")
        _add_need("human", "handoff", conf=1.0,
                  prov=("handoffs.is_service_anger",))

    # 7. contact info / order lookup / route / detectors (canonical producers)
    _info = _warranty.extract_customer_info(norm)
    if _info.get("phone") or _info.get("order_id") or _info.get("name"):
        flags.add("contact_info")
    _contact_vals = {
        (_info.get("phone") or "").lower(),
        (_info.get("order_id") or "").lower(),
    } - {""}

    _order_sn = _order_store.extract_order_sn(message)
    _has_order_tag = bool(_order_store._ORDER_TAG_RE.search(message or ""))
    _order_match = _order_store._ORDER_SN_RE.search(message or "")
    _has_order_prefix = bool(
        _order_match and _order_match.group(0).strip().lower()
        != _order_match.group(1).strip().lower()
    )
    if (_order_sn and not _is_claim_resume and not _is_claim_req
            and (_has_order_tag or _has_order_prefix
                 or intent_name == "order_status")):
        _add_need("order", "lookup", refs=(_order_sn,), conf=0.9,
                  prov=("order_store.extract_order_sn",))

    _model_kws = [
        k for k in _detectors.extract_model_keywords(norm)
        if k.lower() not in _contact_vals
        and (not _order_sn or k.lower() not in {"order", _order_sn.lower()})
    ]
    _route = _rc.resolve_route(norm, intent)
    _dev_names = frozenset(d.lower() for d in _route.devices)
    _tgt_names = frozenset(d.lower() for d in _route.target_devices)
    _tgt_code_names = frozenset(c.lower() for c in _route.target_codes)
    _spec_toks = frozenset(_route.spec_tokens)
    _dev_spans = tuple(s.lower() for s in _route.device_spans)
    _explicit_codes = tuple(dict.fromkeys(
        c for c in _route.model_codes
        if c and c.lower() not in _contact_vals
        and not _detectors.is_target_device_kw(c)
        and c.lower().replace(" ", "") not in _spec_toks
        and not any(c.lower() in s and c.lower() != s for s in _dev_spans)
    ))
    # post-connector codes = counterpart domain (structural split จาก
    # route.target_codes — เช่น "สายชาร์จใช้กับ AD1404T": AD1404T คือ target
    # ของ cable ไม่ใช่ subject) — pre-connector codes = explicit identities
    _tgt_codes = tuple(
        c for c in _explicit_codes if c.lower() in _tgt_code_names)
    _subject_refs = tuple(dict.fromkeys(
        list(item_ids)
        + [c for c in _explicit_codes if c.lower() not in _tgt_code_names]))

    # typed roles ต่อ need kind — derive จาก route surfaces เท่านั้น
    # (validated devices + connector split + device_mode + spec_tokens +
    # intent.target_device structured field — ไม่ parse message ซ้ำ):
    #   compat need: subject = codes/subject-side devices − target-side;
    #                target = connector-following devices + intent target
    #   product/compare: model_fit/charging → devices = constraint (target);
    #                self_compat → subject-side devices = สิ่งที่ถาม;
    #                unknown/skip → เฉพาะ codes (ไม่เดา device role)
    #   kinds อื่น: subject = base refs; target = ()
    # code เท่ากับ device ตัวเดียวกัน (S25==s25) assign ฝั่งเดียว; ไม่มี
    # typed evidence → () (fail closed)
    _intent_tgt = str(intent["target_device"]).strip() \
        if intent.get("target_device") else ""
    # relation_target (structured intent field — classifier-grounded,
    # spec-filtered) — app/service counterpart ที่ไม่ใช่ device/code;
    # re-verify ground+confidence ที่ owner (fail closed)
    _rel_tgt = str(intent.get("relation_target") or "").strip()
    if _rel_tgt.lower() not in low or intent_conf < 0.7:
        _rel_tgt = ""
    _seen_t: set[str] = set()
    _tgt_refs: list[str] = []
    # product ไม่มีวันเป็น counterpart ของตัวเอง — ref ที่ normalize เท่า
    #   subject ref หรือ codes ทับ subject-side codes = mis-slot (เช่น
    #   intent target_device="IMILAB W01" ขณะ subject คือ W01) → drop;
    #   target ต่างชื่อ/ต่าง code (สตาวา/AD1404T/iphone) ไม่กระทบ
    _subj_keys_l = {str(r).lower() for r in _subject_refs}
    _subj_codes_l = {c.lower() for c in _explicit_codes
                     if c.lower() not in _tgt_code_names}
    from .scripts.unit_classifier import _extract_codes as _xcodes
    for _v in (list(_route.target_devices) + list(_tgt_codes)
               + [_intent_tgt, _rel_tgt]):
        _vl = str(_v or "").strip()
        if (not _vl or _vl.lower() in _seen_t
                or _vl.lower() in _subj_keys_l
                or {c.lower() for c in _xcodes(_vl)} & _subj_codes_l):
            continue
        _seen_t.add(_vl.lower())
        _tgt_refs.append(_v)
    _tgt_refs = tuple(_tgt_refs)
    _subj_l = {r.lower() for r in _subject_refs}
    _compat_subject = tuple(dict.fromkeys(
        [c for c in _subject_refs if c.lower() not in _tgt_names]
        + [d for d in _route.subject_devices if d.lower() not in _subj_l]))
    _compat_target = _tgt_refs
    _mode = _route.device_mode
    _prod_subject = _subject_refs + tuple(
        d for d in _route.subject_devices if d.lower() not in _subj_l) \
        if _mode == "self_compat" else tuple(
        c for c in _subject_refs if c.lower() not in _dev_names) \
        if _mode in ("model_fit", "charging") else _subject_refs
    _prod_target = (tuple(dict.fromkeys(_tgt_refs + _route.devices))
                    if _mode in ("model_fit", "charging") else _tgt_refs)

    # product scope ต่อ need = structured evidence ของ producer เท่านั้น:
    # product/compare รับ intent product scope (conf≥0.7 — type name จริง
    # / subtype domain normalize); compat + kinds อื่น = ว่าง — relation
    # scope เป็นของ RetrievalRequest/relations downstream (decide_turn ไม่
    # re-parse prose); ห้าม stamp turn-wide route scope
    _route_types = frozenset(_route.product_types)  # ranking basis เท่านั้น
    _intent_types: frozenset[str] = frozenset()
    _intent_subtypes: frozenset[str] = frozenset()
    _req_facts: tuple[str, ...] = ()
    _req_features: tuple[str, ...] = ()
    _req_specs: tuple[tuple[str, str, float], ...] = ()
    _cap_asks: tuple[str, ...] = ()
    if intent_conf >= 0.7:
        _ipt, _ist = _rc.intent_product_scope(intent)
        if _ipt:
            _intent_types = frozenset({_ipt})
        if _ist:
            _intent_subtypes = frozenset({_ist})
        # typed fact/spec/capability contract — same conf gate กับ
        #   product scope
        _req_facts, _req_features, _req_specs, _cap_asks = \
            _rc.intent_fact_scope(intent)

    # 6.5 cert standards (มอก./CE/...)
    _is_cert = bool(_warranty.detect_cert_question(norm))
    if _is_cert:
        flags.add("cert_question")
        _add_need("product", "describe", refs=_prod_subject,
                  trefs=_prod_target, conf=0.9,
                  prov=("warranty.detect_cert_question",))

    # 8. follow-up & comparison & compatibility & policy & product
    _has_product_ctx = (
        "has_item_tag" in flags
        or has_visual_media  # [รูปภาพ]/[วิดีโอ] = subject evidence จากลูกค้าเอง
        or _anchor_has_product_context(active_anchor)
        or _history_has_product_context(history)
    )
    _has_explicit_product = bool(
        "has_item_tag" in flags
        or _route.product_types
        or _route.charger_subtype
        or _explicit_codes
        or _model_kws
        or (intent_name in ("product_question", "product_recommend", "product_spec")
            and intent_conf >= 0.7)
    )

    _is_link_ask = (
        any(kw in low for kw in _LINK_NOUN_KWS)
        and any(kw in low for kw in _LINK_OBTAIN_KWS)
        and not any(kw in low for kw in _NON_PRODUCT_LINK_KWS)
    )
    # typed facts (intent boundary) เป็น op authority — kw ask ยิงเฉพาะเมื่อ
    #   fact นั้นถูกถามจริงหรือไม่มี typed evidence เลย ("speed เท่าไหร่" →
    #   facts=data_transfer_speed → price kw ห้ามยิง price need)
    _is_price_ask = (
        any(kw in low for kw in _PRICE_ASK_KWS)
        and (not _req_facts or "price" in _req_facts))
    _is_stock_ask = any(kw in low for kw in _STOCK_ASK_KWS)
    _is_select_ask = any(kw in low for kw in _SELECT_ASK_KWS)
    _is_cmp_kw = any(kw in low for kw in _rc._COMPARISON_FOLLOWUP_KW)
    _is_sup_kw = any(kw in low for kw in _rc._SUPERLATIVE_KW)

    # ranking (Phase 6 — owner เดิมคือ app.py superlative kw tables):
    #   superlative → canonical spec field; compatibility_check + charger/
    #   powerbank intent → wattage desc (เดิม app.py _is_charger_compat sort)
    if _is_sup_kw:
        _need_ranking = _rc.detect_ranking(low)
    if (_route_types | _intent_types) & {"charger", "powerbank"}:
        _need_ranking_compat = ("output_power_w", "max")

    _unanchored_followup_ask = False

    if _is_link_ask:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("link_followup")
                flags.add("needs_history")
            _add_need("product", "link", refs=_prod_subject,
                trefs=_prod_target, conf=0.8,
                      prov=("turn_decision.link_ask",))
        else:
            _unanchored_followup_ask = True

    if _is_price_ask:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("price_followup")
                flags.add("needs_history")
            _add_need("product", "price", refs=_prod_subject,
                trefs=_prod_target, conf=0.8,
                      prov=("turn_decision.price_ask",))
        else:
            _unanchored_followup_ask = True

    if _is_stock_ask:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("stock_followup")
                flags.add("needs_history")
            _add_need("product", "stock", refs=_prod_subject,
                trefs=_prod_target, conf=0.8,
                      prov=("turn_decision.stock_ask",))
        else:
            _unanchored_followup_ask = True

    if _is_select_ask:
        # self-anchoring browse ask — "มีตัวไหนบ้าง" ขอ set ทั้งหมด ไม่ได้
        #   อ้างถึง subject เดิม (ต่างจาก stock/price/link ที่ต้องมี subject)
        if _has_product_ctx and not _has_explicit_product:
            flags.add("select_followup")
            flags.add("needs_history")
        _add_need("product", "recommend", refs=_prod_subject,
                trefs=_prod_target, conf=0.8,
                  prov=("turn_decision.select_ask",))

    # typed requested_facts → canonical ops (single interpreter; facts
    #   ที่ map เป็น op เดียวกัน merge ผ่าน _add_need — fact เก็บบน need)
    if _req_facts:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("needs_history")
            for _f in _req_facts:
                _op_f = _FACT_OP.get(_f)
                if _op_f:
                    _add_need("product", _op_f, refs=_prod_subject,
                              trefs=_prod_target, conf=0.8, facts=(_f,),
                              prov=("intent.requested_facts",))
            _df = tuple(f for f in _req_facts if f in _FACT_DESCRIBE)
            if _df:
                _add_need("product", "describe", refs=_prod_subject,
                          trefs=_prod_target, conf=0.8, facts=_df,
                          prov=("intent.requested_facts",))
        else:
            _unanchored_followup_ask = True

    if _is_cmp_kw or (_is_sup_kw and _has_product_ctx and not _has_explicit_product):
        if len(_explicit_codes) >= 2 or _has_product_ctx:
            if _has_product_ctx:
                flags.add("needs_history")
            _add_need("compare", "compare", refs=_prod_subject,
                trefs=_prod_target, conf=0.85,
                      prov=("route_context._COMPARISON_FOLLOWUP_KW",))
        elif _is_cmp_kw:
            _unanchored_followup_ask = True

    # compat need (canonical producers: intent compatibility_check / target_device,
    # or route_context._REL_CONN_RE paired with target device or product signal)
    _has_target_dev = (
        bool(intent.get("target_device"))
        or bool(_rel_tgt)
        or any(_detectors.is_target_device_kw(t) for t in norm.split())
    )
    _has_compat_conn = bool(_rc._REL_CONN_RE.search(low))
    if intent_name == "compatibility_check" and intent_conf >= 0.7:
        _add_need("compat", "compat", refs=_compat_subject,
                  trefs=_compat_target, conf=intent_conf,
                  prov=("intent=compatibility_check",))
    elif _has_compat_conn and (_has_target_dev or _has_explicit_product):
        _add_need("compat", "compat", refs=_compat_subject,
                  trefs=_compat_target, conf=0.85,
                  prov=("route_context._REL_CONN_RE",))

    # policy need (canonical producers: detect_general_question,
    # detect_warranty_duration_question, route.needs_shipping, intent)
    _gen_qtype = _detectors.detect_general_question(norm)
    _is_warr_dur = _warranty.detect_warranty_duration_question(norm)
    if (intent_name in ("general_question", "warranty_duration")
            and intent_conf >= 0.7):
        _add_need("policy", "policy", refs=_subject_refs, conf=intent_conf,
                  prov=(f"intent={intent_name}",))
    elif _is_warr_dur and not _is_claim_req and not _is_claim_resume:
        _add_need("policy", "policy", refs=_subject_refs, conf=0.85,
                  prov=("warranty.detect_warranty_duration_question",))
    elif _gen_qtype and not (
            _gen_qtype == "warranty_policy"
            and (_is_claim_req or _is_claim_resume)
            and not _is_warr_dur):
        _add_need("policy", "policy", refs=_subject_refs, conf=0.8,
                  prov=(f"message_detectors.detect_general_question:{_gen_qtype}",))
    elif _route.needs_shipping and not _is_claim_req and not _is_claim_resume:
        _add_need("policy", "policy", refs=_subject_refs, conf=0.8,
                  prov=("route_context.needs_shipping",))

    # product need — emitted whenever explicit product signal exists and was
    # not already captured as a specific product operation or pure compare-only
    _has_product_or_compare_need = any(
        n.kind in ("product", "compare") for n in needs
    )
    if _has_explicit_product and not _has_product_or_compare_need:
        _op: TurnNeedOp = (
            "recommend" if intent_name == "product_recommend" else "describe"
        )
        _add_need("product", _op, refs=_prod_subject,
                  trefs=_prod_target, conf=0.75,
                  prov=("route_context.resolve_route",))

    # capability asks (intent typed contract) — stamp บน product need
    #   เดียว (describe ก่อน ไม่มีก็ product ตัวแรก; ไม่มี product need
    #   เลย → emit describe ใหม่ carry asks) — ask ทุกตัวต้องไหลเป็น
    #   typed data ของ need ที่ถามถึง subject นั้น ไม่หายที่ boundary นี้
    if _cap_asks:
        _ask_idx = next(
            (j for j, _n in enumerate(needs)
             if _n.kind == "product" and _n.operation == "describe"),
            next((j for j, _n in enumerate(needs)
                  if _n.kind == "product"), None))
        if _ask_idx is not None:
            needs[_ask_idx] = _dc_replace(
                needs[_ask_idx],
                capability_asks=tuple(dict.fromkeys(
                    needs[_ask_idx].capability_asks + _cap_asks)))
        else:
            _add_need("product", "describe", refs=_prod_subject,
                      trefs=_prod_target, conf=0.8, asks=_cap_asks,
                      prov=("intent.capability_asks",))

    # typed ask ownership (หลังทุก need emit แล้ว — order-free): ask span
    #   ที่มี typed compat target = outcome ของ compat need ตัวนั้น → move
    #   ครั้งเดียว คง span ต้นฉบับ; ask ที่ไม่มี compat target → คง need
    #   เดิม (product-side capability outcome)
    for _j in range(len(needs)):
        _n = needs[_j]
        if not _n.capability_asks:
            continue
        _kept: list = []
        for _a in _n.capability_asks:
            _an = "".join(str(_a).split()).casefold()
            _owner = next(
                (_i for _i, _m in enumerate(needs)
                 if _m.kind == "compat" and any(
                     ((_tn := "".join(str(_t).split()).casefold())
                      and _tn in _an)
                     for _t in (_m.target_refs or ()))),
                None)
            if _owner is None or _owner == _j:
                _kept.append(_a)
            else:
                needs[_owner] = _dc_replace(
                    needs[_owner],
                    capability_asks=tuple(dict.fromkeys(
                        needs[_owner].capability_asks + (_a,))))
        if tuple(_kept) != _n.capability_asks:
            needs[_j] = _dc_replace(_n, capability_asks=tuple(_kept))

    requires_clarification = bool(_unanchored_followup_ask)

    if any(n.kind == "human" and n.operation == "handoff" for n in needs):
        primary_action: TurnPrimaryAction = "handoff"
    elif _unanchored_followup_ask and not needs:
        # subject-demanding follow-up ที่ไม่มี context เลย → deterministic
        #   clarify; needs=() แต่เป็นข้อความปกติ (greeting/claim-resume text/
        #   คำถามเปิด) → execute_needs ให้ pipeline ปกติตอบ
        primary_action = "clarify"
    elif (intent_name == "greeting" and intent_conf >= 0.7
          and not needs):
        # typed social turn (intent Pass-1 boundary เท่านั้น — ไม่มี kw/regex
        #   ตรวจข้อความที่นี่): ไม่มี need → caller ตอบ greeting ตรง ไม่เข้า
        #   retrieval/subject resolver (set เดิมไม่ถูกแตะ)
        primary_action = "greeting"
    else:
        primary_action = "execute_needs"

    return TurnPlan(
        primary_action=primary_action,
        needs=tuple(needs),
        ownership=ownership,
        claim=claim,
        requires_clarification=requires_clarification,
        normalized_message=norm,
        flags=frozenset(flags),
            intent_confidence=intent_conf,
    )


def apply_resolved_subject_refs(needs, subject_ids, *,
                                plan_scope: str | None):
    """resolved persisted subject → typed need.subject_refs (ownership
    boundary เดียวของ deictic scope — caller: app.py หลัง resolver resolved).

    subject_scope=current_single + resolver คืน canonical id เดียว → id
    นั้น stamp เป็น subject_refs (exact-item authority ต่อใน slot/request/
    selection — sibling/bundle ไม่ fan-out).

    resolution ผ่าน explicit code-equivalence (plan_scope='explicit' —
    caller ส่ง scope ที่ resolution ถูกผลิต; resolver resolve ได้ก็ต่อเมื่อ
    non-digit refs ทุกตัว covered โดย persisted item เดียว) → union stamp
    id + code refs เดิม (named ref คงไว้สำหรับ render, digit id เป็น
    exact-item authority)

    scope อื่น (none/current_set) · resolved ≠ 1 ตัว · refs มี digit ·
    plan_scope ไม่ใช่ explicit → คงเดิม (explicit typed refs เป็น
    authority เสมอ — ไม่ substitute กับ item ที่ไม่ได้พิสูจน์).

    Input: needs = TurnNeed tuple; subject_ids = resolver output ids;
    plan_scope = scope ที่ resolver ถูกเรียก (ค่าเดียวกับที่ส่งให้
    resolve_subjects — caller เป็น authority ไม่ re-derive จาก needs).
    Output: TurnNeed tuple (frozen — replace สร้าง instance ใหม่เฉพาะ need
    ที่ stamp; caller ตัดสินใจ replace ใน TurnPlan)."""
    ids = tuple(str(i) for i in (subject_ids or ()))
    if len(ids) != 1:
        return tuple(needs)

    def _stamp(n):
        if n.kind not in PRODUCTISH_NEED_KINDS:
            return n
        if (n.subject_scope == "current_single"
                and not n.subject_refs):
            return _dc_replace(n, subject_refs=ids)
        if (plan_scope == "explicit"
                and n.subject_refs
                and all(not str(r).strip().isdigit()
                        for r in n.subject_refs)):
            return _dc_replace(
                n, subject_refs=ids + tuple(n.subject_refs))
        return n

    return tuple(_stamp(n) for n in needs)
