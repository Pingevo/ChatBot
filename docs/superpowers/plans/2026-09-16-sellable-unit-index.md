# Sellable Unit Index + Retrieval Fix — Implementation Plan

> **For agentic workers:** ทำทีละ task ตามลำดับ แต่ละ task จบด้วย verification ของตัวเอง อย่าข้าม gate

**Goal:** เปลี่ยน retrieval ของ legacy `app.py` จาก listing-level keyword/regex guesswork → sellable-unit-level field filtering โดยไม่แตะ production path จนกว่า unit index พิสูจน์แล้ว

**Architecture:** สร้าง derived data ครั้งเดียวตอน ingest (offline script → JSONL → admin DB): `sellable_units` = 1 doc ต่อ 1 รุ่นย่อย (26,970 units จาก 11,503 listings) พร้อม derived fields (type/subtype/components/model_codes/sellable/desc_sections/image_text) — runtime เหลือแค่ Route ครั้งเดียว → filter fields → rank → ปั้น context ตาม intent

**Tech Stack:** Python 3, pymongo (read-only product DB), rapidfuzz+pythainlp (มีอยู่), Gemini vision (ingest เท่านั้น), JSONL intermediate

**Spec:** ผลวิเคราะห์ทั้ง session — ตัวเลขจริงจาก `exports/ShpProducts.export.json` (286MB, 11,503 docs): 26,970 units, 4,969 sellable, 920 mixed-stock, 2,408 multi-price, 1,038 docs พูดถึงรุ่นย่อยใน description_info text, 93% ของ NORMAL+in-stock มีรูปใน description_info

## Thinking Flow (เหตุผลรวม)

```
ลูกค้าคุยเป็น "รุ่นย่อย" ──แต่──► ระบบคิดเป็น "listing" + ขาด fields
        │                              │
        ▼                              ▼
  patch ซ้อน patch (subtype×20จุด,   เดา type จาก cat_name+regex ที่เดาไม่มีทางพอ
  fuzzy patch×10, fallback ladder)   → คำตอบผิด/มั่ว/บอกไม่มีข้อมูลทั้งที่มี
        │                              │
        └────────► แก้ต้นเหตุจุดเดียว ◄┘
                   ย้าย "การรู้" จาก runtime code → fields ที่คำนวณครั้งเดียวตอน ingest
                   (reviewable data — แก้ได้โดยไม่ deploy)
```

**regex + vector ในแพลนใหม่**: ไม่ได้ลบ — เปลี่ยนเป้าหมาย จาก "เดา item_name ดิบ" → "ค้นบน field ที่ normalize แล้ว"
- **regex/exact** → `unit.model_codes`, `search_text` tokens, shop — exact match SKU/รหัส (จุดที่ vector อ่อน)
- **vector** → semantic recall บน `unit.search_text` (item_name+model_name+codes+type) + `kb_qa.q` (จุดที่ regex พลาด: typo/ภาษาธรรมชาติ)
- **structured filter** → `product_type/components/sellable/status/price` เป็น fields ไม่ใช่ regex
- merge → deterministic rank: exact code > sellable > type match > promo/recency

**โค้ดใหม่ไม่เข้า app.py** — ไฟล์ย่อยแยกหน้าที่ (3 ไฟล์ใหม่เท่านั้น):
- `chatbot/shopeechat/route_context.py` — RouteContext dataclass + `resolve_route()` + `normalize_message()` (typo_dict loader)
- `chatbot/shopeechat/units.py` — unit index access: `fetch_units()`, `to_unit_card()`, section picker
- `chatbot/shopeechat/guards.py` — output guard (เคลม/คืนเงิน/จัดส่ง) + flags builder
- ของเดิมที่ย้ายออกจาก app.py: `_routing`/`_send_handoff` → `responses.py` (ตัด circular import ที่ modules ยิงกลับ app)

**KB ใช้ดีกว่าเดิม 3 ระดับ**: (1) deterministic spec — `canonical_specs` ตอบ spec/compare โดยไม่ผ่าน LLM-เดา (LLM แค่เรียบเรียง) (2) **spec inheritance → unit card**: unit ที่ desc ว่างยืม specs จาก kb_products ผ่าน model_codes — แก้ปัญหา "บอกไม่มีข้อมูลทั้งที่ KB มีจริง" โดยตรง (3) `kb_qa` vector-search ด้วยคำถามโดยตรง

