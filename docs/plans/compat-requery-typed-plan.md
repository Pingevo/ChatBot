# Plan: Compat re-query ตาม product_type ลูกค้า + catalog grounding

วันที่: 2026-09-18 · สถานะ: รอ review/approve

## ปัญหา (verified สด — root cause 3 ชั้น)

`หูฟัง sony ใช้กับ iphone 15` → intent แยกได้ `type=earphone, device=iphone 15` ถูกต้อง
**main retrieval ดึงหูฟังถูกอยู่แล้ว 50 ตัว** (Xiaomi Buds 3 อยู่อันดับแรก) —
แต่คำตอบยัง "ไม่มีหูฟัง" เพราะ chain ข้างล่างนี้ทำงานผิดทีละชั้น:

1. **`_device_spec_lookup` re-query ดึงผิดหมวด** — keywords+product_type มาจาก
   device-spec web search (`"{device} charging spec..."` → charging domain เสมอ)
   → merge ชาร์จ 30 ตัวเข้า pool; `intent.product_type='earphone'` ไม่เคยถูกใช้
2. **`_filter_compat_products` ลบหูฟังทิ้งทั้งหมด (ตัวการหลัก)** — line 437:
   ambiguous merge-back เฉพาะเมื่อ `compat < 2` — หูฟังไม่มี connector → ambiguous;
   ชาร์จ usb-c ≥2 ตัว → compat → **หูฟังถูกลบจาก context เงียบๆ** (verified:
   mixed list 5 ตัว → filter คืนแค่ชาร์จ 2 ตัว)
3. **spec-extra prompt สั่งหาของ ≥27W** — charger directive ทั้งที่ถามหูฟัง
   → LLM เห็นแต่ชาร์จ + ถูกสั่งเรื่อง wattage → ตอบ "ไม่มี" + hallucinate

ผล: ร้านมีหูฟัง **54 ตัว NORMAL (KingGadgets)** แต่ตอบ "ไม่มีหูฟัง" +
เดา "มีสมาร์ทโฟน Xiaomi" (hallucinate — ร้านไม่มีมือถือขายเลย)

**ลำดับ fix ตาม causality: A4 (filter) > A2 (prompt) > A1 (re-query) > A3 (ungate) > B (grounding)**

## Fix A — re-query scoped ด้วย product_type ลูกค้า

แยก compat-mode ตาม `intent_result["product_type"]` (fallback `_detect_product_types(msg)`):

| mode | types | re-query | watt sort | connector filter |
|---|---|---|---|---|
| `charging` | charger, adapter, cable, powerbank, car_charger, wireless_charger | **เหมือนเดิมทุกอย่าง** (web kws + subtype prefix) | on | on |
| `model_fit` | case, screen_protector | `"{type_kw} {device_name}"` — compat = ขนาด/รุ่น | off | on (harmless — ไม่มี connector → ambiguous kept) |
| `self_compat` | earphone, speaker, smartwatch, keyboard, mouse, fan, camera, vacuum, ... | `"{type_kw}"` เท่านั้น — BT/app ใช้ได้กับทุกเครื่อง ไม่จำกัดด้วยชื่อรุ่น | off | on (wired variant ที่บอก plug ผิดยังถูก drop ถูกต้อง) |
| `unknown` | ไม่มี type | เหมือนเดิม (charging guess — คงพฤติกรรมเก่า) | on | on |

**ไม่ต้องมี keyword table** — verified สด: `fetch_products(db, "earphone")` คืนหูฟังจริง
เพราะ fetch_products detect type จาก message แล้วใช้ `_product_type_regex` เอง
→ **type token ใช้เป็น query ตรงๆ ได้ทุก type** (coverage = taxonomy 105 types
อัตโนมัติ ไม่ต้องลิสต์ keyword ต่อ type)

ต้องมีแค่ classification set (bounded, category-level) — taxonomy เต็ม 105 types:

```python
_CHARGING_TYPES = {"charger", "powerbank", "car_charger",
                   "wireless_charger", "desktop_charger", "dock"}
_MODEL_FIT_TYPES = {"case", "screen_protector", "battery", "stylus", "memory_card"}
_SKIP_TYPES = {"phone", "voucher"}   # phone = target pseudo-type, voucher = ไม่ใช่ของ
# ที่เหลือทั้งหมด → self_compat
```

**type source (audit: intent enum เล็กกว่า taxonomy มาก):**
- intent `product_type` มีแค่ 8 ค่า: `phone|charger|earphone|smartwatch|powerbank|case|speaker|other|null`
- ถ้า intent ∈ taxonomy และไม่ใช่ other/null → ใช้ intent
- ถ้า intent=other/null → fallback `_detect_product_types(req.message)`
- detect คืน set หลายตัว → pick ตาม priority: charging > model_fit > self_compat
  (ตัวแรกตามลำดับ — compat attr ที่ถามน่าจะเป็นชาร์จก่อน)
- conflict intent vs detect (หายาก): prefer detect (literal จากข้อความลูกค้า)

- `model_fit`: query `f"{type} {device_name}"` เช่น `case iphone 15` — device name คือ compat key
- `self_compat` (ทุก type อื่น): query = **type token เท่านั้น** — **ห้ามใส่ device name**
  (หูฟัง BT ทุกตัวใช้กับ iPhone ได้ ถ้าใส่ "iphone 15" จะพลาดตัวที่ไม่ได้เขียนชื่อรุ่นไว้)
