"""inspect_stock_certs.py — สำรวจ stock DB (STOCK_URI/STOCK_DB) หา cert fields.

read-only เท่านั้น — list collections, sample schema, นับ is_tis/is_ce/is_ccc,
และเดา join key กับ ShpProducts (item_id / model / sku)

รัน: .venv/bin/python chatbot/shopeechat/scripts/inspect_stock_certs.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import knowledge_base  # noqa: E402,F401 — _load_env() รันตอน import

_CERT_FIELDS = ("tis_id", "is_tis", "tis_license_id", "is_ccc", "is_ce")


def main() -> None:
    from pymongo import MongoClient

    uri = os.environ.get("STOCK_URI")
    db_name = os.environ.get("STOCK_DB")
    if not uri or not db_name:
        sys.exit("STOCK_URI / STOCK_DB ไม่ได้ตั้งใน .env")

    db = MongoClient(uri, serverSelectionTimeoutMS=5000)[db_name]
    colls = db.list_collection_names()
    print(f"db={db_name} collections={len(colls)}: {colls}\n")

    for name in colls:
        coll = db[name]
        n = coll.estimated_document_count()
        sample = list(coll.find({}, limit=3))
        if not sample:
            print(f"── {name} (0 docs, skip)")
            continue
        keys = sorted({k for d in sample for k in d})
        has_cert = [f for f in _CERT_FIELDS if f in keys]
        print(f"── {name} (~{n} docs)")
        print(f"   keys: {keys}")
        if has_cert:
            print(f"   CERT FIELDS: {has_cert}")
            for f in _CERT_FIELDS:
                if f in keys:
                    cnt = coll.count_documents({f: {"$exists": True, "$nin": [None, "", False]}})
                    print(f"   {f}: {cnt} docs non-empty")
            ex = coll.find_one({"is_tis": True}) or sample[0]
            slim = {k: v for k, v in ex.items() if k != "_id"}
            print(f"   example: {slim}")
        print()


if __name__ == "__main__":
    main()
