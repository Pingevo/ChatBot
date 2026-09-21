# getoutofmywaybotkaikrook-condensed.md — Waythrough Log (เวอร์ชันย่อ)

> ย่อมาจาก `getoutofmywaybotkaikrook.md` (8,624 บรรทัด / ~892KB) — ต้นฉบับเต็มยังอยู่ไฟล์เดิม
> เคสที่เขียนซ้ำ 2–4 รอบในต้นฉบับ รวมเป็น entry เดียว (เลือกเวอร์ชันสมบูรณ์สุด)
> ฟิลด์ต่อเคส: เคส/แชท · อาการ · Root cause @ ไฟล์:ฟังก์ชัน · แก้ · verify · อ้างอิง
> วันที่อยู่ในหัวข้อ = วันที่เจอ/แก้ (ต้นฉบับส่วนมากไม่แยกเวลาเจอ vs เวลาแก้)

---

## เคสที่ผ่านแล้ว — ชุดแรก (anchor / warranty / order / ticket panel)

### C — Context loss (ผ่าน)
- เคส/แชท: replay ชุด Q1–Q4 (BioKoop smartwatch)
- อาการ: บอทไม่จำสินค้าที่คุยอยู่ คำตอบสั้น follow-up ไม่เชื่อมสินค้าเดิม
- Root cause: ไม่มีระบบติดตามสินค้าต่อ conversation — ค้นใหม่ทุกข้อความ @ `conversation_products.py` (ไม่มีอยู่), `messageService.ts`
- แก้: สร้าง `conversation_products.py` (anchor = สินค้าที่ลูกค้าส่ง, suggestion = ที่บอทแนะนำ, active = anchor ล่าสุด); `[สินค้า: <item_id>]` tag ใน message; normalize item id ตัด `.0`; stop_words กัน FP model keyword; `lookup_product_card` ดึง price/image
- verify: Q1 item card → card ขึ้น, Q2 follow-up จำ BioKoop ได้, Q3 warranty, Q4 image — ผ่าน
- อ้างอิง: `app.py`, `product_store.py`, `knowledge_base.py`, `replay_compare.py`

### A — Trigger ผิด (ผ่าน)
- เคส/แชท: Q11 "ถ้ามีปัญหาเคลมได้ใช่ไหมครับ"
- อาการ: คำถามรับประกันเข้า claim data-collection flow ผิด
- Root cause: warranty detection จับ claim ก่อนเช็คว่าเป็นคำถาม policy @ `app.py`, `warranty.py`
- แก้: จับคำถามรับประกันก่อนเข้า claim flow
- verify: Q11 ตอบเรื่องรับประกัน ไม่เข้า claim flow

### B — Cascade (ผ่าน)
- เคส/แชท: Q12–Q13 หลัง claim flow
- อาการ: คำถามถัดจาก claim ถูกดักเป็น claim field หมด
- Root cause: claim state machine ไม่รู้ว่าเลิก flow แล้ว @ `app.py`
- แก้: แก้ state machine ให้ออกจาก claim flow ได้
- verify: Q12 trust / Q13 iOS-Android ตอบตรง

### D — Trust (ผ่าน)
- เคส/แชท: Q5/Q8/Q9
- อาการ: ตอบ trust (ของแท้/จัดส่ง) ไม่ดี แนบลิงก์ซ้ำ
- Root cause: prompt+context ไม่มีข้อมูลยืนยัน @ `app.py`, `llm.py`
- แก้: เพิ่ม authenticity / Thai shipping / new-sealed / warranty ใน prompt

### Q14 — ดึงผิดรุ่น (ผ่าน routing, รอ verify answer)
- เคส/แชท: replay BioKoop "ผมขอดูสินค้าจริงได้ไหม"
- อาการ: ดึง Elite2/Ks/Lora2 ทั้งที่ active = BioKoop
- Root cause: (1) CONV-ACTIVE อยู่หลัง history block → history-words ทับ anchor (2) "ดูสินค้า" อยู่ใน new_topic_kws (3) `_ref_regex_products` ถูก reset (4) fetch_products ทับค่าที่ตั้งไว้ @ `app.py`
- แก้: ย้าย CONV-ACTIVE ก่อน history block, เอา "ดูสินค้า" ออกจาก new_topic_kws, กัน reset/fetch เมื่อ conv active
- verify: routing ถูก (products=1 BioKoop) — รอ LLM quota ยืนยัน answer

### Order Lookup — ลูกค้าส่งเลขคำสั่งซื้อ (ผ่าน flow, รอ verify answer)
- อาการ: ลูกค้าส่งเลข order → บอทไม่รู้จัก
- Root cause: ไม่มี order lookup @ `order_store.py` (ใหม่)
- แก้: `extract_order_sn()` จับ order_sn หลายรูปแบบ, `lookup_order()` ดึงสถานะ/สินค้า/ขนส่ง/วันที่, `build_order_context()` + block ใน `app.py` → `llm.answer_general(qtype="order_status")`; ไม่พบ → บอกตรวจเลขอีกครั้ง
- verify: flow ผ่าน (source=order_lookup) — LLM 429 รอ quota

### Ticket Panel — ประวัติคำสั่งซื้อ (ผ่าน build, รอ manual verify)
- อาการ: แอดมินไม่เห็นว่าลูกค้าเคยซื้ออะไร
- แก้: API `/api/admin/conversations/[id]/orders` join `customer_id`=`buyer_user_id` + `OrderHistorySection` ใน `InfoTab.tsx` (5 ล่าสุด + ดูทั้งหมด)
- ข้อจำกัด: order ที่ `buyer_user_id`=0/None เชื่อมไม่ได้
- verify: tsc+build ผ่าน

### Q2/Q6 ตอบไม่ได้ + warranty ห้อย + ตอบสั้น (ผ่านเทส)
- เคส/แชท: Q2 "แอพเชื่อมยังไง", Q6 "สายชาร์จยังไง", Q7 "สายนาฬิกาเปลี่ยนได้ไหม"
- อาการ: ตอบ "ไม่มีข้อมูล" ทั้งที่มี spec; เงื่อนไขประกันห้อยทุกคำตอบ; ตอบสั้นเกิน
- Root cause: `desc_kw` ขาดคำ → `include_desc=False`; "เปลี่ยน" อยู่ใน warranty kw; prompt ห้ามอ้าง history + ตัด model history สั้น @ `llm.py`, `knowledge_base.py`, `app.py`
- แก้: เพิ่มคำใน `desc_kw`, warranty kw เป็น "เปลี่ยนสินค้า/ใหม่/ตัว", เพิ่ม State 6 post-handoff (หยุดตอบหลัง handoff), prompt อนุญาต history สินค้าเดียวกัน + ตอบ 2–3 บรรทัด
- verify: Q2/Q6/Q7 ผ่าน

### Replay UI — Inbox picker + History (ผ่าน build, รอทดสอบจริง)
- อาการ: replay-compare รันได้แค่ batch เลือกแชทเฉพาะไม่ได้ ไม่มี history
- แก้: action `run_conv` + `?history=1` ใน `/api/replay-compare` + UI 3 tabs (เลือกแชท/History/ไฟล์ผล) @ `replay-compare/route.ts`, `replay-compare/page.tsx`
- verify: typecheck+build ผ่าน

---

## ผ่านแล้ว — retrieval / charger / anchor

### Phase 2Z++++ — บอทบอกไม่มีสาย Lightning ทั้งที่มีสินค้าจริง (2026-09-07, impl เสร็จ รอ verify)
- เคส/แชท: ZMIThailand — "สายชาร์จรุ่นไหนที่เหมาะกัลไอโฟน 13คะ" (รอ replay bbeem.4343)
- อาการ: ตอบมีแค่ USB-C to USB-C ทั้งที่ Q1 แนะนำสาย ZTEC (มี Lightning) ไว้
- Root cause: "13คะ" ไม่ match `is_target_device_kw` → `_cur_model_kw` ไม่ว่าง → ข้าม CONV-ACTIVE → vector search ใหม่ได้แค่ USB-C @ `knowledge_base.py:is_target_device_kw`
- แก้: regex จับ 11–17 ตามด้วยอักษรไทย (`^1[1-7][\u0E00-\u0E7F]+$`) + `ไอโฟน\s*\d+`
- verify: unit 14 cases ผ่าน — รอ replay จริง

### Phase 3C — Order lookup ครบ + Order anchor (2026-09-07, impl เสร็จ รอ verify)
- อาการ: `[order]` เปล่าส่งบอท; order ข้อมูลไม่ครบ; ไม่มี order anchor; ส่งเลขเฉยๆตอบยาว; 4 flow ไม่ส่ง order_sn
- Root cause: `toBotText()` ไม่แปลง order card; `lookup_order` field น้อย; ไม่มี anchor/order_sn field @ `messageService.ts`, `order_store.py`, `conversation_products.py`, `app.py`
- แก้: order card → `[order: sn]`; ดึง field ครบ (pay/ship/ที่อยู่/ราคา/COD); `add_order_anchor`/`get_active_order_sn`/`is_order_question`; ส่งเลขเฉยๆ → ตอบรับทราบสั้น+เก็บ anchor; `ChatRequest.order_sn` + ส่งจาก replay/live/test-assignment
- verify: py_compile+tsc+lookup ครบ — รอ e2e; ⚠️ ShpOrders 3.8M docs ไม่มี index `buyer_user_id` → query 6.5s

### Phase 2Z+++++ — บอทบอกไม่มีหัวชาร์จในรถทั้งที่มีจริง (2026-09-13, impl+verify ผ่าน)
- เคส/แชท: CukTechThailand — "มีหัวชาจในรถไหม" (typo ขาด ร์) — ร้านมี CC903P/WCJ153
- Root cause (5 จุด) @ `product_store.py`, `intent_classifier.py`: (1) cat_name `car_charger` ไม่ครอบ "Spare Parts and Accessories for Vehicles" (2) limit 100 กด car charger 2 ตัวออก (3) `"ในรถ"` kw กว้าง → FP สายชาร์จ (4) typo "หัวชาจ" ไม่ fix ใน `_detect_product_types` (5) intent prompt ไม่มี car_charger
- แก้: เพิ่ม cat_name, แยก query car_charger ออกจาก charger ทั่วไป, ลบ "ในรถ" ลอย, typo fix ใน `_detect_product_types`, เพิ่ม subtype ใน intent prompt
- verify: regression 16/16 ผ่าน — รอ replay e2e; สร้าง `test_car_charger_regression.py`

### Shadow Inbox — Trash tab แสดงเป็นแชท + restore (2026-09-10, verified)
- อาการ: trash tab โชว์ message เดี่ยวไม่ group แชท; restore แล้ว panel ว่าง
- Root cause: trash ใช้ `<ul>` ไม่ group; `ShadowConversationPanel` กรองเฉพาะที่มี `generation_batch_id` → replies เก่า (ก่อน 3B-6) ถูกทิ้ง @ `shadowReplyService.ts`, `conversations/route.ts`, `shadow-inbox/page.tsx`, `ShadowConversationPanel.tsx`
- แก้: `restoreShadowRepliesByConversation`, GET `?deleted=1` + PUT restore, trash ใช้ `ChatList`+panel เหมือน history, filter ผ่าน replies ที่ไม่มี batch_id
- verify: tsc+build+manual ผ่าน

### Phase 3b — dual-tier recommendation + connector hard filter + wattage asc (2026-09-16, verified)
- เคส/แชท: KingGadgets — "สายชาร์จ mi 17 ultra", "หัวชาร์จ USB-C ทั่วไป"
- อาการ: device-spec re-query ได้ compat แค่ 1 ตัว ไม่ sort wattage → LLM เห็นตัวเลือกไม่ครบ
- Root cause: ไม่มี sort + ไม่มีกฎ dual-tier @ `app.py` (`_extract_max_wattage`, device-spec block), `llm.py` SYSTEM_INSTRUCTION
- แก้: sort wattage asc; context note: เสนอสูงสุด 2 ตัว (baseline+upgrade), connector type ตรงเป๊ะห้ามข้าม, protocol ต้องยืนยันจาก description
- verify: regression 16/16 + replay 3 เคสผ่าน (30-pin ตอบถูก, dual-tier ทำงาน); ⚠️ connector filter ยังเป็น LLM-level ไม่ใช่ deterministic

### Phase 3c — `_detect_charger_subtype` bare "หัว"/"สาย" token match (2026-09-19, verified)
- อาการ: substring match `"หัว" in low` → FP "หัวเตียง"→adapter, "สายรุ้ง"→cable
- Root cause: substring match ล้วน; newmm ตัดคำผสมไม่สม่ำเสมอ ("หัวเตียง"→['หัว','เตียง'] แต่ "หัวใจ"→รวม) @ `product_store.py:_detect_charger_subtype`
- แก้: hybrid — `word_tokenize` + context check (token ถัดไปต้องเป็น charger context) + `_other_prod_kws` blacklist เพิ่ม ("สายไฟ/ยาง/พาน/ลม/ฝน") + guard `ไร้สาย`; fallback substring เดิมเมื่อไม่มี pythainlp
- verify: parity 42/42 (เดิม 20/42), car_charger 16/16, pingevox_mistore 42/42

### EC6 Anchor Bug — แนะนำสินค้าอื่นทั้งที่ลูกค้าส่ง item card (2026-09-10, verified)
- เคส/แชท: hawkeyes69 — ส่ง EC6 Panorama แล้วถาม "Ec6 ใช้กับ app xiaomi จีนได้ไหม" → บอทแนะนำ EC6 Dual Pro 3K + ตอบขัดแย้งกันเอง
- Root cause: `extract_model_keywords` คืน ["Ec6"] → `_cur_model_kw` ไม่ว่าง → ข้าม anchor; แม้กรองออกแล้ว "ใช้กับ"+"xiaomi" → compat+target → fall through fetch @ `app.py` CONV-ACTIVE (~L4098)
- แก้: กรอง `_cur_model_kw` ที่ตรงชื่อ active product (เฉพาะ kw มีตัวเลข — กันกรอง brand); flag `_kw_matched_anchor` block compat+target fall-through
- verify: unit 9/9 + regression 16/16 — รอ replay hawkeyes69

### CTL301 — model code ไม่ส่ง description + uncertainty cascade (2026-09-10, verified)
- เคส/แชท: pingevox — "ctl301" → ตอบ "ไม่มีรายละเอียด + ทักแอดมิน" → trigger web search พัง
- Root cause 3 ข้อ: (1) `_record_suggestion_products` บันทึก anchor ผิด (CTC615W แทน CTL301) (2) `_clean_description` กรอง desc ออกเพราะ "ctl301" ไม่ match kw (3) LLM ถูกสั่งพูด "ทักแอดมิน" ตอน desc ว่าง → trigger web search @ `app.py`, `product_store.py`, `llm.py`
- แก้: text-based anchor จาก model kw ในข้อความ (`is_anchor, source="user_text"`); message มี alnum token ≥4 ตัว → `want_spec=True`; ลบ "ทักแอดมิน" จาก no_desc_note
- verify: test_pingevox_mistore 42/42 ผ่าน

### Shadow Inbox — panel โชว์การ์ดสินค้า 30 ใบ (2026-09-11, ผ่าน)
- อาการ: panel กลางโชว์ product card 30 ใบ/คำตอบ (ทั้ง RAG context) ทั้งที่แนะนำจริง 1–3
- Root cause: ส่ง `bot_products` (context 30 รายการ) เข้า `MessageContent` @ `ShadowConversationPanel.tsx`
- แก้: ส่ง `products: undefined` ฝั่ง bot เรา (Zaapi ยังโชว์การ์ดจริง); `bot_products` ยังเก็บ DB ครบ

