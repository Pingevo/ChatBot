# Planner — Workflow Engine (แบบ Zaapi Flow Builder)

## ทำไมต้องมี Workflow

ระบบปัจจุบันมี **trigger** (keyword → action) แต่มันจำกัด:
- แค่ keyword substring ตัวเดียว
- action ได้แค่ 2 แบบ (`bot_answer` / `handoff_admin`)
- ไม่มีหลายขั้นตอน ไม่มี "รอลูกค้าตอบแล้วทำต่อ"
- ไม่มีเงื่อนไขซับซ้อน (เวลา / สถานะ / ลูกค้าใหม่-เก่า)

**Workflow** = เติม "ขั้นตอน + การกระทำ" ที่ trigger ทำเองไม่ได้ เหมือน Zaapi Flow Builder

> เปรียบเทียบ: trigger = Basic Automation (ง่าย 1 ต่อ 1), workflow = Flow Builder (หลายขั้น แตกกิ่ง รอ reply)

---

## หลักการสำคัญ

1. **trigger เดิมไม่ทิ้ง** — ใช้ต่อเป็น "basic automation" คู่ขนานกับ workflow
2. **บอท (intent→rag→llm2→search→rag→llm2) ไม่แตะ** — คงเดิม ไม่ดึง intent ออกมา
3. **workflow กับ trigger ทำงานแยกกัน** — เลือกลำดับได้จาก config
4. **flow มี state** — ถ้า flow รอ reply ข้อความใหม่เข้า flow ก่อน ไม่ไป trigger/bot

---

## ภาพรวม Pipeline (หลังเพิ่ม workflow)

```
ลูกค้าส่งข้อความ
       │
       ▼
┌──────────────────────────────────────────────────┐
│ ① Active Flow Resume (เสมอ ไม่สน priority)       │
│    เช็ค: แชทนี้มี flow ที่กำลังรอ reply อยู่ไหม?    │
│    ├─ มี → ส่งข้อความเข้า flow เดิม (resume) → จบ  │
│    └─ ไม่มี → ไป ②                              │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│ ② Priority (อ่านจาก config: workflow_priority)  │
│                                                  │
│  workflow_first (default):                       │
│    workflow match → ฮิต+action → จบ              │
│                  → ไม่ฮิต → trigger match         │
│                  → ไม่ฮิต → ไป ③ (บอท)           │
│                                                  │
│  trigger_first:                                  │
│    trigger match → ฮิต → จบ                      │
│                 → ไม่ฮิต → workflow match         │
│                 → ไม่ฮิต → ไป ③ (บอท)           │
│                                                  │
│  both (เสี่ยงตอบซ้ำ ไม่แนะนำ):                    │
│    รัน trigger + workflow ทั้งคู่                 │
└──────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────┐
│ ③ บอท (เหมือนเดิม ไม่แตะ)                        │
│    callBot → intent→rag→llm2→search→rag→llm2     │
│    ├─ ตอบได้ → shadow_reply                      │
│    └─ ตอบไม่ได้ → handoff → admin                │
└──────────────────────────────────────────────────┘
```

---

## ตัวอย่าง Flow จริง (วาดใน canvas)

```
ลูกค้า: "สเปคหัวชาร์จเป็นยังไง"

  ┌─────────────┐
  │  trigger    │  keyword: สเปค, ราคา, หัวชาร์จ
  │  message_   │  shop_ids: ["ร้านA"]
  │  received   │  platforms: ["shopee"]
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  action     │  เรียกบอท (callBot) ตอบสเปค
  │  let_ai_    │  → คำตอบเก็บใน context.bot_answer
  │  respond    │  → ส่ง shadow_reply ให้ลูกค้า
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  action     │  fixed message ทันที (ไม่รอ)
  │  send_      │  "สนใจสั่งซื้อไหมคะ?"
  │  message    │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  wait       │  ⏸ หยุดที่นี่ → run status = waiting_for_reply
  │  for_reply  │  รอลูกค้าพิมพ์ก่อน
  └──────┬──────┘
         │ (ลูกค้าพิมพ์ "สั่งซื้อ")
         ▼
  ┌─────────────┐
  │  condition  │  ข้อความลูกค้ามีคำว่า สั่งซื้อ/ซื้อ/สนใจ?
  │  message_   │     ├─ true  → [send: ลิงก์สั่งซื้อ] → [assign: ทีมขาย] → จบ
  │  content    │     └─ false → false_branch_policy ตัดสิน
  └─────────────┘
```

