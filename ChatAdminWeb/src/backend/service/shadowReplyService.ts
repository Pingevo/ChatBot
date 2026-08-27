// ShadowReply service — เก็บคำตอบที่บอทของเรา generate ใน `shadow_replies` collection
// ⛔ IRON RULE: ห้ามส่งข้อความจริงให้ลูกค้า — เก็บเฉพาะใน DB ของเรา
// ⛔ ห้ามเรียก Shopee/TikTok/Lazada API ใดๆ
//
// วัตถุประสงค์: เปรียบเทียบคำตอบของบอทเรากับคำตอบของ Zaapi/sellcenter
// เพื่อวัดความแม่นยำ โดยไม่กระทบ production
//
// Data flow:
//   1. sellcenter เขียน inbound message (ลูกค้า) ลง `messages` collection
//   2. sellcenter อาจเขียน Zaapi reply ลง `messages` ด้วย (role "bot"/"admin" source "zaapi" หรืออะไรก็ตาม)
//   3. เราเรียก bot ของเราผ่าน /api/chatbot/[platform]/chat (proxy ไป Python service)
//   4. เก็บ bot reply ใน `shadow_replies` (ไม่ส่งจริง)
//   5. UI แสดงเปรียบเทียบ: inbound | Zaapi reply | Bot shadow reply
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { listMessages, getHistoryForBot } from "./messageService";
import { getConversation } from "./conversationService";
import { assertPlatformApiDisabled, type Platform } from "../lib/safety";

export interface ShadowReplyDoc extends Document {
  shadow_reply_id: string;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  inbound_message_id: string;     // ข้อความลูกค้าที่ bot ตอบ
  inbound_text: string;            // snapshot ของข้อความลูกค้า
  bot_reply_text: string;          // คำตอบที่ bot ของเรา generate
  bot_source?: string;             // source จาก bot (knowledge_base, general, etc.)
  bot_model?: string;
  bot_elapsed_ms?: number;
  bot_tokens?: { prompt: number; output: number; total: number };
  bot_cost_usd?: number;          // ต้นทุนประมาณ (USD) — จาก bot
  bot_cost_thb?: number;          // ต้นทุนประมาณ (THB) — คำนวณจาก USD × 36
  bot_products?: unknown[];
  // comparison — เทียบกับ Zaapi/sellcenter reply (ถ้ามี)
  zaapi_reply_text?: string;       // คำตอมของ Zaapi/sellcenter (ถ้ามีใน messages)
  zaapi_reply_message_id?: string;
  // evaluation — admin ให้คะแนน
  rating?: "better" | "worse" | "tie" | "unrated";  // bot vs zaapi
  rated_by?: string;
  rated_at?: Date;
  notes?: string;                  // หมายเหตุของ admin
  origin?: "worker" | "manual" | "manual_conversation";    // ที่มา — worker (auto) / manual (Generate เอง) / manual_conversation (Generate ทั้งหมด)
  trigger_id?: string;             // ถ้าตอบเพราะ trigger match (worker เท่านั้น)
  created_at: Date;
  updated_at: Date;
}

function genShadowReplyId(): string {
  return "sr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * List shadow replies — join กับ conversation เพื่อดึง shop_name, customer_name
 */
export async function listShadowReplies(opts: {
  platform?: Platform;
  shopId?: string;
  conversationId?: string;
  rating?: "better" | "worse" | "tie" | "unrated";
  origin?: "worker" | "manual" | "manual_conversation";
  limit?: number;
} = {}): Promise<ShadowReplyDoc[]> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = {};
  if (opts.platform) filter.platform = opts.platform;
  if (opts.shopId) filter.shop_id = opts.shopId;
  if (opts.conversationId) filter.conversation_id = opts.conversationId;
  if (opts.rating) filter.rating = opts.rating;
  if (opts.origin) filter.origin = opts.origin;
  return coll
    .find(filter)
    .sort({ created_at: -1 })
    .limit(opts.limit || 200)
    .toArray();
}

/**
 * Get one shadow reply
 */
export async function getShadowReply(shadowReplyId: string): Promise<ShadowReplyDoc | null> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  return coll.findOne({ shadow_reply_id: shadowReplyId });
}

/**
 * Generate a shadow reply — เรียก bot ของเรา แต่เก็บใน shadow_replies (ไม่ส่งจริง)
 *
 * ⛔ ห้ามส่งข้อความจริง — เก็บเฉพาะใน DB
 * ⛔ ห้ามเรียก platform API
 *
 * @param conversationId - conversation ที่จะ generate shadow reply
 * @param inboundMessageId - message_id ของข้อความลูกค้าที่จะให้ bot ตอบ (optional — ถ้าไม่ระบุจะใช้ข้อความล่าสุด)
 * @param botCaller - function ที่เรียก bot (inject เพื่อ testable)
 */
