"""Phase 4B — atomic daily evidence refresh contract suite (offline only).

Pins the corrected generation/pointer contract against the real owners:

- one generation_id per run; every artifact carries/verifies against it
- OCR cache (`image_texts`) vs published evidence (`image_texts_g<gid>`) split
- finalize-before-pointer publication order; single fenced CAS; pointer-only rollback
- one EvidenceSnapshot per request reaching units coll, OCR coll, unit NPZ, product NPZ
- 24h grace cleanup protecting active/previous/young/in-flight generations
- native flock contention behavior (via stubbed PATH binaries)
- bounded provider budget: --max-calls counts every attempt, --max-runtime-min,
  quota/cap exhaustion -> deferred (never error, never failed generation)

Offline: tmp dirs, FakeDb/GenColl doubles, injected clock, leaf stubs for
_extract_one / embed_texts / provider seams. No torch, no provider calls,
no real Mongo, no .env.
"""
from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))                # chatbot.shopeechat.scripts.*
sys.path.insert(0, str(ROOT / "chatbot"))    # shopeechat.*
sys.path.insert(0, str(TEST_DIR))            # replay fakes

from test_legacy_turn_incident_replay import (FakeClient, FakeColl,  # noqa: E402
                                              FakeDb)

# ── provider/env stubs installed BEFORE any script-module import ─────────────

def _install_script_stubs() -> None:
    """Block .env reads + provider clients before chatbot.shopeechat.scripts.* import."""
    if "dotenv" not in sys.modules or not hasattr(sys.modules["dotenv"], "load_dotenv"):
        mod = sys.modules.setdefault("dotenv", types.ModuleType("dotenv"))
        mod.load_dotenv = lambda *a, **k: False
    else:
        sys.modules["dotenv"].load_dotenv = lambda *a, **k: False
    import chatbot.shopeechat  # noqa: F401  (package __init__ — docstring only)
    llm_stub = types.ModuleType("chatbot.shopeechat.llm")
    llm_stub._API_KEYS = ["stub-key"]
    llm_stub._gemini_cost = lambda *a, **k: 0.0
    sys.modules.setdefault("chatbot.shopeechat.llm", llm_stub)
    ws_stub = types.ModuleType("chatbot.shopeechat.web_search")
    ws_stub._log_ai_usage = lambda *a, **k: None
    sys.modules.setdefault("chatbot.shopeechat.web_search", ws_stub)


_install_script_stubs()


def _script(name: str):
    return importlib.import_module(f"chatbot.shopeechat.scripts.{name}")


def _pkg(name: str):
    return importlib.import_module(f"shopeechat.{name}")


# ── gen-aware collection double ──────────────────────────────────────────────

class GenColl(FakeColl):
    """FakeColl + insert_many/replace_one/bulk_write/drop + _id uniqueness +
    write-order recording for publication-order assertions."""

    def __init__(self, docs=None, name="", db=None):
        super().__init__(docs)
        self.name = name
        self._db = db
        self.indexes: list = []
        self.dropped = False

    def _check_id(self, doc):
        from pymongo.errors import DuplicateKeyError
        if "_id" in doc and any(d.get("_id") == doc["_id"] for d in self._docs):
            raise DuplicateKeyError(f"dup _id {doc['_id']}")

    def insert_one(self, doc, *a, **k):
        self._check_id(doc)
        return super().insert_one(doc)

    def insert_many(self, docs, *a, **k):
        for d in docs:
            self._check_id(d)
        for d in docs:
            self._docs.append(dict(d))
        return types.SimpleNamespace(inserted_ids=list(range(len(docs))))

    def bulk_write(self, ops, *a, **k):
        from pymongo import UpdateOne
        n = 0
        for op in ops:
            if isinstance(op, UpdateOne):
                filt, update = op._filter, op._doc
                hit = False
                for d in self._docs:
                    from test_legacy_turn_incident_replay import _match
                    if _match(d, filt):
                        self._apply(d, update)
                        hit = True
                if not hit and op._upsert:
                    doc = {k: v for k, v in filt.items() if not k.startswith("$")}
                    self._apply(doc, update)
                    self._check_id(doc)
                    self._docs.append(doc)
                n += 1
        return types.SimpleNamespace(
            upserted_count=0, modified_count=n, matched_count=n)

    def replace_one(self, filt, doc, upsert=False, *a, **k):
        from test_legacy_turn_incident_replay import _match
        for i, d in enumerate(self._docs):
            if _match(d, filt):
                self._docs[i] = dict(doc)
                return types.SimpleNamespace(matched_count=1, upserted_id=None)
        if upsert:
            self._check_id(doc)
            self._docs.append(dict(doc))
            return types.SimpleNamespace(matched_count=0, upserted_id=len(self._docs))
        return types.SimpleNamespace(matched_count=0, upserted_id=None)

    def update_one(self, filt, update, upsert=False, *a, **k):
        # fenced bootstrap: upsert that would create a doc with an _id that
        # already exists must raise DuplicateKeyError (real Mongo behavior)
        from test_legacy_turn_incident_replay import _match
        if not any(_match(d, filt) for d in self._docs) and upsert:
            doc = {k: v for k, v in (filt or {}).items() if not k.startswith("$")}
            self._apply(doc, update)
            self._check_id(doc)
            self._docs.append(doc)
            return types.SimpleNamespace(matched_count=0, upserted_id=len(self._docs))
        return super().update_one(filt, update, upsert=upsert, *a, **k)

    def create_index(self, spec, *a, **k):
        self.indexes.append(spec)
        return None

    def drop(self, *a, **k):
        self.dropped = True
        self._docs.clear()
        if self._db is not None:
            self._db._colls.pop(self.name, None)


class GenDb(FakeDb):
    """FakeDb vending GenColl + recording collection-name access order."""

    def __init__(self, colls=None):
        self.accessed: list[str] = []
        super().__init__()
        for name, docs in (colls or {}).items():
            self._colls[name] = GenColl(docs, name=name, db=self)
            self._colls[name].database = self

    def __getitem__(self, name):
        self.accessed.append(name)
        if name not in self._colls:
            self._colls[name] = GenColl(name=name, db=self)
            self._colls[name].database = self
        return self._colls[name]

    def drop_collection(self, name):
        self._colls.pop(name, None)


def _write_export(path: Path, docs: list[dict]) -> Path:
    """pretty-printed array matching _iter_export_docs' `  {`/`  }` framing."""
    with open(path, "w", encoding="utf-8") as f:
        f.write("[\n")
        for i, d in enumerate(docs):
            body = json.dumps(d, ensure_ascii=False, indent=2)
            indented = "\n".join("  " + ln for ln in body.splitlines())
            f.write(indented + (",\n" if i < len(docs) - 1 else "\n"))
        f.write("]\n")
    return path


def _export_doc(item_id: int, image_ids: list[str], *, stock: int = 5,
                name: str = "หัวชาร์จ Anker 737", shop: str = "shopA") -> dict:
    """minimal listing doc covering all 3 image discovery sources."""
    urls = [f"https://cf.shopee.co.th/file/{i}" for i in image_ids]
    return {
        "item_id": item_id, "item_name": name, "item_status": "NORMAL",
        "shopname": shop, "brand": {"original_brand_name": "Anker"},
        "description": "spec text",
        "description_info": {"extended_description": {"field_list": [
            {"field_type": "image",
             "image_info": {"image_id": image_ids[0],
                            "image_url": urls[0]}}] if image_ids else []}},
        "image": {"image_id_list": image_ids[1:], "image_url_list": urls[1:]},
        "model": [{"model_id": item_id * 10, "model_name": "GaNPrime 120W",
                   "model_sku": "A2148", "model_status": "MODEL_NORMAL",
                   "stock_info_v2": {"summary_info": {"total_available_stock": stock}},
                   "price_info": [{"current_price": 1990.0}]}],
    }


GID = "g20261019-090000-a1b2c3d4"


def _snap_doc(gid=GID, exports_root: str = "exports", **over) -> dict:
    """valid pointer payload for gid (repo-relative paths)."""
    doc = {
        "_id": "active", "generation_id": gid,
        "units_collection": f"sellable_units_{gid}",
        "image_texts_collection": f"image_texts_{gid}",
        "units_npz": f"{exports_root}/gen/{gid}/unit_embeddings.npz",
        "product_npz": f"{exports_root}/gen/{gid}/product_embeddings.npz",
        "units_jsonl": f"{exports_root}/gen/{gid}/sellable_units.jsonl",
        "manifest_path": f"{exports_root}/gen/{gid}/manifest.json",
        "manifest_sha256": "ab12",
        "unit_count": 1, "npz_rows": 1, "activated_at": "2026-10-19T09:00:00Z",
    }
    doc.update(over)
    return doc


# ══════════════════════════ generation_pointer ══════════════════════════════

