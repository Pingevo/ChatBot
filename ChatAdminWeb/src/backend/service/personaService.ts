// Persona service — per-shop bot persona (admin ตั้งชื่อตัวแทนบอทของแต่ละร้าน)
//
// Schema (เรียบง่ายตามที่ user ยืนยัน):
//   persona_id, shopname, platform, bot_name, enabled, notes?,
//   created_at, updated_at, updated_by?
//
// Default behavior: ถ้าร้านไม่มี persona → chatbot ใช้ "ชื่อร้าน" แบบเดิม
// (ไม่ต้องสร้าง default persona ใน DB — chatbot จะ fallback เอง)
//
// ⚠️ ไม่มีการยิง Shopee/TikTok/Lazada API — เก็บใน MongoDB ของเราเท่านั้น
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";

export type PersonaPlatform = "shopee" | "tiktok" | "lazada";

export interface ShopPersonaDoc extends Document {
  persona_id: string;
  shopname: string; // เช่น "IMILabThailand" — ใช้ shopname เป็น key (ตรงกับที่ chatbot ใช้ใน /chat)
  platform: PersonaPlatform;
  bot_name: string; // เช่น "พิม" / "น้ำหวาน" / "มะยม"
  enabled: boolean;
  notes?: string;
  created_at: Date;
  updated_at: Date;
  updated_by?: string; // admin_id ที่แก้ล่าสุด
  // Soft delete (ตามที่ user ยืนยัน — ไม่ hard delete)
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string;
}

