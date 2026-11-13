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

import copy
import re
import types
from types import SimpleNamespace

# field-level operators ที่ production path ใช้จริง — op อื่นต้อง raise
#   (Mongo: OperationFailure code 2 "unknown operator") ห้าม match เงียบ
_KNOWN_FIELD_OPS = frozenset({"$in", "$ne", "$exists", "$regex", "$options"})


def _unknown_op(op):
    """Mongo parity: unknown operator → OperationFailure — never silent match."""
    try:
        from pymongo.errors import OperationFailure
        raise OperationFailure(f"unknown operator: {op}", code=2)
    except OperationFailure:
        raise
    except ImportError:
        raise AssertionError(f"unknown operator: {op}")


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
        if k in ("$or", "$nor"):
            branches = [bool(_match(doc, sub)) for sub in cond]
            if (k == "$or") == any(branches):
                continue
            return False
        if k == "$and":
            if not all(_match(doc, sub) for sub in cond):
                return False
            continue
        if k.startswith("$"):
            _unknown_op(k)
        val, present = _get_path(doc, k) if "." in k else (doc.get(k), k in doc)
        vals = val if isinstance(val, list) else [val]  # array → any-element
        if isinstance(cond, dict) and any(
                str(ck).startswith("$") for ck in cond):
            for ck, cval in cond.items():
                if ck not in _KNOWN_FIELD_OPS:
                    _unknown_op(ck)
                if ck == "$in":
                    if not any(_norm(v) in {_norm(x) for x in cval}
                               for v in vals):
                        return False
                elif ck == "$regex":
                    opts = cond.get("$options", "")
                    flags = re.IGNORECASE if "i" in opts else 0
                    if not any(re.search(cval, str(v or ""), flags)
                               for v in vals):
                        return False
                elif ck == "$ne":
                    if any(_norm(v) == _norm(cval) for v in vals):
                        return False
                elif ck == "$exists":
                    # field presence (Mongo semantics) — field ที่มีค่า None
                    #   ยังนับว่ามี field อยู่ (≠ value check)
                    if present != bool(cval):
                        return False
        else:
            # equality — embedded-doc dict (no $ keys) = whole-value equality
            if not any(_norm(v) == _norm(cond) for v in vals):
                return False
    return True


def _materialize_eq(filt: dict) -> dict:
    """Upsert insert doc = equality predicates เท่านั้น — operator dict
    ({"platform": {"$in": [...]}}) เป็น query predicate ไม่ใช่ค่าที่ต้อง
    materialize เข้า document (real Mongo semantics)."""
    out = {}
    for k, v in (filt or {}).items():
        if k.startswith("$"):
            continue
        if isinstance(v, dict) and any(str(ck).startswith("$") for ck in v):
            continue
        out[k] = copy.deepcopy(v)
    return out


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
    """Minimal Mongo collection double — equality/$in/$regex/$ne/$exists
    filters, $set/$unset, copy-on-read/write boundaries, opt-in unique keys.

    unique_keys: tuple ของ key spec เช่น ("conversation_id",) หรือ
    (("platform", "conversation_id"),) — opt-in per collection (production
    index ที่ต้อง enforce ใน test เท่านั้น; collections อื่นอนุญาต dups).
    Collision บน write → pymongo.errors.DuplicateKeyError-compatible.
    key ที่เป็น None ทุกตัวใน doc → ข้ามเช็ค (sparse-like, กัน false positive
    กับ docs ที่ไม่มี field)."""

    def __init__(self, docs=None, *, unique_keys=()):
        self._docs: list[dict] = [copy.deepcopy(d) for d in (docs or [])]
        self.database = None  # bound by FakeDb
        self._unique_keys = [
            tuple(k) if isinstance(k, (list, tuple)) else (k,)
            for k in unique_keys]

    def _check_unique(self, doc, skip_idx: int | None = None):
        from pymongo.errors import DuplicateKeyError
        for uk in self._unique_keys:
            vals = [doc.get(f) for f in uk]
            if all(v is None for v in vals):
                continue  # sparse-like: doc ไม่มี unique key เลย → ข้าม
            for i, d in enumerate(self._docs):
                if i == skip_idx or d is doc:
                    continue
                if all(_norm(d.get(f)) == _norm(v) for f, v in zip(uk, vals)):
                    raise DuplicateKeyError(
                        f"E11000 duplicate key error "
                        f"collection: dup key {{{', '.join(uk)}}}")

    def find_one(self, filt=None, *a, **k):
        for d in self._docs:
            if _match(d, filt):
                return copy.deepcopy(d)
        return None

    def find(self, filt=None, *a, **k):
        return _Cursor([copy.deepcopy(d) for d in self._docs
                        if _match(d, filt)])

    def count_documents(self, filt=None, *a, **k):
        return sum(1 for d in self._docs if _match(d, filt))

    def estimated_document_count(self):
        return len(self._docs)

    def aggregate(self, *a, **k):
        return iter(())

    def distinct(self, field, *a, **k):
        return list({d.get(field) for d in self._docs})

    def create_index(self, spec=None, *a, **k):
        if k.get("unique") and spec:
            keys = tuple(
                p[0] if isinstance(p, (list, tuple)) else p
                for p in (spec if isinstance(spec, (list, tuple))
                          else (spec,)))
            if keys not in self._unique_keys:
                self._unique_keys.append(keys)
        return None

    def update_one(self, filt, update, upsert=False, *a, **k):
        for i, d in enumerate(self._docs):
            if _match(d, filt):
                # atomic per doc (real Mongo): candidate → validate → commit
                cand = copy.deepcopy(d)
                self._apply(cand, update)
                if cand.get("_id") != d.get("_id"):
                    from pymongo.errors import OperationFailure
                    raise OperationFailure(
                        "Performing an update on the path '_id' would "
                        "modify the immutable field '_id'", code=66)
                self._check_unique(cand, skip_idx=i)
                self._docs[i] = cand
                return SimpleNamespace(matched_count=1, upserted_id=None)
        if upsert:
            doc = _materialize_eq(filt)
            self._apply(doc, update)
            self._check_unique(doc)
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
            tgt[parts[-1]] = copy.deepcopy(val)
        for key in update.get("$unset") or {}:
            doc.pop(key, None)

    def insert_one(self, doc, *a, **k):
        self._check_unique(doc)
        self._docs.append(copy.deepcopy(doc))
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
        for i, d in enumerate(self._docs):
            if _match(d, filt):
                # candidate → validate → commit (abort ที่ doc นี้ ไม่ rollback)
                cand = copy.deepcopy(d)
                self._apply(cand, update)
                if cand.get("_id") != d.get("_id"):
                    from pymongo.errors import OperationFailure
                    raise OperationFailure(
                        "Performing an update on the path '_id' would "
                        "modify the immutable field '_id'", code=66)
                self._check_unique(cand, skip_idx=i)
                self._docs[i] = cand
                n += 1
        return SimpleNamespace(modified_count=n)


