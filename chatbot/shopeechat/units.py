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
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .route_context import RetrievalProfile

import numpy as np

from . import generation_pointer as _gen

_ROOT = Path(__file__).resolve().parent.parent.parent

# subtype → unit product_type ที่ควรรวมใน filter (listing type ≠ unit type
# เช่น "สายชาร์จ" อยู่ใน listing หัวชาร์จ แต่ unit product_type="cable")
_SUBTYPE_TO_TYPES = {
    "cable": {"cable"},
    "adapter": {"charger"}, "set": {"charger"},
    "car_charger": {"car_charger"}, "wireless": {"wireless_charger"},
    "desktop": {"desktop_charger"}, "socket": {"socket"},
}

# npz cache keyed by immutable generation path — ไม่ใช่ mtime (gen dir เป็น
# immutable; path ใหม่ = generation ใหม่); cap กัน pointer flip-flop สะสม
_VEC_CACHE: dict[str, dict] = {}
_VEC_CACHE_CAP = 3


def _resolve_snap(snap):
    """snap ที่ส่งมา (captured — รวม None) หรือ resolve เมื่อ omitted (SNAP_UNSET —
    standalone caller ไม่ได้อยู่ใน request ที่ capture แล้ว)"""
    if snap is not _gen.SNAP_UNSET:
        return snap
    return _gen.resolve_snapshot()


def _units_coll(snap=_gen.SNAP_UNSET):
    """units collection ของ generation ใน snapshot — pointer เดียวเป็นต้นทาง
    (ไม่มี pointer/invalid → raise — caller ตัดสินใจ fail-closed หรือ fallback)"""
    snap = _resolve_snap(snap)
    if snap is None:
        raise RuntimeError("[UNITS] no evidence generation — pointer missing/invalid")
    from . import knowledge_base as _kb
    return _kb._admin_db()[snap.units_collection]


def _unit_vectors(snap) -> dict | None:
    """unit vectors จาก snap.units_npz — cache ด้วย path + assert generation_id
    ใน npz ตรง pointer gen เสมอ (mismatch → fail closed, ไม่ serve ผิด gen)"""
    if snap is None:
        return None
    path = snap.units_npz
    if path in _VEC_CACHE:
        return _VEC_CACHE[path]
    try:
        z = np.load(path, allow_pickle=True)
        if "generation_id" not in z.files or \
                str(z["generation_id"].item()) != snap.generation_id:
            print(f"[UNITS] npz generation_id != pointer gen "
                  f"{snap.generation_id} → fail closed", file=sys.stderr)
            return _VEC_CACHE.get(path)
        vec = {"unit_ids": z["unit_ids"], "emb": z["embeddings"],
               "shops": z["shops"]}
    except Exception as exc:
        print(f"[UNITS] vector load error ({path}): {exc}", file=sys.stderr)
        return _VEC_CACHE.get(path)
    _VEC_CACHE[path] = vec
    while len(_VEC_CACHE) > _VEC_CACHE_CAP:
        _VEC_CACHE.pop(next(iter(_VEC_CACHE)))
    return vec


def _sellable_mask(uids: list, snap=_gen.SNAP_UNSET) -> np.ndarray:
    """mask unit_id ที่ sellable=True — ดึงจาก units collection ของ snapshot."""
    sellable = {d["unit_id"] for d in _units_coll(snap).find(
        {"sellable": True}, {"unit_id": 1})}
    return np.array([str(u) in sellable for u in uids])