class TestGenerationPointer:
    def test_mint_gen_id_format_and_same_second_unique(self):
        gp = _pkg("generation_pointer")
        import re, datetime
        g1 = gp.mint_generation_id(now=datetime.datetime(2026, 10, 19, 9, 0, 0))
        g2 = gp.mint_generation_id(now=datetime.datetime(2026, 10, 19, 9, 0, 0))
        assert re.fullmatch(r"g\d{8}-\d{6}-[0-9a-f]{8}", g1)
        assert g1 != g2  # same-second calls must not collide

    def test_snapshot_from_pointer_valid(self):
        gp = _pkg("generation_pointer")
        snap = gp.snapshot_from_pointer(_snap_doc())
        assert snap is not None
        assert snap.generation_id == GID
        assert snap.units_collection == f"sellable_units_{GID}"
        assert snap.image_texts_collection == f"image_texts_{GID}"
        assert snap.units_npz.endswith(f"gen/{GID}/unit_embeddings.npz")

    def test_snapshot_rejects_foreign_collection_and_paths(self):
        gp = _pkg("generation_pointer")
        assert gp.snapshot_from_pointer(
            _snap_doc(units_collection="sellable_units")) is None
        assert gp.snapshot_from_pointer(
            _snap_doc(image_texts_collection="image_texts")) is None
        assert gp.snapshot_from_pointer(
            _snap_doc(units_npz="exports/gen/other/x.npz")) is None
        assert gp.snapshot_from_pointer(
            _snap_doc(generation_id="not-a-gid")) is None
        assert gp.snapshot_from_pointer(None) is None
        assert gp.snapshot_from_pointer({}) is None

    def test_resolve_snapshot_shared_object_and_fail_closed(self):
        gp = _pkg("generation_pointer")
        gp.reset_cache()
        db = GenDb({"sellable_units_meta": [_snap_doc()]})
        s1 = gp.resolve_snapshot(db)
        s2 = gp.resolve_snapshot(db)
        assert s1 is s2  # TTL shares the immutable object — mid-request isolation
        gp.reset_cache()
        bad = GenDb({"sellable_units_meta": [_snap_doc(generation_id="bad")]})
        assert gp.resolve_snapshot(bad) is None          # invalid → fail closed
        gp.reset_cache()
        assert gp.resolve_snapshot(GenDb({})) is None    # absent → distinct state

    def test_import_order_no_circular_import(self):
        """generation_pointer must import cleanly regardless of who imports first."""
        for first in ("shopeechat.generation_pointer",
                      "shopeechat.units",
                      "shopeechat.product_store"):
            r = subprocess.run(
                [sys.executable, "-c",
                 f"import sys; sys.path.insert(0,{str(ROOT / 'chatbot')!r});"
                 f"import {first}"],
                capture_output=True, text=True, cwd=str(ROOT))
            assert r.returncode == 0, f"{first}: {r.stderr[-300:]}"

    def test_snapshot_rejects_noncanonical_pointer_paths(self):
        """H1 — substring `gen/<gid>/` ยอมรับ foreign/wrong-name/absolute paths;
        contract: เฉพาะ exact `exports/gen/<gid>/<canonical filename>` relative"""
        gp = _pkg("generation_pointer")
        bad = [
            f"/tmp/foreign/gen/{GID}/unit_embeddings.npz",
            f"/Users/example/exports/gen/{GID}/unit_embeddings.npz",
            f"other/exports/gen/{GID}/unit_embeddings.npz",
            f"exports/gen/{GID}/../other/unit_embeddings.npz",
            f"exports/gen/{GID}/evil.npz",
            f"exports//gen/{GID}/unit_embeddings.npz",
            f"exports/gen/{GID}/unit_embeddings.npz.bak",
            f"exports/gen/{GID}/manifest.json/../../x",
            "exports/gen/g20261019-090000-ffffffff/unit_embeddings.npz",
            str(ROOT / "exports/gen" / GID / "unit_embeddings.npz"),
            f"{ROOT}/exports/gen/{GID}/unit_embeddings.npz",
            f"./exports/gen/{GID}/unit_embeddings.npz",
        ]
        for p in bad:
            assert gp.snapshot_from_pointer(
                _snap_doc(units_npz=p)) is None, f"accepted: {p}"

    def test_snapshot_accepts_exact_canonical_relative_paths(self, tmp_path,
                                                             monkeypatch):
        """4 canonical relative paths → validated → ROOT-absolute in snapshot."""
        gp = _pkg("generation_pointer")
        monkeypatch.setattr(gp, "ROOT", tmp_path)
        snap = gp.snapshot_from_pointer(_snap_doc())
        assert snap is not None
        base = tmp_path / "exports" / "gen" / GID
        assert snap.units_npz == str(base / "unit_embeddings.npz")
        assert snap.product_npz == str(base / "product_embeddings.npz")
        assert snap.units_jsonl == str(base / "sellable_units.jsonl")
        assert snap.manifest_path == str(base / "manifest.json")


# ══════════════════════════ OCR classify + run ══════════════════════════════

class TestOcrFingerprint:
    def _bit(self):
        _install_script_stubs()
        return _script("build_image_texts")

    def test_classify_six_states(self):
        bit = self._bit()
        discovered = {f"img{n}": f"https://cf.shopee.co.th/file/{n}?v=2"
                      for n in range(6)}
        cache = {
            "img1": {"fingerprint": bit._fingerprint("img1", discovered["img1"]),
                     "status": "ok", "text": "spec"},
            "img2": {"fingerprint": bit._fingerprint("img2", "https://old-url"),
                     "status": "ok", "text": "old"},
            "img3": {"fingerprint": bit._fingerprint("img3", discovered["img3"]),
                     "status": "error", "error_class": "quota",
                     "attempts_total": 1},
            "img4": {"fingerprint": bit._fingerprint("img4", discovered["img4"]),
                     "status": "deferred"},
            "img5": {"fingerprint": bit._fingerprint("img5", discovered["img5"]),
                     "status": "error", "error_class": "permanent",
                     "attempts_total": 3},
            "gone": {"fingerprint": "gone|x", "status": "ok",
                     "item_ids": [1]},
        }
        cls = bit._classify_images(discovered, cache)
        assert cls["img0"] == "new"           # discovered but not in cache
        assert cls["img1"] == "unchanged"
        assert cls["img2"] == "changed"
        assert cls["img3"] == "retryable_error"
        assert cls["img4"] == "deferred"
        assert cls["img5"] == "unchanged"     # terminal error = skip, never re-burn
        assert cls["gone"] == "removed"

    def test_classify_new_and_retry_bound(self):
        bit = self._bit()
        discovered = {"a": "https://u/a", "b": "https://u/b"}
        cls = bit._classify_images(discovered, {})
        assert cls == {"a": "new", "b": "new"}
        cache = {"a": {"fingerprint": bit._fingerprint("a", "https://u/a"),
                       "status": "error", "error_class": "transient",
                       "attempts_total": 3}}
        cls = bit._classify_images(discovered, cache)
        assert cls["a"] == "unchanged"        # attempts exhausted → skip bound

    def test_fingerprint_url_normalized(self):
        bit = self._bit()
        f1 = bit._fingerprint("i1", "https://cf.shopee.co.th/file/abc?x=1#y")
        f2 = bit._fingerprint("i1", "https://cf.shopee.co.th/file/abc")
        assert f1 == f2


