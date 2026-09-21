# Cert Standards Search (มอก./CE/CCC/FCC/RoHS/GB) via image_texts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้บอทตอบคำถามมาตรฐาน/cert (มอก., CE, CCC, FCC, RoHS, GB) ได้จากข้อมูลที่อยู่ในรูป description ด้วย — ไม่ใช่แค่ text description เหมือนปัจจุบัน

**Architecture:**
- ตอน import: เติม `item_ids` ลง `image_texts` docs (admin DB) โดย map กลับจาก `ShpProducts.export.json` field_list — runtime query ตรงไม่ต้องพึ่ง `sellable_units` index
- Runtime: generalize `search_tisi_products` → `search_cert_products` ค้น 2 แหล่ง (description regex เดิม + image_texts ผ่าน item_ids) แล้ว merge
- Detection: `detect_cert_question` คืน tuple ของ cert ที่ถูกถาม (superset ของ `detect_tisi_question` เดิม)
- Handoff flow เดิมใน `handoffs.py` — เปลี่ยนเฉพาะ detection + search call + label ในคำตอบ

**Tech Stack:** Python (FastAPI bot), PyMongo, `docs/test/` script-style asserts

**Spec:** จาก user requirement (2026-09-17): "อยากให้มันตอบเรื่อง มอก กับ มาตรฐานพวกนี้ได้" — รูป spec/cert ถูก extract อยู่แล้ว (มอก. 112, GB 227, CCC 19, CE 14 ใน `exports/image_texts.jsonl`)

## Global Constraints

- Product DB (`dbWallet`) **read-only** — `image_texts` อยู่ใน admin DB (`ADMIN_MONGO_DB`) — ทุก query เป็น read
- Lazy import โมดูลหนักใน function ที่ใช้ (`knowledge_base` import ใน `search_cert_products`)
- Helper private ขึ้นต้น `_`; `from __future__ import annotations` + `|` union
- ทุกฟังก์ชันที่แก้/เพิ่มใน `chatbot/shopeechat/` → อัปเดต `docs/SRS_SSD.md` section 6 (กฎข้อ 1)
- อัปเดต `getoutofmywaybotkaikrook2.md` เท่านั้น (file 1 freeze)
- **ห้ามทำลายเคสที่ผ่าน** — `detect_tisi_question` เดิมต้องยังทำงานเดิม (wrapper/compat)
- image batch ยังรันอยู่ → `import_image_texts.py` รัน**หลัง** batch จบเท่านั้น

## Data notes (verified)

- `image_texts` doc schema ปัจจุบัน: `{image_id, image_url, kind, text, truncated, model, ts}` — **ไม่มี item_id** → ต้องเติม
- jsonl `used_by` เป็นแค่ count (int) ไม่ใช่ item list
- `item_id` ใน export/Mongo เป็น float (`6492042522.0`) — normalize เป็น `int` ตอนเก็บ; Mongo numeric equality match ข้าม int/double ได้
- รูปอยู่ใน `d["description_info"]["extended_description"]["field_list"][i]` ที่ `field_type=="image"` → `f["image_info"]["image_id"]`
- `attach_image_texts` (units.py:344) join ผ่าน `image_id $in` บน admin DB เดียวกัน — reuse `_units_coll().database` pattern ได้

---

### Task 1: `item_ids` ใน image_texts import

**Files:**
- Modify: `chatbot/shopeechat/scripts/import_image_texts.py`

**Interfaces:**
- Produces: `image_texts` docs มี `item_ids: list[int]` + index `item_ids` — Task 3 query `{text: <cert regex>}` บน image_texts แล้วอ่าน `item_ids` จาก doc ที่ match กลับไปหา product

- [ ] **Step 1: เพิ่ม map builder**