**app.py ลดได้โดยประมาณ**: patch logic ที่ตายเมื่อมี unit index ≈ subtype 20 จุด→1, fuzzy caller patches ~200+ บรรทัด, `_clean_description` keyword path, fallback ที่ index ครอบ, CONV-ACTIVE re-detect — ประเมินหั่น ~800-1,500 บรรทัดจาก ~4,800 (ไม่นับ flow ที่ต้องอยู่: order/warranty/anchor/handoff ซึ่งดีอยู่แล้ว)

## Global Constraints

- Product DB (`dbWallet`) **read-only เด็ดขาด** — derived data เขียนลง admin DB (`ADMIN_MONGO_*`) หรือ JSONL เท่านั้น
- ห้ามอ่าน `.env` / `มาแล้วจ้า.md`
- ก่อนเริ่มทุก phase: เขียน "กำลังจะทำ" ใน `getoutofmywaybotkaikrook.md`; จบ + verify แล้วค่อยย้าย "ผ่านแล้ว"
- แก้/เพิ่มฟังก์ชันใน `chatbot/shopeechat/` → อัปเดต `docs/SRS_SSD.md` section 6 ทุกครั้ง
- ห้ามลบ patch/fallback ใดๆ ใน `fetch_products`/`app.py` ก่อน unit path ผ่าน regression เคสที่เกี่ยว
- Export snapshot: `exports/ShpProducts.export.json` (Aug ~11) — script ต้องอ่านจาก live DB ได้ด้วย (flag `--source export|mongo`)
- ไม่มี pytest framework ใน repo — test = script `assert` แบบ `docs/test/` เดิม

---

## Task 1: `unit_classifier.py` — classifier ตัวเดียว (data-side)

**Files:**
- Create: `chatbot/shopeechat/scripts/unit_classifier.py`
- Test: `docs/test/test_unit_classifier.py`

**Interfaces:**
- Produces: `classify_unit(item_name, model_name, model_sku, kb_lookup) -> dict`
  ```python
  {
    "components": ["adapter"] | ["adapter","cable"] | ["camera","sd_card"] | ...,
    "kind": "standalone" | "variant" | "combo",
    "product_type": str | None,        # "charger","cable","powerbank","camera","smartwatch",...
    "charger_subtype": "adapter"|"cable"|"set"|"car"|"wireless"|"desktop"|"powerbank"|None,
    "model_codes": ["HA835","AL873"],
    "oos_in_name": bool,
    "confidence": "high"|"medium"|"low",
  }
  ```
- Consumed by: Task 2 (`build_sellable_units.py`)

- [x] **Step 1: เขียน test จากเคสจริง** (ใช้ตัวอย่างที่ verify แล้วจาก export) — `docs/test/test_unit_classifier.py` 10/10 PASS

```python
# docs/test/test_unit_classifier.py — assert cases จากข้อมูลจริง
CASES = [
    # (item_name, model_name, expected components/kind/subtype)
    ("ZMI HA835 ...หัวชาร์จ...", "HA835 เฉพาะหัว",      ["adapter"], "standalone", "adapter"),
    ("ZMI HA835 ...",            "HA835 พร้อมสาย",      ["adapter","cable"], "combo", "set"),
    ("ZMI HA716 ...",            "AL870 เฉพาะสาย",      ["cable"], "standalone", "cable"),
    ("ZMI HA716 ...",            "716BK+AL870WH",       ["adapter","cable"], "combo", "set"),
    ("IMILAB EC4 กล้อง...",      "EC4 เฉพาะกล้อง",      ["camera"], "standalone", None),
    ("IMILAB EC4 กล้อง...",      "EC4 +Smart Hub+Solar",["camera","hub","solar"], "combo", None),
    ("IMILAB EC5 กล้อง...",      "กล้อง + 64 GB",       ["camera","sd_card"], "combo", None),
    ("IMILAB W01 สมาร์ทวอทช์",   "สีชมพู",              ["watch"], "variant", None),
    ("IMILAB W01 สมาร์ทวอทช์",   "สีชมพู + สายสีเทา",   ["watch","strap"], "combo", None),
    ("...", "สินค้าหมด", ..., ..., oos_in_name=True),
]
```

