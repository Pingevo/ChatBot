#!/usr/bin/env python3
"""Test compat-mode aware filtering — bug: หูฟังถูก filter ลบทิ้งเมื่อมีชาร์จ ≥2 ตัว.

เคสจริง: "หูฟัง sony ใช้กับ iphone 15" → หูฟัง 50 ตัวที่ retrieval ดึงถูก
ถูก _filter_compat_products ลบเงียบๆ เพราะ ambiguous merge-back เฉพาะ compat<2
และชาร์จ usb-c ใน pool นับเป็น compat → คำตอบ "ไม่มีหูฟัง" ทั้งที่ร้านมี 54 ตัว

ทดสอบ:
1. _compat_mode mapping (intent/detect source + sets)
2. self_compat: ของที่ถาม (ambiguous connector) ต้องไม่ถูกลบ
3. self_compat: ของที่ type ตรง + connector ผิด ต้อง drop (หูฟัง lightning ให้ usb-c)
4. self_compat: ของ type อื่นไม่ถูก promote/ลบ — คงลำดับ
5. charging: พฤติกรรมเดิมเป๊ะ (ambiguous หายเมื่อ compat≥2) — regression
6. model_fit/phone: skip filter คืนทั้งหมด
"""
from __future__ import annotations
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "chatbot"))

from shopeechat.device_compat import _compat_mode, _filter_compat_products

PASS = FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}  {detail}")


def _names(products: list[dict]) -> list[str]:
    return [p["name"] for p in products]


EAR_BUDS = {"name": "Xiaomi Buds 3 หูฟังไร้สาย แบต 32 ชม."}
EAR_BT = {"name": "QCY T12 หูฟังบลูทูธไร้สาย"}
EAR_LIGHTNING = {"name": "หูฟังมีสาย Lightning connector MFi"}
CHG_90 = {"name": "CUKTECH AD653 หัวชาร์จ 90W USB-C GaN"}
CHG_240 = {"name": "CUKTECH CTC615W สายชาร์จ C to C 240W"}
CASE_IP15 = {"name": "เคส iPhone 15 ซิลิโคนกันกระแทก"}

# ── 1. _compat_mode mapping ──
print("== _compat_mode ==")
MODE_CASES = [
    # (intent_ptype, message, expected_mode)
    ("earphone", "หูฟัง sony ใช้กับ iphone 15", "self_compat"),
    ("case", "เคส iphone 15", "model_fit"),
    ("charger", "สายชาร์จใช้กับ iphone 15", "charging"),
    ("powerbank", "powerbank ใช้กับ mi 17", "charging"),
    ("wireless_charger", "แท่นชาร์จไร้สาย iphone", "charging"),
    ("screen_protector", "ฟิล์ม iphone 15", "model_fit"),
    ("battery", "แบตเตอรี่ iphone 15", "model_fit"),
    ("stylus", "ปากกาใช้กับ ipad", "model_fit"),
    ("phone", "iphone 15 มีขายไหม", "skip"),
    ("smartwatch", "นาฬิกาใช้กับ iphone", "self_compat"),
    ("speaker", "ลำโพงใช้กับ iphone", "self_compat"),
    ("other", "เครื่องดูดฝุ่นใช้กับ iphone", "self_compat"),   # other → detect vacuum
    (None, "หูฟังใช้กับ iphone", "self_compat"),              # intent null → detect
    ("other", "ใช้กับ iphone 15 ได้ไหม", "unknown"),          # ไม่มี type → unknown
    ("earphone", "ใช้กับ iphone 15 ไหม", "self_compat"),      # detect ว่าง → ใช้ intent
]
for ptype, msg, want in MODE_CASES:
    mode, atype = _compat_mode(ptype, msg)
    check(f"mode({ptype!r},{msg[:24]!r})={want}", mode == want, f"got={mode}/{atype}")

# multi-type detect → priority charging > model_fit > self_compat
mode, _ = _compat_mode(None, "เคส iphone ที่ชาร์จไร้สายได้")
check("multi-detect case+wireless → charging", mode == "charging", f"got={mode}")

