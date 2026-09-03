// Conversation service — real per-conversation storage (fixes the
// "multichat" gap: each conversation now has its own persisted history
// in MongoDB instead of the client re-sending everything or using mock data).
//
// Collection shape mirrors the indexes already provisioned on `conversations`:
//   shop_id_1, conversation_id_1, shop_id_1_conversation_id_1,
//   platform_1_shop_id_1_pinned_-1_last_message_timestamp_-1,
//   platform_1_shop_id_1_unread_count_1_pinned_-1_last_message_timestamp_-1,
//   shop_id_1_to_name_1
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";
import { closeHistoryService } from "./closeHistoryService";
import { safeRegexSearch } from "../lib/regexEscape";

export type Platform = "shopee" | "tiktok" | "lazada";
// "open" = แชทเปิดอยู่ (ใหม่หรือ reopen), "closed" = แอดมินปิดแล้ว
// เก็บค่าเดิมไว้ backward compat: bot/handoff/resolved/pending
export type ConversationStatus = "open" | "closed" | "bot" | "handoff" | "resolved" | "pending";

// ประเภทปัญหา — ใช้ตอนปิดแชท
export type ProblemCategory =
  | "shipping"        // การจัดส่ง
  | "product"         // สินค้า
  | "payment"         // การชำระเงิน
  | "return_refund"   // คืนสินค้า/คืนเงิน
  | "warranty"        // รับประกัน
  | "account"         // บัญชี/ล็อกอิน
  | "promotion"       // โปรโมชั่น/ส่วนลด
  | "other";          // อื่นๆ

export interface ConversationDoc extends Document {
  conversation_id: string;
  shop_id: string;
  shop_name: string;
  platform: Platform;
  customer_id: string;
  to_name: string; // customer display name — matches shop_id_1_to_name_1 index
  customer_avatar?: string;
  status: ConversationStatus;
  topic?: string;
  item_ids?: string[]; // locked product context
  pinned: boolean;
  unread_count: number;
  last_message_text: string;
  last_message_timestamp: Date;
  assigned_to?: string; // admin_id
  created_at: Date;
  updated_at: Date;
  // Phase 5 — close tracking
  closed_at?: Date | null;
  closed_by?: string; // admin_id
  close_count?: number; // จำนวนครั้งที่ปิดแล้วเปิดใหม่
}

function genConversationId(): string {
  return "conv_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function createConversation(opts: {
  shopId: string;
  shopName: string;
  platform: Platform;
  customerId: string;
  toName: string;
  customerAvatar?: string;
  itemIds?: string[];
}): Promise<ConversationDoc> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const now = new Date();
  const doc: ConversationDoc = {
    conversation_id: genConversationId(),
    shop_id: opts.shopId,
    shop_name: opts.shopName,
    platform: opts.platform,
    customer_id: opts.customerId,
    to_name: opts.toName,
    customer_avatar: opts.customerAvatar,
    status: "open",
    item_ids: opts.itemIds || [],
    pinned: false,
    unread_count: 0,
    last_message_text: "",
    last_message_timestamp: now,
    created_at: now,
    updated_at: now,
    closed_at: null,
    close_count: 0,
  };
  await coll.insertOne(doc);
  return doc;
}

/** Find an existing open conversation for a customer, or create one. Used by
 * the data writer layer so each (shop, customer) pair maps to one active thread. */
export async function findOrCreateConversation(opts: {
  shopId: string;
  shopName: string;
  platform: Platform;
  customerId: string;
  toName: string;
  customerAvatar?: string;
}): Promise<ConversationDoc> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  // หา conversation ที่ยังไม่ปิด — ถ้ามี closed อยู่ จะไม่ reuse (ต้อง reopen แทน)
  const existing = await coll.findOne({
    shop_id: opts.shopId,
    customer_id: opts.customerId,
    status: { $nin: ["closed", "resolved"] },
  });
  if (existing) return existing;
  return createConversation(opts);
}

export async function getConversation(conversationId: string): Promise<ConversationDoc | null> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  return coll.findOne({ conversation_id: conversationId });
}

export async function listConversations(opts: {
  platform?: Platform;
  shopId?: string;
  status?: ConversationStatus;
  search?: string;
  limit?: number;
} = {}): Promise<ConversationDoc[]> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const filter: Record<string, unknown> = {};
  if (opts.platform) filter.platform = opts.platform;
  if (opts.shopId) filter.shop_id = opts.shopId;
  if (opts.status) filter.status = opts.status;
  if (opts.search) {
    // 🔒 escape regex metacharacters ป้องกัน $regex injection / ReDoS
    const safeSearch = safeRegexSearch(opts.search);
    if (safeSearch) {
      filter.$or = [
        { to_name: { $regex: safeSearch, $options: "i" } },
        { last_message_text: { $regex: safeSearch, $options: "i" } },
        { shop_name: { $regex: safeSearch, $options: "i" } },
      ];
    }
  }
  return coll
    .find(filter)
    .sort({ pinned: -1, last_message_timestamp: -1 })
    .limit(opts.limit || 200)
    .toArray();
}