### false_branch_policy (ตอน condition ไม่ผ่าน)

| policy | พฤติกรรม | เหมาะเวลาไหน |
|--------|----------|--------------|
| `exit_to_bot` (default) | cancel flow → ข้อความนี้ไป trigger/bot | ลูกค้าเปลี่ยนเรื่อง → ปล่อยให้บอทตอบ |
| `exit_drop` | cancel flow → ทิ้งข้อความ | บังคับให้ลูกค้าพิมพ์ใหม่ |
| `stay_retry` | ส่ง fixed msg "รบกวนพิมพ์เฉพาะ..." → กลับ wait_for_reply | บังคับให้อยู่ใน flow |

---

## สถานการณ์สำคัญ: บอทตอบนอก flow แล้วฮิต node เดิม

```
flow: [trigger] → [C: bot ตอบ] → [wait] → [F: condition] → [node หลัง F]

ลูกค้า: (ไม่ฮิต node หลัง F) → false → exit_to_bot → cancel flow → บอทตอบ
ลูกค้า: (ฮิต node หลัง F อีกครั้ง) → ???
```

**กฎ: พอออก flow ไปบอท = flow จบ (cancel run) ถ้าฮิตอีกครั้ง = เริ่ม flow ใหม่ ไม่ resume ของเก่า**

เหตุผล:
- บริบทปน (บอทตอบไปแล้ว history มีคำตอบบอท)
- ลูกค้างง (ข้ามเรื่องไปกลับมา)
- debug ยากถ้า resume ของเก่า

---

## สิ่งที่ต้องเพิ่ม (น้อยที่สุด)

| อะไร | ทำไม | ใหม่ไหม |
|------|------|---------|
| `workflows` collection | เก็บ flow (nodes + edges) | ใหม่ |
| `workflow_runs` collection | เก็บ state ของ flow ที่กำลังรัน/รอ reply | ใหม่ — **ตัวสำคัญที่ทำให้เป็น flow จริง** |
| `workflowService.ts` | CRUD workflow | ใหม่ |
| `workflowEngine.ts` | รัน flow + resume + eval condition + ทำ action | ใหม่ |
| แก้ `processMessage` 1 จุด | เสียบ ①②③ | แก้ของเดิม |
| `workflow_priority` config | เลือกลำดับ workflow/trigger | เพิ่มใน system_configs |
| หน้า `/workflows` + `@xyflow/react` | UI ลากโนด | ใหม่ |

---

## ของเดิม — ไปต่อได้ไหม

| ของเดิม | คำตอบ |
|---------|-------|
| `triggers` + `triggerService` | ✅ ใช้ต่อ เป็นขั้น ② (basic automation) |
| `processMessage` | ✅ ใช้ต่อ แค่เพิ่ม ①② ด้านบน |
| `callBot`, `shadowReplyService`, `assignmentService`, `handoffService`, `conversationService`, `adminLogService` | ✅ ใช้เป็น action ของ flow เลย ไม่ต้องเขียนใหม่ |
| `bot-worker.ts`, `pollNewMessages` | ✅ ไม่ต้องแตะ |
| บอท pipeline (intent→rag→llm2→search→rag→llm2) | ✅ ไม่แตะ คงเดิม |
| หน้า `/triggers` | ✅ ใช้ต่อ เป็น "basic automation" คู่กับ flow builder |

**สรุป: ของเดิมใช้ต่อได้หมด ไม่ทิ้ง บอทไม่แตะ**

---

## Schema

### WorkflowDoc (collection: `workflows`)

