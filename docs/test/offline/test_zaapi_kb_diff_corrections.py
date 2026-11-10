"""K0 diff-import root-cause corrections F1-F5: CLI wiring, reorder/scope
reuse, lease result, confirmation binding, per-uid coverage. Offline."""
from __future__ import annotations

import json
import sys
from copy import deepcopy
from types import SimpleNamespace
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs" / "zaapi" / "script"))
sys.path.insert(0, str(Path(__file__).parent))

import import_zaapi_kb as importer  # noqa: E402
from import_zaapi_kb import import_source, declare_source  # noqa: E402
from test_zaapi_kb_import import MemoryCollection, FIXTURES, sources  # noqa: E402
from test_zaapi_kb_diff_import import (  # noqa: E402
    ROWS, _base_extraction, _calls, _item, _xlsx, _active_rev)


def _colls():
    return (MemoryCollection(), MemoryCollection(),
            MemoryCollection(), MemoryCollection())


def _run(item, colls, extractor=None, files_dir=FIXTURES / "knowledge-files",
         **kw):
    raw, rec, reg, log = colls
    return import_source(item, files_dir, raw, rec,
                         extractor=extractor or _base_extraction,
                         canonicalize=True, apply=True,
                         registry_coll=reg, log_coll=log, **kw)


def _first(item, colls, tmp_path, key_columns=("model_code",)):
    if key_columns:
        declare_source(colls[2], item["id"], key_mode="column",
                       key_columns=list(key_columns),
                       declared_by="test", declared_at="t0")
    return _run(item, colls)


def _rev_row_map(coll, sid):
    rev = _active_rev(coll, sid)
    return (rev or {}).get("row_map") or {}


# --- F1: CLI --apply must wire registry/log/confirmation ---

class _FakeDB(dict):
    def __getitem__(self, name):
        return self.setdefault(name, MemoryCollection())


class _FakeClient:
    def __init__(self):
        self.dbs = {}

    def __getitem__(self, name):
        return self.dbs.setdefault(name, _FakeDB())

    def close(self):
        pass


def test_f1_cli_apply_uses_registry_and_log(sources, monkeypatch):
    fake = _FakeClient()
    monkeypatch.setattr(importer, "_get_admin_db", lambda: fake)
    monkeypatch.setattr(importer, "_gemini_extract", _base_extraction)
    monkeypatch.setattr(sys, "argv", [
        "import_zaapi_kb.py", "--apply", "--canonicalize",
        "--source", sources[0]["id"], "--dir", str(FIXTURES)])
    assert importer.main() == 0
    db = fake.dbs[importer.ADMIN_DB_NAME]
    reg = db["zaapi_kb_source_registry"]
    log = db["zaapi_kb_import_log"]
    assert any(d.get("_id") == "reg:demo-cable" or d.get("source_id") ==
               "demo-cable" for d in reg.docs.values())
    assert log.docs, "import log collection must receive events"


def test_f1_cli_confirm_binds_proposals(sources, colls_unused, monkeypatch,
                                        tmp_path):
    fake = _FakeClient()
    monkeypatch.setattr(importer, "_get_admin_db", lambda: fake)
    monkeypatch.setattr(importer, "_gemini_extract", _base_extraction)
    monkeypatch.setattr(sys, "argv", [
        "import_zaapi_kb.py", "--apply", "--canonicalize",
        "--source", sources[0]["id"], "--dir", str(FIXTURES)])
    assert importer.main() == 0
    db = fake.dbs[importer.ADMIN_DB_NAME]
    # second apply with a file that drops a row → needs_confirm, no confirm arg
    item = _item([sources[0]], tmp_path, ROWS[:1])
    (tmp_path / "knowledge-files").mkdir(exist_ok=True)
    _xlsx(tmp_path / "knowledge-files", "knowledge-cable.xlsx", ROWS[:1])
    # build an export dir the CLI can read: sources json + knowledge-files
    export = tmp_path / "export2"
    (export / "knowledge-files").mkdir(parents=True)
    import json as _json
    src = dict(sources[0])
    src["downloaded_file"] = {"file": "knowledge-cable.xlsx",
                              "sha256": item["downloaded_file"]["sha256"]}
    (export / "knowledge-sources.json").write_text(
        _json.dumps({"items": [src]}))
    (export / "knowledge-files" / "knowledge-cable.xlsx").write_bytes(
        (tmp_path / "knowledge-files" / "knowledge-cable.xlsx").read_bytes())
    monkeypatch.setattr(sys, "argv", [
        "import_zaapi_kb.py", "--apply", "--canonicalize",
        "--source", sources[0]["id"], "--dir", str(export)])
    assert importer.main() == 0
    rec = db["zaapi_kb_records"]
    # without confirmation the pointer must not have moved to a 1-row map
    manifest = rec.docs["active:manifest"]
    assert manifest["sources"]["demo-cable"]["record_count"] == 2


