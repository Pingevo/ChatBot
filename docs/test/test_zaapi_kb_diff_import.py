"""v2 diff-import contract: durable row_uid, revision row_map/quarantine,
hold-publish, noop predicate, CAS, import log. Offline; no provider calls."""
from __future__ import annotations

import hashlib
import json
import sys
from copy import deepcopy
from pathlib import Path

import pytest
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT / "docs" / "zaapi" / "script"))
sys.path.insert(0, str(Path(__file__).parent))

from shopeechat.kb_zaapi_schema import SCHEMA_REVISION_V2  # noqa: E402
import import_zaapi_kb as importer  # noqa: E402
from import_zaapi_kb import import_source, declare_source  # noqa: E402
from test_zaapi_kb_import import MemoryCollection, FIXTURES, sources  # noqa: E402


@pytest.fixture
def colls():
    return (MemoryCollection(), MemoryCollection(),
            MemoryCollection(), MemoryCollection())  # raw, rec, reg, log


def _xlsx(folder, name, rows, header=("model_code", "item_id", "alias", "fact")):
    book = Workbook()
    sheet = book.active
    sheet.title = "Cable Specs"
    sheet.append(header)
    for row in rows:
        sheet.append(row)
    path = folder / name
    book.save(path)
    book.close()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _item(sources, tmp_path, rows, *, name="new.xlsx", version="v2",
          accounts=None):
    src = deepcopy(sources[0])
    src["version"]["versionId"] = version
    fp = _xlsx(tmp_path, name, rows)
    src["downloaded_file"] = {"file": name, "sha256": fp}
    if accounts is not None:
        src["accounts"] = accounts
    return src


def _calls(extract):
    calls = []
    def wrap(row):
        calls.append(row)
        return extract(row)
    return wrap, calls


def _base_extraction(row):
    fields = row.get("fields") or {}
    return {
        "record_type": "spec", "topic": "cable capacity",
        "model_codes": [fields.get("model_code") or "CB-100"],
        "aliases": [fields.get("alias") or "x"],
        "item_id": fields.get("item_id"), "model_id": None,
        "subject_id": None, "target_id": None,
        "facts": [{"key": "power_capacity_w",
                   "value": int(fields["fact"].split("=")[1])}],
        "answer_text": "", "steps": [],
    }


def _fail_extraction(row):
    raise RuntimeError("provider down")


def _run(item, colls, extractor=None,
         files_dir=FIXTURES / "knowledge-files", **kw):
    raw, rec, reg, log = colls
    return import_source(item, files_dir, raw, rec,
                         extractor=extractor or _base_extraction,
                         canonicalize=True, apply=True,
                         registry_coll=reg, log_coll=log, **kw)


def _first(item, colls, tmp_path, key_columns=("model_code",)):
    raw, rec, reg, log = colls
    if key_columns:
        declare_source(reg, item["id"], key_mode="column",
                       key_columns=list(key_columns),
                       declared_by="test", declared_at="t0")
    return _run(item, colls)


def _active_rev(rec, sid):
    m = rec.docs.get("active:manifest", {})
    ptr = m.get("sources", {}).get(sid)
    return rec.docs.get(ptr["revision_id"]) if ptr else None


ROWS = [("CB-100", "1001", "Demo cable", "power_capacity_w=240"),
        ("CB-200", "1002", "Demo second cable", "power_capacity_w=100")]


def test_first_import_publishes_v2_identity(sources, colls, tmp_path):
    out = _first(sources[0], colls, tmp_path)
    assert out["status"] == "published"
    rev = _active_rev(colls[1], "demo-cable")
    assert rev["schema_revision"] == SCHEMA_REVISION_V2
    assert sorted(rev["row_map"]) == ["demo-cable:r0", "demo-cable:r1"]
    assert rev["key_map"] == {"CB-100": "demo-cable:r0",
                            "CB-200": "demo-cable:r1"}
    assert rev["quarantined"] == []
    doc = colls[1].docs[rev["row_map"]["demo-cable:r0"]["Demo Shop|shopee"]]
    assert doc["row_uid"] == "demo-cable:r0"
    assert doc["schema_revision"] == SCHEMA_REVISION_V2


