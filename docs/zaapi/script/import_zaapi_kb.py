# -*- coding: utf-8 -*-
"""Import immutable Zaapi raw rows and optionally canonical knowledge records.

วิธีใช้:
    .venv/bin/python docs/zaapi/script/import_zaapi_kb.py --dry-run
    .venv/bin/python docs/zaapi/script/import_zaapi_kb.py --canonicalize --dry-run
    .venv/bin/python docs/zaapi/script/import_zaapi_kb.py --canonicalize --apply

ข้อมูล:
    input  = docs/zaapi/kb-export/ (knowledge-sources.json + knowledge-files/*)
    output = ADMIN_MONGO_*.zaapi_kb_raw_sources (raw) + zaapi_kb_records (canonical)
             (legacy runtime collection `zaapi_kb` is never read or written)

Global `active:manifest` in zaapi_kb_records is the single publication authority;
its pointers reference immutable per-source revision documents validated in full;
legacy raw documents remain untouched. Without --apply, no database is opened.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import openpyxl
from openpyxl.worksheet.hyperlink import Hyperlink as _OxlHyperlink
from pymongo.errors import DuplicateKeyError

# openpyxl 3.1.5 parse hyperlink 'address' attribute (OOXML ใหม่) ไม่ได้ → drop kwarg ก่อน parse
_hl_init = _OxlHyperlink.__init__
def _hl_init_compat(self, *a, **kw):
    kw.pop("address", None)
    _hl_init(self, *a, **kw)
_OxlHyperlink.__init__ = _hl_init_compat
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT / "chatbot"))
from shopeechat.kb_zaapi_schema import (  # noqa: E402
    MANIFEST_POINTER_FIELDS, RAW_AUDIT_FIELDS, RAW_CONTENT_FIELDS, Readiness,
    EXTRACTION_FIELDS, RECORD_PROVENANCE_UNHASHED,
    SCHEMA_REVISION, SCHEMA_REVISION_V2, SEMANTIC_CONTENT_FIELDS,
    ZaapiKnowledgeRecord,
    account_scope_fingerprint, build_revision, canonical_json,
    canonical_record_id, fingerprint, index_raw_rows, load_active_state,
    raw_row_id, sanitize_source_row, valid_row_uid, validate_manifest,
    validate_manifest_records, validate_record_provenance, validate_raw_row,
)

EXPORT_DIR = Path(__file__).resolve().parent.parent / "kb-export"
ADMIN_DB_NAME = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
ZA_KB_RAW_COLL = "zaapi_kb_raw_sources"
MODEL_VERSION = "gemini-3.5-flash-lite"  # gemini-2.5-flash retired provider-side (404); free-tier daily caps make non-lite models unusable
PROMPT_VERSION = "zaapi-kb-v1"


def _get_admin_db() -> "MongoClient":
    """เชื่อม admin DB จาก ADMIN_MONGO_* ใน process environment."""
    uri = os.environ.get("ADMIN_MONGO_URI", "").strip()
    if uri:
        return MongoClient(uri)
    params: dict = {
        "host": os.environ.get("ADMIN_MONGO_HOST", "127.0.0.1:27017").strip(),
        "authSource": os.environ.get("ADMIN_MONGO_AUTH_SOURCE", "admin").strip(),
        "tls": os.environ.get("ADMIN_MONGO_TLS", "false").strip().lower() == "true",
    }
    u = os.environ.get("ADMIN_MONGO_USERNAME", "").strip()
    p = os.environ.get("ADMIN_MONGO_PASSWORD", "").strip()
    if u:
        params["username"] = u
    if p:
        params["password"] = p
    return MongoClient(**params)


def _clean(v) -> str:
    s = str(v).strip() if v is not None else ""
    return " ".join(s.split())


def _xlsx_docs(item: dict, path: Path) -> list[dict]:
    """xlsx → doc ต่อ data row (header = ชื่อคอลัมน์, cell ว่างข้าม)."""
    wb = openpyxl.load_workbook(path, data_only=True)  # read_only parse hyperlink พังใน openpyxl 3.1.5
    docs: list[dict] = []
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        header = [_clean(c) for c in next(rows, [])]
        for idx, row in enumerate(rows, start=2):
            fields = {
                header[i]: _clean(v)
                for i, v in enumerate(row)
                if i < len(header) and header[i] and _clean(v)
            }
            if not fields:
                continue
            docs.append({
                "kind": "xlsx_row",
                "sheet": ws.title,
                "row_index": len(docs),
                "source_row": idx,
                "fields": fields,
                "text": "\n".join(f"{k}: {v}" for k, v in fields.items()),
            })
    wb.close()
    return docs


def _txt_doc(item: dict, path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    return [{"kind": "text", "sheet": None, "row_index": 0,
             "source_row": 0, "fields": {}, "text": text}] if text else []


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _build_docs(item: dict, files_dir: Path, batch: str) -> list[dict]:
    df = item.get("downloaded_file") or {}
    filename = df.get("file", "")
    if (not isinstance(filename, str) or not filename
            or Path(filename).name != filename
            or filename.startswith(".env")
            or filename == "มาแล้วจ้า.md"
            or Path(filename).suffix.lower() not in (".xlsx", ".txt")):
        raise ValueError("invalid source path")
    path = files_dir / filename
    if not path.is_file():
        raise FileNotFoundError(path.name)
    fp = _sha256(path)
    if df.get("sha256") and fp != df["sha256"]:
        raise ValueError(f"sha256 mismatch: {path.name}")
    ver = item.get("version") or {}
    scope_fp = account_scope_fingerprint(item.get("accounts") or [])
    base = {
        "source_id": item["id"],
        "source_name": item.get("name", ""),
        "version_id": ver.get("versionId", ""),
        "source_type": ver.get("type", "file"),
        "accounts": sorted([
            {"id": a.get("id", ""), "platform": a.get("platform", ""), "name": a.get("name", "")}
            for a in item.get("accounts", [])
        ], key=canonical_json),
        "fingerprint": fp,
        "scope_fingerprint": scope_fp,
        "source_file": path.name,
        "active": True,
        "import_batch": batch,
        "zaapi_updated_at": item.get("updated_at", ""),
    }
    rows = _xlsx_docs(item, path) if path.suffix.lower() == ".xlsx" else _txt_doc(item, path)
    return [{**base, **r} for r in rows]


def _gemini_extract(raw: dict) -> dict:
    """Extract one row only when --canonicalize is explicitly requested."""
    from google import genai

    scalar = {"anyOf": [{"type": "string"}, {"type": "number"},
                        {"type": "boolean"},
                        {"type": "array", "items": {"type": "string"}}]}
    props = {
        "record_type": {"type": "string", "enum": [
            "spec", "compatibility", "faq", "troubleshooting", "policy", "note"]},
        "topic": {"type": "string"},
        "model_codes": {"type": "array", "items": {"type": "string"}},
        "aliases": {"type": "array", "items": {"type": "string"}},
        "item_id": {"type": ["string", "null"]},
        "model_id": {"type": ["string", "null"]},
        "subject_id": {"type": ["string", "null"]},
        "target_id": {"type": ["string", "null"]},
        "facts": {"type": "array", "items": {
            "type": "object", "properties": {
                "key": {"type": "string"}, "value": scalar},
            "required": ["key", "value"], "additionalProperties": False}},
        "answer_text": {"type": "string"},
        "steps": {"type": "array", "items": {"type": "string"}},
    }
    client = genai.Client()  # named binding — anonymous temp is GC'd and closes the httpx client mid-call (google-genai 1.75)
    response = client.models.generate_content(
        model=MODEL_VERSION,
        contents=(f"Extract only facts explicitly present in this Zaapi KB row. "
                  f"Do not guess identity, values, or compatibility.\n{raw['text']}"),
        config={"response_mime_type": "application/json",
                "response_json_schema": {
                    "type": "object", "properties": props,
                    "required": list(props), "additionalProperties": False}},
    )
    return json.loads(response.text or "{}")


def _write_checkpoint(path: Path, state: dict) -> None:
    target = path.with_suffix(path.suffix + ".tmp")
    target.write_text(canonical_json(state) + "\n", encoding="utf-8")
    target.replace(path)


def _persist_immutable(collection, expected: dict, audit: tuple = ()) -> None:
    """Insert-once, then exact readback; `audit` fields (raw rows) are first-seen."""
    for doc_id, fields in expected.items():
        try:
            collection.update_one(
                {"_id": doc_id}, {"$setOnInsert": fields}, upsert=True)
        except DuplicateKeyError:
            pass
        stored = collection.find_one({"_id": doc_id}) or {}
        if audit is RAW_AUDIT_FIELDS:
            validate_raw_row(stored)
        if ({k: v for k, v in stored.items() if k not in audit}
                != {k: v for k, v in {"_id": doc_id, **fields}.items()
                    if k not in audit}):
            raise ValueError("persisted record mismatch")


def _fact_conflicts(records, docs, source_id) -> set[int]:
    """Indexes of resolved candidates whose fact value contradicts another source's."""
    entries = [(index, record.to_dict()) for index, record in enumerate(records)
               if record.readiness == Readiness.RESOLVED]
    entries += [(None, doc) for doc in docs if doc["source_id"] != source_id]
    seen: dict[tuple, tuple[str, int | None]] = {}
    conflicted: set[int] = set()
    for index, doc in entries:
        identity = (doc["item_id"] or doc["model_id"]
                    or tuple(sorted(doc["model_codes"])))
        for fact in doc["facts"]:
            key = (doc["shop"], doc["platform"], identity,
                   doc["target_id"], fact["key"])
            value = canonical_json(fact["value"])
            if key in seen and seen[key][0] != value:
                conflicted.update(i for i in (index, seen[key][1])
                                  if i is not None)
            elif index is not None:
                seen[key] = (value, index)
    return conflicted


