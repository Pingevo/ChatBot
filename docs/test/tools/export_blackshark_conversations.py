"""Export N random BlackShark (shopee) conversations -> JSON, customer-side messages only.

โหลด env จาก ChatAdminWeb/.env ผ่าน python-dotenv (ไม่อ่านเนื้อหา .env เอง)
input:  --count N (default 50)  --out <path>  --seed <int optional>
output: JSON {shop, generated_at, conversation_count, total_customer_messages, conversations[]}
        conversations[].messages = user/direction=in เท่านั้น sort created_timestamp asc
read-only — ไม่เขียน DB
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient

try:
    from dotenv import load_dotenv
    _repo_root = Path(__file__).resolve().parent.parent.parent.parent
    load_dotenv(_repo_root / "ChatAdminWeb" / ".env", override=False)
except ImportError:
    pass

SHOP_PLATFORM = "shopee"
SHOP_ID = "1191420560"
SHOP_NAME = "BlackShark"

_CONV_COLL = os.environ.get("ADMIN_MONGO_COLLECTION_CONVERSATIONS", "conversations_shp")
_MSG_COLL = os.environ.get("ADMIN_MONGO_COLLECTION_MESSAGES", "messages_shp")

# text marker → content_type (ข้อมูลเก่าหลายแถวไม่มี raw_payload.message_type)
_MARKER_TYPES = {
    "[รูปภาพ]": "image",
    "[item]": "item",
    "[วิดีโอ]": "video",
    "[สติกเกอร์]": "sticker",
    "[ออเดอร์]": "order",
    "[variation_card]": "variation_card",
}


def _client() -> MongoClient:
    uri = os.environ.get("ADMIN_MONGO_URI", "").strip()
    if uri:
        return MongoClient(uri, serverSelectionTimeoutMS=8000)
    return MongoClient(
        host=os.environ.get("ADMIN_MONGO_HOST", "127.0.0.1:27017").strip(),
        username=os.environ.get("ADMIN_MONGO_USERNAME") or None,
        password=os.environ.get("ADMIN_MONGO_PASSWORD") or None,
        authSource=os.environ.get("ADMIN_MONGO_AUTH_SOURCE", "admin").strip(),
        tls=os.environ.get("ADMIN_MONGO_TLS", "false").strip().lower() == "true",
        serverSelectionTimeoutMS=8000,
    )


def _iso(v) -> str | None:
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).isoformat()
    return str(v) if v is not None else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=50)
    ap.add_argument("--out", type=str, required=True)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    db = _client()[os.environ.get("ADMIN_MONGO_DB", "chatbot").strip()]
    conv = db[_CONV_COLL]
    msg = db[_MSG_COLL]

    user_filter = {
        "shop_id": SHOP_ID,
        "platform": SHOP_PLATFORM,
        "role": "user",
        "direction": "in",
    }
    # conv_ids ที่มีข้อความลูกค้าอย่างน้อย 1 — นับจำนวน user msgs ต่อ conv
    conv_counts = {
        d["_id"]: d["n"]
        for d in msg.aggregate([
            {"$match": user_filter},
            {"$group": {"_id": "$conversation_id", "n": {"$sum": 1}}},
        ])
    }
    eligible = sorted(conv_counts)
    print(f"eligible conversations (>=1 customer msg): {len(eligible)}")
    if not eligible:
        sys.exit("no conversations found")

    rng = random.Random(args.seed)
    picked = rng.sample(eligible, min(args.count, len(eligible)))

    conv_meta = {
        d["conversation_id"]: d
        for d in conv.find(
            {"conversation_id": {"$in": picked}},
            {"conversation_id": 1, "customer_id": 1, "to_name": 1, "status": 1,
             "created_at": 1, "last_message_timestamp": 1},
        )
    }

    out_convs = []
    total_msgs = 0
    for cid in picked:
        seen_ids = set()
        msgs = []
        cursor = msg.find(
            {**user_filter, "conversation_id": cid},
            {"message_id": 1, "text": 1, "created_timestamp": 1, "raw_payload": 1},
        ).sort([("created_timestamp", 1), ("_id", 1)])
        for m in cursor:
            mid = m.get("message_id")
            if mid in seen_ids:  # เด dup message_id (R4 audit พบ dup inbound ใน messages_shp)
                continue
            seen_ids.add(mid)
            text = m.get("text") or ""
            content = (
                ((m.get("raw_payload") or {}).get("data") or {}).get("content") or {}
            )
            ctype = content.get("message_type") or _MARKER_TYPES.get(text)
            entry = {
                "seq": len(msgs) + 1,
                "message_id": mid,
                "timestamp": _iso(m.get("created_timestamp")),
                "text": text,
            }
            if ctype and ctype != "text":
                entry["content_type"] = ctype
                inner = content.get("content") or {}
                if inner.get("url"):
                    entry["media_url"] = inner["url"]
                if ctype in ("item", "variation_card") and inner.get("item_id") is not None:
                    iid = inner["item_id"]
                    entry["item_id"] = int(iid) if isinstance(iid, float) else iid
            msgs.append(entry)
        meta = conv_meta.get(cid, {})
        out_convs.append({
            "conversation_id": cid,
            "customer_id": meta.get("customer_id"),
            "customer_name": meta.get("to_name"),
            "status": meta.get("status"),
            "created_at": _iso(meta.get("created_at")),
            "last_message_timestamp": _iso(meta.get("last_message_timestamp")),
            "customer_message_count": len(msgs),
            "messages": msgs,
        })
        total_msgs += len(msgs)

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "seed": args.seed,
        "shop": {"platform": SHOP_PLATFORM, "shop_id": SHOP_ID, "shop_name": SHOP_NAME},
        "conversation_count": len(out_convs),
        "total_customer_messages": total_msgs,
        "conversations": out_convs,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out_path} — {len(out_convs)} convs, {total_msgs} customer msgs")


if __name__ == "__main__":
    main()
