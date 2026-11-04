"""kb_zaapi_generation — Phase 4 canonical-KB generation lifecycle owner เดียว.

Builders (pure, deterministic ตาม spec §2 hard contract):
- `semantic_text` — renderer เดียว (`semantic_text/v1` — labeled lines) ที่ใช้
  ทั้ง vector embedding และ evidence `payload.text` (ไม่มี renderer ที่สอง)
- `semantic_digest` — SHA-256 ของ semantic_text (vector identity เดียว —
  ไม่ใช่ content_fingerprint)
- `record_set_digest` — fingerprint(sorted record_ids) — pinned-set proof
- `build_record_map` — digest→{vector_index, text, records[projection]}
- `build_structured_index` — field-namespaced index 6 namespaces ปิดตาย
- `build_manifest_payload` — manifest.json object ตาม spec §10

Artifact writers — tmp → sha256/size verify → `os.replace`
(pattern จาก `build_embeddings._save_verified_npz`; `_sha256_file`
pattern-copy จาก `publish_generation` เพราะ module นั้นมี sys.path side effect)

Import DAG (locked): โมดูลนี้ import `kb_zaapi_schema` + `embedding` +
`knowledge_base` (lazy KbEvidenceResult) + `answer_context` เท่านั้น —
`kb_zaapi_retrieval` ห้าม import โมดูลนี้
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import numpy as np

from .kb_zaapi_schema import (canonical_delivery_scope, canonical_json,
                              fingerprint)

SERIALIZATION_VERSION = "semantic_text/v1"
STRUCTURED_INDEX_FIELDS = ("item_id", "model_id", "model_code", "alias",
                           "subject_id", "target_id")
_PROJECTION_FIELDS = ("record_id", "shop", "platform", "item_id", "model_id",
                      "subject_id", "target_id")
_LIST_FIELDS = {"model_code": "model_codes", "alias": "aliases"}


def semantic_text(record: dict) -> str:
    """Render deterministic plain text จาก canonical semantic payload
    (spec §7 — scope/provenance/readiness/record_id/timestamps ห้ามรวม)"""
    lines = [f"record_type: {record['record_type']}",
             f"topic: {record['topic']}"]
    for key in ("item_id", "model_id", "subject_id", "target_id"):
        if record.get(key) is not None:
            lines.append(f"{key}: {record[key]}")
    for value in record["model_codes"]:
        lines.append(f"model_code: {value}")
    for value in record["aliases"]:
        lines.append(f"alias: {value}")
    for fact in sorted(record["facts"], key=lambda x: x["key"]):
        lines.append(f"fact {fact['key']}: {canonical_json(fact['value'])}")
    for value in record["steps"]:
        lines.append(f"step: {value}")
    lines.append(f"answer_text: {record['answer_text']}")
    return "\n".join(lines)


def semantic_digest(record_or_text) -> str:
    """SHA-256 ของ rendered semantic_text — vector identity เดียว (spec §7)"""
    text = (record_or_text if isinstance(record_or_text, str)
            else semantic_text(record_or_text))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def record_set_digest(record_ids) -> str:
    """fingerprint(sorted record_ids) — pinned-set proof ใน gen doc (spec §11)"""
    return fingerprint(sorted(record_ids))


def build_record_map(records: list[dict], texts_by_digest: dict) -> dict:
    """digest → {vector_index (sorted-digest position), text, records[…sorted
    by record_id]} — projections 7 fields เท่านั้น; scope normalize ผ่าน
    `canonical_delivery_scope` (spec §10/§16.24)"""
    sorted_digests = sorted(texts_by_digest)
    out: dict[str, dict] = {}
    for rec in records:
        digest = semantic_digest(rec)
        shop, platform = canonical_delivery_scope(rec["shop"], rec["platform"])
        projection = {
            "record_id": rec["record_id"], "shop": shop, "platform": platform,
            "item_id": rec["item_id"], "model_id": rec["model_id"],
            "subject_id": rec["subject_id"], "target_id": rec["target_id"]}
        entry = out.setdefault(digest, {
            "vector_index": sorted_digests.index(digest),
            "text": texts_by_digest[digest], "records": []})
        entry["records"].append(projection)
    for entry in out.values():
        entry["records"].sort(key=lambda p: p["record_id"])
    return out


def build_structured_index(records: list[dict]) -> dict:
    """field-namespaced index — key set ปิดตาย 6 namespaces; value.strip(),
    skip empty-after-strip, postings sorted+unique record_ids (spec §10)"""
    index: dict[str, dict[str, set]] = {
        field: {} for field in STRUCTURED_INDEX_FIELDS}
    for rec in records:
        for field in STRUCTURED_INDEX_FIELDS:
            values = rec[_LIST_FIELDS[field]] if field in _LIST_FIELDS else (
                (rec[field],) if rec.get(field) is not None else ())
            for value in values:
                norm = value.strip()
                if norm:
                    index[field].setdefault(norm, set()).add(rec["record_id"])
    return {field: {value: sorted(ids) for value, ids in entries.items()}
            for field, entries in index.items()}


def build_manifest_payload(gid: str, roles: dict) -> dict:
    """manifest.json object ตาม spec §10 — ครอบ 3 payload roles เท่านั้น
    (ไม่มี self entry; `roles` = per-role metadata จาก `_write_artifact`)"""
    return {"schema_version": 1, "generation_id": gid,
            "vectors": roles["vectors"], "record_map": roles["record_map"],
            "structured_index": roles["structured_index"]}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_artifact(gen_dir: Path, name: str, payload) -> dict:
    """tmp → verify (reload/sha256+size) → `os.replace` —
    คืน `{file, sha256, size_bytes}` สำหรับ manifest role entry"""
    out = gen_dir / name
    tmp = out.parent / f"{out.stem}.tmp{out.suffix}"
    if isinstance(payload, dict):
        np.savez_compressed(tmp, **payload)
        with np.load(tmp, allow_pickle=True) as z:
            for key in payload:
                if key not in z.files:
                    tmp.unlink(missing_ok=True)
                    raise ValueError(f"npz key {key!r} missing after write")
    else:
        tmp.write_bytes(payload)
        if tmp.read_bytes() != payload:
            tmp.unlink(missing_ok=True)
            raise ValueError(f"artifact {name} bytes mismatch after write")
    sha, size = _sha256_file(tmp), tmp.stat().st_size
    os.replace(tmp, out)
    return {"file": name, "sha256": sha, "size_bytes": size}


# --- Task 9: build/validate orchestration (spec §13) ---

RECORDS_COLL = "zaapi_kb_records"
RAW_COLL = "zaapi_kb_raw_sources"
GEN_COLL = "zaapi_kb_embedding_generations"
MANIFEST_ID = "active:manifest"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def _model_pin() -> dict:
    """Immutable model identity pin — reject ก่อนเขียนอะไรเลยถ้า resolve/
    identity ไม่ใช่ immutable commit (spec §13)"""
    from . import embedding
    identity = embedding.model_identity()
    revision = identity.get("revision")
    if (not isinstance(identity, dict)
            or not isinstance(revision, str)
            or len(revision) != 40
            or any(c not in "0123456789abcdef" for c in revision)
            or identity.get("dim") != embedding.EMBEDDING_DIM
            or identity.get("normalize_embeddings") is not True
            or identity.get("output_dtype") != "float32"
            or not all(isinstance(identity.get(k), str) and identity.get(k)
                       for k in ("name", "sentence_transformers_version"))):
        raise ValueError("model identity not an immutable commit")
    return identity


def _exports_dir(exports_root, gid: str) -> Path:
    root = (Path(exports_root) if exports_root is not None
            else _repo_root() / "exports")
    return root / "zaapi_kb_gen" / gid


def build_generation(db, *, embed=None, exports_root=None, gid=None,
                     now=None) -> dict:
    """Canonical build orchestration (spec §13 Build):
    model identity pin → `load_active_state` → builders → tmp dir →
    `validate_generation` → atomic rename → insert ready doc.
    Failure ไม่แตะ pointer/doc — tmp dir orphan เท่านั้น"""
    identity = _model_pin()                       # reject ก่อนเขียนใด ๆ
    from .generation_pointer import mint_generation_id
    from .kb_zaapi_schema import (SCHEMA_REVISION, fingerprint,
                                load_active_state, validate_gen_doc)
    gid = gid or mint_generation_id(now)
    records_coll, raw_coll = db[RECORDS_COLL], db[RAW_COLL]
    manifest = records_coll.find_one({"_id": MANIFEST_ID})
    if manifest is None:
        raise ValueError("active manifest missing for canonical check")
    canonical_sources = manifest["sources"]       # validate_manifest ใน load
    records = load_active_state(records_coll, raw_coll, manifest)

    texts: dict = {}
    for rec in records:
        texts.setdefault(semantic_digest(rec), semantic_text(rec))
    digests = sorted(texts)
    embed = embed or _default_embed()
    vectors = embed([texts[d] for d in digests])
    import numpy as np
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.shape != (len(digests), 1024):
        raise ValueError("embeddings shape mismatch")

    tmp_dir = _exports_dir(exports_root, f".tmp-{gid}")
    final_dir = _exports_dir(exports_root, gid)
    if final_dir.exists():
        raise ValueError("generation dir already exists (immutable)")
    tmp_dir.mkdir(parents=True, exist_ok=False)

    roles = {}
    meta = _write_artifact(tmp_dir, "vectors.npz", {
        "digests": np.array(digests), "embeddings": vectors,
        "generation_id": np.array(gid)})
    roles["vectors"] = {**meta, "format": "npz", "row_count": len(digests),
                        "dim": int(vectors.shape[1]), "dtype": "float32"}
    record_map = build_record_map(records, texts)
    meta = _write_artifact(tmp_dir, "record_map.json",
                           canonical_json(record_map).encode("utf-8"))
    roles["record_map"] = {**meta, "format": "json",
                           "digest_count": len(record_map),
                           "record_count": len(records)}
    sindex = build_structured_index(records)
    meta = _write_artifact(tmp_dir, "structured_index.json",
                           canonical_json(sindex).encode("utf-8"))
    roles["structured_index"] = {
        **meta, "format": "json", "field_count": len(sindex),
        "key_count": sum(len(v) for v in sindex.values()),
        "posting_count": sum(len(i) for v in sindex.values()
                             for i in v.values())}
    manifest_payload = build_manifest_payload(gid, roles)
    manifest_meta = _write_artifact(
        tmp_dir, "manifest.json",
        canonical_json(manifest_payload).encode("utf-8"))

    from datetime import datetime, timezone
    created = (now if isinstance(now, datetime)
               else datetime.now(timezone.utc)).isoformat()
    gen_doc = {
        "_id": f"gen:{gid}", "generation_id": gid, "status": "ready",
        "created_at": created,
        "canonical_generation": fingerprint(canonical_sources),
        "canonical_schema_revision": SCHEMA_REVISION,
        "canonical_sources": canonical_sources,
        "record_set_digest": record_set_digest(
            rec["record_id"] for rec in records),
        "record_count": len(records),
        "serialization": {"version": SERIALIZATION_VERSION},
        "model": identity,
        "artifacts": {"manifest": {**manifest_meta, "format": "json"}}}
    validate_gen_doc(gen_doc)
    validate_generation(tmp_dir, gen_doc, db)
    tmp_dir.rename(final_dir)
    db[GEN_COLL].insert_one(gen_doc)
    return {"generation_id": gid, "record_count": len(records),
            "digest_count": len(digests)}


def _default_embed():
    from . import embedding
    return embedding.embed_texts


def validate_generation(gen_dir, gen_doc, db) -> dict:
    """Full generation validation gate (build/publish path — spec §13):
    closed gen doc → artifact chain → canonical pin cross-checks ผ่าน
    `load_active_state` (touch point #1 เท่านั้น) → summary dict"""
    from .kb_zaapi_schema import (fingerprint, load_active_state,
                                validate_gen_doc)
    from . import kb_zaapi_retrieval as retr
    gen_doc = validate_gen_doc(gen_doc)            # raises on invalid
    loaded = retr._load_artifacts(Path(gen_dir), gen_doc)
    if loaded is None:
        raise ValueError("generation artifact chain failed")
    records_coll, raw_coll = db[RECORDS_COLL], db[RAW_COLL]
    manifest = records_coll.find_one({"_id": MANIFEST_ID})
    if manifest is None:
        raise ValueError("active manifest missing for canonical check")
    if fingerprint(manifest["sources"]) != gen_doc["canonical_generation"]:
        raise ValueError("canonical_generation pin mismatch")
    docs = load_active_state(records_coll, raw_coll, manifest)
    pinned_ids = sorted(rec["record_id"] for rec in docs)
    map_ids = sorted(p["record_id"] for e in loaded["record_map"].values()
                     for p in e["records"])
    if (map_ids != pinned_ids
            or fingerprint(pinned_ids) != gen_doc["record_set_digest"]
            or len(pinned_ids) != gen_doc["record_count"]):
        raise ValueError("pinned record set drift")
    return {"generation_id": gen_doc["generation_id"],
            "record_count": gen_doc["record_count"],
            "digest_count": len(loaded["digests"])}


# --- Task 10: publish/rollback CAS + canary (spec §12/§13) — CAS +1 ที่นี่ ---

def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _cas_swap(db, *, expected_rev: int, expected_gid: str, new_gid: str,
              canonical_generation: str, now: str):
    """ABA-safe CAS — filter `{_id, revision:R, generation_id:OLD}`; matched=0
    → reread ครั้งเดียว → conflict:<actual>@rev<n> (ไม่มี retry loop)"""
    coll = db[GEN_COLL]
    res = coll.update_one(
        {"_id": "active", "revision": expected_rev,
         "generation_id": expected_gid},
        {"$set": {"revision": expected_rev + 1,
                  "generation_id": new_gid,
                  "previous_generation_id": expected_gid,
                  "canonical_generation": canonical_generation,
                  "activated_at": now}})
    if res.matched_count:
        return True
    actual = coll.find_one({"_id": "active"})
    if actual is None:
        return "conflict:no-pointer"
    return f"conflict:{actual['generation_id']}@rev{actual['revision']}"


def _resolve_and_cas(db, new_doc: dict, *, expected_rev=None,
                     expected_gid=None, now: str):
    """Bootstrap (find→validate→insert_only เท่านั้น) หรือ CAS owner
    เดียวสำหรับ publish/rollback (spec §12)"""
    from pymongo.errors import DuplicateKeyError
    from .kb_zaapi_schema import validate_gen_pointer
    coll = db[GEN_COLL]
    existing = coll.find_one({"_id": "active"})
    if existing is None:
        if expected_rev is not None or expected_gid is not None:
            return "conflict:no-pointer"
        try:
            coll.insert_one({
                "_id": "active", "revision": 1,
                "generation_id": new_doc["generation_id"],
                "previous_generation_id": None,
                "canonical_generation": new_doc["canonical_generation"],
                "activated_at": now})
        except DuplicateKeyError:
            actual = coll.find_one({"_id": "active"})
            return f"conflict:{actual['generation_id']}@rev{actual['revision']}"
        return True
    validate_gen_pointer(existing)          # corrupt → raise, bytes ไม่แก้
    rev = expected_rev if expected_rev is not None else existing["revision"]
    old = expected_gid if expected_gid is not None \
        else existing["generation_id"]
    return _cas_swap(db, expected_rev=rev, expected_gid=old,
                     new_gid=new_doc["generation_id"],
                     canonical_generation=new_doc["canonical_generation"],
                     now=now)


def _readback_ok(db, doc: dict) -> bool:
    from .kb_zaapi_schema import validate_gen_pointer
    try:
        pointer = db[GEN_COLL].find_one({"_id": "active"})
        validate_gen_pointer(pointer)
    except ValueError:
        return False
    return (pointer["generation_id"] == doc["generation_id"]
            and pointer["canonical_generation"]
            == doc["canonical_generation"])


def _run_canary(snapshot, cases):
    """canary gate — case `{name, query:{retrieve kwargs}, assert:{min_hits?,
    record_ids?, empty?}}`; คืน failing case name หรือ None"""
    from . import kb_zaapi_retrieval as retr
    for case in cases:
        res = retr.retrieve(snapshot, **case["query"])
        want = case.get("assert", {})
        hits = [ev for ev in res.supporting_evidence]
        fail = (want.get("empty") and hits
                or "min_hits" in want and len(hits) < want["min_hits"]
                or "record_ids" in want
                and want["record_ids"]
                != [h.get("item_id") for h in hits])
        if fail:
            return case.get("name", "?")
    return None


def publish(db, gid: str, *, canary_cases=(), exports_root=None,
            expected_rev=None, expected_gid=None) -> str:
    """Publish flow (spec §13): read+validate gen doc → full
    `validate_generation` → `expected_canonical` pre-check → canary →
    ABA-safe CAS → readback — คืน status string"""
    from .kb_zaapi_schema import validate_gen_doc
    coll = db[GEN_COLL]
    doc = coll.find_one({"_id": f"gen:{gid}"})
    if doc is None:
        return "reject:gen-doc-missing"
    try:
        validate_gen_doc(doc)
        validate_generation(_exports_dir(exports_root, gid), doc, db)
    except ValueError as exc:
        return f"reject:validate:{exc}"
    manifest = db[RECORDS_COLL].find_one({"_id": MANIFEST_ID})
    if (manifest is None
            or manifest.get("generation") != doc["canonical_generation"]):
        return "reject:canonical_drift"
    if canary_cases:
        from . import kb_zaapi_retrieval as retr
        snap = retr.load_generation_snapshot(db, gid,
                                             exports_root=exports_root)
        if snap is None:
            return "reject:snapshot-load"
        bad = _run_canary(snap, canary_cases)
        if bad is not None:
            return f"reject:canary:{bad}"
    result = _resolve_and_cas(db, doc, expected_rev=expected_rev,
                              expected_gid=expected_gid, now=_now_iso())
    if result is not True:
        return result
    if not _readback_ok(db, doc):
        return "readback_invalid"
    current = db[RECORDS_COLL].find_one({"_id": MANIFEST_ID})
    pending = (current is not None
               and current.get("generation") != doc["canonical_generation"])
    return "published" + ("+newer_canonical_pending" if pending else "")


def rollback(db, expected_gid: str, *, exports_root=None,
             expected_rev=None) -> str:
    """Rollback ผ่าน CAS owner เดียว (spec §13): validate previous gen doc +
    artifacts → CAS swap → readback"""
    from .kb_zaapi_schema import validate_gen_doc, validate_gen_pointer
    coll = db[GEN_COLL]
    pointer = coll.find_one({"_id": "active"})
    if pointer is None:
        return "conflict:no-pointer"
    validate_gen_pointer(pointer)            # corrupt → raise, ไม่แก้
    if expected_gid != pointer["generation_id"]:
        return (f"conflict:{pointer['generation_id']}"
                f"@rev{pointer['revision']}")
    prev_gid = pointer["previous_generation_id"]
    if prev_gid is None:
        return "conflict:no-previous"
    prev_doc = coll.find_one({"_id": f"gen:{prev_gid}"})
    if prev_doc is None:
        return "reject:prev-gen-doc-missing"
    try:
        validate_gen_doc(prev_doc)
        from . import kb_zaapi_retrieval as retr
        if retr._load_artifacts(_exports_dir(exports_root, prev_gid),
                                prev_doc) is None:
            return "reject:prev-artifacts"
    except ValueError as exc:
        return f"reject:prev-invalid:{exc}"
    result = _cas_swap(db,
                       expected_rev=(expected_rev if expected_rev is not None
                                     else pointer["revision"]),
                       expected_gid=expected_gid, new_gid=prev_gid,
                       canonical_generation=prev_doc["canonical_generation"],
                       now=_now_iso())
    if result is not True:
        return result
    if not _readback_ok(db, prev_doc):
        return "readback_invalid"
    return "rolled-back"