def _registry_id(source_id: str) -> str:
    return f"reg:{source_id}"


def declare_source(registry_coll, source_id: str, *, key_mode: str,
                   key_columns: list, declared_by: str,
                   declared_at: str) -> dict:
    """Insert-once source identity declaration: match aid columns or assigned."""
    if key_mode not in ("column", "assigned"):
        raise ValueError("invalid key_mode")
    if key_mode == "column" and not key_columns:
        raise ValueError("column mode requires key_columns")
    doc = {"_id": _registry_id(source_id), "source_id": source_id,
           "key_mode": key_mode, "key_columns": list(key_columns or []),
           "uid_next": 0, "staged": {}, "lease": None,
           "declared_by": declared_by, "declared_at": declared_at}
    registry_coll.update_one(
        {"_id": doc["_id"]},
        {"$setOnInsert": {k: v for k, v in doc.items() if k != "_id"}},
        upsert=True)
    return registry_coll.find_one({"_id": doc["_id"]})


def _write_log(log_coll, entry: dict) -> None:
    if log_coll is None:
        return
    entry = {**entry, "at": datetime.datetime.now(
        datetime.timezone.utc).isoformat(),
        "attempt": os.urandom(16).hex()}
    log_coll.update_one(
        {"_id": "log:" + fingerprint((
            entry["source_id"], entry["event"], entry["at"],
            entry["attempt"], entry.get("revision_id"),
            entry.get("file_fp"), entry.get("detail")))},
        {"$setOnInsert": entry}, upsert=True)


