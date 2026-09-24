// statusConversationService — เก็บสถานะแชทจริง แยกจาก conversations ที่ถูก dump ทุก 2 วิ
// ⚡ Phase 2J — กัน sellcenter dump ทับข้อมูลที่เราเขียน (assigned_to, status, closed_at, etc.)
//
// collection: status_conversation (จริง — ใช้กับ /tickets เท่านั้น)
//   ส่วน test_status_conversation ใช้กับหน้า test (test-assignment, shadowbot, replay-compare, test-chat)
// key: conversation_id (unique)
//
// fields ที่ย้ายมา:
//   - assigned_to, assigned_at, assignment_mode_used
//   - status (bot/handoff/closed — เขียนโดยระบบเราเท่านั้น)
//   - closed_at, closed_by, close_count
//   - pinned, topic, item_ids
//   - updated_at
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { logAdminEvent } from "./adminLogService";
import { closeHistoryService } from "./closeHistoryService";
import type { ConversationStatus, ProblemCategory } from "./conversationService";

export interface StatusConversationDoc {
  conversation_id: string;
  // assignment
  assigned_to?: string | null;
  assigned_at?: Date;
  assignment_mode_used?: string;
  // status (admin-owned — ไม่โดน dump ทับ)
  status?: ConversationStatus;
  // close tracking
  closed_at?: Date | null;
  closed_by?: string;
  close_count?: number;
  // ⚡ pending backlog — handoff แล้วหา admin ไม่ได้ → รอ manual distributor จ่าย
  pending_assignment?: boolean;
  assignment_reason?: string;
  // other admin-owned fields
  pinned?: boolean;
  topic?: string;
  item_ids?: string[];
  updated_at: Date;
}

/** ดึง meta ของ conversation — คืน null ถ้าไม่มี */
export async function getMeta(conversationId: string): Promise<StatusConversationDoc | null> {
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  return coll.findOne({ conversation_id: conversationId });
}

/** ดึง meta หลายอันพร้อมกัน — คืน Map<conversation_id, meta> */
export async function getMetaMap(conversationIds: string[]): Promise<Map<string, StatusConversationDoc>> {
  if (conversationIds.length === 0) return new Map();
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  const docs = await coll.find({ conversation_id: { $in: conversationIds } }).toArray();
  return new Map(docs.map((d) => [d.conversation_id, d]));
}

/** upsert meta — ใช้สำหรับเขียน field ของเรา */
async function upsertMeta(conversationId: string, fields: Partial<StatusConversationDoc>): Promise<void> {
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  await coll.updateOne(
    { conversation_id: conversationId },
    { $set: { ...fields, updated_at: new Date() } },
    { upsert: true }
  );
}

/** อัปเดต status + assigned_to */
export async function updateStatus(
  conversationId: string,
  status: ConversationStatus,
  assignedTo?: string,
  actor?: string
): Promise<boolean> {
  const fields: Partial<StatusConversationDoc> = { status };
  if (assignedTo !== undefined) {
    fields.assigned_to = assignedTo;
    fields.assigned_at = new Date();
  }
  await upsertMeta(conversationId, fields);
  if (actor) {
    const actionMap: Record<ConversationStatus, string> = {
      open: "conversation.open",
      closed: "conversation.close",
      bot: "conversation.status_change",
      handoff: "conversation.handoff",
      resolved: "conversation.resolve",
      pending: "conversation.status_change",
    };
    await logAdminEvent({
      action_type: actionMap[status] as "conversation.open" | "conversation.close" | "conversation.handoff" | "conversation.resolve" | "conversation.status_change",
      actor,
      conversation_id: conversationId,
      metadata: { new_status: status, assigned_to: assignedTo },
    });
  }
  return true;
}

