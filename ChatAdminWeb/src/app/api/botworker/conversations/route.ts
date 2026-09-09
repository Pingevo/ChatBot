// GET /api/botworker/conversations — list conversations สำหรับหน้า /botworker
// เหมือน /admin/conversations แต่อ่าน status/assigned_to จาก test_status_conversation source="botworker"
// ทำให้ /botworker UI เห็น status ที่ botworker เขียน โดยไม่กระทบ /tickets
//
// ⛔ IRON RULE: ห้ามส่งข้อความจริง ห้ามเรียก platform API
// ⚡ force-dynamic — กัน Next.js cache
// ⚡ G-fix — เพิ่ม in-memory cache แบบ short-lived กัน poll รัวๆ ทำให้หน้าล็อค
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { conversationService } from "@/backend/service/conversationService";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import type { Conversation } from "@/lib/types";
import type { ConversationDoc } from "@/backend/service/conversationService";
import type { Platform, ConversationStatus } from "@/backend/service/conversationService";

// ⚡ G-fix — in-memory cache (เหมือน /admin/conversations) ลด query ซ้ำจาก polling
let bwCache: { key: string; data: Conversation[]; totalCount: number; hasMore: boolean; cursor: string | null; ts: number } | null = null;
const BW_CACHE_TTL = 2500; // ⚡ 2.5 วิ — สั้นกว่า poll interval (3s) เล็กน้อย

/** Invalidate botworker cache — เรียกจาก close/reopen/handoff/assign route */
export function invalidateBotworkerCache() {
  bwCache = null;
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = (url.searchParams.get("platform") || undefined) as Platform | undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;
  // ⚡ รองรับทั้ง search และ q (เพื่อให้ตรงกับ /admin/conversations)
  const search = url.searchParams.get("search") || url.searchParams.get("q") || undefined;
  const cursorParam = url.searchParams.get("cursor") || undefined;
  const includeCount = url.searchParams.get("include_count") === "true";
  const limitParam = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.min(Math.max(limitParam, 1), 5000);

  // ⚡ parse cursor (timestamp|conversation_id — เหมือน /admin/conversations)
  let parsedCursor: { ts: Date; id: string } | undefined;
  if (cursorParam) {
    const sepIdx = cursorParam.indexOf("|");
    if (sepIdx > 0) {
      const tsStr = cursorParam.substring(0, sepIdx);
      const idStr = cursorParam.substring(sepIdx + 1);
      const ts = new Date(tsStr);
      if (!isNaN(ts.getTime()) && idStr) parsedCursor = { ts, id: idStr };
    }
  }

  // ⚡ G-fix — เช็ค cache ก่อน query DB (เฉพาะ head — ไม่ cache tail)
  const cacheKey = `${platform || ""}|${shopId || ""}|${search || ""}|${limit}|${cursorParam || ""}`;
  const now = Date.now();
  if (bwCache && bwCache.key === cacheKey && now - bwCache.ts < BW_CACHE_TTL) {
    if (includeCount) {
      return json({ rows: bwCache.data, total_count: bwCache.totalCount ?? bwCache.data.length, has_more: bwCache.hasMore ?? false, cursor: bwCache.cursor ?? null });
    }
    return json({ rows: bwCache.data, total_count: bwCache.totalCount ?? bwCache.data.length });
  }

  // ดึง conversations จาก conversations collection (เหมือน /admin/conversations)
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const filter: Record<string, unknown> = {};
  if (platform) filter.platform = platform;
  if (shopId) filter.shop_id = shopId;
  // ⚡ cursor filter — ดึงแชทที่เก่ากว่า cursor
  if (parsedCursor) {
    filter.$or = [
      { last_message_timestamp: { $lt: parsedCursor.ts } },
      { last_message_timestamp: parsedCursor.ts, conversation_id: { $lt: parsedCursor.id } },
    ];
  }
  if (search) {
    // 🔒 escape regex metacharacters ป้องกัน $regex injection / ReDoS
    const { safeRegexSearch } = await import("@/backend/lib/regexEscape");
    const safe = safeRegexSearch(search);
    if (safe) {
      if (filter.$or) {
        // มี cursor $or อยู่แล้ว → ใช้ $and รวม search $or
        filter.$and = [
          { $or: filter.$or },
          { $or: [
            { to_name: { $regex: safe, $options: "i" } },
            { last_message_text: { $regex: safe, $options: "i" } },
            { shop_name: { $regex: safe, $options: "i" } },
          ]},
        ];
        delete filter.$or;
      } else {
        filter.$or = [
          { to_name: { $regex: safe, $options: "i" } },
          { last_message_text: { $regex: safe, $options: "i" } },
          { shop_name: { $regex: safe, $options: "i" } },
        ];
      }
    }
  }

  const docs = await coll
    .find(filter, { maxTimeMS: 5000 })
    .sort({ last_message_timestamp: -1, conversation_id: -1 })
    .limit(limit)
    .toArray();

  // dedupe
  const seen = new Set<string>();
  const deduped = docs.filter((d) => {
    if (seen.has(d.conversation_id)) return false;
    seen.add(d.conversation_id);
    return true;
  });

  // ⚡ Phase 2V — อ่าน status/assigned_to จาก test_status_conversation source="botworker"
  const convIds = deduped.map((d) => d.conversation_id);
  const metaMap = await testStatusConversationService.getTestStatusMap(convIds, "botworker");

  // map เป็น Conversation shape
  const conversations: Conversation[] = deduped.map((doc) => {
    const meta = metaMap.get(doc.conversation_id);
    const effectiveAssignedTo = meta?.assigned_to || null;
    let derivedStatus: Conversation["status"];
    if (meta?.status) {
      derivedStatus = meta.status as Conversation["status"];
    } else if (doc.closed_at) {
      derivedStatus = "closed";
    } else if (effectiveAssignedTo) {
      derivedStatus = "handoff";
    } else {
      derivedStatus = "bot";
    }
    return {
      id: doc.conversation_id,
      platform: doc.platform,
      shop_id: doc.shop_id,
      shop_name: doc.shop_name,
      customer_id: doc.customer_id,
      customer_name: doc.to_name,
      customer_avatar: doc.customer_avatar,
      item_ids: meta?.item_ids || doc.item_ids || [],
      status: derivedStatus,
      topic: ((meta?.topic as Conversation["topic"]) || (doc.topic as Conversation["topic"]) || "general"),
      last_message: doc.last_message_text,
      last_timestamp: doc.last_message_timestamp.toISOString(),
      unread: 0,
      assigned_to: effectiveAssignedTo || undefined,
      assigned_to_name: undefined,
    };
  });

  // ⚡ hasMore + cursor สำหรับ pagination (เหมือน /admin/conversations)
  const hasMore = docs.length === limit;
  const nextCursor = docs.length > 0
    ? `${docs[docs.length - 1].last_message_timestamp.toISOString()}|${docs[docs.length - 1].conversation_id}`
    : null;

  // ⚡ นับ total_count แบบไม่จำกัด limit (เฉพาะ head — ไม่นับตอนมี cursor เพื่อลด query)
  const totalCount = parsedCursor ? 0 : await coll.countDocuments(filter);

  // ⚡ G-fix — save cache (เฉพาะ head)
  if (!parsedCursor) {
    bwCache = { key: cacheKey, data: conversations, totalCount, hasMore, cursor: nextCursor, ts: now };
  }

  if (includeCount) {
    return json({ rows: conversations, total_count: totalCount, has_more: hasMore, cursor: nextCursor });
  }
  return json({ rows: conversations, total_count: totalCount });
}
