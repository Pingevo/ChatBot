# Plan — Botworker True-Parallel Sandbox

## เป้าหมาย

ทำให้ `/botworker` เป็น **parallel run ของ /tickets ที่สมบูรณ์** — เห็นแชทจริง ลูกค้าทักจริง บอทตอบจริง แอดมินจัดการได้จริง (รับเรื่อง/โยนงาน/ตอบแชท/ปิดแชท) — แต่ **state ทุกอย่างแยกจาก tickets** เพื่อทดสอบระบบก่อนเปิดใช้จริง (live)

## กติกาแยก/แชร์ (จาก requirement)

**แชร์ได้ (ใช้ร่วมกับของจริง):**

- `messages_shp` — อ่านข้อความลูกค้า/zaapi (read-only) + `image_desc` (field additive, vision cache — user อนุมัติแชร์)
- `conversation_products` — anchor/timeline สินค้า (เขียนโดย Python bot — แชร์กับ shadowbot ตามเดิม)
- `conversations` — อ่านข้อมูลแชท/ลูกค้า/orders (read-only)
- `shops`, `admins`, `customers`, `workflows`, `triggers`, `system_configs` — อ่าน config/master data

**ต้องแยก (ห้ามแตะของจริง):**

- สถานะแชท / assigned_to / close / reopen → `test_status_conversation` (source=`botworker`) — มีอยู่แล้ว
- คำตอบบอท → `shadow_replies` (origin=worker/workflow) — มีอยู่แล้ว
- **ข้อความที่แอดมินตอบใน parallel** → collection ใหม่ `botworker_messages`
- **ประวัติการจ่ายงาน/status change ของ parallel** → collection ใหม่ `botworker_events`
- assignment cursor → แยกอยู่แล้วผ่าน poolKey suffix `:<source>` (`*:botworker` ≠ `*:ticket`)
- claim info จาก Python handoff → test doc (`bot_claim_info`) ไม่เขียน `conversations`

## ปัญหาปัจจุบันที่ต้องแก้ (audit เจอ)

| # | จุดรั่ว | ผล |
|---|---|---|
| 1 | `pickAgent` → `handoffToAdmin` ตัวจริง | worker handoff → assign แอดมินใน /tickets จริง |
| 2 | status guard อ่าน `status_conversation` จริง | แอดมินปิด/รับใน parallel → worker ไม่รู้ ตอบซ้ำ |
| 3 | workflow `assign_ticket`/`add_label`/`close_ticket`/`add_note` + conditions `conversation_status`/`assignee` | เขียน/อ่าน `conversations`+`status_conversation` จริง |
| 4 | `callBot(simulate=false)` → Python `_send_handoff` → `/api/.../bot-handoff` ไม่มี simulate | warranty claim จาก worker → เขียน state จริง |
| 5 | ปุ่มหน้า /botworker ยิง API จริง | กดปิด/โยน/รับ = แก้ ticket จริง + หน้าอ่าน test store → **กระพริบกลับ** (bug ที่รายงาน) |
| 6 | ปุ่ม "รับเรื่อง" = `handoffToAdmin` (pool algorithm) | ไม่ assign ให้คนกด — ทั้ง tickets และ botworker |
| 7 | ไม่มีช่องตอบแชท | แอดมินตอบใน parallel ไม่ได้ |
| 8 | ตอน pool ว่างไม่มี pending marker/drain | ลูกค้าถูกส่งต่อแต่ไม่มี admin รับงาน → งานไม่ถูกจ่ายย้อนหลังเมื่อเช้ามี admin เปิดรับแชท |
| 9 | dropdown โยนงานแสดง admin ที่พักรับแชท | manual transfer สามารถเลือก admin ที่ `is_accepting_chats=false` ได้ แม้ auto assignment จะกรองออก |

## Lifecycle ที่ต้องการ (parallel)

