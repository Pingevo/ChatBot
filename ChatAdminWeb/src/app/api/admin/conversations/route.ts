// GET /api/admin/conversations — list conversations from chatbot DB
// (Phase 7 — อ่านจาก chatbot DB ที่พี่เขาเขียนลงตรงๆ)
//
// Query params:
//   platform     = shopee | tiktok | lazada
//   status       = open | closed | bot | handoff | resolved | pending
//   shop_id      = filter by shop
//   q            = search to_name / last_message_text / shop_name
//   assigned_to  = "me" | "all" | "<admin_id>"  (default: all)
//   limit        = default 2000, max 10000 (โหลดครบทั้งหมด)
//
// ⚠️ อ่านอย่างเดียว ไม่ยิง platform API ใดๆ
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { statusConversationService } from "@/backend/service/statusConversationService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { safeRegexSearch } from "@/backend/lib/regexEscape";
import type { Platform, ConversationStatus } from "@/backend/service/conversationService";
import type { Conversation } from "@/lib/types";

// Cache admin id→name lookup (refresh ทุก request)
async function buildAdminNameMap(): Promise<Map<string, { name: string; username: string }>> {
  const coll = await getCollection<{ admin_id: string; name: string; username: string }>(COLLECTIONS.admins);
  const admins = await coll.find({}, { projection: { admin_id: 1, name: 1, username: 1 } }).toArray();
  const m = new Map<string, { name: string; username: string }>();
  for (const a of admins) m.set(a.admin_id, { name: a.name || "", username: a.username || "" });
  return m;
}

/**
 * นับ unanswered = user messages ที่ยังไม่มี out message (admin/bot) ตอบหลังจากนั้น
 * ⚡ page-scoped — กรองเฉพาะ conversations ใน page นี้ (ใช้ index { conversation_id: 1 })
 *   ก่อนหน้านี้สแกนทั้ง messages collection → ช้ามากเวลา DB ใหญ่
 *   ตอนนี้กรอง conversation_id: { $in: [...] } → ใช้ index → เร็วมาก
 */
async function buildUnansweredMap(convIds: string[]): Promise<Map<string, number>> {
  if (convIds.length === 0) return new Map();
  const msgColl = await getCollection<{ conversation_id: string; created_timestamp: Date }>(COLLECTIONS.messages);
  const convFilter = { conversation_id: { $in: convIds } };
  // 1. last out timestamp ของแต่ละ conversation (เฉพาะที่อยู่ใน page นี้)
  const lastOutAgg = await msgColl.aggregate<{ _id: string; last_out: Date }>([
    { $match: { ...convFilter, direction: "out" } },
    { $group: { _id: "$conversation_id", last_out: { $max: "$created_timestamp" } } },
  ]).toArray();
  const lastOutMap = new Map<string, Date>();
  for (const r of lastOutAgg) lastOutMap.set(r._id, r.last_out);

  // 2. นับ user messages ที่ timestamp > last_out (หรือไม่มี out เลย)
  const userAgg = await msgColl.aggregate<{ _id: string; user_msgs: Date[] }>([
    { $match: { ...convFilter, role: "user", direction: "in" } },
    { $group: { _id: "$conversation_id", user_msgs: { $push: "$created_timestamp" } } },
  ]).toArray();
  const unansweredMap = new Map<string, number>();
  for (const r of userAgg) {
    const last = lastOutMap.get(r._id);
    const unanswered = last
      ? r.user_msgs.filter((t) => t > last).length
      : r.user_msgs.length;
    if (unanswered > 0) unansweredMap.set(r._id, unanswered);
  }
  return unansweredMap;
}

/**
 * ⚡ Pre-fetch conversation_ids ที่ assigned ให้ admin คนใดคนหนึ่ง
 *   จาก status_conversation (source of truth) + conversations (legacy fallback)
 *   ใช้แทนการกรองใน JS หลังดึงข้อมูลแล้ว — ทำให้ paginate ได้ถูกต้อง
 *
 *   - ถ้าส่ง adminId → คืน ids ที่ assigned ให้คนนั้น
 *   - ถ้าไม่ส่ง adminId → คืน ids ที่ assigned ให้ใครก็ตาม (ใช้สำหรับ "unassigned" filter)
 */
