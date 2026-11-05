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


# --- Task 8: retrieve() full query contract ---

def _snap(tmp_path, recs=None, model=None):
    """In-memory snapshot via real artifacts+loaders (no shortcuts)."""
    db = _db_with(tmp_path, recs=recs, model=model)
    snap = retr.load_active_generation(db, exports_root=tmp_path)
    assert snap is not None
    return snap


def test_query_validation_truth_table(tmp_path):
    """§16.28: malformed → ว่าง+trace (ห้าม raise); no input → no_query"""
    snap = _snap(tmp_path)
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-1",))
    assert len(r.supporting_evidence) == 1 and r.raw_count == 1
    # no-input → no_query
    r = retr.retrieve(snap, shop="ShopA", platform="shopee")
    assert r.supporting_evidence == () and "no_query" in r.trace
    # scope normalize แล้วว่าง → invalid_query
    for scope in [("  ", "shopee"), ("ShopA", "  "), ("", ""), (None, "shopee"),
                  ("ShopA", None)]:
        r = retr.retrieve(snap, shop=scope[0], platform=scope[1],
                          item_ids=("I-1",))
        assert r.supporting_evidence == () and "invalid_query" in r.trace
    # container ผิด type
    for bad in ({"item_ids": "I-1"}, {"item_ids": {"I-1"}},
                {"item_ids": 5}, {"model_ids": "M"}):
        r = retr.retrieve(snap, shop="ShopA", platform="shopee", **bad)
        assert r.supporting_evidence == () and "invalid_query" in r.trace
    # element ไม่ใช่ str / strip แล้วว่าง
    for bad in ({"item_ids": (5,)}, {"item_ids": (None,)},
                {"item_ids": ("  ",)}, {"item_ids": ("I-1", " ")}):
        r = retr.retrieve(snap, shop="ShopA", platform="shopee", **bad)
        assert r.supporting_evidence == () and "invalid_query" in r.trace
    # limit
    for bad in (True, 0, -1, 9, "8", 2.5):
        r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                          item_ids=("I-1",), limit=bad)
        assert r.supporting_evidence == () and "invalid_query" in r.trace
    # semantic_query type
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      semantic_query=5)
    assert "invalid_query" in r.trace


def test_whitespace_semantic(tmp_path, monkeypatch):
    """§16.29: "   " → no semantic channel (embed_query ไม่ถูกเรียก)"""
    snap = _snap(tmp_path)
    calls = []
    monkeypatch.setattr("shopeechat.embedding.embed_query",
                        lambda q: calls.append(q) or stub_embed([q])[0])
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-1",), semantic_query="   ")
    assert calls == []
    assert len(r.supporting_evidence) == 1   # typed hits ยังทำงาน


def test_duplicate_refs_noop(tmp_path):
    """§16.30: ("X","X") == ("X",) membership+order"""
    snap = _snap(tmp_path)
    a = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-1", "I-1"))
    b = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-1",))
    assert a.supporting_evidence == b.supporting_evidence


def test_exact_strip_and_namespaces(tmp_path):
    """§16.3,32: strip match; internal ws/case no match; per-ns isolation"""
    snap = _snap(tmp_path, recs=[
        record(item_id="ABC", model_id="M-9", model_codes=("X-1",)),
        record(aliases=("ABC",))])
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=(" ABC ",))
    assert len(r.supporting_evidence) == 1           # stripped match
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("A B C",))
    assert r.supporting_evidence == ()               # internal ws → no match
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("abc",))
    assert r.supporting_evidence == ()               # no casefold
    # "ABC" อยู่ item_id ของ rec1 และ alias ของ rec2 — item_ids channel เห็นเฉพาะ rec1
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("ABC",))
    assert len(r.supporting_evidence) == 1
    assert r.supporting_evidence[0]["item_id"] == "ABC"
    # alias channel เห็นเฉพาะ rec2
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      aliases=("ABC",))
    assert len(r.supporting_evidence) == 1
    assert r.supporting_evidence[0].get("item_id") is None


