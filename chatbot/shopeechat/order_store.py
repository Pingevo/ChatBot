"""ดึงข้อมูล order จาก MongoDB (read-only) เพื่อส่งให้ LLM ตอบลูกค้า.

ใช้ env:
- ORDER_URI_MONGO — connection string
- ORDER_DB — database name (เช่น dbWallet)
- ORDER_COLLECTION — collection name (เช่น ShpOrders)

ข้อมูลที่ดึง (Phase 3C — ขยายจากเดิม):
- สถานะ order (order_status + logistics_status)
- สินค้าใน order (item_list: ชื่อ + จำนวน + ราคา + รูป)
- ขนส่ง (shipping_carrier + tracking_no)
- วันที่สั่งซื้อ (create_time)
- วันที่ชำระเงิน (pay_time)
- วันที่ส่ง (ship_by_date, pickup_done_time)
- วันที่ถึง (update_time เมื่อ COMPLETED / logistics_status=DELIVERY_DONE)
- ที่อยู่ลูกค้า (recipient_address)
- ราคารวม (total_amount) + ค่าส่ง (estimated_shipping_fee)
- วิธีชำระเงิน (payment_method, cod)
- สถานะยกเลิก (cancel_by, cancel_reason)
- วันที่ส่งภายในกี่วัน (days_to_ship)
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


# ---- Tracking number extraction (Phase 1B) ------------------------------------

# pattern จับ tracking number จากข้อความ / vision OCR
# รองรับ:
# - ไปรษณีย์ไทย (ED + 9 ตัว + TH): ED123456789TH
# - Kerry (K + 8 ตัว): K12345678
# - Flash Express (F + ตัวเลข): F1234567890
# - J&T (JT + ตัวเลข): JT1234567890
# - DHL (ตัวเลข 10 หลัก): 1234567890
# - ตัวเลข 10-20 หลักทั่วไป (tracking ส่วนใหญ่)
# - ตัวอักษร+ตัวเลข 8-25 ตัว (กว้าง — รองรับขนส่งใหม่)
_TRACKING_RE = re.compile(
    r"(?:tracking[:\s]*|พัสดุ[:\s]*|เลขพัสดุ[:\s]*|เลขติดตาม[:\s]*|waybill[:\s]*)?"
    r"\b([A-Z]{0,6}\d{8,20}[A-Z]{0,3})\b",
    re.IGNORECASE,
)


def extract_tracking_number(message: str) -> str | None:
    """ดึง tracking number จากข้อความ / vision OCR text.

    รองรับ:
    - "tracking K12345678"
    - "เลขพัสดุ ED123456789TH"
    - "F1234567890"
    - "JT1234567890"
    - ตัวเลข 10-20 หลักทั่วไป

    คืน tracking number (normalized — ตัดช่องว่าง) หรือ None.
    """
    if not message:
        return None
    # ลอง pattern แบบมี prefix ก่อน (tracking/พัสดุ/ฯลฯ)
    m = _TRACKING_RE.search(message)
    if m:
        tn = m.group(1).strip().upper().replace(" ", "")
        # กรอง false positive — ตัวเลขอย่างเดียวสั้นเกินไป หรือเป็นเบอร์โทร
        if len(tn) < 8:
            return None
        # ไม่ใช่เบอร์โทร (เบอร์ไทย 08/09 + 8 หลัก = 10 หลัก ติดกัน)
        if re.match(r"^0[89]\d{8}$", tn):
            return None
        return tn
    return None


def _normalize_tracking(tn: str) -> str:
    """Normalize tracking number — ตัดช่องว่าง + ใหญ่."""
    if not tn:
        return ""
    return tn.strip().upper().replace(" ", "").replace("-", "")


def lookup_by_tracking(
    tracking_no: str,
    shop_filter: str | None = None,
) -> dict[str, Any] | None:
    """ค้น order จาก tracking number (MongoDB only).

    ค้นใน package_list ทุก entry ใน field:
    - tracking_no
    - tracking_number
    - parcel_id
    - waybill_id

    Args:
        tracking_no: เลขพัสดุ
        shop_filter: ชื่อร้าน (optional)

    Returns:
        dict เหมือน lookup_order หรือ None ถ้าไม่พบ.
    """
    tn = _normalize_tracking(tracking_no)
    if not tn:
        return None
    try:
        coll = _get_order_collection()
        # ค้นใน package_list ทุก field ที่อาจเก็บ tracking
        _tk_fields = ["tracking_no", "tracking_number", "parcel_id", "waybill_id"]
        query: dict[str, Any] = {
            "$or": [{f"package_list.{f}": tn} for f in _tk_fields]
        }
        if shop_filter:
            query["shopname"] = shop_filter
        doc = coll.find_one(query)
        if not doc:
            # ลองไม่กรอง shop
            if shop_filter:
                doc = coll.find_one({"$or": [{f"package_list.{f}": tn} for f in _tk_fields]})
            if not doc:
                return None
        # ใช้ lookup_order เพื่อ parse เดียวกัน (DRY)
        return lookup_order(doc.get("order_sn") or "", shop_filter=shop_filter)
    except PyMongoError as e:
        print(f"[ORDER_STORE] lookup_by_tracking MongoDB error: {e}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[ORDER_STORE] lookup_by_tracking error: {e}", file=sys.stderr)
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
    return _format_unix_ts(ts)


def _format_unix_ts(ts: Any) -> str:
    """แปล unix timestamp (seconds) เป็นวันที่ภาษาไทย (UTC+7, พ.ศ.).

    รองรับ:
    - int/float unix timestamp (seconds)
    - 0 / None / "" → "ไม่ระบุ"
    - ISO string (เช่น "2026-06-02T17:50:36+07:00") → parse ตรงๆ
    """
    if not ts or ts == 0:
        return "ไม่ระบุ"
    # ISO string (เช่น update_time)
    if isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts)
            from datetime import timedelta
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dt_th = dt.astimezone(timezone(timedelta(hours=7)))
            months = _THAI_MONTHS
            return f"{dt_th.day} {months[dt_th.month]} {dt_th.year + 543}"
        except Exception:
            return str(ts)
    try:
        dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        from datetime import timedelta
        dt_th = dt + timedelta(hours=7)
        months = _THAI_MONTHS
        return f"{dt_th.day} {months[dt_th.month]} {dt_th.year + 543}"
    except Exception:
        return str(ts)


def _format_unix_ts_with_time(ts: Any) -> str:
    """แปล unix timestamp เป็นวันที่+เวลาภาษาไทย (เช่น '15 ก.พ. 2567 14:30')."""
    if not ts or ts == 0:
        return "ไม่ระบุ"
    if isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts)
            from datetime import timedelta
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dt_th = dt.astimezone(timezone(timedelta(hours=7)))
            months = _THAI_MONTHS
            return f"{dt_th.day} {months[dt_th.month]} {dt_th.year + 543} {dt_th.hour:02d}:{dt_th.minute:02d}"
        except Exception:
            return str(ts)
    try:
        dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        from datetime import timedelta
        dt_th = dt + timedelta(hours=7)
        months = _THAI_MONTHS
        return f"{dt_th.day} {months[dt_th.month]} {dt_th.year + 543} {dt_th.hour:02d}:{dt_th.minute:02d}"
    except Exception:
        return str(ts)


# เดือนไทย — ใช้ร่วมกันทุก format function
_THAI_MONTHS = [
    "", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
]


def _format_address(addr: dict | None) -> str:
    """แปล recipient_address dict เป็น string อ่านง่าย (ปกปิดข้อมูล sensitive)."""
    if not addr or not isinstance(addr, dict):
        return ""
    parts = []
    # name + phone ถูกปกปิดจาก Shopee อยู่แล้ว (เช่น "ล******ง")
    name = addr.get("name", "")
    phone = addr.get("phone", "")
    full_address = addr.get("full_address", "")
    city = addr.get("city", "")
    state = addr.get("state", "")
    zipcode = addr.get("zipcode", "")

    # ใช้ full_address ถ้ามี (ครบที่สุด)
    if full_address:
        parts.append(full_address)
    else:
        # ประกอบจาก city + state + zipcode
        sub_parts = []
        if city:
            sub_parts.append(city)
        if state:
            sub_parts.append(state)
        if zipcode:
            sub_parts.append(zipcode)
        if sub_parts:
            parts.append(" ".join(sub_parts))

    # แสดงชื่อ+เบอร์ (ปกปิดแล้ว) เพื่อยืนยันตัวตน
    if name:
        parts.append(f"ชื่อ: {name}")
    if phone:
        parts.append(f"เบอร์: {phone}")

    return " · ".join(parts) if parts else ""


# ---- Lookup -------------------------------------------------------------------

def lookup_order(order_sn: str, shop_filter: str | None = None) -> dict[str, Any] | None:
    """ดึงข้อมูล order จาก MongoDB ตาม order_sn.

    Args:
        order_sn: เลขคำสั่งซื้อ
        shop_filter: ชื่อร้าน (optional — กรองเฉพาะร้านที่ระบุ)

    Returns:
        dict ที่มี (Phase 3C — ขยายจากเดิม):
        - order_sn: str
        - order_status: str (ภาษาไทย)
        - order_status_raw: str (original)
        - logistics_status: str (ภาษาไทย)
        - logistics_status_raw: str (original)
        - items: list[{name, quantity, model_name, price, original_price, image_url, sku, item_id, model_id}]
        - shipping_carrier: str
        - tracking_no: str
        - tracking_numbers: list[str]
        - create_time: str (วันที่สั่งซื้อ ภาษาไทย)
        - pay_time: str (วันที่ชำระเงิน ภาษาไทย)
        - ship_by_date: str (วันที่ส่งกำหนด ภาษาไทย)
        - pickup_done_time: str (วันที่ขนส่งรับพัสดุ ภาษาไทย)
        - delivery_time: str (วันที่ส่งถึง ภาษาไทย — จาก update_time เมื่อ COMPLETED)
        - update_time: str (วันที่อัปเดตล่าสุด ภาษาไทย)
        - recipient_address: str (ที่อยู่ลูกค้า ปกปิด sensitive)
        - total_amount: float
        - currency: str
        - estimated_shipping_fee: float
        - actual_shipping_fee: float
        - payment_method: str
        - cod: bool (เก็บเงินปลายทาง)
        - days_to_ship: int
        - cancel_by: str
        - cancel_reason: str
        - buyer_cancel_reason: str
        - buyer_username: str
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
            # ⚡ Phase 1C — เพิ่ม variant/price/image/brand สำหรับ order panel
            _price = item.get("model_discounted_price") or item.get("model_original_price") or 0
            _orig_price = item.get("model_original_price") or 0
            _image_info = item.get("image_info") or {}
            _image_url = _image_info.get("image_url") if isinstance(_image_info, dict) else ""
            # model_sku มักมี brand prefix (เช่น ZMI-HA716-CN-WH)
            _sku = item.get("model_sku") or item.get("item_sku") or ""
            items.append({
                "name": name,
                "model_name": model_name,
                "quantity": int(qty) if qty else 1,
                "price": float(_price) if _price else 0.0,
                "original_price": float(_orig_price) if _orig_price else 0.0,
                "image_url": _image_url or "",
                "sku": _sku,
                "item_id": str(item.get("item_id") or "").replace(".0", ""),
                "model_id": str(item.get("model_id") or "").replace(".0", ""),
            })

        # ดึง logistics_status + tracking_no จาก package_list
        # ⚡ Phase 1B — ดึงจากทุก entry ไม่ใช่แค่ entry แรก
        logistics_status_raw = ""
        shipping_carrier = doc.get("shipping_carrier") or ""
        tracking_numbers: list[str] = []
        pkg_list = doc.get("package_list") or []
        if pkg_list:
            for pkg in pkg_list:
                _pkg_status = pkg.get("logistics_status") or ""
                if _pkg_status and not logistics_status_raw:
                    logistics_status_raw = _pkg_status
                _pkg_carrier = pkg.get("shipping_carrier") or ""
                if _pkg_carrier and not shipping_carrier:
                    shipping_carrier = _pkg_carrier
                # ⚡ tracking_no อาจอยู่ในหลาย field — เก็บทุกที่ที่เจอ
                for _tk in ("tracking_no", "tracking_number", "parcel_id", "waybill_id"):
                    _tn = pkg.get(_tk)
                    if _tn and str(_tn).strip() and str(_tn).strip() not in tracking_numbers:
                        tracking_numbers.append(str(_tn).strip())

        order_status_raw = doc.get("order_status") or ""

        # ⚡ Phase 3C — ดึงฟิลด์เพิ่ม
        _pay_time = doc.get("pay_time")
        _ship_by_date = doc.get("ship_by_date")
        _pickup_done_time = doc.get("pickup_done_time")
        _update_time = doc.get("update_time") or doc.get("update_time_unix")
        _recipient_address = doc.get("recipient_address")
        _cod = doc.get("cod")
        _estimated_shipping_fee = doc.get("estimated_shipping_fee") or 0
        _actual_shipping_fee = doc.get("actual_shipping_fee") or 0
        _days_to_ship = doc.get("days_to_ship") or 0
        _cancel_by = doc.get("cancel_by") or ""
        _cancel_reason = doc.get("cancel_reason") or ""
        _buyer_cancel_reason = doc.get("buyer_cancel_reason") or ""

        # วันที่ส่งถึง — ใช้ update_time เมื่อ order_status=COMPLETED หรือ logistics=DELIVERY_DONE
        _delivery_time = "ไม่ระบุ"
        if order_status_raw == "COMPLETED" or logistics_status_raw == "LOGISTICS_DELIVERY_DONE":
            _delivery_time = _format_unix_ts(_update_time)

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
            "tracking_no": tracking_numbers[0] if tracking_numbers else "",
            "tracking_numbers": tracking_numbers,  # ทุก tracking ถ้ามีหลาย package
            "create_time": _format_create_time(doc.get("create_time")),
            "create_time_raw": doc.get("create_time"),  # ⚡ Phase 1C — unix ts สำหรับ warranty calc
            # ⚡ Phase 3C — ฟิลด์ใหม่
            "pay_time": _format_unix_ts(_pay_time),
            "ship_by_date": _format_unix_ts(_ship_by_date),
            "pickup_done_time": _format_unix_ts(_pickup_done_time),
            "delivery_time": _delivery_time,
            "update_time": _format_unix_ts(_update_time),
            "recipient_address": _format_address(_recipient_address) if isinstance(_recipient_address, dict) else "",
            "estimated_shipping_fee": float(_estimated_shipping_fee) if _estimated_shipping_fee else 0.0,
            "actual_shipping_fee": float(_actual_shipping_fee) if _actual_shipping_fee else 0.0,
            "days_to_ship": int(_days_to_ship) if _days_to_ship else 0,
            "cod": bool(_cod) if _cod is not None else False,
            "cancel_by": _cancel_by,
            "cancel_reason": _cancel_reason,
            "buyer_cancel_reason": _buyer_cancel_reason,
            "shopname": doc.get("shopname") or "",
            "total_amount": float(doc.get("total_amount") or 0),
            "currency": doc.get("currency") or "THB",
            "buyer_username": doc.get("buyer_username") or "",
            "payment_method": doc.get("payment_method") or "",
            "found": True,
        }
    except PyMongoError as e:
        print(f"[ORDER_STORE] MongoDB error: {e}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[ORDER_STORE] error: {e}", file=sys.stderr)
        return None