class TestOcrRunBudget:
    def _run(self, tmp_path, monkeypatch, *, work_items, cache_docs,
             extract_results, max_calls=100, deadline_offset=3600):
        bit = _script("build_image_texts")
        calls = {"n": 0}

        def fake_extract(item):
            calls["n"] += 1
            st = extract_results[item["image_id"]]
            return {"image_id": item["image_id"], "image_url": item["image_url"],
                    "used_by": 1, "is_template": False, "model": "m",
                    "status": st.get("status", "ok"), "kind": st.get("kind", "spec"),
                    "text": st.get("text", "OCR text"), "truncated": False,
                    "attempts": st.get("attempts", 1),
                    "error": st.get("error"), "ts": 1}

        monkeypatch.setattr(bit, "_extract_one", fake_extract)
        monkeypatch.setattr(bit, "MIN_INTERVAL", 0.0)
        docs = (list(cache_docs.values())
                if isinstance(cache_docs, dict) else cache_docs)
        db = GenDb({"image_texts": docs})
        gen_dir = tmp_path / "gen" / GID
        gen_dir.mkdir(parents=True, exist_ok=True)
        summary = bit.run_generation_ocr(
            work_items, db=db, gen_dir=gen_dir, gid=GID,
            max_calls=max_calls, deadline_ts=None if deadline_offset is None
            else __import__("time").time() + deadline_offset)
        return bit, calls, db, gen_dir, summary

    def test_unchanged_zero_calls_reused_evidence(self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "img1"
        cache = {iid: {"image_id": iid,
                       "fingerprint": bit._fingerprint(iid, "https://u/1"),
                       "status": "ok", "kind": "spec", "text": "reused",
                       "item_ids": [7]}}
        work = [{"image_id": iid, "image_url": "https://u/1", "used_by": 1,
                 "is_template": False, "item_ids": [7]}]
        _, calls, db, gen_dir, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs=cache,
            extract_results={})
        assert calls["n"] == 0
        ev = [json.loads(l) for l in (gen_dir / "image_texts.jsonl").open()]
        assert ev[0]["text"] == "reused" and ev[0]["image_id"] == iid

    def test_new_and_changed_one_call_each(self, tmp_path, monkeypatch):
        work = [{"image_id": "new1", "image_url": "https://u/n", "used_by": 1,
                 "is_template": False, "item_ids": [1]},
                {"image_id": "chg1", "image_url": "https://u/new", "used_by": 1,
                 "is_template": False, "item_ids": [2]}]
        cache = {"chg1": {"image_id": "chg1", "fingerprint": "chg1|old",
                          "status": "ok", "text": "stale", "item_ids": [2]}}
        _, calls, db, gen_dir, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs=cache,
            extract_results={"new1": {}, "chg1": {}})
        assert calls["n"] == 2
        ev_ids = {json.loads(l)["image_id"]
                  for l in (gen_dir / "image_texts.jsonl").open()}
        assert ev_ids == {"new1", "chg1"}

    def test_attempts_count_against_max_calls(self, tmp_path, monkeypatch):
        work = [{"image_id": f"w{i}", "image_url": f"https://u/{i}",
                 "used_by": 1, "is_template": False, "item_ids": [i]}
                for i in range(3)]
        results = {"w0": {"attempts": 3}, "w1": {}, "w2": {}}
        _, calls, db, _, summary = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs={},
            extract_results=results, max_calls=4)
        # w0 burns 3 calls → only 1 left → w1 processed, w2 deferred
        assert calls["n"] == 2
        assert db["image_texts"].find_one({"image_id": "w2"})["status"] == "deferred"
        assert summary["deferred"] >= 1

    def test_quota_deferred_run_level_stop(self, tmp_path, monkeypatch):
        work = [{"image_id": f"w{i}", "image_url": f"https://u/{i}",
                 "used_by": 1, "is_template": False, "item_ids": [i]}
                for i in range(3)]
        results = {"w0": {"status": "deferred", "error": "quota"},
                   "w1": {}, "w2": {}}
        _, calls, db, _, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs={},
            extract_results=results)
        assert calls["n"] == 1                    # stop immediately on quota
        assert db["image_texts"].find_one({"image_id": "w1"})["status"] == "deferred"
        assert db["image_texts"].find_one({"image_id": "w2"})["status"] == "deferred"

    def test_runtime_exhaustion_deferred(self, tmp_path, monkeypatch):
        work = [{"image_id": "w0", "image_url": "https://u/0", "used_by": 1,
                 "is_template": False, "item_ids": [0]}]
        _, calls, db, _, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs={},
            extract_results={"w0": {}}, deadline_offset=-1)  # already past
        assert calls["n"] == 0
        assert db["image_texts"].find_one({"image_id": "w0"})["status"] == "deferred"

    def test_removed_detached_and_cache_state_fields(self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        monkeypatch.setattr(bit, "_extract_one",
                            lambda item: pytest.fail("no work expected"))
        monkeypatch.setattr(bit, "MIN_INTERVAL", 0.0)
        db = GenDb({"image_texts": [
            {"image_id": "gone", "fingerprint": "gone|x", "status": "ok",
             "item_ids": [9]}]})
        gen_dir = tmp_path / "gen" / GID
        gen_dir.mkdir(parents=True)
        bit.run_generation_ocr(
            [], db=db, gen_dir=gen_dir, gid=GID, max_calls=10,
            deadline_ts=None)
        doc = db["image_texts"].find_one({"image_id": "gone"})
        assert doc["item_ids"] == []                 # detached from generation
        assert doc["last_generation_id"] == GID
        assert not (gen_dir / "image_texts.jsonl").exists() or \
            "gone" not in (gen_dir / "image_texts.jsonl").read_text()


class TestOcrAcceptedPending:
    """M1 — accepted ok fields authoritative; ความล้มเหลว/deferred บน fingerprint
    ใหม่เขียนลง pending_* แยกต่างหาก (ห้ามทับ status/fingerprint/text/kind/
    truncated); สำเร็จ → promote pending → accepted + clear pending; publish
    เฉพาะ accepted fingerprint == discovered fingerprint เท่านั้น"""

    def _accepted_doc(self, bit, iid, url):
        return {"image_id": iid,
                "fingerprint": bit._fingerprint(iid, url),
                "status": "ok", "kind": "spec", "text": "ACCEPTED-A",
                "truncated": False, "item_ids": [7]}

    def _work(self, iid, url):
        return [{"image_id": iid, "image_url": url, "used_by": 1,
                 "is_template": False, "item_ids": [7]}]

    def test_failed_changed_preserves_accepted(self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        cache = {iid: self._accepted_doc(bit, iid, "https://u/A")}
        runner = TestOcrRunBudget()
        _, calls, db, gen_dir, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/B"),  # fingerprint เปลี่ยน
            cache_docs=cache,
            extract_results={iid: {"status": "error",
                                   "error": "rate limit", "attempts": 1}})
        assert calls["n"] == 1
        doc = db["image_texts"].find_one({"image_id": iid})
        # accepted fields ต้องเป็น A เดิม — ไม่ถูกทับด้วยสถานะล้มเหลวของ B
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/A")
        assert doc["text"] == "ACCEPTED-A"
        assert doc["kind"] == "spec"
        assert doc["truncated"] is False
        # pending state บันทึก B + failure แยกต่างหากบน doc เดียวกัน
        assert doc["pending_fingerprint"] == bit._fingerprint(iid, "https://u/B")
        assert doc["pending_status"] == "error"
        assert doc["pending_last_generation_id"] == GID
        assert (doc.get("pending_attempts_total") or 0) >= 1
        # B ไม่ถูก publish
        ev = (gen_dir / "image_texts.jsonl")
        published = ([json.loads(l)["image_id"] for l in ev.open()]
                     if ev.exists() else [])
        assert iid not in published

    def test_deferred_changed_preserves_accepted(self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        cache = {iid: self._accepted_doc(bit, iid, "https://u/A")}
        runner = TestOcrRunBudget()
        _, calls, db, gen_dir, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/B"),
            cache_docs=cache,
            extract_results={},          # ไม่ถึง extract — budget/deadline defer
            deadline_offset=-1)
        assert calls["n"] == 0
        doc = db["image_texts"].find_one({"image_id": iid})
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/A")
        assert doc["text"] == "ACCEPTED-A"
        assert doc["pending_status"] == "deferred"
        assert doc["pending_fingerprint"] == bit._fingerprint(iid, "https://u/B")
        # A ต้องไม่ถูก publish ในนามของ B (accepted fp ≠ discovered fp)
        ev = (gen_dir / "image_texts.jsonl")
        published = ([json.loads(l)["image_id"] for l in ev.open()]
                     if ev.exists() else [])
        assert iid not in published

    def test_successful_retry_promotes_pending(self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        cache = {iid: self._accepted_doc(bit, iid, "https://u/A")}
        runner = TestOcrRunBudget()
        # run 1: B fails → pending
        _, _, db, _, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/B"),
            cache_docs=cache,
            extract_results={iid: {"status": "error",
                                   "error": "rate limit",
                                   "attempts": 1}})
        # run 2: B succeeds → promote
        _, calls, db, gen_dir, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/B"),
            cache_docs={iid: db["image_texts"].find_one({"image_id": iid})},
            extract_results={iid: {"status": "ok", "text": "FRESH-B",
                                   "attempts": 1}})
        assert calls["n"] == 1
        doc = db["image_texts"].find_one({"image_id": iid})
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/B")
        assert doc["text"] == "FRESH-B"
        for f in ("pending_fingerprint", "pending_status", "pending_error",
                  "pending_error_class", "pending_attempts_total",
                  "pending_last_generation_id"):
            assert doc.get(f) is None, f"{f} not cleared"
        ev_ids = {json.loads(l)["image_id"]
                  for l in (gen_dir / "image_texts.jsonl").open()}
        assert iid in ev_ids

    def test_pending_attempts_bounded_across_runs(self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        cache = {iid: self._accepted_doc(bit, iid, "https://u/A")}
        runner = TestOcrRunBudget()
        doc = cache[iid]
        # fail B จนถึง MAX_ATTEMPTS — แต่ละ run ต้องไม่ทับ accepted
        for _ in range(bit.MAX_ATTEMPTS + 2):
            _, calls, db, gen_dir, _ = runner._run(
                tmp_path, monkeypatch,
                work_items=self._work(iid, "https://u/B"),
                cache_docs={iid: doc},
                extract_results={iid: {"status": "error",
                                       "error": "rate limit", "attempts": 1}})
            doc = db["image_texts"].find_one({"image_id": iid})
            assert doc["status"] == "ok"      # accepted ไม่เคยถูกทับ
            assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/A")
        assert (doc.get("pending_attempts_total") or 0) <= bit.MAX_ATTEMPTS
        # budget หมดแล้ว → run ถัดไปต้องไม่เรียก provider อีก
        _, calls2, db2, _, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/B"),
            cache_docs={iid: doc},
            extract_results={iid: {"status": "ok", "text": "FRESH-B"}})
        assert calls2["n"] == 0

    def test_new_image_error_unchanged_contract(self, tmp_path, monkeypatch):
        """new image ไม่มี accepted evidence → error/deferred ปกติบน accepted
        fields (ไม่มี pending)"""
        iid = "new1"
        runner = TestOcrRunBudget()
        _, calls, db, _, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/N"),
            cache_docs={},
            extract_results={iid: {"status": "error", "error": "boom",
                                   "attempts": 1}})
        assert calls["n"] == 1
        doc = db["image_texts"].find_one({"image_id": iid})
        assert doc["status"] == "error"
        assert doc.get("pending_status") is None

    def test_removed_semantics_unchanged(self, tmp_path, monkeypatch):
        """removed (ไม่อยู่ใน discovered) — cache detach item_ids เหมือนเดิม"""
        bit = _script("build_image_texts")
        monkeypatch.setattr(bit, "_extract_one",
                            lambda item: pytest.fail("no work expected"))
        monkeypatch.setattr(bit, "MIN_INTERVAL", 0.0)
        db = GenDb({"image_texts": [
            {"image_id": "gone", "fingerprint": "gone|x", "status": "ok",
             "text": "OLD", "item_ids": [9]}]})
        gen_dir = tmp_path / "gen" / GID
        gen_dir.mkdir(parents=True)
        bit.run_generation_ocr([], db=db, gen_dir=gen_dir, gid=GID,
                               max_calls=10, deadline_ts=None)
        doc = db["image_texts"].find_one({"image_id": "gone"})
        assert doc["item_ids"] == []
        assert doc["status"] == "ok"           # accepted state ไม่ถูกแตะ


# ══════════════════════════ materialize published OCR ═══════════════════════

class TestMaterialize:
    def test_materialize_creates_generation_collection(self, tmp_path):
        imp = _script("import_image_texts")
        gen_dir = tmp_path / "gen" / GID
        gen_dir.mkdir(parents=True)
        ev = [{"image_id": "i1", "image_url": "u", "kind": "spec",
               "text": "t1", "truncated": False, "item_ids": [1]},
              {"image_id": "i2", "image_url": "u2", "kind": "banner",
               "text": "t2", "truncated": False, "item_ids": [1]}]
        with open(gen_dir / "image_texts.jsonl", "w") as f:
            for e in ev:
                f.write(json.dumps(e) + "\n")
        db = GenDb({"image_texts": [{"image_id": "i1", "status": "ok",
                                     "text": "cache-only"}]})
        n = imp.materialize_published(db, GID, gen_dir)
        coll = db[f"image_texts_{GID}"]
        assert n == 2 and coll.count_documents({}) == 2
        # shared cache doc untouched; published is a snapshot of evidence file
        assert db["image_texts"].count_documents({}) == 1
        assert any(ix == "image_id" or
                   (isinstance(ix, list) and ("image_id", 1) in ix)
                   for ix in coll.indexes)


# ══════════════════════════ units build OCR-aware ═══════════════════════════

class TestUnitsBuildOcr:
    def _build(self, tmp_path, docs, ocr_records):
        bsu = _script("build_sellable_units")
        export = _write_export(tmp_path / "export.json", docs)
        ocr = tmp_path / "image_texts.jsonl"
        with open(ocr, "w") as f:
            for e in ocr_records:
                f.write(json.dumps(e) + "\n")
        out = tmp_path / "units.jsonl"
        n = bsu.build_units_file(export_path=export, image_texts_path=ocr,
                                 out_path=out)
        return [json.loads(l) for l in out.open()], n

    def test_ocr_kinds_caps_banner_excluded(self, tmp_path):
        docs = [_export_doc(1, ["i1", "i2", "i3"])]
        ocr = [{"image_id": "i1", "kind": "spec", "text": "S" * 500,
                "item_ids": [1]},
               {"image_id": "i2", "kind": "product", "text": "GaN 120W",
                "item_ids": [1]},
               {"image_id": "i3", "kind": "banner", "text": "รับประกัน 1 ปี",
                "item_ids": [1]}]
        units, _ = self._build(tmp_path, docs, ocr)
        st = units[0]["search_text"]
        assert "GaN 120W" in st
        assert "S" * 400 in st and "S" * 401 not in st   # spec cap 400
        assert "รับประกัน" not in st                       # banner excluded

    def test_dedupe_and_boilerplate_filter(self, tmp_path):
        docs = [_export_doc(i, [f"img{i}"]) for i in range(1, 7)]
        ocr = [{"image_id": f"img{i}", "kind": "spec", "text": "BOILERPLATE",
                "item_ids": [i]} for i in range(1, 6)] + [
               {"image_id": "img6", "kind": "spec", "text": "UNIQUE-6",
                "item_ids": [6]}]
        units, _ = self._build(tmp_path, docs, ocr)
        # boilerplate in >20% of items (5/6) → dropped everywhere
        for u in units:
            assert "BOILERPLATE" not in u["search_text"]
        assert "UNIQUE-6" in units[5]["search_text"]

    def test_missing_ocr_non_blocking(self, tmp_path):
        docs = [_export_doc(1, ["nope"])]
        units, n = self._build(tmp_path, docs, [])
        assert n == 1 and units[0]["unit_id"]


# ══════════════════════════ embeddings build ════════════════════════════════

class TestEmbeddingsBuild:
    def test_npz_carries_generation_id(self, tmp_path, monkeypatch):
        be = _script("build_embeddings")
        import numpy as np
        monkeypatch.setattr(be, "embed_texts",
                            lambda texts, batch_size=64: np.ones(
                                (len(texts), 1024), dtype=np.float32))
        units_jsonl = tmp_path / "units.jsonl"
        units_jsonl.write_text(json.dumps(
            {"unit_id": "1:10", "item_id": 1, "model_id": 10,
             "search_text": "x", "shop": "s"}) + "\n")
        out = tmp_path / "unit_embeddings.npz"
        be.build_units_npz(units_jsonl, out, generation_id=GID)
        z = np.load(out, allow_pickle=True)
        assert str(z["generation_id"].item() if hasattr(
            z["generation_id"], "item") else z["generation_id"]) == GID


# ══════════════════════════ publish_generation ══════════════════════════════