- `phone` → **skip re-query ทั้งหมด** (ลูกค้าถามตัวเครื่อง ไม่ใช่ accessory)
- ของที่ re-query ได้เข้า `_additional_products` → dedup เดิม → merge เดิม

### Fix A2 — spec-extra prompt ต้อง gate ตาม mode (audit finding — critical)

เจอระหว่างอ่านโค้ด: `_device_spec_extra` (line ~601-618, 637-642) inject ข้อความ
charger-specific เสมอ: "จ่ายไฟได้พอ", "wattage", "dual-tier baseline/upgrade",
"ต้องรองรับอย่างน้อย {min_watt}W" — **แม้ re-query ดึงหูฟังถูกแล้ว LLM ก็ยังถูกสั่ง
ให้หาของที่ ≥27W** → อาจ reject หูฟังทั้งหมดหรือ hallucinate wattage

แก้: แยก prompt text ตาม mode
- `charging`/`unknown` → text เดิมทั้งหมด (regression-safe)
- `model_fit` → "เลือกสินค้าที่รองรับรุ่น {device} (ขนาด/รุ่นตรง) — ห้ามพูด wattage"
- `self_compat` → "เลือกสินค้าที่ใช้กับ {device} ได้ (bluetooth/connector เดียวกัน) — ห้ามพูด wattage"
- catalog spec line (connector/watt/protocols) ยังใส่ทุก mode — เป็นข้อเท็จจริง
  ไม่ใช่ directive — LLM ใช้ตอบ "ใช้ได้กับ iPhone 15" ถูกอยู่แล้ว
- `min_watt` threshold line (637-642) → เฉพาะ `charging`

### Fix A3 — re-query gate ปัจจุบันผูกกับ web success

line 644 `if _device_keywords:` — re-query ทั้งหมดอยู่ใน block `if search_used:`
→ web fail = ไม่ re-query เลย (เดิมก็งั้น — ไม่ regress แต่เสียโอกาส)
non-charging modes ไม่ต้องการ web keywords เลย (query = type token)
→ ย้าย mode-resolve + non-charging re-query ออกมานอก web-success block;
charging path คงอยู่ข้างใน (ต้องการ keywords) — self_compat/model_fit ทำงานได้
แม้ web search ล่ม (improvement เพิ่มเติม ไม่ใช่ regression)

### Fix A4 — `_filter_compat_products` ต้อง type-aware (ตัวการหลัก — critical)

เดิม (verified): ambiguous merge-back เฉพาะ `compat < 2` → ของที่ถามจริง
(ไม่มี connector) **ถูกลบเงียบๆ** เมื่อมีของชาร์จ usb-c ≥2 ตัวปนใน pool
และ compat items ถูก sort ขึ้นก่อน → ชาร์จชนะตำแหน่งบนเสมอ

แก้ — เพิ่ม params `compat_mode` + `asked_type` เข้า `_filter_compat_products`:

- `charging`/`unknown` → **พฤติกรรมเดิมทุกบรรทัด** (regression-safe —
  สำหรับคำถามชาร์จ ambiguous deletion เป็นเจตนาเดิม)
- `model_fit` → **skip filter ทั้งหมด** (compat = ขนาดรุ่น ไม่ใช่ connector —
  retrieval query `case iphone 15` ทำหน้าที่แล้ว)
- `self_compat` → connector evaluate **เฉพาะสินค้าที่ type ตรงกับ asked_type**
  (detect จาก product name): ของที่ type ตรง + connector ผิด → drop
  (หูฟัง lightning ให้ usb-c phone = ถูกต้อง); ที่เหลือทั้งหมดคงลำดับเดิม
  — ของ type อื่นไม่ถูก promote ขึ้นก่อน และของที่ถามไม่ถูกลบ
- `phone` → skip (ไม่มี filter — ถามตัวเครื่อง)

ส่ง `_compat_mode`/`_asked_type` จาก app.py callsite (line ~4340) — compute
ครั้งเดียวแชร์กับ `_device_spec_lookup` (param เดียวกัน)

## Fix B — catalog grounding สำหรับ fallback

สร้าง `shop_capability` line: หมวดที่ร้านขายจริงจาก catalog (NORMAL เท่านั้น)

- **ต้อง per-shop** (30 shops หมวดต่างกัน — KingGadgets 1,079 items vs ThaiSuperPhone 2,384):
  query `shopname=req.shop` → `_detect_product_types` บน NORMAL `item_name` →
  Counter → cache `dict[shop]` (lazy ต่อ shop ~1-3k docs, ms ต่อครั้ง)
- trigger: ลูกค้าถาม type ที่ร้านไม่มี sellable หรือ retrieved products ไม่มี type
  ที่ถามเลย → inject
  `"\nร้านนี้มีสินค้าหมวด: สายชาร์จ, หัวชาร์จ, หูฟัง, powerbank, ... — ถ้าลูกค้าถามหมวดที่ไม่มี ให้บอกตรงๆ และเสนอเฉพาะหมวดที่มีจริง ห้ามเดาหมวดสินค้าเอง"`
- แก้ "มีสมาร์ทโฟน Xiaomi" hallucination ด้วย (LLM เห็นหมวดจริง → ไม่เดาเอง)

## Coverage จริงใน catalog (นับสด 11,691 docs)

taxonomy เต็ม **105 types** · ที่มีสินค้าจริงใน catalog ~40 types ·
typed 10,603 (90.7%) · untyped 1,088 (9.3%)