```typescript
interface WorkflowDoc {
  workflow_id: string;
  name: string;
  enabled: boolean;

  // กรองว่า flow นี้ทำงานกับ channel ไหน ([] = ทั้งหมด)
  shop_ids: string[];
  platforms: Platform[];

  // trigger frequency (เหมือน Zaapi)
  trigger_frequency: "once_per_customer" | "once_per_conversation" | "every_time";

  // นโยบายตอน condition false
  false_branch_policy: "exit_to_bot" | "exit_drop" | "stay_retry";

  // node graph (สำหรับ visual builder)
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];   // source_node_id → target_node_id (+ branch "true"/"false")

  version: number;
  status: "draft" | "published";
  created_by: string;
  created_at: Date;
  updated_at: Date;
  updated_by?: string;
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string;
}

interface WorkflowNode {
  node_id: string;
  type: "trigger" | "condition" | "action" | "wait";
  subtype: string;         // ดูตารางด้านล่าง
  config: Record<string, unknown>;
  position: { x: number; y: number }; // สำหรับ canvas
}

interface WorkflowEdge {
  edge_id: string;
  source_node_id: string;
  target_node_id: string;
  branch?: "true" | "false"; // สำหรับ condition node
}
```

### WorkflowRunDoc (collection: `workflow_runs`)

```typescript
interface WorkflowRunDoc {
  run_id: string;
  workflow_id: string;
  workflow_version: number;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  customer_id?: string;

  status: "running" | "waiting_for_reply" | "completed" | "cancelled" | "errored";
  current_node_id: string;        // node ที่กำลังอยู่ / รออยู่
  waiting_for?: "next_message";

  // ตัวแปรสะสมระหว่าง node (เช่น bot_answer, customer_reply, product_id)
  context: Record<string, unknown>;

  // ผลลัพธ์สุดท้าย
  outcome?: "actioned" | "no_match" | "condition_false" | "error";

  started_at: Date;
  updated_at: Date;
  completed_at?: Date;
  error?: string;
}
```

---

## Node Types (ที่รองรับ)

### Trigger nodes

| subtype | config | ทำอะไร |
|---------|--------|--------|
| `message_received` | `keywords: string[]` | จุดเริ่ม flow — เช็ค keyword ในข้อความ |

### Condition nodes

| subtype | config | ทำอะไร | ใช้อะไรเช็ค |
|---------|--------|--------|------------|
| `message_content` | `mode: "contains"\|"equals"\|"not_contains"`, `text: string` | เช็คข้อความลูกค้า | ข้อความล่าสุด |
| `conversation_status` | `status: "open"\|"closed"` | เช็คสถานะแชท | `conversations.status` |
| `business_hours` | `timezone: string` | เช็คเวลาทำการ | shop settings |
| `new_vs_returning` | — | ลูกค้าใหม่ vs เก่า | `customers.last_active_at` |
| `assignee` | `admin_id?: string` | เช็คว่าแชทถูกจ่ายให้ใคร | `conversations.assigned_to` |

### Action nodes

| subtype | config | ทำอะไร | เรียก service เดิม |
|---------|--------|--------|-------------------|
| `send_message` | `text: string` | ส่ง fixed message | `shadowReplyService` |
| `let_ai_respond` | `prompt?: string` | เรียกบอทตอบ | `callBot` |
| `assign_ticket` | `admin_id?: string`, `team?: string` | จ่ายงาน | `assignmentService` + `handoffService` |
| `add_label` | `label: string` | ติด label | (ใหม่) `labelService` |
| `close_ticket` | — | ปิดแชท | `conversationService` |
| `add_note` | `text: string` | เพิ่ม note | `adminLogService` |
| `send_http` | `url, method, body` | webhook out | fetch |
| `jump_to` | `target_node_id: string`, `max_jumps: number` | วนกลับ | engine internals |

### Wait nodes

| subtype | config | ทำอะไร |
|---------|--------|--------|
| `wait_for_reply` | `timeout_ms?: number` | หยุด flow รอลูกค้าพิมพ์ → run status = `waiting_for_reply` |