- [x] **Step 2: รัน → fail** (`python docs/test/test_unit_classifier.py`)
- [x] **Step 3: implement** — 3 ชั้นตามความน่าเชื่อถือ:
  1. `model_codes` สกัดจาก `model_sku` ("ZMI-HA716-CN-WH"→["HA716"]) + `model_name` — ถ้า code match KB (task 4 ทำ link) ให้ยืม category
  2. components จาก pattern บน `model_name` เท่านั้น: `เฉพาะX`/`X+Y`/`พร้อมX`/`+เมม`/`+SD xx GB`/multi-code — pattern list อยู่ใน dict เดียวต้นไฟล์ (ย้ายง่ายไป config ทีหลัง)
  3. `product_type` จาก item_name+model_name ด้วย keyword map ชุดเดียว (reuse ตารางใน `product_store.PRODUCT_TYPES` เป็น base — import มาใช้ ไม่เขียนใหม่) + confidence; `low` → `product_type=None` (ไม่ฝืนเดา)

**Taxonomy (lock จากข้อมูลจริง — ต่อยอด PRODUCT_TYPES เดิม 15 ตัว):**
- `product_type`: phone, tablet, smartwatch, smartband, earphone, speaker, charger, cable, powerbank, camera, case, screen_protector, strap, memory_card, projector, vacuum, fan, mobile_wifi, selfie_tripod, massager, hair_dryer, smart_home(hub/sensor/socket), solar_panel, other
- `charger_subtype`: adapter | cable_only | set | car_charger | wireless | desktop_station
- `cable_subtype`: usb-c | lightning | micro | type-a | c-to-c | c-to-l
- `camera_subtype`: indoor | outdoor | dashcam | doorbell
- `components` (สำหรับ combo): {adapter, cable, sd_card, hub, solar_panel, strap, case, earphone, powerbank, stand, mount, bag, screen_protector}
- [x] **Step 4: รัน → pass** + รายงาน coverage — sellable units 6,613: high 6,251 / low 362 = **94.5% classified** (main_comp fallback = item_type เอง)
- [x] **Step 5:** commit

---

## Task 2: `build_sellable_units.py` — สร้าง index

**Files:**
- Create: `chatbot/shopeechat/scripts/build_sellable_units.py`
- Test: `docs/test/test_sellable_units.py` (assert บน output JSONL)

**Interfaces:**
- Consumes: `unit_classifier.classify_unit`, `description`/`description_info` parser (inline ใน script เดียวกัน — ponytail: ไม่แยกไฟล์จนกว่าจำเป็น)
- Produces: `exports/sellable_units.jsonl` — 1 บรรทัดต่อ unit:
  ```python
  {unit_id, item_id, model_id, display_name, kind, components, product_type,
   charger_subtype, model_codes, price, stock, item_status, model_status,
   shop, brand, cat_name, sellable, answerable, oos_in_name,
   desc_sections: {...}, image_urls: [...], search_text}
  ```

- [x] **Step 1: test** — `docs/test/test_sellable_units.py` ALL PASS: units=26,970 unique, sellable=4,969, schema ครบ, HA835/AL870/EC4 ถูก, warranty units=2,084, image units=12,120
- [x] **Step 2: implement** — วน export, แตก `model[]` → unit, เรียก classifier, parse desc:
  - `description` → sections ตาม marker ที่นับได้จริง (`เงื่อนไขการรับประกัน`/`จุดเด่น`/`คุณสมบัติ`/`Specification`)
  - `description_info.field_list` → text blocks merge เข้า sections + image blocks → `image_urls[]` (ยังไม่ vision — task 3)
  - `search_text` = display_name + model_codes + type words
- [x] **Step 3: รันเต็มบน export → JSONL + รายงาน coverage** — **GATE PASS: 94.2% sellable classified** (price_info เป็น list — handle dict|list)
- [x] **Step 4:** commit

---

## Task 3: `build_image_texts.py` — image_texts extraction (vision-parse) — 🔄 RUNNING

**Files:**
- Create: `chatbot/shopeechat/scripts/build_image_texts.py` ✅ (ชื่อเปลี่ยนจาก desc_image_text.py — output JSONL ก่อน collection ตามลำดับงานจริง: user สั่งทำ sellable ก่อน + Gemini direct keys ไม่ใช่ OpenRouter)
- Produces: `exports/image_texts.jsonl` keyed by `image_id` (collection `image_texts` ใน admin DB → import ทีหลังตอน Task 6+)