# ── 2. self_compat: ของที่ถามต้องไม่ถูกลบ (THE BUG) ──
print("== self_compat filter ==")
pool = [EAR_BUDS, EAR_BT, CHG_90, CHG_240]
out = _filter_compat_products(pool, "iphone 15", "",
                              compat_mode="self_compat", asked_type="earphone")
got = _names(out)
check("หูฟัง BT 2 ตัวต้องยังอยู่", EAR_BUDS["name"] in got and EAR_BT["name"] in got,
      f"got={got}")
check("ชาร์จ usb-c คงอยู่ (ไม่ลบ ไม่ promote)", CHG_90["name"] in got and CHG_240["name"] in got)
check("ลำดับเดิมคงไว้ (หูฟังอยู่ก่อนชาร์จ)", got[:2] == [EAR_BUDS["name"], EAR_BT["name"]],
      f"order={got}")

# ── 3. self_compat: asked-type connector ผิด → drop ──
pool2 = [EAR_BUDS, EAR_LIGHTNING, CHG_90]
out2 = _filter_compat_products(pool2, "iphone 15", "",
                               compat_mode="self_compat", asked_type="earphone")
got2 = _names(out2)
check("หูฟัง lightning drop ให้ usb-c phone", EAR_LIGHTNING["name"] not in got2, f"got={got2}")
check("หูฟัง BT ยังอยู่", EAR_BUDS["name"] in got2)

# ── 4. self_compat ไม่มี asked_type → คืนเดิม (safe fallback) ──
out3 = _filter_compat_products(pool, "iphone 15", "",
                               compat_mode="self_compat", asked_type=None)
check("self_compat ไม่มี asked_type → คืนเดิม (ไม่ลบหูฟัง)",
      EAR_BUDS["name"] in _names(out3))

# ── 5. charging: พฤติกรรมเดิมเป๊ะ (regression) ──
print("== charging regression ==")
out4 = _filter_compat_products(pool, "iphone 15", "",
                               compat_mode="charging", asked_type="charger")
got4 = _names(out4)
check("charging: compat≥2 → ambiguous หูฟังถูกลบ (เจตนาเดิม)",
      EAR_BUDS["name"] not in got4 and len(got4) == 2, f"got={got4}")
# backward compat: ไม่ส่ง mode เลย → เหมือน charging
out5 = _filter_compat_products(pool, "iphone 15", "")
check("default mode (ไม่ส่ง) = charging", _names(out5) == got4)

# ── 6. model_fit / phone → skip ──
print("== model_fit/phone skip ==")
pool3 = [CASE_IP15, EAR_BUDS, CHG_90]
out6 = _filter_compat_products(pool3, "iphone 15", "",
                               compat_mode="model_fit", asked_type="case")
check("model_fit → คืนทั้งหมด (connector ไม่เกี่ยว)", len(out6) == 3)
out7 = _filter_compat_products(pool3, "iphone 15", "",
                               compat_mode="skip", asked_type="phone")
check("phone → คืนทั้งหมด", len(out7) == 3)

# ── 7. self_compat: device spec resolve ไม่ได้ → คืนทั้งหมด ──
out8 = _filter_compat_products(pool, "devicexyz123", "",
                               compat_mode="self_compat", asked_type="earphone")
check("device unknown → คืนทั้งหมด", len(out8) == len(pool))

# ── 7b. _charging_scope — BUG-A: scope re-query ตาม type ที่ถามจริง ──
# web extractor เดา "charger" ทับ type อื่น → re-query ดึงผิดหมวด
# scope = detect(msg) ∩ _CHARGING_TYPES; 'charger' drop เมื่อมี form เจาะจงกว่า
print("== _charging_scope (BUG-A) ==")
from shopeechat.device_compat import _charging_scope