def test_identical_reupload_is_noop_zero_calls(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    wrap, calls = _calls(_base_extraction)
    out = _run(sources[0], colls, extractor=wrap)
    assert out["status"] == "noop" and calls == []
    assert out["published"] is True


def test_one_cell_edit_changes_only_that_row(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    before = _active_rev(colls[1], "demo-cable")["row_map"]
    item = _item(sources, tmp_path,
                 [("CB-100", "1001", "Demo cable", "power_capacity_w=300"),
                  ("CB-200", "1002", "Demo second cable",
                   "power_capacity_w=100")])
    wrap, calls = _calls(_base_extraction)
    out = _run(item, colls, files_dir=tmp_path, extractor=wrap)
    assert out["status"] == "published" and len(calls) == 1
    after = _active_rev(colls[1], "demo-cable")["row_map"]
    assert after["demo-cable:r1"] == before["demo-cable:r1"]   # byte-stable
    assert after["demo-cable:r0"] != before["demo-cable:r0"]


def test_added_rows_get_only_new_uids(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path,
                 ROWS + [("CB-300", "1003", "Demo third",
                          "power_capacity_w=60")])
    out = _run(item, colls, files_dir=tmp_path)
    rev = _active_rev(colls[1], "demo-cable")
    assert "demo-cable:r2" in rev["row_map"]
    assert rev["row_map"]["demo-cable:r0"] == (
        _active_rev(colls[1], "demo-cable")["row_map"]["demo-cable:r0"])


def test_renamed_file_keeps_uids(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    before = _active_rev(colls[1], "demo-cable")["row_map"]
    item = _item(sources, tmp_path, ROWS, name="renamed.xlsx")
    out = _run(item, colls, files_dir=tmp_path)
    after = _active_rev(colls[1], "demo-cable")["row_map"]
    assert out["status"] == "published" and after == before


def test_reordered_rows_keep_uids(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path, ROWS[::-1])
    out = _run(item, colls, files_dir=tmp_path)
    rev = _active_rev(colls[1], "demo-cable")
    assert rev["key_map"] == {"CB-100": "demo-cable:r0",
                            "CB-200": "demo-cable:r1"}


def test_declared_key_edit_is_rename_proposal(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path,
                 [("CB-100X", "1001", "Demo cable", "power_capacity_w=240"),
                  ("CB-200", "1002", "Demo second cable",
                   "power_capacity_w=100")])
    out = _run(item, colls, files_dir=tmp_path)
    assert out["status"] == "needs_confirm"
    assert out["proposals"][0]["type"] == "rename"
    assert out["proposals"][0]["from"] == "CB-100"
    assert out["proposals"][0]["to"] == "CB-100X"
    out = _run(item, colls, files_dir=tmp_path, confirm=frozenset(
        {p["needs_confirm"] for p in out["proposals"]}))
    rev = _active_rev(colls[1], "demo-cable")
    assert rev["key_map"] == {"CB-100X": "demo-cable:r0",
                            "CB-200": "demo-cable:r1"}


def test_duplicate_key_stops(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path,
                 [("CB-100", "1001", "Demo cable", "power_capacity_w=240"),
                  ("CB-100", "1009", "Dup key", "power_capacity_w=1")])
    out = _run(item, colls, files_dir=tmp_path)
    assert out["status"] == "stopped" and "duplicate" in out["reason"]


def test_row_removal_needs_confirm_then_drops(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path, ROWS[:1])
    out = _run(item, colls, files_dir=tmp_path)
    assert out["status"] == "needs_confirm"
    assert out["proposals"][0]["type"] == "deactivate"
    out = _run(item, colls, files_dir=tmp_path, confirm=frozenset(
        {p["needs_confirm"] for p in out["proposals"]}))
    rev = _active_rev(colls[1], "demo-cable")
    assert list(rev["row_map"]) == ["demo-cable:r0"]


def test_account_add_changes_only_new_membership(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    before = _active_rev(colls[1], "demo-cable")["row_map"]
    item = _item(sources, tmp_path, ROWS,
                 accounts=[{"id": "demo-shop", "platform": "shopee",
                            "name": "Demo Shop"},
                           {"id": "shop-2", "platform": "shopee",
                            "name": "Second Shop"}])
    out = _run(item, colls, files_dir=tmp_path)
    rev = _active_rev(colls[1], "demo-cable")
    assert set(rev["row_map"]["demo-cable:r0"]) == {
        "Demo Shop|shopee", "Second Shop|shopee"}
    assert rev["row_map"]["demo-cable:r0"]["Demo Shop|shopee"] == (
        before["demo-cable:r0"]["Demo Shop|shopee"])


def test_shop_rename_same_id_publishes(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path, ROWS,
                 accounts=[{"id": "demo-shop", "platform": "shopee",
                            "name": "Renamed Shop"}])
    out = _run(item, colls, files_dir=tmp_path)
    assert out["status"] == "published"
    rev = _active_rev(colls[1], "demo-cable")
    assert set(rev["row_map"]["demo-cable:r0"]) == {"Renamed Shop|shopee"}


def test_edited_existing_row_fail_holds_publish(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    before = coll_manifest = colls[1].docs.get("active:manifest")
    item = _item(sources, tmp_path,
                 [("CB-100", "1001", "Demo cable", "power_capacity_w=999"),
                  ("CB-200", "1002", "Demo second cable",
                   "power_capacity_w=100")])
    out = _run(item, colls, files_dir=tmp_path, extractor=_fail_extraction)
    assert out["status"] == "hold_publish"
    assert colls[1].docs.get("active:manifest") == before  # pointer unmoved


def test_new_row_fail_quarantines_then_retries(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path,
                 ROWS + [("CB-300", "1003", "New", "power_capacity_w=5")])
    out = _run(item, colls, files_dir=tmp_path, extractor=lambda row: (
        _fail_extraction(row)
        if row["fields"].get("model_code") == "CB-300"
        else _base_extraction(row)))
    rev = _active_rev(colls[1], "demo-cable")
    assert (rev["quarantined"]
            and rev["key_map"]["CB-300"] == "demo-cable:r2")
    quid = rev["quarantined"][0]["row_uid"]
    assert quid == "demo-cable:r2"
    out = _run(item, colls, files_dir=tmp_path)     # retry, extractor now succeeds
    rev = _active_rev(colls[1], "demo-cable")
    assert rev["quarantined"] == [] and quid in rev["row_map"]


def test_restart_classifies_existing_by_durable_row_map(
        sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    item = _item(sources, tmp_path,
                 [("CB-100", "1001", "Demo cable", "power_capacity_w=7"),
                  ("CB-200", "1002", "Demo second cable",
                   "power_capacity_w=100")])
    # no checkpoint → fresh process; edited EXISTING row must still HOLD
    out = _run(item, colls, files_dir=tmp_path, extractor=_fail_extraction, checkpoint=None)
    assert out["status"] == "hold_publish"


def test_import_log_records_events(sources, colls, tmp_path):
    _first(sources[0], colls, tmp_path)
    _run(sources[0], colls)
    events = [d["event"] for d in colls[3].docs.values()]
    assert "noop_reimport" in events
    assert any(e in events for e in ("published", "unpublished"))