| mode | types (NORMAL จริง) |
|---|---|
| charging | charger 900, powerbank 221, car_charger 34, wireless_charger 48, desktop_charger+dock (นับรวม charger) |
| model_fit | case 115, screen_protector 30, battery 60, stylus, memory_card 17 |
| self_compat (อัตโนมัติทุก type อื่น) | earphone 325, smartwatch 324, camera 249, vacuum 254, massager 151, fan 148, speaker 76, microphone 73, air_purifier 135, air_filter 109, bag 104, humidifier 33, projector 51, dashcam 26, flash_drive 47, memory_card 17, toothbrush 31, mouse 9, soundbar 18, spray_mop 33, water_purifier 8, car_accessory 29, ... |
| pseudo-type (exclude) | phone 241 — มาจาก "โทรศัพท์/มือถือ" ในชื่อ accessories ไม่ใช่มือถือขายจริง |
| untyped | 1,088 docs — ข้อจำกัด taxonomy เดิม ไม่ใช่ของ fix นี้ |

## ผลกระทบต่อ type อื่น (impact analysis)

| query type | ก่อน | หลัง | ทิศทาง |
|---|---|---|---|
| charger/powerbank/car/wireless | ดึงชาร์จ (ถูก) | **เหมือนเดิมทุกบรรทัด** | neutral — regression-safe |
| earphone BT (325 ตัว) | ดึงชาร์จ 30 → "ไม่มี" | ดึงหูฟังจริง → แนะนำของที่ใช้ได้ | **positive ใหญ่** |
| earphone wired | ดึงชาร์จ | ดึงหูฟัง; lightning ถูก drop ให้ usb-c phone — ถูกต้อง | positive |
| case/film/battery | ดึงชาร์จ (ผิดหมวด แต่ filter กันไว้) | ดึงตามรุ่นเครื่อง | positive |
| smartwatch/speaker/camera/vacuum/massager/... (~30 types) | ดึงชาร์จ | ดึงหมวดจริงด้วย type token | positive |
| compat ไม่มี type ("ของใช้กับ iphone") | ดึงชาร์จ | เหมือนเดิม (คงเดา charging) | neutral |
| query ที่ type='phone' เดี่ยวๆ ("iphone 15 มีไหม") | ดึงชาร์จ (ผิด — ถามตัวเครื่อง) | **skip re-query** → ตอบจาก retrieval เดิม | positive เล็ก |
| fallback "ไม่มีของ" | เดาหมวดเอง (smartphone) | เสนอเฉพาะหมวดจริง | positive |

**negative ที่ต้องระวัง:**

- `self_compat` type-only query อาจดึงของที่ "ใช้กับ device ไม่ได้จริง"
  เช่น หูฟังมีสาย lightning ให้ iPhone 15 — **connector filter จัดการอยู่แล้ว**
  (drop ถูกต้อง); BT ไม่มี connector → ambiguous → kept ถูกต้อง
- `model_fit` query `case iphone 15` อาจพลาดเคสที่เขียน "for iPhone15" (ไม่มี space)
  — fetch_products regex เดิมรองรับอยู่แล้ว (variant matching)
- `_detect_product_types` ขาด type 'ที่วาง/stand', 'micro sd' เดี่ยว — ตก unknown
  → path เดิม (charging guess) — ไม่แย่กว่าเดิม แต่ไม่ดีขึ้น (รับได้)
- **3.5mm jack edge:** connector extractor ไม่รู้จัก 3.5mm → หูฟังมีสาย 3.5mm
  → ambiguous → kept → อาจแนะนำให้ iPhone 15 (ไม่มี jack) — edge เดิมมีอยู่แล้ว
  เพิ่ม '3.5mm' เข้า extractor เป็น task แยกได้ (กระทบ filter semantics กว้าง)
- **proprietary connector device (apple watch):** charging mode + connector
  'proprietary' → filter drop หมด → ambiguous กลับ → LLM อาจเสนอชาร์จที่เสียบ
  ไม่ได้ — เดิมก็เป็น; guard เพิ่มได้: connector ∉ {usb-c,lightning,micro-usb,usb-a}
  → ไม่ re-query ชาร์จ (task เสริม เล็ก)
- **intent misclassify type** (หายาก): "สายชาร์จ" โดน tag earphone → ดึงหูฟัง
  แทนสาย — mitigate: prefer detect(msg) เมื่อมี type word literal ในข้อความ
- **`_device_spec_lookup` มี 2 callsites** (line 2006 KB path + 4314 main) —
  fix ในฟังก์ชันเดียวครอบทั้งคู่อัตโนมัติ (KB path ได้ประโยชน์ด้วย)

## Tasks

1. `_compat_mode(product_type) -> str` — type source: intent (∈taxonomy,≠other)
   → detect(msg) → unknown; sets `_CHARGING_TYPES`/`_MODEL_FIT_TYPES`/`_SKIP_TYPES`;
   multi-detect → priority charging > model_fit > self_compat; 'phone' → skip
2. **A4 filter type-aware (แก้ก่อน — ตัวการหลัก)** — `_filter_compat_products`
   เพิ่ม `compat_mode`+`asked_type`: charging/unknown=เดิม; model_fit/phone=skip;
   self_compat=drop เฉพาะ asked-type ที่ connector ผิด ที่เหลือคงลำดับ
3. re-query branch ใน `_device_spec_lookup` — charging/unknown คง path เดิมเป๊ะ
   (regression-safe); model_fit → `f"{type} {device}"`; self_compat → `f"{type}"`
   (type token เป็น query ได้เลยเพราะ fetch_products detect→type_regex เอง) +
   ปิด watt sort (min_watt=None); non-charging ย้ายออกนอก web-success block (A3)