SCOPE_CASES = [
    # (message, asked_type, expected)
    ("พาวเวอร์แบงค์ชาร์จ MacBook ได้ไหม", "powerbank", {"powerbank"}),
    ("สายชาร์จใช้กับ iphone 15 ไหม", "charger", {"charger"}),
    ("หัวชาร์จในรถใช้กับ samsung s25 ultra ไหม", "car_charger", {"car_charger"}),
    ("แท่นชาร์จไร้สายใช้กับ iphone 16 ไหม", "wireless_charger", {"wireless_charger"}),
    ("ชุดชาร์จและพาวเวอร์แบงค์ใช้กับ iphone ไหม", "charger", {"charger", "powerbank"}),
    ("อันนี้ใช้กับ iphone ไหม", "powerbank", {"powerbank"}),     # anchor fallback
    ("อันนี้ใช้กับ iphone ไหม", None, None),                     # ไม่มี type → ไม่ scope
    ("หูฟังใช้กับ iphone ไหม", "earphone", None),                # non-charging → None
]
for _m, _at, _want in SCOPE_CASES:
    _got = _charging_scope(_m, _at)
    check(f"scope({_m[:26]!r},{_at})={_want}", _got == _want, f"got={_got}")

# ── 8. _device_spec_lookup integration (real DB — KingGadgets) ──
# ตรวจ: non-charging re-query ดึงของถูกหมวด + prompt ไม่มี wattage
# + ไม่เรียก web search เลย (monkeypatch ให้ raise ถ้าถูกเรียก)
print("== device_spec_lookup integration (DB) ==")
import os
from types import SimpleNamespace
from shopeechat import knowledge_base, product_store
knowledge_base._load_env()
import shopeechat.web_search as _wsmod
from shopeechat.device_compat import _device_spec_lookup


def _no_web(**_kw):
    raise RuntimeError("web search ถูกเรียกใน non-charging mode")


_orig_se = _wsmod.search_and_extract
_wsmod.search_and_extract = _no_web
try:
    _client = product_store.get_client()
    _db = _client[os.environ.get("MONGO_DB", "")]

    _req = SimpleNamespace(message="หูฟัง sony ใช้กับ iphone 15 ไหมครับ",
                           shop="KingGadgets", platform="shopee")
    _intent = {"target_device": "iphone 15", "product_type": "earphone"}
    _extra, _add, _ds = _device_spec_lookup(
        _db, _req, _intent, None, [], "หูฟัง", None, None, 50)
    _add_names = [p.get("name") or p.get("item_name") or "" for p in _add]
    _ear_hit = any(("หูฟัง" in n or "buds" in n.lower() or "earphone" in n.lower()
                    or "tws" in n.lower() or "airpods" in n.lower())
                   for n in _add_names)
    check("self_compat re-query ดึงหูฟังจริง (KG)", _ear_hit,
          f"add={len(_add)} top={_add_names[:3]}")
    check("prompt ไม่มี wattage/charger directive",
          all(s not in _extra for s in ("27W", "dual-tier", "ชาร์จเร็ว", "wattage ที่")),
          f"extra={_extra[:100]!r}")
    check("prompt มี self_compat line", "ใช้ร่วมกับ iphone 15" in _extra)

    _req2 = SimpleNamespace(message="เคส iphone 15 มีไหม", shop="KingGadgets",
                            platform="shopee")
    _intent2 = {"target_device": "iphone 15", "product_type": "case"}
    _extra2, _add2, _ds2 = _device_spec_lookup(
        _db, _req2, _intent2, None, [], "เคส", None, None, 50)
    check("model_fit: prompt บอกรองรับรุ่น ไม่พูด wattage",
          "รองรับรุ่น iphone 15" in _extra2 and "wattage" in _extra2,
          f"extra={_extra2[:80]!r}")
    _case_hit = any("เคส" in (p.get("name") or p.get("item_name") or "")
                    for p in _add2)
    check("model_fit re-query 'case iphone 15' → เคสจริง หรือ capability line",
          _case_hit or "ร้านนี้" in _extra2,
          f"add={len(_add2)}")

    _req3 = SimpleNamespace(message="iphone 15 มีขายไหม", shop="KingGadgets",
                            platform="shopee")
    _intent3 = {"target_device": "iphone 15", "product_type": "phone"}
    _extra3, _add3, _ds3 = _device_spec_lookup(
        _db, _req3, _intent3, None, [], "iphone 15", None, None, 50)
    check("phone → skip (ไม่ search ไม่ re-query)",
          _extra3 == "" and _add3 == [])

    # BUG-A: charging re-query ต้อง scope ตาม type ที่ถาม (CukTechThailand มี powerbank จริง)
    _pb = product_store.fetch_products(
        _db, message="charger MacBook Air MagSafe 3 USB-C 70W",
        shop_filter="CukTechThailand", limit=10,
        product_types_override={"powerbank"})
    _pb_names = [p.get("name") or p.get("item_name") or "" for p in _pb or []]
    check("override={powerbank} → ดึงแบตสำรองจริง (CukTech untyped shop)",
          _pb and any("แบตสำรอง" in n or "powerbank" in n.lower() or "power bank" in n.lower()
                      for n in _pb_names), f"got={_pb_names[:3]}")

    # capability line: ถามหมวดที่ร้านไม่มี → ต้องบอกหมวดจริง ไม่ให้เดา
    _counts = product_store._shop_type_counts(_db, "KingGadgets")
    check("shop_type_counts(KG) มี earphone", _counts.get("earphone", 0) > 0,
          f"counts={dict(list(_counts.items())[:5])}")
    _missing = next((t for t in ("projector", "vacuum", "speaker", "fan", "drone")
                     if t not in _counts), None)
    if _missing:
        _cap = product_store.shop_capability_line(
            _db, "KingGadgets", _missing, have_types=set())
        check(f"capability line สำหรับหมวดที่ไม่มี ({_missing})",
              "ไม่มีสินค้าหมวด" in _cap and "หมวดที่ร้านมีจริง" in _cap)
        _cap2 = product_store.shop_capability_line(
            _db, "KingGadgets", "earphone", have_types={"earphone"})
        check("capability line ไม่ inject เมื่อของอยู่ใน context", _cap2 == "")
    else:
        check("capability: หาหมวดที่ KG ไม่มีไม่ได้ (skip)", True)
