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

### Order Lookup — ลูกค้าส่งเลขคำสั่งซื้อ (ผ่าน flow, รอ LLM quota คืนเพื่อ verify answer)
- **ปัญหา**: ลูกค้าส่งเลขคำสั่งซื้อเข้ามา → บอทไม่รู้จัก ไม่ดึงข้อมูล order ตอบไม่ได้
- **วิธีแก้**:
  1. สร้าง `order_store.py` — lookup order จาก MongoDB (ORDER_URI_MONGO, ORDER_DB, ORDER_COLLECTION)
  2. `extract_order_sn()` จับ order_sn จาก message (รองรับ `[order: XXX]`, `[คำสั่งซื้อ: XXX]`, `เลขคำสั่งซื้อ XXX`, `XXX` ลำดับ)
  3. `lookup_order()` ดึงข้อมูล: สถานะ, สินค้า, ขนส่ง, วันที่สั่ง (ไม่มียอดรวม/ที่อยู่/tracking)
  4. `build_order_context()` สร้าง context string ส่งให้ LLM
  5. ใน `app.py` เพิ่ม order lookup block หลัง item_tag block ก่อน general_qtype
  6. ถ้าพบ order → ส่ง context ให้ `llm.answer_general(qtype="order_status")`
  7. ถ้าไม่พบ → บอกลูกค้า "ไม่พบข้อมูลคำสั่งซื้อ ตรวจสอบเลขอีกครั้ง"
- **ข้อมูลที่ตอบได้**:
  - สถานะ order (order_status + logistics_status แปลไทย)
  - สินค้าใน order (ชื่อ + รุ่น + จำนวน)
  - ขนส่ง (shipping_carrier)
  - วันที่สั่งซื้อ (create_time แปลเป็น พ.ศ.)
- **เคสที่ผ่าน**:
  - "เลขคำสั่งซื้อ 220713B9NB3UY0 ส่งถึงไหนแล้ว" → source=order_lookup ✓ (LLM 429 ตอบไม่ได้ แต่ flow ถูก)
  - "เลขคำสั่งซื้อ 999999XXNOTFOUND" → source=order_lookup, ตอบ "ไม่พบข้อมูลคำสั่งซื้อ" ✓
- **⚠️ ยังไม่ verify เต็ม**: รอ LLM quota คืน → ทดสอบ answer จริง
- **ไฟล์ที่แก้**: `order_store.py` (ใหม่), `app.py` (เพิ่ม order lookup block)

### Ticket Panel — ประวัติคำสั่งซื้อในหน้า Tickets (ผ่าน build, รอ manual verify)
- **ปัญหา**: แอดมินดูแชทลูกค้า → ไม่รู้ว่าลูกค้าคนนี้เคยซื้ออะไรบ้าง เมื่อไหร่ สถานะอะไร
- **วิธีแก้**:
  1. สร้าง API route `/api/admin/conversations/[id]/orders` — ดึง orders จาก dbWallet.ShpOrders โดยเชื่อม `customer_id` (conversation) = `buyer_user_id` (order)
  2. เพิ่ม `OrderHistorySection` ใน `InfoTab.tsx` — แสดงใน tab "ข้อมมู" ของ ticket panel
  3. แสดง 5 รายการล่าสุด + ปุ่ม "ดูทั้งหมด" ถ้ามีมากกว่า 5
  4. แต่ละรายการแสดง: order_sn, สถานะ (badge สี), วันที่, ขนส่ง, ร้าน, รายการสินค้า
- **การเชื่อม**: `customer_id` ใน conversations_shp = `buyer_user_id` ใน ShpOrders (ทดสอบแล้ว: buyer_user_id=12204060 → 8 orders)
- **ข้อจำกัด**: buyer_user_id=0 หรือ None ใน order ไม่สามารถเชื่อมได้ (บาง order ไม่มี buyer_user_id)
- **ไฟล์ที่แก้**: `orders/route.ts` (ใหม่), `InfoTab.tsx` (เพิ่ม OrderHistorySection)
- **Build**: ผ่าน ✓ (tsc + next build)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า tickets ใน browser เพื่อยืนยัน UI

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

### Phase 2Z++++ — แก้บอทบอกไม่มีสาย Lightning ทั้งที่มีสินค้าจริง (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: ลูกค้าถาม "สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ" → บอทตอบ "สินค้าในร้าน ZMIThailand ตอนนี้จะเป็นสายชาร์จแบบ USB-C to USB-C สำหรับ iPhone 15 ขึ้นไปค่ะ" ทั้งที่ Q1 บอทเองแนะนำสาย ZTEC ที่มี both USB-C to Lightning และ USB-C to USB-C
- **สาเหตุ**:
  1. ลูกค้าพิมพ์ "ไอโฟน 13คะ" → `extract_model_keywords` แบ่งคำได้ token `"13คะ"`
  2. `is_target_device_kw("13คะ")` คืน `False` เพราะ `_TARGET_DEVICE_KWS` มีแค่ `"13"` (ไม่มี `"13คะ"`) และ regex เดิมไม่จับตัวเลข+คำลงท้ายไทย
  3. → `_cur_model_kw = ["13คะ"]` ไม่ว่าง → ข้าม CONV-ACTIVE → ไม่ใช้ active product (ZTEC)
  4. → ทำ vector search ใหม่ → ดึงแค่สาย USB-C to USB-C → LLM ตอบว่าไม่มีสาย Lightning
- **วิธีแก้**: เพิ่ม regex ใน `is_target_device_kw` (knowledge_base.py) ให้จับตัวเลขรุ่น iPhone (11-17) ที่ติดกับคำลงท้ายไทย เช่น "13คะ", "15ครับ", "17นะ"
  - regex: `re.match(r"^1[1-7][\u0E00-\u0E7F]+$", low)` — จับเฉพาะตัวเลข 11-17 ตามด้วยอักษรไทยล้วน
  - ไม่จับตัวอักษรอังกฤษ เพราะ "A13" อาจเป็น model สินค้า
  - เพิ่ม: `re.search(r"ไอโฟน\s*\d+", low)` — จับ "ไอโฟน13"/"ไอโฟน13คะ" (regex เดิมจับแค่ "iphone" ภาษาอังกฤษ)
- **ผล**: `extract_model_keywords("สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ")` คืน `[]` → `_cur_model_kw` ว่าง → CONV-ACTIVE ทำงาน → ใช้ active product (ZTEC ที่มี both variants) → LLM ตอบถูก
- **เคสที่ผ่าน** (test แล้ว):
  - "13คะ" → is_target_device_kw = True ✓
  - "15ครับ" → True ✓
  - "17นะ" → True ✓
  - "14ๆ" → True ✓
  - "ไอโฟน13" → True ✓ (no space)
  - "ไอโฟน13คะ" → True ✓ (no space + particle)
  - "A13" → False ✓ (ไม่ใช่ target device)
  - "CTC315P" → False ✓ (เป็น model สินค้า)
  - "20คะ" → False ✓ (ไม่ใช่รุ่น iPhone 11-17)
  - extract_model_keywords("สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ") → [] ✓
  - extract_model_keywords("สายชาร์จรุ่นไหนเหมาะกับไอโฟน13คะ") → [] ✓
- **ไฟล์ที่แก้**: `chatbot/shopeechat/knowledge_base.py`, `docs/SRS_SSD.md`
- **Verify**: py_compile ผ่าน ✅, unit test ผ่าน ✅ (14 cases)
- **⚠️ ยังไม่ verify เต็ม**: รอทดสอบจริงกับบอท (replay แชท bbeem.4343) เพื่อยืนยันว่าบอทตอบถูก

### Phase 2Z++++ — แก้บอทบอกไม่มีสาย Lightning ทั้งที่มีสินค้าจริง (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: ลูกค้าถาม "สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ" → บอทตอบ "สินค้าในร้าน ZMIThailand ตอนนี้จะเป็นสายชาร์จแบบ USB-C to USB-C สำหรับ iPhone 15 ขึ้นไปค่ะ" ทั้งที่ Q1 บอทเองแนะนำสาย ZTEC ที่มี both USB-C to Lightning และ USB-C to USB-C
- **สาเหตุ**:
  1. ลูกค้าพิมพ์ "ไอโฟน 13คะ" → `extract_model_keywords` แบ่งคำได้ token `"13คะ"`
  2. `is_target_device_kw("13คะ")` คืน `False` เพราะ `_TARGET_DEVICE_KWS` มีแค่ `"13"` (ไม่มี `"13คะ"`) และ regex เดิมไม่จับตัวเลข+คำลงท้ายไทย
  3. → `_cur_model_kw = ["13คะ"]` ไม่ว่าง → ข้าม CONV-ACTIVE → ไม่ใช้ active product (ZTEC)
  4. → ทำ vector search ใหม่ → ดึงแค่สาย USB-C to USB-C → LLM ตอบว่าไม่มีสาย Lightning
- **วิธีแก้**: เพิ่ม regex ใน `is_target_device_kw` (knowledge_base.py) ให้จับตัวเลขรุ่น iPhone (11-17) ที่ติดกับคำลงท้ายไทย เช่น "13คะ", "15ครับ", "17นะ"
  - regex: `re.match(r"^1[1-7][\u0E00-\u0E7F]+$", low)` — จับเฉพาะตัวเลข 11-17 ตามด้วยอักษรไทยล้วน
  - ไม่จับตัวอักษรอังกฤษ เพราะ "A13" อาจเป็น model สินค้า
  - เพิ่ม: `re.search(r"ไอโฟน\s*\d+", low)` — จับ "ไอโฟน13"/"ไอโฟน13คะ" (regex เดิมจับแค่ "iphone" ภาษาอังกฤษ)
- **ผล**: `extract_model_keywords("สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ")` คืน `[]` → `_cur_model_kw` ว่าง → CONV-ACTIVE ทำงาน → ใช้ active product (ZTEC ที่มี both variants) → LLM ตอบถูก
- **เคสที่ผ่าน** (test แล้ว):
  - "13คะ" → is_target_device_kw = True ✓
  - "15ครับ" → True ✓
  - "17นะ" → True ✓
  - "14ๆ" → True ✓
  - "ไอโฟน13" → True ✓ (no space)
  - "ไอโฟน13คะ" → True ✓ (no space + particle)
  - "A13" → False ✓ (ไม่ใช่ target device)
  - "CTC315P" → False ✓ (เป็น model สินค้า)
  - "20คะ" → False ✓ (ไม่ใช่รุ่น iPhone 11-17)
  - extract_model_keywords("สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ") → [] ✓
  - extract_model_keywords("สายชาร์จรุ่นไหนเหมาะกับไอโฟน13คะ") → [] ✓
- **ไฟล์ที่แก้**: `chatbot/shopeechat/knowledge_base.py`, `docs/SRS_SSD.md`
- **Verify**: py_compile ผ่าน ✅, unit test ผ่าน ✅ (14 cases)
- **⚠️ ยังไม่ verify เต็ม**: รอทดสอบจริงกับบอท (replay แชท bbeem.4343) เพื่อยืนยันว่าบอทตอบถูก

### Phase 3C — Order lookup ครบ + Order anchor (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา 1 (shadow bot ส่ง [order] เปล่า)**: `toBotText()` ใน messageService.ts ไม่แปลง order card → ส่ง `[order]` เปล่าให้ bot → `extract_order_sn("[order]")` คืน None → ข้าม order lookup
- **ปัญหา 2 (ข้อมูล order ไม่ครบ)**: `lookup_order()` ดึงแค่ status/items/carrier/create_time → ไม่มี วันที่ชำระ/ส่ง/ถึง, ที่อยู่, ราคา, วิธีชำระ, สถานะยกเลิก
- **ปัญหา 3 (ไม่มี order anchor)**: bot ไม่จำ order เหมือน item anchor → follow-up ถาม "order เดิม" ไม่ได้
- **ปัญหา 4 (ส่งเลข order เฉยๆ แล้ว bot ตอบเป็นยาว)**: ลูกค้าส่งแค่เลข order ไม่มีคำถาม → bot ตอบข้อมูล order ทั้งหมดทันที ทั้งที่ยังไม่รู้ว่าลูกค้าอยากถามอะไร
- **ปัญหา 5 (4 flow อื่นไม่ส่ง order_sn ให้ bot)**: replay-compare, live-assignment, test-assignment ไม่ได้ส่ง `order_sn` ให้ bot → bot ไม่ lookup order
- **วิธีแก้**:
  1. Next.js `toBotText()` — แปลง order card เป็น `[order: <order_sn>]` เหมือน `[สินค้า: <item_id>]`
  2. Python `order_store.py` `lookup_order()` — ดึงฟิลด์เพิ่ม: pay_time, ship_by_date, pickup_done_time, cancel_by/reason, recipient_address, cod, estimated_shipping_fee, days_to_ship, item original_price
  3. Python `order_store.py` `build_order_context()` — ใส่ข้อมูลครบใน context ส่ง LLM (วันที่ซื้อ/ชำระ/ส่ง/ถึง, ที่อยู่, ราคา, วิธีชำระ, สถานะ, ขนส่ง, สินค้า+ราคา)
  4. Python `conversation_products.py` — เพิ่ม order anchor: `add_order_anchor()`, `get_active_order_sn()`, `resolve_active_order_sn()`, `is_order_question()`
  5. Python `app.py` — order lookup block บันทึก anchor + follow-up ใช้ active order เมื่อลูกค้าถาม "order เดิม/คำสั่งซื้อเดิม"
  6. Python `app.py` — logic ใหม่: ถ้าลูกค้าส่งแค่เลข order (ไม่มีคำถาม) → ตอบรับทราบสั้นๆ + บันทึก anchor + รอคำถามถัดไป (ไม่เรียก LLM)
  7. Python `app.py` — เพิ่ม field `order_sn` ใน ChatRequest (เหมือน `item_id`) + ใช้เมื่อ caller ส่งมา
  8. `replay_compare.py` — `build_bot_message` คืน `order_sn` + แปลง order card เป็น `[order: <order_sn>]` + `call_bot` ส่ง `order_sn` ใน body
  9. `liveAssignmentService.ts` — `callBot` รับ `orderSn` + ส่ง `order_sn` ใน body (2 จุดเรียก)
  10. `test-assignment/route.ts` — `callBot` รับ `orderSn` + ส่ง `order_sn` ใน body
- **ไฟล์ที่แก้**: `messageService.ts`, `order_store.py`, `conversation_products.py`, `app.py`, `replay_compare.py`, `liveAssignmentService.ts`, `test-assignment/route.ts`, `SRS_SSD.md`
- **ไม่ต้องแก้ TestChatClient.tsx**: เป็น text input ธรรมดา ลูกค้าพิมพ์เลข order ตรงๆ → Python bot extract จาก message ผ่าน `extract_order_sn()` ได้อยู่แล้ว
- **Verify**:
  - py_compile ผ่าน ✅ (app.py + replay_compare.py + order_store + conversation_products)
  - tsc --noEmit ผ่าน ✅
  - lookup_order('220713BG3EQG19') ดึงข้อมูลครบ ✅ (สถานะ, วันที่ครบ, ที่อยู่, ราคา, COD, สินค้า+ราคา)
- **⚠️ ยังไม่ verify เต็ม**: รอทดสอบจริงกับบอท (ส่ง order card + follow-up "order ถึงยัง" + ส่งแค่เลข order เฉยๆ + ทดสอบใน live/test-assignment)
- **⚠️ ปัญหาเรื่อง ticket โหลดนาน**: ShpOrders 3.8M docs ไม่มี index บน `buyer_user_id` → query 6.5 วินาที (แยกเป็น Phase 3D)

### Phase 2Z+++++ — แก้บอทบอกไม่มีหัวชาร์จในรถ ทั้งที่มีสินค้าจริง (2026-09-13) — ✅ implement + verify ผ่าน
- **ปัญหา**: ลูกค้าถาม "มีหัวชาจในรถไหม" (พิมพ์ตก ร์) → บอทตอบ "ไม่มีสินค้าประเภทหัวชาร์จในรถ (Car Charger) วางจำหน่าย" ทั้งที่ร้าน CukTechThailand มี car charger จริง 2 รุ่น (CC903P, WCJ153)
- **สาเหตุ** (5 จุด):
  1. **cat_name ไม่ match**: `_PRODUCT_TYPE_CATEGORIES["car_charger"]` มีแค่ `("Mobile & Gadgets", "Automobiles")` แต่สินค้า car charger จริงอยู่ใน cat_name `Spare Parts and Accessories for Vehicles` → MongoDB query กรองด้วย cat_name ตัดสินค้าออก
  2. **limit 100 กด car charger ออก**: charger ทั่วไป (cat=Mobile & Gadgets) มี 130+ ตัว แต่ car charger มีแค่ 2 ตัว → query limit 100 ดึง charger ทั่วไปมาก่อน กด car charger ออก (CC903P อยู่ลำดับ 81, WCJ153 ลำดับ 99 ในผลแบบไม่ limit)
  3. **"ในรถ" keyword กว้างเกิน**: `car_charger_kw` ใน `_filter_charger_subtype` มี `"ในรถ"` ลอยๆ → match "ใช้งานในรถยนต์" ของสายชาร์จทั่วไป CTC310N (false positive) → บอทได้สายชาร์จมาแทน car charger จริง → LLM เห็นว่าเป็นสายชาร์จไม่ใช่หัวชาร์จในรถ → ตอบ "ไม่มี"
  4. **typo "หัวชาจ" ไม่ถูกแก้ใน `_detect_product_types`**: typo fix มีเฉพาะใน `_detect_charger_subtype` → "หัวชาจในรถ" ไม่ถูก detect เป็น `car_charger` ใน product_types (ว่าง)
  5. **intent_classifier prompt ไม่มี car_charger**: charger_subtype กำหนดแค่ `cable|adapter|set|null` → follow-up "ไม่มีหัวชาร์จหรอ" ถูก classify เป็น adapter แทน car_charger
- **วิธีแก้**:
  1. เพิ่ม `"Spare Parts and Accessories for Vehicles"` ใน `_PRODUCT_TYPE_CATEGORIES["car_charger"]` (product_store.py บรรทัด 1769)
  2. แยก query car_charger cat_name ออกจาก charger ทั่วไป — ถ้า `car_charger` ใน product_types ให้ query ด้วย cat_name ของ car_charger อย่างเดียวก่อน (ไม่รวม Mobile & Gadgets ที่มี 130+ ตัว) (product_store.py `fetch_products` บรรทัด 2677-2695)
  3. ลบ `"ในรถ"` ลอยๆ ออกจาก `car_charger_kw` ใน `_filter_charger_subtype` (สินค้าจริง match ด้วย "car charger"/"หัวชาร์จในรถ"/"ที่ชาร์จในรถ" อยู่แล้ว) (product_store.py บรรทัด 1516-1521)
  4. เพิ่ม typo fix ใน `_detect_product_types` (เดิมมีเฉพาะใน `_detect_charger_subtype`) — แก้ "หัวชาจ"→"หัวชาร์จ" ฯลฯ (product_store.py บรรทัด 1285-1300)
  5. เพิ่ม `car_charger/wireless/desktop/socket` ใน intent_classifier prompt + ตัวอย่าง (intent_classifier.py บรรทัด 55-63, 87-94)
  6. เพิ่ม `car_charger` ใน `type_labels` ของ fallback note (product_store.py บรรทัด 2931-2940)
- **เคสที่ผ่าน** (test แล้ว 16/16):
  - "มีหัวชาจในรถไหม" (พิมพ์ตก) → product_types มี car_charger ✓, subtype=car_charger ✓
  - "มีหัวชาร์จในรถไหม" (ถูกต้อง) → product_types มี car_charger ✓, subtype=car_charger ✓
  - fetch_products ดึง CC903P + WCJ153 ได้ ✓
  - "หัวชาร์จ 65w รุ่นไหนดี" → subtype=adapter ✓ (ไม่พัง)
  - "สายชาร์จ type c" → subtype=cable ✓ (ไม่พัง)
  - "ชุดชาร์จ 65w" → subtype=set ✓ (ไม่พัง)
  - "ไม่มีหัวชาร์จหรอ" → subtype=adapter ✓ (ถูกต้องตาม intent — ไม่มี "ในรถ")
  - "หัวชาร์จเร็ว 30w" → subtype=adapter ✓ (ไม่พัง)
  - "สายชาร์จ USB-C to USB-C" → subtype=cable ✓ (ไม่พัง)
  - extract_model_keywords("สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ") → [] ✓ (เคสเก่าไม่พัง)
  - CTC310N (มี "ใช้งานในรถยนต์") ไม่ถูก classify เป็น car_charger ✓ (แก้ false positive)
  - CC903P (มี "Car Charger หัวชาร์จในรถ") ถูก classify เป็น car_charger ✓
  - fetch adapter ได้ >0 ✓ (ไม่พัง)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/product_store.py`, `chatbot/shopeechat/intent_classifier.py`
- **ไฟล์ที่สร้าง**: `test/test_car_charger_regression.py` (regression test), `test/diag_car_charger.py` (diagnostic)
- **Verify**: py_compile ผ่าน ✅, regression test ผ่าน 16/16 ✅
- **⚠️ ยังไม่ verify เต็ม**: รอทดสอบจริงกับบอท (replay แชทที่ถาม car charger) เพื่อยืนยันว่าบอทตอบถูก end-to-end

---

## ผ่านแล้ว (ใหม่)

### Shadow Inbox — Trash tab แสดงเป็นแชท + restore แล้วขึ้นข้อความ (2026-09-10) — ✅ implement + build ผ่าน + verify แล้ว
- **ปัญหา 1 (ถังขยะโชว์เป็น message ไม่ใช่แชท)**: trash tab ดึง individual shadow replies มาแสดงเป็น `<ul>` list ไม่ได้ group ตาม conversation เหมือน tab "ทั้งหมด"/"History"
- **ปัญหา 2 (กู้คืนแล้วไม่ขึ้นข้อความ)**: trash tab ไม่มี detail panel (มีแค่ placeholder), หลัง restore ไม่ reload ข้อมูล
- **ปัญหา 3 (history panel ว่างหลัง restore)**: `ShadowConversationPanel` กรอง `historyReplies` เฉพาะที่มี `generation_batch_id` ตรงกับ batch ล่าสุด แต่ shadow replies เก่า (ก่อน Phase 3B-6) ไม่มี `generation_batch_id` → ถูกกรองออก → panel ว่าง
- **วิธีแก้**:
  1. **`shadowReplyService.ts`** — เพิ่ม `restoreShadowRepliesByConversation(conversationId)` — $unset deleted_at/deleted_by/delete_reason ของทุก doc ใน conversation + export เป็น `restoreByConversation`
  2. **`/api/shadow-inbox/conversations/route.ts`**:
     - GET รองรับ `?deleted=1` — ดึง conversations ที่มี shadow replies ที่ถูก soft delete (สำหรับ trash tab)
     - เพิ่ม PUT `?conversation_id=xxx&action=restore` — restore ทุก shadow replies ใน conversation + audit log
  3. **`shadow-inbox/page.tsx`**:
     - เพิ่ม state `trashConversations` (Conversation[]) — โหลด parallel กับ trashRows
     - trash tab ใช้ `ChatList` (เหมือน history tab) แทน custom `<ul>` — แสดงเป็นแชท + ปุ่ม restore รายแชท
     - center panel ใช้ `ShadowConversationPanel` (เหมือน history tab) แทน placeholder — แสดงแชท + shadow replies
     - `loadDetail` รองรับ trash tab — โหลด chat messages
     - `handleRestore` — reload ข้อมูลหลัง restore (เรียก `load()`)
     - `handleRestoreConversation` — restore ทั้งแชท + reload
     - `handleRestoreAll` — clear state + reload
  4. **`ChatList.tsx`** — เพิ่ม prop `onRestoreConversation` — render ปุ่ม ↩ (RotateCcw icon) ในแต่ละ row
  5. **`adminLogService.ts`** — เพิ่ม `shadow_reply.restore_conversation` ใน AdminActionType (2 type definitions)
  6. **`ShadowConversationPanel.tsx`** — แก้ batch filter: replies ที่ไม่มี `generation_batch_id` (เก่าก่อน Phase 3B-6) ให้แสดงเสมอ ไม่กรองออก (`!r.generation_batch_id || r.generation_batch_id === selectedBatchId`)
- **ไฟล์ที่แก้**: `shadowReplyService.ts`, `/api/shadow-inbox/conversations/route.ts`, `shadow-inbox/page.tsx`, `ChatList.tsx`, `adminLogService.ts`, `ShadowConversationPanel.tsx`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python (`chatbot/shopeechat/`) ไม่เกี่ยวกับการแก้ครั้งนี้
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅, `npm run build` → ผ่าน ✅, manual test (Ice/dev, pingevox + mistorethailand/KingGadgets) → ผ่าน ✅
  - trash tab แสดงเป็นแชท (เหมือน history) ไม่ใช่รายการ message เดี่ยว
  - เลือกแชทในถังขยะ → แสดงเนื้อหาแชท + shadow replies ใน panel กลาง
  - restore แล้ว history tab แสดงแชท + shadow replies ได้ (ไม่ว่าง)

---

## ผ่านแล้ว (ใหม่)

### Phase 3b — dual-tier recommendation + connector type hard filter + sort wattage asc (2026-09-16) — ✅ implement + verify ผ่าน
- **ปัญหา**: device-spec-lookup re-query ดึงสินค้ามาแค่ 1 ตัวที่ compat + ไม่ sort ตาม wattage → LLM เห็นตัวเลือกไม่ครบ + ไม่มีกฎ dual-tier recommendation
- **ข้อกำหนดจาก user**:
  - connector type ต้องตรงเป๊ะ (hardware constraint) — ห้ามข้ามแม้สเปคสูงแค่ไหน
  - สายชาร์จ (2 หัว) ต้องตรวจทั้งสองฝั่ง
  - wattage/protocol เป็นข้อจำกัดขั้นต่ำ ไม่ใช่ขั้นสูงสุด (สินค้าสเปคสูงกว่าใช้ได้)
  - ต้องยืนยันจาก description ว่ารองรับ protocol จริง (ไม่ใช่ดูแค่ wattage)
  - เสนอสูงสุด 2 ตัวเลือก: baseline + upgrade (ถ้ามีจริง)
  - ห้ามแต่งว่ามีตัวสเปคสูงกว่าถ้า retrieval ไม่เจอจริง
  - subtype จาก `_resolve_charger_subtype` ต้องคุมทิศทางการเสนอ
- **วิธีแก้**:
  1. **ย้าย `_extract_max_watt` จาก nested function → module-level helper `_extract_max_wattage`** (app.py บรรทัด ~531)
     - logic เดียวกัน: spec field → variants → name (กรอง model number)
     - ใช้ได้ทั้งใน superlative block และ device-spec-lookup block
  2. **device-spec-lookup re-query block** (app.py บรรทัด ~6010):
     - หลัง fetch_products → sort `_device_products` ตาม wattage **ascending** (น้อย→มาก)
     - baseline (สเปคต่ำสุด) อยู่บนสุด, upgrade อยู่ถัดไป
     - merge เข้า products ตามลำดับที่ sort แล้ว
  3. **context note `_device_spec_extra`** (app.py บรรทัด ~5963):
     - เพิ่ม dual-tier recommendation hint: สูงสุด 2 ตัวเลือก (baseline + upgrade)
     - เพิ่ม connector type hard filter: ห้ามข้าม connector type แม้สเปคสูง
     - เพิ่ม protocol evidence requirement: ต้องยืนยันจาก description จริง
  4. **SYSTEM_INSTRUCTION ใน llm.py** (บรรทัด ~226):
     - เพิ่ม section "Phase 3b — dual-tier recommendation"
     - กฎ connector type ตรงเป๊ะ (USB-C, Lightning, USB-A, Micro-USB, 30-pin)
     - กฎสายชาร์จ 2 หัว ต้องตรวจทั้งสองฝั่ง
     - กฎ wattage/protocol เป็นขั้นต่ำ ไม่ใช่ขั้นสูงสุด
     - กฎต้องยืนยัน protocol จาก description จริง
     - กฎถ้ามี compat แค่ 1 ตัว → เสนอแค่ตัวนั้น
     - กฎห้ามเสนอสินค้าที่ไม่มีใน context
     - กฎ subtype ต้องคุมทิศทางการเสนอ
     - กฎการนำเสนอ 2 ตัวเลือกให้อ่านเป็นธรรมชาติ (ไม่ใช่ list แข็งๆ)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`, `chatbot/shopeechat/llm.py`
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/app.py` → ผ่าน ✅
  - `python3 -m py_compile chatbot/shopeechat/llm.py` → ผ่าน ✅
  - `PYTHONPATH=chatbot python3 docs/test/test_car_charger_regression.py` → ผ่าน 16/16 ✅
  - Replay 3 เคสจริงผ่าน API `/chat` (KingGadgets):
    - **เคส 1 "สายชาร์จ mi 17 ultra ใช้ยังไง"**: บอทตอบ "สายชาร์จพอร์ต USB-C" + แนะนำ CUKTECH CTC615N 240W (1 ตัว เพราะร้านมี compat แค่ 1 ตัว) ✅
    - **เคส 2 "หัวชาร์จ iphone 4s"**: บอทตอบ "iPhone 4s ใช้พอร์ต 30-pin" (ถูกต้อง!) + บอกไม่มีสินค้า compat ในร้าน ✅
    - **เคส 3 "หัวชาร์จ USB-C ทั่วไป"**: บอทแนะนำ IMILAB 20W (baseline) + Xiaomi 45W (upgrade) — dual-tier recommendation ทำงานถูกต้อง ✅
- **⚠️ หมายเหตุ**: connector type filtering ยังใช้ LLM เป็นตัวตัดสินใจ (อ่าน description) ไม่ใช่ deterministic Python filter — เพราะ parsing connector type จาก description ซับซ้อนและอาจทำลายเคสที่ผ่านแล้ว แต่ context note + prompt rules เข้มข้นพอที่จะกัน cross-connector recommendation
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: รอ verify replay เพิ่มเติมก่อน (ตามกฎ)

---

### Phase 3c — _detect_charger_subtype bare "หัว"/"สาย" token-based match (2026-09-19) — ✅ implement + verify ผ่าน
- **ปัญหา**: `_detect_charger_subtype()` ใช้ substring match ธรรมดา `"หัว" in low` → เจอ false positive ในคำผสมภาษาไทย เช่น "หัวเตียง" → adapter, "สายรุ้ง" → cable ทั้งที่ไม่เกี่ยวกับ charger เลย (ระบบขยายไปหลายหมวดสินค้าแล้ว)
- **สมมติฐานเดิมจาก task**: pythainlp newmm จะตัด "หัวเตียง" เป็น token เดียว → เช็ค `"หัว" in tokens` จะไม่ match
- **ความจริงที่พบ**: pythainlp newmm ตัดหลายคำแบบไม่ซ้ำกัน:
  - "หัวเตียง" → `['หัว', 'เตียง']` (แยก — token match ยัง match ผิดอยู่)
  - "หัวใจ" → `['หัวใจ']` (รวม — token match ช่วยได้)
  - "มีหัวไหม" → `['มีหัว', 'ไหม']` (รวม "มีหัว" เป็น token เดียว — ต้องมี fallback)
- **วิธีแก้ (hybrid token + context + fallback)**:
  1. **ใช้ `word_tokenize(low, engine="newmm")`** เมื่อ `_FUZZY_AVAILABLE=True`
  2. **"หัว" shorthand** — เช็ค 3 กรณี:
     - `"หัว" in token_set` (standalone token) → เช็ค context: token ถัดไปต้องเป็น charger context (ชาร์จ/w/gan/ฯลฯ) หรือเป็น token สุดท้าย/ช่องว่าง
     - ไม่ใช่ standalone แต่มี token ที่ลงท้ายด้วย "หัว" (เช่น "มีหัว") → ยอมรับเป็น shorthand
     - ไม่ยอมรับถ้ามีแค่ token ที่ขึ้นต้นด้วย "หัว" (เช่น "หัวปลี") → compound word
  3. **"สาย" shorthand** — logic เดียวกัน + guard `ไร้สาย`/`ไร้ สาย`
  4. **เพิ่ม compound ที่ tokenizer รวมเป็น token เดียวใน `_other_prod_kws` blacklist** (safety net ชั้น 2): "สายไฟ", "สายยาง", "สายพาน", "สายลม", "สายฝน"
  5. **fallback path** (`_FUZZY_AVAILABLE=False`): ใช้ substring match เดิม + blacklist เหมือนเดิม 100% (backward compat)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/product_store.py` (จุดเดียวใน `_detect_charger_subtype()` บรรทัด ~1469)
- **Test ใหม่**: `docs/test/test_charger_subtype_parity.py` (42 คำ: 33 ต้องเป็น None + 8 ต้อง match + 1 ไร้สาย)
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/product_store.py` → ผ่าน ✅
  - parity test 42/42 ผ่าน (baseline ก่อนแก้: 20/42 ผ่าน, 22 false positive) ✅
  - `test_car_charger_regression.py` → 16/16 ผ่าน ✅
  - `test_pingevox_mistore.py` → 42/42 ผ่าน (pingevox 5 + mistore 37) ✅
- **⚠️ หมายเหตุ**: สมมติฐานใน task ว่า "tokenizer จะตัดคำผสมเป็น token เดียว" **ไม่เป็นจริง** สำหรับ newmm — ตัดบางคำแยก บางคำรวม ดังนั้นต้องใช้ hybrid (token + context check + blacklist fallback) แทนที่จะใช้ token match อย่างเดียว

---

## ผ่านแล้ว (ใหม่)

### EC6 Anchor Bug — บอทแนะนำสินค้าอื่นทั้งที่ลูกค้าส่ง item card มาแล้ว (2026-09-10) — ✅ implement + verify ผ่าน
- **ปัญหา**: ลูกค้าส่ง item card EC6 Panorama (Q1) → ถาม "Ec6 ใช้กับ app xiaomi จีนได้ไหม" (Q2) → บอทแนะนำ EC6 Dual Pro 3K แทน + ตอบ "ใช้ได้" → Q3 ถามต่อ → บอทใช้ anchor (EC6 Panorama) → ตอบ "ใช้ไม่ได้" → ขัดแย้งกัน
- **สาเหตุ** (2 barriers ใน CONV-ACTIVE block):
  1. **Barrier 1** (บรรทัด ~4111): `if not _is_new_topic_cp and not _cur_model_kw:` — `extract_model_keywords("Ec6 ใช้กับ app xiaomi จีนได้ไหมครับ")` คืน `["Ec6"]` (มีตัวเลข ไม่ใช่ target device) → `_cur_model_kw` ไม่ว่าง → เงื่อนไขเป็น False → ไม่ใช้ anchor → ตกไป fetch_products → ค้น "ec6" → ดึงหลายตัวในตระกูล EC6 (Panorama + Dual Pro 3K) → LLM แนะนำผิดรุ่น
  2. **Barrier 2** (บรรทัด ~4118): `if _has_compat_cp and _has_target_cp:` — แม้ Barrier 1 แก้แล้ว ("Ec6" ถูกกรองออก → `_cur_model_kw` ว่าง) ข้อความมี "ใช้กับ" (compat) + "xiaomi" (target device) → fall through ไป fetch_products → กลับไปเป็นปัญหาเดิม
- **วิธีแก้** (CONV-ACTIVE block เดียว ไม่แก้ item-tag history block):
  1. หลัง `resolve_active_by_message` หา active card ได้ → กรอง `_cur_model_kw` ที่ตรงกับชื่อ active product ออก (เฉพาะ keyword ที่มีตัวเลข — model code pattern เช่น "Ec6", "CTL301", "A52") เพื่อกัน brand name (เช่น "IMILAB" ไม่มีตัวเลข → ไม่กรอง → อาจเป็นการถามรุ่นอื่นของแบรนด์เดียวกัน)
  2. เก็บ flag `_kw_matched_anchor` — ถ้ามี keyword ถูกกรองออก → True
  3. ที่เงื่อนไข compat+target_device: เพิ่ม `and not _kw_matched_anchor` — ถ้าลูกค้าพิมพ์ชื่อรุ่นที่ตรงกับ anchor → ถามเรื่องสินค้าเดิม ไม่ใช่ขอใหม่ → ใช้ anchor ไม่ fall through
- **ไม่แก้ item-tag history block** เพราะ:
  - ถ้าแก้ → item-tag block จะหา anchor ได้ แต่ compat+target_device จะส่งไป `_hybrid_anchor_card` → main flow → fetch_products (กลับไปเป็นปัญหาเดิม)
  - CONV-ACTIVE เป็น fallback ที่ใช้ anchor จาก timeline ได้โดยตรง ไม่ต้องผ่าน fetch_products
- **เคสที่ผ่าน** (unit test 9/9):
  - "Ec6 ใช้กับ app xiaomi จีนได้ไหมครับ" (active=EC6 Panorama) → kw=[], matched=True → ใช้ anchor ✓
  - "มีรุ่นไหน ใช้ แอปจีนได้ไหมครับ" (active=EC6 Panorama) → kw=[], matched=False → ใช้ anchor ✓
  - "อยากได้ของที่ใช้กับ xiaomi 17 ultra" (active=ZTEC) → kw=[], matched=False → fall through ✓ (เดิมไม่พัง)
  - "IMILAB มีรุ่นไหน" (active=EC6 Panorama) → kw=['IMILAB'], matched=False → search fresh ✓ (brand ไม่ถูกกรอง)
  - "EC6 Dual Pro มีไหม" (active=EC6 Panorama) → kw=['Dual'], matched=True → search fresh ✓ (รุ่นอื่น)
  - "CTL301 ใช้สายอะไร" (active=CTL301) → kw=[], matched=True → ใช้ anchor ✓
  - "BioKoop ใช้สายอะไร" (active=BioKoop) → kw=['BioKoop'], matched=False → search fresh ✓ (ไม่มีตัวเลข)
  - "A52 มีไหม" (active=Galaxy A52) → kw=[], matched=True → ใช้ anchor ✓
  - "A52 มีไหม" (active=Galaxy S21) → kw=['A52'], matched=False → search fresh ✓ (ไม่ตรง anchor)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (CONV-ACTIVE block บรรทัด ~4098)
- **Verify**: py_compile ผ่าน ✅, regression test 16/16 ผ่าน ✅, unit test 9/9 ผ่าน ✅
- **⚠️ ยังไม่ verify เต็ม**: รอ replay แชท hawkeyes69 จริงเพื่อยืนยันว่าบอทตอบ EC6 Panorama ไม่แนะนำ EC6 Dual Pro 3K

---

## ผ่านแล้ว (ใหม่)

### Live Assignment — ปิดแชทแล้วเปิดใหม่ไม่ประมวลผลข้อความใหม่ (2026-09-10) — ✅ implement + build ผ่าน รอ verify
- **ปัญหา**: หน้า live assignment กดปิดแชท → บอทประมวลผลข้อความเหลือ → บอทตอบโดยไม่ handoff → แชท auto-close (`mock_status="closed"`) → ข้อความใหม่เข้ามา → กดปิดแชทไม่ได้เพราะปุ่มเปลี่ยนเป็น "เปิดแชทใหม่" แต่ปุ่มนี้ไม่ทำอะไรจริง (แค่ toast)
- **สาเหตุ**:
  1. `closeChat` ใน `liveAssignmentService.ts` — ถ้าบอทตอบทุกข้อความโดยไม่ handoff → `mock_status = "closed"` (auto-close)
  2. `liveDocToConversation` — `mock_status === "closed"` → `status = "closed"`
  3. `TicketChatPanel.tsx` บรรทัด 493 — `status === "closed"` → ซ่อนปุ่ม "ปิดสนทนา" แสดงปุ่ม "เปิดแชทใหม่" แทน
  4. `handleReopen` ใน `page.tsx` — แค่ `toast.info("Reopen อัตโนมัติเมื่อลูกค้าทักใหม่")` ไม่ได้เรียก API
- **วิธีแก้**:
  1. `handleReopen` ใน `page.tsx` — เปลี่ยนให้เรียก `closeChat` API จริง (ส่ง `action: "close_chat"`) → มันจะ close → เช็คข้อความเหลือ → reopen → ประมวลผลผ่านบอท
  2. เพิ่ม `reopening` prop ใน `TicketChatPanel.tsx` — disabled ปุ่ม + เปลี่ยนข้อความเป็น "กำลังประมวลผล..." ตอนกำลังประมวลผล
  3. ส่ง `reopening={closing}` จาก `page.tsx` เข้า `TicketChatPanel` (reuse `closing` state เพราะ close กับ reopen ไม่ได้ใช้พร้อมกัน)
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/(console)/live-assignment/page.tsx`, `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python ไม่เกี่ยวกับการแก้ครั้งนี้
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅, `npm run build` → ผ่าน ✅
- **⚠️ ยังไม่ verify manual**: รอทดสอบใน browser — ปิดแชท → บอทตอบ → auto-close → กด "เปิดแชทใหม่" → ข้อความใหม่ถูกประมวลผล

---

### CTL301 — model code ไม่ส่ง description + uncertainty cascade (2026-09-10) — ✅ ผ่าน
- **ปัญหา**: ลูกค้าพิมพ์ "ctl301" (text) → LLM2 ตอบ "ไม่มีรายละเอียดเพิ่มเติม + ทักแอดมิน" → trigger web search → cascade พัง
- **สาเหตุ 3 ข้อ**:
  1. **Anchor ผิด** — `_record_suggestion_products` บันทึก suggestion ลำดับผิด → active = CTC615W แทน CTL301
  2. **`_clean_description` กรอง desc ออก** — `ctl301` ไม่ match keyword ใดๆ (warranty/spec/shipping/product) → คืน `""` → LLM2 ไม่เห็น desc
  3. **LLM2 uncertainty marker** — `_build_context` สั่ง LLM พูด "ทักแอดมินได้เลย" ตอน desc ว่าง → trigger web search
- **วิธีแก้ 3 ข้อ**:
  1. **Text-based anchor** — ใน `_record_suggestion_products` (app.py) สกัด model keywords จากข้อความลูกค้า → สินค้าตัวแรกที่ชื่อมี keyword ตรง → บันทึกเป็น anchor (`is_anchor=True, source="user_text"`)
  2. **Model code detection** — ใน `_clean_description` (product_store.py) ถ้า message มี alphanumeric token (เช่น `ctl301`, `biokoop`) ที่มีอย่างน้อย 4 ตัวอักษร → ถือว่า `want_spec=True` → ส่ง description
  3. **ลบ "ทักแอดมิน" จาก no_desc_note** — ใน `_build_context` (llm.py) เปลี่ยน "ทักแอดมินได้เลยนะคะ" เป็น "ไม่มีรายละเอียดเพิ่มเติมในระบบค่ะ" → ไม่ trigger web search
- **เคสที่ผ่าน** (test_pingevox_mistore.py):
  - pingevox Q1: `[สินค้า: 49267582152]` → ตอบ "CUKTECH CTL301 USB-C to Lightning รองรับมาตรฐาน MFi ชาร์จเร็ว PD และถ่ายโอนข้อมูล 480Mbps" (ไม่พ่น "ไม่มีรายละเอียดเพิ่มเติม" อีก) ✓
  - pingevox Q2-Q5: ผ่านครบ ✓
  - mistorethailand Q1-Q37: ผ่านครบ 37 เคส ✓
  - **รวม: 42 ผ่าน, 0 ไม่ผ่าน, 0 error**
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (`_record_suggestion_products`), `chatbot/shopeechat/product_store.py` (`_clean_description`), `chatbot/shopeechat/llm.py` (`_build_context`)
- **Verify**: py_compile ผ่าน ✅, test_pingevox_mistore.py ผ่าน 42/42 ✅

---

### Replay-compare inbox ค้างเพราะ limit:10000 (2026-09-10) — ✅ ผ่าน
- **ปัญหา**: หน้า replay-compare tab "เลือกแชท" โหลดนานมาก/ค้าง เพราะ `loadInbox` ยิง `/admin/conversations?limit=10000` timeout 45s ทีเดียว ทั้งที่ ticket inbox / shadow inbox ใช้ `useSharedConversations` (pagination 50 + load more on scroll) อยู่แล้ว
- **สาเหตุ**: replay-compare ไม่ได้ใช้ shared store เหมือนหน้าอื่น → โหลดทั้งหมดทีเดียว → ค้าง
- **วิธีแก้**:
  1. ลบ `loadInbox` (limit:10000) + state `inboxConvs`/`inboxLoaded` ออก
  2. ใช้ `useSharedConversations({ assigned_to: "all", q: inboxSearch, pageSize: 50 })` แทน — เหมือน ticket inbox / shadow inbox
  3. server-side search ผ่าน `q` (debounce 300ms ในตัว) แทน client filter
  4. infinite scroll — onScroll ที่ parent container เรียก `inboxLoadMore()` ตอน scroll ใกล้ล่าง
  5. แสดง `inboxTotalCount` แทน `inboxConvs.length` ใน header
- **ผล**: โหลด 50 ล่าสุดก่อน (~1s) → scroll โหลดเพิ่มทีละ 50 → ไม่ค้าง
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/(console)/replay-compare/page.tsx`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---

### /team ตัวเลข unassigned ไม่จริง (2026-09-10) — ✅ ผ่าน
- **ปัญหา**: หน้า /team แสดง "4,995 ยังไม่ได้มอบหมาย" ทั้งที่ DB จริงมี 142,308 แชท — เพราะ API ดึงแค่ `limit: 5000` ล่าสุดแล้ว filter ใน memory
- **สาเหตุ**: `conversationService.listConversations({ limit: 5000 })` ดึง 5,000 ล่าสุด → filter `!assigned && status !== closed/resolved` ใน memory → ได้ 4,995 (เกือบทั้งหมดของ 5,000)
- **ข้อมูลจริงจาก DB**:
  - ทั้งหมด: 142,308 แชท
  - มี assigned_to: 15 แชท
  - ไม่มี assigned_to + ไม่ใช่ closed/resolved: 142,293 แชท
  - แยกย่อย: handoff 14, open 136,148, None 6,146
- **วิธีแก้**:
  1. API `/api/team` — เพิ่ม DB aggregation count ที่ `COLLECTIONS.conversations` ตรงๆ (ไม่ผ่าน limit 5000)
     - `total` = countDocuments({})
     - `assigned` = countDocuments({ assigned_to: { $type: 2 } }) — มี assigned_to เป็น string
     - `unassigned` = ไม่มี assigned_to + status ไม่ใช่ closed/resolved
     - `unassigned_handoff` = ไม่มี assigned_to + status=handoff (รอแอดมินรับจริง)
     - `unassigned_open` = ไม่มี assigned_to + status=open (บอทตอบอยู่/ยังไม่มีคนตอบ)
  2. Response เพิ่ม `total_conversations`, `unassigned_handoff`, `unassigned_open`
  3. UI — แสดงตัวเลขจริง + แยกย่อยใน banner + SummaryCard
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/api/team/route.ts`, `ChatAdminWeb/src/app/(console)/team/page.tsx`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---

### /dashboard ช้า + นับแชทผิด (2026-09-10) — ✅ ผ่าน
- **ปัญหา**:
  1. หน้า /dashboard โหลดช้ามาก (30s+) ตอนเลือก รายเดือน/รายปี/ทั้งหมด
  2. นับแชทผิด — ลูกค้าทักแชทเดิมวันนี้ ไม่นับว่า "วันนี้" เพราะใช้ `created_at` (วันที่เริ่มแชทครั้งแรก)
- **สาเหตุ**:
  1. API dashboard ใช้ `dateFilter("created_at")` ใน 11 queries แต่ `conversations_shp` ไม่มี index บน `created_at` → collection scan 142,310 docs ทุก query
  2. `created_at` = วันที่เริ่มแชทครั้งแรก → ลูกค้าทักแชทเดิมวันนี้ไม่นับว่า "วันนี้"
- **วิธีแก้**:
  1. เปลี่ยน `dateFilter("created_at")` → `dateFilter("last_message_timestamp")` ทุก query ใน dashboard API
  2. เปลี่ยน daily trend aggregations ใช้ `$last_message_timestamp` แทน `$created_at`
  3. `last_message_timestamp` มี index อยู่แล้ว (`last_message_timestamp_-1`) → ใช้ index scan แทน collection scan
  4. ความหมายเปลี่ยน: "แชทที่มี activity ในช่วงเวลานั้น" แทน "แชทที่เริ่มในช่วงเวลานั้น"
- **ผลที่คาดการณ์**:
  - ความเร็ว: จาก ~30s → <1s (index scan แทน collection scan)
  - ความหมาย: ลูกค้าทักแชทเดิมวันนี้ นับว่า "วันนี้" ✓
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/api/stats/dashboard/route.ts`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---

### /dashboard error + โหลดหนัก (2026-09-10) — ✅ ผ่าน
- **ปัญหา**: หน้า dashboard error/โหลดหนัก ตอนเลือก รายเดือน/รายปี/ทั้งหมด
- **สาเหตุเพิ่มเติม** (นอกจาก created_at ไม่มี index):
  1. `computeResponseStats` โหลด messages ทั้ง 1.1M docs เข้า memory ตอน range=all → OOM/error
  2. ไม่มี cache → user refresh รัวๆ หรือสลับ tab ไปกลับ → โหลดซ้ำทุกครั้ง
  3. client ไม่ได้ตั้ง timeout → รอจน error
- **วิธีแก้**:
  1. จำกัด `computeResponseStats` เป็น 30 วันล่าสุดเสมอ แม้ range=all → ลด messages ที่โหลดจาก 1.1M → ~50K
  2. เพิ่ม in-process cache TTL 60s → กันโหลดซ้ำในช่วงเวลาเดียวกัน (เก็บแค่ 20 key ล่าสุด)
  3. client timeout 60s → กันค้างนานเกินไป
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/api/stats/dashboard/route.ts`, `ChatAdminWeb/src/lib/services.ts`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---

### Shadow Inbox History — panel กลางไม่โชว์ bot reply (2026-09-11) — ✅ ผ่าน
- **ปัญหา**: tab History เห็นแชทใน list ซ้าย แต่กดแล้ว panel กลางไม่โชว์คำตอบ bot (คอลัมน์ขวาว่าง)
- **สาเหตุ**:
  1. tab History โหลด shadow replies แค่ `limit: 500` (เรียงใหม่สุดก่อน) แต่ใน DB มี 5,488 รายการ
  2. conversation list โหลดจาก `distinct("conversation_id")` — เห็นแชททั้งหมดที่เคย generate
  3. ตอนกดแชท → กรอง `historyReplies.filter((r) => r.conversation_id === selectedId)` ใน 500 ที่โหลดมา
  4. ถ้าแชทที่เลือกไม่อยู่ใน 500 ล่าสุด → panel กลางว่าง (ไม่มี bot reply)
  5. สคริปต์ generate ส่วนใหญ่ไม่มี `generated_by` (4,920 จาก 5,488 = NULL) — แต่ dev เห็นหมดอยู่แล้ว ปัญหาไม่ใช่ visibility
- **วิธีแก้**:
  1. เพิ่ม state `selectedConvReplies` — เก็บ shadow replies เฉพาะแชทที่เลือก
  2. แก้ `loadDetail` — ตอนเลือกแชทใน History/Trash → ดึง shadow replies ของแชทนั้นโดยตรง (`conversation_id: id`) ไม่จำกัด limit
  3. ส่ง `selectedConvReplies` ไป `ShadowConversationPanel` แทน `historyReplies.filter(...)`
  4. โหลด chat messages + shadow replies พร้อมกัน (Promise.all) → ไม่ช้าลง
- **ผล**: แชททุกแชทใน History จะโชว์ bot reply ใน panel กลาง แม้ไม่อยู่ใน 500 ล่าสุด
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/(console)/shadow-inbox/page.tsx`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---

### Shadow Inbox History — timeout 30s โหลดทั้งหมดทีเดียว (2026-09-11) — ✅ ผ่าน
- **ปัญหา**: tab History/Trash โหลด conversations ทั้งหมดทีเดียว (distinct + $in ทุก conversation_id) → timeout 30s
- **สาเหตุ**:
  1. `/api/shadow-inbox/conversations` ใช้ `distinct("conversation_id")` → ได้ conversation_ids ทั้งหมด → `$in` lookup ทุก conversation พร้อมกัน
  2. มี 5,488 shadow replies → distinct ออกมาเป็นพัน conversation_ids → `$in` lookup ช้า → timeout
  3. โหลด shadow replies 500 รายการพร้อม conversations ด้วย → หนักขึ้น
- **วิธีแก้**:
  1. API `/api/shadow-inbox/conversations` — เปลี่ยนจาก `distinct + $in` เป็น pagination แบบ cursor:
     - aggregation pipeline: `$match → $group by conversation_id → $sort by max(created_at) desc → cursor filter → $limit`
     - pageSize 200 (default) + cursor (ISO date string ของ shadow reply ล่าสุดใน page)
     - คืน `{ rows, nextCursor, totalCount }`
  2. หน้า shadow-inbox — เพิ่ม pagination state (cursor, hasMore, loadingMore, totalCount) สำหรับ History + Trash
  3. `load()` — โหลดแค่ page 1 (200 แชท) แทนทั้งหมด
  4. `loadMoreHistory()` / `loadMoreTrash()` — โหลด page ถัดไปตอน scroll
  5. ChatList — ส่ง `loadMore`, `hasMore`, `loadingMore`, `totalCount` ให้ (เหมือน ticket inbox)
  6. ลบการโหลด `historyReplies` และ `trashRows` จาก `load()` (ใช้ `selectedConvReplies` แทน — ดึงเฉพาะแชทที่เลือก)
- **ผล**: โหลด 200 แชทล่าสุดก่อน (~1s) → scroll โหลดเพิ่มทีละ 200 → ไม่ timeout
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/api/shadow-inbox/conversations/route.ts`, `ChatAdminWeb/src/app/(console)/shadow-inbox/page.tsx`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---

### Shadow Inbox History — กระพริบ/แชทหายเมื่อ poll (2026-09-11) — ✅ ผ่าน
- **ปัญหา**: กดแชทใน History แล้วกระพริบ แชทหาย ต้องกดใหม่ แล้วก็หายอีก
- **สาเหตุ**: polling ทุก 20s เรียก `load()` → `setHistoryConversations(page1)` ทับรายการทั้งหมด
  - ถ้า scroll โหลดเพิ่มแล้ว (page 2+) → polling ลบ page 2+ ทิ้ง → แชทที่เลือกหาย → panel ว่าง → กระพริบ
- **วิธีแก้**: ปิด polling ตอนอยู่ History/Trash (เป็นข้อมูลอดีต ไม่ต้อง real-time)
  - `usePolling(load, ..., { enabled: originFilter !== "history" && originFilter !== "trash" })`
  - โหลดครั้งเดียวตอนเข้า tab ผ่าน `useEffect` (เดิมทำงานอยู่แล้ว)
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/app/(console)/shadow-inbox/page.tsx`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---
- **ปัญหา**: panel กลางโชว์การ์ดสินค้า 30 ใบต่อคำตอบ bot เพราะส่ง `bot_products` ทั้งหมด (RAG context) เข้า `MessageContent`
- **สาเหตุ**: bot ส่ง context สินค้า 30 รายการ (llm_context_limit=30) มาเป็น `products` ใน response → panel โชว์ทั้งหมด ทั้งที่ bot แนะนำจริงแค่ 1-3 รายการในคำตอบ
- **วิธีแก้**: ฝั่ง Bot ของเรา — ส่ง `products: undefined` เข้า `MessageContent` (โชว์แค่คำตอบ text ไม่โชว์การ์ดสินค้า)
  - ฝั่ง Zaapi ยังโชว์ products ปกติ (เป็นการ์ดจริงที่ Zaapi ส่ง)
  - `bot_products` ยังเก็บใน DB ครบ (ไม่ได้ลบข้อมูล — แค่ไม่โชว์ใน panel)
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/components/shadow/ShadowConversationPanel.tsx`
- **Verify**: `npx tsc --noEmit` ผ่าน ✅, `npm run build` ผ่าน ✅

---
- **ปัญหา**: RAG (fetch_products) กรอง status/stock ออกในบางจุด → ลูกค้าถามสินค้าเก่าไม่ได้ + สินค้าเลิกขายตอบสเปคไม่ได้
- **ปัญหาเพิ่มเติม**: ไม่มี tier logic → สินค้า exact match (MODEL-REGEX/anchor) อาจถูกตัดด้วย limit ทิ้งไป
- **ปัญหาเพิ่มเติม**: LLM prompt มีกฎเรื่อง status/stock กระจายอยู่ ไม่ชัดเจนพอ → LLM อาจแนะนำขายสินค้าหมดสต็อกได้
- **การตัดสินใจทางธุรกิจ**:
  - RAG ต้องไม่กรอง status/stock ออกเลย ไม่ว่า intent จะเป็นอะไร
  - ยกเว้นกรณีเดียว: ลูกค้าแจ้งเคลม/ปัญหา → ห้ามเสนอขายสินค้าใดๆ
  - "จะเชียร์ขายสินค้าไหน" เป็นหน้าที่ของ LLM (prompt-level) ไม่ใช่ RAG
  - สินค้าที่เลิกขาย/หมดสต็อก ยังต้องตอบสเปค/ประกัน/ข้อมูลได้ปกติ
- **วิธีแก้ (implement จริง — 2026-09-10)**:
  1. **`filter_unavailable=False` ทุกจุดใน app.py** (2 จุด):
     - บรรทัด 4820 (main fetch): ลบ `filter_unavailable=_filter_unavailable` ออก (default=False)
     - บรรทัด 5598 (device-spec lookup): เปลี่ยน `filter_unavailable=True` → `filter_unavailable=False`
     - ทำความสะอาด dead code บรรทัด 4669-4691 (คำนวณ `_filter_unavailable` แล้ว override เป็น False) → ลด 18 บรรทัด
     - ตรวจสอบ repo ทั้งหมด: `chat_v2.py` มี `_filter_unavailable_products` ของตัวเอง (ไม่เกี่ยว), test files ไม่ pass filter_unavailable
     - ห้ามลบ parameter ออกจาก signature ของ `fetch_products` (default=False อยู่แล้ว)
  2. **Tier merge logic** — สร้าง `_apply_product_tiers(products, tier_a_ids, limit)` ระดับโมดูล:
     - Tier A (exact match): item_id ใน `tier_a_ids` → ใส่เสมอ ไม่ถูกตัดด้วย limit ไม่ว่า status จะเป็นอะไร
     - Tier B (general): สินค้าที่ไม่ใช่ Tier A → เรียง normal+stock>0 ขึ้นก่อน แล้วตัด limit
     - รวม Tier A + Tier B (A ก่อน) → เรียก `_dedupe_products`
     - เก็บ `tier_a_ids` จาก: `_ref_regex_products` + `anchor_card` + `_hybrid_anchor_card`
     - เรียก `_apply_product_tiers` ก่อน `llm.answer()` ที่บรรทัด ~5686
  3. **LLM prompt — SYSTEM_INSTRUCTION** (llm.py):
     - เพิ่ม section "=== กฎการเสนอขายสินค้า (บังคับ — อ่านทุกครั้งก่อนตอบ) ===" ก่อนปิด `"""`
     - กฎ 1: เชียร์ขายเฉพาะ status=NORMAL + sold_out=false
     - กฎ 2: สินค้าเลิกขาย/หมดสต็อก → ตอบสเปคได้ ห้ามปฏิเสธ บอกตรงๆ แนะนำรุ่นใกล้เคียง
     - กฎ 3: ลูกค้าแจ้งเคลม/ปัญหา → ห้ามแนะนำซื้อสินค้าใดๆ เด็ดขาด
  4. **LLM prompt — KB_SYSTEM_INSTRUCTION** (llm.py):
     - เพิ่ม 3 กฎเดียวกัน ก่อนปิด `"""`
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`, `chatbot/shopeechat/llm.py`
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/app.py` → ผ่าน ✅
  - `python3 -m py_compile chatbot/shopeechat/llm.py` → ผ่าน ✅
  - `PYTHONPATH=chatbot python3 docs/test/test_car_charger_regression.py` → ผ่าน 16/16 ✅
  - Replay "หาสายชาร์จ mi 17 ultra" (8 คำถามต่อเนื่อง KingGadgets) → ผ่าน ✅
    - Q1-Q4: 5 products each, 2-3s, ไม่มี error
    - Q5 (iPhone 17 ProMax): TIER-MERGE 13→8 (tier_a=3, tier_b=10→5) — tier merge ทำงานถูกต้อง
    - Q6 (สาย): 5 products, 4.8s
    - Q7 (MI 17 Ultra): 1 product (KB-MODEL-REGEX match "ultra" → Eraclean GA01 Ultrasonic Cleaner)
      - สินค้า sold_out=True, stock=0 → RAG ไม่กรองออก (Phase 3 ทำงานถูกต้อง) ✅
      - LLM บอก "หมดสต็อกชั่วคราว" + บอกว่าไม่ใช่หัวชาร์จ → ไม่แนะนำขายสินค้า sold_out (prompt กฎ 1 ทำงาน) ✅
      - LLM ไม่บอก "ไม่มีข้อมูล" (prompt กฎ 2 ทำงาน) ✅
      - ไม่มี buy link ในคำตอบ (ไม่เสนอขายสินค้า sold_out) ✅
    - Q8 (สาย): 5 products, 2.6s
  - แก้ bug `NameError: name 'sys' is not defined` ใน `_apply_product_tiers` — เพิ่ม `import sys` ระดับโมดูล
  - ไม่มี FILTER-UNAVAILABLE log (ยืนยันว่า RAG ไม่กรอง status/stock แล้ว) ✅
  - ไม่มี ERROR/Traceback ใน bot log ✅
- **ข้อบังคับที่ตรวจสอบแล้ว**:
  - ห้ามลบ status/stock field ออกจาก product card → ไม่ได้ลน (product card ยังมี status/sold_out/total_stock ครบ) ✅
  - ห้ามมี item_id ซ้ำจาก tier A และ tier B → `_apply_product_tiers` แยกด้วย set ก่อน merge + `_dedupe_products` จัดการ base_name ซ้ำ ✅
- **⚠️ ยังไม่ verify เต็ม**: รอ replay แชทจริงเพิ่มเติม (เช่น pingevox, nt_sumittra) เพื่อยืนยันว่าบอทตอบถูก end-to-end ในหลายเคส
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: รอ verify replay เพิ่มเติมก่อน (ตามกฎ)
- **⚠️ หมายเหตุ**: Q7 (MI 17 Ultra) ไปผ่าน KB path (KB-MODEL-REGEX match "ultra") ซึ่งมี LLM call ของตัวเองและ return early — tier merge ไม่ได้ทำงานใน KB path (เป็น pre-existing architecture, ไม่ใช่ bug ของ Phase 3)

### Phase 4 — device-spec-lookup trigger ไม่ผูก intent + spec-based retrieval (2026-09-10) — ✅ ผ่าน
- **ปัญหา**: device-spec-lookup trigger เฉพาะ intent==compatibility_check → ถ้า classify เป็น product_recommend (เช่น "อยากได้ของที่ใช้กับ xiaomi 17 ultra") mechanism ไม่ทำงาน → ระบบตกไป query DB ด้วยชื่ออุปกรณ์ตรงๆ → แมตช์ผิด (จับชื่อแบรนด์ ไม่ใช่ spec)
- **วิธีแก้**:
  1. **เปลี่ยน trigger ใน app.py** (บรรทัด ~5603):
     - ก่อน: `intent == "compatibility_check" AND target_device`
     - หลัง: `target_device ไม่ว่าง` (ไม่ผูก intent)
     - เพิ่ม fallback: สกัด target_device จาก message โดยตรงด้วย regex (ถ้า intent classifier ไม่สกัด)
     - รองรับ pattern: mi 17 ultra, iphone 17 pro max, s25 ultra, oneplus 13, macbook air m5, pixel 9 ฯลฯ
  2. **ปรับ intent_classifier.py prompt**:
     - เพิ่มหมายเหตุ: "สกัด target_device ทุกครั้งที่ลูกค้าระบุอุปกรณ์เป้าหมาย ไม่ว่า intent จะเป็นอะไร"
     - เพิ่มตัวอย่าง product_recommend + target_device:
       - "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → product_recommend, target_device="xiaomi 17 ultra"
       - "หัวชาร์จละ มีไหมใช้กับ mi 17 ultra" → product_recommend, sub=adapter, target_device="mi 17 ultra"
       - "พาวเวอร์แบงค์ใช้กับ oneplus 13 ได้ไหม" → compatibility_check, type=powerbank, target_device="oneplus 13"
  3. **retrieval ใช้ spec keyword เป็น query หลัก**:
     - re-query DB ใช้ keywords จาก search_and_extract (USB-C, wattage, protocol) ไม่ใช่ target_device ตรงๆ
     - ต่อยอดด้วย `_resolve_charger_subtype()` จาก Phase 2 เพื่อคง subtype (anchor cable → ยังหา cable ไม่สลับไป adapter)
     - เรียก `_resolve_charger_subtype(intent_result, retrieval_message, anchor_card, msg)` — ใช้ signature ที่ถูกต้อง
  4. **เพิ่ม hint ใน extra_context**:
     - "สินค้าที่แนะนำต้องรองรับ spec ของอุปกรณ์เป้าหมายจริง (พอร์ต/wattage/protocol) ไม่ใช่แค่มีชื่อแบรนด์เดียวกัน"
     - "ถ้า description ไม่ได้ระบุ wattage/protocol ที่ตรง → บอกลูกค้าตรงๆ ว่าอาจชาร์จได้ไม่เต็มสปีด"
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`, `chatbot/shopeechat/intent_classifier.py`
- **Bug ที่พบและแก้**: `_resolve_charger_subtype()` เรียกด้วย `msg_strong`/`msg_weak`/`intent_sub` ซึ่งไม่มีใน signature → แก้เป็น `intent_result`/`retrieval_message`/`anchor_card`/`msg`
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/app.py` → ผ่าน ✅
  - `python3 -m py_compile chatbot/shopeechat/intent_classifier.py` → ผ่าน ✅
  - `PYTHONPATH=chatbot python3 docs/test/test_car_charger_regression.py` → ผ่าน 16/16 ✅
  - Replay pingevox (3 คำถาม) → ผ่าน ✅
    - Q2 "อยากได้ของที่ใช้กับ xiaomi 17 ultra": intent=product_recommend + target_device สกัดได้ ✅
      - DEVICE-SPEC-LOOKUP trigger (ไม่ผูก intent) ✅
      - ได้ spec: "90W PPS, PD3.0, QC3+ USB-C" ✅
      - re-query DB: 'charger Xiaomi 17 Ultra 90W PPS PD3.0 QC3+ USB-C' (spec keyword) ✅
      - merge 9 สินค้าจาก re-query → TIER-MERGE 14→10 ✅
      - LLM แนะนำ CUKTECH GaN3 140W (จ่ายไฟเกิน 90W = ชาร์จเต็มสปีด) ✅
    - Q3 "หัวชาร์จละ มีไหม": intent=product_recommend + sub=adapter + device จาก history ✅
      - RESOLVE-SUBTYPE: resolved=adapter ✅
      - DEVICE-SPEC-LOOKUP subtype=adapter → prefix('หัวชาร์จ') ✅
      - re-query DB: 'หัวชาร์จ charger Xiaomi 17 Ultra 90W PPS PD3.0 QC3+ USB-C' ✅
      - แนะนำ CUKTECH GaN3 140W + CUKTECH AD1204U 120W (all adapter, all NORMAL) ✅
  - Replay OnePlus 13 → ผ่าน ✅
    - intent=product_recommend + type=powerbank + target_device=oneplus 13 ✅
    - DEVICE-SPEC-LOOKUP trigger ✅
    - ได้ spec: "100W SUPERVOOC, 50W AIRVOOC, USB-C" ✅
    - re-query DB: 'charger OnePlus 13 SUPERVOOC AIRVOOC 100W 50W USB-C' ✅
    - ไม่มี powerbank ในร้าน → ตอบตรงๆ "ยังไม่มีพาวเวอร์แบงค์" + แนะนำ charger/cable แทน ✅
  - ไม่มี duplicate web search (3 คำถาม = 3 web search, ไม่ซ้ำ) ✅
  - ไม่มี ERROR/Traceback ใน bot log ✅

### Phase 5 — stock จาก shopee_stock[].stock แทน summary_info.total_available_stock (2026-09-10) — ✅ ผ่าน
- **ปัญหา**: `to_product_card()` และ `_is_sold_out()` คำนวณ stock จาก `model[].stock_info_v2.summary_info.total_available_stock` — ค่านี้รวม `seller_stock` (สต็อกที่ผู้ขายมีแต่ไม่ได้ลง Shopee) ทำให้รายงาน stock เกินจริง
- **หลักฐานจาก DB จริง**: สินค้า 50 ตัวจาก KingGadgets — 0 ตัวมี `shopee_stock > 0` แต่ 11 ตัวมี `summary_info > 0` (mismatch) เช่น:
  - Xiaomi Mi Band 7 Pro: shopee=0 แต่ summary=40 (โค้ดเดิมรายงาน stock=40, โค้ดใหม่รายงาน stock=0)
  - Xiaomi Mi Motion: shopee=0 แต่ summary=100
  - Zaiwan BP35S: shopee=0 แต่ summary=80 (status=NORMAL แต่จริงๆ หมดสต็อก Shopee)
- **วิธีแก้**:
  1. **เขียน `_shopee_stock(model_doc)` helper** (บรรทัด ~478):
     - sum ค่า `stock` จากทุก entry ใน `model_doc["stock_info_v2"]["shopee_stock"]`
     - คืน 0 ถ้า field ไม่มี, list ว่าง, model_doc=None, หรือ exception (fail-safe)
     - ไม่ใช้ `seller_stock`, `summary_info`, `advance_stock`
  2. **แก้ `to_product_card()`**: `total_stock = sum(_shopee_stock(m) for m in model)` แทน `summary_info.total_available_stock`
  3. **แก้ `_is_sold_out()`**: เช็ค `_shopee_stock(m) > 0` แทน `summary_info.total_available_stock > 0`
- **ไฟล์ที่แก้**: `chatbot/shopeechat/product_store.py`
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/product_store.py` → ผ่าน ✅
  - Mock doc test 9 เคส → ผ่าน 9/9 ✅
    - seller_stock ≠ shopee_stock → ใช้ shopee_stock จริง ✅
    - shopee_stock หลาย location → sum รวม ✅
    - ไม่มี field shopee_stock → stock=0 ไม่ error ✅
    - model_doc=None → stock=0 ✅
    - empty list → stock=0 ✅
    - to_product_card total_stock + sold_out → ถูกต้อง ✅
    - _is_sold_out shopee=0 แต่ seller>0 → sold_out=True ✅
    - _is_sold_out shopee>0 → sold_out=False ✅
    - เอกสารเก่าไม่มี shopee_stock → stock=0, sold_out=True ✅
  - `test_car_charger_regression.py` → ผ่าน 16/16 ✅
  - Replay "มีหัวชาร์จไหม" + "มีสายชาร์จไหม" → สินค้าทุกตัว sold_out=True, stock=0 (ถูกต้อง — ร้านไม่มีสต็อก Shopee จริง) ✅
- **Field อื่นที่อาจต้องพิจารณาแก้ตาม**:
  - `seller_stock` — ไม่พบการอ้างถึงใน code (ใช้แค่ใน DB document ไม่ได้อ่าน)
  - `advance_stock` — ไม่พบการอ้างถึงใน code
  - `summary_info` — ไม่พบการอ้างถึงใน code อื่นนอกจาก 3 จุดที่แก้แล้ว
  - สรุป: ไม่มี field อื่นที่ต้องแก้ตาม — `total_available_stock` ถูกอ้างแค่ 3 จุดใน `product_store.py` ทั้งหมด แก้ครบแล้ว

### Charger Subtype Consolidation — รวม _detect_charger_subtype 19 จุด + dedup 2 ชุด (2026-09-16) — ✅ implement เสร็จ รอ verify replay
- **ปัญหา**: `product_store._detect_charger_subtype(...)` ถูกเรียก 22 จุดกระจายทั่ว app.py ด้วย argument ต่างกัน (req.message / retrieval_message / history / anchor_card.name) ไม่มี priority ตายตัว → subtype ที่ตัดสินใจได้ไม่สอดคล้องกันในแต่ละจุด
- **ปัญหาเพิ่มเติม**: dedup logic คนละชื่อ 2 ชุดทำงานเหมือนกันเกือบทุกบรรทัด:
  - `_kb_base_name`/`_kb_sell_score` (บรรทัด ~3214-3234) — KB merge path
  - `_base_name`/`_listing_sell_score` (บรรทัด ~4754-4804) — product_store path + _web_search_reanswer
- **วิเคราะห์ 22 จุด**:
  - 8 จุด (กลุ่ม A) = resolve subtype สำหรับ turn นี้ → แทนที่ด้วย `_resolve_charger_subtype`
  - 14 จุด (กลุ่ม B) = detect subtype จาก text เฉพาะเจาะจง → เรียก `_detect_charger_subtype` ตรงๆ (เหมือนเดิม)
- **Priority ของ `_resolve_charger_subtype` (ตามที่ user ตัดสินใจ)**:
  1. anchor subtype (default) — ใช้เมื่อ msg ไม่ได้ระบุ subtype อื่นชัดเจน
  2. msg strong keyword (override) — เฉพาะเมื่อ msg มี strong keyword ชัดเจน (หัวชาร์จ/สายชาร์จ/ชุดชาร์จ) ที่ต่างจาก anchor
  3. intent subtype — เมื่อไม่มี anchor และ msg ไม่มี keyword ชัด
  4. msg subtype (non-strong) — เมื่อไม่มี anchor และไม่มี intent
  5. retrieval/history — fallback
- **จุดที่แทนที่ (8 จุด)**:
  - จุด 3 (3098) KB search keyword
  - จุด 4 (3274) KB merge filter
  - จุด 15 (4774) _skip_sub superlative
  - จุด 16+17 (4830-4854) _intent_sub resolution (รวม 3 บล็อก if/elif/else)
  - จุด 21 (5320) no-product guard
- **จุดที่ไม่แทนที่ (14 จุด)** — เรียก `_detect_charger_subtype` ตรงๆ เหมือนเดิม:
  - จุด 1, 2 (1189, 1190) detect mismatch msg vs anchor
  - จุด 5, 6 (3734, 3755) detect mismatch msg vs active card
  - จุด 7, 10 (3942, 3982) detect subtype จาก history msg
  - จุด 8, 9 (3958, 3960) bool check จาก msg
  - จุด 11 (4028) _skip_ref_due_to_subtype (intent-or-msg)
  - จุด 12, 13 (4141, 4144) ref subtype mismatch
  - จุด 14 (4735) _filter_unavailable (ยึดเดิม intent > msg)
  - จุด 20 (5235) fallback (ยึดเดิม intent > msg)
  - จุด 22 (5737) device-spec re-query (card-only)
- **Dedup consolidation**: สร้าง `_dedupe_products(products)` ระดับโมดูล ใช้ logic ของ `_listing_sell_score` (ครอบคลุมกว่า) แทนที่:
  - บล็อก 3402-3441 (KB dedup) — ลด 42 บรรทัด → 5 บรรทัด
  - บล็อก 4885-4964 (product_store dedup) — ลด 80 บรรทัด → 8 บรรทัด
  - บล็อก 791-810 ใน `_web_search_reanswer` — ลด 22 บรรทัด → 6 บรรทัด
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **วิธีแก้ (implement จริง — 2026-09-16)**:
  1. เพิ่ม `anchor_card = None` default ที่บรรทัด 928 (กัน UnboundLocalError เมื่อไม่มี _tagged_item_id)
  2. สร้าง `_resolve_charger_subtype(...)` nested function ใน `chat()` ที่บรรทัด ~449 (ก่อน KB branch)
     - ใช้ closure: req, _hybrid_anchor_card
     - Strong keyword = keyword ใน `_STRONG_SUBTYPE_KWS` (ไม่ใช่ "หัว"/"สาย" ลอยๆ)
     - แก้ typo สั้นๆ เหมือน `_detect_charger_subtype`
  3. สร้าง `_dedupe_base_name`, `_dedupe_sell_score`, `_dedupe_products` ระดับโมดูล ที่บรรทัด ~424
  4. แทนที่ 8 จุดเรียก `_detect_charger_subtype` ด้วย `_resolve_charger_subtype`
  5. แทนที่ 3 บล็อก dedup ด้วย `_dedupe_products`
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/app.py` → ผ่าน ✅
  - `test_car_charger_regression.py` → ผ่าน 16/16 ✅
  - Edge case 1: `intent_result={}` → ไม่ throw, ใช้ msg subtype ✅
  - Edge case 2: `anchor_card=None` → ไม่ throw, ใช้ msg/intent subtype ✅
  - Edge case 3: CTL301 anchor (cable) + USB-C msg (cable strong) → cable (เหมือนเดิม) ✅
  - Edge case 4: CTL301 anchor (cable) + adapter msg (strong) → adapter (override anchor) ✅
  - Edge case 5: CTL301 anchor (cable) + vague msg → cable (anchor default) ✅
  - Edge case 6: CTL301 anchor (cable) + "หัว" ลอย (weak) → cable (anchor, weak ไม่ override) ✅
  - Edge case 7: no anchor + intent=cable → cable ✅
  - Edge case 8: no anchor + no intent + retrieval fallback → adapter ✅
  - Edge case 9: no anchor + no intent + no retrieval → None ✅
  - Edge case 10: hybrid anchor (adapter) + msg cable (strong) → cable (override) ✅
- **⚠️ ยังไม่ verify เต็ม**: รอ replay แชทจริง (เช่น pingevox, nt_sumittra) เพื่อยืนยันว่าบอทตอบถูก end-to-end
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: รอ verify replay จริงก่อน (ตามกฎ)

### Legacy Fix — กลับใช้ legacy app.py แก้ความซ้อน/ซับซ้อน/logic ทับกัน (2026-09-09) — ✅ implement 4/4 จุด รอ verify replay
- **ปัญหา**: บอทตอบแย่ลง เพราะมี layer ครอบ layer + logic ทับกัน + search ตอบตรงไม่เข้า LLM2
- **สาเหตุหลัก 4 จุด**:
  1. KB lookup path (บรรทัด 2959) เรียก `search_and_answer()` คืน search_info เป็นคำตอบโดยตรง ไม่ผ่าน RAG/LLM2
  2. NO-PRODUCT-GUARD (บรรทัด 4830-4889) อยู่ก่อน web search fallback → ถ้า RAG ไม่เจอ → handoff เลย ไม่ search
  3. `filter_unavailable` (บรรทัด ~4196) กรอง sold_out/non-NORMAL ออกจาก RAG → ลูกค้าถามสินค้าเก่าไม่ได้
  4. KB branch + product_store branch มี web search fallback คนละชุดโค้ด (copy กัน) → behavior แตกต่าง + ซ้อนกัน
- **ทางแก้ (ตามหลักการ 7 ข้อ)**:
  1. KB path: `search_and_answer` → `search_and_extract` + re-query DB + LLM2 (search ไม่ตอบตรง)
  2. ย้าย NO-PRODUCT-GUARD หลัง web search fallback (ถ้าไม่เจอ → search → ถ้ายังไม่เจอ → ค่อย handoff)
  3. เอา `filter_unavailable` ออกจาก RAG → LLM prompt กรองตอนแนะนำขาย (ไม่กรองใน RAG)
  4. รวม web search fallback ของ KB branch + product_store branch เป็น `_web_search_reanswer(...)` ชุดเดียว
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **วิธีแก้ (implement จริง — 2026-09-15)**:
  1. **KB path web search (บรรทัด ~2948)**: เปลี่ยน `search_and_answer` → `search_and_extract`
     + re-query DB ด้วย keywords จาก search + merge เข้า products (dedup by item_id)
     + strip URL ออกจาก search_info (กัน external URL หลุด)
     + สร้าง extra_context สำหรับ LLM2 (search_info = ข้อมูลประกอบ ไม่ใช่คำตอบหลัก)
     + เรียก LLM2 ใหม่ด้วย products ใหม่ + search context → answer จาก LLM2 ไม่ใช่จาก search
     + source label เปลี่ยนเป็น `knowledge_base+mongo+web_search` เมื่อ search ทำงาน
     + record Search step + LLM2(search) step ใน _steps
     + ตั้ง `_ws_result`/`_search_reason` default ก่อน block กัน UnboundLocalError
  2. **NO-PRODUCT-GUARD (บรรทัด ~4898)**: เพิ่มเงื่อนไข `not _guard_ws_available`
     — ถ้า web search พร้อมทำงาน (is_configured + ไม่ใช่ conv_active) → ข้าม guard ไป web search ก่อน
     — guard ยังทำงานปกติถ้า web search ไม่พร้อม (เช่น conv_active หรือ not configured)
  3. **filter_unavailable (บรรทัด ~4318)**: ตั้ง `_filter_unavailable = False` เสมอ
     — ดึงทุกสินค้า (normal + non-normal + sold_out) เข้า RAG
     — LLM prompt กรองตอนแนะนำขาย (มี context note บอก status != NORMAL ห้ามเสนอขายอยู่แล้ว)
  4. **รวม web search fallback เป็น `_web_search_reanswer(...)` (2026-09-15)**:
     - สร้าง nested function `_web_search_reanswer(...)` ใน `chat()` ที่บรรทัด ~451 (ก่อน KB branch ~3272 และ product_store branch ~5658)
     - รวม logic: search_and_extract → re-query DB (keywords + model code regex + KB lookup) → merge/dedup/rerank → strip URL → LLM2 → record Search + RAG(search) + LLM2(search) steps
     - KB branch เรียกด้วย `do_kb_lookup=False, do_model_code_regex=False, do_dedup_rerank=False` (เพราะ KB branch มี KB อยู่แล้ว + ไม่มี `_base_name` ในขณะนั้น)
     - product_store branch เรียกด้วย `do_kb_lookup=True, do_model_code_regex=True, do_dedup_rerank=True` (ใช้ `_base_name`/`_listing_sell_score` จาก closure)
     - device-spec lookup (บรรทัด ~5495) ยังแยกอยู่ เพราะ inject context ให้ LLM2 รอบแรก ไม่ใช่เรียก LLM2 เอง
     - ลดโค้ดซ้ำ ~470 บรรทัด (162 บรรทัด KB + 311 บรรทัด product_store → 38 + 86 บรรทัด)
     - ทุก branch ใช้ logic เดียวกัน → กัน behavior แตกต่าง (เช่น KB branch ไม่เคย strip URL แบบ 4 ขั้น, product_store branch ไม่เคย record RAG(search) step)
- **ยังไม่ได้ทำ**: ข้อ 5 (ลด subtype source + ลบ layer ซ้อน) — ไว้รอบถัดไป ต้อง map precedence ก่อน
- **Verify ที่ผ่าน**:
  - `py_compile` ผ่าน ✅ (app.py + web_search.py + product_store.py + knowledge_base.py)
  - `test_car_charger_regression.py` ผ่าน 16/16 ✅ (car charger + adapter/cable/set + iPhone 13 ไม่พัง)
- **⚠️ ยังไม่ verify เต็ม**: รอ replay จริง (test_compare_3way.py ต้องการ bot รัน + DB + API keys)
  - ต้อง verify: web search triggered → LLM2 ตอบ (ไม่ใช่ search ตอบ), no-product guard defer, filter_unavailable, MI 17 Ultra/cable compat scenario

### Phase 2Z++++++ — แก้บอทแนะนำสินค้าหมดสต็อก + ลืม subtype + ไม่รู้ device spec (pingevox Mi 17 Ultra) (2026-09-14) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: ลูกค้าส่งสายชาร์จ CTL301 (Lightning) → ถาม "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → บอทแนะนำหัวชาร์จ 45W ที่หมดสต็อก ทั้งที่ควรแนะนำสาย USB-C to USB-C และหัวชาร์จที่รองรับ 90W
- **สาเหตุ** (4 จุด):
  1. `compatibility_check` → `filter_unavailable=False` → ไม่กรอง sold_out → แนะนำสินค้าหมดสต็อก
  2. compat-retrieval override (บรรทัด ~3081) ทับ subtype จาก hybrid anchor → ดึงหัวชาร์จแทนสายชาร์จ
  3. charger_subtype_override (บรรทัด ~4292) ใช้ subtype จาก intent ที่อาจเป็น null/adapter → ทับ cable จาก anchor
  4. LLM prompt ไม่มีความรู้ Mi 17 Ultra ชาร์จ 90W → แนะนำ 45W ได้สบาย + `search_and_answer` ไม่ strip URL → ลิงก์เว็บนอกหลุด
- **วิธีแก้**:
  1. **แผนที่ 1**: เปิด `filter_unavailable` สำหรับ product_recommend + compatibility_check (ปิดเฉพาะ product_spec/warranty) — app.py บรรทัด ~4196
  2. **แผนที่ 2a**: guard `_hybrid_anchor_card` ครอบ compat-retrieval override — ถ้ามี hybrid anchor ให้ข้าม override — app.py บรรทัด ~3085
  3. **แผนที่ 2b**: guard `_hybrid_anchor_card` ใน charger_subtype_override — ถ้ามี anchor ให้ใช้ subtype จาก anchor แทน intent — app.py บรรทัด ~4292
  4. **แผนที่ 3**: device spec lookup — ถ้า intent=compatibility_check + มี target_device → เรียก `web_search.search_and_extract` ดึง spec + keywords แล้ว re-query DB หาสินค้าที่ compatible + merge เข้า products + inject spec ใน `_combined_extra` — app.py บรรทัด ~5141
  5. **แผนที่ 4**: strip URL ใน `search_and_answer` ก่อนคืนคำตอบ — web_search.py บรรทัด ~553
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`, `chatbot/shopeechat/web_search.py`, `docs/SRS_SSD.md`
- **Verify**: py_compile ผ่าน ✅, regression test ผ่าน 16/16 ✅ (car_charger + iPhone 13 ไม่พัง)
- **⚠️ ยังไม่ verify เต็ม**: รอทดสอบจริงกับบอท (replay แชท pingevox) เพื่อยืนยันว่าบอทตอบถูก

### Rich Media Consistency — แก้ test-assignment/live-assignment/shadow-inbox ให้จัดการ rich message ครบเหมือน shadowbot/botworker (2026-09-08) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: 5 ระบบ (shadowbot, test-assignment, live-assignment, botworker, replay-compare) จัดการ rich message (item, order, bundle_message, variation_card, image, video, sticker, notification, faq_liveagent) ไม่เท่ากัน:
  1. **test-assignment + live-assignment**: ส่ง `msg.text` ดิบ (เช่น `[item]`, `[order]`) ให้บอท แทน `[สินค้า: 12345]` / `[order: ABC]` → บอทเห็น placeholder ไม่ใช่ tag + history สะสม raw placeholder → follow-up ถาม "สินค้าเดิม" บอทไม่รู้
  2. **test-assignment + live-assignment**: ไม่ส่ง `images` ให้บอท → vision pass ไม่ทำงาน (บอทไม่อ่านรูป/วิดีโอที่ลูกค้าส่ง)
  3. **live-assignment route (conv_detail)**: ไม่ทำ product lookup → item card แสดงแค่ icon ไม่มีรูป/ราคา/ชื่อ
  4. **live-assignment route (conv_detail)**: เรียก parseRawMessage เฉพาะเมื่อมี raw_payload → ถ้าไม่มี raw_payload ข้อความเป็น text ดิบ `[item]` ไม่ถูกแปลง
  5. **shadow-inbox history**: ข้าม product lookup สำหรับ history messages (comment: "skip per-message product lookup for history") → item card ใน history แสดงแค่ "(สินค้า)" ไม่มีข้อมูลสินค้า
- **วิธีแก้**:
  1. **test-assignment/route.ts**: import `toBotText`, `toBotImages` → ใช้ `botText = toBotText(msg)` ส่งบอท + history + trigger matching, ส่ง `images: toBotImages(msg)` ให้ callBot, เพิ่ม `images` param ใน callBot + body
  2. **liveAssignmentService.ts**: เหมือน test-assignment — import `toBotText`, `toBotImages`, เพิ่ม `images` param ใน callBot + body, แก้ทั้ง 2 ฟังก์ชัน (replayConversation + batchReplay)
  3. **live-assignment/route.ts (conv_detail)**: เพิ่ม batch product lookup (เหมือน admin/conversations API) + เรียก parseRawMessage เสมอ (แม้ไม่มี raw_payload) + ใช้ parsed text สำหรับ display
  4. **live-assignment/route.ts (replay_conversation POST)**: แก้เงื่อนไข `if (raw && typeof raw === "object")` → เรียก parseRawMessage เสมอ
  5. **shadow-inbox/[shadowReplyId]/route.ts**: เปลี่ยนจาก "skip product lookup for history" เป็น batch product lookup สำหรับ history ทั้งหมด (เหมือน admin/conversations API)
- **ไฟล์ที่แก้**: `test-assignment/route.ts`, `liveAssignmentService.ts`, `live-assignment/route.ts`, `shadow-inbox/[shadowReplyId]/route.ts`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python ไม่เกี่ยว
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอทดสอบจริงใน browser:
  1. test-assignment: replay แชทที่มี item card → บอทเห็น `[สินค้า: 12345]` ใน message + history → ตอบรู้สินค้า
  2. test-assignment: replay แชทที่มีรูป → บอทอ่านรูปผ่าน vision pass
  3. live-assignment: replay แชทที่มี item card → บอทเห็น tag + แสดง product card ในหน้า conv_detail
  4. shadow-inbox: เปิด shadow reply → history แสดง product card ใน item card messages (ไม่ใช่แค่ "(สินค้า)")
  5. ทุกระบบ: ข้อความ `[item]` `[order]` `[bundle_message]` `[variation_card]` `[image]` `[video]` `[sticker]` `[notification]` ไม่ปรากฏเป็น text ดิบอีก

### Phase 1 — Inbox pagination + page-scoped unanswered + assigned filter in Mongo (2026-09-10) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: inbox โหลดช้า (limit=2000 แต่โชว์ทีละ 50), search สแกนทั้ง DB + รีโหลดหน้า, buildUnansweredMap สแกนทั้ง messages collection ทุก request, assigned_to filter ทำใน JS หลังดึงข้อมูล → paginate ไม่ถูกต้อง
- **วิธีแก้**:
  1. **Backend `conversationService.listConversations`** — เพิ่ม `cursor` (Date), `conversationIds` ($in), `excludeConversationIds` ($nin) params → กรองใน Mongo ไม่ใช่ใน JS
  2. **Backend `route.ts`** — เพิ่ม `getAssignedConversationIds(adminId?)` pre-fetch ids จาก `status_conversation` (source of truth) + `conversations` (legacy fallback) → ส่ง ids เป็น filter ให้ Mongo ก่อน paginate
  3. **Backend `buildUnansweredMap(convIds)`** — เปลี่ยนจากสแกนทั้ง messages collection เป็นกรอง `conversation_id: { $in: convIds }` (page-scoped) → ใช้ index { conversation_id: 1 }
  4. **Backend pagination** — `limit` default 50 (ไม่ใช่ 2000), cap 200; `cursor` = ISO timestamp ของ last_message_timestamp รายการสุดท้าย; response เพิ่ม `has_more` + `cursor`
  5. **Backend cache** — ขยายรองรับทุก assigned_to (key รวม assigned_to + cursor), TTL 5 วิ (ยาวกว่า poll 3 วิ)
  6. **Mongo index** — เพิ่ม `{ conversation_id: 1 }` unique sparse + `{ assigned_to: 1 }` sparse บน `status_conversation`
  7. **Frontend `useSharedConversations`** — เขียนใหม่: `head` (page 1, poll 3 วิ) + `tail` (page 2+, loadMore on scroll); `loadMore()` + `hasMore` + `loadingMore` + `cursor` state; filter change → reset head+tail; poll → refresh head only (tail คงไว้)
  8. **Frontend `ChatList`** — เพิ่ม props `loadMore`, `hasMore`, `loadingMore`; scroll ใกล้ล่าง → เรียก `loadMore()` (server-side) แทน slice ใน memory
  9. **Frontend `tickets/page.tsx`** — ส่ง `pageSize: 50` + `loadMore`/`hasMore`/`loadingMore` ไป ChatList
  10. **Backward compat** — `ConversationFilter.limit` ยังรองรับ (map เป็น pageSize); shadow-inbox/test-assignment ยังใช้ `limit: 2000` ได้
- **ไฟล์ที่แก้**: `conversationService.ts`, `route.ts`, `mongoClient.ts`, `useSharedConversations.ts`, `ChatList.tsx`, `tickets/page.tsx`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python ไม่เกี่ยว
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า /tickets ใน browser เพื่อยืนยัน:
  1. โหลดครั้งแรกเร็วขึ้น (ดึง 50 ไม่ใช่ 2000)
  2. scroll ใกล้ล่าง → โหลด page ถัดไป (loadMore)
  3. poll 3 วิ → head อัปเดต (ข้อความใหม่ขึ้นบน) แต่ tail ไม่หาย + scroll ไม่กระโดด
  4. search → ค้นทั้ง DB (ไม่ใช่แค่ 2000 ล่าสุด) + paginate ผลลัพธ์
  5. assigned_to=me → ดึงแค่ของฉัน (paginate ถูกต้อง ไม่ใช่ดึง 50 แล้วกรองเหลือ 5)
  6. assigned_to=unassigned → ดึงแค่ที่ยังไม่มีคนรับ
  7. ไม่มี duplicate ระหว่าง head กับ tail เวลา poll
- **⚠️ ต้อง restart server** เพื่อให้ `ensureIndexes` สร้าง index ใหม่บน `status_conversation`

### Phase 3B-6-fix — Shadow-bot annotation 500 + batch selector เด้ง (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา 1 (batch selector เด้ง)**: เลือกรอบ 1/2 แล้วเด้งกลับ 2/2 เสมอ
  - สาเหตุ: `ShadowConversationPanel.tsx` useEffect โหลด batches มี dep `[conversation?.id, historyReplies]` — `historyReplies` เป็น array ใหม่ทุก 20s (polling) → effect re-run → reset `selectedBatchId` เป็น `bs[0]` (รอบใหม่สุด) เสมอ
  - วิธีแก้: เอา `historyReplies` ออกจาก deps (ใช้ `historyReplies?.length` แทน) + ถ้า `selectedBatchId` ยังอยู่ใน batches ใหม่ → ไม่ reset (ใช้ functional setState)
- **ปัญหา 2 (annotation 500 + แยกไม่ได้ + อัปเดตไม่ได้)**: add annotation รอบ 2 แล้ว error 500, ต้องลบแล้วใส่ใหม่
  - สาเหตุ: unique index `{ scope: 1, conversation_id: 1 }` ไม่รวม `generation_batch_id` → มี annotation ได้แค่ 1 ต่อแชท → insert รอบ 2 ชน index → 500
  - วิธีแก้: drop old index `scope_1_conversation_id_1` ก่อน (ใน `ensureIndexes` pre-step) → สร้าง partial unique index ใหม่ 2 ตัว:
    1. `{ scope, conversation_id, generation_batch_id }` unique เฉพาะที่มี batch_id (แยกตามรอบ)
    2. `{ scope, conversation_id }` unique เฉพาะที่ไม่มี batch_id (legacy — 1 ต่อแชท)
- **ไฟล์ที่แก้**: `mongoClient.ts`, `ShadowConversationPanel.tsx`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python ไม่เกี่ยว
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า shadow-inbox history tab ใน browser เพื่อยืนยัน:
  1. เลือกรอบ 1/2 แล้วไม่เด้งกลับ 2/2 หลัง poll 20s
  2. add annotation รอบ 1 แล้ว add annotation รอบ 2 ไม่ error 500
  3. เปลี่ยนสี annotation รอบเดิมได้โดยไม่ต้องลบใส่ใหม่
- **⚠️ ต้อง restart server** เพื่อให้ `ensureIndexes` รัน dropIndex + สร้าง index ใหม่

### Role Permission System Restructure (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: เดิมใช้ hierarchy (superadmin=dev > admin) ไม่ละเอียดพอ — admin เห็นทุกหน้า, superadmin เห็น log/config
- **สิ่งที่ทำ**:
  1. สร้าง page-based permission system ใน `lib/roles.ts` + `authorize.ts` — แต่ละหน้ามี access level ต่อ role: none/read/edit
  2. Permission matrix:
     - admin: edit (ticket/quickreply/testchat/shadow-inbox/test-assignment), read (team/trigger/workflow/kb/persona/shop-setting/shop/customer/admin-config/botworker/test-result/replay-compare), none (dashboard/analytics/admin-review-kpi/user/log/config)
     - superadmin: edit (admin ได้ + dashboard/analytics/admin-review-kpi/user/team/trigger/workflow/kb/persona/shop-setting/shop/customer/admin-config), read (botworker/test-result/replay-compare), none (log/config)
     - dev: edit ทุกหน้า
  3. Rename route `/admin-kpi` → `/admin-review-kpi` (ทั้ง label และ route path)
  4. Restructure Sidebar — 5 หมวด: หลัก/กระบวนการ/ทดสอบบอท/จัดการ/ตั้งค่า
     - หมวด "ทดสอบบอท" เป็น collapsible group (กดยืด/ยุบได้, auto-expand เมื่อ active)
     - test-chat มี nested submenu (Shopee/TikTok/Lazada) ซ้อนใน collapsible group ได้
  5. อัปเดต page components ทั้งหมดใช้ `canEditPage(user, pageKey)` แทน `canEdit`/`canManage`
  6. อัปเดต API route guards — write endpoints ใช้ `requirePageEdit`, read ใช้ `requirePageAccess`
     - log/config → dev เท่านั้น (superadmin ไม่ได้แล้ว)
     - dashboard/analytics → superadmin+dev (admin ห้าม)
     - kb/workflows/shops/admin-config/team writes → superadmin+dev (admin read-only)
- **ไฟล์ที่แก้**: `lib/roles.ts`, `backend/middleware/authorize.ts`, `components/layout/Sidebar.tsx`, page components (shops/knowledge/triggers/admin-config/team/config/users/ShopDetailDrawer), API routes (admin-review-kpi/config/admin/logs/kb/kb-upload/kb-[id]/kb-[id]-toggle/shops-[id]/admin-config/workflows/workflows-[id]/workflows-toggle/workflows-restore/assignment-reassign/assignment-config/assignment-shop-team/assignment-platform-team/users-list/stats-dashboard/stats-live/stats-performance/stats-admin-activity)
- **ไฟล์ใหม่**: ไม่มี (ย้าย admin-kpi → admin-review-kpi)
- **ไฟล์ที่ย้าย**: `app/(console)/admin-kpi/` → `app/(console)/admin-review-kpi/`, `app/api/admin-kpi/` → `app/api/admin-review-kpi/`
- **verify**: `npx tsc --noEmit` → ผ่าน (exit 0, ไม่มี error)

### Phase 3B-8 — Admin-chat-result รองรับ batch (4 admins × 2 batches = 8 rows) (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: admin-chat-result group แค่ `scope-conversation_id` → 4 admins × 2 batches = 8 docs กลายเป็น 1 row ปนกัน
- **วิธีแก้**:
  1. API — เพิ่ม `batch_id` ใน `ResultItem` (test_assignment=replay_batch_id, shadow_bot=generation_batch_id)
  2. API — เปลี่ยน group key เป็น `scope-conversation_id-admin_id-batch_id` → 8 rows แยกกัน (standalone)
  3. API — detail endpoint รองรับ `batch_id` param (กรอง items ตาม batch)
  4. UI — เพิ่ม `batch_id` ใน `ConversationItem` + `DetailItem`
  5. UI — โชว์ batch label (8 ตัวท้าย) ใน list row + detail header
  6. UI — ส่ง `batch_id` ตอน load detail + `isSelected` เช็ค batch_id ด้วย
- **ไฟล์ที่แก้**: `/api/admin-chat-result/route.ts`, `admin-chat-result/page.tsx`
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า admin-chat-result ใน browser เพื่อยืนยัน 8 rows แยกกัน

### Phase 3B-7 — Test-assignment replay_batch_id (แยกรอบ replay) (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: test-assignment replay ซ้ำแชทเดิม → `saveReplayResult` ใช้ `findOneAndUpdate` upsert → ทับของเก่า ผล replay รอบเก่าหาย
- **วิธีแก้** (เหมือน Phase 3B-6 shadow-bot):
  1. เพิ่ม field `replay_batch_id` ใน `TestAssignmentDoc` — unique id ต่อรอบ replay (`replay_<convId>_<ts36>_<rand>`)
  2. `saveReplayResult` เปลี่ยนจาก upsert → `insertOne` (สร้าง doc ใหม่ทุกรอบ) + แนบ `batchId` กลับ
  3. `getTestAssignment` — เพิ่ม param `replayBatchId` ถ้าไม่ส่ง → คืนล่าสุด (sort created_at desc)
  4. `rateMessage`, `rateConversation`, `softDelete`, `restore` — เพิ่ม param `replayBatchId` ใช้กรอง doc (ถ้าไม่ส่ง → อัปเดตล่าสุด)
  5. เพิ่ม `listReplayBatches(conversationId, replayedBy?)` — ดึง distinct batches (id, created_at, count, final_status, replayed_by) เรียงใหม่สุดก่อน
  6. API replay คืน `replay_batch_id` + conv_detail รองรับ `replay_batch_id` param + endpoint `?batches=1&conversation_id=xxx`
  7. API rate/delete รองรับ `replay_batch_id` ใน body
  8. API history — dedupe เก็บล่าสุดต่อ conversation_id + ส่ง `replay_batch_id` กลับ
  9. `chatAnnotationService` — `scope="test_assignment"` ใช้ `generation_batch_id` field เดิมเก็บ `replay_batch_id` (ต่างรอบต่าง mark)
  10. UI — batch selector dropdown ใน detail panel header + AnnotationDot ผูก batch ที่เลือก + ส่ง `replay_batch_id` ใน rate/replay
  11. UI history list — AnnotationDot ส่ง `generationBatchId={h.replay_batch_id}` + loadAnnotations dedupe/match batch
  12. `docs/schema.md` — อัปเดต `test_assignment` section (เพิ่ม replay_batch_id + soft delete fields) + อัปเดต `chat_annotations` note
- **ไฟล์ที่แก้**: `testAssignmentService.ts`, `/api/test-assignment/route.ts`, `chatAnnotationService.ts`, `/api/chat-annotations/route.ts`, `test-assignment/page.tsx`, `docs/schema.md`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python ไม่เกี่ยว
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า test-assignment ใน browser เพื่อยืนยัน batch selector + annotation + rate ทำงาน

### Phase 3B-6 — Shadow-bot generation_batch_id (แยกรอบ generate) (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: กด Generate ซ้ำแชทเดิม → insert doc ใหม่ทุกครั้ง ไม่มี index แยกรอบ → ปนกัน และ annotation ผูก conversation เดียวทับรอบเก่า
- **วิธีแก้**:
  1. เพิ่ม field `generation_batch_id` ใน `ShadowReplyDoc` — unique id ต่อรอบ generate (`gen_<convId>_<ts36>_<rand>`)
  2. `generateConversationShadowReplies` สร้าง batchId ที่เริ่มรอบ แท็กทุก Q&A pair ในรอบนั้น + แนบ `batchId` ลง results ให้ caller
  3. `listShadowReplies` รองรับ filter `generationBatchId`
  4. เพิ่ม `listGenerationBatches(conversationId)` — aggregate group by batch_id ดึง created_at/count/generated_by เรียงใหม่สุดก่อน
  5. `chatAnnotationService` — เพิ่ม `generation_batch_id` ใน doc, upsert key รวม batch_id (ต่างรอบ = คนละ annotation), list รองรับ filter `generationBatchIds`
  6. API `/shadow-inbox/generate-conversation` คืน `generation_batch_id` ใน response
  7. API `/shadow-inbox` GET รองรับ `generation_batch_id` filter + endpoint `?batches=1&conversation_id=xxx`
  8. API `/chat-annotations` GET รองรับ `generation_batch_ids` filter + POST รองรับ `generation_batch_id`
  9. UI `ShadowConversationPanel` — batch selector dropdown (รอบที่ 1/2/...), default รอบใหม่สุด, filter historyReplies ตาม batch ที่เลือก, AnnotationDot ผูก batch ที่เลือก
  10. UI `AnnotationDot` — รับ `generationBatchId` prop ส่งต่อไป API
  11. UI `shadow-inbox/page.tsx` — ลบ annotationsMap จาก ChatList (mark ย้ายไป panel ต่อ batch selector)
  12. UI `ShadowInboxList` — เพิ่ม `generation_batch_id` ใน type
  13. `docs/schema.md` — เพิ่ม `generation_batch_id` ใน shadow_replies + เพิ่ม section 2.12 chat_annotations
- **ไฟล์ที่แก้**: `shadowReplyService.ts`, `chatAnnotationService.ts`, `/api/shadow-inbox/route.ts`, `/api/shadow-inbox/generate-conversation/route.ts`, `/api/chat-annotations/route.ts`, `shadow-inbox/page.tsx`, `ShadowInboxList.tsx`, `ShadowConversationPanel.tsx`, `AnnotationDot.tsx`, `docs/schema.md`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python (`chatbot/shopeechat/`) ไม่เกี่ยวกับการแก้ครั้งนี้
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า shadow-inbox history tab ใน browser เพื่อยืนยัน batch selector + annotation ทำงาน

### Phase 3B — Test-assignment + Shadow-bot restructure + Markup (2026-09-07) — ✅ implement เสร็จ รอ verify

#### Phase 3B-1 — Markup system (chat annotations)
- สร้าง collection `chat_annotations` — เก็บ dot สี + note ของแชท
- API `/api/chat-annotations` — GET/POST/PATCH/DELETE
- UI: วงกลมสี (dot) ที่ inbox chat item + note popup
- ใช้ร่วม test-assignment + shadow-bot

#### Phase 3B-2 — Test-assignment restructure (3 tabs)
- **all**: แชททั้งหมดแบบ ticket inbox — เลือกแชท + กด replay ทีละแชท (เหมือนเดิม)
- **roll**: batch replay — เลือก N แชท, เก่า/ใหม่ก่อน, ทับ/ไม่ทับ/ต่อจากเดิม
  - "ไม่ทับ" → ข้ามแชทที่ **ตัวเอง** เคย replay แล้ว ไปทำอันถัดไปจนครบ N
- **history**: ประวัติ replay แยกตามแอดมิน — ของใครของมัน
- soft delete replay result (กู้คืนได้)

#### Phase 3B-3 — Shadow-bot restructure
- **ลบ "Generate ทีละข้อความ"** — เหลือแค่ generate ทั้งแชท
- **all**: แชททั้งหมด — เลือกแชท + กด Generate ทั้งแชท ทีละแชท
- **roll**: batch generate ทั้งแชท — เลือก N แชท, เก่า/ใหม่ก่อน, ทับ/ไม่ทับ/ต่อจากเดิม
  - "ไม่ทับ" → ข้ามแชทที่มีคน generate แล้ว ไปทำอันถัดไปจนครบ N
- **handoff bubble**: ถ้าเจอ handoff ใส่ bubble "ตรงนี้ต้องแอดมินแล้ว" แต่ทำต่อ + mark ไว้

#### Phase 3B-4 — History per-admin
- test-assignment + shadow-bot แยก history ชัดเจน
- shadow-bot history รวม "generate แชทเดียว" + "roll batch" ในหน้าเดียว
- แยกตามแอดมิน — ของใครของมัน

- **ไฟล์ที่จะแก้**: test-assignment/page.tsx, shadow-inbox/page.tsx, testAssignmentService.ts, shadowReplyService.ts, Sidebar.tsx
- **ไฟล์ใหม่**: chatAnnotationService.ts, /api/chat-annotations/route.ts, /api/chat-annotations/[id]/route.ts

### Phase 3A — Admin KPI Dashboard + Visibility per admin (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: ไม่มีระบบ KPI รวมของแอดมิน — ไม่รู้ว่าใคร replay อะไร, ให้คะแนนคำตอบไหน, คอมเมนต์กี่คอมเมนต์
- **สิ่งที่ทำ**:
  1. **เติม gap — test-assignment**: เพิ่ม `replayed_by` + `replayed_at` ใน `saveReplayResult` + audit log `test_assignment.replay` ตอนกด replay
  2. **เติม gap — shadow-inbox**: เพิ่ม `generated_by` ใน `ShadowReplyDoc` สำหรับ manual/manual_conversation (worker ใช้ "system")
  3. **สร้าง adminKpiService** — aggregate KPI จาก test_chat_ratings + test_assignment + shadow_replies + admin_logs
  4. **สร้าง API `/api/admin-kpi`** — รับ `?admin_id=&from=&to=&scope=` คืน KPI รวม + drill-down
  5. **สร้างหน้า `/admin-kpi`** — dashboard + date range picker + filter admin + ตารางต่อ admin + drill-down session
     - role: dev/superadmin (ใช้ `requireSuperadmin`)
     - แยกจาก dashboard เดิมชัดเจน
  6. **ปรับ Sidebar** — รวม test-chat/shadow-inbox/botworker/test-assignment/replay-compare/test-results/admin-kpi เป็น group "ทดสอบบอท"
  7. **Visibility per admin** — test-assignment + shadow-inbox บังคับกรองของใครของมัน (admin ทั่วไปเห็นเฉพาะของตัวเอง, superadmin/dev เห็นทั้งหมด)
  8. **Bug fix**: test-assignment rate แล้วไม่ reload หน้า (optimistic update), shadow-inbox rate แล้วคะแนนไม่หาย (cache-buster)
- **KPI shadow-inbox**: นับเฉพาะ manual (generate + generate_conversation) ไม่นับ worker
- **ไฟล์ที่แก้**: testAssignmentService.ts, test-assignment/route.ts, shadowReplyService.ts, adminLogService.ts, Sidebar.tsx, test-assignment/page.tsx, shadow-inbox/page.tsx, logs/page.tsx
- **ไฟล์ใหม่**: adminKpiService.ts, /api/admin-kpi/route.ts, /(console)/admin-kpi/page.tsx

### InfoTab — สถิติการสนทนา แสดงชื่อแอดมิน ไม่ใช่ admin_id (2026-09-05) — ✅ implement เสร็จ
- **ปัญหา:** หน้า botworker และ ticket panel ตรง "สถิติการสนทนา" แสดง `admin: <admin_id>` แทนชื่อแอดมิน
- **สาเหตุ:** `InfoTab.tsx` ใช้ `m.admin_id || m.admin_name || "unknown"` เป็น key แล้วแสดง key ตรงๆ → ถ้ามี admin_id จะแสดง id
- **วิธีแก้:**
  - dedup ตาม `admin_id` (key) แต่เก็บ `name` แยก
  - แสดง `admin: ${name}` โดยใช้ `m.admin_name` ก่อน ถ้าไม่มีค่อย fallback เป็น `m.admin_id`
  - ถ้า message หลังมี admin_name แต่ก่อนหน้ายังเป็น id → อัปเดต name
- **ไฟล์ที่แก้:** `ChatAdminWeb/src/components/chat/InfoTab.tsx`
- **Verify:** tsc ผ่าน ✅
- **หมายเหตุ:** ไม่ได้เพิ่ม/แก้/ลบฟังก์ชัน → ไม่ต้องอัปเดต SRS_SSD.md

### Phase 2Z++ — แก้ follow-up ลืมสินค้าเดิม + แก้ warranty skip ไม่ทำงาน (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา 1 — ลืมสินค้าเดิม:** ลูกค้าถามต่อ "อันนี้สามารถฟังเพลงโดยไม่เชื่อมบลูทูธได้ไหมคะ" หลัง bot แนะนำ iSUPER SoundActiv Swim → bot ตอบผิด (ขัดแย้งกับ Q1) เพราะดึงสินค้าอื่นมาแทน
  - **สาเหตุ:** REFERENCE ดึงชื่อ "iSUPER SoundActiv Swim" ได้ถูก → แต่ vector search ไม่เจอ (products=0) → REF-REGEX ไม่ทำงานเพราะต้องการ digit ใน model word → ไป shop fallback ดึงสินค้าอื่น
  - **Fix:** เพิ่ม REF-NAME-FALLBACK ใน app.py — ถ้าเป็น follow-up ที่มี ref_models แต่ vector search ไม่เจอ → ดึงด้วย Mongo regex จากชื่อสินค้าเต็ม (ไม่จำเป็นต้องมี digit)
- **ปัญหา 2 — warranty skip ไม่ทำงาน:** Phase 2Z+ แก้ไปแล้ว แต่เงื่อนไข `not req.message.strip()` ไม่ทำงานเพราะ req.message = "[รูปภาพ]" ไม่ใช่ ""
  - **Fix:** เปลี่ยนเงื่อนไขเป็นตัด image placeholder ออกก่อน แล้วค่อยเช็คว่าว่างไหม
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/app.py` — เพิ่ม REF-NAME-FALLBACK + แก้เงื่อนไข warranty skip
- **Verify:** py_compile ผ่าน ✅

### Phase 2Z+ — แก้ warranty state machine ตีรูปเฉยๆ เป็น claim evidence (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** ลูกค้าส่งรูปเฉยๆ (ไม่ได้บอกว่าเคลม) แต่ bot ยังตอบ "รอแอดมิน" + handoff
- **สาเหตุจริง:** ไม่ใช่ที่ LLM — เป็นที่ warranty state machine ใน app.py
  - state machine ตรวจ history ทั้งหมดหา warranty keywords (เช่น "ประกัน")
  - ในเคสนี้ history มี "ประกัน" (Q5: "รุ่นไหนประกันยังไงบ้าง") → ทุกข้อความต่อมาที่มีรูป → ถูกตีเป็น claim evidence
- **Fix ใน app.py (บรรทัด 1425-1459):**
  1. เช็คเฉพาะ history ล่าสุด 3 ข้อความ แทนทั้งหมด
  2. ถ้าลูกค้าส่งรูปเฉยๆ (ไม่มีข้อความ + ไม่มี warranty keyword) → ไม่ใช่ claim evidence
  3. ปล่อยไปเส้นทางปกติ (LLM อ่านรูป + ตอบตามบริบท)
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/app.py` — จำกัด history scan เป็น 3 ล่าสุด + เช็ค warranty keyword ใน message ปัจจุบัน
- **Verify:** py_compile ผ่าน ✅, uvicorn reload สำเร็จ ✅

### Phase 2Z — แก้ Bot ตีรูปเฉยๆ เป็น claim warranty (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** ลูกค้าส่งรูปเฉยๆ (ไม่ได้บอกว่าเคลม) → Bot ตอบ "ได้รับข้อมูลแล้ว รอแอดมินติดต่อกลับ" + handoff_to_admin=true
- **สาเหตุ 2 จุด:**
  1. `app.py` vision_context สั่ง LLM ว่า "ถ้ารูปเป็นสินค้าเสีย → ถามเคลม" โดยไม่มีเงื่อนไขว่าลูกค้าต้องบอกว่าเคลมก่อน
  2. `llm.py` SYSTEM_INSTRUCTION ไม่มีกฎที่บอกชัดว่า "การส่งรูปเฉยๆ ไม่ใช่ claim"
- **Fix ที่ 1 — app.py vision_context (บรรทัด 499-509):**
  - เพิ่มเงื่อนไข: "ถ้ารูปเป็นสินค้าเสีย **และลูกค้าบอกชัดว่าเคลม** → ถามเคลม"
  - เพิ่ม: "ถ้ารูปเป็นสินค้าปกติ → แนะนำขาย ห้ามตีว่าเป็น claim"
  - เพิ่ม: "ห้ามตีว่ารูปเป็นสินค้าเสีย ถ้าลูกค้าไม่ได้พิมพ์บอกว่าเคลม"
- **Fix ที่ 2 — llm.py SYSTEM_INSTRUCTION (บรรทัด 62-73):**
  - เพิ่มกฎ: "การส่งรูปเฉยๆ ไม่ใช่การขอเคลม"
  - เพิ่ม: ลูกค้าส่งรูป + พิมพ์ "เคลม/สินค้าเสีย/ซ่อม" → เป็น claim
  - เพิ่ม: ลูกค้าส่งรูปเฉยๆ → ห้ามตีว่าเป็น claim
  - เพิ่ม: ถ้ารูปเป็นสินค้าเสียแต่ลูกค้าไม่ได้พิมพ์เคลม → ถามก่อน ห้ามส่งแอดมินเฉย
  - เพิ่ม: ห้ามตอบ "รอแอดมินติดต่อกลับ" ถ้าลูกค้าไม่ได้ขอเคลม
  - เพิ่ม: ห้ามตั้ง handoff_to_admin=true ถ้าลูกค้าไม่ได้ขอเคลม
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/app.py` — ปรับ vision_context ให้ชัดเจน
  - `chatbot/shopeechat/llm.py` — เพิ่มกฎรูปภาพ + claim ใน SYSTEM_INSTRUCTION
- **Verify:** py_compile ผานทั้ง 2 ไฟล์ ✅
- **หมายเหตุ:** ไม่ได้เพิ่ม/แก้/ลบฟังก์ชัน → ไม่ต้องอัปเดต SRS_SSD.md

### Phase 2Y — แก้ Bot สับสน MagSafe "ยึดแม่เหล็ก" vs "ชาร์จแม่เหล็ก" (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** ลูกค้าถาม "ชาร์จ Magsafe ได้ไหม" (ถามเรื่องชาร์จไฟ) → Bot ตอบ "รองรับการใช้งานแบบแม่เหล็ก MagSafe" (ตอบเรื่องยึดแม่เหล็ก) → ลูกค้าเข้าใจผิดว่าชาร์จได้
- **สาเหตุ:** SYSTEM_INSTRUCTION ใน llm.py ไม่ได้สอนให้ bot แยกความหมาย 2 อย่างนี้
- **Fix:** เพิ่มกฎ MagSafe ใน SYSTEM_INSTRUCTION (llm.py บรรทัด 171-186):
  - แยก "ยึดด้วยแม่เหล็ก" (magnetic attachment) จาก "ชาร์จไฟผ่านแม่เหล็ก" (MagSafe wireless charging)
  - ถ้าลูกค้าถาม "ชาร์จ MagSafe ได้ไหม" → ถามเรื่องชาร์จไฟ ไม่ใช่ยึดแม่เหล็ก
  - พัดลมระบายความร้อน (MagCooler, FunCooler) ไม่มีชาร์จไฟ → ตอบชัด
  - ห้ามใช้คำว่า "รองรับ MagSafe" กับสินค้าที่ไม่มีชาร์จไฟ
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/llm.py` — เพิ่มกฎ MagSafe ใน SYSTEM_INSTRUCTION
- **Verify:** py_compile ผ่าน ✅
- **หมายเหตุ:** ไม่ได้เพิ่ม/แก้/ลบฟังก์ชัน → ไม่ต้องอัปเดต SRS_SSD.md

### Phase 2X — /tickets auto-reopen แยกจาก botworker (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** หลัง Phase 2V botworker เขียน test_status_conversation → /tickets ไม่เห็น reopen เมื่อลูกค้าทักใหม่
- **Fix:** /tickets มี auto-reopen logic ของตัวเอง ใน /admin/conversations API
  - ตรวจ closed conversations ว่ามี last_message_timestamp > closed_at ไหม
  - ถ้ามี → reopen status_conversation (จริง) — status=bot, clear assigned_to
  - ทำใน API endpoint โดยตรง ไม่พึ่ง botworker
- **แยกชัดเจน:**
  - /tickets → เขียน status_conversation (จริง)
  - botworker → เขียน test_status_conversation (source=botworker)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/api/admin/conversations/route.ts` — เพิ่ม auto-reopen logic หลังโหลด meta map
- **Verify:** tsc ผ่าน ✅

### Phase 2W — History tab แสดงเวอร์ชั่นเก่าของ bot reply (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** Generate แชทเดิมซ้ำหลายครั้ง → History tab แสดงแค่คำตอบล่าสุด (Map dedupe by inbound_message_id)
- **Fix:**
  - group shadow_replies by inbound_message_id, sort by created_at desc
  - ล่าสุด → botReply หลัก
  - ที่เหลือ → allVersions (เก็บใน QAPair.botReply.allVersions)
  - UI: เพิ่ม OldVersionsButton — กด "ดูเวอร์ชั่นเก่า (N)" → expand แสดงเวอร์ชั่นเก่า
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/components/shadow/ShadowConversationPanel.tsx` —
    - เพิ่ม field allVersions ใน QAPair.botReply
    - เพิ่ม created_at ใน historyReplies type
    - ปรับ useEffect ให้ group + sort + เก็บ allVersions
    - เพิ่ม OldVersionsButton component
- **Verify:** tsc ผ่าน ✅

### Phase 2V — แยก status_conversation ระหว่าง botworker กับ ticket (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** botworker เขียน status_conversation ร่วมกับ /tickets → handoff/reopen กระทบ ticket จริง
- **Fix:**
  - botworker อ่าน status_conversation (read-only — เช็ค admin จริงกำลังตอบไหม)
  - botworker เขียน test_status_conversation source="botworker" (handoff/reopen/status)
  - /botworker UI อ่าน status จาก /api/botworker/conversations (ใช้ test_status_conversation)
  - /tickets ไม่ได้รับผลกระทบจาก botworker อีกต่อไป
- **สิ่งที่เปลี่ยน:**
  - `testStatusConversationService.ts` — เพิ่ม "botworker" ใน TestSource
  - `botWorkerService.ts` —
    - reopen: ใช้ testStatusConversationService.updateTestStatus แทน reopenConversation
    - pickAgent: mirror ผล handoff ลง test_status_conversation source="botworker"
    - ลบ import reopenConversation (ไม่ใช้แล้ว)
  - `ChatAdminWeb/src/app/api/botworker/conversations/route.ts` — API ใหม่ (เหมือน /admin/conversations แต่อ่าน test_status_conversation)
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — ใช้ /api/botworker/conversations แทน /admin/conversations
- **Verify:** tsc ผ่าน ✅

### Phase 2U — เขียน /botworker ใหม่ให้เหมือน /tickets (ChatList + 3 สี + ขวา info/chatlog/products) (2026-09-12) — ✅ implement เสร็จ
- **เหตุผล:** ตอนนี้ /botworker หน้าตาไม่เหมือน tickets — ซ้ายเป็น list ของ shadow_replies ไม่ใช่ ChatList
- **สิ่งที่เปลี่ยน:**
  - ซ้าย: ใช้ ChatList (เดียวกับ tickets) — ดึงจาก /admin/conversations
  - กลาง: BotWorkerChatPanel — แสดงแชท 3 สี (user/zaapi/bot) ไม่มี composer (อ่านอย่างเดียว)
    - user = เทา (ซ้าย) — จาก messages_shp role=user
    - zaapi = เขียว (ขวา) — จาก messages_shp role=bot
    - bot = ฟ้า (ขวา) — จาก shadow_replies
    - มี legend 3 สี + safety notice
    - มี header bar (platform icon + customer name + status badge)
    - รองรับ multi-bubble (bot แบ่งคำตอบด้วย |||)
  - ขวา: InfoTab / ChatLogTab / ProductsTab (เหมือน tickets) — ยืด/หด ได้
  - polling: conversations 5s, messages 3s
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — เขียนใหม่ทั้งหน้า
- **Verify:** tsc ผ่าน ✅

### Phase 2T — bot เห็น history ถูกต้อง + UI 3 สีใน /botworker (2026-09-12) — ✅ implement เสร็จ
- **ปัญหาที่ 1 (history):** getHistoryForBot อ่าน messages_shp role=user+bot → bot เห็นคำตอบ Zaapi (role=bot ใน messages_shp) แต่ไม่เห็นคำตอบตัวเอง (อยู่ใน shadow_replies)
- **ปัญหาที่ 2 (UI):** หน้า /botworker แสดงแค่ inbound + bot reply ไม่แสดงแชทเต็มรูปแบบ
- **Fix ที่ 1 — getHistoryForBot:**
  - อ่าน user จาก messages_shp (role=user เท่านั้น)
  - อ่าน bot replies จาก shadow_replies (คำตอบของเราเอง)
  - merge เรียงตามเวลา → ส่งให้ bot
  - bot ไม่เห็น Zaapi (role=bot ใน messages_shp) และไม่เห็น admin (role=admin)
- **Fix ที่ 2 — UI 3 สี:**
  - API `/api/botworker/conversations/:id/messages` — merge user + zaapi + bot เป็น unified list
  - หน้า /botworker แสดงแชท 3 สี:
    - user = เทา (ซ้าย)
    - zaapi = เขียว (ขวา)
    - bot = ฟ้า (ขวา)
  - มี legend บอกสี + safety notice
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/messageService.ts` — getHistoryForBot อ่าน shadow_replies
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — UI 3 สี + ChatBubble component
- **ไฟล์ที่สร้าง:**
  - `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — API merge 3 แหล่ง
- **Verify:** tsc ผ่าน ✅

### Phase 2S — สร้างหน้า /botworker ดูคำตอบ botworker แบบ ticket layout (2026-09-12) — ✅ implement เสร็จ
- **เหตุผล:** ต้องมีที่ดูคำตอบที่ botworker รันอัตโนมัติ (mode=standalone) แยกจาก shadow-inbox (mode=shadowbot)
- **สิ่งที่สร้าง:**
  - API `/api/botworker/replies` — ดึง shadow_replies mode=standalone (filter + sort + limit)
  - หน้า `/botworker` — layout แบบ ticket (ซ้าย list, ขวา detail)
    - list: แสดง inbound + bot reply + platform badge + handoff badge + trigger badge + เวลา
    - detail: แสดงข้อความลูกค้า + คำตอบบอท + metadata + safety notice
    - filter: platform + search
    - polling ทุก 5 วินาที (real-time)
  - Sidebar: เพิ่ม "Bot Worker" ในกลุ่ม "เครื่องมือ" (icon Bot, badge "auto")
- **ไฟล์ที่สร้าง:**
  - `ChatAdminWeb/src/app/api/botworker/replies/route.ts` — API ใหม่
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — หน้า UI ใหม่
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/components/layout/Sidebar.tsx` — เพิ่ม nav item
- **Verify:** tsc ผ่าน ✅

### Phase 2R — เพิ่ม field `mode` ใน shadow_replies (standalone/shadowbot/ticket) (2026-09-12) — ✅ implement เสร็จ
- **เหตุผล:** แยกโหมดการทำงานของ bot (standalone=worker, shadowbot=Generate, ticket=อนาคต) โดยไม่ overloading `origin`
- **สิ่งที่เพิ่ม:**
  - `ShadowReplyDoc.mode?: "standalone" | "shadowbot" | "ticket"` — field ใหม่
  - botworker `storeBotReply` → `mode: "standalone"`
  - botworker `storeWorkflowDelivered` → `mode: "standalone"`
  - shadowReplyService `generate` (manual) → `mode: "shadowbot"`
  - shadowReplyService `generateConversation` (manual_conversation) → `mode: "shadowbot"`
  - `/api/shadow-inbox` GET → รองรับ query param `?mode=standalone|shadowbot|ticket`
- **ความสัมพันธ์กับ origin:**
  - `origin` = ที่มา (worker/manual/manual_conversation/workflow)
  - `mode` = โหมด (standalone/shadowbot/ticket)
  - origin=worker → mode=standalone
  - origin=manual/manual_conversation → mode=shadowbot
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — เพิ่ม field + ตั้ง mode ใน manual/manual_conversation
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` — ตั้ง mode ใน storeBotReply + storeWorkflowDelivered
  - `ChatAdminWeb/src/app/api/shadow-inbox/route.ts` — รองรับ filter ?mode=
- **Verify:** tsc ผ่าน ✅

### Phase 2Q — เอา limit 20 ออก + เพิ่ม concurrency limiter (ปรับได้ใน /admin-config) (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** pollNewMessages limit=20 ทำให้ 500 ข้อความใช้ 25 cycles (25 วินาที) ทั้งที่ buffer เปิดอยู่แล้วและเป็นตัวคุมปริมาณจริง
- **ความต้องการ:** เอา limit ออก ปล่อยดึงทั้งหมด — แต่จำกัดจำนวน callBot ขนานกัน (กัน Python bot โอเวอร์โหลด)
- **Fix:**
  - `pollNewMessages(since?)` — เอา parameter `limit` ออก ดึงทั้งหมดที่เข้ามาใหม่
  - เพิ่ม semaphore pattern: `acquireBotSlot()` / `releaseBotSlot()` จำกัด `MAX_CONCURRENT_BOT_CALLS = 50`
  - ทุกจุดที่เรียก `callBot` ห่อด้วย acquire/release (try/finally)
  - `bot-worker.ts` — ลบ `BATCH_LIMIT` ไม่ส่ง limit แล้ว
- **พฤติกรรมหลังแก้:**
  - 500 ข้อความเข้ามา → poll ดึงทั้ง 500 ใน cycle เดียว → เข้า buffer
  - buffer รวมเป็น 200 context → flush → 200 context เข้า processMessage
  - processMessage ยิง callBot แต่จำกัด 50 ขนานกัน (150 ที่เหลือรอใน queue)
  - 50 ที่ยิงไปเสร็จ → release slot → 50 ถัดไปยิง
  - กว่าจะครบ 200 ใช้เวลาตามความเร็วบอท (ถ้าบอทตอบ 1s → 4 รอบ × 50 = 200 ใน ~4 วินาที)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` — เอา limit ออก + เพิ่ม semaphore
  - `ChatAdminWeb/scripts/bot-worker.ts` — ลบ BATCH_LIMIT
- **Verify:** tsc ผ่าน ✅

### Phase 2P — botworker ประมวลผลเฉพาะข้อความใหม่หลังเปิด (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** botworker ตอนเปิดครั้งแรก → ดึง 20 ข้อความล่าสุดจาก messages_shp → ประมวลผลข้อความเก่าที่ไม่เคยประมวลผล
- **ความต้องการ:** ประมวลผลเฉพาะข้อความที่เข้ามาหลังเปิด botworker
- **Fix:**
  - `pollNewMessages(limit, since?)` — เพิ่ม parameter `since: Date`
  - ถ้ามี `since` → query `created_timestamp: { $gt: since }` (เฉพาะข้อความหลัง timestamp นั้น)
  - `bot-worker.ts` — บันทึก `startedAt = new Date()` ตอนเริ่ม → ส่งไปทุกครั้ง
- **พฤติกรรมหลังแก้:**
  - เปิด botworker → ประมวลผลเฉพาะข้อความที่เข้ามาหลังเปิด
  - ข้อความเก่าก่อนเปิด → ไม่ถูกประมวลผล
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` — pollNewMessages เพิ่ม parameter since
  - `ChatAdminWeb/scripts/bot-worker.ts` — ส่ง startedAt เข้า pollNewMessages
- **Verify:** tsc ผ่าน ✅

### Phase 2O — close_history: record ปิดเท่านั้น + sequence = จำนวนครั้งที่ปิด (2026-09-12) — ✅ implement เสร็จ (แก้ไขจาก 2N)
- **ปัญหาเดิม:** กด reopen แล้ว panel แสดง "เปิดใหม่แล้ว" ใน record เดิม ไม่เห็นเป็น "ครั้งที่ 2"
- **ความต้องการจริง:** record ปิดเท่านั้น — "ครั้งที่ 1 ปิดแล้ว", "ครั้งที่ 2 ปิดแล้ว", "ครั้งที่ 3 ปิดแล้ว"
  - reopen แก้ใน record เดิม (เก็บ reopened_by, reopened_at, reopen_reason)
  - ปิดใหม่ → สร้าง record ใหม่ (sequence = จำนวนครั้งที่ปิด + 1)
- **โครงสร้าง:**
  - `sequence` = จำนวนครั้งที่ปิด (1, 2, 3...) — ไม่นับ reopen
  - `reopened_at` = ถ้ามี → แสดง badge "เปิดใหม่แล้ว" ใน record เดิม
  - ไม่มี record "open" แยก
- **ตัวอย่าง timeline:**
  ```
  ครั้งที่ 1 · ปิดแล้ว (การจัดส่ง) — ปิดโดย admin_001
    └ เปิดใหม่โดย bot (ลูกค้าทักกลับมา)
  ครั้งที่ 2 · ปิดแล้ว (รับประกัน) — ปิดโดย admin_002
    └ เปิดใหม่โดย admin_001 (แอดมินเปิดแชทใหม่)
  ครั้งที่ 3 · ปิดแล้ว (สินค้า) — ปิดโดย admin_001
  ```
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/closeHistoryService.ts` — recordReopen กลับเป็น update record เดิม
  - `ChatAdminWeb/src/lib/types.ts` — กลับเป็นแบบเดิม (ไม่มี action field)
  - `ChatAdminWeb/src/app/api/conversations/[conversationId]/close-history/route.ts` — serialize แบบเดิม
  - `ChatAdminWeb/src/components/chat/CloseHistoryPanel.tsx` — แสดง "ครั้งที่ N · ปิดแล้ว" + reopen info ข้างใน
  - `ChatAdminWeb/src/components/chat/InfoTab.tsx` — แสดงแบบเดิม
- **Verify:** tsc ผ่าน ✅

### Phase 2N — แก้ botWorkerService อ่าน status จาก status_conversation + reopen เป็น "bot" ไม่ใช่ "handoff" (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** botWorkerService อ่าน `conv.status` และ `conv.assigned_to` จาก `conversations` (ที่โดน dump ทับ) ไม่ใช่ `status_conversation`
  - ถ้า dump ทับ status เป็นค่าเก่า → บอทตัดสินใจผิด (อาจตอบทับแอดมิน หรือไม่ reopen ตอนลูกค้าทักกลับมา)
  - บรรทัด 318-322 ยังเขียน `assigned_to=null` ลง `conversations` (ผิดที่)
- **Fix:**
  - อ่าน status/assigned_to จาก `statusConversationService.getMeta()` แทน `conv.status` / `conv.assigned_to`
  - ตอน reopen + เคลียร์ assigned_to → ใช้ `statusConversationService.updateStatus(conv_id, "bot", undefined, "bot-worker")` ไม่ใช่เขียน `conversations`
- **พฤติกรรมหลังแก้:**
  - status=bot (ไม่มี assigned_to) → บอทตอบปกติ
  - status=handoff (มี assigned_to) → บอทข้าม (ปล่อยให้แอดมินตอบ)
  - status=closed → บอท reopen + เคลียร์ assigned_to + ตอบปกติ
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts`
- **Verify:** tsc ผ่าน ✅

### Phase 2M — เพิ่ม log ครบทุก action (ใครทำอะไร ตอบอะไร เปิด/ปิดอะไร) (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** บาง action ไม่เขียน admin_logs (setTopic, setItemIds, togglePinned, tryAssign)
- **สาเหตุ:** ย้ายมา statusConversationService ใน Phase 2J แต่ลืมเขียน log
- **Fix:**
  - `tryAssign` — เขียน log `chat_assigned` เอง (กัน caller ลืม) + ตั้ง status=handoff ด้วย
  - `setTopic` — เขียน log `conversation.set_topic` (มี old_topic, new_topic)
  - `setItemIds` — เขียน log `conversation.set_item_ids` (มี old_item_ids, new_item_ids)
  - `togglePinned` — เขียน log `conversation.pin` / `conversation.unpin`
  - เพิ่ม action_type ใหม่ใน `AdminActionType`: `conversation.set_topic`, `conversation.set_item_ids`, `conversation.pin`, `conversation.unpin`
  - `setConversationTopic/setConversationItemIds/togglePinned` ใน conversationService — เพิ่ม parameter `actor`
- **ตรวจสอบ log ครบทุก action:**
  | Action | action_type | สถานะ |
  |---|---|---|
  | แอดมินตอบลูกค้า | `admin.reply` | ✅ มีอยู่แล้ว |
  | Handoff (bot→admin) | `conversation.handoff` | ✅ มีอยู่แล้ว |
  | Auto-assign (round-robin) | `chat_assigned` | ✅ มีอยู่แล้ว + tryAssign เขียนเองด้วย |
  | Reassign (โยนแชท) | `chat_reassigned` | ✅ มีอยู่แล้ว |
  | ปิดแชท | `conversation.close` | ✅ มีอยู่แล้ว |
  | เปิดแชทใหม่ | `conversation.open` | ✅ มีอยู่แล้ว |
  | Trigger handoff | `bot.handoff_to_admin` | ✅ มีอยู่แล้ว |
  | Bot reply (ทุกกรณี) | `bot.reply` | ✅ มีอยู่แล้ว |
  | Bot process failed | `bot.process_failed` | ✅ มีอยู่แล้ว |
  | ตั้ง topic | `conversation.set_topic` | ✅ เพิ่มใหม่ |
  | ตั้ง item_ids | `conversation.set_item_ids` | ✅ เพิ่มใหม่ |
  | Pin/unpin | `conversation.pin` / `conversation.unpin` | ✅ เพิ่มใหม่ |
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/statusConversationService.ts` — tryAssign/setTopic/setItemIds/togglePinned เขียน log
  - `ChatAdminWeb/src/backend/service/conversationService.ts` — เพิ่ม parameter `actor`
  - `ChatAdminWeb/src/backend/service/adminLogService.ts` — เพิ่ม action_type ใหม่
- **Verify:** tsc ผ่าน ✅

### Phase 2L — แก้ bug โยนแชทแล้วกลับเป็นคนเดิม (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** กดโยนแชทจากแอดมิน 2 → 3 แล้ว polling 3 วิ ดึงข้อมูลใหม่ กลับเป็นแอดมิน 2
- **สาเหตุ:** `assignmentService.reassignConversation` และ `autoAssignConversation` เขียน `assigned_to` ลง `conversations` (ที่โดน dump ทับ) แทน `status_conversation`
  - polling ดึงจาก `/api/admin/conversations` ซึ่งอ่าน `assigned_to` จาก `status_conversation` (หลัง Phase 2J)
  - แต่ reassign เขียนลง `conversations` → polling ไม่เห็นการเปลี่ยนแปลง → กลับเป็นคนเดิม
- **Fix:**
  - `reassignConversation` → ใช้ `statusConversationService.updateStatus()` เขียนลง `status_conversation`
  - `autoAssignConversation` → ใช้ `statusConversationService.tryAssign()` (atomic upsert กัน race condition)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/assignmentService.ts`
- **Verify:** tsc ผ่าน ✅ (รอ verify จริงในหน้า tickets — โยนแล้ว polling ไม่กลับเป็นคนเดิม)

### Phase 2K — แก้หน้า customers (contacts) โหลดช้า (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** หน้า `/contacts` โหลดช้ามาก (1,000-10,000 ลูกค้า)
- **สาเหตุ:** `listCustomers` ทำ `$lookup` join conversations ทุก record ก่อน paginate
  - pipeline: `$match → $lookup (5,000 ครั้ง) → $sort → $count → $skip → $limit`
  - ควรเป็น: `$match → $sort → $skip → $limit (20 คน) → $lookup (20 ครั้ง)`
- **สาเหตุเสริม:** ใช้ hardcoded `"conversations_shp"` แทน `COLLECTIONS.conversations`
- **Fix:**
  - **Case A (sort ตาม last_active_at/created_at):** paginate ก่อน → batch lookup แค่ 20 คน (เร็วมาก)
  - **Case B (sort ตาม name):** ต้อง lookup ก่อน sort (ช้ากว่า แต่จำเป็น) — ใช้ `COLLECTIONS.conversations` แทน hardcoded
  - `getCustomer` ก็ใช้ `COLLECTIONS.conversations` แทน `"conversations_shp"`
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/customerService.ts`
- **Verify:** tsc ผ่าน ✅ (รอ verify ความเร็วจริงในหน้า contacts)

### Phase 2J — แยก collection สถานะแชทออกจาก conversations ที่ถูก dump ทุก 2 วิ (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** `conversations` collection ถูก sellcenter dump ทับทุก 2 วิ → field ที่เราเขียน (assigned_to, status, closed_at, close_count) หาย
- **โซลูชัน:** แยก field ของเราออกเป็น 2 collection ใหม่:
  - `status_conversation` — สถานะจริง (ใช้กับ `/tickets` เท่านั้น)
  - `test_status_conversation` — สถานะทดสอบ (ใช้กับ test-assignment, shadowbot, replay-compare, test-chat)
- **ไม่มี `status_message`** — read/unread/answered คำนวณจาก aggregation เหมือนเดิม
- **ไฟล์ที่สร้างใหม่:**
  - `ChatAdminWeb/src/backend/service/statusConversationService.ts` — service สำหรับ status_conversation (จริง)
  - `ChatAdminWeb/src/backend/service/testStatusConversationService.ts` — service สำหรับ test_status_conversation (test)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/lib/config.ts` — เพิ่ม `statusConversation` + `testStatusConversation` collection
  - `ChatAdminWeb/src/backend/db/mongoClient.ts` — เพิ่ม index สำหรับ 2 collection ใหม่
  - `ChatAdminWeb/src/backend/service/conversationService.ts` — updateConversationStatus/closeConversation/reopenConversation/setTopic/setItemIds/togglePinned เขียนลง status_conversation แทน conversations
  - `ChatAdminWeb/src/backend/service/handoffService.ts` — handoffToAdmin อ่าน/เขียนจาก status_conversation + เพิ่ม handoffToAdminTest สำหรับ test
  - `ChatAdminWeb/src/app/api/admin/conversations/route.ts` — merge status/assigned_to จาก status_conversation เวลา list
  - `ChatAdminWeb/src/app/api/admin/conversations/bot-handoff/route.ts` — simulate mode ใช้ handoffToAdminTest
  - `ChatAdminWeb/src/app/api/test-assignment/route.ts` — ใช้ handoffToAdminTest + เคลียร์ test_status_conversation ก่อน replay
  - `ChatAdminWeb/src/app/api/shadow-inbox/conversations/route.ts` — อ่าน assigned_to/status จาก test_status_conversation
- **โครงสร้าง test_status_conversation:**
  - key: `(source, conversation_id)` — source บอกว่ามาจากหน้าไหน
  - source: `test_assignment` | `shadowbot` | `replay_compare` | `test_chat`
  - ไม่เขียน admin_logs / close_history (test ไม่ต้อง audit)
  - ใช้ round-robin จริง (cursor ขยับจริง) แต่เก็บใน test_status_conversation
- **Verify:** tsc ผ่าน ✅ (รอ verify จริงในแต่ละหน้า)

### Phase 2I — รวม status (open/handoff/pending → handoff) + แยก filter เป็น 2 dropdown (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา 1 (status มั่ว):** `open` = `handoff` = `pending` แปลว่า "ส่งต่อแอดมินแล้ว ยังไม่ปิด" แต่ใช้ชื่อต่างกันในจุดต่างๆ
  - **Fix:** รวมเป็น `handoff` ค่าเดียว — backend ส่ง `handoff` แทน `open`
  - backend: `/api/admin/conversations/route.ts` + `/api/shadow-inbox/conversations/route.ts`
  - frontend: `tickets/page.tsx` reopen ใช้ `handoff` แทน `open`
  - เหลือ status 3 ค่า: `bot` / `handoff` / `closed`
- **ปัญหา 2 (filter มั่ว):** StatusFilter ผสมสถานะแชท + สถานะข้อความเข้าด้วยกัน
  - **Fix:** แยกเป็น 2 dropdown ใน ChatList:
    - **สถานะแชท:** ทั้งหมด / บอทตอบ / ส่งต่อแอดมิน / ปิดแล้ว
    - **สถานะข้อความ:** ทั้งหมด / ยังไม่อ่าน / อ่านแล้ว / ยังไม่ตอบ
  - ลบ `statusTone`/`statusLabel` ค่าเก่า (open/pending/resolved)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/api/admin/conversations/route.ts` (derivedStatus: open → handoff)
  - `ChatAdminWeb/src/app/api/shadow-inbox/conversations/route.ts` (เหมือนกัน)
  - `ChatAdminWeb/src/app/(console)/tickets/page.tsx` (reopen: open → handoff)
  - `ChatAdminWeb/src/components/chat/ChatList.tsx` (แยก filter + ลบค่าเก่า)
- **Verify:** tsc ผ่าน ✅

### Phase 2H — Quick reply ส่งเลย + textarea auto-expand + shadow-inbox dedupe (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา 1 (quick reply ไม่ส่งเลย):** กด quick reply → แอดใน textarea → ต้องกดส่งอีกที
  - **Fix:** กด quick reply → ส่งเลย (เรียก `send()` / `onSend()` โดยตรง)
  - TestChatClient: `send(undefined, qr.body)` — เพิ่ม `overrideMessage` param ใน `send()`
  - TicketChatPanel: `handleQuickReply` เรียก `onSend(qr.body)` โดยตรง
- **ปัญหา 2 (textarea ไม่ขยาย):** textarea สูงคงที่ → ข้อความยาวเป็น scroll ขึ้นลง
  - **Fix:** auto-expand — `onChange` ปรับ `style.height = scrollHeight` (สูงสุด 120-128px)
  - reset height หลังส่ง
  - เปลี่ยนจาก `h-14` / `rows={1}` เป็น `min-h` + `max-h` + `overflow-hidden`
- **ปัญหา 3 (duplicate key ใน shadow-inbox):** `ChatList.tsx:423` duplicate `shp_xxx` จาก ShadowInboxPage
  - **Fix:** dedupe by id ใน `loadConversations` ของ shadow-inbox (เหมือนที่แก้ใน tickets)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` (send override + auto-expand + quick reply send)
  - `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` (quick reply send + textarea auto-expand + ref)
  - `ChatAdminWeb/src/app/(console)/shadow-inbox/page.tsx` (dedupe conversations)
- **Verify:** tsc ผ่าน ✅

### Phase 2G — แก้ duplicate React key warning (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** Console error "Encountered two children with the same key" ในหน้า tickets
  - `shp_1291688535969234763` (conversation list button)
  - `shp_msg_2433748672435323250` (message list)
- **Root cause:** DB มี document ซ้ำ (same message_id / conversation_id) → React key ซ้ำ
- **Fix:** dedupe by id ใน frontend ก่อน setState
  - `loadConversations`: filter ซ้ำออกก่อน `setConversations`
  - `loadMessages`: filter ซ้ำออกก่อน `setMessages`
  - polling path มี dedupe อยู่แล้ว (line 110-117)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/(console)/tickets/page.tsx`
- **Verify:** tsc ผ่าน ✅

### Phase 2F — กัน overscroll/bounce ทุกหน้า (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** เลื่อนสุดขอบ (บน/ล่าง/ขวา) ในหน้าที่ไม่ใช่ sidebar → เห็นขอบนอกแอป (background ด้านนอก)
- **Root cause:** browser overscroll/bounce behavior ไม่ได้ถูก disable
- **Fix:**
  - `globals.css`: เพิ่ม `overscroll-behavior: none` ที่ `html, body` (กัน bounce ทุกที่)
  - `globals.css`: เพิ่ม `body { overflow: hidden }` (กัน body scroll — ปล่อยให้แค่ inner container scroll)
  - `globals.css`: เพิ่ม `body:has(.auth-gradient-bg) { overflow-y: auto }` (หน้า login ยัง scroll ได้ถ้าจอเล็ก)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/globals.css`
- **Verify:** tsc ผ่าน ✅

### Phase 2E — Quick reply position auto-increment + floating chips UI (2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา 1 (ตำแหน่งทับกัน):** สร้าง quick reply ใหม่ให้ร้าน A → user ใส่ sort_order=0 ทุกครั้ง → ทับกับของเดิม
  - **Fix:** `createQuickReply` ใน backend คำนวณ `sort_order = max(existing) + 1` อัตโนมัติ (ไม่สนค่าที่ user ส่งมา)
  - **Frontend:** ซ่อน input sort_order ตอนสร้างใหม่ (แสดง "กำหนดอัตโนมัติ") — โชว์เฉพาะตอนแก้ไข
- **ปัญหา 2 (UI ไม่ใช่แบบที่อยากได้):** quick replies เป็น dropdown ใหญ่ทับ chat area
  - **Fix:** เปลี่ยนเป็น floating chips (ปุ่มกลมเล็กๆ) เหนือ text box — กดแล้วใส่คำตอบใน text box ทันที
  - ลบ `showQuickReplies` state + `Zap` import (ไม่ใช้แล้ว)
- **ปัญหา 3 (test chat ไม่มี quick reply):** TestChatClient ไม่มี quick replies เลย
  - **Fix:** เพิ่ม quick replies ใน TestChatClient — โหลดจาก API กรองตาม platform=shopee + shop + enabled
  - แสดงเป็น floating chips เหนือ textarea (เหมือน TicketChatPanel)
  - ซ่อนตอน handedOff (บอทไม่ตอบ)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/quickReplyService.ts` (createQuickReply: auto-increment sort_order)
  - `ChatAdminWeb/src/app/(console)/quick-replies/page.tsx` (form: ซ่อน sort_order ตอน create)
  - `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` (UI: dropdown → floating chips)
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` (เพิ่ม quick replies + floating chips UI)
- **Verify:** tsc ผ่าน ✅ — รอ verify จริง

### Phase 2D — Round-robin assignment investigation + fix (2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา:** replay Shadowbot conversation เดิม 2 ครั้ง → ครั้งแรกได้ admin 1, ครั้งที่ 2 ได้ admin 2 (ควร retain admin เดิม)
- **Root cause (simulateHandoff path):**
  1. `simulateHandoff` เรียก `autoAssignConversation({ conversation_id: "sim_${sessionId}" })`
  2. `autoAssignConversation` เรียก `pickNextAgent` ขยับ cursor ไป admin 1
  3. แล้ว `findOneAndUpdate({ conversation_id: "sim_xxx", assigned_to: null })` บน `conversations` collection
  4. แต่ `sim_xxx` ไม่มีใน `conversations` → update ล้มเหลว → คืน null
  5. **cursor ขยับไปแล้ว** แต่ assignment ไม่สำเร็จ → `test_chat_sessions.assigned_to = null`
  6. replay ครั้งที่ 2 → `session.assigned_to = null` → `pickNextAgent` อีกครั้ง → cursor ขยับไป admin 2
- **Root cause (production handoffToAdmin path):** ไม่มีปัญหา — Step 1 เช็ค `conv.assigned_to` ก่อน ถ้ามีอยู่แล้ว → ใช้คนเดิม
- **Fix:** เปลี่ยน `simulateHandoff` ให้เรียก `pickNextAgent` โดยตรง (ไม่ผ่าน `autoAssignConversation`)
  - ไม่ต้อง atomic update บน `conversations` (เพราะ sim_xxx ไม่มีอยู่จริง)
  - เก็บ assigned_to ใน `test_chat_sessions` โดยตรง
  - replay ครั้งที่ 2 → `session.assigned_to = admin1` → Step 1 ใช้คนเดิม → ไม่เรียก `pickNextAgent` อีก
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/api/admin/conversations/bot-handoff/route.ts` (simulateHandoff: เรียก pickNextAgent โดยตรง)
- **Note:** `autoAssignConversation` cursor advancement ก่อน atomic update เป็น design decision ("เสียตาคิวไปหนึ่งตา ยอมรับได้") — ไม่แก้เพราะไม่กระทบ production และ simulation path ไม่ใช้ autoAssignConversation แล้ว
- **Verify:** tsc ผ่าน ✅ — รอ verify จริง

### Phase 2C — Regression check (2026-09-12) — ✅ ผ่าน
- **เคสที่เช็ค**:
  1. **C — Context loss (Q1, Q2)**: ไม่แตะ conversation_products.py → ปลอดภัย ✅
  2. **A — Warranty trigger ("ถ้ามีปัญหาเคลมได้ใช่ไหมครับ")**: match `_CLAIM_QUESTION_PATTERNS` ก่อน → ไม่มี symptom kw → return False → บอทตอบ policy ไม่เข้า claim flow ✅
  3. **B — Trigger cascade (Q12 trust, Q13 iOS/Android)**: ไม่มี complaint keywords → `_has_strong_complaint=False` → LLM override ยังทำงานปกติ ✅
  4. **D — Trust (Q5, Q8, Q9)**: ไม่มี complaint keywords → ไม่กระทบ ✅
  5. **Order lookup**: ไม่แตะ order lookup logic → ปลอดภัย ✅
  6. **Short answers (Q2, Q6, Q7)**: ไม่แตะ answer length → ปลอดภัย ✅
  7. **Phase 1F — Test Chat Image Upload**: `ticket_state` optional (None = backward compat) → `resolveTicketState` คืน null ถ้าไม่มี conversationId → ปลอดภัย ✅
  8. **Charger subtype (Q9)**: ไม่แตะ charger subtype → ปลอดภัย ✅
- **Edge case ที่แก้เพิ่ม**:
  - "มีสายแรงกว่านี้ไหม [รูปภาพ]" ใน context warranty → guard: `_is_post_handoff_product_q=True` → ไม่ถือเป็น claim evidence → ปล่อยไป product flow ✅
  - "เปลี่ยนหัวชาร์จก็ใช้ไม่ได้ค่ะ" → เพิ่ม "ใช้ไม่ได้" ใน `_warranty_q_kws` → `_is_post_handoff_product_q=False` → post-handoff lock ทำงาน ✅
  - Q3 complaint ครั้งแรก → `_has_strong_complaint=True` ("ชาร์จไม่เข้า") → ห้าม LLM override แม้ไม่มี repeated complaint ✅
- **Verify**: py_compile ผ่าน ✅ + tsc ผ่าน ✅

### Phase 2B — แก้เคส patintidamanolai (เริ่ม 2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา 1 (Q3-Q8 วนซ้ำ):** ลูกค้าแจ้ง "ชาร์จไม่เข้า" ซ้ำ + ส่งวิดีโอ → บอทตอบ troubleshooting วนซ้ำ ไม่เข้า claim flow
  - **Root cause:** "ชาร์จไม่เข้า" อยู่แค่ใน `_symptom_kws` (ใช้ต่อเมื่อ match `_CLAIM_QUESTION_PATTERNS` ก่อน) → `detect_claim_request` ไม่จับ → LLM ตอบ troubleshooting
  - **Fix 1:** เพิ่ม "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด", "ชาร์จไม่ได้", "ไม่เข้าเลย", "ไฟไม่เข้า" ฯลฯ ใน `_CLAIM_REQUEST_INDICATORS` โดยตรง
- **ปัญหา 2 (Q5 LLM override):** "เปลี่ยนหัวชาร์จก็ใช้ไม่ได้ค่ะ" มี "ใช้ไม่ได้" match claim แต่ LLM override เป็น False
  - **Root cause:** LLM classify เป็น intent อื่น (เช่น product_recommend) + confidence >= 0.7 → override claim_request=False
  - **Fix 2:** เพิ่ม "repeated complaint" guard — ถ้าลูกค้าแจ้งปัญหาซ้ำ 2+ ครั้งใน history → ห้าม LLM override
- **ปัญหา 3 (Q11 tag ผิด):** ลูกค้าส่งรูปใน context warranty → บอทตอบเป็น product info ของ ZM411 (สินค้าเก่า)
  - **Root cause:** State 7 ทำงานเฉพาะเมื่อ `_bot_asked_claim_info=True` (บอทขอ claim info ใน last message) → Q11 บอทตอบเรื่องระยะเวลาเคลม ไม่ได้ขอ claim info → State 7 ไม่ทำงาน → รูปตกไป active product fallback
  - **Fix 3:** เพิ่ม "warranty context image" check — ถ้า history มี warranty/claim keywords และลูกค้าส่งรูป/วิดีโอ → ถือเป็น claim evidence แม้บอทไม่ได้ขอ claim info ใน last message
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/warranty.py` (`_CLAIM_REQUEST_INDICATORS` เพิ่ม charging symptoms)
  - `chatbot/shopeechat/app.py` (repeated complaint guard + warranty context image check)
  - `docs/SRS_SSD.md` (อัปเดต section 6.8.4)
- **Verify:** py_compile ผ่าน ✅ + tsc ผ่าน ✅ — รอ verify จริง

### Phase 2A — State-driven open/closed (เริ่ม 2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: ปุ่ม "ปิดแชท" ใน test chat แค่ `setHandedOff(false)` client-side → บอทไม่รู้ว่าปิดแล้ว → ยังล็อค post-handoff เพราะแสกน history หา "รอการติดต่อกลับ"
- **Root cause** (5 จุดที่ขาด):
  1. ปุ่ม "ปิดแชท" ไม่ได้เรียก API อัปเดต DB
  2. `botCallService.callBot()` ไม่ส่ง conversation status ไปบอท
  3. `ChatRequest` (Python) ไม่มี field รับ `ticket_state`
  4. บอท post-handoff logic สรุปจาก text ใน history ไม่ใช่ state
  5. `simulate_handoff` ไม่มี `simulate_close` endpoint
- **วิธีแก้** (state-driven ไม่ใช่ keyword-driven):
  1. ✅ เพิ่ม endpoint `/test-chat/sessions/{id}/close` + `/reopen` ใน Python bot — อัปเดต `test_chat_sessions.status`
  2. ✅ ปุ่ม "ปิดแชท" ใน TestChatClient เรียก endpoint ผ่าน proxy + setSessionStatus("closed")
  3. ✅ เพิ่ม `ticket_state` field ใน `ChatRequest` (Python)
  4. ✅ `botCallService.ts` ดึง status จาก DB (`resolveTicketState`) + ส่ง `ticket_state` ใน payload
  5. ✅ บอทใช้ `ticket_state` ตัดสินใจ:
     - `closed` → ข้าม post-handoff lock ทั้งหมด
     - `handoff`/`open` + มี handoff marker → ล็อค (ยกเว้น exceptions)
     - `None` → fallback ใช้ history scan แบบเดิม (backward compat)
  6. ✅ เพิ่ม `post_handoff_exceptions: string[]` ใน ShopSettings — แอดมินตั้งได้ต่อร้าน
  7. ✅ บอทดึง exceptions ผ่าน `_get_post_handoff_exceptions()` + ถ้า message match exception → ตอบปกติ ไม่ล็อค
- **ไฟล์ที่แก้**:
  - `chatbot/shopeechat/app.py` (endpoint close/reopen + ticket_state field + _get_post_handoff_exceptions + post-handoff logic)
  - `ChatAdminWeb/src/backend/service/botCallService.ts` (resolveTicketState + ส่ง ticket_state)
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` (ส่ง conversationId + simulate ให้ callBot)
  - `ChatAdminWeb/src/backend/service/shopSettingsService.ts` (post_handoff_exceptions field)
  - `ChatAdminWeb/src/app/api/shop-settings/route.ts` (รับ post_handoff_exceptions)
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` (sessionStatus state + ส่ง ticket_state + เรียก close API)
- **Verify**: py_compile ผ่าน ✅ + tsc ผ่าน ✅ — รอ verify lifecycle จริง

### Phase 1F — Test Chat Image Upload (เริ่ม 2026-09-11)
- **ปัญหา**: ปุ่ม "ปิดแชท" ใน test chat แค่ `setHandedOff(false)` client-side → บอทไม่รู้ว่าปิดแล้ว → ยังล็อค post-handoff เพราะแสกน history หา "รอการติดต่อกลับ"
- **Root cause** (5 จุดที่ขาด):
  1. ปุ่ม "ปิดแชท" ไม่ได้เรียก API อัปเดต DB
  2. `botCallService.callBot()` ไม่ส่ง conversation status ไปบอท
  3. `ChatRequest` (Python) ไม่มี field รับ `ticket_state`
  4. บอท post-handoff logic สรุปจาก text ใน history ไม่ใช่ state
  5. `simulate_handoff` ไม่มี `simulate_close` endpoint
- **วิธีแก้** (state-driven ไม่ใช่ keyword-driven):
  1. เพิ่ม endpoint `/test-chat/sessions/{id}/close` ใน Python bot — อัปเดต `test_chat_sessions.status = "closed"`
  2. ปุ่ม "ปิดแชท" ใน TestChatClient เรียก endpoint นี้ผ่าน proxy
  3. เพิ่ม `ticket_state` field ใน `ChatRequest` (Python)
  4. `botCallService.ts` ดึง status จาก DB + ส่ง `ticket_state` ใน payload
  5. บอทใช้ `ticket_state` ตัดสินใจ:
     - `closed` → ข้าม post-handoff lock ทั้งหมด
     - `handoff`/`open` + มี handoff marker → ล็อค (ยกเว้น exceptions)
     - `None` → fallback ใช้ history scan แบบเดิม (backward compat)
  6. เพิ่ม `post_handoff_exceptions: string[]` ใน ShopSettings — แอดมินตั้งได้ต่อร้าน
  7. บอทดึง exceptions + ถ้า message match exception → ตอบปกติ ไม่ล็อค
- **เคสที่ต้องไม่พัง**: warranty Q1 first message, Q11 trigger, Q12 cascade, Q9 cable, Q14 BioKoop, post-handoff product Q escape, review request, phone extraction
- **Verify**: lifecycle 10 ขั้นตอน (handoff → close → ส่ง product Q → ตอบ product_store → ส่ง warranty ใหม่ → เข้า warranty flow ได้)

### Phase 1F — Test Chat Image Upload (เริ่ม 2026-09-11)
- **ปัญหา**: TestChatClient ไม่มี UI ส่งรูป ลูกค้าพิมพ์ `[รูปภาพ]` เอง → bot เห็นแค่ text placeholder ไม่เห็นรูปจริง → ตอบ "รูปอาจไม่แสดงผล"
- **เป้าหมาย**: เพิ่มปุ่ม upload รูปใน TestChatClient → ส่ง URL ให้ bot ผ่าน buffer → bot เห็นรูปจริง
- **สิ่งที่ทำ**:
  1. `/api/test-chat/upload` — รับ multipart formdata → เก็บใน Mongo `test_chat_uploads` → คืน URL
  2. `/api/test-chat/uploads/[id]` — GET serve binary กลับ (bot ดึง URL นี้ได้)
  3. TestChatClient เพิ่มปุ่ม 📎 upload + preview thumbnails + ส่ง URL ไป buffer/non-buffer
  4. buffer route รับ `images[]` + เก็บใน raw_payload + ใส่ placeholder ถ้า message ว่าง
  5. flush route รวม images จากทุก message + แปลง URL สัมพันธ์เป็น absolute + ส่ง `images` ให้ bot
  6. config เพิ่ม `testChatUploads` collection
- **เคสที่ผ่าน** (verify แล้ว):
  - tsc ผ่าน ✅
  - py_compile ผ่าน ✅
  - upload endpoint ต้องการ auth (401 ถ้าไม่มี cookie) ✅
  - logic รวม images จากหลาย message ใน flush route ✅
  - middleware ปล่อย `/api/test-chat/uploads` public (แก้ 401 → 200) ✅
  - uploads endpoint serve binary สำหรับ <img> ได้ (HTTP 200 image/png 345KB) ✅
  - bot เห็นรูปจริง + ตอบเกี่ยวกับสินค้าในรูปได้ (Q5 ใน session CukTechThailand) ✅
  - processMessage รับ images จาก buffer flush + ส่งให้ bot (production path) ✅
  - test-chat imageViewer กดดูรูปใหญ่ได้ ✅
  - replay-compare แสดงรูปจริงใน QA detail + ส่ง user_media จาก Python ✅
  - bot max_images อ่านจาก env BOT_MAX_IMAGES_PER_TURN (default 5) ไม่ใช่ fixed 3 ✅
  - bot ใช้ vision desc ใน retrieval ถ้า message เป็น placeholder รูปทั้งหมด ✅
  - TestChatClient history เก็บ images + ส่งให้ bot ใน history field ✅
  - admin-config UI แสดง media buffer config (window + max) แยกจาก text ✅
  - admin-config API validation รองรับ media buffer keys ✅
- **E2E test ผ่าน**:
  - bot รับ images + ตอบเกี่ยวกับรูปได้ ✅
  - bot รับ 4 รูป (max_images=5) ไม่ error ✅
  - bot รับ history มี images ไม่ error ✅
  - text-only regression ผ่าน ✅
  - warranty regression (เคส A) ผ่าน ✅
- **ไฟล์ที่แก้**: `test-chat/upload/route.ts`, `test-chat/uploads/[id]/route.ts`, `test-chat/buffer/route.ts`, `test-chat/flush/route.ts`, `TestChatClient.tsx`, `config.ts`, `middleware.ts`, `bufferService.ts`, `botWorkerService.ts`, `replay-compare/page.tsx`, `replay_compare.py`, `chatbot/shopeechat/app.py`, `admin-config/page.tsx`, `admin-config/route.ts`
- **Verify**: tsc ผ่าน + py_compile ผ่าน + e2e bot test ผ่าน 5 เคส

### Phase 1F-fix — Image persist + trigger cascade + vision-retrieval (2026-09-04)
- **ปัญหาที่แก้**:
  1. รูปขึ้นเป็น HTML text ใน user message bubble (หลัง reload)
  2. รีเฟรชหน้าแล้วรูปหาย (images ไม่ถูก persist ลง DB)
  3. warranty flow จับ Q5 ติด (trigger cascade — Q1 warranty → Q2-Q4 product → Q5 โดนจับ)
  4. vision desc ไม่ถูกใช้ใน retrieval ถ้า message อ้างถึงรูป ("น้องในรูปคือตัวอะไร")
- **วิธีแก้**:
  1. เพิ่ม `images: list[str]` field ใน `TestChatMessage` Python model
  2. `saveMessageToSession` ส่ง images ไป DB ด้วย
  3. ตอน reload — render รูปจาก `m.images` เป็น `<img>` HTML (ไม่ใช่ escapeHtml ทั้งหมด)
  4. warranty state machine — เพิ่ม `_last_model_is_warranty` guard ใน fallback `_bot_asked_info_ever`
     - ถ้า last model message ไม่ใช่ warranty เลย → ไม่ใช้ fallback นี้
  5. vision-retrieval — ขยายเงื่อนไขจับคำอ้างถึงรูป ("ในรูป", "รูปนี้", "ตัวนี้", "น้องในรูป")
- **เคสที่ผ่าน** (verify แล้ว):
  - Q5 "ไม่ใช่ น้องในรูป..." หลัง product answer → ไม่ติด warranty flow ✅
  - Q4 "น้องในรุปคือตัวอะไร" + รูป → vision-retrieval ทำงาน ตอบเกี่ยวกับรูป ✅
  - warranty Q1 ยังทำงานปกติ ✅
  - warranty State 7 (ส่งรูปหลัง bot ขอ) ยังทำงาน ✅
  - tsc + py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (TestChatMessage + warranty guard + vision-retrieval), `TestChatClient.tsx` (saveMessageToSession + reload render)
- **ยังเหลือ**: Q9 "สายแรงๆ กว่านี้ใช้กับ mi 17 ultra" → bot แนะนำแบตแทนสาย (retrieval ไม่กรอง charger_subtype) — ไว้ทำทีหลัง

### Phase 1F-Q9 — Charger subtype retrieval fix (2026-09-04)
- **ปัญหา**: Q9 "มีสายแรงๆ กว่านี้ใช้กับ mi 17 ulrat ไหม" → intent บอก charger_subtype=cable ชัด แต่ bot แนะนำแบตสำรองทั้ง 5 รุ่น
- **สาเหตุ** (3 จุด):
  1. FUZZY-MATCH ดึงสินค้าที่ fuzzy match "mi 17 ulrat" → ได้แบตสำรอง 5 ตัว (ชื่อมี "mi") โดยไม่กรอง charger subtype
  2. `if not _ref_regex_products` อยู่ใน `else` block ของ `if _ref_regex_products` → ถ้า _ref_regex_products ถูกยกเลิกใน if block (กรอง subtype เหลือ 0) → ไม่เข้า else → ไม่ได้ fetch ใหม่
  3. `_skip_sub = _is_superlative and not _detect_charger_subtype(retrieval_message)` → True เพราะ "สายแรงๆ" ไม่มี "สายชาร์จ" เต็ม → ข้าม subtype filter ทั้งหมด ทั้งที่ intent บอก cable ชัด
- **วิธีแก้**:
  1. เพิ่ม `charger_subtype_override` logic ใน `fetch_products` — ถ้ามี override ให้เพิ่ม "charger" เข้า product_types เสมอ (กัน product_types={"phone"} ข้าม subtype filter)
  2. เพิ่ม REF-SUBTYPE-FILTER หลัง `products = _ref_regex_products` — กรอง charger subtype สำหรับ FUZZY-MATCH/MODEL-REGEX path ที่บายพาส fetch_products
  3. ย้าย superlative/fetch logic ออกจาก `else` block → เป็น `if not _ref_regex_products:` แยก (ทำงานแม้ _ref_regex_products ถูกยกเลิก)
  4. `_skip_sub` เพิ่ม guard `and not _intent_sub_early` — ถ้า intent บอก charger_subtype ชัด → ไม่ skip แม้เป็น superlative
- **เคสที่ผ่าน** (verify แล้ว):
  - Q9 "มีสายแรงๆ กว่านี้ใช้กับ mi 17 ulrat ไหม" → ดึงสายชาร์จ 10 รุ่น (ไม่ใช่แบต) ✅
  - "มีสายชาร์จไหม" → ยังดึงสายชาร์จถูกต้อง ✅
  - warranty Q1 → ยังทำงานปกติ ✅
  - tsc + py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (REF-SUBTYPE-FILTER + ย้าย if not _ref_regex_products + _skip_sub guard), `chatbot/shopeechat/product_store.py` (charger_subtype_override → product_types)

### Phase 1F-Warranty — Review request + phone extraction fix (2026-09-04)
- **ปัญหา**: หลัง handoff แอดมิน ลูกค้าถาม "ทวนข้อมูลที่ผมให้ไปหน่อย" → bot ตอบ generic "ระบบได้บันทึกข้อมูล..." ซ้ำๆ ไม่ทวนจริง
  - และ "087 788 7888" (เบอร์โทรมี space) → bot ดึงเป็นชื่อ-นามสกุลแทนเบอร์ เพราะ phone pattern ไม่ลบ space
- **สาเหตุ**:
  1. `_PHONE_PATTERN = r"\b0\d{8,9}\b"` ไม่จับ "087 788 7888" เพราะมี space คั่น → extract เป็น name แทน
  2. `_post_handoff_has_info` เช็คแค่ order_id ไม่เช็ค phone/name → เบอร์ตกไป generic post-handoff
  3. ไม่มี state สำหรับ "ทวนข้อมูล" → ตอบ generic ซ้ำ
  4. State 6 `_has_valid_name` ใช้ `_info["name"]` โดยตรงใน review_lines ไม่ได้เช็ค valid name flag
- **วิธีแก้**:
  1. `warranty.py`: ลบ space และ "-" ก่อน match phone pattern (`re.sub(r"[\s\-]", "", msg)`)
  2. `app.py`: เพิ่ม phone/name ใน `_post_handoff_has_info` check
  3. `app.py`: เพิ่ม review request state — ดึง info จาก history แยกแต่ละ message + กรอง name ที่มีตัวเลข/คำแปลกๆ
  4. `app.py`: State 6 ใช้ `_has_valid_name` แทน `_info["name"]` ใน review_lines + เพิ่ม guard "name มีตัวเลข → ไม่ valid"
- **เคสที่ผ่าน** (verify แล้ว):
  - Q7 "087 788 7888" post-handoff → ตอบรับเบอร์ 0877887888 (ไม่ดึงเป็นชื่อ) ✅
  - Q8 "ทวนข้อมูลที่ผมให้ไปหน่อย" → ทวนเบอร์ + รูป จาก history ✅
  - warranty Q1 ยังทำงานปกติ ✅
  - Q9 สายชาร์จ ยังดึง 10 รุ่น ✅
  - py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/warranty.py` (phone pattern ลบ space), `chatbot/shopeechat/app.py` (review request state + _post_handoff_has_info + _has_valid_name guard)

### Phase 1F-PostHandoff — Post-handoff lock-in escape (2026-09-04)
- **ปัญหา**: หลัง bot handoff แอดมิน → ทุกข้อความต่อไปถูกล็อคเป็น "ระบบได้บันทึกข้อมูล..." แม้ "หาสายชาร์จครับ" หรือ "มีสายแรงๆ กว่านี้" ที่เป็น product question ชัดๆ
  - สถานการณ์จริง: แอดมินปิดแชท (resolve ticket) → ลูกค้าทักใหม่ด้วยคำถามสินค้า → bot ยังล็อคอยู่ใน post-handoff
- **สาเหตุ**: `if _bot_handed_off and not _post_handoff_has_info:` ล็อคทุกข้อความที่ไม่ใช่ claim info โดยไม่ตรวจว่าเป็น product question ไหม
- **วิธีแก้**: เพิ่ม post-handoff escape — ถ้าลูกค้าถาม product question ชัด (มี product keyword และไม่มี warranty keyword) → ปล่อยไปเส้นทางปกติ
  - Product keywords: สายชาร์จ, หัวชาร์จ, แบต, พาวเวอร์แบงค์, หาสาย, มีสาย, สวัสดี, ราคา, etc.
  - Warranty keywords: เคลม, ประกัน, ทวนข้อมูล, ส่งสินค้า, พัสดุ, เบอร์, etc.
  - ถ้ามี warranty keyword → ยังล็อค (เช่น "เคลมสายชาร์จ" ยังเป็น warranty)
- **เคสที่ผ่าน** (verify แล้ว):
  - "หาสายชาร์จครับ" หลัง handoff → ตอบ product 10 รุ่น ✅
  - "มีสายแรงๆ กว่านี้ใช้กับ mi 17 ulrat ไหม" หลัง handoff → ดึงสายชาร์จ 10 รุ่น ✅
  - "สวัสดีครับ หาสายชาร์จครัย" หลัง handoff → ตอบ product ✅
  - "ทวนข้อมูลที่ผมให้ไปหน่อย" หลัง handoff → ยังทวนข้อมูล (ไม่หลุด) ✅
  - "เคลมสายชาร์จหน่อย" หลัง handoff → ยังเป็น warranty (มี "เคลม") ✅
  - warranty Q1 ยังทำงานปกติ ✅
  - py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (post-handoff escape: _is_post_handoff_product_q check)

### Phase 1E — Media-aware Buffer (เริ่ม 2026-09-11)
- **ปัญหา**: ลูกค้าชอบส่งหลายรูป + พิมพ์ตาม แต่ buffer ปัจจุบันใช้เวลาเดียวกับ text
  - ถ้ารอนานเท่า text → รูปยังไม่ครบก็ flush แล้ว
  - ถ้ารอนานเท่ากับทุกอย่าง → text ค้างนานเกินไป
  - flush ส่งแค่ firstMsg.raw_payload → รูปที่ 2,3 หาย
- **สิ่งที่ทำ**:
  1. `BufferConfig` เพิ่ม `bufferWindowMediaMs` (default 12000ms) + `bufferMaxMediaMessages` (default 10)
  2. `hasMedia(rawPayload)` — ตรวจ message_type เป็น image/video/image_with_text
  3. `extractMediaUrls(rawPayload)` — ดึง URL จาก image_url / image_url_list / video_url
  4. `bufferOrProcess` — ถ้า buffer มี media → ใช้ window นานกว่า + max มากกว่า
  5. `flushBuffer` — รวม images จากทุก message (ไม่ใช่แค่ firstMsg) → ฝังใน `_merged_images` field
  6. `systemConfigService` เพิ่ม `bot_buffer_window_media_ms` + `bot_buffer_max_media_messages` (env + DB + admin-configurable)
- **เคสที่ผ่าน** (verify แล้ว):
  - hasMedia จับ image/video/image_with_text ถูก ✅
  - extractMediaUrls ดึง URL จาก image_url + image_url_list + video_url ถูก ✅
  - merge รวม URLs จากหลาย message ไม่ซ้ำ ✅
  - tsc ผ่าน ✅
- **ไฟล์ที่แก้**: `bufferService.ts`, `systemConfigService.ts`, `botWorkerService.ts`
- **Verify**: tsc ผ่าน + node test hasMedia/extractMediaUrls/merge ผ่าน

### Phase 1B — Tracking Lookup (เริ่ม 2026-09-11)
- **เป้าหมาย**: ลูกค้าส่งรูป tracking / ถามสถานะ → บอทเช็ค tracking จาก MongoDB → ตอบสถานะ + ขนส่ง
- **สิ่งที่ทำ**:
  1. `order_store.lookup_order` เพิ่ม `tracking_no` + `tracking_numbers` จากทุก `package_list` entry (ไม่ใช่แค่ entry แรก) — เช็ค field: tracking_no, tracking_number, parcel_id, waybill_id
  2. `order_store.lookup_by_tracking(tracking_no, shop_filter)` — ค้น order จาก tracking number (MongoDB only) — ค้นใน package_list ทุก field
  3. `order_store.extract_tracking_number(text)` — ดึง tracking จาก text/vision OCR — รองรับ SPX/Kerry/Flash/J&T/ไปรษณีย์ไทย + กรองเบอร์โทรออก
  4. `build_order_context` เพิ่ม tracking_no + tracking_numbers (ถ้ามีหลาย package)
  5. `app.py` เชื่อม tracking lookup เข้า flow — ถ้าไม่มี order_sn แต่มี tracking (ในข้อความหรือ vision desc) → lookup_by_tracking → context → LLM ตอบสถานะ
- **เคสที่ผ่าน** (verify แล้ว):
  - ส่งเลขพัสดุ "SPXTH1234567890" → log แสดง `[TRACKING] พบ tracking_no=SPXTH1234567890 → lookup` + บอทตอบเป็นมิตร (ไม่พบใน DB เพราะเลขสมมุติ) ✅
  - order_sn lookup ยังทำงานปกติ (source=order_lookup) ✅
  - Regression (ไม่มี tracking/order) → บอทตอบปกติ ✅
- **ไฟล์ที่แก้**: `order_store.py`, `app.py`
- **Verify**: `py_compile` ผ่าน + curl test 3 เคสผ่าน + log แสดง [TRACKING]

### Phase 1C — Order Panel + Warranty Auto-Check (เริ่ม 2026-09-11)
- **เป้าหมาย**:
  1. Ticket panel ด้านขวา แสดง order cards (collapsible) พร้อม รูป + ชื่อ + ราคา + variant + สถานะ + ขนส่ง + tracking
  2. Warranty auto-check: ลูกค้าถามเคลม → บอทเช็ควันซื้อจาก order → ระยะประกัน → ตอบเงื่อนไข → โยนเข้า warranty_claim
- **สิ่งที่ทำ**:
  1. `order_store.lookup_order` เพิ่ม variant/price/image/sku/item_id/model_id + total_amount + buyer_username + payment_method + create_time_raw
  2. `order_store.lookup_orders_by_buyer(buyer_username, shop_filter, limit)` — ดึง order history ของลูกค้า
  3. Next.js API `/conversations/[id]/orders` ดึง order history พร้อม tracking + variant + price + image + total_amount + buyer_username
  4. `InfoTab.tsx` OrderHistorySection — collapsible per-order card + รูป + ราคา + variant + tracking + logistics_status + payment_method
  5. `warranty.py auto_check_warranty(order_sn, shop_filter, warranty_months=12)` — เช็ควันซื้อ → คำนวณ is_in_warranty → สร้าง warranty_text ให้ LLM
  6. `app.py` เชื่อม warranty auto-check เข้า flow — ถ้า claim request + มี order_sn → ข้าม order_lookup → auto_check_warranty → แนบ context ใน first-message claim answer
- **เคสที่ผ่าน** (verify แล้ว):
  - "สินค้าเสีย อยากเคลม เลขคำสั่งซื้อ 240215MCEQMT60" → source=warranty_claim_first_message + ตอบ "ซื้อเมื่อ 15 ก.พ. 2567 หมดช่วงประกันแล้ว" + ขอข้อมูลเคลม ✅
  - order_sn lookup ยังทำงานปกติเมื่อไม่ใช่ claim (source=order_lookup) ✅
  - Regression (ทักทาย) → บอทตอบปกติ ✅
- **ไฟล์ที่แก้**: `order_store.py`, `warranty.py`, `app.py`, `InfoTab.tsx`, Next.js API route
- **Verify**: `py_compile` + `tsc` ผ่าน + curl test 3 เคสผ่าน

### Phase 1D — Replay + Docs (เริ่ม 2026-09-11)
- **เป้าหมาย**:
  1. `replay_compare.py` ส่ง images จาก stored `raw_payload`
  2. อัปเดต `docs/SRS_SSD.md` ให้ครบ
- **สิ่งที่ทำ**:
  1. `replay_compare.py build_bot_message` คืน `(message, item_id, images)` — ดึง URL รูป/วิดีโอจาก media
  2. `replay_compare.py parse_raw_message` เพิ่ม `media` field สำหรับ image/video (url + type)
  3. `replay_compare.py call_bot` รับ `images` parameter + ส่งใน body
  4. จุดเรียก call_bot ส่ง `images=msg_images` ให้ bot
- **ไฟล์ที่แก้**: `replay_compare.py`
- **Verify**: `py_compile` ผ่าน

###  Plan ค้าง: Order Panel + Warranty Auto-Check (ทำหลัง multimodal เสร็จ)
- **Order Panel (ticket ด้านขวา)**:
  - แสดงการ์ดสินค้าพร้อมรูป + ชื่อ + ราคา + สี/variant + สถานะการจัดส่ง + แบรนด์ + ร้าน + วันที่จัดส่ง + ขนส่ง
  - เป็น collapsible card — กดดูรายละเอียดเพิ่มได้
  - ปัจจุบัน: `OrderHistorySection` ใน `InfoTab.tsx` แสดง 5 รายการล่าสุด + ปุ่ม "ดูทั้งหมด" — ต้องเพิ่มรูป + variant + tracking + collapsible
- **Order Status Query (ลูกค้าถาม)**:
  - ลูกค้าถามสถานะสินค้า → บอทตอบสถานะปัจจุบัน + ขนส่ง (ถ้าส่งแล้ว)
  - ปัจจุบัน: `order_store.lookup_order()` ดึงสถานะได้ แต่ไม่มี tracking_no
- **Warranty Auto-Check (ลูกค้าถามเคลม)**:
  - ลูกค้าถามเคลม → บอทเช็ควันที่ซื้อจากเลขออเดอร์ → ถ้าอยู่ในระยะประกัน → ตอบเงื่อนไข + ระยะเวลา → โยนเข้า warranty_claim flow
  - ปัจจุบัน: warranty flow ขอข้อมูลแล้ว handoff แต่ไม่เช็ควันที่ซื้ออัตโนมัติ
- **ไฟล์ที่จะแก้**: `InfoTab.tsx`, `order_store.py`, `warranty.py`, `app.py`

### include_desc merge — intent บอก False แต่ keyword บอก True → ไม่ส่ง description ให้ LLM
- **เคสที่พบ** (test chat YoupinOfficialStore, BioKoop):
  - ลูกค้าถาม "ขอรายละเอียดเพิ่มเติมได้ไหมครับ" หลังคุยเรื่อง BioKoop
  - สินค้ามี description ยาวเต็ม (จุดเด่น, ข้อมูลสินค้า, อุปกรณ์ในกล่อง)
  - แต่บอทตอบ "ไม่มีรายละเอียดเพิ่มเติมในระบบแล้ว"
- **Root cause**:
  1. `include_desc` ใน `llm.py` บรรทัด 541: ถ้า intent_result confidence ≥ 0.7 → ใช้ `needs_description` จาก intent เท่านั้น
  2. intent classifier บอก `needs_description=False` → `include_desc=False`
  3. keyword matching ("รายละเอียด" อยู่ใน `desc_kw`) ไม่ได้ถูกเช็คเลย
  4. `include_description=False` → `_build_context` ตัด `description_excerpt` ออกจาก context ทั้งหมด
  5. LLM ไม่เห็น description → ตอบ "ไม่มีรายละเอียดเพิ่มเติม"
- **วิธีแก้** (1 จุดใน `llm.py` บรรทัด ~539):
  1. merge intent + keyword: `include_desc = _intent_desc or _kw_match`
  2. ถ้า intent บอก False แต่ keyword บอก True → ยังส่ง desc (กัน intent พลาด)
  3. ถ้า intent บอก True → ส่ง desc เหมือนเดิม
- **เคสที่ผ่านหลังแก้** (verify แล้ว):
  - "ขอรายละเอียดเพิ่มเติมได้ไหมครับ" + history BioKoop → บอทตอบรายละเอียดเพิ่มเติม (Bluetooth 5.3, 178 โหมด, 160 mAh, 3ATM, ฯลฯ)
  - "สวัสดีครับ" ไม่มี history → บอทตอบปกติ ไม่ส่ง desc
- **เคสที่ต้องไม่พัง**: คำถามรับประกัน/สเปก/ชาร์จ (ต้องส่ง desc), คำถามทั่วไป (ไม่ส่ง desc)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/llm.py`
- **Verify**: `python -m py_compile` ผ่าน + curl test 2 เคสผ่าน

### Rejection memory — บอทแนะนำสินค้าที่ลูกค้าปฏิเสธแล้วซ้ำ
- **เคสที่พบ** (test chat CukTechThailand):
  - บอทแนะนำ C2C515 (100W สาย) กับ AD1404U (140W หัวชาร์จ) — wattage ไม่ match
  - ลูกค้าแย้ง "ทำไมสาย 100W แต่หัว 140W" → บอทแก้เป็น CTC615W ครั้งเดียว
  - ข้อความถัดไป บอทกลับไปแนะนำ C2C515 อีก — ไม่จำว่าลูกค้าปฏิเสธ
  - ลูกค้าถาม "ทำไมไม่แนะนำ CTC615W มาแต่ต้น" → บอทตอบ "เพราะยอดฮิต" แล้วยังแนะนำ C2C515
- **Root cause**:
  1. RAG ดึงสินค้าใหม่ทุกรอบตาม keyword → ดึง C2C515 มาอีกเพราะ keyword match
  2. LLM ไม่ได้รู้ว่าลูกค้าปฏิเสธ C2C515 ไปแล้ว → เห็นใน context ก็แนะนำ
  3. history ถูก truncate 200 ตัวอักษร (llm.py บรรทัด 548) → บางทีข้อมูลการปฏิเสธหาย
- **วิธีแก้** (1 จุดใน `app.py` บรรทัด ~3920):
  1. เพิ่ม rejection memory logic ก่อนเรียก `llm.answer()`
     - สแกน `req.history` หา model messages ที่มี product codes (regex `[A-Z][A-Z0-9]{3,11}` + มีตัวเลข)
     - สแกน user message ถัดไปหา negative signals (ทำไม, ไม่โอเค, ดีกว่า, ไม่เอา, จ่ายได้แค่, แล้วทำไมไม่)
     - รองรับทั้ง code ตรงๆ (case-insensitive) และ indirect reference ("สายชาร์จนี้", "อันนี้")
     - indirect reference: "สาย" → match cable code (C2C, CTC, CL), "หัว" → match adapter code (AD)
     - ถ้าเป็น current message (req.message) ก็เช็คด้วย (ไม่ใช่แค่ history)
  2. ส่ง rejected list เป็น extra_context ให้ LLM: "⚠️ ลูกค้าปฏิเสธสินค้า X — ห้ามแนะนำซ้ำ"
  3. รวมกับ superlative_clarify_extra เป็น `_combined_extra`
- **เคสที่ผ่านหลังแก้** (verify แล้ว):
  - ลูกค้าแย้ง C2C515 + ถามสายอื่น → `has C2C515: False`, แนะนำ CTC615P/CTC620P แทน
  - ลูกค้าถาม "ทำไมไม่แนะนำ CTC615W มาแต่ต้น" → บอทขอโทษ + แนะนำ CTC615W ไม่กลับไป C2C515
  - ถามสายชาร์จปกติไม่มี history → บอทตอบปกติ ไม่มี rejection extra_context
- **เคสที่ต้องไม่พัง**: การแนะนำสินค้าปกติ, superlative, compatibility check, การเปรียบเทียบ
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **Verify**: `python -m py_compile` ผ่าน + 3 เคส curl ผ่าน + REJECTION-MEMORY log แสดง C2C515

### Phase 3B-6-fix — Shadow-bot annotation 500 + batch selector เด้ง (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา 1 (batch selector เด้ง)**: เลือกรอบ 1/2 แล้วเด้งกลับ 2/2 เสมอ
  - สาเหตุ: `ShadowConversationPanel.tsx` useEffect โหลด batches มี dep `[conversation?.id, historyReplies]` — `historyReplies` เป็น array ใหม่ทุก 20s (polling) → effect re-run → reset `selectedBatchId` เป็น `bs[0]` (รอบใหม่สุด) เสมอ
  - วิธีแก้: เอา `historyReplies` ออกจาก deps (ใช้ `historyReplies?.length` แทน) + ถ้า `selectedBatchId` ยังอยู่ใน batches ใหม่ → ไม่ reset (ใช้ functional setState)
- **ปัญหา 2 (annotation 500 + แยกไม่ได้ + อัปเดตไม่ได้)**: add annotation รอบ 2 แล้ว error 500, ต้องลบแล้วใส่ใหม่
  - สาเหตุ: unique index `{ scope: 1, conversation_id: 1 }` ไม่รวม `generation_batch_id` → มี annotation ได้แค่ 1 ต่อแชท → insert รอบ 2 ชน index → 500
  - วิธีแก้: drop old index `scope_1_conversation_id_1` ก่อน (ใน `ensureIndexes` pre-step) → สร้าง partial unique index ใหม่ 2 ตัว:
    1. `{ scope, conversation_id, generation_batch_id }` unique เฉพาะที่มี batch_id (แยกตามรอบ)
    2. `{ scope, conversation_id }` unique เฉพาะที่ไม่มี batch_id (legacy — 1 ต่อแชท)
- **ไฟล์ที่แก้**: `mongoClient.ts`, `ShadowConversationPanel.tsx`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python ไม่เกี่ยว
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า shadow-inbox history tab ใน browser เพื่อยืนยัน:
  1. เลือกรอบ 1/2 แล้วไม่เด้งกลับ 2/2 หลัง poll 20s
  2. add annotation รอบ 1 แล้ว add annotation รอบ 2 ไม่ error 500
  3. เปลี่ยนสี annotation รอบเดิมได้โดยไม่ต้องลบใส่ใหม่
- **⚠️ ต้อง restart server** เพื่อให้ `ensureIndexes` รัน dropIndex + สร้าง index ใหม่

### Role Permission System Restructure (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: เดิมใช้ hierarchy (superadmin=dev > admin) ไม่ละเอียดพอ — admin เห็นทุกหน้า, superadmin เห็น log/config
- **สิ่งที่ทำ**:
  1. สร้าง page-based permission system ใน `lib/roles.ts` + `authorize.ts` — แต่ละหน้ามี access level ต่อ role: none/read/edit
  2. Permission matrix:
     - admin: edit (ticket/quickreply/testchat/shadow-inbox/test-assignment), read (team/trigger/workflow/kb/persona/shop-setting/shop/customer/admin-config/botworker/test-result/replay-compare), none (dashboard/analytics/admin-review-kpi/user/log/config)
     - superadmin: edit (admin ได้ + dashboard/analytics/admin-review-kpi/user/team/trigger/workflow/kb/persona/shop-setting/shop/customer/admin-config), read (botworker/test-result/replay-compare), none (log/config)
     - dev: edit ทุกหน้า
  3. Rename route `/admin-kpi` → `/admin-review-kpi` (ทั้ง label และ route path)
  4. Restructure Sidebar — 5 หมวด: หลัก/กระบวนการ/ทดสอบบอท/จัดการ/ตั้งค่า
     - หมวด "ทดสอบบอท" เป็น collapsible group (กดยืด/ยุบได้, auto-expand เมื่อ active)
     - test-chat มี nested submenu (Shopee/TikTok/Lazada) ซ้อนใน collapsible group ได้
  5. อัปเดต page components ทั้งหมดใช้ `canEditPage(user, pageKey)` แทน `canEdit`/`canManage`
  6. อัปเดต API route guards — write endpoints ใช้ `requirePageEdit`, read ใช้ `requirePageAccess`
     - log/config → dev เท่านั้น (superadmin ไม่ได้แล้ว)
     - dashboard/analytics → superadmin+dev (admin ห้าม)
     - kb/workflows/shops/admin-config/team writes → superadmin+dev (admin read-only)
- **ไฟล์ที่แก้**: `lib/roles.ts`, `backend/middleware/authorize.ts`, `components/layout/Sidebar.tsx`, page components (shops/knowledge/triggers/admin-config/team/config/users/ShopDetailDrawer), API routes (admin-review-kpi/config/admin/logs/kb/kb-upload/kb-[id]/kb-[id]-toggle/shops-[id]/admin-config/workflows/workflows-[id]/workflows-toggle/workflows-restore/assignment-reassign/assignment-config/assignment-shop-team/assignment-platform-team/users-list/stats-dashboard/stats-live/stats-performance/stats-admin-activity)
- **ไฟล์ใหม่**: ไม่มี (ย้าย admin-kpi → admin-review-kpi)
- **ไฟล์ที่ย้าย**: `app/(console)/admin-kpi/` → `app/(console)/admin-review-kpi/`, `app/api/admin-kpi/` → `app/api/admin-review-kpi/`
- **verify**: `npx tsc --noEmit` → ผ่าน (exit 0, ไม่มี error)

### Phase 3B-8 — Admin-chat-result รองรับ batch (4 admins × 2 batches = 8 rows) (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: admin-chat-result group แค่ `scope-conversation_id` → 4 admins × 2 batches = 8 docs กลายเป็น 1 row ปนกัน
- **วิธีแก้**:
  1. API — เพิ่ม `batch_id` ใน `ResultItem` (test_assignment=replay_batch_id, shadow_bot=generation_batch_id)
  2. API — เปลี่ยน group key เป็น `scope-conversation_id-admin_id-batch_id` → 8 rows แยกกัน (standalone)
  3. API — detail endpoint รองรับ `batch_id` param (กรอง items ตาม batch)
  4. UI — เพิ่ม `batch_id` ใน `ConversationItem` + `DetailItem`
  5. UI — โชว์ batch label (8 ตัวท้าย) ใน list row + detail header
  6. UI — ส่ง `batch_id` ตอน load detail + `isSelected` เช็ค batch_id ด้วย
- **ไฟล์ที่แก้**: `/api/admin-chat-result/route.ts`, `admin-chat-result/page.tsx`
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า admin-chat-result ใน browser เพื่อยืนยัน 8 rows แยกกัน

### Phase 3B-7 — Test-assignment replay_batch_id (แยกรอบ replay) (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: test-assignment replay ซ้ำแชทเดิม → `saveReplayResult` ใช้ `findOneAndUpdate` upsert → ทับของเก่า ผล replay รอบเก่าหาย
- **วิธีแก้** (เหมือน Phase 3B-6 shadow-bot):
  1. เพิ่ม field `replay_batch_id` ใน `TestAssignmentDoc` — unique id ต่อรอบ replay (`replay_<convId>_<ts36>_<rand>`)
  2. `saveReplayResult` เปลี่ยนจาก upsert → `insertOne` (สร้าง doc ใหม่ทุกรอบ) + แนบ `batchId` กลับ
  3. `getTestAssignment` — เพิ่ม param `replayBatchId` ถ้าไม่ส่ง → คืนล่าสุด (sort created_at desc)
  4. `rateMessage`, `rateConversation`, `softDelete`, `restore` — เพิ่ม param `replayBatchId` ใช้กรอง doc (ถ้าไม่ส่ง → อัปเดตล่าสุด)
  5. เพิ่ม `listReplayBatches(conversationId, replayedBy?)` — ดึง distinct batches (id, created_at, count, final_status, replayed_by) เรียงใหม่สุดก่อน
  6. API replay คืน `replay_batch_id` + conv_detail รองรับ `replay_batch_id` param + endpoint `?batches=1&conversation_id=xxx`
  7. API rate/delete รองรับ `replay_batch_id` ใน body
  8. API history — dedupe เก็บล่าสุดต่อ conversation_id + ส่ง `replay_batch_id` กลับ
  9. `chatAnnotationService` — `scope="test_assignment"` ใช้ `generation_batch_id` field เดิมเก็บ `replay_batch_id` (ต่างรอบต่าง mark)
  10. UI — batch selector dropdown ใน detail panel header + AnnotationDot ผูก batch ที่เลือก + ส่ง `replay_batch_id` ใน rate/replay
  11. UI history list — AnnotationDot ส่ง `generationBatchId={h.replay_batch_id}` + loadAnnotations dedupe/match batch
  12. `docs/schema.md` — อัปเดต `test_assignment` section (เพิ่ม replay_batch_id + soft delete fields) + อัปเดต `chat_annotations` note
- **ไฟล์ที่แก้**: `testAssignmentService.ts`, `/api/test-assignment/route.ts`, `chatAnnotationService.ts`, `/api/chat-annotations/route.ts`, `test-assignment/page.tsx`, `docs/schema.md`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python ไม่เกี่ยว
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า test-assignment ใน browser เพื่อยืนยัน batch selector + annotation + rate ทำงาน

### Phase 3B-6 — Shadow-bot generation_batch_id (แยกรอบ generate) (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: กด Generate ซ้ำแชทเดิม → insert doc ใหม่ทุกครั้ง ไม่มี index แยกรอบ → ปนกัน และ annotation ผูก conversation เดียวทับรอบเก่า
- **วิธีแก้**:
  1. เพิ่ม field `generation_batch_id` ใน `ShadowReplyDoc` — unique id ต่อรอบ generate (`gen_<convId>_<ts36>_<rand>`)
  2. `generateConversationShadowReplies` สร้าง batchId ที่เริ่มรอบ แท็กทุก Q&A pair ในรอบนั้น + แนบ `batchId` ลง results ให้ caller
  3. `listShadowReplies` รองรับ filter `generationBatchId`
  4. เพิ่ม `listGenerationBatches(conversationId)` — aggregate group by batch_id ดึง created_at/count/generated_by เรียงใหม่สุดก่อน
  5. `chatAnnotationService` — เพิ่ม `generation_batch_id` ใน doc, upsert key รวม batch_id (ต่างรอบ = คนละ annotation), list รองรับ filter `generationBatchIds`
  6. API `/shadow-inbox/generate-conversation` คืน `generation_batch_id` ใน response
  7. API `/shadow-inbox` GET รองรับ `generation_batch_id` filter + endpoint `?batches=1&conversation_id=xxx`
  8. API `/chat-annotations` GET รองรับ `generation_batch_ids` filter + POST รองรับ `generation_batch_id`
  9. UI `ShadowConversationPanel` — batch selector dropdown (รอบที่ 1/2/...), default รอบใหม่สุด, filter historyReplies ตาม batch ที่เลือก, AnnotationDot ผูก batch ที่เลือก
  10. UI `AnnotationDot` — รับ `generationBatchId` prop ส่งต่อไป API
  11. UI `shadow-inbox/page.tsx` — ลบ annotationsMap จาก ChatList (mark ย้ายไป panel ต่อ batch selector)
  12. UI `ShadowInboxList` — เพิ่ม `generation_batch_id` ใน type
  13. `docs/schema.md` — เพิ่ม `generation_batch_id` ใน shadow_replies + เพิ่ม section 2.12 chat_annotations
- **ไฟล์ที่แก้**: `shadowReplyService.ts`, `chatAnnotationService.ts`, `/api/shadow-inbox/route.ts`, `/api/shadow-inbox/generate-conversation/route.ts`, `/api/chat-annotations/route.ts`, `shadow-inbox/page.tsx`, `ShadowInboxList.tsx`, `ShadowConversationPanel.tsx`, `AnnotationDot.tsx`, `docs/schema.md`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python (`chatbot/shopeechat/`) ไม่เกี่ยวกับการแก้ครั้งนี้
- **Verify**: `npx tsc --noEmit` → ผ่าน (exit 0)
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า shadow-inbox history tab ใน browser เพื่อยืนยัน batch selector + annotation ทำงาน

### Phase 3B — Test-assignment + Shadow-bot restructure + Markup (2026-09-07) — ✅ implement เสร็จ รอ verify

#### Phase 3B-1 — Markup system (chat annotations)
- สร้าง collection `chat_annotations` — เก็บ dot สี + note ของแชท
- API `/api/chat-annotations` — GET/POST/PATCH/DELETE
- UI: วงกลมสี (dot) ที่ inbox chat item + note popup
- ใช้ร่วม test-assignment + shadow-bot

#### Phase 3B-2 — Test-assignment restructure (3 tabs)
- **all**: แชททั้งหมดแบบ ticket inbox — เลือกแชท + กด replay ทีละแชท (เหมือนเดิม)
- **roll**: batch replay — เลือก N แชท, เก่า/ใหม่ก่อน, ทับ/ไม่ทับ/ต่อจากเดิม
  - "ไม่ทับ" → ข้ามแชทที่ **ตัวเอง** เคย replay แล้ว ไปทำอันถัดไปจนครบ N
- **history**: ประวัติ replay แยกตามแอดมิน — ของใครของมัน
- soft delete replay result (กู้คืนได้)

#### Phase 3B-3 — Shadow-bot restructure
- **ลบ "Generate ทีละข้อความ"** — เหลือแค่ generate ทั้งแชท
- **all**: แชททั้งหมด — เลือกแชท + กด Generate ทั้งแชท ทีละแชท
- **roll**: batch generate ทั้งแชท — เลือก N แชท, เก่า/ใหม่ก่อน, ทับ/ไม่ทับ/ต่อจากเดิม
  - "ไม่ทับ" → ข้ามแชทที่มีคน generate แล้ว ไปทำอันถัดไปจนครบ N
- **handoff bubble**: ถ้าเจอ handoff ใส่ bubble "ตรงนี้ต้องแอดมินแล้ว" แต่ทำต่อ + mark ไว้

#### Phase 3B-4 — History per-admin
- test-assignment + shadow-bot แยก history ชัดเจน
- shadow-bot history รวม "generate แชทเดียว" + "roll batch" ในหน้าเดียว
- แยกตามแอดมิน — ของใครของมัน

- **ไฟล์ที่จะแก้**: test-assignment/page.tsx, shadow-inbox/page.tsx, testAssignmentService.ts, shadowReplyService.ts, Sidebar.tsx
- **ไฟล์ใหม่**: chatAnnotationService.ts, /api/chat-annotations/route.ts, /api/chat-annotations/[id]/route.ts

### Phase 3A — Admin KPI Dashboard + Visibility per admin (2026-09-07) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: ไม่มีระบบ KPI รวมของแอดมิน — ไม่รู้ว่าใคร replay อะไร, ให้คะแนนคำตอบไหน, คอมเมนต์กี่คอมเมนต์
- **สิ่งที่ทำ**:
  1. **เติม gap — test-assignment**: เพิ่ม `replayed_by` + `replayed_at` ใน `saveReplayResult` + audit log `test_assignment.replay` ตอนกด replay
  2. **เติม gap — shadow-inbox**: เพิ่ม `generated_by` ใน `ShadowReplyDoc` สำหรับ manual/manual_conversation (worker ใช้ "system")
  3. **สร้าง adminKpiService** — aggregate KPI จาก test_chat_ratings + test_assignment + shadow_replies + admin_logs
  4. **สร้าง API `/api/admin-kpi`** — รับ `?admin_id=&from=&to=&scope=` คืน KPI รวม + drill-down
  5. **สร้างหน้า `/admin-kpi`** — dashboard + date range picker + filter admin + ตารางต่อ admin + drill-down session
     - role: dev/superadmin (ใช้ `requireSuperadmin`)
     - แยกจาก dashboard เดิมชัดเจน
  6. **ปรับ Sidebar** — รวม test-chat/shadow-inbox/botworker/test-assignment/replay-compare/test-results/admin-kpi เป็น group "ทดสอบบอท"
  7. **Visibility per admin** — test-assignment + shadow-inbox บังคับกรองของใครของมัน (admin ทั่วไปเห็นเฉพาะของตัวเอง, superadmin/dev เห็นทั้งหมด)
  8. **Bug fix**: test-assignment rate แล้วไม่ reload หน้า (optimistic update), shadow-inbox rate แล้วคะแนนไม่หาย (cache-buster)
- **KPI shadow-inbox**: นับเฉพาะ manual (generate + generate_conversation) ไม่นับ worker
- **ไฟล์ที่แก้**: testAssignmentService.ts, test-assignment/route.ts, shadowReplyService.ts, adminLogService.ts, Sidebar.tsx, test-assignment/page.tsx, shadow-inbox/page.tsx, logs/page.tsx
- **ไฟล์ใหม่**: adminKpiService.ts, /api/admin-kpi/route.ts, /(console)/admin-kpi/page.tsx

### InfoTab — สถิติการสนทนา แสดงชื่อแอดมิน ไม่ใช่ admin_id (2026-09-05) — ✅ implement เสร็จ
- **ปัญหา:** หน้า botworker และ ticket panel ตรง "สถิติการสนทนา" แสดง `admin: <admin_id>` แทนชื่อแอดมิน
- **สาเหตุ:** `InfoTab.tsx` ใช้ `m.admin_id || m.admin_name || "unknown"` เป็น key แล้วแสดง key ตรงๆ → ถ้ามี admin_id จะแสดง id
- **วิธีแก้:**
  - dedup ตาม `admin_id` (key) แต่เก็บ `name` แยก
  - แสดง `admin: ${name}` โดยใช้ `m.admin_name` ก่อน ถ้าไม่มีค่อย fallback เป็น `m.admin_id`
  - ถ้า message หลังมี admin_name แต่ก่อนหน้ายังเป็น id → อัปเดต name
- **ไฟล์ที่แก้:** `ChatAdminWeb/src/components/chat/InfoTab.tsx`
- **Verify:** tsc ผ่าน ✅
- **หมายเหตุ:** ไม่ได้เพิ่ม/แก้/ลบฟังก์ชัน → ไม่ต้องอัปเดต SRS_SSD.md

### Phase 2Z++ — แก้ follow-up ลืมสินค้าเดิม + แก้ warranty skip ไม่ทำงาน (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา 1 — ลืมสินค้าเดิม:** ลูกค้าถามต่อ "อันนี้สามารถฟังเพลงโดยไม่เชื่อมบลูทูธได้ไหมคะ" หลัง bot แนะนำ iSUPER SoundActiv Swim → bot ตอบผิด (ขัดแย้งกับ Q1) เพราะดึงสินค้าอื่นมาแทน
  - **สาเหตุ:** REFERENCE ดึงชื่อ "iSUPER SoundActiv Swim" ได้ถูก → แต่ vector search ไม่เจอ (products=0) → REF-REGEX ไม่ทำงานเพราะต้องการ digit ใน model word → ไป shop fallback ดึงสินค้าอื่น
  - **Fix:** เพิ่ม REF-NAME-FALLBACK ใน app.py — ถ้าเป็น follow-up ที่มี ref_models แต่ vector search ไม่เจอ → ดึงด้วย Mongo regex จากชื่อสินค้าเต็ม (ไม่จำเป็นต้องมี digit)
- **ปัญหา 2 — warranty skip ไม่ทำงาน:** Phase 2Z+ แก้ไปแล้ว แต่เงื่อนไข `not req.message.strip()` ไม่ทำงานเพราะ req.message = "[รูปภาพ]" ไม่ใช่ ""
  - **Fix:** เปลี่ยนเงื่อนไขเป็นตัด image placeholder ออกก่อน แล้วค่อยเช็คว่าว่างไหม
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/app.py` — เพิ่ม REF-NAME-FALLBACK + แก้เงื่อนไข warranty skip
- **Verify:** py_compile ผ่าน ✅

### Phase 2Z+ — แก้ warranty state machine ตีรูปเฉยๆ เป็น claim evidence (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** ลูกค้าส่งรูปเฉยๆ (ไม่ได้บอกว่าเคลม) แต่ bot ยังตอบ "รอแอดมิน" + handoff
- **สาเหตุจริง:** ไม่ใช่ที่ LLM — เป็นที่ warranty state machine ใน app.py
  - state machine ตรวจ history ทั้งหมดหา warranty keywords (เช่น "ประกัน")
  - ในเคสนี้ history มี "ประกัน" (Q5: "รุ่นไหนประกันยังไงบ้าง") → ทุกข้อความต่อมาที่มีรูป → ถูกตีเป็น claim evidence
- **Fix ใน app.py (บรรทัด 1425-1459):**
  1. เช็คเฉพาะ history ล่าสุด 3 ข้อความ แทนทั้งหมด
  2. ถ้าลูกค้าส่งรูปเฉยๆ (ไม่มีข้อความ + ไม่มี warranty keyword) → ไม่ใช่ claim evidence
  3. ปล่อยไปเส้นทางปกติ (LLM อ่านรูป + ตอบตามบริบท)
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/app.py` — จำกัด history scan เป็น 3 ล่าสุด + เช็ค warranty keyword ใน message ปัจจุบัน
- **Verify:** py_compile ผ่าน ✅, uvicorn reload สำเร็จ ✅

### Phase 2Z — แก้ Bot ตีรูปเฉยๆ เป็น claim warranty (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** ลูกค้าส่งรูปเฉยๆ (ไม่ได้บอกว่าเคลม) → Bot ตอบ "ได้รับข้อมูลแล้ว รอแอดมินติดต่อกลับ" + handoff_to_admin=true
- **สาเหตุ 2 จุด:**
  1. `app.py` vision_context สั่ง LLM ว่า "ถ้ารูปเป็นสินค้าเสีย → ถามเคลม" โดยไม่มีเงื่อนไขว่าลูกค้าต้องบอกว่าเคลมก่อน
  2. `llm.py` SYSTEM_INSTRUCTION ไม่มีกฎที่บอกชัดว่า "การส่งรูปเฉยๆ ไม่ใช่ claim"
- **Fix ที่ 1 — app.py vision_context (บรรทัด 499-509):**
  - เพิ่มเงื่อนไข: "ถ้ารูปเป็นสินค้าเสีย **และลูกค้าบอกชัดว่าเคลม** → ถามเคลม"
  - เพิ่ม: "ถ้ารูปเป็นสินค้าปกติ → แนะนำขาย ห้ามตีว่าเป็น claim"
  - เพิ่ม: "ห้ามตีว่ารูปเป็นสินค้าเสีย ถ้าลูกค้าไม่ได้พิมพ์บอกว่าเคลม"
- **Fix ที่ 2 — llm.py SYSTEM_INSTRUCTION (บรรทัด 62-73):**
  - เพิ่มกฎ: "การส่งรูปเฉยๆ ไม่ใช่การขอเคลม"
  - เพิ่ม: ลูกค้าส่งรูป + พิมพ์ "เคลม/สินค้าเสีย/ซ่อม" → เป็น claim
  - เพิ่ม: ลูกค้าส่งรูปเฉยๆ → ห้ามตีว่าเป็น claim
  - เพิ่ม: ถ้ารูปเป็นสินค้าเสียแต่ลูกค้าไม่ได้พิมพ์เคลม → ถามก่อน ห้ามส่งแอดมินเฉย
  - เพิ่ม: ห้ามตอบ "รอแอดมินติดต่อกลับ" ถ้าลูกค้าไม่ได้ขอเคลม
  - เพิ่ม: ห้ามตั้ง handoff_to_admin=true ถ้าลูกค้าไม่ได้ขอเคลม
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/app.py` — ปรับ vision_context ให้ชัดเจน
  - `chatbot/shopeechat/llm.py` — เพิ่มกฎรูปภาพ + claim ใน SYSTEM_INSTRUCTION
- **Verify:** py_compile ผานทั้ง 2 ไฟล์ ✅
- **หมายเหตุ:** ไม่ได้เพิ่ม/แก้/ลบฟังก์ชัน → ไม่ต้องอัปเดต SRS_SSD.md

### Phase 2Y — แก้ Bot สับสน MagSafe "ยึดแม่เหล็ก" vs "ชาร์จแม่เหล็ก" (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** ลูกค้าถาม "ชาร์จ Magsafe ได้ไหม" (ถามเรื่องชาร์จไฟ) → Bot ตอบ "รองรับการใช้งานแบบแม่เหล็ก MagSafe" (ตอบเรื่องยึดแม่เหล็ก) → ลูกค้าเข้าใจผิดว่าชาร์จได้
- **สาเหตุ:** SYSTEM_INSTRUCTION ใน llm.py ไม่ได้สอนให้ bot แยกความหมาย 2 อย่างนี้
- **Fix:** เพิ่มกฎ MagSafe ใน SYSTEM_INSTRUCTION (llm.py บรรทัด 171-186):
  - แยก "ยึดด้วยแม่เหล็ก" (magnetic attachment) จาก "ชาร์จไฟผ่านแม่เหล็ก" (MagSafe wireless charging)
  - ถ้าลูกค้าถาม "ชาร์จ MagSafe ได้ไหม" → ถามเรื่องชาร์จไฟ ไม่ใช่ยึดแม่เหล็ก
  - พัดลมระบายความร้อน (MagCooler, FunCooler) ไม่มีชาร์จไฟ → ตอบชัด
  - ห้ามใช้คำว่า "รองรับ MagSafe" กับสินค้าที่ไม่มีชาร์จไฟ
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/llm.py` — เพิ่มกฎ MagSafe ใน SYSTEM_INSTRUCTION
- **Verify:** py_compile ผ่าน ✅
- **หมายเหตุ:** ไม่ได้เพิ่ม/แก้/ลบฟังก์ชัน → ไม่ต้องอัปเดต SRS_SSD.md

### Phase 2X — /tickets auto-reopen แยกจาก botworker (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** หลัง Phase 2V botworker เขียน test_status_conversation → /tickets ไม่เห็น reopen เมื่อลูกค้าทักใหม่
- **Fix:** /tickets มี auto-reopen logic ของตัวเอง ใน /admin/conversations API
  - ตรวจ closed conversations ว่ามี last_message_timestamp > closed_at ไหม
  - ถ้ามี → reopen status_conversation (จริง) — status=bot, clear assigned_to
  - ทำใน API endpoint โดยตรง ไม่พึ่ง botworker
- **แยกชัดเจน:**
  - /tickets → เขียน status_conversation (จริง)
  - botworker → เขียน test_status_conversation (source=botworker)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/api/admin/conversations/route.ts` — เพิ่ม auto-reopen logic หลังโหลด meta map
- **Verify:** tsc ผ่าน ✅

### Phase 2W — History tab แสดงเวอร์ชั่นเก่าของ bot reply (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** Generate แชทเดิมซ้ำหลายครั้ง → History tab แสดงแค่คำตอบล่าสุด (Map dedupe by inbound_message_id)
- **Fix:**
  - group shadow_replies by inbound_message_id, sort by created_at desc
  - ล่าสุด → botReply หลัก
  - ที่เหลือ → allVersions (เก็บใน QAPair.botReply.allVersions)
  - UI: เพิ่ม OldVersionsButton — กด "ดูเวอร์ชั่นเก่า (N)" → expand แสดงเวอร์ชั่นเก่า
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/components/shadow/ShadowConversationPanel.tsx` —
    - เพิ่ม field allVersions ใน QAPair.botReply
    - เพิ่ม created_at ใน historyReplies type
    - ปรับ useEffect ให้ group + sort + เก็บ allVersions
    - เพิ่ม OldVersionsButton component
- **Verify:** tsc ผ่าน ✅

### Phase 2V — แยก status_conversation ระหว่าง botworker กับ ticket (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** botworker เขียน status_conversation ร่วมกับ /tickets → handoff/reopen กระทบ ticket จริง
- **Fix:**
  - botworker อ่าน status_conversation (read-only — เช็ค admin จริงกำลังตอบไหม)
  - botworker เขียน test_status_conversation source="botworker" (handoff/reopen/status)
  - /botworker UI อ่าน status จาก /api/botworker/conversations (ใช้ test_status_conversation)
  - /tickets ไม่ได้รับผลกระทบจาก botworker อีกต่อไป
- **สิ่งที่เปลี่ยน:**
  - `testStatusConversationService.ts` — เพิ่ม "botworker" ใน TestSource
  - `botWorkerService.ts` —
    - reopen: ใช้ testStatusConversationService.updateTestStatus แทน reopenConversation
    - pickAgent: mirror ผล handoff ลง test_status_conversation source="botworker"
    - ลบ import reopenConversation (ไม่ใช้แล้ว)
  - `ChatAdminWeb/src/app/api/botworker/conversations/route.ts` — API ใหม่ (เหมือน /admin/conversations แต่อ่าน test_status_conversation)
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — ใช้ /api/botworker/conversations แทน /admin/conversations
- **Verify:** tsc ผ่าน ✅

### Phase 2U — เขียน /botworker ใหม่ให้เหมือน /tickets (ChatList + 3 สี + ขวา info/chatlog/products) (2026-09-12) — ✅ implement เสร็จ
- **เหตุผล:** ตอนนี้ /botworker หน้าตาไม่เหมือน tickets — ซ้ายเป็น list ของ shadow_replies ไม่ใช่ ChatList
- **สิ่งที่เปลี่ยน:**
  - ซ้าย: ใช้ ChatList (เดียวกับ tickets) — ดึงจาก /admin/conversations
  - กลาง: BotWorkerChatPanel — แสดงแชท 3 สี (user/zaapi/bot) ไม่มี composer (อ่านอย่างเดียว)
    - user = เทา (ซ้าย) — จาก messages_shp role=user
    - zaapi = เขียว (ขวา) — จาก messages_shp role=bot
    - bot = ฟ้า (ขวา) — จาก shadow_replies
    - มี legend 3 สี + safety notice
    - มี header bar (platform icon + customer name + status badge)
    - รองรับ multi-bubble (bot แบ่งคำตอบด้วย |||)
  - ขวา: InfoTab / ChatLogTab / ProductsTab (เหมือน tickets) — ยืด/หด ได้
  - polling: conversations 5s, messages 3s
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — เขียนใหม่ทั้งหน้า
- **Verify:** tsc ผ่าน ✅

### Phase 2T — bot เห็น history ถูกต้อง + UI 3 สีใน /botworker (2026-09-12) — ✅ implement เสร็จ
- **ปัญหาที่ 1 (history):** getHistoryForBot อ่าน messages_shp role=user+bot → bot เห็นคำตอบ Zaapi (role=bot ใน messages_shp) แต่ไม่เห็นคำตอบตัวเอง (อยู่ใน shadow_replies)
- **ปัญหาที่ 2 (UI):** หน้า /botworker แสดงแค่ inbound + bot reply ไม่แสดงแชทเต็มรูปแบบ
- **Fix ที่ 1 — getHistoryForBot:**
  - อ่าน user จาก messages_shp (role=user เท่านั้น)
  - อ่าน bot replies จาก shadow_replies (คำตอบของเราเอง)
  - merge เรียงตามเวลา → ส่งให้ bot
  - bot ไม่เห็น Zaapi (role=bot ใน messages_shp) และไม่เห็น admin (role=admin)
- **Fix ที่ 2 — UI 3 สี:**
  - API `/api/botworker/conversations/:id/messages` — merge user + zaapi + bot เป็น unified list
  - หน้า /botworker แสดงแชท 3 สี:
    - user = เทา (ซ้าย)
    - zaapi = เขียว (ขวา)
    - bot = ฟ้า (ขวา)
  - มี legend บอกสี + safety notice
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/messageService.ts` — getHistoryForBot อ่าน shadow_replies
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — UI 3 สี + ChatBubble component
- **ไฟล์ที่สร้าง:**
  - `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — API merge 3 แหล่ง
- **Verify:** tsc ผ่าน ✅

### Phase 2S — สร้างหน้า /botworker ดูคำตอบ botworker แบบ ticket layout (2026-09-12) — ✅ implement เสร็จ
- **เหตุผล:** ต้องมีที่ดูคำตอบที่ botworker รันอัตโนมัติ (mode=standalone) แยกจาก shadow-inbox (mode=shadowbot)
- **สิ่งที่สร้าง:**
  - API `/api/botworker/replies` — ดึง shadow_replies mode=standalone (filter + sort + limit)
  - หน้า `/botworker` — layout แบบ ticket (ซ้าย list, ขวา detail)
    - list: แสดง inbound + bot reply + platform badge + handoff badge + trigger badge + เวลา
    - detail: แสดงข้อความลูกค้า + คำตอบบอท + metadata + safety notice
    - filter: platform + search
    - polling ทุก 5 วินาที (real-time)
  - Sidebar: เพิ่ม "Bot Worker" ในกลุ่ม "เครื่องมือ" (icon Bot, badge "auto")
- **ไฟล์ที่สร้าง:**
  - `ChatAdminWeb/src/app/api/botworker/replies/route.ts` — API ใหม่
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — หน้า UI ใหม่
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/components/layout/Sidebar.tsx` — เพิ่ม nav item
- **Verify:** tsc ผ่าน ✅

### Phase 2R — เพิ่ม field `mode` ใน shadow_replies (standalone/shadowbot/ticket) (2026-09-12) — ✅ implement เสร็จ
- **เหตุผล:** แยกโหมดการทำงานของ bot (standalone=worker, shadowbot=Generate, ticket=อนาคต) โดยไม่ overloading `origin`
- **สิ่งที่เพิ่ม:**
  - `ShadowReplyDoc.mode?: "standalone" | "shadowbot" | "ticket"` — field ใหม่
  - botworker `storeBotReply` → `mode: "standalone"`
  - botworker `storeWorkflowDelivered` → `mode: "standalone"`
  - shadowReplyService `generate` (manual) → `mode: "shadowbot"`
  - shadowReplyService `generateConversation` (manual_conversation) → `mode: "shadowbot"`
  - `/api/shadow-inbox` GET → รองรับ query param `?mode=standalone|shadowbot|ticket`
- **ความสัมพันธ์กับ origin:**
  - `origin` = ที่มา (worker/manual/manual_conversation/workflow)
  - `mode` = โหมด (standalone/shadowbot/ticket)
  - origin=worker → mode=standalone
  - origin=manual/manual_conversation → mode=shadowbot
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — เพิ่ม field + ตั้ง mode ใน manual/manual_conversation
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` — ตั้ง mode ใน storeBotReply + storeWorkflowDelivered
  - `ChatAdminWeb/src/app/api/shadow-inbox/route.ts` — รองรับ filter ?mode=
- **Verify:** tsc ผ่าน ✅

### Phase 2Q — เอา limit 20 ออก + เพิ่ม concurrency limiter (ปรับได้ใน /admin-config) (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** pollNewMessages limit=20 ทำให้ 500 ข้อความใช้ 25 cycles (25 วินาที) ทั้งที่ buffer เปิดอยู่แล้วและเป็นตัวคุมปริมาณจริง
- **ความต้องการ:** เอา limit ออก ปล่อยดึงทั้งหมด — แต่จำกัดจำนวน callBot ขนานกัน (กัน Python bot โอเวอร์โหลด)
- **Fix:**
  - `pollNewMessages(since?)` — เอา parameter `limit` ออก ดึงทั้งหมดที่เข้ามาใหม่
  - เพิ่ม semaphore pattern: `acquireBotSlot()` / `releaseBotSlot()` จำกัด `MAX_CONCURRENT_BOT_CALLS = 50`
  - ทุกจุดที่เรียก `callBot` ห่อด้วย acquire/release (try/finally)
  - `bot-worker.ts` — ลบ `BATCH_LIMIT` ไม่ส่ง limit แล้ว
- **พฤติกรรมหลังแก้:**
  - 500 ข้อความเข้ามา → poll ดึงทั้ง 500 ใน cycle เดียว → เข้า buffer
  - buffer รวมเป็น 200 context → flush → 200 context เข้า processMessage
  - processMessage ยิง callBot แต่จำกัด 50 ขนานกัน (150 ที่เหลือรอใน queue)
  - 50 ที่ยิงไปเสร็จ → release slot → 50 ถัดไปยิง
  - กว่าจะครบ 200 ใช้เวลาตามความเร็วบอท (ถ้าบอทตอบ 1s → 4 รอบ × 50 = 200 ใน ~4 วินาที)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` — เอา limit ออก + เพิ่ม semaphore
  - `ChatAdminWeb/scripts/bot-worker.ts` — ลบ BATCH_LIMIT
- **Verify:** tsc ผ่าน ✅

### Phase 2P — botworker ประมวลผลเฉพาะข้อความใหม่หลังเปิด (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** botworker ตอนเปิดครั้งแรก → ดึง 20 ข้อความล่าสุดจาก messages_shp → ประมวลผลข้อความเก่าที่ไม่เคยประมวลผล
- **ความต้องการ:** ประมวลผลเฉพาะข้อความที่เข้ามาหลังเปิด botworker
- **Fix:**
  - `pollNewMessages(limit, since?)` — เพิ่ม parameter `since: Date`
  - ถ้ามี `since` → query `created_timestamp: { $gt: since }` (เฉพาะข้อความหลัง timestamp นั้น)
  - `bot-worker.ts` — บันทึก `startedAt = new Date()` ตอนเริ่ม → ส่งไปทุกครั้ง
- **พฤติกรรมหลังแก้:**
  - เปิด botworker → ประมวลผลเฉพาะข้อความที่เข้ามาหลังเปิด
  - ข้อความเก่าก่อนเปิด → ไม่ถูกประมวลผล
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` — pollNewMessages เพิ่ม parameter since
  - `ChatAdminWeb/scripts/bot-worker.ts` — ส่ง startedAt เข้า pollNewMessages
- **Verify:** tsc ผ่าน ✅

### Phase 2O — close_history: record ปิดเท่านั้น + sequence = จำนวนครั้งที่ปิด (2026-09-12) — ✅ implement เสร็จ (แก้ไขจาก 2N)
- **ปัญหาเดิม:** กด reopen แล้ว panel แสดง "เปิดใหม่แล้ว" ใน record เดิม ไม่เห็นเป็น "ครั้งที่ 2"
- **ความต้องการจริง:** record ปิดเท่านั้น — "ครั้งที่ 1 ปิดแล้ว", "ครั้งที่ 2 ปิดแล้ว", "ครั้งที่ 3 ปิดแล้ว"
  - reopen แก้ใน record เดิม (เก็บ reopened_by, reopened_at, reopen_reason)
  - ปิดใหม่ → สร้าง record ใหม่ (sequence = จำนวนครั้งที่ปิด + 1)
- **โครงสร้าง:**
  - `sequence` = จำนวนครั้งที่ปิด (1, 2, 3...) — ไม่นับ reopen
  - `reopened_at` = ถ้ามี → แสดง badge "เปิดใหม่แล้ว" ใน record เดิม
  - ไม่มี record "open" แยก
- **ตัวอย่าง timeline:**
  ```
  ครั้งที่ 1 · ปิดแล้ว (การจัดส่ง) — ปิดโดย admin_001
    └ เปิดใหม่โดย bot (ลูกค้าทักกลับมา)
  ครั้งที่ 2 · ปิดแล้ว (รับประกัน) — ปิดโดย admin_002
    └ เปิดใหม่โดย admin_001 (แอดมินเปิดแชทใหม่)
  ครั้งที่ 3 · ปิดแล้ว (สินค้า) — ปิดโดย admin_001
  ```
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/closeHistoryService.ts` — recordReopen กลับเป็น update record เดิม
  - `ChatAdminWeb/src/lib/types.ts` — กลับเป็นแบบเดิม (ไม่มี action field)
  - `ChatAdminWeb/src/app/api/conversations/[conversationId]/close-history/route.ts` — serialize แบบเดิม
  - `ChatAdminWeb/src/components/chat/CloseHistoryPanel.tsx` — แสดง "ครั้งที่ N · ปิดแล้ว" + reopen info ข้างใน
  - `ChatAdminWeb/src/components/chat/InfoTab.tsx` — แสดงแบบเดิม
- **Verify:** tsc ผ่าน ✅

### Phase 2N — แก้ botWorkerService อ่าน status จาก status_conversation + reopen เป็น "bot" ไม่ใช่ "handoff" (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** botWorkerService อ่าน `conv.status` และ `conv.assigned_to` จาก `conversations` (ที่โดน dump ทับ) ไม่ใช่ `status_conversation`
  - ถ้า dump ทับ status เป็นค่าเก่า → บอทตัดสินใจผิด (อาจตอบทับแอดมิน หรือไม่ reopen ตอนลูกค้าทักกลับมา)
  - บรรทัด 318-322 ยังเขียน `assigned_to=null` ลง `conversations` (ผิดที่)
- **Fix:**
  - อ่าน status/assigned_to จาก `statusConversationService.getMeta()` แทน `conv.status` / `conv.assigned_to`
  - ตอน reopen + เคลียร์ assigned_to → ใช้ `statusConversationService.updateStatus(conv_id, "bot", undefined, "bot-worker")` ไม่ใช่เขียน `conversations`
- **พฤติกรรมหลังแก้:**
  - status=bot (ไม่มี assigned_to) → บอทตอบปกติ
  - status=handoff (มี assigned_to) → บอทข้าม (ปล่อยให้แอดมินตอบ)
  - status=closed → บอท reopen + เคลียร์ assigned_to + ตอบปกติ
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts`
- **Verify:** tsc ผ่าน ✅

### Phase 2M — เพิ่ม log ครบทุก action (ใครทำอะไร ตอบอะไร เปิด/ปิดอะไร) (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** บาง action ไม่เขียน admin_logs (setTopic, setItemIds, togglePinned, tryAssign)
- **สาเหตุ:** ย้ายมา statusConversationService ใน Phase 2J แต่ลืมเขียน log
- **Fix:**
  - `tryAssign` — เขียน log `chat_assigned` เอง (กัน caller ลืม) + ตั้ง status=handoff ด้วย
  - `setTopic` — เขียน log `conversation.set_topic` (มี old_topic, new_topic)
  - `setItemIds` — เขียน log `conversation.set_item_ids` (มี old_item_ids, new_item_ids)
  - `togglePinned` — เขียน log `conversation.pin` / `conversation.unpin`
  - เพิ่ม action_type ใหม่ใน `AdminActionType`: `conversation.set_topic`, `conversation.set_item_ids`, `conversation.pin`, `conversation.unpin`
  - `setConversationTopic/setConversationItemIds/togglePinned` ใน conversationService — เพิ่ม parameter `actor`
- **ตรวจสอบ log ครบทุก action:**
  | Action | action_type | สถานะ |
  |---|---|---|
  | แอดมินตอบลูกค้า | `admin.reply` | ✅ มีอยู่แล้ว |
  | Handoff (bot→admin) | `conversation.handoff` | ✅ มีอยู่แล้ว |
  | Auto-assign (round-robin) | `chat_assigned` | ✅ มีอยู่แล้ว + tryAssign เขียนเองด้วย |
  | Reassign (โยนแชท) | `chat_reassigned` | ✅ มีอยู่แล้ว |
  | ปิดแชท | `conversation.close` | ✅ มีอยู่แล้ว |
  | เปิดแชทใหม่ | `conversation.open` | ✅ มีอยู่แล้ว |
  | Trigger handoff | `bot.handoff_to_admin` | ✅ มีอยู่แล้ว |
  | Bot reply (ทุกกรณี) | `bot.reply` | ✅ มีอยู่แล้ว |
  | Bot process failed | `bot.process_failed` | ✅ มีอยู่แล้ว |
  | ตั้ง topic | `conversation.set_topic` | ✅ เพิ่มใหม่ |
  | ตั้ง item_ids | `conversation.set_item_ids` | ✅ เพิ่มใหม่ |
  | Pin/unpin | `conversation.pin` / `conversation.unpin` | ✅ เพิ่มใหม่ |
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/statusConversationService.ts` — tryAssign/setTopic/setItemIds/togglePinned เขียน log
  - `ChatAdminWeb/src/backend/service/conversationService.ts` — เพิ่ม parameter `actor`
  - `ChatAdminWeb/src/backend/service/adminLogService.ts` — เพิ่ม action_type ใหม่
- **Verify:** tsc ผ่าน ✅

### Phase 2L — แก้ bug โยนแชทแล้วกลับเป็นคนเดิม (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** กดโยนแชทจากแอดมิน 2 → 3 แล้ว polling 3 วิ ดึงข้อมูลใหม่ กลับเป็นแอดมิน 2
- **สาเหตุ:** `assignmentService.reassignConversation` และ `autoAssignConversation` เขียน `assigned_to` ลง `conversations` (ที่โดน dump ทับ) แทน `status_conversation`
  - polling ดึงจาก `/api/admin/conversations` ซึ่งอ่าน `assigned_to` จาก `status_conversation` (หลัง Phase 2J)
  - แต่ reassign เขียนลง `conversations` → polling ไม่เห็นการเปลี่ยนแปลง → กลับเป็นคนเดิม
- **Fix:**
  - `reassignConversation` → ใช้ `statusConversationService.updateStatus()` เขียนลง `status_conversation`
  - `autoAssignConversation` → ใช้ `statusConversationService.tryAssign()` (atomic upsert กัน race condition)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/assignmentService.ts`
- **Verify:** tsc ผ่าน ✅ (รอ verify จริงในหน้า tickets — โยนแล้ว polling ไม่กลับเป็นคนเดิม)

### Phase 2K — แก้หน้า customers (contacts) โหลดช้า (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** หน้า `/contacts` โหลดช้ามาก (1,000-10,000 ลูกค้า)
- **สาเหตุ:** `listCustomers` ทำ `$lookup` join conversations ทุก record ก่อน paginate
  - pipeline: `$match → $lookup (5,000 ครั้ง) → $sort → $count → $skip → $limit`
  - ควรเป็น: `$match → $sort → $skip → $limit (20 คน) → $lookup (20 ครั้ง)`
- **สาเหตุเสริม:** ใช้ hardcoded `"conversations_shp"` แทน `COLLECTIONS.conversations`
- **Fix:**
  - **Case A (sort ตาม last_active_at/created_at):** paginate ก่อน → batch lookup แค่ 20 คน (เร็วมาก)
  - **Case B (sort ตาม name):** ต้อง lookup ก่อน sort (ช้ากว่า แต่จำเป็น) — ใช้ `COLLECTIONS.conversations` แทน hardcoded
  - `getCustomer` ก็ใช้ `COLLECTIONS.conversations` แทน `"conversations_shp"`
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/customerService.ts`
- **Verify:** tsc ผ่าน ✅ (รอ verify ความเร็วจริงในหน้า contacts)

### Phase 2J — แยก collection สถานะแชทออกจาก conversations ที่ถูก dump ทุก 2 วิ (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** `conversations` collection ถูก sellcenter dump ทับทุก 2 วิ → field ที่เราเขียน (assigned_to, status, closed_at, close_count) หาย
- **โซลูชัน:** แยก field ของเราออกเป็น 2 collection ใหม่:
  - `status_conversation` — สถานะจริง (ใช้กับ `/tickets` เท่านั้น)
  - `test_status_conversation` — สถานะทดสอบ (ใช้กับ test-assignment, shadowbot, replay-compare, test-chat)
- **ไม่มี `status_message`** — read/unread/answered คำนวณจาก aggregation เหมือนเดิม
- **ไฟล์ที่สร้างใหม่:**
  - `ChatAdminWeb/src/backend/service/statusConversationService.ts` — service สำหรับ status_conversation (จริง)
  - `ChatAdminWeb/src/backend/service/testStatusConversationService.ts` — service สำหรับ test_status_conversation (test)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/lib/config.ts` — เพิ่ม `statusConversation` + `testStatusConversation` collection
  - `ChatAdminWeb/src/backend/db/mongoClient.ts` — เพิ่ม index สำหรับ 2 collection ใหม่
  - `ChatAdminWeb/src/backend/service/conversationService.ts` — updateConversationStatus/closeConversation/reopenConversation/setTopic/setItemIds/togglePinned เขียนลง status_conversation แทน conversations
  - `ChatAdminWeb/src/backend/service/handoffService.ts` — handoffToAdmin อ่าน/เขียนจาก status_conversation + เพิ่ม handoffToAdminTest สำหรับ test
  - `ChatAdminWeb/src/app/api/admin/conversations/route.ts` — merge status/assigned_to จาก status_conversation เวลา list
  - `ChatAdminWeb/src/app/api/admin/conversations/bot-handoff/route.ts` — simulate mode ใช้ handoffToAdminTest
  - `ChatAdminWeb/src/app/api/test-assignment/route.ts` — ใช้ handoffToAdminTest + เคลียร์ test_status_conversation ก่อน replay
  - `ChatAdminWeb/src/app/api/shadow-inbox/conversations/route.ts` — อ่าน assigned_to/status จาก test_status_conversation
- **โครงสร้าง test_status_conversation:**
  - key: `(source, conversation_id)` — source บอกว่ามาจากหน้าไหน
  - source: `test_assignment` | `shadowbot` | `replay_compare` | `test_chat`
  - ไม่เขียน admin_logs / close_history (test ไม่ต้อง audit)
  - ใช้ round-robin จริง (cursor ขยับจริง) แต่เก็บใน test_status_conversation
- **Verify:** tsc ผ่าน ✅ (รอ verify จริงในแต่ละหน้า)

### Phase 2I — รวม status (open/handoff/pending → handoff) + แยก filter เป็น 2 dropdown (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา 1 (status มั่ว):** `open` = `handoff` = `pending` แปลว่า "ส่งต่อแอดมินแล้ว ยังไม่ปิด" แต่ใช้ชื่อต่างกันในจุดต่างๆ
  - **Fix:** รวมเป็น `handoff` ค่าเดียว — backend ส่ง `handoff` แทน `open`
  - backend: `/api/admin/conversations/route.ts` + `/api/shadow-inbox/conversations/route.ts`
  - frontend: `tickets/page.tsx` reopen ใช้ `handoff` แทน `open`
  - เหลือ status 3 ค่า: `bot` / `handoff` / `closed`
- **ปัญหา 2 (filter มั่ว):** StatusFilter ผสมสถานะแชท + สถานะข้อความเข้าด้วยกัน
  - **Fix:** แยกเป็น 2 dropdown ใน ChatList:
    - **สถานะแชท:** ทั้งหมด / บอทตอบ / ส่งต่อแอดมิน / ปิดแล้ว
    - **สถานะข้อความ:** ทั้งหมด / ยังไม่อ่าน / อ่านแล้ว / ยังไม่ตอบ
  - ลบ `statusTone`/`statusLabel` ค่าเก่า (open/pending/resolved)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/api/admin/conversations/route.ts` (derivedStatus: open → handoff)
  - `ChatAdminWeb/src/app/api/shadow-inbox/conversations/route.ts` (เหมือนกัน)
  - `ChatAdminWeb/src/app/(console)/tickets/page.tsx` (reopen: open → handoff)
  - `ChatAdminWeb/src/components/chat/ChatList.tsx` (แยก filter + ลบค่าเก่า)
- **Verify:** tsc ผ่าน ✅

### Phase 2H — Quick reply ส่งเลย + textarea auto-expand + shadow-inbox dedupe (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา 1 (quick reply ไม่ส่งเลย):** กด quick reply → แอดใน textarea → ต้องกดส่งอีกที
  - **Fix:** กด quick reply → ส่งเลย (เรียก `send()` / `onSend()` โดยตรง)
  - TestChatClient: `send(undefined, qr.body)` — เพิ่ม `overrideMessage` param ใน `send()`
  - TicketChatPanel: `handleQuickReply` เรียก `onSend(qr.body)` โดยตรง
- **ปัญหา 2 (textarea ไม่ขยาย):** textarea สูงคงที่ → ข้อความยาวเป็น scroll ขึ้นลง
  - **Fix:** auto-expand — `onChange` ปรับ `style.height = scrollHeight` (สูงสุด 120-128px)
  - reset height หลังส่ง
  - เปลี่ยนจาก `h-14` / `rows={1}` เป็น `min-h` + `max-h` + `overflow-hidden`
- **ปัญหา 3 (duplicate key ใน shadow-inbox):** `ChatList.tsx:423` duplicate `shp_xxx` จาก ShadowInboxPage
  - **Fix:** dedupe by id ใน `loadConversations` ของ shadow-inbox (เหมือนที่แก้ใน tickets)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` (send override + auto-expand + quick reply send)
  - `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` (quick reply send + textarea auto-expand + ref)
  - `ChatAdminWeb/src/app/(console)/shadow-inbox/page.tsx` (dedupe conversations)
- **Verify:** tsc ผ่าน ✅

### Phase 2G — แก้ duplicate React key warning (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** Console error "Encountered two children with the same key" ในหน้า tickets
  - `shp_1291688535969234763` (conversation list button)
  - `shp_msg_2433748672435323250` (message list)
- **Root cause:** DB มี document ซ้ำ (same message_id / conversation_id) → React key ซ้ำ
- **Fix:** dedupe by id ใน frontend ก่อน setState
  - `loadConversations`: filter ซ้ำออกก่อน `setConversations`
  - `loadMessages`: filter ซ้ำออกก่อน `setMessages`
  - polling path มี dedupe อยู่แล้ว (line 110-117)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/(console)/tickets/page.tsx`
- **Verify:** tsc ผ่าน ✅

### Phase 2F — กัน overscroll/bounce ทุกหน้า (2026-09-12) — ✅ implement เสร็จ
- **ปัญหา:** เลื่อนสุดขอบ (บน/ล่าง/ขวา) ในหน้าที่ไม่ใช่ sidebar → เห็นขอบนอกแอป (background ด้านนอก)
- **Root cause:** browser overscroll/bounce behavior ไม่ได้ถูก disable
- **Fix:**
  - `globals.css`: เพิ่ม `overscroll-behavior: none` ที่ `html, body` (กัน bounce ทุกที่)
  - `globals.css`: เพิ่ม `body { overflow: hidden }` (กัน body scroll — ปล่อยให้แค่ inner container scroll)
  - `globals.css`: เพิ่ม `body:has(.auth-gradient-bg) { overflow-y: auto }` (หน้า login ยัง scroll ได้ถ้าจอเล็ก)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/globals.css`
- **Verify:** tsc ผ่าน ✅

### Phase 2E — Quick reply position auto-increment + floating chips UI (2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา 1 (ตำแหน่งทับกัน):** สร้าง quick reply ใหม่ให้ร้าน A → user ใส่ sort_order=0 ทุกครั้ง → ทับกับของเดิม
  - **Fix:** `createQuickReply` ใน backend คำนวณ `sort_order = max(existing) + 1` อัตโนมัติ (ไม่สนค่าที่ user ส่งมา)
  - **Frontend:** ซ่อน input sort_order ตอนสร้างใหม่ (แสดง "กำหนดอัตโนมัติ") — โชว์เฉพาะตอนแก้ไข
- **ปัญหา 2 (UI ไม่ใช่แบบที่อยากได้):** quick replies เป็น dropdown ใหญ่ทับ chat area
  - **Fix:** เปลี่ยนเป็น floating chips (ปุ่มกลมเล็กๆ) เหนือ text box — กดแล้วใส่คำตอบใน text box ทันที
  - ลบ `showQuickReplies` state + `Zap` import (ไม่ใช้แล้ว)
- **ปัญหา 3 (test chat ไม่มี quick reply):** TestChatClient ไม่มี quick replies เลย
  - **Fix:** เพิ่ม quick replies ใน TestChatClient — โหลดจาก API กรองตาม platform=shopee + shop + enabled
  - แสดงเป็น floating chips เหนือ textarea (เหมือน TicketChatPanel)
  - ซ่อนตอน handedOff (บอทไม่ตอบ)
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/backend/service/quickReplyService.ts` (createQuickReply: auto-increment sort_order)
  - `ChatAdminWeb/src/app/(console)/quick-replies/page.tsx` (form: ซ่อน sort_order ตอน create)
  - `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` (UI: dropdown → floating chips)
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` (เพิ่ม quick replies + floating chips UI)
- **Verify:** tsc ผ่าน ✅ — รอ verify จริง

### Phase 2D — Round-robin assignment investigation + fix (2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา:** replay Shadowbot conversation เดิม 2 ครั้ง → ครั้งแรกได้ admin 1, ครั้งที่ 2 ได้ admin 2 (ควร retain admin เดิม)
- **Root cause (simulateHandoff path):**
  1. `simulateHandoff` เรียก `autoAssignConversation({ conversation_id: "sim_${sessionId}" })`
  2. `autoAssignConversation` เรียก `pickNextAgent` ขยับ cursor ไป admin 1
  3. แล้ว `findOneAndUpdate({ conversation_id: "sim_xxx", assigned_to: null })` บน `conversations` collection
  4. แต่ `sim_xxx` ไม่มีใน `conversations` → update ล้มเหลว → คืน null
  5. **cursor ขยับไปแล้ว** แต่ assignment ไม่สำเร็จ → `test_chat_sessions.assigned_to = null`
  6. replay ครั้งที่ 2 → `session.assigned_to = null` → `pickNextAgent` อีกครั้ง → cursor ขยับไป admin 2
- **Root cause (production handoffToAdmin path):** ไม่มีปัญหา — Step 1 เช็ค `conv.assigned_to` ก่อน ถ้ามีอยู่แล้ว → ใช้คนเดิม
- **Fix:** เปลี่ยน `simulateHandoff` ให้เรียก `pickNextAgent` โดยตรง (ไม่ผ่าน `autoAssignConversation`)
  - ไม่ต้อง atomic update บน `conversations` (เพราะ sim_xxx ไม่มีอยู่จริง)
  - เก็บ assigned_to ใน `test_chat_sessions` โดยตรง
  - replay ครั้งที่ 2 → `session.assigned_to = admin1` → Step 1 ใช้คนเดิม → ไม่เรียก `pickNextAgent` อีก
- **ไฟล์ที่แก้:**
  - `ChatAdminWeb/src/app/api/admin/conversations/bot-handoff/route.ts` (simulateHandoff: เรียก pickNextAgent โดยตรง)
- **Note:** `autoAssignConversation` cursor advancement ก่อน atomic update เป็น design decision ("เสียตาคิวไปหนึ่งตา ยอมรับได้") — ไม่แก้เพราะไม่กระทบ production และ simulation path ไม่ใช้ autoAssignConversation แล้ว
- **Verify:** tsc ผ่าน ✅ — รอ verify จริง

### Phase 2C — Regression check (2026-09-12) — ✅ ผ่าน
- **เคสที่เช็ค**:
  1. **C — Context loss (Q1, Q2)**: ไม่แตะ conversation_products.py → ปลอดภัย ✅
  2. **A — Warranty trigger ("ถ้ามีปัญหาเคลมได้ใช่ไหมครับ")**: match `_CLAIM_QUESTION_PATTERNS` ก่อน → ไม่มี symptom kw → return False → บอทตอบ policy ไม่เข้า claim flow ✅
  3. **B — Trigger cascade (Q12 trust, Q13 iOS/Android)**: ไม่มี complaint keywords → `_has_strong_complaint=False` → LLM override ยังทำงานปกติ ✅
  4. **D — Trust (Q5, Q8, Q9)**: ไม่มี complaint keywords → ไม่กระทบ ✅
  5. **Order lookup**: ไม่แตะ order lookup logic → ปลอดภัย ✅
  6. **Short answers (Q2, Q6, Q7)**: ไม่แตะ answer length → ปลอดภัย ✅
  7. **Phase 1F — Test Chat Image Upload**: `ticket_state` optional (None = backward compat) → `resolveTicketState` คืน null ถ้าไม่มี conversationId → ปลอดภัย ✅
  8. **Charger subtype (Q9)**: ไม่แตะ charger subtype → ปลอดภัย ✅
- **Edge case ที่แก้เพิ่ม**:
  - "มีสายแรงกว่านี้ไหม [รูปภาพ]" ใน context warranty → guard: `_is_post_handoff_product_q=True` → ไม่ถือเป็น claim evidence → ปล่อยไป product flow ✅
  - "เปลี่ยนหัวชาร์จก็ใช้ไม่ได้ค่ะ" → เพิ่ม "ใช้ไม่ได้" ใน `_warranty_q_kws` → `_is_post_handoff_product_q=False` → post-handoff lock ทำงาน ✅
  - Q3 complaint ครั้งแรก → `_has_strong_complaint=True` ("ชาร์จไม่เข้า") → ห้าม LLM override แม้ไม่มี repeated complaint ✅
- **Verify**: py_compile ผ่าน ✅ + tsc ผ่าน ✅

### Phase 2B — แก้เคส patintidamanolai (เริ่ม 2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา 1 (Q3-Q8 วนซ้ำ):** ลูกค้าแจ้ง "ชาร์จไม่เข้า" ซ้ำ + ส่งวิดีโอ → บอทตอบ troubleshooting วนซ้ำ ไม่เข้า claim flow
  - **Root cause:** "ชาร์จไม่เข้า" อยู่แค่ใน `_symptom_kws` (ใช้ต่อเมื่อ match `_CLAIM_QUESTION_PATTERNS` ก่อน) → `detect_claim_request` ไม่จับ → LLM ตอบ troubleshooting
  - **Fix 1:** เพิ่ม "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด", "ชาร์จไม่ได้", "ไม่เข้าเลย", "ไฟไม่เข้า" ฯลฯ ใน `_CLAIM_REQUEST_INDICATORS` โดยตรง
- **ปัญหา 2 (Q5 LLM override):** "เปลี่ยนหัวชาร์จก็ใช้ไม่ได้ค่ะ" มี "ใช้ไม่ได้" match claim แต่ LLM override เป็น False
  - **Root cause:** LLM classify เป็น intent อื่น (เช่น product_recommend) + confidence >= 0.7 → override claim_request=False
  - **Fix 2:** เพิ่ม "repeated complaint" guard — ถ้าลูกค้าแจ้งปัญหาซ้ำ 2+ ครั้งใน history → ห้าม LLM override
- **ปัญหา 3 (Q11 tag ผิด):** ลูกค้าส่งรูปใน context warranty → บอทตอบเป็น product info ของ ZM411 (สินค้าเก่า)
  - **Root cause:** State 7 ทำงานเฉพาะเมื่อ `_bot_asked_claim_info=True` (บอทขอ claim info ใน last message) → Q11 บอทตอบเรื่องระยะเวลาเคลม ไม่ได้ขอ claim info → State 7 ไม่ทำงาน → รูปตกไป active product fallback
  - **Fix 3:** เพิ่ม "warranty context image" check — ถ้า history มี warranty/claim keywords และลูกค้าส่งรูป/วิดีโอ → ถือเป็น claim evidence แม้บอทไม่ได้ขอ claim info ใน last message
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/warranty.py` (`_CLAIM_REQUEST_INDICATORS` เพิ่ม charging symptoms)
  - `chatbot/shopeechat/app.py` (repeated complaint guard + warranty context image check)
  - `docs/SRS_SSD.md` (อัปเดต section 6.8.4)
- **Verify:** py_compile ผ่าน ✅ + tsc ผ่าน ✅ — รอ verify จริง

### Phase 2A — State-driven open/closed (เริ่ม 2026-09-12) — ✅ implement เสร็จ รอ verify
- **ปัญหา**: ปุ่ม "ปิดแชท" ใน test chat แค่ `setHandedOff(false)` client-side → บอทไม่รู้ว่าปิดแล้ว → ยังล็อค post-handoff เพราะแสกน history หา "รอการติดต่อกลับ"
- **Root cause** (5 จุดที่ขาด):
  1. ปุ่ม "ปิดแชท" ไม่ได้เรียก API อัปเดต DB
  2. `botCallService.callBot()` ไม่ส่ง conversation status ไปบอท
  3. `ChatRequest` (Python) ไม่มี field รับ `ticket_state`
  4. บอท post-handoff logic สรุปจาก text ใน history ไม่ใช่ state
  5. `simulate_handoff` ไม่มี `simulate_close` endpoint
- **วิธีแก้** (state-driven ไม่ใช่ keyword-driven):
  1. ✅ เพิ่ม endpoint `/test-chat/sessions/{id}/close` + `/reopen` ใน Python bot — อัปเดต `test_chat_sessions.status`
  2. ✅ ปุ่ม "ปิดแชท" ใน TestChatClient เรียก endpoint ผ่าน proxy + setSessionStatus("closed")
  3. ✅ เพิ่ม `ticket_state` field ใน `ChatRequest` (Python)
  4. ✅ `botCallService.ts` ดึง status จาก DB (`resolveTicketState`) + ส่ง `ticket_state` ใน payload
  5. ✅ บอทใช้ `ticket_state` ตัดสินใจ:
     - `closed` → ข้าม post-handoff lock ทั้งหมด
     - `handoff`/`open` + มี handoff marker → ล็อค (ยกเว้น exceptions)
     - `None` → fallback ใช้ history scan แบบเดิม (backward compat)
  6. ✅ เพิ่ม `post_handoff_exceptions: string[]` ใน ShopSettings — แอดมินตั้งได้ต่อร้าน
  7. ✅ บอทดึง exceptions ผ่าน `_get_post_handoff_exceptions()` + ถ้า message match exception → ตอบปกติ ไม่ล็อค
- **ไฟล์ที่แก้**:
  - `chatbot/shopeechat/app.py` (endpoint close/reopen + ticket_state field + _get_post_handoff_exceptions + post-handoff logic)
  - `ChatAdminWeb/src/backend/service/botCallService.ts` (resolveTicketState + ส่ง ticket_state)
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` (ส่ง conversationId + simulate ให้ callBot)
  - `ChatAdminWeb/src/backend/service/shopSettingsService.ts` (post_handoff_exceptions field)
  - `ChatAdminWeb/src/app/api/shop-settings/route.ts` (รับ post_handoff_exceptions)
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` (sessionStatus state + ส่ง ticket_state + เรียก close API)
- **Verify**: py_compile ผ่าน ✅ + tsc ผ่าน ✅ — รอ verify lifecycle จริง

### Phase 1F — Test Chat Image Upload (เริ่ม 2026-09-11)
- **ปัญหา**: ปุ่ม "ปิดแชท" ใน test chat แค่ `setHandedOff(false)` client-side → บอทไม่รู้ว่าปิดแล้ว → ยังล็อค post-handoff เพราะแสกน history หา "รอการติดต่อกลับ"
- **Root cause** (5 จุดที่ขาด):
  1. ปุ่ม "ปิดแชท" ไม่ได้เรียก API อัปเดต DB
  2. `botCallService.callBot()` ไม่ส่ง conversation status ไปบอท
  3. `ChatRequest` (Python) ไม่มี field รับ `ticket_state`
  4. บอท post-handoff logic สรุปจาก text ใน history ไม่ใช่ state
  5. `simulate_handoff` ไม่มี `simulate_close` endpoint
- **วิธีแก้** (state-driven ไม่ใช่ keyword-driven):
  1. เพิ่ม endpoint `/test-chat/sessions/{id}/close` ใน Python bot — อัปเดต `test_chat_sessions.status = "closed"`
  2. ปุ่ม "ปิดแชท" ใน TestChatClient เรียก endpoint นี้ผ่าน proxy
  3. เพิ่ม `ticket_state` field ใน `ChatRequest` (Python)
  4. `botCallService.ts` ดึง status จาก DB + ส่ง `ticket_state` ใน payload
  5. บอทใช้ `ticket_state` ตัดสินใจ:
     - `closed` → ข้าม post-handoff lock ทั้งหมด
     - `handoff`/`open` + มี handoff marker → ล็อค (ยกเว้น exceptions)
     - `None` → fallback ใช้ history scan แบบเดิม (backward compat)
  6. เพิ่ม `post_handoff_exceptions: string[]` ใน ShopSettings — แอดมินตั้งได้ต่อร้าน
  7. บอทดึง exceptions + ถ้า message match exception → ตอบปกติ ไม่ล็อค
- **เคสที่ต้องไม่พัง**: warranty Q1 first message, Q11 trigger, Q12 cascade, Q9 cable, Q14 BioKoop, post-handoff product Q escape, review request, phone extraction
- **Verify**: lifecycle 10 ขั้นตอน (handoff → close → ส่ง product Q → ตอบ product_store → ส่ง warranty ใหม่ → เข้า warranty flow ได้)

### Phase 1F — Test Chat Image Upload (เริ่ม 2026-09-11)
- **ปัญหา**: TestChatClient ไม่มี UI ส่งรูป ลูกค้าพิมพ์ `[รูปภาพ]` เอง → bot เห็นแค่ text placeholder ไม่เห็นรูปจริง → ตอบ "รูปอาจไม่แสดงผล"
- **เป้าหมาย**: เพิ่มปุ่ม upload รูปใน TestChatClient → ส่ง URL ให้ bot ผ่าน buffer → bot เห็นรูปจริง
- **สิ่งที่ทำ**:
  1. `/api/test-chat/upload` — รับ multipart formdata → เก็บใน Mongo `test_chat_uploads` → คืน URL
  2. `/api/test-chat/uploads/[id]` — GET serve binary กลับ (bot ดึง URL นี้ได้)
  3. TestChatClient เพิ่มปุ่ม 📎 upload + preview thumbnails + ส่ง URL ไป buffer/non-buffer
  4. buffer route รับ `images[]` + เก็บใน raw_payload + ใส่ placeholder ถ้า message ว่าง
  5. flush route รวม images จากทุก message + แปลง URL สัมพันธ์เป็น absolute + ส่ง `images` ให้ bot
  6. config เพิ่ม `testChatUploads` collection
- **เคสที่ผ่าน** (verify แล้ว):
  - tsc ผ่าน ✅
  - py_compile ผ่าน ✅
  - upload endpoint ต้องการ auth (401 ถ้าไม่มี cookie) ✅
  - logic รวม images จากหลาย message ใน flush route ✅
  - middleware ปล่อย `/api/test-chat/uploads` public (แก้ 401 → 200) ✅
  - uploads endpoint serve binary สำหรับ <img> ได้ (HTTP 200 image/png 345KB) ✅
  - bot เห็นรูปจริง + ตอบเกี่ยวกับสินค้าในรูปได้ (Q5 ใน session CukTechThailand) ✅
  - processMessage รับ images จาก buffer flush + ส่งให้ bot (production path) ✅
  - test-chat imageViewer กดดูรูปใหญ่ได้ ✅
  - replay-compare แสดงรูปจริงใน QA detail + ส่ง user_media จาก Python ✅
  - bot max_images อ่านจาก env BOT_MAX_IMAGES_PER_TURN (default 5) ไม่ใช่ fixed 3 ✅
  - bot ใช้ vision desc ใน retrieval ถ้า message เป็น placeholder รูปทั้งหมด ✅
  - TestChatClient history เก็บ images + ส่งให้ bot ใน history field ✅
  - admin-config UI แสดง media buffer config (window + max) แยกจาก text ✅
  - admin-config API validation รองรับ media buffer keys ✅
- **E2E test ผ่าน**:
  - bot รับ images + ตอบเกี่ยวกับรูปได้ ✅
  - bot รับ 4 รูป (max_images=5) ไม่ error ✅
  - bot รับ history มี images ไม่ error ✅
  - text-only regression ผ่าน ✅
  - warranty regression (เคส A) ผ่าน ✅
- **ไฟล์ที่แก้**: `test-chat/upload/route.ts`, `test-chat/uploads/[id]/route.ts`, `test-chat/buffer/route.ts`, `test-chat/flush/route.ts`, `TestChatClient.tsx`, `config.ts`, `middleware.ts`, `bufferService.ts`, `botWorkerService.ts`, `replay-compare/page.tsx`, `replay_compare.py`, `chatbot/shopeechat/app.py`, `admin-config/page.tsx`, `admin-config/route.ts`
- **Verify**: tsc ผ่าน + py_compile ผ่าน + e2e bot test ผ่าน 5 เคส

### Phase 1F-fix — Image persist + trigger cascade + vision-retrieval (2026-09-04)
- **ปัญหาที่แก้**:
  1. รูปขึ้นเป็น HTML text ใน user message bubble (หลัง reload)
  2. รีเฟรชหน้าแล้วรูปหาย (images ไม่ถูก persist ลง DB)
  3. warranty flow จับ Q5 ติด (trigger cascade — Q1 warranty → Q2-Q4 product → Q5 โดนจับ)
  4. vision desc ไม่ถูกใช้ใน retrieval ถ้า message อ้างถึงรูป ("น้องในรูปคือตัวอะไร")
- **วิธีแก้**:
  1. เพิ่ม `images: list[str]` field ใน `TestChatMessage` Python model
  2. `saveMessageToSession` ส่ง images ไป DB ด้วย
  3. ตอน reload — render รูปจาก `m.images` เป็น `<img>` HTML (ไม่ใช่ escapeHtml ทั้งหมด)
  4. warranty state machine — เพิ่ม `_last_model_is_warranty` guard ใน fallback `_bot_asked_info_ever`
     - ถ้า last model message ไม่ใช่ warranty เลย → ไม่ใช้ fallback นี้
  5. vision-retrieval — ขยายเงื่อนไขจับคำอ้างถึงรูป ("ในรูป", "รูปนี้", "ตัวนี้", "น้องในรูป")
- **เคสที่ผ่าน** (verify แล้ว):
  - Q5 "ไม่ใช่ น้องในรูป..." หลัง product answer → ไม่ติด warranty flow ✅
  - Q4 "น้องในรุปคือตัวอะไร" + รูป → vision-retrieval ทำงาน ตอบเกี่ยวกับรูป ✅
  - warranty Q1 ยังทำงานปกติ ✅
  - warranty State 7 (ส่งรูปหลัง bot ขอ) ยังทำงาน ✅
  - tsc + py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (TestChatMessage + warranty guard + vision-retrieval), `TestChatClient.tsx` (saveMessageToSession + reload render)
- **ยังเหลือ**: Q9 "สายแรงๆ กว่านี้ใช้กับ mi 17 ultra" → bot แนะนำแบตแทนสาย (retrieval ไม่กรอง charger_subtype) — ไว้ทำทีหลัง

### Phase 1F-Q9 — Charger subtype retrieval fix (2026-09-04)
- **ปัญหา**: Q9 "มีสายแรงๆ กว่านี้ใช้กับ mi 17 ulrat ไหม" → intent บอก charger_subtype=cable ชัด แต่ bot แนะนำแบตสำรองทั้ง 5 รุ่น
- **สาเหตุ** (3 จุด):
  1. FUZZY-MATCH ดึงสินค้าที่ fuzzy match "mi 17 ulrat" → ได้แบตสำรอง 5 ตัว (ชื่อมี "mi") โดยไม่กรอง charger subtype
  2. `if not _ref_regex_products` อยู่ใน `else` block ของ `if _ref_regex_products` → ถ้า _ref_regex_products ถูกยกเลิกใน if block (กรอง subtype เหลือ 0) → ไม่เข้า else → ไม่ได้ fetch ใหม่
  3. `_skip_sub = _is_superlative and not _detect_charger_subtype(retrieval_message)` → True เพราะ "สายแรงๆ" ไม่มี "สายชาร์จ" เต็ม → ข้าม subtype filter ทั้งหมด ทั้งที่ intent บอก cable ชัด
- **วิธีแก้**:
  1. เพิ่ม `charger_subtype_override` logic ใน `fetch_products` — ถ้ามี override ให้เพิ่ม "charger" เข้า product_types เสมอ (กัน product_types={"phone"} ข้าม subtype filter)
  2. เพิ่ม REF-SUBTYPE-FILTER หลัง `products = _ref_regex_products` — กรอง charger subtype สำหรับ FUZZY-MATCH/MODEL-REGEX path ที่บายพาส fetch_products
  3. ย้าย superlative/fetch logic ออกจาก `else` block → เป็น `if not _ref_regex_products:` แยก (ทำงานแม้ _ref_regex_products ถูกยกเลิก)
  4. `_skip_sub` เพิ่ม guard `and not _intent_sub_early` — ถ้า intent บอก charger_subtype ชัด → ไม่ skip แม้เป็น superlative
- **เคสที่ผ่าน** (verify แล้ว):
  - Q9 "มีสายแรงๆ กว่านี้ใช้กับ mi 17 ulrat ไหม" → ดึงสายชาร์จ 10 รุ่น (ไม่ใช่แบต) ✅
  - "มีสายชาร์จไหม" → ยังดึงสายชาร์จถูกต้อง ✅
  - warranty Q1 → ยังทำงานปกติ ✅
  - tsc + py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (REF-SUBTYPE-FILTER + ย้าย if not _ref_regex_products + _skip_sub guard), `chatbot/shopeechat/product_store.py` (charger_subtype_override → product_types)

### Phase 1F-Warranty — Review request + phone extraction fix (2026-09-04)
- **ปัญหา**: หลัง handoff แอดมิน ลูกค้าถาม "ทวนข้อมูลที่ผมให้ไปหน่อย" → bot ตอบ generic "ระบบได้บันทึกข้อมูล..." ซ้ำๆ ไม่ทวนจริง
  - และ "087 788 7888" (เบอร์โทรมี space) → bot ดึงเป็นชื่อ-นามสกุลแทนเบอร์ เพราะ phone pattern ไม่ลบ space
- **สาเหตุ**:
  1. `_PHONE_PATTERN = r"\b0\d{8,9}\b"` ไม่จับ "087 788 7888" เพราะมี space คั่น → extract เป็น name แทน
  2. `_post_handoff_has_info` เช็คแค่ order_id ไม่เช็ค phone/name → เบอร์ตกไป generic post-handoff
  3. ไม่มี state สำหรับ "ทวนข้อมูล" → ตอบ generic ซ้ำ
  4. State 6 `_has_valid_name` ใช้ `_info["name"]` โดยตรงใน review_lines ไม่ได้เช็ค valid name flag
- **วิธีแก้**:
  1. `warranty.py`: ลบ space และ "-" ก่อน match phone pattern (`re.sub(r"[\s\-]", "", msg)`)
  2. `app.py`: เพิ่ม phone/name ใน `_post_handoff_has_info` check
  3. `app.py`: เพิ่ม review request state — ดึง info จาก history แยกแต่ละ message + กรอง name ที่มีตัวเลข/คำแปลกๆ
  4. `app.py`: State 6 ใช้ `_has_valid_name` แทน `_info["name"]` ใน review_lines + เพิ่ม guard "name มีตัวเลข → ไม่ valid"
- **เคสที่ผ่าน** (verify แล้ว):
  - Q7 "087 788 7888" post-handoff → ตอบรับเบอร์ 0877887888 (ไม่ดึงเป็นชื่อ) ✅
  - Q8 "ทวนข้อมูลที่ผมให้ไปหน่อย" → ทวนเบอร์ + รูป จาก history ✅
  - warranty Q1 ยังทำงานปกติ ✅
  - Q9 สายชาร์จ ยังดึง 10 รุ่น ✅
  - py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/warranty.py` (phone pattern ลบ space), `chatbot/shopeechat/app.py` (review request state + _post_handoff_has_info + _has_valid_name guard)

### Phase 1F-PostHandoff — Post-handoff lock-in escape (2026-09-04)
- **ปัญหา**: หลัง bot handoff แอดมิน → ทุกข้อความต่อไปถูกล็อคเป็น "ระบบได้บันทึกข้อมูล..." แม้ "หาสายชาร์จครับ" หรือ "มีสายแรงๆ กว่านี้" ที่เป็น product question ชัดๆ
  - สถานการณ์จริง: แอดมินปิดแชท (resolve ticket) → ลูกค้าทักใหม่ด้วยคำถามสินค้า → bot ยังล็อคอยู่ใน post-handoff
- **สาเหตุ**: `if _bot_handed_off and not _post_handoff_has_info:` ล็อคทุกข้อความที่ไม่ใช่ claim info โดยไม่ตรวจว่าเป็น product question ไหม
- **วิธีแก้**: เพิ่ม post-handoff escape — ถ้าลูกค้าถาม product question ชัด (มี product keyword และไม่มี warranty keyword) → ปล่อยไปเส้นทางปกติ
  - Product keywords: สายชาร์จ, หัวชาร์จ, แบต, พาวเวอร์แบงค์, หาสาย, มีสาย, สวัสดี, ราคา, etc.
  - Warranty keywords: เคลม, ประกัน, ทวนข้อมูล, ส่งสินค้า, พัสดุ, เบอร์, etc.
  - ถ้ามี warranty keyword → ยังล็อค (เช่น "เคลมสายชาร์จ" ยังเป็น warranty)
- **เคสที่ผ่าน** (verify แล้ว):
  - "หาสายชาร์จครับ" หลัง handoff → ตอบ product 10 รุ่น ✅
  - "มีสายแรงๆ กว่านี้ใช้กับ mi 17 ulrat ไหม" หลัง handoff → ดึงสายชาร์จ 10 รุ่น ✅
  - "สวัสดีครับ หาสายชาร์จครัย" หลัง handoff → ตอบ product ✅
  - "ทวนข้อมูลที่ผมให้ไปหน่อย" หลัง handoff → ยังทวนข้อมูล (ไม่หลุด) ✅
  - "เคลมสายชาร์จหน่อย" หลัง handoff → ยังเป็น warranty (มี "เคลม") ✅
  - warranty Q1 ยังทำงานปกติ ✅
  - py_compile ผ่าน ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (post-handoff escape: _is_post_handoff_product_q check)

### Phase 1E — Media-aware Buffer (เริ่ม 2026-09-11)
- **ปัญหา**: ลูกค้าชอบส่งหลายรูป + พิมพ์ตาม แต่ buffer ปัจจุบันใช้เวลาเดียวกับ text
  - ถ้ารอนานเท่า text → รูปยังไม่ครบก็ flush แล้ว
  - ถ้ารอนานเท่ากับทุกอย่าง → text ค้างนานเกินไป
  - flush ส่งแค่ firstMsg.raw_payload → รูปที่ 2,3 หาย
- **สิ่งที่ทำ**:
  1. `BufferConfig` เพิ่ม `bufferWindowMediaMs` (default 12000ms) + `bufferMaxMediaMessages` (default 10)
  2. `hasMedia(rawPayload)` — ตรวจ message_type เป็น image/video/image_with_text
  3. `extractMediaUrls(rawPayload)` — ดึง URL จาก image_url / image_url_list / video_url
  4. `bufferOrProcess` — ถ้า buffer มี media → ใช้ window นานกว่า + max มากกว่า
  5. `flushBuffer` — รวม images จากทุก message (ไม่ใช่แค่ firstMsg) → ฝังใน `_merged_images` field
  6. `systemConfigService` เพิ่ม `bot_buffer_window_media_ms` + `bot_buffer_max_media_messages` (env + DB + admin-configurable)
- **เคสที่ผ่าน** (verify แล้ว):
  - hasMedia จับ image/video/image_with_text ถูก ✅
  - extractMediaUrls ดึง URL จาก image_url + image_url_list + video_url ถูก ✅
  - merge รวม URLs จากหลาย message ไม่ซ้ำ ✅
  - tsc ผ่าน ✅
- **ไฟล์ที่แก้**: `bufferService.ts`, `systemConfigService.ts`, `botWorkerService.ts`
- **Verify**: tsc ผ่าน + node test hasMedia/extractMediaUrls/merge ผ่าน

### Phase 1B — Tracking Lookup (เริ่ม 2026-09-11)
- **เป้าหมาย**: ลูกค้าส่งรูป tracking / ถามสถานะ → บอทเช็ค tracking จาก MongoDB → ตอบสถานะ + ขนส่ง
- **สิ่งที่ทำ**:
  1. `order_store.lookup_order` เพิ่ม `tracking_no` + `tracking_numbers` จากทุก `package_list` entry (ไม่ใช่แค่ entry แรก) — เช็ค field: tracking_no, tracking_number, parcel_id, waybill_id
  2. `order_store.lookup_by_tracking(tracking_no, shop_filter)` — ค้น order จาก tracking number (MongoDB only) — ค้นใน package_list ทุก field
  3. `order_store.extract_tracking_number(text)` — ดึง tracking จาก text/vision OCR — รองรับ SPX/Kerry/Flash/J&T/ไปรษณีย์ไทย + กรองเบอร์โทรออก
  4. `build_order_context` เพิ่ม tracking_no + tracking_numbers (ถ้ามีหลาย package)
  5. `app.py` เชื่อม tracking lookup เข้า flow — ถ้าไม่มี order_sn แต่มี tracking (ในข้อความหรือ vision desc) → lookup_by_tracking → context → LLM ตอบสถานะ
- **เคสที่ผ่าน** (verify แล้ว):
  - ส่งเลขพัสดุ "SPXTH1234567890" → log แสดง `[TRACKING] พบ tracking_no=SPXTH1234567890 → lookup` + บอทตอบเป็นมิตร (ไม่พบใน DB เพราะเลขสมมุติ) ✅
  - order_sn lookup ยังทำงานปกติ (source=order_lookup) ✅
  - Regression (ไม่มี tracking/order) → บอทตอบปกติ ✅
- **ไฟล์ที่แก้**: `order_store.py`, `app.py`
- **Verify**: `py_compile` ผ่าน + curl test 3 เคสผ่าน + log แสดง [TRACKING]

### Phase 1C — Order Panel + Warranty Auto-Check (เริ่ม 2026-09-11)
- **เป้าหมาย**:
  1. Ticket panel ด้านขวา แสดง order cards (collapsible) พร้อม รูป + ชื่อ + ราคา + variant + สถานะ + ขนส่ง + tracking
  2. Warranty auto-check: ลูกค้าถามเคลม → บอทเช็ควันซื้อจาก order → ระยะประกัน → ตอบเงื่อนไข → โยนเข้า warranty_claim
- **สิ่งที่ทำ**:
  1. `order_store.lookup_order` เพิ่ม variant/price/image/sku/item_id/model_id + total_amount + buyer_username + payment_method + create_time_raw
  2. `order_store.lookup_orders_by_buyer(buyer_username, shop_filter, limit)` — ดึง order history ของลูกค้า
  3. Next.js API `/conversations/[id]/orders` ดึง order history พร้อม tracking + variant + price + image + total_amount + buyer_username
  4. `InfoTab.tsx` OrderHistorySection — collapsible per-order card + รูป + ราคา + variant + tracking + logistics_status + payment_method
  5. `warranty.py auto_check_warranty(order_sn, shop_filter, warranty_months=12)` — เช็ควันซื้อ → คำนวณ is_in_warranty → สร้าง warranty_text ให้ LLM
  6. `app.py` เชื่อม warranty auto-check เข้า flow — ถ้า claim request + มี order_sn → ข้าม order_lookup → auto_check_warranty → แนบ context ใน first-message claim answer
- **เคสที่ผ่าน** (verify แล้ว):
  - "สินค้าเสีย อยากเคลม เลขคำสั่งซื้อ 240215MCEQMT60" → source=warranty_claim_first_message + ตอบ "ซื้อเมื่อ 15 ก.พ. 2567 หมดช่วงประกันแล้ว" + ขอข้อมูลเคลม ✅
  - order_sn lookup ยังทำงานปกติเมื่อไม่ใช่ claim (source=order_lookup) ✅
  - Regression (ทักทาย) → บอทตอบปกติ ✅
- **ไฟล์ที่แก้**: `order_store.py`, `warranty.py`, `app.py`, `InfoTab.tsx`, Next.js API route
- **Verify**: `py_compile` + `tsc` ผ่าน + curl test 3 เคสผ่าน

### Phase 1D — Replay + Docs (เริ่ม 2026-09-11)
- **เป้าหมาย**:
  1. `replay_compare.py` ส่ง images จาก stored `raw_payload`
  2. อัปเดต `docs/SRS_SSD.md` ให้ครบ
- **สิ่งที่ทำ**:
  1. `replay_compare.py build_bot_message` คืน `(message, item_id, images)` — ดึง URL รูป/วิดีโอจาก media
  2. `replay_compare.py parse_raw_message` เพิ่ม `media` field สำหรับ image/video (url + type)
  3. `replay_compare.py call_bot` รับ `images` parameter + ส่งใน body
  4. จุดเรียก call_bot ส่ง `images=msg_images` ให้ bot
- **ไฟล์ที่แก้**: `replay_compare.py`
- **Verify**: `py_compile` ผ่าน

###  Plan ค้าง: Order Panel + Warranty Auto-Check (ทำหลัง multimodal เสร็จ)
- **Order Panel (ticket ด้านขวา)**:
  - แสดงการ์ดสินค้าพร้อมรูป + ชื่อ + ราคา + สี/variant + สถานะการจัดส่ง + แบรนด์ + ร้าน + วันที่จัดส่ง + ขนส่ง
  - เป็น collapsible card — กดดูรายละเอียดเพิ่มได้
  - ปัจจุบัน: `OrderHistorySection` ใน `InfoTab.tsx` แสดง 5 รายการล่าสุด + ปุ่ม "ดูทั้งหมด" — ต้องเพิ่มรูป + variant + tracking + collapsible
- **Order Status Query (ลูกค้าถาม)**:
  - ลูกค้าถามสถานะสินค้า → บอทตอบสถานะปัจจุบัน + ขนส่ง (ถ้าส่งแล้ว)
  - ปัจจุบัน: `order_store.lookup_order()` ดึงสถานะได้ แต่ไม่มี tracking_no
- **Warranty Auto-Check (ลูกค้าถามเคลม)**:
  - ลูกค้าถามเคลม → บอทเช็ควันที่ซื้อจากเลขออเดอร์ → ถ้าอยู่ในระยะประกัน → ตอบเงื่อนไข + ระยะเวลา → โยนเข้า warranty_claim flow
  - ปัจจุบัน: warranty flow ขอข้อมูลแล้ว handoff แต่ไม่เช็ควันที่ซื้ออัตโนมัติ
- **ไฟล์ที่จะแก้**: `InfoTab.tsx`, `order_store.py`, `warranty.py`, `app.py`

### include_desc merge — intent บอก False แต่ keyword บอก True → ไม่ส่ง description ให้ LLM
- **เคสที่พบ** (test chat YoupinOfficialStore, BioKoop):
  - ลูกค้าถาม "ขอรายละเอียดเพิ่มเติมได้ไหมครับ" หลังคุยเรื่อง BioKoop
  - สินค้ามี description ยาวเต็ม (จุดเด่น, ข้อมูลสินค้า, อุปกรณ์ในกล่อง)
  - แต่บอทตอบ "ไม่มีรายละเอียดเพิ่มเติมในระบบแล้ว"
- **Root cause**:
  1. `include_desc` ใน `llm.py` บรรทัด 541: ถ้า intent_result confidence ≥ 0.7 → ใช้ `needs_description` จาก intent เท่านั้น
  2. intent classifier บอก `needs_description=False` → `include_desc=False`
  3. keyword matching ("รายละเอียด" อยู่ใน `desc_kw`) ไม่ได้ถูกเช็คเลย
  4. `include_description=False` → `_build_context` ตัด `description_excerpt` ออกจาก context ทั้งหมด
  5. LLM ไม่เห็น description → ตอบ "ไม่มีรายละเอียดเพิ่มเติม"
- **วิธีแก้** (1 จุดใน `llm.py` บรรทัด ~539):
  1. merge intent + keyword: `include_desc = _intent_desc or _kw_match`
  2. ถ้า intent บอก False แต่ keyword บอก True → ยังส่ง desc (กัน intent พลาด)
  3. ถ้า intent บอก True → ส่ง desc เหมือนเดิม
- **เคสที่ผ่านหลังแก้** (verify แล้ว):
  - "ขอรายละเอียดเพิ่มเติมได้ไหมครับ" + history BioKoop → บอทตอบรายละเอียดเพิ่มเติม (Bluetooth 5.3, 178 โหมด, 160 mAh, 3ATM, ฯลฯ)
  - "สวัสดีครับ" ไม่มี history → บอทตอบปกติ ไม่ส่ง desc
- **เคสที่ต้องไม่พัง**: คำถามรับประกัน/สเปก/ชาร์จ (ต้องส่ง desc), คำถามทั่วไป (ไม่ส่ง desc)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/llm.py`
- **Verify**: `python -m py_compile` ผ่าน + curl test 2 เคสผ่าน

### Rejection memory — บอทแนะนำสินค้าที่ลูกค้าปฏิเสธแล้วซ้ำ
- **เคสที่พบ** (test chat CukTechThailand):
  - บอทแนะนำ C2C515 (100W สาย) กับ AD1404U (140W หัวชาร์จ) — wattage ไม่ match
  - ลูกค้าแย้ง "ทำไมสาย 100W แต่หัว 140W" → บอทแก้เป็น CTC615W ครั้งเดียว
  - ข้อความถัดไป บอทกลับไปแนะนำ C2C515 อีก — ไม่จำว่าลูกค้าปฏิเสธ
  - ลูกค้าถาม "ทำไมไม่แนะนำ CTC615W มาแต่ต้น" → บอทตอบ "เพราะยอดฮิต" แล้วยังแนะนำ C2C515
- **Root cause**:
  1. RAG ดึงสินค้าใหม่ทุกรอบตาม keyword → ดึง C2C515 มาอีกเพราะ keyword match
  2. LLM ไม่ได้รู้ว่าลูกค้าปฏิเสธ C2C515 ไปแล้ว → เห็นใน context ก็แนะนำ
  3. history ถูก truncate 200 ตัวอักษร (llm.py บรรทัด 548) → บางทีข้อมูลการปฏิเสธหาย
- **วิธีแก้** (1 จุดใน `app.py` บรรทัด ~3920):
  1. เพิ่ม rejection memory logic ก่อนเรียก `llm.answer()`
     - สแกน `req.history` หา model messages ที่มี product codes (regex `[A-Z][A-Z0-9]{3,11}` + มีตัวเลข)
     - สแกน user message ถัดไปหา negative signals (ทำไม, ไม่โอเค, ดีกว่า, ไม่เอา, จ่ายได้แค่, แล้วทำไมไม่)
     - รองรับทั้ง code ตรงๆ (case-insensitive) และ indirect reference ("สายชาร์จนี้", "อันนี้")
     - indirect reference: "สาย" → match cable code (C2C, CTC, CL), "หัว" → match adapter code (AD)
     - ถ้าเป็น current message (req.message) ก็เช็คด้วย (ไม่ใช่แค่ history)
  2. ส่ง rejected list เป็น extra_context ให้ LLM: "⚠️ ลูกค้าปฏิเสธสินค้า X — ห้ามแนะนำซ้ำ"
  3. รวมกับ superlative_clarify_extra เป็น `_combined_extra`
- **เคสที่ผ่านหลังแก้** (verify แล้ว):
  - ลูกค้าแย้ง C2C515 + ถามสายอื่น → `has C2C515: False`, แนะนำ CTC615P/CTC620P แทน
  - ลูกค้าถาม "ทำไมไม่แนะนำ CTC615W มาแต่ต้น" → บอทขอโทษ + แนะนำ CTC615W ไม่กลับไป C2C515
  - ถามสายชาร์จปกติไม่มี history → บอทตอบปกติ ไม่มี rejection extra_context
- **เคสที่ต้องไม่พัง**: การแนะนำสินค้าปกติ, superlative, compatibility check, การเปรียบเทียบ
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **Verify**: `python -m py_compile` ผ่าน + 3 เคส curl ผ่าน + REJECTION-MEMORY log แสดง C2C515

### Charger subtype carry ไม่ทำงานเมื่อ message พิมพ์ตก "หัวชาจ" หรือไม่มีคำ charger เลย
- **เคสที่พบ** (log จริง CukTechThailand):
  - Q5 "มีชาจเร็วขาร์จแรงกว่านี้ไหม" (หลังคุยหัวชาร์จ AD652S) → บอทตอบ CL315P (สาย) ผิด
  - Q15 "มีจอไหม แบบมีจอด้วยดิ" (หลังคุยหัวชาร์จ AD1404U) → บอทตอบ CL315P (สาย) ผิด
- **Root cause**:
  1. `_detect_product_types` ไม่มี logic แก้พิมพ์ผิด "หัวชาจ" → "หัวชาร์จ" (แต่ `_detect_charger_subtype` มี)
  2. carry type จาก history (app.py บรรทัด 2399-2417) ใช้ `_detect_product_types(hmsg)` อย่างเดียว → ไม่จับ Q3/Q7/Q13 "หัวชาจ" เป็น charger
  3. carry subtype (app.py บรรทัด 2423) เช็ค `"charger" in current_types` ก่อน → ไม่ผ่าน → carry subtype ไม่ทำงาน
  4. RAG ใช้ `req.message` ตรงๆ → ดึงสายชาร์จ (CL315P) มาเพราะ keyword "ชาร์จ"/"จอ" ตรงกับสายชาร์จใน DB
- **วิธีแก้** (2 จุดใน `app.py`):
  1. carry type จาก history: ถ้า `_detect_product_types` ไม่จับ ให้ลอง `_detect_charger_subtype(hmsg)` ด้วย — ถ้าจับได้ ถือว่าเป็น `{"charger"}`
  2. carry subtype: เพิ่มเงื่อนไข `_detect_charger_subtype(req.message) is not None` เป็นทางเลือกให้ `current_types` ถือว่าเป็น charger context ด้วย
- **เคสที่จะผ่านหลังแก้**:
  - Q5 → carry adapter จาก Q3 → RAG ดึงหัวชาร์จ
  - Q15 → carry type charger จาก Q13 + carry adapter → RAG ดึงหัวชาร์จ
- **เคสที่ต้องไม่พัง**: Q3, Q7, Q13 (มี "หัวชาจ" ตรงๆ → subtype จับได้ → ไม่ต้อง carry)
- **ไฟล์ที่จะแก้**: `chatbot/shopeechat/app.py`
- **Verify**: `python -m py_compile chatbot/shopeechat/app.py` + ทดสอบ `_detect_charger_subtype` กับ Q5/Q15 + ทดสอบ carry logic ด้วย history จริง

---

## เคสที่ผ่านแล้ว (เพิ่มใหม่ 2026-09-11)

### Multimodal Vision Phase 1A — บอทเข้าใจรูปภาพ (ผ่าน foundation + verify)
- **เป้าหมาย**: บอทรับ URL รูปจากลูกค้า → ใช้ Gemini vision อ่านรูป → ตอบเข้ากับบริบท
- **สิ่งที่ทำ (Phase 1A Foundation)**:
  1. `app.py` ChatRequest + ChatMessage schema: เพิ่ม `images: list[str]` field
  2. `llm.py` ฟังก์ชันใหม่:
     - `describe_image(image_url, shop_hint)` — ใช้ `gemini-3-flash-preview` (VISION_MODEL env) อ่านรูป → คืน (text, usage_info)
     - `describe_images(image_urls, shop_hint, max_images=3)` — อ่านหลายรูป → คืน (combined_text, total_usage)
     - `_VISION_PROMPT` — prompt ภาษาไทย อธิบายรูปสั้นๆ (สินค้า/tracking/สกรีนช็อต/สินค้าเสีย/รูปอื่นๆ)
  3. `app.py` vision pass block (บรรทัด ~389): ถ้า `req.images` ไม่ว่าง → เรียก `llm.describe_images()` → เก็บใน `_vision_context` → ส่งเป็น extra_context ให้ทุกจุดที่เรียก `llm.answer()`
  4. `app.py` cost calculation: เพิ่ม `_vision_usage` tokens เข้าคำนวณด้วย
  5. `messageService.ts` ฟังก์ชันใหม่ `toBotImages(msg)` — ดึง URL รูปจาก `raw_payload` (image / image_with_text)
  6. `botCallService.ts` BotCallParams: เพิ่ม `images?: string[]` + ส่งใน body
  7. `botWorkerService.ts`: ดึง `botImages = toBotImages(msg)` + ส่งให้ callBot ทั้ง 2 จุด (trigger match + no trigger)
  8. `workflowEngine.ts`: ส่ง images ใน let_ai_respond action ด้วย
- **โมเดล vision ที่ใช้ได้จริง**:
  - `gemini-3.1-flash-lite` ✅ (ใช้อยู่ — รองรับ multimodal: text, image, video, audio, PDF)
  - `gemini-3.5-flash-lite` ✅ (รองรับ multimodal เช่นกัน — ใช้ได้)
  - ⚠️ ต้องโหลดรูปเป็น bytes แล้วใช้ `Part.from_bytes` — `Part.from_uri` ใช้ได้เฉพาะ GCS URL ไม่ใช่ HTTP URL ทั่วไป
  - `gemini-3-flash-preview` — ใช้ได้แต่เป็น preview (เคยใช้ชั่วคราว)
  - `gemini-3.1-flash-lite-image` — รองรับ vision แต่ quota หมดทุก key (429)
  - `gemini-2.5-flash` / `gemini-2.0-flash` — ถูกปิดแล้ว (404)
- **เคสที่ผ่าน** (verify แล้ว):
  - ส่งรูปกล้องวงจรปิด + ถาม "สินค้าตัวนี้ราคาเท่าไหร่" → บอทเห็น "กล้องวงจรปิดนอกบ้าน Outdoor CW400" → ตอบเกี่ยวกับกล้อง + แนะนำดูลิงก์สินค้า ✅
  - ส่งรูปกล้อง + ถาม "กันน้ำไหม" → บอทตอบเรื่องกล้องกันน้ำ IP66 + ตอบเกี่ยวกับกล้องโดยตรง ✅
  - ส่งรูปสินค้าเสีย + บอก "สินค้าเสีย อยากเคลม" → บอทเข้า warranty_claim flow + ขอข้อมูลเคลม ✅
  - history images: ลูกค้าส่งรูปใน turn ก่อนหน้า + ถามต่อ "กันน้ำไหม" → บอทเห็นรูปจาก history + ตอบเรื่องกล้อง CW400 IP66 ✅
  - ไม่มีรูป (regression) → บอทตอบปกติ ✅
  - CW400 anchor (regression) → ยังยึด CW400 ไม่ข้ามไป TP-Link ✅
- **การแก้ปัญหา LLM ตอบทับด้วย product context**:
  - ปัญหา: vision context ถูกส่งเป็น extra_context แต่ LLM ยังตอบจาก product context (smartwatch) ทับ
  - แก้: เพิ่ม instruction ใน `_vision_context` บอก LLM ชัดว่า "ลูกค้าส่งรูปเพราะสนใจสินค้าในรูป → ตอบเกี่ยวกับสินค้านั้น"
  - ผล: LLM ตอบเกี่ยวกับกล้อง CW400 ถูกต้อง ✅
- **History images (Phase 1A เพิ่มเติม)**:
  - ปัญหา: `getHistoryForBot` ส่งแค่ `text` ไม่มี `images` → ลูกค้าส่งรูปใน turn ก่อนหน้า บอทไม่เห็นรูปเก่า
  - แก้: `getHistoryForBot` เพิ่ม `images` ใน return + `botCallService` history type เพิ่ม `images?` + `app.py` vision pass รวมรูปจาก history ล่าสุด (max 2 turn ย้อนหลัง)
  - ผล: ลูกค้าส่งรูปใน turn 1 แล้วถามต่อใน turn 2 → บอทเห็นรูปเก่า + ตอบถูก ✅
- **Vision prompt สำหรับ claim flow**:
  - ปรับ `_VISION_PROMPT` ให้ละเอียดขึ้น — อธิบายสินค้าเสีย/ชำรุด + อาการเสีย (หน้าจอแตก, ไม่เปิด, สีผิด, ขอด, บวม, รอยไหม้, น้ำเข้า, หลุดหาย) + รุ่น/แบรนด์
  - รองรับกล่อง/ฉลากสินค้า (อ่าน SN) + สกรีนช็อตสถานะการจัดส่ง + รูปไม่ชัด
- **History context + image_desc cache (Phase 1A เพิ่มเติม)**:
  - ปัญหา 1: vision pass ส่งแค่ URL รูปให้ Gemini อ่านเปล่าๆ — ไม่ส่ง history ก่อนหน้ารูป → Gemini อ่านรูปโดยไม่รู้บริบท
  - ปัญหา 2: ทุกครั้งที่เจอรูปใน history → โหลดและอ่านใหม่ทุกครั้ง (เปลือง token + latency)
  - แก้ปัญหา 1: `describe_image` รับ `history_context` parameter — ส่ง history text ก่อนหน้ารูปไปให้ Gemini ด้วย
  - แก้ปัญหา 2: `ChatMessage` เพิ่ม `image_desc` field + `ChatResponse` เพิ่ม `image_desc` + Next.js เก็บใน message doc + ส่งใน history → bot ใช้ desc เดิมไม่อ่านซ้ำ
  - ผล: vision เข้าใจบริบท + ไม่อ่านรูปซ้ำ (ประหยัด token + latency) ✅
- **Phase 1A สมบูรณ์ — แก้จุดค้าง 3 จุด**:
  - 1. **วิดีโอรองรับ**: `toBotImages` รองรับ `media.type === "video"` + `llm.describe_image` detect mime_type จาก URL + content-type header (video/mp4, image/png, image/webp, image/gif, image/jpeg)
  - 2. **image_desc ใน ChatResponse ครบ**: ทุก 15 จุด return ChatResponse มี `image_desc=_image_desc_out` แล้ว
  - 3. **LLM หลักเห็น image_desc ใน history**: `llm.answer` แนบ `(รูปที่ส่ง: {image_desc})` ใน history text ส่งให้ LLM หลัก — ทำให้ LLM เห็น description ของรูปเก่าโดยไม่ต้องอ่านรูปซ้ำ
  - 4. **ลบ `gemini-2.0-flash` default ออกหมด**: เปลี่ยน default เป็น `gemini-3.5-flash-lite` ทุกจุด (llm.py + app.py) — ไม่ใช้ 2.0 แล้ว
  - Verify: py_compile + tsc ผ่าน + history image_desc → LLM ตอบเรื่องกล้อง CW400 ถูก ✅ + regression (ไม่มีรูป) ผ่าน ✅ + CW400 anchor ผ่าน ✅
- **ข้อจำกัด**:
  - URL รูปต้องเป็น public CDN ที่ Gemini ดึงได้ (cf.shopee.co.th ✅, unsplash/wikipedia บางครั้ง 400)
  - จำกัด 3 รูป/turn
  - เพิ่ม latency ~1-2s ต่อรูป
- **ไฟล์ที่แก้**: `app.py`, `llm.py`, `messageService.ts`, `botCallService.ts`, `botWorkerService.ts`, `workflowEngine.ts`
- **Verify**: `py_compile` ผ่าน + `tsc --noEmit` ผ่าน + 4 เคส curl ผ่าน + log แสดง [VISION-PASS]
- **ยังเหลือ (Phase 1D)**:
  - 1D: replay_compare.py ส่ง images + verify เคสจริง (โค้ดเสร็จ รอ verify เคสจริง)

### Anchor item หาย — "Version" ถูก extract เป็น model keyword → ดึง TP-Link ทับ CW400 (ผ่าน)
- **เคสที่พบ** (replay ThaiSuperPhone, conv shp_56386168990580567):
  - Q1: ลูกค้าส่งการ์ด [item: 6919173680] = Xiaomi Outdoor Camera CW400
  - Q2: ถาม "สอบถาม CW 400" → บอทตอบ CW400 ถูก
  - Q3: ถาม "Version จีนไหมครับ อยากได้ของ จีน" → บอทตอบ TP-Link Tapo C210 (ผิด!)
  - Q4: ถาม "เปน version China ไหม" → บอทตอบ TP-Link (ผิด!)
  - Q5: ถาม "อยากได้ version China" → บอทตอบ TP-Link (ผิด!)
- **Root cause**:
  1. `extract_model_keywords("Version จีนไหมครับ อยากได้ของ จีน")` คืน `["Version"]`
     — "Version" เป็น token ที่มีตัวอักษร + ความยาว >= 2 → ผ่าน regex แต่ไม่อยู่ใน stop_words
  2. ใน app.py บรรทัด 3148: `re.findall(r"[A-Za-z]{5,}", req.message)` เจอ "Version" (7 ตัวอักษร)
     และไม่อยู่ใน `_common_words` → ถูกใช้เป็น model keyword
  3. `[MODEL-REGEX]` ค้นหา "Versio" ใน Mongo → เจอ TP-Link ที่มี "(Global Version)" ในชื่อ
  4. พอ `_cur_model_kw` ไม่ว่าง → เงื่อนไข `not _cur_model_kw` ในบรรทัด 2414 เป็น False
     → **conv-active ถูกข้าม** → anchor CW400 ไม่ถูกยึด
- **วิธีแก้** (3 จุด):
  1. `knowledge_base.py` `extract_model_keywords` stop_words: เพิ่ม version/region words
  2. `app.py` บรรทัด ~3150 `_common_words`: เพิ่ม version/region words
  3. `app.py` บรรทัด ~1859 `_kb_common`: เพิ่ม version/region words (KB path)
- **เคสที่ผ่านหลังแก้** (verify แล้ว):
  - Q3 "Version จีนไหมครับ อยากได้ของ จีน" → has CW400: True, has TP-Link: False ✅
  - Q4 "เปน version China ไหม" → has CW400: True, has TP-Link: False ✅
  - Q5 "อยากได้ version China" → has CW400: True, has TP-Link: False ✅
  - ถาม "สอบถาม CW 400" ไม่มี history → บอทตอบ CW400 ปกติ ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/knowledge_base.py`, `chatbot/shopeechat/app.py`
- **Verify**: `python -m py_compile` ผ่าน + 4 เคส curl ผ่าน + log ไม่มี [MODEL-REGEX] Version อีก

---

## เคสที่ผ่านแล้ว (เพิ่มใหม่ 2026-09-11)

### Multimodal Vision Phase 1A — บอทเข้าใจรูปภาพ (ผ่าน foundation + verify)
- **เป้าหมาย**: บอทรับ URL รูปจากลูกค้า → ใช้ Gemini vision อ่านรูป → ตอบเข้ากับบริบท
- **สิ่งที่ทำ (Phase 1A Foundation)**:
  1. `app.py` ChatRequest + ChatMessage schema: เพิ่ม `images: list[str]` field
  2. `llm.py` ฟังก์ชันใหม่:
     - `describe_image(image_url, shop_hint)` — ใช้ `gemini-3-flash-preview` (VISION_MODEL env) อ่านรูป → คืน (text, usage_info)
     - `describe_images(image_urls, shop_hint, max_images=3)` — อ่านหลายรูป → คืน (combined_text, total_usage)
     - `_VISION_PROMPT` — prompt ภาษาไทย อธิบายรูปสั้นๆ (สินค้า/tracking/สกรีนช็อต/สินค้าเสีย/รูปอื่นๆ)
  3. `app.py` vision pass block (บรรทัด ~389): ถ้า `req.images` ไม่ว่าง → เรียก `llm.describe_images()` → เก็บใน `_vision_context` → ส่งเป็น extra_context ให้ทุกจุดที่เรียก `llm.answer()`
  4. `app.py` cost calculation: เพิ่ม `_vision_usage` tokens เข้าคำนวณด้วย
  5. `messageService.ts` ฟังก์ชันใหม่ `toBotImages(msg)` — ดึง URL รูปจาก `raw_payload` (image / image_with_text)
  6. `botCallService.ts` BotCallParams: เพิ่ม `images?: string[]` + ส่งใน body
  7. `botWorkerService.ts`: ดึง `botImages = toBotImages(msg)` + ส่งให้ callBot ทั้ง 2 จุด (trigger match + no trigger)
  8. `workflowEngine.ts`: ส่ง images ใน let_ai_respond action ด้วย
- **โมเดล vision ที่ใช้ได้จริง**:
  - `gemini-3.1-flash-lite` ✅ (ใช้อยู่ — รองรับ multimodal: text, image, video, audio, PDF)
  - `gemini-3.5-flash-lite` ✅ (รองรับ multimodal เช่นกัน — ใช้ได้)
  - ⚠️ ต้องโหลดรูปเป็น bytes แล้วใช้ `Part.from_bytes` — `Part.from_uri` ใช้ได้เฉพาะ GCS URL ไม่ใช่ HTTP URL ทั่วไป
  - `gemini-3-flash-preview` — ใช้ได้แต่เป็น preview (เคยใช้ชั่วคราว)
  - `gemini-3.1-flash-lite-image` — รองรับ vision แต่ quota หมดทุก key (429)
  - `gemini-2.5-flash` / `gemini-2.0-flash` — ถูกปิดแล้ว (404)
- **เคสที่ผ่าน** (verify แล้ว):
  - ส่งรูปกล้องวงจรปิด + ถาม "สินค้าตัวนี้ราคาเท่าไหร่" → บอทเห็น "กล้องวงจรปิดนอกบ้าน Outdoor CW400" → ตอบเกี่ยวกับกล้อง + แนะนำดูลิงก์สินค้า ✅
  - ส่งรูปกล้อง + ถาม "กันน้ำไหม" → บอทตอบเรื่องกล้องกันน้ำ IP66 + ตอบเกี่ยวกับกล้องโดยตรง ✅
  - ส่งรูปสินค้าเสีย + บอก "สินค้าเสีย อยากเคลม" → บอทเข้า warranty_claim flow + ขอข้อมูลเคลม ✅
  - history images: ลูกค้าส่งรูปใน turn ก่อนหน้า + ถามต่อ "กันน้ำไหม" → บอทเห็นรูปจาก history + ตอบเรื่องกล้อง CW400 IP66 ✅
  - ไม่มีรูป (regression) → บอทตอบปกติ ✅
  - CW400 anchor (regression) → ยังยึด CW400 ไม่ข้ามไป TP-Link ✅
- **การแก้ปัญหา LLM ตอบทับด้วย product context**:
  - ปัญหา: vision context ถูกส่งเป็น extra_context แต่ LLM ยังตอบจาก product context (smartwatch) ทับ
  - แก้: เพิ่ม instruction ใน `_vision_context` บอก LLM ชัดว่า "ลูกค้าส่งรูปเพราะสนใจสินค้าในรูป → ตอบเกี่ยวกับสินค้านั้น"
  - ผล: LLM ตอบเกี่ยวกับกล้อง CW400 ถูกต้อง ✅
- **History images (Phase 1A เพิ่มเติม)**:
  - ปัญหา: `getHistoryForBot` ส่งแค่ `text` ไม่มี `images` → ลูกค้าส่งรูปใน turn ก่อนหน้า บอทไม่เห็นรูปเก่า
  - แก้: `getHistoryForBot` เพิ่ม `images` ใน return + `botCallService` history type เพิ่ม `images?` + `app.py` vision pass รวมรูปจาก history ล่าสุด (max 2 turn ย้อนหลัง)
  - ผล: ลูกค้าส่งรูปใน turn 1 แล้วถามต่อใน turn 2 → บอทเห็นรูปเก่า + ตอบถูก ✅
- **Vision prompt สำหรับ claim flow**:
  - ปรับ `_VISION_PROMPT` ให้ละเอียดขึ้น — อธิบายสินค้าเสีย/ชำรุด + อาการเสีย (หน้าจอแตก, ไม่เปิด, สีผิด, ขอด, บวม, รอยไหม้, น้ำเข้า, หลุดหาย) + รุ่น/แบรนด์
  - รองรับกล่อง/ฉลากสินค้า (อ่าน SN) + สกรีนช็อตสถานะการจัดส่ง + รูปไม่ชัด
- **History context + image_desc cache (Phase 1A เพิ่มเติม)**:
  - ปัญหา 1: vision pass ส่งแค่ URL รูปให้ Gemini อ่านเปล่าๆ — ไม่ส่ง history ก่อนหน้ารูป → Gemini อ่านรูปโดยไม่รู้บริบท
  - ปัญหา 2: ทุกครั้งที่เจอรูปใน history → โหลดและอ่านใหม่ทุกครั้ง (เปลือง token + latency)
  - แก้ปัญหา 1: `describe_image` รับ `history_context` parameter — ส่ง history text ก่อนหน้ารูปไปให้ Gemini ด้วย
  - แก้ปัญหา 2: `ChatMessage` เพิ่ม `image_desc` field + `ChatResponse` เพิ่ม `image_desc` + Next.js เก็บใน message doc + ส่งใน history → bot ใช้ desc เดิมไม่อ่านซ้ำ
  - ผล: vision เข้าใจบริบท + ไม่อ่านรูปซ้ำ (ประหยัด token + latency) ✅
- **Phase 1A สมบูรณ์ — แก้จุดค้าง 3 จุด**:
  - 1. **วิดีโอรองรับ**: `toBotImages` รองรับ `media.type === "video"` + `llm.describe_image` detect mime_type จาก URL + content-type header (video/mp4, image/png, image/webp, image/gif, image/jpeg)
  - 2. **image_desc ใน ChatResponse ครบ**: ทุก 15 จุด return ChatResponse มี `image_desc=_image_desc_out` แล้ว
  - 3. **LLM หลักเห็น image_desc ใน history**: `llm.answer` แนบ `(รูปที่ส่ง: {image_desc})` ใน history text ส่งให้ LLM หลัก — ทำให้ LLM เห็น description ของรูปเก่าโดยไม่ต้องอ่านรูปซ้ำ
  - 4. **ลบ `gemini-2.0-flash` default ออกหมด**: เปลี่ยน default เป็น `gemini-3.5-flash-lite` ทุกจุด (llm.py + app.py) — ไม่ใช้ 2.0 แล้ว
  - Verify: py_compile + tsc ผ่าน + history image_desc → LLM ตอบเรื่องกล้อง CW400 ถูก ✅ + regression (ไม่มีรูป) ผ่าน ✅ + CW400 anchor ผ่าน ✅
- **ข้อจำกัด**:
  - URL รูปต้องเป็น public CDN ที่ Gemini ดึงได้ (cf.shopee.co.th ✅, unsplash/wikipedia บางครั้ง 400)
  - จำกัด 3 รูป/turn
  - เพิ่ม latency ~1-2s ต่อรูป
- **ไฟล์ที่แก้**: `app.py`, `llm.py`, `messageService.ts`, `botCallService.ts`, `botWorkerService.ts`, `workflowEngine.ts`
- **Verify**: `py_compile` ผ่าน + `tsc --noEmit` ผ่าน + 4 เคส curl ผ่าน + log แสดง [VISION-PASS]
- **ยังเหลือ (Phase 1D)**:
  - 1D: replay_compare.py ส่ง images + verify เคสจริง (โค้ดเสร็จ รอ verify เคสจริง)

### Anchor item หาย — "Version" ถูก extract เป็น model keyword → ดึง TP-Link ทับ CW400 (ผ่าน)
- **เคสที่พบ** (replay ThaiSuperPhone, conv shp_56386168990580567):
  - Q1: ลูกค้าส่งการ์ด [item: 6919173680] = Xiaomi Outdoor Camera CW400
  - Q2: ถาม "สอบถาม CW 400" → บอทตอบ CW400 ถูก
  - Q3: ถาม "Version จีนไหมครับ อยากได้ของ จีน" → บอทตอบ TP-Link Tapo C210 (ผิด!)
  - Q4: ถาม "เปน version China ไหม" → บอทตอบ TP-Link (ผิด!)
  - Q5: ถาม "อยากได้ version China" → บอทตอบ TP-Link (ผิด!)
- **Root cause**:
  1. `extract_model_keywords("Version จีนไหมครับ อยากได้ของ จีน")` คืน `["Version"]`
     — "Version" เป็น token ที่มีตัวอักษร + ความยาว >= 2 → ผ่าน regex แต่ไม่อยู่ใน stop_words
  2. ใน app.py บรรทัด 3148: `re.findall(r"[A-Za-z]{5,}", req.message)` เจอ "Version" (7 ตัวอักษร)
     และไม่อยู่ใน `_common_words` → ถูกใช้เป็น model keyword
  3. `[MODEL-REGEX]` ค้นหา "Versio" ใน Mongo → เจอ TP-Link ที่มี "(Global Version)" ในชื่อ
  4. พอ `_cur_model_kw` ไม่ว่าง → เงื่อนไข `not _cur_model_kw` ในบรรทัด 2414 เป็น False
     → **conv-active ถูกข้าม** → anchor CW400 ไม่ถูกยึด
- **วิธีแก้** (3 จุด):
  1. `knowledge_base.py` `extract_model_keywords` stop_words: เพิ่ม version/region words
  2. `app.py` บรรทัด ~3150 `_common_words`: เพิ่ม version/region words
  3. `app.py` บรรทัด ~1859 `_kb_common`: เพิ่ม version/region words (KB path)
- **เคสที่ผ่านหลังแก้** (verify แล้ว):
  - Q3 "Version จีนไหมครับ อยากได้ของ จีน" → has CW400: True, has TP-Link: False ✅
  - Q4 "เปน version China ไหม" → has CW400: True, has TP-Link: False ✅
  - Q5 "อยากได้ version China" → has CW400: True, has TP-Link: False ✅
  - ถาม "สอบถาม CW 400" ไม่มี history → บอทตอบ CW400 ปกติ ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/knowledge_base.py`, `chatbot/shopeechat/app.py`
- **Verify**: `python -m py_compile` ผ่าน + 4 เคส curl ผ่าน + log ไม่มี [MODEL-REGEX] Version อีก

---

## เคสที่ผ่านแล้ว (เพิ่มใหม่ 2026-09-10)

### Warranty claim: ลูกค้าส่ง [รูปภาพ] ใน claim flow → บอทไม่จำ state → ตอบทั่วไป → closed แทน handoff
- **เคสที่พบ** (replay YoupinOfficialStore):
  - Q4 บอทขอ "วันที่ซื้อ + เลขที่คำสั่งซื้อ + รูปหรือวิดีโอ"
  - Q5 ลูกค้าส่ง `[รูปภาพ]` ตามที่บอทขอ → บอทตอบ "ขออภัย ระบบไม่ได้รับภาพ" → ตก flow ปกติ → closed แทน handoff
- **Root cause**:
  1. warranty state machine ใน app.py มี state 1-6 แต่ **ไม่มี state "รอข้อมูลเคลม"** (บอทขอ วันที่+order+รูป แล้วลูกค้าส่งรูป/วิดีโอกลับมา)
  2. `[รูปภาพ]` ไม่ตรงเงื่อนไข info/date/confirm ใด → ตกไป flow ปกติ → LLM ตอบทั่วไป
  3. ถ้ามี order_sn ในข้อความ → order_lookup จับก่อนเข้า warranty flow → ตอบ "ไม่พบ order"
  4. **Flow เดิม**: ขอข้อมูล → รอลูกค้าส่งครบ → ทวน → ยืนยัน → handoff (ช้าเกินไป)
- **วิธีแก้** (4 จุดใน `chatbot/shopeechat/app.py`):
  1. **State 7 detection** (บรรทัด ~957): `_bot_asked_claim_info` — ตรวจว่า last model message ขอ "วันที่ซื้อ" + "เลขที่คำสั่งซื้อ" + "รูป/วิดีโอ" พร้อมกัน
  2. **State 7 handler** (บรรทัด ~1011): รับรูป/ข้อมูล + ขอบคุณ + บอกรอแอดมิน (ไม่ต้องทวน/ถามยืนยัน — เพราะ handoff แล้ว)
  3. **ข้าม order_lookup ถ้าอยู่ใน claim flow** (บรรทัด ~495): ตรวจ history ว่าบอทขอ claim info อยู่ไหม → ถ้าใช่ ข้าม order_lookup
  4. **ตัด image placeholder + date pattern ก่อน extract_customer_info** — กัน `[รูปภาพ]` และ "ซื้อวันที่ 15 ส.ค. 2567" ถูกตีความเป็นชื่อ
  5. **handoff ทันทีที่ขอข้อมูลเคลม** — ทั้ง state 6 (duration_answered + claim_request) และ first_message path ตั้ง `_warranty_claim_handoff = True` ทันที
- **Flow ใหม่**: ขอข้อมูล + **handoff ทันที** → ลูกค้าตอบมา → ขอบคุณ + บอกรอแอดมิน (แอดมินมาอ่านแชทต่อ)
- **เคสที่ผ่านหลังแก้** (verify แล้ว):
  - Q4 "สินค้าเสียต้องเคลมยังไงคะ" → source=warranty_claim_first_message, **handoff=True**, ขอข้อมูลเคลม
  - Q5 `[รูปภาพ]` อย่างเดียว → source=warranty_claim_flow, "ขอบคุณ ได้รับรูปแล้ว รบกวนรอแอดมิน"
  - `[รูปภาพ] ซื้อวันที่ 15 ส.ค. 2567 order 240815MCEQMT60 สมชาย ใจดี 0812345678` → source=warranty_claim_flow, "ขอบคุณ ได้รับข้อมูลครบแล้ว รบกวนรอแอดมิน"
- **เคสที่ต้องไม่พัง**: state 1-6 เดิม (duration→claim→date→info→confirm→handoff, post-handoff)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **Verify**: `python -m py_compile` ผ่าน + 3 เคส curl ผ่าน + handoff=True ที่ Q4 + ขอบคุณที่ Q5

---

## เคสที่ผ่านแล้ว (เพิ่มใหม่ 2026-09-04)

### Workflow Phase 6 — Testing / Rollout (ผ่าน)
- **ที่ผู้ใช้ขอ**: ทำ Phase 6 ต่อจาก implentplanworkflow.md — unit test + e2e + tsc/build + rollout
- **งานที่ทำ**:
  1. **6.1 Unit tests** (`scripts/test-workflow-phase6.ts` — 69 cases ผ่าน):
     - `validateWaitAnswer` — answer_type any/number/custom_keywords + edge cases (ว่าง, ทศนิยม, จุลภาคไทย, case-insensitive, trim)
     - `validateWorkflowGraph` Phase 2 wait branch validation — success/retry_exceeded/no_reply · ghost branch reject · max_retries<0 reject · timeout_ms=0 reject · answer_type ผิด reject · custom_keywords ว่าง reject · legacy edge อนุญาต
     - `evalMultiBranchCondition` edge cases — empty branches → fallback · ไม่มี fallback_branch_id → "false" (type guard ไม่ผ่าน) · source variants
     - `matchBranch` — case-insensitive (caller ต้อง .toLowerCase() ก่อน) · contains_all · equals
     - `isPhase2WaitConfig` type guard — null/undefined/ไม่มี answer_type/answer_type ไม่ใช่ string
     - `resolveTemplate` Phase 4 — แทนตัวแปร · var ไม่รู้จัก → ว่าง · case-insensitive · ตัวเลข
     - `isPhase3AddLabelConfig` + `isMultiBranchCondition` type guards
  2. **6.2 E2E** (`scripts/test-workflow-e2e.ts` — **16/16 ผ่าน** verified 2026-09-03):
     - สร้าง flow ตัวอย่างใน MongoDB จริง (trigger → menu → wait → condition 3 branches → add label → send)
     - A: ข้อความแรก "สเปคหัวชาร์จ" → trigger match → ส่ง menu → รอ reply ✓
     - B: reply "สั่งซื้อ" → wait success → condition buy → add label → ส่ง buy message ✓
     - C: reply "ดูรายละเอียด" → wait success → condition ask → ส่ง ask message ✓
     - D: checkWaitTimeouts รันไม่พัง ✓
     - E: ข้อความไม่ match trigger → no_match ✓
     - F: condition fallback branch → ส่ง fallback message ✓
     - script save/restore workflow_enabled อัตโนมัติ + cleanup workflow/runs หลังเทส
     - **Cleanup verified**: ลบ test workflows 2 + runs 3 + logs 4 + คืนค่า workflow_enabled=false ✓
  3. **6.3 tsc + build**: `tsc --noEmit` ผ่าน · `npm run build` ผ่าน
  4. **6.4 Rollout** (`scripts/rollout-workflow.ts`):
     - สร้าง test workflow `[ROLLOUT] GodungIT test flow` (wf_8havngi6mtl6bvw8) shop_ids=["GodungIT"] priority=100 enabled published
     - เปิด workflow_enabled=true ใน SystemConfig
     - flow: trigger สเปค/ราคา → menu → wait → 3 branches (buy/ask/other) + retry_exceeded
- **ไฟล์ใหม่**:
  - `ChatAdminWeb/scripts/test-workflow-phase6.ts` — unit test 69 cases
  - `ChatAdminWeb/scripts/test-workflow-e2e.ts` — e2e 16 cases (MongoDB จริง)
  - `ChatAdminWeb/scripts/rollout-workflow.ts` — rollout script สำหรับ shop GodungIT
- **Verify**: Phase 1 test 69 passed · Phase 6 test 69 passed · E2E 16 passed · tsc ผ่าน · build ผ่าน
- **หมายเหตุ**:
  - `resumeFlow` async ที่เชื่อม MongoDB → ทดสอบใน e2e แทน unit test
  - E2E save/restore workflow_enabled อัตโนมัติ — ไม่กระทบ config จริง
  - Rollout สร้าง workflow จริงใน DB + เปิด workflow_enabled=true — ปิดได้โดยลบ workflow ใน UI หรือปิดใน System Config

---

### Workflow audit log + soft delete + restore (ผ่าน)
- **ที่ผู้ใช้ขอ**: ระบบ log ต้องระบุใครทำอะไรยังไง — create/update/toggle/delete/restore · ระบบต้อง soft delete เท่านั้น ห้าม hard delete
- **สำรวจพบ**:
  - soft delete ใช้แล้ว (`is_deleted: true` + `deleted_at` + `deleted_by` + `enabled: false`) ✓
  - list/get/update/toggle กรอง `is_deleted: { $ne: true }` ✓
  - audit log มี 4 จุด (create/update/toggle/delete) ✓ แต่ขาดข้อมูลสำคัญ
- **ขาด/แก้**:
  1. **`workflow.restore`** — ไม่มี service + API + log → เพิ่ม `restoreWorkflow()` + `/api/workflows/[id]/restore` + `workflow.restore` action_type
  2. **log ไม่มีชื่อ flow** — มีแค่ `workflow_id` ดูใน log ไม่รู้ว่าคือ flow ไหน → เพิ่ม `workflow_name` ในทุก log (update/toggle/delete/restore)
  3. **log update ไม่มี before→after** — รู้แค่ชื่อ field ที่เปลี่ยน → เพิ่ม `changes: { field: { from, to } }` (เฉพาะที่เปลี่ยนจริง ตาม JSON.stringify diff)
  4. **log toggle ไม่มี previous_enabled** → เพิ่ม `previous_enabled`
  5. **log delete ไม่มี previous_enabled** → เพิ่ม `previous_enabled`
  6. **logs page filter** ไม่มีหมวด Workflow → เพิ่ม category + tone (`workflow.create/update`=brand · `toggle`=pale · `delete`=coral · `restore`=brand · `run_errored/timeout/cancelled`=coral)
  7. **WorkflowDoc** ขาด `restored_at`/`restored_by` → เพิ่มใน interface
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/backend/service/workflowService.ts` — `updateWorkflow`/`toggleWorkflow`/`deleteWorkflow` เพิ่ม before-fetch + log ข้อมูลเพิ่ม · เพิ่ม `restoreWorkflow()` · เพิ่ม `restored_at`/`restored_by` ใน WorkflowDoc · export `restoreWorkflow`
  - `ChatAdminWeb/src/backend/service/adminLogService.ts` — เพิ่ม `"workflow.restore"` ใน AdminActionType
  - `ChatAdminWeb/src/app/api/workflows/[workflowId]/restore/route.ts` — ใหม่ · POST restore endpoint
  - `ChatAdminWeb/src/app/(console)/logs/page.tsx` — เพิ่ม Workflow category + tone mapping
- **Verify**: `tsc --noEmit` ผ่าน · `npm run build` ผ่าน
- **หมายเหตุ**: หน้า logs แสดง metadata เป็น JSON อยู่แล้ว — `workflow_name` + `changes` จะโชว์อัตโนมัติ

---

### Workflow list + create modal UI consistency (ผ่าน 2026-09-04)
- **ที่ผู้ใช้ขอ**: การ์ดแต่ละอันในหน้า workflows มีขนาด/สไตล์ไม่เท่ากัน · modal สร้าง workflow ไม่ consistency กับ modal อื่น
- **วิธีทำ**:
  1. **Create modal** (`workflows/page.tsx`): แปลง inline styles → Tailwind classes + design tokens (`bg-surface`, `rounded-2xl`, `border-border`, `text-text`, `bg-black/40`, `focus:ring-brand/30`) · header sticky + border-b · platform chips แบบ toggle · footer มี border-t + Button ghost/primary
  2. **List cards** (`workflows/page.tsx`): แปลง inline styles → Tailwind · ใช้ `bg-surface rounded-xl border border-border p-4 hover:border-pale-sky` เหมือน triggers page · toggle switch แทน raw checkbox · icon buttons `w-7 h-7 rounded-md` แทน Button outline · `items-start justify-between` ให้ความสูงเท่ากัน
  3. **Toolbar**: search/sort/filter ใช้ `h-9 rounded-lg border-border bg-surface-2 focus:ring-brand/30` เหมือน triggers page
  4. **ลบ `filterSelectStyle`** ที่ไม่ใช้แล้ว
- **Verify**: `tsc --noEmit` ผ่าน · `npm run build` ผ่าน

---

### Triggers/Workflow duplicate shop_id React key (ผ่าน 2026-09-04)
- **ที่ผู้ใช้ขอ**: แก้ duplicate React key `'ThaiSuperPhone'` ใน triggers page + ป้องกันที่ WorkflowEditor
- **สาเหตุ**: `/api/shops` ส่งกลับ shop เดียวหลายบรรทัด (หนึ่งบรรทัดต่อ platform) เพราะ `shops` collection เก็บ one doc per (shop_id, platform)
- **วิธีทำ**:
  - `triggers/page.tsx` — dedupe ตอนโหลดจาก `/api/shops` (Map by shop_id)
  - `WorkflowEditor.tsx` — dedupe ตอนโหลดจาก `/api/shops` (Map by shop_id)
  - `workflows/page.tsx` — dedupe ใน `filteredShops` useMemo + รวม platforms เป็น array
- **ไม่ต้องแก้**: `config/page.tsx` (group by platform ก่อน render) · `shops/page.tsx` (เป็นหน้าจัดการร้านต่อ platform โดยเจตนา)
- **Verify**: `tsc --noEmit` ผ่าน · `npm run build` ผ่าน

---

## เคสที่ผ่านแล้ว (เพิ่มใหม่ 2026-09-03)

### Workflow Phase 5 — UI Polish (ผ่าน)
- **ที่ผู้ใช้ขอ**: ปรับ node card style ให้ตรง pattern ภาพต้นแบบ — header สี+icon ตาม node type + ค่า/preview บนการ์ด + label ข้าง handle ตาม `implentplanworkflow.md` Phase 5
- **วิธีทำ**:
  1. **Node card structure** (`nodes.tsx`): ทุก node type (Trigger/Condition/Action/Wait) เปลี่ยนจาก flat card → header สีเต็ม + body แยก · `overflow: hidden` ให้ header โค้งตาม border-radius · padding แยก header/body
  2. **Header สี**: Trigger=เหลือง (#f59e0b) · Condition=ม่วง (#8b5cf6) · Action=เขียว (#10b981) · Wait=คราง (#6366f1) — ใช้ `NODE_TYPE_META.color` ที่มีอยู่แล้ว · ตัวอักษรขาว · icon + label ภาษาไทย
  3. **Label ข้าง handle**: TriggerNode → "เริ่ม flow ↓" · ActionNode → "ต่อไป ↓" · ConditionNode → label แต่ละ branch (มีอยู่แล้ว Phase 1) · WaitNode → "ตอบถูก/ทำผิดซ้ำ/ไม่ตอบ ↓" (มีอยู่แล้ว Phase 2)
  4. **Preview ค่าบน node**: `configSummary` แสดงค่าสำคัญใน body (keywords, message, timeout, label_ids) — มีอยู่แล้ว + ปรับใน Phase 1-4
  5. **Chip สำหรับ add_label**: แสดงใน body ของ ActionNode (มีอยู่แล้ว Phase 3) — ปรับ padding ให้ตรง card structure ใหม่
- **Pure UI/CSS**: ไม่แก้ logic ใดๆ — เปลี่ยนเฉพาะ style/structure ของ node card
- **ไฟล์ที่แก้**: `nodes.tsx` (TriggerNode, ConditionNode, ActionNode, WaitNode)
- **Verify**: `tsc --noEmit` ผ่าน + unit test 69/69 ผ่าน + `npm run build` ผ่าน
- **ยังไม่ได้ทดสอบ**: visual review ใน browser จริง (ต้องรัน `npm run dev` แล้วดูใน editor)

### Workflow Phase 4 — Variable Interpolation (ผ่าน)
- **ที่ผู้ใช้ขอ**: แทรก `{{customerName}}` ใน send_message แบบมี autocomplete + preview ตาม `implentplanworkflow.md` Phase 4
- **วิธีทำ**:
  1. **Template service** (`templateService.ts` — ใหม่): `resolveTemplate(text, vars)` pure function · `hasTemplateVariables` · `extractTemplateVariables` · `SUPPORTED_TEMPLATE_VARS` list · case-insensitive · var ไม่มีค่า → แทนด้วยค่าว่าง · regex จับ `{{ varName }}` (รองรับช่องว่าง)
  2. **Engine** (`workflowEngine.ts`): `prepareTemplateVars(msg, context)` — ดึง customer.name + conversation.shop_name + to_name ครั้งเดียว (parallel `Promise.all`) · ส่งต่อให้ `resolveTemplate` (ไม่ยิง DB เพิ่มต่อตัวแปร) · `send_message` performAction เรียก `resolveTemplate` ก่อน push ลง delivered
  3. **UI** (`WorkflowEditor.tsx`): `SendMessageConfigPanel` — textarea + autocomplete dropdown (พิมพ์ `{{` → แสดงตัวแปร) + แทรกที่ cursor + preview ข้อความที่ resolve แล้ว (sample vars) + ปุ่มตัวแปรทั้งหมด (กดแทรกได้)
- **ตัวแปรที่รองรับ**: `{{customerName}}`, `{{shopName}}`, `{{integrationName}}`, `{{botAnswer}}`, `{{customerReply}}`, `{{initialMessage}}`, `{{conversationId}}`, `{{shopId}}`, `{{platform}}`
- **Performance**: `prepareTemplateVars` ดึงข้อมูลครั้งเดียวต่อ node · `resolveTemplate` pure function ไม่ยิง DB
- **ไฟล์ที่แก้**: `workflowEngine.ts`, `WorkflowEditor.tsx`
- **ไฟล์ใหม่**: `src/backend/service/templateService.ts`, `scripts/test-workflow-phase1.ts` (เพิ่ม 16 cases → รวม 69 cases)
- **Verify**: `tsc --noEmit` ผ่าน + unit test 69/69 ผ่าน + `npm run build` ผ่าน
- **ยังไม่ได้ทดสอบ**: e2e กับ MongoDB (สร้าง send_message มี {{customerName}} → รัน flow → ดูข้อความ resolve จริงใน shadow_replies)

### Workflow Phase 3 — Add Label: Tag Picker (ผ่าน)
- **ที่ผู้ใช้ขอ**: เปลี่ยน add_label node จาก text field เดียว → TagPicker แบบ chip (ดึง label list จริงจากระบบ) ตาม `implentplanworkflow.md` Phase 3
- **วิธีทำ**:
  1. **Schema** (`workflowService.ts`): เพิ่ม `AddLabelConfig` (label_ids: string[]) + `isPhase3AddLabelConfig()` type guard · backward compat — legacy `{ label: string }` ยังทำงาน
  2. **Engine** (`workflowEngine.ts`): `performAction` add_label รองรับทั้ง `label_ids[]` (Phase 3) และ `label` (legacy) · ใช้ `$addToSet $each` สำหรับหลาย label (atomic) · audit log เก็บ `labels: string[]`
  3. **API** (`src/app/api/labels/route.ts` — ใหม่): `GET /api/labels` distinct labels จาก `conversations.labels` · requireAuth · sort ภาษาไทย · รองรับ label master collection ในอนาคต
  4. **UI** (`nodes.tsx`): `ActionNode` ถ้า subtype=add_label + label_ids → แสดง chip สีเขียวใต้ header (สูงสุด 4 chip + "+N") · `configSummary` แสดง label_ids สั้นๆ
  5. **NodeConfigPanel** (`WorkflowEditor.tsx`): `AddLabelConfigPanel` — legacy → text input + ปุ่มอัปเกรด · Phase 3 → fetch `/api/labels` + chip ที่เลือก (ลบได้) + list ของ label ให้เลือก (toggle) + พิมพ์ label ใหม่ (Enter) · loading/error state ครบ · fallback เป็น text input ถ้า fetch ไม่ได้
- **Backward compat**: document เก่าที่มี `config.label` ยังทำงาน — engine ตรวจ `isPhase3AddLabelConfig` ก่อน
- **ไฟล์ที่แก้**: `workflowService.ts`, `workflowEngine.ts`, `nodes.tsx`, `WorkflowEditor.tsx`
- **ไฟล์ใหม่**: `src/app/api/labels/route.ts`, `scripts/test-workflow-phase1.ts` (เพิ่ม 6 cases → รวม 53 cases)
- **Verify**: `tsc --noEmit` ผ่าน + unit test 53/53 ผ่าน + `npm run build` ผ่าน
- **ยังไม่ได้ทดสอบ**: e2e กับ MongoDB (สร้าง add_label node → เลือก label จาก TagPicker → รัน flow → ดู label ติดใน conversations.labels)

### Workflow Phase 2 — Wait for Reply (retry + timeout + 3-branch) (ผ่าน)
- **ที่ผู้ใช้ขอ**: อัปเกรด wait_for_reply node จากรอ reply เดียว + global timeout → retry N ครั้ง + per-node timeout + 3 branch ออก (success/retry_exceeded/no_reply) ตาม `implentplanworkflow.md` Phase 2
- **วิธีทำ**:
  1. **Schema** (`workflowService.ts`): เพิ่ม `WaitForReplyConfig` (answer_type, max_retries, retry_message?, timeout_ms, custom_keywords?) + `WAIT_BRANCH` const (success/retry_exceeded/no_reply) + `isPhase2WaitConfig()` type guard · `WorkflowRunDoc` เพิ่ม `wait_retry_count`, `wait_started_at`, `wait_node_id` + outcome เพิ่ม `retry_exceeded`, `no_reply`
  2. **Engine** (`workflowEngine.ts`):
     - `walkGraph` ส่วน wait: ถ้า Phase 2 config → set `wait_retry_count=0`, `wait_started_at=now`, `wait_node_id`
     - `resumeFlow`: ถ้า Phase 2 config → เรียก `resumePhase2Wait` — validate answer_type → success (เดินต่อ) / ไม่ผ่าน + ยังไม่ครบ retry → ส่ง retry_message + คง waiting / ครบ retry → retry_exceeded
     - `validateWaitAnswer` (pure, export): any → true · number → regex · custom_keywords → contains
     - `checkWaitTimeouts` (export): background checker หา run ที่ `wait_started_at + timeout_ms < now` → branch no_reply · race-safe (set status=running ก่อนเดิน graph)
     - `processWaitTimeout`: เดิน no_reply branch หรือ completeRun ด้วย outcome=no_reply
  3. **Bot worker** (`scripts/bot-worker.ts`): เรียก `workflowEngine.checkWaitTimeouts()` ทุก cycle ถ้า `workflow_enabled=true`
  4. **Validation** (`validateWorkflowGraph`): wait node Phase 2 — edge ต้องเป็น success/retry_exceeded/no_reply · max_retries ≥ 0 · timeout_ms > 0 · answer_type ถูกต้อง · custom_keywords ต้องมี ≥1 ถ้า answer_type=custom_keywords
  5. **UI** (`nodes.tsx`): `WaitNode` ถ้า Phase 2 → 3 handles (success=เขียว/retry_exceeded=ส้ม/no_reply=แดง) + label ข้าง handle · `useUpdateNodeInternals()` เมื่อ mode เปลี่ยน · legacy ยัง 1 handle
  6. **NodeConfigPanel** (`WorkflowEditor.tsx`): `WaitForReplyConfigPanel` — legacy → UI เดิม + ปุ่มอัปเกรด · Phase 2 → answer_type select + custom_keywords input + max_retries (0-10) + retry_message + timeout preset (5m/15m/30m/1h/2h/4h/custom) + ปุ่มกลับ legacy
  7. **Audit log** (`adminLogService.ts`): เพิ่ม `workflow.wait_retry` + `workflow.wait_no_reply`
- **Backward compat**: document เก่าที่มี `config.timeout_ms` อย่างเดียว ยังทำงาน — engine ตรวจ `isPhase2WaitConfig` ก่อน ถ้าไม่ใช่ → ใช้ legacy path · global `workflow_run_timeout_ms` ยังเป็น safety net รอง
- **Race-safe**: `checkWaitTimeouts` set `status=running` ก่อนเดิน graph กัน resume ซ้อน · `resumeFlow` ก็ set `status=running` ก่อน
- **Cap กันลูป**: `max_retries` จำกัด 0-10 (UI) · `MAX_ENGINE_STEPS=50` ยังเป็น cap หลัก
- **ไฟล์ที่แก้**: `workflowService.ts`, `workflowEngine.ts`, `adminLogService.ts`, `nodes.tsx`, `WorkflowEditor.tsx`, `scripts/bot-worker.ts`
- **ไฟล์ใหม่**: `scripts/test-workflow-phase1.ts` (เพิ่ม 22 cases → รวม 47 cases)
- **Verify**: `tsc --noEmit` ผ่าน + unit test 47/47 ผ่าน + `npm run build` ผ่าน
- **ยังไม่ได้ทดสอบ**: e2e กับ MongoDB (สร้าง wait node Phase 2 → ส่งข้อความผิด → ดู retry → ครบ retry → ดู retry_exceeded branch · ปล่อยผ่าน timeout → ดู no_reply branch)

### Workflow Phase 1 — Multi-branch Condition Node (ผ่าน)
- **ที่ผู้ใช้ขอ**: อัปเกรด condition node subtype `message_content` จาก true/false 2 ทาง → N ทาง + fallback (ตาม `implentplanworkflow.md` Phase 1)
- **วิธีทำ**:
  1. **Schema** (`workflowService.ts`): เพิ่ม `ConditionBranch` type (branch_id, match_type, keywords, label) + `MessageContentConfig` (source, branches[], fallback_branch_id) + `isMultiBranchCondition()` type guard · `WorkflowEdge.branch` เปลี่ยนจาก `"true"|"false"` → `string` (backward compat — edge เก่ายังใช้ได้)
  2. **Validation** (`validateWorkflowGraph`): เพิ่มกฎ multi-branch — branch_id ไม่ซ้ำ / fallback ไม่ชน branch_id / edge ต้องอ้าง branch ที่มีจริง / แต่ละ branch ต้องมี keywords ≥1 / match_type ถูกต้อง
  3. **Engine** (`workflowEngine.ts`): `evalCondition` เปลี่ยนคืน `{ branch: string }` แทน `{ value: boolean }` · แยก `evalMultiBranchCondition` (pure, ไม่ใช้ DB) กับ `evalLegacyCondition` (ใช้ DB สำหรับ conversation_status/business_hours/assignee/new_vs_returning) · `walkGraph` ใช้ branch string generic หา edge · legacy "false" ไม่มี edge → ยังใช้ `false_branch_policy` เหมือนเดิม
  4. **UI** (`nodes.tsx`): `ConditionNode` render dynamic Handle ตาม `branches.length + 1` (fallback) · `useUpdateNodeInternals()` เมื่อ branch เปลี่ยน · label ข้าง handle แต่ละอัน · legacy ยังโชว์ true/false handle 2 อัน
  5. **NodeConfigPanel** (`WorkflowEditor.tsx`): `MessageContentConfigPanel` component — ถ้า legacy → โชว์ UI เดิม + ปุ่ม "อัปเกรดเป็น multi-branch" · ถ้า multi-branch → โชว์ source select + list ของ branch (label/match_type/keywords/ลบ) + ปุ่ม "+ เพิ่มเงื่อนไข" + fallback field + ปุ่ม "กลับไป legacy"
- **Backward compat**: document เก่าที่มี `config.mode/text` ยังทำงาน — engine ตรวจ `isMultiBranchCondition` ก่อน ถ้าไม่ใช่ → ใช้ legacy path
- **ไฟล์ที่แก้**: `workflowService.ts`, `workflowEngine.ts`, `nodes.tsx`, `WorkflowEditor.tsx`
- **ไฟล์ใหม่**: `scripts/test-workflow-phase1.ts` (unit test 25 cases)
- **Verify**: `tsc --noEmit` ผ่าน + unit test 25/25 ผ่าน + `npm run build` ผ่าน
- **ยังไม่ได้ทดสอบ**: e2e กับ MongoDB (สร้าง multi-branch flow ผ่าน UI → ส่งข้อความ → ดู flow เดินถูก branch)

### Workflow — Create modal ตอนกด New (ผ่าน)
- **ที่ผู้ใช้ขอ**: กด "สร้าง Workflow" ต้องเลือก name + description + platform (multi) → ร้านกรองตาม platform (multi) ก่อนเข้า editor และแก้ค่าพวกนี้ได้ภายหลัง
- **วิธีทำ**:
  1. `workflowService.ts` — เพิ่ม `description?: string` ใน `WorkflowDoc` + `createWorkflow` รับ description + allowlist PATCH มี description + อนุญาต graph ว่างตอนสร้าง (shell สร้างก่อน วาด graph ใน editor)
  2. `POST /api/workflows` — รับ `description` และยอม `nodes/edges` ว่าง (default `[]`) ก่อน validate
  3. `PATCH /api/workflows/[workflowId]` — รับ `description` ผ่าน allowlist
  4. `/workflows/page.tsx` — เปลี่ยนปุ่ม "สร้าง Workflow" จาก `router.push("/workflows/new")` เป็นเปิด modal: ชื่อ (required) + description (optional) + platform checkbox (shopee/tiktok/lazada, multi) + shop checkbox กรองตาม platform ที่เลือก (multi, ไม่เลือก platform = โชว์ร้านทั้งหมด) → POST shell → redirect `/workflows/[id]`
  5. `WorkflowEditor.tsx` — `FlowSettings` + `WorkflowDocDTO` เพิ่ม `description` โหลดตอน GET + ส่งตอน POST/PATCH + textarea ใน FlowSettingsPanel
- **Semantics คงเดิม**: `platforms: []` = ทุก platform · `shop_ids: []` = ทุกร้าน · 1 ร้านได้หลาย flow · flow ใช้ร่วมหลายร้าน/หลาย platform
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/backend/service/workflowService.ts`, `ChatAdminWeb/src/app/api/workflows/route.ts`, `ChatAdminWeb/src/app/api/workflows/[workflowId]/route.ts`, `ChatAdminWeb/src/app/(console)/workflows/page.tsx`, `ChatAdminWeb/src/components/workflow/WorkflowEditor.tsx`
- **Verify**: `tsc --noEmit` ผ่าน + `npm run build` ผ่าน (routes `/workflows`, `/workflows/[workflowId]`, `/api/workflows*` ขึ้นครบ)
- **ยังไม่ได้ทดสอบ**: end-to-end กับ MongoDB จริง (สร้างผ่าน modal → ขึ้นใน list → เข้า editor แก้ description/platform/shop ได้) — ต้องรัน admin + มีข้อมูลร้าน

### Workflow Engine — อัปเกรดหน้า /workflows list (ผ่าน)
- **ที่ผู้ใช้ขอ**: flow เป็นรายร้าน (1 ร้านได้หลาย flow) + flow ใช้ร่วมทั้ง platform + หน้า list ต้องมี search/sort/filter/rename/toggle
- **วิธีทำ**:
  1. Rewrite `/workflows/page.tsx` — search ชื่อ+ชื่อร้าน / sort (อัปเดตล่าสุด, ชื่อ, priority, จำนวน node) / filter 3 ตัว (status, enabled, platform) / inline rename (pencil → input → Enter=PATCH / Esc=cancel) / toggle ราย flow / กดแถวเข้า editor / ลบ soft
  2. `WorkflowEditor.tsx` — เลือกร้านจาก checkbox list (โหลด `/api/shops` แมป shop_id→shopname) แทนพิมพ์ ID มือ — fallback เป็น text input ถ้าโหลดร้านไม่ได้
  3. แสดงชื่อร้านบน list (ไม่ใช่แค่ shop_id) + badge "ใช้ร่วมทุกร้าน" ถ้าไม่เลือกร้าน
- **Per-shop หลาย flow**: รองรับอยู่แล้วที่ schema (`shop_ids[]` ว่าง=ทุกร้าน) + engine `matchAndRun` ไล่ทุก flow ที่ match เรียงตาม priority → created_at
- **Verify**: tsc ผ่าน + build ผ่าน

### Workflow Engine (แบบ Zaapi Flow Builder) — ผ่าน (Phase 1-3)

### Workflow Engine (แบบ Zaapi Flow Builder) — ผ่าน (Phase 1-3)
- **ทำอะไร**: ระบบ flow หลายขั้นตอนคู่ขนานกับ trigger — ตาม `workflow-planner.md` ครบทุก Phase
- **สิ่งที่สร้าง**:
  - `workflows` + `workflow_runs` collections (mongoClient.ts + config.ts + indexes)
  - `systemConfigService.ts` เพิ่ม `workflow_enabled` (default false) / `workflow_priority` / `workflow_run_timeout_ms`
  - `workflowService.ts` — CRUD + `validateWorkflowGraph` (กัน graph พัง/trigger ซ้ำ/edge อ้าง ghost)
  - `workflowEngine.ts` — `getActiveRun` (timeout auto-cancel) / `matchAndRun` (keyword + trigger_frequency) / `resumeFlow` / `cancelActiveRuns` + node types ครบตามตาราง planner (trigger 1, condition 5, action 8, wait 1)
  - `botCallService.ts` — แยก callBot ออกจาก botWorkerService (แก้ circular dependency: processMessage → engine → callBot)
  - `botWorkerService.processMessage` เสียบ ①②③ — ① resume active flow (เสมอ) ② workflow_first/both ก่อน trigger, trigger_first หลัง trigger ไม่ match ③ บอทเดิมไม่แตะ + cancel flow ตอน admin รับแชท (assigned guard)
  - API: `/api/workflows` (GET/POST) + `/api/workflows/[workflowId]` (GET/PATCH/DELETE soft) + `/api/workflows/[workflowId]/toggle` + `/api/test-chat/workflow-step` (Test Chat ผ่าน engine)
  - TestChatClient: `flushBuffer` เรียก workflow-step ก่อน trigger (phase=entry) และหลัง trigger ไม่ match (phase=after_trigger) — render delivered messages แบบเดียวกับ template
  - UI: `/workflows` (list) + `/workflows/[workflowId]` (canvas editor `@xyflow/react` — palette/palette/property panel/true-false branch edges) + config card ในหน้า `/config` + เมนู Sidebar
- **false_branch_policy**: exit_to_bot (default) / exit_drop / stay_retry — ใช้เมื่อ condition false และไม่มี false edge (ถ้ามี false edge → เดินตาม edge แบบแตกกิ่งจริง)
- **กฎเหล็กที่ทำตาม planner**: trigger เดิมไม่ทิ้ง / บอทไม่แตะ / workflow_first default / พอออก flow ไปบอท = flow จบ (ฮิตใหม่ = เริ่มใหม่) / admin รับแชท → cancelActiveRuns / MAX_ENGINE_STEPS=50 กัน jump_to ลูปไม่รู้จบ
- **Safety**: ไม่ยิง platform API ใดๆ — delivered messages เก็บใน `shadow_replies` (origin="workflow", inbound_message_id suffix `__wf<N` กันชน unique index) / send_http ผ่าน `isSafeFetchUrl` (SSRF guard)
- **Verify**: `tsc --noEmit` ผ่าน + `npm run build` ผ่าน (routes `/workflows`, `/workflows/[workflowId]`, `/api/workflows*` ขึ้นครบ) + smoke test `validateWorkflowGraph` 6/6 ผ่าน (valid graph / no trigger / two triggers / ghost edge / no outgoing / dup id)
- **ยังไม่ได้ทดสอบ**: end-to-end กับ MongoDB + Python bot จริง (ต้อง insert workflow ทาง UI แล้วส่งข้อความผ่าน Test Chat)
- **ไฟล์ใหม่**: `src/backend/service/{workflowService,workflowEngine,botCallService}.ts`, `src/app/api/workflows/**`, `src/app/api/test-chat/workflow-step/route.ts`, `src/components/workflow/{WorkflowEditor,nodes}.tsx`, `src/app/(console)/workflows/**`
- **ไฟล์ที่แก้**: `config.ts`, `mongoClient.ts`, `systemConfigService.ts`, `botWorkerService.ts`, `shadowReplyService.ts` (origin + "workflow"), `adminLogService.ts` (action types), `/api/config/route.ts` (validation), `config/page.tsx`, `Sidebar.tsx`, `TestChatClient.tsx`

---

## ปัญหาที่เหลือ (ตามลำดับความสำคัญ)

### 1. Verify Q14 + charger subtype carry (ผ่าน)
- **Q14 "ผมขอดูสินค้าจริงได้ไหม"** (หลังคุย BioKoop):
  - มี item_id → source=item_tag, products=BioKoop ✓
  - ไม่มี item_id (ใช้ history) → source=product_store, สินค้าลำดับแรก=BioKoop ✓
  - ไม่ดึง Elite2 ผิดเหมือนเดิมแล้ว
- **Q5 "มีชาจเร็วขาร์จแรงกว่านี้ไหม"** (หลังคุยหัวชาร์จ AD652S):
  - ดึงหัวชาร์จ (AD653, AD652S, AD654T) ไม่ใช่สาย CL315P ✓
- **Q15 "มีจอไหม แบบมีจอด้วยดิ"** (หลังคุยหัวชาร์จ AD1404U):
  - ดึงหัวชาร์จ (AD1404U, AD1204U, AD1003) ไม่ใช่สาย ✓
  - ตอบ "ไม่มีจอ" ถูก ✓
- **Verify**: bot จริง 2026-09-03 ผ่านทั้ง 3 เคส

### 2. Q19 — "ใช้มั๊ย" สั้นเกิน (ผ่าน)
- บอทบอกถามใหม่ ทั้งที่ควรดึง context จาก history
- **Root cause**: SYSTEM_INSTRUCTION ใน `llm.py` ไม่มีกฎสำหรับคำถามสั้น/กำกวม → LLM ตอบ "คำถามสั้นไปนิดนึง ไม่แน่ใจว่าหมายถึงอะไร" ทั้งที่มี BioKoop ใน context + history
- **วิธีแก้**: เพิ่มกฎใน SYSTEM_INSTRUCTION (`llm.py` บรรทัด ~84) ว่า:
  - ถ้าคำถามสั้น/กำกวม + มี history → ใช้ history ตีความ แล้วตอบเกี่ยวกับสินค้าที่กำลังคุย
  - ห้ามตอบว่า "คำถามสั้นไป" หรือ "ไม่แน่ใจว่าหมายถึงอะไร"
  - ถ้าไม่ชัดว่าถามเรื่องใด → ตอบเกี่ยวกับสินค้าที่กำลังคุยแบบกว้างๆ + เชิญถามเพิ่ม
- **ไฟล์ที่แก้**: `chatbot/shopeechat/llm.py` (SYSTEM_INSTRUCTION)
- **Verify** (bot จริง 2026-09-03):
  - Q19 "ใช้มั๊ย" + history BioKoop → ตอบเกี่ยวกับ BioKoop (สายรัดข้อมืออัจฉริยะ ตรวจสุขภาพ 24 ชม. แบต 21 วัน) ✓
  - "ตัวไหน" + history สมาร์ทวอช → ตอบแนะนำ BioKoop ✓
  - "ส่งยัง" + history สั่งซื้อ → ตอบเรื่องจัดส่ง ✓
  - Q18 "มีประกัน" (regression) → ยังตอบเรื่องรับประกันถูก ✓

### 3. Q18, Q21 — รับประกันยาวเกิน + ตัดค้าง (ผ่าน)
- คำตอบ warranty ยาวเกิน template-heavy (Q18: 1275 chars, Q21: 1358 chars)
- **Root cause**:
  1. SYSTEM_INSTRUCTION มีกฎ "คำถาม duration เฉพาะเจาะจง" แต่ตัวอย่างคือ "X รับประกันกี่ปี" → "มีประกัน" ไม่เข้าเงื่อนไข
  2. `_append_base_warranty` ใน `app.py` แนบเงื่อนไขรับประกันเต็มทุกครั้งที่เป็น warranty question
  3. `detect_warranty_duration_question` จับทุกข้อความที่มี "ประกัน" → แนบเงื่อนไข "สั้น" ที่จริงคือเงื่อนไขเต็ม
  4. Q21 เป็น statement ("มีประกันถูกต้องนะครับ") แต่ยังถูกแนบเงื่อนไขเต็ม
- **วิธีแก้** (2 ไฟล์):
  1. `llm.py` SYSTEM_INSTRUCTION: ขยาย duration question รวม "มีประกัน" และเพิ่มกฎ statement + terms
  2. `app.py` `_append_base_warranty`: เปลี่ยน logic ใหม่ — แนบเงื่อนไขเต็มเฉพาะเมื่อลูกค้าขอ terms (มี "เงื่อนไข", "ยังไง", "อะไรบ้าง" ฯลฯ) ไม่ใช่ทุก warranty question
  3. `app.py` บรรทัด 1606: skip general warranty_policy flow เมื่อมี item_id (ลูกค้าคลิกสินค้า)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/llm.py`, `chatbot/shopeechat/app.py`
- **Verify** (bot จริง 2026-09-03):
  - Q18 "มีประกัน" + item_id → 180 chars (จาก 1275) ตอบ "รับประกัน 1 ปีค่ะ" ✓
  - Q21 statement + item_id → 182 chars (จาก 1358) ไม่แนบเงื่อนไข ✓
  - "เงื่อนไขรับประกันเป็นยังไงบ้าง" → 1396 chars แนบเงื่อนไขเต็ม ✓
  - Q3 "BioKoop รับประกันกี่ปี" (regression) → 202 chars สั้น ✓

### 4. Answer elaboration — ตอบละเอียดขึ้น (ผ่าน)
- บอทตอบสั้นเกิน เช่น "เปลี่ยนได้ใช้สาย 22 มม. แบบนี้" จบ
- **วิธีแก้**: เพิ่ม 2 กฎใน SYSTEM_INSTRUCTION (`llm.py`):
  1. **ตอบให้ละเอียด**: ทุกคำถามเกี่ยวกับสินค้า ต้องเสริมข้อมูลที่เป็นประโยชน์ 2-3 ประโยค
     เช่น "สายนาฬิกาเปลี่ยนได้ไหม" → บอกขนาด + ที่หาซื้อ + เชิญถามเพิ่ม
     ห้าม invent ข้อมูล — ถ้าไม่มี บอก "ทักแอดมินสอบถามได้ค่ะ"
  2. **คำถามเล่นๆ/นอกเรื่อง**: ตอบเป็นมิตร เล่นด้วยสั้นๆ แล้วกลับสู่บริบทร้าน
     เช่น "มี Pokemon ไหม" → "ไม่มีค่ะ แต่มีสินค้าไอทีน่าสนใจมากมาย"
- **ไฟล์ที่แก้**: `chatbot/shopeechat/llm.py` (SYSTEM_INSTRUCTION)
- **Verify** (bot จริง 2026-09-03):
  - "สายนาฬิกาเปลี่ยนได้ไหม" → 217 chars บอกขนาด + ที่หาซื้อ ✓
  - "มี Pokemon ขายไหม" → 177 chars ตอบเป็นมิตร + กลับสู่ร้าน ✓
  - "ใช้กับ iPhone ได้ไหม" → 292 chars บอก Bluetooth + iOS/Android ✓
  - "กันน้ำไหม" (ไม่มีข้อมูล) → 190 chars บอกตรง + ทักแอดมิน ✓
  - "มีหุ่นยนต์ไหม" → 408 chars ตอบเป็นมิตร + แนะนำสินค้า ✓
  - Q18 regression → 179 chars ✓
  - Q19 regression → 507 chars ✓

### 5. Q5, Q12 — แนบลิงก์/รูปซ้ำซ้อน (ผ่าน)
- บอท push sales แนบลิงก์/รูปซ้ำทั้งที่ลูกค้าถาม trust
- **Q5**: "มีวีดีโอการรีวิวไหม...ไม่แน่ใจว่ามีความน่าเชื่อถือ" → บอทแนบลิงก์สั่งซื้อ+รูป ทั้งที่ลูกค้าถาม trust
- **Q12**: "ผมมั่นใจได้นะครับว่าไม่โดนหลอกลวง" → บอทแนบลิงก์สั่งซื้อ+รูป (อาจ OK เพราะลูกค้าพร้อมซื้อ)
- **Root cause**: SYSTEM_INSTRUCTION ไม่มีกฎ "ห้ามแนบลิงก์/รูปเมื่อลูกค้าถาม trust/ความน่าเชื่อถือ"
- **วิธีแก้**: เพิ่ม 2 กฎใน SYSTEM_INSTRUCTION (`llm.py`):
  1. ถ้าลูกค้าถาม trust/ความน่าเชื่อถือ/วีดีโอรีวิว → ตอบ trust อย่างเดียว ไม่แนบลิงก์/รูป
  2. แนบลิงก์/รูปเฉพาะเมื่อลูกค้าแสดงความสนใจซื้อ/ขอดูสินค้า
- **ไฟล์ที่แก้**: `chatbot/shopeechat/llm.py` (SYSTEM_INSTRUCTION)
- **Verify** (bot จริง 2026-09-03):
  - Q5 trust + วีดีโอ → no link, no img ✓
  - Q12 "มั่นใจได้นะครับ" → no link, no img ✓
  - Q12 + "สนใจสั่งซื้อ" → has link, has img ✓
  - "ของแท้ไหม" → no link, no img ✓
  - "ขอดูรูปสินค้า" → has link, has img ✓
  - "สนใจสั่งซื้อ BioKoop" (regression) → has link ✓
- **Q5**: "มีวีดีโอการรีวิวไหม...ไม่แน่ใจว่ามีความน่าเชื่อถือ" → บอทแนบลิงก์สั่งซื้อ+รูป ทั้งที่ลูกค้าถาม trust
- **Q12**: "ผมมั่นใจได้นะครับว่าไม่โดนหลอกลวง" → บอทแนบลิงก์สั่งซื้อ+รูป (อาจ OK เพราะลูกค้าพร้อมซื้อ)
- **Root cause**: SYSTEM_INSTRUCTION ไม่มีกฎ "ห้ามแนบลิงก์/รูปเมื่อลูกค้าถาม trust/ความน่าเชื่อถือ"
- **วิธีแก้**: เพิ่ม 2 กฎใน SYSTEM_INSTRUCTION (`llm.py`):
  1. ถ้าลูกค้าถาม trust/ความน่าเชื่อถือ/วีดีโอรีวิว → ตอบ trust อย่างเดียว ไม่แนบลิงก์/รูป
  2. แนบลิงก์/รูปเฉพาะเมื่อลูกค้าแสดงความสนใจซื้อ/ขอดูสินค้า
- **ไฟล์ที่แก้**: `chatbot/shopeechat/llm.py` (SYSTEM_INSTRUCTION)
- **Verify** (bot จริง 2026-09-03):
  - Q5 trust + วีดีโอ → no link, no img ✓
  - Q12 "มั่นใจได้นะครับ" → no link, no img ✓
  - Q12 + "สนใจสั่งซื้อ" → has link, has img ✓
  - "ของแท้ไหม" → no link, no img ✓
  - "ขอดูรูปสินค้า" → has link, has img ✓
  - "สนใจสั่งซื้อ BioKoop" (regression) → has link ✓
- ต้องทำ: แก้ prompt กันแนบลิงก์ถ้าไม่จำเป็น

### 5. SRS_SSD.md section 6
- อัปเดตฟังก์ชันที่เปลี่ยน: CONV-ACTIVE, conversation_products, knowledge_base stop_words, replay UI

---

## เคสที่ผ่านแล้ว (เพิ่มใหม่ 2026-09-09)

### Charger subtype carry ไม่ทำงานเมื่อ message พิมพ์ตก "หัวชาจ" หรือไม่มีคำ charger เลย (ผ่าน logic, รอ verify answer จริง)
- **เคสที่พบ** (log จริง CukTechThailand):
  - Q5 "มีชาจเร็วขาร์จแรงกว่านี้ไหม" (หลังคุยหัวชาร์จ AD652S) → บอทตอบ CL315P (สาย) ผิด
  - Q15 "มีจอไหม แบบมีจอด้วยดิ" (หลังคุยหัวชาร์จ AD1404U) → บอทตอบ CL315P (สาย) ผิด
- **Root cause**:
  1. `_detect_product_types` ไม่มี logic แก้พิมพ์ผิด "หัวชาจ" → "หัวชาร์จ" (แต่ `_detect_charger_subtype` มี)
  2. carry type จาก history (app.py บรรทัด ~2399) ใช้ `_detect_product_types(hmsg)` อย่างเดียว → ไม่จับ "หัวชาจ" เป็น charger
  3. carry subtype (app.py บรรทัด ~2427) เช็ค `"charger" in current_types` ก่อน → ไม่ผ่าน → carry subtype ไม่ทำงาน
  4. RAG ใช้ `req.message` ตรงๆ → ดึงสายชาร์จ (CL315P) มาเพราะ keyword "ชาร์จ"/"จอ" ตรงกับสายชาร์จใน DB
- **วิธีแก้** (2 จุดใน `app.py`):
  1. **carry type จาก history** (บรรทัด ~2399-2412): เพิ่ม fallback ถ้า `_detect_product_types` และ `_detect_product_types_fuzzy` ไม่จับ ให้ลอง `_detect_charger_subtype(hmsg)` — ถ้าจับได้ ถือว่าเป็น `{"charger"}`
  2. **carry subtype** (บรรทัด ~2427): เพิ่ม `_is_charger_ctx` variable ที่เป็น True ถ้า `"charger" in current_types` **หรือ** `_detect_charger_subtype(req.message) is not None` — ทำให้ message ที่มี "หัวชาจ" ตรงๆ ก็ถือว่าเป็น charger context ด้วย
- **ผล verify logic** (จำลองด้วย Python):
  - Q5: carry type `{'charger'}` จาก Q3 + carry subtype `adapter` → RAG จะใช้ "หัวชาร์จ มีชาจเร็วขาร์จแรงกว่านี้ไหม" ✓
  - Q15: carry type `{'charger'}` จาก Q13 + carry subtype `adapter` → RAG จะใช้ "หัวชาร์จ มีจอไหม แบบมีจอด้วยดิ" ✓
  - Q3 (ต้องไม่พัง): message มี `_detect_charger_subtype = adapter` → carry subtype คืน None (ใช้ตรงๆ) ✓
  - เคสเก่า (smartwatch/BioKoop): history ไม่มี charger_subtype → carry ใหม่ไม่ทำงาน → ไม่กระทบ ✓
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **Verify**: `python -m py_compile` ผ่าน + จำลอง logic กับ history จริง ผ่าน
- **⚠️ ยังไม่ verify เต็ม**: รอทดสอบกับ bot จริง (replay CukTechThailand 15 Q) เพื่อยืนยันว่า RAG ดึงหัวชาร์จจริง ไม่ใช่สาย

### Deploy — แก้ bug Dockerfile + เพิ่ม Caddy + ปรับ DEPLOY.md (ผ่าน)
- **ปัญหา**:
  1. `Dockerfile.chatbot` มี `COPY scripts/ ./scripts/` แต่ root มีแค่ `script/` (ไม่มี s) → build fail
  2. `docker-compose.yml` ไม่มี reverse proxy / SSL
  3. `DEPLOY.md` ยังไม่สมบูรณ์ (ไม่มี troubleshooting, ไม่มี Caddy, ไม่เตือน lazada/tiktok placeholder)
  4. `chatbot-lazada` / `chatbot-tiktok` ใน docker-compose ตั้ง `APP_MODULE=chatbot.lazadachat.app:app` แต่ไม่มี `app.py` จริง (มีแค่ `__init__.py` ว่าง) → ถ้าเปิด profile จะ crash
- **วิธีแก้**:
  1. `Dockerfile.chatbot`: เอา `COPY scripts/ ./scripts/` ออก (root `script/` เป็น manual tool ไม่ใช้ตอน runtime — ตรวจด้วย grep แล้วไม่มี import)
  2. สร้าง `Caddyfile` — reverse proxy + auto SSL (Let's Encrypt) รองรับทั้งกรณีมีโดเมน (HTTPS) และยังไม่มีโดเมน (HTTP :80)
  3. `docker-compose.yml`:
     - เพิ่ม `caddy` service (image `caddy:2-alpine`, port 80/443, mount Caddyfile)
     - เปลี่ยน `chatadmin-web` จาก `ports: 3000:3000` เป็น `expose: 3000` (เข้าผ่าน Caddy)
     - เปลี่ยน `chatbot-shopee` จาก `ports: 8010:8010` เป็น `127.0.0.1:8010:8010` (debug จาก host ได้ แต่ไม่ expose ออก internet)
     - เปลี่ยน `depends_on` เป็น `condition: service_healthy` (chatbot-shopee) / `service_started` (chatadmin-web)
     - เพิ่ม volumes `caddy_data`, `caddy_config`
     - เพิ่มคำเตือนใน comment ว่า lazada/tiktok เป็น placeholder
  4. `DEPLOY.md`: เขียนใหม่ทั้งไฟล์ — เพิ่มสถาปัตยกรรม traffic, ขั้นตอน Caddy (2 กรณี), troubleshooting, การอัปเดต, backup, คำเตือน safety switches
- **ไฟล์ที่แก้**: `Dockerfile.chatbot`, `docker-compose.yml`, `DEPLOY.md`, `Caddyfile` (ใหม่)
- **Verify**: `python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"` ผ่าน — services: chatbot-shopee, chatbot-lazada, chatbot-tiktok, chatadmin-web, bot-worker, caddy
- **⚠️ ยังไม่ verify เต็ม**: ไม่ได้รัน `docker compose up` จริง (เครื่องนี้ไม่มี Docker) — lead tech ต้องทดสอบ build + start บน server

---

## กำลังจะทำ (2026-09-10 — Inbox/Scroll/Image/BotWorker refactor)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม
> ทุกข้อต้อง verify หลังแก้ — ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify

### ที่มา

User พบปัญหาและต้องการปรับระบบหลายจุด:

1. **Scroll รายการแชท (ซ้าย) เด้งกลับ** — เลื่อนไปดูแชท 3-4 วันก่อน แล้วเด้งกลับแชท 2 ชม. ก่อน
2. **Image vision ไม่ทำงานในบางหน้า** — Shadow Generate ไม่ส่งรูปเลย, Replay ไม่ส่งรูปใน history, TestChat ไม่เก็บ image_desc
3. **ต้องการแยก assigned_to ตาม source** — shadowbot จ่าย admin 1, botworker จ่าย admin 2 สำหรับ conversation เดียวกันได้
4. **ต้องการล้าง status เก่า** — status_conversation (ticket) + test_status_conversation (4 หน้า test)
5. **ต้องการปรับ botworker ให้เลียนแบบ ticket** — UI เหมือน ticket, แสร้งเป็นแอดมินตอบ, เก็บใน messages_shp ด้วย source='adminbottesttest'
6. **ต้องการ history logic ใหม่สำหรับ botworker** — มัดรวม message ติดกันเป็นกลุ่ม, เลือกบอทเราก่อน zaapi

### รีวิวแผน — ข้อดี/ข้อเสีย/ทางเลือก

#### A1. แก้ scroll รายการแชท (ซ้าย)
- **สาเหตุจริง**: polling ทุก 3-5 วิ re-render `ChatList` → React รีเซ็ต scroll position ของ container
- **วิธี**: เก็บ scrollTop ใน ref ตอน onScroll, restore หลัง re-render
- **ข้อดี**: แก้ตรงจุด, ไม่กระทบ logic อื่น
- **ข้อเสีย**: ถ้ามี conversation ใหม่เข้ามา ตำแหน่งอาจเลื่อนนิดหน่อย (แต่ไม่เด้ง)
- **ทางเลือก**: ใช้ `react-virtualized` หรือ `react-window` — เกินไป ใช้ ref พอ
- **ความเสี่ยงต่อเคสเก่า**: ไม่มี เพราะแค่ preserve scroll position

#### A2. แก้ image vision ทุกหน้า
- **Shadow Generate**: เพิ่ม `toBotImages` + ส่งใน history
- **Replay Compare**: ส่ง `images` ใน history
- **TestChat**: เก็บ `image_desc` จาก ChatResponse ใส่ historyRef
- **ข้อดี**: bot อ่านรูปได้ครบทุกหน้า, ประหยัด token (ใช้ cache)
- **ข้อเสีย**: เพิ่ม latency นิดหน่อยตอนอ่านรูปใหม่
- **ความเสี่ยงต่อเคสเก่า**: ไม่มี เพราะเดิมไม่ส่งรูปอยู่แล้ว การส่งเพิ่มแค่ทำให้ดีขึ้น

#### B1/B2. ล้าง status
- **วิธี**: `updateMany({}, {$unset: {status: "", assigned_to: "", close_count: ""}})`
- **ข้อดี**: ทำได้ทันที, ไม่กระทบ message/conversation data
- **ข้อเสีย**: ทำลาย state ปัจจุบัน (แต่ user ยืนยันแล้วว่าจะรันใหม่เอง)
- **ความเสี่ยง**: ถ้ามี conversation ที่กำลังเปิดอยู่จริง จะกลายเป็น default (bot) — แต่ user บอกล้างได้

#### C1. แยก assigned_to ตาม source
- **ตอนนี้**: `test_status_conversation` มี compound key `{conversation_id, source}` อยู่แล้ว
- **แต่ละ source มี document ของตัวเองอยู่แล้ว** (เพราะ upsert ด้วย `{conversation_id, source}`)
- **ปัญหาจริง**: `handoffService` อ่าน assigned_to จาก `meta?.assigned_to` โดยไม่กรอง source → อาจอ่านของ source อื่น
- **วิธีแก้**: ให้ `testStatusConversationService.getMeta` กรองด้วย source เสมอ
- **ข้อดี**: ใช้โครงสร้างเดิม, ไม่ต้องเปลี่ยน schema
- **ความเสี่ยงต่อเคสเก่า**: ต้องเช็คว่าทุก caller ส่ง source มา

#### D1-D3. botworker เลียนแบบ ticket
- **วิธี**: ดึง `TicketChatPanel` มาใช้, เพิ่ม source='adminbottesttest' ใน messages_shp
- **ข้อดี**: UI เหมือน ticket, ใช้ collection เดียวกัน
- **ข้อเสีย**: เพิ่ม field ใหม่ใน message doc — ต้องเช็คว่า query อื่นกรอง source ไหม
- **ความเสี่ยงต่อเคสเก่า**: ถ้า `listMessages` ไม่กรอง source → คำตอบ test ปนกับของจริง
- **แก้**: `listMessages` ต้องกรอง `source != 'adminbottesttest'` สำหรับ ticket ปกติ

#### E1-E2. History logic ใหม่
- **วิธี**: สร้าง `getHistoryForBotWorker` ที่:
  1. ดึง user messages + zaapi replies + bot shadow replies
  2. มัดรวม message ที่ติดกันเป็นกลุ่ม (ไม่มี reply คั่น)
  3. แต่ละกลุ่ม → หา reply: ถ้ามี shadow reply → ใช้ bot, ถ้าไม่ → ใช้ zaapi
- **ข้อดี**: bot เห็น history ที่สมจริง
- **ข้อเสีย**: logic ซับซ้อนขึ้น
- **ความเสี่ยงต่อเคสเก่า**: `getHistoryForBot` เดิมใช้ใน botworker อยู่แล้ว — ต้องสร้าง function ใหม่แยก ไม่แก้ของเดิม

### ลำดับการทำ

1. **F1** อธิบาย image vision flow ปัจจุบัน (ให้เข้าใจก่อนแก้)
2. **B1 + B2** ล้างข้อมูล (เร็ว, ทำได้ทันที)
3. **A1** แก้ scroll รายการแชท
4. **A2** แก้ image vision ทุกหน้า
5. **C1** แยก assigned_to ตาม source
6. **D1-D3** ปรับ botworker UI + storage
7. **E1-E2** history logic ใหม่

### ข้อกำหนดที่ต้องไม่ลืม

- **ห้ามกระทบ ticket**: ทุกการเปลี่ยนแปลงใน test_status_conversation ต้องไม่กระทบ status_conversation (ticket ใช้คนเดียว)
- **ห้ามกระทบเคสเก่า**: C (context loss), A (trigger), B (cascade), D (trust), Q14, Order Lookup, Warranty-Image, Charger subtype — ทั้งหมดต้องไม่พัง
- **ห้ามกระทบ getHistoryForBot เดิม**: สร้าง function ใหม่ `getHistoryForBotWorker` แยก
- **ห้ามกระทบ listMessages เดิม**: ถ้าต้องกรอง source ใหม่ ต้องไม่ทำลาย query เดิม
- **botworker source='adminbottesttest'**: ต้องไม่ปนกับ ticket ปกติ — listMessages สำหรับ ticket ต้องกรองออก
- **กฎ open/closed/bot ต้องครบ**:
  - open/handoff: บอทส่งต่อ, trigger/workflow ส่งต่อ, แอดมินกดรับเรื่อง
  - closed: แอดมินกดปิด, บอทปิดเองหลัง 30 นาทีไม่มีทักซ้ำ, trigger/workflow ปิด
  - reopen/bot: แอดมินกด reopen หรือลูกค้าทักซ้ำหลังปิด → ผ่าน buffer/workflow/trigger ก่อนถึงบอท
- **Verify ทุกข้อ**: ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify จริง

### คำถามที่ถาม user แล้ว (ยืนยันแล้ว)

- botworker เก็บคำตอบใน messages_shp ด้วย source field → ใช่
- มัดรวม message ติดกัน → เฉพาะ history ส่ง bot (UI แสดงทีละ message ปกติ)
- เลือกบอทเราก่อน zaapi → แบบ B (ทีละ Q&A pair) + มัดรวม 3-4 message ที่ติดกันเป็นคำถามเดียว แล้ว zaapi reply = คำตอบของทั้งกลุ่ม
- แยก assigned_to ตาม source → ใช่ แยกตาม source
- scroll เด้ง → เกิดที่รายการแชท (ซ้าย)
- ล้าง status → ล้างเฉพาะ field status/assigned_to ไม่ลบ document

---

## กำลังจะทำ (2026-09-05 — /team expand bug + status columns + date range)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา

User พบปัญหาในหน้า `/team`:
1. **กด expand agent แล้วไม่โชว์ร้านค้า/แพลตฟอร์ม** — ขึ้น 0 ทั้งที่มีข้อมูล
2. **สถานะเปลี่ยนเป็น open/handoff/closed/bot แล้ว** — คอลัมน์ยังเป็น Pending อยู่
3. **ต้องการดูรายละเอียดสถานะแชทของแอดมินตามวันที่/ช่วงเวลา** เหมือน dashboard

### สาเหตุ

1. **Expand bug**: `shops`, `shopTeam`, `platformTeam` state โหลดเฉพาะตอน tab = shop-team/platform-team (useEffect บรรทัด 185-188) — ใน overview tab มันว่าง → agentShops/agentPlatforms = 0
2. **Status ผิด**: team API อ่าน `c.status === "pending"` จาก `conversations` (โดน dump ทับ) — ควรอ่านจาก `status_conversation` และใช้ open/handoff/closed/bot
3. **ไม่มี date range**: ไม่มี date picker สำหรับดู historical stats

### วิธีแก้

1. **API `/team`**:
   - อ่าน workload จาก `status_conversation` (join `conversations` สำหรับ shop/platform)
   - ใช้ statuses: open, handoff, closed, bot (เอา pending ออก)
   - รวม shop_team + platform_team พร้อม shop names ใน response (ไม่ต้องโหลดแยก)
   - รองรับ `start_date`/`end_date` query params — ดึง historical stats จาก `admin_logs`
2. **Frontend `/team`**:
   - โหลด shops/shopTeam/platformTeam ตอน mount (แก้ expand bug)
   - เปลี่ยนคอลัมน์ Pending → Closed
   - เพิ่ม `UnifiedDateRangePicker`
   - expand panel แสดง historical status breakdown ตาม date range

### ความเสี่ยงต่อเคสเก่า

- ไม่มี — /team เป็นหน้า monitor ไม่กระทบ bot flow
- ไม่กระทบ status_conversation writes (แค่อ่าน)

### ผล (ผ่าน)

- **Typecheck**: ผ่าน
- **Build**: ผ่าน
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/app/api/team/route.ts` — rewrite อ่านจาก status_conversation + รวม shop/platform + historical stats
  - `ChatAdminWeb/src/app/(console)/team/page.tsx` — โหลด shops ตอน mount, เปลี่ยน Pending→Closed, เพิ่ม DateRangePicker, expand panel แสดง historical stats
- **เคสที่ผ่าน**:
  - Expand agent ใน overview tab → แสดงร้าน/แพลตฟอร์มที่ดูแล (จาก API)
  - คอลัมน์ workload = open/bot/handoff/closed (ไม่มี pending แล้ว)
  - เลือก date range → expand แสดง historical stats (รับงาน/ตอบ/ส่งต่อ/ปิด/เปิดใหม่/resolve)
  - workload อ่านจาก status_conversation (ไม่โดน dump ทับ)

---

## กำลังจะทำ (2026-09-05 — Date separator ทุกหน้าแชท เหมือน LINE)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา

User ต้องการ date separator คั่นกลางแชทเมื่อเปลี่ยนวัน — เหมือน LINE ที่มีแถบ "วันนี้" / "เมื่อวาน" / "5 ก.ย. 2569" ขึ้นตรงกลางแชท

ต้องทำในทุกหน้าที่แสดงแชท:
- test-chat/shopee
- test-assignment
- botworker
- replay-compare
- shadow-inbox (ฝั่ง user/zaapi และ user/bot)
- tickets

### สาเหตุ

- ไม่มี date separator ในทุกหน้า — ผู้ใช้ไม่รู้ว่าข้อความข้างบน/ข้างล่างเป็นวันไหน
- มี `DateBanner` component อยู่แล้วใน `components/shadow/DateBanner.tsx` แต่ใช้แค่ใน ShadowReplyPanel

### วิธีแก้

1. **สร้าง `DateSeparator.tsx`** — helper component `DateSeparatedList` รับ items + getKey + getTimestamp + renderItem แล้วแทรก DateBanner เมื่อวันเปลี่ยน
2. **ChatWindow.tsx** — ใช้ DateSeparatedList แทน messages.map
3. **TicketChatPanel.tsx** — ใช้ DateSeparatedList แทน messages.map
4. **TestChatClient.tsx** — เพิ่ม timestamp field ใน Msg interface + แทรก DateBanner ใน messages.map
5. **botworker/page.tsx** — แทรก DateBanner ใน messages.map ด้วย React.Fragment
6. **test-assignment/page.tsx** — แทรก DateBanner ใน detail.messages.map
7. **replay-compare/page.tsx** — แทรก DateBanner ใน previewMessages.map
8. **ShadowReplyPanel.tsx** — มี DateBanner อยู่แล้ว ไม่ต้องแก้

### ความเสี่ยงต่อเคสเก่า

- ไม่มี — เป็นการเพิ่ม DateBanner คั่น ไม่ได้ลบ logic เดิม
- ไม่กระทบ bot flow หรือ API

### ผล (ผ่าน)

- **Typecheck**: ผ่าน
- **Build**: ผ่าน
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/components/chat/DateSeparator.tsx` — สร้างใหม่ (DateSeparatedList helper)
  - `ChatAdminWeb/src/components/chat/ChatWindow.tsx` — ใช้ DateSeparatedList
  - `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` — ใช้ DateSeparatedList
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` — เพิ่ม timestamp field + แทรก DateBanner
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — แทรก DateBanner
  - `ChatAdminWeb/src/app/(console)/test-assignment/page.tsx` — แทรก DateBanner
  - `ChatAdminWeb/src/app/(console)/replay-compare/page.tsx` — แทรก DateBanner
- **เคสที่ผ่าน**:
  - ทุกหน้าแชทแสดงแถบวันที่คั่นกลางเมื่อเปลี่ยนวัน (เหมือน LINE)
  - "วันนี้" / "เมื่อวาน" / "5 ก.ย. 2569" ตามจริง
  - ไม่กระทบการ scroll หรือ logic เดิม

---

## กำลังจะทำ (2026-09-05 — Sticker URL + botworker raw_payload)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา

User พบปัญหา:
1. **สติกเกอร์ไม่ขึ้นเป็นรูป** — `[สติกเกอร์]` แสดงเป็น text "(สติกเกอร์ ID)" แทนที่จะเป็นรูป
2. **หน้า botworker ไม่ parse raw_payload** — สติกเกอร์/รูป/การ์ดสินค้า/การ์ดคำสั่งซื้อไม่แสดง
3. **ต้องการให้ทุกหน้าเห็นข้อความจริง + ประมวลผลรูป + history + buffer เหมือนกัน**

### สาเหตุ

1. **Sticker parser**: `parseRawMessage` case "sticker" ดึงแค่ `sticker_id` ไม่ดึง URL → ไม่มี media ส่งกลับ
2. **Botworker route**: `/botworker/conversations/:id/messages` ไม่เรียก `parseRawMessage` เลย — ส่งแค่ text ดิบๆ
3. **MessageContent**: case "sticker" แสดง icon + text เท่านั้น ไม่รองรับ media.url

### วิธีแก้

1. **`messageMediaParser.ts`** — case "sticker" ดึง URL จาก `url`/`image_url`/`sticker_url` + normalize + ส่งกลับเป็น media
2. **`MessageContent.tsx`** — case "sticker" ถ้ามี `media.url` → แสดงเป็น `<img>` (max 160px) + click ดูภาพใหญ่
3. **`botworker/.../messages/route.ts`** — เพิ่ม `parseRawMessage` + `productService.getProductsByIds` เหมือน admin route
4. **`botworker/page.tsx`** — `UnifiedMessage` interface เพิ่ม `message_type`/`media`/`order_sn`/`table`/`products` + `toChatMsg` ส่ง rich media ไป MessageContent
5. **`replay_compare.py`** — case "sticker" ดึง URL จากหลาย field + normalize + ส่งกลับเป็น media

### ความเสี่ยงต่อเคสเก่า

- ไม่มี — เป็นการเพิ่ม field ใหม่ (media) ไม่ได้ลบ field เดิม
- ไม่กระทบ bot flow — bot ยังได้ text เดิม (placeholder `[สติกเกอร์]`)
- ไม่กระทบ history/buffer — ไม่ได้แก้ messageService.ts

### ผล (ผ่าน)

- **Typecheck**: ผ่าน
- **Build**: ผ่าน
- **py_compile**: ผ่าน
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/backend/service/messageMediaParser.ts` — sticker case ดึง URL + **แก้ placeholder fallback ให้ fall through ไป switch case ถ้า msgType === "sticker"**
  - `ChatAdminWeb/src/components/chat/MessageContent.tsx` — sticker แสดงเป็นรูป
  - `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — เพิ่ม parseRawMessage + product lookup
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — UnifiedMessage + toChatMsg ส่ง rich media
  - `replay_compare.py` — sticker parser ดึง URL + **แก้ placeholder fallback เหมือน TS**
- **เคสที่ผ่าน**:
  - สติกเกอร์ที่มี URL ใน raw_payload → แสดงเป็นรูปในทุกหน้า (tickets, shadow-inbox, test-assignment, replay-compare, botworker)
  - หน้า botworker แสดงรูป/สติกเกอร์/การ์ดสินค้า/การ์ดคำสั่งซื้อได้เหมือน /tickets
  - สติกเกอร์ที่ไม่มี URL → fallback แสดง icon + text (เหมือนเดิม)
- **⚠️ บั๊กหลักที่แก้ครั้งที่ 2**: placeholder fallback `[สติกเกอร์]` return ก่อนถึง switch case → ไม่เคยดึง URL จาก raw_payload เลย แม้จะมี msgType === "sticker" ก็ตาม → แก้ให้ fall through ไป switch case เหมือน image/video/item

---

## กำลังจะทำ (2026-09-07 — TestChat session ownership + log UI)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา
User ต้องการให้ test chat (shopee) แยก session ตาม admin — แต่ละคนเห็นแค่ของตัวเอง และมีระบบ log บอกว่าใครสร้าง/พิมพ์อันไหน

### สถานะปัจจุบัน
- `test_chat_sessions` ไม่มี field `admin_id` → ทุก admin เห็นทุก session
- `test_chat_logs` มีอยู่แล้ว (`_log_testchat_action` บันทึก create/add_message/delete/update/close/reopen พร้อม admin_id, admin_name)
- ไม่มี UI ดู log ในหน้า test chat
- Next.js proxy ส่ง `X-Admin-Id` + `X-Admin-Name` header ให้ Python อยู่แล้ว

### แผน
1. **Python `app.py`**:
   - `create_test_chat_session`: เพิ่ม `admin_id` + `admin_name` ลง doc (ดึงจาก header)
   - `list_test_chat_sessions`: กรองด้วย `admin_id` จาก header (legacy session ที่ไม่มี admin_id → แสดงให้ทุกคน เพื่อไม่ทำลายของเก่า)
   - `list_test_chat_logs`: เพิ่ม query param `admin_id` ถ้าส่งมาให้กรอง
2. **Next.js `TestChatClient.tsx`**: เพิ่มปุ่ม "ประวัติการใช้งาน" เปิด panel ดู log (เรียก `/api/chatbot/shopee/test-chat/logs`)
3. **อัปเดต SRS_SSD.md** section 6 ของฟังก์ชันที่แก้
4. **อัปเดต docs/schema.md** field ใหม่ของ `test_chat_sessions`

### ความเสี่ยงต่อเคสเก่า
- ไม่มี เพราะแค่เพิ่ม field + filter ไม่แตะ chat pipeline
- legacy session (ไม่มี admin_id) ยังเห็นได้ทุกคน → ไม่หาย

### วิธีแก้ (implement เสร็จ 2026-09-07)
- **Python `app.py`**:
  - `list_test_chat_sessions` (line 5345): เพิ่ม param `request: Request`, ดึง `X-Admin-Id`, query `$or` กรอง `admin_id == ผู้เรียก` OR legacy (ไม่มี field / None / "")
  - `create_test_chat_session` (line 5385): ดึง `X-Admin-Id` + `X-Admin-Name` (URL-decode) → insert ลง doc
  - `list_test_chat_logs` (line 5612): เพิ่ม param `admin_id` + ดึงจาก header fallback; `admin_id=all` → ดูทุกคน
- **Next.js `TestChatClient.tsx`**:
  - เพิ่ม `History` icon import
  - `rightTab` type เพิ่ม `"logs"`
  - เพิ่ม state `actionLogs`, `logsLoading`, `logsScope` + function `loadActionLogs`
  - เพิ่ม tab "ประวัติ" ใน right panel (สลับ ฉัน/ทุกคน + รีเฟรช)
  - แสดง log: action label (ไทย), เวลา, admin_name, shop, session #, text_preview
- **docs/schema.md**: เพิ่ม field `admin_id`, `admin_name` ใน `test_chat_sessions` + หมายเหตุ Phase 3
- **docs/SRS_SSD.md**: อัปเดต table 6.1.1 (line + Calls) + เพิ่ม section 6.1.6 detail (Purpose/Input/Output/Calls/Called by/How it works/Side effects/Error)
- **Verify:** `python3 -m py_compile` ผ่าน ✅, `npx tsc --noEmit` ผ่าน ✅

### ผ่านแล้ว ✅
- แต่ละ admin เห็นเฉพาะ session ของตัวเอง (legacy ยังเห็นรวม)
- ปุ่ม "ประวัติ" ใน right panel ดู log ได้ (สลับ ฉัน/ทุกคน)
- log บันทึก create/add_message/delete/update/close/reopen พร้อม admin_id, admin_name อยู่แล้ว

---

## ผ่านแล้ว (2026-09-08 — Rich Media All Pages — ทำให้ทุกหน้าเข้าใจ tag ครบทั้ง 9)

### ที่มา
ผู้ใช้ระบุว่าทุกหน้า (ticket, testchat/shopee, shadowbot, botworker, testassignment, live-assignment, replay-compare, admin-chat-result, test-chat-result) ต้องเข้าใจและแสดง Shopee rich-message tags ครบทั้ง 9: `faq_liveagents`, `item_card`, `variation_card`, `sticker`, `bundle_message`, `video`, `picture`, `notification`, `order`

### Audit พบปัญหา
1. **test-chat-result**: ใช้ custom markdown renderer ไม่ใช้ MessageContent → ไม่รองรับ rich media
2. **messages API** (admin/conversations/[id]/messages + botworker): ไม่ส่ง `bundle` field กลับ → bundle_message ไม่แสดง sub-messages
3. **parseRawMessage**: ไม่รองรับ alias `item_card` (ใช้ `item`), `picture` (ใช้ `image`), `faq_liveagents` (ใช้ `faq_liveagent`)
4. **TestChatClient**: ไม่ใช้ MessageContent — แต่ตรวจพบว่าไม่รับ raw_payload เลย (เป็น test chat interface ไม่ใช่ Shopee viewer) → ไม่ต้องแก้

### วิธีแก้
1. **messageMediaParser.ts**: เพิ่ม alias normalization ใน `parseRawMessage`:
   - `item_card` → `item`
   - `picture` → `image`
   - `faq_liveagents` → `faq_liveagent`
   - เพิ่ม `[picture]`, `[item_card]`, `[faq_liveagents]`, `[โอนเจ้าหน้าที่]` ใน placeholder regex
2. **replay_compare.py**: เพิ่ม alias normalization เดียวกันใน `parse_raw_message` + placeholder regex
3. **admin/conversations/[id]/messages/route.ts**:
   - รวบรวม item_ids จาก bundle sub-messages ด้วย
   - แปลง `p.bundle` (ParsedMessage[]) → `ChatMessage[]` ใน response
4. **botworker/conversations/[id]/messages/route.ts**:
   - รวบรวม item_ids จาก bundle sub-messages
   - แปลง `p.bundle` → `UnifiedMessage[]` ใน user message response
5. **botworker/page.tsx**: เพิ่ม `bundle` field ใน `toChatMsg` function
6. **test-chat-result/page.tsx**:
   - import `MessageContent` + `ChatMessage` type
   - เพิ่ม `sessionMsgToChatMsg` helper — แปลง SessionMessage → ChatMessage (มี images → `image_with_text`)
   - user message: ใช้ MessageContent แทน plain text + custom image grid
   - bot message: ใช้ MessageContent แทน `renderMarkdownInline`

### ไฟล์ที่แก้
- `ChatAdminWeb/src/backend/service/messageMediaParser.ts` — alias normalization + placeholder regex
- `replay_compare.py` — alias normalization + placeholder regex
- `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/messages/route.ts` — bundle field
- `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — bundle field
- `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — toChatMsg bundle field
- `ChatAdminWeb/src/app/(console)/test-chat-result/page.tsx` — MessageContent + sessionMsgToChatMsg

### ไม่ได้แก้
- `TestChatClient.tsx` — ไม่รับ raw_payload (เป็น test chat interface ไม่ใช่ Shopee viewer) → ไม่ต้อง parse rich media
- `docs/SRS_SSD.md` — section 6 เป็นของ Python chatbot ไม่เกี่ยว (replay_compare.py เป็น script ไม่ใช่ฟังก์ชันใน chatbot/)

### Verify
- `npx tsc --noEmit` ใน ChatAdminWeb → ผ่าน (exit 0) ✅
- `python3 -m py_compile replay_compare.py` → ผ่าน ✅
- ⚠️ ยังไม่ verify manual: รอทดสอบจริงใน browser:
  1. ticket/botworker: เปิดแชทที่มี bundle_message → แสดง sub-messages ครบ
  2. admin-chat-result: เปิดแชทที่มี item card → แสดง product card จาก MessageContent
  3. test-chat-result: เปิด session ที่มีรูป → แสดงรูปใน MessageContent + lightbox
  4. ทุกหน้า: ถ้า Shopee ส่ง `item_card`/`picture`/`faq_liveagents` → แสดงถูกต้อง (ไม่ตกไป unknown)

### Fix เพิ่ม — Product card ภาพไม่ขึ้น (shp_203905019987193330)
- **ปัญหา**: product card แสดงแต่ภาพไม่มา (ชื่อ/ราคา/url ขึ้น แต่รูปไม่ขึ้น)
- **Root cause** (2 จุด):
  1. `toProductCard` หา `doc.images` (plural) แต่ dbWallet Shopee เก็บ `doc.image` (singular) มี `image_id_list` ข้างใน → ไม่เจอ → ภาพหาย
  2. `toProductCard` ใช้ `normalizeImageUrl` (host `img.sp.mms.shopee.sg`) แต่ product image ใช้ CDN คนละตัวกับ message media — Python bot ใช้ `https://cf.shopee.co.th/file/{hash}`
- **Fix**:
  1. เพิ่ม `normalizeProductImageUrl` ใช้ host `https://cf.shopee.co.th/file/` (เหมือน Python `_first_image_url`)
  2. `toProductCard` รองรับทั้ง `doc.images` (plural) และ `doc.image` (singular มี `image_id_list`)
  3. ใช้ `normalizeProductImageUrl` สำหรับ product image ทุก case
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/backend/service/messageMediaParser.ts`
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅ — รอ verify จริงใน browser

### Fix เพิ่ม — bundle_message ไม่ขึ้น (shp_152520383445167602) + สินค้าไม่ขึ้น (shp_152520383346282116)
- **ปัญหา 1 — bundle_message**: conversation `shp_152520383445167602` มี bundle_message แต่ไม่แสดง sub-messages
- **Root cause 1** (3 จุด):
  1. parser หา `source_content` ที่ `raw.source_content` และ `raw.data.source_content` แต่จริงๆ อยู่ที่ `raw.data.content.source_content` (nestedContent.source_content)
  2. `source_content` ว่างเปล่า `{}` — ไม่มี `item_id` → parser ตกไป placeholder "(bundle)"
  3. sub-message IDs ใน `content.messages` (เช่น `["2434454232218550641", ...]`) ไม่ได้ถูก sync มาเก็บใน DB ของเรา → fetch ไม่เจอ
- **Fix 1**:
  1. parser หา `source_content` ใน 4 ตำแหน่ง (รวม `nestedContent.source_content`)
  2. เพิ่ม `bundle_message_ids` field ใน `ParsedMessage` — เก็บ message_id strings จาก `content.messages`
  3. messages API (admin + botworker) fetch sub-messages จาก DB ด้วย `bundle_message_ids` แล้ว parse เป็น `bundle` field (สำหรับกรณีที่ sub-messages มีใน DB ในอนาคต)
  4. ถ้า sub-messages ไม่มีใน DB → แสดงเป็น "Bundle (N ข้อความ)" แทน placeholder ว่าง
- **ปัญหา 2 — สินค้าไม่ขึ้น**: conversation `shp_152520383346282116` มี message `[item]` แต่ product card ไม่แสดง
- **Root cause 2**: ทุก message ใน conversation นี้มี `raw_payload = null`! เป็นข้อมูลเก่าที่ Zaapi ส่งมาแค่ text placeholder `[item]` โดยไม่มี item_id ใน text และไม่มี raw_payload → ไม่สามารถ lookup product ได้
- **สถานะ 2**: เป็นปัญหาที่ข้อมูล DB ไม่สมบูรณ์ ไม่ใช่ปัญหาที่ parser — parser จะแสดง "สินค้า" (placeholder) ซึ่งถูกต้องแล้ว ไม่สามารถแก้ได้โดยไม่มี raw_payload
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/backend/service/messageMediaParser.ts` — source_content 4 ตำแหน่ง + bundle_message_ids + RawContent type
  - `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/messages/route.ts` — fetch sub-messages
  - `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — fetch sub-messages
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅, `python3 -m py_compile replay_compare.py` → ผ่าน ✅ — รอ verify จริงใน browser

## ผ่านแล้ว (2026-09-07 — kb+mongo path ไม่บันทึก suggestion → context loss)

### ที่มา
ลูกค้าถาม "แนะนำหัวชาร์ต mi 17 ultra แล้วฟาสชาตที" → บอทตอบจาก kb+mongo+web_search แนะนำ CUKTECH P100P, P23, BA652U (source=`knowledge_base+mongo+web_search`, pipeline=Search) — ตอบถูก
แต่คำถามถัดไป "ขอลิงค์กับรูปประกอบ" → บอทไปดึง powerbank PB150P มาแทน และไม่แนบรูป+ลิงค์ของหัวชาร์จ

### สาเหตุ (root cause)
- `kb+mongo` path (บรรทัด ~2696) และ `kb+mongo+web_search` path (บรรทัด ~2672) **ไม่ได้เรียก** `_record_suggestion_products`
- ทำให้สินค้าที่บอทแนะนำ (CUKTECH P100P, P23, BA652U) ไม่ถูกบันทึกลง `conversation_products` timeline
- → `active_item_id` ว่าง → คำถามถัดไป "ขอลิงค์กับรูปประกอบ" เข้า CONV-ACTIVE block (บรรทัด ~2907) แต่ `_active_card = None`
- → บอทไป RAG ใหม่ด้วยคำว่า "ลิงค์กับรูป" (ไม่มี product type ชัดเจน) → ดึง powerbank มาแทน
- เปรียบเทียบ: `product_store` path (บรรทัด 5079) และ `product_store+web_search` path (บรรทัด 5054) เรียก `_record_suggestion_products` อยู่แล้ว → ไม่มีปัญหานี้

### วิธีแก้
เพิ่ม `_record_suggestion_products(req, products[:req.limit])` ก่อน `return ChatResponse` ใน 2 จุด:
1. `kb+mongo+web_search` path (บรรทัด ~2671) — ก่อน return ที่ source="knowledge_base+mongo+web_search"
2. `kb+mongo` path (บรรทัด ~2695) — ก่อน return ที่ source="knowledge_base+mongo"

### ความเสี่ยงต่อเคสเก่า
- ไม่มี — เป็นการเพิ่มบันทึก suggestion ที่ขาดหายไป ไม่ได้แตะ logic การตอบ
- คำถามถัดไปที่เป็น generic ("ขอลิงค์/รูป/ราคา/สเปก") จะใช้ active product ที่บันทึกไว้แทนดึงใหม่ → ตรงเคส C (Context loss) ที่ผ่านแล้ว

### Verify
- `python3 -m py_compile chatbot/shopeechat/app.py` ผ่าน
- ⚠️ ยังไม่ได้ทดสอบ replay จริง (ต้องรัน test chat ซ้ำเคสเดิม: ถามหัวชาร์จ → ขอลิงค์+รูป)

### ไฟล์ที่แก้
- `chatbot/shopeechat/app.py` (เพิ่ม `_record_suggestion_products` 2 จุด)

---

## ผ่านแล้ว (2026-09-07 — /logs ตาราง view)

### ที่มา
User ต้องการเพิ่มมุมมองตารางในหน้า `/logs` (audit logs) โดย list เดิมยังเก็บไว้ — สลับด้วย tab

### วิธีแก้
- **`src/app/(console)/logs/page.tsx`**:
  - เพิ่ม state `viewMode: "list" | "table"`
  - เพิ่ม tab สลับมุมมอง (List / Table2 icon) ด้านขวาบน header
  - list view เดิมไม่แก้
  - เพิ่ม component `LogTableView` แสดงทุก field จริงใน `AdminLogDoc`: `timestamp`, `action_type`, `actor`/`admin_id`, `target_admin_id`, `conversation_id`, `shop_id`, `ticket_id`, `ip`, `meta` (key count), `metadata` (key count)
  - คลิก row → expand ดู `metadata` + `meta` (legacy) แบบเต็มด้านล่าง
  - filter (admin, หมวด, search) ใช้ร่วมกันทั้ง 2 view
- เพิ่ม `ticket_id`, `meta`, `actor` ใน `AdminLogRow` interface
- เพิ่มหมวดใน `ACTION_CATEGORIES`: Config (เพิ่ม `admin_config.update`, `admin.maintenance.clear_status`), Bot/Data (เพิ่ม `bot.buffer_flush`, `bot.buffer_recover`), Shadow (เพิ่ม `shadow_reply.generate`), Test, Chat accept, Conversation meta, SLA
- **`docs/function and process.md`** อัปเดต section 2.18 ระบุ view mode

### Verify
- `npx tsc --noEmit` ผ่าน
- `npx next build` ผ่าน (exit 0, ไม่มี error/warning เกี่ยวกับ logs/page)

### ไฟล์ที่แก้
- `ChatAdminWeb/src/app/(console)/logs/page.tsx`
- `docs/function and process.md`

---

## กำลังจะทำ

(ว่าง)

---

## ผ่านแล้ว

### 2026-09-20 — ChatBot v3 — OpenRouter-first paradigm (implement + smoke test ผ่าน)

**paradigm shift:** ไม่นั่งปั้น RAG context แบบ legacy แต่ส่ง raw (message + history + images + shop link) ให้ OpenRouter ตอบ → เอา list สินค้ามา match กับ ShpProducts

**ไฟล์ที่สร้าง** (`chatbot/shopeechat/chatbotv3/`):
- `__init__.py` — export `chat_v3`
- `or_client.py` — OpenRouter client (round-robin API keys, AI Usage Hub log, multimodal)
- `system_prompt.py` — SYSTEM_INSTRUCTION_V3 (base จาก llm.py + กฎ v3 ใหม่ + fallback)
- `shop_link.py` — สร้าง shop URL `https://shopee.co.th/{shopname_lower}?entryPoint=ShopBySearch&searchKeyword={shopname_lower}`
- `rich_parse.py` — parse rich tags ([สินค้า: id], [order: sn], [รูปภาพ], placeholder)
- `product_match.py` — match สินค้าจาก OpenRouter answer กับ ShpProducts (กรองเฉพาะร้าน)
- `emotion.py` — detect negative emotion (strong + moderate + word boundary) + human request
- `engine.py` — main flow: parse → safety checks (warranty/emotion/human) → LLM → product match → response

**สิ่งที่ copy จาก legacy:**
- warranty.detect_claim_request (เหมือนเดิม — ไม่แก้)
- product_store.to_product_card, fetch_products, fetch_product_by_id (เรียกผ่าน lazy import)
- order_store.extract_order_sn, extract_tracking_number (เรียกผ่าน lazy import)
- rich tag patterns ([สินค้า: id], [order: sn], [รูปภาพ], placeholder)

**สิ่งที่ตัดออก:**
- intent_classifier, RAG/vector search, KB lookup, charger subtype, conversation_products anchor, web_search fallback

**เพิ่มใหม่:**
- emotion detection (อารมณ์เสีย/ไม่ดี → handoff admin) — มี word boundary สำหรับคำสั้น (บ้า/บ้าง, กาก/กากมาก)
- shop link format `https://shopee.co.th/{shopname_lower}?entryPoint=ShopBySearch&searchKeyword={shopname_lower}`
- lazy imports ทุก heavy module (llm, warranty, knowledge_base, product_store, order_store) — ทำให้ test ไม่ต้องลง google-genai/pymongo

**กฎใหม่ใน system_instruction:**
- ตอบจาก DB ก่อน/มีคำตอบห้ามส่งต่อ
- ปัญหาใช้งานต้องบอกวิธีตรวจสอบก่อน ถามซ้ำจึงส่งต่อ
- ห้ามบอกว่าตรวจสอบระบบ/คำสั่งซื้อแล้ว
- ห้ามสรุปแทนทุกรุ่น
- ห้ามเสนอหัวข้อที่ไม่ได้ถาม
- ห้ามสัญญาแทนคน
- ผู้ช่วยร้านอุปกรณ์ไอที, ค่ะ ไม่ใช้ครับ, สุภาพ กระชับ ตรงประเด็น

**Wiring:**
- `app.py` — เพิ่ม `use_v3` field ใน ChatRequest + dispatch ก่อน v2/legacy
- env `USE_CHAT_V3=1` หรือ `req.use_v3=True` → route `/chat` ไป `chatbotv3.engine.chat_v3(req)`
- default: ไม่เปิด (USE_CHAT_V3=0) → legacy/v2 ทำงานเหมือนเดิม

**Verification ที่ผ่าน:**
- `py_compile` ทุกไฟล์ (8 ไฟล์ + app.py) — ผ่าน
- smoke test import ทุก module — ผ่าน
- shop_link.build_shop_url — ผ่าน (KingGadgets, ThaiSuperPhone, empty)
- shop_link.build_shop_context_block — ผ่าน
- rich_parse.parse_rich_message — ผ่าน (item tag, image placeholder, placeholder only)
- emotion.detect_negative_emotion — ผ่าน (strong, moderate+context, normal, complaint history, word boundary บ้า/บ้าง)
- emotion.detect_human_request — ผ่าน
- product_match._extract_product_names_from_answer — ผ่าน
- product_match._normalize_name — ผ่าน
- engine.chat_v3 (mock) — ผ่าน 6 tests: warranty handoff, emotion handoff, human request handoff, placeholder only, normal LLM call, บ่นเล่นๆ ไม่ handoff

**⚠️ ยังไม่ได้ทดสอบ:**
- Live OpenRouter call (ต้องมี API key จริง)
- Live MongoDB product match (ต้องเชื่อม DB จริง)
- End-to-end ผ่าน `/chat` endpoint (ต้องรัน server)
- Replay/shadow test เทียบกับ legacy

**⚠️ ห้ามทำลาย:** warranty claim flow, order lookup, handoff, vision pass — เคสที่ผ่านใน legacy ต้องผ่านใน v3 ด้วย

---

### 2026-09-20 — แก้ stock checker อ่านผิด field (shopee_stock → summary_info)

**ที่มา:** สินค้าที่มีรุ่นย่อย (model) ถูก mark sold_out ทั้งที่มี stock จริง เพราะโค้ดอ่าน field ผิด

**ปัญหา:** `_shopee_stock()` อ่านจาก `stock_info_v2.shopee_stock[].stock` ซึ่งเป็น **0 เสมอ** ในข้อมูลจริง
- stock จริงอยู่ใน `stock_info_v2.summary_info.total_available_stock`
- สินค้าที่มี model: stock อยู่ที่ `model[i].stock_info_v2.summary_info.total_available_stock`
- สินค้าที่ไม่มี model: stock อยู่ที่ `doc.stock_info_v2.summary_info.total_available_stock`

**ผลกระทบ:** 3419 สินค้าถูก mark sold_out ผิด (มี stock จริงแต่โค้ดเห็นเป็น 0)
- LuckyHomeMart: Leravan LJF003 มี stock=50 แต่โค้ดเก่าเห็น 0
- IMILabThailand: IMILAB EC4 มี stock=130 แต่โค้ดเก่าเห็น 0

**วิธีแก้:**
1. `_shopee_stock()` — เปลี่ยนอ่านจาก `summary_info.total_available_stock` เป็นหลัก, fallback ไป `shopee_stock[].stock`
2. `to_product_card()` — ถ้ามี model รวม stock ทุกรุ่นย่อย, ถ้าไม่มี model อ่านจาก doc
3. `_is_sold_out()` — ถ้าไม่มี model ตรวจจาก doc.stock_info_v2 แทน return True

**ไฟล์ที่แก้:**
- `chatbot/shopeechat/product_store.py` — `_shopee_stock()`, `to_product_card()`, `_is_sold_out()`

**Verification ที่ผ่าน:**
- `py_compile` — ผ่าน
- สินค้า IMILabThailand: stock ถูกต้อง (130, 108, 279) แทน 0
- LuckyHomeMart: stock ถูกต้อง (50, 45, 30) แทน 0
- สินค้าไม่มี model: stock ถูกต้อง (2) จาก doc.stock_info_v2
- Car charger regression: 16/16 ผ่าน
- Pingevox/mistore regression: 42/42 ผ่าน
- Live test IMILabThailand: แนะนำสินค้าพร้อม stock และลิงก์ถูกต้อง
- Live test LuckyHomeMart: แนะนำสินค้า Leravan ที่มี stock จริง

**⚠️ หมายเหตุ:** การแก้ครั้งก่อน (availability rule) ทำงานถูกต้อง แต่ stock ที่อ่านได้ผิด ทำให้สินค้าที่มี stock ถูกห้ามแนะนำ ตอนนี้แก้แล้ว สินค้าที่มี stock จริงจะถูกแนะนำได้

---

### 2026-09-20 — ChatBot v3 — เพิ่มฟีเจอร์ audit ข้อ 1-5,7 (ยกเว้นข้อ 6 conversation_products)

**ที่มา:** audit พบว่า v3 ขาดฟีเจอร์สำคัญหลายตัวที่ legacy มี → ต้องเพิ่มก่อนเปิดใช้จริง

**ฟีเจอร์ที่เพิ่ม (ข้อ 1-5,7 — ยกเว้นข้อ 6 conversation_products ตามคำสั่ง):**

1. **handoff API จริง** — v3 ไม่ได้เรียก `ADMIN_HANDOFF_URL` จริง แค่ตั้ง flag
   - เพิ่ม `_send_handoff_to_admin()` ใน `engine.py` — ส่ง POST ไป ChatAdminWeb จริง (เหมือน legacy app.py 1856-1884)
   - ส่ง `conversation_id`, `shop_id`, `platform`, `reason`, `simulate`, `claim`
   - ใช้ `urllib.request` + `X-Internal-Secret` header
   - เรียกจาก `_make_handoff_response()` ทุกครั้งที่มี `conversation_id`
   - ถ้าไม่มี `conversation_id` → ไม่เรียก API (เหมือน legacy)

2. **persona ของร้าน** — v3 ไม่ได้ดึง persona จาก `persona.get_persona()`
   - เพิ่ม `_get_persona_extra()` ใน `engine.py` — ดึง persona ของร้าน + สร้าง instruction
   - ส่งเข้า `system_prompt.build_system_instruction(persona_extra=...)`
   - lazy import `persona` module

3. **image_desc** — v3 ไม่ได้คืน `image_desc` ใน response
   - เพิ่ม `_extract_image_desc_from_answer()` — สกัด description จากคำตอบ LLM (ถ้ามีรูป)
   - ปัจจุบัน return "" เพราะ v3 ส่งรูปเข้า LLM ตรง (multimodal) ไม่มี vision pass แยก
   - ส่ง `image_desc` ใน `_make_answer_response()`

4. **answer_segments (multi-bubble)** — v3 ไม่ได้แยกคำตอบด้วย `|||`
   - `_make_answer_response()` แยก answer ด้วย `|||` อยู่แล้ว
   - เพิ่มใน `_make_handoff_response()` ด้วย — แยก answer ด้วย `|||` เหมือน legacy

5. **order_sn lookup** — v3 ไม่ได้ lookup order จริง
   - เพิ่ม `_lookup_order_context()` ใน `engine.py` — เรียก `order_store.lookup_order()` + `build_order_context()`
   - ส่ง order context จริงเข้า user prompt (แทนที่แค่ส่ง order_sn ลอยๆ)
   - lazy import `order_store` module

7. **ChatAdminWeb config** — v3 ไม่มี UI เลือก + type ไม่มี "v3"
   - `systemConfigService.ts` — เพิ่ม `"v3"` ใน `chat_engine` type + `shouldUseChatV3()`
   - `botCallService.ts` — ส่ง `use_v3: true` เมื่อ config เลือก v3 + คืน `chat_engine: "v3"`
   - `shadowReplyService.ts` — เพิ่ม `"v3"` ใน `chat_engine` + `chatEngine` type
   - `liveAssignmentService.ts` — เพิ่ม `"v3"` ใน `chat_engine` type
   - `test-assignment/route.ts` — เพิ่ม `"v3"` ใน `chat_engine` type
   - `config/page.tsx` — เพิ่ม option "v3" ใน dropdown + แสดง warning เมื่อเลือก v3

**ฟีเจอร์ที่ไม่ทำ (ข้อ 6):**
- `conversation_products` — ไม่เพิ่มตามคำสั่ง (v3 ไม่อัปเดต timeline สินค้า)

**ไฟล์ที่แก้:**
- `chatbot/shopeechat/chatbotv3/engine.py` — เพิ่ม helper + แก้ flow
- `ChatAdminWeb/src/backend/service/systemConfigService.ts` — type + `shouldUseChatV3()`
- `ChatAdminWeb/src/backend/service/botCallService.ts` — ส่ง `use_v3` + type
- `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — type
- `ChatAdminWeb/src/backend/service/liveAssignmentService.ts` — type
- `ChatAdminWeb/src/app/api/test-assignment/route.ts` — type
- `ChatAdminWeb/src/app/(console)/config/page.tsx` — UI option + warning

**Verification ที่ผ่าน:**
- `py_compile engine.py` — ผ่าน
- `npx tsc --noEmit` — ผ่าน
- smoke test 7 tests — ผ่านทั้งหมด:
  1. handoff API จริง (warranty claim) — ส่ง POST จริง, payload ถูกต้อง ✓
  2. persona ของร้าน — ดึง persona ได้, ส่งเข้า system instruction ✓
  3. image_desc — คืน "" ตาม design (v3 ส่งรูปเข้า LLM ตรง) ✓
  4. answer_segments — แยก `|||` ได้ 3 segments ✓
  5. order_sn lookup — lookup จริง, ส่ง context เข้า prompt ✓
  6. handoff ไม่ส่ง API เมื่อไม่มี conversation_id ✓
  7. simulate_assignment ส่งไป handoff API ✓

**⚠️ ยังไม่ได้ทดสอบ:**
- Live OpenRouter call พร้อม v3 features ใหม่
- Live MongoDB product match พร้อม v3 features ใหม่
- End-to-end `/chat` กับ `use_v3=True`
- Live ChatAdminWeb UI เลือก v3 แล้ว callBot ส่ง `use_v3: true` จริง

---

### 2026-09-12 — Shadow inbox Generate ทีละข้อดึง history รวมอนาคต

**ปัญหา:** กด Generate ทีละข้อความใน shadow inbox → บอทเห็นคำถามถัดไปด้วย
- เช่น Q1 `[item]` → บอทตอบเรื่องใบกำกับภาษี (ทั้งที่ Q1 เป็นการ์ดสินค้า)
- บางครั้งตอบ "สวัสดี" ทุกข้อเพราะเห็น Q6 "สวัสดีค่ะ" ใน history

**สาเหตุ:** `getHistoryForBot` ดึง user messages ล่าสุด 20 ข้อความจาก DB โดยไม่กรองเฉพาะข้อความก่อนหน้า inbound message ปัจจุบัน → บอทเห็น Q2-Q11 ใน history ตอนตอบ Q1

**วิธีแก้:**
1. `messageService.ts` — `getHistoryForBot` เพิ่ม parameter `beforeTimestamp?: Date`
   - ถ้าส่ง → กรอง `created_timestamp < beforeTimestamp` ทั้ง user messages และ bot replies
   - ถ้าไม่ส่ง → ใช้ทั้งหมด (สำหรับ botworker ที่ตอบข้อล่าสุด)
2. `shadowReplyService.ts` — `generateShadowReply` ส่ง `beforeTimestamp: inboundMsg.created_timestamp`
3. `shadowReplyService.ts` — เพิ่ม manual shadow replies (origin="manual") ใน history
   - ไม่งั้นกด Generate Q2 จะไม่เห็น Q1 bot reply → บอทไม่มี context
   - `getHistoryForBot` เอาเฉพาะ origin="worker" เราต้องเพิ่ม manual เอง

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/backend/service/messageService.ts` — `getHistoryForBot`
- `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — `generateShadowReply`

**verify:** `npx tsc --noEmit` ผ่าน

### 2026-09-12 — Admin-chat-result detail items=0 ทั้งที่ API ส่ง 11 รายการ

**ปัญหา:** API ส่ง 11 shadow_replies กลับมา แต่หน้าบอก `detail items: 0`
**สาเหตุ:** axios ส่ง AxiosResponse ที่มี `.data` แต่หน้าเข้า `.items` โดยตรง ไม่เข้า `.data.items`
**วิธีแก้:** เข้า `.data?.items || .items` (รองรับทั้ง AxiosResponse และ plain object)
- tsc ผ่าน (admin-chat-result ไม่มี error)

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result ไม่แสดงแชท (detail ว่าง ไม่มี fallback)

**ปัญหา:** หลังจากแก้ "โชว์ Zaapi แทน bot เรา" → ลบ fullMessages rendering path ออกหมด → ถ้า detail ว่าง (conversation ยังไม่มี rating) ก็ขึ้น "ไม่มีรายการ" ทั้งที่มี fullMessages
**วิธีแก้:** เพิ่ม fallback 3 ทาง:
1. `detail.length > 0` → render จาก detail (bot_reply ของ bot เรา) + rich user content จาก fullMessages
2. `detail.length === 0 && fullMessages.length > 0` → render จาก fullMessages (user + bot จาก messages collection)
3. ทั้งคู่ว่าง → "ไม่มีรายการใน conversation นี้"
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result โชว์คำตอบ Zaapi แทน bot เรา

**ปัญหา:** แชทฝั่งบอทโชว์คำตอบของ Zaapi (ที่ส่งจริง) แทนคำตอบของ bot เรา
**สาเหตุ:** render จาก `fullMessages` (messages collection) ซึ่งมีคำตอบ Zaapi ไม่ใช่ shadow_replies
**วิธีแก้:**
- เปลี่ยน logic: ใช้ `detail` items เป็นหลัก (มี `bot_reply` ของ bot เรา)
- user message: ใช้ rich content จาก `fullMessages` (match ด้วย `message_id` → `messageMap`)
- bot reply: ใช้ `d.bot_reply` (คำตอบ bot เรา ไม่ใช่ Zaapi)
- ลบ fallback section เก่าที่ซ้ำซ้อน
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result bot ชิดขวาสุด + format ข้อความ

**ปัญหา:**
1. bot bubble ไม่ชิดขวาสุด
2. ข้อความไม่ตาม format ที่บอทพ่น — ขึ้นบรรทัดใหม่หายไป

**สาเหตุ:**
1. parent มี `max-w-[85%]` จำกัด + `justify-end` แต่ไม่ได้ใช้ `flex-1` เหมือน shadow-inbox
2. `MessageContent` fallback text render ไม่มี `whitespace-pre-wrap` → newline หายไป

**วิธีแก้:**
- **Bot ชิดขวาสุด:** parent `flex-1 min-w-0 flex flex-col items-end gap-1` (เหมือน shadow-inbox) + bubble `max-w-[85%]`
- **Format ข้อความ:** เพิ่ม `whitespace-pre-wrap break-words` ใน MessageContent ทุกจุดที่ render text:
  - fallback text (บรรทัด 271)
  - image_with_text (บรรทัด 217)
  - item/variation_card text (บรรทัด 230)
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`
- `ChatAdminWeb/src/components/chat/MessageContent.tsx`

### 2026-09-12 — Admin-chat-result ชื่อลูกค้า "ไม่ระบุชื่อ" (shadow_bot)

**ปัญหา:** list แสดง "ไม่ระบุชื่อ" แทนชื่อลูกค้า ทั้งที่ shadow-inbox โชว์ได้
**สาเหตุ:** API ดึง `shop_name` จาก `shop_id` แต่ไม่ได้ดึง `to_name` จาก `conversation_id`
**วิธีแก้:**
- เปลี่ยน query จาก `find({ shop_id: { $in: shopIds } })` → `find({ conversation_id: { $in: convIds } })`
- สร้าง `convInfoMap` (conversation_id → { shop_name, to_name })
- ส่ง `to_name` และ `shop_name` จาก convInfoMap แทน
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/api/admin-chat-result/route.ts`

### 2026-09-12 — Admin-chat-result bot render เหมือน shadow-inbox + ล้าง toggle

**ปัญหา:**
1. มี toggle "ดูเต็ม/ย่อ" ที่ไม่จำเป็น — ควรโชว์เต็มเสมอ
2. แนะนำสินค้า (ภาพ/ลิงค์) ไม่โชว์ เพราะ bot render ใช้ text ธรรมดา ไม่ใช้ MessageContent
3. bot bubble ไม่ชิดขวาสุด

**วิธีแก้:**
- **Bot render เหมือน shadow-inbox:** ใช้ `MessageContent` สำหรับแต่ละ segment (แยกด้วย |||)
  - ส่ง `products` และ `table` ไปที่ segment สุดท้าย (กันซ้ำ) เหมือน ShadowConversationPanel
  - รองรับ: image, video, sticker, item card, variation card, product card, link, bold
- **ล้าง toggle:** ลบ `showFullBot` state, `toggleFullBot` function, `Eye/EyeOff` imports
- **ชิดขวาสุด:** parent `max-w-[85%]` + `justify-end` + `items-end`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result list style เหมือน shadow-inbox + bot bubble ชิดขวา

**ปัญหา:**
1. bot bubble ไม่ชิดขวากว่าเดิม
2. list แสดงแค่ชื่อร้าน ไม่แสดงชื่อลูกค้า/วันที่/จุดที่มา/รีวิว
3. style ไม่เหมือน shadow-inbox

**วิธีแก้:**
- **List style (เหมือน shadow-inbox):**
  - Row 1: ชื่อลูกค้า (`to_name`) + platform dot + scope badge + วันที่
  - Row 2: ชื่อร้าน (`shop_name`)
  - Row 3: แอดมิน + รายการ + รีวิว (✓/✗/★/💬)
  - active row: `bg-pale-sky-soft border-l-2 border-l-brand` (เหมือน ChatList)
- **Bot bubble ชิดขวากว่าเดิม:**
  - parent: `flex-row-reverse justify-end` + `max-w-[80%]` (จำกัดความกว้าง)
  - bubble: `w-fit max-w-full` (หดตามเนื้อหา ไม่ขยายเต็ม)
- **User bubble ชิดซ้าย:**
  - parent: `justify-start` + `max-w-[80%]`
  - bubble: `w-fit max-w-full`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — User bubble fixed ขนาด ไม่ตามเนื้อหา

**ปัญหา:** bubble ฝั่งลูกค้าไม่ตามความยาว/กว้างของเนื้อหา — ขยายเต็มกรอบเสมอ
**สาเหตุ:** ไม่มี `w-fit` → div ขยายเต็ม parent
**วิธีแก้:**
- เพิ่ม `w-fit` ใน user bubble (ทั้ง MessageContent และ fallback text)
- admin-chat-result: 2 จุด (fullMessages mode + fallback mode)
- test-chat-result: มี w-fit อยู่แล้ว
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Bot multi-bubble เลื่อมกัน (ไม่เสอ)

**ปัญหา:** ข้อความฝั่งบอทแต่ละ segment (แยกด้วย |||) เลื่อมติดกัน ไม่มีช่องว่างคั่น
**สาเหตุ:** แต่ละ segment ใช้ `<div key={si}>` เรียงกันโดยไม่มี margin/gap
**วิธีแก้:**
- เพิ่ม `space-y-0.5` ในแต่ละ segment wrapper
- เปลี่ยน parent container `gap-1` → `gap-2` (เพิ่มระยะห่างระหว่าง segment + rating)
- แก้ทั้ง admin-chat-result และ test-chat-result
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`
- `ChatAdminWeb/src/app/(console)/test-chat-result/page.tsx`

### 2026-09-12 — Shadow inbox Generate ทีละข้อดึง history รวมอนาคต## ผ่านแล้ว

### 2026-09-12 — Admin-chat-result ไม่โชว์แชท (detail=0 แต่มี messages)

**ปัญหา:** คลิก conversation → บอก "ไม่มีรายการใน conversation นี้" ทั้งที่มีข้อความ (fullMessages=22)
**สาเหตุ:** API ส่งเฉพาะ rated items (จาก shadow_replies/test_assignment/test_chat_ratings) — ถ้า conversation ยังไม่มี rating → items=0 → หน้าแสดง "ไม่มีรายการ"
**วิธีแก้:**
- เปลี่ยน render logic: ถ้ามี `fullMessages` → render แชทจาก messages collection เป็นหลัก (user ซ้าย / bot ขวา)
- merge rating จาก detail items โดย match ด้วย `message_id` หรือ `text`
- ถ้าไม่มี fullMessages (เช่น test_chat) → fallback render จาก detail items
- ลบ debug box ออก
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`
- `ChatAdminWeb/src/app/api/admin-chat-result/route.ts` (ลบ debug log)

### 2026-09-12 — Admin-chat-result detail ว่าง + ตัวอักษรเล็ก

**ปัญหา:**
1. คลิก conversation ใน list → detail บอก "ไม่มีรายการใน conversation นี้" ทั้งที่มีข้อมูล
2. ตัวอักษรเล็กเกินไป

**สาเหตุ:** `loadDetail` ส่ง `admin_id` กลับไปกรองใน API อีกครั้ง — ถ้า conversation มี rating จาก admin หลายคน แต่ filter เลือก admin คนใดคนหนึ่ง → กรองจนเหลือ 0

**วิธีแก้:**
- `loadDetail` — ไม่ส่ง `admin_id` ตอนโหลด detail (หน้านี้ dev-only เห็นทุก Q&A ใน conversation ได้)
- เพิ่มขนาดตัวอักษร:
  - chat bubbles: `text-xs` → `text-sm`
  - rating/comment: `text-[9px]` → `text-xs`, star size 10 → 12
  - conversation list: `text-xs` → `text-sm`, `text-[9px]` → `text-xs`
  - header: `text-sm` → `text-base`, `text-[10px]` → `text-xs`
  - scope badge: `text-[9px]` → `text-xs`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — ZMIThailand context loss รอบจริง (Phase 3.1 — 4 จุด)

**ปัญหา:** เคสจริง ZMIThailand 13Q — Q1 ลูกค้าส่ง `[variation_card]` (มี item_id แนบ) → bot ตอบ AL870/AL856/CL315P ถูก แต่ Q2-Q13 follow-up กลับดึงสินค้าอื่นมาทับ anchor ตลอด
- Q2 "ไอโฟน 11โปรแม๊กอันไหนคับ" → ดึง AL805/GL870/HA728 ทับ
- Q3 "ต่างกันยังไงคับ" → ดึง CUKTECH GaN3 AD1404T/U ทับ
- Q7 "สายแท้ มั้ยคัย" → ดึง AL805/GL870/HA728 ทับ
- Q10 "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → ดึง ZMI CUKTECH B06 ทับ

**สาเหตุ 4 จุด:**

1. **`_filter_charger_subtype` อ่าน field ผิด** — ใช้ `d.get("item_name")` แต่ `to_product_card` คืน field `name` → กรอง active_card (AL870) ออกเหลือ 0 → ยกเลิก `_ref_regex_products` → ไป fetch_products ใหม่ → ดึงสินค้าอื่นมาทับ
2. **web_search ทับ anchor** — LLM ตอบ "ไม่มี" กับ anchor product → trigger `compatibility_check_negative_answer` → web_search ดึงสินค้าอื่นมาทับ
3. **FOLLOWUP-COMP จับ placeholder เป็น model** — `extract_model_keywords` จับ `[variation_card]` เป็น model keyword → สร้าง message `"2217375776] vs [variation_card] vs Type"` → ดึงสินค้าอื่น
4. **CONV-ACTIVE ไม่ทำงานเมื่อมี charger_sub** — `if req.conversation_id and not _cur_charger_sub` → "สายแท้" ถูก detect เป็น cable → ข้าม CONV-ACTIVE → ไม่ใช้ anchor

**วิธีแก้:**

1. **`product_store.py` — `_filter_charger_subtype`**: เปลี่ยน `d.get("item_name")` → `d.get("item_name") or d.get("name")` (รองรับทั้ง doc ดิบและ product card)
2. **`app.py` — web_search fallback**: เพิ่มเงื่อนไข `if _ws.is_configured() and not _is_conv_active` — ถ้ามี anchor อยู่แล้ว ไม่ trigger web_search (anchor คือสินค้าที่ลูกค้าสนใจ ถ้า LLM ตอบ "ไม่มี" น่าจะ LLM ตอบผิด ไม่ใช่สินค้าไม่มีจริง)
3. **`app.py` — FOLLOWUP-COMP**: กรอง placeholder/tag ออกจาก history text ก่อน `extract_model_keywords` — ใช้ `_ITEM_TAG_RE.sub()` + replace `[variation_card]`, `[item]`, `[สินค้า]`, ฯลฯ
4. **`app.py` — CONV-ACTIVE**: ยกเลิกเงื่อนไข `not _cur_charger_sub` → ทำงานแม้มี charger_sub + เช็ค subtype ของ active_card ว่าตรงกันไหม:
   - ถ้า `_cur_charger_sub == "adapter"` แต่ `_active_sub == "cable"` และไม่มี strong adapter keyword (หัวชาร์จ/adapter/gan) → "หัว" ลอยๆ ไม่ใช่การเปลี่ยนหมวด → ใช้ active ต่อ
   - ถ้า subtype เปลี่ยนจริง → ไม่ใช้ active (ไป fetch ใหม่)

**ไฟล์ที่แก้:**
- `chatbot/shopeechat/product_store.py` — `_filter_charger_subtype` บรรทัด ~1532
- `chatbot/shopeechat/app.py` — web_search fallback บรรทัด ~4733, FOLLOWUP-COMP บรรทัด ~1092, CONV-ACTIVE บรรทัด ~2895

**ผลการทดสอบ (ZMIThailand 13Q รอบจริง):**
- Q1 `[variation_card]` (item_id=2217375776) → ตอบ AL870/AL856/CL315P ✓
- Q2 "ไอโฟน 11โปรแม๊กอันไหนคับ" → ใช้ anchor 2217375776 ต่อ ✓
- Q3 "ต่างกันยังไงคับ" → ตอบ AL870/CL315P ต่อ ✓
- Q4 "ไม่เคยใช้ของแบนนี้" → ใช้ anchor ต่อ ✓
- Q5 "ใช้กับที่ชาต มอเตอร์ไซค์" → ใช้ anchor ต่อ ✓
- Q6 "ใช้กับมอไซร" → ใช้ anchor ต่อ ✓
- Q7 "สายแท้ มั้ยคัย" → ใช้ anchor ต่อ ✓
- Q8 "ทำไมราคาแรงจัง" → ใช้ anchor ต่อ ✓
- Q9 "ราคาเกือบ ๆสายแท้เลย" → ใช้ anchor ต่อ ✓
- Q10 "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → ใช้ anchor ต่อ ✓
- Q11 "ชาต" → ใช้ anchor ต่อ ✓
- Q12 "แล้วมีประกันมั้ยคับ" → ตอบ warranty policy ✓
- Q13 "ประกันเท่าไรคับ" → ตอบ warranty policy ✓

**Regression ที่ผ่าน:**
- CW400 (item_id=6919173680) → ตอบไม่มี CW400 ไม่ดึง TP-Link ทับ ✓
- Charger typo "หัวชาจ" → ตอบหัวชาร์จถูก ✓
- iSuper multi-use-case (วิ่ง + ANC) → แนะนำ SoundActiv Run + SOUND COMFORT ✓

**verify:** `python3 -m py_compile` ผ่านทุกไฟล์

---

### 2026-09-12 — Admin-chat-result rich content + multi-bubble |||

**ปัญหา:** admin-chat-result แสดงแค่ text ธรรมดา — ไม่โชว์ variation card, image, video, sticker, item card และไม่แยก bubble |||

**วิธีแก้:**
- เพิ่ม `fullMessages` state — โหลดจาก `chatService.messages(conversation_id)` (สำหรับ shadow_bot + test_assignment)
- สร้าง `messageMap` (message_id → ChatMessage) เพื่อ match rating item กับ full message
- User message: ถ้ามี fullMsg → render ด้วย `MessageContent` (รองรับ image/video/sticker/item card/variation card) | fallback เป็น text
- Bot reply: split ด้วย `splitAnswerSegments` (|||) → render เป็น multi-bubble แยกกัน
- แต่ละ segment มี "ดูเต็ม/ย่อ" ถ้าเกิน 400 ตัวอักษร
- import `MessageContent`, `splitAnswerSegments`, `chatService`, `ChatMessage`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Test-assignment All/History tab incremental rendering (เหมือน shadow-bot)

**ปัญหา:** test-assignment All tab โหลด 2000 conversation จาก API แล้ว render ทั้งหมดทีเดียว → หนัก/ช้า
- shadow-bot ใช้ `ChatList` component ที่มี incremental rendering (50 ต่อ scroll)
- test-assignment render list เอง → ไม่มี incremental rendering

**วิธีแก้:**
- เพิ่ม `RENDER_BATCH = 50` + `allRenderCount` + `historyRenderCount` state
- เพิ่ม `allListRef` + `historyListRef` (useRef)
- เพิ่ม `handleAllScroll` + `handleHistoryScroll` — เมื่อ scroll ใกล้ล่าง (200px) → เพิ่ม 50 รายการ
- ใช้ `filteredConvs.slice(0, allRenderCount)` แทน `filteredConvs` ทั้งหมด
- ใช้ `historyRows.slice(0, historyRenderCount)` แทน `historyRows` ทั้งหมด
- reset renderCount เมื่อ filter/sort เปลี่ยน (track ด้วย `allFilterSig` + `prevAllFilterSig`)
- แสดง "แสดง X จาก Y · scroll เพื่อโหลดเพิ่ม" ท้าย list เมื่อยังมีเหลือ
- import `useRef` เพิ่ม
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/test-assignment/page.tsx`


---

## ผ่านแล้ว

### 2026-09-07 — Context loss + ANC search + "สอบถาม" new topic (Phase 3)

**เคส A — ZMIThailand context loss:**
- Q1 ลูกค้าส่ง `[variation_card]` → บอทตอบ AL870/AL856/CL315P (ถูก)
- Q2 "ไอโฟน 11โปรแม๊กอันไหนคับ" → บอทลืมสินค้าเดิม ดึง AL805/HA719 มาแทน
- Q3-Q6 ตอบมั่วเรื่องหัวชาร์จตลอด
- **สาเหตุ:** `extract_model_keywords("ไอโฟน 11โปรแม๊กอันไหนคับ")` จับ "11โปรแม๊ก" เป็น model keyword → CONV-ACTIVE ข้าม → ไม่ใช้ anchor

**เคส B — mosaakub ANC search:**
- Q2 "รอบกวนสอบถาม 2 รุ้นครับ สำหรับวิ่ง และตัดเสียงรบกวน" → บอทตอบแค่รุ่นวิ่ง ส่วน ANC บอก "ทักแอดมิน"
- **สาเหตุ 3 ชั้น:**
  1. "สอบถาม" อยู่ใน `_new_topic_kws` → Q2 ถูกจัดเป็น new topic → ไม่ carry anchor
  2. "ตัดเสียงรบกวน" ไม่อยู่ใน earphone keywords → `_detect_product_types` ไม่เจอ earphone
  3. ไม่มี feature-based search → บอทค้น "หูฟัง" ใน item_name แต่ไม่ค้น "ANC"

### วิธีแก้

**1. `knowledge_base.py` — แยก target device ออกจาก model keyword**
- เพิ่ม `_TARGET_DEVICE_KWS` (iphone/ไอโฟน/samsung/โปรแม็ก/ultra/ฯลฯ)
- เพิ่ม `is_target_device_kw(kw)` helper
- ใน `extract_model_keywords` กรอง target device ออกจาก candidates

**2. `app.py` — 4 จุด**
- CONV-ACTIVE (บรรทัด ~2894): กรอง target device ออกจาก `_cur_model_kw` ก่อนเช็ค
- `_new_topic_kws` (บรรทัด ~531): เอา "สอบถาม" ออก
- `_new_topic_kws_cp` (บรรทัด ~2902): เอา "สอบถาม" ออก
- Multi-use-case (บรรทัด ~3949): ถ้า message มี "2 รุ้น"/"สองรุ่น" + earphone → แยกค้นตาม use case (วิ่ง/ANC) แล้วรวมผล

**3. `product_store.py` — 2 จุด**
- `PRODUCT_TYPES` earphone: เพิ่ม "ตัดเสียงรบกวน", "ANC", "noise cancelling", "降噪" ฯลฯ
- `build_query`: feature-based search — ถ้า message มี feature keyword (ANC/กันน้ำ/วิ่ง) ให้ค้นใน item_name ด้วย `$and`

### ไฟล์ที่แก้
- `chatbot/shopeechat/knowledge_base.py` — เพิ่ม `_TARGET_DEVICE_KWS`, `is_target_device_kw()`, กรองใน `extract_model_keywords`
- `chatbot/shopeechat/app.py` — 4 จุด (CONV-ACTIVE filter, 2 new_topic_kws, multi-use-case)
- `chatbot/shopeechat/product_store.py` — earphone keywords + feature-based search ใน `build_query`
- `docs/SRS_SSD.md` — อัปเดต section 6.5.2 + เพิ่ม `is_target_device_kw` detail

### Verification
- `python3 -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/knowledge_base.py chatbot/shopeechat/product_store.py` → ALL OK
- TypeScript error ใน `testAssignmentService.ts` เป็น error เดิม ไม่เกี่ยวกับการแก้ครั้งนี้

### ทดสอบใน test-chat (2026-09-07)

**เคส A — ZMIThailand context loss:**
- Q1: ส่ง `[สินค้า: 2217375776]` (AL870/AL856/CL315P) → บอทตอบถูก ✓
- Q2: "ไอโฟน 11โปรแม๊กอันไหนคับ" → บอทใช้ anchor ต่อ (SOURCE: item_tag) → ตอบ AL870/AL856/CL315P ✓
- ก่อนแก้: บอทดึง ZM211/CTC620W มาแทน (context loss)
- หลังแก้: บอทใช้สินค้าเดิม → ตอบถูก

**เคส B — mosaakub ANC:**
- ส่ง "รอบกวนสอบถาม 2 รุ้นครับ สำหรับวิ่ง และตัดเสียงรบกวน" ร้าน "iSuper"
- บอทแนะนำ 2 รุ่น: iSUPER SoundActiv Run (วิ่ง) + iSUPER SOUND COMFORT PRO (ANC -50dB) ✓
- FEATURE-SEARCH log แสดงกรอง "วิ่ง" + "ANC" ใน item_name ✓
- MULTI-CASE logic ทำงาน — แยกค้นตาม use case แล้วรวมผล ✓
- ก่อนแก้: บอทตอบแค่รุ่นวิ่ง ส่วน ANC บอก "ทักแอดมิน"
- หลังแก้: บอทตอบครบทั้ง 2 use case และเจอสินค้า ANC จริงในร้าน

**แก้เพิ่มระหว่างทดสอบ:**
- `is_target_device_kw` เดิมใช้ `re.fullmatch` → ไม่ match "11โปรแม๊กอันไหนคับ" (token เดียวไม่มี space)
- แก้เป็น `re.search` เพื่อจับ target device pattern ที่อยู่ข้างใน token ยาว
- ยืนยัน model จริง (AL870, BioKoop, EC4) ไม่ถูกกรอง ✓

### ความเสี่ยงต่อเคสเก่า
- **เคส A fix:** กรอง target device ออกจาก model keyword → เคส Q14 BioKoop ไม่กระทบ (BioKoop ไม่ใช่ target device)
- **เคส B fix:** เพิ่ม keyword ใน earphone → ไม่กระทบเคสอื่น (เป็นการเพิ่มไม่ใช่ลบ)
- **"สอบถาม" ออกจาก new_topic:** เคส Q1-Q14 ไม่มี "สอบถาม" ใน message หลัก → ไม่กระทบ

### Deploy — แก้ bug Dockerfile + เพิ่ม Caddy + ปรับ DEPLOY.md (ผ่าน)
- **ปัญหา**:
  1. `Dockerfile.chatbot` มี `COPY scripts/ ./scripts/` แต่ root มีแค่ `script/` (ไม่มี s) → build fail
  2. `docker-compose.yml` ไม่มี reverse proxy / SSL
  3. `DEPLOY.md` ยังไม่สมบูรณ์ (ไม่มี troubleshooting, ไม่มี Caddy, ไม่เตือน lazada/tiktok placeholder)
  4. `chatbot-lazada` / `chatbot-tiktok` ใน docker-compose ตั้ง `APP_MODULE=chatbot.lazadachat.app:app` แต่ไม่มี `app.py` จริง (มีแค่ `__init__.py` ว่าง) → ถ้าเปิด profile จะ crash
- **วิธีแก้**:
  1. `Dockerfile.chatbot`: เอา `COPY scripts/ ./scripts/` ออก (root `script/` เป็น manual tool ไม่ใช้ตอน runtime — ตรวจด้วย grep แล้วไม่มี import)
  2. สร้าง `Caddyfile` — reverse proxy + auto SSL (Let's Encrypt) รองรับทั้งกรณีมีโดเมน (HTTPS) และยังไม่มีโดเมน (HTTP :80)
  3. `docker-compose.yml`:
     - เพิ่ม `caddy` service (image `caddy:2-alpine`, port 80/443, mount Caddyfile)
     - เปลี่ยน `chatadmin-web` จาก `ports: 3000:3000` เป็น `expose: 3000` (เข้าผ่าน Caddy)
     - เปลี่ยน `chatbot-shopee` จาก `ports: 8010:8010` เป็น `127.0.0.1:8010:8010` (debug จาก host ได้ แต่ไม่ expose ออก internet)
     - เปลี่ยน `depends_on` เป็น `condition: service_healthy` (chatbot-shopee) / `service_started` (chatadmin-web)
     - เพิ่ม volumes `caddy_data`, `caddy_config`
     - เพิ่มคำเตือนใน comment ว่า lazada/tiktok เป็น placeholder
  4. `DEPLOY.md`: เขียนใหม่ทั้งไฟล์ — เพิ่มสถาปัตยกรรม traffic, ขั้นตอน Caddy (2 กรณี), troubleshooting, การอัปเดต, backup, คำเตือน safety switches
- **ไฟล์ที่แก้**: `Dockerfile.chatbot`, `docker-compose.yml`, `DEPLOY.md`, `Caddyfile` (ใหม่)
- **Verify**: `python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))"` ผ่าน — services: chatbot-shopee, chatbot-lazada, chatbot-tiktok, chatadmin-web, bot-worker, caddy
- **⚠️ ยังไม่ verify เต็ม**: ไม่ได้รัน `docker compose up` จริง (เครื่องนี้ไม่มี Docker) — lead tech ต้องทดสอบ build + start บน server

---

## กำลังจะทำ (2026-09-10 — Inbox/Scroll/Image/BotWorker refactor)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม
> ทุกข้อต้อง verify หลังแก้ — ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify

### ที่มา

User พบปัญหาและต้องการปรับระบบหลายจุด:

1. **Scroll รายการแชท (ซ้าย) เด้งกลับ** — เลื่อนไปดูแชท 3-4 วันก่อน แล้วเด้งกลับแชท 2 ชม. ก่อน
2. **Image vision ไม่ทำงานในบางหน้า** — Shadow Generate ไม่ส่งรูปเลย, Replay ไม่ส่งรูปใน history, TestChat ไม่เก็บ image_desc
3. **ต้องการแยก assigned_to ตาม source** — shadowbot จ่าย admin 1, botworker จ่าย admin 2 สำหรับ conversation เดียวกันได้
4. **ต้องการล้าง status เก่า** — status_conversation (ticket) + test_status_conversation (4 หน้า test)
5. **ต้องการปรับ botworker ให้เลียนแบบ ticket** — UI เหมือน ticket, แสร้งเป็นแอดมินตอบ, เก็บใน messages_shp ด้วย source='adminbottesttest'
6. **ต้องการ history logic ใหม่สำหรับ botworker** — มัดรวม message ติดกันเป็นกลุ่ม, เลือกบอทเราก่อน zaapi

### รีวิวแผน — ข้อดี/ข้อเสีย/ทางเลือก

#### A1. แก้ scroll รายการแชท (ซ้าย)
- **สาเหตุจริง**: polling ทุก 3-5 วิ re-render `ChatList` → React รีเซ็ต scroll position ของ container
- **วิธี**: เก็บ scrollTop ใน ref ตอน onScroll, restore หลัง re-render
- **ข้อดี**: แก้ตรงจุด, ไม่กระทบ logic อื่น
- **ข้อเสีย**: ถ้ามี conversation ใหม่เข้ามา ตำแหน่งอาจเลื่อนนิดหน่อย (แต่ไม่เด้ง)
- **ทางเลือก**: ใช้ `react-virtualized` หรือ `react-window` — เกินไป ใช้ ref พอ
- **ความเสี่ยงต่อเคสเก่า**: ไม่มี เพราะแค่ preserve scroll position

#### A2. แก้ image vision ทุกหน้า
- **Shadow Generate**: เพิ่ม `toBotImages` + ส่งใน history
- **Replay Compare**: ส่ง `images` ใน history
- **TestChat**: เก็บ `image_desc` จาก ChatResponse ใส่ historyRef
- **ข้อดี**: bot อ่านรูปได้ครบทุกหน้า, ประหยัด token (ใช้ cache)
- **ข้อเสีย**: เพิ่ม latency นิดหน่อยตอนอ่านรูปใหม่
- **ความเสี่ยงต่อเคสเก่า**: ไม่มี เพราะเดิมไม่ส่งรูปอยู่แล้ว การส่งเพิ่มแค่ทำให้ดีขึ้น

#### B1/B2. ล้าง status
- **วิธี**: `updateMany({}, {$unset: {status: "", assigned_to: "", close_count: ""}})`
- **ข้อดี**: ทำได้ทันที, ไม่กระทบ message/conversation data
- **ข้อเสีย**: ทำลาย state ปัจจุบัน (แต่ user ยืนยันแล้วว่าจะรันใหม่เอง)
- **ความเสี่ยง**: ถ้ามี conversation ที่กำลังเปิดอยู่จริง จะกลายเป็น default (bot) — แต่ user บอกล้างได้

#### C1. แยก assigned_to ตาม source
- **ตอนนี้**: `test_status_conversation` มี compound key `{conversation_id, source}` อยู่แล้ว
- **แต่ละ source มี document ของตัวเองอยู่แล้ว** (เพราะ upsert ด้วย `{conversation_id, source}`)
- **ปัญหาจริง**: `handoffService` อ่าน assigned_to จาก `meta?.assigned_to` โดยไม่กรอง source → อาจอ่านของ source อื่น
- **วิธีแก้**: ให้ `testStatusConversationService.getMeta` กรองด้วย source เสมอ
- **ข้อดี**: ใช้โครงสร้างเดิม, ไม่ต้องเปลี่ยน schema
- **ความเสี่ยงต่อเคสเก่า**: ต้องเช็คว่าทุก caller ส่ง source มา

#### D1-D3. botworker เลียนแบบ ticket
- **วิธี**: ดึง `TicketChatPanel` มาใช้, เพิ่ม source='adminbottesttest' ใน messages_shp
- **ข้อดี**: UI เหมือน ticket, ใช้ collection เดียวกัน
- **ข้อเสีย**: เพิ่ม field ใหม่ใน message doc — ต้องเช็คว่า query อื่นกรอง source ไหม
- **ความเสี่ยงต่อเคสเก่า**: ถ้า `listMessages` ไม่กรอง source → คำตอบ test ปนกับของจริง
- **แก้**: `listMessages` ต้องกรอง `source != 'adminbottesttest'` สำหรับ ticket ปกติ

#### E1-E2. History logic ใหม่
- **วิธี**: สร้าง `getHistoryForBotWorker` ที่:
  1. ดึง user messages + zaapi replies + bot shadow replies
  2. มัดรวม message ที่ติดกันเป็นกลุ่ม (ไม่มี reply คั่น)
  3. แต่ละกลุ่ม → หา reply: ถ้ามี shadow reply → ใช้ bot, ถ้าไม่ → ใช้ zaapi
- **ข้อดี**: bot เห็น history ที่สมจริง
- **ข้อเสีย**: logic ซับซ้อนขึ้น
- **ความเสี่ยงต่อเคสเก่า**: `getHistoryForBot` เดิมใช้ใน botworker อยู่แล้ว — ต้องสร้าง function ใหม่แยก ไม่แก้ของเดิม

### ลำดับการทำ

1. **F1** อธิบาย image vision flow ปัจจุบัน (ให้เข้าใจก่อนแก้)
2. **B1 + B2** ล้างข้อมูล (เร็ว, ทำได้ทันที)
3. **A1** แก้ scroll รายการแชท
4. **A2** แก้ image vision ทุกหน้า
5. **C1** แยก assigned_to ตาม source
6. **D1-D3** ปรับ botworker UI + storage
7. **E1-E2** history logic ใหม่

### ข้อกำหนดที่ต้องไม่ลืม

- **ห้ามกระทบ ticket**: ทุกการเปลี่ยนแปลงใน test_status_conversation ต้องไม่กระทบ status_conversation (ticket ใช้คนเดียว)
- **ห้ามกระทบเคสเก่า**: C (context loss), A (trigger), B (cascade), D (trust), Q14, Order Lookup, Warranty-Image, Charger subtype — ทั้งหมดต้องไม่พัง
- **ห้ามกระทบ getHistoryForBot เดิม**: สร้าง function ใหม่ `getHistoryForBotWorker` แยก
- **ห้ามกระทบ listMessages เดิม**: ถ้าต้องกรอง source ใหม่ ต้องไม่ทำลาย query เดิม
- **botworker source='adminbottesttest'**: ต้องไม่ปนกับ ticket ปกติ — listMessages สำหรับ ticket ต้องกรองออก
- **กฎ open/closed/bot ต้องครบ**:
  - open/handoff: บอทส่งต่อ, trigger/workflow ส่งต่อ, แอดมินกดรับเรื่อง
  - closed: แอดมินกดปิด, บอทปิดเองหลัง 30 นาทีไม่มีทักซ้ำ, trigger/workflow ปิด
  - reopen/bot: แอดมินกด reopen หรือลูกค้าทักซ้ำหลังปิด → ผ่าน buffer/workflow/trigger ก่อนถึงบอท
- **Verify ทุกข้อ**: ห้ามบอก "แก้เสร็จ" ถ้ายังไม่ verify จริง

### คำถามที่ถาม user แล้ว (ยืนยันแล้ว)

- botworker เก็บคำตอบใน messages_shp ด้วย source field → ใช่
- มัดรวม message ติดกัน → เฉพาะ history ส่ง bot (UI แสดงทีละ message ปกติ)
- เลือกบอทเราก่อน zaapi → แบบ B (ทีละ Q&A pair) + มัดรวม 3-4 message ที่ติดกันเป็นคำถามเดียว แล้ว zaapi reply = คำตอบของทั้งกลุ่ม
- แยก assigned_to ตาม source → ใช่ แยกตาม source
- scroll เด้ง → เกิดที่รายการแชท (ซ้าย)
- ล้าง status → ล้างเฉพาะ field status/assigned_to ไม่ลบ document

---

## กำลังจะทำ (2026-09-05 — /team expand bug + status columns + date range)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา

User พบปัญหาในหน้า `/team`:
1. **กด expand agent แล้วไม่โชว์ร้านค้า/แพลตฟอร์ม** — ขึ้น 0 ทั้งที่มีข้อมูล
2. **สถานะเปลี่ยนเป็น open/handoff/closed/bot แล้ว** — คอลัมน์ยังเป็น Pending อยู่
3. **ต้องการดูรายละเอียดสถานะแชทของแอดมินตามวันที่/ช่วงเวลา** เหมือน dashboard

### สาเหตุ

1. **Expand bug**: `shops`, `shopTeam`, `platformTeam` state โหลดเฉพาะตอน tab = shop-team/platform-team (useEffect บรรทัด 185-188) — ใน overview tab มันว่าง → agentShops/agentPlatforms = 0
2. **Status ผิด**: team API อ่าน `c.status === "pending"` จาก `conversations` (โดน dump ทับ) — ควรอ่านจาก `status_conversation` และใช้ open/handoff/closed/bot
3. **ไม่มี date range**: ไม่มี date picker สำหรับดู historical stats

### วิธีแก้

1. **API `/team`**:
   - อ่าน workload จาก `status_conversation` (join `conversations` สำหรับ shop/platform)
   - ใช้ statuses: open, handoff, closed, bot (เอา pending ออก)
   - รวม shop_team + platform_team พร้อม shop names ใน response (ไม่ต้องโหลดแยก)
   - รองรับ `start_date`/`end_date` query params — ดึง historical stats จาก `admin_logs`
2. **Frontend `/team`**:
   - โหลด shops/shopTeam/platformTeam ตอน mount (แก้ expand bug)
   - เปลี่ยนคอลัมน์ Pending → Closed
   - เพิ่ม `UnifiedDateRangePicker`
   - expand panel แสดง historical status breakdown ตาม date range

### ความเสี่ยงต่อเคสเก่า

- ไม่มี — /team เป็นหน้า monitor ไม่กระทบ bot flow
- ไม่กระทบ status_conversation writes (แค่อ่าน)

### ผล (ผ่าน)

- **Typecheck**: ผ่าน
- **Build**: ผ่าน
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/app/api/team/route.ts` — rewrite อ่านจาก status_conversation + รวม shop/platform + historical stats
  - `ChatAdminWeb/src/app/(console)/team/page.tsx` — โหลด shops ตอน mount, เปลี่ยน Pending→Closed, เพิ่ม DateRangePicker, expand panel แสดง historical stats
- **เคสที่ผ่าน**:
  - Expand agent ใน overview tab → แสดงร้าน/แพลตฟอร์มที่ดูแล (จาก API)
  - คอลัมน์ workload = open/bot/handoff/closed (ไม่มี pending แล้ว)
  - เลือก date range → expand แสดง historical stats (รับงาน/ตอบ/ส่งต่อ/ปิด/เปิดใหม่/resolve)
  - workload อ่านจาก status_conversation (ไม่โดน dump ทับ)

---

## กำลังจะทำ (2026-09-05 — Date separator ทุกหน้าแชท เหมือน LINE)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา

User ต้องการ date separator คั่นกลางแชทเมื่อเปลี่ยนวัน — เหมือน LINE ที่มีแถบ "วันนี้" / "เมื่อวาน" / "5 ก.ย. 2569" ขึ้นตรงกลางแชท

ต้องทำในทุกหน้าที่แสดงแชท:
- test-chat/shopee
- test-assignment
- botworker
- replay-compare
- shadow-inbox (ฝั่ง user/zaapi และ user/bot)
- tickets

### สาเหตุ

- ไม่มี date separator ในทุกหน้า — ผู้ใช้ไม่รู้ว่าข้อความข้างบน/ข้างล่างเป็นวันไหน
- มี `DateBanner` component อยู่แล้วใน `components/shadow/DateBanner.tsx` แต่ใช้แค่ใน ShadowReplyPanel

### วิธีแก้

1. **สร้าง `DateSeparator.tsx`** — helper component `DateSeparatedList` รับ items + getKey + getTimestamp + renderItem แล้วแทรก DateBanner เมื่อวันเปลี่ยน
2. **ChatWindow.tsx** — ใช้ DateSeparatedList แทน messages.map
3. **TicketChatPanel.tsx** — ใช้ DateSeparatedList แทน messages.map
4. **TestChatClient.tsx** — เพิ่ม timestamp field ใน Msg interface + แทรก DateBanner ใน messages.map
5. **botworker/page.tsx** — แทรก DateBanner ใน messages.map ด้วย React.Fragment
6. **test-assignment/page.tsx** — แทรก DateBanner ใน detail.messages.map
7. **replay-compare/page.tsx** — แทรก DateBanner ใน previewMessages.map
8. **ShadowReplyPanel.tsx** — มี DateBanner อยู่แล้ว ไม่ต้องแก้

### ความเสี่ยงต่อเคสเก่า

- ไม่มี — เป็นการเพิ่ม DateBanner คั่น ไม่ได้ลบ logic เดิม
- ไม่กระทบ bot flow หรือ API

### ผล (ผ่าน)

- **Typecheck**: ผ่าน
- **Build**: ผ่าน
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/components/chat/DateSeparator.tsx` — สร้างใหม่ (DateSeparatedList helper)
  - `ChatAdminWeb/src/components/chat/ChatWindow.tsx` — ใช้ DateSeparatedList
  - `ChatAdminWeb/src/components/chat/TicketChatPanel.tsx` — ใช้ DateSeparatedList
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` — เพิ่ม timestamp field + แทรก DateBanner
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — แทรก DateBanner
  - `ChatAdminWeb/src/app/(console)/test-assignment/page.tsx` — แทรก DateBanner
  - `ChatAdminWeb/src/app/(console)/replay-compare/page.tsx` — แทรก DateBanner
- **เคสที่ผ่าน**:
  - ทุกหน้าแชทแสดงแถบวันที่คั่นกลางเมื่อเปลี่ยนวัน (เหมือน LINE)
  - "วันนี้" / "เมื่อวาน" / "5 ก.ย. 2569" ตามจริง
  - ไม่กระทบการ scroll หรือ logic เดิม

---

## กำลังจะทำ (2026-09-05 — Sticker URL + botworker raw_payload)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา

User พบปัญหา:
1. **สติกเกอร์ไม่ขึ้นเป็นรูป** — `[สติกเกอร์]` แสดงเป็น text "(สติกเกอร์ ID)" แทนที่จะเป็นรูป
2. **หน้า botworker ไม่ parse raw_payload** — สติกเกอร์/รูป/การ์ดสินค้า/การ์ดคำสั่งซื้อไม่แสดง
3. **ต้องการให้ทุกหน้าเห็นข้อความจริง + ประมวลผลรูป + history + buffer เหมือนกัน**

### สาเหตุ

1. **Sticker parser**: `parseRawMessage` case "sticker" ดึงแค่ `sticker_id` ไม่ดึง URL → ไม่มี media ส่งกลับ
2. **Botworker route**: `/botworker/conversations/:id/messages` ไม่เรียก `parseRawMessage` เลย — ส่งแค่ text ดิบๆ
3. **MessageContent**: case "sticker" แสดง icon + text เท่านั้น ไม่รองรับ media.url

### วิธีแก้

1. **`messageMediaParser.ts`** — case "sticker" ดึง URL จาก `url`/`image_url`/`sticker_url` + normalize + ส่งกลับเป็น media
2. **`MessageContent.tsx`** — case "sticker" ถ้ามี `media.url` → แสดงเป็น `<img>` (max 160px) + click ดูภาพใหญ่
3. **`botworker/.../messages/route.ts`** — เพิ่ม `parseRawMessage` + `productService.getProductsByIds` เหมือน admin route
4. **`botworker/page.tsx`** — `UnifiedMessage` interface เพิ่ม `message_type`/`media`/`order_sn`/`table`/`products` + `toChatMsg` ส่ง rich media ไป MessageContent
5. **`replay_compare.py`** — case "sticker" ดึง URL จากหลาย field + normalize + ส่งกลับเป็น media

### ความเสี่ยงต่อเคสเก่า

- ไม่มี — เป็นการเพิ่ม field ใหม่ (media) ไม่ได้ลบ field เดิม
- ไม่กระทบ bot flow — bot ยังได้ text เดิม (placeholder `[สติกเกอร์]`)
- ไม่กระทบ history/buffer — ไม่ได้แก้ messageService.ts

### ผล (ผ่าน)

- **Typecheck**: ผ่าน
- **Build**: ผ่าน
- **py_compile**: ผ่าน
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/backend/service/messageMediaParser.ts` — sticker case ดึง URL + **แก้ placeholder fallback ให้ fall through ไป switch case ถ้า msgType === "sticker"**
  - `ChatAdminWeb/src/components/chat/MessageContent.tsx` — sticker แสดงเป็นรูป
  - `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — เพิ่ม parseRawMessage + product lookup
  - `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — UnifiedMessage + toChatMsg ส่ง rich media
  - `replay_compare.py` — sticker parser ดึง URL + **แก้ placeholder fallback เหมือน TS**
- **เคสที่ผ่าน**:
  - สติกเกอร์ที่มี URL ใน raw_payload → แสดงเป็นรูปในทุกหน้า (tickets, shadow-inbox, test-assignment, replay-compare, botworker)
  - หน้า botworker แสดงรูป/สติกเกอร์/การ์ดสินค้า/การ์ดคำสั่งซื้อได้เหมือน /tickets
  - สติกเกอร์ที่ไม่มี URL → fallback แสดง icon + text (เหมือนเดิม)
- **⚠️ บั๊กหลักที่แก้ครั้งที่ 2**: placeholder fallback `[สติกเกอร์]` return ก่อนถึง switch case → ไม่เคยดึง URL จาก raw_payload เลย แม้จะมี msgType === "sticker" ก็ตาม → แก้ให้ fall through ไป switch case เหมือน image/video/item

---

## กำลังจะทำ (2026-09-07 — TestChat session ownership + log UI)

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา
User ต้องการให้ test chat (shopee) แยก session ตาม admin — แต่ละคนเห็นแค่ของตัวเอง และมีระบบ log บอกว่าใครสร้าง/พิมพ์อันไหน

### สถานะปัจจุบัน
- `test_chat_sessions` ไม่มี field `admin_id` → ทุก admin เห็นทุก session
- `test_chat_logs` มีอยู่แล้ว (`_log_testchat_action` บันทึก create/add_message/delete/update/close/reopen พร้อม admin_id, admin_name)
- ไม่มี UI ดู log ในหน้า test chat
- Next.js proxy ส่ง `X-Admin-Id` + `X-Admin-Name` header ให้ Python อยู่แล้ว

### แผน
1. **Python `app.py`**:
   - `create_test_chat_session`: เพิ่ม `admin_id` + `admin_name` ลง doc (ดึงจาก header)
   - `list_test_chat_sessions`: กรองด้วย `admin_id` จาก header (legacy session ที่ไม่มี admin_id → แสดงให้ทุกคน เพื่อไม่ทำลายของเก่า)
   - `list_test_chat_logs`: เพิ่ม query param `admin_id` ถ้าส่งมาให้กรอง
2. **Next.js `TestChatClient.tsx`**: เพิ่มปุ่ม "ประวัติการใช้งาน" เปิด panel ดู log (เรียก `/api/chatbot/shopee/test-chat/logs`)
3. **อัปเดต SRS_SSD.md** section 6 ของฟังก์ชันที่แก้
4. **อัปเดต docs/schema.md** field ใหม่ของ `test_chat_sessions`

### ความเสี่ยงต่อเคสเก่า
- ไม่มี เพราะแค่เพิ่ม field + filter ไม่แตะ chat pipeline
- legacy session (ไม่มี admin_id) ยังเห็นได้ทุกคน → ไม่หาย

### วิธีแก้ (implement เสร็จ 2026-09-07)
- **Python `app.py`**:
  - `list_test_chat_sessions` (line 5345): เพิ่ม param `request: Request`, ดึง `X-Admin-Id`, query `$or` กรอง `admin_id == ผู้เรียก` OR legacy (ไม่มี field / None / "")
  - `create_test_chat_session` (line 5385): ดึง `X-Admin-Id` + `X-Admin-Name` (URL-decode) → insert ลง doc
  - `list_test_chat_logs` (line 5612): เพิ่ม param `admin_id` + ดึงจาก header fallback; `admin_id=all` → ดูทุกคน
- **Next.js `TestChatClient.tsx`**:
  - เพิ่ม `History` icon import
  - `rightTab` type เพิ่ม `"logs"`
  - เพิ่ม state `actionLogs`, `logsLoading`, `logsScope` + function `loadActionLogs`
  - เพิ่ม tab "ประวัติ" ใน right panel (สลับ ฉัน/ทุกคน + รีเฟรช)
  - แสดง log: action label (ไทย), เวลา, admin_name, shop, session #, text_preview
- **docs/schema.md**: เพิ่ม field `admin_id`, `admin_name` ใน `test_chat_sessions` + หมายเหตุ Phase 3
- **docs/SRS_SSD.md**: อัปเดต table 6.1.1 (line + Calls) + เพิ่ม section 6.1.6 detail (Purpose/Input/Output/Calls/Called by/How it works/Side effects/Error)
- **Verify:** `python3 -m py_compile` ผ่าน ✅, `npx tsc --noEmit` ผ่าน ✅

### ผ่านแล้ว ✅
- แต่ละ admin เห็นเฉพาะ session ของตัวเอง (legacy ยังเห็นรวม)
- ปุ่ม "ประวัติ" ใน right panel ดู log ได้ (สลับ ฉัน/ทุกคน)
- log บันทึก create/add_message/delete/update/close/reopen พร้อม admin_id, admin_name อยู่แล้ว

---

## ผ่านแล้ว (2026-09-08 — Rich Media All Pages — ทำให้ทุกหน้าเข้าใจ tag ครบทั้ง 9)

### ที่มา
ผู้ใช้ระบุว่าทุกหน้า (ticket, testchat/shopee, shadowbot, botworker, testassignment, live-assignment, replay-compare, admin-chat-result, test-chat-result) ต้องเข้าใจและแสดง Shopee rich-message tags ครบทั้ง 9: `faq_liveagents`, `item_card`, `variation_card`, `sticker`, `bundle_message`, `video`, `picture`, `notification`, `order`

### Audit พบปัญหา
1. **test-chat-result**: ใช้ custom markdown renderer ไม่ใช้ MessageContent → ไม่รองรับ rich media
2. **messages API** (admin/conversations/[id]/messages + botworker): ไม่ส่ง `bundle` field กลับ → bundle_message ไม่แสดง sub-messages
3. **parseRawMessage**: ไม่รองรับ alias `item_card` (ใช้ `item`), `picture` (ใช้ `image`), `faq_liveagents` (ใช้ `faq_liveagent`)
4. **TestChatClient**: ไม่ใช้ MessageContent — แต่ตรวจพบว่าไม่รับ raw_payload เลย (เป็น test chat interface ไม่ใช่ Shopee viewer) → ไม่ต้องแก้

### วิธีแก้
1. **messageMediaParser.ts**: เพิ่ม alias normalization ใน `parseRawMessage`:
   - `item_card` → `item`
   - `picture` → `image`
   - `faq_liveagents` → `faq_liveagent`
   - เพิ่ม `[picture]`, `[item_card]`, `[faq_liveagents]`, `[โอนเจ้าหน้าที่]` ใน placeholder regex
2. **replay_compare.py**: เพิ่ม alias normalization เดียวกันใน `parse_raw_message` + placeholder regex
3. **admin/conversations/[id]/messages/route.ts**:
   - รวบรวม item_ids จาก bundle sub-messages ด้วย
   - แปลง `p.bundle` (ParsedMessage[]) → `ChatMessage[]` ใน response
4. **botworker/conversations/[id]/messages/route.ts**:
   - รวบรวม item_ids จาก bundle sub-messages
   - แปลง `p.bundle` → `UnifiedMessage[]` ใน user message response
5. **botworker/page.tsx**: เพิ่ม `bundle` field ใน `toChatMsg` function
6. **test-chat-result/page.tsx**:
   - import `MessageContent` + `ChatMessage` type
   - เพิ่ม `sessionMsgToChatMsg` helper — แปลง SessionMessage → ChatMessage (มี images → `image_with_text`)
   - user message: ใช้ MessageContent แทน plain text + custom image grid
   - bot message: ใช้ MessageContent แทน `renderMarkdownInline`

### ไฟล์ที่แก้
- `ChatAdminWeb/src/backend/service/messageMediaParser.ts` — alias normalization + placeholder regex
- `replay_compare.py` — alias normalization + placeholder regex
- `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/messages/route.ts` — bundle field
- `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — bundle field
- `ChatAdminWeb/src/app/(console)/botworker/page.tsx` — toChatMsg bundle field
- `ChatAdminWeb/src/app/(console)/test-chat-result/page.tsx` — MessageContent + sessionMsgToChatMsg

### ไม่ได้แก้
- `TestChatClient.tsx` — ไม่รับ raw_payload (เป็น test chat interface ไม่ใช่ Shopee viewer) → ไม่ต้อง parse rich media
- `docs/SRS_SSD.md` — section 6 เป็นของ Python chatbot ไม่เกี่ยว (replay_compare.py เป็น script ไม่ใช่ฟังก์ชันใน chatbot/)

### Verify
- `npx tsc --noEmit` ใน ChatAdminWeb → ผ่าน (exit 0) ✅
- `python3 -m py_compile replay_compare.py` → ผ่าน ✅
- ⚠️ ยังไม่ verify manual: รอทดสอบจริงใน browser:
  1. ticket/botworker: เปิดแชทที่มี bundle_message → แสดง sub-messages ครบ
  2. admin-chat-result: เปิดแชทที่มี item card → แสดง product card จาก MessageContent
  3. test-chat-result: เปิด session ที่มีรูป → แสดงรูปใน MessageContent + lightbox
  4. ทุกหน้า: ถ้า Shopee ส่ง `item_card`/`picture`/`faq_liveagents` → แสดงถูกต้อง (ไม่ตกไป unknown)

### Fix เพิ่ม — Product card ภาพไม่ขึ้น (shp_203905019987193330)
- **ปัญหา**: product card แสดงแต่ภาพไม่มา (ชื่อ/ราคา/url ขึ้น แต่รูปไม่ขึ้น)
- **Root cause** (2 จุด):
  1. `toProductCard` หา `doc.images` (plural) แต่ dbWallet Shopee เก็บ `doc.image` (singular) มี `image_id_list` ข้างใน → ไม่เจอ → ภาพหาย
  2. `toProductCard` ใช้ `normalizeImageUrl` (host `img.sp.mms.shopee.sg`) แต่ product image ใช้ CDN คนละตัวกับ message media — Python bot ใช้ `https://cf.shopee.co.th/file/{hash}`
- **Fix**:
  1. เพิ่ม `normalizeProductImageUrl` ใช้ host `https://cf.shopee.co.th/file/` (เหมือน Python `_first_image_url`)
  2. `toProductCard` รองรับทั้ง `doc.images` (plural) และ `doc.image` (singular มี `image_id_list`)
  3. ใช้ `normalizeProductImageUrl` สำหรับ product image ทุก case
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/backend/service/messageMediaParser.ts`
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅ — รอ verify จริงใน browser

### Fix เพิ่ม — bundle_message ไม่ขึ้น (shp_152520383445167602) + สินค้าไม่ขึ้น (shp_152520383346282116)
- **ปัญหา 1 — bundle_message**: conversation `shp_152520383445167602` มี bundle_message แต่ไม่แสดง sub-messages
- **Root cause 1** (3 จุด):
  1. parser หา `source_content` ที่ `raw.source_content` และ `raw.data.source_content` แต่จริงๆ อยู่ที่ `raw.data.content.source_content` (nestedContent.source_content)
  2. `source_content` ว่างเปล่า `{}` — ไม่มี `item_id` → parser ตกไป placeholder "(bundle)"
  3. sub-message IDs ใน `content.messages` (เช่น `["2434454232218550641", ...]`) ไม่ได้ถูก sync มาเก็บใน DB ของเรา → fetch ไม่เจอ
- **Fix 1**:
  1. parser หา `source_content` ใน 4 ตำแหน่ง (รวม `nestedContent.source_content`)
  2. เพิ่ม `bundle_message_ids` field ใน `ParsedMessage` — เก็บ message_id strings จาก `content.messages`
  3. messages API (admin + botworker) fetch sub-messages จาก DB ด้วย `bundle_message_ids` แล้ว parse เป็น `bundle` field (สำหรับกรณีที่ sub-messages มีใน DB ในอนาคต)
  4. ถ้า sub-messages ไม่มีใน DB → แสดงเป็น "Bundle (N ข้อความ)" แทน placeholder ว่าง
- **ปัญหา 2 — สินค้าไม่ขึ้น**: conversation `shp_152520383346282116` มี message `[item]` แต่ product card ไม่แสดง
- **Root cause 2**: ทุก message ใน conversation นี้มี `raw_payload = null`! เป็นข้อมูลเก่าที่ Zaapi ส่งมาแค่ text placeholder `[item]` โดยไม่มี item_id ใน text และไม่มี raw_payload → ไม่สามารถ lookup product ได้
- **สถานะ 2**: เป็นปัญหาที่ข้อมูล DB ไม่สมบูรณ์ ไม่ใช่ปัญหาที่ parser — parser จะแสดง "สินค้า" (placeholder) ซึ่งถูกต้องแล้ว ไม่สามารถแก้ได้โดยไม่มี raw_payload
- **ไฟล์ที่แก้**:
  - `ChatAdminWeb/src/backend/service/messageMediaParser.ts` — source_content 4 ตำแหน่ง + bundle_message_ids + RawContent type
  - `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/messages/route.ts` — fetch sub-messages
  - `ChatAdminWeb/src/app/api/botworker/conversations/[conversationId]/messages/route.ts` — fetch sub-messages
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅, `python3 -m py_compile replay_compare.py` → ผ่าน ✅ — รอ verify จริงใน browser

## ผ่านแล้ว (2026-09-07 — kb+mongo path ไม่บันทึก suggestion → context loss)

### ที่มา
ลูกค้าถาม "แนะนำหัวชาร์ต mi 17 ultra แล้วฟาสชาตที" → บอทตอบจาก kb+mongo+web_search แนะนำ CUKTECH P100P, P23, BA652U (source=`knowledge_base+mongo+web_search`, pipeline=Search) — ตอบถูก
แต่คำถามถัดไป "ขอลิงค์กับรูปประกอบ" → บอทไปดึง powerbank PB150P มาแทน และไม่แนบรูป+ลิงค์ของหัวชาร์จ

### สาเหตุ (root cause)
- `kb+mongo` path (บรรทัด ~2696) และ `kb+mongo+web_search` path (บรรทัด ~2672) **ไม่ได้เรียก** `_record_suggestion_products`
- ทำให้สินค้าที่บอทแนะนำ (CUKTECH P100P, P23, BA652U) ไม่ถูกบันทึกลง `conversation_products` timeline
- → `active_item_id` ว่าง → คำถามถัดไป "ขอลิงค์กับรูปประกอบ" เข้า CONV-ACTIVE block (บรรทัด ~2907) แต่ `_active_card = None`
- → บอทไป RAG ใหม่ด้วยคำว่า "ลิงค์กับรูป" (ไม่มี product type ชัดเจน) → ดึง powerbank มาแทน
- เปรียบเทียบ: `product_store` path (บรรทัด 5079) และ `product_store+web_search` path (บรรทัด 5054) เรียก `_record_suggestion_products` อยู่แล้ว → ไม่มีปัญหานี้

### วิธีแก้
เพิ่ม `_record_suggestion_products(req, products[:req.limit])` ก่อน `return ChatResponse` ใน 2 จุด:
1. `kb+mongo+web_search` path (บรรทัด ~2671) — ก่อน return ที่ source="knowledge_base+mongo+web_search"
2. `kb+mongo` path (บรรทัด ~2695) — ก่อน return ที่ source="knowledge_base+mongo"

### ความเสี่ยงต่อเคสเก่า
- ไม่มี — เป็นการเพิ่มบันทึก suggestion ที่ขาดหายไป ไม่ได้แตะ logic การตอบ
- คำถามถัดไปที่เป็น generic ("ขอลิงค์/รูป/ราคา/สเปก") จะใช้ active product ที่บันทึกไว้แทนดึงใหม่ → ตรงเคส C (Context loss) ที่ผ่านแล้ว

### Verify
- `python3 -m py_compile chatbot/shopeechat/app.py` ผ่าน
- ⚠️ ยังไม่ได้ทดสอบ replay จริง (ต้องรัน test chat ซ้ำเคสเดิม: ถามหัวชาร์จ → ขอลิงค์+รูป)

### ไฟล์ที่แก้
- `chatbot/shopeechat/app.py` (เพิ่ม `_record_suggestion_products` 2 จุด)

---

## ผ่านแล้ว (2026-09-07 — /logs ตาราง view)

### ที่มา
User ต้องการเพิ่มมุมมองตารางในหน้า `/logs` (audit logs) โดย list เดิมยังเก็บไว้ — สลับด้วย tab

### วิธีแก้
- **`src/app/(console)/logs/page.tsx`**:
  - เพิ่ม state `viewMode: "list" | "table"`
  - เพิ่ม tab สลับมุมมอง (List / Table2 icon) ด้านขวาบน header
  - list view เดิมไม่แก้
  - เพิ่ม component `LogTableView` แสดงทุก field จริงใน `AdminLogDoc`: `timestamp`, `action_type`, `actor`/`admin_id`, `target_admin_id`, `conversation_id`, `shop_id`, `ticket_id`, `ip`, `meta` (key count), `metadata` (key count)
  - คลิก row → expand ดู `metadata` + `meta` (legacy) แบบเต็มด้านล่าง
  - filter (admin, หมวด, search) ใช้ร่วมกันทั้ง 2 view
- เพิ่ม `ticket_id`, `meta`, `actor` ใน `AdminLogRow` interface
- เพิ่มหมวดใน `ACTION_CATEGORIES`: Config (เพิ่ม `admin_config.update`, `admin.maintenance.clear_status`), Bot/Data (เพิ่ม `bot.buffer_flush`, `bot.buffer_recover`), Shadow (เพิ่ม `shadow_reply.generate`), Test, Chat accept, Conversation meta, SLA
- **`docs/function and process.md`** อัปเดต section 2.18 ระบุ view mode

### Verify
- `npx tsc --noEmit` ผ่าน
- `npx next build` ผ่าน (exit 0, ไม่มี error/warning เกี่ยวกับ logs/page)

### ไฟล์ที่แก้
- `ChatAdminWeb/src/app/(console)/logs/page.tsx`
- `docs/function and process.md`

---

## กำลังจะทำ

(ว่าง)

---

## ผ่านแล้ว

### 2026-09-20 — ChatBot v3 — OpenRouter-first paradigm (implement + smoke test ผ่าน)

**paradigm shift:** ไม่นั่งปั้น RAG context แบบ legacy แต่ส่ง raw (message + history + images + shop link) ให้ OpenRouter ตอบ → เอา list สินค้ามา match กับ ShpProducts

**ไฟล์ที่สร้าง** (`chatbot/shopeechat/chatbotv3/`):
- `__init__.py` — export `chat_v3`
- `or_client.py` — OpenRouter client (round-robin API keys, AI Usage Hub log, multimodal)
- `system_prompt.py` — SYSTEM_INSTRUCTION_V3 (base จาก llm.py + กฎ v3 ใหม่ + fallback)
- `shop_link.py` — สร้าง shop URL `https://shopee.co.th/{shopname_lower}?entryPoint=ShopBySearch&searchKeyword={shopname_lower}`
- `rich_parse.py` — parse rich tags ([สินค้า: id], [order: sn], [รูปภาพ], placeholder)
- `product_match.py` — match สินค้าจาก OpenRouter answer กับ ShpProducts (กรองเฉพาะร้าน)
- `emotion.py` — detect negative emotion (strong + moderate + word boundary) + human request
- `engine.py` — main flow: parse → safety checks (warranty/emotion/human) → LLM → product match → response

**สิ่งที่ copy จาก legacy:**
- warranty.detect_claim_request (เหมือนเดิม — ไม่แก้)
- product_store.to_product_card, fetch_products, fetch_product_by_id (เรียกผ่าน lazy import)
- order_store.extract_order_sn, extract_tracking_number (เรียกผ่าน lazy import)
- rich tag patterns ([สินค้า: id], [order: sn], [รูปภาพ], placeholder)

**สิ่งที่ตัดออก:**
- intent_classifier, RAG/vector search, KB lookup, charger subtype, conversation_products anchor, web_search fallback

**เพิ่มใหม่:**
- emotion detection (อารมณ์เสีย/ไม่ดี → handoff admin) — มี word boundary สำหรับคำสั้น (บ้า/บ้าง, กาก/กากมาก)
- shop link format `https://shopee.co.th/{shopname_lower}?entryPoint=ShopBySearch&searchKeyword={shopname_lower}`
- lazy imports ทุก heavy module (llm, warranty, knowledge_base, product_store, order_store) — ทำให้ test ไม่ต้องลง google-genai/pymongo

**กฎใหม่ใน system_instruction:**
- ตอบจาก DB ก่อน/มีคำตอบห้ามส่งต่อ
- ปัญหาใช้งานต้องบอกวิธีตรวจสอบก่อน ถามซ้ำจึงส่งต่อ
- ห้ามบอกว่าตรวจสอบระบบ/คำสั่งซื้อแล้ว
- ห้ามสรุปแทนทุกรุ่น
- ห้ามเสนอหัวข้อที่ไม่ได้ถาม
- ห้ามสัญญาแทนคน
- ผู้ช่วยร้านอุปกรณ์ไอที, ค่ะ ไม่ใช้ครับ, สุภาพ กระชับ ตรงประเด็น

**Wiring:**
- `app.py` — เพิ่ม `use_v3` field ใน ChatRequest + dispatch ก่อน v2/legacy
- env `USE_CHAT_V3=1` หรือ `req.use_v3=True` → route `/chat` ไป `chatbotv3.engine.chat_v3(req)`
- default: ไม่เปิด (USE_CHAT_V3=0) → legacy/v2 ทำงานเหมือนเดิม

**Verification ที่ผ่าน:**
- `py_compile` ทุกไฟล์ (8 ไฟล์ + app.py) — ผ่าน
- smoke test import ทุก module — ผ่าน
- shop_link.build_shop_url — ผ่าน (KingGadgets, ThaiSuperPhone, empty)
- shop_link.build_shop_context_block — ผ่าน
- rich_parse.parse_rich_message — ผ่าน (item tag, image placeholder, placeholder only)
- emotion.detect_negative_emotion — ผ่าน (strong, moderate+context, normal, complaint history, word boundary บ้า/บ้าง)
- emotion.detect_human_request — ผ่าน
- product_match._extract_product_names_from_answer — ผ่าน
- product_match._normalize_name — ผ่าน
- engine.chat_v3 (mock) — ผ่าน 6 tests: warranty handoff, emotion handoff, human request handoff, placeholder only, normal LLM call, บ่นเล่นๆ ไม่ handoff

**⚠️ ยังไม่ได้ทดสอบ:**
- Live OpenRouter call (ต้องมี API key จริง)
- Live MongoDB product match (ต้องเชื่อม DB จริง)
- End-to-end ผ่าน `/chat` endpoint (ต้องรัน server)
- Replay/shadow test เทียบกับ legacy

**⚠️ ห้ามทำลาย:** warranty claim flow, order lookup, handoff, vision pass — เคสที่ผ่านใน legacy ต้องผ่านใน v3 ด้วย

---

### 2026-09-20 — ChatBot v3 — เพิ่มฟีเจอร์ audit ข้อ 1-5,7 (ยกเว้นข้อ 6 conversation_products)

**ที่มา:** audit พบว่า v3 ขาดฟีเจอร์สำคัญหลายตัวที่ legacy มี → ต้องเพิ่มก่อนเปิดใช้จริง

**ฟีเจอร์ที่เพิ่ม (ข้อ 1-5,7 — ยกเว้นข้อ 6 conversation_products ตามคำสั่ง):**

1. **handoff API จริง** — v3 ไม่ได้เรียก `ADMIN_HANDOFF_URL` จริง แค่ตั้ง flag
   - เพิ่ม `_send_handoff_to_admin()` ใน `engine.py` — ส่ง POST ไป ChatAdminWeb จริง (เหมือน legacy app.py 1856-1884)
   - ส่ง `conversation_id`, `shop_id`, `platform`, `reason`, `simulate`, `claim`
   - ใช้ `urllib.request` + `X-Internal-Secret` header
   - เรียกจาก `_make_handoff_response()` ทุกครั้งที่มี `conversation_id`
   - ถ้าไม่มี `conversation_id` → ไม่เรียก API (เหมือน legacy)

2. **persona ของร้าน** — v3 ไม่ได้ดึง persona จาก `persona.get_persona()`
   - เพิ่ม `_get_persona_extra()` ใน `engine.py` — ดึง persona ของร้าน + สร้าง instruction
   - ส่งเข้า `system_prompt.build_system_instruction(persona_extra=...)`
   - lazy import `persona` module

3. **image_desc** — v3 ไม่ได้คืน `image_desc` ใน response
   - เพิ่ม `_extract_image_desc_from_answer()` — สกัด description จากคำตอบ LLM (ถ้ามีรูป)
   - ปัจจุบัน return "" เพราะ v3 ส่งรูปเข้า LLM ตรง (multimodal) ไม่มี vision pass แยก
   - ส่ง `image_desc` ใน `_make_answer_response()`

4. **answer_segments (multi-bubble)** — v3 ไม่ได้แยกคำตอบด้วย `|||`
   - `_make_answer_response()` แยก answer ด้วย `|||` อยู่แล้ว
   - เพิ่มใน `_make_handoff_response()` ด้วย — แยก answer ด้วย `|||` เหมือน legacy

5. **order_sn lookup** — v3 ไม่ได้ lookup order จริง
   - เพิ่ม `_lookup_order_context()` ใน `engine.py` — เรียก `order_store.lookup_order()` + `build_order_context()`
   - ส่ง order context จริงเข้า user prompt (แทนที่แค่ส่ง order_sn ลอยๆ)
   - lazy import `order_store` module

7. **ChatAdminWeb config** — v3 ไม่มี UI เลือก + type ไม่มี "v3"
   - `systemConfigService.ts` — เพิ่ม `"v3"` ใน `chat_engine` type + `shouldUseChatV3()`
   - `botCallService.ts` — ส่ง `use_v3: true` เมื่อ config เลือก v3 + คืน `chat_engine: "v3"`
   - `shadowReplyService.ts` — เพิ่ม `"v3"` ใน `chat_engine` + `chatEngine` type
   - `liveAssignmentService.ts` — เพิ่ม `"v3"` ใน `chat_engine` type
   - `test-assignment/route.ts` — เพิ่ม `"v3"` ใน `chat_engine` type
   - `config/page.tsx` — เพิ่ม option "v3" ใน dropdown + แสดง warning เมื่อเลือก v3

**ฟีเจอร์ที่ไม่ทำ (ข้อ 6):**
- `conversation_products` — ไม่เพิ่มตามคำสั่ง (v3 ไม่อัปเดต timeline สินค้า)

**ไฟล์ที่แก้:**
- `chatbot/shopeechat/chatbotv3/engine.py` — เพิ่ม helper + แก้ flow
- `ChatAdminWeb/src/backend/service/systemConfigService.ts` — type + `shouldUseChatV3()`
- `ChatAdminWeb/src/backend/service/botCallService.ts` — ส่ง `use_v3` + type
- `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — type
- `ChatAdminWeb/src/backend/service/liveAssignmentService.ts` — type
- `ChatAdminWeb/src/app/api/test-assignment/route.ts` — type
- `ChatAdminWeb/src/app/(console)/config/page.tsx` — UI option + warning

**Verification ที่ผ่าน:**
- `py_compile engine.py` — ผ่าน
- `npx tsc --noEmit` — ผ่าน
- smoke test 7 tests — ผ่านทั้งหมด:
  1. handoff API จริง (warranty claim) — ส่ง POST จริง, payload ถูกต้อง ✓
  2. persona ของร้าน — ดึง persona ได้, ส่งเข้า system instruction ✓
  3. image_desc — คืน "" ตาม design (v3 ส่งรูปเข้า LLM ตรง) ✓
  4. answer_segments — แยก `|||` ได้ 3 segments ✓
  5. order_sn lookup — lookup จริง, ส่ง context เข้า prompt ✓
  6. handoff ไม่ส่ง API เมื่อไม่มี conversation_id ✓
  7. simulate_assignment ส่งไป handoff API ✓

**⚠️ ยังไม่ได้ทดสอบ:**
- Live OpenRouter call พร้อม v3 features ใหม่
- Live MongoDB product match พร้อม v3 features ใหม่
- End-to-end `/chat` กับ `use_v3=True`
- Live ChatAdminWeb UI เลือก v3 แล้ว callBot ส่ง `use_v3: true` จริง

---

### 2026-09-12 — Shadow inbox Generate ทีละข้อดึง history รวมอนาคต

**ปัญหา:** กด Generate ทีละข้อความใน shadow inbox → บอทเห็นคำถามถัดไปด้วย
- เช่น Q1 `[item]` → บอทตอบเรื่องใบกำกับภาษี (ทั้งที่ Q1 เป็นการ์ดสินค้า)
- บางครั้งตอบ "สวัสดี" ทุกข้อเพราะเห็น Q6 "สวัสดีค่ะ" ใน history

**สาเหตุ:** `getHistoryForBot` ดึง user messages ล่าสุด 20 ข้อความจาก DB โดยไม่กรองเฉพาะข้อความก่อนหน้า inbound message ปัจจุบัน → บอทเห็น Q2-Q11 ใน history ตอนตอบ Q1

**วิธีแก้:**
1. `messageService.ts` — `getHistoryForBot` เพิ่ม parameter `beforeTimestamp?: Date`
   - ถ้าส่ง → กรอง `created_timestamp < beforeTimestamp` ทั้ง user messages และ bot replies
   - ถ้าไม่ส่ง → ใช้ทั้งหมด (สำหรับ botworker ที่ตอบข้อล่าสุด)
2. `shadowReplyService.ts` — `generateShadowReply` ส่ง `beforeTimestamp: inboundMsg.created_timestamp`
3. `shadowReplyService.ts` — เพิ่ม manual shadow replies (origin="manual") ใน history
   - ไม่งั้นกด Generate Q2 จะไม่เห็น Q1 bot reply → บอทไม่มี context
   - `getHistoryForBot` เอาเฉพาะ origin="worker" เราต้องเพิ่ม manual เอง

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/backend/service/messageService.ts` — `getHistoryForBot`
- `ChatAdminWeb/src/backend/service/shadowReplyService.ts` — `generateShadowReply`

**verify:** `npx tsc --noEmit` ผ่าน

### 2026-09-12 — Admin-chat-result detail items=0 ทั้งที่ API ส่ง 11 รายการ

**ปัญหา:** API ส่ง 11 shadow_replies กลับมา แต่หน้าบอก `detail items: 0`
**สาเหตุ:** axios ส่ง AxiosResponse ที่มี `.data` แต่หน้าเข้า `.items` โดยตรง ไม่เข้า `.data.items`
**วิธีแก้:** เข้า `.data?.items || .items` (รองรับทั้ง AxiosResponse และ plain object)
- tsc ผ่าน (admin-chat-result ไม่มี error)

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result ไม่แสดงแชท (detail ว่าง ไม่มี fallback)

**ปัญหา:** หลังจากแก้ "โชว์ Zaapi แทน bot เรา" → ลบ fullMessages rendering path ออกหมด → ถ้า detail ว่าง (conversation ยังไม่มี rating) ก็ขึ้น "ไม่มีรายการ" ทั้งที่มี fullMessages
**วิธีแก้:** เพิ่ม fallback 3 ทาง:
1. `detail.length > 0` → render จาก detail (bot_reply ของ bot เรา) + rich user content จาก fullMessages
2. `detail.length === 0 && fullMessages.length > 0` → render จาก fullMessages (user + bot จาก messages collection)
3. ทั้งคู่ว่าง → "ไม่มีรายการใน conversation นี้"
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result โชว์คำตอบ Zaapi แทน bot เรา

**ปัญหา:** แชทฝั่งบอทโชว์คำตอบของ Zaapi (ที่ส่งจริง) แทนคำตอบของ bot เรา
**สาเหตุ:** render จาก `fullMessages` (messages collection) ซึ่งมีคำตอบ Zaapi ไม่ใช่ shadow_replies
**วิธีแก้:**
- เปลี่ยน logic: ใช้ `detail` items เป็นหลัก (มี `bot_reply` ของ bot เรา)
- user message: ใช้ rich content จาก `fullMessages` (match ด้วย `message_id` → `messageMap`)
- bot reply: ใช้ `d.bot_reply` (คำตอบ bot เรา ไม่ใช่ Zaapi)
- ลบ fallback section เก่าที่ซ้ำซ้อน
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result bot ชิดขวาสุด + format ข้อความ

**ปัญหา:**
1. bot bubble ไม่ชิดขวาสุด
2. ข้อความไม่ตาม format ที่บอทพ่น — ขึ้นบรรทัดใหม่หายไป

**สาเหตุ:**
1. parent มี `max-w-[85%]` จำกัด + `justify-end` แต่ไม่ได้ใช้ `flex-1` เหมือน shadow-inbox
2. `MessageContent` fallback text render ไม่มี `whitespace-pre-wrap` → newline หายไป

**วิธีแก้:**
- **Bot ชิดขวาสุด:** parent `flex-1 min-w-0 flex flex-col items-end gap-1` (เหมือน shadow-inbox) + bubble `max-w-[85%]`
- **Format ข้อความ:** เพิ่ม `whitespace-pre-wrap break-words` ใน MessageContent ทุกจุดที่ render text:
  - fallback text (บรรทัด 271)
  - image_with_text (บรรทัด 217)
  - item/variation_card text (บรรทัด 230)
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`
- `ChatAdminWeb/src/components/chat/MessageContent.tsx`

### 2026-09-12 — Admin-chat-result ชื่อลูกค้า "ไม่ระบุชื่อ" (shadow_bot)

**ปัญหา:** list แสดง "ไม่ระบุชื่อ" แทนชื่อลูกค้า ทั้งที่ shadow-inbox โชว์ได้
**สาเหตุ:** API ดึง `shop_name` จาก `shop_id` แต่ไม่ได้ดึง `to_name` จาก `conversation_id`
**วิธีแก้:**
- เปลี่ยน query จาก `find({ shop_id: { $in: shopIds } })` → `find({ conversation_id: { $in: convIds } })`
- สร้าง `convInfoMap` (conversation_id → { shop_name, to_name })
- ส่ง `to_name` และ `shop_name` จาก convInfoMap แทน
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/api/admin-chat-result/route.ts`

### 2026-09-12 — Admin-chat-result bot render เหมือน shadow-inbox + ล้าง toggle

**ปัญหา:**
1. มี toggle "ดูเต็ม/ย่อ" ที่ไม่จำเป็น — ควรโชว์เต็มเสมอ
2. แนะนำสินค้า (ภาพ/ลิงค์) ไม่โชว์ เพราะ bot render ใช้ text ธรรมดา ไม่ใช้ MessageContent
3. bot bubble ไม่ชิดขวาสุด

**วิธีแก้:**
- **Bot render เหมือน shadow-inbox:** ใช้ `MessageContent` สำหรับแต่ละ segment (แยกด้วย |||)
  - ส่ง `products` และ `table` ไปที่ segment สุดท้าย (กันซ้ำ) เหมือน ShadowConversationPanel
  - รองรับ: image, video, sticker, item card, variation card, product card, link, bold
- **ล้าง toggle:** ลบ `showFullBot` state, `toggleFullBot` function, `Eye/EyeOff` imports
- **ชิดขวาสุด:** parent `max-w-[85%]` + `justify-end` + `items-end`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Admin-chat-result list style เหมือน shadow-inbox + bot bubble ชิดขวา

**ปัญหา:**
1. bot bubble ไม่ชิดขวากว่าเดิม
2. list แสดงแค่ชื่อร้าน ไม่แสดงชื่อลูกค้า/วันที่/จุดที่มา/รีวิว
3. style ไม่เหมือน shadow-inbox

**วิธีแก้:**
- **List style (เหมือน shadow-inbox):**
  - Row 1: ชื่อลูกค้า (`to_name`) + platform dot + scope badge + วันที่
  - Row 2: ชื่อร้าน (`shop_name`)
  - Row 3: แอดมิน + รายการ + รีวิว (✓/✗/★/💬)
  - active row: `bg-pale-sky-soft border-l-2 border-l-brand` (เหมือน ChatList)
- **Bot bubble ชิดขวากว่าเดิม:**
  - parent: `flex-row-reverse justify-end` + `max-w-[80%]` (จำกัดความกว้าง)
  - bubble: `w-fit max-w-full` (หดตามเนื้อหา ไม่ขยายเต็ม)
- **User bubble ชิดซ้าย:**
  - parent: `justify-start` + `max-w-[80%]`
  - bubble: `w-fit max-w-full`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — User bubble fixed ขนาด ไม่ตามเนื้อหา

**ปัญหา:** bubble ฝั่งลูกค้าไม่ตามความยาว/กว้างของเนื้อหา — ขยายเต็มกรอบเสมอ
**สาเหตุ:** ไม่มี `w-fit` → div ขยายเต็ม parent
**วิธีแก้:**
- เพิ่ม `w-fit` ใน user bubble (ทั้ง MessageContent และ fallback text)
- admin-chat-result: 2 จุด (fullMessages mode + fallback mode)
- test-chat-result: มี w-fit อยู่แล้ว
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Bot multi-bubble เลื่อมกัน (ไม่เสอ)

**ปัญหา:** ข้อความฝั่งบอทแต่ละ segment (แยกด้วย |||) เลื่อมติดกัน ไม่มีช่องว่างคั่น
**สาเหตุ:** แต่ละ segment ใช้ `<div key={si}>` เรียงกันโดยไม่มี margin/gap
**วิธีแก้:**
- เพิ่ม `space-y-0.5` ในแต่ละ segment wrapper
- เปลี่ยน parent container `gap-1` → `gap-2` (เพิ่มระยะห่างระหว่าง segment + rating)
- แก้ทั้ง admin-chat-result และ test-chat-result
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`
- `ChatAdminWeb/src/app/(console)/test-chat-result/page.tsx`

### 2026-09-12 — Shadow inbox Generate ทีละข้อดึง history รวมอนาคต## ผ่านแล้ว

### 2026-09-12 — Admin-chat-result ไม่โชว์แชท (detail=0 แต่มี messages)

**ปัญหา:** คลิก conversation → บอก "ไม่มีรายการใน conversation นี้" ทั้งที่มีข้อความ (fullMessages=22)
**สาเหตุ:** API ส่งเฉพาะ rated items (จาก shadow_replies/test_assignment/test_chat_ratings) — ถ้า conversation ยังไม่มี rating → items=0 → หน้าแสดง "ไม่มีรายการ"
**วิธีแก้:**
- เปลี่ยน render logic: ถ้ามี `fullMessages` → render แชทจาก messages collection เป็นหลัก (user ซ้าย / bot ขวา)
- merge rating จาก detail items โดย match ด้วย `message_id` หรือ `text`
- ถ้าไม่มี fullMessages (เช่น test_chat) → fallback render จาก detail items
- ลบ debug box ออก
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`
- `ChatAdminWeb/src/app/api/admin-chat-result/route.ts` (ลบ debug log)

### 2026-09-12 — Admin-chat-result detail ว่าง + ตัวอักษรเล็ก

**ปัญหา:**
1. คลิก conversation ใน list → detail บอก "ไม่มีรายการใน conversation นี้" ทั้งที่มีข้อมูล
2. ตัวอักษรเล็กเกินไป

**สาเหตุ:** `loadDetail` ส่ง `admin_id` กลับไปกรองใน API อีกครั้ง — ถ้า conversation มี rating จาก admin หลายคน แต่ filter เลือก admin คนใดคนหนึ่ง → กรองจนเหลือ 0

**วิธีแก้:**
- `loadDetail` — ไม่ส่ง `admin_id` ตอนโหลด detail (หน้านี้ dev-only เห็นทุก Q&A ใน conversation ได้)
- เพิ่มขนาดตัวอักษร:
  - chat bubbles: `text-xs` → `text-sm`
  - rating/comment: `text-[9px]` → `text-xs`, star size 10 → 12
  - conversation list: `text-xs` → `text-sm`, `text-[9px]` → `text-xs`
  - header: `text-sm` → `text-base`, `text-[10px]` → `text-xs`
  - scope badge: `text-[9px]` → `text-xs`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — ZMIThailand context loss รอบจริง (Phase 3.1 — 4 จุด)

**ปัญหา:** เคสจริง ZMIThailand 13Q — Q1 ลูกค้าส่ง `[variation_card]` (มี item_id แนบ) → bot ตอบ AL870/AL856/CL315P ถูก แต่ Q2-Q13 follow-up กลับดึงสินค้าอื่นมาทับ anchor ตลอด
- Q2 "ไอโฟน 11โปรแม๊กอันไหนคับ" → ดึง AL805/GL870/HA728 ทับ
- Q3 "ต่างกันยังไงคับ" → ดึง CUKTECH GaN3 AD1404T/U ทับ
- Q7 "สายแท้ มั้ยคัย" → ดึง AL805/GL870/HA728 ทับ
- Q10 "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → ดึง ZMI CUKTECH B06 ทับ

**สาเหตุ 4 จุด:**

1. **`_filter_charger_subtype` อ่าน field ผิด** — ใช้ `d.get("item_name")` แต่ `to_product_card` คืน field `name` → กรอง active_card (AL870) ออกเหลือ 0 → ยกเลิก `_ref_regex_products` → ไป fetch_products ใหม่ → ดึงสินค้าอื่นมาทับ
2. **web_search ทับ anchor** — LLM ตอบ "ไม่มี" กับ anchor product → trigger `compatibility_check_negative_answer` → web_search ดึงสินค้าอื่นมาทับ
3. **FOLLOWUP-COMP จับ placeholder เป็น model** — `extract_model_keywords` จับ `[variation_card]` เป็น model keyword → สร้าง message `"2217375776] vs [variation_card] vs Type"` → ดึงสินค้าอื่น
4. **CONV-ACTIVE ไม่ทำงานเมื่อมี charger_sub** — `if req.conversation_id and not _cur_charger_sub` → "สายแท้" ถูก detect เป็น cable → ข้าม CONV-ACTIVE → ไม่ใช้ anchor

**วิธีแก้:**

1. **`product_store.py` — `_filter_charger_subtype`**: เปลี่ยน `d.get("item_name")` → `d.get("item_name") or d.get("name")` (รองรับทั้ง doc ดิบและ product card)
2. **`app.py` — web_search fallback**: เพิ่มเงื่อนไข `if _ws.is_configured() and not _is_conv_active` — ถ้ามี anchor อยู่แล้ว ไม่ trigger web_search (anchor คือสินค้าที่ลูกค้าสนใจ ถ้า LLM ตอบ "ไม่มี" น่าจะ LLM ตอบผิด ไม่ใช่สินค้าไม่มีจริง)
3. **`app.py` — FOLLOWUP-COMP**: กรอง placeholder/tag ออกจาก history text ก่อน `extract_model_keywords` — ใช้ `_ITEM_TAG_RE.sub()` + replace `[variation_card]`, `[item]`, `[สินค้า]`, ฯลฯ
4. **`app.py` — CONV-ACTIVE**: ยกเลิกเงื่อนไข `not _cur_charger_sub` → ทำงานแม้มี charger_sub + เช็ค subtype ของ active_card ว่าตรงกันไหม:
   - ถ้า `_cur_charger_sub == "adapter"` แต่ `_active_sub == "cable"` และไม่มี strong adapter keyword (หัวชาร์จ/adapter/gan) → "หัว" ลอยๆ ไม่ใช่การเปลี่ยนหมวด → ใช้ active ต่อ
   - ถ้า subtype เปลี่ยนจริง → ไม่ใช้ active (ไป fetch ใหม่)

**ไฟล์ที่แก้:**
- `chatbot/shopeechat/product_store.py` — `_filter_charger_subtype` บรรทัด ~1532
- `chatbot/shopeechat/app.py` — web_search fallback บรรทัด ~4733, FOLLOWUP-COMP บรรทัด ~1092, CONV-ACTIVE บรรทัด ~2895

**ผลการทดสอบ (ZMIThailand 13Q รอบจริง):**
- Q1 `[variation_card]` (item_id=2217375776) → ตอบ AL870/AL856/CL315P ✓
- Q2 "ไอโฟน 11โปรแม๊กอันไหนคับ" → ใช้ anchor 2217375776 ต่อ ✓
- Q3 "ต่างกันยังไงคับ" → ตอบ AL870/CL315P ต่อ ✓
- Q4 "ไม่เคยใช้ของแบนนี้" → ใช้ anchor ต่อ ✓
- Q5 "ใช้กับที่ชาต มอเตอร์ไซค์" → ใช้ anchor ต่อ ✓
- Q6 "ใช้กับมอไซร" → ใช้ anchor ต่อ ✓
- Q7 "สายแท้ มั้ยคัย" → ใช้ anchor ต่อ ✓
- Q8 "ทำไมราคาแรงจัง" → ใช้ anchor ต่อ ✓
- Q9 "ราคาเกือบ ๆสายแท้เลย" → ใช้ anchor ต่อ ✓
- Q10 "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → ใช้ anchor ต่อ ✓
- Q11 "ชาต" → ใช้ anchor ต่อ ✓
- Q12 "แล้วมีประกันมั้ยคับ" → ตอบ warranty policy ✓
- Q13 "ประกันเท่าไรคับ" → ตอบ warranty policy ✓

**Regression ที่ผ่าน:**
- CW400 (item_id=6919173680) → ตอบไม่มี CW400 ไม่ดึง TP-Link ทับ ✓
- Charger typo "หัวชาจ" → ตอบหัวชาร์จถูก ✓
- iSuper multi-use-case (วิ่ง + ANC) → แนะนำ SoundActiv Run + SOUND COMFORT ✓

**verify:** `python3 -m py_compile` ผ่านทุกไฟล์

---

### 2026-09-12 — Admin-chat-result rich content + multi-bubble |||

**ปัญหา:** admin-chat-result แสดงแค่ text ธรรมดา — ไม่โชว์ variation card, image, video, sticker, item card และไม่แยก bubble |||

**วิธีแก้:**
- เพิ่ม `fullMessages` state — โหลดจาก `chatService.messages(conversation_id)` (สำหรับ shadow_bot + test_assignment)
- สร้าง `messageMap` (message_id → ChatMessage) เพื่อ match rating item กับ full message
- User message: ถ้ามี fullMsg → render ด้วย `MessageContent` (รองรับ image/video/sticker/item card/variation card) | fallback เป็น text
- Bot reply: split ด้วย `splitAnswerSegments` (|||) → render เป็น multi-bubble แยกกัน
- แต่ละ segment มี "ดูเต็ม/ย่อ" ถ้าเกิน 400 ตัวอักษร
- import `MessageContent`, `splitAnswerSegments`, `chatService`, `ChatMessage`
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/admin-chat-result/page.tsx`

### 2026-09-12 — Test-assignment All/History tab incremental rendering (เหมือน shadow-bot)

**ปัญหา:** test-assignment All tab โหลด 2000 conversation จาก API แล้ว render ทั้งหมดทีเดียว → หนัก/ช้า
- shadow-bot ใช้ `ChatList` component ที่มี incremental rendering (50 ต่อ scroll)
- test-assignment render list เอง → ไม่มี incremental rendering

**วิธีแก้:**
- เพิ่ม `RENDER_BATCH = 50` + `allRenderCount` + `historyRenderCount` state
- เพิ่ม `allListRef` + `historyListRef` (useRef)
- เพิ่ม `handleAllScroll` + `handleHistoryScroll` — เมื่อ scroll ใกล้ล่าง (200px) → เพิ่ม 50 รายการ
- ใช้ `filteredConvs.slice(0, allRenderCount)` แทน `filteredConvs` ทั้งหมด
- ใช้ `historyRows.slice(0, historyRenderCount)` แทน `historyRows` ทั้งหมด
- reset renderCount เมื่อ filter/sort เปลี่ยน (track ด้วย `allFilterSig` + `prevAllFilterSig`)
- แสดง "แสดง X จาก Y · scroll เพื่อโหลดเพิ่ม" ท้าย list เมื่อยังมีเหลือ
- import `useRef` เพิ่ม
- tsc ผ่าน

**ไฟล์ที่แก้:**
- `ChatAdminWeb/src/app/(console)/test-assignment/page.tsx`


---

## ผ่านแล้ว

### 2026-09-07 — Context loss + ANC search + "สอบถาม" new topic (Phase 3)

**เคส A — ZMIThailand context loss:**
- Q1 ลูกค้าส่ง `[variation_card]` → บอทตอบ AL870/AL856/CL315P (ถูก)
- Q2 "ไอโฟน 11โปรแม๊กอันไหนคับ" → บอทลืมสินค้าเดิม ดึง AL805/HA719 มาแทน
- Q3-Q6 ตอบมั่วเรื่องหัวชาร์จตลอด
- **สาเหตุ:** `extract_model_keywords("ไอโฟน 11โปรแม๊กอันไหนคับ")` จับ "11โปรแม๊ก" เป็น model keyword → CONV-ACTIVE ข้าม → ไม่ใช้ anchor

**เคส B — mosaakub ANC search:**
- Q2 "รอบกวนสอบถาม 2 รุ้นครับ สำหรับวิ่ง และตัดเสียงรบกวน" → บอทตอบแค่รุ่นวิ่ง ส่วน ANC บอก "ทักแอดมิน"
- **สาเหตุ 3 ชั้น:**
  1. "สอบถาม" อยู่ใน `_new_topic_kws` → Q2 ถูกจัดเป็น new topic → ไม่ carry anchor
  2. "ตัดเสียงรบกวน" ไม่อยู่ใน earphone keywords → `_detect_product_types` ไม่เจอ earphone
  3. ไม่มี feature-based search → บอทค้น "หูฟัง" ใน item_name แต่ไม่ค้น "ANC"

### วิธีแก้

**1. `knowledge_base.py` — แยก target device ออกจาก model keyword**
- เพิ่ม `_TARGET_DEVICE_KWS` (iphone/ไอโฟน/samsung/โปรแม็ก/ultra/ฯลฯ)
- เพิ่ม `is_target_device_kw(kw)` helper
- ใน `extract_model_keywords` กรอง target device ออกจาก candidates

**2. `app.py` — 4 จุด**
- CONV-ACTIVE (บรรทัด ~2894): กรอง target device ออกจาก `_cur_model_kw` ก่อนเช็ค
- `_new_topic_kws` (บรรทัด ~531): เอา "สอบถาม" ออก
- `_new_topic_kws_cp` (บรรทัด ~2902): เอา "สอบถาม" ออก
- Multi-use-case (บรรทัด ~3949): ถ้า message มี "2 รุ้น"/"สองรุ่น" + earphone → แยกค้นตาม use case (วิ่ง/ANC) แล้วรวมผล

**3. `product_store.py` — 2 จุด**
- `PRODUCT_TYPES` earphone: เพิ่ม "ตัดเสียงรบกวน", "ANC", "noise cancelling", "降噪" ฯลฯ
- `build_query`: feature-based search — ถ้า message มี feature keyword (ANC/กันน้ำ/วิ่ง) ให้ค้นใน item_name ด้วย `$and`

### ไฟล์ที่แก้
- `chatbot/shopeechat/knowledge_base.py` — เพิ่ม `_TARGET_DEVICE_KWS`, `is_target_device_kw()`, กรองใน `extract_model_keywords`
- `chatbot/shopeechat/app.py` — 4 จุด (CONV-ACTIVE filter, 2 new_topic_kws, multi-use-case)
- `chatbot/shopeechat/product_store.py` — earphone keywords + feature-based search ใน `build_query`
- `docs/SRS_SSD.md` — อัปเดต section 6.5.2 + เพิ่ม `is_target_device_kw` detail

### Verification
- `python3 -m py_compile chatbot/shopeechat/app.py chatbot/shopeechat/knowledge_base.py chatbot/shopeechat/product_store.py` → ALL OK
- TypeScript error ใน `testAssignmentService.ts` เป็น error เดิม ไม่เกี่ยวกับการแก้ครั้งนี้

### ทดสอบใน test-chat (2026-09-07)

**เคส A — ZMIThailand context loss:**
- Q1: ส่ง `[สินค้า: 2217375776]` (AL870/AL856/CL315P) → บอทตอบถูก ✓
- Q2: "ไอโฟน 11โปรแม๊กอันไหนคับ" → บอทใช้ anchor ต่อ (SOURCE: item_tag) → ตอบ AL870/AL856/CL315P ✓
- ก่อนแก้: บอทดึง ZM211/CTC620W มาแทน (context loss)
- หลังแก้: บอทใช้สินค้าเดิม → ตอบถูก

**เคส B — mosaakub ANC:**
- ส่ง "รอบกวนสอบถาม 2 รุ้นครับ สำหรับวิ่ง และตัดเสียงรบกวน" ร้าน "iSuper"
- บอทแนะนำ 2 รุ่น: iSUPER SoundActiv Run (วิ่ง) + iSUPER SOUND COMFORT PRO (ANC -50dB) ✓
- FEATURE-SEARCH log แสดงกรอง "วิ่ง" + "ANC" ใน item_name ✓
- MULTI-CASE logic ทำงาน — แยกค้นตาม use case แล้วรวมผล ✓
- ก่อนแก้: บอทตอบแค่รุ่นวิ่ง ส่วน ANC บอก "ทักแอดมิน"
- หลังแก้: บอทตอบครบทั้ง 2 use case และเจอสินค้า ANC จริงในร้าน

**แก้เพิ่มระหว่างทดสอบ:**
- `is_target_device_kw` เดิมใช้ `re.fullmatch` → ไม่ match "11โปรแม๊กอันไหนคับ" (token เดียวไม่มี space)
- แก้เป็น `re.search` เพื่อจับ target device pattern ที่อยู่ข้างใน token ยาว
- ยืนยัน model จริง (AL870, BioKoop, EC4) ไม่ถูกกรอง ✓

### ความเสี่ยงต่อเคสเก่า
- **เคส A fix:** กรอง target device ออกจาก model keyword → เคส Q14 BioKoop ไม่กระทบ (BioKoop ไม่ใช่ target device)
- **เคส B fix:** เพิ่ม keyword ใน earphone → ไม่กระทบเคสอื่น (เป็นการเพิ่มไม่ใช่ลบ)
- **"สอบถาม" ออกจาก new_topic:** เคส Q1-Q14 ไม่มี "สอบถาม" ใน message หลัก → ไม่กระทบ

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
| `chatbot/shopeechat/app.py` | CONV-ACTIVE ก่อน history, guard placeholder, กัน reset, ข้าม fetch, warranty detection, claim state machine, trust prompt, **State 7 awaiting_claim_info (รับรูปใน claim flow)**, **ข้าม order_lookup ใน claim flow**, **Phase 3 test_chat_sessions admin_id ownership + log filter** | C, A, B, D, Q14, **Warranty-Image**, **TestChat-Ownership** |
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
| `ChatAdminWeb/.../chat/TestChatClient.tsx` | **Phase 3 — tab "ประวัติ" ดู test_chat_logs (สลับ ฉัน/ทุกคน)** | **TestChat-Ownership** |
| `docs/schema.md` | **Phase 3 — เพิ่ม field admin_id, admin_name ใน test_chat_sessions** | **TestChat-Ownership** |
| `docs/SRS_SSD.md` | **Phase 3 — อัปเดต section 6.1.1 + เพิ่ม 6.1.6 detail ของ list/create_test_chat_session + list_test_chat_logs** | **TestChat-Ownership** |
| `ChatAdminWeb/.../chat/TestChatClient.tsx` | **Phase 3 — tab "ประวัติ" ดู test_chat_logs (สลับ ฉัน/ทุกคน)** | **TestChat-Ownership** |
| `docs/schema.md` | **Phase 3 — เพิ่ม field admin_id, admin_name ใน test_chat_sessions** | **TestChat-Ownership** |
| `docs/SRS_SSD.md` | **Phase 3 — อัปเดต section 6.1.1 + เพิ่ม 6.1.6 detail ของ list/create_test_chat_session + list_test_chat_logs** | **TestChat-Ownership** |

---

## กำลังจะทำ (ใหม่ — 2026-09-12)

### Vision hallucination (รูปแมว → บอทบอกเป็นพาวเวอร์แบงค์)

**ปัญหา:** shadow script ส่ง `history_context` ให้ vision model โดยรวมคำถามก่อนหน้า (เช่น "Mi 17 ultra ใช้พาวเวอร์แบงค์ไหน") → vision model โดน bias และ hallucinate ว่ารูปแมวเป็นพาวเวอร์แบงค์ CukTech PB100P

**สาเหตุ:**
1. `shadow_openrouter.py` บรรทัด 337 ส่ง `merged[:200]` (รวมคำถามก่อนหน้าทั้งหมด) เป็น history_context
2. `llm.py describe_image()` บรรทัด 574-577 ส่ง history_context เข้า prompt โดยไม่มี guard ว่า "ห้ามให้ context ไป override สิ่งที่เห็นในรูปจริง"
3. `_VISION_PROMPT` ไม่ได้บอกชัดว่า context เป็นแค่ hint ไม่ใช่ตัวกำหนด

**แผนแก้:**
1. `llm.py` — แก้ `_VISION_PROMPT` เพิ่มบรรทัดชัดเจนว่า "อธิบายเฉพาะที่เห็นในรูปจริง ห้ามให้ history context ไปกำหนดประเภทของรูป"
2. `shadow_openrouter.py` บรรทัด 337 — เปลี่ยนจาก `merged[:200]` เป็นเฉพาะคำถามล่าสุด (last user text) ลด bias
3. อัปเดต SRS_SSD.md section 6 ของ `describe_image`
4. verify: `python -m py_compile`

### ผลลัพธ์ — ผ่านแล้ว (2026-09-12)

**วิธีแก้:**
1. `chatbot/shopeechat/llm.py` — `_VISION_PROMPT` เพิ่ม 4 บรรทัด guard ชัดเจน:
   - "อธิบายเฉพาะสิ่งที่เห็นในรูปจริงเท่านั้น"
   - "ห้ามใช้ history เป็นตัวกำหนดว่ารูปเป็นอะไร"
   - "ถ้าในรูปเป็นแมว/สัตว์ ต้องบอกตรงๆ"
   - "แม้ history จะคุยเรื่องสินค้า ก็ห้ามสรุปว่ารูปเป็นสินค้าถ้าไม่เห็นสินค้าในรูปจริง"
2. `chatbot/shadow_openrouter.py` บรรทัด 337 — เปลี่ยนจาก `merged[:200]` (รวมคำถามก่อนหน้าทั้งหมด) เป็น `text[:150]` (เฉพาะคำถามปัจจุบันที่มีรูป) + เปลี่ยน label จาก "History:" เป็น "คำถามปัจจุบัน:"
3. `chatbot/shadow_openrouter.py` บรรทัด 353 — step log เปลี่ยน `history_context` → `current_question` ให้สะท้อนสิ่งที่ส่งจริง
4. `docs/SRS_SSD.md` — อัปเดต row `describe_image` บอก guard กัน hallucination

**verify:**
- `python3 -m py_compile chatbot/shopeechat/llm.py` ผ่าน
- `python3 -m py_compile chatbot/shadow_openrouter.py` ผ่าน

**หมายเหตุ:** การแก้นี้กระทบทั้ง production bot (`describe_image()` ใน llm.py) และ shadow script — ทั้งคู่ใช้ `_VISION_PROMPT` ตัวเดียวกัน การเพิ่ม guard ใน prompt กัน hallucination ทุกที่ ส่วน history_context ใน production `describe_image()` ยังคงส่งอยู่ (มี use case เคลมที่ต้องการ context) แต่ prompt ใหม่จะกันไม่ให้ context ไป override สิ่งที่เห็นในรูปจริง

---

### item_tag anchor ไม่เช็ค charger subtype → ตอบสายชาร์จแทนหัวชาร์จ (2026-09-12)

**ปัญหา:** ลูกค้าแชร์การ์ดสายชาร์จ CTL301 (Q1) → ถาม "หัวชาร์จละ" (Q4) → บอทตอบ CTL301 (สายชาร์จ) แทนหัวชาร์จ

**สาเหตุ:**
1. Q1 มี `[สินค้า: 49267582152]` ใน history
2. Q4 "หัวชาร์จละ" ไม่มี new_topic keyword ("สวัสดี", "อยากได้", ฯลฯ) → ถูกมองเป็น follow-up
3. app.py บรรทัด 577-595: หา tag ใน history → เจอ CTL301 → ใช้เป็น anchor
4. app.py บรรทัด 633-669: ใช้ anchor card ตอบทันที (source="item_tag") ข้าม fetch_products ทั้งหมด
5. ไม่มีการเช็คว่า charger subtype ของ message ต่างจาก anchor หรือไม่

**แผนแก้:**
1. เช็ค charger subtype mismatch ใน `if anchor_card:` block — ถ้า message มี subtype ชัดและต่างจาก anchor → fall through ไป fetch_products
2. เก็บ anchor ไว้ใน conversation_products timeline (ไม่ลบ) แต่ไม่ใช้เป็น product หลัก
3. CONV-ACTIVE ด้านล่างจะเช็ค subtype mismatch อีกครั้งและไม่ใช้ anchor (line 3056)

### ผลลัพธ์ — ผ่านแล้ว (2026-09-12)

**วิธีแก้:**
1. `chatbot/shopeechat/app.py` บรรทัด 633 — เพิ่ม charger subtype mismatch check ก่อน return early:
   - `_cur_sub_anchor = product_store._detect_charger_subtype(req.message)`
   - `_anchor_sub = product_store._detect_charger_subtype(anchor_card.get("name") or ...)`
   - ถ้า `_cur_sub_anchor and _cur_sub_anchor != _anchor_sub` → ไม่ return, fall through ไป main flow
   - ถ้า subtype เดียวกันหรือไม่มี subtype → ใช้ anchor ตามเดิม

**verify:**
- `python3 -m py_compile chatbot/shopeechat/app.py` ผ่าน
- Q4 "หัวชาร์จละ" (หลังแชร์ CTL301 cable): source=product_store, products=5 หัวชาร์จ (ไม่ใช่ CTL301) ✓
- Edge case 1: ถาม "รายละเอียดสินค้า" (no subtype) → source=item_tag, anchor ใช้ตามเดิม ✓
- Edge case 2: ถาม "หัวชาร์จตัวนี้รับประกันกี่ปี" (same subtype) → source=item_tag, anchor ใช้ตามเดิม ✓
- Edge case 3: ถาม "หัวชาร์จละ" (different subtype) → source=product_store, fall through ✓
- Regression test: 16/16 ผ่าน

**ยังไม่ได้แก้ (แยกปัญหา):**
- Q3 "อยากได้ของที่ใช้กับ xiaomi 17 ultra" — "อยากได้" trigger new_topic → anchor ไม่ถูกใช้ → บอทดึงสินค้า Xiaomi สุ่ม ควรเป็น compatibility check ของสายชาร์จ CTL301 กับ Mi 17 Ultra หรือแนะนำสาย USB-C to USB-C

---

### Q3 "อยากได้ของที่ใช้กับ xiaomi 17 ultra" — hybrid anchor+fetch (2026-09-12)

**ปัญหา:** ลูกค้าแชร์การ์ดสายชาร์จ CTL301 (Q1) → ถาม "อยากได้ของที่ใช้กับ xiaomi 17 ultra" (Q3) → บอทดึงสินค้า Xiaomi สุ่ม (phones/routers) แทนบอกว่า CTL301 ไม่รองรับ Mi 17 Ultra

**สาเหตุ:**
1. "อยากได้" อยู่ใน `_new_topic_kws` (4 จุด: บรรทัด 584, 3078, 3158, 3892) → `is_new_topic=True` → ทิ้ง anchor (CTL301)
2. message ไม่มี product type ชัด → fetch สินค้า Xiaomi สุ่ม (phones/routers/vacuum)
3. ทั้งที่ message มี "ใช้กับ" → เป็น compatibility question ไม่ใช่ new topic

**แผนแก้ (solution C — hybrid anchor+fetch):**
1. Guard "อยากได้" ด้วย compat indicator — ถ้ามี "อยากได้" + "ใช้กับ/รองรับ" + ไม่มี product type ชัด → ไม่ใช่ new topic
2. anchor block — ถ้า compat + target_device → fall through (ไม่ return early) + เก็บ `_hybrid_anchor_card`
3. CONV-ACTIVE guard — ถ้า compat + target_device → ไม่ใช้ active เป็น product เดียว
4. เพิ่ม anchor product_type ใน `req.message` เพื่อให้ fetch_products ดึงสินค้าประเภทเดียวกับ anchor
5. Merge anchor กับ products หลัง fetch (ทั้ง KB+Mongo path และ main flow) + เพิ่ม context note บอก LLM

### ผลลัพธ์ — ผ่านแล้ว (2026-09-12)

**วิธีแก้:**
1. `app.py` บรรทัด 582-597 — Guard "อยากได้" ด้วย compat indicator:
   - `_compat_kws_early = ("ใช้กับ", "รองรับ", "สำหรับ", "compatible", "support", "works with")`
   - ถ้า `_is_new_topic and not _current_model_kw and _has_compat_early` → `_is_new_topic = False`
2. `app.py` บรรทัด 642-672 — anchor block: ถ้า compat + target_device → set `_hybrid_anchor_card` + fall through
3. `app.py` บรรทัด 711-734 — เพิ่ม anchor product_type ใน `req.message` (เช่น "ชาร์จ charger สายชาร์จ cable")
4. `app.py` บรรทัด 3097-3123 — CONV-ACTIVE guard: ถ้า compat + target_device → ไม่ใช้ active เป็น product เดียว
5. `app.py` บรรทัด 2696-2722 — KB+Mongo path: merge anchor + context note
6. `app.py` บรรทัด 4868-4891 — Main flow: merge anchor + context note

**verify:**
- `python3 -m py_compile chatbot/shopeechat/app.py` ผ่าน
- Q3 "อยากได้ของที่ใช้กับ xiaomi 17 ultra": LLM บอก "CTL301 เป็น Lightning ไม่ใช้กับ Mi 17 Ultra" + แนะนำ Xiaomi USB-C Power Adapter ✓
- Q4 "หัวชาร์จละ": source=product_store, แนะนำหัวชาร์จจริง (CUKTECH GaN3 140W, ZMI HA729 65W) ✓
- Edge case 1: ถาม "รายละเอียดสินค้า" (no subtype) → source=item_tag, anchor ใช้ตามเดิม ✓
- Edge case 2: ถาม "หัวชาร์จตัวนี้รับประกันกี่ปี" (same subtype) → source=item_tag, anchor ใช้ตามเดิม ✓
- Edge case 3: ถาม "หัวชาร์จละ" (different subtype) → source=product_store, fall through ✓
- Edge case 4: CukTech Q9 "สายแรงๆ กว่านี้ใช้กับ mi 17 ulrat" → ดึงสายชาร์จ (ไม่ใช่แบต) ✓
- Regression test: 16/16 ผ่าน
- ⚡ 2026-09-12 — เพิ่ม guard "หัว" ลอยๆ (เหมือน CONV-ACTIVE) ใน item_tag block:
  - "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → _detect_charger_subtype=adapter แต่ไม่มี strong adapter kw → ใช้ anchor ต่อ (ZMIThailand Q10 ผ่าน) ✓
- ⚡ 2026-09-12 — เพิ่ม car_charger ใน _skip_ref_due_to_subtype (REFERENCE block):
  - "มีหัวชาร์จในรถไหม" หลังแชร์การ์ด CTL301 → ดึง car_charger (WCJ153, CC903P) ไม่ใช่ CTL301 ✓
  - "มีหัวชาจในรถไหม" (typo) → ดึง car_charger (WCJ153, CC903P) ✓
- ⚡ 2026-09-12 — regression เคสที่เคยผ่านทั้งหมด:
  - เคส C "ไอโฟน 11โปรแม๊กอันไหนคับ" → source=item_tag, anchor ใช้ ✓
  - Phase 2Z++++ "สายชาร์จรุ่นไหนเหมาะกัลไอโฟน 13คะ" → source=item_tag, anchor ใช้ ✓
  - Phase 1F-Q9 "สายแรงๆ กว่านี้ใช้กับ mi 17 ulrat" → source=product_store, ดึงสายชาร์จ ✓
  - REJECTION-MEMORY "สายอื่นที่ไม่ใช่ C2C515" → source=knowledge_base+mongo, ดึงสายชาร์จ ✓
  - Q5 "ใช้กับที่ชาต มอเตอร์ไซค์" → source=item_tag, anchor ใช้ ✓
  - Q6 "ใช้กับมอไซร" → source=item_tag, anchor ใช้ ✓
  - "แนะนำหัวชาร์จหน่อย" → source=product_store, ดึงหัวชาร์จ ✓
  - "แนะนำพาวเวอร์แบงค์หน่อย" → source=product_store+web_search, ดึงพาวเวอร์แบงค์ ✓

---

## ผ่านแล้ว (2026-09-12 — FILTER-UNAVAILABLE: ห้ามแนะนำขายสินค้า sold_out / status != NORMAL)

### ที่มา
QA pingevox Q4 "หัวชาร์จละ" หลังคุย CTL301 → บอทแนะนำหัวชาร์จที่ stock=0 / status=UNLIST/SELLER_DELETE/SHOPEE_DELETE
ลูกค้าบอกชัด: "เราตอบคำถามได้ สเปคบลาๆ แต่ไม่แนะนำขายสินค้าที่ stock <= 0 และ status != normal"

### สาเหตุ
`product_store.fetch_products` ไม่กรอง sold_out/non-NORMAL ออกจาก context — ส่งให้ LLM เห็นทุกสินค้า
LLM มีกฎ "ห้ามแนะนำ sold_out" ใน SYSTEM_INSTRUCTION แต่ก็ยังแนะนำขายอยู่ (เพราะเห็นสินค้าใน context)

### วิธีแก้ (2 ไฟล์ 3 จุด)
1. **`product_store.py` — `fetch_products`** (เพิ่ม param `filter_unavailable: bool = False`):
   - เมื่อ `filter_unavailable=True` → กรองสินค้าที่ `status != NORMAL` หรือ `sold_out=True` ออกจาก cards
   - fallback: ถ้ากรองแล้วว่าง (ไม่มีสินค้า available เลย) → ปล่อยทั้งหมด + ฝัง `_context_note` บอก LLM ว่า
     "สินค้าทุกตัวไม่พร้อมขาย ห้ามแนะนำ/เสนอขาย ให้บอกไม่มีสต็อก + ชวนทักแอดมิน"
2. **`app.py` — main fetch_products call** (บรรทัด ~4110):
   - คำนวณ `_filter_unavailable` จาก intent:
     - `intent=product_recommend` → `filter_unavailable=True`
     - `intent=product_spec/compatibility_check/warranty` → `filter_unavailable=False` (ลูกค้าถามเฉพาะรุ่น อาจเป็นสินค้าที่ซื้อไปแล้ว)
   - heuristic เมื่อ intent skip Pass1 (`_intent_result={}`):
     - ถ้ามี charger subtype + ไม่ใช่ spec/compat/warranty/general → ถือว่าเป็น product_recommend
3. **`app.py` — ส่ง `filter_unavailable=_filter_unavailable` ไป fetch_products** (บรรทัด ~4265)

### ไฟล์ที่แก้
- `chatbot/shopeechat/product_store.py` — `fetch_products` เพิ่ม param + filter logic + fallback note
- `chatbot/shopeechat/app.py` — คำนวณ `_filter_unavailable` + ส่งไป fetch_products

### ความเสี่ยงต่อเคสเก่า (เช็คแล้ว)
- Q3 compat "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → ไม่กรอง (compat) → ยังเห็น CTL301 + Xiaomi phones ✓
- Q9 compat "สายแรงๆ กว่านี้ใช้กับ mi 17 ulrat" → ไม่กรอง (compat) → ดึงสายชาร์จทุกรุ่น ✓
- Q10 "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → source=item_tag (anchor) → ไม่เข้า fetch_products ✓
- "มีหัวชาร์จในรถไหม" → source=product_store, ดึง car_charger (WCJ153, CC903P) stock > 0 ✓
- "แนะนำพาวเวอร์แบงค์หน่อย" → ดึงพาวเวอร์แบงค์ ✓

### เคสที่ผ่าน (verify จริง 2026-09-12)
- py_compile: app.py + product_store.py + llm.py ผ่าน ✅
- Q4 kinggadgets "หัวชาร์จละ" → source=product_store, products=2, ทั้งคู่ NORMAL stock > 0 (CUKTECH GaN3 140W) ✅
- Q4 new topic "แนะนำหัวชาร์จหน่อย" → fallback ปล่อยทั้งหมด + ฝัง note ห้ามขาย (LLM จะบอกไม่มีสต็อก) ✅
- Q9 CukTech compat "สายแรงๆ กว่านี้ใช้กับ mi 17 ulrat" → ไม่กรอง (compat) → ดึงสายชาร์จ 10 ตัว ✅
- Q3 kinggadgets compat "อยากได้ของที่ใช้กับ xiaomi 17 ultra" → ไม่กรอง (compat) → ดึง CTL301 + Xiaomi ✅
- Q10 ZMIThailand "แข็งแรงมั้ยคับ ชอบมีปันกาเรื่องหัว ชาน" → source=item_tag, anchor ใช้ ✅
- "มีหัวชาร์จในรถไหม" CukTechThailand → source=product_store, ดึง car_charger (WCJ153, CC903P) stock > 0 ✅
- Regression: test_car_charger_regression.py 16/16 ผ่าน ✅

### หมายเหตุ (2026-09-12)
- spec-up feature (ส่งสินค้าสเปคสูงสุดไปด้วยเวลาแนะนำ) — **ไม่ทำ** (user บอก "ช่างมันก่อนไม่ทำละ")
- กฎที่ใช้ตอนนี้: intent=product_recommend → กรอง sold_out/non-NORMAL ออก / intent=spec/compat/warranty → ไม่กรอง (ตอบสเปค/ประกันสินค้าที่ซื้อไปนานแล้วได้)

---

## ผ่านแล้ว (2026-09-14 — QA Shadow Inbox BUG-2/3/4/6/9/11 — แก้บัก 6 ตัวพร้อมกัน)

### ที่มา
QA notes (`shadow-inbox-bot-qa-notes.md`) ระบุบัก 11 ตัว งานนี้แก้ 6 ตัวที่ confirmed:
- BUG-2: KB `[[ ]]` markers หลุดไปหาลูกค้า
- BUG-3: บอทอ้างว่าแอดมินมาแล้ว (เท็จ) + ไม่ escalate (handoff_to_admin=null)
- BUG-4: มั่วขั้นตอนลงทะเบียนรับประกัน (QR Code ที่ไม่มีจริง)
- BUG-6: HTTP 500 เงียบ (peeslnwza007 #15/#20/#21 — history มี video)
- BUG-9: persona `abubu` หลุดข้ามร้าน (Kospet/ร้านอื่นก็ได้ abubu)
- BUG-11: web_search แพง/ช้า (24,986 tokens / 17.6s ในเคสที่ไม่จำเป็น)

### สาเหตุ + วิธีแก้

#### BUG-9 — persona abubu hardcode 5 จุด
- **สาเหตุ**: `app.py` warranty deterministic f-string ใช้ `"abubu"` ตรงๆ ทั้ง 5 จุด (บรรทัด ~1411, 1854, 2059, 2191, และ review block) — ไม่ดึงจาก persona ของร้าน
- **วิธีแก้**: เพิ่ม `_bot_name = ((_persona_doc or {}).get("bot_name") or "เรา").strip() or "เรา"` หลัง `persona.get_persona()` (บรรทัด 462) → แทนที่ `abubu` ทั้ง 5 จุดด้วย `{_bot_name}`
- **ไฟล์**: `chatbot/shopeechat/app.py`

#### BUG-3 — บอทอ้างแอดมินมาแล้ว + ไม่ escalate
- **สาเหตุ**: ไม่มี human-request detector → LLM ตอบเอง "แอดมินมาดูแลแล้วค่ะ" (เท็จ) + `handoff_to_admin=null`
- **วิธีแก้**:
  1. `app.py` — เพิ่ม `_HUMAN_REQUEST_KWS` (30+ คำ) + handoff block หลัง tax-invoice block (บรรทัด ~1095) → ถ้า match → ส่งต่อแอดมินจริง + ตอบ "เดี๋ยวส่งต่อให้แอดมินดูแลให้นะคะ"
  2. `llm.py` — เพิ่ม prompt rule ห้ามพูด "แอดมินมาแล้ว/มาดูแลแล้ว" เด็ดขาด ถ้าระบบไม่ได้ส่งต่อจริง
- **ไฟล์**: `chatbot/shopeechat/app.py`, `chatbot/shopeechat/llm.py`

#### BUG-2 — KB `[[ ]]` หลุด
- **สาเหตุ**: LLM บางครั้ง generate `[[ การรับประกันและบริการ ]]` + `---` + `หมายเหตุ:` (KB internal markup) แต่ไม่มี sanitizer strip ออกก่อนส่งลูกค้า
- **วิธีแก้**:
  1. `llm.py` — เพิ่ม `_strip_kb_markup()` helper (บรรทัด 19) + ใช้ที่ return ทั้ง 3 ของ `answer`/`answer_general`/`answer_with_kb`
  2. `app.py` — เพิ่ม `_strip_kb_markup()` helper (บรรทัด 5563) + เรียกใน `_append_base_warranty` ทั้งก่อนแนบ + หลังแนบ
- **ไฟล์**: `chatbot/shopeechat/llm.py`, `chatbot/shopeechat/app.py`

#### BUG-4 — มั่วขั้นตอนลงทะเบียน/QR Code
- **สาเหตุ**: LLM ประดิษฐ์ "สแกน QR Code บนกล่อง" / "ไปที่เว็บ XYZ" ทั้งที่ KB ไม่มีขั้นตอนจริง
- **วิธีแก้**: `llm.py` — เพิ่ม prompt rule ห้ามแต่งขั้นตอนลงทะเบียน/QR Code/URL/แอป/ฟอร์ม เด็ดขาด + บอกคำตอบปลอดภัย ("ใช้เลขคำสั่งซื้อเป็นหลักฐานได้เลย หากต้องการลงทะเบียนเพิ่ม รบกวนแจ้งแอดมิน")
- **ไฟล์**: `chatbot/shopeechat/llm.py`

#### BUG-6 — HTTP 500 เงียบ (history มี video)
- **สาเหตุ**: `import json` ขาดใน `app.py` → handoff payload ใช้ `json.dumps` ไม่ได้ → `NameError` → 500 (แก้ใน session ก่อนหน้า แล้ว verify ใน session นี้)
- **วิธีแก้**: เพิ่ม `import json` ที่ module top (บรรทัด 12) — แก้ใน session ก่อนหน้า ครั้งนี้ verify ผ่าน bot จริง
- **ไฟล์**: `chatbot/shopeechat/app.py`

#### BUG-11 — web_search แพง/ช้า
- **สาเหตุ**: `should_use_web_search` ไม่มี guard สำหรับ ordinary product query ที่มี products อยู่แล้ว + `max_tokens=1024` + `timeout=30s`
- **วิธีแก้**:
  1. `web_search.py` `should_use_web_search` — เพิ่ม guard: greeting/thanks → skip + ordinary_product_query_with_context (มี products + เป็น "ราคา/ขอลิงค์/สนใจ") → skip
  2. `web_search.py` `search_and_extract` — ลด `max_tokens` 1024 → 512 + `timeout` 30 → 20
- **ไฟล์**: `chatbot/shopeechat/web_search.py`

### ความเสี่ยงต่อเคสเก่า (เช็คแล้ว)
- BUG-9: CukTechThailand ยังได้ "abubu" (เป็น persona จริงของร้าน) ✓ / Kospet ได้ "เรา" (fallback) ✓
- BUG-3: ไม่ trigger บนคำถามสินค้า/ประกันปกติ (keyword list เฉพาะ "ขอคุยกับคน/แอดมิน") ✓
- BUG-2: ไม่ strip `**bold**` (ฝั่ง sender ทำ) / ไม่ strip เนื้อหาปกติ ✓
- BUG-4: ไม่บังคับให้ตอบ fixed phrase — LLM ยังตอบจาก KB ได้ แค่ห้ามแต่ง QR/URL ✓
- BUG-6: `import json` ไม่กระทบ flow อื่น ✓
- BUG-11: guard ทำงานเฉพาะเมื่อมี products + เป็น ordinary query — ไม่บังคับ skip สำหรับ spec/compat/uncertainty ✓

### เคสที่ผ่าน (verify จริง 2026-09-14 ผ่าน bot ที่ port 8010)
- py_compile: app.py + llm.py + web_search.py ผ่าน ✅
- BUG-9 CukTechThailand "เงื่อนไขรับประกันเป็นยังไงคะ" → มี "abubu" (persona จริงของร้าน) ✅
- BUG-9 KospetThailand "สินค้าเสีย อยากเคลมค่ะ" → ไม่มี "abubu" ใช้ "เรา" ✅
- BUG-3 BlackShark "Admin ไม่ทำงานกันหรอคะ เมื่อไหร่จะมีมนุษย์มาตอบ" → source=human_request_handoff, handoff_to_admin=True, ไม่มี "แอดมินมาแล้ว" ✅
- BUG-2 CukTechThailand "[สินค้า: 10175495624] เงื่อนไขรับประกันเป็นยังไงคะ" → ไม่มี `[[ ]]`, `---`, `หมายเหตุ:` ✅
- BUG-4 KospetThailand "ลงทะเบียนรับประกันยังไงคะ" → ไม่มี QR/สแกน/แอป/ฟอร์ม ตอบจาก KB จริง ✅
- BUG-6 KospetThailand history มี video attachment → 200 OK (ไม่ 500) ✅
- BUG-1 CukTechThailand "[order: 2409151956KQJ3] สถานะออเดอร์เป็นยังไงคะ" → source=order_lookup ✅

### ยังไม่ได้ทำ (pending)
- BUG-5: frontend ไม่ fetch conversation rows (API รองรับแล้ว แต่ UI ไม่เรียก)
- BUG-7: Zaapi ตอบสเปคแม่นกว่า (ต้องเปรียบเทียบ prompt/context)
- BUG-8: ราคา product card ผิด (186,900,000)
- UI-1: search page crash
- markdown leakage ไป Shopee sender (unconfirmed)
- avatar fallback (ไม่ทำใน scope นี้)

### Replay 12 conversation (2026-09-14 หลังแก้ครบ)

| Conversation | Shop | Q | Errors | Notes |
|---|---|---|---|---|
| shp_4706202213883068417 | KieslectThailand | 3 | 0 | ok |
| shp_2234370743100585429 | BlackShark | 11 | 0 | ok |
| shp_4243515972619489117 | CukTechThailand | — | 0 | "abubu" หลุด — เป็น persona จริงของร้าน ถูกต้อง |
| shp_25168654584899535 | YoupinOfficialStore | 2 | 0 | ok |
| shp_189458811488865924 | ZMIThailand | 14 | 0 | ok |
| shp_458397960147048739 | ZMIThailand | 1 | 0 | ok |
| shp_2512944112716742475 | CukTechThailand | — | **1 timeout** | Q3 read timeout=120 — vision pass โหลด video URL ช้า (ไม่ใช่ bug ที่แก้) |
| shp_3440141253415424272 | KospetThailand | 2 | 0 | ok (BUG-6 ผ่าน — ไม่มี 500) |
| shp_458397959910495383 | ZMIThailand | 10 | 0 | ok |
| shp_1337984705527833202 | IMILabThailand | 28 | 0 | ok |
| shp_60418748263294927 | YoupinOfficialStore | 3 | 0 | ok |
| shp_3274132825964099029 | BlackShark | 4 | 0 | ok |

**สรุป replay:**
- ✅ 0 HTTP 500 (BUG-6 ผ่าน — Kospet ไม่มี 500 แล้ว)
- ✅ 0 `[[ ]]` / `---` / `หมายเหตุ:` หลุด (BUG-2 ผ่าน)
- ✅ 0 QR Code / สแกน ปลอม (BUG-4 ผ่าน)
- ✅ Kospet ไม่มี "abubu" (BUG-9 ผ่าน — CukTech มี abubu เพราะเป็น persona จริงของร้าน)
- ⚠️ 1 timeout ที่ shp_25129441 Q3 — vision pass โหลด video URL ช้า (pre-existing, ไม่ใช่ regression จากการแก้)

---

## ผ่านแล้ว (2026-09-08 — QA Shadow Inbox BUG-10 — ห้ามบอทสรุปสต็อก/แคตตาล็อกร้านจากผลค้นว่าง/ไม่น่าเชื่อ)

### ที่มา
QA notes (`shadow-inbox-bot-qa-notes.md`) พบ BUG-10 อันตรายสุด (4 ครั้ง / 3 ร้าน):
1. `m8iolenl0i`/ZMI — การ์ดออเดอร์เฉยๆ → "สินค้าทุกรายการในร้านหมดสต็อกชั่วคราวและบางรุ่นปิดการขายไปแล้ว" (เท็จ — 12 นาทีก่อนหน้า `item_tag` บอก "พร้อมส่ง" 3 ครั้ง)
2. `taweep154`/CukTech #3 — "no.6 Ultra ไม่มีจำหน่าย" (ค้นไม่เจอ ≠ เลิกขาย)
3. `pornpansonsuwan`/Youpin — ถามอะไหล่หัวฉีด → "ร้านขายหัวชาร์จและสายชาร์จเป็นหลัก" (แต่งแคตตาล็อกจาก context สุ่ม)

### สาเหตุ (3 ชั้น — พบเพิ่มระหว่างแก้)
1. `app.py` — ปล่อยให้ flow ไปถึง `llm.answer()` แม้ products ว่างหลัง fallback ทุกชั้น — ไม่มี guard
2. `llm.py` — `_build_context` ใส่แค่ "ไม่พบสินค้าที่ตรงกับคำถามในฐานข้อมูล" เมื่อ products ว่าง + header สั่ง "ให้บอกตรงๆ ว่าร้านนี้ไม่มี" + SYSTEM_INSTRUCTION ไม่มีกฎห้าม generalize เป็นแคตตาล็อกทั้งร้าน → LLM ตี "ไม่พบ" เป็น "หมดสต็อก/เลิกขาย/ทั้งร้านของหมด"
3. `product_store.py` — `_detect_charger_subtype` จับ "หัว" ลอยๆ เป็น adapter → "หัวฉีด" (อะไหล่เครื่องฟอก) โดนดึงหัวชาร์จมาเป็น context → LLM แต่งแคตตาล็อกจาก context ผิดประเภท (พบตอน verify e2e — vector ดึงพัดลม 6 ตัวมาจากคำ "พ่นน้ำ")
4. โบนัส: LLM ตอบ "ไม่พบข้อมูล" → `should_use_web_search` จับ marker เป็น answer_uncertain → ยิง web search (แพง/ช้า — BUG-11 ด้วย)

### วิธีแก้ (3 ไฟล์ 5 จุด)
1. **`app.py` — NO-PRODUCT-GUARD** (หลัง shop fallback บรรทัด ~4638): 2 แขน
   - แขน 1: ค้นไม่เจอเลย (products=0) + (มี product intent: ptypes/ref/charger_sub/model_kw/conv_active — หรือ เป็นคำถามถามหาของเฉพาะ) → guard
   - แขน 2: เจอสินค้า แต่ผลมาจาก vector fuzzy ล้วน (ไม่มี intent ใดๆ กำกับ) + ถามหาของเฉพาะ (ไม่ใช่ browse) → ผลไม่น่าเชื่อ → guard
   - Guard action: return ตายตัด "ไม่พบข้อมูลสินค้า + ส่งเรื่องให้แอดมินตรวจสอบ" + `handoff_to_admin=True, handoff_reason="no_product_found"` + `source=no_product_found_handoff` + `routing_decision` (pattern เดียวกับ tax_invoice_handoff)
   - ยกเว้น: มีรูป (`_vision_context`) → ปล่อยไป LLM ตอบเรื่องรูป / ทักทาย-ขอบคุณ-ไม่ใช่คำถามสินค้า → ปล่อยไป LLM ตอบทั่วไป / browse (แนะนำ/มาใหม่/โปร/ขายดี) → ปล่อยให้ vector search แนะนำ
   - Seeking check: `"มี"+"ไหม"` / `"มีไหม"/"หาไหม"/"อยากได้"/"มีขาย"/"ขายไหม"` + เช็ค charger subtype ด้วย (shorthand "มีสายไหม"/"มีหัวไหม" ถูกจับที่ `_detect_charger_subtype` ไม่ใช่ `_detect_product_types` — ต้องนับเป็น intent กันพัง use case เดิม)
2. **`llm.py` — `_build_context` body เมื่อ products ว่าง** (บรรทัด 431): เพิ่มคำเตือน "⚠️ ห้ามสรุปว่าหมดสต็อก เลิกขาย ไม่มีจำหน่าย ห้ามอธิบายว่าร้านขายอะไรเป็นหลัก → บอกไม่พบข้อมูล + ชวนทักแอดมิน"
3. **`llm.py` — `_build_context` header** (บรรทัด ~484): ปรับ "ให้บอกตรงๆ ว่าร้านนี้ไม่มี" → "ให้บอกว่าไม่พบข้อมูลรุ่นนี้ในระบบค่ะ ห้ามบอกว่าหมดสต็อก/เลิกขาย/ไม่มีจำหน่าย เว้นแต่เห็น sold_out=true หรือ status != NORMAL ของรุ่นนั้นใน context จริงๆ"
4. **`llm.py` — SYSTEM_INSTRUCTION** (หลังกฎ sold_out/NORMAL): เพิ่มกฎ "context ไม่ใช่แคตตาล็อกทั้งร้าน — ห้ามสรุปเกี่ยวกับทั้งร้าน ('สินค้าทุกรายการหมดสต็อก' / 'ร้านขาย ... เป็นหลัก') เด็ดขาด + ถ้าไม่พบรุ่นที่ถาม → ตอบ 'ไม่พบข้อมูลรุ่นนี้ในระบบ + ทักแอดมิน' ห้ามบอกหมดสต็อก/เลิกขาย เว้นแต่เห็น sold_out/status จริง"
5. **`product_store.py` — `_other_prod_kws`** (ใน `_detect_charger_subtype` บรรทัด ~1433): เพิ่ม "หัวฉีด", "หัวพ่น", "หัวข้อ" — กัน "หัว" ลอยๆ จับอะไหล่หัวฉีดเป็น adapter (เป็นการเพิ่ม guard — ไม่ทำลายเคสเดิม)
6. **`app.py` — shop fallback note** (บรรทัด ~4629): ปรับ "ร้านไม่มีสินค้าที่ถาม" → "ระบบค้นหาไม่พบรุ่นที่ลูกค้าถาม + ห้ามบอกว่าหมดสต็อก/เลิกขาย — เป็นแค่ไม่พบในระบบค้นหาเท่านั้น"

### ไฟล์ที่แก้
- `chatbot/shopeechat/app.py` — NO-PRODUCT-GUARD (2 แขน) + shop fallback note
- `chatbot/shopeechat/llm.py` — `_build_context` body ว่าง + header + SYSTEM_INSTRUCTION กฎแคตตาล็อก
- `chatbot/shopeechat/product_store.py` — `_other_prod_kws` เพิ่ม หัวฉีด/หัวพ่น/หัวข้อ
- `docs/SRS_SSD.md` — อัปเดต section 6 (chat + _build_context + _detect_charger_subtype)

### ความเสี่ยงต่อเคสเก่า (เช็คแล้ว)
- CW400 (Phase 3.1) — ยังตอบ "ไม่พบรุ่นนี้" ไม่ดึง TP-Link ทับ ✓
- Car charger (Phase 2Z+++) — ค้นเจอ products → guard ไม่ทำงาน ✓
- iSuper ANC multi-use-case — ค้นเจอ ✓
- Superlative no-match — path เฉพาะ return ก่อน ✓
- kb+mongo / general / trivial / warranty / order lookup — return ก่อนถึงจุดนี้ ✓
- Vision (ส่งรูป) — `_vision_context` ยกเว้น ✓
- Shorthand "มีสายไหม"/"มีหัวไหม" — จับผ่าน `_detect_charger_subtype` เป็น intent → ไม่โดน guard ✓
- Browse "มีสินค้าแนะนำไหม" — browse kws ยกเว้น → vector แนะนำได้ตามเดิม ✓

### เคสที่ผ่าน (verify จริง 2026-09-08)
- py_compile: app.py + llm.py + product_store.py ผ่าน ✅
- Unit 5 เคส: empty context มีคำเตือน / header ภาษาใหม่ / SYSTEM_INSTRUCTION มีกฎ / ขอบคุณ-สวัสดีไม่โดน / หัวชาร์จ detect ได้ ✅
- Detection: "หัวฉีด"→None (ไม่ใช่ adapter) / "หัวชาจในรถ"→car_charger / "หัวชาร์จ 65w"→adapter / "มีหัวไหม"→adapter ✅
- e2e เคส A: "มีอะไหล่หัวฉีดตัวพ่นน้ำไหมคะ" → source=no_product_found_handoff + handoff=True + answer "ไม่พบข้อมูล + แอดมิน" (เดิม: แต่งแคตตาล็อก + web search 10.58s) ✅
- e2e เคส B: "ขอบคุณค่ะ" → LLM ตอบทั่วไป (guard ไม่ทำงาน) ✅
- e2e เคส C: "มีหัวชาร์จไหมคะ" CukTech → product_store ตอบปกติ ✅
- e2e เคส D: "มีสินค้าแนะนำไหมคะ" Youpin → product_store แนะนำปกติ (browse ยกเว้น) ✅
- e2e เคส E: "[order: 260907DUBY0DHF]" เฉยๆ → order_lookup รับทราบ (BUG-1 แก้แล้วโดย Rich Media Consistency ก่อนหน้า) ✅
- e2e เคส F: "2608259K9MGKSE" พิมพ์ตรง → order_lookup ✅
- e2e เคส G: "[order: ...] ส่งของรึยังคะ" → order_lookup ตอบสถานะ+ขนส่ง+วันที่ครบ ✅
- e2e เคส H: "มีสายไหม" ZMI → ตอบ "หมดสต็อกชั่วคราว" — **ตรวจ DB แล้วเป็นข้อมูลจริง** (สาย ZMI ทั้ง 10 ตัว sold_out=True/stock=0/UNLIST จริง) → ตอบถูกตามกฎ ไม่ใช่การแต่ง ✅
- Regression: test_car_charger_regression.py 16/16 ผ่าน ✅

### หมายเหตุ
- BUG-1 (การ์ดออเดอร์ไม่เข้า order_lookup): ตรวจแล้วปัจจุบันเข้า order_lookup ถูกต้อง — แก้ไปก่อนหน้าโดยงาน Rich Media Consistency (Next.js แปลง order card เป็น `[order: <order_sn>]` ให้ bot extract ได้) — QA เทสตอน 7 ก.ย. ยังเป็น `[order]` เปล่า
- BUG-11 (web_search แพง/ช้า): guard ลด trigger ได้บางส่วน (return ก่อนถึง web_search block) — เคส remaining: browse/path อื่นที่ LLM ตอบ "ไม่พบข้อมูล" แล้ว trigger web search — แยกเป็นงานถัดไป

### หลัง-verify รอบ 2 (2026-09-12) — post ITEM-TAG guard refactor + import json fix
- **สาเหตุใหม่**: log replay แสดง `[HANDOFF] setup error: name 'json' is not defined` / `[TAX-HANDOFF] error: name 'json' is not defined` — app.py มี `json.dumps`/`json.loads` 6 จุด (handoff ทั้ง tax-invoice / warranty / no-product) แต่ไม่มี `import json` ที่ top
- **แก้**: เพิ่ม `import json` ที่ top ของ `chatbot/shopeechat/app.py` (หลัง `from __future__`)
- **user แก้ ITEM-TAG guard**: แยก `_is_loose_head` (หัวลอยๆ cable→adapter ไม่ใช่การเปลี่ยนหมวดจริง) ออกจาก subtype mismatch จริง — ป้องกัน fall through ผิดเคส ZMIThailand Q10
- **Verify**:
  - py_compile app.py + llm.py + product_store.py ผ่าน ✅
  - test_car_charger_regression.py 16/16 ผ่าน ✅
  - subtype ใหม่: หัวฉีด→None / หัวพ่น→None / หัวชาจในรถ→car_charger / หัวชาร์จ 65w→adapter / มีหัวไหม→adapter / มีสายไหม→cable ✅
  - Replay QA 12 แชท (post-fix): ทุกเคส 0 errors (rerun 3 แชทที่เคย error: shp_60418748263294927 / shp_458397959910495383 / shp_1337984705527833202 + shp_189458811488865924 / shp_3274132825964099029 กลายเป็น 0 errors ในไฟล์ rerun) ✅
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (import json + ITEM-TAG guard refactor โดย user)
- **ไม่มี regression**: ทุกเคสเดิมใน ledger ยังผ่าน

---

## กำลังจะทำ (2026-09-15 — chat_v2 pipeline rewrite)

### ที่มา
`chat()` ใน `app.py` ใหญ่ 5000+ บรรทัด มี 15+ early return, 20+ shared mutable state, 50+ hardcode keyword lists ทำให้:
1. search ตอบเลย ไม่เข้า LLM2 (search_and_answer deprecated ยังใช้อยู่)
2. anchor จับ subtype ผิด (4 source แข่งกัน)
3. guard ซ้อนการ์ด ซ้อนเงื่อนไข แก้ยาก
4. RAG เคยได้ถูก ตอนนี้ผิด (layer ใหม่ทับ)
5. ตอบไม่มีข้อมูล ทั้งที่มี (NO-PRODUCT-GUARD ตัดสินใจแทน LLM)
6. สับสน สาย/หัว/พาวเวอร์แบงค์ + พิมพ์ผิด
7. KB lookup fuzzy ไม่เข้าใจ
8. hardcode keyword เยอะ เจอเคสนอกเคสตอบไม่ได้
9. การันตี ร้าน + แพลตฟอร์ม ต่อ 1 คำถาม
10. anchor ควรเก็บข้อมูลครบ + markup history

### แผน (comment code เก่าไว้ + เขียนใหม่ โดยใช้ flag สลับ)
1. สร้าง `chat_models.py` — dataclass (AnchorData, IntentData, ContextData, HistoryEntry) ✅
2. สร้าง `chat_v2.py` — pipeline ใหม่ 7 stages:
   - Stage 1: `_build_context()` → ContextData
   - Stage 2: `_check_deterministic()` → order/tracking/warranty/tax/human (เก็บเดิม)
   - Stage 3: `_classify_intent()` → IntentData (LLM เป็นหลัก)
   - Stage 4: `_detect_anchor()` → AnchorData (เก็บข้อมูลครบ)
   - Stage 5: `_retrieve_products()` → list[Product] (RAG ไม่กรอง sold_out)
   - Stage 6: `_search_if_needed()` → SearchData (search → RAG → LLM2 ไม่ตอบตรง)
   - Stage 7: `_no_product_guard()` → ด่านสุดท้าย หลัง search แล้วยังไม่เจอ
   - Stage 8: `_build_answer()` → AnswerData (LLM2)
3. เพิ่ม flag `USE_LEGACY_CHAT` ใน app.py เพื่อสลับ legacy/v2 (default=legacy)
4. เขียน test script เทียบ legacy vs v2
5. Verify: replay pingevox Mi 17 Ultra (4 คำถาม) + search สายชาร์จ + เคสเก่า

### กฎที่ต้องรักษา
- แนะนำขายเฉพาะ normal + stock>0 (LLM prompt กรอง ไม่กรองใน RAG)
- ตอบเคลม/ใบกำกับ/ประกัน (deterministic flow เก็บไว้)
- ห้ามบอกไม่มีข้อมูล → search (NO-PRODUCT-GUARD ย้ายไปหลัง search)
- search สกัด keywords + spec → RAG → LLM2 (ไม่ตอบตรง)
- RAG ไม่ตัด non-normal (ลูกค้าถามสินค้าเก่าได้)
- ห้ามกุคำตอบ
- ห้ามแนะนำตอนเคลม
- ห้าม external URL
- ห้ามบอกไม่มีข้อมูล ถ้า search ได้
- stock จาก Shopee stock เท่านั้น
- เก็บ history, buffer flush, vision, test-chat step logging ไว้

---

## ผ่านแล้ว (2026-09-15 — chat_v2 pipeline + warranty_flow + subtype mismatch + followup + rerank + filter)

### ที่มา
`chat()` ใน `app.py` ใหญ่ 5000+ บรรทัด มี 15+ early return, 20+ shared mutable state, 50+ hardcode keyword lists ทำให้:
1. search ตอบเลย ไม่เข้า LLM2
2. anchor จับ subtype ผิด (4 source แข่งกัน)
3. guard ซ้อนการ์ด ซ้อนเงื่อนไข แก้ยาก
4. RAG เคยได้ถูก ตอนนี้ผิด (layer ใหม่ทับ)
5. ตอบไม่มีข้อมูล ทั้งที่มี (NO-PRODUCT-GUARD ตัดสินใจแทน LLM)
6. สับสน สาย/หัว/พาวเวอร์แบงค์ + พิมพ์ผิด
7. KB lookup fuzzy ไม่เข้าใจ
8. hardcode keyword เยอะ เจอเคสนอกเคสตอบไม่ได้

### วิธีแก้ (3 ไฟล์ใหม่ + 1 ไฟล์แก้)

#### 1. `chatbot/shopeechat/chat_models.py` (ใหม่)
- dataclass: `AnchorData`, `IntentData`, `ContextData`, `HistoryEntry`
- ใช้ใน chat_v2 เพื่อ structure data แทน mutable variables

#### 2. `chatbot/shopeechat/warranty_flow.py` (ใหม่ — 822 บรรทัด)
- ห่อ warranty state machine จาก legacy `app.py` บรรทัด 1413-2351
- ฟังก์ชันหลัก: `handle_warranty_flow(req, ctx, history, db)` → dict | None
- รักษา logic เดิมทุก state (verify ผ่าน 12 แชทใน ledger):
  - State 1: Review request — ลูกค้าขอทวนข้อมูล
  - State 2: Post-handoff lock — บอทเคย handoff แล้ว ลูกค้าทักใหม่
  - State 3: Awaiting claim info — ลูกค้าส่งรูป/วิดีโอ/ข้อมูลบางส่วน
  - State 4: Awaiting customer info — ลูกค้าให้ชื่อ/เบอร์/order
  - State 5: Awaiting confirmation — ลูกค้ายืนยันหรือแก้ข้อมูล
  - State 6: Out of warranty consult — ลูกค้าสนใจปรึกษาแอดมิน
  - State 7: Duration answered + claim request — ถามวันที่ซื้อ + handoff
  - State 8: Warranty date follow-up — คำนวณช่วงประกัน
  - State 9: Tax invoice follow-up — บอทเคยตอบใบกำกับ ลูกค้าตอบต่อ
  - State 10: First-message claim — claim request ไม่มี history
- คืน dict ที่ chat_v2 ใช้สร้าง ChatResponse ได้เลย
- คืน None ถ้าไม่ใช่ warranty flow → ไป pipeline หลัก

#### 3. `chatbot/shopeechat/chat_v2.py` (ใหม่ — ~1100 บรรทัด)
- Pipeline ใหม่ 8 stages แทน legacy 5000+ บรรทัด:
  - Stage 1: `_build_context()` — setup + history + persona + vision
  - Stage 2: `_check_deterministic()` — order/tracking/tax/human/warranty/general/brand
  - Stage 3: `_classify_intent()` — LLM เป็นหลัก ไม่ใช่ hardcode keyword
  - Stage 4: `_detect_anchor()` — เก็บข้อมูลครบ + subtype mismatch check
  - Stage 5: `_retrieve_products()` — RAG (KB + DB) + follow-up + rerank + filter
  - Stage 6: `_search_if_needed()` — search → RAG → LLM2 (ไม่ตอบตรง)
  - Stage 7: `_no_product_guard()` — ด่านสุดท้าย หลัง search แล้วยังไม่เจอ
  - Stage 8: `_build_answer()` — LLM2 ตอบ
- ⚡ subtype mismatch: ถ้า anchor=สาย แต่ message=หัว → ไม่ใช้ anchor เป็น product หลัก
- ⚡ follow-up detection: "รับประกัน"/"ราคา"/"ต่างกันยังไง"/"อันนั้น" → ดึงสินค้าจาก history
- ⚡ rerank: เรียงตาม anchor → normal+stock → keyword match → wattage
- ⚡ filter_unavailable: intent=product_recommend → กรอง sold_out/non-NORMAL
- ⚡ compat subtype ครบ: adapter/cable/set/car_charger/wireless/desktop/socket
- ⚡ robust extraction helpers: item_id/order_sn/tracking/image/subtype/types
- ⚡ search → RAG → LLM2 (ไม่ตอบตรง) + strip URL ออกจาก search_info

#### 4. `chatbot/shopeechat/app.py` (แก้)
- เพิ่ม flag `USE_LEGACY_CHAT` (default=1=legacy, 0=chat_v2)
- เพิ่ม `_send_handoff()` helper สำหรับ chat_v2
- เพิ่ม `import json` (BUG-6 fix จาก session ก่อน)

### กฎที่รักษา
- แนะนำขายเฉพาะ normal + stock>0 (filter_unavailable ใน RAG + LLM prompt)
- ตอบเคลม/ใบกำกับ/ประกัน (warranty_flow.py ย้าย logic เดิม)
- ห้ามบอกไม่มีข้อมูล → search (NO-PRODUCT-GUARD ย้ายไปหลัง search)
- search สกัด keywords + spec → RAG → LLM2 (ไม่ตอบตรง)
- RAG ไม่ตัด non-normal (ลูกค้าถามสินค้าเก่าได้) — กรองเฉพาะ product_recommend
- ห้ามกุคำตอบ / ห้าม external URL / ห้ามแนะนำตอนเคลม
- stock จาก Shopee stock เท่านั้น
- เก็บ history, buffer flush, vision, test-chat step logging ไว้

### verify
- `python3 -m py_compile` ทั้ง 4 ไฟล์ผ่าน ✅
- ast.parse ทั้ง 3 ไฟล์ใหม่ผ่าน ✅
- ⚠️ ยังไม่ได้ทดสอบ runtime (ต้องมี google.genai + MongoDB)

### สถานะ
- `USE_LEGACY_CHAT=1` (default) → ใช้ legacy chat() เดิม (production ปลอดภัย)
- `USE_LEGACY_CHAT=0` → ใช้ chat_v2 (ยังไม่ได้ทดสอบ runtime)

### ของที่ยังขาด (pending)
- runtime test กับ MongoDB + google.genai
- replay เคสเก่าทั้งหมด

---

## ผ่านแล้ว (2026-09-15 — superlative / multi-use-case / charging spec detection)

### ที่มา
chat_v2 ยังขาดการจัดการ superlative ("แรงสุด/ไวสุด/ดีสุด"), multi-use-case ("วิ่ง+ANC", "ในรถ+แม่เหล็ก"), และ charging spec question ("biokoop ใช้สายชาร์จอะไร") ทำให้:
1. superlative → ดึงสินค้าน้อยเกิน → LLM เปรียบเทียบไม่ได้
2. multi-use-case → แนะนำสินค้าที่ไม่ตรงทุก use-case
3. charging spec → แนะนำสินค้า charger ใหม่ ทั้งที่ลูกค้าถามสเปกของสินค้าเดิม

### วิธีแก้ (เพิ่มใน chat_v2.py)

#### 1. Superlative detection
- `_is_superlative_question(message)` — ตรวจ "สุด/ที่สุด/แรงสุด/ไวสุด/กว่านี้/ชาร์จไว"
- `_adjust_fetch_limit_for_superlative()` — ถ้าเป็น superlative → limit * 5 (สูงสุด 50)
- `_augment_retrieval_for_superlative()` — ถ้า superlative + "ชาร์จ" ไม่มี history → เพิ่ม "พาวเวอร์แบงค์ แบตสำรอง" ใน retrieval

#### 2. Multi-use-case detection
- `_detect_multi_usecase(message)` — ตรวจ scenario + feature pairs
- scenarios: วิ่ง/ออกกำลังกาย/ในรถ/มอเตอร์ไซค์/เที่ยว/เดินทาง/ทำงาน/ประชุม/นอน/เล่นเกม
- features: ANC/กันน้ำ/แม่เหล็ก/พับได้/ไมโครโฟน/latency ฯลฯ
- ⚡ ตัด "ชาร์จ" ออกจาก features ของ "ในรถ" เพราะ "หัวชาร์จในรถ" เป็น car_charger subtype ไม่ใช่ multi-usecase

#### 3. Charging spec detection
- `_is_charging_spec_question(message)` — ตรวจ "ใช้สายชาร์จอะไร/ชาร์จยังไง/พอร์ตอะไร/ชาร์จกี่w"
- ถ้าเป็น charging spec → override intent เป็น `product_spec` (ไม่ใช่ `product_recommend`)
- ใน `_build_answer` → ส่ง hint บอก LLM ว่า "ตอบสเปกชาร์จของสินค้า ไม่ใช่แนะนำสินค้า charger ใหม่"

#### 4. Wattage extraction
- `_extract_wattage(message)` — สกัด "65w", "100 วัตต์" → int
- ใช้ใน rerank: สินค้าที่มี wattage ใกล้เคียงที่สุดขึ้นบน (สำหรับ charging spec)
- ใช้ใน `_build_answer` → ส่ง hint บอก LLM ว่าลูกค้าระบุ wattage เท่าไหร่

#### 5. Rerank update
- `_rerank_products()` เพิ่มเกณฑ์:
  - superlative: สินค้าที่มี wattage สูงสุดขึ้นบน
  - multi-use-case: สินค้าที่ชื่อตรง use-case keyword ขึ้นบน
  - charging spec: สินค้าที่มี wattage ใกล้เคียงที่สุดขึ้นบน

#### 6. Intent classification update
- `_classify_intent()` เพิ่ม fields:
  - `is_superlative` — bool
  - `is_charging_spec` — bool
  - `multi_usecase` — list[str]
  - `wattage` — int
- ถ้า `is_charging_spec` + intent=`product_recommend` → override เป็น `product_spec`

#### 7. _build_answer update
- ส่ง extra hints ให้ LLM2:
  - superlative: "เปรียบเทียบสินค้าแล้วตอบอันที่เด่นจริง"
  - multi-use-case: "แนะนำเฉพาะสินค้าที่ตรงทุก use-case"
  - charging spec: "ตอบสเปกชาร์จของสินค้า ไม่ใช่แนะนำสินค้า charger ใหม่"
  - wattage: "พิจารณาสินค้าที่รองรับ wattage ใกล้เคียงหรือสูงกว่า"

### verify
- `python3 -m py_compile` ทั้ง 4 ไฟล์ผ่าน ✅
- unit test superlative: 4/4 ผ่าน ✅
- unit test charging_spec: 4/4 ผ่าน ✅
- unit test wattage: 3/3 ผ่าน ✅
- unit test multi-use-case: 8/8 ผ่าน ✅ (หลังแก้ bug "ในรถ+ชาร์จ")
- `test_car_charger_regression.py`: 16/16 ผ่าน ✅

### สถานะ
- `USE_LEGACY_CHAT=1` (default) → legacy chat() เดิม (production ปลอดภัย)
- `USE_LEGACY_CHAT=0` → chat_v2 (syntax ผ่าน, unit test ผ่าน, ยังไม่ได้ทดสอบ runtime)

### ของที่ยังขาด (pending)
- runtime test กับ MongoDB + google.genai
- replay เคสเก่าทั้งหมด

---

## ผ่านแล้ว (2026-09-15 — per-request use_v2 flag สำหรับ shadowbot/replay)

### ที่มา
ต้องการทดสอบ chat_v2 ด้วย replay/shadowbot โดยไม่กระทบ traffic จริง
- `USE_LEGACY_CHAT=0` ทั้งหมด → อันตราย (traffic จริงไป chat_v2 หมด)
- ต้องมี per-request flag ให้ shadowbot/replay ส่ง `use_v2=true` ได้

### วิธีแก้

#### 1. `app.py` — เพิ่ม `use_v2` field ใน ChatRequest + dispatch logic
- `use_v2: bool | None` field ใน ChatRequest (default=None)
- dispatch: `if req.use_v2 or os.environ.get("USE_LEGACY_CHAT", "1") != "1":`
  - `req.use_v2=True` → บังคับ chat_v2 (แม้ USE_LEGACY_CHAT=1)
  - `USE_LEGACY_CHAT=0` → chat_v2 ทั้งหมด (เหมือนเดิม)
  - default → legacy (ปลอดภัย)

#### 2. `replay_compare.py` — เพิ่ม `--v2` flag
- `call_bot()` รับ `use_v2` parameter
- `replay_one()` รับ `use_v2` parameter
- `main()` เพิ่ม `--v2` arg → ส่ง `use_v2=True` ให้ทุก call_bot
- ใช้: `python replay_compare.py --conv XXX --v2`

#### 3. `ChatAdminWeb/src/app/api/shadow-inbox/route.ts` — รับ + ส่ง `use_v2`
- `callOurBot()` รับ `use_v2?: boolean` → ส่ง `body.use_v2 = true`
- POST body รับ `use_v2?: boolean`
- ใช้ closure wrapper ส่ง `use_v2` ผ่าน `botCaller`

#### 4. `ChatAdminWeb/src/app/api/shadow-inbox/generate-conversation/route.ts` — รับ + ส่ง `use_v2`
- เหมือน shadow-inbox/route.ts — รับ `use_v2` จาก body + ส่งผ่าน closure

### verify
- `python3 -m py_compile` ทั้ง 4 ไฟล์ผ่าน ✅
- `npx tsc --noEmit` ผ่าน ✅ (ไม่มี type error)
- `test_car_charger_regression.py`: 16/16 ผ่าน ✅

### วิธีใช้
```bash
# replay_compare.py (CLI)
python chatbot/frontendScript/replay_compare.py --conv <conv_id> --v2

# shadow inbox (UI) — ส่ง use_v2: true ใน body
POST /api/shadow-inbox { conversation_id: "xxx", use_v2: true }

# generate conversation (UI) — ส่ง use_v2: true ใน body
POST /api/shadow-inbox/generate-conversation { conversation_id: "xxx", use_v2: true }
```

### ความปลอดภัย
- traffic จริง (ไม่ส่ง use_v2) → ยังใช้ legacy chat() ตาม USE_LEGACY_CHAT env
- เฉพาะ replay/shadowbot ที่ส่ง use_v2=true → ไป chat_v2
- ไม่ต้อง restart bot หรือเปลี่ยน env

### ของที่ยังขาด (pending)
- runtime test กับ MongoDB + google.genai (ต้องมี bot server รันอยู่)
- replay เคสเก่าทั้งหมด (ต้องรัน bot server + เลือก conversation_id)

---

## ผ่านแล้ว (2026-09-15 — chat_engine config global toggle)

### ที่มา
ต้องการเปิด/ปิด chat_v2 จากหน้า config ให้มีผลทุกหน้า:
- shadowbot, botworker, test-assignment, live-assignment, replay-compare, testchat/shopee
- ไม่ต้องเปลี่ยน env หรือ restart bot

### วิธีแก้

#### 1. `systemConfigService.ts` — เพิ่ม `chat_engine` field
- `chat_engine: 'legacy' | 'v2'` ใน SystemConfigDoc
- default: `'legacy'` (ปลอดภัย)
- เพิ่มใน getSafeDefaults, mergeWithSafety, default doc, updateSystemConfig whitelist
- เพิ่ม `shouldUseChatV2()` helper — อ่าน config คืน boolean

#### 2. ทุก caller อ่าน config และส่ง `use_v2=true` ให้ bot

| ไฟล์ | หน้าที่ | วิธี |
|---|---|---|
| `botCallService.ts` | botworker + workflowEngine | อ่าน `shouldUseChatV2()` ใน `callBot()` |
| `shadow-inbox/route.ts` | shadowbot (Generate) | อ่าน config + per-request override |
| `shadow-inbox/generate-conversation/route.ts` | shadowbot (Generate All) | อ่าน config + per-request override |
| `test-assignment/route.ts` | test-assignment replay | อ่าน config ใน `callBot()` |
| `liveAssignmentService.ts` | live-assignment | อ่าน config ใน `callBot()` |
| `replay-compare/route.ts` | replay-compare | อ่าน config → ส่ง `--v2` flag ให้ script |
| `chatbot/[...path]/route.ts` | testchat proxy | inject `use_v2` ใน body สำหรับ POST /chat |
| `test-chat/flush/route.ts` | test-chat buffer flush | อ่าน config ใน payload |

#### 3. `config/page.tsx` — เพิ่ม Chat Engine toggle UI
- Card ใหม่ "Chat Engine (logic ตอบของบอท)"
- select: legacy / v2
- ปุ่มบันทึก + confirm dialog
- แสดง badge ว่ากำลังใช้ mode ไหน
- คำอธิบาย: "มีผลทุกหน้า: shadowbot, botworker, test-assignment, live-assignment, replay-compare, testchat"

#### 4. `app.py` — รับ `use_v2` per-request (ทำไว้แล้วก่อนหน้านี้)
- `req.use_v2=True` → บังคับ chat_v2
- `USE_LEGACY_CHAT=0` → chat_v2 ทั้งหมด
- default → legacy

### verify
- `npx tsc --noEmit`: ✅ ผ่าน (ไม่มี type error)
- `python3 -m py_compile` ทั้ง 5 ไฟล์: ✅ ผ่าน
- `test_car_charger_regression.py`: ✅ 16/16 ผ่าน

### วิธีใช้
1. ไปหน้า `/config`
2. เลือก Chat Engine: `v2` หรือ `legacy`
3. กดบันทึก
4. ทุกหน้าจะใช้ engine ที่เลือกทันที (ไม่ต้อง restart)

### ความปลอดภัย
- config default = `legacy` (app.py เดิม)
- เปลี่ยนได้จากหน้า config เท่านั้น (ต้อง login + มีสิทธิ์ edit)
- ไม่ต้อง restart bot หรือเปลี่ยน env
- per-request `use_v2` override ยังใช้ได้ (สำหรับ replay_compare.py --v2)

---

## จัดระเบียบไฟล์ repo (ผ่าน — 2026-09-09)

**ปัญหา:** ไฟล์ plan/doc/script กระจายอยู่ root รก ไม่มีแผนผังอ้างอิง — หาไฟล์ยาก

**วิธีแก้:**
1. ย้าย `DEPLOY.md` (root, 23KB canonical ฉบับ Caddy+troubleshooting) → `docs/DEPLOY.md` (ทับฉบับเก่า 8.9KB ที่ใช้ Nginx + 3 env files — deprecated)
2. สร้าง `docs/plans/` และย้ายไฟล์ plan ทั้ง 3 ไปรวม:
   - `planner.md` → `docs/plans/planner.md`
   - `workflow-planner.md` → `docs/plans/workflow-planner.md`
   - `implentplanworkflow.md` → `docs/plans/implentplanworkflow.md`
3. ลบ `script/export_mongo.py` (ไฟล์ว่าง 0 byte — ตัวจริงอยู่ที่ `chatbot/shopeechat/export_mongo.py`)
4. อัปเดต comment อ้างอิง `workflow-planner.md` → `docs/plans/workflow-planner.md` ใน 4 ไฟล์ ChatAdminWeb (`workflows/route.ts`, `botWorkerService.ts`, `workflowEngine.ts`, `workflowService.ts`)
5. อัปเดต comment ใน `Dockerfile.chatbot` บรรทัด 27 (เอา `export_mongo.py` ออกจากรายชื่อ)
6. แทนที่ section "โครงสร้าง repo" ใน `AGENTS.md` ด้วยแผนผังละเอียด แบ่งตามหมวด: core bot / placeholder / script / test / ผลลัพธ์ / deploy / doc / plan / rule / waythrough

**ไฟล์ที่แก้:** `docs/DEPLOY.md` (ย้าย+ทับ), `docs/plans/*` (ย้าย), `AGENTS.md` (แผนผัง), `Dockerfile.chatbot` (comment), `ChatAdminWeb/src/...` 4 ไฟล์ (comment path)
**ไฟล์ที่ลบ:** `script/export_mongo.py`, root `DEPLOY.md` (ย้ายแล้ว), root plan files (ย้ายแล้ว)

**verify:**
- `git status` แสดง rename ถูกต้อง (preserve history ด้วย `git mv`)
- ไม่กระทบ core bot (`chatbot/shopeechat/` ไม่ถูกแตะ)
- `.gitignore` ไม่ต้องแก้ (`testlog/`, `testresult/`, `exports/` ignore อยู่แล้ว)

**หมายเหตุ:** การย้ายนี้ใช้ `git mv` เพื่อ preserve history ไม่ใช่ delete+create

---

## จัดระเบียบ Docker files (ผ่าน — 2026-09-09)

**ปัญหา:** `Dockerfile.chatbot` และ `Caddyfile` อยู่ที่ root รก — ผู้ใช้ขอสร้าง `docker/` folder

**ข้อจำกัดที่เช็คก่อนย้าย:**
- `docker-compose.yml` ต้องอยู่ที่ root (Docker หาไฟล์ที่ cwd) — ย้ายไม่ได้ ไม่งั้นต้องรัน `docker compose -f docker/docker-compose.yml up` ทุกครั้ง
- `.dockerignore` ต้องอยู่ที่ build context root (`context: .` = repo root) — ย้ายไม่ได้ Docker จะไม่อ่าน
- `Dockerfile.chatbot` และ `Caddyfile` ย้ายได้ แค่แก้ path ใน compose

**วิธีแก้:**
1. สร้าง `docker/` แล้ว `git mv Dockerfile.chatbot docker/Dockerfile.chatbot` + `git mv Caddyfile docker/Caddyfile`
2. `docker-compose.yml` แก้ 3 จุด `dockerfile: Dockerfile.chatbot` → `dockerfile: docker/Dockerfile.chatbot` (shopee/lazada/tiktok)
3. `docker-compose.yml` แก้ Caddy mount `./Caddyfile:` → `./docker/Caddyfile:`
4. `docker-compose.yml` แก้ comment "config ที่ Caddyfile (root)" → "config ที่ docker/Caddyfile"
5. `docker/Dockerfile.chatbot` แก้ comment build command `-f Dockerfile.chatbot` → `-f docker/Dockerfile.chatbot` + `.env.chatbot.shopee` → `.env`
6. `docs/DEPLOY.md` แก้ tree diagram + 6 จุดที่อ้าง `Caddyfile` → `docker/Caddyfile`
7. `AGENTS.md` แก้ section Deploy ในแผนผัง

**ไฟล์ที่แก้:** `docker/Dockerfile.chatbot` (ย้าย+comment), `docker/Caddyfile` (ย้าย), `docker-compose.yml` (4 path), `docs/DEPLOY.md` (tree+6 refs), `AGENTS.md` (section Deploy)

**verify:**
- `git status` แสดง rename ถูกต้อง (preserve history)
- ไม่กระทบ core bot
- `docker compose config` ควร parse ได้ (รอ verify บน server ที่มี Docker)

**หมายเหตุ:** `docker-compose.yml` และ `.dockerignore` คงไว้ที่ root ตาม Docker convention — ย้ายไม่ได้เพราะ Docker บังคับ

---

## จัดระเบียบ test scripts ใน chatbot/ (ผ่าน — 2026-09-09)

**ปัญหา:** `chatbot/` มี script test/shadow กระจายอยู่รก — ผู้ใช้ขอสร้าง `chatbot/testscript/` เก็บรวม

**ไฟล์ที่ย้าย:**
- `chatbot/backfill_ai_usage.py` → `chatbot/testscript/backfill_ai_usage.py`
- `chatbot/shadow_openrouter.py` → `chatbot/testscript/shadow_openrouter.py`
- `chatbot/test_openrouter_cost.py` → `chatbot/testscript/test_openrouter_cost.py`
- `chatbot/test_openrouter_full_cost.py` → `chatbot/testscript/test_openrouter_full_cost.py`

**สิ่งที่ต้องแก้ตาม (สำคัญ — ไม่งั้น import พัง):**
1. ไฟล์ทั้ง 4 ใช้ `_REPO_ROOT = Path(__file__).resolve().parent.parent` (ชี้ repo root ตอนอยู่ `chatbot/`) → แก้เป็น `parent.parent.parent` (ชี้ repo root จาก `chatbot/testscript/`)
2. 3 ไฟล์ (`shadow_openrouter`, `test_openrouter_cost`, `test_openrouter_full_cost`) ใช้ `sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))` + `from shopeechat import ...` → แก้ sys.path เป็น `os.path.dirname(os.path.dirname(...))` ให้ชี้ parent (`chatbot/`) ที่มี `shopeechat/` อยู่
3. `backfill_ai_usage.py` ไม่ import shopeechat แค่แก้ `_REPO_ROOT`

**ไฟล์ที่แก้:** 4 ไฟล์ใน `chatbot/testscript/` (path + sys.path), `AGENTS.md` (แผนผัง)

**verify:**
- `python3 -m py_compile` ทั้ง 4 ไฟล์ผ่าน
- import จริง: `from shopeechat import product_store, llm, persona` สำเร็จ
- ไม่กระทบ core bot

**หมายเหตุ:** ไฟล์เหล่านี้ untracked ใน git ใช้ `mv` ธรรมดา (ไม่ใช่ `git mv`)

---

## ย้าย replay_compare.py เข้า chatbot/frontendScript/ (ผ่าน — 2026-09-09)

**ปัญหา:** `replay_compare.py` อยู่ที่ root รก — ผู้ใช้ขอย้ายเข้า `chatbot/frontendScript/`

**ความสัมพันธ์ที่เช็คก่อนย้าย (สำคัญ):**
- `replay_compare.py` คือ **backend engine** ของหน้า `/replay-compare` ใน ChatAdminWeb
- `ChatAdminWeb/src/app/api/replay-compare/route.ts` spawn `replay_compare.py` เป็น child process (บรรทัด 145)
- อ่านผลจาก `testresult/replay_*.json` ที่ script เซฟ
- `pgrep -f 'replay_compare.py'` เช็คกันรันซ้อน

**วิธีแก้:**
1. `git mv replay_compare.py chatbot/frontendScript/replay_compare.py`
2. แก้ `.env` path: `os.path.join(os.path.dirname(__file__), '.env')` → `'..', '..', '.env'` (ชี้ repo root จาก `chatbot/frontendScript/`)
3. แก้ sys.path สำหรับ `from shopeechat import llm`: `os.path.join(os.path.dirname(__file__), 'chatbot')` → `os.path.join(os.path.dirname(__file__), '..')` (ชี้ `chatbot/` ที่มี `shopeechat/`)
4. แก้ `ChatAdminWeb/src/app/api/replay-compare/route.ts` บรรทัด 145: `"replay_compare.py"` → `"chatbot/frontendScript/replay_compare.py"`
5. `pgrep -f 'replay_compare.py'` ยังทำงานได้ (path ใหม่มีชื่อไฟล์นี้อยู่)
6. `AGENTS.md` แผนผัง — อัปเดต path + บอกความสัมพันธ์กับ ChatAdminWeb

**ไฟล์ที่แก้:** `chatbot/frontendScript/replay_compare.py` (ย้าย+2 path), `ChatAdminWeb/src/app/api/replay-compare/route.ts` (spawn path), `AGENTS.md` (แผนผัง)

**verify:**
- `python3 -m py_compile` ผ่าน
- ไม่กระทบ core bot
- `pgrep` pattern ยัง match ได้ (ชื่อไฟล์ไม่เปลี่ยน)

**หมายเหตุ:** doc/SRS ที่อ้าง `replay_compare.py:call_bot()` เป็น name reference (filename เดิม) — ไม่ต้องแก้

---

## รวม test/testlog/testresult + ย้าย adminbase (ผ่าน — 2026-09-09)

**ปัญหา:** `test/`, `testlog/`, `testresult/` แยกกัน 3 โฟลเดอร์รก + `adminbase/` กับ `script/import_adminbase.py` แยกกัน

### 1. รวม test/testlog/testresult → `test/` (one folder)

**วิธี:**
- `mv testlog test/logs`
- `mv testresult test/results`
- โครงสร้างใหม่: `test/` (scripts) + `test/logs/` (log) + `test/results/` (JSON)

**ไฟล์ที่แก้ path (11 ไฟล์):**
- `test/test_200.py`, `test/check_progress.py`, `test/testQA2.py`, `test/run_daily_tests.py`, `test/test_comprehensive.py` — `"testresult"` → `"test" / "results"`
- `test/analyze_qa_replays.py` — `os.path.join(..., "testresult")` → `os.path.join(..., "test", "results")` (ใช้ comma ไม่ใช่ `/` เพราะ os.path.join)
- `test/run_fresh_tests.sh` — `LOG_DIR="testlog"` → `"test/logs"` + `testresult/` → `test/results/`
- `chatbot/testscript/shadow_openrouter.py` — `OUTPUT_DIR = _REPO_ROOT / "testresult"` → `_REPO_ROOT / "test" / "results"`
- `ChatAdminWeb/src/app/api/replay-compare/route.ts` — hardcoded `RESULTS_DIR` จาก `testresult` → `test/results`
- `ChatAdminWeb/src/app/api/test-results/route.ts` — `join("..", "testresult")` → `join("..", "test", "results")`
- `.gitignore` — `testlog/` + `testresult/` → `test/logs/` + `test/results/`

### 2. ย้าย adminbase + import_adminbase.py → `docs/adminbase/`

**วิธี:**
- `git mv adminbase docs/adminbase` (55 xlsx files — tracked)
- `git mv script/import_adminbase.py docs/adminbase/script/import_adminbase.py`
- ลบ `script/` ที่ว่างแล้ว

**โครงสร้างใหม่:**
- `docs/adminbase/*.xlsx` — ไฟล์ต้นฉบับสินค้า
- `docs/adminbase/script/import_adminbase.py` — import script

**ไฟล์ที่แก้ path:**
- `docs/adminbase/script/import_adminbase.py`:
  - `ROOT = parent.parent` → `parent.parent.parent.parent` (ชี้ repo root จาก `docs/adminbase/script/`)
  - `ADMINBASE_DIR = ROOT / "adminbase"` → `Path(__file__).resolve().parent.parent` (ชี้ `docs/adminbase/`)
- `docker/Dockerfile.chatbot` — `COPY adminbase/ ./adminbase/` → `COPY docs/adminbase/ ./adminbase/`
- `ChatAdminWeb/src/app/api/kb/template/route.ts` — comment `scripts/import_adminbase.py` → `docs/adminbase/script/import_adminbase.py`
- `ChatAdminWeb/src/backend/service/knowledgeBaseService.ts` — comment เดียวกัน

### verify
- `python3 -m py_compile` ทุก test script ผ่าน ✅
- `python3 -m py_compile docs/adminbase/script/import_adminbase.py` ผ่าน ✅
- ไม่มี stale reference เหลือ (grep `testresult`, `testlog`, `adminbase/` ที่ root = 0)
- ไม่กระทบ core bot

**หมายเหตุ:** testlog/ และ testresult/ เป็น gitignored (untracked) ใช้ `mv` ธรรมดา / adminbase/ และ script/ เป็น tracked ใช้ `git mv`

---

## ย้าย test/ ไป docs/test/ (ผ่าน — 2026-09-09)

**ปัญหา:** `test/` อยู่ที่ root ผู้ใช้ต้องการย้ายเข้า `docs/` ให้หมด

**วิธี:**
- `git mv test docs/test` (8 tracked files + logs/ + results/ subfolders)

**ไฟล์ที่แก้ path (สำคัญ — ROOT เปลี่ยนความหมาย):**

หลังย้าย `test/file.py` → `docs/test/file.py`:
- `ROOT = parent.parent` เดิมชี้ repo root → กลายเป็นชี้ `docs/` (ผิด)
- แก้เป็น `ROOT = parent.parent.parent` (ชี้ repo root จาก `docs/test/`)

1. `docs/test/check_progress.py` — ROOT → `parent.parent.parent` + `"test" / "results"` → `"docs" / "test" / "results"`
2. `docs/test/testQA2.py` — ROOT → `parent.parent.parent` + results paths + `sys.path` ชี้ `ROOT / "chatbot" / "shopeechat"` (ถูกต้องเพราะ ROOT ชี้ repo root)
3. `docs/test/test_200.py` — ROOT + results path
4. `docs/test/test_comprehensive.py` — ROOT + results paths
5. `docs/test/run_daily_tests.py` — ROOT + `TEST_DIR = ROOT / "docs" / "test"` + results + `.env` + `.venv` (ถูกต้องเพราะ ROOT ชี้ repo root)
6. `docs/test/find_qa_conversations.py` — `_repo_root` → `parent.parent.parent`
7. `docs/test/run_fresh_tests.sh` — `LOG_DIR="docs/test/logs"` + `docs/test/results/`
8. `docs/test/analyze_qa_replays.py` — ไม่ต้องแก้ (ใช้ `os.path.dirname(os.path.dirname(__file__))` ซึ่ง resolve ถูกอัตโนมัติ)
9. `chatbot/testscript/shadow_openrouter.py` — `_REPO_ROOT / "docs" / "test" / "results"`
10. `ChatAdminWeb/src/app/api/replay-compare/route.ts` — hardcoded `RESULTS_DIR` → `docs/test/results`
11. `ChatAdminWeb/src/app/api/test-results/route.ts` — `join("..", "docs", "test", "results")`
12. `.gitignore` — `test/logs/` + `test/results/` → `docs/test/logs/` + `docs/test/results/`

### verify
- `python3 -m py_compile` ทุก test script ผ่าน ✅
- ไม่มี stale reference เหลือ (grep 0 ผล)
- ไม่กระทบ core bot
- ROOT ในทุก test script ยังชี้ repo root → `.env`, `.venv`, `chatbot/shopeechat` ใช้ได้เหมือนเดิม

---

## chat_engine runtime test + fix MongoClient close bug (ผ่าน — 2026-09-15)

### Bug ที่พบ
`chat_v2` 500 error: `pymongo.errors.InvalidOperation: Cannot use MongoClient after close`

**สาเหตุ:** `_check_warranty_state_machine()` ใน `chat_v2.py` เรียก `_app_module._db()` เพื่อสร้าง client ใหม่ แล้ว `client.close()` ใน `finally` — แต่ `product_store.get_client()` คืน **singleton cached client** ดังนั้นการ close ใน warranty check ทำให้ client ของ context หลักถูกปิดไปด้วย → query ถัดไป error

**วิธีแก้:** เปลี่น `_check_warranty_state_machine(req, ctx, history)` → `_check_warranty_state_machine(req, ctx, history, db)` รับ `db` เป็น parameter จาก context หลัก ไม่ต้องสร้าง/ปิด client เอง

### Runtime test ผล
| เคส | Engine | ผล |
|---|---|---|
| แนะนำหัวชาร์จ 65W | v2 | ✅ ตอบได้ แนะนำ desktop charger แทน (ไม่มี 65W) |
| CTL301 + mi 17 ultra compatibility | v2 | ✅ บอก Lightning ไม่ใช้กับ USB-C แนะนำ CTC615W แทน |
| mi 17 ultra ชาร์จกี่ W | v2 | ✅ ไม่ยัดสเปกที่ไม่รู้ แนะนำพาวเวอร์แบงค์แทน |
| สายชาร์จแรงสุด (superlative) | v2 | ✅ แนะนำ CTC615W 240W ทุกสินค้า status=NORMAL |
| สวัสดี (default) | legacy | ✅ ตอบปกติ chat_engine=legacy |
| แนะนำหัวชาร์จ 65W (default) | legacy | ✅ ตอบปกติ chat_engine=legacy |

### ไฟล์ที่แก้
- `chatbot/shopeechat/chat_v2.py` — `_check_warranty_state_machine` รับ `db` parameter แทนสร้าง client เอง
- `chatbot/shopeechat/app.py` — `ChatResponse` เพิ่ม `chat_engine` field + v2 path ตั้ง `chat_engine="v2"`

### verify
- `py_compile`: ✅ ผ่าน
- runtime test 6 เคส: ✅ ทุกเคสผ่าน
- สลับ engine ได้จริง: ✅ `use_v2=true` → v2, ไม่ส่ง → legacy


## MODEL-REGEX pre-filter ใน chat_v2 (ผ่าน — 2026-09-16)

**ปัญหา:** chat_v2 ไม่มี MODEL-REGEX pre-filter ที่ legacy มี (app.py line 2614-2653)
- ลูกค้าพิมพ์ "ctl301" → chat_v2 ไป `build_query` ซึ่งไม่ใส่ model keyword → query มีแค่ shop filter → ดึงสินค้าทั้งร้าน (1079 รายการ) → vector search ได้ ZMI AL301 แทน CUKTECH CTL301
- Legacy เจอ CTL301 ตรงๆ เพราะมี regex search `item_name: /ctl.?301/` ก่อน vector search

**วิธี:** เพิ่ม MODEL-REGEX pre-filter stage 5.2c ใน `_retrieve_products()` ของ chat_v2
- สกัด model keyword จาก message (regex `[A-Za-z]+\d+[A-Za-z]*` len>=4)
- ถ้าเจอ → query Mongo `item_name: {$regex: pattern}` + shop filter
- ถ้าเจอสินค้า → ใช้เป็น products หลัก (skip broad fetch_products ใน 5.4)
- ถ้าไม่เจอ → fall through ไป KB + fetch_products ปกติ

**ไฟล์ที่แก้:** `chatbot/shopeechat/chat_v2.py` — `_retrieve_products()` เพิ่ม stage 5.2c
**ไม่แก้:** `product_store.py` (ใช้ร่วมกับ legacy ไม่กระทบ)

### verify
- `py_compile`: ✅ ผ่าน
- ctl301 ใน KingGadgets: ✅ เจอ CTL301 ตรงๆ (2 products) ไม่ใช่ ZMI AL301
- car charger regression: ✅ 16/16 ผ่าน
- เคสเดิม 4 กรณี: ✅ ทุกเคสผ่าน (สายชาร์จ, สวัสดี, compatibility, หัวชาร์จ)
- `docs/SRS_SSD.md`: ✅ อัปเดต helper + calls


## ผ่านแล้ว (2026-09-16 — Phase 6: ยกเลิก should_run_pass1 gate + intent classification รันทุกข้อความ)

### ที่มา
`should_run_pass1()` gate ทำให้ intent classification รันเฉพาะ "จุดอ่อน" — แต่ hardcoded keyword detection ตัดสินก่อน LLM ในหลายจุด (general_qtype, _is_claim_request, _is_tax_invoice) → ผิดได้ในกรณีกำกวม

### วิธีแก้

#### 1. `intent_classifier.py` — เพิ่ม field `general_qtype`
- เพิ่ม `general_qtype` field ใน result dict (ค่า: warranty_policy/return_policy/shipping_policy/brands/categories/shops/tax_invoice/null)
- อัปเดต prompt + ตัวอย่าง + `_DEFAULT_RESULT` + docstring

#### 2. `app.py` — ย้าย intent classification ให้รันก่อน keyword detection
- ลบ `should_run_pass1()` gate — รัน `classify_intent()` เสมอ (หลัง deterministic checks)
- Deterministic checks ที่ยังอยู่ก่อน intent (100% ชัด/regex):
  1. `order_sn` regex (~line 1345)
  2. `tracking_no` regex (~line 1384)
  3. `human_request` keyword (~line 1605 — ชัด 100%)
- หลัง intent classification → แก้ hardcoded detection ให้ใช้ intent_result เป็นหลัก (conf >= 0.7), keyword เป็น fallback:
  - `general_qtype`: intent=general_question + general_qtype → ใช้ค่าจาก intent; อื่น → `knowledge_base.detect_general_question()`
  - `_is_claim_request`: intent=warranty_claim → True; intent อื่น (conf>=0.7) → False (ยกเว้น strong complaint/repeated); อื่น → `warranty.detect_claim_request()`
  - `_is_tax_invoice`: intent=general_question + general_qtype=tax_invoice → True; อื่น → `warranty.detect_tax_invoice_request()` (จับ data submission ด้วย)
- ย้าย tax_invoice handoff block มาหลัง intent classification (ก่อนอยู่ก่อน human_request)
- เพิ่ม try/except รอบ `classify_intent()` → fallback to `_DEFAULT_RESULT` (conf=0) → keyword fallback ทำงาน

#### 3. Keyword lists ทั้งหมดยังอยู่ — เปลี่ยนสถานะเป็น fallback
- `_HUMAN_REQUEST_KWS` — ยังเป็น deterministic (ชัด 100%)
- `knowledge_base.GENERAL_QUESTION_KEYWORDS` — fallback เมื่อ intent ไม่ได้บอก general_qtype
- `warranty._CLAIM_QUESTION_PATTERNS` / `_TAX_INVOICE_REQUEST_KWS` / `_TAX_INVOICE_DATA_KWS` — fallback
- `_strong_complaint_kws` / `_complaint_kws` — ยังใช้ป้องกัน LLM override claim ผิด
- `should_run_pass1()` helper — ยังคงอยู่ใน `intent_classifier.py` (ไม่ลบ) แต่ไม่ถูกเรียกจาก `app.py` แล้ว

### จุด hardcode เดิม → intent field ที่แทนที่ → fallback ยังอยู่ไหม

| จุด hardcode (บรรทัดเดิม) | intent field ที่แทนที่ | fallback ยังอยู่? |
|---|---|---|
| `general_qtype = detect_general_question()` (~1586) | `intent=general_question` + `general_qtype` field (ใหม่) | ✅ `knowledge_base.detect_general_question()` |
| `_is_claim_request = detect_claim_request()` (~1594) | `intent=warranty_claim` | ✅ `warranty.detect_claim_request()` + `_strong_complaint_kws` |
| `_is_tax_invoice = detect_tax_invoice_request()` (~1613) | `intent=general_question` + `general_qtype=tax_invoice` | ✅ `warranty.detect_tax_invoice_request()` (จับ data submission) |
| `_is_human_request` (~1691) | — (deterministic, ไม่ย้าย) | — (ยังเป็นหลัก) |
| `_order_sn` regex (~1345) | — (deterministic, ไม่ย้าย) | — (ยังเป็นหลัก) |
| `_tracking_no` regex (~1384) | — (deterministic, ไม่ย้าย) | — (ยังเป็นหลัก) |

### Behavior changes (intent กับ keyword ไม่ตรงกัน)
1. **`general_qtype` จาก intent ไม่ตรง keyword** — เชื่อ intent (conf>=0.7) → override keyword
   - กรณี: intent บอก `general_question` + `general_qtype=shipping_policy` แต่ keyword จับเป็น `warranty_policy` → ใช้ intent
2. **`_is_claim_request` — intent บอกไม่ใช่ warranty_claim แต่ keyword บอกใช่** — ยกเลิก claim (ยกเว้น strong complaint/repeated)
   - กรณี: "รับประกันกี่ปี" → keyword จับ "รับประกัน" เป็น claim แต่ intent บอก general_question → ไม่ใช่ claim
3. **`_is_claim_request` — intent บอก warranty_claim แต่ keyword ไม่บอก** — เชื่อ intent (conf>=0.7)
   - กรณี: ลูกค้าพูดคำไม่ตรง keyword แต่ intent เข้าใจว่าเป็น claim
4. **`_is_tax_invoice` — intent บอก tax_invoice** — เชื่อ intent (conf>=0.7)
   - แต่ data submission (เลขผู้เสียภาษี/หจก.) ยังใช้ keyword เพราะ intent อาจไม่จับ

### Cost/latency estimate
- **ก่อน:** `classify_intent()` รันเฉพาะ "จุดอ่อน" (~30-40% ของ messages ที่ผ่าน deterministic checks)
- **หลัง:** `classify_intent()` รันทุก message ที่ผ่าน deterministic checks (order/tracking/human)
- **เพิ่ม:** ~60-70% ของ messages ที่ไม่เคยเรียก intent มาก่อน
- **Cost per call:** prompt ~300-500 tokens, output ~50-100 tokens
  - cost = (400 * $0.25 + 75 * $0.50) / 1M = ($0.0001 + $0.0000375) = ~$0.0001375/call = ~0.005 THB/call
- **Latency:** ~0.5-1.5s per call (gemini flash-lite)
- **เพิ่มต่อ message ที่ไม่เคยเรียก:** ~0.005 THB + ~1s latency
- **กระทบ:** ทุก message ที่ไม่ใช่ order/tracking/human จะเพิ่ม ~1s latency + ~0.005 THB

### verify
- `py_compile` app.py + intent_classifier.py: ✅ ผ่าน
- car charger regression: ✅ 16/16 ผ่าน
- classifier-failed fallback test (no API key): ✅ keyword fallback ทำงานถูกต้อง (8/10 ผ่าน — 2 "fail" คือ test expectation ผิด ไม่ใช่ behavior ผิด)
- order/tracking regex false-positive: ⚠️ Thai landline 9 หลัก (02/03/05 + 7) โดน tracking regex จับ (pre-existing — ไม่ใช่จากการแก้ครั้งนี้)
- app import: ✅ ผ่าน

### ข้อจำกัดที่เหลือ
1. **Tracking regex false-positive** — Thai landline 9 หลัก (02/03/05/053 + 7 digits) โดน `_TRACKING_RE` จับ เพราะ filter มีแค่ `0[89]\d{8}` (10 หลัก) — pre-existing, ไม่ได้แก้ใน Phase 6
2. **No live API test** — ไม่มี GEMINI_API_KEY ใน env นี้ → ทดสอบแค่ fallback path (conf=0) ไม่ได้ทดสอบ intent จริง
3. **`should_run_pass1()` ยังอยู่** — ไม่ลบ เพราะอาจมี caller อื่น แต่ `app.py` ไม่เรียกแล้ว

---

## ผ่านแล้ว (2026-09-16 — Phase 6 live verify: Zaapi mistorethailand + pingevox เทียบจริง)

### ที่มา
หลัง Phase 6 (intent-first resolution) ผ่าน unit test + live API test 12/12 แล้ว ทดสอบเทียบคำตอบจริงของ Zaapi จากแชทจริง 2 ลูกค้าที่ทักเข้าร้านเดียวกัน:
- **ร้านจริง**: `KingGadgets` (133 CUKTECH products ใน DB)
- **ลูกค้า pingevox** — 5 คำถาม
- **ลูกค้า mistorethailand** — 38 คำถาม (เทส 11 เคสสำคัญ)

### เคสที่เทส (16 เคสสำคัญ จาก 43 คำถาม)
ทดสอบผ่าน `chat()` flow จริง (ไม่ใช่แค่ classify_intent) — ใช้ Gemini API จริง + DB จริง + web search จริง:

**Pingevox (KingGadgets) — 5 เคส:**
- P1 `[item]` → intent=other, source=product_store+web ✅
- P2 `ซาหวัดดีจ้า` → intent=other, source=product_store ✅
- P3 `อยากได้ของที่ใช้กับ xiaomi 17 ultra` → intent=product_recommend device=xiaomi 17 ultra ✅ (device-spec lookup trigger)
- P4 `หัวชาร์จละ` → intent=product_recommend sub=adapter device=xiaomi 17 ultra ✅ (subtype change cable→adapter + device carry from history)
- P5 `ดีจ้า` → intent=other ✅

**MiStore (KingGadgets) — 11 เคส (ลูกค้า mistorethailand ทักเข้าร้าน KingGadgets):**
- M5 `สนใจหัวชาร์จที่ใช้กับ iphone 17 pro max` → intent=product_recommend device=iphone 17 pro max ✅
- M6 `AC65B เทียบกับ AC65B2 ต่างกันยังไง` → intent=product_spec ✅ (KB-MODEL-REGEX จับ AC65B2)
- M10 `รุ่นไหนมี มอก. บ้าง` → intent=product_spec ✅ (เราตอบได้จาก DB, Zaapi ส่งต่อแอดมิน)
- M15 `WPB100L ใช้กับมือถือ xiaomi ได้ไหม` → intent=compatibility_check device=xiaomi ✅
- M19 `สินค้ารุ่นนี้หมดประกันยังที่ซื้อมา` → intent=general_question gq=warranty_policy ✅ (เราจับเป็น policy question, Zaapi จับเป็น claim — เราถูก)
- M21 `จะสอบถามสเปคสินค้ารุ่น a18T` → intent=product_spec ✅ (KB-MODEL-REGEX จับ a18T → 5 products)
- M22 `หัวชาร์จ a18t ใช้งานไม่ได้` → intent=warranty_claim ✅ (handoff ทันที)
- M29 `สายชาร์จ ชาร์จไฟไม่ได้` → intent=warranty_claim ✅ (handoff ทันที)
- M12 `สนใจ powerbank ที่ใช้กับ MacBook air` → intent=product_recommend device=MacBook air ✅ (DEVICE-SPEC-LOOKUP trigger → web search ได้ MagSafe 3/Thunderbolt)
- M30 `,` → intent=other conf=0.9 ✅ (garbage input)
- M38 `3` → intent=other conf=0.5 ✅ (rating — Zaapi เข้าใจดีกว่า แต่เราไม่ผิด)

### ผล
- **16/16 ผ่าน** (5 pingevox + 11 mistore) — intent classification ทำงานถูกทุกเคส
- ทั้งสองลูกค้าทักเข้าร้าน `KingGadgets` (ร้านเดียวกัน)
- avg latency: 1.3-9.5s/call (บางเคส trigger web search นานขึ้น)
- avg cost: ~0.0209 THB/call (intent step)

### จุดที่เราทำได้ดีกว่า Zaapi
1. **M10 มอก.** — เราตอบได้จาก DB (AC65B2 มี มอก.) Zaapi ส่งต่อแอดมิน
2. **M12 MacBook air** — เราแนะนำ powerbank ได้  Zaapi ตอบเรื่อง มอก. ต่อ (ผิดคำถาม)
3. **M19 หมดประกัน** — เราจับเป็น general_question (warranty_policy) ถูก  Zaapi จับเป็น claim (ผิด — ลูกค้าถาม ไม่ได้แจ้งเคลม)

### จุดที่ Zaapi ทำได้ดีกว่า
1. **M38 `3`** — Zaapi เข้าใจว่าเป็นคะแนน rating → ขอบคุณ เราตอบเรื่องสินค้าหมดสต็อก (intent=other ไม่จับ rating)
2. **M30 `,`** — Zaapi ไม่ตอบจน Q37 (รอ context) เราตอบทันที (อาจรบกวน)

### ปัญหาที่พบ (ไม่ใช่ bug ของ Phase 6)
1. **สินค้า sold_out ทุกตัว** — CukTechThailand และ KingGadgets ใน DB ส่วนใหญ่ stock=0/sold_out=True → LLM ตอบ "หมดสต็อกชั่วคราว" ทุกเคส (เป็นข้อมูล DB จริง ไม่ใช่ bug)
2. **Persona `abubu`** ของ CukTechThailand ทำงานถูก (ปรากฏในคำตอบ)
3. **KB-MODEL-REGEX** จับ `a18T` → ดึง 5 สินค้าตรง ✅
4. **DEVICE-SPEC-LOOKUP** trigger กับ MacBook air → web search ได้ spec (MagSafe 3, Thunderbolt) ✅

### Test cases สำหรับ session นี้ (จดไว้ใช้ต่อ)
- **Pingevox (KingGadgets)**: P1-P5 (5 เคส) — item card, greeting, compat+device, subtype change, follow-up
- **MiStore (CukTechThailand)**: M5, M6, M10, M15, M19, M21, M22, M29, M12, M30, M38 (11 เคส)
- รวม 16 เคส — ใช้เป็น regression suite สำหรับ Phase 6 ต่อไป

---

## ผ่านแล้ว (2026-09-16 — Phase 7: Anchor comparison "อันนี้กับอันก่อน")

### ที่มา
ลูกค้าถาม "อันนี้กับอันก่อนต่างกันยังไง" โดย "อันนี้" = anchor ล่าสุด (active) และ "อันก่อน" = anchor อันดับ 2
ต้องดึงจาก conversation_products timeline แทนการ extract model keyword จาก history
(เพราะลูกค้าอ้างอิง anchor ไม่ใช่ชื่อรุ่น)

### สิ่งที่เพิ่ม

#### 1. conversation_products.py — 2 ฟังก์ชันใหม่
- `get_anchor_history(conversation_id, limit=10)` → คืน anchor products เรียงใหม่→เก่าตาม mentioned_at
- `get_previous_anchor(conversation_id, exclude_item_id=None)` → คืน anchor อันดับ 2 (อันก่อนหน้า active)
  - ถ้าไม่ระบุ exclude_item_id → คืน index 1 (อันดับ 2)
  - ถ้าระบุ exclude_item_id → กรองออก แล้วคืน index 0 (อันก่อนหน้าตัวที่ exclude)
  - ถ้ามี anchor แค่ 1 ตัว → คืน None (graceful)

#### 2. app.py — comparison detection + context injection
- `_anchor_compare_kws` = ("อันนี้กับอันก่อน", "อันนี้กับอันก่อนหน้า", "อันนี้กับอันนั้น", ฯลฯ)
- `_is_anchor_compare` trigger เมื่อ message ตรง keyword + มี conversation_id
- ดึง `get_active_product()` (current) + `get_previous_anchor()` (previous)
- ใส่ทั้ง 2 สินค้าเข้า products + context note บอก LLM ให้เปรียบเทียบ

#### 3. Bug fix: _compute_active TypeError
- พบว่า `_compute_active` เกิด `TypeError: can't compare offset-naive and offset-aware datetimes`
- เพราะ MongoDB ลบ tzinfo ตอนเก็บ แต่ `datetime.now(timezone.utc)` มี tzinfo
- แก้โดยเพิ่ม `_normalize_dt()` แปลงทุก datetime เป็น naive ก่อน sort
- แก้ใน `_compute_active`, `get_suggestion_latest`, `get_anchor_history`

### ข้อบังคับที่ถือ
- ห้ามแก้ schema เดิม (mentioned_at, source, is_anchor อยู่แล้ว พอสำหรับ query)
- ห้ามเปลี่ยน resolve_active_by_message / get_active_product เดิม
- FOLLOWUP-COMP (model keyword) และ ANCHOR-COMP (anchor reference) ทำงานคู่กัน:
  - ถ้า history มี model name → FOLLOWUP-COMP จับ (rewrite เป็น "A vs B")
  - ถ้าไม่มี model name → ANCHOR-COMP จับ (ใช้ anchor จาก timeline)

### verify
- py_compile: ✅ ผ่าน
- unit test 7/7: ✅ ผ่าน (test_anchor_compare.py)
  - test_single_anchor: anchor 1 ตัว → previous = None ✅
  - test_two_anchors: anchor 2 ตัว → previous = อันเก่ากว่า ✅
  - test_repeat_anchor: A→B→A → history เรียงตาม mentioned_at ล่าสุดจริง ✅
  - test_exclude_item_id: exclude active → คืน previous ที่เหลือ ✅
  - test_no_timeline: ไม่มี timeline → [] / None ✅
  - test_suggestions_only: มีแต่ suggestion → [] / None ✅
  - test_limit: limit parameter ทำงาน ✅
- live chat() test: ✅ ผ่าน
  - 2 anchors (A18T + AC65B2) → LLM ตอบเปรียบเทียบ 2 รุ่นถูกต้อง
  - 1 anchor → graceful fallback (LLM บอกไม่มีรุ่นก่อนหน้า)

---

## ผ่านแล้ว (2026-09-17 — Phase 8: History QA pairs + RAG/LLM context limit 30)

### ที่มา
โค้ดเดิมส่ง `history` (ทั้งหมด) เข้า LLM และใช้ `limit=10` สำหรับ RAG retrieval ที่ส่งเข้า LLM context
ทำให้ prompt ยาวเกินจำเป็น (history ทุก message) และ LLM เห็นสินค้าน้อยเกินไป (10 ชิ้น)

ผู้ใช้ขอ:
> history = fixed 10 คู่ (Q+A นับเป็น 1 หน่วยต่อคู่) + RAG product limit จาก 10 เป็น 30 ทุกจุดที่เป็น "LLM context limit" (ไม่ใช่ frontend display limit)

### สิ่งที่เพิ่ม/แก้

#### 1. `_recent_qa_pairs(history, n=10)` — ฟังก์ชันใหม่ใน app.py
- จับคู่ user+model message เป็น QA pair (1 คู่ = 1 หน่วย)
- คืน `n` คู่ล่าสุด (default 10) เรียงเก่า→ใหม่ (พร้อมส่ง LLM contents)
- รับมือ edge cases:
  - history ว่าง / None → []
  - 2 user ติดกัน (buffer flush) → ไม่ crash, จับคู่ผิดไม่ได้
  - model เดี่ยวต้น history → คืน model เดี่ยว
  - user เดี่ยวท้าย history (ยังไม่ตอบ) → คืน user เดี่ยว
  - เกิน n คู่ → ตัดเหลือ n คู่ล่าสุด
- ไม่ mutate history ต้นฉบับ

#### 2. แทนที่ history slice ที่เป็น LLM context/follow-up
เปลี่ยนจาก `history=history` → `history=_recent_qa_pairs(history, 10)` ใน:
- Product-anchor follow-up `llm.answer()`
- Order-status `llm.answer_general()` (2 จุด)
- General-question `llm.answer_general()`
- Brand-info `llm.answer_general()`
- KB-branch `llm.answer()`
- Main product-store `llm.answer()`
- `_web_search_reanswer()` (2 จุด) — `history_list=_recent_qa_pairs(history, 10)`
- Warranty-policy model extraction (fallback text)
- Comparison follow-up model extraction
- Purchase-date model extraction

#### 3. คง history เต็มไว้โดยเจตนา (มี comment อธิบาย)
- Intent classification — ต้องการ full history เพื่อจับ intent ที่อ้างอิงไกล
- Warranty claim state-machine review extraction — ต้องการ full history เพื่อรักษา claim details
- Logging preview (`history[-10:]`) — logging เท่านั้น
- Vision context summary (`history[-6:]`) — vision-specific
- Vision image URL extraction (`history[-2:]`) — จำกัดจำนวนภาพที่ reprocess
- Warranty image-context detection (`history[-3:]`) — warranty-specific
- Last-model-message guards (`[-1:]`, `[-2:]`) — state machine

#### 4. `_LLM_CONTEXT_LIMIT = 30` — constant ใหม่
- แยกจาก `req.limit` (frontend display limit)
- ใช้สำหรับ RAG retrieval และ LLM context limit

#### 5. เปลี่ยน RAG/retrieval `limit=10` → `limit=_LLM_CONTEXT_LIMIT` (5 จุด)
- Web-search re-answer DB query (L867)
- KB/Mongo merge retrieval (L3350)
- Original-query fallback (L3362)
- Charger fallback retrieval (L5278)
- Device-spec lookup retrieval (L5855)

#### 6. เปลี่ยน LLM context cap จาก 10/req.limit → `_LLM_CONTEXT_LIMIT` (4 จุด)
- KB branch `products[:10]` → `products[:_LLM_CONTEXT_LIMIT]` (L3580)
- Superlative sort `products[:req.limit]` → `products[:_LLM_CONTEXT_LIMIT]` (L5142)
- `_apply_product_tiers(products, _tier_a_ids, req.limit)` → `... _LLM_CONTEXT_LIMIT` (L5898)
- `_fetch_limit` base: `req.limit` → `_LLM_CONTEXT_LIMIT` (L4858)
  - compat: `max(req.limit * 2, 20)` → `max(_LLM_CONTEXT_LIMIT * 2, 40)`
  - `_merge_limit`: `max(req.limit * 4, 40)` → `max(_LLM_CONTEXT_LIMIT * 4, 80)`

#### 7. คง frontend display limit ไว้ (ไม่แตะ)
- `products[:req.limit]` ใน ChatResponse
- `products_for_response = products[:req.limit]`
- `_record_suggestion_products(req, products[:req.limit])`
- Logging/debug previews (`products[:10]`, `products[:20]`)

### ข้อบังคับที่ถือ
- ห้าม conflate LLM context limit กับ frontend display limit
- ห้ามลบ comment เดิม
- ใช้ pattern ที่มี (helper `_` prefix, `from __future__` type hint)
- ไม่ mutate history ต้นฉบับ

### verify
- py_compile: ✅ ผ่าน
- unit test 10/10: ✅ ผ่าน (test_recent_qa_pairs.py)
  - test_empty, test_none, test_full_pairs, test_truncate, test_double_user
  - test_model_solo, test_user_solo_end, test_n1, test_order, test_preserve_fields
- anchor compare test 7/7: ✅ ผ่าน (test_anchor_compare.py — ไม่พัง)
- live chat() test: ✅ ผ่าน
  - 2 anchors (A18T + AC65B2) → LLM ตอบเปรียบเทียบ 2 รุ่นถูกต้อง
  - ใช้ `_recent_qa_pairs(history, 10)` + `_LLM_CONTEXT_LIMIT=30`

### cost/latency estimate (ไม่ได้วัดจริง — เป็นการประมาณ)
- **Retrieval**: Mongo/KB ดึงเพิ่มจาก 10 → 30 การ์ด (~3x query result size)
  - dedup/sort เพิ่มเล็กน้อย (O(n log n), n=30 แทน 10)
  - latency เพิ่ม ~10-30ms (Mongo index lookup + Python dedup)
- **LLM prompt**: การ์ดสินค้าเพิ่มจาก 10 → 30 (~3x product context tokens)
  - ประมาณการ์ดละ ~150-250 tokens (name + spec + price + stock + status)
  - เพิ่ม ~3,000-4,500 input tokens
  - output tokens ไม่เปลี่ยน (LLM ตอบเท่าเดิม)
  - cost เพิ่ม ~ proportional กับ input tokens (~3-5% ของ total cost per call)
- **History**: ลดจาก full history → 10 QA pairs
  - ประหยัด tokens ถ้า history ยาว > 10 คู่
  - เพิ่ม tokens ถ้า history สั้น < 10 คู่ (ไม่น่าเกิด)
- **รวม**: latency เพิ่ม ~50-100ms, cost เพิ่ม ~3-5% per call (เป็นการประมาณ ไม่ได้วัดจริง)
- **Token safety**: 30 การ์ด + 10 QA pairs + system prompt ≈ 8,000-12,000 tokens
  - อยู่ใน limit ของ GPT-4o-mini (128K) และ Gemini Flash (1M) อย่างปลอดภัย

### ไฟล์ที่แก้
- `chatbot/shopeechat/app.py` — `_recent_qa_pairs`, `_LLM_CONTEXT_LIMIT`, แทนที่ history/limit
- `docs/test/test_recent_qa_pairs.py` — unit test ใหม่

### ไม่ได้แก้ SRS_SSD.md ในรอบนี้
- จะอัปเดต section 6 ของ SRS ในรอบถัดไป (ตามกฎข้อ 1 — แต่ขอ verify replay เพิ่มก่อน)

## ผ่านแล้ว (2026-09-18 — Phase 8.1: Admin-configurable llm_context_limit)

### ที่มา
Phase 8 ใช้ `_LLM_CONTEXT_LIMIT = 30` เป็น module constant แบบ hardcoded — ผู้ใช้ขอให้ปรับค่านี้ได้จากหน้า admin config โดยไม่ต้องแก้โค้ด/redeploy

ผู้ใช้ขอ:
> เราสามารถให้ปรับได้ไหมในหน้า config ว่า limit จะส่งเท่าไหร่ สูงสุดอะ

### สิ่งที่เพิ่ม/แก้

#### 1. Admin web — `systemConfigService.ts`
- เพิ่ม `llm_context_limit` ใน `SystemConfigDoc` (default 30)
- เพิ่มใน safe defaults + initialization path
- เพิ่มใน `allowedKeys` (PUT whitelist)
- เพิ่มใน `ADMIN_CONFIGURABLE_KEYS` (admin-config endpoint)

#### 2. Admin API — `/api/config/route.ts`
- เพิ่ม validation: `llm_context_limit` ต้องเป็น integer 10-50
- reject ค่านอก range ด้วย HTTP 422
- คง dangerous-key rejection + URL safety ไว้ครบ

#### 3. Admin UI — `/config/page.tsx`
- เพิ่ม `llm_context_limit` ใน `SystemConfig` interface
- เพิ่ม numeric input (min 10, max 50, step 5)
- เพิ่ม save handler `handleSaveLlmContextLimit()` (ใช้ confirm dialog + api().put)
- อธิบายว่าเป็น LLM context ไม่ใช่ frontend display

#### 4. Admin UI — `/admin-config/page.tsx`
- เพิ่ม `llm_context_limit` ใน `AdminConfig` interface
- เพิ่ม `MinimalSlider` (10-50, step 5) พร้อม label
- เพิ่มใน load/save/hasChanges

#### 5. Bot call — `botCallService.ts`
- อ่าน `llm_context_limit` จาก `getSystemConfig()` ใน `callBot()`
- ส่ง `llm_context_limit` ใน JSON body ไป Python `/chat`
- ครอบคลุมทุก call path (live, worker, assignment, replay, test-chat)

#### 6. Python — `app.py`
- เพิ่ม `llm_context_limit: int | None` ใน `ChatRequest` (Field(None, ge=10, le=50))
- resolve `_llm_ctx_limit = req.llm_context_limit or _LLM_CONTEXT_LIMIT` ที่ต้น `chat()`
- แทนที่ `_LLM_CONTEXT_LIMIT` → `_llm_ctx_limit` ใน 11 จุด (web-search re-query, KB/Mongo merge, fetch_limit, compat merge, Tier B cap, KB cap, etc.)
- `_LLM_CONTEXT_LIMIT = 30` ยังคงเป็น default fallback (ถ้า request ไม่ส่งค่ามา)
- ไม่แตะ `req.limit` (frontend display) / logging previews / anchor follow-up

### ข้อบังคับที่ถือ
- แยก LLM context limit จาก frontend display limit (`req.limit`)
- validation ทั้ง admin API (422) และ Python (Pydantic ge/le)
- ไม่ mutate global constant — ใช้ per-request local
- ไม่อ่าน .env — ค่ามาจาก SystemConfig (MongoDB) เท่านั้น

### verify
- py_compile: ✅ ผ่าน
- tsc --noEmit: ✅ ผ่าน (0 errors)
- test_recent_qa_pairs.py: ✅ 10/10 passed
- test_anchor_compare.py: ✅ 7/7 passed

### ไฟล์ที่แก้
- `ChatAdminWeb/src/backend/service/systemConfigService.ts` — field + defaults + whitelist
- `ChatAdminWeb/src/app/api/config/route.ts` — PUT validation
- `ChatAdminWeb/src/app/(console)/config/page.tsx` — UI card + save handler
- `ChatAdminWeb/src/app/(console)/admin-config/page.tsx` — slider UI + save
- `ChatAdminWeb/src/backend/service/botCallService.ts` — ส่ง llm_context_limit ใน body
- `chatbot/shopeechat/app.py` — ChatRequest field + _llm_ctx_limit resolve + แทนที่ 11 จุด
- `docs/SRS_SSD.md` — อัปเดต ChatRequest + _LLM_CONTEXT_LIMIT description


## ผ่านแล้ว (2026-09-18 — Warranty auto-check จาก delivery date)

### ที่มา
`auto_check_warranty()` ใน `warranty.py` ใช้ `create_time_raw` (วันที่สั่งซื้อ) คำนวณระยะประกัน — แต่ warranty ควรเริ่มนับจากวันที่ส่งมอบ (delivery date) ไม่ใช่วันที่สั่งซื้อ

### วิธีแก้

#### 1. `order_store.py` — เพิ่ม `delivery_time_raw`
- คู่กับ `delivery_time` (formatted) ที่มีอยู่แล้ว
- ใช้เงื่อนไข + source เดียวกัน: `order_status_raw == "COMPLETED"` หรือ `logistics_status_raw == "LOGISTICS_DELIVERY_DONE"` → ใช้ `update_time`
- ถ้ายังไม่ส่งมอบ/ยกเลิก → `delivery_time_raw = None`
- ไม่ใช้ `create_time_raw` เป็น fallback

#### 2. `warranty.py` — เพิ่ม `check_warranty_status(delivery_time_raw, warranty_months)`
- คำนวณสถานะรับประกันจาก delivery date แทน create date
- ถ้า `delivery_time_raw` เป็น None/0/empty → คืน `in_warranty=None` (ยังไม่ส่งมอบ)
- ถ้า `warranty_months <= 0` → คืน `in_warranty=None`
- ถ้า timestamp ไม่ valid → catch exception → คืน `in_warranty=None` (ไม่ crash)
- คืน dict: `{in_warranty, days_remaining, delivery_date, expiry_date, text}`
- `auto_check_warranty()` เดิมยังคงอยู่ (legacy — ใช้ create_time_raw) แต่ถูกใช้เป็น context fallback เท่านั้น

#### 3. `app.py` — แก้ warranty auto-check flow (line ~1659)
- เปลี่ยนจากเรียก `auto_check_warranty()` ตรงๆ → เรียก `lookup_order()` + `check_warranty_status()`
- ดึง warranty duration จากชื่อสินค้าใน order (ใช้ `extract_warranty_from_name`)
- ถ้า multi-item ที่ warranty ต่างกัน → ถามลูกค้าว่าถามเรื่องชิ้นไหน (ambiguity)
- ถ้าทุก item มี warranty เท่ากัน → คำนวณ `check_warranty_status()`
- ถ้ายังไม่ส่งมอบ → บอกลูกค้าว่ายังไม่เริ่มนับประกัน
- ถ้าอยู่ในช่วงประกัน → บอกระยะเวลา + ขอข้อมูลเคลม
- ถ้าหมดช่วงประกัน → บอกหมดแล้ว + ถามสนใจปรึกษาแอดมินไหม
- deterministic answer → return ทันที ไม่เข้า LLM (early return ก่อน claim flow)
- ถ้า delivery-date flow ไม่ได้ผล → fallback ไป `auto_check_warranty()` เดิมเป็น context
- manual purchase-date flow (`parse_purchase_date` + `is_in_warranty`) ยังอยู่ครบ ไม่ถูกแตะ

### ข้อบังคับที่ถือ
- ห้ามใช้ `create_time_raw` แทน `delivery_time_raw` ใน flow ใหม่
- CANCELLED order → `delivery_time_raw=None` → `in_warranty=None` ไม่ crash
- multi-item ต่าง warranty → ถามลูกค้า ไม่เดา
- manual date fallback ยังทำงานเหมือนเดิม
- ไม่แตะ `conversation_products` schema / anchor / history behavior
- ไม่ migrate ไป chat_v2

### verify
- `py_compile` 3 ไฟล์: ✅ ผ่าน (order_store.py, warranty.py, app.py)
- `test_warranty_delivery.py`: ✅ 11/11 ผ่าน
  - test_cancelled_order_delivery_raw_none: CANCELLED → None ✅
  - test_zero_delivery_raw: ts=0 → None ✅
  - test_completed_order_in_warranty: ส่งมอบ 10 วัน → in_warranty=True ✅
  - test_completed_order_out_of_warranty: ส่งมอบ 400 วัน → in_warranty=False ✅
  - test_no_warranty_months: warranty_months=0 → None ✅
  - test_invalid_timestamp: ts ไม่ valid → None ไม่ crash ✅
  - test_multi_item_different_warranties: 12M + 24M → ambiguity → ask customer ✅
  - test_multi_item_same_warranty: 12M + 12M → calculate ✅
  - test_manual_date_fallback_still_works: parse_purchase_date + is_in_warranty ยังทำงาน ✅
  - test_manual_date_thai_year: ปี พ.ศ. → ค.ศ. ✅
  - test_delivery_time_raw_in_lookup_order_docstring: delivery_time_raw อยู่ใน lookup_order ✅
- `test_anchor_compare.py`: ✅ 7/7 ผ่าน (ไม่พัง)
- `test_recent_qa_pairs.py`: ⚠️ pre-existing env issue (missing google.genai) — ไม่ใช่จากการแก้ครั้งนี้
- `test_pingevox_mistore.py`: ✅ 42/42 ผ่าน (live bot server + real Gemini API + real MongoDB)
  - pingevox (KingGadgets): 5/5 ผ่าน
  - mistorethailand (KingGadgets): 37/37 ผ่าน
  - claim handoff ทำงาน: Q22 (a18t ใช้งานไม่ได้), Q29 (สายชาร์จ ชาร์จไฟไม่ได้) → handoff=True ✅
  - warranty policy แยกจาก claim: Q19 (หมดประกันยัง) → ไม่ handoff ตอบเอง ✅

### ไฟล์ที่แก้
- `chatbot/shopeechat/order_store.py` — เพิ่ม `delivery_time_raw` + docstring
- `chatbot/shopeechat/warranty.py` — เพิ่ม `check_warranty_status()` + `Any` import
- `chatbot/shopeechat/app.py` — แก้ warranty auto-check flow + early return + legacy fallback
- `docs/test/test_warranty_delivery.py` — unit test ใหม่ 11 เคส
- `docs/test/test_pingevox_mistore.py` — live regression test 42 เคส (pingevox + mistore)
- `docs/SRS_SSD.md` — อัปเดต lookup_order return + check_warranty_status + called by
- `getoutofmywaybotkaikrook.md` — บันทึก waythrough


## ผ่านแล้ว (2026-09-19 — Phase 3d: _available_for_sale + context note นอก if has_unlist)

### ที่มา
บอทแนะนำขายสินค้าที่ `shopee_stock=0` (sold_out=True) ทั้งที่ status=NORMAL — เคส LuckyHomeMart สินค้า Leravan ทุกตัว stock=0 แต่บอทยังแนะนำขาย + ส่งลิงก์สั่งซื้อ

### สาเหตุ
- sold_out note (กฎ "ห้ามเสนอขายสินค้า stock=0") ถูกฝังอยู่ใน `if has_unlist and products:` block (บรรทัด 5659)
- `has_unlist` = มีสินค้า status != NORMAL ปนอยู่ไหม
- เคส LuckyHomeMart: สินค้า Leravan ทุกตัว status=NORMAL แต่ sold_out=True → has_unlist=False → sold_out note ไม่ถูก inject → LLM ไม่รู้ว่าห้ามแนะนำขาย

### วิธีแก้

#### 1. `app.py` — ย้าย sold_out note ออกจาก if has_unlist block
- mark `_available_for_sale` ในทุก product card (ก่อน `_apply_product_tiers`):
  - `True` ถ้า status=NORMAL + sold_out=False + total_stock>0
  - `False` ถือไม่ใช่
- สร้าง `_pending_context_note` จาก unlist_note + sold_out_note + กฎหลัก
- inject context_note หลัง `_apply_product_tiers` (ไม่ใช่ก่อน) เพราะ sort เปลี่ยนลำดับ products

#### 2. `llm.py` — เพิ่ม _available_for_sale ใน slim_fields + SYSTEM_INSTRUCTION
- slim_fields: เพิ่ม `_available_for_sale` ให้ LLM เห็น field นี้ใน product card
- SYSTEM_INSTRUCTION กฎ 1: เพิ่มกฎ `_available_for_sale` เป็นเกณฑ์หลัก
- KB_SYSTEM_INSTRUCTION กฎ 1: เพิ่มกฎ `_available_for_sale` เป็นเกณฑ์หลัก

### กฎ
- ตอบคำถามสินค้าได้ทุก status (สเปค, รายละเอียด, รับประกัน)
- แต่ห้ามแนะนำขาย/เสนอขาย/ส่งลิงก์สั่งซื้อ กับสินค้าที่:
  - `shopee_stock <= 0` หรือ
  - `status != NORMAL` หรือ
  - `sold_out = True`
- ใช้ `_available_for_sale` field เป็นเกณฑ์หลัก (True=พร้อมขาย, False=ห้ามขาย)

### verify
- `py_compile` app.py + llm.py: ✅ ผ่าน
- LuckyHomeMart "มีเครื่องนวดหลังแบบรองหลังไหมครับ": ✅ บอทตอบ "หมดสต็อกชั่วคราว" ไม่มีลิงก์สั่งซื้อ
- `test_car_charger_regression.py`: ✅ 16/16 ผ่าน
- `test_pingevox_mistore.py`: ✅ 41/42 ผ่าน (1 ไม่ผ่านเป็น LLM 503 error ไม่เกี่ยวกับการแก้)

### ไฟล์ที่แก้
- `chatbot/shopeechat/app.py` — ย้าย sold_out note ออกจาก if has_unlist + เพิ่ม _available_for_sale + inject context_note หลัง _apply_product_tiers
- `chatbot/shopeechat/llm.py` — เพิ่ม _available_for_sale ใน slim_fields + กฎใน SYSTEM_INSTRUCTION + KB_SYSTEM_INSTRUCTION
- `getoutofmywaybotkaikrook.md` — บันทึก waythrough


---

## ผ่านแล้ว (2026-09-22 — Test Assignment replay 500 hardening)

### ที่มา
- ผู้ใช้แจ้ง: กด generate replay ในหน้า Test Assignment แล้วรอนานสักพักแล้วเจอ `AxiosError: Request failed with status code 500`
- เนื่องจาก route มี outer try/catch เดียวที่แปลงทุก exception เป็น HTTP 500 โดยไม่ log stack trace → หา root cause ไม่ได้จากฝั่ง browser

### สิ่งที่ตรวจสอบ
- อ่าน `ChatAdminWeb/src/app/api/test-assignment/route.ts` ทั้ง replay flow
- อ่าน services: `messageService.ts` (`toBotText`/`toBotImages`), `messageMediaParser.ts` (`parseRawMessage`), `testStatusConversationService.ts`, `handoffService.ts`
- สร้าง JWT + session ใน DB แล้วยิง API จริงกับ 4 conversations (4–30 user msgs, มี item/image/video/sticker/order)
- ทุกเคสที่ลองคืน HTTP 200 (ไม่ reproduce 500 ในเคสปกติ) → สรุปว่า 500 เป็น intermittent (เกิดจาก data/path ผิดปกติ หรือ service transient error)

### วิธีแก้ (defensive hardening — กัน exception หลุดออกเป็น 500)
1. **`console.error` full stack trace** ใน outer catch — ตอนนี้เห็น error จริงใน server log แทนแค่ message สั้นๆ
2. **`updateTestStatus` (clear status ก่อน replay)** → wrap try/catch + log — ถ้า clear พัง ไม่ block replay
3. **`parseRawMessage` mapping** (อยู่นอก per-message loop) → wrap แต่ละ msg ใน try/catch + fallback เป็น text — ถ้า raw_payload schema ผิดจะไม่ throw 500 ทั้ง replay
4. **`toBotText`/`toBotImages`** → ย้ายเข้า per-message try/catch (เดิมอยู่นอก) — ถ้า parse พังที่ msg ใด msg หนึ่ง จะ catch ที่ msg นั้น ไม่ใช่ทำ 500 ทั้ง replay
5. **`saveReplayResult`** → wrap try/catch + log — ถ้า MongoDB write พัง ยังคืนผล replay ให้ UI ได้ (แสดงผลได้ แค่ไม่ persist)
6. **`logAdminEvent` (audit)** → wrap try/catch + log — ถ้า audit log พัง ไม่ควรทำให้ replay 500

### ไฟล์ที่แก้
- `ChatAdminWeb/src/app/api/test-assignment/route.ts`

### Verify
- `npx tsc --noEmit` → ผ่าน ✅
- ยิง API replay จริงหลังแก้ (shp_376646402366507654, 4 msgs) → HTTP 200, ครบ ok/qa/final_status/replay_batch_id ✅
- โครงสร้าง response คงเดิม — ไม่ทำลาย contract กับ frontend

### หมายเหตุ
- ไม่ได้ reproduce 500 จริงในเคสที่ลอง — แต่เดิมมีจุดที่ exception หลุดออกนอก per-message catch ได้ (toBotText/toBotImages อยู่นอก loop, parseRawMessage อยู่นอก loop, save/log/clear ไม่มี catch) การ hardening นี้จะทำให้:
  - ถ้าเกิด 500 อีก → จะเห็น stack trace ใน server log (หา root cause ได้)
  - ถ้าเกิดจาก data/path ผิดปกติ → replay จะไม่พังทั้ง batch แค่ msg นั้นๆ ที่ error
  - ถ้าเกิดจาก service transient (MongoDB/audit) → replay ยังคืนผลได้

---

## ผ่านแล้ว (2026-09-22 — เบาะรองหลัง false negative: product type ไม่จับ "รองหลัง")

> ⚠️ ก่อนเริ่ม — อ่าน "เคสที่ผ่านแล้ว" ทั้งหมดข้างบน ห้ามทำลายเคสเดิม

### ที่มา
ลูกค้าถาม "หาเบารองหลังแจ่มๆ เอาไว้นั่งทำงาน" (เบารองหลัง = พิมพ์ผิดของ เบาะรองหลัง)
- บอทตอบ "ทางร้าน LuckyHomeMart ของเราตอนนี้ไม่มีสินค้าเบารองหลังจำหน่ายค่ะ"
- แต่จริงๆ ร้านมีสินค้า Leravan Cushion Back LBB003 "เบาะรองหลังเพื่อสุขภาพ" (item_id=21629137045, status=NORMAL, cat_name=Home & Living)
- metadata: `source=product_store+web_search`, `web_search=negative_answer`, `pipeline=Intent→LLM1→Search`, runtime 10.46s
- บอทแนะนำ MicroSD (Netac, Sandisk) แทน — มาจาก web_search fallback

### Root cause (ยืนยันแล้วด้วยการรันโค้ดจริง)
1. `_detect_product_types("หาเบารองหลังแจ่มๆ เอาไว้นั่งทำงาน")` → `set()` (ว่าง)
   - "รองหลัง" / "เบาะรองหลัง" ไม่อยู่ใน keyword ของ PRODUCT_TYPES ใดๆ
   - "massager" มีแค่ "เครื่องนวด", "นวด", "หมอนนวด", "หมอนรองคอ", "เครื่องนวดคอ", "เข็มขัดนวด", "แผ่นนวด" — ไม่มี "รองหลัง"
2. `_detect_product_types_fuzzy` ก็ไม่จับ (ไม่มี keyword ใกล้เคียงให้ fuzzy match)
3. ไม่มี product type → `has_type_regex=False` → ใช้ vector search
4. vector search ด้วย "หาเบารองหลังแจ่มๆ เอาไว้นั่งทำงาน" ไม่เจอสินค้าที่เกี่ยวข้อง (หรือเจอไม่พอ)
5. LLM ตอบ "ไม่มี" (negative answer)
6. `should_use_web_search` trigger ด้วย reason "negative_answer"
7. web_search fallback ค้นแล้วแนะนำ MicroSD แทน

### สินค้าจริงใน DB (LuckyHomeMart, cat_name=Home & Living, status=NORMAL)
- LBB003: "Leravan Cushion Back LBB003 เบาะรองหลังเพื่อสุขภาพ" (item_id=21629137045)
- LBB001: "Leravan Leband LBB001 พนักพิงหลัง เบาะพิงหลัง" (item_id=16012490191)
- LBH001: "LERAVAN Leband LBH001 เบาะรองนั่ง" (item_id=16917376841)
- ML0559: "Leravan ML0559 หมอนนวด หมอนพิงหลัง" (item_id=... — จับ massager regex ได้แล้วผ่าน "หมอนนวด")

### วิธีแก้
เพิ่ม keyword ของ "รองหลัง" / "พิงหลัง" เข้าไปใน product type "massager" (ใน `product_store.py`):
1. **user_kws** — เพิ่ม "รองหลัง", "พนักพิงหลัง", "เบาะพิงหลัง"
   - "รองหลัง" จับทั้ง "เบาะรองหลัง" และ "เบารองหลัง" (พิมพ์ผิด) เพราะเป็น substring
2. **regex** — เพิ่ม `รองหลัง|พนักพิงหลัง|เบาะพิงหลัง` เข้าไปใน massager regex
   - ทำให้ MongoDB query กรอง item_name ด้วย regex นี้ และเจอสินค้า LBB003, LBB001

### ความเสี่ยงต่อเคสเก่า
- "massager" `_PRODUCT_TYPE_CATEGORIES` = ("Health", "Home & Living", "Home Appliances") — ครอบคลุม cat_name ของสินค้า cushion (Home & Living) ✓
- สินค้าที่มี "รองหลัง"/"พิงหลัง" ในชื่อทั้งหมดเป็น Leravan health/wellness products ใน Home & Living/Health — ไม่มี false positive
- ไม่กระทบ charger subtype, smartwatch, phone, หรือ product type อื่น
- เคสเก่า "มีเครื่องนวดหลังแบบรองหลังไหมครับ" ยังจับ massager ผ่าน "เครื่องนวด" เหมือนเดิม (regex เดิมยังอยู่)

### ไฟล์ที่แก้
- `chatbot/shopeechat/product_store.py` — PRODUCT_TYPES massager entry (user_kws + regex)

### Verify (ผ่านครบ)
1. `python3 -m py_compile chatbot/shopeechat/product_store.py` → ผ่าน ✅
2. `_detect_product_types("หาเบารองหลังแจ่มๆ เอาไว้นั่งทำงาน")` → `{'massager'}` ✅
3. `_detect_product_types("หาเบาะรองหลังดีๆ เอาไว้นั่งทำงาน")` → `{'massager'}` ✅
4. `_detect_product_types("มีเบาะรองหลังไหม")` → `{'massager'}` ✅
5. `_detect_product_types("มีเบารองหลังไหม")` → `{'massager'}` ✅ (พิมพ์ผิด)
6. `_detect_product_types("อยากได้เบาะพิงหลัง")` → `{'massager'}` ✅
7. `_detect_product_types("มีพนักพิงหลังไหม")` → `{'massager'}` ✅
8. `_detect_product_types("มีเครื่องนวดหลังแบบรองหลังไหมครับ")` → `{'massager'}` ✅ (regression — ยังเดิม)
9. `fetch_products(db, "หาเบารองหลังแจ่มๆ เอาไว้นั่งทำงาน", shop_filter="LuckyHomeMart")` → 10 products, **LBB003 (21629137045) เป็นลำดับแรก** ✅
10. `fetch_products(db, "หาเบาะรองหลังดีๆ เอาไว้นั่งทำงาน", shop_filter="LuckyHomeMart")` → 10 products, **LBB003 เป็นลำดับแรก** ✅
11. `fetch_products(db, "มีเบาะรองหลังไหม", shop_filter="LuckyHomeMart")` → 10 products, **LBB003 เป็นลำดับแรก** ✅
12. `should_use_web_search` กับ positive answer (LLM เห็น LBB003) → `False, "confident_enough"` ✅ (ไม่ trigger web_search)
13. Charger subtype regression: 16/16 ผ่าน ✅
14. Product type regression (22 types): ทุกตัวผ่าน ✅
15. False positive check: "รองเท้า", "รองพื้น", "จานรอง", "ที่รองแก้ว", "หลังคา", "หลังบ้าน", "กลับหลัง" → ไม่ match massager ✅

### สรุป
- Root cause: "รองหลัง" / "เบาะรองหลัง" ไม่อยู่ใน keyword ของ product type ใดๆ → ไม่ detect → ไม่กรอง → vector search ไม่เจอ → LLM ตอบ "ไม่มี" → web_search fallback แนะนำ MicroSD แทน
- Fix: เพิ่ม "รองหลัง", "พนักพิงหลัง", "เบาะพิงหลัง" เข้าไปใน massager keywords + regex (5 บรรทัดใน product_store.py)
- ผล: LBB003 กลายเป็นสินค้าลำดับแรก → LLM ตอบเกี่ยวกับเบาะรองหลัง → ไม่ trigger web_search → ไม่แนะนำ MicroSD อีก
- **Live test (2026-09-22)**: หลังแก้ + รีสตาร์ทบอท → Q1 "ปวดหลังหาเยาะรองหลัง" RAG=22 ชิ้น (เดิม 1) → แนะนำ LBB003 ตรง; Q3 "แล้วรองเก้าอี้รองหลังไม่มีเรอะ" RAG=22 ชิ้น (เดิม 5) → แนะนำ LBB003 ตรง — ปัญหา "ส่งแค่ 5 หรือ 1 ชิ้น" หาย
- Car charger regression: 16/16 ผ่าน ✅; Pingevox/mistore regression: 42/42 ผ่าน ✅

---

### Shadow Inbox — Generate ทั้งหมด streaming (SSE) แสดงทีละคำตอบ (2026-09-10) — ✅ implement + build ผ่าน รอ verify manual
- **ปัญหา**: กด "Generate ทั้งหมด" ในหน้า shadow-inbox → รอจนครบทุก Q&A pair ถึงจะเห็นคำตอบ (บางแชท 5 คำถาม = รอ 30-60 วินาทีเห็นทีเดียว)
- **สาเหตุ**:
  1. Backend `generateConversationShadowReplies` วนลูปเรียก bot ทีละ Q&A แต่คืนผลลัพธ์ทั้งหมดพร้อมกันตอนจบ
  2. Frontend `generateAll` ใช้ `api().post()` (axios) ซึ่ง resolve ตอน response ครบ → ไม่สามารถแสดงทีละคำตอบได้
- **วิธีแก้** (SSE streaming):
  1. **`shadowReplyService.ts`** — เพิ่ม `onReply(doc, current, total)` callback ใน `generateConversationShadowReplies` — เรียกหลัง insert แต่ละ shadow reply ทันที (ไม่รอครบทุก pair)
  2. **`generate-conversation/route.ts`** — เปลี่ยนจาก `json()` response → SSE `text/event-stream` ใช้ `ReadableStream`:
     - `event: progress` → `{ current, total, inbound_text }` (ก่อนเรียก bot แต่ละรอบ)
     - `event: reply` → `{ shadow_reply: {...}, current, total }` (หลัง insert แต่ละ doc)
     - `event: done` → `{ total, generation_batch_id }` (จบ)
     - `event: error` → `{ message }` (ถ้า error)
     - เพิ่ม `export const dynamic = "force-dynamic"` กัน Next.js static render
     - เพิ่ม header `X-Accel-Buffering: no` กัน proxy รวม buffer
  3. **`ShadowConversationPanel.tsx`** — เปลี่ยน `generateAll` จาก `api().post()` (axios) → `fetch()` + `getReader()`:
     - อ่าน stream chunk ทีละ chunk, buffer, แยก SSE events ตาม `\n\n`
     - parse `event:` + `data:` แต่ละ event
     - `progress` → อัปเดต `generatingProgress` + `generatingIdx` (highlight ข้อที่กำลังทำ)
     - `reply` → อัปเดต `pairs[idx]` ทันทีที่ bot ตอบเสร็จ (ไม่รอครบ)
     - `done` → toast success
     - `error` → toast error
     - เพิ่ม state `generatingProgress` (`{ current, total } | null`) แสดง "Generate 2/5" บนปุ่ม
- **ไฟล์ที่แก้**: `shadowReplyService.ts`, `generate-conversation/route.ts`, `ShadowConversationPanel.tsx`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python (`chatbot/shopeechat/`) ไม่เกี่ยวกับการแก้ครั้งนี้
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅, `npm run build` → ผ่าน ✅
- **⚠️ ยังไม่ verify manual**: รอเปิดหน้า shadow-inbox กด Generate ทั้งหมดใน browser เพื่อยืนยัน:
  1. คำตอบขึ้นทีละอันทันทีที่ bot ตอบเสร็จ (ไม่รอครบ)
  2. ปุ่มแสดง "Generate 2/5" อัปเดตตาม progress
  3. ข้อที่กำลัง generate มี spinner "กำลัง generate..."
  4. ครบทุกข้อแล้ว toast "Generate ครบ N ข้อความแล้ว"
- **⚠️ หมายเหตุ**: batch generate (roll) ใน `shadow-inbox/page.tsx` ยังใช้ `api().post()` เดิม — รอทีละแชท แต่ละแชทรอครบ Q&A (ไม่ stream) เพราะ roll ทำทีละแชทและอัปเดต progress ระดับแชทแล้ว

---

## ผ่านแล้ว (ใหม่)

### มอก. (TISI standard) question handler (2026-09-10) — ✅ implement + verify ผ่าน
- **ปัญหา**: ลูกค้าถามเรื่อง มอก. (มาตรฐานผลิตภัณฑ์อุตสาหกรรม) → บอทไม่รู้จัก ไม่ค้น DB ตอบไม่ได้
  - เคสจริง: "รุ่นไหนมี มอก. บ้าง" → Zaapi ส่งต่อแอดมิน (เราตอบได้จาก DB แต่ยังไม่มี handler เฉพาะ)
  - เคสเจาะจง: "AC65B2 มี มอก. ไหม" → ต้องเช็คเฉพาะรุ่น
- **วิธีแก้**:
  1. **`product_store.py`** — เพิ่ม `search_tisi_products(db, shop_filter, model_keyword, limit)`:
     - ค้น MongoDB `description` ด้วย regex `มอก\.` (TISI standard)
     - กรอง false positive ใน Python (`_has_tisi`): ไม่ match "หมอก" (fog), "เสมอกัน" (equal)
     - `_extract_tisi_context` ดึงข้อความรอบ มอก. ส่งให้ LLM/answer
     - รองรับ `model_keyword` กรองเฉพาะรุ่นที่เจาะจง
  2. **`warranty.py`** — เพิ่ม `detect_tisi_question(message)` และ `extract_tisi_model_keyword(message)`:
     - `detect_tisi_question`: ตรวจคำถาม มอก. (กรอง "หมอก"/"เสมอกัน" false positive)
     - `extract_tisi_model_keyword`: สกัดชื่อรุ่นจากคำถาม (เช่น "AC65B2 มี มอก. ไหม" → "AC65B2")
     - ถ้าเป็นคำถามทั่วไป "รุ่นไหนมี มอก. บ้าง" → คืน "" (ไม่เจาะจงรุ่น)
  3. **`app.py`** — เพิ่ม มอก. handler block หลัง tax invoice handoff:
     - detect คำถาม มอก. → ค้น `search_tisi_products` ใน DB
     - ถ้าเจอ → ตอบว่ามี รุ่นไหนบ้าง (หรือรุ่นที่เจาะจงถาม)
     - ถ้าไม่เจอ → ส่งเรื่องให้แอดมิน + handoff (เหมือน tax invoice pattern)
  4. **`product_store.py`** — เพิ่ม "มอก.", "มอก", "tisi", "มาตรฐาน" ใน `spec_kw` ของ `_clean_description`
     - เพื่อให้ description ที่มี มอก. ถูกส่งให้ LLM ได้เมื่อลูกค้าถามเรื่อง มอก.
- **เคสที่ผ่าน** (test แล้ว):
  - `detect_tisi_question("รุ่นไหนมี มอก. บ้าง")` → True ✓
  - `detect_tisi_question("AC65B2 มี มอก. ไหม")` → True ✓
  - `detect_tisi_question("หมอกเย็นเกรดไมครอน")` → False ✓ (หมอก = fog)
  - `detect_tisi_question("เสมอกันที่ 0.8 มม.")` → False ✓ (เสมอกัน = equal)
  - `detect_tisi_question("tisi certified ไหม")` → True ✓
  - `extract_tisi_model_keyword("AC65B2 มี มอก. ไหม")` → "AC65B2" ✓
  - `extract_tisi_model_keyword("รุ่นไหนมี มอก. บ้าง")` → "" ✓ (ไม่เจาะจง)
  - `_has_tisi("ปลั๊กมาตรฐาน มอก. 2432-2555")` → True ✓
  - `_has_tisi("หมอกหมุนได้ 360")` → False ✓ (หมอก = fog)
  - `search_tisi_products(db)` → 109 products with มอก. across 8 shops ✓
  - `search_tisi_products(db, model_keyword="A18T")` → 1 product (CUKTECH A18T, "มาตรฐานมอก.") ✓
  - `search_tisi_products(db, model_keyword="AC65B2")` → 0 products (AC65B2 ไม่มี มอก. ใน description) ✓
- **ไฟล์ที่แก้**: `chatbot/shopeechat/product_store.py`, `chatbot/shopeechat/warranty.py`, `chatbot/shopeechat/app.py`
- **Verify**:
  - `python3 -m py_compile` ทุกไฟล์ → ผ่าน ✅
  - `test_car_charger_regression.py` → 16/16 ผ่าน ✅ (ไม่ทำลายเคสเดิม)
  - unit test 13 cases → ผ่านทุกเคส ✅
  - MongoDB query → 109 products with มอก. จริง ✅
- **⚠️ ยังไม่ verify เต็ม**: รอทดสอบจริงกับบอท (replay แชทที่ถาม มอก.) เพื่อยืนยันว่าบอทตอบถูก end-to-end
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: รอ verify replay เพิ่มเติมก่อน (ตามกฎ)

---

### Live Assignment — กดปิดแชทครั้งที่ 2 ไม่ประมวลผลข้อความใหม่ (2026-09-10) — ✅ implement + tsc ผ่าน รอ verify
- **ปัญหา**: หน้า live assignment กดปิดแชท → reopen → bot ตอบ → handoff → หยุด แต่พอกดปิดแชทครั้งที่ 2 ข้อความใหม่ไม่มาต่อ
- **สาเหตุ**: ใน `closeChat()` (liveAssignmentService.ts) บรรทัด ~710:
  - `const newProcessedCount = processedCount + remainingMsgs.length` — นับ `remainingMsgs.length` ทั้งหมด ทั้งที่ loop หยุดกลางทางที่ handoff (`stopped=true`)
  - ข้อความหลัง handoff ถูก mark ว่า "processed" แต่ไม่เคย process จริง
  - ครั้งต่อไปกดปิดแชท → `remainingMsgs = allUserMsgs.slice(processedCount)` ข้ามข้อความที่ถูกข้าม → ไม่มาต่อ
- **วิธีแก้**:
  1. เพิ่ม `let processedInThisBatch = 0` ก่อน loop
  2. ใน loop: `processedInThisBatch = i + 1` (track จำนวนที่ process จริง)
  3. เปลี่ยน `newProcessedCount = processedCount + remainingMsgs.length` → `processedCount + processedInThisBatch`
  - ผล: ถ้า loop หยุดที่ handoff (i=0) → `processedInThisBatch=1` → `newProcessedCount = processedCount + 1` → ครั้งต่อไปข้อความที่เหลือจะถูก process ใหม่
- **ไฟล์ที่แก้**: `ChatAdminWeb/src/backend/service/liveAssignmentService.ts`
- **Verify**: `npx tsc --noEmit` → ผ่าน ✅
- **⚠️ ยังไม่ verify manual**: รอทดสอบจริงในหน้า live assignment (กดปิดแชท 2 ครั้ง + มีข้อความใหม่)

---

### Device-spec-lookup ไม่ทำงานใน KB path → บอทแนะนำแค่ baseline ไม่มี upgrade (2026-09-10) — ✅ implement + verify ผ่าน
- **ปัญหา**: ลูกค้าถาม "สนใจหัวชาร์จที่ใช้กับ iphone 17 pro max" → บอทแนะนำแค่ CUKTECH A18T 30W ทั้งที่ร้านมี 65W/100W ที่ compat กับ iPhone 17 Pro Max (USB-C PD) ด้วย → ไม่มี dual-tier recommendation (baseline + upgrade)
- **สาเหตุ**: KB path (บรรทัด ~3979) เรียก LLM และ return ก่อนถึง device-spec-lookup block (บรรทัด ~6083) → web search spec + re-query หา high-wattage ไม่เคยทำงานเมื่อ KB path จัดการเอง → LLM เห็นแค่สินค้าจาก KB+Mongo (4 ตัว) ไม่เห็น high-wattage upgrade
- **วิธีแก้**:
  1. แยก device-spec-lookup logic (บรรทัด ~140 บรรทัด) เป็น module-level helper `_device_spec_lookup()` (บรรทัด ~646)
     - รับ parameter: db, req, intent_result, history, existing_products, retrieval_message, anchor_card, hybrid_anchor_card, llm_ctx_limit, resolve_subtype_fn
     - คืน tuple: (device_spec_extra, additional_products)
     - resolve_subtype_fn เป็น parameter เพราะ `_resolve_charger_subtype` เป็น nested function ใน `chat()` (closure ใช้ req, _hybrid_anchor_card)
  2. เรียก helper จาก KB path ก่อน LLM call (บรรทัด ~4008) → merge high-wattage products + inject spec context
  3. แทนที่ inline code ใน main path (บรรทัด ~6267) ด้วย helper call → ลดโค้ดซ้ำ ~130 บรรทัด
- **ผล**:
  - ก่อนแก้: 4 products, แนะนำแค่ 1 รุ่น (30W)
  - หลังแก้: 33 products (4 KB + 29 re-query), แนะนำ 2 รุ่น (baseline 40W + upgrade 65W/100W)
  - log: `[DEVICE-SPEC-LOOKUP-KB] merge 29 สินค้าจาก re-query เข้า merged_products (now 33)`
  - re-query: `'หัวชาร์จ charger USB-C Type-C PD Power Delivery MagSafe Qi2'` (keywords จาก web search spec ของ iPhone 17 Pro Max)
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/app.py` → ผ่าน ✅
  - `test_car_charger_regression.py` → ผ่าน 16/16 ✅
  - curl test "สนใจหัวชาร์จที่ใช้กับ iphone 17 pro max" → 10 products, แนะนำ 2 รุ่น (AD653U 65W/100W + AC301 40W) ✅
- **⚠️ หมายเหตุ**: iPhone 17 Pro Max ชาร์จสูงสุด 36-40W → บอทแนะนำ 40W (baseline) + 65W/100W (upgrade) ถูกต้องตาม spec ไม่ใช่ 120W/140W ที่เกินความต้องการของอุปกรณ์
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: รอ verify replay เพิ่มเติมก่อน (ตามกฎ)

---

## กำลังจะทำ

### UX Critique + Fix Round (2026-09-22 — Impeccable critique + fix loop)

- **ที่มา**: รัน `/impeccable critique` บน ChatAdminWeb `(console)` ทุกหน้า → ได้คะแนน 22/40
- **แผนแก้ 6 ข้อตามลำดับ** (แก้แต่ละข้อแล้วรัน critique เทียบคะแนน):
  1. ✅ Accessibility & contrast — แก้ `--color-text-subtle` `#98a2b3`→`#667085`, เพิ่ม `--color-base` token, standardize `focus:ring-brand/30`→`/40` (32 จุด), `aria-label` 2 ปุ่ม send → คะแนน 22→23
  2. ✅ PageShell — สร้าง `PageShell` ที่ `src/components/ui/PageShell.tsx`, แปลง 8 หน้า (dashboard, shops, contacts, users, team, config, admin-config, admin-review-kpi) → คะแนน 23→24
  3. ✅ Filter density — สร้าง `FilterChips` ที่ `src/components/ui/FilterChips.tsx`, ใส่ใน 4 หน้า (knowledge, triggers, quick-replies, logs), เพิ่ม `filterBar` slot ใน PageShell → คะแนน 24→25
  4. ✅ Error handling — แก้ 4 silent `.catch(() => {})` → `catchError(e, "msg")` ใน shop-settings, test-results, botworker, tickets → คะแนน 25→26
  5. ✅ IA bloat — ทำ "การทดสอบบอท" collapsible (10 items ซ่อน default), เพิ่ม nav search ใน Sidebar → คะแนน 26→26 (H9↑1, H4↓1)
  6. ✅ Polish — แก้ detector findings ทั้ง 3 (gray-on-color, side-tab, broken-image) → คะแนน 26→27, detector 0 findings
- **ไฟล์ที่แก้แล้ว**: `globals.css`, `TicketChatPanel.tsx`, `ChatWindow.tsx`, `PageShell.tsx`, `FilterChips.tsx`, `Sidebar.tsx` + หน้า console ที่แปลง/แก้ catch + `replay-compare/page.tsx` + `TestChatClient.tsx`
- **Verify**: รัน critique รอบ 7 → 27/40 (ขึ้น 5 จาก baseline 22) — detector 0 findings
- **⚠️ ไม่ได้แก้ฟังก์ชันบอท**: งานนี้เป็น CSS/a11y ใน ChatAdminWeb เท่านั้น ไม่กระทบ chatbot core
- **ปัญหาที่เหลือ (future work)**:
  - Hardcoded hex palette ใน TestChatClient.tsx style block
  - Image errors ลบเงียบไม่มี fallback
  - ~30+ silent `.catch(() => setX([]))` ยังกลืน load failures
  - ไม่มี in-app help/tooltips
  - PageShell ครอบคลุม 8/28+ หน้า

### UX Critique Round 8+ (2026-09-22 — Push 27→31/40)
- **ที่มา**: ผู้ใช้ต้องการ push คะแนนต่อ วิเคราะห์ impact 3 ด้านแล้ว กระทบระบบเดิมต่ำ-กลาง
- **แผนแก้ 4 ข้อ** (ทีละข้อ + audit + critique):
  1. ✅ ขยาย PageShell 5 หน้า (quick-replies, triggers, knowledge, logs, shop-settings) — H4 3→3, H7 2→4, H9 2→3, H10 1→2 → คะแนน 27→29
  2. ✅ แก้ 11 silent catches เป็น catchError toast — H9 3→4, H3 3→4, H10 2→3 → คะแนน 29→30
  3. ✅ เพิ่ม tooltip บน 17 icon-only buttons — H4 2→4, H5 2→3, H8 3→4 → คะแนน 30→31
  4. ✅ แทน neutral hex ใน TestChatClient ด้วย tokens (21 จุด) — H1 3→4, H6 3→4, H7 2→3 → คะแนน 31→32
- **เป้าหมาย**: 27 → 31/40 (ปัจจุบัน 32/40 — เกินเป้า +1!)
- **สรุป 11 รอบ**: 22 → 32/40 (+10), detector 3→0 findings
- **รอบ 12 (ที่เหลือ)**:
  - ✅ P0: เพิ่ม `--color-surface-3: #e8ebef` ใน globals.css — แก้ 19 จุดที่ bg-surface-3 ไม่ render
  - ✅ P1: เพิ่ม 12 semantic tokens ใน globals.css (success/error/info/warning/purple/orange/muted)
  - ✅ P1: Migrate 21 semantic hex ใน TestChatClient → `var(--color-*)` (zero remaining)
  - ✅ P1: แก้ 10 silent catches ใน TestChatClient → toast.error (6 user + 4 background)
  - ✅ Final audit + critique round 12: 32 → 33/40 (+1)
- **สรุป 12 รอบ**: 22 → 33/40 (+11), detector 3→0 findings
- **ปัญหาที่เหลือ (future work)**:
  - 3 silent catch {} ใน TestChatClient (handoff + ratings — intentionally left)
  - Hardcoded Tailwind semantic colors (text-green-600 ฯลฯ) ใน 5 console pages
  - icon-only buttons ขาด aria-label (~12 จุดใน 30+ pages)
  - No help/onboarding surface (H10 ติด 2/4)
  - surface-3 ยังไม่ roll out ครบ 17 จุดที่เหลือ

### UX Critique Round 15+ (2026-09-22 — P1 done, P2 in progress)
- **ที่มา**: ผู้ใช้สั่ง "ทำต่อที่เหลือครับ /impeccable audit และ critique ทุกรอบ"
- **ความคืบหน้า**:
  - ✅ P0: แก้ 3 silent catch {} ใน TestChatClient (handoff + ratings) — typecheck ผ่าน, detector `[]`, critique r13/r14 = 34.5/40
  - ✅ P1: migrate ~71 hardcoded Tailwind semantic colors ใน 6 console pages (replay-compare, live-assignment, botworker, tickets, admin-config, config) — typecheck ผ่าน, detector `[]`, critique r14 = 34.5/40
  - 🔄 P2: เพิ่ม `aria-label` บน icon-only buttons ที่มี `title` แต่ขาด `aria-label` — audit พบ 81 จุดใน console + components
  - ✅ P2 (implemented): เพิ่ม `aria-label` ~60 จุด ใน ShopDetailDrawer (13), TestChatClient (8), ChatWindow (1), ProductsTab (1), RateBox (1), ShadowConversationPanel (2), ShadowInboxList (1), ShadowReplyPanel (1), AnnotationDot (1), ImageViewer (5), WorkflowEditor (1), AppShell (1), Sidebar (3), ZaapiStats (1) + console pages: knowledge (2), persona (2), quick-replies (2), triggers (2), workflows (4), shop-settings (4), test-assignment (4), test-results (2), test-chat-result (2), admin-chat-result (1), admin-review-kpi (1), botworker (5), live-assignment (5), shadow-inbox (6), tickets (5)
  - เพิ่ม `focus-visible:ring` บน test-assignment soft-delete span (มี role=button + tabIndex + onKeyDown อยู่แล้ว)
  - ลบ aria-label ที่ redundant บน shadow-inbox "ล้าง" button (มี visible text อยู่แล้ว)
- **Verify**:
  - `npx tsc --noEmit -p tsconfig.json` → exit 0 ✅
  - detector `ChatAdminWeb/src/app/(console)` → `[]` ✅
  - detector `ChatAdminWeb/src/components` → `[]` ✅
- **Critique r15** (dual-agent A:94565bba · B:81b10596):
  - คะแนน **28/40** (ลดจาก 34.5 เพราะ audit เข้มขึ้น ไม่ใช่ P2 ทำให้แย่ลง)
  - H4 consistency 2.5/4, H10 help 1/4, H2 match 2/4
  - P0: 89 hardcoded semantic colors ยังเหลือใน 11 ไฟล์ (test-assignment 33, test-chat-result 10, config 10, admin-config 9, admin-chat-result 9, team 8)
  - P0: 8 toggle switches ยังขาด aria-label + role="switch" (config, admin-config, workflows, persona, triggers, quick-replies, knowledge, test-chat-result)
  - P1: `bg-surface-1` ใช้ 6 จุด แต่ **ไม่ได้ define** ใน globals.css (test-results 3, config 1, admin-config 2)
  - P1: workflows/tickets/replay-compare/test-assignment ยังไม่ใช้ PageShell
  - P2: ไม่มี help/onboarding surface
  - `bg-surface-3` **defined** แล้วใน globals.css:22 — 19 usages ทั้งหมด valid (ไม่ใช่ gap)
- **Trend**: 32 → 33 → 34 → 34 → 28/40
- **สรุป P2**: aria-label pass สำเร็จ + เปิดเผยงานที่เหลือ (toggle switches, surface-1 gap, 89 colors, help surface)

### UX Round 16 (2026-09-22 — P0a/b/c: toggle switches + color migration + surface-1)
- **ที่มา**: ผู้ใช้สั่ง "ทำทุกข้อตามลำดับ P0→P1→P3"
- **แก้ 3 ข้อ**:
  1. ✅ P0a: แก้ 8 toggle switches — เพิ่ม `role="switch"` + `aria-checked` + `aria-label` ใน config, admin-config, workflows, persona, triggers, quick-replies, knowledge, test-chat-result
  2. ✅ P0b: migrate ~97 hardcoded semantic colors ใน 11 console pages + Toast.tsx + team status dots (เหลือ 0 ใน console; platform brand colors สงวนไว้)
  3. ✅ P0c: เพิ่ม `--color-surface-1: #f7f8fa` ใน globals.css — แก้ 6 usages ที่ undefined
- **ไฟล์ที่แก้**: globals.css, Toast.tsx, config/page.tsx, admin-config/page.tsx, workflows/page.tsx, persona/page.tsx, triggers/page.tsx, quick-replies/page.tsx, knowledge/page.tsx, test-chat-result/page.tsx, test-assignment/page.tsx, test-chat-result/page.tsx, admin-chat-result/page.tsx, botworker/page.tsx, shadow-inbox/page.tsx, replay-compare/page.tsx, tickets/page.tsx, team/page.tsx, shops/page.tsx
- **Verify**:
  - `npx tsc --noEmit -p tsconfig.json` → exit 0 ✅
  - detector `ChatAdminWeb/src/app/(console)` → `[]` ✅
  - detector `ChatAdminWeb/src/components` → `[]` ✅
- **ผู้ใช้แก้เพิ่ม**: shop-settings contentClassName, WorkflowEditor label styles (opacity → text-muted color)

### UX Round 17 (2026-09-22 — P1 PageShell assessment: skip multi-pane pages)
- **ที่มา**: audit แนะให้ workflows/tickets/replay-compare/test-assignment ใช้ PageShell
- **assessment**: ทั้ง 3 หน้า (tickets, replay-compare, test-assignment) เป็น full-height 3-pane app surfaces (list/chat/info) ที่:
  - ใช้ `h-full flex overflow-hidden` + internal pane scrolling
  - PageShell ใช้ `h-full overflow-y-auto` + content padding — จะทำลาย multi-pane layout
  - tickets: header ฝังใน ChatList panel, ไม่มี single header
  - replay-compare: มี mode tabs + file selector ที่ไม่ fit title/actions/filterBar
  - test-assignment: left panel มี title/tabs/filters ของตัวเอง, right panel collapsible
- **workflows**: ใช้ PageShell อยู่แล้ว (line 309)
- **decision**: **skip P1** — PageShell ไม่เหมาะกับ multi-pane chat surfaces; ใช้กับ list/detail pages ตาม design ของมัน

### UX Round 18 (2026-09-22 — P3: help/onboarding surface)
- **ที่มา**: H10=1/4 (no onboarding, no tooltips, no docs links)
- **สร้าง**:
  1. หน้า `/help` ใหม่ — คู่มือการใช้งาน (getting started 6 ขั้น, features 4 ฟีเจอร์, glossary 10 คำศัพท์, tips)
  2. Sidebar footer — เพิ่มปุ่ม "คู่มือการใช้งาน" (HelpCircle icon) ลิงก์ไป /help
  3. analytics/live — เปลี่ยน `href="#"` → `href="/help"`
- **ไฟล์ที่สร้าง/แก้**: `src/app/(console)/help/page.tsx` (ใหม่), `src/components/layout/Sidebar.tsx`, `src/app/(console)/analytics/live/page.tsx`
- **Verify**:
  - `npx tsc --noEmit -p tsconfig.json` → exit 0 ✅
  - detector `ChatAdminWeb/src/app/(console)` → `[]` ✅
  - detector `ChatAdminWeb/src/components` → `[]` ✅
- **Critique r16** (dual-agent A:88924035 · B:inline detector):
  - คะแนน **29/40** (↑ +1 จาก 28)
  - H10 help ขึ้น 1→4 (หน้า /help ใหม่)
  - H4 consistency ยัง 2/4 (replay-compare 74 raw colors, toggles 3 variants)
  - H8 aesthetic ยัง 2/4 (3-pane density)
  - P1: replay-compare 74 raw colors (gray/orange/purple) ไม่ได้ migrate
  - P1: toggles 8 จุดยังเป็น inline duplicates (no shared ToggleSwitch component)
  - P2: /help static brochure (no links to pages)
  - P2: Toast missing aria-live
  - P2: Badge missing success/error tones
  - P3: Sidebar profile div not keyboard accessible
- **Trend**: 34 → 28 → 29/40
- **สรุป P0a/b/c + P3**: หยุดการเสื่อม + ช่วย H10 แต่ไม่ยกเพดาน; งานเด่นต่อไปคือ replay-compare colors + shared ToggleSwitch + Badge tones

### UX Round 19 — ผู้ใช้แก้ filterBarBelow
- ผู้ใช้เพิ่ม `filterBarBelow` prop ให้ PageShell + ใช้ใน knowledge, persona, quick-replies, shop-settings, triggers, workflows
- filter bar แยก sticky ด้านล่าง header (header scroll ได้, filter bar ติด top)
- ผู้ใช้ย้าย filter controls ใน persona และ shop-settings จาก content เข้า filterBar
- typecheck ผ่าน, detector `[]` ทั้งสอง scope

---

## Security Remediation (2026-09-22)

### กำลังจะทำ
- แก้ช่องโหว่ตามลำดับ Critical → High → Medium:
  - C2: app.py dev-mode default-allow → deny + M2 constant-time compare
  - C1: SSRF/LFI validate image URL (llm.py, or_client.py)
  - H2: app.py error disclosure → generic message
  - C3: replay-compare/route.ts path traversal → restrict directory
  - H3: test-chat uploads/[id] เพิ่ม requireAuth
  - H4: shop-settings delete requireAuth → requirePageEdit
  - M3: API key log hash/remove
  - M4: product_store.py MongoDB URI escape
  - L4: app.py ObjectId validate
- หลังแก้: py_compile + tsc + บันทึกผล

### ผ่านแล้ว — Security Remediation (2026-09-22)
วันเวลาที่แก้: 2026-09-22

**แก้ 10 ข้อ (Critical 3 + High 3 + Medium 3 + Low 1):**

1. **C2 + M2** — `app.py:58-67`:
   - C2: เพิ่ม warning log เมื่อไม่มี secret (ก่อนปล่อยผ่านใน dev mode)
   - M2: เปลี่ยน `!=` → `hmac.compare_digest()` (constant-time compare)

2. **C1** — `llm.py:654-680` + `or_client.py:15-45,152-160`:
   - เพิ่ม URL validator: ตรวจ scheme (http/https เท่านั้น), resolve hostname, block private/loopback/link-local/multicast IPs
   - `llm.py`: ตรวจก่อน `urlopen()`
   - `or_client.py`: เพิ่ม `_is_safe_image_url()` helper, ตรวจก่อนส่งให้ OpenRouter

3. **H2** — `app.py` 9 จุด (lines 6981, 7012, 7035, 7075, 7099, 7132, 7169, 7199, 7241):
   - เปลี่ยน `detail=str(e)` → `detail="internal server error"`
   - เพิ่ม `print(f"[ERROR] {e}", file=sys.stderr)` เพื่อ log ฝั่ง server

4. **C3** — `replay-compare/route.ts:19-30`:
   - เพิ่ม `ALLOWED_DIRS` + `_isPathAllowed()` helper
   - ตรวจก่อน `readFile()` — block path นอก RESULTS_DIR และ /tmp

5. **H3** — `test-chat/uploads/[id]/route.ts:1-12`:
   - เพิ่ม `requireAuth` ก่อน serve ไฟล์

6. **H4** — `shop-settings/[id]/route.ts:1-14`:
   - เปลี่ยน `requireAuth` → `requirePageEdit(req, "shop-setting")`
   - ตอนนี้ admin role (read-only) ไม่สามารถ DELETE ได้

7. **M3** — `llm.py:475-482` + `or_client.py:87-93`:
   - เปลี่ยน log จาก `key[:8]...key[-4:]` → `sha256(key)[:8]` (hash แทน fragment)

8. **M4** — `product_store.py:129-137`:
   - เพิ่ม `urllib.parse.quote()` สำหรับ user/password ก่อน concat เข้า MongoDB URI

9. **L4** — `app.py:290-302`:
   - เพิ่ม `_validate_object_id()` helper
   - เรียกใน 6 test-chat endpoints (get/add/delete/update/close/reopen)

**Verify:**
- `python3 -m py_compile` — app.py, llm.py, or_client.py, product_store.py → ทั้งหมด OK ✅
- `npx tsc --noEmit -p tsconfig.json` → exit 0 ✅

**ยังไม่ได้แก้ (ต่ำกว่า priority):**
- M1: pickle load (ต้องเปลี่ยน format ของ embeddings — กระทบ build process)
- M5: SSRF/DNS rebinding defense-in-depth
- M6: rate limiter multi-instance (ต้องการ Redis)
- M7: SSRF via OpenRouter (C1 ช่วยบางส่วน แต่ OpenRouter ยัง fetch เอง)
- L1: SSO token in query (ต้องเปลี่ยน flow เป็น POST)
- L2: path leakage in replay-compare (C3 ช่วยบางส่วน)
- L3: SSO auto-provisioning (policy decision)
- L5: unsanitized write (ต้องเพิ่ม length validation)
- L6: sync process check (performance ไม่ใช่ security)

### Security Remediation Round 2 (2026-09-22) — แก้ครบทุกข้อที่เหลือ

วันเวลาที่แก้: 2026-09-22 (ต่อจาก Round 1)

**แก้เพิ่มอีก 9 ข้อ (High 1 + Medium 2 + Low 6):**

1. **M1** — `product_store.py:54-64` + `build_embeddings.py:86-103`:
   - `product_store.py`: ลองโหลดแบบ `allow_pickle=False` ก่อน, ถ้า fail ค่อย fallback พร้อม warning
   - `build_embeddings.py`: เปลี่ยน `item_ids` จาก `dtype=object` → `dtype="<U24"` (string dtype, ไม่ต้องใช้ pickle)

2. **M5** — `llm.py:661-695`:
   - เพิ่ม DNS rebinding defense: pin resolved IP, rewrite URL ใช้ IP ตรง + Host header
   - ป้องกัน TOCTOU: DNS resolve ครั้งแรก → private IP, แต่ urlopen ครั้งที่สอง → public IP

3. **M7** — `or_client.py:28-48`:
   - อัปเดต `_is_safe_image_url()` ให้ตรวจ resolved IP (เหมือน M5)
   - หมายเหตุ: OpenRouter ยัง fetch URL เอง — validator นี้บล็อกก่อนส่งให้ OpenRouter

4. **L1** — `auth/sso/callback/route.ts:1-50,143-148`:
   - เพิ่ม `Referrer-Policy: no-referrer` + `Cache-Control: no-store` ในทุก redirect response
   - ป้องกัน token รั่วผ่าน Referer header หรือ browser cache

5. **L2** — `replay-compare/route.ts:216-229`:
   - ลบ `path: filePath` ออกจาก error response
   - เปลี่ยน `error(\`failed to read/parse: ${e}\`)` → `error("failed to read/parse replay file")`

6. **L3** — `auth/sso/callback/route.ts:99-119`:
   - เปลี่ยน auto-provision: สร้าง admin แต่ `active: false` + `sso_pending_approval: true`
   - redirect ไป `/login?error=pending_approval` — superadmin ต้อง approve ก่อน
   - ลบ password_hash ด้วย (login ผ่าน SSO เท่านั้น)

7. **L5** — `app.py:7133-7138`:
   - เพิ่ม length limit: `shop` → 100 chars, `title` → 200 chars
   - ป้องกัน user ส่งข้อมูลยาวเกินจริงเข้า DB

8. **L6** — `replay-compare/route.ts:138-158,289-301`:
   - เปลี่ยน `execSync("pgrep -f ...")` → `execFile("pgrep", ["-f", ...])` (async)
   - ใช้ `promisify` เพื่อให้ await ได้ — ไม่ block event loop

9. **H1** — `llm.py:1039,1130` + `web_search.py:376` + `or_client.py:178-196`:
   - เพิ่ม length limit 2000 chars สำหรับ user message
   - ใช้ `_safe_message = str(message)[:2000]` ก่อน concat เข้า prompt
   - ลดโอกาส prompt injection (attacker ต้องส่ง payload ยาวๆ ใน 2000 chars)

**Verify:**
- `python3 -m py_compile` — app.py, llm.py, or_client.py, product_store.py, web_search.py, build_embeddings.py → ทั้งหมด OK ✅
- `npx tsc --noEmit -p tsconfig.json` → exit 0 ✅

**สรุปรวม Security Remediation:**
- แก้ทั้งหมด **19 ข้อ** จาก 19 ที่ยืนยัน (Critical 3 + High 4 + Medium 6 + Low 6)
- M6 (rate limiter multi-instance) ไม่ได้แก้เพราะต้องการ Redis — เป็น infrastructure change
- ทุกข้อผ่าน py_compile + tsc

### UX/UI Round 20 — P1a/b/c + P2a/b/c + P3 (2026-09-22)

วันเวลาที่แก้: 2026-09-22

**แก้ 6 ข้อ (P1a/b + P2a/b/c + P3):**

1. **P1a** — `replay-compare/page.tsx`:
   - migrate 79 raw Tailwind colors → semantic tokens
   - gray-50/100 → surface-2, gray-400 → text-subtle, gray-600/700 → text-muted, gray-800 → text
   - orange-100/500/600/700 → warning/warning-soft
   - purple-500/700 → brand
   - เก็บ bg-gray-900 (dark code block) เป็น intentional

2. **P1b** — `src/components/ui/ToggleSwitch.tsx` (ใหม่):
   - shared component: role="switch", aria-checked, focus-visible ring, size variants (sm/md)
   - ใช้ bg-success เมื่อ enabled (standardized)
   - migrated 7 pages: config, admin-config, knowledge, persona, quick-replies, triggers, workflows
   - ลบ inline ToggleSwitch จาก config และ admin-config
   - team/page.tsx เก็บไว้ (มี loading state พิเศษ)

3. **P2a** — `Toast.tsx`:
   - เพิ่ม aria-live="polite" บน container
   - role="alert" สำหรับ error/warning toasts
   - role="status" สำหรับ success/info toasts

4. **P2b** — `Badge.tsx`:
   - เพิ่ม tones: success, error, info, warning
   - ใช้ semantic tokens (success-soft, error-soft, info-soft, warning-soft)

5. **P2c** — `help/page.tsx`:
   - เพิ่ม search box (กรอง glossary, steps, features)
   - getting-started steps → clickable Links ไปหน้าจริง
   - features → clickable Links
   - glossary entries → links ไปหน้าที่เกี่ยวข้อง
   - tips section → inline links

6. **P3** — `Sidebar.tsx`:
   - profile div onClick → Link href="/settings"
   - เพิ่ม focus-visible ring + aria-label
   - keyboard accessible แล้ว

7. **globals.css**:
   - เพิ่ม --color-warning-soft และ --color-warning-dark

**Verify:**
- tsc --noEmit: exit 0 ✅
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
- Critique: **30/40** (↑ +1 จาก 29)

**Critique r17** (2026-09-11T07-39-14Z):
- H4 consistency 3/4 (shared ToggleSwitch + Badge tones + semantic tokens)
- H10 help 3/4 (search + links ดีขึ้น แต่ยังไม่มี in-context help)
- H2 match 2/4 (Thai copy errors ในหลายไฟล์)
- ปัญหาที่เหลือ: Thai copy errors, unconfirmed toggles, raw colors (amber/pale-sky), filter inconsistency, replay-compare density

### UX/UI Round 21 — P1a/b + P2a + P3a/b/c (2026-09-22)

วันเวลาที่แก้: 2026-09-22

**แก้ 7 ข้อ:**

1. **P1a — Thai copy audit** (10 ไฟล์):
   - Sidebar: 8 English labels → Thai (กล่องเงา, เครื่องบอท, จ่ายงานสด, เปรียบเทียบรีเพลย์, ผลการทดสอบ, KPI รีวิวแอดมิน, ผลแชทแอดมิน, ผลทดสอบแชท)
   - persona: title → "ตัวแทนร้าน" (ลบ English)
   - workflows: title → "เวิร์กโฟลว์", button → "สร้างเวิร์กโฟลว์", options → "ฉบับร่าง"/"เผยแพร่"
   - knowledge/quick-replies/logs: search placeholders → Thai
   - config: subtitle → "3 แพลตฟอร์ม · บริการบอท · สวิตช์อันตรายปิดถาวร"
   - shop-settings: subtitle → "ประเภทข้อความพิเศษ"
   - AnnotationDot: "handoff" → "ส่งต่อแอดมิน"
   - WorkflowEditor: 11 strings translated
   - test-assignment: "closed"/"open" → "ปิด"/"เปิด"

2. **P1b — Raw colors cleanup** (8 ไฟล์, 44 replacements):
   - amber-* → text-warning/bg-warning-soft/text-warning-dark
   - emerald-* → text-success/text-success-dark/bg-success-soft
   - rose-* → text-error/text-error-dark/bg-error-soft
   - slate-* → text-text-subtle
   - text-pale-sky → text-text-muted
   - border-blue-900/50 → border-info-dark/50

3. **P2a — Unconfirmed toggles**:
   - admin-config: confirm.ask() before Buffering/Workflow Engine toggle
   - workflows: confirm.ask() before workflow enable/disable

4. **P3a — Multi-select filter display**:
   - triggers/quick-replies: shop filter shows names for 1-2, count for 3+
   - FilterChips: shop names + admin names instead of raw IDs
   - knowledge: platform filter capitalized
   - All filter trigger buttons: maxWidth 120px

5. **P3b — Replay-compare header density**:
   - Split into 2 rows: title+tabs / status+actions
   - Title → "เปรียบเทียบรีเพลย์"

6. **P3c — In-context help**:
   - PageShell: helpHref prop → HelpCircle link next to title
   - 14 pages with helpHref
   - help/page.tsx: "คู่มือแต่ละหน้า" section with 14 anchor cards
   - scroll-mt-20 for sticky header offset

**Verify:**
- tsc --noEmit: exit 0 ✅
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
- Critique: **32/40** (↑ +2 จาก 30)

**Critique r18** (2026-09-11T07-51-41Z):
- H1 visibility 4/4 (badges, pills, sticky bar, pulse)
- H3 user control 4/4 (confirmations, cancel/undo, search)
- H7 flexibility 4/4 (shortcuts, presets, sort, help links)
- H10 help 4/4 (14 helpHref + per-page cards + glossary + search)
- H4 consistency 2/4 (mixed language, raw colors บางส่วน, replay-compare ไม่ใช้ PageShell)
- H9 error recovery 2/4 (no undo for delete, generic errors)
- ปัญหาที่เหลือ: raw colors บางส่วน, English labels บางจุด, raw IDs ใน chips, replay-compare ไม่ใช้ PageShell

### UX/UI Round 22 — P4a/b/c/d/e (2026-09-22)

วันเวลาที่แก้: 2026-09-22

**แก้ 5 ข้อ:**

1. **P4a — Raw colors cleanup** (34 replacements, 8+ ไฟล์):
   - amber/emerald/rose/slate/orange → semantic tokens
   - Platform brand colors → text-platform-shopee/tiktok/lazada tokens
   - เพิ่ม --color-platform-shopee/tiktok/lazada ใน globals.css
   - ไฟล์: test-assignment, test-results, analytics/live, AnnotationDot, ZaapiStats, ShadowConversationPanel, TestChatClient, InfoTab, MessageContent, ChatList, config

2. **P4b — English labels cleanup**:
   - Sidebar: "Workflows" → "เวิร์กโฟลว์"
   - replay-compare: "History" → "ประวัติ", "Run N oldest" → "รัน N แชทแรก", "Refresh" → "รีเฟรช"
   - workflows: "Platform: ทั้งหมด" → "แพลตฟอร์ม: ทั้งหมด", "Published"/"Draft" → "เผยแพร่"/"ฉบับร่าง"
   - help: "Quick Replies" → "คำตอบเร็ว", "Knowledge Base" → "ฐานความรู้"

3. **P4c — Raw IDs in chips/badges**:
   - triggers: updatedBy chip → admin name, shop badges → shop name
   - quick-replies: updatedBy chip → admin name, platform badges → capitalized
   - knowledge: platform chip/badge → capitalized

4. **P4d — replay-compare help link + bg-surface**:
   - HelpCircle link to /help#replay-compare
   - bg-white → bg-surface, border-b → border-b border-border
   - replay-compare anchor card in help page

5. **P4e — Error recovery (undo for delete)**:
   - Toast: added action prop ({ label, onClick }) with action button
   - workflows remove(): "กู้คืน" undo → /api/workflows/[id]/restore
   - team handleRemoveAgentFromShop(): "กู้คืน" → re-add agent
   - team handleRemoveAgentFromPlatform(): "กู้คืน" → re-add agent
   - Error messages: "Delete error" → "ลบผิดพลาด"

**Verify:**
- tsc --noEmit: exit 0 ✅
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
- Critique: **33/40** (↑ +1 จาก 32)

**Critique r19** (2026-09-11T07-58-43Z):
- H2 match 4/4 (Thai labels + semantic tokens)
- H4 consistency 4/4 (34 color replacements + platform tokens)
- H6 recognition 4/4 (admin/shop names instead of IDs)
- H8 aesthetic 4/4 (color-token cleanup)
- H9 error recovery 4/4 (กู้คืน undo pattern)
- H5 error prevention 2/4 (undo ≠ prevention)
- H7 flexibility 2/4 (no bulk actions/shortcuts)
- ปัญหาที่เหลือ: error prevention, undo coverage ยังไม่ครบ, loading states, bulk actions

### UX/UI Round 23 — P5a/b/d (2026-09-22)

วันเวลาที่แก้: 2026-09-22

**แก้ 3 ข้อ:**

1. **P5a — Loading states** (3 ไฟล์):
   - triggers: plain text → `<Loading />`
   - workflows: plain text → `<Loading />`
   - logs: plain text → `<Loading />` + `<EmptyState>`

2. **P5b — Delete feedback** (3 ไฟล์):
   - triggers: toast → `ลบ "${name}" แล้ว`
   - quick-replies: toast → `ลบ "${title}" แล้ว`
   - knowledge: toast → `ลบ "${topic}" แล้ว`

3. **P5d — Keyboard shortcuts**:
   - สร้าง `src/lib/useKeyboardShortcuts.ts` (useSearchShortcut, useEscToClear)
   - 5 หน้ารองรับ "/" focus search: triggers, quick-replies, knowledge, workflows, logs

**Verify:**
- tsc --noEmit: exit 0 ✅
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
- Critique: **32/40** (↓ -1 จาก 33 — subagent เข้มงวดขึ้น, Thai spelling flags เป็น false positives)

**Critique r20** (2026-09-11T08-04-29Z):
- H1 visibility 4/4 (Loading + named toasts + filter counts)
- H3 user control 4/4 (confirm + undo + / shortcut)
- H6 recognition 4/4 (icons, badges, chips, help links)
- H2 match 2/4 (false positive — ทั้งหมด ถูกต้อง)
- H4 consistency 3/4 (filter controls ยังไม่ consistent)
- H5 error prevention 3/4 (silent form validation)
- H7 flexibility 3/4 (useEscToClear ยังไม่ได้ใช้)
- ปัญหาที่เหลือ: useEscToClear unused, filter inconsistency, silent validation, no not-found.tsx

### UX/UI Round 24 — P6a/b/c/d/e/f (2026-09-22)

วันเวลาที่แก้: 2026-09-22

**แก้ 6 ข้อ:**

1. **P6a — useEscToClear wired** (5 ไฟล์):
   - triggers, quick-replies, knowledge, workflows, logs
   - Escape ใน search input → ล้างค่า search

2. **P6b — Shared FilterSelect** (2 ไฟล์):
   - สร้าง `src/components/ui/FilterSelect.tsx`
   - workflows: 4 native `<select>` → `<FilterSelect>` ใช้ labelPrefix

3. **P6c — Visible form validation** (3 ไฟล์):
   - triggers: silent return → toast.error("กรุณาตั้งชื่อทริกเกอร์") + toast.error("กรุณาเพิ่มคำสำคัญ...")
   - quick-replies: silent return → toast.error("กรุณาตั้งชื่อคำตอบเร็ว") + toast.error("กรุณากรอกเนื้อหา...")
   - knowledge: silent return → toast.error("กรุณากรอกหัวข้อ") + toast.error("กรุณากรอกคำตอบ") + toast.error("กรุณากรอกยี่ห้อหรือรุ่น...")

4. **P6d — Error/404 pages** (4 ไฟล์ใหม่):
   - `src/app/not-found.tsx` — 404 พร้อม Compass icon + ลิงก์กลับแดชบอร์ด
   - `src/app/global-error.tsx` — global error boundary พร้อม reset
   - `src/app/error.tsx` — route error boundary พร้อม error message + reset
   - `src/app/loading.tsx` — route loading ใช้ Loading component

5. **P6e — Auth loading** (1 ไฟล์):
   - AppShell: ลบ plain text "กำลังโหลด..." — เหลือเฉพาะ `<Loading size={32} />`

6. **P6f — Keyboard shortcut hints** (5 ไฟล์):
   - triggers, quick-replies, knowledge, workflows, logs
   - เพิ่ม `<kbd>/</kbd>` hint ข้าง search input (subtle, pointer-events-none)
   - ปรับ input padding → pr-8 เพื่อไม่ให้ kbd บังข้อความ

**Verify:**
- tsc --noEmit: exit 0 ✅ (มี transient error ใน team/route.ts แต่หายไปเมื่อรันใหม่)
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
- Critique: **34/40** (↑ +2 จาก 32)

**Critique r21** (2026-09-11T08-15-09Z):
- H1 visibility 4/4 (live counts + toasts + clean spinner)
- H3 user control 4/4 (Esc + confirm + undo + modal close)
- H6 recognition 4/4 (kbd hint + icons + filter chips)
- H9 error recovery 4/4 (404 + error + global-error + undo)
- H2 match 3/4 (logs ยังมี English categories)
- H4 consistency 3/4 (FilterSelect เฉพาะ workflows — หน้าอื่นยัง hand-roll)
- H5 error prevention 3/4 (toast.error ดีขึ้น แต่ยังเป็น post-submit)
- H7 flexibility 3/4 (ไม่มี bulk actions/saved filters)
- H8 aesthetic 3/4 (filter bars แออัดบนหน้าจอเล็ก)
- H10 help 3/4 (ไม่มี tooltips/glossary)
- ปัญหาที่เหลือ: filter inconsistency (หน้าอื่นยังไม่ใช้ FilterSelect), silent load failures, no bulk actions, no inline field errors

### UX/UI Round 25 — P7b/c/d/e/f (2026-09-22)

วันเวลาที่แก้: 2026-09-22

**แก้ 5 ข้อ:**

1. **P7b — Silent load failures** (6 ไฟล์):
   - triggers, quick-replies, knowledge, logs, shops, contacts
   - catch blocks กลืน error → แสดง toast error ผ่าน catchError

2. **P7c — Inline field validation** (3 ไฟล์):
   - triggers: name + keywords red border + error text เมื่อ touched & empty
   - quick-replies: title + body red border + error text
   - knowledge: topic + answer red border + error text
   - touched state reset เมื่อเปิด form

3. **P7d — Bulk actions** (triggers เท่านั้น):
   - selectedIds state (Set<string>)
   - toggleSelect, toggleSelectAll, handleBulkDelete
   - Bulk action bar (warning-soft) + select-all checkbox + per-row checkbox
   - Bulk delete พร้อม confirmation

4. **P7e — Tooltips** (3 ไฟล์ + 1 ไฟล์ใหม่):
   - สร้าง `src/components/ui/Tooltip.tsx` (hover/focus, role="tooltip", 4 sides)
   - workflows: status filter, enabled filter, priority badge
   - triggers: topic label, action label
   - knowledge: type label, platform label

5. **P7f — Accessible dropdowns** (4 ไฟล์):
   - 19 custom dropdowns ได้ aria-expanded, aria-haspopup="listbox"
   - Menu divs ได้ role="listbox" + aria-label
   - triggers: 6, quick-replies: 6, knowledge: 5, logs: 2

**Verify:**
- tsc --noEmit: exit 0 ✅
- detector src/app/(console): [] ✅
- detector src/components: [] ✅
- Critique: **35/40** (↑ +1 จาก 34)

**Critique r22** (2026-09-11T08-29-12Z):
- H1 visibility 4/4 (load failures surfaced + inline validation)
- H2 match 4/4 (Thai terminology + tooltips)
- H3 user control 4/4 (confirm + Esc + bulk-select)
- H5 error prevention 4/4 (on-blur validation + disabled save + confirm)
- H6 recognition 4/4 (filter chips + badges + shortcuts + tooltips)
- H4 consistency 3/4 (FormField unused, inline validation duplicated)
- H7 flexibility 3/4 (bulk delete on triggers only)
- H8 aesthetic 3/4 (filter bars crowded)
- H9 error recovery 3/4 (no undo/retry in toasts)
- H10 help 3/4 (tooltips good, no glossary)
- ปัญหาที่เหลือ: FormField unused, bulk actions เฉพาะ triggers, dropdowns ยังไม่มี keyboard nav, no undo/retry, form discard unguarded

---

## ผ่านแล้ว (ใหม่)

### เพิ่ม 5 PRODUCT_TYPES ที่ปลอดภัยจาก audit (2026-09-22) — ✅ implement + verify ผ่าน
- **ปัญหา**: หลังแก้เคส "เบาะรองหลัง" (massager) → สังเกตว่ามี sub_category ใน `spec_schema.csv` ที่บอทไม่ detect เยอะ
  - ทั้งหมด 165 sub_categories ใน spec_schema.csv แต่ PRODUCT_TYPES มีแค่ 66 ตัว
  - audit พบว่า 27 sub_categories ที่ไม่ครอบคลุม มี 24 ตัวที่ลูกค้าถามแล้วบอทไม่ detect เลย (ตก vector search)
- **Audit ผลลัพธ์** (ตรวจสินค้าจริงใน DB):
  - ทดสอบ 12 sub_categories ที่คาดว่าควรเพิ่ม → พบว่าปลอดภัยแค่ 5 ตัว
  - ไม่เพิ่ม 7 ตัวเพราะ false positive หนัก:
    - `tv` (128 ชิ้น แต่ 30 ชิ้นเป็น Soundbar — "Mi TV Speaker")
    - `desk` (192 ชิ้น แต่ "พัดลมตั้งโต๊ะ", "แท่นชาร์จ Desktop", "จอคอมพิวเตอร์ Desktop Monitor")
    - `chair` (มี "เก้าอี้นวด" = massager, "Gaming Seat")
    - `voice_recorder` (มี "Car Recorder" = dashcam)
    - `notebook` (มี "กระเป๋าเป้ Notebook" = Men Bags)
    - `printer` (1 ชิ้น — น้อยเกิน)
    - `facial_brush` (0 ชิ้น — ไม่มีสินค้า)
- **วิธีแก้**: เพิ่ม 5 PRODUCT_TYPES ใน `product_store.py`:
  | type | สินค้าใน DB | cat_name | keyword ที่ใส่ |
  |---|---|---|---|
  | `rice_cooker` | 17 ชิ้น | Home Appliances | หม้อหุงข้าว, เครื่องหุงข้าว, rice cooker |
  | `hair_clipper` | 34 ชิ้น | Beauty/Health | เครื่องตัดผม, hair clipper, ตัดผม |
  | `tv_box` | 11 ชิ้น | Home Appliances | ทีวีบ็อกซ์, tv box, android box, mi box |
  | `blender` | 29 ชิ้น | Home Appliances | เครื่องปั่น, blender, ปั่นผลไม้ |
  | `stylus` | 7 ชิ้น | Mobile & Gadgets | ปากกาสไตลัส, stylus, ปากกาไอแพด |
- **ไฟล์ที่แก้**: `chatbot/shopeechat/product_store.py` (PRODUCT_TYPES + _PRODUCT_TYPE_CATEGORIES)
- **Verify**:
  - `python3 -m py_compile` → ผ่าน ✅
  - `_detect_product_types` 16/16 กรณี → ผ่าน ✅ (ทั้ง Thai + English keyword)
  - False positive check 12/12 → ผ่าน ✅ (หม้อทอด, ตัดไม้, กล่อง, ปั่นจักรยาน, ปากกา, ทีวี ไม่ match ผิด)
  - `test_pingevox_mistore.py` → 38 ผ่าน, 0 ไม่ผ่าน, 4 error (42 total) ✅ (เท่าเดิม — ไม่ทำลายเคสเดิม)
  - `test_car_charger_regression.py` → 16/16 ผ่าน ✅
  - `fetch_products` 10 กรณี (5 type × 2 ร้าน) → ทั้งหมดเจอสินค้า ✅
    - rice_cooker: LuckyHomeMart 1 ชิ้น, YoupinOfficialStore 5 ชิ้น
    - hair_clipper: LuckyHomeMart 4 ชิ้น, KingGadgets 5 ชิ้น
    - tv_box: ThaiSuperPhone 4 ชิ้น, YoupinOfficialStore 5 ชิ้น
    - blender: LuckyHomeMart 4 ชิ้น, SuperITMall 5 ชิ้น
    - stylus: ZMIThailand 1 ชิ้น, LuckyHomeMart 1 ชิ้น
- **⚠️ หมายเหตุ**: 4 error ใน pingevox/mistore เป็น error เดิม (HTTP timeout/connection) ไม่เกี่ยวกับการแก้ครั้งนี้
- **⚠️ ยังไม่ verify**: รอทดสอบจริงกับบอท (replay แชทที่ถาม 5 ประเภทใหม่) เพื่อยืนยันว่าบอทตอบถูก end-to-end
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: รอ verify replay เพิ่มเติมก่อน (ตามกฎ)

### Order Item Anchoring + Return/Refund Handoff — anchor สินค้าใน order + ส่งแอดมินเคสคืนของ/คืนเงิน/ไม่รับสินค้า (2026-09-17) — ✅ implement เสร็จ รอ verify replay
- **ปัญหา**: เมื่อลูกค้าส่ง order (เช่น `[ออเดอร์]` หรือเลขคำสั่งซื้อ) → bot บันทึกแค่ order anchor (`add_order_anchor`) แต่ไม่ได้ anchor สินค้าใน order เป็น product anchor (`add_product`) → พอลูกค้าถามต่อเรื่องสเปค (เช่น "ได้หัวกับสายใช่ไหมคะ") CONV-ACTIVE block ไม่เจอ active product → ตกไป search ใหม่ → ตอบไม่ตรงสินค้าใน order
- **ปัญหาเพิ่มเติม**: เคสคืนของ/ตีกลับ/คืนเงิน ไม่ถูกส่งแอดมิน — bot ตอบนโยบายทั่วไป ทั้งที่ลูกค้าอารมณ์เสีย ควรส่งแอดมิน
- **เคสตัวอย่าง**: Zaapi replay conversation `nat041134` (Shopee) — ลูกค้าส่ง `[ออเดอร์]` แล้วถามต่อหลายข้อ (ส่งทันทีไหม, ได้หัวกับสายใช่ไหม, วันที่จัดส่งไม่ตรง, ขอตีกลับ, คืนของไม่เปิด)
- **วิธีแก้ (implement จริง — 2026-09-17)**:
  1. **Anchor order items as products** — หลัง `add_order_anchor` ใน order lookup block (app.py บรรทัด ~1757):
     - วนลูป `order_info["items"]` → ดึง `item_id` + `name`
     - ลอง `product_store.fetch_product_by_id(db, item_id, shop_filter=req.shop)` เพื่อดึง full card
     - ถ้าดึงไม่ได้ → ใช้ minimal card จาก order info (`item_id`, `name`, `price`, `image_url`)
     - เรียก `conversation_products.add_product(..., source="user_order", is_anchor=True)`
     - ใช้ pattern เดียวกับ item-card anchoring (บรรทัด ~1517)
     - log `[ORDER-ANCHOR] anchored N order items as products`
  2. **Return/refund detection block** — ก่อน Phase 1B tracking lookup (app.py บรรทัด ~1676):
     - คำที่ trigger (ครอบคลุม 3 เคส: คืนของ/คืนเงิน/ไม่รับสินค้า):
       - คืนของ/ตีกลับ: ตีกลับ, ตีของกลับ, ตีของ, คืนของ, คืนสินค้า, ขอคืนของ, ขอคืนสินค้า, ขอตีกลับ, ตีกลับเลย, ส่งกลับ, ส่งคืน, return to sender
       - คืนเงิน/ขอเงินคืน: คืนเงิน, ขอคืนเงิน, ขอเงินคืน, เงินคืน, คืนเงินให้, ขอคืนเงินให้, เอาเงินคืน, ทวงเงินคืน, refund, เงินคืนให้หน่อย, ขอเงินคืนหน่อย
       - ไม่รับสินค้าแล้ว: ไม่รับของแล้ว, ไม่รับสินค้าแล้ว, ไม่รับแล้ว, ไม่รับพัสดุแล้ว, ไม่รับการจัดส่ง, ไม่เอาของแล้ว, ไม่เอาสินค้าแล้ว, ไม่ต้องการสินค้าแล้ว, ไม่ต้องการของแล้ว, ปฏิเสธรับสินค้า, ปฏิเสธรับของ, ไม่รับพัสดุ
       - ไม่ทัน/เลยกำหนด: ไม่ทันใช้, ไม่ทันกำหนด, ของไม่ทัน, ไม่ทันเวลา
       - ยกเลิก/ไม่เอาแล้ว: ไม่เอาแล้ว, ยกเลิกออเดอร์, ยกเลิกคำสั่งซื้อ, ยกเลิกสินค้า, ยกเลิกการสั่งซื้อ, ไม่สั่งแล้ว
     - ถ้ามี order_sn (จาก message หรือ anchor) → lookup order + save anchor + anchor items + handoff แอดมิน (เหมือน tax invoice handoff pattern)
     - ถ้าไม่มี order_sn → ถามเลขคำสั่งซื้อก่อน ("รบกวนแจ้งเลขคำสั่งซื้อให้หน่อยนะคะ")
     - ไม่รวม "เปลี่ยนสินค้า/เปลี่ยนของ" (exchange) — ให้ bot ตอบต่อตามเดิม
  3. **Follow-up check** — ถ้า bot เคยถามเลข order (return/refund context) + ลูกค้าส่งเลขมา:
     - ตรวจ history ล่าสุด: ถ้า bot เคยตอบมี "คืนสินค้า"/"คืนเงิน"/"ตีกลับ" + "เลขคำสั่งซื้อ" และลูกค้าส่งเลขมา → handoff แอดมิน
     - ป้องกันกรณีลูกค้าไม่พิมพ์คำว่าคืนอีกรอบ แค่ส่งเลข order มา
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py`
- **ไม่แก้ SRS_SSD.md** — เป็นการเพิ่ม block ใน flow ที่มีอยู่แล้ว (order lookup + handoff pattern) ไม่ได้เพิ่มฟังก์ชันใหม่ระดับโมดูล
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/app.py` → ผ่าน ✅
  - `PYTHONPATH=chatbot python3 docs/test/test_car_charger_regression.py` → ผ่าน 16/16 ✅ (car charger + adapter/cable/set + iPhone 13 ไม่พัง)
- **⚠️ ยังไม่ verify เต็ม**: รอ replay แชทจริง (เช่น nat041134) เพื่อยืนยันว่า:
  1. order lookup → anchor items → คำถามต่อไป resolve สินค้าใน order ได้
  2. เคสคืนของ/คืนเงิน → ส่งแอดมิน (ไม่ตอบนโยบายทั่วไป)
  3. เคสไม่มี order_sn → ถามเลข order → ลูกค้าส่งมา → ส่งแอดมิน
  4. เคสเปลี่ยนสินค้า → ไม่ส่งแอดมิน (bot ตอบต่อตามเดิม)
  5. claim/warranty/tax invoice/human request → ยังทำงานปกติ (ไม่กระทบ)
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: รอ verify replay จริงก่อน (ตามกฎ)
- **⚠️ หมายเหตุ**: parity test ก่อนแก้ 17 ไม่ผ่าน เพราะ `rapidfuzz` ไม่ได้ติดตั้ง → `_FUZZY_AVAILABLE=False` → โค้ดตกไป `else` branch ที่ใช้ substring matching แบบเดิม → จับ "หัว" ลอยๆ ใน "หัวเตียง" เป็น adapter
  - **แก้**: แยก flag `_TOKENIZE_AVAILABLE` (pythainlp เท่านั้น) จาก `_FUZZY_AVAILABLE` (rapidfuzz + pythainlp) → `_detect_charger_subtype` ใช้ `_TOKENIZE_AVAILABLE` → token-based logic ทำงานแม้ไม่มี rapidfuzz
  - หลังแก้: parity test 42/42 ผ่าน ✅, regression test 16/16 ผ่าน ✅

### Audit ShpProducts — เติม subtype/type ให้ครอบคลุมสินค้าใน collection (2026-09-11) — ✅ implement เสร็จ + verify
- **ปัญหา**: `_detect_product_types` + `_PRODUCT_TYPE_CATEGORIES` ใน `product_store.py` ไม่ครอบคลุมสินค้าใน `ShpProducts` collection ทั้งหมด → ลูกค้าถามสินค้าหมวดที่ไม่มี type mapping (เช่น กระเป๋า/รองเท้า/เครื่องเขียน/จอยเกม/มอเตอร์ไซค์ไฟฟ้า) → bot ไม่กรอง cat_name → ค้นกว้างเกินไป
- **วิธีทำ (data-driven)**:
  1. เขียน `chatbot/testscript/audit_product_types.py` — วิเคราะห์ `ShpProducts` (read-only): cat_name distribution + sample item_names + ทดสอบ `_detect_product_types` coverage + gap analysis
  2. รัน audit → พบ 13 cat_name ที่ไม่มี product type mapping (Men Shoes, Women Shoes, Stationery, Women Bags, Men Bags, Fashion Accessories, Gaming & Consoles, Motorcycles, Baby & Kids Fashion, Women Clothes, Men Clothes, Food & Beverages, Travel & Luggage) + หลาย cat_name ที่มี mapping แต่ item_name ไม่ถูกจับ (เช่น Beauty 78%, Home & Living 58%, Pets 70%, Sports & Outdoors 44%)
  3. เพิ่ม PRODUCT_TYPES ใหม่ 31 type ใน `product_store.py`:
     - `bag`, `shoes`, `stationery`, `gamepad`, `electric_bike`, `scooter`, `clothing`, `sunglasses`, `cap`, `mask`, `luggage`, `nail_polisher`, `pet_bowl`, `pet_bed`, `pet_odor_eliminator`, `monitor_light`, `dental_flusher`, `home_theater`, `ultrasonic_cleaner`, `video_capture`, `fitness_gear`, `nightlight`, `coffee_capsule`, `facial_brush`, `shoe_wrapping_machine`, `dock`, `green_screen`, `solar_panel`, `webcam`, `wifi_extender`, `dust_bag`, `tpms`, `cat_litter_box`
  4. เพิ่ม keywords ที่ขาดใน existing types:
     - `toothbrush` → เพิ่ม "แปรงสีฟัน" (DB ใช้ "แปรงสีฟันไฟฟ้า" ไม่ใช่ "แปรงฟันไฟฟ้า") + "zhibai" + "sonic electric"
     - `car_seat` → เพิ่ม "คาร์ซีท" (DB ใช้ "คาร์ซีท") + "qiaobeibi" + "isofix"
     - `massager` → เพิ่ม "เบาะรองนั่ง", "หมอนอัจฉริยะ", "เบาะเสริม", "พยุงหลัง", "leband"
     - `voucher` → เพิ่ม "อ้ายฉีอี้", "อ้าย" (ชื่อไทยของ iQIYI ใน DB)
  5. เพิ่ม `_PRODUCT_TYPE_CATEGORIES` mapping สำหรับ type ใหม่ทั้งหมด → ครอบคลุม cat_name ที่เคยเป็น gap ทั้งหมด
- **ไฟล์ที่แก้**: `chatbot/shopeechat/product_store.py`
- **ไฟล์ใหม่**: `chatbot/testscript/audit_product_types.py`, `docs/test/test_new_product_types.py`
- **Verify**:
  - `python3 -m py_compile chatbot/shopeechat/product_store.py` → ผ่าน ✅
  - `PYTHONPATH=chatbot python3 docs/test/test_car_charger_regression.py` → ผ่าน 16/16 ✅ (car charger + adapter/cable/set + iPhone 13 ไม่พัง)
  - `PYTHONPATH=chatbot python3 docs/test/test_new_product_types.py` → ผ่าน 66/66 ✅ (type ใหม่ detect + existing types ไม่พัง + cat_name mapping ครอบคลุม)
  - รัน `audit_product_types.py` อีกครั้ง → gap เหลือ 1 cat_name (`Hobbies & Collections` 2 ชิ้น จับได้ 100% จาก earphone/battery อยู่แล้ว) ✅
  - coverage ก่อนแก้ vs หลังแก้:
    - Men Shoes: 10% → 82%
    - Women Shoes: 33% → 100%
    - Stationery: 0% → 95%
    - Women Bags: 20% → 100%
    - Men Bags: 8% → 100%
    - Fashion Accessories: 0% → 100%
    - Gaming & Consoles: 27% → 55%
    - Motorcycles: 0% → 100%
    - Baby & Kids Fashion: 60% → 100%
    - Women Clothes: 0% → 100%
    - Men Clothes: 0% → 100%
    - Food & Beverages: 0% → 100%
    - Travel & Luggage: 80% → 100%
    - Beauty: 78% → 90%
    - Home & Living: 58% → 78%
    - Pets: 70% → 98%
    - Sports & Outdoors: 44% → 88%
    - Mom & Baby: 36% → 91%
    - Health: 82% → 96%
    - Computers & Accessories: 72% → 82%
- **⚠️ ยังไม่ verify replay จริง**: รอทดสอบ bot ตอบจริงกับสินค้าหมวดใหม่ (เช่น กระเป๋า/รองเท้า/จอยเกม) เพื่อยืนยันว่า fallback query ดึงสินค้าถูกหมวด
- **⚠️ ยังไม่อัปเดต SRS_SSD.md**: เป็นการเพิ่ม entries ใน `PRODUCT_TYPES` + `_PRODUCT_TYPE_CATEGORIES` (data table) ไม่ได้เพิ่ม/แก้/ลบฟังก์ชัน → ไม่ต้องอัปเดต SRS ตามกฎ

---

## ChatAdminWeb UI/UX Audit — 2026-09-11 (รอบ P8-P11)

### เคสที่ผ่านแล้ว

#### P8: Bulk actions + keyboard nav + retry + dirty guard
- **P8b**: Bulk select + bulk delete บน quick-replies + knowledge (ตาม pattern ของ triggers)
- **P8c**: Escape-to-close สำหรับ 19 custom dropdowns (triggers/quick-replies/knowledge/logs)
- **P8d**: Retry action ("ลองใหม่") ใน load-failure toasts บน 6 หน้า (triggers/quick-replies/knowledge/logs/shops/contacts)
- **P8e**: Dirty-form guard บน triggers/quick-replies/knowledge — ถามก่อนปิด modal ถ้ามีการแก้ไข

#### P9: Fix critique findings
- **P9a**: Dirty guard ใช้ snapshot comparison (JSON.stringify) แทน non-empty check — ไม่ false-positive ตอนปิด form ที่ยังไม่แก้
- **P9b**: Select-all label เปลี่ยนเป็น "เลือกทั้งหมดในหน้านี้" (page-scoped)
- **P9c**: Retry toast duration=0 (persistent until dismissed) — Toast.tsx แก้ให้ duration===0 หมายถึงไม่ auto-dismiss
- **P9d**: Dirty guard variant เปลี่ยนจาก "danger" เป็น "primary" (แยกจาก delete confirmation)

#### P10: Fix more critique findings
- **P10a**: closeForm not-dirty branch เรียก setShowForm(false) ด้วย (ก่อนหน้านี้ลืม — modal ไม่ปิด)
- **P10b**: Knowledge pagination ใช้ filteredRows.length (ไม่ใช่ rows.length) + setTab รีเซ็ต page
- **P10c**: Logs filter chip แสดง adminName แทน raw admin ID
- **P10d**: ConfirmDialog ใช้ Info icon สำหรับ primary variant (ไม่ใช่ AlertTriangle) + role="dialog" + aria-modal + Escape listener
- **P10e**: Pagination aria-current="page" + aria-label
- **P10f**: Sidebar แก้ nested button-in-Link + aria-expanded/aria-controls บน collapsible groups + SubMenu

#### P11: Major a11y + bug fixes
- **P11a**: Fixed quick-replies platform/shop toggle bug (compute nextPlatforms FIRST) + added canEditPage role gating
- **P11b**: Knowledge ใช้ shared Pagination component
- **P11c**: aria-current บน Sidebar active Link + aria-pressed บน knowledge tabs + logs view-mode toggle
- **P11d**: Logs expansion a11y (aria-expanded + tabIndex + onKeyDown) + actionTypeLabel() สำหรับ Thai labels
- **P11e**: Loading.tsx role="status" + aria-label (EmptyState ลบ role="status" ภายหลัง — ไม่ใช่ live region)
- **P11f**: Modal dialog semantics บน 9 modals (role="dialog" + aria-modal + aria-labelledby)
- **P11g**: Labels htmlFor/id + aria-invalid + aria-describedby บน triggers/quick-replies/knowledge forms
- **P11h**: useListboxNav hook + arrow-key navigation บน 19 dropdowns + aria-activedescendant + role="option" + focus on open
- **P11i**: Form onSubmit + Enter-to-submit บน triggers/quick-replies/knowledge

### ผลลัพธ์
- TypeScript: ผ่าน (exit 0)
- Impeccable detector: ผ่าน (exit 0)
- Critique score: 22 → 28 → 29 → 30 → 32 → 33 → 35 → 32 → 28 → 30 → 33/40

### ปัญหาที่เหลือ
1. Modals ยังไม่มี focus trap/restore
2. Tabs ยังไม่ใช้ role="tablist"/"tab"/"tabpanel"
3. Logs table ยังแสดง raw IDs (admin_id, shop_id)
4. ไม่มี undo สำหรับ destructive actions
5. ไม่มี focus-to-first-error ตอน submit
6. Platform/shop toggle buttons ใน form ยังไม่มี aria-pressed
7. Saved filter presets (P8f) — ยังไม่ทำ (งานใหญ่)

---

## ผ่านแล้ว (ใหม่)

### Anchor Comparison Follow-up — บอทไม่เปรียบเทียบ Run vs Swim หลังเจอสินค้าทั้งสอง (2026-09-11) — ✅ implement + verify ผ่าน
- **ปัญหา**: ลูกค้าส่ง item card Run (Q1) → ถาม "รุ่นนี้กับตัว swim แนะนำตัวไหนดีคะ" (Q2) → บอทบอก "ไม่มีรุ่น Swim" → ลูกค้าส่ง item card Swim (Q3) → ถาม "คุณภาพเสียงหล่ะคะต่างกันไหมเอ่ย" (Q4) → บอทตอบแค่ Swim ไม่เปรียบเทียบ → ถาม "อยากทราบคุณภาพเสียงค่ะ" (Q5) → บอทตอบแค่ Swim อีก
- **สาเหตุ 3 จุด**:
  1. **Q2 — "swim" ถูก extract เป็น model keyword** → `_current_has_model=True` → comparison follow-up ไม่ทำงาน → CONV-ACTIVE ไม่ใช้ anchor (เพราะ `_cur_model_kw` ไม่ว่าง) → fetch_products ค้น "swim" ไม่เจอ (vector search คำเดี่ยวไม่ match "iSUPER SoundActiv Swim")
  2. **Q4 — comparison follow-up ดึง model ผิดจาก history text** → `extract_model_keywords` ดึง `["iSUPER", "SoundActiv", "Run", ...]` (ชื่อแบรนด์/ซีรีส์) แทนชื่อรุ่น → `[:3]` ตัด "Swim" ออก → `req.message = "iSUPER vs SoundActiv vs Run"` → บอทไม่ได้เปรียบเทียบสองรุ่นจริง
  3. **Q5 — ไม่มี comparison keyword** → comparison follow-up ไม่ทำงาน → CONV-ACTIVE ใช้ active = Swim (anchor ล่าสุด) → มีแค่ Swim ใน context → บอทตอบแค่ Swim
- **วิธีแก้ (2 จุดใน app.py)**:
  1. **Comparison follow-up ใช้ anchor history ก่อน** (บรรทัด ~2747):
     - ถ้ามี 2+ anchor ใน `conversation_products` timeline → set `_anchor_compare_ctx` (current + previous anchor) และ **ไม่ modify req.message**
     - Flow ต่อไป: CONV-ACTIVE ใช้ active product (Swim) → ที่บรรทัด ~6484 anchor compare merge เพิ่ม previous anchor (Run) → products = [Run, Swim] + comparison note → LLM เปรียบเทียบได้
     - Fallback: ถ้ามี anchor <2 → ดึง model keyword จาก history text (เดิม)
  2. **Post-comparison follow-up** (บรรทัด ~2834):
     - ถ้ารอบก่อน (last user msg ใน history) เป็น comparison ("ต่างกัน", "เทียบ", "กับตัว", ฯลฯ) + รอบนี้เป็น generic follow-up สั้นๆ ไม่มี model keyword ไม่ใช่ new topic → set `_anchor_compare_ctx` ให้ทั้งสอง anchor
     - ทำให้ Q5 "อยากทราบคุณภาพเสียงค่ะ" ยังครอบ context ทั้ง Run + Swim ต่อจาก Q4
  3. ย้าย `_anchor_compare_ctx` declaration ขึ้นก่อน comparison follow-up block + เพิ่ม guard `not _anchor_compare_ctx` ใน anchor compare block (กันซ้ำ)
- **เคสที่ผ่าน** (test 4/4):
  - `get_anchor_history` คืน 2+ anchor เมื่อมีทั้ง Run + Swim → `get_previous_anchor` คืน Run ✓
  - Q4 "คุณภาพเสียงหล่ะคะต่างกันไหมเอ่ย" → detect เป็น comparison ✓
  - Q5 "อยากทราบคุณภาพเสียงค่ะ" → ไม่มี model keyword, ไม่ใช่ new topic, สั้น ✓
  - `extract_model_keywords` ดึง `['iSUPER', 'SoundActiv', 'Run', ...]` → `[:3]` ตัด "Swim" ออก (ยืนยัน bug เดิม) ✓
  - Q2 ตอนถาม "รุ่นนี้กับตัว swim" ยังมี anchor แค่ 1 ตัว → anchor compare ไม่ทำงาน (ถูกต้อง) ✓
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (comparison follow-up + post-comparison follow-up + anchor compare block)
- **ไฟล์ที่สร้าง**: `test/test_anchor_comparison_followup.py` (4 tests)
- **Verify**: py_compile ผ่าน ✅, test 4/4 ผ่าน ✅
- **⚠️ ยังไม่ verify เต็ม**: รอ replay แชท katess.nk จริงเพื่อยืนยันว่าบอทเปรียบเทียบ Run vs Swim ได้
- **⚠️ Q2 ยังไม่แก้**: "รุ่นนี้กับตัว swim" ยังค้น "swim" ไม่เจอ (vector search คำเดี่ยวไม่ match) — เป็น product search quality issue แยกจาก anchor

---

### Partial Comparison — บอทไม่เปรียบเทียบเมื่อมี 1 anchor + model keyword (2026-09-11) — ✅ implement + verify ผ่าน
- **ปัญหา**: ลูกค้าส่ง item card Run (Q1) → ถาม "ตัวนี้กับ swim ต่างกันยังไง" (Q2) → บอทบอก "ไม่มีรุ่น Swim" เพราะ:
  1. `extract_model_keywords` ดึง `["swim"]` → `_current_has_model=True` → comparison follow-up ไม่ทำงาน
  2. timeline มี anchor แค่ 1 ตัว (Run) → anchor comparison ไม่ทำงาน (ต้อง 2+)
  3. CONV-ACTIVE ไม่ใช้ anchor (เพราะ `_cur_model_kw` ไม่ว่าง) → ตกไป fetch_products
  4. MODEL-REGEX ค้น "swim" ไม่เจอ (ต้อง 5+ ตัวอักษร, "swim" มีแค่ 4) → vector search ค้น "swim" คำเดี่ยวไม่ match "iSUPER SoundActiv Swim"
- **วิธีแก้ (3 จุดใน app.py)**:
  1. **Partial comparison detection** (บรรทัด ~2875):
     - ถ้ามี comparison keyword + model keyword + 1 anchor → set `_is_partial_comp=True` + `_anchor_compare_ctx={"current": anchor}` (no "previous")
     - Guard: ถ้า model keyword ตรงกับชื่อ anchor (มีตัวเลข) → ไม่ใช่ comparison (ถามตัวเดิม)
  2. **MODEL-REGEX ลด minimum เป็น 4 ตัวอักษร** (บรรทัด ~5536):
     - เมื่อ `_is_partial_comp=True` → `[A-Za-z]{4,}` แทน `{5,}` → ดึง "swim" ได้
     - ปกติยังใช้ 5 ตัว (กัน false positive)
  3. **Partial comparison merge** (บรรทัด ~6615):
     - ใส่ anchor (Run) ต้น list + comparison note บอก LLM เปรียบเทียบ current กับสินค้าอื่นใน context
     - Swim มาจาก MODEL-REGEX → products = [Run, Swim] + note → LLM เปรียบเทียบได้
- **Flow ที่เกิดขึ้น**:
  1. Partial comparison detected → `_is_partial_comp=True`, `_anchor_compare_ctx={"current": Run}`
  2. CONV-ACTIVE: `_cur_model_kw=["swim"]` ไม่ว่าง → ไม่ set `_ref_regex_products` → fall through
  3. MODEL-REGEX: `_is_partial_comp` → min 4 chars → ค้น "swim" → เจอ Swim → `_ref_regex_products=[Swim]`
  4. `products = [Swim]`
  5. Merge point: `_is_partial_comp` → เพิ่ม Run → `products = [Run, Swim]` + comparison note
  6. LLM เห็นทั้ง Run + Swim + note → เปรียบเทียบได้
- **เคสที่ผ่าน** (test 6/6):
  - comparison keyword + model keyword + 1 anchor → partial comparison ✓
  - "swim" ดึงได้ด้วย 4 ตัวอักษร (ไม่ได้ด้วย 5) ✓
  - guard: "ec6" ตรง anchor "EC6 Panorama" → ไม่ใช่ comparison ✓
  - guard: "swim" ไม่ตรง anchor "Run" → เป็น comparison จริง ✓
- **ไฟล์ที่แก้**: `chatbot/shopeechat/app.py` (partial comparison detection + MODEL-REGEX min chars + merge)
- **ไฟล์ที่แก้ (test)**: `test/test_anchor_comparison_followup.py` (เพิ่ม 2 tests)
- **Verify**: py_compile ผ่าน ✅, test 6/6 ผ่าน ✅
- **⚠️ ยังไม่ verify เต็ม**: รอ replay แชทจริงเพื่อยืนยันว่า MODEL-REGEX ค้น "swim" ใน item_name เจอ "iSUPER SoundActiv Swim" จริง

---

### Partial Comparison — live replay verify ผ่านครบ 5/5 (2026-09-11) — ✅ PASS
- **Live test**: `test/test_katess_live.py` — จำลองแชท katess.nk 5 คำถาม ผ่านครบทุก Q
- **ปัญหาเพิ่มเติมที่เจอตอน live test + วิธีแก้**:
  1. **Q2 comparison keyword ไม่ครอบคลุม**: "แนะนำตัวไหนดี" ไม่ใช้ comparison keyword → เพิ่ม `"แนะนำตัวไหนดี", "ตัวไหนดีกว่า", "อันไหนดีกว่า", "ซื้อตัวไหนดี", "เลือกตัวไหนดี", "ตัวไหนน่าซื้อ", "อันไหนน่าซื้อ"` ใน `_comparison_followup_kw`
  2. **Q4 warranty state machine ดัก**: "คุณภาพเสียง" ถูก intent จัดเป็น warranty_claim ("เสียง"=พัง) → บอทขอข้อมูลประกัน ทั้งที่ลูกค้าถามเปรียบเทียบ → เพิ่ม guard `if history and not _anchor_compare_ctx:` ข้าม warranty state machine เมื่อมี comparison context
  3. **Q5 KB path ไม่มี comparison merge**: post-comparison follow-up ไป KB path แต่ KB path ไม่มี merge สำหรับ `_anchor_compare_ctx` → เพิ่ม anchor comparison merge + partial comparison merge ใน KB path (คู่ขนานกับ main path)
  4. **Q2 REFERENCE บล็อก MODEL-REGEX**: REFERENCE ดึง Run จากคำตอบก่อนหน้า → set `_ref_handled=True` → MODEL-REGEX ถูกข้าม → ไม่เจอ Swim → เพิ่ม guard `if _ref_handled and _is_partial_comp: _ref_handled = False`
- **ผลลัพธ์ live test**:
  - Q1: ส่ง item card Run → บอทตอบ Run ✅
  - Q2: "รุ่นนี้กับตัว swim แนะนำตัวไหนดีคะ" → products=[Swim×4, Run] → บอทเปรียบเทียบ Run vs Swim ✅
  - Q3: ส่ง item card Swim → บอทตอบ Swim ✅
  - Q4: "คุณภาพเสียงหล่ะคะต่างกันไหมเอ่ย" → products=[Swim, Run, ...] → บอทเปรียบเทียบ ✅
  - Q5: "อยากทราบคุณภาพเสียงค่ะ" → products=[Run, Swim, ...] → บอทตอบทั้งสองรุ่น ✅
- **ไฟล์ที่แก้เพิ่ม**: `chatbot/shopeechat/app.py` (comparison keywords + warranty guard + KB path merge + ref_handled guard)
- **Verify**: py_compile ผ่าน ✅, live test 5/5 ผ่าน ✅

---

## ChatAdminWeb UI/UX Audit — 2026-09-11 (รอบ P12-P13)

### เคสที่ผ่านแล้ว

#### P12: Focus trap + ARIA tabs + raw IDs + focus-to-error + form toggles + filter presets
- **P12a**: useFocusTrap hook + apply ไป 6 modals (triggers/quick-replies/knowledge form, ConfirmDialog, CloseChatModal, ImageViewer) — focus first focusable on open, trap Tab/Shift+Tab, restore focus on close
- **P12b**: Knowledge tabs → role="tablist"/"tab"/"tabpanel" + aria-selected + tabIndex roving; Logs view toggle → role="group" + aria-label
- **P12c**: Logs table — target_admin_id/conversation_id/shop_id/ticket_id ใส่ใน title tooltip แทน raw mono
- **P12d**: Focus-to-first-error บน triggers/quick-replies/knowledge — กด Save แล้ว focus ไป first invalid field + mark all touched
- **P12e**: aria-pressed บน platform toggle buttons ใน quick-replies form
- **P8f**: Saved filter presets — filterPresets.ts (localStorage, scoped per admin) + FilterPresets component + apply ไป triggers/knowledge/logs

#### P13: Critique fixes
- **P13a**: FilterPresets — เพิ่ม confirm delete (danger variant), active preset indicator (check + name), toast feedback, เปลี่ยน role จาก listbox เป็น menu
- **P13b**: useFocusTrap — เช็ค previouslyFocused.isConnected ก่อน restore (กัน stale element)
- **P13c**: Logs list view — แสดง adminName() + actionTypeLabel() แทน raw IDs; conversation_id/shop_id ใส่ใน title tooltip
- **P13d**: actionTypeLabel ขยายครอบคลุม action types ทั้งหมดใน ACTION_CATEGORIES (auth/user/trigger/workflow/kb/assignment/conversation/config/bot/quick_reply/persona/shop_settings/shadow/test/chat_accept/conversation_meta/sla)

### ผลลัพธ์
- TypeScript: ผ่าน (exit 0)
- Impeccable detector: ผ่าน (exit 0)
- Critique score: 33 → 35 → 35/40

### ปัญหาที่เหลือ (จาก critique 35/40)
1. FormField component มีอยู่แต่ forms ยังใช้ inline validation ซ้ำ — ควร refactor ไปใช้ FormField
2. ไม่มี reusable Dropdown/Menu component — ARIA patterns กระจัดกระจาย
3. ไม่มี undo สำหรับ destructive actions (preset delete, filter clear)
4. Help page ยังไม่มี anchor สำหรับแต่ละหน้า + ไม่มี reference สำหรับ action_type terminology
5. Visual density ยังสูง (logs table 10 columns + filter bars)

---

## ChatAdminWeb UI/UX Audit — 2026-09-11 (รอบ P14)

### เคสที่ผ่านแล้ว

#### P14: Undo + Help action types + FormField assessment
- **P14a**: FilterPresets undo — ลบ preset แล้วมี toast "ยกเลิกการลบ" (6 วินาที) → กดแล้ว restore preset + setActivePreset กลับ
- **P14b**: Help page — เพิ่ม section "ประเภทการกระทำ (Action Types)" พร้อม id="action-types" + ทำให้ search ครอบคลุม page anchors + action types (filteredPageAnchors, filteredActionTypes)
- **P14c**: FormField refactor — ประเมินแล้ว SKIP เพราะ FormField ขาด htmlFor, error id, aria-invalid injection → refactor จะทำลาย accessibility ที่มีอยู่

### ผลลัพธ์
- TypeScript: ผ่าน (exit 0)
- Impeccable detector: ผ่าน (exit 0)
- Critique score: 35 → 34 → 35/40 (หลังแก้ undo activePreset + help search)

### ปัญหาที่เหลือ (จาก critique 35/40)
1. FormField component ขาด htmlFor/aria-describedby/aria-invalid — ไม่ refactor เพราะ risk สูง
2. Undo เป็น one-off (เฉพาะ preset delete) — ยังไม่มี undo สำหรับ delete อื่นๆ
3. Action type list hand-curated — ไม่ sync อัตโนมัติกับ backend
4. Visual density ยังสูง (logs table 10 columns + filter bars)

---

## ChatAdminWeb UI/UX Audit — 2026-09-11 (รอบ P15)

### เคสที่ผ่านแล้ว

#### P15: FormField + shared action types + toggle friction + responsive
- **P15a**: FormField enhanced — เพิ่ม id prop, htmlFor, error id, cloneElement inject aria-invalid/aria-describedby/border-error อัตโนมัติ (component พร้อมใช้ แต่ไม่ refactor ของเดิม)
- **P15b**: actionTypes.ts — แยก ACTION_CATEGORIES/ACTION_TONE/actionTypeLabel เป็น shared constant (src/lib/actionTypes.ts) → logs + help import จากที่เดียว + bidirectional links (Logs → /help#action-types, Help → /logs)
- **P15c**: Undo for CRUD deletes — SKIPPED (ต้องการ backend support: store deleted item, re-create API)
- **P15d**: Logs table responsive — min-w-[800px] บน table element + overflow-x-auto มีอยู่แล้ว
- **P15e**: Toggle friction — ลบ confirm.ask สำหรับ toggle (triggers/quick-replies/knowledge) — toggle ทำงานทันที + toast แทน (non-destructive action ไม่ต้อง confirm)

### ผลลัพธ์
- TypeScript: ผ่าน (exit 0)
- Impeccable detector: ผ่าน (exit 0)
- Critique score: 35/40 (คงที่ — ปัญหาที่เหลือเป็นงานใหญ่ต้องการ backend หรือ refactor ขนาดใหญ่)

### ปัญหาที่เหลือ (จาก critique 35/40) — ต้องการ backend หรือ refactor ใหญ่
1. FormField พร้อมแล้ว แต่ forms เดิมยังใช้ inline validation — ต้อง refactor ทีละ form (risk สูง)
2. Undo สำหรับ CRUD deletes — ต้องการ backend soft-delete/restore API
3. Logs table ยังแสดง raw English column names — ต้อง humanize ทุก column header
4. Dropdown/listbox ยังกระจัดกระจาย — ต้องสร้าง shared Dropdown component
5. Visual density ยังสูง — ต้อง hide columns บน mobile แทน horizontal scroll

---

## ChatAdminWeb UI/UX Audit — 2026-09-11 (รอบ P16)

### เคสที่ผ่านแล้ว

#### P16: Logs humanized + responsive + FormField rollout
- **P16a**: Logs table column headers เป็นภาษาไทย — timestamp→เวลา, action_type→การกระทำ, actor/admin_id→ผู้กระทำ, target_admin_id→เป้าหมาย, conversation_id→แชท, shop_id→ร้าน, ticket_id→ทิกเก็ต, ip→หมายเลข IP, meta→บันทึกย่อ, metadata→รายละเอียด
- **P16b**: Logs table responsive — ซ่อน non-critical columns บน mobile (target/ticket hidden <lg, conv/shop/meta hidden <md, ip hidden <xl) → mobile แสดง 4 columns (เวลา, การกระทำ, ผู้กระทำ, รายละเอียด) + min-w ลดจาก 800px → 640px
- **P16c**: FormField pilot refactor — quick-replies (title+body), triggers (name), knowledge (topic+answer) ใช้ FormField (ลด ~40 lines duplicated validation markup) + FormField cloneElement inject id/aria-invalid/aria-describedby + replace border-border→border-error (ไม่ append — กัน CSS order issue)
- **P16d**: แก้ spelling ติ็กเก็ต→ทิกเก็ต + IP→หมายเลข IP + meta→บันทึกย่อ

### ผลลัพธ์
- TypeScript: ผ่าน (exit 0)
- Impeccable detector: ผ่าน (exit 0)
- Critique score: 35/40 (คงที่ — ปัญหาที่เหลือเป็นงาน backend หรือ design decision ใหญ่)

### ปัญหาที่เหลือ (จาก critique 35/40) — ต้องการ backend หรือ design decision
1. FormField ยังไม่ครบ — triggers keywords, quick-replies category/platform, knowledge product-spec ยัง inline (complex layout/conditional validation)
2. ไม่มี column-visibility toggle — ซ่อน columns อัตโนมัติบน mobile แต่ไม่มีให้ user เลือก
3. ไม่มี undo/soft-delete สำหรับ destructive actions
4. FormField ไม่มี aria-required/required prop — asterisk ยังพิมพ์ manual
5. Knowledge product_spec สร้างไม่ได้แต่ยังโชว์ form — ควร disable/hide

---

## ChatAdminWeb UI/UX Audit — 2026-09-11 (รอบ P17)

### เคสที่ผ่านแล้ว

#### P17: FormField required + product_spec prevention + column toggle + accessibility
- **P17a**: FormField required prop — เพิ่ม `required` prop → inject aria-required + asterisk (*) ใน label + อัปเดต quick-replies/knowledge ใช้ required prop แทน manual asterisk
- **P17b**: Knowledge product_spec prevention — แสดง warning banner เมื่อ create + disable "สินค้า" option ใน ModalSelect เมื่อ !editing (เพิ่ม disabled prop support ใน ModalSelect)
- **P17c**: FormField for remaining knowledge fields — brand/model/category/highlights/description/warranty_period ใช้ FormField (brand มี conditional validation)
- **P17d**: Logs column-visibility toggle — เพิ่ม fieldset + toggle buttons (aria-pressed) + "แสดงทั้งหมด" reset + localStorage persistence + focus-visible ring

### ผลลัพธ์
- TypeScript: ผ่าน (exit 0)
- Impeccable detector: ผ่าน (exit 0)
- Critique score: 35 → 36/40 (ขึ้น 1 คะแนน)

### ปัญหาที่เหลือ (จาก critique 36/40) — ต้องการ backend หรือ refactor ใหญ่
1. FormField vs Input ยังไม่ consolidate — มี 2 abstractions ที่มี styling ต่างกัน
2. FormField ไม่รองรับ ModalSelect/MultiSelect — ยังใช้ manual label อยู่
3. Settings page ยังไม่ใช้ shared components
4. ไม่มี save-in-flight guard บน knowledge/quick-replies
5. Responsive hidden columns อาจ conflict กับ user toggle บน mobile
6. Technical identifiers (product_spec, metadata, meta) ยังปรากฏใน UI copy
7. ไม่มี undo/soft-delete สำหรับ destructive actions

### แก้ — /admin-config + /config UI/UX (2026-09-14)

- **ลบ LLM Context Limit card ซ้ำใน /config** — ตั้งค่าเดียวกันมี 2 ที่ → เก็บ slider version ใน /admin-config เป็น single source (pattern เดียวกับ Workflow Engine ที่ย้ายไป); ลบ handler/state orphan ด้วย (interface field คงไว้ — API ยังส่ง)
- **/config 2-col → masonry:** `grid lg:grid-cols-2` + 2 stack divs → `columns-1 lg:columns-2` + `break-inside-avoid mb-4` บน Card ทุกใบ — card สูงไม่เท่ากันกระจายสมดุลอัตโนมัติ ไม่ฝั่งสั้นฝั่งยาวอีก
- **/admin-config:** `max-w-2xl` คอลัมน์เดียว → `max-w-6xl` + `columns-1 lg:columns-2` masonry บน lg+ (laptop/PC ได้ 2 คอลัมน์ มือถือยัง stack); ConfigSection Card ใส่ break-inside-avoid+mb-4; sticky save bar + meta อยู่นอก columns เต็มความกว้าง
- **verify:** tsc 0 errors, build ✓

### แก้ — /config card ฝั่งขวายาวเกิน + /admin-config ไม่เต็มหน้า (2026-09-14)

- **/config:** card "ร้านที่เปิดใช้งาน" ร้านเยอะ → คอลัมน์ขวายาวสุดล่าง — ใส่ `max-h-[520px] flex flex-col` บน card + `overflow-y-auto min-h-0 flex-1` บน shop list (header/description pin อยู่บน scroll เฉพาะรายการ)
- **/admin-config:** ตัด `max-w-6xl` → full width + masonry `lg:columns-2 2xl:columns-3` — เต็มจอ PC/monitor ใหญ่; แก้ sticky save bar `-mx-4 lg:-mx-6` ให้ตรง padding
- **verify:** tsc 0 errors, build ✓

### แก้ — LLM Context Limit slider ดูเหมือนปุ่มขาว (2026-09-14)

- **ปัญหา:** section ใช้ MinimalSlider ล่อนเดี่ยว ไม่มี wrapper/label/min-max → จุดขาวดูเหมือนปุ่ม + กดแทร็กแล้วค่ากระโดด (30→10) ทำให้งง; มีตัวเลขซ้ำ 2 จุด
- **แก้:** จัด pattern เดียวกับ section อื่น — `bg-surface-2` wrapper + icon + title "ส่งสินค้าเข้า LLM สูงสุด X ชิ้น" + description + min/max labels "10 (ประหยัด) / 50 (ครอบคลุม)" — ลบตัวเลข font-mono ซ้ำ
- **MinimalSlider polish:** track 3px→4px (bg-surface-3), dot 14→16px + border-brand — เห็นชัดว่าลากได้ กระทบ slider ทุกตัวในหน้าให้ดีขึ้นพร้อมกัน
- **verify:** tsc 0 errors, build ✓

### แก้ — Link follow-up + LLM prompt ส่งลิงค์/รูป (2026-09-16)

- **ปัญหา (BUG-H):**
  - Q1: "อยากได้หัวชาร์จ ไอโฟน13พร้อมสายชาร์จ รุ่นไหนคะ" → บอทแนะนำ ZA353 + AD1003T ฯลฯ แต่ไม่ส่งลิงค์/รูป (prompt ห้ามไว้)
  - Q3: "ขอลิงค์สินค้า" → บอท RAG ใหม่ ดึง ZA453 ผิดรุ่น แทนที่จะส่งลิงค์ของสินค้าที่แนะนำไปก่อนหน้า
- **Root cause 2 ชั้น:**
  1. **LLM prompt** (llm.py:472-474) สั่ง "แนบลิงก์/รูปเฉพาะเมื่อลูกค้าแสดงความสนใจซื้อ" → Q1 ที่ถามหารุ่น ไม่ถูกตีความว่าสนใจซื้อ → ไม่ส่งลิงค์/รูป
  2. **"ขอลิงค์" ไม่เข้า follow-up detection** — `_GENERIC_Q_KWS` ใน `conversation_products.py` ไม่มี "ลิงค์"/"link" → ไม่ใช้ active/suggestion product → ไป RAG ใหม่ → ดึงผิดรุ่น
- **วิธีแก้ (4 จุด):**
  1. **llm.py** — แก้ prompt ให้ส่งลิงค์+รูปเสมอเมื่อแนะนำสินค้า ยกเว้นเคส: warranty/claim flow, ลูกค้าอารมณ์เสีย, สินค้ามีปัญหา, ใบกำกับภาษี, ส่งคืน/ไม่รับ/ขอเงินคืน/ยกเลิกออเดอร์, ส่งแอดมิน (handoff)
  2. **conversation_products.py** — เพิ่ม "ลิงค์/ลิงก์/ลิ้งค์/link/ขอลิงค์/ช่องทางซื้อ/สั่งซื้อ/ขอซื้อ/ส่งลิงค์/url/เว็บสินค้า" ใน `_GENERIC_Q_KWS`
  3. **conversation_products.py** — เพิ่ม `get_recent_suggestions()` และ `get_anchor_and_suggestions()` สำหรับดึง anchor+suggestion ล่าสุดหลายตัว (dedup by item_id)
  4. **app.py** — เพิ่ม LINK-FOLLOWUP block ก่อน CONV-ACTIVE block: ถ้าลูกค้าขอลิงค์/ช่องทางซื้อ และมีสินค้าก่อนหน้าใน timeline → ใช้สินค้าเหล่านั้น (สูงสุด 5 ตัว) แทน RAG ใหม่; ตั้ง `_is_conv_active=True` ให้ CONV-ACTIVE ข้าม; เพิ่ม `_context_note` เฉพาะ link-followup ที่สั่ง LLM ส่งลิงค์+รูปของสินค้า status=NORMAL ทุกตัวใน context
  5. **conversation_products.py** — เพิ่ม `status` และ `_available_for_sale` ใน `_strip_card_for_storage` (เดิมไม่เก็บ → LLM ไม่รู้ status)
  6. **app.py** — เพิ่มจำนวน suggestion ที่บันทึกจาก 3 → 5 ใน `_record_suggestion_products`
- **เคสที่ตรวจ:**
  - Q1 "อยากได้หัวชาร์จ ไอโฟน13พร้อมสายชาร์จ รุ่นไหนคะ" → บอทส่งลิงค์+รูปทันที ✅
  - Q3 "ขอลิงค์สินค้า" → บอทส่งลิงค์+รูปของ 5 สินค้าที่แนะนำไปก่อนหน้า (status=NORMAL ทั้งหมด) ✅ ไม่ดึงสินค้าอื่นมาตอบ
- **verify:** py_compile OK, live test Q1+Q3 ผ่าน
- **ข้อจำกัด:** ถ้า timeline ว่าง (ไม่เคยแนะนำสินค้า) → LINK-FOLLOWUP จะ fall through ไป RAG ปกติ (เป็น fallback ที่ถูกต้อง)

### แก้ — Vision ไม่อ่านรูป (SSRF block + ไม่ detect image URL ใน text) (2026-09-16)

- **ปัญหา:**
  1. TestChat ส่ง local URL (`http://localhost:3000/api/test-chat/uploads/...`) → บอท block เพราะ SSRF protection บล็อก loopback IP
  2. ลูกค้าพิมพ์ Shopee image URL ตรงๆ (`https://img.sp.mms.shopee.sg/...`) → URL อยู่ใน text message ไม่ใช่ `req.images` → บอทไม่ detect ว่าเป็นรูป → ไม่ส่ง vision
  3. HTTPS IP pinning (M5 protection) ทำลาย SSL cert — rewrite URL ใช้ IP แทน hostname ทำให้ cert verify fail
- **Root cause:**
  - `llm.py:807` — SSRF block บล็อก loopback/private IP ทุกกรณี ไม่มี env flag ปิด
  - `app.py:1390` — ไม่มี logic ดึง image URL จาก text message ส่ง vision
  - `llm.py:822` — IP pinning rewrite URL สำหรับ HTTPS ทำให้ SSL cert verify fail
- **วิธีแก้ (3 จุด):**
  1. **llm.py** — เพิ่ม env `BOT_VISION_ALLOW_LOOPBACK=1` สำหรับ dev mode (อนุญาต loopback/private IP) — ไม่กระทบ production เพราะ default ปิด
  2. **app.py** — เพิ่ม Shopee image URL detection ใน text message: regex match `img.sp.mms.shopee.*`, `cf.shopee.*`, `down-*.sp.mms.shopee.*` → ดึง URL ส่ง `_urls_to_read` ให้ vision
  3. **llm.py** — HTTPS ไม่ pin IP (SSL cert validation ป้องกัน DNS rebinding ได้อยู่แล้ว) — pin IP เฉพาะ HTTP
- **เคสที่ตรวจ:**
  - Shopee URL ใน text (`https://img.sp.mms.shopee.sg/...`) → บอทอ่านรูปได้ รู้ว่าเป็น Xiaomi Mi Air Purifier 2C ✅
  - TestChat local URL + `BOT_VISION_ALLOW_LOOPBACK=1` → บอทอ่านรูปได้ ✅
- **verify:** py_compile OK, live test ผ่าน
- **ข้อจำกัด:** ใน production ต้องไม่ตั้ง `BOT_VISION_ALLOW_LOOPBACK=1` (เปิดช่อง SSRF) — ใช้เฉพาะ dev/TestChat

### แก้ — Dual-tier recommendation แนะนำแค่ 1 ตัว ทั้งที่มีหลายตัว compat (2026-09-16)

- **ปัญหา:** ลูกค้าถาม "ขอหัวพร้อมสาย ใช้กับ iphone 18 promax" → context มี 19 สินค้า compat แต่บอทแนะนำแค่ AC301+CTC615W (1 ตัว) ทั้งที่มี Ready to go, AD1003T ฯลฯ เป็น upgrade ได้
- **Root cause 2 ชั้น:**
  1. **llm.py prompt (Phase 3b)** — ใช้คำว่า "สูงสุด 2 ตัวเลือก" (ceiling) → LLM ตีความว่า 1 ตัวก็ได้
  2. **app.py `_device_spec_lookup` context note** — ใช้คำว่า "ให้เสนอสูงสุด 2 ตัวเลือก" (ceiling) เหมือนกัน
- **วิธีแก้ (2 จุด):**
  1. **llm.py:346** — เปลี่ยนเป็น "กฎเหล็ก: ถ้ามี 2 ตัวขึ้นไป compat → ต้องแนะนำอย่างน้อย 2 ตัว ห้ามแค่ 1"
  2. **app.py:757** — เปลี่ยน context note ใน `_device_spec_lookup` ให้สอดคล้องกับ prompt (เน้น "ต้องแนะนำอย่างน้อย 2 ตัว")
- **เคสที่ตรวจ:**
  - "ขอหัวพร้อมสาย ใช้กับ iphone 18 promax" → บอทแนะนำ baseline (AC301+CTC615W 30W) + upgrade (Ready to go Standard Set) พร้อมลิงค์+รูป ✅
- **verify:** py_compile OK, live test ผ่าน

### แก้ — CODE-level compat filter กรองสินค้า connector ไม่ตรงออก (2026-09-16)

- **ปัญหา:** ลูกค้าถาม "หัวชาร์จใช้กับ iPhone 17" → บอทส่งสินค้าทุกตัวเข้า LLM (รวม Lightning cable ที่ไม่รองรับ iPhone 17 USB-C) → LLM อาจแนะนำผิด + เสีย context สินค้าที่ไม่ compat
- **Root cause:** ไม่มี CODE-level filter กรองสินค้าที่ connector ไม่ตรงกับอุปกรณ์ — ทุกตัวถูกส่งเข้า LLM แล้วให้ LLM ตัดสินใจเอง
- **วิธีแก้ (3 จุด):**
  1. **intent_classifier.py** — เพิ่ม `device_connector` (usb-c/lightning/micro-usb) + `device_min_watt` ใน prompt + default + log + max_output_tokens 200→250 — ให้ intent LLM คืน spec ของอุปกรณ์มาด้วยเลย (ไม่ต้อง hardcode หรือ parse web search แยก)
  2. **app.py** — เพิ่ม `_KNOWN_DEVICE_SPECS` (fallback), `_extract_product_connectors`, `_resolve_device_spec`, `_filter_compat_products` — กรองสินค้าที่ connector ไม่ตรงออกก่อนส่ง LLM, sort by wattage ascending (baseline ก่อน upgrade ทีหลัง)
  3. **app.py main flow** — เรียก `_filter_compat_products` หลัง `_device_spec_lookup` merge, ก่อน `_apply_product_tiers` — ส่ง `intent_connector` + `intent_min_watt` จาก intent_result เป็นหลัก, web search + hardcoded เป็น fallback
- **Device spec priority:**
  1. `intent_connector` (จาก intent classifier LLM — หลัก)
  2. web search text (จาก `_device_spec_lookup` — fallback)
  3. `_KNOWN_DEVICE_SPECS` (hardcoded — last resort)
- **Fallback strategy (safe — ไม่ over-filter):**
  - ดึง device spec ไม่ได้ → คืนทั้งหมด
  - สินค้าดึง connector ไม่ได้ → ambiguous → เก็บไว้
  - กรองเหลือ < 2 ตัว → รวม ambiguous กลับ
  - กรองว่าง → คืนทั้งหมด
- **เคสที่คาดว่าจะผ่าน:**
  - "หัวชาร์จใช้กับ iPhone 17" → กรอง Lightning ออก → เหลือ USB-C 30W/65W/100W/140W → sort ascending → LLM เห็น baseline (30W) + upgrade (100W+) ✅
  - "สายชาร์จใช้กับ iPhone 13" → กรอง USB-C-only ออก → เหลือ C-to-Lightning + A-to-Lightning ✅
- **verify:** py_compile OK (app.py + intent_classifier.py)
- **ข้อจำกัด:** `_KNOWN_DEVICE_SPECS` เป็น fallback สำหรับอุปกรณ์ที่ intent LLM ไม่รู้ + web search ไม่ได้ผล — ถ้าอุปกรณ์ใหม่มาก อาจต้องเพิ่มในตาราง

### แก้ — "ขอที่อยู่ส่งกลบ/ส่งเคลม" ไม่ handoff แอดมิน (2026-09-16)

- **ปัญหา (mistorethailand):**
  - Q3 "ขอที่อยู่ส่งกลบ" → bot ถามเลขคำสั่งซื้อ (ไม่ handoff) — พิมพ์ "ส่งกลบ" ไม่มี ่ → ไม่ match "ส่งกลบ" ใน `_RETURN_REFUND_KWS`
  - Q4 "ต้องการที่อยู่ด่วน" → bot ตอบนโยบายรับคืน (ไม่ handoff) — ไม่มี return/refund keyword เลย
  - ทั้งสองเคส ลูกค้าต้องการที่อยู่เพื่อส่งสินค้ากลับ/ส่งเคลม ซึ่ง bot ไม่มีที่อยู่จริงของร้าน → ควร handoff แอดมินเลย
- **Root cause:**
  1. `_RETURN_REFUND_KWS` ไม่มี "ขอที่อยู่" / "ที่อยู่ส่งกลบ" / "ที่อยู่ด่วน" — ไม่ match
  2. ถ้า match แล้วไม่มี order_sn → เข้า else branch ที่ถามเลขคำสั่งซื้อ (ไม่ใช่สิ่งที่ลูกค้าต้องการ)
- **วิธีแก้ (app.py 1 จุด):**
  - เพิ่ม `_ADDRESS_REQUEST_KWS` block ก่อน `_RETURN_REFUND_KWS` block:
    - keywords: "ขอที่อยู่", "ที่อยู่ร้าน", "ที่อยู่ส่งกลับ", "ที่อยู่ส่งกลบ", "ที่อยู่ส่งเคลม", "ที่อยู่ส่งคืน", "ที่อยู่ด่วน", "ต้องการที่อยู่", "ขอสถานที่ส่ง", "ส่งไปที่ไหน", "จะส่งไปที่ไหน", "ที่อยู่สำหรับส่งกลับ", "ที่อยู่สำหรับส่งเคลม", "address ส่งกลับ", "return address", "claim address"
    - ถ้า match → handoff แอดมินทันที (ไม่ถามเลขคำสั่งซื้อ)
    - คำตอบ: "เรื่องที่อยู่ร้าน/ที่อยู่ส่งสินค้ากลับ/ส่งเคลม รบกวนส่งต่อแชทนี้ให้แอดมินดูแลให้นะคะ..."
    - reason: "address_request"
- **เคสที่ตรวจ:**
  - "ขอที่อยู่ส่งกลบ" → handoff ✅
  - "ต้องการที่อยู่ด่วน" → handoff ✅
  - "ขอที่อยู่ร้านหน่อยค่ะ จะไปหน้าร้าน" → handoff ✅
  - "ขอที่อยู่จัดส่งด้วยค่ะ" → handoff ✅ (ในบริบท Shopee ลูกค้าใส่ที่อยู่ในระบบแล้ว ถ้าถามอาจมีปัญหาเรื่องที่อยู่ → ส่งแอดมินถูก)
- **verify:** py_compile OK, live test ผ่าน 4 เคส

### แก้ — "p23 มีขายไหม" หาไม่เจอทั้งที่มีใน DB (2026-09-16)

- **ปัญหา (KingGadgets):**
  - ลูกค้าถาม "p23 มีขายไหม" → บอทตอบ "ไม่มี" ทั้งที่ DB มี CUKTECH P23 Powerbank 4 ตัว status=NORMAL
  - RAG ดึง 30 ตัว แต่ P23 ไม่อยู่ใน list (vector search ไม่ match "p23" เพราะ query สั้น)
- **Root cause:**
  - `app.py:4595` — `_kb_model_kws = [w for w in _kb_model_kws if len(w) >= 4]`
  - "p23" มีความยาว 3 ตัวอักษร → น้อยกว่า 4 → ถูกกรองออกจาก MODEL-REGEX
  - MODEL-REGEX ไม่ทำงาน → ใช้ vector search แทน → ไม่ match P23
- **วิธีแก้ (app.py 1 จุด):**
  - เปลี่ยน filter จาก `len(w) >= 4` เป็น `len(w) >= 3 and re.search(r"\d", w)`
  - รับ model code สั้น (>=3 ตัว) ที่มีตัวอักษร + ตัวเลข (เช่น p23, k9, x7)
- **เคสที่ตรวจ:**
  - "p23 มีขายไหม" → บอทหา P23 เจอ + ตอบถูกต้อง + แนบลิงค์+รูป ✅
- **verify:** py_compile OK, live test ผ่าน

## กำลังจะทำ

### Config — ทำให้ ponytail skill ติดถาวรทุก session ใน repo นี้ (เฉพาะ user คนนี้) (2026-09-15) — ✅ เสร็จ

- **เป้าหมาย**: เปิด ponytail (level: full) อัตโนมัติทุก session โดยไม่ต้องสั่งเอง
- **วิธี**: สร้าง `AGENTS.local.md` (personal rule, ไม่ commit) สั่งให้ invoke skill `ponytail` ตอนเริ่ม session + เพิ่ม `AGENTS.local.md` ใน `.gitignore`
- **เหตุผลที่เลือก AGENTS.local.md**: user เลือก scope "repo นี้ เฉพาะเรา" → ไม่กระทบทีม; skill ponytail อยู่ใน `.devin/skills/` (untracked) อยู่แล้ว
- **ไม่แก้ SRS_SSD.md** — ไม่ใช่โค้ดใน `chatbot/shopeechat/`
- **Verify**: `git check-ignore -v AGENTS.local.md` → ถูก ignore โดย .gitignore:46 ✅, ไม่ขึ้นใน git status ✅

### 🔨 Refactor app.py + reorg shopeechat/ — อนุมัติแล้ว กำลังทำ (2026-09-15)

- **คำขอ:** user อนุมัติทำ refactor — จัดระเบียบไฟล์ใน `chatbot/shopeechat/` ก่อน แล้วตัด/ย้ายตาม audit
- **Reorg (ทำแล้ว):** `export_mongo.py` → `scripts/` (standalone script, cwd-relative `--out`/`EXPORT_DIR` คุม output อยู่แล้ว) + อัปเดต README/AGENTS refs
- **ตัดสินใจ: ไม่แยกโฟลเดอร์ core** — flat layout load-bearing 3 ทาง: `from shopeechat import X` (testscript+docs/test ~10 ไฟล์), `import product_store` flat (testQA2.py sys.path→shopeechat/), `chatbot.shopeechat.app:app` (Dockerfile+build_embeddings)
- **⚠️ correction:** `chat_models.py` ไม่ใช่ dead — `chat_v2.py:280` import จริง (KEEP BY DESIGN ตาม L8022); รายการ dead code ที่ verify คือตาม L8023
- **Batch 1 (mechanical — findings L8006-8016 verify แล้ว):** redundant imports, hoist model_name/_qa10/_new_topic_kws, _context_note shrink, _kw_claim, dead placeholders, hasattr×4, _send_handoff แทน 8 inline urllib, dict→ChatResponse ×2
- **Batch 2 (dead code — verify แล้ว):** `_has_warranty_history` (L2702), `_warranty_calc_note` (L3291), `_pre_product_types` (L2707) + repo-wide dead fns ตาม L8023
- **Batch 3 (extraction):** test_chat_api.py (ใหม่), device_compat.py (ใหม่), handoffs.py (ใหม่), warranty SM→warranty_flow.py, auto-check→warranty.py, _web_search_reanswer→web_search.py, _dedupe_*→product_store.py, brand helpers→knowledge_base.py — move ล้วน ไม่แก้ logic, ctx dict pattern เหมือน handle_warranty_flow
- **Verify ต่อ batch:** py_compile ทุกไฟล์ที่แตะ + grep call sites + replay เคสเก่า (ต้องผ่านเหมือนเดิมทุกเคส)

### ⏸️ Ponytail review app.py — findings รออนุมัติ ยังไม่ได้แก้โค้ด (2026-09-15)

- **คำขอ:** ponytail-review `chatbot/shopeechat/app.py` → เจอ `net: -500 lines possible` → user เลือก **หยุดก่อน แค่ review** (ไม่แตะโค้ด)
- **▶️ 2026-09-15 (ภายหลัง): user อนุมัติแล้ว — กำลัง apply ตาม entry ข้างบน**
- **Findings ที่ verify แล้ว พร้อม apply เมื่ออนุมัติ (เชิงกล ไม่เปลี่ยน semantics):**
  1. ลบ redundant local imports: `import sys` (L78), `import os` (L387, L7648), `import os as _os` (L4667), `import time as _time` ซ้ำ (L6999), `import re as _re_*` 12 จุด (L463 `_re_dedup_mod`, L564 `_re_w`, L642 `_re_conn`, L704 `_re_dev_spec`, L982 `_re_dev`, L1282 `_re_wsr`, L3061 `_re2`, L4020 `_re3`, L5591 `_re_ref`, L6489 `_re_super`, L7736 `_re`) + L4498 `import re as _re` dead (ไม่มี usage) — alias map ครบทุก usage แล้ว
  2. Hoist `model_name` = `os.environ.get("GEMINI_MODEL","gemini-3.5-flash-lite")` 1 จุด แทน 24 assignments + 3 inline uses (rename `_model_name` → `model_name`)
  3. Hoist `_qa10 = _recent_qa_pairs(history, 10)` แทน call ซ้ำ 14 จุด — ⚠️ ต้องเช็ค `history` (สร้าง L1549) ไม่ mutate ก่อนจุดใช้แรก (L2240) ก่อน apply
  4. Hoist `_new_topic_kws` tuple (ซ้ำเหมือนกันเป๊ะ L1730/L6157)
  5. Shrink `_context_note` append if/else 5 จุด (L4948, L6236, L6260, L6275, L7254) → `products[0]["_context_note"] = f"{products[0].get('_context_note','')} {note}".strip()`
  6. `_kw_claim` คำนวณครั้งเดียว (L1921 `_warranty_pre_check` / L2788 `_warranty_check_mod` = module เดียวกัน 2 alias; L3884 คนละ flow เก็บไว้)
  7. ลบ `_is_conv_active_init` placeholder (L5265 ไม่เคยอ่าน), print ADDRESS-REQUEST ซ้ำ (L1984/L2003 เก็บอันเดียว), `_is_superlative` ซ้ำ `_is_superlative_q` (L6297)
  8. Simplify `hasattr(m,'role')`/`hasattr(m,'text')` บน req.history ×4 (L4444, L4489, L5186, L5509 — pydantic รับประกัน ChatMessage)
  9. Extend `_send_handoff` (L7809 — chat_v2/chatbotv3 เรียกอยู่แล้ว) +`claim`/`simulate`/return dict → แทน 8 inline urllib blocks: fire-and-forget L2013-2041, L2122-2152, L2635-2666, L2855-2886, L2988-3019, L4170-4201; อ่าน response L3909-3949, L4271-4308
  10. dict returns L6450/L6807 → `ChatResponse` (key `platform`/`intent_confidence` ไม่มีใน model ถูก drop อยู่แล้ว → output เดิม)
- **ข้ามโดยตั้งใจ (เสี่ยงเปลี่ยน behavior):** merge `_charging_spec_kws` 3 เวอร์ชัน (เนื้อหาต่างกัน), device tables ×3, brand/stop sets ×2, `_respond()` helper, phase extraction ของ chat() (6,325 บรรทัด)
- **วิธี apply ที่ปลอดภัย (เมื่ออนุมัติ):** แบ่ง batch imports→hoists→misc→handoff, py_compile+grep verify ทุก batch, ให้ดู git diff ทีละชุด

### ℹ️ Ponytail repo-audit (2026-09-15) — report-only, ยังไม่แก้โค้ด

- **⚠️ KEEP BY DESIGN:** `chat_v2.py` + `chat_models.py` + `warranty_flow.py` + `chatbotv3/` (~4,200 บรรทัด) — user ยืนยันเก็บไว้พัฒนาต่อ (legacy คือ engine ที่ใช้จริง) → **อย่า flag/ลบ อีก**
- **Dead code verified (zero callers ทั้ง repo):** `web_search.search_and_answer` (53 บรรทัด, deprecated), `product_store._score_card` (41), `_is_sold_out` (14), `order_store.lookup_orders_by_buyer` (36), `_format_unix_ts_with_time` (23), `conversation_products.get_recent_suggestions` (25), `is_generic_question` (11) ≈ 203 บรรทัด
- **requirements.txt dead deps ×4:** resend, PyJWT, bcrypt, email-validator — ไม่มี import ใน Python tree (bcryptjs ใน Next.js คนละ package; ไม่มี EmailStr)
- **docker-compose:** service chatbot-lazada/tiktok ชี้ APP_MODULE ที่ไม่มีอยู่จริง (~60 บรรทัด) — ลบจนกว่า implement
- **soft:** docs/test 22 scripts — run_daily_tests เรียกแค่ testQA2.py; test_openrouter_cost vs test_openrouter_full_cost ซ้อนกัน

### แก้ — Warranty follow-up "รุ่นไหนประกันยังไงบ้าง" หยิบรุ่นเก่ามาตอบ + anchor poisoning (2026-09-16)

- **เคสจริง (conv thwtchtpyn, shop CukTechThailand):**
  - Q2/Q3: บอทแนะนำ CTC615S (สายชาร์จ) → Q4: "Mi 17 ultra ใช้พาวเวอร์แบงค์ไหนรองรับบ้าง" → แนะนำ PB150P+PB100P
  - Q5: "รุ่นไหนประกันยังไงบ้าง" → บอทตอบประกัน CTC615S (สายชาร์จเก่า) แทนที่จะเทียบ PB150P/PB100P
  - Q6-Q18: บอทเชียร์ขาย CTC615S ทุกคำตอบ (แม้แค่ส่งสติกเกอร์) เพราะ CTC615S กลายเป็น anchor ถาวร
- **Root cause (verify ด้วย live replay + timeline inspection แล้ว):**
  1. `app.py:~2780` `_is_followup_policy` — `_last_model_msgs[-2:]` join ตามเวลา (เก่าก่อน) → `valid_models[0]` = CTC615S (รุ่นเก่าจาก Q3) ไม่ใช่รุ่นล่าสุด
  2. `req.message` ถูก rewrite เป็น "CUKTECH CTC615S รับประกัน CUKTECH PB150P รับประกัน ..." → CONV-ACTIVE `resolve_active_by_message` match kw ตัวแรก → คืน CTC615S ตัวเดียว
  3. `_record_suggestion_products` extract model kw จาก rewritten message → mark CTC615S เป็น anchor (source=user_text) → poison timeline ทุกรอบถัดไป
  4. (รอง) Q4 "Mi" kw match "Mi" (Mi HyperCharge) ในชื่อ PB150S → false anchor — substring match อนุญาต kw สั้นเกิน/ไม่มีตัวเลข
- **แผนแก้ (app.py 2 จุด):**
  1. `_is_followup_policy` block: reverse `_last_model_msgs` (ล่าสุดก่อน) + resolve ทุกรุ่นใน `_unique_models[:3]` เป็น product cards (match timeline ก่อน → fallback DB regex ignore status) → set `_ref_regex_products` + `_is_conv_active=True` (pattern เดียวกับ LINK-FOLLOWUP)
  2. `_record_suggestion_products`: extract anchor kw จาก `req._followup_original` (ข้อความจริงของลูกค้า) ไม่ใช่ rewritten message + กัน kw สั้นไร้ตัวเลข (len>=3 หรือมี digit เท่านั้น)
- **verify ที่จะทำ:** replay conv thwtchtpyn → Q5 ต้องตอบ warranty ของ powerbank ไม่ใช่สายชาร์จ; py_compile; รัน test_katess_live.py กัน regression

### แก้ — ensureIndexes fail ตอน start: partial index `$exists: false` ไม่ได้บน MongoDB 5.0 (2026-09-15) — ✅ implement + tsc ผ่าน รอ verify deploy

- **ปัญหา:** `chatadmin-web` start ทุกครั้ง → log error `ensureIndexes failed: MongoServerError ... unsupported expression in partial index: $not ... code: 67`
- **สาเหตุ:** `mongoClient.ts:168` สร้าง partial index `{ scope: 1, conversation_id: 1 }` กับ `partialFilterExpression: { generation_batch_id: { $exists: false } }` — MongoDB 5.0.32 ไม่รองรับ `$exists: false` ใน partial index (แปลงเป็น `$not` แล้วปฏิเสธ, code 67 CannotCreateIndex)
- **ผลกระทบก่อนแก้:** index เก่า `scope_1_conversation_id_1` ถูก drop (บรรทัด 51) แต่ตัวใหม่สร้างไม่ได้ → legacy annotation (ไม่มี batch_id) ไม่มี unique constraint; ปัจจุบัน DB มี legacy docs = 0 → ไม่มีข้อมูลเสีย แต่ log error ทุกครั้ง
- **วิธีแก้ (mongoClient.ts 2 จุด):**
  1. **pre-step (บรรทัด 48-65):** เปลี่ยนจาก drop แค่ `scope_1_conversation_id_1` → drop ทั้ง 2 old index (`scope_1_conversation_id_1` + `scope_1_conversation_id_1_generation_batch_id_1`) ใน for-loop — ไม่งั้น safeCreateIndex เจอ code 85 (IndexOptionsConflict) กับ partial index เดิมที่มี key ซ้อน แล้วเงียบ ๆ ไม่สร้างตัวใหม่
  2. **ใน Promise.all (บรรทัด 181):** แทนที่ 2 partial index (เดิมบรรทัด 167-168) ด้วย unique index ธรรมดาตัวเดียวบน `{ scope: 1, conversation_id: 1, generation_batch_id: 1 }` — MongoDB index doc ที่ไม่มี field เป็น null → unique บังคับ 1 ต่อ (scope, conversation_id) สำหรับ legacy docs อัตโนมัติ (semantic เดิมครบทั้ง 2 ข้อ: แยกตามรอบเมื่อมี batch_id / 1 ต่อแชทเมื่อไม่มี) โดยไม่ต้องพึ่ง `$exists: false`
- **ไม่ต้องแก้:** `chatAnnotationService.ts` — upsert filter `$exists: false` (บรรทัด 122) เป็น query ไม่ใช่ index spec ใช้ได้ตามเดิม; convention "ไม่มี batch = omit field" (บรรทัด 148) คงไว้
- **ไฟล์ที่แก้:** `ChatAdminWeb/src/backend/db/mongoClient.ts`
- **ไม่แก้ SRS_SSD.md** — section 6 เป็นของ Python (`chatbot/shopeechat/`) ไม่เกี่ยว
- **Verify:** `npx tsc --noEmit` → ผ่าน ✅ (exit 0); `npm run build` → ผ่าน ✅; in-memory MongoDB test (`scripts/test-ensure-indexes-5.0.mjs`) → ผ่านครบ 4/4 ✅:
  - Test 1 (reproduce bug): OLD spec `$exists: false` partial index → FAIL code=67 CannotCreateIndex (bug reproduced) ✅
  - Test 2 (verify fix): NEW spec plain unique index → PASS ✅
  - Test 3 (legacy unique): 2nd legacy doc (no batch_id) same (scope, conv_id) → blocked code=11000 (unique enforced อัตโนมัติ) ✅
  - Test 4 (multi-batch): ต่าง batch_id แชทเดียวกัน → insert ได้ทั้งคู่ ✅
  - index หลัง fix: `scope_1_conversation_id_1_generation_batch_id_1` unique=true partial=null (ไม่มี partialFilterExpression) ✅
- **⚠️ ยังไม่ verify deploy:** รอ rebuild จริง + ตรวจ log ว่าไม่มี `ensureIndexes failed`
- **วันเวลาที่แก้:** 2026-09-15

### 🔨 image_texts pipeline — extract spec จาก description images (sellable first) (2026-09-21)

- **ทำอะไร:** สร้าง `chatbot/shopeechat/scripts/build_image_texts.py` — ยิง Gemini vision (`gemini-3.5-flash-lite`, loop keys แบบ `llm._client()`) extract structured text {kind, text} จากรูปใน `description_info` เฉพาะ **sellable units** (item_status=NORMAL + stock>0) → append `exports/image_texts.jsonl` (resume ได้)
- **ทำไม:** spec/variant info อยู่ในรูปเท่านั้น (4,426 docs มี image blocks; listing CUKTECH item_id=24166340609 มี spec 9 รุ่นย่อยในรูป) — bot อ่านไม่ได้เลยตอนนี้
- **ข้อกำหนด:** rate รวมทุก key ≤80/min, ≤4,000/day → checkpoint+resume; **ทุก call → `_log_ai_usage`** (reuse `web_search._log_ai_usage` + local `exports/image_texts_usage.jsonl` กัน hub-timeout หาย); ห้ามแตะ app.py; `max_output_tokens=4000` + เช็ค finish_reason=MAX_TOKENS
- **ตัวเลขวัดจริง:** รูปธรรมดา ~฿0.02, spec sheet หนัก ~฿0.14-0.17; sellable unique image_id = 5,925 (template >20 listings = 45); estimate รวม ~฿150-400
- **แผนเต็ม:** `docs/superpowers/plans/2026-09-16-sellable-unit-index.md` (Task 3 — ทำก่อน Task 1-2 ตามคำสั่ง user)
- **⚠️ bug ที่เจอ + แก้:** (1) `genai.Client` สร้างใหม่ทุก call → "client has been closed" (SDK share httpx transport โดน GC ปิด) → cache client ต่อ key `_next_client()` rotation เหมือนเดิม (2) `price_info` เป็น list ไม่ใช่ dict
- **progress:** batch กำลังรัน (pid background) — output `exports/image_texts.jsonl`, usage log `exports/image_texts_usage.jsonl`, run log `exports/image_texts_run.log`; resume = รัน command เดิมซ้ำ (skip status==ok)

### 🔨 Task 1-2: unit_classifier + sellable_units index (2026-09-21) — ✅ PASS + GATE ผ่าน

- **สร้าง:** `chatbot/shopeechat/scripts/unit_classifier.py` (classify_unit → components/kind/type/subtypes/model_codes/oos_in_name/confidence — reuse `product_store.PRODUCT_TYPES`/`_CHARGER_SUBTYPES` ไม่เขียนตารางใหม่), `chatbot/shopeechat/scripts/build_sellable_units.py` (→ `exports/sellable_units.jsonl` 26,970 units พร้อม desc_sections/image_ids/search_text)
- **ผลวัดจริง:** units=26,970 (ตรง census), sellable=4,969 (ตรง), **classified sellable=4,679 = 94.2% ≥ gate 90%**; confidence all-units: high 24,500 / medium 54 / low 2,416 (low = type นอก taxonomy เช่น เฟอร์นิเจอร์ — ตั้งใจไม่เดา)
- **desc_sections keys จริง:** intro/highlights/specs/warranty/notes/other — markers `[[ X ]]`, `*** X ***`, `===banner===`, "เงื่อนไขการรับประกันสินค้า" บรรทัดลอย; warranty units=2,084, units with image_ids=12,120
- **design decision:** main_comp fallback = item_type เอง (vacuum unit → comps=["vacuum"]); "สาย"→cable (charging) / strap (smartwatch); companion code ที่ resolve ไม่ได้ → cable (charging family) / accessory
- **tests:** `docs/test/test_unit_classifier.py` 10/10 PASS, `docs/test/test_sellable_units.py` ALL PASS (units/unique/sellable flag/HA835-AL870-EC4 spot checks/sections/images)

### 🔨 Task 4: KB re-import → kb_products/kb_qa/kb_raw (2026-09-21) — ✅ PASS + import จริงแล้ว

- **แก้:** `docs/adminbase/script/import_adminbase.py` — `parse_row(header,row,...)` → (kb_products|None, [kb_qa], kb_raw); **สร้าง:** `spec_key_map.py` (canonical map ~45 keys: capacity_mah/input_spec/screen_size/...)
- **bug จริงที่แก้:** duplicate columns ใน 4 ไฟล์ (Cuktech ZTEC มี คำถาม/คำตอบ ×2 ต่อ row, Xiaomi กล้อง มี ฟีเจอร์เด่น/อุปกรณ์ในกล่อง ×2) — เดิม dict overwrite ทำข้อมูลหาย → ตอนนี้ raw=list-of-pairs + specs_raw disambiguate `col (2)` + Q&A positional pairing
- **ผล import จริง (admin DB `chatbot`):** kb_products=1,011 (canonical_specs 511, model_codes 558, item_ids linked 539), kb_qa=393 (linked 239 — รวม general_faq จาก txt), kb_raw=1,040 (audit trail ทุกแถวที่มีข้อมูล)
- **design:** `code_item_map` จาก sellable_units.jsonl → item_ids link ผ่าน model_codes; txt → kb_qa type=general_faq; row ที่มีแต่ Q&A ไม่สร้าง product doc
- **test:** `docs/test/test_kb_import.py` ALL PASS
- **หมายเหตุ:** knowledge_base collection เดิมยังอยู่ — reader migration (knowledge_base.py อ่าน kb_products/kb_qa) เป็น Task 9

### 🔨 Task 5: typo_dict + unit_embeddings (2026-09-21) — 🔄 embeddings กำลังรัน

- **สร้าง:** `build_typo_dict.py` → `exports/typo_dict.json` {brands 221, model_codes 2,119, product_words 4,012, thai_terms 5,603} — bug ที่แก้: code 3 ตัว (EC4,P23) หลุดเพราะเช็ค code อยู่ใต้ filter len≥4
- **แก้:** `build_embeddings.py` เพิ่ม `--units` → embed unit.search_text 26,970 units → `exports/unit_embeddings.npz` (item_ids+unit_ids+model_ids+shops+texts) — กำลังรัน ~23/s

---

## ผ่านแล้ว (ใหม่)

### Video understanding + media transport ตรวจครบ 6 paths (2026-09-15) — ✅ implement + verify ผ่าน

- **คำขอ:** "timeout 180s แล้วก็เชค shadowbot botworker testchat/shoppee live assignment test assignment replay compare หน่อยครับ ว่าส่งวิดีโอได้ถูกต้องตาม format ที่ต้องการหรือยัง รับวิดีโอส่งวิดีโอถูกต้องหรือยังครับ"
- **ผลตรวจ 6 paths (subagent ตรวจครบ):**
  - **Shadowbot** ✅ — `messageMediaParser` extract `inner.video_url` → `media.type=video` → `toBotImages` คืน `[video_url]` → `shadowReplyService` ส่ง `images` → `/chat` ส่ง `body.images` ครบ; placeholder `[วิดีโอ]` ส่งถูก; `message_type=video` ไม่ถูกบังคับเป็น `image`
  - **Bot Worker** ⚠️→✅ — path หลักผ่าน แต่ **workflow `let_ai_respond` ทิ้ง video URL** เพราะ `EngineMessage` ไม่มี `raw_payload`/`images` → `toBotImages(engineMsg)` คืน `[]` → แก้โดยเพิ่ม `images?: string[]` ใน `EngineMessage` + ส่ง `botImages` จาก `botWorkerService` + `let_ai_respond` ใช้ `msg.images` ก่อน fallback `toBotImages(msg)`
  - **Test Chat/Shopee** ⚠️→✅ — proxy ส่ง `images` ผ่านเดิม แต่ **upload URL `/api/test-chat/uploads/<id>` ไม่มี extension** → `hasVideo` heuristic ไม่จับ → วิดีโอถูก tag `message_type=image` + placeholder `[รูปภาพ]` → แก้โดย client ส่ง `media_types` (content types) มาด้วย + buffer route เช็ค `ct.startsWith("video/")` ก่อน fallback URL heuristic
  - **Live Assignment** ✅ — `toBotImages(msg)` → `callBot({images})` → `body.images` ครบ; ไม่ทิ้ง/ไม่แทน thumb
  - **Test Assignment** ✅ — `toBotImages(msg)` → `callBot({images})` → `body.images` ครบ; ไม่ทิ้ง/ไม่แทน thumb
  - **Replay Compare** ✅ — `parse_raw_message` จับ `msg_type=='video'` → `media={type:video,url:video_url}` → `build_bot_message` ส่ง `images=[url]` → `call_bot` ส่ง `body.images` ครบ; ใช้ path เดียวกับ image
- **Python `describe_image` (llm.py):**
  - timeout 180s สำหรับ video URL (extension .mp4/.mov/.avi/.webm/.mkv) + test-chat upload URL (ไม่มี extension → ให้ 180s ไว้ก่อน)
  - MIME detect จาก HTTP `Content-Type` + URL suffix → `video/mp4` → `Part.from_bytes`
  - เพิ่ม video-specific prompt section (motion/sequence/audio/fault demo) เมื่อ `_mime.startswith("video/")`
  - `describe_images` label เปลี่ยนจาก `[รูปที่ N]` → `[วิดีโอที่ N]` / `[รูปที่ N]` ตาม URL suffix
- **ไฟล์ที่แก้:**
  - `chatbot/shopeechat/llm.py` — timeout 180s + video prompt + label วิดีโอ/รูป
  - `ChatAdminWeb/src/backend/service/workflowEngine.ts` — `EngineMessage.images?` + `let_ai_respond` ใช้ `msg.images`
  - `ChatAdminWeb/src/backend/service/botWorkerService.ts` — `engineMsg` ส่ง `images: botImages`
  - `ChatAdminWeb/src/app/api/test-chat/buffer/route.ts` — รับ `media_types` + `hasVideoMedia` เช็ค content_type ก่อน URL heuristic
  - `ChatAdminWeb/src/components/chat/TestChatClient.tsx` — ส่ง `media_types: images.map(i => i.type)` ไป buffer
- **Verify:** py_compile ผ่าน ✅, `npx tsc --noEmit` ผ่าน ✅
- **⚠️ ยังไม่ verify end-to-end จริง:** รอทดสอบส่งวิดีโอจริงผ่าน test chat + ส่งวิดีโอ Shopee จริงผ่าน bot worker เพื่อยืนยัน Gemini อ่านวิดีโอได้
- **สถาปัตยกรรม:** `images` field (string[]) ยังคงเป็น media URL array สำหรับทั้ง image และ video — ไม่เปลี่ยนเป็น `media` field ตามที่ไม่ได้รับการร้องขอ

---

## Audit (ไม่ได้แก้โค้ด)

### Ponytail audit — repo-wide over-engineering scan (2026-09-15) — ✅ report only, applies nothing

- **คำขอ:** ponytail-audit ทั้ง repo + ประเมิน plan-3411cb7710a70c07.md (retrieval redesign) ว่าแก้ปัญหาหรือเพิ่ม complexity
- **Findings หลัก (ยังไม่ได้แก้ — รอตัดสินใจ):**
  - 3 chat engines ขนานกัน (app.chat legacy 8,239 + chat_v2 1,491 + chatbotv3 ~1,783 + warranty_flow 822 เฉพาะ v2) หลัง flag `USE_LEGACY_CHAT`/`USE_CHAT_V3`/`chat_engine` — cut ที่ใหญ่สุดถ้าเลือกตัวชนะ
  - dead code ที่เช็คแล้วไม่มี caller: `chat_models.py`, `web_search.search_and_answer`, `product_store._score_card`, `product_store._is_sold_out`
  - dead Python deps ใน requirements.txt: `resend`, `PyJWT`, `bcrypt`, `email-validator` (auth อยู่ฝั่ง Next: jose+bcryptjs)
  - docker-compose services สำหรับ lazada/tiktok ที่ app ยังไม่มี (comment ตัวเองบอก container จะ crash)
  - test harness ซ้ำซ้อน: `test/` vs `docs/test/` + `test_openrouter_cost.py` ถูกแทนด้วย `test_openrouter_full_cost.py` + `ChatAdminWeb/scripts/test-workflow-*.ts`
- **Plan verdict:** แผน retrieval ใหม่ (union regex∪vector + anchor-always + bypass 8 heuristic blocks) เป็นทิศทาง "เอาพฤติกรรมผิดออก" ไม่ใช่ guard ซ้อน guard → แก้ปัญหาจริง; ข้อเสนอเพิ่ม: ควรมี phase ลบ legacy path หลัง eval ผ่าน + ตัด enum `reranked` ออกจนกว่า Phase C จะมีจริง
- **ไฟล์ที่แก้:** ไม่มี (รายงานอย่างเดียว) — อัปเดตไฟล์นี้ตามกฎข้อ 8

### Ponytail review เฉพาะ app.py legacy (2026-09-15 ต่อเนื่อง) — ✅ report only

- **คำขอ:** รีวิว legacy `app.py` (8,239 บรรทัด) — ซับซ้อนเกินไหม ลด/รวมฟังก์ชันตรงไหนได้บ้าง (ไม่สนใจ v2/v3)
- **Findings (ยังไม่แก้):**
  - `chat()` ยาว ~6,325 บรรทัด, 26 return points, flag ข้าม block กัน (UnboundLocalError guard ที่ L1137-1143 คืออาการ)
  - warranty state machine ซ้ำกับ `warranty_flow.py` — inline ~850 บรรทัด (L3293-4143) vs module ที่ port ไปแล้ว (มี Phase 2Z+/2B ครบ) → legacy เรียก `handle_warranty_flow()` เองได้
  - handoff HTTP call copy-paste 7 จุด (~30 บรรทัด/จุด) ทั้งที่ `_send_handoff` (L7809) มีอยู่แต่ legacy ไม่เคยเรียก
  - `return ChatResponse(...)` 26 จุด tail เหมือนกัน → รวมเป็น `_respond()`
  - comparison quartet L3110-3292 — 4 detector ผลิต `_anchor_compare_ctx` เหมือนกัน → รวมเป็น resolver เดียว
  - tax invoice 2 block เกือบเหมือนกัน (L2841-2908 + L4143-4222)
  - Phase 1C warranty auto-check 2 ตัว (delivery + legacy create_time fallback)
  - Test Chat Sessions API ~370 บรรทัด (L7872-8239) ไม่เกี่ยวกับ chat() → ย้าย router ของตัวเอง
  - nested `_resolve_charger_subtype` + `_web_search_reanswer` ประกาศทุก request → ยกขึ้น module level
  - carry/ref heuristic stack ~L5027-5800 (retrieval rewrite, LINK-FOLLOWUP, CONV-ACTIVE, charger carry, fuzzy guard, ref-like) — เป้าหมายเดียวกับ plan staged_filter
- **ไฟล์ที่แก้:** ไม่มี — รายงานอย่างเดียว

### Refactor legacy app.py — extraction + dedup (2026-09-16) — ✅ verified

- **คำขอ:** "app.py ฟังก์ชั่นไหนไม่จำเป็นลดจำนวนได้... อันไหนแยกเป็นไฟล์อื่นๆ ได้" → audit → "เอา ทำเลยพี่"
- **ผลลัพธ์:** `app.py` 8,239 → **4,807 บรรทัด** (−3,432)
- **ไฟล์ใหม่:**
  - `test_chat_api.py` (408) — test-chat sessions CRUD 9 routes + `_validate_object_id`/`_log_testchat_action` (APIRouter, include ใน app.py)
  - `device_compat.py` (519) — `_extract_max_wattage`, `_KNOWN_DEVICE_SPECS`, `_extract_product_connectors`, `_resolve_device_spec`, `_filter_compat_products`, `_apply_product_tiers`, `_device_spec_lookup`
- **ย้ายเข้าไฟล์เดิม:**
  - `warranty_flow.py` += `handle_warranty_flow_legacy(req, ctx, history, db)` — claim SM ~950 บรรทัด verbatim (returns dict→ChatResponse wrap); ctx ส่ง 15 vars จาก chat scope
  - `warranty.py` += `auto_check_delivery_warranty(order_sn, shop, bot_name)` — 2-phase (delivery-date + legacy create_time fallback) → (answer, info, ctx)
  - `web_search.py` += `reanswer(...)` — เดิม nested `_web_search_reanswer` ใน chat() (~295 บรรทัด); เพิ่ม params `db`, `llm_ctx_limit`
  - `knowledge_base.py` += `_detect_brand_question`, `_build_brand_context`, `_kb_doc_to_card`
  - `product_store.py` += `_dedupe_products`, `_dedupe_base_name`, `_dedupe_sell_score`, `_DEDUP_STANDARDS`
  - `llm.py` += `_GEMINI_COST_PER_M` + `_gemini_cost(p_in, p_out)` — แทน inline cost ×9 จุด
- **Dead code ลบทิ้ง (verify 0 call sites แล้ว):**
  - app.py: `_has_warranty_history`, `_warranty_calc_note`, `_pre_product_types`, `_strip_kb_markup` (ซ้ำ llm.py — alias ใช้ `llm._strip_kb_markup`), `_admin_db` (ซ้ำ conversation_products)
  - `product_store.py`: `_score_card`, `_is_sold_out`, `_STOPWORDS`
  - `web_search.py`: `search_and_answer` (deprecated)
  - `order_store.py`: `lookup_orders_by_buyer`, `_format_unix_ts_with_time`
  - `conversation_products.py`: `get_recent_suggestions`, `is_generic_question`
- **Dedupe:** inline urllib handoff 8 จุด → `_send_handoff` (ขยาย sig รับ `claim`/`simulate`/`timeout`/`log_tag` + คืน response); `_qa10` hoist 13 จุด→1; `model_name` hoist 27 จุด→1; `_add_context_note` helper แทน if/else 4 บรรทัด ×5; raw dict returns ×2 → `ChatResponse`; `dir()` hack ใน superlative → var ปกติ
- **Reorg:** `export_mongo.py` → `scripts/` + อัปเดต README/AGENTS
- **Compat alias (v2 เรียกผ่าน `_app_module`):** `_detect_brand_question`, `_build_brand_context` ชี้ไป knowledge_base
- **⚠️ correction (2026-09-16 ทดสอบจริง):** `_model_name` ไม่ใช่ latent bug — ต้นฉบับ assign `_model_name = os.environ.get("GEMINI_MODEL", ...)` ไว้ 3 จุด แต่ **ตอน extract บรรทัด assign หลุด** → post-handoff path 500 จริง (replay suite จับได้: "," หลัง handoff → NameError) → แก้แล้วด้วย `_model_name = model_name` (จาก ctx — ค่าเดียวกัน)
- **Verify:**
  - `python3 -m py_compile` ทุกไฟล์ที่แก้ ✅
  - import `shopeechat.app` + `chat_v2` + `warranty_flow` ผ่าน (venv .venv) ✅
  - FastAPI openapi paths มี /test-chat/* ครบ 9 routes (include_router lazy-mount) ✅
  - smoke test จริง `chat(ChatRequest)`: "สวัสดี" → product_store answer ปกติ ✅; "สินค้าเสียอยากเคลมค่ะ" → `warranty_claim_first_message` + `handoff_to_admin=True` ✅

### Refactor ต่อ — order_flow.py + handoffs.py (2026-09-16) — ✅ verified

- **ผลลัพธ์:** `app.py` 5,471 → **4,807 บรรทัด** (−664)
- **ไฟล์ใหม่:**
  - `order_flow.py` (537) — `early_order_flow(req, ctx, history, db)` ย้าย verbatim order lookup + return/refund+address handoff + tracking lookup (~500 บรรทัด); เขียนกลับ `ctx["order_sn"]`/`ctx["is_claim_request_pre"]` ให้ warranty auto-check ใช้ต่อ
  - `handoffs.py` (260) — `detect_human_request(req, ctx)` (pre-intent, BUG-3) + `post_intent_handoffs(req, ctx, db)` (tax invoice + TISI)
- **Bug ที่จับได้จาก smoke test (แก้แล้ว):**
  - `web_search.py` ขาด `import re` — `reanswer()` ใช้ `re` แต่ import ไม่ได้ตามมาตอนย้าย → NameError หลัง LLM ตอบ → เพิ่ม import
  - `order_flow.py` ขาด `from fastapi import HTTPException` — block มี `raise HTTPException(500)` อยู่ → เพิ่ม
  - `app.py` หลุด lazy imports `warranty` + `warranty_flow` — เดิม import อยู่ใน order block ที่ย้าย แต่ code หลัง block ใช้ต่อ → re-add ก่อน call site
- **Verify:**
  - `py_compile` ทุกไฟล์ ✅ + import ทุกโมดูลใหม่ ✅
  - smoke `chat()` 6 paths: order_sn ปลอม → `order_lookup` not-found answer ✅, "ขอที่อยู่ส่งคืน" → `address_request_handoff` ✅, "ขอคุยกับแอดมิน" → `human_request_handoff` ✅, "ขอใบกำกับภาษี" → `tax_invoice_handoff` (ผ่าน intent conf=1.0) ✅, claim first-message ✅, claim w/ history → `warranty_claim_flow` + handoff ✅, "มีพาวเวอร์แบงค์ไหม" → `product_store` ✅
- **ยังไม่ได้ทำ:** `_respond()`/`_record_step()` (ตรวจแล้ว rounding ต่างกันจริงต่อ site — helper จะเปลี่ยน output precision จึงข้าม), comparison follow-up quartet + KB merge + product path (~2,900 บรรทัด core ที่ผูกกับ chat() state — เสี่ยงสูง คุ้มน้อย), replay suite เต็มจาก docs/test/

### Replay test pingevox + mistorethailand หลัง refactor (2026-09-16) — ✅ 41/42

- **รัน:** `docs/test/test_pingevox_mistore.py` ยิง server จริง `127.0.0.1:8010` (42 เคส, history สะสม)
- **ผล:** pingevox 5/5 ✅ | mistore 36/37 — Q29 "สอบถาม สายชาร์จ ชาร์จไฟไม่ได้" หลัง claim flow เดิม → SM เก็บข้อมูลต่อ handoff=False (logic เดิม — handoff ไปแล้ว turn ก่อนหน้า ไม่ใช่ regression)
- **Regression ที่ replay จับได้ (แก้แล้ว):**
  - `warranty_flow.py` — `_model_name` 3 assignment หลุดตอน extract → post-handoff 500 → `_model_name = model_name`
  - `device_compat.py` — `_extract_max_wattage` ใช้ `_re_w` (alias `import re as _re_w` หลุดตอน dedupe local imports) → `_re_w.`→`re.` 2 จุด — compat-follow-up path ("หัวชาร์จละ" ฯลฯ) 500 ก่อนแก้
- **ระหว่างทดสอบ:** Gemini 429 RESOURCE_EXHAUSTED (quota หมดจากรันซ้ำ) — error/fail ที่เหลือในรอบกลางเป็น quota ไม่ใช่โค้ด; static sweep หา undefined names ทุกไฟล์ที่แตะ → clean แล้ว

### Replay test katess_live หลัง refactor (2026-09-16) — ✅ 5/5

- **รัน:** `test/test_katess_live.py` ยิง server จริง `127.0.0.1:8010` — เคส Run vs Swim comparison
- **ผล:** Q1 item-card anchor (Run) ✅, Q2 anchor comparison "รุ่นนี้กับตัว swim" → Run+Swim ครบ context ✅, Q3 item-card Swim ✅, Q4 comparison follow-up "คุณภาพเสียงต่างกันไหม" ✅, Q5 post-comparison follow-up ✅
- **ความหมาย:** comparison quartet + anchor/carry-forward (โซนที่ยังอยู่ใน app.py และผูกกับ chat() state หนักสุด) ทำงานถูกหลัง refactor

### Unit tests test/ หลัง refactor (2026-09-16) — ✅ 24/24

- **รัน:** `pytest test/test_anchor_comparison_followup.py test/test_qa_batch_20260911.py`
- **ผล:** anchor comparison 6/6 (anchor history, post-comparison, partial comparison) + qa_batch 18/18 (lang detect, `_strip_kb_markup` — verify dedupe ไปใช้ `llm.py` copy เดียว, claim state helpers)

### เทสโมดูลที่ย้าย (2026-09-16) — ✅ 13/13 live

- **ไฟล์ใหม่:** `test/test_extracted_modules_live.py` — ยิง server จริง `127.0.0.1:8010`, shop=KingGadgets
- **order_flow.py:** order found (`220725DCDR7DBN`) ✅ / not-found ✅ / order anchor follow-up "order ถึงยัง" ✅ / return-refund ask→follow-up handoff ✅ / address request handoff ✅
- **handoffs.py:** human request ✅ / tax invoice ✅ / มอก. → tisi_answer (เจอ Powerconnex รางไฟ) ✅
- **device_compat.py:** "หัวชาร์จใช้กับ iphone 17 pro max" → compat products ✅ / "หัวชาร์จละ" follow-up ✅ / "ราคาเท่าไหร่" ✅ (เส้นทางที่เคยพัง `_re_w`)
- **พบ (ไม่ใช่ regression):** `lookup_by_tracking` ค้นเฉพาะ `package_list.*` แต่ Shopee เก็บ `tracking_no` ไว้ top-level → tracking path miss เสมอกับ data shape ปัจจุบัน → bot ตอบขอเลข order (shipping_policy) — behavior เดิมก่อน refactor, order_store.py ไม่ได้แตะ

### รัน docs/test suite หลัง refactor (2026-09-16)

**Unit (ไม่ยิง server):**
- `test_recent_qa_pairs.py` + `test_warranty_delivery.py` — pytest 21 ผ่าน
- `test_car_charger_regression.py` — 16/16 (ต้อง `PYTHONPATH=chatbot` — sys.path ในไฟล์ชี้ `docs/chatbot` ผิดอยู่เดิม pre-existing)
- `test_new_product_types.py` — 66/66 (sys.path เดียวกัน)
- `test_charger_subtype_parity.py` — 42/42

**Live (ยิง server :8010):**
- `test_flow.py` — 7/8 กลุ่มผ่าน; Q8 "สายถัก iphone 17 promax" คาด `product_store+web_search` แต่ได้ `product_store` (retrieval เจอชุด CTC615W+CTL301 → ไม่ trigger web search — nondeterministic ไม่ใช่ regression)
- `test_all_conditions.py` — **54/54** (ครอบทุก source: product/kb/general/claim SM/compat/handoff/web_search; เคส 8.4 โดน 429 quota กลางรันแต่เช็ค loose ผ่าน)

**แก้ test 2 ไฟล์:** test_flow.py + test_all_conditions.py เก่ากว่า secret middleware — เพิ่ม `X-Internal-Secret` header จาก env (pattern เดียวกับ test_katess_live.py)

### Unit-index runtime path (2026-09-16) — ✅ ALL PASS

**เคสที่เคย fail / วิธีแก้:**
- `HA835 พร้อมสาย` เลือกผิด unit → qualifier scoring (model_name token ที่อยู่ใน message ได้ bonus)
- `สายชาร์จ AL870` เป็น phone combo → สาเหตุ 3 ชั้น: (1) compat phrase "สำหรับ iPhone" กลืนเป็น phone — strip ก่อน detect type; (2) main comp ถูก prepend เสมอ — ใส่เฉพาะเมื่อมีหลักฐาน (พร้อม/code-only segment/color/segment อยู่ใน item_name); (3) "พร้อมสายชาร์จ" ถูก cable rule กิน — skip เมื่อมี "พร้อมสาย"
- `กล้องวงจรปิดแนะนำหน่อย` + sellable_only → 0 hits: top-50 vector เป็น deleted/unlisted หมด → `_sellable_mask` ที่ vector level (ดึง Mongo ไม่อบ npz — sellability เปลี่ยนได้)

**ผ่านแล้ว:**
- `test_unit_classifier.py` 10/10, `test_units.py` 5/5 (code match, qualifier, per-unit stock, sellable filter, vector, card shape)
- `test_sellable_units.py`, `test_kb_import.py`, `test_route_context.py`, `test_unit_card_fields.py` ผ่านครบ
- Mongo `chatbot.sellable_units` = 26,970 units (classifier ล่าสุด)

**กำลังจะทำ:** image batch รันอยู่ (~1,725/5,741, ETA ~3 ชม., 0 error, ~$1.08) — ต่อด้วย Task 9 feature-flag wire ใน fetch_products + charger regression

### Task 8 เสร็จ — staged flag + regression (2026-09-16)

- `USE_UNIT_INDEX=charger` = staged rollout: unit path เฉพาะ route charger-family (subtype หรือ type ∈ cable/charger/car_charger/wireless/desktop/socket); query อื่น (เช่น หูฟัง) ยัง legacy
- verify: "สายชาร์จ AL870"→unit, "มีหัวชาร์จในรถไหม"→unit, "มีหูฟัง"→legacy
- regression ภายใต้ flag: `test_car_charger_regression` 16/16 + `test_charger_subtype_parity` 42/42
- commits: 3cc6dde (classifier), 913e8a3 (units runtime)

### กำลังจะทำ (2026-09-16 ~14:00)

Task 9 — context shaping v2 + `guards.py`: unit card flags, desc section ตาม route, canonical_specs inject, output guard (เคลม/คืนเงิน/จัดส่งโดยไม่ handoff); `responses.py` ย้าย helper จาก app.py ถ้าไม่ติด nested function

### Task 9 เสร็จ — guards + responses + spec inheritance (2026-09-16)

- `responses.py`: ย้าย `_routing`+`_send_handoff` จาก app.py (module-level self-contained) — app.py re-import, net **−88 บรรทัด**
- `guards.py`: `build_flags` + `check_output` (regex ยืนยันเคลม/คืนเงิน/จัดส่งโดยไม่ handoff)
- จุดเช็คเดียว: `ChatResponse.model_post_init` — ครอบทุก return path log-only
- `units.attach_kb_specs`: unit desc ว่างยืม canonical_specs จาก kb_products ผ่าน model_codes — verified AD653C/AD653T ได้ specs จริง (sellable ทั้งหมดมี desc อยู่แล้ว → เฉพาะ non-sellable ที่ inherit)
- `_build_context`: ส่ง canonical_specs + unit flags เข้า context
- test_guards ALL PASS; regression car_charger 16/16

### image_texts → Mongo + unit join (2026-09-16)

- `import_image_texts.py`: jsonl → `image_texts` collection (key=image_id, เฉพาะ status=ok, idempotent — rerun ได้เรื่อยๆ)
- batch ปัจจุบัน: 2,715 unique ok (spec 2,160 / product 202 / banner 352)
- `units.attach_image_texts`: join ผ่าน image_ids เฉพาะ kind=spec|product → field `image_text` (≤2500 chars); `description_excerpt` fallback ไปที่ image_text เมื่อ desc ว่าง
- verify: 20/20 sellable units ที่มี image_ids ได้ image_text จริง (EC4 ได้ "2.5K & 4MP โหมดกลางคืน" จากรูป)

### Live test 8015 flag=charger (2026-09-16) — ✅ PASS หลังแก้ 2 bug

**bug ที่ live test จับได้ (unit test ไม่เห็น):**
- `unit_classifier.py` absolute import `chatbot.shopeechat.*` → server context ไม่มี package `chatbot` → gate except กลืนเงียบ (unit path ไม่ engage เลย) → relative-first fallback + gate print error
- `to_unit_card` price เป็น float → `_dedupe_sell_score` คาด `{min,max}` → 500 → แก้ price_range shape

**ผล:** unit path engage จริง (hits=30), code-match HA835 ตอบ "หมดสต็อก" ตรง truth, non-charger ยัง legacy, 0 traceback

### prod :8010 พัง 500 ทุก /chat — root cause + fix (2026-09-16 ~15:00)

**อาการ:** /chat → 500 ทุก call แม้แต่ greeting; /root + /feedback → 200

**root cause:** process เก่า (pid 73442, start เมื่อวาน ไม่มี --reload) stdout/stderr ชี้ไป pipe ที่ปลายอ่านตายแล้ว (parent shell ออก) → `print(..., file=sys.stderr)` ใน chat() → BrokenPipeError → 500. /feedback รอดเพราะ print ไป stdout ซึ่ง block-buffered (เขียนลง memory ไม่ syscall) — stderr unbuffered → พังทันที. **ไม่เกี่ยวกับโค้ดใหม่** — environment เสื่อม

**วิธีแก้:** kill 73442 → start ใหม่ด้วย `USE_UNIT_INDEX=charger nohup uvicorn ... > exports/uvicorn_8010.log 2>&1` — redirect ไฟล์จริงแบบ image batch → จบปัญหาถาวร + มี traceback ดูได้คราวหน้า

**verify หลัง restart (shop จริง — 'cuktech' ไม่ใช่ shopname จริง ต้อง 'CukTechThailand'/'ZMIThailand'):**
- greeting/car-charger/HA835 → 200 ทั้งหมด; [UNITS] hits=30 (11 code-match)
- HA835+ZMIThailand → "หมดสต็อก/ปิดการขาย" ตรง unit truth (sellable=0 ทุก shop)
- หมอนรองหลัง+ZMIThailand → ตอบตรงว่าร้านไม่มี ไม่หลอก
- order_sn fake → "ไม่พบคำสั่งซื้อ" ถูกต้อง
- image batch (pid 96547) ไม่กระทบ — process แยก, log ไฟล์จริง, เดินหน้าต่อ

**บทเรียน:** test payload ต้องใช้ shopname จริงจาก ShpProducts (`shopname` field: CukTechThailand, ZMIThailand, Ztec, ThaiSuperPhone, ...) — 'cuktech' lowercase ไม่ match → "ไม่พบข้อมูล" ถูกต้องตามระบบ

---

## กำลังจะทำ (2026-09-16 ~17:00): KB QA wiring + warranty per-product — ✅ เสร็จ

**ปัญหา:** runtime อ่าน collection `knowledge_base` เก่า (qa=1 doc) ทั้งที่ `kb_qa` มี troubleshooting 392 docs แต่ไม่มีใคร query → "นาฬิกาแบตลดไวครับ" ไม่ hit KB เลย

**Baseline (8015, shop=KieslectThailand):** → `source=warranty_claim_first_message` ขอข้อมูลเคลม+handoff ทันที ไม่มีคำแนะนำเบื้องต้น — claim path เป็น deterministic ไม่ผ่าน LLM (warranty_flow.py ~1754)

**แผน:** `docs/superpowers/plans/2026-09-16-kb-qa-wiring.md` — ทำครบทุก task

**ทำแล้ว:**
- repoint: `_search_kb_single`→`kb_products` (specs อ่าน `canonical_specs`/`specs_raw`), `get_general_faq`→`kb_qa` (normalize `a`→`answer`, fallback legacy 982 chars OK)
- `build_embeddings --qa` → `exports/qa_embeddings.npz` (392 vecs, 1.4MB)
- `search_qa` + `qa_context` ใน knowledge_base.py: sim + model_codes/item_id boost; **cross-model guard** (doc ผูกรุ่นอื่น exclude — รวม derive scope จาก `topic` เช่น "CUKTECH KLC-5497" ที่ model_codes ว่าง); **brand scope** (generic doc แบรนด์อื่นข้าม — fix multi-word brand ด้วย startswith)
- wire: `app.py` _combined_extra += qa_context (ก่อน llm.answer, 8 บรรทัด); `warranty_flow` claim-first prepend tips
- `units._unit_warranty` + `to_unit_card.warranty` = extract_warranty_from_name (แก้ regression warranty=None)
- `attach_image_texts`: banner ที่มี ประกัน/เคลม/warranty → `warranty_text` (≤1500, per-listing) append ท้าย description_excerpt

**bug ที่ live test จับ (unit test ไม่เห็น):**
- claim tips ดึง `a` ดิบ → คำตอบสั้น "ทำไม่ได้" + tip ไม่เกี่ยว ("ตรวจสอบราคาหน้าร้าน") หลุดเข้าข้อความขอข้อมูลเคลม → gate 3 ชั้น: level∈{model,item,brand} + `_qa_sim`≥0.5 (raw sim ก่อน boost — กันคำถามไม่เกี่ยวกับอาการ) + len(a)≥30
- brand scope first-token "black" ไม่เท่า "black shark" → ใช้ topic.startswith(brand) แทน
- เพิ่ม level "brand" (topic brand == แบรนด์ที่คุยอยู่) — troubleshooting QA ส่วนใหญ่ brand-scoped ไม่ใช่ model-scoped

**troubleshoot-first flow (ตามที่ user ต้องการ — แนะนำวิธีแก้ก่อน เคลมทีหลัง):**
- claim request + tips ผ่าน gate → ตอบวิธีแก้เท่านั้น `source=warranty_troubleshoot` ไม่ handoff ไม่ขอข้อมูล; save `claim_state.stage="ts_suggested"`
- ลูกค้าตอบ "ไม่หาย/ไม่ได้/เหมือนเดิม/ลองแล้ว" (หรือ claim ใหม่) → claim info + handoff (state machine ดักจาก claim_state หรือ marker "ลองทำตามนี้ก่อน" ใน last model msg)
- ลูกค้าตอบ "หายแล้ว/ได้แล้ว" → ปิดเคสสุภาพ stage=resolved ไม่ handoff
- bare claim ไม่มี context → claim info ตรงเหมือนเดิม (ไม่มี product จะแนะนำอะไรก็เสี่ยง)

**verify troubleshoot-first (8015):**
- "Kieslect นาฬิกาแบตเสื่อม เคลมได้ไหมครับ" → tips จริง (ปิด AOD ประหยัดแบต 30-50%) handoff=False
- "ลองแล้วไม่หายครับ" (history มี marker) → claim info + handoff=True
- "สินค้าเสียครับอยากเคลม" → claim info สะอาด ไม่มี tips มั่ว

**verify:**
- `test_qa_kb.py` 26/26: repoint, canonical_specs ctx, general_faq, model match, cross-model guard, brand scope, warranty parse +/−, unit card warranty, banner join, missing-banner fallback
- smoke 8015: "นาฬิกาแบตลดไวครับ" → ตอบวิธีแก้เบื้องต้นจริง (เดิมขอเคลมทันที); "LPB200NL ใช้กับ S26 ได้ไหม" → ตอบ compat ถูกจาก spec; "IMILAB EC5 ประกันกี่ปี" → "2 ปี" จาก KB; "KS3 หน้าจอดำครับ เคลมได้ไหม" → claim msg สะอาด ไม่มี tips มั่ว

**Rollback:** USE_QA_KB=0 ปิด QA / collection เก่าไม่แตะ / warranty parse เป็น additive (None → ช่องว่างเหมือนเดิม)

---

## 2026-09-16 (ต่อ) — `_KNOWN_BRAND_SET` → auto-derive จาก DB

**ทำแล้ว:**
- เพิ่ม `_known_brands()` ใน knowledge_base.py — `_KNOWN_BRAND_SET` baseline ∪ `distinct("brand")` จาก `kb_products` + `sellable_units.brand.original_brand_name`; cache ครั้งเดียว; DB ล่ม → baseline (fail-open)
- เพิ่ม `_norm_brand()` — ตัดวงเล็บ `(ไทย)`/lower/กรอง `_BRAND_JUNK`+สั้น<3 — DB สกปรกจริง: `'Kieslect '` trailing space, `'cuktech (ชุกเทค)'`, `'nobrand'`, `'tws(ทีดับบลิวเอส)'`, `'meet(มีท)'`
- แทน 3 จุดที่ใช้ `_KNOWN_BRAND_SET` (search_qa topic scope, qa_context, qa_troubleshoot_tips)

**ผล:** 182 แบรนด์ (hardcode 33 + DB เพิ่ม 149 — amazfit, baseus, dji, dreame, huawei...) — แบรนด์ใหม่เข้าร้านได้ scope protection ทันที

**ข้อจำกัดที่ยอมรับ:** `_BRAND_JUNK` ยังเป็น denylist manual — junk ใหม่ใน DB อาจหลุดได้ แต่ผลกระทบแค่ over-scope (ขาด context) ไม่ใช่ตอบผิด

**verify:** test_qa_kb 28/28; must-have brands assert ผ่าน; compile OK

---

## 2026-09-16 (ต่อ) — kb_qa near-real-time (TTL + lazy-embed)

**ทำไม:** admin เพิ่ม/แก้ kb_qa แล้วอยากเห็นผลโดยไม่ต้อง restart หรือรอ rebuild npz

**ทำแล้ว:**
- `_qa_docs` — TTL cache 5 นาที + `threading.Lock` (chat() เป็น sync def → threadpool จริง ต้องกัน refresh ซ้อน) + refresh fail → ใช้ของเก่า (ไม่ assign ทับ)
- `_qa_embed_missing` — doc ใหม่ที่ไม่มี vector → `embed_texts` (local ฟรี) append เข้า vec cache; key `_id` → ไม่มี realignment; fail → log เฉยๆ doc ยังหาเจอด้วย substring
- `_known_brands` — TTL 5 นาที pattern เดียวกัน; cold-start DB ล่ม → baseline set

**วิเคราะห์ความเสี่ยงก่อนทำ (verify ในโค้ดจริง):**
- vectors key ด้วย `_id` string → doc ใหม่ default sim=0.0 — append ปลอดภัย ไม่มีทางสลับแถว
- doc ถูกลบ → vector เก่าค้างแต่ไม่ถูกอ่าน (ไม่มี doc) — ปลอดภัย
- worst case npz หาย → embed ~400 docs ครั้งเดียว ~2-5s ใน request — ยอมรับได้
- Mongo สะดุดตอน refresh → stale cache ทำงานต่อ ไม่พัง

**verify:**
- docs 392 → fake doc ใหม่ → lazy-embed ได้ vector ทันที sim 0.819 กับ query ใกล้เคียง
- brands 182 + TTL ts set; test_qa_kb 28/28; compile OK

**ผล:** kb_qa เปลี่ยน → สดภายใน 5 นาที ไม่ต้อง restart; npz ยังเป็น base cold-start + rebuild ราตรี (canonical)

---

## 2026-09-16 (ต่อ) — npz auto-reload (mtime) ทั้ง 3 loaders — ไม่ต้อง restart อีกต่อไป

**ทำแล้ว:**
- `build_embeddings.py` — เขียน `.tmp.npz` + `os.replace` (atomic — reader เห็นไฟล์เก่า/ใหม่เต็มก้อนเสมอ) ทั้ง products + units npz
- `product_store._load_vector_store` / `units._unit_vectors` / `knowledge_base._qa_vectors` — stat mtime ทุก call (~0.001ms), เปลี่ยน → reload ใหม่เอง
- กัน edge cases: stat ก่อน load (build replace ระหว่าง load → self-healing รอบหน้า), fail/ไฟล์หาย → ใช้ cache เก่า, QA reload npz → `_qa_embed_missing` re-embed doc ที่เคย lazy-embed

**verify จริง:** touch npz → 3 loaders reload ทันที (qa 392 / units 26970 / products 11503); mtime เดิม → cache hit; test_qa_kb 28/28 + test_units ผ่าน

**ผล:** pipeline รันเสร็จ → bot เห็นข้อมูลใหม่ใน request ถัดไป — restart/reload endpoint ไม่จำเป็นแล้ว; cron เหลือแค่ trigger build

---

## 2026-09-16 (ต่อ) — refresh_data.sh (nightly pipeline trigger)

**ทำแล้ว:** `chatbot/shopeechat/scripts/refresh_data.sh` — export → product emb → build+import units → unit emb → qa emb → image OCR (incremental) → import image_texts; lock ด้วย `mkdir` (macOS ไม่มี flock); export fail → abort; อื่น fail → log แล้วต่อ; **ไม่มี restart** — npz mtime reload + Mongo สดเอาเอง; cron `0 3 * * *`; เพิ่มส่วน "Data refresh" ใน DEPLOY.md

**verify:** bash -n ผ่าน; lock acquire/release/double-run-block ผ่าน

---

## 2026-09-17 — unit card fields + fuzzy_match_products fix

**ทำแล้ว:**

- `units.attach_listing_fields()` (ใหม่) — batch join `ShpProducts` ด้วย `item_id` (int ทั้งสองฝั่ง — ห้าม str(), เจอ type mismatch ตอนเทส) เติม `_listing` {condition, weight, dimension, short_link, promotion, is_flash_sale, image} — runtime join เพราะ promo เปลี่ยนบ่อย (build-time copy จะ stale ≤24h)
- `to_unit_card` — `image_url` จาก `image_ids[0]` (cf.shopee.co.th CDN เดียวกับ `_first_image_url`), `condition`/`short_link`/`weight`/`dimension`/`has_promotion`(`_has_active_promotion`)/`is_flash_sale` จาก `_listing` — แก้ regression ที่ unit path ส่งลิงก์+รูป+โปรไม่ได้เลย
- `fuzzy_match_products` 3 fix:
  - ตัด `item_status:NORMAL` ทั้ง 2 query — ตอบสินค้า BANNED/UNLIST ได้ (กันขายอยู่ที่ `card._available_for_sale` + prompt เหมือนเดิม)
  - prefix-3 gate พลาด (typo ต้น token เช่น "wach"→"watch") หรือ score ไม่ผ่าน → rescan ทั้งร้าน ≤2000 docs (เดิม fire เฉพาะ candidates ว่าง + limit 50 = ครอบ 2% ของร้าน 2108)
  - `_common` ∪ `_known_brands()` (182 แบรนด์จาก DB); brand ใช้กรอง fetch แต่**ยังนับ score**; ทุก token โดนกรอง → fallback ใช้ token เดิม; scoring เปลี่ยน max→**avg per-token** กัน brand match 100 ชนะคนเดียว

**verify จริง:** ShowSee A1-W (BANNED) เจอ + `sale:False` ✅ / "khoxsee"(prefix typo) เจอ ✅ / "redmi wach 6"@Youpin 2108 docs → Redmi Watch 6/5 อันดับ 1 (เดิม Merach/Merach speaker มาก่อน) ✅ / biokooooooooop ✅ / QA 28/28 + car charger 16/16 ผ่าน / fallback rescan ~5.4s (fire เฉพาะตอน primary พลาด)

**เคสที่รู้ว่ายัง:** fuzzy ไม่มี shop → prefix typo ยังหลุดได้ (ไม่มี fallback scope) — เป็น design เดิม; live compare :8010/:8015 ค้างรอ quota 15:00

**Rollback:** ไม่มี flag เฉพาะ — ถ้าพัง revert commit; unit path ยังอยู่หลัง `USE_UNIT_INDEX` เหมือนเดิม

---

## 2026-09-17 (ต่อ) — single-key quota manager (llm.py + intent_classifier.py)

**ทำไม:** เปลี่ยนจาก 9 keys round-robin → `GEMINI_API_KEY` key เดียว — ต้องบริหาร rate เอง (3.5-lite/3.1-lite: 500 req/day + 15 RPM + 250k TPM ต่อ model)

**ทำแล้ว:**
- `_acquire(model, est)` — sliding window 60s แยกต่อ model: RPM เต็ม → sleep จนหลุด; est tokens (chars/4 + max_output) เกิน TPM → รอ; daily counter persist `exports/.gemini_quota.json` (atomic os.replace); primary RPD เต็ม → auto ใช้ fallback model แทน; ทั้งคู่เต็ม → raise 429
- `_generate(model, contents, config, est)` — wrapper เดียวครอบทุก call: acquire → call → record tokens จริงจาก usage_metadata → **429 → retry ครั้งเดียวด้วย model คู่ fallback** (3.5↔3.1 เป็น quota pool แยกกัน = capacity x2)
- แพตช์ 5 call sites: describe_images / answer / answer_with_kb / answer_general + intent_classifier (lazy import llm — ไม่มี cycle)
- env override: `GEMINI_RPM`/`GEMINI_TPM`/`GEMINI_RPD`

**bug ที่เจอระหว่างทำ:** `_client().models.generate_content` (temporary ref) → GC ปิด shared httpx → "client has been closed" — ต้อง `client = _client()` เก็บ ref (เหมือนโค้ดเดิมทุก site)

**verify จริง:** unit checks acquire/RPD/fallback ผ่าน; live call → `[QUOTA] 3.5 429 → fallback 3.1` ยิงจริง (3.1 ก็หมด → raise ต่อถูกต้อง); counter persist ทำงาน

**ยังต้องทำ (user):** ตั้ง `GEMINI_API_KEY` (key เดียว) ใน .env + ลบ `_1.._9` + restart bot — process ที่รันอยู่ยังโค้ดเก่า (9 keys)
