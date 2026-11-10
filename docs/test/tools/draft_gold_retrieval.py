"""Draft gold_retrieval rows from existing replay outputs for human review."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from eval_retrieval import classify_answer_mode, load_results

MANUAL_CASES = [
    {
        "id": "compat-mi17-history-cable",
        "shop": "KingGadgets",
        "message": "อยากได้ที่ใช้กับ mi 17 ultra",
        "history": [{"role": "user", "text": "มีสายชาร์จไหม"}],
        "intent": "compatibility",
        "expected_answer_mode": "products",
        "acceptable_item_ids": [],
        "must_not_item_ids": [],
        "must_not_phrases": ["ไม่มีสินค้าที่ใช้ได้", "สินค้าหมดสต็อกทั้งหมด"],
        "expected_product_type": "charger",
        "expected_subtype": "cable",
        "expected_target_device": "mi 17 ultra",
        "expected_catalog_status": "",
        "requires_evidence": ["compatibility"],
        "note": "manual gate: follow-up must carry cable/charger from history",
    },
    {
        "id": "compat-iphone13-cable",
        "shop": "ZMIThailand",
        "message": "สายชาร์จใช้กับ iPhone 13 ได้ไหม",
        "history": [],
        "intent": "compatibility",
        "expected_answer_mode": "products",
        "acceptable_item_ids": [],
        "must_not_item_ids": [],
        "must_not_phrases": ["ไม่มีสินค้าที่ใช้ได้", "สินค้าหมดสต็อกทั้งหมด"],
        "expected_product_type": "charger",
        "expected_subtype": "cable",
        "expected_target_device": "iphone 13",
        "expected_catalog_status": "",
        "requires_evidence": ["compatibility"],
        "note": "manual gate: device name must not become product family",
    },
]

CORRECTED = {
    "q079": {"note": "corrected:handoff to admin for return/exchange"},
    "q184": {
        "expected_answer_mode": "recommend",
        "expected_product_type": "cctv",
        "acceptable_item_ids": ["24660887364", "24063024401"],
        "must_not_item_ids": ["15149115649", "7216867207", "10572967788", "18706557305"],
        "note": "corrected:iSUPER Dash Cam Lite Plus/Pro2 exist; shown items were wrong category",
    },
    "q187": {
        "acceptable_item_ids": ["16792816023", "22460941701"],
        "note": "corrected:CUKTECH AC30S/AC30T/AC301 exist in ZMIThailand",
    },
    "compat-iphone13-cable": {
        "acceptable_item_ids": ["51666380159", "45966405338"],
        "note": "corrected:CTL301 30W+ cables compatible with iphone 13",
    },
    "compat-mi17-history-cable": {
        "acceptable_item_ids": ["26103699718", "49767569381", "52967557054", "49767573329", "50767549208"],
        "note": "corrected:KingGadgets has compatible cable/adapter/powerbank for mi 17 ultra",
    },
    "q005": {
        "expected_answer_mode": "no_such_type",
        "must_not_item_ids": ["4279856514", "4118165339", "4115718484", "1276571008"],
        "must_not_phrases": ["ทางร้านมีสายชาร์จ Type-C"],
        "note": "corrected:no type-c cable in shop; must say so before offering alternatives",
    },
    "q007": {
        "expected_answer_mode": "recommend",
        "acceptable_item_ids": ["4750449123", "4852454641", "3829062944"],
        "note": "corrected:wireless chargers in stock were not recommended",
    },
    "q245": {
        "expected_answer_mode": "recommend",
        "expected_product_type": "cctv",
        "acceptable_item_ids": ["41473310161"],
        "must_not_phrases": ["ไม่พบสินค้า"],
        "note": "corrected:Xiaomi Camera C201 (XMIC201) exists in stock",
    },
    "q203": {
        "expected_answer_mode": "recommend",
        "acceptable_item_ids": ["4253586372", "8513170022", "6255113830", "11694844668"],
        "must_not_phrases": ["หมดสต็อกชั่วคราวทุกรุ่น", "หมดสต็อกทุกรุ่น"],
        "note": "corrected:speakers/earphones in stock; false out-of-stock claim",
    },
    "q204": {
        "expected_answer_mode": "no_such_type",
        "must_not_phrases": ["Redmi Note", "สมาร์ทโฟน Xiaomi"],
        "note": "corrected:ZMI sells no phones; must not fabricate models",
    },
    "q047": {"note": "corrected:state Thai-center warranty or handoff to admin"},
    "q051": {"requires_evidence": ["warranty"], "note": "corrected:must state warranty duration"},
}

EXTRA_MANUAL = [
    {
        "id": "oos-hagibis-hdmi-vga", "shop": "SuperITMall",
        "message": "Hagibis HDMI to VGA มีไหมครับ", "history": [],
        "intent": "exact_model", "expected_answer_mode": "out_of_stock",
        "acceptable_item_ids": ["21637491034"], "must_not_item_ids": [],
        "must_not_phrases": ["พร้อมส่ง", "ไม่มีสินค้ารุ่นนี้"],
        "expected_product_type": "", "expected_subtype": "", "expected_target_device": "",
        "expected_catalog_status": "active", "requires_evidence": [],
        "note": "oos gate: NORMAL listing, stock_info current_stock=0",
    },
    {
        "id": "oos-hagibis-monitor-stand", "shop": "SuperITMall",
        "message": "Hagibis Monitor Stand ZD1 ยังมีขายไหม", "history": [],
        "intent": "exact_model", "expected_answer_mode": "out_of_stock",
        "acceptable_item_ids": ["12395909725"], "must_not_item_ids": [],
        "must_not_phrases": ["พร้อมส่ง", "ไม่มีสินค้ารุ่นนี้"],
        "expected_product_type": "", "expected_subtype": "", "expected_target_device": "",
        "expected_catalog_status": "active", "requires_evidence": [],
        "note": "oos gate: NORMAL listing, stock_info current_stock=0",
    },
    {
        "id": "oos-hagibis-imac-hub", "shop": "SuperITMall",
        "message": "Hagibis iMac USB Hub IMC01H มีไหมครับ", "history": [],
        "intent": "exact_model", "expected_answer_mode": "out_of_stock",
        "acceptable_item_ids": ["14391644472"], "must_not_item_ids": [],
        "must_not_phrases": ["พร้อมส่ง", "ไม่มีสินค้ารุ่นนี้"],
        "expected_product_type": "", "expected_subtype": "", "expected_target_device": "",
        "expected_catalog_status": "active", "requires_evidence": [],
        "note": "oos gate: NORMAL listing, stock_info current_stock=0",
    },
    {
        "id": "unlist-imilab-c21", "shop": "IMILabThailand",
        "message": "IMILAB C21 มีไหมครับ", "history": [],
        "intent": "exact_model", "expected_answer_mode": "discontinued",
        "acceptable_item_ids": ["22109357437", "7592077465"], "must_not_item_ids": [],
        "must_not_phrases": ["พร้อมส่ง", "มีสต็อก"],
        "expected_product_type": "cctv", "expected_subtype": "", "expected_target_device": "",
        "expected_catalog_status": "unlisted", "requires_evidence": [],
        "note": "unlisted gate: C21 listings are UNLIST",
    },
    {
        "id": "disc-70mai-lite", "shop": "ThaiSuperPhone",
        "message": "70mai Dash Cam Lite ยังมีขายไหมครับ", "history": [],
        "intent": "exact_model", "expected_answer_mode": "discontinued",
        "acceptable_item_ids": ["2733356742"], "must_not_item_ids": [],
        "must_not_phrases": ["พร้อมส่ง", "มีสต็อก"],
        "expected_product_type": "cctv", "expected_subtype": "", "expected_target_device": "",
        "expected_catalog_status": "discontinued", "requires_evidence": [],
        "note": "discontinued gate: listing SELLER_DELETE",
    },
    {
        "id": "unlist-zmi-wtx11", "shop": "SuperITMall",
        "message": "ZMI WTX11 แท่นชาร์จไร้สายมีไหมครับ", "history": [],
        "intent": "exact_model", "expected_answer_mode": "discontinued",
        "acceptable_item_ids": ["7947454599"], "must_not_item_ids": [],
        "must_not_phrases": ["พร้อมส่ง", "มีสต็อก"],
        "expected_product_type": "charger", "expected_subtype": "wireless", "expected_target_device": "",
        "expected_catalog_status": "unlisted", "requires_evidence": [],
        "note": "unlisted gate: WTX11 UNLIST",
    },
    {
        "id": "order-old-item-not-in-catalog", "shop": "IMILabThailand",
        "message": "กล้องที่สั่งไปเมื่อปีก่อน ตอนนี้จอดำ เคลมได้ไหมครับ",
        "history": [{"role": "user", "text": "[ออเดอร์] 240915OLDORDER"}],
        "intent": "claim", "expected_answer_mode": "handoff",
        "acceptable_item_ids": [], "must_not_item_ids": [],
        "must_not_phrases": ["IMILAB C201", "IMILAB EC4", "กล้องรุ่น"],
        "expected_product_type": "", "expected_subtype": "", "expected_target_device": "",
        "expected_catalog_status": "", "requires_evidence": ["warranty", "order_history"],
        "tags": ["old_order_item"],
        "note": "order item absent from catalog; must not fabricate product identity",
    },
]

EXTRA_REPLAY = {
    "q081": {
        "intent": "refund", "expected_answer_mode": "policy",
        "requires_evidence": ["order_history"],
        "must_not_phrases": ["คืนเงินให้ทันที", "รับคืนทุกกรณี"],
        "note": "refund:ask order number",
    },
    "q091": {
        "intent": "refund", "expected_answer_mode": "policy",
        "requires_evidence": ["order_history"],
        "must_not_phrases": ["คืนเงินให้ทันที", "รับคืนทุกกรณี"],
        "note": "refund:ask order number",
    },
    "q291": {
        "intent": "refund", "expected_answer_mode": "policy",
        "requires_evidence": ["order_history"],
        "must_not_phrases": ["คืนเงินให้ทันที", "รับคืนทุกกรณี"],
        "note": "refund:ask order number",
    },
    "q293": {
        "intent": "tax_invoice", "expected_answer_mode": "handoff",
        "must_not_phrases": ["ไม่สามารถออกใบกำกับภาษีได้"],
        "note": "tax invoice handoff",
    },
    "q300": {
        "intent": "other", "expected_answer_mode": "policy",
        "must_not_phrases": ["ใบกำกับภาษี"],
        "note": "misroute guard: storefront question must not hit tax handoff",
    },
    "q254": {
        "intent": "exact_model", "expected_answer_mode": "no_such_type",
        "must_not_phrases": ["W03 มีจำหน่าย", "พร้อมส่ง"],
        "note": "negative: W03 not sold in YoupinOfficialStore",
    },
    "q276": {
        "intent": "recommend", "expected_answer_mode": "no_such_type",
        "must_not_phrases": ["หูฟังพร้อมส่ง", "มีหูฟังให้เลือก"],
        "note": "negative: typo earphones not sold in Ztec",
    },
}

CONV_SPECS = [
    ("shp_261127500627830735", 2, {
        "intent": "tax_invoice", "expected_answer_mode": "handoff",
        "must_not_phrases": ["ไม่สามารถออกใบกำกับภาษีได้"],
        "note": "tax handoff after item card",
    }),
    ("shp_865227480848871144", 3, {
        "intent": "tax_invoice", "expected_answer_mode": "handoff",
        "must_not_phrases": ["ไม่สามารถออกใบกำกับภาษีได้"],
        "note": "tax handoff after order card",
    }),
    ("shp_410999740081933956", 7, {
        "intent": "tax_invoice", "expected_answer_mode": "handoff",
        "must_not_phrases": ["ไม่สามารถออกใบกำกับภาษีได้"],
        "note": "tax handoff mid-conversation",
    }),
    ("shp_1139737579763796614", 2, {
        "intent": "tax_invoice", "expected_answer_mode": "handoff",
        "must_not_phrases": ["ไม่สามารถออกใบกำกับภาษีได้"],
        "note": "tax handoff after item card",
    }),
    ("shp_4706344800526819329", 3, {
        "intent": "recommend", "expected_answer_mode": "inform_only",
        "expected_product_type": "smartwatch",
        "note": "anchor follow-up: spare strap for BLACK SHARK RUN",
    }),
    ("shp_4706344800526819329", 5, {
        "intent": "spec", "expected_answer_mode": "inform_only",
        "expected_product_type": "smartwatch", "requires_evidence": ["spec"],
        "note": "order+item anchor: bundled contents question",
    }),
    ("shp_408058959945945360", 2, {
        "intent": "other", "expected_answer_mode": "policy",
        "note": "follow-up: which shops carry the watch",
    }),
    ("shp_408058959945945360", 4, {
        "intent": "spec", "expected_answer_mode": "inform_only",
        "expected_product_type": "smartwatch", "expected_target_device": "tank t3 ultra",
        "requires_evidence": ["spec"],
        "note": "model anchor follow-up: golf app support",
    }),
    ("shp_408058959945945360", 15, {
        "intent": "order", "expected_answer_mode": "policy",
        "requires_evidence": ["order_history"],
        "must_not_phrases": ["ยกเลิกให้ทันที"],
        "note": "cancel-order follow-up with long shipping context",
    }),
    ("shp_288461076336572928", 42, {
        "intent": "order", "expected_answer_mode": "inform_only",
        "requires_evidence": ["order_history"],
        "note": "order lookup after shipping questions",
    }),
]

_MUST_NOT_BY_MODE = {
    "handoff": ["เคลมได้ทุกกรณี", "คืนเงินให้ทันที"],
    "out_of_stock": ["พร้อมส่ง", "ไม่มีสินค้ารุ่นนี้", "ไม่เคยจำหน่าย"],
    "discontinued": ["พร้อมส่ง", "มีสต็อก"],
    "no_such_type": ["พร้อมส่ง", "มีสต็อก"],
}

_TOPIC_INTENT = {
    "browse_type": "recommend",
    "brand": "recommend",
    "price_range": "recommend",
    "shorthand": "recommend",
    "typo": "recommend",
    "compat_charging": "compatibility",
    "compat_other": "compatibility",
    "model_code": "exact_model",
    "compare": "compare",
    "superlative": "superlative",
    "warranty": "warranty",
    "claim": "claim",
    "problem_report": "claim",
    "device_issue": "claim",
    "order_tracking": "order",
    "shipping": "order",
    "general_policy": "other",
    "tisi": "spec",
}
_INTENT_MAP = {
    "product_recommend": "recommend",
    "product_spec": "spec",
    "compatibility_check": "compatibility",
    "warranty_duration": "warranty",
    "warranty_claim": "claim",
    "general_question": "general",
    "other": "other",
}
_CAT_INTENT = {
    "compat": "compatibility",
    "mixed": "recommend",
    "ambiguous": "superlative",
    "followup": "recommend",
    "general": "other",
}
_EVIDENCE_BY_INTENT = {
    "compatibility": ["compatibility"],
    "spec": ["spec"],
    "warranty": ["warranty"],
    "claim": ["warranty", "order_history"],
    "order": ["order_history"],
}
_TARGETS = [
    ("recommend", 8, lambda r: r.get("topic") in {"browse_type", "shorthand", "price_range", "typo"}),
    ("exact_model", 10, lambda r: r.get("topic") == "model_code"),
    ("variant_stock", 8, lambda r: r.get("topic") in {"model_code", "browse_type"} and len(r.get("products") or []) > 1),
    ("compare", 6, lambda r: r.get("topic") == "compare"),
    ("spec", 6, lambda r: (r.get("intent") or {}).get("intent") == "product_spec" or r.get("topic") == "tisi"),
    ("compat_charging", 8, lambda r: r.get("topic") == "compat_charging"),
    ("compat_other", 6, lambda r: r.get("topic") == "compat_other"),
    ("warranty_order", 6, lambda r: r.get("topic") in {"warranty", "order_tracking"}),
    ("sensitive", 8, lambda r: r.get("topic") in {"claim", "problem_report", "device_issue", "general_policy"}),
    ("t200_compat", 6, lambda r: r.get("cat") == "compat"),
    ("t200_followup", 4, lambda r: r.get("cat") == "followup"),
    ("t200_ambiguous", 4, lambda r: r.get("cat") == "ambiguous"),
]


def _norm(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _infer_intent(rec: dict) -> str:
    topic_intent = _TOPIC_INTENT.get(rec.get("topic") or "")
    intent = (rec.get("intent") or {}).get("intent")
    mapped = _INTENT_MAP.get(intent)
    if rec.get("topic") in {"compare", "superlative", "model_code"}:
        return topic_intent
    if rec.get("cat") == "followup":
        text = _norm(rec.get("message"))
        if "รับประกัน" in text or "ประกัน" in text:
            return "warranty"
        if any(k in text for k in ("ใช้กับ", "รองรับ", "เข้ากัน")):
            return "compatibility"
        if any(k in text for k in ("กี่", "รายละเอียด", "สเปค", "ขนาด", "น้ำหนัก")):
            return "spec"
    source = str(rec.get("source") or "")
    if rec.get("cat") == "general":
        if "warranty" in source:
            return "warranty"
        if "return" in source:
            return "claim"
        if "shipping" in source:
            return "order"
    return mapped or topic_intent or _CAT_INTENT.get(rec.get("cat") or "", "other")


def _infer_product_type(rec: dict, intent: str) -> str:
    proposed = (rec.get("intent") or {}).get("product_type")
    if proposed and proposed != "other":
        return str(proposed)
    text = _norm(rec.get("message"))
    if any(k in text for k in ("สายชาร์จ", "สายชาจ", "สาย type", "สายแท้", "cable")):
        return "charger"
    if any(k in text for k in ("หัวชาร์จ", "หัวชาจ", "ที่ชาร์จ", "charger", "adapter", "หัวไหม")):
        return "charger"
    if any(k in text for k in ("พาวเวอร์แบงค์", "แบตสำรอง", "powerbank", "power bank")):
        return "powerbank"
    if any(k in text for k in ("หูฟัง", "earphone", "earbuds", "headphone", "buds", "tws")):
        return "earphone"
    if any(k in text for k in ("สมาร์ทวอทช์", "สมาดวอด", "นาฬิกา", "smartwatch", "watch")):
        return "smartwatch"
    if any(k in text for k in ("โทรศัพท์", "โทสับ", "มือถือ", "phone")):
        return "phone"
    if any(k in text for k in ("กล้อง", "cctv", "camera")):
        return "cctv"
    return ""


def _infer_subtype(rec: dict, product_type: str) -> str:
    if product_type != "charger":
        return ""
    text = _norm(rec.get("message"))
    if "ในรถ" in text or "car charger" in text:
        return "car_charger"
    if any(k in text for k in ("สายชาร์จ", "สายชาจ", "สาย type", "สายแท้", "มีสาย", "cable", "c to")):
        return "cable"
    if any(k in text for k in ("หัวชาร์จ", "หัวชาจ", "หัวไหม", "adapter", "gan")):
        return "adapter"
    proposed = (rec.get("intent") or {}).get("charger_subtype")
    return str(proposed or "")


def _infer_target_device(rec: dict) -> str:
    proposed = (rec.get("intent") or {}).get("target_device")
    if proposed:
        return str(proposed)
    text = _norm(rec.get("message"))
    patterns = (
        r"\biphone\s*\d+(?:\s*(?:pro|max|promax|plus|air|ultra))*",
        r"\bipad\s*(?:\d+|air|pro|mini)?",
        r"\bmacbook\s*(?:air|pro)?\s*\d*",
        r"\bmi\s*\d+\s*(?:ultra|pro)?",
        r"\bsamsung\s*[a-z]?\d+\s*(?:ultra|plus)?",
        r"\bgalaxy\s*[a-z]?\d+\s*(?:ultra|plus)?",
        r"\bandroid\b",
        r"โน้ตบุ๊ค|notebook",
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return _norm(match.group(0))
    return ""


def _expected_mode(rec: dict) -> str:
    source = str(rec.get("source") or "")
    if rec.get("handoff_to_admin") or "handoff" in source:
        return "handoff"
    if source.startswith("general:") or source in {"return_refund_ask_order", "cert_answer"}:
        return "policy"
    if source == "warranty_claim_first_message":
        return "policy"
    return classify_answer_mode(rec.get("answer") or "")


def _first_status(rec: dict) -> str:
    products = rec.get("products")
    if not isinstance(products, list):
        return ""
    for product in products:
        if not isinstance(product, dict):
            continue
        status = str(product.get("catalog_status") or product.get("status") or "").upper()
        if status == "NORMAL":
            return "active"
        if status == "UNLIST":
            return "unlisted"
        if status in {"SELLER_DELETE", "DELETED", "SHOPEE_DELETE"}:
            return "discontinued"
        if status:
            return status.lower()
    return ""


def _row(rec: dict, *, bucket: str = "") -> dict:
    intent = _infer_intent(rec)
    product_type = _infer_product_type(rec, intent)
    mode = _expected_mode(rec)
    return {
        "id": str(rec.get("id") or rec.get("i") or ""),
        "shop": str(rec.get("shop") or ""),
        "message": str(rec.get("message") or rec.get("msg") or ""),
        "history": rec.get("history") or [],
        "intent": intent,
        "expected_answer_mode": mode,
        "acceptable_item_ids": [],
        "must_not_item_ids": [],
        "must_not_phrases": list(_MUST_NOT_BY_MODE.get(mode, [])),
        "expected_product_type": product_type,
        "expected_subtype": _infer_subtype(rec, product_type),
        "expected_target_device": _infer_target_device(rec),
        "expected_catalog_status": _first_status(rec),
        "requires_evidence": _EVIDENCE_BY_INTENT.get(intent, []),
        "note": f"draft:{bucket}" if bucket else "draft",
    }


def draft_rows(recs: list[dict], *, include_manual: bool = True) -> list[dict]:
    """Select deterministic draft rows; humans must approve before use."""
    rows = [dict(r) for r in MANUAL_CASES] if include_manual else []
    seen_messages = {(_norm(r.get("shop")), _norm(r.get("message"))) for r in rows}

    ordered = sorted(recs, key=lambda r: str(r.get("id") or r.get("i") or ""))
    for bucket, limit, predicate in _TARGETS:
        count = 0
        for rec in ordered:
            if count >= limit:
                break
            key = (_norm(rec.get("shop")), _norm(rec.get("message") or rec.get("msg")))
            if key in seen_messages or not predicate(rec):
                continue
            row = _row(rec, bucket=bucket)
            if not row["id"]:
                continue
            rows.append(row)
            seen_messages.add(key)
            count += 1

    return sorted(rows, key=lambda r: (r.get("intent") or "", r.get("id") or ""))


def _norm_id(value: object) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value or "")
    return text[:-2] if text.endswith(".0") else text


def _iter_json_array(path: Path):
    decoder = json.JSONDecoder()
    buf = ""
    pos = 0
    with path.open("r", encoding="utf-8") as f:
        while chunk := f.read(1 << 20):
            buf += chunk
            while True:
                while pos < len(buf) and buf[pos] in " \t\r\n,[":
                    pos += 1
                if pos >= len(buf):
                    buf, pos = "", 0
                    break
                try:
                    obj, end = decoder.raw_decode(buf, pos)
                except json.JSONDecodeError:
                    break
                yield obj
                pos = end
            if pos:
                buf = buf[pos:]
                pos = 0


def _load_image_map(path: str | None, wanted_ids: set[str]) -> dict[str, str]:
    if not path:
        return {}
    source = Path(path)
    if not source.exists() or not wanted_ids:
        return {}
    images: dict[str, str] = {}
    for doc in _iter_json_array(source):
        item_id = _norm_id(doc.get("item_id"))
        if item_id not in wanted_ids:
            continue
        info = doc.get("images") or {}
        urls = info.get("image_url_list") or []
        if urls:
            images[item_id] = str(urls[0])
        if len(images) == len(wanted_ids):
            break
    return images


def review_rows(recs: list[dict], rows: list[dict], images: dict[str, str] | None = None) -> list[dict]:
    """Attach replay evidence shown only in the review UI."""
    by_id = {str(r.get("id") or ""): r for r in recs}
    images = images or {}
    out = []
    for row in rows:
        rec = by_id.get(str(row.get("id") or ""))
        item = dict(row)
        if rec:
            products = rec.get("products")
            item["_review"] = {
                "source": rec.get("source") or "",
                "answer": rec.get("answer") or "",
                "product_count": products if isinstance(products, int) else len(products or []),
                "products": [
                    {
                        "item_id": p.get("item_id"),
                        "name": p.get("name") or p.get("item_name") or "",
                        "model_name": p.get("model_name") or "",
                        "product_type": p.get("product_type") or "",
                        "status": p.get("catalog_status") or p.get("status") or "",
                        "available": p.get("_available_for_sale") or p.get("sellable") or False,
                        "price": p.get("price"),
                        "image": (p.get("image") or p.get("image_url")
                                  or images.get(_norm_id(p.get("item_id")), "")),
                    }
                    for p in (products if isinstance(products, list) else [])[:10]
                    if isinstance(p, dict)
                ],
            }
        out.append(item)
    return out


def write_review_data(rows: list[dict], path: str) -> None:
    """Write browser-consumable draft rows for gold_review.html."""
    Path(path).write_text(
        "window.GOLD_DRAFT_ROWS = "
        + json.dumps(rows, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )


def apply_review(rows: list[dict], review_path: str) -> list[dict]:
    """Keep approved rows; promote rejected rows that have encoded corrections."""
    decisions = {
        str(r.get("id") or ""): str(r.get("decision") or "pending")
        for r in json.loads(Path(review_path).read_text(encoding="utf-8"))
    }
    out = []
    for row in rows:
        rid = str(row.get("id") or "")
        decision = decisions.get(rid)
        if decision == "approved":
            out.append(row)
        elif decision == "rejected" and rid in CORRECTED:
            out.append({**row, **CORRECTED[rid]})
    return out


def extra_replay_rows(recs: list[dict]) -> list[dict]:
    """Build gold rows for EXTRA_REPLAY ids with explicit overrides."""
    out = []
    for rec in recs:
        rid = str(rec.get("id") or "")
        override = EXTRA_REPLAY.get(rid)
        if not override:
            continue
        out.append({**_row(rec, bucket="extra"), **override})
    return out


def conv_gold_rows(conv_path: str, specs: list[tuple[str, int, dict]] | None = None) -> list[dict]:
    """Build gold rows from multi-turn conversation replays (history coverage)."""
    convs = {}
    for line in Path(conv_path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            conv = json.loads(line)
            convs[str(conv.get("conv_id") or "")] = conv
    out = []
    for conv_id, qa_i, override in (specs or CONV_SPECS):
        conv = convs.get(conv_id)
        if not conv:
            continue
        qa = next((q for q in conv.get("qa") or [] if q.get("i") == qa_i), None)
        if not qa:
            continue
        history = []
        for q in conv["qa"]:
            if q.get("i") >= qa_i:
                break
            if q.get("user_text"):
                history.append({"role": "user", "text": q["user_text"]})
            if q.get("bot_answer"):
                history.append({"role": "assistant", "text": q["bot_answer"]})
        base = {
            "id": f"conv-{conv_id}-{qa_i}",
            "shop": str(conv.get("shop_name") or ""),
            "message": str(qa.get("user_text") or ""),
            "history": history[-6:],
            "intent": "other",
            "expected_answer_mode": "inform_only",
            "acceptable_item_ids": [],
            "must_not_item_ids": [],
            "must_not_phrases": [],
            "expected_product_type": "",
            "expected_subtype": "",
            "expected_target_device": "",
            "expected_catalog_status": "",
            "requires_evidence": [],
            "note": "conv",
        }
        out.append({**base, **override})
    return out


def build_gold(recs: list[dict], review_path: str, conv_path: str | None = None) -> list[dict]:
    """Assemble final gold: reviewed + corrected + gap-fill rows."""
    rows = apply_review(draft_rows(recs), review_path)
    rows.extend(extra_replay_rows(recs))
    if conv_path:
        rows.extend(conv_gold_rows(conv_path))
    rows.extend(dict(r) for r in EXTRA_MANUAL)
    seen = set()
    deduped = []
    for row in rows:
        rid = str(row.get("id") or "")
        if rid and rid not in seen:
            seen.add(rid)
            deduped.append(row)
    return sorted(deduped, key=lambda r: (r.get("intent") or "", r.get("id") or ""))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", nargs="+")
    parser.add_argument("--review-js", help="write JS data for gold_review.html instead of JSONL")
    parser.add_argument("--image-export", help="optional product export JSON used to attach review images")
    parser.add_argument("--review-file", help="apply review JSON: keep approved, promote corrected")
    parser.add_argument("--convs", help="conversation JSONL used to add history gold rows")
    args = parser.parse_args(argv)

    recs: list[dict] = []
    for path in args.results:
        loaded = load_results(path)
        for i, rec in enumerate(loaded, 1):
            rec = dict(rec)
            if not rec.get("id"):
                rec["id"] = f"{Path(path).stem}-{i:03d}"
            recs.append(rec)

    if args.review_file:
        rows = build_gold(recs, args.review_file, args.convs)
    else:
        rows = draft_rows(recs)
    if args.review_js:
        wanted_ids = {
            _norm_id(p.get("item_id"))
            for rec in recs
            for p in (rec.get("products") if isinstance(rec.get("products"), list) else [])
            if isinstance(p, dict) and p.get("item_id") is not None
        }
        images = _load_image_map(args.image_export, wanted_ids)
        write_review_data(review_rows(recs, rows, images), args.review_js)
        return 0
    for row in rows:
        print(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