finally:
    _wsmod.search_and_extract = _orig_se

# ── 9. structured device_specs จาก web search (P2) ──
# root fix: prose regex max() ดูดเลขอุปกรณ์เสริม (สาย 240W) มาเป็น device spec
# → LLM extraction ส่ง spec เป็น list ตรงๆ; resolver ใช้ structured ก่อน regex
print("== structured device_specs (P2) ==")
from shopeechat.device_compat import (_resolve_device_spec, _web_spec_to_dict,
                                      _lookup_spec_db)

# 9a. web_search._clean_device_specs — tolerant normalize
_c = _wsmod._clean_device_specs([
    {"device": "MacBook Pro 16", "connector": "USB-C", "max_watt": "140W",
     "protocols": ["USB PD", "PPS"]},
    {"device": "MacBook Air", "connector": "usb-c", "max_watt": 70},
    "not-a-dict", {"max_watt": "fast"}, None, {"device": "onlyname"},
])
check("clean: normalize lower + '140W'→140.0 + protocols",
      _c[0] == {"device": "macbook pro 16", "connector": "usb-c",
                "max_watt": 140.0, "protocols": ["usb pd", "pps"]},
      f"got={_c[:1]}")
check("clean: int→float", _c[1]["max_watt"] == 70.0)
check("clean: entry ไม่มี field ใช้ได้ → ตัดทิ้ง", len(_c) == 2, f"got={_c}")
check("clean: ไม่ใช่ list → []",
      _wsmod._clean_device_specs("junk") == []
      and _wsmod._clean_device_specs(None) == [])

# 9b. structured ชนะ prose regex — เคสจริง: 240W ของสายชาร์จหลุดเป็น device spec
_extra_240 = "สายชาร์จรองรับ 240W; ไม่มีข้อมูลกำลังชาร์จของเครื่องชัดเจน"
_specs_33 = [{"device": "somephone zq9", "connector": "usb-c", "max_watt": 33.0,
              "protocols": ["usb pd"]}]
_r = _resolve_device_spec("somephone zq9", _extra_240, web_specs=_specs_33)
check("structured ชนะ prose: min_watt=33 ไม่ใช่ 240",
      _r and _r.get("min_watt") == 33.0, f"got={_r}")
