// GET /api/admin/conversations — list conversations from chatbot DB
// (Phase 7 — อ่านจาก chatbot DB ที่พี่เขาเขียนลงตรงๆ)
//
// Query params:
//   platform     = shopee | tiktok | lazada
//   status       = open | closed | bot | handoff | resolved | pending
//   shop_id      = filter by shop
//   q            = search name / message / shop / conversation_id / user_id / exact order_sn
//   assigned_to  = "me" | "unassigned" | "all" | "<admin_id>"  (default: all)
//   limit        = default 2000, max 10000 (โหลดครบทั้งหมด)
//
// ⚠️ read-only — ไม่เขียน DB, ไม่ยิง platform API
//   status/assigned_to เป็น meta predicates (status_conversation) — join ใน
//   aggregation pipeline เดียวกับ rows/count (ไม่มี JS id-arrays)
//   auto-reopen closed→bot on inbound ไม่มี owner ใน codebase — ดู roadmap 2B.1
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { CONVERSATION_TEXT_SEARCH_FIELDS, OWNED_CHAT_STATUSES, parseInboxFilters, unansweredStages, messageStatusMatch } from "@/backend/lib/inboxFilters";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { safeRegexSearch } from "@/backend/lib/regexEscape";
import { findOrderConversationMatch } from "@/backend/service/conversationService";
import type { Platform, ConversationStatus, ConversationDoc } from "@/backend/service/conversationService";
import type { Conversation } from "@/lib/types";

// Cache admin id→name lookup (refresh ทุก request)
async function buildAdminNameMap(): Promise<Map<string, { name: string; username: string }>> {
  const coll = await getCollection<{ admin_id: string; name: string; username: string }>(COLLECTIONS.admins);
  const admins = await coll.find({}, { projection: { admin_id: 1, name: 1, username: 1 } }).toArray();
  const m = new Map<string, { name: string; username: string }>();
  for (const a of admins) m.set(a.admin_id, { name: a.name || "", username: a.username || "" });
  return m;
}

/** นับ unanswered = user messages ที่ยังไม่มี out message (admin/bot) ตอบหลังจากนั้น
 *  ⚡ page-scoped — เฉพาะ conversations ใน page นี้ (index { conversation_id: 1 }) */
async function buildUnansweredMap(convIds: string[]): Promise<Map<string, number>> {
  if (convIds.length === 0) return new Map();
  const msgColl = await getCollection<{ conversation_id: string; created_timestamp: Date }>(COLLECTIONS.messages);
  const convFilter = { conversation_id: { $in: convIds } };
  const lastOutAgg = await msgColl.aggregate<{ _id: string; last_out: Date }>([
    { $match: { ...convFilter, direction: "out" } },
    { $group: { _id: "$conversation_id", last_out: { $max: "$created_timestamp" } } },
  ]).toArray();
  const lastOutMap = new Map<string, Date>();
  for (const r of lastOutAgg) lastOutMap.set(r._id, r.last_out);

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

interface MetaRow {
  status?: string;
  assigned_to?: string | null;
  topic?: string;
  item_ids?: string[];
  pinned?: boolean;
  pinned_by_admin_ids?: string[];
  // ⚡ Phase 2B.6 — claim lifecycle fields (transport จาก status_conversation)
  active_claim_episode_id?: string | null;
  claim_outcome?: {
    episode_id: string;
    outcome: "resolved" | "cancelled";
    actor_id: string;
    occurred_at: Date | string;
  } | null;
  bot_claim_info?: Record<string, unknown> | null;
}

export function mapToConversation(
  doc: ConversationDoc,
  adminMap: Map<string, { name: string; username: string }>,
  unansweredCount: number,
  meta?: MetaRow,
  me = "",
): Conversation {
  // status/assigned_to อ่านจาก meta เท่านั้น — raw conversations(_shp) เป็น dump
  //   meta ไม่มี → bot-owned
  const metaStatus = meta?.status;
  const effectiveAssignedTo = meta?.assigned_to ?? null;
  const adminInfo = effectiveAssignedTo ? adminMap.get(effectiveAssignedTo) : undefined;
  const derivedStatus: Conversation["status"] = metaStatus
    ? (metaStatus as Conversation["status"])
    : "bot";
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
    created_at: doc.created_at.toISOString(),
    pin_global: meta?.pinned === true,
    pin_personal: !!me && (meta?.pinned_by_admin_ids || []).includes(me),
    unread: unansweredCount,  // ⚠️ ใช้ unanswered แทน unread_count ของ sellcenter
    assigned_to: effectiveAssignedTo || undefined,
    assigned_to_name: adminInfo?.name || adminInfo?.username,
    // ⚡ Phase 2B.6 — claim lifecycle transport (meta เท่านั้น)
    active_claim_episode_id: meta?.active_claim_episode_id ?? undefined,
    claim_outcome: meta?.claim_outcome
      ? { ...meta.claim_outcome,
          occurred_at: meta.claim_outcome.occurred_at instanceof Date
            ? meta.claim_outcome.occurred_at.toISOString()
            : String(meta.claim_outcome.occurred_at) }
      : undefined,
    bot_claim_info: (meta?.bot_claim_info as Conversation["bot_claim_info"]) ?? undefined,
  };
}

