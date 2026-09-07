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

---

## กำลังจะทำ

### Phase 3C — Order lookup ครบ + Order anchor (2026-09-07) — กำลังจะทำ
- **ปัญหา 1 (shadow bot ส่ง [order] เปล่า)**: `toBotText()` ใน messageService.ts ไม่แปลง order card → ส่ง `[order]` เปล่าให้ bot → `extract_order_sn("[order]")` คืน None → ข้าม order lookup
- **ปัญหา 2 (ข้อมูล order ไม่ครบ)**: `lookup_order()` ดึงแค่ status/items/carrier/create_time → ไม่มี วันที่ชำระ/ส่ง/ถึง, ที่อยู่, ราคา, วิธีชำระ, สถานะยกเลิก
- **ปัญหา 3 (ไม่มี order anchor)**: bot ไม่จำ order เหมือน item anchor → follow-up ถาม "order เดิม" ไม่ได้
- **วิธีแก้**:
  1. Next.js `toBotText()` — แปลง order card เป็น `[order: <order_sn>]` เหมือน `[สินค้า: <item_id>]`
  2. Python `order_store.py` `lookup_order()` — ดึงฟิลด์เพิ่ม: pay_time, ship_by_date, pickup_done_time, cancel_by/reason, recipient_address, cod, estimated_shipping_fee, days_to_ship, item original_price
  3. Python `order_store.py` `build_order_context()` — ใส่ข้อมูลครบใน context ส่ง LLM
  4. Python `conversation_products.py` — เพิ่ม order anchor: `add_order_anchor()`, `get_active_order()`, `resolve_active_order()`
  5. Python `app.py` — order lookup block บันทึก anchor + follow-up ใช้ active order
- **ไฟล์ที่จะแก้**: `messageService.ts`, `order_store.py`, `conversation_products.py`, `app.py`, `SRS_SSD.md`
- **ไม่ละเว้น SRS_SSD.md** — มีการเพิ่ม/แก้ ฟังก์ชันใน Python → ต้องอัปเดต section 6

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
