"""route_context.py — resolve ข้อมูล routing จาก message จุดเดียว.

ทำไมมีไฟล์นี้:
- app.py เดิมเรียก _detect_product_types / _detect_charger_subtype / แก้ typo
  กระจายหลายจุดด้วย argument ต่างกัน → ย้ายมาไว้ที่เดียว ทดสอบได้
- `normalize_message` แก้ typo เทียบ `exports/typo_dict.json` (คำจริงจาก catalog)
  — แก้เฉพาะที่ชัวร์ (rapidfuzz ≥85) ไม่เดา

ผู้ใช้: units.fetch_units (Task 8) — และภายหลัง app.py ค่อยย้ายมาใช้
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent.parent.parent
_TYPO_DICT_PATH = _ROOT / "exports" / "typo_dict.json"

_TYPO_THRESHOLD = 85          # rapidfuzz score ขั้นต่ำที่ถือว่า typo จริง
_TYPO_MIN_LEN = 4             # คำสั้นกว่านี้ไม่แก้ (เสี่ยงแก้ผิด เช่น ec4 → ec2)

_SPEC_WORDS = ("สเปค", "spec", "รายละเอียด", "ขนาด", "น้ำหนัก", "วัตต์", "w ",
               "ความเร็ว", "รองรับ", "กี่วัตต์", "mah", "ความจุ", "ชาร์จเร็ว",
               "อินพุต", "เอาท์พุต", "input", "output", "พอร์ต")
_WARRANTY_WORDS = ("ประกัน", "รับประกัน", "warranty", "เคลม", "ศูนย์")
_SHIPPING_WORDS = ("จัดส่ง", "ส่งของ", "ขนส่ง", "ค่าส่ง", "กี่วัน", "ส่งไว")

# ── generic question-shape detector constants (owner เดิมคือ app.py — ย้ายมาที่นี่
#    เพราะเป็นของ route/facts ไม่ใช่ flow; app.py alias กลับเพื่อไม่เปลี่ยน flow) ──
_COMPARISON_FOLLOWUP_KW = ("ต่างกัน", "ต่างยังไง", "ต่างไหม", "เปรียบเทียบ", "เทียบ", "เทียบกัน",
                           "แนะนำตัวไหนดี", "ตัวไหนดีกว่า", "อันไหนดีกว่า", "ซื้อตัวไหนดี",
                           "เลือกตัวไหนดี", "ตัวไหนน่าซื้อ", "อันไหนน่าซื้อ",
                           # คำเปรียบเทียบโดยนัย — "อันไหนใหม่กว่า/ถูกกว่า/ล่าสุด"
                           "ใหม่กว่า", "ถูกกว่า", "ล่าสุด")
_SUPERLATIVE_KW = ("สุด", "ที่สุด", "แรงสุด", "ไวสุด", "เร็วสุด", "มากสุด", "น้อยสุด",
                   "แรงที่สุด", "ไวที่สุด", "เร็วที่สุด", "มากที่สุด", "น้อยที่สุด",
                   "เบาสุด", "จุมากสุด", "คุ้มสุด", "คุ้มที่สุด",
                   "กว่านี้", "เร็วกว่า", "แรงกว่า", "ไวกว่า", "ดีกว่า", "มากกว่า",
                   "ไวๆ", "เร็วๆ", "แรงๆ", "ชาร์จไว", "ชาร์จเร็ว")
# คำอ้าง "ชิ้นเดียว" (deictic) — ถ้ามี = ถามเกี่ยวกับ anchor ไม่ใช่เทียบชุด
#   กัน false positive ของ _SUPERLATIVE_KW เช่น "ตัวนี้ชาร์จเร็วไหม" (ไม่ใช่ set question)
_SINGLE_ITEM_REF_KW = ("ตัวนี้", "รุ่นนี้", "อันนี้", "ชิ้นนี้", "สินค้านี้", "เรือนนี้")

# superlative → canonical spec field (ย้ายมาจาก app.py superlative block —
# kw → (field, direction) เจ้าของเดียว; spec fields ตาม CSV schema)
_RANK_FIELD_KWS = (
    (("ไว", "แรง", "เร็ว", "w", "watt", "ชาร์จไว", "จ่ายไฟ"),
     "output_power_w", "max"),
    (("จุ", "ความจุ", "mah", "capacity", "แบตเยอะ", "แบตมาก"),
     "capacity_mah", "max"),
    (("เบา", "น้ำหนัก", "weight", "เบาสุด", "น้อยสุด"),
     "package_weight", "min"),
)


def detect_ranking(low: str) -> tuple[str, str] | None:
    """superlative message → (canonical spec field, "max"|"min") ตามลำดับ
    wattage → capacity → weight (parity กับ app.py เดิม); ไม่ match → None"""
    for kws, field, direction in _RANK_FIELD_KWS:
        if any(kw in low for kw in kws):
            return (field, direction)
    return None


@dataclass
class RouteContext:
    """ข้อมูล routing ที่ resolve แล้วจาก message เดียว.

    devices/subject_devices/target_devices = device names ที่ผ่าน
    authoritative validation (`_lookup_spec_db`/`_SPEC_INDEX`) เท่านั้น —
    subject/target domain split ตาม position vs first relation connector
    (`_REL_CONN_RE` grammar owner) — เป็น structural surface ไม่ใช่ role
    verdict; `decide_turn` assign role ให้แต่ละ need จาก surface เหล่านี้.
    spec_tokens = spec-claim tokens (`policy_resolver._spec_tokens` owner)
    — IP rating/protocol/wattage — ไม่ใช่ product identity.
    device_mode = `_dc._compat_mode` — domain ของ device ใน ask
    (model_fit/charging = device เป็น constraint; self_compat = device คือ
    สิ่งที่ถาม; unknown/skip = ไม่มี typed role)."""
    message: str                      # message หลัง normalize
    product_types: set[str] = field(default_factory=set)
    charger_subtype: str | None = None
    model_codes: list[str] = field(default_factory=list)
    needs_spec: bool = False
    needs_warranty: bool = False
    needs_shipping: bool = False
    corrections: dict[str, str] = field(default_factory=dict)  # typo → คำที่แก้
    devices: tuple[str, ...] = ()          # validated device mentions (order)
    subject_devices: tuple[str, ...] = ()  # validated devices ก่อน first connector
    target_devices: tuple[str, ...] = ()   # validated devices หลัง first connector
    target_codes: tuple[str, ...] = ()     # model codes หลัง first connector (structural split เดียวกับ target_devices)
    device_spans: tuple[str, ...] = ()     # raw device-candidate spans (ทุก candidate — code containment surface)
    spec_tokens: tuple[str, ...] = ()      # spec claims — ไม่ใช่ identity
    device_mode: str = "unknown"           # _dc._compat_mode device-role domain


_typo_sets: dict[str, set[str]] | None = None


def _load_typo_dict() -> dict[str, set[str]]:
    """โหลด typo_dict.json ครั้งเดียว (lazy) — ไม่มีไฟล์ → empty sets."""
    global _typo_sets
    if _typo_sets is None:
        try:
            d = json.loads(_TYPO_DICT_PATH.read_text(encoding="utf-8"))
        except Exception:
            d = {}
        _typo_sets = {k: set(v) for k, v in d.items()}
    return _typo_sets


def normalize_message(message: str) -> tuple[str, dict[str, str]]:
    """แก้ typo เทียบคำจริงใน catalog — คืน (ข้อความที่แก้, {เดิม:แก้}).

    กฎ: เฉพาะ token latin ≥4 chars; เลือก candidate ที่ score สูงสุด ≥85
    และไม่ใช่คำเดิมเป๊ะ (คำถูกอยู่แล้ว → score 100 กับตัวเอง → ข้าม)
    """
    if not message:
        return message, {}
    from rapidfuzz import fuzz, process

    td = _load_typo_dict()
    vocab = td.get("product_words", set()) | td.get("model_codes", set()) | td.get("brands", set())
    if not vocab:
        return message, {}

    thai_vocab = td.get("thai_terms", set())
    corrections: dict[str, str] = {}
    tokens = re.split(r"(\s+)", message)
    for i, tok in enumerate(tokens):
        t = tok.strip().lower()
        if not t:
            continue
        if re.fullmatch(r"[a-z0-9._\-]+", t) and len(t) >= _TYPO_MIN_LEN and t not in vocab:
            best = process.extractOne(t, vocab, scorer=fuzz.ratio, score_cutoff=_TYPO_THRESHOLD)
        elif re.fullmatch(r"[ก-๙]+", t) and len(t) >= 3 and t not in thai_vocab:
            # ภาษาไทย threshold สูงกว่า — false positive อันตรายกว่า (คำไทยคล้ายกันเยอะ)
            best = process.extractOne(t, thai_vocab, scorer=fuzz.ratio, score_cutoff=90)
        else:
            continue
        if best and best[0] != t:
            tokens[i] = tok.replace(t, best[0]) if tok != t else best[0]
            corrections[t] = best[0]
    return "".join(tokens), corrections


def intent_confidence(intent_result: dict | None) -> float:
    """intent confidence → float ∈ [0,1] — normalize owner เดียวของ intent
    fields; bool/non-finite/out-of-range/malformed/หาย → 0.0 (consumer
    ห้าม float() ซ้ำ)"""
    raw = (intent_result or {}).get("confidence")
    if isinstance(raw, bool):
        return 0.0
    try:
        conf = float(raw) if raw is not None else 0.0
    except (TypeError, ValueError):
        return 0.0
    return conf if math.isfinite(conf) and 0.0 <= conf <= 1.0 else 0.0


def intent_product_scope(intent_result: dict | None
                          ) -> tuple[str | None, str | None]:
    """intent → (product_type, charger_subtype) proposals — type name จริง
    เท่านั้น; ค่า subtype domain (เช่น "cable") → subtype (model พูด subtype
    แทน type); charger_subtype field นับเฉพาะเมื่อ product_type=="charger"
    """
    if not intent_result:
        return None, None
    from . import product_store as _ps
    pt = intent_result.get("product_type")
    st = intent_result.get("charger_subtype")
    if not isinstance(pt, str):
        pt = None
    if not isinstance(st, str):
        st = None
    if pt in _ps._CHARGER_SUBTYPES:
        return None, pt
    if pt == "charger" and st in _ps._CHARGER_SUBTYPES:
        return pt, st
    return (pt or None), None


def intent_fact_scope(intent_result: dict | None
                      ) -> tuple[tuple[str, ...], tuple[str, ...],
                                 tuple[tuple[str, str, float], ...],
                                 tuple[str, ...], tuple[str, ...]]:
    """intent → (requested_facts, required_features, spec_constraints,
    capability_asks, intrinsic_asks) — typed fact/spec/capability contract
    accessor เดียว (consumer ห้ามอ่าน raw keys ตรง); closed enums อยู่ที่
    producer (intent_classifier) — accessor re-validate shape แล้ว drop
    ค่านอก contract (fail closed); capability_asks/intrinsic_asks = open
    labels — shape check เท่านั้น; intrinsic_asks ต้อง ⊂ capability_asks
    (normalized key — semantic scope ตัดสินที่ producer เท่านั้น)"""
    if not intent_result:
        return (), (), (), (), ()
    from . import intent_classifier as _ic
    rf = intent_result.get("requested_facts")
    facts = tuple(dict.fromkeys(
        str(x) for x in (rf if isinstance(rf, (list, tuple)) else ())
        if str(x) in _ic.REQUESTED_FACTS))
    fx = intent_result.get("required_features")
    feats = tuple(dict.fromkeys(
        str(x) for x in (fx if isinstance(fx, (list, tuple)) else ())
        if str(x) in _ic.REQUIRED_FEATURES))
    ca = intent_result.get("capability_asks")
    asks = tuple(dict.fromkeys(
        s for s in (str(x).strip() for x in
                    (ca if isinstance(ca, (list, tuple)) else ()))
        if s))
    _ask_keys = {"".join(s.split()).casefold() for s in asks}
    ia = intent_result.get("intrinsic_asks")
    intrinsic = tuple(dict.fromkeys(
        s for s in (str(x).strip() for x in
                    (ia if isinstance(ia, (list, tuple)) else ()))
        if s and "".join(s.split()).casefold() in _ask_keys))
    return facts, feats, _ic.norm_spec_constraints(
        intent_result.get("spec_constraints")), asks, intrinsic


def resolve_route(message: str, intent_result: dict | None = None) -> RouteContext:
    """Resolve routing ครั้งเดียว: normalize → types/subtype/codes/needs +
    structured device/spec surfaces (validated devices, connector-position
    split, spec claims, device-role mode) สำหรับ role assignment ที่
    `decide_turn` — ทุกอย่างมาจาก existing structured extractors เท่านั้น.

    intent_result: ผล intent_classifier (ใช้เป็น fallback เมื่อ msg ไม่มี subtype)
    """
    from . import product_store as _ps
    from . import device_compat as _dc
    from . import policy_resolver as _pr
    from .scripts.unit_classifier import _extract_codes

    msg, corrections = normalize_message(message or "")
    low = msg.lower()

    ptypes = _ps._detect_product_types(msg)
    subtype = _ps._detect_charger_subtype(msg)
    if not subtype:
        subtype = intent_product_scope(intent_result)[1]

    # validated device mentions — authority rule เดียวกับ _local_target_device
    # (spec db หรือ registered alias canon เท่านั้น); position vs relation
    # connectors → structural subject/target domains
    devices: list[str] = []
    subj_devs: list[str] = []
    tgt_devs: list[str] = []
    spans: list[str] = []
    conns = list(_REL_CONN_RE.finditer(low))
    for raw, canon in _dc._device_candidates(msg):
        if raw not in spans:
            spans.append(raw)
        name = canon or raw
        if name in devices or not (
                _dc._lookup_spec_db(raw)
                or (canon and canon in _dc._SPEC_INDEX)):
            continue
        devices.append(name)
        occ = _device_occurrence(low, name)
        (tgt_devs if occ and any(cm.end() <= occ[0] for cm in conns)
         else subj_devs).append(name)

    codes = _extract_codes(msg)
    # code ที่ occurrence แรกอยู่หลัง connector = counterpart domain
    # (structural split เดียวกับ target_devices — ไม่ใช่ role verdict)
    tgt_codes = tuple(c for c in codes if conns and any(
        cm.end() <= low.find(c.lower()) for cm in conns))

    return RouteContext(
        message=msg,
        product_types=ptypes,
        charger_subtype=subtype,
        model_codes=codes,
        needs_spec=any(w in low for w in _SPEC_WORDS),
        needs_warranty=any(w in low for w in _WARRANTY_WORDS),
        needs_shipping=any(w in low for w in _SHIPPING_WORDS),
        corrections=corrections,
        devices=tuple(devices),
        subject_devices=tuple(subj_devs),
        target_devices=tuple(tgt_devs),
        target_codes=tgt_codes,
        device_spans=tuple(spans),
        spec_tokens=_pr._spec_tokens(msg),
        device_mode=_dc._compat_mode(None, msg)[0],
    )


# ── RetrievalProfile (Task 4A) ──
# โจทย์กลางก่อนดึงสินค้า — reconcile current message + anchor + intent + bounded history
# ครั้งเดียว แทนที่การ re-derive facts ซ้ำหลายจุด · intent เป็น proposal ไม่ใช่ truth
# observe-only: ยังไม่ถูก wire เข้า app.py/retrieval paths (Task 4B/4C/4D)

_INTENT_MAP = {
    "product_recommend": "recommend",
    "product_spec": "spec",
    "compatibility_check": "compatibility",
    "warranty_duration": "warranty",
    "warranty_claim": "claim",
    "general_question": "general",
    "other": "other",
}

# stock-only wording → availability_mode sellable_only
_STOCK_ONLY_KW = ("พร้อมส่ง", "มีของ", "เหลือ", "สต็อก")
# follow-up/compatibility language → เปิด carry จาก bounded history
_FOLLOWUP_KW = ("ใช้กับ", "รองรับ", "เชื่อมต่อ", "เข้ากัน", "ตัวนี้", "อันนี้",
                "รุ่นนี้", "ของเดิม", "ตัวเดิม", "อันเดิม", "อันก่อน", "ตัวก่อน")
# order/history wording → intent "history" (old-order item answerable แม้หมด/เลิกขาย)
_ORDER_HISTORY_KW = ("ออเดอร์", "คำสั่งซื้อ", "เลขที่สั่งซื้อ", "เลขออเดอร์",
                     "tracking", "พัสดุ", "เคยซื้อ", "ซื้อไป", "ประวัติ")
# type ที่ compat = bluetooth pairing ทั่วไป (ไม่ใช่ connector/power)
_BLUETOOTH_FAMILY = frozenset({"earphone", "speaker", "smartwatch", "smartband"})
# intent ที่ยังเปิดให้ deterministic override (soft — intent แข็งแรงเช่น warranty/claim ไม่ถูกทับ)
_SOFT_INTENTS = frozenset({"other", "general", "recommend", "spec"})

_VARIANT_RES = (
    re.compile(r"สี\s*[a-zA-Zก-๙]{2,}"),
    re.compile(r"\b\d{1,4}\s*(?:gb|tb|mah|นิ้ว)\b", re.IGNORECASE),
    re.compile(r"ไซส์\s*[a-zA-Z0-9ก-๙]+", re.IGNORECASE),
)


@dataclass(frozen=True)
class RetrievalProfile:
    """request facts ที่ reconcile แล้ว — owner เดียวก่อน retrieval (Task 4A)."""
    platform: str
    shop: str | None
    message: str
    intent: str
    product_types: frozenset[str]
    subtype: str | None
    model_codes: tuple[str, ...]
    variant_terms: tuple[str, ...]
    target_device: str | None
    availability_mode: str
    compat_mode: str
    anchor_item_ids: tuple[str, ...] = ()
    fact_sources: tuple[tuple[str, str], ...] = ()
    # typed value constraints (งบ/ช่วงราคา) — parse ครั้งเดียวที่นี่ผ่าน
    # product_store._extract_price_range (owner เดียว) — retrieval และ
    # AnswerTask consume typed result เดียวกัน ไม่มี downstream re-parse
    value_constraints: tuple[tuple[str, int], ...] = ()
    # phrase-shaped named-product candidates — soft lookup hints ไม่ใช่
    # trusted identity (ต่างจาก model_codes ที่เป็น code-shape hard identity)
    model_terms: tuple[str, ...] = ()
    # typed spec contract จาก intent boundary (conf ≥0.7):
    #   spec_constraints = (field, op, value) canonical — producer:
    #   intent_classifier.norm_spec_constraints; required_features =
    #   closed feature tokens (เช่น "magnetic") — eval owner:
    #   policy_resolver.eval_spec_constraints (ผ่าน AnswerContext)
    spec_constraints: tuple[tuple[str, str, float], ...] = ()
    required_features: tuple[str, ...] = ()


def _bounded_history_facts(history: list[dict] | None) -> dict:
    """อ่าน user messages ใหม่สุด ≤4 entries — คืน type/subtype/device/codes ที่พบ.

    bot prose ไม่ใช่ source ของ product truth; ไม่ concatenate history เป็น query
    """
    facts: dict[str, Any] = {"types": frozenset(), "subtype": None,
                             "device": None, "codes": ()}
    if not history:
        return facts
    from . import product_store as _ps
    from . import device_compat as _dc
    from .scripts.unit_classifier import _extract_codes

    for entry in reversed(history[-4:]):
        if isinstance(entry, dict):
            role, text = entry.get("role"), (entry.get("text") or entry.get("message") or "")
        else:
            role = getattr(entry, "role", None)
            text = getattr(entry, "text", None) or getattr(entry, "message", None) or ""
        if role != "user" or not text:
            continue
        if not facts["types"]:
            t = _ps._detect_product_types(text)
            if t:
                facts["types"] = frozenset(t)
        if not facts["subtype"]:
            facts["subtype"] = _ps._detect_charger_subtype(text)
        if not facts["device"]:
            facts["device"] = next((cn or rw for rw, cn in
                                    _dc._device_candidates(text)), None)
        if not facts["codes"]:
            facts["codes"] = tuple(_extract_codes(text))
    return facts


def _variant_terms(message: str) -> tuple[str, ...]:
    """explicit color/capacity/size phrases จาก current message เท่านั้น."""
    terms: list[str] = []
    for rx in _VARIANT_RES:
        for m in rx.finditer(message or ""):
            t = m.group(0).strip()
            if t and t not in terms:
                terms.append(t)
    return tuple(terms)


def _resolved_intent(message: str, intent_result: dict | None,
                     model_codes: tuple[str, ...], anchor_cards: list[dict]) -> str:
    """normalize classifier label + deterministic route modifiers (compare/superlative/
    exact_model/history) — soft intents เท่านั้นที่ถูก override."""
    from . import product_store as _ps

    raw = str((intent_result or {}).get("intent") or "other")
    intent = _INTENT_MAP.get(raw, "other")
    low = (message or "").lower()
    anchors = list(anchor_cards or [])
    if len(anchors) >= 2 and any(kw in low for kw in _COMPARISON_FOLLOWUP_KW):
        return "compare"
    if model_codes and intent in _SOFT_INTENTS:
        return "exact_model"
    if (any(kw in low for kw in _SUPERLATIVE_KW)
            and not any(kw in low for kw in _SINGLE_ITEM_REF_KW)
            and (anchors or _ps._detect_product_types(message or ""))):
        return "superlative"
    if intent in ("other", "general", "recommend") and (
            any(kw in low for kw in _ORDER_HISTORY_KW)
            or any(c.get("_source") == "order" or c.get("source") == "order" for c in anchors)):
        return "history"
    return intent


def _availability_mode(intent: str, model_codes: tuple[str, ...], message: str) -> str:
    """deterministic answer-purpose mapping — ไม่ copy จาก intent output."""
    if intent == "history":
        return "exact_history"
    if intent in ("spec", "warranty", "claim", "compare", "exact_model"):
        return "answerable_all"
    if any(kw in (message or "").lower() for kw in _STOCK_ONLY_KW):
        return "sellable_only"
    return "sellable_first"


def _compat_mode(product_types: frozenset[str], subtype: str | None,
                 target_device: str | None) -> str:
    """deterministic จาก final type/subtype/device — conservative: charging→connector,
    wireless→power, bluetooth family→bluetooth_general, ไม่มี device→none."""
    if not target_device:
        return "none"
    from . import device_compat as _dc

    if product_types & _dc._CHARGING_TYPES:
        if subtype == "wireless" or "wireless_charger" in product_types:
            return "power_required"
        return "connector_required"
    if product_types & _BLUETOOTH_FAMILY:
        return "bluetooth_general"
    return "none"


def _subtype_explicit(low: str, subtype: str | None) -> bool:
    """subtype มาจาก keyword จริงใน message (strong) ไม่ใช่ shorthand "หัว"/"สาย" ลอยๆ."""
    if not subtype:
        return False
    from . import product_store as _ps
    return any(kw in low for kw in _ps._CHARGER_SUBTYPES.get(subtype, ()))


def _id_str(value: Any) -> str:
    """normalize item/model id → str (float ที่เป็น int เช่น 130177903540.0 → "130177903540")."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def build_retrieval_profile(
    message: str,
    *,
    history: list[dict] | None,
    intent_result: dict | None,
    shop: str | None,
    platform: str = "shopee",
    anchor_cards: list[dict] | None = None,
    history_cards: list[dict] | None = None,
) -> RetrievalProfile:
    """สร้าง RetrievalProfile เดียวต่อ request — reconcile precedence ต่อ field อิสระ.

    shop/platform: arg เท่านั้น (ห้ามจาก history/intent)
    product_types: current → anchor(compatible) → intent(≥0.7) → bounded history
    subtype: strong current → anchor → intent(≥0.7) → history → weak current
    model_codes: current → anchor → history(follow-up) · target_device: current → intent → history(compat)
    """
    from . import product_store as _ps
    from . import device_compat as _dc
    from .scripts.unit_classifier import _extract_codes

    msg = message or ""
    low = msg.lower()
    anchors = list(anchor_cards or [])
    intent_result = intent_result or {}
    confidence = intent_confidence(intent_result)
    sources: list[tuple[str, str]] = []

    # ── current message facts ──
    cur_types = frozenset(_ps._detect_product_types(msg))
    cur_subtype = _ps._detect_charger_subtype(msg)
    # model_codes = trusted code-shape identity (_extract_codes); span ที่
    #   device owner เคลมเป็น candidate ไม่ใช่ product code
    _dev_spans = {cand for cand, _ in _dc._device_candidates(msg)}
    cur_codes = tuple(dict.fromkeys(
        c for c in _extract_codes(msg)
        if not any(c.lower() in s for s in _dev_spans)))
    # compat-connector target เท่านั้น (explicit subject = TurnNeed.subject_refs)
    cur_device = _local_target_device(msg, None)
    # model_terms = unverified phrase evidence — dedupe กับ roles ที่ prove
    #   แล้วเท่านั้น ไม่ classify ด้วย keyword/guard chains
    cur_terms = tuple(dict.fromkeys(
        t for t in _ps._raw_model_tokens(msg)
        if t not in cur_codes
        and not (cur_device and _code_is_device(t, cur_device, low))))
    if cur_terms:
        sources.append(("model_terms", "message"))
    cur_variants = _variant_terms(msg)

    # ── anchor facts (compatible = current ไม่ได้ตั้ง family อื่นไว้) ──
    anchor_ids = tuple(_id_str(c["item_id"]) for c in anchors if c.get("item_id") is not None)
    anchor_types: set[str] = set()
    anchor_subtype: str | None = None
    anchor_codes: list[str] = []
    for c in anchors:
        name = str(c.get("name") or "")
        anchor_types |= _ps._detect_product_types(name)
        if not anchor_subtype:
            anchor_subtype = _ps._detect_charger_subtype(name)
        anchor_codes += _extract_codes(name)
        anchor_codes += _extract_codes(str(c.get("model_name") or c.get("model_code") or ""))
    anchor_compatible = not cur_types or bool(anchor_types & cur_types)

    # ── intent proposal (confidence ≥0.7 เท่านั้น และชนะ current message ไม่ได้) ──
    itypes: frozenset[str] = frozenset()
    isubtype: str | None = None
    idevice: str | None = None
    if confidence >= 0.7:
        iv = intent_result.get("product_type")
        if isinstance(iv, str) and iv:
            itypes = frozenset({iv})
        elif isinstance(iv, (list, tuple, set)):
            itypes = frozenset(str(x) for x in iv if x)
        # ค่า subtype domain (เช่น "cable") ไม่ใช่ type proposal — normalize
        # ไปที่ subtype แทน ไม่ให้ปนเข้า product_types
        itypes = frozenset(t for t in itypes if t not in _ps._CHARGER_SUBTYPES)
        isubtype = intent_product_scope(intent_result)[1]
        dv = intent_result.get("target_device")
        if dv:
            idevice = str(dv)

    # typed spec contract (closed enums — accessor เดียว; conf gate เดียว
    #   กับ product scope)
    if confidence >= 0.7:
        _rf, req_features, spec_constraints, _, _ = intent_fact_scope(
            intent_result)
    else:
        req_features, spec_constraints = (), ()

    # ── history cards (persisted subject cards ของ app.py — category carry
    #   เมื่อ current message elliptical; identity ไม่ carry — resolver เท่านั้น) ──
    hc_types: set[str] = set()
    hc_subtype: str | None = None
    for c in (history_cards or ()):
        name = str(c.get("name") or "")
        hc_types |= _ps._detect_product_types(name)
        if not hc_subtype:
            hc_subtype = _ps._detect_charger_subtype(name)

    # ── bounded history + carry gate ──
    hist = _bounded_history_facts(history)
    elliptical = not cur_types and not cur_subtype
    is_followup = elliptical or any(kw in low for kw in _FOLLOWUP_KW)

    # ── resolve ต่อ field (precedence ตาม spec) ──
    if cur_types:
        product_types: frozenset[str] = cur_types
        sources.append(("product_types", "message"))
    elif anchor_compatible and anchor_types:
        product_types = frozenset(anchor_types)
        sources.append(("product_types", "anchor"))
    elif itypes:
        product_types = itypes
        sources.append(("product_types", "intent"))
    elif is_followup and hc_types:
        product_types = frozenset(hc_types)
        sources.append(("product_types", "history_cards"))
    elif is_followup and hist["types"]:
        product_types = hist["types"]
        sources.append(("product_types", "history"))
    else:
        product_types = frozenset()

    subtype: str | None = None
    subtype_src: str | None = None
    strong = cur_subtype if _subtype_explicit(low, cur_subtype) else None
    if strong:
        subtype, subtype_src = strong, "message"
    elif anchor_subtype and anchor_compatible and (not cur_types or "charger" in cur_types):
        subtype, subtype_src = anchor_subtype, "anchor"
    elif isubtype and (not cur_types or "charger" in cur_types):
        subtype, subtype_src = isubtype, "intent"
    elif is_followup and hc_subtype and (
            not cur_types or "charger" in cur_types):
        subtype, subtype_src = hc_subtype, "history_cards"
    elif is_followup and hist["subtype"] and (not cur_types or "charger" in cur_types):
        subtype, subtype_src = hist["subtype"], "history"
    elif cur_subtype:
        subtype, subtype_src = cur_subtype, "message"
    if subtype:
        sources.append(("subtype", subtype_src or "message"))
        if "charger" not in product_types:
            product_types = product_types | {"charger"}  # subtype ⇒ charger family
        # subtype ⇒ unit-domain types (เช่น "สาย"→cable, wireless→wireless_charger)
        #   map เดียวกับ retrieval_executor — listing type ≠ unit type
        from .units import _SUBTYPE_TO_TYPES
        product_types = product_types | _SUBTYPE_TO_TYPES.get(subtype, set())

    if cur_codes:
        model_codes = cur_codes
        sources.append(("model_codes", "message"))
    elif anchor_codes:
        model_codes = tuple(dict.fromkeys(anchor_codes))
        sources.append(("model_codes", "anchor"))
    elif is_followup and hist["codes"]:
        model_codes = hist["codes"]
        sources.append(("model_codes", "history"))
    else:
        model_codes = ()

    if cur_variants:
        variant_terms = cur_variants
        sources.append(("variant_terms", "message"))
    else:
        variant_terms = ()
        for c in anchors:
            for v in c.get("variants") or ():
                vs = str(v)
                if vs and vs.lower() in low and vs not in variant_terms:
                    variant_terms += (vs,)
        if variant_terms:
            sources.append(("variant_terms", "anchor"))

    if cur_device:
        target_device = cur_device
        sources.append(("target_device", "message"))
    elif idevice:
        # target_device = counterpart เท่านั้น — label ที่ codes ทับกับ
        #   subject-side codes ของ message นี้ (connector split owner:
        #   resolve_route) คือ product ที่ลูกค้าถามเอง ไม่ใช่ counterpart
        #   (W01 live incident: model mis-slot "IMILAB W01" ลง target)
        _rt = resolve_route(msg, intent_result)
        _tgt_code_l = {c.lower() for c in _rt.target_codes}
        _subj_code_l = {c.lower() for c in _rt.model_codes
                        if c.lower() not in _tgt_code_l}
        if {c.lower() for c in _extract_codes(idevice)} & _subj_code_l:
            target_device = None
        else:
            target_device = idevice
            sources.append(("target_device", "intent"))
    elif is_followup and hist["device"]:
        target_device = hist["device"]
        sources.append(("target_device", "history"))
    else:
        target_device = None

    # value constraints — existing parser เดียว parse ครั้งเดียวต่อ turn
    _vmin, _vmax = _ps._extract_price_range(msg)
    value_constraints: tuple[tuple[str, int], ...] = tuple(
        ([("price_min", _vmin)] if _vmin is not None else [])
        + ([("price_max", _vmax)] if _vmax is not None else []))
    if value_constraints:
        sources.append(("value_constraints", "message"))
    if spec_constraints:
        sources.append(("spec_constraints", "intent"))
    if req_features:
        sources.append(("required_features", "intent"))

    intent = _resolved_intent(msg, intent_result, model_codes, anchors)

    return RetrievalProfile(
        platform=platform,
        shop=shop,
        message=msg,
        intent=intent,
        product_types=product_types,
        subtype=subtype,
        model_codes=model_codes,
        variant_terms=variant_terms,
        target_device=target_device,
        availability_mode=_availability_mode(intent, model_codes, msg),
        compat_mode=_compat_mode(product_types, subtype, target_device),
        anchor_item_ids=anchor_ids,
        fact_sources=tuple(sources),
        value_constraints=value_constraints,
        model_terms=cur_terms,
        spec_constraints=spec_constraints,
        required_features=req_features,
    )


