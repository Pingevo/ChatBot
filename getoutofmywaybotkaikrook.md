# getoutofmywaybotkaikrook.md — Waythrough Log

> ไฟล์นี้คือบันทึกเส้นทางที่เราผ่านมา — ทำอะไร แก้อะไร เคสไหนผ่านแล้ว แก้ยังไง
> **ก่อนทำอะไรใหม่ → อ่านไฟล์นี้ก่อนทุกครั้ง**
> ห้ามทำให้เคสที่เคยผ่านกลับมาพัง
> พอจะทำอะไรใหม่ → เขียนไว้ใน "กำลังจะทำ" ก่อน
> แก้เสร็จ → เขียนวิธีแก้ + ย้ายไป "ผ่านแล้ว"

---

## วิธีใช้ไฟล์นี้

1. **ก่อนทำงานใหม่** → อ่าน "เคสที่ผ่านแล้ว" ก่อน เพื่อไม่ทำลายของเก่า
2. **ก่อนแก้โค้ด** → เขียนไว้ใน "กำลังจะทำ" ว่าจะแก้อะไร ทำไม
3. **แก้เสร็จ** → เขียน "วิธีแก้" + ย้ายเคสไป "ผ่านแล้ว" + อัปเดต "กำลังจะทำ"
4. **เจอปัญหาใหม่** → เขียนใน "ปัญหาที่เหลือ"
5. **ห้ามลบ** เคสที่ผ่านแล้ว — เก็บไว้เป็นประวัติ

---

## ลำดับการทำ (Order: C → A → B → D)

1. **C — Context loss** — บอทลืมสินค้าที่คุยอยู่ → สร้าง anchor system
2. **A — Trigger ผิด** — คำถามรับประกันเข้า claim flow ผิด
3. **B — Cascade** — คำถามถัดไปถูกดักใน claim flow
4. **D — Trust** — ตอบความน่าเชื่อถือ ของแท้ การจัดส่ง
5. **Q14 — ดึงผิดรุ่น** — "ขอดูสินค้าจริง" ดึง Elite2 แทน BioKoop
6. **Replay UI** — เพิ่ม inbox picker ในหน้า replay-compare

---

## เคสที่ผ่านแล้ว (ห้ามทำลาย)

### C — Context loss (ผ่าน)
- **ปัญหา**: บอทไม่จำสินค้าเก่า คำตอบสั้นเกิน คำถามต่อไม่เชื่อมสินค้าเดิม
- **วิธีแก้**:
  - สร้าง `conversation_products.py` — เก็บ timeline สินค้าตาม conversation_id ใน MongoDB
  - anchor = สินค้าที่ลูกค้าส่งมา (item card / variation card / order)
  - suggestion = สินค้าที่บอทแนะนำ
  - active product = anchor ล่าสุด ถ้าไม่มี anchor ใช้ suggestion ล่าสุด
  - `messageService.ts` แปลง rich message เป็น `[สินค้า: <item_id>]` ก่อนส่งบอท
  - `messageMediaParser.ts` normalize item ID ตัด `.0` จาก Shopee float
  - `replay_compare.py` ใช้ pattern เดียวกับ shadowbot (`[สินค้า: id]`)
  - `knowledge_base.py` เพิ่ม stop_words (app/wifi/usb/ฯลฯ) กัน false positive model keyword
  - `app.py` เพิ่ม guard กันส่ง `[item]` placeholder เป็นคำถามให้ LLM
  - `product_store.py` lookup_product_card ดึง price/image จาก `gen_price` / `image.image_url_list`
- **เคสที่ผ่าน**:
  - Q1 rich item card → product card ขึ้น price 3490 image + บอทตอบรู้สินค้า
  - Q2 follow-up app connection → บอทจำ BioKoop ตอบ Kstyle OS
  - Q3 warranty → บอทตอบ 1 ปี
  - Q4 image request → บอทตอบเรื่องรูป BioKoop
