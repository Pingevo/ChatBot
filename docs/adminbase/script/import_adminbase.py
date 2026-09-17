"""Import ไฟล์ Excel ใน adminbase/ ไปยัง MongoDB collection knowledge_base.

หลักการสำคัญ:
- ไม่ทิ้งข้อมูลแม้แต่ตัวอักษรเดียว — เก็บ raw ดิบใน field `original_raw`
- field ที่ map ได้ → ขึ้น common + specs
- field ที่ map ไม่ได้ → เก็บใน `extra_fields` (ไม่ทิ้ง)
- เก็บ source_file, source_row, source_sheet เพื่อย้อนกลับดูได้
- ใช้ upsert — ถ้ามี document อยู่แล้ว (match ด้วย source_file + source_row) จะอัปเดต ไม่ทับซ้อน
- flag --reset สำหรับลบข้อมูลเดิมทั้งหมดก่อน import (ใช้เมื่อต้องการเริ่มใหม่)

Usage:
    .venv/bin/python scripts/import_adminbase.py
    .venv/bin/python scripts/import_adminbase.py --reset
    .venv/bin/python scripts/import_adminbase.py --dry-run   # อ่าน + แปลง แต่ไม่เขียน DB
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from dotenv import load_dotenv
from pymongo import MongoClient

# ---- config ----

ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(ROOT))          # chatbot.shopeechat.*
sys.path.insert(0, str(Path(__file__).resolve().parent))  # spec_key_map
load_dotenv(ROOT / ".env")

import spec_key_map  # noqa: E402

ADMIN_DB_NAME = os.environ.get("ADMIN_MONGO_DB", "chatbot_admin").strip()
KB_COLLECTION = os.environ.get("ADMIN_MONGO_COLLECTION_KB", "knowledge_base").strip()
KB_PRODUCTS_COLL = os.environ.get("ADMIN_MONGO_COLLECTION_KB_PRODUCTS", "kb_products").strip()
KB_QA_COLL = os.environ.get("ADMIN_MONGO_COLLECTION_KB_QA", "kb_qa").strip()
KB_RAW_COLL = os.environ.get("ADMIN_MONGO_COLLECTION_KB_RAW", "kb_raw").strip()
ADMINBASE_DIR = Path(__file__).resolve().parent.parent
UNITS_JSONL = ROOT / "exports" / "sellable_units.jsonl"

# ---- field mapping ----
# ชื่อ column ใน Excel → field ใน schema knowledge_base
# รองรับหลายชื่อ (เพราะไฟล์ตั้งชื่อไม่เหมือนกัน)

COMMON_FIELD_MAP: dict[str, list[str]] = {
    "brand": ["ชื่อแบรนด์", "แบรนด์", "brand"],
    "model": ["รุ่นสินค้า", "รุ่น", "model"],
    "category": ["ประเภท", "ประเภทสินค้า", "category"],
    "highlights": ["จุดเด่นสินค้า", "จุดเด่น"],
    "description": ["ข้อมูลสินค้า", "ข้อมูลสำคัญ", "ข้อมูลสินค้าหลังกล่อง", "ข้อมูล"],
    "box_contents": [
        "อุปกรณ์ที่ได้รับในแพ็กเกจ",
        "อุปกรณ์ภายในกล่อง",
        "อุปกรณ์ในกล่อง",
        "อุปกรณ์ที่แนะนำ",
    ],
    "warranty_period": ["ระยะเวลาการรับประกัน", "ระยะเวลารับประกัน"],
    "warranty_note": ["การรับประกันสินค้า", "การรับประกัน"],
    "notes": ["หมายเหตุสำคัญ", "หมายเหตุ"],
    "weight": ["น้ำหนักสินค้า", "น้ำหนัก"],
    "dimensions": ["ขนาดสินค้า", "ขนาด"],
    "question": ["คำถามเกี่ยวสินค้า", "คำถาม"],
    "answer": ["คำตอบ", "คำตอบเกี่ยวกับสินค้า"],
}

# field ที่เป็น "สเปก" — เก็บใน specs (dynamic)
# ไม่ต้อง map ทุก field — ที่เหลือจะไป extra_fields อัตโนมัติ
KNOWN_COMMON_KEYS: set[str] = set()
for _vals in COMMON_FIELD_MAP.values():
    KNOWN_COMMON_KEYS.update(v.lower() for v in _vals)

# field ที่ไม่ใช่สเปก แต่ก็ไม่ใช่ common — ไป extra_fields
# (เช่น วิธีการใช้งาน, การดูแลรักษา, วิธีการใส่สายนาฬิกา)
# ไม่ต้องระบุ — ทุก field ที่ไม่ใช่ common จะไป extra_fields อัตโนมัติ


def _build_reverse_map() -> dict[str, str]:
    """สร้าง reverse map: 'ชื่อ column ใน excel (lower)' → 'field ใน schema'."""
    rev: dict[str, str] = {}
    for schema_field, excel_names in COMMON_FIELD_MAP.items():
        for name in excel_names:
            rev[name.strip().lower()] = schema_field
    return rev


REVERSE_MAP = _build_reverse_map()


def _cell_to_str(val) -> str:
    """แปลงค่าจาก Excel เป็น string โดยไม่ทิ้งข้อมูล."""
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, float):
        # ถ้าเป็นจำนวนเต็ม ไม่ต้องมี .0
        if val == int(val):
            return str(int(val))
        return str(val)
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, datetime):
        return val.isoformat()
    return str(val)


def _detect_category_id(category: str, brand: str, model: str) -> str:
    """แปลง category ภาษาไทย/อังกฤษ → slug สำหรับ category_id."""
    low = (category or "").lower()
    combined = f"{category} {model}".lower()
    # ลำดับสำคัญ — เช็คเฉพาะก่อน
    if any(k in low for k in ["หูฟัง", "earphone", "earbuds", "tws", "headphone"]):
        return "earphone"
    if any(k in low for k in ["พาวเวอร์แบงค์", "powerbank", "power bank", "แบตสำรอง"]):
        return "powerbank"
    if any(k in low for k in ["สมาร์ทวอช", "smartwatch", "smart watch", "นาฬิกา"]):
        return "smartwatch"
    if any(k in low for k in ["โทรศัพท์", "มือถือ", "phone", "smartphone", "โทสับ"]):
        return "phone"
    if any(k in low for k in ["พัดลม", "fan", "cooling"]):
        return "fan"
    if any(k in low for k in ["ชาร์จ", "charger", "หัวชาร์จ", "สายชาร์จ", "cable"]):
        return "charger"
    if any(k in low for k in ["กล้องวงจรปิด", "cctv", "camera", "กล้องติดรถ", "dash cam"]):
        return "camera"
    if any(k in low for k in ["ลำโพง", "speaker", "bluetooth speak"]):
        return "speaker"
    if any(k in low for k in ["เครื่องนวด", "massager", "massager"]):
        return "massager"
    if any(k in low for k in ["เครื่องดูดฝุ่น", "vacuum"]):
        return "vacuum"
    if any(k in low for k in ["เครื่องฟอกอากาศ", "air purifier"]):
        return "air_purifier"
    if any(k in low for k in ["เครื่องทำความชื้น", "humidifier"]):
        return "humidifier"
    if any(k in low for k in ["ทำเล็บ", "nail"]):
        return "nail_care"
    if any(k in low for k in ["โกนหนวด", "shaver", "shave"]):
        return "shaver"
    if any(k in low for k in ["โต๊ะ", "table", "desk"]):
        return "table"
    if any(k in low for k in ["โซฟา", "sofa"]):
        return "sofa"
    if any(k in low for k in ["หมอน", "pillow"]):
        return "pillow"
    if any(k in low for k in ["เบาะ", "cushion"]):
        return "cushion"
    if any(k in low for k in ["เครื่องชั่ง", "scale"]):
        return "scale"
    if any(k in low for k in ["ssd", "drive", "ไดร์"]):
        return "storage"
    if any(k in low for k in ["แท็บเล็ต", "tablet", "pad"]):
        return "tablet"
    if any(k in low for k in ["ไมค์", "ไมโครโฟน", "microphone"]):
        return "microphone"
    if any(k in low for k in ["แท็ก", "tag", "tracker"]):
        return "tracker"
    if any(k in low for k in ["ถ่าน", "battery", "แบตเตอรี่"]):
        return "battery"
    if any(k in low for k in ["เครื่องใช้ไฟฟ้า", "appliance"]):
        return "appliance"
    if any(k in low for k in ["เครื่องใช้ภายในบ้าน", "home"]):
        return "home_appliance"
    if any(k in low for k in ["ลู่วิ่ง", "treadmill"]):
        return "treadmill"
    if any(k in low for k in ["ไดร์เป่าผม", "hair dryer"]):
        return "hair_dryer"
    if any(k in low for k in ["สายรัด", "strap", "nylon"]):
        return "strap"
    if any(k in low for k in ["เครื่องทำเล็บ", "nail"]):
        return "nail_care"
    if any(k in low for k in ["พยุงพุง", "พยุง"]):
        return "massager"
    if any(k in low for k in ["เครื่องโกน", "โกน"]):
        return "shaver"
    # fallback
    return "other"


def _is_qa_file(filename: str) -> bool:
    """ไฟล์ที่ชื่อบอกว่าเป็น Q&A."""
    low = filename.lower()
    return "ถาม" in low and "ตอบ" in low


def _is_comparison_file(filename: str) -> bool:
    """ไฟล์ที่เป็นตารางเปรียบเทียบ."""
    low = filename.lower()
    return "เปรียบเทียบ" in low or "หัวข้อเปรียบเทียบ" in low


def _is_spec_file(filename: str, sheet_name: str) -> bool:
    """ไฟล์ที่เป็น spec sheet (สเปกละเอียด)."""
    low = (filename + " " + sheet_name).lower()
    return "spec" in low


def build_code_item_map() -> dict[str, list[str]]:
    """โหลด sellable_units.jsonl → {model_code_lower: [item_id,...]} สำหรับ link kb→catalog."""
    code_map: dict[str, list[str]] = {}
    if not UNITS_JSONL.exists():
        return code_map
    for line in open(UNITS_JSONL, encoding="utf-8"):
        u = json.loads(line)
        iid = str(u.get("item_id") or "")
        for c in u.get("model_codes") or []:
            code_map.setdefault(str(c).lower(), [])
            if iid and iid not in code_map[str(c).lower()]:
                code_map[str(c).lower()].append(iid)
    return code_map


def _extract_model_codes(text: str) -> list[str]:
    """สกัดรหัสรุ่นจากชื่อ model — reuse ตัวเดียวกับ unit_classifier."""
    try:
        from chatbot.shopeechat.scripts.unit_classifier import _extract_codes
        return _extract_codes(text or "")
    except Exception:
        return []


def parse_row(
    header: list[str],
    row: tuple,
    source_file: str,
    source_row: int,
    source_sheet: str,
    code_item_map: dict[str, list[str]] | None = None,
) -> tuple[dict | None, list[dict], dict]:
    """แปลง row → (kb_products doc|None, [kb_qa docs], kb_raw doc).

    - raw เป็น list-of-pairs [{col,val}] — ไม่ทิ้ง column ซ้ำ (แก้ bug dict overwrite)
    - Q&A: pair column คำถาม/คำตอบ ตามตำแหน่ง (ไฟล์อย่าง Cuktech ZTEC มี 2 pairs/row)
    - specs: canonical_specs (map ผ่าน spec_key_map) + specs_raw (ที่เหลือทั้งหมด)
    - product doc = None เมื่อ row มีแต่ Q&A ไม่มี product identity
    """
    # ── raw pairs (เก็บทุกคอลัมน์ตามลำดับ ไม่ซ้ำทับ) ──
    pairs: list[dict[str, str]] = []
    for i, col_name in enumerate(header):
        if not col_name:
            continue
        val = row[i] if i < len(row) else None
        cell_str = _cell_to_str(val)
        if cell_str:
            pairs.append({"col": col_name, "val": cell_str})
    raw_doc = {
        "source_file": source_file,
        "source_sheet": source_sheet,
        "source_row": source_row,
        "pairs": pairs,
    }
    if not pairs:
        return None, [], raw_doc

    # ── Q&A positional pairing: col 'question' จับคู่ 'answer' ถัดไปที่ยังไม่ถูกใช้ ──
    q_pos: list[int] = []       # index ใน pairs ที่เป็น question
    used_a: set[int] = set()
    qa_pairs: list[tuple[int, int | None]] = []  # (q_idx, a_idx|None)
    mapped_fields: dict[int, str] = {}           # pair idx → schema field
    for i, p in enumerate(pairs):
        f = REVERSE_MAP.get(p["col"].strip().lower())
        mapped_fields[i] = f or ""
        if f == "question":
            q_pos.append(i)
        elif f == "answer":
            qi = q_pos.pop(0) if q_pos else None
            qa_pairs.append((qi, i))
            used_a.add(i)
    for qi in q_pos:  # question ที่ไม่มี answer ตามหลัง
        qa_pairs.append((qi, None))

    qa_docs: list[dict] = []
    for n, (qi, ai) in enumerate(qa_pairs):
        q = pairs[qi]["val"] if qi is not None else ""
        a = pairs[ai]["val"] if ai is not None else ""
        if not (q or a):
            continue
        qa_docs.append({
            "type": "qa",
            "kb_ref": f"{source_file}:{source_sheet}:{source_row}",
            "q": q, "a": a,
            "topic": "",
            "model_codes": [],
            "item_ids": [],
            "source_file": source_file, "source_sheet": source_sheet,
            "source_row": source_row, "qa_idx": n,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "updated_by": "system_import", "version": 1, "active": True,
        })

    # ── common fields (first occurrence ชนะ) + specs ──
    doc: dict = {
        "type": "product_spec",
        "brand": "", "model": "", "category": "", "category_id": "",
        "model_codes": [], "item_ids": [],
        "highlights": "", "description": "", "box_contents": "",
        "warranty_period": "", "warranty_note": "", "notes": "",
        "weight": "", "dimensions": "",
        "canonical_specs": {}, "specs_raw": {}, "extra_fields": {},
        "source_file": source_file, "source_row": source_row,
        "source_sheet": source_sheet,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": "system_import", "version": 1, "active": True,
    }
    used: set[int] = set(used_a)
    for qi, ai in qa_pairs:
        if qi is not None:
            used.add(qi)
    col_count: dict[str, int] = {}
    for i, p in enumerate(pairs):
        if i in used:
            continue
        col, val = p["col"], p["val"]
        cnt = col_count.get(col, 0)
        col_count[col] = cnt + 1
        key = col if cnt == 0 else f"{col} ({cnt + 1})"
        f = mapped_fields[i]
        if f and f in doc and isinstance(doc.get(f), str) and not doc[f]:
            doc[f] = val
            continue
        canon = spec_key_map.canonical_of(col)
        if canon and canon not in doc["canonical_specs"]:
            doc["canonical_specs"][canon] = val
        elif len(val) > 200:
            doc["extra_fields"][key] = val
        else:
            doc["specs_raw"][key] = val

    doc["category_id"] = _detect_category_id(
        doc.get("category", ""), doc.get("brand", ""), doc.get("model", ""))
    doc["model_codes"] = _extract_model_codes(doc.get("model", ""))
    if code_item_map:
        seen: list[str] = []
        for c in doc["model_codes"]:
            for iid in code_item_map.get(c.lower(), []):
                if iid not in seen:
                    seen.append(iid)
        doc["item_ids"] = seen
    for qa in qa_docs:
        qa["topic"] = f"{doc['brand']} {doc['model']}".strip()
        qa["model_codes"] = doc["model_codes"]
        qa["item_ids"] = doc["item_ids"]

    if _is_comparison_file(source_file):
        doc["type"] = "comparison"
    if _is_spec_file(source_file, source_sheet):
        doc["is_spec_sheet"] = True

    # row ที่มีแต่ Q&A ไม่มีข้อมูลสินค้าเลย → ไม่สร้าง product doc
    has_identity = doc["brand"] or doc["model"] or doc["canonical_specs"] or doc["specs_raw"]
    return (doc if has_identity else None), qa_docs, raw_doc


def _parse_txt_file(filepath: Path) -> list[dict]:
    """อ่านไฟล์ .txt (เงื่อนไขรับประกันทั่วไป) → kb_qa doc type=general_faq."""
    content = filepath.read_text(encoding="utf-8", errors="replace").strip()
    if not content:
        return []

    doc = {
        "type": "general_faq",
        "topic": "รับประกัน",
        "question_patterns": ["รับประกัน", "เคลม", "warranty", "garantee", "guarantee"],
        "q": "เงื่อนไขการรับประกันสินค้า",
        "a": content,
        "applies_to_brands": [],
        "applies_to_categories": [],
        "source_file": filepath.name,
        "source_row": 1,
        "source_sheet": "",
        "qa_idx": 0,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
        "updated_by": "system_import",
        "version": 1,
        "active": True,
    }
    return [doc]


def _get_admin_db() -> "MongoClient":
    """เชื่อม DB admin โดยใช้ค่าจาก .env."""
    uri = os.environ.get("ADMIN_MONGO_URI", "").strip()
    if uri:
        client = MongoClient(uri)
    else:
        host = os.environ.get("ADMIN_MONGO_HOST", "127.0.0.1:27017").strip()
        username = os.environ.get("ADMIN_MONGO_USERNAME", "").strip()
        password = os.environ.get("ADMIN_MONGO_PASSWORD", "").strip()
        auth_source = os.environ.get("ADMIN_MONGO_AUTH_SOURCE", "admin").strip()
        tls = os.environ.get("ADMIN_MONGO_TLS", "false").strip().lower() == "true"

        params: dict = {"host": host, "authSource": auth_source, "tls": tls}
        if username:
            params["username"] = username
        if password:
            params["password"] = password
        client = MongoClient(**params)

    return client


def main() -> int:
    parser = argparse.ArgumentParser(description="Import adminbase Excel → MongoDB")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="ลบข้อมูลเดิมใน knowledge_base ทั้งหมดก่อน import",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="อ่าน + แปลง แต่ไม่เขียน DB (สำหรับทดสอบ)",
    )
    parser.add_argument(
        "--file",
        type=str,
        default=None,
        help="import เฉพาะไฟล์ที่ระบุ (ชื่อไฟล์ใน adminbase/)",
    )
    args = parser.parse_args()

    if not ADMINBASE_DIR.exists():
        print(f"ERROR: adminbase dir not found: {ADMINBASE_DIR}")
        return 1

    # หาไฟล์ทั้งหมด
    xlsx_files = sorted(ADMINBASE_DIR.glob("*.xlsx"))
    txt_files = sorted(ADMINBASE_DIR.glob("*.txt"))

    if args.file:
        xlsx_files = [f for f in xlsx_files if f.name == args.file]
        txt_files = [f for f in txt_files if f.name == args.file]
        if not xlsx_files and not txt_files:
            print(f"ERROR: file not found: {args.file}")
            return 1

    print(f"=== Import adminbase → MongoDB ===")
    print(f"  DB: {ADMIN_DB_NAME}")
    print(f"  Collections: {KB_PRODUCTS_COLL}, {KB_QA_COLL}, {KB_RAW_COLL}")
    print(f"  Source: {ADMINBASE_DIR}")
    print(f"  Excel files: {len(xlsx_files)}")
    print(f"  TXT files: {len(txt_files)}")
    print(f"  Mode: {'dry-run' if args.dry_run else 'write'}")
    if args.reset:
        print(f"  Reset: YES (will delete existing data)")
    print()

    # อ่าน + แปลงทุกไฟล์ → 3 stores: products / qas / raws
    code_item_map = build_code_item_map()
    print(f"  model_code→item map: {len(code_item_map)} codes (จาก sellable_units.jsonl)\n")
    all_products: list[dict] = []
    all_qas: list[dict] = []
    all_raws: list[dict] = []
    errors: list[str] = []
    file_stats: list[tuple[str, int, int]] = []  # (filename, rows_read, docs_produced)

    for f in xlsx_files:
        try:
            wb = openpyxl.load_workbook(f, read_only=True, data_only=True)
            file_docs = 0
            file_rows = 0
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                rows = list(ws.iter_rows(values_only=True))
                if not rows:
                    continue
                header = [
                    str(c).strip() if c is not None else "" for c in rows[0]
                ]
                for row_idx, row in enumerate(rows[1:], start=2):
                    file_rows += 1
                    product, qas, raw = parse_row(
                        header=header,
                        row=row,
                        source_file=f.name,
                        source_row=row_idx,
                        source_sheet=sheet_name,
                        code_item_map=code_item_map,
                    )
                    if raw["pairs"]:
                        all_raws.append(raw)
                    if product:
                        all_products.append(product)
                        file_docs += 1
                    all_qas.extend(qas)
            wb.close()
            file_stats.append((f.name, file_rows, file_docs))
        except Exception as exc:
            errors.append(f"{f.name}: {exc}")
            file_stats.append((f.name, 0, 0))

    for f in txt_files:
        try:
            docs = _parse_txt_file(f)
            all_qas.extend(docs)
            file_stats.append((f.name, 0, len(docs)))
        except Exception as exc:
            errors.append(f"{f.name}: {exc}")
            file_stats.append((f.name, 0, 0))

    # สรุปการอ่าน
    print("=== File stats ===")
    print(f"{'File':<50s} {'rows':>5s} {'docs':>5s}")
    print("-" * 65)
    total_rows = 0
    for fname, rows, docs in file_stats:
        print(f"{fname[:48]:<50s} {rows:5d} {docs:5d}")
        total_rows += rows
    print("-" * 65)
    print(f"{'TOTAL':<50s} {total_rows:5d} {len(all_products):5d}")
    print(f"  kb_qa docs: {len(all_qas)}   kb_raw docs: {len(all_raws)}")
    print()

    if errors:
        print("=== Errors ===")
        for e in errors:
            print(f"  {e}")
        print()

    # สรุป type distribution
    type_counts: dict[str, int] = {}
    for d in all_products:
        t = d.get("type", "unknown")
        type_counts[t] = type_counts.get(t, 0) + 1
    print("=== Type distribution (kb_products) ===")
    for t, c in sorted(type_counts.items()):
        print(f"  {t}: {c}")
    print()

    # สรุป category distribution
    cat_counts: dict[str, int] = {}
    for d in all_products:
        if d.get("type") == "product_spec":
            cat = d.get("category_id", "other")
            cat_counts[cat] = cat_counts.get(cat, 0) + 1
    print("=== Category distribution (product_spec) ===")
    for cat, c in sorted(cat_counts.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {c}")
    print()

    # coverage รายงาน: canonical specs + item_ids link
    n_canon = sum(1 for d in all_products if d.get("canonical_specs"))
    n_linked = sum(1 for d in all_products if d.get("item_ids"))
    n_codes = sum(1 for d in all_products if d.get("model_codes"))
    print("=== Coverage ===")
    print(f"  products with canonical_specs: {n_canon}/{len(all_products)}")
    print(f"  products with model_codes:     {n_codes}/{len(all_products)}")
    print(f"  products linked to item_ids:   {n_linked}/{len(all_products)}")
    print(f"  kb_qa linked to item_ids:      {sum(1 for d in all_qas if d.get('item_ids'))}/{len(all_qas)}")
    print()

    if args.dry_run:
        print("=== Dry run — not writing to DB ===")
        if all_products:
            sample = next((d for d in all_products if d.get("canonical_specs")), all_products[0]).copy()
            for k in ["extra_fields", "specs_raw"]:
                if sample.get(k):
                    s = str(sample[k])
                    sample[k] = s[:200] + "..." if len(s) > 200 else s
            sample["created_at"] = str(sample["created_at"])
            sample["updated_at"] = str(sample["updated_at"])
            print("  Sample kb_products doc:")
            print(json.dumps(sample, ensure_ascii=False, indent=2, default=str))
        if all_qas:
            s = all_qas[0].copy()
            s["created_at"] = str(s["created_at"]); s["updated_at"] = str(s["updated_at"])
            print("  Sample kb_qa doc:")
            print(json.dumps(s, ensure_ascii=False, indent=2, default=str))
        return 0

    # เขียนลง DB — 3 collections
    print("=== Writing to MongoDB ===")
    client = _get_admin_db()
    db = client[ADMIN_DB_NAME]
    coll_p = db[KB_PRODUCTS_COLL]
    coll_q = db[KB_QA_COLL]
    coll_r = db[KB_RAW_COLL]

    if args.reset:
        for coll in (coll_p, coll_q, coll_r):
            deleted = coll.delete_many({})
            print(f"  Reset {coll.name}: deleted {deleted.deleted_count}")

    def _upsert(coll, docs, key_fields):
        ins = upd = 0
        for doc in docs:
            fq = {k: doc[k] for k in key_fields}
            r = coll.replace_one(fq, doc, upsert=True)
            ins += 1 if r.upserted_id else 0
            upd += 0 if r.upserted_id else 1
        return ins, upd

    i, u = _upsert(coll_r, all_raws, ["source_file", "source_sheet", "source_row"])
    print(f"  {KB_RAW_COLL}:     inserted={i} updated={u} total={coll_r.count_documents({})}")
    i, u = _upsert(coll_p, all_products, ["source_file", "source_sheet", "source_row"])
    print(f"  {KB_PRODUCTS_COLL}: inserted={i} updated={u} total={coll_p.count_documents({})}")
    i, u = _upsert(coll_q, all_qas, ["source_file", "source_sheet", "source_row", "qa_idx"])
    print(f"  {KB_QA_COLL}:      inserted={i} updated={u} total={coll_q.count_documents({})}")
    client.close()

    print()
    print("=== Done ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
