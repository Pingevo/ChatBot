"""Import exports/sellable_units.jsonl → admin DB collection `sellable_units`.

รันหลัง build_sellable_units.py — upsert keyed by unit_id (รันซ้ำได้)
สร้าง indexes: unit_id(unique), model_codes, item_id, sellable, shop, product_type

วิธีใช้:
    .venv/bin/python chatbot/shopeechat/scripts/import_sellable_units.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat.knowledge_base import _build_admin_client  # noqa: E402

UNITS_PATH = ROOT / "exports" / "sellable_units.jsonl"
COLL = "sellable_units"


def main() -> int:
    import os
    db_name = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
    db = _build_admin_client()[db_name]
    coll = db[COLL]

    units = [json.loads(l) for l in open(UNITS_PATH, encoding="utf-8")]
    ins = upd = 0
    for u in units:
        r = coll.replace_one({"unit_id": u["unit_id"]}, u, upsert=True)
        ins += 1 if r.upserted_id else 0
        upd += 0 if r.upserted_id else 1

    for spec in (
        [("unit_id", 1)], [("model_codes", 1)], [("item_id", 1)],
        [("sellable", 1)], [("shop", 1)], [("product_type", 1)],
    ):
        coll.create_index(spec)

    print(f"imported → {db_name}.{COLL}: inserted={ins} updated={upd} total={coll.count_documents({})}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
