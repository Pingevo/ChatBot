"""Phase 4 — neutral test-infra isolation contracts (T1; T12 seam file).

T1 scope: `mongo_doubles` is the single shared implementation owner of the
Fake*/Gen* Mongo doubles; the two donor test modules re-export the same
objects. `zaapi_phase4_helpers` must import without pulling any test module,
app code, Mongo/socket/provider call, or env/sys.path mutation. T12 adds
retrieval/generation offline-leak tests to this file later.

Offline: subprocess probes install traps before importing the neutral
modules; no real Mongo/provider/network access can happen silently.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
import pymongo.errors

ROOT = Path(__file__).resolve().parents[3]
TEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TEST_DIR))            # mongo_doubles / helpers / donor re-exports
sys.path.insert(0, str(ROOT / "chatbot"))    # shopeechat.kb_zaapi_schema


def _probe(script: str, marker: str) -> str:
    """Run a fresh-interpreter probe; fail on nonzero exit or missing marker."""
    out = subprocess.run(
        [sys.executable, "-c", script],
        cwd=str(ROOT), capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, (
        f"probe failed ({out.returncode}):\n{out.stdout}\n{out.stderr}")
    assert marker in out.stdout, f"marker missing: {out.stdout!r}"
    return out.stdout


def test_doubles_single_owner_and_behavior():
    """Executable census: all shared doubles resolve to mongo_doubles and the
    donor modules re-export the identical objects; moved fakes still act like
    Mongo (find_one filter + _id uniqueness)."""
    import mongo_doubles as md
    from test_phase4b_refresh import GenDb, GenColl
    from test_legacy_turn_incident_replay import (
        FakeColl, FakeDb, FakeClient)

    assert {obj.__module__ for obj in (
        md._norm, md._get_path, md._match, md._Cursor, md._AdminNs,
        md.FakeColl, md.FakeDb, md.FakeClient, md.GenColl, md.GenDb)
    } == {"mongo_doubles"}
    assert GenDb is md.GenDb and GenColl is md.GenColl
    assert (FakeColl is md.FakeColl and FakeDb is md.FakeDb
            and FakeClient is md.FakeClient)

    db = md.FakeDb({"c": [{"_id": 1, "x": 2}]})
    assert db["c"].find_one({"x": 2})["_id"] == 1
    gen = md.GenDb({"c": [{"_id": 1}]})
    gen["c"].insert_one({"_id": 2})
    with pytest.raises(pymongo.errors.DuplicateKeyError):
        gen["c"].insert_one({"_id": 2})


def test_phase4b_import_no_longer_pulls_donor_module():
    """Behavioral: `import test_phase4b_refresh` must not pull the donor
    module (import-time side effects) into sys.modules."""
    probe = textwrap.dedent("""
        import sys
        sys.path.insert(0, {testdir!r})
        import test_phase4b_refresh  # noqa: F401
        assert "test_legacy_turn_incident_replay" not in sys.modules, \\
            "phase4b import pulled the donor side-effect module"
        print("PHASE4B-CLEAN")
    """).format(testdir=str(TEST_DIR))
    _probe(probe, "PHASE4B-CLEAN")


def test_helpers_do_not_import_test_modules():
    """`import zaapi_phase4_helpers` must not pull donor test modules or
    shopeechat.app into sys.modules."""
    probe = textwrap.dedent("""
        import sys
        sys.path.insert(0, {testdir!r})
        import zaapi_phase4_helpers  # noqa: F401
        leaked = [m for m in ("test_legacy_turn_incident_replay",
                              "test_phase4b_refresh", "shopeechat.app")
                  if m in sys.modules]
        assert not leaked, f"helper import pulled forbidden modules: {{leaked}}"
        print("HELPERS-ISOLATION-OK")
    """).format(testdir=str(TEST_DIR))
    _probe(probe, "HELPERS-ISOLATION-OK")


def test_neutral_modules_have_no_import_side_effects():
    """Importing mongo_doubles/zaapi_phase4_helpers must not call dotenv,
    socket.connect, urlopen or MongoClient, must not mutate os.environ or
    sys.path, and must not import app or test modules."""
    probe = textwrap.dedent("""
        import os, socket, sys, urllib.request
        sys.path.insert(0, {testdir!r})
        import dotenv, pymongo
        env_before = dict(os.environ)
        path_before = list(sys.path)

        def _trap(what):
            raise AssertionError(f"OFFLINE LEAK at import: {{what}}")
        dotenv.load_dotenv = lambda *a, **k: _trap("load_dotenv")
        socket.socket.connect = lambda self, addr: _trap(
            f"socket.connect({{addr!r}})")
        urllib.request.urlopen = lambda *a, **k: _trap("urlopen")
        pymongo.MongoClient.__init__ = lambda self, *a, **k: _trap(
            "pymongo.MongoClient()")

        import mongo_doubles         # noqa: F401
        import zaapi_phase4_helpers  # noqa: F401

        assert os.environ == env_before, "os.environ mutated at import"
        assert sys.path == path_before, "sys.path mutated at import"
        leaked = [m for m in ("test_legacy_turn_incident_replay",
                              "test_phase4b_refresh", "shopeechat.app")
                  if m in sys.modules]
        assert not leaked, f"neutral import pulled forbidden modules: {{leaked}}"
        print("NEUTRAL-IMPORT-CLEAN")
    """).format(testdir=str(TEST_DIR))
    _probe(probe, "NEUTRAL-IMPORT-CLEAN")


def test_manifest_for_validates_with_schema_owner():
    """manifest_for builds a manifest + revision docs that the real schema
    owner validators accept (fingerprint/revision logic is NOT re-implemented
    in helpers)."""
    import zaapi_phase4_helpers as helpers
    from shopeechat.kb_zaapi_schema import (
        MANIFEST_POINTER_FIELDS, build_revision, validate_manifest)

    recs = [helpers.record(topic="a", item_id="IT-1"),
            helpers.record(topic="b", model_id="MD-2", model_codes=())]
    out = helpers.manifest_for({"src-1": recs})
    manifest, revision = out["manifest"], out["revisions"]["src-1"]

    validate_manifest(manifest)
    assert build_revision(revision) == revision
    assert manifest["sources"]["src-1"] == {
        **{k: revision[k] for k in MANIFEST_POINTER_FIELDS
           if k != "revision_id"},
        "revision_id": revision["_id"]}
    assert revision["record_ids"] == [r["record_id"] for r in recs]


def test_no_new_module_touches_network_or_mongo_at_import():
    """T12 §16.19: importing the new production owner modules + thin CLI must
    not connect Mongo, open sockets, hit urlopen, load_dotenv, pull
    sentence_transformers/pymongo.MongoClient work, or mutate os.environ —
    every heavy dependency is lazy."""
    probe = textwrap.dedent("""
        import os, socket, sys, urllib.request
        sys.path.insert(0, {chatbot!r})
        import dotenv, pymongo
        env_before = dict(os.environ)
        path_before = list(sys.path)

        def _trap(what):
            raise AssertionError(f"OFFLINE LEAK at import: {{what}}")
        dotenv.load_dotenv = lambda *a, **k: _trap("load_dotenv")
        socket.socket.connect = lambda self, addr: _trap(
            f"socket.connect({{addr!r}})")
        urllib.request.urlopen = lambda *a, **k: _trap("urlopen")
        pymongo.MongoClient.__init__ = lambda self, *a, **k: _trap(
            "pymongo.MongoClient()")

        from shopeechat import (  # noqa: F401
            kb_zaapi_generation, kb_zaapi_retrieval, kb_zaapi_schema,
            embedding)
        import shopeechat.scripts.zaapi_kb_gen as cli  # noqa: F401

        assert "sentence_transformers" not in sys.modules, \\
            "sentence_transformers loaded at import (must be lazy)"
        assert os.environ == env_before, "os.environ mutated at import"
        assert sys.path == path_before, "sys.path mutated at import"
        assert "shopeechat.app" not in sys.modules, "app pulled at import"
        # DAG lock: retrieval must not import generation
        import shopeechat.kb_zaapi_retrieval as ret
        assert not hasattr(ret, "kb_zaapi_generation"), \\
            "retrieval imported generation (DAG violation)"
        print("P4-IMPORT-CLEAN")
    """).format(chatbot=str(ROOT / "chatbot"))
    _probe(probe, "P4-IMPORT-CLEAN")


def test_no_provider_or_mongo_leak(monkeypatch, tmp_path):
    """T12 §16.19: load_active_generation + retrieve + validate_generation +
    publish-path validation run fully offline with fakes — any socket/Mongo
    call trips the wire."""
    from mongo_doubles import GenDb
    from zaapi_phase4_helpers import (
        block_network, record, seed_canonical_state, stub_embed)
    from shopeechat import kb_zaapi_generation as gen
    from shopeechat.kb_zaapi_retrieval import (
        load_active_generation, retrieve)

    block_network(monkeypatch)

    db = GenDb()
    recs, _ = seed_canonical_state(db, ({"item_id": "IT-1",
                                         "subject_id": "SUB-1"},))
    gid = "g20261104-010203-abcdef12"
    rep = gen.build_generation(db, embed=stub_embed,
                               exports_root=tmp_path, gid=gid)
    assert rep["record_count"] == 1
    doc = db["zaapi_kb_embedding_generations"].find_one({"_id": f"gen:{gid}"})
    assert rep == gen.validate_generation(
        tmp_path / "zaapi_kb_gen" / gid, doc, db)
    assert gen.publish(db, gid, exports_root=tmp_path) == "published"
    snap = load_active_generation(db, exports_root=tmp_path)
    assert snap is not None
    res = retrieve(snap, shop="ShopA", platform="shopee",
                   item_ids=("IT-1",))
    assert len(res.supporting_evidence) == 1
    # semantic path — embed seam monkeypatched (real model ไม่แตะ offline)
    from shopeechat import embedding as _emb
    monkeypatch.setattr(_emb, "embed_query",
                        lambda q: stub_embed((q,))[0])
    res2 = retrieve(snap, shop="ShopA", platform="shopee",
                    semantic_query="offline canary")
    assert len(res2.supporting_evidence) == 1


def test_import_order_isolation():
    """T12 §16.20: importing retrieval/generation in either order (and after
    another test module) yields identical public behavior — no module-level
    state that depends on import order."""
    probe = textwrap.dedent("""
        import sys
        sys.path.insert(0, {chatbot!r})
        # order A: retrieval first
        from shopeechat import kb_zaapi_retrieval as r1
        from shopeechat import kb_zaapi_generation as g1
        a = (r1.retrieve, g1.semantic_text, g1.build_generation)
        probe = r1.canonical_delivery_scope("  Shop  A ", " ShOPEE ")
        assert probe == ("Shop A", "shopee"), probe
        print("ORDER-A-OK")
    """).format(chatbot=str(ROOT / "chatbot"))
    _probe(probe, "ORDER-A-OK")

    probe = textwrap.dedent("""
        import sys
        sys.path.insert(0, {chatbot!r})
        sys.path.insert(0, {testdir!r})
        # order B: generation first + an unrelated test module imported before
        import test_phase4_zaapi_scope  # noqa: F401
        from shopeechat import kb_zaapi_generation as g2
        from shopeechat import kb_zaapi_retrieval as r2
        assert g2.semantic_text is not None and r2.retrieve is not None
        probe = r2.canonical_delivery_scope("  Shop  A ", " ShOPEE ")
        assert probe == ("Shop A", "shopee"), probe
        print("ORDER-B-OK")
    """).format(chatbot=str(ROOT / "chatbot"), testdir=str(TEST_DIR))
    _probe(probe, "ORDER-B-OK")


def test_cli_runs_as_script_and_reaches_owner():
    """T12 §16.19/20: `python zaapi_kb_gen.py publish ...` บน sys.path ว่าง
    (scripts dir เท่านั้น) ต้อง resolve `from shopeechat import` ได้ —
    regression สำหรับ bootstrap path bug (เดิม insert parent.parent =
    chatbot/shopeechat ซึ่งทำให้ ModuleNotFoundError) — subprocess stub
    pymongo → command ถึง owner จริงและพิมพ์ status JSON."""
    probe = textwrap.dedent("""
        import sys, types

        class _Coll:
            def find_one(self, *a, **k):
                return None

        class _Db(dict):
            def __getitem__(self, name):
                return _Coll()

        class _FakeClient:
            def __init__(self, uri):
                self.uri = uri
            def __getitem__(self, name):
                return _Db()

        sys.modules["pymongo"] = types.SimpleNamespace(
            MongoClient=_FakeClient)
        sys.argv = ["zaapi_kb_gen.py", "publish",
                    "--mongo-uri", "mongodb://localhost:28018",
                    "--db-name", "zaapi_kb_p4_verify_abcd1234",
                    "--gid", "g20261104-010203-abcdef12"]
        import runpy
        try:
            runpy.run_path({script!r}, run_name="__main__")
        except SystemExit:
            pass
    """).format(
        script=str(ROOT / "chatbot/shopeechat/scripts/zaapi_kb_gen.py"))
    out = subprocess.run(
        [sys.executable, "-c", probe], cwd=str(ROOT),
        capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, (
        f"script run failed ({out.returncode}):\n{out.stdout}\n{out.stderr}")
    assert "ModuleNotFoundError" not in out.stderr, out.stderr
    assert '"reject:gen-doc-missing"' in out.stdout, out.stdout


def test_retrieve_boundary_imports_no_heavy_kb():
    """§18: retrieve/retrieve_active ต้องไม่ลาก knowledge_base (ซึ่งอ่าน .env
    ตอน import) เข้ามา — result contract ต้องมาจาก module บริสุทธิ์
    (precedent: message_detectors split)"""
    probe = textwrap.dedent("""
        import sys
        sys.path.insert(0, "@CHATBOT@")
        from shopeechat.kb_zaapi_retrieval import retrieve
        from shopeechat.kb_zaapi_retrieval import ZaapiKbSnapshot
        import numpy as np
        snap = ZaapiKbSnapshot(
            generation_id="g20261104-000000-deadbeef", vectors=np.zeros((0, 1024), dtype=np.float32),
            digests=(), record_map={}, structured_index={k: {} for k in
                ("item_id","model_id","model_code","alias","subject_id","target_id")},
            record_index={}, model={}, model_compatible=False,
            canonical_generation="0"*64, record_count=0)
        res = retrieve(snap, shop="x", platform="y", item_ids=("nope",))
        assert res.raw_count == 0
        leaked = "shopeechat.knowledge_base" in sys.modules
        print("CONTRACT-MODULE-OK" if not leaked else "HEAVY-KB-LEAKED")
    """).replace("@CHATBOT@", str(ROOT / "chatbot"))
    _probe(probe, "CONTRACT-MODULE-OK")