def profile_debug(profile: RetrievalProfile, *, source: str,
                  used_fields: tuple[str, ...] = ()) -> dict:
    """serialize profile เป็น debug dict สำหรับ _steps — log facts เท่านั้น
    (ไม่ใส่ history/message dump; ไม่แสดงลูกค้า)"""
    return {
        "source": source,
        "platform": profile.platform,
        "shop": profile.shop,
        "intent": profile.intent,
        "product_types": sorted(profile.product_types),
        "subtype": profile.subtype,
        "model_codes": list(profile.model_codes),
        "variant_terms": list(profile.variant_terms),
        "target_device": profile.target_device,
        "availability_mode": profile.availability_mode,
        "compat_mode": profile.compat_mode,
        "anchor_item_ids": list(profile.anchor_item_ids),
        "used_fields": list(used_fields),
        "fact_sources": dict(profile.fact_sources),
    }


# RetrievalSlot — แยก profile แบนเป็น product-request slots ด้วย deterministic
# span parse (type keyword position → constraint window ถึง mention ของ type
# ถัดไป) — contract/parser เท่านั้น ยังไม่ wire เข้า retrieval runtime


@dataclass(frozen=True)
class RetrievalSlot:
    """scoped product request หนึ่งชิ้นใน turn — ไม่ใช่ intent ใหม่."""
    slot_id: str
    source_span: str
    product_types: frozenset[str]
    subtypes: frozenset[str]
    primary_subtype: str | None
    brand_hints: tuple[str, ...]
    model_codes: tuple[str, ...]
    model_terms: tuple[str, ...]
    target_device: str | None
    target_scope: str                    # "slot" | "shared" | "none"
    availability_mode: str
    compat_mode: str
    confidence: float
    fact_sources: tuple[tuple[str, str], ...] = ()
    variant_terms: tuple[str, ...] = ()   # requested option(s) ของ slot นี้
    # typed roles — owner = TurnNeed.subject_refs/target_refs verbatim (r8)
    subject_refs: tuple[str, ...] = ()
    target_refs: tuple[str, ...] = ()
    # typed spec contract จาก TurnNeed (verbatim propagate — eval ที่
    #   AnswerContext ผ่าน policy_resolver.eval_spec_constraints)
    spec_constraints: tuple[tuple[str, str, float], ...] = ()
    required_features: tuple[str, ...] = ()