def _row_content_fp(safe_row: dict) -> str:
    return fingerprint(
        {key: safe_row.get(key) for key in SEMANTIC_CONTENT_FIELDS})


def _account_key(name: str, platform: str) -> str:
    return f"{name}|{platform}"  # row_map member key — validator shares this


def import_source(
    item: dict, files_dir: Path, raw_coll, records_coll, *,
    extractor=None, canonicalize: bool = False, apply: bool = False,
    checkpoint: Path | None = None, registry_coll=None, log_coll=None,
    importer_tag: str = "cli", confirm: frozenset = frozenset(),
) -> dict:
    """Store raw snapshots separately; publish canonical revision atomically by pointer."""
    if not isinstance(item.get("id"), str) or not item["id"].strip():
        raise ValueError("missing source_id")
    if not apply and records_coll is None:
        return {"source_id": item["id"], "status": "unavailable",
                "reason": "active state unreadable — cannot diff",
                "published": False}
    rows = _build_docs(item, files_dir, "canonical-v1")
    fp = rows[0]["fingerprint"] if rows else _sha256(
        files_dir / item["downloaded_file"]["file"])
    source_revision = (item.get("version") or {}).get("versionId", "")
    scope_fp = account_scope_fingerprint(item.get("accounts") or [])
    log_coll = log_coll if log_coll is not None else registry_coll
    manifest_key = {"_id": "active:manifest"}
    try:
        expected_manifest = (records_coll.find_one(manifest_key)
                             if records_coll is not None else None)
        persisted: list[dict] = []
        if expected_manifest:
            persisted = load_active_state(
                records_coll, raw_coll, expected_manifest)
        expected_sources = (expected_manifest["sources"]
                            if expected_manifest else {})
        expected_pointer = expected_sources.get(item["id"])
        prior_rev = (records_coll.find_one(
            {"_id": expected_pointer["revision_id"]})
            if expected_pointer and records_coll is not None else None)
        if prior_rev is not None and prior_rev.get(
                "schema_revision") != SCHEMA_REVISION_V2:
            prior_rev = None        # v1 active → first v2 import = full baseline
        expected_rev_id = (expected_pointer["revision_id"]
                           if expected_pointer and prior_rev else None)
        registry_coll.update_one(
            {"_id": _registry_id(item["id"])},
            {"$setOnInsert": {"source_id": item["id"], "key_mode": "assigned",
                              "key_columns": [], "uid_next": 0, "staged": {},
                              "lease": None}},
            upsert=True) if apply and registry_coll is not None else None
        reg = (registry_coll.find_one({"_id": _registry_id(item["id"])})
               if registry_coll is not None else None) or {
            "key_mode": "assigned", "key_columns": [], "uid_next": 0,
            "staged": {}, "lease": None}
    except Exception:
        if apply:
            raise
        return {"source_id": item["id"], "status": "unavailable",
                "reason": "active state unreadable — cannot diff",
                "published": False}
    if apply and reg.get("lease") not in (None, importer_tag):
        return {"source_id": item["id"], "status": "stopped",
                "reason": f"leased by {reg['lease']}", "published": False}
    staged_all = dict(reg.get("staged") or {})
    staged = staged_all.get(importer_tag)
    if staged and (staged.get("file_fp") != fp
                   or staged.get("expected_rev") != expected_rev_id):
        staged = None               # stale attempt for another file/base
    adds = dict((staged or {}).get("adds") or {})
    confirmations = set((staged or {}).get("confirmations") or ()) | set(confirm)
    if apply and registry_coll is not None:
        acquired = registry_coll.update_one(
            {"_id": _registry_id(item["id"]), "lease": None},
            {"$set": {"lease": importer_tag}})
        if getattr(acquired, "matched_count", 0) == 0:
            return {"source_id": item["id"], "status": "stopped",
                    "reason": "lease busy", "published": False}
    try:
        return _import_v2(
            item, rows, fp, source_revision, scope_fp, raw_coll,
            records_coll, registry_coll, log_coll, extractor=extractor,
            canonicalize=canonicalize, apply=apply, checkpoint=checkpoint,
            importer_tag=importer_tag, confirmations=confirmations,
            expected_manifest=expected_manifest,
            expected_pointer=expected_pointer, prior_rev=prior_rev,
            expected_rev_id=expected_rev_id, reg=reg, staged=staged,
            staged_all=staged_all, adds=adds, persisted=persisted)
    finally:
        if apply and registry_coll is not None:
            registry_coll.update_one(
                {"_id": _registry_id(item["id"]), "lease": importer_tag},
                {"$set": {"lease": None}})


