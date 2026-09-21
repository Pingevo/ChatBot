# Cert Merge Plan — รวมแหล่งข้อมูล มอก./CE/CCC/GB ทั้ง 4 แหล่ง

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans หรือ subagent-driven-development — implement ทีละ task, steps ใช้ checkbox (`- [ ]`)

**Goal:** บอทตอบคำถาม cert (มอก./CE/CCC/FCC/RoHS/GB) ได้ครบและแม่นขึ้น โดย merge 4 แหล่งข้อมูล: stock DB (structured flags + เลข มอก./ใบอนุญาต), variant names, description text, image OCR — เพิ่ม coverage ~173 items ที่เดิมหาไม่เจอ + ตอบเลข มอก. จริงได้

**Architecture:** runtime merge ใน `search_cert_products` (เพิ่ม path 3=stock DB, path 4=variant names) — ไม่มี build pipeline ใหม่, stock data สดเสมอ, degrade ปลอดภัยถ้า DB ล่ม

**Tech Stack:** Python 3.11+, pymongo, regex — ไม่มี dependency ใหม่

**Verify (ทำแล้ว 2026-09-18):**
- `itStock.Products` (~8,801 docs): `is_tis`=491, `tis_id`=265, `tis_license_id`=263, `is_ccc`=58, `is_ce`=40 — field sparse, ค่า `True` bool / `'False'` string (8 docs = negative evidence ชัดเจน)
- join key: `shopee_ship_box.{item_id,model_id,shopname}` — 4,988 docs มี; item join ได้ 410/415; **model_id join `sellable_units` ได้ 411/416 (99%)**
- stock เพิ่ม coverage ใหม่ 173 items (เทียบ desc+OCR เดิม); desc มี 1,674 items ที่ stock ไม่มี → union จำเป็น
- variant tokens ใน `tier_variation.option_list[].option`: 616 items (`(CCC)`=117, `(CE)`=89, `CN.V`=145, `GB.V`=?) — `GB` ต้องการ `V` ตามหลังกัน FP "128 GB"
- limitation: `shopee_ship_box` เก็บได้ 1 listing/SKU — SKU เดียวกันขายหลาย listing จะ join ได้แค่ตัวเดียว → variant-name path ชดเชยจุดนี้
- `model_id`/`item_id` ใน stock เป็น float บาง doc → `int()` ทั้งสองฝั่ง

---

## Design decisions

### 1. Merge model: union of positive evidence (ไม่มี conflict resolution)

- ทุกแหล่งเป็น **positive evidence เท่านั้น** — ไม่มีแหล่งไหนบอก "ไม่มี" ได้นอกจาก `'False'` string ใน stock (phase 2)
- conflict ไม่มีทางเกิดจริง: stock ว่ามี + desc ไม่พูดถึง → ถือว่ามี (staff-curated น่าเชื่อสุด)
- `via` เก็บ provenance: `"desc"|"image"|"stock"|"variant"|"both"` (both = >1 แหล่ง)

### 2. Variant token mapping

| token ในชื่อตัวเลือก | → cert | เหตุ |
|---|---|---|
| `(CCC)` `CCC` | ccc | explicit |
| `(CE)` `CE` | ce | explicit |
| `มอก`/`TISI` | tisi | explicit |
| `CN.V` `CN V.` | ccc | **China version** — CCC บังคับขายในจีนสำหรับหมวดที่ร้านขาย (inference — hedge ใน cert_context) |
| `GB.V` `GB Ver.` `Global V.` | ce | **GloBal version** (ไม่ใช่ GB standard! — verify: item 4842405819 ชื่อ `(GB Ver.)`, P23 คู่ `GB.V (CE)`/`CN.V (CCC)`) — global version มี CE เสมอ (inference — hedge เหมือนกัน) |
| `EU.V` `EU` | ce | European version → CE |
| `US.V` `US Ver.` | fcc | US version → FCC |
| `GB/T` `GB` (ไม่มี V ตาม) | gb | GB standard จริง — **GB.V ต้องไม่ match** (ใส่ negative lookahead) |