def _kw_positions(low: str, kw: str) -> list[int]:
    """ตำแหน่งทั้งหมดของ kw ใน text — latin kw ต้อง token boundary
    ("phone" ใน "iphone" ไม่นับ); Thai kw ใช้ substring ตามเดิม"""
    kl = kw.lower()
    if re.fullmatch(r"[a-z0-9 ._\-]+", kl):
        return [m.start() for m in re.finditer(
            rf"(?<![a-z0-9]){re.escape(kl)}(?![a-z0-9])", low)]
    out: list[int] = []
    start = 0
    while True:
        i = low.find(kl, start)
        if i < 0:
            return out
        out.append(i)
        start = i + len(kl)


def _type_mentions(low: str, allowed: frozenset[str]) -> list[tuple[int, str, str]]:
    """(pos, type, src) ของ type keyword/regex ใน message — src: "kw" (explicit
    product request) | "regex" (inferred model/device phrase); merge same-type run"""
    from . import product_store as _ps

    hits: list[tuple[int, str, str]] = []
    for name, kws, rx in _ps.PRODUCT_TYPES:
        if name not in allowed:
            continue
        for kw in kws:
            for pos in _kw_positions(low, kw):
                hits.append((pos, name, "kw"))
        if rx:
            for m in re.finditer(rx, low):
                hits.append((m.start(), name, "regex"))
    hits.sort(key=lambda h: h[0])
    merged: list[tuple[int, str, str]] = []
    for pos, t, s in hits:
        if merged and merged[-1][1] == t:
            continue
        merged.append((pos, t, s))
    return merged


