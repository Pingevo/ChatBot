// Conversation service — raw conversations(_shp) doc access.
// ⚡ ownership/status/pinned/topic/item_ids live in status_conversation (meta) —
//   raw conversations fields are dump-owned and never authoritative.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { getOrderCollection } from "../db/orderMongoClient";
import { statusConversationService } from "./statusConversationService";

export type Platform = "shopee" | "tiktok" | "lazada";
// "open" = แชทเปิดอยู่, "closed" = แอดมินปิดแล้ว — meta statuses: bot/handoff/resolved/pending
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
  assigned_to?: string; // dump field — not authoritative (meta owns assignment)
  created_at: Date;
  updated_at: Date;
  closed_at?: Date | null;
  closed_by?: string;
  close_count?: number;
}

export async function findOrderConversationMatch(orderSn: string): Promise<Pick<ConversationDoc, "customer_id" | "platform" | "shop_id"> | null> {
  const order = await (await getOrderCollection()).findOne(
    { order_sn: orderSn.trim() },
    { projection: { buyer_user_id: 1, shopname: 1 } },
  );
  const buyerUserId = Number(order?.buyer_user_id);
  const shopName = typeof order?.shopname === "string" ? order.shopname.trim() : "";
  if (!Number.isFinite(buyerUserId) || buyerUserId <= 0 || !shopName) return null;

  const shopsColl = await getCollection<{ shop_id?: string }>(COLLECTIONS.shops);
  const shops = await shopsColl.find(
    { platform: "shopee", shopname: shopName },
    { projection: { shop_id: 1 } },
  ).toArray();
  const configuredShopIds = [...new Set(shops
    .map((shop) => shop.shop_id?.trim())
    .filter((shopId): shopId is string => !!shopId))];
  if (configuredShopIds.length !== 1) return null;

  const convColl = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  // shops.shop_id may be a legacy name fallback; resolve transport ID from conversation evidence.
  const directShopIds = [...new Set((await convColl.distinct("shop_id", {
    platform: "shopee",
    shop_id: { $in: configuredShopIds },
  })).filter((shopId): shopId is string => typeof shopId === "string" && !!shopId))];
  let transportShopId = directShopIds.length === 1 ? directShopIds[0] : undefined;
  if (directShopIds.length === 0) {
    const evidenceShopIds = [...new Set((await convColl.distinct("shop_id", {
      platform: "shopee",
      shop_name: shopName,
    })).filter((shopId): shopId is string => typeof shopId === "string" && !!shopId))];
    if (evidenceShopIds.length === 1) transportShopId = evidenceShopIds[0];
  }
  if (!transportShopId) return null;

  return { customer_id: String(buyerUserId), platform: "shopee", shop_id: transportShopId };
}

export async function getConversation(conversationId: string): Promise<ConversationDoc | null> {
  const coll = await getCollection<ConversationDoc>(COLLECTIONS.conversations);
  return coll.findOne({ conversation_id: conversationId });
}

export async function updateConversationStatus(
  conversationId: string,
  status: ConversationStatus,
  assignedTo?: string | null,
  actor?: string
): Promise<boolean> {
  return statusConversationService.updateStatus(conversationId, status, assignedTo, actor);
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

export const conversationService = {
  getConversation,
  updateConversationStatus,
  touchLastMessage,
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

  return statusConversationService.closeConversation({
    conversationId: opts.conversationId,
    closedBy: opts.closedBy,
    reason: opts.reason,
    category: opts.category,
    resolution: opts.resolution,
    note: opts.note,
    shopId: conv.shop_id,
    customerId: conv.customer_id,
  });
}

/** เปิดแชทใหม่ — targetStatus: "handoff" (แอดมิน) | "bot" (ลูกค้าทักกลับ) */
export async function reopenConversation(opts: {
  conversationId: string;
  reopenedBy: string; // "bot" หรือ admin_id
  reopenReason?: string;
  assignedTo?: string; // ถ้ามีการ assign ใหม่
  targetStatus?: "handoff" | "bot";
}): Promise<boolean> {
  return statusConversationService.reopenConversation(opts);
}
