"""Offline raw/canonical Zaapi import contract; no database or provider calls."""
from __future__ import annotations

import hashlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace

import pytest
from openpyxl import Workbook, load_workbook
from pymongo.errors import DuplicateKeyError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs" / "zaapi" / "script"))

from shopeechat.kb_zaapi_schema import (  # noqa: E402
    canonical_json, canonical_record_id, SCHEMA_REVISION_V2,
    RECORD_PROVENANCE_UNHASHED)
import import_zaapi_kb as importer  # noqa: E402
from import_zaapi_kb import import_source, import_snapshot  # noqa: E402
from export_zaapi_kb import export_snapshot  # noqa: E402
import export_zaapi_kb as exporter  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "zaapi_kb_minimal"


class MemoryCollection:
    def __init__(self):
        self.docs = {}
        self.indexes = []
        self.queries = []
        self.before_update = None
        self.before_find = None
        self.before_raw = None
        self.lose_race = {}
        self.upserts = {}

    def create_index(self, keys, **kwargs):
        self.indexes.append((keys, kwargs))

    def update_one(self, query, update, upsert=False):
        key = query["_id"]
        if set(update.get("$set", ())) & set(update.get("$setOnInsert", ())):
            raise ValueError("Mongo rejects overlapping update paths")
        if self.before_update and key.startswith("active:"):
            hook, self.before_update = self.before_update, None
            hook(query, update, upsert)
        if self.before_raw and key.startswith("raw:"):
            self.before_raw()
        self.upserts[key] = self.upserts.get(key, 0) + 1
        if key in self.lose_race and key not in self.docs:
            self.docs[key] = deepcopy(self.lose_race.pop(key))
            raise DuplicateKeyError("lost insert race")
        existing = self.docs.get(key)
        if existing is not None and all(
                existing.get(field) == value for field, value in query.items()):
            existing.update(deepcopy(update.get("$set", {})))
            return SimpleNamespace(matched_count=1, upserted_id=None)
        if not upsert:
            return SimpleNamespace(matched_count=0, upserted_id=None)
        if existing is not None:
            raise DuplicateKeyError("concurrent _id insert")
        self.docs[key] = {"_id": key, **deepcopy(update.get("$setOnInsert", {})),
                          **deepcopy(update.get("$set", {}))}
        return SimpleNamespace(matched_count=0, upserted_id=key)

    def find(self, query=None, projection=None):
        self.queries.append(query)
        rows = list(self.docs.values())
        for key, value in (query or {}).items():
            rows = [row for row in rows if (
                row.get(key) in value["$in"]
                if isinstance(value, dict) and "$in" in value
                else row.get(key) == value)]
        if self.before_find and (not query or query.get("_id") == "active:manifest"):
            self.before_find()
        return iter(deepcopy(rows))

    def find_one(self, query):
        return next(self.find(query), None)


@pytest.fixture
def collections():
    return MemoryCollection(), MemoryCollection()


@pytest.fixture
def sources():
    return json.loads((FIXTURES / "knowledge-sources.json").read_text(
        encoding="utf-8"))["items"]


def extraction(row):
    fields = row.get("fields") or {}
    code = fields.get("model_code") or "CB-100"
    if fields:
        return {
            "record_type": "spec", "topic": "cable capacity",
            "model_codes": [code], "aliases": [fields["alias"]],
            "item_id": fields["item_id"], "model_id": None,
            "subject_id": None, "target_id": None,
            "facts": [{"key": "power_capacity_w",
                       "value": int(fields["fact"].split("=")[1])}],
            "answer_text": "", "steps": [],
        }
    return {
        "record_type": "faq", "topic": "cable use",
        "model_codes": ["CB-100"], "aliases": ["Demo cable"],
        "item_id": "1001", "model_id": None,
        "subject_id": None, "target_id": None,
        "facts": [], "answer_text": row["text"], "steps": [],
    }


def _run(item, collections, *, extractor=extraction, checkpoint=None,
         files_dir=FIXTURES / "knowledge-files", apply=True,
         confirm=None):
    out = import_source(item, files_dir, *collections, extractor=extractor,
                        canonicalize=True, apply=apply, checkpoint=checkpoint,
                        confirm=confirm or frozenset())
    if confirm is None and out.get("status") == "needs_confirm":
        out = import_source(
            item, files_dir, *collections, extractor=extractor,
            canonicalize=True, apply=apply, checkpoint=checkpoint,
            confirm=frozenset(
                {p["needs_confirm"] for p in out["proposals"]}))
    return out