def _vector_search(message: str, shop: str | None, top: int = 50,
                   sellable_only: bool = False, snap=_gen.SNAP_UNSET) -> list[tuple[str, float]]:
    """cosine sim บน unit embeddings → [(unit_id, score)] top-N (กรอง shop/sellable ก่อน)."""
    uv = _unit_vectors(snap)
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
            mask &= _sellable_mask(uids, snap)
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
    retrieval_profile: RetrievalProfile | None = None,
    snap=_gen.SNAP_UNSET,
) -> list[dict]:
    """ดึง units ที่เกี่ยวกับ message — exact code → field filter → vector → merge.

    Returns: list[unit doc + _score + _matched_by] (ว่าง = ให้ caller fallback)
    """
    snap = _resolve_snap(snap)
    if snap is None:
        print("[UNITS] no active generation → fail closed (caller → legacy)",
              file=sys.stderr)
        return []
    from . import route_context as _rc

    # Task 4D — profile เป็น canonical facts owner: มี profile → ใช้ types/
    #   subtype/codes จาก profile โดยไม่ต้อง resolve_route ซ้ำ; ไม่มี → เดิม
    if route is None and retrieval_profile is None:
        route = _rc.resolve_route(message)
    if product_types is not None:
        ptypes = set(product_types)
    elif retrieval_profile is not None:
        ptypes = set(retrieval_profile.product_types)
    else:
        ptypes = set(route.product_types)
    subtype = charger_subtype or (retrieval_profile.subtype
                                  if retrieval_profile is not None
                                  else route.charger_subtype)
    ptypes |= _SUBTYPE_TO_TYPES.get(subtype or "", set())
    codes = [c.upper() for c in (
        retrieval_profile.model_codes if retrieval_profile is not None
        else route.model_codes)]

    try:
        coll = _units_coll(snap)
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
    vec = _vector_search(message, shop, top=50, sellable_only=sellable_only,
                         snap=snap)
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

    # availability tier: code-hit ชนะเสมอ ("HA835 มีไหม" ต้องเห็น HA835 แม้ตาย)
    # → sellable (build-time snapshot; live re-sort อยู่ใน fetch_unit_cards หลัง join) → score
    ranked = sorted(hits.values(),
                    key=lambda u: (u["_matched_by"] == "code",
                                   bool(u.get("sellable")), u["_score"]),
                    reverse=True)[:limit]
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


def _live_availability(unit: dict) -> tuple[str, dict, str]:
    """คืน (item_status, availability, model_status) — availability จาก resolver owner เดียว.

    - ไม่มี _listing → resolve จาก snapshot build-time ของ unit เอง
    - unit มี model_id → ส่ง exact model doc ใน lst["model"] เข้า resolver
      (ไม่เจอ = variant ถูกลบออกจาก listing → model_missing ไม่ใช่ sold-out ทั้ง listing)
    - solo unit (model_id=None) → resolve ทั้ง listing (รวม MODEL_NORMAL ทุกรุ่น)
    """
    from . import product_store as _ps   # lazy — กัน circular
    lst = unit.get("_listing")
    if not lst:
        return (unit.get("item_status") or "", _ps.resolve_availability(unit),
                unit.get("model_status") or "")
    status = lst.get("item_status") or unit.get("item_status") or ""
    mid = unit.get("model_id")
    if mid is None:
        return status, _ps.resolve_availability(lst), unit.get("model_status") or ""
    m = next((m for m in (lst.get("model") or []) if m.get("model_id") == mid), None)
    if m is None:
        # variant ไม่อยู่ใน live listing — customer-visible เฉพาะเมื่อ listing
        # เป็น historical evidence ชัดเจน (SELLER_DELETE/DELETED/BANNED = เคย
        # publish ทั้ง listing); NORMAL/UNLIST = variant ถูกถอด/ยังไม่ publish
        return status, {"catalog_status": "unlisted", "available_for_sale": False,
                        "answerable": True, "reason": "model_missing",
                        "total_stock": None,
                        "customer_visible": status.upper() in {
                            "SELLER_DELETE", "DELETED", "SHOPEE_DELETE",
                            "BANNED"}}, ""
    return status, _ps.resolve_availability(lst, model_doc=m), m.get("model_status") or ""


def _live_sellable(unit: dict) -> bool:
    """unit ขายได้จริงตอนนี้ — delegate ไป resolve_availability (owner เดียว).

    ใช้ re-sort หลัง attach_listing_fields — ของที่ตายหลัง build จะถูกดีดออกจาก top
    """
    return _live_availability(unit)[1]["available_for_sale"]