check("structured connector=usb-c", _r and _r.get("connector") == "usb-c")

# 9c. spec-db ชนะ structured (curated > extracted)
_r2 = _resolve_device_spec(
    "iphone 15", "",
    web_specs=[{"device": "iphone 15", "connector": "lightning", "max_watt": 999.0}])
check("spec-db ชนะ structured (iphone15 → spec-db ไม่ใช่ 999W/lightning)",
      _r2 and _r2.get("min_watt") != 999.0 and _r2.get("connector") != "lightning",
      f"got={_r2}")

# 9d. multi-variant → min_watt = max (spec ceiling ครอบทุกรุ่นย่อย)
_r3 = _resolve_device_spec(
    "laptopxyz", "",
    web_specs=[{"device": "laptopxyz air", "connector": "usb-c", "max_watt": 70.0},
               {"device": "laptopxyz pro", "connector": "usb-c", "max_watt": 140.0}])
check("multi-variant → min_watt=max(70,140)=140",
      _r3 and _r3.get("min_watt") == 140.0, f"got={_r3}")

# 9e. malformed/empty → prose fallback = connector เท่านั้น
#     (P3: prose watt parse ถูกฆ่า — เลขลอยไม่ trusted, min_watt=None)
_r4 = _resolve_device_spec(
    "unknownphone q7", "เครื่องรองรับ 45W usb-c",
    web_specs=[{"max_watt": "junk"}, "bad", {}])
check("entries เสียหมด → prose ให้ connector เท่านั้น",
      _r4 and _r4.get("connector") == "usb-c" and _r4.get("min_watt") is None,
      f"got={_r4}")
_r5 = _resolve_device_spec(
    "unknownphone q7", "เครื่องรองรับ 45W usb-c", web_specs=[])
check("web_specs=[] → เหมือนกัน", _r5 and _r5.get("connector") == "usb-c"
      and _r5.get("min_watt") is None)

# 9f. _web_spec_to_dict — entry match เฉพาะที่ตรง ("macbook air" ≠ "macbook pro")
_d = _web_spec_to_dict(
    [{"device": "macbook air", "connector": "usb-c", "max_watt": 70.0},
     {"device": "macbook pro", "connector": "usb-c", "max_watt": 140.0}],
    "macbook air")
check("entry match: 'macbook air' → 70 ไม่ใช่ 140",
      _d and _d.get("min_watt") == 70.0, f"got={_d}")
_d2 = _web_spec_to_dict(
    [{"device": "macbook air", "connector": "usb-c", "max_watt": 70.0},
     {"device": "macbook pro", "connector": "usb-c", "max_watt": 140.0}],
    "macbook")
check("generic 'macbook' match ทั้งคู่ → max=140",
      _d2 and _d2.get("min_watt") == 140.0, f"got={_d2}")
check("ไม่มี usable field → None",
      _web_spec_to_dict([{"device": "x"}], "x") is None
      and _web_spec_to_dict(None, "x") is None)

# 9g. _filter_compat_products รับ web_specs — connector resolve จาก structured
_out9 = _filter_compat_products(
    [CHG_90, CHG_240, EAR_BUDS], "somephone zq9", "",
    web_specs=[{"device": "somephone zq9", "connector": "usb-c", "max_watt": 30.0}],
    compat_mode="charging", asked_type="charger")
check("filter ใช้ structured connector=usb-c → ชาร์จผ่าน หูฟัง drop",
      CHG_90["name"] in _names(_out9) and EAR_BUDS["name"] not in _names(_out9),
      f"got={_names(_out9)}")

# ── 10. spec source ladder — web = ด่านสุดท้าย (P3) ──
# spec-db → catalog evidence → web (จ่าย เฉพาะชั้นบนพลาด) → intent
# + ฆ่า prose watt parse (เลขลอยใน prose ไม่ trusted)
print("== spec ladder (P3) ==")
from shopeechat.device_compat import _device_mentioned

