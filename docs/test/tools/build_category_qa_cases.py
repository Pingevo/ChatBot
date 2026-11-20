"""Build live category-QA case file from real BlackShark conversations.

ดึง customer messages (role=user + direction=in) ของ conv_ids ที่เลือกจาก
messages_shp — logic เดียวกับ export_blackshark_conversations.py (dedupe
message_id, content_type จาก raw_payload/message_type หรือ text marker)
แล้วเพิ่ม order_sn เมื่อการ์ด [ออเดอร์] มี

input:  CASE_IDS (hardcode list ของ (category, conversation_id))
output: docs/test/results/category_qa_cases.json (gitignored)
read-only — ไม่เขียน DB
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from pymongo import MongoClient

try:
    from dotenv import load_dotenv
    _repo_root = Path(__file__).resolve().parent.parent.parent.parent
    load_dotenv(_repo_root / "ChatAdminWeb" / ".env", override=False)
except ImportError:
    pass

SHOP_ID = "1191420560"
OUT = Path(__file__).resolve().parent.parent / "results" / "category_qa_cases.json"

# (category, conversation_id) — คัดจาก export + DB search วันนี้
CASE_IDS = [
    ("compat", "shp_162696480510522837"),   # ใช้กับตัวs3ได้ไหม
    ("compat", "shp_1725450099578451413"),  # ใส่กับ black shark run ได้ไหม
    ("compat", "shp_3188025844145141205"),  # ultra เชื่อมแอพ strava ได้มั้ย
    ("compare", "shp_874340671325550037"),  # สปอร์ต vs อัลตร้า ต่างกันยังไง
    ("compare", "shp_10319892776039893"),   # เทียบ 3pro อันไหนดีกว่า
    ("spec", "shp_2183773018469845"),       # สี Black หน้าปัดสีอะไร
    ("spec", "shp_2019781515428836821"),    # มีจีพีเอสในตัวไหม
    ("spec", "shp_4697994150733172737"),    # มีแบตในตัวมั้ย / รุ่นไหนมี
    ("handoff", "shp_49414935667094997"),   # ขอคุยเจ้าหน้าที่ / ติดต่อแอดมิน
    ("handoff", "shp_1878727591063008725"), # ค้างหน้าจอ → ติดต่อแอดมิน → ปกติแล้ว
    ("claim", "shp_4697272221540298753"),   # ชาร์จไม่เข้า ส่งเคลมยังไง
    ("claim", "shp_340212216203130325"),    # T6 แบตหมดไวข้างซ้าย → เคลม
    ("claim", "shp_382087034942600661"),    # S3 ลงน้ำไม่ติด → เคลม
    ("warranty", "shp_1792640576547010005"),# สอบถามการรับประกัน + order + เคลมได้มั้ย
    ("warranty", "shp_1309544231345927637"),# แบตหมดเร็ว ติดต่อประกัน
    ("warranty", "shp_489471967645742549"), # ตกแล้วจอร้าวเคลมได้ไหม
    ("troubleshoot", "shp_1199916075878790613"), # บลูทูธหลุดต้องรีเซ็ตทุกครั้ง
    ("troubleshoot", "shp_147583160610797013"),  # เปิดโหมดเกมไม่ได้ Rokas 5
    ("troubleshoot", "shp_325832704350827989"),  # เชื่อมนาฬิกาไม่ได้/หลุด
    ("return", "shp_3571466209206023637"),  # คืนสินค้าเปลี่ยนรุ่นได้ไหม
    ("return", "shp_4708362889406205953"),  # ชาร์จละลาย ขอคืนเงิน/คืนสินค้า
    ("return", "shp_4708685008597946369"),  # GS3 จอดับ ขอคืนสินค้าคืนเงิน
    ("refund", "shp_3197877932186482133"),  # ขอคืนเงินเท่านั้น ไม่เคลม
    ("refund", "shp_1107213085150098901"),  # ขอรับเป็นเงินคืนอย่างเดียว
    ("tax", "shp_122460952003687893"),      # ออกใบกำกับได้ไหม/ส่งพร้อมสินค้าไหม
    ("tax", "shp_878406154223957461"),      # ออกใบกำกับมั้ย / เป็นชื่อคนอื่นได้ไหม
    ("tax", "shp_951590206514476501"),      # ขอใบกำกับ + ขอลิงก์กรอก
]

_MARKER_TYPES = {
    "[รูปภาพ]": "image", "[item]": "item", "[วิดีโอ]": "video",
    "[สติกเกอร์]": "sticker", "[ออเดอร์]": "order",
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


def main() -> None:
    msg = _client()[os.environ.get("ADMIN_MONGO_DB", "chatbot").strip()][
        os.environ.get("ADMIN_MONGO_COLLECTION_MESSAGES", "messages_shp")]
    base = {"shop_id": SHOP_ID, "platform": "shopee",
            "role": "user", "direction": "in"}
    cases, missing = [], []
    for cat, cid in CASE_IDS:
        seen, turns = set(), []
        cur = msg.find({**base, "conversation_id": cid},
                       {"message_id": 1, "text": 1, "created_timestamp": 1,
                        "raw_payload": 1}).sort(
            [("created_timestamp", 1), ("_id", 1)])
        for m in cur:
            mid = m.get("message_id")
            if mid in seen:
                continue
            seen.add(mid)
            content = (((m.get("raw_payload") or {}).get("data") or {})
                       .get("content") or {})
            ctype = content.get("message_type") or _MARKER_TYPES.get(
                m.get("text") or "")
            inner = content.get("content") or {}
            t: dict = {"text": m.get("text") or ""}
            if ctype:
                t["kind"] = ctype
            if inner.get("item_id") is not None:
                iid = inner["item_id"]
                t["item_id"] = str(int(iid)) if isinstance(iid, float) \
                    else str(iid)
            if inner.get("order_sn"):
                t["order_sn"] = str(inner["order_sn"])
            turns.append(t)
        if not turns:
            missing.append(cid)
            continue
        cases.append({"category": cat, "conversation_id": cid,
                      "turns": turns})
    OUT.write_text(json.dumps(
        {"shop_id": SHOP_ID, "case_count": len(cases),
         "turn_count": sum(len(c["turns"]) for c in cases),
         "missing": missing, "cases": cases},
        ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {OUT} — {len(cases)} cases, "
          f"{sum(len(c['turns']) for c in cases)} turns, missing={missing}")


if __name__ == "__main__":
    main()
