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
  assigned_at?: Date | null;
  assignment_mode_used?: string;
  // status (admin-owned — ไม่โดน dump ทับ)
  // null ได้ใน storage จริง (topic-only doc ที่มี status:null) — init CAS ต้อง match ทั้งคู่
  status?: ConversationStatus | null;
  // close tracking
  closed_at?: Date | null;
  closed_by?: string | null;
  close_count?: number;
  // ⚡ pending backlog — handoff แล้วหา admin ไม่ได้ → รอ manual distributor จ่าย
  pending_assignment?: boolean;
  assignment_reason?: string;
  // other admin-owned fields
  pinned?: boolean;
  topic?: string;
  item_ids?: string[];
  // ⚡ inbound lifecycle — message_id ของ inbound event ที่ชนะ CAS
  //   (loser/retry เทียบ identity แล้ว settle audit แบบ idempotent ได้)
  inbound_reopen_event_id?: string;
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

/** อัปเดต status + assigned_to
 *  assignedTo มี 3 ความหมายชัดเจน:
 *    - undefined → ไม่แตะ owner เดิม
 *    - null      → ล้าง current ownership (ไม่ลบ audit/history)
 *    - string    → ตั้ง owner ใหม่
 */
export async function updateStatus(
  conversationId: string,
  status: ConversationStatus,
  assignedTo?: string | null,
  actor?: string
): Promise<boolean> {
  const fields: Partial<StatusConversationDoc> = { status };
  if (assignedTo === null) {
    fields.assigned_to = null;
    fields.assigned_at = null;
  } else if (assignedTo !== undefined) {
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
  // filter miss + upsert insert ชน unique(conversation_id) → E11000
  //   = คนอื่น assign ชนะ race → แพ้ CAS คืน false (ห้ามโยน exception เป็น false-success)
  let result;
  try {
    result = await coll.findOneAndUpdate(
      { conversation_id: conversationId, $or: [{ assigned_to: null }, { assigned_to: { $exists: false } }] },
      { $set: { assigned_to: agentId, assigned_at: new Date(), assignment_mode_used: mode, status: "handoff", updated_at: new Date() } },
      { upsert: true, returnDocument: "after" }
    );
  } catch (e) {
    if ((e as { code?: number })?.code === 11000) return false;
    throw e;
  }
  // log เฉพาะเมื่อ assign สำเร็จจริง (CAS loser ห้ามบันทึก chat_assigned)
  if (result) {
    await logAdminEvent({
      action_type: "chat_assigned",
      actor: "system",
      target_admin_id: agentId,
      conversation_id: conversationId,
      metadata: { mode_used: mode, atomic: true },
    });
  }
  return !!result;
}

/** manual assign (admin กดรับช่วง/เปลี่ยนคน) — atomic guard แบบ "ทับได้ถ้ายังเป็นคนเดิมหรือยังไม่มี"
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
  // filter miss + upsert insert ชน unique(conversation_id) → E11000
  //   = ถูกแย่งระหว่างรอ → คืน false (conflict) ไม่โยน exception
  let result;
  try {
    result = await coll.findOneAndUpdate(
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
  } catch (e) {
    if ((e as { code?: number })?.code === 11000) return false;
    throw e;
  }
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

// ── Inbound lifecycle command ────────────────────────────────────────────
// ⚡ single ownership owner สำหรับ external inbound writer hook:
//   writer persist message สำเร็จ → ยิง command นี้หลัง persist เท่านั้น
//   command self-fences — ยิงซ้ำ/ยิงทุก message ปลอดภัย (unchanged = no-op)
//
// guarantees:
//   - state transition = single-winner fenced CAS (authoritative)
//   - history/audit = idempotent convergence under retry/reconciliation
//     (ไม่ใช่ atomic transaction — crash โดยไม่มี retry → audit อาจขาด)
//   - initialization (missing/no-status meta) ≠ reopen — zero history/log
//   - side-effect owner เดียว = closeHistoryService.recordReopen
export interface InboundOwnershipEvent {
  conversationId: string;
  messageId: string;
  inboundAt: Date;
}
export type InboundTransitionOutcome = "initialized" | "reopened" | "unchanged";

export async function applyInboundOwnershipTransition(
  event: InboundOwnershipEvent
): Promise<InboundTransitionOutcome> {
  const coll = await getCollection<StatusConversationDoc>(COLLECTIONS.statusConversation);
  const now = new Date();

  let meta = await coll.findOne({ conversation_id: event.conversationId });
  if (!meta) {
    // missing meta → initialize authoritative bot state (unique conversation_id arbitrates races)
    try {
      await coll.insertOne({
        conversation_id: event.conversationId,
        status: "bot",
        assigned_to: null,
        updated_at: now,
      } as StatusConversationDoc);
      return "initialized";
    } catch (e) {
      if ((e as { code?: number })?.code !== 11000) throw e;
      // lost insert race → bounded re-read once, dispatch on the observed state (no loop)
      meta = await coll.findOne({ conversation_id: event.conversationId });
      if (!meta) return "unchanged"; // winner's doc vanished — fail closed
    }
  }

  const settleReopen = () => closeHistoryService.recordReopen({
    conversationId: event.conversationId,
    reopenedBy: "bot",
    reopenReason: "customer_inbound",
    messageId: event.messageId,
  });

  // doc exists but has no status (topic-only metadata) → initialize, preserve fields
  if (meta.status === undefined || meta.status === null) {
    const r = await coll.findOneAndUpdate(
      { conversation_id: event.conversationId, $or: [{ status: { $exists: false } }, { status: null }] },
      { $set: { status: "bot", assigned_to: null, updated_at: now } },
      { returnDocument: "after" }
    );
    return r ? "initialized" : "unchanged"; // CAS miss → someone else resolved it
  }

  if (meta.status === "closed" || meta.status === "resolved") {
    // stale/equal inbound → unchanged, zero write
    if (!(meta.closed_at instanceof Date && meta.closed_at < event.inboundAt)) return "unchanged";
    const r = await coll.findOneAndUpdate(
      {
        conversation_id: event.conversationId,
        status: { $in: ["closed", "resolved"] },
        closed_at: { $lt: event.inboundAt },
      },
      {
        $set: {
          status: "bot",
          assigned_to: null,
          assigned_at: null,
          closed_at: null,
          closed_by: null,
          pending_assignment: false,
          inbound_reopen_event_id: event.messageId,
          updated_at: now,
        },
      },
      { returnDocument: "after" }
    );
    if (r) {
      await settleReopen(); // failure propagates — state commits, retry converges audit
      return "reopened";
    }
    // CAS miss → bounded reconcile once: settle only if the winner committed THIS event
    const observed = await coll.findOne({ conversation_id: event.conversationId });
    if (observed?.status === "bot" && observed.inbound_reopen_event_id === event.messageId) {
      await settleReopen();
    }
    return "unchanged";
  }

  // bot + matching event id → committed winner whose audit may be missing → converge
  if (meta.status === "bot" && meta.inbound_reopen_event_id === event.messageId) {
    await settleReopen();
    return "unchanged";
  }

  // bot/open/handoff/pending/other → unchanged, zero write
  return "unchanged";
}

export const statusConversationService = {
  getMeta,
  getMetaMap,
  updateStatus,
  tryAssign,
  manualAssign,
  closeConversation,
  reopenConversation,
  setPendingAssignment,
  assignPendingTicket,
  applyInboundOwnershipTransition,
};
