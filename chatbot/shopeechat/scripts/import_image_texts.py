"""import_image_texts.py — upsert exports/image_texts.jsonl → admin DB `image_texts`.

image_id เป็น key เดียว (dedupe), เก็บล่าสุด status=ok เท่านั้น — rerun ได้เรื่อยๆ
ตอน batch ยังไม่จบ (idempotent)

รัน: .venv/bin/python chatbot/shopeechat/scripts/import_image_texts.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat import knowledge_base  # noqa: E402


def main() -> None:
    knowledge_base._load_env()
    import os
    from pymongo import UpdateOne
    db = knowledge_base._build_admin_client()[os.environ.get("ADMIN_MONGO_DB", "chatbot_admin")]
    coll = db["image_texts"]
    coll.create_index("image_id", unique=True)

    best: dict[str, dict] = {}
    for line in (ROOT / "exports" / "image_texts.jsonl").open():
        e = json.loads(line)
        iid = e.get("image_id")
        if not iid or e.get("status") != "ok":
            continue
        prev = best.get(iid)
        if prev is None or e.get("ts", 0) > prev.get("ts", 0):
            best[iid] = e

    ops = [
        UpdateOne({"image_id": iid}, {"$set": {
            "image_id": iid,
            "image_url": e.get("image_url"),
            "kind": e.get("kind"),
            "text": e.get("text"),
            "truncated": e.get("truncated"),
            "model": e.get("model"),
            "ts": e.get("ts"),
        }}, upsert=True)
        for iid, e in best.items()
    ]
    res = coll.bulk_write(ops) if ops else None
    kinds: dict[str, int] = {}
    for e in best.values():
        kinds[e.get("kind") or "?"] = kinds.get(e.get("kind") or "?", 0) + 1
    print(f"image_texts: {len(best)} unique ok → upserted "
          f"({res.upserted_count if res else 0} new, {res.modified_count if res else 0} updated)")
    print("kinds:", kinds)


if __name__ == "__main__":
    main()
