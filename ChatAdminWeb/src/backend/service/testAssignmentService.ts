// testAssignmentService — เก็บ replay results + ratings ของ test assignment
//
// Collection: test_assignment
// Document shape:
//   {
//     _id: ObjectId,
//     conversation_id: string,
//     shop_id: string,
//     platform: Platform,
//     shop_name?: string,
//     to_name?: string,
//     qa: QaItem[],              // Q&A pairs จาก replay
//     total_messages: number,
//     processed_messages: number,
//     final_status: string,      // bot_answered | handed_off | no_agent | error
//     assigned_to?: string | null,
//     stopped_at_handoff: boolean,
//     mock_status: "open" | "closed",   // mock: ตอบครบ + 30 วิ → closed
//     // ── overall conversation rating (ใหม่) ──
//     conv_star_rating?: number,        // 0-5 ทั้งแชท
//     conv_rating?: "good" | "bad" | "unrated",
//     conv_comment?: string,
//     conv_rated_by?: string,
//     conv_rated_at?: Date,
//     // ── per-message ratings (embedded) ──
//     message_ratings?: Record<string, MessageRating>,  // key = message_id
//     created_at: Date,
//     updated_at: Date,
//   }
import { ObjectId } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "../lib/safety";

export interface QaItem {
  index: number;
  message_id: string;
  user_text: string;
  // rich media ของ user message (เหมือนฝั่งซ้าย)
  user_message_type?: string;
  user_media?: { type: string; url?: string; thumb_url?: string; duration?: number };
  user_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  user_order_sn?: string;
  user_notification_text?: string;
  user_table?: { headers?: string[]; rows?: string[][] };
  // ⚡ bundle_message — sub-messages หลายตัว
  user_bundle?: {
    message_type: string;
    text: string;
    media?: { type: string; url?: string; thumb_url?: string };
    product_ref?: { item_id: string };
    products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  }[];
  // bot reply
  trigger_name?: string;
  trigger_action?: string;
  bot_reply?: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed?: number;
  // ⚡ bot products (item cards ที่บอทแนะนำ)
  bot_products?: { item_id: string; name: string; price?: number; image?: string; url?: string }[];
  // ⚡ pipeline info — intent/rag/llm2/search counts
  bot_intent?: unknown;
  bot_retrieval_info?: unknown;
  bot_web_search_used?: boolean;
  bot_web_search_reason?: string;
  status: "bot_answered" | "trigger_matched" | "handed_off" | "no_agent" | "error";
  assigned_to?: string | null;
  detail: string;
}

export interface MessageRating {
  star_rating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  rated_by?: string;
  rated_at?: Date;
}

export interface TestAssignmentDoc {
  _id?: ObjectId;
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  shop_name?: string;
  to_name?: string;
  qa: QaItem[];
  total_messages: number;
  processed_messages: number;
  final_status: string;
  assigned_to?: string | null;
  stopped_at_handoff: boolean;
  mock_status: "open" | "closed";
  // overall conversation rating
  conv_star_rating?: number;
  conv_rating?: "good" | "bad" | "unrated";
  conv_comment?: string;
  conv_rated_by?: string;
  conv_rated_at?: Date;
  // ⚡ Phase 3B-2 — soft delete
  deleted_at?: Date;
  deleted_by?: string;
  delete_reason?: string;
  // per-message ratings
  message_ratings?: Record<string, MessageRating>;
  // ⚡ Phase 3A — ใครเป็นคนกด replay (KPI)
  replayed_by?: string;
  replayed_at?: Date;
  // ⚡ Phase 3B-7 — id กลุ่มรอบ replay (unique ต่อรอบ กด replay ซ้ำแชทเดิมแยกกัน)
  //   format: replay_<convId>_<ts36>_<rand>
  replay_batch_id?: string;
  created_at: Date;
  updated_at: Date;
}

