#!/usr/bin/env python3
"""
test_cert_standards.py — ทดสอบ cert standards detection + search (มอก./CE/CCC/FCC/RoHS/GB)

ตรวจ:
1. detect_cert_question จับ cert ที่ถาม + ไม่ false positive (หมอก/service/price/8GB)
2. extract_tisi_model_keyword ตัด cert keywords ออกถูก
3. search_cert_products merge description + image_texts (admin DB) โดย item_ids
4. compat: detect_tisi_question/search_tisi_products เดิมยังทำงาน
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "chatbot"))
from dotenv import load_dotenv
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".env")

from shopeechat import warranty, product_store


def _check(label: str, actual, expected) -> bool:
    ok = actual == expected
    mark = "✅" if ok else "❌"
    print(f"  {mark} {label}: actual={actual!r} expected={expected!r}")
    return ok


# ---- fake mongo ----

class _FakeCursor(list):
    def limit(self, n):
        return _FakeCursor(self[:n])


class _FakeColl:
    """find(query, proj) → docs ทั้งหมด (filter ทำเองใน test ขั้นต่ำ)."""
    def __init__(self, docs):
        self.docs = docs
        self.queries = []

    def find(self, query, proj=None):
        self.queries.append(query)
        # regex prefilter แบบง่าย: match "text" หรือ "description" ที่มี substring ใดใน pattern
        import re as _re
        out = []
        for d in self.docs:
            ok = True
            for field, cond in (query or {}).items():
                if isinstance(cond, dict) and "$regex" in cond:
                    val = d.get(field) or ""
                    if not _re.search(cond["$regex"], val, _re.IGNORECASE):
                        ok = False
                elif isinstance(cond, dict) and "$in" in cond:
                    if d.get(field) not in cond["$in"]:
                        ok = False
            if ok:
                out.append(d)
        return _FakeCursor(out)


class _FakeDb:
    def __init__(self, colls: dict):
        self._colls = colls

    def __getitem__(self, name):
        return self._colls[name]


def main() -> int:
    passed = 0
    failed = 0

    def test(label, actual, expected):
        nonlocal passed, failed
        if _check(label, actual, expected):
            passed += 1
        else:
            failed += 1

    print("=== 1. detect_cert_question — จับ cert ที่ถาม ===")
    test("มอก. ทั่วไป", warranty.detect_cert_question("รุ่นไหนมี มอก. บ้าง"), ("tisi",))
    test("มอก เฉพาะรุ่น", "tisi" in warranty.detect_cert_question("AC65B2 มี มอก. ไหม"), True)
    test("CE", warranty.detect_cert_question("ผ่าน CE ไหม"), ("ce",))
    test("ccc lowercase", warranty.detect_cert_question("มี ccc มั้ย"), ("ccc",))
    test("GB/T", warranty.detect_cert_question("GB/T ผ่านไหม"), ("gb",))
    test("FCC", warranty.detect_cert_question("มี fcc ไหมครับ"), ("fcc",))
    test("RoHS", warranty.detect_cert_question("rohs ผ่านรึเปล่า"), ("rohs",))
    test("generic มาตรฐาน → all", len(warranty.detect_cert_question("สินค้าผ่านมาตรฐานอะไรบ้าง")) >= 5, True)
    test("tisi keyword เดิม", warranty.detect_cert_question("tisi certified ไหม"), ("tisi",))

    print("=== 2. detect_cert_question — false positive guard ===")
    test("หมอก (fog)", warranty.detect_cert_question("หมอกเย็นเกรดไมครอน"), ())
    test("เสมอกัน", warranty.detect_cert_question("เสมอกันที่ 0.8 มม."), ())
    test("เสมอการ", warranty.detect_cert_question("อยู่เสมอการแจ้งเตือน"), ())
    # regex-level: "เสมอกัน" เก็บเป็น [เ][ส][ม][อ][ก] — ตัวก่อน มอก คือ ส (ไม่ใช่ เ)
    test("_has_cert เสมอกัน→None", product_store._has_cert("มีความเสมอกันที่ 0.8 มม.", ("tisi",)), None)
    test("_has_cert เสมอการ→None", product_store._has_cert("เปิดอยู่เสมอการแจ้งเตือน", ("tisi",)), None)
    test("_has_cert มอก. จริง→tisi", product_store._has_cert("ปลั๊กมาตรฐานความปลอดภัย มอก. 2432-2555", ("tisi",)), "tisi")
    test("service center", warranty.detect_cert_question("service center อยู่ไหน"), ())
    test("price", warranty.detect_cert_question("price เท่าไหร่"), ())
    test("8gb ram", warranty.detect_cert_question("ram 8gb rom 128gb"), ())
    test("คำถามปกติ", warranty.detect_cert_question("ส่งของกี่วัน"), ())
    test("empty", warranty.detect_cert_question(""), ())

    print("=== 3. compat — detect_tisi_question เดิมยังทำงาน ===")
    test("tisi มอก.", warranty.detect_tisi_question("รุ่นไหนมี มอก. บ้าง"), True)
    test("tisi model", warranty.detect_tisi_question("AC65B2 มี มอก. ไหม"), True)
    test("tisi หมอก", warranty.detect_tisi_question("หมอกเย็นเกรดไมครอน"), False)
    test("tisi เสมอกัน", warranty.detect_tisi_question("เสมอกันที่ 0.8 มม."), False)

    print("=== 4. extract_tisi_model_keyword — ตัด cert kw ทั้งหมด ===")
    test("มอก. + รุ่น", warranty.extract_tisi_model_keyword("AC65B2 มี มอก. ไหม"), "AC65B2")
    test("CE + รุ่น", warranty.extract_tisi_model_keyword("A18T ผ่าน CE ไหม"), "A18T")
    test("ทั่วไป → ว่าง", warranty.extract_tisi_model_keyword("รุ่นไหนมี มอก. บ้าง"), "")
    test("ทุกรุ่น → ว่าง", warranty.extract_tisi_model_keyword("แบตสำรอง Cuktech. ทุกรุ่นมี มอก ไหม"), "")
    test("ทั้งหมด → ว่าง", warranty.extract_tisi_model_keyword("ของในร้านทั้งหมดผ่าน CE ไหม"), "")
    test("หมวดสินค้าไทย → ว่าง", warranty.extract_tisi_model_keyword("หาพาวแบง มีมอก มีไหม"), "")
    test("หมวด+เงื่อนไขไทย → ว่าง", warranty.extract_tisi_model_keyword("หาพาวเวอร์แบงค์ที่มี มอก มีไหมครับ รองรับมาตตราฐาน ccc ด้วยนะครับ"), "")
    test("รหัสรุ่นเลือกตัวมีเลข", warranty.extract_tisi_model_keyword("CUKTECH A18T ผ่าน CE ไหม"), "A18T")

    print("=== 5. search_cert_products — merge desc + image_texts ===")
    prod_docs = [
        {"item_id": 1, "item_name": "PlugA มอก.", "item_status": "NORMAL",
         "brand": {}, "shopname": "s1", "description": "ผ่าน มอก. 1234",
         "stock_info_v2": {"summary_info": {"total_available_stock": 5}}},
        {"item_id": 2, "item_name": "PowerBank B", "item_status": "NORMAL",
         "brand": {}, "shopname": "s1", "description": "powerbank ดี",
         "stock_info_v2": {"summary_info": {"total_available_stock": 3}}},
        {"item_id": 3, "item_name": "Cable C", "item_status": "DELETED",
         "brand": {}, "shopname": "s1", "description": "สายธรรมดา",
         "stock_info_v2": {"summary_info": {"total_available_stock": 0}}},
        {"item_id": 4, "item_name": "PowerConnex Surge Protection Module PCX-P",
         "item_status": "NORMAL", "brand": {}, "shopname": "s1",
         "description": "ป้องกันไฟกระชาก ผ่าน มอก. 9999",
         "stock_info_v2": {"summary_info": {"total_available_stock": 8}}},
    ]
    img_docs = [
        {"image_id": "img1", "text": "ผ่านมาตรฐาน CE และ มอก.", "item_ids": [2]},
        {"image_id": "img2", "text": "ผ่านมาตรฐาน CE", "item_ids": [3]},
    ]
    fake_db = _FakeDb({os.environ.get("MONGO_COLLECTION", "ShpProducts"): _FakeColl(prod_docs)})
    fake_admin = _FakeDb({"image_texts": _FakeColl(img_docs)})

    # คำถามทั่วไป (model_keyword=None) → กรองเฉพาะ NORMAL: item 3 (DELETED) ต้องหลุด
    res = product_store.search_cert_products(
        fake_db, ("ce",), shop_filter=None, model_keyword=None, admin_db=fake_admin)
    ids = sorted(r["item_id"] for r in res)
    test("ce: เจอ item 2 จาก image", ids, [2])

    res = product_store.search_cert_products(
        fake_db, ("tisi",), shop_filter=None, model_keyword=None, admin_db=fake_admin)
    by_id = {r["item_id"]: r for r in res}
    test("tisi: item1+2+4 (desc+image)", sorted(by_id), [1, 2, 4])
    test("tisi: item2 via=image", by_id.get(2, {}).get("via"), "image")
    test("tisi: item1 via=desc", by_id.get(1, {}).get("via"), "desc")

    # model_keyword → ไม่กรอง status (ตอบได้แม้ของหมด)
    res = product_store.search_cert_products(
        fake_db, ("ce",), model_keyword="Cable", admin_db=fake_admin)
    test("ce + model kw: เจอ item3 แม้ DELETED", [r["item_id"] for r in res], [3])

    # admin_db=None → degrade desc-only ไม่พัง
    res = product_store.search_cert_products(
        fake_db, ("tisi",), admin_db=None)
    test("admin_db=None → desc-only", sorted(r["item_id"] for r in res), [1, 4])

    print("=== 5b. type_filter — กรองหมวดสินค้า (KingGadgets case) ===")
    # "พาวแบง" (bare) ต้อง detect เป็น powerbank — เดิม kw ต้องมี ค์/ก์ ตามท้าย
    test("type detect พาวแบง bare", "powerbank" in product_store._detect_product_types("หาพาวแบง มีมอก มีไหม"), True)
    test("type detect พาวเวอร์แบงค์", product_store._detect_product_types("หาพาวเวอร์แบงค์ที่มี มอก มีไหมครับ รองรับมาตตราฐาน ccc ด้วยนะครับ"), {"powerbank"})
    # tisi + filter powerbank → เหลือแค่ item2 (PowerBank B) — item4 surge module หลุด
    res = product_store.search_cert_products(
        fake_db, ("tisi",), type_filter={"powerbank"}, admin_db=fake_admin)
    test("tisi+powerbank: เฉพาะ powerbank", sorted(r["item_id"] for r in res), [2])
    # ไม่มี filter → item4 (surge มี มอก.) ยังเจอ — กัน over-filter
    res = product_store.search_cert_products(
        fake_db, ("tisi",), type_filter=None, admin_db=fake_admin)
    test("tisi ไม่ filter: item4 ยังเจอ", 4 in [r["item_id"] for r in res], True)
    # filter หมวดที่ไม่มีของ → ว่าง (caller ใช้ fallback/handoff)
    res = product_store.search_cert_products(
        fake_db, ("tisi",), type_filter={"smartwatch"}, admin_db=fake_admin)
    test("tisi+smartwatch: ว่าง", res, [])
    # image path ก็กรองหมวด — item2 มาจาก image_texts → ยังเจอเมื่อ filter powerbank
    res = product_store.search_cert_products(
        fake_db, ("ce",), type_filter={"powerbank"}, admin_db=fake_admin)
    test("ce+powerbank: item2 via image ผ่าน filter", sorted(r["item_id"] for r in res), [2])

    print("=== 5c. variant cert tokens (_variant_cert_hit) ===")
    test("variant (CCC)", product_store._variant_cert_hit("QB817ฟ้า CN.V (CCC)", ("ccc",)), "ccc")
    test("variant (CE)", product_store._variant_cert_hit("P23 เทา GB.V (CE)", ("ce",)), "ce")
    test("variant GB.V→ce (Global)", product_store._variant_cert_hit("C200 ศูนย์ไทย GB.V", ("ce",)), "ce")
    test("variant GB.V ไม่ใช่ gb standard", product_store._variant_cert_hit("P23 เทา GB.V (CE)", ("gb",)), None)
    test("variant GB/T→gb จริง", product_store._variant_cert_hit("มาตรฐาน GB/T", ("gb",)), "gb")
    test("variant Global V.→ce", product_store._variant_cert_hit("Global V. ศูนย์ไทย", ("ce",)), "ce")
    test("variant CN.V→ccc (inferred)", product_store._variant_cert_hit("Pro (CN V.)", ("ccc",)), "ccc")
    test("variant EU.V→ce", product_store._variant_cert_hit("ปลั๊ก EU V.", ("ce",)), "ce")
    test("variant US.V→fcc", product_store._variant_cert_hit("Adapter US Ver.", ("fcc",)), "fcc")
    test("variant 128GB storage → None", product_store._variant_cert_hit("กล้อง + 128 GB", ("gb", "ce")), None)
    test("variant 32 GB → None", product_store._variant_cert_hit("กล้อง + 32 GB", ("gb", "ce")), None)
    test("variant ไม่มี token", product_store._variant_cert_hit("QB817 สีเขียว", ("ccc", "ce")), None)

    print("=== 5d. search_cert_products — stock + variant paths ===")
    prod_docs2 = prod_docs + [
        {"item_id": 5, "item_name": "QB817 PowerBank", "item_status": "NORMAL",
         "brand": {}, "shopname": "s1", "description": "แบตสำรอง",
         "tier_variation": [{"option_list": [{"option": "QB817ฟ้า CN.V (CCC)"},
                                             {"option": "QB817 สีเขียว"}]}],
         "stock_info_v2": {"summary_info": {"total_available_stock": 2}}},
        {"item_id": 6, "item_name": "Cam 128 GB", "item_status": "NORMAL",
         "brand": {}, "shopname": "s1", "description": "กล้อง",
         "tier_variation": [{"option_list": [{"option": "กล้อง + 128 GB"}]}],
         "stock_info_v2": {"summary_info": {"total_available_stock": 1}}},
        {"item_id": 7, "item_name": "Mi PB Pro", "item_status": "NORMAL",
         "brand": {}, "shopname": "s1", "description": "พาวเวอร์แบงค์",
         "stock_info_v2": {"summary_info": {"total_available_stock": 4}}},
        {"item_id": 8, "item_name": "APX GaN", "item_status": "NORMAL",
         "brand": {}, "shopname": "s1", "description": "หัวชาร์จ",
         "stock_info_v2": {"summary_info": {"total_available_stock": 2}}},
    ]
    fake_db2 = _FakeDb({os.environ.get("MONGO_COLLECTION", "ShpProducts"): _FakeColl(prod_docs2)})
    stock_docs = [
        {"product_id": "MI-PB", "is_tis": True, "tis_id": "2879-2560",
         "tis_license_id": "น 30516-48/2879",
         "shopee_ship_box": {"item_id": 7, "model_id": 111.0}},
        {"product_id": "APX", "is_tis": "False",   # negative — ห้ามนับ
         "shopee_ship_box": {"item_id": 8}},
        {"product_id": "PLUG-A", "is_tis": True,   # item1 — desc มี มอก. อยู่แล้ว → both
         "shopee_ship_box": {"item_id": 1}},
    ]
    fake_stock = _FakeDb({"Products": _FakeColl(stock_docs)})

    res = product_store.search_cert_products(
        fake_db2, ("tisi",), admin_db=fake_admin, stock_db=fake_stock)
    by_id = {r["item_id"]: r for r in res}
    test("stock: item7 via=stock", by_id.get(7, {}).get("via"), "stock")
    test("stock: cert_ids มีเลข มอก.", (by_id.get(7, {}).get("cert_ids") or {}).get("tis_id"), "2879-2560")
    test("stock: 'False' ไม่นับ (item8 ไม่มี)", 8 in by_id, False)
    test("stock+desc → item1 via=both", by_id.get(1, {}).get("via"), "both")

    res = product_store.search_cert_products(
        fake_db2, ("ccc",), admin_db=fake_admin, stock_db=fake_stock)
    by_id = {r["item_id"]: r for r in res}
    test("variant: item5 via=variant", by_id.get(5, {}).get("via"), "variant")
    test("variant: cert_context มีชื่อ option",
         "QB817ฟ้า CN.V (CCC)" in (by_id.get(5, {}).get("cert_context") or ""), True)
    test("variant: 128GB ไม่ FP (item6)", 6 in by_id, False)

    # stock_db=None → degrade เหมือนเดิม (real lazy connect หรือ None ก็ไม่พัง)
    res = product_store.search_cert_products(
        fake_db2, ("tisi",), admin_db=fake_admin, stock_db=None)
    test("stock_db=None → ไม่พัง", isinstance(res, list), True)

    print("=== 6. compat — search_tisi_products wrapper ===")
    res = product_store.search_tisi_products(fake_db, admin_db=fake_admin)
    test("wrapper เจอทั้ง desc+image", sorted(r["item_id"] for r in res), [1, 2, 4])
    test("wrapper มี tisi_context", bool(res and "tisi_context" in res[0]), True)

    print(f"\n=== ผลลัพธ์: {passed} ผ่าน / {failed} ไม่ผ่าน ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