def lookup_orders_by_buyer(
    buyer_username: str,
    shop_filter: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """ดึง order history ของลูกค้าจาก buyer_username (MongoDB only).

    ⚡ Phase 1C — สำหรับ ticket panel ด้านขวา แสดงประวัติการสั่งซื้อ

    Args:
        buyer_username: ชื่อผู้ซื้อ (Shopee buyer_username)
        shop_filter: ชื่อร้าน (optional)
        limit: จำนวนสูงสุด (default 20)

    Returns:
        list ของ order dict (เหมือน lookup_order) เรียงจากใหม่→เก่า
    """
    try:
        coll = _get_order_collection()
        query: dict[str, Any] = {"buyer_username": buyer_username}
        if shop_filter:
            query["shopname"] = shop_filter
        cursor = coll.find(query).sort("create_time", -1).limit(limit)
        results = []
        for doc in cursor:
            # reuse lookup_order เพื่อ parse เดียวกัน (DRY)
            order = lookup_order(doc.get("order_sn") or "", shop_filter=shop_filter)
            if order:
                results.append(order)
        return results
    except PyMongoError as e:
        print(f"[ORDER_STORE] lookup_orders_by_buyer MongoDB error: {e}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"[ORDER_STORE] lookup_orders_by_buyer error: {e}", file=sys.stderr)
        return []


def build_order_context(order: dict[str, Any]) -> str:
    """สร้าง context string สำหรับส่งให้ LLM.

    ⚡ Phase 3C — ขยายให้ครบ: วันที่ซื้อ/ชำระ/ส่ง/ถึง, ที่อยู่, ราคา, วิธีชำระ, สถานะ, ขนส่ง, สินค้า+ราคา

    รูปแบบ:
    === ข้อมูลคำสั่งซื้อ ===
    เลขที่คำสั่งซื้อ: 240215MCEQMT60
    สถานะ: จัดส่งแล้ว
    สถานะขนส่ง: ขนส่งรับพัสดุแล้ว
    วันที่สั่งซื้อ: 15 ก.พ. 2567
    วันที่ชำระเงิน: 15 ก.พ. 2567
    วันที่ส่งกำหนด: 17 ก.พ. 2567
    วันที่ขนส่งรับพัสดุ: 16 ก.พ. 2567
    วันที่ส่งถึง: ไม่ระบุ
    ขนส่ง: Kerry
    เลขพัสดุ: SPX1234567890
    ที่อยู่จัดส่ง: ****** คลองโยง อำเภอพุทธมณฑล จังหวัดนครปฐม 73170
    วิธีชำระเงิน: บัตรเครดิต (ไม่ใช่เก็บเงินปลายทาง)
    ราคารวม: 2,206 บาท
    ค่าส่ง: 48 บาท
    สินค้า:
    - [ชื่อสินค้า] (รุ่น: XXX) จำนวน 2 ชิ้น ราคา 1,079 บาท/ชิ้น (จาก 1,590 บาท)
    - ...
    รวม 2 ชิ้น 2 รายการ ยอดรวม 2,206 บาท
    """
    if not order or not order.get("found"):
        return ""

    lines = ["=== ข้อมูลคำสั่งซื้อ ==="]
    lines.append(f"เลขที่คำสั่งซื้อ: {order['order_sn']}")
    lines.append(f"สถานะ: {order['order_status']}")
    if order.get("logistics_status"):
        lines.append(f"สถานะขนส่ง: {order['logistics_status']}")

    # วันที่ต่างๆ
    lines.append(f"วันที่สั่งซื้อ: {order['create_time']}")
    if order.get("pay_time") and order["pay_time"] != "ไม่ระบุ":
        lines.append(f"วันที่ชำระเงิน: {order['pay_time']}")
    if order.get("ship_by_date") and order["ship_by_date"] != "ไม่ระบุ":
        lines.append(f"วันที่ส่งกำหนด: {order['ship_by_date']}")
    if order.get("pickup_done_time") and order["pickup_done_time"] != "ไม่ระบุ":
        lines.append(f"วันที่ขนส่งรับพัสดุ: {order['pickup_done_time']}")
    if order.get("delivery_time") and order["delivery_time"] != "ไม่ระบุ":
        lines.append(f"วันที่ส่งถึง: {order['delivery_time']}")
    if order.get("update_time") and order["update_time"] != "ไม่ระบุ":
        lines.append(f"วันที่อัปเดตล่าสุด: {order['update_time']}")

    # ขนส่ง + tracking
    lines.append(f"ขนส่ง: {order['shipping_carrier']}")
    _tracking = order.get("tracking_no") or ""
    _all_tracking = order.get("tracking_numbers") or []
    if _all_tracking and len(_all_tracking) > 1:
        lines.append(f"เลขพัสดุ: {', '.join(_all_tracking)}")
    elif _tracking:
        lines.append(f"เลขพัสดุ: {_tracking}")

    # ที่อยู่
    _addr = order.get("recipient_address") or ""
    if _addr:
        lines.append(f"ที่อยู่จัดส่ง: {_addr}")

    # วิธีชำระเงิน
    _payment = order.get("payment_method") or ""
    _cod = order.get("cod")
    if _cod:
        lines.append("วิธีชำระเงิน: เก็บเงินปลายทาง (COD)")
    elif _payment:
        lines.append(f"วิธีชำระเงิน: {_payment}")
    else:
        lines.append("วิธีชำระเงิน: ไม่ระบุ")

    # ราคา
    _total = order.get("total_amount", 0)
    _currency = order.get("currency", "THB")
    _est_ship = order.get("estimated_shipping_fee", 0)
    if _total:
        lines.append(f"ราคารวม: {_total:,.0f} {_currency}")
    if _est_ship:
        lines.append(f"ค่าส่ง (โดยประมาณ): {_est_ship:,.0f} {_currency}")

    # สถานะยกเลิก
    _cancel_by = order.get("cancel_by") or ""
    _cancel_reason = order.get("cancel_reason") or ""
    _buyer_cancel = order.get("buyer_cancel_reason") or ""
    if _cancel_by:
        _cancel_text = f"ยกเลิกโดย: {_cancel_by}"
        if _cancel_reason:
            _cancel_text += f" (เหตุผล: {_cancel_reason})"
        elif _buyer_cancel and _buyer_cancel != _cancel_reason:
            _cancel_text += f" (เหตุผล: {_buyer_cancel})"
        lines.append(_cancel_text)

    # วันที่ส่งภายในกี่วัน
    _days = order.get("days_to_ship") or 0
    if _days:
        lines.append(f"ส่งภายใน: {_days} วัน")

    # สินค้า
    items = order.get("items", [])
    if items:
        lines.append("สินค้า:")
        for item in items:
            name = item["name"]
            model = item.get("model_name", "")
            qty = item["quantity"]
            price = item.get("price", 0)
            orig_price = item.get("original_price", 0)
            # สร้างบรรทัดสินค้า
            if model and model != name:
                _item_line = f"- {name} (รุ่น: {model}) จำนวน {qty} ชิ้น"
            else:
                _item_line = f"- {name} จำนวน {qty} ชิ้น"
            # เพิ่มราคา
            if price:
                if orig_price and orig_price > price:
                    _item_line += f" ราคา {price:,.0f} บาท/ชิ้น (จาก {orig_price:,.0f} บาท)"
                else:
                    _item_line += f" ราคา {price:,.0f} บาท/ชิ้น"
            lines.append(_item_line)
        _total_qty = order.get("total_quantity", 0)
        _total_items = order.get("item_count", 0)
        _summary = f"รวม {_total_qty} ชิ้น {_total_items} รายการ"
        if _total:
            _summary += f" ยอดรวม {_total:,.0f} {_currency}"
        lines.append(_summary)

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
