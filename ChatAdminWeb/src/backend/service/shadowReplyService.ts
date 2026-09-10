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
import { listMessages, getHistoryForBot, toBotText, toBotImages } from "./messageService";
import { getConversation } from "./conversationService";
import { assertPlatformApiDisabled, type Platform } from "../lib/safety";
import { logAdminEvent } from "./adminLogService";

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
  rating?: "good" | "bad" | "unrated";  // bot vs zaapi
  rated_by?: string;
  rated_at?: Date;
  notes?: string;                  // หมายเหตุของ admin
  star_rating?: number;            // คะแนนดาว 0-5 (รองรับทศนิยม เช่น 4.5)
  star_rated_by?: string;
  star_rated_at?: Date;
  comment?: string;                // คอมเมนต์ว่าบอทตอบดี/ไม่ดี มีปัญหายังไง
  comment_by?: string;
  comment_at?: Date;
  // soft delete — ไม่ hard delete เก็บประวัติ
  deleted_at?: Date;
  deleted_by?: string;
  delete_reason?: string;
  // ⚡ Phase 3A — ใครเป็นคนกด Generate (KPI — manual เท่านั้น, worker = null)
  generated_by?: string;
  origin?: "worker" | "manual" | "manual_conversation" | "workflow";    // ที่มา — worker (auto) / manual (Generate เอง) / manual_conversation (Generate ทั้งหมด) / workflow (Flow Builder)
  // ⚡ Phase 2R — mode: โหมดการทำงาน (แยกจาก origin)
  //   standalone = botworker รันอัตโนมัติ (อ่าน messages_shp, เก็บใน shadow_replies)
  //   shadowbot = แอดมินกด Generate ใน /shadow-inbox (เปรียบเทียบกับ Zaapi)
  //   ticket = แอดมินตอบใน /tickets (อนาคต)
  mode?: "standalone" | "shadowbot" | "ticket";
  trigger_id?: string;             // ถ้าตอบเพราะ trigger match (worker เท่านั้น)
  bot_routing_decision?: {         // routing decision จาก bot (observability)
    path?: string;
    reason?: string;
    trigger_matched?: string | null;
    shop_settings_action?: string | null;
    assigned_admin?: string | null;
    handoff_reason?: string | null;
  };
  bot_handoff_to_admin?: boolean;
  bot_handoff_reason?: string;
  bot_image_desc?: string;           // ⚡ A2 — vision description ของรูป current turn (cache กัน re-read)
  // ⚡ chat_engine — บันทึกว่าคำตอบนี้มาจาก engine ไหน (legacy / v2 / v3)
  //    ใช้ตอนเปรียบเทียบ — แยกคำตอบ legacy vs v2 vs v3 ใน shadow inbox
  chat_engine?: "legacy" | "v2" | "v3";
  // ⚡ Phase 3B-6 — id กลุ่มรอบ generate (unique ต่อรอบ กด Generate ซ้ำแชทเดิมแยกกัน)
  //   format: gen_<convId>_<ts36>_<rand>
  //   ใช้ group + sort รอบใน UI, แยก annotation ตามรอบ
  generation_batch_id?: string;
  created_at: Date;
  updated_at: Date;
}