def requested_product_types(text: str, *, explicit_only: bool = False) -> set[str]:
    """product types ที่ผู้เขียนถามถึงจริง — provenance-aware.

    explicit type noun (src="kw" เช่น "หัวชาร์จ", "เคส") ชนะ regex-mention
    (src="regex" = ชื่อรุ่น/อุปกรณ์ที่ infer เป็น type — เช่น "iphone 15" ใน
    "หัวชาร์จ iphone 15" คือ compat target ไม่ใช่หมวดที่ถาม).
    ข้อความที่มีแต่ regex mention (ขึ้นชื่อรุ่นล้วน) → คืน regex types
    เพราะนั่นคือหมวดที่ถามโดยนัย.

    Args:
        text: ข้อความลูกค้า หรือ product name (ชื่อสินค้าใช้ได้เหมือนกัน —
              kw ในชื่อ = type ที่ชื่อสินค้า claim ตัวเอง)
        explicit_only: True → คืนเฉพาะ kw-mention (ไม่ fallback regex) —
              ใช้เช็คว่ามี explicit type noun จริงไหม
    """
    from . import product_store as _ps
    allowed = frozenset(n for n, _k, _r in _ps.PRODUCT_TYPES)
    mentions = _type_mentions(_ps._fix_product_type_typos(text), allowed)
    kw = {t for _p, t, s in mentions if s == "kw"}
    if kw or explicit_only:
        return kw
    return {t for _p, t, _s in mentions}