```
ลูกค้าทัก (messages_shp) → buffer → dedup
  → guard: อ่าน test_status_conversation[botworker]
      assigned_to มี / status=open    → skip (แอดมินกำลังตอบ)
      closed/resolved                 → reopen (status=bot) → ทำต่อ
  → trigger → handoff_admin → handoffToAdminTest → assign + status=open → บอทเงียบ
            → bot_answer  → bot_template (ตอบตรง) หรือ callBot
  → workflow (testSource=botworker — side effects ลง test store)
  → callBot → ตอบ → shadow_replies
              → ตอบไม่ได้/handoff → handoffToAdminTest → status=open (assign) / handoff+pending_assignment (pool ว่าง)

แอดมินในหน้า botworker:
  รับเรื่อง → assign ตัวเอง, status=open, worker ไม่ auto-reply จนกว่าจะ reopen/ปล่อยกลับ bot
  ตอบแชท → เขียน botworker_messages (bubble สีตาม profile admin) — ไม่ส่งจริงไป Shopee แต่เข้า bot history ของ sandbox
  โยนงาน → assigned_to=คนใหม่, status=open
  ปิดแชท → status=closed + close_history[]
  ลูกค้าทักซ้ำหลังปิด → reopen → เข้า loop เดิม (guard→trigger→workflow→bot)
```

---

## แผนงาน (แบ่ง 8 ส่วน)

### Part A — Worker pipeline อ่าน/เขียน test store เท่านั้น

ไฟล์: `src/backend/service/botWorkerService.ts`

1. **Status guard** (~L320-360): เปลี่ยน `statusConversationService.getMeta` → `testStatusConversationService.getTestStatus(convId, "botworker")`
   - `assigned_to` มี หรือ `status==="open"` → skip + markProcessed(no_action)
   - `closed|resolved` → `reopenTestConversation(convId,"botworker")` (status=bot, clear assigned) → ทำต่อ
2. **`pickAgent`** (~L254): `handoffToAdmin` → `handoffToAdminTest({source:"botworker"})` — cursor แยกอัตโนมัติ (poolKey `*:botworker`); ลบ mirror `updateTestStatus` ซ้ำ (handoffToAdminTest เขียนเอง)
3. **Workflow handoff** (`handleWorkflowResult` ~L202): เดิม engine assign เอง — หลัง engine ใส่ testSource แล้ว engine จะเขียน test store เอง (ดู Part C); ฝั่ง worker แค่ markProcessed+log → `botworker_events`
4. **`storeBotReply`** — คงเขียน `image_desc` ลง `messages_shp` (user อนุมัติแชร์) + `bot_image_desc` บน shadow doc (มี field อยู่แล้ว — ใส่เพิ่มเพื่อให้ reply doc self-contained)
5. **History priority ของ botworker**
   - `getGroupedHistoryForBot` / history path ของ worker ต้องใช้คำตอบจาก `shadow_replies` ที่ `origin in ["worker","workflow"]` และ `mode="standalone"` ก่อน Zaapi เสมอ
   - workflow delivered ที่ใช้ suffix `__wf<N>` ต้องรวมกลับเป็น reply เดียวตาม base inbound id เหมือน fix ล่าสุด
   - `botworker_messages` role=admin ต้องถูก merge เข้า sandbox history เป็น model/admin turn ตามลำดับเวลา เพื่อให้บอทรู้ว่า admin ใน parallel เคยตอบอะไรไปแล้ว
   - ห้ามเอา shadow replies จาก shadowbot/replay/test source อื่นมาปน history ของ botworker
6. `logAdminEvent` → เปลี่ยนเป็น `logBotworkerEvent` (เขียน `botworker_events` แทน `admin_logs`) ทุก call site ใน worker path

### Part B — handoffService + testStatusConversationService

ไฟล์: `handoffService.ts`, `testStatusConversationService.ts`

1. `handoffToAdminTest` — เพิ่ม param `assignedStatus?: "handoff"|"open"` (default "handoff" คงพฤติกรรม test-chat/shadowbot เดิม); worker ส่ง `"open"` — requirement: assign สำเร็จ → status=open
2. `TestStatusConversationDoc` เพิ่ม fields:
   - `labels?: string[]` — สำหรับ workflow add_label
   - `close_history?: { closed_at: Date; closed_by: string; reason: string; category: string; resolution: string; note?: string }[]`
   - `bot_claim_info?: unknown` — claim จาก Python handoff
   - `reopen_count?: number`
3. เพิ่ม `pushTestCloseHistory(conversationId, source, entry)` — `$push` เข้า close_history ใน test doc
4. `manualTestAssign(conversationId, source, targetAdminId, byAdminId)` — assign ตรง (transfer/accept) — atomic เหมือน `manualAssign` ตัวจริง

### Part C — Workflow engine sandbox mode

ไฟล์: `workflowEngine.ts`

เพิ่ม `testSource?: TestSource` ใน `EngineMessage` (worker ส่ง `"botworker"`, test-chat ไม่ส่ง = เดิม):