// ⚡ In-memory cache แบบ short-lived — invalidate ทันทีเมื่อส่ง/อ่าน/assign/resolve
//    (ผ่าน invalidateConversationsCache)
let cache: { key: string; data: Conversation[]; totalCount?: number; hasMore?: boolean; cursor?: string | null; ts: number; ver: number } | null = null;
const CACHE_TTL = 5000;
const CACHE_VER = 5; // bump เมื่อเปลี่ยน shape/contract

/** Invalidate cache — เรียกจาก send/assign/resolve/handoff route */
export function invalidateConversationsCache() {
  cache = null;
}

const META_JOIN = [
  { $lookup: { from: COLLECTIONS.statusConversation, localField: "conversation_id", foreignField: "conversation_id", as: "meta" } },
  { $unwind: { path: "$meta", preserveNullAndEmptyArrays: true } },
];

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const rawFilters = url.searchParams.get("filters");
  const rawPinIds = url.searchParams.get("pin_ids");
  let pinIds: string[] | null = null;
  if (rawPinIds) {
    try {
      const ids: unknown = JSON.parse(rawPinIds);
      if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === "string" && id.length <= 150)) return error("invalid pin ids", 422);
      pinIds = ids;
    } catch { return error("invalid pin ids", 422); }
  }
  const listFilters = parseInboxFilters(rawFilters);
  if (rawFilters && !listFilters) return error("invalid inbox filters", 422);
  const platform = (url.searchParams.get("platform") as Platform | null) || undefined;
  const status = ((listFilters?.msgStatus === "unreplied" ? "handoff"
    : listFilters && listFilters.chatStatus !== "all" ? listFilters.chatStatus
    : url.searchParams.get("status")) || undefined) as ConversationStatus | undefined;
  const shopId = url.searchParams.get("shop") || url.searchParams.get("shop_id") || undefined;
  const search = url.searchParams.get("q") || url.searchParams.get("search") || undefined;
  const assignedToParam = url.searchParams.get("assigned_to") || "all";
  const includeCount = url.searchParams.get("include_count") === "true";
  // ⚡ compound cursor — "timestamp|conversation_id" (tiebreaker กัน timestamp เดียวกัน)
  const cursorParam = url.searchParams.get("cursor") || undefined;
  let nameCursor: { name: string; id: string } | undefined;
  if (listFilters?.sort === "name" && cursorParam?.startsWith("n|")) {
    const parts = cursorParam.split("|");
    if (parts.length === 3 && parts[2]) {
      try { nameCursor = { name: decodeURIComponent(parts[1]), id: parts[2] }; } catch { return error("invalid cursor", 422); }
    }
  }
  let parsedCursor: { ts: Date; id: string } | undefined;
  if (cursorParam && listFilters?.sort !== "name") {
    const sepIdx = cursorParam.indexOf("|");
    if (sepIdx > 0) {
      const ts = new Date(cursorParam.substring(0, sepIdx));
      const idStr = cursorParam.substring(sepIdx + 1);
      if (!isNaN(ts.getTime()) && idStr) parsedCursor = { ts, id: idStr };
    } else {
      const ts = new Date(cursorParam);
      if (!isNaN(ts.getTime())) parsedCursor = { ts, id: "" };
    }
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 10000);
  const me = r.ctx.admin.admin_id;

  // 🔒 channel predicate — admin ธรรมดาเห็นเฉพาะ channels_access (superadmin/dev/[] = ทั้งหมด)
  const isPrivileged = r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev";
  const channelsAccess = r.ctx.admin.channels_access || [];
  const channelPred = isPrivileged || channelsAccess.length === 0 ? undefined : { $in: channelsAccess };

  // me + channels ต้องอยู่ใน cache key — กันข้าม admin (assigned_to=me/authorized rows คนละชุด)
  const cacheKey = `${me}|${channelsAccess.join(",")}|${assignedToParam}|${platform || ""}|${status || ""}|${shopId || ""}|${search || ""}|${rawFilters || ""}|${rawPinIds || ""}|${limit}|${includeCount}|${cursorParam || ""}`;
  const now = Date.now();
  if (cache && cache.key === cacheKey && cache.ver === CACHE_VER && now - cache.ts < CACHE_TTL) {
    if (includeCount) {
      return json({ rows: cache.data, total_count: cache.totalCount ?? cache.data.length, has_more: cache.hasMore ?? false, cursor: cache.cursor ?? null });
    }
    return json(cache.data);
  }

  type ListRow = ConversationDoc & { meta?: MetaRow | MetaRow[] | null };
  const convColl = await getCollection<ListRow>(COLLECTIONS.conversations);

  const safeSearch = search ? safeRegexSearch(search) : undefined;
  let searchOr: Record<string, unknown>[] | undefined = safeSearch
    ? CONVERSATION_TEXT_SEARCH_FIELDS.map((field) => ({
        [field]: { $regex: safeSearch, $options: "i" },
      }))
    : undefined;

  if (search?.trim()) {
    try {
      const orderMatch = await findOrderConversationMatch(search);
      if (orderMatch) (searchOr ||= []).push(orderMatch);
    } catch (e) {
      console.error("[admin/conversations] order lookup failed:", e);
    }
  }

  // conv-side predicate (pfx = "" บน conv doc / "conv." หลัง meta-first lookup)
  //   channel/platform/shop/search/cursor ทั้งหมดก่อน sort/limit — rows/count predicate เดียวกัน
  const convMatch = (pfx: string, withCursor: boolean) => {
    const m: Record<string, unknown> = {};
    if (platform) {
      m[`${pfx}platform`] = channelPred && !channelsAccess.includes(platform) ? { $in: [] } : platform;
    } else if (listFilters?.platforms.length) {
      const allowed = channelPred ? listFilters.platforms.filter((p) => channelsAccess.includes(p)) : listFilters.platforms;
      m[`${pfx}platform`] = { $in: allowed };
    } else if (channelPred) {
      m[`${pfx}platform`] = channelPred;
    }
    if (shopId) m[`${pfx}shop_id`] = shopId;
    if (pinIds) m[`${pfx}conversation_id`] = { $in: pinIds };
    const ands: Record<string, unknown>[] = [];
    if (listFilters?.shops.length) ands.push({ $or: listFilters.shops.map((shop) => ({
      [`${pfx}platform`]: shop.platform, [`${pfx}shop_id`]: shop.shop_id,
    })) });
    if (withCursor && nameCursor) {
      ands.push({ $or: [
        { [`${pfx}to_name`]: { $gt: nameCursor.name } },
        { [`${pfx}to_name`]: nameCursor.name, [`${pfx}conversation_id`]: { $gt: nameCursor.id } },
      ] });
    } else if (withCursor && parsedCursor) {
      const direction = listFilters?.sort === "oldest" ? "$gt" : "$lt";
      ands.push({ $or: [
        { [`${pfx}last_message_timestamp`]: { [direction]: parsedCursor.ts } },
        { [`${pfx}last_message_timestamp`]: parsedCursor.ts, [`${pfx}conversation_id`]: { [direction]: parsedCursor.id } },
      ]});
    }
    if (searchOr) {
      ands.push({ $or: searchOr.map((c) => Object.fromEntries(
        Object.entries(c).map(([key, value]) => [`${pfx}${key}`, value]),
      )) });
    }
    if (ands.length === 1) Object.assign(m, ands[0]);
    else if (ands.length > 1) m.$and = ands;
    return m;
  };

  // meta predicates (pfx = "" บน meta doc / "meta." หลัง conv-first lookup)
  //   status=bot → meta.status ∉ OWNED_STATUSES (ครอบ missing meta/no-status/bot — conv-first เท่านั้น)
  //   assigned_to=<id|me> → meta.assigned_to = id;  unassigned → ไม่มี owner
  const metaConds = (pfx: string) => {
    const conds: Record<string, unknown>[] = [];
    if (status === "bot") conds.push({ [`${pfx}status`]: { $nin: OWNED_CHAT_STATUSES } });
    else if (status) conds.push({ [`${pfx}status`]: status });
    if (assignedToParam === "pending_handoff") conds.push({ [`${pfx}status`]: { $in: ["handoff", "open", "pending"] } });
    if (assignedToParam === "unassigned" || assignedToParam === "pending_handoff") conds.push({ $or: [
      { [`${pfx}assigned_to`]: { $exists: false } },
      { [`${pfx}assigned_to`]: { $in: [null, ""] } },
    ]});
    else if (assignedToParam === "me") conds.push({ [`${pfx}assigned_to`]: me });
    else if (assignedToParam !== "all" && assignedToParam !== "pending_handoff") conds.push({ [`${pfx}assigned_to`]: assignedToParam });
    return conds;
  };
  const metaMatch = (conds: Record<string, unknown>[]) =>
    conds.length === 1 ? conds[0] : { $and: conds };

  // meta-bound = filter ที่ต้องการ meta มีอยู่จริง (human status / specific owner)
  //   → aggregate จาก status_conversation (indexed status/assigned_to) แล้ว lookup conv
  // status=bot / unassigned ยอม missing meta → conv-first anti-join เท่านั้นที่ครอบ
  //   (bounded ต้องการ complete meta ที่ ingress — external writer, ดู roadmap 2B.1)
  const metaBound = (status !== undefined && status !== "bot") ||
    (assignedToParam !== "all" && assignedToParam !== "unassigned");

  const sortKeys = listFilters?.sort === "oldest"
    ? { last_message_timestamp: 1, conversation_id: 1 }
    : listFilters?.sort === "name"
      ? { to_name: 1, conversation_id: 1 }
      : listFilters ? { last_message_timestamp: -1, conversation_id: -1 }
        : { pinned: -1, last_message_timestamp: -1, conversation_id: -1 };
  const sortStage = (pfx: string) =>
    ({ $sort: Object.fromEntries(Object.entries(sortKeys).map(([k, v]) => [`${pfx}${k}`, v])) });
  const messageStages = listFilters?.msgStatus && listFilters.msgStatus !== "all"
    ? (pfx: string) => [...unansweredStages(pfx), ...messageStatusMatch(listFilters.msgStatus)]
    : () => [];

  let docs: ListRow[];
  let totalCount: number | undefined;
  let fetched = 0; // rows ก่อน slice — hasMore เที่ยงตรงแม้ page สุดท้ายพอดี limit

  if (metaBound) {
    const metaColl = await getCollection(COLLECTIONS.statusConversation);
    const mFilter = { $match: metaMatch(metaConds("")) };
    const convLookup = [
      { $lookup: { from: COLLECTIONS.conversations, localField: "conversation_id", foreignField: "conversation_id", as: "conv" } },
      { $unwind: "$conv" },
    ];
    const metaRows = await metaColl.aggregate<{ conv: ConversationDoc } & MetaRow & { conversation_id: string }>([
      mFilter, ...convLookup,
      { $match: convMatch("conv.", true) },
      ...messageStages("conv."),
      sortStage("conv."),
      { $limit: limit + 1 }, // +1 probe → has_more เที่ยงตรง (page สุดท้ายพอดี limit ไม่ false-positive)
    ], { allowDiskUse: true, maxTimeMS: 15000 }).toArray();
    fetched = metaRows.length;
    docs = metaRows.slice(0, limit).map((d) => ({
      ...d.conv,
      meta: { status: d.status, assigned_to: d.assigned_to, topic: d.topic, item_ids: d.item_ids, pinned: d.pinned, pinned_by_admin_ids: d.pinned_by_admin_ids,
        active_claim_episode_id: d.active_claim_episode_id, claim_outcome: d.claim_outcome,
        bot_claim_info: d.bot_claim_info },
    }));
    if (includeCount) {
      totalCount = ((await metaColl.aggregate<{ n: number }>([
        mFilter, ...convLookup,
        { $match: convMatch("conv.", false) },
        ...messageStages("conv."),
        { $count: "n" },
      ]).toArray())[0]?.n ?? 0);
    }
  } else {
    // conv-first — default (join หลัง limit page-scoped) หรือ missing-meta filter (bot/unassigned)
    const mconds = metaConds("meta.");
    const metaFilter = mconds.length ? { $match: metaMatch(mconds) } : undefined;
    const pipeline: Record<string, unknown>[] = [
      { $match: convMatch("", true) },
      ...(metaFilter ? [...META_JOIN, metaFilter] : []),
      ...messageStages(""),
      sortStage(""),
      { $limit: limit + 1 },
      ...(metaFilter ? [] : META_JOIN),
    ];
    const convRows = await convColl.aggregate<ListRow>(pipeline, { allowDiskUse: true, maxTimeMS: 15000 }).toArray();
    fetched = convRows.length;
    docs = convRows.slice(0, limit);
    if (includeCount) {
      totalCount = metaFilter
        ? ((await convColl.aggregate<{ n: number }>([
            { $match: convMatch("", false) }, ...META_JOIN, metaFilter, ...messageStages(""), { $count: "n" },
          ]).toArray())[0]?.n ?? 0)
        : listFilters?.msgStatus && listFilters.msgStatus !== "all"
          ? ((await convColl.aggregate<{ n: number }>([
              { $match: convMatch("", false) }, ...messageStages(""), { $count: "n" },
            ]).toArray())[0]?.n ?? 0)
          : await convColl.countDocuments(convMatch("", false));
    }
  }

  // ⚡ hasMore — fetch limit+1: เหลือเกิน limit = มีหน้าถัดไปจริง
  const hasMore = fetched > limit;
  const nextCursor = docs.length > 0
    ? listFilters?.sort === "name"
      ? `n|${encodeURIComponent(docs[docs.length - 1].to_name || "")}|${docs[docs.length - 1].conversation_id}`
      : `${docs[docs.length - 1].last_message_timestamp.toISOString()}|${docs[docs.length - 1].conversation_id}`
    : null;

  // ⚡ dedupe by conversation_id — DB อาจมี doc ซ้ำ
  const _seenConv = new Set<string>();
  const filtered = docs.filter((d) => {
    if (_seenConv.has(d.conversation_id)) return false;
    _seenConv.add(d.conversation_id);
    return true;
  });

  const adminMap = await buildAdminNameMap();
  const pageConvIds = filtered.map((d) => d.conversation_id);
  const unansweredMap = await buildUnansweredMap(pageConvIds);
  const conversations: Conversation[] = filtered.map((d) => {
    const meta = Array.isArray(d.meta) ? d.meta[0] : d.meta;
    return mapToConversation(d, adminMap, unansweredMap.get(d.conversation_id) || 0, meta ?? undefined, me);
  });

  if (includeCount) {
    cache = { key: cacheKey, data: conversations, totalCount, hasMore, cursor: nextCursor, ts: now, ver: CACHE_VER };
    return json({ rows: conversations, total_count: totalCount ?? 0, has_more: hasMore, cursor: nextCursor });
  }

  cache = { key: cacheKey, data: conversations, hasMore, cursor: nextCursor, ts: now, ver: CACHE_VER };
  return json(conversations);
}
