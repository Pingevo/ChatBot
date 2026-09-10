# SRS / SSD — ChatBotProductMS

> Software Requirements Specification + System Design Document  
เอกสารนี้อธิบายระบบ chatbot ปรึกษาสินค้าของเครือร้าน Shopee ทั้งสถาปัตยกรรม กระบวนการทำงาน รายการฟังก์ชันทั้งหมด (หลัก+ย่อย) สถานะปัจจุบัน และแผนอนาคต

วันที่จัดทำ: 2026-09-02

---

## สารบัญ

1. [ภาพรวมระบบ](#1-ภาพรวมระบบ)
2. [สถาปัตยกรรม](#2-สถาปัตยกรรม)
3. [ฐานข้อมูล](#3-ฐานข้อมูล)
4. [บริการภายนอก](#4-บริการภายนอก)
5. [กระบวนการทำงานของ Chat Pipeline](#5-กระบวนการทำงานของ-chat-pipeline)
6. [รายการฟังก์ชันทั้งหมด](#6-รายการฟังก์ชันทั้งหมด)
   - 6.1 [app.py](#61-apppy--fastapi--chat-orchestrator)
   - 6.2 [llm.py](#62-llmpy--gemini-llm)
   - 6.3 [product_store.py](#63-product_storepy--mongodb-retrieval)
   - 6.4 [intent_classifier.py](#64-intent_classifierpy--pass-1-llm)
   - 6.5 [knowledge_base.py](#65-knowledge_basepy--kb-lookup)
   - 6.6 [web_search.py](#66-web_searchpy--openrouter-fallback)
   - 6.7 [persona.py](#67-personapy--bot-persona)
   - 6.8 [warranty.py](#68-warrantypy--warranty--claim)
7. [คอนฟิกและตัวแปรสำคัญ](#7-คอนฟิกและตัวแปรสำคัญ)
8. [สถานะปัจจุบัน](#8-สถานะปัจจุบัน)
9. [แผนอนาคต](#9-แผนอนาคต)
10. [ปัญหาที่ทราบ + แนวทางแก้](#10-ปัญหาที่ทราบ--แนวทางแก้)

---

## 1. ภาพรวมระบบ

ChatBotProductMS คือระบบ chatbot ปรึกษาสินค้าสำหรับเครือร้านค้าออนไลน์บน Shopee โดยทำหน้าที่:
- ตอบคำถามเกี่ยวกับสเปค/ความสามารถ/รับประกันของสินค้า
- แนะนำสินค้าจากร้านที่ลูกค้าทักเข้ามาเท่านั้น (shop isolation)
- เปรียบเทียบสินค้าหลายรุ่นแบบสเปคต่อสเปค
- จัดการเรื่องการเคลม/รับประกัน/ใบกำกับภาษี → ส่งต่อแอดมินเมื่อจำเป็น
- ค้นหาข้อมูลเสริมจากอินเทอร์เน็ต (OpenRouter) เมื่อข้อมูลในระบบไม่พอ

ระบบประกอบด้วย 2 ส่วนหลัก:
1. **ChatAdminWeb** — Next.js admin console (frontend + BFF)
2. **chatbot/** — Python FastAPI backend (เฉพาะ `shopeechat/` ที่ใช้งานจริง)

---

## 2. สถาปัตยกรรม

```
┌─────────────────────────────────────────────────────────────┐
│  เบราว์เซอร์แอดมิน                                          │
│   ChatAdminWeb (Next.js 16 + React 19 + Tailwind 4)         │
│   - console: dashboard, chats, knowledge, persona,          │
│     triggers, shops, team, test-assignment, shadow-inbox... │
│   - BFF proxy → /api/chatbot/[...path]                      │
└──────────────────┬──────────────────────────────────────────┘
                   │ HTTP + X-Internal-Secret
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  Python FastAPI chatbot                                      │
│   chatbot/shopeechat/app.py  :8010 (shopee)                 │
│   chatbot/lazadachat/        :8011 (placeholder)            │
│   chatbot/tiktokchat/        :8012 (placeholder)            │
│                                                              │
│   Pipeline:                                                  │
│   intent → KB → product_store → reference/carry-forward →   │
│   rerank → llm.answer → web_search fallback                 │
└────┬───────────────┬───────────────┬────────────────────────┘
     │               │               │
     ▼               ▼               ▼
┌─────────┐   ┌──────────────┐  ┌─────────────────┐
│ MongoDB │   │ Google       │  │ OpenRouter      │
│ admin   │   │ Gemini LLM   │  │ (web search)    │
│ + product│  │ (gemini-2.0- │  │ google/gemini-  │
│         │   │  flash)      │  │ 2.5-flash:online│
└─────────┘   └──────────────┘  └─────────────────┘
                                        │
                                        ▼
                                 ┌──────────────┐
                                 │ AI Usage Hub │
                                 │ (log usage/  │
                                 │  cost)       │
                                 └──────────────┘
```

### การเชื่อมต่อระหว่างส่วน

| จาก | ไป | วิธี | หมายเหตุ |
|---|---|---|---|
| Browser | Next.js | HTTP | Next.js auth (JWT cookie `cc_session`) |
| Next.js | FastAPI | HTTP + `X-Internal-Secret` header | ผ่าน BFF proxy `/api/chatbot/[...path]` |
| FastAPI | MongoDB | pymongo | 2 DB: admin + product |
| FastAPI | Gemini | `google.genai` SDK | API key rotation 9 keys |
| FastAPI | OpenRouter | `urllib.request` | เฉพาะ fallback |
| FastAPI | AI Usage Hub | `urllib.request` | log usage/cost |

### การ mirror ข้อมูลแชทเข้าระบบ

ข้อความลูกค้า/แอดมินจาก Shopee **ไม่ได้ดึงโดยตรงจาก API ของระบบนี้** แต่ถูก mirror เข้า MongoDB (`conversations_shp`, `messages_shp`) โดย sellcenter/Zaapi data mirror ระบบเราอ่านมาใช้เท่านั้น

---

## 3. ฐานข้อมูล

### 3.1 Admin DB: `chatbot_admin`

ใช้ env `ADMIN_MONGO_*` (URI/DB/collection names)

| Collection | หน้าที่ |
|---|---|
| `admins`, `auth_tokens`, `sessions` | ผู้ใช้และ auth |
| `conversations_shp`, `messages_shp`, `customers_shp` | แชทที่ mirror จาก Shopee |
| `shops` | ร้านค้า |
| `knowledge_base` | KB: `product_spec` + `general_faq` |
| `triggers` | keyword-based rules (bot_answer / handoff_admin) |
| `shop_personas` | ชื่อบอทต่อร้าน |
| `shop_settings` | ตั้งค่าร้าน (เช่น faq_liveagent_action) |
| `shadow_replies` | คำตอบบอท (shadow mode — ไม่ส่งกลับ Shopee) |
| `test_assignment` | ผล replay + rating |
| `test_chat_ratings` | คะแนน test chat |
| `quick_replies` | คำตอบสำเร็จรูป |
| `chat_accept_sessions` | มูลค่า/เวลารับแชทของ admin |
| `chat_processing` | polling pipeline state |
| `buffer_messages` | debounce buffer |
| `assignment_configs`, `assignment_cursors` | การจ่ายงาน admin |
| `shop_team_assignments`, `platform_team_assignments` | ทีม admin ต่อร้าน/platform |
| `close_history`, `tickets`, `admin_logs`, `pushevents`, `requestlogs` | ประวัติ/ticket/log |
| `system_configs`, `guardrails` | config + guardrails |

### 3.2 Product DB: `dbWallet` (read-only)

ใช้ env `MONGO_*`

| Collection | หน้าที่ |
|---|---|
| `ShpProducts` | สินค้า Shopee — ใช้หลัก |
| `OpenLazadaProducts` | สินค้า Lazada (placeholder) |
| `TikProducts` | สินค้า TikTok (placeholder) |

#### Schema สำคัญของ `ShpProducts`

| Field | การใช้งาน |
|---|---|
| `item_id` | PK (int/float/str) |
| `item_name` | ชื่อสินค้า — ใช้ regex/text search |
| `item_status` | NORMAL / อื่นๆ |
| `brand.original_brand_name` | แบรนด์ |
| `cat_name`, `category_id` | หมวดหมู่ |
| `shopname` | ร้าน — ใช้กรอง |
| `description` | คำอธิบาย — ตัด excerpt ให้ LLM |
| `short_link` | Shopee short URL |
| `image.image_id_list` | รูปสินค้า |
| `model[].price_info.current_price` | ราคา |
| `model[].stock_info_v2.summary_info.total_available_stock` | stock |
| `attribute_list` | รับประกัน |
| `promotion`, `has_promotion`, `is_flash_sale` | สัญญาณ rerank |
| `create_time`, `update_time_unix` | recency |
| `weight`, `dimension` | สเปค |

### 3.3 KB schema (`knowledge_base` collection)

**`product_spec` doc**: `type`, `active`, `brand`, `model`, `category`, `highlights`, `description`, `box_contents`, `warranty_period`, `warranty_note`, `specs`, `extra_fields`, `notes`, `weight`, `dimensions`

**`general_faq` doc**: `type`, `topic` (เช่น `"รับประกัน"`), `answer`, `active`

---

## 4. บริการภายนอก

| บริการ | วิธีใช้ | รายละเอียด |
|---|---|---|
| **Google Gemini** | `google.genai` SDK | model `gemini-2.0-flash` (default) + `gemini-3.1-flash-lite` (intent) — 9 API keys หมุนวน |
| **OpenRouter** | `urllib.request` | model `google/gemini-2.5-flash:online` — เฉพาะ fallback |
| **AI Usage Hub** | `urllib.request` | log provider usage/cost — fire-and-forget |
| **Shopee/Zaapi mirror** | (อ่าน MongoDB) | ข้อมูลแชทจริง mirror เข้ามา |
| **Resend** | (optional) | อีเมล signup/reset |

---

## 5. กระบวนการทำงานของ Chat Pipeline

`POST /chat` ใน `app.py` รัน stage เรียงตามลำดับ — แต่ละ stage อาจ short-circuit return กลับเลย:

```
┌──────────────────────────────────────────────────────────────┐
│ 1. โหลด persona (persona.get_persona)                       │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. ถ้ามี [item: xxx] tag → ดึงสินค้าตรง + ตอบทันที              │
│    _extract_item_id_tag + product_store.fetch_product_by_id  │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. detect general question (KB)                              │
│    knowledge_base.detect_general_question                    │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. tax-invoice handoff (warranty.detect_tax_invoice_request) │
│    → ส่งแอดมินทันที                                            │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 5. Pass 1 LLM intent classification                         │
│    intent_classifier.classify_intent                         │
│    (Phase 6 — รันทุกข้อความ ไม่ gate ด้วย should_run_pass1)    │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 6. warranty/return/shipping follow-up + comparison follow-up │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 7. warranty date follow-up + claim state machine             │
│    warranty.parse_purchase_date / is_in_warranty /           │
│    detect_claim_request / extract_customer_info              │
│    → อาจ handoff แอดมิน                                       │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 8. general question branch → llm.answer_general              │
│    (ใช้ build_general_context จาก KB/product DB)              │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 9. brand question branch → _build_brand_context + LLM        │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 10. KB lookup path                                           │
│     knowledge_base.lookup_kb → _merge_kb_mongo → llm.answer  │
│     → web_search fallback (ถ้า negative/uncertain)            │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 11. Product-store / RAG path (เส้นทางหลัก)                     │
│     - extract charger constraints + carry-forward guard      │
│     - reference extraction from history (model recovery)     │
│     - product_store.fetch_products (regex/vector)            │
│     - dedup + superlative rerank                             │
│     - llm.answer                                             │
│     → web_search fallback (ถ้า negative/uncertain)            │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 12. _append_base_warranty (ถ้าคำถามเกี่ยวกับรับประกัน)           │
└──────┬───────────────────────────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ 13. return ChatResponse                                     │
│     (answer, products, source, usage, timing, web_search,    │
│      handoff, routing_decision)                              │
└──────────────────────────────────────────────────────────────┘
```

### Web search fallback (ท้ายทั้ง KB path และ product-store path)

```
web_search.should_use_web_search(answer, intent, products, message)
   ├─ yes/no spec question + มีสินค้าใน context → skip (เพิ่มใหม่)
   ├─ warranty/spec/comparison + มีสินค้า → skip
   ├─ uncertainty markers → search
   ├─ compatibility_check_negative_answer → search (skip ถ้า yes/no)
   ├─ compatibility_check_device_specific → search
   ├─ spec_query_negative_answer → search
   └─ negative_answer → search (skip ถ้า yes/no + มีสินค้า)

ถ้า search → web_search.search_and_extract
   → OpenRouter (gemini-2.5-flash:online)
   → extract keywords + search_info
   → product_store.fetch_products ด้วย keywords
   → strip external URLs จาก search_info
   → llm.answer (ใช้สินค้าจาก DB + sanitized search_info)
   → log AI Usage Hub
```

---

## 6. รายการฟังก์ชันทั้งหมด

> รูปแบบ: `function_name` (line) — หน้าที่ — เรียกอะไรบ้าง

### 6.1 `app.py` — FastAPI + chat orchestrator

#### 6.1.1 FastAPI routes (main entry points)

| ฟังก์ชัน | Line | หน้าที่ | เรียกในไฟล์ / โมดูลนอก |
|---|---|---|---|
| `_require_internal_secret` | 51 | middleware ตรวจ `X-Internal-Secret` | — |
| `_warmup` | 69 | startup hook warm embedding/KB | `product_store`, `knowledge_base`, `embedding` |
| `health` | 245 | `GET /health` — ตรวจ DB + นับ shop/category | `_db()`, `product_store` |
| `index` | 257 | `GET /` — หน้า demo | — |
| `shops` | 263 | `GET /shops` | `_db()`, `product_store.list_shops` |
| `categories` | 272 | `GET /categories` | `_db()`, `product_store.list_categories` |
| `brands` | 281 | `GET /brands` — paginated | `_db()`, `os`, `re`, `Counter` |
| `chat` | 368 | **`POST /chat` — main orchestrator** — **2026-09-14 (DEVICE-SPEC-LOOKUP + FILTER-UNAVAILABLE + COMPAT-RETRIEVAL GUARD + HYBRID-SUBTYPE)**: (1) เปิด `filter_unavailable` สำหรับ intent=product_recommend + compatibility_check (ปิดเฉพาะ product_spec/warranty ที่ลูกค้าอาจถามสินค้าที่ซื้อไปแล้ว) — กันแนะนำสินค้า sold_out ใน compat case; (2) guard `_hybrid_anchor_card` ครอบ compat-retrieval override — ถ้ามี hybrid anchor ให้ข้าม override (anchor มี subtype จากสินค้าจริงแม่นกว่า intent classifier); (3) guard `_hybrid_anchor_card` ใน charger_subtype_override — ถ้ามี anchor ให้ใช้ subtype จาก anchor แทน intent; (4) device spec lookup — ถ้า intent=compatibility_check + มี target_device → เรียก `web_search.search_and_extract` ดึง spec + keywords แล้ว re-query DB หาสินค้าที่ compatible + merge เข้า products + inject spec ใน `_combined_extra` ก่อน LLM ตอบ — กัน LLM แนะนำ 45W ให้เครื่องที่ชาร์จ 90W — **2026-09-16 (Phase 3b DUAL-TIER)**: (5) re-query products หลัง fetch_products → sort ตาม wattage **ascending** (น้อย→มาก) เพื่อให้ baseline อยู่บนสุดและ upgrade อยู่ถัดไป — LLM เห็นตัวเลือกครบเรียงตาม spec; (6) เพิ่ม context note บอก dual-tier recommendation (สูงสุด 2 ตัวเลือก: baseline + upgrade) + connector type hard filter (ห้ามข้าม connector type) + protocol evidence requirement (ต้องยืนยันจาก description จริง) | ทุก pipeline stage (ดู section 5) |
| `list_test_chat_sessions` | 5345 | `GET /test-chat/sessions` — กรองตาม admin_id (Phase 3) | `_admin_db()`, `Request.headers` |
| `create_test_chat_session` | 5385 | `POST /test-chat/sessions` — เก็บ admin_id + admin_name (Phase 3) | `_admin_db()`, `_log_testchat_action`, `urllib.parse.unquote` |
| `get_test_chat_session` | 5414 | `GET /test-chat/sessions/{id}` | `_admin_db()` |
| `add_test_chat_message` | 5437 | `POST /test-chat/sessions/{id}/messages` | `_admin_db()`, `_log_testchat_action` |
| `delete_test_chat_session` | 5477 | `DELETE /test-chat/sessions/{id}` | `_admin_db()`, `_log_testchat_action` |
| `update_test_chat_session` | 5501 | `PUT /test-chat/sessions/{id}` | `_admin_db()`, `_log_testchat_action` |
| `list_test_chat_logs` | 5612 | `GET /test-chat/logs` — รองรับ filter admin_id (Phase 3) | `_admin_db()`, `Request.headers` |
| `feedback` | 4304 | `POST /feedback` — thumbs up/down | — |

#### 6.1.2 Pipeline helpers (top-level)

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `_extract_item_id_tag` | 361 | extract `[item: xxx]` tag — **2026-09-12**: (1) เพิ่ม charger subtype mismatch check — ถ้า message มี charger subtype ชัดและต่างจาก anchor → fall through ไป fetch_products; (2) เพิ่ม compat+target_device hybrid — ถ้า message มี "ใช้กับ/รองรับ" + phone brand → เก็บ anchor ใน context + fetch สินค้าที่รองรับ + merge anchor กับ products (ทั้ง KB+Mongo และ main flow) + เพิ่ม context note บอก LLM; (3) guard "อยากได้" ด้วย compat indicator — ถ้ามี "อยากได้" + "ใช้กับ" → ไม่ใช่ new topic; (4) guard "หัว" ลอยๆ — ถ้า _detect_charger_subtype=adapter แต่ไม่มี strong adapter kw (หัวชาร์จ/adapter/gan) → ใช้ anchor ต่อ (เหมือน CONV-ACTIVE guard); (5) เพิ่ม car_charger ใน _skip_ref_due_to_subtype — กัน REFERENCE block ดึง anchor จาก history ทับ car_charger retrieval | `_ITEM_TAG_RE`, `product_store._detect_charger_subtype`, `product_store._detect_product_types` |
| `_record_suggestion_products` | 3938 | บันทึกสินค้าที่ bot แนะนำลง conversation_products timeline | `conversation_products.add_product` |
| `_strip_kb_markup` | 5563 | **BUG-2 fix** — ขจัด KB markup `[[ ... ]]`, `---`, `หมายเหตุ:` ที่หลุดจาก LLM ก่อนส่งลูกค้า | `re` |
| `_append_base_warranty` | 5590 | append warranty text เฉพาะเมื่อลูกค้าขอเงื่อนไขรับประกัน — **2026-09-14 (BUG-2)**: เรียก `_strip_kb_markup` ก่อนแนบ + หลังแนบ | `knowledge_base.is_warranty_question`, `warranty`, `_strip_kb_markup` |
| `_detect_brand_question` | 3866 | detect "Xiaomi ขายอะไรบ้าง" | `re` |
| `_build_brand_context` | 3896 | สร้าง context ของแบรนด์ | `os`, `re`, `Counter` |
| `_merge_kb_mongo` | 3959 | รวม KB doc + Mongo product card | `_kb_doc_to_card`, `re` |
| `_kb_doc_to_card` | 4060 | แปลง KB doc → product card | — |
| `_recent_qa_pairs` | ~1030 | **Phase 8 (2026-09-17)** — จับคู่ user+model message เป็น QA pair (1 คู่ = 1 หน่วย) แล้วคืน `n` คู่ล่าสุด (default 10) เรียงเก่า→ใหม่ — ใช้แทน `history` ที่ส่งเข้า LLM context/follow-up detection — รับมือ edge cases: history ว่าง/None, 2 user ติดกัน (buffer flush), model เดี่ยวต้น history, user เดี่ยวท้าย history, เกิน n คู่ — ไม่ mutate history ต้นฉบับ | — |
| `_LLM_CONTEXT_LIMIT` | ~1035 | **Phase 8 (2026-09-17)** — module constant = 30 — แยกจาก `req.limit` (frontend display limit) — ใช้สำหรับ RAG retrieval และ LLM context limit (ไม่ใช่ frontend display) — **Phase 8.1 (2026-09-18)**: กลายเป็น default fallback เท่านั้น — ค่าจริง resolve จาก `req.llm_context_limit` (per-request จาก admin config) ที่จุดเริ่มต้น `chat()` เป็น `_llm_ctx_limit` แล้วใช้แทน `_LLM_CONTEXT_LIMIT` ในทุกจุด retrieval/context (web-search re-query, KB/Mongo merge, fetch_limit, compatibility merge, Tier B cap, KB product cap) | — |
| `_extract_max_wattage` | ~531 | **Phase 3b (2026-09-16)** — extract ค่า W สูงสุดจาก product card — ย้ายจาก nested function `_extract_max_watt` ใน superlative block มาเป็น module-level helper เพื่อให้ device-spec-lookup re-query block ใช้ sort ตาม wattage ได้ — logic: (1) spec field `output_power_w` (2) variants `output_power_w` (3) fallback extract จากชื่อ กรอง model number (เช่น CTC615W) ออกก่อน — ใช้ใน superlative block (sort desc) + device-spec-lookup block (sort asc) | `re` |

#### 6.1.3 Nested helpers (ใน `chat()`)

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_kb_base_name` | 1749 | strip prefix/suffix → base name สำหรับ KB dedup |
| `_kb_sell_score` | 1761 | score เลือก duplicate ดีสุดใน KB path |
| `_extract_charger_constraints` | 1957 | extract W/mAh/PD/material จากข้อความ |
| `_is_good_keyword` | 2505 | กรอง keyword สำหรับ history-carry query |
| `_listing_sell_score` | 2949 | score เลือก duplicate ดีสุดใน product-store path |
| `_base_name` | 2970 | normalize name สำหรับ dedup (preserve bundle) |
| `_extract_max_watt` | 3034 | ดึงค่า W สูงสุดจาก spec |
| `_extract_max_mah` | 3066 | ดึงค่า mAh สูงสุด |
| `_extract_weight` | 3086 | ดึงน้ำหนัก (กรัม) |

#### 6.1.4 Utilities

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_routing` | 177 | สร้าง `routing_decision` dict |
| `_db` | 199 | คืน `(mongo_client, db)` ของ product |
| `_admin_db` | 211 | คืน admin Database |
| `_log_testchat_action` | 217 | insert audit log `test_chat_logs` |

#### 6.1.5 Pydantic schemas

| Schema | Line | หน้าที่ |
|---|---|---|
| `ChatMessage` | 101 | `{role, text}` history entry |
| `ChatRequest` | 106 | body `/chat` (message, shop, item_id, order_sn, history, limit, handoff fields, simulate, use_v2, **llm_context_limit** — Phase 8.1: per-request LLM context limit 10-50 จาก admin config) |
| `ChatResponse` | 124 | response `/chat` (answer, products, source, usage, timing, web_search, handoff, routing_decision) |
| `FeedbackRequest` | 170 | body `/feedback` |
| `TestChatMessage`, `CreateSessionRequest`, `AddMessageRequest`, `UpdateSessionRequest` | 5320-5343 | test-chat schemas |

#### 6.1.6 Test Chat Sessions — detail (Phase 3 ownership + log filter)

**`list_test_chat_sessions` (line 5345) — `GET /test-chat/sessions`**
- **Purpose:** list test chat sessions ของ admin คนนั้น (กรองตาม `admin_id`)
- **Input:** `request: Request` (header `X-Admin-Id`), query `shop?: str`, `limit?: int`
- **Output:** `{sessions: [{id, shop, title, message_count, created_at, updated_at, admin_id, admin_name}]}`
- **Calls:** `_admin_db()`
- **Called by:** Next.js `TestChatClient.loadSessions()` → proxy `/api/chatbot/shopee/test-chat/sessions`
- **How it works:**
  1. ดึง `admin_id` จาก header `X-Admin-Id`
  2. สร้าง query `$or`: `admin_id == ผู้เรียก` OR `admin_id` ไม่มี field / None / "" (legacy)
  3. ถ้ามี `shop` เพิ่มเงื่อนไข `shop` เข้าไป
  4. sort `updated_at` desc, limit
- **Side effects:** อ่าน MongoDB admin DB (`test_chat_sessions`)
- **Error/fallback:** ถ้าไม่มี header `X-Admin-Id` → ไม่กรอง (เห็นทั้งหมด) — ปลอดภัยเพราะ proxy แนบ header เสมอ

**`create_test_chat_session` (line 5385) — `POST /test-chat/sessions`**
- **Purpose:** สร้าง session ใหม่ พร้อมเก็บ `admin_id` + `admin_name` ของผู้สร้าง
- **Input:** `req: CreateSessionRequest` (shop, title), `request: Request` (header `X-Admin-Id`, `X-Admin-Name`)
- **Output:** `{id, shop, title}`
- **Calls:** `_admin_db()`, `_log_testchat_action()`, `urllib.parse.unquote`
- **Called by:** Next.js `TestChatClient.createSession()` → proxy `/api/chatbot/shopee/test-chat/sessions`
- **How it works:**
  1. ดึง `admin_id` จาก header (default "anonymous")
  2. ดึง `admin_name` จาก header แล้ว URL-decode (default "anonymous")
  3. insert doc พร้อม `admin_id` + `admin_name`
  4. log action "create_session"
- **Side effects:** write `test_chat_sessions` + write `test_chat_logs`
- **Error/fallback:** exception → HTTP 500

**`list_test_chat_logs` (line 5612) — `GET /test-chat/logs`**
- **Purpose:** ดู log การใช้งาน testchat — ใคร ทำอะไร แชทไหน เมื่อไหร่
- **Input:** `request: Request` (header `X-Admin-Id`), query `limit?: int`, `action?: str`, `admin_id?: str`
- **Output:** `{logs: [{id, action, session_id, admin_id, admin_name, shop, timestamp, ...extra}], count}`
- **Calls:** `_admin_db()`
- **Called by:** Next.js `TestChatClient.loadActionLogs()` → proxy `/api/chatbot/shopee/test-chat/logs`
- **How it works:**
  1. resolve `admin_id` filter: ถ้าส่ง query param `admin_id` มาใช้ค่านั้น, ถ้าไม่ส่งดึงจาก header
  2. ถ้า `admin_id == "all"` → ไม่กรอง (ดูทุกคน)
  3. ถ้ามี `admin_id` ปกติ → กรอง `admin_id` ใน query
  4. ถ้ามี `action` → เพิ่มเงื่อนไข `action`
  5. sort `timestamp` desc, limit
- **Side effects:** อ่าน MongoDB admin DB (`test_chat_logs`)
- **Error/fallback:** exception → HTTP 500

#### 6.1.7 NO-PRODUCT-GUARD — ห้าม LLM ตอบจาก context ที่ไม่น่าเชื่อถือ (BUG-10, 2026-09-08)

- **Purpose**: กัน QA BUG-10 — เมื่อค้นสินค้าไม่เจอ หรือเจอแต่ผลมาจาก vector fuzzy ล้วน (ไม่มี product intent ใดๆ กำกับ) แล้วปล่อยไปให้ LLM ตอบ → LLM แต่งคำอธิบายสต็อก/แคตตาล็อกของร้านเอง (เช่น "สินค้าทุกรายการหมดสต็อก", "ร้านขายหัวชาร์จเป็นหลัก") — แทนที่ด้วยคำตอบตายตัว "ไม่พบข้อมูล + ส่งต่อแอดมิน"
- **Input** (อ่านจากตัวแปรใน `chat()` หลัง shop fallback บรรทัด ~4638):
  - `products` (list[dict]) — ผลค้นหาหลัง fallback ทุกชั้น (REF-NAME, charger subtype, shop)
  - `_vision_context` (str) — ถ้ามีรูป (ไม่ว่าง) → ยกเว้น guard
  - `_guard_has_intent` (bool) — มี product intent ไหม: `_guard_ptypes` (จาก `product_store._detect_product_types`) + `_guard_ref_models` (จาก `ref_models`) + `_guard_charger_sub` (จาก `_intent_sub` หรือ `product_store._detect_charger_subtype`) + `_guard_model_kw` (จาก `_cur_model_kw`) + `_is_conv_active`
  - `_guard_seek_specific` (bool) — ถามหาของเฉพาะ: `("มี"+"ไหม") / "มีไหม"/"หาไหม"/"อยากได้"/"มีขาย"/"ขายไหม"` และไม่ใช่ browse (`แนะนำ/มาใหม่/โปร/ลดราคา/ขายดี/การ์ด/มือใหม่/ครบ/ดูสินค้า`)
- **Output**: dict response (return ก่อนเข้า LLM) — `answer` ตายตัว, `products=[]`, `source="no_product_found_handoff"`, `handoff_to_admin=True`, `handoff_reason="no_product_found"`, `routing_decision=_routing("handoff", ...)`, `usage` ทั้งหมด 0 (ไม่เรียก LLM)
- **Calls**: `product_store._detect_product_types`, `product_store._detect_charger_subtype`, `_routing`
- **Called by**: `chat()` (inline block บรรทัด ~4638 — หลัง shop fallback ก่อน follow-up filter)
- **How it works**:
  1. ถ้า `_vision_context` ไม่ว่าง (ลูกค้าส่งรูป) → skip guard (ปล่อยไป LLM ตอบเรื่องรูป)
  2. คำนวณ `_guard_has_intent` + `_guard_seek_specific`
  3. แขน 1: `not products and (_guard_has_intent or _guard_seek_specific)` → guard
  4. แขน 2: `products and not _guard_has_intent and _guard_seek_specific` → guard (ผล vector fuzzy ล้วนไม่น่าเชื่อ — เคส QA "หัวฉีด" ดึงพัดลมมา)
  5. Guard ทำงาน → log `[NO-PRODUCT-GUARD]` + return คำตอบตายตัว + handoff
- **Side effects**: log `[NO-PRODUCT-GUARD]` — ไม่มี DB write ในตัว (handoff ทำโดย caller ผ่าน `handoff_to_admin` field ใน response)
- **Error/fallback**: ใช้ try/except NameError กับ `ref_models`/`_cur_model_kw` (อาจไม่ถูกประกาศในบาง path) → default None

---

### 6.2 `llm.py` — Gemini LLM

#### 6.2.1 Main generation

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `answer` | 434 | ตอบคำถามสินค้าจาก product context | `_client()`, `_build_context()` |
| `answer_with_kb` | 604 | ตอบจาก KB context (ไม่มี product_store) | `_client()` |
| `answer_general` | 664 | ตอบคำถามทั่วไป (policy/brands/categories) | `_client()` |
| `describe_image` | 476 | **Phase 1A** vision pass — อ่านรูป 1 รูปด้วย `gemini-3.1-flash-lite` (โหลด bytes → `Part.from_bytes`) → คืน (text, usage). **2026-09-12**: `_VISION_PROMPT` เพิ่ม guard กัน hallucination — อธิบายเฉพาะที่เห็นในรูปจริง ห้ามให้ `history_context` ไปกำหนดประเภทของรูป (เช่น คุยเรื่องพาวเวอร์แบงค์แล้วรูปแมวกลายเป็นพาวเวอร์แบงค์) | `_client()`, `urllib.request`, `types.Part.from_bytes()` |
| `describe_images` | 516 | **Phase 1A** vision pass — อ่านหลายรูป (max 3) → คืน (combined_text, total_usage) | `describe_image()` |

#### 6.2.2 API key management

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_load_api_keys` | 290 | โหลด `GEMINI_API_KEY_1..9` + `GEMINI_API_KEY` |
| `_next_api_key` | 317 | หมุนวน round-robin |
| `_client` | 327 | สร้าง `genai.Client` |

#### 6.2.3 Prompt building + helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_build_context` | 357 | แปลง product cards → context string (พร้อม description_excerpt/weight/dimension) — **2026-09-08 (BUG-10)**: (1) body เมื่อ products ว่าง เพิ่มคำเตือน "ห้ามสรุปว่าหมดสต็อก/เลิกขาย/ไม่มีจำหน่าย ห้ามอธิบายว่าร้านขายอะไรเป็นหลัก → บอกไม่พบข้อมูล + ชวนทักแอดมิน"; (2) header เปลี่ยน "ให้บอกตรงๆ ว่าร้านนี้ไม่มี" → "ให้บอกว่าไม่พบข้อมูลรุ่นนี้ในระบบค่ะ ห้ามบอกว่าหมดสต็อก/เลิกขาย เว้นแต่เห็น sold_out=true หรือ status != NORMAL ของรุ่นนั้นใน context จริงๆ" |
| `split_segments` | 337 | แยก answer ด้วย `|||` |

#### 6.2.4 Module constants

| ชื่อ | Line | สรุปกฎสำคัญ |
|---|---|---|
| `SYSTEM_INSTRUCTION` | 19-320 | บุคลิกหญิงใช้ `ค่ะ/นะคะ`, ตอบจาก context เท่านั้น, แยก bubble `|||`, แนะนำ 2-3 ชิ้น, ห้ามบอกราคา, ร้าน isolation, **ห้ามแนะนำรุ่นอื่นเมื่อถาม spec รุ่นเดิม (เว้นแต่สัมพันธ์กับคำถาม)**, **ห้ามใส่ลิงก์ภายนอก**, **คำถามสั้น/กำกวม ให้ใช้ history ตีความ ห้ามตอบ "คำถามสั้นไป"**, **ตอบให้ละเอียด 2-3 ประโยค ไม่สั้นเกิน**, **คำถามเล่นๆ/นอกเรื่อง ตอบเป็นมิตรแล้วกลับสู่บริบทร้าน**, **ห้ามแนบลิงก์/รูปเมื่อลูกค้าถาม trust ไม่ได้ขอซื้อ** — **2026-09-16 (Phase 3b DUAL-TIER)**: เพิ่ม section dual-tier recommendation — เมื่อแนะนำสินค้า compat กับอุปกรณ์ที่ลูกค้าระบุ ให้เสนอสูงสุด 2 ตัวเลือก (baseline + upgrade) — กฎบังคับ: connector type ตรงเป๊ะ (hardware constraint), สายชาร์จ 2 หัว ต้องตรวจทั้งสองฝั่ง, wattage/protocol เป็นขั้นต่ำไม่ใช่ขั้นสูงสุด, ต้องยืนยัน protocol จาก description จริง, ถ้ามี compat แค่ 1 ตัว เสนอแค่ตัวนั้น, ห้ามเสนอสินค้าที่ไม่มีใน context, subtype ต้องคุมทิศทาง, นำเสนอ 2 ตัวเลือกให้อ่านเป็นธรรมชาติไม่ใช่ list แข็งๆ |
| `KB_SYSTEM_INSTRUCTION` | 572-601 | บุคลิกเดียวกัน, ตอบจาก KB context, สั้นกระชับเรื่องรับประกัน |
| `_SEGMENT_DELIMITER` | 334 | `"|||"` |

---

### 6.3 `product_store.py` — MongoDB retrieval

#### 6.3.1 Main retrieval

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `fetch_products` | 2385 | **central retrieval** — สร้าง query + filter + rerank + card — **2026-09-12 (FILTER-UNAVAILABLE)**: เพิ่ม param `filter_unavailable: bool = False` — เมื่อ True กรองสินค้า `status != NORMAL` หรือ `sold_out=True` ออกจาก cards; fallback ถ้ากรองแล้วว่าง → ปล่อยทั้งหมด + ฝัง `_context_note` ห้ามแนะนำขาย | `_detect_*`, `build_query`, `vector_search`, `_filter_*`, `_rerank_*`, `to_product_card` |
| `fetch_product_by_id` | 2880 | ดึงสินค้าเดียวโดย `item_id` | `to_product_card` |
| `fuzzy_match_products` | 559 | rapidfuzz fallback สำหรับพิมพ์ผิด | `_extract_product_name_tokens`, `to_product_card` |
| `vector_search` | 68 | cosine similarity กับ embedding NPZ | `_load_vector_store`, `embedding.embed_query` |

#### 6.3.2 Charger subtype

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_detect_charger_subtype` | 1357 | detect `cable`/`adapter`/`set`/`car_charger`/`wireless`/`desktop`/`socket` จากข้อความ (รวม shorthand `"หัว"`/`"สาย"`) — มี typo normalization `"หัวชาจ"`→`"หัวชาร์จ"` ฯลฯ — **2026-09-08 (BUG-10)**: `_other_prod_kws` เพิ่ม `"หัวฉีด"`, `"หัวพ่น"`, `"หัวข้อ"` — กัน "หัวฉีด" (อะไหล่เครื่องฟอก/พ่นน้ำ) โดน shorthand "หัว" จับเป็น adapter → ดึงหัวชาร์จมาเป็น context ผิดประเภท → LLM แต่งแคตตาล็อกร้าน — **2026-09-19 (Phase 3c)**: เปลี่ยน shorthand `"หัว"`/`"สาย"` จาก substring match → token-based match (pythainlp newmm) + context check + blacklist fallback — กัน false positive ของคำผสม "หัวเตียง"/"สายรุ้ง" ฯลฯ (ระบบขยายไปหลายหมวด) — เพิ่ม `"สายไฟ"`, `"สายยาง"`, `"สายพาน"`, `"สายลม"`, `"สายฝน"` ใน blacklist (compound ที่ tokenizer รวมเป็น token เดียว) |
| `_filter_charger_subtype` | 1477 | กรอง docs ให้ตรง subtype (พร้อมกฎ set/cable/adapter cross-inclusion) — อ่านทั้ง `item_name` และ `name` field — `car_charger_kw` ไม่มี `"ในรถ"` ลอยๆ (กัน false positive สายชาร์จ "ใช้งานในรถยนต์") |

**`fetch_products` car_charger query split (Phase 2Z+++++, 2026-09-13):**
- **Purpose**: car_charger มี cat_name เฉพาะ (`Spare Parts and Accessories for Vehicles`) แต่ charger ทั่วไปอยู่ใน `Mobile & Gadgets` มี 130+ ตัว → query limit 100 กด car charger ออก
- **Input**: `product_types` (set), `query` (dict), `collection` (Mongo)
- **Logic**: ถ้า `"car_charger" in product_types` และ `"cat_name" in query` → คำนวณ `car_only_cats` (cat_name ของ car_charger ที่ไม่อยู่ใน charger ทั่วไป) → query ด้วย `car_only_cats` อย่างเดียวก่อน (limit `max(limit*5, 50)`) → ถ้าได้ผล ใช้ผลนั้น (ไม่รวม charger ทั่วไป)
- **Called by**: `fetch_products` (บรรทัด 2677-2695)
- **Side effects**: print `[CAR-CHARGER-ONLY]` log ไป stderr
- **Error/fallback**: ถ้า query car_charger อย่างเดียวได้ 0 → ใช้ query เดิม (รวม charger ทั่วไป)

#### 6.3.3 Reranking

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `_rerank_by_promo_latest` | 2088 | sort by `(standalone, has_promo, recency, similarity)` | `_is_bundle_product`, `_has_active_promotion`, `_get_recency_score` |
| `_rerank_with_diversity` | 2226 | รับ model ละ ≥ quota ก่อน fill | `_rerank_by_promo_latest`, `_doc_matches_model` |
| `_score_card` | 1966 | relevance score (type regex + brand + shop + token) — *ไม่ถูกเรียกในไฟล์นี้* | — |
| `_has_active_promotion` | 2015 | flash sale / promotion check | — |
| `_get_recency_score` | 2029 | 0.0-1.0 จาก `create_time` | — |
| `_is_bundle_product` | 2054 | detect bundle/set/combo | — |

#### 6.3.4 Query builders

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `build_query` | 1829 | สร้าง MongoDB filter (shop/brand/category/price/type/warranty) + feature-based search สำหรับ earphone (ANC/กันน้ำ/วิ่ง 2026-09-07) | `_detect_*`, `_product_type_*`, `warranty.strip_warranty_keywords` |
| `_product_type_regex` | 1816 | join regex ของ detected types | — |
| `_product_type_categories` | 1808 | ดึง candidate `cat_name` ของ types | — |
| `_detect_product_types` | 1265 | exact keyword + regex detect product types — มี typo fix `"หัวชาจ"`→`"หัวชาร์จ"` ฯลฯ ก่อน detect (Phase 2Z+++++) | — |
| `_detect_product_types_fuzzy` | 1631 | pythainlp + rapidfuzz typo-tolerant detect | — |
| `_extract_price_range` | 694 | regex ช่วงราคา (`1000-3000`, `ไม่เกิน 2000`) | — |
| `_detect_shops` | 733 | detect known shop names | — |
| `_detect_brands` | 754 | detect known brands | — |
| `_detect_categories` | 804 | detect categories + aliases | — |
| `_detect_intent` | 681 | warranty/compare/recommend keyword detect | — |

#### 6.3.5 Keyword preprocessing

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_extract_product_name_tokens` | 547 | English/alphanumeric tokens ≥4 chars สำหรับ fuzzy |
| `_extract_model_tokens` | 2146 | model tokens (`EC6 Pro`, `Mi 10`) + collapse variants |
| `_doc_matches_model` | 2216 | check model token ใน `item_name` |
| `_filter_false_positives` | 2290 | ตัด accessory ที่แอบเป็น phone/powerbank/charger/smartwatch |

#### 6.3.6 Helpers (sorting, dedup, formatting)

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `to_product_card` | 479 | Mongo doc → compact card สำหรับ LLM |
| `_to_serializable` | 168 | ObjectId/datetime → string (recursive) |
| `_warranty_info` | 215 | extract warranty จาก `attribute_list` / name |
| `_price_range` | 279 | min/max price จาก `model[].price_info` |
| `_first_image_url` | 292 | first image URL |
| `_clean_description` | 299 | slice `description` เป็น section + cap 3000 chars |
| `_is_sold_out` | 532 | check stock == 0 (*ไม่ถูกเรียกในไฟล์*) |
| `_load_vector_store` | 39 | lazy load `.npz` embedding |
| `get_client` | 148 | cached MongoClient + ping health |
| `build_connection_string` | 111 | build URI จาก `MONGO_*` env |
| `list_shops` | 2919 | distinct `shopname` |
| `list_categories` | 2925 | distinct `cat_name` |

#### 6.3.7 Module constants (สำคัญ)

| ชื่อ | Line | ความหมาย |
|---|---|---|
| `PRODUCT_PROJECTION` | 186 | Mongo field projection สำหรับ LLM context |
| `WARRANTY_KEYWORDS` / `COMPARE_KEYWORDS` / `RECOMMEND_KEYWORDS` | 665-676 | intent keywords |
| `KNOWN_SHOPS` | 721 | 32 ชื่อร้าน |
| `KNOWN_BRANDS` | 745 | แบรนด์ที่รู้จัก |
| `KNOWN_CATEGORIES` / `CATEGORY_ALIASES` | 764/771 | หมวดหมู่ + alias ไทย |
| `PRODUCT_TYPES` | 829 | ~50 product types (name, user_kws, name_regex) |
| `_CHARGER_SUBTYPES` | 1320 | cable/adapter/set/car_charger/wireless/desktop/socket keywords |
| `_PRODUCT_TYPE_CATEGORIES` | 1736 | product type → candidate cat_name — `car_charger` เพิ่ม `Spare Parts and Accessories for Vehicles` (Phase 2Z+++++) |

---

### 6.4 `intent_classifier.py` — Pass 1 LLM

#### 6.4.1 Main classification

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `classify_intent` | 132 | **Pass 1 LLM classifier** — ถาม Gemini ให้คืน JSON intent | `_client()` |

**Output keys**: `intent`, `product_type`, `charger_subtype`, `target_device`, `needs_description`, `general_qtype`, `confidence`, `model`, `usage`

**`general_qtype` values (Phase 6, 2026-09-16):**
- ค่า: `warranty_policy`/`return_policy`/`shipping_policy`/`brands`/`categories`/`shops`/`tax_invoice`/`null`
- เหตุผล: เดิม `general_qtype` มาจาก `knowledge_base.detect_general_question()` (keyword) ก่อน intent classification → ผิดได้ในกรณีกำกวม
- ตอนนี้: intent classifier ระบุ `general_qtype` เมื่อ `intent=general_question` → `app.py` ใช้ค่าจาก intent เป็นหลัก (conf>=0.7), keyword เป็น fallback

**`charger_subtype` values (Phase 2Z+++++, 2026-09-13):**
- prompt กำหนดครบ: `cable`/`adapter`/`set`/`car_charger`/`wireless`/`desktop`/`socket`/`null`
- มีตัวอย่าง: "มีหัวชาร์จในรถไหม"→`car_charger`, "มีแท่นชาร์จไร้สายไหม"→`wireless`
- เหตุผล: เดิม prompt กำหนดแค่ `cable|adapter|set|null` → follow-up car charger ถูก classify เป็น adapter ผิด

**`llm.py` include_desc merge (line ~539, แก้ 2026-09-03):**
- **Purpose**: merge intent `needs_description` กับ keyword matching — ถ้าอย่างใดอย่างหนึ่งบอก True → ส่ง description
- **เหตุผล**: intent classifier อาจบอก False แต่ keyword ("รายละเอียด", "สเปก") บอก True → ต้องส่ง desc เพื่อให้ LLM เห็นข้อมูล
- **Logic**: `include_desc = _intent_desc or _kw_match` (OR merge)
- **Called by**: `llm.answer()` ก่อนเรียก `_build_context()`
- **Side effects**: ถ้า `include_desc=True` → `_build_context` ใส่ `description_excerpt`, `weight`, `dimension` ใน context

#### 6.4.2 Gate (Phase 6 — ยกเลิกการใช้เป็น gate)

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `should_run_pass1` | 232 | ตัดสินใจว่าจะเรียก LLM หรือใช้ rule-based — return True เฉพาะ claim/compat/unknown-product-type/warranty-history |

**Phase 6 (2026-09-16):** `should_run_pass1()` ไม่ถูกเรียกจาก `app.py` แล้ว — `classify_intent()` รันทุก message ที่ผ่าน deterministic checks (order_sn/tracking_no/human_request). Helper ยังคงอยู่ใน `intent_classifier.py` (ไม่ลบ) แต่ไม่ใช้เป็น gate.

#### 6.4.3 Helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_load_api_keys` | 90 | โหลด `GEMINI_API_KEY_1..9` |
| `_next_api_key` | 108 | round-robin |
| `_client` | 117 | สร้าง `genai.Client` |

#### 6.4.4 Intent categories

| intent | ความหมาย |
|---|---|
| `product_recommend` | ขอแนะนำสินค้า |
| `product_spec` | ถามสเปค |
| `compatibility_check` | ถามความเข้ากัน |
| `warranty_duration` | ถามระยะรับประกัน |
| `warranty_claim` | ขอเคลม |
| `general_question` | คำถามทั่วไป |
| `other` | อื่นๆ |

`product_type`: `phone` / `charger` / `earphone` / `smartwatch` / `powerbank` / `case` / `speaker` / `other` / `null`

`charger_subtype`: `cable` / `adapter` / `set` / `null`

---

### 6.5 `knowledge_base.py` — KB lookup

#### 6.5.1 Main lookup

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `lookup_kb` | 751 | **main entry** — detect topic + search + build context | `detect_topic`, `search_kb_by_model`, `get_general_faq`, `format_kb_context` |
| `search_kb_by_model` | 274 | search KB (single + comparison) | `extract_model_keywords`, `_search_kb_single` |
| `_search_kb_single` | 340 | score + fetch full docs | `extract_model_keywords`, `_kb_coll` |
| `get_general_faq` | 429 | ดึง `general_faq` doc by topic | `_kb_coll` |

#### 6.5.2 Model keyword + topic

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `extract_model_keywords` | 235 | tokenize + filter stopwords → model keyword candidates (เพิ่ม version/region stop_words 2026-09-03: กัน "Version" ถูก extract เป็น model keyword และดึง TP-Link "Global Version" มาทับ anchor CW400; เพิ่ม target device filter 2026-09-07: กรอง "11โปรแม๊ก"/"iphone" ออกจาก candidates เพราะเป็นอุปกรณ์ ไม่ใช่ model สินค้าในร้าน → กัน CONV-ACTIVE ข้าม) |
| `is_target_device_kw` | 268 | ตรวจว่า token เป็นชื่ออุปกรณ์ (iPhone/Samsung/โปรแม็ก/ฯลฯ) ไม่ใช่ model สินค้าในร้าน — ใช้ใน `extract_model_keywords` และ CONV-ACTIVE check (เพิ่ม 2026-09-07: จับ "13คะ"/"15ครับ" ที่เป็นเลขรุ่น iPhone + คำลงท้ายไทย) |
| `detect_general_question` | 189 | detect warranty/return/shipping policy / brands / categories / shops / tax_invoice |
| `detect_topic` | 223 | match `TOPIC_KEYWORDS` → `warranty`/`specs`/`box_contents`/`highlights`/`description`/`comparison` |
| `is_warranty_question` | 76 | simple warranty/claim keyword check |

##### `is_target_device_kw` (Phase 3, 2026-09-07)

- **Purpose**: ตรวจว่า token เป็นชื่ออุปกรณ์ (target device) เช่น iPhone/Samsung/โปรแม็ก ไม่ใช่ model สินค้าในร้าน — ใช้แยก "11โปรแม๊ก" (อุปกรณ์) ออกจาก "AL870" (model สินค้า)
- **Input**: `kw: str` — token ที่สกัดจาก message
- **Output**: `bool` — True ถ้าเป็น target device
- **Calls**: `re.fullmatch` (built-in)
- **Called by**:
  - `extract_model_keywords` (ในไฟล์เดียวกัน) — กรอง target device ออกจาก candidates
  - `app.py` CONV-ACTIVE block (บรรทัด ~2894) — กรอง target device ออกจาก `_cur_model_kw` ก่อนเช็ค
- **How it works**:
  1. เช็คว่า token อยู่ใน `_TARGET_DEVICE_KWS` (iphone/ไอโฟน/samsung/โปรแม็ก/ultra/ฯลฯ) หรือไม่
  2. เช็ค regex รุ่น iPhone เฉยๆ เช่น "11โปรแม็ก", "15พลัส", "13มินิ", "14pro" — ใช้ `re.search` (ไม่ใช่ fullmatch) เพื่อจับ token ยาว เช่น "11โปรแม๊กอันไหนคับ"
  3. เช็ค regex "iphone" + ตัวเลข เช่น "iphone11", "iphone15promax" — ใช้ `re.search` เช่นกัน
  4. เช็ค regex "ไอโฟน" (Thai) + ตัวเลข เช่น "ไอโฟน13", "ไอโฟน13คะ" — ใช้ `re.search(r"ไอโฟน\s*\d+")` (เพิ่ม 2026-09-07: regex ด้านบนจับแค่ "iphone" ภาษาอังกฤษ ไม่จับ "ไอโฟน" ภาษาไทย)
  5. เช็ค regex ตัวเลขรุ่น iPhone (11-17) + คำลงท้ายไทย เช่น "13คะ", "15ครับ", "17นะ" — ใช้ `re.match(r"^1[1-7][\u0E00-\u0E7F]+$")` (เพิ่ม 2026-09-07: กัน "13คะ" ถูกจับเป็น model keyword แล้วข้าม CONV-ACTIVE ทำให้บอทไม่ใช้ active product และตอบว่าไม่มีสาย Lightning)
- **Side effects**: ไม่มี
- **Error/fallback**: ไม่มี — เป็น pure function

##### `extract_model_keywords` — Phase 3 update (2026-09-07)

- **Purpose**: สกัดคำที่น่าจะเป็นชื่อรุ่นสินค้าในร้าน กรอง target device ออกจาก candidates
- **Input**: `message: str` — ข้อความลูกค้า
- **Output**: `list[str]` — model keyword candidates (กรอง target device แล้ว)
- **Calls**: `is_target_device_kw`
- **Called by**: `app.py` (CONV-ACTIVE, carry-forward, KB path), `search_kb_by_model`, `_search_kb_single`, `should_use_web_search`
- **How it works**:
  1. tokenize + filter stopwords (เดิม)
  2. กรอง target device ออกจาก candidates ด้วย `is_target_device_kw` (ใหม่ Phase 3)
- **Side effects**: ไม่มี
- **Error/fallback**: ไม่มี

#### 6.5.3 Context building

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `format_kb_context` | 639 | KB docs + general FAQ → formatted text สำหรับ LLM | — |
| `build_general_context` | 479 | context สำหรับ general question (policy/brands/categories) | `get_general_faq`, `_extract_policy_from_descriptions` |
| `_extract_policy_from_descriptions` | 435 | extract warranty/return/shipping section จาก product `description` | — |
| `get_base_warranty_text` | 40 | ข้อความรับประกันพื้นฐาน (KB faq → fallback hardcoded) | `get_general_faq` |

#### 6.5.4 Helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_load_env` | 27 | load `.env` |
| `_build_admin_client` | 92 | cached MongoClient for admin DB |
| `_kb_coll` | 118 | return `knowledge_base` collection |

#### 6.5.5 Module constants

| ชื่อ | Line | ความหมาย |
|---|---|---|
| `TOPIC_KEYWORDS` | 127 | topic → keyword list |
| `GENERAL_QUESTION_KEYWORDS` | 138 | qtype → keyword list |

---

### 6.6 `web_search.py` — OpenRouter fallback

#### 6.6.1 Decision

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `detect_uncertainty` | 97 | scan answer หา uncertainty markers | — |
| `should_use_web_search` | 119 | **multi-rule trigger** — config + skip + uncertainty + compat + spec + negative — **2026-09-14 (BUG-11)**: เพิ่ม guard greeting/thanks + ordinary_product_query_with_context (มี products อยู่แล้ว → skip) | `is_configured`, `detect_uncertainty`, `knowledge_base.extract_model_keywords` |

**Skip conditions** (เมื่อ `_has_products=True`):
- warranty / spec / comparison question
- charging-spec question
- follow-up question (สั้นๆ)
- **yes/no spec question (เพิ่มใหม่):** "มี...ไหม/รองรับ...ไหม/ได้...ไหม/กัน...ไหม/สำรอง...ไหม"

#### 6.6.2 Search execution

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `search_and_extract` | 272 | **เรียก OpenRouter + parse JSON + extract keywords** | `is_configured`, `_get_openrouter_*`, `_log_ai_usage` |
| `search_and_answer` | 502 | deprecated wrapper — **2026-09-14**: เพิ่ม URL stripping ก่อนคืนคำตอบ (กันลิงก์เว็บนอกหลุดไปลูกค้า) | `search_and_extract` |

#### 6.6.3 Helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_get_openrouter_key` | 30 | `OPENROUTER_API_KEY` |
| `_get_openrouter_base` | 33 | `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`) |
| `_get_openrouter_model` | 36 | `OPENROUTER_SEARCH_MODEL` (default `google/gemini-2.5-flash:online`) |
| `_get_ai_usage_hub_url` | 39 | `AI_USAGE_HUB_URL` |
| `_get_ai_usage_hub_token` | 42 | `AI_USAGE_HUB_TOKEN` |
| `is_configured` | 68 | check OpenRouter key มีไหม |
| `_log_ai_usage` | 46 | fire-and-forget POST → AI Usage Hub |

#### 6.6.4 Module constants

| ชื่อ | Line | ความหมาย |
|---|---|---|
| `_UNCERTAINTY_MARKERS_STRONG` | 77 | strong uncertainty phrases |
| `_UNCERTAINTY_MARKERS_WEAK` | 89 | weak markers (trigger เฉพาะ + admin referral) |
| `_ADMIN_REFERRAL_MARKERS` | 94 | `["ทักแอดมิน", "ติดต่อแอดมิน", "แอดมินได้เลย"]` |

---

### 6.7 `persona.py` — Bot persona

#### ฟังก์ชัน

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `get_persona` | 58 | ดึง persona (bot_name + notes) จาก `shop_personas` — fallback case-insensitive | `_persona_coll` |
| `build_persona_instruction` | 128 | สร้าง Thai instruction appendix สำหรับ LLM | — |
| `_build_admin_client` | 18 | cached MongoClient (admin DB) | — |
| `_persona_coll` | 49 | return `shop_personas` collection | `_build_admin_client` |

**Collection**: `shop_personas` (fields: `shopname`, `platform`, `is_deleted`, `bot_name`, `enabled`, `notes`)

---

### 6.8 `warranty.py` — Warranty & claim

> **ไม่ใช้ MongoDB** — pure Python text/NLP logic + `pythainlp` NER (lazy load)

#### 6.8.1 Main functions

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `extract_warranty_from_name` | 66 | extract warranty duration (months) จาก product name — tail/near/thai pattern |
| `is_in_warranty` | 163 | คำนวณว่ายังในรับประกันไหม (purchase_date + months) |
| `parse_purchase_date` | 199 | parse Thai/English/numeric date → datetime (รวม Buddhist year) |
| `strip_warranty_keywords` | 290 | ตัด warranty keywords ออกจาก message เพื่อ isolate product name |
| `detect_claim_request` | 434 | detect ลูกค้าขอเคลม/ซ่อม — แยก "ขอเคลมจริง" จาก "ถามเงื่อนไข" และตรวจอาการเสีย (ไหม้/รอย/พัง) ที่แม้มี question pattern ก็เป็น claim จริง |
| `detect_consent` | 460 | detect consent ให้ปรึกษาแอดมิน (เช็ค decline ก่อน) |
| `detect_confirmation` | 469 | detect ลูกค้ายืนยันข้อมูลถูกต้อง |
| `extract_customer_info` | 558 | extract name/phone/order_id (ใช้ pythainlp NER + fallback + mixed alphanumeric order ID) |
| `detect_purchase_date_and_order` | 649 | extract purchase_date + order_id |
| `detect_warranty_duration_question` | 671 | detect "รับประกันกี่ปี" |
| `detect_tax_invoice_request` | 699 | detect ขอใบกำกับภาษี — ไม่รวม "เลขที่" เพราะเป็น false positive จากที่อยู่ |
| `auto_check_warranty` | 717 | ⚡ Phase 1C — auto-check ระยะประกันจาก order_sn → ดึง order จาก MongoDB → คำนวณ is_in_warranty → สร้าง warranty_text ให้ LLM (legacy — ใช้ create_time_raw) |
| `check_warranty_status` | 742 | ⚡ Warranty-Delivery — คำนวณสถานะรับประกันจาก delivery_time_raw (วันที่ส่งมอบ) แทน create_time_raw — คืน in_warranty/days_remaining/delivery_date/expiry_date หรือ None ถ้ายังไม่ส่งมอบ |

#### 6.8.2 Helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_unit_to_months` | 56 | `Y`/`M` → months |
| `_get_ner` | 450 | lazy load `pythainlp.tag.NER` (thainer) |
| `_extract_name_ner` | 462 | extract person name ด้วย NER + post-process |

#### 6.8.3 Data structures

| ชื่อ | Line | ความหมาย |
|---|---|---|
| `WarrantyClaimState` | 343 | Literal 8 สถานะ: `idle` / `duration_question` / `awaiting_claim_request` / `awaiting_purchase_date` / `awaiting_customer_info` / `awaiting_confirmation` / `out_of_warranty_consult` / `handoff_complete` |
| `WarrantyClaimContext` | 355 | dataclass state ของ claim flow (state, product name, customer info, dates) + `to_dict()` |
| `_ORDER_ID_MIXED_PATTERN` | 487 | regex สำหรับ Shopee mixed alphanumeric order ID เช่น `2508088B5T4W1D` (เริ่มด้วย digit 6+ ตามด้วยตัวอักษร) |

#### 6.8.4 การแก้ไขสำคัญ

**`detect_claim_request` (line 434):**
- **ก่อนแก้:** ถ้า message มี question pattern (เช่น "เคลมได้ไหม") → return False เสมอ แม้ลูกค้าจะเล่าอาการเสียจริง
- **หลังแก้:** ถ้า message มี question pattern แต่มีอาการเสียจริง (ไหม้/รอย/ร้าว/แตก/เสีย/พัง/ไม่ทำงาน/ฯลฯ) → return True (เป็น claim request จริง)
- **เหตุผล:** "จอมีรอยไหม้ เคลมได้ไหม" เป็นการขอเคลมจริง ไม่ใช่ถามเงื่อนไข

**`detect_tax_invoice_request` (line 699):**
- **ก่อนแก้:** `_TAX_INVOICE_DATA_KWS` รวม "เลขที่" → จับ "เลขที่ 303" ในที่อยู่เป็นใบกำกับภาษี
- **หลังแก้:** เอา "เลขที่" ออก เพราะเป็นคำทั่วไปในที่อยู่ → ใช้ "เลขผู้เสียภาษี"/"เลขภาษี"/"หจก." แทน

**`extract_customer_info` (line 558):**
- **ก่อนแก้:** ใช้แค่ `_ORDER_ID_PATTERN` (digit 9-16 + optional suffix) → ไม่จับ "2508088B5T4W1D"
- **หลังแก้:** เพิ่ม fallback `_ORDER_ID_MIXED_PATTERN` สำหรับ Shopee mixed format

**`app.py` state machine (line 833):**
- **ก่อนแก้:** รับเฉพาะ name/phone เป็นข้อมูลบางส่วน → ถ้าลูกค้าให้แค่ order_id ถือว่าไม่มีข้อมูล → ขอข้อมูลใหม่ทั้งหมด
- **หลังแก้:** รับ order_id ด้วย → ทวนข้อมูลที่ให้มา + ถามข้อมูลที่เหลือ (name/phone/order_id ที่ขาด)

**`app.py` State 7 — awaiting_claim_info (line ~1011, เพิ่ม 2026-09-10, ขยับ Phase 2B 2026-09-12):**
- **Purpose:** รับรูป/วิดีโอ/ข้อมูลที่ลูกค้าส่งตามที่บอทขอใน claim flow (หลัง handoff แล้ว) → ขอบคุณ + บอกรอแอดมิน
- **Flow ใหม่:** ขอข้อมูล + handoff ทันที → ลูกค้าตอบมา → ขอบคุณ + บอกรอแอดมิน (ไม่ต้องทวน/ถามยืนยัน)
- **Input:** `req.message` (อาจเป็น `[รูปภาพ]`, `[วิดีโอ]`, หรือมี placeholder + ข้อมูลอื่น), `history` (last model message ขอ claim info)
- **Output:** `_warranty_claim_answer` (ขอบคุณ + บอกรอแอดมิน), `_warranty_claim_ctx` (เก็บข้อมูลที่ได้รับ)
- **Detection:** `_bot_asked_claim_info` — last model message มี "วันที่ซื้อ" + "เลขที่คำสั่งซื้อ" + "รูป/วิดีโอ" พร้อมกัน
- **⚡ Phase 2B — Warranty context image:** ถ้า history มี warranty/claim keywords (เคลม/ประกัน/ซ่อม/เสีย/พัง/ใช้ไม่ได้/ชาร์จไม่เข้า/ฯลฯ) และลูกค้าส่งรูป/วิดีโอ → ถือเป็น claim evidence แม้บอทไม่ได้ขอ claim info ใน last message (กัน Q11: บอทตอบเรื่องระยะเวลาเคลม → ลูกค้าส่งรูป → บอทตอบเป็น product info ผิด)
- **Image detection:** `_msg_is_image` (message = `[รูปภาพ]` อย่างเดียว) หรือ `_msg_has_image_placeholder` (มี placeholder ผสมกับ text)
- **Cleanup:** ตัด image placeholder + date pattern ออกจาก message ก่อน `extract_customer_info` (กัน `[รูปภาพ]` หรือ "ซื้อวันที่..." ถูกตีความเป็นชื่อ)
- **Called by:** `chat()` หลัง post-handoff block, ก่อน state awaiting_customer_info
- **Side effects:** ไม่มี DB write (เก็บใน memory เฉพาะรอบปัจจุบัน)
- **Error/fallback:** ถ้าไม่มี image และไม่มีข้อมูลใดเลย → ไม่ตั้ง `_warranty_claim_answer` → ตกไป state อื่นตามปกติ

**`warranty.py` `_CLAIM_REQUEST_INDICATORS` (Phase 2B 2026-09-12):**
- **ก่อนแก้:** "ชาร์จไม่เข้า" อยู่แค่ใน `_symptom_kws` (ใช้ต่อเมื่อ match `_CLAIM_QUESTION_PATTERNS` ก่อน) → "รู้สึกน้องชาร์จไม่เข้าเลยค่ะ" ไม่ถูกตรวจจับเป็น claim request
- **หลังแก้:** เพิ่ม "ชาร์จไม่เข้า", "ไม่ชาร์จ", "ชาร์จไม่ติด", "ชาร์จไม่ได้", "ไม่เข้าเลย", "ไฟไม่เข้า", "ไม่สแกน", "ไม่เชื่อมต่อ", "ไม่แสดงผล", "ไม่ได้เสียง" ใน `_CLAIM_REQUEST_INDICATORS` โดยตรง

**`app.py` Repeated complaint guard (Phase 2B 2026-09-12):**
- **Purpose:** กัน LLM override claim_request เป็น False เมื่อลูกค้าแจ้งปัญหาซ้ำ 2+ ครั้งใน history
- **Detection:** นับ user messages ใน history ที่มี complaint keywords (ชาร์จไม่เข้า/ใช้ไม่ได้/เสีย/พัง/ฯลฯ) → ถ้า >= 2 → ตั้ง `_repeated_complaint=True`
- **Behavior:** ถ้า `_repeated_complaint=True` → ห้าม LLM override `_is_claim_request` เป็น False (แม้ LLM จะบอก intent != warranty_claim ด้วย confidence >= 0.7)

**`app.py` State-driven open/closed (Phase 2A 2026-09-12):**
- **Purpose:** ปุ่ม "ปิดแชท" ใน test chat อัปเดต DB จริง → botCallService ดึง status ส่ง `ticket_state` ให้บอท → บอทใช้ state ตัดสินใจ ไม่ใช้ keyword scan
- **Input:** `req.ticket_state` ("open"|"closed"|"handoff"|"resolved"|"pending"|None)
- **Behavior:**
  - `closed` → `_bot_handed_off = False` (ข้าม post-handoff lock ทั้งหมด บอทตอบปกติ)
  - `handoff`/`open` + มี history marker → ล็อค (ยกเว้น exceptions ใน ShopSettings)
  - `None` → fallback ใช้ history scan แบบเดิม (backward compat)
- **Endpoints:** `/test-chat/sessions/{id}/close` + `/reopen` (Python bot, simulate mode)
- **ShopSettings:** `post_handoff_exceptions: string[]` — แอดมินตั้งได้ต่อร้าน (เช่น "ทวนข้อมูลเคลม", "ส่งลิงก์กรอกฟอร์ม")
- **Called by:** `botCallService.resolveTicketState()` ดึงจาก `test_chat_sessions` (simulate) หรือ `conversations` (production)

**`app.py` ข้าม order_lookup ใน claim flow (line ~495, เพิ่ม 2026-09-10):**
- **Purpose:** กัน order_sn ในข้อความลูกค้า (ที่ส่งมาเป็น claim info) ถูกจับโดย order_lookup ก่อนเข้า warranty state machine
- **Detection:** ตรวจ history ว่า last model message ขอ "วันที่ซื้อ" + "เลขที่คำสั่งซื้อ" + "รูป/วิดีโอ" → ถ้าใช่ ตั้ง `_in_claim_flow=True`
- **Behavior:** ถ้า `_in_claim_flow` → ข้าม order_lookup ทั้งหมด → order_sn ไปอยู่ใน claim info ของ State 7

**`app.py` handoff ทันทีที่ขอข้อมูลเคลม (line ~1170 + ~1504, เพิ่ม 2026-09-10):**
- **Purpose:** เปลี่ยน flow เดิม (ขอข้อมูล→รอครบ→ทวน→ยืนยัน→handoff) เป็น "ขอข้อมูล + handoff ทันที" — บอทตั้งคำถามเบื้องต้นทิ้งไว้ แอดมินมาอ่านแชทต่อ
- **จุดที่เปลี่ยน:**
  1. State 6 (duration_answered + claim_request) — ตั้ง `_warranty_claim_handoff = True` พร้อมขอข้อมูล
  2. first_message path (claim request ไม่มี history) — เรียก handoff API ทันที + ตั้ง `handoff_to_admin=True`
- **Behavior หลัง handoff:** ลูกค้าตอบกลับมา → State 7 รับข้อมูล + ขอบคุณ + บอกรอแอดมิน (ไม่ handoff ซ้ำ)

**`app.py` LLM override (line 631):**
- **ก่อนแก้:** LLM บอก warranty_claim + `not _prev_is_product` → override เป็น True เสมอ แม้เป็นคำถาม policy
- **หลังแก้:** เพิ่มเช็ค question marker (ไหม/มั้ย/?) + ไม่มี strong kw → ไม่ override (เป็น policy question)

---

### 6.9 `conversation_products.py` — Conversation product timeline

> **MongoDB admin DB** collection `conversation_products` — เก็บ timeline สินค้าที่กล่าวถึงในแชท

#### 6.9.1 Purpose

จำสินค้าที่ลูกค้าส่งมา (anchor) และสินค้าที่ bot แนะนำ (suggestion) ตลอดทั้งแชท
แก้ปัญหา context loss — bot ลืมสินค้าเดิมเมื่อลูกค้าถามต่อ หรือสลับไปสินค้าอื่นผิด

#### 6.9.2 Main functions

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `load_timeline` | 80 | โหลด product timeline ของแชทจาก Mongo |
| `save_timeline` | 95 | บันทึก product timeline (upsert โดย conversation_id) |
| `add_product` | 130 | เพิ่มสินค้าเข้า timeline + คำนวณ active ใหม่ |
| `get_active_product` | 195 | ดึง active product card (anchor ล่าสุด) |
| `get_suggestion_latest` | 210 | ดึง suggestion product ล่าสุด (bot แนะนำ) |
| `resolve_active_by_message` | 230 | resolve active product ตามกฎ priority (ชื่อรุ่น → ตัวเดิม → อันที่แนะนำ → default) |
| `is_generic_question` | 280 | ตรวจว่าคำถามเป็น generic (ไม่ระบุสินค้า) หรือไม่ |
| `add_order_anchor` | 340 | ⚡ Phase 3C — บันทึก order_sn เป็น anchor ใน timeline (field `order_anchors` + `active_order_sn`) |
| `get_active_order_sn` | 420 | ⚡ Phase 3C — ดึง active order_sn (order ล่าสุดที่ลูกค้าส่งมา) |
| `get_order_anchors` | 430 | ⚡ Phase 3C — ดึง order anchors ทั้งหมด (เรียงใหม่→เก่า) |
| `resolve_active_order_sn` | 450 | ⚡ Phase 3C — resolve order_sn ตามกฎ (order_sn ใน message → order เดิม → order generic → None) |
| `is_order_question` | 490 | ⚡ Phase 3C — ตรวจว่าคำถามเกี่ยวกับ order หรือไม่ |
| `get_anchor_history` | 560 | ⚡ Phase 7 — ดึง anchor products เรียงใหม่→เก่าตาม mentioned_at (สำหรับ comparison) |
| `get_previous_anchor` | 590 | ⚡ Phase 7 — ดึง anchor อันดับ 2 (อันก่อนหน้า active) — รองรับ exclude_item_id |

#### 6.9.3 Helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_admin_db` | 40 | lazy load knowledge_base._build_admin_client → admin DB |
| `_coll` | 47 | คืน collection `conversation_products` |
| `_to_serializable` | 65 | แปลง float → int สำหรับ Mongo |
| `_strip_card_for_storage` | 175 | ตัด product card เก็บแค่ fields จำเป็น (ประหยัดพื้นที่) |
| `_compute_active` | 195 | คำนวณ active = anchor ล่าสุด (fallback: suggestion ล่าสุด) |
| `_normalize_dt` | 260 | ⚡ Phase 7 — แปลง mentioned_at เป็น naive datetime สำหรับ sort (กัน TypeError offset-naive vs aware) |

#### 6.9.4 Data structures

Mongo document schema:

```js
{
  conversation_id: "shp_xxx",
  platform: "shopee",
  shop: "KieslectThailand",
  products: [
    {
      item_id: 47615436122,
      name: "KIESLECT BioKoop Smart Health Tracker",
      source: "user_item_card",  // user_item_card | user_variation_card | user_order | bot_suggestion
      mentioned_at: ISODate,
      is_anchor: true,  // ลูกค้าส่งมา = true, bot แนะนำ = false
      card: { ... }  // product card (stripped)
    }
  ],
  active_item_id: 47615436122,  // anchor ล่าสุด
  // ⚡ Phase 3C — order anchors
  order_anchors: [
    {
      order_sn: "240215MCEQMT60",
      mentioned_at: ISODate,
      summary: { order_status: "จัดส่งแล้ว", shipping_carrier: "Kerry", total_amount: 259, item_count: 1, create_time: "15 ก.พ. 2567" }
    }
  ],
  active_order_sn: "240215MCEQMT60",  // order ล่าสุด
  last_updated: ISODate,
}
```

#### 6.9.5 Priority rules (active product)

1. ถ้า message มีชื่อรุ่นเฉพาะ → หาสินค้าที่ match ใน timeline
2. ถ้า message พูด "ตัวเดิม/อันเดิม/ของเดิม" → anchor ล่าสุด
3. ถ้า message พูด "อันที่แนะนำ/ที่ส่งมา" → suggestion ล่าสุด
4. ถ้า message เป็น generic question → active product (anchor ล่าสุด)
5. default → active product

#### 6.9.5b Priority rules (active order — Phase 3C)

1. ถ้า message มี order_sn อยู่แล้ว → ใช้ order_sn นั้น
2. ถ้า message พูด "order เดิม/คำสั่งซื้อเดิม" → active order (ล่าสุด)
3. ถ้า message เป็น order generic question ("สถานะ order", "order ถึงยัง") → active order
4. ถ้าไม่ตรงเงื่อนไขไหน → None (ไม่ใช่คำถามเรื่อง order)

#### 6.9.6 Integration in app.py

| จุด | Line | ทำอะไร |
|---|---|---|
| item-tag anchor | ~428 | บันทึก anchor product ตอนลูกค้าส่ง `[item: xxx]` |
| conv-active resolution | ~2835 | ดึง active product จาก timeline ก่อน carry-forward |
| conv-active context note | ~2927 | บอก LLM ห้ามสลับสินค้า |
| suggestion recording | ~3938 | `_record_suggestion_products()` บันทึกสินค้าที่ bot แนะนำ |
| kb+mongo+web_search return | ~2671 | ⚡ เรียก `_record_suggestion_products` ก่อน return (source=knowledge_base+mongo+web_search) |
| kb+mongo return | ~2695 | ⚡ เรียก `_record_suggestion_products` ก่อน return (source=knowledge_base+mongo) |
| web_search return | ~3894 | เรียก `_record_suggestion_products` ก่อน return |
| product_store return | ~3920 | เรียก `_record_suggestion_products` ก่อน return |
| ⚡ order anchor resolve | ~640 | Phase 3C — ถ้าไม่มี order_sn ใน message แต่เป็น order question → ใช้ active order anchor |
| ⚡ order anchor save | ~730 | Phase 3C — บันทึก order anchor หลัง lookup_order สำเร็จ |

#### 6.9.7 Called by

- `app.py:chat()` — บันทึก anchor ตอนรับ item tag, ดึง active ก่อน retrieval, บันทึก suggestion ก่อน return
- `replay_compare.py:call_bot()` — ส่ง `conversation_id` + `platform` ให้ bot

#### 6.9.8 Calls

- `knowledge_base._build_admin_client()` — สร้าง admin Mongo client

#### 6.9.9 Side effects

- MongoDB write: `conversation_products` collection (upsert by conversation_id)
- เก็บถาวร (ไม่มี TTL)

#### 6.9.10 Error/fallback

- ทุก function catch exception เอง → ไม่ crash chat flow
- ถ้า Mongo ไม่ available → return None / ข้ามไป
- ถ้า conversation_id ว่าง → ไม่ทำอะไร

---

### 6.10 `order_store.py` — Order & tracking lookup (read-only)

> **MongoDB order DB** (env `ORDER_URI_MONGO` / `ORDER_DB` / `ORDER_COLLECTION`) — read-only

#### 6.10.1 Purpose

ดึงข้อมูลคำสั่งซื้อ + tracking จาก MongoDB เพื่อ:
- ตอบลูกค้าเรื่องสถานะคำสั่งซื้อ/การจัดส่ง
- ⚡ Phase 1B — ค้น order จาก tracking number (ลูกค้าส่งเลขพัสดุ)
- ⚡ Phase 1C — แสดง order history ใน ticket panel + warranty auto-check

#### 6.10.2 Main functions

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `extract_order_sn` | 74 | ดึง order_sn จากข้อความ (รองรับ `[order: xxx]` tag + pattern ทั่วไป) |
| `extract_tracking_number` | 117 | ⚡ Phase 1B — ดึง tracking number จาก text/vision OCR (SPX/Kerry/Flash/J&T/ไปรษณีย์) |
| `lookup_by_tracking` | 144 | ⚡ Phase 1B — ค้น order จาก tracking number (MongoDB) |
| `lookup_order` | 227 | ดึงข้อมูล order จาก order_sn — คืน status + items + tracking + variant + price + image |
| `lookup_orders_by_buyer` | 372 | ⚡ Phase 1C — ดึง order history ของลูกค้าจาก buyer_username |
| `build_order_context` | 425 | สร้าง context string สำหรับส่งให้ LLM (รวม tracking_no) |

#### 6.10.3 Helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_get_order_client` | 33 | lazy singleton MongoClient สำหรับ order DB |
| `_get_order_collection` | 49 | คืน PyMongo collection สำหรับ orders |
| `_map_order_status` | 196 | แปล order_status เป็นภาษาไทย |
| `_map_logistics_status` | 201 | แปล logistics_status เป็นภาษาไทย |
| `_format_create_time` | 250 | แปล unix timestamp เป็นวันที่ภาษาไทย (UTC+7) — alias ของ `_format_unix_ts` |
| `_format_unix_ts` | 257 | ⚡ Phase 3C — แปล unix timestamp / ISO string เป็นวันที่ภาษาไทย (รองรับทั้ง int และ ISO string) |
| `_format_unix_ts_with_time` | 285 | ⚡ Phase 3C — แปล unix timestamp เป็นวันที่+เวลาภาษาไทย |
| `_format_address` | 310 | ⚡ Phase 3C — แปล recipient_address dict เป็น string อ่านง่าย (ปกปิด sensitive) |
| `_normalize_tracking` | 137 | normalize tracking number (ตัดช่องว่าง + ใหญ่) |

#### 6.10.4 Data structures

`lookup_order` return (Phase 3C — ขยายจากเดิม):
```python
{
  "order_sn": "240215MCEQMT60",
  "order_status": "จัดส่งแล้ว",  # ภาษาไทย
  "order_status_raw": "SHIPPED",
  "logistics_status": "ขนส่งรับพัสดุแล้ว",
  "logistics_status_raw": "LOGISTICS_PICKUP_DONE",
  "items": [{"name": "...", "model_name": "...", "quantity": 1, "price": 259.0, "original_price": 318.0, "image_url": "...", "sku": "...", "item_id": "...", "model_id": "..."}],
  "shipping_carrier": "Kerry",
  "tracking_no": "SPX1234567890",
  "tracking_numbers": ["SPX1234567890"],
  "create_time": "15 ก.พ. 2567",
  "create_time_raw": 1708012800,
  # ⚡ Phase 3C — ฟิลด์ใหม่
  "pay_time": "15 ก.พ. 2567",              # วันที่ชำระเงิน
  "ship_by_date": "17 ก.พ. 2567",          # วันที่ส่งกำหนด
  "pickup_done_time": "16 ก.พ. 2567",      # วันที่ขนส่งรับพัสดุ
  "delivery_time": "ไม่ระบุ",               # วันที่ส่งถึง (จาก update_time เมื่อ COMPLETED)
  "delivery_time_raw": None,              # ⚡ Warranty-Delivery — unix ts ของวันที่ส่งถึง (None ถ้ายังไม่ส่งมอบ/ยกเลิก)
  "update_time": "18 ก.พ. 2567",           # วันที่อัปเดตล่าสุด
  "recipient_address": "****** คลองโยง อำเภอพุทธมณฑล จังหวัดนครปฐม 73170 · ชื่อ: ล******ง · เบอร์: ******31",
  "estimated_shipping_fee": 48.0,
  "actual_shipping_fee": 0.0,
  "days_to_ship": 2,
  "cod": False,                             # เก็บเงินปลายทาง
  "cancel_by": "",                          # ยกเลิกโดยใคร (ถ้า CANCELLED)
  "cancel_reason": "",
  "buyer_cancel_reason": "",
  "total_amount": 259.0,
  "currency": "THB",
  "buyer_username": "witchayaporn773",
  "payment_method": "Cash on Delivery",
  "shopname": "ThaiSuperPhone",
  "found": True,
}
```

#### 6.10.5 Called by

- `app.py:chat()` — order lookup + tracking lookup + warranty auto-check
- `warranty.py:auto_check_warranty()` — ดึง order เพื่อคำนวณระยะประกัน (legacy — ใช้ create_time_raw)
- `warranty.py:check_warranty_status()` — ⚡ Warranty-Delivery — ดึง delivery_time_raw เพื่อคำนวณระยะประกันจากวันที่ส่งมอบ
- Next.js API `/api/admin/conversations/[id]/orders` — ดึง order history สำหรับ ticket panel

#### 6.10.6 Side effects

- MongoDB read (read-only — ไม่เขียน)

#### 6.10.7 Error/fallback

- ทุก function catch PyMongoError + Exception → return None / []
- ถ้า ORDER_URI_MONGO ไม่ตั้ง → raise RuntimeError
- ถ้าไม่พบ order → return None

---

## 7. คอนฟิกและตัวแปรสำคัญ

### 7.1 FastAPI app.py

| ตัวแปร | หน้าที่ |
|---|---|
| `_INTERNAL_SECRET` | ตรวจ `X-Internal-Secret` header |
| `_PUBLIC_PATHS` | `{"/health", "/"}` ไม่ต้องมี secret |
| `_ITEM_TAG_RE` | regex `[item: xxx]` / `[สินค้า: xxx]` |

### 7.2 LLM

| ตัวแปร | หน้าที่ |
|---|---|
| `GEMINI_API_KEY` / `GEMINI_API_KEY_1..9` | API keys (rotation) |
| `GEMINI_MODEL` | default `gemini-2.0-flash` |
| `INTENT_MODEL` | default `gemini-3.1-flash-lite` |

### 7.3 MongoDB

| env | หน้าที่ |
|---|---|
| `ADMIN_MONGO_URI` / `ADMIN_MONGO_DB` | admin DB |
| `ADMIN_MONGO_COLLECTION_*` | collection names |
| `MONGO_URI` / `MONGO_DB` / `MONGO_COLLECTION` | product DB (`dbWallet` / `ShpProducts`) |

### 7.4 Web search

| env | หน้าที่ |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key |
| `OPENROUTER_BASE_URL` | default `https://openrouter.ai/api/v1` |
| `OPENROUTER_SEARCH_MODEL` | default `google/gemini-2.5-flash:online` |
| `AI_USAGE_HUB_URL` / `AI_USAGE_HUB_TOKEN` | AI Usage Hub |

---

## 8. สถานะปัจจุบัน

### 8.1 ใช้งานจริง

- ✅ Shopee chatbot (`shopeechat/`) ที่ port 8010
- ✅ Next.js admin console (`ChatAdminWeb/`) ครบทุกหน้า
- ✅ Product retrieval จาก `ShpProducts` (regex + vector + fuzzy)
- ✅ KB lookup จาก `knowledge_base` collection
- ✅ Gemini LLM (gemini-2.0-flash + gemini-3.1-flash-lite สำหรับ intent)
- ✅ OpenRouter web search fallback + AI Usage Hub logging
- ✅ Persona, warranty claim state machine, tax-invoice handoff
- ✅ Test chat + test assignment (replay) + shadow inbox
- ✅ Charger subtype detection (cable/adapter/set/car/wireless/desktop/socket)
- ✅ Reference extraction + carry-forward จาก history
- ✅ URL sanitization (strip external URLs จาก search_info)
- ✅ Prompt: ห้ามแนะนำรุ่นอื่นเมื่อถาม spec รุ่นเดิม (เว้นแต่สัมพันธ์)
- ✅ Prompt: ห้ามใส่ลิงก์ภายนอก (ยกเว้น shopee short_link/image)
- ✅ Web search skip สำหรับ yes/no spec question ที่มีสินค้าใน context
- ✅ **Multimodal vision pass (Phase 1A)** — บอทอ่านรูภาพที่ลูกค้าส่งด้วย `gemini-3-flash-preview` → ส่ง description เป็น context ให้ LLM หลัก

### 8.2 Placeholder / ยังไม่ใช้

- ⚠️ `lazadachat/` และ `tiktokchat/` — port 8011/8012 ว่าง, `__init__.py` ว่าง
- ⚠️ `_score_card` และ `_is_sold_out` ใน `product_store.py` — นิยามแล้วแต่ไม่ถูกเรียก
- ⚠️ `search_and_answer` ใน `web_search.py` — deprecated (ใช้ `search_and_extract` แทน)

### 8.3 คุณภาพคำตอบ (จาก replay เทียบ bot vs Zaapi — IMILabThailand 4 conversations)

| ปัญหา | สถานะ |
|---|---|
| Bot แนะนำรุ่นอื่นทุกครั้ง (น่าเกลียด) | ✅ แก้แล้ว (llm.py prompt) |
| Bot ตอบ "ไม่มี" แล้ว trigger web_search จนได้สินค้าอื่นมา | ✅ แก้แล้ว (web_search.py skip) |
| `[item]` ไม่ anchor สินค้าให้ turn ถัดไป | ⚠️ ยังไม่แก้ (pending #1) |
| ลิงก์นอกหลุดเข้าคำตอบ | ✅ แก้แล้ว (URL sanitization + prompt) |
| Charger subtype ปนกัน | ✅ แก้แล้ว |
| Reference follow-up ไม่จำสินค้าเดิม | ✅ แก้แล้ว (บางส่วน — ขึ้นกับ #1) |

---

## 9. แผนอนาคต

### 9.1 ระยะสั้น (กำลังทำ)

| งาน | รายละเอียด | ผลกระทบ |
|---|---|---|
| **#1: `[item]` anchor** | ทำให้ `[item: xxx]` anchor สินค้าตลอดทั้ง conversation แม้ history ไม่มี model name | `app.py` reference extraction + carry-forward |
| ปรับ answer length | ตอบพอดีไม่สั้นไม่ยาว | `llm.py` SYSTEM_INSTRUCTION |
| Replay batch | รัน replay เปรียบเทียบหลาย conversations พร้อมกัน | `replay_compare.py` |

### 9.2 ระยะกลาง

| งาน | รายละเอียด |
|---|---|
| ขยายไป Lazada / TikTok | implement `lazadachat/` และ `tiktokchat/` |
| Final-answer URL allowlist | ตรวจคำตอบสุดท้ายก่อน return ว่าไม่มีลิงก์นอก (defense in depth) |
| ปรับ `intent_classifier` | เพิ่ม charger subtype ให้ครบ (ตอนนี้ LLM คืนแค่ cable/adapter/set/null) |
| ใช้ `_score_card` และ `_is_sold_out` | นิยามแล้วไม่ใช้ — ควรเชื่อมหรือลบ |
| KB schema validation | validate KB doc schema ด้วย jsonschema |

### 9.3 ระยะยาว

| งาน | รายละเอียด |
|---|---|
| Multi-turn context memory | ทำให้ bot จำ context ข้ามหลาย turn ได้ดีขึ้นโดยไม่ต้องพึ่ง reference extraction |
| Streaming response | ส่งคำตอบเป็น stream ลด latency |
| A/B testing framework | เปรียบเทียบ prompt versions |
| Observability dashboard | ดู usage/cost/latency/quality แบบ real-time |
| Multi-lingual | รองรับอังกฤษ/จีน |

---

## 10. ปัญหาที่ทราบ + แนวทางแก้

| # | ปัญหา | สาเหตุ | แนวทางแก้ | ผลกระทบ |
|---|---|---|---|---|
| 1 | `[item]` ตอบ "ไม่แน่ใจตัวไหน" → turn ถัดไปหาสินค้าไม่เจอ | answer สั้นไม่มี model name → reference extraction หาไม่เจอ → context ว่าง → web_search ทำงาน | เก็บ `item_id` ไว้ใน session/history + carry-forward โดยไม่พึ่ง model name ใน answer | `app.py` reference + carry-forward |
| 2 | Bot แนะนำรุ่นอื่นทุกครั้ง | SYSTEM_INSTRUCTION ไม่ชัด | ✅ แก้แล้ว (เพิ่มกฎ "ตอบ spec รุ่นเดิม แนะนำเฉพาะที่สัมพันธ์") | `llm.py` |
| 3 | "ไม่มี" ทริกเกอร์ web_search จนได้สินค้าอื่นมา | `should_use_web_search` เห็น "ไม่มี" → search | ✅ แก้แล้ว (skip สำหรับ yes/no spec + มีสินค้าใน context) | `web_search.py` |
| 4 | ลิงก์นอกหลุดจาก search_info | search_info มี URL ส่งให้ LLM | ✅ แก้แล้ว (strip URLs + prompt ห้ามใส่ลิงก์นอก) | `app.py` + `llm.py` |
| 5 | Charger subtype ปน | shorthand ไม่ detect + filter ไม่ครบ + brand fallback ฆ่า subtype | ✅ แก้แล้ว | `product_store.py` |
| 6 | Carry-forward ทับ subtype ใหม่ | follow-up detector บังคับสินค้าเก่า | ✅ แก้แล้ว (skip carry-forward เมื่อมี charger subtype ชัด) | `app.py` |
| 6b | Carry subtype ไม่ทำงานเมื่อ message พิมพ์ตก "หัวชาจ" หรือไม่มีคำ charger | `_detect_product_types` ไม่แก้พิมพ์ผิด → carry type ไม่จับ → `current_types` ว่าง → carry subtype ไม่ทำงาน → RAG ดึงสายชาร์จแทนหัวชาร์จ | ✅ แก้แล้ว (carry type เพิ่ม fallback `_detect_charger_subtype` + carry subtype เพิ่ม `_is_charger_ctx` รองรับ message ที่มี subtype ชัด) | `app.py` |
| 7 | KB merge return ก่อน reference | KB path early-return | ✅ แก้แล้ว (ref-indicator guard) | `app.py` |
| 8 | Web search ใช้ query ไม่ระบุสินค้า | ส่ง `req.message` ลอยๆ | ✅ แก้แล้ว (ส่ง `retrieval_message` ที่รวม model name) | `app.py` |
| 9 | `_score_card` / `_is_sold_out` ไม่ถูกเรียก | นิยามไว้แต่ไม่เชื่อม | ระยะกลาง: เชื่อมหรือลบ | `product_store.py` |
| 10 | `answer` return type ผิด | annotated `-> str` แต่คืน `tuple` | ระยะสั้น: แก้ annotation | `llm.py` |

---

## ภาคผนวก: Call Graph สำคัญ

### `chat()` → โมดูลนอก

```
chat()
├── persona.get_persona + persona.build_persona_instruction
├── _extract_item_id_tag → product_store.fetch_product_by_id
├── knowledge_base.detect_general_question (fallback — Phase 6)
├── warranty.detect_tax_invoice_request (fallback — Phase 6)
├── intent_classifier.classify_intent (Phase 6 — รันทุกข้อความ ไม่ gate)
├── warranty.parse_purchase_date / is_in_warranty / detect_claim_request / ...
├── knowledge_base.build_general_context → llm.answer_general
├── _detect_brand_question → _build_brand_context → llm.answer_general
├── knowledge_base.lookup_kb → _merge_kb_mongo → llm.answer
│   └── web_search.should_use_web_search → search_and_extract → llm.answer
├── product_store.fetch_products → _rerank_* → rejection_memory → llm.answer
│   └── web_search.should_use_web_search → search_and_extract → llm.answer
└── _append_base_warranty → return ChatResponse
```

### `app.py` rejection memory (line ~3920, เพิ่ม 2026-09-03)
- **Purpose:** สแกน history หาสินค้าที่ลูกค้าปฏิเสธ → ส่ง extra_context ให้ LLM ว่าห้ามแนะนำซ้ำ
- **Input:** `req.history` (ChatMessage[]), `products` (dict[] — context ปัจจุบัน), `req.message` (current message)
- **Output:** `_rejection_extra` (str — extra_context สำหรับ llm.answer)
- **Detection:**
  1. สแกน model messages ใน history หา product codes (regex `[A-Z][A-Z0-9]{3,11}` + มีตัวเลข)
  2. สแกน user message ถัดไป (หรือ req.message ถ้าเป็น last model message) หา negative signals
  3. Negative signals: ทำไม, ไม่โอเค, ดีกว่า, ไม่เอา, จ่ายได้แค่, แล้วทำไมไม่, ฯลฯ
  4. Matching: code ตรงๆ (case-insensitive) หรือ indirect reference ("สาย" → cable, "หัว" → adapter)
- **Called by:** `chat()` ก่อนเรียก `llm.answer()`
- **Side effects:** ไม่มี DB write — ส่งเป็น extra_context ให้ LLM เท่านั้น
- **Error/fallback:** ถ้าไม่พบ rejected products → `_rejection_extra = ""` → ไม่กระทบ flow ปกติ
```

### `product_store.fetch_products()` internal

```
fetch_products
├── _detect_intent / _detect_product_types / _detect_product_types_fuzzy
├── _detect_charger_subtype
├── _extract_model_tokens
├── build_query
│   └── _detect_shops / _detect_brands / _detect_categories / _extract_price_range
├── vector_search → _load_vector_store
├── _filter_false_positives
├── _rerank_with_diversity → _rerank_by_promo_latest
│   └── _is_bundle_product / _has_active_promotion / _get_recency_score
├── _filter_charger_subtype
└── to_product_card
    └── _price_range / _warranty_info / _first_image_url / _clean_description
```

---

### 6.11 `chat_v2.py` — Pipeline ใหม่ 8 stages (alternative to legacy `chat()`)

> **Feature flag**: `USE_LEGACY_CHAT=1` (default) → legacy `chat()` / `USE_LEGACY_CHAT=0` → `chat_v2()`
> **Status**: syntax + unit test ผ่าน, ยังไม่ได้ทดสอบ runtime (ต้องมี google.genai + MongoDB)

#### 6.11.1 Purpose

แทนที่ legacy `chat()` ใน `app.py` (5000+ บรรทัด, 15+ early return, 20+ shared mutable state) ด้วย pipeline 8 stages ที่:
- แต่ละ stage เป็น function แยก ไม่มี shared mutable state
- คืน None ถ้าไม่จับเคส → ไป stage ถัดไป
- ไม่มี early return ใน main `chat_v2()` นอกจาก deterministic check

#### 6.11.2 Pipeline stages

| Stage | Function | หน้าที่ |
|---|---|---|
| 1 | `_build_context(req)` | setup + history + persona + vision |
| 2 | `_check_deterministic(req, ctx, history)` | order/tracking/tax/human/warranty/general/brand |
| 3 | `_classify_intent(req, ctx, history)` | LLM intent + superlative/multi-usecase/charging-spec/wattage |
| 4 | `_detect_anchor(req, ctx, history, db)` | anchor + subtype mismatch check |
| 5 | `_retrieve_products(req, ctx, history, intent, anchor, db)` | RAG (KB+DB) + follow-up + rerank + filter |
| 6 | `_search_if_needed(req, ctx, history, intent, products, db)` | search → RAG → LLM2 (ไม่ตอบตรง) |
| 7 | `_no_product_guard(req, ctx, intent, products, extra_context)` | ด่านสุดท้าย หลัง search แล้วไม่เจอ |
| 8 | `_build_answer(req, ctx, history, intent, anchor, products, extra_context)` | LLM2 ตอบ |

#### 6.11.3 Helper functions

| ฟังก์ชัน | หน้าที่ |
|---|---|
| `_extract_item_id(message)` | สกัด item_id จาก `[สินค้า: XXX]` |
| `_extract_order_sn(message)` | สกัด order_sn จาก `[order: XXX]` + fallback |
| `_extract_tracking(message)` | สกัด tracking number |
| `_has_image_placeholder(message)` | ตรวจ `[รูปภาพ]/[วิดีโอ]/[sticker]` |
| `_is_image_only(message)` | ตรวจ message เป็นแค่ placeholder |
| `_extract_product_subtype(message)` | สกัด charger subtype |
| `_extract_product_types(message)` | สกัด product types |
| `_extract_target_device(message)` | สกัด target device (Xiaomi 17 Ultra, iPhone 13) |
| `_is_superlative_question(message)` | ตรวจ "สุด/ที่สุด/แรงสุด/ไวสุด" |
| `_is_charging_spec_question(message)` | ตรวจ "ใช้สายชาร์จอะไร/ชาร์จยังไง/พอร์ตอะไร" |
| `_detect_multi_usecase(message)` | ตรวจ scenario+feature pairs (วิ่ง+ANC, ในรถ+แม่เหล็ก) |
| `_extract_wattage(message)` | สกัด "65w", "100 วัตต์" → int |
| `_adjust_fetch_limit_for_superlative()` | superlative → limit * 5 (สูงสุด 50) |
| `_augment_retrieval_for_superlative()` | superlative + "ชาร์จ" → เพิ่ม powerbank ใน retrieval |
| `_detect_followup_products(req, history, db)` | ดึงสินค้าจาก conversation_products timeline |
| MODEL-REGEX pre-filter (inline in `_retrieve_products` 5.2c) | สกัด model keyword จาก message → Mongo `item_name` regex search → ใช้เป็น products หลัก แทน broad vector search |
| `_rerank_products(products, message, intent, anchor)` | เรียงตาม anchor → normal → match → watt → usecase |
| `_filter_unavailable_products(products)` | กรอง sold_out/non-NORMAL (เฉพาะ product_recommend) |
| `_make_response(answer, products, ctx, ...)` | สร้าง ChatResponse dict สม่ำเสมอ |
| `_check_warranty_state_machine(req, ctx, history)` | เรียก `warranty_flow.handle_warranty_flow()` |

#### 6.11.4 Calls

- `_build_context` → `app._db()`, `persona.get_persona()`, `llm.describe_images()`
- `_check_deterministic` → `order_store`, `warranty.detect_*`, `app._routing()`
- `_check_warranty_state_machine` → `warranty_flow.handle_warranty_flow()`
- `_classify_intent` → `intent_classifier.classify_intent()`, `product_store._detect_*`
- `_detect_anchor` → `product_store.fetch_product_by_id()`, `conversation_products.add_item_anchor()`
- `_retrieve_products` → `knowledge_base.lookup_kb()`, `product_store.fetch_products()`, `product_store.to_product_card()`, `conversation_products.get_timeline()`, Mongo `db[coll].find()` (MODEL-REGEX pre-filter)
- `_search_if_needed` → `web_search.search_and_extract()`, `product_store.fetch_products()`
- `_build_answer` → `llm.answer()`, `app._append_base_warranty()`

#### 6.11.5 Called by

- `app.chat()` เมื่อ `USE_LEGACY_CHAT=0` → เรียก `chat_v2.chat_v2(req)`

#### 6.11.6 Side effects

- DB write: `conversation_products.add_item_anchor()` (anchor timeline)
- HTTP call: handoff API (ผ่าน `warranty_flow`)
- Log: `[RAG-V2]`, `[ANCHOR-V2]`, `[SUPERLATIVE-V2]`, `[COMPAT-V2]`, `[INTENT-V2]`

#### 6.11.7 Error/fallback

- ถ้า LLM error → `HTTPException(500)`
- ถ้า DB error → log + ดึงสินค้า 0 ตัว → no_product_guard
- ถ้า search error → ใช้ products เดิม
- ถ้า anchor ไม่เจอ → ดึงสินค้าปกติ

---

### 6.12 `warranty_flow.py` — Warranty state machine (ย้ายจาก legacy)

> **Source**: ย้ายจาก `app.py` บรรทัด 1413-2351 (Warranty Claim State Machine)
> **Status**: logic เดิม 100%, verify ผ่าน 12 แชทใน ledger

#### 6.12.1 Purpose

ห่อ warranty state machine จาก legacy `app.py` ให้ `chat_v2` เรียกได้โดยไม่ต้องเขียน logic ใหม่

#### 6.12.2 Main function

| ฟังก์ชัน | หน้าที่ |
|---|---|
| `handle_warranty_flow(req, ctx, history, db)` | จัดการ warranty state machine ทั้ง 10 states |
| `_handle_review_request()` | State 1: ลูกค้าขอทวนข้อมูล |
| `_build_post_handoff_response()` | State 2: post-handoff lock |
| `_build_warranty_claim_response()` | สร้าง response + handoff API call |
| `_handle_warranty_date_followup()` | State 8: คำนวณช่วงประกัน |
| `_handle_tax_invoice_followup()` | State 9: tax invoice follow-up |
| `_handle_first_message_claim()` | State 10: first-message claim |

#### 6.12.3 States ที่จัดการ

1. Review request — ลูกค้าขอทวนข้อมูล
2. Post-handoff lock — บอทเคย handoff แล้ว ลูกค้าทักใหม่
3. Awaiting claim info — ลูกค้าส่งรูป/วิดีโอ/ข้อมูลบางส่วน
4. Awaiting customer info — ลูกค้าให้ชื่อ/เบอร์/order
5. Awaiting confirmation — ลูกค้ายืนยันหรือแก้ข้อมูล
6. Out of warranty consult — ลูกค้าสนใจปรึกษาแอดมิน
7. Duration answered + claim request — ถามวันที่ซื้อ + handoff
8. Warranty date follow-up — คำนวณช่วงประกัน
9. Tax invoice follow-up — บอทเคยตอบใบกำกับ ลูกค้าตอบต่อ
10. First-message claim — claim request ไม่มี history

#### 6.12.4 Calls

- `handle_warranty_flow` → `warranty.detect_claim_request()`, `warranty.parse_purchase_date()`, `warranty.extract_customer_info()`, `warranty.is_in_warranty()`, `product_store._warranty_info()`, `app._get_post_handoff_exceptions()`, `app._routing()`
- `_build_warranty_claim_response` → handoff API (urllib)

#### 6.12.5 Called by

- `chat_v2._check_warranty_state_machine()` → `warranty_flow.handle_warranty_flow()`

#### 6.12.6 Side effects

- HTTP call: handoff API (`ADMIN_HANDOFF_URL`)
- DB read: `db[ShpProducts].find()` (สำหรับ warranty date followup)
- Log: `[WARRANTY-CLAIM]`, `[HANDOFF-V2]`, `[WARRANTY-DATE-V2]`

#### 6.12.7 Error/fallback

- ถ้า DB error → log + คืน None (ไป pipeline หลัก)
- ถ้า handoff API error → log + ยังส่งคำตอบให้ลูกค้า
- ถ้าไม่ใช่ warranty flow → คืน None → ไป pipeline หลัก

---

### 6.13 `chatbotv3/` — OpenRouter-first paradigm (2026-09-20)

> **Feature flag**: `USE_CHAT_V3=1` หรือ `req.use_v3=True` → route `/chat` ไป `chatbotv3.engine.chat_v3(req)`
> **Default**: ปิด (`USE_CHAT_V3=0`) → legacy/v2 ทำงานเหมือนเดิม
> **Paradigm**: ไม่นั่งปั้น RAG context แบบ legacy แต่ส่ง raw (message + history + images + shop link) ให้ OpenRouter ตอบ → เอา list สินค้ามา match กับ ShpProducts

#### 6.13.1 Purpose

แชทบอท v3 สำหรับ Shopee — เปลี่ยน paradigm จากการสร้าง RAG context แบบ legacy มาเป็นการส่ง raw context (message + history + images + shop link + สินค้าในร้าน) ให้ OpenRouter ตอบ แล้วเอา list สินค้าที่ LLM อ้างถึงมา match กับ ShpProducts จริงในร้านนั้น เพื่อป้องกันการแนะนำสินค้าที่ไม่มีในร้าน

#### 6.13.2 ไฟล์ในแพ็กเกจ

| ไฟล์ | หน้าที่ |
|---|---|
| `__init__.py` | export `chat_v3` |
| `or_client.py` | OpenRouter client (round-robin API keys, AI Usage Hub log, multimodal) |
| `system_prompt.py` | SYSTEM_INSTRUCTION_V3 (base จาก llm.py + กฎ v3 ใหม่ + fallback) |
| `shop_link.py` | สร้าง shop URL `https://shopee.co.th/{shopname_lower}?entryPoint=ShopBySearch&searchKeyword={shopname_lower}` |
| `rich_parse.py` | parse rich tags ([สินค้า: id], [order: sn], [รูปภาพ], placeholder) |
| `product_match.py` | match สินค้าจาก OpenRouter answer กับ ShpProducts (กรองเฉพาะร้าน) |
| `emotion.py` | detect negative emotion (strong + moderate + word boundary) + human request |
| `engine.py` | main flow: parse → safety checks (warranty/emotion/human) → LLM → product match → response |

#### 6.13.3 Main function

| ฟังก์ชัน | หน้าที่ |
|---|---|
| `chat_v3(req)` | main entry — รับ ChatRequest → คืน dict compatible กับ ChatResponse |
| `or_client.call_or(model, system, user, history, images)` | เรียก OpenRouter + log AI Usage Hub |
| `system_prompt.build_system_instruction(shop_name, shop_url, persona_extra)` | สร้าง system instruction สำหรับ v3 (รวม persona) |
| `shop_link.build_shop_url(shop_name, platform)` | สร้าง shop URL จากชื่อร้าน |
| `shop_link.build_shop_context_block(shop_name, platform)` | สร้าง context block สำหรับแปะใน user prompt |
| `rich_parse.parse_rich_message(text)` | parse rich tags → dict (item_id, order_sn, has_image, etc.) |
| `product_match.match_products(answer, shop_filter, db)` | match สินค้าจาก LLM answer กับ ShpProducts |
| `product_match.get_product_by_id(item_id, shop_filter, db)` | ดึงสินค้า 1 ชิ้นจาก item_id |
| `product_match.get_shop_products_summary(shop_filter, db, message)` | ดึงสินค้าทั้งหมดในร้าน (context เสริม) |
| `emotion.detect_negative_emotion(message, history)` | ตรวจอารมณ์เสีย → handoff admin |
| `emotion.detect_human_request(message)` | ตรวจลูกค้าขอคุยแอดมิน |
| `_send_handoff_to_admin(conv_id, shop, platform, reason, claim, simulate)` | ส่ง handoff ไป ChatAdminWeb จริง (เหมือน legacy) |
| `_get_persona_extra(shop_name, platform)` | ดึง persona instruction ของร้าน (lazy import persona) |
| `_lookup_order_context(order_sn, shop)` | lookup order จริง + สร้าง context string (lazy import order_store) |
| `_extract_image_desc_from_answer(answer, has_images)` | สกัด image_desc จากคำตอบ LLM (ถ้ามีรูป) |

#### 6.13.4 Flow (chat_v3)

1. รับ ChatRequest → extract message, shop, history, images, item_id, order_sn, conversation_id, simulate_assignment
2. parse rich message (item_id, order_sn, image placeholder)
3. deterministic safety checks (ตามลำดับ priority):
   a. warranty claim (จริง) → handoff admin (เหมือน legacy) — **เรียก handoff API จริง**
   b. emotion (อารมณ์เสีย) → handoff admin (ใหม่ v3) — **เรียก handoff API จริง**
   c. human request → handoff admin — **เรียก handoff API จริง**
4. ดึงสินค้าในร้าน (context เสริม) — ส่งเป็น list สั้นๆ ให้ LLM
5. ดึง persona ของร้าน (ถ้ามี) + lookup order จริง (ถ้ามี order_sn)
6. สร้าง system instruction (รวม persona) + user prompt (รวม shop context block + order context)
7. เรียก OpenRouter (เลือก vision model ถ้ามี images)
8. match สินค้าที่ LLM อ้างถึง กับ ShpProducts จริง (กรองเฉพาะร้าน)
9. สกัด image_desc (ถ้ามีรูป)
10. คืน response dict (compatible กับ ChatResponse — รวม answer_segments, image_desc)

#### 6.13.5 Calls

- `chat_v3` → `rich_parse.parse_rich_message()`, `warranty.detect_claim_request()`, `emotion.detect_negative_emotion()`, `emotion.detect_human_request()`, `product_match.get_shop_products_summary()`, `product_match.get_product_by_id()`, `_get_persona_extra()`, `_lookup_order_context()`, `system_prompt.build_system_instruction()`, `shop_link.build_shop_url()`, `shop_link.build_shop_context_block()`, `or_client.call_or()`, `product_match.match_products()`, `_extract_image_desc_from_answer()`, `_send_handoff_to_admin()`
- `_send_handoff_to_admin` → `urllib.request.urlopen()` (POST `ADMIN_HANDOFF_URL`)
- `_get_persona_extra` → `persona.get_persona()`, `persona.build_persona_instruction()` (lazy import)
- `_lookup_order_context` → `order_store.lookup_order()`, `order_store.build_order_context()` (lazy import)
- `or_client.call_or` → OpenRouter REST API (`/chat/completions`), AI Usage Hub log API
- `product_match.match_products` → `product_store.to_product_card()`, MongoDB `ShpProducts.find_one()`
- `product_match.get_shop_products_summary` → `product_store.fetch_products()`
- `product_match.get_product_by_id` → `product_store.fetch_product_by_id()`
- `rich_parse.parse_rich_message` → `order_store.extract_order_sn()`, `order_store.extract_tracking_number()`
- `system_prompt.build_system_instruction` → `llm.SYSTEM_INSTRUCTION` (lazy import, fallback ถ้า import ไม่ได้)

#### 6.13.6 Called by

- `app.chat()` → `chatbotv3.chat_v3(req)` (เมื่อ `USE_CHAT_V3=1` หรือ `req.use_v3=True`)
- `ChatAdminWeb botCallService.callBot()` → ส่ง `use_v3: true` เมื่อ `shouldUseChatV3()` คืน true

#### 6.13.7 Side effects

- HTTP call: OpenRouter `/chat/completions`
- HTTP call: AI Usage Hub log (fire-and-forget)
- HTTP call: `ADMIN_HANDOFF_URL` (POST handoff ไป ChatAdminWeb — เมื่อ detect warranty/emotion/human)
- DB read: `ShpProducts.find()`, `ShpProducts.find_one()` (กรองเฉพาะร้าน)
- DB read: `persona` collection (ดึง persona ของร้าน)
- DB read: `order_store` collection (lookup order จริง)
- Log: `[OR-V3]` (API key count, errors), `[HANDOFF-V3]` (handoff sent/failed), `[PERSONA-V3]`, `[ORDER-V3]`

#### 6.13.8 Error/fallback

- ถ้า OpenRouter fail → ตอบ "ขออภัยค่ะ ตอนนี้ไม่สามารถตอบคำถามได้ รบกวนลองใหม่อีกครั้งนะคะ"
- ถ้า product match fail → คืนคำตอบ LLM โดยไม่มี products (ไม่ block)
- ถ้า warranty/emotion module fail → log + ไป LLM path (ไม่ block)
- ถ้า llm module import ไม่ได้ → ใช้ fallback system instruction
- ถ้าไม่มี API key → `call_or` คืน error → ตอบ fallback

#### 6.13.9 กฎใหม่ใน system instruction (v3)

- ตอบจากฐานข้อมูลก่อน มีคำตอบห้ามส่งต่อ
- ปัญหาการใช้งาน ต้องบอกวิธีตรวจสอบก่อน ถามซ้ำจึงส่งต่อ
- ห้ามบอกว่าตรวจสอบระบบหรือคำสั่งซื้อแล้ว
- ห้ามสรุปแทนทุกรุ่น
- ห้ามเสนอหัวข้อที่ไม่ได้ถาม
- ห้ามสัญญาแทนคน (เคลม/คืนเงิน/ส่วนลด ให้คนตัดสินใจ)
- บทบาท: ผู้ช่วยร้านอุปกรณ์ไอที
- ตอบภาษาไทยเสมอ ลงท้ายด้วยค่ะ ไม่ใช้ครับ
- สุภาพ กระชับ ตรงประเด็น ไม่ทักทายยืดยาว ไม่ใช้ศัพท์เทคนิคเกินจำเป็น
- shop link isolation: ตอบแค่สินค้าในลิงก์ร้านที่ส่งมาเท่านั้น

#### 6.13.10 Emotion detection (ใหม่ v3)

- Strong keywords (โกง, ควาย, กาก, ห่วย, โกรธ, ร้องเรียน, ฯลฯ) → handoff ทันที
- Moderate keywords (อืด, ช้า, บัค, แย่, ฯลฯ) + negative context (มาก, จัง, เลย) → handoff
- Moderate keywords ซ้ำ 2 ครั้งขึ้นไปใน history → handoff
- Word boundary สำหรับคำสั้น (บ้า ≠ บ้าง, กาก ≠ กากมาก, ช้า ≠ ช้าง)
- Human request (ขอคุยแอดมิน, staff, human, ฯลฯ) → handoff

#### 6.13.11 Verification ที่ผ่าน

- `py_compile` ทุกไฟล์ (8 ไฟล์ + app.py) — ผ่าน
- smoke test import ทุก module — ผ่าน (lazy import ไม่ต้องลง google-genai/pymongo)
- shop_link.build_shop_url — ผ่าน (KingGadgets, ThaiSuperPhone, empty)
- rich_parse.parse_rich_message — ผ่าน (item tag, image placeholder, placeholder only)
- emotion.detect_negative_emotion — ผ่าน (strong, moderate+context, normal, complaint history, word boundary)
- emotion.detect_human_request — ผ่าน
- product_match._extract_product_names_from_answer — ผ่าน
- engine.chat_v3 (mock) — ผ่าน 6 tests: warranty handoff, emotion handoff, human request handoff, placeholder only, normal LLM call, บ่นเล่นๆ ไม่ handoff
- engine.chat_v3 (mock, audit features) — ผ่าน 7 tests:
  1. handoff API จริง (warranty claim) — ส่ง POST จริง, payload ถูกต้อง ✓
  2. persona ของร้าน — ดึง persona ได้, ส่งเข้า system instruction ✓
  3. image_desc — คืน "" ตาม design (v3 ส่งรูปเข้า LLM ตรง) ✓
  4. answer_segments — แยก `|||` ได้ 3 segments ✓
  5. order_sn lookup — lookup จริง, ส่ง context เข้า prompt ✓
  6. handoff ไม่ส่ง API เมื่อไม่มี conversation_id ✓
  7. simulate_assignment ส่งไป handoff API ✓
- `npx tsc --noEmit` (ChatAdminWeb) — ผ่าน (type `"v3"` ใน chat_engine ทุกไฟล์)

#### 6.13.12 ยังไม่ได้ทดสอบ

- Live OpenRouter call (ต้องมี API key จริง)
- Live MongoDB product match (ต้องเชื่อม DB จริง)
- End-to-end ผ่าน `/chat` endpoint (ต้องรัน server)
- Replay/shadow test เทียบกับ legacy

---

*เอกสารนี้สร้างจากการสำรวจโค้ดจริงทั้ง 8 ไฟล์ใน `chatbot/shopeechat/` + โครงสร้าง `ChatAdminWeb/` โดยใช้ subagent แบบ read-only ขนานกัน ไม่ได้อ่าน `.env`*
