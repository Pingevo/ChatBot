# Plan v2: Retrieval / Ranking / Structure — แก้ที่โครง ไม่ใช่ที่เคส (2026-09-21)

สถานะ: **รออนุมัติ**
v1 ถูกถอน — เหตุผลอยู่ท้ายไฟล์ (§9) เพื่อไม่ให้ทำผิดซ้ำ

## 0. ขอบเขตที่ผู้ใช้ตัดสินแล้ว (2026-09-21)

- **focus legacy เท่านั้น** — legacy คือ production จริง (`USE_LEGACY_CHAT` default `1`; 300Q รันออกมา `chat_engine=legacy` ทั้งหมด)
- **v2/v3 พังได้ ไม่ต้อง verify** — `chat_v2.py` / `chatbotv3` เรียก `product_store._detect_*` / `fetch_products` ตรงๆ; เมื่อลบ regex ที่ต้นทาง v2/v3 อาจพัง → **ยอมรับ** (ทาง C) → ไม่ต้องทำโค้ดซ้อนเพื่อเลี้ยง v2/v3
- **ไม่ตัด unit path** แต่ตัด **pipeline ที่สอง**:
  - เก็บ: unit **data** (variant-level + tag + KB spec + OCR + live join) และ enrichment (`attach_kb_specs` / `attach_image_texts` / `attach_listing_fields` / `to_unit_card`)
  - ลบ: unit **pipeline** (vector/rank/dedupe/fallback ของตัวเอง + `return _ucards` early) และ `is_compat_check` bypass
- ปลายทาง = **หนึ่ง pipeline สองแหล่งข้อมูล**: legacy pipeline เดียว เลือกอ่าน unit docs (ถ้ามี) หรือ listing docs, กรองด้วย field, dedupe ด้วย id, rank ด้วยฟังก์ชันเดียว

---

## 1. หลักการตัดสินใจ (ใช้ตัดข้อเสนอที่ไม่เข้าเกณฑ์)

ข้อเสนอจะรับเฉพาะที่ผ่านทั้ง 3 ข้อ:

1. **ลดจำนวนที่ที่ต้องแก้** เมื่อมีสินค้า/ประเภท/subtype ใหม่ — ถ้าคำตอบคือ "เพิ่ม if" = ปฏิเสธ
2. **โค้ดโดยรวมไม่เพิ่ม** (เป้า: ลด) — ถ้าเพิ่มชั้นเพื่อกลบข้อมูลไม่ครบ = ปฏิเสธ
3. **พิสูจน์ได้ด้วย replay/eval** ว่าไม่พังของเดิม — ถ้าพิสูจน์ไม่ได้ = ยังไม่ทำ

**กฎเหล็กของงานนี้:**
> ตอน query **ห้ามอ่านชื่อสินค้าเพื่อตัดสินว่าเป็นประเภทอะไร**
> query แปลได้แค่ *คำของลูกค้า → type label*; ประเภทของสินค้าอ่านจาก **field ใน data** เท่านั้น
> ของใหม่ = เพิ่ม tag ใน data + คำใน vocabulary — ไม่ใช่เพิ่มเงื่อนไขในโค้ด

---

## 2. Root cause (โครงสร้าง — ตัวที่ผลิตอาการซ้ำไม่จบ)

### R1 — "สินค้านี้ประเภทอะไร" มีคำตอบ 2 แหล่ง ⚠️ ตัวใหญ่สุด
- build-time: `scripts/unit_classifier.py` → เขียน `product_type` / `charger_subtype` ลง unit doc
- query-time: `product_store._detect_product_types` + `_detect_product_types_fuzzy` + `_detect_charger_subtype` + `_filter_charger_subtype` + `_filter_false_positives` ≈ **600+ บรรทัด regex อ่าน `item_name`**

