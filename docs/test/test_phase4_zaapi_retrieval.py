"""Phase 4 Task 7: retrieval loaders — snapshot + artifact chain (fail closed)."""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "chatbot"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mongo_doubles import GenDb
from zaapi_phase4_helpers import record, stub_embed, write_gen_dir
from shopeechat import kb_zaapi_schema as schema
from shopeechat import kb_zaapi_retrieval as retr

GID = "g20261104-010203-abcdef12"
GEN_COLL = "zaapi_kb_embedding_generations"


def _gen_doc(tmp_path, gid=GID, recs=None, model=None):
    """Build real artifacts via helper → gen doc whose manifest hash is exact."""
    recs = recs if recs is not None else [record(item_id="I-1"),
                                          record(item_id="I-2")]
    gen_dir = write_gen_dir(tmp_path, gid, recs)
    manifest = json.loads((gen_dir / "manifest.json").read_bytes())
    m_entry = {"file": "manifest.json",
               "sha256": schema.fingerprint(""),  # replaced below
               "size_bytes": (gen_dir / "manifest.json").stat().st_size,
               "format": "json"}
    import hashlib
    m_entry["sha256"] = hashlib.sha256(
        (gen_dir / "manifest.json").read_bytes()).hexdigest()
    sources = {"zaapi_kb": {"revision_id": "rev:1", "record_count": len(recs)}}
    doc = {
        "_id": f"gen:{gid}", "generation_id": gid, "status": "ready",
        "created_at": "2026-11-04T01:02:03+00:00",
        "canonical_generation": schema.fingerprint(sources),
        "canonical_schema_revision": schema.SCHEMA_REVISION,
        "canonical_sources": sources,
        "record_set_digest": schema.fingerprint(
            sorted(r["record_id"] for r in recs)),
        "record_count": len(recs),
        "serialization": {"version": "semantic_text/v1"},
        "model": model or {
            "name": "BAAI/bge-m3",
            "revision": "5617a9f61b028005a4858fdac845db406aefb181",
            "sentence_transformers_version": "5.7.0", "dim": 1024,
            "normalize_embeddings": True, "output_dtype": "float32"},
        "artifacts": {"manifest": m_entry}}
    schema.validate_gen_doc(doc)
    return doc, manifest


def _replace(coll, doc):
    """Replace doc in GenColl's list store by _id."""
    coll._docs[:] = [d for d in coll._docs if d.get("_id") != doc["_id"]]
    coll._docs.append(doc)


def _db_with(tmp_path, gid=GID, **kw):
    doc, _ = _gen_doc(tmp_path, gid, **kw)
    db = GenDb()
    db[GEN_COLL].insert_one(doc)
    db[GEN_COLL].insert_one({
        "_id": "active", "revision": 1, "generation_id": gid,
        "previous_generation_id": None,
        "canonical_generation": doc["canonical_generation"],
        "activated_at": "2026-11-04T01:02:03+00:00"})
    return db


def test_self_containment(tmp_path):
    """§16.21: snapshot จาก artifacts เพียงอย่างเดียว — canonical colls ไม่มีใน db"""
    db = _db_with(tmp_path)
    snap = retr.load_active_generation(db, exports_root=tmp_path)
    assert snap is not None
    assert snap.generation_id == GID
    assert snap.vectors.shape == (2, 1024)
    assert snap.digests == tuple(sorted(snap.digests))
    assert set(snap.record_map) == set(snap.digests)
    assert set(snap.structured_index) == {
        "item_id", "model_id", "model_code", "alias",
        "subject_id", "target_id"}
    assert snap.model_compatible is True
    assert snap.record_count == 2
    assert len(snap.record_index) == 2   # record_id → (digest, projection)


def test_corruption_matrix(tmp_path):
    """§16.8/33: ทุก corruption → None (fail closed, ไม่ fallback gen อื่น)"""
    db = _db_with(tmp_path)
    assert retr.load_active_generation(db, exports_root=tmp_path) is not None

    coll = db[GEN_COLL]

    # pointer missing
    db2 = GenDb(); db2[GEN_COLL].insert_one(coll.find_one({"_id": "gen:"+GID}))
    assert retr.load_active_generation(db2, exports_root=tmp_path) is None
    # pointer invalid (missing field → validator reject)
    db3 = GenDb(); db3[GEN_COLL].insert_one(coll.find_one({"_id": "gen:"+GID}))
    db3[GEN_COLL].insert_one({"_id": "active", "revision": 1})
    assert retr.load_active_generation(db3, exports_root=tmp_path) is None
    # gen doc missing
    db4 = GenDb(); db4[GEN_COLL].insert_one(coll.find_one({"_id": "active"}))
    assert retr.load_active_generation(db4, exports_root=tmp_path) is None
    # gen doc corrupt (status != ready)
    doc = dict(coll.find_one({"_id": "gen:"+GID})); doc["status"] = "building"
    db5 = GenDb(); db5[GEN_COLL].insert_one(coll.find_one({"_id": "active"}))
    db5[GEN_COLL].insert_one(doc)
    assert retr.load_active_generation(db5, exports_root=tmp_path) is None


