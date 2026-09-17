"""test_qa_kb.py — regression tests สำหรับ KB/QA wiring (plan 2026-09-16-kb-qa-wiring).

ครอบคลุม:
  - collection repoint: kb_products / kb_qa / general_faq normalization
  - search_qa: model match, cross-model guard, brand scope
  - warranty parse: positive (1Y/2Y/12M/15M/ประกันศูนย์ไทย) + negative (70mai, DEM-CS50M, T11M, 1.5M)
  - warranty_text banner join + missing-banner fallback

รัน:  PYTHONPATH=chatbot .venv/bin/python chatbot/testscript/test_qa_kb.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "shopeechat"))

from shopeechat import knowledge_base as kb  # noqa: E402
from shopeechat import units as _units  # noqa: E402
from shopeechat import warranty as _w  # noqa: E402

PASS, FAIL = [], []


def check(name: str, cond: bool, detail: str = ""):
    (PASS if cond else FAIL).append(name)
    print(f"{'✅' if cond else '❌'} {name}" + (f"  | {detail}" if detail else ""))


# ---------- 1. collection repoint ----------
def test_repoint():
    try:
        res = kb.lookup_kb("EC4")
        docs = (res or {}).get("kb_docs") or []
        models = sorted({(d.get("model") or "") for d in docs})
        check("repoint kb_products: EC4 lookup ไม่ว่าง", bool(res and res["found"]),
              str(models[:3]))
        # kb_products ไม่มี field 'specs' — context ต้องได้ spec จาก canonical_specs/specs_raw
        ctx = (res or {}).get("context") or ""
        check("format_kb_context ใช้ canonical_specs/specs_raw", len(ctx) > 50,
              f"ctx_len={len(ctx)}")
    except Exception as e:
        check("repoint kb_products: EC4 lookup", False, repr(e))
    try:
        faq = kb.get_general_faq() or {}
        check("kb_qa general_faq: answer normalized (a→answer)",
              len(faq.get("answer") or "") > 100,
              f"len={len(faq.get('answer') or '')}")
        check("base_warranty_text ใช้งานได้", len(kb.get_base_warranty_text() or "") > 100)
    except Exception as e:
        check("general_faq", False, repr(e))


# ---------- 2. search_qa ----------
def test_search_qa():
    # model-specific match
    hits = kb.search_qa("LPB200NL ใช้กับ S26 ได้ไหม",
                        model_codes={"LPB200NL"}, known_brand="cuktech")
    check("model match: LPB200NL คืน doc ของ LPB200NL",
          any("LPB200NL" in str(h.get("model_codes") or "") or "LPB200NL" in (h.get("topic") or "")
              for h in hits), f"hits={len(hits)}")
    # cross-model guard: query LPB200NL ห้ามได้ doc ของ KLC-5497
    leak = [h for h in hits if "KLC-5497" in str(h.get("model_codes") or "")
            or "KLC-5497" in (h.get("topic") or "")]
    check("cross-model guard: ไม่มี KLC-5497 หลุดมา", not leak, f"leak={len(leak)}")
    # topic-derived model scope: doc ที่ topic มีรหัสรุ่นแต่ model_codes ว่าง ต้องไม่ถือเป็น generic
    hits2 = kb.search_qa("PB150S ใช้กับ S26 ได้ไหม",
                         model_codes={"PB150S"}, known_brand="cuktech")
    leak2 = [h for h in hits2 if h.get("_qa_level") == "generic"
             and ("KLC-5497" in (h.get("topic") or "") or "LPB200NL" in (h.get("topic") or ""))]
    check("topic-derived scope: doc topic มีรหัสรุ่นอื่นไม่เป็น generic", not leak2)
    # brand scope: KS3 (kieslect) ห้ามได้ KOSPET/Black Shark generic
    hits3 = kb.search_qa("KS3 วิธีกลับด้านหน้าจอ",
                         model_codes={"KS3"}, known_brand="kieslect")
    xbrand = [h for h in hits3
              if (h.get("topic") or "").lower().startswith(("kospet", "black shark"))]
    check("brand scope: query kieslect ไม่ได้ KOSPET/Black Shark", not xbrand,
          f"hits={[(h.get('topic'), h['_qa_level']) for h in hits3]}")
    # generic brand QA: คำถามทั่วไปของ kieslect ต้องยังหาเจอ
    hits4 = kb.search_qa("นาฬิกาแบตลดไวครับ", model_codes=set(), known_brand="kieslect")
    check("generic brand QA: 'นาฬิกาแบตลดไว' เจอ Kieslect QA",
          any((h.get("topic") or "").lower().startswith("kieslect") for h in hits4),
          f"hits={[(h.get('topic'), h['_qa_score']) for h in hits4[:2]]}")
    # troubleshoot tips: brand-scoped symptom → fire; bare claim → ไม่ fire
    tips = kb.qa_troubleshoot_tips("Kieslect นาฬิกาแบตเสื่อม เคลมได้ไหม")
    check("troubleshoot tips: brand+symptom → มีคำแนะนำ", bool(tips),
          (tips[0] or "")[:50] if tips else "")
    tips2 = kb.qa_troubleshoot_tips("สินค้าเสียครับอยากเคลม")
    check("troubleshoot tips: bare claim ไม่มี context → ไม่แนะนำ", not tips2)


# ---------- 3. warranty parse ----------
def test_warranty_parse():
    pos = [
        ("IMILAB EC5 ประกันศูนย์ไทย -2Y", 24), ("Realme 5i ประกันศูนย์ไทย 1Y", 12),
        ("Xiaomi Mi Note 10 Lite -15M", 15), ("Tile Mate -12M", 12),
        ("SanDisk Extreme ประกัน Synnex -7Y", 84), ("PISEN Buds -18M", 18),
        ("กล้อง ประกัน 2 ปี", 24),
    ]
    for name, months in pos:
        w = _w.extract_warranty_from_name(name)
        check(f"parse+ {name[:45]!r} → {months} เดือน",
              bool(w) and w["months"] == months, str(w))
    neg = [
        "70mai Dash Cam Pro Plus A500S", "DEM-CS50M Speaker", "Himo T11M",
        "สายชาร์จ USB-C 1.5M ยาว", "โค้ดส่วนลด EVLM7M", "Powerbank 20000mAh",
    ]
    for name in neg:
        w = _w.extract_warranty_from_name(name)
        check(f"parse- {name[:45]!r} → None", w is None, str(w))


# ---------- 4. unit card + banner join ----------
def test_unit_card_and_banner():
    # to_unit_card: warranty field
    u = {"item_name": "IMILAB EC5 -2Y", "display_name": "EC5", "stock": 3,
         "price": 990, "image_ids": []}
    c = _units.to_unit_card(u)
    check("unit card warranty: '-2Y' → 2 ปี",
          bool(c["warranty"]) and c["warranty"]["duration"] == "2 ปี", str(c["warranty"]))
    c2 = _units.to_unit_card({"item_name": "70mai A500S", "display_name": "x",
                              "stock": 1, "price": 1, "image_ids": []})
    check("unit card warranty: '70mai' → None", c2["warranty"] is None)
    # banner join: unit ที่ image_ids ชี้ banner ที่มีคำว่าประกัน → warranty_text
    try:
        coll = _units._units_coll().database["image_texts"]
        banner = coll.find_one(
            {"kind": "banner",
             "text": {"$regex": "ประกัน|รับประกัน|เคลม|warranty", "$options": "i"}},
            {"image_id": 1})
        if not banner:
            check("banner join", True, "skip — image_texts ยังไม่มี banner (import ยังไม่เสร็จ)")
            return
        fake_unit = {"image_ids": [banner["image_id"]], "item_name": "X", "stock": 1,
                     "price": 1, "display_name": "x"}
        out = _units.attach_image_texts([fake_unit])[0]
        check("banner join: warranty_text ถูก attach", bool(out.get("warranty_text")),
              (out.get("warranty_text") or "")[:60])
        # missing banner → ไม่มี warranty_text (fallback ใช้ general policy)
        out2 = _units.attach_image_texts(
            [{"image_ids": ["__nonexistent__"], "item_name": "X", "stock": 1,
              "price": 1, "display_name": "x"}])[0]
        check("missing banner → warranty_text ว่าง (fallback)", "warranty_text" not in out2)
    except Exception as e:
        check("banner join", False, repr(e))


if __name__ == "__main__":
    print("=== test_qa_kb.py ===")
    test_repoint()
    test_search_qa()
    test_warranty_parse()
    test_unit_card_and_banner()
    print(f"\n=== {len(PASS)} passed, {len(FAIL)} failed ===")
    if FAIL:
        print("FAILED:", *FAIL, sep="\n  ")
        sys.exit(1)