def _stage_gen(tmp_path, db, gid=GID, *, unit_count=1, ocr_count=1,
               npz_rows=1):
    """create gen dir artifacts + gen collections for publish tests."""
    import numpy as np
    gen_dir = tmp_path / "gen" / gid
    gen_dir.mkdir(parents=True)
    (gen_dir / "ShpProducts.export.json").write_text("[]")
    for i in range(unit_count):
        pass
    (gen_dir / "sellable_units.jsonl").write_text(
        "".join(json.dumps({"unit_id": f"{i}:1", "item_id": i,
                            "search_text": "x"}) + "\n"
                for i in range(unit_count)))
    (gen_dir / "image_texts.jsonl").write_text(
        "".join(json.dumps({"image_id": f"i{i}", "kind": "spec",
                            "text": "t", "item_ids": [i]}) + "\n"
                for i in range(ocr_count)))
    for name in ("unit_embeddings.npz", "product_embeddings.npz"):
        np.savez_compressed(
            gen_dir / name,
            generation_id=np.array(gid),
            embeddings=np.ones((npz_rows, 4), dtype=np.float32),
            item_ids=np.array([str(i) for i in range(npz_rows)], dtype="<U8"),
            texts=np.array(["x"] * npz_rows, dtype=object),
            shops=np.array(["s"] * npz_rows, dtype="<U8"))
    db[f"sellable_units_{gid}"].insert_many(
        [{"unit_id": f"{i}:1"} for i in range(unit_count)])
    db[f"image_texts_{gid}"].insert_many(
        [{"image_id": f"i{i}"} for i in range(ocr_count)])
    return gen_dir


class TestPublishGeneration:
    def _pub(self):
        return _script("publish_generation")

    def test_validate_counts_and_gen_pairing(self, tmp_path):
        pub = self._pub()
        db = GenDb({})
        gen_dir = _stage_gen(tmp_path, db)
        stats = pub.validate_generation(gen_dir, db, GID)
        assert stats["unit_count"] == 1
        db[f"sellable_units_{GID}"].insert_one({"unit_id": "extra"})
        with pytest.raises(Exception):
            pub.validate_generation(gen_dir, db, GID)

    def test_validate_rejects_npz_gen_mismatch(self, tmp_path):
        pub = self._pub()
        db = GenDb({})
        gen_dir = _stage_gen(tmp_path, db)
        import numpy as np
        np.savez_compressed(gen_dir / "unit_embeddings.npz",
                            generation_id=np.array("g00000000-000000-ffffffff"),
                            embeddings=np.ones((1, 4), dtype=np.float32),
                            item_ids=np.array(["0"], dtype="<U8"),
                            texts=np.array(["x"], dtype=object),
                            shops=np.array(["s"], dtype="<U8"))
        with pytest.raises(Exception):
            pub.validate_generation(gen_dir, db, GID)

    def test_manifest_finalized_before_cas_and_zero_writes_after(self, tmp_path):
        pub = self._pub()
        order: list[str] = []

        class OrderColl(GenColl):
            def update_one(self, filt, update, upsert=False, *a, **k):
                # manifest must be finalized (on disk, status validated) BEFORE
                # the pointer CAS write reaches Mongo
                order.append("cas")
                assert (gen_dir / "manifest.json").exists()
                m = json.loads((gen_dir / "manifest.json").read_text())
                assert m["status"] == "validated"
                return super().update_one(filt, update, upsert, *a, **k)

        db = GenDb({})
        db._colls["sellable_units_meta"] = OrderColl(
            name="sellable_units_meta", db=db)
        gen_dir = _stage_gen(tmp_path, db)
        res = pub.publish(db=db, gen_dir=gen_dir, gid=GID)
        assert res in ("published", "bootstrap")
        assert order == ["cas"]                       # exactly one pointer write
        ptr = db["sellable_units_meta"].find_one({"_id": "active"})
        assert ptr["generation_id"] == GID
        assert ptr["manifest_sha256"]
        # zero correctness-critical writes after CAS → manifest already final
        assert db["sellable_units_meta"].count_documents({}) == 1

    def test_cas_loss_no_retry_and_prev_active_survives(self, tmp_path):
        pub = self._pub()
        db = GenDb({"sellable_units_meta": [_snap_doc(gid="gOLD-keep-00000000")]})
        gen_dir = _stage_gen(tmp_path, db)
        meta = db["sellable_units_meta"]
        writes = {"n": 0}
        orig = meta.update_one
        meta.update_one = lambda *a, **k: (writes.__setitem__("n", writes["n"] + 1),
                                           orig(*a, **k))[1]
        res = pub.publish(db=db, gen_dir=gen_dir, gid=GID,
                          expected_current="gWRONG-expected-00000000")
        assert res.startswith("conflict")
        assert writes["n"] == 1                       # no blind retry
        assert meta.find_one({"_id": "active"})["generation_id"] == \
            "gOLD-keep-00000000"                       # winner untouched

    def test_publish_rejects_malformed_gid_zero_writes(self, tmp_path,
                                                       monkeypatch):
        """H2 — gid ไม่ตรง canonical regex → reject ก่อน manifest/CAS/cleanup"""
        pub = self._pub()
        db = GenDb({})
        bad = "gBAD-not-canonical"
        gen_dir = _stage_gen(tmp_path, db, gid=bad)
        calls = {"cas": 0, "cleanup": 0}
        monkeypatch.setattr(
            pub, "cleanup_generations",
            lambda *a, **k: calls.__setitem__("cleanup", calls["cleanup"] + 1))
        meta = db["sellable_units_meta"]
        orig = meta.update_one
        meta.update_one = lambda *a, **k: (
            calls.__setitem__("cas", calls["cas"] + 1), orig(*a, **k))[1]
        with pytest.raises(Exception):
            pub.publish(db=db, gen_dir=gen_dir, gid=bad)
        assert calls == {"cas": 0, "cleanup": 0}
        assert not (gen_dir / "manifest.json").exists()
        assert db["sellable_units_meta"].count_documents({}) == 0

    def test_publish_rejects_gen_dir_identity_mismatch(self, tmp_path,
                                                       monkeypatch):
        """H2 — artifacts validated ใน gen_dir หนึ่ง แต่ pointer paths ผูกกับ
        exports_root อื่น → ต้อง reject; zero CAS/manifest/cleanup"""
        pub = self._pub()
        db = GenDb({})
        gen_dir = _stage_gen(tmp_path, db)          # <tmp>/gen/<GID>
        other_root = tmp_path / "other_root"
        other_root.mkdir()
        calls = {"cas": 0, "cleanup": 0}
        monkeypatch.setattr(
            pub, "cleanup_generations",
            lambda *a, **k: calls.__setitem__("cleanup", calls["cleanup"] + 1))
        meta = db["sellable_units_meta"]
        orig = meta.update_one
        meta.update_one = lambda *a, **k: (
            calls.__setitem__("cas", calls["cas"] + 1), orig(*a, **k))[1]
        with pytest.raises(Exception):
            pub.publish(db=db, gen_dir=gen_dir, gid=GID,
                        exports_root=other_root)   # gen_dir != other_root/gen/gid
        assert calls == {"cas": 0, "cleanup": 0}
        assert not (gen_dir / "manifest.json").exists()
        assert db["sellable_units_meta"].count_documents({}) == 0

    def test_publish_rejects_gen_dir_outside_gen_parent(self, tmp_path,
                                                      monkeypatch):
        """H2 — gen_dir ที่ไม่ได้อยู่ใต้ <root>/gen/<gid> เลย → reject"""
        pub = self._pub()
        db = GenDb({})
        gen_dir = _stage_gen(tmp_path, db)
        misplaced = tmp_path / "staged" / GID      # not under <root>/gen
        misplaced.parent.mkdir(parents=True)
        import shutil as _sh
        _sh.copytree(gen_dir, misplaced)
        calls = {"cas": 0, "cleanup": 0}
        monkeypatch.setattr(
            pub, "cleanup_generations",
            lambda *a, **k: calls.__setitem__("cleanup", calls["cleanup"] + 1))
        meta = db["sellable_units_meta"]
        orig = meta.update_one
        meta.update_one = lambda *a, **k: (
            calls.__setitem__("cas", calls["cas"] + 1), orig(*a, **k))[1]
        with pytest.raises(Exception):
            pub.publish(db=db, gen_dir=misplaced, gid=GID)
        assert calls == {"cas": 0, "cleanup": 0}
        assert not (misplaced / "manifest.json").exists()

    def test_pointer_stores_canonical_relative_paths(self, tmp_path):
        """H1+H2 — pointer doc เก็บ repo-relative canonical paths เท่านั้น
        (ไม่ใช่ host-absolute) + resolver round-trip ต้อง accept"""
        pub = self._pub()
        db = GenDb({})
        gen_dir = _stage_gen(tmp_path, db)
        res = pub.publish(db=db, gen_dir=gen_dir, gid=GID)
        assert res in ("published", "bootstrap")
        ptr = db["sellable_units_meta"].find_one({"_id": "active"})
        assert ptr["units_npz"] == f"exports/gen/{GID}/unit_embeddings.npz"
        assert ptr["product_npz"] == \
            f"exports/gen/{GID}/product_embeddings.npz"
        assert ptr["units_jsonl"] == f"exports/gen/{GID}/sellable_units.jsonl"
        assert ptr["manifest_path"] == f"exports/gen/{GID}/manifest.json"
        gp = _pkg("generation_pointer")
        assert gp.snapshot_from_pointer(ptr) is not None   # round-trip valid

    def test_concurrent_bootstrap_one_winner(self, tmp_path):
        pub = self._pub()
        db = GenDb({})
        g1 = _stage_gen(tmp_path, db)
        r1 = pub.publish(db=db, gen_dir=g1, gid=GID, expected_current=None)
        g2 = "g20261019-090001-b2c3d4e5"
        g2dir = _stage_gen(tmp_path, db, gid=g2)
        r2 = pub.publish(db=db, gen_dir=g2dir, gid=g2, expected_current=None)
        assert r1 == "bootstrap"
        assert r2.startswith("conflict")
        assert db["sellable_units_meta"].count_documents({}) == 1

    def test_crash_before_cas_keeps_previous(self, tmp_path):
        pub = self._pub()
        db = GenDb({"sellable_units_meta": [_snap_doc(gid="gOLD-keep-00000000")]})
        gen_dir = _stage_gen(tmp_path, db)
        db[f"sellable_units_{GID}"].insert_one({"unit_id": "corrupt-extra"})
        res = None
        try:
            res = pub.publish(db=db, gen_dir=gen_dir, gid=GID)
        except Exception:
            pass
        assert res is None
        assert db["sellable_units_meta"].find_one(
            {"_id": "active"})["generation_id"] == "gOLD-keep-00000000"

    def test_rollback_cas_and_stale_rollback_fenced(self, tmp_path):
        pub = self._pub()
        prev = _snap_doc(gid="gOLD-keep-00000000")
        prev.pop("_id", None)
        cur = _snap_doc(gid=GID, previous=prev)
        db = GenDb({"sellable_units_meta": [cur]})
        ok = pub.rollback(db, expected_active=GID)
        assert ok == "rolled_back"
        ptr = db["sellable_units_meta"].find_one({"_id": "active"})
        assert ptr["generation_id"] == "gOLD-keep-00000000"
        # stale rollback cannot overwrite the newly rolled-back gen
        stale = pub.rollback(db, expected_active=GID)
        assert stale.startswith("conflict")
        assert db["sellable_units_meta"].find_one(
            {"_id": "active"})["generation_id"] == "gOLD-keep-00000000"

    def test_cleanup_grace_and_inflight_protection(self, tmp_path):
        pub = self._pub()
        now = __import__("time").time()
        old_gid = "g20261017-090000-aaaaaaa1"    # 2 days old
        young_gid = "g20261019-080000-bbbbbbb2"  # 1h old
        prev_doc = _snap_doc(gid=young_gid)
        prev_doc.pop("_id", None)
        db = GenDb({"sellable_units_meta": [_snap_doc(gid=GID,
                                                     previous=prev_doc)]})
        for g in (old_gid, young_gid, GID):
            (tmp_path / "gen" / g).mkdir(parents=True)
            db[f"sellable_units_{g}"]
            db[f"image_texts_{g}"]
        removed = pub.cleanup_generations(db, tmp_path, now=now,
                                          grace_seconds=24 * 3600)
        assert old_gid in removed
        for g in (GID, young_gid):
            assert (tmp_path / "gen" / g).exists()           # grace/active survive
            assert f"sellable_units_{g}" in db.list_collection_names()
        assert not (tmp_path / "gen" / old_gid).exists()
        assert f"sellable_units_{old_gid}" not in db.list_collection_names()

    def test_cleanup_failure_never_invalidates_activation(self, tmp_path):
        pub = self._pub()
        db = GenDb({})
        gen_dir = _stage_gen(tmp_path, db)
        orig = pub.cleanup_generations
        pub.cleanup_generations = lambda *a, **k: (_ for _ in ()).throw(
            RuntimeError("cleanup boom"))
        try:
            res = pub.publish(db=db, gen_dir=gen_dir, gid=GID)
        finally:
            pub.cleanup_generations = orig
        assert res in ("published", "bootstrap")

    def test_manifest_contains_no_secrets(self, tmp_path):
        pub = self._pub()
        db = GenDb({})
        gen_dir = _stage_gen(tmp_path, db)
        pub.publish(db=db, gen_dir=gen_dir, gid=GID)
        m = json.loads((gen_dir / "manifest.json").read_text())
        blob = json.dumps(m).lower()
        for bad in ("api_key", "apikey", "secret", "password", "token",
                    "bearer"):
            assert bad not in blob
        assert m["generation_id"] == GID and m["status"] == "validated"