สองแหล่งขัดกันได้ตลอดเวลา และแหล่งที่ 2 แก้ไม่จบ เพราะชื่อสินค้าจริงไม่มีไวยากรณ์ → ทุกเคสใหม่ = patch เพิ่ม (ปัจจุบัน ~20 จุด)
**นี่คือต้นตอของ "hardcode ไม่จบ" ที่ถามถึง** — ไม่ใช่ similarity, ไม่ใช่ limit

### R2 — identity ของสินค้าใช้ "ชื่อ" ไม่ใช่ id
`_dedupe_products` / `_dedupe_base_name` / false-positive guard ทั้งชุด ตัดสินจาก `name`
unit card ใช้ `display_name = "<listing> — <model_name>"` → dedupe ไม่เคยยุบ (วัดแล้ว q174: 10→10)
**ผล: 49% ของ unit-path pool มี unit ≥3 ตัวจาก listing เดียวกัน; unique-listing ratio 0.72**
→ นี่คือสาเหตุจริงของ "MacBook เจอแต่ 55W ซ้ำ 5 ตัว" (ไม่ใช่ threshold เพียงลำพัง)

### R3 — retrieval กับ selection พันกัน / มี 2 engine ทำงานทับกัน
`fetch_products` เลือกทางใดทางหนึ่งแล้ว return (`product_store.py:2928`) → unit path ข้าม selection ทั้งชุด; legacy ไม่ได้ข้อมูล variant-level
similarity ถูกใช้เป็น **ประตูคัดเข้า** (`units.py:98` `sim>0.3`) ทั้งที่ตอบได้แค่ "text คล้าย"

### R4 — ranking กระจาย 5 ที่ ไม่มีใครเป็นเจ้าของอันดับสุดท้าย
`units.fetch_units:174` · `units.fetch_unit_cards:454` · `product_store._rerank_by_promo_latest/_rerank_with_diversity` · `app.py` superlative sort (~3660) · `device_compat._filter_compat_products` watt sort

### R5 — data tag ไม่ครบ + snapshot ไม่มีรอบ rebuild
`product_type=None` (เช่น KG ~218 units), `charger_subtype=car_charger` แค่ 8 units (มีปั๊มลม mis-tag)
→ ถ้าไม่แก้ตรงนี้ จะถูกบังคับให้เขียน "ชั้นชดเชย" ในโค้ด (= v1 ของผมพลาดตรงนี้)

### R6 — `chat()` เป็นฟังก์ชันเดียว 4,084 บรรทัด / 418 if-block / 33 จุด return
ทำให้ทุกการแก้มี blast radius ไม่รู้ขอบเขต และเป็นเหตุผลว่าทำไม patch สะสมง่ายกว่าแก้โครง

### R7 — policy ราคารั่ว
`llm.py:1013-1018` ตัด `price` ชั้นบน แต่ `variants` ติดไปพร้อม `variants[].price` (`product_store.py:658`, `units.py:304`)

---

## 3. ทิศทางแก้ (เทียบกับ v1 — เน้นว่า "ลบ" มากกว่า "เพิ่ม")

| root | v1 (ถอน) | v2 |
|---|---|---|
| R1 | ส่ง unit pool เข้า `_filter_false_positives` (= ต่ออายุ regex) | **ลบ name-inspection ที่ query-time** เหลือ vocabulary map (คำลูกค้า → label) + กรองด้วย field |
| R2 | เพิ่ม quota layer | dedupe/diversity ใช้ `item_id`/`model_id` เป็น identity (ลบการพึ่งชื่อ) |
| R3 | union 3 ขา + merge + tie-break | **กฎเดียว**: route มี structured signal → structured query เป็น candidate set; ไม่มี → vector เป็น candidate set; similarity เป็น *score* ไม่ใช่ประตู |
| R4 | เพิ่ม unified key (แต่ของเดิมยังอยู่) | รวมเป็น **rank function เดียว** แล้ว *ลบ* sort ที่ซ้ำ |
| R5 | ใช้โค้ดชดเชย tag ที่ไม่ครบ | แก้ที่ data + วัด coverage ก่อนเปิดใช้ structured path |
| R6 | ไม่แตะ | แยกตามรอยต่อ ทีละรอย พิสูจน์ด้วย golden replay |

