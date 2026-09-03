"""ดึงข้อมูล order จาก MongoDB (read-only) เพื่อส่งให้ LLM ตอบลูกค้า.

ใช้ env:
- ORDER_URI_MONGO — connection string
- ORDER_DB — database name (เช่น dbWallet)
- ORDER_COLLECTION — collection name (เช่น ShpOrders)

ข้อมูลที่ดึง:
- สถานะ order (order_status + logistics_status)
- สินค้าใน order (item_list: ชื่อ + จำนวน)
- ขนส่ง (shipping_carrier)
- วันที่สั่งซื้อ (create_time)
"""

from __future__ import annotations

import os
import re
import sys
import time as _time
from datetime import datetime, timezone
from typing import Any

from pymongo import MongoClient
from pymongo.errors import PyMongoError


# ---- DB connection (read-only, lazy singleton) --------------------------------

_ORDER_CLIENT: MongoClient | None = None


def _get_order_client() -> MongoClient:
    """สร้าง/คืน MongoClient สำหรับ order DB (lazy singleton)."""
    global _ORDER_CLIENT
    if _ORDER_CLIENT is not None:
        try:
            _ORDER_CLIENT.admin.command("ping")
            return _ORDER_CLIENT
        except Exception:
            _ORDER_CLIENT = None
    uri = os.environ.get("ORDER_URI_MONGO", "").strip()
    if not uri:
        raise RuntimeError("ไม่พบ ORDER_URI_MONGO ใน env")
    _ORDER_CLIENT = MongoClient(uri, serverSelectionTimeoutMS=5000)
    return _ORDER_CLIENT


def _get_order_collection():
    """คืน PyMongo collection สำหรับ orders."""
    client = _get_order_client()
    db_name = os.environ.get("ORDER_DB", "dbWallet")
    coll_name = os.environ.get("ORDER_COLLECTION", "ShpOrders")
    return client[db_name][coll_name]


# ---- Order SN extraction ------------------------------------------------------

# pattern จับ order_sn จากข้อความ — Shopee order_sn มักเป็นตัวอักษร+ตัวเลข 12-20 ตัว
# เช่น 240215MCEQMT60, 220713BG7P7PG1
_ORDER_SN_RE = re.compile(
    r"(?:order[:\s]*|คำสั่งซื้อ[:\s]*|เลขคำสั่งซื้อ[:\s]*|เลขที่คำสั่งซื้อ[:\s]*|order_sn[:\s]*)?"
    r"([0-9]{6,}[A-Z][0-9A-Z]{5,})",
    re.IGNORECASE,
)

# pattern สำหรับ [order: XXX] tag (เหมือน [สินค้า: item_id])
_ORDER_TAG_RE = re.compile(
    r"\[(?:order|คำสั่งซื้อ)[:\s]*([^\]]+)\]",
    re.IGNORECASE,
)


def extract_order_sn(message: str) -> str | None:
    """ดึง order_sn จากข้อความลูกค้า.

    รองรับ:
    - [order: 240215MCEQMT60]
    - [คำสั่งซื้อ: 240215MCEQMT60]
    - เลขคำสั่งซื้อ 240215MCEQMT60
    - 240215MCEQMT60 (ถ้าดูเหมือน order_sn)

    คืน order_sn หรือ None.
    """
    if not message:
        return None
    # ลอง tag format ก่อน
    m = _ORDER_TAG_RE.search(message)
    if m:
        sn = m.group(1).strip()
        if sn:
            return sn
    # ลอง pattern ทั่วไป
    m = _ORDER_SN_RE.search(message)
    if m:
        return m.group(1).strip()
    return None


# ---- Order status mapping -----------------------------------------------------

