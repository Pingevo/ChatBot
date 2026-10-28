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
    build_description_chunks,
    build_doc_text,
    clean_item_name,
    embed_texts,
)

EXPORT_PATH = ROOT / "exports" / "ShpProducts.export.json"
UNITS_PATH = ROOT / "exports" / "sellable_units.jsonl"
OUTPUT_PATH = ROOT / "exports" / "product_embeddings.npz"
UNITS_OUTPUT_PATH = ROOT / "exports" / "unit_embeddings.npz"
BATCH_SIZE = 64


def _embed_all(texts: list[str], embed=None) -> np.ndarray:
    """embed ทั้งหมดเป็น batch — embed=None → embed_texts (monkeypatch-able)"""
    embed = embed or embed_texts
    t0 = time.time()
    embeddings = np.zeros((len(texts), EMBEDDING_DIM), dtype=np.float32)
    for start in range(0, len(texts), BATCH_SIZE):
        end = min(start + BATCH_SIZE, len(texts))
        embeddings[start:end] = embed(texts[start:end], batch_size=BATCH_SIZE)
        print(f"  {end}/{len(texts)}  elapsed={time.time()-t0:.1f}s", flush=True)
    return embeddings


def _save_verified_npz(npz_kwargs: dict, out: Path, expected_rows: int,
                       generation_id: str) -> int:
    """เขียน tmp → verify (load จริง + rows + generation_id) → os.replace —
    pointer ต้องไม่ชี้ไฟล์ที่ยังไม่ verify; คืน row count"""
    if generation_id:
        npz_kwargs["generation_id"] = np.array(generation_id)
    tmp = out.parent / f"{out.stem}.tmp{out.suffix}"  # ต้องลงท้าย .npz
    np.savez_compressed(tmp, **npz_kwargs)
    z = np.load(tmp, allow_pickle=True)
    if z["embeddings"].shape[0] != expected_rows:
        tmp.unlink(missing_ok=True)
        raise ValueError(f"npz rows {z['embeddings'].shape[0]} != {expected_rows}")
    if generation_id and (
            "generation_id" not in z.files
            or str(z["generation_id"].item()) != generation_id):
        tmp.unlink(missing_ok=True)
        raise ValueError("npz generation_id missing/mismatch after write")
    os.replace(tmp, out)
    return expected_rows


def build_units_npz(units_jsonl: Path, out: Path, generation_id: str = "",
                    embed=None) -> int:
    """unit.search_text → unit_embeddings.npz (+generation_id) — คืน row count"""
    units = [json.loads(l) for l in open(units_jsonl, encoding="utf-8")]
    texts = [u["search_text"] for u in units]
    print(f"{len(units)} units → embed")
    emb = _embed_all(texts, embed)
    return _save_verified_npz(dict(
        unit_ids=np.array([str(u["unit_id"]) for u in units], dtype="<U96"),
        item_ids=np.array([str(u["item_id"]) for u in units], dtype="<U24"),
        model_ids=np.array([str(u.get("model_id") or "") for u in units],
                           dtype="<U64"),
        shops=np.array([str(u.get("shop") or "") for u in units], dtype="<U64"),
        texts=np.array(texts, dtype=object),
        embeddings=emb), out, len(units), generation_id)


def build_product_npz(export_path: Path, out: Path, generation_id: str = "",
                      embed=None) -> int:
    """ShpProducts export → product_embeddings.npz (+generation_id) — คืน row count"""
    t0 = time.time()
    with open(export_path, encoding="utf-8") as f:
        data = json.load(f)
    docs = [d for d in data if d.get("item_name") and d.get("item_id")]
    print(f"  {len(docs)} docs (load {time.time()-t0:.1f}s) → embed")
    texts = [build_doc_text(d) for d in docs]
    emb = _embed_all(texts, embed)
    return _save_verified_npz(dict(
        item_ids=np.array([str(d["item_id"]) for d in docs], dtype="<U24"),
        shops=np.array([str(d.get("shopname") or "") for d in docs],
                       dtype="<U64"),
        texts=np.array(texts, dtype=object),
        embeddings=emb), out, len(docs), generation_id)


def build_description_npz(export_path: Path, out: Path, generation_id: str = "",
                          embed=None, tokenizer=None) -> int:
    """ShpProducts export → description_embeddings.npz (Phase 10B) —
    chunk = build_description_chunks (owner เดียว, measured-B contract);
    row = (item_id, chunk_id=<iid>:<i>, shop, text, vector) — คืน row count.
    item doc contract เดียวกับ build_product_npz (item_name+item_id);
    duplicate item doc → first wins; empty/malformed → zero rows (fail
    closed — ไม่เคยสร้าง chunk-only identity)"""
    t0 = time.time()
    with open(export_path, encoding="utf-8") as f:
        data = json.load(f)
    item_ids, chunk_ids, shops, texts = [], [], [], []
    seen_ids: set = set()
    for d in data:
        iid = d.get("item_id")
        if not d.get("item_name") or not iid:
            continue                # malformed/missing identity → ข้าม
        iid = str(iid)
        if iid in seen_ids:
            continue                # duplicate item doc → first wins
        chunks = build_description_chunks(d.get("description") or "",
                                          tokenizer=tokenizer)
        if not chunks:
            continue                # empty desc → zero rows (ถูกต้อง)
        seen_ids.add(iid)
        for ci, text in enumerate(chunks):
            item_ids.append(iid)
            chunk_ids.append(f"{iid}:{ci}")
            shops.append(str(d.get("shopname") or ""))
            texts.append(text)
    print(f"  items={len(seen_ids)} chunks={len(texts)} "
          f"({time.time()-t0:.1f}s) → embed")
    if len(set(chunk_ids)) != len(chunk_ids):
        raise ValueError("duplicate (item_id, chunk_id) rows")
    emb = _embed_all(texts, embed)
    if emb.shape != (len(texts), EMBEDDING_DIM):
        raise ValueError(f"desc embeddings shape {emb.shape} != "
                         f"({len(texts)},{EMBEDDING_DIM})")
    if not np.isfinite(emb).all():
        raise ValueError("non-finite description embeddings")
    return _save_verified_npz(dict(
        item_ids=np.array(item_ids, dtype="<U24"),
        chunk_ids=np.array(chunk_ids, dtype="<U40"),
        shops=np.array(shops, dtype="<U64"),
        texts=np.array(texts, dtype=object),
        embeddings=emb), out, len(texts), generation_id)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--units", action="store_true",
                    help="embed unit.search_text จาก sellable_units.jsonl → unit_embeddings.npz")
    ap.add_argument("--description", action="store_true",
                    help="embed description chunks จาก export → description_embeddings.npz")
    ap.add_argument("--qa", action="store_true",
                    help="embed kb_qa 'topic | q' จาก admin Mongo → qa_embeddings.npz")
    ap.add_argument("--export", type=Path, default=EXPORT_PATH)
    ap.add_argument("--units-path", type=Path, default=UNITS_PATH)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--gid", default="",
                    help="generation_id ที่ฝังลง npz (refresh gen run ส่งเสมอ)")
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

    if args.description:
        n = build_description_npz(
            args.export,
            args.out or (args.export.parent / "description_embeddings.npz"),
            args.gid)
    elif args.units:
        n = build_units_npz(args.units_path,
                            args.out or UNITS_OUTPUT_PATH, args.gid)
    else:
        n = build_product_npz(args.export,
                              args.out or OUTPUT_PATH, args.gid)
    print(f"\nAll done! rows={n}")


if __name__ == "__main__":
    main()
