"""import_image_texts.py — materialize published OCR evidence ของ generation.

gen_dir/image_texts.jsonl → `image_texts_g<gid>` (immutable หลัง validation —
runtime readers อ่านผ่าน snapshot เท่านั้น; shared `image_texts` เป็น OCR cache
ที่ build_image_texts เขียนระหว่าง build — module นี้ไม่แตะมัน)

รัน: .venv/bin/python chatbot/shopeechat/scripts/import_image_texts.py \
        --gen-dir exports/gen/<gid> --gid <gid>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "chatbot"))
sys.path.insert(0, str(ROOT))


def materialize_published(db, gid: str, gen_dir: Path) -> int:
    """เขียน evidence file → image_texts_g<gid> — คืนจำนวน docs ที่ publish.

    collection เป็น per-generation (fresh ทุก gid) — drop ก่อนเผื่อ staging
    รอบเดิมค้าง; docs คือ snapshot ของ evidence file — cache mutate ภายหลัง
    ไม่กระทบ generation นี้
    """
    ev_path = Path(gen_dir) / "image_texts.jsonl"
    docs = ([json.loads(l) for l in ev_path.open(encoding="utf-8")]
            if ev_path.exists() else [])
    name = f"image_texts_{gid}"
    if name in db.list_collection_names():
        db.drop_collection(name)          # stale staging รอบเดิม (gid collision เท่านั้น)
    coll = db[name]
    if docs:
        coll.insert_many(docs)
    coll.create_index("image_id", unique=True)
    coll.create_index("item_ids")
    return len(docs)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gen-dir", type=Path, required=True)
    ap.add_argument("--gid", required=True)
    args = ap.parse_args()
    from chatbot.shopeechat import knowledge_base  # noqa: E402
    knowledge_base._load_env()
    db = knowledge_base._admin_db()
    n = materialize_published(db, args.gid, args.gen_dir)
    print(f"published image_texts_{args.gid}: {n} docs")


if __name__ == "__main__":
    main()
