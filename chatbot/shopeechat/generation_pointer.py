"""generation_pointer — owner เดียวของ active evidence-generation pointer + snapshot.

Phase 4B: ทุก generated source (units collection, published OCR collection,
unit/product NPZ, units JSONL, manifest) ผูกกับ generation_id เดียวผ่าน pointer
document `sellable_units_meta {_id:"active"}` — module นี้เป็นจุดเดียวที่
resolve pointer → EvidenceSnapshot (immutable) ให้ request ใช้ร่วมกัน

- validate ทุก field: gid format + derived collection/path ต้องอยู่ใต้ gen ตัวเอง
- resolver: pointer read + short TTL — callers ใน window เดียวกันได้ object เดิม
- missing/invalid pointer → None (fail closed — caller ตัดสิน degrade)
- ไม่มี business logic, ไม่มี Mongo write — write owner อยู่ publish_generation.py
"""
from __future__ import annotations

import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

GEN_ID_RE = re.compile(r"^g\d{8}-\d{6}-[0-9a-f]{8}$")
POINTER_COLL = "sellable_units_meta"
POINTER_ID = "active"
POINTER_TTL = 5.0          # วินาที — amortize pointer read; object คนละ window อาจต่าง gen

_POINTER_FIELDS = (
    "units_collection", "image_texts_collection",
    "units_npz", "product_npz", "units_jsonl",
    "manifest_path", "manifest_sha256", "activated_at",
)

# canonical field→filename mapping เดียว — resolver validate + publisher
# serialize ใช้ชุดเดียวกัน (pointer เก็บ repo-relative paths เท่านั้น)
POINTER_PATH_FILES = {
    "units_npz": "unit_embeddings.npz",
    "product_npz": "product_embeddings.npz",
    "units_jsonl": "sellable_units.jsonl",
    "manifest_path": "manifest.json",
}
_PATH_FIELDS = tuple(POINTER_PATH_FILES)


def canonical_gen_relpath(gid: str, field: str) -> str:
    """repo-relative path เดียวที่ pointer ยอมรับ/เขียนสำหรับ field นี้"""
    return f"exports/gen/{gid}/{POINTER_PATH_FILES[field]}"


SNAP_UNSET = object()
"""sentinel แยก 'argument omitted' (standalone caller → resolve เองครั้งเดียว)
จาก captured value (รวม None — request ที่ capture แล้วใช้ค่านั้นตลอด ไม่ resolve ซ้ำ)
owner: request boundary (`app._chat_impl`) capture ครั้งเดียวแล้วส่งต่อ"""


@dataclass(frozen=True)
class EvidenceSnapshot:
    """immutable per-request view ของ generated sources ทั้งหมด — resolve ครั้งเดียว
    แล้วส่งต่อให้ทุก loader (ห้าม loader resolve pointer ซ้ำเอง)"""
    generation_id: str
    units_collection: str
    image_texts_collection: str
    units_npz: str            # absolute path
    product_npz: str
    units_jsonl: str
    manifest_path: str
    manifest_sha256: str
    activated_at: str


def mint_generation_id(now: datetime | None = None) -> str:
    """g<UTC %Y%m%d-%H%M%S>-<8hex> — timestamp sortable + uuid suffix กัน
    collision เมื่อสอง attempts เริ่มวินาทีเดียวกัน"""
    now = now or datetime.now(timezone.utc)
    return f"g{now.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"


def snapshot_from_pointer(doc: dict | None) -> EvidenceSnapshot | None:
    """pointer doc → validated immutable snapshot; invalid/absent → None.

    Exact-path rule: collection names ต้อง derive จาก gid และทุก path field
    ต้องเท่ากับ `exports/gen/<gid>/<canonical filename>` (repo-relative)
    เป๊ะ ๆ — absolute/`..`/foreign gid/wrong filename ทั้งหมด reject
    """
    if not isinstance(doc, dict):
        return None
    gid = doc.get("generation_id")
    if not isinstance(gid, str) or not GEN_ID_RE.fullmatch(gid):
        return None
    if doc.get("units_collection") != f"sellable_units_{gid}":
        return None
    if doc.get("image_texts_collection") != f"image_texts_{gid}":
        return None
    out: dict[str, str] = {"generation_id": gid}
    for f in _PATH_FIELDS:
        v = doc.get(f)
        if not isinstance(v, str) or v != canonical_gen_relpath(gid, f):
            return None
        out[f] = str(ROOT / v)   # relative→local absolute หลัง validate เท่านั้น
    for f in _POINTER_FIELDS:
        if f in out:
            continue
        v = doc.get(f)
        if not isinstance(v, str) or not v:
            return None
        out[f] = v
    return EvidenceSnapshot(
        generation_id=gid,
        units_collection=out["units_collection"],
        image_texts_collection=out["image_texts_collection"],
        units_npz=out["units_npz"],
        product_npz=out["product_npz"],
        units_jsonl=out["units_jsonl"],
        manifest_path=out["manifest_path"],
        manifest_sha256=out["manifest_sha256"],
        activated_at=out["activated_at"],
    )


_cache: tuple[float, EvidenceSnapshot | None] | None = None
_cache_lock = threading.Lock()


def resolve_snapshot(db=None, *, force: bool = False) -> EvidenceSnapshot | None:
    """อ่าน sellable_units_meta.active → validated snapshot หรือ None.

    db: inject ได้ (tests) — None → admin DB ผ่าน knowledge_base client (lazy,
    กัน circular: generation_pointer import ได้โดยไม่ต้อง import units/product)
    TTL สั้น ๆ: pointer flip ใหม่จะถูกเห็นภายใน window นี้; object ที่คืนไปแล้ว
    ไม่เปลี่ยน — request ที่จับ object ไว้ใช้ generation เดิมจนจบ
    """
    global _cache
    now = time.time()
    with _cache_lock:
        if not force and _cache is not None and now - _cache[0] < POINTER_TTL:
            return _cache[1]
    try:
        if db is None:
            from . import knowledge_base as _kb
            db = _kb._admin_db()
        doc = db[POINTER_COLL].find_one({"_id": POINTER_ID})
    except Exception as exc:
        print(f"[GEN] pointer read failed: {exc}", file=sys.stderr)
        doc = None
    snap = snapshot_from_pointer(doc)
    with _cache_lock:
        _cache = (now, snap)
    return snap


def reset_cache() -> None:
    """test hook — เคลียร์ TTL cache (production ไม่เรียก)"""
    global _cache
    with _cache_lock:
        _cache = None


def npz_generation_id(npz_path: str | Path):
    """อ่าน generation_id ที่ฝังใน npz — คืน str หรือ None (ไฟล์เก่า/เสีย)"""
    try:
        import numpy as np
        z = np.load(npz_path, allow_pickle=True)
        if "generation_id" not in z.files:
            return None
        v = z["generation_id"]
        return str(v.item() if hasattr(v, "item") else v)
    except Exception:
        return None