```python
def _image_item_ids() -> dict[str, list[int]]:
    """map image_id → item_ids จาก export — logic เดียวกับ _collect_worklist."""
    from chatbot.shopeechat.scripts.build_image_texts import _iter_export_docs
    export = ROOT / "exports" / "ShpProducts.export.json"
    m: dict[str, set[int]] = {}
    for d in _iter_export_docs(export):
        iid_set = {
            f["image_info"]["image_id"]
            for f in ((d.get("description_info") or {}).get("extended_description") or {}).get("field_list") or []
            if isinstance(f, dict) and f.get("field_type") == "image" and isinstance(f.get("image_info"), dict)
            and f["image_info"].get("image_id")
        }
        raw = d.get("item_id")
        try:
            item_id = int(raw)
        except (TypeError, ValueError):
            continue
        for iid in iid_set:
            m.setdefault(iid, set()).add(item_id)
    return {k: sorted(v) for k, v in m.items()}
```

- [ ] **Step 2: ใส่ใน upsert + index**

ใน `main()` หลัง `coll.create_index("image_id", unique=True)`:

```python
    coll.create_index("item_ids")
    iid_items = _image_item_ids()
```

และใน `ops` `$set` เพิ่ม `"item_ids": iid_items.get(iid, []),`

- [ ] **Step 3: py_compile + dry-run เช็ค map**

Run: `.venv/bin/python -m py_compile chatbot/shopeechat/scripts/import_image_texts.py`
แล้ว `python3 -c` เรียก `_image_item_ids()` → เช็ค count > 0 และ spot-check image_id ที่รู้จัก

- [ ] **Step 4: Commit**

---

### Task 2: cert detection ใน warranty.py

**Files:**
- Modify: `chatbot/shopeechat/warranty.py` (หลัง `extract_tisi_model_keyword` ~line 815)
- Test: `docs/test/test_cert_standards.py` (สร้างใหม่ — script style เดียวกับ test_new_product_types.py)

**Interfaces:**
- Produces: `detect_cert_question(message: str) -> tuple[str, ...]` — cert keys เช่น `("tisi",)`, `("ce", "ccc")`; empty tuple = ไม่ใช่คำถาม cert
- `extract_tisi_model_keyword` ขยายให้ตัด cert keywords ทั้งหมด (signature เดิม)

- [ ] **Step 1: เขียน failing test**

```python
# docs/test/test_cert_standards.py — sys.path เดียวกับ test_new_product_types.py
from shopeechat import warranty

def test_detect():
    assert warranty.detect_cert_question("รุ่นไหนมี มอก. บ้าง") == ("tisi",)
    assert warranty.detect_cert_question("ผ่าน CE ไหม") == ("ce",)
    assert warranty.detect_cert_question("มี ccc มั้ย") == ("ccc",)
    assert warranty.detect_cert_question("GB/T ผ่านไหม") == ("gb",)
    # false positives — เดิมผ่านอยู่ต้องไม่พัง
    assert warranty.detect_cert_question("หมอกเย็นเกรดไมครอน") == ()
    assert warranty.detect_cert_question("service center อยู่ไหน") == ()
    assert warranty.detect_cert_question("price เท่าไหร่") == ()
    assert warranty.detect_cert_question("ram 8gb rom 128gb") == ()
    # compat: เคสเดิมที่ detect_tisi_question จับได้ต้องยังได้
    assert warranty.detect_tisi_question("AC65B2 มี มอก. ไหม") is True
    assert "tisi" in warranty.detect_cert_question("AC65B2 มี มอก. ไหม")

def test_model_keyword():
    assert warranty.extract_tisi_model_keyword("AC65B2 มี มอก. ไหม") == "AC65B2"
    assert warranty.extract_tisi_model_keyword("A18T ผ่าน CE ไหม") == "A18T"
    assert warranty.extract_tisi_model_keyword("รุ่นไหนมี มอก. บ้าง") == ""
```

- [ ] **Step 2: run → fail**

Run: `.venv/bin/python docs/test/test_cert_standards.py` → AttributeError

