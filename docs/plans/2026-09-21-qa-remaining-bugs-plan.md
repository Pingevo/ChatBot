# Plan: แก้ QA bugs คงค้างที่ root cause (จาก shadow-inbox QA notes 2026-09-15)

> แหล่งอ้างอิง: `~/Downloads/shadow-inbox-bot-qa-notes-2026-09-15.md` + audit ใน `getoutofmywaybotkaikrook2.md` (entry 2026-09-21)
> หลักการ: แก้ที่ root cause ไม่ patch รายเคส · ไม่ hardcode เคส · ทุกงานมี test/verify กำกับ · ห้ามทำลายเคสที่ผ่านแล้วใน waythrough

## Root cause clusters (กลุ่มต้นตอ — แก้ตรงนี้จุดเดียวคุมทุกเคส)

### RC-A — ไม่มี trust boundary ระหว่าง LLM output กับคำตอบที่ส่งลูกค้า
ปัญหาที่ครอบ: NEW-3 (แต่งนโยบาย), BUG-M (อ้างแอดมินรับเรื่อง/สัญญาส่งต่อแต่ไม่ escalate), ส่วนหนึ่งของ BUG-H/K/O (อ้างเช็คสต็อก/บอกมีทั้งที่หมด), "ทางร้านไม่แจ้งราคา" (LLM แต่งเอง)

ปัจจุบัน: `guards.check_output` มีแต่ observe-only (log) · `llm._clean` มี fixed-pattern list (whack-a-mole — จับได้เฉพาะประโยคที่ระบุตรงๆ)

**Fix:** ยก `guards.py` เป็น output policy layer จริง — rules-as-data `(pattern → action)` จุดเดียวครอบทุก answer path:
- `escalate` — คำตอบอ้างสิ่งที่เกิดขึ้นแล้ว (รับเรื่องแล้ว/ได้รับแล้ว/เคลมให้แล้ว/จัดส่งแล้ว) แต่ `handoff=False` → แทนข้อความเป็น canned "ส่งต่อให้แอดมิน" **+ set handoff จริง** (ไม่ใช่แค่เปลี่ยนคำ)
- `rewrite` — สัญญา/อ้างนโยบาย (เปลี่ยนได้/คืนได้/ฟรี/มีโปร/แถม) ที่ไม่มี grounding ใน context → เขียนใหม่เป็น "ขอตรวจสอบกับแอดมิน"
- `log` — นโยบายที่มี grounding ใน context → ผ่าน (ไม่ block คำตอบที่มี source จริง)

การรู้ว่า "มี grounding" = เช็ค KB/context ที่ส่งให้ LLM ตอนนั้น (ส่ง `context_keys` เข้า check_output) — ไม่ใช่เดา

จุด enforce: **wrap `chat()` จุดเดียว** — verify แล้วว่าทุก engine funnel ผ่าน `/chat` (v3 → `ChatResponse(**_resp)` app.py:535, v2 → :544, legacy → ภายใน) → rename body เดิมเป็น `_chat_impl(req)` แล้ว `chat(req)` = `_chat_impl` → `guards.enforce(resp, req)` → return (cover ทุก return path + ทุก engine; `_send_handoff` เป็น sync POST เรียกใน wrapper sync ได้) — enforce ทำหน้าที่: rule `escalate` → เรียก `_send_handoff` จริง + set flag + แทนข้อความ; `rewrite` → แทนข้อความ — pattern list เดิมใน `_clean` ย้ายรวมมาที่นี่ (dedupe whack-a-mole ให้อยู่ที่เดียว) · `model_post_init` log guard คงไว้เป็น telemetry ซ้ำซ้อนได้ หรือลบทิ้งเมื่อ enforce ครบ

### RC-B — claim flow derive state ใหม่ทุก turn แทนที่จะใช้ slot ที่ persist
ปัญหาที่ครอบ: NEW-1 (ชื่อขยะ), NEW-2 (กลืนคำถาม/ขอข้อมูลซ้ำ/restart จากรูป)

พบว่า: `claim_state` persistence **มีและถูกใช้แล้วบางส่วน** (`conversation_products.py:767-846`; warranty_flow load:872, update:1316/1418/1824, clear:1550, แสดงข้อมูลเดิม:1331-1339) — งานจริงคือ **audit ว่า state ไหนไม่เช็ค slot ที่ fill แล้ว** (ยังขอซ้ำ) + เพิ่ม question-fallthrough

