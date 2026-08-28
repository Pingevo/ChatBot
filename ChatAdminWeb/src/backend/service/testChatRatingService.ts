// testChatRatingService — เก็บคะแนน/คอมเมนต์/ดาว ของ test chat messages
// ฝั่ง Next.js (admin mongo) — ไม่ยุ่งกับ Python
//
// Collection: test_chat_ratings
// Document shape:
//   {
//     _id: ObjectId,
//     session_id: string,        // test chat session id (จาก Python)
//     msg_index: number,         // index ใน messages array
//     platform: "shopee" | "tiktok" | "lazada",
//     shop: string,
//     star_rating?: number,      // 0-5
//     rating?: "good" | "bad" | "unrated",   // ⚡ เปลี่ยนเป็น good/bad
//     comment?: string,
//     msg_text_preview?: string, // 200 ตัวแรกของคำตอบ (เผื่อแสดงใน list)
//     msg_stats?: {              // snapshot ของ stats ตอน rate (เก็บประวัติ)
//       elapsed?: number;
//       cost?: number;
//       tokens_total?: number;
//       tokens_prompt?: number;
//       tokens_output?: number;
//       model?: string;
//       source?: string;
//       intent?: string;
//       web_search_used?: boolean;
//       handoff_to_admin?: boolean;
//     },
//     rated_by: string,          // admin_id
//     rated_at: Date,
//     updated_at: Date,
//   }
import { ObjectId } from "mongodb";
import { getCollection, getDb } from "@/backend/db/mongoClient";
import { COLLECTIONS } from "@/backend/db/mongoClient";
import type { Platform } from "@/lib/types";

export interface TestChatRatingDoc {
  _id?: ObjectId;
  session_id: string;
  msg_index: number;
  platform: Platform;
  shop: string;
  star_rating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  msg_text_preview?: string;
  msg_stats?: {
    elapsed?: number;
    cost?: number;
    tokens_total?: number;
    tokens_prompt?: number;
    tokens_output?: number;
    model?: string;
    source?: string;
    intent?: string;
    web_search_used?: boolean;
    handoff_to_admin?: boolean;
  };
  rated_by: string;
  rated_at: Date;
  updated_at: Date;
}

/**
 * Rate (หรืออัปเดต rating ของ) test chat message
 * upsert โดย (session_id, msg_index)
 */
export async function rateTestChatMessage(opts: {
  sessionId: string;
  msgIndex: number;
  platform: Platform;
  shop: string;
  starRating?: number;
  rating?: "good" | "bad" | "unrated";
  comment?: string;
  msgTextPreview?: string;
  msgStats?: TestChatRatingDoc["msg_stats"];
  ratedBy: string;
}): Promise<boolean> {
  const coll = await getCollection<TestChatRatingDoc>(COLLECTIONS.testChatRatings);
  const now = new Date();
  const update: Record<string, unknown> = { updated_at: now };
  if (opts.starRating !== undefined) update.star_rating = opts.starRating;
  if (opts.rating !== undefined) update.rating = opts.rating;
  if (opts.comment !== undefined) update.comment = opts.comment;
  if (opts.msgTextPreview !== undefined) update.msg_text_preview = opts.msgTextPreview;
  if (opts.msgStats !== undefined) update.msg_stats = opts.msgStats;

  const result = await coll.updateOne(
    { session_id: opts.sessionId, msg_index: opts.msgIndex },
    {
      $set: update,
      $setOnInsert: {
        platform: opts.platform,
        shop: opts.shop,
        rated_by: opts.ratedBy,
        rated_at: now,
      },
    },
    { upsert: true }
  );
  return result.upsertedCount > 0 || result.modifiedCount > 0;
}

/**
 * ดึง rating ของ session เดียว
 */
export async function getRatingsForSession(sessionId: string): Promise<TestChatRatingDoc[]> {
  const coll = await getCollection<TestChatRatingDoc>(COLLECTIONS.testChatRatings);
  return coll.find({ session_id: sessionId }).sort({ msg_index: 1 }).toArray();
}

/**
 * ดึง rating ทั้งหมด (ทุก session) — สำหรับ All Sessions stats
 */
export async function getAllRatings(): Promise<TestChatRatingDoc[]> {
  const coll = await getCollection<TestChatRatingDoc>(COLLECTIONS.testChatRatings);
  return coll.find({}).sort({ rated_at: -1 }).limit(5000).toArray();
}

/**
 * สถิติรวม — คำนวณฝั่ง Next.js จาก test_chat_ratings collection
 *
 * คืน:
 *   - จำนวนคำตอบทั้งหมด (จาก rating docs)
 *   - จำนวนที่ดี (good) / ไม่ดี (bad) / ยังไม่ให้คะแนน (unrated หรือไม่มี rating field)
 *   - ดาวเฉลี่ย + จำนวนที่ให้ดาว
 *   - จำนวนที่โดนคอมเมนต์
 *   - ราคารวม + เฉลี่ย (จาก msg_stats.cost)
 *   - token รวม + เฉลี่ย (จาก msg_stats.tokens_total)
 *   - เวลาเฉลี่ย (จาก msg_stats.elapsed)
 *   - จำนวนที่ใช้ intent / rag / llm2 / search (จาก msg_stats)
 */
export async function getTestChatRatingStats(): Promise<{
  total_ratings: number;
  good: number;
  bad: number;
  unrated: number;
  star_rated: number;
  avg_star: number;
  commented: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  total_tokens: number;
  avg_tokens: number;
  avg_elapsed: number;
  intent_calls: number;
  web_search_calls: number;
  handoff_count: number;
}> {
  const docs = await getAllRatings();
  const total = docs.length;
  let good = 0, bad = 0, unrated = 0;
  let starRated = 0, starSum = 0;
  let commented = 0;
  let totalCost = 0, totalTokens = 0, totalElapsed = 0;
  let intentCalls = 0, webSearchCalls = 0, handoffCount = 0;

  for (const d of docs) {
    if (d.rating === "good") good++;
    else if (d.rating === "bad") bad++;
    else unrated++;

    if (d.star_rating != null && d.star_rating > 0) {
      starRated++;
      starSum += d.star_rating;
    }
    if (d.comment && d.comment.trim()) commented++;

    const s = d.msg_stats || {};
    totalCost += s.cost || 0;
    totalTokens += s.tokens_total || 0;
    totalElapsed += s.elapsed || 0;
    if (s.intent) intentCalls++;
    if (s.web_search_used) webSearchCalls++;
    if (s.handoff_to_admin) handoffCount++;
  }

  return {
    total_ratings: total,
    good,
    bad,
    unrated,
    star_rated: starRated,
    avg_star: starRated > 0 ? Math.round((starSum / starRated) * 100) / 100 : 0,
    commented,
    total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
    avg_cost_usd: total > 0 ? Math.round((totalCost / total) * 1e6) / 1e6 : 0,
    total_tokens: totalTokens,
    avg_tokens: total > 0 ? Math.round(totalTokens / total) : 0,
    avg_elapsed: total > 0 ? Math.round((totalElapsed / total) * 100) / 100 : 0,
    intent_calls: intentCalls,
    web_search_calls: webSearchCalls,
    handoff_count: handoffCount,
  };
}

export const testChatRatingService = {
  rate: rateTestChatMessage,
  listBySession: getRatingsForSession,
  listAll: getAllRatings,
  stats: getTestChatRatingStats,
};
