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
    SCHEMA_REVISION, ZaapiKnowledgeRecord, account_scope_fingerprint,
    build_revision, canonical_json, canonical_record_id, fingerprint,
    index_raw_rows, load_active_state, raw_row_id, sanitize_source_row,
    validate_manifest, validate_manifest_records, validate_record_provenance,
    validate_raw_row,
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
        if audit:
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


def import_source(
    item: dict, files_dir: Path, raw_coll, records_coll, *,
    extractor=None, canonicalize: bool = False, apply: bool = False,
    checkpoint: Path | None = None,
) -> dict:
    """Store raw snapshots separately; publish canonical revision atomically by pointer."""
    if not isinstance(item.get("id"), str) or not item["id"].strip():
        raise ValueError("missing source_id")
    rows = _build_docs(item, files_dir, "canonical-v1")
    fp = rows[0]["fingerprint"] if rows else _sha256(
        files_dir / item["downloaded_file"]["file"])
    source_revision = (item.get("version") or {}).get("versionId", "")
    scope_fp = account_scope_fingerprint(item.get("accounts") or [])
    manifest_key = {"_id": "active:manifest"}
    expected_manifest = (records_coll.find_one(manifest_key)
                         if canonicalize and apply else None)
    persisted: list[dict] = []
    if expected_manifest:
        persisted = load_active_state(records_coll, raw_coll, expected_manifest)
    expected_sources = expected_manifest["sources"] if expected_manifest else {}
    expected_pointer = expected_sources.get(item["id"])
    checkpoint_key = fingerprint((
        item["id"], fp, source_revision, scope_fp, MODEL_VERSION, PROMPT_VERSION))
    state = (json.loads(checkpoint.read_text(encoding="utf-8"))
             if checkpoint and checkpoint.exists() else {})
    if not isinstance(state, dict):
        raise ValueError("invalid checkpoint")
    progress = state[checkpoint_key] if checkpoint_key in state else {
        "source_id": item["id"], "source_fingerprint": fp,
        "source_revision": source_revision, "scope_fingerprint": scope_fp,
        "model_version": MODEL_VERSION,
        "prompt_version": PROMPT_VERSION, "status": "unresolved", "rows": {},
        "expected_revision": (expected_pointer["active_revision"]
                              if expected_pointer else None),
        "expected_generation": (expected_manifest["generation"]
                                if expected_manifest else None),
    }
    if not isinstance(progress, dict) or not isinstance(progress.get("rows"), dict):
        raise ValueError("invalid checkpoint rows")
    if "expected_revision" not in progress:
        raise ValueError("missing checkpoint publication fence")
    if "expected_generation" not in progress:
        raise ValueError("missing checkpoint manifest fence")
    if any(progress.get(key) != value for key, value in (
            ("source_id", item["id"]), ("source_fingerprint", fp),
            ("source_revision", source_revision), ("scope_fingerprint", scope_fp),
            ("model_version", MODEL_VERSION), ("prompt_version", PROMPT_VERSION))):
        raise ValueError("checkpoint metadata mismatch")
    if expected_pointer and all((
            expected_pointer.get("source_fingerprint") == fp,
            expected_pointer.get("scope_fingerprint") == scope_fp,
            expected_pointer.get("source_revision") == source_revision,
            expected_pointer.get("model_version") == MODEL_VERSION,
            expected_pointer.get("prompt_version") == PROMPT_VERSION)):
        if checkpoint and progress.get("status") != "complete":
            progress["status"] = "complete"
            progress["revision_id"] = expected_pointer["active_revision"]
            state[checkpoint_key] = progress
            _write_checkpoint(checkpoint, state)
        return {
            "source_id": item["id"], "source_fingerprint": fp,
            "raw_count": len(rows), "record_count": expected_pointer["record_count"],
            "revision_id": expected_pointer["active_revision"],
            "published": True, "readiness": "resolved",
        }
    records: list[ZaapiKnowledgeRecord] = []
    conflicted: set[int] = set()
    if canonicalize:
        for row in rows:
            safe_row = sanitize_source_row(row)
            row_fp = fingerprint({key: safe_row.get(key) for key in RAW_CONTENT_FIELDS})
            accounts = safe_row["accounts"] or [{}]
            output = progress["rows"].get(row_fp) if checkpoint else None
            prepared = None
            if output is not None:
                prepared = [ZaapiKnowledgeRecord.from_extraction(
                    safe_row, output, shop=account.get("name", ""),
                    platform=account.get("platform", ""),
                    model_version=MODEL_VERSION, prompt_version=PROMPT_VERSION)
                    for account in accounts]
                if not all(r.readiness == Readiness.RESOLVED for r in prepared):
                    prepared = None
            if prepared is None:
                try:
                    output = (extractor or _gemini_extract)(safe_row)
                    failed = False
                except Exception:
                    output, failed = {}, True
                prepared = [ZaapiKnowledgeRecord.from_extraction(
                    safe_row, output, shop=account.get("name", ""),
                    platform=account.get("platform", ""),
                    model_version=MODEL_VERSION, prompt_version=PROMPT_VERSION,
                    failed=failed) for account in accounts]
                if checkpoint and all(
                        r.readiness == Readiness.RESOLVED for r in prepared):
                    progress["rows"][row_fp] = output
                    state[checkpoint_key] = progress
                    _write_checkpoint(checkpoint, state)
            records.extend(prepared)

        conflicted = _fact_conflicts(records, persisted, item["id"])
        for index in conflicted:
            updated = replace(records[index], readiness=Readiness.CONFLICTED)
            records[index] = replace(updated, record_id=canonical_record_id({
                k: v for k, v in updated.to_dict().items() if k != "record_id"}))

    revision = build_revision({
        "source_id": item["id"], "source_fingerprint": fp,
        "source_revision": source_revision, "scope_fingerprint": scope_fp,
        "model_version": MODEL_VERSION, "prompt_version": PROMPT_VERSION,
        "record_ids": [r.record_id for r in records]}) if records else None
    revision_id = revision["active_revision"] if revision else ""
    ready_to_publish = bool(records) and all(
        r.readiness == Readiness.RESOLVED for r in records)
    published = ready_to_publish
    if checkpoint and canonicalize:
        progress["revision_id"] = revision_id
        progress["status"] = "complete" if published else "unresolved"
        state[checkpoint_key] = progress
        _write_checkpoint(checkpoint, state)
    if apply:
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
            record.record_id: record.to_dict() for record in records})
        if published:
            _persist_immutable(records_coll, {revision["_id"]: {
                key: value for key, value in revision.items()
                if key != "_id"}})
            pointer = {
                **{key: revision[key] for key in MANIFEST_POINTER_FIELDS
                   if key != "revision_id"},
                "revision_id": revision["_id"]}
            next_sources = {**expected_sources, item["id"]: pointer}
            next_manifest = {
                "sources": next_sources,
                "generation": fingerprint(next_sources),
                "schema_revision": SCHEMA_REVISION,
            }
            load_active_state(records_coll, raw_coll,
                              {"_id": "active:manifest", **next_manifest})
            fence_generation = progress["expected_generation"]
            if fence_generation is None and expected_manifest is None:
                try:
                    records_coll.update_one(
                        manifest_key, {"$setOnInsert": next_manifest},
                        upsert=True)
                except DuplicateKeyError:
                    pass
            elif fence_generation is not None:
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
                        and progress["expected_revision"] ==
                        (expected_pointer["active_revision"]
                         if expected_pointer else None)
                        and current["sources"].get(item["id"]) == expected_pointer):
                    next_sources = {**current["sources"], item["id"]: pointer}
                    load_active_state(records_coll, raw_coll, {
                        "_id": "active:manifest", "sources": next_sources,
                        "generation": fingerprint(next_sources),
                        "schema_revision": SCHEMA_REVISION})
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

    return {
        "source_id": item["id"], "source_fingerprint": fp,
        "raw_count": len(rows), "record_count": len(records),
        "revision_id": revision_id, "published": bool(published and apply),
        "publication_conflict": bool(canonicalize and apply
                                     and ready_to_publish and not published),
        "readiness": ("conflicted" if conflicted else
                      "resolved" if ready_to_publish else
                      "unresolved" if any(r.readiness == Readiness.UNRESOLVED
                                          for r in records) else "invalid"),
    }


def _unique_json_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate snapshot key")
    return result


def import_snapshot(snapshot: str, raw_coll, records_coll) -> None:
    """Re-import a validated deterministic export without changing row bytes."""
    data = json.loads(snapshot, object_pairs_hook=_unique_json_pairs)
    if (not isinstance(data, dict) or data.get("schema_revision") != SCHEMA_REVISION
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
                              (records_coll, record_rows, ()),
                              (records_coll, revision_rows, ()),
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
    args = ap.parse_args()

    manifest = json.loads((args.dir / "knowledge-sources.json").read_text(encoding="utf-8"))
    items = [it for it in manifest["items"]
             if args.source is None or it["id"] == args.source]
    if args.source and not items:
        ap.error(f"source not found: {args.source}")
    files_dir = args.dir / "knowledge-files"
    client = _get_admin_db() if args.apply else None
    try:
        db = client[ADMIN_DB_NAME] if client else None
        for item in items:
            result = import_source(
                item, files_dir, db[ZA_KB_RAW_COLL] if db else None,
                db["zaapi_kb_records"] if db else None,
                canonicalize=args.canonicalize, apply=args.apply,
                checkpoint=args.resume)
            print(canonical_json(result))
    finally:
        if client:
            client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