# 10a. _device_mentioned helper
_p10 = [{"name": "CUKTECH PB200P แบตสำรอง 150W สำหรับ MacBook Pro"},
        {"name": "สายชาร์จ C to C 240W"}]
check("device_mentioned: hit เมื่อชื่อสินค้าระบุ device",
      _device_mentioned("macbook", _p10))
check("device_mentioned: miss เมื่อไม่มี",
      not _device_mentioned("galaxy s25", _p10))
check("device_mentioned: สั้นเกิน/ว่าง → False",
      not _device_mentioned("mi", _p10) and not _device_mentioned("", _p10))

# 10b. prose เหลือ connector เท่านั้น — เลขลอยไม่กลายเป็น spec
_r10 = _resolve_device_spec("unknownphone q7", "เครื่องรองรับ 45W usb-c สาย 240W")
check("prose → connector เท่านั้น min_watt=None (ฆ่า watt parse)",
      _r10 and _r10.get("connector") == "usb-c" and _r10.get("min_watt") is None,
      f"got={_r10}")

# 10c-f. integration — monkeypatch web ให้นับ call
_ws_calls: list = []


def _fake_web(**kw):
    _ws_calls.append(kw)
    return {"search_info": "fake device info ยาวพอให้ extra มีเนื้อ",
            "keywords": [], "product_type": "charger", "device_specs": [],
            "error": None, "search_used": True, "usage": {},
            "cost_usd": 0.0, "model": "m", "elapsed": 0.0}


_orig_cfg = _wsmod.is_configured
_wsmod.search_and_extract = _fake_web
_wsmod.is_configured = lambda: True
try:
    # 10c. spec-db hit → web ไม่ถูกเรียก (iphone 15 อยู่ใน db)
    _req_c = SimpleNamespace(message="สายชาร์จใช้กับ iphone 15 ไหม",
                             shop="KingGadgets", platform="shopee")
    _int_c = {"target_device": "iphone 15", "product_type": "charger",
              "device_connector": "usb-c", "device_min_watt": 27}
    _ex_c, _ad_c, _ds_c = _device_spec_lookup(
        _db, _req_c, _int_c, None, [], "สายชาร์จ", None, None, 50)
    check("spec-db hit → web ไม่ถูกเรียก", not _ws_calls,
          f"calls={len(_ws_calls)}")
    check("spec-db extra มี spec line", "สเปค" in _ex_c,
          f"extra={_ex_c[:100]!r}")
    check("re-query เติม pool โดยไม่ต้อง web keywords", len(_ad_c) > 0,
          f"add={len(_ad_c)}")

    # 10d. catalog evidence → web ไม่ถูกเรียก
    # (galaxy note 30 — รุ่นสมมติ ไม่อยู่ spec-db แต่ product ระบุชื่อตรง)
    _ws_calls.clear()
    _req_i = SimpleNamespace(message="สายชาร์จใช้กับ galaxy note 30 ไหม",
                             shop="KingGadgets", platform="shopee")
    _int_i = {"target_device": "galaxy note 30", "product_type": "charger"}
    _exist_i = [{"name": "ZTEC สายชาร์จ Type C 240W สำหรับ Galaxy Note 30",
                 "item_id": "x-cat-ev"}]
    _ex_i, _ad_i, _ds_i = _device_spec_lookup(
        _db, _req_i, _int_i, None, _exist_i, "สายชาร์จ", None, None, 50)
    check("catalog hit (สินค้าระบุ galaxy note 30 ตรง) → ไม่ web",
          not _ws_calls,
          f"calls={len(_ws_calls)} add={len(_ad_i)}")
    check("catalog evidence note อยู่ใน extra",
          "หลักฐานจาก catalog" in _ex_i, f"extra={_ex_i[:120]!r}")

    # 10e. ทุกชั้นพลาด → web ถูกเรียก
    _ws_calls.clear()
    _req_u = SimpleNamespace(message="ชาร์จ devicexyz123 ได้ไหม",
                             shop="KingGadgets", platform="shopee")
    _int_u = {"target_device": "devicexyz123", "product_type": "charger"}
    _ex_u, _ad_u, _ds_u = _device_spec_lookup(
        _db, _req_u, _int_u, None, [], "ชาร์จ", None, None, 50)
    check("ทุกชั้นพลาด → web ถูกเรียก", len(_ws_calls) == 1,
          f"calls={len(_ws_calls)}")

    # 10f. intent เดา connector อย่างเดียว (ไม่ grounded) → web ยังถูกเรียก
    _ws_calls.clear()
    _int_iu = {"target_device": "devicexyz123", "product_type": "charger",
               "device_connector": "usb-c"}
    _ex_iu, _ad_iu, _ds_iu = _device_spec_lookup(
        _db, _req_u, _int_iu, None, [], "ชาร์จ", None, None, 50)
    check("intent-only → web ยังถูกเรียก (guess ไม่ใช่หลักฐาน)",
          len(_ws_calls) == 1, f"calls={len(_ws_calls)}")
