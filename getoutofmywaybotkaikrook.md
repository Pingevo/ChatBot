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

---

## กำลังจะทำ

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
| `chatbot/shopeechat/app.py` | CONV-ACTIVE ก่อน history, guard placeholder, กัน reset, ข้าม fetch, warranty detection, claim state machine, trust prompt, **State 7 awaiting_claim_info (รับรูปใน claim flow)**, **ข้าม order_lookup ใน claim flow** | C, A, B, D, Q14, **Warranty-Image** |
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