async function getAssignedConversationIds(adminId?: string): Promise<string[]> {
  // ⚡ ใช้ type ที่ยอมรับ null/undefined สำหรับ assigned_to (MongoDB อาจเก็บ null ได้)
  type StatusDoc = { conversation_id: string; assigned_to?: string | null };
  const statusColl = await getCollection<StatusDoc>(COLLECTIONS.statusConversation);
  const convColl = await getCollection<StatusDoc>(COLLECTIONS.conversations);

  if (adminId) {
    // 1. ids จาก status_conversation ที่ assigned ให้ admin คนนี้
    const fromStatus = await statusColl
      .find({ assigned_to: adminId }, { projection: { conversation_id: 1 } })
      .toArray();
    const setA = new Set(fromStatus.map((d) => d.conversation_id));

    // 2. ids จาก conversations (legacy) ที่ assigned ให้ admin คนนี้
    const fromConv = await convColl
      .find({ assigned_to: adminId }, { projection: { conversation_id: 1 } })
      .toArray();
    const setB = new Set(fromConv.map((d) => d.conversation_id));

    // 3. ids ที่ status_conversation บอก assigned ให้คนอื่น → ต้องยกเว้น (meta แทนที่ legacy)
    const fromStatusOther = await statusColl
      .find({ assigned_to: { $exists: true, $nin: [null, "", adminId] } }, { projection: { conversation_id: 1 } })
      .toArray();
    const setC = new Set(fromStatusOther.map((d) => d.conversation_id));

    // final = (A ∪ B) - C
    const final = new Set<string>();
    for (const id of setA) final.add(id);
    for (const id of setB) final.add(id);
    for (const id of setC) final.delete(id);
    return Array.from(final);
  } else {
    // คืน ids ที่ assigned ให้ใครก็ตาม (จาก status_conversation — source of truth)
    const fromStatus = await statusColl
      .find({ assigned_to: { $exists: true, $nin: [null, ""] } }, { projection: { conversation_id: 1 } })
      .toArray();
    const setD = new Set(fromStatus.map((d) => d.conversation_id));

    // รวมจาก conversations (legacy) ที่ assigned และไม่ถูก status_conversation override
    const fromConv = await convColl
      .find({ assigned_to: { $exists: true, $nin: [null, ""] } }, { projection: { conversation_id: 1 } })
      .toArray();
    for (const d of fromConv) {
      if (!setD.has(d.conversation_id)) {
        // เช็คว่า status_conversation มี entry นี้ไหม — ถ้ามีและ assigned_to เป็น null → ไม่นับ
        const meta = await statusColl.findOne({ conversation_id: d.conversation_id });
        if (!meta || !meta.assigned_to) {
          setD.add(d.conversation_id);
        }
      }
    }
    return Array.from(setD);
  }
}

function mapToConversation(
  doc: Awaited<ReturnType<typeof conversationService.listConversations>>[number],
  adminMap: Map<string, { name: string; username: string }>,
  unansweredCount: number,
  meta?: { status?: string; assigned_to?: string | null; topic?: string; item_ids?: string[]; pinned?: boolean },
): Conversation {
  // ⚡ Phase 2J — อ่าน status/assigned_to จาก meta (ไม่ใช่ conversations ที่โดน dump ทับ)
  //   ถ้า meta มี → ใช้ meta; ถ้าไม่มี → derive จาก conversations (backward compat)
  const metaStatus = meta?.status;
  const metaAssignedTo = meta?.assigned_to ?? null;
  const effectiveAssignedTo = metaAssignedTo || doc.assigned_to || null;
  const adminInfo = effectiveAssignedTo ? adminMap.get(effectiveAssignedTo) : undefined;
  let derivedStatus: Conversation["status"];
  if (metaStatus) {
    derivedStatus = metaStatus as Conversation["status"];
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
    unread: unansweredCount,  // ⚠️ ใช้ unanswered แทน unread_count ของ sellcenter
    assigned_to: effectiveAssignedTo || undefined,
    assigned_to_name: adminInfo?.name || adminInfo?.username,
  };
}

// ⚡ In-memory cache แบบ short-lived — ลด query ซ้ำจาก polling รัวๆ
//    แต่ invalidate ทันทีเมื่อมีการส่ง/อ่าน/assign/resolve (ผ่าน invalidateCache)
//    → ตอบ/อ่านแล้ว list อัปเดตทันที ไม่รอ 5 วิ
//    เก็บทั้ง data, totalCount, hasMore, cursor (สำหรับ pagination)
//    ⚡ v3 — รองรับ pagination (has_more + cursor) + cache ทุก assigned_to
let cache: { key: string; data: Conversation[]; totalCount?: number; hasMore?: boolean; cursor?: string | null; ts: number; ver: number } | null = null;
const CACHE_TTL = 5000; // ⚡ 5 วิ — ยาวกว่า poll interval (3 วิ) เพื่อให้บางรอบใช้ cache
const CACHE_VER = 3; // ⚡ bump version เมื่อเปลี่ยน cache shape

