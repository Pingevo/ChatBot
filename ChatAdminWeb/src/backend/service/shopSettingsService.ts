// ShopSettings service — per-shop behavior settings
//
// ตอนนี้รองรับ:
//   - faq_liveagent_action: "handoff" | "bot_reply" (default "handoff")
//   - faq_liveagent_enabled: boolean (default true — เปิดใช้งานการตอบสนอง faq_liveagent)
//
// ใช้ shopname + platform เป็น key (เหมือน persona)
// ถ้าร้านไม่มี settings → ใช้ default (handoff + enabled)
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";
import { safeRegexSearch } from "../lib/regexEscape";
import type { PersonaPlatform } from "./personaService";

export type FaqLiveagentAction = "handoff" | "bot_reply";

export interface ShopSettingsDoc extends Document {
  settings_id: string;
  shopname: string;
  platform: PersonaPlatform;
  // faq_liveagent behavior
  faq_liveagent_enabled: boolean; // เปิด/ปิด การตอบสนอง faq_liveagent
  faq_liveagent_action: FaqLiveagentAction; // "handoff" = ส่งแอดมิน, "bot_reply" = ให้บอทตอบ
  notes?: string;
  created_at: Date;
  updated_at: Date;
  updated_by?: string;
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string;
}

function genId(): string {
  return `settings_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ค่า default ถ้าร้านไม่มี settings
export const DEFAULT_SHOP_SETTINGS = {
  faq_liveagent_enabled: true,
  faq_liveagent_action: "handoff" as FaqLiveagentAction,
};

// listShopSettings — ดู settings ทั้งหมด
export async function listShopSettings(opts: {
  platform?: PersonaPlatform;
  search?: string;
  limit?: number;
} = {}): Promise<ShopSettingsDoc[]> {
  const coll = await getCollection<ShopSettingsDoc>(COLLECTIONS.shopSettings);
  const filter: Record<string, unknown> = { is_deleted: { $ne: true } };
  if (opts.platform) filter.platform = opts.platform;
  if (opts.search) {
    // 🔒 escape regex
    const safeSearch = safeRegexSearch(opts.search);
    if (safeSearch) {
      filter.shopname = { $regex: safeSearch, $options: "i" };
    }
  }
  return coll
    .find(filter)
    .sort({ shopname: 1, platform: 1 })
    .limit(opts.limit || 500)
    .toArray();
}

// getShopSettings — ดึง settings ของร้าน (ใช้ shopname + platform เป็น key)
// ถ้าไม่มี → คืน null (caller ใช้ DEFAULT_SHOP_SETTINGS)
export async function getShopSettings(
  shopname: string,
  platform: PersonaPlatform
): Promise<ShopSettingsDoc | null> {
  const coll = await getCollection<ShopSettingsDoc>(COLLECTIONS.shopSettings);
  return coll.findOne({ shopname, platform, is_deleted: { $ne: true } });
}

// upsertShopSettings — สร้างหรืออัปเดต settings ของร้าน
export async function upsertShopSettings(opts: {
  shopname: string;
  platform: PersonaPlatform;
  faq_liveagent_enabled?: boolean;
  faq_liveagent_action?: FaqLiveagentAction;
  notes?: string;
  updatedBy: string;
}): Promise<ShopSettingsDoc> {
  const coll = await getCollection<ShopSettingsDoc>(COLLECTIONS.shopSettings);
  const now = new Date();

  const existing = await coll.findOne({
    shopname: opts.shopname,
    platform: opts.platform,
    is_deleted: { $ne: true },
  });

  const updates: Partial<ShopSettingsDoc> = {};
  if (opts.faq_liveagent_enabled !== undefined)
    updates.faq_liveagent_enabled = opts.faq_liveagent_enabled;
  if (opts.faq_liveagent_action !== undefined)
    updates.faq_liveagent_action = opts.faq_liveagent_action;
  if (opts.notes !== undefined) updates.notes = opts.notes;
  updates.updated_at = now;
  updates.updated_by = opts.updatedBy;

  if (existing) {
    await coll.updateOne(
      { settings_id: existing.settings_id },
      { $set: updates }
    );
    await logAdminEvent({
      action_type: "shop_settings.update",
      actor: opts.updatedBy,
      metadata: {
        settings_id: existing.settings_id,
        shopname: opts.shopname,
        platform: opts.platform,
        ...updates,
      },
    });
    return (await coll.findOne({ settings_id: existing.settings_id }))!;
  }

  // สร้างใหม่
  const doc: Omit<ShopSettingsDoc, "_id"> = {
    settings_id: genId(),
    shopname: opts.shopname,
    platform: opts.platform,
    faq_liveagent_enabled: opts.faq_liveagent_enabled ?? DEFAULT_SHOP_SETTINGS.faq_liveagent_enabled,
    faq_liveagent_action: opts.faq_liveagent_action ?? DEFAULT_SHOP_SETTINGS.faq_liveagent_action,
    notes: opts.notes,
    created_at: now,
    updated_at: now,
    updated_by: opts.updatedBy,
  };
  await coll.insertOne(doc as ShopSettingsDoc);
  await logAdminEvent({
    action_type: "shop_settings.create",
    actor: opts.updatedBy,
    metadata: {
      settings_id: doc.settings_id,
      shopname: doc.shopname,
      platform: doc.platform,
    },
  });
  return (await coll.findOne({ settings_id: doc.settings_id }))!;
}

// deleteShopSettings — soft delete
export async function deleteShopSettings(
  settingsId: string,
  deletedBy?: string
): Promise<boolean> {
  const coll = await getCollection<ShopSettingsDoc>(COLLECTIONS.shopSettings);
  const existing = await coll.findOne({
    settings_id: settingsId,
    is_deleted: { $ne: true },
  });
  if (!existing) return false;
  const result = await coll.updateOne(
    { settings_id: settingsId },
    {
      $set: {
        is_deleted: true,
        deleted_at: new Date(),
        deleted_by: deletedBy,
        updated_at: new Date(),
        updated_by: deletedBy,
      },
    }
  );
  if (result.modifiedCount > 0 && deletedBy) {
    await logAdminEvent({
      action_type: "shop_settings.delete",
      actor: deletedBy,
      metadata: { settings_id: settingsId, shopname: existing.shopname },
    });
  }
  return result.modifiedCount > 0;
}

// upsertShopSettingsBatch — สร้าง/อัปเดต settings หลายร้านพร้อมกัน
// ใช้ตอน admin เลือกหลาย platform + หลายร้านในฟอร์ม
// คืน array ของ docs ที่สร้าง/อัปเดต
export async function upsertShopSettingsBatch(opts: {
  shops: string[];
  platforms: PersonaPlatform[];
  faq_liveagent_enabled?: boolean;
  faq_liveagent_action?: FaqLiveagentAction;
  notes?: string;
  updatedBy: string;
}): Promise<ShopSettingsDoc[]> {
  const results: ShopSettingsDoc[] = [];
  for (const shopname of opts.shops) {
    for (const platform of opts.platforms) {
      const doc = await upsertShopSettings({
        shopname,
        platform,
        faq_liveagent_enabled: opts.faq_liveagent_enabled,
        faq_liveagent_action: opts.faq_liveagent_action,
        notes: opts.notes,
        updatedBy: opts.updatedBy,
      });
      results.push(doc);
    }
  }
  return results;
}

export const shopSettingsService = {
  listShopSettings,
  getShopSettings,
  upsertShopSettings,
  upsertShopSettingsBatch,
  deleteShopSettings,
};