| node/condition | testSource ไม่มี (เดิม) | testSource มี (worker) |
|---|---|---|
| `assign_ticket` direct | `conversations.updateOne(assigned_to)` | `manualTestAssign(convId, testSource, admin, "workflow")` |
| `assign_ticket` auto | `handoffToAdmin` | `handoffToAdminTest(source=testSource, assignedStatus:"open")` |
| `add_label` | `conversations.$addToSet(labels)` | `test_status_conversation.$addToSet(labels)` |
| `close_ticket` | `closeConversation` (status_conversation + close_history + admin_logs) | `closeTestConversation` + `pushTestCloseHistory` + `botworker_events` |
| `add_note` | (เช็ก target — ถ้าเขียน conversations → test doc `notes[]`) | test doc |
| `let_ai_respond` | `callBot(...)` | `callBot({..., testSource})` |
| cond `conversation_status` | อ่าน status_conversation/conversations | อ่าน test doc |
| cond `assignee` | อ่าน assigned_to จริง | อ่าน test doc.assigned_to |

### Part D — callBot + Python handoff isolation

ไฟล์: `botCallService.ts`, `chatbot/shopeechat/app.py`, `chatbot/shopeechat/responses.py`, `api/admin/conversations/bot-handoff/route.ts`

1. `BotCallParams.testSource?: TestSource`:
   - `resolveTicketState`: testSource มี → อ่าน `test_status_conversation` (source=testSource) แทน conversations/test_chat_sessions
   - POST body: `simulate_assignment: true` + `test_source: <source>` เมื่อ testSource มี
2. Python `ChatRequest` เพิ่ม `test_source: str | None = None`
3. `_send_handoff` payload เพิ่ม `"test_source": req.test_source` เมื่อมี (ส่งคู่กับ `simulate`)
4. `bot-handoff` route:
   - body เพิ่ม `test_source?: string` — validate ∈ `["botworker","test_chat","shadowbot","replay_compare","test_assignment"]`
   - `test_source` มี → `handoffToAdminTest({source: test_source, assignedStatus:"open"})` + claim → `test_status_conversation.bot_claim_info` (แทน test_chat_sessions) + log `botworker_events` (ถ้า source=botworker)
   - `simulate=true` ไม่มี test_source → path เดิม (test_chat)
   - ไม่มีทั้งคู่ → path จริงเดิม (tickets)

### Part E — API routes ใหม่สำหรับหน้า /botworker

สร้างใต้ `src/app/api/botworker/conversations/[conversationId]/`:

| route | ทำอะไร |
|---|---|
| `POST accept` | self-assign — `manualTestAssign(convId,"botworker", me)` → status=open + event; 409 ถ้ามีคนรับแล้ว |
| `POST transfer` `{admin_id}` | `manualTestAssign` คนใหม่ → status=open + event `transfer` |
| `POST handoff` | `handoffToAdminTest(source="botworker")` — pool round-robin |
| `POST close` `{reason,category,resolution,note}` | `closeTestConversation` + `pushTestCloseHistory` + event |
| `POST reopen` | `reopenTestConversation` + event |
| `POST send` `{text}` | insert `botworker_messages` (role=admin, actor=me, bubble_color จาก profile) — **ไม่แตะ messages_shp / ไม่ยิง Shopee** |
| `GET close-history` | คืน `close_history[]` จาก test doc |

แก้ `GET messages` route — merge `botworker_messages` เข้า unified list (role="admin", actor, สีจาก admins list)

แก้ history builder สำหรับ worker:

- merge `messages_shp` + `shadow_replies` origin worker/workflow + `botworker_messages`
- inbound user turn จาก `messages_shp` ยังเป็น source หลัก
- model/admin reply ต่อ inbound ใช้ลำดับความสำคัญ: `shadow_replies(origin=worker/workflow, mode=standalone)` → `botworker_messages` → Zaapi fallback
- orphan admin/botworker messages ที่ไม่มี inbound pair ให้ append ตามเวลาเป็น model/admin context เฉพาะใน sandbox history
- production `/tickets` history ไม่เปลี่ยน

ทุก route: `requireAuth` เหมือน ticket routes + invalidate botworker cache

### Part F — หน้า /botworker + ปุ่ม "รับเรื่อง" หน้า tickets

ไฟล์: `app/(console)/botworker/page.tsx`, `app/(console)/tickets/page.tsx`, `src/lib/services.ts`