- `CN.V`/`GB.V`/`US.V`/`EU` เป็น version→cert **inference** ทั้งหมด — `cert_context` ต้องโชว์ชื่อ option จริง (เช่น `ตัวเลือก: QB817ฟ้า CN.V (CCC)`) ให้เห็นที่มา
- `GB` ต้องมี `V` ตามหลังในเคส version — กัน FP `128 GB`/`32 GB` (storage)
- user อนุมัติ CN.V→ccc โดยตรง (ไม่ gate type_filter) + ขอ post-check ว่า token กระจายหมวดไหนบ้าง

### 3. Stock flag mapping (field → cert)

```
tis_id หรือ is_tis=True  → tisi   (+ cert_ids: tis_id, tis_license_id)
is_ccc=True              → ccc
is_ce=True               → ce
is_tis='False'           → negative evidence (phase 2 — phase 1 ข้าม)
```

### 4. คำตอบต้อง honest กับ absence

หลักเดิม: "ไม่พบข้อมูล" ≠ "ไม่มี" — รักษาไว้ทุก path (handoff text เดิมถูกอยู่แล้ว)

---

## ทางเลือกการใช้งาน (ตัดสินใจแล้ว: A)

| | A. runtime merge ใน search_cert_products | B. build-time `cert_map` collection | C. embed certs ใน sellable_units |
|---|---|---|---|
| freshness | สดเสมอ (stock query ตรง) | stale จน rebuild | stale จน rebuild |
| งานเพิ่ม | ~180 บรรทัด product_store | +script +collection +cron | +build_sellable_units join |
| runtime dep | +STOCK_URI (degrade ได้) | ไม่มี | ไม่มี |
| variant-level | ได้ (result มี context) | ได้ | ได้ |
| audit/debug | query log | snapshot ดูได้ | ใน index |
| card attach ภายหลัง | helper เดียวกันใช้ซ้ำ | lookup เดียว | ฟรีใน unit card |
| **เลือก** | ✅ **phase 1** | เก็บเป็นทางเลือกถ้าโหลด/audit จำเป็น | phase 2 (card attach) ค่อยพิจารณา |

เหตุเลือก A: คำถาม cert เกิดน้อย (ไม่ใช่ hot path), stock data เปลี่ยนบ่อยโดยพนักงาน (runtime สดกว่า), ไม่ต้องดูแล pipeline เพิ่ม, pattern `_admin_image_texts_coll` มีอยู่แล้ว copy ได้

---

## ผลกระทบ

- `product_store.py` +~180 บรรทัด (2 helpers + 2 paths + `stock_db` param + `cert_ids` field)
- `handoffs.py` +~10 บรรทัด (แสดงเลข มอก. เมื่อมี cert_ids)
- `docs/test/test_cert_standards.py` +~10 cases (fake ไม่ต้องแก้ — `$or`/nested ผ่านเป็น loose prefilter)
- `docs/SRS_SSD.md` section 6 (product_store functions)
- `getoutofmywaybotkaikrook2.md` waythrough
- **deploy:** `STOCK_URI`/`STOCK_DB` ต้องอยู่ใน env ของ bot host (docker-compose .env) — ถ้าไม่มี → path 3 เงียบๆ ข้าม (degrade เหมือนเดิม)
- ไม่มี schema change / rebuild / index ใหม่ / dependency ใหม่

## Risks

1. **STOCK_DB ล่ม/ช้า** → `serverSelectionTimeoutMS=5000` + try/except → degrade เป็น 2 paths เดิม (เหมือน `admin_db` pattern)
2. **variant regex COLLSCAN** บน `tier_variation.option_list.option` (~11.5k docs/คำถาม) — คำถาม cert หายาก, acceptable; ถ้าช้าจริงค่อย index
3. **`CN.V`→ccc เป็น inference** — hedge: cert_context ระบุ "CN.V (China version)" ให้ LLM/answer เห็นที่มา
4. **GB regex** — `GB[\s.]*V\.?` อาจชน model code แปลก (เช่น "GBV-XX") — accept rare FP, ดูผล test
5. **stock ผูก 1 listing/SKU** — listing อื่นที่ขาย SKU เดียวกันหลุดจาก stock → variant path ชดเชย (verify แล้ว option name ตรงกัน)

