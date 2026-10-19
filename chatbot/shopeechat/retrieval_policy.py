"""retrieval_policy.py — evidence card contract (Task 3, observe-only).

ทำไม: product cards มาจากหลายแหล่ง (product_store/units/KB/anchor/order/compat/web)
      แต่ไม่มีภาษาเดียวกันบอกว่ามาจากไหน หลักฐานอะไร ถูกเลือกเพราะอะไร
      contract นี้คือ metadata ภายใน — Task 6/8/10 ใช้ต่อสำหรับ selection/proof

Contract (private — ห้ามหลุด public response):
    _evidence = {"sources": [...], "item_ids": [...], "model_ids": [...], "facts": {...}}
    _selection_reason = "short_machine_reason"

Canonical fields (public — adapter เจ้าเดียวแปล raw source values ที่ boundary
นี้ก่อน card เข้า pool/selection; downstream อ่าน canonical เท่านั้น):
    canonical_type = unit product_type หรือ detect จากชื่อ (ไม่รู้ → None)
    canonical_roles = ["adapter","cable","set",...] — components/subtype/type/ชื่อ
    variant_facets = {"connector"} — structured fields เท่านั้น (ไม่ parse ชื่อ)
    publish_state = published | unpublished | deleted | unknown
    stock_state   = in_stock | out_of_stock | unknown
    requested_variant_state = not_requested | available | out_of_stock
                              | not_offered | unknown — SKU-level combination
    customer_visibility = visible | historical_only | hidden
    availability_reason = resolver reason
    sellable = published ∧ in_stock ∧ visible ∧ requested ∈ {not_requested,
               available} — eligibility owner เดียว (requested unknown = fail closed)
"""
from __future__ import annotations

import re

PRIVATE_KEYS = ("_evidence", "_selection_reason")

# raw subtype vocab (unit + request) → canonical roles — ค่าจาก
# exports/sellable_units.jsonl inventory + request vocab เดิม
_SUBTYPE_ROLES = {
    "adapter": ("adapter",),
    "cable": ("cable",), "cable_only": ("cable",),
    "set": ("set", "adapter", "cable"),
    "car_charger": ("car_charger",), "wireless": ("wireless",),
    "desktop": ("desktop",), "socket": ("socket",),
}

# catalog_status (product_store.resolve_availability เจ้าของ semantics) →
# canonical states — PUBLISH_STATE/PUBLISH_RANK owner = product_store
# (consume ผ่าน _ps); card-shape maps นี้เป็น adapter internals
_STOCK_STATE = {
    "active": "in_stock", "out_of_stock": "out_of_stock",
}
_VISIBILITY = {
    "active": "visible", "active_unknown_stock": "visible",
    "out_of_stock": "visible", "discontinued": "historical_only",
}
_MODEL_PUBLISH = {
    "MODEL_NORMAL": "published", "MODEL_UNLIST": "unpublished",
    "MODEL_DELETE": "deleted",
}
_SELLABLE_RVS = frozenset({"not_requested", "available"})

_OPT_NORM_RE = re.compile(r"[^0-9a-zก-๙]+")


