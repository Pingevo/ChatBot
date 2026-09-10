# Planner — Message Buffering (Debounce) สำหรับ Bot Worker

## ปัญหาปัจจุบัน

ระบบปัจจุบันใช้ **FIRE-AND-FORGET** — ทุกข้อความถูกประมวลผลแยกอิสระทันที:

```
ลูกค้าส่ง 3 ข้อความรัวๆ: "สนใจหัวชาร์จ", "มี 220W ไหม", "ส่งรูปได้ไหม"
         ↓
bot-worker poll → เจอ 3 messages
         ↓
ยิง 3 reqs ไปบอทพร้อมกัน (fire-and-forget)
         ↓
บอทตอบ 3 คำตอบแยกกัน → 3 shadow_replies
```

**ปัญหา:**
- ตอบเกินจำเป็น (3 คำตอบ ในเมื่อรวมเป็น 1 คำถามก็พอ)
- บอทอาจไม่เข้าใจบริบทเพราะ history ยังไม่ทันถูกบันทึก
- เปลือง token/cost
- ไม่เหมือนแอดมินจริง (คนรอให้ลูกค้าพิมพ์จบก่อนตอบ)

Shopee ล็อคแชทไม่ได้ → ลูกค้าพิมพ์เป็นท่อนสั้นๆ รัวๆ เป็นเรื่องปกติ

---

## แนวทาง: Message Buffering (Debounce)

รอให้ลูกค้าหยุดพิมพ์ X วินาที แล้วรวมทุกข้อความเป็น 1 query ส่งให้บอท 1 ครั้ง

```
ลูกค้าส่ง 3 ข้อความรัวๆ
         ↓
message 1 เข้า → เริ่ม timer (X วินาที)
message 2 เข้า → รีเซ็ต timer
message 3 เข้า → รีเซ็ต timer
         ↓ ครบ X วินาที (ไม่มี message ใหม่)
         ↓
รวม 3 ข้อความเป็น 1 query → ส่งบอท 1 ครั้ง → ตอบ 1 คำตอบ
```

---

## Config ที่ปรับได้ในหน้า /config

เพิ่ม 3 ค่าใหม่ใน `SystemConfigDoc`:

| Field | Default | คำอธิบาย |
|-------|---------|----------|
| `bot_buffer_enabled` | `false` | เปิด/ปิด message buffering |
| `bot_buffer_window_ms` | `6000` | รอ X ms หลัง message สุดท้ายก่อนประมวลผล |
| `bot_buffer_max_messages` | `5` | ถ้าครบ X ข้อความใน window → ประมวลผลเลย ไม่รอ |

---

## การ Implement

### 1. systemConfigService.ts — เพิ่ม config fields

**ไฟล์:** `ChatAdminWeb/src/backend/service/systemConfigService.ts`

- เพิ่ม `bot_buffer_enabled`, `bot_buffer_window_ms`, `bot_buffer_max_messages` ใน `SystemConfigDoc`
- เพิ่มใน `getSafeDefaults()` — ค่า default จาก env หรือ hard-coded
- เพิ่มใน `mergeWithSafety()` — อ่านจาก DB หรือใช้ default
- เพิ่มใน default doc ตอนสร้างครั้งแรก

### 2. config/page.tsx — เพิ่ม UI ปรับค่า

**ไฟล์:** `ChatAdminWeb/src/app/(console)/config/page.tsx`

เพิ่ม Card ใหม่ "Bot Message Buffering" ใต้ Card "Bot Worker (Auto)":

```
┌─ Bot Message Buffering ──────────────────┐
│  ⚙️ รวมข้อความหลายท่อนเป็น 1 คำถาม        │
│                                          │
│  [Toggle] เปิด Buffering                 │
│                                          │
│  รอ X ms หลังข้อความสุดท้าย:              │
│  [6000] ms                               │
│                                          │
│  สูงสุด X ข้อความต่อ buffer:              │
│  [5] ข้อความ                             │
│                                          │
│  [บันทึก]                                │
└──────────────────────────────────────────┘
```

- Toggle เปิด/ปิด `bot_buffer_enabled`
- Number input สำหรับ `bot_buffer_window_ms` (1000-30000, step 500)
- Number input สำหรับ `bot_buffer_max_messages` (1-20, step 1)
- ปุ่มบันทึกส่งไป `/api/config` (PUT)

### 3. botWorkerService.ts — เพิ่ม Buffer Manager

**ไฟล์:** `ChatAdminWeb/src/backend/service/botWorkerService.ts`

เพิ่ม in-memory buffer per conversation:

