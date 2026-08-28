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
  // bot reply
  trigger_name?: string;
  trigger_action?: string;
  bot_reply?: string;
  bot_source?: string;
  bot_model?: string;
  bot_elapsed?: number;
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
  // per-message ratings
  message_ratings?: Record<string, MessageRating>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Save replay result (upsert by conversation_id)
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
}): Promise<TestAssignmentDoc | null> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const now = new Date();

  // mock_status: ถ้า bot ตอบครบทุกคำถาม (ไม่ handoff) → ถือว่า closed
  // ถ้า handoff → open (รอแอดมิน)
  const mockStatus: "open" | "closed" =
    opts.final_status === "bot_answered" && !opts.stopped_at_handoff ? "closed" : "open";

  const result = await coll.findOneAndUpdate(
    { conversation_id: opts.conversation_id },
    {
      $set: {
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
        updated_at: now,
      },
      $setOnInsert: {
        conversation_id: opts.conversation_id,
        created_at: now,
      },
    },
    { returnDocument: "after", upsert: true }
  );
  return result || null;
}

/**
 * Get one test assignment by conversation_id
 */
export async function getTestAssignment(conversationId: string): Promise<TestAssignmentDoc | null> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  return coll.findOne({ conversation_id: conversationId });
}

/**
 * List test assignments (recent first)
 */
export async function listTestAssignments(opts?: {
  platform?: Platform;
  finalStatus?: string;
  limit?: number;
}): Promise<TestAssignmentDoc[]> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const filter: Record<string, unknown> = {};
  if (opts?.platform) filter.platform = opts.platform;
  if (opts?.finalStatus) filter.final_status = opts.finalStatus;
  const limit = opts?.limit || 500;
  return coll.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
}

/**
 * Rate a single message within a conversation
 */
export async function rateMessage(opts: {
  conversationId: string;
  messageId: string;
  starRating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  ratedBy: string;
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

  const result = await coll.updateOne(
    { conversation_id: opts.conversationId },
    { $set: update }
  );
  return result.modifiedCount > 0;
}

/**
 * Rate the overall conversation (ใหม่ — ทั้งแชท)
 */
export async function rateConversation(opts: {
  conversationId: string;
  starRating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  ratedBy: string;
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

  const result = await coll.updateOne(
    { conversation_id: opts.conversationId },
    { $set: update }
  );
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
}> {
  const coll = await getCollection<TestAssignmentDoc>(COLLECTIONS.testAssignment);
  const docs = await coll.find({}).sort({ created_at: -1 }).limit(5000).toArray();
  const total = docs.length;
  let botAnswered = 0, handedOff = 0, noAgent = 0, errorCount = 0;
  let open = 0, closed = 0;
  let convStarRated = 0, convStarSum = 0, convGood = 0, convBad = 0;
  let msgStarRated = 0, msgStarSum = 0, msgGood = 0, msgBad = 0;

  for (const d of docs) {
    if (d.final_status === "bot_answered") botAnswered++;
    else if (d.final_status === "handed_off") handedOff++;
    else if (d.final_status === "no_agent") noAgent++;
    else if (d.final_status === "error") errorCount++;

    if (d.mock_status === "open") open++;
    else if (d.mock_status === "closed") closed++;

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
  };
}

export const testAssignmentService = {
  saveReplayResult,
  getTestAssignment,
  listTestAssignments,
  rateMessage,
  rateConversation,
  stats: getTestAssignmentStats,
};
