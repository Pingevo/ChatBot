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
  // ⚡ Phase 1A multimodal — description ที่สกัดจากรูปใน message นี้
  //    สำหรับ user message: เก็บ description ที่ vision pass สกัดได้ (ส่งกลับจาก bot)
  //    ส่งใน history ของ turn ถัดไป → bot ไม่ต้องอ่านรูปซ้ำ
  image_desc?: string;
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

  // ⚡ Phase 3C — แปลง order card เป็น [order: <order_sn>] เหมือน [สินค้า: <item_id>]
  // Python bot มี _ORDER_TAG_RE จับ [order: XXX] แล้ว (order_store.py)
  const orderSn = parsed.order_sn;
  if (orderSn) {
    const isPlaceholder = _PLACEHOLDER_RE.test(msg.text);
    const extra = isPlaceholder ? "" : msg.text.trim();
    return extra ? `[order: ${orderSn}] ${extra}` : `[order: ${orderSn}]`;
  }

  // ปล่อย other (image/video/sticker/notification) ไปตามเดิม
  return msg.text;
}

/**
 * ดึง URL สื่อ (รูป/วิดีโอ) จาก message (สำหรับ multimodal vision pass)
 *
 * สำหรับ rich-media message (image, image_with_text, video) ที่ DB เก็บเป็น raw_payload
 * ให้ดึง URL ออกมาเพื่อส่งให้ Python bot ใน field `images`
 * ถ้าเป็น message ปกติ (text) จะคืน array ว่าง
 *
 * ⚡ Phase 1A multimodal — บอทใช้ Gemini vision อ่านรูป/วิดีโอที่ลูกค้าส่ง
 * ⚡ Phase 1A+ — รองรับวิดีโอด้วย (เช่น ลูกค้าถ่ายวิดีโอแสดงอาการเสีย)
 *    ส่งเป็น string URL ธรรมดา — Python ฝั่งจะ detect mime_type จาก URL หรือ content-type
 */
