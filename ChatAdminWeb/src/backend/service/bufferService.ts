// Buffer Service — Message Buffering (Debounce) สำหรับ Bot Worker
//
// วัตถุประสงค์: รอให้ลูกค้าหยุดพิมพ์ X วินาที แล้วรวมทุกข้อความเป็น 1 query
// ส่งให้บอท 1 ครั้ง → ตอบ 1 คำตอบ (แทน fire-and-forget ที่ตอบทุกข้อความ)
//
// โครงสร้าง:
//   - buffer_messages collection — เก็บข้อความที่กำลัง buffer (DB-backed ไม่ใช่ memory)
//   - timer map (in-memory) — debounce timer per conversation_id
//   - ตอนเข้า buffer → insert ลง buffer_messages (ยังไม่ mark chat_processing)
//   - ตอน flush → รวมข้อความ → processMessage → mark chat_processing ปกติ → ลบจาก buffer_messages
//   - ตอน boot → recover stale buffers (flush เลย ไม่รอ)
//
// ⚠️ ปลอดภัย:
//   - ไม่ mark chat_processing ตอนเข้า buffer (กัน isProcessed ขัดกับ processMessage)
//   - ถ้า bot-worker restart ข้อความใน buffer_messages ยังอยู่ → recover ตอน boot
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";
import type { Platform } from "./systemConfigService";

// ─── Types ────────────────────────────────────────────────

export interface BufferMessageDoc extends Document {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  received_at: Date;
}

export interface BufferConfig {
  bufferEnabled: boolean;
  bufferWindowMs: number;
  bufferMaxMessages: number;
  // ⚡ Phase 1E — media-aware buffer: รอนานกว่า + รับได้มากกว่าเมื่อมีรูป/วิดีโอ
  bufferWindowMediaMs?: number;   // default = bufferWindowMs * 2
  bufferMaxMediaMessages?: number; // default = bufferMaxMessages * 2
}

// ─── Media detection (⚡ Phase 1E) ─────────────────────────
// ตรวจว่า message เป็นรูป/วิดีโอไหม — ใช้ raw_payload structure เดียวกับ messageMediaParser
// ไม่ import messageMediaParser เพื่อหลีกเลี่ยง circular dependency + ตรวจแบบง่ายๆ พอ

function hasMedia(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== "object") return false;
  const raw = rawPayload as Record<string, unknown>;
  // ตรวจ message_type ที่ nested หรือ top-level
  const nested = (raw.data as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined;
  const msgType = (nested?.message_type as string) || (raw.message_type as string) || (raw.msg_type as string) || "";
  return msgType === "image" || msgType === "video" || msgType === "image_with_text";
}

// ดึง image URLs จาก raw_payload (เหมือน toBotImages แต่ inline เพื่อหลีกเลี่ยง circular dep)
function extractMediaUrls(rawPayload: unknown): string[] {
  if (!rawPayload || typeof rawPayload !== "object") return [];
  const raw = rawPayload as Record<string, unknown>;
  const nested = (raw.data as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined;
  const inner = (nested?.content as Record<string, unknown> | undefined) || (raw.content as Record<string, unknown> | undefined) || {};
  const msgType = (nested?.message_type as string) || (raw.message_type as string) || (raw.msg_type as string) || "";
  if (msgType === "image" || msgType === "image_with_text") {
    const url = (inner.image_url as string) || (((inner.image_url_list as string[]) || [])[0]);
    return url ? [url] : [];
  }
  if (msgType === "video") {
    const url = (inner.video_url as string) || "";
    return url ? [url] : [];
  }
  return [];
}

// ─── In-memory timer map (per conversation) ───────────────
// timer อยู่ใน memory (ไม่ใช่ DB) — ถ้า restart หาย แต่ recover ตอน boot ช่วยได้
const bufferTimers = new Map<string, NodeJS.Timeout>();

// ─── Insert message into buffer_messages collection ───────

async function insertToBuffer(msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
}): Promise<void> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  await coll.insertOne({
    message_id: msg.message_id,
    conversation_id: msg.conversation_id,
    shop_id: msg.shop_id,
    platform: msg.platform,
    text: msg.text,
    raw_payload: msg.raw_payload,
    received_at: new Date(),
  });
}