**Interfaces:**
- Consumes: `exports/sellable_units.jsonl` (image_urls), `llm.describe_image` (reuse ตัวเดิม)
- Produces: collection **`image_texts`** (admin DB) keyed by `image_id`:
  ```python
  {image_id, url, kind: "spec|variant_map|product|banner",
   text: "...", used_by: n, is_template: bool, ocr_at: ts}
  ```
  units เก็บแค่ `image_ids: [...]` (normalize — ไม่เก็บ text ซ้ำ)

**กฎสำคัญ (จากข้อมูลจริง — 23,042 refs / 14,005 unique / top shared 1,759 docs):**
- dedup ตาม `image_id` ก่อนเสียเงิน (ลดงาน ~40%)
- `used_by > 20` → `is_template` = แบนเนอร์ร้าน/เงื่อนไขกลาง → extract ครั้งเดียว → ส่ง `kb_policy` **ไม่ใช่** per-unit
- structured prompt เดียว ขอ JSON `{kind, text}` — vision classify เอง ไม่ต้องมี pass แยก:
  spec infographic→ข้อความ spec ครบ / variant_map→mapping รหัส↔ตัวเลือก ("ดู Code ที่รูป") / product→บรรยายสั้น / banner→เงื่อนไข
- เก็บ `url` อ้างอิงเสมอ + mark text ว่า OCR-derived

- [x] **Step 1:** filter เฉพาะ sellable — measured: **5,925 unique image_id** (template >20 = 45); วัดต้นทุนจริง: ธรรมดา ~฿0.02, spec sheet หนัก ~฿0.14-0.17
- [x] **Step 2: implement** — Gemini direct (`_next_client()` cached-client rotation — bug "client has been closed" เจอและแก้), rate ≤80/min (0.78s), ≤4,000/day `--max-calls`, checkpoint JSONL resume (skip status==ok), **ทุก call → AI Usage Hub + local usage log** (กัน hub timeout), `max_output_tokens=4000` + finish_reason check
- [x] **Step 3: sample จริง 9 รูปแล้ว** — quality ดี: banner/spec/variant sheet แยก kind ถูก, OCR ไทยครบ (CUKTECH PB060/PB150P/PB1055 spec sheet ~1,800 out tokens)
- [ ] **Step 4:** commit + รอ batch เสร็จ (~2 วันตาม quota) → รายงาน cost จริงรวม

---

## Task 4: KB re-import — 3 store + link catalog

**Files:**
- Modify: `docs/adminbase/script/import_adminbase.py`
- Create: `docs/adminbase/script/spec_key_map.py` (mapping table ไฟล์เดียว ~100 ชื่อ column จริง → canonical key)
- Test: `docs/test/test_kb_import.py`

**Interfaces:**
- Produces: `kb_products` {kb_id, brand, model, model_codes, category, canonical_specs{}, specs_raw{}, item_ids[], version}, `kb_qa` {qa_id, kb_id, q, a, topic}, `kb_raw` (list of {col,val} — แก้ bug column ซ้ำเขียนทับ)
- Consumed by: `knowledge_base.py` (phase C), Task 1 KB-link

- [x] **Step 1: test** — `docs/test/test_kb_import.py` ALL PASS: dup Q&A columns → 2 qa docs, canonical_specs ถูก, dup spec cols ไม่หาย, code→item map 1,362 codes
- [x] **Step 2: implement** — `parse_row` → (kb_products, [kb_qa], kb_raw); raw=list-of-pairs (แก้ dup-column bug จริง 4 ไฟล์); Q&A positional pairing (Cuktech ZTEC มี 2 pairs/row); canonical map ~45 keys; item_ids ผ่าน model_codes
- [x] **Step 3: dry-run + import จริง** — kb_products=1,011 (canonical 511, linked items 539), kb_qa=393 (linked 239), kb_raw=1,040 — เขียน admin DB แล้ว
- [x] **Step 4:** commit

---

## Task 5: `typo_dict.json` + `unit_embeddings.npz`

