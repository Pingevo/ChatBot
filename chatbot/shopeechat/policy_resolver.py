"""policy_resolver.py — Phase 5 typed facts & decisions (single owner).

สาม surface ใน module เดียว:

1. Policy eligibility — PolicyQuery + PolicyRule records → PolicyDecision.
   resolve เฉพาะกับ structured records ที่ส่งเข้ามาเท่านั้น: ไม่มี record
   → unknown (ไม่ใช่ eligible), rule ขัดกัน → admin_review.
   FAQ/description/history/bot prose ไม่ใช่ input ของการตัดสิน — เป็นได้แค่
   process explanation หลังจาก decision ออกแล้วเท่านั้น.

2. Field evidence — FieldEvidence: fact ที่ผูก subject identity (canonical
   key เดียวกับ candidate_pool._identity_key). แถว fact มีเมื่อ evidence
   มีจริงเท่านั้น — ไม่มี evidence = unknown (ไม่ใช่ negative claim).

3. Compatibility — CompatProof/CompatDecision: compatible/incompatible
   ต้องมี explicit proof; ไม่มี proof → unknown; proof ขัดกัน → admin_review.

Production activation: BLOCKED — ไม่มี authoritative structured policy
source ใน production (Phase 5 blocker). active_policy_rules() คืน ()
เสมอจนกว่าจะมี record store ที่ approved; tests monkeypatch seam นี้.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime as _dt
from typing import Any

from . import candidate_pool, device_compat, guards, product_store

RULE_OUTCOMES = frozenset({"eligible", "ineligible", "admin_review"})
# closed enums ที่ classifier/owner ใช้ validate policy signals — ค่าอื่น
# clamp เป็น "unknown" (ห้ามเดาจาก keywords)
POLICY_REASONS = frozenset({"customer_wrong_model", "seller_wrong_item",
                            "defect", "damage", "unknown"})
POLICY_CONDITIONS = frozenset({"sealed", "outer_opened", "inner_opened",
                               "used", "unknown"})
POLICY_ORDER_STATES = frozenset({"unshipped", "shipped", "delivered",
                                 "unknown"})
# device-side connector evidence grades — structured sources เท่านั้นที่
# prove compatible/incompatible ได้; intent hint/web prose parse = unknown
_DEVICE_STRUCTURED_SOURCES = frozenset({"spec-db", "web-structured"})
# canonical_specs ที่ยืมมาผ่าน attach_kb_specs — provenance ต้องบอกตรง
_KB_INHERIT_SOURCE = "kb_inherit"


# ══════════════════════════════════════════════════════════════════
# policy eligibility
# ══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class PolicyQuery:
    policy_type: str
    shop: str | None
    subject_ids: tuple[str, ...]
    canonical_product_types: tuple[str, ...]
    reason: str                 # customer_wrong_model|seller_wrong_item|defect|damage|unknown
    item_condition: str         # sealed|outer_opened|inner_opened|used|unknown
    order_state: str | None
    event_time: str | None      # ISO date/datetime (evaluation instant)
    # H3 — supplied/verified evidence identities เท่านั้น (ห้ามอนุมานจาก
    # prose): evidence_by_subject = {subject_id: (evidence_ids,...)}
    evidence_ids: tuple[str, ...] = ()
    evidence_by_subject: dict = field(default_factory=dict)
    conflicting_evidence: tuple[str, ...] = ()


@dataclass(frozen=True)
class PolicyDecision:
    outcome: str                # eligible|ineligible|admin_review|unknown
    matched_rule_ids: tuple[str, ...]
    required_evidence: tuple[str, ...]
    reason_codes: tuple[str, ...]
    source_versions: tuple[str, ...]
    missing_evidence: tuple[str, ...] = ()


@dataclass(frozen=True)
class PolicyRule:
    """Versioned policy record — data, not a code branch.

    scope fields ว่าง/None = match ทุกค่า (บันทึกเฉพาะ scope ที่ rule ประกาศ).
    """
    rule_id: str
    version: str
    policy_type: str
    outcome: str                       # eligible|ineligible|admin_review
    reason: str | None = None
    item_conditions: frozenset[str] = frozenset()
    order_states: frozenset[str] = frozenset()
    shops: frozenset[str] = frozenset()
    subject_ids: frozenset[str] = frozenset()
    product_types: frozenset[str] = frozenset()
    required_evidence: tuple[str, ...] = ()
    priority: int = 0
    effective_from: str | None = None
    effective_until: str | None = None
    source: str = ""


def policy_rule_from_dict(d: dict) -> PolicyRule:
    """dict → PolicyRule — ต้องมี rule identity + version + structured
    outcome + source (prose/FAQ text ไม่ใช่ record → raise).
    effective_from/until parse ด้วย stdlib fromisoformat → เก็บเป็น
    canonical `YYYY-MM-DD` เท่านั้น (basic `YYYYMMDD` / datetime →
    normalize เป็นวันเดียวกัน); malformed → reject; until<from → reject."""
    missing = [k for k in ("rule_id", "version", "policy_type",
                           "outcome", "source") if not d.get(k)]
    if missing:
        raise ValueError(f"policy rule missing {missing}")
    if d["outcome"] not in RULE_OUTCOMES:
        raise ValueError(f"policy outcome {d['outcome']!r} not in "
                         f"{sorted(RULE_OUTCOMES)}")
    # R3 — normalize เป็น canonical YYYY-MM-DD ก่อนเก็บ: basic `YYYYMMDD`
    #   / datetime กลายเป็นวันเดียวกัน → ordering/compare ไม่พึ่ง raw
    #   string bytes อีก; range กลับ (until<from) → reject
    _eff: dict = {}
    for _k in ("effective_from", "effective_until"):
        _v = d.get(_k)
        if _v:
            try:
                _eff[_k] = _dt.fromisoformat(str(_v)).date().isoformat()
            except ValueError:
                raise ValueError(
                    f"policy rule {_k} {_v!r} not ISO date/datetime")
        else:
            _eff[_k] = None
    if (_eff["effective_from"] and _eff["effective_until"]
            and _eff["effective_until"] < _eff["effective_from"]):
        raise ValueError(
            f"policy rule effective_until {_eff['effective_until']!r} "
            f"< effective_from {_eff['effective_from']!r}")
    return PolicyRule(
        rule_id=str(d["rule_id"]), version=str(d["version"]),
        policy_type=str(d["policy_type"]), outcome=d["outcome"],
        reason=d.get("reason"),
        item_conditions=frozenset(d.get("item_conditions") or ()),
        order_states=frozenset(d.get("order_states") or ()),
        shops=frozenset(str(s) for s in (d.get("shops") or ())),
        subject_ids=frozenset(str(s) for s in (d.get("subject_ids") or ())),
        product_types=frozenset(d.get("product_types") or ()),
        required_evidence=tuple(d.get("required_evidence") or ()),
        priority=int(d.get("priority") or 0),
        effective_from=_eff["effective_from"],
        effective_until=_eff["effective_until"],
        source=str(d["source"]))


def active_policy_rules() -> tuple[PolicyRule, ...]:
    """Production policy records — BLOCKED: no authoritative structured
    source exists. Always () until an approved record store is wired;
    tests monkeypatch this seam with supplied records."""
    return ()


def build_policy_query(*, policy_type: str, intent_result: dict | None = None,
                       cards=(), shop: str | None = None,
                       order_state: str | None = None,
                       event_time: str | None = None) -> PolicyQuery:
    """PolicyQuery จาก structured inputs เท่านั้น — subject identity จาก
    candidate_pool._identity_key, reason/condition จาก intent_result fields
    (classifier semantics); ไม่ parse message/prose ที่นี่."""
    ir = intent_result or {}
    sids: list[str] = []
    types: set[str] = set()
    for c in cards or ():
        key, _dom = candidate_pool._identity_key(c)
        if key:
            sids.append(key)
        types |= product_store._detect_product_types(
            c.get("name") or c.get("item_name") or "")
        pt = c.get("product_type") or c.get("product_types")
        if isinstance(pt, str):
            types.add(pt)
        elif pt:
            types |= set(pt)
    # H4 — typed fields เท่านั้น; ค่านอก enum → "unknown" (ห้ามเดา)
    _reason = ir.get("policy_reason") or "unknown"
    if _reason not in POLICY_REASONS:
        _reason = "unknown"
    _cond = ir.get("policy_item_condition") or "unknown"
    if _cond not in POLICY_CONDITIONS:
        _cond = "unknown"
    _ost = order_state or ir.get("policy_order_state") or "unknown"
    if _ost not in POLICY_ORDER_STATES:
        _ost = "unknown"
    return PolicyQuery(
        policy_type=policy_type, shop=shop,
        subject_ids=tuple(dict.fromkeys(sids)),
        canonical_product_types=tuple(sorted(types)),
        reason=_reason, item_condition=_cond,
        order_state=None if _ost == "unknown" else _ost,
        event_time=event_time)


def _effective_status(rule: PolicyRule, event_time: str | None) -> str:
    """active|unverifiable|pending|expired — dated rule ต้อง verify window
    ได้ก่อนใช้ (เวลาไม่ทราบ/malformed → unverifiable, ไม่สมมติว่า active).
    event_time parse ด้วย stdlib fromisoformat → canonical `YYYY-MM-DD`
    เทียบกับ canonical rule dates ตรงๆ (ห้าม raw-slice string compare)."""
    if not rule.effective_from and not rule.effective_until:
        return "active"
    if not event_time:
        return "unverifiable"
    try:
        t = _dt.fromisoformat(str(event_time)).date().isoformat()
    except ValueError:
        return "unverifiable"
    if rule.effective_from and t < rule.effective_from:
        return "pending"
    if rule.effective_until and t > rule.effective_until:
        return "expired"
    return "active"


def _matches(rule: PolicyRule, q: PolicyQuery) -> bool:
    """scope ที่ rule ประกาศต้อง match query ทุกช่อง (ประกาศ = ต้องพิสูจน์)."""
    if rule.reason is not None and rule.reason != q.reason:
        return False
    if (rule.item_conditions
            and q.item_condition not in rule.item_conditions):
        return False
    if rule.order_states and q.order_state not in rule.order_states:
        return False
    if (rule.shops
            and (q.shop or "").lower()
            not in {s.lower() for s in rule.shops}):
        return False
    if (rule.subject_ids
            and not (rule.subject_ids & set(q.subject_ids))):
        return False
    if (rule.product_types
            and not (rule.product_types & set(q.canonical_product_types))):
        return False
    return True


def _specificity(rule: PolicyRule) -> int:
    return sum(bool(x) for x in (rule.subject_ids, rule.shops,
                                 rule.product_types, rule.reason,
                                 rule.item_conditions, rule.order_states))


def resolve_policy(query: PolicyQuery, rules) -> PolicyDecision:
    """deterministic resolution — input เดียวคือ query + supplied records.

    Precedence: effective-window → scope match → reason/condition/
    order_state → **tier เลือกก่อน: specificity → priority → newest
    effective_from** — conflict เช็คเฉพาะใน winner tier (rule ต่ำกว่า
    ไม่มีทาง conflict กับ rule ที่ชนะ tier). rule_id เดียวกันหลาย record:
    เลือกด้วย effective_from ล่าสุดเท่านั้น (canonical `YYYY-MM-DD` —
    `version` เป็น opaque identity ห้ามเทียบ lexicographic); same-day +
    decision payload เหมือนกันเป๊ะ → dedupe; same-day + ต่างกันใน field
    ที่กระทบ decision (outcome/scope/requirements/until ฯลฯ) →
    rule_conflict/admin_review — ห้าม union requirements เด็ดขาด.
    ไม่มี active match → unknown พร้อม reason (no_records|no_matching_rule|
    rule_expired|rule_pending|rule_window_unverifiable). ไม่มี
    default-eligible เด็ดขาด.
    matched_rule_ids เรียง specificity desc → priority desc → rule_id asc.
    """
    rules = tuple(r for r in (rules or ())
                  if r.policy_type == query.policy_type)
    if not rules:
        return PolicyDecision("unknown", (), (), ("no_records",), ())
    active: list[PolicyRule] = []
    stale_codes: set[str] = set()
    for r in rules:
        if not _matches(r, query):
            continue
        st = _effective_status(r, query.event_time)
        if st == "active":
            active.append(r)
        else:
            stale_codes.add("rule_window_unverifiable"
                            if st == "unverifiable" else f"rule_{st}")
    if active:
        # M1 — precedence tier ก่อน conflict check: specificity → priority;
        # rule เดียวกันหลาย version → version/effective ล่าสุดชนะเด็ดขาด
        order = sorted(active, key=lambda r: (-_specificity(r),
                                              -r.priority, r.rule_id))
        top = order[0]
        tier = [r for r in order
                if _specificity(r) == _specificity(top)
                and r.priority == top.priority]
        # per rule_id: newest effective_from (canonical day) เท่านั้น —
        #   ไม่เทียบ opaque version; same-day records: payload เหมือนกัน
        #   เป๊ะ → dedupe; ต่างกันใน field ที่กระทบ decision → rule_conflict
        #   (ห้าม union requirements/source เป็น rule ประดิษฐ์)
        _by_id: dict[str, list[PolicyRule]] = {}
        for r in tier:
            _by_id.setdefault(r.rule_id, []).append(r)
        _winners_raw: list[PolicyRule] = []
        _amb_ids: list[str] = []
        _amb_vers: list[str] = []
        for _rid in sorted(_by_id):
            _recs = _by_id[_rid]
            _max_day = max(r.effective_from or "" for r in _recs)
            _tops = [r for r in _recs
                     if (r.effective_from or "") == _max_day]
            _sigs = {
                (r.outcome, r.reason, r.item_conditions, r.order_states,
                 r.shops, r.subject_ids, r.product_types,
                 r.required_evidence, r.priority, r.effective_until)
                for r in _tops}
            if len(_sigs) > 1:
                _amb_ids.append(_rid)
                _amb_vers += [f"{r.source}@{r.version}" for r in _tops]
            else:
                _winners_raw.append(_tops[0])
        if _amb_ids:
            return PolicyDecision(
                "admin_review", tuple(_amb_ids), (),
                ("rule_conflict",),
                tuple(dict.fromkeys(_amb_vers)), ())
        winners = sorted(_winners_raw,
                         key=lambda r: (-_specificity(r), -r.priority,
                                        r.rule_id))
        ids = tuple(dict.fromkeys(r.rule_id for r in winners))
        req_ev = tuple(dict.fromkeys(
            e for r in winners for e in r.required_evidence))
        vers = tuple(dict.fromkeys(
            f"{r.source}@{r.version}" for r in winners))
        outcomes = {r.outcome for r in winners}
        if len(outcomes) > 1:
            return PolicyDecision("admin_review", ids, req_ev,
                                  ("rule_conflict",), vers, ())
        codes = ["rule_match"]
        if query.reason != "unknown":
            codes.append(f"reason:{query.reason}")
        if query.item_condition != "unknown":
            codes.append(f"condition:{query.item_condition}")
        if query.order_state:
            codes.append(f"order_state:{query.order_state}")
        # H3 — evidence ที่ rule ชนะประกาศต้อง supplied+consistent;
        #   ขาด/ขัด → admin_review (ห้ามตี eligible/ineligible ลอยๆ)
        supplied = set(query.evidence_ids or ())
        for _esid in query.subject_ids:
            supplied |= set(
                (query.evidence_by_subject or {}).get(_esid) or ())
        conflicted = tuple(e for e in req_ev
                           if e in set(query.conflicting_evidence or ()))
        missing = tuple(e for e in req_ev if e not in supplied)
        if conflicted:
            return PolicyDecision("admin_review", ids, req_ev,
                                  tuple(codes) + ("evidence_conflict",),
                                  vers, missing)
        if missing:
            return PolicyDecision("admin_review", ids, req_ev,
                                  tuple(codes) +
                                  ("missing_required_evidence",),
                                  vers, missing)
        return PolicyDecision(outcomes.pop(), ids, req_ev,
                              tuple(codes), vers, ())
    code = sorted(stale_codes)[0] if stale_codes else "no_matching_rule"
    return PolicyDecision("unknown", (), (), (code,), (), ())


# ══════════════════════════════════════════════════════════════════
# field evidence — identity-scoped typed facts
# ══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class FieldEvidence:
    subject_id: str       # canonical identity key (i:/v:/u:/n: หรือ device:<name>)
    fact_key: str         # stable key: canonical_specs key, output_w,
                          # capacity_mah, connector, protocols, certifications,
                          # warranty, water_rating, wifi_bands, spec_tokens,
                          # declares_device, wired_w, wireless_w, min_watt, year
    value: Any
    status: str           # "known" — emit เฉพาะเมื่อ evidence มีจริง
    source: str           # canonical_specs|card_text|card|device_specs|order|declared
    source_version: str = ""
    provenance: str = ""  # diagnostic path — ไม่ใช่ input ของพฤติกรรม


def _norm_tok(s: str) -> str:
    return re.sub(r"[\s,]+", "", (s or "").lower())


def _norm_val(v):
    if isinstance(v, (list, tuple, set)):
        return tuple(sorted(str(x).strip() for x in v if str(x).strip()))
    if isinstance(v, str):
        return " ".join(v.split())
    return v


def _card_text(card: dict) -> str:
    return " ".join(str(card.get(k) or "") for k in (
        "name", "item_name", "description", "raw_description",
        "description_excerpt", "image_text", "warranty_text"))


def _spec_tokens(text: str) -> tuple[str, ...]:
    """spec token surface เดียวกับ guards._SPEC_CLAIM_RE (reuse — ไม่ใช่
    table ใหม่) normalize เป็น spaceless-lower."""
    return tuple(sorted({_norm_tok(m.group(0))
                         for m in guards._SPEC_CLAIM_RE.finditer(text)}))


def _warranty_months(card: dict) -> int | None:
    w = card.get("warranty")
    if isinstance(w, dict) and isinstance(
            w.get("duration_months"), (int, float)):
        return int(w["duration_months"])
    if isinstance(w, (int, float)) and w:
        return int(w)
    name = card.get("name") or card.get("item_name") or ""
    if name:
        from . import warranty as _warranty
        m = _warranty.extract_warranty_from_name(name)
        if isinstance(m, dict) and m.get("months"):
            return int(m["months"])
    return None


def _declares(card: dict, device: str) -> bool:
    """card text ประกาศ device ตรงๆ (boundary match เดียวกับ
    device_compat._device_mentioned — ทั้งมี/ไม่มีช่องว่าง)."""
    low = (device or "").strip().lower()
    if len(low) < 3:
        return False
    text = _card_text(card).lower()
    return any(device_compat._term_boundary_match(v, text)
               for v in (low, low.replace(" ", "")))


def extract_field_facts(card: dict, *, subject_id: str = "",
                        source_version: str = "",
                        mentions: tuple[str, ...] = ()
                        ) -> tuple[FieldEvidence, ...]:
    """card → typed facts ที่ผูก canonical subject identity เดียว.

    emit เฉพาะ fact ที่ evidence มีจริง — ไม่มี fact row = unknown
    (ห้ามตีเป็น negative). แหล่ง: canonical_specs (structured) → fact_key
    ตาม canonical key; card text → spec_tokens/certifications/connector
    (parser เดิมทั้งหมด); warranty → เดือนรับประกัน; mentions →
    declares_device (declared compat)."""
    sid = subject_id or candidate_pool._identity_key(card)[0]
    if not sid:
        return ()
    facts: list[FieldEvidence] = []

    def add(key, val, source, prov):
        if val in (None, "", (), [], {}):
            return
        facts.append(FieldEvidence(
            sid, key, _norm_val(val), "known", source,
            source_version, prov))

    # scoped ctx card อาจถูกตัด field text ออกเหลือ typed spec_facts —
    #   fold กลับเป็น fact row (extract owner เดียว → guard/verifier เห็น
    #   fact เดียวกับตอน eval)
    _sf = card.get("spec_facts")
    if isinstance(_sf, dict):
        for k, v in _sf.items():
            add(str(k), v, "spec_facts", f"spec_facts.{k}")

    specs = card.get("canonical_specs") or card.get("specs") or {}
    # specs ที่ยืมมาจาก attach_kb_specs (model_codes ของ unit เอง — identity
    # เดียวกัน ไม่ใช่ข้าม product) ต้องบอก provenance ตรง — hint grade
    _specs_src = (_KB_INHERIT_SOURCE
                  if card.get("_specs_origin") == _KB_INHERIT_SOURCE
                  else "canonical_specs")
    if isinstance(specs, dict):
        for k, v in specs.items():
            add(str(k), v, _specs_src, f"{_specs_src}.{k}")
        fct = specs.get("fast_charge_tech")
        if fct:
            add("protocols", fct if isinstance(fct, (list, tuple))
                else re.split(r"[,/|]+", str(fct)),
                _specs_src, f"{_specs_src}.fast_charge_tech")

    text = _card_text(card)
    add("spec_tokens", _spec_tokens(text), "card_text",
        "name+description+image_text+warranty_text")
    certs = tuple(sorted(
        c for c in product_store._CERT_SEARCH_RES
        if product_store._has_cert(text, (c,))))
    add("certifications", certs, "card_text", "card text cert match")
    conns = device_compat._extract_product_connectors(card)
    add("connector", conns, "card_text", "connector extract")
    add("output_w", device_compat._extract_max_wattage(card) or None,
        "card", "output_power_w|variants|name")
    # structured-only watt values สำหรับ compat verdict — name/title/
    #   description ไม่ใช่ wattage proof (parse fallback ของ
    #   _extract_max_wattage ใช้ได้แค่ retrieval/ranking ไม่ใช่ verdict);
    #   canonical owner = device_compat._structured_watts (set ครบทุก
    #   structured value: card-level + specs + ทุก variant, numeric/
    #   finite/>0 เท่านั้น) — resolve_compat ประเมินความสัมพันธ์ทั้ง
    #   set กับ min_watt
    add("output_w_structured",
        device_compat._structured_watts(card) or None,
        "card", "output_power_w|variants (structured only)")
    # canonical numeric/feature facts (extractor owner เดียวกัน — ไม่มี
    #   evidence → ไม่ emit row = unknown ไม่ใช่ negative)
    add("data_transfer_mbps",
        device_compat._extract_data_transfer_mbps(card) or None,
        "card", "data_transfer_mbps|variants|name+desc")
    # features: structured feature field ไม่มีบน card/unit contract →
    #   ไม่ emit row (unknown ไม่ใช่ negative — keyword inference บน card
    #   text ถูกลบ: MISSING_STRUCTURED_PRODUCT_FEATURE_EVIDENCE)
    months = _warranty_months(card)
    if months:
        add("warranty", months, "card", "warranty|name")
    for m in mentions or ():
        if _declares(card, m):
            add("declares_device", m, "card_text", "name+description")
    return tuple(facts)


# ══════════════════════════════════════════════════════════════════
# typed spec-constraint eval — numeric/feature evidence owner เดียว
# (FieldEvidence จาก extract_field_facts เท่านั้น; ไม่มี evidence → unknown)

_CMP_OPS = {
    "gte": lambda a, b: a >= b,
    "lte": lambda a, b: a <= b,
    "gt": lambda a, b: a > b,
    "lt": lambda a, b: a < b,
    "eq": lambda a, b: a == b,
}
_CONSTRAINT_UNITS = {
    "data_transfer_mbps": "Mbps", "output_power_w": "W",
    "capacity_mah": "mAh", "cable_length_m": "m"}


def eval_spec_constraints(
        facts,
        spec_constraints: tuple[tuple[str, str, float], ...] = (),
        required_features: tuple[str, ...] = ()) -> dict:
    """FieldEvidence tuple × typed constraints/features → verdict map.

    fail = fact evidence มีจริงและขัดเงื่อนไข (best numeric claim ต่ำกว่า/
    สูงกว่า threshold); ไม่มี fact row/cast ไม่ได้ → unknown (ห้ามตีเป็น
    negative); borrowed (_KB_INHERIT_SOURCE) specs เป็น hint grade —
    ไม่ ground verdict; required_features: token ไม่อยู่ → unknown
    returns {"status","satisfied","failed","unknown","detail"} — failed/
    unknown/satisfied คือ key names; detail[field]=(op,want,best)
    """
    fmap: dict[str, list] = {}
    for f in facts or ():
        if getattr(f, "source", "") == _KB_INHERIT_SOURCE:
            continue  # borrowed spec — hint grade, ไม่ ground verdict
        fmap.setdefault(f.fact_key, []).append(f)
    satisfied: list[str] = []
    failed: list[str] = []
    unknown: list[str] = []
    detail: dict[str, tuple] = {}
    for field_, op, want in spec_constraints or ():
        fn = _CMP_OPS.get(op)
        nums: list[float] = []
        for f in fmap.get(field_, ()):
            for v in (f.value if isinstance(f.value, tuple)
                      else (f.value,)):
                try:
                    nums.append(float(v))
                except (TypeError, ValueError):
                    continue
        if fn is None or not nums:
            unknown.append(field_)
            continue
        best = max(nums)  # card claim semantics "สูงสุดถึง" — best value
        detail[field_] = (op, float(want), best)
        if fn(best, float(want)):
            satisfied.append(field_)
        else:
            failed.append(field_)
    if required_features:
        feats = {str(v).lower() for f in fmap.get("features", ())
                 for v in (f.value if isinstance(f.value, tuple)
                           else (f.value,))}
        for f_ in required_features:
            (satisfied if str(f_).lower() in feats
             else unknown).append(f_)
    status = ("none" if not (spec_constraints or required_features)
              else "fail" if failed
              else "pass" if not unknown else "unknown")
    return {"status": status, "satisfied": satisfied,
            "failed": failed, "unknown": unknown, "detail": detail}


def format_constraint_value(field: str, value: float) -> str:
    """constraint field value → human unit ("10Gbps" สำหรับ Mbps≥1000 ที่
    ลงตัว, "480Mbps", "240W") — display owner เดียวของ spec contract"""
    if field == "data_transfer_mbps" and value >= 1000 \
            and float(value) % 1000 == 0:
        return f"{value / 1000:g}Gbps"
    unit = _CONSTRAINT_UNITS.get(field, "")
    return f"{value:g}{unit}"


def device_field_facts(device_name: str, spec: dict
                       ) -> tuple[FieldEvidence, ...]:
    """device spec dict (DEVICE_SPECS/web-structured) → target-side facts
    ผูก subject 'device:<normalized name>'."""
    sid = f"device:{(device_name or '').strip().lower()}"
    facts: list[FieldEvidence] = []
    for key in ("connector", "wired_w", "wireless_w", "min_watt",
                "protocols", "year"):
        v = (spec or {}).get(key)
        if v in (None, "", (), []):
            continue
        facts.append(FieldEvidence(
            sid, key, _norm_val(v), "known",
            spec.get("source") or "device_specs",
            str(spec.get("source_version") or ""),
            f"device_specs.{key}"))
    return tuple(facts)


# spec token → canonical field unit normalize (scale เดียวกับ intent
# spec_constraints: 10Gbps→10000 = data_transfer_mbps canonical value)
_FIELD_UNITS = {
    "data_transfer_mbps": (("gbps", 1000.0), ("mbps", 1.0)),
    "output_w": (("kw", 1000.0), ("w", 1.0)),
    "output_power_w": (("kw", 1000.0), ("w", 1.0)),
    "capacity_mah": (("ah", 1000.0), ("mah", 1.0)),
    "cable_length_m": (("mm", 0.001), ("cm", 0.01), ("m", 1.0)),
}
_TOK_NUM_RE = re.compile(r"^(\d+(?:\.\d+)?)([a-z]+)$")


def _tok_field_value(tok: str):
    """spec token → ({canonical fact_keys}, normalized value) — unit scale
    เดียวกับ _FIELD_UNITS (field aliases ร่วมหน่วยคืนครบ); หน่วยไม่อยู่ใน
    ตาราง → None (ไม่ ground)."""
    m = _TOK_NUM_RE.match(tok)
    if not m:
        return None
    num, unit = float(m.group(1)), m.group(2)
    fields = {fk for fk, aliases in _FIELD_UNITS.items()
              if any(u == unit for u, _ in aliases)}
    if not fields:
        return None
    scale = next(s for fk in fields
                 for u, s in _FIELD_UNITS[fk] if u == unit)
    return frozenset(fields), num * scale


def claim_supported(facts, subject_id: str, token: str) -> bool:
    """claim token ถูก support โดย facts ของ subject นั้นเองเท่านั้น —
    subject อื่น/ไม่มี evidence → False (unknown, ไม่ใช่ negative)."""
    t = _norm_tok(token)
    if not t:
        return False
    tn = _tok_field_value(t)
    for f in facts or ():
        if f.subject_id != subject_id:
            continue
        if f.source == _KB_INHERIT_SOURCE:
            continue  # borrowed spec = hint grade — ไม่ ground claim
        vals = f.value if isinstance(f.value, tuple) else (f.value,)
        if f.fact_key in ("spec_tokens", "certifications") \
                and t in {_norm_tok(str(v)) for v in vals}:
            return True
        if f.fact_key == t:
            return True
        if isinstance(f.value, str) and _norm_tok(f.value) == t \
                and f.fact_key not in ("spec_tokens", "declares_device"):
            return True
        if tn and f.fact_key in tn[0]:
            for v in vals:
                try:
                    if float(v) == tn[1]:
                        return True
                except (TypeError, ValueError):
                    continue
    return False


# ══════════════════════════════════════════════════════════════════
# compatibility — explicit proof required for both directions
# ══════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class CompatProof:
    subject_id: str
    target: str
    relation: str          # charges|fits|works_with
    verdict: str           # compatible|incompatible
    facts: tuple[str, ...] = ()
    source: str = ""
    source_version: str = ""


@dataclass(frozen=True)
class CompatDecision:
    outcome: str           # compatible|incompatible|unknown|admin_review
    proofs: tuple[CompatProof, ...]
    reason_codes: tuple[str, ...]


COMPAT_RELATIONS = frozenset({"charges", "connects", "fits", "works_with"})
# compat_mode → relation เดียว (typed enum translation — ไม่ใช่ keyword
# match; owner เดียวสำหรับทุก consumer — ห้าม broad else→charges)
_MODE_RELATION = {
    "connector_required": "charges",
    "power_required": "charges",
    "charging": "charges",
    "model_fit": "fits",
    "self_compat": "connects",
    "bluetooth_general": "works_with",
}


def compat_relation_for_mode(mode: str | None) -> str | None:
    """canonical compat_mode → relation — unknown/none/skip/""/malformed
    → None (fail closed, ไม่เดา/ไม่ fallback เป็น charges)"""
    return _MODE_RELATION.get(mode if isinstance(mode, str) else "")
# known contract sources ของ declared proof — customer ผ่าน shape แต่
# resolver downgrade เป็น admin_review เสมอ (unverified); นอก set = unknown
# → reject (fail closed, ไม่ coerce เป็น trusted)
COMPAT_PROOF_SOURCES = frozenset(
    {"spec-db", "web-structured", "customer"})


def compat_proof_from_dict(d: dict) -> CompatProof:
    """validated CompatProof builder — owner เดียวของ dict→proof;
    malformed/unknown-source → ValueError (caller fail closed)."""
    missing = [k for k in ("subject_id", "target", "relation",
                           "verdict", "source") if not d.get(k)]
    if missing:
        raise ValueError(f"compat proof missing {missing}")
    if d["relation"] not in COMPAT_RELATIONS:
        raise ValueError(f"compat relation {d['relation']!r} invalid")
    if d["verdict"] not in ("compatible", "incompatible"):
        raise ValueError(f"compat verdict {d['verdict']!r} invalid")
    if d["source"] not in COMPAT_PROOF_SOURCES:
        raise ValueError(f"compat proof source {d['source']!r} unknown")
    return CompatProof(
        subject_id=str(d["subject_id"]), target=str(d["target"]),
        relation=str(d["relation"]), verdict=d["verdict"],
        facts=tuple(d.get("facts") or ()),
        source=str(d["source"]),
        source_version=str(d.get("source_version") or ""))


def _fact_vals(facts, subject_id: str, fact_key: str) -> set:
    sid = (subject_id or "").lower()
    out: set = set()
    for f in facts or ():
        if f.subject_id.lower() != sid or f.fact_key != fact_key:
            continue
        vals = f.value if isinstance(f.value, tuple) else (f.value,)
        out |= {_norm_tok(str(v)) for v in vals}
    return out


def _fact_src(facts, subject_id: str, fact_key: str) -> str:
    sid = (subject_id or "").lower()
    for f in facts or ():
        if f.subject_id.lower() == sid and f.fact_key == fact_key:
            return f.source
    return ""


def _unk(*codes: str) -> CompatDecision:
    return CompatDecision("unknown", (), tuple(codes))


def resolve_compat(*, subject_id: str, target: str, relation: str,
                   subject_facts=(), target_facts=(), declared=()
                   ) -> CompatDecision:
    """compat decision สำหรับ (subject, target, relation) เดียว — proof
    ต้องผูก subject_id/target เดียวกันเป๊ะ (evidence ของ subject อื่นใช้ไม่ได้).

    1. declared proofs (supplied records) — ขัดกัน → admin_review;
       customer-sourced อย่างเดียว → admin_review (ยังไม่ verify)
    2. relation=charges — connector match = positive proof; disjoint =
       incompatible เฉพาะเมื่อ connector มาจาก structured source;
       usb-a→usb-c = bridge possible → unknown; ไม่มี connector
       evidence → unknown
    3. relation=fits/works_with — declares_device fact เท่านั้นที่เป็น
       positive proof; ไม่มี → unknown (ห้าม derive negative)
    """
    _sid = (subject_id or "").lower()
    _tgt = (target or "").lower()
    decl = [p for p in (declared or ())
            if p.subject_id.lower() == _sid and p.target.lower() == _tgt
            and p.relation == relation]
    if decl:
        cust = [p for p in decl if p.source == "customer"]
        rest = [p for p in decl if p.source != "customer"]
        if rest:
            verdicts = {p.verdict for p in rest}
            if cust and {p.verdict for p in cust} != verdicts:
                return CompatDecision(
                    "admin_review", tuple(decl),
                    ("proof_conflict", "customer_evidence_unverified"))
            if len(verdicts) > 1:
                return CompatDecision("admin_review", tuple(rest),
                                      ("proof_conflict",))
            return CompatDecision(verdicts.pop(), tuple(rest),
                                  ("declared_proof",))
        return CompatDecision("admin_review", tuple(cust),
                              ("customer_evidence_unverified",))

    # derive — evidence ต้องเป็นของ subject/target นี้เท่านั้น
    # charges/connects ใช้ connector logic เดียวกัน: declared connector set
    # (จาก listing ของ product เอง) ที่ไม่ครอบ device connector = negative
    # proof; usb-a→usb-c bridge ได้ใน principle → unknown; ไม่มี connector
    # evidence ฝั่งใดฝั่งหนึ่ง → unknown
    if relation in ("charges", "connects"):
        dev = _fact_vals(target_facts, target, "connector")
        sub = _fact_vals(subject_facts, subject_id, "connector")
        if not dev or not sub:
            return _unk("missing_connector_evidence")
        # H6 — device-side connector ต้องมาจาก structured source เท่านั้น
        # (spec-db/web-structured); intent hint/web prose parse = unknown
        if _fact_src(target_facts, target, "connector") \
                not in _DEVICE_STRUCTURED_SOURCES:
            return _unk("hint_only_device_evidence")
        hit = dev & sub
        src = _fact_src(subject_facts, subject_id, "connector")
        if hit:
            proof = CompatProof(
                subject_id, target, relation, "compatible",
                (f"connector:{sorted(hit)[0]}",), src)
            # wattage truth — connector fit พิสูจน์การเชื่อมต่อเท่านั้น:
            #   target มี structured min_watt → ประเมิน structured watt
            #   ทุกค่าที่เป็นไปได้เทียบ min (verdict คง compatible — ห้าม
            #   ตี unknown เป็น full-speed หรือตัดเป็น incompatible):
            #   ไม่มี structured watt → missing_wattage_evidence ·
            #   ทุกค่า < min → insufficient_wattage (known-below) ·
            #   ทุกค่า ≥ min → adequate (variant ใดก็พอ — clean) ·
            #   mixed → wattage_variant_unconfirmed (ห้ามใช้ max
            #   เป็นหลักฐาน — ยังไม่รู้ selected variant)
            _rc = ["connector_match"]
            if relation == "charges":
                _req_w = 0.0
                for _v in _fact_vals(target_facts, target, "min_watt"):
                    try:
                        _fv = float(_v)
                    except (TypeError, ValueError):
                        continue
                    # NaN/Inf/negative ไม่ใช่ requirement ที่ valid —
                    #   watt ไม่ควรกลายเป็น adequacy claim จาก target ที่
                    #   malformed
                    if math.isfinite(_fv):
                        _req_w = max(_req_w, _fv)
                _ws = []
                for _v in _fact_vals(
                        subject_facts, subject_id,
                        "output_w_structured"):
                    try:
                        _fw = float(_v)
                    except (TypeError, ValueError):
                        continue
                    if math.isfinite(_fw):
                        _ws.append(_fw)
                if _req_w > 0:
                    if not _ws:
                        _rc.append("missing_wattage_evidence")
                    elif all(_w < _req_w for _w in _ws):
                        _rc.append("insufficient_wattage")
                    elif any(_w < _req_w for _w in _ws):
                        _rc.append("wattage_variant_unconfirmed")
            return CompatDecision("compatible", (proof,), tuple(_rc))
        if "usb-a" in sub and "usb-c" in dev:
            return _unk("adapter_bridge_possible")
        proof = CompatProof(
            subject_id, target, relation, "incompatible",
            (f"connector_disjoint:{sorted(sub)}x{sorted(dev)}",),
            src)
        return CompatDecision("incompatible", (proof,),
                              ("connector_disjoint",))

    if relation in ("fits", "works_with"):
        want = target.lower().removeprefix("device:")
        for f in subject_facts or ():
            if f.subject_id.lower() != _sid or \
                    f.fact_key != "declares_device":
                continue
            have = _norm_tok(str(f.value))
            if have == _norm_tok(want) or device_compat._term_boundary_match(
                    str(f.value).lower(), want):
                return CompatDecision(
                    "compatible",
                    (CompatProof(subject_id, target, relation,
                                 "compatible", (f"declares:{f.value}",),
                                 f.source),),
                    ("declared_fit",))
        return _unk(f"no_declared_{relation}_evidence")

    return _unk("unknown_relation")