export function toBotImages(msg: { text: string; raw_payload?: unknown }): string[] {
  const raw = msg.raw_payload;
  if (!raw) return [];

  let parsed;
  try {
    parsed = parseRawMessage(raw, msg.text);
  } catch {
    return [];
  }

  // ดึง URL จาก media (image / image_with_text / video)
  const media = parsed.media;
  if (media && (media.type === "image" || media.type === "video") && media.url) {
    return [media.url];
  }

  return [];
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
  imageDesc?: string; // ⚡ Phase 1A — description ที่สกัดจากรูปใน message นี้
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
    image_desc: opts.imageDesc,    // ⚡ Phase 1A — vision description cache
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
 * ⚡ Phase 3B-7 — เพิ่ม beforeTimestamp กัน Generate ทีละข้อดึง history รวมอนาคต
 *   ถ้าไม่ส่ง beforeTimestamp → ใช้ทั้งหมด (สำหรับ botworker ที่ตอบข้อล่าสุด)
 */
export async function getHistoryForBot(opts: {
  conversationId: string;
  platform: Platform;
  maxMessages?: number;
  beforeTimestamp?: Date;  // ⚡ Phase 3B-7 — กรองเฉพาะข้อความก่อนเวลานี้
}): Promise<{ role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[]> {
  // ⚡ E1-E2 — history logic ใหม่:
  //   - bot เห็นเฉพาะ user messages + bot replies ของเราเอง (prefer internal bot)
  //   - ไม่เห็น Zaapi (role=bot ใน messages_shp) และไม่เห็น admin (role=admin)
  //   - กรองเฉพาะ bot replies ที่ส่งจริง (origin="worker") ไม่เอา shadow test (origin="manual")
  //   - รวม image_desc ใน history (cache กัน re-read รูป)
  //   - group ถูกต้อง: pair user message กับ bot reply โดยใช้ inbound_message_id
  const maxMsgs = opts.maxMessages || 20; // ⚡ E1 — เพิ่มจาก 10 → 20 ให้ bot จำ context ได้มากขึ้น

  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);
  const userQuery: Record<string, unknown> = {
    conversation_id: opts.conversationId,
    platform: opts.platform,         // บังคับ — กันข้าม platform
    role: "user",                    // ⚡ Phase 2T — เฉพาะ user (ไม่เอา bot/admin)
  };
  // ⚡ Phase 3B-7 — กรองเฉพาะข้อความก่อน beforeTimestamp (กัน Generate ทีละข้อดึงอนาคต)
  if (opts.beforeTimestamp) {
    userQuery.created_timestamp = { $lt: opts.beforeTimestamp };
  }
  const userDocs = await coll
    .find(userQuery)
    .sort({ created_timestamp: -1 })
    .limit(maxMsgs)
    .toArray();

  // ⚡ E1-E2 — อ่าน bot replies จาก shadow_replies เฉพาะที่ส่งจริง (origin="worker")
  //   ไม่เอา origin="manual" (shadow inbox test) เพราะ bot จะสับสนคิดว่าตอบไปแล้ว
  const srColl = await getCollection<{
    conversation_id: string;
    platform: Platform;
    bot_reply_text: string;
    inbound_message_id: string;
    created_at: Date;
    mode?: string;
    origin?: string;
    deleted_at?: Date;
  }>(COLLECTIONS.shadowReplies);
  const botQuery: Record<string, unknown> = {
    conversation_id: opts.conversationId,
    platform: opts.platform,
    // เฉพาะที่ไม่ถูก soft delete และมีคำตอบจริง
    deleted_at: { $exists: false },
    bot_reply_text: { $exists: true, $ne: "" },
    // ⚡ E1-E2 — กรองเฉพาะ bot-worker replies (ส่งจริง) ไม่เอา shadow test
    origin: { $in: ["worker", "workflow"] },
  };
  // ⚡ Phase 3B-7 — กรองเฉพาะ bot replies ก่อน beforeTimestamp
  if (opts.beforeTimestamp) {
    botQuery.created_at = { $lt: opts.beforeTimestamp };
  }
  const botDocs = await srColl
    .find(botQuery)
    .sort({ created_at: -1 })
    .limit(maxMsgs)
    .toArray();

  // ⚡ E1 — group: สร้าง map ของ bot replies ตาม inbound_message_id เพื่อ pair กับ user message
  const botReplyByInboundId = new Map<string, typeof botDocs[0]>();
  for (const d of botDocs) {
    if (d.inbound_message_id && !botReplyByInboundId.has(d.inbound_message_id)) {
      botReplyByInboundId.set(d.inbound_message_id, d);
    }
  }

  // merge user + bot replies → เรียงตามเวลา (เก่า → ใหม่)
  type HistoryItem = { role: "user" | "model"; text: string; images?: string[]; image_desc?: string; _ts: Date };
  const merged: HistoryItem[] = [];

  for (const d of userDocs) {
    const item: HistoryItem = {
      role: "user" as const,
      _ts: d.created_timestamp,
      // ⚠️ ใช้ toBotText แทน d.text ตรงๆ — ถ้า message เป็นการ์ดสินค้า (text="[item]")
      // ต้องแปลงเป็น tag [สินค้า: <item_id>] ไม่งั้น bot เห็น history เป็น "[item]" ตอบไม่รู้เรื่อง
      text: toBotText(d),
    };
    // ⚡ Phase 1A multimodal — ส่ง URL รูปใน history ด้วย
    const imgs = toBotImages(d);
    if (imgs.length > 0) item.images = imgs;
    // ส่ง image_desc ที่เคยสกัดไว้ (cache) — bot ไม่ต้องอ่านรูปซ้ำ
    if (d.image_desc) item.image_desc = d.image_desc;
    merged.push(item);

    // ⚡ E1 — pair user message กับ bot reply (ถ้ามี) โดยใช้ inbound_message_id
    const botReply = d.message_id ? botReplyByInboundId.get(d.message_id) : undefined;
    if (botReply) {
      merged.push({
        role: "model" as const,
        _ts: botReply.created_at,
        text: botReply.bot_reply_text,
      });
    }
  }

  // ⚡ E1 — เพิ่ม bot replies ที่ไม่มี user message คู่ (เช่น workflow trigger ที่ bot ส่งเอง)
  for (const d of botDocs) {
    if (!d.inbound_message_id || !userDocs.some((u) => u.message_id === d.inbound_message_id)) {
      merged.push({
        role: "model" as const,
        _ts: d.created_at,
        text: d.bot_reply_text,
      });
    }
  }

  // เรียงเก่า → ใหม่ แล้วตัดให้เหลือ maxMessages (เอาใหม่สุด)
  merged.sort((a, b) => a._ts.getTime() - b._ts.getTime());
  const trimmed = merged.length > maxMsgs ? merged.slice(-maxMsgs) : merged;

  // ลบ field _ts ออกก่อน return
  return trimmed.map(({ _ts, ...rest }) => rest);
}

/**
 * ⚡ getGroupedHistoryForBot — สำหรับ botworker เท่านั้น
 *
 * ความแตกต่างจาก getHistoryForBot:
 *   1. รวม user messages ที่ติดกัน (ไม่มี reply คั่น) เป็น 1 turn
 *   2. pair reply: เลือก bot เราก่อน (shadow_replies origin=worker/workflow)
 *      ถ้าไม่มี → fallback ใช้ Zaapi (messages_shp role=admin ไม่มี actor, direction=out)
 *   3. ไม่เอา admin จริง (role=admin + มี actor) เพราะ bot ไม่ควรเห็นคำตอบแอดมิน
 *
 * โครงสร้าง history ที่ได้:
 *   [
 *     { role: "user", text: "สีแดงมีไหม ราคาเท่าไหร่ ส่งวันจันทร์ถึงไหม" },  ← 3 msg รวม
 *     { role: "model", text: "มีครับ 299 ส่งวันจันทร์ถึง" },              ← bot reply หรือ Zaapi
 *     { role: "user", text: "มีสีฟ้าไหม" },
 *     { role: "model", text: "มีครับ" },
 *   ]
 *
 * maxTurns = จำนวน turn สูงสุด (default 10) — 1 turn = 1 user group + 1 reply
 */
export async function getGroupedHistoryForBot(opts: {
  conversationId: string;
  platform: Platform;
  maxTurns?: number;
}): Promise<{ role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[]> {
  const maxTurns = opts.maxTurns || 10;

  const coll = await getCollection<MessageDoc>(COLLECTIONS.messages);

  // 1. ดึง user messages + Zaapi replies (role=admin ไม่มี actor) + ไม่เอา admin จริง (มี actor)
  //    ดึงล่าสุด 50 ข้อความ (พอให้ grouping ได้ครบ)
  const allDocs = await coll
    .find({
      conversation_id: opts.conversationId,
      platform: opts.platform,
      $or: [
        { role: "user" },
        // Zaapi: role=admin ไม่มี actor, direction=out, source ไม่ใช่ "admin"
        { role: "admin", actor: { $exists: false }, direction: "out", source: { $ne: "admin" } },
        // ⚡ รองรับ Zaapi เก่าที่อาจเป็น role=bot
        { role: "bot", direction: "out" },
      ],
    })
    .sort({ created_timestamp: -1 })
    .limit(50)
    .toArray();

  // 2. ดึง bot replies จาก shadow_replies (origin=worker/workflow)
  const srColl = await getCollection<{
    conversation_id: string;
    platform: Platform;
    bot_reply_text: string;
    inbound_message_id: string;
    created_at: Date;
    origin?: string;
    deleted_at?: Date;
  }>(COLLECTIONS.shadowReplies);
  const botDocs = await srColl
    .find({
      conversation_id: opts.conversationId,
      platform: opts.platform,
      deleted_at: { $exists: false },
      bot_reply_text: { $exists: true, $ne: "" },
      origin: { $in: ["worker", "workflow"] },
    })
    .sort({ created_at: -1 })
    .limit(50)
    .toArray();

  // 3. สร้าง map: inbound_message_id → bot reply
  const botReplyByInboundId = new Map<string, typeof botDocs[0]>();
  for (const d of botDocs) {
    if (d.inbound_message_id && !botReplyByInboundId.has(d.inbound_message_id)) {
      botReplyByInboundId.set(d.inbound_message_id, d);
    }
  }

  // 4. แยก user messages และ Zaapi replies
  type SortedDoc = {
    role: "user" | "zaapi";
    text: string;
    message_id: string;
    ts: Date;
    raw_payload?: unknown;
    image_desc?: string;
  };
  const sorted: SortedDoc[] = [];
  for (const d of allDocs) {
    if (d.role === "user") {
      sorted.push({
        role: "user",
        text: toBotText(d),
        message_id: d.message_id,
        ts: d.created_timestamp,
        raw_payload: d.raw_payload,
        image_desc: d.image_desc,
      });
    } else {
      // Zaapi (role=admin ไม่มี actor หรือ role=bot)
      sorted.push({
        role: "zaapi",
        text: d.text,
        message_id: d.message_id,
        ts: d.created_timestamp,
      });
    }
  }
  // เรียงเก่า → ใหม่
  sorted.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // 5. Group: user messages ที่ติดกัน (ไม่มี reply คั่น) = 1 turn
  type Turn = {
    userTexts: string[];
    userImages: string[];
    imageDescs: string[];
    userMsgIds: string[];
    lastUserTs: Date;
    zaapiReply?: { text: string; ts: Date };
  };
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const doc of sorted) {
    if (doc.role === "user") {
      if (!currentTurn) {
        currentTurn = {
          userTexts: [],
          userImages: [],
          imageDescs: [],
          userMsgIds: [],
          lastUserTs: doc.ts,
        };
      }
      currentTurn.userTexts.push(doc.text);
      currentTurn.userMsgIds.push(doc.message_id);
      currentTurn.lastUserTs = doc.ts;
      // รวม images + image_desc
      if (doc.raw_payload) {
        const imgs = toBotImages({ text: doc.text, raw_payload: doc.raw_payload });
        for (const u of imgs) {
          if (!currentTurn.userImages.includes(u)) currentTurn.userImages.push(u);
        }
      }
      if (doc.image_desc && !currentTurn.imageDescs.includes(doc.image_desc)) {
        currentTurn.imageDescs.push(doc.image_desc);
      }
    } else {
      // Zaapi reply — ปิด turn ปัจจุบัน
      if (currentTurn) {
        currentTurn.zaapiReply = { text: doc.text, ts: doc.ts };
        turns.push(currentTurn);
        currentTurn = null;
      }
    }
  }
  // turn สุดท้ายที่ยังไม่มี reply
  if (currentTurn) {
    turns.push(currentTurn);
  }

  // 6. ตัดให้เหลือ maxTurns (เอาใหม่สุด)
  const trimmedTurns = turns.length > maxTurns ? turns.slice(-maxTurns) : turns;

  // 7. สร้าง history: แต่ละ turn → { user, model }
  type HistoryItem = { role: "user" | "model"; text: string; images?: string[]; image_desc?: string };
  const history: HistoryItem[] = [];

  for (const turn of trimmedTurns) {
    // user turn — รวมข้อความทั้งหมด
    const userText = turn.userTexts.join(" ");
    const userItem: HistoryItem = { role: "user", text: userText };
    if (turn.userImages.length > 0) userItem.images = turn.userImages;
    if (turn.imageDescs.length > 0) userItem.image_desc = turn.imageDescs.join(" | ");
    history.push(userItem);

    // reply turn — เลือก bot เราก่อน, ถ้าไม่มี fallback Zaapi
    let botReply: { text: string } | null = null;
    for (const msgId of turn.userMsgIds) {
      const sr = botReplyByInboundId.get(msgId);
      if (sr && sr.bot_reply_text) {
        botReply = { text: sr.bot_reply_text };
        break;
      }
    }
    if (!botReply && turn.zaapiReply) {
      botReply = { text: turn.zaapiReply.text };
    }
    if (botReply) {
      history.push({ role: "model", text: botReply.text });
    }
  }

  return history;
}

export const messageService = {
  addMessage,
  listMessages,
  listMessagesPaginated,
  getHistoryForBot,
  getGroupedHistoryForBot,
  toBotText,
};
