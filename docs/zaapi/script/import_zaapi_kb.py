# -*- coding: utf-8 -*-
"""Import Zaapi Knowledge Base export เข้า admin DB (collection `zaapi_kb`).

วิธีใช้:
    .venv/bin/python docs/zaapi/script/import_zaapi_kb.py --dry-run
    .venv/bin/python docs/zaapi/script/import_zaapi_kb.py
    .venv/bin/python docs/zaapi/script/import_zaapi_kb.py --reset

ข้อมูล:
    input  = docs/zaapi/kb-export/ (knowledge-sources.json + knowledge-files/*)
    output = ADMIN_MONGO_*.zaapi_kb — doc ต่อ row (xlsx) / ต่อไฟล์ (txt)

Idempotent: fingerprint = sha256 ของไฟล์ใน manifest — ไฟล์ไม่เปลี่ยน → skip,
เปลี่ยน → replace docs ของ source นั้น, ไม่มีใน export → deactivate (active=false)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from openpyxl.worksheet.hyperlink import Hyperlink as _OxlHyperlink
from dotenv import load_dotenv

# openpyxl 3.1.5 parse hyperlink 'address' attribute (OOXML ใหม่) ไม่ได้ → drop kwarg ก่อน parse
_hl_init = _OxlHyperlink.__init__
def _hl_init_compat(self, *a, **kw):
    kw.pop("address", None)
    _hl_init(self, *a, **kw)
_OxlHyperlink.__init__ = _hl_init_compat
from pymongo import MongoClient

ROOT = Path(__file__).resolve().parent.parent.parent.parent
load_dotenv(ROOT / ".env")

EXPORT_DIR = Path(__file__).resolve().parent.parent / "kb-export"
ADMIN_DB_NAME = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
ZA_KB_COLL = os.environ.get("ADMIN_MONGO_COLLECTION_ZAAPI_KB", "zaapi_kb").strip()


def _get_admin_db() -> "MongoClient":
    """เชื่อม DB admin โดยใช้ค่าจาก .env (pattern เดียวกับ import_adminbase.py)."""
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
        for idx, row in enumerate(rows):
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
                "fields": fields,
                "text": "\n".join(f"{k}: {v}" for k, v in fields.items()),
            })
    wb.close()
    return docs


def _txt_doc(item: dict, path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    return [{"kind": "text", "sheet": None, "row_index": 0, "fields": {}, "text": text}] if text else []


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _build_docs(item: dict, files_dir: Path, batch: str) -> list[dict]:
    df = item.get("downloaded_file") or {}
    path = files_dir / df.get("file", "")
    if not path.is_file():
        print(f"  !! missing file: {item['name'][:60]} -> {path.name}")
        return []
    fp = _sha256(path)
    if df.get("sha256") and fp != df["sha256"]:
        print(f"  !! sha256 mismatch: {path.name} (manifest {df['sha256'][:12]} != {fp[:12]})")
    ver = item.get("version") or {}
    base = {
        "source_id": item["id"],
        "source_name": item.get("name", ""),
        "version_id": ver.get("versionId", ""),
        "source_type": ver.get("type", "file"),
        "accounts": [
            {"id": a.get("id", ""), "platform": a.get("platform", ""), "name": a.get("name", "")}
            for a in item.get("accounts", [])
        ],
        "fingerprint": fp,
        "active": True,
        "import_batch": batch,
        "zaapi_updated_at": item.get("updated_at", ""),
        "imported_at": datetime.now(timezone.utc).isoformat(),
    }
    rows = _xlsx_docs(item, path) if path.suffix.lower() == ".xlsx" else _txt_doc(item, path)
    return [{**base, **r} for r in rows]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="อ่าน+แปลง แต่ไม่เขียน DB")
    ap.add_argument("--reset", action="store_true", help="ลบ zaapi_kb ทั้งหมดก่อน import")
    ap.add_argument("--dir", type=Path, default=EXPORT_DIR, help="โฟลเดอร์ kb-export")
    args = ap.parse_args()

    manifest = json.loads((args.dir / "knowledge-sources.json").read_text(encoding="utf-8"))
    items = manifest["items"]
    files_dir = args.dir / "knowledge-files"
    batch = f"imp-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"

    stats = {"sources": 0, "docs": 0, "skipped": 0, "deactivated": 0, "missing": 0}
    existing: dict[str, str] = {}
    coll = None
    if not args.dry_run:
        coll = _get_admin_db()[ADMIN_DB_NAME][ZA_KB_COLL]
        if args.reset:
            n = coll.delete_many({}).deleted_count
            print(f"reset: deleted {n} docs")
        coll.create_index("source_id")
        coll.create_index("fingerprint")
        coll.create_index("accounts.id")
        coll.create_index([("text", "text")], default_language="none")
        for d in coll.find({}, {"source_id": 1, "fingerprint": 1}):
            existing.setdefault(d["source_id"], d.get("fingerprint", ""))

    seen_sources: set[str] = set()
    for it in items:
        sid = it["id"]
        seen_sources.add(sid)
        want_fp = (it.get("downloaded_file") or {}).get("sha256", "")
        if existing.get(sid) == want_fp and want_fp:
            stats["skipped"] += 1
            continue
        docs = _build_docs(it, files_dir, batch)
        if not docs:
            stats["missing"] += 1
            continue
        stats["sources"] += 1
        stats["docs"] += len(docs)
        if coll is not None:
            # manual_edit=True = doc ที่แอดมินแก้ผ่าน UI — importer ห้ามทับ/ลบ
            coll.delete_many({"source_id": sid, "manual_edit": {"$ne": True}})
            coll.insert_many(docs)

    if coll is not None:
        stats["deactivated"] = coll.update_many(
            {"source_id": {"$nin": list(seen_sources)}, "active": True},
            {"$set": {"active": False, "import_batch": batch}},
        ).modified_count

    print(f"batch={batch} sources_updated={stats['sources']} docs={stats['docs']} "
          f"skipped_unchanged={stats['skipped']} missing={stats['missing']} "
          f"deactivated={stats['deactivated']} dry_run={args.dry_run}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