### FILTER-UNAVAILABLE — RAG กรอง status/stock ออก + tier merge (2026-09-10/12, verified)
- อาการ: RAG กรอง sold_out/non-NORMAL ออก → ถามสินค้าเก่า/เลิกขายตอบไม่ได้; exact match อาจโดน limit ตัด
- Root cause: `filter_unavailable=True` บางจุด + ไม่มี tier กัน exact-match โดนตัด @ `app.py` fetch (~L4820/5598), `llm.py` SYSTEM_INSTRUCTION
- แก้: `filter_unavailable=False` ทุกจุด (RAG ไม่กรอง — LLM ตัดสินใจเชียร์ขาย); `_apply_product_tiers` (Tier A exact match ใส่เสมอ, Tier B sort normal+stock ก่อนตัด limit); prompt 3 กฎ (เชียร์ขายเฉพาะ NORMAL+ไม่หมด / เลิกขายตอบสเปคได้ห้ามเสนอขาย / เคลมห้ามแนะนำซื้อ)
- verify: regression 16/16 + replay 8Q (sold_out ตอบ "หมด" ไม่เสนอลิงก์ตาย); ⚠️ KB path ไม่ผ่าน tier merge (pre-existing)

### Phase 4 — device-spec-lookup ไม่ผูก intent + spec-based retrieval (2026-09-10, verified)
- เคส/แชท: pingevox "อยากได้ของที่ใช้กับ xiaomi 17 ultra", OnePlus 13 powerbank
- อาการ: intent=product_recommend (ไม่ใช่ compatibility_check) → spec lookup ไม่ทำงาน → query DB ด้วยชื่ออุปกรณ์ตรงๆ แมตช์ผิด
- Root cause: trigger ผูก intent==compatibility_check @ `app.py` (~L5603), `intent_classifier.py`
- แก้: trigger = `target_device` ไม่ว่าง (ไม่ผูก intent) + regex fallback สกัด device; intent prompt สกัด target_device เสมอ; re-query DB ด้วย spec keywords (90W/PPS/USB-C) ไม่ใช่ชื่อเครื่อง; `_resolve_charger_subtype` คง subtype
- verify: regression 16/16 + replay (แนะนำ 140W สำหรับ 90W spec ถูก); bug แก้ระหว่างทาง: `_resolve_charger_subtype` เรียกผิด signature

### Phase 5 — stock จาก `shopee_stock[].stock` แทน `summary_info` (2026-09-10, verified)
- อาการ: รายงาน stock เกินจริง (เช่น shopee=0 แต่รายงาน 40–100)
- Root cause: `summary_info.total_available_stock` รวม `seller_stock` (สต็อกที่ไม่ได้ลง Shopee) @ `product_store.py:to_product_card`, `_is_sold_out`
- แก้: helper `_shopee_stock(model_doc)` sum `stock_info_v2.shopee_stock[].stock` (fail-safe → 0); ใช้ทั้ง 2 จุด
- verify: mock 9/9 + regression 16/16 + replay (sold_out ถูกต้อง)

### Charger Subtype Consolidation — รวม `_detect_charger_subtype` + dedup (2026-09-16, impl รอ verify replay)
- อาการ: เรียก `_detect_charger_subtype` 22 จุด args ต่างกัน → subtype ไม่สอดคล้อง; dedup 2 ชุด (`_kb_base_name` vs `_base_name`) ซ้ำกัน
- Root cause: ไม่มี priority ตายตัว @ `app.py`
- แก้: `_resolve_charger_subtype` (priority: anchor → msg strong kw → intent → msg → retrieval) แทน 8 จุด, 14 จุดคง `_detect` ตรง; `_dedupe_products` module-level แทน 3 บล็อก (ลด ~140 บรรทัด)
- verify: py_compile + regression 16/16 + edge cases 10/10 — รอ replay

### Legacy Fix — กลับใช้ legacy app.py (2026-09-09/15, impl 4/4 รอ verify replay)
- อาการ: บอทตอบแย่ลง — layer ครอบ layer, search ตอบตรงไม่เข้า LLM2, guard handoff ก่อน search
- Root cause 4 จุด @ `app.py`: (1) KB path เรียก `search_and_answer` ตอบตรง (2) NO-PRODUCT-GUARD อยู่ก่อน web search (3) `filter_unavailable` กรองใน RAG (4) web search fallback 2 ชุด copy กัน
- แก้: `search_and_answer`→`search_and_extract`+re-query+LLM2; ย้าย guard หลัง search (`_guard_ws_available`); filter_unavailable=False; รวม fallback เป็น `_web_search_reanswer` ชุดเดียว (ลด ~470 บรรทัด)
- verify: py_compile + regression 16/16 — รอ replay จริง
- อ้างอิง: `search_and_answer` deprecated → ใช้ `search_and_extract`

### Phase 2Z++++++ — แนะนำของหมดสต็อก + ลืม subtype + ไม่รู้ device spec (2026-09-14, impl รอ verify)
- เคส/แชท: pingevox — ส่ง CTL301 (Lightning) แล้วถาม "ของที่ใช้กับ xiaomi 17 ultra" → แนะนำหัวชาร์จ 45W หมดสต็อก
- Root cause: `filter_unavailable=False` ใน compat; compat-retrieval override ทับ subtype anchor; subtype_override ใช้ intent null; prompt ไม่รู้ spec 90W; `search_and_answer` ไม่ strip URL @ `app.py`, `web_search.py`
- แก้: guard `_hybrid_anchor_card` ครอบ 2 override; device spec lookup (web search → spec → re-query); strip URL ใน `search_and_answer`
- verify: py_compile + regression 16/16 — รอ replay pingevox
- อ้างอิง: ต่อยอดเป็น Phase 4 (trigger ไม่ผูก intent)

### include_desc merge — intent False แต่ keyword True → ไม่ส่ง description
- เคส/แชท: YoupinOfficialStore BioKoop — "ขอรายละเอียดเพิ่มเพิ่มได้ไหมครับ" → ตอบ "ไม่มีรายละเอียด" ทั้งที่ desc ยาว
- Root cause: intent confidence ≥0.7 → ใช้ `needs_description` จาก intent ล้วน ไม่เช็ค keyword @ `llm.py` (~L541)
- แก้: `include_desc = _intent_desc or _kw_match`
- verify: py_compile + curl 2 เคสผ่าน

### Rejection memory — แนะนำสินค้าที่ลูกค้าปฏิเสธซ้ำ
- เคส/แชท: CukTechThailand — ลูกค้าปฏิเสธ C2C515 (สาย 100W คู่หัว 140W) แล้วบอทกลับไปแนะนำอีก
- Root cause: RAG ดึงใหม่ทุกรอบ; LLM ไม่รู้ว่าถูกปฏิเสธ; history truncate 200 ตัวอักษร @ `app.py` (~L3920)
- แก้: สแกน history หา model code + negative signals (ทำไม/ไม่เอา/ดีกว่า) รวม indirect ref ("สาย"→C2C/CTC, "หัว"→AD) → extra_context "ลูกค้าปฏิเสธ X — ห้ามแนะนำซ้ำ"
- verify: py_compile + curl 3 เคสผ่าน

---

## ผ่านแล้ว — warranty / claim / post-handoff

### Phase 2Z — Bot ตีรูปเฉยๆ เป็น claim warranty (2026-09-12, impl เสร็จ)
- อาการ: ลูกค้าส่งรูปเฉยๆ → ตอบ "รอแอดมิน" + handoff
- Root cause: vision_context สั่ง "รูปสินค้าเสีย→ถามเคลม" ไม่มีเงื่อนไขลูกค้าบอกเคลมก่อน; prompt ไม่มีกฎ "ส่งรูปเฉยๆ≠claim" @ `app.py` vision_context, `llm.py` SYSTEM_INSTRUCTION
- แก้: เงื่อนไขต้องพิมพ์เคลม/สินค้าเสีย/ซ่อม; รูปปกติ→แนะนำขาย; ห้าม handoff ถ้าไม่ได้ขอเคลม

### Phase 2Z+ — warranty state machine ตีรูปเป็น claim evidence (2026-09-12, impl เสร็จ)
- อาการ: เหมือน 2Z แต่สาเหตุจริงคือ state machine ไม่ใช่ LLM
- Root cause: state machine สแกน history **ทั้งหมด** หา warranty kw — history มี "ประกัน" (Q5) → ทุกรูปต่อมา = claim evidence @ `app.py` (~L1425-1459)
- แก้: เช็คแค่ history 3 ข้อความล่าสุด + ข้อความปัจจุบันต้องมี warranty kw

### Phase 2Z++ — follow-up ลืมสินค้าเดิม + warranty skip ไม่ทำงาน (2026-09-12, impl เสร็จ)
- อาการ 1: "อันนี้ฟังเพลงโดยไม่เชื่อมบลูทูธได้ไหม" (active=iSUPER Swim) → ดึงสินค้าอื่นตอบผิด — vector search ไม่เจอ + REF-REGEX ต้องการ digit → ไป shop fallback
- แก้ 1: REF-NAME-FALLBACK — follow-up มี ref_models แต่ vector ไม่เจอ → Mongo regex จากชื่อเต็ม @ `app.py`
- อาการ 2: warranty skip เงื่อนไข `not req.message.strip()` ไม่ทำงานเพราะ message = "[รูปภาพ]"
- แก้ 2: ตัด image placeholder ออกก่อนเช็คว่าง

### Phase 2Y — สับสน MagSafe "ยึดแม่เหล็ก" vs "ชาร์จแม่เหล็ก" (2026-09-12, impl เสร็จ)
- เคส/แชท: "ชาร์จ Magsafe ได้ไหม" → ตอบ "รองรับ MagSafe" (หมายถึงยึด) → ลูกค้าเข้าใจผิด
- Root cause: prompt ไม่สอนแยก 2 ความหมาย @ `llm.py` SYSTEM_INSTRUCTION
- แก้: กฎแยก magnetic attachment vs wireless charging; พัดลมระบายความร้อนไม่มีชาร์จไฟ → ตอบชัด; ห้ามใช้ "รองรับ MagSafe" กับของที่ไม่มีชาร์จไฟ

### Phase 2B — เคส patintidamanolai (2026-09-12, impl รอ verify)
- เคส/แชท: patintidamanolai — "ชาร์จไม่เข้า" ซ้ำ + ส่งวิดีโอ
- อาการ: บอทตอบ troubleshooting วน ไม่เข้า claim; LLM override กลับเป็น product; รูปใน warranty context ตอบ product info สินค้าเก่า
- Root cause: "ชาร์จไม่เข้า" อยู่แค่ใน `_symptom_kws` (ต้อง match claim pattern ก่อน); LLM override ไม่มี guard; State 7 ทำงานเฉพาะเมื่อบอทขอ claim info ใน last msg @ `warranty.py:_CLAIM_REQUEST_INDICATORS`, `app.py`
- แก้: เพิ่ม charging symptoms ใน `_CLAIM_REQUEST_INDICATORS` ตรง; "repeated complaint ≥2 ครั้ง" ห้าม LLM override; warranty context image check (history มี warranty kw + ส่งรูป/วิดีโอ = claim evidence)

### Phase 2C — Regression check (2026-09-12, ผ่าน)
- เช็คเคสเก่า C/A/B/D/Order/short-answer/1F/Q9 ไม่พัง + edge เพิ่ม: "มีสายแรงกว่านี้ไหม [รูปภาพ]" ไม่ตีเป็น claim, "ใช้ไม่ได้" ใน `_warranty_q_kws`, Q3 complaint แรกห้าม override
- verify: py_compile + tsc ผ่าน

### Phase 2A — State-driven open/closed (2026-09-12, impl รอ verify)
- อาการ: ปุ่ม "ปิดแชท" ใน test chat แค่ setHandedOff client-side → บอทยังล็อค post-handoff จาก keyword ใน history
- Root cause: ไม่มี API ปิดแชท / `ChatRequest` ไม่มี `ticket_state` / post-handoff อนุมานจาก text @ `app.py`, `botCallService.ts`, `TestChatClient.tsx`
- แก้: endpoint `/test-chat/sessions/{id}/close|reopen`; `ticket_state` field + `resolveTicketState`; บอทใช้ state ตัดสิน (closed→ข้ามล็อค, handoff/open→ล็อค, None→fallback history scan); `post_handoff_exceptions` ต่อร้านใน ShopSettings
- verify: py_compile+tsc — รอ lifecycle จริง

### Phase 1F-Warranty — review request + phone extraction (2026-09-04, verified)
- เคส/แชท: หลัง handoff — "ทวนข้อมูลที่ผมให้ไปหน่อย" ตอบ generic; "087 788 7888" ดึงเป็นชื่อแทนเบอร์
- Root cause: `_PHONE_PATTERN` ไม่ลบ space/`-`; `_post_handoff_has_info` เช็คแค่ order_id; ไม่มี review state @ `warranty.py`, `app.py`
- แก้: ลบ space/`-` ก่อน match phone; เพิ่ม phone/name ใน has_info; review request state ดึง info จาก history + กรอง name มีตัวเลข
- verify: Q7 เบอร์ถูก, Q8 ทวนจริง, py_compile

### Phase 1F-PostHandoff — lock-in escape (2026-09-04, verified)
- อาการ: หลัง handoff ทุกข้อความถูกล็อค "ระบบได้บันทึกข้อมูล" แม้ถามสินค้าชัดๆ
- Root cause: `if _bot_handed_off and not _post_handoff_has_info` ล็อคทุกอย่างไม่เช็ค product question @ `app.py`
- แก้: `_is_post_handoff_product_q` — มี product kw + ไม่มี warranty kw → ปล่อยเส้นทางปกติ ("เคลมสายชาร์จ" ยังล็อค)

---

## ผ่านแล้ว — ChatAdminWeb (inbox / shadow / ticket / dashboard)

### Replay-compare inbox ค้างเพราะ limit:10000 (2026-09-10, ผ่าน)
- Root cause: `loadInbox` ยิง `/admin/conversations?limit=10000` ทีเดียว → timeout @ `replay-compare/page.tsx`
- แก้: ใช้ `useSharedConversations` (pageSize 50 + loadMore on scroll + server search debounce)
- verify: tsc+build

### /team ตัวเลข unassigned ไม่จริง (2026-09-10, ผ่าน)
- อาการ: โชว์ "4,995 ยังไม่มอบหมาย" ทั้งที่จริง 142,293
- Root cause: `listConversations({limit:5000})` แล้ว filter ใน memory @ `/api/team/route.ts`
- แก้: countDocuments ตรงใน DB (total/assigned/unassigned แยก handoff/open) + UI แสดงแยกย่อย

### /dashboard ช้า + นับแชทผิด (2026-09-10, ผ่าน)
- อาการ: โหลด 30s+; ลูกค้าทักแชทเดิมวันนี้ไม่นับ "วันนี้"
- Root cause: `dateFilter("created_at")` 11 queries แต่ไม่มี index (scan 142K/query); created_at = วันเริ่มแชทครั้งแรก @ `api/stats/dashboard/route.ts`
- แก้: ใช้ `last_message_timestamp` (มี index) — ความหมายเปลี่ยนเป็น "แชทที่มี activity ในช่วง"

### /dashboard error + โหลดหนัก (2026-09-10, ผ่าน)
- Root cause เพิ่ม: `computeResponseStats` โหลด messages 1.1M เข้า memory ตอน range=all; ไม่มี cache; ไม่มี client timeout @ `api/stats/dashboard/route.ts`, `services.ts`
- แก้: จำกัด stats 30 วัน, cache TTL 60s (20 keys), client timeout 60s

### Shadow Inbox History — panel กลางไม่โชว์ bot reply (2026-09-11, ผ่าน)
- Root cause: โหลด replies แค่ 500 ล่าสุด แต่ list แสดงทุกแชท → แชทนอก 500 → panel ว่าง @ `shadow-inbox/page.tsx`
- แก้: `selectedConvReplies` — ตอนเลือกแชทดึง replies ของแชทนั้นตรงๆ ไม่จำกัด