4. spec-extra prompt gate ตาม mode (A2) — charging/unknown=text เดิม;
   model_fit/self_compat=text ใหม่ห้ามพูด wattage; catalog spec line คงทุก mode;
   min_watt threshold → เฉพาะ charging
5. `shop_capability_line()` ใน product_store — per-shop count types + cache dict
6. inject capability line เมื่อ retrieved ไม่ตรง type ที่ถาม (app.py จุดเดียว)
7. tests: earphone compat (หูฟังต้องไม่ถูก filter ลบ + prompt ไม่มี ≥W),
   case compat, phone skip, regression charger ทั้งหมด (subtype parity/anchor/car)

## ไม่ทำ (scope guard)

- `_filter_compat_products` — แตะเฉพาะ branch ตาม mode (A4); path charging เดิมเป๊ะ
- ไม่เพิ่ม product_type ใหม่ให้ taxonomy (เช่น stand/micro-sd/3.5mm connector) — งานคนละชิ้น
- ไม่แก้ web-search spec lookup — spec ยังถูกต้อง/จำเป็นสำหรับทุก mode
- ไม่แตะ ambiguous-deletion rule ของ charging path — เป็นเจตนาเดิม (narrowing)

---

## Implementation status (2026-09-18) — ✅ done + verified

**ทำครบทุก task + เจอชั้นที่ 4 ที่ plan ไม่เห็น (web_search.reanswer):**

| Task | สถานะ | หมายเหตุ |
|---|---|---|
| 1 `_compat_mode` | ✅ | detect∪intent union → priority mode pick (แก้เคส stylus/stationery conflict ด้วย union แทน detect-first) |
| 2 A4 filter | ✅ | mode params + 3 branch; charging/unknown เดิมเป๊ะ |
| 3 A1 re-query | ✅ | **เปลี่ยน design:** ใช้ `_type_query_word` (canonical Thai kw) แทน raw token + `product_types_override` hard-scope — token อังกฤษ detect ผิดเพี้ยนและดึงโทรศัพท์ |
| 4 A2 prompt gate | ✅ | mode lines ไม่มี wattage; charging เดิม |
| 5 B capability | ✅ | `_shop_type_counts` per-shop cache + inject เมื่อของถามไม่อยู่ context |
| **+C (ใหม่)** | ✅ | `web_search.reanswer` — layer ที่ 3 ที่ทำลาย context: token→Thai kw + override + `_final_products` replace→union |

**Verify:** test_compat_mode_filter 36/36 · car_charger_regression 16/16 ·
E2E 4 mode (earphone/charger/case/phone-skip) ผ่านทั้งหมดบน server :8010

---

## Phase 2 — E2E batch 12 เคส: เคสที่แย่ + แพลนแก้ (2026-09-18, แก้ไขหลังอ่านผลละเอียด)

### อ่านผลจริงทีละเคส (ไม่ใช่แค่ verdict)

| # | เคส | สิ่งที่เจอจริงจากคำตอบเต็ม | ระดับ |
|---|---|---|---|
| BUG-A | c3 `พาวเวอร์แบงค์+macbook` (CukTech) | ตอบ "ยังไม่มีสินค้าประเภทพาวเวอร์แบงค์" — **ผิดชัด**: c7 เดียวกันเจอ PB060/ZMI P17/QPB60 ในร้านเดียวกัน → พิสูจน์ว่า re-query เชื่อ extractor "charger" ทับ asked type | 🔴 wrong answer |
| BUG-B | c4 `ฟิล์มจอ iphone 16` (KG) | แก้แล้ว — ตอบเจาะจง "ไม่มีฟิล์ม" + เสนอเคส (KG มีเคสจริง) | ✅ fixed |
| BUG-D | c1 `ลำโพง+s24` (Kieslect) | "ลำโพงอาจจะหมดชั่วคราว" — ร้านไม่เคยขายลำโพงเลย แต่ LLM เขียนเหมือนของหมดชั่วคราว (politeness softening ของ "ไม่มี") | 🟡 hedge |
| OBS-1 | c1 เดิม (แก้การตีความ) | ~~"หูฟังไร้สาย" = hallucination~~ → **จริง = grounded**: Kieslect มี `NotePods 10S หูฟัง AI` NORMAL 1 ตัว — capability line ทำงานถูก (ระบุ earphone → LLM pivot หมวดจริง) ปมที่เหลือ: card หูฟังไม่ได้อยู่ใน pool ที่แสดง | ✅ working |
| OBS-2 | c5 `หัวชาร์จในรถ+s25u` | คำตอบถูก (CC903P มีจริงในร้าน 90W ตรง spec) แต่ **pool เรียงผิด**: card #1-3 = wall charger 30W/65W, ที่ชาร์จรถจริง WCJ153 อยู่ #4 — subtype "ในรถ" ไม่ชนะ generic charger ในการจัดอันดับ | 🟡 ranking |
| OBS-3 | c5 latency | 36.3s (เฉลี่ย ~8s) — web spec search + JSON retry | 🟡 cost |
| OBS-4 | c7 `powerbank≤1000฿` | pool มี BF01 พัดลม rank #2 (noise path ปกติ ไม่ใช่ compat) — คำตอบไม่กระทบ (แนะนำ ZMI P17 จริง) | 🟡 noise |
| OBS-5 | c8/c9 | c8 ตอบถูกตัดกลาง tag = artifact ของ harness (ตัด 280 ตัวอักษร) ไม่ใช่ bug · c9 แนะนำ K9 (รุ่นจริง) แต่ card top4 = K3 — ตระกูลเดียวกับ OBS-2 | ⚪ artifact |