export async function generateShadowReply(opts: {
  conversationId: string;
  inboundMessageId?: string;
  botCaller: (params: {
    platform: Platform;
    message: string;
    history: { role: "user" | "model"; text: string }[];
    shopId: string;
    shopName?: string;
  }) => Promise<{
    answer: string;
    source?: string;
    model?: string;
    elapsed?: number;
    usage?: { prompt: number; output: number; total: number };
    cost?: number;       // USD
    products?: unknown[];
  }>;
}): Promise<ShadowReplyDoc> {
  const { conversationId, botCaller } = opts;

  // อ่าน conversation จาก DB (ไม่เรียก platform API)
  const conv = await getConversation(conversationId);
  if (!conv) throw new Error("conversation not found");

  // ⛔ Iron Rule guard — กันใครเพิ่ม code เรียก platform API โดยไม่ตั้งใจ
  assertPlatformApiDisabled(conv.platform, "send");
  assertPlatformApiDisabled(conv.platform, "read");

  // อ่าน messages จาก DB (ไม่เรียก platform API)
  const messages = await listMessages(conversationId, { platform: conv.platform, limit: 50 });

  // หา inbound message ที่จะให้ bot ตอบ
  let inboundMsg: typeof messages[0] | undefined;
  if (opts.inboundMessageId) {
    inboundMsg = messages.find((m) => m.message_id === opts.inboundMessageId);
  } else {
    // ใช้ข้อความล่าสุดที่ลูกค้าส่งเข้า (role "user" direction "in")
    inboundMsg = [...messages].reverse().find((m) => m.role === "user" && m.direction === "in");
  }
  if (!inboundMsg) throw new Error("no inbound message found to reply to");

  // ดึง history สำหรับ bot (ก่อน inbound message นี้)
  const history = await getHistoryForBot({
    conversationId,
    platform: conv.platform,
    maxMessages: 10,
  });

  // เรียก bot ของเรา (ผ่าน botCaller — ไม่ได้เรียก platform API)
  // ⚠️ ส่ง shopName (ชื่อร้าน) ให้ bot ด้วย เพราะ Python bot กรองสินค้าด้วยชื่อร้าน
  const botResp = await botCaller({
    platform: conv.platform,
    message: inboundMsg.text,
    history,
    shopId: conv.shop_id,
    shopName: conv.shop_name,
  });

  // หา Zaapi/sellcenter reply สำหรับ inbound message นี้ (ถ้ามีใน messages)
  // Zaapi reply อาจจะเป็น role "bot" หรือ role "admin" ที่ source ไม่ใช่ "admin"
  // (source "admin" = แอดมินพิมพ์เองใน console ของเรา)
  const zaapiReply = messages.find(
    (m) =>
      m.direction === "out" &&
      m.role !== "user" &&
      m.source !== "admin" &&
      m.created_timestamp > inboundMsg!.created_timestamp
  );

  // เก็บใน shadow_replies (ไม่ส่งจริง)
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const now = new Date();
  const doc: ShadowReplyDoc = {
    shadow_reply_id: genShadowReplyId(),
    conversation_id: conversationId,
    shop_id: conv.shop_id,
    platform: conv.platform,
    inbound_message_id: inboundMsg.message_id,
    inbound_text: inboundMsg.text,
    bot_reply_text: botResp.answer,
    bot_source: botResp.source,
    bot_model: botResp.model,
    bot_elapsed_ms: botResp.elapsed,
    bot_tokens: botResp.usage,
    bot_cost_usd: botResp.cost,
    bot_cost_thb: botResp.cost ? botResp.cost * 36 : undefined,  // USD × 36 = THB (ประมาณ)
    bot_products: botResp.products,
    zaapi_reply_text: zaapiReply?.text,
    zaapi_reply_message_id: zaapiReply?.message_id,
    rating: "unrated",
    origin: "manual",  // สร้างจากหน้า Shadow Inbox (กด Generate)
    created_at: now,
    updated_at: now,
  };
  await coll.insertOne(doc);
  return doc;
}