// ─── Get buffered messages for a conversation ─────────────

async function getBufferedMessages(conversationId: string): Promise<BufferMessageDoc[]> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  return coll
    .find({ conversation_id: conversationId })
    .sort({ received_at: 1 })
    .toArray();
}

// ─── Delete buffered messages for a conversation ──────────

async function deleteBufferedMessages(conversationId: string): Promise<void> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);
  await coll.deleteMany({ conversation_id: conversationId });
}

// ─── Clear timer for a conversation ───────────────────────

function clearTimer(conversationId: string): void {
  const timer = bufferTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    bufferTimers.delete(conversationId);
  }
}

// ─── Flush buffer — รวมข้อความ → processMessage → ลบ ──────
//
// รับ processMessage function จาก botWorkerService (avoid circular dependency)
// และ markProcessed function สำหรับ mark ข้อความที่เหลือ

type ProcessMessageFn = (msg: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  text: string;
  raw_payload?: unknown;
  images?: string[];  // ⚡ Phase 1F — image URLs รวมจากทุก message ใน buffer
}) => Promise<{ status: string; detail: string }>;

type MarkProcessedFn = (doc: {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  status: "trigger_matched" | "bot_answered" | "handed_off" | "bot_failed" | "no_action";
}) => Promise<void>;

export async function flushBuffer(
  conversationId: string,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn
): Promise<{ status: string; detail: string }> {
  // ล้าง timer
  clearTimer(conversationId);

  // ดึงข้อความที่ buffer อยู่
  const msgs = await getBufferedMessages(conversationId);
  if (msgs.length === 0) {
    return { status: "skip", detail: "no buffered messages" };
  }

  // ลบออกจาก buffer_messages ก่อน (กัน flush ซ้ำถ้ามี message ใหม่เข้ามา)
  await deleteBufferedMessages(conversationId);

  // รวมข้อความทั้งหมดเป็น 1 query — ใช้ space แทน \n เพื่อให้ RAG/LLM อ่านเป็นประโยคเดียว
  const combinedText = msgs.map((m) => m.text).join(" ");
  const firstMsg = msgs[0];

  // ⚡ Phase 1E/1F — รวม images จากทุก message (ไม่ใช่แค่ firstMsg)
  //    ลูกค้าส่ง 3 รูป + พิมพ์ → บอทต้องเห็นรูปทั้ง 3
  const allImages: string[] = [];
  for (const m of msgs) {
    const urls = extractMediaUrls(m.raw_payload);
    for (const u of urls) {
      if (!allImages.includes(u)) allImages.push(u);
    }
  }

  try {
    // ประมวลผลเป็น 1 message
    const result = await processMessage({
      message_id: firstMsg.message_id, // ใช้ตัวแรกเป็น ref
      conversation_id: firstMsg.conversation_id,
      shop_id: firstMsg.shop_id,
      platform: firstMsg.platform,
      text: combinedText, // ข้อความรวม
      raw_payload: firstMsg.raw_payload, // ใช้ raw_payload ตัวแรก (สำหรับ trigger matching)
      images: allImages.length > 0 ? allImages : undefined, // ⚡ ส่ง images เป็น field แยก
    });

    // mark ข้อความที่เหลือว่า processed (รวมในคำตอบเดียว)
    for (let i = 1; i < msgs.length; i++) {
      await markProcessed({
        message_id: msgs[i].message_id,
        conversation_id: msgs[i].conversation_id,
        shop_id: msgs[i].shop_id,
        platform: msgs[i].platform,
        status: "bot_answered",
      });
    }

    await logAdminEvent({
      action_type: "bot.buffer_flush",
      actor: "bot-worker",
      metadata: {
        conversation_id: conversationId,
        message_count: msgs.length,
        combined_text_length: combinedText.length,
        result_status: result.status,
      },
    });

    return {
      status: "buffer_flushed",
      detail: `flushed ${msgs.length} msgs → ${result.status}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[buffer] flush error for ${conversationId}:`, errorMsg);

    await logAdminEvent({
      action_type: "bot.buffer_flush",
      actor: "bot-worker",
      metadata: {
        conversation_id: conversationId,
        message_count: msgs.length,
        error: errorMsg,
      },
    });

    return { status: "buffer_error", detail: errorMsg };
  }
}