```typescript
// ─── Message Buffer (Debounce) ───────────────────────────
interface BufferedMessage {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  received_at: number; // Date.now()
}

// buffer per conversation: conversation_id → messages[]
const bufferMap = new Map<string, BufferedMessage[]>();
// timer per conversation: conversation_id → timeout handle
const bufferTimers = new Map<string, NodeJS.Timeout>();

async function flushBuffer(conversationId: string): Promise<void> {
  const msgs = bufferMap.get(conversationId);
  if (!msgs || msgs.length === 0) return;

  // ล้าง buffer + timer
  bufferMap.delete(conversationId);
  const timer = bufferTimers.get(conversationId);
  if (timer) { clearTimeout(timer); bufferTimers.delete(conversationId); }

  // รวมข้อความทั้งหมดเป็น 1 query
  // ใช้ข้อความแรกเป็นหลัก แล้วต่อด้วยข้อความถัดไปด้วย \n
  const combinedText = msgs.map(m => m.text).join("\n");
  const firstMsg = msgs[0]; // ใช้ message_id ตัวแรกเป็น reference

  // ประมวลผลเป็น 1 message
  const result = await processMessage({
    message_id: firstMsg.message_id,       // ใช้ตัวแรกเป็น ref
    conversation_id: firstMsg.conversation_id,
    shop_id: firstMsg.shop_id,
    platform: firstMsg.platform,
    text: combinedText,                    // ข้อความรวม
    raw_payload: firstMsg.raw_payload,     // ใช้ raw_payload ตัวแรก
  });

  // mark ข้อความที่เหลือว่า processed (รวมในคำตอบเดียวกัน)
  for (let i = 1; i < msgs.length; i++) {
    await markProcessed({
      message_id: msgs[i].message_id,
      conversation_id: msgs[i].conversation_id,
      shop_id: msgs[i].shop_id,
      platform: msgs[i].platform,
      status: "bot_answered",
    });
  }
}

export async function bufferOrProcess(
  msg: { message_id: string; conversation_id: string; shop_id: string; platform: Platform; text: string; raw_payload?: unknown },
  config: { bufferEnabled: boolean; bufferWindowMs: number; bufferMaxMessages: number }
): Promise<{ status: string; detail: string }> {
  // ถ้าปิด buffer → ประมวลผลทันที (เหมือนเดิม)
  if (!config.bufferEnabled) {
    return processMessage(msg);
  }

  // เพิ่มเข้า buffer
  const convId = msg.conversation_id;
  if (!bufferMap.has(convId)) bufferMap.set(convId, []);
  bufferMap.get(convId)!.push({ ...msg, received_at: Date.now() });

  // ถ้าครบ max → flush ทันที
  const buffered = bufferMap.get(convId)!;
  if (buffered.length >= config.bufferMaxMessages) {
    return flushBuffer(convId).then(() => ({ status: "buffered_flushed", detail: `max ${config.bufferMaxMessages} reached` }));
  }

  // รีเซ็ต timer
  const existingTimer = bufferTimers.get(convId);
  if (existingTimer) clearTimeout(existingTimer);
  bufferTimers.set(convId, setTimeout(() => {
    flushBuffer(convId).catch(err => console.error(`[buffer] flush error:`, err));
  }, config.bufferWindowMs));

  return { status: "buffered", detail: `buffered (${buffered.length} msgs, waiting ${config.bufferWindowMs}ms)` };
}
```

### 4. bot-worker.ts — ใช้ bufferOrProcess แทน processMessage

**ไฟล์:** `ChatAdminWeb/scripts/bot-worker.ts`

แก้ loop ใน `pollNewMessages` ให้เรียก `bufferOrProcess` แทน `processMessage`:

```typescript
// อ่าน config สำหรับ buffer
const config = await getSystemConfig();
const bufferConfig = {
  bufferEnabled: config.bot_buffer_enabled,
  bufferWindowMs: config.bot_buffer_window_ms,
  bufferMaxMessages: config.bot_buffer_max_messages,
};

// ในลูป for (const doc of docs):
const result = await bufferOrProcess({
  message_id: doc.message_id,
  conversation_id: doc.conversation_id,
  shop_id: doc.shop_id,
  platform: doc.platform,
  text: doc.text,
  raw_payload: doc.raw_payload,
}, bufferConfig);
```

### 5. pollNewMessages — แก้ให้ส่ง config เข้าไป

**ไฟล์:** `ChatAdminWeb/src/backend/service/botWorkerService.ts`

แก้ `pollNewMessages` ให้:
- อ่าน `getSystemConfig()` ทุกรอบ
- เรียก `bufferOrProcess(msg, bufferConfig)` แทน `processMessage(msg)`
- ถ้า `bufferEnabled=false` → `bufferOrProcess` เรียก `processMessage` ทันที (ยังไงก็ทำงานเหมือนเดิม)

