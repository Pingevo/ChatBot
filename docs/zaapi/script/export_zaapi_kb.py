"""Deterministic Zaapi raw/canonical snapshot export (read-only)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT / "chatbot"))
from shopeechat.kb_zaapi_schema import (  # noqa: E402
    RAW_CONTENT_FIELDS, RAW_STORAGE_FIELDS, SCHEMA_REVISION, account_scope_fingerprint,
    build_revision, canonical_json, fingerprint,
    index_raw_rows, raw_row_id, sanitize_source_row, validate_manifest,
    validate_record_provenance, validate_raw_row,
)
from import_zaapi_kb import load_active_state  # noqa: E402


def export_snapshot(raw_coll, records_coll, *, source_id: str | None = None,
                    raw_only: bool = False) -> str:
    """Export validated source rows and canonical revisions deterministically."""
    query = {} if source_id is None else {"source_id": source_id}
    index = index_raw_rows(raw_coll.find(query))
    raw_rows = []
    for row in [row for groups in index.values()
                for pairs in groups.values() for row, _ in pairs]:
        sanitized = sanitize_source_row(row)
        raw_row = {k: row.get(k) for k in RAW_CONTENT_FIELDS}
        raw_row["fields"], raw_row["text"] = (
            sanitized["fields"], sanitized["text"])
        safe = {k: row.get(k) for k in RAW_STORAGE_FIELDS}
        safe["accounts"] = sanitized["accounts"]
        safe["scope_fingerprint"] = account_scope_fingerprint(safe["accounts"])
        safe["fields"], safe["text"] = (
            sanitized["fields"], sanitized["text"])
        safe["raw_row_json"] = canonical_json(raw_row)
        safe["_id"] = raw_row_id(safe)
        validate_raw_row(safe)
        raw_rows.append(safe)
    raw_rows.sort(key=lambda row: row["_id"])
    data = {"schema_revision": SCHEMA_REVISION, "raw_rows": raw_rows}
    if not raw_only:
        manifest = records_coll.find_one({"_id": "active:manifest"})
        if manifest:
            load_active_state(records_coll, raw_coll, manifest)
        selected, revisions = [], []
        for doc in records_coll.find(query):
            if doc.get("_id") == "active:manifest":
                continue
            if str(doc.get("_id")).startswith("revision:"):
                if build_revision(doc) != doc:
                    raise ValueError("revision schema mismatch")
                revisions.append(doc)
            else:
                validate_record_provenance(doc, index)
                selected.append(doc)
        record_ids = {r["record_id"] for r in selected}
        if any(rid not in record_ids
               for revision in revisions for rid in revision["record_ids"]):
            raise ValueError("missing or incomplete canonical revision")
        data["records"] = sorted(selected, key=lambda r: r["_id"])
        data["revisions"] = sorted(revisions, key=lambda r: r["_id"])
        if manifest and source_id is not None:
            selected_sources = {source_id: manifest["sources"][source_id]} if (
                source_id in manifest["sources"]) else {}
            manifest = {
                "_id": "active:manifest", "schema_revision": SCHEMA_REVISION,
                "sources": selected_sources,
                "generation": fingerprint(selected_sources),
            } if selected_sources else None
            if manifest:
                validate_manifest(manifest)
        data["manifest"] = manifest
    return canonical_json(data)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="source id filter")
    ap.add_argument("--raw", action="store_true", help="raw rows only")
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()

    from import_zaapi_kb import ADMIN_DB_NAME, ZA_KB_RAW_COLL, _get_admin_db
    client = _get_admin_db()
    try:
        db = client[ADMIN_DB_NAME]
        snapshot = export_snapshot(db[ZA_KB_RAW_COLL], db["zaapi_kb_records"],
                                   source_id=args.source, raw_only=args.raw)
        args.output.write_text(snapshot + "\n", encoding="utf-8")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
