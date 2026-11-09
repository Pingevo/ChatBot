#!/usr/bin/env python3
"""k2_bulk_apply.py — bulk apply Zaapi KB files per admin mapping.

อ่าน mapping JSON (จาก k2-mapping-workbench export) → apply_import ทีละไฟล์
(staged rev → CAS publish triple ตาม contract เดิม) → รายงานผลต่อไฟล์

usage:
  python k2_bulk_apply.py --mapping <mapping.json> [--dry-run] [--only N|file]
env: ADMIN_MONGO_URI / ADMIN_MONGO_DB (โหลด .env ของ repo root อัตโนมัติ)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT / "chatbot"))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from pymongo import MongoClient  # noqa: E402
from shopeechat import kb_zaapi_files as zkf  # noqa: E402

FILES_DIR = ROOT / "docs/zaapi/kb-export/knowledge-files"


def _db():
    uri = os.environ.get("ADMIN_MONGO_URI") or os.environ.get("MONGO_URI")
    dbn = os.environ.get("ADMIN_MONGO_DB") or os.environ.get("MONGO_DB")
    if not uri or not dbn:
        raise SystemExit("missing ADMIN_MONGO_URI/ADMIN_MONGO_DB")
    return MongoClient(uri, serverSelectionTimeoutMS=10000)[dbn]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mapping", default=None,
                    help="mapping JSON file — ละเว้น = อ่านจาก Mongo zaapi_kb_mappings")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default=None,
                    help="จำนวนไฟล์แรก หรือชื่อไฟล์เดียว")
    args = ap.parse_args()

    db = _db()
    if args.mapping:
        mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
    else:
        saved = {d["_id"]: d for d in db["zaapi_kb_mappings"].find({})}
        manifest = json.loads(
            (ROOT / "ChatAdminWeb/data/zaapi-kb-files-manifest.json")
            .read_text(encoding="utf-8"))
        mapping = []
        skipped = []
        for f in manifest["files"]:
            m = saved.get(f["file"])
            if not m:
                skipped.append(f["file"]); continue
            mapping.append({
                "file": f["file"],
                "accounts": m.get("accounts") or [],
                "platforms": m.get("platforms") or ["shopee"],
                "content_type": m.get("content_type"),
                "sheet_types": m.get("sheet_types") or {},
            })
        if skipped:
            print(f"{len(skipped)} files unmapped — skipped:")
            for s in skipped:
                print(f"  - {s}")
    if args.only and args.only.isdigit():
        mapping = mapping[: int(args.only)]
    elif args.only:
        mapping = [m for m in mapping if m["file"] == args.only]
        if not mapping:
            raise SystemExit(f"not in mapping: {args.only}")

    results = []
    for m in mapping:
        fn = m["file"]
        path = FILES_DIR / fn
        if not path.is_file():
            results.append({"file": fn, "ok": False, "err": "file missing"})
            continue
        data = path.read_bytes()
        kw = dict(filename=fn, data=data,
                  accounts=m.get("accounts") or (),
                  platforms=m.get("platforms") or (),
                  content_type=m.get("content_type"),
                  sheet_types=m.get("sheet_types") or None)
        try:
            if args.dry_run:
                r = zkf.preview_import(db, **kw)
                results.append({"file": fn, "ok": True, "preview": {
                    "new_rows": r["new_rows"], "untyped": r["untyped_rows"],
                    "sheets": r["sheets"]}})
            else:
                r = zkf.apply_import(db, admin="k2-import", **kw)
                results.append({"file": fn, "ok": True, "applied": r})
                print(f"OK {fn}: rows={r.get('inserted')} rev={r.get('rev')}")
        except Exception as e:
            results.append({"file": fn, "ok": False, "err": str(e)[:200]})
            print(f"FAIL {fn}: {e}", file=sys.stderr)
        time.sleep(0.05)

    ok = sum(1 for r in results if r["ok"])
    print(f"\n{ok}/{len(results)} files {'previewed' if args.dry_run else 'applied'}")
    report = ROOT / "docs/test/results/k2_bulk_apply.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    print("report:", report)
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