def test_scope_isolation(tmp_path):
    """§16.4,25: scope ต่างไม่ leak; shop case-sensitive; platform casefold"""
    snap = _snap(tmp_path, recs=[
        record(item_id="I-1"),
        record(item_id="I-1", shop="ShopB", platform="lazada")])
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-1",))
    assert len(r.supporting_evidence) == 1
    r = retr.retrieve(snap, shop="shopa", platform="shopee",
                      item_ids=("I-1",))
    assert r.supporting_evidence == ()               # shop case-sensitive
    r = retr.retrieve(snap, shop="ShopA", platform="SHOPEE",
                      item_ids=("I-1",))
    assert len(r.supporting_evidence) == 1           # platform casefold
    r = retr.retrieve(snap, shop=" ShopA ", platform=" Shopee ",
                      item_ids=("I-1",))
    assert len(r.supporting_evidence) == 1           # normalize scope


def test_merge_dedupe(tmp_path, monkeypatch):
    """§16.5: structured ก่อน semantic ตาม; dedupe record_id structured ชนะ"""
    recs = [record(item_id="I-1"), record(item_id="I-2")]
    snap = _snap(tmp_path, recs=recs)
    monkeypatch.setattr("shopeechat.embedding.embed_query",
                        lambda q: stub_embed(["x"])[0])
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-2",), semantic_query="x", limit=8)
    ev = r.supporting_evidence
    assert len(ev) == 2
    # structured hit (I-2) มาก่อน semantic hits
    assert ev[0]["item_id"] == "I-2"
    # I-1 มาจาก semantic channel — deterministic order


def test_semantic_unavailable(tmp_path, monkeypatch):
    """§16.6,7: model_compatible=False → exact ยังได้ + semantic_unavailable;
    semantic-only → ว่าง+trace; embed raise → เดียวกัน"""
    from shopeechat import embedding
    model = dict(embedding.model_identity()); model["dim"] = 999
    snap = _snap(tmp_path / "m", model=model)
    assert snap.model_compatible is False
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-1",), semantic_query="q")
    assert len(r.supporting_evidence) == 1           # exact ยังทำงาน
    assert "semantic_unavailable" in r.trace
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      semantic_query="q")
    assert r.supporting_evidence == () and "semantic_unavailable" in r.trace
    # embed raise → same fail-closed
    snap2 = _snap(tmp_path / "ok")
    monkeypatch.setattr("shopeechat.embedding.embed_query",
                        lambda q: (_ for _ in ()).throw(RuntimeError("x")))
    r = retr.retrieve(snap2, shop="ShopA", platform="shopee",
                      semantic_query="q")
    assert r.supporting_evidence == () and "semantic_unavailable" in r.trace


def test_scoped_ranking(tmp_path, monkeypatch):
    """§16.38: foreign top-scored ไม่กิน quota; shared digest → เฉพาะ local
    projections; limit หลัง merge"""
    foreign = [record(item_id="I-1", shop="Foreign", platform="shopee")
               for _ in range(3)]
    # ให้ foreign vectors score สูงสุด — สร้าง semantic เดียวกันหมด? ต่าง item_id
    foreign = [record(item_id=f"F-{i}", shop="Foreign", platform="shopee")
               for i in range(3)]
    local = [record(item_id="L-1")]
    snap = _snap(tmp_path, recs=foreign + local)
    # embed: query ใกล้ทุก vector เท่ากัน → score tie → record_id asc
    monkeypatch.setattr("shopeechat.embedding.embed_query",
                        lambda q: stub_embed(["seed"])[0])
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      semantic_query="q", limit=2)
    # foreign ไม่เข้า result เลย — scope filter ก่อน rank/limit
    assert len(r.supporting_evidence) == 1
    assert r.supporting_evidence[0]["item_id"] == "L-1"
    # shared digest local+foreign → เฉพาะ local projection
    shared = [record(item_id="S-1"),
              record(item_id="S-1", shop="Foreign")]
    snap2 = _snap(tmp_path / "s", recs=shared)
    monkeypatch.setattr("shopeechat.embedding.embed_query",
                        lambda q: stub_embed(["seed2"])[0])
    r = retr.retrieve(snap2, shop="ShopA", platform="shopee",
                      semantic_query="q", limit=8)
    assert len(r.supporting_evidence) == 1
    assert r.supporting_evidence[0]["item_id"] == "S-1"