# ══════════════════════════ runtime snapshot consumers ═════════════════════

class TestRuntimeSnapshot:
    def _unit(self, gid=GID):
        return {"unit_id": "1:10", "item_id": 1, "model_id": 10,
                "display_name": "Anker 737 — GaNPrime 120W",
                "item_name": "Anker 737", "model_name": "GaNPrime 120W",
                "model_sku": "A2148", "kind": "charger", "components": [],
                "product_type": "charger", "model_codes": ["A2148"],
                "price": 1990.0, "stock": 5, "item_status": "NORMAL",
                "model_status": "MODEL_NORMAL", "shop": "shopA",
                "brand": {"original_brand_name": "Anker"},
                "cat_name": "chargers", "sellable": True, "answerable": True,
                "desc_sections": {}, "image_ids": ["i1"], "search_text": "x"}

    def _snap(self, tmp_path, gid=GID):
        gp = _pkg("generation_pointer")
        doc = _snap_doc(gid=gid)
        snap = gp.snapshot_from_pointer(doc)
        return snap

    def test_units_coll_reads_generation_collection(self, tmp_path, monkeypatch):
        units = _pkg("units")
        gp = _pkg("generation_pointer")
        snap = self._snap(tmp_path)
        db = GenDb({f"sellable_units_{GID}": [self._unit()],
                    "image_texts": [{"image_id": "i1", "kind": "spec",
                                     "text": "SHARED-CACHE-SHOULD-NOT-READ"}],
                    f"image_texts_{GID}": [{"image_id": "i1", "kind": "spec",
                                            "text": "PUBLISHED-OCR"}]})
        kb = _pkg("knowledge_base")
        monkeypatch.setattr(kb, "_admin_db", lambda: db)
        coll = units._units_coll(snap)
        assert coll is db[f"sellable_units_{GID}"]
        docs = units.attach_image_texts([dict(self._unit())], snap)
        assert docs[0].get("image_text") == "PUBLISHED-OCR"
        assert "SHARED-CACHE" not in (docs[0].get("image_text") or "")
        # mutable cache + base collection were never touched by name
        assert "image_texts" not in db.accessed

    def test_no_pointer_units_path_fail_closed(self, monkeypatch):
        units = _pkg("units")
        gp = _pkg("generation_pointer")
        gp.reset_cache()
        db = GenDb({})
        kb = _pkg("knowledge_base")
        monkeypatch.setattr(kb, "_admin_db", lambda: db)
        with pytest.raises(Exception):
            units._units_coll()          # missing pointer → fail closed
        assert units.fetch_units("anker a2148", limit=2) == []

    def test_unit_vectors_path_keyed_and_gen_assert(self, tmp_path,
                                                    monkeypatch):
        import numpy as np
        units = _pkg("units")
        gp = _pkg("generation_pointer")
        monkeypatch.setattr(gp, "ROOT", tmp_path)   # snapshot → tmp gen files
        gid2 = "g20261019-100000-ffffffff"
        gdir1 = tmp_path / "exports" / "gen" / GID
        gdir2 = tmp_path / "exports" / "gen" / gid2
        gdir1.mkdir(parents=True)
        gdir2.mkdir(parents=True)
        p1, p2 = gdir1 / "unit_embeddings.npz", gdir2 / "unit_embeddings.npz"
        for p, g, tag in ((p1, GID, "a"), (p2, gid2, "b")):
            np.savez_compressed(p, generation_id=np.array(g),
                                embeddings=np.ones((1, 4), dtype=np.float32),
                                unit_ids=np.array([tag], dtype="<U4"),
                                shops=np.array(["s"], dtype="<U4"))
        snap = gp.snapshot_from_pointer(_snap_doc())
        v1 = units._unit_vectors(snap)
        assert list(v1["unit_ids"]) == ["a"]
        bad = gp.snapshot_from_pointer(_snap_doc(gid=gid2))
        assert bad is not None
        # force npz gen_id ≠ pointer gen_id → fail closed
        np.savez_compressed(p2, generation_id=np.array("g20261019-110000-cccccccc"),
                            embeddings=np.ones((1, 4), dtype=np.float32),
                            unit_ids=np.array(["b"], dtype="<U4"),
                            shops=np.array(["s"], dtype="<U4"))
        units._VEC_CACHE.clear() if hasattr(units, "_VEC_CACHE") else None
        assert units._unit_vectors(bad) is None   # npz gen ≠ snap gen → closed

    def test_product_npz_from_same_snapshot(self, tmp_path, monkeypatch):
        import numpy as np
        ps = _pkg("product_store")
        gp = _pkg("generation_pointer")
        monkeypatch.setattr(gp, "ROOT", tmp_path)
        gdir = tmp_path / "exports" / "gen" / GID
        gdir.mkdir(parents=True)
        p = gdir / "product_embeddings.npz"
        np.savez_compressed(p, generation_id=np.array(GID),
                            embeddings=np.ones((1, 4), dtype=np.float32),
                            item_ids=np.array(["1"], dtype="<U8"),
                            texts=np.array(["x"], dtype=object),
                            shops=np.array(["s"], dtype="<U8"))
        snap = gp.snapshot_from_pointer(_snap_doc())
        vs = ps._load_vector_store(snap)
        assert vs is not None and list(vs["item_ids"]) == ["1"]
        gid2 = "g20261019-090000-dddddddd"
        mism = gp.snapshot_from_pointer(_snap_doc(
            gid=gid2,
            product_npz=f"exports/gen/{GID}/product_embeddings.npz"))
        assert mism is None  # path ของ gen อื่น → rejected by exact rule

    def test_mid_request_pointer_flip_no_mixing(self, tmp_path, monkeypatch):
        units = _pkg("units")
        gp = _pkg("generation_pointer")
        kb = _pkg("knowledge_base")
        snap_a = self._snap(tmp_path)
        gid_b = "g20261019-100000-bbbbbbbb"
        db = GenDb({f"sellable_units_{GID}": [self._unit()],
                    f"sellable_units_{gid_b}": [dict(self._unit(),
                                                    unit_id="b:1")],
                    f"image_texts_{GID}": [], f"image_texts_{gid_b}": []})
        monkeypatch.setattr(kb, "_admin_db", lambda: db)
        # snap captured at request start stays the request's generation
        got = units._units_coll(snap_a)
        assert got is db[f"sellable_units_{GID}"]
        assert units._units_coll(gp.snapshot_from_pointer(
            _snap_doc(gid=gid_b))) is db[f"sellable_units_{gid_b}"]


# ══════════════════════════ refresh_data.sh lock ════════════════════════════

class TestRefreshScriptLock:
    def test_second_refresh_exits_before_provider_writes(self, tmp_path):
        """M1 — hermetic: run a COPY of the script so its derived ROOT is
        tmp_path; repository exports/ must remain byte-identical."""
        script_src = ROOT / "chatbot/shopeechat/scripts/refresh_data.sh"
        tscript = (tmp_path / "chatbot/shopeechat/scripts"
                   / "refresh_data.sh")
        tscript.parent.mkdir(parents=True)
        tscript.write_text(script_src.read_text())
        fakebin = tmp_path / "bin"
        fakebin.mkdir()
        (fakebin / "flock").write_text("#!/bin/sh\nexit 1\n")
        (fakebin / "flock").chmod(0o755)
        invoked = tmp_path / "invoked"
        (fakebin / "python3").write_text(
            f"#!/bin/sh\necho py >> {invoked}\nexit 0\n")
        (fakebin / "python3").chmod(0o755)
        repo_exports = ROOT / "exports"
        before = {p.name: (p.stat().st_mtime, p.stat().st_size)
                  for p in repo_exports.iterdir() if p.is_file()}
        env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}",
                   REFRESH_PY=str(fakebin / "python3"))
        r = subprocess.run(["bash", str(tscript)], capture_output=True,
                           text=True, env=env, cwd=str(tmp_path), timeout=30)
        assert r.returncode == 0                    # lost lock → clean skip
        assert not invoked.exists()                 # fake python never ran
        texports = tmp_path / "exports"             # derived ROOT = tmp_path
        assert (texports / ".refresh.lock").exists()
        assert list(texports.glob("refresh_*.log"))
        after = {p.name: (p.stat().st_mtime, p.stat().st_size)
                 for p in repo_exports.iterdir() if p.is_file()}
        assert before == after                      # repo exports untouched

    def test_script_uses_native_flock_not_mkdir_protocol(self):
        src = (ROOT / "chatbot/shopeechat/scripts/refresh_data.sh").read_text()
        assert "flock" in src
        assert ".refresh.lock.d" not in src      # old mkdir protocol deleted