def _all_charger_subtypes(low: str) -> frozenset[str]:
    """ทุก charger subtype ที่มี kw ใน text — _detect_charger_subtype คืนตัวเดียว
    แต่ "สายชาร์จกับหัวชาร์จ" ต้องได้ทั้ง cable + adapter"""
    from . import product_store as _ps
    return frozenset(
        name for name, kws in _ps._CHARGER_SUBTYPES.items()
        if any(kw in low for kw in kws)
    )


def _model_terms(span_text: str, brands: list[str]) -> tuple[str, ...]:
    """brand-anchored model phrase hint — "<brand> + ≤4 tokens ถัดไป"
    ตัดที่ connector/stopword (ใช้กับ/เอา/และ/ราคา/สี/ไหม/ครับ/ค่ะ)"""
    _stop = ("ใช้กับ", "กับ", "เอา", "และ", "ส่วน", "สำหรับ", "ไหม", "ครับ",
             "ค่ะ", "ราคา", "สี", "ขอ", "อยาก", "มี", "หรือ", "แบบ", "ตัว")
    terms: list[str] = []
    for b in brands:
        m = re.search(re.escape(b.lower()) + r"((?:\s+\S+){1,4})", span_text)
        if not m:
            continue
        keep: list[str] = []
        for w in m.group(1).split():
            if any(w.startswith(s) for s in _stop):
                break
            keep.append(w)
        if keep:
            phrase = f"{b} {' '.join(keep)}"
            if phrase not in terms:
                terms.append(phrase)
    return tuple(terms)


def _device_occurrence(low: str, token: str | None) -> tuple[int, int] | None:
    """literal span ของ device token ใน message — literal match หรือ span ที่
    normalize แล้วเท่ากัน ('mi14pro' ↔ 'xiaomi 14 pro')"""
    if not token:
        return None
    m = re.search(re.escape(token.lower()).replace(r"\ ", r"\s+"), low)
    if m:
        return m.start(), m.end()
    from . import device_compat as _dc
    for _m in _dc._DEVICE_ALIAS_PROBE_RE.finditer(low):
        if _dc.normalize_device_alias(_m.group(0)) == token:
            return _m.start(), _m.end()
    return None


def _span_device_position(low: str, token: str | None) -> int:
    """ตำแหน่ง device token ใน message — -1 ถ้าหาไม่เจอ"""
    occ = _device_occurrence(low, token)
    return occ[0] if occ else -1


def _code_is_device(code: str, device: str, low: str) -> bool:
    """code token คือ device mention เองไหม — normalize เท่ากัน / spec resolve
    device เดียวกัน / compact form เท่ากัน / หรืออยู่ภายใน device span"""
    from . import device_compat as _dc
    cl = code.lower()
    if cl.replace(" ", "") == device.replace(" ", ""):
        return True
    if _dc.normalize_device_alias(cl) == device:
        return True
    cs, ds = _dc._lookup_spec_db(cl), _dc._lookup_spec_db(device)
    if cs and ds and cs.get("device") == ds.get("device"):
        return True
    occ = _device_occurrence(low, device)
    return bool(occ and any(
        occ[0] <= m.start() < occ[1]
        for m in re.finditer(re.escape(cl), low)))


def _product_brands(text: str, brands: list[str],
                    target: str | None) -> list[str]:
    """brand ที่เป็น product evidence — occurrence ทั้งหมดของ brand ต้องไม่อยู่
    ภายใน target-device span ('เคส iphone 15' → iphone คือ device ไม่ใช่ brand);
    target มาจาก typed target_refs/connector — ไม่ infer device spans เอง"""
    if not target:
        return list(brands)
    occ = _device_occurrence(text.lower(), target)
    if not occ:
        return list(brands)
    low_t = text.lower()
    out: list[str] = []
    for b in brands:
        hits = list(re.finditer(re.escape(b.lower()), low_t))

        def _device_owned(m: re.Match) -> bool:
            if occ[0] <= m.start() < occ[1]:
                return True
            # brand ติดกับ device ด้านหน้า = ส่วนของชื่อ device ("xiaomi mi watch 8")
            return (m.end() <= occ[0]
                    and bool(re.fullmatch(r"\s*", low_t[m.end():occ[0]])))

        if not hits or any(not _device_owned(m) for m in hits):
            out.append(b)
    return out


def _local_target_device(seg: str, shared: str | None) -> str | None:
    """compat-target device ของ segment — validated device หลัง compat
    connector เท่านั้น (`_REL_CONN_RE` — grammar owner เดียวกับ relation
    parser): candidate ต้องยืนยันใน _SPEC_INDEX (fabricated alias เช่น
    "ip68"→"iphone 68" = unverified); source role ถูกลบ (r7) — explicit
    subject = TurnNeed.subject_refs เท่านั้น"""
    from . import device_compat as _dc
    low = seg.lower()
    for cand, canon in _dc._device_candidates(seg):
        name = canon or cand
        if name == shared:
            continue
        # authoritative resolution เท่านั้น — _lookup_spec_db หรือ registered
        # alias canon (fabricated alias เช่น "ip68"→"iphone 68" = unverified)
        if not (_dc._lookup_spec_db(cand)
                or (canon and canon in _dc._SPEC_INDEX)):
            continue
        occ = _device_occurrence(low, name)
        if occ is None:
            continue
        # connector position จาก _REL_CONN_RE — grammar owner เดียวกับ parser
        if any(cm.end() <= occ[0] for cm in _REL_CONN_RE.finditer(low)):
            return name
    return None


