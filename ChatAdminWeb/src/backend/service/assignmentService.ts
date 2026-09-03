// Assignment service — adapted from ChatBotPDigg/src/services/chatAssignment.js
// ระบบแบ่งงานแชทแบบ round-robin 3 โหมด:
// 1. equal_global — วนทุก agent ทั้งระบบ 1→2→3→1
// 2. equal_per_shop — วนเฉพาะ agent ในทีมของร้านนั้น
// 3. equal_per_platform — วนเฉพาะ agent ตามแพลตฟอร์ม (shopee/lazada/tiktok)
//
// ⚠️ ไม่มีการยิง Shopee API ใดๆ — ทำงานใน MongoDB ของเราเท่านั้น
import { Document, ObjectId } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";

export type AssignmentMode = "equal_global" | "equal_per_shop" | "equal_per_platform";

export interface AssignmentConfigDoc extends Document {
  config_key: string;
  mode: AssignmentMode;
  updated_by: string;
  updated_at: Date;
}

export interface AssignmentCursorDoc extends Document {
  pool_key: string;
  last_assigned_admin_id: string;
  updated_at: Date;
}

export interface ShopTeamAssignmentDoc extends Document {
  shop_id: string;
  admin_id: string;
  is_active: boolean;
  role_on_shop?: string;
  added_at: Date;
}

export interface PlatformTeamAssignmentDoc extends Document {
  platform: string;
  admin_id: string;
  is_active: boolean;
  added_at: Date;
}

// รายชื่อ agent ทั้งหมดเรียงตามวันที่สร้างบัญชี — ใช้เป็น pool กลางของโหมด global
// ใช้ admin_id (string) ทั้งระบบเพื่อให้ตรงกับ shopTeamAssignments / platformTeamAssignments
// ⚠️ เฉพาะ role=admin เท่านั้นที่ถูกจ่ายแชท — superadmin และ dev ไม่ถูกจ่าย
// ⚠️ Phase 7.9 — กรองเฉพาะที่ is_accepting_chats !== false (คนลาหยุดจะไม่ถูกจ่าย)
async function allAgentsOrdered(): Promise<string[]> {
  const coll = await getCollection<{ admin_id: string; created_at: Date; active: boolean; role: string; is_accepting_chats?: boolean }>(COLLECTIONS.admins);
  const docs = await coll
    .find({ active: { $ne: false }, role: "admin", is_accepting_chats: { $ne: false } })
    .sort({ created_at: 1 })
    .project<{ admin_id: string }>({ admin_id: 1 })
    .toArray();
  return docs.map((d) => d.admin_id).filter(Boolean);
}

// สร้าง { poolKey, orderedAgentIds } ตามโหมด — จุดเดียวที่ตัดสินใจ "ขอบเขตคิว"
// ⚠️ กรองเฉพาะ role=admin เท่านั้น — superadmin และ dev ไม่ถูกจ่ายแชท
async function buildPool(
  mode: AssignmentMode,
  shop: { shop_id: string; platform: string }
): Promise<{ poolKey: string; orderedAgentIds: string[] }> {
  // ดึง admin_ids ที่เป็น role=admin ทั้งหมด เพื่อใช้กรอง
  const adminOnlyIds = new Set(await allAgentsOrdered());

  if (mode === "equal_per_shop") {
    const coll = await getCollection<ShopTeamAssignmentDoc>(COLLECTIONS.shopTeamAssignments);
    const rows = await coll
      .find({ shop_id: shop.shop_id, is_active: true })
      .sort({ added_at: 1 })
      .project<{ admin_id: string }>({ admin_id: 1 })
      .toArray();
    // กรองเฉพาะที่เป็น role=admin
    const agentIds = rows.map((r) => r.admin_id).filter((id) => id && adminOnlyIds.has(id));
    // ถ้าไม่มีทีมร้านเลย → fallback ใช้ทุก admin (กันงานตกหล่น)
    const finalIds = agentIds.length > 0 ? agentIds : Array.from(adminOnlyIds);
    return { poolKey: `shop:${shop.shop_id}`, orderedAgentIds: finalIds };
  }
  if (mode === "equal_per_platform") {
    const coll = await getCollection<PlatformTeamAssignmentDoc>(COLLECTIONS.platformTeamAssignments);
    const rows = await coll
      .find({ platform: shop.platform, is_active: true })
      .sort({ added_at: 1 })
      .project<{ admin_id: string }>({ admin_id: 1 })
      .toArray();
    // กรองเฉพาะที่เป็น role=admin
    const agentIds = rows.map((r) => r.admin_id).filter((id) => id && adminOnlyIds.has(id));
    // ถ้าไม่มีทีมแพลตฟอร์มเลย → fallback ใช้ทุก admin (กันงานตกหล่น)
    const finalIds = agentIds.length > 0 ? agentIds : Array.from(adminOnlyIds);
    return { poolKey: `platform:${shop.platform}`, orderedAgentIds: finalIds };
  }
  // equal_global (default)
  return { poolKey: "global", orderedAgentIds: Array.from(adminOnlyIds) };
}