---

### Task 1: Helpers — stock connector + variant cert regex

**Files:**
- Modify: `chatbot/shopeechat/product_store.py` (ใกล้ `_admin_image_texts_coll` ~L3579)
- Test: `docs/test/test_cert_standards.py`

**Interfaces:**
- Produces: `_stock_products_coll() -> coll|None`, `_VARIANT_CERT_RES: dict`, `_variant_cert_hit(name, certs) -> str|None`

- [ ] **Step 1: เขียน failing test** (ต่อท้าย section 5b ใน test_cert_standards.py)

```python
print("=== 5c. variant cert tokens ===")
test("variant (CCC)", product_store._variant_cert_hit("QB817ฟ้า CN.V (CCC)", ("ccc",)), "ccc")
test("variant (CE)", product_store._variant_cert_hit("P23 เทา GB.V (CE)", ("ce",)), "ce")
test("variant GB.V→ce (Global)", product_store._variant_cert_hit("C200 ศูนย์ไทย GB.V", ("ce",)), "ce")
test("variant GB.V ไม่ใช่ gb standard", product_store._variant_cert_hit("P23 เทา GB.V (CE)", ("gb",)), None)
test("variant GB/T→gb จริง", product_store._variant_cert_hit("มาตรฐาน GB/T", ("gb",)), "gb")
test("variant Global V.→ce", product_store._variant_cert_hit("Global V. ศูนย์ไทย", ("ce",)), "ce")
test("variant CN.V→ccc (inferred)", product_store._variant_cert_hit("Pro (CN V.)", ("ccc",)), "ccc")
test("variant EU.V→ce", product_store._variant_cert_hit("ปลั๊ก EU V.", ("ce",)), "ce")
test("variant US.V→fcc", product_store._variant_cert_hit("Adapter US Ver.", ("fcc",)), "fcc")
test("variant 128GB storage → None", product_store._variant_cert_hit("กล้อง + 128 GB", ("gb","ce")), None)
test("variant 32 GB → None", product_store._variant_cert_hit("กล้อง + 32 GB", ("gb","ce")), None)
test("variant ไม่มี token", product_store._variant_cert_hit("QB817 สีเขียว", ("ccc","ce")), None)
```

- [ ] **Step 2: run → FAIL** (`NameError`/`AttributeError: _variant_cert_hit`)

Run: `cd docs/test && ../../.venv/bin/python test_cert_standards.py`

- [ ] **Step 3: implement** — ต่อจาก `_CERT_SEARCH_RES` block (~L3556)