/** Invalidate cache — เรียกจาก send/assign/resolve/handoff route */
export function invalidateConversationsCache() {
  cache = null;
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = (url.searchParams.get("platform") as Platform | null) || undefined;
  const status = (url.searchParams.get("status") as ConversationStatus | null) || undefined;
  const shopId = url.searchParams.get("shop") || url.searchParams.get("shop_id") || undefined;
  const search = url.searchParams.get("q") || url.searchParams.get("search") || undefined;
  const assignedToParam = url.searchParams.get("assigned_to") || "all";
  const includeCount = url.searchParams.get("include_count") === "true";
  // ⚡ compound cursor — "timestamp|conversation_id" (tiebreaker กันข้ามแชทที่ timestamp เดียวกัน)
  const cursorParam = url.searchParams.get("cursor") || undefined;
  let parsedCursor: { ts: Date; id: string } | undefined;
  if (cursorParam) {
    const sepIdx = cursorParam.indexOf("|");
    if (sepIdx > 0) {
      const tsStr = cursorParam.substring(0, sepIdx);
      const idStr = cursorParam.substring(sepIdx + 1);
      const ts = new Date(tsStr);
      if (!isNaN(ts.getTime()) && idStr) {
        parsedCursor = { ts, id: idStr };
      }
    } else {
      // backward compat — cursor เดิมที่เป็นแค่ timestamp
      const ts = new Date(cursorParam);
      if (!isNaN(ts.getTime())) parsedCursor = { ts, id: "" };
    }
  }
  const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
  const limit = Math.min(Math.max(limitParam, 1), 10000);
  const me = r.ctx.admin.admin_id;

  // ⚡ cache ทุก assigned_to (key รวม assigned_to + cursor)
  const canCache = true;
  const cacheKey = `${assignedToParam}|${platform || ""}|${status || ""}|${shopId || ""}|${search || ""}|${limit}|${cursorParam || ""}`;
  const now = Date.now();
  if (canCache && cache && cache.key === cacheKey && cache.ver === CACHE_VER && now - cache.ts < CACHE_TTL) {
    if (includeCount) {
      return json({ rows: cache.data, total_count: cache.totalCount ?? cache.data.length, has_more: cache.hasMore ?? false, cursor: cache.cursor ?? null });
    }
    return json(cache.data);
  }

  // ⚡ Pre-fetch assigned_to conversation_ids — กรองใน Mongo ไม่ใช่ใน JS
  //   ทำให้ paginate ถูกต้อง (ไม่ใช่ดึง 2000 แล้วกรองเหลือ 50)
  let conversationIds: string[] | undefined;
  let excludeConversationIds: string[] | undefined;
  if (assignedToParam === "me") {
    conversationIds = await getAssignedConversationIds(me);
  } else if (assignedToParam === "unassigned") {
    excludeConversationIds = await getAssignedConversationIds();
  } else if (assignedToParam !== "all") {
    conversationIds = await getAssignedConversationIds(assignedToParam);
  }

  const docs = await conversationService.listConversations({
    platform,
    status,
    shopId,
    search,
    limit,
    cursor: parsedCursor,
    conversationIds,
    excludeConversationIds,
  });

  // ⚡ hasMore — ถ้าดึงได้ครบ limit → อาจมีอีก
  const hasMore = docs.length === limit;
  // ⚡ compound cursor สำหรับ page ถัดไป = "timestamp|conversation_id" ของ doc สุดท้าย
  const nextCursor = docs.length > 0
    ? `${docs[docs.length - 1].last_message_timestamp.toISOString()}|${docs[docs.length - 1].conversation_id}`
    : null;

  // ⚡ dedupe by conversation_id — DB อาจมี doc ซ้ำ (same conversation_id)
  const _seenConv = new Set<string>();
  const _dedupedDocs = docs.filter((d) => {
    if (_seenConv.has(d.conversation_id)) return false;
    _seenConv.add(d.conversation_id);
    return true;
  });

  // ⚡ Phase 2J — โหลด meta ทั้งหมดของ conversations ที่ได้มา (batch)
  const _convIds = _dedupedDocs.map((d) => d.conversation_id);
  const _metaMap = await statusConversationService.getMetaMap(_convIds);

  // ⚡ Phase 2X — auto-reopen closed conversations ที่มีข้อความใหม่หลัง closed_at
  //   ทำที่นี่ (ไม่ใช่ใน botworker) เพื่อให้ /tickets ทำงานอิสระจาก botworker
  //   เขียน status_conversation (จริง) — แยกจาก test_status_conversation ของ botworker
  const _closedConvIds = _dedupedDocs
    .filter((d) => {
      const m = _metaMap.get(d.conversation_id);
      const status = m?.status || (d.closed_at ? "closed" : "bot");
      return status === "closed" || status === "resolved";
    })
    .map((d) => d.conversation_id);
  if (_closedConvIds.length > 0) {
    // ตรวจแต่ละ closed conversation ว่ามีข้อความใหม่หลัง closed_at ไหม
    for (const convId of _closedConvIds) {
      const doc = _dedupedDocs.find((d) => d.conversation_id === convId);
      const meta = _metaMap.get(convId);
      if (!doc) continue;
      const closedAt = meta?.closed_at || doc.closed_at;
      if (!closedAt) continue;
      // เช็ค last_message_timestamp ของ conversation — ถ้าใหม่กว่า closed_at → reopen
      if (doc.last_message_timestamp && doc.last_message_timestamp > closedAt) {
        try {
          await statusConversationService.updateStatus(convId, "bot", undefined);
          // อัปเดต meta ใน map ทันทีเพื่อให้ response ส่งกลับเห็น status ใหม่
          _metaMap.set(convId, {
            ...meta!,
            status: "bot",
            assigned_to: undefined,
            updated_at: new Date(),
          });
        } catch (err) {
          console.error(`[admin/conversations] auto-reopen failed for ${convId}:`, err);
        }
      }
    }
  }

  // ⚡ assigned_to filter ทำใน Mongo แล้ว (pre-fetch) — ไม่ต้องกรองใน JS อีก
  let filtered = _dedupedDocs;

  // 🔒 channels_access filter — admin ธรรมดาเห็นเฉพาะ conversation ใน channel ที่ตนมีสิทธิ์
  // superadmin/dev เห็นทั้งหมด (channels_access ว่าง = เห็นทั้งหมดด้วย เพื่อ backward compat)
  const isPrivileged = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
  const channelsAccess = r.ctx.admin.channels_access || [];
  if (!isPrivileged && channelsAccess.length > 0) {
    filtered = filtered.filter((d) => channelsAccess.includes(d.platform));
  }

  const adminMap = await buildAdminNameMap();
  // ⚡ page-scoped unanswered — กรองเฉพาะ conversations ใน page นี้ (ใช้ index { conversation_id: 1 })
  //   ก่อนหน้านี้สแกนทั้ง messages collection → ช้ามาก
  const pageConvIds = filtered.map((d) => d.conversation_id);
  const unansweredMap = await buildUnansweredMap(pageConvIds);
  const conversations: Conversation[] = filtered.map((d) =>
    mapToConversation(d, adminMap, unansweredMap.get(d.conversation_id) || 0, _metaMap.get(d.conversation_id))
  );
  // ⚡ ถ้า include_count=true → นับ total_count แบบไม่จำกัด limit แล้วส่งกลับ { rows, total_count, has_more, cursor }
  if (includeCount) {
    const countFilter: Record<string, unknown> = {};
    if (platform) countFilter.platform = platform;
    if (status) countFilter.status = status;
    if (shopId) countFilter.shop_id = shopId;
    if (conversationIds) countFilter.conversation_id = { $in: conversationIds };
    if (excludeConversationIds) {
      const existing = countFilter.conversation_id as Record<string, unknown> | undefined;
      countFilter.conversation_id = { ...(existing || {}), $nin: excludeConversationIds };
    }
    if (search) {
      // 🔒 escape regex metacharacters
      const safeSearch = safeRegexSearch(search);
      if (safeSearch) {
        countFilter.$or = [
          { to_name: { $regex: safeSearch, $options: "i" } },
          { last_message_text: { $regex: safeSearch, $options: "i" } },
          { shop_name: { $regex: safeSearch, $options: "i" } },
        ];
      }
    }
    const convColl = await getCollection(COLLECTIONS.conversations);
    const totalCount = await convColl.countDocuments(countFilter);
    // ⚡ save cache พร้อม totalCount + hasMore + cursor
    if (canCache) cache = { key: cacheKey, data: conversations, totalCount, hasMore, cursor: nextCursor, ts: now, ver: CACHE_VER };
    return json({ rows: conversations, total_count: totalCount, has_more: hasMore, cursor: nextCursor });
  }

  // ⚡ save cache (ไม่มี totalCount — ไม่จำเป็นถ้าไม่ใช่ include_count)
  if (canCache) cache = { key: cacheKey, data: conversations, hasMore, cursor: nextCursor, ts: now, ver: CACHE_VER };
  return json(conversations);
}