// เดินคิว 1→2→3→4→1 ไม่สนภาระงาน — ข้าม agent ที่ active=false แต่ไม่ขยับตำแหน่งคิว
// ใช้ admin_id (string) ทั้งระบบ
// ⚠️ เช็คเพิ่มว่า role=admin เท่านั้น (กันกรณี role เปลี่ยนหลังเข้าคิว)
async function pickNextAgent(
  poolKey: string,
  orderedAgentIds: string[]
): Promise<string | null> {
  if (!orderedAgentIds.length) return null;

  const cursorColl = await getCollection<AssignmentCursorDoc>(COLLECTIONS.assignmentCursors);
  const cursor = await cursorColl.findOne({ pool_key: poolKey });
  const lastId = cursor?.last_assigned_admin_id ? String(cursor.last_assigned_admin_id) : null;
  const startIdx = lastId ? orderedAgentIds.findIndex((id) => String(id) === lastId) : -1;

  const adminColl = await getCollection<{
    admin_id: string; active: boolean; role: string; is_accepting_chats?: boolean;
  }>(COLLECTIONS.admins);

  for (let step = 1; step <= orderedAgentIds.length; step++) {
    const idx = (startIdx + step + orderedAgentIds.length) % orderedAgentIds.length;
    const agentId = orderedAgentIds[idx];
    // eslint-disable-next-line no-await-in-loop
    const agent = await adminColl.findOne({
      admin_id: agentId,
      active: { $ne: false },
      role: "admin",
      is_accepting_chats: { $ne: false },
    });
    if (agent) {
      await cursorColl.updateOne(
        { pool_key: poolKey },
        { $set: { last_assigned_admin_id: agentId, updated_at: new Date() } },
        { upsert: true }
      );
      return agentId;
    }
  }
  return null; // ทั้งคิวพักหมด
}

// ดึง config ปัจจุบัน — สร้าง default ถ้ายังไม่มี
export async function getActiveAssignmentConfig(): Promise<AssignmentMode> {
  const coll = await getCollection<AssignmentConfigDoc>(COLLECTIONS.assignmentConfigs);
  let config = await coll.findOne({ config_key: "main_config" });
  if (!config) {
    await coll.insertOne({
      config_key: "main_config",
      mode: "equal_global",
      updated_by: "initial_setup",
      updated_at: new Date(),
    } as AssignmentConfigDoc);
    config = await coll.findOne({ config_key: "main_config" });
  }
  return config?.mode || "equal_global";
}

// ตั้งโหมด assignment
export async function setAssignmentMode(mode: AssignmentMode, updatedBy = "admin"): Promise<void> {
  const coll = await getCollection<AssignmentConfigDoc>(COLLECTIONS.assignmentConfigs);
  await coll.updateOne(
    { config_key: "main_config" },
    { $set: { mode, updated_by: updatedBy, updated_at: new Date() } },
    { upsert: true }
  );
  await logAdminEvent({
    action_type: "assignment.mode_change",
    actor: updatedBy,
    metadata: { mode },
  });
}

// เรียกตอนมีข้อความขาเข้าใหม่ — assign แบบ atomic กัน race condition
export async function autoAssignConversation(conv: {
  _id?: ObjectId;
  conversation_id: string;
  shop_id: string;
  platform: string;
  assigned_to?: string | null;
}): Promise<string | null> {
  if (conv.assigned_to) return null; // มีคนรับผิดชอบอยู่แล้ว

  const shopColl = await getCollection<{ shop_id: string; platform: string; enabled_for_chat: boolean }>(COLLECTIONS.shops);
  const shop = await shopColl.findOne({ shop_id: conv.shop_id, platform: conv.platform });
  if (!shop) return null;
  // ถ้าร้านปิดดึงข้อความแล้ว → ไม่มอบหมาย
  if (shop.enabled_for_chat === false) return null;

  const mode = await getActiveAssignmentConfig();
  const { poolKey, orderedAgentIds } = await buildPool(mode, shop);
  if (!orderedAgentIds.length) return null;

  const agentId = await pickNextAgent(poolKey, orderedAgentIds);
  if (!agentId) return null;

  // Atomic guard — กันสองแชทชนกัน
  const convColl = await getCollection<{
    _id: ObjectId; conversation_id: string; assigned_to: string | null; assigned_at: Date; assignment_mode_used: string;
  }>(COLLECTIONS.conversations);
  // ⚡ รองรับกรณี caller ส่งแค่ conversation_id (ไม่มี _id) — เช่น handoffService
  const filter = conv._id
    ? { _id: conv._id, assigned_to: null }
    : { conversation_id: conv.conversation_id, assigned_to: null };
  const updated = await convColl.findOneAndUpdate(
    filter,
    { $set: { assigned_to: agentId, assigned_at: new Date(), assignment_mode_used: mode } },
    { returnDocument: "after" }
  );
  if (!updated) return null; // มีคนอื่น assign ไปแล้ว — เสียตาคิวไปหนึ่งตา ยอมรับได้

  await logAdminEvent({
    action_type: "chat_assigned",
    actor: "system",
    target_admin_id: agentId,
    conversation_id: conv.conversation_id,
    shop_id: conv.shop_id,
    metadata: { mode_used: mode, pool_size: orderedAgentIds.length },
  });

  return agentId;
}