def _variant_image_id(lst: dict, model_name: str) -> str:
    """image_id ของ variant จาก tier_variation.option_list — match option กับ model_name.

    listing รวมหลายรุ่น (หัวชาร์จ+สายชาร์จใน listing เดียว) — รูปปก/รูป desc ไม่ตรง
    variant; Shopee เก็บรูปแยกต่อ option ไว้ ใช้ตรงนั้น. คืน "" ถ้า match ไม่ได้
    (containment match เฉพาะ option ≥4 chars กัน option สั้นอย่าง "ขาว" match ผิด variant)
    """
    def _n(s: str) -> str:
        return "".join(c for c in (s or "").lower() if c.isalnum())
    name = _n(model_name)
    if not name:
        return ""
    for tv in (lst.get("tier_variation") or []):
        for o in (tv.get("option_list") or []):
            opt = _n(o.get("option") or "")
            if opt and (opt == name or (len(opt) >= 4 and opt in name)):
                iid = (o.get("image") or {}).get("image_id")
                if iid:
                    return iid
    return ""


def to_unit_card(unit: dict, route=None) -> dict:
    """unit doc → card shape เดียวกับ to_product_card (downstream ไม่ต้องแก้)."""
    from . import product_store as _ps   # lazy — กัน circular (product_store ก็ lazy-import units)
    brand = unit.get("brand") or {}
    brand_name = brand.get("original_brand_name", "") if isinstance(brand, dict) else str(brand)
    lst = unit.get("_listing") or {}   # attach_listing_fields join มา (อาจไม่มี)
    # ⚡ availability สดจาก _listing ผ่าน resolver owner เดียว — unit snapshot เป็น build-time
    #   ของที่ร้านลบ/หมดหลัง build ต้องเห็นตาย (ทุก field ต้องสด — app.py recompute
    #   _available_for_sale ผ่าน resolver เดียวกันจะทับถ้า field stale)
    status, av, model_status = _live_availability(unit)
    stock = av["total_stock"]
    price = unit.get("price")
    # shape เดียวกับ _price_range ของ product card — downstream อ่าน price.get("min"/"max")
    price_range = {"min": int(price), "max": int(price), "currency": "THB"} if price else {}
    # ⚡ รูปแสดงผล: variant image (tier_variation option) > รูปปก listing > รูปแรกใน desc
    #   unit.image_ids = รูปใน description (ไว้ join OCR text) — รูปแรกมักเป็น banner
    #   ไม่ใช่รูปสินค้า/variant ที่ลูกค้ากำลังดู
    _vid = _variant_image_id(lst, unit.get("model_name") or "")
    img_ids = ([_vid] if _vid else
               (lst.get("image") or {}).get("image_id_list") or
               unit.get("image_ids") or [])
    # ⚡ tier evidence จาก joined listing (shape เดียวกับ to_product_card) —
    #   requested-option resolver ต้องการ structured vocab + tier_index ของ
    #   model ตัวเอง (ไม่ parse prose); ไม่มี _listing/model → ว่าง (honest)
    _mid = unit.get("model_id")
    _m = next((m for m in (lst.get("model") or [])
               if m.get("model_id") == _mid), None)
    return {
        # shape เดียวกับ product card
        "item_id": unit.get("item_id"),
        "name": unit.get("display_name"),
        "brand": brand_name,
        "category": unit.get("cat_name"),
        "shop": unit.get("shop"),
        "status": status,
        "condition": lst.get("condition"),
        "price": price_range,
        "warranty": _unit_warranty(unit),  # ระยะประกันจากชื่อ (shape เดียวกับ _warranty_info)
        "short_link": lst.get("short_link"),
        "image_url": f"https://cf.shopee.co.th/file/{img_ids[0]}" if img_ids else "",
        "weight": lst.get("weight"),
        "dimension": lst.get("dimension"),
        "total_stock": stock,
        "catalog_status": av["catalog_status"],
        "availability_reason": av["reason"],
        # sold_out = รู้จริงว่าหมดเท่านั้น — unknown/unlisted/model_missing ไม่ใช่ sold out
        "sold_out": av["catalog_status"] == "out_of_stock",
        "_available_for_sale": av["available_for_sale"],
        # UNLIST/unknown = ยังไม่ publish → ห้ามใช้เป็น evidence ตอบลูกค้า
        "customer_visible": av["customer_visible"],
        "has_promotion": _ps._has_active_promotion(lst) if lst else False,
        "is_flash_sale": bool(lst.get("is_flash_sale")),
        "description_excerpt": (
            (pick_desc_sections(unit, route) or (unit.get("image_text") or "")[:3000])
            + (f"\n\nเงื่อนไขการรับประกัน (จากรูปสินค้า): {unit['warranty_text']}"
               if unit.get("warranty_text") else "")
        ),
        "image_text": unit.get("image_text"),
        "warranty_text": unit.get("warranty_text"),
        "raw_description": "\n\n".join(
            v for v in (unit.get("desc_sections") or {}).values() if v)[:4000],
        "variants": [{
            "name": unit.get("model_name"), "model_id": unit.get("model_id"),
            "tier_index": (_m or {}).get("tier_index"),
            "stock": stock, "price": unit.get("price"),
            "model_status": model_status,
        }],
        "tier_variation": [
            {"name": tv.get("name"),
             "options": [o.get("option") for o in tv.get("option_list") or []]}
            for tv in (lst.get("tier_variation") or [])
        ],
        # unit-level extras (shape เดิม + ข้อมูลรุ่นย่อย)
        "unit_id": unit.get("unit_id"),
        "model_id": unit.get("model_id"),
        "model_name": unit.get("model_name"),
        "model_sku": unit.get("model_sku"),
        "model_status": model_status,
        "sellable": av["available_for_sale"],
        "kind": unit.get("kind"),
        "components": unit.get("components"),
        "product_type": unit.get("product_type"),
        "charger_subtype": unit.get("charger_subtype"),
        "cable_subtype": unit.get("cable_subtype"),
        "camera_subtype": unit.get("camera_subtype"),
        "model_codes": unit.get("model_codes"),
        "canonical_specs": unit.get("canonical_specs"),
        "oos_in_name": unit.get("oos_in_name"),
        "has_warranty_info": unit.get("has_warranty_info"),
        "has_description": unit.get("has_description"),
        "image_ids": (unit.get("image_ids") or [])[:10],
        "_score": unit.get("_score"),
        "_matched_by": unit.get("_matched_by"),
    }