_ORDER_STATUS_TH: dict[str, str] = {
    "UNPAID": "ยังไม่ชำระเงิน",
    "READY_TO_SHIP": "พร้อมจัดส่ง",
    "PROCESSED": "กำลังเตรียมจัดส่ง",
    "SHIPPED": "จัดส่งแล้ว",
    "TO_CONFIRM_RECEIVE": "รอยืนยันรับสินค้า",
    "COMPLETED": "สำเร็จแล้ว (ได้รับสินค้าแล้ว)",
    "CANCELLED": "ยกเลิกแล้ว",
    "TO_RETURN": "รอคืนสินค้า/คืนเงิน",
    "RETRY_SHIP": "กำลังจัดส่งใหม่",
    "": "ไม่ระบุสถานะ",
}

_LOGISTICS_STATUS_TH: dict[str, str] = {
    "LOGISTICS_NOT_START": "ยังไม่เริ่มจัดส่ง",
    "LOGISTICS_READY": "พร้อมจัดส่ง",
    "LOGISTICS_REQUEST_CREATED": "สร้างคำขอจัดส่งแล้ว",
    "LOGISTICS_PICKUP_DONE": "ขนส่งรับพัสดุแล้ว",
    "LOGISTICS_PICKUP_RETRY": "ขนส่งรับพัสดุใหม่",
    "LOGISTICS_PICKUP_FAILED": "ขนส่งรับพัสดุไม่สำเร็จ",
    "LOGISTICS_DELIVERY_DONE": "จัดส่งถึงปลายทางแล้ว",
    "LOGISTICS_DELIVERY_FAILED": "จัดส่งไม่สำเร็จ",
    "LOGISTICS_LOST": "พัสดุสูญหาย",
    "LOGISTICS_INVALID": "สถานะไม่ถูกต้อง",
    "LOGISTICS_REQUEST_CANCELED": "ยกเลิกคำขอจัดส่ง",
    "": "",
}


def _map_order_status(status: str) -> str:
    """แปล order_status เป็นภาษาไทย."""
    return _ORDER_STATUS_TH.get(status, status or "ไม่ระบุ")


def _map_logistics_status(status: str) -> str:
    """แปล logistics_status เป็นภาษาไทย."""
    return _LOGISTICS_STATUS_TH.get(status, status or "")


def _format_create_time(ts: Any) -> str:
    """แปล create_time (unix timestamp) เป็นวันที่ภาษาไทย."""
    if not ts:
        return "ไม่ระบุ"
    try:
        # Shopee create_time มักเป็น unix timestamp (seconds)
        dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        # แปลเป็นเวลาไทย (UTC+7)
        from datetime import timedelta
        dt_th = dt + timedelta(hours=7)
        months = [
            "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
            "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
        ]
        return f"{dt_th.day} {months[dt_th.month]} {dt_th.year + 543}"
    except Exception:
        return str(ts)


# ---- Lookup -------------------------------------------------------------------

def lookup_order(order_sn: str, shop_filter: str | None = None) -> dict[str, Any] | None:
    """ดึงข้อมูล order จาก MongoDB ตาม order_sn.

    Args:
        order_sn: เลขคำสั่งซื้อ
        shop_filter: ชื่อร้าน (optional — กรองเฉพาะร้านที่ระบุ)

    Returns:
        dict ที่มี:
        - order_sn: str
        - order_status: str (ภาษาไทย)
        - order_status_raw: str (original)
        - logistics_status: str (ภาษาไทย)
        - logistics_status_raw: str (original)
        - items: list[{name, quantity, model_name}]
        - shipping_carrier: str
        - create_time: str (วันที่ภาษาไทย)
        - shopname: str
        - found: True

        หรือ None ถ้าไม่พบ.
    """
    try:
        coll = _get_order_collection()
        query: dict[str, Any] = {"order_sn": order_sn}
        if shop_filter:
            query["shopname"] = shop_filter
        doc = coll.find_one(query)
        if not doc:
            # ลองไม่กรอง shop
            if shop_filter:
                doc = coll.find_one({"order_sn": order_sn})
            if not doc:
                return None

        # ดึง items
        items = []
        for item in doc.get("item_list", []):
            name = item.get("item_name") or item.get("model_name") or ""
            model_name = item.get("model_name") or ""
            qty = item.get("model_quantity_purchased") or 1
            items.append({
                "name": name,
                "model_name": model_name,
                "quantity": int(qty) if qty else 1,
            })

        # ดึง logistics_status จาก package_list
        logistics_status_raw = ""
        shipping_carrier = doc.get("shipping_carrier") or ""
        pkg_list = doc.get("package_list") or []
        if pkg_list:
            pkg = pkg_list[0]
            logistics_status_raw = pkg.get("logistics_status") or ""
            if not shipping_carrier:
                shipping_carrier = pkg.get("shipping_carrier") or ""

        order_status_raw = doc.get("order_status") or ""

        return {
            "order_sn": doc.get("order_sn") or order_sn,
            "order_status": _map_order_status(order_status_raw),
            "order_status_raw": order_status_raw,
            "logistics_status": _map_logistics_status(logistics_status_raw),
            "logistics_status_raw": logistics_status_raw,
            "items": items,
            "item_count": len(items),
            "total_quantity": sum(i["quantity"] for i in items),
            "shipping_carrier": shipping_carrier or "ไม่ระบุ",
            "create_time": _format_create_time(doc.get("create_time")),
            "shopname": doc.get("shopname") or "",
            "found": True,
        }
    except PyMongoError as e:
        print(f"[ORDER_STORE] MongoDB error: {e}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[ORDER_STORE] error: {e}", file=sys.stderr)
        return None


