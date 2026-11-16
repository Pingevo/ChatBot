"""Zaapi KB import HTTP endpoints — param plumbing tests.

เฉพาะชั้น FastAPI: query params แบบ JSON (subject_bindings,
shop_scopes, row_snapshot, hashes) ต้องถูก parse และ forward ไปยัง
kb_zaapi_files owner จริง; input เสีย → 400; op=package → import_package.

ใช้ TestClient + MemoryDb (แทน _admin_db) — parse/validate/path จริง
ผ่าน owner ตัวเดิม ไม่ mock logic import.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient  # noqa: E402

from shopeechat import app as _app_mod  # noqa: E402
from shopeechat import embedding as _emb  # noqa: E402
from shopeechat import knowledge_base as _kb  # noqa: E402
from shopeechat import kb_zaapi_files as zkf  # noqa: E402
from test_zaapi_kb_files import (  # noqa: E402
    F1, F1_BINDINGS, F1_DATA, MemoryDb)

CLIENT = TestClient(_app_mod.app)

SHOP = {"platform": "shopee", "shop_id": "s1", "shopname": "ร้านทดสอบ"}
SHA = hashlib.sha256(F1_DATA).hexdigest()


def _stub_embed(monkeypatch):
    monkeypatch.setattr(_emb, "embed_texts",
                        lambda texts, **k: [[0.1, 0.2] for _ in texts])
    monkeypatch.setattr(_emb, "model_identity", lambda: "test-embed-2d")


def _patch_db(monkeypatch) -> MemoryDb:
    db = MemoryDb()
    monkeypatch.setattr(_kb, "_admin_db", lambda: db)
    return db


def test_preview_forwards_declared_subject_scope_and_hashes(monkeypatch):
    _patch_db(monkeypatch)
    r = CLIENT.post("/zaapi-kb/import/preview", params={
        "filename": F1,
        "subject_bindings": json.dumps(F1_BINDINGS),
        "shop_scopes": json.dumps([SHOP]),
        "source_id": "src-x",
        "file_sha256": SHA,
        "mapping_sha256": "m" * 64,
        "source_snapshot_sha256": "s" * 64,
    }, content=F1_DATA)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bound_rows"] == 2 and body["unbound_rows"] == 0
    assert body["source_id"] == "src-x"
    assert body["shop_scopes"] == [
        {"key": "shopee|s1", "platform": "shopee",
         "shop_id": "s1", "shopname": "ร้านทดสอบ"}]
    assert body["mapping_sha256"] == "m" * 64
    assert body["source_snapshot_sha256"] == "s" * 64
    assert body["subject_bindings"] == F1_BINDINGS
    assert all(d["subject_refs"] for d in body["subject_samples"])


def test_apply_forwards_and_persists(monkeypatch):
    db = _patch_db(monkeypatch)
    _stub_embed(monkeypatch)
    r = CLIENT.post("/zaapi-kb/import/apply", params={
        "filename": F1,
        "subject_bindings": json.dumps(F1_BINDINGS),
        "shop_scopes": json.dumps([SHOP]),
        "source_id": "src-x",
        "file_sha256": SHA,
    }, content=F1_DATA)
    assert r.status_code == 200, r.text
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["source_id"] == "src-x"
    assert reg["subject_bindings"] == F1_BINDINGS
    assert reg["shop_scopes"][0]["key"] == "shopee|s1"


@pytest.mark.parametrize("bad", [
    {"subject_bindings": "{bad"},
    {"subject_bindings": "[1,2]"},
    {"shop_scopes": "{}"},
    {"shop_scopes": "notjson"},
    {"shop_scopes": json.dumps([{"platform": "shopee"}])},
    {"shop_scopes": json.dumps([{"platform": "shopee", "shop_id": "x",
                                 "shopname": "y",
                                 "key": "lazada|x"}])},
    {"row_snapshot": "{bad"},
    {"sheet_types": "{bad"},
])
def test_preview_rejects_malformed_params(monkeypatch, bad):
    _patch_db(monkeypatch)
    r = CLIENT.post("/zaapi-kb/import/preview",
                    params={"filename": F1, **bad}, content=F1_DATA)
    assert r.status_code == 400, r.text


def test_apply_rejects_wrong_file_sha(monkeypatch):
    _patch_db(monkeypatch)
    r = CLIENT.post("/zaapi-kb/import/apply", params={
        "filename": F1, "file_sha256": "0" * 64,
    }, content=F1_DATA)
    assert r.status_code == 400, r.text


def test_package_endpoint_forwards(monkeypatch):
    seen = {}

    def _fake(db, *, data, shops, preview, admin):
        seen.update(data=data, shops=shops, preview=preview)
        return {"ok": True}

    _patch_db(monkeypatch)
    monkeypatch.setattr(zkf, "import_package", _fake)
    r = CLIENT.post("/zaapi-kb/import/package", params={
        "preview": "true", "shops": json.dumps([SHOP]),
    }, content=b'{"format": "zaapi-kb-source"}')
    assert r.status_code == 200, r.text
    assert seen["preview"] is True
    assert seen["shops"] == [SHOP]
    assert seen["data"] == b'{"format": "zaapi-kb-source"}'


def test_package_rejects_bad_shops_json(monkeypatch):
    _patch_db(monkeypatch)
    r = CLIENT.post("/zaapi-kb/import/package",
                    params={"shops": "{bad"}, content=b"{}")
    assert r.status_code == 400, r.text


def _apply_bound_file(db):
    r = CLIENT.post("/zaapi-kb/import/apply", params={
        "filename": F1,
        "subject_bindings": json.dumps(F1_BINDINGS),
        "shop_scopes": json.dumps([SHOP]),
        "source_id": "src-x", "file_sha256": SHA,
    }, content=F1_DATA)
    assert r.status_code == 200, r.text


def test_export_package_endpoint_round_trip(monkeypatch):
    db = _patch_db(monkeypatch)
    _stub_embed(monkeypatch)
    _apply_bound_file(db)
    r = CLIENT.get("/zaapi-kb/export-package", params={"file": F1})
    assert r.status_code == 200, r.text
    pkg = r.json()
    assert pkg["format"] == "zaapi-kb-source" and pkg["version"] == 1
    # package bytes → preview endpoint (no writes) on a fresh db
    db2 = MemoryDb()
    monkeypatch.setattr(_kb, "_admin_db", lambda: db2)
    r2 = CLIENT.post("/zaapi-kb/import/package", params={
        "preview": "true", "shops": json.dumps([SHOP]),
    }, content=r.content)
    assert r2.status_code == 200, r2.text
    plan = r2.json()
    assert plan["filename"] == F1
    assert plan["bound_rows"] == 2 and plan["unbound_rows"] == 0
    assert plan["shop_scopes"][0]["key"] == "shopee|s1"
    assert db2[zkf._FILES_COLL].count_documents({}) == 0


def test_export_package_requires_mapping(monkeypatch):
    db = _patch_db(monkeypatch)
    _stub_embed(monkeypatch)
    # apply โดยไม่ส่ง shop_scopes → legacy unmapped file → export-package ต้อง 400
    r = CLIENT.post("/zaapi-kb/import/apply",
                    params={"filename": F1}, content=F1_DATA)
    assert r.status_code == 200, r.text
    r2 = CLIENT.get("/zaapi-kb/export-package", params={"file": F1})
    assert r2.status_code == 400, r2.text