**ผ่านสะอาด:** c2 smartwatch+iphone16, c6 claim flow, c10 lightning, c11 shipping, c12 projector

### แพลนแก้ (เรียงตาม value/risk)

**P1 — BUG-A: asked-type scope ใน charging re-query** ✅ **DONE 2026-09-17** — `_charging_scope()` + `_CHARGER_FORMS` ใน device_compat.py; ผ่าน scope matrix 8/8 + compat 45/45 + car_charger 16/16 + E2E: #109 ตอบ PB100S จริง, หัวชาร์จในรถ → CC903P car charger จริง (OBS-2 ดีขึ้นด้วย)

- หลักการ: **ใช้ type ที่ detect ได้ตรงๆ เหมือน non-charging** แต่กรองให้อยู่ใน class เดียวกับงาน — `∩ _CHARGING_TYPES` กัน type อื่นจาก compound phrase (เคส/phone) ปนเข้า connector-filtered pool; `_CHARGER_FORMS` ลบ substring artifact ('charger' ใน "หัวชาร์จในรถ"); type ใหม่ในอนาคต (เช่น vacuum) ทำงานอัตโนมัติผ่าน self_compat `{_asked_type}` ไม่ต้องแตะโค้ด

```python
_CHARGER_FORMS = {"car_charger", "wireless_charger", "desktop_charger", "dock"}
_chg_scope = _detect(req.message) & _CHARGING_TYPES
if 'charger' in _chg_scope and (_chg_scope & _CHARGER_FORMS):
    _chg_scope.discard('charger')          # subtype เจาะจงชนะ hypernym
if not _chg_scope and _asked_type:          # "อันนี้ใช้ไหม" + intent=powerbank
    _chg_scope = {_asked_type}
fetch_products(..., product_types_override=_chg_scope or None)
```

- **drop เฉพาะเมื่อเหลือ charger-form** — "ชุดชาร์จและพาวเวอร์แบงค์" → {charger,powerbank} ครบทั้งคู่ (powerbank ไม่ใช่ charger-form → ไม่ drop)
- ผลกระทบทีละเคส:
  - `สายชาร์จ/หัวชาร์จ + device` → {charger} = **เดิมเป๊ะ** (keywords detect charger อยู่แล้ว)
  - `powerbank + device` → {powerbank} = **แก้ BUG-A**
  - `หัวชาร์จในรถ` → {car_charger} = แม่นกว่าเดิม + แก้ OBS-2 ranking ในแก้เดียว
  - `ที่ชาร์จไร้สาย` → {wireless_charger} = แม่นกว่าเดิม
  - `พาวเวอร์แบงค์และที่ชาร์จในรถ` → {powerbank,car_charger} = ครบทั้งคู่
  - `สายชาร์จในรถ` → {car_charger} = edge ยอมรับ (ลูกค้าอาจหมายถึง cable ใช้ในรถ — แต่ car charger มีสายในตัวอยู่แล้ว + main pool ยัง cover)
  - `อันนี้ใช้กับ iphone ไหม` (anchor=powerbank, ไม่มี literal type) → detect ว่าง → fallback {_asked_type} = ดีกว่าเดิม (เดิมเชื่อ extractor)
  - unknown mode → ไม่ส่ง override = **เดิมเป๊ะทุกบรรทัด**
- hardcode เพิ่ม: `_CHARGER_FORMS` 4 tokens (category semantics — type ใหม่ที่เป็น charger-form แต่ไม่อยู่ใน set → แค่ไม่ drop charger → เดิมเป๊ะ degrade-safe)
- scope แคบเกินก็ไม่พัง: re-query คืน 0 → main pool ยัง cover (graceful)
- verify: unit scope matrix 8 เคส · c3 integration ต้องได้ powerbank (PB060/WPB100) · c5 pool top=car charger · compat 36/36 + car_charger 16/16 ต้องไม่พัง · E2E c3 ซ้ำต้องเห็น powerbank จริง
- นี่คือ **ช่องสุดท้ายของ wrong-category bug class**

**P2 — BUG-D hedge wording** (defer — low harm)

- "ไม่มีหมวด X" ถูก LLM soften เป็น "อาจจะหมดชั่วคราว" — ทำให้ฟังเหมือนเคยขาย
- ทางเลือก: เขียน capability line ชัดขึ้น "ไม่ใช่หมวดที่ร้านจำหน่าย" — แต่ LLM อาจ soften อยู่ดี → **defer** รอเคสจริง

**P3 — OBS-3 web retry ซ้ำ** — แยก ticket (pre-existing ไม่เกี่ยว compat)

**P4 — ยอมรับไว้ (ไม่แก้ phase นี้):** untyped docs 9.3% · detect+intent พลาดทั้งคู่ · capability-mention ไม่มี card (คิดจะใส่ sample item ต่อหมวด → noise เสี่ยงกว่าคุ้ม defer)

### หลักการคงไว้ทั้ง phase

