#!/usr/bin/env python3
"""conversation_products scope census — read-only dry-run (A-260 Task C).

วัตถุประสงค์: นับ legacy unscoped docs (`platform`/`shop` ว่าง/missing) ใน
`conversation_products` แล้วจำแนกความพร้อม derive scope จาก deterministic
authority `conversations_shp.conversation_id → {platform, shop_name}` เท่านั้น — ห้ามเดา
จากชื่อสินค้า/regex/LLM และห้ามเขียน DB (read-only ทั้งไฟล์)

usage (operator, env ADMIN_MONGO_* ต้องพร้อม):
    .venv/bin/python docs/test/tools/conversation_scope_census.py

output: JSON report — conversation_ids ถูก hash (sha256[:12]) เสมอ
exit 0 เสมอเมื่ออ่านสำเร็จ; ข้อมูลขาด = categories ไม่ใช่ exception
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "chatbot"))

from shopeechat import conversation_products as cp  # noqa: E402


def _h(v) -> str:
    return hashlib.sha256(str(v).encode("utf-8")).hexdigest()[:12]


def _scope_of(doc: dict) -> tuple[str, str]:
    return (str(doc.get("platform") or ""),
            str(doc.get("shop") or ""))


def main() -> int:
    db = cp._admin_db()
    coll = db["conversation_products"]
    conv_name = os.environ.get(
        "ADMIN_MONGO_COLLECTION_CONVERSATIONS", "conversations_shp").strip() \
        or "conversations_shp"
    convs = db[conv_name]

    total = coll.count_documents({})
    scoped_docs = unscoped_docs = 0
    derivable = ambiguous = conflict = orphan = 0
    samples = {"ambiguous": [], "conflict": [], "orphan": []}

    docs = list(coll.find({}, {"conversation_id": 1, "platform": 1,
                               "shop": 1}))
    ids = list({d.get("conversation_id") for d in docs
                if d.get("conversation_id") and
                (not d.get("platform") or not d.get("shop"))})
    found_by_id: dict = {}
    for conv in convs.find({"conversation_id": {"$in": ids}},
                           {"conversation_id": 1, "platform": 1,
                            "shop_name": 1}):
        found_by_id.setdefault(conv.get("conversation_id"), []).append(conv)

    for doc in docs:
        cid = doc.get("conversation_id")
        dplat, dshop = _scope_of(doc)
        if dplat and dshop:
            scoped_docs += 1
            continue
        unscoped_docs += 1
        # Conversation service resolves by conversation_id; timeline shop is shop_name.
        found = found_by_id.get(cid, [])
        if not found:
            orphan += 1
            if len(samples["orphan"]) < 50:
                samples["orphan"].append(_h(cid))
            continue
        if len(found) > 1:
            ambiguous += 1
            if len(samples["ambiguous"]) < 50:
                samples["ambiguous"].append(_h(cid))
            continue
        conv = found[0]
        cplat = str(conv.get("platform") or "")
        cshop = str(conv.get("shop_name") or "")
        if not cplat or not cshop:
            # authority doc ไม่มี scope ให้ derive → ambiguous (ไม่เดา)
            ambiguous += 1
            if len(samples["ambiguous"]) < 50:
                samples["ambiguous"].append(_h(cid))
            continue
        # conflict: partial scope ของ doc ขัดกับ authority
        if (dplat and dplat != cplat) or (dshop and dshop != cshop):
            conflict += 1
            if len(samples["conflict"]) < 50:
                samples["conflict"].append(_h(cid))
            continue
        derivable += 1

    report = {
        "collection": "conversation_products",
        "authority": f"{conv_name}.conversation_id → {{platform, shop_name}}",
        "total_docs": total,
        "scoped_docs": scoped_docs,
        "unscoped_docs": unscoped_docs,
        "derivation": {
            "derivable": derivable,
            "ambiguous": ambiguous,
            "conflict": conflict,
            "orphan": orphan,
        },
        "hashed_conversation_ids_sha256_12": samples,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
