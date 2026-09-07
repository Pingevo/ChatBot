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
 * ใช้ aggregation 2 ตัวเพื่อความเร็ว (0.5s แทน 118s สำหรับ 1377 conversations)
 *   1. หา last out timestamp ของแต่ละ conversation
 *   2. นับ user messages ที่ timestamp > last_out ของแต่ละ conversation
 */
async function buildUnansweredMap(): Promise<Map<string, number>> {
  const msgColl = await getCollection<{ conversation_id: string; created_timestamp: Date }>(COLLECTIONS.messages);
  // 1. last out timestamp ของแต่ละ conversation
  const lastOutAgg = await msgColl.aggregate<{ _id: string; last_out: Date }>([
    { $match: { direction: "out" } },
    { $group: { _id: "$conversation_id", last_out: { $max: "$created_timestamp" } } },
  ]).toArray();
  const lastOutMap = new Map<string, Date>();
  for (const r of lastOutAgg) lastOutMap.set(r._id, r.last_out);

  // 2. นับ user messages ที่ timestamp > last_out (หรือไม่มี out เลย)
  const userAgg = await msgColl.aggregate<{ _id: string; user_msgs: Date[] }>([
    { $match: { role: "user", direction: "in" } },
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
//    เก็บทั้ง data และ totalCount (สำหรับ include_count=true)
//    ⚡ v2 — dedupe cache version (กัน cache เก่าที่มี duplicate)
let cache: { key: string; data: Conversation[]; totalCount?: number; ts: number; ver: number } | null = null;
const CACHE_TTL = 3000; // 3 วิ — สั้นๆ เผื่อ invalidate ไม่ทัน
const CACHE_VER = 2; // ⚡ bump version เมื่อเปลี่ยน cache shape

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
  const limitParam = parseInt(url.searchParams.get("limit") || "2000", 10);
  const limit = Math.min(Math.max(limitParam, 1), 10000);

  // ⚡ cache เฉพาะ assigned_to=all (เหมือนกันทุกคน) — กรณีอื่นไม่ cache
  const canCache = assignedToParam === "all";
  const cacheKey = `${assignedToParam}|${platform || ""}|${status || ""}|${shopId || ""}|${search || ""}|${limit}`;
  const now = Date.now();
  if (canCache && cache && cache.key === cacheKey && cache.ver === CACHE_VER && now - cache.ts < CACHE_TTL) {
    // ⚡ ถ้า include_count=true → คืน { rows, total_count } ถ้าไม่ใช่ → คืน array ตรงๆ
    if (includeCount) {
      return json({ rows: cache.data, total_count: cache.totalCount ?? cache.data.length });
    }
    return json(cache.data);
  }

  const docs = await conversationService.listConversations({
    platform,
    status,
    shopId,
    search,
    limit,
  });

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

  // Phase 7.9 — filter assigned_to ที่นี่ (service ยังไม่รองรับ field นี้)
  // ⚡ Phase 2J — ใช้ assigned_to จาก meta ถ้ามี ไม่ใช่จาก conversations
  let filtered = _dedupedDocs;
  const me = r.ctx.admin.admin_id;
  if (assignedToParam === "me") {
    filtered = _dedupedDocs.filter((d) => {
      const m = _metaMap.get(d.conversation_id);
      return (m?.assigned_to || d.assigned_to) === me;
    });
  } else if (assignedToParam === "unassigned") {
    filtered = _dedupedDocs.filter((d) => {
      const m = _metaMap.get(d.conversation_id);
      return !(m?.assigned_to || d.assigned_to);
    });
  } else if (assignedToParam !== "all") {
    // กรองตาม admin_id เฉพาะเจาะจง
    filtered = _dedupedDocs.filter((d) => {
      const m = _metaMap.get(d.conversation_id);
      return (m?.assigned_to || d.assigned_to) === assignedToParam;
    });
  }

  // 🔒 channels_access filter — admin ธรรมดาเห็นเฉพาะ conversation ใน channel ที่ตนมีสิทธิ์
  // superadmin/dev เห็นทั้งหมด (channels_access ว่าง = เห็นทั้งหมดด้วย เพื่อ backward compat)
  const isPrivileged = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
  const channelsAccess = r.ctx.admin.channels_access || [];
  if (!isPrivileged && channelsAccess.length > 0) {
    filtered = filtered.filter((d) => channelsAccess.includes(d.platform));
  }

  const adminMap = await buildAdminNameMap();
  // ⚡ batch compute unanswered counts (0.5s สำหรับ 1377 conversations)
  const unansweredMap = await buildUnansweredMap();
  const conversations: Conversation[] = filtered.map((d) =>
    mapToConversation(d, adminMap, unansweredMap.get(d.conversation_id) || 0, _metaMap.get(d.conversation_id))
  );
  // ⚡ ถ้า include_count=true → นับ total_count แบบไม่จำกัด limit แล้วส่งกลับ { rows, total_count }
  if (includeCount) {
    const countFilter: Record<string, unknown> = {};
    if (platform) countFilter.platform = platform;
    if (status) countFilter.status = status;
    if (shopId) countFilter.shop_id = shopId;
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
    // ⚡ save cache พร้อม totalCount
    if (canCache) cache = { key: cacheKey, data: conversations, totalCount, ts: now, ver: CACHE_VER };
    return json({ rows: conversations, total_count: totalCount });
  }

  // ⚡ save cache (ไม่มี totalCount — ไม่จำเป็นถ้าไม่ใช่ include_count)
  if (canCache) cache = { key: cacheKey, data: conversations, ts: now, ver: CACHE_VER };
  return json(conversations);
}
