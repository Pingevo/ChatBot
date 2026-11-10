"""Neutral Mongo test doubles — single shared implementation owner.

Moved verbatim from the two donor test modules so Phase 4 suites and
`zaapi_phase4_helpers` can reuse the fakes WITHOUT importing test modules
(those carry import-time side effects: env mutation, socket/dotenv/MongoClient
stubs, shopeechat.app import). Donor files re-export these names, so
`replay.<name>` / `test_phase4b_refresh.<name>` keep resolving identically.

Definitions: `_norm`, `_get_path`, `_match`, `_Cursor`, `FakeColl`, `FakeDb`,
`_AdminNs` (FakeClient companion), `FakeClient`, `GenColl`, `GenDb`.
Import side effects: none — stdlib only; pymongo is lazily imported inside
methods.
"""
from __future__ import annotations

import re
import types
from types import SimpleNamespace


def _norm(v):
    if isinstance(v, float) and v == int(v):
        return int(v)
    if isinstance(v, str):
        try:
            f = float(v)
            return int(f) if f == int(f) else v
        except (ValueError, TypeError):
            return v
    return v


def _get_path(doc: dict, path: str):
    """Resolve a dotted Mongo path — returns (value, present). List fields
    descend into elements (Mongo array semantics → returns list of values)."""
    cur = doc
    for p in path.split("."):
        if isinstance(cur, list):
            cur = [x.get(p) for x in cur if isinstance(x, dict) and p in x]
            if not cur:
                return None, False
            continue
        if not isinstance(cur, dict) or p not in cur:
            return None, False
        cur = cur[p]
    return cur, True


def _match(doc: dict, filt: dict) -> bool:
    for k, cond in (filt or {}).items():
        if k == "$or":
            if not any(_match(doc, sub) for sub in cond):
                return False
            continue
        val, present = _get_path(doc, k) if "." in k else (doc.get(k), k in doc)
        vals = val if isinstance(val, list) else [val]  # array → any-element
        if isinstance(cond, dict):
            if "$in" in cond:
                if not any(_norm(v) in {_norm(x) for x in cond["$in"]}
                           for v in vals):
                    return False
            if "$regex" in cond:
                opts = cond.get("$options", "")
                flags = re.IGNORECASE if "i" in opts else 0
                if not any(re.search(cond["$regex"], str(v or ""), flags)
                           for v in vals):
                    return False
            if "$ne" in cond and any(
                    _norm(v) == _norm(cond["$ne"]) for v in vals):
                return False
            if "$exists" in cond and (val is not None) != bool(cond["$exists"]):
                return False
        else:
            if not any(_norm(v) == _norm(cond) for v in vals):
                return False
    return True


class _Cursor(list):
    def max_time_ms(self, value):
        assert isinstance(value, int) and value >= 0
        return self

    def limit(self, n):
        return _Cursor(self[:n])

    def sort(self, *a, **k):
        return self

    def skip(self, n):
        return _Cursor(self[n:])


class FakeColl:
    """Minimal Mongo collection double — equality/$in/$regex filters, $set/$unset."""

    def __init__(self, docs=None):
        self._docs: list[dict] = [dict(d) for d in (docs or [])]
        self.database = None  # bound by FakeDb

    def find_one(self, filt=None, *a, **k):
        for d in self._docs:
            if _match(d, filt):
                return d
        return None

    def find(self, filt=None, *a, **k):
        return _Cursor([d for d in self._docs if _match(d, filt)])

    def count_documents(self, filt=None, *a, **k):
        return sum(1 for d in self._docs if _match(d, filt))

    def estimated_document_count(self):
        return len(self._docs)

    def aggregate(self, *a, **k):
        return iter(())

    def distinct(self, field, *a, **k):
        return list({d.get(field) for d in self._docs})

    def create_index(self, *a, **k):
        return None

    def update_one(self, filt, update, upsert=False, *a, **k):
        for d in self._docs:
            if _match(d, filt):
                self._apply(d, update)
                return SimpleNamespace(matched_count=1, upserted_id=None)
        if upsert:
            doc = {k: v for k, v in (filt or {}).items() if not k.startswith("$")}
            self._apply(doc, update)
            self._docs.append(doc)
            return SimpleNamespace(matched_count=0, upserted_id=len(self._docs))
        return SimpleNamespace(matched_count=0, upserted_id=None)

    @staticmethod
    def _apply(doc, update):
        for key, val in (update.get("$set") or {}).items():
            parts = key.split(".")
            tgt = doc
            for p in parts[:-1]:
                tgt = tgt.setdefault(p, {})
            tgt[parts[-1]] = val
        for key in update.get("$unset") or {}:
            doc.pop(key, None)

    def insert_one(self, doc, *a, **k):
        self._docs.append(dict(doc))
        return SimpleNamespace(inserted_id=len(self._docs))

    def insert_many(self, docs, *a, **k):
        for d in docs:
            self.insert_one(d)
        return SimpleNamespace(
            inserted_ids=[d.get("_id") for d in docs])

    def delete_many(self, *a, **k):
        return SimpleNamespace(deleted_count=0)

    def update_many(self, filt, update, *a, **k):
        n = 0
        for d in self._docs:
            if _match(d, filt):
                self._apply(d, update)
                n += 1
        return SimpleNamespace(modified_count=n)


class FakeDb:
    def __init__(self, colls=None):
        self._colls: dict[str, FakeColl] = {}
        for name, docs in (colls or {}).items():
            self._colls[name] = FakeColl(docs)
            self._colls[name].database = self

    def __getitem__(self, name):
        if name not in self._colls:
            self._colls[name] = FakeColl()
            self._colls[name].database = self
        return self._colls[name]

    def list_collection_names(self):
        return list(self._colls)


class _AdminNs:
    def command(self, *a, **k):
        return {"ok": 1}


class FakeClient:
    """client[db_name] → FakeDb; client.admin.command('ping') works."""

    def __init__(self, dbs=None):
        self._dbs: dict[str, FakeDb] = dict(dbs or {})
        self.admin = _AdminNs()

    def __getitem__(self, name):
        return self._dbs.setdefault(name, FakeDb())


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