- [ ] **Step 3: implement**

```python
# ── cert standards question detection (superset ของ TISI) ──────────────────
_CERT_QUESTION_RES: tuple[tuple[str, "re.Pattern"], ...] = (
    ("tisi", re.compile(r"(?<![หเ])มอก|(?<![a-z])tisi(?![a-z])", re.IGNORECASE)),
    ("ce",   re.compile(r"(?<![a-z])ce(?![a-z])", re.IGNORECASE)),
    ("ccc",  re.compile(r"(?<![a-z])ccc(?![a-z])", re.IGNORECASE)),
    ("fcc",  re.compile(r"(?<![a-z])fcc(?![a-z])", re.IGNORECASE)),
    ("rohs", re.compile(r"rohs", re.IGNORECASE)),
    ("gb",   re.compile(r"(?<![a-z0-9])gb[/.\s]|(?<![a-z0-9])gb$", re.IGNORECASE)),
)
_GENERIC_STANDARDS_KWS = (
    "ผ่านมาตรฐาน", "ได้มาตรฐาน", "มีมาตรฐาน", "มาตรฐานอะไร", "มาตรฐานไหม",
)


def detect_cert_question(message: str) -> tuple[str, ...]:
    """คืน tuple ของ cert keys ที่ลูกค้าถาม (เช่น ("tisi",) หรือ ("ce","ccc")).

    "ผ่านมาตรฐานอะไรบ้าง" (generic) → คืนทุก cert.
    Superset ของ detect_tisi_question — เคสเดิมทุกเคสยังได้ ("tisi",).
    """
    if not message:
        return ()
    msg = message.strip()
    hits = tuple(k for k, pat in _CERT_QUESTION_RES if pat.search(msg))
    if not hits and any(kw in msg for kw in _GENERIC_STANDARDS_KWS):
        return tuple(k for k, _ in _CERT_QUESTION_RES)
    # กรอง "หมอก/เสมอกัน" — ถ้า hit มาจาก มอก เพียวๆ แต่เป็นคำอื่นจริง
    if hits == ("tisi",) and "มอก." not in msg and "tisi" not in msg.lower():
        if "มอก" not in msg or "หมอก" in msg or "เสมอก" in msg:
            return ()
    return hits
```

และใน `extract_tisi_model_keyword` — loop ตัด keywords เพิ่ม regex pass:

```python
    # ลบ cert keywords (CE/CCC/FCC/RoHS/GB) เพิ่มจาก มอก. เดิม
    for _k, _pat in _CERT_QUESTION_RES:
        cleaned = _pat.sub(" ", cleaned)
```

(วางหลัง loop `_TISI_QUESTION_KWS` เดิม ก่อนลบคำถามทั่วไป)

- [ ] **Step 4: run → pass**

- [ ] **Step 5: Commit**

---

### Task 3: `search_cert_products` ใน product_store.py

**Files:**
- Modify: `chatbot/shopeechat/product_store.py` (section "มอก. (TISI) certification search" ~line 3510)
- Test: `docs/test/test_cert_standards.py` (เพิ่ม test block)

**Interfaces:**
- Consumes: `image_texts.item_ids` (Task 1), cert keys จาก `detect_cert_question` (Task 2)
- Produces: `search_cert_products(db, certs: tuple[str, ...], shop_filter=None, model_keyword=None, limit=30) -> list[dict]` — dict keys เดิมของ tisi + `via` + `cert_context`; `search_tisi_products` กลายเป็น wrapper

- [ ] **Step 1: เขียน failing test** (fake collections — ไม่ต้อง Mongo จริง)

