#!/usr/bin/env python3
"""
test_qa_context_guard.py — ทดสอบ qa_context ไม่ crash เมื่อ QA hit มี topic ว่าง

ที่มา (test_200 #132): dict literal ใน qa_context evaluate
f-string "brand" → (topic or '').split()[0] สำหรับทุก hit ก่อนเลือก level
→ hit ใดๆ ที่ topic='' (kb_qa มี 32 docs) → IndexError → HTTP 500

ตรวจ:
1. hit topic='' level=generic → ไม่ raise + tag "คำแนะนำทั่วไป"
2. hit topic ปกติ level=brand → tag "เฉพาะแบรนด์ <คำแรก>" เหมือนเดิม
3. hit topic whitespace → ไม่ raise
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot"))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import knowledge_base


def _check(label: str, actual, expected) -> bool:
    ok = actual == expected
    mark = "✅" if ok else "❌"
    print(f"  {mark} {label}: actual={actual!r} expected={expected!r}")
    return ok


def _run_with_hits(hits):
    """รัน qa_context โดย patch search_qa ให้คืน hits ปลอม (กัน DB/embedding)."""
    orig_search = knowledge_base.search_qa
    orig_resolve = None
    try:
        knowledge_base.search_qa = lambda *a, **k: hits
        # patch route_context resolve เพื่อไม่ให้ต้องต่อ DB (คืน codes ว่าง)
        try:
            from shopeechat import route_context as _rc
            orig_resolve = _rc.resolve_route
            class _R:
                model_codes = ()
            _rc.resolve_route = lambda *a, **k: _R()
        except Exception:
            pass
        return knowledge_base.qa_context("อันไหนเสียงดีสุด")
    finally:
        knowledge_base.search_qa = orig_search
        if orig_resolve is not None:
            try:
                from shopeechat import route_context as _rc
                _rc.resolve_route = orig_resolve
            except Exception:
                pass


def main() -> int:
    passed = 0
    total = 0

    # 1) topic ว่าง + level=generic → ต้องไม่ crash (regression เคส #132)
    total += 1
    try:
        out = _run_with_hits([{"_qa_level": "generic", "topic": "",
                               "q": "อันไหนเสียงดีสุด", "a": "แนะนำรุ่น X",
                               "model_codes": []}])
        ok = _check("empty topic generic → ไม่ raise", "คำแนะนำทั่วไป" in out, True)
        if ok and "แนะนำรุ่น X" in out:
            print("  ✅ output มีคำตอบครบ")
        passed += 1
    except Exception as e:
        print(f"  ❌ empty topic generic → raised {type(e).__name__}: {e}")

    # 2) topic ปกติ + level=brand → tag brand เหมือนเดิม (regression ของเดิม)
    total += 1
    try:
        out = _run_with_hits([{"_qa_level": "brand", "topic": "QCY หูฟัง เสียงดี",
                               "q": "รุ่นไหนเสียงดี", "a": "QCY T13",
                               "model_codes": []}])
        ok = _check("topic 'QCY หูฟัง' brand → tag", "เฉพาะแบรนด์ QCY" in out, True)
        passed += 1 if ok else 0
    except Exception as e:
        print(f"  ❌ brand tag → raised {type(e).__name__}: {e}")

    # 3) topic whitespace-only → ไม่ raise
    total += 1
    try:
        out = _run_with_hits([{"_qa_level": "generic", "topic": "   ",
                               "q": "x", "a": "y", "model_codes": []}])
        ok = _check("whitespace topic → ไม่ raise", "คำแนะนำทั่วไป" in out, True)
        passed += 1 if ok else 0
    except Exception as e:
        print(f"  ❌ whitespace topic → raised {type(e).__name__}: {e}")

    # 4) topic=None (field หาย) → ไม่ raise
    total += 1
    try:
        out = _run_with_hits([{"_qa_level": "generic", "q": "x", "a": "y",
                               "model_codes": []}])
        ok = _check("missing topic → ไม่ raise", "คำแนะนำทั่วไป" in out, True)
        passed += 1 if ok else 0
    except Exception as e:
        print(f"  ❌ missing topic → raised {type(e).__name__}: {e}")

    print(f"\n{passed}/{total} passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
