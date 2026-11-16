"""Zaapi file-backed KB — import/export/search contract tests.

Offline: MemoryColl/FakeDb doubles (no mongod). Real Mongo: set env
ZAAPI_TEST_MONGO_URI (disposable container/db) — same assertions run
against pymongo; collections are created/dropped under a `zztest_` DB.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))

from shopeechat import kb_zaapi_files as zkf  # noqa: E402


# ── in-memory doubles (ops subset used by kb_zaapi_files) ───────────────

def _get_path(doc, path):
    cur = doc
    for p in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _match(doc, filt):
    for k, cond in (filt or {}).items():
        v = _get_path(doc, k)
        if k == "$or":
            if not any(_match(doc, c) for c in cond):
                return False
            continue
        if k == "$nor":
            if any(_match(doc, c) for c in cond):
                return False
            continue
        if isinstance(cond, dict):
            for op, cv in cond.items():
                if op == "$exists" and ((v is not None) != bool(cv)):
                    return False
                if op == "$ne" and v == cv:
                    return False
                if op == "$lt" and not (v is not None and v < cv):
                    return False
                if op == "$in" and v not in cv:
                    return False
        elif v != cond:
            return False
    return True


class _Cur(list):
    def sort(self, keys, direction=1):
        ks = keys if isinstance(keys, list) else [(keys, direction)]
        for f, d in reversed(ks):
            super().sort(key=lambda x: (x.get(f) is None, x.get(f)),
                         reverse=(d < 0))
        return self

    def limit(self, n):
        return _Cur(self[:n])


class MemoryColl:
    def __init__(self):
        self.docs = []

    def find_one(self, filt=None):
        return deepcopy(next((d for d in self.docs if _match(d, filt)),
                             None))

    def find(self, filt=None, proj=None):
        out = [deepcopy(d) for d in self.docs if _match(d, filt)]
        if proj:
            keys = [k for k, inc in proj.items() if inc]
            for o in out:
                for k in list(o):
                    if k not in keys and k != "_id":
                        del o[k]
        return _Cur(out)

    def count_documents(self, filt=None):
        return sum(1 for d in self.docs if _match(d, filt))

    def insert_one(self, doc, **kw):
        if (doc.get("_id") is not None
                and any(x.get("_id") == doc["_id"] for x in self.docs)):
            from pymongo.errors import DuplicateKeyError
            raise DuplicateKeyError("dup")
        self.docs.append(deepcopy(doc))

    def insert_many(self, docs, **kw):
        for d in docs:
            if any(x["_id"] == d["_id"] for x in self.docs):
                from pymongo.errors import DuplicateKeyError
                raise DuplicateKeyError("dup")
        self.docs += [deepcopy(d) for d in docs]

    def update_one(self, filt, update, upsert=False):
        class R: matched_count = 0; upserted_id = None
        for d in self.docs:
            if _match(d, filt):
                self._apply(d, update)
                R.matched_count = 1
                return R
        if upsert:
            nd = {k: v for k, v in filt.items() if not k.startswith("$")
                  and not isinstance(v, dict)}
            self._apply(nd, update)
            if (nd.get("_id") is not None
                    and any(x.get("_id") == nd["_id"] for x in self.docs)):
                from pymongo.errors import DuplicateKeyError
                raise DuplicateKeyError("dup")
            self.docs.append(nd)
            R.upserted_id = nd.get("_id")
        return R

    def update_many(self, filt, update):
        class R: modified_count = 0
        for d in self.docs:
            if _match(d, filt):
                self._apply(d, update)
                R.modified_count += 1
        return R

    @staticmethod
    def _apply(d, update):
        for k, v in update.get("$set", {}).items():
            d[k] = v
        for k in update.get("$unset", {}):
            d.pop(k, None)

    def delete_many(self, filt):
        class R: deleted_count = 0
        before = len(self.docs)
        self.docs = [d for d in self.docs if not _match(d, filt)]
        R.deleted_count = before - len(self.docs)
        return R

    def create_index(self, *a, **k):
        return "idx"


class MemoryDb:
    def __init__(self):
        self._c = {}

    def __getitem__(self, name):
        return self._c.setdefault(name, MemoryColl())


# ── fixtures ───────────────────────────────────────────────────────────

def _xlsx_bytes(sheets: dict[str, list[list]]) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(title=name)
        for r in rows:
            ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    return buf.getvalue()


F1 = "001 - test-file.xlsx"
F1_DATA = _xlsx_bytes({
    "ข้อมูลสินค้า": [
        ["ชื่อสินค้า", "รายละเอียดสินค้า", "คำตอบ"],
        ["AC65B", "หูฟัง Bluetooth รุ่น AC65B แบต 30 ชม.", "รับประกัน 1 ปี"],
        ["AC65B2", "หูฟัง Bluetooth รุ่น AC65B2 แบต 40 ชม.", "รับประกัน 2 ปี"],
    ]})
F1_EDITED = _xlsx_bytes({
    "ข้อมูลสินค้า": [
        ["ชื่อสินค้า", "รายละเอียดสินค้า", "คำตอบ"],
        ["AC65B", "หูฟัง Bluetooth รุ่น AC65B แบต 35 ชม.", "รับประกัน 1 ปี"],
    ]})
F2 = "002 - other-shop.xlsx"
F1_BINDINGS = {"ข้อมูลสินค้า": {"columns": [{"column_index": 1, "header": "ชื่อสินค้า"}]}}
TS_BINDINGS = {"ชีต1": {"columns": [{"column_index": 2, "header": "รุ่น"}]}}


def _no_embed(monkeypatch):
    """embed ใช้งานไม่ได้ → fallback prefilter score (ทดสอบสาย degrade)."""
    from shopeechat import embedding as emb
    monkeypatch.setattr(emb, "embed_query",
                        lambda *a, **k: (_ for _ in ()).throw(
                            RuntimeError("embed off in test")))


def _zaapi_mode(monkeypatch, mode="zaapi"):
    from shopeechat import runtime_config as rc
    monkeypatch.setattr(rc, "get_runtime_config",
                        lambda *a, **k: {"kb_source": mode,
                                         "pool_sources": {}})


@pytest.fixture(params=["memory"])
def db(request, monkeypatch):
    _zaapi_mode(monkeypatch)
    uri = os.environ.get("ZAAPI_TEST_MONGO_URI")
    if request.param == "mongo" or (uri and request.param == "memory"
                                  and os.environ.get("ZAAPI_FORCE_MONGO")):
        from pymongo import MongoClient
        cli = MongoClient(uri, serverSelectionTimeoutMS=3000)
        cli.server_info()
        real = cli[f"zztest_{os.getpid()}"]
        yield real
        for c in real.list_collection_names():
            real.drop_collection(c)
        return
    yield MemoryDb()


# ── parse/preview (read-only) ──────────────────────────────────────────

def test_parse_xlsx_verbatim():
    docs = zkf.parse_upload(F1, F1_DATA)
    assert len(docs) == 2
    d = docs[0]
    assert d["sheet"] == "ข้อมูลสินค้า" and d["row_index"] == 0
    assert d["source_row"] == 2  # excel row (header=1)
    assert d["fields"]["ชื่อสินค้า"] == "AC65B"
    assert "แบต 30 ชม." in d["text"]
    assert docs[1]["fields"]["ชื่อสินค้า"] == "AC65B2"


def test_parse_txt():
    docs = zkf.parse_upload("note.txt", "เงื่อนไขประกัน 1 ปี\nทุกรุ่น".encode())
    assert len(docs) == 1 and docs[0]["kind"] == "text"
    assert "เงื่อนไขประกัน" in docs[0]["text"]


def test_preview_zero_writes(db):
    r = zkf.preview_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                           accounts=["ShopA"], platforms=["shopee"])
    assert r["new_rows"] == 2 and r["replaces_rev"] is None
    assert r["new_rev"] == 1 and r["accounts"] == ["ShopA"]
    # zero writes — no collections touched
    assert db[zkf._COLL].count_documents({}) == 0
    assert db[zkf._FILES_COLL].count_documents({}) == 0
    assert db[zkf._LOG_COLL].count_documents({}) == 0


# ── apply / replace / rollback / sweep ─────────────────────────────────

def test_apply_new_file(db):
    r = zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                         accounts=["ShopA"], platforms=["shopee"],
                         admin="t")
    assert r["ok"] and r["rev"] == 1 and r["rows"] == 2
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["active_rev"] == 1 and reg["accounts"] == ["ShopA"]
    assert db[zkf._COLL].count_documents(
        {"source_file": F1, "file_rev": 1}) == 2
    assert db[zkf._LOG_COLL].count_documents({"op": "apply"}) == 1


def test_same_filename_replaces_new_filename_adds(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    r2 = zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    assert r2["ok"] and r2["rev"] == 2 and r2["replaced_rev"] == 1
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["active_rev"] == 2 and reg["prev_rev"] == 1
    # old rev retained with expire_at (grace window)
    old = list(db[zkf._COLL].find({"source_file": F1, "file_rev": 1}))
    assert len(old) == 2 and all("expire_at" in d for d in old)
    # ชื่อใหม่ = แหล่งเพิ่ม — rev อิสระ, ไม่แตะ F1
    r3 = zkf.apply_import(db, filename=F2, data=F1_DATA, admin="t")
    assert r3["ok"] and r3["rev"] == 1
    assert db[zkf._FILES_COLL].count_documents({}) == 2


def test_rollback_restores_prev(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    r = zkf.rollback_import(db, filename=F1, admin="t")
    assert r["ok"] and r["rev"] == 1
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["active_rev"] == 1
    # เก่า (rev1) กลับมาใช้งาน — expire_at ถูกล้าง
    assert all("expire_at" not in d for d in db[zkf._COLL].find(
        {"source_file": F1, "file_rev": 1}))
    assert db[zkf._COLL].count_documents(
        {"source_file": F1, "file_rev": 2, "expire_at": {
            "$exists": True}}) == 1


def test_toggle_file_enabled(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    # disable → visibility หาย แต่ rows คงอยู่
    r = zkf.set_file_enabled(db, filename=F1, enabled=False, admin="t")
    assert r["ok"] and r["rev"] == 1
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert "active_rev" not in reg and reg["disabled_rev"] == 1
    assert db[zkf._COLL].count_documents(
        {"source_file": F1, "file_rev": 1}) == 2
    lf = [f for f in zkf.list_files(db) if f["file"] == F1][0]
    # disabled → active_rev=0 แต่ rows แสดงข้อมูล rev ที่ปิดอยู่ (2 แถว)
    assert lf["disabled"] and lf["active_rev"] == 0 and lf["rows"] == 2
    assert zkf._visible_pairs(db)[0] == []
    # disable ซ้ำ → unchanged ไม่ log
    r2 = zkf.set_file_enabled(db, filename=F1, enabled=False)
    assert r2["ok"] and r2.get("unchanged")
    # enable → visibility กลับ
    r3 = zkf.set_file_enabled(db, filename=F1, enabled=True, admin="t")
    assert r3["ok"] and r3["rev"] == 1
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["active_rev"] == 1 and "disabled_rev" not in reg
    assert zkf._visible_pairs(db)[0][0]["file_rev"] == 1
    # unknown file / enable ไฟล์ที่ไม่เคย disable → ValueError
    with pytest.raises(ValueError):
        zkf.set_file_enabled(db, filename="nope.xlsx", enabled=True)
    assert db[zkf._LOG_COLL].count_documents({"op": "toggle"}) == 2


def test_rollback_fails_after_sweep(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    # expire rev1 → sweep deletes → rollback ไม่ได้
    past = datetime.now(timezone.utc) - timedelta(seconds=10)
    db[zkf._COLL].update_many(
        {"source_file": F1, "file_rev": 1},
        {"$set": {"expire_at": past}})
    s = zkf.sweep_expired(db)
    assert s["deleted"] == 2
    assert db[zkf._COLL].count_documents(
        {"source_file": F1, "file_rev": 1}) == 0
    r = zkf.rollback_import(db, filename=F1, admin="t")
    assert r["ok"] is False and r["reason"] == "prev_rows_incomplete"


def test_visibility_active_rev_only_and_manual_untouched(db):
    db[zkf._COLL].insert_many([{
        "_id": "manual1", "text": "manual answer", "kind": "manual",
        "fields": {"q": "x"}, "active": True}])
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    pairs, _ = zkf._visible_pairs(db)
    assert len(pairs) == 1
    p = pairs[0]
    assert p["source_file"] == F1 and p["file_rev"] == 2
    # triple: apply_id ต้องตรง attempt ที่ registry publish
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert p["apply_id"] == reg["active_apply"]
    # manual doc ไม่มี source_file → ไม่ถูก import แตะ
    man = db[zkf._COLL].find_one({"_id": "manual1"})
    assert man["text"] == "manual answer" and "file_rev" not in man


# ── export round-trip ─────────────────────────────────────────────────

def test_export_roundtrip(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    data = zkf.export_file(db, filename=F1)
    assert data
    wb = load_workbook(io.BytesIO(data))
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    assert rows[0][0] == "ชื่อสินค้า"
    assert rows[1][0] == "AC65B" and rows[2][0] == "AC65B2"
    # re-import ไฟล์ export ชื่อเดิม → rev ใหม่, ค่าเดิมครบ
    r = zkf.apply_import(db, filename=F1, data=data, admin="t")
    assert r["ok"] and r["rev"] == 2 and r["rows"] == 2
    doc = db[zkf._COLL].find_one(
        {"source_file": F1, "file_rev": 2, "fields.ชื่อสินค้า": "AC65B"})
    assert doc and doc["fields"]["รายละเอียดสินค้า"] == \
        "หูฟัง Bluetooth รุ่น AC65B แบต 30 ชม."


def test_export_missing_returns_none(db):
    assert zkf.export_file(db, filename="nope.xlsx") is None


# ── scope ─────────────────────────────────────────────────────────────

def test_scope_filter(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                     accounts=["ShopA"], platforms=["shopee"], admin="t")
    zkf.apply_import(db, filename=F2, data=F1_EDITED, subject_bindings=F1_BINDINGS,
                     accounts=["ShopB"], platforms=["shopee"], admin="t")
    hits, _ = zkf.zaapi_search(db, shop="ShopA", platform="shopee",
                             query="AC65B", refs=["AC65B"])
    assert hits and all(h["meta"]["file"] == F1 for h in hits)
    # ShopB เห็นเฉพาะ F2
    hits2, _ = zkf.zaapi_search(db, shop="ShopB", platform="shopee",
                              query="AC65B", refs=["AC65B"])
    assert hits2 and all(h["meta"]["file"] == F2 for h in hits2)


# ── search ────────────────────────────────────────────────────────────

def test_search_verbatim_provenance(db, monkeypatch):
    # ปิด embed ให้ deterministic — prefilter score แทน cosine
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    hits, trace = zkf.zaapi_search(db, shop=None, platform=None,
                                 query="AC65B แบต", refs=["AC65B"])
    assert hits
    h = hits[0]
    assert h["record_id"] == f"{F1}::ข้อมูลสินค้า::0"
    assert h["meta"]["file"] == F1 and h["meta"]["sheet"] == "ข้อมูลสินค้า"
    assert "แบต 30 ชม." in h["a"]  # text verbatim — ไม่แปลง
    assert h["_qa_source"] == "zaapi"


def test_search_gate_closed_when_legacy(db, monkeypatch):
    _zaapi_mode(monkeypatch, "legacy")
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    hits, trace = zkf.zaapi_search(db, query="AC65B")
    assert hits == [] and "gate_closed" in trace[0]


# ── wiring into knowledge_base / kb_zaapi ─────────────────────────────

def test_search_qa_zaapi_cross_model_guard(db, monkeypatch):
    """doc ผูก AC65B2 ต้องถูก guard ข้ามเมื่อรู้รุ่น AC65B — assert จริง
    (เดิม `or True` ทำให้ผ่านเสมอ = ไม่เคยพิสูจน์ guard)."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    both = _xlsx_bytes({"s": [
        ["คำถาม", "คำตอบ"],
        ["AC65B แบตอยู่กี่ชม.", "AC65B อยู่ได้ 30 ชม."],
        ["AC65B2 แบตอยู่กี่ชม.", "AC65B2 อยู่ได้ 45 ชม."],
    ]})
    zkf.apply_import(db, filename="both.xlsx", data=both,
                     subject_bindings={"s": {"rows": {"0": ["AC65B"], "1": ["AC65B2"]}}},
                     content_type="faq", admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    hits = kb.search_qa("แบตอยู่กี่ชม.", model_codes={"AC65B"})
    texts = [h["a"] for h in hits]
    assert any("AC65B อยู่ได้ 30" in t for t in texts)
    assert not any("AC65B2 อยู่ได้ 45" in t for t in texts), \
        "doc ผูก AC65B2 ต้องไม่ตอบคำถาม AC65B"


def test_qa_uses_declared_subject_instead_of_models_mentioned_in_answer(db, monkeypatch):
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    data = _xlsx_bytes({"qa": [["question", "answer"],
        ["Battery duration", "30 hours, unlike AC65B2"],
    ]})
    zkf.apply_import(db, filename="subject-qa.xlsx", data=data, content_type="faq",
                     subject_bindings={"qa": {"refs": ["AC65B"]}})
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    hits = kb.search_qa("แบตอยู่กี่ชม.", model_codes={"AC65B"})
    assert hits and "30 hours" in hits[0]["a"]
    assert hits[0]["_qa_level"] == "model" and hits[0]["model_codes"] == ["AC65B"]


def test_known_qa_subject_is_not_widened_by_comparison_mentions(db, monkeypatch):
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    data = _xlsx_bytes({"qa": [["question", "answer"],
        ["AC65B2", "45 hours compared with AC65B"],
    ]})
    zkf.apply_import(db, filename="subject-qa.xlsx", data=data, content_type="faq",
                     subject_bindings={"qa": {"refs": ["AC65B2"]}})
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    assert kb.search_qa("AC65B2 compared with AC65B", model_codes={"AC65B"}) == []


def test_get_general_faq_zaapi(db, monkeypatch):
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename="011 - เงื่อนไข.xlsx", data=_xlsx_bytes({
        "เงื่อนไขประกัน": [
            ["หัวข้อ", "รายละเอียด"],
            ["รับประกัน", "สินค้ารับประกัน 1 ปีนับจากวันส่งมอบ"]],
    }), content_type="warranty", admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    faq = kb.get_general_faq("รับประกัน")
    assert faq and "รับประกัน 1 ปี" in faq["answer"]


def test_zaapi_kb_evidence_shape(db, monkeypatch):
    from shopeechat import kb_zaapi
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    monkeypatch.setattr(kb_zaapi, "_COLL", zkf._COLL)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                     content_type="product", admin="t")

    class N:  # TurnNeed-shaped double
        kind = "product"
        subject_refs = ("AC65B",)
        target_refs = ()
        capability_asks = ("แบต",)

    res = kb_zaapi.zaapi_kb_evidence(
        shop=None, platform="shopee", message="AC65B แบต",
        needs=(N(),), request_id="ch:kb:0", db=db)
    assert res.supporting_evidence
    ev = res.supporting_evidence[0]
    assert ev["kind"] == "kb" and ev["request_id"] == "ch:kb:0"
    assert ev["record_id"].startswith(F1)
    assert ev["meta"]["file"] == F1 and ev["meta"]["sheet"] == "ข้อมูลสินค้า"
    assert "แบต" in ev["payload"]["text"]