---

## Flow หลัง Implement

### กรณีปิด Buffer (default)

```
message เข้า → bufferOrProcess → processMessage ทันที (เหมือนเดิม)
```

### กรณีเปิด Buffer

```
message 1 เข้า → buffer (รอ 6s)
message 2 เข้า → รีเซ็ต timer (รอ 6s ใหม่)
message 3 เข้า → รีเซ็ต timer (รอ 6s ใหม่)
         ↓ ครบ 6s ไม่มี message ใหม่
         ↓
flushBuffer → รวม 3 ข้อความเป็น "สนใจหัวชาร์จ\nมี 220W ไหม\nส่งรูปได้ไหม"
         ↓
processMessage 1 ครั้ง → บอทตอบ 1 คำตอบ
         ↓
mark ข้อความที่ 2,3 ว่า processed (รวมในคำตอบเดียว)
```

### กรณีครบ Max Messages

```
message 1-5 เข้าใน 6s → ครบ 5 (max) → flush ทันที ไม่รอ
```

---

## ข้อควรระวัง

1. **Buffer อยู่ใน memory** — ถ้า bot-worker restart ข้อความใน buffer จะหาย
   - แต่ข้อความยังอยู่ใน `messages` collection → poll รอบถัดไปเจออีก
   - แต่ `isProcessed` จะไม่เจอ → ประมวลผลใหม่ (อาจตอบซ้ำได้)
   - **แก้:** ตอนเข้า buffer ให้ mark `chat_processing` ด้วย status `buffered` กันประมวลผลซ้ำ

2. **Trigger check** — ถ้าลูกค้าพิมพ์ "poppy" (trigger keyword) ใน buffer
   - ตอน flush ต้องเช็ค trigger ของข้อความรวมด้วย
   - ถ้า match → ใช้ trigger action (handoff หรือ bot_template)
   - **สำคัญ:** trigger check อยู่ใน `processMessage` อยู่แล้ว → ทำงานอัตโนมัติ

3. **History race condition** — ถ้าบอทกำลังตอบ message ก่อนหน้า และ message ใหม่เข้า
   - Buffer รอ 6s → พอ flush บอทตอบก่อนหน้าเสร็จแล้ว → history ครบ
   - ดีกว่า fire-and-forget ที่อาจยิงพร้อมกัน

4. **Test Chat** — Test Chat ไม่ผ่าน bot-worker → ไม่ได้รับผล buffer
   - ถ้าอยากให้ Test Chat มี buffer ด้วย → เพิ่มใน `TestChatClient.tsx` แยก
   - **แนะนำ:** ทำใน bot-worker ก่อน ส่วน Test Chat ไว้ทีหลัง

5. **Shadow Inbox / Test Assignment** — ไม่กระทบเพราะใช้ `processMessage` ตรงๆ
   - ถ้าอยากให้ replay จำลอง buffer ด้วย → ทำภายหลัง

---

## ลำดับการทำ

1. **systemConfigService.ts** — เพิ่ม 3 config fields + defaults
2. **config/page.tsx** — เพิ่ม UI Card สำหรับปรับค่า
3. **botWorkerService.ts** — เพิ่ม `bufferMap`, `bufferTimers`, `bufferOrProcess`, `flushBuffer`
4. **botWorkerService.ts** — แก้ `pollNewMessages` ให้เรียก `bufferOrProcess`
5. **bot-worker.ts** — อ่าน config ส่งเข้า `pollNewMessages`
6. **Build + ทดสอบ** — ปิด buffer ก่อน (default) แล้วลองเปิด

---

## ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | การเปลี่ยน |
|------|-----------|
| `src/backend/service/systemConfigService.ts` | เพิ่ม 3 config fields |
| `src/app/(console)/config/page.tsx` | เพิ่ม UI Card Buffering |
| `src/backend/service/botWorkerService.ts` | เพิ่ม buffer logic + แก้ pollNewMessages |
| `scripts/bot-worker.ts` | ส่ง buffer config เข้า pollNewMessages |

---

## ค่าแนะนำ

| ค่า | แนะนำ | หมายเหตุ |
|------|------|----------|
| `bot_buffer_window_ms` | 6000 (6 วินาที) | รอให้ลูกค้าพิมพ์จบ ไม่นานเกินไป |
| `bot_buffer_max_messages` | 5 | ถ้าลูกค้าพิมพ์รัวๆ 5 ท่อน ก็ตอบเลย |
| `bot_buffer_enabled` | false (default) | ต้องเปิดเองในหน้า config |