1. **botworker page** — เปลี่ยน handler ทั้งหมดมายิง `/api/botworker/...`:
   - รับเรื่อง → `accept` (assign ตัวเอง — แก้ bug ไม่ assign คนกด)
   - โยนงาน → `transfer` · ส่งต่อ pool → `handoff` · ปิด/เปิด → `close`/`reopen` · close history → route ใหม่
   - **เพิ่ม composer** — ช่องพิมพ์ตอบแชท → `send` → bubble แสดงด้วย `bubble_color` ของแอดมินนั้น (ดึงจาก admins list/`user.bubble_color`)
   - toggle "รับแชท" (is_accepting_chats) — **เก็บไว้** (profile จริงของแอดมิน — user อนุมัติ)
   - แก้ flicker โดยอัตโนมัติ — เขียนและอ่าน test store เดียวกัน + invalidate cache
2. **tickets page** — "รับเรื่อง" → `POST /admin/conversations/:id/assign {admin_id: me}` (endpoint มีอยู่ `manualAssign` atomic) — self-assign จริง; แสดง error เมื่อ conflict; transfer dropdown เดิมสำหรับเลือกคนอื่น
3. **Transfer eligibility** — dropdown โยนงานทั้ง `/tickets` และ `/botworker` ต้อง default แสดงเฉพาะ `active=true`, `role="admin"`, `is_accepting_chats !== false`
   - server route `POST /assignment/reassign` และ botworker `transfer` route ต้อง validate ซ้ำ ห้าม assign ให้ admin ที่พักรับแชท เว้นแต่มี flag override เฉพาะ superadmin/dev ในอนาคต
   - ถ้าไม่มี admin ที่รับแชท ให้ dropdown แสดง empty state "ไม่มีแอดมินที่เปิดรับแชท" ไม่แสดง admin paused

### Part G — Pending assignment backlog distributor

ไฟล์: `handoffService.ts`, `testStatusConversationService.ts`, `statusConversationService.ts`, `api/assignment/backlog/*`, `botWorkerService.ts`, หน้า admin assignment/backlog

1. **สถานะเมื่อจ่ายไม่ได้**
   - `handoffToAdminTest(source="botworker")`: ถ้า `assignedTo=null` ให้เขียน `status="handoff"`, `assigned_to=null`, `pending_assignment=true`, `assignment_reason="no_available_admin"` ลง `test_status_conversation`
   - `handoffToAdmin` ของ tickets จริง: ถ้า `assignedTo=null` ให้เขียน `status="handoff"`, `assigned_to=null`, `pending_assignment=true` ลง `status_conversation` เช่นกัน เพื่อให้งานค้างไม่หาย
2. **Manual distributor สำหรับ superadmin/dev**
   - เพิ่มหน้า/กล่อง “งานค้างรอจ่าย” ให้ role `superadmin`/`dev` เห็นจำนวน pending tickets และเลือก admin ที่จะอยู่ใน pool เช้านี้
   - superadmin เลือก admin ได้หลายคนโดยไม่ผูกกับ `is_accepting_chats`; แต่ default filter แสดงเฉพาะ `active=true`, `role="admin"`, `is_accepting_chats !== false`
   - มี preview ก่อน confirm: จำนวนงาน pending ทั้งหมด, จำนวนที่จะจ่ายรอบนี้, admin แต่ละคนจะได้กี่งาน
   - กด confirm แล้วค่อยเขียน `assigned_to`; ไม่มี auto-write แค่เปิดหน้า
3. **Distribution mode**
   - `round_robin_selected`: วนเฉพาะรายชื่อ admin ที่ superadmin เลือก
   - `least_loaded_selected`: นับงานเปิดปัจจุบันของ admin ที่เลือก แล้วให้คนงานน้อยก่อน; ถ้าเท่ากันค่อย RR
   - `manual_quota`: superadmin กำหนด quota ต่อคน เช่น A=10, B=5 แล้วระบบจ่ายตาม quota
   - มี `limit` ต่อรอบ เช่น จ่าย 20 งานแรกก่อน กันเผลอกวาดทั้งหมด
