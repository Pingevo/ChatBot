// GET /api/test-chat-result
//
// ⚡ Phase 3B-6 — ดูผลลัพธ์ test chat session ของแอดมินแต่ละคน
// dev เท่านั้น — ดูว่าใครถามอะไร บอทตอบยังไง รีวิว/คอมเมนต์อะไร
//
// Query params:
//   admin_id=xxx        — กรองตามแอดมิน (ถ้าไม่ส่ง → ทุกคน)
//   from=ISO&to=ISO     — กรองตามช่วงเวลา (updated_at)
//   limit=500           — จำนวนสูงสุด
//   session_id=xxx      — ดึงเฉพาะ session นั้น (สำหรับ detail panel)
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

interface SessionMessage {
  role: string;
  text: string;
  timestamp?: string;
  stats?: Record<string, unknown>;
  images?: string[];
}

interface SessionListItem {
  session_id: string;
  shop: string;
  title: string;
  admin_id: string;
  admin_name: string;
  message_count: number;
  created_at?: string;
  updated_at?: string;
  // aggregated ratings
  total_rated: number;
  good: number;
  bad: number;
  commented: number;
  star_sum: number;
  star_count: number;
  last_rated_at?: string;
}

interface SessionDetail {
  session_id: string;
  shop: string;
  title: string;
  admin_id: string;
  admin_name: string;
  created_at?: string;
  updated_at?: string;
  messages: SessionMessage[];
  ratings: Array<{
    msg_index: number;
    star_rating?: number;
    rating?: string;
    comment?: string;
    rated_by?: string;
    rated_at?: string;
  }>;
}

export async function GET(req: NextRequest) {
  const r = await requirePageAccess(req, "test-chat-result");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const adminId = url.searchParams.get("admin_id") || undefined;
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "500", 10), 1), 5000);
  const sessionId = url.searchParams.get("session_id") || undefined;

  const dateFilter: Record<string, unknown> = {};
  if (from) dateFilter.$gte = new Date(from);
  if (to) dateFilter.$lte = new Date(to);

  try {
    // ── detail mode: ดึง session เดียว + ratings ──
    if (sessionId) {
      const { ObjectId } = await import("mongodb");
      const coll = await getCollection<{
        _id: typeof ObjectId.prototype;
        shop?: string;
        title?: string;
        admin_id?: string;
        admin_name?: string;
        created_at?: Date;
        updated_at?: Date;
        messages?: SessionMessage[];
      }>(COLLECTIONS.testChatSessions);

      const doc = await coll.findOne({ _id: new ObjectId(sessionId) as never });
      if (!doc) return error("session not found", 404);

      // ดึง ratings ของ session นี้
      const rateColl = await getCollection<{
        session_id: string;
        msg_index: number;
        star_rating?: number;
        rating?: string;
        comment?: string;
        rated_by?: string;
        rated_at?: Date;
      }>(COLLECTIONS.testChatRatings);

      const ratings = await rateColl
        .find({ session_id: sessionId })
        .sort({ msg_index: 1 })
        .toArray();

      const detail: SessionDetail = {
        session_id: sessionId,
        shop: doc.shop || "",
        title: doc.title || "ไม่มีชื่อ",
        admin_id: doc.admin_id || "",
        admin_name: doc.admin_name || "",
        created_at: doc.created_at ? new Date(doc.created_at).toISOString() : undefined,
        updated_at: doc.updated_at ? new Date(doc.updated_at).toISOString() : undefined,
        messages: doc.messages || [],
        ratings: ratings.map((rt) => ({
          msg_index: rt.msg_index,
          star_rating: rt.star_rating,
          rating: rt.rating,
          comment: rt.comment,
          rated_by: rt.rated_by,
          rated_at: rt.rated_at ? new Date(rt.rated_at).toISOString() : undefined,
        })),
      };

      return json(detail);
    }

    // ── list mode: ดึง sessions + aggregate ratings ──
    const { ObjectId: _ObjectId } = await import("mongodb");
    const coll = await getCollection<{
      _id: typeof _ObjectId.prototype;
      shop?: string;
      title?: string;
      admin_id?: string;
      admin_name?: string;
      messages?: unknown[];
      created_at?: Date;
      updated_at?: Date;
    }>(COLLECTIONS.testChatSessions);

    const filter: Record<string, unknown> = {};
    if (adminId) {
      filter.$or = [
        { admin_id: adminId },
        // legacy sessions (no admin_id) — ยังเห็น
        { admin_id: { $exists: false } },
        { admin_id: null },
        { admin_id: "" },
      ];
    }
    if (from || to) {
      filter.updated_at = dateFilter;
    }

    const docs = await coll
      .find(filter)
      .sort({ updated_at: -1 })
      .limit(limit)
      .toArray();

    if (docs.length === 0) {
      return json({ sessions: [], total: 0 });
    }

    // ดึง ratings ทั้งหมดของ sessions ที่ดึงมา
    const sessionIds = docs.map((d) => String(d._id));
    const rateColl = await getCollection<{
      session_id: string;
      msg_index: number;
      star_rating?: number;
      rating?: string;
      comment?: string;
      rated_by?: string;
      rated_at?: Date;
    }>(COLLECTIONS.testChatRatings);

    const allRatings = await rateColl
      .find({ session_id: { $in: sessionIds } })
      .toArray();

    // group ratings by session_id
    const ratingsBySession = new Map<string, typeof allRatings>();
    for (const rt of allRatings) {
      const arr = ratingsBySession.get(rt.session_id) || [];
      arr.push(rt);
      ratingsBySession.set(rt.session_id, arr);
    }

    const sessions: SessionListItem[] = docs.map((d) => {
      const sid = String(d._id);
      const ratings = ratingsBySession.get(sid) || [];
      let good = 0, bad = 0, commented = 0, starSum = 0, starCount = 0;
      let lastRatedAt: Date | undefined;
      for (const rt of ratings) {
        if (rt.rating === "good") good++;
        if (rt.rating === "bad") bad++;
        if (rt.comment && rt.comment.trim()) commented++;
        if (rt.star_rating && rt.star_rating > 0) {
          starSum += rt.star_rating;
          starCount++;
        }
        if (rt.rated_at && (!lastRatedAt || rt.rated_at > lastRatedAt)) {
          lastRatedAt = rt.rated_at;
        }
      }
      return {
        session_id: sid,
        shop: d.shop || "",
        title: d.title || "ไม่มีชื่อ",
        admin_id: d.admin_id || "",
        admin_name: d.admin_name || "",
        message_count: d.messages?.length || 0,
        created_at: d.created_at ? new Date(d.created_at).toISOString() : undefined,
        updated_at: d.updated_at ? new Date(d.updated_at).toISOString() : undefined,
        total_rated: ratings.length,
        good,
        bad,
        commented,
        star_sum: starSum,
        star_count: starCount,
        last_rated_at: lastRatedAt ? new Date(lastRatedAt).toISOString() : undefined,
      };
    });

    return json({ sessions, total: sessions.length });
  } catch (err) {
    return error(err instanceof Error ? err.message : "failed", 500);
  }
}
