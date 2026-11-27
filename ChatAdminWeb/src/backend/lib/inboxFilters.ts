import { COLLECTIONS } from "@/backend/db/mongoClient";
import type { Platform } from "@/backend/service/conversationService";

export interface InboxQueryFilters {
  platforms: Platform[];
  shops: { platform: Platform; shop_id: string }[];
  chatStatus: "all" | "bot" | "handoff" | "closed";
  msgStatus: "all" | "unread" | "read" | "unreplied";
  sort: "recent" | "oldest" | "name";
}

// ownership statuses ที่เป็น human/lifecycle-managed — นอกเหนือจากนี้ (missing meta, no status, "bot") = bot-owned
export const OWNED_CHAT_STATUSES = ["handoff", "open", "pending", "closed", "resolved"] as const;

export const CONVERSATION_TEXT_SEARCH_FIELDS = [
  "to_name",
  "last_message_text",
  "shop_name",
  "conversation_id",
  "customer_id",
] as const;

const PLATFORMS = new Set(["shopee", "tiktok", "lazada"]);

export function parseInboxFilters(raw: string | null): InboxQueryFilters | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || !Array.isArray(value.platforms) || !Array.isArray(value.shops)) return null;
    if (value.platforms.length > 3 || value.shops.length > 200) return null;
    if (!value.platforms.every((p) => typeof p === "string" && PLATFORMS.has(p))) return null;
    if (!value.shops.every((key) => typeof key === "string" && key.length < 120 && key.includes("|"))) return null;
    if (!["all", "bot", "handoff", "closed"].includes(String(value.chatStatus))) return null;
    if (!["all", "unread", "read", "unreplied"].includes(String(value.msgStatus))) return null;
    if (!["recent", "oldest", "name"].includes(String(value.sort))) return null;
    const shops = (value.shops as string[]).map((key) => {
      const sep = key.indexOf("|");
      return { platform: key.slice(sep + 1) as Platform, shop_id: key.slice(0, sep) };
    });
    if (shops.some((shop) => !PLATFORMS.has(shop.platform) || !shop.shop_id)) return null;
    return {
      platforms: value.platforms as Platform[], shops,
      chatStatus: value.chatStatus as InboxQueryFilters["chatStatus"],
      msgStatus: value.msgStatus as InboxQueryFilters["msgStatus"],
      sort: value.sort as InboxQueryFilters["sort"],
    };
  } catch { return null; }
}

export function unansweredStages(conversationPrefix = "", includeBotworkerAdmin = false): Record<string, unknown>[] {
  const cid = `$${conversationPrefix}conversation_id`;
  return [
    { $lookup: { from: COLLECTIONS.messages, let: { cid }, pipeline: [
      { $match: { direction: "out", $expr: { $eq: ["$conversation_id", "$$cid"] } } },
      { $sort: { created_timestamp: -1 } }, { $limit: 1 },
      { $project: { created_timestamp: 1 } },
    ], as: "_last_out" } },
    ...(includeBotworkerAdmin ? [{ $lookup: { from: COLLECTIONS.botworkerMessages, let: { cid }, pipeline: [
      { $match: { role: "admin", $expr: { $eq: ["$conversation_id", "$$cid"] } } },
      { $sort: { created_at: -1 } }, { $limit: 1 }, { $project: { created_at: 1 } },
    ], as: "_last_sandbox_out" } }] : []),
    { $set: { _last_out_at: { $max: [
      { $ifNull: [{ $arrayElemAt: ["$_last_out.created_timestamp", 0] }, new Date(0)] },
      ...(includeBotworkerAdmin ? [{ $ifNull: [{ $arrayElemAt: ["$_last_sandbox_out.created_at", 0] }, new Date(0)] }] : []),
    ] } } },
    { $lookup: { from: COLLECTIONS.messages, let: { cid, cutoff: "$_last_out_at" }, pipeline: [
      { $match: { role: "user", direction: "in", $expr: { $and: [
        { $eq: ["$conversation_id", "$$cid"] }, { $gt: ["$created_timestamp", "$$cutoff"] },
      ] } } },
      { $count: "n" },
    ], as: "_unanswered" } },
    { $set: { _unanswered_count: { $ifNull: [{ $arrayElemAt: ["$_unanswered.n", 0] }, 0] } } },
  ];
}

export function messageStatusMatch(status: InboxQueryFilters["msgStatus"]): Record<string, unknown>[] {
  if (status === "all") return [];
  return [{ $match: { _unanswered_count: status === "unread" ? { $gt: 0 } : 0 } }];
}