**Files:**
- Create: `chatbot/shopeechat/scripts/build_typo_dict.py` (อ่าน sellable_units.jsonl → tokens)
- Modify: `chatbot/shopeechat/scripts/build_embeddings.py` → รองรับ `--units` mode (embed `search_text` ต่อ unit)

**Interfaces:**
- Produces: `exports/typo_dict.json` = {brands[], model_codes[], product_words[], thai_terms[]} — จาก item_name/model_name/brand จริงทั้งหมด; `exports/unit_embeddings.npz` (item_id+model_id+shop per row เหมือน format เดิม)
- Consumed by: Task 7 `normalize_message`; Task 8 vector search บน units

- [ ] **Step 1-3:** extract tokens (≥4 chars + Thai words ≥3), dedupe, save — test: "biokoop","ha835","สมาร์ทวอทช์" อยู่ใน dict
- [ ] **Step 4:** build embeddings บน unit.search_text (reuse `embedding.py` เดิม)

---

## Collections (admin DB — product DB ยัง read-only)

| สร้างใหม่ | เก็บต่อ | เลิกใช้หลัง migration |
|---|---|---|
| `sellable_units` (core) | `ShpProducts`(read-only source), orders, conversations, conversation_products/timelines, sessions, shop_* | `knowledge_base` เดิม (flat) |
| `image_texts` (keyed image_id) | test_chat_*, shadow_replies, triggers, tickets, workflows, assignment_* | `product_embeddings.npz` เดิม |
| `kb_products`/`kb_qa`/`kb_raw` | | ลบได้ทันที: `pararell_bottesting`, `usersettings` (zero reference พิสูจน์แล้ว) |
| `typo_dict.json` (file ไม่ใช่ collection) | | `compatibility_info`,`tag.kit` fields (ว่างอยู่แล้ว) |

---

## Task 6: plumbing ระดับ variation (additive — risk ต่ำ)

**Files:**
- Modify: `product_store.py:to_product_card` (~L597-611), `conversation_products.py:add_product` (L148), `order_flow.py` (L186-211)

**Interfaces:**
- Produces: `variants[]` += `{model_id, stock, price, model_status}`; `add_product(..., model_id=None)`; order anchor ส่ง model_id จาก order item

- [ ] **Step 1: test** — card ของ EC4 มี per-variant stock; order anchor เก็บ model_id
- [ ] **Step 2: implement** (additive — ไม่ลบ field เดิม)
- [ ] **Step 3:** อัปเดต SRS section 6 + waythrough; commit

---

## Task 7: `route_context.py` — Route เดียว + normalize (ไฟล์ใหม่ ไม่บวม app.py)

**Files:**
- Create: `chatbot/shopeechat/route_context.py` — `RouteContext` dataclass + `resolve_route(intent_result, message)` + `normalize_message(msg)`
- Modify: `app.py` (chat() setup ~L520 — แทนที่ direct detect 20 จุดด้วย `route.`)

**Interfaces:**
- Produces: `route = resolve_route(intent_result, normalized_msg)` → `{product_types, charger_subtype, device, model_codes, needs_desc, flags}`; `normalize_message(msg)->corrected msg` (typo-correct เทียบ typo_dict ด้วย rapidfuzz — threshold ≥85 แก้เฉพาะที่ชัวร์)
- Consumes: typo_dict.json, intent_classifier

- [ ] **Step 1: test** — message "HA835 พร้อมสาย" → route.charger_subtype=="set"; "โทสับ"→correct→"โทรศัพท์"
- [ ] **Step 2: implement** — resolve ครั้งเดียวหลัง intent; ทุก `_detect_charger_subtype` ตรงๆ (20 จุด) → อ่าน `route.charger_subtype` แล้วส่ง `charger_subtype_override` ลง fetch_products
- [ ] **Step 3: regression** — `test_charger_subtype.py` + car_charger tests ต้องผ่านเหมือนเดิม
- [ ] **Step 4:** SRS + waythrough; commit

---

## Task 8: `units.py` — unit path (flag-gated — risk สูงสุด)

**Files:**
- Create: `chatbot/shopeechat/units.py` — `fetch_units(db, route, ...)`, `to_unit_card(unit)`, `pick_desc_sections(unit, route)`
- Modify: `product_store.py:fetch_products` — เรียก `units.fetch_units` เมื่อ flag เปิด (app.py แทบไม่เปลี่ยน)