### Shadow Inbox History — timeout 30s (2026-09-11, ผ่าน)
- Root cause: `distinct(conversation_id)` + `$in` lookup พันแชทพร้อมกัน @ `api/shadow-inbox/conversations/route.ts`
- แก้: cursor pagination (group by conv + sort + limit 200/page) + `loadMoreHistory/Trash` on scroll

### Shadow Inbox History — กระพริบ/แชทหายเมื่อ poll (2026-09-11, ผ่าน)
- Root cause: polling 20s เรียก `load()` ทับ list ทั้งหมด → page 2+ หาย → แชทที่เลือกหลุด @ `shadow-inbox/page.tsx`
- แก้: ปิด polling ใน tab History/Trash (ข้อมูลอดีต)

### Live Assignment — ปิดแชทแล้วเปิดใหม่ไม่ประมวลผลข้อความใหม่ (2026-09-10, impl+build รอ verify)
- อาการ: ปิดแชท → auto-close → ข้อความใหม่เข้า → ปุ่ม "เปิดแชทใหม่" แค่ toast ไม่ทำงาน
- Root cause: `closeChat` → `mock_status="closed"` → UI โชว์ปุ่มเปิดใหม่ แต่ `handleReopen` ไม่เรียก API @ `live-assignment/page.tsx`, `TicketChatPanel.tsx`, `liveAssignmentService.ts`
- แก้: `handleReopen` เรียก closeChat API จริง (close→เช็คข้อความ→reopen→ประมวลผล) + prop `reopening` disable ปุ่ม

### Phase 1 — Inbox pagination + page-scoped unanswered + assigned filter (2026-09-10, impl รอ verify)
- อาการ: inbox ช้า (limit=2000 โชว์ทีละ 50), search สแกนทั้ง DB, `buildUnansweredMap` สแกนทั้ง messages ทุก request, assigned filter ทำใน JS
- Root cause: กรองหลังดึง @ `conversationService.ts`, `route.ts`, `useSharedConversations.ts`, `ChatList.tsx`
- แก้: cursor pagination (50/page), `getAssignedConversationIds` pre-fetch จาก `status_conversation`, unanswered map page-scoped (`$in` + index), cache 5s, index ใหม่บน `status_conversation`, head/tail split ใน frontend
- verify: tsc — รอ manual; ⚠️ ต้อง restart เพื่อสร้าง index

### Role Permission System Restructure (2026-09-07, impl รอ verify)
- อาการ: hierarchy เดิม (superadmin>admin) ไม่ละเอียด — admin เห็นทุกหน้า
- แก้: page-based permission (`lib/roles.ts`+`authorize.ts`) — none/read/edit ต่อหน้าต่อ role; rename `/admin-kpi`→`/admin-review-kpi`; sidebar 5 หมวด + collapsible; page guards `requirePageEdit`/`requirePageAccess`
- verify: tsc ผ่าน

### Phase 3B-6 — Shadow-bot `generation_batch_id` (2026-09-07, impl รอ verify)
- อาการ: Generate ซ้ำแชทเดิม → docs ปนกัน; annotation ผูก conv เดียวทับรอบเก่า
- แก้: `generation_batch_id` ต่อรอบ + `listGenerationBatches` + annotation upsert key รวม batch + UI batch selector @ `shadowReplyService.ts`, `chatAnnotationService.ts`, `ShadowConversationPanel.tsx`, `schema.md`

### Phase 3B-6-fix — annotation 500 + batch selector เด้ง (2026-09-07, impl รอ verify)
- อาการ: เลือกรอบ 1/2 เด้งกลับ 2/2; add annotation รอบ 2 → 500
- Root cause: useEffect dep `historyReplies` (array ใหม่ทุก poll) → reset selection; unique index `{scope,conversation_id}` ไม่รวม batch_id @ `ShadowConversationPanel.tsx`, `mongoClient.ts`
- แก้: deps ใช้ `historyReplies?.length` + ไม่ reset ถ้าเลือกยังอยู่; drop index เก่า → partial unique 2 ตัว (มี/ไม่มี batch_id)

### Phase 3B-7 — Test-assignment `replay_batch_id` (2026-09-07, impl รอ verify)
- อาการ: replay ซ้ำแชทเดิม → upsert ทับผลเก่า
- แก้: `replay_batch_id` + `insertOne` ทุกรอบ + `listReplayBatches` + annotation reuse field `generation_batch_id` + UI selector @ `testAssignmentService.ts`, routes, `schema.md`

### Phase 3B-8 — Admin-chat-result รองรับ batch (2026-09-07, impl รอ verify)
- อาการ: 4 admins × 2 batches = 8 docs กลาย 1 row ปน
- แก้: group key `scope-conv-admin-batch` + `batch_id` ใน ResultItem/ConversationItem + label 8 ตัวท้าย @ `admin-chat-result` route+page

### Phase 3B — Test-assignment + Shadow-bot restructure + Markup (2026-09-07, impl รอ verify)
- ทำ: `chat_annotations` collection (dot สี+note ต่อแชท ใช้ร่วม); test-assignment 3 tabs (all/roll/history); shadow-bot ลบ "Generate ทีละข้อ" เหลือทั้งแชท + roll batch + handoff bubble; history แยกตามแอดมิน
- verify: tsc — รอ manual

### Phase 3A — Admin KPI Dashboard + Visibility per admin (2026-09-07, impl รอ verify)
- อาการ: ไม่มี KPI รวมว่าแอดมิน replay/ให้คะแนน/คอมเมนต์อะไร
- แก้: `adminKpiService` aggregate จาก test_chat_ratings+test_assignment+shadow_replies+admin_logs; API+หน้า `/admin-kpi` (dev/superadmin); visibility per admin (admin เห็นเฉพาะของตัวเอง); fix rate ไม่ reload / คะแนนหาย
- verify: tsc

### InfoTab — แสดงชื่อแอดมินแทน admin_id (2026-09-05, impl เสร็จ)
- Root cause: ใช้ `m.admin_id || m.admin_name` เป็น key แล้วแสดง key @ `InfoTab.tsx`
- แก้: dedup ตาม admin_id แต่แสดง `admin_name` ก่อน

### Phase 2X — /tickets auto-reopen แยกจาก botworker (2026-09-12, impl เสร็จ)
- อาการ: หลัง 2V botworker เขียน test_status_conversation → /tickets ไม่เห็น reopen เมื่อลูกค้าทักใหม่
- แก้: auto-reopen ใน `/admin/conversations` API — closed + last_message_timestamp > closed_at → reopen `status_conversation` (status=bot, clear assigned_to) @ `api/admin/conversations/route.ts`

### Phase 2W — History tab แสดงเวอร์ชันเก่า bot reply (2026-09-12, impl เสร็จ)
- อาการ: Generate ซ้ำ → เห็นแค่คำตอบล่าสุด
- แก้: group by inbound_message_id sort desc — ล่าสุด=botReply, ที่เหลือ=`allVersions` + OldVersionsButton @ `ShadowConversationPanel.tsx`

### Phase 2V — แยก status_conversation ระหว่าง botworker/ticket (2026-09-12, impl เสร็จ)
- อาการ: botworker เขียน status_conversation ร่วมกับ /tickets → handoff/reopen กระทบ ticket จริง
- แก้: botworker อ่าน status_conversation (read-only) + เขียน `test_status_conversation` source="botworker"; API `/api/botworker/conversations`; /botworker UI อ่านจากนั้น @ `testStatusConversationService.ts`, `botWorkerService.ts`, `botworker/page.tsx`

### Phase 2U — เขียน /botworker ใหม่เหมือน /tickets (2026-09-12, impl เสร็จ)
- แก้: ซ้าย `ChatList` เดียวกับ tickets; กลาง `BotWorkerChatPanel` 3 สี (user เทา / zaapi เขียว / bot ฟ้า) + multi-bubble `|||`; ขวา InfoTab/ChatLogTab/ProductsTab @ `botworker/page.tsx` (เขียนใหม่)

### Phase 2T — bot เห็น history ถูกต้อง + UI 3 สี (2026-09-12, impl เสร็จ)
- อาการ: `getHistoryForBot` อ่าน messages_shp role=user+bot → bot เห็นคำตอบ Zaapi ไม่เห็นของตัวเอง
- แก้: user จาก messages_shp role=user + bot replies จาก shadow_replies merge ตามเวลา (ไม่เห็น zaapi/admin); API `/api/botworker/conversations/:id/messages` merge 3 แหล่ง @ `messageService.ts`, `botworker/page.tsx`

### Phase 2S — สร้างหน้า /botworker (2026-09-12, impl เสร็จ)
- เหตุ: ต้องมีที่ดูคำตอบ botworker auto (mode=standalone) แยกจาก shadow-inbox
- แก้: API `/api/botworker/replies` + หน้า layout ticket + Sidebar item

### Phase 2R — field `mode` ใน shadow_replies (2026-09-12, impl เสร็จ)
- แก้: `mode: standalone|shadowbot|ticket` แยกจาก `origin` (worker→standalone, manual→shadowbot) + filter `?mode=` @ `shadowReplyService.ts`, `botWorkerService.ts`, `shadow-inbox/route.ts`

### Phase 2Q — เอา limit 20 ออก + concurrency limiter (2026-09-12, impl เสร็จ)
- อาการ: pollNewMessages limit=20 → 500 ข้อความใช้ 25 cycles
- แก้: เอา limit ออก + semaphore `acquireBotSlot`/`releaseBotSlot` (MAX_CONCURRENT=50, ปรับใน /admin-config) @ `botWorkerService.ts`, `bot-worker.ts`

### Phase 2P — botworker ประมวลผลเฉพาะข้อความใหม่หลังเปิด (2026-09-12, impl เสร็จ)
- อาการ: เปิดครั้งแรกดึง 20 ข้อความล่าสุด → ประมวลผลของเก่า
- แก้: `pollNewMessages(since)` — `startedAt` ตอนเปิด → query `created_timestamp > since` @ `botWorkerService.ts`, `bot-worker.ts`

### Phase 2O — close_history record ปิดเท่านั้น (2026-09-12, impl เสร็จ แก้จาก 2N)
- อาการ: reopen แล้วเห็น record เดิม ไม่เห็น "ครั้งที่ 2"
- แก้: sequence = จำนวนครั้งที่ปิด; reopen update record เดิม (reopened_by/at); ปิดใหม่ = record ใหม่ @ `closeHistoryService.ts`, `CloseHistoryPanel.tsx`

### Phase 2N — botWorkerService อ่าน status จาก status_conversation (2026-09-12, impl เสร็จ)
- อาการ: botworker อ่าน status/assigned_to จาก `conversations` (ถูก dump ทับ) → ตัดสินใจผิด + เขียน assigned_to=null ผิดที่
- แก้: อ่านจาก `statusConversationService.getMeta()`; reopen → `updateStatus(conv_id,"bot",...,"bot-worker")` @ `botWorkerService.ts`

### Phase 2M — log ครบทุก action (2026-09-12, impl เสร็จ)
- อาการ: setTopic/setItemIds/togglePinned/tryAssign ไม่เขียน admin_logs (ลืมตอนย้ายมา statusConversationService ใน 2J)
- แก้: เขียน log ใน service + action_type ใหม่ + param `actor` @ `statusConversationService.ts`, `conversationService.ts`, `adminLogService.ts`

### Phase 2L — bug โยนแชทแล้วกลับเป็นคนเดิม (2026-09-12, impl เสร็จ)
- อาการ: โยนแชท admin2→3 แล้ว polling กลับเป็น admin2
- Root cause: `reassignConversation`/`autoAssignConversation` เขียน `assigned_to` ลง `conversations` (ถูก dump ทับ) แต่ polling อ่าน `status_conversation` @ `assignmentService.ts`
- แก้: เขียนผ่าน `statusConversationService.updateStatus`/`tryAssign` (atomic)

### Phase 2K — หน้า customers (contacts) โหลดช้า (2026-09-12, impl เสร็จ)
- Root cause: `listCustomers` `$lookup` join ทุก record ก่อน paginate (5,000 lookups) @ `customerService.ts`
- แก้: paginate ก่อน → lookup แค่ 20 คน (sort ตาม name ยังต้อง lookup ก่อน); ใช้ `COLLECTIONS.conversations` ไม่ hardcode

### Phase 2J — แยก collection สถานะแชทออกจาก conversations ที่ถูก dump (2026-09-12, impl เสร็จ)
- Root cause แม่: `conversations` ถูก sellcenter dump ทับทุก 2 วิ → field ที่เราเขียน (assigned_to/status/closed_at) หาย
- แก้: collection ใหม่ `status_conversation` (จริง — /tickets) + `test_status_conversation` (test — test-assignment/shadowbot/replay/test-chat, key=(source,conv_id)) + services ใหม่ 2 ตัว @ `statusConversationService.ts`, `testStatusConversationService.ts`, callers ทั้งหมด
- อ้างอิง: เป็น root cause ร่วมของ Phase 2L/2N/2V/2X

### Phase 2I — รวม status + แยก filter 2 dropdown (2026-09-12, impl เสร็จ)
- อาการ: open/handoff/pending แปลเดียวกันแต่ใช้ชื่อต่างกัน; StatusFilter ผสมสถานะแชท+ข้อความ
- แก้: รวมเป็น `handoff` เดียว (เหลือ bot/handoff/closed); แยก dropdown สถานะแชท vs สถานะข้อความ @ routes + `tickets/page.tsx` + `ChatList.tsx`

### Phase 2H — Quick reply ส่งเลย + textarea auto-expand + shadow dedupe (2026-09-12, impl เสร็จ)
- แก้: quick reply กด→ส่งเลย (`send(qr.body)`); textarea auto-expand ตาม scrollHeight; dedupe by id ใน shadow-inbox @ `TestChatClient.tsx`, `TicketChatPanel.tsx`, `shadow-inbox/page.tsx`

### Phase 2G — duplicate React key warning (2026-09-12, impl เสร็จ)
- Root cause: DB มี doc ซ้ำ (same message_id/conversation_id) @ `tickets/page.tsx`
- แก้: dedupe by id ก่อน setState ทั้ง conversations+messages

### Phase 2F — กัน overscroll/bounce (2026-09-12, impl เสร็จ)
- แก้: `overscroll-behavior:none` + `body{overflow:hidden}` (login ยกเว้น) @ `globals.css`

### Phase 2E — Quick reply auto-increment + floating chips (2026-09-12, impl รอ verify)
- อาการ: sort_order=0 ทุกครั้ง → ทับกัน; dropdown ใหญ่ทับ chat; test chat ไม่มี quick reply
- แก้: `createQuickReply` คำนวณ `max+1` เอง; UI floating chips เหนือ textarea; เพิ่มใน TestChatClient @ `quickReplyService.ts`, `quick-replies/page.tsx`, `TicketChatPanel.tsx`, `TestChatClient.tsx`

### Phase 2D — Round-robin assignment fix (2026-09-12, impl รอ verify)
- อาการ: replay shadowbot เดิม 2 ครั้งได้ admin คนละคน (ควร retain)
- Root cause: `simulateHandoff` → `autoAssignConversation` ขยับ cursor ก่อน แต่ atomic update ล้ม (`sim_xxx` ไม่มีใน conversations) → assigned_to=null → รอบถัดไปขยับอีก @ `bot-handoff/route.ts`
- แก้: simulate เรียก `pickNextAgent` ตรง + เก็บใน `test_chat_sessions`; production path ไม่พังอยู่แล้ว (เช็ค assigned_to ก่อน)

---

## ผ่านแล้ว — test chat / media / order features

