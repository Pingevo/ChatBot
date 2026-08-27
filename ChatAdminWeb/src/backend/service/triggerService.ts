// Trigger service — new collection `triggers` (no pre-existing schema found).
// Used by the "ทริกเกอร์" admin page: keyword-based rules that decide
// whether the bot answers directly or hands off to an admin.
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { Platform } from "./conversationService";

export type TriggerAction = "bot_answer" | "handoff_admin";

export interface TriggerDoc extends Document {
  trigger_id: string;
  name: string;
  keywords: string[];
  // Phase 7.10 — เปลี่ยนเป็น array (multi-select)
  shop_ids: string[]; // [] = applies to all shops
  platforms: Platform[]; // [] = applies to all platforms
  topic?: string;
  action: TriggerAction;
  bot_template?: string;
  enabled: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  updated_by?: string; // edited by
  // Soft delete
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string;
}

function genTriggerId(): string {
  return "tr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function createTrigger(opts: {
  name: string;
  keywords: string[];
  shopIds?: string[];
  platforms?: Platform[];
  topic?: string;
  action: TriggerAction;
  botTemplate?: string;
  enabled?: boolean;
  createdBy: string;
}): Promise<TriggerDoc> {
  const coll = await getCollection<TriggerDoc>(COLLECTIONS.triggers);
  const now = new Date();
  const doc: TriggerDoc = {
    trigger_id: genTriggerId(),
    name: opts.name,
    keywords: opts.keywords,
    shop_ids: opts.shopIds || [],
    platforms: opts.platforms || [],
    topic: opts.topic,
    action: opts.action,
    bot_template: opts.botTemplate,
    enabled: opts.enabled ?? true,
    created_by: opts.createdBy,
    created_at: now,
    updated_at: now,
  };
  await coll.insertOne(doc);
  return doc;
}

export async function listTriggers(opts: {
  shopId?: string;
  platform?: Platform;
  enabledOnly?: boolean;
} = {}): Promise<TriggerDoc[]> {
  const coll = await getCollection<TriggerDoc>(COLLECTIONS.triggers);
  const filter: Record<string, unknown> = { is_deleted: { $ne: true } };
  if (opts.shopId) filter.$or = [{ shop_ids: opts.shopId }, { shop_ids: { $size: 0 } }];
  if (opts.platform) filter.platforms = { $in: [opts.platform] };
  if (opts.enabledOnly) filter.enabled = true;
  return coll.find(filter).sort({ created_at: -1 }).toArray();
}

export async function getTrigger(triggerId: string): Promise<TriggerDoc | null> {
  const coll = await getCollection<TriggerDoc>(COLLECTIONS.triggers);
  return coll.findOne({ trigger_id: triggerId });
}

export async function updateTrigger(
  triggerId: string,
  fields: Partial<
    Pick<TriggerDoc, "name" | "keywords" | "shop_ids" | "platforms" | "topic" | "action" | "bot_template" | "enabled">
  >,
  updatedBy?: string
): Promise<boolean> {
  const coll = await getCollection<TriggerDoc>(COLLECTIONS.triggers);
  const result = await coll.updateOne(
    { trigger_id: triggerId },
    { $set: { ...fields, updated_at: new Date(), updated_by: updatedBy } }
  );
  return result.modifiedCount > 0;
}

export async function toggleTrigger(triggerId: string, enabled: boolean, updatedBy?: string): Promise<boolean> {
  const coll = await getCollection<TriggerDoc>(COLLECTIONS.triggers);
  const result = await coll.updateOne(
    { trigger_id: triggerId },
    { $set: { enabled, updated_at: new Date(), updated_by: updatedBy } }
  );
  return result.modifiedCount > 0;
}

export async function deleteTrigger(triggerId: string, deletedBy?: string): Promise<boolean> {
  const coll = await getCollection<TriggerDoc>(COLLECTIONS.triggers);
  // Soft delete — never hard delete
  const result = await coll.updateOne(
    { trigger_id: triggerId, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, deleted_at: new Date(), deleted_by: deletedBy, enabled: false } }
  );
  return result.modifiedCount > 0;
}

/** Match a customer message against enabled triggers (simple substring match). */
export async function matchTrigger(
  message: string,
  opts: { shopId?: string; platform?: Platform } = {}
): Promise<TriggerDoc | null> {
  const triggers = await listTriggers({ ...opts, enabledOnly: true });
  const lower = message.toLowerCase();
  for (const t of triggers) {
    if (t.keywords.some((k) => lower.includes(k.toLowerCase()))) {
      return t;
    }
  }
  return null;
}

export const triggerService = {
  createTrigger,
  listTriggers,
  getTrigger,
  updateTrigger,
  toggleTrigger,
  deleteTrigger,
  matchTrigger,
};
