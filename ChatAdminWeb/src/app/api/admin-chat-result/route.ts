// GET /api/admin-chat-result
//
// ⚡ Phase 3B-5 — ดูผลลัพธ์การให้คะแนน/คอมเมนต์/คำตอบบอท แยกตามแอดมิน
// dev เท่านั้น
//
// ⚡ Phase 3B-6 — เปลี่ยนเป็น chat layout แบบ shadow-bot
//   - list: conversations ที่มี rating/comment (group by conversation_id)
//   - detail: Q&A pairs ใน conversation นั้น (user_text + bot_reply + rating + comment)
//
// Query params:
//   admin_id=xxx       — กรองตามแอดมินคนนั้น (ถ้าไม่ส่ง → ทุกคน)
//   scope=test_assignment | shadow_bot | test_chat — กรองตามระบบ
//   from=ISO&to=ISO    — กรองตามช่วงเวลา
//   limit=500          — จำนวนสูงสุด
//   conversation_id=xxx — ดึงเฉพาะ conversation นั้น (สำหรับ detail panel)
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

interface ResultItem {
  scope: "test_assignment" | "shadow_bot" | "test_chat";
  admin_id: string;
  conversation_id: string;
  message_id?: string;
  user_text?: string;
  bot_reply?: string;
  bot_source?: string;
  star_rating?: number;
  rating?: string;
  comment?: string;
  rated_at?: Date;
  created_at?: Date;
  platform?: string;
  shop_name?: string;
  to_name?: string;
  // ⚡ Phase 3B-8 — batch id (test_assignment=replay_batch_id, shadow_bot=generation_batch_id)
  batch_id?: string;
}