def _import_v2(item, rows, fp, source_revision, scope_fp, raw_coll,
               records_coll, registry_coll, log_coll, *, extractor,
               canonicalize, apply, checkpoint, importer_tag, confirmations,
               expected_manifest, expected_pointer, prior_rev,
               expected_rev_id, reg, staged, staged_all, adds,
               persisted) -> dict:
    """v2 diff-import: match durable uids → diff → publish revision → CAS."""
    source_id = item["id"]
    expected_sources = expected_manifest["sources"] if expected_manifest else {}
    checkpoint_key = fingerprint((
        source_id, fp, source_revision, scope_fp, MODEL_VERSION, PROMPT_VERSION))
    state = (json.loads(checkpoint.read_text(encoding="utf-8"))
             if checkpoint and checkpoint.exists() else {})
    if not isinstance(state, dict):
        raise ValueError("invalid checkpoint")
    progress = state[checkpoint_key] if checkpoint_key in state else {
        "source_id": source_id, "source_fingerprint": fp,
        "source_revision": source_revision, "scope_fingerprint": scope_fp,
        "model_version": MODEL_VERSION,
        "prompt_version": PROMPT_VERSION, "status": "unresolved", "rows": {},
        "expected_revision": expected_rev_id,
        "expected_generation": (expected_manifest["generation"]
                                if expected_manifest else None),
    }
    if not isinstance(progress, dict) or not isinstance(progress.get("rows"), dict):
        raise ValueError("invalid checkpoint rows")
    if progress.get("status") == "complete":
        progress["expected_revision"] = expected_rev_id
        progress["expected_generation"] = (
            expected_manifest["generation"] if expected_manifest else None)
    if "expected_revision" not in progress:
        raise ValueError("missing checkpoint publication fence")
    if "expected_generation" not in progress:
        raise ValueError("missing checkpoint manifest fence")
    if any(progress.get(key) != value for key, value in (
            ("source_id", source_id), ("source_fingerprint", fp),
            ("source_revision", source_revision), ("scope_fingerprint", scope_fp),
            ("model_version", MODEL_VERSION), ("prompt_version", PROMPT_VERSION))):
        raise ValueError("checkpoint metadata mismatch")

    # --- noop: full contract tuple + clean quarantine + no pending staged ---
    if (expected_pointer and prior_rev and not (staged or {}).get("adds")
            and prior_rev.get("quarantined") == []
            and all(expected_pointer.get(key) == value for key, value in (
                ("source_fingerprint", fp), ("scope_fingerprint", scope_fp),
                ("source_revision", source_revision),
                ("model_version", MODEL_VERSION),
                ("prompt_version", PROMPT_VERSION),
                ("schema_revision", SCHEMA_REVISION_V2)))):
        if apply and checkpoint and progress.get("status") != "complete":
            progress["status"] = "complete"
            progress["revision_id"] = expected_pointer["active_revision"]
            state[checkpoint_key] = progress
            _write_checkpoint(checkpoint, state)
        if apply:
            _write_log(log_coll, {"source_id": source_id,
                                  "event": "noop_reimport",
                                  "revision_id": expected_pointer["revision_id"],
                                  "file_fp": fp, "detail": {}})
        return {"source_id": source_id, "source_fingerprint": fp,
                "status": "noop", "raw_count": len(rows),
                "record_count": expected_pointer["record_count"],
                "revision_id": expected_pointer["active_revision"],
                "published": True, "readiness": "resolved"}

    # --- durable prior state ---
    prior_row_map = (prior_rev or {}).get("row_map") or {}
    prior_key_map = (prior_rev or {}).get("key_map") or {}
    prior_quar = {q["row_uid"]: q
                  for q in (prior_rev or {}).get("quarantined") or []}
    prior_recs = {doc["_id"]: doc for doc in records_coll.find(
        {"_id": {"$in": (prior_rev or {}).get("record_ids") or []}}
    )} if records_coll is not None else {}
    prior_uid_fp = {
        uid: prior_recs[members[next(iter(members))]]["content_fingerprint"]
        for uid, members in prior_row_map.items()
        if members and members[next(iter(members))] in prior_recs}
    key_columns = list(reg.get("key_columns") or [])
    uid_next = int(reg.get("uid_next") or 0)
    durable_max = [int(uid.rsplit(":r", 1)[1]) + 1
                   for uid in (*prior_row_map, *prior_quar)
                   if uid.rsplit(":r", 1)[-1].isdigit()]
    if durable_max:
        uid_next = max(uid_next, max(durable_max))

    # --- match rows to durable uids ---
    key_of = ((lambda fields: "\x00".join(
        fields.get(c, "") for c in key_columns))
        if key_columns else None)
    assignments: dict = {}          # row position → uid
    file_uids: set = set()
    missing_keys: set = set()       # declared keys absent from file
    new_keys: list = []             # keys not in prior_key_map
    stop_reason = None
    proposals: list = []
    if key_of:
        seen_keys: dict = {}
        for pos, row in enumerate(rows):
            key = key_of(row["fields"])
            if not key.strip("\x00"):
                stop_reason = "blank declared key"
                break
            if key in seen_keys:
                stop_reason = f"duplicate declared key {key!r}"
                break
            seen_keys[key] = pos
            uid = prior_key_map.get(key)
            if uid is None:
                uid = adds.get(key)
                if uid is None:
                    new_keys.append(key)
                    continue
            if uid in file_uids:
                stop_reason = f"key collision on {key!r}"
                break
            file_uids.add(uid)
            assignments[pos] = uid
        if not stop_reason:
            prior_keys = set(prior_key_map)
            file_keys = set(seen_keys)
            missing_keys = prior_keys - file_keys
            if len(new_keys) == 1 and len(missing_keys) == 1:
                proposals.append({"type": "rename",
                                  "from": next(iter(missing_keys)),
                                  "to": new_keys[0],
                                  "needs_confirm": "rename"})
            else:
                for key in sorted(missing_keys):
                    proposals.append({"type": "deactivate",
                                      "key": key, "uid": prior_key_map[key],
                                      "needs_confirm": "deactivate"})
    else:
        prior_fp_uid: dict = {}
        for uid, row_fp in prior_uid_fp.items():
            prior_fp_uid.setdefault(row_fp, []).append(uid)
        for uid, q in prior_quar.items():
            prior_fp_uid.setdefault(q["row_content_fp"], []).append(uid)
        unmatched_new: list = []
        used: set = set()
        for pos, row in enumerate(rows):
            safe = sanitize_source_row(row)
            row_fp = _row_content_fp(safe)
            cands = [u for u in prior_fp_uid.get(row_fp, [])
                     if u not in used and u not in file_uids]
            if len(cands) > 1:
                stop_reason = "assigned match ambiguous"
                break
            if cands:
                used.add(cands[0])
                file_uids.add(cands[0])
                assignments[pos] = cands[0]
            else:
                unmatched_new.append(pos)
        if not stop_reason:
            absent = sorted(set(prior_row_map) - file_uids)
            if absent or unmatched_new:
                if len(absent) == len(unmatched_new) and absent:
                    for uid, pos in zip(absent, unmatched_new):
                        proposals.append({"type": "reposition",
                                          "uid": uid, "row": pos,
                                          "needs_confirm": "reposition"})
                else:
                    for uid in absent:
                        proposals.append({"type": "deactivate", "uid": uid,
                                          "needs_confirm": "deactivate"})

    # --- confirmations gate: token binds this file, this diff base, and
    # the exact proposal — a stale/category confirmation cannot apply ---
    for p in proposals:
        p["needs_confirm"] = p["type"] + ":" + fingerprint(
            (expected_rev_id, fp, p["type"],
             {k: v for k, v in p.items() if k != "needs_confirm"}))
    if not apply:
        # read-only preview: diff + proposal tokens vs active state —
        # no extraction, no registry/checkpoint/log/active writes
        preview_assign = dict(assignments)
        preview_map: dict = {}
        for pos in range(len(rows)):
            uid = preview_assign.get(pos)
            if uid is None:
                uid = f"new:{pos}"
                preview_assign[pos] = uid
            preview_map[uid] = {}
        return {"source_id": source_id, "source_fingerprint": fp,
                "status": "stopped" if stop_reason else "preview",
                "reason": stop_reason,
                "proposals": proposals,
                "diff": _diff_summary(preview_assign, prior_row_map,
                                      prior_uid_fp, prior_quar, rows,
                                      preview_map, []),
                "published": False, "raw_count": len(rows),
                "readiness": "unassessed"}
    needed = {p["needs_confirm"] for p in proposals}
    if stop_reason is None and needed - confirmations:
        _write_log(log_coll, {"source_id": source_id,
                              "event": "needs_confirm", "file_fp": fp,
                              "detail": {"proposals": proposals}})
        return {"source_id": source_id, "source_fingerprint": fp,
                "status": "needs_confirm", "proposals": proposals,
                "published": False, "raw_count": len(rows)}
    for p in proposals:
        if p["type"] == "rename":
            assignments[seen_keys[p["to"]]] = prior_key_map[p["from"]]
            file_uids.add(prior_key_map[p["from"]])
            missing_keys.discard(p["from"])
            new_keys.remove(p["to"])
        elif p["type"] == "reposition":
            assignments[p["row"]] = p["uid"]
            file_uids.add(p["uid"])

    # --- mint uids for remaining unmatched rows ---
    staged_dirty = False
    for pos, row in enumerate(rows):
        if pos in assignments:
            continue
        key = key_of(row["fields"]) if key_of else None
        uid = adds.get(key) if key else adds.get(f"pos:{pos}")
        if uid is None:
            uid = f"{source_id}:r{uid_next}"
            uid_next += 1
            if key:
                adds[key] = uid
            else:
                adds[f"pos:{pos}"] = uid
            staged_dirty = True
        assignments[pos] = uid
        file_uids.add(uid)
    if apply and registry_coll is not None and (
            adds or staged_dirty or staged is None and adds):
        new_staged = {"file_fp": fp, "adds": adds,
                      "expected_rev": expected_rev_id,
                      "confirmations": sorted(confirmations)}
        staged_all[importer_tag] = new_staged
        registry_coll.update_one(
            {"_id": _registry_id(source_id)},
            {"$set": {f"staged.{importer_tag}": new_staged}})

    # --- classify + extract only what changed ---
    records: list[ZaapiKnowledgeRecord] = []
    row_map: dict = {}
    quarantined: list = []
    held: list = []
    if not stop_reason and canonicalize:
        for pos, row in enumerate(rows):
            uid = assignments[pos]
            safe_row = sanitize_source_row(row)
            row_fp = _row_content_fp(safe_row)
            existing = uid in prior_row_map
            prior_accounts = prior_row_map.get(uid) or {}
            row_accounts = [(_account_key(a.get("name", ""),
                                          a.get("platform", "")), a)
                            for a in safe_row["accounts"]]
            members: dict = {}
            if existing and prior_uid_fp.get(uid) == row_fp:
                for account_key, account in row_accounts:
                    if account_key in prior_accounts:
                        members[account_key] = prior_accounts[account_key]
            need_extract = [a for a in row_accounts
                            if a[0] not in members]
            if need_extract:
                output = progress["rows"].get(row_fp) if checkpoint else None
                prepared = None
                if output is not None:
                    prepared = [ZaapiKnowledgeRecord.from_extraction(
                        safe_row, output, row_uid=uid,
                        shop=account.get("name", ""),
                        platform=account.get("platform", ""),
                        model_version=MODEL_VERSION,
                        prompt_version=PROMPT_VERSION)
                        for _, account in need_extract]
                    if not all(r.readiness == Readiness.RESOLVED
                               for r in prepared):
                        prepared = None
                if prepared is None and members:
                    # unchanged row: reuse the prior member's extraction —
                    # new accounts get the same row extraction, 0 provider calls
                    donor = prior_recs.get(members[next(iter(members))])
                    if donor is not None:
                        output = {
                            k: ([dict(x) for x in donor[k]]
                                if k == "facts"
                                else list(donor[k])
                                if isinstance(donor[k], (list, tuple))
                                else donor[k])
                            for k in EXTRACTION_FIELDS}
                        prepared = [ZaapiKnowledgeRecord.from_extraction(
                            safe_row, output, row_uid=uid,
                            shop=account.get("name", ""),
                            platform=account.get("platform", ""),
                            model_version=MODEL_VERSION,
                            prompt_version=PROMPT_VERSION)
                            for _, account in need_extract]
                        if not all(r.readiness == Readiness.RESOLVED
                                   for r in prepared):
                            prepared = None
                if prepared is None:
                    try:
                        output = (extractor or _gemini_extract)(safe_row)
                        failed = False
                    except Exception:
                        output, failed = {}, True
                    prepared = [ZaapiKnowledgeRecord.from_extraction(
                        safe_row, output, row_uid=uid,
                        shop=account.get("name", ""),
                        platform=account.get("platform", ""),
                        model_version=MODEL_VERSION,
                        prompt_version=PROMPT_VERSION,
                        failed=failed) for _, account in need_extract]
                    if checkpoint and all(
                            r.readiness == Readiness.RESOLVED
                            for r in prepared):
                        progress["rows"][row_fp] = output
                        state[checkpoint_key] = progress
                        _write_checkpoint(checkpoint, state)
                if not all(r.readiness == Readiness.RESOLVED
                           for r in prepared):
                    if existing:
                        held.append({"row_uid": uid,
                                     "reason": prepared[0].readiness.value})
                        break
                    quarantined.append({
                        "row_uid": uid, "row_content_fp": row_fp,
                        "reason": prepared[0].readiness.value})
                    continue
                for rec, (account_key, _) in zip(prepared, need_extract):
                    members[account_key] = rec.record_id
                    records.append(rec)
            if not members:
                if existing:
                    held.append({"row_uid": uid,
                                 "reason": "no account membership"})
                    break
                quarantined.append({"row_uid": uid,
                                    "row_content_fp": row_fp,
                                    "reason": "no account membership"})
                continue
            row_map[uid] = members

    if held:
        _write_log(log_coll, {"source_id": source_id, "event": "hold_publish",
                              "file_fp": fp, "detail": {"rows": held}})
        if checkpoint and canonicalize:
            progress["status"] = "unresolved"
            state[checkpoint_key] = progress
            _write_checkpoint(checkpoint, state)
        return {"source_id": source_id, "source_fingerprint": fp,
                "status": "hold_publish", "held": held,
                "published": False, "raw_count": len(rows),
                "readiness": "unresolved"}
    if stop_reason:
        _write_log(log_coll, {"source_id": source_id, "event": "stopped",
                              "file_fp": fp, "detail": {"reason": stop_reason}})
        return {"source_id": source_id, "source_fingerprint": fp,
                "status": "stopped", "reason": stop_reason,
                "published": False, "raw_count": len(rows)}

    # --- conflict exclusion (cross-source facts) ---
    conflicted: set[int] = set()
    status = "unpublished"
    if canonicalize and records:
        conflicted = _fact_conflicts(records, persisted, source_id)
        for index in sorted(conflicted, reverse=True):
            rec = records.pop(index)
            uid = rec.row_uid
            row_map.pop(uid, None)
            quarantined.append({"row_uid": uid,
                                "row_content_fp": rec.content_fingerprint,
                                "reason": "conflict"})

    # --- key_map: declared keys → uid for surviving rows ---
    key_map: dict = {}
    if key_of:
        for pos, row in enumerate(rows):
            if assignments[pos] in row_map or any(
                    q["row_uid"] == assignments[pos] for q in quarantined):
                key_map[key_of(row["fields"])] = assignments[pos]

    revision = None
    if canonicalize and (row_map or quarantined):
        revision = build_revision({
            "source_id": source_id, "source_fingerprint": fp,
            "source_revision": source_revision,
            "scope_fingerprint": scope_fp,
            "model_version": MODEL_VERSION,
            "prompt_version": PROMPT_VERSION,
            "record_ids": [],
            "row_map": row_map, "key_map": key_map,
            "quarantined": quarantined,
            "expected_rev": expected_rev_id})
    revision_id = revision["active_revision"] if revision else ""
    ready_to_publish = bool(revision)
    published = ready_to_publish
    if checkpoint and canonicalize:
        progress["revision_id"] = revision_id
        progress["status"] = "unresolved"
        state[checkpoint_key] = progress
        _write_checkpoint(checkpoint, state)

    if apply:
        manifest_key = {"_id": "active:manifest"}
        raw_coll.create_index([("source_id", 1), ("fingerprint", 1)])
        records_coll.create_index("source_id")
        expected_raw: dict = {}
        for row in rows:
            raw_row = {k: row.get(k) for k in RAW_CONTENT_FIELDS}
            expected_raw[raw_row_id(row)] = {
                **row, "raw_row_json": canonical_json(raw_row),
                "active": False}
            validate_raw_row(expected_raw[raw_row_id(row)])
        _persist_immutable(raw_coll, expected_raw, RAW_AUDIT_FIELDS)
        _persist_immutable(records_coll, {
            record.record_id: record.to_dict() for record in records},
            RECORD_PROVENANCE_UNHASHED)
        if published:
            _persist_immutable(records_coll, {revision["_id"]: {
                key: value for key, value in revision.items()
                if key != "_id"}}, ("expected_rev",))
            pointer = {
                **{key: revision[key] for key in MANIFEST_POINTER_FIELDS
                   if key != "revision_id"},
                "revision_id": revision["_id"]}
            next_sources = {**expected_sources, item["id"]: pointer}
            next_manifest = {
                "sources": next_sources,
                "generation": fingerprint(next_sources),
                "schema_revision": SCHEMA_REVISION_V2,
            }
            load_active_state(records_coll, raw_coll,
                              {"_id": "active:manifest", **next_manifest})
            fence_generation = progress["expected_generation"]
            if fence_generation is None:
                try:
                    records_coll.update_one(
                        manifest_key, {"$setOnInsert": next_manifest},
                        upsert=True)
                except DuplicateKeyError:
                    pass
            else:
                records_coll.update_one(
                    {**manifest_key, "generation": fence_generation},
                    {"$set": {"sources": next_sources,
                              "generation": next_manifest["generation"]}},
                    upsert=False)
            current = records_coll.find_one(manifest_key)
            published = bool(
                current and current.get("sources", {}).get(item["id"]) == pointer)
            latest_docs = (load_active_state(records_coll, raw_coll, current)
                           if current else [])
            if not published and current:
                conflicted = _fact_conflicts(records, latest_docs, item["id"])
                if (not conflicted
                        and progress["expected_revision"] == expected_rev_id
                        and current["sources"].get(item["id"]) == expected_pointer):
                    next_sources = {**current["sources"], item["id"]: pointer}
                    load_active_state(records_coll, raw_coll, {
                        "_id": "active:manifest", "sources": next_sources,
                        "generation": fingerprint(next_sources),
                        "schema_revision": SCHEMA_REVISION_V2})
                    records_coll.update_one(
                        {**manifest_key, "generation": current["generation"]},
                        {"$set": {"sources": next_sources,
                                  "generation": fingerprint(next_sources)}},
                        upsert=False)
                    latest = records_coll.find_one(manifest_key)
                    if latest:
                        load_active_state(records_coll, raw_coll, latest)
                    published = bool(
                        latest and latest.get("sources", {}).get(item["id"]) == pointer)
        # --- registry final state: advance allocator, drop consumed staged ---
        if registry_coll is not None:
            reg_doc = registry_coll.find_one({"_id": _registry_id(item["id"])})
            if reg_doc is not None:
                staged_map = dict(reg_doc.get("staged") or {})
                if published:
                    staged_map.pop(importer_tag, None)
                else:
                    staged_map[importer_tag] = {
                        "file_fp": fp, "adds": adds,
                        "expected_rev": expected_rev_id,
                        "confirmations": sorted(confirmations)}
                registry_coll.update_one(
                    {"_id": _registry_id(item["id"])},
                    {"$set": {"uid_next": uid_next,
                              "staged": staged_map}})
        status = ("published" if published
                  else "cas_conflict" if ready_to_publish and apply
                  else "unpublished")
        if checkpoint and canonicalize:
            progress["status"] = "complete" if published else "unresolved"
            state[checkpoint_key] = progress
            _write_checkpoint(checkpoint, state)
        _write_log(log_coll, {"source_id": item["id"], "event": status,
                              "revision_id": revision["_id"]
                              if revision else None,
                              "file_fp": fp,
                              "detail": {"row_map": len(row_map),
                                         "quarantined": len(quarantined)}})

    return {
        "source_id": item["id"], "source_fingerprint": fp,
        "status": status if apply else "preview",
        "raw_count": len(rows), "record_count": len(records),
        "revision_id": revision_id, "published": bool(published and apply),
        "publication_conflict": bool(canonicalize and apply
                                     and ready_to_publish and not published),
        "row_map": {uid: sorted(m) for uid, m in row_map.items()},
        "quarantined": quarantined, "proposals": proposals,
        "diff": _diff_summary(assignments, prior_row_map, prior_uid_fp,
                              prior_quar, rows, row_map, quarantined),
        "readiness": ("conflicted" if conflicted else
                      "invalid" if any(q["reason"] == "invalid"
                                       for q in quarantined) else
                      "unresolved" if quarantined else
                      "resolved" if ready_to_publish else
                      "unresolved" if any(r.readiness == Readiness.UNRESOLVED
                                          for r in records) else "invalid"),
    }