### Phase 1F — Test Chat Image Upload (2026-09-11, verified)
- อาการ: test chat ส่งรูปไม่ได้ ลูกค้าพิมพ์ `[รูปภาพ]` เอง → bot เห็นแค่ placeholder
- แก้: `/api/test-chat/upload` (Mongo `test_chat_uploads`) + GET serve binary; ปุ่ม 📎+preview ใน TestChatClient; buffer/flush route รับ `images[]` รวมทุก message + absolute URL; `BOT_MAX_IMAGES_PER_TURN` env; vision desc ใช้ใน retrieval; history เก็บ images @ `test-chat/*` routes, `TestChatClient.tsx`, `bufferService.ts`, `app.py`, `middleware.ts`
- verify: tsc+py_compile+e2e 5 เคส (รับรูป/4 รูป/history มีรูป/text-only/warranty regression)

### Phase 1F-fix — Image persist + trigger cascade + vision-retrieval (2026-09-04, verified)
- อาการ: รูปขึ้นเป็น HTML text; reload แล้วรูปหาย; warranty จับ Q5 ติด (cascade); "น้องในรูปคือตัวอะไร" ไม่ใช้ vision desc
- Root cause: `TestChatMessage` ไม่มี `images`; warranty fallback `_bot_asked_info_ever` ไม่เช็ค last msg; vision-retrieval จับคำอ้างรูปไม่ครบ @ `app.py`, `TestChatClient.tsx`
- แก้: field `images` + persist; `_last_model_is_warranty` guard; ขยายคำอ้างรูป ("ในรูป/รูปนี้/ตัวนี้/น้องในรูป")
- เหลือ: Q9 "สายแรงๆ กว่านี้ใช้กับ mi 17 ultra" → แนะนำแบตแทนสาย (→ Phase 1F-Q9)

### Phase 1F-Q9 — Charger subtype retrieval fix (2026-09-04, verified)
- เคส/แชท: "มีสายแรงๆ กว่านี้ใช้กับ mi 17 ulrat ไหม" → แนะนำแบตสำรอง 5 รุ่น
- Root cause 3 จุด: FUZZY-MATCH ไม่กรอง subtype; `if not _ref_regex_products` อยู่ใน else → ref ถูกยกเลิกแล้วไม่ fetch ใหม่; `_skip_sub` ข้าม subtype filter เพราะ "สายแรงๆ" ไม่มี "สายชาร์จ" เต็ม @ `app.py`, `product_store.py`
- แก้: `charger_subtype_override` → เพิ่ม "charger" ใน product_types; REF-SUBTYPE-FILTER หลัง ref path; ย้าย superlative/fetch ออกจาก else; `_skip_sub` guard `and not _intent_sub_early`
- verify: Q9 ดึงสาย 10 รุ่น + warranty Q1 ไม่พัง

### Phase 1E — Media-aware Buffer (2026-09-11, verified)
- อาการ: ลูกค้าส่งหลายรูป+พิมพ์ตาม แต่ buffer ใช้เวลาเดียวกับ text → รูปไม่ครบก็ flush / text ค้าง; flush ส่งแค่ firstMsg → รูป 2,3 หาย
- แก้: `bufferWindowMediaMs` (12s) + `bufferMaxMediaMessages` (10) แยกจาก text; `hasMedia`/`extractMediaUrls`; flush รวม images ทุก message → `_merged_images` @ `bufferService.ts`, `systemConfigService.ts`, `botWorkerService.ts`

### Phase 1B — Tracking Lookup (2026-09-11, verified)
- อาการ: ลูกค้าส่งเลขพัสดุ/ถามสถานะ → บอทเช็คไม่ได้
- แก้: `lookup_order` เพิ่ม `tracking_no`/`tracking_numbers` ทุก package; `lookup_by_tracking`; `extract_tracking_number` (SPX/Kerry/Flash/J&T/ไปรษณีย์, กรองเบอร์โทร); flow ใน `app.py` ไม่มี order_sn แต่มี tracking → lookup @ `order_store.py`, `app.py`
- verify: py_compile + curl 3 เคส

### Phase 1C — Order Panel + Warranty Auto-Check (2026-09-11, verified)
- แก้: `lookup_order` เพิ่ม variant/price/image/total/buyer/payment; `lookup_orders_by_buyer`; API `/conversations/[id]/orders`; `OrderHistorySection` collapsible card; `warranty.auto_check_warranty(order_sn)` เช็ควันซื้อ→is_in_warranty; claim+order_sn → auto-check แนบ context @ `order_store.py`, `warranty.py`, `app.py`, `InfoTab.tsx`
- verify: "เคลม เลขคำสั่งซื้อ X" → ตอบ "หมดช่วงประกัน" + ขอข้อมูลเคลม; regression ผ่าน

### Phase 1D — Replay + Docs (2026-09-11)
- แก้: `replay_compare.py` ส่ง `images` จาก raw_payload (`build_bot_message` คืน images, `parse_raw_message` เพิ่ม media field, `call_bot` ส่ง body)

### Plan ค้าง — Order Panel + Warranty Auto-Check (เขียนไว้ก่อนทำ 1C)
- จดข้อกำหนด: order card collapsible (รูป/variant/tracking), ลูกค้าถามสถานะตอบได้ + tracking, เคลม→เช็ควันซื้ออัตโนมัติ → ทำแล้วใน Phase 1B/1C
### Charger subtype carry — "หัวชาจ" typo / ไม่มีคำ charger เลย (2026-09-09, ผ่าน bot จริง 09-03)
- เคส/แชท: CukTechThailand — Q5 "มีชาจเร็วขาร์จแรงกว่านี้ไหม", Q15 "มีจอไหม แบบมีจอด้วยดิ" (หลังคุยหัวชาร์จ AD652S/AD1404U) → ตอบ CL315P (สาย) ผิด
- Root cause: `_detect_product_types` ไม่แก้ typo "หัวชาจ" → carry type จาก history ไม่จับ charger → carry subtype ข้าม → RAG ดึงสายชาร์จ @ `app.py` (~L2399, L2427)
- แก้: carry type fallback ลอง `_detect_charger_subtype(hmsg)`; `_is_charger_ctx` = charger type หรือ subtype ตรง
- verify: จำลอง logic + bot จริง Q5/Q15 ดึงหัวชาร์จถูก (ดู "ปัญหาที่เหลือ #1" verify ผ่าน)

---

## ผ่านแล้ว — vision / anchor (2026-09-11)

### Multimodal Vision Phase 1A — บอทเข้าใจรูปภาพ (verified)
- แก้: `ChatRequest/ChatMessage.images`; `llm.describe_image(s)` ด้วย Gemini (`gemini-3.1/3.5-flash-lite`, โหลด bytes ผ่าน `Part.from_bytes` — `from_uri` ใช้ได้แค่ GCS); vision pass ใน app.py → `_vision_context`; `toBotImages` ดึง URL จาก raw_payload; ส่ง images ทุกช่องทาง (botCall/botWorker/workflow); `_VISION_PROMPT` อธิบายสินค้าเสีย/tracking/สกรีนช็อต; `history_context` ส่งบริบทให้ Gemini; `image_desc` cache กันอ่านรูปซ้ำ; video support + mime detect; เปลี่ยน default model เป็น 3.5-flash-lite
- ข้อจำกัด: URL ต้อง public CDN, 3 รูป/turn, +1-2s/รูป
- verify: py_compile+tsc+4 เคส curl (กล้อง CW400/กันน้ำ/เคลม/history รูป) + regression ผ่าน

### Anchor item หาย — "Version" ถูก extract เป็น model keyword (verified)
- เคส/แชท: ThaiSuperPhone conv shp_56386168990580567 — ส่ง CW400 แล้วถาม "Version จีนไหมครับ" → ตอบ TP-Link Tapo C210
- Root cause: "Version" ผ่าน regex → MODEL-REGEX เจอ "(Global Version)" → `_cur_model_kw` ไม่ว่าง → ข้าม conv-active @ `knowledge_base.py:extract_model_keywords`, `app.py` (~L3148 `_common_words`, ~L1859 `_kb_common`)
- แก้: เพิ่ม version/region words ใน stop_words ทั้ง 3 จุด
- verify: Q3-Q5 ยึด CW400 ไม่ดึง TP-Link

### Warranty State 7 — ส่ง `[รูปภาพ]` ใน claim flow แล้วตก flow (2026-09-10, verified)
- เคส/แชท: YoupinOfficialStore — Q4 บอทขอ "วันที่+order+รูป" → Q5 ลูกค้าส่งรูป → ตอบ "ไม่ได้รับภาพ" → closed แทน handoff
- Root cause: state machine ไม่มี state "รอข้อมูลเคลม"; `[รูปภาพ]` ไม่ match เงื่อนไขใด; order_sn ถูก order_lookup จับก่อน @ `app.py` (~L957/1011/495)
- แก้: State 7 (`_bot_asked_claim_info` → รับรูป+ขอบคุณ+บอกรอแอดมิน); ข้าม order_lookup ใน claim flow; ตัด image placeholder/date ก่อน extract_customer_info; handoff ทันทีตอนขอข้อมูลเคลม (flow ใหม่: ขอข้อมูล→handoff→รอแอดมิน)

---

## ผ่านแล้ว — Workflow Engine (Zaapi-style) ทั้งชุด

### Workflow Engine — ระบบหลัก Phase 1-3 (ผ่าน build/unit)
- สร้าง: `workflows`+`workflow_runs` collections, `workflowService` (CRUD+`validateWorkflowGraph`), `workflowEngine` (matchAndRun/resumeFlow/cancelActiveRuns + node types ครบ), `botCallService` (แยก callBot กัน circular dep), เสียบใน processMessage ①resume②workflow_first/both③trigger, API `/api/workflows*`, canvas editor `@xyflow/react`, TestChat ผ่าน engine
- กฎเหล็ก: trigger เดิมไม่ทิ้ง/บอทไม่แตะ/workflow_first default/ออก flow=จบ/admin รับ→cancel/MAX_ENGINE_STEPS=50/ไม่ยิง platform API (เก็บ `shadow_replies` origin="workflow", `__wf<N` กันชน index)/SSRF guard
- verify: tsc+build+smoke validateWorkflowGraph 6/6 — e2e ยังไม่ได้ทดสอบตอนนั้น (ผ่านจริงใน Phase 6)

### Workflow Phase 1 — Multi-branch Condition (ผ่าน unit 25/25)
- แก้: `ConditionBranch[]` + `fallback_branch_id`; engine คืน `{branch}`; `evalMultiBranchCondition` (pure) แยกจาก legacy; UI dynamic handles + upgrade panel; backward compat กับ doc เก่า @ `workflowService.ts`, `workflowEngine.ts`, `nodes.tsx`, `WorkflowEditor.tsx`

### Workflow Phase 2 — Wait for Reply (retry+timeout+3-branch) (ผ่าน unit 47/47)
- แก้: `WaitForReplyConfig` (answer_type/max_retries/retry_message/timeout_ms); `resumePhase2Wait`+`validateWaitAnswer`; `checkWaitTimeouts` race-safe (set running ก่อน); 3 handles (success/retry_exceeded/no_reply); audit log `wait_retry`/`wait_no_reply`; legacy path คง + global timeout เป็น safety net @ `workflowService.ts`, `workflowEngine.ts`, `nodes.tsx`, `WorkflowEditor.tsx`, `bot-worker.ts`

### Workflow Phase 3 — Add Label TagPicker (ผ่าน unit 53/53)
- แก้: `AddLabelConfig` (label_ids[]) + legacy `{label}` ยังทำงาน; `$addToSet $each`; API `/api/labels` distinct จาก conversations.labels; chip UI + upgrade panel

### Workflow Phase 4 — Variable Interpolation `{{var}}` (ผ่าน unit 69/69)
- แก้: `templateService.resolveTemplate` (pure, case-insensitive, var ไม่มีค่า→ว่าง); `prepareTemplateVars` ดึงครั้งเดียวต่อ node; autocomplete+preview ใน editor; ตัวแปร: customerName/shopName/integrationName/botAnswer/customerReply/initialMessage/conversationId/shopId/platform @ `templateService.ts`, `workflowEngine.ts`, `WorkflowEditor.tsx`

### Workflow Phase 5 — UI Polish node card (ผ่าน)
- แก้: node card = header สีตาม type (Trigger เหลือง/Condition ม่วง/Action เขียว/Wait คราม) + label ข้าง handle + configSummary preview — pure CSS @ `nodes.tsx`

### Workflow Phase 6 — Testing/Rollout (ผ่านเต็ม)
- ทำ: unit 69/69 + E2E 16/16 กับ MongoDB จริง (trigger→menu→wait→condition→label→send, cleanup ครบ) + rollout script สร้าง flow จริง GodungIT + เปิด `workflow_enabled`
- verify: unit+E2E+tsc+build ผ่านทั้งหมด

### Workflow audit log + soft delete + restore (ผ่าน)
- แก้: `restoreWorkflow()` + API restore; log ใส่ `workflow_name`; update log `changes:{from,to}`; `previous_enabled` ใน toggle/delete; logs page เพิ่มหมวด Workflow + tone @ `workflowService.ts`, `adminLogService.ts`, `logs/page.tsx`

### Workflow UI รวมย่อย (ผ่านทั้งหมด 2026-09-04)
- **List+modal consistency**: แปลง inline styles → Tailwind tokens เหมือน triggers page @ `workflows/page.tsx`
- **Duplicate shop_id key**: `/api/shops` คืน doc ละ (shop_id, platform) → dedupe Map by shop_id ใน triggers/WorkflowEditor/workflows
- **Create modal**: กดสร้าง → เลือกชื่อ+desc+platform(multi)→ร้านกรองตาม platform → POST shell แล้ววาด graph ทีหลัง @ `workflowService.ts`, routes, `workflows/page.tsx`, `WorkflowEditor.tsx`
- **/workflows list**: search/sort/filter 3 ตัว + inline rename + toggle + shop checkbox list แทนพิมพ์ ID

---

## ผ่านแล้ว — prompt/คำตอบเดิม (2026-09-03, verify bot จริงทั้งหมด)

### Q19 "ใช้มั๊ย" — คำถามสั้นเกิน (ผ่าน)
- Root cause: SYSTEM_INSTRUCTION ไม่มีกฎคำถามสั้น+มี history @ `llm.py` (~L84)
- แก้: กฎ — คำถามสั้น/กำกวม+มี history → ตีความจาก history ตอบเรื่องสินค้าที่คุยอยู่ ห้ามบอก "คำถามสั้นไป"

### Q18/Q21 — ตอบรับประกันยาวเกิน/ตัดค้าง (ผ่าน)
- Root cause: duration question ไม่ครอบ "มีประกัน"; `_append_base_warranty` แนบเงื่อนไขเต็มทุก warranty question; statement ก็โดนแนบ @ `llm.py`, `app.py:_append_base_warranty`
- แก้: แนบเงื่อนไขเต็มเฉพาะเมื่อขอ terms; skip warranty_policy flow เมื่อมี item_id → Q18: 1275→180 chars

### Answer elaboration — ตอบละเอียดขึ้น + คำถามเล่นๆ (ผ่าน)
- แก้ 2 กฎใน `llm.py`: คำถามสินค้าเสริม 2-3 ประโยค (ห้าม invent ข้อมูล); คำถามนอกเรื่องเล่นด้วยสั้นๆแล้วกลับสู่ร้าน

### Q5/Q12 — แนบลิงก์/รูปซ้ำซ้อนตอนถาม trust (ผ่าน)
- แก้ 2 กฎใน `llm.py`: ถาม trust/วีดีโอรีวิว → ตอบ trust เท่านั้น ห้ามแนบลิงก์/รูป; แนบเฉพาะเมื่อแสดงสนใจซื้อ/ขอดู

---

## ผ่านแล้ว — Deploy + แผนงาน (2026-09-09/10)

