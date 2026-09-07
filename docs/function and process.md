# Function and Process — หลักการทำงานของระบบ ChatBotProductMS

เอกสารนี้อธิบายหลักการทำงานของทุกหน้าใน Admin Console, บอท, และกระบวนการย่อยทั้งหมด
อ้างอิงจากโค้ดจริงใน `ChatAdminWeb/` (Next.js) และ `chatbot/shopeechat/` (Python FastAPI)

---

## สารบัญ

1. [ภาพรวมระบบ](#1-ภาพรวมระบบ)
2. [หน้า Console ทั้งหมด](#2-หน้า-console-ทั้งหมด)
3. [บอท — หลักการทำงาน](#3-บอท--หลักการทำงาน)
4. [Bot Worker Pipeline](#4-bot-worker-pipeline)
5. [Buffer / Flush / Debounce](#5-buffer--flush--debounce)
6. [Workflow Engine](#6-workflow-engine)
7. [Trigger](#7-trigger)
8. [Image Input (Vision)](#8-image-input-vision)
9. [History Retrieval](#9-history-retrieval)
10. [Round-Robin Assignment](#10-round-robin-assignment)
11. [Handoff / Close / Reopen Lifecycle](#11-handoff--close--reopen-lifecycle)
12. [Configuration Loading](#12-configuration-loading)
13. [Cache & Polling](#13-cache--polling)
14. [Audit Logging](#14-audit-logging)
15. [Shadow Inbox / Replay Compare](#15-shadow-inbox--replay-compare)
16. [Test Chat](#16-test-chat)
17. [Phases สำคัญ](#17-phases-สำคัญ)

---

## 1. ภาพรวมระบบ

ระบบประกอบด้วย 3 ส่วนหลัก:

| ส่วน | เทคโนโลยี | หน้าที่ |
|------|----------|---------|
| Admin Console | Next.js 16 + TypeScript | หน้า UI สำหรับแอดมินจัดการแชท, ตั้งค่า, ดู log |
| Python Chatbot | FastAPI + Gemini LLM | ประมวลผลคำถามลูกค้า, ดึงสินค้า, ตอบ, ส่งต่อแอดมิน |
| MongoDB | admin DB + product DB (dbWallet) | เก็บ conversations, messages, config, products, orders |

### Data flow หลัก

```
ลูกค้าส่งข้อความ (ผ่าน sellcenter/Zaapi)
  ↓
data writer เขียนลง messages collection (role=user, direction=in)
  ↓
Bot Worker poll → buffer → processMessage
  ↓
workflow → trigger → bot (call Python /chat) → handoff (ถ้าต้อง)
  ↓
คำตอบเก็บใน shadow_replies (ไม่ส่งจริง — เปรียบเทียบกับ Zaapi)
  ↓
แอดมินเห็นใน /tickets, /botworker, /shadow-inbox
```

### แยก source of truth สำคัญ

- `conversations` — ข้อมูลแชทหลัก (โดน sellcenter dump ทับทุก 2 วินาที)
- `status_conversation` — admin-owned meta (assigned_to, status, closed_at) — ไม่โดน dump ทับ
- `test_status_conversation` — test version สำหรับ botworker/shadow/test-assignment (แยก source)

---

## 2. หน้า Console ทั้งหมด

หน้าทั้งหมดอยู่ใน `ChatAdminWeb/src/app/(console)/`

### 2.1 `/tickets` — Inbox หลัก

**ไฟล์:** `src/app/(console)/tickets/page.tsx`

หน้า inbox หลักสำหรับแอดมินตอบแชทจริง

**API ที่ใช้:**
- `GET /admin/conversations?assigned_to=...&limit=2000&include_count=true` — รายการแชท (ผ่าน `useSharedConversations`)
- `GET /users/list` — รายชื่อแอดมิน
- `GET /admin/conversations/{id}/messages?all=1` — ดึง message ทั้งหมด
- `GET /admin/conversations/{id}/messages?after=...` — pagination
- `POST /admin/conversations/{id}/send` — ส่งข้อความ (เขียน DB เท่านั้น ไม่ส่งจริง)
- `POST /admin/conversations/{id}/assign` — รับเป็นเจ้าของ
- `POST /admin/conversations/{id}/handoff` — ส่งต่อ admin อื่น
- `POST /conversations/{id}/close` — ปิดแชท
- `POST /conversations/{id}/reopen` — เปิดใหม่
- `GET /conversations/{id}/close-history` — ประวัติปิด/เปิด
- `PATCH /profile/accepting-chats` — toggle รับแชท

**Polling:**
- Shared conversation list: 3 วินาที (ผ่าน `useSharedConversations`)
- Messages: 2 วินาที (`usePolling`)

**ทำอะไร:**
- ดูรายการแชท (filter ตาม assigned_to, platform, status, search)
- อ่าน message, ส่ง reply, assign ให้ตัวเอง, handoff, close/reopen
- Conflict detection (ถ้าคนอื่น assign ไปแล้ว)
- Optimistic update ทุก action (close, reopen, handoff, transfer, assign)

**Collection ที่ใช้:**
- `conversations` (read — list/preview)
- `status_conversation` (read/write — assigned_to, status, close_count)
- `messages` (read — chat log, write — admin reply)
- `admins` (read — admin list)
- `close_history` (read — ประวัติปิด/เปิด)
- `admin_logs` (write — ทุก action)

### 2.2 `/botworker` — Bot Worker Monitor

**ไฟล์:** `src/app/(console)/botworker/page.tsx`

หน้า monitor การทำงานของบอท (อ่านอย่างเดียว — ไม่มี composer)

**API:**
- `GET /botworker/conversations?limit=2000` — รายการแชท (status จาก `test_status_conversation` source=botworker)
- `GET /botworker/conversations/{id}/messages?limit=200` — message + shadow replies
- `GET /users/list`, `POST /assignment/reassign`
- `chatService.close/reopen/handoff/closeHistory/setAcceptingChats`

**Polling:**
- Conversations: 3 วินาที
- Messages: 3 วินาที
- Request timeout: 45s (conversations), 30s (messages)

**ทำอะไร:**
- ดูสถานะบอท (กำลังตอบ, handoff, ปิดแล้ว)
- ดู unified message (user + zaapi + bot shadow reply)
- Close/reopen/handoff/transfer/accept toggle
- **ไม่มี composer** — อ่านอย่างเดียว

**Collection:**
- `conversations` (read)
- `test_status_conversation` source=botworker (read/write — status/assigned_to)
- `messages` (read)
- `shadow_replies` (read — คำตอบบอท)
- `close_history` (read)
- `admins` (read)

### 2.3 `/shadow-inbox` — Shadow Reply Rating

**ไฟล์:** `src/app/(console)/shadow-inbox/page.tsx`

หน้าดู/ให้คะแนน shadow reply (คำตอบบอทที่ไม่ส่งจริง)

**API:**
- `GET /shadow-inbox/conversations` — รายการแชทที่มี shadow reply
- `GET /shadow-inbox` — รายการ shadow reply (filter origin, mode, rating)
- `GET /shadow-inbox?stats=1` — สถิติ
- `GET /shadow-inbox/{id}` — รายละเอียด
- `PATCH /shadow-inbox/{id}` — rate/star/comment
- `POST /shadow-inbox` — generate shadow reply
- `DELETE /shadow-inbox?clear_all=1` — ล้างทั้งหมด
- `DELETE /shadow-inbox/{id}` — soft delete
- `POST /shadow-inbox/{id}?action=restore` — restore
- `PUT /shadow-inbox?action=restore_all` — restore ทั้งหมด
- `GET /admin/conversations` (ผ่าน shared store สำหรับ tab "ทั้งหมด")

**Polling:**
- Shared store (tab "ทั้งหมด"): 3 วินาที
- Shadow list: 10 วินาที (20 วินาที สำหรับ history tab)
- Stats: 30 วินาที

**Collection:**
- `shadow_replies` (read/write/edit/delete)
- `conversations` (read — สำหรับ tab ทั้งหมด)
- `messages` (read — ดู context)

### 2.4 `/replay-compare` — Bot vs Zaapi

**ไฟล์:** `src/app/(console)/replay-compare/page.tsx`

หน้าเปรียบเทียบคำตอบบอทกับ Zaapi (replay)

**API:**
- `GET /replay-compare` — ไฟล์ replay, QA items, analysis, history
- `GET /admin/conversations?assigned_to=all&limit=10000` — รายการแชท
- `GET /admin/conversations/{id}/messages` — message ของแชท
- `POST /replay-compare` — run replay

**Polling:** 5s/10s สำหรับ poll ไฟล์

**Collection:**
- `test_assignment` (read/write — replay results + ratings)
- `conversations` (read)
- `messages` (read)

### 2.5 `/test-assignment` — Test Assignment

**ไฟล์:** `src/app/(console)/test-assignment/page.tsx`

หน้าทดสอบการจ่ายงาน (replay + rate)

**API:**
- `GET /test-assignment?list=1` — รายการ
- `GET /test-assignment` — status
- `GET /test-assignment?stats=1` — สถิติ
- `GET /test-assignment?conv_detail=...` — รายละเอียด
- `POST /test-assignment` action=replay_conversation — replay
- `POST /test-assignment` — rate message/conversation

**Polling:** stats 10 วินาที

**Collection:**
- `test_assignment` (read/write)
- `test_status_conversation` (read/write)
- `conversations` (read)
- `messages` (read)

### 2.6 `/test-chat/{shopee,tiktok,lazada}` — Test Chat

**ไฟล์:** `src/app/(console)/test-chat/{platform}/page.tsx` → render `TestChatClient`

หน้าจำลองแชทเพื่อทดสอบบอท/trigger/workflow/buffer

**API (ใน TestChatClient):**
- `GET/POST /chatbot/shopee/test-chat/sessions` — session CRUD
- `GET/DELETE /chatbot/shopee/test-chat/sessions/{id}`
- `POST /chatbot/shopee/test-chat/sessions/{id}/messages` — ส่งข้อความ
- `PUT /chatbot/shopee/test-chat/sessions/{id}` — update
- `POST /chatbot/shopee/test-chat/sessions/{id}/close` — ปิด
- `GET/POST /test-chat-ratings` — rate
- `GET /chatbot/shops` — ร้าน
- `GET /test-chat/buffer-status` — สถานะ buffer
- `POST /chatbot/feedback` — feedback
- `POST /test-chat/upload` — อัปโหลดรูป
- `POST /test-chat/buffer` — ทดสอบ buffer
- `POST /triggers/match` — ทดสอบ trigger
- `POST /admin/conversations/bot-handoff` — handoff
- `POST /chatbot/chat` — เรียกบอท
- `POST /test-chat/workflow-step` — ทดสอบ workflow

**Polling:** ไม่มี (manual)

**Collection:**
- `test_chat_sessions` (read/write — Python เขียนหลัก)
- `test_chat_ratings` (read/write)
- `test_chat_uploads` (read/write)
- `buffer_messages` (read/write — test buffer)
- `test_status_conversation` (write — handoff test)
- `test_chat_logs` (write — Python log)

### 2.7 `/workflows` + `/workflows/[workflowId]`

**ไฟล์:**
- `src/app/(console)/workflows/page.tsx` — list
- `src/app/(console)/workflows/[workflowId]/page.tsx` → `WorkflowEditor`

**API:**
- `GET /workflows` — list
- `POST /workflows` — create
- `GET /workflows/{id}` — detail
- `PATCH /workflows/{id}` — rename
- `POST /workflows/{id}/toggle` — enable/disable
- `DELETE /workflows/{id}` — soft delete
- `POST /workflows/{id}/restore` — restore
- `GET /shops`, `GET /labels`

**Polling:** ไม่มี

**Collection:**
- `workflows` (read/write/edit/delete/toggle)
- `workflow_runs` (read — ดู run history)
- `shops` (read)

### 2.8 `/triggers`

**ไฟล์:** `src/app/(console)/triggers/page.tsx`

**API:**
- `GET /triggers` — list
- `POST /triggers` — create
- `PATCH /triggers/{id}` — update
- `POST /triggers/{id}/toggle` — toggle
- `DELETE /triggers/{id}` — soft delete
- `GET /shops`, `GET /users/list`

**Collection:**
- `triggers` (read/write/edit/delete/toggle)
- `shops` (read)
- `admins` (read)

### 2.9 `/knowledge` — Knowledge Base

**ไฟล์:** `src/app/(console)/knowledge/page.tsx`

**API:**
- `GET /kb` — list (filter type, search, platform, active)
- `POST /kb` — create general_faq
- `PUT /kb/{id}` — update
- `DELETE /kb/{id}` — soft delete
- `PATCH /kb/{id}/toggle` — toggle active
- `POST /kb/upload` — upload Excel product_spec
- `GET /users/list`

**Collection:**
- `knowledge_base` (read/write/edit/delete/toggle)
- `admins` (read)

### 2.10 `/persona`

**ไฟล์:** `src/app/(console)/persona/page.tsx`

**API:**
- `GET /persona` — list
- `POST /persona` — upsert
- `PATCH /persona/{id}` — update
- `DELETE /persona/{id}` — soft delete
- `GET /chatbot/shops`

**Collection:**
- `shop_personas` (read/write/edit/delete)
- `shops` (read)

### 2.11 `/shops`

**ไฟล์:** `src/app/(console)/shops/page.tsx`

**API:**
- `GET /shops` — list (debounce 300ms, composite key `${platform}-${shop_id}`)
- เปิด `ShopDetailDrawer` — inline edit cards สำหรับ workflow/trigger/persona/KB ของร้าน

**Collection:**
- `shops` (read)
- `workflows`, `triggers`, `shop_personas`, `knowledge_base` (read — ใน drawer)

### 2.12 `/shop-settings`

**ไฟล์:** `src/app/(console)/shop-settings/page.tsx`

**API:**
- `GET /shop-settings` — list
- `POST /shop-settings` — upsert (single + batch)
- `DELETE /shop-settings/{id}` — soft delete
- `GET /admin/logs?action_type=shop_settings` — log
- `GET /chatbot/shops`

**Collection:**
- `shop_settings` (read/write/edit/delete)
- `admin_logs` (read)
- `shops` (read)

### 2.13 `/quick-replies`

**ไฟล์:** `src/app/(console)/quick-replies/page.tsx`

**API:**
- `GET /quick-replies` — list
- `POST /quick-replies` — create
- `PUT /quick-replies/{id}` — update
- `DELETE /quick-replies/{id}` — soft delete
- `GET /shops`, `GET /users/list`

**Collection:**
- `quick_replies` (read/write/edit/delete)
- `shops`, `admins` (read)

### 2.14 `/admin-config` — Admin Configuration

**ไฟล์:** `src/app/(console)/admin-config/page.tsx`

**API:**
- `GET /admin-config` — อ่าน config (requireEditor)
- `PUT /admin-config` — อัปเดต (requireEditor)

**ทำอะไร:** ปรับ buffer config, workflow engine, assignment preference
- `bot_buffer_enabled`, `bot_buffer_window_ms`, `bot_buffer_max_messages`
- `bot_buffer_window_media_ms`, `bot_buffer_max_media_messages`
- `bot_concurrency_limit`
- `workflow_enabled`, `workflow_priority`, `workflow_run_timeout_ms`
- `assignment_prefer_previous_admin`

**Collection:**
- `system_configs` (read/write)
- `admin_logs` (write)

### 2.15 `/config` — System Config (Superadmin)

**ไฟล์:** `src/app/(console)/config/page.tsx`

**API:**
- `GET /config` — อ่าน (requireSuperadmin)
- `PUT /config` — อัปเดต
- `PATCH /config/shop/{shopId}` — toggle shop
- `POST /config/test-integration` — health check
- `GET /shops`

**ทำอะไร:** สวิตช์อันตราย (live read/send/mark_read/pin/poll), mock mode, shadow bot, bot worker, polling interval, bot URLs, toggle ร้าน

**Collection:**
- `system_configs` (read/write)
- `shops` (read/write — toggle enabled_for_chat)
- `admin_logs` (write)

### 2.16 `/team` — Team & Assignment

**ไฟล์:** `src/app/(console)/team/page.tsx`

**API:**
- `GET /team` — agents + workload
- `GET /shops`, `GET /assignment/shop-team`, `GET /assignment/platform-team`
- `GET /team/chat-status` — สถานะรับแชท
- `PUT /assignment/config` — เปลี่ยน mode
- `POST/DELETE /assignment/shop-team` — เพิ่ม/นำ agent ออก
- `POST/DELETE /assignment/platform-team`

**Collection:**
- `admins` (read)
- `assignment_configs` (read/write)
- `shop_team_assignments` (read/write/delete)
- `platform_team_assignments` (read/write/delete)
- `chat_accept_sessions` (read)
- `shops` (read)

### 2.17 `/users`

**ไฟล์:** `src/app/(console)/users/page.tsx`

**API:**
- `GET /users/list` — list
- `PATCH /users/{id}` — toggle active

**Collection:**
- `admins` (read/write)
- `sessions` (write — revoke all ถ้า deactivate)
- `admin_logs` (write)

### 2.18 `/logs` — Audit Logs

**ไฟล์:** `src/app/(console)/logs/page.tsx`

**API:**
- `GET /admin/logs` — list (filter admin, action, search)
- `GET /users/list`

**Polling:** 5 วินาที

**View mode (⚡ v2):**
- **ลิสต์** (default) — card list แบบเดิม คลิก row expand ดู metadata
- **ตาราง** — table view แสดงทุก field จริงใน `AdminLogDoc`: `timestamp`, `action_type`, `actor`/`admin_id`, `target_admin_id`, `conversation_id`, `shop_id`, `ticket_id`, `ip`, `meta` (key count), `metadata` (key count) — คลิก row expand ดู `metadata` + `meta` แบบเต็ม
- สลับด้วย tab ด้านขวาบน (List / Table2 icon)
- filter (admin, หมวด, search) ใช้ร่วมกันทั้ง 2 view

**Collection:**
- `admin_logs` (read)
- `admins` (read — $lookup username)

### 2.19 `/contacts`

**ไฟล์:** `src/app/(console)/contacts/page.tsx`

**API:** `GET /contacts` — list (debounce 300ms, composite key `${platform}-${buyer_id}`)

**Collection:**
- `customers` (read)
- `conversations` (read — ดึง name ถ้า customers ไม่มี)

### 2.20 `/dashboard`

**ไฟล์:** `src/app/(console)/dashboard/page.tsx`

**API:** `GET /stats/dashboard`

**Collection:** อ่านผ่าน stats aggregate (conversations, messages, etc.)

### 2.21 `/analytics/{performance,live,admin-activity}`

**ไฟล์:**
- `analytics/performance/page.tsx` — `GET /stats/performance`
- `analytics/live/page.tsx` — `GET /stats/live` (poll 30s + tick 1s)
- `analytics/admin-activity/page.tsx` — `GET /stats/admin-activity`

### 2.22 `/settings` — Profile

**ไฟล์:** `src/app/(console)/settings/page.tsx`

**API:** `PATCH /profile` — แก้ไขชื่อ

**Collection:** `admins` (write)

### 2.23 `/test-results`

**ไฟล์:** `src/app/(console)/test-results/page.tsx`

**API:** `GET /test-results?mode=list`, `GET /test-results?file=...`

### 2.24 Redirect

- `/chats` → `/tickets`
- `/analytics` → `/analytics/performance`

---

## 3. บอท — หลักการทำงาน

บอทอยู่ใน `chatbot/shopeechat/app.py` (FastAPI)

### 3.1 Endpoints

| Method | Path | หน้าที่ |
|--------|------|---------|
| GET | `/health` | ตรวจสุขภาพ + แสดงจำนวนร้าน/หมวด |
| GET | `/` | หน้าเว็บทดลอง |
| GET | `/shops` | รายชื่อร้าน |
| GET | `/categories` | รายชื่อหมวด |
| GET | `/brands` | รายชื่อแบรนด์ (pagination) |
| POST | `/chat` | รับคำถาม → ตอบ (endpoint หลัก) |
| GET/POST/PUT/DELETE | `/test-chat/sessions/*` | test chat session CRUD |
| POST | `/test-chat/sessions/{id}/close` | ปิด session |
| POST | `/test-chat/sessions/{id}/reopen` | เปิดใหม่ |
| GET | `/test-chat/logs` | ดู log |
| POST | `/feedback` | รับ feedback |

### 3.2 Middleware

- ทุก endpoint (ยกเว้น `/health`, `/`, `/static/*`) ต้องมี header `X-Internal-Secret` ตรงกับ `CHATBOT_INTERNAL_SECRET`
- ถ้าไม่ตั้งค่าใน env (dev) → allow แต่ warn

### 3.3 Startup warmup

- โหลด embedding model
- โหลด vector store
- เชื่อม MongoDB (product + admin)

### 3.4 `/chat` — Text Input Flow

**ไฟล์:** `app.py` บรรทัด 412+ (ฟังก์ชัน `chat()`)

ขั้นตอนการประมวลผลคำถามลูกค้า:

```
1. ดึง persona ของร้าน (persona.get_persona)
   → ถ้ามี → สร้าง persona_extra สำหรับ system instruction

2. Multimodal Vision Pass (ถ้ามีรูป)
   → รวมรูปจาก history (ที่มี image_desc ใช้เลย, ที่ไม่มีอ่านใหม่)
   → รวมรูปจาก turn ปัจจุบัน
   → เรียก llm.describe_images → ได้ _vision_context

3. ตรวจ item_id tag (ลูกค้าแชร์การ์ดสินค้า)
   → ถ้ามี → fetch_product_by_id → ตอบจากสินค้านั้นโดยตรง
   → บันทึก anchor product ลง conversation_products

4. Order lookup (ถ้ามี order_sn หรือ tracking_no)
   → ถ้าเป็น claim request → ข้าม (ไป warranty auto-check)
   → ถ้าไม่ใช่ → lookup_order → ตอบจาก order context

5. Tracking lookup (ถ้ามี tracking_no ในข้อความหรือ vision desc)

6. ตรวจคำถามทั่วไป (policy/brands/categories)
   → detect_general_question
   → ถ้าเป็น follow-up (warranty/return + history มีสินค้า) → ดึงสินค้าจาก history

7. Tax invoice → handoff แอดมินเลย (ก่อน claim_request)

8. Warranty auto-check (ถ้า claim + order_sn)
   → auto_check_warranty → คำนวณระยะประกัน

9. Pass 1: Intent Classification (LLM)
   → ถ้า hardcoded detection ไม่มั่นใจ → เรียก LLM จำแนก intent
   → override claim_request ถ้า LLM บอกต่าง (ยกเว้น strong complaint / repeated complaint)

10. Claim request flow (warranty claim state machine)
    → detect_claim_request → warranty.run_claim_flow
    → ถ้าครบข้อมูล → handoff_to_admin=True

11. General question (policy/return/shipping)
    → ตอบจาก KB general_faq

12. Product retrieval (RAG)
    → detect product_type + charger_subtype
    → vector search (embedding) + filter shop
    → ส่งให้ LLM ตอบ

13. Web search fallback (ด่านสุดท้าย)
    → ถ้าคำตอบไม่มั่นใจ → OpenRouter + Google Search

14. ส่งคำตอบกลับ (ChatResponse)
    → answer, products, source, usage, cost, elapsed
    → answer_segments (multi-bubble)
    → handoff_to_admin, handoff_reason, handoff_claim
    → image_desc (ส่งกลับให้ caller เก็บใน message doc)
    → routing_decision (observability)
```

### 3.5 LLM

**ไฟล์:** `chatbot/shopeechat/llm.py`

- Provider: Google Gemini (หลัก) + OpenRouter (web search fallback)
- API key rotation: `_load_api_keys` + `_next_api_key` + `_client`
- ฟังก์ชันหลัก:
  - `answer(message, products, shop_hint, history, persona_extra, extra_context)` — ตอบจากสินค้า
  - `answer_general(message, context, qtype, history, persona_extra)` — ตอบจาก context (order, policy)
  - `describe_images(urls, shop_hint, max_images, history_context)` — vision pass
  - `split_segments(text)` — แยก multi-bubble ด้วย `|||`
- Cost calculation: prompt $0.30/M, output $2.50/M (gemini-3.5-flash-lite)

### 3.6 Product Store

**ไฟล์:** `chatbot/shopeechat/product_store.py`

- อ่านจาก product DB (`MONGO_*` env, default `dbWallet`)
- Collection: `ShpProducts` (env `MONGO_COLLECTION`)
- ฟังก์ชัน:
  - `list_shops(db)`, `list_categories(db)`
  - `fetch_product_by_id(db, item_id, shop_filter, desc_message)`
  - `_detect_product_types(message)`, `_detect_product_types_fuzzy(message)`
  - vector store (embedding) สำหรับ semantic search

### 3.7 Knowledge Base (Python)

**ไฟล์:** `chatbot/shopeechat/knowledge_base.py`

- อ่านจาก admin DB (`ADMIN_MONGO_*`)
- Collection: `knowledge_base` (env `ADMIN_MONGO_COLLECTION_KB`)
- รองรับ 2 type: `general_faq`, `product_spec`
- ฟังก์ชัน:
  - `get_base_warranty_text()` — ดึงเงื่อนไขรับประกัน (จาก KB หรือ default)
  - `is_warranty_question(message)`
  - `detect_general_question(message)` — จำแนก policy/return/shipping
  - `extract_model_keywords(message)` — ดึงชื่อรุ่น
  - `get_general_faq(topic)`, `get_product_spec(brand, model)`

### 3.8 Persona (Python)

**ไฟล์:** `chatbot/shopeechat/persona.py`

- อ่านจาก admin DB, collection `shop_personas`
- `get_persona(shopname, platform)` — ดึง persona (bot_name, notes)
- `build_persona_instruction(persona, shop_hint)` — สร้าง instruction เพิ่มเติม

### 3.9 Order Store

**ไฟล์:** `chatbot/shopeechat/order_store.py`

- อ่านจาก order DB (`ORDER_URI_MONGO`, `ORDER_DB`, `ORDER_COLLECTION`)
- Collection: `ShpOrders` (default)
- ฟังก์ชัน:
  - `extract_order_sn(message)` — ดึง order_sn จากข้อความ
  - `extract_tracking_number(message)` — ดึง tracking
  - `lookup_order(order_sn, shop_filter)`
  - `lookup_by_tracking(tracking_no, shop_filter)`
  - `build_order_context(order)` — สร้าง context สำหรับ LLM

### 3.10 Warranty

**ไฟล์:** `chatbot/shopeechat/warranty.py`

- `detect_claim_request(message)` — ตรวจ claim request
- `detect_tax_invoice_request(message)` — ตรวจใบกำกับภาษี
- `auto_check_warranty(order_sn, shop_filter)` — คำนวณระยะประกันจาก order
- `run_claim_flow(message, history, ...)` — claim state machine

### 3.11 Conversation Products

**ไฟล์:** `chatbot/shopeechat/conversation_products.py`

- เก็บ timeline สินค้าในแชท (admin DB, collection `conversation_products`)
- anchor product (ลูกค้าส่งมา) vs suggestion product (bot แนะนำ)
- `add_product()`, `load_timeline()`, `save_timeline()`
- `resolve_active_by_message()` — หา active product ตามกฎ
- `get_active_product()`, `get_suggestion_latest()`

### 3.12 Intent Classifier

**ไฟล์:** `chatbot/shopeechat/intent_classifier.py`

- `should_run_pass1(message, claim_detected, product_types, has_warranty_history)`
- `classify_intent(message, history, shop)` — เรียก LLM จำแนก intent

### 3.13 Web Search

**ไฟล์:** `chatbot/shopeechat/web_search.py`

- `search_and_extract(query)` — ใช้ OpenRouter + Google Search (fallback ด่านสุดท้าย)
- `search_and_answer` deprecated — ใช้ `search_and_extract` แทน

---

## 4. Bot Worker Pipeline

**ไฟล์:** `ChatAdminWeb/src/backend/service/botWorkerService.ts`

Pipeline ประมวลผลข้อความใหม่จากลูกค้า

### 4.1 Flow

```
pollNewMessages(since?)
  ↓
ดึง messages (role=user, direction=in) ที่ยังไม่ประมวลผล
  ↓
ตัดที่ประมวลผลแล้ว (เช็ค chat_processing)
  ↓
อ่าน buffer config จาก system_configs
  ↓
แต่ละ message → bufferOrProcess (fire-and-forget)
  ↓
ถ้า buffer เปิด → insert buffer_messages + ตั้ง timer
ถ้า buffer ปิด → processMessage ทันที
```

### 4.2 processMessage

```
1. เช็คซ้ำ (isProcessed)
2. Safety guard (assertPlatformApiDisabled)
3. อัปเดต concurrency limit จาก config
4. ดึง shop_name จาก conversation
5. Guard: ถ้า admin กำลังตอบ (status_conversation assigned_to มีค่า) → ข้าม
6. แปลง raw_payload → botText + botImages (messageMediaParser)
7. Workflow resume (ถ้ามี active run + workflow_enabled)
   → resumeFlow → ถ้า actioned → return
8. Workflow priority:
   - workflow_first → matchAndRun ก่อน trigger
   - trigger_first → trigger ก่อน แล้ว matchAndRun
   - both → matchAndRun + trigger (ตอบซ้ำได้)
9. Trigger match
   → handoff_admin → pickAgent (round-robin) → mark + log
   → bot_answer → callBot → storeBotReply (shadow_replies) → mark + log
10. ไม่ match trigger → callBot
    → ถ่าง → handoff
    → ตอบได้ → storeBotReply → mark + log
11. Error → mark bot_failed + log
```

### 4.3 Concurrency Limiter

- `acquireBotSlot()` / `releaseBotSlot()` — semaphore pattern
- limit จาก `bot_concurrency_limit` (default 50, admin ปรับได้)
- ถ้าเต็ม → รอใน queue

### 4.4 Fire-and-forget

- แต่ละ message ยิงไปเลย ไม่ await
- 10 คำถามเข้าพร้อมกัน → ยิง 10 reqs พร้อมกัน (จำกัดด้วย concurrency)
- บอทตอบทีละคำตอบเสร็จก่อนก็ตอบก่อน

### 4.5 chat_processing collection

- idempotency — ถ้าเคยประมวลผลแล้ว ข้าม
- status: `trigger_matched`, `bot_answered`, `handed_off`, `bot_failed`, `no_action`, `workflow_actioned`, `workflow_resumed`

---

## 5. Buffer / Flush / Debounce

**ไฟล์:** `ChatAdminWeb/src/backend/service/bufferService.ts`

### 5.1 วัตถุประสงค์

รอให้ลูกค้าหยุดพิมพ์ X วินาที → รวมทุกข้อความเป็น 1 query → ส่งบอท 1 ครั้ง → ตอบ 1 คำตอบ

### 5.2 โครงสร้าง

- `buffer_messages` collection — เก็บข้อความที่กำลัง buffer (DB-backed)
- `bufferTimers` Map (in-memory) — debounce timer per conversation_id

### 5.3 bufferOrProcess

```
ถ้า buffer ปิด → processMessage ทันที
ถ้า buffer เปิด:
  1. insert ลง buffer_messages (ยังไม่ mark chat_processing)
  2. ดึง buffered messages ของ conversation
  3. ตรวจ media (รูป/วิดีโอ) → ใช้ window นานกว่า + max มากกว่า
  4. ถ้าครบ max → flush ทันที
  5. ถ้ายังไม่ครบ → รีเซ็ต timer (debounce)
```

### 5.4 flushBuffer

```
1. ล้าง timer
2. ดึง buffered messages
3. ลบออกจาก buffer_messages (กัน flush ซ้ำ)
4. รวมข้อความเป็น 1 query (join ด้วย space)
5. รวม images จากทุก message
6. processMessage (ใช้ firstMsg.message_id เป็น ref)
7. mark ข้อความที่เหลือว่า processed
8. log bot.buffer_flush
```

### 5.5 Media-aware buffer

- ถ้ามีรูป/วิดีโอ → window นานกว่า (default × 2)
- max messages มากกว่า (default × 2)
- เพราะลูกค้ามักส่งหลายรูปติดกัน

### 5.6 recoverStaleBuffers

- ตอน boot → หา conversation ที่มีข้อความค้างใน buffer_messages
- flush เลย (ไม่รอ timer เพราะ timer หายแล้ว)
- log bot.buffer_recover

### 5.7 Config

- `bot_buffer_enabled` (default false)
- `bot_buffer_window_ms` (default 3000, range 1000-30000)
- `bot_buffer_max_messages` (default 5, range 1-20)
- `bot_buffer_window_media_ms` (default = window × 2)
- `bot_buffer_max_media_messages` (default = max × 2)

---

## 6. Workflow Engine

**ไฟล์:** `ChatAdminWeb/src/backend/service/workflowEngine.ts`

### 6.1 โครงสร้าง

- `workflows` collection — นิยาม workflow (nodes + edges)
- `workflow_runs` collection — state ของ run ที่กำลังทำงาน

### 6.2 Node types

- `trigger` — entry point (1 ตัวต่อ workflow)
- `condition` — multi-branch (match keyword → branch)
- `wait` — wait for reply (retry + timeout)
- `action` — `send_message`, `let_ai_respond`, `handoff`, `add_label`, `send_http`

### 6.3 matchAndRun

```
1. หา workflow ที่ enabled + match shop/platform
2. เริ่มจาก trigger node
3. ประมวลผล nodes ตาม edges (max 50 steps)
4. action node → execute action
5. wait node → บันทึก waiting_for + wait_started_at
6. condition node → match branch → ไป branch นั้น
7. ส่งคำตอบ (delivered) / handoff / exit
```

### 6.4 resumeFlow

```
ถ้ามี active run (status=waiting):
  1. ดึง wait node config
  2. validate คำตอบ (validateWaitAnswer)
  3. ถ้า match → ไป node ถัดไป
  4. ถ้าไม่ match → retry (wait_retry_count++)
  5. ถ้า retry ครบ → timeout → cancel/exit
```

### 6.5 checkWaitTimeouts

- poll หา run ที่ wait_started_at + timeout < now
- cancel/exit

### 6.6 false_branch_policy

- `exit_to_bot` — ไม่ match → ออกไปบอทปกติ
- `exit_drop` — ไม่ match → ทิ้งข้อความ

### 6.7 Workflow priority

- `workflow_first` — workflow ก่อน trigger
- `trigger_first` — trigger ก่อน workflow
- `both` — workflow + trigger (ตอบซ้ำได้)

### 6.8 validateWorkflowGraph

- ตรวจ node_id ซ้ำ
- trigger node 1 ตัว
- edges อ้างอิงถูก
- multi-branch condition config
- wait node config

---

## 7. Trigger

**ไฟล์:** `ChatAdminWeb/src/backend/service/triggerService.ts`

### 7.1 โครงสร้าง

- `triggers` collection
- Fields: `name`, `keywords[]`, `shop_ids[]`, `platforms[]`, `topic`, `action`, `bot_template`, `enabled`

### 7.2 matchTrigger

- substring case-insensitive match
- ถ้า `shop_ids` ว่าง = ทุกร้าน
- ถ้า `platforms` ว่าง = ทุกแพลตฟอร์ม

### 7.3 Action types

- `bot_answer` — เรียกบอท + ใช้ `bot_template` (resolve variables)
- `handoff_admin` — จ่ายงาน admin (round-robin)

### 7.4 Template resolution

**ไฟล์:** `ChatAdminWeb/src/backend/service/templateService.ts`

- `resolveTemplate(text, vars)` — แทนที่ `{{variable}}`
- variables: `customerName`, `shopName`, `botAnswer`, etc.

---

## 8. Image Input (Vision)

### 8.1 Python side

**ไฟล์:** `chatbot/shopeechat/app.py` (ใน `chat()`)

```
1. รวมรูปจาก history (ที่มี image_desc ใช้เลย, ที่ไม่มีอ่านใหม่)
2. รวมรูปจาก turn ปัจจุบัน
3. เรียก llm.describe_images(urls, shop_hint, max_images, history_context)
   → ใช้ Gemini vision (gemini-3.1-flash-lite)
   → ได้ text description
4. รวม description เป็น _vision_context
5. ส่ง _vision_context ให้ LLM หลักเป็น extra_context
6. ส่ง image_desc กลับใน ChatResponse (caller เก็บใน message doc)
```

### 8.2 Next.js side

**ไฟล์:** `ChatAdminWeb/src/backend/service/messageMediaParser.ts`

- `parseRawMessage(rawPayload, fallbackText)` — แปลง raw_payload → message_type + media URL
- รองรับ: `image`, `video`, `item`, `variation_card`, `order`, `sticker`, `bundle_message`, `faq_liveagent`
- `normalizeItemId(id)` — ตัด `.0`

**ไฟล์:** `ChatAdminWeb/src/backend/service/messageService.ts`

- `toBotImages(msg)` — ดึง image URLs จาก message

**ไฟล์:** `ChatAdminWeb/src/backend/service/botWorkerService.ts`

- `storeBotReply` — เก็บ `image_desc` ที่ vision pass สกัดได้ลงใน message doc
- ทำให้ turn ถัดไปส่ง image_desc ใน history → bot ไม่ต้องอ่านรูปซ้ำ

### 8.3 Buffer + images

- `bufferService.extractMediaUrls(rawPayload)` — ดึง URL จาก raw_payload
- flush → รวม images จากทุก message ใน buffer
- ลูกค้าส่ง 3 รูป + พิมพ์ → บอทเห็นรูปทั้ง 3

---

## 9. History Retrieval

**ไฟล์:** `ChatAdminWeb/src/backend/service/messageService.ts`

### 9.1 getHistoryForBot

```
1. listMessages(convId, { platform, limit: 10 })
2. pair user message กับ bot reply โดย inbound_message_id (จาก shadow_replies)
3. สร้าง history list [{role, text, images, image_desc}]
4. ส่งให้ Python /chat เป็น req.history
```

### 9.2 Python side

- `req.history` — list ของ `{role, text, images, image_desc}`
- ใช้ history สำหรับ:
  - follow-up detection (warranty/return + history มีสินค้า)
  - anchor product from history (ลูกค้าแชร์การ์ดไว้ก่อนหน้า)
  - vision context (history ล่าสุด 6 บรรทัด)
  - repeated complaint detection
  - intent classification

### 9.3 Conversation Products

- `conversation_products` collection — timeline สินค้าในแชท
- anchor (ลูกค้าส่งมา) vs suggestion (bot แนะนำ)
- `resolve_active_by_message` — หา active product ตามกฎ
- ทำให้ follow-up ไม่ลืมสินค้าเก่า

---

## 10. Round-Robin Assignment

**ไฟล์:** `ChatAdminWeb/src/backend/service/assignmentService.ts`

### 10.1 3 โหมด

| Mode | ความหมาย |
|------|----------|
| `equal_global` | ทุกคนรับเท่ากัน (pool เดียว global) |
| `equal_per_shop` | แยก pool ตามร้าน |
| `equal_per_platform` | แยก pool ตามแพลตฟอร์ม |

### 10.2 buildPool

- pool key รวม source: `global:ticket`, `shop:123:shadowbot`, `platform:shopee:botworker`
- แยก cursor ตาม source → test ไม่กระทบจริง

### 10.3 pickNextAgent

```
1. buildPool(mode, shop, source) → pool_key
2. ดึง orderedAgentIds (filter role=admin + active + is_accepting_chats)
3. ดึง cursor จาก assignment_cursors (pool_key)
4. round-robin: agent ถัดไปจาก cursor
5. update cursor (last_assigned_admin_id)
```

### 10.4 autoAssignConversation

```
1. buildPool
2. pickNextAgent
3. statusConversationService.tryAssign (atomic)
4. ถ้าสำเร็จ → return agentId
5. ถ้า fail (คนอื่น assign ไปแล้ว) → return null
```

### 10.5 reassignConversation

- ใช้ตอน admin โอนงานให้คนอื่น
- `manualAssign` (atomic guard — ยอมทับถ้าเป็น previousAssignedTo/null)

---

## 11. Handoff / Close / Reopen Lifecycle

### 11.1 Handoff

**ไฟล์:** `ChatAdminWeb/src/backend/service/handoffService.ts`

```
handoffToAdmin({conversationId, shopId, platform, reason, source}):
  1. ถ้า closed/resolved → reopenConversation (status=handoff)
  2. ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม
  3. ถ้า config assignment_prefer_previous_admin !== false
     → หา admin คนสุดท้ายที่ตอบ (getLastReplyAdmin from messages)
     → เช็ค active + is_accepting_chats
     → ถ้ามี → ใช้คนเดิม
  4. ถ้ายังไม่มี → assignmentService.autoAssignConversation (round-robin)
```

### 11.2 Close

**ไฟล์:** `ChatAdminWeb/src/backend/service/statusConversationService.ts`

```
closeConversation({conversationId, closedBy, reason, category, resolution, note, shopId, customerId}):
  1. update status_conversation: status=closed, closed_at, closed_by, close_count++
  2. closeHistoryService.recordClose (sequence = close_count)
  3. log admin.close
```

### 11.3 Reopen

```
reopenConversation({conversationId, reopenedBy, reopenReason, assignedTo, targetStatus}):
  1. update status_conversation: status=targetStatus (handoff หรือ bot)
  2. clear closed_at
  3. closeHistoryService.recordReopen (ไม่ increment sequence)
  4. log admin.reopen
```

### 11.4 Lifecycle ที่ต้องการ

```
1. ลูกค้าส่งข้อความ → bot ตอบ
2. bot handoff → status=handoff (admin-owned)
3. admin ตอบ → admin ปิด → "ครั้งที่ 1 ปิดแล้ว"
4. ลูกค้าส่งอีก → reopen status=bot → bot ตอบ
5. bot handoff อีก → status=handoff
6. admin กด reopen เอง → status=handoff (admin จะจัดการ)
7. admin ปิด → "ครั้งที่ 2 ปิดแล้ว"
8. reopen ไม่ increment sequence
```

### 11.5 Auto-reopen

**ไฟล์:** `ChatAdminWeb/src/app/api/admin/conversations/route.ts`

- ถ้า conversation closed แต่มีข้อความใหม่หลัง `closed_at` → auto-reopen (status=bot)

---

## 12. Configuration Loading

**ไฟล์:** `ChatAdminWeb/src/backend/service/systemConfigService.ts`

### 12.1 getSystemConfig

- in-memory cache TTL 5 วินาที
- อ่านจาก `system_configs` collection
- สวิตช์อันตราย (live read/send/mark_read/pin/poll) ถูก hard-coded `false` จาก `SAFETY`
- ค่า default มาจาก env

### 12.2 updateSystemConfig

- internal — อัปเดต allowlist สวิตช์ปลอดภัยเท่านั้น

### 12.3 updateAdminConfig

- สำหรับ `/admin-config` (requireEditor)
- validate ช่วงค่า (buffer, concurrency, workflow)

### 12.4 Config keys

| Key | หน้าที่ | ปรับโดย |
|-----|---------|---------|
| `bot_buffer_enabled` | เปิด/ปิด buffer | admin-config |
| `bot_buffer_window_ms` | debounce window | admin-config |
| `bot_buffer_max_messages` | max ก่อน flush | admin-config |
| `bot_buffer_window_media_ms` | media window | admin-config |
| `bot_buffer_max_media_messages` | media max | admin-config |
| `bot_concurrency_limit` | max concurrent bot calls | admin-config |
| `workflow_enabled` | เปิด/ปิด workflow | admin-config |
| `workflow_priority` | workflow_first/trigger_first/both | admin-config |
| `workflow_run_timeout_ms` | workflow timeout | admin-config |
| `assignment_prefer_previous_admin` | จ่ายให้ admin เดิมก่อน | admin-config |
| `shopee_live_read` | อันตราย — อ่านจริง | config (superadmin) |
| `shopee_live_send` | อันตราย — ส่งจริง | config (superadmin) |
| `mock_mode_enabled` | mock mode | config |
| `shadow_bot_enabled` | shadow bot | config |
| `bot_worker_enabled` | bot worker | config |
| `polling_interval_ms` | polling interval | config |
| `shopee_bot_url` | Python bot URL | config |

---

## 13. Cache & Polling

### 13.1 API cache

| Endpoint | TTL | Invalidate |
|----------|-----|------------|
| `/admin/conversations` | 3 วินาที | `invalidateConversationsCache()` |
| `/botworker/conversations` | 2.5 วินาที | `invalidateBotworkerCache()` |
| `systemConfigService` | 5 วินาที | forceRefresh |

### 13.2 Cache invalidation

ทุก mutation route เรียก invalidate ทั้งสอง cache:
- send, close, reopen, handoff, assign, resolve, bot-handoff

### 13.3 Polling intervals

| หน้า | Poll | Interval |
|------|------|----------|
| `/tickets` | shared conversations | 3 วินาที |
| `/tickets` | messages | 2 วินาที |
| `/botworker` | conversations | 3 วินาที |
| `/botworker` | messages | 3 วินาที |
| `/shadow-inbox` | shared (tab ทั้งหมด) | 3 วินาที |
| `/shadow-inbox` | shadow list | 10 วินาที (20 วินาที history) |
| `/shadow-inbox` | stats | 30 วินาที |
| `/logs` | logs | 5 วินาที |
| `/analytics/live` | live | 30 วินาที + tick 1 วินาที |
| `/test-assignment` | stats | 10 วินาที |

### 13.4 Shared conversation store

**ไฟล์:** `ChatAdminWeb/src/lib/useSharedConversations.ts`

- module-level singleton store
- 1 polling loop → multiple subscribers
- ใช้โดย `/tickets` และ `/shadow-inbox` (tab "ทั้งหมด")
- `invalidateSharedConversations()` — บังคับ refresh

### 13.5 Request timeouts

- Botworker conversations: 45 วินาที
- Botworker messages: 30 วินาที
- ถ้า timeout → preserve existing data (ไม่ clear)

---

## 14. Audit Logging

**ไฟล์:** `ChatAdminWeb/src/backend/service/adminLogService.ts`

### 14.1 ฟังก์ชัน

- `logAdminAction({adminId, actionType, ticketId, meta, ip})`
- `logAdminEvent({action_type, actor, target_admin_id, conversation_id, shop_id, metadata, ip})`
- `logBotEvent(...)` — บอท action
- `logDataWriterEvent(...)` — data writer action
- `listAdminLogs`, `listAdminLogsExtended` (with $lookup admins)
- `getAdminActivitySummary` — aggregate

### 14.2 Action types ที่ log

| Action | ใครเขียน | ตอนไหน |
|--------|---------|--------|
| `admin.reply` | admin | ส่งข้อความ |
| `admin.close` | admin | ปิดแชท |
| `admin.reopen` | admin | เปิดใหม่ |
| `admin.handoff` | admin | ส่งต่อ |
| `admin.assign` | admin | รับเป็นเจ้าของ |
| `admin.transfer` | admin | โอนงาน |
| `admin.resolve` | admin | resolve |
| `admin.login` | admin | login |
| `admin.logout` | admin | logout |
| `admin_config.update` | admin | แก้ config |
| `shop_settings.update` | admin | แก้ shop settings |
| `trigger.create/update/delete/toggle` | admin | จัดการ trigger |
| `workflow.create/update/delete/toggle` | admin | จัดการ workflow |
| `kb.create/update/delete/toggle` | admin | จัดการ KB |
| `persona.upsert/delete/toggle` | admin | จัดการ persona |
| `quick_reply.create/update/delete` | admin | จัดการ quick reply |
| `bot.reply` | bot-worker | บอทตอบ |
| `bot.handoff_to_admin` | bot-worker | บอทส่งต่อ |
| `bot.process_failed` | bot-worker | บอท error |
| `bot.buffer_flush` | bot-worker | flush buffer |
| `bot.buffer_recover` | bot-worker | recover stale buffer |

---

## 15. Shadow Inbox / Replay Compare

### 15.1 Shadow Reply

**ไฟล์:** `ChatAdminWeb/src/backend/service/shadowReplyService.ts`

- เก็บคำตอบบอทที่ **ไม่ส่งจริง** ใน `shadow_replies` collection
- เปรียบเทียบกับ Zaapi reply (ดึงจาก messages ที่ source != admin)
- Fields: `bot_reply_text`, `zaapi_reply_text`, `rating`, `star_rating`, `comment`, `cost`, `tokens`, `image_desc`
- origin: `worker` (auto pipeline), `workflow` (workflow engine), `manual` (generate มือ)
- mode: `standalone` (botworker), `replay` (replay-compare)

### 15.2 generateShadowReply

- สร้าง shadow reply สำหรับ message เฉพาะ (manual)
- เรียกบอท → เก็บใน shadow_replies

### 15.3 generateConversationShadowReplies

- สร้าง shadow reply ทุก message ใน conversation (batch)

### 15.4 Replay Compare

**ไฟล์:** `replay_compare.py` (script) + `/replay-compare` page

- replay แชทจริง → ส่งทุก message ให้บอท → เก็บผลใน `test_assignment`
- เปรียบเทียบ bot vs Zaapi
- rate per-message + per-conversation

---

## 16. Test Chat

### 16.1 TestChatClient

**ไฟล์:** `ChatAdminWeb/src/components/test-chat/TestChatClient.tsx`

- จำลองแชทเพื่อทดสอบบอท/trigger/workflow/buffer
- ส่งข้อความ → `POST /chatbot/shopee/test-chat/sessions/{id}/messages`
- อัปโหลดรูป → `POST /test-chat/upload`
- ทดสอบ buffer → `POST /test-chat/buffer`
- ทดสอบ trigger → `POST /triggers/match`
- ทดสอบ workflow → `POST /test-chat/workflow-step`
- handoff → `POST /admin/conversations/bot-handoff`
- rate → `POST /test-chat-ratings`

### 16.2 Python test chat

**ไฟล์:** `chatbot/shopeechat/app.py` บรรทัด 5345-5569

- `GET /test-chat/sessions` — list
- `POST /test-chat/sessions` — create
- `GET /test-chat/sessions/{id}` — detail
- `POST /test-chat/sessions/{id}/messages` — add message
- `DELETE /test-chat/sessions/{id}` — delete
- `PUT /test-chat/sessions/{id}` — update
- `POST /test-chat/sessions/{id}/close` — close
- `POST /test-chat/sessions/{id}/reopen` — reopen
- `GET /test-chat/logs` — log

### 16.3 test_chat_logs

- Python `_log_testchat_action` — เก็บ log การใช้ testchat
- Fields: `action`, `session_id`, `admin_id`, `admin_name`, `timestamp`, `**extra`

---

## 17. Phases สำคัญ

| Phase | ความหมาย |
|-------|---------|
| Phase 1A | Multimodal vision (Gemini vision อ่านรูป) |
| Phase 1B | Tracking lookup |
| Phase 1C | Warranty auto-check from order_sn |
| Phase 1E | Media-aware buffer |
| Phase 1F | Test chat uploads + max_images env |
| Phase 2A | State-driven handoff (ticket_state from DB) |
| Phase 2J | แยก status_conversation จาก conversations |
| Phase 2P | pollNewMessages since parameter |
| Phase 2Q | Concurrency limiter |
| Phase 2R | Shadow reply mode standalone |
| Phase 2V | test_status_conversation source=botworker |
| Phase 2Z | Conversation products timeline |
| Phase 3 | Shop persona |
| Phase 5 | Close history |
| Phase 8 | Chat accept sessions |
| Phase 9 | Bot worker |
| Phase 10 | Shop settings |

---

## อ้างอิงไฟล์หลัก

| ไฟล์ | หน้าที่ |
|------|---------|
| `ChatAdminWeb/src/backend/lib/config.ts` | Collection names + env config |
| `ChatAdminWeb/src/backend/db/mongoClient.ts` | MongoDB connection + COLLECTIONS |
| `ChatAdminWeb/src/backend/db/dbWalletClient.ts` | Read-only product DB |
| `ChatAdminWeb/src/backend/service/*.ts` | 31 services |
| `ChatAdminWeb/src/app/(console)/*/page.tsx` | 24 หน้า console |
| `ChatAdminWeb/src/app/api/*/route.ts` | API routes |
| `ChatAdminWeb/src/lib/useSharedConversations.ts` | Shared polling store |
| `chatbot/shopeechat/app.py` | FastAPI bot |
| `chatbot/shopeechat/llm.py` | LLM (Gemini) |
| `chatbot/shopeechat/product_store.py` | Product DB |
| `chatbot/shopeechat/knowledge_base.py` | KB (admin DB) |
| `chatbot/shopeechat/persona.py` | Persona |
| `chatbot/shopeechat/order_store.py` | Order DB |
| `chatbot/shopeechat/warranty.py` | Warranty claim |
| `chatbot/shopeechat/conversation_products.py` | Product timeline |
| `chatbot/shopeechat/intent_classifier.py` | Intent classification |
| `chatbot/shopeechat/web_search.py` | Web search fallback |