4. **API**
   - `GET /api/assignment/backlog?source=ticket|botworker` — list/summary pending (`pending_assignment=true`, `assigned_to` ว่าง)
   - `POST /api/assignment/backlog/preview` — รับ `{source, admin_ids, mode, limit, quotas?}` แล้วคืนแผนจ่ายโดยยังไม่เขียน DB
   - `POST /api/assignment/backlog/commit` — รับ payload เดียวกับ preview + idempotency key; re-check pending ก่อนเขียน กัน race
   - ticket source เขียน `status_conversation`; botworker source เขียน `test_status_conversation source="botworker"`
5. **กติกาหลังจ่ายสำเร็จ**
   - ticket จริง: set `assigned_to=<admin>`, `pending_assignment=false`, คง status เป็น `handoff` ตาม convention tickets เดิม
   - botworker: set `assigned_to=<admin>`, `pending_assignment=false`, `status="open"` เพื่อให้ worker skip และให้ admin ตอบใน sandbox
   - log ticket ลง `admin_logs`; log botworker ลง `botworker_events`
6. **Auto drain**
   - ไม่ทำ auto-drain ตอน admin toggle รับแชทใน MVP
   - ถ้าต้องมีภายหลัง ให้เป็น system config แยกและ default `off`; manual distributor เป็น path หลัก

### Part H — Full reset หลังจบทดสอบ

ไฟล์/พื้นที่: `scripts/reset-assignment-state.ts` หรือ maintenance API ใหม่, `status_conversation`, `test_status_conversation`, `chat_accept_sessions`, `assignment_cursors`, `admin_logs`, `shadow_replies`, `test_chat_sessions`, `test_assignment`, `live_assignment/test_assignment`, `workflow_runs`, `botworker_messages`, `botworker_events`

เป้าหมาย: หลังทดสอบจบ ต้อง reset สภาพเหมือน “ไม่เคยทดลอง function assignment/close/chat test เหล่านี้” ทั้ง tickets จริงและระบบทดสอบ โดยไม่ลบข้อความลูกค้าจริงใน `messages_shp` และไม่ลบ master data (`admins`, `shops`, `workflows`, `triggers`, products)

1. **Dry-run ก่อนเสมอ**
   - command/API ต้องมี mode `--dry-run` เป็น default
   - แสดงจำนวน docs ที่จะถูก update/delete/soft-delete แยกตาม collection และ source
   - ห้าม reset จริงถ้ายังไม่ได้ confirm token เฉพาะรอบนั้น
2. **Backup ก่อน reset**
   - export docs ที่จะเปลี่ยนไป `exports/maintenance/reset-assignment-<timestamp>/`
   - อย่างน้อยต้อง backup: `status_conversation`, `test_status_conversation`, `chat_accept_sessions`, `assignment_cursors`, `admin_logs` ที่เกี่ยวกับ assignment/close, `shadow_replies` เฉพาะ test origins, `test_chat_sessions`, `test_assignment`, `workflow_runs` active/test, `botworker_messages`, `botworker_events`
3. **Tickets จริง**
   - `status_conversation`: unset `assigned_to`, `assigned_at`, `assignment_mode_used`, `assignment_reason`, `status`, `closed_at`, `closed_by`, `close_count`, `close_history`, `pending_assignment`
   - `conversations`: unset additive fields ที่เกิดจาก handoff/assignment test เช่น `bot_claim_info`, `bot_handoff_at`, `bot_handoff_reason`, แต่ไม่ลบ customer/order/message fields
   - `assignment_cursors`: reset/remove pool keys ของ ticket/botworker/test sources ตาม confirm scope
   - `chat_accept_sessions`: close/delete sessions test และ set admin `is_accepting_chats` ตาม baseline ที่เลือก
4. **Test surfaces**
   - `test_status_conversation`: delete หรือ unset state ทุก source (`test_chat`, `shadowbot`, `replay_compare`, `test_assignment`, `botworker`)
   - `shadow_replies`: soft-delete test/botworker/shadow origins ตาม scope ไม่ hard delete by default
   - `test_chat_sessions`, `test_chat_ratings`, `test_assignment`, live-assignment docs ที่เก็บใน `test_assignment`: clear/soft-delete ตาม scope
   - `workflow_runs`: cancel/delete runs ที่เกิดจาก test/botworker scope
   - `botworker_messages`, `botworker_events`: delete test sandbox history
5. **Admin state**
   - reset `is_accepting_chats` ของ admin 1-3 หรือทุก admin ตาม baseline ที่ superadmin เลือก
   - clear current open `chat_accept_sessions` เพื่อไม่ให้ session ค้าง 15 วันกลับมากำหนดสถานะผิด
