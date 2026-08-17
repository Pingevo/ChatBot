"""ดึงข้อมูลจาก MongoDB แล้ว export เป็นไฟล์ JSON/CSV.

ค่าการเชื่อมต่ออ่านจาก environment (.env) ดู .env.example สำหรับรายการทั้งหมด.

Usage:
    python export_mongo.py
    python export_mongo.py --collection products --format csv
    python export_mongo.py --collection products --limit 100
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from bson import ObjectId  # type: ignore
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import PyMongoError


def _to_serializable(value: Any) -> Any:
    """แปลง BSON types ให้เป็น JSON-serializable."""
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [_to_serializable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_serializable(v) for k, v in value.items()}
    return value


def build_connection_string() -> str:
    """สร้าง mongodb URI จาก env vars.

    ถ้าตั้ง MONGO_URI ไว้จะใช้ค่านั้นโดยตรง (override ค่าอื่นทั้งหมด).
    """
    uri = os.environ.get("MONGO_URI", "").strip()
    if uri:
        return uri

    host = os.environ.get("MONGO_HOST", "").strip()
    if not host:
        raise SystemExit("ERROR: กรุณาตั้ง MONGO_URI หรือ MONGO_HOST ใน .env")

    user = os.environ.get("MONGO_USERNAME", "").strip()
    password = os.environ.get("MONGO_PASSWORD", "").strip()
    auth_source = os.environ.get("MONGO_AUTH_SOURCE", "admin").strip() or "admin"
    use_tls = os.environ.get("MONGO_TLS", "false").strip().lower() == "true"

    if user and password:
        creds = f"{user}:{password}@"
    elif user:
        creds = f"{user}@"
    else:
        creds = ""

    # ถ้า host ไม่มี scheme ให้เติมให้
    if "://" in host:
        return host

    scheme = "mongodb+srv" if host.endswith(".mongodb.net") else "mongodb"
    uri = f"{scheme}://{creds}{host}/?authSource={auth_source}"
    if use_tls:
        uri += "&tls=true"
    return uri


def get_client() -> MongoClient:
    uri = build_connection_string()
    try:
        client = MongoClient(uri, serverSelectionTimeoutMS=10000)
        # บังคับให้เชื่อมต่อจริงเพื่อตรวจ auth ทันที
        client.admin.command("ping")
        return client
    except PyMongoError as exc:
        raise SystemExit(f"ERROR: ไม่สามารถเชื่อมต่อ MongoDB ได้: {exc}")


def list_collections(db) -> list[str]:
    return sorted(db.list_collection_names())


def fetch_documents(collection, limit: int) -> Iterable[dict]:
    cursor = collection.find({})
    if limit and limit > 0:
        cursor = cursor.limit(limit)
    for doc in cursor:
        yield _to_serializable(doc)


def export_json(collection_name: str, docs: list[dict], export_dir: Path) -> Path:
    out = export_dir / f"{collection_name}.export.json"
    with out.open("w", encoding="utf-8") as f:
        json.dump(docs, f, ensure_ascii=False, indent=2, default=str)
    return out


def export_csv(collection_name: str, docs: list[dict], export_dir: Path) -> Path:
    out = export_dir / f"{collection_name}.export.csv"
    if not docs:
        out.write_text("", encoding="utf-8")
        return out

    # รวม keys จากทุก doc
    fieldnames: list[str] = []
    seen: set[str] = set()
    for d in docs:
        for k in d.keys():
            if k not in seen:
                seen.add(k)
                fieldnames.append(k)

    with out.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for d in docs:
            row = {k: (json.dumps(v, ensure_ascii=False, default=str) if isinstance(v, (dict, list)) else v)
                   for k, v in d.items()}
            writer.writerow(row)
    return out


def export_collection(db, collection_name: str, fmt: str, limit: int, export_dir: Path) -> tuple[Path, int]:
    collection = db[collection_name]
    docs = list(fetch_documents(collection, limit))
    if fmt.lower() == "csv":
        out = export_csv(collection_name, docs, export_dir)
    else:
        out = export_json(collection_name, docs, export_dir)
    return out, len(docs)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export MongoDB data to JSON/CSV files.")
    parser.add_argument("--collection", default=os.environ.get("MONGO_COLLECTION", "").strip(),
                        help="collection ที่จะดึง (เว้นว่าง = ดึงทุก collection)")
    parser.add_argument("--format", choices=["json", "csv"],
                        default=os.environ.get("EXPORT_FORMAT", "json").strip().lower(),
                        help="รูปแบบไฟล์ export")
    parser.add_argument("--limit", type=int,
                        default=int(os.environ.get("EXPORT_LIMIT", "0") or 0),
                        help="จำกัดจำนวนเอกสาร (0 = ไม่จำกัด)")
    parser.add_argument("--out", default=os.environ.get("EXPORT_DIR", "exports").strip(),
                        help="โฟลเดอร์เก็บไฟล์ export")
    args = parser.parse_args()

    load_dotenv()
    # re-read หลัก load_dotenv เผื่อ env ยังไม่ถูกโหลดตอน argparse default
    if not args.collection:
        args.collection = os.environ.get("MONGO_COLLECTION", "").strip()
    if not args.out:
        args.out = "exports"
    if not args.limit:
        args.limit = int(os.environ.get("EXPORT_LIMIT", "0") or 0)

    export_dir = Path(args.out)
    export_dir.mkdir(parents=True, exist_ok=True)

    client = get_client()
    db_name = os.environ.get("MONGO_DB", "").strip()
    if not db_name:
        raise SystemExit("ERROR: MONGO_DB ไม่ถูกตั้งใน .env")
    db = client[db_name]

    if args.collection:
        collections = [args.collection]
    else:
        collections = list_collections(db)
        if not collections:
            print(f"DB '{db_name}' ไม่มี collection ใดๆ")
            return 0

    print(f"เชื่อมต่อแล้ว: db={db_name} | collections={len(collections)} | format={args.format} | limit={args.limit or 'ALL'}")
    total = 0
    for name in collections:
        try:
            out, count = export_collection(db, name, args.format, args.limit, export_dir)
            total += count
            print(f"  - {name}: {count} docs -> {out}")
        except PyMongoError as exc:
            print(f"  ! {name}: ล้มเหลว ({exc})", file=sys.stderr)

    print(f"เสร็จสิ้น รวม {total} เอกสาร -> {export_dir.resolve()}")
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