export async function updateConversationStatus(
  conversationId: string,
  status: ConversationStatus,
  assignedTo?: string,
  actor?: string
): Promise<boolean> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const update: Record<string, unknown> = { status, updated_at: new Date() };
  if (assignedTo !== undefined) update.assigned_to = assignedTo;
  const result = await coll.updateOne({ conversation_id: conversationId }, { $set: update });
  if (result.modifiedCount > 0 && actor) {
    const actionMap: Record<ConversationStatus, "conversation.open" | "conversation.handoff" | "conversation.resolve" | "conversation.close" | "conversation.status_change"> = {
      open: "conversation.open",
      closed: "conversation.close",
      bot: "conversation.status_change",
      handoff: "conversation.handoff",
      resolved: "conversation.resolve",
      pending: "conversation.status_change",
    };
    await logAdminEvent({
      action_type: actionMap[status],
      actor,
      conversation_id: conversationId,
      metadata: { new_status: status, assigned_to: assignedTo },
    });
  }
  return result.modifiedCount > 0;
}

export async function setConversationTopic(conversationId: string, topic: string): Promise<boolean> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const result = await coll.updateOne(
    { conversation_id: conversationId },
    { $set: { topic, updated_at: new Date() } }
  );
  return result.modifiedCount > 0;
}

export async function setConversationItemIds(conversationId: string, itemIds: string[]): Promise<boolean> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const result = await coll.updateOne(
    { conversation_id: conversationId },
    { $set: { item_ids: itemIds, updated_at: new Date() } }
  );
  return result.modifiedCount > 0;
}

export async function togglePinned(conversationId: string, pinned: boolean): Promise<boolean> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const result = await coll.updateOne({ conversation_id: conversationId }, { $set: { pinned } });
  return result.modifiedCount > 0;
}

/** Bump last_message preview + timestamp, and increment unread_count unless
 * the message came from an admin/bot reply that the admin already sees. */
export async function touchLastMessage(
  conversationId: string,
  text: string,
  incrementUnread: boolean
): Promise<void> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const update: Record<string, unknown> = {
    $set: {
      last_message_text: text,
      last_message_timestamp: new Date(),
      updated_at: new Date(),
    },
  };
  if (incrementUnread) update.$inc = { unread_count: 1 };
  await coll.updateOne({ conversation_id: conversationId }, update);
}

export async function resetUnread(conversationId: string): Promise<void> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  await coll.updateOne({ conversation_id: conversationId }, { $set: { unread_count: 0 } });
}

export const conversationService = {
  createConversation,
  findOrCreateConversation,
  getConversation,
  listConversations,
  updateConversationStatus,
  setConversationTopic,
  setConversationItemIds,
  togglePinned,
  touchLastMessage,
  resetUnread,
  closeConversation,
  reopenConversation,
};

/** ปิดแชท — แอดมินกรอก reason/category/resolution/note */
export async function closeConversation(opts: {
  conversationId: string;
  closedBy: string;
  reason: string;
  category: ProblemCategory;
  resolution: string;
  note?: string;
}): Promise<boolean> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const conv = await coll.findOne({ conversation_id: opts.conversationId });
  if (!conv) return false;

  const closeCount = (conv.close_count || 0) + 1;
  const result = await coll.updateOne(
    { conversation_id: opts.conversationId },
    {
      $set: {
        status: "closed",
        closed_at: new Date(),
        closed_by: opts.closedBy,
        close_count: closeCount,
        updated_at: new Date(),
      },
    }
  );

  if (result.modifiedCount > 0) {
    await closeHistoryService.recordClose({
      conversationId: opts.conversationId,
      shopId: conv.shop_id,
      customerId: conv.customer_id,
      closedBy: opts.closedBy,
      reason: opts.reason,
      category: opts.category,
      resolution: opts.resolution,
      note: opts.note,
    });
    await logAdminEvent({
      action_type: "conversation.close",
      actor: opts.closedBy,
      metadata: {
        conversation_id: opts.conversationId,
        reason: opts.reason,
        category: opts.category,
        close_count: closeCount,
      },
    });
  }

  return result.modifiedCount > 0;
}

/** เปิดแชทใหม่ — ใช้ตอนบอทส่งต่อแอดมิน หรือ แอดมินเปิด手动 */
export async function reopenConversation(opts: {
  conversationId: string;
  reopenedBy: string; // "bot" หรือ admin_id
  reopenReason?: string;
  assignedTo?: string; // ถ้ามีการ assign ใหม่
}): Promise<boolean> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  const update: Record<string, unknown> = {
    status: "open",
    closed_at: null,
    updated_at: new Date(),
  };
  if (opts.assignedTo !== undefined) update.assigned_to = opts.assignedTo;

  const result = await coll.updateOne(
    { conversation_id: opts.conversationId },
    { $set: update }
  );

  if (result.modifiedCount > 0) {
    await closeHistoryService.recordReopen({
      conversationId: opts.conversationId,
      reopenedBy: opts.reopenedBy,
      reopenReason: opts.reopenReason,
    });
    await logAdminEvent({
      action_type: "conversation.open",
      actor: opts.reopenedBy,
      metadata: {
        conversation_id: opts.conversationId,
        reopen_reason: opts.reopenReason,
        assigned_to: opts.assignedTo,
      },
    });
  }

  return result.modifiedCount > 0;
}