def _norm_id(value) -> str:
    """normalize id เป็น string — float/int-float-str (mongo export) → int-str."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, str):
        try:
            f = float(value)
        except ValueError:
            return value
        return str(int(f)) if f.is_integer() else value
    return str(value)


def _opt_norm(s: str) -> str:
    """option term normalize — lower + เก็บเฉพาะ alnum/thai."""
    return _OPT_NORM_RE.sub("", (s or "").lower())


def _row_stock_state(row: dict) -> str:
    s = row.get("stock")
    if isinstance(s, (int, float)) and not isinstance(s, bool):
        return "in_stock" if s > 0 else "out_of_stock"
    return "unknown"


def _row_publish_state(row: dict) -> str:
    return _MODEL_PUBLISH.get(
        str(row.get("model_status") or "").upper(), "unknown")


def _row_option_state(row: dict) -> str:
    """state ของ variant row เดียวสำหรับ requested-option resolution."""
    pub = row.get("publish_state") or _row_publish_state(row)
    if pub in ("unpublished", "deleted"):
        return "not_offered"
    st = row.get("stock_state") or _row_stock_state(row)
    if pub == "published" and st == "in_stock":
        return "available"
    if pub == "published" and st == "out_of_stock":
        return "out_of_stock"
    return "unknown"


def _best_row_state(rows: list) -> str:
    """state ที่ดีสุดของ rows ที่ match — option ขายได้ถ้ามี row ใดขายได้."""
    states = [_row_option_state(v) for v in rows]
    for st in ("available", "out_of_stock", "unknown", "not_offered"):
        if st in states:
            return st
    return "unknown"


_ASCII_EDGE = re.compile(r"[0-9a-zA-Z]")


def _opt_in(opt_norm: str, term_norm: str) -> bool:
    """option ⊂ term ทางเดียว (parser term อาจกินคำต่อท้าย — "แดง"⊂"แดงไหม") —
    ทิศกลับห้าม ("แดงอิฐ"⊄"แดง"); boundary ไม่ใช่ ASCII-alnum กัน "2เมตร"⊂"12เมตร"."""
    t, o = term_norm, opt_norm
    if not (t and o) or len(o) > len(t):
        return False
    i = t.find(o)
    while i >= 0:
        pre = i > 0 and _ASCII_EDGE.match(t[i - 1]) \
            and _ASCII_EDGE.match(o[0])
        j = i + len(o)
        post = j < len(t) and _ASCII_EDGE.match(t[j]) \
            and _ASCII_EDGE.match(o[-1])
        if not (pre or post):
            return True
        i = t.find(o, i + 1)
    return False


def _requested_variant_state(card: dict, requested) -> tuple[str, dict]:
    """requested options → combination state — structured resolver เจ้าเดียว.

    ทุก term map เข้า tier dimension ของมัน (containment) → SKU row ต้อง
    satisfy ทุก dimension พร้อมกัน (tier_index[dim] ∈ matched opts) —
    ห้าม resolve ทีละ term แยก row (red+1m/blue+2m ≠ red+2m)
    """
    terms = [_opt_norm(t) for t in (requested or ())]
    terms = [t for t in terms if t]
    if not terms:
        return "not_requested", {}
    tvs = [tv for tv in (card.get("tier_variation") or [])
           if isinstance(tv, dict) and tv.get("options")]
    rows = [v for v in (card.get("variants") or []) if isinstance(v, dict)]
    trace: dict[str, str] = {}

    if tvs:
        # ── structured dims: term → (dim, opt_idx เดียว) — vocab เป็น authority
        # exact ก่อน → unique-longest contained → tie/multi-dim/conflict = ambiguous
        # (ห้าม union หลาย option ใน dim เดียว — "แดงอิฐ" ⊉ {"แดง","แดงอิฐ"})
        constraints: dict[int, int] = {}
        for t in terms:
            hits: dict[int, int | None] = {}
            for di, tv in enumerate(tvs):
                opts = [_opt_norm(str(o))
                        for o in (tv.get("options") or [])]
                exact = [oi for oi, n in enumerate(opts) if n == t]
                if exact:
                    hits[di] = exact[0] if len(exact) == 1 else None
                    continue
                cands = [(len(n), oi) for oi, n in enumerate(opts)
                         if n and _opt_in(n, t)]
                if cands:
                    mx = max(l for l, _ in cands)
                    best = [oi for l, oi in cands if l == mx]
                    hits[di] = best[0] if len(best) == 1 else None
            if not hits:
                trace[t] = "not_in_vocab"
            elif len(hits) > 1:
                trace[t] = "ambiguous"
            else:
                di, oi = next(iter(hits.items()))
                if oi is None:
                    trace[t] = "ambiguous"
                elif di in constraints and constraints[di] != oi:
                    trace[t] = "conflict"
                else:
                    constraints[di] = oi
                    trace[t] = f"dim:{di}"
        if any(s == "not_in_vocab" for s in trace.values()):
            # option vocab ชัดเจนบอกว่าไม่มี term นี้ → not_offered
            return "not_offered", trace
        if any(s in ("ambiguous", "conflict") for s in trace.values()):
            return "unknown", trace      # term หลาย dim / tie / ขัดกัน — เดาไม่ได้
        # row satisfy iff ทุก dim: tier_index[dim] == opt เดียวที่ resolve ได้
        matched = [r for r in rows
                   if isinstance(r.get("tier_index"), (list, tuple))
                   and all(di < len(r["tier_index"])
                           and r["tier_index"][di] == oi
                           for di, oi in constraints.items())]
        if matched:
            return _best_row_state(matched), trace
        if rows and all(isinstance(r.get("tier_index"), (list, tuple))
                        for r in rows):
            # index evidence ครบทุก row แต่ไม่มี combination นี้ → ไม่เสนอจริง
            return "not_offered", trace
        # rows ขาด tier_index → พิสูจน์ combination ไม่ได้
        return "unknown", trace

    # ── ไม่มี tier vocab — row name คือ SKU identity evidence ──
    matched = [r for r in rows
               if all(t in _opt_norm(r.get("name") or "") for t in terms)]
    if matched:
        for t in terms:
            trace[t] = "row"
        return _best_row_state(matched), trace
    if rows:
        # name ไม่พิสูจน์ absence ได้ (ชื่ออาจไม่ระบุ option) → unknown
        for t in terms:
            trace[t] = "no_row_match"
        return "unknown", trace
    # ไม่มี row เลย — identity match จากชื่อ card/model เอง
    card_name = _opt_norm(
        f"{card.get('model_name') or ''} {card.get('name') or ''}")
    if all(t in card_name for t in terms):
        st = card.get("stock_state")
        return {"in_stock": "available",
                "out_of_stock": "out_of_stock"}.get(st, "unknown"), trace
    return "unknown", trace


def _variant_facets(card: dict) -> dict:
    """variant facets จาก structured fields เท่านั้น — connector เป็น canonical
    vocab อยู่แล้ว; ห้าม parse ชื่อ (length/color ไม่ใช่ facet evidence ได้)"""
    conn = card.get("cable_subtype")
    return {"connector": conn} if conn else {}


def _canonical_roles(card: dict, types: set) -> set:
    """roles จาก components (unit facts) + subtype map + type + name detect."""
    roles: set = set()
    comps = card.get("components")
    if isinstance(comps, (list, tuple, set)):
        roles.update(c for c in comps if isinstance(c, str) and c)
    csub = card.get("charger_subtype")
    roles.update(_SUBTYPE_ROLES.get(csub) or ())
    cam = card.get("camera_subtype")
    if cam:
        roles.add(cam)
    if "cable" in types:
        roles.add("cable")
    if not roles and "charger" in types:
        # listing card ไม่มี unit fields — detect จากชื่อผ่าน owner เดิม
        from . import product_store as _ps
        roles.update(
            _SUBTYPE_ROLES.get(
                _ps._detect_charger_subtype(card.get("name") or "")) or ())
    return roles


def _canonicalize(card: dict, requested) -> dict:
    """raw card → canonical fields + facts trace — adapter internals เจ้าเดียว."""
    from . import product_store as _ps

    # availability semantics — resolver owner เดียว; stamped fields ชนะ
    cs = card.get("catalog_status")
    cv = card.get("customer_visible")
    need_av = (cs is None or cv is None
               or not card.get("availability_reason"))
    av = _ps.resolve_availability(card) if need_av else None
    if cs is None:
        cs = av["catalog_status"]
    if cv is None:
        # ขาด visibility แต่มี status → resolver; มีแค่ catalog_status →
        # semantics เดียวกับ resolver (unlisted/unknown = ไม่เคย publish)
        cv = (av["customer_visible"]
              if ("status" in card or "item_status" in card)
              else cs not in ("unlisted", "unknown"))
    reason = card.get("availability_reason") or (av or {}).get("reason") or ""

    publish = _ps.PUBLISH_STATE.get(cs, "unknown")
    stock_st = _STOCK_STATE.get(cs, "unknown")
    vis = "hidden" if cv is False else _VISIBILITY.get(cs, "hidden")

    # type — unit field ชนะ; ไม่มี → detect จากชื่อ (multi → candidates)
    ptype = card.get("product_type")
    cand: set = {ptype} if ptype else set()
    if not ptype:
        cand = set(_ps._detect_product_types(card.get("name") or "") or ())
    ctype = ptype or (sorted(cand)[0] if cand else None)

    roles = _canonical_roles(card, cand)
    facets = _variant_facets(card)

    # variant rows → per-row canonical states (copy — ห้าม mutate source)
    rows = card.get("variants")
    if isinstance(rows, list):
        out_rows = []
        for v in rows:
            if isinstance(v, dict):
                v = dict(v)
                v["stock_state"] = _row_stock_state(v)
                v["publish_state"] = _row_publish_state(v)
            out_rows.append(v)
        card["variants"] = out_rows

    card["canonical_type"] = ctype
    card["canonical_roles"] = sorted(roles)
    card["variant_facets"] = facets
    card["publish_state"] = publish
    card["stock_state"] = stock_st
    card["customer_visibility"] = vis
    card["availability_reason"] = card.get("availability_reason") or reason

    rvs, rtrace = _requested_variant_state(card, requested)
    card["requested_variant_state"] = rvs
    card["sellable"] = bool(
        publish == "published" and stock_st == "in_stock"
        and vis == "visible" and rvs in _SELLABLE_RVS)

    # trace — ค่าที่พิสูจน์ไม่ได้ต้องเห็นว่า unknown ไม่ใช่หายเงียบ
    csub = card.get("charger_subtype")
    unknowns = []
    if csub and csub not in _SUBTYPE_ROLES:
        unknowns.append(f"charger_subtype:{csub}")
    if not ctype:
        unknowns.append("type")
    if not roles:
        unknowns.append("roles")
    if publish == "unknown":
        unknowns.append("publish")
    if stock_st == "unknown":
        unknowns.append("stock")
    if rvs == "unknown" and rtrace:
        unknowns.append("requested")
    canon = {
        "type": ctype,
        "type_source": "field" if ptype else ("detect" if cand else "none"),
        "type_candidates": sorted(cand),
        "roles": sorted(roles),
        "catalog_status": cs,
        "publish": publish, "stock": stock_st, "visibility": vis,
        "facets": facets or None,
        "requested": rtrace or None,
        "unknown": unknowns or None,
    }
    return {k: v for k, v in canon.items() if v not in (None, [], {})}


def make_evidence_card(product: dict, *, source: str,
                       evidence: dict | None = None,
                       selection_reason: str | None = None,
                       requested: tuple | list = ()) -> dict:
    """card + evidence metadata — คืน copy ใหม่ ไม่ mutate input.

    Args:
        product: product card/doc
        source: "unit" | "legacy" | "kb" | "order" | "anchor" | "compat" | "web"
        evidence: facts เพิ่มเติม (เช่น {"spec": ["ShpProducts.description"]})
        selection_reason: short machine reason ว่าถูกเลือกเพราะอะไร
        requested: requested option terms ของ request (สี/ขนาด/รุ่นย่อย) —
            ตัดสิน requested_variant_state แยกจาก whole-product sellability

    Returns:
        card ที่เพิ่ม `_evidence` (merge กับของเดิม — sources ไม่ซ้ำ,
        item_ids/model_ids normalize เป็น str) + canonical fields
        (canonical_type/roles/facets/publish/stock/requested_variant/
        visibility/sellable) + `_selection_reason` ถ้าส่งมา
    """
    card = dict(product or {})
    meta = dict(card.get("_evidence") or {})

    sources = list(meta.get("sources") or [])
    if source and source not in sources:
        sources.append(source)
    meta["sources"] = sources

    for key, field in (("item_ids", "item_id"), ("model_ids", "model_id")):
        ids = list(meta.get(key) or [])
        value = product.get(field) if product else None
        if value is not None:
            sv = _norm_id(value)
            if sv not in ids:
                ids.append(sv)
        meta[key] = ids

    facts = dict(meta.get("facts") or {})
    facts.update(evidence or {})
    facts["canonical"] = _canonicalize(card, requested)
    meta["facts"] = facts

    card["_evidence"] = meta
    if selection_reason is not None:
        card["_selection_reason"] = selection_reason
    return card


def strip_private_evidence(product: dict | list[dict]) -> dict | list[dict]:
    """ลบ `_evidence`/`_selection_reason` ก่อน public response — ไม่ mutate input.

    รับ card เดียวหรือ list (Task 8 wire ครั้งเดียวที่ product-response boundary).
    """
    if isinstance(product, list):
        return [strip_private_evidence(p) for p in product]
    out = dict(product or {})
    for key in PRIVATE_KEYS:
        out.pop(key, None)
    return out