def attach_kb_specs(unit_docs: list[dict]) -> list[dict]:
    """spec inheritance — unit ที่ desc ว่าง ยืม canonical_specs จาก kb_products
    ผ่าน model_codes (แก้ "บอกไม่มีข้อมูลทั้งที่ KB มี") — additive, docs เดิม.
    kb_products เป็น live source นอก generation contract — อ่าน admin DB ตรง"""
    from . import runtime_config as _rc
    if not _rc.legacy_kb_reads_allowed():
        return unit_docs
    need = [u for u in unit_docs
            if not u.get("has_description") and u.get("model_codes")]
    if not need:
        return unit_docs
    codes = sorted({c for u in need for c in u["model_codes"]})
    try:
        from . import knowledge_base as _kb
        kb = _kb._admin_db()["kb_products"]
        spec_of: dict[str, dict] = {}
        for doc in kb.find({"model_codes": {"$in": codes}},
                           {"model_codes": 1, "canonical_specs": 1}):
            for c in doc.get("model_codes") or []:
                spec_of.setdefault(c, doc.get("canonical_specs") or {})
        for u in need:
            specs = next((spec_of[c] for c in u["model_codes"] if spec_of.get(c)), None)
            if specs:
                u["canonical_specs"] = specs
                # Phase 5 — provenance: specs ยืมมาจาก kb_products ผ่าน
                #   model_codes ของ unit เอง (identity-bound ไม่ข้าม product)
                #   แต่ต้องบอกตรงว่าไม่ใช่ declared spec ของ listing
                u["_specs_origin"] = "kb_inherit"
    except Exception as exc:
        print(f"[UNITS] kb spec inherit error: {exc}", file=sys.stderr)
    return unit_docs


def _unit_warranty(unit: dict) -> dict | None:
    """ระยะประกันจาก item_name (1Y/2Y/-6M/ประกันศูนย์ไทย) — ใช้ parser เดียวกับ legacy path."""
    try:
        from . import warranty as _w
        w = _w.extract_warranty_from_name(unit.get("item_name") or "")
    except Exception:
        return None
    if not w:
        return None
    return {"duration": w["text"], "duration_months": str(w["months"]),
            "duration_source": "item_name"}