# ══════════════════════════ deletion gates ══════════════════════════════════

class TestDeletedPaths:
    def test_no_mutable_image_texts_runtime_reads(self):
        for f in ("units.py", "product_store.py", "conversation_products.py"):
            src = (ROOT / "chatbot/shopeechat" / f).read_text()
            assert '["image_texts"]' not in src
            assert "['image_texts']" not in src
            assert 'database["image_texts"]' not in src

    def test_no_base_sellable_units_writer(self):
        src = (ROOT / "chatbot/shopeechat/scripts/import_sellable_units.py").read_text()
        assert 'COLL = "sellable_units"' not in src
        assert '"sellable_units"' not in src

    def test_no_mtime_resolution_of_generated_sources(self):
        src = (ROOT / "chatbot/shopeechat/units.py").read_text()
        assert "st_mtime" not in src
        src = (ROOT / "chatbot/shopeechat/product_store.py").read_text()
        head = src[: src.index("def vector_search")]
        assert "_VECTOR_MTIME" not in head


# ═══════════ correction: request-wide snapshot ownership (H1) ════════════════
#
# contract: /chat resolves EvidenceSnapshot ครั้งเดียวที่ request boundary —
#   consumer ทุกตัวใน request ได้ object เดียวกัน (รวม None); pointer flip/TTL
#   expiry กลาง request เปลี่ยน request ไม่ได้; standalone entry resolve ของตัวเอง
#   เมื่อไม่ได้อยู่ใน request ที่ capture แล้วเท่านั้น

_SNAP_OMITTED = object()


def _fake_snap(gid: str, tmp_path, tag: str):
    """EvidenceSnapshot ปลอม — product_npz ชี้ npz จริงใน tmp (gen ฝังตรงกัน)
    units_npz fake (unit path ไม่ถูกใช้เมื่อ USE_UNIT_INDEX=0)"""
    import numpy as np
    gp = _pkg("generation_pointer")
    npz = tmp_path / f"product_embeddings_{tag}.npz"
    np.savez_compressed(
        npz,
        item_ids=np.array(["3001"], dtype="<U24"),
        shops=np.array(["KingGadgets"], dtype="<U64"),
        texts=np.array(["wopow powerbank"], dtype=object),
        embeddings=np.zeros((1, 1024), dtype=np.float32),
        generation_id=np.array(gid))
    return gp.EvidenceSnapshot(
        generation_id=gid,
        units_collection=f"sellable_units_{gid}",
        image_texts_collection=f"image_texts_{gid}",
        units_npz=str(tmp_path / f"unit_embeddings_{tag}.npz"),
        product_npz=str(npz),
        units_jsonl=f"exports/gen/{gid}/sellable_units.jsonl",
        manifest_path=f"exports/gen/{gid}/manifest.json",
        manifest_sha256="x", activated_at="")


_REQSNAP_DOC = {
    "item_id": 3001.0, "item_name": "WOPOW WPB100L Powerbank 10000mAh",
    "item_status": "NORMAL", "shopname": "KingGadgets",
    "cat_name": "พาวเวอร์แบงค์", "condition": "new",
    "brand": {"brand_id": 1, "original_brand_name": "WOPOW"},
    "gen_price": 990.0, "short_link": "https://s.shopee.co.th/fx3001",
    "image": {"image_url_list": ["https://img.example/fx.jpg"],
              "image_id_list": ["fximg"]},
    "description": "power bank wopow",
    "tier_variation": [{"name": "สี", "option_list": [{"option": "Black"}]}],
    "model": [{"model_id": 11.0, "model_name": "WPB100L", "model_sku": "",
               "model_status": "MODEL_NORMAL",
               "stock_info_v2": {"summary_info": {"total_available_stock": 4}},
               "tier_index": [0], "price_info": [{"current_price": 99000}]}],
    "standardise_tier_variation": [],
}

_REQSNAP_FX = {
    "id": "reqsnap", "shop": "KingGadgets",
    "conversation_id": "reqsnap-1", "platform": "shopee",
    "catalog": [_REQSNAP_DOC],
    "timeline_seed": {"active_item_id": 3001.0, "products": [{
        "item_id": 3001.0, "name": "WOPOW WPB100L Powerbank",
        "is_anchor": True, "model_name": "WPB100L",
        "card": {"item_id": 3001, "variants": [{"name": "WPB100L"}]}}]},
    "turns": [{"text": "powerbank wopow มีไหมคะ"}],
}

_REQSNAP_CERT_FX = dict(_REQSNAP_FX, conversation_id="reqsnap-2",
                        turns=[{"text": "มี มอก. ไหมคะ"}])


def _snap_harness(monkeypatch, fx, resolver):
    """replay _install + counting resolver + consumer spies.

    seen[name] = snap ที่ consumer ได้รับจริงแต่ละครั้ง (object identity —
    _SNAP_OMITTED = caller ไม่ส่ง kwarg เลย)"""
    from test_legacy_turn_incident_replay import _install, ADMIN_DB
    from shopeechat import (conversation_products, knowledge_base,  # noqa: F401
                            product_store, units)
    gp = _pkg("generation_pointer")
    real_fetch = product_store.fetch_products
    real_cert = product_store.search_cert_products
    real_lvs = product_store._load_vector_store
    real_attach = units.attach_image_texts
    real_aitc = product_store._admin_image_texts_coll
    real_mat = conversation_products.materialize_subject_cards
    real_gap = conversation_products.get_active_product
    real_kb = knowledge_base.lookup_kb
    client, _captured, _hc = _install(monkeypatch, fx)
    calls = {"n": 0}
    seen: dict[str, list] = {}

    def _res(db=None, *, force=False):
        calls["n"] += 1
        return resolver(calls["n"])

    monkeypatch.setattr(gp, "resolve_snapshot", _res)

    def _spy_fetch(db, message, *a, **k):
        seen.setdefault("fetch_products", []).append(k.get("snap", _SNAP_OMITTED))
        return real_fetch(db, message, *a, **k)

    def _spy_units_coll(snap=None):
        seen.setdefault("_units_coll", []).append(snap)
        return client[ADMIN_DB]["sellable_units"]

    def _spy_attach(docs, snap=None):
        seen.setdefault("attach_image_texts", []).append(snap)
        return real_attach(docs, snap)

    def _spy_lvs(snap=None):
        seen.setdefault("_load_vector_store", []).append(snap)
        return real_lvs(snap)

    def _spy_aitc(snap=None, db=None):
        seen.setdefault("_admin_image_texts_coll", []).append(snap)
        return real_aitc(snap, db=db)

    def _spy_cert(db, *a, **k):
        seen.setdefault("search_cert_products", []).append(
            k.get("snap", _SNAP_OMITTED))
        return real_cert(db, *a, **k)

    def _spy_mat(db, ids, **k):
        seen.setdefault("materialize_subject_cards", []).append(
            k.get("snap", _SNAP_OMITTED))
        return real_mat(db, ids, **k)

    def _spy_gap(cid, **k):
        seen.setdefault("get_active_product", []).append(
            k.get("snap", _SNAP_OMITTED))
        return real_gap(cid, **k)

    def _spy_kb(message, **k):
        seen.setdefault("lookup_kb", []).append(k.get("snap", _SNAP_OMITTED))
        return real_kb(message, **k)

    monkeypatch.setattr(product_store, "fetch_products", _spy_fetch)
    monkeypatch.setattr(units, "_units_coll", _spy_units_coll)
    monkeypatch.setattr(units, "attach_image_texts", _spy_attach)
    monkeypatch.setattr(product_store, "_load_vector_store", _spy_lvs)
    monkeypatch.setattr(product_store, "_admin_image_texts_coll", _spy_aitc)
    monkeypatch.setattr(product_store, "search_cert_products", _spy_cert)
    monkeypatch.setattr(conversation_products, "materialize_subject_cards",
                        _spy_mat)
    monkeypatch.setattr(conversation_products, "get_active_product", _spy_gap)
    monkeypatch.setattr(knowledge_base, "lookup_kb", _spy_kb)
    return calls, seen, client


def _chat_once(fx):
    from shopeechat import app
    t = fx["turns"][0]
    return app.chat(app.ChatRequest(
        message=t["text"], shop=fx.get("shop"),
        platform=fx.get("platform", "shopee"),
        history=[], conversation_id=fx.get("conversation_id"),
        limit=5, simulate_assignment=True, test_source="phase4b_reqsnap"))


def _flat_seen(seen):
    return [v for vs in seen.values() for v in vs if v is not _SNAP_OMITTED]


class TestRequestSnapshotOwnership:
    """H1 — snapshot ต้องตรึง request เดียว: resolve ครั้งเดียว, consumer ทุกตัว
    ได้ object เดียวกัน, pointer flip กลาง request ไม่ผสม gen"""

    def test_cert_path_resolves_once_and_threads_same_snap(
            self, monkeypatch, tmp_path):
        snapA = _fake_snap("g00000000-000000-aaaaaaaa", tmp_path, "a")
        snapB = _fake_snap("g00000000-000000-bbbbbbbb", tmp_path, "b")
        seq = iter([snapA] + [snapB] * 50)
        calls, seen, _ = _snap_harness(
            monkeypatch, _REQSNAP_CERT_FX, lambda n: next(seq))
        _chat_once(_REQSNAP_CERT_FX)
        assert calls["n"] == 1, (
            f"resolver called {calls['n']}× in one request — per-call "
            f"resolution can mix generations (seen={ {k: [s.generation_id if s not in (_SNAP_OMITTED, None) else s for s in v] for k, v in seen.items()} })")
        for snap in _flat_seen(seen):
            assert snap is snapA, "consumer saw a different generation object"

    def test_product_path_resolves_once_and_threads_same_snap(
            self, monkeypatch, tmp_path):
        # no timeline_seed → no subject pin → request ต้องผ่าน fetch_products จริง
        fx = {k: v for k, v in _REQSNAP_FX.items() if k != "timeline_seed"}
        fx["turns"] = [{"text": "มีสินค้าอะไรแนะนำไหมคะ"}]
        snapA = _fake_snap("g00000000-000000-aaaaaaaa", tmp_path, "a")
        snapB = _fake_snap("g00000000-000000-bbbbbbbb", tmp_path, "b")
        seq = iter([snapA] + [snapB] * 50)
        calls, seen, _ = _snap_harness(monkeypatch, fx, lambda n: next(seq))
        _chat_once(fx)
        assert calls["n"] == 1
        assert "fetch_products" in seen
        for snap in _flat_seen(seen):
            assert snap is snapA

    def test_captured_none_survives_mid_request_flip(
            self, monkeypatch, tmp_path):
        """capture ได้ None แล้ว pointer B มากลาง request — request ต้อง None
        ตลอด (fail-closed บน gen เดิม ไม่ผูก B เข้ามา)"""
        snapB = _fake_snap("g00000000-000000-bbbbbbbb", tmp_path, "b")
        seq = iter([None] + [snapB] * 50)
        calls, seen, _ = _snap_harness(
            monkeypatch, _REQSNAP_CERT_FX, lambda n: next(seq))
        _chat_once(_REQSNAP_CERT_FX)
        assert calls["n"] == 1
        for snap in _flat_seen(seen):
            assert snap is None

    def test_two_requests_may_capture_different_generations(
            self, monkeypatch, tmp_path):
        snapA = _fake_snap("g00000000-000000-aaaaaaaa", tmp_path, "a")
        snapB = _fake_snap("g00000000-000000-bbbbbbbb", tmp_path, "b")
        seq = iter([snapA, snapB] + [snapB] * 50)
        calls, seen, _ = _snap_harness(
            monkeypatch, _REQSNAP_CERT_FX, lambda n: next(seq))
        _chat_once(_REQSNAP_CERT_FX)
        req1 = [s for v in seen.values() for s in v]
        seen.clear()
        _chat_once(dict(_REQSNAP_CERT_FX, conversation_id="reqsnap-3"))
        req2 = [s for v in seen.values() for s in v]
        assert calls["n"] == 2
        assert all(s is snapA for s in req1 if s is not _SNAP_OMITTED)
        assert all(s is snapB for s in req2 if s is not _SNAP_OMITTED)

    def test_standalone_entries_still_resolve_at_own_boundary(
            self, monkeypatch, tmp_path):
        """standalone/manual caller ไม่ได้อยู่ใน captured request → resolve
        ครั้งเดียวที่ boundary ตัวเอง (ไม่ใช่กฎ 'ห้าม resolve' ตลอดกาล)"""
        snapA = _fake_snap("g00000000-000000-aaaaaaaa", tmp_path, "a")
        seq = iter([snapA] * 10)
        calls, seen, _ = _snap_harness(
            monkeypatch, _REQSNAP_FX, lambda n: next(seq))
        from shopeechat import product_store
        product_store.search_cert_products(
            _pkg("knowledge_base")._admin_db(),
            ["tisi"], shop_filter="KingGadgets", limit=5)
        assert calls["n"] == 1