```python
def test_search_cert_merge():
    class FakeCursor(list):
        def limit(self, n): return self[:n]
    class FakeColl:
        def __init__(self, docs): self.docs = docs
        def find(self, q, proj=None): return FakeCursor(self.docs)
    desc_doc = {"item_id": 1, "item_name": "Plug มอก.", "item_status": "NORMAL",
                "brand": {}, "shopname": "s1", "description": "ผ่าน มอก. 1234"}
    fake_db = { ... }  # db[coll_name] → FakeColl([desc_doc])
    # image_texts มี doc text "ผ่านมาตรฐาน CE" item_ids=[2]; product 2 ไม่มีใน description
    # → ผลรวมต้องมี item_id 1 (via desc) + 2 (via image)
```

(เต็มในไฟล์ test — inject admin_db ผ่าน param `admin_db=None` ใน signature เพื่อ testability)

- [ ] **Step 2: run → fail**

- [ ] **Step 3: implement**

เพิ่มก่อน `search_tisi_products`:

```python
# cert regex สำหรับ verify ใน Python (mongo prefilter ใช้ broad terms)
_CERT_SEARCH_RES: dict[str, "re.Pattern"] = {
    "tisi": re.compile(r"(?<![หเ])มอก|(?<![a-zA-Z])tisi(?![a-zA-Z])", re.IGNORECASE),
    "ce":   re.compile(r"(?<![A-Za-z])CE(?![A-Za-z])"),
    "ccc":  re.compile(r"(?<![A-Za-z])CCC(?![A-Za-z])"),
    "fcc":  re.compile(r"(?<![A-Za-z])FCC(?![A-Za-z])"),
    "rohs": re.compile(r"rohs", re.IGNORECASE),
    "gb":   re.compile(r"(?<![A-Za-z0-9])GB(?=[\s/.\-]|$)"),
}
_CERT_MONGO_TERMS = {"tisi": r"มอก|[Tt][Ii][Ss][Ii]", "ce": r"CE", "ccc": r"CCC",
                   "fcc": r"FCC", "rohs": r"[Rr][Oo][Hh][Ss]", "gb": r"GB[\s/.\-]|GB$"}


def _has_cert(text: str, certs: tuple[str, ...]) -> str | None:
    """คืน cert key แรกที่ match (verify หลัง mongo prefilter) — ไม่ match → None."""
    if not text:
        return None
    for c in certs:
        pat = _CERT_SEARCH_RES.get(c)
        if pat and pat.search(text):
            return c
    return None


def _admin_image_texts_coll():
    """collection image_texts จาก admin DB — lazy; fail → None (degrade เป็น desc-only)."""
    try:
        from . import knowledge_base as _kb
        return _kb._admin_db()["image_texts"]
    except Exception as exc:
        print(f"[CERT] admin db unavailable: {exc}", file=sys.stderr)
        return None


def search_cert_products(
    db,
    certs: tuple[str, ...],
    shop_filter: str | None = None,
    model_keyword: str | None = None,
    limit: int = 30,
    admin_db=None,
) -> list[dict]:
    """ค้นสินค้าที่มี cert ที่ถาม — 2 แหล่ง: description text + image_texts (admin DB).

    Returns list[dict]: item_id, name, brand, shop, status, via ("desc"|"image"|"both"),
    cert_context — dedupe ด้วย item_id; sort sellable (NORMAL+stock>0) ก่อน.
    model_keyword ระบุ → ไม่กรอง status (ตอบว่ารุ่นนั้นมี/ไม่มีได้แม้ของหมด)
    model_keyword ไม่ระบุ → คำถาม "รุ่นไหนมีบ้าง" → กรองเฉพาะ item_status==NORMAL
    """
```

