// Message service — stores every chat message tied to a conversation_id.
// This is what makes "multichat" real: each conversation's history lives
// here, independent of any other conversation, and the orchestrator reads
// exactly this conversation's messages before calling the (stateless)
// Python chatbot.
//
// Collection shape mirrors the indexes already provisioned on `messages`:
//   shop_id_1, conversation_id_1, message_id_1,
//   conversation_id_1_created_timestamp_1, shop_id_1_created_timestamp_-1
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { touchLastMessage } from "./conversationService";
import { logAdminEvent } from "./adminLogService";
import { parseRawMessage } from "./messageMediaParser";

export type MessageRole = "user" | "bot" | "admin" | "system";
export type MessageDirection = "in" | "out"; // in = ลูกค้า, out = ร้าน/bot
export type Platform = "shopee" | "tiktok" | "lazada";

export interface MessageProduct {
  item_id: string;
  name: string;
  price?: number;
  image?: string;
  shop?: string;
  url?: string;
}

export interface MessageDoc extends Document {
  message_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;              // Phase 7 — กัน bot ตอบข้าม platform
  role: MessageRole;
  direction: MessageDirection;     // Phase 7 — in = ลูกค้าส่งเข้า, out = ร้าน/bot ตอบ
  text: string;
  products?: MessageProduct[];
  source?: string; // data_mirror | product_store | knowledge_base | general:* | admin | bot
  topic?: string;
  tokens?: { prompt: number; output: number; total: number };
  reply_to_message_id?: string;   // Phase 7 — idempotency key สำหรับ bot reply
  created_timestamp: Date;        // เวลาจริงที่ข้อความถูกสร้าง (จาก platform หรือ admin)
  data_received_at?: Date;         // เวลาที่ data writer เขียน (debug)
  raw_payload?: unknown;           // เก็บของเดิมไว้ debug
  actor?: string;                  // admin_id ที่ตอบ (สำหรับ admin messages)
}