- ไม่มี hardcode เพิ่ม — ทุก scope derive จาก `_detect_product_types` + taxonomy + catalog
- charging/unknown path ที่ไม่เกี่ยว = เดิมเป๊ะ
- type ใหม่ใน taxonomy → อัตโนมัติ self_compat → ตอบได้ทันที
- verify ต่อ task: 36/36 + 16/16 + E2E เคส c3 ซ้ำ + สเปรดเช็ก car_charger/wireless_charger/multi-type บน DB

---

## Phase 3 — P1b: unit-index pool + spec-db generic (2026-09-17)

### อาการ

หลัง P1 — #109 ตอบ powerbank จริงแล้ว แต่เลือก **PB100S 30W** ทั้งที่ร้านมี 90-210W
(user review: "ทำไมเป็นตัว 30W ทั้งที่มี 120/140/210W")

### Root cause (2 ชั้นซ้อน — debug จาก log+DB ไม่ใช่เดา)

**① หลัก — unit index pool เล็กทับ legacy pool:**
- `fetch_products` มี guard `if is_compat_check: _uif=""` (ข้าม unit index เพราะ
  pool เล็ก vector top-50 — comment ในโค้ดเตือนเอง "ของที่ spec สูงพอไม่เคยเข้า context")
- main compat path ส่ง `is_compat_check=True` (app.py:3612) แต่ **re-query ใน
  `_device_spec_lookup` ไม่ได้ส่ง** → synthetic query "charger MacBook..."
  ผ่าน charger gate → `fetch_unit_cards` คืน **5 ตัว** (PB100S 33W, P02ZM 0W)
  → early-return → legacy 30 docs (มี PB200P 150W, P23 210W) ไม่เคยถูกใช้
- verify ตรง: env เดียวกัน USE_UNIT_INDEX=charger → n=5 low-watt;
  ไม่มี env → n=30 ครบ high-watt

**② รอง — spec-db ไม่มี "macbook" ลอย + web parse เพี้ยน:**
- spec-db มีเฉพาะ `macbook air m1-m4`/`pro 13-16` → "macbook" lookup=None
- fallback web-parse `min_watt = max(watt_matches)` → ดูด **240W** จาก text
  (spec สายชาร์จ) → sort ใช้ 70W (parse แรก) แต่ compat-filter เห็น 240W
  (parse สอง) — inconsistent สอง parse คนละตัว

### แก้ (implement แล้ว — แพลนนี้เขียนย้อนหลังตามกฎ)

| fix | เนื้อหา | ขนาด |
|---|---|---|
| 1 | `is_compat_check=True` ใน re-query **ทั้ง 2 จุด** (charging ~L829, non-charging ~L700) — semantic เดียวกับ main path | 1 param ×2 |
| 2 | spec-db generic entries: `"macbook"`(70W) `"macbook air"`(70W) `"macbook pro"`(96W) — spec-db hit → min_watt consistent ทั้ง sort+filter ไม่ต้อง web parse | +12 บรรทัด data |

### ผลกระทบทีละเคส

| เคส | ก่อน | หลัง |
|---|---|---|
| powerbank+macbook | unit pool 5 ตัว 33W → ตอบ 30W | legacy 64 docs → adequate-first ≥70W → PB200P/P23/BA652U ขึ้นหัว |
| สายชาร์จ/หัวชาร์จ compat | unit path ทำงานปกติ (pool ใหญ่พอ) | **เดิมเป๊ะ** — is_compat_check เพิ่ม sweep เท่านั้น |
| non-charging re-query | flag=charger: gate ปิดอยู่แล้ว = เดิมเป๊ะ; flag=1: เดิมมี bug แฝงเดียวกัน → กันไว้ล่วงหน้า | superset pool |
| "macbook air m2" | hit specific 70W | เดิมเป๊ะ (longest-match ชนะ) |
| "macbook pro 16" | hit specific 140W | เดิมเป๊ะ |
| device ไม่มีใน spec-db | web parse เดิม | เดิมเป๊ะ (ยัง parse max — จดไว้) |

- น่าจะดีขึ้น: สูง — mechanism เดียวกับ main compat path ที่ใช้งานอยู่แล้ว
- น่าจะแย่ลง: ต่ำ — pool เป็น superset, sort/filter ปลายทางเดิม
- hardcode เพิ่ม: 3 spec entries (curated data — pattern เดิมของ catalog 140 entries)
- ยังไม่แก้: web-parse `max()` fragile (เคสอื่นนอก spec-db ยังเสี่ยง) — defer รอหลักฐานเพิ่ม

### verify

- [x] `_lookup_spec_db` matrix: generic hit + specific ชนะ + device อื่นเดิม
- [x] fetch_products(env=charger, is_compat_check=True, scope={powerbank}) → n=64, sort top = 120/150/210W
- [ ] restart + E2E #109 → ต้องแนะนำ ≥70W (คาด PB200P 150W/P23 210W)
- [ ] compat 45/45 + car_charger 16/16 ไม่พัง
- [ ] E2E สายชาร์จ/หัวชาร์จในรถ regression

---

## Phase 4 — P2: structured device_specs จาก web search (2026-09-17)

### อาการ / root cause

`_resolve_device_spec` ดึง spec จาก `search_info` **prose** ด้วย regex —
`min_watt = max(\d+W)` เอาเลขสูงสุดใน text ทั้งก้อน → แยก spec ของ device
กับ spec อุปกรณ์เสริมไม่ได้ → "สายชาร์จ 240W" หลุดเป็น min_watt ของ macbook
(parse 2 จุดยังได้คนละค่า: sort 70W / filter 240W — inconsistent)

