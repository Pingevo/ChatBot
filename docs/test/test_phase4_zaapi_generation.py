"""Phase 4 Task 5: closed-schema validators — gen pointer / gen doc / artifact manifest."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "chatbot"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from zaapi_phase4_helpers import record, manifest_for
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