def _ambiguous_device_target(low: str, target: str | None) -> bool:
    """device ตามหลัง 'กับ' เปล่า (ไม่ใช่ compat connector) + ไม่มี kw ของ
    family นั้น — เสี่ยงว่า device คือ product อีกชิ้นไม่ใช่ target
    ('หัวชาร์จกับ mi watch 8' vs 'สายชาร์จใช้กับ ip14')"""
    if not target:
        return False
    occ = _device_occurrence(low, target)
    if occ is None:
        return False
    head = low[:occ[0]].rstrip()
    if not head.endswith("กับ") or head.endswith(
            ("ใช้กับ", "เข้ากับ", "คู่กับ")):
        return False
    from . import product_store as _ps
    dev_types = _ps._detect_product_types(target)
    for name, kws, _rx in _ps.PRODUCT_TYPES:
        if name in dev_types and any(
                _kw_positions(low, kw) for kw in kws):
            return False
    return True


def build_retrieval_slots(profile: RetrievalProfile,
                          needs: tuple = ()) -> tuple[RetrievalSlot, ...]:
    """แยก resolved profile เป็น product-request slots — deterministic เท่านั้น.

    span rule: window ของ type mention คือ text จาก mention นั้นจนถึง mention
    ของ type อื่นถัดไป → brand/model/subtype ผูกกับ product ที่ระบุใกล้สุด
    device ที่ตามหลัง ≥2 distinct types (หรือผูก span ไม่ได้) → target_scope=shared
    0/1 distinct typed span → slot เดียวเทียบเท่า profile (behavior เดิม)
    needs = TurnNeed tuple ที่สร้างแล้ว (decide_turn — call เดียวต่อ turn)
    → `subject_refs` ของ productish need ถูก propagate เป็น slot.subject_refs
    (owner เดียว — ไม่ infer จาก prose)
    ไม่เรียก LLM · ไม่สรุป compatibility (compat_mode เป็น hint เท่านั้น)
    """
    from . import product_store as _ps
    from . import device_compat as _dc
    from .scripts.unit_classifier import _extract_codes
    from .turn_decision import PRODUCTISH_NEED_KINDS as _PK

    msg = profile.message or ""
    low = msg.lower()
    mentions = _type_mentions(low, profile.product_types)
    mentioned = {t for _, t, _ in mentions}
    explicit = {t for _, t, s in mentions if s == "kw"}
    carry = profile.product_types - mentioned  # type จาก anchor/history/intent
    # typed role carriers — consume verbatim (ไม่ re-parse, ไม่ filter refs
    # ผ่าน span/code/device domain — roles ถูก owner ที่ decide_turn assign
    # แล้ว): product/compare needs stamp slot เสมอ; compat needs stamp slot
    # เฉพาะเมื่อไม่มี product/compare need (compat-only turn → slot request
    # คือ surface เดียวของ relation — refs ของ compat need ไม่ไหลไป slot
    # ของ product need อื่น)
    from .turn_decision import _SCOPE_NEED_KINDS as _SK
    scope_needs = [n for n in needs
                   if getattr(n, "kind", None) in _SK]
    prodish = scope_needs or [n for n in needs
                              if getattr(n, "kind", None) in _PK]

    # effective types จุดเดียว: explicit kw = product request จริง;
    # regex-only mention = device phrase (target ไม่ใช่ slot) — มี explicit แล้ว drop;
    # ไม่มี explicit เลย → inferred เป็น fallback ("อยากได้ iphone 15" → phone slot)
    effective = (explicit or mentioned) | carry
    if explicit:
        mentions = [(p, t, s) for p, t, s in mentions if t in explicit]
        distinct = {t for _, t, _ in mentions}
    else:
        distinct = mentioned

    # single-slot path: ≤1 typed span → slot เดียวด้วย effective types
    if len(distinct) <= 1:
        subs = _all_charger_subtypes(low) or (
            frozenset({profile.subtype}) if profile.subtype else frozenset())
        # need product scope เป็น typed surface เดียวกัน — slot ห้ามเสีย
        #   type/subtype ที่ need declare (subtype → listing types ผ่าน map
        #   เดียวกับ profile)
        need_types = frozenset(
            t for n in prodish for t in getattr(n, "product_types", ()))
        need_subs = frozenset(
            s for n in prodish for s in getattr(n, "subtypes", ()))
        if need_subs:
            from .units import _SUBTYPE_TO_TYPES
            for s in need_subs:
                need_types |= _SUBTYPE_TO_TYPES.get(s, set())
            subs = subs | need_subs
        effective = effective | need_types
        target = profile.target_device or _local_target_device(low, None)
        # need refs verbatim — productish needs ทุกตัวครอบ slot เดียวของ
        # turn; typed target เดียวชนะ span target (owner เดียวกัน)
        refs = tuple(dict.fromkeys(
            r for n in prodish for r in n.subject_refs))
        trefs = tuple(dict.fromkeys(
            r for n in prodish for r in n.target_refs))
        # typed spec contract verbatim จาก productish needs
        cons = tuple(dict.fromkeys(
            c for n in prodish
            for c in getattr(n, "spec_constraints", ())))
        feats = tuple(dict.fromkeys(
            f for n in prodish
            for f in getattr(n, "required_features", ())))
        # target_device = device view ของ typed target เท่านั้น —
        # app/service/code target (เช่น strava/ad1404t) อยู่ target_refs ไม่ใช่
        # target_device; validate ผ่าน authority เดียวกับ resolve_route
        _td = next((t for t in trefs if _dc._lookup_spec_db(t)
                    or _dc.normalize_device_alias(t) in _dc._SPEC_INDEX),
                   None)
        if _td:
            target = _td
        brands = _product_brands(low, _ps._detect_brands(msg), target)
        mterms = _model_terms(low, brands)
        return (RetrievalSlot(
            slot_id=f"slot-{next(iter(effective), 'open')}",
            source_span=msg,
            product_types=frozenset(effective),
            subtypes=subs,
            primary_subtype=profile.subtype,
            brand_hints=tuple(brands),
            model_codes=profile.model_codes,
            model_terms=mterms,
            target_device=target,
            subject_refs=refs,
            target_refs=trefs,
            target_scope="slot" if target else "none",
            availability_mode=profile.availability_mode,
            compat_mode=profile.compat_mode,
            confidence=0.6 if _ambiguous_device_target(
                low, target) else (1.0 if effective else 0.4),
            fact_sources=profile.fact_sources,
            variant_terms=profile.variant_terms,
            spec_constraints=cons,
            required_features=feats,
        ),)

    # multi-slot: window ของ mention = [pos, next different-type pos)
    windows: dict[str, list[str]] = {t: [] for t in distinct}
    for i, (pos, t, _s) in enumerate(mentions):
        end = len(low)
        for pos2, t2, _s2 in mentions[i + 1:]:
            if t2 != t:
                end = pos2
                break
        windows[t].append(low[pos:end])

    # shared device: อยู่หลัง ≥2 distinct types, ก่อน mention แรก, หรือผูก span ไม่ได้
    dev_tok = profile.target_device or next(
        (cn or rw for rw, cn in _dc._device_candidates(msg)), None)
    dev_pos = _span_device_position(low, dev_tok)
    types_before = {t for pos, t, _ in mentions if pos < dev_pos}
    shared_dev = dev_tok if dev_tok and (
        dev_pos < 0 or len(types_before) >= 2
        or dev_pos < mentions[0][0]) else None

    first_pos = {t: min(p for p, tt, _ in mentions if tt == t) for t in distinct}
    slots: list[RetrievalSlot] = []
    for t in sorted(distinct, key=lambda x: first_pos[x]):
        span = " ".join(windows[t])
        subs = _all_charger_subtypes(span) if t == "charger" else frozenset()
        primary_sub = profile.subtype if t == "charger" else None
        if t == "charger" and not subs and profile.subtype:
            subs = frozenset({profile.subtype})
        brands = _ps._detect_brands(span)
        codes = tuple(dict.fromkeys(
            c for seg in windows[t] for c in _extract_codes(seg)))
        local_dev = None
        for seg in windows[t]:
            _d = _local_target_device(seg, shared_dev)
            local_dev = local_dev or _d
        target = local_dev or shared_dev
        scope = "slot" if local_dev else ("shared" if shared_dev else "none")
        # need→slot association ผ่าน typed product_types scope เท่านั้น —
        # scope ว่าง (ไม่มี association ชัด) → ไม่ stamp (fail closed; ไม่
        # flatten refs ข้าม slots); typed target เดียวชนะ span target
        def _need_covers(n) -> bool:
            # need→slot association ผ่าน typed scope เท่านั้น — subtype-only
            #   scope (เช่น cable) ผูกกับ charger slot; scope ว่าง → ไม่ stamp
            #   (fail closed; ไม่ flatten refs ข้าม slots)
            nts = frozenset(getattr(n, "product_types", ()) or ())
            return bool(nts & {t}) or (
                t == "charger" and bool(getattr(n, "subtypes", ())))
        assoc = [n for n in prodish if _need_covers(n)]
        if t == "charger":
            for n in assoc:
                subs = subs | frozenset(getattr(n, "subtypes", ()) or ())
        refs = tuple(dict.fromkeys(
            r for n in assoc for r in n.subject_refs))
        trefs = tuple(dict.fromkeys(
            r for n in assoc for r in n.target_refs))
        acons = tuple(dict.fromkeys(
            c for n in assoc
            for c in getattr(n, "spec_constraints", ())))
        afeats = tuple(dict.fromkeys(
            f for n in assoc
            for f in getattr(n, "required_features", ())))
        _td = next((t for t in trefs if _dc._lookup_spec_db(t)
                    or _dc.normalize_device_alias(t) in _dc._SPEC_INDEX),
                   None)
        if _td:
            target, scope = _td, "slot"
        brands = _product_brands(span, brands, target)
        sources: list[tuple[str, str]] = [("product_types", "message")]
        if subs:
            sources.append(("subtypes", "span"))
        if brands:
            sources.append(("brand_hints", "span"))
        if codes:
            sources.append(("model_codes", "span"))
        if target:
            sources.append(("target_device", scope))
        vterms = _variant_terms(span)
        if vterms:
            sources.append(("variant_terms", "span"))
        mterms = _model_terms(span, brands)
        if refs or trefs:
            sources.append(("subject_refs", "needs"))
        slots.append(RetrievalSlot(
            slot_id=f"slot-{t}",
            source_span=span,
            product_types=frozenset({t}),
            subtypes=subs,
            primary_subtype=primary_sub,
            brand_hints=tuple(brands),
            model_codes=codes,
            model_terms=mterms,
            target_device=target,
            subject_refs=refs,
            target_refs=trefs,
            target_scope=scope,
            availability_mode=profile.availability_mode,
            compat_mode=_compat_mode(frozenset({t}), primary_sub, target),
            confidence=0.8,
            fact_sources=tuple(sources),
            variant_terms=vterms,
            spec_constraints=acons,
            required_features=afeats,
        ))
    return tuple(slots)


