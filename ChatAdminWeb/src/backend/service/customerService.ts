// Customer service — real schema mirrors indexes on `customers`:
// platform_1, buyer_id_1, name_1, platform_1_buyer_id_1,
// platform_1_last_active_at_-1, platform_1_name_1.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./conversationService";

export interface CustomerDoc extends Document {
  platform: Platform;
  buyer_id: string;
  name: string;
  avatar?: string;
  last_active_at: Date;
  created_at: Date;
}

export async function upsertCustomer(opts: {
  platform: Platform;
  buyerId: string;
  name: string;
  avatar?: string;
}): Promise<CustomerDoc> {
  const coll = await getCollection<CustomerDoc>(COLLECTIONS.customers);
  const now = new Date();
  await coll.updateOne(
    { platform: opts.platform, buyer_id: opts.buyerId },
    {
      $set: { name: opts.name, avatar: opts.avatar, last_active_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  );
  return (await coll.findOne({ platform: opts.platform, buyer_id: opts.buyerId }))!;
}

export async function getCustomer(platform: Platform, buyerId: string): Promise<CustomerDoc | null> {
  const coll = await getCollection<CustomerDoc>(COLLECTIONS.customers);
  return coll.findOne({ platform, buyer_id: buyerId });
}

export const customerService = {
  upsertCustomer,
  getCustomer,
};
