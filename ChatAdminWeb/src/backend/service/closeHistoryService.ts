// Close history service — เก็บประวัติการปิด/เปิดแชท
// ทุกครั้งที่แอดมินปิดแชท จะบันทึก: reason, category, resolution, note
// ทุกครั้งที่ reopen (บอทส่งต่อแอดมิน) จะบันทึก: reopened_by, reason
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";
import type { ProblemCategory } from "./conversationService";

export interface CloseHistoryDoc extends Document {
  record_id: string;
  conversation_id: string;
  shop_id: string;
  customer_id: string;
  // close info
  closed_by: string; // admin_id
  closed_at: Date;
  reason: string;            // เหตุผลที่ปิด (คำอธิบายสั้น)
  category: ProblemCategory; // ประเภทปัญหา
  resolution: string;        // วิธีการแก้ไข
  note?: string;             // หมายเหตุเพิ่มเติม
  // reopen info (กรอกภายหลังเมื่อบอทส่งต่อแอดมิน)
  reopened_by?: string;      // "bot" หรือ admin_id
  reopened_at?: Date;
  reopen_reason?: string;    // เหตุผลที่เปิดใหม่ (เช่น "ลูกค้าทักกลับมา บอทส่งต่อแอดมิน")
  // sequence
  sequence: number; // ครั้งที่ 1, 2, 3...
}

function genRecordId(): string {
  return "chr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** บันทึกการปิดแชท — แอดมินกรอก reason/category/resolution/note */
export async function recordClose(opts: {
  conversationId: string;
  shopId: string;
  customerId: string;
  closedBy: string;
  reason: string;
  category: ProblemCategory;
  resolution: string;
  note?: string;
}): Promise<CloseHistoryDoc> {
  const coll = await getCollection<CloseHistoryDoc>(COLLECTIONS.closeHistory);

  // หา sequence ล่าสุด
  const lastRecord = await coll.findOne(
    { conversation_id: opts.conversationId },
    { sort: { sequence: -1 } }
  );
  const sequence = (lastRecord?.sequence || 0) + 1;

  const doc: CloseHistoryDoc = {
    record_id: genRecordId(),
    conversation_id: opts.conversationId,
    shop_id: opts.shopId,
    customer_id: opts.customerId,
    closed_by: opts.closedBy,
    closed_at: new Date(),
    reason: opts.reason,
    category: opts.category,
    resolution: opts.resolution,
    note: opts.note || "",
    sequence,
  };

  await coll.insertOne(doc);

  await logAdminEvent({
    action_type: "conversation.close",
    actor: opts.closedBy,
    conversation_id: opts.conversationId,
    metadata: {
      reason: opts.reason,
      category: opts.category,
      resolution: opts.resolution,
      sequence,
    },
  });

  return doc;
}

/** บันทึกการ reopen — บอทส่งต่อแอดมิน หรือ แอดมินเปิดใหม่手动 */
export async function recordReopen(opts: {
  conversationId: string;
  reopenedBy: string; // "bot" หรือ admin_id
  reopenReason?: string;
}): Promise<void> {
  const coll = await getCollection<CloseHistoryDoc>(COLLECTIONS.closeHistory);

  // หา record ล่าสุดที่ยังไม่มี reopened_at
  const lastRecord = await coll.findOne(
    { conversation_id: opts.conversationId, reopened_at: { $exists: false } },
    { sort: { sequence: -1 } }
  );

  if (lastRecord) {
    await coll.updateOne(
      { record_id: lastRecord.record_id },
      {
        $set: {
          reopened_by: opts.reopenedBy,
          reopened_at: new Date(),
          reopen_reason: opts.reopenReason || "",
        },
      }
    );
  }

  await logAdminEvent({
    action_type: "conversation.open",
    actor: opts.reopenedBy,
    conversation_id: opts.conversationId,
    metadata: {
      reopen_reason: opts.reopenReason,
      previous_close_sequence: lastRecord?.sequence,
    },
  });
}

/** ดึงประวัติการปิด/เปิด ของ conversation — เรียงจากใหม่ไปเก่า */
export async function listCloseHistory(conversationId: string): Promise<CloseHistoryDoc[]> {
  const coll = await getCollection<CloseHistoryDoc>(COLLECTIONS.closeHistory);
  return coll
    .find({ conversation_id: conversationId })
    .sort({ sequence: -1 })
    .toArray();
}

/** ดึงประวัติการปิด/เปิด ของลูกค้า (ทุก conversation) — ใช้ดูประวัติรวม */
export async function listCustomerCloseHistory(customerId: string): Promise<CloseHistoryDoc[]> {
  const coll = await getCollection<CloseHistoryDoc>(COLLECTIONS.closeHistory);
  return coll
    .find({ customer_id: customerId })
    .sort({ closed_at: -1 })
    .toArray();
}

export const closeHistoryService = {
  recordClose,
  recordReopen,
  listCloseHistory,
  listCustomerCloseHistory,
};