หลังทำครบ **units.py + product_store.py ควรสั้นลง** ไม่ใช่ยาวขึ้น

---

## 4. เฟสงาน

### A. Golden replay harness (ไม่เปลี่ยน behavior) — ต้องทำก่อนทุกอย่าง
มี corpus อยู่แล้ว (`unit_reg_corpus.jsonl` 300Q, convs 50) แต่ยังไม่มีตัวเทียบผลแบบ deterministic
- แยกชั้นวัดเป็น 2 ระดับ: **(a) retrieval-level** (ไม่เรียก LLM → เทียบได้เป๊ะ, เร็ว, ไม่ติด quota) และ **(b) answer-level** (เรียก LLM — ใช้เฉพาะตอน gate ปล่อยจริง)
- metric retrieval-level: `listing_diversity`, `type_purity`, `live_ratio@k`, `adequacy@1` (compat), `recall@k`, latency
- เก็บ baseline ลง `docs/test/results/` — ทุกเฟสถัดไปต้องเทียบกับไฟล์นี้
- **เหตุผลที่จำเป็น:** เฟส B/E เป็นการ *ลบโค้ด* — ลบได้อย่างมั่นใจต่อเมื่อพิสูจน์ได้ว่า output เท่าเดิม

### B. ยุบ classification ให้เหลือแหล่งเดียว (แก้ R1) — งานหลักของแผนนี้
1. **shadow compare ก่อนลบ** (ไม่เปลี่ยน behavior): ในเส้นทางเดิม log เทียบ `product_type` ที่ regex เดาได้ vs field ใน data ของสินค้าเดียวกัน → ได้ "รายการที่ไม่ตรง" เป็นข้อมูลจริง ไม่ใช่การเดา
2. รายการไม่ตรง → **แก้ที่ data/classifier** (เฟส D) ไม่ใช่แก้ regex
3. เมื่อ disagreement ต่ำกว่าเกณฑ์ → **ลบ** `_filter_false_positives` / `_filter_charger_subtype` / `_detect_product_types_fuzzy` ออกจากเส้นทาง แล้วกรองด้วย field
4. เหลือไว้เฉพาะ **vocabulary map**: คำ/typo ของลูกค้า → type label (คนละเรื่องกับอ่านชื่อสินค้า) — จุดนี้ควรเป็น *data file* (`typo_dict.json` มีรูปแบบอยู่แล้ว) ไม่ใช่ regex ในโค้ด
- ผลที่คาด: ลบโค้ดหลายร้อยบรรทัด; สินค้าใหม่ = เพิ่ม tag/คำ ไม่ใช่เพิ่ม if

### C. Candidate + Rank ให้เหลือชุดเดียว (แก้ R2/R3/R4)

**C0 — ยุบ 2 pipeline เป็น 1 (ทำก่อน C2/C3):** `product_store.py:2917-2931` เปลี่ยนจาก
`unit path → return _ucards` เป็น "อ่าน unit docs เป็นแหล่งข้อมูลของ pipeline เดิม"
→ unit pool ผ่านขั้นกรอง/rerank/dedupe เดียวกับ legacy แล้วค่อยแปลงเป็น card ด้วย `to_unit_card`
→ **ลบ** `is_compat_check` bypass (`product_store.py:2905-2906`) ได้ เพราะ compat sweep ของ legacy
ทำงานบน unit docs ได้ตรงๆ — นี่คือการแก้บั๊ก "MacBook เจอแต่ 55W" ที่ราก ไม่ใช่ที่เคส
→ **ลบ** rank/fallback ที่ซ้ำใน `units.py` (`fetch_units:174-177`, `fetch_unit_cards:454-465`)
1. **identity = id**: dedupe/diversity ใช้ `item_id` (+`model_id`) — ยกเลิกการพึ่ง `name`
   ต่อ listing เอา unit ตัวแทน 1 ตัว (ขยายเมื่อ pool ยังไม่เต็ม; ถามเจาะจงรุ่น = code-hit ยกเว้น quota)
   → แก้ตัวเลข 49% ที่วัดได้ และเป็นการ *ลบ* ความพึ่งชื่อ ไม่ใช่เพิ่มชั้น
