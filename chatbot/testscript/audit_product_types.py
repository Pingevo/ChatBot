#!/usr/bin/env python3
"""
audit_product_types.py — วิเคราะห์ ShpProducts collection
เพื่อหา cat_name / item_name ที่ไม่ถูกจับด้วย PRODUCT_TYPES ปัจจุบัน

วิธีใช้:
  cd chatbot
  ../.venv/bin/python3 testscript/audit_product_types.py

ผลลัพธ์: พิมพ์ cat_name distribution + sample item_names + gap analysis
"""
from __future__ import annotations
import os
import sys
import re
from collections import Counter, defaultdict
from pathlib import Path

# ─── path + .env ─────────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import product_store
from shopeechat.product_store import (
    PRODUCT_TYPES,
    _PRODUCT_TYPE_CATEGORIES,
    _detect_product_types,
    _detect_charger_subtype,
)

# ─── connect ─────────────────────────────────────────────────
client = product_store.get_client()
db_name = os.environ.get("MONGO_DB", "").strip()
if not db_name:
    raise SystemExit("ERROR: MONGO_DB ไม่ถูกตั้งใน .env")
db = client[db_name]
coll_name = os.environ.get("MONGO_COLLECTION", "ShpProducts").strip() or "ShpProducts"
coll = db[coll_name]

print(f"=== Audit ShpProducts: {coll_name} (db={db_name}) ===\n")

# ─── 1. cat_name distribution ────────────────────────────────
print("=== 1. cat_name distribution ===")
pipeline = [
    {"$group": {"_id": "$cat_name", "count": {"$sum": 1}}},
    {"$sort": {"count": -1}},
]
cat_counts = list(coll.aggregate(pipeline))
total = sum(c["count"] for c in cat_counts)
print(f"Total products: {total}")
print(f"Distinct cat_name: {len(cat_counts)}\n")
for c in cat_counts:
    print(f"  {c['count']:>6}  {c['_id']}")

# ─── 2. Sample item_names per cat_name ────────────────────────
print("\n=== 2. Sample item_names per cat_name (5 per cat) ===")
for c in cat_counts:
    cat = c["_id"]
    if not cat:
        continue
    docs = coll.find({"cat_name": cat}, {"item_name": 1, "_id": 0}).limit(5)
    names = [d.get("item_name", "") for d in docs]
    print(f"\n  [{cat}] ({c['count']} products)")
    for n in names:
        print(f"    - {n}")

# ─── 3. Test _detect_product_types against item_names ─────────
print("\n\n=== 3. _detect_product_types coverage per cat_name ===")
# สำหรับแต่ละ cat_name ทดสอบว่า item_name ถูกจับด้วย PRODUCT_TYPES ไหม
# (จับแบบ: _detect_product_types(item_name) คืน set ที่ไม่ว่าง)
type_coverage = defaultdict(lambda: {"matched": 0, "unmatched": 0, "samples_unmatched": []})

for c in cat_counts:
    cat = c["_id"]
    if not cat:
        continue
    docs = coll.find({"cat_name": cat}, {"item_name": 1, "_id": 0}).limit(50)
    for d in docs:
        name = d.get("item_name", "")
        if not name:
            continue
        types = _detect_product_types(name)
        if types:
            type_coverage[cat]["matched"] += 1
        else:
            type_coverage[cat]["unmatched"] += 1
            if len(type_coverage[cat]["samples_unmatched"]) < 3:
                type_coverage[cat]["samples_unmatched"].append(name)

print(f"\n{'cat_name':<50} {'matched':>8} {'unmatched':>10}")
print("-" * 72)
for cat in sorted(type_coverage.keys()):
    tc = type_coverage[cat]
    total_tested = tc["matched"] + tc["unmatched"]
    pct = (tc["matched"] / total_tested * 100) if total_tested > 0 else 0
    flag = " ⚠️" if tc["unmatched"] > 0 else ""
    print(f"{str(cat):<50} {tc['matched']:>8} {tc['unmatched']:>10}  ({pct:.0f}%){flag}")
    if tc["unmatched"] > 0:
        for s in tc["samples_unmatched"]:
            print(f"    unmatched: {s}")

# ─── 4. cat_name → which PRODUCT_TYPES map to it ─────────────
print("\n\n=== 4. cat_name → mapped PRODUCT_TYPES (via _PRODUCT_TYPE_CATEGORIES) ===")
# reverse map: cat_name → list of product types
cat_to_types = defaultdict(list)
for pt, cats in _PRODUCT_TYPE_CATEGORIES.items():
    for cat in cats:
        cat_to_types[cat].append(pt)

for c in cat_counts:
    cat = c["_id"]
    if not cat:
        continue
    mapped = cat_to_types.get(cat, [])
    if mapped:
        print(f"  {cat:<50} → {mapped}")
    else:
        print(f"  {cat:<50} → (no product type mapped) ⚠️")

# ─── 5. cat_name with no product type mapping AND no item_name match ─
print("\n\n=== 5. GAP: cat_name ที่ไม่มี product type และ item_name ไม่ถูกจับ ===")
gaps = []
for c in cat_counts:
    cat = c["_id"]
    if not cat:
        continue
    mapped = cat_to_types.get(cat, [])
    tc = type_coverage.get(cat, {"matched": 0, "unmatched": 0, "samples_unmatched": []})
    # gap = ไม่มี mapping หรือมี mapping แต่ item_name ไม่ถูกจับเลย
    if not mapped or tc["matched"] == 0:
        gaps.append({
            "cat_name": cat,
            "count": c["count"],
            "mapped_types": mapped,
            "item_match_pct": (tc["matched"] / (tc["matched"] + tc["unmatched"]) * 100)
                if (tc["matched"] + tc["unmatched"]) > 0 else 0,
            "samples": tc["samples_unmatched"],
        })

if gaps:
    print(f"Found {len(gaps)} cat_name with gaps:\n")
    for g in sorted(gaps, key=lambda x: -x["count"]):
        print(f"  [{g['count']:>5}] {g['cat_name']}")
        print(f"         mapped: {g['mapped_types'] or 'NONE'}")
        print(f"         item match: {g['item_match_pct']:.0f}%")
        for s in g["samples"]:
            print(f"         sample: {s}")
        print()
else:
    print("No gaps found — all cat_name have product type mapping and item_name matches.")

print("\n=== Audit complete ===")
