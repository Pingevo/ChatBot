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
│    (conditional — should_run_pass1 เป็นเกท)                   │
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
| `chat` | 368 | **`POST /chat` — main orchestrator** | ทุก pipeline stage (ดู section 5) |
| `list_test_chat_sessions` | 4110 | `GET /test-chat/sessions` | `_admin_db()` |
| `create_test_chat_session` | 4132 | `POST /test-chat/sessions` | `_admin_db()`, `_log_testchat_action` |
| `get_test_chat_session` | 4154 | `GET /test-chat/sessions/{id}` | `_admin_db()` |
| `add_test_chat_message` | 4177 | `POST /test-chat/sessions/{id}/messages` | `_admin_db()`, `_log_testchat_action` |
| `delete_test_chat_session` | 4217 | `DELETE /test-chat/sessions/{id}` | `_admin_db()`, `_log_testchat_action` |
| `update_test_chat_session` | 4241 | `PATCH /test-chat/sessions/{id}` | `_admin_db()`, `_log_testchat_action` |
| `list_test_chat_logs` | 4283 | `GET /test-chat/logs` | `_admin_db()` |
| `feedback` | 4304 | `POST /feedback` — thumbs up/down | — |

#### 6.1.2 Pipeline helpers (top-level)

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `_extract_item_id_tag` | 361 | extract `[item: xxx]` tag | `_ITEM_TAG_RE` |
| `_record_suggestion_products` | 3938 | บันทึกสินค้าที่ bot แนะนำลง conversation_products timeline | `conversation_products.add_product` |
| `_append_base_warranty` | 3971 | append warranty text ถ้าเป็นคำถามรับประกัน | `knowledge_base.is_warranty_question`, `warranty` |
| `_detect_brand_question` | 3866 | detect "Xiaomi ขายอะไรบ้าง" | `re` |
| `_build_brand_context` | 3896 | สร้าง context ของแบรนด์ | `os`, `re`, `Counter` |
| `_merge_kb_mongo` | 3959 | รวม KB doc + Mongo product card | `_kb_doc_to_card`, `re` |
| `_kb_doc_to_card` | 4060 | แปลง KB doc → product card | — |

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
| `ChatRequest` | 106 | body `/chat` (message, shop, item_id, history, limit, handoff fields, simulate) |
| `ChatResponse` | 124 | response `/chat` (answer, products, source, usage, timing, web_search, handoff, routing_decision) |
| `FeedbackRequest` | 170 | body `/feedback` |
| `TestChatMessage`, `CreateSessionRequest`, `AddMessageRequest`, `UpdateSessionRequest` | 4086-4104 | test-chat schemas |

---

### 6.2 `llm.py` — Gemini LLM

#### 6.2.1 Main generation

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `answer` | 434 | ตอบคำถามสินค้าจาก product context | `_client()`, `_build_context()` |
| `answer_with_kb` | 604 | ตอบจาก KB context (ไม่มี product_store) | `_client()` |
| `answer_general` | 664 | ตอบคำถามทั่วไป (policy/brands/categories) | `_client()` |

#### 6.2.2 API key management

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_load_api_keys` | 290 | โหลด `GEMINI_API_KEY_1..9` + `GEMINI_API_KEY` |
| `_next_api_key` | 317 | หมุนวน round-robin |
| `_client` | 327 | สร้าง `genai.Client` |

#### 6.2.3 Prompt building + helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_build_context` | 357 | แปลง product cards → context string (พร้อม description_excerpt/weight/dimension) |
| `split_segments` | 337 | แยก answer ด้วย `|||` |

#### 6.2.4 Module constants

| ชื่อ | Line | สรุปกฎสำคัญ |
|---|---|---|
| `SYSTEM_INSTRUCTION` | 19-280 | บุคลิกหญิงใช้ `ค่ะ/นะคะ`, ตอบจาก context เท่านั้น, แยก bubble `|||`, แนะนำ 2-3 ชิ้น, ห้ามบอกราคา, ร้าน isolation, **ห้ามแนะนำรุ่นอื่นเมื่อถาม spec รุ่นเดิม (เว้นแต่สัมพันธ์กับคำถาม)**, **ห้ามใส่ลิงก์ภายนอก** |
| `KB_SYSTEM_INSTRUCTION` | 572-601 | บุคลิกเดียวกัน, ตอบจาก KB context, สั้นกระชับเรื่องรับประกัน |
| `_SEGMENT_DELIMITER` | 334 | `"|||"` |

---

### 6.3 `product_store.py` — MongoDB retrieval

#### 6.3.1 Main retrieval

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `fetch_products` | 2385 | **central retrieval** — สร้าง query + filter + rerank + card | `_detect_*`, `build_query`, `vector_search`, `_filter_*`, `_rerank_*`, `to_product_card` |
| `fetch_product_by_id` | 2880 | ดึงสินค้าเดียวโดย `item_id` | `to_product_card` |
| `fuzzy_match_products` | 559 | rapidfuzz fallback สำหรับพิมพ์ผิด | `_extract_product_name_tokens`, `to_product_card` |
| `vector_search` | 68 | cosine similarity กับ embedding NPZ | `_load_vector_store`, `embedding.embed_query` |

