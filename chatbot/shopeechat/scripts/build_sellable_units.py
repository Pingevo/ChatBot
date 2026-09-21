"""build_sellable_units — แตก ShpProducts listings → unit index (1 unit = item_id × model_id).

วิธีใช้:
    .venv/bin/python chatbot/shopeechat/scripts/build_sellable_units.py [--source export|mongo]

ผลลัพธ์:
    exports/sellable_units.jsonl — 1 บรรทัด/unit:
        {unit_id, item_id, model_id, display_name, item_name, model_name, model_sku,
         kind, components, product_type, charger_subtype, cable_subtype, camera_subtype,
         model_codes, price, stock, item_status, model_status, shop, brand, cat_name,
         sellable, answerable, oos_in_name, has_description, has_warranty_info,
         desc_sections, image_ids, search_text}

GATE (ตามแผน): sellable units ที่ classify ได้ (confidence != low) ≥90% — ต่ำกว่านี้หยุดรายงาน
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))

from chatbot.shopeechat.product_store import _shopee_stock  # noqa: E402
from chatbot.shopeechat.scripts.unit_classifier import classify_unit  # noqa: E402

EXPORT_PATH = ROOT / "exports" / "ShpProducts.export.json"
OUTPUT_PATH = ROOT / "exports" / "sellable_units.jsonl"
COVERAGE_GATE = 0.90

# ---- desc section markers (จาก format จริงใน export) ----
_SECTION_MAP = (
    ("highlights", ("จุดเด่น", "จุดเด่นสินค้า", "ไฮไลท์", "highlight")),
    ("specs", ("คุณสมบัติ", "ข้อมูลสินค้า", "specification", "สเปค", "สเปก",
               "รายละเอียดสินค้า", "ข้อมูลจำเพาะ", "รายละเอียด")),
    ("warranty", ("รับประกัน", "ประกัน", "warranty", "เงื่อนไขการรับประกัน")),
    ("notes", ("ข้อกำหนด", "ข้อสังเกต", "หมายเหตุ", "ข้อควร", "เงื่อนไข",
               "คำเตือน", "note")),
)
_MARKER_RE = re.compile(r"\[\[\s*(.+?)\s*\]\]|\*\*\*\s*(.+?)\s*\*\*\*|={5,}")
_BANNER_RE = re.compile(r"={5,}.*?={5,}", re.S)


def _section_key(title: str) -> str:
    t = title.lower()
    for key, words in _SECTION_MAP:
        if any(w in t for w in words):
            return key
    return "other"


def _parse_desc_sections(text: str) -> dict:
    """แตก description เป็น sections: intro/highlights/specs/warranty/notes/other.

    markers ที่พบจริง: [[ X ]], *** X ***, ===banner===, "เงื่อนไขการรับประกันสินค้า" (ไม่มีกรอบ)
    """
    text = _BANNER_RE.sub("\n", text or "")
    sections: dict[str, list[str]] = {}
    cur_key, cur = "intro", []
    # "เงื่อนไขการรับประกันสินค้า" header บรรทัดลอย (ไม่มี [[ ]])
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        m = _MARKER_RE.search(line)
        head = line.strip()
        bare_warranty = re.match(r"^(เงื่อนไขการรับประกัน|เงื่อนไขการจัดส่ง|ข้อตกลง)", head)
        if m:
            if cur:
                sections.setdefault(cur_key, []).append("\n".join(cur).strip())
            title = (m.group(1) or m.group(2) or "").strip()
            cur_key = _section_key(title)
            cur = [f"[{title}]"] if title else []
            i += 1
            continue
        if bare_warranty:
            if cur:
                sections.setdefault(cur_key, []).append("\n".join(cur).strip())
            cur_key = "warranty" if "รับประกัน" in head else "notes"
            cur = [head]
            i += 1
            continue
        cur.append(line)
        i += 1
    if cur:
        sections.setdefault(cur_key, []).append("\n".join(cur).strip())
    return {k: "\n".join(v).strip() for k, v in sections.items() if "\n".join(v).strip()}


def _iter_export_docs(path: Path):
    buf, started = [], False
    with open(path, encoding="utf-8") as f:
        for line in f:
            s = line.rstrip("\n")
            if not started:
                if s == "  {":
                    started, buf = True, [line]
                continue
            buf.append(line)
            if s in ("  }", "  },"):
                yield json.loads("".join(buf).rstrip().rstrip(","))
                started, buf = False, []


def _field_list_parts(doc: dict) -> tuple[str, list[str]]:
    """คืน (รวม text blocks, image_ids ตามลำดับ) จาก description_info.field_list.

    image_ids ต่อท้ายด้วย gallery (image_id_list) + variant (option_list) ids —
    attach_image_texts join เห็น OCR text ของรูปนอก desc ด้วย (มอก./cert badge
    มักอยู่ในรูป gallery) — desc ids ยังนำหน้าเหมือนเดิม
    """
    fl = ((doc.get("description_info") or {}).get("extended_description") or {}).get("field_list") or []
    texts, image_ids = [], []
    for f in fl:
        if not isinstance(f, dict):
            continue
        if f.get("field_type") == "image" and isinstance(f.get("image_info"), dict):
            iid = f["image_info"].get("image_id")
            if iid:
                image_ids.append(iid)
        else:
            t = (f.get("text") or "").strip()
            if t:
                texts.append(t)
    seen = set(image_ids)
    for iid in (doc.get("image") or {}).get("image_id_list") or []:
        if iid and iid not in seen:
            image_ids.append(iid)
            seen.add(iid)
    for tv in (doc.get("tier_variation") or []):
        for o in (tv.get("option_list") or []):
            iid = (o.get("image") or {}).get("image_id")
            if iid and iid not in seen:
                image_ids.append(iid)
                seen.add(iid)
    return "\n".join(texts), image_ids


def _price_of(model_doc: dict, doc: dict) -> float | None:
    # price_info เป็น list ต่อ currency — เอา entry แรก (THB)
    for src in (model_doc, doc):
        pi = (src or {}).get("price_info") or []
        if isinstance(pi, dict):
            pi = [pi]
        for entry in pi:
            p = (entry or {}).get("current_price")
            if isinstance(p, (int, float)) and p > 0:
                return float(p)
    p = doc.get("price")
    return float(p) if isinstance(p, (int, float)) and p > 0 else None


def _build_unit(doc: dict, m: dict | None, sections: dict, image_ids: list[str],
                idx: int = 0) -> dict:
    m = m or {}
    item_name = doc.get("item_name") or ""
    model_name = m.get("model_name") or ""
    model_sku = m.get("model_sku") or ""
    c = classify_unit(item_name, model_name, model_sku)
    stock = _shopee_stock(m) if m else _shopee_stock(doc)
    item_status = doc.get("item_status") or ""
    item_id = doc.get("item_id")
    model_id = m.get("model_id")
    if isinstance(item_id, float):
        item_id = int(item_id)
    if isinstance(model_id, float):
        model_id = int(model_id)
    display = item_name if not model_name else f"{item_name} — {model_name}"
    search_parts = [display, model_sku, " ".join(c["model_codes"]),
                    c["product_type"] or "", " ".join(c["components"])]
    # model_id หายใน multi-model listing → ใส่ index กัน unit_id ชนกัน
    unit_key = model_id if model_id is not None else ("solo" if idx == 0 else f"m{idx}")
    return {
        "unit_id": f"{item_id}:{unit_key}",
        "item_id": item_id,
        "model_id": model_id,
        "display_name": display,
        "item_name": item_name,
        "model_name": model_name,
        "model_sku": model_sku,
        "kind": c["kind"],
        "components": c["components"],
        "product_type": c["product_type"],
        "charger_subtype": c["charger_subtype"],
        "cable_subtype": c["cable_subtype"],
        "camera_subtype": c["camera_subtype"],
        "model_codes": c["model_codes"],
        "confidence": c["confidence"],
        "price": _price_of(m, doc),
        "stock": stock,
        "item_status": item_status,
        "model_status": m.get("model_status") or "",
        "shop": doc.get("shopname") or doc.get("shop") or "",
        "brand": doc.get("brand") or "",
        "cat_name": doc.get("cat_name") or "",
        "sellable": item_status == "NORMAL" and stock > 0,
        "answerable": True,
        "oos_in_name": c["oos_in_name"],
        "has_description": bool(sections),
        "has_warranty_info": bool(sections.get("warranty")),
        "desc_sections": sections,
        "image_ids": image_ids,
        "search_text": " ".join(p for p in search_parts if p).strip(),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["export", "mongo"], default="export")
    args = ap.parse_args()
    if args.source == "mongo":
        sys.exit("--source mongo ยังไม่ implement — ใช้ export ก่อน (snapshot เดียวกับ census)")

    n_units = n_sellable = n_classified = 0
    conf_count = {"high": 0, "medium": 0, "low": 0}
    seen_ids = set()
    t0 = time.time()
    with open(OUTPUT_PATH, "w", encoding="utf-8") as out:
        for doc in _iter_export_docs(EXPORT_PATH):
            fl_text, image_ids = _field_list_parts(doc)
            desc_text = ((doc.get("description") or "") + "\n" + fl_text).strip()
            sections = _parse_desc_sections(desc_text)
            models = doc.get("model") or []
            if not models:
                models = [None]
            for i, m in enumerate(models):
                u = _build_unit(doc, m, sections, image_ids, idx=i)
                if u["unit_id"] in seen_ids:
                    continue
                seen_ids.add(u["unit_id"])
                out.write(json.dumps(u, ensure_ascii=False) + "\n")
                n_units += 1
                conf_count[u["confidence"]] += 1
                if u["sellable"]:
                    n_sellable += 1
                    if u["confidence"] != "low":
                        n_classified += 1
    pct = n_classified / n_sellable * 100 if n_sellable else 0
    print(f"units={n_units} sellable={n_sellable} "
          f"classified={n_classified} ({pct:.1f}% — gate ≥{COVERAGE_GATE*100:.0f}%)")
    print(f"confidence: {conf_count}  elapsed={time.time()-t0:.0f}s")
    print(f"output → {OUTPUT_PATH}")
    if pct < COVERAGE_GATE * 100:
        print("⛔ GATE FAIL — coverage ต่ำกว่าเกณฑ์ หยุดรายงานก่อนไปต่อ")
        sys.exit(2)


if __name__ == "__main__":
    main()