# RetrievalRelation — product-to-product relation (source ที่ลูกค้าอ้างถึง →
# target ที่อยากหา) ผ่าน compat connector — contract/parser เท่านั้น
# ยังไม่ wire เข้า retrieval runtime

_REL_CONN_RE = re.compile(
    r"ใช้คู่กับ|ใช้คู่กัน|ใช้ได้กับ|ใช้ร่วมกับ|ใช้กับ|เข้ากัน|เข้ากับ|"
    r"เชื่อมต่อกับ|เชื่อมต่อ|เชื่อมกับ|สำหรับ|"
    r"รองรับ|คู่กัน|คู่กับ")
_REL_QUESTION = ("ไหน", "อะไร", "แบบไหน", "ตัวไหน", "รุ่นไหน",
                 "ยี่ห้อไหน", "ได้บ้าง")


@dataclass(frozen=True)
class RetrievalRelation:
    """relation ระหว่าง product mention ใน turn เดียว — ไม่ใช่ intent ใหม่."""
    source_slot_id: str
    target_slot_id: str
    relation_type: str                    # "works_with"
    evidence_span: str
    constraints: tuple[tuple[str, str], ...] = ()
    confidence: float = 1.0


def _relation_constraints(tail: str) -> tuple[tuple[str, str], ...]:
    """constraint tokens ที่ผูกกับ target product — generic detectors เท่านั้น"""
    out: list[tuple[str, str]] = []
    if re.search(r"มีจอ|จอแสดง|หน้าจอ", tail):
        out.append(("display", "required"))
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:เมตร|ม\.|m(?![a-z]))", tail)
    if m:
        out.append(("length_m", m.group(1)))
    if re.search(r"เต็มสปีด|เร็วสุด|เต็มกำลัง|สปีดสูงสุด", tail):
        out.append(("speed", "full"))
    m = re.search(r"(\d{2,3})\s*(?:w(?![a-z])|วัตต์)", tail)
    if m:
        out.append(("power_w", m.group(1)))
    m = re.search(r"(pd|qc|pps|ufcs)\s*(\d+(?:\.\d+)?)", tail)
    if m:
        out.append(("protocol", f"{m.group(1).upper()}{m.group(2)}"))
    return tuple(out)


def _slot_id_for(slots: tuple[RetrievalSlot, ...], t: str) -> str:
    """slot_id ของ slot ที่มี type t — single-slot ทุก mention map เข้า slot เดียว;
    type ไม่อยู่ใน slots → ชื่อตาม convention (virtual, contract-only)"""
    for s in slots:
        if t in s.product_types:
            return s.slot_id
    return f"slot-{t}"


def _kw_type_mentions(low: str, allowed: frozenset[str]) -> list[tuple[int, str]]:
    """kw-only type mentions ไม่ merge — relation parser ต้องเห็น mention ซ้ำ
    type เดียวกัน ("หัวชาร์จ ... สายชาร์จ" คนละบทบาท)"""
    from . import product_store as _ps
    hits: set[tuple[int, str]] = set()
    for name, kws, _rx in _ps.PRODUCT_TYPES:
        if name not in allowed:
            continue
        for kw in kws:
            for pos in _kw_positions(low, kw):
                hits.add((pos, name))
    return sorted(hits)


# 'สาย'/'หัว' shorthand — ใช้เฉพาะ relation-tail ที่มี question marker ตามทันที
# compound blacklist กัน สายไฟ/สายตา/สายนาฬิกา/หัวหน้า/หัวใจ ฯลฯ
_REL_SHORT_CABLE_BL = ("ไฟ", "ตา", "รัด", "คล้อง", "นาฬิกา", "เชือก", "พาน",
                       "ยาง", "ลม", "ฝน", "สัญญาณ", "ดิน", "เปย์", "พันธุ์",
                       "ชาร์จ", "ชาร์ต", "บัว", "หนีบ", "สปริง", "โลห์")
_REL_SHORT_HEAD_BL = ("ชาร์จ", "ชาร์ต", "หน้า", "ใจ", "เข่า", "ไฟ", "ขวด",
                      "บ้าน", "คอ", "ไหล่", "จุด", "เราะ", "มุม", "ท้าย")
_REL_SHORT_Q = ("ไหน", "อะไร", "แบบไหน", "รุ่นไหน", "ตัวไหน")


def _shorthand_target_mentions(low: str, start: int, end: int
                               ) -> list[tuple[int, str, str]]:
    """'สาย'/'หัว' + question marker ใน [start,end) → (pos,"charger",subtype)
    compound blacklist กันคำประสม — kw เต็ม (สายชาร์จ/หัวชาร์จ) จัดการก่อนเสมอ"""
    out: list[tuple[int, str, str]] = []
    for m in re.finditer(r"สาย|หัว", low):
        if not (start <= m.start() < end):
            continue
        w = m.group(0)
        after = low[m.end():].lstrip(" ,")
        if after.startswith(_REL_SHORT_CABLE_BL if w == "สาย"
                            else _REL_SHORT_HEAD_BL):
            continue
        if after.startswith(_REL_SHORT_Q):
            out.append((m.start(), "charger",
                        "cable" if w == "สาย" else "adapter"))
    return out


def _shorthand_source_mentions(low: str) -> list[tuple[int, str]]:
    """'หัว' + อันนี้/นี้/ตัวนี้/รุ่นนี้/code → (pos,"charger") — adapter ที่อ้างถึง
    ('หัวอันนี้ AD1404T' = หัวชาร์จตัวเดิม) · compound blacklist เช่น หัวหน้า/หัวใจ
    shorthand source เพิ่ม type เท่านั้น — ไม่นับเป็น source evidence เอง"""
    out: list[tuple[int, str]] = []
    for m in re.finditer("หัว", low):
        after = low[m.end():]
        if after.startswith(_REL_SHORT_HEAD_BL):
            continue
        if re.match(r"(?:อันนี้|นี้|ตัวนี้|รุ่นนี้|ตัวที่|\s*[a-z]{1,4}\d{2,})",
                    after):
            out.append((m.start(), "charger"))
    return out


def _mention_subtype(low: str, pos: int, t: str) -> str | None:
    """subtype ของ mention ที่ pos — 'สายชาร์จ'→cable, 'หัวชาร์จ'→adapter
    เฉพาะ charger taxonomy; kw ยาวสุดที่ match ตรง pos ชนะ"""
    if t != "charger":
        return None
    from . import product_store as _ps
    best_sub, best_len = None, 0
    for sub, kws in _ps._CHARGER_SUBTYPES.items():
        for kw in kws:
            if len(kw) > best_len and low.startswith(kw, pos):
                best_sub, best_len = sub, len(kw)
    return best_sub