Body:
1. desc path = logic เดิมของ `search_tisi_products` แต่ mongo regex = union ของ `_CERT_MONGO_TERMS[c]` + verify ด้วย `_has_cert`
2. image path: `coll = admin_db["image_texts"] if admin_db is not None else _admin_image_texts_coll()` → `find({"text": {"$regex": union}}, {"image_id":1,"text":1,"item_ids":1}).limit(300)` → verify `_has_cert` → รวม `item_ids` → `collection.find({"item_id": {"$in": ids}, +shop/model filters}, tisi_projection)` → merge
3. merge: dict by item_id; ถ้าซ้ำ → `via="both"`; `cert_context` จาก `_extract_tisi_context`-style snippet (reuse ฟังก์ชันเดิม — generalize เป็น `_extract_cert_context(text, pattern)`? ใช้ `_extract_tisi_context` เฉพาะ tisi; cert อื่นทำ snippet ง่ายๆ หน้า/หลัง match 80 chars — extract shared helper `_extract_match_context(text, m, window)` refactor `_extract_tisi_context` ให้เรียกมัน)
4. sort: sellable (status==NORMAL และ stock>0 จาก `stock_info_v2`) ก่อน — เพิ่ม `"stock_info_v2.summary_info.total_available_stock": 1` ใน projection
5. `search_tisi_products(db, ...)` = `return search_cert_products(db, ("tisi",), shop_filter, model_keyword, limit)` — เติม `tisi_context` alias จาก `cert_context` เพื่อ compat

- [ ] **Step 4: run → pass + regression**

Run: `.venv/bin/python docs/test/test_cert_standards.py` + live check `search_tisi_products(db)` บน Mongo จริงต้องยังได้ ~109 products (baseline เดิม)

- [ ] **Step 5: Commit**

---

### Task 4: wire ใน handoffs.py

**Files:**
- Modify: `chatbot/shopeechat/handoffs.py` (TISI block ~lines 157-250)

**Interfaces:**
- Consumes: `warranty.detect_cert_question`, `product_store.search_cert_products`

- [ ] **Step 1: เปลี่ยน block**

```python
    _certs = warranty.detect_cert_question(req.message)
    if _certs:
        _tisi_model_kw = warranty.extract_tisi_model_keyword(req.message)
        _cert_label = "/".join({"tisi": "มอก."}.get(c, c.upper()) for c in _certs)
        ...
        _tisi_products = product_store.search_cert_products(
            db, _certs, shop_filter=req.shop, model_keyword=_tisi_model_kw or None, limit=30)
```

- คำตอบ: แทน "มอก." ตายตัวด้วย `_cert_label` ในทั้ง 3 template (single/list/not-found)
- not-found handoff: `reason="cert_not_found"`, `claim={"topic": f"สอบถาม {_cert_label}"}`, log_tag `"CERT-HANDOFF"`
- log `[TISI]` → `[CERT]`

- [ ] **Step 2: py_compile + รัน regression test เดิมที่เกี่ยว**

Run: `.venv/bin/python -m py_compile chatbot/shopeechat/handoffs.py` + `test_warranty_delivery.py` + `test_new_product_types.py` (baseline 66/66)

- [ ] **Step 3: Commit**

---

### Task 5: SRS + waythrough + live verify

- [ ] **Step 1:** อัปเดต `docs/SRS_SSD.md` section 6 — `detect_cert_question`, `extract_tisi_model_keyword` (ขยาย), `search_cert_products`, `search_tisi_products` (wrapper), `_has_cert`, `_extract_match_context`, `_admin_image_texts_coll`, `_image_item_ids` (import script), `post_intent_handoffs` (Calls เปลี่ยน)
- [ ] **Step 2:** รอ image batch จบ → รัน `import_image_texts.py` (มี item_ids แล้ว) → เช็ค `image_texts` count + docs มี `item_ids`
- [ ] **Step 3:** live verify บน :8010 (restart โค้ดใหม่): "รุ่นไหนมี มอก. บ้าง" / "A18T ผ่าน CE ไหม" / "มี ccc ไหม" / "หมอกเย็น" (ต้องไม่เข้า cert path)
- [ ] **Step 4:** เขียนผลลง `getoutofmywaybotkaikrook2.md` (ผ่านแล้ว + วิธีแก้)
- [ ] **Step 5: Commit**
