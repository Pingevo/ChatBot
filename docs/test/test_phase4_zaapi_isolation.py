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

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
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
