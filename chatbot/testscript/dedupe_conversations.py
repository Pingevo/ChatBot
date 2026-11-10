"""dedupe_conversations.py — R4 conversations_shp duplicate remediation.

ตาม docs/plans/active/2026-10-14-conversations-shp-duplicate-remediation-plan.md:
- Stage 3 cleanup เท่านั้น — ห้ามรันก่อน external writer ถูกแก้ + drain แล้ว
- default = dry-run (read-only census + preview); --apply ต้องใส่ --token APPLY-DEDUPE
  + fresh census ใน process เดียวกัน (fail closed เมื่อ data เปลี่ยนระหว่างรัน)
- canonical = doc updated_at/last_message_timestamp ใหม่สุดต่อ group;
  losers → archive เข้า conversations_shp_dup_archive (ไม่ลบทิ้ง — rollback ได้)
- ห้ามแตะ status_conversation / messages_* (non-goal ของ plan)

Usage:
    dry-run : .venv/bin/python chatbot/testscript/dedupe_conversations.py
    apply   : ... --apply --token APPLY-DEDUPE [--limit N]
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(str(ROOT / ".env"), override=False)
from chatbot.shopeechat import knowledge_base as _kb  # noqa: E402

COLL = "conversations_shp"
ARCHIVE = "conversations_shp_dup_archive"
FRESHNESS = ("updated_at", "last_message_timestamp", "data_received_at", "created_at")


def _fresh_key(d: dict):
    """จัดอันดับ canonical — field เวลาใหม่สุดชนะ (str/date เปรียบตรงได้เพราะ format
    เดียวกัน); tie-break ด้วย str(_id) — ObjectId ฝังเวลาสร้าง เผื่อเวลาเท่ากันเป๊ะ"""
    return tuple(str(d.get(f) or "") for f in FRESHNESS) + (str(d.get("_id")),)


def _census(coll) -> list[list[dict]]:
    """dup groups → [docs...] ต่อ group (read-only, fresh per call)."""
    groups = coll.aggregate([
        {"$group": {"_id": "$conversation_id", "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
    ], allowDiskUse=True)
    out = []
    for g in groups:
        docs = list(coll.find({"conversation_id": g["_id"]}))
        if len(docs) > 1:
            out.append(docs)
    return out


def _report(groups: list[list[dict]]) -> None:
    extra = sum(len(g) - 1 for g in groups)
    print(f"dup groups: {len(groups)} | extra docs: {extra}")
    for g in groups[:5]:
        c = max(g, key=_fresh_key)
        print(f"  e.g. {c.get('conversation_id')}: n={len(g)} canonical={c['_id']} "
              f"updated={c.get('updated_at')}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--token", default="")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    db = _kb._admin_db()
    coll, arch = db[COLL], db[ARCHIVE]
    groups = _census(coll)
    _report(groups)
    if not args.apply:
        print("\nDRY-RUN — ไม่มี write; --apply --token APPLY-DEDUPE เมื่อ writer fix+approve แล้ว")
        return
    if args.token != "APPLY-DEDUPE":
        sys.exit("ต้อง --token APPLY-DEDUPE (approval token ตาม plan §4)")
    if args.limit:
        groups = groups[: args.limit]

    # merge ต่อ group — canonical fresh สุด; CAS: re-read ids ก่อนเขียน กัน drift
    archived = deleted = skipped = 0
    for g in groups:
        g_sorted = sorted(g, key=_fresh_key, reverse=True)
        canon, losers = g_sorted[0], g_sorted[1:]
        live_ids = {d["_id"] for d in
                    coll.find({"conversation_id": canon["conversation_id"]},
                              {"_id": 1})}
        if {d["_id"] for d in g} != live_ids:
            skipped += 1
            print(f"  SKIP {canon['conversation_id']} — doc set drifted mid-run")
            continue
        now = _dt.datetime.now(_dt.UTC)
        arch.insert_many([{**d, "_dup_of": canon["_id"], "_archived_at": now}
                          for d in losers], ordered=False)
        r = coll.delete_many({"_id": {"$in": [d["_id"] for d in losers]}})
        archived += len(losers)
        deleted += r.deleted_count
    print(f"\narchived={archived} deleted={deleted} skipped_groups={skipped} "
          f"(rollback = re-insert จาก {ARCHIVE} แล้วลบ archive docs)")


if __name__ == "__main__":
    main()