**Fix:**
1. **NEW-1** — ลบ regex fallback ใน `extract_customer_info` (warranty.py:620-668) ทิ้งทั้งก้อน: NER → English-name pattern → จบ (ไม่มี fallback ที่ลบ "ค"/"ชื่อ" ทิ้งมั่ว) + เพิ่ม validator: reject ถ้ามีคำกริยา/คำถาม (ไหม/ครับ/แล้ว/ได้/ไม่/ที่ไหน) — ขาดชื่อดีกว่าเก็บขยะ
2. **เบอร์โทร → order_id bug** — mask phone ออกจาก msg ก่อน scan order (ตอนนี้ `candidate != phone` พลาดเพราะ normalize คนละแบบ) + **order_sn 19 หลัก** (Shopee format `3256063691605504616`) — extend `_ORDER_ID_PATTERN` รองรับ
3. **NEW-2** — ใน waiting states **ก่อน handoff** (State 7 awaiting info) ของ `warranty_flow`: ถ้าข้อความเป็น "คำถาม" (มี ไหม/ยังไง/ได้ไหม/?/อะไร/เมื่อไหร่/ที่ไหน) และไม่ extract claim info ได้เลย → `return None` ปล่อย pipeline ปกติตอบ (claim_state persist อยู่ → turn ถัดไป resume ได้) — ไม่กลืนคำถามอีก
   - ⚠️ guard กัน fallthrough ผิด: ข้อความมี warranty/claim kw (เคลม/ประกัน/ส่งคืน) หรือ extract info ได้ → **ห้าม** fallthrough ต้องอยู่ใน flow
   - ⚠️ scope เฉพาะ pre-handoff: State 6 post-handoff **ห้าม** fallthrough (ดู decision ด้านล่าง)
4. fill-once: audit ทุก waiting state ว่าเช็ค `claim_state` ก่อนถามหรือยัง (บางจุดทำแล้ว :1331-1339) — จุดที่ยัง derive จาก history/`_received_items` ให้เปลี่ยนไปอ่าน persisted state → ขอเฉพาะ slot ที่ยังว่าง

**✅ design decision (user 2026-09-21):** post-handoff = **บอทเงียบจนกว่า ticket closed + ลูกค้าทักซ้ำ** — verify แล้วว่า semantics นี้มีครบ end-to-end อยู่แล้ว:
- worker layer: `botWorkerService.ts:334` — `assigned_to && !closed` → `skip_assigned` (ไม่เรียกบอทเลย = เงียบจริง); `closed/resolved` → process ปกติ (ตอบต่อ)
- bot layer (fallback เมื่อ worker ยังเรียก เช่น handoff ไม่มี assigned_to / test path): `warranty_flow.py:148-199` — `ticket_state` open/handoff + marker → lock ตอบ canned "รอแอดมิน"; `closed` → ข้าม lock ตอบปกติ
- → **ไม่ต้องเปลี่ยน State 6** — QA suggestion (ตอบคำถาม+แปะรอแอดมิน) ถูก reject โดย user

### RC-C — escalation keyword เป็น list enumeration (whack-a-mole)
ปัญหาที่ครอบ: BUG-M (ขอคน 4/4 พลาด: "ติดต่อเจ้าหน้าที่"/"แชทกับเจ้าหน้าที่"/"ติดต่อร้านค้า")

**Fix:** `handoffs.py:34` — เปลี่ยนจาก list ประโยคเป็น **composition pattern**: `(verb ∈ {ติดต่อ,คุย,แชท,พูด,ขอ,โทร}) + (target ∈ {เจ้าหน้าที่,คน,แอดมิน,พนักงาน,admin,human,agent})` + exclusion list เดิม — ครอบ phrasing ที่ยังไม่เคยเจอ ไม่ต้องเพิ่มคำทีละเคส + เพิ่ม English ("talk to human", "speak to agent", "real person")
- ⚠️ "ร้าน" เป็น target เฉพาะกับ verb {ติดต่อ,โทร} ("ติดต่อร้านค้า") — คู่ "คุย"+"ร้าน" กว้างเกิน (เคส "อยากคุยเรื่องร้าน") → แยก rule

### RC-D — error path แนบ exception ดิบถึงลูกค้า
ปัญหาที่ครอบ: BUG-Q (429 JSON หลุดถึงลูกค้า), NEW-10 (vision 503)