### แก้ (root fix — LLM semantic extraction แทน regex; user-approved)

extraction call เป็น LLM structured JSON อยู่แล้ว → ขยาย schema ให้ส่ง
spec ของ **target device** เป็น list ตรงๆ ไม่ต้อง parse prose

| # | จุด | เนื้อหา |
|---|---|---|
| 1 | `web_search.search_and_extract` | prompt + field `device_specs: [{device, connector, max_watt, protocols}]` — บังคับ "เฉพาะที่พบใน results เท่านั้น ห้ามเดา", device เป้าหมายเท่านั้นไม่ใช่อุปกรณ์เสริม, multi-variant ใส่หลาย entry; parse tolerant (str→num coerce, ตัด entry เสีย) → return `device_specs: []` เสมอ |
| 2 | `device_compat._web_spec_to_dict` | normalize list → `{connector, min_watt=max(watts), protocols, source="web-structured"}` — max = ครอบทุกรุ่นย่อย (semantic "spec ceiling" ของ device) |
| 3 | `_resolve_device_spec(..., web_specs=None)` | chain: **spec-db → web-structured → prose regex (last resort)** — regex เก็บไว้เป็น fallback เมื่อ LLM ไม่ส่ง field |
| 4 | `_device_spec_lookup` | return 3-tuple `(extra, products, device_specs)`; ส่ง web_specs เข้า `_resolve_device_spec` ตอนหา `_dev_min_watt` |
| 5 | `_filter_compat_products(..., web_specs=None)` | รับ structured pass ต่อ resolver |
| 6 | app.py | 2 call sites unpack 3-tuple; main path ส่ง `web_specs` เข้า filter |

### ผลกระทบทีละจุด (ก่อนลงมือ — ตามกฎ)

| จุด | ผลกระทบ | ความเสี่ยง |
|---|---|---|
| `search_and_extract` return +key | callers อื่น (reanswer:615, chat_v2:1195) ignore key ใหม่ได้ | ต่ำ — additive |
| `_device_spec_lookup` 2→3 tuple | callers: app.py:2051, app.py:4359, test ×3 | ต่ำ — อัปเดตครบ |
| `_filter_compat_products`/`_resolve_device_spec` +param=None | tests เดิม positional/keyword — default None = พฤติกรรมเดิมเป๊ะ | ต่ำ — backward compatible |
| prompt ใหญ่ขึ้น ~15 บรรทัด | token +~200/call — call นี้ถูกเรียกเฉพาะ compat lookup | ต่ำ |
| device_specs ว่าง/ไม่มี (model ไม่ส่ง field) | chain ตกไป prose regex เดิม — พฤติกรรมเดิมเป๊ะ | ไม่มี regression |
| type/subtype อื่น (charger/cable/car_charger/model_fit/self_compat) | ไม่แตะ flow — structured spec ใช้เฉพาะ resolve | ไม่มี |
| hardcode | ไม่มี — connector vocab เดิม, threshold=max เป็น generic rule | — |

### กฎที่ตัดสินใจ

- **min_watt = max** ของ entries — semantic "spec ceiling" ของ device family:
  สินค้าที่ ≥max ใช้ได้กับทุกรุ่นย่อย; ถ้าร้านไม่มีตัวถึง → ทุกตัวตกกลุ่ม
  below-spec เหมือนเดิม ไม่เสียอะไร (เป็น ranking hint ไม่ใช่ hard filter)
- **entry match** = normalized substring overlap ทั้งสองทาง
  ("macbook" ⊂ "macbook air" ✓) — generic ไม่มี list ชื่อรุ่น
- **connector** = ตัวแรกที่เจอ (LLM ควรให้ตรงกัน; ถ้าต่างกันเอา mode — ไม่เดา)
- **spec-db ยังชนะเสมอ** — curated > extracted (LLM เดาได้ ข้อมูล catalog ไม่เดา)

### verify checklist

- [ ] TDD: structured ชนะ prose (prose 240W cable / structured 140W → 140)
- [ ] spec-db ชนะ structured เมื่อ device มีใน db
- [ ] malformed/empty → fallback เดิม ไม่ crash
- [ ] multi-variant → min_watt=max
- [ ] compat 45/45 + car_charger 16/16 ไม่พัง
- [ ] E2E #109 + device นอก db

---

## Phase 5 — P3: spec source ladder — web search เป็นด่านสุดท้าย (2026-09-18)

### Root cause

`_device_spec_lookup` ยิง web search **ทุก compat query** (~6k tokens/call)
แม้ device อยู่ใน spec-db หรือ catalog บอก compat เองอยู่แล้ว — เสียเงินโดยไม่จำเป็น
+ prose `max(\d+W)` ดูดเลขอุปกรณ์เสริม (สาย 240W) มาเป็น spec เครื่อง

### แก้ — ladder (user-proposed, อนุมัติแล้ว)

```
spec-db (ฟรี, curated) → catalog evidence (ฟรี — description สินค้า
ประกาศ compat เอง) → intent (ฟรี — LLM guess ไม่ grounded) → web (จ่าย — rare)
```

