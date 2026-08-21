// Shop service — real schema mirrors indexes on `shops`:
// shop_id_1, shopname_1, platform_1_shop_id_1.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./conversationService";

export interface ShopDoc extends Document {
  shop_id: string;
  shopname: string;
  platform: Platform;
  connected: boolean;
  conversation_count: number;
  product_count: number;
  last_sync_at?: Date | null;
  created_at: Date;
  updated_at: Date;
  // Phase 1 — per-shop sync toggle (adapted from ChatBotPDigg Shop model)
  enabled_for_chat: boolean;
  disabled_by_user: boolean;
  last_polled_at?: Date | null;
  status?: "active" | "token_error" | "disabled";
}

export async function listShops(platform?: Platform): Promise<ShopDoc[]> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  const filter = platform ? { platform } : {};
  return coll.find(filter).sort({ created_at: -1 }).toArray();
}

/**
 * List shops with search, platform filter, sorting and pagination.
 * Returns { rows, total } — used by the improved /shops page.
 */
export async function listShopsPaged(opts: {
  platform?: Platform;
  search?: string;
  sortBy?: "shopname" | "created_at" | "conversation_count" | "product_count";
  sortDir?: 1 | -1;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ rows: ShopDoc[]; total: number }> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  const filter: Record<string, unknown> = {};
  if (opts.platform) filter.platform = opts.platform;
  if (opts.search) {
    filter.$or = [
      { shopname: { $regex: opts.search, $options: "i" } },
      { shop_id: { $regex: opts.search, $options: "i" } },
    ];
  }
  const sortBy = opts.sortBy || "created_at";
  const sortDir = opts.sortDir || -1;
  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
  const [rows, total] = await Promise.all([
    coll
      .find(filter)
      .sort({ [sortBy]: sortDir })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    coll.countDocuments(filter),
  ]);
  return { rows, total };
}

export async function getShop(shopId: string): Promise<ShopDoc | null> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  return coll.findOne({ shop_id: shopId });
}

export async function upsertShop(opts: {
  shopId: string;
  shopname: string;
  platform: Platform;
}): Promise<ShopDoc> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  const now = new Date();
  await coll.updateOne(
    { shop_id: opts.shopId },
    {
      $set: { shopname: opts.shopname, platform: opts.platform, updated_at: now },
      $setOnInsert: {
        connected: true,
        conversation_count: 0,
        product_count: 0,
        enabled_for_chat: false,
        disabled_by_user: false,
        created_at: now,
      },
    },
    { upsert: true }
  );
  return (await coll.findOne({ shop_id: opts.shopId }))!;
}

export async function setShopConnected(shopId: string, connected: boolean): Promise<boolean> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  const result = await coll.updateOne(
    { shop_id: shopId },
    { $set: { connected, updated_at: new Date() } }
  );
  return result.modifiedCount > 0;
}

export async function touchShopSync(shopId: string): Promise<void> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  await coll.updateOne({ shop_id: shopId }, { $set: { last_sync_at: new Date() } });
}

/**
 * Toggle per-shop chat sync — adapted from ChatBotPDigg
 * PATCH /api/config/shopee/shop/:shop_id/toggle
 *
 * enabled_for_chat = ร้านนี้เปิดให้ background sync ดึงข้อความจาก dbWallet หรือไม่
 * disabled_by_user = ผู้ใช้สั่งปิดเอง (กัน sync auto re-enable ทับ)
 */
export async function toggleShopChatSync(shopId: string, enabledForChat: boolean): Promise<ShopDoc | null> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  await coll.updateOne(
    { shop_id: shopId },
    { $set: { enabled_for_chat: enabledForChat, disabled_by_user: !enabledForChat, updated_at: new Date() } }
  );
  return coll.findOne({ shop_id: shopId });
}

export const shopService = {
  listShops,
  listShopsPaged,
  getShop,
  upsertShop,
  setShopConnected,
  touchShopSync,
  toggleShopChatSync,
};