**Fix:** `llm.py:1455/1588/1692` 3 จุด `f"...({exc})"` → helper เดียว `_error_reply(exc)`: log full exc → stderr, คืนข้อความสะอาด "ขออภัย ระบบติดขัดชั่วคราว เดี๋ยวแอดมินตรวจสอบให้นะคะ" + caller set `handoff=True` (ลูกค้าควรได้คน ไม่ใช่ error text)
~~ops: quota free-tier~~ — **ตัดออกแล้ว (user 2026-09-21):** user จะเปลี่ยน quota เอง ไม่ใส่ scope

### RC-E — measurement gaps (แก้โค้ดตาบอดไม่ได้)
- **NEW-9 elapsed=0**: plumbing ถูกทั้ง 2 ฝั่งแล้ว (route อ่าน `data.elapsed` ✓ Python ส่ง `elapsed` ✓) → ต้อง gen batch ใหม่ดูค่าจริง — ถ้ายัง 0 ค่อยไล่
- **BUG-I token**: ยังไม่มี cap — ใส่ instrumentation ก่อน (log context size breakdown) แล้วค่อย cap ตามข้อมูล
- ~~**NEW-10 vision 503**~~ — ตัดออก (ผูก quota; user จัดการเอง) — ถ้าหลังเปลี่ยน quota แล้วยังเจอ ค่อยเปิดเคสใหม่

---

## Task list (เรียงตาม impact × risk — ทำทีละ phase, phase ไหน shippable อิสระ)

### Phase 0 — isolated, high trust impact
- [ ] **T1 BUG-Q**: `_error_reply()` helper + แทน 3 จุด + handoff=True บน LLM failure · test: mock ClientError → answer ไม่มี "429"/"RESOURCE_EXHAUSTED"/JSON + handoff flag
- [ ] **T2 NEW-1**: ลบ regex fallback + validator + phone-mask-ก่อน-order-scan · test: "ขอบคุณครับ"→name="" · "ชาร์จ iPhone 15 Pro Max"→name="" · "เชื่อม"ไม่โดนลบ · เบอร์ไม่กลายเป็น order_id
- [ ] **T3 BUG-M keywords**: composition pattern + English + exclusions · test: 4 เคส QA ทั้งหมดจับได้ + "แอดเพื่อน"/"แอดไลน์" ไม่จับ
- [ ] **T4 BUG-M escalate**: rules-as-data ใน guards.py + enforce ที่ response boundary + ย้าย `_false_admin_patterns` จาก llm._clean มารวม · test: answer มี "รับเรื่องแล้ว" แต่ handoff=False → rewritten + handoff=True

### Phase 1 — claim flow (งานใหญ่สุด แยกทำหลัง Phase 0)
- [ ] **T5 NEW-2**: claim_state fill-once (อ่าน persisted state แทน derive จาก history) + question-detection → fallthrough · test: replay shp_242433419154067076 — คำถามกลาง claim ต้องได้คำตอบจริง ไม่ใช่ canned
- [ ] **T6**: "ส่งของผิด/ของไม่ครบ/ของแถมขาด" (fulfillment problem) — ตอนนี้หลุดเข้า warranty claim เพราะ `early_order_flow` มีแค่กลุ่ม return/refund (`_RETURN_REFUND_KWS` order_flow.py:80-99) ไม่มีกลุ่มปัญหาออเดอร์ → LLM intent จัดเป็น warranty_claim → เข้าฟอร์มเคลมผิดประเภท
  - **decision (user 2026-09-21):** ส่งแอดมิน — flow ที่ถูกคือ **reuse path return/refund เดิม** (order_flow.py:75-286): detect → มี order_sn → lookup+anchor items+handoff / ไม่มี → ถามเลข → turn ถัดไป handoff (ขยาย `_is_rr_followup`) — ไม่สร้าง flow ใหม่
  - detection แบบ composition ไม่ใช่ flat list: `(received-verb ∈ {ส่งมา,ส่งให้,ได้รับ,ได้ของ,ได้มา,แกะกล่อง,ในกล่อง,เปิดกล่อง}) + (problem ∈ {ผิด,ไม่ครบ,ขาด,ไม่ตรง,ไม่เหมือน,หาย})` + standalone {"ส่งผิด","ผิดรุ่น","ผิดสี","ผิดแบบ"} + freebie {"ของแถม"+ไม่ครบ/ขาด/ไม่ได้/ไม่มี}
  - guards: `not _in_claim_flow` (เหมือน return_refund) · freebie pattern ข้ามถ้าข้อความมี ไหม/เหรอ/หรอ/มั้ย (กัน "มีของแถมไหม"=คำถามขายของ) · "เปลี่ยนได้ไหม/คืนได้ไหม" = policy question → general flow ไม่แตะ
  - handoff `reason="order_problem"`, claim topic แยก subtype: "ส่งสินค้าผิด/ไม่ตรงที่สั่ง" | "สินค้าไม่ครบ/ขาด" | "ของแถมไม่ครบ" + canned answer เชิญส่งรูปสินค้าที่ได้รับ (post-handoff info path รับรูปอยู่แล้ว)
  - test: "ส่งของผิดรุ่น"/"ของแถมไม่ครบ"/"ได้รับของไม่ตรงที่สั่ง" → handoff order_problem · "มีของแถมไหม" → product path ไม่เปลี่ยน · "สินค้าเสีย" → warranty claim ไม่เปลี่ยน

