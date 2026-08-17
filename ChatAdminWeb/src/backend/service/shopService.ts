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
}

export async function listShops(platform?: Platform): Promise<ShopDoc[]> {
  const coll = await getCollection<ShopDoc>(COLLECTIONS.shops);
  const filter = platform ? { platform } : {};
  return coll.find(filter).sort({ created_at: -1 }).toArray();
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

export const shopService = {
  listShops,
  getShop,
  upsertShop,
  setShopConnected,
  touchShopSync,
};