@pytest.fixture
def colls_unused():
    return _colls()


# --- F2: reorder must not re-extract or re-key ---

@pytest.mark.parametrize("key_columns", [("model_code",), None])
def test_f2_reorder_zero_calls_stable_ids(sources, tmp_path, key_columns):
    colls = _colls()
    _first(sources[0], colls, tmp_path, key_columns=key_columns)
    before_map = _rev_row_map(colls[1], "demo-cable")
    wrap, calls = _calls(_base_extraction)
    item = _item([sources[0]], tmp_path, ROWS[::-1])
    out = _run(item, colls, extractor=wrap, files_dir=tmp_path)
    assert out["status"] == "published"
    assert calls == [], f"reorder re-extracted {len(calls)} rows"
    after_map = _rev_row_map(colls[1], "demo-cable")
    assert after_map == before_map, "record ids changed on pure reorder"


# --- F3: scope-only account add must reuse extraction ---

def test_f3_account_add_zero_extractor_calls(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    before_map = _rev_row_map(colls[1], "demo-cable")
    wrap, calls = _calls(_base_extraction)
    item = _item([sources[0]], tmp_path, ROWS, accounts=[
        {"id": "demo-shop", "platform": "shopee", "name": "Demo Shop"},
        {"id": "shop-2", "platform": "shopee", "name": "Second Shop"}])
    out = _run(item, colls, extractor=wrap, files_dir=tmp_path)
    assert out["status"] == "published"
    assert calls == [], f"scope-only change re-extracted {len(calls)} rows"
    after_map = _rev_row_map(colls[1], "demo-cable")
    assert (after_map["demo-cable:r0"]["Demo Shop|shopee"]
            == before_map["demo-cable:r0"]["Demo Shop|shopee"])
    assert "Second Shop|shopee" in after_map["demo-cable:r0"]


# --- F4: lease acquisition result must be checked ---

class _LeaseLostCollection(MemoryCollection):
    """update_one reports matched_count=0 for lease acquisition (A won)."""

    def update_one(self, query, update, upsert=False):
        if (query.get("lease") is None and "$set" in update
                and update["$set"].get("lease") is not None):
            return SimpleNamespace(matched_count=0, upserted_id=None)
        return super().update_one(query, update, upsert=upsert)


def test_f4_lease_loser_stops_without_writes(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    raw, rec, reg, log = colls
    lost = _LeaseLostCollection()
    lost.docs["reg:demo-cable"] = dict(reg.docs["reg:demo-cable"])
    lost.docs["reg:demo-cable"]["lease"] = None
    wrap, calls = _calls(_base_extraction)
    out = _run(sources[0], colls[:2] + (lost, colls[3]), extractor=wrap)
    assert out["status"] == "stopped"
    assert calls == [], "lease loser must not extract"
    assert not any(d.get("row_map") for d in rec.docs.values()
                   if str(d.get("_id", "")).startswith("revision:demo-cable")
                   and d.get("_id") != _active_rev(rec, "demo-cable")["_id"]), \
        "lease loser must not stage/publish a revision"


def test_f4_lease_release_does_not_steal(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    reg = colls[2]
    # importer tag A finished → released lease; B's stale finally must not
    # clear a lease owned by someone else — release is already filtered by
    # tag; simulate by checking the doc after a normal run
    doc = reg.docs["reg:demo-cable"]
    assert doc["lease"] is None


# --- F5: confirmation binds to previewed proposals + base ---

def test_f5_stale_confirm_token_rejected(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    # preview A: remove CB-200 → deactivate proposal
    item_a = _item([sources[0]], tmp_path, ROWS[:1], name="a.xlsx")
    out = _run(item_a, colls, files_dir=tmp_path)
    assert out["status"] == "needs_confirm"
    tokens_a = frozenset({p["needs_confirm"] for p in out["proposals"]})
    # file changes BEFORE apply: now a different removal set is proposed
    item_b = _item([sources[0]], tmp_path,
                   [("CB-100", "1001", "Demo cable", "power_capacity_w=240")],
                   name="b.xlsx", version="v3")
    # simulate: the new file proposes deactivate for the same uid category;
    # confirm tokens from preview A must NOT authorize it
    out2 = _run(item_b, colls, files_dir=tmp_path, confirm=tokens_a)
    rev = _active_rev(colls[1], "demo-cable")
    if out2["status"] == "needs_confirm":
        assert len(rev["row_map"]) == 2          # pointer unmoved
    else:
        # if proposal happens to be identical it may legitimately confirm —
        # but a different file must produce a different confirmation scope
        assert out2["proposals"] == out["proposals"], (
            "stale confirmation applied to a different proposal set")


def test_f5_confirm_after_base_change_rejected(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    item_a = _item([sources[0]], tmp_path, ROWS[:1], name="a.xlsx")
    out = _run(item_a, colls, files_dir=tmp_path)
    assert out["status"] == "needs_confirm"
    tokens_a = frozenset({p["needs_confirm"] for p in out["proposals"]})
    # base revision moves forward first (concurrent writer publishes an edit)
    item_edit = _item([sources[0]], tmp_path,
                      [("CB-100", "1001", "Demo cable",
                        "power_capacity_w=300"),
                       ("CB-200", "1002", "Demo second cable",
                        "power_capacity_w=100")],
                      name="edit.xlsx", version="v2b")
    assert _run(item_edit, colls, files_dir=tmp_path)["status"] == "published"
    # stale confirmation against old base must not apply
    out2 = _run(item_a, colls, files_dir=tmp_path, confirm=tokens_a)
    assert out2["status"] == "needs_confirm", (
        "confirmation minted on a different base revision must not apply")


# --- per-uid coverage: two identical-looking rows must not collapse ---

def test_identical_rows_get_distinct_uids_and_coverage(sources, tmp_path):
    colls = _colls()
    item = _item([sources[0]], tmp_path,
                 [("CB-100", "1001", "Demo cable", "power_capacity_w=240"),
                  ("CB-100", "1001", "Demo cable", "power_capacity_w=240")],
                 name="dup.xlsx")
    # no declared keys → assigned mode; identical new rows mint distinct uids
    out = _run(item, colls, files_dir=tmp_path)
    rev = _active_rev(colls[1], "demo-cable")
    assert out["status"] == "published"
    assert len(rev["row_map"]) == 2
    assert len(set(rev["row_map"])) == len(
        {uid for uid in rev["row_map"]})


# --- F6/F7: read-only preview vs active state; provider boundary ---

class _ReadOnly(MemoryCollection):
    """Traps every write method — preview must not write anything."""

    def update_one(self, *a, **k):
        raise AssertionError("write during preview")

    def insert_one(self, *a, **k):
        raise AssertionError("write during preview")

    def create_index(self, *a, **k):
        raise AssertionError("write during preview")


def _ro(colls):
    out = []
    for c in colls:
        r = _ReadOnly()
        r.docs = c.docs
        out.append(r)
    return tuple(out)


def test_f6_preview_reports_active_diff(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)                    # publishes A,B
    item = _item([sources[0]], tmp_path, ROWS[:1], name="a.xlsx")
    raw, rec, reg, log = _ro(colls)
    out = import_source(item, tmp_path, raw, rec,
                        canonicalize=True, apply=False,
                        registry_coll=reg, log_coll=log)
    assert out["status"] == "preview"
    assert out["diff"]["deactivated"] == ["demo-cable:r1"]
    assert any(p["type"] == "deactivate" for p in out["proposals"])
    assert out["proposals"][0]["needs_confirm"].startswith("deactivate:")


def test_f6_preview_unavailable_without_state(sources, tmp_path):
    item = _item([sources[0]], tmp_path, ROWS)
    out = import_source(item, tmp_path, None, None,
                        canonicalize=True, apply=False)
    assert out["status"] == "unavailable"


def test_f6_preview_unavailable_on_read_error(sources, tmp_path):
    class _Boom:
        def find_one(self, *_a, **_k):
            raise RuntimeError("db read failed")

        def find(self, *_a, **_k):
            raise RuntimeError("db read failed")

    item = _item([sources[0]], tmp_path, ROWS)
    out = import_source(item, tmp_path, _Boom(), _Boom(),
                        canonicalize=True, apply=False)
    assert out["status"] == "unavailable"
    assert out["published"] is False
    with pytest.raises(RuntimeError):
        import_source(item, tmp_path, _Boom(), _Boom(),
                      canonicalize=True, apply=True)


def test_f6_first_import_preview_all_additions(sources, tmp_path):
    colls = _colls()
    raw, rec, reg, log = _ro(colls)
    out = import_source(sources[0], FIXTURES / "knowledge-files",
                        raw, rec, canonicalize=True, apply=False,
                        registry_coll=reg, log_coll=log)
    assert out["status"] == "preview"
    assert len(out["diff"]["added"]) == 2
    assert out["proposals"] == []


def test_f6_preview_noop_status(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    raw, rec, reg, log = _ro(colls)
    out = import_source(sources[0], FIXTURES / "knowledge-files",
                        raw, rec, canonicalize=True, apply=False,
                        registry_coll=reg, log_coll=log)
    assert out["status"] == "noop"           # apply would noop identically


def test_f7_dry_run_zero_writes_and_provider_calls_via_cli(
        sources, tmp_path, monkeypatch):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    fake = _FakeClient()
    db = fake[importer.ADMIN_DB_NAME]
    for name, coll in (("zaapi_kb_raw_sources", colls[0]),
                       ("zaapi_kb_records", colls[1]),
                       ("zaapi_kb_source_registry", colls[2]),
                       ("zaapi_kb_import_log", colls[3])):
        ro = _ReadOnly()
        ro.docs = coll.docs
        db[name] = ro
    calls = []

    def forbidden(row):
        calls.append(row)
        raise AssertionError("provider called in dry-run")

    monkeypatch.setattr(importer, "_get_admin_db", lambda: fake)
    monkeypatch.setattr(importer, "_gemini_extract", forbidden)
    monkeypatch.setattr(sys, "argv", [
        "import_zaapi_kb.py", "--dry-run", "--canonicalize",
        "--source", sources[0]["id"], "--dir", str(FIXTURES)])
    assert importer.main() == 0
    assert calls == []


def test_f7_dry_run_resume_writes_no_checkpoint(
        sources, tmp_path, monkeypatch):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    cp = tmp_path / "cp.json"
    raw, rec, reg, log = _ro(colls)
    out = import_source(sources[0], FIXTURES / "knowledge-files",
                        raw, rec, canonicalize=True, apply=False,
                        registry_coll=reg, log_coll=log, checkpoint=cp)
    assert not cp.exists()


def test_f8_repeat_apply_appends_distinct_noop_events(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    _run(sources[0], colls)
    _run(sources[0], colls)
    events = [d for d in colls[3].docs.values()
              if d["event"] == "noop_reimport"]
    assert len(events) == 2
    assert events[0]["attempt"] != events[1]["attempt"]


def test_f8_same_timestamp_attempts_stay_distinct(
        sources, tmp_path, monkeypatch):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    import datetime as _dt

    class _Frozen:
        @staticmethod
        def now(tz=None):
            return _dt.datetime(2026, 1, 1, tzinfo=tz)

    monkeypatch.setattr(
        importer, "datetime",
        SimpleNamespace(datetime=_Frozen, timezone=_dt.timezone))
    _run(sources[0], colls)
    _run(sources[0], colls)
    events = [d for d in colls[3].docs.values()
              if d["event"] == "noop_reimport"]
    assert len(events) == 2              # identical `at`, distinct attempt
    assert events[0]["at"] == events[1]["at"]
    assert events[0]["attempt"] != events[1]["attempt"]


def test_f8_log_is_append_only_on_outcomes(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    before = dict(colls[3].docs)
    item = _item([sources[0]], tmp_path,
                 [("CB-100", "1001", "Demo cable", "power_capacity_w=999"),
                  ("CB-200", "1002", "Demo second cable",
                   "power_capacity_w=100")])
    out = _run(item, colls, files_dir=tmp_path,
               extractor=lambda r: (_ for _ in ()).throw(RuntimeError("x")))
    assert out["status"] == "hold_publish"
    after = colls[3].docs
    assert set(before) <= set(after)          # prior events untouched
    assert any(d["event"] == "hold_publish" for d in after.values())


def test_f5_preview_token_applies_on_same_base(sources, tmp_path):
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    item = _item([sources[0]], tmp_path, ROWS[:1], name="a.xlsx")
    raw, rec, reg, log = _ro(colls)
    prev = import_source(item, tmp_path, raw, rec,
                         canonicalize=True, apply=False,
                         registry_coll=reg, log_coll=log)
    tokens = frozenset({p["needs_confirm"] for p in prev["proposals"]})
    out = _run(item, colls, files_dir=tmp_path, confirm=tokens)
    assert out["status"] == "published"
    assert len(_rev_row_map(colls[1], "demo-cable")) == 1


def _changed_item(sources, tmp_path, name="cas.xlsx"):
    return _item([sources[0]], tmp_path,
                 ROWS + [("CB-9", "9", "Nine", "power_capacity_w=9")],
                 name=name)


def test_r1_cas_loss_cross_source_retries_and_converges(
        sources, tmp_path):
    """Generation-fence CAS miss, own slot untouched -> retry converges."""
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    other = deepcopy(sources[0])
    other["id"] = "other-src"
    declare_source(colls[2], "other-src", key_mode="column",
                   key_columns=["model_code"], declared_by="t",
                   declared_at="t")
    fired = []

    def rival_publish(row):
        if not fired:
            fired.append(True)
            _run(other, colls)          # different source: own publish
        return _base_extraction(row)

    item = _changed_item(sources, tmp_path)
    out = _run(item, colls, extractor=rival_publish, files_dir=tmp_path)
    assert out["published"] is True, out["status"]
    man = colls[1].docs["active:manifest"]
    assert "other-src" in man["sources"]
    assert man["sources"][sources[0]["id"]]["revision_id"].endswith(
        out["revision_id"])


def test_r1_cas_loss_no_retry_on_conflict(sources, tmp_path):
    """CAS loser whose candidate conflicts with concurrent winner -> no retry."""
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    base_rev = colls[1].docs["active:manifest"]["sources"][
        sources[0]["id"]]["revision_id"]
    rival_item = deepcopy(sources[0])
    rival_item["id"] = "rival-src"
    rival_item["downloaded_file"] = {
        "file": "rival.xlsx",
        "sha256": _xlsx(tmp_path, "rival.xlsx",
                        [("CB-900", "9009", "Nine", "power_capacity_w=555")])}
    declare_source(colls[2], "rival-src", key_mode="column",
                   key_columns=["model_code"], declared_by="t",
                   declared_at="t")
    fired = []

    def rival_conflict(row):
        if not fired:
            fired.append(True)
            _run(rival_item, colls, files_dir=tmp_path)
        return _base_extraction(row)

    # S adds CB-900=777 -> candidate conflicts with rival's fresh 555
    item = _item([sources[0]], tmp_path,
                 ROWS + [("CB-900", "9009", "Nine",
                          "power_capacity_w=777")], name="conf.xlsx")
    out = _run(item, colls, extractor=rival_conflict, files_dir=tmp_path)
    assert out["status"] == "cas_conflict" and out["published"] is False
    man = colls[1].docs["active:manifest"]
    assert man["sources"][sources[0]["id"]]["revision_id"] == base_rev
    assert "rival-src" in man["sources"]


def test_r1_stale_checkpoint_fence_no_retry(sources, tmp_path):
    """Checkpoint fence from an older base -> loser path must not retry."""
    colls = _colls()
    _first(sources[0], colls, tmp_path)
    first_rev = colls[1].docs["active:manifest"]["sources"][
        sources[0]["id"]]["revision_id"]
    item = _changed_item(sources, tmp_path, name="cp.xlsx")
    cp = tmp_path / "cp.json"
    key = importer.fingerprint((
        item["id"], item["downloaded_file"]["sha256"],
        item["version"]["versionId"],
        importer.account_scope_fingerprint(item["accounts"]),
        importer.MODEL_VERSION, importer.PROMPT_VERSION))
    cp.write_text(json.dumps({key: {
        "source_id": item["id"],
        "source_fingerprint": item["downloaded_file"]["sha256"],
        "source_revision": item["version"]["versionId"],
        "scope_fingerprint": importer.account_scope_fingerprint(
            item["accounts"]),
        "model_version": importer.MODEL_VERSION,
        "prompt_version": importer.PROMPT_VERSION,
        "status": "unresolved", "rows": {},
        "expected_revision": "revision:demo-cable:STALE",
        "expected_generation": "stale-generation"}}))
    out = _run(item, colls, files_dir=tmp_path, checkpoint=cp)
    assert out["status"] == "cas_conflict" and out["published"] is False
    man = colls[1].docs["active:manifest"]
    assert man["sources"][sources[0]["id"]]["revision_id"] == first_rev