#### 6.3.2 Charger subtype

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_detect_charger_subtype` | 1357 | detect `cable`/`adapter`/`set`/`car_charger`/`wireless`/`desktop`/`socket` จากข้อความ (รวม shorthand `"หัว"`/`"สาย"`) |
| `_filter_charger_subtype` | 1470 | กรอง docs ให้ตรง subtype (พร้อมกฎ set/cable/adapter cross-inclusion) |

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
| `build_query` | 1829 | สร้าง MongoDB filter (shop/brand/category/price/type/warranty) | `_detect_*`, `_product_type_*`, `warranty.strip_warranty_keywords` |
| `_product_type_regex` | 1816 | join regex ของ detected types | — |
| `_product_type_categories` | 1808 | ดึง candidate `cat_name` ของ types | — |
| `_detect_product_types` | 1265 | exact keyword + regex detect product types | — |
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
| `_PRODUCT_TYPE_CATEGORIES` | 1736 | product type → candidate cat_name |

---

### 6.4 `intent_classifier.py` — Pass 1 LLM

#### 6.4.1 Main classification

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `classify_intent` | 132 | **Pass 1 LLM classifier** — ถาม Gemini ให้คืน JSON intent | `_client()` |

**Output keys**: `intent`, `product_type`, `charger_subtype`, `target_device`, `needs_description`, `confidence`, `model`, `usage`

#### 6.4.2 Gate

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `should_run_pass1` | 232 | ตัดสินใจว่าจะเรียก LLM หรือใช้ rule-based — return True เฉพาะ claim/compat/unknown-product-type/warranty-history |

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
| `extract_model_keywords` | 235 | tokenize + filter stopwords → model keyword candidates |
| `detect_general_question` | 189 | detect warranty/return/shipping policy / brands / categories / shops / tax_invoice |
| `detect_topic` | 223 | match `TOPIC_KEYWORDS` → `warranty`/`specs`/`box_contents`/`highlights`/`description`/`comparison` |
| `is_warranty_question` | 76 | simple warranty/claim keyword check |

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
| `should_use_web_search` | 119 | **multi-rule trigger** — config + skip + uncertainty + compat + spec + negative | `is_configured`, `detect_uncertainty`, `knowledge_base.extract_model_keywords` |

**Skip conditions** (เมื่อ `_has_products=True`):
- warranty / spec / comparison question
- charging-spec question
- follow-up question (สั้นๆ)
- **yes/no spec question (เพิ่มใหม่):** "มี...ไหม/รองรับ...ไหม/ได้...ไหม/กัน...ไหม/สำรอง...ไหม"

#### 6.6.2 Search execution

| ฟังก์ชัน | Line | หน้าที่ | เรียก |
|---|---|---|---|
| `search_and_extract` | 272 | **เรียก OpenRouter + parse JSON + extract keywords** | `is_configured`, `_get_openrouter_*`, `_log_ai_usage` |
| `search_and_answer` | 502 | deprecated wrapper | `search_and_extract` |

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

#### 6.9.3 Helpers

| ฟังก์ชัน | Line | หน้าที่ |
|---|---|---|
| `_admin_db` | 40 | lazy load knowledge_base._build_admin_client → admin DB |
| `_coll` | 47 | คืน collection `conversation_products` |
| `_to_serializable` | 65 | แปลง float → int สำหรับ Mongo |
| `_strip_card_for_storage` | 175 | ตัด product card เก็บแค่ fields จำเป็น (ประหยัดพื้นที่) |
| `_compute_active` | 195 | คำนวณ active = anchor ล่าสุด (fallback: suggestion ล่าสุด) |

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
  last_updated: ISODate,
}
```

#### 6.9.5 Priority rules (active product)

1. ถ้า message มีชื่อรุ่นเฉพาะ → หาสินค้าที่ match ใน timeline
2. ถ้า message พูด "ตัวเดิม/อันเดิม/ของเดิม" → anchor ล่าสุด
3. ถ้า message พูด "อันที่แนะนำ/ที่ส่งมา" → suggestion ล่าสุด
4. ถ้า message เป็น generic question → active product (anchor ล่าสุด)
5. default → active product

#### 6.9.6 Integration in app.py

| จุด | Line | ทำอะไร |
|---|---|---|
| item-tag anchor | ~428 | บันทึก anchor product ตอนลูกค้าส่ง `[item: xxx]` |
| conv-active resolution | ~2835 | ดึง active product จาก timeline ก่อน carry-forward |
| conv-active context note | ~2927 | บอก LLM ห้ามสลับสินค้า |
| suggestion recording | ~3938 | `_record_suggestion_products()` บันทึกสินค้าที่ bot แนะนำ |
| web_search return | ~3894 | เรียก `_record_suggestion_products` ก่อน return |
| product_store return | ~3920 | เรียก `_record_suggestion_products` ก่อน return |

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
├── knowledge_base.detect_general_question
├── warranty.detect_tax_invoice_request
├── intent_classifier.classify_intent (conditional)
├── warranty.parse_purchase_date / is_in_warranty / detect_claim_request / ...
├── knowledge_base.build_general_context → llm.answer_general
├── _detect_brand_question → _build_brand_context → llm.answer_general
├── knowledge_base.lookup_kb → _merge_kb_mongo → llm.answer
│   └── web_search.should_use_web_search → search_and_extract → llm.answer
├── product_store.fetch_products → _rerank_* → llm.answer
│   └── web_search.should_use_web_search → search_and_extract → llm.answer
└── _append_base_warranty → return ChatResponse
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

*เอกสารนี้สร้างจากการสำรวจโค้ดจริงทั้ง 8 ไฟล์ใน `chatbot/shopeechat/` + โครงสร้าง `ChatAdminWeb/` โดยใช้ subagent แบบ read-only ขนานกัน ไม่ได้อ่าน `.env`*