2. **candidate rule เดียว**: route resolve ได้ type/subtype/code → query ด้วย field (exhaustive ตามขอบเขตร้าน); resolve ไม่ได้ → vector
   - **ยกเลิก hard cutoff `sim>0.3`** — similarity ไปอยู่ใน rank
   - ไม่มี "3 ขา + merge" — ถ้า structured path recall ไม่พอ นั่นคือสัญญาณว่า **tag ไม่ครบ** → ไปแก้เฟส D (ห้ามกลบด้วยโค้ด)
3. **rank function เดียว** ใช้หลัง live join: `code_hit → live_sellable → adequacy(min_watt) → type_match → promo/recency → similarity`
   แล้ว **ลบ** sort ที่ซ้ำใน units (2 จุด) และให้ superlative/compat sort เรียกใช้ฟังก์ชันเดียวกันแทนที่จะมีสูตรของตัวเอง

### D. Data coverage + rebuild cadence (แก้ R5) — เป็นเงื่อนไขของ C ไม่ใช่ของแถม
- วัด coverage เป็นตัวเลขต่อร้าน/ต่อ type: `%unit ที่มี product_type`, `%ที่มี subtype ที่ควรมี`, mis-tag ที่พบ
- แก้ `unit_classifier` ที่กฎ **ห้ามแก้รายตัว**; ทุกการแก้ต้องรายงาน diff ก่อน/หลังทั้ง corpus
- `refresh_data.sh` — กำหนดรอบ + log ให้ snapshot ไม่เน่าเงียบ
- **gate:** ห้ามเปิด structured-only path ในร้าน/type ที่ coverage ยังต่ำกว่าเกณฑ์ (fallback vector ตามกฎเดิม)

### E. โครงไฟล์: แยกตามรอยต่อ ทีละรอย (แก้ R6)
หลักการ: **ย้ายเฉยๆ ไม่ลดความซับซ้อน** — ทำเมื่อมีรอยต่อชัดและมี golden replay คุม
- เกณฑ์เลือกรอยต่อ: มี input/output ชัด, ไม่ต้องใช้ตัวแปร local ของ `chat()` เกินไม่กี่ตัว, มีเทสครอบอยู่แล้ว
- ผู้สมัครตามลำดับความปลอดภัย: cert/tisi answer block → superlative ranking → general_qtype answers → context assembly → compat re-query (บางส่วนอยู่ `device_compat` แล้ว)
- ทำ 1 รอย = 1 commit = replay ต้องเหมือนเดิม (retrieval-level เป๊ะ 100%)
- `product_store.py`: กำไรหลักมาจากเฟส B (ลบ) ไม่ใช่การแยกไฟล์ — แยกทีหลังเมื่อโค้ดหายไปแล้ว
- ไม่แตะ `app.py` เพิ่ม (ข้อตกลงเดิม: logic ใหม่ห้ามเพิ่มใน app.py — สอดคล้องกับทิศนี้พอดี)

### F. Policy ราคา (แก้ R7)
strip `price` ออกจาก `variants[]` ที่จุดสร้าง context จุดเดียว (ครอบทั้ง 2 path)
ต้องยืนยัน policy: ห้ามตอบราคา **ทุกกรณี** รวม "ถูกสุด/แพงสุด" ใช่ไหม → ถ้าใช่ ต้องมีข้อความมาตรฐาน + ตัด superlative เชิงราคาออกจาก deterministic sort

