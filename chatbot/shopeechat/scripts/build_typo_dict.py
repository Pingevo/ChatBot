"""สร้าง exports/typo_dict.json — dictionary คำศัพท์จริงจาก catalog.

ใช้โดย route_context.normalize_message แก้ typo เทียบคำที่มีจริงเท่านั้น
(ไม่เดา — ถ้าคำไม่อยู่ใน dict ก็ไม่แก้)

แหล่งข้อมูล: exports/sellable_units.jsonl (ทุก unit ไม่ใช่แค่ sellable —
typo dict ต้องครอบคลุมสินค้า historical ที่ลูกค้าอาจถามด้วย)

วิธีใช้:
    .venv/bin/python chatbot/shopeechat/scripts/build_typo_dict.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

UNITS_PATH = ROOT / "exports" / "sellable_units.jsonl"
OUT_PATH = ROOT / "exports" / "typo_dict.json"

_LATIN = re.compile(r"[A-Za-z][A-Za-z0-9._\-]{2,}")
_THAI = re.compile(r"[ก-๙]{3,}")
# รหัสรุ่น: ตัวพิมพ์+ตัวเลขผสม เช่น HA835, PB150P, EC4, XM5461
_CODE = re.compile(r"\b[A-Za-z]{1,6}\d{1,5}[A-Za-z]{0,4}\b|\b\d{1,5}[A-Za-z]{1,6}\b")

# คำทั่วไปที่ไม่ใช่รหัสรุ่นแม้ match pattern (gating list เล็กๆ ตามที่เห็นจริง)
_NOT_CODES = {
    "2024", "2025", "2026", "3in1", "2in1", "4in1", "5g", "4g", "100w", "65w",
    "20w", "30w", "45w", "120w", "140w", "240w", "10w", "15w", "18w", "22w",
    "5000mah", "10000mah", "20000mah", "30000mah", "usb", "type",
}


def main() -> None:
    brands: set[str] = set()
    codes: set[str] = set()
    latin: set[str] = set()
    thai: set[str] = set()

    for line in open(UNITS_PATH, encoding="utf-8"):
        u = json.loads(line)
        b = u.get("brand") or {}
        bn = (b.get("original_brand_name") or "").strip()
        if bn and bn.lower() not in ("no brand", "nobrand"):
            brands.add(bn.lower())
        for c in u.get("model_codes") or []:
            codes.add(c.lower())
        text = f"{u.get('item_name') or ''} {u.get('model_name') or ''}"
        for tok in _LATIN.findall(text):
            t = tok.lower().strip(".-_")
            if len(t) >= 3 and _CODE.fullmatch(t) and t not in _NOT_CODES:
                codes.add(t)
            if len(t) >= 4:
                latin.add(t)
        for tok in _THAI.findall(text):
            thai.add(tok)

    out = {
        "brands": sorted(brands),
        "model_codes": sorted(codes),
        "product_words": sorted(latin),
        "thai_terms": sorted(thai),
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print({k: len(v) for k, v in out.items()}, "→", OUT_PATH)


if __name__ == "__main__":
    main()
