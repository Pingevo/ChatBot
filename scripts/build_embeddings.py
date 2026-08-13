"""Script embed สินค้าทั้งหมดจาก export JSON เป็น vector แล้วเก็บลงไฟล์.

วิธีใช้:
    .venv/bin/python scripts/build_embeddings.py

ผลลัพธ์:
    exports/product_embeddings.npz  — numpy archive เก็บ (ids, embeddings, texts)
    ใช้สำหรับ similarity search ใน product_store.py

หลังจากนี้ถ้าต้องการ sync ลง MongoDB field `embedding` ก็ทำได้ทีหลัง
แต่ตอนนี้เก็บในไฟล์ก่อนเพื่อความเร็วในการทดสอบ.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

# ทำให้ import chatbot.* ได้
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np

from chatbot.embedding import (
    EMBEDDING_DIM,
    build_doc_text,
    clean_item_name,
    embed_texts,
)

EXPORT_PATH = ROOT / "exports" / "ShpProducts.export.json"
OUTPUT_PATH = ROOT / "exports" / "product_embeddings.npz"
BATCH_SIZE = 64


def main() -> None:
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
    print(f"\nSaving to {OUTPUT_PATH}...")
    np.savez_compressed(
        OUTPUT_PATH,
        item_ids=np.array(item_ids, dtype=object),
        embeddings=embeddings,
        texts=np.array(texts, dtype=object),
    )
    size_mb = OUTPUT_PATH.stat().st_size / 1024 / 1024
    print(f"  saved {size_mb:.1f} MB")

    # ทดสอบโหลดกลับมา
    print("\nVerifying load...")
    loaded = np.load(OUTPUT_PATH, allow_pickle=True)
    print(f"  item_ids: {loaded['item_ids'].shape}")
    print(f"  embeddings: {loaded['embeddings'].shape}")
    print(f"  texts: {loaded['texts'].shape}")
    print(f"  sample item_id: {loaded['item_ids'][0]}")
    print(f"  sample text: {str(loaded['texts'][0])[:80]}")

    print("\nAll done!")


if __name__ == "__main__":
    main()