### Deploy — Dockerfile bug + Caddy + DEPLOY.md (ผ่าน yaml, รอรันจริง)
- Root cause: `COPY scripts/` แต่ root มีแค่ `script/`; ไม่มี reverse proxy/SSL; lazada/tiktok เป็น placeholder จะ crash
- แก้: ลบ COPY scripts, เพิ่ม Caddy (auto SSL, รองรับทั้งมี/ไม่มีโดเมน), chatadmin-web expose-only, chatbot-shopee 127.0.0.1, DEPLOY.md เขียนใหม่ @ `Dockerfile.chatbot`, `docker-compose.yml`, `Caddyfile`, `DEPLOY.md`
- ⚠️ ยังไม่ได้รัน `docker compose up` จริง

### แผน Inbox/Scroll/Image/BotWorker refactor (2026-09-10 — แผน, ต่อมาทำหลายข้อ)
- ที่มา: scroll list เด้งกลับ (polling re-render); vision ไม่ครบทุกหน้า; ต้องแยก assigned_to ตาม source; ล้าง status เก่า; botworker เลียนแบบ ticket (source='adminbottesttest' ใน messages_shp); history มัดรวม message ติดกัน เลือกบอทเราก่อน zaapi
- ข้อกำหนด: ห้ามกระทบ ticket/`getHistoryForBot`/`listMessages` เดิม; test source ไม่ปนจริง; verify ทุกข้อ

---

## ผ่านแล้ว — Admin web รอบ 2026-09-05/07/08

### /team — expand bug + status columns + date range (2026-09-05, ผ่าน)
- Root cause: shops/shopTeam/platformTeam โหลดเฉพาะ tab นั้น → expand=0; อ่าน status จาก `conversations` (dump ทับ) @ `api/team/route.ts`, `team/page.tsx`
- แก้: อ่าน workload จาก `status_conversation`, statuses=open/handoff/closed/bot, รวม shop/platform ใน response, `start_date/end_date` → historical stats จาก admin_logs, frontend โหลดตอน mount + DateRangePicker

### Date separator ทุกหน้าแชท เหมือน LINE (2026-09-05, ผ่าน)
- แก้: `DateSeparator.tsx`/`DateSeparatedList` helper แทรก DateBanner เมื่อเปลี่ยนวัน — ใช้ใน ChatWindow/TicketChatPanel/TestChatClient/botworker/test-assignment/replay-compare (ShadowReplyPanel มีอยู่แล้ว)

### Sticker URL + botworker raw_payload (2026-09-05, ผ่าน)
- Root cause: sticker parser ดึงแค่ sticker_id ไม่ดึง URL; **bug หลัก**: placeholder `[สติกเกอร์]` return ก่อนถึง switch case → ไม่เคยดึง URL เลย; botworker route ไม่ parseRawMessage @ `messageMediaParser.ts`, `MessageContent.tsx`, `botworker/messages/route.ts`, `botworker/page.tsx`, `replay_compare.py`
- แก้: ดึง URL จาก url/image_url/sticker_url + normalize, placeholder fall through ไป switch, botworker route parse+product lookup เหมือน admin

### TestChat session ownership + log UI (2026-09-07, ผ่าน)
- แก้: `test_chat_sessions` เพิ่ม `admin_id/admin_name` (จาก X-Admin-Id header); list กรองของตัวเอง (legacy ไม่มี admin_id เห็นรวม); logs filter `admin_id` (`all`=ทุกคน); tab "ประวัติ" ใน right panel @ `app.py` (L5345/5385/5612), `TestChatClient.tsx`, `docs/schema.md`, `docs/SRS_SSD.md`

### Rich Media All Pages — 9 Shopee tags (2026-09-08, ผ่าน build รอ manual)
- แก้: alias `item_card`→item, `picture`→image, `faq_liveagents`→faq_liveagent ใน parser ทั้ง TS+Python; messages API ส่ง `bundle` (fetch sub-messages ด้วย `bundle_message_ids`; ไม่มีใน DB → "Bundle (N ข้อความ)"); test-chat-result ใช้ `MessageContent` @ `messageMediaParser.ts`, `replay_compare.py`, messages routes, `test-chat-result/page.tsx`
- **Fix เพิ่ม — product card ภาพไม่ขึ้น** (shp_203905019987193330): `toProductCard` หา `doc.images` แต่ DB ใช้ `doc.image.image_id_list` + CDN คนละ host → เพิ่ม `normalizeProductImageUrl` (`cf.shopee.co.th/file/`) + รองรับทั้ง 2 field
- **Fix เพิ่ม — bundle_message** (shp_152520383445167602): `source_content` อยู่ที่ `raw.data.content.source_content` (หา 4 ตำแหน่ง); **สินค้าไม่ขึ้น** (shp_152520383346282116): raw_payload=null ทั้งแชท — ข้อมูล DB ไม่สมบูรณ์ แก้ไม่ได้ parser แสดง placeholder ถูกแล้ว

### Rich Media Consistency — 5 ระบบจัดการ rich message ไม่เท่ากัน (2026-09-08, impl รอ manual)
- อาการ: test-assignment/live-assignment ส่ง `msg.text` ดิบ (`[item]`/`[order]`) + ไม่ส่ง `images` ให้บอท → vision ไม่ทำงาน + history สะสม placeholder; live-assignment conv_detail ไม่ทำ product lookup + parse เฉพาะเมื่อมี raw_payload; shadow-inbox history ข้าม product lookup → item card โชว์แค่ "(สินค้า)"
- แก้: ใช้ `toBotText`/`toBotImages` + `images` param ใน callBot ทั้ง `test-assignment/route.ts` และ `liveAssignmentService.ts` (2 ฟังก์ชัน); live-assignment route เพิ่ม batch product lookup + เรียก `parseRawMessage` เสมอ; shadow-inbox `[shadowReplyId]` route เปลี่ยนเป็น batch product lookup สำหรับ history ทั้งหมด
- verify: tsc ผ่าน — รอ manual (replay แชท item/รูป + เปิด history)

### kb+mongo path ไม่บันทึก suggestion → context loss (2026-09-07, impl รอ replay)
- เคส/แชท: ถามหัวชาร์จ mi 17 ultra → ตอบถูก (source=kb+mongo+web_search) → "ขอลิงค์กับรูปประกอบ" → ดึง powerbank แทน
- Root cause: `kb+mongo` + `kb+mongo+web_search` path ไม่เรียก `_record_suggestion_products` → active_item_id ว่าง @ `app.py` (~L2672/2696)
- แก้: เพิ่ม `_record_suggestion_products` 2 จุด (product_store path มีอยู่แล้ว)

### /logs ตาราง view (2026-09-07, ผ่าน)
- แก้: tab สลับ List/Table + `LogTableView` โชว์ทุก field จริงใน `AdminLogDoc` + expand metadata + หมวด ACTION_CATEGORIES เพิ่ม @ `logs/page.tsx`

---

## ผ่านแล้ว — ChatBot v3 + stock (2026-09-20)

### ChatBot v3 — OpenRouter-first paradigm (impl + smoke ผ่าน, รอ live)
- paradigm: ไม่ปั้น RAG context — ส่ง raw (message+history+images+shop link) ให้ OpenRouter → match สินค้ากับ ShpProducts
- สร้าง `chatbot/shopeechat/chatbotv3/` (or_client, system_prompt, shop_link, rich_parse, product_match, emotion, engine); copy warranty/order/product_store/rich tags ผ่าน lazy import; ตัด intent_classifier/RAG/KB/charger subtype/anchor/web_search; เพิ่ม emotion detection (มี word boundary บ้า/กาก) + human request → handoff
- Wiring: `ChatRequest.use_v3` / env `USE_CHAT_V3=1` → dispatch `chat_v3` ก่อน legacy; default ปิด
- verify: py_compile+smoke ทุก module+engine mock 6 tests — รอ live OpenRouter/Mongo/e2e

### Stock checker อ่านผิด field (2026-09-20, verified)
- เคส/แชท: LuckyHomeMart Leravan LJF003, IMILabThailand EC4 — 3,419 สินค้าถูก mark sold_out ผิด
- Root cause: `_shopee_stock` อ่าน `shopee_stock[].stock` (เป็น 0 เสมอในข้อมูลจริง) — stock จริงอยู่ `summary_info.total_available_stock` @ `product_store.py:_shopee_stock`, `to_product_card`, `_is_sold_out`
- แก้: อ่าน summary_info เป็นหลัก fallback shopee_stock; มี model → รวมทุกรุ่นย่อย; ไม่มี model → อ่าน doc
- หมายเหตุ: กลับทิศจาก Phase 5 (2026-09-10) ที่เปลี่ยนมาใช้ shopee_stock — ข้อมูลจริงพิสูจน์ว่า summary_info ถูก
- verify: stock ถูกทุกร้าน + regression 16/16 + 42/42 + live test

### ChatBot v3 — audit features ข้อ 1-5,7 (impl + smoke 7/7)
- เพิ่ม: `_send_handoff_to_admin` (POST จริงเหมือน legacy), `_get_persona_extra` (persona ของร้าน), `image_desc` field, `|||` segments ใน handoff, `_lookup_order_context` (order lookup จริง); ChatAdminWeb `chat_engine:"v3"` + config UI option + `use_v3` flag
- ไม่ทำข้อ 6: `conversation_products` (ตามคำสั่ง)

---

## ผ่านแล้ว — shadow/admin-chat-result/ZMI (2026-09-12)

### Shadow inbox — Generate ทีละข้อดึง history รวมอนาคต (ผ่าน)
- อาการ: Generate Q1 → บอทเห็น Q2-Q11 ตอบเรื่องใบกำกับภาษี/สวัสดี
- Root cause: `getHistoryForBot` ดึง 20 ข้อความล่าสุดไม่กรองเวลา @ `messageService.ts`
- แก้: param `beforeTimestamp` (กรอง `created_timestamp <`); generate ส่งเวลา inbound; เพิ่ม manual shadow replies (origin="manual") ใน history กัน Q2 ไม่เห็น Q1 @ `shadowReplyService.ts`

### Admin-chat-result — ซีรีส์ UI/ข้อมูล (2026-09-12, ผ่านทุกข้อ tsc)
- **detail items=0**: axios ต้องเข้า `.data.items` → `.data?.items || .items`
- **โชว์ Zaapi แทน bot เรา**: render จาก `detail` items (bot_reply ของเรา) + rich user content จาก fullMessages; fallback 3 ทาง (detail / fullMessages / ว่าง)
- **detail=0 ทั้งที่มี messages**: API ส่งเฉพาะ rated items → render จาก fullMessages เป็นหลัก merge rating ด้วย message_id
- **detail ว่างตอน filter admin**: `loadDetail` ไม่ส่ง `admin_id` (dev-only เห็นทุก Q&A)
- **ชื่อลูกค้า "ไม่ระบุชื่อ"**: query ด้วย `conversation_id` แทน `shop_id` → `convInfoMap` ส่ง to_name
- **format/bubble**: `whitespace-pre-wrap` ใน MessageContent ทุกจุด; bot bubble ชิดขวา `flex-1 items-end`; user bubble `w-fit`; multi-bubble `space-y-0.5`/`gap-2`; list style เหมือน shadow-inbox (to_name/shop/แอดมิน/รีวิว); ลบ toggle "ดูเต็ม/ย่อ" → MessageContent ต่อ segment (products/table ส่ง segment สุดท้าย); ตัวอักษรใหญ่ขึ้น
- ไฟล์: `admin-chat-result/page.tsx`, `api/admin-chat-result/route.ts`, `MessageContent.tsx`, `test-chat-result/page.tsx`

### ZMIThailand context loss รอบจริง — Phase 3.1, 4 จุด (2026-09-12, verified 13Q)
- เคส/แชท: ZMIThailand 13Q — Q1 `[variation_card]` item 2217375776 → AL870/AL856/CL315P ถูก แต่ Q2-Q13 follow-up ดึงสินค้าอื่นทับ anchor
- Root cause 4 จุด: (1) `_filter_charger_subtype` อ่าน `item_name` แต่ card มี `name` → กรอง active ออก → fetch ใหม่ (2) web_search ทับเมื่อ LLM ตอบ "ไม่มี" กับ anchor (3) FOLLOWUP-COMP จับ `[variation_card]` เป็น model kw (4) CONV-ACTIVE ข้ามเมื่อมี `_cur_charger_sub` @ `product_store.py` (~L1532), `app.py` (~L4733/1092/2895)
- แก้: `item_name or name`; web_search guard `not _is_conv_active`; strip tag/placeholder ก่อน extract_model_keywords; CONV-ACTIVE ทำงานแม้มี charger_sub + เช็ค subtype เปลี่ยนจริงไหม ("หัว" ลอยๆ ไม่ใช่เปลี่ยนหมวด)
- verify: 13Q ใช้ anchor ตลอด + regression CW400/typo/iSuper multi-case

### Context loss + ANC search + "สอบถาม" new topic — Phase 3 (2026-09-07, verified)
- เคส A (ZMIThailand): "ไอโฟน 11โปรแม๊กอันไหนคับ" → "11โปรแม๊ก" ถูกจับเป็น model kw → ข้าม CONV-ACTIVE
- เคส B (mosaakub): "2 รุ้น สำหรับวิ่ง และตัดเสียงรบกวน" → ตอบแค่รุ่นวิ่ง ("สอบถาม" อยู่ใน `_new_topic_kws`; "ตัดเสียงรบกวน" ไม่อยู่ earphone kw; ไม่มี feature search)
- แก้: `_TARGET_DEVICE_KWS`+`is_target_device_kw` (กรอง target device ออกจาก model kw — แก้เป็น `re.search` จับใน token ยาว); เอา "สอบถาม" ออก 2 จุด; multi-use-case ("2 รุ้น"+earphone → แยกค้นตาม use case รวมผล); earphone kw + feature-based search `$and` ใน `build_query` @ `knowledge_base.py`, `app.py`, `product_store.py`
- verify: เคส A anchor ต่อ; เคส B แนะนำ SoundActiv Run+SOUND COMFORT PRO ครบ

### Test-assignment — incremental rendering (2026-09-12, ผ่าน)
- Root cause: All/History tab render 2000 แถวทีเดียว @ `test-assignment/page.tsx`
- แก้: `RENDER_BATCH=50` + scroll listener + reset เมื่อ filter เปลี่ยน (เหมือน ChatList)

---

## ผ่านแล้ว — vision / anchor subtype / compat guard (2026-09-12)

### Vision hallucination — รูปแมว บอทบอกเป็นพาวเวอร์แบงค์ (verified)
- Root cause: shadow script ส่ง `merged[:200]` (รวมคำถามก่อนหน้า) เป็น history_context → vision โดน bias; `_VISION_PROMPT` ไม่มี guard ห้าม context override @ `shadow_openrouter.py` (L337), `llm.py:describe_image` (L574-577)
- แก้: `_VISION_PROMPT` +4 บรรทัด (อธิบายเฉพาะที่เห็นจริง / ห้ามให้ history กำหนด / แมวต้องบอกแมว); shadow ส่งเฉพาะ `text[:150]` คำถามปัจจุบัน; production `describe_image` ยังส่ง context (ใช้เคสเคลม) แต่ prompt กัน override
- verify: py_compile ผ่าน

### item_tag anchor ไม่เช็ค charger subtype → ตอบสายแทนหัว (verified)
- เคส/แชท: แชร์การ์ด CTL301 (สาย) แล้วถาม "หัวชาร์จละ" → บอทตอบ CTL301 ทั้งที่ถามหัวชาร์จ
- Root cause: item_tag block return ตอบจาก anchor ทันที ไม่เช็ค subtype ต่างกัน @ `app.py` (L633-669)
- แก้: subtype mismatch check ก่อน return — ต่างกัน → fall through fetch ใหม่ (anchor คงใน timeline); post-fix แยก `_is_loose_head` (หัวลอยๆ cable→adapter ไม่ใช่เปลี่ยนหมวด)
- verify: ดึงหัวชาร์จจริง + edge 3 เคส + regression 16/16