function genMessageId(): string {
  return "msg_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ─── Bot-facing text ─────────────────────────────────────
// เมื่อลูกค้าแชร์การ์ดสินค้า/คำสั่งซื้อในแชท Shopee ข้อความที่ mirror เก็บใน `text`
// เป็น placeholder สั้นๆ เช่น "[item]" หรือ "[order]" — ไม่มีข้อมูลสินค้าจริง
// แต่ `raw_payload` มี item_id / order_sn อยู่ครบ
// Python bot รองรับ tag รูปแบบ "[สินค้า: <item_id>]" (ดู _ITEM_TAG_RE ใน chatbot/shopeechat/app.py)
// ดังนั้นฝั่ง Next.js ต้องแปลง rich-media message เป็น tag text ก่อนส่งให้ bot
// (ทั้งใน `message` ปัจจุบันและใน `history`) ไม่งั้น bot ตอบไม่รู้เรื่อง

// placeholder ที่ data writer ใส่ให้ rich-media messages — ให้แทนที่ด้วย tag แทน
const _PLACEHOLDER_RE = /^\s*\[(item|order|image|video|sticker|notification)\]\s*$/i;

/**
 * แปลง message → text ที่ bot ควรเห็น
 *
 * สำหรับ rich-media message (item card, order card, variation card) ที่ DB เก็บเป็น
 * placeholder เช่น "[item]" ให้แปลงเป็น tag ที่ Python bot เข้าใจ เช่น "[สินค้า: 46051234150]"
 * ถ้ามีข้อความลูกค้าต่อท้าย (ไม่ใช่ placeholder) จะต่อท้าย tag ให้ด้วย
 * ถ้าเป็น message ปกติ (text) จะคืน text เดิมเปล่าๆ
 */
export function toBotText(msg: { text: string; raw_payload?: unknown }): string {
  const raw = msg.raw_payload;
  if (!raw) return msg.text;

  let parsed;
  try {
    parsed = parseRawMessage(raw, msg.text);
  } catch {
    return msg.text;
  }

  const itemId = parsed.product_ref?.item_id;
  if (itemId) {
    const isPlaceholder = _PLACEHOLDER_RE.test(msg.text);
    const extra = isPlaceholder ? "" : msg.text.trim();
    return extra ? `[สินค้า: ${itemId}] ${extra}` : `[สินค้า: ${itemId}]`;
  }

  // ปล่อย order/other ไปตามเดิม (Python bot ยังไม่มี logic จับ order tag ใน message —
  // ถ้าจะรองรับต้องเพิ่ม regex ที่ฝั่ง Python ด้วย)
  return msg.text;
}

export async function addMessage(opts: {
  conversationId: string;
  shopId: string;
  platform?: Platform;        // ระบุให้ชัดเจน — แต่ละ platform แยกกัน
  role: MessageRole;
  direction?: MessageDirection; // default: in สำหรับ user, out สำหรับ bot/admin
  text: string;
  products?: MessageProduct[];
  source?: string;
  topic?: string;
  tokens?: { prompt: number; output: number; total: number };
  replyToMessageId?: string;  // idempotency key สำหรับ bot reply
  actor?: string; // admin_id for admin replies, "bot" for bot replies
}): Promise<MessageDoc> {
  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  const direction = opts.direction ?? (opts.role === "user" ? "in" : "out");
  const doc: MessageDoc = {
    message_id: genMessageId(),
    conversation_id: opts.conversationId,
    shop_id: opts.shopId,
    platform: opts.platform || "shopee", // default shopee ถ้าไม่ระบุ (backward compat)
    role: opts.role,
    direction,
    text: opts.text,
    products: opts.products || [],
    source: opts.source,
    topic: opts.topic,
    tokens: opts.tokens,
    reply_to_message_id: opts.replyToMessageId,
    created_timestamp: new Date(),
    actor: opts.actor,             // admin_id ที่ตอบ (สำหรับ admin messages)
  };
  await coll.insertOne(doc);

  // Update conversation preview — unread only bumps for customer-originated
  // messages (admin/bot replies are already "seen" by the console).
  await touchLastMessage(opts.conversationId, opts.text, opts.role === "user");

  // Log reply events for audit trail
  if (opts.role === "admin" && opts.actor) {
    await logAdminEvent({
      action_type: "admin.reply",
      actor: opts.actor,
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      metadata: { message_id: doc.message_id, text_preview: opts.text.slice(0, 100) },
    });
  } else if (opts.role === "bot") {
    await logAdminEvent({
      action_type: "bot.reply",
      actor: "system",
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      metadata: { message_id: doc.message_id, text_preview: opts.text.slice(0, 100) },
    });
  }

  return doc;
}

/**
 * List messages for a conversation — บังคับ filter conversation_id
 * ถ้าระบุ platform ด้วย จะ filter เพิ่ม (กัน bot ตอบข้าม platform)
 */
export async function listMessages(
  conversationId: string,
  opts?: { platform?: Platform; limit?: number }
): Promise<MessageDoc[]> {
  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  const filter: Record<string, unknown> = { conversation_id: conversationId };
  if (opts?.platform) filter.platform = opts.platform;
  return coll
    .find(filter)
    .sort({ created_timestamp: 1 })
    .limit(opts?.limit || 2000)
    .toArray();
}

/**
 * Cursor-based pagination สำหรับ infinite scroll.
 * - ถ้ามี `after` → ดึงข้อความหลังเวลานี้ (เรียงจากเก่า→ใหม่) — ใช้ตอน scroll ลงล่าง
 * - ถ้ามี `before` → ดึงข้อความก่อนเวลานี้ (เรียงจากใหม่→เก่า แล้ว reverse) — ใช้ตอน scroll ขึ้นบน
 * - ถ้าไม่มีทั้งคู่ → ดึง page สุดท้าย (ข้อความใหม่สุด limit ข้อความ) — ใช้ตอนเปิด conversation
 */
export async function listMessagesPaginated(
  conversationId: string,
  opts: {
    platform?: Platform;
    limit: number;
    before?: Date;
    after?: Date;
  }
): Promise<MessageDoc[]> {
  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  const filter: Record<string, unknown> = { conversation_id: conversationId };
  if (opts.platform) filter.platform = opts.platform;

  if (opts.after) {
    // scroll ลงล่าง — ดึงข้อความหลัง cursor
    filter.created_timestamp = { $gt: opts.after };
    return coll
      .find(filter)
      .sort({ created_timestamp: 1 })
      .limit(opts.limit)
      .toArray();
  }

  if (opts.before) {
    // scroll ขึ้นบน — ดึงข้อความก่อน cursor (เรียงใหม่→เก่า แล้ว reverse กลับ)
    filter.created_timestamp = { $lt: opts.before };
    const docs = await coll
      .find(filter)
      .sort({ created_timestamp: -1 })
      .limit(opts.limit)
      .toArray();
    return docs.reverse();
  }

  // default — ดึง page สุดท้าย (ข้อความใหม่สุด)
  const docs = await coll
    .find(filter)
    .sort({ created_timestamp: -1 })
    .limit(opts.limit)
    .toArray();
  return docs.reverse();
}

/**
 * Get the last N messages formatted for the chatbot's `history` param.
 * ⚠️ Phase 7 — บังคับ filter platform กัน bot ใช้ history ของ platform อื่น
 * เรียก assertBotReplyContext ก่อนเพื่อตรวจ platform match + conversation_id prefix
 */
export async function getHistoryForBot(opts: {
  conversationId: string;
  platform: Platform;
  maxMessages?: number;
}): Promise<{ role: "user" | "model"; text: string }[]> {
  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  const docs = await coll
    .find({
      conversation_id: opts.conversationId,
      platform: opts.platform,         // บังคับ — กันข้าม platform
      role: { $in: ["user", "bot"] },
    })
    .sort({ created_timestamp: -1 })
    .limit(opts.maxMessages || 10)
    .toArray();
  return docs
    .reverse()
    .map((d) => ({
      role: d.role === "user" ? ("user" as const) : ("model" as const),
      // ⚠️ ใช้ toBotText แทน d.text ตรงๆ — ถ้า message เป็นการ์ดสินค้า (text="[item]")
      // ต้องแปลงเป็น tag [สินค้า: <item_id>] ไม่งั้น bot เห็น history เป็น "[item]" ตอบไม่รู้เรื่อง
      text: d.role === "user" ? toBotText(d) : d.text,
    }));
}

export const messageService = {
  addMessage,
  listMessages,
  listMessagesPaginated,
  getHistoryForBot,
  toBotText,
};
