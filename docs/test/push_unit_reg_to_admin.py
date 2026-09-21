"""push ผล unit regression เข้า collection `test_assignment` ให้ดูที่ /admin-chat-result.

- questions file (flat) → group เป็น doc ต่อ topic (conversation_id = unitreg-<date>-<topic>)
- conversations file → doc ต่อ conversation จริง (conversation_id = จริง, replayed_by tag)
- replayed_by = unit_reg_YYYY-MM-DD → unique index {conversation_id, replayed_by} ไม่ชน

รัน: .venv/bin/python docs/test/push_unit_reg_to_admin.py <results.jsonl> [--tag 2026-09-18]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from pymongo import MongoClient  # noqa: E402


def qa_item(message_id: str, user_text: str, bot_reply: str,
            bot_source: str | None, rating: int | None = None) -> dict:
    return {
        "message_id": message_id,
        "user_text": user_text,
        "bot_reply": bot_reply,
        "bot_source": bot_source,
        "star_rating": rating,
    }


def push_questions(coll, recs: list[dict], tag: str) -> int:
    """group questions ตาม topic → 1 doc/topic (qa[] = ทุกข้อใน topic)."""
    from collections import defaultdict
    by_topic: dict[str, list[dict]] = defaultdict(list)
    for r in recs:
        by_topic[r.get("topic") or "misc"].append(r)
    n = 0
    for topic, items in by_topic.items():
        qa = [
            qa_item(r["id"], r["message"], r.get("answer") or "",
                    r.get("source"))
            for r in items
        ]
        n_err = sum(1 for r in items if r.get("error") or r.get("error_cause"))
        doc = {
            "conversation_id": f"unitreg-{tag}-{topic}",
            "replayed_by": f"unit_reg_{tag}",
            "platform": "shopee",
            "shop_name": f"unit-regression ({len(items)}q)",
            "to_name": topic,
            "qa": qa,
            "final_status": "error" if n_err else "bot_answered",
            "replayed_at": datetime.now(timezone.utc),
            "created_at": datetime.now(timezone.utc),
            "replay_batch_id": f"unit_reg_{tag}",
            "extra": {
                "kind": "unit_index_regression_questions",
                "n_questions": len(items),
                "n_errors": n_err,
                "n_unit_path": sum(1 for r in items if r.get("unit_path")),
            },
        }
        coll.insert_one(doc)
        n += 1
    return n


def push_conversations(coll, recs: list[dict], tag: str) -> int:
    n = 0
    for r in recs:
        qa = [
            qa_item(q.get("message_id") or f"{r.get('conv_id')}-{i}",
                    q.get("user_text") or "",
                    q.get("bot_answer") or "",
                    q.get("bot_source"))
            for i, q in enumerate(r.get("qa", []))
        ]
        doc = {
            "conversation_id": r.get("conv_id") or f"unitreg-conv-{n}",
            "replayed_by": f"unit_reg_{tag}",
            "platform": "shopee",
            "shop_name": (r.get("_meta") or {}).get("shop"),
            "to_name": r.get("to_name"),
            "qa": qa,
            "final_status": r.get("final_status") or "bot_answered",
            "replayed_at": datetime.now(timezone.utc),
            "created_at": datetime.now(timezone.utc),
            "replay_batch_id": f"unit_reg_{tag}",
            "extra": {
                "kind": "unit_index_regression_conversation",
                "n_qa": len(qa),
                "n_errors": sum(1 for q in r.get("qa", []) if q.get("error_cause")),
                "n_unit_path": sum(1 for q in r.get("qa", []) if q.get("unit_path")),
            },
        }
        coll.insert_one(doc)
        n += 1
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", help="results JSONL")
    ap.add_argument("--tag", default=datetime.now().strftime("%Y-%m-%d"))
    args = ap.parse_args()

    recs = [json.loads(l) for l in open(args.results, encoding="utf-8") if l.strip()]
    db = MongoClient(os.environ["ADMIN_MONGO_URI"],
                     serverSelectionTimeoutMS=5000)[
        os.environ.get("ADMIN_MONGO_DB", "chatbot_admin")]
    coll = db["test_assignment"]

    if recs and "qa" in recs[0]:
        n = push_conversations(coll, recs, args.tag)
    else:
        n = push_questions(coll, recs, args.tag)
    print(f"pushed {n} docs → test_assignment (replayed_by=unit_reg_{args.tag})")


if __name__ == "__main__":
    main()
