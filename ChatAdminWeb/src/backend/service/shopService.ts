// Shop service — real schema mirrors indexes on `shops`:
// shop_id_1, shopname_1, platform_1_shop_id_1.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { safeRegexSearch } from "../lib/regexEscape";
import { BOTWORKER_BACKENDS } from "../lib/safety";
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
  // ⚡ Phase 2D — per-shop botworker admission (missing = OFF; แยกจาก
  //   connected/enabled_for_chat — admission ต้อง global+platform+shop ทั้งสามชั้น)
  bot_worker_enabled?: boolean;
  // ⚡ enable rising-edge — เขียน/ล้างใน CAS เดียวกับ flag; flag=true แต่ตัวนี้
  //   หาย/null → resolver fail-closed
  bot_worker_enabled_at?: Date | null;
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
    // 🔒 escape regex
    const safeSearch = safeRegexSearch(opts.search);
    if (safeSearch) {
      filter.$or = [
        { shopname: { $regex: safeSearch, $options: "i" } },
        { shop_id: { $regex: safeSearch, $options: "i" } },
      ];
    }
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
        bot_worker_enabled: false,
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

/**
 * Phase 2D — per-shop botworker admission toggle (ขั้นที่ 3 ของ admission:
 *   global + platform + shop; missing = OFF; ไม่แตะ connected/enabled_for_chat)
 * Optimistic CAS: เขียนได้ก็ต่อเมื่อ persisted === expected
 *   (missing ≡ false); matchedCount===1 = success — write ซ้ำค่าเดิมก็ถือสำเร็จ
 *   (idempotent) จึงใช้ matchedCount ไม่ใช่ modifiedCount
 * เมื่อ enable → filter เพิ่ม platform fence `platform ∈ BOTWORKER_BACKENDS`
 *   ใน updateOne เดียวกัน — กัน race platform flip ระหว่าง route pre-read กับ write
 *   (sync เปลี่ยน platform เป็น unsupported ระหว่างนั้น → CAS miss → route map 422)
 * เมื่อ disable → ไม่ fence platform — latent true ต้อง clear ได้เสมอ
 * คืน true ถ้า CAS match, false = miss (caller re-read แยก 404/422/409)
 */
export async function setShopBotWorker(
  shopId: string,
  enabled: boolean,
  expected: boolean
): Promise<boolean> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  const filter: Record<string, unknown> = expected
    ? { shop_id: shopId, bot_worker_enabled: true }
    : {
        shop_id: shopId,
        $or: [{ bot_worker_enabled: false }, { bot_worker_enabled: { $exists: false } }],
      };
  // ⚡ desired === caller's expected persisted state → idempotent no-op — probe
  //   เท่านั้น (zero write): enable edge ห้ามขยับ; persisted≠expected → miss → 409
  if (enabled === expected) {
    return (await coll.findOne(filter, { projection: { _id: 1 } })) !== null;
  }
  if (enabled) filter.platform = { $in: [...BOTWORKER_BACKENDS] };
  const now = new Date();
  // ⚡ enable edge ใน write เดียวกัน — true→stamp now / false→clear null (atomic)
  const result = await coll.updateOne(
    filter,
    { $set: { bot_worker_enabled: enabled, bot_worker_enabled_at: enabled ? now : null, updated_at: now } }
  );
  return result.matchedCount === 1;
}

export const shopService = {
  listShops,
  listShopsPaged,
  getShop,
  upsertShop,
  setShopConnected,
  touchShopSync,
  toggleShopChatSync,
  setShopBotWorker,
};
