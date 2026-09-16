"""units.py — unit-level product path (Task 8, flag-gated USE_UNIT_INDEX).

ทำไม: fetch_products เดิมคืน listing cards — listing หนึ่งมีหลายรุ่นย่อย
      (stock/price ต่างกัน เช่น EC4 เฉพาะกล้องหมด แต่ +Smart Hub มี)
      units คือระดับรุ่นย่อยที่ขายจริง คำนวณจาก sellable_units collection
      + unit_embeddings.npz (vector บน search_text)

Path: exact model_code → field filter → vector → merge+rank
Fallback: คืน [] → caller (fetch_products) ไป legacy path เหมือนเดิม
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import numpy as np

_ROOT = Path(__file__).resolve().parent.parent.parent
_UNIT_VEC_PATH = _ROOT / "exports" / "unit_embeddings.npz"

_UNITS_COLL_NAME = os.environ.get("ADMIN_MONGO_COLLECTION_UNITS", "sellable_units").strip()

# subtype → unit product_type ที่ควรรวมใน filter (listing type ≠ unit type
# เช่น "สายชาร์จ" อยู่ใน listing หัวชาร์จ แต่ unit product_type="cable")
_SUBTYPE_TO_TYPES = {
    "cable": {"cable"},
    "adapter": {"charger"}, "set": {"charger"},
    "car_charger": {"car_charger"}, "wireless": {"wireless_charger"},
    "desktop": {"desktop_charger"}, "socket": {"socket"},
}

_units_coll_cached: Any = None
_unit_vec: dict | None = None


def _units_coll():
    """collection sellable_units จาก admin DB (lazy, reuse knowledge_base client)."""
    global _units_coll_cached
    if _units_coll_cached is None:
        from . import knowledge_base as _kb
        db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
        _units_coll_cached = _kb._build_admin_client()[db_name][_UNITS_COLL_NAME]
    return _units_coll_cached


def _unit_vectors() -> dict | None:
    """lazy load unit_embeddings.npz → {unit_ids, emb, shops}."""
    global _unit_vec
    if _unit_vec is None:
        try:
            z = np.load(_UNIT_VEC_PATH, allow_pickle=True)
            _unit_vec = {"unit_ids": z["unit_ids"], "emb": z["embeddings"],
                         "shops": z["shops"]}
        except Exception:
            _unit_vec = {}
    return _unit_vec or None


def _sellable_mask(uids: list) -> np.ndarray:
    """mask unit_id ที่ sellable=True — ดึงจาก Mongo (sellability เปลี่ยนได้ อบลง npz จะ stale)."""
    sellable = {d["unit_id"] for d in _units_coll().find(
        {"sellable": True}, {"unit_id": 1})}
    return np.array([str(u) in sellable for u in uids])


def _vector_search(message: str, shop: str | None, top: int = 50,
                   sellable_only: bool = False) -> list[tuple[str, float]]:
    """cosine sim บน unit embeddings → [(unit_id, score)] top-N (กรอง shop/sellable ก่อน)."""
    uv = _unit_vectors()
    if not uv or not message:
        return []
    try:
        from . import embedding as _emb
        q = _emb.embed_query(message)
        emb, uids, shops = uv["emb"], uv["unit_ids"], uv["shops"]
        mask = np.ones(len(uids), dtype=bool)
        if shop:
            mask &= np.array([s == shop for s in shops])
        if sellable_only:
            mask &= _sellable_mask(uids)
        sims = np.where(mask, emb @ q, -1.0)
        idx = np.argpartition(-sims, min(top, len(sims) - 1))[:top]
        out = [(str(uids[i]), float(sims[i])) for i in idx if sims[i] > 0.3]
        out.sort(key=lambda x: -x[1])
        return out
    except Exception as exc:
        print(f"[UNITS] vector search error: {exc}", file=sys.stderr)
        return []


def fetch_units(
    message: str,
    *,
    shop: str | None = None,
    limit: int = 8,
    sellable_only: bool = False,
    product_types: set[str] | None = None,
    charger_subtype: str | None = None,
    route=None,
) -> list[dict]:
    """ดึง units ที่เกี่ยวกับ message — exact code → field filter → vector → merge.

    Returns: list[unit doc + _score + _matched_by] (ว่าง = ให้ caller fallback)
    """
    from . import route_context as _rc

    route = route or _rc.resolve_route(message)
    ptypes = set(product_types) if product_types is not None else set(route.product_types)
    subtype = charger_subtype or route.charger_subtype
    ptypes |= _SUBTYPE_TO_TYPES.get(subtype or "", set())
    codes = [c.upper() for c in route.model_codes]

    try:
        coll = _units_coll()
        coll.find_one()  # ping — collection อาจยังไม่มี
    except Exception as exc:
        print(f"[UNITS] collection unavailable → legacy path: {exc}", file=sys.stderr)
        return []

    base_q: dict = {}
    if shop:
        base_q["shop"] = shop
    if sellable_only:
        base_q["sellable"] = True

    hits: dict[str, dict] = {}

    # 1) exact model_code — ความมั่นใจสูงสุด
    #    code อยู่ระดับ listing (หลาย unit ใช้ code เดียวกัน เช่น HA835 เฉพาะหัว/พร้อมสาย)
    #    → ให้คะแนนเพิ่มตาม token ของ model_name ที่ปรากฏใน message (เลือก unit ที่ตรงสุด)
    if codes:
        for u in coll.find({**base_q, "model_codes": {"$in": codes}}).limit(limit * 3):
            bonus = 0.0
            for tok in (u.get("model_name") or "").split():
                t = tok.strip()
                if len(t) >= 2 and t.upper() not in codes and t in message:
                    bonus += 0.3
            u["_score"], u["_matched_by"] = 2.0 + bonus, "code"
            hits[u["unit_id"]] = u

    # 2) vector บน search_text → เติม field filter
    vec = _vector_search(message, shop, top=50, sellable_only=sellable_only)
    cand_ids = [uid for uid, _ in vec if uid not in hits]
    if cand_ids:
        q = dict(base_q)
        q["unit_id"] = {"$in": cand_ids}
        docs = list(coll.find(q).limit(200))
        if ptypes:
            typed = [d for d in docs if d.get("product_type") in ptypes]
            if typed:
                docs = typed
        score_of = dict(vec)
        for d in docs:
            d["_score"], d["_matched_by"] = score_of.get(d["unit_id"], 0.0), "vector"
            hits.setdefault(d["unit_id"], d)

    ranked = sorted(hits.values(), key=lambda u: -u["_score"])[:limit]
    print(f"[UNITS] msg={message[:40]!r} codes={codes} hits={len(ranked)} "
          f"({sum(1 for u in ranked if u['_matched_by']=='code')} code)", file=sys.stderr)
    return ranked


def pick_desc_sections(unit: dict, route=None) -> str:
    """เลือก desc sections ตาม route.needs_* — cap ~3000 chars ประหยัด token."""
    secs = unit.get("desc_sections") or {}
    generic = route is None or not (route.needs_spec or route.needs_warranty)
    order = ["specs", "highlights"]
    if generic or getattr(route, "needs_warranty", False):
        order.append("warranty")
    if generic:
        order += ["intro", "notes", "other"]
    parts = [secs[k] for k in order if secs.get(k)]
    return "\n\n".join(parts)[:3000]


def to_unit_card(unit: dict, route=None) -> dict:
    """unit doc → card shape เดียวกับ to_product_card (downstream ไม่ต้องแก้)."""
    brand = unit.get("brand") or {}
    brand_name = brand.get("original_brand_name", "") if isinstance(brand, dict) else str(brand)
    stock = unit.get("stock") or 0
    return {
        # shape เดียวกับ product card
        "item_id": unit.get("item_id"),
        "name": unit.get("display_name"),
        "brand": brand_name,
        "category": unit.get("cat_name"),
        "shop": unit.get("shop"),
        "status": unit.get("item_status"),
        "condition": None,
        "price": unit.get("price"),
        "warranty": None,  # warranty text อยู่ใน desc_sections → description_excerpt
        "short_link": None,
        "image_url": None,
        "weight": None,
        "dimension": None,
        "total_stock": stock,
        "sold_out": stock == 0,
        "_available_for_sale": unit.get("item_status") == "NORMAL",
        "has_promotion": False,
        "is_flash_sale": False,
        "description_excerpt": pick_desc_sections(unit, route),
        "raw_description": "\n\n".join(
            v for v in (unit.get("desc_sections") or {}).values() if v)[:4000],
        "variants": [{
            "name": unit.get("model_name"), "model_id": unit.get("model_id"),
            "stock": stock, "price": unit.get("price"),
            "model_status": unit.get("model_status"),
        }],
        "tier_variation": [],
        # unit-level extras (shape เดิม + ข้อมูลรุ่นย่อย)
        "unit_id": unit.get("unit_id"),
        "model_id": unit.get("model_id"),
        "model_name": unit.get("model_name"),
        "model_sku": unit.get("model_sku"),
        "model_status": unit.get("model_status"),
        "sellable": unit.get("sellable"),
        "kind": unit.get("kind"),
        "components": unit.get("components"),
        "product_type": unit.get("product_type"),
        "charger_subtype": unit.get("charger_subtype"),
        "cable_subtype": unit.get("cable_subtype"),
        "camera_subtype": unit.get("camera_subtype"),
        "model_codes": unit.get("model_codes"),
        "oos_in_name": unit.get("oos_in_name"),
        "has_warranty_info": unit.get("has_warranty_info"),
        "has_description": unit.get("has_description"),
        "image_ids": (unit.get("image_ids") or [])[:10],
        "_score": unit.get("_score"),
        "_matched_by": unit.get("_matched_by"),
    }


def fetch_unit_cards(message: str, **kwargs) -> list[dict]:
    """fetch_units + to_unit_card — entry point ที่ fetch_products เรียก."""
    route = kwargs.pop("route", None)
    from . import route_context as _rc
    route = route or _rc.resolve_route(message)
    return [to_unit_card(u, route) for u in fetch_units(message, route=route, **kwargs)]