```python
# ── stock DB cert source (itStock.Products — STOCK_URI/STOCK_DB) ────────────
# flag เป็น sparse: True=มี, 'False' string=ไม่มี(negative), ไม่มี field=ไม่รู้
# join: shopee_ship_box.{item_id,model_id} → ShpProducts (item_id float ได้ → int())
_STOCK_CERT_FLAGS: dict[str, tuple[str, ...]] = {
    "tisi": ("is_tis", "tis_id"),          # tis_id มีค่า = มี มอก. แม้ flag ไม่ได้ตั้ง
    "ccc":  ("is_ccc",),
    "ce":   ("is_ce",),
}


def _stock_products_coll():
    """collection Products ของ stock DB — lazy; fail/ไม่มี env → None (degrade)."""
    try:
        from pymongo import MongoClient
        uri = os.environ.get("STOCK_URI")
        dbname = os.environ.get("STOCK_DB")
        if not uri or not dbname:
            return None
        return MongoClient(uri, serverSelectionTimeoutMS=5000)[dbname]["Products"]
    except Exception as exc:
        print(f"[CERT] stock db unavailable: {exc}", file=sys.stderr)
        return None


# variant option names มี cert token ฝัง: "QB817ฟ้า CN.V (CCC)", "P23 เทา GB.V (CE)"
# version tokens: CN.V→ccc, GB.V/Global→ce, EU→ce, US.V→fcc (inference — hedge ด้วย cert_context)
# GB.V = GloBal version ไม่ใช่ GB standard! GB/T จริง match เฉพาะ "gb" cert
_VER_RE = r"[\s.]*V(?:ER)?\.?"   # V / V. / Ver / Ver.
_VARIANT_CERT_RES: dict[str, "re.Pattern"] = {
    "tisi": _CERT_SEARCH_RES["tisi"],
    "ce":   re.compile(r"(?<![A-Za-z0-9])(?:CE|GB" + _VER_RE + r"|GLOBAL" + _VER_RE +
                      r"|EU" + _VER_RE + r"|EU)(?![A-Za-z0-9])", re.IGNORECASE),
    "ccc":  re.compile(r"(?<![A-Za-z0-9])(?:CCC|CN" + _VER_RE + r")(?![A-Za-z0-9])", re.IGNORECASE),
    "fcc":  re.compile(r"(?<![A-Za-z0-9])(?:FCC|US" + _VER_RE + r")(?![A-Za-z0-9])", re.IGNORECASE),
    "gb":   re.compile(r"(?<![A-Za-z0-9])GB[\s./-]*T(?![A-Za-z0-9])"),   # GB/T เท่านั้น — "GB.V"/"128 GB" ไม่ชน
}
_VARIANT_MONGO_TERMS: dict[str, str] = {
    "tisi": r"มอก|[Tt][Ii][Ss][Ii]",
    "ce":   r"CE|GB[\s.]*V|GLOBAL|EU",
    "ccc":  r"CCC|CN[\s.]*V",
    "fcc":  r"FCC|US[\s.]*V",
    "gb":   r"GB[\s/.\-]|GB$",
}


def _variant_cert_hit(option_name: str, certs: tuple[str, ...]) -> str | None:
    """cert key แรกที่ match variant option name (verify หลัง mongo prefilter)."""
    if not option_name:
        return None
    for c in certs:
        pat = _VARIANT_CERT_RES.get(c)
        if pat and pat.search(option_name):
            return c
    return None
```

- [ ] **Step 4: run → PASS** เคส 5c ทั้งหมด + เคสเดิมยังผ่าน

- [ ] **Step 5: commit** — `feat: variant-name cert tokens + stock DB connector for cert search`

---

### Task 2: `search_cert_products` — เพิ่ม path 3 (stock) + path 4 (variant)

**Files:**
- Modify: `chatbot/shopeechat/product_store.py` (`search_cert_products` ~L3602, `_to_result` ~L3661)
- Test: `docs/test/test_cert_standards.py`

**Interfaces:**
- Consumes: `_stock_products_coll`, `_variant_cert_hit`, `_VARIANT_MONGO_TERMS` (Task 1)
- Produces: `search_cert_products(..., stock_db=None)` — result dict เพิ่ม `cert_ids: {tis_id, tis_license_id}|None`; `via` เพิ่ม `"stock"|"variant"`

- [ ] **Step 1: เขียน failing test** — fake stock_db + prod docs มี tier_variation

```python
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
test("variant: cert_context มีชื่อ option", "QB817ฟ้า CN.V (CCC)" in (by_id.get(5, {}).get("cert_context") or ""), True)
test("variant: 128GB ไม่ FP (item6)", 6 in by_id, False)

# stock_db=None → degrade เหมือนเดิม (real lazy connect หรือ None ก็ไม่พัง)
res = product_store.search_cert_products(
    fake_db2, ("tisi",), admin_db=fake_admin, stock_db=None)
test("stock_db=None → ไม่พัง", isinstance(res, list), True)
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement** — ใน `search_cert_products`:

a) signature เพิ่ม `stock_db=None` หลัง `admin_db`
b) `_to_result` เพิ่ม `cert_ids` param:

```python
def _to_result(doc: dict, via: str, ctx_text: str, certs_found: str | None,
               cert_ids: dict | None = None) -> dict:
    return {
        "item_id": doc.get("item_id"),
        "name": doc.get("item_name", ""),
        "brand": (doc.get("brand") or {}).get("original_brand_name", ""),
        "shop": doc.get("shopname", ""),
        "status": doc.get("item_status", ""),
        "stock": _doc_stock_total(doc),
        "via": via,
        "cert": certs_found,
        "cert_context": ctx_text,
        "cert_ids": cert_ids,
    }
