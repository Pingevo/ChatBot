"""publish_generation — pointer/mutation owner เดียวของ Phase 4B.

หน้าที่ (ลำดับเดียวที่ถูกต้อง):
    validate_generation → finalize manifest (tmp→replace, verify) → CAS pointer
    ครั้งเดียว → cleanup (best-effort, หลัง activation เท่านั้น)

- pointer = sellable_units_meta {_id:"active"} — write ผ่าน fenced CAS เท่านั้น
  publish: {_id:active, generation_id:expected}; bootstrap: generation_id ไม่มี
  → upsert (duplicate _id = conflict); rollback: filter เดียวกัน swap previous↔top
- cleanup: ห้ามลบ active/previous/อายุ < grace (24h default) — best effort
- ไม่มี retry loop: CAS แพ้ → reread 1 ครั้งเพื่อ classify → conflict:<gid>

usage:
    publish_generation.py --gen-dir exports/gen/<gid> --gid <gid> [--expected <gid>|none|auto]
    publish_generation.py --rollback --expected-active <gid>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

POINTER_COLL = "sellable_units_meta"
POINTER_ID = "active"
GRACE_SECONDS = 24 * 3600
_GID_TS_RE = re.compile(r"^g(\d{8})-(\d{6})-[0-9a-f]{8}$")
_GEN_COLL_RE = re.compile(r"^(sellable_units|image_texts)_(g\d{8}-\d{6}-[0-9a-f]{8})$")

# fields ที่อยู่ top-level ของ pointer = สิ่งที่ snapshot resolver validate
_SNAPSHOT_FIELDS = (
    "generation_id", "units_collection", "image_texts_collection",
    "units_npz", "product_npz", "units_jsonl",
    "manifest_path", "manifest_sha256", "unit_count", "npz_rows",
    "activated_at",
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _count_jsonl(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for _ in open(path, encoding="utf-8"))


def _npz_rows_and_gen(path: Path) -> tuple[int, str | None]:
    import numpy as np
    z = np.load(path, allow_pickle=True)
    gid = (str(z["generation_id"].item())
           if "generation_id" in z.files else None)
    return int(z["embeddings"].shape[0]), gid


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _gid_age_seconds(gid: str, now: float) -> float | None:
    """อายุ generation จาก timestamp ใน gid — parse ไม่ได้ → None (ปลอดภัย: keep)"""
    m = _GID_TS_RE.match(gid)
    if not m:
        return None
    ts = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    return now - ts.replace(tzinfo=timezone.utc).timestamp()


def _read_pointer(db) -> dict | None:
    return db[POINTER_COLL].find_one({"_id": POINTER_ID})


def validate_generation(gen_dir: Path, db, gid: str,
                        require_description: bool = False) -> dict:
    """counts/hashes/generation pairing — mismatch ใด ๆ → ValueError (หยุดก่อน CAS).

    ตรวจ: artifacts ครบ, units jsonl == units coll count, unit npz rows ==
    units count, product npz rows > 0, ทั้ง npz ฝัง generation_id == gid,
    image_texts evidence file count == published coll count + generation
    OCR counts ของ gid เดียวกัน (empty publish ผ่านเฉพาะเมื่อ counts
    พิสูจน์ว่า source ว่างจริง — r7 gate)
    """
    gen_dir = Path(gen_dir)
    required = ("sellable_units.jsonl", "unit_embeddings.npz",
                "product_embeddings.npz", "ShpProducts.export.json")
    for name in required:
        if not (gen_dir / name).exists():
            raise ValueError(f"missing artifact: {gen_dir / name}")
    unit_count = _count_jsonl(gen_dir / "sellable_units.jsonl")
    coll_count = db[f"sellable_units_{gid}"].count_documents({})
    if coll_count != unit_count:
        raise ValueError(
            f"sellable_units_{gid} count {coll_count} != jsonl {unit_count}")
    npz_rows, npz_gid = _npz_rows_and_gen(gen_dir / "unit_embeddings.npz")
    if npz_gid != gid:
        raise ValueError(f"unit npz generation_id {npz_gid!r} != {gid}")
    if npz_rows != unit_count:
        raise ValueError(f"unit npz rows {npz_rows} != units {unit_count}")
    prod_rows, prod_gid = _npz_rows_and_gen(gen_dir / "product_embeddings.npz")
    if prod_gid != gid:
        raise ValueError(f"product npz generation_id {prod_gid!r} != {gid}")
    if prod_rows <= 0:
        raise ValueError("product npz empty")
    # Phase 10B — description-chunk artifact เป็น optional: มี ⇒ schema gate
    #   เต็มรูปแบบก่อน CAS; ไม่มี ⇒ generation ยัง valid (gen เก่าก่อน Phase
    #   10B ไม่กลายเป็น invalid — runtime desc source คืนว่างตาม contract)
    desc_npz = gen_dir / "description_embeddings.npz"
    desc_rows = 0
    if require_description and not desc_npz.exists():
        # operator precondition: Phase 10B gen ใหม่ต้องมี description source —
        #   missing artifact = publication reject (ไม่ใช่ empty-source publish)
        raise ValueError(
            "description_embeddings.npz required but missing — "
            "description build must succeed before publish")
    if desc_npz.exists():
        import numpy as np
        _z = np.load(desc_npz, allow_pickle=True)
        _dgid = (str(_z["generation_id"].item())
                 if "generation_id" in _z.files else None)
        if _dgid != gid:
            raise ValueError(
                f"description npz generation_id {_dgid!r} != {gid}")
        desc_rows = int(_z["embeddings"].shape[0])
        if _z["embeddings"].ndim != 2 or _z["embeddings"].shape[1] != 1024:
            raise ValueError(
                f"description npz emb dim {_z['embeddings'].shape}")
        if not np.isfinite(_z["embeddings"]).all():
            raise ValueError("description npz non-finite embeddings")
        for _k in ("item_ids", "chunk_ids", "shops", "texts"):
            if _k not in _z.files or len(_z[_k]) != desc_rows:
                raise ValueError(f"description npz {_k} rows != {desc_rows}")
        if len({str(c) for c in _z["chunk_ids"]}) != desc_rows:
            raise ValueError("description npz duplicate chunk_ids")
        for _iid, _cid in zip(_z["item_ids"], _z["chunk_ids"]):
            if not str(_cid).startswith(f"{_iid}:"):
                raise ValueError(
                    f"description npz chunk_id {_cid} !~ item_id {_iid}")
    if require_description and desc_rows <= 0:
        raise ValueError(
            "description_embeddings.npz required but empty (0 rows)")
    it_count = _count_jsonl(gen_dir / "image_texts.jsonl")
    it_coll = db[f"image_texts_{gid}"].count_documents({})
    if it_coll != it_count:
        raise ValueError(
            f"image_texts_{gid} count {it_coll} != evidence file {it_count}")
    # r8 completeness gate — sidecar + jsonl + generated collection ต้อง
    #   พิสูจน์ผลลัพธ์เดียวกันครบทั้งสอง scope ก่อน CAS เสมอ:
    #   sidecar parse ได้ + gid ตรง + completed_scopes = 2 scopes +
    #   scopes keys ตรง completed_scopes + per-scope counters ครบเป็น
    #   int≥0 (ไม่ใช่ bool) + finals int≥0 +
    #   unique_discovered = ผลรวม scope-discovered (worklists disjoint) +
    #   published_evidence == jsonl count + coll count == jsonl (ด้านบน) +
    #   reusable/carried>0 ⇒ evidence>0 + empty ⇒ unique_discovered==0
    #   (mismatch ใด ๆ → reject ก่อน CAS — pointer เดิมคงเดิม)
    cdoc = None
    counts_path = gen_dir / "image_texts.counts.json"
    if counts_path.exists():
        try:
            _c = json.loads(counts_path.read_text(encoding="utf-8"))
            if (_c.get("generation_id") == gid
                    and isinstance(_c.get("scopes"), dict)):
                cdoc = _c
        except Exception:
            cdoc = None
    if cdoc is None:
        raise ValueError(
            f"image_texts_{gid} without valid generation OCR counts — "
            "carry-forward step did not run (publish rejected)")
    cscopes = cdoc.get("scopes") or {}
    if set(cdoc.get("completed_scopes") or []) != {"sellable",
                                                 "nonsellable"}:
        raise ValueError(
            f"image_texts_{gid} incomplete scopes "
            f"{cdoc.get('completed_scopes')} — both sellable and "
            "nonsellable must complete (publish rejected)")
    # r9 shape gate — completed_scopes เพียงอย่างเดียวไม่ใช่ proof: scope keys
    #   + counter types + finals ต้อง structurally valid (scopes:{} fabricated
    #   เคยผ่าน — completed ถูกเช็คแต่ scopes keys ไม่เคยถูก verify)
    if set(cscopes) != {"sellable", "nonsellable"}:
        raise ValueError(
            f"image_texts_{gid} scopes keys {sorted(cscopes)} != "
            "{sellable,nonsellable} (publish rejected)")
    if set(cdoc.get("completed_scopes") or []) != set(cscopes):
        raise ValueError(
            f"image_texts_{gid} completed_scopes != scopes keys")
    _req = ("discovered", "reusable", "carried", "new", "changed",
            "deferred", "malformed", "duplicate")
    for sname in ("sellable", "nonsellable"):
        sc = cscopes[sname]
        if not isinstance(sc, dict):
            raise ValueError(
                f"image_texts_{gid} scope {sname} not an object")
        for k in _req:
            v = sc.get(k)
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                raise ValueError(
                    f"image_texts_{gid} scope {sname}.{k} invalid: {v!r}")
    for k in ("unique_discovered", "published_evidence"):
        v = cdoc.get(k)
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise ValueError(
                f"image_texts_{gid} {k} invalid: {v!r}")
    unique_discovered = cdoc.get("unique_discovered")
    if unique_discovered != sum(
            (cscopes.get(s) or {}).get("discovered") or 0
            for s in ("sellable", "nonsellable")):
        raise ValueError(
            f"image_texts_{gid} unique_discovered {unique_discovered} "
            "!= scope discovered sum")
    published_evidence = cdoc.get("published_evidence")
    if published_evidence != it_count:
        raise ValueError(
            f"image_texts_{gid} published_evidence {published_evidence} "
            f"!= evidence file count {it_count}")
    carried_total = sum((sc.get("reusable") or 0) + (sc.get("carried") or 0)
                        for sc in cscopes.values())
    if carried_total > 0 and it_count == 0:
        raise ValueError(
            f"image_texts_{gid} empty but counts show carried/reusable "
            "evidence — refusing empty publish")
    if it_count == 0 and unique_discovered != 0:
        raise ValueError(
            f"image_texts_{gid} empty but unique_discovered="
            f"{unique_discovered} — source was not empty")
    return {
        "unit_count": unit_count, "npz_rows": npz_rows,
        "product_rows": prod_rows, "desc_rows": desc_rows,
        "image_texts_count": it_count,
        "image_texts_scopes": cscopes,
        "image_texts_unique_discovered": unique_discovered,
        "image_texts_published_evidence": published_evidence,
        "image_texts_completed_scopes": sorted(
            cdoc.get("completed_scopes") or []),
        "sha256": {name: sha256_file(gen_dir / name)
                   for name in (*required, "description_embeddings.npz")
                   if (gen_dir / name).exists()},
    }


def finalize_manifest(gen_dir: Path, payload: dict) -> tuple[Path, str]:
    """manifest tmp→replace (final ก่อน CAS เสมอ) → read-back verify → (path, sha)"""
    gen_dir = Path(gen_dir)
    tmp = gen_dir / "manifest.json.tmp"
    final = gen_dir / "manifest.json"
    body = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    tmp.write_text(body + "\n", encoding="utf-8")
    os.replace(tmp, final)
    # verify finalized bytes อ่านกลับ — pointer ต้องไม่อ้าง pending manifest
    back = json.loads(final.read_text(encoding="utf-8"))
    if back.get("generation_id") != payload["generation_id"] \
            or back.get("status") != payload["status"]:
        raise ValueError("manifest read-back mismatch")
    return final, sha256_file(final)


def cas_publish(db, expected_current: str | None, set_doc: dict) -> str:
    """one fenced pointer write.

    expected None → bootstrap: upsert บน {generation_id:{$exists:false}} —
    duplicate _id → conflict (ไม่ retry); expected gid → CAS matched==1 →
    "published", 0 → reread 1 ครั้ง classify → "conflict:<actual>"
    """
    coll = db[POINTER_COLL]
    if expected_current is None:
        from pymongo.errors import DuplicateKeyError
        try:
            r = coll.update_one(
                {"_id": POINTER_ID, "generation_id": {"$exists": False}},
                {"$set": set_doc}, upsert=True)
        except DuplicateKeyError:
            actual = _read_pointer(db) or {}
            return f"conflict:{actual.get('generation_id', '?')}"
        return ("bootstrap" if getattr(r, "upserted_id", None) is not None
                or getattr(r, "matched_count", 0) else "conflict")
    r = coll.update_one(
        {"_id": POINTER_ID, "generation_id": expected_current},
        {"$set": set_doc})
    if getattr(r, "matched_count", 0) == 1:
        return "published"
    actual = _read_pointer(db) or {}
    return f"conflict:{actual.get('generation_id', '?')}"


def _pointer_set_doc(gid: str, stats: dict, manifest_sha: str,
                     previous: dict | None) -> dict:
    # pointer เก็บ repo-relative canonical paths เท่านั้น (portable ข้าม host/
    # container — resolver convert → absolute ภายใต้ ROOT ตอนอ่าน)
    from chatbot.shopeechat import generation_pointer as _gp
    return {
        "generation_id": gid,
        "units_collection": f"sellable_units_{gid}",
        "image_texts_collection": f"image_texts_{gid}",
        "units_npz": _gp.canonical_gen_relpath(gid, "units_npz"),
        "product_npz": _gp.canonical_gen_relpath(gid, "product_npz"),
        "units_jsonl": _gp.canonical_gen_relpath(gid, "units_jsonl"),
        "manifest_path": _gp.canonical_gen_relpath(gid, "manifest_path"),
        "manifest_sha256": manifest_sha,
        "unit_count": stats["unit_count"], "npz_rows": stats["npz_rows"],
        "activated_at": _utc_now_iso(),
        "previous": previous or {},
    }


def publish(db, gen_dir: Path, gid: str, expected_current: str | None = "auto",
            exports_root: Path | None = None,
            require_description: bool = False) -> str:
    """validate → manifest → one CAS → cleanup — คืน published|bootstrap|conflict:*

    expected_current: "auto" = อ่านจาก pointer ปัจจุบัน (None ถ้าไม่มี) — CAS
    fence ป้องกัน publisher สองตัวเหยียบกันเสมอ; pre-CAS failure → raise (gen
    เก่ายัง active เหมือนเดิม)
    """
    from chatbot.shopeechat.generation_pointer import GEN_ID_RE
    gen_dir = Path(gen_dir).resolve()
    exports_root = (Path(exports_root).resolve() if exports_root is not None
                    else gen_dir.parent.parent)
    # identity gate — ก่อน manifest/CAS/cleanup เสมอ:
    #   gid ต้องเป็น canonical generation id และ gen_dir ต้องเป็นดิเรกทอรี
    #   เดียวกับที่ pointer จะอ้าง (exports_root/gen/<gid>) — artifacts ที่
    #   validate ผ่านต้องเป็นชุดเดียวกับที่ pointer ชี้เสมอ
    if not GEN_ID_RE.fullmatch(gid):
        raise ValueError(f"invalid generation_id: {gid!r}")
    if gen_dir != exports_root / "gen" / gid:
        raise ValueError(
            f"gen_dir {gen_dir} != {exports_root / 'gen' / gid} — "
            "pointer ต้องอ้าง gen dir เดียวกับที่ validate")
    stats = validate_generation(gen_dir, db, gid,
                                require_description=require_description)
    counts = {
        "units": stats["unit_count"], "unit_npz_rows": stats["npz_rows"],
        "products": stats["product_rows"],
        "image_texts": stats["image_texts_count"],
        "image_texts_unique_discovered":
            stats["image_texts_unique_discovered"],
        "image_texts_published_evidence":
            stats["image_texts_published_evidence"],
        "image_texts_completed_scopes":
            stats["image_texts_completed_scopes"]}
    if stats["desc_rows"]:                       # Phase 10B artifact present
        counts["description_chunks"] = stats["desc_rows"]
    # per-scope counters → disjoint-safe sums (worklists disjoint — ทุก key
    #   ยกเว้น discovered ที่ถูกบันทึกเป็น unique_discovered แล้ว)
    for sc in stats["image_texts_scopes"].values():
        for k, v in sc.items():
            if k == "discovered":
                continue
            if isinstance(v, int) and not isinstance(v, bool):
                counts[f"image_texts_{k}"] = (
                    counts.get(f"image_texts_{k}", 0) + v)
    if stats["image_texts_count"] == 0:
        counts["image_texts_empty"] = True
    manifest = {
        "generation_id": gid, "status": "validated",
        "validated_at": _utc_now_iso(), "counts": counts,
        "sha256": stats["sha256"],
    }
    _mpath, msha = finalize_manifest(gen_dir, manifest)
    current = _read_pointer(db)
    if expected_current == "auto":
        expected_current = (current or {}).get("generation_id")
    previous = ({k: current[k] for k in _SNAPSHOT_FIELDS if k in current}
                if current else None)
    res = cas_publish(db, expected_current,
                      _pointer_set_doc(gid, stats, msha, previous))
    if res in ("published", "bootstrap"):
        try:
            removed = cleanup_generations(db, exports_root)
            if removed:
                print(f"[PUBLISH] cleanup removed: {removed}")
        except Exception as exc:
            # cleanup เป็น non-critical — fail ไม่ย้อน activation ที่เพิ่งสำเร็จ
            print(f"[PUBLISH] cleanup failed (best-effort): {exc}",
                  file=sys.stderr)
    return res


def rollback(db, expected_active: str) -> str:
    """pointer-only rollback — swap previous snapshot ขึ้นเป็น active ด้วย CAS
    fence บน expected_active; stale → conflict:<actual>; ไม่มี previous → conflict"""
    cur = _read_pointer(db)
    if not cur or cur.get("generation_id") != expected_active:
        return f"conflict:{(cur or {}).get('generation_id', '?')}"
    prev = cur.get("previous") or {}
    if not prev.get("generation_id"):
        return "conflict:no-previous"
    displaced = {k: cur[k] for k in _SNAPSHOT_FIELDS if k in cur}
    set_doc = {k: prev[k] for k in _SNAPSHOT_FIELDS if k in prev}
    set_doc["previous"] = displaced
    set_doc["activated_at"] = _utc_now_iso()
    r = db[POINTER_COLL].update_one(
        {"_id": POINTER_ID, "generation_id": expected_active},
        {"$set": set_doc})
    if getattr(r, "matched_count", 0) == 1:
        return "rolled_back"
    actual = _read_pointer(db) or {}
    return f"conflict:{actual.get('generation_id', '?')}"


def cleanup_generations(db, exports_root: Path, *, now: float | None = None,
                        grace_seconds: float = GRACE_SECONDS) -> list[str]:
    """ลบ generations ที่ไม่ถูกอ้าง — keep: active, previous(rollback target),
    อายุ < grace (ครอบ max request lifetime + pointer TTL + drain + margin);
    age parse ไม่ได้ → keep (safe); คืน list gid ที่ลบ"""
    now = time.time() if now is None else now
    ptr = _read_pointer(db) or {}
    keep = {ptr.get("generation_id"),
            (ptr.get("previous") or {}).get("generation_id")} - {None}
    removed: list[str] = []

    def _expired(gid: str) -> bool:
        if gid in keep:
            return False
        age = _gid_age_seconds(gid, now)
        return age is not None and age >= grace_seconds

    gen_root = Path(exports_root) / "gen"
    if gen_root.is_dir():
        for d in sorted(gen_root.iterdir()):
            if d.is_dir() and _expired(d.name):
                shutil.rmtree(d, ignore_errors=True)
                removed.append(d.name)
    for name in db.list_collection_names():
        m = _GEN_COLL_RE.match(name)
        if m and _expired(m.group(2)):
            db.drop_collection(name)
            if m.group(2) not in removed:
                removed.append(m.group(2))
    return removed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gen-dir", type=Path)
    ap.add_argument("--gid", default="")
    ap.add_argument("--expected", default="auto",
                    help="expected current gid | none (bootstrap) | auto")
    ap.add_argument("--rollback", action="store_true")
    ap.add_argument("--expected-active", default="")
    ap.add_argument("--require-description", action="store_true",
                    help="Phase 10B operator precondition: description_embeddings.npz ต้องมีและ valid ก่อน CAS")
    args = ap.parse_args()
    from chatbot.shopeechat.knowledge_base import _admin_db  # noqa: E402
    db = _admin_db()
    if args.rollback:
        res = rollback(db, args.expected_active)
        print(res)
        return 0 if res == "rolled_back" else 1
    expected = {"auto": "auto", "none": None}.get(args.expected, args.expected)
    res = publish(db, args.gen_dir, args.gid, expected_current=expected,
                  require_description=args.require_description)
    print(res)
    return 0 if res in ("published", "bootstrap") else 1


if __name__ == "__main__":
    sys.exit(main())
