# SRS / SSD — ChatBotProductMS

**อัปเดตล่าสุด:** 2026-10-02 (เขียนใหม่ทั้งไฟล์จากโค้ดจริง — แทนที่ฉบับ 2026-09-02)
**ขอบเขต:** `chatbot/shopeechat/` (production) + `chat_v2` + `chatbotv3/` + `scripts/*` + `ChatAdminWeb/` + `lazadachat/`/`tiktokchat/` (placeholder)
**อ้างอิงเสริม:** `docs/schema.md` (field-level DB schema) · `docs/plans/2026-09-21-retrieval-hybrid-rerank-plan.md` · `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` · `getoutofmywaybotkaikrook2.md` (work log)

> **กฎเอกสาร:** อ้างอิงด้วย *ชื่อฟังก์ชัน/โมดูล* เท่านั้น — ไม่ใช้ line numbers (ตายหลัง refactor) · ไม่ใส่ changelog ย่อยใน cell (อยู่ใน waythrough log)

---

## สารบัญ

1. [ภาพรวมระบบ](#1-ภาพรวมระบบ)
2. [สถาปัตยกรรม](#2-สถาปัตยกรรม)
3. [ฐานข้อมูล](#3-ฐานข้อมูล)
4. [บริการภายนอก](#4-บริการภายนอก)
5. [กระบวนการทำงานของ Chat Pipeline](#5-กระบวนการทำงานของ-chat-pipeline)
6. [รายการฟังก์ชันทั้งหมด](#6-รายการฟังก์ชันทั้งหมด)
7. [คอนฟิกและตัวแปรสำคัญ](#7-คอนฟิกและตัวแปรสำคัญ)
8. [สถานะปัจจุบัน](#8-สถานะปัจจุบัน)
9. [แผนอนาคต](#9-แผนอนาคต)
10. [ปัญหาที่ทราบ + แนวทางแก้](#10-ปัญหาที่ทราบ--แนวทางแก้)
11. [ภาคผนวก: Call Graph สำคัญ](#ภาคผนวก-call-graph-สำคัญ)

---

## 1. ภาพรวมระบบ

ระบบ chatbot ตอบลูกค้าร้านอุปกรณ์ไอทีบน Shopee (production) พร้อม admin console สำหรับคุมบอท ดูแชท จ่ายงาน และทดสอบ

### 1.1 เป้าหมายหลัก (functional scope)

| ขีดความสามารถ | โมดูลหลัก |
|---|---|
| ตอบคำถามสินค้า (spec/รุ่น/ตัวเลือก/ใช้งาน/เปรียบเทียบ) | `product_store`, `llm`, `knowledge_base` |
| แนะนำสินค้า + การ์ดสินค้า + short link | `product_store.fetch_products` → `to_product_card` |
| รับประกัน/เคลม (state machine เก็บข้อมูล→handoff) | `warranty`, `warranty_flow`, `order_store` |
| ใบกำกับภาษี → ส่งแอดมิน | `warranty.detect_tax_invoice_request`, `handoffs` |
| มาตรฐานสินค้า (TISI/มอก./CE/CCC/FCC/RoHS/GB) | `product_store.search_cert_products` |
| คำสั่งซื้อ/เลขพัสดุ/คืน/ refund | `order_store`, `order_flow` |
| Compatibility (ใช้กับอุปกรณ์ X ได้ไหม) | `device_compat` + `device_specs_data` |
| อ่านรูป/วิดีโอที่ลูกค้าส่ง | `llm.describe_image(s)` (multimodal vision) |
| Web search fallback เมื่อ catalog ไม่พอ | `web_search` (OpenRouter) |
| ส่งต่อแอดมิน (human request/claim/tax/อารมณ์เสีย v3/ไม่พบสินค้า) | `handoffs`, `responses._send_handoff` |
| จำบริบทสินค้า/order ข้าม turn | `conversation_products` (timeline+anchors) |

### 1.2 ช่องทาง

| Channel | สถานะ |
|---|---|
| Shopee (`shopeechat/`) | ✅ production (port 8010) |
| Lazada (`lazadachat/`) | ⚠️ placeholder — `__init__.py` ว่าง, port 8011 ว่าง |
| TikTok (`tiktokchat/`) | ⚠️ placeholder — port 8012 ว่าง |

### 1.3 Chat engines (เลือกต่อ request)

| Engine | Entry | เลือกเมื่อ | แนวคิด |
|---|---|---|---|
| Legacy | `app._chat_impl(req)` | `USE_LEGACY_CHAT=1` (default) | deterministic flow → intent → hybrid retrieval → compat → search fallback → LLM |
| chat_v2 | `chat_v2.chat_v2(req)` | `req.use_v2=True` หรือ `USE_LEGACY_CHAT != "1"` | 8-stage pipeline สะอาด แชร์โมดูลเดิม |
| chatbotv3 | `chatbotv3.engine.chat_v3(req)` | `req.use_v3=True` หรือ `USE_CHAT_V3=1` | OpenRouter-first: safety checks → ส่ง catalog context ให้ LLM → match ชื่อสินค้ากลับ DB |

ทุก engine คืน dict เดียวกัน (ChatResponse-compatible) และผ่าน `guards.enforce()` ด่านสุดท้ายเสมอ

---

## 2. สถาปัตยกรรม

### 2.1 ภาพรวม

```
┌─────────────────────────────────────────────────────────────────┐
│  Shopee (sellcenter mirror → MongoDB)                            │
│   conversations_shp / messages_shp / customers_shp / shops       │
└──────────────┬──────────────────────────────────────────────────┘
               │ poll (bot-worker.ts, ทุก ~2-5s)
               ▼
┌──────────────────────────┐      ┌───────────────────────────────┐
│  ChatAdminWeb (Next.js)  │─────▶│  chatbot/shopeechat (FastAPI) │
│  port 3000               │/chat │  port 8010                    │
│  - botWorkerService      │◀─────│  - app.py (entry + legacy)    │
│    (poll→buffer→trigger→ │ hand │  - chat_v2.py (8-stage)       │
│     workflow→callBot)    │ off  │  - chatbotv3/ (OpenRouter)    │
│  - shadow_replies        │ POST │  - guards.enforce (ทุก engine) │
│  - test/live assignment  │      │                               │
│  - KB/persona/llm config │      │  Mongo: ShpProducts (ro)      │
│  - inbox/dashboard/KPI   │      │         sellable_units        │
└──────────┬───────────────┘      │         image_texts           │
           │                      │         itStock.Products      │
           ▼                      │         ShpOrders             │
   admin DB (chatbot_admin)       │         knowledge_base/KB QA  │
   34 collections (ดู schema.md)  │         persona/llm_config    │
                                  │         conversation_products │
                                  └──────────┬────────────────────┘
                                             │
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                         Gemini API    OpenRouter     AI Usage Hub
                         (intent/      (web search +  (usage/cost log,
                          answer/      chatbotv3)      fire-and-forget)
                          vision)
```

### 2.2 การเชื่อมต่อระหว่างส่วน

| ทิศทาง | วิธี | รายละเอียด |
|---|---|---|
| ChatAdminWeb → bot | `POST {CHATBOT_BASE_URL_*}/chat` | header `X-Internal-Secret`; payload มี `conversation_id`, `simulate_assignment`, `ticket_state`, `use_v2`/`use_v3`, `llm_context_limit` |
| bot → ChatAdminWeb | `POST {ADMIN_HANDOFF_URL}` (default `…/api/admin/conversations/bot-handoff`) | `simulate=true` → `test_status_conversation`; `false` → `conversations` จริง + assign admin |
| bot → AI Usage Hub | `POST {AI_USAGE_HUB_URL}/internal/ai-usage/logs` | fire-and-forget ทุก LLM call (ไม่ block คำตอบ) |
| bot → OpenRouter | `POST {OPENROUTER_BASE_URL}/chat/completions` | web_search + chatbotv3; key rotation 1-9 |
| bot → Gemini | `google.genai` SDK | intent/answer/vision; key rotation + quota tracking (RPD/RPM/TPM) |
| sellcenter → Mongo | mirror dump ทุก ~2s | `conversations_shp`/`messages_shp` ถูก dump ทับ → admin state แยกใน `status_conversation` |

### 2.3 การ mirror ข้อมูลแชทเข้าระบบ

sellcenter dump แชท Shopee ลง `conversations_shp`/`messages_shp` (เขียนทับ field บางส่วน) → `status_conversation` เก็บ admin-owned fields (`assigned_to`, `status`, `closed_at`, `close_count`) กันโดนทับ · `bot-worker.ts` poll `messages_shp` (role=user, direction=in) → `bufferService` debounce → `triggerService`/`workflowEngine` → `botCallService.callBot` → เก็บคำตอบใน `shadow_replies` (IRON RULE: ห้ามส่งจริงให้ลูกค้า)

---

## 3. ฐานข้อมูล

4 กลุ่ม (field-level schema → `docs/schema.md`)

### 3.1 Admin DB: `chatbot_admin` (env `ADMIN_MONGO_*`)

ใช้ร่วมกันโดย Next.js (เขียนหลัก) + Python (อ่าน KB/persona/shop_settings/test_chat, เขียน `conversation_products`/`image_texts`/`sellable_units`)

| Collection | ใช้ทำอะไร | เขียนโดย |
|---|---|---|
| `conversations` | แชทหลัก (ถูก sellcenter dump ทับบาง field) | sellcenter + Next.js |
| `messages` | message log (raw_payload ของ Shopee) | sellcenter |
| `status_conversation` | admin-owned state (assigned_to/status/closed_at/close_count) — กัน dump ทับ | Next.js |
| `test_status_conversation` | เวอร์ชัน test ของ status | Next.js (`simulate` path) |
| `shadow_replies` | คำตอบบอทที่ generate (ไม่ส่งจริง — IRON RULE) | Next.js botWorker |
| `chat_processing` | idempotency ของ bot worker (message_id) | Next.js |
| `buffer_messages` | debounce buffer | Next.js bufferService |
| `conversation_products` | timeline สินค้า/order ต่อ conversation (anchor/suggestion/claim_state); doc key = conversation_id, shadow ใช้ prefix `shadow:` | **Python** `conversation_products.py` |
| `knowledge_base` | FAQ + product_spec + general_faq | import script + admin UI `/knowledge` |
| `knowledge_base_products` / `knowledge_base_qa` | KB product entries / QA pairs (`USE_QA_KB`) | import + admin |
| `shop_personas` | persona ต่อร้าน (bot_name ฯลฯ) | admin UI `/persona` |
| `shop_settings` | per-shop settings (`faq_liveagent_action`, post-handoff exceptions ฯลฯ) | admin UI |
| `system_configs` | `llm_config` (key pool AES-GCM + per-role models) + `role_permissions` + switches | `/llm`, `/roles`, `/config` |
| `test_chat_sessions` / `test_chat_ratings` | test chat จาก `/test-chat` + rating | Python `test_chat_api` + Next.js |
| `test_assignment` | replay results (QA sets, transcript เต็มใน `qa` — docs ใหญ่ ~60KB avg, list endpoints ใช้ projection) | scripts + admin |
| `live_assignment` (ผ่าน `test_assignment`) | จ่ายงานจริงแอดมิน + จำลอง flow | Next.js |
| `chat_annotations` | markup dot + note (unique index `{scope, conv_id, gen_batch_id}`) | admin UI |
| `image_texts` | OCR text จากรูปใน description (Gemini vision offline) | Python `build_image_texts*.py` |
| `sellable_units` | unit index (item_id × model_id, ~27.8k docs) | Python `build/import_sellable_units` |
| `admins`/`sessions`/`admin_logs` | auth (SSO) + audit log | Next.js |
| `triggers`/`workflows`/`workflow_runs` | keyword trigger + visual flow builder + run state | admin UI |
| `assignment_configs`/`assignment_cursors`/`shop_team_assignments`/`platform_team_assignments` | round-robin assignment (equal_global/equal_per_shop/weighted) | Next.js |
| `quick_replies`/`close_history`/`chat_accept_sessions`/`tickets`/`shops`/`customers` | canned replies, close/reopen history, accept sessions, tickets, shop/customer mirror | Next.js |
| `test_chat_uploads` | ไฟล์อัปโหลดใน test-chat | Next.js |
| `guardrails`/`auth_tokens`/`pushevents`/`requestlogs` | ⚠️ legacy — ประกาศไว้แต่ไม่ใช้ | — |

### 3.2 Product DB: `dbWallet` (env `MONGO_*`, read-only)

| Collection | ใช้ทำอะไร |
|---|---|
| `ShpProducts` (env `MONGO_COLLECTION`) | listing สินค้า Shopee — `item_id`, `item_name`, `models[]`, `stock`, `status` (NORMAL/UNLIST/…), `sold_out`, price, `warranty`, `description`, images, `shopname`, `cat_name`, `brand` |

### 3.3 Order DB (env `ORDER_URI_MONGO`/`ORDER_DB`/`ORDER_COLLECTION`, read-only)

| Collection | ใช้ทำอะไร |
|---|---|
| `ShpOrders` (default) | คำสั่งซื้อ — `order_sn`, tracking, items, buyer, status, logistics, create/delivery time |

### 3.4 Stock DB (env `STOCK_URI`/`STOCK_DB`, read-only)

| Collection | ใช้ทำอะไร |
|---|---|
| `itStock.Products` | cert flags + stock data — join ผ่าน `shopee_ship_box.{item_id, model_id}` |

### 3.5 Local files (ไม่ใช่ Mongo)

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `exports/ShpProducts.export.json` | snapshot ต้นทางของ offline builds |
| `exports/product_embeddings.npz` | vector store listings (mtime-reload ไม่ต้อง restart) |
| `exports/unit_embeddings.npz` / `qa_embeddings.npz` | vector store units / QA pairs |
| `exports/sellable_units.jsonl` | build artifact → import `sellable_units` |
| `exports/image_texts.jsonl` | OCR artifact → import `image_texts` (resume ได้) |
| `exports/typo_dict.json` | vocab/typo map → `route_context` |

---

## 4. บริการภายนอก

| บริการ | ใช้ทำอะไร | จุดเรียก |
|---|---|---|
| Google Gemini (`google.genai`) | intent classification, answer generation, vision, embedding-adjacent | `llm.py` — key rotation `GEMINI_API_KEY_1..9`, quota tracking RPD/RPM/TPM, runtime config `llm_config` |
| OpenRouter | web search fallback (`web_search.py`) + chatbotv3 ทั้งหมด | `OPENROUTER_API_KEY(_1..9)`, models ผ่าน `llm_config`/env |
| AI Usage Hub | log token/cost ทุก call (fire-and-forget) | `AI_USAGE_HUB_URL` + `AI_USAGE_HUB_TOKEN` |
| ChatAdminWeb internal API | handoff endpoint | `ADMIN_HANDOFF_URL` + `CHATBOT_INTERNAL_SECRET` |
| SSO องค์กร | login admin (Next.js `/api/auth/sso/*`) | JWT `ADMIN_JWT_SECRET`, cookie `cc_session` |
| sellcenter (ภายใน) | mirror แชท Shopee → Mongo | ไม่มี API call จาก bot — อ่าน DB อย่างเดียว |
| Resend | email (ถ้าใช้) | `RESEND_API_KEY`/`RESEND_FROM_EMAIL` |

**ข้อห้าม:** ไม่มีการ call Shopee/TikTok/Lazada API ตรงจาก bot หรือ admin — ไม่ส่งข้อความจริงให้ลูกค้า (คำตอบทั้งหมด → `shadow_replies`)

---

## 5. กระบวนการทำงานของ Chat Pipeline

### 5.0 API contract

`POST /chat` — header `X-Internal-Secret` → `chat(req: ChatRequest) → ChatResponse`

**ChatRequest fields:** `message` (จำเป็น) · `shop` · `item_id` (การ์ดสินค้าที่ส่งมา) · `order_sn` (การ์ด order) · `history[]` (`{role, text, images[], image_desc}`) · `limit` (1-50, default 10) · `images[]` (≤3 รูป/turn) · `conversation_id` · `platform` · `simulate_assignment` (test/shadow) · `ticket_state` (`open|closed|handoff|resolved|pending`) · `use_v2`/`use_v3` (override engine) · `llm_context_limit` (10-50)

**ChatResponse fields:** `answer` · `answer_segments[]` (split `|||`) · `products[]` (cards) · `shop` · `model` · `source` · `chat_engine` (`legacy|v2|v3`) · `usage{prompt,output,total}` · `elapsed` · `cost` · `handoff_to_admin`/`handoff_reason`/`handoff_claim` · `intent` · `timing` · `retrieval_info` · `web_search_used`/`web_search_reason`/`web_search_model` · `image_desc` (cache ให้ turn ถัดไป) · `steps[]` (per-stage breakdown) · `routing_decision{path, reason, …}`

`ChatResponse.model_post_init` เรียก `guards.check_output` (observe-only log) เสมอ; `chat()` เรียก `guards.enforce` (อาจแก้/escalate) ครอบทุก engine

### 5.1 Engine routing

```
POST /chat → _require_internal_secret → chat(req)
  → _chat_impl(req)
      ├─ req.use_v3 | USE_CHAT_V3=1          → chatbotv3.engine.chat_v3(req)
      ├─ req.use_v2 | USE_LEGACY_CHAT!="1"   → chat_v2.chat_v2(req)
      └─ else                                → legacy pipeline (§5.2)
  → guards.enforce(resp, req) → ChatResponse
```

### 5.2 Legacy pipeline (`_chat_impl`) — ลำดับจริง

| # | Stage | Trigger / guard | ทำอะไร |
|---|---|---|---|
| 1 | RouteContext | always | `route_context.resolve_route` — normalize message ด้วย `typo_dict.json` |
| 2 | Vision pass | `req.images` หรือ history images ที่ยังไม่มี `image_desc` | `llm.describe_images` (≤`BOT_MAX_IMAGES_PER_TURN`) → `vision_context` |
| 3 | Item-tag | `[สินค้า: N]`/`[item: N]` | fetch การ์ด anchor — **ITEM-TAG shortcut** ตอบจาก anchor เดี่ยว; เว้น compare/superlative + timeline ≥2 → fall through; `_SINGLE_ITEM_REF_KW` กันกลับ |
| 3.5 | Image anchor | `_image_desc_out` + ไม่มี item-tag/anchor + ข้อความไม่มี model kw | `extract_model_keywords(image_desc)` → item_name regex → **match ตัวเดียวเท่านั้น** → set `_hybrid_anchor_card` (NEW-6; desc กำกวม match หลายตัว → ปล่อย flow ปกติ) |
| 4 | Pre-intent handoff | `handoffs.detect_human_request` kw | `_send_handoff(reason=human_request)` |
| 5 | Order early flow | order_sn/tracking/return-refund detect | `order_flow.early_order_flow` → lookup + anchor + (received-verb+problem → handoff, guard "ไหม/เหรอ") → เขียน `ctx.order_sn`/`is_claim_request_pre` |
| 6 | Warranty | order_sn จากข้อ 5 หรือ claim detect | `warranty.auto_check_delivery_warranty` → `warranty_flow.handle_warranty_flow` (SM State 0-7 — ตารางด้านล่าง) |
| 7 | Intent (Pass 1) | `should_run_pass1` (skip clear case) | `intent_classifier.classify_intent` → intent dict |
| 8 | Post-intent handoffs | tax invoice / cert question | `handoffs.post_intent_handoffs` → tax→handoff; cert→`search_cert_products` |
| 9 | General question | `knowledge_base.detect_general_question` | `build_general_context` → `answer_general`; ยกเว้น warranty/return policy + follow-up สั้น → ไปขั้น 11+ |
| 10 | Brand question | `_detect_brand_question` | `_build_brand_context` (shop-scoped ก่อน) → `answer_general` |
| 11 | CONV-ACTIVE anchor | `conversation_products.resolve_active_by_message` + `get_previous_anchor` + `get_latest_suggestion_batch` | comparison ctx (`_anchor_compare_ctx`), partial comp, superlative; pin เดี่ยวถูกปิดเมื่อมี compare ctx |
| 12 | Model-regex pre-filter | model kw ≥4 chars ใน message | Mongo regex บน `item_name` ก่อน vector |
| 13 | KB + Mongo merge | `knowledge_base.lookup_kb` | `_merge_kb_mongo` (KB card ก่อน + dedupe) |
| 14 | Product retrieval | always (ถ้าไม่ return ก่อน) | `product_store.fetch_products` — `USE_UNIT_INDEX` → `units.fetch_unit_cards`; ไม่ก็ hybrid listing path (ตารางด้านล่าง) |
| 15 | Device compat | intent=compatibility_check หรือ target_device ชัด | `device_compat._device_spec_lookup` → `_filter_compat_products` → `_apply_product_tiers` |
| 16 | Availability marking | always | `_available_for_sale = status=="NORMAL" && !sold_out && stock>0` + `_context_note` ห้ามเสนอขายตัวไม่พร้อม (ตอบ spec/ประกันได้) |
| 17 | Tier merge + dedupe | always | `_dedupe_products` (base-name → best sellable) + tier merge |
| 18 | Web search fallback | `should_use_web_search` (skip เมื่อ spec-db grounded) | `search_and_extract` → keywords re-query → `reanswer` (strip URLs) |
| 19 | Answer | always | `llm.answer` (products+persona+vision+compat+search ctx) → `_append_base_warranty` |
| 19.5 | Card suppress | intent ∈ {warranty_claim, general_question, other} + ข้อความไม่มี `_PRODUCT_MENTION_KWS` | `products_for_response=[]` — กันการ์ดมั่วบน greeting/complaint/claim (NEW-7); ใช้ทั้ง path ปกติและ web-search branch |
| 20 | Record suggestions | เมื่อแนะนำสินค้า | `_record_suggestion_products` → timeline (3 callsites) |
| 21 | Guard | always | `guards.enforce` ที่ `chat()` |

**`fetch_products` hybrid path (ภายใน):**

```
USE_UNIT_INDEX=1|charger → units.fetch_unit_cards → empty/err → listing path
listing path:
  type regex ชัด → mongo item_name regex filter
  ไม่ชัด → vector_search (npz) → ว่าง → legacy regex fallback
  → _filter_charger_subtype (name-level) → _filter_false_positives
  → ว่าง → relax price → relax item-name → catalog category fallback
  → _rerank_by_promo_latest / _rerank_with_diversity → _dedupe_products → to_product_card
```

**Charger subtype resolution:** nested `_resolve_charger_subtype` ใน `_chat_impl` — anchor > intent > message; subtype ชัดใหม่ทับ carry-forward; charging-spec question ("X ชาร์จกี่วัตต์") → ไม่กรอง X เป็น charger

**Warranty claim state machine (State 0-7):**

| State | เงื่อนไข | ทำอะไร |
|---|---|---|
| 0 | `detect_claim_request` หรือ auto-check บอกในประกัน | เริ่มเก็บ slots (order/date/name/phone/addr), `stage=collecting` |
| 1 | บอทเคยตอบ "รับประกัน X ปี" | ลูกค้าอาจขอเคลม → เริ่ม flow |
| 2 | บอทเคยถามวันที่ซื้อ | parse วันที่ → `is_in_warranty` → ใน/นอกประกัน |
| 3 | บอทเคยถามชื่อ/เบอร์ | `extract_customer_info` (NER+regex) → merge slots |
| 4 | บอทเคยทวนข้อมูล | `detect_confirmation` → handoff พร้อม claim payload |
| 5 | บอทเคยบอกนอกประกัน | สนใจปรึกษาแอดมิน → handoff |
| 6 | post-handoff | บอทเงียบจน `ticket_state=="closed"`; exceptions จาก `shop_settings` |
| 7 | เคยขอข้อมูล/รูป | รับรูป/วิดีโอเป็น evidence → merge slots |

### 5.3 chat_v2 (`chat_v2.chat_v2`) — 8 stages

| Stage | ฟังก์ชัน | ทำอะไร |
|---|---|---|
| 1 | `_build_context` + `_run_vision` | DB + history + persona + vision → ctx dict |
| 2 | `_check_deterministic` | order → tracking → tax invoice → human → warranty SM → general Q ⚠️ → brand Q (⚠️ `_check_general_question` เรียก `knowledge_base.get_general_context` ที่ไม่มี — ใช้ `build_general_context` — AttributeError = 500; ดู §10#1) |
| 3 | `_classify_intent` | `intent_classifier` + `is_superlative`/`is_charging_spec`/`multi_usecase`/`wattage`; charging-spec → override `product_spec` |
| 4 | `_detect_anchor` | tag (req→message→history) → card + subtype-mismatch + compat detect (⚠️ `_cp.add_item_anchor` ไม่มี → no-op) |
| 5 | `_retrieve_products` | anchor augment + compat retrieval + follow-up (⚠️ `_cp.get_timeline` ไม่มี → no-op) + model-regex + KB→Mongo + `fetch_products` + anchor merge + `_rerank_products` + `_filter_unavailable_products` (เฉพาะ recommend/search intent) |
| 6 | `_search_if_needed` | trigger: products=0 หรือ compat+target_device → `search_and_extract` → re-query → merge + `_strip_urls` |
| 7 | `_no_product_guard` | ยังว่างหลัง search → handoff `no_product_found` |
| 8 | `_build_answer` → `_make_response` | `llm.answer` + hints → uniform ChatResponse dict |

### 5.4 chatbotv3 (`chatbotv3.engine.chat_v3`)

| # | ทำอะไร |
|---|---|
| 1 | `rich_parse.parse_rich_message` → item_id/order_sn/tracking/image/placeholder (placeholder ลอย → ตอบรับสั้น) |
| 2 | deterministic safety: `warranty.detect_claim_request` → handoff `warranty_claim_detected`; `emotion.detect_negative_emotion` → handoff `customer_negative_emotion`; `emotion.detect_human_request` → handoff `human_request` — ยิง `POST bot-handoff` จริงทุกอัน |
| 3 | context: `product_match.get_shop_products_summary` (≤30 ชิ้น + `description_excerpt` ≤500 ตัวอักษร) + item card (ถ้ามี item_id) + `order_store.lookup_order` + persona |
| 4 | `system_prompt.build_system_instruction` = `llm.SYSTEM_INSTRUCTION` + `_V3_RULES` (shop isolation, ห้ามแต่งลิงก์, compat rule ต้องเช็คจาก "รายละเอียด", ห้ามสัญญาแทนคน) |
| 5 | `or_client.call_or` — `MODEL_VISION` เมื่อมีรูป (multimodal ตรง ไม่มี vision pass แยก) ไม่ก็ `MODEL_LLM2`; image URL ผ่าน SSRF guard; user text ≤2000 chars |
| 6 | `product_match.match_products` — สกัดชื่อสินค้าจากคำตอบ (bold/link/alt/bullet) → regex `item_name` longest-token ใน `ShpProducts` (shop-scoped) → `to_product_card` |
| 7 | `_make_answer_response` — segments `|||`, `chat_engine:"v3"`, steps, usage/cost |

**v3 ไม่มี:** unit index, `device_compat` spec-db, warranty SM (มีแค่ detect→handoff), cert search, order early-flow — LLM-first + deterministic safety เท่านั้น

### 5.5 Output guard (`guards.enforce`)

ด่านสุดท้ายของทุก engine ที่ `chat()`: `build_flags(resp, req)` (ลิงก์ภายนอก/คำตอบหลุด policy/ยืนยันเคลมโดยไม่ handoff) → `check_output` → `_escalate` (handoff เมื่อจำเป็น) — แยกจาก `ChatResponse.model_post_init` ที่ observe-only log

**Rewrite tier (T7+):** ถ้าไม่ escalate — claim ที่ **ungrounded** (ไม่มีหลักฐานใน `resp.products` desc/flags หรือ `routing_decision.grounding_text`) → `_replace_clause` แทนทั้ง clause ด้วยข้อความขอแอดมินตรวจสอบ; ข้าม source ที่ context เป็น policy/order data อยู่แล้ว (`_REWRITE_SKIP_PREFIXES`) — ยกเว้น `general:*` ที่แนบ `grounding_text` (KB context) มาให้ verify ได้; กัน negation ด้วย lookbehind + polarity window ("ไม่รับคืน" ไม่ ground "เปลี่ยนได้"); rules re-scan จนสะอาด (≤4 รอบ)

- `promo_claim` — ของแถม/โปร/ลด/ส่งฟรี/`แถม<noun>` ที่ context ไม่มีหลักฐานบวก
- `return_claim` — "เปลี่ยนได้/คืนได้" เมื่อ context ไม่อนุญาต (รวม KB ที่ห้ามชัด)
- `stock_claim` (BUG-K) — "พร้อมส่ง/เช็คสต็อกแล้ว/มีของ" เมื่อไม่มี card `_available_for_sale`
- `model_claim` (NEW-6 residual) — model token `UPPERCASE≥2+digits≥2` ที่ไม่อยู่ใน context pool เลย = LLM แต่งรุ่น; boundary ASCII lookaround (ทำงานใน text ไทยติดกัน); stoplist spec tokens (IP66/PD65W/WiFi6)

### 5.6 PRODUCT_TYPES taxonomy + charger subtypes

`product_store.PRODUCT_TYPES` = tuple ของ `(type_name, keywords[], item_name_regex)` — **~105 types**: phone, smartwatch, powerbank, charger, case, earphone, speaker, memory_card, screen_protector, fan, selfie_stick, mobile_wifi, camera, projector, vacuum, massager, soundbar, scale, gps_tracker, inverter, microphone, flash_drive, air_filter, car_accessory, car_charger, wireless_charger, desktop_charger, smart_socket, battery, air_purifier, humidifier, smart_lamp, smart_lock, smart_bin, hair_dryer, shaver, nose_trimmer, blackhead_cleaner, toothbrush, water_purifier, pet_feeder, fish_tank, exercise_bike, walking_pad, skateboard, stroller, air_pump, dashcam, alcohol_tester, keyboard, mouse, ram, ssd, air_fryer, coffee_machine, kettle, oven, grill, cloth_dryer, garment_steamer, spray_mop, sofa_cleaner, ems_massager, car_seat, makeup_mirror, mini_razor, voucher, rice_cooker, hair_clipper, tv_box, blender, stylus, bag, shoes, stationery, gamepad, electric_bike, scooter, clothing, sunglasses, cap, mask, luggage, nail_polisher, pet_bowl, pet_bed, pet_odor_eliminator, monitor_light, dental_flusher, home_theater, ultrasonic_cleaner, video_capture, fitness_gear, nightlight, coffee_capsule, facial_brush, shoe_wrapping_machine, dock, green_screen, solar_panel, webcam, wifi_extender, dust_bag, tpms, cat_litter_box — filter ทำที่ `item_name` เพราะ Shopee category กว้าง

**Charger subtypes** (`_detect_charger_subtype`): `adapter` (หัวชาร์จ) · `cable` (สาย) · `set` (ชุด) · `car_charger` · `wireless` · `desktop` (แท่น) · `socket` (เต้ารับ) — `_CHARGER_FORMS` = {car_charger, wireless_charger, desktop_charger, dock} ใช้เป็นเส้นแบ่ง class ใน `_charging_scope`

**Intent labels** (`intent_classifier`): `product_recommend`, `product_spec`, `product_search`, `compatibility_check`, `warranty_claim`, `return_policy`, `tax_invoice`, `general_question`, `other` + fields `product_type`, `charger_subtype`, `target_device`, `device_connector`, `device_min_watt`, `confidence`, `needs_description`, `general_qtype`

**Cert search sources** (`search_cert_products`): 4 แหล่ง — (1) `description` regex prefilter + python verify (boundary กัน CE ใน word/GB ใน capacity) (2) `image_texts` OCR (3) `itStock.Products` cert flags (join `shopee_ship_box`) (4) variant/version tokens — certs: TISI/มอก., CE, CCC, FCC, RoHS, GB

**Dedupe scorecard** (`_dedupe_products` → `_dedupe_sell_score`): เลือก listing ที่ดีสุดต่อ normalized base name — `status=="NORMAL"` → `!sold_out` → stock มาก → มี promo → ราคาต่ำสุดต่ำกว่า

---

## 6. รายการฟังก์ชันทั้งหมด

> **รูปแบบ 8 ช่อง:** `ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error`
> `—` = ไม่มี/ไม่สำคัญ · `↳` = nested function · DB = MongoDB

### 6.1 `app.py` — FastAPI entry + legacy orchestrator

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_require_internal_secret` | middleware auth | request, call_next | response / 401 | — | FastAPI (ทุก request) | เทียบ `X-Internal-Secret` กับ env | 401 เมื่อไม่ตรง |
| `_warmup` | startup warm | — | — | embedding._get_model, product_store._load_vector_store, mongo ping (product+admin) | FastAPI startup | preload model/npz + ping DBs | stderr log |
| `ChatMessage` | pydantic: history row | role, text, images[], image_desc | — | — | ChatRequest | schema | — |
| `ChatRequest` | pydantic: request | ดู §5.0 | — | — | chat() | schema + defaults | — |
| `ChatResponse` | pydantic: response | ดู §5.0 | — | guards.check_output | chat() | `model_post_init` → observe-only guard log | log stderr |
| `FeedbackRequest` | pydantic: feedback | answer, rating | — | — | feedback() | schema | — |
| `_db` | product DB handle | — | (client, db) | product_store.get_client | routes, _chat_impl, chat_v2._build_context | **shared singleton — ห้าม close() ใน handler** (issue #17) | — |
| `_shutdown_db_clients` | `app.on_event("shutdown")` | — | — | get_client().close, _build_admin_client().close | FastAPI shutdown | ปิด singleton ตอน process จบเท่านั้น | — |
| `_get_post_handoff_exceptions` | shops ยกเว้น post-handoff silence | shop, platform | list[str] | admin DB `shop_settings` | warranty post-handoff path | อ่าน config ต่อร้าน | DB read; error→[] |
| `health` | `GET /health` | — | dict | _db, product_store counts | HTTP | ping + counts; **ไม่ close client** | error→dict fail |
| `index` | `GET /` | — | HTMLResponse | static/index.html | HTTP | serve info page | — |
| `shops` | `GET /shops` | — | list | _db, product_store.list_shops | HTTP | distinct shopname | — |
| `categories` | `GET /categories` | — | list | _db, product_store.list_categories | HTTP | distinct cat | — |
| `brands` | `GET /brands` | pagination | dict | _db, re, Counter | HTTP | brand count paginated | — |
| `feedback` | `POST /feedback` | FeedbackRequest | dict | — | HTTP | log thumbs | — |
| `_extract_item_id_tag` | parse item tag | text | item_id/None | `_ITEM_TAG_RE` | _chat_impl | `[สินค้า: N]`/`[item: N]` | — |
| `_general_qtype_bypass` | กัน general path กลืน follow-up | qtype, message | qtype/None | — | _chat_impl | ถ้า qtype เป็น warranty/return + ข้อความสั้นมี history → ปล่อยผ่าน | — |
| `_add_context_note` | แนบ note เข้า cards | products, note | — | — | _chat_impl | set `_context_note` ทุก card | mutate list |
| `_recent_qa_pairs` | ดึง QA pairs จาก history | history, n=10 | list[dict] | — | _chat_impl, KB ctx | pair user/model turns | — |
| `chat` | **`POST /chat` entry** | ChatRequest | ChatResponse | _chat_impl, guards.enforce | FastAPI | route engine → enforce | guard อาจ escalate |
| `_chat_impl` | **legacy orchestrator** | ChatRequest | ChatResponse | ทุกโมดูล (§5.2) | chat() | pipeline 21 ขั้น | writes: conversation_products, handoff POST, usage; RuntimeError→HTTPException 500; ⚠️ client.close() บน shared client (§10#2) |
| ↳ `_resolve_charger_subtype` | subtype resolution | message, intent, anchor, ctx | subtype str | product_store._detect_charger_subtype | _chat_impl | anchor > intent > message; carry ยกเว้น subtype ชัดใหม่ | — |
| ↳ `_extract_charger_constraints` | spec constraints | text | dict | regex | _chat_impl | parse "≥45W"/"20000mAh"/น้ำหนัก | — |
| ↳ `_is_good_keyword` | keyword quality | w | bool | stoplist | _chat_impl (search requery) | กรองคำกว้าง | — |
| ↳ `_extract_max_mah`/`_extract_weight` | sort helpers | p | float | regex | _chat_impl | สกัด mAh/น้ำหนักจาก card | — |
| `_record_suggestion_products` | บันทึก suggestion batch | req, products | — | conversation_products.add_product | _chat_impl (×3) | เขียน suggestion entries ลง timeline | Mongo write; error→log |
| `_append_base_warranty` | ต่อท้ายประกันมาตรฐาน | answer, message, source | str | knowledge_base.get_base_warranty_text | _chat_impl, chat_v2._build_answer | append เมื่อถามประกัน | — |
| `_merge_kb_mongo` | merge KB+mongo cards | kb_docs, mongo_products | list[card] | ↳`_norm`, knowledge_base._kb_doc_to_card | _chat_impl | KB ก่อน + dedupe normalized name | — |
| ↳ `_norm` | normalize name | s | str | regex | _merge_kb_mongo | — | — |
| `_detect_brand_question` | alias → kb | message | str/None | knowledge_base | chat_v2._check_brand_question | module-level alias | — |
| `_build_brand_context` | alias → kb | db, brand, shop_filter | dict/None | knowledge_base | chat_v2._check_brand_question | alias | — |

### 6.2 `llm.py` — Gemini client + prompts + cost/key/quota

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_gemini_cost` | cost USD | prompt_tokens, output_tokens | float | `_GEMINI_COST_PER_M` | _record_tokens, callers | rate/1M | — |
| `_error_reply` | ข้อความ error สุภาพ | exc, where | str | — | answer paths | mask exception เป็นข้อความกลาง | — |
| `_strip_kb_markup` | ลบ markup KB | text | str | regex | KB paths | strip `[[ ]]`, `*** ***`; markdown table แถว `| a | b |` → `• a: b · c: d` (Shopee render ตารางไม่ได้); collapse space กลางประโยค ("ทางร้าน จะ"→"ทางร้านจะ"); normalize run ของ pipe ≥2 (`||`/`||||`) → ` ||| ` (issue #19 — กัน LLM พิมพ์ตัวคั่น bubble ผิด) | — |
| `_lang_instruction` | กฎภาษา | message | str | — | answer builders | ไทยเสมอ เว้นขอภาษาอื่น→อังกฤษ | — |
| `_load_api_keys` | โหลด keys | env | list[str] | os.environ | module init | `GEMINI_API_KEY_1..9` + single | — |
| `get_llm_config` | runtime config | — | dict | admin mongo `system_configs` (`llm_config` doc) | getters ทั้งหมด | TTL 10s + `max_time_ms` 1500 + fail-stale | DB read; miss→env fallback |
| `_master_key` | AES key | — | bytes/None | `LLM_MASTER_KEY` env | _dec_secret | 64-hex หรือ passphrase→sha256 | — |
| `_dec_secret` | ถอดรหัส secret | v (str) | str | _master_key | get_key_pool, _active_keys | `enc:v1:iv:tag:ct` hex → AES-256-GCM; plaintext ผ่านตรง | ถอดไม่ได้→"" (skip key) |
| `get_key_pool` | key pool จาก config | field | list[str] | get_llm_config, _dec_secret | _active_keys, web_search | รองรับ string / `{name,value,enabled}`; enabled=false ไม่หมุน | — |
| `_active_keys` | effective key set | — | list[str] | get_key_pool, env | _next_api_key | ตาม `key_source.gemini`: env/single/db (default db) | fallback env |
| `get_provider` | provider ต่อ role | role | str | get_llm_config | _generate | roles: chat/vision/intent/openrouter_search | env fallback |
| `get_model` | model ต่อ role | role | str | get_llm_config | _generate, callers | เช่น chat→`GEMINI_MODEL` | env fallback |
| `_next_api_key` | round-robin key | — | str | _active_keys | _client, _generate | cycle ข้าม key เกิน quota | RuntimeError เมื่อหมด |
| `_client` | genai client | — | Client | _next_api_key | describe_*, answer_* | client ต่อ key (กัน shared-transport closed bug) | — |
| `_load_quota_day` | โหลด quota counter | — | dict | json file | _day_used, _acquire | day-reset | file read |
| `_save_quota_day` | persist quota | — | — | json file | _record_tokens | — | file write |
| `_day_used` | usage วันนี้ | model | int | _load_quota_day | _acquire | — | — |
| `_acquire` | เลือก key ใต้ quota | model, est_tokens | key str | _day_used, RPD/RPM/TPM env | _generate | skip key เกิน limit | RuntimeError quota หมด |
| `_record_tokens` | นับ usage | model, resp | — | _gemini_cost, _save_quota_day | _generate | update counters | file write |
| `_or_messages` | Gemini contents→OR messages | contents, config | list[dict] | — | _openrouter_generate | role map + flatten | — |
| `_openrouter_generate` | call OpenRouter | model, contents, config | (text, resp) | urllib POST, _or_messages | _generate | ใช้เมื่อ provider=openrouter | HTTP error→raise |
| `_generate` | **unified generation** | model, contents, config, est_tokens | (text, usage) | _acquire, _client/_openrouter_generate, _record_tokens | answer*, intent_classifier | Gemini SDK หรือ OR → usage dict | RuntimeError เมื่อทุก key fail |
| `split_segments` | multi-bubble split | answer | list[str] | — | _make_response(v2), engine v3, app | split `|||`, strip | — |
| `_build_context` | product context block | products, shop_hint, options | str | card fields | answer() | serialize cards + `_context_note` + availability flags | — |
| `describe_image` | vision 1 ไฟล์ | url, shop_hint, history_context | (text, usage) | urllib fetch, _client, types.Part.from_bytes | describe_images | bytes→Part; video suffix→180s + video prompt; MIME จาก Content-Type+suffix; `_VISION_PROMPT` กัน hallucination | net fetch; error→("",{}) |
| `describe_images` | vision หลายไฟล์ | urls, shop_hint, max_images, history_context | (text, usage) | describe_image | _run_vision (v2), _chat_impl | loop ≤max, label `[รูป/วิดีโอที่ N]` | — |
| `answer` | **ตอบหลักจาก products** | message, products, shop_hint, history, persona_extra, intent_result, extra_context | (answer, usage) | _build_context, _lang_instruction, _generate | _chat_impl, chat_v2._build_answer | SYSTEM_INSTRUCTION + ctx + hints → LLM | RuntimeError→caller raise 500 |
| `answer_with_kb` | ตอบจาก KB | message, kb_context, history, persona_extra | (answer, usage) | _generate, `KB_SYSTEM_INSTRUCTION` | KB path | RAG over KB | — |
| `answer_general` | ตอบ policy/brand/order | message, context, qtype, history, persona_extra, shop_hint | (answer, usage) | _generate | order/general/brand paths | qtype-specific prompt — ทุก qtype: ตอบคำถามเฉพาะจาก context ก่อน ห้าม dump list ดิบ/ห้ามตอบ bare "ทักแอดมิน" เมื่อ context ตอบได้ (NEW-8) | RuntimeError→caller 500 |

### 6.3 `product_store.py` — retrieval/ranking/cards/certs/dedupe

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_load_vector_store` | โหลด npz | — | dict/None | np.load + mtime check | vector_search | cache + auto-reload เมื่อไฟล์เปลี่ยน | file read; miss→None |
| `vector_search` | semantic search | query, limit, filters | docs | embedding.embed_query, _load_vector_store | fetch_products | cosine top-k over npz | npz missing→[] |
| `build_connection_string` | mongo URI | env MONGO_* | str | — | get_client | URI หรือ host+creds | — |
| `get_client` | mongo client | — | MongoClient | build_connection_string | ทุก query | cached singleton (⚠️ ห้าม close — §10#2) | — |
| `_to_serializable` | BSON→JSON | value | any | — | cards/export | ObjectId/date convert | — |
| `_warranty_info` | warranty extract | doc | dict | warranty helpers | to_product_card | parse warranty field/name | — |
| `_price_range` | min-max price | doc | dict | models[] | to_product_card | — | — |
| `_first_image_url` | รูปแรก | doc | str | — | to_product_card | — | — |
| `_clean_description` | trim/filter desc | desc, message | str | section markers | to_product_card | intent-aware section pick | — |
| `_shopee_stock` | live stock join | model_doc | int | stock DB | to_product_card, build_sellable_units | `shopee_ship_box` → itStock | DB read |
| `_doc_sellable` | sellable check | doc | bool | status/stock fields | fetch, _dedupe_sell_score | NORMAL && !sold_out && stock>0 | — |
| `to_product_card` | doc→card มาตรฐาน | doc, message | dict(card) | _warranty_info, _price_range, _first_image_url, _clean_description, _shopee_stock | ทุก retrieval path, product_match | uniform card + `_available_for_sale` | — |
| `_extract_product_name_tokens` | tokenize name | name | list[str] | regex | fuzzy_match_products | — | — |
| `fuzzy_match_products` | fuzzy name match | docs/message | list | _extract_product_name_tokens | fallback retrieval | token overlap score | — |
| `_detect_intent` | intent kw → filter hints | message | set[str] | kw tables | build_query | — | — |
| `_extract_price_range` | ช่วงราคาจากข้อความ | message | (min, max) | regex | build_query | "ไม่เกิน X"/"X-Y บาท" | — |
| `_detect_shops` | shop detect | message | list[str] | shop table | build_query | — | — |
| `_detect_brands` | brand detect | message | list[str] | brand table | build_query | — | — |
| `_detect_categories` | category detect | message | list[str] | cat table | build_query | — | — |
| `_detect_product_types` | type detect (strict) | message | set[str] | `PRODUCT_TYPES` (kw + name_regex) | fetch_products, app, chat_v2, units | item_name-level — Shopee cat กว้าง | — |
| `_detect_charger_subtype` | charger subtype | text | str/None | subtype kw table | fetch, app, chat_v2, units | adapter/cable/set/car_charger/wireless/desktop/socket | — |
| `_filter_charger_subtype` | กรองตาม subtype | docs, subtype | docs | item_name regex | fetch_products | name-level filter | — |
| `_detect_product_types_fuzzy` | type detect (fuzzy) | message | set[str] | typo-tolerant match | fetch_products, chat_v2 | fallback เมื่อ strict ว่าง | — |
| `_product_type_categories` | type→cat list | types | list[str] | mapping table | build_query | — | — |
| `_product_type_regex` | type→regex | types | str/None | name_regexes | build_query | — | — |
| `build_query` | mongo filter compose | message, opts | dict | detectors ทั้งหมดข้างบน | fetch_products | type/cat/brand/shop/price | — |
| `_has_active_promotion` | promo flag | doc | bool | promo fields | _rerank_by_promo_latest, _dedupe_sell_score | — | — |
| `_get_recency_score` | recency | doc | float | date fields | _rerank_by_promo_latest | — | — |
| `_is_bundle_product` | bundle detect | doc | bool | kw/fields | ranking | — | — |
| `_rerank_by_promo_latest` | promo+recency sort | docs | docs | above | fetch_products | — | — |
| `_extract_model_tokens` | model codes | message | list[str] | _raw_model_tokens + collapse | fetch, rerank | ≥2 tokens only | — |
| `_raw_model_tokens` | model codes (all) | message | list[str] | regex | _extract_model_tokens, vector augment/promote | ทุก token รวมรุ่นเดียว | — |
| `_model_token_regex_str` | bounded pattern | token | str (PCRE) | escape + \s* + lookaround | _model_token_in_name, app.py regex paths | space-insensitive + alnum boundary | — |
| `_model_token_in_name` | bounded match | name, token | bool | _model_token_regex_str / nospace substr | fetch_products, conversation_products, app.py, knowledge_base | code→bounded; pure alpha/digit→substring เดิม | — |
| `_doc_matches_model` | doc↔token match | doc, model_token | bool | _model_token_in_name | fetch_products | — | — |
| `_rerank_with_diversity` | spread results | docs | docs | — | fetch_products | กระจาย shop/brand | — |
| `_filter_false_positives` | กรองตัวหลอก | docs, types | docs | type regexes | fetch_products | python-side verify หลัง mongo | — |
| `fetch_products` | **main retrieval** | db, message, shop_filter, limit, desc_message, is_compat_check, skip_charger_subtype, product_types_override, charger_subtype_override, filter_unavailable | list[card] | units.fetch_unit_cards (flag), vector_search, build_query, _filter_*, _rerank_*, _dedupe_products, to_product_card | _chat_impl, chat_v2, product_match | §5.2 fetch path — compat bypass unit pool; empty/error→fallback | mongo reads; error→[] |
| `fetch_product_by_id` | ดึงตาม item_id | db, item_id, shop_filter | doc/card | coll.find_one | anchor paths, product_match.get_product_by_id | exact id + shop scope | — |
| `list_shops` | รายชื่อร้าน | db | list[str] | distinct | /shops route | — | — |
| `list_categories` | รายหมวด | db | list[str] | distinct | /categories route | — | — |
| `_has_tisi` | TISI detect | text | bool | regex | cert paths | มอก./TISI boundary | — |
| `_extract_match_context` | context window | text, pattern, window | str | regex | cert extract | ตัดบริบทรอบ match | — |
| `_extract_tisi_context` | TISI context | text, window | str | _extract_match_context | cert paths | — | — |
| `_has_cert` | cert detect ทั่วไป | text, certs tuple | str/None | boundary regex | search_cert_products | กัน CE ใน word / GB ใน capacity | — |
| `_stock_products_coll` | stock coll handle | — | coll | STOCK_* env | _variant_cert_hit, cert join | `itStock.Products` | — |
| `_variant_cert_hit` | cert ใน variant name | option_name, certs | str/None | _has_cert | search_cert_products | version tokens | — |
| `_admin_image_texts_coll` | OCR coll handle | — | coll | ADMIN_MONGO_* | search_cert_products | `image_texts` | — |
| `_doc_stock_total` | sum stock | doc | int | models[] | sellable checks | — | — |
| `_name_matches_types` | name↔type check | name, type_filter | bool | type regexes | search_cert_products | — | — |
| `search_cert_products` | **cert search** | db, message, shop, certs, type_filter | list[card] | mongo prefilter + _has_cert verify + _stock_products_coll + _variant_cert_hit + _admin_image_texts_coll | cert path (handoffs/app) | 4 แหล่ง: desc + OCR + itStock flags + variant tokens; type_filter กรองหมวด | mongo reads |
| `search_tisi_products` | TISI wrapper | db, message, shop | list[card] | search_cert_products | TISI path | certs=("tisi","มอก") | — |
| `_dedupe_base_name` | normalize ชื่อเทียบ | name | str | regex | _dedupe_products | ตัดสี/ขนาด/variant | — |
| `_dedupe_sell_score` | score เลือก listing | p (card) | tuple | _doc_sellable, _has_active_promotion, price | _dedupe_products | NORMAL > !sold_out > stock > promo > ราคาต่ำ | — |
| `_dedupe_products` | dedupe listings | products, log_label | list | _dedupe_base_name, _dedupe_sell_score | fetch_products, app merge | best ต่อ base name | mutate order |
| `_type_query_word` | type→query word | type_name | str | map | shop_capability_line | — | — |
| `_shop_type_counts` | นับ type ต่อร้าน | db, shop | dict | coll count + types | shop_capability_line | — | mongo count |
| `shop_capability_line` | บรรทัดสรุปร้าน | db, shop | str | _shop_type_counts, _type_query_word | _chat_impl context | "ร้านนี้มี X n ตัว…" | — |

### 6.4 `intent_classifier.py` — Pass-1 LLM intent

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `classify_intent` | LLM จำแนก intent | message, history, shop | dict{intent, product_type, charger_subtype, target_device, device_connector, device_min_watt, general_qtype, confidence, needs_description, usage} | llm._generate (intent model) | _chat_impl, chat_v2._classify_intent | prompt → JSON parse → normalize labels | error→{} (ไม่ block pipeline) |
| `should_run_pass1` | gate ข้าม intent | message, claim_detected, product_types, has_warranty_history | bool | — | จุดเรียก classify_intent | clear-case rules → skip LLM (ประหยัด) | — |

### 6.5 `knowledge_base.py` — KB/RAG/QA/brand/policy

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_load_env` | โหลด env | — | — | dotenv | module init | — | — |
| `get_base_warranty_text` | ข้อความประกันมาตรฐาน | — | str | KB/config | app._append_base_warranty | อ่าน warranty_policy | — |
| `is_warranty_question` | detect ถามประกัน | message | bool | kw table | app/flows | — | — |
| `_build_admin_client` | admin mongo client | env ADMIN_MONGO_* | MongoClient | — | _admin_db | — | — |
| `_admin_db` | admin db handle | — | db | _build_admin_client | KB getters | cached | — |
| `_kb_coll` | `knowledge_base` coll | — | coll | _admin_db | KB queries | — | — |
| `_kb_products_coll` | `knowledge_base_products` coll | — | coll | _admin_db | search_kb_by_model | — | — |
| `_kb_qa_coll` | `knowledge_base_qa` coll | — | coll | _admin_db | QA search | — | — |
| `detect_general_question` | policy topic detect | message | qtype/None | kw tables | _chat_impl, chat_v2._check_general_question | warranty_policy/return_policy/shipping/brands/categories/… | — |
| `detect_topic` | subtopic detect | message | str/None | kw | general paths | — | — |
| `is_target_device_kw` | kw เป็น device ไหม | kw | bool | device vocab | extraction | — | — |
| `extract_model_keywords` | สกัด model kw | message | list[str] | regex + brand tables + stoplist | retrieval, KB, app | กรองคำทั่วไป/brand-only | — |
| `search_kb_by_model` | KB search หลาย kw | message, limit | list[doc] | _search_kb_single (loop) | lookup_kb | per-kw search merge | — |
| `_search_kb_single` | KB search kw เดียว | message, limit | list[doc] | _kb_products_coll + vectors | search_kb_by_model | text + vector merge | DB read |
| `get_general_faq` | ดึง FAQ topic | topic | doc/None | _kb_coll | build_general_context | — | — |
| `_extract_policy_from_descriptions` | สกัด policy จาก product desc | mongo_coll, policy_type, limit | str | regex over descriptions | build_general_context | รวมข้อความประกัน/คืนสินค้าจาก catalog | — |
| `build_general_context` | สร้าง general ctx | qtype, shop, mongo_db | dict/None {context, meta} | get_general_faq, _extract_policy_from_descriptions | _chat_impl (app ใช้ชื่อนี้ — chat_v2 เรียกผิดชื่อ §10#1) | KB doc + catalog policy → context | DB reads |
| `format_kb_context` | KB docs→prompt text | docs | str | — | lookup_kb | format block | — |
| `lookup_kb` | **KB lookup entry** | message | dict/None {found, context, kb_docs} | extract_model_keywords, search_kb_by_model, format_kb_context | _chat_impl, chat_v2._retrieve_products | kw → search → context | DB reads |
| `_detect_brand_question` | ถามแบรนด์ | message | brand/None | _known_brands | _chat_impl (alias app._detect_brand_question) | — | — |
| `_build_brand_context` | brand→ctx | db, brand, shop_filter | dict/None {context, meta{shop_scoped}} | mongo query | _chat_impl, chat_v2._check_brand_question | brand products → context; shop-scoped ก่อน | DB read |
| `_norm_brand` | normalize brand | raw | str | — | brand paths | — | — |
| `_known_brands` | brand set | — | set[str] | table/mongo | _detect_brand_question | — | — |
| `_qa_docs` | QA docs cache | — | list[dict] | _kb_qa_coll | QA search | cache | — |
| `_qa_vectors` | QA vectors cache | — | dict/None | npz/embedding | QA search | — | — |
| `_qa_embed_missing` | embed QA ที่ขาด | docs | — | embedding.embed_texts | QA search | เติม vector ที่ไม่มี | write-back |
| `search_qa` | QA-pair search | message, model_codes, … | list[doc] | _qa_docs, _qa_vectors, _qa_embed_missing | qa_context | vector QA (`USE_QA_KB`) | — |
| `qa_context` | QA→context text | message, conversation_id, claim | str | search_qa | answer ctx | — | — |
| `qa_troubleshoot_tips` | troubleshoot จาก QA | message, conversation_id, item_id | str | search_qa | problem-question path | tips สำหรับ "ใช้ไม่ได้" | — |
| `_kb_doc_to_card` | KB doc→product card | doc | card | — | _merge_kb_mongo | uniform card shape | — |

### 6.6 `web_search.py` — OpenRouter web fallback

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_get_openrouter_key` | OR key | — | str | llm.get_key_pool("openrouter_keys")/env | calls | pool → env fallback | — |
| `_get_openrouter_base`/`_get_openrouter_model` | OR config | — | str | env `OPENROUTER_BASE_URL`/`OPENROUTER_SEARCH_MODEL` | calls | — | — |
| `_get_ai_usage_hub_url`/`_get_ai_usage_hub_token` | hub config | — | str | env | _log_ai_usage | — | — |
| `_log_ai_usage` | usage log | entry dict | — | urllib POST hub | search_and_extract | fire-and-forget | swallow errors |
| `is_configured` | enabled check | — | bool | key getter | callers (gate) | — | — |
| `_salvage_json_value` | JSON salvage | text, key | any | regex | extract parse | ดึง value จาก JSON พัง | — |
| `_clean_device_specs` | normalize spec | raw | list[dict] | — | search result | structured device specs | — |
| `detect_uncertainty` | negative-answer detect | answer | (bool, reason/None) | patterns | _chat_impl (reanswer trigger) | "ไม่แน่ใจ/ไม่มีข้อมูล" | — |
| `should_use_web_search` | trigger decision | message, products, intent, answer… | (bool, reason) | rules + spec-db gate (lazy `_lookup_spec_db`) | _chat_impl, chat_v2._search_if_needed | reasons: no_products/answer_uncertain/compatibility…; skip เมื่อ target_device อยู่ spec-db หรือ yes-no spec มีสินค้า | — |
| `search_and_extract` | **search + extract** | message, shop, platform, history, reason | dict{search_used, keywords[], product_type, search_info, device_specs, usage, cost_usd, model, error} | OR call, _log_ai_usage, _clean_device_specs, _salvage_json_value | _chat_impl, chat_v2, device_compat (web ladder) | query rewrite → OR search → extract structured | net; error→{error} |
| `reanswer` | ตอบใหม่จาก search ctx | message, products, search_result, history… | (answer, usage) | llm answer + URL strip | _chat_impl | search_info (ไม่มี URL) → LLM | — |

### 6.7 `persona.py` — per-shop persona

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_build_admin_client` | admin mongo client | env | MongoClient | — | _persona_coll | — | — |
| `_persona_coll` | `shop_personas` coll | — | coll | _build_admin_client | get_persona | — | — |
| `get_persona` | ดึง persona | shop, platform | doc/None | _persona_coll.find_one | _build_context, engine v3, _chat_impl | shopname+platform match | DB read; error→None |
| `build_persona_instruction` | persona→prompt block | doc, shop | str | — | same | bot_name + style → instruction | — |

### 6.8 `warranty.py` — warranty detect/parse/claim/auto-check

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_unit_to_months` | unit→months | value, unit | int | — | extract_warranty_from_name | y/ปี→×12, เดือน→ตรง | — |
| `extract_warranty_from_name` | ระยะประกันจากชื่อ | item_name | dict/None {months, text} | regex, _unit_to_months | cards, warranty check | "1y"/"6 เดือน" → months | — |
| `is_in_warranty` | เช็คหมดประกัน | purchase_date, warranty_months, now | dict{in_warranty, expire_date, …} | datetime | check/auto | date math | — |
| `parse_purchase_date` | parse วันที่ซื้อ | text | datetime/None | regex TH formats | claim flow | dd/mm/yy, บริบทไทย | — |
| `strip_warranty_keywords` | ลบคำประกันออกจาก msg | message | str | kw list | flow | เหลือข้อมูลจริง | — |
| `WarrantyClaimContext` | claim state class | — | obj | — | warranty_flow | slots: order/date/name/phone/address/consent | — |
| ↳ `to_dict` | serialize | — | dict | — | claim persist | — | — |
| `detect_claim_request` | detect เคลมจริง | message | bool | `_CLAIM_REQUEST_INDICATORS` + negation guards | warranty_flow, v3 engine, chat_v2._classify_intent | kw + กัน "ถามเฉยๆ" (⚠️ "เสีย" substring latent §10#3) | — |
| `detect_consent` | detect ตกลง | message | bool | kw | claim SM | — | — |
| `detect_confirmation` | detect ยืนยัน | message | bool | kw | claim SM State 4 | — | — |
| `_mask_digits` | mask เลข | msg, digits | str | — | NER preprocess | กัน NER กลืนเบอร์/order | — |
| `_get_ner` | lazy NER model | — | model | transformers | _extract_name_ner | load once | model load |
| `_extract_name_ner` | สกัดชื่อด้วย NER | message | str | _get_ner, _mask_digits | extract_customer_info | NER primary | fallback regex |
| `extract_customer_info` | สกัด name/phone/addr | message | dict | _extract_name_ner + regex | claim SM State 3 | NER→regex fallback; reject ชื่อมีตัวเลข (⚠️ fallback ลบ "ค"/"ชื่อ" ผิด §10#9) | — |
| `detect_purchase_date_and_order` | date+order ใน msg | message | dict | regex | claim SM | — | — |
| `detect_warranty_duration_question` | ถามประกันกี่ปี | message | bool | kw | claim SM | — | — |
| `detect_tax_invoice_request` | ขอใบกำกับ | message | bool | kw | handoffs, chat_v2._check_tax_invoice | — | — |
| `detect_tisi_question` | ถาม มอก. | message | bool | kw | cert paths | — | — |
| `extract_tisi_model_keyword` | model kw สำหรับ TISI | message | str | regex | cert paths | — | — |
| `detect_cert_question` | ถาม cert ทั่วไป | message | tuple[str,…] | cert kw table | handoffs.post_intent_handoffs | TISI/CE/CCC/FCC/RoHS/GB | — |
| `check_warranty_status` | ประกันของสินค้า | product, purchase_text | dict | is_in_warranty, parse_purchase_date, extract_warranty_from_name | flow | — | — |
| `auto_check_warranty` | auto warranty | product/order info | dict | is_in_warranty | order flow | — | — |
| `auto_check_delivery_warranty` | auto warranty จาก delivery | order_sn, shop_filter, bot_name | (answer, info, ctx) | order_store.lookup_order, is_in_warranty | _chat_impl (หลัง order flow) | delivery date → คำนวณประกัน | DB read |

### 6.9 `warranty_flow.py` — claim state machine

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_is_question_msg` | เป็นคำถามไหม | text | bool | "ไหม/เหรอ/?" | internals | กันเอาคำถามเป็น consent | — |
| `_merge_claim_slots` | รวม claim slots | info, has_date, has_image, claim_state | dict | — | handle_warranty_flow | merge ข้อมูลสะสมข้าม turn | — |
| `_claim_collecting` | อยู่ช่วงเก็บข้อมูลไหม | claim_state | bool | stage/slots | handle_warranty_flow | stage==collecting หรือมี slots | — |
| `_update_claim_state` | persist claim | req, fields | — | conversation_products.update_claim_state | SM ทุกจุดเปลี่ยน | write `claim_state` ลง timeline | Mongo write |
| `_clear_claim_state` | ล้าง claim | req | — | conversation_products.clear_claim_state | SM เมื่อจบ/ยกเลิก | — | Mongo write |
| `_maybe_clear_claim_state` | clear ตามเงื่อนไข | req, claim_ctx, answer | — | _clear_claim_state | SM | เช่น handoff แล้ว | — |
| `handle_warranty_flow` | **SM entry (v2 ใช้)** | req, ctx, history, db | resp dict/None | warranty.*, _cp claim fns, order_store, llm, _send_handoff, _get_post_handoff_exceptions | chat_v2._check_warranty_state_machine | State 0-7 ตาม §5.2 — detect→order→date→consent→info→confirm→handoff→evidence; State 6 post-handoff เงียบ (ticket_state!=closed) | claim_state writes, handoff POST |
| `_handle_review_request` | ขอ review ใน claim | req, ctx, history | resp | llm | handle_warranty_flow | — | — |
| `_build_post_handoff_response` | resp หลัง handoff | req, ctx | resp | llm, _app_module | State 6 | เงียบ/รับรู้สั้น | — |
| `_build_warranty_claim_response` | resp claim ปกติ | req, ctx, answer, handoff, claim_ctx | resp | _make_response-equivalent | SM | สร้าง ChatResponse dict + claim payload | — |
| `_handle_warranty_date_followup` | follow-up วันที่ | req, ctx, history, purchase_date, db | resp/None | warranty.is_in_warranty, llm | State 2 | คำนวณใน/นอกประกัน | state write |
| `_handle_tax_invoice_followup` | follow-up ใบกำกับ | req, ctx, history | resp/None | _send_handoff | SM | tax → handoff | handoff POST |
| `_handle_first_message_claim` | claim ข้อความแรก | req, ctx, is_claim | resp/None | warranty.*, llm | SM State 0/1 | — | — |
| `handle_warranty_flow_legacy` | wrapper legacy | req, ctx, history, db | resp/None | handle_warranty_flow | _chat_impl | arg order เดิม | — |

### 6.10 `conversation_products.py` — timeline/anchor/claim state (admin DB, key=conversation_id)

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_admin_db` | admin db handle | env | db | mongo client | internals | cached | — |
| `_coll` | `conversation_products` coll | — | coll | _admin_db | persist fns | — | — |
| `_to_serializable` | BSON→JSON | obj | any | — | save | ObjectId/date | — |
| `load_timeline` | อ่าน timeline | conversation_id | doc/None | _coll.find_one | getters | doc key=conv_id (`shadow:` prefix แยก test) | DB read |
| `save_timeline` | เขียน timeline | conversation_id, platform, shop, data | — | _coll.update_one upsert, _to_serializable | add_*/claim fns | upsert | Mongo write |
| `add_product` | เพิ่ม entry | conv_id, platform, shop, item_id, card, kind(anchor/suggestion), message | — | load/save_timeline, _strip_card_for_storage, _compute_active | _record_suggestion_products, order flow | append entry + recompute active | Mongo write |
| `_strip_card_for_storage` | เบา card ก่อนเก็บ | card | card | — | add_product | ตัด heavy fields | — |
| `_compute_active` | เลือก active | products | id/index/None | sort key (datetime) | add_product | ล่าสุด anchor > suggestion | — |
| `_rebuild_card` | rebuild card สด | p, message | card/None | product_store.fetch_product_by_id | _materialize_card | refetch รูป/ราคา/stock จริง | DB read |
| `_materialize_card` | card ที่ใช้ได้เสมอ | p, message | card | _rebuild_card | getters | rebuild ไม่ได้→เก็บเดิม | — |
| `_normalize_dt` | datetime normalize | dt | datetime | — | _compute_active | — | — |
| `get_active_product` | active anchor/suggestion | conversation_id | card/None | load_timeline, _materialize_card | _chat_impl CONV-ACTIVE | — | — |
| `get_suggestion_latest` | suggestion ล่าสุด | conversation_id | card/None | load_timeline | follow-up paths | — | — |
| `get_latest_suggestion_batch` | batch แนะนำล่าสุด | conversation_id | list[card] | load_timeline, _materialize | _chat_impl compare | ทุกขนาด batch; caller เติม anchor เป็นคู่เทียบเมื่อ=1 | — |
| `get_anchor_and_suggestions` | anchor+suggest รวม | conversation_id, limit | list | load_timeline | _chat_impl (ITEM-TAG bypass check) | ใช้เช็ค timeline ≥2 | — |
| `resolve_active_by_message` | resolve "อันนั้น/ตัวเดิม" | conversation_id, message | card/None | timeline + reference kw | CONV-ACTIVE | ref kw → entry | — |
| `add_order_anchor` | เพิ่ม order anchor | conv_id, platform, shop, order_sn, order_info | — | save_timeline | order_flow, chat_v2._check_order_lookup | — | Mongo write |
| `get_active_order_sn` | order_sn active | conversation_id | str/None | load_timeline | order paths | — | — |
| `get_order_anchors` | order anchors ทั้งหมด | conversation_id | list | load_timeline | — | — | — |
| `resolve_active_order_sn` | resolve order จาก msg | conversation_id, message | str/None | is_order_question + timeline | order_flow, chat_v2._check_order_lookup | คำถาม order + มี anchor → sn | — |
| `is_order_question` | เป็นคำถาม order ไหม | message | bool | kw | resolve_active_order_sn | — | — |
| `get_anchor_history` | history anchors | conversation_id | list | load_timeline | compare ctx | — | — |
| `get_previous_anchor` | anchor ก่อนหน้า | conversation_id | card/None | load_timeline | _chat_impl compare | — | — |
| `load_claim_state` | อ่าน claim state | conversation_id | dict/None | load_timeline | warranty_flow | — | — |
| `update_claim_state` | เขียน claim state | conversation_id, fields | — | save_timeline | warranty_flow._update_claim_state | merge fields | Mongo write |
| `clear_claim_state` | ล้าง claim | conversation_id | — | save_timeline | warranty_flow._clear_claim_state | — | Mongo write |

### 6.11 `order_store.py` — order/tracking lookup (read-only)

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_get_order_client` | order DB client | env ORDER_* | MongoClient | — | _get_order_collection | mongo แยกจาก product DB | — |
| `_get_order_collection` | `ShpOrders` coll | — | coll | _get_order_client | lookups | — | — |
| `extract_order_sn` | สกัดเลข order | message | str/None | regex patterns | order_flow, chat_v2, rich_parse, warranty | SN pattern | — |
| `extract_tracking_number` | สกัดเลขพัสดุ | message | str/None | regex | order_flow, chat_v2, rich_parse | carrier patterns (SPX/Kerry/Flash/J&T/ไปรษณีย์) | — |
| `_normalize_tracking` | normalize tracking | tn | str | — | lookup_by_tracking | — | — |
| `lookup_by_tracking` | tracking→order | tn, shop_filter | order/None | _get_order_collection, _normalize_tracking | order_flow, chat_v2._check_tracking_lookup | find by tracking | DB read |
| `_map_order_status` | status→ไทย | status | str | map | build_order_context | — | — |
| `_map_logistics_status` | logistics→ไทย | status | str | map | build_order_context | — | — |
| `_format_create_time` | เวลาสั่งซื้อ | ts | str | — | build_order_context | — | — |
| `_format_unix_ts` | unix ts→text | ts | str | — | build_order_context | — | — |
| `_format_address` | address→text | addr dict | str | — | build_order_context | — | — |
| `lookup_order` | **order lookup** | order_sn, shop_filter | dict/None | _get_order_collection.find_one | order_flow, chat_v2, engine v3, warranty.auto_check_* | full doc | DB read |
| `build_order_context` | order→prompt ctx | order | str | _map_*/_format_* | all order paths | items/status/tracking/address block | — |

### 6.12 `order_flow.py` — early order flow

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `early_order_flow` | order/tracking/return-refund ก่อน intent | req, ctx, history, db | resp dict/None | order_store.*, conversation_products.add_order_anchor/resolve_active_order_sn, llm.answer_general, responses._send_handoff | _chat_impl | order_sn resolve (req/tag/regex/anchor) → lookup → status/tracking → return/refund detect (received-verb+problem → handoff; guard "ไหม/เหรอ") → เขียน `ctx["order_sn"]`/`ctx["is_claim_request_pre"]` | anchor write; handoff POST; error→None (ผ่านต่อ) |

### 6.13 `handoffs.py` — handoff detection

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `detect_human_request` | pre-intent human req + frustration | req, ctx | resp/None | kw tables, anger composition, responses._send_handoff | _chat_impl | "ขอคุยกับคน/แอดมิน/คนตอบ" → `human_request`; strong anger (ผิดหวัง/หัวร้อน/โกรธ/ตีของกลับ) หรือ mild complaint (ช้ามาก/รอนาน/ไม่มีใครตอบ) ที่ไม่ใช่คำถาม → `customer_frustration` | handoff POST |
| `post_intent_handoffs` | tax invoice + cert | req, ctx, db | resp/None | warranty.detect_tax_invoice_request/detect_cert_question, product_store.search_cert_products | _chat_impl | tax→handoff `tax_invoice_request`; cert→cert cards answer | handoff POST; mongo read |

### 6.14 `device_compat.py` — compatibility engine

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_extract_max_wattage` | watt สูงสุดจาก text | text | int | regex | tiers/filter | — | — |
| `_wattage_asc_key` | sort key watt | p | num | _extract_max_wattage | _apply_product_tiers | ascending | — |
| `_spec_brand` | brand ของ spec entry | spec | str | — | _lookup_spec_db | — | — |
| `_device_brand_hint` | brand hint จาก msg | message | str | `_DEVICE_BRAND_HINTS` | _extract_device_token | — | — |
| `_ascii_alnum` | normalize token | text | str | regex | matching | — | — |
| `_term_boundary_match` | boundary match | text, term | bool | regex boundaries | _device_mentioned, _lookup_spec_db | กัน substring collision ("a73"ใน"xiaomi a73") | — |
| `_lookup_spec_db` | spec-db lookup | device token | dict/None | `device_specs_data.DEVICE_SPECS` + aliases + brand guard | _resolve_device_spec, web_search gate | key/alias + `_spec_brand` guard กันข้ามแบรนด์ | — |
| `_extract_device_token` | device จาก msg | message | str | regex + _device_brand_hint | _device_spec_lookup | brand+model pattern | — |
| `_charging_scope` | scope type ที่ถามจริง | message, asked_type | set/None | product_store._detect_product_types ∩ `_CHARGING_TYPES` | re-query | 'charger' drop เมื่อมี form เจาะจง; ว่าง→{asked_type} | — |
| `_compat_mode` | mode detect | message, intent | str | kw/ctx | _device_spec_lookup | charging/model_fit/self_compat/skip | — |
| `_extract_product_connectors` | connectors ของสินค้า | card | set[str] | `_CONN_QUERY_KW` vocab map | _filter_compat_products | จาก name/desc | — |
| `_device_mentioned` | สินค้าระบุ device ตรงไหม | card, device | bool | _term_boundary_match + no-space variant | catalog evidence | "iPhone18"="iphone 18" บน name/desc | — |
| `_web_spec_to_dict` | web result→spec | raw | dict | _clean helpers | _resolve_device_spec | เชื่อเฉพาะ connector vocab; watt ต้อง structured | — |
| `_resolve_device_spec` | resolve spec | device, intent, … | dict/None | _lookup_spec_db → _web_spec_to_dict → intent min_watt | _device_spec_lookup | structured เท่านั้น (ไม่ parse prose watt) | web call ได้ |
| `_filter_compat_products` | กรองตาม spec | products, spec, mode | products | _extract_product_connectors, _device_mentioned | _device_spec_lookup | connector hard filter (ห้ามข้าม type) | — |
| `_apply_product_tiers` | tier sort | products, spec | products | _wattage_asc_key, min_watt | _device_spec_lookup | adequate-first (≥min_watt ก่อน) + baseline/upgrade ≤2 | — |
| `_device_spec_lookup` | **compat orchestrator** | message, products, intent, db, … | (spec, products, meta) | ทั้งหมดข้างบน + product_store.fetch_products + web_search | _chat_impl | ladder: spec-db → re-query (`_charging_scope`+conn syn) → catalog evidence `_device_mentioned` → web → intent min_watt | mongo + web reads |

### 6.15 `device_specs_data.py` — structured spec DB (data only, ไม่มีฟังก์ชัน)

| member | Purpose | โครงสร้าง | ขนาด |
|---|---|---|---|
| `DEVICE_SPECS` | device→charging spec | `{connector: usb-c/lightning/micro-usb/proprietary, wired_w, wireless_w, protocols[pd/pps/qc/ufcs/qi/qi2/magsafe/hypercharge/supervooc/vooc/flashcharge/supercharge/warp], year, aliases[]}` | ~516 entries — มือถือ/แท็บเล็ต/หูฟัง/laptop (Windows ด้วย)/wearable/gadget + generic (iphone/ipad/notebook) |
| `_T_*` (25 templates) | shared spec รุ่นที่เหมือนกัน | `{**_T_x, "year":…, "aliases":[…]}` | แก้จุดเดียวทั้งชุด |

### 6.16 `units.py` — sellable-unit runtime (flag `USE_UNIT_INDEX`)

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_units_coll` | `sellable_units` coll | — | coll | admin mongo | internals | — | — |
| `_unit_vectors` | unit npz | — | vectors | npz load (mtime) | _vector_search | — | — |
| `_sellable_mask` | mask sellable | units | mask | sellable field | _vector_search | — | — |
| `_vector_search` | unit vector search | query, filters | units | _unit_vectors, _sellable_mask, embed_query | fetch_units | cosine top-k | — |
| `fetch_units` | unit retrieval | db, message, limit, … | units | _vector_search | fetch_products (flag) | — | error→[] → fallback listing |
| `pick_desc_sections` | เลือก desc sections | unit, route | str | sections dict | to_unit_card | highlights/specs/warranty/notes | — |
| `_live_availability` | availability สด | unit | bool | stock join | _live_sellable | — | DB read |
| `_live_sellable` | sellable สด | unit | bool | _live_availability | fetch_unit_cards | — | — |
| `_variant_image_id` | รูปตาม variant | unit | image_id | — | to_unit_card | — | — |
| `to_unit_card` | unit→card | unit, message | card | pick_desc_sections, _variant_image_id, _live_sellable | fetch_unit_cards | listing-compatible shape | — |
| `attach_kb_specs` | ผูก KB specs | units | units | knowledge_base | fetch_unit_cards | enrich spec | DB read |
| `_unit_warranty` | warranty ของ unit | unit | dict | warranty helpers | to_unit_card | — | — |
| `attach_image_texts` | ผูก OCR | units | units | `image_texts` coll | fetch_unit_cards | รูปนอก desc | DB read |
| `attach_listing_fields` | ผูก listing fields | units | units | `ShpProducts` | fetch_unit_cards | เติม field listing | DB read |
| `fetch_unit_cards` | **unit path entry** | db, message, shop, limit | list[card] | fetch_units, _live_sellable, attach_*, to_unit_card | product_store.fetch_products (`USE_UNIT_INDEX`) | vector→sellable→live→enrich→cards | fallback []→listing path |

### 6.17 `embedding.py` — embeddings

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_get_model` | lazy embedding model | — | model | sentence-transformers, `EMBEDDING_DEVICE` | embed_* | load once cache | model load |
| `embed_texts` | encode docs | texts, batch_size=32 | np.ndarray | _get_model | build scripts, _qa_embed_missing | normalized emb | — |
| `embed_query` | encode query | text | np.ndarray | _get_model | vector_search (products/units/QA) | single emb | — |
| `clean_item_name` | clean ชื่อก่อน embed | name | str | regex | build_doc_text | — | — |
| `build_doc_text` | doc→embed text | doc | str | clean_item_name | build_embeddings | name+key fields | — |

### 6.18 `route_context.py` — route normalization

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `RouteContext` | ctx holder class | — | obj | — | resolve_route | fields: normalized message ฯลฯ | — |
| `_load_typo_dict` | โหลด typo map | — | dict | json `exports/typo_dict.json` | normalize_message | cache | file read; miss→{} |
| `normalize_message` | แก้คำผิด | message | str | _load_typo_dict | resolve_route | vocab replace | — |
| `resolve_route` | entry | req | RouteContext | normalize_message | _chat_impl | — | — |

### 6.19 `responses.py` — response helpers

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_routing` | routing_decision dict | path, reason, handoff_reason | dict | — | app, chat_v2 | uniform `{path, reason, …}` | — |
| `_send_handoff` | POST handoff แอดมิน | req, ctx, reason, claim_topic, claim, simulate, timeout, log_tag | resp dict/{} | urllib POST `ADMIN_HANDOFF_URL` + `X-Internal-Secret` | app/flows, chat_v2 | payload `simulate=req.simulate_assignment` | net POST best-effort; error→{} |

### 6.20 `guards.py` — final output policy

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `build_flags` | detect violations | resp, req | flags | regex (ext URLs, policy phrases, claim-confirm w/o handoff) | enforce | — | — |
| `check_output` | evaluate flags | answer/resp, handoff_sent | violations list | build_flags | ChatResponse.model_post_init (observe), enforce | log + คืน violations | log stderr |
| `enforce` | **final boundary** | resp, req | resp | build_flags, check_output, _escalate, _claim_grounded, _replace_clause | app.chat() ทุก engine | escalate rules (`_ESCALATE_RULES`) → rewrite tier (`_REWRITE_RULES`): claim โปร/เปลี่ยนคืนที่ ungrounded → แทน clause ด้วยข้อความขอแอดมินตรวจสอบ | อาจ handoff |
| `_escalate` | handoff on violation | resp, req | resp | responses._send_handoff | enforce | — | POST |
| `_claim_grounded` | claim มีหลักฐานใน context | resp, pos_rx, flags, mode | bool | `_pos_grounded`, `_card_available`, `_grounding_text` | enforce | mode "text": `_pos_grounded` (negation-aware) บน card desc + `grounding_text`; mode "stock": มี card `_available_for_sale` | — |
| `_pos_grounded` | polarity-aware match | text, pos_rx | bool | `_NEGATION_RE` | `_claim_grounded` | match pos_rx ที่ไม่มี ไม่/ห้าม/หมด ใน 20 chars ก่อนหน้า | — |
| `_card_available` | card ขายได้จริง | card dict | bool | — | `_claim_grounded` | `_available_for_sale` หรือ fallback `status==NORMAL && !sold_out` | — |
| `_grounding_text` | KB context ของ general: | resp | str | — | `_claim_grounded`, `_context_pool` | อ่าน `routing_decision["grounding_text"]` (app.py แนบ gen_context[:2000]) | — |
| `_context_pool` | pool ข้อความที่ LLM เห็น | resp, req | str | `_grounding_text` | enforce | cards name/desc + grounding_text + req.message + history text/image_desc → lower | — |
| `_replace_clause` | แทน claim ทั้ง clause | text, start, end, repl | str | `_CLAUSE_BOUNDARY` | enforce | หา boundary (newline/`|||`/`.!?`/particle ไทย+space) รอบ span → swap ทั้ง clause กันเศษค้าง | — |

### 6.21 `chat_models.py` — structured context dataclasses

| class | Purpose | Fields |
|---|---|---|
| `HistoryEntry` | history row | role, text, images, image_desc |
| `AnchorData` | anchor bundle | item_id, name, product_type, charger_subtype, description, card, source |
| `IntentData` | intent result | intent, product_type, charger_subtype, target_device, confidence, needs_description |
| `ContextData` | pipeline ctx | shop, platform, conversation_id, history, persona, vision, steps, timing |
| `SearchData` | search result | used, reason, keywords, product_type, info |
| `AnswerData` | answer bundle | answer, usage, cost, model |

### 6.22 `test_chat_api.py` — test-chat sessions API

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_validate_object_id` | เช็ค id | id str | ObjectId | bson | routes | invalid→400 | HTTPException |
| `_log_testchat_action` | audit | entry | — | admin mongo | mutating routes | write log | DB write |
| `TestChatMessage` | pydantic msg | role,text,images… | — | — | AddMessageRequest | schema | — |
| `CreateSessionRequest`/`AddMessageRequest`/`UpdateSessionRequest`/`RateMessageRequest` | pydantic req | fields | — | — | routes | schema | — |
| `list_test_chat_sessions` | `GET /test-chat/sessions` | headers | list | `test_chat_sessions` coll | HTTP | filter admin_id | — |
| `create_test_chat_session` | `POST /test-chat/sessions` | CreateSessionRequest | dict | coll insert | HTTP | +admin_id/name | DB write |
| `get_test_chat_session` | `GET …/{id}` | id | dict | coll.find_one | HTTP | — | — |
| `add_test_chat_message` | `POST …/{id}/messages` | id, AddMessageRequest | dict | coll update | HTTP | append msg | DB write |
| `delete_test_chat_session` | `DELETE …/{id}` | id | dict | coll delete | HTTP | — | DB write |
| `update_test_chat_session` | `PUT …/{id}` | id, UpdateSessionRequest | dict | coll update | HTTP | rename/meta | DB write |
| `close_test_chat_session` | close | id | dict | coll update | HTTP | status→closed | DB write |
| `reopen_test_chat_session` | reopen | id | dict | coll update | HTTP | status→open | DB write |
| `list_test_chat_logs` | `GET /test-chat/logs` | headers, filters | list | coll query | HTTP | filter admin_id | — |

### 6.23 `chat_v2.py` — 8-stage pipeline

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_extract_item_id` | item tag | message | str | `_ITEM_TAG_RE` | stages | — | — |
| `_extract_order_sn` | order tag/sn | message | str | `_ORDER_TAG_RE`, order_store.extract_order_sn | _check_order_lookup | tag→regex fallback | — |
| `_extract_tracking` | tracking | message | str | order_store.extract_tracking_number | _check_tracking_lookup | — | — |
| `_has_image_placeholder` | มี placeholder รูปไหม | message | bool | `_IMAGE_PLACEHOLDER_RE` | stages | — | — |
| `_is_image_only` | msg เป็นรูปล้วน | message | bool | regex sub | stages | — | — |
| `_extract_product_subtype` | subtype จาก msg | message | str | product_store._detect_charger_subtype | enrichers | — | — |
| `_extract_product_types` | types จาก msg | message | set | product_store._detect_product_types(_fuzzy) | _classify_intent | — | — |
| `_is_superlative_question` | superlative | message | bool | kw ("สุด/ที่สุด/แรงสุด") | _classify_intent, _rerank | — | — |
| `_is_charging_spec_question` | ถาม spec ชาร์จ | message | bool | kw+pattern | _classify_intent | → intent product_spec | — |
| `_detect_multi_usecase` | หลาย use-case | message | list[str] | kw pairs | _classify_intent, _rerank | "เล่นเกม+ฟังเพลง" | — |
| `_extract_wattage` | W จาก msg | message | int | regex | _classify_intent, _rerank | — | — |
| `_adjust_fetch_limit_for_superlative` | limit ขยาย | limit, message, intent, history | int | — | _retrieve_products | ×5 ≤50 | — |
| `_augment_retrieval_for_superlative` | เพิ่ม kw | retrieval_msg, message, history | str | — | _retrieve_products | +powerbank เมื่อ "ชาร์จ" ลอย | — |
| `_build_context` | Stage 1 | req | (ctx, history, client, db) | _app_module._db, persona.*, _run_vision | chat_v2 | ctx dict — ไม่ mutate shared | — |
| `_run_vision` | vision pass | req, history, steps, timing | (ctx_str, usage, image_desc) | llm.describe_images | _build_context | history images ยังไม่มี desc + req.images ≤`BOT_MAX_IMAGES_PER_TURN` | net; error→"" |
| `_check_deterministic` | Stage 2 router | req, ctx, history, db | resp/None | sub-checks ล่าง | chat_v2 | order→tracking→tax→human→warranty→general→brand | — |
| `_check_order_lookup` | order | req, ctx, history, db | resp/None | _extract_order_sn, order_store.lookup_order/build_order_context, _cp.add_order_anchor, llm.answer_general | _check_deterministic | order_sn จาก req/tag/anchor → lookup → answer | anchor write |
| `_check_tracking_lookup` | tracking | req, ctx, history, db | resp/None | _extract_tracking (incl. vision ctx), order_store.lookup_by_tracking, answer_general | _check_deterministic | — | — |
| `_check_tax_invoice` | ใบกำกับ | req, ctx | resp/None | warranty.detect_tax_invoice_request, _app_module._send_handoff | _check_deterministic | → handoff tax_invoice_request | POST |
| `_check_human_request` | ขอคน | req, ctx | resp/None | kw table, _send_handoff | _check_deterministic | → handoff human_request | POST |
| `_check_warranty_state_machine` | warranty | req, ctx, history, db | resp/None | warranty_flow.handle_warranty_flow | _check_deterministic | — | state writes, POST |
| `_check_general_question` | general Q | req, ctx, history, db | resp/None | kb.detect_general_question, **kb.get_general_context ⚠️ (ไม่มี — ของจริง build_general_context)**, llm.answer_general | _check_deterministic | skip follow-up warranty/return สั้น | ⚠️ AttributeError→500 (§10#1) |
| `_check_brand_question` | brand Q | req, ctx, history, db | resp/None | _app_module._detect_brand_question/_build_brand_context, answer_general | _check_deterministic | shop-scoped ก่อน | — |
| `_classify_intent` | Stage 3 | req, ctx, history | intent dict | intent_classifier.should_run_pass1/classify_intent, enrichers | chat_v2 | skip clear case; +superlative/charging_spec/multi_usecase/wattage; charging→product_spec | — |
| `_detect_anchor` | Stage 4 | req, ctx, history, db | anchor/None | _extract_item_id (req→msg→history), product_store.fetch_product_by_id, _detect_product_type_from_name, **_cp.add_item_anchor ⚠️ (ไม่มี)** | chat_v2 | card + subtype-mismatch → `use_as_product` flag + compat detect | ⚠️ timeline write no-op (§10#1) |
| `_extract_target_device` | device จาก msg | message | str | brand+model regex | _detect_anchor, _classify_intent | — | — |
| `_detect_product_type_from_name` | type จากชื่อ | name | str | product_store detectors | _detect_anchor | — | — |
| `_detect_followup_products` | follow-up products | req, history, db | cards | **_cp.get_timeline ⚠️ (ไม่มี)** | _retrieve_products | follow-up kw → timeline 5 ล่าสุด | ⚠️ no-op (§10#1) |
| `_rerank_products` | rerank | products, message, intent, anchor | products | scorers | _retrieve_products | sort: anchor>NORMAL+stock>kw match>superlative watt>usecase>charging-spec closeness>watt | — |
| `_filter_unavailable_products` | กรองของไม่พร้อมขาย | products | products | status/stock | _retrieve_products | เฉพาะ recommend/search intent; anchor ไม่กรอง; ว่าง→คืนทั้งหมด+_context_note | mutate |
| `_retrieve_products` | Stage 5 RAG | req, ctx, history, intent, anchor, db | products | knowledge_base.lookup_kb, product_store.fetch_products, model-regex, follow-up, anchor merge, rerank, filter | chat_v2 | §5.3 stage 5 | mongo reads |
| `_search_if_needed` | Stage 6 | req, ctx, history, intent, products, db | (products, extra_ctx, meta) | web_search.is_configured/should_use_web_search/search_and_extract, fetch_products, _strip_urls | chat_v2 | trigger → search → re-query merge → strip URLs → extra ctx | net |
| `_strip_urls` | ลบ URL | text | str | regex | _search_if_needed | markdown+plain URLs | — |
| `_no_product_guard` | Stage 7 | req, ctx, intent, products, search_used | resp/None | _make_response, _routing | chat_v2 | ว่างหลัง search→handoff no_product_found | POST |
| `_build_answer` | Stage 8 | req, ctx, history, intent, anchor, products, extra_context | (answer, usage, cost, model) | llm.answer, _app_module._append_base_warranty | chat_v2 | +hints (superlative/usecase/charging-spec/wattage) | RuntimeError→500 |
| `_make_response` | resp builder | answer, products, ctx, source, usage, handoff…, routing | dict | llm.split_segments | ทุก stage | uniform ChatResponse-compatible | — |
| `chat_v2` | **entry** | req | dict | stages 1-8 | _chat_impl | §5.3 | `client.close()` ใน finally — ⚠️ shared-client race (§10#2) |

### 6.24 `chatbotv3/` — OpenRouter-first engine

**`engine.py`:**

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_get_warranty`/`_get_knowledge_base`/`_get_product_store`/`_get_persona`/`_get_order_store` | lazy imports | — | module | import | engine internals | กันโหลด heavy modules ตอน import (test ไม่ต้องลง deps) | — |
| `_send_handoff_to_admin` | handoff POST | conversation_id, shop, platform, reason, claim, simulate | bool | urllib POST `ADMIN_HANDOFF_URL` | _make_handoff_response | เหมือน legacy `_send_handoff` | POST; error→False+log |
| `_get_persona_extra` | persona text | shop_name, platform | str | persona.get_persona/build_persona_instruction | chat_v3 | error→"" | — |
| `_lookup_order_context` | order→ctx | order_sn, shop | str | order_store.lookup_order/build_order_context | chat_v3 | error→"" | DB read |
| `_extract_image_desc_from_answer` | image desc | answer, has_images | str | — | chat_v3 | ปัจจุบันคืน "" (v3 ส่งรูปตรง) | — |
| `_build_history_list` | history→dicts | history | list[dict] | model_dump/dict | chat_v3 | แนบ image_desc เดิมต่อท้าย text | — |
| `_build_user_prompt` | user prompt | message, shop, platform, history, images, shop_products, order_sn, item_id, order_context | str | shop_link.build_shop_context_block | chat_v3 | shop block + order + item + ≤30 products (desc ≤500 chars) + คำถาม | — |
| `_make_handoff_response` | resp handoff | reason, answer, shop, model, elapsed, steps, claim, conversation_id, platform, simulate | dict | _send_handoff_to_admin | chat_v3 | ChatResponse-compatible + `chat_engine:"v3"` + segments `|||` | POST |
| `_make_answer_response` | resp คำตอบ | answer, products, shop, model, usage, elapsed, cost, steps, image_desc | dict | — | chat_v3 | เหมือนด้านบน | — |
| `chat_v3` | **entry** | req (ChatRequest) | dict | rich_parse.parse_rich_message, warranty.detect_claim_request, emotion.*, product_match.*, order_store, persona, system_prompt, or_client.call_or | _chat_impl | §5.4 | POST handoff; OR call; error→fallback answer |

**`or_client.py`:**

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_is_safe_image_url` | SSRF guard | url | bool | urlparse, socket.getaddrinfo, ipaddress | call_or | http/https เท่านั้น + resolve IP: block private/loopback/link-local/multicast (กัน DNS rebinding) | — |
| `_load_api_keys` | โหลด keys | env | list[str] | os.environ | module init | `OPENROUTER_API_KEY_1..9` + single | log sha256[:8] เท่านั้น (ไม่ log key) |
| `_next_api_key` | round-robin | — | str | itertools.cycle | call_or | — | RuntimeError ถ้าไม่มี key |
| `_log_ai_usage` | usage log | entry | — | urllib POST hub | call_or | fire-and-forget | swallow errors |
| `call_or` | **OR REST call** | model, system, user, history, max_tokens, temperature, source, step, reference, images | dict{answer, prompt_tokens, output_tokens, cost_usd, duration_s, raw_usage, model, error} | _next_api_key, _is_safe_image_url, _log_ai_usage | chat_v3 | messages build (role model→assistant; ≤3 imgs validated; user ≤2000 chars กัน injection) → POST /chat/completions → cost จาก OR หรือ pricing table | HTTPError/Exception→error dict (ไม่ raise) |

**`product_match.py`:**

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_get_product_store` | lazy import | — | module | import | internals | — | — |
| `_extract_product_names_from_answer` | สกัดชื่อสินค้า | answer | list[str] | regex ×4 | match_products | `**bold**`, `[name](link)`, `![alt](url)`, bullet lines | — |
| `_normalize_name` | normalize | name | str | regex | match_products | lower+alnum only | — |
| `match_products` | answer→cards จริง | answer, shop_filter, db, limit | list[card] | _extract_product_names_from_answer, _normalize_name, coll.find_one (longest-token regex), product_store.to_product_card | chat_v3 | verify ชื่อใน `ShpProducts` ของร้านนั้น — กัน cross-shop/หลอก | mongo reads |
| `get_product_by_id` | การ์ดตาม id | item_id, shop_filter, db | card/None | product_store.fetch_product_by_id, to_product_card | chat_v3 | — | error→None |
| `get_shop_products_summary` | catalog ร้านสำหรับ ctx | shop_filter, db, message, limit | list[card] | product_store.fetch_products(filter_unavailable=False) | chat_v3 | ≤30 ชิ้นทุก status (LLM ตัดสินใจ) | error→[] |

**`system_prompt.py`:**

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_get_llm` | lazy import llm | — | module/False | import | builders | False→ใช้ `_FALLBACK_SYSTEM_INSTRUCTION` | — |
| `build_system_instruction` | v3 system prompt | shop_name, shop_url, persona_extra | str | llm.SYSTEM_INSTRUCTION + `_V3_RULES` | chat_v3 | base legacy + v3 rules (ตอบจาก DB ก่อน/ปัญหาใช้งานบอกวิธีเช็คก่อน/ห้ามอ้างตรวจระบบ/ห้ามสรุปแทนทุกรุ่น/ห้ามสัญญาแทนคน/shop isolation/ห้ามแต่งลิงก์/compat เช็คจาก รายละเอียด) | — |
| `build_kb_system_instruction` | KB prompt | persona_extra | str | llm.KB_SYSTEM_INSTRUCTION | (KB path ถ้าใช้) | — | — |

**`emotion.py`:**

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_contains_word` | kw match กัน FP | text, keyword | bool | `_FALSE_POSITIVES` map | detectors | คำสั้น (บ้า/ชั่ว/ห่วย/กาก/บัค/ช้า…) เช็คไม่ใช่ substring ของคำอื่น | — |
| `detect_negative_emotion` | อารมณ์เสีย → handoff | message, history | bool | _contains_word | chat_v3 | strong kw→T; moderate+context kw→T; moderate ซ้ำ≥2 ใน 6 turn ล่าสุด→T | — |
| `detect_human_request` | ขอคุยคน | message | bool | kw table | chat_v3 | คุยแอดมิน/ขอคน/staff/human/agent… | — |

**`rich_parse.py`:**

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `_get_order_store` | lazy import | — | module | import | extract_* | — | — |
| `extract_item_id` | item tag | text | str/None | `_ITEM_TAG_RE` | parse_rich_message | `[สินค้า/item/item_id/product: N]` | — |
| `extract_order_sn` | order | text | str/None | `_ORDER_TAG_RE` → order_store.extract_order_sn | parse_rich_message | — | — |
| `extract_tracking` | tracking | text | str/None | order_store.extract_tracking_number | parse_rich_message | — | — |
| `has_image_placeholder` | มี placeholder | text | bool | `_IMAGE_PLACEHOLDER_RE` | parse_rich_message | — | — |
| `is_image_only` | รูปล้วน | text | bool | regex sub | parse_rich_message | — | — |
| `strip_item_tag` | ตัด tag | text | str | `_ITEM_TAG_RE` | parse_rich_message | — | — |
| `is_placeholder_only` | placeholder ลอย | text | bool | strip_item_tag + `_PLACEHOLDERS_EMPTY` | parse_rich_message | `[item]/[variation_card]/[bundle]/[order]` ลอย | — |
| `parse_rich_message` | **parse รวม** | text | dict{item_id, order_sn, tracking, has_image, is_image_only, clean_message, is_placeholder_only} | ทั้งหมดข้างบน | chat_v3 | — | — |

**`shop_link.py`:**

| ฟังก์ชัน | Purpose | Input | Output | Calls | Called by | How it works | Side effects / Error |
|---|---|---|---|---|---|---|---|
| `build_shop_url` | URL ร้าน | shop_name, platform | str | urllib.parse.quote | chat_v3, build_shop_context_block | `shopee.co.th/{lower}?entryPoint=ShopBySearch&searchKeyword=` (+tiktok/lazada placeholder formats) | — |
| `build_shop_context_block` | shop ctx block | shop_name, platform | str | build_shop_url | _build_user_prompt | block "ตอบแค่สินค้าในลิงก์ร้านนี้" | — |

### 6.25 Scripts + tooling

**`chatbot/shopeechat/scripts/`:**

| สคริปต์/ฟังก์ชัน | Purpose | Input | Output | How it works |
|---|---|---|---|---|
| `export_mongo.py` (`main`, `export_collection`, `export_json`, `export_csv`, `fetch_documents`, `get_client`, `build_connection_string`, `list_collections`, `_to_serializable`) | dump collection→ไฟล์ | `--collection --format json|csv --limit` | `exports/*.{json,csv}` | conn pattern เดียวกับ product_store |
| `build_embeddings.py` (`main`) | embed → npz | `[--units] [--qa]` | `exports/product_embeddings.npz` / unit / qa variants | อ่าน export/jsonl → `embedding.build_doc_text`+`embed_texts` → npz |
| `build_sellable_units.py` (`main`, `_iter_export_docs`, `_parse_desc_sections`, `_section_key`, `_field_list_parts`, `_price_of`, `_build_unit`) | แตก listing→units | `--source export|mongo` | `exports/sellable_units.jsonl` | 1 unit=item_id×model_id; parse desc sections (`[[ ]]`/`*** ***`/`===`); `unit_classifier.classify_unit`; gate ≥90% classified |
| `unit_classifier.py` (`classify_unit`, `_parse_components`, `_detect_type`, `_extract_codes`, `_seg_component`, `_is_color_or_version`, `_seg_is_code`, `_code_matches_listing`, `_companion_comp`, `_charger_subtype`, `_cable_subtype`, `_camera_subtype`, `_norm_seg`) | classify unit | item_name, model_name, model_sku | {product_type, components[], subtypes, model_codes, confidence} | part-keyword ladder (เจาะจงก่อนกว้าง); segment→component |
| `import_sellable_units.py` (`main`) | upsert units→Mongo | jsonl | `sellable_units` | upsert idempotent |
| `import_image_texts.py` (`main`, `_image_item_ids`) | upsert OCR→Mongo | jsonl | `image_texts` | — |
| `build_image_texts.py` (`main`, `_collect_worklist`, `_load_done`, `_iter_export_docs`, `_doc_stock`, `_doc_images`, `_fetch_bytes`, `_parse_answer`, `_next_client`, `_extract_one`) | OCR รูปใน description (sellable) | `--max-calls` | `image_texts.jsonl` | Gemini vision per image; resume จาก jsonl; client ต่อ key (กัน closed-transport bug) |
| `build_image_texts_nonsellable.py` (`main`, `_collect_nonsellable`) | OCR เวอร์ชัน non-sellable | `--max-calls` | jsonl | เหมือนด้านบน |
| `build_typo_dict.py` (`main`) | vocab จาก catalog | export | `exports/typo_dict.json` | model-code pattern + gating list → route_context |
| `inspect_stock_certs.py` (`main`) | survey cert fields | STOCK_* env | report stdout | — |
| `refresh_data.sh` | **daily rebuild (cron)** | — | all artifacts | mkdir lock; export→embeddings→units→import→unit/qa emb→OCR sellable+non→import; export fail→abort; ไม่ต้อง restart (mtime reload) |

**เครื่องมืออื่นใน repo:**

| Path | Purpose |
|---|---|
| `docs/adminbase/script/import_adminbase.py` | import `docs/adminbase/*.xlsx` → `knowledge_base` (product_spec + general_faq) |
| `chatbot/testscript/backfill_ai_usage.py` | backfill usage → AI Usage Hub |
| `chatbot/testscript/shadow_openrouter.py` / `test_openrouter_cost.py` / `test_openrouter_full_cost.py` | shadow/cost เทียบ OpenRouter (pattern ที่ or_client fork มา) |
| `chatbot/frontendScript/replay_compare.py` | replay bot vs Zaapi (backend ของ `/replay-compare` API — spawn ผ่าน route) — ใช้ `shadow:` conv id |
| `docs/test/*` | test suite: `testQA2.py`, `test_200.py`, `test_comprehensive.py`, `test_all_conditions.py`, `test_flow.py`, `test_car_charger_regression.py`, `run_daily_tests.py`, `run_fresh_tests.sh`, `check_progress.py`, `diag_car_charger.py`, `analyze_qa_replays.py`, `find_qa_conversations.py` |
| `ChatAdminWeb/scripts/` | `bot-worker.ts` (worker loop), `sync-shops.ts`, `seed-superadmin.mjs`, `generate-all-shadow.ts`, `clear-shadow-replies.ts`, `rollout-workflow.ts`, `test-workflow-*.ts`, `cleanup-test-artifacts.ts`, `soft-delete-all.ts`, `test-ensure-indexes-5.0.mjs` |

### 6.26 `ChatAdminWeb` — Next.js admin console (service-level inventory)

| Service (`src/backend/service/`) | หน้าที่หลัก |
|---|---|
| `botWorkerService` | pipeline poll `messages_shp` → `isProcessed` (chat_processing) → trigger → workflowEngine → callBot → `storeBotReply` (shadow_replies) → `markProcessed`; handoff → assignment |
| `botCallService` | `callBot` → POST `{chatbotBaseUrls[platform]}/chat` — `resolveTicketState` (simulate→test_chat_sessions, จริง→conversations), `shouldUseChatV2/V3`, `llm_context_limit` จาก systemConfig |
| `bufferService` | debounce รวมข้อความ X วิ → 1 bot call (`buffer_messages`) |
| `workflowEngine` / `workflowService` / `templateService` | visual flow builder (แบบ Zaapi): nodes/edges CRUD, resume paused runs, eval conditions, actions (`let_ai_respond`→callBot), `{{var}}` interpolation (pure) |
| `triggerService` | keyword rules → `bot_answer`/`handoff_admin` (`triggers`) |
| `handoffService` | รับ bot-handoff: reopen ถ้า closed → assign admin (คืน admin เดิมก่อนเสมอ) |
| `assignmentService` | round-robin: equal_global / equal_per_shop / weighted (`assignment_configs`/`assignment_cursors`/`shop_team_assignments`/`platform_team_assignments`) |
| `statusConversationService` / `testStatusConversationService` | admin-owned state แยกจาก dump (จริง/`status_conversation`, test/`test_status_conversation`) |
| `shadowReplyService` | `shadow_replies` CRUD — IRON RULE ห้ามส่งจริง/ห้าม platform API |
| `liveAssignmentService` / `testAssignmentService` / `testChatRatingService` / `chatAnnotationService` | live+test assignment (transcript `qa[]`), ratings, dot+note annotations |
| `adminKpiService` | KPI aggregate 3 ระบบ (test-chat, test-assignment, shadow-inbox) |
| `conversationService` / `messageService` / `messageMediaParser` | per-conv storage, `getHistoryForBot`/`getGroupedHistoryForBot`/`toBotText`/`toBotImages`, parse `raw_payload` (item/variation_card/order/sticker/image/video) |
| `knowledgeBaseService` / `personaService` / `shopSettingsService` / `shopService` / `productService` / `customerService` | CRUD KB/persona/shop-settings/shops; products จาก `dbWallet` read-only; customers join `conversations_shp.to_name` |
| `authService` | SSO login/session/logout/admin CRUD (JWT `cc_session`, HS256) |
| `rolePermissionService` | role×page matrix (`system_configs` doc `role_permissions`, seed `DEFAULT_PERMISSIONS`, cache 30s) |
| `systemConfigService` | config switches — สวิตช์อันตราย (live read/send/mark_read/pin/poll) hard-false ใน `safety.ts` |
| `llmConfigService` | `llm_config` doc: key pool encrypt AES-256-GCM (`enc:v1:iv:tag:ct`) + per-role models — bot ถอดด้วย `LLM_MASTER_KEY` เดียวกัน |
| `ticketService` / `quickReplyService` / `closeHistoryService` / `chatAcceptService` / `adminLogService` | tickets, canned replies, close/reopen history (sequence), accept/pause sessions, audit log |
| `lib/*` | `jwt`, `urlSafety`, `safety` (platform API disabled asserts), `rateLimit`, `sanitizeFields`, `config` (env→collections map), `pages` (PAGES registry) |

**API routes (~70, `src/app/api/`):** conversations CRUD + `send`/`assign`/`handoff`/`resolve`/`messages`/`orders` + `bot-handoff` (รับจาก Python) · `shadow-inbox` (+generate-conversation) · `test-chat` (buffer/flush/upload/workflow-step) · `test-assignment` / `live-assignment` / `test-results` / `admin-chat-result` / `admin-review-kpi` · `chat-annotations` · `kb` (+upload/template/toggle) · `triggers` (+match/toggle) · `workflows` (+restore/toggle) · `llm-config` (+models) · `persona` · `shops`/`shop-settings`/`products` · `stats/*` (dashboard/admin-activity/live/performance) · `team`/`users`/`profile`/`permissions` · `auth/sso` · `quick-replies`/`labels`/`contacts` · `replay-compare` (spawn `replay_compare.py`) · `admin/maintenance` · `botworker/*` (internal) · `chatbot/[...path]` proxy

---

## 7. คอนฟิกและตัวแปรสำคัญ

### 7.1 Engine / app

| Env / field | Default | ความหมาย |
|---|---|---|
| `USE_LEGACY_CHAT` | `"1"` | `1`=legacy · อื่น→v2 (req.use_v2/v3 override ได้) |
| `USE_CHAT_V3` | `"0"` | `1`→chatbotv3 ทั้งระบบ |
| `req.use_v2` / `req.use_v3` | None | per-request override (shadowbot/replay) |
| `USE_UNIT_INDEX` | unset | `1`=units ทุก query · `charger`=เฉพาะ charger family · compat bypass เสมอ |
| `USE_QA_KB` | unset | เปิด QA-pair RAG |
| `CHATBOT_INTERNAL_SECRET` | — | คุม internal API ทั้งสองทิศ |
| `ADMIN_HANDOFF_URL` | `http://127.0.0.1:3000/api/admin/conversations/bot-handoff` | handoff endpoint |
| `BOT_MAX_IMAGES_PER_TURN` | `5` | จำกัดรูป/turn ของ vision pass |
| `BOT_VISION_ALLOW_LOOPBACK` | — | อนุญาต loopback image URL (test-chat upload) |
| `req.ticket_state` | — | `open|closed|handoff|resolved|pending` — คุม post-handoff silence |
| `req.simulate_assignment` | False | handoff→`test_status_conversation` แทน conversations จริง |
| `req.llm_context_limit` | 30 (10-50) | จำนวนสินค้าสูงสุดใน LLM ctx (หน้า config ตั้ง) |

### 7.2 LLM (Gemini)

| Env | ความหมาย |
|---|---|
| `GEMINI_API_KEY` / `GEMINI_API_KEY_1..9` | key pool (baseline/fallback เมื่อ `key_source.gemini=env`) |
| `GEMINI_MODEL` | model ตอบหลัก (default `gemini-3.5-flash-lite`) |
| `GEMINI_VISION_MODEL` | vision (default `gemini-3.1-flash-lite`) |
| `GEMINI_RPD` / `GEMINI_RPM` / `GEMINI_TPM` | quota ต่อ key: requests/day, requests/min, tokens/min |
| `LLM_MASTER_KEY` | AES-256-GCM master (64-hex หรือ passphrase→sha256) — ถอด `llm_config` keys |
| `EMBEDDING_DEVICE` | `cpu`/`cuda` สำหรับ sentence-transformers |

### 7.3 OpenRouter / web search / v3

| Env | ความหมาย |
|---|---|
| `OPENROUTER_API_KEY` / `OPENROUTER_API_KEY_1..9` | key pool (v3 + web_search — web ใช้ `llm_config.openrouter_keys` ก่อน) |
| `OPENROUTER_BASE_URL` | default `https://openrouter.ai/api/v1` |
| `OPENROUTER_SEARCH_MODEL` | model ของ web search extract |
| `OPENROUTER_REFERER` / `OPENROUTER_APP_TITLE` | headers |
| `CHATBOTV3_MODEL` / `CHATBOTV3_VISION_MODEL` | v3 models (default `google/gemini-2.5-flash:online` / `google/gemini-3.1-flash-lite`) |
| `AI_USAGE_HUB_URL` / `AI_USAGE_HUB_TOKEN` | usage log endpoint + `x-service-token` |

### 7.4 MongoDB

| Env | ความหมาย |
|---|---|
| `MONGO_URI` หรือ `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD`/`MONGO_TLS`/`MONGO_AUTH_SOURCE` | product DB conn |
| `MONGO_DB` / `MONGO_COLLECTION` | `dbWallet` / `ShpProducts` |
| `ADMIN_MONGO_URI` หรือ `ADMIN_MONGO_HOST`/`ADMIN_MONGO_USERNAME`/`ADMIN_MONGO_PASSWORD`/`ADMIN_MONGO_TLS`/`ADMIN_MONGO_AUTH_SOURCE` + `ADMIN_MONGO_DB` | admin DB conn (`chatbot_admin`) |
| `ADMIN_MONGO_COLLECTION_KB` / `_KB_PRODUCTS` / `_KB_QA` / `_UNITS` / `_TEST_CHAT_SESSIONS` | collection name overrides |
| `ORDER_URI_MONGO` / `ORDER_DB` / `ORDER_COLLECTION` | order DB (default `ShpOrders`) |
| `STOCK_URI` / `STOCK_DB` | stock/cert DB (`itStock`) |

### 7.5 ChatAdminWeb (Next.js)

| Env | ความหมาย |
|---|---|
| `ADMIN_JWT_SECRET` | session JWT (HS256, cookie `cc_session`) |
| `ADMIN_SESSION_TIMEOUT_HOURS` | session ttl (default 8) |
| `CHATBOT_BASE_URL` / `CHATBOT_BASE_URL_SHOPEE` / `_LAZADA` / `_TIKTOK` | bot base URLs (8010/8011/8012 — Shopee fallback `CHATBOT_BASE_URL`) |
| `ADMIN_MONGO_COLLECTION_*` | 34 collection name overrides (map เต็มใน `lib/config.ts`, ดู schema.md §1.2) |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | email |

`system_configs` runtime docs: `llm_config` — `{keys:[], models:{chat,vision,intent,openrouter_search}, key_source:{gemini: env|single|db}}` — UI `/llm`, bot อ่าน TTL 10s, ไม่มี→env fallback · `role_permissions` — `{roles:[{key,label,builtin}], permissions:{page:{role:none|read|edit}}}` — UI `/roles`, cache 30s, ไม่มี→`DEFAULT_PERMISSIONS`

---

## 8. สถานะปัจจุบัน

### 8.1 ใช้งานจริง

- ✅ Shopee bot `shopeechat/` :8010 — legacy default + v2/v3 flag-gated
- ✅ Hybrid retrieval: type regex → vector (npz) → relax → category fallback + model-regex pre-filter + false-positive filter + `_dedupe_products` sellable-first
- ✅ Sellable-unit index (`sellable_units` ~27.8k docs + `units.py`) — `USE_UNIT_INDEX` gated, compat bypass, fallback listing
- ✅ Device compat: `DEVICE_SPECS` ~516 entries + source ladder (spec-db→re-query→catalog evidence→web) + connector hard filter + adequate-first watt sort + `_charging_scope`
- ✅ Cert search: TISI/มอก./CE/CCC/FCC/RoHS/GB — desc + OCR `image_texts` + `itStock` flags + variant tokens, boundary anti-FP
- ✅ Order flow: order_sn/tracking/return-refund + order anchors + `auto_check_delivery_warranty`
- ✅ Warranty claim SM (State 0-7) + post-handoff silence (`ticket_state`) + รับรูป evidence
- ✅ Vision pass multimodal + `image_desc` carry-forward (ไม่อ่านซ้ำ)
- ✅ Language policy: ไทยเสมอ (เว้นขอภาษาอื่น→อังกฤษ)
- ✅ Output guard `guards.enforce` ครอบทุก engine (+ observe-only `check_output` ใน model_post_init)
- ✅ Web search fallback + URL strip + uncertainty detect + spec-db gate
- ✅ Shadow isolation: `shadow:` conv id + `simulate_assignment` → `test_status_conversation`
- ✅ ChatAdminWeb: inbox cursor pagination, dashboard index+cache, `/roles` matrix, `/llm` AES-GCM key pool + per-role models, test/live assignment, shadow inbox, annotations, KPI, workflow builder, bot-worker + buffer debounce
- ✅ `refresh_data.sh` cron pipeline (incremental OCR, mtime reload ไม่ต้อง restart)

### 8.2 Placeholder / ยังไม่ใช้

- ⚠️ `lazadachat/` `tiktokchat/` — ports 8011/8012 ว่าง
- ⚠️ collections `guardrails`/`auth_tokens`/`pushevents`/`requestlogs`/`tickets` — ประกาศไว้แต่ไม่ใช้
- ⚠️ chatbotv3 ไม่ใช่ default (เข้า traffic ผ่าน flag เท่านั้น)
- ⚠️ `v3._extract_image_desc_from_answer` — stub คืน "" เสมอ

---

## 9. แผนอนาคต

### 9.1 ระยะสั้น (active plans)

| Plan | สาระ | ไฟล์ |
|---|---|---|
| Retrieval hybrid rerank v2 | ลบ query-time regex → pipeline เดียวเหนือ 2 data sources | `docs/plans/2026-09-21-retrieval-hybrid-rerank-plan.md` |
| QA remaining bugs | RC-A trust boundary / RC-B claim slots / RC-C keyword whack-a-mole / RC-D error leak / RC-E measurement — 16 tasks | `docs/plans/2026-09-21-qa-remaining-bugs-plan.md` |

### 9.2 ระยะกลาง

| งาน | รายละเอียด |
|---|---|
| Lazada/TikTok | implement `lazadachat/` `tiktokchat/` (ports/URL/config พร้อม) |
| chatbotv3 hardening | เพิ่ม compat/spec-db/unit path หรือพิสูจน์ LLM-first เพียงพอผ่าน shadow eval |
| chat_v2 callee fix | แก้ 3 callsite: `kb.get_general_context`→`build_general_context`, เติม `add_item_anchor`/`get_timeline` หรือเปลี่ยนไป `add_product`/`load_timeline` (§10#1) |

### 9.3 ระยะยาว

| งาน | รายละเอียด |
|---|---|
| Streaming response | ลด latency |
| A/B prompt framework | เทียบ prompt versions |
| Observability dashboard | usage/cost/latency realtime |
| Multi-lingual | อังกฤษ/จีน |

---

## 10. ปัญหาที่ทราบ + แนวทางแก้

| # | ปัญหา | สาเหตุ | สถานะ/แนวทาง | ที่ |
|---|---|---|---|---|
| 1 | chat_v2 เรียก callee ที่ไม่มี 3 จุด | (a) `knowledge_base.get_general_context` ไม่มี (ของจริง `build_general_context`) → **AttributeError ลอย = 500 ทุก general question ใน v2** · (b) `_cp.add_item_anchor` (c) `_cp.get_timeline` ไม่มีใน `conversation_products.py` → try/except กลืน = anchor persist + follow-up no-op เงียบ | ❌ ยังไม่แก้ — (a) rename→`build_general_context`; (b/c) เติม methods หรือเปลี่ยนไป `add_product`/`load_timeline` | `chat_v2._check_general_question`, `_detect_anchor`, `_detect_followup_products` |
| 2 | `client.close()` บน shared cached client → race 500 | `get_client`/`_db` คืน cached singleton แต่บางจุด close | ❌ latent (เคส #123-160 ชน 429 ก่อนเห็น) | `app.py` หลายจุด, `chat_v2` finally |
| 3 | "เสีย" substring ใน `_CLAIM_REQUEST_INDICATORS` | "เสียงดีสุด" match เคลมถ้า intent fail | ❌ latent | `warranty.detect_claim_request` |
| 4 | error path leak `{exc}` ถึงลูกค้า | ตอบ exception ดิบ | ❌ (RC-D/T1 ใน plan) | `llm.py` error paths |
| 5 | ไม่มี post-check นโยบาย (เปลี่ยน/คืน/ฟรี/โปร/แถม) | `guards.check_output` observe-only บาง flag | ❌ (RC-A/NEW-3) | `guards.py` |
| 6 | anchor ไม่ใช้ `image_desc` | การ์ดไม่ผูก desc รูป | ❌ NEW-6 | `app.py` |
| 7 | ไม่มี suppression การ์ดตาม intent | การ์ดแนบแม้ถามทั่วไป | ❌ NEW-7 | `_chat_impl` |
| 8 | ไม่มี cap prompt tokens | context ใหญ่ไม่จำกัด | ❌ BUG-I | `llm._build_context` |
| 9 | NER fallback regex ลบ "ค"/"ชื่อ" ผิด | ชื่อขยะใน claim slots | 🟡 (RC-B/T2) | `warranty.extract_customer_info` |
| 10 | handoff keywords ขาดบางรูปแบบ | "ติดต่อเจ้าหน้าที่/แชทกับเจ้าหน้าที่" | 🟡 BUG-M (T3) | `handoffs.py`, `llm` post-check |
| 11 | BUG-A charging re-query เชื่อ web "charger" | scope ผิดหมวด | ✅ แก้แล้ว `_charging_scope`+spec-db ladder | `device_compat.py` |
| 12 | Shadow gen เขียนทับ state จริง | conv_id จริง | ✅ แก้แล้ว `shadow:`+`simulate` | callOurBot ×3 |
| 13 | live-assignment 500 / inbox หน่วง | `updated_at` missing + no projection | ✅ แก้แล้ว (backfill+cursor fallback+$slice) | ChatAdminWeb |
| 14 | 429 RESOURCE_EXHAUSTED ท้ายรัน | quota/key จำกัด | ops — user จัดการ | Gemini keys |
| 15 | `test_compat_mode_filter.py` ถูก watcher revert | IDE watcher | ⚠️ เขียน atomic ผ่าน shell | tooling |
| 16 | v3 ไม่มี image_desc | `_extract_image_desc_from_answer` stub | ❌ minor | `chatbotv3/engine.py` |

---

## ภาคผนวก: Call Graph สำคัญ

### `chat()` (ทุก engine)

```
chat(req) → _chat_impl(req) → [v3|v2|legacy] → guards.enforce(resp, req) → ChatResponse
                                              ↑ ChatResponse.model_post_init → check_output (observe)
```

### Legacy `_chat_impl` → โมดูลหลัก

```
route_context.resolve_route
llm.describe_images (vision)
_extract_item_id_tag → product_store.fetch_product_by_id → conversation_products (anchor)
handoffs.detect_human_request → responses._send_handoff
order_flow.early_order_flow → order_store.lookup_order/lookup_by_tracking → conversation_products.add_order_anchor
warranty.auto_check_delivery_warranty → warranty_flow.handle_warranty_flow → claim_state
intent_classifier.should_run_pass1 → classify_intent
handoffs.post_intent_handoffs → product_store.search_cert_products
knowledge_base.detect_general_question → build_general_context → llm.answer_general
knowledge_base._detect_brand_question → _build_brand_context → answer_general
conversation_products.resolve_active_by_message / get_previous_anchor / get_latest_suggestion_batch
knowledge_base.lookup_kb → _merge_kb_mongo
product_store.fetch_products → [units.fetch_unit_cards | vector_search | regex] → _dedupe_products
device_compat._device_spec_lookup → _filter_compat_products → _apply_product_tiers
web_search.should_use_web_search → search_and_extract → reanswer
llm.answer → _append_base_warranty → _record_suggestion_products
```

### `fetch_products` ภายใน

```
USE_UNIT_INDEX? → units.fetch_unit_cards → (empty/err) → listing path
→ _detect_product_types(_fuzzy) + _detect_charger_subtype + build_query
→ vector_search (npz) | mongo regex → _filter_charger_subtype
→ _filter_false_positives → relax price → relax item-name → category fallback
→ _rerank_by_promo_latest / _rerank_with_diversity → _dedupe_products → to_product_card
```

### `device_compat._device_spec_lookup` ladder

```
extract device token → _compat_mode
  → _lookup_spec_db (DEVICE_SPECS + aliases + brand guard)      [ฟรี ด่าน 1]
  → re-query derive: _charging_scope + _CONN_QUERY_KW synonyms  [ด่าน 2]
  → catalog evidence: _device_mentioned บน name/desc            [ด่าน 3]
  → web_search.search_and_extract (structured เท่านั้น)          [ด่าน 4 จ่ายเงิน]
  → intent.min_watt                                              [สำรอง]
→ _filter_compat_products (connector hard filter)
→ _apply_product_tiers (adequate-first, baseline+upgrade ≤2)
```

### Handoff (ทุก engine)

```
responses._send_handoff / engine._send_handoff_to_admin
  → POST ADMIN_HANDOFF_URL (X-Internal-Secret)
    simulate=true  → test_status_conversation (แยกจากจริง)
    simulate=false → conversations + status_conversation + assign admin
```

### Shadow/test isolation

```
callOurBot (shadow-inbox / generate-conversation / generate-all-shadow / replay_compare)
  → conversation_id = "shadow:"+id, simulate_assignment=true
  → writes ทั้งหมดลง "shadow:" key; handoff → test_status_conversation
```