export async function GET(req: NextRequest) {
  const r = await requirePageAccess(req, "admin-chat-result");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const adminId = url.searchParams.get("admin_id") || undefined;
  const scope = url.searchParams.get("scope") || undefined;
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "500", 10), 1), 5000);
  const convId = url.searchParams.get("conversation_id") || undefined;
  // ⚡ Phase 3B-8 — batch_id filter (สำหรับ detail panel — กรอง items ตาม batch)
  const batchId = url.searchParams.get("batch_id") || undefined;

  const dateFilter: Record<string, unknown> = {};
  if (from) dateFilter.$gte = new Date(from);
  if (to) dateFilter.$lte = new Date(to);

  const items: ResultItem[] = [];

  try {
    // ── 1. Test Assignment: message ratings + conversation ratings ──
    if (!scope || scope === "test_assignment") {
      const coll = await getCollection<{
        conversation_id: string; replayed_by?: string; platform?: string; shop_name?: string;
        to_name?: string;
        qa?: Array<{ message_id: string; user_text: string; bot_reply?: string; bot_source?: string }>;
        message_ratings?: Record<string, { star_rating?: number; rating?: string; comment?: string; rated_by?: string; rated_at?: Date }>;
        conv_star_rating?: number; conv_rating?: string; conv_comment?: string;
        conv_rated_by?: string; conv_rated_at?: Date;
        replayed_at?: Date; created_at?: Date;
        replay_batch_id?: string;  // ⚡ Phase 3B-8
      }>(COLLECTIONS.testAssignment);

      const taFilter: Record<string, unknown> = { deleted_at: { $exists: false } };
      if (convId) taFilter.conversation_id = convId;
      if (adminId) {
        taFilter.$or = [
          { replayed_by: adminId },
          { "message_ratings.rated_by": adminId },
          { conv_rated_by: adminId },
        ];
      }
      if (from || to) {
        taFilter.replayed_at = dateFilter;
      }

      const docs = await coll.find(taFilter).sort({ replayed_at: -1 }).limit(limit).toArray();

      for (const d of docs) {
        // ⚡ Phase 3B-6 — iterate ผ่าน qa[] ทั้งหมด (ไม่ใช่แค่ message_ratings)
        //   ถ้ายังไม่ได้ rate → push item พร้อม rating="unrated"
        //   ถ้า rate แล้ว → push item พร้อม rating info
        if (d.qa && d.qa.length > 0) {
          for (const qaItem of d.qa) {
            const mr = d.message_ratings?.[qaItem.message_id];
            // ถ้ามี adminId filter และ item นี้ rated โดยคนอื่น → ข้าม
            // แต่ถ้ายังไม่ได้ rate → เช็คด้วย replayed_by
            if (adminId && mr && mr.rated_by !== adminId) continue;
            if (adminId && !mr && d.replayed_by !== adminId) continue;
            items.push({
              scope: "test_assignment",
              admin_id: mr?.rated_by || d.replayed_by || "",
              conversation_id: d.conversation_id,
              message_id: qaItem.message_id,
              user_text: qaItem.user_text,
              bot_reply: qaItem.bot_reply,
              bot_source: qaItem.bot_source,
              star_rating: mr?.star_rating,
              rating: mr?.rating || "unrated",
              comment: mr?.comment,
              rated_at: mr?.rated_at,
              created_at: d.replayed_at || d.created_at,
              platform: d.platform,
              shop_name: d.shop_name,
              to_name: d.to_name,
              batch_id: d.replay_batch_id,  // ⚡ Phase 3B-8
            });
          }
        } else if (d.message_ratings) {
          // fallback: ถ้าไม่มี qa[] แต่มี message_ratings → ใช้แบบเดิม
          for (const [msgId, mr] of Object.entries(d.message_ratings)) {
            if (adminId && mr.rated_by !== adminId) continue;
            items.push({
              scope: "test_assignment",
              admin_id: mr.rated_by || d.replayed_by || "",
              conversation_id: d.conversation_id,
              message_id: msgId,
              star_rating: mr.star_rating,
              rating: mr.rating,
              comment: mr.comment,
              rated_at: mr.rated_at,
              platform: d.platform,
              shop_name: d.shop_name,
              to_name: d.to_name,
              batch_id: d.replay_batch_id,  // ⚡ Phase 3B-8
            });
          }
        }
        if (d.conv_rated_by && (!adminId || d.conv_rated_by === adminId)) {
          items.push({
            scope: "test_assignment",
            admin_id: d.conv_rated_by,
            conversation_id: d.conversation_id,
            star_rating: d.conv_star_rating,
            rating: d.conv_rating,
            comment: d.conv_comment,
            rated_at: d.conv_rated_at,
            platform: d.platform,
            shop_name: d.shop_name,
            to_name: d.to_name,
            batch_id: d.replay_batch_id,  // ⚡ Phase 3B-8
          });
        }
      }
    }

    // ── 2. Shadow Bot: shadow_replies ratings ──
    if (!scope || scope === "shadow_bot") {
      const coll = await getCollection<{
        shadow_reply_id: string; conversation_id: string; generated_by?: string;
        platform?: string; shop_id?: string; inbound_text?: string; bot_reply_text?: string;
        bot_source?: string; rating?: string; star_rating?: number; comment?: string;
        rated_by?: string; rated_at?: Date; origin?: string; created_at?: Date;
        deleted_at?: Date;
        generation_batch_id?: string;  // ⚡ Phase 3B-8
      }>(COLLECTIONS.shadowReplies);

      const shFilter: Record<string, unknown> = {
        deleted_at: { $exists: false },
        origin: { $in: ["manual", "manual_conversation"] },
      };
      if (convId) shFilter.conversation_id = convId;
      if (adminId) {
        shFilter.$or = [
          { generated_by: adminId },
          { rated_by: adminId },
        ];
      }
      if (from || to) {
        shFilter.created_at = dateFilter;
      }

      const docs = await coll.find(shFilter).sort({ created_at: -1 }).limit(limit).toArray();

      // ⚡ ดึง shop_name + to_name จาก conversations collection (match ด้วย conversation_id)
      const convIds = [...new Set(docs.map((d) => d.conversation_id).filter(Boolean))] as string[];
      let convInfoMap = new Map<string, { shop_name?: string; to_name?: string }>();
      if (convIds.length > 0) {
        const convColl = await getCollection<{ shop_id: string; shop_name?: string; conversation_id: string; to_name?: string }>(COLLECTIONS.conversations);
        const convs = await convColl.find({ conversation_id: { $in: convIds } }).project({ shop_id: 1, shop_name: 1, conversation_id: 1, to_name: 1 }).toArray();
        convInfoMap = new Map(
          convs.map((c) => [c.conversation_id, { shop_name: c.shop_name, to_name: c.to_name }])
        );
      }

      for (const d of docs) {
        const convInfo = convInfoMap.get(d.conversation_id);
        items.push({
          scope: "shadow_bot",
          admin_id: d.rated_by || d.generated_by || "",
          conversation_id: d.conversation_id,
          message_id: d.shadow_reply_id,
          user_text: d.inbound_text,
          bot_reply: d.bot_reply_text,
          bot_source: d.bot_source,
          star_rating: d.star_rating,
          rating: d.rating,
          comment: d.comment,
          rated_at: d.rated_at,
          created_at: d.created_at,
          platform: d.platform,
          shop_name: convInfo?.shop_name,
          to_name: convInfo?.to_name,
          batch_id: d.generation_batch_id,  // ⚡ Phase 3B-8
        });
      }
    }

    // ── 3. Test Chat: test_chat_ratings ──
    if (!scope || scope === "test_chat") {
      const coll = await getCollection<{
        session_id: string; platform?: string; msg_index: number;
        user_message?: string; bot_answer?: string; bot_source?: string;
        star_rating?: number; rating?: string; comment?: string;
        rated_by?: string; rated_at?: Date;
      }>(COLLECTIONS.testChatRatings);

      const tcFilter: Record<string, unknown> = {};
      if (convId) tcFilter.session_id = convId;
      if (adminId) tcFilter.rated_by = adminId;
      if (from || to) tcFilter.rated_at = dateFilter;

      const docs = await coll.find(tcFilter).sort({ rated_at: -1 }).limit(limit).toArray();

      for (const d of docs) {
        items.push({
          scope: "test_chat",
          admin_id: d.rated_by || "",
          conversation_id: d.session_id,
          message_id: `msg_${d.msg_index}`,
          user_text: d.user_message,
          bot_reply: d.bot_answer,
          bot_source: d.bot_source,
          star_rating: d.star_rating,
          rating: d.rating,
          comment: d.comment,
          rated_at: d.rated_at,
          platform: d.platform,
        });
      }
    }

    // ── sort by rated_at desc (fallback created_at) ──
    items.sort((a, b) => {
      const da = a.rated_at || a.created_at || new Date(0);
      const db = b.rated_at || b.created_at || new Date(0);
      return db.getTime() - da.getTime();
    });

    // ⚡ Phase 3B-8 — ถ้ามี batch_id → กรอง items ตาม batch ก่อน
    const filteredItems = batchId
      ? items.filter((it) => it.batch_id === batchId)
      : items;

    // ⚡ Phase 3B-6 — ถ้ามี conversation_id → ส่ง detail (Q&A pairs) กลับไป
    if (convId) {
      return json({
        conversation_id: convId,
        items: filteredItems.map((it) => ({
          ...it,
          rated_at: it.rated_at ? new Date(it.rated_at).toISOString() : undefined,
          created_at: it.created_at ? new Date(it.created_at).toISOString() : undefined,
        })),
      });
    }

    // ⚡ Phase 3B-6 — group by conversation_id → list สำหรับ panel ซ้าย
    // ⚡ Phase 3B-8 — เปลี่ยน group key เป็น scope-conversation_id-admin_id-batch_id
    //   ทำให้ 4 admins × 2 batches = 8 rows แยกกัน (standalone)
    const convMap = new Map<string, {
      conversation_id: string;
      scope: string;
      admin_id: string;
      platform?: string;
      shop_name?: string;
      to_name?: string;
      batch_id?: string;
      total: number;
      rated: number;
      commented: number;
      good: number;
      bad: number;
      starSum: number;
      starCount: number;
      last_rated_at?: Date;
    }>();

    for (const it of filteredItems) {
      // ⚡ Phase 3B-8 — group key รวม admin_id + batch_id (ถ้าไม่มี batch_id → ใช้ค่าว่าง)
      const key = `${it.scope}-${it.conversation_id}-${it.admin_id}-${it.batch_id || ""}`;
      const existing = convMap.get(key) || {
        conversation_id: it.conversation_id,
        scope: it.scope,
        admin_id: it.admin_id,
        platform: it.platform,
        shop_name: it.shop_name,
        to_name: it.to_name,
        batch_id: it.batch_id,
        total: 0,
        rated: 0,
        commented: 0,
        good: 0,
        bad: 0,
        starSum: 0,
        starCount: 0,
      };
      existing.total++;
      if (it.rating && it.rating !== "unrated") {
        existing.rated++;
        if (it.rating === "good") existing.good++;
        if (it.rating === "bad") existing.bad++;
      }
      if (it.comment && it.comment.trim()) existing.commented++;
      if (it.star_rating && it.star_rating > 0) {
        existing.starSum += it.star_rating;
        existing.starCount++;
      }
      const ts = it.rated_at || it.created_at;
      if (ts && (!existing.last_rated_at || ts > existing.last_rated_at)) {
        existing.last_rated_at = ts;
      }
      convMap.set(key, existing);
    }

    const conversations = [...convMap.values()]
      .sort((a, b) => (b.last_rated_at || new Date(0)).getTime() - (a.last_rated_at || new Date(0)).getTime())
      .slice(0, limit)
      .map((c) => ({
        ...c,
        last_rated_at: c.last_rated_at ? new Date(c.last_rated_at).toISOString() : undefined,
      }));

    return json({ conversations, total: conversations.length });
  } catch (err) {
    return error(err instanceof Error ? err.message : "failed", 500);
  }
}
