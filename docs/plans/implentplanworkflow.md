# Workflow Implement Zaapi Plan

## เป้าหมาย

อัปเกรด Workflow Builder (`ChatBotProductMS/ChatAdminWeb`) ที่มีอยู่แล้ว ให้รองรับ pattern การทำงานแบบเดียวกับ flow builder ต้นแบบ (multi-branch condition, wait-for-reply แบบมี retry/timeout, tag picker จริง, variable interpolation) โดย **ไม่ทำลายของเดิม** — เพิ่มแบบ additive/backward-compatible ตามแนวทางที่ใช้อยู่ (soft delete, allowlist PATCH, validateWorkflowGraph ฯลฯ)

---

## Gap Analysis

| ส่วน | ตอนนี้มี | เป้าหมาย | ระดับงาน |
|---|---|---|---|
| Condition node | true/false 2 ทาง | N ทางตาม keyword group + fallback | **ใหญ่สุด** — เปลี่ยน schema + engine + UI handle |
| Wait for reply | รอ reply เดียว + global timeout | ประเภทคำตอบ, retry N ครั้ง, timeout, 3 branch ออก (success / retry exceeded / no reply) | ปานกลาง |
| Add label | text field | tag picker แบบ chip (ดึงจาก label list จริง) | เล็ก |
| Send message | ข้อความ static | แทรก `{{customerName}}` แบบมี autocomplete + preview | เล็ก |
| Node UI | การ์ดพื้นฐาน | การ์ดสไตล์ header สี + preview ค่าใต้ field + label ต่อ handle | UI polish |

---

## Phase 1 — Multi-branch Condition Node (สำคัญที่สุด)

### Schema ใหม่ (`condition` node, subtype `message_content`)

```ts
type ConditionBranch = {
  branch_id: string;         // "b1","b2"... ใช้เป็น edge.branch ด้วย
  match_type: "contains_any" | "contains_all" | "equals";
  keywords: string[];
  label?: string;            // แสดงบน UI เช่น "สั่งซื้อสินค้า"
};

type MessageContentConfig = {
  source: "customer_reply" | "initial_message";
  branches: ConditionBranch[];
  fallback_branch_id: string; // "ถ้าไม่ตรงเงื่อนไข ให้ใช้ขั้นตอนนี้"
};
```

`WorkflowEdge.branch` เปลี่ยนจาก `"true"|"false"` → เป็น `branch_id` string ใดๆ (backward compatible — edge เก่าของ condition node แบบ binary เดิมยังใช้ได้ เพราะ `evalCondition` รองรับทั้ง 2 แบบ)

### Engine change (`workflowEngine.ts`)

```ts
function evalConditionNode(node: WorkflowNode, ctx: RunContext): string {
  if (node.subtype === "message_content") {
    const text = node.config.source === "customer_reply"
      ? ctx.customer_reply ?? "" : ctx.initial_message ?? "";
    for (const branch of node.config.branches) {
      if (matchBranch(text, branch)) return branch.branch_id;
    }
    return node.config.fallback_branch_id;
  }
  // legacy binary condition types (conversation_status, business_hours, ...)
  // ยังคืน "true"/"false" เหมือนเดิม
  return evalLegacyCondition(node, ctx);
}

function matchBranch(text: string, b: ConditionBranch): boolean {
  const t = text.toLowerCase();
  const kws = b.keywords.map(k => k.toLowerCase());
  if (b.match_type === "contains_any") return kws.some(k => t.includes(k));
  if (b.match_type === "contains_all") return kws.every(k => t.includes(k));
  return t === kws[0];
}
```

ใน `walkGraph`: หา next edge ด้วย `edge.source_node_id === node.node_id && edge.branch === matchedBranchId` — โค้ดเดิมที่ทำ true/false ใช้ path เดียวกันได้เลยเพราะ matchedBranchId เป็น string เหมือนกัน

### UI — dynamic handles (xyflow)

Node component ใน `nodes.tsx` ต้อง render `<Handle>` ตามจำนวน `branches.length + 1` (fallback) แล้วเรียก `useUpdateNodeInternals()` ทุกครั้งที่ user เพิ่ม/ลบ branch ใน panel

### validateWorkflowGraph เพิ่มกฎ

- `branch_id` ต้องไม่ซ้ำกันภายใน node เดียวกัน
- `fallback_branch_id` ต้องไม่ตรงกับ `branch_id` ใดๆ
- edge ที่ออกจาก condition node ต้องมี `branch` ตรงกับ branch_id หรือ fallback_branch_id ที่มีจริง (กัน ghost branch)