// ─── Buffer or Process — ตัดสินใจว่าจะ buffer หรือ process ทันที ──

export async function bufferOrProcess(
  msg: {
    message_id: string;
    conversation_id: string;
    shop_id: string;
    platform: Platform;
    text: string;
    raw_payload?: unknown;
  },
  config: BufferConfig,
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn
): Promise<{ status: string; detail: string }> {
  // ถ้าปิด buffer → ประมวลผลทันที (เหมือนเดิม)
  if (!config.bufferEnabled) {
    return processMessage(msg);
  }

  const convId = msg.conversation_id;

  // เพิ่มเข้า buffer_messages collection
  await insertToBuffer(msg);

  // ดึงจำนวนข้อความที่ buffer อยู่ใน conversation นี้
  const buffered = await getBufferedMessages(convId);

  // ⚡ Phase 1E — ตรวจว่ามี media (รูป/วิดีโอ) ใน buffer ไหม
  //    ถ้ามี → ใช้ window นานกว่า + max มากกว่า (ลูกค้ามักส่งหลายรูปติดกัน)
  const hasAnyMedia = buffered.some((m) => hasMedia(m.raw_payload));
  const mediaWindowMs = config.bufferWindowMediaMs ?? config.bufferWindowMs * 2;
  const mediaMaxMessages = config.bufferMaxMediaMessages ?? config.bufferMaxMessages * 2;
  const effectiveWindowMs = hasAnyMedia ? mediaWindowMs : config.bufferWindowMs;
  const effectiveMaxMessages = hasAnyMedia ? mediaMaxMessages : config.bufferMaxMessages;

  // ถ้าครบ max → flush ทันที ไม่รอ
  if (buffered.length >= effectiveMaxMessages) {
    return flushBuffer(convId, processMessage, markProcessed);
  }

  // รีเซ็ต timer (debounce) — ใช้ window ตาม media
  clearTimer(convId);
  bufferTimers.set(
    convId,
    setTimeout(() => {
      flushBuffer(convId, processMessage, markProcessed).catch((err) =>
        console.error(`[buffer] timer flush error for ${convId}:`, err)
      );
    }, effectiveWindowMs)
  );

  return {
    status: "buffered",
    detail: `buffered (${buffered.length} msgs, ${hasAnyMedia ? "media" : "text"} window ${effectiveWindowMs}ms)`,
  };
}

// ─── Recover stale buffers ตอน boot ───────────────────────
// ถ้า bot-worker restart ขณะมีข้อความค้างใน buffer_messages
// → flush เลย (ไม่รอ timer เพราะ timer หายแล้ว)

export async function recoverStaleBuffers(
  processMessage: ProcessMessageFn,
  markProcessed: MarkProcessedFn
): Promise<{ recovered: number; conversations: string[] }> {
  const coll = await getCollection<BufferMessageDoc>(COLLECTIONS.bufferMessages);

  // หา conversation ที่มีข้อความค้าง
  const staleConvIds = await coll.distinct("conversation_id", {});
  if (staleConvIds.length === 0) {
    return { recovered: 0, conversations: [] };
  }

  console.log(`[buffer] recovering ${staleConvIds.length} stale conversations from buffer_messages`);

  const conversations: string[] = [];
  for (const convId of staleConvIds) {
    try {
      await flushBuffer(convId, processMessage, markProcessed);
      conversations.push(convId);
    } catch (err) {
      console.error(`[buffer] recovery error for ${convId}:`, err);
    }
  }

  await logAdminEvent({
    action_type: "bot.buffer_recover",
    actor: "bot-worker",
    metadata: {
      recovered_conversations: conversations.length,
      conversation_ids: conversations,
    },
  });

  return { recovered: conversations.length, conversations };
}

// ─── Clear all timers (สำหรับ graceful shutdown) ──────────

export function clearAllBufferTimers(): void {
  for (const [convId, timer] of bufferTimers.entries()) {
    clearTimeout(timer);
  }
  bufferTimers.clear();
}

export const bufferService = {
  bufferOrProcess,
  flushBuffer,
  recoverStaleBuffers,
  clearAllBufferTimers,
};
