// GET /api/botworker/conversations — list conversations สำหรับหน้า /botworker
// อ่าน status/assigned_to จาก test_status_conversation source="botworker"
// ห้ามส่งข้อความจริงหรือเรียก platform API
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { statusConversationService } from "@/backend/service/statusConversationService";
import { safeRegexSearch } from "@/backend/lib/regexEscape";
import { parseInboxFilters, unansweredStages, messageStatusMatch } from "@/backend/lib/inboxFilters";
import { getBotworkerConversationCache, setBotworkerConversationCache } from "@/backend/service/botworkerConversationCache";
import type { Conversation } from "@/lib/types";
import type { ConversationDoc } from "@/backend/service/conversationService";

export async function GET(req: NextRequest) {
  const auth = await requirePageAccess(req, "botworker");
  if (!auth.ok) return auth.response;
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
  const platform = url.searchParams.get("platform") || undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;
  const search = url.searchParams.get("search") || url.searchParams.get("q") || undefined;
  const cursorParam = url.searchParams.get("cursor") || undefined;
  const includeCount = url.searchParams.get("include_count") === "true";
  const parsedLimit = Number.parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 5000) : 200;
  const assignedTo = url.searchParams.get("assigned_to") || "all";
  const me = auth.ctx.admin.admin_id;
  const channels = auth.ctx.admin.role === "superadmin" || auth.ctx.admin.role === "dev" || !auth.ctx.admin.channels_access?.length
    ? null : auth.ctx.admin.channels_access;
  const cacheKey = JSON.stringify([me, channels, assignedTo, platform, shopId, search, rawFilters, rawPinIds, limit, cursorParam]);
  const cached = getBotworkerConversationCache(cacheKey);
  if (cached) {
    return json({ rows: cached.data, total_count: cached.totalCount, has_more: cached.hasMore, cursor: cached.cursor });
  }

  const terms: Record<string, unknown>[] = [];
  if (channels) terms.push({ platform: { $in: channels } });
  if (platform) terms.push({ platform });
  if (listFilters?.platforms.length) terms.push({ platform: { $in: listFilters.platforms } });
  if (shopId) terms.push({ shop_id: shopId });
  if (pinIds) terms.push({ conversation_id: { $in: pinIds } });
  if (listFilters?.shops.length) terms.push({ $or: listFilters.shops.map((shop) => ({ platform: shop.platform, shop_id: shop.shop_id })) });
  if (search) {
    const safe = safeRegexSearch(search);
    if (safe) terms.push({ $or: [
      { to_name: { $regex: safe, $options: "i" } },
      { last_message_text: { $regex: safe, $options: "i" } },
      { shop_name: { $regex: safe, $options: "i" } },
    ] });
  }

  // Sandbox ownership is the source of truth for BotWorker recipient filters.
  if (assignedTo !== "all") {
    const statuses = await getCollection<{ conversation_id: string; assigned_to?: string | null }>(COLLECTIONS.testStatusConversation);
    if (assignedTo === "unassigned") {
      const assigned = await statuses.find({ source: "botworker", assigned_to: { $nin: [null, ""] } }, { projection: { conversation_id: 1 } }).toArray();
      terms.push({ conversation_id: { $nin: assigned.map((row) => row.conversation_id) } });
    } else if (assignedTo === "pending_handoff") {
      const pending = await statuses.find({ source: "botworker", status: { $in: ["handoff", "open", "pending"] },
        $or: [{ assigned_to: null }, { assigned_to: "" }, { assigned_to: { $exists: false } }],
      }, { projection: { conversation_id: 1 } }).toArray();
      terms.push({ conversation_id: { $in: pending.map((row) => row.conversation_id) } });
    } else {
      const target = assignedTo === "me" ? me : assignedTo;
      const mine = await statuses.find({ source: "botworker", assigned_to: target }, { projection: { conversation_id: 1 } }).toArray();
      terms.push({ conversation_id: { $in: mine.map((row) => row.conversation_id) } });
    }
  }
  const baseMatch = terms.length ? { $and: terms } : {};
  const sort = listFilters?.sort === "oldest"
    ? { last_message_timestamp: 1, conversation_id: 1 }
    : listFilters?.sort === "name"
      ? { to_name: 1, conversation_id: 1 }
      : { last_message_timestamp: -1, conversation_id: -1 };

  const cursorTerms = [...terms];
  if (cursorParam) {
    if (listFilters?.sort === "name") {
      const parts = cursorParam.split("|");
      if (parts.length !== 3 || parts[0] !== "n" || !parts[2]) return error("invalid cursor", 422);
      let name: string;
      try { name = decodeURIComponent(parts[1]); } catch { return error("invalid cursor", 422); }
      cursorTerms.push({ $or: [
        { to_name: { $gt: name } },
        { to_name: name, conversation_id: { $gt: parts[2] } },
      ] });
    } else {
      const separator = cursorParam.indexOf("|");
      if (separator < 1) return error("invalid cursor", 422);
      const ts = new Date(cursorParam.slice(0, separator));
      const id = cursorParam.slice(separator + 1);
      if (Number.isNaN(ts.getTime()) || !id) return error("invalid cursor", 422);
      const direction = listFilters?.sort === "oldest" ? "$gt" : "$lt";
      cursorTerms.push({ $or: [
        { last_message_timestamp: { [direction]: ts } },
        { last_message_timestamp: ts, conversation_id: { [direction]: id } },
      ] });
    }
  }
  const pageMatch = cursorTerms.length ? { $and: cursorTerms } : {};
  const chatStatus = listFilters?.msgStatus === "unreplied" ? "handoff" : listFilters?.chatStatus;
  const statusStages: Record<string, unknown>[] = chatStatus && chatStatus !== "all" ? [
    { $lookup: { from: COLLECTIONS.testStatusConversation, let: { cid: "$conversation_id" }, pipeline: [
      { $match: { source: "botworker", $expr: { $eq: ["$conversation_id", "$$cid"] } } }, { $limit: 1 },
    ], as: "_status" } },
    { $set: { _meta: { $arrayElemAt: ["$_status", 0] } } },
    { $set: { _effective_status: { $ifNull: ["$_meta.status", {
      $cond: ["$_meta.closed_at", "closed", { $cond: ["$_meta.assigned_to", "handoff", "bot"] }],
    }] } } },
    { $match: { _effective_status: chatStatus } },
  ] : [];
  const filteredMessageStages = listFilters?.msgStatus && listFilters.msgStatus !== "all"
    ? [...unansweredStages("", true), ...messageStatusMatch(listFilters.msgStatus)] : [];
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const docs = await coll.aggregate<ConversationDoc & { _unanswered_count?: number }>([
    { $match: pageMatch }, ...statusStages, ...filteredMessageStages,
    { $sort: sort }, { $limit: limit + 1 },
    ...(filteredMessageStages.length ? [] : unansweredStages("", true)),
  ], { maxTimeMS: 15000, allowDiskUse: true }).toArray();
  const hasMore = docs.length > limit;
  const page = docs.slice(0, limit);
  const totalCount = cursorParam ? 0 : includeCount
    ? statusStages.length || filteredMessageStages.length
      ? ((await coll.aggregate<{ n: number }>([
          { $match: baseMatch }, ...statusStages, ...filteredMessageStages, { $count: "n" },
        ], { maxTimeMS: 15000 }).toArray())[0]?.n ?? 0)
      : await coll.countDocuments(baseMatch)
    : page.length;

  const convIds = page.map((doc) => doc.conversation_id);
  const metaMap = await testStatusConversationService.getTestStatusMap(convIds, "botworker");
  const pinMap = await statusConversationService.getMetaMap(convIds);
  const adminColl = await getCollection<{ admin_id: string; name: string; username: string }>(COLLECTIONS.admins);
  const adminRows = await adminColl.find({}, { projection: { admin_id: 1, name: 1, username: 1 } }).toArray();
  const adminMap = new Map(adminRows.map((row) => [row.admin_id, row.name || row.username || ""]));
  const rows: Conversation[] = page.map((doc) => {
    const meta = metaMap.get(doc.conversation_id);
    const pin = pinMap.get(doc.conversation_id);
    const owner = meta?.assigned_to || null;
    const status = meta?.status || (meta?.closed_at ? "closed" : owner ? "handoff" : "bot");
    return {
      id: doc.conversation_id, platform: doc.platform, shop_id: doc.shop_id,
      shop_name: doc.shop_name, customer_id: doc.customer_id, customer_name: doc.to_name,
      customer_avatar: doc.customer_avatar, item_ids: meta?.item_ids || doc.item_ids || [],
      status, topic: ((meta?.topic as Conversation["topic"]) || (doc.topic as Conversation["topic"]) || "general"),
      last_message: doc.last_message_text, last_timestamp: doc.last_message_timestamp.toISOString(),
      unread: doc._unanswered_count ?? 0, pin_global: pin?.pinned === true,
      pin_personal: (pin?.pinned_by_admin_ids || []).includes(me), assigned_to: owner || undefined,
      assigned_to_name: owner ? adminMap.get(owner) : undefined,
    };
  });
  const last = page.at(-1);
  const nextCursor = last
    ? listFilters?.sort === "name"
      ? `n|${encodeURIComponent(last.to_name || "")}|${last.conversation_id}`
      : `${last.last_message_timestamp.toISOString()}|${last.conversation_id}`
    : null;
  if (!cursorParam) setBotworkerConversationCache({ key: cacheKey, data: rows, totalCount, hasMore, cursor: nextCursor, ts: Date.now() });
  return json({ rows, total_count: totalCount, has_more: hasMore, cursor: nextCursor });
}