def test_artifact_corruption(tmp_path):
    """manifest/payload corruption → None"""
    db = _db_with(tmp_path)
    gen_dir = tmp_path / "zaapi_kb_gen" / GID

    # manifest hash mismatch (tamper bytes → sha256/size ไม่ตรง gen doc)
    (gen_dir / "manifest.json").write_bytes(b'{"schema_version":1,"x":1}')
    assert retr.load_active_generation(db, exports_root=tmp_path) is None

    # restore แล้ว corrupt payload sha (manifest ยังเก่า → bytes ต่าง)
    db = _db_with(tmp_path)
    z = np.load(gen_dir / "vectors.npz", allow_pickle=True)
    np.savez_compressed(gen_dir / "vectors.tmp.npz", digests=z["digests"],
                        embeddings=np.zeros((2, 1024), np.float32),
                        generation_id=np.array(GID))
    import os
    os.replace(gen_dir / "vectors.tmp.npz", gen_dir / "vectors.npz")
    assert retr.load_active_generation(db, exports_root=tmp_path) is None


def test_shape_count_corruption(tmp_path):
    """§11 ชั้น 3: shape/dim/count/dtype/cross-counts corrupt → None —
    manifest ต้อง regenerate ให้ผ่านชั้น 1–2 ก่อน แล้วค่อยเจอ payload ผิด"""
    db = _db_with(tmp_path)
    gen_dir = tmp_path / "zaapi_kb_gen" / GID
    # swap embeddings → wrong dim (64 แทน 1024) + regenerate manifest ให้ผ่าน hash gate
    z = np.load(gen_dir / "vectors.npz", allow_pickle=True)
    np.savez_compressed(gen_dir / "vectors.tmp.npz", digests=z["digests"],
                        embeddings=np.zeros((2, 64), np.float32),
                        generation_id=np.array(GID))
    import os
    os.replace(gen_dir / "vectors.tmp.npz", gen_dir / "vectors.npz")
    # rewrite manifest.json + gen doc artifacts hash เพื่อให้ payload load ได้
    # แล้ว shape mismatch ถูกจับที่ชั้น 3
    manifest = json.loads((gen_dir / "manifest.json").read_bytes())
    import hashlib
    raw = (gen_dir / "vectors.npz").read_bytes()
    manifest["vectors"]["sha256"] = hashlib.sha256(raw).hexdigest()
    manifest["vectors"]["size_bytes"] = len(raw)
    (gen_dir / "manifest.json").write_bytes(
        schema.canonical_json(manifest).encode())
    coll = db[GEN_COLL]
    doc = dict(coll.find_one({"_id": "gen:"+GID}))
    mraw = (gen_dir / "manifest.json").read_bytes()
    doc["artifacts"]["manifest"]["sha256"] = hashlib.sha256(mraw).hexdigest()
    doc["artifacts"]["manifest"]["size_bytes"] = len(mraw)
    _replace(coll, doc)
    assert retr.load_active_generation(db, exports_root=tmp_path) is None


def test_index_corruption(tmp_path):
    """§16.33: namespace นอก 6/ขาด/posting dup/unsorted → None"""
    db = _db_with(tmp_path)
    gen_dir = tmp_path / "zaapi_kb_gen" / GID
    import hashlib, os
    idx = json.loads((gen_dir / "structured_index.json").read_bytes())
    idx["bogus"] = {"x": ["y"]}
    payload = schema.canonical_json(idx).encode()
    (gen_dir / "structured_index.json").write_bytes(payload)
    manifest = json.loads((gen_dir / "manifest.json").read_bytes())
    manifest["structured_index"]["sha256"] = hashlib.sha256(payload).hexdigest()
    manifest["structured_index"]["size_bytes"] = len(payload)
    mraw = schema.canonical_json(manifest).encode()
    (gen_dir / "manifest.json").write_bytes(mraw)
    coll = db[GEN_COLL]
    doc = dict(coll.find_one({"_id": "gen:"+GID}))
    doc["artifacts"]["manifest"]["sha256"] = hashlib.sha256(mraw).hexdigest()
    doc["artifacts"]["manifest"]["size_bytes"] = len(mraw)
    _replace(coll, doc)
    assert retr.load_active_generation(db, exports_root=tmp_path) is None


def test_path_traversal(tmp_path):
    """§16.9: gid ที่ไม่ผ่าน GEN_ID_RE (../abs/foreign) → None"""
    db = _db_with(tmp_path)
    coll = db[GEN_COLL]
    pointer = coll.find_one({"_id": "active"})
    for bad in ("../escape", "/abs/path", "g20269999-999999-zzzzzzzz"):
        _replace(coll, {**pointer, "generation_id": bad})
        assert retr.load_active_generation(db, exports_root=tmp_path) is None
    _replace(coll, pointer)


def test_model_compat(tmp_path):
    """§16.34: runtime identity ≠ pin ทีละ field → snapshot โหลดแต่
    model_compatible=False (exact channel ยังใช้ได้)"""
    from shopeechat import embedding
    runtime = embedding.model_identity()
    for key in ("name", "revision", "sentence_transformers_version", "dim",
                "normalize_embeddings", "output_dtype"):
        model = dict(runtime)
        model[key] = (999 if key == "dim" else
                      not runtime[key] if key == "normalize_embeddings"
                      else "other")
        db = _db_with(tmp_path / str(key), model=model)
        snap = retr.load_active_generation(db, exports_root=tmp_path / str(key))
        assert snap is not None
        assert snap.model_compatible is False, key


def test_load_generation_snapshot_by_gid(tmp_path):
    db = _db_with(tmp_path)
    assert retr.load_generation_snapshot(db, GID,
                                         exports_root=tmp_path) is not None
    assert retr.load_generation_snapshot(db, "g20990101-000000-00000000",
                                         exports_root=tmp_path) is None