### Prompt สำหรับ coding agent (Phase 1)

```
บริบท: โปรเจกต์ ChatBotProductMS/ChatAdminWeb มี workflow builder อยู่แล้ว
(workflowService.ts, workflowEngine.ts, WorkflowEditor.tsx, nodes.tsx, NodeConfigPanel)
งานตอนนี้: เปลี่ยน condition node subtype "message_content" จาก true/false
เป็น multi-branch (N ทาง + fallback) ตาม spec นี้:

1. schema: MessageContentConfig { source, branches: ConditionBranch[],
   fallback_branch_id } — ConditionBranch { branch_id, match_type, keywords, label }
2. workflowEngine.ts: เพิ่ม evalConditionNode ที่ handle ทั้ง message_content
   (multi-branch) และ legacy binary condition (conversation_status, business_hours,
   assignee, new_vs_returning) โดยไม่ทำให้ของเดิมพัง
3. walkGraph: หา next node จาก edge.branch === matchedBranchId (generic,
   ไม่ hardcode true/false)
4. validateWorkflowGraph: เพิ่ม validation ตามที่ระบุ (branch_id ไม่ซ้ำ,
   fallback ไม่ชนกับ branch, edge ต้องอ้าง branch ที่มีจริง)
5. nodes.tsx: ConditionNode component ต้อง render Handle แบบ dynamic ตาม
   config.branches.length + 1 (fallback handle), เรียก
   useUpdateNodeInternals() ทุกครั้งที่ branches เปลี่ยน
6. NodeConfigPanel: UI ให้ user กด "+ เพิ่มเงื่อนไข" เพิ่ม branch ใหม่,
   ลบ branch, แก้ keywords ต่อ branch (comma-separated input), เลือก match_type
7. เขียน unit test สำหรับ evalConditionNode ครอบคลุม: contains_any match,
   contains_all match, ไม่ตรงเลย → fallback, legacy binary ยังทำงานถูก

ห้ามแก้ trigger matching logic เดิม (triggerService.ts) และห้ามเปลี่ยน
schema ของ node type อื่นนอกจาก condition/message_content
ทำทีละไฟล์ รันทดสอบ (tsc --noEmit, unit test) หลังแก้แต่ละไฟล์
```

---

## Phase 2 — Wait for Reply (retry + timeout + 3-branch)

### Schema

```ts
type WaitForReplyConfig = {
  answer_type: "any" | "number" | "custom_keywords";
  max_retries: number;      // "ถามซ้ำ 3 ครั้ง"
  retry_message?: string;   // ข้อความถามซ้ำ (ถ้าไม่ระบุ ใช้ prompt เดิม)
  timeout_ms: number;       // "1 ชั่วโมง" = 3600000
};
```

Outgoing edges 3 อัน: `branch: "success" | "retry_exceeded" | "no_reply"`

### Run state เพิ่ม

```ts
{
  ...run,
  wait_retry_count: 0,
  wait_started_at: Date,
}
```

### Engine logic

- `resumeFlow`: ถ้าคำตอบผ่าน `answer_type` validation → branch `success`, ไปต่อ
- ถ้าไม่ผ่านและ `wait_retry_count < max_retries` → +1 retry, ส่ง `retry_message`, คง `status: waiting_for_reply`
- ถ้า `wait_retry_count >= max_retries` → branch `retry_exceeded`
- ต้องมี **cron/interval job** (เช่นทุก 1 นาที) เช็ค run ที่ `status: waiting_for_reply` และ `now - wait_started_at > timeout_ms` → branch `no_reply` (แยกจาก `workflow_run_timeout_ms` เดิมที่เป็น global fallback — อันนี้คือ per-node override)

### Prompt

```
งาน: อัปเกรด wait_for_reply node ใน workflowEngine.ts ให้รองรับ:
1. config: answer_type, max_retries, retry_message, timeout_ms
2. run document เพิ่มฟิลด์ wait_retry_count, wait_started_at
3. resumeFlow(): validate answer_type ของ customer_reply →
   ถ้าผ่าน = branch "success" ไปต่อ
   ถ้าไม่ผ่านและยังไม่ครบ retry = ส่ง retry_message ซ้ำ, เพิ่ม wait_retry_count,
   สถานะคง waiting_for_reply
   ถ้าครบ retry แล้วไม่ผ่าน = branch "retry_exceeded"
4. เพิ่ม background checker (interval หรือ cron endpoint ที่มีอยู่แล้วถ้ามี)
   เช็ค run ที่รอเกิน timeout_ms → branch "no_reply", audit log
   "workflow.run_timeout"
5. WorkflowEditor: WaitForReply node ต้องมี 3 output handle คงที่
   (success/retry_exceeded/no_reply) — ไม่ dynamic เหมือน condition node
6. NodeConfigPanel: form field ประเภทคำตอบ (select), ถามซ้ำกี่ครั้ง (number),
   ระยะเวลารอ (select เป็นนาที/ชั่วโมง แปลงเป็น ms ตอน save)

เช็คว่า global workflow_run_timeout_ms เดิมยังทำงานเป็น safety net รอง
(เผื่อ per-node timeout ไม่ทำงาน) ไม่ใช่แทนที่กัน
```