// ⚡ Phase 3B-7 — สร้าง batch_id สำหรับรอบ replay หนึ่งรอบ (unique ไม่ชนกันแม้กดพร้อมกัน)
function genReplayBatchId(conversationId: string): string {
  const safeConv = conversationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "conv";
  return `replay_${safeConv}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Save replay result
 * ⚡ Phase 3B-4 — เดิม 1 doc/(conversation, admin) upsert
 * ⚡ Phase 3B-7 — เปลี่ยนเป็น insertOne (สร้าง doc ใหม่ทุกรอบ) + tag replay_batch_id
 *   ทำให้ replay ซ้ำแชทเดิม = ไม่ทับ แยก batch กัน
 *   คืน doc พร้อม replay_batch_id (แนบที่ doc.replay_batch_id + property batchId)
 */
export async function saveReplayResult(opts: {
  conversation_id: string;
  shop_id: string;
  platform: Platform;
  shop_name?: string;
  to_name?: string;
  qa: QaItem[];
  total_messages: number;
  processed_messages: number;
  final_status: string;
  assigned_to?: string | null;
  stopped_at_handoff: boolean;
  replayedBy?: string;  // ⚡ Phase 3A — ใครกด replay
}): Promise<TestAssignmentDoc | null> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const now = new Date();

  // mock_status: ถ้า bot ตอบครบทุกคำถาม (ไม่ handoff) → ถือว่า closed
  // ถ้า handoff → open (รอแอดมิน)
  const mockStatus: "open" | "closed" =
    opts.final_status === "bot_answered" && !opts.stopped_at_handoff ? "closed" : "open";

  // ⚡ Phase 3B-7 — สร้าง batch_id สำหรับรอบนี้
  const batchId = genReplayBatchId(opts.conversation_id);

  const doc: TestAssignmentDoc = {
    conversation_id: opts.conversation_id,
    shop_id: opts.shop_id,
    platform: opts.platform,
    shop_name: opts.shop_name,
    to_name: opts.to_name,
    qa: opts.qa,
    total_messages: opts.total_messages,
    processed_messages: opts.processed_messages,
    final_status: opts.final_status,
    assigned_to: opts.assigned_to ?? null,
    stopped_at_handoff: opts.stopped_at_handoff,
    mock_status: mockStatus,
    replayed_by: opts.replayedBy,
    replayed_at: now,
    replay_batch_id: batchId,  // ⚡ Phase 3B-7 — tag รอบ replay
    created_at: now,
    updated_at: now,
  };
  const result = await coll.insertOne(doc);
  // แนบ _id กลับเพื่อ return ครบ
  const inserted: TestAssignmentDoc = { ...doc, _id: result.insertedId };
  // แนบ batchId ผ่าน property ให้ caller ใช้
  (inserted as TestAssignmentDoc & { batchId?: string }).batchId = batchId;
  return inserted;
}

/**
 * Get one test assignment by conversation_id (+ optional replayed_by + replay_batch_id)
 * ⚡ Phase 3B-4 — ถ้าส่ง replayedBy จะกรองเฉพาะ doc ของ admin คนนั้น
 * ⚡ Phase 3B-7 — ถ้าส่ง replayBatchId จะกรองเฉพาะรอบนั้น ถ้าไม่ส่ง → คืนล่าสุด (sort created_at desc)
 */
export async function getTestAssignment(
  conversationId: string,
  replayedBy?: string,
  replayBatchId?: string
): Promise<TestAssignmentDoc | null> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = {
    conversation_id: conversationId,
    deleted_at: { $exists: false },
  };
  if (replayedBy) filter.replayed_by = replayedBy;
  if (replayBatchId) filter.replay_batch_id = replayBatchId;
  // ⚡ Phase 3B-7 — ถ้าไม่ระบุ batch → คืนล่าสุด (sort created_at desc)
  if (replayBatchId) {
    return coll.findOne(filter);
  }
  return coll.findOne(filter, { sort: { created_at: -1 } });
}

/**
 * List test assignments (recent first)
 */
export async function listTestAssignments(opts?: {
  platform?: Platform;
  finalStatus?: string;
  replayedBy?: string;  // ⚡ Phase 3A — กรองตามคนกด replay
  limit?: number;
}): Promise<TestAssignmentDoc[]> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = {};
  if (opts?.platform) filter.platform = opts.platform;
  if (opts?.finalStatus) filter.final_status = opts.finalStatus;
  if (opts?.replayedBy) filter.replayed_by = opts.replayedBy;
  const limit = opts?.limit || 500;
  return coll.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
}

/**
 * Rate a single message within a conversation
 * ⚡ Phase 3B-7 — ถ้าส่ง replayBatchId จะกรองเฉพาะรอบนั้น ถ้าไม่ส่ง → อัปเดตล่าสุด
 */
export async function rateMessage(opts: {
  conversationId: string;
  messageId: string;
  starRating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  ratedBy: string;
  replayedBy?: string;  // ⚡ Phase 3B-4 — กรอง doc ของ admin คนนี้
  replayBatchId?: string;  // ⚡ Phase 3B-7 — กรองรอบ replay
}): Promise<boolean> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const now = new Date();
  const key = `message_ratings.${opts.messageId}`;
  const update: Record<string, unknown> = {
    [`${key}.rated_by`]: opts.ratedBy,
    [`${key}.rated_at`]: now,
    updated_at: now,
  };
  if (opts.starRating !== undefined) update[`${key}.star_rating`] = opts.starRating;
  if (opts.rating !== undefined) update[`${key}.rating`] = opts.rating;
  if (opts.comment !== undefined) update[`${key}.comment`] = opts.comment;

  // ⚡ Phase 3B-4 — filter ใช้ { conversation_id, replayed_by } แทน { conversation_id }
  // ⚡ Phase 3B-7 — เพิ่ม replay_batch_id ถ้าส่ง ถ้าไม่ส่ง → อัปเดตล่าสุด
  const filter: Record<string, unknown> = {
    conversation_id: opts.conversationId,
    deleted_at: { $exists: false },
  };
  if (opts.replayedBy) filter.replayed_by = opts.replayedBy;
  if (opts.replayBatchId) {
    filter.replay_batch_id = opts.replayBatchId;
  } else {
    // ไม่ระบุ batch → อัปเดตล่าสุด (sort + limit 1)
    const latest = await coll.findOne(filter, { sort: { created_at: -1 } });
    if (!latest) return false;
    filter.replay_batch_id = latest.replay_batch_id;
  }

  const result = await coll.updateOne(filter, { $set: update });
  return result.modifiedCount > 0;
}

/**
 * Rate the overall conversation (ใหม่ — ทั้งแชท)
 * ⚡ Phase 3B-7 — ถ้าส่ง replayBatchId จะกรองเฉพาะรอบนั้น ถ้าไม่ส่ง → อัปเดตล่าสุด
 */
export async function rateConversation(opts: {
  conversationId: string;
  starRating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  ratedBy: string;
  replayedBy?: string;  // ⚡ Phase 3B-4 — กรอง doc ของ admin คนนี้
  replayBatchId?: string;  // ⚡ Phase 3B-7 — กรองรอบ replay
}): Promise<boolean> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const now = new Date();
  const update: Record<string, unknown> = {
    conv_rated_by: opts.ratedBy,
    conv_rated_at: now,
    updated_at: now,
  };
  if (opts.starRating !== undefined) update.conv_star_rating = opts.starRating;
  if (opts.rating !== undefined) update.conv_rating = opts.rating;
  if (opts.comment !== undefined) update.conv_comment = opts.comment;

  // ⚡ Phase 3B-4 — filter ใช้ { conversation_id, replayed_by } แทน { conversation_id }
  // ⚡ Phase 3B-7 — เพิ่ม replay_batch_id ถ้าส่ง ถ้าไม่ส่ง → อัปเดตล่าสุด
  const filter: Record<string, unknown> = {
    conversation_id: opts.conversationId,
    deleted_at: { $exists: false },
  };
  if (opts.replayedBy) filter.replayed_by = opts.replayedBy;
  if (opts.replayBatchId) {
    filter.replay_batch_id = opts.replayBatchId;
  } else {
    const latest = await coll.findOne(filter, { sort: { created_at: -1 } });
    if (!latest) return false;
    filter.replay_batch_id = latest.replay_batch_id;
  }

  const result = await coll.updateOne(filter, { $set: update });
  return result.modifiedCount > 0;
}

/**
 * Stats — สรุปภาพรวม
 */
export async function getTestAssignmentStats(): Promise<{
  total: number;
  bot_answered: number;
  handed_off: number;
  no_agent: number;
  error: number;
  open: number;
  closed: number;
  conv_star_rated: number;
  conv_avg_star: number;
  conv_good: number;
  conv_bad: number;
  msg_star_rated: number;
  msg_avg_star: number;
  msg_good: number;
  msg_bad: number;
  // ⚡ message counts (all history)
  total_messages: number;
  total_bot_replies: number;
  total_handed_off: number;
  // ⚡ pipeline counts
  intent_count: number;
  rag_count: number;
  llm2_count: number;
  web_search_count: number;
}> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const docs = await coll.find({}).sort({ created_at: -1 }).limit(5000).toArray();
  const total = docs.length;
  let botAnswered = 0, handedOff = 0, noAgent = 0, errorCount = 0;
  let open = 0, closed = 0;
  let convStarRated = 0, convStarSum = 0, convGood = 0, convBad = 0;
  let msgStarRated = 0, msgStarSum = 0, msgGood = 0, msgBad = 0;
  // ⚡ message counts
  let totalMessages = 0, totalBotReplies = 0, totalHandedOff = 0;
  // ⚡ pipeline counts
  let intentCount = 0, ragCount = 0, llm2Count = 0, webSearchCount = 0;

  for (const d of docs) {
    if (d.final_status === "bot_answered") botAnswered++;
    else if (d.final_status === "handed_off") handedOff++;
    else if (d.final_status === "no_agent") noAgent++;
    else if (d.final_status === "error") errorCount++;

    if (d.mock_status === "open") open++;
    else if (d.mock_status === "closed") closed++;

    // ⚡ message counts — นับจาก qa array
    if (Array.isArray(d.qa)) {
      totalMessages += d.qa.length; // ข้อความที่ถามมา = จำนวน qa pairs
      for (const q of d.qa) {
        if (q.status === "bot_answered" || q.status === "trigger_matched") totalBotReplies++;
        else if (q.status === "handed_off" || q.status === "no_agent") totalHandedOff++;

        // ⚡ pipeline counts
        // intent = ทุกคำถามที่เข้า bot (Pass 1 รันทุกครั้ง)
        if (q.bot_intent || q.status === "bot_answered" || q.status === "trigger_matched") intentCount++;
        // rag = source มี product_store / knowledge_base / kb / item_tag
        const src = (q.bot_source || "").toLowerCase();
        if (src.includes("product_store") || src.includes("knowledge_base") || src.includes("kb") || src.includes("item_tag")) ragCount++;
        // llm2 = source มี general: (LLM2 ตอบคำถามทั่วไป)
        if (src.includes("general")) llm2Count++;
        // web search = bot_web_search_used หรือ source มี web_search
        if (q.bot_web_search_used || src.includes("web_search")) webSearchCount++;
      }
    }

    // conversation rating
    if (d.conv_star_rating != null && d.conv_star_rating > 0) {
      convStarRated++;
      convStarSum += d.conv_star_rating;
    }
    if (d.conv_rating === "good") convGood++;
    else if (d.conv_rating === "bad") convBad++;

    // per-message ratings
    if (d.message_ratings) {
      for (const mr of Object.values(d.message_ratings)) {
        if (mr.star_rating != null && mr.star_rating > 0) {
          msgStarRated++;
          msgStarSum += mr.star_rating;
        }
        if (mr.rating === "good") msgGood++;
        else if (mr.rating === "bad") msgBad++;
      }
    }
  }

  return {
    total,
    bot_answered: botAnswered,
    handed_off: handedOff,
    no_agent: noAgent,
    error: errorCount,
    open,
    closed,
    conv_star_rated: convStarRated,
    conv_avg_star: convStarRated > 0 ? Math.round((convStarSum / convStarRated) * 100) / 100 : 0,
    conv_good: convGood,
    conv_bad: convBad,
    msg_star_rated: msgStarRated,
    msg_avg_star: msgStarRated > 0 ? Math.round((msgStarSum / msgStarRated) * 100) / 100 : 0,
    msg_good: msgGood,
    msg_bad: msgBad,
    total_messages: totalMessages,
    total_bot_replies: totalBotReplies,
    total_handed_off: totalHandedOff,
    intent_count: intentCount,
    rag_count: ragCount,
    llm2_count: llm2Count,
    web_search_count: webSearchCount,
  };
}

export const testAssignmentService = {
  saveReplayResult,
  getTestAssignment,
  listTestAssignments,
  rateMessage,
  rateConversation,
  stats: getTestAssignmentStats,
  // ⚡ Phase 3B-2
  softDelete,
  restore,
  listDeleted,
  listHistoryByAdmin,
  // ⚡ Phase 3B-7
  listReplayBatches,
};

// ─────────────────────────────────────────────────────────────
// Phase 3B-2 — Soft delete + History
// ─────────────────────────────────────────────────────────────

/** Soft delete — mark replay result as deleted (กู้คืนได้)
 * ⚡ Phase 3B-7 — ถ้าส่ง replayBatchId จะลบเฉพาะรอบนั้น ถ้าไม่ส่ง → ลบล่าสุด
 */
export async function softDelete(opts: {
  conversationId: string;
  deletedBy: string;
  reason?: string;
  replayedBy?: string;  // ⚡ Phase 3B-4 — กรอง doc ของ admin คนนี้
  replayBatchId?: string;  // ⚡ Phase 3B-7 — กรองรอบ replay
}): Promise<boolean> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  // ⚡ Phase 3B-4 — filter ใช้ { conversation_id, replayed_by }
  const filter: Record<string, unknown> = { conversation_id: opts.conversationId };
  if (opts.replayedBy) filter.replayed_by = opts.replayedBy;
  if (opts.replayBatchId) {
    filter.replay_batch_id = opts.replayBatchId;
  } else {
    const latest = await coll.findOne(filter, { sort: { created_at: -1 } });
    if (!latest) return false;
    filter.replay_batch_id = latest.replay_batch_id;
  }
  const r = await coll.updateOne(
    filter,
    {
      $set: {
        deleted_at: new Date(),
        deleted_by: opts.deletedBy,
        delete_reason: opts.reason || "",
      },
    }
  );
  return r.modifiedCount > 0;
}

/** Restore — กู้คืนจาก soft delete
 * ⚡ Phase 3B-7 — ถ้าส่ง replayBatchId จะกู้เฉพาะรอบนั้น ถ้าไม่ส่ง → กู้ล่าสุดที่ถูกลบ
 */
export async function restore(
  conversationId: string,
  replayedBy?: string,  // ⚡ Phase 3B-4 — กรอง doc ของ admin คนนี้
  replayBatchId?: string  // ⚡ Phase 3B-7 — กรองรอบ replay
): Promise<boolean> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = {
    conversation_id: conversationId,
    deleted_at: { $exists: true },
  };
  if (replayedBy) filter.replayed_by = replayedBy;
  if (replayBatchId) {
    filter.replay_batch_id = replayBatchId;
  } else {
    const latest = await coll.findOne(filter, { sort: { deleted_at: -1 } });
    if (!latest) return false;
    filter.replay_batch_id = latest.replay_batch_id;
  }
  const r = await coll.updateOne(
    filter,
    {
      $unset: { deleted_at: "", deleted_by: "", delete_reason: "" },
    }
  );
  return r.modifiedCount > 0;
}

/** ดึงรายการที่ถูก soft delete */
export async function listDeleted(opts?: {
  adminId?: string;  // กรองตามคนลบ
  limit?: number;
}): Promise<TestAssignmentDoc[]> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = { deleted_at: { $exists: true } };
  if (opts?.adminId) filter.deleted_by = opts.adminId;
  const limit = opts?.limit || 500;
  return coll.find(filter).sort({ deleted_at: -1 }).limit(limit).toArray();
}

/** ดึงประวัติ replay ของ admin คนหนึ่ง (history tab)
 * ⚡ Phase 3B-7 — แชทหนึ่งอาจมีหลายรอบ → ดึงทั้งหมด เรียงล่าสุดก่อน
 *   (UI จะ group ตาม conversation_id และโชว์ batch selector ใน detail panel)
 */
export async function listHistoryByAdmin(opts: {
  adminId: string;
  limit?: number;
}): Promise<TestAssignmentDoc[]> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = {
    replayed_by: opts.adminId,
    deleted_at: { $exists: false },
  };
  const limit = opts?.limit || 500;
  return coll.find(filter).sort({ replayed_at: -1 }).limit(limit).toArray();
}

/**
 * ⚡ Phase 3B-7 — ดึงรายการ replay batches ของ conversation หนึ่ง
 *   ใช้สำหรับ batch selector ใน UI (เหมือน listGenerationBatches ของ shadow-bot)
 *   คืน: [{ replay_batch_id, created_at, count, final_status, replayed_by }] เรียงใหม่สุดก่อน
 */
export async function listReplayBatches(opts: {
  conversationId: string;
  replayedBy?: string;
}): Promise<Array<{
  replay_batch_id: string;
  conversation_id: string;
  created_at: Date;
  replayed_at?: Date;
  count: number;
  final_status: string;
  stopped_at_handoff: boolean;
  replayed_by?: string;
}>> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = {
    conversation_id: opts.conversationId,
    deleted_at: { $exists: false },
  };
  if (opts.replayedBy) filter.replayed_by = opts.replayedBy;
  const docs = await coll
    .find(filter, { projection: {
      replay_batch_id: 1, conversation_id: 1, created_at: 1, replayed_at: 1,
      processed_messages: 1, final_status: 1, stopped_at_handoff: 1, replayed_by: 1,
    } })
    .sort({ created_at: -1 })
    .limit(100)
    .toArray();
  return docs
    .filter((d) => d.replay_batch_id)
    .map((d) => ({
      replay_batch_id: d.replay_batch_id!,
      conversation_id: d.conversation_id,
      created_at: d.created_at,
      replayed_at: d.replayed_at,
      count: d.processed_messages ?? 0,
      final_status: d.final_status,
      stopped_at_handoff: d.stopped_at_handoff,
      replayed_by: d.replayed_by,
    }));
}
