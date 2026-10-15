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
from dataclasses import dataclass, field
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
    "handoff", "clarify",
]
TurnOwnership = Literal["bot", "human", "unknown"]


TurnSubjectScope = Literal[
    "none", "explicit", "current_single", "current_set"]

_TURN_SUBJECT_SCOPES = frozenset(
    {"none", "explicit", "current_single", "current_set"})


@dataclass(frozen=True)
class TurnNeed:
    """ความต้องการอิสระ 1 รายการที่สกัดได้ใน turn เดียว.

    subject_scope/subject_count = structured deictic reference จาก
    interpretation boundary (intent Pass-1) — kind=="product" เท่านั้น;
    resolver validate กับ persisted ConversationSubjectSet"""
    kind: TurnNeedKind
    operation: TurnNeedOp
    subject_refs: tuple[str, ...] = ()
    confidence: float = 1.0
    provenance: tuple[str, ...] = ()
    subject_scope: TurnSubjectScope = "none"
    subject_count: int | None = None


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
) -> TurnPlan:
    """สร้าง TurnPlan ของ turn — pure, deterministic (ยกเว้น intent_result ที่ caller ส่งมา)."""
    intent: dict = intent_result if isinstance(intent_result, dict) else {}
    intent_name = intent.get("intent")
    intent_conf = float(intent.get("confidence") or 0.0)
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

    def _add_need(kind: TurnNeedKind, op: TurnNeedOp,
                  refs: tuple[str, ...] = (), conf: float = 1.0,
                  prov: tuple[str, ...] = ()) -> None:
        full_prov = tuple(dict.fromkeys(prov + media_prov))
        _scope = _subj_scope if kind == "product" else "none"
        _count = _subj_count if kind == "product" else None
        for idx, existing in enumerate(needs):
            if existing.kind == kind and existing.operation == op:
                merged_refs = tuple(dict.fromkeys(existing.subject_refs + refs))
                merged_prov = tuple(dict.fromkeys(existing.provenance + full_prov))
                needs[idx] = TurnNeed(
                    kind=kind,
                    operation=op,
                    subject_refs=merged_refs,
                    confidence=max(existing.confidence, conf),
                    provenance=merged_prov,
                    subject_scope=_scope,
                    subject_count=_count,
                )
                return
        needs.append(TurnNeed(
            kind=kind,
            operation=op,
            subject_refs=refs,
            confidence=conf,
            provenance=full_prov,
            subject_scope=_scope,
            subject_count=_count,
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
    _explicit_codes = tuple(dict.fromkeys(
        c for c in _route.model_codes
        if c and c.lower() not in _contact_vals
        and not _detectors.is_target_device_kw(c)
    ))
    _subject_refs = tuple(dict.fromkeys(list(item_ids) + list(_explicit_codes)))

    # 6.5 cert standards (มอก./CE/...)
    _is_cert = bool(_warranty.detect_cert_question(norm))
    if _is_cert:
        flags.add("cert_question")
        _add_need("product", "describe", refs=_subject_refs, conf=0.9,
                  prov=("warranty.detect_cert_question",))

    # 8. follow-up & comparison & compatibility & policy & product
    _has_product_ctx = (
        "has_item_tag" in flags
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
    _is_price_ask = any(kw in low for kw in _PRICE_ASK_KWS)
    _is_stock_ask = any(kw in low for kw in _STOCK_ASK_KWS)
    _is_select_ask = any(kw in low for kw in _SELECT_ASK_KWS)
    _is_cmp_kw = any(kw in low for kw in _rc._COMPARISON_FOLLOWUP_KW)
    _is_sup_kw = any(kw in low for kw in _rc._SUPERLATIVE_KW)

    _unanchored_followup_ask = False

    if _is_link_ask:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("link_followup")
                flags.add("needs_history")
            _add_need("product", "link", refs=_subject_refs, conf=0.8,
                      prov=("turn_decision.link_ask",))
        else:
            _unanchored_followup_ask = True

    if _is_price_ask:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("price_followup")
                flags.add("needs_history")
            _add_need("product", "price", refs=_subject_refs, conf=0.8,
                      prov=("turn_decision.price_ask",))
        else:
            _unanchored_followup_ask = True

    if _is_stock_ask:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("stock_followup")
                flags.add("needs_history")
            _add_need("product", "stock", refs=_subject_refs, conf=0.8,
                      prov=("turn_decision.stock_ask",))
        else:
            _unanchored_followup_ask = True

    if _is_select_ask:
        if _has_product_ctx or _has_explicit_product:
            if _has_product_ctx and not _has_explicit_product:
                flags.add("select_followup")
                flags.add("needs_history")
            _add_need("product", "recommend", refs=_subject_refs, conf=0.8,
                      prov=("turn_decision.select_ask",))
        else:
            _unanchored_followup_ask = True

    if _is_cmp_kw or (_is_sup_kw and _has_product_ctx and not _has_explicit_product):
        if len(_explicit_codes) >= 2 or _has_product_ctx:
            if _has_product_ctx:
                flags.add("needs_history")
            _add_need("compare", "compare", refs=_subject_refs, conf=0.85,
                      prov=("route_context._COMPARISON_FOLLOWUP_KW",))
        elif _is_cmp_kw:
            _unanchored_followup_ask = True

    # compat need (canonical producers: intent compatibility_check / target_device,
    # or route_context._REL_CONN_RE paired with target device or product signal)
    _has_target_dev = (
        bool(intent.get("target_device"))
        or any(_detectors.is_target_device_kw(t) for t in norm.split())
    )
    _has_compat_conn = bool(_rc._REL_CONN_RE.search(low))
    if intent_name == "compatibility_check" and intent_conf >= 0.7:
        _add_need("compat", "compat", refs=_subject_refs, conf=intent_conf,
                  prov=("intent=compatibility_check",))
    elif _has_compat_conn and (_has_target_dev or _has_explicit_product):
        _add_need("compat", "compat", refs=_subject_refs, conf=0.85,
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
        _add_need("product", _op, refs=_subject_refs, conf=0.75,
                  prov=("route_context.resolve_route",))

    requires_clarification = bool(not needs or _unanchored_followup_ask)

    if any(n.kind == "human" and n.operation == "handoff" for n in needs):
        primary_action: TurnPrimaryAction = "handoff"
    elif not needs:
        primary_action = "clarify"
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