_WARRANTY_IMG_KWS = ("ประกัน", "รับประกัน", "เคลม", "warranty", "สินค้ามีปัญหา")


def attach_image_texts(unit_docs: list[dict], snap=_gen.SNAP_UNSET) -> list[dict]:
    """join published OCR evidence (image_texts_g<gid> ใน snapshot) เข้า unit
    ผ่าน image_ids — additive. ไม่อ่าน shared cache; ไม่มี generation → skip.

    image_text = text ของรูป kind=spec|product
    warranty_text = text ของรูป kind=banner ที่มีคำเกี่ยวกับประกัน
    (เงื่อนไขประกันเป็น per-listing — ร้านเดียวกันอาจให้ต่างกันตามสินค้า)
    """
    from . import runtime_config as _rc
    if not _rc.source_enabled("image_text"):
        return unit_docs
    iids = sorted({i for u in unit_docs for i in (u.get("image_ids") or [])})
    if not iids:
        return unit_docs
    try:
        snap = _resolve_snap(snap)
        if snap is None:
            return unit_docs        # ยังไม่มี generation — missing OCR non-blocking
        from . import knowledge_base as _kb
        coll = _kb._admin_db()[snap.image_texts_collection]
        text_of: dict[str, str] = {}
        warranty_of: dict[str, str] = {}
        for d in coll.find(
                {"image_id": {"$in": iids},
                 "kind": {"$in": ["spec", "product", "banner"]}},
                {"image_id": 1, "text": 1, "kind": 1}):
            t = d.get("text") or ""
            if not t:
                continue
            if d.get("kind") == "banner":
                if any(k in t for k in _WARRANTY_IMG_KWS):
                    warranty_of[d["image_id"]] = t
            else:
                text_of[d["image_id"]] = t
        for u in unit_docs:
            parts = [text_of[i] for i in (u.get("image_ids") or []) if text_of.get(i)]
            if parts:
                u["image_text"] = "\n".join(dict.fromkeys(parts))[:2500]
            wparts = [warranty_of[i] for i in (u.get("image_ids") or []) if warranty_of.get(i)]
            if wparts:
                u["warranty_text"] = "\n".join(dict.fromkeys(wparts))[:1500]
    except Exception as exc:
        print(f"[UNITS] image_text join error: {exc}", file=sys.stderr)
    return unit_docs


def attach_listing_fields(unit_docs: list[dict]) -> list[dict]:
    """join ShpProducts ด้วย item_id — เติม listing-level fields ที่ unit ไม่มี.

    ใช้ runtime join (ไม่ใช่ copy ตอน build) เพราะ promotion/flash_sale เปลี่ยนบ่อย —
    build-time copy จะ stale จน rebuild รอบหน้า. 1 query batch ต่อ request.
    """
    iids = {u.get("item_id") for u in unit_docs if u.get("item_id") is not None}
    if not iids:
        return unit_docs
    try:
        from . import product_store as _ps
        db_name = os.environ.get("MONGO_DB", "").strip()
        coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
        by_id: dict = {}
        for d in _ps.get_client()[db_name][coll_name].find(
                {"item_id": {"$in": list(iids)}},   # item_id เป็น int ทั้งสองฝั่ง — ห้าม str()
                {"item_id": 1, "condition": 1, "weight": 1, "dimension": 1,
                 "short_link": 1, "promotion": 1, "has_promotion": 1,
                 "is_flash_sale": 1, "image": 1, "tier_variation": 1,
                 # live availability — status/stock เปลี่ยนบ่อยกว่า build cycle
                 "item_status": 1, "stock_info_v2": 1,
                 "model.model_id": 1, "model.model_status": 1,
                 "model.stock_info_v2": 1}):
            by_id[d["item_id"]] = d
        for u in unit_docs:
            d = by_id.get(u.get("item_id"))
            if d:
                u["_listing"] = d
    except Exception as exc:
        print(f"[UNITS] listing join error: {exc}", file=sys.stderr)
    return unit_docs


