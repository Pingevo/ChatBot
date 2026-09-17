"""Script embed สินค้าทั้งหมดจาก export JSON เป็น vector แล้วเก็บลงไฟล์.

วิธีใช้:
    .venv/bin/python scripts/build_embeddings.py            # listing-level (เดิม)
    .venv/bin/python scripts/build_embeddings.py --units    # unit-level จาก sellable_units.jsonl

ผลลัพธ์:
    exports/product_embeddings.npz  — numpy archive เก็บ (ids, embeddings, texts)
    ใช้สำหรับ similarity search ใน product_store.py
    exports/unit_embeddings.npz (--units) — เพิ่ม unit_ids/model_ids ต่อ row

หลังจากนี้ถ้าต้องการ sync ลง MongoDB field `embedding` ก็ทำได้ทีหลัง
แต่ตอนนี้เก็บในไฟล์ก่อนเพื่อความเร็วในการทดสอบ.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# ทำให้ import chatbot.shopeechat.* ได้
ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np

from chatbot.shopeechat.embedding import (
    EMBEDDING_DIM,
    build_doc_text,
    clean_item_name,
    embed_texts,
)

EXPORT_PATH = ROOT / "exports" / "ShpProducts.export.json"
UNITS_PATH = ROOT / "exports" / "sellable_units.jsonl"
OUTPUT_PATH = ROOT / "exports" / "product_embeddings.npz"
UNITS_OUTPUT_PATH = ROOT / "exports" / "unit_embeddings.npz"
BATCH_SIZE = 64


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", action="store_true",
                    help="embed unit.search_text จาก sellable_units.jsonl → unit_embeddings.npz")
    ap.add_argument("--qa", action="store_true",
                    help="embed kb_qa 'topic | q' จาก admin Mongo → qa_embeddings.npz")
    args = ap.parse_args()

    if args.qa:
        # QA embeddings — อ่าน kb_qa จาก Mongo ตรงๆ (แค่ ~392 docs ไม่ต้องผ่าน export)
        from chatbot.shopeechat import knowledge_base as _kb
        docs = list(_kb._kb_qa_coll().find(
            {"type": "qa", "active": {"$ne": False}},
            {"q": 1, "topic": 1}))
        print(f"{len(docs)} QA docs")
        texts = [f"{d.get('topic') or ''} | {d.get('q') or ''}".strip(" |") for d in docs]
        print("Sample:", texts[:2])
        print(f"Embedding {len(texts)} QA (batch={BATCH_SIZE})...")
        t0 = time.time()
        embeddings = np.zeros((len(texts), EMBEDDING_DIM), dtype=np.float32)
        for start in range(0, len(texts), BATCH_SIZE):
            embeddings[start:start + BATCH_SIZE] = embed_texts(
                texts[start:start + BATCH_SIZE], batch_size=BATCH_SIZE)
        print(f"done in {time.time()-t0:.1f}s")
        out = ROOT / "exports" / "qa_embeddings.npz"
        np.savez_compressed(
            out,
            qa_ids=np.array([str(d["_id"]) for d in docs], dtype="<U24"),
            topics=np.array([d.get("topic") or "" for d in docs], dtype="<U64"),
            embeddings=embeddings)
        print(f"saved {out} ({out.stat().st_size/1024:.0f} KB)")
        return

    if args.units:
        print(f"Loading units from {UNITS_PATH}...")
        units = [json.loads(l) for l in open(UNITS_PATH, encoding="utf-8")]
        print(f"  {len(units)} units")
        texts = [u["search_text"] for u in units]
        item_ids = [str(u["item_id"]) for u in units]
        unit_ids = [str(u["unit_id"]) for u in units]
        model_ids = [str(u.get("model_id") or "") for u in units]
        shops = [str(u.get("shop") or "") for u in units]
        output_path = UNITS_OUTPUT_PATH
    else:
        print(f"Loading products from {EXPORT_PATH}...")
        t0 = time.time()
        with open(EXPORT_PATH, encoding="utf-8") as f:
            data = json.load(f)
        print(f"  loaded {len(data)} docs in {time.time()-t0:.1f}s")

        # กรองเฉพาะสินค้าที่มี item_name และมี item_id
        docs = []
        for d in data:
            if not d.get("item_name"):
                continue
            if not d.get("item_id"):
                continue
            docs.append(d)
        print(f"  {len(docs)} docs with item_name + item_id")

        # สร้าง text สำหรับ embed
        print("\nBuilding text for embedding...")
        texts = [build_doc_text(d) for d in docs]
        item_ids = [str(d["item_id"]) for d in docs]
        # ⚡ BUG-H fix — เก็บ shopname ลง .npz ด้วย เพื่อให้ vector_search กรอง shop ก่อน similarity
        shops = [str(d.get("shopname") or "") for d in docs]
        unit_ids = model_ids = None
        output_path = OUTPUT_PATH

    # แสดงตัวอย่าง
    print("\nSample texts:")
    for t in texts[:3]:
        print(f"  - {t[:100]}")

    # embed เป็น batch
    print(f"\nEmbedding {len(texts)} docs (batch_size={BATCH_SIZE})...")
    t0 = time.time()
    embeddings = np.zeros((len(texts), EMBEDDING_DIM), dtype=np.float32)
    total = len(texts)
    for start in range(0, total, BATCH_SIZE):
        end = min(start + BATCH_SIZE, total)
        batch = texts[start:end]
        emb = embed_texts(batch, batch_size=BATCH_SIZE)
        embeddings[start:end] = emb
        elapsed = time.time() - t0
        done = end
        rate = done / elapsed if elapsed > 0 else 0
        eta = (total - done) / rate if rate > 0 else 0
        print(f"  {done}/{total}  elapsed={elapsed:.1f}s  rate={rate:.1f}/s  eta={eta:.1f}s",
              flush=True)

    total_time = time.time() - t0
    print(f"\nDone in {total_time:.1f}s  ({len(texts)/total_time:.1f} docs/s)")

    # บันทึกเป็น .npz (compressed)
    # 🔒 M1: Use string dtype instead of object dtype — avoids need for allow_pickle=True
    print(f"\nSaving to {output_path}...")
    npz_kwargs = dict(
        item_ids=np.array(item_ids, dtype="<U24"),  # ObjectId strings are 24 chars
        embeddings=embeddings,
        texts=np.array(texts, dtype=object),  # texts vary in length — keep object but verify
        shops=np.array(shops, dtype="<U64"),  # ⚡ BUG-H fix — shopname สำหรับกรอง shop ก่อน similarity
    )
    if unit_ids is not None:
        npz_kwargs["unit_ids"] = np.array(unit_ids, dtype="<U96")
        npz_kwargs["model_ids"] = np.array(model_ids, dtype="<U64")
    # atomic write — bot อาจ lazy-load npz ขณะ build อยู่; เขียน tmp แล้ว replace
    # (os.replace เป็น atomic บน POSIX → reader เห็นไฟล์เก่าหรือใหม่เต็มก้อนเสมอ)
    tmp_path = output_path.with_suffix(".tmp.npz")
    np.savez_compressed(tmp_path, **npz_kwargs)
    os.replace(tmp_path, output_path)
    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"  saved {size_mb:.1f} MB")

    # ทดสอบโหลดกลับมา
    print("\nVerifying load...")
    # 🔒 M1: Verify load without pickle for item_ids
    loaded = np.load(output_path, allow_pickle=True)  # texts still need pickle
    print(f"  item_ids: {loaded['item_ids'].shape} (dtype: {loaded['item_ids'].dtype})")
    print(f"  embeddings: {loaded['embeddings'].shape}")
    print(f"  texts: {loaded['texts'].shape}")
    print(f"  shops: {loaded['shops'].shape} (dtype: {loaded['shops'].dtype})")  # ⚡ BUG-H fix
    print(f"  sample item_id: {loaded['item_ids'][0]}")
    print(f"  sample shop: {loaded['shops'][0]}")  # ⚡ BUG-H fix
    print(f"  sample text: {str(loaded['texts'][0])[:80]}")
    if unit_ids is not None:
        print(f"  unit_ids: {loaded['unit_ids'].shape}")
        print(f"  sample unit_id: {loaded['unit_ids'][0]}")

    print("\nAll done!")


if __name__ == "__main__":
    main()