6. **Safety**
   - superadmin-only
   - ต้องพิมพ์ confirm phrase เช่น `RESET_ASSIGNMENT_STATE`
   - ห้ามแตะ `.env`, product DB, `messages_shp` customer messages, `conversations` core identity fields
   - หลัง reset ให้ run verification query: ไม่มี assigned_to/status/closed/pending เหลือใน ticket/test state, ไม่มี open accept session ค้าง, cursor reset แล้ว

## โครงสร้าง collection ใหม่

```
botworker_messages:  { message_id:"bw_...", conversation_id, platform, shop_id,
                       role:"admin", actor:admin_id, actor_name, text,
                       bubble_color?, created_at }
botworker_events:    { event_id, conversation_id, type, actor, metadata, created_at }
                       type: accept|transfer|handoff|close|reopen|bot_reply|bot_handoff|workflow_*
```

## ไฟล์ที่แตะ (สรุป)

| ไฟล์ | เปลี่ยน |
|---|---|
| `botWorkerService.ts` | guard→test store, pickAgent→handoffToAdminTest, log→botworker_events, ส่ง testSource ให้ engine/callBot |
| `handoffService.ts` | `assignedStatus` param |
| `testStatusConversationService.ts` | fields ใหม่ + manualTestAssign + pushTestCloseHistory |
| `workflowEngine.ts` | testSource threading + node side-effects/conditions sandbox |
| `botCallService.ts` | testSource → ticket_state + POST test_source |
| `chatbot/shopeechat/app.py`, `responses.py` | ChatRequest.test_source + _send_handoff payload |
| `bot-handoff/route.ts` | test_source branch |
| `api/botworker/conversations/[id]/*` | routes ใหม่ 7 ตัว + messages merge |
| `botworker/page.tsx` + `services.ts` | composer + handlers ใหม่ |
| `tickets/page.tsx`, `TicketChatPanel.tsx` | รับเรื่อง → assign-self; transfer dropdown กรองเฉพาะ admin ที่รับแชท |
| `api/assignment/backlog/*` + หน้า admin backlog | superadmin/dev preview+commit งานค้างให้ selected admin pool |
| `api/assignment/reassign/route.ts` | validate target admin active+role admin+accepting ก่อน manual transfer |
| `statusConversationService.ts` | pending_assignment fields + backlog assign helper สำหรับ tickets จริง |
| `scripts/reset-assignment-state.ts` หรือ maintenance route ใหม่ | dry-run/backup/confirm reset assignment+close+test state |
| `docs/SRS_SSD.md`, waythrough | อัปเดต |

## ผลกระทบ/เคสอื่น

- **test-chat**: ไม่แตะ — `handoffToAdminTest` default เดิม, engine ไม่ส่ง testSource = path เดิม, bot-handoff simulate เดิม
- **shadowbot**: ไม่แตะ — test store แยก source อยู่แล้ว
- **tickets**: เปลี่ยนแค่ปุ่มรับเรื่อง (self-assign) + read เดิม
- **image_desc** คงเขียน messages_shp (แชร์ตามที่อนุมัติ)
- **workflow_runs**: ไม่มี source field — run ของ worker conv_id จริง ไม่ชน test-chat (session id) — คงเดิม
- **botworker history เห็นข้อความแอดมิน parallel** — `botworker_messages` เข้า sandbox history ตาม requirement; production `/tickets` history ไม่เปลี่ยน
- **botworker history ใช้คำตอบบอทเราเป็นหลัก** — `shadow_replies` origin worker/workflow + mode standalone ชนะ Zaapi fallback เสมอ
- **admin_logs** เดิมยังใช้โดย tickets/test-chat — worker ย้ายไป `botworker_events`
- **pending assignment backlog**: tickets จริงจะเริ่มเห็นงานค้าง `status=handoff, assigned_to=null, pending_assignment=true` แทนค้างเป็น `bot`; ไม่มี auto-drain ตอน admin เปิดรับแชทใน MVP
- **manual transfer eligibility**: paused admins (`is_accepting_chats=false`) จะไม่โผล่ใน dropdown และ API จะ reject ซ้ำ
- **full reset**: เป็น maintenance operation แยก มี dry-run+backup+confirm; ไม่รันอัตโนมัติหลัง deploy

## ลำดับทำงานที่แนะนำ

