"""หา conversation_id ของลูกค้าที่อยู่ใน QA notes (shadow-inbox-bot-qa-notes.md).

โหลด env จาก ChatAdminWeb/.env ผ่าน python-dotenv (ไม่อ่านเนื้อหา .env เอง)
ค้นจาก conversations_shp ด้วย to_name
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from pymongo import MongoClient

try:
    from dotenv import load_dotenv
    _repo_root = Path(__file__).resolve().parent.parent.parent
    load_dotenv(_repo_root / "ChatAdminWeb" / ".env", override=False)
except ImportError:
    pass

# ลูกค้าจาก QA notes (+ bbeem.4343 จาก getoutofmyway BioKoop replay)
QA_CUSTOMERS = [
    ("0xgssknoa9", "KieslectThailand"),
    ("thunderblackhousr", "BlackShark"),
    ("takdanaikunasatittayakul", "CukTechThailand"),
    ("sirikanjanapintep", "YoupinOfficialStore"),
    ("aroranuch2511", "ZMIThailand"),
    ("m8iolenl0i", "ZMIThailand"),
    ("taweep154", "CukTechThailand"),
    ("peeslnwza007", "KospetThailand"),
    ("pornchita_24", "ZMIThailand"),
    ("bloodymaryx", "IMILabThailand"),
    ("pornpansonsuwan", "YoupinOfficialStore"),
    ("nt_sumittra", "BlackShark"),
]


def main() -> None:
    uri = os.environ.get("ADMIN_MONGO_URI", "").strip()
    if uri:
        client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    else:
        host = os.environ.get("ADMIN_MONGO_HOST", "127.0.0.1:27017").strip()
        username = os.environ.get("ADMIN_MONGO_USERNAME", "").strip()
        password = os.environ.get("ADMIN_MONGO_PASSWORD", "").strip()
        auth_source = os.environ.get("ADMIN_MONGO_AUTH_SOURCE", "admin").strip()
        tls = os.environ.get("ADMIN_MONGO_TLS", "false").strip().lower() == "true"
        params: dict = {"host": host, "authSource": auth_source, "tls": tls, "serverSelectionTimeoutMS": 5000}
        if username:
            params["username"] = username
        if password:
            params["password"] = password
        client = MongoClient(**params)

    db = client[os.environ.get("ADMIN_MONGO_DB", "chatbot").strip()]
    coll = db["conversations_shp"]

    print(f"{'to_name':32} {'shop':24} conversation_id")
    print("-" * 100)
    found = {}
    for name, shop_hint in QA_CUSTOMERS:
        # ค้นด้วย to_name — เอาอันที่ last_message_timestamp ใหม่สุด
        docs = list(coll.find(
            {"to_name": {"$regex": name, "$options": "i"}},
            {"conversation_id": 1, "shop_name": 1, "last_message_timestamp": 1, "customer_id": 1},
        ).sort("last_message_timestamp", -1).limit(3))
        if not docs:
            print(f"{name:32} {shop_hint:24} ❌ ไม่พบ")
            continue
        for d in docs:
            shop = d.get("shop_name") or "?"
            # ถ้าระบุ shop_hint และเจอตรง shop → ใช้อันนั้น; ถ้าไม่ตรงแสดงให้เลือก
            mark = "✓" if (not shop_hint or shop_hint.lower() in (shop or "").lower()) else " "
            print(f"{name:32} {shop:24} {mark} {d.get('conversation_id')}  (last: {d.get('last_message_timestamp')})")
        found[name] = docs[0].get("conversation_id")
    print()
    print("=== สรุง conversation_id หลัก (ใหม่สุด) ===")
    for name, shop_hint in QA_CUSTOMERS:
        if name in found:
            print(f"{name} → {found[name]}")


if __name__ == "__main__":
    main()