def _diff_summary(assignments, prior_row_map, prior_uid_fp, prior_quar,
                  rows, row_map, quarantined) -> dict:
    summary = {"unchanged": [], "changed": [], "added": [],
               "deactivated": [], "retried": []}
    new_fps = {}
    for pos, row in enumerate(rows):
        new_fps[assignments[pos]] = _row_content_fp(
            sanitize_source_row(row))
    for uid in row_map:
        if uid not in prior_row_map:
            (summary["retried"] if uid in prior_quar
             else summary["added"]).append(uid)
        elif prior_uid_fp.get(uid) != new_fps.get(uid):
            summary["changed"].append(uid)
        else:
            summary["unchanged"].append(uid)
    summary["deactivated"] = sorted(set(prior_row_map) - set(row_map)
                                    - set(prior_quar)
                                    - {q["row_uid"] for q in quarantined})
    return {k: sorted(v) for k, v in summary.items()}


def _unique_json_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate snapshot key")
    return result


def import_snapshot(snapshot: str, raw_coll, records_coll) -> None:
    """Re-import a validated deterministic export without changing row bytes."""
    data = json.loads(snapshot, object_pairs_hook=_unique_json_pairs)
    if (not isinstance(data, dict)
            or data.get("schema_revision") not in (
                SCHEMA_REVISION, SCHEMA_REVISION_V2)
            or set(data) not in (
                {"schema_revision", "raw_rows"},
                {"schema_revision", "raw_rows", "records", "revisions",
                 "manifest"})):
        raise ValueError("malformed canonical snapshot")
    raw_rows = data["raw_rows"]
    record_rows = data.get("records", [])
    revision_rows = data.get("revisions", [])
    manifest = data.get("manifest")
    if not all(isinstance(group, list) and all(
            isinstance(row, dict) for row in group)
            for group in (raw_rows, record_rows, revision_rows)):
        raise ValueError("malformed canonical snapshot")
    try:
        for group in (raw_rows, record_rows, revision_rows):
            if len({row["_id"] for row in group}) != len(group):
                raise ValueError("duplicate identity or incompatible record schema")
        records = {r["record_id"]: r for r in record_rows}
        for row in raw_rows:
            validate_raw_row(row)
        index = index_raw_rows(raw_rows)
        for record in record_rows:
            validate_record_provenance(record, index)
        for revision in revision_rows:
            if (build_revision(revision) != revision or any(
                    records.get(rid, {}).get("source_id") != revision["source_id"]
                    for rid in revision["record_ids"])):
                raise ValueError("missing or incomplete canonical revision")
        if manifest is not None:
            validate_manifest(manifest)
            validate_manifest_records(
                manifest["sources"], revision_rows, record_rows, index)
        previous = records_coll.find_one({"_id": "active:manifest"})
        if previous and (manifest is None
                         or previous.get("generation") != manifest["generation"]):
            raise ValueError("existing active manifest conflict")
    except (KeyError, TypeError, AttributeError) as error:
        raise ValueError("malformed canonical snapshot") from error
    for coll, rows, audit in ((raw_coll, raw_rows, RAW_AUDIT_FIELDS),
                              (records_coll, record_rows,
                               RECORD_PROVENANCE_UNHASHED),
                              (records_coll, revision_rows, ("expected_rev",)),
                              (records_coll, [manifest] if manifest else [], ())):
        _persist_immutable(coll, {row["_id"]: {
            k: v for k, v in row.items() if k != "_id"} for row in rows}, audit)