# ═══════════ correction: OCR accepted/pending state (M1) ════════════════════
#
# contract: accepted fields (status/fingerprint/text/kind/truncated) authoritative
# — changed-fp + fail/deferred ห้ามทับ accepted; pending_* บันทึก attempt ใหม่;
# success → promote pending→accepted + clear pending; publish เฉพาะเมื่อ
# accepted fingerprint == discovered fingerprint; pending attempts bounded


class TestOcrAcceptedState:
    """reuse TestOcrRunBudget._run helper (unbound — ไม่ subclass เพื่อไม่ให้
    parent tests ถูก collect ซ้ำ)"""

    def _run(self, tmp_path, monkeypatch, **kw):
        return TestOcrRunBudget()._run(tmp_path, monkeypatch, **kw)

    def test_changed_url_failure_preserves_accepted(
            self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "imgA"
        fpA = bit._fingerprint(iid, "https://u/a")
        cache = {iid: {"image_id": iid, "fingerprint": fpA,
                       "status": "ok", "kind": "spec",
                       "text": "accepted-A-text", "item_ids": [7]}}
        work = [{"image_id": iid, "image_url": "https://u/b", "used_by": 1,
                 "is_template": False, "item_ids": [7]}]
        _, calls, db, gen_dir, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs=cache,
            extract_results={iid: {"status": "error", "error": "timeout",
                                   "attempts": 1}})
        assert calls["n"] == 1
        doc = db["image_texts"]._docs[0]
        # accepted fields ไม่ถูกแตะ
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == fpA
        assert doc["text"] == "accepted-A-text"
        # pending state บันทึก B + failure แยก
        assert doc["pending_fingerprint"] == bit._fingerprint(iid, "https://u/b")
        assert doc["pending_status"] == "error"
        assert doc["pending_error_class"] == "transient"
        assert doc["pending_attempts_total"] == 1
        # B ไม่เข้า published evidence
        ev_path = gen_dir / "image_texts.jsonl"
        ev = [json.loads(l) for l in ev_path.open()] if ev_path.exists() else []
        assert all(e["image_id"] != iid for e in ev)

    def test_pending_success_promotes_to_accepted(
            self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "imgA"
        fpA = bit._fingerprint(iid, "https://u/a")
        fpB = bit._fingerprint(iid, "https://u/b")
        cache = {iid: {"image_id": iid, "fingerprint": fpA,
                       "status": "ok", "kind": "spec",
                       "text": "accepted-A-text", "item_ids": [7],
                       "pending_fingerprint": fpB, "pending_status": "error",
                       "pending_error_class": "transient",
                       "pending_attempts_total": 1,
                       "pending_last_generation_id": "gprev"}}
        work = [{"image_id": iid, "image_url": "https://u/b", "used_by": 1,
                 "is_template": False, "item_ids": [7]}]
        _, calls, db, gen_dir, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs=cache,
            extract_results={iid: {"status": "ok", "text": "fresh-B-text"}})
        assert calls["n"] == 1
        doc = db["image_texts"]._docs[0]
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == fpB
        assert doc["text"] == "fresh-B-text"
        assert doc.get("pending_fingerprint") is None
        assert doc.get("pending_status") is None
        assert doc.get("pending_attempts_total") is None
        ev = [json.loads(l) for l in (gen_dir / "image_texts.jsonl").open()]
        assert any(e["image_id"] == iid and e["text"] == "fresh-B-text"
                   for e in ev)

    def test_deferred_b_preserves_accepted_a(self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "imgA"
        fpA = bit._fingerprint(iid, "https://u/a")
        cache = {iid: {"image_id": iid, "fingerprint": fpA,
                       "status": "ok", "kind": "spec",
                       "text": "accepted-A-text", "item_ids": [7]}}
        work = [{"image_id": iid, "image_url": "https://u/b", "used_by": 1,
                 "is_template": False, "item_ids": [7]}]
        _, calls, db, gen_dir, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs=cache,
            extract_results={iid: {"status": "deferred", "error": "quota"}})
        assert calls["n"] == 1
        doc = db["image_texts"]._docs[0]
        assert doc["status"] == "ok" and doc["fingerprint"] == fpA
        assert doc["pending_status"] == "deferred"
        ev_path = gen_dir / "image_texts.jsonl"
        ev = [json.loads(l) for l in ev_path.open()] if ev_path.exists() else []
        assert all(e["image_id"] != iid for e in ev)

    def test_pending_attempts_bounded(self, tmp_path, monkeypatch):
        """pending_attempts_total >= MAX_ATTEMPTS + retryable class → skip (ไม่เผา call)"""
        bit = _script("build_image_texts")
        iid = "imgA"
        fpA = bit._fingerprint(iid, "https://u/a")
        fpB = bit._fingerprint(iid, "https://u/b")
        cache = {iid: {"image_id": iid, "fingerprint": fpA,
                       "status": "ok", "kind": "spec",
                       "text": "accepted-A-text", "item_ids": [7],
                       "pending_fingerprint": fpB, "pending_status": "error",
                       "pending_error_class": "transient",
                       "pending_attempts_total": bit.MAX_ATTEMPTS}}
        work = [{"image_id": iid, "image_url": "https://u/b", "used_by": 1,
                 "is_template": False, "item_ids": [7]}]
        _, calls, db, _, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs=cache,
            extract_results={iid: {"status": "ok", "text": "x"}})
        assert calls["n"] == 0            # ไม่ retry เกินเพดาน
        doc = db["image_texts"]._docs[0]
        assert doc["fingerprint"] == fpA  # accepted คงเดิม

    def test_new_image_failure_stays_ordinary(self, tmp_path, monkeypatch):
        iid = "imgN"
        work = [{"image_id": iid, "image_url": "https://u/n", "used_by": 1,
                 "is_template": False, "item_ids": [1]}]
        _, calls, db, _, _ = self._run(
            tmp_path, monkeypatch, work_items=work, cache_docs={},
            extract_results={iid: {"status": "error", "error": "timeout"}})
        assert calls["n"] == 1
        doc = db["image_texts"]._docs[0]
        assert doc["status"] == "error"   # ไม่มี accepted → ordinary record


class TestLiveCardCacheGeneration:
    """H1(round3) — _LIVE_CARD_CACHE key ต้องรวม captured generation identity:
    card ที่ cache จาก gen A ห้ามถูก reuse โดย request ที่ capture gen B
    หรือ captured None (gen-blind cache = ผสม generation ใน request ใหม่)"""

    def _env(self, monkeypatch, tmp_path):
        from shopeechat import conversation_products as cp
        from shopeechat import knowledge_base as kb
        from shopeechat import product_store as ps
        snapA = _fake_snap("g00000000-000000-aaaaaaaa", tmp_path, "ca")
        snapB = _fake_snap("g00000000-000000-bbbbbbbb", tmp_path, "cb")

        def _unit(tag):
            return {"item_id": 100, "model_name": "M", "unit_id": f"u-{tag}",
                    "display_name": f"CARD-{tag}", "shop": "shopA",
                    "brand": {"original_brand_name": "Anker"},
                    "cat_name": "charger", "image_ids": [], "sellable": True,
                    "item_name": f"หัวชาร์จ {tag}"}

        admin = GenDb({snapA.units_collection: [_unit("A")],
                       snapB.units_collection: [_unit("B")],
                       "kb_products": []})
        monkeypatch.setattr(kb, "_admin_db", lambda: admin)
        monkeypatch.setenv("MONGO_DB", "shopdb")
        monkeypatch.setenv("MONGO_COLLECTION", "ShpProducts")
        doc = _export_doc(100, ["img1"], name="LISTING-PRODUCT")
        proddb = GenDb({"ShpProducts": [doc]})
        monkeypatch.setattr(ps, "_cached_client",
                            FakeClient({"shopdb": proddb}))
        cp._LIVE_CARD_CACHE.clear()
        return cp, snapA, snapB, proddb, doc

    def _entry(self):
        return {"item_id": 100, "model_name": "M", "is_anchor": True,
                "mentioned_at": "2026-10-21T00:00:00Z",
                "card": {"item_id": 100, "name": "STORED-NAME",
                         "variants": [{"name": "M"}]}}

    def test_materialize_card_does_not_cross_generations(
            self, monkeypatch, tmp_path):
        cp, snapA, snapB, _, _ = self._env(monkeypatch, tmp_path)
        card_a = cp._materialize_card(self._entry(), snap=snapA)
        assert card_a.get("name") == "CARD-A"
        # pointer พลิก → request ใหม่ capture gen B — ห้ามได้ card A จาก cache
        card_b = cp._materialize_card(self._entry(), snap=snapB)
        assert card_b.get("name") == "CARD-B", (
            f"generation B request received cached A card: {card_b.get('name')}")

    def test_materialize_subject_cards_does_not_cross_generations(
            self, monkeypatch, tmp_path):
        cp, snapA, snapB, proddb, _ = self._env(monkeypatch, tmp_path)
        entry = self._entry()
        out_a = cp.materialize_subject_cards(
            proddb, [100], products=[entry], snap=snapA)
        assert out_a[0].get("name") == "CARD-A"
        out_b = cp.materialize_subject_cards(
            proddb, [100], products=[entry], snap=snapB)
        assert out_b[0].get("name") == "CARD-B", (
            f"generation B request received cached A card: "
            f"{out_b[0].get('name')}")

    def test_captured_none_never_reuses_generation_card(
            self, monkeypatch, tmp_path):
        cp, snapA, _, proddb, _ = self._env(monkeypatch, tmp_path)
        cp._materialize_card(self._entry(), snap=snapA)   # populate under A
        card_n = cp._materialize_card(self._entry(), snap=None)
        assert card_n.get("name") != "CARD-A", (
            "captured-None request reused generation-A cached card")
        out_n = cp.materialize_subject_cards(
            proddb, [100], products=[self._entry()], snap=None)
        assert out_n[0].get("name") != "CARD-A"
        # fail-closed คงอยู่ — stored/live product path เดิม (ไม่พัง)
        assert out_n[0].get("name") in ("STORED-NAME", "LISTING-PRODUCT")


