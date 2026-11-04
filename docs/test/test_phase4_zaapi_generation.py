"""Phase 4 Task 5: closed-schema validators — gen pointer / gen doc / artifact manifest."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "chatbot"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from zaapi_phase4_helpers import record, manifest_for, stub_embed
from shopeechat import kb_zaapi_schema as schema

GID = "g20261104-010203-abcdef12"
GID2 = "g20261105-010203-abcdef12"


def _valid_pointer():
    return {
        "_id": "active",
        "revision": 1,
        "generation_id": GID,
        "previous_generation_id": None,
        "canonical_generation": "a" * 64,
        "activated_at": "2026-11-04T01:02:03+00:00",
    }


def _valid_gen_doc():
    sources = {"zaapi_kb": {"revision_id": "rev:1", "record_count": 2}}
    return {
        "_id": f"gen:{GID}",
        "generation_id": GID,
        "status": "ready",
        "created_at": "2026-11-04T01:02:03+00:00",
        "canonical_generation": schema.fingerprint(sources),
        "canonical_schema_revision": schema.SCHEMA_REVISION,
        "canonical_sources": sources,
        "record_set_digest": "b" * 64,
        "record_count": 2,
        "serialization": {"version": "semantic_text/v1"},
        "model": {
            "name": "BAAI/bge-m3",
            "revision": "5617a9f61b028005a4858fdac845db406aefb181",
            "sentence_transformers_version": "5.7.0",
            "dim": 1024,
            "normalize_embeddings": True,
            "output_dtype": "float32",
        },
        "artifacts": {
            "manifest": {"file": "manifest.json", "sha256": "c" * 64,
                         "size_bytes": 10, "format": "json"},
        },
    }


def _valid_manifest():
    return {
        "schema_version": 1,
        "generation_id": GID,
        "vectors": {"file": "vectors.npz", "sha256": "d" * 64, "size_bytes": 10,
                    "format": "npz", "row_count": 2, "dim": 1024,
                    "dtype": "float32"},
        "record_map": {"file": "record_map.json", "sha256": "e" * 64,
                       "size_bytes": 10, "format": "json", "digest_count": 2,
                       "record_count": 2},
        "structured_index": {"file": "structured_index.json", "sha256": "f" * 64,
                             "size_bytes": 10, "format": "json", "field_count": 6,
                             "key_count": 3, "posting_count": 4},
    }


def test_validate_gen_pointer_truth_table():
    ok = _valid_pointer()
    assert schema.validate_gen_pointer(ok) is ok
    assert schema.validate_gen_pointer(
        {**ok, "previous_generation_id": GID2})["previous_generation_id"] == GID2

    bad = [
        {**{k: v for k, v in ok.items() if k != "revision"}},          # missing
        {**ok, "extra": 1},                                            # extra
        {**ok, "_id": "other"},                                        # wrong _id
        {**ok, "revision": True},                                      # bool
        {**ok, "revision": 0},                                         # <1
        {**ok, "generation_id": "bad"},                                # GEN_ID_RE
        {**ok, "previous_generation_id": 5},                           # bad type
        {**ok, "previous_generation_id": "bad"},                       # bad gid
        {**ok, "canonical_generation": "A" * 64},                      # uppercase
        {**ok, "canonical_generation": "a" * 63},                      # bad len
        {**ok, "activated_at": ""},                                    # empty
        {**ok, "activated_at": "2026-11-04 01:02:03"},                 # malformed
        {**ok, "activated_at": "2026-11-04T01:02:03"},                 # naive
        {**ok, "activated_at": "2026-11-04T01:02:03+07:00"},           # non-UTC
    ]
    for doc in bad:
        with pytest.raises(ValueError):
            schema.validate_gen_pointer(doc)
    with pytest.raises(ValueError):
        schema.validate_gen_pointer("not a dict")


def test_validate_gen_doc_truth_table():
    ok = _valid_gen_doc()
    assert schema.validate_gen_doc(ok) is ok

    bad = [
        {**{k: v for k, v in ok.items() if k != "model"}},             # missing
        {**ok, "extra": 1},                                            # extra
        {**ok, "_id": "gen:other"},                                    # _id != gen:<gid>
        {**ok, "generation_id": "bad"},                                # GEN_ID_RE
        {**ok, "status": "building"},                                  # != ready
        {**ok, "canonical_generation": "a" * 64},                      # != fingerprint(sources)
        {**ok, "canonical_schema_revision": schema.SCHEMA_REVISION + 1},
        {**ok, "canonical_sources": "not a dict"},
        {**ok, "record_set_digest": "B" * 64},                         # uppercase
        {**ok, "record_count": True},                                  # bool
        {**ok, "record_count": -1},
        {**ok, "serialization": {"version": "other"}},
        {**ok, "model": {**ok["model"], "extra": 1}},                  # model extra
        {**ok, "model": {k: v for k, v in ok["model"].items()
                         if k != "dim"}},                              # model missing
        {**ok, "model": {**ok["model"], "dim": "1024"}},
        {**ok, "model": {**ok["model"], "normalize_embeddings": "yes"}},
        {**ok, "artifacts": {}},                                       # missing manifest
        {**ok, "artifacts": {"manifest": {"file": "manifest.json"}}},  # incomplete
        {**ok, "artifacts": {"manifest": {**ok["artifacts"]["manifest"],
                                        "sha256": "z" * 64}}},         # non-hex
    ]
    for doc in bad:
        with pytest.raises(ValueError):
            schema.validate_gen_doc(doc)
    with pytest.raises(ValueError):
        schema.validate_gen_doc([])


def test_validate_artifact_manifest_truth_table():
    ok = _valid_manifest()
    assert schema.validate_artifact_manifest(ok) is ok

    bad = [
        {**{k: v for k, v in ok.items() if k != "vectors"}},           # missing role
        {**ok, "manifest": {}},                                        # extra role (self-ref)
        {**ok, "schema_version": True},
        {**ok, "schema_version": 2},
        {**ok, "generation_id": "bad"},
        {**ok, "vectors": {**ok["vectors"], "file": "vec.npz"}},       # wrong file
        {**ok, "vectors": {**ok["vectors"], "sha256": "D" * 64}},      # uppercase
        {**ok, "vectors": {**ok["vectors"], "size_bytes": -1}},
        {**ok, "vectors": {**ok["vectors"], "row_count": 1.5}},        # non-int
        {**ok, "vectors": {**ok["vectors"], "extra": 1}},              # extra key
        {**ok, "vectors": {k: v for k, v in ok["vectors"].items()
                           if k != "dim"}},                            # missing key
        {**ok, "record_map": {**ok["record_map"], "digest_count": -1}},
        {**ok, "structured_index": {**ok["structured_index"],
                                   "field_count": 5}},                 # != 6
    ]
    for doc in bad:
        with pytest.raises(ValueError):
            schema.validate_artifact_manifest(doc)
    with pytest.raises(ValueError):
        schema.validate_artifact_manifest(None)


def test_validators_round_trip_with_helpers():
    """Executable wiring: helper-built canonical state feeds a coherent gen doc."""
    recs = [record(item_id="i1"), record(item_id="i2")]
    manifest = manifest_for({"zaapi_kb": recs})
    doc = _valid_gen_doc()
    doc["canonical_sources"] = manifest["manifest"]["sources"]
    doc["canonical_generation"] = schema.fingerprint(doc["canonical_sources"])
    doc["record_count"] = len(recs)
    assert schema.validate_gen_doc(doc) is doc


# --- Task 6: kb_zaapi_generation builders + artifact writers ---

def _import_gen():
    from shopeechat import kb_zaapi_generation as gen
    return gen


def test_semantic_text_determinism():
    """spec §16.1: record เดียวกัน → bytes เดียวกัน; field order คงที่"""
    gen = _import_gen()
    r = record(item_id="I-1", model_id="M-1", model_codes=("CB-100", "CB-200"),
               aliases=("charger",), facts=({"key": "v", "value": ["a", "b"]},
                                            {"key": "w", "value": 5}),
               steps=("s1", "s2"), answer_text="ans")
    t1, t2 = gen.semantic_text(r), gen.semantic_text(r)
    assert t1 == t2
    lines = t1.split("\n")
    assert lines[0] == "record_type: spec"
    assert lines[1] == "topic: t"
    assert lines[2] == "item_id: I-1"      # identity refs ลำดับคงที่
    assert lines[3] == "model_id: M-1"
    assert lines.index("model_code: CB-100") < lines.index("model_code: CB-200")
    assert lines.index("fact v: [\"a\",\"b\"]") < lines.index("fact w: 5")  # sorted key
    assert lines.index("step: s1") < lines.index("step: s2")
    assert lines[-1] == "answer_text: ans"
    for banned in ("ShopA", "shopee", "src-1", "sfp-1", "record_id"):
        assert banned not in t1            # scope/provenance ห้ามรวม


def test_semantic_digest_truth_table():
    """spec §16.2/§7: same/scope-only/provenance-only → เดียวกัน;
    identity/facts/steps/list-order/extract-diff → ต่างกัน"""
    gen = _import_gen()
    base = record(item_id="I-1")
    assert gen.semantic_digest(base) == gen.semantic_digest(dict(base))
    assert gen.semantic_digest(base) == gen.semantic_digest(
        gen.semantic_text(base))           # accepts text
    assert gen.semantic_digest(base) == gen.semantic_digest(
        record(item_id="I-1", shop="OtherShop", platform="lazada"))
    assert gen.semantic_digest(base) == gen.semantic_digest(
        record(item_id="I-1", source_fingerprint="other", row=99))
    for over in ({"item_id": "I-2"}, {"model_id": "M-9"},
                 {"facts": ({"key": "v", "value": "x"},)},
                 {"steps": ("other",)}, {"answer_text": "other"},
                 {"facts": ({"key": "v", "value": ["b", "a"]},)},
                 {"record_type": "faq"}):
        over.setdefault("topic", "t")
        assert gen.semantic_digest(base) != gen.semantic_digest(record(**over))


def test_record_set_digest_ordered():
    gen = _import_gen()
    ids = ["b" * 64, "a" * 64, "c" * 64]
    assert gen.record_set_digest(ids) == gen.record_set_digest(ids[::-1])
    assert gen.record_set_digest(ids) != gen.record_set_digest(ids[:2])


def test_record_map_self_contained():
    """spec §16.24: text ครั้งเดียวต่อ digest; sorted by record_id;
    projections 7 fields; scope normalize ผ่าน canonical_delivery_scope"""
    gen = _import_gen()
    r1, r2 = record(item_id="I-1", shop="  Shop  A "), record(item_id="I-1")
    r3 = record(item_id="I-2")
    texts = {}
    for r in (r1, r2, r3):
        texts.setdefault(gen.semantic_digest(r), gen.semantic_text(r))
    rm = gen.build_record_map([r1, r2, r3], texts)
    d_shared = gen.semantic_digest(r1)
    assert set(rm) == {d_shared, gen.semantic_digest(r3)}
    entry = rm[d_shared]
    assert entry["text"] == gen.semantic_text(r1)      # text once
    assert entry["vector_index"] == sorted(texts).index(d_shared)
    ids = [p["record_id"] for p in entry["records"]]
    assert ids == sorted(ids) and len(ids) == 2        # sorted, dedup-free
    for p in entry["records"]:
        assert set(p) == {"record_id", "shop", "platform", "item_id",
                          "model_id", "subject_id", "target_id"}
    shops = {p["shop"] for p in entry["records"]}
    assert shops == {"Shop A", "ShopA"}                # normalized ผ่าน owner
    plats = {p["platform"] for p in entry["records"]}
    assert plats == {"shopee"}


def test_structured_index_namespaces():
    """spec §16.32/33: 6 namespaces; strip; postings sorted+unique;
    empty-after-strip skipped (unreachable); cross-field ไม่ชน"""
    gen = _import_gen()
    # NB: empty-after-strip values ถูก canonical_record_id reject ก่อนถึง builder
    # (schema requires _nonempty_str) — builder skip เป็น defense-in-depth เท่านั้น
    rec = record(item_id=" ABC ", model_id="M-1", subject_id="S-1",
                 target_id="T-1", model_codes=(" ABC ", "CB-1"),
                 aliases=(" ABC ",))
    idx = gen.build_structured_index([rec])
    assert set(idx) == {"item_id", "model_id", "model_code", "alias",
                        "subject_id", "target_id"}
    rid = rec["record_id"]
    assert idx["item_id"]["ABC"] == [rid]              # stripped
    assert idx["model_code"]["ABC"] == [rid]
    assert idx["alias"]["ABC"] == [rid]
    # cross-field ไม่ชน — namespace อื่นไม่มี "ABC"
    assert "ABC" not in idx["subject_id"] and "ABC" not in idx["target_id"]
    r2 = record(item_id="ABC")                         # same ns same value
    idx2 = gen.build_structured_index([rec, r2])
    assert idx2["item_id"]["ABC"] == sorted({rec["record_id"],
                                           r2["record_id"]})  # sorted+unique


def test_manifest_deterministic():
    """spec §16.27/36: rebuild → bytes เดียวกัน; 3 roles เท่านั้น ไม่มี self entry"""
    gen = _import_gen()
    roles = {"vectors": {"file": "vectors.npz", "sha256": "a" * 64,
                         "size_bytes": 1, "format": "npz", "row_count": 1,
                         "dim": 1024, "dtype": "float32"},
             "record_map": {"file": "record_map.json", "sha256": "b" * 64,
                            "size_bytes": 1, "format": "json", "digest_count": 1,
                            "record_count": 1},
             "structured_index": {"file": "structured_index.json",
                                  "sha256": "c" * 64, "size_bytes": 1,
                                  "format": "json", "field_count": 6,
                                  "key_count": 1, "posting_count": 1}}
    m1 = gen.build_manifest_payload(GID, roles)
    m2 = gen.build_manifest_payload(GID, roles)
    assert schema.canonical_json(m1) == schema.canonical_json(m2)
    assert schema.validate_artifact_manifest(m1) is m1  # chain กับ T5
    assert "manifest" not in m1


def test_reproducibility_boundary(tmp_path):
    """spec §16.26: builders ทั้งชุดบน input เดียวกัน → outputs เท่ากันเป๊ะ"""
    gen = _import_gen()
    recs = [record(item_id="I-1"), record(item_id="I-2", model_codes=("X",))]
    texts = {gen.semantic_digest(r): gen.semantic_text(r) for r in recs}
    out1 = (gen.build_record_map(recs, texts),
            gen.build_structured_index(recs),
            gen.record_set_digest([r["record_id"] for r in recs]))
    out2 = (gen.build_record_map(recs, texts),
            gen.build_structured_index(recs),
            gen.record_set_digest([r["record_id"] for r in recs]))
    assert schema.canonical_json(out1) == schema.canonical_json(out2)


def test_write_artifact_atomic(tmp_path):
    """writer: tmp → sha256/size verify → os.replace; metadata คืนสำหรับ manifest"""
    gen = _import_gen()
    meta = gen._write_artifact(tmp_path, "record_map.json",
                               schema.canonical_json({"a": 1}).encode("utf-8"))
    assert (tmp_path / "record_map.json").exists()
    assert meta["file"] == "record_map.json" and meta["size_bytes"] > 0
    import hashlib
    assert meta["sha256"] == hashlib.sha256(
        (tmp_path / "record_map.json").read_bytes()).hexdigest()
    assert not list(tmp_path.glob("*.tmp*"))           # tmp cleaned


def test_write_gen_dir_helper(tmp_path):
    """helper write_gen_dir: records+gid+stub embed → 4 artifact files +
    manifest ผ่าน validator; vectors row order = sorted digests"""
    from zaapi_phase4_helpers import write_gen_dir
    recs = [record(item_id="I-2"), record(item_id="I-1")]
    gen_dir = write_gen_dir(tmp_path, GID, recs)
    for name in ("vectors.npz", "record_map.json",
                 "structured_index.json", "manifest.json"):
        assert (gen_dir / name).exists(), name
    import json
    manifest = json.loads((gen_dir / "manifest.json").read_text())
    schema.validate_artifact_manifest(manifest)
    assert manifest["generation_id"] == GID
    assert manifest["vectors"]["row_count"] == manifest["record_map"]["digest_count"]
    import numpy as np
    z = np.load(gen_dir / "vectors.npz", allow_pickle=True)
    digests = [str(d) for d in z["digests"]]
    assert digests == sorted(digests)                  # sorted digest order
    assert z["embeddings"].shape == (2, 1024)


# --- Task 9: validate_generation + build_generation orchestration ---

def _seeded_db(tmp_path, specs=({"item_id": "I-1"}, {"item_id": "I-2"})):
    from mongo_doubles import GenDb
    from zaapi_phase4_helpers import seed_canonical_state
    db = GenDb()
    recs, manifest = seed_canonical_state(db, specs)
    return db, recs, manifest


def test_build_happy_path(tmp_path):
    """GenDb canonical state + stub_embed → build → gen dir 4 artifacts +
    ready gen doc §11 fields; pointer ไม่แตะ (ไม่มี active doc)"""
    gen = _import_gen()
    db, recs, _ = _seeded_db(tmp_path)
    out = gen.build_generation(db, embed=stub_embed, exports_root=tmp_path,
                               gid=GID)
    assert out["generation_id"] == GID and out["record_count"] == 2
    assert out["digest_count"] == 2
    gen_dir = tmp_path / "zaapi_kb_gen" / GID
    for name in ("vectors.npz", "record_map.json", "structured_index.json",
                 "manifest.json"):
        assert (gen_dir / name).is_file(), name
    doc = db["zaapi_kb_embedding_generations"].find_one({"_id": f"gen:{GID}"})
    assert doc is not None and doc["status"] == "ready"
    assert doc["record_count"] == 2 and doc["_id"] == f"gen:{GID}"
    schema.validate_gen_doc(doc)
    assert db["zaapi_kb_embedding_generations"].find_one(
        {"_id": "active"}) is None               # pointer ไม่แตะ


def test_build_determinism(tmp_path):
    """§16.26 build-side: input เดียวกัน gid ต่าง → digests/record_map/
    structured_index/record_set_digest เท่ากันเป๊ะ"""
    gen = _import_gen()
    db, recs, _ = _seeded_db(tmp_path)
    g1 = "g20261104-010203-abcdef12"; g2 = "g20261105-010203-abcdef12"
    gen.build_generation(db, embed=stub_embed, exports_root=tmp_path, gid=g1)
    gen.build_generation(db, embed=stub_embed, exports_root=tmp_path, gid=g2)
    import json
    def payload(g, name):
        return json.loads(
            (tmp_path / "zaapi_kb_gen" / g / name).read_text())
    assert payload(g1, "record_map.json") == payload(g2, "record_map.json")
    assert payload(g1, "structured_index.json") == \
        payload(g2, "structured_index.json")
    d1 = db["zaapi_kb_embedding_generations"].find_one({"_id": f"gen:{g1}"})
    d2 = db["zaapi_kb_embedding_generations"].find_one({"_id": f"gen:{g2}"})
    assert d1["record_set_digest"] == d2["record_set_digest"]
    assert d1["canonical_generation"] == d2["canonical_generation"]


def test_build_failure_no_side_effects(tmp_path):
    """§14 build crash: embed raise → raise; ไม่มี gen doc; pointer ไม่เปลี่ยน;
    tmp dir orphan เท่านั้น"""
    gen = _import_gen()
    db, recs, _ = _seeded_db(tmp_path)
    def boom(texts, **kw):
        raise RuntimeError("embed down")
    import pytest as _pt
    with _pt.raises(RuntimeError):
        gen.build_generation(db, embed=boom, exports_root=tmp_path, gid=GID)
    assert db["zaapi_kb_embedding_generations"].find_one(
        {"_id": f"gen:{GID}"}) is None
    assert db["zaapi_kb_embedding_generations"].find_one(
        {"_id": "active"}) is None
    assert not (tmp_path / "zaapi_kb_gen" / GID).exists()   # ไม่มี final dir


def test_model_unresolvable_reject(tmp_path, monkeypatch):
    """§16.34 build-side: model identity resolve ไม่ได้/invalid → reject
    ก่อนเขียน artifact/doc ใด ๆ"""
    gen = _import_gen()
    db, recs, _ = _seeded_db(tmp_path)
    monkeypatch.setattr("shopeechat.embedding.model_identity",
                        lambda: {"name": "BAAI/bge-m3", "revision": "refs/main",
                                 "sentence_transformers_version": "5.7.0",
                                 "dim": 1024, "normalize_embeddings": True,
                                 "output_dtype": "float32"})
    import pytest as _pt
    with _pt.raises(ValueError):
        gen.build_generation(db, embed=stub_embed, exports_root=tmp_path,
                             gid=GID)
    assert db["zaapi_kb_embedding_generations"].find_one(
        {"_id": f"gen:{GID}"}) is None
    assert not (tmp_path / "zaapi_kb_gen" / GID).exists()
    monkeypatch.setattr("shopeechat.embedding.model_identity",
                        lambda: (_ for _ in ()).throw(
                            RuntimeError("no ST")))
    with _pt.raises(RuntimeError):
        gen.build_generation(db, embed=stub_embed, exports_root=tmp_path,
                             gid=GID)
    assert not (tmp_path / "zaapi_kb_gen" / GID).exists()


def test_canonical_pin_validation(tmp_path):
    """§16.8/16.10: pinned-record drift / canonical pin mismatch →
    validate_generation reject"""
    gen = _import_gen()
    db, recs, _ = _seeded_db(tmp_path)
    gen.build_generation(db, embed=stub_embed, exports_root=tmp_path, gid=GID)
    gen_dir = tmp_path / "zaapi_kb_gen" / GID
    coll = db["zaapi_kb_embedding_generations"]
    doc = dict(coll.find_one({"_id": f"gen:{GID}"}))
    # canonical_generation != fingerprint(canonical_sources) → gen_doc reject
    bad = dict(doc); bad["canonical_generation"] = "a" * 64
    import pytest as _pt
    with _pt.raises(ValueError):
        gen.validate_generation(gen_dir, bad, db)
    # record_set_digest mismatch → reject
    bad = dict(doc); bad["record_set_digest"] = "b" * 64
    with _pt.raises(ValueError):
        gen.validate_generation(gen_dir, bad, db)
    # record_count mismatch → reject
    bad = dict(doc); bad["record_count"] = 99
    with _pt.raises(ValueError):
        gen.validate_generation(gen_dir, bad, db)
    # happy path — valid doc ผ่าน (ก่อน tamper)
    assert gen.validate_generation(gen_dir, doc, db)["generation_id"] == GID
    # pinned-record drift — tamper a record doc แล้ว re-validate → reject
    tampered = dict(db["zaapi_kb_records"].find_one(
        {"_id": recs[0]["record_id"]}))
    tampered["answer_text"] = "tampered"
    rec_coll = db["zaapi_kb_records"]
    rec_coll._docs[:] = [d for d in rec_coll._docs
                         if d.get("_id") != tampered["_id"]]
    rec_coll._docs.append(tampered)
    with _pt.raises(ValueError):
        gen.validate_generation(gen_dir, doc, db)


# --- Task 10: publish/bootstrap CAS + rollback + thin CLI ---

def _built_db(tmp_path, specs=({"item_id": "I-1"}, {"item_id": "I-2"}),
              gid=GID):
    gen = _import_gen()
    db, recs, _ = _seeded_db(tmp_path, specs)
    gen.build_generation(db, embed=stub_embed, exports_root=tmp_path, gid=gid)
    return db


def _pointer(db):
    return db["zaapi_kb_embedding_generations"].find_one({"_id": "active"})


def test_bootstrap_insert_only(tmp_path):
    """§16.35: absent→insert rev1 prev None; concurrent→1 ชนะ conflict;
    existing invalid→fail closed bytes ไม่แก้; ไม่มี upsert"""
    gen = _import_gen()
    db = _built_db(tmp_path)
    out = gen.publish(db, GID, exports_root=tmp_path)
    p = _pointer(db)
    assert out == "published"
    assert p["revision"] == 1 and p["generation_id"] == GID
    assert p["previous_generation_id"] is None
    schema.validate_gen_pointer(p)
    # concurrent bootstrap — insert dup → conflict
    db2 = _built_db(tmp_path / "c")
    coll = db2["zaapi_kb_embedding_generations"]
    p1 = {"_id": "active", "revision": 1, "generation_id": "g20261201-000000-aaaaaaa1",
          "previous_generation_id": None, "canonical_generation": "a" * 64,
          "activated_at": "2026-12-01T00:00:00+00:00"}
    coll.insert_one(p1)
    # existing valid pointer → normal CAS (rev+1, prev=old gid)
    out = gen.publish(db2, GID, exports_root=tmp_path / "c")
    assert out == "published"
    p2 = db2["zaapi_kb_embedding_generations"].find_one({"_id": "active"})
    assert p2["revision"] == 2
    assert p2["previous_generation_id"] == p1["generation_id"]
    # concurrent bootstrap — insert_one แพ้ race → DuplicateKey → conflict
    from pymongo.errors import DuplicateKeyError
    db3 = _built_db(tmp_path / "c3")
    coll3 = db3["zaapi_kb_embedding_generations"]
    def _loser(doc, *a, **k):
        coll3._docs.append({**p1})
        raise DuplicateKeyError("dup _id active")
    coll3.insert_one = _loser
    doc3 = coll3.find_one({"_id": "gen:" + GID})
    out = gen._resolve_and_cas(db3, doc3,
                               now="2026-12-01T00:00:00+00:00")
    assert out.startswith("conflict")
    # existing invalid pointer → fail closed, bytes ไม่แก้
    for bad in ({"_id": "active", "generation_id": GID},          # ขาด revision
                {"_id": "active", "revision": 1},                 # ขาด gid
                {"_id": "active", "revision": 1, "generation_id": GID,
                 "previous_generation_id": None,
                 "canonical_generation": "a" * 64,
                 "activated_at": "2026-12-01T00:00:00+00:00",
                 "extra": 1}):                                    # extra field
        coll._docs[:] = [d for d in coll._docs if d.get("_id") != "active"]
        coll.insert_one(bad)
        before = [dict(d) for d in coll._docs]
        try:
            gen.publish(db2, GID, exports_root=tmp_path / "c")
            raised = False
        except ValueError:
            raised = True
        assert raised
        assert coll._docs == before                     # bytes เดิมไม่แก้
    import inspect
    assert "upsert" not in inspect.getsource(gen._resolve_and_cas)


def test_cas_stale_writer_and_aba(tmp_path):
    """§16.11/12: stale expected → matched=0 → conflict:<actual>@rev<n>;
    A→B→A race → revision fence จับได้"""
    gen = _import_gen()
    db = _built_db(tmp_path)
    g2 = "g20261105-010203-abcdef12"
    _built_db(tmp_path, gid=g2)   # build ก่อน — ใช้ db เดียวกันไม่ได้; rebuild
    db, _, _ = _seeded_db(tmp_path / "x")
    gen.build_generation(db, embed=stub_embed, exports_root=tmp_path / "x",
                         gid=GID)
    gen.build_generation(db, embed=stub_embed, exports_root=tmp_path / "x",
                         gid=g2)
    assert gen.publish(db, GID, exports_root=tmp_path / "x") == "published"
    # stale writer — expected (rev0? no — publish again ด้วย gid เดิม expected stale)
    out = gen.publish(db, g2, exports_root=tmp_path / "x",
                      expected_rev=0)
    assert out.startswith("conflict")
    assert "@rev" in out
    # normal publish g2 → rev2, prev=GID
    out = gen.publish(db, g2, exports_root=tmp_path / "x")
    p = _pointer(db)
    assert out == "published"
    assert p["revision"] == 2 and p["generation_id"] == g2
    assert p["previous_generation_id"] == GID
    # ABA: tamper pointer back to gid A โดยไม่เพิ่ม rev → publish อื่นคิดว่า
    # expected (rev2, g2) — filter revision+gid: gid ต่าง → conflict
    out = gen.publish(db, GID, exports_root=tmp_path / "x",
                      expected_rev=2, expected_gid=GID)   # stale gid fence
    assert out.startswith("conflict")


def test_rollback(tmp_path):
    """§16.14: stale expected → conflict; success → prev active + fields ครบ;
    previous=None → conflict:no-previous"""
    gen = _import_gen()
    db, _, _ = _seeded_db(tmp_path / "r")
    g2 = "g20261105-010203-abcdef12"
    for g in (GID, g2):
        gen.build_generation(db, embed=stub_embed, exports_root=tmp_path / "r",
                             gid=g)
    gen.publish(db, GID, exports_root=tmp_path / "r")
    gen.publish(db, g2, exports_root=tmp_path / "r")
    out = gen.rollback(db, g2, exports_root=tmp_path / "r")
    p = _pointer(db)
    assert out == "rolled-back"
    assert p["generation_id"] == GID                 # prev กลับมา active
    assert p["previous_generation_id"] == g2
    assert p["revision"] == 3
    doc = db["zaapi_kb_embedding_generations"].find_one({"_id": f"gen:{GID}"})
    assert p["canonical_generation"] == doc["canonical_generation"]
    schema.validate_gen_pointer(p)
    # stale expected gid → conflict
    out = gen.rollback(db, "g20990101-000000-00000000",
                       exports_root=tmp_path / "r")
    assert out.startswith("conflict")
    # rollback อีกครั้ง → previous=g2 มีอยู่ → สำเร็จ; แต่ prev=None case:
    db2, _, _ = _seeded_db(tmp_path / "r2")
    gen.build_generation(db2, embed=stub_embed,
                         exports_root=tmp_path / "r2", gid=GID)
    gen.publish(db2, GID, exports_root=tmp_path / "r2")
    out = gen.rollback(db2, GID, exports_root=tmp_path / "r2")
    assert "conflict" in out or "no-previous" in out


def test_canonical_drift_and_canary(tmp_path):
    """§16.15 + canary: manifest drift ก่อน pre-check → reject; canary fail →
    reject ก่อน CAS; ผ่าน → published"""
    gen = _import_gen()
    db, recs, _ = _seeded_db(tmp_path)
    gen.build_generation(db, embed=stub_embed, exports_root=tmp_path, gid=GID)
    # drift: manifest generation เปลี่ยน → reject ก่อน CAS
    coll = db["zaapi_kb_records"]
    m = dict(coll.find_one({"_id": "active:manifest"}))
    m["generation"] = "f" * 64
    coll._docs[:] = [d for d in coll._docs if d.get("_id") != "active:manifest"]
    coll._docs.append(m)
    out = gen.publish(db, GID, exports_root=tmp_path)
    assert out.startswith("reject") or "drift" in out
    assert _pointer(db) is None                        # CAS ไม่เกิด
    # restore + canary fail → reject
    db2, recs2, _ = _seeded_db(tmp_path / "d2")
    gen.build_generation(db2, embed=stub_embed, exports_root=tmp_path / "d2",
                         gid=GID)
    cases = [{"name": "c1", "query": {"shop": "ShopA", "platform": "shopee", "item_ids": ("MISS",)},
              "assert": {"min_hits": 1}}]
    out = gen.publish(db2, GID, exports_root=tmp_path / "d2",
                      canary_cases=cases)
    assert "reject" in out or "canary" in out
    assert _pointer(db2) is None
    cases = [{"name": "c2", "query": {"shop": "ShopA", "platform": "shopee", "item_ids": ("I-1",)},
              "assert": {"min_hits": 1}}]
    out = gen.publish(db2, GID, exports_root=tmp_path / "d2",
                      canary_cases=cases)
    assert out == "published"


def test_readback_invalid(tmp_path, monkeypatch):
    """§16.16: write สำเร็จแต่ readback ผิด → report ไม่ auto-rollback"""
    gen = _import_gen()
    db = _built_db(tmp_path)
    g2 = "g20261105-010203-abcdef12"
    _import_gen().build_generation(db, embed=stub_embed,
                                   exports_root=tmp_path, gid=g2)
    assert gen.publish(db, GID, exports_root=tmp_path) == "published"
    coll = db["zaapi_kb_embedding_generations"]
    orig_update = coll.update_one
    def poisoned(filt, update, *a, **k):
        res = orig_update(filt, update, *a, **k)
        if filt.get("_id") == "active" and res.matched_count:
            for d in coll._docs:
                if d.get("_id") == "active":
                    d["generation_id"] = "poisoned"
        return res
    monkeypatch.setattr(coll, "update_one", poisoned)
    out = gen.publish(db, g2, exports_root=tmp_path)
    assert "readback" in out or "conflict" in out
    assert "published" not in out


def test_disposable_target_gate():
    """refusal matrix — ทุกเคส MongoClient ถูกเรียก 0 ครั้ง (validate ก่อนเสมอ)"""
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent
                         / "chatbot" / "shopeechat" / "scripts"))
    import zaapi_kb_gen as cli
    import pytest as _pt
    good = "mongodb://localhost:51234"
    for bad in ("mongodb+srv://x.example.com", "mongodb://digital.in.th:27018",
                "mongodb://prod.internal:27018", "mongodb://localhost:27017",
                "mongodb://127.0.0.1:27017", "mongodb://[::1]:27017",
                "mongodb://localhost", "mongodb://user:pass@localhost:51234",
                "mongodb://localhost:51234/?replicaSet=rs",
                "mongodb://localhost:51234,localhost:51235",
                "mongodb://localhost:51234/dbpath", "", "not-a-uri"):
        with _pt.raises(ValueError):
            cli.require_disposable_target(bad, "zaapi_kb_p4_verify_abcd1234")
    for db in ("admin", "zaapi_kb_records", "zaapi_kb_p4_verify_",
               "zaapi_kb_p4_verify_short", "other_p4_verify_abcdefgh",
               123, None):
        with _pt.raises(ValueError):
            cli.require_disposable_target(good, db)
    uri, name = cli.require_disposable_target(
        good, "zaapi_kb_p4_verify_abcd1234")
    assert (uri, name) == cli.require_disposable_target(
        good, "zaapi_kb_p4_verify_abcd1234")           # deterministic


def test_pointer_schema_write_path(tmp_path):
    """§16.39: doc ที่ publish เขียน → validate_gen_pointer ผ่าน round-trip"""
    gen = _import_gen()
    db = _built_db(tmp_path)
    gen.publish(db, GID, exports_root=tmp_path)
    assert schema.validate_gen_pointer(_pointer(db))