def _kw_span_len(low: str, pos: int, t: str) -> int:
    """ความยาว kw ของ type t ที่ match ตรง pos (ยาวสุดชนะ — 'สายชาร์จ' > 'สาย')"""
    from . import product_store as _ps
    best = 0
    for name, kws, _rx in _ps.PRODUCT_TYPES:
        if name != t:
            continue
        for kw in kws:
            if low.startswith(kw, pos) and len(kw) > best:
                best = len(kw)
    return best


def _strap_compound_mention(low: str, pos: int) -> bool:
    """kw mention ที่เป็น tail ของ strap compound ('สายนาฬิกา' ทำ 'นาฬิกา' ไม่ใช่
    smartwatch mention) — compound ที่เป็น kw เอง (สายคล้อง) ไม่โดน"""
    return low[:pos].rstrip().endswith("สาย")


def build_retrieval_relations(
        profile: RetrievalProfile,
        slots: tuple[RetrievalSlot, ...],
        *,
        allow_reversed: bool = False
) -> tuple[RetrievalRelation, ...]:
    """หา product-to-product relations — deterministic เท่านั้น.

    pattern: source(code/type mention) → compat connector → target
    (explicit type kw + question marker) — เช่น
    "หัวชาร์จ AD1404T ใช้กับสายชาร์จไหน" = source AD1404T, target cable request
    connector ลงท้าย "คู่กัน" = สองฝั่งนำหน้า connector
    device/target-device mention (ip14, mi watch 8) ไม่ใช่ target — type kw เท่านั้น
    reversed order ("สายที่ใช้กับ AD1404T") เปิดเฉพาะ `allow_reversed` —
    typed eligibility จาก TurnPlan productish need (caller derive)
    ไม่เรียก LLM · ไม่สรุป compatibility positive
    """
    msg = profile.message or ""
    low = msg.lower()
    kw_mentions = [(p, t) for p, t in
                   _kw_type_mentions(low, profile.product_types)
                   if not _strap_compound_mention(low, p)]
    kw_pos = {p for p, _ in kw_mentions}
    # source candidates = kw + 'หัว' shorthand (อันนี้/นี้/code ตามหลัง)
    shorthand_mentions = _shorthand_source_mentions(low)
    head_pos = {p for p, _ in shorthand_mentions}
    all_mentions = sorted(kw_mentions + shorthand_mentions)
    code_mentions = [(m.start(), c)
                     for c in profile.model_codes
                     for m in re.finditer(re.escape(c.lower()), low)]
    if not all_mentions and not code_mentions:
        return ()

    rels: list[RetrievalRelation] = []
    seen: set[tuple[str, str]] = set()
    for cm in _REL_CONN_RE.finditer(low):
        conn = cm.group(0)
        symmetric = conn.endswith("คู่กัน")
        # reversed order: "สายที่ใช้กับ AD1404T" — target (สิ่งที่อยากได้) อยู่
        # ก่อน "ที่" + connector, source ตามหลัง — semantics เดียวกับ forward
        reversed_order = (
            not symmetric
            and low[max(0, cm.start() - len("ที่")):cm.start()] == "ที่")
        shorthand_sub: str | None = None
        src_sub: str | None = None
        tgt_sub: str | None = None
        tgt_head_start = -1
        if symmetric:
            before = [(p, t) for p, t in all_mentions if p < cm.start()]
            # shorthand-only source ไม่พอ — ต้องมี kw/code evidence จริง
            if (len(before) < 2 or
                    (before[-2][0] not in kw_pos and
                     not any(p < cm.start() for p, _ in code_mentions))):
                continue
            tgt_pos, tgt_type = before[-1]
            src_pos, src_type = before[-2]
            src_sub = ("adapter" if src_pos in head_pos
                       else _mention_subtype(low, src_pos, src_type))
            tgt_sub = ("adapter" if tgt_pos in head_pos
                       else _mention_subtype(low, tgt_pos, tgt_type))
            q_seg = low[cm.end():cm.end() + 30]
            tail = low[cm.end():]
        elif reversed_order:
            if not allow_reversed:
                continue  # typed eligibility: no productish need → fail closed
            # target = head noun ก่อน "ที่" — kw mention สุดท้าย หรือ bare
            # 'สาย'/'หัว' (compound blacklist เหมือน shorthand อื่น)
            pre = low[:cm.start() - len("ที่")]
            kw_head = [(p, t) for p, t in kw_mentions if p < cm.start()]
            if kw_head:
                tgt_pos, tgt_type = kw_head[-1]
                tgt_head_start = tgt_pos
                tgt_sub = _mention_subtype(low, tgt_pos, tgt_type)
            else:
                tm = re.search(r"(สาย|หัว)\s*$", pre)
                if not tm:
                    continue
                tgt_pos = tm.start(1)
                tgt_head_start = tgt_pos
                tgt_type = "charger"
                tgt_sub = "cable" if tm.group(1) == "สาย" else "adapter"
                shorthand_sub = tgt_sub  # shorthand target → conf 0.7
            # source = code ก่อน (exact identity ชนะ) ไม่ก็ kw mention หลัง connector
            code_after = [(p, c) for p, c in code_mentions
                          if cm.end() <= p <= cm.end() + 30]
            kw_after = [(p, t) for p, t in kw_mentions
                        if cm.end() <= p <= cm.end() + 30]
            src_type = None
            if code_after:
                src_pos, src_code = code_after[0]
                src_end = src_pos + len(src_code)
                if kw_after and kw_after[0][0] < src_pos:
                    src_type = kw_after[0][1]
                    src_sub = _mention_subtype(low, kw_after[0][0],
                                               src_type)
            elif kw_after:
                src_pos, src_type = kw_after[0]
                src_end = src_pos + _kw_span_len(low, src_pos, src_type)
                src_sub = _mention_subtype(low, src_pos, src_type)
            else:
                continue
            tail = low[src_end:]
        else:
            cand = [(p, t) for p, t in all_mentions if p < cm.start()]
            code_before = [(p, c) for p, c in code_mentions if p < cm.start()]
            # shorthand source ไม่นับ evidence — ต้องมี kw mention หรือ code จริง
            if (not code_before and
                    not any(p in kw_pos for p, _ in cand)):
                continue
            after = [(p, t) for p, t in kw_mentions
                     if p >= cm.end() and p - cm.end() <= 25]
            if not after:
                # bare 'สาย'/'หัว' + question — infer เฉพาะเมื่อ source เป็น
                # charger ctx (kw/หัว-shorthand/code/charger ใน profile)
                if (code_before or "charger" in profile.product_types or
                        any(t == "charger" for _, t in cand)):
                    short = _shorthand_target_mentions(low, cm.end(),
                                                     cm.end() + 20)
                    if short:
                        after = [(short[0][0], "charger")]
                        shorthand_sub = short[0][2]
            if not after:
                continue
            tgt_pos, tgt_type = after[0]
            tgt_sub = (shorthand_sub
                       or _mention_subtype(low, tgt_pos, tgt_type))
            src_pos = max([p for p, _ in cand] + [p for p, _ in code_before])
            src_type = cand[-1][1] if cand else None
            if cand:
                src_sub = ("adapter" if cand[-1][0] in head_pos
                           else _mention_subtype(low, cand[-1][0],
                                                 cand[-1][1]))
            q_seg = low[tgt_pos:tgt_pos + 30]
            tail = low[tgt_pos:]
        # request-marker gate — forward เท่านั้น: question kw หลัง target;
        #   reversed order ใช้ intent eligibility (ข้างบน) + structural
        #   parse เป็น boundary ("สายที่ใช้กับ X เสีย" ถูก claim intent กัน)
        if (not reversed_order
                and not any(q in q_seg for q in _REL_QUESTION)):
            continue
        src_slot = _slot_id_for(slots, src_type) if src_type else (
            slots[0].slot_id if slots else "slot-open")
        tgt_slot = _slot_id_for(slots, tgt_type)
        key = (src_slot, tgt_slot)
        if key in seen:
            continue
        seen.add(key)
        start = (tgt_head_start if reversed_order
                 else src_pos if not symmetric
                 else min(src_pos, tgt_pos))
        cons = _relation_constraints(tail)
        if tgt_sub:
            cons += (("target_subtype", tgt_sub),)
        if src_sub:
            cons += (("source_subtype", src_sub),)
        # query_hint = text ฝั่ง target (target kw + constraints tail) — executor
        # ใช้เป็น query แทน message เต็มที่มี source terms ปน
        hint = (f"{low[tgt_pos:cm.start() - len('ที่')].strip()} "
                f"{tail.strip()}"
                if reversed_order else low[tgt_pos:tgt_pos + 200].strip())
        cons += (("query_hint", hint),)
        rels.append(RetrievalRelation(
            source_slot_id=src_slot,
            target_slot_id=tgt_slot,
            relation_type="works_with",
            evidence_span=msg[start:].strip(),
            constraints=cons,
            confidence=0.7 if shorthand_sub else 0.8,
        ))
    return tuple(rels)