class TestKnownBrandsGeneration:
    """M1(round3) — generated-unit brands ใน _brand_cache ต้องเป็นของ
    generation เดียวกับ snap — B ห้ามสืบทอด brand set ที่ gen A สร้าง"""

    def _install(self, monkeypatch, tmp_path):
        from shopeechat import knowledge_base as kb
        from shopeechat import units
        snapA = _fake_snap("g00000000-000000-aaaaaaaa", tmp_path, "ka")
        snapB = _fake_snap("g00000000-000000-bbbbbbbb", tmp_path, "kb")

        class _BrandColl:
            def __init__(self, brands):
                self._brands = brands

            def distinct(self, field, *a, **k):
                return list(self._brands)

        colls = {snapA.generation_id: _BrandColl(["brand-a-gen"]),
                 snapB.generation_id: _BrandColl(["brand-b-gen"])}
        self._units_calls: list = []       # generated-unit read แต่ละครั้ง
        self._units_raise_for: set = set()  # gen ที่ให้ _units_coll raise
        admin = GenDb({"kb_products": [{"brand": "KB-ONLY-BRAND"}]})

        def _units_spy(snap=None):
            self._units_calls.append(
                snap.generation_id if snap is not None else None)
            if (snap is None or snap.generation_id
                    in self._units_raise_for):
                raise RuntimeError("units unavailable")
            return colls[snap.generation_id]

        monkeypatch.setattr(kb, "_admin_db", lambda: admin)
        monkeypatch.setattr(units, "_units_coll", _units_spy)
        kb._brand_cache = None
        return kb, snapA, snapB

    def test_brands_do_not_cross_generations(self, monkeypatch, tmp_path):
        kb, snapA, snapB = self._install(monkeypatch, tmp_path)
        a = kb._known_brands(snap=snapA)
        assert "brand-a-gen" in a
        b = kb._known_brands(snap=snapB)
        assert "brand-b-gen" in b, "gen B request got A's cached brand set"
        assert "brand-a-gen" not in b

    def test_captured_none_gets_no_generated_brands(
            self, monkeypatch, tmp_path):
        kb, snapA, snapB = self._install(monkeypatch, tmp_path)
        kb._known_brands(snap=snapA)
        kb._known_brands(snap=snapB)
        n = kb._known_brands(snap=None)
        assert "brand-a-gen" not in n and "brand-b-gen" not in n

    def test_same_generation_reuses_ttl_cache(self, monkeypatch, tmp_path):
        kb, snapA, _ = self._install(monkeypatch, tmp_path)
        a1 = kb._known_brands(snap=snapA)
        a2 = kb._known_brands(snap=snapA)
        assert a1 is a2 or a1 == a2
        assert "brand-a-gen" in a2

    def test_kb_brands_survive_captured_none(self, monkeypatch, tmp_path):
        """kb_products brands เป็น live source อิสระ — captured-None ต้องได้
        KB brand + static, ห้ามได้ generated brand และห้ามอ่าน units เลย"""
        kb, _, _ = self._install(monkeypatch, tmp_path)
        n = kb._known_brands(snap=None)
        assert "kb-only-brand" in n, (
            "kb_products brands lost when captured snapshot is None")
        assert "brand-a-gen" not in n and "brand-b-gen" not in n
        assert self._units_calls == [], (
            f"generated-units read attempted under captured None: "
            f"{self._units_calls}")

    def test_kb_brands_survive_units_failure(self, monkeypatch, tmp_path):
        """units read ล้มต้องไม่ลบ kb_products brands ที่อ่านสำเร็จแล้ว —
        และ B ห้ามสืบทอด generated brands ของ A"""
        kb, snapA, snapB = self._install(monkeypatch, tmp_path)
        kb._known_brands(snap=snapA)              # cache A's set ก่อน
        self._units_raise_for.add(snapB.generation_id)
        b = kb._known_brands(snap=snapB)
        assert "kb-only-brand" in b, (
            "kb_products brands discarded by generated-units failure")
        assert "brand-a-gen" not in b, (
            "B inherited A's generated brands after units read failure")


class TestOcrPendingFingerprintScope:
    """M2(round3) — retry budget เป็นของ (image_id, pending_fingerprint) เท่านั้น:
    B หมด budget ไม่ block C; attempts/error ของ B ห้ามไหลไป C; deferral ก่อน
    provider call ไม่นับ attempt"""

    def _accepted_doc(self, bit, iid, url):
        return {"image_id": iid,
                "fingerprint": bit._fingerprint(iid, url),
                "status": "ok", "kind": "spec", "text": "ACCEPTED-A",
                "truncated": False, "item_ids": [7]}

    def _work(self, iid, url):
        return [{"image_id": iid, "image_url": url, "used_by": 1,
                 "is_template": False, "item_ids": [7]}]

    def _cache_exhausted_b(self, bit, iid):
        doc = self._accepted_doc(bit, iid, "https://u/A")
        doc.update({
            "pending_fingerprint": bit._fingerprint(iid, "https://u/B"),
            "pending_status": "error",
            "pending_error": "rate limit",
            "pending_error_class": "rate_limit",
            "pending_attempts_total": bit.MAX_ATTEMPTS,
            "pending_last_generation_id": GID})
        return {iid: doc}

    def test_exhausted_pending_same_fingerprint_no_call(
            self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        runner = TestOcrRunBudget()
        _, calls, db, _, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/B"),  # discovered = B (same)
            cache_docs=self._cache_exhausted_b(bit, iid),
            extract_results={iid: {"status": "ok", "text": "X",
                                   "attempts": 1}})
        assert calls["n"] == 0, "exhausted pending B must not retry B"
        doc = db["image_texts"].find_one({"image_id": iid})
        assert doc["status"] == "ok" and doc["text"] == "ACCEPTED-A"
        assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/A")

    def test_exhausted_pending_does_not_block_new_fingerprint(
            self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        runner = TestOcrRunBudget()
        _, calls, db, _, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/C"),   # discovered = C (new)
            cache_docs=self._cache_exhausted_b(bit, iid),
            extract_results={iid: {"status": "error",
                                   "error": "boom-c", "attempts": 1}})
        assert calls["n"] == 1, (
            "new fingerprint C was blocked by B's exhausted retry budget")
        doc = db["image_texts"].find_one({"image_id": iid})
        # accepted A intact; pending identity เปลี่ยนเป็น C และนับใหม่จาก 1
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/A")
        assert doc["text"] == "ACCEPTED-A"
        assert doc["pending_fingerprint"] == bit._fingerprint(iid,
                                                            "https://u/C")
        assert doc["pending_attempts_total"] == 1, (
            f"C attempts must start at 1, got "
            f"{doc.get('pending_attempts_total')} (B's budget leaked)")
        assert doc["pending_error"] == "boom-c"

    def test_deferred_new_fingerprint_zero_attempts(
            self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        runner = TestOcrRunBudget()
        _, calls, db, _, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/C"),
            cache_docs=self._cache_exhausted_b(bit, iid),
            extract_results={},          # never reaches provider
            deadline_offset=-1)
        assert calls["n"] == 0
        doc = db["image_texts"].find_one({"image_id": iid})
        assert doc["pending_fingerprint"] == bit._fingerprint(iid,
                                                            "https://u/C")
        assert doc["pending_status"] == "deferred"
        # attempt ที่ไม่ได้เกิด ห้ามนับ — และ error ของ B ห้ามเหลือเป็น state ของ C
        assert (doc.get("pending_attempts_total") or 0) == 0, (
            f"deferred-without-call must keep attempts=0 for C, got "
            f"{doc.get('pending_attempts_total')}")
        assert doc.get("pending_error") is None
        assert doc.get("pending_error_class") is None

    def test_provider_deferred_class_belongs_to_current_fingerprint(
            self, tmp_path, monkeypatch):
        """provider-deferred บน fp ใหม่ (C) — error_class ต้องเป็นของ C ไม่ใช่
        ค้างของ B; error/attempts นับของ C เท่านั้น; accepted A ไม่แตะ"""
        bit = _script("build_image_texts")
        iid = "chg1"
        runner = TestOcrRunBudget()
        _, calls, db, gen_dir, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/C"),
            cache_docs=self._cache_exhausted_b(bit, iid),
            extract_results={iid: {"status": "deferred",
                                   "error": "429 quota exceeded",
                                   "attempts": 1}})
        assert calls["n"] == 1
        doc = db["image_texts"].find_one({"image_id": iid})
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/A")
        assert doc["text"] == "ACCEPTED-A"
        assert doc["pending_fingerprint"] == bit._fingerprint(iid,
                                                            "https://u/C")
        assert doc["pending_status"] == "deferred"
        assert doc["pending_error"] == "429 quota exceeded"
        assert doc["pending_error_class"] == "quota", (
            f"error_class must be C's, got {doc.get('pending_error_class')!r} "
            f"(B's class leaked into C's pending state)")
        assert doc["pending_attempts_total"] == 1
        ev = gen_dir / "image_texts.jsonl"
        published = ([json.loads(l)["image_id"] for l in ev.open()]
                     if ev.exists() else [])
        assert iid not in published

    def test_new_fingerprint_success_promotes_and_clears(
            self, tmp_path, monkeypatch):
        bit = _script("build_image_texts")
        iid = "chg1"
        runner = TestOcrRunBudget()
        _, calls, db, gen_dir, _ = runner._run(
            tmp_path, monkeypatch,
            work_items=self._work(iid, "https://u/C"),
            cache_docs=self._cache_exhausted_b(bit, iid),
            extract_results={iid: {"status": "ok", "text": "FRESH-C",
                                   "attempts": 1}})
        assert calls["n"] == 1
        doc = db["image_texts"].find_one({"image_id": iid})
        assert doc["status"] == "ok"
        assert doc["fingerprint"] == bit._fingerprint(iid, "https://u/C")
        assert doc["text"] == "FRESH-C"
        for f in ("pending_fingerprint", "pending_status", "pending_error",
                  "pending_error_class", "pending_attempts_total",
                  "pending_last_generation_id"):
            assert doc.get(f) is None, f"{f} not cleared"
        ev_ids = {json.loads(l)["image_id"]
                  for l in (gen_dir / "image_texts.jsonl").open()}
        assert iid in ev_ids