- **ไฟล์ที่แก้**: `conversation_products.py`, `messageService.ts`, `messageMediaParser.ts`, `replay_compare.py`, `knowledge_base.py`, `app.py`, `product_store.py`, `replay-compare/page.tsx`

### A — Trigger ผิด (ผ่าน)
- **ปัญหา**: "ถ้ามีปัญหาเครมได้ใช่ไหมครับ" เข้า claim data-collection flow ทั้งที่เป็นคำถามรับประกัน
- **วิธีแก้**: แก้ warranty detection ให้จับคำถามรับประกันก่อนเข้า claim flow
- **เคสที่ผ่าน**: Q11 ถามเคลม → บอทตอบเรื่องรับประกัน ไม่เข้า claim flow
- **ไฟล์ที่แก้**: `app.py`, `warranty.py`

### B — Cascade (ผ่าน)
- **ปัญหา**: หลังเข้า claim flow แล้ว คำถามถัดไปถูกดักเป็น claim field หมด
- **วิธีแก้**: แก้ claim state machine ให้รู้ว่าเลิก claim flow แล้ว
- **เคสที่ผ่าน**:
  - Q12 trust question → บอทตอบ trust ไม่ถูกดัก claim
  - Q13 iOS/Android compatibility → บอทตอบตรง ไม่ถูกดัก claim
- **ไฟล์ที่แก้**: `app.py`

### D — Trust (ผ่าน)
- **ปัญหา**: บอทตอบ trust ไม่ดี ไม่มีข้อมูลยืนยัน แนบลิงก์ซ้ำซ้อน
- **วิธีแก้**: แก้ prompt + context ให้ตอบ authenticity, Thai shipping, new/sealed, warranty
- **เคสที่ผ่าน**: Q5, Q8, Q9 ตอบ trust ได้
- **ไฟล์ที่แก้**: `app.py`, `llm.py`

### Q14 — ดึงผิดรุ่น (ผ่าน routing, รอ verify answer)
- **ปัญหา**: "ผมขอดูสินค้าจริงได้ไหม" ดึง Elite2/Ks/Lora2 ทั้งที่ active = BioKoop
- **สาเหตุ**:
  1. CONV-ACTIVE อยู่หลัง history block → history-words ดึง "kieslect" ไปค้น Ks/Lora2/KR Pro ทับ anchor
  2. "ดูสินค้า" อยู่ใน new_topic_kws → "ขอดูสินค้าจริง" ถูก classify เป็น new topic → ข้าม active product
  3. `_ref_regex_products = []` ที่บรรทัด ~2756 reset ค่าที่ CONV-ACTIVE ตั้งไว้
  4. fetch_products รันเสมอ ทับ `_ref_regex_products` ที่ CONV-ACTIVE ตั้ง
- **วิธีแก้**:
  1. ย้าย CONV-ACTIVE ก่อน history block (บรรทัด ~2121)
  2. เอา "ดูสินค้า" ออกจาก `_new_topic_kws_cp`
  3. เปลี่ยน `_ref_regex_products: list[dict] = []` เป็น `if not _is_conv_active: _ref_regex_products = []`
  4. เพิ่ม `if not _ref_regex_products:` ครอบ fetch_products block
- **ผล**: routing ถูกแล้ว (products=1 BioKoop, fetch_products 0.00s) แต่ LLM 429 ทดสอบ answer ไม่ได้
- **ไฟล์ที่แก้**: `app.py`
- **⚠️ ยังไม่ verify เต็ม**: รอ LLM quota คืน → รัน replay BioKoop 54 Q เปรียบเทียบกับ baseline

### Q2/Q6 ตอบไม่ได้ + warranty ห้อย + ตอบสั้น (ผ่านเทส)
- **ปัญหา**:
  1. Q2 "แอพเชื่อมยังไง" / Q6 "สายชาร์จยังไง" → บอทตอบ "ไม่มีข้อมูล" ทั้งที่มี spec ในมือ
  2. เงื่อนไขรับประกันห้อยมาทุกคำตอม (Q3, Q7, Q11, Q12)
  3. ตอบสั้นเกิน เช่น "เปลี่ยนได้ค่ะ 22 มม." จบ