def fetch_unit_cards(message: str, retrieval_profile: RetrievalProfile | None = None,
                     **kwargs) -> list[dict]:
    """fetch_units + attach_kb_specs + attach_image_texts + attach_listing_fields + to_unit_card."""
    route = kwargs.pop("route", None)
    # มี profile แล้วไม่ต้อง resolve_route ซ้ำ (fetch_units ใช้ profile ตรง)
    if route is None and retrieval_profile is None:
        from . import route_context as _rc
        route = _rc.resolve_route(message)
    limit = int(kwargs.pop("limit", 8))
    # snapshot เดียวต่อ request — units coll + OCR coll + npz ต้อง gen เดียวกัน
    snap = _resolve_snap(kwargs.pop("snap", _gen.SNAP_UNSET))
    # ⚡ overfetch 2× เพราะ sellable บน unit doc เป็น build-time snapshot —
    #   re-sort ด้วย live status หลัง join (ของที่ตายหลัง build ถูกดีดออกจาก top)
    #   แล้วค่อยตัด limit — code-hit ยังชนะเสมอ
    us = attach_listing_fields(attach_image_texts(attach_kb_specs(
        fetch_units(message, route=route, limit=limit * 2,
                    retrieval_profile=retrieval_profile, snap=snap,
                    **kwargs)), snap=snap))
    us.sort(key=lambda u: (u.get("_matched_by") == "code",
                           _live_sellable(u), u.get("_score") or 0.0),
            reverse=True)
    top = us[:limit]
    # ⚡ unit index เป็น snapshot — ถ้า catalog เปลี่ยนหลัง build (ร้านลบ/restock)
    #   pool อาจตายหมดทั้งที่ live catalog มีของขาย → คืน [] ให้ caller ตก legacy
    #   (legacy sweep อ่าน status/stock สด + pool กว้างกว่า)
    #   ยกเว้น code-hit — "HA835 มีไหม" ต้องเห็น HA835 แม้ตาย (ตอบ "หมด/เลิกขาย" ได้)
    if top and not any(u.get("_matched_by") == "code" for u in top) \
            and not any(_live_sellable(u) for u in top):
        print("[UNITS] pool all-dead post-join → legacy fallback", file=sys.stderr)
        return []
    return [to_unit_card(u, route) for u in top]


@dataclass(frozen=True)
class UnitEvidenceFetchResult:
    """evidence fetch result — cards ครบทั้ง sellable/dead (ไม่ collapse เหมือน
    fetch_unit_cards ที่คืน [] เมื่อ all-dead เพื่อเป็น runtime fallback signal)"""
    cards: tuple[dict, ...]
    raw_count: int
    sellable_count: int
    unavailable_count: int
    trace: tuple[str, ...]


def fetch_unit_evidence(
    message: str,
    retrieval_profile: RetrievalProfile | None = None,
    **kwargs,
) -> UnitEvidenceFetchResult:
    """chain เดียวกับ fetch_unit_cards แต่คืน evidence ทั้งหมด — observe path
    ของ grouped executor (Task 5B1): หลักฐาน all-dead ต้องไม่หาย
    availability คำนวณผ่าน resolve_availability เหมือนเดิม (ใน to_unit_card)"""
    route = kwargs.pop("route", None)
    if route is None and retrieval_profile is None:
        from . import route_context as _rc
        route = _rc.resolve_route(message)
    limit = int(kwargs.pop("limit", 8))
    snap = _resolve_snap(kwargs.pop("snap", _gen.SNAP_UNSET))
    us = attach_listing_fields(attach_image_texts(attach_kb_specs(
        fetch_units(message, route=route, limit=limit * 2,
                    retrieval_profile=retrieval_profile, snap=snap,
                    **kwargs)), snap=snap))
    us.sort(key=lambda u: (u.get("_matched_by") == "code",
                           _live_sellable(u), u.get("_score") or 0.0),
            reverse=True)
    cards = tuple(to_unit_card(u, route) for u in us[:limit])
    sellable = sum(1 for c in cards if c.get("_available_for_sale"))
    return UnitEvidenceFetchResult(
        cards=cards,
        raw_count=len(us),
        sellable_count=sellable,
        unavailable_count=len(cards) - sellable,
        trace=(f"units raw={len(us)} top={len(cards)} sellable={sellable}",),
    )
