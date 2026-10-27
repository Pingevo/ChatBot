"""Extract image texts สำหรับรูปที่โผล่เฉพาะใน NON-sellable docs — phase 2 ของ
OCR budget (sellable ได้ priority ก่อนเสมอ — scope เดียวกับ gen เดียวกัน).

reuse ทุกอย่างจาก build_image_texts — ต่างแค่ scope + default MODEL
usage:
    python build_image_texts_nonsellable.py --export <gen export> \
        --gen-dir exports/gen/<gid> --gid <gid> [--max-calls N]
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from chatbot.shopeechat.scripts import build_image_texts as B  # noqa: E402

B.MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", type=Path, default=B.EXPORT_PATH)
    ap.add_argument("--gen-dir", type=Path, default=ROOT / "exports")
    ap.add_argument("--gid", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max-calls", type=int,
                    default=int(os.environ.get("IMGTXT_NONSELLABLE_MAX_CALLS", "300")))
    ap.add_argument("--max-runtime-min", type=float,
                    default=float(os.environ.get("IMGTXT_MAX_RUNTIME_MIN", "90")))
    ap.add_argument("--shard", type=str, default="")
    args = ap.parse_args()

    work = B._collect_worklist(args.export, scope="nonsellable")
    if args.shard:
        k, n = (int(x) for x in args.shard.split("/"))
        work = work[k::n]
    if args.limit:
        work = work[: args.limit]

    deadline = time.time() + args.max_runtime_min * 60
    env_deadline = os.environ.get("REFRESH_DEADLINE_EPOCH")
    if env_deadline:
        deadline = min(deadline, float(env_deadline))

    from chatbot.shopeechat import knowledge_base as _kb
    counts = B.run_generation_ocr(work, db=_kb._admin_db(),
                                  gen_dir=args.gen_dir, gid=args.gid,
                                  max_calls=args.max_calls, deadline_ts=deadline,
                                  scope="nonsellable")
    print(f"Done (nonsellable): {counts}")


if __name__ == "__main__":
    main()