### Phase 2 — grounding/policy + cosmetics
- [x] **T7 NEW-3**: guard `rewrite` tier นโยบาย — เช็ค grounding จาก context_keys (KB ที่ inject จริง) ไม่ใช่ลิสต์คำตายตัว
- [x] **T8 NEW-7**: intent gate ก่อน attach product cards — suppress เมื่อ intent ∈ {sticker/greeting/complaint/claim-flow} **และ**ข้อความปัจจุบันไม่มี product kw (กัน suppress ผิดในแชท complaint ที่ลูกค้าถามสินค้า)
- [x] **T9 NEW-6**: image_desc → `extract_model_keywords` → match สินค้าในร้าน → set anchor **เฉพาะเมื่อข้อความไม่มี product ref ชัด + match ได้ตัวเดียว** (reuse existing extractor ไม่เขียนใหม่)
- [x] **T10**: markdown table→bullet converter ใน `_clean` (reuse จุดเดียวกับ BUG-C fix) + ลบ space เกิน "ทางร้าน จะ"
- [x] **T11 NEW-8**: `general:brands/categories` — ถ้าคำถาม specific แต่ KB template เป็น list ดิบ → ให้ LLM ตอบด้วย KB เป็น context แทนตอบ template ตรงๆ

### Phase 3 — verify + measure (ไม่ใช่ code fix)
- [x] **T12**: replay เคส BUG-H/K/O เดิม (Luxury Black/ROSY/BINNIFA/Pad7) กับ sellable ranking ใหม่ — จดผล
- [x] **T13**: audit BUG-10 arm conditions — ทำไม `no_product_found_handoff` ไม่เคย fire (app.py:3955-3966)
- [x] **T14**: gen shadow batch ใหม่ → เช็ค `bot_elapsed_ms` ≠ 0 (NEW-9) + log token breakdown (BUG-I)
- [x] **T15**: verify "ทางร้านไม่แจ้งราคา" — grep prompt หา price prohibition; ถ้าไม่มี = LLM fabrication → คุมด้วย RC-A guard
- [x] **T16**: misc misinterpretation ("ย่อ"=สรุปสั้น แต่ตอบเรื่องสี · "ปิดยังไง"=AOD แต่สอนปิดเครื่อง) — ไม่มี deterministic fix → เพิ่ม 2 เคสเข้า test corpus + monitor รอบหน้า

### ข้าม/แยกงาน
- ~~Quota/keys~~ — user จัดการเอง (ตัดออก 2026-09-21) · มาแล้วจ้า deploy = separate · MongoClient close() race (จดไว้ใน waythrough แล้ว — bug คนละตัว) · post-handoff silence — **มีอยู่แล้ว end-to-end** (worker skip + ticket_state lock) ไม่ใช่งานใหม่

## กฎที่ทุก task ต้องทำตาม
- `python -m py_compile` + `npx tsc --noEmit` (ถ้าแตะ TS) ทุกครั้ง
- รัน `docs/test/test_car_charger_regression.py` + unit test เฉพาะส่วนที่แตะ — ห้ามทำลายเคสผ่าน
- อัปเดต SRS_SSD.md section 6 ทุกฟังก์ชันที่แก้ (กฎ repo ข้อ 1)
- เขียน waythrough file 2: error→สาเหตุ→วิธีแก้→ผลกระทบเคสอื่น