// lead/admin ย้ายงานเอง — ไม่แตะคิว round-robin
export async function reassignConversation(
  conv: { _id: ObjectId; conversation_id: string; shop_id: string; assigned_to?: string | null },
  newAgentId: string | null,
  actor: string,
  reason?: string
): Promise<void> {
  const fromAdminId = conv.assigned_to || null;
  const mode = await getActiveAssignmentConfig();

  const convColl = await getCollection<{
    assigned_to: string | null; assigned_at: Date; assignment_mode_used: string;
  }>(COLLECTIONS.conversations);
  await convColl.updateOne(
    { _id: conv._id },
    { $set: { assigned_to: newAgentId, assigned_at: new Date(), assignment_mode_used: mode } }
  );

  await logAdminEvent({
    action_type: "chat_reassigned",
    actor,
    target_admin_id: newAgentId,
    conversation_id: conv.conversation_id,
    shop_id: conv.shop_id,
    metadata: { from_admin_id: fromAdminId, reason: reason || null },
  });
}

// เพิ่ม/ลบ agent ในทีมของร้าน
export async function addAgentToShop(shopId: string, adminId: string, roleOnShop?: string): Promise<void> {
  const coll = await getCollection<ShopTeamAssignmentDoc>(COLLECTIONS.shopTeamAssignments);
  await coll.updateOne(
    { shop_id: shopId, admin_id: adminId },
    { $set: { is_active: true, role_on_shop: roleOnShop }, $setOnInsert: { added_at: new Date() } },
    { upsert: true }
  );
  await logAdminEvent({
    action_type: "assignment.shop_team_add",
    actor: adminId,
    metadata: { shop_id: shopId, role_on_shop: roleOnShop },
  });
}

export async function removeAgentFromShop(shopId: string, adminId: string): Promise<void> {
  const coll = await getCollection<ShopTeamAssignmentDoc>(COLLECTIONS.shopTeamAssignments);
  await coll.updateOne(
    { shop_id: shopId, admin_id: adminId },
    { $set: { is_active: false } }
  );
  await logAdminEvent({
    action_type: "assignment.shop_team_remove",
    actor: adminId,
    metadata: { shop_id: shopId },
  });
}

// เพิ่ม/ลบ agent ในทีมของแพลตฟอร์ม
export async function addAgentToPlatform(platform: string, adminId: string): Promise<void> {
  const coll = await getCollection<PlatformTeamAssignmentDoc>(COLLECTIONS.platformTeamAssignments);
  await coll.updateOne(
    { platform, admin_id: adminId },
    { $set: { is_active: true }, $setOnInsert: { added_at: new Date() } },
    { upsert: true }
  );
  await logAdminEvent({
    action_type: "assignment.platform_team_add",
    actor: adminId,
    metadata: { platform },
  });
}

export async function removeAgentFromPlatform(platform: string, adminId: string): Promise<void> {
  const coll = await getCollection<PlatformTeamAssignmentDoc>(COLLECTIONS.platformTeamAssignments);
  await coll.updateOne(
    { platform, admin_id: adminId },
    { $set: { is_active: false } }
  );
  await logAdminEvent({
    action_type: "assignment.platform_team_remove",
    actor: adminId,
    metadata: { platform },
  });
}

export const assignmentService = {
  getActiveAssignmentConfig,
  setAssignmentMode,
  autoAssignConversation,
  reassignConversation,
  addAgentToShop,
  removeAgentFromShop,
  addAgentToPlatform,
  removeAgentFromPlatform,
  buildPool,
  pickNextAgent,
};