def test_zaapi_kb_evidence_nonproduct_type_visible(db, monkeypatch):
    """evidence path ต้องค้นเจอแถวที่ประกาศชนิดอื่นที่ไม่ใช่ product
    (troubleshooting/faq/warranty) — types widen ครอบชุดปิดทั้งหมด"""
    from shopeechat import kb_zaapi
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    monkeypatch.setattr(kb_zaapi, "_COLL", zkf._COLL)
    zkf.apply_import(db, filename=TS_FILE, data=TS_DATA, subject_bindings=TS_BINDINGS,
                     content_type="troubleshooting", admin="t")

    class N:  # TurnNeed-shaped double
        kind = "product"
        subject_refs = ("AC65B",)
        target_refs = ()
        capability_asks = ()

    res = kb_zaapi.zaapi_kb_evidence(
        shop=None, platform="shopee", message="AC65B เชื่อมต่อไม่ได้",
        needs=(N(),), request_id="ch:kb:1", db=db)
    assert res.supporting_evidence
    assert "รีเซ็ตหูฟัง" in res.supporting_evidence[0]["payload"]["text"]


def test_readiness_searchable(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    r = zkf.file_kb_ready(db)
    assert r["searchable"] and r["active_rows"] == 2 and r["files"] == 1


# ── owner-level e2e (functions app.chat() calls — ไม่ใช่ LLM) ──────────

TS_FILE = "060 - หูฟัง Earbuds วิธีแก้ปัญหา.xlsx"
TS_DATA = _xlsx_bytes({
    "ชีต1": [
        ["ปัญหา", "รุ่น", "ขั้นตอนแก้ไข"],
        ["เชื่อมต่อไม่ได้", "AC65B", "รีเซ็ตหูฟัง กดค้าง 10 วินาที"],
        ["เสียงขาด", "AC65B", "เช็คแบตและระยะห่าง"],
    ]})


def test_qa_troubleshoot_tips_zaapi(db, monkeypatch):
    """app.chat() → warranty_flow troubleshoot-first owner ผ่าน zaapi rows."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=TS_FILE, data=TS_DATA, subject_bindings=TS_BINDINGS,
                     content_type="troubleshooting", admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    tips = kb.qa_troubleshoot_tips("หูฟัง AC65B เชื่อมต่อไม่ได้",
                                   snap=None, min_sim=0.3)
    assert tips and any("รีเซ็ตหูฟัง" in t for t in tips)


def test_qa_context_zaapi(db, monkeypatch):
    """app.chat() → _qa_ctx path: zaapi hit กลายเป็น คำตอบอ้างอิง."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=TS_FILE, data=TS_DATA, subject_bindings=TS_BINDINGS,
                     content_type="troubleshooting", admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    ctx = kb.qa_context("AC65B เชื่อมต่อไม่ได้", snap=None)
    assert ctx and "รีเซ็ตหูฟัง" in ctx


def test_general_warranty_policy_zaapi(db, monkeypatch):
    """app.chat() general_qtype=warranty_policy → build_general_context →
    get_general_faq zaapi branch — context ต้องมีข้อความจากไฟล์จริง."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename="011 - เงื่อนไข.xlsx", data=_xlsx_bytes({
        "เงื่อนไขประกัน": [
            ["หัวข้อ", "รายละเอียด"],
            ["รับประกัน", "สินค้ารับประกัน 1 ปีนับจากวันส่งมอบ"]],
    }), content_type="warranty", admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    res = kb.build_general_context("warranty_policy")
    assert res and "รับประกัน 1 ปี" in res["context"]


def test_zaapi_mode_no_legacy_reads(db, monkeypatch):
    """Zaapi mode → legacy collections (knowledge_base/kb_qa/kb_products)
    ไม่ถูกอ่าน — gate _legacy_allowed() ปิด."""
    from shopeechat import knowledge_base as kb
    assert kb._legacy_allowed() is False


def test_search_qa_zaapi_no_evidence_no_hit(db, monkeypatch):
    """ไม่มีหลักฐาน → ไม่มี hit → owner อื่นตัดสิน (ห้ามแต่งคำตอบ)."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    assert kb.search_qa("กาแล็กซี่ S999 ราคาเท่าไหร่",
                        model_codes={"S999"}) == []