def main() -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="อ่านเท่านั้น (default)")
    mode.add_argument("--apply", action="store_true", help="เขียน snapshot แบบ append-only")
    ap.add_argument("--canonicalize", action="store_true",
                    help="สกัด canonical records ด้วย Gemini structured JSON")
    ap.add_argument("--resume", type=Path, help="checkpoint ต่อ source fingerprint")
    ap.add_argument("--source", help="จำกัด source id")
    ap.add_argument("--dir", type=Path, default=EXPORT_DIR, help="โฟลเดอร์ kb-export")
    ap.add_argument("--confirm", action="append", default=[],
                    help="needs_confirm token จาก preview ล่าสุด (repeat ได้)")
    args = ap.parse_args()

    manifest = json.loads((args.dir / "knowledge-sources.json").read_text(encoding="utf-8"))
    items = [it for it in manifest["items"]
             if args.source is None or it["id"] == args.source]
    if args.source and not items:
        ap.error(f"source not found: {args.source}")
    files_dir = args.dir / "knowledge-files"
    # preview (--dry-run) reads active state too; import_source gates all
    # writes on apply — no write reaches Mongo without --apply
    client = _get_admin_db()
    try:
        db = client[ADMIN_DB_NAME] if client else None
        for item in items:
            result = import_source(
                item, files_dir, db[ZA_KB_RAW_COLL] if db is not None else None,
                db["zaapi_kb_records"] if db is not None else None,
                registry_coll=(db["zaapi_kb_source_registry"]
                               if db is not None else None),
                log_coll=(db["zaapi_kb_import_log"]
                          if db is not None else None),
                importer_tag="cli",
                confirm=frozenset(args.confirm),
                canonicalize=args.canonicalize, apply=args.apply,
                checkpoint=args.resume)
            print(canonical_json(result))
    finally:
        if client:
            client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