/**
 * Generate shadow replies สำหรับทุก Q&A pair ใน conversation — แบบ sequential
 *
 * ลำดับการทำงาน:
 *   1. โหลด messages ทั้งหมดใน conversation (เรียงจากเก่า → ใหม่)
 *   2. แยกเป็น Q&A pairs (user question → หา Zaapi reply ถัดไป)
 *   3. วนทีละ Q&A pair จากเก่าสุด → ใหม่สุด:
 *      - history = คำถาม + คำตอบ bot เรา ที่ generate ไปก่อนหน้า (ไม่ใช่ Zaapi)
 *      - เรียก bot ของเรา พร้อม history ที่สะสมได้
 *      - เก็บผลลัพธ์ใน shadow_replies
 *      - เพิ่มคำถาม + คำตอบ bot เรา เข้า history สำหรับรอบถัดไป
 *   4. คืนผลลัพธ์ทั้งหมด
 *
 * ⛔ ห้ามส่งข้อความจริง — เก็บใน shadow_replies เท่านั้น
 * ⛔ ห้ามเรียก platform API
 *
 * @param conversationId - conversation ที่จะ generate
 * @param botCaller - function ที่เรียก bot (inject เพื่อ testable)
 * @param onProgress - callback แจ้งความคืบหน้า (optional)
 */
export async function generateConversationShadowReplies(opts: {
  conversationId: string;
  botCaller: (params: {
    platform: Platform;
    message: string;
    history: { role: "user" | "model"; text: string }[];
    shopId: string;
    shopName?: string;
  }) => Promise<{
    answer: string;
    source?: string;
    model?: string;
    elapsed?: number;
    usage?: { prompt: number; output: number; total: number };
    cost?: number;
    products?: unknown[];
  }>;
  onProgress?: (current: number, total: number, pair: { inbound_text: string }) => void;
}): Promise<ShadowReplyDoc[]> {
  const { conversationId, botCaller, onProgress } = opts;

  // อ่าน conversation จาก DB
  const conv = await getConversation(conversationId);
  if (!conv) throw new Error("conversation not found");

  // ⛔ Iron Rule guard
  assertPlatformApiDisabled(conv.platform, "send");
  assertPlatformApiDisabled(conv.platform, "read");

  // โหลด messages ทั้งหมด (เรียงเก่า → ใหม่)
  const messages = await listMessages(conversationId, { platform: conv.platform, limit: 500 });

  // แยกเป็น Q&A pairs: แต่ละ user message = คำถาม, หา out message ถัดไป = Zaapi reply
  interface QAPair {
    inboundMsg: typeof messages[0];
    zaapiReply: typeof messages[0] | null;
  }
  const pairs: QAPair[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && m.direction === "in") {
      // หา out message ถัดไปที่เป็น Zaapi/bot (ไม่ใช่ admin พิมพ์เอง)
      let zaapiReply: typeof messages[0] | null = null;
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.role === "user" && next.direction === "in") break;
        if (next.direction === "out" && next.role !== "user" && next.source !== "admin") {
          zaapiReply = next;
          break;
        }
      }
      pairs.push({ inboundMsg: m, zaapiReply });
    }
  }

  if (pairs.length === 0) throw new Error("no user messages found in conversation");

  // ⚡ history สะสม — เริ่มว่าง, เพิ่มทีละ Q&A (user question + bot reply เรา)
  // จำกัดไม่ให้เกิน 20 ข้อความ (10 คู่ล่าสุด) เพื่อกัน LLM context เยอะเกินไป
  const MAX_HISTORY = 20;
  const accumulatedHistory: { role: "user" | "model"; text: string }[] = [];
  const results: ShadowReplyDoc[] = [];
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);

  for (let idx = 0; idx < pairs.length; idx++) {
    const pair = pairs[idx];
    onProgress?.(idx + 1, pairs.length, { inbound_text: pair.inboundMsg.text });

    // เรียก bot ของเรา — ส่ง history ที่สะสม (เก็บเฉพาะ 20 ข้อความล่าสุด)
    const trimmedHistory = accumulatedHistory.slice(-MAX_HISTORY);
    const botResp = await botCaller({
      platform: conv.platform,
      message: pair.inboundMsg.text,
      history: [...trimmedHistory], // copy เพื่อกัน mutation
      shopId: conv.shop_id,
      shopName: conv.shop_name,
    });

    // เก็บใน shadow_replies
    const now = new Date();
    const doc: ShadowReplyDoc = {
      shadow_reply_id: genShadowReplyId(),
      conversation_id: conversationId,
      shop_id: conv.shop_id,
      platform: conv.platform,
      inbound_message_id: pair.inboundMsg.message_id,
      inbound_text: pair.inboundMsg.text,
      bot_reply_text: botResp.answer,
      bot_source: botResp.source,
      bot_model: botResp.model,
      bot_elapsed_ms: botResp.elapsed,
      bot_tokens: botResp.usage,
      bot_cost_usd: botResp.cost,
      bot_cost_thb: botResp.cost ? botResp.cost * 36 : undefined,
      bot_products: botResp.products,
      zaapi_reply_text: pair.zaapiReply?.text,
      zaapi_reply_message_id: pair.zaapiReply?.message_id,
      rating: "unrated",
      origin: "manual_conversation",  // Generate ทั้งหมด — ไม่ปนกับ Generate เอง
      created_at: now,
      updated_at: now,
    };
    await coll.insertOne(doc);
    results.push(doc);

    // ⚡ เพิ่ม Q&A นี้เข้า history สำหรับรอบถัดไป
    //    user question → role "user"
    //    bot reply เรา → role "model" (ไม่ใช่ Zaapi reply)
    accumulatedHistory.push({ role: "user", text: pair.inboundMsg.text });
    accumulatedHistory.push({ role: "model", text: botResp.answer });
  }

  return results;
}