# ══ correction round 1 — independent review findings ══════════════════
# RED: executable reproductions of data-loss/coverage/scope bugs.

def test_post_commit_failure_never_deletes_active_rev(db, monkeypatch):
    """F1A: retire/log ล้มหลัง CAS → active rev ห้ามถูกลบ + ต้องรายงานจริง."""
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    za = db[zkf._COLL]
    # class-level patch: pymongo db[name] คืน instance ใหม่ทุกครั้ง —
    # apply_import ใช้ handle ของตัวเอง ต้องแพตช์ที่ class
    orig_um = type(za).update_many

    def boom(self, filt, update, *a, **kw):
        if (filt or {}).get("file_rev") == 1:  # retire old rev = post-commit
            raise RuntimeError("post-commit failure")
        return orig_um(self, filt, update, *a, **kw)
    monkeypatch.setattr(type(za), "update_many", boom)
    r = zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    assert r["ok"] and r["rev"] == 2, f"publish must survive: {r}"
    assert r.get("warning"), f"post-commit failure must be reported: {r}"
    assert za.count_documents(
        {"source_file": F1, "file_rev": 2}) == 1, "active rev deleted"
    hits, _ = zkf.zaapi_search(db, query="AC65B", refs=["AC65B"])
    assert hits, "active rev must stay searchable after failed cleanup"


def test_post_commit_log_failure_keeps_rows(db, monkeypatch):
    """F1A': _log ล้มหลัง publish → rows คงอยู่ + warning."""
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    orig_log = zkf._log

    def bad_log(d, entry):
        if entry.get("status") == "ok":
            raise RuntimeError("log write failed")
        return orig_log(d, entry)
    monkeypatch.setattr(zkf, "_log", bad_log)
    r = zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    assert r["ok"] and r["rev"] == 2 and r.get("warning")
    assert db[zkf._COLL].count_documents(
        {"source_file": F1, "file_rev": 2}) == 1


def test_concurrent_loser_never_deletes_winner_rows(db, monkeypatch):
    """F1B: A commit rev1 ก่อน → B (stale reg, ไฟล์ต่าง) CAS แพ้ →
    B ต้องไม่ลบแถวของ A และต้องไม่ publish เนื้อหาของ B."""
    rA = zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="a")
    assert rA["ok"] and rA["rev"] == 1
    files = db[zkf._FILES_COLL]
    # B อ่าน registry ก่อน A commit → เห็น {} (old_rev=0)
    monkeypatch.setattr(type(files), "find_one",
                        lambda self, f=None, *a, **kw: None)
    rB = zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="b")
    monkeypatch.undo()
    assert rB["ok"] is False and rB.get("conflict"), \
        f"loser must conflict, not publish: {rB}"
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["active_rev"] == 1, "winner rev replaced"
    rows = list(db[zkf._COLL].find({"source_file": F1, "file_rev": 1}))
    assert len(rows) == 2, f"winner rows deleted: {len(rows)}"
    assert all("แบต 30 ชม." in d["text"] for d in rows
               if d["fields"].get("ชื่อสินค้า") == "AC65B"), \
        "winner content must be A's bytes, not loser's"


def test_retry_after_crash_same_and_different_file(db, monkeypatch):
    """F1B': crash หลัง stage ก่อน CAS → retry (ไฟล์เดิม/ต่าง) ต้องชนะ
    และ staged เก่าหมดอายุเอง ไม่ปนข้อมูล."""
    files = db[zkf._FILES_COLL]

    def crash_uo(self, f, u, upsert=False, *a, **kw):
        raise RuntimeError("crash before CAS")
    monkeypatch.setattr(type(files), "update_one", crash_uo)
    try:
        zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    except RuntimeError:
        pass
    monkeypatch.undo()
    # staged attempt rows ต้องไม่มองเห็น + retry ไฟล์ต่างต้องชนะ
    hits, _ = zkf.zaapi_search(db, query="AC65B", refs=["AC65B"])
    assert hits == [], "crashed staged rows must stay invisible"
    r = zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    assert r["ok"] and r["rev"] == 1
    doc = db[zkf._COLL].find_one({"source_file": F1, "file_rev": 1,
                                  "fields.ชื่อสินค้า": "AC65B"})
    assert "แบต 35 ชม." in doc["text"], "new file content must win"


def test_rollback_rejects_partially_swept_prev(db):
    """F1C: prev rev หายบางแถว → rollback ต้องปฏิเสธ (ไม่ใช่ count>0 พอ)."""
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    zkf.apply_import(db, filename=F1, data=F1_EDITED, admin="t")
    za = db[zkf._COLL]
    old = list(za.find({"source_file": F1, "file_rev": 1}))
    za.delete_many({"_id": old[0]["_id"]})  # prev หาย 1 ใน 2 แถว
    r = zkf.rollback_import(db, filename=F1, admin="t")
    assert r["ok"] is False and r["reason"] in (
        "prev_rows_gone", "prev_rows_incomplete"), \
        f"partial prev must not rollback: {r}"
    # active ยัง rev2
    assert db[zkf._FILES_COLL].find_one(
        {"_id": F1})["active_rev"] == 2


def test_sweep_never_deletes_active_rev(db):
    """F1C': expire_at รั่วบน active rows (bug) → sweep ห้ามลบชุดที่ใช้งาน."""
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    past = datetime.now(timezone.utc) - timedelta(seconds=10)
    db[zkf._COLL].update_many(
        {"source_file": F1, "file_rev": 1}, {"$set": {"expire_at": past}})
    s = zkf.sweep_expired(db)
    assert s["deleted"] == 0, "sweep deleted active revision"
    assert db[zkf._COLL].count_documents(
        {"source_file": F1, "file_rev": 1}) == 2


def test_grace_window_is_7_days():
    """F1D: report บอก 7 วัน → code default ต้องตรง."""
    assert zkf._RETIRE_S == 7 * 24 * 3600


# ── F2: content_type (admin-declared) ─────────────────────────────────

