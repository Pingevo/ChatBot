"""Zaapi file-backed KB — import/export/search contract tests.

Offline: MemoryColl/FakeDb doubles (no mongod). Real Mongo: set env
ZAAPI_TEST_MONGO_URI (disposable container/db) — same assertions run
against pymongo; collections are created/dropped under a `zztest_` DB.
"""
from __future__ import annotations

import io
import os
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[2]
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
    def sort(self, keys):
        ks = keys if isinstance(keys, list) else [keys]
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
    r = zkf.preview_import(db, filename=F1, data=F1_DATA,
                           accounts=["ShopA"], platforms=["shopee"])
    assert r["new_rows"] == 2 and r["replaces_rev"] is None
    assert r["new_rev"] == 1 and r["accounts"] == ["ShopA"]
    # zero writes — no collections touched
    assert db[zkf._COLL].count_documents({}) == 0
    assert db[zkf._FILES_COLL].count_documents({}) == 0
    assert db[zkf._LOG_COLL].count_documents({}) == 0


# ── apply / replace / rollback / sweep ─────────────────────────────────

def test_apply_new_file(db):
    r = zkf.apply_import(db, filename=F1, data=F1_DATA,
                         accounts=["ShopA"], platforms=["shopee"],
                         admin="t")
    assert r["ok"] and r["rev"] == 1 and r["rows"] == 2
    reg = db[zkf._FILES_COLL].find_one({"_id": F1})
    assert reg["active_rev"] == 1 and reg["accounts"] == ["ShopA"]
    assert db[zkf._COLL].count_documents(
        {"source_file": F1, "file_rev": 1}) == 2
    assert db[zkf._LOG_COLL].count_documents({"op": "apply"}) == 1


def test_same_filename_replaces_new_filename_adds(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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


def test_rollback_fails_after_sweep(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA,
                     accounts=["ShopA"], platforms=["shopee"], admin="t")
    zkf.apply_import(db, filename=F2, data=F1_EDITED,
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
                     content_type="faq", admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    hits = kb.search_qa("แบตอยู่กี่ชม.", model_codes={"AC65B"})
    texts = [h["a"] for h in hits]
    assert any("AC65B อยู่ได้ 30" in t for t in texts)
    assert not any("AC65B2 อยู่ได้ 45" in t for t in texts), \
        "doc ผูก AC65B2 ต้องไม่ตอบคำถาม AC65B"


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
    zkf.apply_import(db, filename=F1, data=F1_DATA,
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


def test_readiness_searchable(db):
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=TS_FILE, data=TS_DATA,
                     content_type="troubleshooting", admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    tips = kb.qa_troubleshoot_tips("หูฟัง AC65B เชื่อมต่อไม่ได้",
                                   snap=None, min_sim=0.3)
    assert tips and any("รีเซ็ตหูฟัง" in t for t in tips)


def test_qa_context_zaapi(db, monkeypatch):
    """app.chat() → _qa_ctx path: zaapi hit กลายเป็น คำตอบอ้างอิง."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=TS_FILE, data=TS_DATA,
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
    monkeypatch.setattr(kb, "_admin_db", lambda: db)
    assert kb.search_qa("กาแล็กซี่ S999 ราคาเท่าไหร่",
                        model_codes={"S999"}) == []


# ══ correction round 1 — independent review findings ══════════════════
# RED: executable reproductions of data-loss/coverage/scope bugs.

def test_post_commit_failure_never_deletes_active_rev(db, monkeypatch):
    """F1A: retire/log ล้มหลัง CAS → active rev ห้ามถูกลบ + ต้องรายงานจริง."""
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    rA = zkf.apply_import(db, filename=F1, data=F1_DATA, admin="a")
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
        zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
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
    zkf.apply_import(db, filename=F1, data=F1_DATA,
                     content_type="product", admin="t")
    zkf.apply_import(db, filename="115 - คำถามทั่วไป.xlsx", data=_xlsx_bytes({
        "faq": [["คำถาม", "คำตอบ"], ["AC65B เชื่อมต่อกี่เครื่อง", "1 เครื่อง"]],
    }), content_type="faq", admin="t")
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
        zkf.apply_import(MemoryDb(), filename=F1, data=F1_DATA,
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
    zkf.apply_import(db, filename=F1, data=F1_DATA,
                     content_type="product", admin="t")
    hits, _ = zkf.zaapi_search(db, query="AC65B แบต", refs=["AC65B"],
                             types=("product",), limit=5)
    assert hits and hits[0]["meta"]["row"] == 0, \
        "AC65B2 row must not outrank AC65B on exact ref"
    b2 = next((h for h in hits if "AC65B2" in h["a"]), None)
    if b2 is not None:
        assert b2["_qa_prefilter"] < hits[0]["_qa_prefilter"]


def test_readiness_manual_only_not_searchable(db):
    """F3D: มีแต่ manual/legacy docs → ยังไม่พร้อม (ต้องมี active file rows)."""
    db[zkf._COLL].insert_one({
        "_id": "m", "kind": "manual", "text": "x", "unscoped": True})
    db[zkf._COLL].insert_one({
        "_id": "l", "kind": "xlsx_row", "text": "legacy"})
    r = zkf.file_kb_ready(db)
    assert r["searchable"] is False, "manual/legacy must not flip readiness"
    zkf.apply_import(db, filename=F1, data=F1_DATA, admin="t")
    assert zkf.file_kb_ready(db)["searchable"] is True


# ══ correction round 2 — whole-flow audit findings ════════════════════

def test_qa_path_scoped_file_visible_to_own_shop(db, monkeypatch):
    """F-A: search_qa ต้องส่ง shop — file scope=ShopA ต้องค้นเจอตอนถามจาก
    ShopA (เดิม shop=None → scoped file มองไม่เห็นเลย)."""
    from shopeechat import knowledge_base as kb
    _no_embed(monkeypatch)
    zkf.apply_import(db, filename=TS_FILE, data=TS_DATA,
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
    zkf.apply_import(db, filename=F1, data=F1_DATA,
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
    zkf.apply_import(db, filename=F1, data=F1_DATA,
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
