# Schema — MongoDB Collections ของระบบ ChatBotProductMS

เอกสารนี้อธิบายทุก MongoDB collection ที่ใช้ในระบบ
อ้างอิงจากโค้ดจริงใน `ChatAdminWeb/src/backend/` และ `chatbot/shopeechat/`

---

## สารบัญ

1. [ภาพรวม Collections](#1-ภาพรวม-collections)
2. [Admin DB Collections (รายละเอียด)](#2-admin-db-collections-รายละเอียด)
3. [Product DB Collections (dbWallet — read-only)](#3-product-db-collections-dbwallet--read-only) (รวม §3.5 Stock DB `itStock.Products`)
4. [Order DB Collections](#4-order-db-collections)
5. [Collections ที่ Python เป็นเจ้าของ (admin DB)](#5-collections-ที่-python-เป็นเจ้าของ-admin-db)
6. [Collection ที่ประกาศแต่ยังไม่ใช้](#6-collection-ที่ประกาศแต่ยังไม่ใช้)
7. [Local files (ไม่ใช่ Mongo)](#7-local-files-ไม่ใช่-mongo)
8. [Access Matrix รวม](#8-access-matrix-รวม)

---

## 1. ภาพรวม Collections

### 1.1 แหล่ง define `COLLECTIONS`

**ไฟล์:**
- `ChatAdminWeb/src/backend/db/mongoClient.ts` บรรทัด 26 — `export const COLLECTIONS = serverConfig.collections;`
- `ChatAdminWeb/src/backend/lib/config.ts` บรรทัด 41-99 — map env → collection name (36 keys)

⚠️ **ทุกชื่อ override ด้วย env `ADMIN_MONGO_COLLECTION_*`** — default ในตารางคือชื่อ fallback
เช่น production ใช้ `conversations_shp` / `messages_shp` / `customers_shp` (sellcenter dump ลงชื่อ `_shp`)

### 1.2 รายการใน `COLLECTIONS` (36 keys — ทั้งหมดอยู่ใน admin DB)

| key | default name | DB | ใช้ทำอะไร |
|-----|-------------|-----|----------|
| `admins` | `admins` | admin | ข้อมูลแอดมิน (SSO) |
| `authTokens` | `auth_tokens` | admin | ⚠️ legacy — ไม่ใช้ |
| `sessions` | `sessions` | admin | session ล็อกอิน |
| `knowledgeBase` | `knowledge_base` | admin | FAQ + product spec |
| `guardrails` | `guardrails` | admin | ⚠️ legacy — ไม่ใช้ |
| `tickets` | `tickets` | admin | ticket (ยังไม่ใช้ใน UI) |
| `adminLogs` | `admin_logs` | admin | audit log |
| `conversations` | `conversations` | admin | ข้อมูลแชทหลัก (โดน dump ทับ) |
| `messages` | `messages` | admin | message log |
| `shops` | `shops` | admin | ร้านค้า |
| `customers` | `customers` | admin | ลูกค้า |
| `triggers` | `triggers` | admin | trigger rules |
| `pushEvents` | `pushevents` | admin | ⚠️ legacy — ไม่ใช้ |
| `requestLogs` | `requestlogs` | admin | ⚠️ legacy — ไม่ใช้ |
| `systemConfigs` | `system_configs` | admin | system config |
| `assignmentConfigs` | `assignment_configs` | admin | assignment mode |
| `assignmentCursors` | `assignment_cursors` | admin | round-robin cursor |
| `shopTeamAssignments` | `shop_team_assignments` | admin | ทีมร้าน |
| `platformTeamAssignments` | `platform_team_assignments` | admin | ทีมแพลตฟอร์ม |
| `shadowReplies` | `shadow_replies` | admin | คำตอบบอท (ไม่ส่งจริง) |
| `chatAnnotations` | `chat_annotations` | admin | markup dot + note (Phase 3B-1) |
| `quickReplies` | `quick_replies` | admin | ข้อความตอบเร็ว |
| `closeHistory` | `close_history` | admin | ประวัติปิด/เปิด |
| `chatAcceptSessions` | `chat_accept_sessions` | admin | session รับแชท/พัก |
| `chatProcessing` | `chat_processing` | admin | idempotency bot worker |
| `shopPersonas` | `shop_personas` | admin | persona ต่อร้าน |
| `shopSettings` | `shop_settings` | admin | ตั้งค่าต่อร้าน |
| `testChatRatings` | `test_chat_ratings` | admin | rate test chat |
| `testAssignment` | `test_assignment` | admin | replay results |
| `bufferMessages` | `buffer_messages` | admin | buffer ข้อความ |
| `testChatUploads` | `test_chat_uploads` | admin | อัปโหลด test chat |
| `workflows` | `workflows` | admin | workflow นิยาม |
| `workflowRuns` | `workflow_runs` | admin | workflow run state |
| `statusConversation` | `status_conversation` | admin | admin-owned meta (ไม่โดน dump) |
| `testStatusConversation` | `test_status_conversation` | admin | test version ของ status |
| `testChatSessions` | `test_chat_sessions` | admin | test chat session (Python เขียนหลัก) |

### 1.3 DB connections (4 DBs)

| DB | env | เขียนโดย | อ่านโดย |
|----|-----|---------|---------|
| admin DB (`chatbot_admin`) | `ADMIN_MONGO_URI` หรือ `ADMIN_MONGO_HOST/USERNAME/PASSWORD/AUTH_SOURCE/TLS` + `ADMIN_MONGO_DB` | Next.js (หลัก) + Python (`conversation_products`, `test_chat_*`, import scripts) + sellcenter dump (conversations/messages/customers) | Next.js ทุก service + Python bot runtime |
| product DB (`dbWallet`) | `MONGO_URI`, `MONGO_DB`, `MONGO_COLLECTION` | ภายนอก (Shopee sync) | Python `product_store`/`units`/`knowledge_base`/`app.py`/`chat_v2`/`chatbotv3` + Next.js `dbWalletClient.ts` (ReadOnlyCollection บล็อกทุก write) |
| order DB (default `dbWallet`) | `ORDER_URI_MONGO`, `ORDER_DB`, `ORDER_COLLECTION` | ภายนอก | Python `order_store.py` + Next.js `/admin/conversations/[id]/orders` route |
| stock DB (`itStock`) | `STOCK_URI`, `STOCK_DB` | ภายนอก | Python `product_store.py` (cert flags — cert search path เท่านั้น) |

### 1.4 Collections ใน admin DB ที่อยู่นอก `COLLECTIONS` (Python-owned)

`COLLECTIONS` ครอบคลุมเฉพาะ collection ที่ Next.js ใช้ — Python bot เขียน/อ่าน
collection เพิ่มอีก 7 ตัวใน admin DB เดียวกัน (รายละเอียด §5):

| collection | env override | เขียนโดย | อ่านโดย |
|------------|--------------|---------|---------|
| `conversation_products` | — (hardcoded) | `conversation_products.py` | bot runtime (`app.py`, `chat_v2`, `warranty_flow`, `order_flow`) |
| `test_chat_logs` | — (hardcoded) | `test_chat_api.py` | `GET /test-chat/logs` (Python) |
| `image_texts` | — (hardcoded) | `scripts/import_image_texts.py` | `product_store.py` (OCR cert search), `units.py` |
| `sellable_units` | `ADMIN_MONGO_COLLECTION_UNITS` | `scripts/import_sellable_units.py` | `units.py` (unit index runtime) |
| `kb_products` | `ADMIN_MONGO_COLLECTION_KB_PRODUCTS` | `docs/adminbase/script/import_adminbase.py` | `knowledge_base.py`, `units.py` |
| `kb_qa` | `ADMIN_MONGO_COLLECTION_KB_QA` | `import_adminbase.py` | `knowledge_base.py`, `build_embeddings.py` |
| `kb_raw` | `ADMIN_MONGO_COLLECTION_KB_RAW` | `import_adminbase.py` | — (audit trail — ยังไม่มี reader) |

---

## 2. Admin DB Collections (รายละเอียด)

### 2.1 `admins`

**Schema:** `AdminDoc` ใน `src/backend/service/authService.ts` บรรทัด 15-36

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `admin_id` | string | PK |
| `email` | string | unique |
| `username` | string | unique |
| `name` | string | ชื่อที่แสดง |
| `role` | `"superadmin" \| "admin" \| "dev"` | สิทธิ์ |
| `password_hash` | string? | (SSO ไม่ใช้) |
| `active` | boolean | เปิด/ปิด |
| `is_accepting_chats` | boolean? | รับแชทอยู่ไหม |
| `channels_access` | string[]? | จำกัดแพลตฟอร์ม |
| `failed_login_count` | number? | lockout |
| `locked_until` | Date \| null? | lockout |
| `last_login_at` | Date \| null? | |
| `last_login_ip` | string? | |
| `created_at` | Date | |
| `created_by` | string? | |
| `is_deleted` | boolean? | soft delete |
| `deleted_at` | Date \| null? | |
| `deleted_by` | string? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | authService | `auth/sso/callback`, `auth/me`, `users/list`, `users/[id]`, `profile`, `admin/conversations`, `bot-handoff`, `test-assignment` |
| Write (create) | authService.createAdmin | `auth/sso/callback` (SSO สร้าง admin ใหม่) |
| Update | authService.recordLoginSuccess, toggleAdminActive, updateAdminProfile | `auth/sso/callback`, `profile`, `profile/accepting-chats`, `users/[id]` |
| Delete (soft) | authService.deleteAdmin | `users/[id]` |

**หน้าที่เข้าถึง:** `/users`, `/team`, `/tickets`, `/botworker`, `/shadow-inbox`, `/test-assignment`, `/quick-replies`, `/triggers`, `/knowledge`, `/logs`, `/settings`

---

### 2.2 `sessions`

**Schema:** shape ใน `authService.createSession` บรรทัด 142-158

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `token_hash` | string | PK (hash ของ session token) |
| `admin_id` | string | ref admins |
| `created_at` | Date | |
| `expires_at` | Date | |
| `last_activity_at` | Date | |
| `ip` | string? | |
| `revoked` | boolean | soft revoke |
| `revoked_at` | Date \| null? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | authService.getSession | `auth/me`, middleware |
| Write | authService.createSession | `auth/sso/callback` |
| Update | revokeSession, revokeAllSessions, updateSessionActivity | `auth/logout`, middleware, `users/[id]` |
| Delete | ไม่มี hard delete (ใช้ revoke) | |

**หน้าที่เข้าถึง:** ทุกหน้า (ผ่าน middleware session check)

---

### 2.3 `knowledge_base`

**Schema:** `KbGeneralFaqDoc` และ `KbProductSpecDoc` ใน `knowledgeBaseService.ts` บรรทัด 18-59

**Fields (general_faq):**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `_id` | ObjectId? | MongoDB PK |
| `type` | `"general_faq"` | |
| `topic` | string | เช่น "รับประกัน" |
| `question_patterns` | string[]? | |
| `answer` | string | |
| `applies_to_brands` | string[]? | |
| `applies_to_categories` | string[]? | |
| `platform` | string? | `"shopee" \| "tiktok" \| "lazada" \| "all"` (missing = global) |
| `active` | boolean | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `updated_by` | string? | |
| `version` | number? | |
| `is_deleted` | boolean? | soft delete |

**Fields (product_spec):**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `_id` | ObjectId? | |
| `type` | `"product_spec"` | |
| `brand` | string? | |
| `model` | string? | |
| `category` | string? | |
| `category_id` | string? | |
| `highlights` | string? | |
| `description` | string? | |
| `box_contents` | string? | |
| `warranty_period` | string? | |
| `warranty_note` | string? | |
| `notes` | string? | |
| `weight` | string? | |
| `dimensions` | string? | |
| `specs` | object? | |
| `extra_fields` | object? | |
| `platform` | string? | |
| `source_file` | string? | สำหรับ Excel upsert |
| `source_row` | number? | |
| `source_sheet` | string? | |
| `active` | boolean | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `updated_by` | string? | |
| `is_deleted` | boolean? | soft delete |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | knowledgeBaseService (Next.js), knowledge_base.py (Python) | `/knowledge`, `/shops` (drawer), Python `/chat` |
| Write (create) | createGeneralFaq, upsertProductSpecFromExcelRow | `/kb` POST, `/kb/upload` |
| Update | updateGeneralFaq, updateKbEntry, toggleKbActive | `/kb/[id]`, `/kb/[id]/toggle` |
| Delete (soft) | deleteKbEntry | `/kb/[id]` DELETE |

**หน้าที่เข้าถึง:** `/knowledge`, `/shops` (drawer), Python bot (อ่าน FAQ/spec ตอนตอบ)

**หมายเหตุ:**
- `platform: "all"` หรือ missing = ใช้ได้ทุกแพลตฟอร์ม
- ใช้ `_id` เป็น key หลัก (ไม่ใช่ `kb_id`)
- ⚠️ **สถานะปัจจุบัน:** collection นี้ยังเป็น admin-managed KB (หน้า `/knowledge` CRUD เต็ม)
  แต่สำหรับ Python runtime กลายเป็น **legacy fallback** แล้ว — บอทอ่าน `kb_qa`/`kb_products`
  ก่อน (§5.5/§5.6) และ fallback มา `knowledge_base` เฉพาะตอน `kb_qa` ไม่เจอ
  (`knowledge_base.py` `_kb_coll()` — เหลือ caller เดียวใน `get_general_faq`)

---

### 2.4 `tickets`

**Schema:** `TicketDoc` ใน `ticketService.ts` บรรทัด 12-31

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `ticket_id` | string | PK (format `TK-XXXX`) |
| `conversation_id` | string | ref conversations |
| `channel` | string | platform |
| `shop_id` | string? | |
| `shop_name` | string | |
| `customer_id` | string? | |
| `customer_name` | string | |
| `topic` | string | |
| `status` | string | |
| `priority` | string | |
| `assigned_to` | string? | |
| `summary` | string | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `is_deleted` | boolean? | soft delete |
| `deleted_at` | Date \| null? | |
| `deleted_by` | string? | |

**Access:** ticketService (CRUD) → ใช้ใน `stats/dashboard` (ยังไม่มี UI จัดการตรง)

---

### 2.5 `admin_logs`

**Schema:** `AdminLogDoc` ใน `adminLogService.ts` บรรทัด 129-142

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `admin_id` | string? | ใครทำ (legacy field) |
| `action_type` | string | เช่น `admin.reply`, `bot.handoff_to_admin` |
| `ticket_id` | string? | legacy |
| `meta` | object? | legacy |
| `ip` | string? | |
| `timestamp` | Date | |
| `actor` | string? | ใครทำ (ใหม่ — `admin_id` หรือ `bot-worker`) |
| `target_admin_id` | string? | กรณี action เกี่ยวกับ admin อื่น |
| `conversation_id` | string? | |
| `shop_id` | string? | |
| `metadata` | object? | รายละเอียดเพิ่มเติม |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Write | ทุก service ที่ audit (logAdminAction, logAdminEvent, logBotEvent, logDataWriterEvent) | ทุก mutation route |
| Read | listAdminLogs, listAdminLogsExtended, getAdminActivitySummary | `/admin/logs`, `/stats/admin-activity`, `/stats/performance`, `/shop-settings` |

**หน้าที่เข้าถึง:** `/logs`, `/analytics/admin-activity`, `/shop-settings` (ดู log ของ shop settings)

---

### 2.6 `conversations`

**Schema:** `ConversationDoc` ใน `conversationService.ts` บรรทัด 34-56

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `conversation_id` | string | PK |
| `shop_id` | string | |
| `shop_name` | string | |
| `platform` | string | shopee/tiktok/lazada |
| `customer_id` | string | |
| `to_name` | string | ชื่อลูกค้า |
| `customer_avatar` | string? | |
| `status` | string | open/closed/handoff/bot/resolved |
| `topic` | string? | |
| `item_ids` | string[]? | |
| `pinned` | boolean | |
| `unread_count` | number | |
| `last_message_text` | string | preview |
| `last_message_timestamp` | Date | |
| `labels` | string[]? | tag บนแชท — อ่านโดย `/labels` (distinct) + workflowEngine (label condition); ไม่มี label master collection |
| `assigned_to` | string? | ⚠️ โดน dump ทับ — ใช้ status_conversation |
| `created_at` | Date | |
| `updated_at` | Date | |
| `closed_at` | Date? | ⚠️ โดน dump ทับ |
| `closed_by` | string? | ⚠️ โดน dump ทับ |
| `close_count` | number? | ⚠️ โดน dump ทับ |

**⚠️ สำคัญ:** `assigned_to`, `closed_at`, `closed_by`, `close_count` โดน sellcenter dump ทับทุก 2 วินาที
→ ใช้ `status_conversation` เป็น source of truth สำหรับ admin-owned meta

ชื่อจริงใน production: `conversations_shp` (env `ADMIN_MONGO_COLLECTION_CONVERSATIONS`)

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | conversationService, หลาย route, Python `replay_compare.py`, `docs/test/find_qa_conversations.py` | `/admin/conversations`, `/botworker/conversations`, `/shadow-inbox/conversations`, `/test-assignment` |
| Write (create) | createConversation, findOrCreateConversation | `bot-handoff`, data writer ภายนอก |
| Update (internal) | touchLastMessage, resetUnread | messageService.addMessage |
| Update (close/reopen) | closeConversation, reopenConversation → delegate ไป statusConversationService | `/conversations/[id]/close`, `/conversations/[id]/reopen` |
| Delete | ไม่มี | |

**หน้าที่เข้าถึง:** `/tickets`, `/botworker`, `/shadow-inbox`, `/replay-compare`, `/test-assignment`, `/contacts`, `/dashboard`, `/analytics/*`

---

### 2.7 `messages`

**Schema:** `MessageDoc` ใน `messageService.ts` บรรทัด 29-50

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `message_id` | string | PK |
| `conversation_id` | string | ref |
| `shop_id` | string | |
| `platform` | string | |
| `role` | string | user/bot/admin |
| `direction` | string | in/out |
| `text` | string | |
| `products` | object[]? | สินค้าที่อ้างถึง |
| `source` | string? | admin/bot/zaapi/sellcenter |
| `topic` | string? | |
| `tokens` | object? | |
| `reply_to_message_id` | string? | |
| `created_timestamp` | Date | |
| `data_received_at` | Date? | |
| `raw_payload` | object? | rich media (image, item card, order) |
| `actor` | string? | |
| `image_desc` | string? | ⚡ vision description cache |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | messageService (listMessages, listMessagesPaginated, getHistoryForBot) | `/admin/conversations/[id]/messages`, `/botworker/conversations/[id]/messages` |
| Write | messageService.addMessage | `/admin/conversations/[id]/send` (admin reply), data writer (user messages) |
| Update | updateOne image_desc | botWorkerService.storeBotReply (cache vision desc) |
| Delete | ไม่มี (immutable log) | |

**หน้าที่เข้าถึง:** `/tickets`, `/botworker`, `/shadow-inbox`, `/replay-compare`, `/test-assignment`

---

### 2.8 `shops`

**Schema:** `ShopDoc` ใน `shopService.ts` บรรทัด 8-23

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `shop_id` | string | PK |
| `shopname` | string | |
| `platform` | string | |
| `connected` | boolean | |
| `conversation_count` | number | |
| `product_count` | number | |
| `last_sync_at` | Date? | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `enabled_for_chat` | boolean | toggle ใน /config |
| `disabled_by_user` | string? | |
| `last_polled_at` | Date? | |
| `status` | string? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | shopService | `/shops`, `/shops/[id]`, `/config`, `/dashboard`, `/workflows`, `/triggers`, `/quick-replies`, `/team` |
| Write (upsert) | shopService.upsertShop + `scripts/sync-shops.ts` (aggregate จาก `conversations_shp`) | data writer / sync / script |
| Update | setShopConnected, touchShopSync, toggleShopChatSync | `/shops/[id]`, `/config/shop/[shopId]` |
| Delete | ไม่มี | |

**หน้าที่เข้าถึง:** `/shops`, `/config`, `/workflows`, `/triggers`, `/quick-replies`, `/team`, `/persona`, `/shop-settings`

---

### 2.9 `customers`

**Schema:** `CustomerDoc` ใน `customerService.ts` บรรทัด 11-21

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `platform` | string | PK (ร่วม) |
| `buyer_id` | string | PK (ร่วม) |
| `customer_id` | string? | |
| `name` | string | |
| `avatar` | string? | |
| `last_active_at` | Date | |
| `created_at` | Date | |
| `conversations` | number? | |
| `shops` | string[]? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | customerService.listCustomers, getCustomer | `/contacts` |
| Write (upsert) | customerService.upsertCustomer | data writer / sync |
| Delete | ไม่มี | |

**หน้าที่เข้าถึง:** `/contacts`

---

### 2.10 `triggers`

**Schema:** `TriggerDoc` ใน `triggerService.ts` บรรทัด 12-31

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `trigger_id` | string | PK |
| `name` | string | |
| `keywords` | string[] | substring match |
| `shop_ids` | string[] | ว่าง = ทุกร้าน |
| `platforms` | string[] | ว่าง = ทุกแพลตฟอร์ม |
| `topic` | string? | |
| `action` | `"bot_answer" \| "handoff_admin"` | |
| `bot_template` | string? | template สำหรับ bot_answer |
| `enabled` | boolean | |
| `created_by` | string | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `updated_by` | string? | |
| `is_deleted` | boolean? | soft delete |
| `deleted_at` | Date \| null? | |
| `deleted_by` | string? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | triggerService.listTriggers, getTrigger, matchTrigger | `/triggers`, `/triggers/match`, bot worker, test-assignment |
| Write (create) | createTrigger | `/triggers` POST |
| Update | updateTrigger, toggleTrigger | `/triggers/[id]`, `/triggers/[id]/toggle` |
| Delete (soft) | deleteTrigger | `/triggers/[id]` DELETE |

**หน้าที่เข้าถึง:** `/triggers`, `/shops` (drawer), bot worker (match), `/test-chat` (match)

---

### 2.11 `shadow_replies`

**Schema:** `ShadowReplyDoc` ใน `shadowReplyService.ts` บรรทัด 21-71

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `shadow_reply_id` | string | PK |
| `conversation_id` | string | ref |
| `shop_id` | string | |
| `platform` | string | |
| `inbound_message_id` | string | ⚠️ unique index (workflow ต่อท้าย `__wf<N>`) |
| `inbound_text` | string | |
| `bot_reply_text` | string | |
| `bot_source` | string? | |
| `bot_model` | string? | |
| `bot_elapsed_ms` | number? | |
| `bot_tokens` | object? | |
| `bot_cost_usd` | number? | |
| `bot_cost_thb` | number? | |
| `bot_products` | object[]? | |
| `zaapi_reply_text` | string? | คำตอบ Zaapi (เปรียบเทียบ) |
| `zaapi_reply_message_id` | string? | |
| `rating` | string? | unrated/good/bad |
| `rated_by` | string? | |
| `rated_at` | Date? | |
| `notes` | string? | |
| `star_rating` | number? | 1-5 |
| `star_rated_by` | string? | |
| `star_rated_at` | Date? | |
| `comment` | string? | |
| `comment_by` | string? | |
| `comment_at` | Date? | |
| `deleted_at` | Date? | soft delete |
| `deleted_by` | string? | |
| `delete_reason` | string? | |
| `origin` | string? | worker/workflow/manual |
| `mode` | string? | standalone/replay |
| `trigger_id` | string? | |
| `bot_routing_decision` | object? | |
| `bot_handoff_to_admin` | boolean? | |
| `bot_handoff_reason` | string? | |
| `bot_image_desc` | string? | |
| `generation_batch_id` | string? | ⚡ Phase 3B-6 — id กลุ่มรอบ generate (unique ต่อรอบ กดซ้ำแชทเดิมแยกกัน) |
| `created_at` | Date | |
| `updated_at` | Date | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | shadowReplyService.list, get, stats | `/shadow-inbox`, `/shadow-inbox/conversations`, `/botworker/replies`, `/replay-compare` |
| Write | generateShadowReply, generateConversationShadowReplies, storeBotReply (bot worker) | `/shadow-inbox` POST, bot worker, test-assignment |
| Update | rateShadowReply, restoreShadowReply | `/shadow-inbox/[id]` PATCH |
| Delete (soft) | deleteShadowReply, clearAllShadowReplies | `/shadow-inbox/[id]` DELETE, `/shadow-inbox?clear_all=1` |

**หน้าที่เข้าถึง:** `/shadow-inbox`, `/botworker`, `/replay-compare`

**หมายเหตุ:** เป็น collection หลักที่เก็บคำตอบบอท — ไม่ส่งจริงให้ลูกค้า

---

### 2.12 `chat_annotations`

**Schema:** `ChatAnnotationDoc` ใน `chatAnnotationService.ts`

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `annotation_id` | string | PK (`ann_<ts36>_<rand>`) |
| `scope` | string | `test_assignment` / `shadow_bot` |
| `conversation_id` | string | ref |
| `color` | string | `red`/`yellow`/`green`/`blue`/`purple`/`orange`/`pink`/`gray` |
| `note` | string | โน้ตเคสที่เจอ |
| `created_by` | string | admin_id |
| `created_at` | Date | |
| `updated_at` | Date | |
| `deleted_at` | Date? | soft delete |
| `deleted_by` | string? | |
| `generation_batch_id` | string? | ⚡ Phase 3B-6 — ผูกกับรอบ generate (scope=`shadow_bot` เท่านั้น) ต่างรอบต่าง mark |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | chatAnnotationService.listAnnotations | `/chat-annotations` GET |
| Write | chatAnnotationService.upsertAnnotation | `/chat-annotations` POST |
| Delete (soft) | chatAnnotationService.deleteAnnotation | `/chat-annotations/[id]` DELETE |

**หน้าที่เข้าถึง:** `/shadow-inbox` (history tab), `/test-assignment`

**หมายเหตุ:**
- `scope="test_assignment"` — 1 annotation ต่อรอบ replay (มี `generation_batch_id` = `replay_batch_id`) — กด Replay ซ้ำแชทเดิม = คนละ annotation
- `scope="shadow_bot"` — 1 annotation ต่อรอบ generate (มี `generation_batch_id`) — กด Generate ซ้ำแชทเดิม = คนละ annotation

---

### 2.13 `quick_replies`

**Schema:** `QuickReplyDoc` ใน `quickReplyService.ts` บรรทัด 12-29

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `quick_reply_id` | string | PK |
| `admin_id` | string? | เจ้าของ (null = สาธารณะ) |
| `platforms` | string[] | ว่าง = ทุกแพลตฟอร์ม |
| `shop_ids` | string[] | ว่าง = ทุกร้าน |
| `category` | string | |
| `title` | string | |
| `body` | string | |
| `enabled` | boolean | |
| `sort_order` | number | auto-increment |
| `created_by` | string | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `is_deleted` | boolean? | soft delete |
| `deleted_at` | Date \| null? | |
| `deleted_by` | string? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | listQuickReplies, listCategories | `/quick-replies`, `/test-chat` (TestChatClient) |
| Write | createQuickReply | `/quick-replies` POST |
| Update | updateQuickReply | `/quick-replies/[id]` |
| Delete (soft) | deleteQuickReply | `/quick-replies/[id]` DELETE |

**หน้าที่เข้าถึง:** `/quick-replies`, `/test-chat`

---

### 2.14 `close_history`

**Schema:** `CloseHistoryDoc` ใน `closeHistoryService.ts` บรรทัด 12-30

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `record_id` | string | PK |
| `conversation_id` | string | ref |
| `shop_id` | string | |
| `customer_id` | string | |
| `closed_by` | string | admin_id |
| `closed_at` | Date | |
| `reason` | string | |
| `category` | string | shipping/product/payment/return_refund/warranty/account/promotion/other |
| `resolution` | string | |
| `note` | string? | |
| `reopened_by` | string? | |
| `reopened_at` | Date? | |
| `reopen_reason` | string? | |
| `sequence` | number | ครั้งที่ปิด (1, 2, 3, ...) |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | listCloseHistory, listCustomerCloseHistory | `/conversations/[id]/close-history` |
| Write | recordClose | statusConversationService.closeConversation |
| Update | recordReopen | statusConversationService.reopenConversation |
| Delete | ไม่มี | |

**หน้าที่เข้าถึง:** `/tickets`, `/botworker` (close history panel)

**หมายเหตุ:** `sequence` นับเฉพาะครั้งปิด — reopen ไม่ increment

---

### 2.15 `chat_accept_sessions`

**Schema:** `ChatAcceptSessionDoc` ใน `chatAcceptService.ts` บรรทัด 17-25

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `session_id` | string | PK |
| `admin_id` | string | ref admins |
| `state` | string | accepting/paused |
| `started_at` | Date | |
| `ended_at` | Date? | |
| `duration_ms` | number? | |
| `reason` | string? | เหตุผลพัก |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | getCurrentState, getCurrentStates, getTodayStats, getTodayStatsBatch | `/profile/accepting-chats`, `/team/chat-status`, `/stats/performance` |
| Write | startSession | `/profile/accepting-chats` |
| Update | closeOpenSession (internal) | ตอน start session ใหม่ |
| Delete | ไม่มี | |

**หน้าที่เข้าถึง:** `/team`, `/tickets` (toggle รับแชท), `/analytics/performance`

---

### 2.16 `chat_processing`

**Schema:** `ChatProcessingDoc` ใน `botWorkerService.ts` บรรทัด 37-50

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `message_id` | string | PK (idempotency) |
| `conversation_id` | string | ref |
| `shop_id` | string | |
| `platform` | string | |
| `status` | string | trigger_matched/bot_answered/handed_off/bot_failed/no_action/workflow_actioned/workflow_resumed |
| `trigger_id` | string? | |
| `trigger_action` | string? | bot_answer/handoff_admin |
| `shadow_reply_id` | string? | ref shadow_replies |
| `assigned_to` | string? | admin_id ที่ถูกจ่ายงาน |
| `assignment_mode` | string? | |
| `error` | string? | |
| `processed_at` | Date | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | isProcessed (internal) | bot worker |
| Write | markProcessed (internal) | bot worker |
| Delete | ไม่มี | |

**หน้าที่เข้าถึง:** ไม่มี UI ตรง — ใช้ภายใน bot worker

---

### 2.17 `shop_personas`

**Schema:** `ShopPersonaDoc` ใน `personaService.ts` บรรทัด 18-32

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `persona_id` | string | PK |
| `shopname` | string | PK (ร่วมกับ platform) |
| `platform` | string | shopee/tiktok/lazada |
| `bot_name` | string | ชื่อตัวแทนบอท |
| `enabled` | boolean | |
| `notes` | string? | หมายเหตุจากแอดมิน |
| `created_at` | Date | |
| `updated_at` | Date | |
| `updated_by` | string? | |
| `is_deleted` | boolean? | soft delete |
| `deleted_at` | Date \| null? | |
| `deleted_by` | string? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | personaService (Next.js), persona.py (Python) | `/persona`, `/shops` (drawer), Python `/chat` |
| Write (upsert) | upsertPersona | `/persona` POST |
| Update | upsertPersona | `/persona/[id]` PATCH |
| Delete (soft) | deletePersona | `/persona/[id]` DELETE |

**หน้าที่เข้าถึง:** `/persona`, `/shops` (drawer), Python bot (อ่านตอนตอบ)

---

### 2.18 `shop_settings`

**Schema:** `ShopSettingsDoc` ใน `shopSettingsService.ts` บรรทัด 17-35

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `settings_id` | string | PK |
| `shopname` | string | PK (ร่วมกับ platform) |
| `platform` | string | |
| `faq_liveagent_enabled` | boolean | เปิด FAQ liveagent ไหม |
| `faq_liveagent_action` | `"handoff" \| "bot_reply"` | action เมื่อ FAQ liveagent trigger |
| `post_handoff_exceptions` | string[]? | keywords ที่บอทยังตอบได้หลัง handoff |
| `notes` | string? | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `updated_by` | string? | |
| `is_deleted` | boolean? | soft delete |
| `deleted_at` | Date \| null? | |
| `deleted_by` | string? | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | shopSettingsService (Next.js), app.py (Python) | `/shop-settings`, Python `/chat` (post_handoff_exceptions) |
| Write (upsert) | upsertShopSettings, upsertShopSettingsBatch | `/shop-settings` POST |
| Delete (soft) | deleteShopSettings | `/shop-settings/[id]` DELETE |

**หน้าที่เข้าถึง:** `/shop-settings`, Python bot (อ่าน post_handoff_exceptions)

---

### 2.19 `system_configs`

**Multi-doc config store** — 1 doc ต่อ `config_key` (unique index). ตอนนี้มี 3 docs:

| `config_key` | schema | เขียนโดย | อ่านโดย |
|--------------|--------|---------|---------|
| `main_config` | `SystemConfigDoc` (systemConfigService.ts บรรทัด 23-71) | systemConfigService (`/config`, `/admin-config`) | systemConfigService, bot worker, buffer service |
| `llm_config` | `LlmConfigDoc` (llmConfigService.ts — key pool AES-GCM + per-role models/providers) | llmConfigService (`/llm`) | **Python `llm.py` `get_llm_config()`** (TTL 10s, env `GEMINI_API_KEY*` fallback), `web_search.py` (`openrouter_keys`) |
| `role_permissions` | `RolePermissionsDoc` (rolePermissionService.ts — seed จาก DEFAULT_PERMISSIONS, cache 30s) | rolePermissionService (`/roles`) | rolePermissionService |

**Fields ของ doc `main_config`:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `shopee_live_read` | boolean | ⚠️ อันตราย — hard-coded false |
| `shopee_live_send` | boolean | ⚠️ อันตราย |
| `shopee_live_mark_read` | boolean | ⚠️ อันตราย |
| `shopee_live_pin` | boolean | ⚠️ อันตราย |
| `shopee_poll` | boolean | ⚠️ อันตราย |
| `tiktok_live_*` | boolean | เหมือน shopee |
| `lazada_live_*` | boolean | เหมือน shopee |
| `mock_mode_enabled` | boolean | |
| `shadow_bot_enabled` | boolean | |
| `polling_interval_ms` | number | |
| `bot_worker_enabled` | boolean | |
| `bot_worker_interval_ms` | number | |
| `bot_buffer_enabled` | boolean | |
| `bot_buffer_window_ms` | number | 1000-30000 |
| `bot_buffer_max_messages` | number | 1-20 |
| `bot_buffer_window_media_ms` | number | |
| `bot_buffer_max_media_messages` | number | |
| `bot_concurrency_limit` | number | 1-500 |
| `workflow_enabled` | boolean | |
| `workflow_priority` | string | workflow_first/trigger_first/both |
| `workflow_run_timeout_ms` | number | 60000-86400000 |
| `assignment_prefer_previous_admin` | boolean | |
| `shopee_bot_url` | string | |
| `tiktok_bot_url` | string | |
| `lazada_bot_url` | string | |
| `updated_by` | string? | |
| `updated_at` | Date | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | getSystemConfig (cache 5s), getAdminConfig, rolePermissionService, Python `llm.py`/`web_search.py` | `/config`, `/admin-config`, `/roles`, `/llm`, bot worker, buffer service, Python `/chat` |
| Write | updateSystemConfig (internal), updateAdminConfig, updateRolePermissions, llmConfigService | `/admin-config` PUT, `/config` PUT, `/roles` PUT, `/llm` PUT |

**หน้าที่เข้าถึง:** `/config` (superadmin), `/admin-config` (editor), `/roles`, `/llm`, Python bot (อ่าน `llm_config`)

---

### 2.20 `assignment_configs`

**Schema:** `AssignmentConfigDoc` ใน `assignmentService.ts` บรรทัด 14-19

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `config_key` | string | PK (default "default") |
| `mode` | `"equal_global" \| "equal_per_shop" \| "equal_per_platform"` | |
| `updated_by` | string? | |
| `updated_at` | Date | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | getActiveAssignmentConfig | `/assignment/config`, `/test-assignment`, bot worker |
| Write/Update | setAssignmentMode | `/assignment/config` PUT |

**หน้าที่เข้าถึง:** `/team`, bot worker (autoAssign)

---

### 2.21 `assignment_cursors`

**Schema:** `AssignmentCursorDoc` ใน `assignmentService.ts` บรรทัด 21-25

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `pool_key` | string | PK (เช่น `global:ticket`, `shop:123:shadowbot`) |
| `last_assigned_admin_id` | string | admin ล่าสุดที่ถูกจ่าย |
| `updated_at` | Date | |

**Access:** internal ใน `assignmentService.autoAssignConversation/reassignConversation`

---

### 2.22 `shop_team_assignments`

**Schema:** `ShopTeamAssignmentDoc` ใน `assignmentService.ts` บรรทัด 27-33

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `shop_id` | string | PK (ร่วม) |
| `admin_id` | string | PK (ร่วม) |
| `is_active` | boolean | |
| `role_on_shop` | string? | |
| `added_at` | Date | |

**Access:**
| Read | assignmentService | `/assignment/shop-team`, `/team` |
| Write | addAgentToShop | `/assignment/shop-team` POST |
| Update/Delete | removeAgentFromShop | `/assignment/shop-team` DELETE |

---

### 2.23 `platform_team_assignments`

**Schema:** `PlatformTeamAssignmentDoc` ใน `assignmentService.ts` บรรทัด 35-40

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `platform` | string | PK (ร่วม) |
| `admin_id` | string | PK (ร่วม) |
| `is_active` | boolean | |
| `added_at` | Date | |

**Access:**
| Read | assignmentService | `/assignment/platform-team`, `/team` |
| Write | addAgentToPlatform | `/assignment/platform-team` POST |
| Update/Delete | removeAgentFromPlatform | `/assignment/platform-team` DELETE |

---

### 2.24 `status_conversation`

**Schema:** `StatusConversationDoc` ใน `statusConversationService.ts` บรรทัด 19-36

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `conversation_id` | string | PK |
| `assigned_to` | string? | admin_id |
| `assigned_at` | Date? | |
| `assignment_mode_used` | string? | |
| `status` | string? | open/closed/handoff/bot/resolved |
| `closed_at` | Date? | |
| `closed_by` | string? | |
| `close_count` | number? | |
| `pinned` | boolean? | |
| `topic` | string? | |
| `item_ids` | string[]? | |
| `updated_at` | Date | |

**⚠️ สำคัญ:** Source of truth สำหรับ admin-owned meta — ไม่โดน sellcenter dump ทับ

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | getMeta, getMetaMap | `/admin/conversations`, assign/handoff/resolve/close/reopen routes |
| Write/Update | upsertMeta, updateStatus, manualAssign, tryAssign, closeConversation, reopenConversation, setTopic, setItemIds, togglePinned, resetUnread | ทุก mutation route |
| Delete | ไม่มี | |

**หน้าที่เข้าถึง:** `/tickets` (จริง), ทุก conversation mutation route

---

### 2.25 `test_status_conversation`

**Schema:** `TestStatusConversationDoc` ใน `testStatusConversationService.ts` บรรทัด 18-37

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `conversation_id` | string | PK (ร่วมกับ source) |
| `source` | string | test_assignment/shadowbot/replay_compare/test_chat/botworker |
| `assigned_to` | string? | |
| `assigned_at` | Date? | |
| `assignment_mode_used` | string? | |
| `assignment_reason` | string? | |
| `status` | string? | |
| `closed_at` | Date? | |
| `closed_by` | string? | |
| `close_count` | number? | |
| `pinned` | boolean? | |
| `topic` | string? | |
| `item_ids` | string[]? | |
| `updated_at` | Date | |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | getTestStatus, getTestStatusMap | `/botworker/conversations`, `/shadow-inbox/conversations`, `/test-assignment` |
| Write/Update | updateTestStatus, tryTestAssign, closeTestConversation, reopenTestConversation | bot worker, test routes |
| Delete | clearTestSource | `/admin/maintenance/clear-status` |

**หน้าที่เข้าถึง:** `/botworker`, `/shadow-inbox`, `/test-assignment`, `/test-chat`

**หมายเหตุ:** ไม่เขียน `admin_logs` / `close_history` เพราะเป็นหน้า test

---

### 2.26 `test_chat_sessions`

**Schema:** ไม่มี TypeScript interface แยก — shape ใน Python `test_chat_api.py`
(ย้ายออกจาก `app.py` ตอน refactor 2026-09-15 — env override `ADMIN_MONGO_COLLECTION_TEST_CHAT_SESSIONS`)

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `_id` | ObjectId | MongoDB PK |
| `shop` | string | ร้าน |
| `title` | string | ชื่อ session |
| `messages` | array | list ของ {role, text, images, image_desc, ...} |
| `created_at` | Date | |
| `updated_at` | Date | |
| `status` | string? | open/closed |
| `closed_at` | Date? | |
| `closed_by` | string? | |
| `bot_claim_info` | object? | (Next.js bot-handoff) |
| `bot_handoff_at` | Date? | (Next.js bot-handoff) |
| `admin_id` | string | ⚡ Phase 3 — เจ้าของ session (ดึงจาก header X-Admin-Id ตอน create) |
| `admin_name` | string | ⚡ Phase 3 — ชื่อเจ้าของ (ดึงจาก header X-Admin-Name ตอน create) |
| `source` | string? | `"script_test"` = session จาก shadow script (`shadow_openrouter.py`) |
| `script_test` | boolean? | marker สำหรับ badge ใน list (ทุกคนเห็น ไม่กรอง admin_id) |

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | Python `test_chat_api.py`, Next.js `bot-handoff`/`test-chat-result`/`admin-chat-result` routes | `/test-chat/sessions` (Python, กรองตาม admin_id + เห็น script_test ทุกคน), `/admin/conversations/bot-handoff` (Next.js) |
| Write (create) | Python `test_chat_api.py`, `chatbot/testscript/shadow_openrouter.py` (source=script_test) | `POST /test-chat/sessions`, shadow script |
| Update | Python `test_chat_api.py` (messages, status), `shadow_openrouter.py` (script sessions), Next.js (bot_claim_info, bot_handoff_at) | `POST /test-chat/sessions/{id}/messages`, `PUT /test-chat/sessions/{id}`, `POST .../close`, `POST .../reopen`, `/admin/conversations/bot-handoff` |
| Delete | Python `test_chat_api.py`, Next.js maintenance | `DELETE /test-chat/sessions/{id}`, `/admin/maintenance/soft-delete-all` |

**หน้าที่เข้าถึง:** `/test-chat/*`

**หมายเหตุ:**
- Python เขียนหลัก แต่ Next.js อ่าน/เขียน `bot_claim_info`, `bot_handoff_at`
- ⚡ Phase 3 — `list_test_chat_sessions` กรองตาม `admin_id` จาก header `X-Admin-Id` (legacy session ที่ไม่มี field `admin_id` ยังเห็นได้ทุกคน เพื่อ backward compat)

---

### 2.27 `test_chat_ratings`

**Schema:** `TestChatRatingDoc` ใน `testChatRatingService.ts` บรรทัด 37-62

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `_id` | ObjectId? | |
| `session_id` | string | ref test_chat_sessions |
| `msg_index` | number | index ของ message ใน session |
| `platform` | string | |
| `shop` | string | |
| `star_rating` | number? | 1-5 |
| `rating` | string? | up/down |
| `comment` | string? | |
| `msg_text_preview` | string? | |
| `msg_stats` | object? | cost, tokens, elapsed |
| `rated_by` | string | |
| `rated_at` | Date | |
| `updated_at` | Date | |

**Access:**
| Read | getRatingsForSession, getAllRatings, getTestChatRatingStats | `/test-chat-ratings` |
| Write/Update | rateTestChatMessage (upsert) | `/test-chat-ratings` POST |

**หน้าที่เข้าถึง:** `/test-chat/*`

---

### 2.28 `test_assignment`

**Schema:** `TestAssignmentDoc` ใน `testAssignmentService.ts` บรรทัด 80-104

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `_id` | ObjectId? | |
| `conversation_id` | string | ref |
| `shop_id` | string | |
| `platform` | string | |
| `shop_name` | string? | |
| `to_name` | string? | |
| `qa` | array | list ของ {message_id, user_text, bot_reply, zaapi_reply, rating, ...} |
| `total_messages` | number | |
| `processed_messages` | number | |
| `final_status` | string | |
| `assigned_to` | string? | |
| `stopped_at_handoff` | boolean | |
| `mock_status` | string | |
| `conv_star_rating` | number? | |
| `conv_rating` | string? | |
| `conv_comment` | string? | |
| `conv_rated_by` | string? | |
| `conv_rated_at` | Date? | |
| `message_ratings` | object? | {message_id: rating} |
| `replayed_by` | string? | ⚡ Phase 3A — ใครกด replay |
| `replayed_at` | Date? | ⚡ Phase 3A — เวลาที่ replay |
| `replay_batch_id` | string? | ⚡ Phase 3B-7 — id กลุ่มรอบ replay (unique ต่อรอบ กดซ้ำแชทเดิมแยกกัน) |
| `deleted_at` | Date? | ⚡ Phase 3B-2 — soft delete |
| `deleted_by` | string? | |
| `delete_reason` | string? | |
| `created_at` | Date | |
| `updated_at` | Date | |

**Access:**
| Read | getTestAssignment, listTestAssignments, listHistoryByAdmin, listReplayBatches, stats, liveAssignmentService, adminKpiService | `/test-assignment`, `/live-assignment`, `/admin-chat-result`, `/stats` |
| Write/Update | saveReplayResult (insertOne), rateMessage, rateConversation, `docs/test/push_unit_reg_to_admin.py` (unit regression results, `replayed_by=unit_reg_*`) | `/test-assignment` POST, script |
| Soft delete | softDelete, restore | `/test-assignment` POST |

**หน้าที่เข้าถึง:** `/test-assignment`, `/replay-compare`, `/live-assignment`, `/admin-chat-result`

**หมายเหตุ:**
- ⚡ Phase 3B-7 — `saveReplayResult` ใช้ `insertOne` (สร้าง doc ใหม่ทุกรอบ) + tag `replay_batch_id`
  - กด Replay ซ้ำแชทเดิม = ไม่ทับ แยก batch กัน
  - ดึงล่าสุดด้วย `getTestAssignment(convId, replayedBy)` (sort created_at desc)
  - ดึงรายการ batches ด้วย `listReplayBatches(convId, replayedBy?)`

---

### 2.29 `buffer_messages`

**Schema:** `BufferMessageDoc` ใน `bufferService.ts` บรรทัด 23-31

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `message_id` | string | PK |
| `conversation_id` | string | ref |
| `shop_id` | string | |
| `platform` | string | |
| `text` | string | |
| `raw_payload` | object? | |
| `received_at` | Date | |

**Access:**
| Read | getBufferedMessages | buffer service |
| Write | insertToBuffer | bufferOrProcess |
| Delete | deleteBufferedMessages | flushBuffer |
| Recover | recoverStaleBuffers | ตอน boot |

**หน้าที่เข้าถึง:** `/test-chat` (test buffer), bot worker (production buffer)

---

### 2.30 `test_chat_uploads`

**Schema:** shape ใน `test-chat/upload/route.ts` บรรทัด 53-61

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `_id` | ObjectId | |
| `filename` | string | |
| `contentType` | string | |
| `size` | number | |
| `data` | Buffer/BSON Binary | |
| `uploaded_by` | string | |
| `uploaded_at` | Date | |

**Access:**
| Read | `/test-chat/uploads/[id]` | ดูรูป |
| Write | `/test-chat/upload` POST | อัปโหลด |

**หน้าที่เข้าถึง:** `/test-chat/*`

---

### 2.31 `workflows`

**Schema:** `WorkflowDoc` ใน `workflowService.ts` บรรทัด 108-145

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `workflow_id` | string | PK |
| `name` | string | |
| `description` | string? | |
| `enabled` | boolean | |
| `shop_ids` | string[] | ว่าง = ทุกร้าน |
| `platforms` | string[] | ว่าง = ทุกแพลตฟอร์ม |
| `trigger_frequency` | string | |
| `false_branch_policy` | string | exit_to_bot/exit_drop |
| `nodes` | array | node graph |
| `edges` | array | edge graph |
| `priority` | number | |
| `version` | number | increment ตอน update |
| `status` | string | draft/published |
| `created_by` | string | |
| `created_at` | Date | |
| `updated_at` | Date | |
| `updated_by` | string? | |
| `is_deleted` | boolean? | soft delete |
| `deleted_at` | Date \| null? | |
| `deleted_by` | string? | |
| `restored_at` | Date? | |
| `restored_by` | string? | |

**Access:**
| Read | listWorkflows, getWorkflow | `/workflows`, `/workflows/[id]` |
| Write (create) | createWorkflow | `/workflows` POST |
| Update | updateWorkflow, toggleWorkflow | `/workflows/[id]`, `/workflows/[id]/toggle` |
| Delete (soft) | deleteWorkflow | `/workflows/[id]` DELETE |
| Restore | restoreWorkflow | `/workflows/[id]/restore` |

**หน้าที่เข้าถึง:** `/workflows`, `/workflows/[id]`, `/shops` (drawer), bot worker (matchAndRun)

---

### 2.32 `workflow_runs`

**Schema:** `WorkflowRunDoc` ใน `workflowEngine.ts` บรรทัด 29-57

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `run_id` | string | PK |
| `workflow_id` | string | ref |
| `workflow_version` | number | version ตอน run |
| `conversation_id` | string | ref |
| `shop_id` | string | |
| `platform` | string | |
| `customer_id` | string? | |
| `status` | string | running/waiting/completed/cancelled/error |
| `current_node_id` | string | node ปัจจุบัน |
| `waiting_for` | string? | รออะไร (wait node) |
| `wait_retry_count` | number? | |
| `wait_started_at` | Date? | |
| `wait_node_id` | string? | |
| `context` | object | context ระหว่าง run |
| `outcome` | string? | ผลลัพธ์ |
| `started_at` | Date | |
| `updated_at` | Date | |
| `completed_at` | Date? | |
| `error` | string? | |

**Access:**
| Read | getActiveRun | workflow engine |
| Write/Update | matchAndRun, resumeFlow, cancelActiveRuns, checkWaitTimeouts | workflow engine |

**หน้าที่เข้าถึง:** ไม่มี UI ตรง — ใช้ภายใน workflow engine

---

## 3. Product DB Collections (dbWallet — read-only)

### 3.1 Connection

**ไฟล์:**
- Python: `chatbot/shopeechat/product_store.py` — `get_client()` + env `MONGO_*`
- Next.js: `ChatAdminWeb/src/backend/db/dbWalletClient.ts` — `ReadOnlyCollection` (บล็อกทุก write)

### 3.2 `ShpProducts` (Shopee products)

**env:** `MONGO_COLLECTION` (default `ShpProducts`) — Next.js ใช้ `SHP_PRODUCTS_COLLECTION` แทน (systemConfigService)

**ใช้ที่:**
- Python `product_store.py` — ค้นสินค้า, vector search, fetch by id, cert search, stock (`_shopee_stock`)
- Python `units.py` — `attach_listing_fields` (ดึง field listing เติม unit card)
- Python `knowledge_base.py` — `_extract_policy_from_descriptions` (นโยบายจาก description) + product match
- Python `app.py` — direct reads (`db[MONGO_COLLECTION]`) หลายจุด
- Python `chat_v2.py`, `chatbotv3/product_match.py` — product retrieval/matching
- Python `frontendScript/replay_compare.py` + `docs/test/*` — replay/test scripts
- Next.js `productService.ts` — listProducts, getProduct, getProductsByIds (ReadOnlyCollection)
- Next.js `systemConfigService.ts` — product stats ใน `/config`

**Fields ที่ใช้ (ไม่ใช่ schema เต็ม — เป็น product DB ภายนอก):**
- `item_id`, `item_status`, `brand`, `cat_name`, `shopname`/`shop`, `item_name`/`name`, `price`, `price_info`, `image_url`, `images`, `description`, `field_list`, `model`[] (`model_id`, `model_name`, `model_sku`, `model_status`, `shopee_ship_box`), `variants`, `tier_variation`, `total_stock`, `sold_out`, `has_promotion`, `is_flash_sale`, `warranty`, `short_link`

**⚠️ Read-only — ห้ามเขียน** (Next.js บล็อกด้วย ReadOnlyCollection, Python ไม่มี write path)

---

### 3.3 `TiksProduct` (TikTok products)

**env:** `TIKTOK_PRODUCTS_COLLECTION` (default `TiksProduct`)

**ใช้ที่:** Next.js `productService.ts` (TikTok platform)

---

### 3.4 `OpenLazadaProducts` (Lazada products)

**env:** `LAZADA_PRODUCTS_COLLECTION` (default `OpenLazadaProducts`)

**ใช้ที่:** Next.js `productService.ts` (Lazada platform)

---

### 3.5 Stock DB — `itStock.Products` (read-only)

**env:** `STOCK_URI` (connection string), `STOCK_DB` (default `itStock`) — collection name hardcoded `Products`

**ไฟล์:** `chatbot/shopeechat/product_store.py` บรรทัด 3584+ (`_stock_products_coll`)

**ใช้ที่:** cert search path เท่านั้น (`search_cert_products` — TISI/มอก./CE/CCC/FCC/RoHS/GB)
- join ผ่าน `shopee_ship_box.{item_id,model_id}` ของ `ShpProducts`
- เก็บ cert flags + ข้อมูล stock ต่อ variant

**⚠️ Read-only — ใช้ lazy connect, fail → cert source นี้ถูกข้าม**

---

## 4. Order DB Collections

### 4.1 Connection

**ไฟล์:**
- Python: `chatbot/shopeechat/order_store.py` — lazy singleton client
- Next.js: `src/app/api/admin/conversations/[conversationId]/orders/route.ts` — lazy client ของตัวเอง

**env:** `ORDER_URI_MONGO`, `ORDER_DB` (default `dbWallet`), `ORDER_COLLECTION` (default `ShpOrders`)

### 4.2 `ShpOrders`

**ใช้ที่:**
- Python `order_store.py` (read-only) — ตอบลูกค้าใน `/chat` + warranty flow
- Next.js `orders/route.ts` (read-only) — order panel ในหน้า conversation (lookup ด้วย `buyer_user_id` ← `conversation.customer_id`)

**Fields ที่ใช้:**
- `order_sn`, `order_status`, `buyer_user_id`, `buyer_username`, `shopname`
- `item_list[]` (`item_name`, `model_name`, `model_sku`, `item_sku`, `model_quantity_purchased`, `model_discounted_price`, `model_original_price`, `image_info.image_url`, `item_id`, `model_id`)
- `package_list[]` (`logistics_status`, `shipping_carrier`, `tracking_no`, `tracking_number`, `parcel_id`, `waybill_id`)
- `create_time`, `pay_time`, `ship_by_date`, `pickup_done_time`, `update_time`
- `recipient_address` (name/phone ถูก Shopee mask อยู่แล้ว), `total_amount`, `currency`, `estimated_shipping_fee`, `actual_shipping_fee`, `payment_method`, `cod`, `days_to_ship`, `cancel_by`, `cancel_reason`, `buyer_cancel_reason`

**ฟังก์ชัน Python:**
- `extract_order_sn(message)` / `extract_tracking_number(message)` — ดึงเลขจากข้อความ/OCR
- `lookup_order(order_sn, shop_filter)` / `lookup_by_tracking(tracking_no, shop_filter)`
- `build_order_context(order)` — สร้าง context string สำหรับ LLM

**⚠️ Read-only** — ไม่มี write path ทั้ง Python และ Next.js

---

## 5. Collections ที่ Python เป็นเจ้าของ (admin DB)

อยู่ใน admin DB เดียวกัน แต่ **ไม่มีใน `COLLECTIONS`** — Next.js ไม่แตะ (ยกเว้น test_chat_sessions
ที่อยู่ใน COLLECTIONS เพราะ Next.js อ่าน/เขียน bot_claim_info ด้วย — ดู §2.26)

### 5.1 `conversation_products`

**ไฟล์:** `chatbot/shopeechat/conversation_products.py` — collection name hardcoded

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `conversation_id` | string | PK |
| `platform` | string? | |
| `shop` | string? | |
| `products` | array | list ของ {item_id, name, source, mentioned_at, is_anchor, card} |
| `active_item_id` | string \| int? | anchor ล่าสุด |
| `order_anchors` | array? | list ของ order ที่ลูกค้าส่งมา {order_sn, mentioned_at, ...} |
| `active_order_sn` | string? | order ล่าสุด (อัปเดตทุกครั้งที่มี order anchor ใหม่) |
| `claim_state` | object? | warranty claim state — {customer_name, customer_phone, customer_order_id, ...} merge-fill โดย `warranty_flow` |
| `last_updated` | Date | |

**product entry:** `{item_id, name, source: user_item_card|user_variation_card|user_order|bot_suggestion, mentioned_at, is_anchor, card?}`

**Access:**
| การกระทำ | โดยใคร | ผ่านไหน |
|---------|-------|--------|
| Read | load_timeline, get_active_product, get_suggestion_latest, resolve_active_by_message, get_active_order_sn, get_order_anchors, load_claim_state | Python `/chat` (app.py, chat_v2, warranty_flow, order_flow) |
| Write/Update | save_timeline, add_product, add_order_anchor, update_claim_state, clear_claim_state | Python `/chat` |

**หน้าที่เข้าถึง:** ไม่มี UI ตรง — Python bot ใช้ภายใน

**หมายเหตุ:** ทำให้ follow-up ไม่ลืมสินค้า/order เก่า — active = anchor ล่าสุด

---

### 5.2 `test_chat_logs`

**ไฟล์:** `chatbot/shopeechat/test_chat_api.py` (`_log_testchat_action`) — collection name hardcoded

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `action` | string | create_session/send/close/reopen/delete/... |
| `session_id` | string? | ref test_chat_sessions |
| `admin_id` | string | จาก header X-Admin-Id |
| `admin_name` | string | จาก header X-Admin-Name |
| `timestamp` | Date | |
| `**extra` | object | ข้อมูลเพิ่มเติม (shop, title, ...) |

**Access:** Python เขียน + อ่าน (`GET /test-chat/logs`) — fail เงียบ (logging ต้องไม่ทำ request fail)

**หน้าที่เข้าถึง:** ไม่มี UI ตรง — Python log only

---

### 5.3 `image_texts`

**ไฟล์:** `chatbot/shopeechat/scripts/import_image_texts.py` (เขียน) — collection name hardcoded

**ใช้ทำอะไร:** OCR text จากรูปใน description/variant ของสินค้า (Gemini vision offline batch) — ใช้ตอน cert search + unit card

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `image_id` | string | PK (unique index) — dedupe key |
| `image_url` | string | |
| `item_ids` | int[] | items ที่ใช้รูปนี้ (desc + gallery + variant options) |
| `kind` | string | desc_field / gallery / variant |
| `text` | string | OCR result |
| `truncated` | boolean? | |
| `model` | string? | vision model ที่ใช้ |
| `ts` | number | timestamp (เก็บเฉพาะ status=ok ล่าสุด) |

**Access:**
| เขียน | `import_image_texts.py` — upsert จาก `exports/image_texts.jsonl` |
| อ่าน | `product_store.py` (cert search OCR source), `units.py` `attach_image_texts` |

---

### 5.4 `sellable_units`

**ไฟล์:** `chatbot/shopeechat/units.py` (อ่าน), `scripts/build_sellable_units.py` + `import_sellable_units.py` (เขียน)

**env:** `ADMIN_MONGO_COLLECTION_UNITS` (default `sellable_units`)

**ใช้ทำอะไร:** unit-level product index (item_id × model_id) — flag-gated `USE_UNIT_INDEX`
listing หนึ่งมีหลายรุ่นย่อย ค้นระดับรุ่นย่อยที่ขายจริง — exact model_code → field filter →
vector (`exports/unit_embeddings.npz`) → merge+rank; ว่าง → fallback legacy listing path

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `unit_id` | string | PK (unique) — `{item_id}:{model_id\|solo\|m<idx>}` |
| `item_id` / `model_id` | int | ref ShpProducts |
| `display_name`, `item_name`, `model_name`, `model_sku` | string | |
| `kind`, `product_type` | string | classifier output |
| `charger_subtype`, `cable_subtype`, `camera_subtype` | string? | subtype |
| `components` | string[] | |
| `model_codes` | string[] | index — exact code lookup |
| `confidence` | string | high/medium/low |
| `price`, `stock` | number | snapshot ตอน build |
| `item_status`, `model_status` | string | |
| `shop`, `brand`, `cat_name` | string | |
| `sellable` | boolean | `item_status=="NORMAL" and stock>0` — ⚠️ อ่านสดจาก Mongo ทุกครั้ง (`_sellable_mask`) ไม่ใช้ค่าใน npz |
| `answerable`, `oos_in_name`, `has_description`, `has_warranty_info` | boolean | |
| `desc_sections` | object | parsed description sections |
| `image_ids` | string[] | ref `image_texts` |
| `search_text` | string | text ที่ embed ลง unit_embeddings.npz |

**Indexes (สร้างโดย import script):** `unit_id`(unique), `model_codes`, `item_id`, `sellable`, `shop`, `product_type`

**Access:**
| เขียน | `import_sellable_units.py` — replace_one upsert จาก `exports/sellable_units.jsonl` |
| อ่าน | `units.py` — runtime search; join `kb_products` (`attach_kb_specs`), `image_texts` (`attach_image_texts`), `ShpProducts` (`attach_listing_fields`) |

---

### 5.5 `kb_products`

**ไฟล์:** `docs/adminbase/script/import_adminbase.py` (เขียน), `knowledge_base.py` `_kb_products_coll()` (อ่าน)

**env:** `ADMIN_MONGO_COLLECTION_KB_PRODUCTS` (default `kb_products`)

**ใช้ทำอะไร:** KB product_spec + comparison จาก adminbase Excel import — แยกจาก `knowledge_base` (admin UI)
ตั้งแต่ KB re-import 2026-09-21

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `type` | string | `product_spec` / `comparison` (จากชื่อไฟล์) |
| `brand`, `model`, `category`, `category_id` | string | identity |
| `model_codes` | string[] | extract จาก model — exact code lookup |
| `item_ids` | string[] | link ไป ShpProducts ผ่าน model_codes |
| `highlights`, `description`, `box_contents` | string | |
| `warranty_period`, `warranty_note`, `notes`, `weight`, `dimensions` | string | |
| `canonical_specs` | object | spec map ผ่าน `spec_key_map` (~45 canonical keys: capacity_mah/input_spec/screen_size/...) |
| `specs_raw` | object | spec ที่ไม่มี canonical map (column ซ้ำเก็บ `name (2)`, `name (3)`) |
| `extra_fields` | object | ค่ายาว >200 ตัวอักษร |
| `is_spec_sheet` | boolean? | flag จากชื่อไฟล์/sheet |
| `source_file`, `source_sheet`, `source_row` | | upsert key |
| `active`, `version`, `created_at`, `updated_at`, `updated_by` | | `updated_by=system_import` |

**Access:**
| เขียน | `import_adminbase.py` — upsert by (source_file, source_sheet, source_row); `--reset`/`--dry-run` |
| อ่าน | `knowledge_base.py` (spec/comparison/brand list), `units.py` `attach_kb_specs` |

**หมายเหตุ:** runtime normalize `canonical_specs`/`specs_raw` → `specs` ใน `_search_kb_single` (schema alias)

---

### 5.6 `kb_qa`

**ไฟล์:** `import_adminbase.py` (เขียน), `knowledge_base.py` `_kb_qa_coll()` (อ่าน)

**env:** `ADMIN_MONGO_COLLECTION_KB_QA` (default `kb_qa`)

**ใช้ทำอะไร:** QA pairs (troubleshooting จาก Excel) + `general_faq` (จากไฟล์ .txt เงื่อนไขรับประกัน)

**Fields:**
| Field | Type | หมายเหตุ |
|-------|------|---------|
| `type` | string | `qa` / `general_faq` |
| `q`, `a` | string | question/answer — caller normalize `a` → `answer` |
| `kb_ref` | string? | `{source_file}:{source_sheet}:{source_row}` ชี้กลับ kb_products |
| `topic` | string | `{brand} {model}` หรือ "รับประกัน" (general_faq) |
| `model_codes`, `item_ids` | array | inherit จาก product doc ของ row เดียวกัน |
| `question_patterns`, `applies_to_brands`, `applies_to_categories` | string[]? | เฉพาะ general_faq |
| `source_file`, `source_sheet`, `source_row`, `qa_idx` | | upsert key (4 fields) |
| `active`, `version`, `created_at`, `updated_at`, `updated_by` | | |

**Access:**
| เขียน | `import_adminbase.py` |
| อ่าน | `knowledge_base.py` (`get_general_faq` → fallback `knowledge_base`; QA lookup), `build_embeddings.py` (embed QA) |

---

### 5.7 `kb_raw`

**ไฟล์:** `import_adminbase.py` (เขียน)

**env:** `ADMIN_MONGO_COLLECTION_KB_RAW` (default `kb_raw`)

**ใช้ทำอะไร:** audit trail — raw source data ทุกแถวที่มีข้อมูล (ไม่ทิ้ง column ซ้ำ)
- `pairs`: list-of-pairs `[{col, val}]` ตามลำดับ column จริง
- `source_file`, `source_sheet`, `source_row` — upsert key

**Access:** เขียนอย่างเดียว — ยังไม่มี runtime reader (ใช้ trace/audit ย้อนหลัง)

---

## 6. Collection ที่ประกาศแต่ยังไม่ใช้

| Collection | สถานะ | หมายเหตุ |
|------------|-------|---------|
| `auth_tokens` | legacy | ประกาศใน COLLECTIONS + มี index แต่ไม่มี service/route ใช้ |
| `guardrails` | legacy | ประกาศแต่ไม่มี service ใช้ |
| `pushevents` | legacy | ประกาศแต่ไม่มี service ใช้ |
| `requestlogs` | legacy | ประกาศแต่ไม่มี service ใช้ |

**แนะนำ:** ตรวจสอบว่าจะใช้ใน phase ถัดไปหรือลบออกจาก COLLECTIONS

---

## 7. Local files (ไม่ใช่ Mongo)

ส่วนหนึ่งของ data pipeline เป็นไฟล์ local ใน `exports/` (Docker copy เข้า image)

| ไฟล์ | สร้างโดย | ใช้โดย |
|------|---------|--------|
| `exports/ShpProducts.export.json` | `scripts/export_mongo.py` (dump จาก dbWallet) | build scripts ทั้งหมด (offline snapshot) |
| `exports/product_embeddings.npz` | `scripts/build_embeddings.py` (default mode — products จาก export) | `product_store.py` vector search (mtime auto-reload) |
| `exports/unit_embeddings.npz` | `scripts/build_embeddings.py --units` (embed `search_text` จาก `sellable_units.jsonl`) | `units.py` vector search (mtime auto-reload) |
| `exports/qa_embeddings.npz` | `scripts/build_embeddings.py --qa` (embed `topic \| q` จาก `kb_qa` ใน admin DB) | `knowledge_base.py` `search_qa`/`_qa_vectors` (flag `USE_QA_KB`, mtime auto-reload) |
| `exports/sellable_units.jsonl` | `scripts/build_sellable_units.py` (จาก export + `_shopee_stock`) | `import_sellable_units.py` → Mongo |
| `exports/image_texts.jsonl` | `scripts/build_image_texts.py` (Gemini vision batch) | `import_image_texts.py` → Mongo |
| `exports/typo_dict.json` | `scripts/build_typo_dict.py` (คำจริงจาก catalog) | `route_context.py` `normalize_message` |
| `device_specs_data.py` | curated module (ไม่ใช่ไฟล์ data — เป็น dict `DEVICE_SPECS` ในโค้ด) | `device_compat.py` (compatibility engine) |

---

## 8. Access Matrix รวม

### 8.1 Admin DB (Next.js ผ่าน `COLLECTIONS`)

| Collection | Read หลัก | Write หลัก | Update หลัก | Delete | หน้าที่เข้าถึง |
|------------|----------|-----------|------------|--------|---------------|
| `admins` | authService | authService (SSO), `seed-superadmin.mjs` | authService | authService (soft) | users, team, tickets, botworker, ... |
| `sessions` | authService | authService | authService | (revoke) | ทุกหน้า (middleware) |
| `knowledge_base` | knowledgeBaseService, Python (fallback) | knowledgeBaseService | knowledgeBaseService | knowledgeBaseService (soft) | knowledge, shops, Python bot (legacy fallback) |
| `tickets` | ticketService | ticketService | ticketService | ticketService (soft) | stats/dashboard |
| `admin_logs` | adminLogService | ทุก service (audit), `cleanup-test-artifacts.ts` (read) | — | — | logs, analytics |
| `conversations` | conversationService, หลาย route, workflowEngine, Python `replay_compare.py` | conversationService, sellcenter dump | conversationService, statusConversationService, `/labels` | — | tickets, botworker, shadow-inbox, ... |
| `messages` | messageService, bot worker, liveAssignmentService, Python `replay_compare.py` | messageService, sellcenter dump | botWorkerService (image_desc cache) | — | tickets, botworker, shadow-inbox |
| `shops` | shopService | shopService, `sync-shops.ts`, data writer | shopService | — | shops, config, workflows, triggers, ... |
| `customers` | customerService | customerService (data writer) | customerService | — | contacts |
| `triggers` | triggerService, Python `replay_compare.py` | triggerService | triggerService | triggerService (soft) | triggers, shops, bot worker |
| `shadow_replies` | shadowReplyService, adminKpiService, messageService | shadowReplyService, bot worker | shadowReplyService | shadowReplyService (soft), `clear-shadow-replies.ts` | shadow-inbox, botworker, replay-compare |
| `chat_annotations` | chatAnnotationService | chatAnnotationService | chatAnnotationService | chatAnnotationService (soft) | shadow-inbox, test-assignment |
| `quick_replies` | quickReplyService | quickReplyService | quickReplyService | quickReplyService (soft) | quick-replies, test-chat |
| `close_history` | closeHistoryService | closeHistoryService | closeHistoryService | — | tickets, botworker |
| `chat_accept_sessions` | chatAcceptService | chatAcceptService | chatAcceptService | — | team, tickets, analytics |
| `chat_processing` | botWorkerService | botWorkerService | — | — | (internal — idempotency) |
| `shop_personas` | personaService, Python `persona.py` | personaService | personaService | personaService (soft) | persona, shops, Python bot |
| `shop_settings` | shopSettingsService, Python `app.py` | shopSettingsService | shopSettingsService | shopSettingsService (soft) | shop-settings, Python bot |
| `system_configs` | systemConfigService, rolePermissionService, llmConfigService, Python `llm.py`/`web_search.py` | systemConfigService, rolePermissionService, llmConfigService | เหมือน write | — | config, admin-config, roles, llm, Python bot |
| `assignment_configs` | assignmentService | assignmentService | assignmentService | — | team, bot worker |
| `assignment_cursors` | assignmentService | assignmentService | assignmentService | — | (internal) |
| `shop_team_assignments` | assignmentService | assignmentService | assignmentService | assignmentService | team |
| `platform_team_assignments` | assignmentService | assignmentService | assignmentService | assignmentService | team |
| `status_conversation` | statusConversationService | statusConversationService | statusConversationService | `/admin/maintenance/clear-status` | tickets (จริง), mutation routes |
| `test_status_conversation` | testStatusConversationService, bot-handoff route | testStatusConversationService | testStatusConversationService | clearTestSource | botworker, shadow-inbox, test-assignment |
| `test_chat_sessions` | Python `test_chat_api.py`, Next.js routes | Python `test_chat_api.py`, `shadow_openrouter.py` | Python, Next.js (bot_claim_info) | Python, `/admin/maintenance/soft-delete-all` | test-chat |
| `test_chat_ratings` | testChatRatingService, adminKpiService | testChatRatingService (upsert) | testChatRatingService | `/admin/maintenance/soft-delete-all` | test-chat, admin-chat-result |
| `test_assignment` | testAssignmentService, liveAssignmentService, adminKpiService | testAssignmentService, `push_unit_reg_to_admin.py` | testAssignmentService | softDelete/restore | test-assignment, replay-compare, live-assignment, admin-chat-result |
| `buffer_messages` | bufferService | bufferService | — | bufferService | (internal), test-chat |
| `test_chat_uploads` | route | route (upload) | — | — | test-chat |
| `workflows` | workflowService, `cleanup-test-artifacts.ts` | workflowService | workflowService | workflowService (soft/restore) | workflows, shops, bot worker |
| `workflow_runs` | workflowEngine | workflowEngine | workflowEngine | — | (internal) |

### 8.2 Admin DB (Python-owned — ไม่อยู่ใน `COLLECTIONS`)

| Collection | Read | Write | หมายเหตุ |
|------------|------|-------|---------|
| `conversation_products` | Python bot runtime | Python bot runtime | product/order timeline + claim_state |
| `test_chat_logs` | Python `/test-chat/logs` | Python `test_chat_api.py` | audit log test chat |
| `image_texts` | `product_store.py`, `units.py` | `import_image_texts.py` | OCR จากรูปสินค้า |
| `sellable_units` | `units.py` | `import_sellable_units.py` | unit index (flag `USE_UNIT_INDEX`) |
| `kb_products` | `knowledge_base.py`, `units.py` | `import_adminbase.py` | KB product spec/comparison |
| `kb_qa` | `knowledge_base.py`, `build_embeddings.py` | `import_adminbase.py` | KB QA + general_faq |
| `kb_raw` | — | `import_adminbase.py` | audit trail (ไม่มี reader) |

### 8.3 External DBs (read-only — ห้ามเขียน)

| Collection | DB/env | Read โดย |
|------------|--------|----------|
| `ShpProducts` | `MONGO_*` (dbWallet) | Python `product_store`/`units`/`knowledge_base`/`app.py`/`chat_v2`/`chatbotv3`, Next.js `productService`+`systemConfigService` (ReadOnlyCollection), test/replay scripts |
| `TiksProduct` | `TIKTOK_PRODUCTS_COLLECTION` (dbWallet) | Next.js `productService` |
| `OpenLazadaProducts` | `LAZADA_PRODUCTS_COLLECTION` (dbWallet) | Next.js `productService` |
| `ShpOrders` | `ORDER_*` | Python `order_store.py`, Next.js `/admin/conversations/[id]/orders` |
| `itStock.Products` | `STOCK_URI`/`STOCK_DB` | Python `product_store.py` (cert search) |

### 8.4 Declared-but-unused (ยังไม่มี service/route ใช้)

`auth_tokens`, `guardrails`, `pushevents`, `requestlogs` — มีใน `COLLECTIONS` + สร้าง index แต่ไม่มี caller

---

## อ้างอิงไฟล์หลัก

| ไฟล์ | หน้าที่ |
|------|---------|
| `ChatAdminWeb/src/backend/lib/config.ts` | Collection names + env config (36 keys) |
| `ChatAdminWeb/src/backend/db/mongoClient.ts` | MongoDB connection + COLLECTIONS + ensureIndexes |
| `ChatAdminWeb/src/backend/db/dbWalletClient.ts` | Read-only product DB (ReadOnlyCollection) |
| `ChatAdminWeb/src/backend/service/*.ts` | 34 services (แต่ละ service มี interface ของ doc) |
| `ChatAdminWeb/src/app/api/admin/conversations/[conversationId]/orders/route.ts` | Order DB read (Next.js) |
| `ChatAdminWeb/scripts/bot-worker.ts` | poll messages → buffer → trigger/workflow → bot → shadow_replies |
| `ChatAdminWeb/scripts/sync-shops.ts` | aggregate `conversations_shp` → upsert `shops` |
| `chatbot/shopeechat/product_store.py` | Product DB (read-only) + stock DB `itStock.Products` (cert) |
| `chatbot/shopeechat/units.py` | `sellable_units` unit index + `unit_embeddings.npz` |
| `chatbot/shopeechat/order_store.py` | Order DB (read-only) |
| `chatbot/shopeechat/knowledge_base.py` | `kb_products`/`kb_qa` + legacy `knowledge_base` fallback + admin client builder |
| `chatbot/shopeechat/persona.py` | `shop_personas` (admin DB, read-only) |
| `chatbot/shopeechat/llm.py` | `system_configs.llm_config` (admin DB, read-only, TTL 10s) |
| `chatbot/shopeechat/conversation_products.py` | `conversation_products` (admin DB, read/write) |
| `chatbot/shopeechat/test_chat_api.py` | `test_chat_sessions` + `test_chat_logs` (admin DB, CRUD) |
| `chatbot/shopeechat/app.py` | `/chat` entry — อ่าน `shop_settings`, `ShpProducts`, `conversation_products` |
| `chatbot/shopeechat/scripts/import_*.py` | import `image_texts`/`sellable_units` เข้า admin DB |
| `chatbot/shopeechat/scripts/build_*.py` | build exports (`sellable_units.jsonl`, `image_texts.jsonl`, `*_embeddings.npz`) |
| `docs/adminbase/script/import_adminbase.py` | import `kb_products`/`kb_qa`/`kb_raw` จาก `docs/adminbase/*.xlsx` |
| `chatbot/frontendScript/replay_compare.py` | replay engine — อ่าน `conversations_shp`/`messages_shp`/`triggers`/`ShpProducts` |
| `chatbot/testscript/shadow_openrouter.py` | shadow test — เขียน `test_chat_sessions` (source=script_test) |
| `docs/test/push_unit_reg_to_admin.py` | เขียน `test_assignment` (unit regression) |