### Q3 "อยากได้ของที่ใช้กับ xiaomi 17 ultra" — hybrid anchor+fetch (verified)
- เคส/แชท: แชร์ CTL301 → ถาม compat → บอทดึงสินค้า Xiaomi สุ่ม แทนบอก CTL301 ไม่รองรับ
- Root cause: "อยากได้" ใน `_new_topic_kws` (4 จุด) → ทิ้ง anchor ทั้งที่ "ใช้กับ" คือ compat ไม่ใช่ new topic @ `app.py`
- แก้: guard อยากได้+ใช้กับ → ไม่ new topic; compat+target_device → fall through + เก็บ `_hybrid_anchor_card`; แนบ anchor product_type ใน req.message; merge anchor เข้า products + context note
- verify: บอก CTL301 Lightning ไม่ใช้กับ Mi 17 Ultra + แนะนำ USB-C ถูก; regression เคสเก่าผ่านครบ

---

## ผ่านแล้ว — Shadow Inbox QA BUG series (2026-09-08/14)

### BUG-10 — บอทแต่งสต็อก/แคตตาล็อกร้านจากผลค้นว่าง (verified)
- เคส/แชท: m8iolenl0i/ZMI "ทุกรายการหมดสต็อก" (เท็จ), taweep154/CukTech "no.6 Ultra ไม่มีจำหน่าย", pornpansonsuwan/Youpin ถามอะไหล่หัวฉีด → แต่งแคตตาล็อก
- Root cause 3 ชั้น: products ว่างยังปล่อยเข้า LLM; prompt สั่ง "บอกว่าไม่มี" → LLM ตีเป็นหมดสต็อก/เลิกขาย; "หัวฉีด" โดนจับเป็น adapter → context ผิดประเภท @ `app.py`, `llm.py:_build_context`, `product_store.py:_detect_charger_subtype`
- แก้: NO-PRODUCT-GUARD 2 แขน (ค้นไม่เจอ+มี product intent / fuzzy ล้วน+ถามหาของเฉพาะ → handoff `no_product_found`); `_build_context`+SYSTEM_INSTRUCTION ห้ามสรุปหมดสต็อก/เลิกขาย/แคตตาล็อก เว้นเห็น sold_out จริง; `_other_prod_kws` เพิ่ม หัวฉีด/หัวพ่น/หัวข้อ
- verify: unit 5 + e2e 8 เคส + regression 16/16; ⚠️ ZMI "มีสายไหม" ตอบหมด = ข้อมูลจริงใน DB ไม่ใช่แต่ง
- อ้างอิง: ต่อมาเพิ่ม `import json` (handoff 500) + user แยก `_is_loose_head` ใน ITEM-TAG guard

### BUG-2/3/4/6/9/11 — แก้ 6 บักพร้อมกัน (2026-09-14, verified)
- **BUG-9** persona `abubu` hardcode 5 จุดใน warranty f-string → `_bot_name` จาก persona ของร้าน @ `app.py`
- **BUG-3** บอทอ้าง "แอดมินมาแล้ว" (เท็จ) + ไม่ escalate → `_HUMAN_REQUEST_KWS` 30+ คำ + handoff block; prompt ห้ามพูดแอดมินมาแล้ว @ `app.py`, `llm.py`
- **BUG-2** KB `[[ ]]`/`---`/`หมายเหตุ:` หลุด → `_strip_kb_markup()` ที่ return ทุก LLM path + `_append_base_warranty` @ `llm.py`, `app.py`
- **BUG-4** แต่งขั้นตอนลงทะเบียน/QR/URL → prompt ห้ามแต่ง + บอกใช้เลขออเดอร์เป็นหลักฐาน @ `llm.py`
- **BUG-6** HTTP 500 เงียบ (history มี video) → `import json` ขาดใน app.py → เพิ่ม
- **BUG-11** web_search แพง/ช้า (24,986 tok / 17.6s) → `should_use_web_search` guard greeting/ordinary query ที่มี products; max_tokens 1024→512, timeout 30→20 @ `web_search.py`
- verify: live bot 8010 ทุกเคส + replay 12 conv 0 errors (1 timeout = vision โหลด video ช้า pre-existing)
- ⚠️ pending: BUG-5 (frontend ไม่ fetch rows), BUG-7 (Zaapi spec แม่นกว่า), BUG-8 (ราคา card ผิด)

---

## ผ่านแล้ว — chat_v2 pipeline (2026-09-15/16)

### chat_v2 pipeline rewrite + warranty_flow + chat_models (impl, รอ replay)
- ที่มา: legacy `chat()` ~6,300 บรรทัด guard ซ้อน guard → เขียน pipeline ใหม่แบบ staged
- สร้าง: `chat_models.py`, `warranty_flow.py` (822 บรรทัด — port SM เดิม), `chat_v2.py` (~1,100 บรรทัด: intent → anchor → retrieval → search → no-product guard → answer); `app.py` dispatch `USE_LEGACY_CHAT` (default=legacy)
- deterministic รักษา: order/tracking/warranty/tax/human
- verify: py_compile + unit — runtime MongoDB/genai + replay ยังขาด ณ ตอนบันทึก

### chat_v2 เพิ่ม superlative / multi-use-case / charging spec (verified unit)
- เพิ่มใน `chat_v2.py`: `_is_superlative_question` (limit×5 สูงสุด 50 + เติมพาวเวอร์แบงค์ใน retrieval), `_detect_multi_usecase` (ตัด "ชาร์จ" จาก "ในรถ" กัน car_charger), `_is_charging_spec_question` (override→product_spec + hint), `_extract_wattage`; rerank + intent fields + `_build_answer` hints
- verify: unit 4/4 + 4/4 + 3/3 + 8/8 + regression 16/16

### per-request `use_v2` + global `chat_engine` config (2026-09-15, impl)
- `ChatRequest.use_v2`; `replay_compare.py --v2`; shadow-inbox routes ส่งต่อ; default legacy
- `systemConfigService.chat_engine` (legacy|v2) — ทุก caller (botworker/shadow/test-assignment/live-assignment/replay/test-chat) อ่าน config ส่ง `use_v2`; toggle UI ใน /config

### chat_engine runtime test + MongoClient close bug (verified)
- Root cause: `chat_v2._check_warranty_state_machine` สร้าง `_db()` แล้ว `client.close()` — เป็น singleton cached → client หลักถูกปิด → 500 "Cannot use MongoClient after close" @ `chat_v2.py`
- แก้: รับ `db` param จาก context หลัก; `ChatResponse.chat_engine` field
- verify: runtime 6/6 (v2 compat/superlative ผ่าน, legacy default ผ่าน)

### MODEL-REGEX pre-filter ใน chat_v2 (2026-09-16, verified)
- Root cause: "ctl301" → `build_query` ไม่ใส่ model kw → ดึงทั้งร้าน 1,079 ตัว → vector ได้ ZMI AL301 แทน CTL301
- แก้: stage 5.2c ใน `_retrieve_products()` — regex `[A-Za-z]+\d+[A-Za-z]*` len>=4 → Mongo `item_name:{$regex}` ก่อน vector
- verify: เจอ CTL301 ตรง + regression 16/16

---

## จัดระเบียบ repo (ผ่าน — 2026-09-09)

- Docker files → `docker/`; test scripts → `chatbot/testscript/`; `replay_compare.py` → `chatbot/frontendScript/`; รวม test/testlog/testresult → `test/` แล้วย้าย `docs/test/`; adminbase + import script → `docs/adminbase/`
- refs อัปเดต: Dockerfile, README, AGENTS, package.json

---

## ผ่านแล้ว — intent-first + context limits (2026-09-16/17/18)

### Phase 6 — intent-first: ยกเลิก should_run_pass1, classify ทุกข้อความ (verified)
- Root cause: hardcoded keyword ตัดสินก่อน LLM (general_qtype/claim/tax) → ผิดในเคสกำกวม @ `app.py`, `intent_classifier.py`
- แก้: `classify_intent()` รันเสมอหลัง deterministic (order_sn/tracking regex/human kw); `general_qtype` field ใหม่; intent (conf≥0.7) เป็นหลัก, keyword list กลายเป็น fallback; tax handoff ย้ายหลัง intent; try/except → `_DEFAULT_RESULT`
- Cost: +~1s + ~0.005฿/msg ที่ไม่เคยเรียก intent
- verify: regression 16/16; fallback no-key 8/10 (2 fail = test expectation ผิด); ⚠️ tracking regex จับเบอร์บ้าน 9 หลัก (pre-existing)

### Phase 6 live verify — เทียบ Zaapi จริง (2026-09-16, verified)
- เคส/แชท: pingevox 5Q + mistorethailand 38Q ทัก KingGadgets (CUKTECH 133 products) — เทส 16 เคสผ่าน `chat()` จริง (Gemini+DB+web search จริง)
- ผล: intent ถูกทุกเคส — ดีกว่า Zaapi: M10 "รุ่นไหนมี มอก." (เราตอบจาก DB, Zaapi ส่งแอดมิน), M19 "หมดประกันยัง" (เรา=policy, Zaapi=claim — เราถูก); M38 "3" Zaapi เข้าใจ rating ดีกว่า (เราไม่ผิด)

### Phase 7 — Anchor comparison "อันนี้กับอันก่อน" (2026-09-16, verified)
- เพิ่ม `conversation_products.get_anchor_history` + `get_previous_anchor`; `_anchor_compare_kws`/`_is_anchor_compare` → ใส่ current+previous anchor เข้า products + comparison note @ `app.py`
- Bug แก้ระหว่างทาง: `_compute_active` TypeError offset-naive/aware → `_normalize_dt()` 3 ฟังก์ชัน
- verify: unit 7/7 + live (2 anchors เปรียบเทียบถูก, 1 anchor graceful)

### Phase 8 — `_recent_qa_pairs` + `_LLM_CONTEXT_LIMIT=30` (2026-09-17, verified)
- ที่มา: ส่ง history ทั้งหมดเข้า LLM + RAG limit=10 → prompt ยาว + LLM เห็นสินค้าน้อย
- แก้: `_recent_qa_pairs(history, n=10)` จับคู่ user+model (edge: user ติดกัน/model เดี่ยว/ไม่ mutate); ใช้แทน history ใน 11 จุด LLM context; `_LLM_CONTEXT_LIMIT=30` แทน limit=10 ใน RAG 5 จุด + LLM cap 4 จุด; คง `req.limit` (frontend) + full history สำหรับ intent/warranty SM/vision
- verify: unit 10/10 + anchor 7/7 + live; cost ประมาณ +3-5%

### Phase 8.1 — `llm_context_limit` ปรับได้ใน admin (2026-09-18, verified)
- `systemConfigService` field (default 30); `/api/config` validate 10-50 (422); input + MinimalSlider ทั้ง /config และ /admin-config; `botCallService` ส่งใน body ทุก path; `ChatRequest.llm_context_limit` (ge=10,le=50) → `_llm_ctx_limit` แทน constant 11 จุด (fallback 30)
- verify: tsc + py_compile + unit 10/10 + 7/7

### Warranty auto-check จาก delivery date (2026-09-18, verified)
- Root cause: `auto_check_warranty` ใช้ `create_time_raw` (วันสั่ง) — ประกันควรนับจากวันส่งมอบ @ `warranty.py`, `order_store.py`
- แก้: `delivery_time_raw` (COMPLETED/DELIVERY_DONE → update_time, ไม่ fallback create); `check_warranty_status()` ใหม่; flow: multi-item ต่างประกัน→ถาม / ยังไม่ส่งมอบ→บอกยังไม่เริ่มนับ / ในประกัน→ขอข้อมูลเคลม / หมด→เสนอแอดมิน; legacy fallback คง
- verify: unit 11/11 + anchor 7/7 + live pingevox/mistore 42/42

### Phase 3d — `_available_for_sale` + sold_out note นอก has_unlist (2026-09-19, verified)
- เคส/แชท: LuckyHomeMart Leravan status=NORMAL แต่ stock=0 → บอทยังแนะนำขาย+ส่งลิงก์
- Root cause: sold_out note ฝังใน `if has_unlist` — สินค้า NORMAL+stock=0 → has_unlist=False → note ไม่ inject @ `app.py` (L5659)
- แก้: mark `_available_for_sale` (NORMAL+!sold_out+stock>0) ทุก card; `_pending_context_note` inject หลัง `_apply_product_tiers`; field เข้า slim_fields + กฎหลักใน SYSTEM_INSTRUCTION/KB
- verify: live LuckyHomeMart ตอบหมดไม่ส่งลิงก์ + regression 16/16 + pingevox/mistore 41/42 (1 fail = LLM 503 ไม่เกี่ยว)

---

## ผ่านแล้ว — misc fixes (2026-09-10/22)

### Test Assignment replay 500 hardening (2026-09-22, impl+verify API)
- เคส: กด generate replay → AxiosError 500; outer catch เดียวกลืน stack → หา cause ไม่ได้
- แก้ @ `test-assignment/route.ts`: console.error stack; wrap try/catch — updateTestStatus / parseRawMessage per-msg / toBotText+toBotImages เข้า loop / saveReplayResult / logAdminEvent
- verify: tsc + ยิง API จริง HTTP 200 ครบ fields; ⚠️ ไม่ได้ reproduce 500 (น่าจะ intermittent data/service)

### เบาะรองหลัง false negative — product type ไม่จับ "รองหลัง" (2026-09-22, verified)
- เคส/แชท: LuckyHomeMart "หาเบารองหลังแจ่มๆ" → ตอบไม่มี + web_search แนะนำ MicroSD — จริงมี LBB003/LBB001/LBH001
- Root cause: "รองหลัง/พิงหลัง" ไม่อยู่ keyword PRODUCT_TYPES ใดๆ → vector ไม่เจอ → LLM "ไม่มี" → web_search ผิดหมวด @ `product_store.py:_detect_product_types`
- แก้: เพิ่ม "รองหลัง","พนักพิงหลัง","เบาะพิงหลัง" ใน massager user_kws + regex (จับพิมพ์ผิด "เบารองหลัง")
- verify: detect 8/8 + LBB003 อันดับ 1 + FP check (รองเท้า/รองพื้น ไม่ match) + regression 16/16 + 42/42 + live RAG 22 ชิ้น
- อ้างอิง: ต่อยอดเป็น audit เพิ่ม 5+31 PRODUCT_TYPES (ด้านล่าง)

### Shadow Inbox — Generate ทั้งหมด streaming SSE (2026-09-10, impl รอ manual)
- อาการ: กด Generate ทั้งหมด → รอครบทุก Q&A ถึงเห็นคำตอบ (30-60s)
- แก้: `generateConversationShadowReplies` เพิ่ม `onReply` callback; route → SSE ReadableStream (progress/reply/done/error + force-dynamic + X-Accel-Buffering:no); panel axios→fetch+getReader อัปเดต pair ทีละอัน + "Generate 2/5"
- verify: tsc + build — รอ manual browser

### มอก. (TISI) question handler (2026-09-10, impl+unit รอ replay)
- เคส: "รุ่นไหนมี มอก. บ้าง" / "AC65B2 มี มอก. ไหม" → บอทไม่รู้จัก
- แก้: `search_tisi_products` (regex มอก. + `_has_tisi` กรอง "หมอก"/"เสมอกัน" + `_extract_tisi_context` + model_keyword) @ `product_store.py`; `detect_tisi_question`+`extract_tisi_model_keyword` @ `warranty.py`; handler หลัง tax invoice → เจอตอบ / ไม่เจอ handoff; "มอก" ใน `_clean_description` spec_kw
- verify: unit 13/13 + MongoDB 109 products/8 shops + regression 16/16 — รอ replay e2e

### Live Assignment — ปิดแชทครั้งที่ 2 ไม่ประมวลผลข้อความใหม่ (2026-09-10, impl รอ manual)
- Root cause: `closeChat` นับ `newProcessedCount = processedCount + remainingMsgs.length` ทั้งหมด ทั้งที่ loop หยุดกลางที่ handoff → ข้อความหลัง handoff ถูก mark processed โดยไม่ process @ `liveAssignmentService.ts` (~L710)
- แก้: `processedInThisBatch` นับจริงใน loop
- verify: tsc — รอ manual UI