class FakeDb:
    def __init__(self, colls=None, *, coll_opts=None):
        self._colls: dict[str, FakeColl] = {}
        opts = coll_opts or {}
        for name, docs in (colls or {}).items():
            self._colls[name] = FakeColl(docs, **opts.get(name, {}))
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

    def __init__(self, docs=None, name="", db=None, *, unique_keys=()):
        super().__init__(docs, unique_keys=unique_keys)
        self.name = name
        self._db = db
        self.indexes: list = []
        self.dropped = False

    def _check_id(self, doc):
        from pymongo.errors import DuplicateKeyError
        if "_id" in doc and any(
                d.get("_id") == doc["_id"] for d in self._docs
                if d is not doc):
            raise DuplicateKeyError(f"dup _id {doc['_id']}")

    def insert_one(self, doc, *a, **k):
        self._check_id(doc)
        return super().insert_one(doc)

    def insert_many(self, docs, *a, **k):
        for d in docs:
            self._check_id(d)
            self._check_unique(d)
        for d in docs:
            self._docs.append(copy.deepcopy(d))
        return types.SimpleNamespace(inserted_ids=list(range(len(docs))))

    def bulk_write(self, ops, *a, **k):
        from pymongo import UpdateOne
        n = 0
        for op in ops:
            if isinstance(op, UpdateOne):
                filt, update = op._filter, op._doc
                hit = False
                for i, d in enumerate(self._docs):
                    if _match(d, filt):
                        # candidate → validate → commit เช่นเดียวกับ update_one
                        cand = copy.deepcopy(d)
                        self._apply(cand, update)
                        if cand.get("_id") != d.get("_id"):
                            from pymongo.errors import OperationFailure
                            raise OperationFailure(
                                "Performing an update on the path '_id' "
                                "would modify the immutable field '_id'",
                                code=66)
                        self._check_unique(cand, skip_idx=i)
                        self._docs[i] = cand
                        hit = True
                if not hit and op._upsert:
                    doc = _materialize_eq(filt)
                    self._apply(doc, update)
                    self._check_id(doc)
                    self._check_unique(doc)
                    self._docs.append(doc)
                n += 1
        return types.SimpleNamespace(
            upserted_count=0, modified_count=n, matched_count=n)

    def replace_one(self, filt, doc, upsert=False, *a, **k):
        for i, d in enumerate(self._docs):
            if _match(d, filt):
                cand = copy.deepcopy(doc)
                self._check_unique(cand, skip_idx=i)
                self._docs[i] = cand
                return types.SimpleNamespace(matched_count=1, upserted_id=None)
        if upsert:
            cand = copy.deepcopy(doc)
            self._check_id(cand)
            self._check_unique(cand)
            self._docs.append(cand)
            return types.SimpleNamespace(matched_count=0, upserted_id=len(self._docs))
        return types.SimpleNamespace(matched_count=0, upserted_id=None)

    def update_one(self, filt, update, upsert=False, *a, **k):
        # fenced bootstrap: upsert that would create a doc with an _id that
        # already exists must raise DuplicateKeyError (real Mongo behavior)
        if not any(_match(d, filt) for d in self._docs) and upsert:
            doc = _materialize_eq(filt)
            self._apply(doc, update)
            self._check_id(doc)
            self._check_unique(doc)
            self._docs.append(doc)
            return types.SimpleNamespace(matched_count=0, upserted_id=len(self._docs))
        return super().update_one(filt, update, upsert=upsert, *a, **k)

    def create_index(self, spec=None, *a, **k):
        self.indexes.append(spec)
        return super().create_index(spec, *a, **k)

    def drop(self, *a, **k):
        self.dropped = True
        self._docs.clear()
        if self._db is not None:
            self._db._colls.pop(self.name, None)


class GenDb(FakeDb):
    """FakeDb vending GenColl + recording collection-name access order."""

    def __init__(self, colls=None, *, coll_opts=None):
        self.accessed: list[str] = []
        super().__init__()
        opts = coll_opts or {}
        for name, docs in (colls or {}).items():
            self._colls[name] = GenColl(
                docs, name=name, db=self, **opts.get(name, {}))
            self._colls[name].database = self

    def __getitem__(self, name):
        self.accessed.append(name)
        if name not in self._colls:
            self._colls[name] = GenColl(name=name, db=self)
            self._colls[name].database = self
        return self._colls[name]

    def drop_collection(self, name):
        self._colls.pop(name, None)