1. **MVP safety first**: Part A + B + D เฉพาะ worker/callBot handoff isolation เพื่อหยุดการเขียนของจริงจาก botworker
2. **UI sandbox**: Part E + F เฉพาะ routes/handlers สำหรับ accept/transfer/close/reopen/send และ `botworker_messages`
3. **Sandbox history parity**: merge `botworker_messages` + prioritize worker/workflow `shadow_replies` ก่อน Zaapi เพื่อให้ replay ต่อเนื่องตามสิ่งที่ bot/admin ใน sandbox ตอบจริง
4. **Workflow sandbox**: Part C หลังจากพื้นฐาน worker ปลอดภัยแล้ว เพราะ node side-effect หลายตัวต้อง test matrix เยอะ
5. **Backlog distributor**: Part G ทำหลัง handoff semantics ชัดแล้ว; ถ้าต้องการใช้งาน ticket จริงเร็ว ให้แยก PR ย่อยเฉพาะ pending marker + manual distributor ได้
6. **Reset tool**: Part H ทำหลัง feature behavior นิ่งแล้ว เพื่อเคลียร์ผลทดสอบทั้งหมดก่อนเริ่มรอบจริง
7. **Docs/verify gate**: อัปเดต SRS + manual checklist + integration tests ก่อนเปิด botworker ให้ทีมใช้ทดสอบจริง

## Verify plan

1. `npx tsc --noEmit` + `git diff --check`
2. Integration test (tsonsx + Mongo จริง, conv สังเคราะห์): seed user msg → processMessage จำลอง guard/handoff paths → assert เขียน test store เท่านั้น (`status_conversation`/`conversations`/`assignment_cursors:*ticket` ไม่ถูกแตะ)
3. Reopen loop: seed closed test doc → message ใหม่ → status กลับ bot + bot ตอบ
4. Accept flow: API accept → test doc assigned_to=me,status=open → worker skip
5. Workflow assign_ticket/close_ticket ใน worker context → เขียน test doc
6. Manual UI checklist หน้า /botworker: รับเรื่อง/ตอบแชท/โยน/ปิด/reopen/สี bubble
7. Tickets รับเรื่อง → assign ตัวเองใน status_conversation จริง
8. History priority: ถ้ามี Zaapi + `shadow_replies` worker/workflow ของ inbound เดียวกัน → history ใช้คำตอบจาก `shadow_replies`
9. Admin sandbox history: admin ตอบใน `botworker_messages` แล้วข้อความถัดไปต้องเห็น admin reply ใน history
10. Pool ว่าง: handoff → `pending_assignment=true`, ไม่มี write ผิด store
11. Backlog preview: เลือก admin A/B + limit → คืนจำนวนงานต่อคนโดยยังไม่เขียน DB
12. Backlog commit: re-check pending + assign ตาม selected pool/mode; ticket ไม่แตะ botworker store และ botworker ไม่แตะ `status_conversation`
13. Transfer dropdown/API: paused admin ไม่แสดงและ assign ผ่าน API ไม่ได้
14. Reset dry-run: report counts ครบทุก collection โดยไม่เขียน DB
15. Reset confirm: backup ถูกสร้างก่อน reset; หลัง reset verification query ไม่มี assignment/close/test state เหลือใน scope

## คำถาม/ตัดสินใจที่ต้องยืนยัน

- [ ] status หลัง assign สำเร็จ = `open` (ตาม requirement) — handoff ที่หาคนไม่ได้ = `handoff` (รอใน pool)
- [ ] `botworker_events` collection ใหม่ แทน admin_logs ที่ติด source — ตรง "เก็บแยก" ชัดเจน
- [ ] ticket จริงหลัง backlog commit สำเร็จควรใช้ status `handoff` ตาม convention เดิม หรือเปลี่ยนเป็น `open` เหมือน botworker?
- [ ] backlog distributor ควรอยู่หน้า `/team`, `/tickets`, หรือหน้าใหม่ `/assignment/backlog`?
- [ ] default mode ตอน superadmin กดจ่ายควรเป็น `least_loaded_selected` หรือ `round_robin_selected`?
- [ ] reset baseline ของ `is_accepting_chats` หลังจบทดสอบควรตั้ง admin ทุกคนเป็นพัก หรือให้ superadmin เลือกรายคน?
- [ ] reset test docs ควร soft-delete ทั้งหมด หรือ hard-delete เฉพาะ sandbox collections ใหม่ (`botworker_messages`, `botworker_events`)?
