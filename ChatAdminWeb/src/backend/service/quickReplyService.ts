// Quick reply service — admin-configurable canned responses
// แต่ละ admin มี quick replies ของตัวเอง (admin_id)
// ใช้สำหรับให้ admin ตั้งคำตอบสำเร็จรูป เช่น "ขอเลขพัสดุ", "แจ้งเคลม", "นอกเวลาทำการ"
// ตอนแชท admin กดปุ่ม → ส่งคำตอบนั้นทันที
//
// ⚠️ ไม่มีการยิง Shopee API — เก็บใน MongoDB ของเราเท่านั้น
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";

export interface QuickReplyDoc extends Document {
  quick_reply_id: string;
  admin_id: string; // เจ้าของ quick reply คนนี้
  platforms: string[]; // ["shopee","tiktok"] หรือ [] = ทุก platform
  shop_ids: string[]; // ["shop1","shop2"] หรือ [] = ทุกร้านใน platform ที่เลือก
  category: string;
  title: string;
  body: string;
  enabled: boolean;
  sort_order: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  // Soft delete
  is_deleted?: boolean;
  deleted_at?: Date | null;
  deleted_by?: string;
}

function genId(): string {
  return `qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// listQuickReplies — ค่าเริ่มต้นกรองตาม admin_id (ของใครของมัน)
// ถ้าไม่ส่ง adminId จะ return ทั้งหมด (สำหรับ superadmin/dev ดูรวม)
export async function listQuickReplies(opts: {
  adminId?: string;
  platform?: string;
  shopId?: string;
  category?: string;
  enabledOnly?: boolean;
  limit?: number;
} = {}): Promise<QuickReplyDoc[]> {
  const coll = await getCollection<QuickReplyDoc>(COLLECTIONS.quickReplies);
  const filter: Record<string, unknown> = { is_deleted: { $ne: true } };
  if (opts.adminId) filter.admin_id = opts.adminId;
  if (opts.category) filter.category = opts.category;
  if (opts.enabledOnly) filter.enabled = true;
  // กรองตาม platform: แสดง quick reply ที่ platforms ว่าง (ทุก platform) หรือมี platform นี้
  if (opts.platform) {
    filter.$or = [
      { platforms: { $size: 0 } },
      { platforms: opts.platform },
    ];
  }
  // กรองตาม shopId: แสดง quick reply ที่ shop_ids ว่าง (ทุกร้าน) หรือมี shop_id นี้
  if (opts.shopId) {
    const shopCondition = { $or: [{ shop_ids: { $size: 0 } }, { shop_ids: opts.shopId }] };
    filter.$and = filter.$or ? [{ $or: filter.$or }, shopCondition] : [shopCondition];
    delete filter.$or;
  }
  return coll
    .find(filter)
    .sort({ sort_order: 1, created_at: -1 })
    .limit(opts.limit || 200)
    .toArray();
}

export async function createQuickReply(opts: {
  adminId: string;
  platforms?: string[];
  shopIds?: string[];
  category: string;
  title: string;
  body: string;
  createdBy: string;
  sortOrder?: number;
}): Promise<QuickReplyDoc> {
  const coll = await getCollection<QuickReplyDoc>(COLLECTIONS.quickReplies);
  const now = new Date();
  const doc: Omit<QuickReplyDoc, "_id"> = {
    quick_reply_id: genId(),
    admin_id: opts.adminId,
    platforms: opts.platforms ?? [],
    shop_ids: opts.shopIds ?? [],
    category: opts.category,
    title: opts.title,
    body: opts.body,
    enabled: true,
    sort_order: opts.sortOrder ?? 0,
    created_by: opts.createdBy,
    created_at: now,
    updated_at: now,
  };
  const result = await coll.insertOne(doc as QuickReplyDoc);
  const created = (await coll.findOne({ _id: result.insertedId }))!;

  await logAdminEvent({
    action_type: "quick_reply.create",
    actor: opts.createdBy,
    metadata: { quick_reply_id: created.quick_reply_id, title: opts.title, category: opts.category },
  });

  return created;
}

export async function updateQuickReply(
  quickReplyId: string,
  updates: Partial<Pick<QuickReplyDoc, "platforms" | "shop_ids" | "category" | "title" | "body" | "enabled" | "sort_order">>,
  actor?: string
): Promise<boolean> {
  const coll = await getCollection<QuickReplyDoc>(COLLECTIONS.quickReplies);
  const result = await coll.updateOne(
    { quick_reply_id: quickReplyId, is_deleted: { $ne: true } },
    { $set: { ...updates, updated_at: new Date() } }
  );
  if (result.modifiedCount > 0 && actor) {
    await logAdminEvent({
      action_type: "quick_reply.update",
      actor,
      metadata: { quick_reply_id: quickReplyId, changes: updates },
    });
  }
  return result.modifiedCount > 0;
}

export async function deleteQuickReply(quickReplyId: string, deletedBy?: string): Promise<boolean> {
  const coll = await getCollection<QuickReplyDoc>(COLLECTIONS.quickReplies);
  // Soft delete — never hard delete
  const result = await coll.updateOne(
    { quick_reply_id: quickReplyId, is_deleted: { $ne: true } },
    { $set: { is_deleted: true, deleted_at: new Date(), deleted_by: deletedBy, enabled: false } }
  );
  if (result.modifiedCount > 0 && deletedBy) {
    await logAdminEvent({
      action_type: "quick_reply.delete",
      actor: deletedBy,
      metadata: { quick_reply_id: quickReplyId },
    });
  }
  return result.modifiedCount > 0;
}

export async function listCategories(adminId?: string): Promise<string[]> {
  const coll = await getCollection<QuickReplyDoc>(COLLECTIONS.quickReplies);
  const match: Record<string, unknown> = { is_deleted: { $ne: true } };
  if (adminId) match.admin_id = adminId;
  const docs = await coll.aggregate<{ _id: string }>([
    { $match: match },
    { $group: { _id: "$category" } },
    { $sort: { _id: 1 } },
  ]).toArray();
  return docs.map((d) => d._id).filter(Boolean);
}

export const quickReplyService = {
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
  listCategories,
};