function genShadowReplyId(): string {
  return "sr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ⚡ Phase 3B-6 — สร้าง batch_id สำหรับรอบ generate หนึ่งรอบ (unique ไม่ชนกันแม้กดพร้อมกัน)
function genGenerationBatchId(conversationId: string): string {
  const safeConv = conversationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "conv";
  return `gen_${safeConv}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * List shadow replies — join กับ conversation เพื่อดึง shop_name, customer_name
 */
export async function listShadowReplies(opts: {
  platform?: Platform;
  shopId?: string;
  conversationId?: string;
  rating?: "good" | "bad" | "unrated";
  origin?: "worker" | "manual" | "manual_conversation" | "workflow";
  generatedBy?: string;  // ⚡ Phase 3A — กรองตามคนกด Generate
  generationBatchId?: string;  // ⚡ Phase 3B-6 — กรองตามรอบ generate
  limit?: number;
  includeDeleted?: boolean;  // ถ้า true → รวม soft-deleted
  deletedOnly?: boolean;     // ถ้า true → ดึงเฉพาะที่ถูก soft delete
} = {}): Promise<ShadowReplyDoc[]> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = {};
  if (opts.platform) filter.platform = opts.platform;
  if (opts.shopId) filter.shop_id = opts.shopId;
  if (opts.conversationId) filter.conversation_id = opts.conversationId;
  if (opts.rating) filter.rating = opts.rating;
  if (opts.origin) filter.origin = opts.origin;
  if (opts.generatedBy) filter.generated_by = opts.generatedBy;
  if (opts.generationBatchId) filter.generation_batch_id = opts.generationBatchId;
  // soft delete — กรองออก by default
  if (opts.deletedOnly) {
    filter.deleted_at = { $exists: true };
  } else if (!opts.includeDeleted) {
    filter.deleted_at = { $exists: false };
  }
  return coll
    .find(filter)
    .sort({ created_at: -1 })
    .limit(opts.limit || 200)
    .toArray();
}

/**
 * Get one shadow reply
 */
export async function getShadowReply(shadowReplyId: string, opts?: { includeDeleted?: boolean }): Promise<ShadowReplyDoc | null> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = { shadow_reply_id: shadowReplyId };
  if (!opts?.includeDeleted) {
    filter.deleted_at = { $exists: false };
  }
  return coll.findOne(filter);
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
  generatedBy?: string;  // ⚡ Phase 3A — admin_id ของคนกด Generate (KPI)
  // ⚡ chat_engine — บันทึกว่าคำตอบนี้ใช้ engine ไหน
  chatEngine?: "legacy" | "v2" | "v3";
  botCaller: (params: {
    platform: Platform;
    message: string;
    history: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[];
    shopId: string;
    shopName?: string;
    images?: string[];
  }) => Promise<{
    answer: string;
    source?: string;
    model?: string;
    elapsed?: number;
    usage?: { prompt: number; output: number; total: number };
    cost?: number;       // USD
    products?: unknown[];
    image_desc?: string;
  }>;
}): Promise<ShadowReplyDoc> {
  const { conversationId, botCaller, generatedBy, chatEngine } = opts;

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
  // ⚡ Phase 3B-7 — ส่ง beforeTimestamp กัน bot เห็นข้อความในอนาคต (Q2-Q11)
  const history = await getHistoryForBot({
    conversationId,
    platform: conv.platform,
    maxMessages: 10,
    beforeTimestamp: inboundMsg.created_timestamp,
  });

  // ⚡ Phase 3B-7 — เพิ่ม shadow replies ที่ generate ไปแล้ว (origin="manual") ใน history
  //   ไม่งั้นกด Generate ทีละข้อ → Q2 จะไม่เห็น Q1 bot reply → บอทไม่มี context
  //   getHistoryForBot เอาเฉพาะ origin="worker" เราต้องเพิ่ม manual เอง
  const srColl = await getCollection<{
    inbound_message_id: string;
    bot_reply_text: string;
    created_at: Date;
    deleted_at?: Date;
  }>(COLLECTIONS.shadowReplies);
  const manualReplies = await srColl
    .find({
      conversation_id: conversationId,
      platform: conv.platform,
      deleted_at: { $exists: false },
      bot_reply_text: { $exists: true, $ne: "" },
      origin: "manual",
      created_at: { $lt: inboundMsg.created_timestamp },
    })
    .sort({ created_at: 1 })
    .toArray();
  // สร้าง map: inbound_message_id → bot_reply_text
  const manualReplyMap = new Map<string, string>();
  for (const r of manualReplies) {
    if (r.inbound_message_id && !manualReplyMap.has(r.inbound_message_id)) {
      manualReplyMap.set(r.inbound_message_id, r.bot_reply_text);
    }
  }
  // แทรก manual bot replies ลงใน history (หลัง user message ที่ match inbound_message_id)
  if (manualReplyMap.size > 0) {
    const enrichedHistory: typeof history = [];
    for (const h of history) {
      enrichedHistory.push(h);
      // ถ้า h เป็น user message และมี manual reply อยู่ → เพิ่ม model reply ตามหลัง
      // ต้องหา inbound_message_id ของ h — ใช้ text match เพราะ history ไม่มี message_id
      // วิธี: ดูจาก manualReplies ที่ตรงกับ user message นี้
      if (h.role === "user") {
        for (const [inboundId, replyText] of manualReplyMap) {
          const originalMsg = messages.find((m) => m.message_id === inboundId);
          if (originalMsg && toBotText(originalMsg) === h.text) {
            enrichedHistory.push({ role: "model", text: replyText });
            manualReplyMap.delete(inboundId);
            break;
          }
        }
      }
    }
    history.length = 0;
    history.push(...enrichedHistory);
  }

  // ⚠️ Enrich text สำหรับ rich-media messages — ถ้าลูกค้าแชร์การ์ดสินค้า
  // `text` จะเป็น placeholder "[item]" แต่ raw_payload มี item_id แปลงเป็น tag
  // "[สินค้า: <item_id>]" ที่ Python bot เข้าใจ ก่อนส่งให้ bot
  const botText = toBotText(inboundMsg);
  // ⚡ A2 — ดึง images ของ current inbound message ส่งให้ bot
  const botImages = toBotImages(inboundMsg);

  // เรียก bot ของเรา (ผ่าน botCaller — ไม่ได้เรียก platform API)
  // ⚠️ ส่ง shopName (ชื่อร้าน) ให้ bot ด้วย เพราะ Python bot กรองสินค้าด้วยชื่อร้าน
  const botResp = await botCaller({
    platform: conv.platform,
    message: botText,
    history,
    shopId: conv.shop_id,
    shopName: conv.shop_name,
    ...(botImages.length > 0 ? { images: botImages } : {}),
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
    inbound_text: botText,  // snapshot สิ่งที่ bot เห็นจริง (อาจเป็น tag [สินค้า: <item_id>] ถ้าเป็นการ์ดสินค้า)
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
    mode: "shadowbot",  // ⚡ Phase 2R — โหมด shadowbot (แอดมินกด Generate)
    generated_by: generatedBy,  // ⚡ Phase 3A — ใครกด Generate (KPI)
    bot_routing_decision: (botResp as any).routing_decision,
    bot_handoff_to_admin: (botResp as any).handoff_to_admin,
    bot_handoff_reason: (botResp as any).handoff_reason,
    bot_image_desc: botResp.image_desc, // ⚡ A2 — cache vision description
    chat_engine: chatEngine || "legacy", // ⚡ บันทึก engine ที่ใช้
    created_at: now,
    updated_at: now,
  };
  await coll.insertOne(doc);
  await logAdminEvent({
    action_type: "shadow_reply.generate",
    actor: "system",
    metadata: {
      shadow_reply_id: doc.shadow_reply_id,
      conversation_id: doc.conversation_id,
      message_id: doc.message_id,
      origin: doc.origin,
    },
  });
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
  generatedBy?: string;  // ⚡ Phase 3A — admin_id ของคนกด Generate (KPI)
  // ⚡ chat_engine — บันทึกว่าคำตอบนี้ใช้ engine ไหน
  chatEngine?: "legacy" | "v2" | "v3";
  botCaller: (params: {
    platform: Platform;
    message: string;
    history: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[];
    shopId: string;
    shopName?: string;
    images?: string[];
  }) => Promise<{
    answer: string;
    source?: string;
    model?: string;
    elapsed?: number;
    usage?: { prompt: number; output: number; total: number };
    cost?: number;
    products?: unknown[];
    image_desc?: string;
  }>;
  onProgress?: (current: number, total: number, pair: { inbound_text: string }) => void;
  // ⚡ streaming — เรียกหลัง insert แต่ละ shadow reply (สำหรับ SSE: ส่งทีละคำตอบให้ UI แสดงทันที)
  onReply?: (doc: ShadowReplyDoc, current: number, total: number) => void;
}): Promise<ShadowReplyDoc[]> {
  const { conversationId, botCaller, onProgress, onReply, generatedBy, chatEngine } = opts;

  // ⚡ Phase 3B-6 — สร้าง batch_id สำหรับรอบนี้ (tag ทุก Q&A pair ในรอบเดียวกัน)
  const batchId = genGenerationBatchId(conversationId);

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
    // ⚠️ Enrich text สำหรับ rich-media messages — ถ้าลูกค้าแชร์การ์ดสินค้า
    // `text` จะเป็น placeholder "[item]" แปลงเป็น tag [สินค้า: <item_id>] ก่อนส่ง bot
    const botText = toBotText(pair.inboundMsg);
    // ⚡ A2 — ดึง images ของ current inbound message
    const botImages = toBotImages(pair.inboundMsg);
    onProgress?.(idx + 1, pairs.length, { inbound_text: botText });

    // เรียก bot ของเรา — ส่ง history ที่สะสม (เก็บเฉพาะ 20 ข้อความล่าสุด)
    const trimmedHistory = accumulatedHistory.slice(-MAX_HISTORY);
    const botResp = await botCaller({
      platform: conv.platform,
      message: botText,
      history: [...trimmedHistory], // copy เพื่อกัน mutation
      shopId: conv.shop_id,
      shopName: conv.shop_name,
      ...(botImages.length > 0 ? { images: botImages } : {}),
    });

    // เก็บใน shadow_replies
    const now = new Date();
    const doc: ShadowReplyDoc = {
      shadow_reply_id: genShadowReplyId(),
      conversation_id: conversationId,
      shop_id: conv.shop_id,
      platform: conv.platform,
      inbound_message_id: pair.inboundMsg.message_id,
      inbound_text: botText,  // snapshot สิ่งที่ bot เห็นจริง
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
      generated_by: generatedBy,  // ⚡ Phase 3A — ใครกด Generate (KPI)
      mode: "shadowbot",  // ⚡ Phase 2R — โหมด shadowbot (Generate ทั้งหมด)
      bot_routing_decision: (botResp as any).routing_decision,
      bot_handoff_to_admin: (botResp as any).handoff_to_admin,
      bot_handoff_reason: (botResp as any).handoff_reason,
      bot_image_desc: botResp.image_desc, // ⚡ A2 — cache vision description
      chat_engine: chatEngine || "legacy", // ⚡ บันทึก engine ที่ใช้
      generation_batch_id: batchId,  // ⚡ Phase 3B-6 — tag รอบ generate
      created_at: now,
      updated_at: now,
    };
    await coll.insertOne(doc);
    results.push(doc);
    // ⚡ streaming — ส่ง doc ที่เพิ่ง insert ให้ caller (SSE) ทันที ไม่ต้องรอครบทุก pair
    onReply?.(doc, idx + 1, pairs.length);

    // ⚡ เพิ่ม Q&A นี้เข้า history สำหรับรอบถัดไป
    //    user question → role "user" (ใช้ botText เพื่อให้รอบถัดไป bot เห็น tag สินค้าถ้ามี)
    //    bot reply เรา → role "model" (ไม่ใช่ Zaapi reply)
    accumulatedHistory.push({ role: "user", text: botText });
    accumulatedHistory.push({ role: "model", text: botResp.answer });
  }

  await logAdminEvent({
    action_type: "shadow_reply.generate_conversation",
    actor: "system",
    metadata: {
      conversation_id: opts.conversationId,
      generated_count: results.length,
      generation_batch_id: batchId,  // ⚡ Phase 3B-6 — log รอบ generate
    },
  });

  // ⚡ Phase 3B-6 — attach batch_id ลง results ให้ caller ใช้ (ผ่าน property batchId)
  (results as ShadowReplyDoc[] & { batchId?: string }).batchId = batchId;
  return results;
}

// ⚡ Phase 3B-6 — ดึง distinct generation batches ของ conversation (เรียงใหม่สุดก่อน)
//   ใช้สำหรับ UI แสดง "รอบที่ 1/2/3..." และให้เลือก batch เพื่อดู shadow replies ของรอบนั้น
export interface GenerationBatch {
  generation_batch_id: string;
  conversation_id: string;
  created_at: string;       // ISO — เวลาเริ่มรอบ (min created_at ของ docs ใน batch)
  count: number;            // จำนวน Q&A pair ในรอบนั้น
  generated_by?: string;
  origin?: string;
}

export async function listGenerationBatches(conversationId: string): Promise<GenerationBatch[]> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  // aggregate: group by generation_batch_id, นับ + ดึง created_at ตัวแรก + generated_by ตัวแรก
  const pipeline: Record<string, unknown>[] = [
    { $match: { conversation_id: conversationId, deleted_at: { $exists: false } } },
    { $sort: { created_at: 1 } },
    {
      $group: {
        _id: "$generation_batch_id",
        conversation_id: { $first: "$conversation_id" },
        created_at: { $first: "$created_at" },
        count: { $sum: 1 },
        generated_by: { $first: "$generated_by" },
        origin: { $first: "$origin" },
      },
    },
    { $sort: { created_at: -1 } },  // ใหม่สุดก่อน
    { $limit: 100 },
  ];
  const rows = await coll.aggregate(pipeline).toArray();
  return rows.map((r: Record<string, unknown>) => ({
    generation_batch_id: String(r._id),
    conversation_id: String(r.conversation_id),
    created_at: (r.created_at as Date).toISOString(),
    count: Number(r.count),
    generated_by: r.generated_by ? String(r.generated_by) : undefined,
    origin: r.origin ? String(r.origin) : undefined,
  }));
}

/**
 * Rate a shadow reply — admin ให้คะแนนเปรียบเทียบ bot vs zaapi
 * + star rating (0-5) + comment
 */
export async function rateShadowReply(
  shadowReplyId: string,
  rating: "good" | "bad" | "unrated",
  ratedBy: string,
  opts?: {
    notes?: string;
    starRating?: number;   // 0-5
    comment?: string;      // คอมเมนต์
  }
): Promise<boolean> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const update: Record<string, unknown> = {
    rating,
    rated_by: ratedBy,
    rated_at: new Date(),
    updated_at: new Date(),
  };
  if (opts?.notes !== undefined) update.notes = opts.notes;
  if (opts?.starRating !== undefined) {
    const star = Math.max(0, Math.min(5, opts.starRating));
    update.star_rating = star;
    update.star_rated_by = ratedBy;
    update.star_rated_at = new Date();
  }
  if (opts?.comment !== undefined) {
    update.comment = opts.comment;
    update.comment_by = ratedBy;
    update.comment_at = new Date();
  }
  const result = await coll.updateOne(
    { shadow_reply_id: shadowReplyId },
    { $set: update }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "shadow_reply.rate",
      actor: ratedBy,
      metadata: { shadow_reply_id: shadowReplyId, rating, star_rating: opts?.starRating },
    });
  }
  return result.modifiedCount > 0;
}

/**
 * Soft delete all shadow replies — ล้างข้อมูลทั้งหมด (soft delete)
 * ใช้ตอนอยากเริ่มใหม่ แต่ยังเก็บประวัติ
 */
export async function clearAllShadowReplies(opts?: {
  platform?: Platform;
  shopId?: string;
  deletedBy?: string;
  reason?: string;
}): Promise<{ softDeletedCount: number }> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = { deleted_at: { $exists: false } };
  if (opts?.platform) filter.platform = opts.platform;
  if (opts?.shopId) filter.shop_id = opts.shopId;
  const now = new Date();
  const result = await coll.updateMany(filter, {
    $set: {
      deleted_at: now,
      deleted_by: opts?.deletedBy || "system",
      delete_reason: opts?.reason || "clear_all",
      updated_at: now,
    },
  });
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "shadow_reply.clear_all",
      actor: opts?.deletedBy || "system",
      metadata: { count: result.modifiedCount, platform: opts?.platform, shop_id: opts?.shopId, reason: opts?.reason },
    });
  }
  return { softDeletedCount: result.modifiedCount };
}

/**
 * Soft delete a shadow reply — ไม่ hard delete เก็บประวัติ
 * ตั้ง deleted_at + deleted_by + delete_reason
 */
export async function deleteShadowReply(
  shadowReplyId: string,
  deletedBy: string,
  reason?: string
): Promise<boolean> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const result = await coll.updateOne(
    { shadow_reply_id: shadowReplyId, deleted_at: { $exists: false } },
    {
      $set: {
        deleted_at: new Date(),
        deleted_by: deletedBy,
        delete_reason: reason || "",
        updated_at: new Date(),
      },
    }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "shadow_reply.delete",
      actor: deletedBy,
      metadata: { shadow_reply_id: shadowReplyId, reason, soft_delete: true },
    });
  }
  return result.modifiedCount > 0;
}

/**
 * ⚡ Phase 3B-5 — Soft delete ทุก shadow replies ใน conversation นั้น
 * ใช้สำหรับปุ่ม "ลบรายแชท" ใน history tab
 */
export async function deleteShadowRepliesByConversation(
  conversationId: string,
  deletedBy: string,
  reason?: string
): Promise<{ softDeletedCount: number }> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const now = new Date();
  const result = await coll.updateMany(
    { conversation_id: conversationId, deleted_at: { $exists: false } },
    {
      $set: {
        deleted_at: now,
        deleted_by: deletedBy,
        delete_reason: reason || "delete_conversation",
        updated_at: now,
      },
    }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "shadow_reply.delete_conversation",
      actor: deletedBy,
      conversation_id: conversationId,
      metadata: { count: result.modifiedCount, reason, soft_delete: true },
    });
  }
  return { softDeletedCount: result.modifiedCount };
}

/**
 * Restore a soft-deleted shadow reply
 */
export async function restoreShadowReply(shadowReplyId: string): Promise<boolean> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const result = await coll.updateOne(
    { shadow_reply_id: shadowReplyId },
    {
      $unset: { deleted_at: "", deleted_by: "", delete_reason: "" },
      $set: { updated_at: new Date() },
    }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "shadow_reply.restore",
      actor: "system",
      metadata: { shadow_reply_id: shadowReplyId },
    });
  }
  return result.modifiedCount > 0;
}

/**
 * ⚡ Restore ทุก shadow replies ใน conversation นั้น — ใช้ในหน้าถังขยะ (restore per conversation)
 */
export async function restoreShadowRepliesByConversation(
  conversationId: string
): Promise<{ restoredCount: number }> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const result = await coll.updateMany(
    { conversation_id: conversationId, deleted_at: { $exists: true } },
    {
      $unset: { deleted_at: "", deleted_by: "", delete_reason: "" },
      $set: { updated_at: new Date() },
    }
  );
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "shadow_reply.restore_conversation",
      actor: "system",
      conversation_id: conversationId,
      metadata: { count: result.modifiedCount },
    });
  }
  return { restoredCount: result.modifiedCount };
}

/**
 * Restore ทั้งหมดที่ถูก soft delete — ใช้ในหน้าถังขยะ
 */
export async function restoreAllShadowReplies(opts?: {
  platform?: Platform;
  shopId?: string;
}): Promise<{ restoredCount: number }> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = { deleted_at: { $exists: true } };
  if (opts?.platform) filter.platform = opts.platform;
  if (opts?.shopId) filter.shop_id = opts.shopId;
  const result = await coll.updateMany(filter, {
    $unset: { deleted_at: "", deleted_by: "", delete_reason: "" },
    $set: { updated_at: new Date() },
  });
  if (result.modifiedCount > 0) {
    await logAdminEvent({
      action_type: "shadow_reply.restore_all",
      actor: "system",
      metadata: { count: result.modifiedCount, platform: opts?.platform, shop_id: opts?.shopId },
    });
  }
  return { restoredCount: result.modifiedCount };
}

/**
 * Get statistics — สรุปคะแนน bot vs zaapi
 */
export async function getShadowReplyStats(opts: {
  platform?: Platform;
  shopId?: string;
  conversationId?: string;
} = {}): Promise<{
  total: number;
  rated: number;
  good: number;
  bad: number;
  unrated: number;
  bot_win_rate: number; // good / rated
  // star rating
  star_rated: number;          // จำนวนที่ให้ดาว
  avg_star: number;            // คะแนนดาวเฉลี่ย (0-5)
  star_5: number;
  star_4: number;              // 4-4.9
  star_3: number;              // 3-3.9
  star_below3: number;         // < 3
  // comment
  commented: number;           // จำนวนที่มี comment
  // cost + performance metrics
  total_cost_usd: number;
  total_cost_thb: number;
  avg_cost_usd: number;
  avg_elapsed_ms: number;
  total_tokens: number;
  avg_tokens: number;
}> {
  const coll = await getCollection<ShadowReplyDoc>(COLLECTIONS.shadowReplies);
  const filter: Record<string, unknown> = { deleted_at: { $exists: false } };
  if (opts.platform) filter.platform = opts.platform;
  if (opts.shopId) filter.shop_id = opts.shopId;
  if (opts.conversationId) filter.conversation_id = opts.conversationId;

  const docs = await coll.find(filter).toArray();
  const total = docs.length;
  const rated = docs.filter((d) => d.rating && d.rating !== "unrated").length;
  const good = docs.filter((d) => d.rating === "good").length;
  const bad = docs.filter((d) => d.rating === "bad").length;
  const unrated = docs.filter((d) => !d.rating || d.rating === "unrated").length;
  const bot_win_rate = rated > 0 ? good / rated : 0;

  // star rating
  const starDocs = docs.filter((d) => d.star_rating != null);
  const star_rated = starDocs.length;
  const starSum = starDocs.reduce((s, d) => s + (d.star_rating || 0), 0);
  const avg_star = star_rated > 0 ? starSum / star_rated : 0;
  const star_5 = starDocs.filter((d) => (d.star_rating || 0) >= 5).length;
  const star_4 = starDocs.filter((d) => (d.star_rating || 0) >= 4 && (d.star_rating || 0) < 5).length;
  const star_3 = starDocs.filter((d) => (d.star_rating || 0) >= 3 && (d.star_rating || 0) < 4).length;
  const star_below3 = starDocs.filter((d) => (d.star_rating || 0) < 3).length;

  // comment
  const commented = docs.filter((d) => d.comment && d.comment.trim().length > 0).length;

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
    total, rated, good, bad, unrated, bot_win_rate,
    star_rated, avg_star, star_5, star_4, star_3, star_below3,
    commented,
    total_cost_usd, total_cost_thb, avg_cost_usd, avg_elapsed_ms,
    total_tokens, avg_tokens,
  };
}

export const shadowReplyService = {
  list: listShadowReplies,
  get: getShadowReply,
  generate: generateShadowReply,
  generateConversation: generateConversationShadowReplies,
  listGenerationBatches,  // ⚡ Phase 3B-6
  rate: rateShadowReply,
  delete: deleteShadowReply,
  deleteByConversation: deleteShadowRepliesByConversation,
  restore: restoreShadowReply,
  restoreByConversation: restoreShadowRepliesByConversation,
  restoreAll: restoreAllShadowReplies,
  clearAll: clearAllShadowReplies,
  stats: getShadowReplyStats,
};