### Device-spec-lookup ไม่ทำงานใน KB path → แนะนำแค่ baseline (2026-09-10, verified)
- เคส: "สนใจหัวชาร์จที่ใช้กับ iphone 17 pro max" → แนะนำแค่ A18T 30W ทั้งที่มี 65W/100W compat
- Root cause: KB path return ก่อนถึง device-spec-lookup block @ `app.py` (KB ~3979 vs lookup ~6083)
- แก้: แยกเป็น module helper `_device_spec_lookup()` (รับ resolve_subtype_fn เพราะ nested); เรียกจาก KB path + main path (ลดซ้ำ ~130 บรรทัด)
- verify: merge 29 สินค้า → baseline 40W + upgrade 65W/100W ถูก spec + regression 16/16

---

## UX/UI Critique rounds ทั้งชุด (2026-09-22) — ChatAdminWeb เท่านั้น ไม่กระทบ bot core

- **R1-7 (22→27/40)**: a11y contrast; PageShell 8 หน้า; FilterChips; catchError 4 จุด; IA collapsible + nav search
- **R8-12 (27→33/40)**: PageShell +5 หน้า; 21 silent catches→toast; tooltip 17 ปุ่ม; TestChatClient hex→tokens; `--color-surface-3` + 12 semantic tokens
- **R15 (34.5→28)**: silent catch 3 จุด TestChatClient; ~71 colors→tokens 6 หน้า; aria-label ~60 จุด (audit เข้มขึ้น → คะแนนดิ่ง)
- **R16**: 8 toggle switches (role=switch+aria); ~97 colors→0; define `--color-surface-1`
- **R17**: SKIP PageShell บน tickets/replay-compare/test-assignment — multi-pane layout ไม่ fit
- **R18 (28→29)**: หน้า `/help` (getting started/features/glossary/tips) + sidebar link → H10 1→4
- **R19**: ผู้ใช้เพิ่ม `filterBarBelow` prop — filter bar sticky ใต้ header
- **R20-25 (30→35/40)**: replay-compare 79 raw colors→tokens; shared ToggleSwitch 7 หน้า; Toast aria-live; Badge tones; /help search+links; Sidebar keyboard; Thai copy audit 10 ไฟล์; raw colors 78 จุด; confirm ก่อน toggle; filter แสดงชื่อแทน ID; in-context help 14 หน้า; undo "กู้คืน"; Loading/EmptyState; "/" focus search + Esc clear 5 หน้า; FilterSelect; visible validation; 404/error/loading pages; load-failure toasts 6 หน้า; inline validation; bulk delete (triggers); Tooltip; aria dropdowns 19 จุด
- **P8-P17 (33→36/40)**: bulk select quick-replies/knowledge; Esc ปิด dropdowns; retry "ลองใหม่" 6 หน้า; dirty-form guard (snapshot); knowledge pagination; ConfirmDialog a11y; quick-replies toggle bug + role gating; useFocusTrap 6 modals; ARIA tabs; focus-to-error; FilterPresets (localStorage + undo); useListboxNav arrow-key; Enter-to-submit; /help action-types; actionTypes.ts shared; logs humanized + responsive + col toggle; FormField pilot/required/rollout; product_spec create warning
- verify ทุกรอบ: tsc + detector `[]`; รวม 22→36/40; ⚠️ ค้าง: undo CRUD (ต้อง backend soft-delete), shared Dropdown, FormField refactor ครบ, column toggle conflict mobile

---

## Security Remediation (2026-09-22) — 19/19 ข้อ ผ่าน py_compile+tsc

- **R1 (10 ข้อ)**: C2+M2 dev-mode warn + `hmac.compare_digest` @ `app.py`; C1 SSRF URL validator (scheme+resolve+block private IP) @ `llm.py`+`or_client.py`; H2 `detail=str(e)`→generic+stderr log 9 จุด; C3 replay-compare `ALLOWED_DIRS`; H3 test-chat uploads `requireAuth`; H4 shop-settings DELETE→`requirePageEdit`; M3 key log→sha256; M4 Mongo URI `quote()`; L4 `_validate_object_id` 6 endpoints
- **R2 (9 ข้อ)**: M1 `allow_pickle=False`+dtype `<U24`; M5 DNS rebinding pin IP+Host header; M7 or_client เช็ค resolved IP; L1 Referrer-Policy+no-store SSO redirect; L2 ลบ path ใน error response; L3 SSO auto-provision→pending_approval; L5 length limit shop/title; L6 execSync→execFile; H1 user message ≤2000 chars กัน injection
- ⚠️ M6 (rate limiter multi-instance) ไม่แก้ — ต้อง Redis (infra change)

---

## ผ่านแล้ว — product types / order / comparison (2026-09-11/17/22)

### เพิ่ม 5 PRODUCT_TYPES จาก audit (2026-09-22, verified)
- ที่มา: หลังเบาะรองหลัง — 165 sub_categories ใน spec_schema.csv แต่ PRODUCT_TYPES 66 ตัว; audit 12 ตัว → ปลอดภัย 5 (อีก 7 FP หนัก: tv/desk/chair/voice_recorder/notebook/printer/facial_brush)
- เพิ่ม: `rice_cooker`(17), `hair_clipper`(34), `tv_box`(11), `blender`(29), `stylus`(7) @ `product_store.py`
- verify: detect 16/16 + FP 12/12 + pingevox/mistore 38 ผ่าน 4 error (error เดิม timeout ไม่เกี่ยว) + regression 16/16 + fetch 10/10 — รอ replay 5 ประเภทใหม่

### Audit ShpProducts — เพิ่ม 31 PRODUCT_TYPES + keywords (2026-09-11, verified)
- Root cause: mapping ไม่ครอบ 13 cat_name (Shoes/Bags/Stationery/Gaming/Motorcycles/Clothes/Food/Travel) + coverage ต่ำ (Beauty 78%, Home&Living 58%) @ `product_store.py`
- แก้: `audit_product_types.py` (ใหม่) + 31 types (bag/shoes/gamepad/electric_bike/clothing/...) + keywords ใน existing (toothbrush/car_seat/massager/voucher) + `_PRODUCT_TYPE_CATEGORIES`
- verify: regression 16/16 + new types 66/66 + coverage เช่น Men Shoes 10→82%, Stationery 0→95%, Women Clothes 0→100% — รอ replay หมวดใหม่

### Order Item Anchoring + Return/Refund Handoff (2026-09-17, impl รอ replay)
- เคส/แชท: nat041134 (Shopee) — ส่ง `[ออเดอร์]` แล้วถามต่อ → CONV-ACTIVE ไม่เจอ product; เคสคืนของ/คืนเงินไม่ส่งแอดมิน
- Root cause: order lookup บันทึกแค่ order anchor ไม่ anchor สินค้าใน order @ `app.py` (~L1757)
- แก้: (1) วน `order_info["items"]` → fetch card → `add_product(source="user_order", is_anchor)`; (2) `_RETURN_REFUND_KWS` block ก่อน tracking — มี order_sn→lookup+anchor+handoff / ไม่มี→ถามเลข; ไม่รวม "เปลี่ยนสินค้า"; (3) follow-up check bot เคยถามเลข→ลูกค้าส่งมา→handoff
- verify: py_compile + regression 16/16 — รอ replay 5 จุด; ⚠️ bug เจอ: rapidfuzz ขาด → `_FUZZY_AVAILABLE=False` → substring จับ "หัวเตียง" ผิด → แยก `_TOKENIZE_AVAILABLE` (parity 42/42 หลังแก้)

### Anchor comparison follow-up + partial comparison (2026-09-11, verified live 5/5)
- เคส/แชท: katess.nk — ส่ง Run → "รุ่นนี้กับตัว swim" (บอกไม่มี Swim) → ส่ง Swim → "ต่างกันไหม" → ตอบแค่ Swim ไม่เปรียบเทียบ
- Root cause 3 จุด: "swim" เป็น model kw → ข้าม comparison+CONV-ACTIVE; extract_model ดึงชื่อแบรนด์ `[:3]` ตัด Swim; follow-up สั้นไม่มี kw → active=Swim อย่างเดียว @ `app.py`
- แก้: (1) comparison follow-up ใช้ anchor history ก่อน (≥2 anchors → `_anchor_compare_ctx`, ไม่ rewrite req.message); (2) post-comparison follow-up (รอบก่อนเปรียบเทียบ+รอบนี้สั้น → คง 2 anchors); (3) partial comparison (1 anchor+model kw → `_is_partial_comp` + MODEL-REGEX min 4 ตัวดึง "swim" + merge Run ต้น list); live fixes: เพิ่ม kw "แนะนำตัวไหนดี"; warranty SM guard เมื่อมี compare ctx; KB path merge; `_ref_handled` ไม่บล็อก MODEL-REGEX ตอน partial
- verify: unit 4/4→6/6 + live katess 5/5 (Q2-Q5 เปรียบเทียบ Run vs Swim ครบ)
- ⚠️ Q2 "swim" ค้นไม่เจอ = product search quality issue แยก

---

## ผ่านแล้ว — แก้เล็กกระจาย (2026-09-14/16)

### /admin-config + /config layout (2026-09-14, verified)
- ลบ LLM Context Limit card ซ้ำใน /config (เก็บ slider ใน /admin-config เป็น single source); 2-col→masonry `columns-2` ทั้งสองหน้า; "ร้านที่เปิดใช้งาน" max-h+scroll; admin-config เต็มจอ 3 คอลัมน์; slider ห่อ wrapper+label+min/max (เดิมดูเหมือนปุ่มขาว กดแล้วค่ากระโดด)
- verify: tsc + build

### Link follow-up + LLM ส่งลิงก์/รูป (BUG-H, 2026-09-16, verified)
- เคส: "อยากได้หัวชาร์จ ไอโฟน13" → แนะนำแต่ไม่ส่งลิงก์/รูป; "ขอลิงค์สินค้า" → RAG ใหม่ดึงผิดรุ่น (ZA453)
- Root cause: prompt ส่งลิงก์เฉพาะเมื่อ "สนใจซื้อ"; "ลิงค์" ไม่อยู่ `_GENERIC_Q_KWS` → ไม่ใช้ anchor/suggestion @ `llm.py` (L472), `conversation_products.py`
- แก้: prompt ส่งลิงก์+รูปเสมอเมื่อแนะนำ (ยกเว้นเคลม/อารมณ์เสีย/handoff); เพิ่ม kw ลิงค์/link/ช่องทางซื้อ; `get_recent_suggestions`/`get_anchor_and_suggestions`; LINK-FOLLOWUP block ใช้สินค้าใน timeline (≤5) แทน RAG; `_strip_card_for_storage` เก็บ status+`_available_for_sale`; suggestions 3→5
- verify: live Q1 ส่งลิงก์ทันที + Q3 ส่งลิงก์ 5 สินค้าที่แนะนำไป (NORMAL ทั้งหมด)

### Vision ไม่อ่านรูป — SSRF block + URL ใน text (2026-09-16, verified)
- Root cause 3 จุด: SSRF บล็อก loopback (TestChat local URL) ไม่มี flag ปิด; image URL ใน text ไม่ถูก detect; HTTPS IP pinning ทำลาย SSL cert @ `llm.py` (L807/822), `app.py` (L1390)
- แก้: env `BOT_VISION_ALLOW_LOOPBACK=1` (dev เท่านั้น — production ห้ามตั้ง); regex จับ Shopee image URL ใน text → vision; pin IP เฉพาะ HTTP (HTTPS ใช้ cert กัน rebinding)
- verify: อ่านรูป Shopee URL ได้ (Mi Air Purifier 2C) + TestChat ผ่าน

### Dual-tier แนะนำแค่ 1 ตัว → "อย่างน้อย 2" (2026-09-16, verified)
- Root cause: prompt "สูงสุด 2 ตัวเลือก" (ceiling) → LLM เสนอ 1 ตัว @ `llm.py` (L346), `app.py` (L757)
- แก้: "ถ้ามี ≥2 compat → ต้องแนะนำอย่างน้อย 2" ทั้ง prompt + context note
- verify: "iphone 18 promax" → baseline+upgrade+ลิงก์ — ต่อยอดจาก Phase 3b

### CODE-level compat filter — กรอง connector ไม่ตรง (2026-09-16, impl)
- Root cause: ทุกสินค้าเข้า LLM ให้ตัดสินเอง (เช่น Lightning เข้าเคส iPhone 17 USB-C)
- แก้: intent คืน `device_connector`+`device_min_watt`; `_KNOWN_DEVICE_SPECS`+`_extract_product_connectors`+`_resolve_device_spec`+`_filter_compat_products` (กรองก่อน LLM, sort wattage asc); priority intent→web→hardcode; safe fallback (ดึง spec ไม่ได้/เหลือ<2/ว่าง → คืนเดิม) @ `intent_classifier.py`, `app.py`
- verify: py_compile; อ้างอิง: ปิดช่อง "connector filter ยังเป็น LLM-level" ของ Phase 3b

### "ขอที่อยู่ส่งกลบ/ส่งเคลม" ไม่ handoff (2026-09-16, verified)
- เคส/แชท: mistorethailand — "ขอที่อยู่ส่งกลบ"/"ต้องการที่อยู่ด่วน" → ถามเลขออเดอร์แทน handoff
- Root cause: `_RETURN_REFUND_KWS` ไม่มี "ที่อยู่" + ไม่มี order_sn → เข้า branch ถามเลข @ `app.py`
- แก้: `_ADDRESS_REQUEST_KWS` block ก่อน return/refund — match → handoff ทันที (reason=address_request)
- verify: live 4 เคสผ่าน

### "p23 มีขายไหม" หาไม่เจอ (2026-09-16, verified)
- เคส/แชท: KingGadgets — DB มี CUKTECH P23 4 ตัว NORMAL แต่บอทบอกไม่มี
- Root cause: `_kb_model_kws` filter `len>=4` → "p23" (3 ตัว) ถูกกรอง → MODEL-REGEX ไม่ทำงาน @ `app.py` (L4595)
- แก้: `len(w)>=3 and re.search(r"\d", w)` — รับ code สั้นที่มีตัวเลข (p23/k9/x7)
- verify: live เจอ P23+ลิงก์+รูป

### Warranty follow-up anchor poisoning (2026-09-16, แผน verify แล้วระดับ cause)
- เคส/แชท: conv thwtchtpyn (CukTechThailand) — Q5 "รุ่นไหนประกันยังไงบ้าง" ตอบประกันสายชาร์จเก่า CTC615S; CTC615S กลาย anchor ถาวรทุกคำตอบ (แม้แค่ส่งสติกเกอร์)
- Root cause: `_is_followup_policy` `_last_model_msgs[-2:]` join เก่าก่อน → `valid_models[0]`=รุ่นเก่า; req.message rewrite → resolve คืนตัวเดียว; `_record_suggestion_products` extract kw จาก rewritten → anchor poison; "Mi" kw match "Mi" ใน PB150S → false anchor @ `app.py` (~L2780)
- แผน: reverse `_last_model_msgs` (ล่าสุดก่อน) + resolve ทุกรุ่นใน `_unique_models[:3]`; extract anchor kw จาก `req._followup_original` + กัน kw สั้นไร้ตัวเลข

---

## Refactor + ponytail audits (2026-09-15/16)

### Config — ponytail auto-invoke (2026-09-15, done)
- `AGENTS.local.md` (ไม่ commit, ใน .gitignore) สั่ง invoke ponytail full ทุก session