- **สาเหตุ**:
  1. `desc_kw` ไม่มี "แอพ", "app", "ชาร์จ", "charge" → `include_desc=False` → ไม่ส่ง spec ให้ LLM
  2. `is_warranty_question` มีคำว่า "เปลี่ยน" → "สายนาฬิกาเปลี่ยนได้ไหม" โดนแนบเงื่อนไข
  3. prompt บอก "ห้ามอ้างอิง history" + ตัด model history ให้สั้นเกิน
- **วิธีแก้**:
  1. เพิ่ม "แอพ", "แอป", "app", "ชาร์จ", "charge", "สายนาฬิกา", "สายรัด", "strap", "กันน้ำ", "หน้าจอ", "sensor" ฯลฯ ใน `desc_kw`
  2. เอา "เปลี่ยน" ออกจาก warranty keywords → เปลี่ยนเป็น "เปลี่ยนสินค้า", "เปลี่ยนใหม่", "เปลี่ยนตัว"
  3. เพิ่ม State 6 (post-handoff): ถ้าบอทเคย handoff แล้วลูกค้าทักใหม่ → บอทหยุดตอบทุกอย่าง บอกลูกค้า "ส่งต่อแอดมินแล้ว รอการติดต่อกลับ" (เหตุผล: เรื่องเคลม sensitive, แอดมินเห็นประวัติ, ลูกค้าต้องการคนจริง)
  4. แก้ prompt: อนุญาตให้ใช้ history ถ้าเป็นสินค้าเดียวกัน + เพิ่มคำสั่ง "ตอบ 2-3 บรรทัด 60-120 คำ ไม่สั้นเกิน"
  5. ถ้า context มี 1 สินค้า → ส่ง model history เต็ม (ไม่ตัด 200 ตัวอักษร)
- **เคสที่ผ่าน**:
  - Q2 "แอพเชื่อมยังไง" → ตอบ "Kstyle OS บนมือถือ" ✓
  - Q6 "สายชาร์จยังไง" → ตอบ "สายชาร์จแม่เหล็กในกล่อง" ✓
  - Q7 "สายนาฬิกาเปลี่ยนได้ไหม" → ตอบ "เปลี่ยนได้ 22 มม. ถอดเปลี่ยนได้" ไม่ติด warranty ✓
- **ไฟล์ที่แก้**: `llm.py` (desc_kw + prompt + history), `knowledge_base.py` (is_warranty_question), `app.py` (State 6 post-handoff)

