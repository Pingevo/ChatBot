"""Prototype: hybrid unit retrieval — "units หา + legacy เลือก" (OFFLINE, ไม่แตะ prod)

เปรียบเทียบ 2 โหมดบน index จริง (exports/sellable_units.jsonl + unit_embeddings.npz):

  A) unit-vector (ปัจจุบัน): cosine top-50 → ตัด sims>0.3 → field filter → sellable-first → limit
     ← จำลอง _vector_search + fetch_units logic ตรงๆ (เคส MacBook เคยได้ ~5 ชิ้น)

  B) field-sweep (prototype): ดึง units ตาม {shop, product_type ∈ scope} ตรงๆ จาก index
     ไม่ผ่าน similarity → แล้ว rank ด้วย live-sellable + adequate-first wattage
     (logic เดียวกับ legacy compat sort)

จุดประสงค์: พิสูจน์ว่า compat/type-scoped query ต้อง sweep ตาม field ไม่ใช่ similarity —
ของที่ spec สูงพอไม่เคยเข้า pool เพราะ text ไม่คล้าย query

รัน: .venv/bin/python docs/test/test_unit_hybrid_sweep.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "chatbot"))

import numpy as np

from shopeechat import units as _units
from shopeechat.device_compat import (
    _extract_max_wattage, _wattage_asc_key, _charging_scope, _lookup_spec_db,
    _compat_mode,
)
from shopeechat import route_context as _rc

UNITS_JSONL = _REPO_ROOT / "exports" / "sellable_units.jsonl"
UNIT_NPZ = _REPO_ROOT / "exports" / "unit_embeddings.npz"

# ── load index ──
_UNITS: list[dict] = []
with open(UNITS_JSONL) as f:
    for line in f:
        _UNITS.append(json.loads(line))
_BY_ID = {u["unit_id"]: u for u in _UNITS}
print(f"[load] {len(_UNITS)} units from jsonl")

_uv = _units._unit_vectors()
_EMB, _UIDS, _SHOPS = _uv["emb"], _uv["unit_ids"], _uv["shops"]
print(f"[load] embeddings {_EMB.shape}")

from shopeechat import embedding as _emb_mod  # noqa: E402  (โหลด model หนัก — ทีเดียว)


# ══════════ Mode A — จำลอง unit path ปัจจุบันตรงๆ ══════════
def mode_a_vector(message: str, shop: str, ptypes: set[str] | None,
                  subtype: str | None, limit: int = 8) -> list[dict]:
    """_vector_search(top50, sims>0.3) → field filter → sellable-first → limit"""
    q = _emb_mod.embed_query(message)
    mask = np.array([s == shop for s in _SHOPS])
    sims = np.where(mask, _EMB @ q, -1.0)
    idx = np.argpartition(-sims, min(50, len(sims) - 1))[:50]
    vec = [(str(_UIDS[i]), float(sims[i])) for i in idx if sims[i] > 0.3]
    docs = [_BY_ID[uid] for uid, _ in vec if uid in _BY_ID]
    pt = set(ptypes or set())
    pt |= _units._SUBTYPE_TO_TYPES.get(subtype or "", set())
    if pt:
        typed = [d for d in docs if d.get("product_type") in pt]
        if typed:
            docs = typed
    score_of = dict(vec)
    docs.sort(key=lambda u: (bool(u.get("sellable")), score_of.get(u["unit_id"], 0.0)),
              reverse=True)
    return docs[:limit]


# ══════════ Mode B — field sweep + legacy-style ranking ══════════
def mode_b_sweep(message: str, shop: str, ptypes: set[str] | None,
                 subtype: str | None, min_watt: float | None,
                 limit: int = 8) -> tuple[list[dict], int]:
    """ดึงทุก unit ของ type/subtype ใน scope (ไม่ผ่าน similarity) → sellable-first +
    adequate-first wattage (logic เดียวกับ legacy compat sort)"""
    pt = set(ptypes or set())
    pt |= _units._SUBTYPE_TO_TYPES.get(subtype or "", set())
    pool = [u for u in _UNITS if u.get("shop") == shop]
    # subtype เจาะจง (car_charger/wireless/...) → กรอง field charger_subtype ของ unit
    # ตรงๆ (unit เก็บ subtype เป็น field จริง — ไม่ใช่เดาจากชื่อ); ไม่ match subtype
    # เลยค่อย fallback product_type
    if subtype and any(u.get("charger_subtype") == subtype for u in pool):
        pool = [u for u in pool if u.get("charger_subtype") == subtype]
    elif pt:
        pool = [u for u in pool if u.get("product_type") in pt]
    total = len(pool)
    # rank: sellable ก่อน (desc) → adequate-first wattage (asc) —
    #   ต้อง ascending ทั้ง tuple: (not sellable)=0 ก่อน, tier 0(adequate) ก่อน, watt น้อยก่อน
    pool.sort(key=lambda u: (
        not bool(u.get("sellable")),
        *_wattage_asc_key({"name": u.get("display_name") or "",
                           "description_excerpt": u.get("search_text") or ""},
                          min_watt),
    ))
    return pool[:limit], total


def _w(u: dict) -> float:
    return _extract_max_wattage({"name": u.get("display_name") or "",
                                 "description_excerpt": u.get("search_text") or ""})


def _show(tag: str, docs: list[dict], total: int | None = None) -> None:
    sell = sum(1 for u in docs if u.get("sellable"))
    watts = sorted({_w(u) for u in docs})
    t = f" (sweep ทั้งหมด={total})" if total is not None else ""
    print(f"  {tag}: pool={len(docs)}{t} sellable={sell} watts={watts}")
    for u in docs[:5]:
        print(f"    {_w(u):6.0f}W {'✓' if u.get('sellable') else '✗'} "
              f"{(u.get('display_name') or '')[:85]}")


# ══════════ cases ══════════
CASES = [
    # (message, shop, intent product_type, target_device สำหรับ min_watt)
    ("พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม", "KingGadgets", "powerbank", "macbook"),
    ("สายชาร์จใช้กับ redmi note 9 ได้ไหม", "KingGadgets", "charger", "redmi note 9"),
    ("มีหัวชาร์จในรถไหม", "KingGadgets", "car_charger", None),
    ("มีหูฟังไร้สายไหม", "KingGadgets", "earphone", None),
]

for msg, shop, itype, dev in CASES:
    print(f"\n{'═' * 72}\nQ: {msg}  (shop={shop}, intent_type={itype})")
    mode, asked = _compat_mode(itype, msg)
    scope = _charging_scope(msg, asked) if mode in ("charging", "unknown") else None
    ptypes = scope or ({itype} if itype else None)
    spec = _lookup_spec_db(dev) if dev else None
    min_watt = (spec or {}).get("min_watt")
    print(f"  mode={mode} asked={asked} scope={scope} spec={dev}→{min_watt}W")

    print(" ── A) unit-vector (ปัจจุบัน) ──")
    _show("A", mode_a_vector(msg, shop, ptypes, asked))

    print(" ── B) field-sweep (hybrid prototype) ──")
    _docs, _tot = mode_b_sweep(msg, shop, ptypes, asked, min_watt)
    _show("B", _docs, _tot)