### Ponytail audits — report only (2026-09-15)
- **repo-wide**: 3 engines ขนาน (legacy 8,239 + v2 1,491 + v3 ~1,783); dead code ~203 บรรทัด (`search_and_answer`, `_score_card`, `_is_sold_out`, `lookup_orders_by_buyer`, `get_recent_suggestions`, `is_generic_question`); dead deps requirements.txt ×4 (resend/PyJWT/bcrypt/email-validator); compose lazada/tiktok ชี้ app ที่ไม่มี; test harness ซ้ำ — verdict: แผน retrieval redesign แก้ปัญหาจริง
- **app.py legacy**: `chat()` ~6,325 บรรทัด 26 returns; warranty SM inline ~850 บรรทัดซ้ำ warranty_flow; handoff urllib 8 จุดทั้งที่ `_send_handoff` มี; comparison quartet; tax invoice 2 block; test-chat API ~370 บรรทัด
- ⚠️ KEEP BY DESIGN: chat_v2/chat_models/warranty_flow/chatbotv3 (~4,200 บรรทัด) — user ยืนยันเก็บพัฒนาต่อ อย่า flag อีก

### Refactor legacy app.py — 8,239 → 4,807 บรรทัด (2026-09-16, verified)
- ไฟล์ใหม่: `test_chat_api.py` (9 routes), `device_compat.py` (519), `order_flow.py` (537 — order lookup+return/refund+tracking), `handoffs.py` (260 — human/tax/TISI)
- ย้าย: warranty SM→`warranty_flow.py` (~950), auto-check→`warranty.py`, `_web_search_reanswer`→`web_search.py`, brand helpers→`knowledge_base.py`, `_dedupe_*`→`product_store.py`, `_gemini_cost`→`llm.py`
- Dedupe: handoff urllib 8→`_send_handoff`; `_qa10` 13→1; `model_name` 27→1; `_add_context_note`; dict→ChatResponse ×2
- Dead code ลบ (0 call sites): `_has_warranty_history`, `_warranty_calc_note`, `_pre_product_types`, `_strip_kb_markup` (alias llm), `_score_card`, `_is_sold_out`, `search_and_answer`, `lookup_orders_by_buyer`, `get_recent_suggestions`, `is_generic_question`
- Bug ที่ replay จับ (แก้แล้ว): `_model_name` assignment หลุดตอน extract → post-handoff 500; `web_search.py` ขาด `import re`; `order_flow.py` ขาด HTTPException; `_re_w` alias หลุดใน device_compat
- verify: py_compile ทุกไฟล์ + import + openapi 9 routes + smoke 6 paths + **pingevox/mistore 41/42** (Q29 logic เดิม; error อื่น = Gemini 429 quota) + **katess 5/5** + unit 24/24 + **modules live 13/13** + test_all_conditions 54/54 + test_flow 7/8 (Q8 nondeterministic)
- ⚠️ pre-existing พบ: `lookup_by_tracking` ค้นเฉพาะ `package_list.*` แต่ Shopee เก็บ `tracking_no` top-level → tracking miss เสมอ (ก่อน refactor เหมือนกัน)
- ยังไม่ทำ: `_respond()`/`_record_step()` (rounding ต่างกันจริง), comparison quartet+KB merge (~2,900 บรรทัดผูก chat() state — เสี่ยงสูง)

### ensureIndexes partial index `$exists:false` บน MongoDB 5.0 (2026-09-15, verified)
- อาการ: chatadmin-web start → `ensureIndexes failed: unsupported expression in partial index: $not` code 67
- Root cause: MongoDB 5.0.32 ไม่รองรับ `$exists:false` ใน partial index; index เก่าโดน drop แต่ใหม่สร้างไม่ได้ @ `mongoClient.ts` (L168)
- แก้: drop 2 old index ใน loop; แทน 2 partial ด้วย unique ธรรมดาบน `{scope,conversation_id,generation_batch_id}` (field ไม่มี→null → legacy unique 1 ต่อแชทอัตโนมัติ)
- verify: tsc + build + in-memory Mongo 4/4 (reproduce code 67 / fix pass / legacy unique 11000 / multi-batch ผ่าน) — รอ verify deploy จริง

---

## ผ่านแล้ว — video / unit index / data pipeline (2026-09-15/16/21)

### Video understanding + media transport 6 paths (2026-09-15, impl+tsc รอ e2e)
- ตรวจ: shadowbot ✅; botworker ⚠️→✅ (workflow `let_ai_respond` ทิ้ง video — `EngineMessage` ไม่มี images → เพิ่ม field + ใช้ `msg.images`); test-chat ⚠️→✅ (upload URL ไม่มี extension → client ส่ง `media_types` + buffer เช็ค content-type); live/test assignment + replay ✅
- `llm.py`: timeout 180s video, MIME จาก Content-Type, video prompt (motion/sequence/audio), label `[วิดีโอที่ N]`
- verify: py_compile + tsc — รอส่งวิดีโอจริง

### Sellable unit index — Tasks 1-2, 4-5, 8-9 (2026-09-16/21, verified)
- `unit_classifier.py` + `build_sellable_units.py` → `sellable_units.jsonl` 26,970 units (sellable 4,969, classified 94.2% ≥ gate 90%)
- `import_adminbase.py` → kb_products=1,011 / kb_qa=393 / kb_raw=1,040 (แก้ duplicate columns ที่ dict overwrite ทำข้อมูลหาย); `spec_key_map.py` ~45 canonical keys
- `build_typo_dict.py` (brands 221 / model_codes 2,119 / words 4,012 / thai 5,603); `build_embeddings --units` → unit_embeddings.npz
- Task 8: `USE_UNIT_INDEX=charger` staged — unit path เฉพาะ charger-family, อื่นๆ legacy; regression 16/16+42/42
- Task 9: `responses.py` (ย้าย `_routing`+`_send_handoff`), `guards.py` (build_flags+check_output ที่ model_post_init log-only), `units.attach_kb_specs` (desc ว่างยืม canonical_specs ผ่าน model_codes)
- Bug ที่ live จับ: absolute import `chatbot.shopeechat.*` → gate except กลืนเงียบ → relative-first fallback; `to_unit_card` price float → `{min,max}` shape
- Runtime fixes: HA835 qualifier scoring; AL870 compat phrase "สำหรับ iPhone" กลืน phone→strip; `_sellable_mask` vector level (top-50 เป็น deleted หมด)
- verify: unit_classifier 10/10, test_units 5/5, sellable/kb_import/route_context/unit_card_fields ผ่าน; live 8015 unit path engage (hits=30, code-hit ตอบ "หมดสต็อก" ตรง truth)

### prod :8010 พัง 500 ทุก /chat — BrokenPipeError (2026-09-16, fixed)
- Root cause: process เก่าไม่มี --reload, stdout/stderr ชี้ pipe ที่ปลายอ่านตาย → `print(file=sys.stderr)` → BrokenPipeError → 500 ทุก call (environment เสื่อม ไม่เกี่ยวโค้ดใหม่)
- แก้: kill → start ใหม่ `nohup uvicorn ... > exports/uvicorn_8010.log 2>&1`
- verify: greeting/car-charger/HA835 200; ⚠️ บทเรียน: shopname ต้องตรง DB (`CukTechThailand` ไม่ใช่ `cuktech`)

### image_texts pipeline — extract spec จาก description images (2026-09-21, กำลังรัน)
- `build_image_texts.py`: Gemini vision extract {kind,text} จาก `description_info` เฉพาะ sellable → `exports/image_texts.jsonl` (resume ได้); rate ≤80/min ≤4,000/day; `_log_ai_usage` ทุก call
- Bug แก้: `genai.Client` ใหม่ทุก call → "client has been closed" (GC ปิด shared httpx) → cache client ต่อ key; `price_info` เป็น list
- Resume 8 shards: สลับ model 3.5↔3.1 (quota pool แยก) ~133/min/model; `IMGTXT_MIN_INTERVAL` env
- `import_image_texts.py` → Mongo `image_texts` (idempotent); `units.attach_image_texts` join kind=spec|product → `image_text` ≤2500 + banner warranty → `warranty_text`; verify 20/20 units ได้ image_text

### KB QA wiring + troubleshoot-first (2026-09-16, verified)
- Root cause: runtime อ่าน `knowledge_base` เก่า (1 doc) ทั้งที่ `kb_qa` มี 392 docs ไม่มีใคร query → "นาฬิกาแบตลดไว" ไม่ hit KB
- แก้: repoint `_search_kb_single`→kb_products (canonical_specs/specs_raw), `get_general_faq`→kb_qa; `build_embeddings --qa`→qa_embeddings.npz (392); `search_qa`+`qa_context` (sim+model/item boost, cross-model guard, brand scope startswith); wire `_combined_extra` + warranty claim-first prepend tips; `_unit_warranty`/`to_unit_card.warranty`
- troubleshoot-first: claim+tips ผ่าน gate 3 ชั้น (level/`_qa_sim`≥0.5/len≥30) → `warranty_troubleshoot` ไม่ handoff, stage="ts_suggested"; "ไม่หาย"→claim info+handoff; "หายแล้ว"→resolved; bare claim→ขอข้อมูลตรง
- verify: test_qa_kb 26/26 + smoke (เคลม→tips จริง, ไม่หาย→handoff, bare claim→สะอาด); rollback `USE_QA_KB=0`

### _KNOWN_BRAND_SET → auto-derive จาก DB (2026-09-16, verified)
- `_known_brands()`: baseline ∪ distinct(brand) จาก kb_products+sellable_units (cache, DB ล่ม→baseline fail-open); `_norm_brand()` ตัดวงเล็บ/junk/สั้น<3
- ผล: 33→182 แบรนด์ (amazfit/baseus/dji/dreame/huawei...); verify: 28/28

### kb_qa near-real-time + npz auto-reload + refresh_data.sh (2026-09-16, verified)
- `_qa_docs` TTL 5min + Lock (sync def→threadpool) + fail→stale; `_qa_embed_missing` lazy-embed doc ใหม่ (key `_id` ไม่ realign); `_known_brands` TTL เดียวกัน
- npz: build เขียน `.tmp`+`os.replace` atomic; 3 loaders (product/unit/qa) stat mtime ทุก call → reload เอง; edge: replace ระหว่าง load/ไฟล์หาย → cache เก่า
- `refresh_data.sh` nightly: export→product emb→units→unit emb→qa emb→image OCR→import; `mkdir` lock; cron `0 3 * * *`; ไม่มี restart
- verify: lazy-embed sim 0.819; touch npz→reload ทันที; 28/28 + test_units

### unit card fields + `fuzzy_match_products` fix (2026-09-17, verified)
- `units.attach_listing_fields()`: join ShpProducts ด้วย item_id int (ห้าม str — เจอ type mismatch) → `_listing` {condition,weight,dimension,short_link,promotion,is_flash_sale,image}; `to_unit_card` image_url จาก `image_ids[0]` + fields — แก้ unit path ส่งลิงก์/รูป/โปรไม่ได้
- `fuzzy_match_products` 3 fix: ตัด `item_status:NORMAL` (ตอบ BANNED/UNLIST ได้); prefix-3 พลาด → rescan ≤2000 docs; `_common`∪`_known_brands()` + avg per-token score (กัน brand match ชนะคนเดียว)
- verify: ShowSee A1-W (BANNED) เจอ+sale:False; "khoxsee"/"redmi wach 6"@2108 docs → Watch 6 top1; fallback ~5.4s เฉพาะตอน primary พลาด; 28/28+16/16

---

## LLM config / quota / roles (2026-09-17)

### Single-key quota manager (impl — รอ user ตั้ง env)
- เปลี่ยน 9 keys round-robin → `GEMINI_API_KEY` เดียว: `_acquire` sliding window 60s/model (RPM/TPM/RPD persist `exports/.gemini_quota.json`); RPD เต็ม→fallback model (3.5↔3.1 pool แยก=2x capacity); `_generate` wrapper 429→retry fallback; patch 5 call sites; env `GEMINI_RPM/TPM/RPD`
- verify: unit + live `[QUOTA] 3.5 429→fallback 3.1` จริง; ⚠️ รอ user ตั้ง key + ลบ `_1.._9` + restart
- หมายเหตุ: ต่อมาระบบเปลี่ยนเป็น runtime config (ด้านล่าง) — pool db 9 keys กลับมาใช้

### Runtime LLM config — `/llm` + key pools + providers + AES (verified)
- `system_configs.llm_config`: keys pool `[{name,value,enabled}]` (legacy string[] อ่านได้), models per-role, `key_source` env|db|single, `providers` gemini|openrouter, `openrouter_keys` แยก pool
- bot: `get_llm_config` TTL 10s+fail-stale; `_active_keys` ตาม source; `get_model(role)`; `_generate(role=)` provider=openrouter→`_openrouter_generate` (map `google/{id}`, `_or_messages` 3 shapes, OR พัง→fallback gemini); `getAvailableModels` ดึง live ทั้ง 2 provider (openrouter_search auto `:online`)
- web: `/llm` dev-only; GET masked (sha256:8+tail4); PUT ops (add/remove/toggle/rename/set_source/providers); SearchableSelect; `KeyPoolCard` ×2
- กฎ roles: `/roles` page — `lib/pages.ts` PAGES 27+DEFAULT_PERMISSIONS+resolveAccess (dev→edit เสมอ, role-admin non-dev→none); `rolePermissionService` (seed อัตโนมัติ, กันลบ builtin+dev); authorize async DB TTL 30s fallback DEFAULT; `/users` ModalSelect assign (dev→ทุก role, superadmin→ยกเว้น dev, ห้ามเปลี่ยนตัวเอง, role ต้องมีใน matrix)
- AES-256-GCM at rest: `enc:v1:iv:tag:ct`, master=`LLM_MASTER_KEY` (64-hex หรือ passphrase→sha256) ต้องตั้งทั้ง web+bot; migrate-on-write re-encrypt; plaintext passthrough (ไม่ตั้ง key=เดิม)
- verify: tsc+py_compile+stub (pool/source/provider/messages)+resolveAccess ตรง matrix เดิม+cross-lang round-trip Node→Python; ⚠️ `/roles` ไม่อยู่ใน PAGES โดยเจตนา (กันล็อกตัวเอง)

---

## Sellable-first ranking + live stock join (2026-09-17, verified)

### context เต็มของตาย + compat pool หด + compare ไม่เห็น suggestions
- Root cause 5 จุด: `_available_for_sale` เช็กแค่ NORMAL ไม่เช็ก stock; sort ไม่มี sellable tier (ของตาย promo+recency สูงลอยขึ้น top); unit index `sellable` เป็น build-time snapshot (KingGadgets เหลือ 6/275 ทั้งที่ live 113); compat ที่ classify เป็น product_recommend หลุดเข้า unit path (pool เล็กตัด sweep); compare เห็นแค่ anchors ไม่เห็น suggestions
- แก้ (legacy เท่านั้น): `product_store._doc_sellable` (NORMAL&&stock>0, model[] รุ่นใดมีก็นับ) + `_available_for_sale` ใช้ stock>0; rerank/name-match เพิ่ม sellable tier แรก; unit gate skip เมื่อ compat; `units.fetch_units` sort (code-hit,sellable,-score) + `attach_listing_fields` ดึง status/stock สด + `_live_availability`/`_live_sellable` (per-model) + overfetch×2→live re-sort→[:limit]→all-dead คืน[] ตก legacy; `app.py` `is_compat_check` ส่ง target_device; CONV-ACTIVE ไม่ pin เดี่ยวเมื่อ compare/superlative; `get_latest_suggestion_batch` merge เข้า products
- verify: "หัวชาร์จละ" 12/12 sellable (ทั้ง UIF on/off); compat xiaomi 17 ultra top 120W/100W/90W (เดิม 45-67W); HA835 code-hit flag dead ถูก; suggestion-batch 5/5; regression ทั้งชุด (unit/parity 42/qa 10/warranty 11/new_types 66)
- ยังไม่ทำ: hard filter status, neural reranker (F6), charger kw data-driven, unit index rebuild (deploy step)