### Replay UI — Inbox picker + History (ผ่าน build, รอทดสอบจริง)
- **ปัญหา**: หน้า replay-compare รันได้แค่ batch ไม่มีเลือกแชทเฉพาะ ไม่มี history
- **วิธีแก้**:
  - API: เพิ่ม action `run_conv` ใน `/api/replay-compare` → รัน `replay_compare.py --conv <id>`
  - API: เพิ่ม `?history=1` → list ไฟล์ `replay_conv_*.json` พร้อม metadata (conv_id, shop, qa_count, status)
  - UI: 3 tabs — "เลือกแชท" (inbox) | "History" | "ไฟล์ผล" (files เดิม)
  - Inbox: โหลดจาก `/admin/conversations` + search + filter platform/shop
  - History: ดึงแชทที่เคย replay ผ่าน inbox แล้ว + search + กดเลือกเพื่อดูผลเก่า
  - กดเลือกแชทใน inbox → รัน replay แค่แชทนั้น → โพลผลทุก 5 วินาที → เสร็จแล้ว reload history
  - กดเลือกใน history → โหลดไฟล์ replay ของแชทนั้นขึ้นมาแสดง
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/api/replay-compare/route.ts`, `ChatAdminWeb/src/app/(console)/replay-compare/page.tsx`
- **สถานะ**: typecheck + build ผ่าน, preview เปิดแล้ว, รอผู้ใช้ทดสอบ

---

## กำลังจะทำ

_(ว่าง — รอ LLM quota คืนก่อนทำต่อ)_

---

## ปัญหาที่เหลือ (ตามลำดับความสำคัญ)

### 1. Verify Q14 + regression check (รอ LLM quota)
- รัน replay BioKoop 54 Q เต็ม
- เปรียบเทียบ verdict กับ baseline ก่อนแก้ Q14
- ถ้ามี regression > 3 Q → แก้ก่อน ห้ามทำข้อต่อไป
- baseline เก่า: ดูใน `testresult/` หรือ `/tmp/replay_biokoop_v3.json`

### 2. Q19 — "ใช้มั๊ย" สั้นเกิน
- บอทบอกถามใหม่ ทั้งที่ควรดึง context จาก history
- ต้องทำ: ตรวจว่า message สั้น + มี history → ใช้ active product ตอบ

### 3. Q18, Q21 — รับประกันยาวเกิน + ตัดค้าง
- คำตอบ warranty ยาวเกิน template-heavy
- ต้องทำ: ย่อ prompt + กันตัดกลางคัน

### 4. Q5, Q12 — แนบลิงก์/รูปซ้ำซ้อน
- บอท push sales แนบลิงก์/รูปซ้ำทั้งที่ลูกค้าถาม trust
- ต้องทำ: แก้ prompt กันแนบลิงก์ถ้าไม่จำเป็น

### 5. SRS_SSD.md section 6
- อัปเดตฟังก์ชันที่เปลี่ยน: CONV-ACTIVE, conversation_products, knowledge_base stop_words, replay UI

---

## กฎเหล็ก (ห้ามละเมิด)

1. **ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify** — ถ้า LLM 429 บอกตรงๆ ว่า "routing ถูก แต่ยังทดสอบ answer ไม่ได้"
2. **ก่อนแก้ logic ที่มีผลกว้าง → ถามตัวเอง**: "เคสที่เคยถูกจะพังไหม? ทดสอบยังไง?"
3. **บันทึก baseline ก่อนแก้** — รัน replay ก่อน → เก็บ verdict → แก้ → รันซ้ำ → เปรียบเทียบ
4. **ถ้า quota หมด → ห้ามแก้ต่อ** จนกว่าจะทดสอบได้
5. **ห้ามลบเคสที่ผ่านแล้ว** จากไฟล์นี้ — เก็บไว้เป็นประวัติ
6. **ก่อนทำอะไรใหม่ → เขียนใน "กำลังจะทำ" ก่อน** → แก้เสร็จ → ย้ายไป "ผ่านแล้ว"

---

## ไฟล์สำคัญที่แก้ทั้งหมด

| ไฟล์ | การแก้ | เคสที่เกี่ยวข้อง |
|---|---|---|
| `chatbot/shopeechat/app.py` | CONV-ACTIVE ก่อน history, guard placeholder, กัน reset, ข้าม fetch, warranty detection, claim state machine, trust prompt | C, A, B, D, Q14 |
| `chatbot/shopeechat/conversation_products.py` | timeline + anchor + active product resolution | C |
| `chatbot/shopeechat/knowledge_base.py` | stop_words (app/wifi/usb/ฯลฯ) | C |
| `chatbot/shopeechat/product_store.py` | lookup_product_card (gen_price, image_url_list) | C |
| `chatbot/shopeechat/warranty.py` | warranty detection | A |
| `chatbot/shopeechat/llm.py` | trust prompt | D |
| `replay_compare.py` | build_bot_message `[สินค้า: id]` pattern + user_products lookup | C, Replay UI |
| `ChatAdminWeb/.../messageMediaParser.ts` | normalizeItemId ตัด .0 | C |
| `ChatAdminWeb/.../messageService.ts` | toBotText → `[สินค้า: id]` | C |
| `ChatAdminWeb/.../replay-compare/page.tsx` | inbox picker + tab + product card | C, Replay UI |
| `ChatAdminWeb/.../api/replay-compare/route.ts` | action run_conv | Replay UI |