def test_content_type_filters_typed_search(db, monkeypatch):
    """F2: typed search เห็นเฉพาะแถวของชนิดนั้น; unclassified ถูก hold."""
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                     content_type="product", admin="t")
    zkf.apply_import(db, filename="115 - คำถามทั่วไป.xlsx", data=_xlsx_bytes({
        "faq": [["คำถาม", "คำตอบ"], ["AC65B เชื่อมต่อกี่เครื่อง", "1 เครื่อง"]],
    }), content_type="faq", subject_bindings={"faq": {"refs": ["AC65B"]}}, admin="t")
    zkf.apply_import(db, filename="099 - raw.xlsx", data=_xlsx_bytes({
        "raw": [["x", "y"], ["AC65B unclassified", "raw"]],
    }), admin="t")  # ไม่จัดชนิด
    prod, _ = zkf.zaapi_search(db, query="AC65B", refs=["AC65B"],
                             types=("product",))
    assert prod and all(h["meta"]["file"] == F1 for h in prod)
    faq, _ = zkf.zaapi_search(db, query="AC65B", refs=["AC65B"],
                            types=("faq",))
    assert faq and all(h["meta"]["file"] == "115 - คำถามทั่วไป.xlsx"
                       for h in faq)
    # unclassified row ห้ามเข้าเส้นทางคำตอบเฉพาะชนิด
    assert not any(h["meta"]["file"] == "099 - raw.xlsx"
                   for h in prod + faq)


def test_sheet_types_per_sheet(db):
    """F2: sheet_types map → row ได้ content_type ตาม sheet; registry เก็บ."""
    multi = _xlsx_bytes({
        "สินค้า": [["n", "d"], ["AC65B", "สเปค"]],
        "ปัญหา": [["p", "fix"], ["AC65B ต่อไม่ติด", "รีเซ็ต"]]})
    zkf.apply_import(db, filename="m.xlsx", data=multi,
                     sheet_types={"สินค้า": "product",
                                  "ปัญหา": "troubleshooting"}, admin="t")
    prod = db[zkf._COLL].find_one(
        {"source_file": "m.xlsx", "sheet": "สินค้า"})
    ts = db[zkf._COLL].find_one(
        {"source_file": "m.xlsx", "sheet": "ปัญหา"})
    assert prod["content_type"] == "product"
    assert ts["content_type"] == "troubleshooting"
    reg = db[zkf._FILES_COLL].find_one({"_id": "m.xlsx"})
    assert reg["sheet_types"]["ปัญหา"] == "troubleshooting"
    # re-import ไม่ส่ง types → inherit registry
    zkf.apply_import(db, filename="m.xlsx", data=multi, admin="t")
    prod2 = db[zkf._COLL].find_one(
        {"source_file": "m.xlsx", "file_rev": 2, "sheet": "สินค้า"})
    assert prod2["content_type"] == "product"


def test_invalid_content_type_rejected():
    docs = zkf.parse_upload(F1, F1_DATA)
    assert docs
    import pytest as _pt
    with _pt.raises(ValueError):
        zkf.apply_import(MemoryDb(), filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                         content_type="guessy", admin="t")


def test_preview_reports_sheet_types(db):
    multi = _xlsx_bytes({
        "สินค้า": [["n", "d"], ["AC65B", "สเปค"]],
        "ปัญหา": [["p", "fix"], ["ต่อไม่ติด", "รีเซ็ต"]]})
    r = zkf.preview_import(db, filename="m.xlsx", data=multi,
                           sheet_types={"สินค้า": "product"})
    assert r["sheet_types"]["สินค้า"] == "product"
    assert r["untyped_rows"] == 1  # sheet ปัญหา ยังไม่จัดชนิด


# ── F3: search coverage / scope ───────────────────────────────────────

def test_search_beyond_500_rows(db, monkeypatch):
    """F3A: corpus >500 — relevant row ท้ายชุดต้องถูกค้นพบ."""
    _no_embed(monkeypatch)
    rows = [["pad%d" % i, "noise %d" % i] for i in range(700)]
    rows.append(["ZZ900", "สเปคจริงของ ZZ900"])
    big = _xlsx_bytes({"s": [["k", "v"]] + rows})
    zkf.apply_import(db, filename="big.xlsx", data=big,
                     subject_bindings={"s": {"columns": [{"column_index": 1, "header": "k"}]}},
                     content_type="product", admin="t")
    hits, tr = zkf.zaapi_search(db, query="ZZ900", refs=["ZZ900"],
                                types=("product",))
    assert hits and any("ZZ900" in h["a"] for h in hits), \
        f"row beyond 500 lost: {tr}"


def test_manual_scope_and_legacy_unmigrated_excluded(db, monkeypatch):
    """F3B: manual kind=manual scope ถูกเท่านั้น; legacy unmigrated
    (kind=xlsx_row ไม่มี source_file) ห้ามรวม."""
    _no_embed(monkeypatch)
    db[zkf._COLL].insert_one({
        "_id": "leg1", "kind": "xlsx_row",
        "text": "ZZ900 legacy unmigrated", "fields": {}})
    db[zkf._COLL].insert_one({
        "_id": "manB", "kind": "manual", "text": "ZZ900 manual ShopB",
        "unscoped": False,
        "accounts": [{"name": "ShopB", "platform": "shopee"}]})
    db[zkf._COLL].insert_one({
        "_id": "manAll", "kind": "manual", "text": "ZZ900 manual ทุกร้าน",
        "unscoped": True, "accounts": []})
    db[zkf._COLL].insert_one({
        "_id": "manOff", "kind": "manual", "text": "ZZ900 manual inactive",
        "unscoped": True, "accounts": [], "active": False})
    manual_rows = [{**d, "row_index": 0} for d in db[zkf._COLL].find({"kind": "manual"})]
    _, bound = zkf._bind_subjects(manual_rows, {"-": {"refs": ["ZZ900"]}}, {}, "")
    for row in bound:
        db[zkf._COLL].update_one({"_id": row["_id"]}, {"$set": {
            "subject_refs": row["subject_refs"], "subject_digest": row["subject_digest"]}})
    hits, _ = zkf.zaapi_search(db, shop="ShopA", platform="shopee",
                             query="ZZ900", refs=["ZZ900"],
                             include_manual=True)
    files = {h["a"] for h in hits}
    assert "ZZ900 manual ทุกร้าน" in files
    assert "ZZ900 manual ShopB" not in files       # scope ผิดร้าน
    assert "ZZ900 legacy unmigrated" not in files   # legacy raw ห้ามรวม
    assert "ZZ900 manual inactive" not in files     # active=false
    hits_b, _ = zkf.zaapi_search(db, shop="ShopB", platform="shopee",
                               query="ZZ900", refs=["ZZ900"],
                               include_manual=True)
    assert "ZZ900 manual ShopB" in {h["a"] for h in hits_b}


def test_near_model_code_boundary(db, monkeypatch):
    """F3C: ref 'AC65B' ต้องไม่เป็น proof ของ 'AC65B2' — row AC65B ชนะ."""
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                     content_type="product", admin="t")
    hits, _ = zkf.zaapi_search(db, query="AC65B แบต", refs=["AC65B"],
                             types=("product",), limit=5)
    assert hits and hits[0]["meta"]["row"] == 0, \
        "AC65B2 row must not outrank AC65B on exact ref"
    b2 = next((h for h in hits if "AC65B2" in h["a"]), None)
    if b2 is not None:
        assert b2["_qa_prefilter"] < hits[0]["_qa_prefilter"]


def test_subject_binding_preview_and_search_use_declared_column(db, monkeypatch):
    _no_embed(monkeypatch)
    data = _xlsx_bytes({"products": [["model", "details"],
        ["AC65B", "รับประกัน 1 ปี"],
        ["AC65B2", "รับประกัน 2 ปี ต่างจาก AC65B"],
        ["", "รับประกัน AC65B แต่ยังไม่ยืนยันสินค้าของแถว"],
    ]})
    binding = {"products": {"columns": [{"column_index": 1, "header": "model"}]}}
    preview = zkf.preview_import(db, filename="subjects.xlsx", data=data, subject_bindings=binding)
    assert preview["bound_rows"] == 2 and preview["unbound_rows"] == 1
    assert preview["subject_samples"][0]["subject_refs"] == ["ac65b"]
    assert preview["subject_samples"][0]["cells"][0]["value"] == "AC65B"
    assert preview["sheet_columns"] == {"products": [
        {"column_index": 1, "header": "model"}, {"column_index": 2, "header": "details"}]}
    assert db[zkf._FILES_COLL].count_documents({}) == 0
    zkf.apply_import(db, filename="subjects.xlsx", data=data, subject_bindings=binding)
    hits, _ = zkf.zaapi_search(db, query="AC65B รับประกัน", refs=("AC65B",))
    assert len(hits) == 1 and "1 ปี" in hits[0]["a"]
    assert "2 ปี" not in hits[0]["a"]


@pytest.mark.parametrize("selector", [
    {"column_index": 1, "header": "wrong"},
    {"column_index": 99, "header": "model"},
    {"column_index": True, "header": "model"},
])
def test_invalid_subject_selector_rejected_before_writes(db, selector):
    data = _xlsx_bytes({"products": [["model"], ["AC65B"]]})
    with pytest.raises(ValueError, match="subject"):
        zkf.apply_import(db, filename="subjects.xlsx", data=data,
                         subject_bindings={"products": {"columns": [selector]}})
    assert db[zkf._COLL].count_documents({}) == 0
    assert db[zkf._SOURCES_COLL].count_documents({}) == 0


def test_subject_binding_is_positional_and_manual_changes_invalidate_it(db, monkeypatch):
    _no_embed(monkeypatch)
    data = _xlsx_bytes({"products": [["model", "model", "details"],
        ["AC65B2", "AC65B", "รับประกัน 2 ปี"],
    ]})
    zkf.apply_import(db, filename="subjects.xlsx", data=data,
        subject_bindings={"products": {"columns": [{"column_index": 1, "header": "model"}]}})
    assert not zkf.zaapi_search(db, query="AC65B รับประกัน", refs=("AC65B",))[0]
    assert zkf.zaapi_search(db, query="AC65B2 รับประกัน", refs=("AC65B2",))[0]
    db[zkf._COLL].update_many({}, {"$set": {"text": "AC65B2 updated fact", "manual_edit": True}})
    assert not zkf.zaapi_search(db, query="AC65B2 updated fact", refs=("AC65B2",))[0]


def test_subject_reference_edit_cannot_reuse_another_subject_proof(db, monkeypatch):
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename="proof.txt", data=b"AC65B compared with AC65B2",
                     subject_bindings={"-": {"refs": ["AC65B"]}})
    db[zkf._COLL].update_many({}, {"$set": {"subject_refs": ["ac65b2"]}})
    assert not zkf.zaapi_search(db, query="AC65B2", refs=("AC65B2",))[0]


