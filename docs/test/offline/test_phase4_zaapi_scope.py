"""Phase 4 — delivery-scope normalization owner contracts (Task 2; §16.25,31).

`canonical_delivery_scope` is the single owner of shop/platform normalization:
shop whitespace-collapse (case-sensitive) + platform strip/casefold. No
callsite may inline-copy it — `account_scope_fingerprint` delegates, and later
generation/retrieval normalize query scope through the same function.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
TEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TEST_DIR))            # mongo_doubles / zaapi_phase4_helpers
sys.path.insert(0, str(ROOT / "chatbot"))    # shopeechat.kb_zaapi_schema
sys.path.insert(0, str(ROOT / "docs" / "zaapi" / "script"))  # import_/export_zaapi_kb


def test_scope_owner_truth_table():
    """§16.25: shop whitespace variants collapse to match; shop case differs →
    NOT equal; platform case differs → equal; different scope → different."""
    from shopeechat.kb_zaapi_schema import canonical_delivery_scope

    # whitespace collapse — leading/trailing/internal, case-sensitive shop
    assert canonical_delivery_scope("  Shop  A ", " shopee ") == ("Shop A", "shopee")
    assert canonical_delivery_scope("Shop A", "SHOPEE") == ("Shop A", "shopee")
    # shop case differs → different scope (case-sensitive)
    assert canonical_delivery_scope("shop a", "shopee") == ("shop a", "shopee")
    assert canonical_delivery_scope("shop a", "shopee") != \
        canonical_delivery_scope("Shop A", "shopee")
    # platform case differs → same scope (casefold)
    assert canonical_delivery_scope("Shop", "Shopee") == \
        canonical_delivery_scope("Shop", "SHOPEE")
    # different shop or platform → different scope (no leak)
    assert canonical_delivery_scope("ShopA", "shopee") != \
        canonical_delivery_scope("ShopB", "shopee")
    assert canonical_delivery_scope("ShopA", "shopee") != \
        canonical_delivery_scope("ShopA", "lazada")


def test_account_scope_fingerprint_parity():
    """Accounts differing only by pre-normalization whitespace/case produce the
    same fingerprint as their canonical form (existing contract — refactor must
    not drift). Different scopes produce different fingerprints."""
    from shopeechat.kb_zaapi_schema import account_scope_fingerprint as fp

    raw = [{"id": "a1", "name": "  Shop  A ", "platform": " SHOPEE "}]
    canon = [{"id": "a1", "name": "Shop A", "platform": "shopee"}]
    assert fp(raw) == fp(canon)
    other_shop = [{"id": "a1", "name": "Shop B", "platform": "shopee"}]
    assert fp(raw) != fp(other_shop)
    other_platform = [{"id": "a1", "name": "Shop A", "platform": "lazada"}]
    assert fp(raw) != fp(other_platform)


def test_account_scope_fingerprint_uses_owner(monkeypatch):
    """§16.31 behavioral: the fingerprint path must call the single owner —
    a spy on the module attribute must observe one call per account in each of
    the two inline sites (delivery-uniqueness set + identity fingerprint)."""
    import shopeechat.kb_zaapi_schema as schema

    calls = []
    real = schema.canonical_delivery_scope

    def spy(shop, platform):
        calls.append((shop, platform))
        return real(shop, platform)

    monkeypatch.setattr(schema, "canonical_delivery_scope", spy)
    accounts = [{"id": "a1", "name": "Shop A", "platform": "shopee"},
                {"id": "a2", "name": "Shop B", "platform": "shopee"}]
    schema.account_scope_fingerprint(accounts)
    assert len(calls) == 2 * len(accounts)


def test_scope_boundary_malformed():
    """§16.31: malformed account types fail at the boundary —
    `account_scope_fingerprint` validates str-ness before delegating."""
    from shopeechat.kb_zaapi_schema import account_scope_fingerprint

    with pytest.raises(ValueError, match="invalid account scope"):
        account_scope_fingerprint([{"id": "a1", "name": None,
                                    "platform": "shopee"}])
    with pytest.raises(ValueError, match="invalid account scope"):
        account_scope_fingerprint([{"id": "a1", "name": "Shop",
                                    "platform": 123}])
    with pytest.raises(ValueError, match="invalid account scope"):
        account_scope_fingerprint("not-a-list")


def _canonical_state():
    """One coherent (raw row, record, revision+manifest) state — every
    provenance field wired through schema owner fns only (no hand-computed
    fingerprints). Returns (raw_docs, records_docs, manifest)."""
    import zaapi_phase4_helpers as helpers
    from shopeechat.kb_zaapi_schema import (
        RAW_CONTENT_FIELDS, account_scope_fingerprint, canonical_json,
        fingerprint, raw_row_id, sanitize_source_row)

    accounts = [{"id": "a1", "name": "ShopA", "platform": "shopee"}]
    scope_fp = account_scope_fingerprint(accounts)
    row_data = {"kind": "xlsx_row", "sheet": "S1", "row_index": 0,
                "source_row": 0, "fields": {"model_code": "CB-100"},
                "text": "model_code: CB-100"}
    raw = {"source_id": "src-1", "version_id": "rev-1", "accounts": accounts,
           "fingerprint": "sfp-1", "scope_fingerprint": scope_fp,
           "raw_row_json": canonical_json(row_data), "active": True, **row_data,
           "source_name": "src", "source_type": "file",
           "source_file": "c.xlsx", "import_batch": "b1",
           "zaapi_updated_at": "2026-01-01"}
    raw["_id"] = raw_row_id(raw)
    safe = sanitize_source_row(raw)
    content_fp = fingerprint({k: safe.get(k) for k in RAW_CONTENT_FIELDS})
    rec = helpers.record(
        shop="ShopA", platform="shopee", item_id="IT-1",
        **{"source_fingerprint": "sfp-1", "source_revision": "rev-1",
           "scope_fingerprint": scope_fp, "content_fingerprint": content_fp,
           "sheet": "S1", "row": 0})
    built = helpers.manifest_for({"src-1": [rec]})
    return [raw], [built["revisions"]["src-1"], rec], built["manifest"]


def test_load_active_state_lives_in_schema_owner():
    """Owner move: schema is the single implementation; importer re-exports
    the same object (compatibility), exporter binds the schema owner directly."""
    import shopeechat.kb_zaapi_schema as schema
    assert callable(schema.load_active_state)
    import import_zaapi_kb as imp
    assert imp.load_active_state is schema.load_active_state
    import export_zaapi_kb as exp
    assert exp.load_active_state is schema.load_active_state


def test_load_active_state_behavioral():
    """Read path on a GenDb-seeded coherent state: bounded fetch + full
    owner validation returns the canonical record doc."""
    import shopeechat.kb_zaapi_schema as schema
    from mongo_doubles import GenDb

    raw_docs, rec_docs, manifest = _canonical_state()
    raw_coll = GenDb({"zaapi_kb_raw_sources": raw_docs}
                     )["zaapi_kb_raw_sources"]
    records_coll = GenDb({"zaapi_kb_records": rec_docs}
                         )["zaapi_kb_records"]
    docs = schema.load_active_state(records_coll, raw_coll, manifest)
    assert len(docs) == 1 and docs[0]["item_id"] == "IT-1"


def test_loader_uses_immutable_revision(monkeypatch):
    """§16.37 build-side: the existing lazy singleton must pass
    `revision=MODEL_REVISION` (immutable 40-hex commit) — no name-only/latest
    path, no second loader."""
    captured = {}
    import shopeechat.embedding as emb
    import sentence_transformers
    monkeypatch.setattr(emb, "_model", None)
    monkeypatch.setattr(
        sentence_transformers, "SentenceTransformer",
        lambda *a, **kw: captured.update(kw) or object())
    emb._get_model()
    assert captured.get("revision") == emb.MODEL_REVISION
    assert len(emb.MODEL_REVISION) == 40
    assert set(emb.MODEL_REVISION) <= set("0123456789abcdef")


def test_model_identity_six_fields():
    """§13 locked identity — gen doc pin source; ST version resolves via
    importlib.metadata (no model load, no hardcode)."""
    from importlib.metadata import version
    import shopeechat.embedding as emb
    ident = emb.model_identity()
    assert set(ident) == {"name", "revision", "sentence_transformers_version",
                        "dim", "normalize_embeddings", "output_dtype"}
    assert ident["name"] == "BAAI/bge-m3"
    assert ident["revision"] == emb.MODEL_REVISION
    assert ident["sentence_transformers_version"] == version(
        "sentence-transformers")
    assert ident["dim"] == 1024
    assert ident["normalize_embeddings"] is True
    assert ident["output_dtype"] == "float32"