---

## Phase 3 — Add Label: Tag Picker จริง

```
งาน: เปลี่ยน add_label node config จาก { text } เป็น { label_ids: string[] }
1. ใช้ API label list ที่มีอยู่แล้วในระบบ CRM/ticket (หาไฟล์ labelService
   หรือคล้ายกันในโปรเจกต์ก่อน ถ้าไม่มีให้สร้าง GET /api/labels)
2. NodeConfigPanel: component TagPicker — multi-select แสดงเป็น chip
   มีสี/ไอคอนตาม label จริง (เหมือนภาพ: "แจ้งปัญหา", "Product Returning")
3. performAction สำหรับ add_label: เรียก addLabelsToConversation(conversationId,
   label_ids) ของจริง ไม่ใช่ mock
4. node card แสดง chip ของ tag ที่เลือกไว้ใต้ header (ตามภาพ)
```

---

## Phase 4 — Variable Interpolation ใน Send Message

```
งาน:
1. สร้าง resolveTemplate(text: string, ctx: RunContext & shopInfo): string
   รองรับ {{customerName}}, {{integrationName}}, {{botAnswer}} เป็นต้น
   (ดึง mapping จริงจาก conversation/customer/shop document)
2. performAction ของ send_message ต้องเรียก resolveTemplate ก่อนส่งเข้า
   shadowReplyService
3. UI: textarea ใน NodeConfigPanel เพิ่ม autocomplete แบบ "{{" trigger
   dropdown ตัวแปรที่ใช้ได้ (ใช้ library เบาๆ เช่น simple mentions หรือ
   contentEditable custom — ไม่ต้องใหญ่โต)
4. แสดง preview ข้อความที่ resolve แล้วใต้ field (helper text)
```

---

## Phase 5 — UI Polish ให้ตรงภาพ

```
งาน: ปรับ node card style ใน nodes.tsx ให้ตรง pattern ภาพตัวอย่าง:
- header มี icon + สี ต่างกันตาม node type (trigger=เขียว, condition=เหลือง,
  action=น้ำเงิน, wait=ส้ม ตาม NODE_TYPE_META ที่มีอยู่)
- แต่ละ field แสดง label ภาษาไทยด้านบน + ค่า/preview ด้านล่างแบบ read-only
  บนการ์ด (ไม่ต้องเปิด edit panel ถึงจะเห็นค่า) เหมือนใน screenshot ที่เห็น
  keyword, ข้อความ, ทันทีบนตัว node
- ท้ายการ์ดแสดง label ของแต่ละ output handle (เช่น "ถ้าไม่ตรงเงื่อนไข ให้ใช้
  ขั้นตอนนี้", "ขั้นตอนถัดไป") ต่อจาก handle แต่ละอัน

ไม่ต้องแก้ logic ใดๆ ใน phase นี้ เป็น pure UI/CSS
```

---

## Phase 6 — Testing / Rollout

```
งาน:
1. unit test evalConditionNode (multi-branch), resumeFlow (retry/timeout),
   validateWorkflowGraph (branch validation ใหม่)
2. e2e ผ่าน Test Chat: สร้าง flow ตัวอย่างเลียนแบบภาพ (trigger → send message
   with menu → wait for reply → condition แยก 3 กิ่ง → add label → send message)
   แล้วรันผ่าน /api/test-chat/workflow-step ดูว่า flow เดินถูก branch
3. รัน tsc --noEmit + npm run build ตรวจว่าไม่พังของเดิม
4. เปิด workflow_enabled=true เฉพาะ shop ทดสอบก่อน (ใช้ shop_ids filter ที่มีอยู่แล้ว)
```

---

## ลำดับแนะนำ

ทำ **Phase 1 → 2** ก่อน (สองอันนี้คือ core logic ที่ทำให้ flow เหมือนภาพได้จริง) แล้วค่อย 3-4-5 ซึ่งเป็น polish ที่ทำแยกได้อิสระ ไม่ block กัน