---

## 5. ลำดับและเงื่อนไขผ่าน

```
A (harness)  →  C1 (identity/dedupe)  →  B1-B2 (shadow compare + แก้ data)  →  D  →  C2-C3  →  B3 (ลบ regex)  →  E  →  F
                 ↑ เล็ก วัดผลชัด            ↑ ได้ข้อมูลจริงก่อนลบ                        ↑ ลบได้เมื่อ coverage ถึง
```
เงื่อนไขผ่านแต่ละเฟส: metric retrieval-level ไม่แย่ลงเลย + regression suite เดิมผ่าน + โค้ดไม่เพิ่มสุทธิ

---

## 6. Metric

| metric | baseline | เป้า |
|---|---|---|
| listing_diversity | 0.72 (วัดแล้ว) | ≥ 0.95 |
| type_purity (route มั่นใจ) | ต้องวัดในเฟส A | ≥ 0.90 |
| adequacy@1 (compat) | ต้องวัด | ≥ 0.90 |
| classification disagreement (regex vs field) | ต้องวัดในเฟส B1 | ต่ำพอจะลบ regex |
| tag coverage (`product_type` ไม่ว่าง) | ต้องวัด | ≥ 0.98 ต่อร้านที่เปิดใช้ |
| fallback rate | 5% (15/300) | ไม่เพิ่ม |
| LOC `units.py` + `product_store.py` | 4,563 | **ลดลง** |

---

## 7. ความเสี่ยงที่ต้องคุมจริง

| ความเสี่ยง | คุมยังไง |
|---|---|
| ลบ regex แล้วเคสที่ regex เคยช่วยพัง | ลบหลัง shadow compare + data ถึงเกณฑ์เท่านั้น; มี fallback vector; ลบเป็นขั้นไม่รวดเดียว |
| structured query recall ตกเพราะ tag ไม่ครบ | gate ด้วย coverage ต่อร้าน/type; ต่ำกว่าเกณฑ์ → ใช้ vector (ไม่เขียนชั้นชดเชย) |
| quota 1 unit/listing ทำให้คำถามรุ่นย่อยเสียข้อมูล | code-hit ยกเว้น quota |
| refactor `chat()` พังเงียบ | golden replay retrieval-level ต้องเป๊ะ 100% ต่อ 1 รอยต่อ ต่อ 1 commit |
| classifier แก้แล้วผิดเป็นชุด (silent) | บังคับรายงาน diff ทั้ง corpus ก่อน import; ห้ามแก้รายตัว |

---

## 8. ไม่อยู่ใน scope

rebuild embeddings / query rewriting (พิจารณาหลัง C-D ถ้า metric ยังไม่ถึง) · chat_v2 / chatbotv3 · quota/keys · แก้ `app.py` เพิ่ม

---

## 9. ทำไม v1 ถูกถอน (บันทึกไว้กันทำซ้ำ)

| v1 เสนอ | ปัญหา |
|---|---|
| union candidates 3 ขา + merge + tie-break | เพิ่มชั้นเพื่อกลบว่า tag ไม่ครบ — ถ้าแก้ data ก็ไม่ต้องมี = complexity ที่สร้างขึ้นเอง |
| ส่ง unit pool เข้า `_filter_false_positives` / `_filter_charger_subtype` | สอง filter นี้ *คือ* R1 (อ่านชื่อสินค้าเดาประเภท) — ต่อเข้าไป = ต่ออายุ treadmill hardcode |
| เพิ่ม quota layer / เพิ่ม unified key โดยไม่ลบของเดิม | โค้ดเพิ่มสุทธิ ผิดเกณฑ์ข้อ 2 |
| จัดลำดับตาม "แก้เคสที่เห็น" | ทำให้ดูดีขึ้นในเคสที่วัด แต่ไม่ปิดช่องที่ทำให้เคสประเภทอื่นกลับมาอีก |