function genId(): string {
  return `persona_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// listPersonas — ดู persona ทั้งหมด (กรองตาม platform หรือคำค้นได้)
// ไม่แสดง persona ที่ถูก soft delete (is_deleted=true)
export async function listPersonas(opts: {
  platform?: PersonaPlatform;
  search?: string;
  enabledOnly?: boolean;
  limit?: number;
} = {}): Promise<ShopPersonaDoc[]> {
  const coll = await getCollection<ShopPersonaDoc>(COLLECTIONS.shopPersonas);
  const filter: Record<string, unknown> = { is_deleted: { $ne: true } };
  if (opts.platform) filter.platform = opts.platform;
  if (opts.enabledOnly) filter.enabled = true;
  if (opts.search) {
    filter.$or = [
      { shopname: { $regex: opts.search, $options: "i" } },
      { bot_name: { $regex: opts.search, $options: "i" } },
    ];
  }
  return coll
    .find(filter)
    .sort({ shopname: 1, platform: 1 })
    .limit(opts.limit || 500)
    .toArray();
}

// getPersona — ดึง persona ของร้าน (ใช้ shopname + platform เป็น key)
// ใช้โดย chatbot proxy route เพื่อส่งให้ Python chatbot
// ไม่คืน persona ที่ถูก soft delete
export async function getPersona(
  shopname: string,
  platform: PersonaPlatform
): Promise<ShopPersonaDoc | null> {
  const coll = await getCollection<ShopPersonaDoc>(COLLECTIONS.shopPersonas);
  return coll.findOne({ shopname, platform, is_deleted: { $ne: true } });
}

// upsertPersona — สร้างหรืออัปเดต persona ของร้าน (1 ร้าน 1 platform = 1 persona)
// ถ้ามีแล้วจะ overwrite bot_name/enabled/notes
// กรอง persona ที่ถูก soft delete ออก (ถ้า soft-deleted แล้ว upsert จะสร้างใหม่แทน)
export async function upsertPersona(opts: {
  shopname: string;
  platform: PersonaPlatform;
  botName: string;
  enabled?: boolean;
  notes?: string;
  updatedBy: string;
}): Promise<ShopPersonaDoc> {
  const coll = await getCollection<ShopPersonaDoc>(COLLECTIONS.shopPersonas);
  const now = new Date();
  const botNameTrimmed = opts.botName.trim();
  if (!botNameTrimmed) throw new Error("bot_name ต้องไม่ว่าง");

  const existing = await coll.findOne({
    shopname: opts.shopname,
    platform: opts.platform,
    is_deleted: { $ne: true },
  });

  if (existing) {
    await coll.updateOne(
      { persona_id: existing.persona_id },
      {
        $set: {
          bot_name: botNameTrimmed,
          enabled: opts.enabled ?? existing.enabled ?? true,
          notes: opts.notes ?? existing.notes,
          updated_at: now,
          updated_by: opts.updatedBy,
        },
      }
    );
    await logAdminEvent({
      action_type: "shop_persona.update",
      actor: opts.updatedBy,
      metadata: {
        persona_id: existing.persona_id,
        shopname: opts.shopname,
        platform: opts.platform,
        bot_name: botNameTrimmed,
        old_bot_name: existing.bot_name,
      },
    });
    return (await coll.findOne({ persona_id: existing.persona_id }))!;
  }

  // สร้างใหม่
  const doc: Omit<ShopPersonaDoc, "_id"> = {
    persona_id: genId(),
    shopname: opts.shopname,
    platform: opts.platform,
    bot_name: botNameTrimmed,
    enabled: opts.enabled ?? true,
    notes: opts.notes,
    created_at: now,
    updated_at: now,
    updated_by: opts.updatedBy,
  };
  await coll.insertOne(doc as ShopPersonaDoc);
  await logAdminEvent({
    action_type: "shop_persona.create",
    actor: opts.updatedBy,
    metadata: {
      persona_id: doc.persona_id,
      shopname: opts.shopname,
      platform: opts.platform,
      bot_name: botNameTrimmed,
    },
  });
  return (await coll.findOne({ persona_id: doc.persona_id }))!;
}

// deletePersona — soft delete persona (ตามที่ user ยืนยัน)
// ตั้ง is_deleted=true + เก็บ deleted_at + deleted_by + log
// หลังลบ chatbot จะ fallback ไปใช้ "ชื่อร้าน" เดิมอัตโนมัติ
export async function deletePersona(
  personaId: string,
  deletedBy?: string
): Promise<boolean> {
  const coll = await getCollection<ShopPersonaDoc>(COLLECTIONS.shopPersonas);
  const existing = await coll.findOne({
    persona_id: personaId,
    is_deleted: { $ne: true },
  });
  if (!existing) return false;
  const result = await coll.updateOne(
    { persona_id: personaId },
    {
      $set: {
        is_deleted: true,
        deleted_at: new Date(),
        deleted_by: deletedBy,
        enabled: false, // ปิดใช้งานด้วย เผื่อ query เก่ายังไม่กรอง is_deleted
        updated_at: new Date(),
        updated_by: deletedBy,
      },
    }
  );
  if (result.modifiedCount > 0 && deletedBy) {
    await logAdminEvent({
      action_type: "shop_persona.delete",
      actor: deletedBy,
      metadata: {
        persona_id: personaId,
        shopname: existing.shopname,
        platform: existing.platform,
        bot_name: existing.bot_name,
      },
    });
  }
  return result.modifiedCount > 0;
}

// togglePersona — เปิด/ปิดใช้งาน persona (ปิด = กลับไปใช้ "ชื่อร้าน" เดิม)
// ไม่ toggle persona ที่ถูก soft delete
export async function togglePersona(
  personaId: string,
  enabled: boolean,
  updatedBy?: string
): Promise<boolean> {
  const coll = await getCollection<ShopPersonaDoc>(COLLECTIONS.shopPersonas);
  const result = await coll.updateOne(
    { persona_id: personaId, is_deleted: { $ne: true } },
    { $set: { enabled, updated_at: new Date(), updated_by: updatedBy } }
  );
  if (result.modifiedCount > 0 && updatedBy) {
    await logAdminEvent({
      action_type: "shop_persona.toggle",
      actor: updatedBy,
      metadata: { persona_id: personaId, enabled },
    });
  }
  return result.modifiedCount > 0;
}

export const personaService = {
  listPersonas,
  getPersona,
  upsertPersona,
  deletePersona,
  togglePersona,
};