/** อัปเดต assigned_to (atomic guard — กัน race condition) */
export async function tryAssign(
  conversationId: string,
  agentId: string,
  mode: string
): Promise<boolean> {
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  // atomic: ถ้ายังไม่มี assigned_to (หรือยังไม่มี doc) → assign ได้
  const result = await coll.findOneAndUpdate(
    { conversation_id: conversationId, $or: [{ assigned_to: null }, { assigned_to: { $exists: false } }] },
    { $set: { assigned_to: agentId, assigned_at: new Date(), assignment_mode_used: mode, status: "handoff", updated_at: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  // ⚡ Phase 2M — เขียน log ทุกครั้ง (กัน caller ลืม)
  await logAdminEvent({
    action_type: "chat_assigned",
    actor: "system",
    target_admin_id: agentId,
    conversation_id: conversationId,
    metadata: { mode_used: mode, atomic: true },
  });
  return !!result;
}

/** ⚡ C1 — manual assign (admin กดรับช่วง/เปลี่ยนคน) — atomic guard แบบ "ทับได้ถ้ายังเป็นคนเดิมหรือยังไม่มี"
 *  เขียน statusConversation เท่านั้น (ไม่เขียน conversations ที่โดน dump ทับ)
 *  คืน true ถ้าสำเร็จ, false ถ้าโดนแย่งโดย admin อื่น
 */
export async function manualAssign(
  conversationId: string,
  agentId: string,
  previousAssignedTo: string | null | undefined,
  actor: string
): Promise<boolean> {
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  const result = await coll.findOneAndUpdate(
    {
      conversation_id: conversationId,
      // ต้องยังเป็น assigned_to เดิม หรือยังไม่ assigned (กันทับคนอื่น)
      $or: [
        { assigned_to: previousAssignedTo ?? null },
        { assigned_to: null },
        { assigned_to: { $exists: false } },
      ],
    },
    {
      $set: {
        assigned_to: agentId,
        assigned_at: new Date(),
        assignment_mode_used: "manual",
        status: "handoff",
        updated_at: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  if (result) {
    await logAdminEvent({
      action_type: "conversation.handoff",
      actor,
      target_admin_id: agentId,
      conversation_id: conversationId,
      metadata: {
        assigned_to: agentId,
        previous_assigned_to: previousAssignedTo || null,
        mode: "manual",
      },
    });
  }
  return !!result;
}

/** ปิดแชท — บันทึก closed_at, closed_by, close_count + close_history */
export async function closeConversation(opts: {
  conversationId: string;
  closedBy: string;
  reason: string;
  category: ProblemCategory;
  resolution: string;
  note?: string;
  shopId?: string;
  customerId?: string;
}): Promise<boolean> {
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  const existing = await coll.findOne({ conversation_id: opts.conversationId });
  const closeCount = (existing?.close_count || 0) + 1;
  await upsertMeta(opts.conversationId, {
    status: "closed",
    closed_at: new Date(),
    closed_by: opts.closedBy,
    close_count: closeCount,
  });
  if (opts.shopId && opts.customerId) {
    await closeHistoryService.recordClose({
      conversationId: opts.conversationId,
      shopId: opts.shopId,
      customerId: opts.customerId,
      closedBy: opts.closedBy,
      reason: opts.reason,
      category: opts.category,
      resolution: opts.resolution,
      note: opts.note,
    });
  }
  await logAdminEvent({
    action_type: "conversation.close",
    actor: opts.closedBy,
    metadata: {
      conversation_id: opts.conversationId,
      reason: opts.reason,
      category: opts.category,
      close_count: closeCount,
    },
  });
  return true;
}

/** เปิดแชทใหม่ — ล้าง closed_at + บันทึก reopen history
 *  ⚡ Phase 2N — targetStatus: "handoff" (default, แอดมินเปิด) หรือ "bot" (บอท reopen ตอนลูกค้าทักกลับมา)
 */
export async function reopenConversation(opts: {
  conversationId: string;
  reopenedBy: string;
  reopenReason?: string;
  assignedTo?: string;
  targetStatus?: "handoff" | "bot";
}): Promise<boolean> {
  const targetStatus = opts.targetStatus || "handoff";
  const fields: Partial<StatusConversationDoc> = {
    status: targetStatus,
    closed_at: null,
  };
  if (opts.assignedTo !== undefined) {
    fields.assigned_to = opts.assignedTo;
    fields.assigned_at = new Date();
  } else if (targetStatus === "bot") {
    // ⚡ bot reopen → เคลียร์ assigned_to ด้วย (ปล่อยให้บอทตอบ)
    fields.assigned_to = null;
  }
  await upsertMeta(opts.conversationId, fields);
  await closeHistoryService.recordReopen({
    conversationId: opts.conversationId,
    reopenedBy: opts.reopenedBy,
    reopenReason: opts.reopenReason,
  });
  await logAdminEvent({
    action_type: "conversation.open",
    actor: opts.reopenedBy,
    metadata: {
      conversation_id: opts.conversationId,
      reopen_reason: opts.reopenReason,
      assigned_to: opts.assignedTo,
      new_status: targetStatus,
    },
  });
  return true;
}

// ⚡ Phase 2M — setTopic/setItemIds/togglePinned เขียน log ด้วย (ใครทำอะไร)
export async function setTopic(conversationId: string, topic: string, actor?: string): Promise<void> {
  const existing = await getMeta(conversationId);
  const oldTopic = existing?.topic;
  await upsertMeta(conversationId, { topic });
  await logAdminEvent({
    action_type: "conversation.set_topic",
    actor: actor || "system",
    conversation_id: conversationId,
    metadata: { old_topic: oldTopic || null, new_topic: topic },
  });
}

export async function setItemIds(conversationId: string, itemIds: string[], actor?: string): Promise<void> {
  const existing = await getMeta(conversationId);
  const oldItemIds = existing?.item_ids || [];
  await upsertMeta(conversationId, { item_ids: itemIds });
  await logAdminEvent({
    action_type: "conversation.set_item_ids",
    actor: actor || "system",
    conversation_id: conversationId,
    metadata: { old_item_ids: oldItemIds, new_item_ids: itemIds },
  });
}

export async function togglePinned(conversationId: string, pinned: boolean, actor?: string): Promise<void> {
  await upsertMeta(conversationId, { pinned });
  await logAdminEvent({
    action_type: pinned ? "conversation.pin" : "conversation.unpin",
    actor: actor || "system",
    conversation_id: conversationId,
    metadata: { pinned },
  });
}

export async function resetUnread(conversationId: string): Promise<void> {
  // unread_count ยังอยู่ใน conversations (เขียนโดย dump) — ไม่ย้าย
  // แต่ถ้าต้องการ track ฝั่งเรา ก็เพิ่มได้
}

/** ⚡ pending backlog — handoff แล้วหา admin ไม่ได้ → mark รอ distributor; จ่ายสำเร็จ → clear */
export async function setPendingAssignment(
  conversationId: string,
  pending: boolean,
  reason?: string
): Promise<void> {
  const fields: Partial<StatusConversationDoc> = { pending_assignment: pending };
  if (pending) {
    fields.status = "handoff";
    fields.assigned_to = null;
    if (reason) fields.assignment_reason = reason;
  }
  await upsertMeta(conversationId, fields);
}

/** ⚡ backlog distributor — assign ตรงให้ pending ticket (re-check ว่ายัง pending อยู่ กัน race) */
export async function assignPendingTicket(
  conversationId: string,
  agentId: string,
  actor: string
): Promise<boolean> {
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  const result = await coll.findOneAndUpdate(
    { conversation_id: conversationId, pending_assignment: true, $or: [{ assigned_to: null }, { assigned_to: { $exists: false } }] },
    { $set: { assigned_to: agentId, assigned_at: new Date(), assignment_mode_used: "backlog_distributor", pending_assignment: false, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (result) {
    await logAdminEvent({
      action_type: "chat_assigned",
      actor,
      target_admin_id: agentId,
      conversation_id: conversationId,
      metadata: { mode_used: "backlog_distributor" },
    });
  }
  return !!result;
}

export const statusConversationService = {
  getMeta,
  getMetaMap,
  updateStatus,
  tryAssign,
  manualAssign,
  closeConversation,
  reopenConversation,
  setTopic,
  setItemIds,
  togglePinned,
  setPendingAssignment,
  assignPendingTicket,
};