---

## Engine ทำงานยังไง

```
runFlow(workflow, message, context):
  current_node = trigger node (หาจาก edges ที่ไม่มี source)
  loop:
    node = workflow.nodes[current_node]

    if node.type == "trigger":
      → ไป node ถัดไป (ตาม edge)

    if node.type == "action":
      → ทำ action (เรียก service เดิม)
      → เก็บผลลัพธ์ลง context
      → ไป node ถัดไป

    if node.type == "condition":
      → eval condition (เช็ค context / ข้อความ / DB)
      → ไป node ถัดไปตาม branch "true" หรือ "false"

    if node.type == "wait":
      → เก็บ run status = "waiting_for_reply"
      → เก็บ current_node_id
      → หยุด (return) — รอ message ถัดไป resume

    if ไม่มี node ถัดไป:
      → run status = "completed"
      → จบ
```

### Resume (ตอนลูกค้าพิมพ์ต่อใน flow ที่รอ reply)

```
resumeFlow(run, newMessage):
  current_node = run.current_node_id (wait node)
  → ป้อน newMessage เข้า context.customer_reply
  → ไป node ถัดไปจาก wait (ปกติคือ condition)
  → ทำงานต่อเหมือน runFlow ปกติ
```

---

## จุดเชื่อมใน processMessage

ไฟล์: `ChatAdminWeb/src/backend/service/botWorkerService.ts`
จุด: หลังบรรทัดที่เรียก `triggerService.matchTrigger` (~บรรทัด 258)

```
// ปัจจุบัน:
  const trigger = await triggerService.matchTrigger(msg.text, {...});

// หลังเพิ่ม:
  // ① active flow resume
  const activeRun = await workflowEngine.getActiveRun(msg.conversation_id);
  if (activeRun) {
    return workflowEngine.resumeFlow(activeRun, msg);
  }

  // ② priority
  const priority = config.workflow_priority; // "workflow_first" | "trigger_first" | "both"
  if (priority === "workflow_first") {
    const wfResult = await workflowEngine.matchAndRun(msg);
    if (wfResult.outcome === "actioned") return wfResult;
    // ตกไป trigger เดิม ↓
  } else if (priority === "trigger_first") {
    const trigger = await triggerService.matchTrigger(msg.text, {...});
    if (trigger) { /* ทำ trigger เหมือนเดิม */ return ...; }
    const wfResult = await workflowEngine.matchAndRun(msg);
    if (wfResult.outcome === "actioned") return wfResult;
  }

  // ③ บอท (เหมือนเดิม ไม่แตะ)
  ...
```

---

## Config ที่เพิ่มใน system_configs

| Field | Default | คำอธิบาย |
|-------|---------|----------|
| `workflow_priority` | `"workflow_first"` | ลำดับ: `workflow_first` / `trigger_first` / `both` |
| `workflow_enabled` | `false` | สวิตช์เปิด/ปิด workflow engine ทั้งหมด |
| `workflow_run_timeout_ms` | `1800000` (30 นาที) | flow ที่รอ reply เกินเวลานี้ → cancel อัตโนมัติ |

UI: เพิ่มในหน้า `/config` ที่มีอยู่แล้ว (Card "Workflow Engine")

---

## ลำดับการ Implement

### Phase 1 — Data model + Engine (ไม่มี UI)

1. `mongoClient.ts` — เพิ่ม `workflows` + `workflow_runs` collection + indexes
2. `config.ts` — เพิ่ม collection names
3. `systemConfigService.ts` — เพิ่ม `workflow_priority`, `workflow_enabled`, `workflow_run_timeout_ms`
4. `workflowService.ts` — CRUD (create/list/get/update/delete workflow)
5. `workflowEngine.ts` — `matchAndRun`, `runFlow`, `resumeFlow`, `getActiveRun`
6. ทดสอบด้วย insert workflow doc ทาง DB ตรงๆ

### Phase 2 — เสียบเข้า pipeline