def test_materialization_and_closed_record(tmp_path):
    """§16.22,23,17: payload.text verbatim digest text; identity precedence
    subject→model; omit empty; kind=="kb_zaapi" + typed meta channel;
    ห้าม request_id/need_indices flat (request_id อยู่ใน meta)"""
    rec = record(item_id="I-1", subject_id="S-9", target_id="T-9",
                 answer_text="hello ans")
    snap = _snap(tmp_path, recs=[rec])
    r = retr.retrieve(snap, shop="ShopA", platform="shopee",
                      item_ids=("I-1",))
    ev = r.supporting_evidence[0]
    from shopeechat.kb_zaapi_generation import semantic_digest
    digest = semantic_digest(rec)
    assert ev["payload"]["text"] == snap.record_map[digest]["text"]
    assert ev["kind"] == "kb_zaapi"
    assert ev["item_id"] == "I-1"
    assert ev["identity"] == "S-9"          # subject_id precedence
    assert ev["target"] == "T-9"
    meta = ev["meta"]
    assert meta["record_type"] == "spec" and meta["readiness"] == "resolved"
    assert meta["record_id"] == rec["record_id"]
    assert meta["request_id"] == "ch:kb"
    assert meta["answer_text"] == "hello ans"
    assert "score" not in meta              # exact hit — no invented score
    for banned in ("request_id", "need_indices", "linked_candidate",
                   "subject_refs", "shop", "platform", "record_id",
                   "generation_id", "model_id"):
        assert banned not in ev             # typed fields live inside meta
    # model_id fallback เมื่อไม่มี subject
    rec2 = record(item_id="I-2", model_id="M-9")
    snap2 = _snap(tmp_path / "m2", recs=[rec2])
    r = retr.retrieve(snap2, shop="ShopA", platform="shopee",
                      item_ids=("I-2",))
    ev = r.supporting_evidence[0]
    assert ev["identity"] == "M-9"
    # ไม่มี identity refs เลย → omit
    rec3 = record()
    snap3 = _snap(tmp_path / "m3", recs=[rec3])
    r = retr.retrieve(snap3, shop="ShopA", platform="shopee",
                      model_codes=("CB-100",))
    ev = r.supporting_evidence[0]
    assert "item_id" not in ev and "identity" not in ev and "target" not in ev


def test_load_failure_trace(tmp_path):
    """§14 + end-to-end: load failures → ว่าง + generation_unavailable;
    snapshot ใช้ได้ → delegation identity"""
    from shopeechat.knowledge_base import KbEvidenceResult
    # pointer absent
    res = retr.retrieve_active(GenDb(), shop="ShopA", platform="shopee",
                               item_ids=("I-1",), exports_root=tmp_path)
    assert isinstance(res, KbEvidenceResult)
    assert res.supporting_evidence == () and res.raw_count == 0
    assert "generation_unavailable" in res.trace
    # snapshot ใช้ได้ → delegation เหมือน retrieve() เป๊ะ
    db = _db_with(tmp_path)
    res = retr.retrieve_active(db, shop="ShopA", platform="shopee",
                               item_ids=("I-1",), exports_root=tmp_path)
    snap = retr.load_active_generation(db, exports_root=tmp_path)
    direct = retr.retrieve(snap, shop="ShopA", platform="shopee",
                           item_ids=("I-1",))
    assert res.supporting_evidence == direct.supporting_evidence
