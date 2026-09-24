"""Integration test: RetrievalProfile (Task 4A) กับ MongoDB จริง.

รัน: .venv/bin/python docs/test/test_retrieval_profile_db.py
ต้องมี .env (load_dotenv) — ใช้ product_store.get_client() singleton

ตรวจ:
1. profile จากข้อความจริง → fetch สินค้าจริงในร้านนั้นสอดคล้องกัน
   - "สายชาร์จใช้กับ iPhone 13" → profile charger+cable → ร้านมี cable จริง
   - Mi17 follow-up (history สายชาร์จ) → charger+cable+mi17 → ร้านมี cable จริง
     (หลักฐานว่า "ไม่มีสินค้าที่ใช้ด้วยได้" เป็น bug ตั้งแต่ profile ผิด)
2. anchor cards จริงจาก DB → compare profile (anchor_item_ids เป็น str ของ item_id จริง)
3. model code จริงจาก DB (เช่น HA835) → exact_model/answerable_all
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))

from chatbot.shopeechat import product_store, route_context  # noqa: E402


def _check(label: str, actual, expected) -> bool:
    ok = actual == expected
    mark = "✅" if ok else "❌"
    print(f"  {mark} {label}: actual={actual!r} expected={expected!r}")
    return ok


def _find_real_items(db, shop: str, name_rx: str, limit: int = 5) -> list[dict]:
    """ดึง doc จริงจาก ShpProducts ตาม shop + name regex."""
    return list(db["ShpProducts"].find(
        {"shopname": shop, "item_name": re.compile(name_rx, re.IGNORECASE)},
        {"item_id": 1, "item_name": 1, "shopname": 1, "item_status": 1,
         "model": 1, "price": 1, "price_info": 1},
    ).limit(limit))


def main() -> None:
    passed = 0
    failed = 0

    client = product_store.get_client()
    db = client[os.environ.get("MONGO_DB", "")]
    print(f"=== connected: db={db.name} ===\n")

    # ── 1) หา shop จริงที่มีสายชาร์จขายอยู่ (หลักฐาน Mi17 false-negative) ──
    print("=== 1) real sellable cables ใน DB ===")
    cable_docs = list(db["ShpProducts"].find(
        {"item_name": re.compile(r"สายชาร์จ|cable", re.IGNORECASE),
         "item_status": "NORMAL"},
        {"item_id": 1, "item_name": 1, "shopname": 1, "item_status": 1, "model": 1},
    ).limit(200))
    sellable = [d for d in cable_docs
                if product_store.resolve_availability(d)["available_for_sale"]]
    shops_with_cable = sorted({d.get("shopname") for d in sellable})
    if _check("มีร้านที่ขายสายชาร์จจริง (sellable)", len(shops_with_cable) > 0, True):
        passed += 1
    else:
        failed += 1
    print(f"     shops: {shops_with_cable[:8]}")
    real_shop = shops_with_cable[0] if shops_with_cable else None

    # ── 2) profile "สายชาร์จใช้กับ iPhone 13" → ร้านจริงมีของตรง profile ──
    print("\n=== 2) profile vs real stock ===")
    if real_shop:
        prof = route_context.build_retrieval_profile(
            "สายชาร์จใช้กับ iPhone 13 ได้ไหม",
            history=[],
            intent_result={"intent": "compatibility_check", "confidence": 0.95},
            shop=real_shop,
        )
        checks = [
            ("types=charger", prof.product_types == frozenset({"charger"})),
            ("subtype=cable", prof.subtype == "cable"),
            ("device=iphone 13", (prof.target_device or "").lower() == "iphone 13"),
            ("compat=connector_required", prof.compat_mode == "connector_required"),
        ]
        for label, ok in checks:
            if _check(label, ok, True):
                passed += 1
            else:
                failed += 1
        # ร้านที่ profile ชี้ มี cable ขายจริงใน DB ร้านนั้น
        shop_sellable = any(d.get("shopname") == real_shop for d in sellable)
        if _check(f"{real_shop} มี cable sellable จริง", shop_sellable, True):
            passed += 1
        else:
            failed += 1

    # ── 3) Mi17 follow-up — history carry + ร้านมีของจริง ──
    print("\n=== 3) Mi17 follow-up vs real stock ===")
    prof = route_context.build_retrieval_profile(
        "อยากได้ที่ใช้กับ mi 17 ultra",
        history=[{"role": "user", "text": "มีสายชาร์จไหม"}],
        intent_result={"intent": "other", "confidence": 0.0},
        shop="KingGadgets",
    )
    checks = [
        ("types=charger", prof.product_types == frozenset({"charger"})),
        ("subtype=cable (history)", prof.subtype == "cable"),
        ("device=mi 17 ultra", (prof.target_device or "").lower() == "mi 17 ultra"),
        ("('subtype','history') in fact_sources",
         ("subtype", "history") in prof.fact_sources),
    ]
    for label, ok in checks:
        if _check(label, ok, True):
            passed += 1
        else:
            failed += 1
    kg_cables = [d for d in cable_docs if d.get("shopname") == "KingGadgets"]
    kg_sellable = [d for d in kg_cables
                   if product_store.resolve_availability(d)["available_for_sale"]]
    print(f"     KingGadgets cables: total={len(kg_cables)} sellable={len(kg_sellable)}")
    if _check("KingGadgets มี cable sellable จริง (พิสูจน์ false 'ไม่มีสินค้า')",
              len(kg_sellable) > 0, True):
        passed += 1
    else:
        failed += 1

    # ── 4) anchor cards จริง → compare profile ──
    print("\n=== 4) real anchor cards → compare ===")
    if real_shop:
        raw = _find_real_items(db, real_shop, r"สายชาร์จ|cable", limit=2)
        cards = [product_store.to_product_card(d) for d in raw]
        if len(cards) >= 2:
            prof = route_context.build_retrieval_profile(
                "อันไหนดีกว่า",
                history=[],
                intent_result={"intent": "other", "confidence": 0.4},
                shop=real_shop,
                anchor_cards=cards,
            )
            # item_id ใน Mongo เป็น float (เช่น 46057699735.0) → profile normalize เป็น int-str
            expected_ids = tuple(
                str(int(v)) if isinstance(v := c["item_id"], float) and v.is_integer()
                else str(v) for c in cards)
            checks = [
                ("intent=compare", prof.intent == "compare"),
                ("availability=answerable_all",
                 prof.availability_mode == "answerable_all"),
                ("anchor_item_ids ตรง DB จริง",
                 prof.anchor_item_ids == expected_ids),
            ]
            for label, ok in checks:
                if _check(label, ok, True):
                    passed += 1
                else:
                    failed += 1
        else:
            print(f"     ⚠️ {real_shop} มี cable <2 — ข้าม compare check")

    # ── 5) model code จริงจาก DB → exact_model ──
    print("\n=== 5) real model code ===")
    # หา token รูป model-code จาก item_name จริง (เช่น HA835, PB100, EC4)
    real_code = None
    for doc in db["ShpProducts"].find(
            {"item_status": "NORMAL"}, {"item_name": 1}).limit(500):
        for tok in re.split(r"[\s\-_/+(),]+", doc.get("item_name") or ""):
            t = tok.strip()
            if (3 <= len(t) <= 12
                    and re.fullmatch(r"[A-Za-z]{0,5}\d{2,5}[A-Za-z]{0,3}", t)
                    and any(c.isdigit() for c in t) and any(c.isalpha() for c in t)):
                real_code = t
                break
        if real_code:
            break
    if real_code:
        prof = route_context.build_retrieval_profile(
            f"{real_code} ยังมีประกันไหม",
            history=[],
            intent_result={"intent": "warranty_duration", "confidence": 0.9},
            shop="AnyShop",
        )
        checks = [
            (f"model_codes มี {real_code}", real_code.upper() in prof.model_codes),
            ("availability=answerable_all",
             prof.availability_mode == "answerable_all"),
            ("code ไม่ถูกนับเป็น device", prof.target_device is None),
        ]
        for label, ok in checks:
            if _check(label, ok, True):
                passed += 1
            else:
                failed += 1
    else:
        print("     ⚠️ ไม่เจอ model code จริงใน DB — ข้าม")

    print(f"\n{'=' * 50}")
    print(f"ผล: ผ่าน {passed} / ล้มเหลว {failed}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