def test_explicit_row_subjects_bind_mixed_qa_without_changing_source(db, monkeypatch):
    _no_embed(monkeypatch)
    data = _xlsx_bytes({"qa": [["question", "answer"],
        ["AC65B battery", "30 hours"], ["AC65B2 compared with AC65B", "45 hours"],
    ]})
    zkf.apply_import(db, filename="mixed.xlsx", data=data,
        subject_bindings={"qa": {"rows": {"0": ["AC65B"], "1": ["AC65B2"]}}})
    hits, _ = zkf.zaapi_search(db, query="AC65B battery", refs=("AC65B",))
    assert len(hits) == 1 and "30 hours" in hits[0]["a"]
    assert zkf.export_file(db, filename="mixed.xlsx", original=True) == data
    with pytest.raises(ValueError, match="subject"):
        zkf.apply_import(db, filename="mixed.xlsx", data=_xlsx_bytes({
            "qa": [["question", "answer"], ["different subject", "different answer"]],
        }))


def test_fixed_subject_refs_require_review_when_source_bytes_change(db, monkeypatch):
    _no_embed(monkeypatch)
    binding = {"-": {"refs": ["AC65B"]}}
    zkf.apply_import(db, filename="subject.txt", data=b"AC65B original", subject_bindings=binding)
    assert zkf.zaapi_search(db, query="AC65B", refs=("AC65B",))[0]
    with pytest.raises(ValueError, match="subject"):
        zkf.apply_import(db, filename="subject.txt", data=b"AC65B2 new product")
    assert zkf.export_file(db, filename="subject.txt", original=True) == b"AC65B original"


def test_subject_binding_survives_package_and_revision_rollback(db, monkeypatch):
    _no_embed(monkeypatch)
    binding = {"-": {"refs": ["AC65B"]}}
    zkf.apply_import(db, filename="subject.txt", data=b"AC65B first", subject_bindings=binding,
                     source_id="source-a", shop_scopes=PAIR_SCOPES)
    package = zkf.export_package(db, filename="subject.txt")
    fresh = MemoryDb()
    zkf.import_package(fresh, data=package, shops=PAIR_SCOPES)
    assert zkf.zaapi_search(fresh, shop="ShopA", platform="shopee", query="AC65B", refs=("AC65B",))[0]
    zkf.apply_import(fresh, filename="subject.txt", data=b"AC65B2 next",
                     subject_bindings={"-": {"refs": ["AC65B2"]}})
    assert not zkf.zaapi_search(fresh, shop="ShopA", platform="shopee", query="AC65B", refs=("AC65B",))[0]
    assert zkf.rollback_import(fresh, filename="subject.txt")["ok"]
    assert zkf.zaapi_search(fresh, shop="ShopA", platform="shopee", query="AC65B", refs=("AC65B",))[0]


@pytest.mark.parametrize("legacy", ["missing", "null"])
def test_package_without_subject_binding_does_not_inherit_destination_identity(db, monkeypatch, legacy):
    from shopeechat.kb_zaapi_schema import canonical_json
    _no_embed(monkeypatch)
    data = b"AC65B original source"
    zkf.apply_import(db, filename="unbound.txt", data=data, source_id="source-a", shop_scopes=PAIR_SCOPES)
    package = json.loads(zkf.export_package(db, filename="unbound.txt"))
    package.pop("integrity_sha256")
    if legacy == "missing":
        package["metadata"].pop("subject_bindings")
    else:
        package["metadata"]["subject_bindings"] = None
    package["integrity_sha256"] = hashlib.sha256(canonical_json(package).encode()).hexdigest()
    fresh = MemoryDb()
    zkf.apply_import(fresh, filename="unbound.txt", data=data, source_id="source-a", shop_scopes=PAIR_SCOPES,
                     subject_bindings={"-": {"refs": ["AC65B"]}})
    assert zkf.zaapi_search(fresh, shop="ShopA", platform="shopee", query="AC65B", refs=("AC65B",))[0]
    zkf.import_package(fresh, data=json.dumps(package).encode(), shops=PAIR_SCOPES)
    assert not zkf.zaapi_search(fresh, shop="ShopA", platform="shopee", query="AC65B", refs=("AC65B",))[0]
    assert zkf.export_file(fresh, filename="unbound.txt", original=True) == data


@pytest.mark.parametrize("requested,other", [
    ("AC65B", "AC65B2"), ("AC65B", "AC65B-2"), ("ZX100", "ZX100B"),
])
def test_model_bound_search_abstains_when_only_other_model_exists(db, monkeypatch, requested, other):
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename="identity.xlsx", content_type="product",
        subject_bindings={"products": {"columns": [{"column_index": 1, "header": "model"}]}},
        data=_xlsx_bytes({
        "products": [["model", "details"], [other, "รับประกัน 2 ปี เฉพาะสินค้ารุ่นนี้"]],
    }))
    hits, _ = zkf.zaapi_search(db, query=f"{requested} รับประกัน", refs=(requested,))
    assert hits == [], f"other-model evidence must not answer {requested}: {hits}"


def test_model_reference_in_comparison_is_not_subject_identity(db, monkeypatch):
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename="comparison.xlsx", content_type="product",
        subject_bindings={"products": {"columns": [{"column_index": 1, "header": "model"}]}},
        data=_xlsx_bytes({
        "products": [["model", "details"],
                     ["AC65B2", "AC65B2 รับประกัน 2 ปี ต่างจาก AC65B รุ่นเก่า"]],
    }))
    hits, _ = zkf.zaapi_search(db, query="AC65B รับประกัน", refs=("AC65B",))
    assert hits == [], f"a comparison mention does not bind the row to AC65B: {hits}"


def test_readiness_manual_only_not_searchable(db):
    """F3D: มีแต่ manual/legacy docs → ยังไม่พร้อม (ต้องมี active file rows)."""
    db[zkf._COLL].insert_one({
        "_id": "m", "kind": "manual", "text": "x", "unscoped": True})
    db[zkf._COLL].insert_one({
        "_id": "l", "kind": "xlsx_row", "text": "legacy"})
    r = zkf.file_kb_ready(db)
    assert r["searchable"] is False, "manual/legacy must not flip readiness"
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, admin="t")
    assert zkf.file_kb_ready(db)["searchable"] is True


# ══ correction round 2 — whole-flow audit findings ════════════════════

def test_qa_path_scoped_file_visible_to_own_shop(db, monkeypatch):
    """F-A: search_qa ต้องส่ง shop — file scope=ShopA ต้องค้นเจอตอนถามจาก
    ShopA (เดิม shop=None → scoped file มองไม่เห็นเลย)."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=TS_FILE, data=TS_DATA, subject_bindings=TS_BINDINGS,
                     content_type="troubleshooting",
                     accounts=["ShopA"], platforms=["shopee"], admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    hits = kb.search_qa("AC65B เชื่อมต่อไม่ได้", model_codes={"AC65B"},
                        shop="ShopA", platform="shopee")
    assert hits and any("รีเซ็ตหูฟัง" in h["a"] for h in hits), \
        "scoped file invisible to its own shop"
    # wrong shop → 0 evidence
    hits_b = kb.search_qa("AC65B เชื่อมต่อไม่ได้", model_codes={"AC65B"},
                          shop="ShopB", platform="shopee")
    assert not any("รีเซ็ตหูฟัง" in h["a"] for h in hits_b)


def test_qa_path_manual_doc_not_leaked_cross_shop(db, monkeypatch):
    """F-A: manual doc scoped=ShopB ห้ามรั่วผ่าน search_qa ของ ShopA."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    db[zkf._COLL].insert_one({
        "_id": "manB2", "kind": "manual",
        "text": "AC65B ShopB manual secret answer",
        "unscoped": False,
        "accounts": [{"name": "ShopB", "platform": "shopee"}],
        "active": True})
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    hits = kb.search_qa("AC65B manual secret", model_codes={"AC65B"},
                        shop="ShopA", platform="shopee")
    assert not any("ShopB manual secret" in h["a"] for h in hits), \
        "scoped manual doc leaked to other shop"