/**
 * Rate a shadow reply — admin ให้คะแนนเปรียบเทียบ bot vs zaapi
 */
export async function rateShadowReply(
  shadowReplyId: string,
  rating: "better" | "worse" | "tie" | "unrated",
  ratedBy: string,
  notes?: string
): Promise<boolean> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const result = await coll.updateOne(
    { shadow_reply_id: shadowReplyId },
    {
      $set: {
        rating,
        rated_by: ratedBy,
        rated_at: new Date(),
        notes: notes,
        updated_at: new Date(),
      },
    }
  );
  return result.modifiedCount > 0;
}

/**
 * Delete a shadow reply (hard delete — เป็น data ทดสอบ ไม่ใช่ production data)
 */
export async function deleteShadowReply(shadowReplyId: string): Promise<boolean> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const result = await coll.deleteOne({ shadow_reply_id: shadowReplyId });
  return result.deletedCount > 0;
}

/**
 * Get statistics — สรุปคะแนน bot vs zaapi
 */
export async function getShadowReplyStats(opts: {
  platform?: Platform;
  shopId?: string;
} = {}): Promise<{
  total: number;
  rated: number;
  better: number;
  worse: number;
  tie: number;
  unrated: number;
  bot_win_rate: number; // (better + tie*0.5) / rated
  // cost + performance metrics
  total_cost_usd: number;
  total_cost_thb: number;
  avg_cost_usd: number;
  avg_elapsed_ms: number;
  total_tokens: number;
  avg_tokens: number;
}> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = {};
  if (opts.platform) filter.platform = opts.platform;
  if (opts.shopId) filter.shop_id = opts.shopId;

  const docs = await coll.find(filter).toArray();
  const total = docs.length;
  const rated = docs.filter((d) => d.rating && d.rating !== "unrated").length;
  const better = docs.filter((d) => d.rating === "better").length;
  const worse = docs.filter((d) => d.rating === "worse").length;
  const tie = docs.filter((d) => d.rating === "tie").length;
  const unrated = docs.filter((d) => !d.rating || d.rating === "unrated").length;
  const bot_win_rate = rated > 0 ? (better + tie * 0.5) / rated : 0;

  // cost + performance
  const costs = docs.map((d) => d.bot_cost_usd || 0);
  const total_cost_usd = costs.reduce((a, b) => a + b, 0);
  const total_cost_thb = total_cost_usd * 36;
  const avg_cost_usd = total > 0 ? total_cost_usd / total : 0;

  const elapsed = docs.map((d) => d.bot_elapsed_ms || 0);
  const avg_elapsed_ms = total > 0 ? elapsed.reduce((a, b) => a + b, 0) / total : 0;

  const tokens = docs.map((d) => d.bot_tokens?.total || 0);
  const total_tokens = tokens.reduce((a, b) => a + b, 0);
  const avg_tokens = total > 0 ? total_tokens / total : 0;

  return {
    total, rated, better, worse, tie, unrated, bot_win_rate,
    total_cost_usd, total_cost_thb, avg_cost_usd, avg_elapsed_ms,
    total_tokens, avg_tokens,
  };
}

export const shadowReplyService = {
  list: listShadowReplies,
  get: getShadowReply,
  generate: generateShadowReply,
  generateConversation: generateConversationShadowReplies,
  rate: rateShadowReply,
  delete: deleteShadowReply,
  stats: getShadowReplyStats,
};