```

c) ต่อท้าย path 2 (image_texts) เพิ่ม:

```python
    # --- path 3: stock DB cert flags (itStock.Products → shopee_ship_box.item_id) ---
    coll_st = stock_db["Products"] if stock_db is not None else _stock_products_coll()
    if coll_st is not None:
        try:
            st_items: dict[int, dict] = {}
            for d in coll_st.find(
                    {"$or": [{"is_tis": True}, {"is_ccc": True}, {"is_ce": True},
                             {"tis_id": {"$exists": True, "$nin": [None, ""]}}],
                     "shopee_ship_box.item_id": {"$exists": True}},
                    {"is_tis": 1, "tis_id": 1, "tis_license_id": 1,
                     "is_ccc": 1, "is_ce": 1, "shopee_ship_box.item_id": 1}).limit(2000):
                hit = None
                for c in certs:
                    flags = _STOCK_CERT_FLAGS.get(c)
                    if not flags:
                        continue
                    # tis_id มีค่า → tisi แม้ is_tis ไม่ได้ตั้ง; flag อื่นต้องเป็น True เท่านั้น
                    if any(d.get(f) is True or (f == "tis_id" and d.get(f)) for f in flags):
                        hit = c
                        break
                if not hit:
                    continue
                iid = _norm_iid((d.get("shopee_ship_box") or {}).get("item_id"))
                if iid is None:
                    continue
                e = st_items.setdefault(iid, {"cert": hit, "tis_id": None, "tis_license_id": None})
                e["tis_id"] = d.get("tis_id") or e["tis_id"]
                e["tis_license_id"] = d.get("tis_license_id") or e["tis_license_id"]
            for iid, e in st_items.items():
                if iid in found:
                    found[iid]["via"] = "both"
                    found[iid]["cert_ids"] = {
                        k: e[k] for k in ("tis_id", "tis_license_id") if e[k]} or None
            new_ids = [iid for iid in st_items if iid not in found]
            if new_ids:
                for doc in collection.find(_filters({"item_id": {"$in": new_ids[:limit * 3]}}), proj):
                    key = _norm_iid(doc.get("item_id"))
                    if key is None or key in found:
                        continue
                    if type_filter and not _name_matches_types(doc.get("item_name", ""), type_filter):
                        continue
                    e = st_items[key]
                    ctx = "เลข มอก. " + str(e["tis_id"]) if e["tis_id"] else "stock cert flag"
                    if e["tis_license_id"]:
                        ctx += f" · ใบอนุญาต {e['tis_license_id']}"
                    found[key] = _to_result(
                        doc, "stock", ctx, e["cert"],
                        cert_ids={k: e[k] for k in ("tis_id", "tis_license_id") if e[k]} or None)
        except Exception as exc:
            print(f"[CERT] stock search error: {exc}", file=sys.stderr)

    # --- path 4: variant option names (tier_variation.option_list.option + model.model_name) ---
    variant_union = "|".join(_VARIANT_MONGO_TERMS[c] for c in certs if c in _VARIANT_MONGO_TERMS)
    if variant_union:
        try:
            vproj = dict(proj)
            vproj["tier_variation.option_list.option"] = 1
            vproj["model.model_name"] = 1
            for doc in collection.find(
                    _filters({"$or": [
                        {"tier_variation.option_list.option": {"$regex": variant_union, "$options": "i"}},
                        {"model.model_name": {"$regex": variant_union, "$options": "i"}},
                    ]}), vproj).limit(limit * 3):
                names: list[str] = []
                cert_hit = None
                for tv in doc.get("tier_variation") or []:
                    for o in tv.get("option_list") or []:
                        nm = o.get("option") or ""
                        h = _variant_cert_hit(nm, certs)
                        if h:
                            cert_hit = cert_hit or h
                            names.append(nm)
                for m in doc.get("model") or []:
                    nm = m.get("model_name") or ""
                    h = _variant_cert_hit(nm, certs)
                    if h:
                        cert_hit = cert_hit or h
                        names.append(nm)
                if not cert_hit:
                    continue
                if type_filter and not _name_matches_types(doc.get("item_name", ""), type_filter):
                    continue
                key = _norm_iid(doc.get("item_id"))
                if key is None:
                    continue
                if key in found:
                    found[key]["via"] = "both"
                    continue
                found[key] = _to_result(doc, "variant", "ตัวเลือก: " + ", ".join(names[:3]), cert_hit)
                if len(found) >= limit:
                    break
        except Exception as exc:
            print(f"[CERT] variant search error: {exc}", file=sys.stderr)