def test_get_general_faq_shop_scoped(db, monkeypatch):
    """F-A: get_general_faq ส่ง shop — warranty file scope=ShopA เห็นเฉพาะ
    ShopA; ไม่ส่ง shop (caller ไม่รู้ร้าน) → fail-closed ไม่ใช่ leak."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename="011 - เงื่อนไข.xlsx", data=_xlsx_bytes({
        "s": [["หัวข้อ", "รายละเอียด"],
              ["รับประกัน", "ประกัน ShopA เท่านั้น 2 ปี"]],
    }), content_type="warranty",
        accounts=["ShopA"], platforms=["shopee"], admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    faq = kb.get_general_faq("รับประกัน", shop="ShopA", platform="shopee")
    assert faq and "2 ปี" in faq["answer"]
    faq_b = kb.get_general_faq("รับประกัน", shop="ShopB", platform="shopee")
    assert faq_b is None or "2 ปี" not in (faq_b or {}).get("answer", "")


def test_ref_hit_hyphen_suffix_not_near_model():
    """F-D: 'AC65B' ห้าม match 'AC65B-2' — model suffix ใช้ - _ ได้ด้วย."""
    assert not zkf._ref_hit("ac65b", "หูฟัง ac65b-2 รุ่นใหม่")
    assert not zkf._ref_hit("ac65b", "หูฟัง ac65b_2 รุ่นใหม่")
    assert zkf._ref_hit("ac65b", "หูฟัง ac65b - รุ่นเก่า")
    assert zkf._ref_hit("ac65b", "ac65b")


def test_preview_per_sheet_resolved_types(db):
    """F-E: preview ต้องบอกชนิด resolved ต่อ sheet (file-level + overrides)
    — admin เห็นชัดว่า sheet ไหนเป็นชนิดใด."""
    multi = _xlsx_bytes({
        "สินค้า": [["n", "d"], ["AC65B", "สเปค"]],
        "ปัญหา": [["p", "fix"], ["ต่อไม่ติด", "รีเซ็ต"]]})
    r = zkf.preview_import(db, filename="m.xlsx", data=multi,
                           content_type="product",
                           sheet_types={"ปัญหา": "troubleshooting"})
    stm = r.get("sheet_type_map") or {}
    assert stm.get("สินค้า") == "product"
    assert stm.get("ปัญหา") == "troubleshooting"
    # file-level type alone resolves all sheets
    r2 = zkf.preview_import(db, filename="m.xlsx", data=multi,
                            content_type="warranty")
    assert (r2.get("sheet_type_map") or {}).get("ปัญหา") == "warranty"


def test_export_roundtrip_multisheet_empty_cols(db):
    """PART 2: export→reimport ชื่อเดิม — หลาย sheet + คอลัมน์ว่างต้อง
    รอด และ type/scope inherit จาก registry เดิม."""
    import io, openpyxl
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    ws = wb.create_sheet("สินค้า"); ws.append(["a", "b", "c"])
    ws.append(["x1", None, "x3"])          # คอลัมน์ว่างกลางแถว
    ws2 = wb.create_sheet("ว่างบางส่วน"); ws2.append(["k"])
    ws2.append(["v1"]); ws2.append([None]); ws2.append(["v2"])
    buf = io.BytesIO(); wb.save(buf); wb.close()
    zkf.apply_import(db, filename="rt.xlsx", data=buf.getvalue(),
                     accounts=["ShopA"], platforms=["shopee"],
                     content_type="product", sheet_types={
                         "ว่างบางส่วน": "faq"}, admin="t")
    data = zkf.export_file(db, filename="rt.xlsx")
    assert data
    # reimport ชื่อเดิม → rev2; values ต้องตรง + type/scope inherit
    zkf.apply_import(db, filename="rt.xlsx", data=data, admin="t2")
    reg = db[zkf._FILES_COLL].find_one({"_id": "rt.xlsx"})
    assert reg["active_rev"] == 2 and reg["accounts"] == ["ShopA"]
    assert reg["sheet_types"]["ว่างบางส่วน"] == "faq"
    row = db[zkf._COLL].find_one(
        {"source_file": "rt.xlsx", "file_rev": 2, "sheet": "สินค้า"})
    assert row["fields"].get("a") == "x1" and row["fields"].get("c") == "x3"
    assert row["content_type"] == "product"
    rows2 = [r for r in db[zkf._COLL].find(
        {"source_file": "rt.xlsx", "file_rev": 2, "sheet": "ว่างบางส่วน"})]
    assert all(r["content_type"] == "faq" for r in rows2)
    assert len(rows2) == 2  # แถวว่างทั้งแถวถูกข้ามตอน parse (เดิมก็ข้าม)


def test_apply_warning_returned_on_post_commit_fail(db, monkeypatch):
    """PART 2: publish สำเร็จแต่ post-commit fail → caller เห็น warning
    พร้อมพิสูจน์ pointer truth (active_rev ชี้ rev ใหม่, rows ครบ)."""
    za_coll = db[zkf._COLL]
    calls = {"n": 0}
    orig = za_coll.update_many
    def flaky(filt, upd, *a, **k):
        calls["n"] += 1
        # fail ครั้งแรกของ post-commit (unexpire own rows)
        if calls["n"] == 1 and "$unset" in upd:
            raise RuntimeError("post-commit boom")
        return orig(filt, upd, *a, **k)
    monkeypatch.setattr(type(za_coll), "update_many", flaky)
    r = zkf.apply_import(db, filename="w.xlsx", data=F1_DATA, admin="t")
    assert r["ok"] and r.get("warning"), "caller must see post-commit warning"
    reg = db[zkf._FILES_COLL].find_one({"_id": "w.xlsx"})
    assert reg["active_rev"] == 1
    n = db[zkf._COLL].count_documents(
        {"source_file": "w.xlsx", "file_rev": 1})
    assert n == r["rows"], "published rows must be complete despite warning"


def test_search_semantic_below_lexical_rank_still_found(db, monkeypatch):
    """แถวที่ถูกทางความหมายแต่ prefilter rank ต่ำ ต้องไม่ถูกตัดก่อน
    cosine — prefilter คือขอบเขตงานเดียว ไม่ใช่ตัวตัด rank."""
    from shopeechat import embedding as emb
    target = "TARGETSPEC240W"
    rows = [["q", "a"]] + [
        [f"รุ่น {i}", f"สายชาร์จ ไทป์ซี หูฟัง บลูทูธ {i}" * 3]
        for i in range(45)]
    rows.append(["รุ่น X9", f"{target} สายชาร์จ"])
    zkf.apply_import(db, filename="sem.xlsx",
                     data=_xlsx_bytes({"s": rows}),
                     content_type="product", admin="t")
    monkeypatch.setattr(emb, "embed_query", lambda *a, **k: [1.0, 0.0])
    monkeypatch.setattr(emb, "embed_texts", lambda texts, *a, **k: [
        [1.0, 0.0] if target in t else [0.0, 1.0] for t in texts])
    hits, trace = zkf.zaapi_search(
        db, query="สายชาร์จ ไทป์ซี หูฟัง บลูทูธ", limit=5)
    assert hits and target in hits[0]["a"], (
        f"semantic-best row ต้องชนะ cosine แม้ prefilter rank ต่ำ "
        f"(hits={[h['meta'] for h in hits]}, trace={trace})")


def test_export_txt_roundtrip_verbatim(db):
    """export .txt ต้องคืน text bytes ตรงต้นฉบับ — re-import ชื่อเดิม
    ได้ข้อมูลแถวเดิม (xlsx bytes ใต้ชื่อ .txt = round-trip พัง)."""
    orig = "เงื่อนไขประกัน 1 ปี\nทุกรุ่น ยกเว้นรุ่นเดโม่".encode("utf-8")
    zkf.apply_import(db, filename="w.txt", data=orig, admin="t")
    data = zkf.export_file(db, filename="w.txt")
    assert data == orig.decode("utf-8").encode("utf-8")
    # re-import ชื่อเดิม = replace: text เหมือนเดิมทุกประการ
    r = zkf.apply_import(db, filename="w.txt", data=data, admin="t")
    assert r["ok"]
    row = db["zaapi_kb"].find_one(
        {"source_file": "w.txt", "file_rev": r["rev"]})
    assert row["text"] == orig.decode("utf-8")


def test_reapply_after_rollback_retires_stale_attempt(db):
    """rev2/apply_a → rollback rev1 → re-apply (rev2/apply_b ใหม่):
    แถว apply_a ของ rev2 ต้องได้ expire_at (invisible อยู่แล้วแต่ต้องถูก
    sweep ได้ ไม่ค้างตลอด)."""
    zkf.apply_import(db, filename="rr.xlsx", data=F1_DATA, admin="t")
    zkf.apply_import(db, filename="rr.xlsx", data=F1_EDITED, admin="t")
    zkf.rollback_import(db, filename="rr.xlsx", admin="t")
    # rev1 active อีกครั้ง; rev2 (attempt เดิม) = prev
    zkf.apply_import(db, filename="rr.xlsx", data=F1_DATA, admin="t")
    reg = db[zkf._FILES_COLL].find_one({"_id": "rr.xlsx"})
    assert reg["active_rev"] == 2
    cur_apply = reg["active_apply"]
    rows = list(db[zkf._COLL].find(
        {"source_file": "rr.xlsx", "file_rev": 2}))
    assert rows, "rev2 rows should exist (old + new attempt)"
    stale = [r for r in rows if r["apply_id"] != cur_apply]
    assert stale, "old attempt rows of rev2 should still exist pre-sweep"
    assert all("expire_at" in r for r in stale), \
        "stale same-rev attempts must be re-expired for sweep"
    assert all("expire_at" not in r for r in rows
               if r["apply_id"] == cur_apply)


def test_platform_scope_case_insensitive(db, monkeypatch):
    """platform stored display-case ('Shopee' จาก UI) ต้อง match
    req.platform lowercase ('shopee') — ไม่เช่นนั้น file scoped ตายเงียบ."""
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                     platforms=["Shopee"], admin="t")
    hits, _ = zkf.zaapi_search(db, shop=None, platform="shopee",
                             query="AC65B", refs=["AC65B"])
    assert hits, "lowercase platform ต้อง match display-case ที่เก็บ"
    # registry normalize เป็น lowercase ด้วย
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["platforms"] == ["shopee"]
    # platform อื่นยังถูกกันออก
    hits2, _ = zkf.zaapi_search(db, shop=None, platform="lazada",
                                query="AC65B", refs=["AC65B"])
    assert not hits2


def test_file_kb_ready_ignores_scope(db):
    """readiness = มี active file rows ตาม triple — ไม่กรอง shop/platform
    (file ที่ scope ไว้ก็ยังเป็นข้อมูลที่พร้อมเสิร์ฟร้านนั้น)."""
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS,
                     accounts=["ShopA"], platforms=["shopee"], admin="t")
    r = zkf.file_kb_ready(db)
    assert r["searchable"] and r["active_rows"] == 2, (
        f"scoped file ต้องนับเป็น active rows ใน readiness — got {r}")


def test_manual_platform_scope_case_fold(db, monkeypatch):
    """manual doc accounts[].platform display-case ต้อง match lowercase
    platform ของผู้ค้น (ข้อมูล legacy มี display-case อยู่แล้ว)."""
    _no_embed(monkeypatch)
    db[zkf._COLL].insert_one({
        "_id": "m1", "kind": "manual", "text": "shopA only answer",
        "fields": {}, "active": True,
        "accounts": [{"name": "ShopA", "platform": "Shopee"}]})
    hits, _ = zkf.zaapi_search(db, shop="ShopA", platform="shopee",
                               query="answer", include_manual=True)
    assert hits and hits[0]["a"] == "shopA only answer"


def test_parse_duplicate_and_unnamed_cells_keep_positions():
    data = _xlsx_bytes({"ข้อมูล": [
        ["รุ่น", "ฟีเจอร์", "ฟีเจอร์", None, "จำนวน", "เปิด"],
        ["AUD100", "first value", "second value", "unnamed value", 0, False],
    ]})
    row = zkf.parse_upload("cells.xlsx", data)[0]
    assert row["cells"] == [
        {"column_index": 1, "header": "รุ่น", "value": "AUD100"},
        {"column_index": 2, "header": "ฟีเจอร์", "value": "first value"},
        {"column_index": 3, "header": "ฟีเจอร์", "value": "second value"},
        {"column_index": 4, "header": "", "value": "unnamed value"},
        {"column_index": 5, "header": "จำนวน", "value": "0"},
        {"column_index": 6, "header": "เปิด", "value": "False"},
    ]
    assert all(s in row["text"] for s in (
        "first value", "second value", "unnamed value", "จำนวน: 0", "เปิด: False"))


def test_parse_headerless_nonempty_row_is_not_discarded():
    data = _xlsx_bytes({"ข้อมูล": [[None, None], ["AUD100", "รับประกัน 2 ปี"]]})
    row = zkf.parse_upload("no-header.xlsx", data)[0]
    assert row["source_row"] == 2
    assert [c["value"] for c in row["cells"]] == ["AUD100", "รับประกัน 2 ปี"]


def test_duplicate_cells_survive_apply_export_reimport(db):
    data = _xlsx_bytes({"ข้อมูล": [
        ["รุ่น", "ฟีเจอร์", "ฟีเจอร์", None],
        ["AUD100", "first value", "second value", "unnamed value"],
        [None, None, None, None],
        ["AUD200", "other first", "other second", None],
    ]})
    zkf.apply_import(db, filename="cells.xlsx", data=data)
    before = list(db[zkf._COLL].find({"source_file": "cells.xlsx", "file_rev": 1}))
    out = zkf.export_file(db, filename="cells.xlsx")
    after = zkf.parse_upload("cells.xlsx", out)
    assert [r["cells"] for r in before] == [r["cells"] for r in after]
    assert [r["text"] for r in before] == [r["text"] for r in after]
    assert [r["source_row"] for r in after] == [2, 4]


def test_preview_reports_duplicate_and_unnamed_columns(db):
    data = _xlsx_bytes({"ข้อมูล": [["h", "h", None], ["a", "b", "c"]]})
    result = zkf.preview_import(db, filename="cells.xlsx", data=data)
    assert result["duplicate_columns"] == [{"sheet": "ข้อมูล", "header": "h", "columns": [1, 2]}]
    assert result["unnamed_columns"] == [{"sheet": "ข้อมูล", "columns": [3]}]
    assert result["warnings"]
    assert db[zkf._COLL].count_documents({}) == 0


@pytest.mark.parametrize("suffix", ["xlsx", "txt"])
def test_original_bytes_follow_active_disabled_and_rollback(db, suffix):
    first = F1_DATA if suffix == "xlsx" else "  รับประกัน 1 ปี\r\n\r\n".encode()
    second = F1_EDITED if suffix == "xlsx" else "\ufeffรับประกัน 2 ปี\n".encode()
    fn = f"original.{suffix}"
    zkf.apply_import(db, filename=fn, data=first)
    zkf.apply_import(db, filename=fn, data=second)
    assert zkf.export_file(db, filename=fn, original=True) == second
    zkf.set_file_enabled(db, filename=fn, enabled=False)
    assert zkf.export_file(db, filename=fn, original=True) == second
    zkf.set_file_enabled(db, filename=fn, enabled=True)
    assert zkf.rollback_import(db, filename=fn)["ok"]
    assert zkf.export_file(db, filename=fn, original=True) == first


def test_original_export_legacy_revision_is_explicitly_unavailable(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA)
    db[zkf._SOURCES_COLL].delete_many({})
    assert zkf.export_file(db, filename=F1, original=True) is None
    assert zkf.export_file(db, filename=F1)


def test_export_cell_text_is_not_reinterpreted_as_formula(db):
    wb = Workbook()
    ws = wb.active
    ws.append(["value"])
    ws.append(["=1+1"])
    ws.cell(2, 1).data_type = "s"
    buf = io.BytesIO()
    wb.save(buf)
    wb.close()
    zkf.apply_import(db, filename="literal.xlsx", data=buf.getvalue())
    out = zkf.export_file(db, filename="literal.xlsx")
    parsed = zkf.parse_upload("literal.xlsx", out)
    assert parsed[0]["fields"]["value"] == "=1+1"
    wb2 = load_workbook(io.BytesIO(out), data_only=False)
    assert wb2.active.cell(2, 1).data_type == "s"
    wb2.close()


def test_original_export_checks_stored_checksum(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA)
    db[zkf._SOURCES_COLL].update_many({}, {"$set": {"data": b"corrupt"}})
    with pytest.raises(ValueError, match="checksum"):
        zkf.export_file(db, filename=F1, original=True)


def test_original_sources_are_attempt_scoped_and_swept(db, monkeypatch):
    zkf.apply_import(db, filename=F1, data=F1_DATA)
    files = db[zkf._FILES_COLL]
    monkeypatch.setattr(type(files), "find_one", lambda *a, **k: None)
    assert zkf.apply_import(db, filename=F1, data=F1_EDITED)["conflict"]
    monkeypatch.undo()
    assert db[zkf._SOURCES_COLL].count_documents({}) == 1
    assert zkf.export_file(db, filename=F1, original=True) == F1_DATA
    zkf.apply_import(db, filename=F1, data=F1_EDITED)
    past = datetime.now(timezone.utc) - timedelta(seconds=10)
    db[zkf._SOURCES_COLL].update_many({}, {"$set": {"expire_at": past}})
    zkf.sweep_expired(db)
    assert db[zkf._SOURCES_COLL].count_documents({}) == 1
    assert zkf.export_file(db, filename=F1, original=True) == F1_EDITED


def test_original_sources_stay_exportable_when_disabled_and_expired(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA)
    zkf.set_file_enabled(db, filename=F1, enabled=False)
    past = datetime.now(timezone.utc) - timedelta(seconds=10)
    db[zkf._SOURCES_COLL].update_many({}, {"$set": {"expire_at": past}})
    zkf.sweep_expired(db)
    assert zkf.export_file(db, filename=F1, original=True) == F1_DATA


def test_source_write_failure_does_not_publish_rows(db, monkeypatch):
    original = type(db[zkf._SOURCES_COLL]).insert_one
    sources = db[zkf._SOURCES_COLL]
    def fail(self, doc, **kwargs):
        if self is sources:
            raise RuntimeError("source storage unavailable")
        return original(self, doc, **kwargs)
    monkeypatch.setattr(type(sources), "insert_one", fail)
    with pytest.raises(RuntimeError, match="source storage"):
        zkf.apply_import(db, filename=F1, data=F1_DATA)
    assert db[zkf._FILES_COLL].count_documents({}) == 0
    assert db[zkf._COLL].count_documents({}) == 0


def test_human_export_retains_manual_field_edits_and_original_source(db):
    data = _xlsx_bytes({"ข้อมูล": [["รุ่น", "ฟีเจอร์", "ฟีเจอร์"],
                                     ["AUD100", "first", "second"]]})
    zkf.apply_import(db, filename="edited.xlsx", data=data)
    db[zkf._COLL].update_many({}, {"$set": {
        "manual_edit": True,
        "fields": {"รุ่น": "AUD100", "ฟีเจอร์": "edited", "เพิ่ม": "new"},
    }})
    exported = zkf.parse_upload("edited.xlsx", zkf.export_file(db, filename="edited.xlsx"))[0]
    assert exported["fields"]["ฟีเจอร์"] == "edited"
    assert exported["fields"]["เพิ่ม"] == "new"
    assert exported["cells"][1]["value"] == "first"
    assert zkf.export_file(db, filename="edited.xlsx", original=True) == data


PAIR_SCOPES = [
    {"key": "shopee|shop-a", "platform": "shopee", "shop_id": "shop-a", "shopname": "ShopA"},
    {"key": "lazada|shop-b", "platform": "lazada", "shop_id": "shop-b", "shopname": "ShopB"},
]


def _mapping_inputs():
    source = json.dumps({"items": [
        {"id": "source-a", "downloaded_file": {"file": "mapped.xlsx", "sha256": hashlib.sha256(F1_DATA).hexdigest()}},
        {"id": "source-b", "downloaded_file": {"file": "unmapped.txt", "sha256": hashlib.sha256(b"unmapped").hexdigest()}},
    ]}).encode()
    mapping = {
        "version": 1, "zaapi_source_sha256": hashlib.sha256(source).hexdigest(),
        "shops_sha256": "a" * 64, "mapping": {"source-a": [s["key"] for s in PAIR_SCOPES]},
        "rows": [{"source_id": "source-a", "file": "mapped.xlsx", "shops": deepcopy(PAIR_SCOPES)}],
    }
    return mapping, source


def test_validated_mapping_keeps_explicit_pairs_and_unmapped_sources():
    mapping, source = _mapping_inputs()
    plan = zkf.validate_shop_mapping(json.dumps(mapping).encode(), source, PAIR_SCOPES)
    assert len(plan) == 2
    selected = next(r for r in plan if r["source_id"] == "source-a")
    assert selected["filename"] == "mapped.xlsx"
    assert selected["shop_scopes"] == sorted(PAIR_SCOPES, key=lambda s: s["key"])
    assert selected["file_sha256"] == hashlib.sha256(F1_DATA).hexdigest()
    assert next(r for r in plan if r["source_id"] == "source-b")["shop_scopes"] == []


@pytest.mark.parametrize("corruption", ["source_hash", "source_id", "shop_key", "row_pairs", "filename", "duplicate_pair"])
def test_mapping_rejects_inconsistent_or_stale_input(corruption):
    mapping, source = _mapping_inputs()
    if corruption == "source_hash":
        source += b" "
    elif corruption == "source_id":
        mapping["mapping"]["unknown"] = []
    elif corruption == "shop_key":
        mapping["mapping"]["source-a"] = ["shopee|unknown"]
    elif corruption == "row_pairs":
        mapping["rows"][0]["shops"] = PAIR_SCOPES[:1]
    elif corruption == "filename":
        mapping["rows"][0]["file"] = "other.xlsx"
    else:
        mapping["mapping"]["source-a"].append(PAIR_SCOPES[0]["key"])
    with pytest.raises(ValueError):
        zkf.validate_shop_mapping(json.dumps(mapping).encode(), source, PAIR_SCOPES)


def test_pair_scope_does_not_form_cartesian_product(db, monkeypatch):
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-a", shop_scopes=PAIR_SCOPES)
    for shop, platform, expected in [
        ("ShopA", "shopee", True), ("ShopB", "lazada", True),
        ("shop-a", "shopee", True), ("ShopA", "lazada", False),
        ("ShopB", "shopee", False), (None, "shopee", False), ("ShopA", None, False),
    ]:
        hits, _ = zkf.zaapi_search(db, shop=shop, platform=platform, query="AC65B", refs=("AC65B",))
        assert bool(hits) is expected, (shop, platform)


def test_explicit_unmapped_source_is_not_global(db, monkeypatch):
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="unmapped", shop_scopes=[])
    for shop, platform in [("ShopA", "shopee"), (None, None)]:
        assert not zkf.zaapi_search(db, shop=shop, platform=platform, query="AC65B")[0]


def test_pair_metadata_inherits_and_rolls_back_with_revision(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-a", shop_scopes=PAIR_SCOPES[:1])
    zkf.apply_import(db, filename=F1, data=F1_EDITED, shop_scopes=PAIR_SCOPES[1:])
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["source_id"] == "source-a" and reg["shop_scopes"] == PAIR_SCOPES[1:]
    assert zkf.rollback_import(db, filename=F1)["ok"]
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["shop_scopes"] == PAIR_SCOPES[:1]
    assert reg["file_sha256"] == hashlib.sha256(F1_DATA).hexdigest()


def test_source_binding_rejects_accidental_reassignment(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-a", shop_scopes=PAIR_SCOPES)
    with pytest.raises(ValueError):
        zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-b", shop_scopes=PAIR_SCOPES)
    with pytest.raises(ValueError):
        zkf.apply_import(db, filename=F2, data=F1_DATA, source_id="source-a", shop_scopes=PAIR_SCOPES)
    assert db[zkf._FILES_COLL].count_documents({}) == 1


def test_unmapped_only_is_not_kb_ready(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="unmapped", shop_scopes=[])
    for scopes in ([], [{}], "invalid"):
        db[zkf._FILES_COLL].update_one({"_id": F1}, {"$set": {"shop_scopes": scopes}})
        assert not zkf.file_kb_ready(db)["searchable"]


def test_list_files_exposes_explicit_scope_instead_of_global_arrays(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-a", shop_scopes=PAIR_SCOPES)
    row = zkf.list_files(db)[0]
    assert row["source_id"] == "source-a"
    assert row["shop_scopes"] == sorted(PAIR_SCOPES, key=lambda s: s["key"])
    assert row["subject_bindings"] == F1_BINDINGS


def test_validated_plan_checks_file_hash_before_publish(db):
    mapping, source = _mapping_inputs()
    plan = zkf.validate_shop_mapping(json.dumps(mapping).encode(), source, PAIR_SCOPES)
    selected = next(p for p in plan if p["source_id"] == "source-a")
    with pytest.raises(ValueError, match="checksum"):
        zkf.apply_import(db, data=F1_EDITED, **selected)
    assert db[zkf._FILES_COLL].count_documents({}) == 0
    assert zkf.apply_import(db, data=F1_DATA, **selected)["ok"]
    reg = db[zkf._FILES_COLL].find_one({"_id": "mapped.xlsx"})
    assert reg["mapping_sha256"] == selected["mapping_sha256"]


def test_strict_scope_rollback_does_not_reopen_legacy_global_revision(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA)
    zkf.apply_import(db, filename=F1, data=F1_EDITED, source_id="source-a", shop_scopes=PAIR_SCOPES)
    result = zkf.rollback_import(db, filename=F1)
    assert result["ok"] is False and result["reason"] == "prev_scope_unverified"
    assert db[zkf._FILES_COLL].find_one({"_id": F1})["active_rev"] == 2


def test_source_package_roundtrip_preserves_scope_raw_rows_and_manual_edits(db, monkeypatch):
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-a",
                     shop_scopes=PAIR_SCOPES, content_type="product")
    db[zkf._COLL].update_many({"source_row": 2}, {"$set": {
        "manual_edit": True, "fields": {"model": "AUD100", "value": "edited fact"},
        "text": "AUD100 edited fact",}})
    package = zkf.export_package(db, filename=F1)
    fresh = MemoryDb()
    result = zkf.import_package(fresh, data=package, shops=PAIR_SCOPES)
    assert result["ok"]
    reg = fresh[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["shop_scopes"] == sorted(PAIR_SCOPES, key=lambda s: s["key"])
    assert reg["source_id"] == "source-a" and reg["content_type"] == "product"
    assert zkf.export_file(fresh, filename=F1, original=True) == F1_DATA
    before = list(db[zkf._COLL].find({}).sort("row_index"))
    after = list(fresh[zkf._COLL].find({}).sort("row_index"))
    for key in ("cells", "fields", "text", "source_row", "content_type"):
        assert [r.get(key) for r in before] == [r.get(key) for r in after], key
    assert not zkf.zaapi_search(fresh, shop="ShopA", platform="lazada", query="AUD100")[0]


def test_source_package_rejects_tampering_and_unknown_shops_before_writes(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-a", shop_scopes=PAIR_SCOPES)
    package = zkf.export_package(db, filename=F1)
    fresh = MemoryDb()
    with pytest.raises(ValueError):
        zkf.import_package(fresh, data=package, shops=PAIR_SCOPES[:1])
    manifest = json.loads(package)
    manifest["filename"] = "other.xlsx"
    with pytest.raises(ValueError):
        zkf.import_package(fresh, data=json.dumps(manifest).encode(), shops=PAIR_SCOPES)
    assert fresh[zkf._COLL].count_documents({}) == 0
    assert fresh[zkf._FILES_COLL].count_documents({}) == 0


def test_source_package_preview_is_read_only(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, subject_bindings=F1_BINDINGS, source_id="source-a", shop_scopes=[])
    package = zkf.export_package(db, filename=F1)
    fresh = MemoryDb()
    result = zkf.import_package(fresh, data=package, shops=PAIR_SCOPES, preview=True)
    assert result["new_rows"] == 2 and result["shop_scopes"] == []
    assert fresh[zkf._FILES_COLL].count_documents({}) == 0
    assert fresh[zkf._SOURCES_COLL].count_documents({}) == 0


def test_validated_corpus_mapping_snapshot():
    mapping_file = os.environ.get("ZAAPI_MAPPING_FILE")
    snapshot_file = os.environ.get("ZAAPI_MAPPING_SNAPSHOT_HTML")
    source_dir = os.environ.get("ZAAPI_CORPUS_DIR")
    if not all((mapping_file, snapshot_file, source_dir)):
        pytest.skip("set mapping, snapshot HTML and corpus paths for frozen mapping validation")
    html = Path(snapshot_file).read_text()
    snapshot = json.loads(html.split('<script id="snapshot" type="application/json">', 1)[1].split('</script>', 1)[0])
    source = (Path(source_dir).parent / "knowledge-sources.json").read_bytes()
    plan = zkf.validate_shop_mapping(Path(mapping_file).read_bytes(), source, snapshot["shops"])
    assert len(plan) == 118
    assert sum(bool(p["shop_scopes"]) for p in plan) == 103
    assert sum(len(p["shop_scopes"]) for p in plan) == 693
    assert len({s["key"] for p in plan for s in p["shop_scopes"]}) == 60
    imported = MemoryDb()
    for item in plan:
        data = (Path(source_dir) / item["filename"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item["file_sha256"]
        assert zkf.apply_import(imported, data=data, **item)["ok"]
        package = zkf.export_package(imported, filename=item["filename"])
        fresh = MemoryDb()
        assert zkf.import_package(fresh, data=package, shops=snapshot["shops"])["ok"]
        reg = fresh[zkf._FILES_COLL].find_one({"_id": item["filename"]})
        assert reg["shop_scopes"] == item["shop_scopes"]
        assert reg["mapping_sha256"] == item["mapping_sha256"]
        assert zkf.export_file(fresh, filename=item["filename"], original=True) == data
    for shop in zkf._norm_shop_scopes(snapshot["shops"]):
        expected = {p["filename"] for p in plan if shop["key"] in {s["key"] for s in p["shop_scopes"]}}
        pairs, _ = zkf._visible_pairs(imported, shop["shop_id"], shop["platform"])
        assert {p["source_file"] for p in pairs} == expected, shop["key"]


def test_corpus_positional_cells_and_original_bytes_roundtrip():
    root = os.environ.get("ZAAPI_CORPUS_DIR")
    if not root:
        pytest.skip("set ZAAPI_CORPUS_DIR to a local knowledge-files directory")
    files = sorted(p for p in Path(root).iterdir() if p.suffix.lower() in zkf._EXTS)
    assert files
    for path in files:
        data = path.read_bytes()
        parsed = zkf.parse_upload(path.name, data)
        db = MemoryDb()
        zkf.apply_import(db, filename=path.name, data=data)
        assert zkf.export_file(db, filename=path.name, original=True) == data, path.name
        exported = zkf.parse_upload(path.name, zkf.export_file(db, filename=path.name))
        view = lambda rows: [(r.get("sheet"), r.get("source_row"), r.get("cells"),
                              r["fields"], r["text"]) for r in rows]
        assert view(parsed) == view(exported), path.name
        if path.suffix.lower() != ".xlsx":
            continue
        wb = load_workbook(io.BytesIO(data), data_only=True)
        try:
            actual = {(r["sheet"], r["source_row"]): r for r in parsed}
            for ws in wb.worksheets:
                for rownum, values in enumerate(ws.iter_rows(values_only=True), 1):
                    if rownum == 1 or not any(zkf._clean(v) for v in values):
                        continue
                    row = actual[(ws.title, rownum)]
                    assert [c["value"] for c in row["cells"]] == [
                        "" if v is None else str(v) for v in values], (path.name, rownum)
        finally:
            wb.close()
