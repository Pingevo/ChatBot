"""Import gen_dir/sellable_units.jsonl → admin DB `sellable_units_g<gid>`.

collection เป็น per-generation (immutable หลัง validation — runtime อ่านผ่าน
pointer เท่านั้น; ไม่มี base-collection writer อีกต่อไป)
indexes: unit_id(unique), model_codes, item_id, sellable, shop, product_type

วิธีใช้:
    .venv/bin/python chatbot/shopeechat/scripts/import_sellable_units.py \
        --gen-dir exports/gen/<gid> --gid <gid>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

_INDEXES = (
    [("unit_id", 1)], [("model_codes", 1)], [("item_id", 1)],
    [("sellable", 1)], [("shop", 1)], [("product_type", 1)],
)


def import_units(db, coll_name: str, units_jsonl: Path) -> int:
    """jsonl → coll_name — fresh generation coll: drop stale staging ก่อน
    แล้ว bulk insert (per-gid collection ไม่ควรมีอยู่แล้ว — มี = รอบเดิมค้าง)"""
    units = [json.loads(l) for l in open(units_jsonl, encoding="utf-8")]
    if coll_name in db.list_collection_names():
        db.drop_collection(coll_name)
    coll = db[coll_name]
    if units:
        coll.insert_many(units)
    for spec in _INDEXES:
        coll.create_index(spec)
    print(f"imported → {coll_name}: total={coll.count_documents({})}")
    return len(units)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gen-dir", type=Path, required=True)
    ap.add_argument("--gid", required=True)
    args = ap.parse_args()
    from chatbot.shopeechat.knowledge_base import _admin_db  # noqa: E402
    import_units(_admin_db(), f"sellable_units_{args.gid}",
                 Path(args.gen_dir) / "sellable_units.jsonl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