def _replacement(item, folder, *, name="replacement.xlsx", rows=None, version="v2"):
    source = deepcopy(item)
    book = Workbook()
    sheet = book.active
    sheet.title = "Cable Specs"
    sheet.append(("model_code", "item_id", "alias", "fact"))
    for row in rows or (
            ("CB-200", "1002", "Demo second cable", "power_capacity_w=120"),
            ("CB-300", "1003", "Demo third cable", "power_capacity_w=60")):
        sheet.append(row)
    path = folder / name
    book.save(path)
    book.close()
    source["version"]["versionId"] = version
    source["downloaded_file"] = {
        "file": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    return source


def _active_sources(collection):
    return collection.docs.get("active:manifest", {}).get("sources", {})


def _record_ids(collection, source_id):
    return collection.docs[
        _active_sources(collection)[source_id]["revision_id"]]["record_ids"]


def test_simultaneous_cross_source_conflicts_cannot_both_publish(
        sources, collections):
    barrier = Barrier(2)
    scans = []

    def scan_same_snapshot():
        scans.append(True)
        if len(scans) <= 2:
            barrier.wait()

    collections[1].before_find = scan_same_snapshot

    def duplicate_fact(row):
        return {**extraction(row), "record_type": "spec",
                "topic": "cable capacity", "model_codes": ["CB-100"],
                "item_id": "1001",
                "facts": [{"key": "power_capacity_w", "value": 120}],
                "answer_text": ""}

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(_run, sources[0], collections)
        second = pool.submit(_run, sources[1], collections,
                             extractor=duplicate_fact)
        results = (first.result(), second.result())
    active = _active_sources(collections[1])
    assert "active:manifest" in collections[1].docs
    assert not any(key.startswith("active:") and key != "active:manifest"
                   for key in collections[1].docs)
    assert sum(result["published"] for result in results) == 1
    assert sorted(result["readiness"] for result in results) == [
        "conflicted", "resolved"]
    assert len(active) == 1
    assert len([r for r in collections[1].docs.values() if r.get("record_id")]) == 3


def test_absent_manifest_loser_rechecks_nonconflict_and_publishes(
        sources, collections):
    advanced = []

    def race(row):
        if not advanced:
            advanced.append(_run(sources[1], collections))
        return extraction(row)

    result = _run(sources[0], collections, extractor=race)
    assert advanced[0]["published"] is True
    assert result["published"] is True
    assert set(_active_sources(collections[1])) == {"demo-cable", "demo-guide"}


def test_existing_manifest_loser_rechecks_nonconflict_and_publishes(
        sources, collections):
    original = _run(sources[1], collections)
    changed = deepcopy(sources[1])
    changed["version"]["versionId"] = "v2"
    advanced = []

    def race(row):
        if not advanced:
            advanced.append(_run(changed, collections))
        return extraction(row)

    result = _run(sources[0], collections, extractor=race)
    assert advanced[0]["revision_id"] != original["revision_id"]
    assert result["published"] is True
    assert _active_sources(collections[1])["demo-guide"]["active_revision"] == \
        advanced[0]["revision_id"]
    assert set(_active_sources(collections[1])) == {"demo-cable", "demo-guide"}


def test_cross_source_scan_ignores_inactive_historical_facts(
        sources, collections, tmp_path):
    old = _run(sources[0], collections)
    replacement = _replacement(sources[0], tmp_path)
    updated = _run(replacement, collections, files_dir=tmp_path)
    assert old["revision_id"] != updated["revision_id"]
    assert "1001" not in {
        collections[1].docs[rid]["item_id"]
        for rid in _record_ids(collections[1], "demo-cable")}

    def contradicts_history(_row):
        return {**extraction(_row), "item_id": "1001",
                "facts": [{"key": "power_capacity_w", "value": 120}],
                "answer_text": ""}

    result = _run(sources[1], collections, extractor=contradicts_history)
    assert result["published"] is True
    assert set(_active_sources(collections[1])) == {"demo-cable", "demo-guide"}


def test_same_file_new_account_scope_is_new_revision(
        sources, collections):
    first = _run(sources[0], collections)
    changed = deepcopy(sources[0])
    changed["accounts"][0]["name"] = "Renamed Shop"
    changed["accounts"][0]["platform"] = "lazada"
    calls = []

    def counted(row):
        calls.append(row["row_index"])
        return extraction(row)

    second = _run(changed, collections, extractor=counted)
    assert second["published"] is True
    assert second["revision_id"] != first["revision_id"]
    assert calls == [0, 1]
    active = _record_ids(collections[1], "demo-cable")
    assert {collections[1].docs[rid]["shop"] for rid in active} == {
        "Renamed Shop"}
    assert {collections[1].docs[rid]["platform"] for rid in active} == {
        "lazada"}
    assert len(collections[0].docs) == 4


def test_semantic_account_order_does_not_change_revision(
        sources, collections):
    first = deepcopy(sources[0])
    first["accounts"].append({
        "id": "second-shop", "name": "Second Shop", "platform": "shopee"})
    reordered = deepcopy(first)
    reordered["accounts"].reverse()
    a = _run(first, collections, apply=True)
    b = _run(reordered, collections, apply=True)
    assert a["revision_id"] == b["revision_id"]


def test_duplicate_semantic_account_scope_fails_before_provider_or_db(
        sources, collections):
    repeated = deepcopy(sources[0])
    repeated["accounts"].append(deepcopy(repeated["accounts"][0]))
    called = []

    def counted(row):
        called.append(row)
        return extraction(row)

    with pytest.raises(ValueError, match="account scope"):
        _run(repeated, collections, extractor=counted)
    assert not called
    assert not collections[0].docs and not collections[1].docs


def test_same_file_changed_scope_has_distinct_checkpoint(
        sources, collections, tmp_path):
    checkpoint = tmp_path / "checkpoint.json"
    first = _run(sources[0], collections, checkpoint=checkpoint, apply=True)
    changed = deepcopy(sources[0])
    changed["accounts"][0]["name"] = "Renamed Shop"
    calls = []

    def counted(row):
        calls.append(row["row_index"])
        return extraction(row)

    second = _run(changed, collections, checkpoint=checkpoint,
                  extractor=counted, apply=True)
    assert second["revision_id"] != first["revision_id"]
    assert calls == [0, 1]
    assert len(json.loads(checkpoint.read_text(encoding="utf-8"))) == 2


def test_corrupted_other_source_manifest_cannot_enable_conflict(
        sources, collections):
    _run(sources[0], collections)
    _repoint_manifest(collections[1], "demo-cable", [])
    calls = []

    def counted(row):
        calls.append(True)
        return extraction(row)

    with pytest.raises(ValueError, match="manifest|revision"):
        _run(sources[1], collections, extractor=counted)
    assert not calls
    assert "demo-guide" not in _active_sources(collections[1])


@pytest.mark.parametrize("field", [
    "source_id", "source_fingerprint", "source_revision",
    "model_version", "prompt_version", "scope_fingerprint",
])
def test_tampered_checkpoint_metadata_rejected_before_provider_or_db(
        sources, collections, tmp_path, field):
    checkpoint = tmp_path / "checkpoint.json"
    _run(sources[0], collections, apply=True, checkpoint=checkpoint)
    state = json.loads(checkpoint.read_text(encoding="utf-8"))
    next(iter(state.values()))[field] = "tampered"
    checkpoint.write_text(canonical_json(state), encoding="utf-8")
    called = []

    def forbidden(_row):
        called.append(True)
        raise AssertionError("provider must not be called")

    docs_before = (dict(collections[0].docs), dict(collections[1].docs))
    with pytest.raises(ValueError, match="checkpoint"):
        _run(sources[0], collections, extractor=forbidden,
             checkpoint=checkpoint)
    assert not called
    assert collections[0].docs == docs_before[0]
    assert collections[1].docs == docs_before[1]


def test_malformed_checkpoint_entry_cannot_be_silently_ignored(
        sources, collections, tmp_path):
    checkpoint = tmp_path / "checkpoint.json"
    _run(sources[0], collections, apply=True, checkpoint=checkpoint)
    state = json.loads(checkpoint.read_text(encoding="utf-8"))
    state[next(iter(state))] = {}
    checkpoint.write_text(canonical_json(state), encoding="utf-8")
    calls = []

    def counted(row):
        calls.append(row)
        return extraction(row)

    docs_before = (dict(collections[0].docs), dict(collections[1].docs))
    with pytest.raises(ValueError, match="checkpoint"):
        _run(sources[0], collections, extractor=counted,
             checkpoint=checkpoint)
    assert not calls
    assert collections[0].docs == docs_before[0]
    assert collections[1].docs == docs_before[1]


def test_renamed_same_bytes_same_scope_is_idempotent(
        sources, collections, tmp_path):
    first = _run(sources[0], collections)
    second = _run(_rename(sources[0], tmp_path), collections, files_dir=tmp_path,
                  extractor=lambda _row: pytest.fail("unchanged source re-extracted"))
    assert second["revision_id"] == first["revision_id"]
    assert len(collections[0].docs) == 2


def test_empty_replacement_keeps_previous_active(sources, collections, tmp_path):
    first = _run(sources[0], collections)
    book = Workbook()
    book.active.append(("model_code", "item_id", "alias", "fact"))
    path = tmp_path / "empty.xlsx"
    book.save(path)
    book.close()
    empty = deepcopy(sources[0])
    empty["downloaded_file"] = {
        "file": "empty.xlsx", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    result = _run(empty, collections, files_dir=tmp_path)
    assert result["published"] is False
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == \
        first["revision_id"]
    assert len(collections[0].docs) == 2


def test_renamed_replacement_publishes_full_source_snapshot(
        sources, collections, tmp_path):
    first = _run(sources[0], collections)
    updated = _replacement(sources[0], tmp_path, name="renamed-catalog.xlsx")
    second = _run(updated, collections, files_dir=tmp_path)
    active = [collections[1].docs[rid]
              for rid in _record_ids(collections[1], "demo-cable")]
    historical = [r for r in collections[1].docs.values()
                  if r.get("source_id") == "demo-cable" and r.get("record_id")]
    assert second["published"] is True
    assert second["revision_id"] != first["revision_id"]
    assert {(r["item_id"], r["facts"][0]["value"]) for r in active} == {
        ("1002", 120), ("1003", 60)}
    assert all(row["source_file"] == "renamed-catalog.xlsx"
               for row in collections[0].docs.values()
               if row["version_id"] == "v2")
    assert {(r["item_id"], r["facts"][0]["value"]) for r in historical} == {
        ("1001", 240), ("1002", 100), ("1002", 120), ("1003", 60)}
    assert len(collections[0].docs) == 4


def test_failed_replacement_keeps_source_pointer(sources, collections, tmp_path):
    first = _run(sources[0], collections)
    updated = _replacement(sources[0], tmp_path)

    def fails_last(row):
        if row["fields"]["item_id"] == "1003":
            raise RuntimeError("offline extractor failure")
        return extraction(row)

    result = _run(updated, collections, files_dir=tmp_path, extractor=fails_last)
    assert result["published"] is False
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == first["revision_id"]


def test_same_filename_different_source_ids_remain_independent(
        sources, collections):
    first = _run(sources[0], collections)
    other = deepcopy(sources[0])
    other["id"] = "another-source"
    second = _run(other, collections)
    assert first["revision_id"] != second["revision_id"]
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == first["revision_id"]
    assert _active_sources(collections[1])["another-source"]["active_revision"] == second["revision_id"]
    assert len(collections[0].docs) == 4


def test_source_selector_never_uses_filename_as_identity(
        sources, monkeypatch, tmp_path):
    selected = deepcopy(sources[0])
    selected["id"] = "unselected-source"
    manifest = {"items": [selected]}
    (tmp_path / "knowledge-sources.json").write_text(
        canonical_json(manifest), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", [
        "import_zaapi_kb.py", "--dry-run", "--source", "demo-cable",
        "--dir", str(tmp_path)])
    with pytest.raises(SystemExit) as error:
        importer.main()
    assert error.value.code == 2


def test_missing_selected_source_identity_fails_before_writes(
        sources, collections):
    missing = deepcopy(sources[0])
    missing["id"] = ""
    with pytest.raises(ValueError, match="source_id"):
        _run(missing, collections)
    assert not collections[0].docs and not collections[1].docs


def test_export_preserves_one_shot_cursor_pointers_and_source_scope(
        sources, collections):
    for source in sources:
        _run(source, collections)
    full = json.loads(export_snapshot(*collections))
    scoped = json.loads(export_snapshot(*collections, source_id="demo-cable"))
    assert len(full["records"]) == 3
    assert set(full["manifest"]["sources"]) == {
        "demo-cable", "demo-guide"}
    assert len(scoped["records"]) == 2
    assert list(scoped["manifest"]["sources"]) == ["demo-cable"]
    assert {r["source_id"] for r in scoped["raw_rows"]} == {"demo-cable"}


@pytest.mark.parametrize("mutate", [
    lambda dump: dump["manifest"]["sources"]["demo-cable"].update(
        active_revision="tampered"),
    lambda dump: dump["records"][0].update(schema_revision=999),
    lambda dump: dump["manifest"]["sources"]["demo-cable"].update(
        model_version="tampered"),
    lambda dump: dump["revisions"][0]["record_ids"].append(
        dump["revisions"][0]["record_ids"][0]),
    lambda dump: dump["manifest"].update(generation="tampered"),
    lambda dump: dump.update(records={}),
    lambda dump: dump.pop("revisions"),
    lambda dump: dump["revisions"].append(dump["revisions"][0]),
    lambda dump: dump["revisions"][0].update(record_count=9),
    lambda dump: dump["revisions"][0].update(extra="x"),
    lambda dump: dump.update(revisions=[]),
])
def test_snapshot_rejects_tampered_metadata_before_any_write(
        sources, collections, mutate):
    _run(sources[0], collections)
    dump = json.loads(export_snapshot(*collections))
    mutate(dump)
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError):
        import_snapshot(canonical_json(dump), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_resume_reuses_completed_rows_without_provider(
        sources, collections, tmp_path):
    checkpoint = tmp_path / "checkpoint.json"
    calls = []

    def counted(row):
        calls.append(row["row_index"])
        return extraction(row)

    _run(sources[0], collections, apply=True, extractor=counted,
         checkpoint=checkpoint)
    second = _run(sources[0], collections, extractor=counted,
                  checkpoint=checkpoint)
    assert second["published"] is True
    assert calls == [0, 1]


def test_resume_only_retries_failed_row_and_never_downgrades_complete(
        sources, collections, tmp_path):
    checkpoint = tmp_path / "checkpoint.json"
    calls = []

    def partly_fails(row):
        calls.append(row["row_index"])
        if row["row_index"] == 1:
            raise RuntimeError("offline provider failure")
        return extraction(row)

    failed = _run(sources[0], collections, extractor=partly_fails,
                  checkpoint=checkpoint)
    # v2: new-row failure quarantines row1; row0 publishes
    assert failed["published"] is True
    assert [q["row_uid"] for q in failed["quarantined"]] == ["demo-cable:r1"]

    def counted(row):
        calls.append(row["row_index"])
        return extraction(row)

    resumed = _run(sources[0], collections, extractor=counted,
                   checkpoint=checkpoint)
    again = _run(sources[0], collections, extractor=counted,
                 checkpoint=checkpoint)
    assert resumed["published"] is True and again["published"] is True
    assert calls == [0, 1, 1]
    states = json.loads(checkpoint.read_text(encoding="utf-8"))
    assert len(states) == 1
    assert next(iter(states.values()))["status"] == "complete"


def test_resume_checkpoint_is_scoped_by_source_id(
        sources, collections, tmp_path):
    calls = []
    checkpoint = tmp_path / "checkpoint.json"

    def counted(row):
        calls.append(row["source_id"])
        return extraction(row)

    _run(sources[0], collections, apply=True,
         extractor=counted, checkpoint=checkpoint)
    second = deepcopy(sources[0])
    second["id"] = "another-source"
    _run(second, collections, apply=True, extractor=counted,
         checkpoint=checkpoint)
    assert calls == ["demo-cable", "demo-cable",
                     "another-source", "another-source"]
    assert len(json.loads(checkpoint.read_text(encoding="utf-8"))) == 2


def test_resume_after_publication_write_failure_reuses_provider_output(
        sources, collections, tmp_path):
    checkpoint = tmp_path / "checkpoint.json"
    calls = []

    def counted(row):
        calls.append(row["row_index"])
        return extraction(row)

    def offline_write_error(query, _update, _upsert):
        if query["_id"] == "active:manifest":
            raise RuntimeError("offline pointer write failure")

    collections[1].before_update = offline_write_error
    with pytest.raises(RuntimeError, match="pointer write"):
        _run(sources[0], collections, extractor=counted,
             checkpoint=checkpoint)
    assert "active:manifest" not in collections[1].docs
    resumed = _run(sources[0], collections, extractor=counted,
                   checkpoint=checkpoint)
    assert resumed["published"] is True
    assert calls == [0, 1]


def test_sanitized_provider_input_and_canonical_export_round_trip(
        sources, collections, tmp_path):
    secret = "synthetic-" + "s" * 35
    source = _replacement(sources[0], tmp_path)
    source["accounts"][0]["token"] = secret
    book = load_workbook(tmp_path / "replacement.xlsx")
    book.active.cell(row=1, column=5, value="api_key")
    book.active.cell(row=2, column=5, value=secret)
    book.save(tmp_path / "replacement.xlsx")
    book.close()
    source["downloaded_file"]["sha256"] = hashlib.sha256(
        (tmp_path / "replacement.xlsx").read_bytes()).hexdigest()
    checkpoint = tmp_path / "checkpoint.json"

    def checked(row):
        assert secret not in canonical_json(row)
        return extraction(row)

    result = _run(source, collections, files_dir=tmp_path,
                  extractor=checked, checkpoint=checkpoint)
    dump = export_snapshot(*collections)
    assert result["published"] is True
    assert secret in canonical_json(list(collections[0].docs.values()))
    assert secret not in dump
    assert secret not in canonical_json(list(collections[1].docs.values()))
    assert secret not in checkpoint.read_text(encoding="utf-8")
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(dump, *restored)
    assert export_snapshot(*restored) == dump


def test_stale_writer_cannot_replace_newer_revision(
        sources, collections, tmp_path):
    first = _run(sources[0], collections)
    newer = _replacement(sources[0], tmp_path, name="newer.xlsx", version="v2")
    stale = _replacement(sources[0], tmp_path, name="stale.xlsx", version="v3",
                         rows=(("CB-300", "1003", "Demo third cable",
                                "power_capacity_w=90"),))
    advanced = []

    def race(row):
        if not advanced:
            advanced.append(_run(newer, collections, files_dir=tmp_path))
        return extraction(row)

    loser = _run(stale, collections, files_dir=tmp_path, extractor=race)
    assert first["revision_id"] != advanced[0]["revision_id"]
    assert loser["published"] is False
    assert loser["publication_conflict"] is True
    assert loser["readiness"] == "resolved"
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == \
        advanced[0]["revision_id"]
    assert any(r.get("source_revision") == "v3"
               for r in collections[1].docs.values())


def test_resuming_stale_writer_keeps_its_original_fence(
        sources, collections, tmp_path):
    _run(sources[0], collections)
    newer = _replacement(sources[0], tmp_path, name="newer.xlsx", version="v2")
    stale = _replacement(sources[0], tmp_path, name="stale.xlsx", version="v3")
    checkpoint = tmp_path / "checkpoint.json"
    competing = []

    def race(row):
        if not competing:
            competing.append(_run(newer, collections, files_dir=tmp_path))
        return extraction(row)

    first = _run(stale, collections, files_dir=tmp_path,
                 extractor=race, checkpoint=checkpoint)
    assert first["published"] is False

    def must_not_reextract(_row):
        raise AssertionError("completed row extracted again")

    again = _run(stale, collections, files_dir=tmp_path,
                 extractor=must_not_reextract, checkpoint=checkpoint)
    assert again["published"] is False
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == \
        competing[0]["revision_id"]


def test_no_pointer_concurrent_different_revision_cannot_insert(
        sources, collections, tmp_path):
    newer = _replacement(sources[0], tmp_path, name="newer.xlsx", version="v2")
    stale = _replacement(sources[0], tmp_path, name="stale.xlsx", version="v3")
    competing = []

    def race(row):
        if not competing:
            competing.append(_run(newer, collections, files_dir=tmp_path))
        return extraction(row)

    loser = _run(stale, collections, files_dir=tmp_path, extractor=race)
    assert loser["published"] is False
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == \
        competing[0]["revision_id"]


def test_identical_racing_publish_converges(sources, collections):
    competing = []

    def race(row):
        if not competing:
            competing.append(_run(sources[0], collections))
        return extraction(row)

    result = _run(sources[0], collections, extractor=race)
    assert result["published"] is True
    assert result["revision_id"] == competing[0]["revision_id"]
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == \
        result["revision_id"]


def test_duplicate_key_race_converges_only_for_identical_revision(
        sources, collections):
    def concurrent_insert(query, update, _upsert):
        if query["_id"] == "active:manifest":
            pointer = update.get("$setOnInsert") or update["$set"]
            collections[1].docs[query["_id"]] = {
                "_id": query["_id"], **deepcopy(pointer)}
            raise DuplicateKeyError("offline duplicate-key race")

    collections[1].before_update = concurrent_insert
    result = _run(sources[0], collections)
    assert result["published"] is True
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == \
        result["revision_id"]


def test_duplicate_key_race_with_other_metadata_cannot_converge(
        sources, collections):
    def conflicting_insert(query, update, _upsert):
        if query["_id"] == "active:manifest":
            pointer = deepcopy(update["$setOnInsert"])
            pointer["sources"]["demo-cable"]["model_version"] = "other-model"
            collections[1].docs[query["_id"]] = {
                "_id": query["_id"], **pointer}
            raise DuplicateKeyError("offline duplicate-key race")

    collections[1].before_update = conflicting_insert
    with pytest.raises(ValueError, match="revision|manifest"):
        _run(sources[0], collections)


def test_invalid_active_pointer_hash_never_skips_validation(
        sources, collections):
    first = _run(sources[0], collections)
    collections[1].docs["active:manifest"]["generation"] = "tampered"

    def forbidden(_row):
        raise AssertionError("must validate active pointer before extraction")

    with pytest.raises(ValueError, match="manifest fingerprint"):
        _run(sources[0], collections, extractor=forbidden)
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == \
        first["revision_id"]


def test_concurrent_other_source_does_not_change_source_pointer(
        sources, collections, tmp_path):
    other = _run(sources[1], collections)
    _run(sources[0], collections)
    newer = _replacement(sources[0], tmp_path)
    moved = []

    def race(row):
        if not moved:
            moved.append(_run(newer, collections, files_dir=tmp_path))
        return extraction(row)

    stale = _replacement(sources[0], tmp_path, name="stale.xlsx", version="v3")
    result = _run(stale, collections, extractor=race, files_dir=tmp_path)
    assert result["published"] is False
    assert _active_sources(collections[1])["demo-guide"]["active_revision"] == \
        other["revision_id"]


def test_same_fingerprint_is_idempotent(sources, collections):
    first = _run(sources[0], collections)
    before = tuple(len(coll.docs) for coll in collections)

    def changed_provider(_row):
        raise AssertionError("unchanged source must not re-extract")

    second = _run(sources[0], collections, extractor=changed_provider)
    assert first["revision_id"] == second["revision_id"]
    assert tuple(len(coll.docs) for coll in collections) == before
    assert second["published"] is True


def test_changed_source_revision_keeps_both_snapshots(sources, collections):
    first = _run(sources[0], collections)
    updated = deepcopy(sources[0])
    updated["version"]["versionId"] = "v2"
    second = _run(updated, collections)
    assert second["revision_id"] != first["revision_id"]
    assert len(collections[0].docs) == 4
    # v2: identical rows reuse records — provenance stays first-seen (v1)
    assert sorted(r["source_revision"] for r in collections[1].docs.values()
                  if r.get("record_id")) == ["v1", "v1"]
    assert sorted(r["source_revision"] for r in collections[1].docs.values()
                  if r.get("active_revision")) == ["v1", "v2"]
    snapshot = export_snapshot(*collections)
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(snapshot, *restored)
    assert export_snapshot(*restored) == snapshot


def test_raw_row_bytes_survive_export_reimport(sources, collections):
    _run(sources[0], collections)
    original = sorted(row["raw_row_json"] for row in collections[0].docs.values())
    dump = export_snapshot(*collections)
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(dump, *restored)
    assert sorted(row["raw_row_json"] for row in restored[0].docs.values()) == original
    assert export_snapshot(*restored) == dump


def test_provenance_and_identity_stay_on_each_record(sources, collections):
    _run(sources[0], collections)
    records = [r for r in collections[1].docs.values() if r.get("record_type")]
    assert len(records) == 2
    first = next(r for r in records if r["item_id"] == "1001")
    assert first["source_id"] == "demo-cable"
    assert "source_file" not in first
    assert first["sheet"] == "Cable Specs"
    assert first["row"] == 2
    assert first["source_fingerprint"] == sources[0]["downloaded_file"]["sha256"]
    assert len(first["content_fingerprint"]) == 64
    assert (first["shop"], first["platform"]) == ("Demo Shop", "shopee")
    assert first["model_codes"] == ["CB-100"]
    assert first["aliases"] == ["Demo cable"]
    assert first["facts"] == [{"key": "power_capacity_w", "value": 240}]
    assert first["readiness"] == "resolved"
    assert all((first["source_revision"], first["model_version"],
                first["prompt_version"]))


def test_invalid_output_stays_inactive(sources, collections):
    bad = lambda row: {**extraction(row), "unexpected": True}
    outcome = _run(sources[0], collections, extractor=bad)
    # v2: invalid NEW rows quarantine; revision publishes with zero coverage
    assert outcome["published"] is True
    assert not outcome["row_map"]
    assert all(q["reason"] == "invalid" for q in outcome["quarantined"])
    assert not any(r.get("readiness") == "resolved"
                   for r in collections[1].docs.values() if r.get("record_type"))


def test_conflicting_same_identity_facts_stay_inactive(sources, collections):
    def conflicting(row):
        result = extraction(row)
        result["model_codes"] = ["CB-100"]
        result["item_id"] = "1001"
        return result
    outcome = _run(sources[0], collections, extractor=conflicting)
    records = [r for r in collections[1].docs.values() if r.get("record_type")]
    # v2: self-conflicting rows quarantine; revision publishes zero coverage
    assert outcome["published"] is True
    assert not outcome["row_map"]
    assert len(outcome["quarantined"]) == 2
    assert [r["readiness"] for r in records] == []


def test_provider_failure_is_resumable_without_replacing_active(
        sources, collections, tmp_path):
    first = _run(sources[1], collections)
    source = deepcopy(sources[1])
    target = tmp_path / "guide.txt"
    target.write_text("Updated sanitized guide", encoding="utf-8")
    source["downloaded_file"]["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
    checkpoint = tmp_path / "checkpoint.json"

    def offline_failure(_row):
        raise RuntimeError("offline provider failure")

    failed = _run(source, collections, extractor=offline_failure,
                  files_dir=tmp_path, checkpoint=checkpoint)
    assert failed["published"] is False
    assert failed["readiness"] == "unresolved"
    assert _active_sources(collections[1])["demo-guide"]["active_revision"] == first["revision_id"]
    assert next(iter(json.loads(checkpoint.read_text(
        encoding="utf-8")).values()))["status"] == "unresolved"

    resumed = _run(source, collections, files_dir=tmp_path, checkpoint=checkpoint)
    assert resumed["published"] is True
    assert _active_sources(collections[1])["demo-guide"]["active_revision"] == resumed["revision_id"]
    assert next(iter(json.loads(checkpoint.read_text(
        encoding="utf-8")).values()))["status"] == "complete"


def test_failed_batch_keeps_previous_revision(sources, collections, tmp_path):
    first = _run(sources[0], collections)
    changed = deepcopy(sources[0])
    target = tmp_path / "cables.xlsx"
    target.write_bytes((FIXTURES / "knowledge-files" / "cables.xlsx").read_bytes())
    from openpyxl import load_workbook
    workbook = load_workbook(target)
    workbook.active.cell(row=2, column=4, value="power_capacity_w=241")
    workbook.save(target)
    workbook.close()
    changed["downloaded_file"]["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()

    def fail_second(row):
        result = extraction(row)
        return {**result, "unexpected": 1} if result["item_id"] == "1001" else result

    second = _run(changed, collections, extractor=fail_second, files_dir=tmp_path)
    assert second["published"] is False
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == first["revision_id"]


def test_checkpoint_write_failure_keeps_previous_revision(
        sources, collections, tmp_path):
    first = _run(sources[0], collections)
    changed = deepcopy(sources[0])
    changed["version"]["versionId"] = "v2"
    unavailable = tmp_path / "missing-parent" / "checkpoint.json"
    with pytest.raises(FileNotFoundError):
        _run(changed, collections, checkpoint=unavailable)
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == first["revision_id"]


def test_dry_run_does_not_write_or_call_provider(sources, collections):
    def forbidden(_row):
        raise AssertionError("provider called without canonicalization")

    outcome = import_source(sources[0], FIXTURES / "knowledge-files",
                            *collections, extractor=forbidden,
                            canonicalize=False, apply=False)
    assert outcome["published"] is False
    assert not collections[0].docs and not collections[1].docs


def test_raw_and_canonical_export_is_deterministic(sources, collections):
    for source in sources:
        _run(source, collections)
    result = export_snapshot(*collections)
    decoded = json.loads(result)
    assert decoded["schema_revision"] == 1
    assert len(decoded["raw_rows"]) == 3
    assert len(decoded["records"]) == 3
    assert result == canonical_json(decoded)


def test_reimport_unchanged_snapshot_creates_no_duplicates(sources, collections):
    _run(sources[0], collections)
    dump = export_snapshot(*collections)
    before = tuple(len(coll.docs) for coll in collections)
    import_snapshot(dump, *collections)
    assert tuple(len(coll.docs) for coll in collections) == before


def test_cross_source_conflict_keeps_previous_active(sources, collections):
    first = _run(sources[0], collections)

    def duplicate_fact(_row):
        return {**extraction(_row), "record_type": "spec",
                "topic": "cable capacity", "model_codes": ["CB-100"],
                "item_id": "1001",
                "facts": [{"key": "power_capacity_w", "value": 120}],
                "answer_text": ""}

    second = _run(sources[1], collections, extractor=duplicate_fact)
    incoming = [r for r in collections[1].docs.values()
                if r.get("source_id") == "demo-guide" and r.get("record_id")]
    # v2: conflicting source publishes an all-quarantine revision (no coverage)
    assert second["published"] is True
    assert not second["row_map"]
    assert all(q["reason"] == "conflict" for q in second["quarantined"])
    assert [r["readiness"] for r in incoming] == []
    assert _active_sources(collections[1])["demo-cable"]["active_revision"] == first["revision_id"]


def test_tampered_export_cannot_publish_missing_record(sources, collections):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    snapshot["records"].pop()
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="missing|incomplete"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_tampered_export_cannot_publish_changed_fact(sources, collections):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    snapshot["records"][0]["facts"][0]["value"] = 999
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="identity|fingerprint"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_rejects_duplicate_source_entry_before_any_write(
        sources, collections):
    _run(sources[0], collections)
    snapshot = export_snapshot(*collections).replace(
        '"demo-cable":{', '"demo-cable":{},"demo-cable":{', 1)
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="duplicate"):
        import_snapshot(snapshot, *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_rejects_wrong_scope_even_with_updated_manifest_digest(
        sources, collections):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    snapshot["manifest"]["sources"]["demo-cable"]["scope_fingerprint"] = "tampered"
    snapshot["manifest"]["generation"] = importer.fingerprint(
        snapshot["manifest"]["sources"])
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError,
                       match="manifest|revision|scope|coverage|mismatch"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def _signed_revision(old, record_ids):
    active = importer.fingerprint((
        old["source_id"], old["source_fingerprint"], old["source_revision"],
        old["scope_fingerprint"], old["model_version"], old["prompt_version"],
        record_ids))
    return {**old, "_id": f"revision:{old['source_id']}:{active}",
            "active_revision": active, "record_ids": record_ids,
            "record_count": len(record_ids)}


def _repoint_pointer(manifest, new):
    manifest["sources"][new["source_id"]].update(
        revision_id=new["_id"], active_revision=new["active_revision"],
        record_count=new["record_count"])
    manifest["generation"] = importer.fingerprint(manifest["sources"])


def _repoint_manifest(collection, source_id, record_ids):
    """Re-sign revision, pointer and manifest digest after tampering record_ids."""
    manifest = collection.docs["active:manifest"]
    new = _signed_revision(
        collection.docs[manifest["sources"][source_id]["revision_id"]],
        record_ids)
    collection.docs[new["_id"]] = new
    _repoint_pointer(manifest, new)


def _repoint_snapshot(snapshot, source_id, record_ids):
    manifest = snapshot["manifest"]
    old = next(r for r in snapshot["revisions"]
               if r["_id"] == manifest["sources"][source_id]["revision_id"])
    new = _signed_revision(old, record_ids)
    snapshot["revisions"] = [r for r in snapshot["revisions"]
                             if r is not old] + [new]
    _repoint_pointer(manifest, new)


def _snapshot_record_ids(snapshot, source_id):
    return next(r for r in snapshot["revisions"] if r["_id"] == snapshot[
        "manifest"]["sources"][source_id]["revision_id"])["record_ids"]


def test_manifest_pointing_to_missing_record_rejects_import(
        sources, collections):
    _run(sources[0], collections)
    _repoint_manifest(collections[1], "demo-cable", ["missing-record-id"])
    with pytest.raises(ValueError, match="manifest|record"):
        _run(sources[0], collections)


def test_manifest_missing_record_cannot_hide_cross_source_conflict(
        sources, collections):
    _run(sources[0], collections)
    _repoint_manifest(collections[1], "demo-cable", ["missing-record-id"])

    def conflicting(_row):
        return {**extraction(_row), "item_id": "1001",
                "facts": [{"key": "power_capacity_w", "value": 120}],
                "answer_text": ""}

    with pytest.raises(ValueError, match="manifest|record"):
        _run(sources[1], collections, extractor=conflicting)
    assert "demo-guide" not in _active_sources(collections[1])


def test_tampered_persisted_active_record_rejects_import(
        sources, collections):
    _run(sources[0], collections)
    collections[1].docs[_record_ids(collections[1], "demo-cable")[0]]["facts"] = [
        {"key": "power_capacity_w", "value": 999}]
    with pytest.raises(ValueError, match="record|identity|manifest"):
        _run(sources[0], collections)


def test_tampered_persisted_record_metadata_rejects_import(
        sources, collections):
    _run(sources[0], collections)
    collections[1].docs[_record_ids(collections[1], "demo-cable")[0]]["shop"] = (
        "Tampered Shop")
    with pytest.raises(ValueError, match="record|identity|manifest"):
        _run(sources[0], collections)


def test_corrupt_persisted_record_cannot_publish(sources, collections):
    probe = MemoryCollection(), MemoryCollection()
    _run(sources[0], probe)
    rid = _record_ids(probe[1], "demo-cable")[0]
    collections[1].docs[rid] = {
        **probe[1].docs[rid],
        "facts": [{"key": "power_capacity_w", "value": 999}]}
    with pytest.raises(ValueError, match="persisted|mismatch"):
        _run(sources[0], collections)
    assert collections[1].docs[rid]["facts"][0]["value"] == 999
    assert "active:manifest" not in collections[1].docs


def test_import_snapshot_rejects_corrupt_persisted_record(
        sources, collections):
    _run(sources[0], collections)
    snapshot = export_snapshot(*collections)
    target = json.loads(snapshot)["records"][0]
    restored = MemoryCollection(), MemoryCollection()
    restored[1].docs[target["_id"]] = {
        **target, "facts": [{"key": "power_capacity_w", "value": 999}]}
    with pytest.raises(ValueError, match="persisted|mismatch"):
        import_snapshot(snapshot, *restored)
    assert restored[1].docs[target["_id"]]["facts"][0]["value"] == 999
    assert "active:manifest" not in restored[1].docs


def test_corrupt_persisted_raw_row_cannot_publish(sources, collections):
    probe = MemoryCollection(), MemoryCollection()
    _run(sources[0], probe)
    raw_id = next(iter(probe[0].docs))
    collections[0].docs[raw_id] = {
        **probe[0].docs[raw_id], "fields": {"tampered": "field"}}
    with pytest.raises(ValueError, match="persisted|mismatch"):
        _run(sources[0], collections)
    assert "active:manifest" not in collections[1].docs


def test_tampered_inactive_historical_record_rejected(
        sources, collections, tmp_path):
    _run(sources[0], collections)
    _run(_replacement(sources[0], tmp_path), collections, files_dir=tmp_path)
    snapshot = json.loads(export_snapshot(*collections))
    active_ids = set(_snapshot_record_ids(snapshot, "demo-cable"))
    inactive = next(r for r in snapshot["records"]
                    if r["record_id"] not in active_ids)
    inactive["facts"][0]["value"] = 999
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="identity|fingerprint"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_orphan_historical_record_rejected(sources, collections):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    other = MemoryCollection(), MemoryCollection()
    _run(sources[1], other)
    foreign = json.loads(export_snapshot(*other))
    snapshot["records"].append(foreign["records"][0])
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="provenance|incomplete|orphan|missing"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_valid_inactive_history_round_trip(sources, collections, tmp_path):
    _run(sources[0], collections)
    _run(_replacement(sources[0], tmp_path), collections, files_dir=tmp_path)
    snapshot = export_snapshot(*collections)
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(snapshot, *restored)
    assert export_snapshot(*restored) == snapshot
    active_ids = set(_record_ids(restored[1], "demo-cable"))
    inactive = [r for r in restored[1].docs.values()
                if r.get("record_id") and r["_id"] not in active_ids]
    assert len(inactive) == 2


def _self_hash(record):
    base = {key: value for key, value in record.items()
            if key not in ("_id", "record_id")}
    if base.get("schema_revision") == SCHEMA_REVISION_V2:
        base = {key: value for key, value in base.items()
                if key not in RECORD_PROVENANCE_UNHASHED}
    record["record_id"] = record["_id"] = importer.fingerprint(base)


def _resign_snapshot_manifest(snapshot, source_id):
    _repoint_snapshot(snapshot, source_id, [
        record["record_id"] for record in snapshot["records"]
        if record["source_id"] == source_id
        and record["readiness"] == "resolved"])


def test_persisted_record_extra_field_cannot_publish(sources, collections):
    probe = MemoryCollection(), MemoryCollection()
    _run(sources[0], probe)
    rid = _record_ids(probe[1], "demo-cable")[0]
    collections[1].docs[rid] = {**probe[1].docs[rid], "unexpected_field": "x"}
    with pytest.raises(ValueError, match="persisted|mismatch"):
        _run(sources[0], collections)
    assert "active:manifest" not in collections[1].docs


def test_snapshot_persisted_record_extra_field_rejected(sources, collections):
    _run(sources[0], collections)
    snapshot = export_snapshot(*collections)
    target = json.loads(snapshot)["records"][0]
    restored = MemoryCollection(), MemoryCollection()
    restored[1].docs[target["_id"]] = {**target, "unexpected_field": "x"}
    with pytest.raises(ValueError, match="persisted|mismatch"):
        import_snapshot(snapshot, *restored)
    assert "active:manifest" not in restored[1].docs


def test_snapshot_persisted_record_missing_field_rejected(sources, collections):
    _run(sources[0], collections)
    snapshot = export_snapshot(*collections)
    target = json.loads(snapshot)["records"][0]
    restored = MemoryCollection(), MemoryCollection()
    trimmed = {k: v for k, v in target.items() if k != "topic"}
    restored[1].docs[target["_id"]] = trimmed
    with pytest.raises(ValueError, match="persisted|mismatch"):
        import_snapshot(snapshot, *restored)
    assert "active:manifest" not in restored[1].docs


def test_persisted_raw_row_extra_field_cannot_publish(sources, collections):
    probe = MemoryCollection(), MemoryCollection()
    _run(sources[0], probe)
    raw_id = next(iter(probe[0].docs))
    collections[0].docs[raw_id] = {
        **probe[0].docs[raw_id], "unexpected_raw_field": "x"}
    with pytest.raises(ValueError, match="persisted|mismatch"):
        _run(sources[0], collections)
    assert "active:manifest" not in collections[1].docs


def test_snapshot_persisted_raw_row_extra_field_rejected(sources, collections):
    _run(sources[0], collections)
    snapshot = export_snapshot(*collections)
    target = json.loads(snapshot)["raw_rows"][0]
    restored = MemoryCollection(), MemoryCollection()
    restored[0].docs[target["_id"]] = {**target, "unexpected_raw_field": "x"}
    with pytest.raises(ValueError, match="persisted|mismatch"):
        import_snapshot(snapshot, *restored)


def test_snapshot_persisted_raw_row_missing_field_rejected(sources, collections):
    _run(sources[0], collections)
    snapshot = export_snapshot(*collections)
    target = json.loads(snapshot)["raw_rows"][0]
    restored = MemoryCollection(), MemoryCollection()
    trimmed = {k: v for k, v in target.items() if k != "source_name"}
    restored[0].docs[target["_id"]] = trimmed
    with pytest.raises(ValueError, match="persisted|mismatch"):
        import_snapshot(snapshot, *restored)


def _tampered_record_snapshot(sources, collections, mutate):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    record = snapshot["records"][0]
    mutate(record)
    _self_hash(record)
    _resign_snapshot_manifest(snapshot, record["source_id"])
    return snapshot


def test_snapshot_facts_wrong_type_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections,
        lambda record: record.update(facts="not-a-list"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_malformed_fact_shape_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections,
        lambda record: record.update(
            facts=[{"key": "k", "value": 1, "extra": "x"}]))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_unknown_record_field_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections,
        lambda record: record.update(unexpected_field="x"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_missing_record_field_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections, lambda record: record.pop("topic"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_invalid_model_code_type_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections,
        lambda record: record.update(model_codes=[123]))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_bool_row_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections, lambda record: record.update(row=True))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_invalid_readiness_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections,
        lambda record: record.update(readiness="resolved-ish"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_resolved_without_identity_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections,
        lambda record: record.update(
            item_id=None, model_id=None, model_codes=[]))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_compatibility_without_target_rejected(sources, collections):
    snapshot = _tampered_record_snapshot(
        sources, collections,
        lambda record: record.update(
            record_type="compatibility", target_id=None))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="schema|identity|canonical"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def _tampered_raw_snapshot(sources, collections, mutate):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    mutate(snapshot["raw_rows"][0])
    return snapshot


def test_snapshot_unknown_raw_field_rejected(sources, collections):
    snapshot = _tampered_raw_snapshot(
        sources, collections,
        lambda row: row.update(unexpected_raw_field="x"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="raw row|schema"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_missing_raw_field_rejected(sources, collections):
    snapshot = _tampered_raw_snapshot(
        sources, collections, lambda row: row.pop("source_name"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="raw row|schema"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_invalid_accounts_shape_rejected(sources, collections):
    snapshot = _tampered_raw_snapshot(
        sources, collections,
        lambda row: row.update(accounts=[{"id": "a1", "extra": "x"}]))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="raw row|schema|scope"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_wrong_raw_scope_rejected(sources, collections):
    snapshot = _tampered_raw_snapshot(
        sources, collections,
        lambda row: row.update(scope_fingerprint="tampered"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="raw row|fingerprint|scope"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def _provenance_tampered_snapshot(sources, collections, mutate):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    record = snapshot["records"][0]
    mutate(record)
    _self_hash(record)
    _resign_snapshot_manifest(snapshot, record["source_id"])
    return snapshot


@pytest.mark.parametrize("field,value", (
    ("source_snapshot_id", "f" * 64),
    ("sheet", "Forged Sheet"), ("row", 99),
    ("content_fingerprint", "0" * 64), ("shop", "Forged Shop")))
def test_snapshot_fake_provenance_rejected(sources, collections, field, value):
    snapshot = _provenance_tampered_snapshot(
        sources, collections, lambda record: record.update({field: value}))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="provenance|schema|identity"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_snapshot_missing_provenance_row_rejected(sources, collections):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    record = snapshot["records"][0]
    snapshot["raw_rows"] = [
        row for row in snapshot["raw_rows"]
        if not (row["source_id"] == record["source_id"]
                and row["sheet"] == record["sheet"])]
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="provenance|incomplete|manifest"):
        import_snapshot(canonical_json(snapshot), *restored)
    assert not restored[0].docs and not restored[1].docs


def test_export_rejects_raw_extra_field(sources, collections):
    _run(sources[0], collections)
    raw_id = next(iter(collections[0].docs))
    collections[0].docs[raw_id]["extra_field"] = "x"
    with pytest.raises(ValueError, match="raw row"):
        export_snapshot(*collections)


def test_export_rejects_raw_missing_field(sources, collections):
    _run(sources[0], collections)
    raw_id = next(iter(collections[0].docs))
    del collections[0].docs[raw_id]["source_name"]
    with pytest.raises(ValueError, match="raw row"):
        export_snapshot(*collections)


def test_export_rejects_malformed_canonical_facts(sources, collections):
    _run(sources[0], collections)
    rid = _record_ids(collections[1], "demo-cable")[0]
    collections[1].docs[rid]["facts"] = "not-a-list"
    with pytest.raises(ValueError, match="canonical"):
        export_snapshot(*collections)


def test_export_rejects_canonical_unknown_field(sources, collections):
    _run(sources[0], collections)
    rid = _record_ids(collections[1], "demo-cable")[0]
    collections[1].docs[rid]["unexpected_field"] = "x"
    with pytest.raises(ValueError, match="canonical"):
        export_snapshot(*collections)


def test_export_rejects_orphan_historical_record(sources, collections):
    _run(sources[0], collections)
    rid = _record_ids(collections[1], "demo-cable")[0]
    orphan = deepcopy(collections[1].docs[rid])
    orphan["source_id"] = "ghost-source"
    _self_hash(orphan)
    collections[1].docs[orphan["_id"]] = orphan
    with pytest.raises(ValueError, match="provenance|canonical"):
        export_snapshot(*collections)


def test_export_rejects_corrupted_active_record(sources, collections):
    _run(sources[0], collections)
    rid = _record_ids(collections[1], "demo-cable")[0]
    collections[1].docs[rid]["facts"] = [
        {"key": "power_capacity_w", "value": 999}]
    with pytest.raises(ValueError, match="canonical|manifest|identity"):
        export_snapshot(*collections)


def _manifest_tampered_snapshot(sources, collections, mutate):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    mutate(snapshot["manifest"])
    snapshot["manifest"]["generation"] = importer.fingerprint(
        snapshot["manifest"]["sources"])
    return snapshot


def test_snapshot_extra_manifest_field_rejected(sources, collections):
    snapshot = _manifest_tampered_snapshot(
        sources, collections,
        lambda manifest: manifest.update(extra_field=1))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="manifest"):
        import_snapshot(canonical_json(snapshot), *restored)


def test_snapshot_missing_manifest_field_rejected(sources, collections):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    del snapshot["manifest"]["generation"]
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="manifest"):
        import_snapshot(canonical_json(snapshot), *restored)


def test_snapshot_extra_pointer_field_rejected(sources, collections):
    snapshot = _manifest_tampered_snapshot(
        sources, collections,
        lambda manifest: manifest["sources"]["demo-cable"].update(extra=1))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="revision|manifest"):
        import_snapshot(canonical_json(snapshot), *restored)


def test_snapshot_missing_pointer_field_rejected(sources, collections):
    snapshot = _manifest_tampered_snapshot(
        sources, collections,
        lambda manifest: manifest["sources"]["demo-cable"].pop("prompt_version"))
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="revision|manifest"):
        import_snapshot(canonical_json(snapshot), *restored)


@pytest.mark.parametrize("record_ids", ("abc", ["", "x"], [], ["a", "a"]))
def test_snapshot_bad_record_ids_rejected(sources, collections, record_ids):
    _run(sources[0], collections)
    snapshot = json.loads(export_snapshot(*collections))
    _repoint_snapshot(snapshot, "demo-cable", record_ids)
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="revision|manifest"):
        import_snapshot(canonical_json(snapshot), *restored)


def test_snapshot_source_key_mismatch_rejected(sources, collections):
    def swap_key(manifest):
        manifest["sources"]["demo-guide"] = manifest["sources"].pop("demo-cable")
    snapshot = _manifest_tampered_snapshot(sources, collections, swap_key)
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError, match="revision|manifest"):
        import_snapshot(canonical_json(snapshot), *restored)


def test_source_scoped_export_round_trip(sources, collections):
    _run(sources[0], collections)
    _run(sources[1], collections)
    snapshot = export_snapshot(*collections, source_id="demo-cable")
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(snapshot, *restored)
    assert set(_active_sources(restored[1])) == {"demo-cable"}
    assert all(row["source_id"] == "demo-cable"
               for row in restored[0].docs.values())


def test_source_filter_cannot_hide_corruption(sources, collections):
    _run(sources[0], collections)
    _run(sources[1], collections)
    rid = _record_ids(collections[1], "demo-guide")[0]
    collections[1].docs[rid]["facts"] = [
        {"key": "power_capacity_w", "value": 999}]
    with pytest.raises(ValueError, match="canonical|manifest|identity"):
        export_snapshot(*collections, source_id="demo-cable")


def test_snapshot_race_does_not_silently_report_publication_success(
        sources, collections):
    _run(sources[0], collections)
    dump = export_snapshot(*collections)
    restored = MemoryCollection(), MemoryCollection()

    def concurrent_manifest(query, _update, _upsert):
        if query["_id"] == "active:manifest":
            restored[1].docs[query["_id"]] = {
                "_id": query["_id"], "sources": {},
                "generation": importer.fingerprint({}),
                "schema_revision": 1}

    restored[1].before_update = concurrent_manifest
    with pytest.raises(ValueError, match="manifest conflict|persisted record mismatch"):
        import_snapshot(dump, *restored)
    assert not _active_sources(restored[1])


def test_canonical_import_does_not_mutate_existing_raw_row(sources, collections):
    previous = {"_id": "legacy", "source_id": sources[0]["id"],
                "fingerprint": "old-fingerprint", "active": True,
                "manual_edit": True, "fields": {"original": "unchanged"}}
    collections[0].docs["legacy"] = deepcopy(previous)
    _run(sources[0], collections)
    assert collections[0].docs["legacy"] == previous


def test_raw_export_redacts_credential_columns_without_mutating_source(collections):
    raw = {
        "source_id": "demo-credential", "source_name": "Demo credential",
        "version_id": "v1", "source_type": "file",
        "source_file": "cred.xlsx", "import_batch": "canonical-v1",
        "zaapi_updated_at": "", "fingerprint": "fixture-fp",
        "kind": "xlsx_row", "sheet": "Safe", "row_index": 0, "source_row": 2,
        "fields": {"Model": "CB-100", "API_KEY": "demo-credential-value",
                   "api_token": "demo-account-token"},
        "text": ("Model: CB-100\nAPI_KEY: demo-credential-value\n"
                 "api_token: demo-account-token"),
        "accounts": [{"id": "a1", "name": "Demo Shop", "platform": "shopee"}],
        "active": False,
    }
    raw["scope_fingerprint"] = importer.account_scope_fingerprint(raw["accounts"])
    raw["raw_row_json"] = canonical_json({key: raw[key] for key in (
        "kind", "sheet", "row_index", "source_row", "fields", "text")})
    raw["_id"] = importer.raw_row_id(raw)
    collections[0].docs[raw["_id"]] = deepcopy(raw)
    dump = export_snapshot(*collections, raw_only=True)
    assert "demo-credential-value" not in dump
    assert "demo-account-token" not in dump
    assert "CB-100" in dump
    assert collections[0].docs[raw["_id"]] == raw


def test_manifest_fingerprint_mismatch_cannot_publish(sources, collections):
    altered = deepcopy(sources[0])
    altered["downloaded_file"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="sha256 mismatch"):
        _run(altered, collections)
    assert not collections[0].docs and not collections[1].docs


def test_manifest_cannot_read_outside_source_directory(sources, collections):
    altered = deepcopy(sources[0])
    altered["downloaded_file"]["file"] = "../knowledge-sources.json"
    with pytest.raises(ValueError, match="source path"):
        _run(altered, collections)
    assert not collections[0].docs and not collections[1].docs


def test_unresolved_identity_cannot_be_published(sources, collections):
    def no_identity(row):
        return {**extraction(row), "model_codes": [], "item_id": None}

    result = _run(sources[0], collections, extractor=no_identity)
    # v2: unresolvable NEW rows quarantine revision-bound; nothing delivers
    assert result["published"] is True
    assert not result["row_map"] and len(result["quarantined"]) == 2
    assert all(q["reason"] == "unresolved" for q in result["quarantined"])
    assert not any(r.get("readiness") == "resolved"
                   for r in collections[1].docs.values() if r.get("record_id"))


def test_missing_shop_scope_cannot_be_published(sources, collections):
    unscoped = deepcopy(sources[0])
    unscoped["accounts"] = []
    result = _run(unscoped, collections)
    # v2: no-account rows quarantine; revision publishes with zero coverage
    assert result["published"] is True
    assert not result["row_map"] and len(result["quarantined"]) == 2
    assert all(q["reason"] == "no account membership"
               for q in result["quarantined"])
    assert not any(r.get("readiness") == "resolved"
                   for r in collections[1].docs.values() if r.get("record_id"))


def test_cli_dry_run_reads_active_state_without_writes_or_provider(
        admin, monkeypatch, capsys):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("external call")

    monkeypatch.setattr(importer, "_gemini_extract", forbidden)
    for method in ("update_one", "create_index"):
        monkeypatch.setattr(MemoryCollection, method, forbidden)
    monkeypatch.setattr(sys, "argv", [
        "import_zaapi_kb.py", "--dry-run", "--source", "demo-cable",
        "--dir", str(FIXTURES),
    ])
    assert importer.main() == 0
    output = capsys.readouterr().out
    assert len(output.strip().splitlines()) == 1
    assert '"raw_count":2' in output
    assert '"published":false' in output
    assert '"status":"preview"' in output


def _resign_persisted_active(collections, source_id, mutate):
    """Tamper one persisted active record and re-sign revision+pointer+manifest."""
    record_ids = list(_record_ids(collections[1], source_id))
    doc = collections[1].docs.pop(record_ids[0])
    mutate(doc)
    _self_hash(doc)
    collections[1].docs[doc["_id"]] = doc
    record_ids[0] = doc["record_id"]
    _repoint_manifest(collections[1], source_id, record_ids)


@pytest.mark.parametrize("field,value", (
    ("source_snapshot_id", "f" * 64),
    ("sheet", "Forged Sheet"), ("row", 99),
    ("content_fingerprint", "0" * 64), ("shop", "Forged Shop")))
def test_import_source_rejects_fake_active_provenance(
        sources, collections, field, value):
    _run(sources[0], collections)
    _resign_persisted_active(
        collections, "demo-cable", lambda doc: doc.update({field: value}))
    calls = []

    def forbidden(row):
        calls.append(row)
        return extraction(row)

    with pytest.raises(ValueError, match="provenance|manifest|identity|schema"):
        _run(sources[0], collections, extractor=forbidden)
    assert not calls


def test_cas_loser_recheck_rejects_fake_active_provenance(
        sources, collections):
    _run(sources[0], collections)
    injected = []

    def race(row):
        if not injected:
            injected.append(_resign_persisted_active(
                collections, "demo-cable",
                lambda doc: doc.update(sheet="Forged Sheet")))
        return extraction(row)

    with pytest.raises(ValueError, match="provenance|manifest|identity"):
        _run(sources[1], collections, extractor=race)


def test_scoped_export_cannot_hide_other_active_provenance(
        sources, collections):
    for source in sources:
        _run(source, collections)
    _resign_persisted_active(
        collections, "demo-guide", lambda doc: doc.update(sheet="Forged Sheet"))
    with pytest.raises(ValueError, match="provenance|manifest|identity"):
        export_snapshot(*collections, source_id="demo-cable")


def test_scoped_export_rejects_other_active_missing_raw(
        sources, collections):
    for source in sources:
        _run(source, collections)
    raw_id = next(key for key, doc in collections[0].docs.items()
                  if doc["source_id"] == "demo-guide")
    del collections[0].docs[raw_id]
    with pytest.raises(ValueError,
                       match="provenance|manifest|coverage|mismatch"):
        export_snapshot(*collections, source_id="demo-cable")


def test_scoped_export_rejects_other_source_malformed_owned_raw(
        sources, collections):
    for source in sources:
        _run(source, collections)
    raw_id = next(key for key, doc in collections[0].docs.items()
                  if doc["source_id"] == "demo-guide")
    collections[0].docs[raw_id]["unexpected"] = "x"
    with pytest.raises(ValueError, match="raw"):
        export_snapshot(*collections, source_id="demo-cable")


def test_scoped_export_rejects_selected_source_corrupt_history(
        sources, collections, tmp_path):
    _run(sources[0], collections)
    _run(_replacement(sources[0], tmp_path), collections, files_dir=tmp_path)
    active_ids = set(_record_ids(collections[1], "demo-cable"))
    historical = next(doc for doc in collections[1].docs.values()
                      if doc.get("record_id")
                      and doc["source_id"] == "demo-cable"
                      and doc["record_id"] not in active_ids)
    collections[1].docs.pop(historical["_id"])
    historical["sheet"] = "Forged Sheet"
    _self_hash(historical)
    collections[1].docs[historical["_id"]] = historical
    with pytest.raises(ValueError, match="provenance|identity|canonical"):
        export_snapshot(*collections, source_id="demo-cable")


def _unscoped(item):
    source = deepcopy(item)
    source["accounts"] = []
    return source


def test_no_account_unresolved_history_round_trip(sources, collections):
    result = _run(_unscoped(sources[0]), collections)
    assert result["published"] is True
    assert result["readiness"] == "unresolved"
    dump = export_snapshot(*collections)
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(dump, *restored)
    assert export_snapshot(*restored) == dump


def test_no_account_invalid_history_round_trip(sources, collections):
    result = _run(_unscoped(sources[0]), collections,
                  extractor=lambda _row: {"bad": "shape"})
    # no accounts → rows quarantine before extraction runs at all
    assert result["readiness"] == "unresolved"
    dump = export_snapshot(*collections)
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(dump, *restored)
    assert export_snapshot(*restored) == dump


@pytest.mark.parametrize("mutate", (
    lambda doc: doc.update(readiness="unresolved"),
    lambda doc: doc.update(shop="Ghost Shop", platform="shopee"),
))
def test_no_account_fabricated_record_rejected(
        sources, collections, mutate):
    _run(sources[0], collections)
    held = _run(_unscoped(sources[0]), collections)
    assert held["status"] == "hold_publish"
    rid = next(key for key, doc in collections[1].docs.items()
               if doc.get("record_id"))
    doc = collections[1].docs.pop(rid)
    mutate(doc)
    with pytest.raises(ValueError,
                       match="provenance|schema|canonical|mismatch"):
        _self_hash(doc)
        collections[1].docs[doc["_id"]] = doc
        export_snapshot(*collections)


LEGACY_RAW = {"_id": "legacy-manual-1", "source_id": "demo-cable",
              "manual_edit": True, "fields": {"legacy": "data"}}


def test_legacy_raw_rows_do_not_break_import_or_export(sources, collections):
    collections[0].docs["legacy-manual-1"] = deepcopy(LEGACY_RAW)
    result = _run(sources[0], collections)
    assert result["published"] is True
    dump = json.loads(export_snapshot(*collections))
    assert all(row["_id"].startswith("raw:") for row in dump["raw_rows"])
    assert collections[0].docs["legacy-manual-1"] == LEGACY_RAW


def test_unrelated_inactive_malformed_history_does_not_block_bounded_import(
        sources, collections):
    collections[0].docs["raw:corrupt"] = {
        "_id": "raw:corrupt", "source_id": "ghost", "junk": True}
    collections[1].docs["revision:ghost:x"] = {
        "_id": "revision:ghost:x", "source_id": "ghost", "junk": True}
    assert _run(sources[0], collections)["published"] is True
    assert export_snapshot(*collections, source_id="demo-cable")
    with pytest.raises(ValueError):
        export_snapshot(*collections)
    del collections[0].docs["raw:corrupt"]
    with pytest.raises(ValueError):
        export_snapshot(*collections)


def test_malformed_target_source_raw_row_rejects_import(sources, collections):
    collections[0].docs["raw:corrupt"] = {
        "_id": "raw:corrupt", "source_id": "demo-cable", "junk": True}
    with pytest.raises(ValueError, match="raw"):
        _run(sources[0], collections)
    assert "active:manifest" not in collections[1].docs


def test_legacy_raw_row_is_never_provenance(sources, collections):
    _run(sources[0], collections)
    owned = next(iter(collections[0].docs.values()))
    collections[0].docs["legacy-copy"] = {
        **deepcopy(owned), "_id": "legacy-copy"}
    result = _run(sources[0], collections)
    assert result["published"] is True
    dump = json.loads(export_snapshot(*collections))
    assert len(dump["raw_rows"]) == 2
    assert collections[0].docs["legacy-copy"]["_id"] == "legacy-copy"


def test_credential_persisted_raw_provenance_round_trip(collections):
    raw = {
        "source_id": "demo-credential", "source_name": "Demo credential",
        "version_id": "v1", "source_type": "file",
        "source_file": "cred.xlsx", "import_batch": "canonical-v1",
        "zaapi_updated_at": "", "fingerprint": "fixture-fp",
        "kind": "xlsx_row", "sheet": "Safe", "row_index": 0, "source_row": 2,
        "fields": {"Model": "CB-100", "API_KEY": "demo-credential-value",
                   "api_token": "demo-account-token"},
        "text": ("Model: CB-100\nAPI_KEY: demo-credential-value\n"
                 "api_token: demo-account-token"),
        "accounts": [{"id": "a1", "name": "Demo Shop", "platform": "shopee"}],
        "active": False,
    }
    raw["scope_fingerprint"] = importer.account_scope_fingerprint(
        raw["accounts"])
    raw["raw_row_json"] = canonical_json({key: raw[key] for key in (
        "kind", "sheet", "row_index", "source_row", "fields", "text")})
    raw["_id"] = importer.raw_row_id(raw)
    collections[0].docs[raw["_id"]] = deepcopy(raw)
    safe = importer.sanitize_source_row(raw)
    record = importer.ZaapiKnowledgeRecord.from_extraction(
        raw, extraction({"fields": {}, "text": safe["text"]}),
        shop="Demo Shop", platform="shopee",
        model_version="m1", prompt_version="p1").to_dict()
    collections[1].docs[record["record_id"]] = {
        "_id": record["record_id"], **record}
    dump = export_snapshot(*collections)
    assert "demo-credential-value" not in dump
    assert "demo-account-token" not in dump
    assert collections[0].docs[raw["_id"]] == raw
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(dump, *restored)
    assert export_snapshot(*restored) == dump


def _partial_pointer(collections, source_id):
    """Drop active record ids from a revision and re-sign every hash."""
    _repoint_manifest(collections[1], source_id,
                      _record_ids(collections[1], source_id)[:1])


def test_import_source_rejects_partial_active_revision(sources, collections):
    _run(sources[0], collections)
    assert len(_record_ids(collections[1], "demo-cable")) == 2
    _partial_pointer(collections, "demo-cable")
    calls = []

    def forbidden(row):
        calls.append(row)
        return extraction(row)

    with pytest.raises(ValueError, match="manifest|record|provenance|incomplete"):
        _run(sources[0], collections, extractor=forbidden)
    assert not calls


def test_cross_source_import_rejects_partial_active_state(
        sources, collections):
    _run(sources[0], collections)
    _partial_pointer(collections, "demo-cable")
    calls = []

    def forbidden(row):
        calls.append(row)
        return extraction(row)

    with pytest.raises(ValueError, match="manifest|record|provenance|incomplete"):
        _run(sources[1], collections, extractor=forbidden)
    assert not calls
    assert "demo-guide" not in _active_sources(collections[1])


def test_export_rejects_partial_active_revision(sources, collections):
    _run(sources[0], collections)
    _partial_pointer(collections, "demo-cable")
    with pytest.raises(ValueError, match="manifest|record|provenance"):
        export_snapshot(*collections)


def test_scoped_export_rejects_partial_revision_anywhere(
        sources, collections):
    for source in sources:
        _run(source, collections)
    _partial_pointer(collections, "demo-cable")
    with pytest.raises(ValueError, match="manifest|record|provenance"):
        export_snapshot(*collections, source_id="demo-guide")


def test_publish_fails_when_persisted_manifest_reads_back_invalid(
        sources, collections):
    def corrupt(query, update, _upsert):
        if query["_id"] == "active:manifest":
            update["$setOnInsert"]["generation"] = "corrupted-on-write"

    collections[1].before_update = corrupt
    with pytest.raises(ValueError, match="manifest"):
        _run(sources[0], collections)


def test_duplicate_delivery_scope_cannot_publish_invalid_manifest(
        sources, collections):
    dual = deepcopy(sources[0])
    dual["accounts"] = [
        {"id": "account-1", "name": "Same Shop", "platform": "shopee"},
        {"id": "account-2", "name": "Same Shop", "platform": "shopee"},
    ]
    with pytest.raises(ValueError, match="account scope"):
        _run(dual, collections)
    assert "active:manifest" not in collections[1].docs
    assert not collections[0].docs


def test_distinct_delivery_scope_publishes_complete_revision(
        sources, collections):
    dual = deepcopy(sources[0])
    dual["accounts"] = [
        {"id": "a1", "name": "Shop One", "platform": "shopee"},
        {"id": "a2", "name": "Shop Two", "platform": "shopee"},
    ]
    result = _run(dual, collections)
    assert result["published"] is True
    record_ids = _record_ids(collections[1], "demo-cable")
    assert len(record_ids) == 4
    assert len({collections[1].docs[rid]["shop"] for rid in record_ids}) == 2


def test_bounded_retry_rejects_corrupt_persisted_manifest_readback(
        sources, collections):
    """Retry-CAS winner must not trust pointer equality on corrupt readback."""
    injected = []

    def race(row):
        if not injected:
            injected.append(_run(sources[1], collections))
        return extraction(row)

    writes = []

    def corrupt_retry(_query, update, _upsert):
        if "$set" in update:
            update["$set"]["generation"] = "corrupt-after-retry"
            writes.append(True)
        else:
            collections[1].before_update = corrupt_retry

    collections[1].before_update = corrupt_retry
    with pytest.raises(ValueError, match="manifest"):
        _run(sources[0], collections, extractor=race)
    assert injected[0]["published"] is True
    assert writes


def test_renamed_file_keeps_semantic_revision_fresh_build(
        sources, collections, tmp_path):
    """Filename is audit-only: fresh build of renamed same-bytes source."""
    first = _run(sources[0], collections)
    fresh = MemoryCollection(), MemoryCollection()
    second = _run(_rename(sources[0], tmp_path), fresh, files_dir=tmp_path)
    assert second["revision_id"] == first["revision_id"]
    assert {r["record_id"] for r in fresh[1].docs.values()
            if r.get("record_id")} == {
        r["record_id"] for r in collections[1].docs.values()
        if r.get("record_id")}
    assert {r["source_file"] for r in fresh[0].docs.values()} == {"renamed.xlsx"}


def test_import_and_cas_use_bounded_queries(sources, collections):
    """Import/CAS paths must not run full-collection scans."""
    _run(sources[0], collections)
    for coll in collections:
        coll.queries.clear()
    _run(sources[0], collections)
    _run(sources[1], collections)
    queries = collections[0].queries + collections[1].queries
    assert queries
    assert all(query and set(query) <= {"_id", "source_id"}
               for query in queries)


def test_scoped_export_queries_are_bounded(sources, collections, tmp_path):
    """Contract correction: scoped export never scans raw/canonical history."""
    _run(sources[0], collections)
    _run(_replacement(sources[0], tmp_path), collections, files_dir=tmp_path)
    _run(sources[1], collections)
    for coll in collections:
        coll.queries.clear()
    export_snapshot(*collections, source_id="demo-guide")
    raw_queries, record_queries = (c.queries for c in collections)
    assert all(query and set(query) == {"source_id"} for query in raw_queries)
    assert {"source_id": "demo-guide"} in raw_queries
    assert {"source_id": "demo-guide"} in record_queries
    assert {"source_id": "demo-cable"} not in record_queries
    assert all(query and set(query) <= {"_id", "source_id"}
               for query in record_queries)


def _rename(item, folder, name="renamed.xlsx"):
    renamed = deepcopy(item)
    renamed["downloaded_file"]["file"] = name
    (folder / name).write_bytes(
        (FIXTURES / "knowledge-files" / "cables.xlsx").read_bytes())
    return renamed


def test_rename_without_active_manifest_converges_and_reuses_checkpoint(
        sources, collections, tmp_path):
    checkpoint = tmp_path / "cp.json"
    first = _run(sources[0], collections, checkpoint=checkpoint)
    del collections[1].docs["active:manifest"]
    history = deepcopy(collections[1].docs)
    second = _run(_rename(sources[0], tmp_path), collections, files_dir=tmp_path,
                  checkpoint=checkpoint,
                  extractor=lambda _row: pytest.fail("provider re-called"))
    assert second["published"] is True
    assert second["revision_id"] == first["revision_id"]
    assert {k: v for k, v in collections[1].docs.items()
            if k != "active:manifest"} == history
    assert {r["source_file"] for r in collections[0].docs.values()} == {
        "cables.xlsx"}


def test_first_publication_race_with_renamed_file_converges(
        sources, collections, tmp_path):
    renamed = _rename(sources[0], tmp_path)
    advanced = []

    def race(row):
        if not advanced:
            advanced.append(_run(sources[0], collections))
        return extraction(row)

    result = _run(renamed, collections, files_dir=tmp_path, extractor=race)
    assert result["published"] is True
    assert result["revision_id"] == advanced[0]["revision_id"]
    assert len(collections[0].docs) == 2
    assert len(_record_ids(collections[1], "demo-cable")) == 2


def test_rename_after_identity_bearing_raw_corruption_still_rejects(
        sources, collections, tmp_path):
    _run(sources[0], collections)
    del collections[1].docs["active:manifest"]
    raw = next(iter(collections[0].docs.values()))
    raw["text"] = "tampered"
    with pytest.raises(ValueError):
        _run(_rename(sources[0], tmp_path), collections, files_dir=tmp_path)


def test_same_filename_changed_bytes_is_new_revision(
        sources, collections, tmp_path):
    first = _run(sources[0], collections)
    del collections[1].docs["active:manifest"]
    changed = _replacement(sources[0], tmp_path, name="cables.xlsx")
    second = _run(changed, collections, files_dir=tmp_path)
    assert second["published"] is True
    assert second["revision_id"] != first["revision_id"]


def test_same_store_changed_scope_without_manifest_is_new_revision(
        sources, collections):
    first = _run(sources[0], collections)
    del collections[1].docs["active:manifest"]
    changed = deepcopy(sources[0])
    changed["accounts"][0]["name"] = "Renamed Shop"
    second = _run(changed, collections)
    assert second["published"] is True
    assert second["revision_id"] != first["revision_id"]


def test_scoped_export_ignores_unrelated_inactive_malformed_history(
        sources, collections):
    _run(sources[0], collections)
    _run(sources[1], collections)
    collections[0].docs["raw:ghost"] = {
        "_id": "raw:ghost", "source_id": "ghost", "junk": True}
    snapshot = export_snapshot(*collections, source_id="demo-guide")
    assert "ghost" not in snapshot
    with pytest.raises(ValueError, match="raw"):
        export_snapshot(*collections)
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(snapshot, *restored)
    assert set(_active_sources(restored[1])) == {"demo-guide"}


def test_scoped_export_rejects_selected_source_malformed_raw_history(
        sources, collections):
    _run(sources[0], collections)
    _run(sources[1], collections)
    collections[0].docs["raw:bad"] = {
        "_id": "raw:bad", "source_id": "demo-guide", "junk": True}
    with pytest.raises(ValueError, match="raw"):
        export_snapshot(*collections, source_id="demo-guide")


@pytest.mark.parametrize("stage", ("initial", "cas_loser"))
def test_conflict_semantics_match_initial_and_cas_loser(
        sources, collections, stage):
    def duplicate_fact(row):
        return {**extraction(row), "record_type": "spec",
                "topic": "cable capacity", "model_codes": ["CB-100"],
                "item_id": "1001",
                "facts": [{"key": "power_capacity_w", "value": 120}],
                "answer_text": ""}

    advanced = []

    def race(row):
        if stage == "cas_loser" and not advanced:
            advanced.append(_run(sources[1], collections,
                                 extractor=duplicate_fact))
        return extraction(row)

    if stage == "initial":
        _run(sources[0], collections)
        result = _run(sources[1], collections, extractor=duplicate_fact)
        # v2: conflicting source publishes an all-quarantine revision
        assert set(_active_sources(collections[1])) == {
            "demo-cable", "demo-guide"}
        assert not result["row_map"]
        assert all(q["reason"] == "conflict"
                   for q in result["quarantined"])
        assert result["published"] is True
    else:
        result = _run(sources[0], collections, extractor=race)
        assert set(_active_sources(collections[1])) == {"demo-guide"}
        assert result["published"] is False
    assert result["readiness"] == "conflicted"


AUDIT_FIELDS = {"source_name", "source_type", "source_file", "import_batch",
                "zaapi_updated_at"}


def _mutated(value):
    if isinstance(value, bool):
        return not value
    if isinstance(value, int):
        return value + 1
    if isinstance(value, str):
        return value + "x"
    if value is None:
        return "x"
    if isinstance(value, dict):
        return {**value, "zz": "x"}
    return [{**value[0], "name": value[0]["name"] + "x"}]


def test_raw_field_partition_is_complete_and_disjoint():
    from shopeechat.kb_zaapi_schema import (
        RAW_AUDIT_FIELDS, RAW_CONTENT_FIELDS, RAW_STORAGE_FIELDS)
    identity = {"source_id", "version_id", "accounts", "fingerprint",
                "scope_fingerprint", "raw_row_json", "active"}
    groups = (identity, set(RAW_CONTENT_FIELDS), set(RAW_AUDIT_FIELDS))
    assert set(RAW_AUDIT_FIELDS) == AUDIT_FIELDS
    assert len(RAW_STORAGE_FIELDS) == len(set(RAW_STORAGE_FIELDS)) == sum(
        len(group) for group in groups)
    assert set(RAW_STORAGE_FIELDS) == set().union(*groups)


def test_concurrent_writers_with_different_filenames_converge(
        sources, collections, tmp_path):
    renamed = _rename(sources[0], tmp_path)
    barrier = Barrier(2)
    collections[0].before_raw = lambda: barrier.wait(timeout=5)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(_run, sources[0], collections),
                   pool.submit(_run, renamed, collections, files_dir=tmp_path)]
        results = [future.result() for future in futures]
    assert results[0]["revision_id"] == results[1]["revision_id"]
    assert any(result["published"] for result in results)
    assert all(result["published"] or result["publication_conflict"]
               for result in results)
    assert len(collections[0].docs) == 2
    assert {r["source_file"] for r in collections[0].docs.values()} <= {
        "cables.xlsx", "renamed.xlsx"}
    assert len(_record_ids(collections[1], "demo-cable")) == 2
    export_snapshot(*collections)


@pytest.mark.parametrize("field", sorted(
    ("source_id", "source_name", "version_id", "source_type", "accounts",
     "fingerprint", "scope_fingerprint", "source_file", "import_batch",
     "zaapi_updated_at", "kind", "sheet", "row_index", "source_row",
     "fields", "text", "raw_row_json", "active")))
def test_persisted_raw_field_mutation_matrix(
        sources, collections, field):
    first = _run(sources[0], collections)
    del collections[1].docs["active:manifest"]
    stored = collections[0].docs[next(iter(collections[0].docs))]
    stored[field] = _mutated(stored[field])
    kept = stored[field]
    if field in AUDIT_FIELDS:
        second = _run(sources[0], collections)
        assert second["published"] is True
        assert second["revision_id"] == first["revision_id"]
        assert stored[field] == kept
        assert len(collections[0].docs) == 2
    else:
        with pytest.raises(ValueError):
            _run(sources[0], collections)


@pytest.mark.parametrize("field", sorted(AUDIT_FIELDS | {"kind", "text"}))
@pytest.mark.parametrize("damage", ("missing", "extra"))
def test_persisted_raw_shape_damage_rejects(
        sources, collections, field, damage):
    _run(sources[0], collections)
    del collections[1].docs["active:manifest"]
    stored = next(iter(collections[0].docs.values()))
    if damage == "missing":
        del stored[field]
    else:
        stored["unexpected_" + field] = "x"
    with pytest.raises(ValueError):
        _run(sources[0], collections)


@pytest.mark.parametrize("change", ("name", "updated_at", "type"))
def test_candidate_audit_only_change_is_idempotent_without_manifest(
        sources, collections, change):
    first = _run(sources[0], collections)
    del collections[1].docs["active:manifest"]
    changed = deepcopy(sources[0])
    if change == "type":
        changed["version"]["type"] = "other"
    else:
        changed[change] = "changed"
    second = _run(changed, collections)
    assert second["published"] is True
    assert second["revision_id"] == first["revision_id"]
    assert len(collections[0].docs) == 2


def _many_rows(count):
    return [(f"CB-{i}", str(20000 + i), f"alias {i}", f"power_capacity_w={i + 1}")
            for i in range(count)]


def _three_account_item(item, folder, count):
    item = _replacement(item, folder, rows=_many_rows(count))
    item["accounts"] = [
        {"id": f"acc-{i}", "platform": "shopee", "name": f"Shop {i}"}
        for i in range(3)]
    return item


def _validation_work(count, tmp_path, monkeypatch):
    import shopeechat.kb_zaapi_schema as schema
    item = _three_account_item(json.loads((FIXTURES / "knowledge-sources.json")
                                          .read_text(encoding="utf-8"))["items"][0],
                               tmp_path, count)
    store = MemoryCollection(), MemoryCollection()
    _run(item, store, files_dir=tmp_path)
    calls = {"sanitize": 0, "fingerprint": 0}
    for name in calls:
        original = getattr(schema, name if name != "sanitize" else "sanitize_source_row")

        def counted(*args, _name=name, _original=original, **kwargs):
            calls[_name] += 1
            return _original(*args, **kwargs)

        monkeypatch.setattr(schema, name if name != "sanitize" else "sanitize_source_row", counted)
    importer.load_active_state(store[1], store[0], store[1].docs["active:manifest"])
    return calls


def test_provenance_validation_work_is_linear(tmp_path, monkeypatch):
    small = _validation_work(60, tmp_path, monkeypatch)
    monkeypatch.undo()
    large = _validation_work(120, tmp_path, monkeypatch)
    assert small["sanitize"] <= 2 * 60 and large["sanitize"] <= 2 * 120
    for name in small:
        assert large[name] < 2.5 * small[name]


def test_manifest_size_depends_on_sources_not_records(tmp_path):
    import bson
    sizes = []
    for count in (20, 200):
        item = _three_account_item(json.loads(
            (FIXTURES / "knowledge-sources.json").read_text(
                encoding="utf-8"))["items"][0], tmp_path, count)
        store = MemoryCollection(), MemoryCollection()
        _run(item, store, files_dir=tmp_path)
        manifest = store[1].docs["active:manifest"]
        assert "record_ids" not in manifest["sources"]["demo-cable"]
        sizes.append(len(bson.encode(manifest)))
    assert sizes[0] == sizes[1] < 4096


def test_manifest_budget_for_real_catalog_shape():
    import bson
    from hashlib import sha256
    from shopeechat.kb_zaapi_schema import (
        MANIFEST_POINTER_FIELDS, MONGO_BSON_MAX_BYTES, build_revision,
        fingerprint, validate_manifest)
    counts = [55692] + [(177267 - 55692) // 117] * 116 + [177267 - 55692 - 116 * ((177267 - 55692) // 117)]
    assert len(counts) == 118 and sum(counts) == 177267
    sources, largest = {}, None
    for index, count in enumerate(counts):
        revision = build_revision({
            "source_id": f"src-{index}", "source_fingerprint": "f" * 64,
            "source_revision": "v1", "scope_fingerprint": "s" * 64,
            "model_version": "m", "prompt_version": "p",
            "record_ids": [sha256(f"{index}:{i}".encode()).hexdigest()
                           for i in range(count)]})
        sources[f"src-{index}"] = {
            **{k: revision[k] for k in MANIFEST_POINTER_FIELDS
               if k != "revision_id"}, "revision_id": revision["_id"]}
        largest = largest or revision
    manifest = {"_id": "active:manifest", "schema_revision": 1,
                "sources": sources, "generation": fingerprint(sources)}
    assert validate_manifest(manifest)
    assert len(bson.encode(manifest)) < 1_000_000
    assert len(bson.encode(largest)) < MONGO_BSON_MAX_BYTES
    assert largest["record_count"] == 55692


def _revision_of(collection, source_id="demo-cable"):
    return collection.docs[_active_sources(collection)[source_id]["revision_id"]]


def test_revision_document_is_closed_history_not_authority(
        sources, collections, tmp_path):
    first = _run(sources[0], collections)
    revision = _revision_of(collections[1])
    assert set(revision) == {
        "_id", "schema_revision", "source_id", "active_revision",
        "source_fingerprint", "source_revision", "scope_fingerprint",
        "model_version", "prompt_version", "record_ids", "record_count",
        "row_map", "key_map", "quarantined", "expected_rev"}
    assert revision["_id"] == f"revision:demo-cable:{first['revision_id']}"
    assert revision["record_count"] == len(revision["record_ids"]) == 2
    second = _run(_replacement(sources[0], tmp_path), collections,
                  files_dir=tmp_path)
    assert second["revision_id"] != first["revision_id"]
    assert revision["_id"] in collections[1].docs
    assert _active_sources(collections[1])["demo-cable"]["revision_id"] != revision["_id"]
    del collections[1].docs["active:manifest"]
    assert not _active_sources(collections[1])


@pytest.mark.parametrize("tamper", (
    "record_count", "source_id", "active_revision", "extra", "missing",
    "reorder", "drop_record", "scope"))
def test_tampered_revision_document_rejects_import_and_export(
        sources, collections, tamper):
    _run(sources[0], collections)
    revision = _revision_of(collections[1])
    if tamper == "record_count":
        revision["record_count"] += 1
    elif tamper == "source_id":
        revision["source_id"] = "other"
    elif tamper == "active_revision":
        revision["active_revision"] = "f" * 64
    elif tamper == "extra":
        revision["unexpected"] = "x"
    elif tamper == "missing":
        del revision["record_count"]
    elif tamper == "reorder":
        revision["record_ids"].reverse()
    elif tamper == "drop_record":
        revision["record_ids"].pop()
        revision["record_count"] -= 1
    else:
        revision["scope_fingerprint"] = "0" * 64
    with pytest.raises(ValueError):
        _run(sources[0], collections)
    with pytest.raises(ValueError):
        export_snapshot(*collections)
    with pytest.raises(ValueError):
        export_snapshot(*collections, source_id="demo-cable")


def test_missing_revision_document_rejects_import_and_export(
        sources, collections):
    _run(sources[0], collections)
    del collections[1].docs[_active_sources(collections[1])["demo-cable"]["revision_id"]]
    with pytest.raises(ValueError):
        _run(sources[1], collections)
    with pytest.raises(ValueError):
        export_snapshot(*collections)


@pytest.mark.parametrize("kind,outcome", [
    (kind, outcome) for kind in ("raw", "record", "revision")
    for outcome in ("identical", "tampered", "audit_only")
    if kind == "raw" or outcome != "audit_only"])
def test_duplicate_key_race_converges_by_readback(
        sources, collections, kind, outcome):
    reference = MemoryCollection(), MemoryCollection()
    _run(sources[0], reference)
    pool = reference[0] if kind == "raw" else reference[1]
    target = collections[0] if kind == "raw" else collections[1]
    wanted = {
        "raw": lambda key: key.startswith("raw:"),
        "record": lambda key: len(key) == 64,
        "revision": lambda key: key.startswith("revision:")}[kind]
    key = next(k for k in sorted(pool.docs) if wanted(k))
    doc = deepcopy(pool.docs[key])
    if outcome == "tampered":
        doc["text" if kind == "raw" else "topic" if kind == "record"
            else "record_count"] = 999 if kind == "revision" else "x"
    elif outcome == "audit_only":
        doc["source_name"] = "other name"
    target.lose_race[key] = doc
    if outcome == "tampered":
        with pytest.raises(ValueError):
            _run(sources[0], collections)
    else:
        result = _run(sources[0], collections)
        assert result["published"] is True
        assert target.docs[key] == doc
    assert target.upserts[key] == 1


def test_non_duplicate_database_error_is_not_swallowed(sources, collections):
    class Boom(RuntimeError):
        pass

    original = collections[0].update_one

    def failing(query, update, upsert=False):
        if query["_id"].startswith("raw:"):
            raise Boom("db down")
        return original(query, update, upsert)

    collections[0].update_one = failing
    with pytest.raises(Boom):
        _run(sources[0], collections)


def test_cas_retry_readback_queries_are_bounded(sources, collections):
    advanced = []

    def race(row):
        if not advanced:
            advanced.append(_run(sources[1], collections))
        return extraction(row)

    for coll in collections:
        coll.queries.clear()
    result = _run(sources[0], collections, extractor=race)
    assert result["published"] is True
    for coll in collections:
        assert all(query and set(query) <= {"_id", "source_id"}
                   for query in coll.queries)


def test_scoped_export_carries_only_selected_source_revisions(
        sources, collections, tmp_path):
    for source in sources:
        _run(source, collections)
    _run(_replacement(sources[0], tmp_path), collections, files_dir=tmp_path)
    snapshot = json.loads(export_snapshot(*collections, source_id="demo-cable"))
    assert {r["source_id"] for r in snapshot["revisions"]} == {"demo-cable"}
    assert len(snapshot["revisions"]) == 2
    assert snapshot["manifest"]["sources"]["demo-cable"]["revision_id"] in {
        r["_id"] for r in snapshot["revisions"]}
    full = json.loads(export_snapshot(*collections))
    assert {r["source_id"] for r in full["revisions"]} == {"demo-cable", "demo-guide"}
    assert len(full["revisions"]) == 3
    restored = MemoryCollection(), MemoryCollection()
    import_snapshot(canonical_json(snapshot), *restored)
    assert export_snapshot(*restored, source_id="demo-cable") == canonical_json(snapshot)


def test_scoped_export_rejects_unrelated_active_revision_corruption(
        sources, collections):
    for source in sources:
        _run(source, collections)
    _revision_of(collections[1], "demo-guide")["record_count"] += 1
    with pytest.raises(ValueError):
        export_snapshot(*collections, source_id="demo-cable")


def _history_store(sources, collections, tmp_path):
    _run(sources[0], collections)
    _run(_replacement(sources[0], tmp_path), collections, files_dir=tmp_path)
    active = set(_record_ids(collections[1], "demo-cable"))
    return active, [r for r in collections[1].docs.values()
                    if r.get("record_id") and r["record_id"] not in active]


@pytest.mark.parametrize("where", ("inactive", "active"))
@pytest.mark.parametrize("surface", ("full", "scoped", "snapshot"))
def test_canonical_storage_id_must_equal_record_id(
        sources, collections, tmp_path, where, surface):
    active, history = _history_store(sources, collections, tmp_path)
    target = next(iter(active)) if where == "active" else history[0]["record_id"]
    if surface == "snapshot":
        dump = json.loads(export_snapshot(*collections))
        next(r for r in dump["records"] if r["record_id"] == target)["_id"] = "bad-id"
        with pytest.raises(ValueError):
            import_snapshot(canonical_json(dump), MemoryCollection(), MemoryCollection())
        return
    doc = collections[1].docs.pop(target)
    doc["_id"] = "bad-id"
    collections[1].docs["bad-id"] = doc
    with pytest.raises(ValueError):
        export_snapshot(*collections, **(
            {"source_id": "demo-cable"} if surface == "scoped" else {}))


@pytest.mark.parametrize("surface", ("full", "scoped", "snapshot"))
def test_duplicate_canonical_record_with_different_storage_id_rejects(
        sources, collections, tmp_path, surface):
    _, history = _history_store(sources, collections, tmp_path)
    if surface == "snapshot":
        dump = json.loads(export_snapshot(*collections))
        dump["records"].append({**dump["records"][0], "_id": "duplicate-id"})
        with pytest.raises(ValueError):
            import_snapshot(canonical_json(dump), MemoryCollection(), MemoryCollection())
        return
    collections[1].docs["duplicate-id"] = {**history[0], "_id": "duplicate-id"}
    with pytest.raises(ValueError):
        export_snapshot(*collections, **(
            {"source_id": "demo-cable"} if surface == "scoped" else {}))


def test_canonical_storage_identity_control_accepts_valid_history(
        sources, collections, tmp_path):
    _history_store(sources, collections, tmp_path)
    for kwargs in ({}, {"source_id": "demo-cable"}):
        dump = export_snapshot(*collections, **kwargs)
        import_snapshot(dump, MemoryCollection(), MemoryCollection())


def _revision_source(**override):
    return {"source_id": "s", "source_fingerprint": "f" * 64,
            "source_revision": "v1", "scope_fingerprint": "c" * 64,
            "model_version": "m", "prompt_version": "p",
            "record_ids": ["r1", "r2"], **override}


def test_revision_bson_gate_is_exact_encoded_size():
    import bson
    from shopeechat.kb_zaapi_schema import MONGO_BSON_MAX_BYTES, build_revision
    assert MONGO_BSON_MAX_BYTES == 16 * 1024 * 1024
    overhead = len(bson.encode(build_revision(_revision_source(record_ids=["a"])))) - 1
    fits = build_revision(_revision_source(
        record_ids=["a" * (MONGO_BSON_MAX_BYTES - overhead)]))
    assert len(bson.encode(fits)) == MONGO_BSON_MAX_BYTES
    for oversized in (
            _revision_source(record_ids=["a" * (MONGO_BSON_MAX_BYTES - overhead + 1)]),
            _revision_source(model_version="x" * (MONGO_BSON_MAX_BYTES + 1)),
            _revision_source(record_ids=["b" * 6_000_000, "c" * 6_000_000,
                                         "d" * 6_000_000])):
        with pytest.raises(ValueError, match="BSON"):
            build_revision(oversized)


def test_manifest_bson_gate_rejects_oversize_and_accepts_catalog_shape():
    import bson
    from shopeechat.kb_zaapi_schema import (
        MONGO_BSON_MAX_BYTES, fingerprint, validate_manifest)
    pointer = {"revision_id": "revision:s:x", "source_id": "s",
               "active_revision": "x", "source_fingerprint": "f",
               "scope_fingerprint": "c", "source_revision": "v1",
               "model_version": "m", "prompt_version": "p",
               "schema_revision": 1, "record_count": 1}

    def manifest(**override):
        sources = {"s": {**pointer, **override}}
        return {"_id": "active:manifest", "schema_revision": 1,
                "sources": sources, "generation": fingerprint(sources)}

    assert validate_manifest(manifest())
    huge = manifest(model_version="x" * MONGO_BSON_MAX_BYTES)
    assert len(bson.encode(huge)) > MONGO_BSON_MAX_BYTES
    with pytest.raises(ValueError, match="BSON"):
        validate_manifest(huge)


def test_oversize_revision_writes_nothing(sources, collections, monkeypatch):
    import shopeechat.kb_zaapi_schema as schema
    monkeypatch.setattr(schema, "MONGO_BSON_MAX_BYTES", 1)
    with pytest.raises(ValueError, match="BSON"):
        _run(sources[0], collections)
    assert not collections[0].docs and not collections[1].docs


def test_oversize_manifest_is_rejected_before_cas(
        sources, collections, monkeypatch):
    import bson
    import shopeechat.kb_zaapi_schema as schema
    item = {**sources[0], "id": "demo-" + "x" * 3000}
    reference = MemoryCollection(), MemoryCollection()
    _run(item, reference)
    manifest = reference[1].docs["active:manifest"]
    revision = next(r for r in reference[1].docs.values()
                    if str(r["_id"]).startswith("revision:"))
    low, high = sorted(
        (len(bson.encode(revision)), len(bson.encode(manifest))))
    assert low < high
    monkeypatch.setattr(schema, "MONGO_BSON_MAX_BYTES", (low + high) // 2)
    with pytest.raises(ValueError, match="BSON"):
        _run(item, collections)
    assert "active:manifest" not in collections[1].docs


@pytest.mark.parametrize("junk,surface,rejects", [
    ({"_id": "junk", "foo": 1}, {}, True),
    ({"_id": "junk-selected", "source_id": "demo-cable", "foo": 1},
     {"source_id": "demo-cable"}, True),
    ({"_id": "junk-selected", "source_id": "demo-cable", "foo": 1}, {}, True),
    ({"_id": "junk-other", "source_id": "demo-guide", "foo": 1},
     {"source_id": "demo-cable"}, False),
    ({"_id": "junk-other", "source_id": "demo-guide", "foo": 1}, {}, True),
    ({"_id": "junk"}, {"source_id": "demo-cable"}, False),
    ({"_id": "revision:demo-cable:bogus", "source_id": "demo-cable"},
     {"source_id": "demo-cable"}, True),
])
def test_zaapi_records_collection_is_closed_for_export(
        sources, collections, junk, surface, rejects):
    for source in sources:
        _run(source, collections)
    collections[1].docs[junk["_id"]] = deepcopy(junk)
    if rejects:
        with pytest.raises(ValueError):
            export_snapshot(*collections, **surface)
    else:
        assert export_snapshot(*collections, **surface)


def test_zaapi_records_collection_accepts_exactly_manifest_revisions_records(
        sources, collections):
    for source in sources:
        _run(source, collections)
    dump = json.loads(export_snapshot(*collections))
    assert dump["manifest"]["_id"] == "active:manifest"
    assert len(dump["revisions"]) == 2
    assert all(r["_id"] == r["record_id"] for r in dump["records"])
    kinds = {"manifest" if k == "active:manifest" else
             "revision" if k.startswith("revision:") else "record"
             for k in collections[1].docs}
    assert kinds == {"manifest", "revision", "record"}


@pytest.mark.parametrize("mutate", [
    lambda dump: dump["records"].append({"_id": "junk", "foo": 1}),
    lambda dump: dump["revisions"].append({"_id": "junk", "foo": 1}),
    lambda dump: dump["revisions"].append({"_id": "revision:demo-cable:bogus"}),
    lambda dump: dump["records"][0].update(_id="other"),
    lambda dump: dump.update(unknown=[]),
    lambda dump: dump["manifest"].update(unknown=1),
])
def test_snapshot_import_rejects_unknown_documents_before_any_write(
        sources, collections, mutate):
    _run(sources[0], collections)
    dump = json.loads(export_snapshot(*collections))
    mutate(dump)
    restored = MemoryCollection(), MemoryCollection()
    with pytest.raises(ValueError):
        import_snapshot(canonical_json(dump), *restored)
    assert not restored[0].docs and not restored[1].docs


LEGACY_SENTINEL = {"_id": "legacy-sentinel", "source_id": "legacy-source",
                   "active": True, "text": "legacy runtime row"}


class LegacyCollection(MemoryCollection):
    """Legacy `zaapi_kb`: any read/write/index call fails the test at once."""

    def __init__(self):
        super().__init__()
        self.docs = {LEGACY_SENTINEL["_id"]: deepcopy(LEGACY_SENTINEL)}

    def _forbidden(self, *_args, **_kwargs):
        raise AssertionError("legacy zaapi_kb accessed by Task 3")

    update_one = find = find_one = create_index = _forbidden


class FakeAdmin:
    def __init__(self):
        self.store = {"zaapi_kb": LegacyCollection()}
        self.trace = []

    def __getitem__(self, name):
        self.trace.append(name)
        return self.store.setdefault(name, MemoryCollection())

    def close(self):
        pass


class _Client:
    def __init__(self, fake):
        self.fake = fake

    def __getitem__(self, _db_name):
        return self.fake

    def close(self):
        self.fake.close()


@pytest.fixture
def admin(monkeypatch):
    monkeypatch.delenv("ADMIN_MONGO_COLLECTION_ZAAPI_KB", raising=False)
    fake = FakeAdmin()
    monkeypatch.setattr(importer, "_get_admin_db", lambda: _Client(fake))
    return fake


def test_import_cli_apply_routes_raw_and_canonical_to_dedicated_collections(
        admin, monkeypatch):
    monkeypatch.setattr(importer, "_gemini_extract", extraction)
    monkeypatch.setattr(sys, "argv", [
        "import_zaapi_kb.py", "--apply", "--canonicalize",
        "--dir", str(FIXTURES)])
    legacy_before = deepcopy(admin.store["zaapi_kb"].docs)
    assert importer.main() == 0
    assert set(admin.trace) == {
        "zaapi_kb_raw_sources", "zaapi_kb_records",
        "zaapi_kb_source_registry", "zaapi_kb_import_log"}
    raw = admin.store["zaapi_kb_raw_sources"].docs
    records = admin.store["zaapi_kb_records"].docs
    assert raw and all(key.startswith("raw:") for key in raw)
    assert "active:manifest" in records
    assert any(key.startswith("revision:") for key in records)
    assert any(doc.get("record_id") for doc in records.values())
    assert not any(key.startswith("raw:") for key in records)
    assert admin.store["zaapi_kb"].docs == legacy_before


def test_export_cli_reads_only_dedicated_collections(
        admin, monkeypatch, tmp_path, sources):
    raw = admin.store.setdefault("zaapi_kb_raw_sources", MemoryCollection())
    records = admin.store.setdefault("zaapi_kb_records", MemoryCollection())
    for source in sources:
        _run(source, (raw, records))
    raw.queries.clear()
    records.queries.clear()
    admin.trace.clear()
    output = tmp_path / "snapshot.json"
    monkeypatch.setattr(sys, "argv", [
        "export_zaapi_kb.py", "--output", str(output)])
    assert exporter.main() == 0
    assert set(admin.trace) == {"zaapi_kb_raw_sources", "zaapi_kb_records"}
    assert raw.queries and records.queries
    assert output.read_text(encoding="utf-8").strip() == export_snapshot(
        raw, records)
    assert admin.store["zaapi_kb"].docs == {
        LEGACY_SENTINEL["_id"]: LEGACY_SENTINEL}


def test_runtime_corpus_stays_legacy_collection_and_is_never_a_raw_target(admin):
    import importlib
    import shopeechat.kb_zaapi as kb_zaapi
    import shopeechat.knowledge_base as knowledge_base
    with pytest.MonkeyPatch.context() as local:
        local.delenv("ADMIN_MONGO_COLLECTION_ZAAPI_KB", raising=False)
        importlib.reload(kb_zaapi)
        local.setattr(knowledge_base, "_admin_db", lambda: admin)
        assert kb_zaapi._COLL == "zaapi_kb"
        assert importer.ZA_KB_RAW_COLL == "zaapi_kb_raw_sources"
        assert importer.ZA_KB_RAW_COLL != kb_zaapi._COLL
        # Task 5: runtime = immutable Phase 4 artifacts only — canonical
        #   collection must have no per-request reader on the adapter
        assert not hasattr(kb_zaapi, "_zaapi_coll")
        assert admin.trace == []
    importlib.reload(kb_zaapi)


_XLSX_SECRETS = ("sentinel-login-7f3a", "sentinel-wifi-91bc")


def _credential_header_item(sources, folder, headers, values):
    book = Workbook()
    sheet = book.active
    sheet.title = "Creds"
    sheet.append(headers)
    sheet.append(values)
    path = folder / "creds.xlsx"
    book.save(path)
    book.close()
    item = deepcopy(sources[0])
    item["downloaded_file"] = {
        "file": "creds.xlsx", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    return item


def _capture_run(item, folder, collections, checkpoint=None):
    seen = []

    def capture(row):
        seen.append(deepcopy(row))
        return {
            "record_type": "spec", "topic": "credential header",
            "model_codes": [row["fields"]["model_code"]], "aliases": [],
            "item_id": row["fields"]["item_id"], "model_id": None,
            "subject_id": None, "target_id": None,
            "facts": [{"key": "ok", "value": 1}], "answer_text": "", "steps": []}
    importer.import_source(item, folder, *collections, extractor=capture,
                           canonicalize=True, apply=True, checkpoint=checkpoint)
    return seen


def test_structured_xlsx_colon_credential_headers_redacted_everywhere(
        sources, collections, tmp_path):
    headers = ("model_code", "item_id", "Login: Password", "Wi-Fi:Password")
    item = _credential_header_item(
        sources, tmp_path, headers, ("CB-100", "1001", *_XLSX_SECRETS))
    checkpoint = tmp_path / "cp.json"
    seen = _capture_run(item, tmp_path, collections, checkpoint)
    dump = export_snapshot(*collections)
    canonical = canonical_json(list(collections[1].docs.values()))
    raw_store = canonical_json(list(collections[0].docs.values()))
    provider = canonical_json(seen)
    leaked = {
        "provider": any(s in provider for s in _XLSX_SECRETS),
        "export": any(s in dump for s in _XLSX_SECRETS),
        "canonical": any(s in canonical for s in _XLSX_SECRETS),
        "checkpoint": any(s in checkpoint.read_text(encoding="utf-8")
                          for s in _XLSX_SECRETS),
    }
    assert leaked == dict.fromkeys(leaked, False)
    assert all(s in raw_store for s in _XLSX_SECRETS)
    assert len(seen) == 1
    assert seen[0]["fields"] == {
        "model_code": "CB-100", "item_id": "1001",
        "Login: Password": "[redacted]", "Wi-Fi:Password": "[redacted]"}
    assert seen[0]["text"] == (
        "model_code: CB-100\nitem_id: 1001\n"
        "Login: Password: [redacted]\nWi-Fi:Password: [redacted]")
    assert importer.import_snapshot(dump, *(type(c)() for c in collections)) is None


def test_structured_xlsx_standard_and_colon_noncredential_headers(
        sources, collections, tmp_path):
    headers = ("model_code", "item_id", "API_KEY", "password", "Note: Model")
    item = _credential_header_item(
        sources, tmp_path, headers, ("CB-100", "1001", *_XLSX_SECRETS, "A1"))
    seen = _capture_run(item, tmp_path, collections)
    assert seen[0]["text"] == (
        "model_code: CB-100\nitem_id: 1001\nAPI_KEY: [redacted]\n"
        "password: [redacted]\nNote: Model: A1")
    assert seen[0]["fields"]["Note: Model"] == "A1"
    assert not any(s in export_snapshot(*collections) for s in _XLSX_SECRETS)


def test_freeform_text_rows_keep_line_level_redaction():
    from shopeechat.kb_zaapi_schema import sanitize_source_row
    raw = {"kind": "text", "fields": {}, "accounts": [], "text": (
        "Admin password: pw1\nLogin: Password: pw2\nModel: A1")}
    assert sanitize_source_row(raw)["text"] == (
        "Admin password: [redacted]\nLogin: Password: pw2\nModel: A1")


@pytest.mark.parametrize("fields,text", [
    ({"Model": "A", "Password": "secret"}, "Model: A"),
    ({"Model": "A", "Password": "secret"}, "Model: A\nModel: A"),
    ({"a": "b: c", "a: b": "c"}, "a: b: c\na: b: c"),
    ({"a": "b: c", "a: b": "c"}, "a: b: c"),
])
def test_xlsx_text_must_be_exact_permutation_of_field_lines(fields, text):
    from shopeechat.kb_zaapi_schema import sanitize_source_row
    with pytest.raises(ValueError, match="invalid raw row"):
        sanitize_source_row({"kind": "xlsx_row", "fields": fields,
                             "text": text, "accounts": []})


def test_xlsx_reordered_valid_lines_accepted_and_order_preserved():
    from shopeechat.kb_zaapi_schema import sanitize_source_row
    fields = {"Model": "A", "Password": "secret", "Note: X": "y"}
    text = "Note: X: y\nPassword: secret\nModel: A"
    safe = sanitize_source_row({"kind": "xlsx_row", "fields": fields,
                                "text": text, "accounts": []})
    assert safe["text"] == "Note: X: y\nPassword: [redacted]\nModel: A"