7. `botWorkerService.ts` — แก้ `processMessage` เพิ่ม ①②③
8. ทดสอบ end-to-end (สร้าง flow ง่ายๆ → ส่งข้อความ → ดูผล)

### Phase 3 — UI Visual Builder

9. `npm add @xyflow/react`
10. `src/app/(console)/workflows/page.tsx` — list workflows
11. `src/app/(console)/workflows/[id]/page.tsx` — canvas editor
12. Node palette (trigger / condition / action / wait)
13. Save → `workflows` doc (nodes/edges/positions)

### Phase 4 — เพิ่ม action/condition ทีละตัว

14. `send_message` + `let_ai_respond` (ใช้ service เดิม)
15. `assign_ticket` (ใช้ assignmentService)
16. `condition: message_content` + `conversation_status`
17. `wait_for_reply` + resume
18. `add_label` (ต้องสร้าง `labelService` ใหม่)
19. `close_ticket`, `add_note`, `send_http`, `jump_to`

---

## ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | การเปลี่ยน |
|------|-----------|
| `src/backend/db/mongoClient.ts` | เพิ่ม collection + indexes |
| `src/backend/lib/config.ts` | เพิ่ม collection names |
| `src/backend/service/systemConfigService.ts` | เพิ่ม 3 config fields |
| `src/backend/service/workflowService.ts` | **ใหม่** — CRUD |
| `src/backend/service/workflowEngine.ts` | **ใหม่** — engine |
| `src/backend/service/botWorkerService.ts` | แก้ `processMessage` เพิ่ม ①②③ |
| `src/app/(console)/config/page.tsx` | เพิ่ม Card "Workflow Engine" |
| `src/app/(console)/workflows/page.tsx` | **ใหม่** — list + canvas |
| `src/app/api/workflows/route.ts` | **ใหม่** — REST API |
| `package.json` | เพิ่ม `@xyflow/react` |

---

## ข้อควรระวัง

1. **Buffer อยู่ใน memory** — ถ้า bot-worker restart flow ที่รอ reply จะค้าง
   - แต่ `workflow_runs` เก็บใน DB → poll รอบถัดไปเจอ run ที่ `waiting_for_reply` → resume ได้
   - ต้องมี cleanup: run ที่เกิน `workflow_run_timeout_ms` → cancel

2. **Conflict กับ trigger** — ถ้าตั้ง `both` อาจตอบซ้ำ
   - default `workflow_first` ปลอดภัยสุด

3. **Admin กำลังตอบ** — `processMessage` มี guard `assigned_to` อยู่แล้ว
   - flow ต้องเคารพ guard นี้ด้วย ถ้าแอดมินรับแชท flow ที่รอ reply ต้อง cancel อัตโนมัติ

4. **หลาย flow ฮิตพร้อมกัน** — ต้องตั้งกฎว่าเอาอันไหน
   - แนะนำ: เรียงตาม field `priority` ถ้าไม่มี → ตาม `created_at`

5. **Test Chat** — Test Chat ไม่ผ่าน bot-worker → ไม่ผ่าน workflow
   - ถ้าอยากให้ Test Chat ผ่าน workflow → เพิ่มในภายหลัง

6. **Shadow Inbox / Test Assignment** — ใช้ `processMessage` ตรงๆ
   - ถ้าอยากให้ replay ผ่าน workflow → ทำภายหลัง

---

## ค่าแนะนำ

| ค่า | แนะนำ | หมายเหตุ |
|------|------|----------|
| `workflow_priority` | `"workflow_first"` | workflow เป็นหลัก trigger เป็นตัวจับหลัง |
| `workflow_enabled` | `false` (default) | ต้องเปิดเองในหน้า config |
| `workflow_run_timeout_ms` | `1800000` (30 นาที) | flow รอ reply เกิน 30 นาที → cancel |
| `false_branch_policy` | `"exit_to_bot"` | ลูกค้าเปลี่ยนเรื่อง → ปล่อยให้บอทตอบ |
