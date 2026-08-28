#!/usr/bin/env python3
"""check_progress — ดูความคืบหน้า testQA2 ทั้งภาพรวมและรายเคส.

Usage:
    # ภาพรวม (default)
    python test/check_progress.py

    # ดูเคสเฉพาะเลข
    python test/check_progress.py 401 402 501 502

    # ดูช่วงเคส
    python test/check_progress.py 400-410

    # ดู 10 เคสล่าสุด
    python test/check_progress.py --last 10

    # ดูเคสที่ source = error
    python test/check_progress.py --errors

    # ดูเคสที่ไม่มีสินค้า (product_count = 0)
    python test/check_progress.py --no-products

    # ดูเคสใน batch ใด batch หนึ่ง
    python test/check_progress.py --batch per_product_warranty

    # ดูเคสที่ใช้เวลานาน (>10s)
    python test/check_progress.py --slow

    # รวมหลาย filter
    python test/check_progress.py --batch per_product_detail --last 20
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS_FILE = ROOT / "testresult" / "testQA2_results.json"
PLAN_FILE = ROOT / "testresult" / "testQA2_plan.json"
TOTAL = 13537


def load_results() -> list[dict]:
    if not RESULTS_FILE.exists():
        print(f"❌ ยังไม่มี results file ({RESULTS_FILE})")
        print("   รัน: python test/run_daily_tests.py ก่อน")
        sys.exit(1)
    with open(RESULTS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_plan_stats() -> dict:
    if not PLAN_FILE.exists():
        return {}
    try:
        with open(PLAN_FILE, "r", encoding="utf-8") as f:
            plan = json.load(f)
        return plan.get("stats", {})
    except Exception:
        return {}


def show_overview(data: list[dict], plan_stats: dict):
    """แสดงภาพรวมพร้อม checkpoint."""
    done = len(data)
    total = plan_stats.get("total", TOTAL)
    pct = done / total * 100 if total else 0

    src = Counter(d["source"] for d in data)
    batch = Counter(d.get("batch", "?") for d in data)
    checkpoints = done // 50

    print()
    print("=" * 70)
    print("📊 ความคืบหน้า testQA2")
    print("=" * 70)
    print(f"  รันแล้ว: {done}/{total} ({pct:.1f}%)")
    print(f"  เหลือ: {total - done}")
    print()

    # progress bar
    bar_len = 50
    filled = int(bar_len * done / total) if total else 0
    bar = "█" * filled + "░" * (bar_len - filled)
    print(f"  [{bar}] {pct:.1f}%")
    print()

    # checkpoints ทุก 50 เคส
    print(f"  ✅ Checkpoints ผ่าน ({checkpoints} จุด):")
    shown = 0
    for cp in range(1, checkpoints + 1):
        # แสดง: 5 จุดแรก, ทุก 10, และจุดสุดท้าย
        if cp <= 5 or cp == checkpoints or cp % 10 == 0:
            print(f"     ✅ จุดที่ {cp * 50:6d} เคส")
            shown += 1
    if checkpoints > shown:
        print(f"     ... (ทั้งหมด {checkpoints} จุด)")
    print()

    # by batch
    print(f"  📦 แยกตาม batch:")
    for bn, cnt in batch.most_common():
        plan_cnt = plan_stats.get(bn, "?")
        bpct = cnt / plan_cnt * 100 if isinstance(plan_cnt, int) and plan_cnt else 0
        print(f"     {bn:25s}: {cnt:5d} / {plan_cnt} ({bpct:.1f}%)")
    print()

    # by source
    print(f"  🔗 แยกตาม source:")
    for s, cnt in src.most_common():
        print(f"     {s:25s}: {cnt:5d}")
    print()

    # errors / no products
    errors = sum(1 for d in data if d.get("source") == "error")
    no_prods = sum(1 for d in data if d.get("product_count", 0) == 0)
    print(f"  ⚠️  errors: {errors} | no-products: {no_prods}")
    print()

    # 3 ล่าสุด
    print(f"  📝 3 ล่าสุด:")
    for d in data[-3:]:
        print(f"     {d['test_id']} | {d['message'][:35]} | src={d['source']} prods={d['product_count']} {d['elapsed']:.1f}s")
    print()

    # เวลา
    times = [datetime.fromisoformat(d["timestamp"]) for d in data if d.get("timestamp")]
    if len(times) >= 2:
        elapsed_total = (times[-1] - times[0]).total_seconds()
        avg_per_req = elapsed_total / (len(times) - 1)
        remaining_secs = (total - done) * avg_per_req
        now = datetime.now()
        print(f"  ⏱  เวลาเฉลี่ย/เคส: {avg_per_req:.1f}s")
        print(f"  ⏱  เวลาที่ผ่าน: {elapsed_total / 60:.1f} นาที")
        print(f"  ⏱  ประมาณเวลาที่เหลือ (ทั้งหมด): {remaining_secs / 3600:.1f} ชม")
        # ก่อน 18:00
        end = now.replace(hour=18, minute=0, second=0, microsecond=0)
        secs_to_18 = (end - now).total_seconds()
        if secs_to_18 > 0:
            cases_to_18 = int(secs_to_18 / avg_per_req)
            print(f"  ⏱  ก่อน 18:00 น. รันได้อีก: ~{cases_to_18} เคส")
    print("=" * 70)


def show_case(data: list[dict], idx: int):
    """แสดงรายละเอียดเคสที่ idx (1-based)."""
    if idx < 1 or idx > len(data):
        print(f"❌ เคสที่ {idx} ยังไม่มี (รันแล้ว {len(data)} เคส)")
        return
    d = data[idx - 1]  # 1-based → 0-based
    print()
    print(f"─" * 70)
    print(f"🔍 เคสที่ {idx}")
    print(f"─" * 70)
    print(f"  test_id     : {d.get('test_id', '?')}")
    print(f"  batch       : {d.get('batch', '?')}")
    print(f"  message     : {d.get('message', '?')}")
    print(f"  source      : {d.get('source', '?')}")
    print(f"  products    : {d.get('product_count', 0)} รายการ")
    print(f"  elapsed     : {d.get('elapsed', 0):.1f}s")
    print(f"  timestamp   : {d.get('timestamp', '?')}")
    print(f"  expected    : {d.get('expected', '?')}")
    print(f"  check       : {d.get('check', '?')}")
    # product names
    prods = d.get("product_names", [])
    if prods:
        print(f"  ──────────────")
        print(f"  สินค้าที่ดึงมา:")
        for i, p in enumerate(prods):
            print(f"    {i + 1}. {p}")
    # answer preview
    ans = d.get("answer_full") or d.get("answer_preview", "")
    if ans:
        print(f"  ──────────────")
        print(f"  คำตอบ ({len(ans)} ตัวอักษร):")
        # แสดง 500 ตัวแรก
        preview = ans[:500]
        if len(ans) > 500:
            preview += f"\n... ({len(ans) - 500} ตัวอักษรถัดไป)"
        print(f"  {preview}")
    print(f"─" * 70)


def show_range(data: list[dict], start: int, end: int):
    """แสดงเคสในช่วง start-end (1-based)."""
    print()
    print(f"{'#':>5s}  {'test_id':25s}  {'batch':25s}  {'src':20s}  {'p':>3s}  {'t':>5s}  message")
    print("─" * 120)
    for idx in range(start, min(end + 1, len(data) + 1)):
        d = data[idx - 1]
        print(
            f"{idx:5d}  {d.get('test_id', '?'):25s}  "
            f"{d.get('batch', '?'):25s}  "
            f"{d.get('source', '?'):20s}  "
            f"{d.get('product_count', 0):3d}  "
            f"{d.get('elapsed', 0):5.1f}s  "
            f"{d.get('message', '?')[:30]}"
        )
    print("─" * 120)
    print(f"  แสดง {min(end, len(data)) - start + 1} เคส (#{start}-#{min(end, len(data))})")


def parse_range(arg: str) -> tuple[int, int] | int:
    """parse '401' → 401, '400-410' → (400, 410)."""
    if "-" in arg:
        parts = arg.split("-")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            return int(parts[0]), int(parts[1])
    if arg.isdigit():
        return int(arg)
    return None


def main():
    parser = argparse.ArgumentParser(description="check_progress — ดูความคืบหน้า testQA2")
    parser.add_argument("cases", nargs="*", help="เลขเคสที่จะดู (เช่น 401 402 หรือ 400-410)")
    parser.add_argument("--last", type=int, metavar="N", help="ดู N เคสล่าสุด")
    parser.add_argument("--errors", action="store_true", help="ดูเฉพาะเคสที่ error")
    parser.add_argument("--no-products", action="store_true", help="ดูเฉพาะเคสที่ไม่มีสินค้า")
    parser.add_argument("--slow", action="store_true", help="ดูเฉพาะเคสที่ใช้เวลา >10s")
    parser.add_argument("--batch", metavar="NAME", help="กรองเฉพาะ batch ที่ระบุ")
    parser.add_argument("--source", metavar="NAME", help="กรองเฉพาะ source ที่ระบุ")
    args = parser.parse_args()

    data = load_results()
    plan_stats = load_plan_stats()

    # ---- กรองตาม filter ----
    filtered = data
    if args.errors:
        filtered = [d for d in data if d.get("source") == "error"]
    if args.no_products:
        filtered = [d for d in filtered if d.get("product_count", 0) == 0]
    if args.slow:
        filtered = [d for d in filtered if d.get("elapsed", 0) > 10]
    if args.batch:
        filtered = [d for d in filtered if d.get("batch") == args.batch]
    if args.source:
        filtered = [d for d in filtered if d.get("source") == args.source]

    used_filter = any([args.errors, args.no_products, args.slow, args.batch, args.source])

    # ---- mode: ดูเคสเฉพาะเลข ----
    if args.cases:
        for arg in args.cases:
            r = parse_range(arg)
            if r is None:
                print(f"❌ '{arg}' ไม่ใช่เลขหรือช่วงที่ถูกต้อง")
                continue
            if isinstance(r, tuple):
                show_range(data, r[0], r[1])
            else:
                show_case(data, r)
        # แสดง overview ด้วย
        show_overview(data, plan_stats)
        return

    # ---- mode: ดู N ล่าสุด ----
    if args.last:
        n = args.last
        start = max(1, len(data) - n + 1)
        end = len(data)
        show_range(data, start, end)
        show_overview(data, plan_stats)
        return

    # ---- mode: มี filter ----
    if used_filter:
        print()
        print(f"📋 พบ {len(filtered)} เคสที่ตรงเงื่อนไข (จาก {len(data)} เคสทั้งหมด)")
        print()
        if not filtered:
            print("  ไม่มีเคสที่ตรงเงื่อนไข")
        else:
            print(f"{'#':>5s}  {'test_id':25s}  {'batch':25s}  {'src':20s}  {'p':>3s}  {'t':>5s}  message")
            print("─" * 120)
            for idx, d in enumerate(filtered, 1):
                # หาเลขจริงใน data
                real_idx = data.index(d) + 1
                print(
                    f"#{real_idx:<4d} {d.get('test_id', '?'):25s}  "
                    f"{d.get('batch', '?'):25s}  "
                    f"{d.get('source', '?'):20s}  "
                    f"{d.get('product_count', 0):3d}  "
                    f"{d.get('elapsed', 0):5.1f}s  "
                    f"{d.get('message', '?')[:30]}"
                )
            print("─" * 120)
        show_overview(data, plan_stats)
        return

    # ---- default: overview ----
    show_overview(data, plan_stats)


if __name__ == "__main__":
    main()