def build_order_context(order: dict[str, Any]) -> str:
    """สร้าง context string สำหรับส่งให้ LLM.

    รูปแบบ:
    === ข้อมูลคำสั่งซื้อ ===
    เลขที่คำสั่งซื้อ: 240215MCEQMT60
    สถานะ: จัดส่งแล้ว
    สถานะขนส่ง: ขนส่งรับพัสดุแล้ว
    วันที่สั่งซื้อ: 15 ก.พ. 2567
    ขนส่ง: Kerry
    สินค้า:
    - [ชื่อสินค้า] (รุ่น: XXX) จำนวน 1 ชิ้น
    - ...
    รวม 2 ชิ้น 2 รายการ
    """
    if not order or not order.get("found"):
        return ""

    lines = ["=== ข้อมูลคำสั่งซื้อ ==="]
    lines.append(f"เลขที่คำสั่งซื้อ: {order['order_sn']}")
    lines.append(f"สถานะ: {order['order_status']}")
    if order.get("logistics_status"):
        lines.append(f"สถานะขนส่ง: {order['logistics_status']}")
    lines.append(f"วันที่สั่งซื้อ: {order['create_time']}")
    lines.append(f"ขนส่ง: {order['shipping_carrier']}")

    items = order.get("items", [])
    if items:
        lines.append("สินค้า:")
        for item in items:
            name = item["name"]
            model = item.get("model_name", "")
            qty = item["quantity"]
            if model and model != name:
                lines.append(f"- {name} (รุ่น: {model}) จำนวน {qty} ชิ้น")
            else:
                lines.append(f"- {name} จำนวน {qty} ชิ้น")
        lines.append(f"รวม {order.get('total_quantity', 0)} ชิ้น {order.get('item_count', 0)} รายการ")

    return "\n".join(lines)


# ---- Test ----

if __name__ == "__main__":
    # ทดสอบ: python -m shopeechat.order_store
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

    # ทดสอบ extract
    tests = [
        "[order: 240215MCEQMT60]",
        "[คำสั่งซื้อ: 240215MCEQMT60]",
        "เลขคำสั่งซื้อ 240215MCEQMT60 ส่งถึงไหนแล้ว",
        "240215MCEQMT60",
        "ขอดูสถานะ order 240215MCEQMT60 หน่อย",
    ]
    print("=== extract_order_sn ===")
    for t in tests:
        sn = extract_order_sn(t)
        print(f"  {t!r:50s} → {sn}")

    # ทดสอบ lookup
    print("\n=== lookup_order ===")
    sn = "240215MCEQMT60"
    order = lookup_order(sn)
    if order:
        print(build_order_context(order))
    else:
        print(f"ไม่พบ order {sn}")