**Interfaces:**
- Consumes: `sellable_units` collection (admin DB), `route` fields
- Produces: unit cards — behavior เดิมเป็น fallback เมื่อ flag ปิด/index ว่าง

- [x] **Step 1:** `USE_UNIT_INDEX` env flag (default off) — path ใหม่: exact model_code → field filter (type/components/sellable/shop/price) → vector บน search_text → merge+rank ✅ (units.py + fetch_products hook)
- [x] **Step 2:** เปิด flag เฉพาะ charger path ก่อน → run regression เต็ม ✅ `USE_UNIT_INDEX=charger` → car_charger 16/16 + subtype parity 42/42
- [x] **Step 3: เคสใหม่ที่ต้องผ่าน** — ✅ test_units.py 5/5: "HA835 พร้อมสาย"→combo set, "สายชาร์จ AL870"→cable standalone, EC4 per-variant stock, "กล้องวงจรปิด"→เฉพาะ sellable (vector-level sellable mask)
- [x] **Step 4:** commit 913e8a3; **เก็บ flag ไว้ — ลบ path เดิม task 10 เท่านั้น** (flag ยัง off by default)

---

## Task 9: Context shaping v2 + `guards.py`

**Files:**
- Create: `chatbot/shopeechat/guards.py` — `build_flags(unit_card)`, `check_output(answer, route) -> str`
- Create: `chatbot/shopeechat/responses.py` — ย้าย `_routing`/`_send_handoff`/step helpers จาก app.py (ตัด circular import)
- Modify: `llm.py:_build_context`, `app.py` (web search trigger + output guard call), `web_search.py:should_use_web_search`

**Interfaces:**
- Produces: unit card มี `sellable`,`has_warranty_info`,`has_description`,`oos_in_name` flags; desc เฉพาะ top-K(≤5) × เฉพาะ section ตาม `route.needs_desc`; `canonical_specs` inject เป็น facts (รวม spec inheritance: unit ที่ desc ว่างยืมจาก kb_products ผ่าน model_codes — แก้ "บอกไม่มีข้อมูลทั้งที่ KB มี"); output guard regex (ยืนยันเคลม/คืนเงิน/จัดส่ง โดยไม่มี handoff → flag)

- [x] **Step 1-3:** implement ✅ — `guards.py` (build_flags/check_output), `responses.py` (ย้าย _routing+_send_handoff, app.py −88 บรรทัด), `attach_kb_specs` spec inheritance, `ChatResponse.model_post_init` output guard จุดเดียวครอบทุก return path, `_build_context` ส่ง canonical_specs+unit flags
- [x] **Step 4:** SRS + waythrough; commit — test_guards ALL PASS + regression 16/16 (เว้น token-compare จริงไว้ทำตอนเปิด flag)

---

## Task 10: ลบของที่ตายแล้ว (หลัง 8-9 นิ่ง ≥1 regression cycle)

ลบทีละกลุ่ม commit แยก: `_detect_product_types_fuzzy`+caller patches (app.py:2450-3020 หลายจุด), `_PRODUCT_TYPE_CATEGORIES` เป็น filter, `_filter_charger_subtype` ×3, CAR-CHARGER patch, `$nor` accessory list, `known_brands` generic words, `_clean_description` keyword path (เหลือ section picker), fallback ladder ที่ unit index ครอบแล้ว, dead code (product_store.py:3372)

- [ ] แต่ละลบ: run `test_charger_subtype.py` + `test_car_charger_regression.py` + replay เคสผ่านแล้ว
- [ ] fix `fuzzy_match_products`: เอา `item_status:NORMAL` ออก (ขัด requirement ตอบทุก status), ตัด prefix-3 gate, fix `_common` blocklist

---

## Done criteria รวม

- [ ] ตอบระดับ variation ได้: stock/price/spec/ประกัน ต่อรุ่นย่อย
- [ ] เสนอขายเฉพาะ sellable; ตอบข้อมูลได้ทุก status
- [ ] desc รูปถูกอ่าน (image_text); model_code exact match; typo ถูกแก้ก่อน detect
- [ ] spec ตอบจาก canonical_specs (ไม่เดา); ไม่มี output ที่เคลมเป็นแอดมิน
- [ ] regression "ผ่านแล้ว" ทั้งหมดยังผ่าน; SRS + waythrough อัปเดตครบ