| # | เปลี่ยน | เนื้อหา |
|---|---|---|
| 1 | `_device_spec_lookup` charging branch restructure | re-query ก่อนเสมอ (keywords derive เอง: type word + device + connector synonyms + subtype kw — ไม่พึ่ง web keywords); web ยิงเฉพาะเมื่อ `ไม่มี _db_spec และ ไม่มี _catalog_hit` |
| 2 | `_device_mentioned(device, products)` helper | normalized substring (lower, ลบ space/dash) — device ปรากฏใน name/desc สินค้า = declared compat |
| 3 | `_CONN_QUERY_KW` | connector→synonyms vocab map (data — pattern เดียวกับ _extract_connectors) |
| 4 | `_resolve_device_spec` prose step | **ลบ watt_matches ทิ้ง** — prose เหลือ connector เท่านั้น (ฆ่า 240W-class ถาวร; เลขเชื่อได้เฉพาะจาก spec-db/web-structured/intent) |
| 5 | `_dev_min_watt` chain | spec-db → web-structured → intent (consistent ทั้ง lookup+filter — ข้อมูลจริง > ความจำ) |
| 6 | dual-tier instruction | ย้ายออกจาก web-block → append เสมอใน charging mode |

### ผลกระทบ

- spec-db devices (iphone/samsung/macbook/…~140 entries = compat ส่วนใหญ่): **web 0 ครั้ง** — ประหยัด ~6k tokens/เคส
- device ไม่รู้จัก + catalog มีของระบุชื่อ → ไม่ web; catalog ไม่มี + intent ว่าง → web (rare)
- intent-only → **ยัง web** (guess ไม่ grounded — correctness > cost)
- min_watt หายไปเมื่อไม่มี structured source → sort เป็น asc ธรรมดา + LLM อ่าน prose เอง — ปลอดภัยกว่าเลขผิด
- type/subtype อื่น: ไม่แตะ non-charging path เลย; hardcode ไม่มี (vocab map = data เดิม)

### verify

- [ ] spec-db hit → web ไม่ถูกเรียก + extra มี spec-db line + re-query ได้ของ
- [ ] catalog hit (device นอก db แต่สินค้าระบุชื่อ) → ไม่ web
- [ ] ไม่มีอะไรเลย → web ถูกเรียก
- [ ] prose เหลือ connector เท่านั้น (240W ไม่กลายเป็น min_watt อีก)
- [ ] compat suite + car_charger ผ่าน

---

## Phase 5 — Spec source ladder (web = ด่านสุดท้าย) — 2026-10-02

### Problem
- ทุก compat query ยิง web search ~6K tok/call (~$0.01) แม้ device อยู่ใน spec-db — web ถูกเรียกตั้งแต่แรกก่อนเช็ก db
- prose watt parse `max(\d+W)` ดูดเลขของ accessory (240W สายชาร์จ) มาเป็น device spec
- re-query พึ่ง web keywords — web fail → pool ว่าง → ตอบผิดหมวด

### Design (generic ทุก type/subtype — ไม่มี hardcode keyword)
source ladder:
1. spec-db (local, deterministic, free)
2. catalog evidence — สินค้าใน scope ที่ name/desc ระบุชื่อ target_device ตรง (declared compat — ไม่ infer จาก watt)
3. intent fields — LLM guess (grounding ต่ำสุด — ไม่นับเป็น evidence สำหรับตัด web)
4. web search — เฉพาะเมื่อ 1-2 ไม่มีหลักฐาน (rare path)

### Changes
- `device_compat.py`:
  - `_device_mentioned(device, products)` — substring match บน name/description_excerpt (device ≥4 chars)
  - `_CONN_QUERY_KW` — connector→query synonyms map (generic เดียวกับ _extract_connectors)
  - `_device_spec_lookup` re-order: db → derived-keyword re-query → catalog evidence → (conditional) web → intent
  - min_watt chain consistent ทั้ง lookup+filter: spec-db → web-structured → intent
  - `_resolve_device_spec`: ลบ prose watt parse — เหลือ connector vocab parse เท่านั้น (ตัวเลขจาก prose ไม่ trusted)
- web block ทั้งก้อน → conditional `not (db_hit or catalog_hit) and is_configured()`
- re-query keywords derive เอง: type word + device + connector synonyms (ไม่พึ่ง web keywords)
- `web_search.py` (Phase 4 ที่ทำแล้ว) — เก็บเป็น rare-path fallback

### Blast radius
- `_resolve_device_spec` ใช้ใน `_filter_compat_products` ด้วย → prose watt หายจากทั้ง 2 path (จงใจ)
- callers อื่นของ lookup: app.py 2 จุด (signature เดิม 3-tuple ไม่เปลี่ยน)
- non-compat paths ไม่แตะ

## Phase 6 — spec-db coverage ~10 ปี + outer-search gate — 2026-10-02

### เพิ่ม
- `DEVICE_SPECS` 249 → 516 entries: มือถือเก่า 2016-2019 ทุกแบรนด์, หูฟัง (AirPods/Buds/WF-WH/FreeBuds/Enco/JBL/Bose/Beats/Marshall), แท็บเล็ตนอก Apple/Samsung, Windows laptops (Dell/HP/Lenovo/Asus/Acer/MSI/Surface), wearables/gadgets, generic entries (iphone/ipad/notebook)
- shared templates `_T_*` — สเปคเดียวกันใช้ dict ชุดเดียว
- `should_use_web_search` gate: `target_device` grounded ใน spec-db → ข้าม `compatibility_check_device_specific`/`short_answer` (ประหยัด ~6K tok/compat call)

### verify
- test_compat_mode_filter 144/144 · car_charger 16/16 · guards 27+4+7+10 · E2E redmi note 9/macbook/notebook = 0 web call

### ค้าง (เหมือนเดิม)
- unit-index field-filter sweep สำหรับ compat — ยังไม่ implement