```

- [ ] **Step 4: run → PASS** ทั้ง suite (เคสเดิมไม่แตก — `via` desc/image ไม่เปลี่ยน)

- [ ] **Step 5: commit** — `feat: merge stock DB + variant-name cert sources into cert search`

---

### Task 3: คำตอบแสดงเลข มอก. เมื่อมี cert_ids

**Files:**
- Modify: `chatbot/shopeechat/handoffs.py` (~L209-221, answer builder)
- Test: `docs/test/test_cert_standards.py` (เช็ค field ไหลถึง result — e2e handoff ไม่มี test เดิม, manual verify)

- [ ] **Step 1:** ใน answer builder — เมื่อ `_tisi_model_kw` และ result เดียวมี `cert_ids.tis_id` → ใส่เลขในคำตอบ

```python
_ids = (_tisi_products[0].get("cert_ids") or {}) if len(_tisi_products) == 1 else {}
_ids_txt = ""
if _ids.get("tis_id"):
    _ids_txt = f" (เลข มอก. {_ids['tis_id']}"
    if _ids.get("tis_license_id"):
        _ids_txt += f" ใบอนุญาต {_ids['tis_license_id']}"
    _ids_txt += ")"
_tisi_answer = (
    f"ค่ะ สินค้า{_tisi_names[0]} มี {_cert_label}{_ids_txt} ค่ะ "
    f"สามารถสอบถามรายละเอียดเพิ่มเติมได้นะคะ"
)
```

- [ ] **Step 2: verify manual** — replay แชทที่ถาม "QB817 มี มอก. ไหม" → คำตอบมีเลขจริง
- [ ] **Step 3: commit** — `feat: include TIS number in cert answer when known`

---

### Task 4: docs + log

- [ ] `docs/SRS_SSD.md` — product_store section: `_stock_products_coll`, `_variant_cert_hit`, `_VARIANT_CERT_RES`, `search_cert_products` (paths 3-4, `stock_db`, `cert_ids`), `handoffs.py` cert answer
- [ ] `getoutofmywaybotkaikrook2.md` — ย้ายเคสไปผ่านแล้ว + วิธีแก้ + verify
- [ ] **Step: commit** — `docs: cert merge SRS + waythrough`

---

## Phase 2 (บันทึกไว้ — ยังไม่ทำใน plan นี้)

1. **Negative evidence** — `is_tis='False'` → คำถามเจาะรุ่นตอบ "ระบบสต็อกระบุไม่มี มอก." ได้ (แม่นกว่า handoff)
2. **cert on unit card** — `_lookup_unit_certs(unit)`: parse `model_name` tokens + stock `model_id` → `certs` field ใน `to_unit_card` → LLM ตอบ variant-level ("CN.V มี CCC แต่ GB.V มี CE"); prompt ต้องสั่ง "ไม่มี field → ไม่พบข้อมูล อย่าบอกไม่มี"
3. **cert_map collection** — ถ้า runtime โหลดหนักหรืออยาก audit snapshot (ทางเลือก B)

## Open questions (ถาม user ก่อน implement)

1. `CN.V` → ccc ยอมรับ inference ไหม หรืออยากได้ explicit `(CCC)` เท่านั้น? (แนะนำ: รับ — hedge ด้วย cert_context)
2. เลข มอก./ใบอนุญาต โชว์ในคำตอบเลยไหม หรือแค่ internal context? (แนะนำ: โชว์ — ลูกค้าถามบ่อย)
3. `fcc`/`rohs` ใน stock ไม่มี field — ตกลงว่า variant/desc/OCR เท่านั้นสำหรับ 2 ตัวนี้?