finally:
    _wsmod.search_and_extract = _orig_se
    _wsmod.is_configured = _orig_cfg

# ═══════════ 11. spec-db coverage ย้อนหลัง ~10 ปี (data — lookup เดิม) ═══════════
def _sp(d):
    return (_lookup_spec_db(d) or {}).get("device")

print("\n── 11a. มือถือเก่า (2016-2019) — canonical + alias")
for _d, _want in [("galaxy note 8", "galaxy note 8"), ("note8", "galaxy note 8"),
                  ("galaxy s9", "galaxy s9"), ("s9 plus", "galaxy s9 plus"),
                  ("s7 edge", "galaxy s7 edge"),
                  ("j7 prime", "galaxy j7"), ("a50", "galaxy a50"),
                  ("iphone 6s plus", "iphone 6s plus"), ("mi 8", "xiaomi 8"),
                  ("redmi note 8 pro", "redmi note 8 pro"), ("poco f3", "poco f3"),
                  ("reno 6 pro", "oppo reno 6"), ("oppo f11", "oppo f11 pro"),
                  ("v23 pro", "vivo v23"), ("p30 pro", "huawei p30 pro"),
                  ("mate 20 pro", "huawei mate 20 pro"),
                  ("one plus 7 pro", "oneplus 7 pro"), ("7t", "oneplus 7t"),
                  ("pixel 3a", "pixel 3a"), ("google pixel 4", "pixel 4")]:
    check(f"old phone '{_d}' → {_want}", _sp(_d) == _want, f"got {_sp(_d)}")

print("\n── 11b. connector ยุค micro-usb / lightning ต้องไม่โดนโยงเป็น usb-c")
for _d, _conn in [("galaxy s7", "micro-usb"), ("j5 pro", "micro-usb"),
                  ("redmi 9a", "micro-usb"), ("oppo f11", "micro-usb"),
                  ("vivo y16", "micro-usb"), ("huawei y9", "micro-usb"),
                  ("airpods 3", "lightning"), ("ipad mini 5", "lightning"),
                  ("iphone 6 plus", "lightning"),
                  ("galaxy s9", "usb-c"), ("mi 8", "usb-c")]:
    _r = _lookup_spec_db(_d) or {}
    check(f"'{_d}' connector={_conn}", _r.get("connector") == _conn,
          f"got {_r.get('connector')}")

print("\n── 11c. หูฟัง/แท็บเล็ต/ล็อปท็อป/แก็ดเจ็ต")
for _d, _want in [("airpods 4 anc", "airpods 4 anc"), ("buds2 pro", "galaxy buds 2 pro"),
                  ("wf-1000xm5", "sony wf-1000xm5"), ("wh1000xm4", "sony wh-1000xm4"),
                  ("freebuds 5i", "huawei freebuds 5i"),
                  ("jbl tune 230", "jbl tune 230nc"), ("qc earbuds ii", "bose qc earbuds ii"),
                  ("buds air", "realme buds air 5"), ("enco air3", "oppo enco air3"),
                  ("matepad", "huawei matepad 11"), ("tab m10", "lenovo tab m10"),
                  ("pad se", "redmi pad se"), ("oppo pad air", "oppo pad air"),
                  ("xps 15", "dell xps 15"), ("dell inspiron", "dell inspiron"),
                  ("thinkpad x1", "lenovo thinkpad"), ("yoga slim", "lenovo yoga"),
                  ("vivobook 15", "asus vivobook"), ("zenbook 14", "asus zenbook"),
                  ("nitro 5", "acer nitro"), ("surface pro 9", "surface pro"),
                  ("notebook", "notebook"), ("โน้ตบุ๊ค", "notebook"),
                  ("watch gt 4", "huawei watch gt"), ("amazfit", "amazfit gtr"),
                  ("gopro hero 12", "gopro hero"), ("kindle", "kindle paperwhite"),
                  ("switch lite", "nintendo switch lite"), ("jbl flip", "jbl flip 6")]:
    check(f"'{_d}' → {_want}", _sp(_d) == _want, f"got {_sp(_d)}")

