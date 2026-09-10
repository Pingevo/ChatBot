// testStatusConversationService — เก็บสถานะแชททดสอบ แยกจาก status_conversation จริง
// ⚡ Phase 2J — ใช้กับหน้า test ทั้งหมด: test-assignment, shadowbot, replay-compare, test-chat
//
// collection: test_status_conversation
// key: (source, conversation_id) — source บอกว่ามาจากหน้าไหน เพื่อกันชนกัน
//   source: "test_assignment" | "shadowbot" | "replay_compare" | "test_chat"
//
// ต่างจาก statusConversationService:
//   - ไม่เขียน admin_logs (test ไม่ต้อง audit)
//   - ไม่เขียน close_history (test ไม่ต้องเก็บประวัติ)
//   - มี source field แยกตามหน้า
//   - ใช้ round-robin จริง (cursor ขยับจริง) แต่เก็บใน test_status_conversation ไม่ใช่ status_conversation
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import type { ConversationStatus } from "./conversationService";

export type TestSource = "test_assignment" | "shadowbot" | "replay_compare" | "test_chat" | "botworker";

export interface TestStatusConversationDoc {
  conversation_id: string;
  source: TestSource;
  // assignment
  assigned_to?: string | null;
  assigned_at?: Date;
  assignment_mode_used?: string;
  assignment_reason?: string;
  // status
  status?: ConversationStatus;
  // close tracking (test)
  closed_at?: Date | null;
  closed_by?: string;
  close_count?: number;
  // other
  pinned?: boolean;
  topic?: string;
  item_ids?: string[];
  updated_at: Date;
}

function coll() {
  return getCollection<TestStatusConversationDoc>(COLLECTIONS.testStatusConversation);
}

/** ดึง status ของ conversation ใน source ที่ระบุ */
export async function getTestStatus(
  conversationId: string,
  source: TestSource
): Promise<TestStatusConversationDoc | null> {
  return coll().then((c) => c.findOne({ conversation_id: conversationId, source }));
}

/** ดึงหลายอัน — คืน Map<conversation_id, doc> */
export async function getTestStatusMap(
  conversationIds: string[],
  source: TestSource
): Promise<Map<string, TestStatusConversationDoc>> {
  if (conversationIds.length === 0) return new Map();
  const c = await coll();
  const docs = await c.find({ conversation_id: { $in: conversationIds }, source }).toArray();
  return new Map(docs.map((d) => [d.conversation_id, d]));
}

async function upsertTestStatus(
  conversationId: string,
  source: TestSource,
  fields: Partial<TestStatusConversationDoc>
): Promise<void> {
  const c = await coll();
  await c.updateOne(
    { conversation_id: conversationId, source },
    { $set: { ...fields, updated_at: new Date() } },
    { upsert: true }
  );
}

/** อัปเดต status + assigned_to (test) */
export async function updateTestStatus(
  conversationId: string,
  source: TestSource,
  status: ConversationStatus,
  assignedTo?: string,
  assignmentReason?: string
): Promise<void> {
  const fields: Partial<TestStatusConversationDoc> = { status };
  if (assignedTo !== undefined) {
    fields.assigned_to = assignedTo;
    fields.assigned_at = new Date();
  }
  if (assignmentReason) fields.assignment_reason = assignmentReason;
  await upsertTestStatus(conversationId, source, fields);
}

/** atomic assign — กัน race condition (test) */
export async function tryTestAssign(
  conversationId: string,
  source: TestSource,
  agentId: string,
  mode: string
): Promise<boolean> {
  const c = await coll();
  const result = await c.findOneAndUpdate(
    { conversation_id: conversationId, source, $or: [{ assigned_to: null }, { assigned_to: { $exists: false } }] },
    { $set: { assigned_to: agentId, assigned_at: new Date(), assignment_mode_used: mode, updated_at: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  return !!result;
}

/** ปิดแชท (test) — ไม่บันทึก close_history */
export async function closeTestConversation(
  conversationId: string,
  source: TestSource,
  closedBy: string
): Promise<void> {
  const c = await coll();
  const existing = await c.findOne({ conversation_id: conversationId, source });
  const closeCount = (existing?.close_count || 0) + 1;
  await upsertTestStatus(conversationId, source, {
    status: "closed",
    closed_at: new Date(),
    closed_by: closedBy,
    close_count: closeCount,
  });
}

/** เปิดแชทใหม่ (test) */
export async function reopenTestConversation(
  conversationId: string,
  source: TestSource,
  assignedTo?: string
): Promise<void> {
  const fields: Partial<TestStatusConversationDoc> = {
    status: "handoff",
    closed_at: null,
  };
  if (assignedTo !== undefined) {
    fields.assigned_to = assignedTo;
    fields.assigned_at = new Date();
  }
  await upsertTestStatus(conversationId, source, fields);
}

export async function setTestTopic(conversationId: string, source: TestSource, topic: string): Promise<void> {
  await upsertTestStatus(conversationId, source, { topic });
}

export async function setTestItemIds(conversationId: string, source: TestSource, itemIds: string[]): Promise<void> {
  await upsertTestStatus(conversationId, source, { item_ids: itemIds });
}

export async function toggleTestPinned(conversationId: string, source: TestSource, pinned: boolean): Promise<void> {
  await upsertTestStatus(conversationId, source, { pinned });
}

/** ล้างข้อมูล test ของ source ที่ระบุ — ใช้ตอนเริ่ม replay ใหม่ */
export async function clearTestSource(source: TestSource): Promise<void> {
  const c = await coll();
  await c.deleteMany({ source });
}

export const testStatusConversationService = {
  getTestStatus,
  getTestStatusMap,
  updateTestStatus,
  tryTestAssign,
  closeTestConversation,
  reopenTestConversation,
  setTestTopic,
  setTestItemIds,
  toggleTestPinned,
  clearTestSource,
};
