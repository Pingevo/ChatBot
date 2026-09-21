"""Extract image texts สำหรับ NON-sellable docs (UNLIST / หมด / ลบแล้ว).

รันขนานกับ build_image_texts.py ได้โดยไม่ชนกัน — worklist คือ image_id ที่
โผล่เฉพาะใน non-sellable docs เท่านั้น (รูปที่ถูก sellable doc ใช้ด้วยจะอยู่ฝั่ง
sellable run อยู่แล้ว ไม่ต้องทำซ้ำ)

reuse ทุกอย่างจาก build_image_texts (_extract_one/_load_done/OUTPUT_PATH)
ต่างแค่ worklist scope + default MODEL=gemini-3.1-flash-lite (A/B แล้วว่าพอกัน)

usage:
    GEMINI_MODEL=gemini-3.1-flash-lite \
        python build_image_texts_nonsellable.py --shard 0/4 --max-calls 2500
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from chatbot.shopeechat.scripts import build_image_texts as B  # noqa: E402

# default model ของ run นี้ — override ด้วย env GEMINI_MODEL ได้เหมือนเดิม
B.MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")


def _collect_nonsellable(path: Path) -> list[dict]:
    """image_id ที่อยู่ใน non-sellable docs เท่านั้น (หัก sellable ids ทิ้ง)."""
    used_by: collections.Counter = collections.Counter()
    sellable_ids: set[str] = set()
    nonsellable: dict[str, str] = {}
    n_docs = n_sellable = 0
    for d in B._iter_export_docs(path):
        n_docs += 1
        ids = B._doc_images(d)
        for iid in ids:
            used_by[iid] += 1
        if d.get("item_status") == "NORMAL" and B._doc_stock(d) > 0:
            n_sellable += 1
            sellable_ids.update(ids)
        else:
            nonsellable.update(ids)
    nonsellable = {k: v for k, v in nonsellable.items() if k not in sellable_ids}
    print(f"docs={n_docs} sellable_docs={n_sellable} unique_images(nonsellable_only)={len(nonsellable)}")
    return [
        {"image_id": iid, "image_url": url, "used_by": used_by[iid],
         "is_template": used_by[iid] > B.TEMPLATE_MIN_USED_BY}
        for iid, url in sorted(nonsellable.items())
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-calls", type=int, default=4000)
    ap.add_argument("--shard", type=str, default="", help="K/N")
    args = ap.parse_args()

    work = _collect_nonsellable(B.EXPORT_PATH)
    done = B._load_done(B.OUTPUT_PATH)
    todo = [w for w in work if w["image_id"] not in done]
    if args.shard:
        k, n = (int(x) for x in args.shard.split("/"))
        todo = todo[k::n]
    if args.limit:
        todo = todo[: args.limit]
    print(f"model={B.MODEL} done={len(done)} todo={len(todo)} shard={args.shard or '-'}")

    n_ok = n_err = 0
    cost_sum = 0.0
    t_start = time.time()
    with open(B.OUTPUT_PATH, "a", encoding="utf-8") as out:
        for i, item in enumerate(todo):
            if i >= args.max_calls:
                print(f"⛔ ถึง max_calls={args.max_calls} — หยุด (รันซ้ำ resume ต่อได้)")
                break
            t_call = time.time()
            entry = B._extract_one(item)
            out.write(json.dumps(entry, ensure_ascii=False) + "\n")
            out.flush()
            if entry["status"] == "ok":
                n_ok += 1
                cost_sum += entry.get("cost_usd", 0)
            else:
                n_err += 1
            if (i + 1) % 25 == 0 or i < 5:
                el = time.time() - t_start
                print(f"[{i+1}/{len(todo)}] ok={n_ok} err={n_err} cost=${cost_sum:.3f} "
                      f"rate={(i+1)/el:.2f}/s eta={(len(todo)-i-1)/((i+1)/el)/60:.0f}m "
                      f"last={entry.get('kind','-')} {entry['image_id']}", flush=True)
            time.sleep(max(0.0, B.MIN_INTERVAL - (time.time() - t_call)))

    print(f"\nDone: ok={n_ok} err={n_err} cost=${cost_sum:.3f} "
          f"(~฿{cost_sum*34:.0f}) elapsed={(time.time()-t_start)/60:.0f}m")


if __name__ == "__main__":
    main()