print("\n── 11d. shared template — entry ที่ใช้ spec ชุดเดียวต้องได้ spec เดียวกัน")
_gn8 = _lookup_spec_db("galaxy note 8"); _gn9 = _lookup_spec_db("galaxy note 9")
check("note8/note9 spec เท่ากัน (template _T_SAM15_QI10)",
      _gn8["connector"] == _gn9["connector"] == "usb-c"
      and _gn8["min_watt"] == _gn9["min_watt"] == 15,
      f"note8={_gn8.get('min_watt')} note9={_gn9.get('min_watt')}")
_r4a = _lookup_spec_db("pixel 4a"); _r5a = _lookup_spec_db("pixel 5a")
check("pixel 4a/5a spec เท่ากัน (template _T_UC18)",
      _r4a["connector"] == _r5a["connector"] == "usb-c"
      and _r4a["min_watt"] == _r5a["min_watt"] == 18, f"{_r4a.get('min_watt')}")

print("\n── 11e. brand guard — alias ข้ามแบรนด์ต้องไม่ชน")
for _d, _none in [("oppo a73", None), ("realme a54", None),
                  ("xiaomi x9", None), ("vivo note 8", None),
                  ("samsung buds air", None)]:
    check(f"'{_d}' → None (แบรนด์ผิด ต้องไม่ hit)", _sp(_d) is None,
          f"got {_sp(_d)}")
_r = _lookup_spec_db("samsung a73")
check("'samsung a73' → galaxy a73 (แบรนด์ถูก)", (_r or {}).get("device") == "galaxy a73")

print("\n── 11f. คำศัพท์ลอย/generic + unknown ยัง fallback")
check("bare 'iphone' → iphone (generic entry)", _sp("iphone") == "iphone")
check("bare 'ipad' → ipad (generic entry)", _sp("ipad") == "ipad")
check("bare 'macbook' → macbook (เดิม)", _sp("macbook") == "macbook")
check("unknown 'devicexyz999' → None", _sp("devicexyz999") is None)

print("\n── 11g. outer web-search gate — grounded device ไม่จ่าย search ซ้ำ")
import shopeechat.web_search as _wsm
_should, _reason = _wsm.should_use_web_search(
    answer="ใช้ได้ค่ะ", products=[{"name": "x"}],
    intent_result={"intent": "compatibility_check",
                   "target_device": "redmi note 9", "confidence": 0.9},
    message="สายชาร์จใช้กับ redmi note 9 ได้ไหม")
check("grounded device + คำตอบสั้น → ไม่ search", _should is False,
      f"reason={_reason}")
_should, _reason = _wsm.should_use_web_search(
    answer="ได้ครับยาวพอไม่ให้สั้นเกินไปเลยครับผมมมมมมมมมมมมมมมมมมมมมมมมมมมม",
    products=[{"name": "x"}],
    intent_result={"intent": "compatibility_check",
                   "target_device": "devicexyz99", "confidence": 0.9},
    message="สายชาร์จใช้กับ redmi zzz99 ได้ไหม")
check("device ไม่อยู่ db + มีเลขรุ่น → search ปกติ", _should is True,
      f"reason={_reason}")

print(f"\n{PASS}/{PASS+FAIL} passed")
sys.exit(0 if FAIL == 0 else 1)
