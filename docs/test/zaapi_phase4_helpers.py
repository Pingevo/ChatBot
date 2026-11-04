"""Neutral Phase 4 Zaapi test helpers — factories for fixtures/data only.

Shared by Phase 4 test files. Imports ONLY `mongo_doubles` at module level —
never donor test modules (those have import-time side effects). Schema-owner
imports (shopeechat.kb_zaapi_schema) are lazy inside functions; fingerprint /
revision / canonical-id logic is NOT re-implemented here — the schema owner is
the single implementation.

Functions: `record()` stored-record dict, `manifest_for()` manifest+revision
docs, `stub_embed()` deterministic embedding stub, `block_network()` offline
tripwires. GenDb/GenColl/_match re-exported for Phase 4 test files (no test-
module import needed to reach the doubles).
"""
from __future__ import annotations

from mongo_doubles import GenColl, GenDb, _match  # noqa: F401


def record(*, record_type="spec", topic="t", model_codes=("CB-100",),
           aliases=(), item_id=None, model_id=None, subject_id=None,
           target_id=None, facts=(), answer_text="", steps=(),
           shop="ShopA", platform="shopee", content_fingerprint=None,
           readiness="resolved", **over):
    """Return a stored-record dict shaped like the Mongo record collection
    (`{"_id", "record_id", **payload}`; `_id == canonical_record_id(payload)`).
    Provenance defaults are deterministic; `**over` overrides payload keys —
    `source_snapshot_id` is recomputed from the final provenance values."""
    from shopeechat.kb_zaapi_schema import (
        SCHEMA_REVISION, canonical_record_id, fingerprint,
        source_snapshot_id)
    payload = {
        "source_id": "src-1",
        "source_snapshot_id": "",          # recomputed below
        "sheet": None,
        "row": 0,
        "source_fingerprint": "sfp-1",
        "scope_fingerprint": "scope-fp-1",
        "content_fingerprint": content_fingerprint or fingerprint(topic),
        "shop": shop,
        "platform": platform,
        "record_type": record_type,
        "topic": topic,
        "model_codes": tuple(model_codes),
        "aliases": tuple(aliases),
        "item_id": item_id,
        "model_id": model_id,
        "subject_id": subject_id,
        "target_id": target_id,
        "facts": tuple(facts),
        "answer_text": answer_text,
        "steps": tuple(steps),
        "readiness": readiness,
        "source_revision": "rev-1",
        "model_version": "model-v1",
        "prompt_version": "prompt-v1",
        "schema_revision": SCHEMA_REVISION,
    }
    payload.update(over)
    payload["source_snapshot_id"] = source_snapshot_id(
        payload["source_id"], payload["source_revision"],
        payload["source_fingerprint"], payload["scope_fingerprint"])
    rid = canonical_record_id(payload)
    return {"_id": rid, "record_id": rid, **payload}


def manifest_for(record_dicts_by_source: dict) -> dict:
    """Build manifest + revision docs for test records.

    Input: `{source_id: [record_dicts]}`. Each source's records must share the
    same provenance fields (validators reject mismatches downstream).
    Output: `{"manifest": manifest_doc, "revisions": {source_id: rev_doc}}`.
    Revision is built via `build_revision` (schema owner); `generation` is
    `fingerprint(manifest["sources"])`."""
    from shopeechat.kb_zaapi_schema import (
        MANIFEST_POINTER_FIELDS, SCHEMA_REVISION, build_revision,
        fingerprint)
    sources, revisions = {}, {}
    for source_id, records in record_dicts_by_source.items():
        first = records[0]
        rev = build_revision({
            "source_id": source_id,
            "source_fingerprint": first["source_fingerprint"],
            "source_revision": first["source_revision"],
            "scope_fingerprint": first["scope_fingerprint"],
            "model_version": first["model_version"],
            "prompt_version": first["prompt_version"],
            "record_ids": [r["record_id"] for r in records]})
        revisions[source_id] = rev
        sources[source_id] = {
            **{k: rev[k] for k in MANIFEST_POINTER_FIELDS
               if k != "revision_id"},
            "revision_id": rev["_id"]}
    manifest = {"_id": "active:manifest", "schema_revision": SCHEMA_REVISION,
                "sources": sources, "generation": fingerprint(sources)}
    return {"manifest": manifest, "revisions": revisions}


def stub_embed(texts, batch_size=32):
    """Deterministic L2-normalized (n,1024) float32 stub of `embed_texts` —
    each vector seeded by sha256(text), so semantic-fixture tests get stable
    nearest-neighbor behavior without provider calls."""
    import hashlib
    import numpy as np
    out = np.empty((len(texts), 1024), dtype=np.float32)
    for i, text in enumerate(texts):
        seed = int.from_bytes(
            hashlib.sha256(text.encode("utf-8")).digest()[:8], "big")
        vec = np.random.default_rng(seed).standard_normal(1024)
        out[i] = vec / np.linalg.norm(vec)
    return out


def block_network(monkeypatch):
    """Install offline tripwires — socket.connect / urlopen /
    pymongo.MongoClient raise AssertionError if called. Returns None."""
    import socket
    import urllib.request
    import pymongo

    def _leak(what):
        raise AssertionError(f"OFFLINE LEAK: {what}")
    monkeypatch.setattr(socket.socket, "connect",
                        lambda self, addr: _leak(f"socket.connect({addr!r})"))
    monkeypatch.setattr(pymongo.MongoClient, "__init__",
                        lambda self, *a, **k: _leak("pymongo.MongoClient()"))
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda *a, **k: _leak("urllib.request.urlopen"))
