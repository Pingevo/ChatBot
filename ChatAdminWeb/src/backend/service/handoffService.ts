// Handoff service — จุดกลางสำหรับ "บอทส่งต่อแอดมิน"
// ทำ 3 อย่าง:
//   1. reopen conversation ถ้าสถานะเป็น closed (ลูกค้าทักกลับมา)
//   2. assign ให้ admin — ถ้าเคยมี admin ตอบแล้ว → ส่งคืน admin เดิมก่อนเสมอ
//      ถ้าไม่เคยมี → auto-assign แบบ round-robin
//   3. ส่ง assigned_admin_name กลับให้บอทบอกลูกค้าได้
// เรียกจาก: data writer (sellcenter เขียนลง MongoDB) หรือ trigger match
// ⚡ Phase 2J — status/assigned_to เก็บใน status_conversation (จริง) ไม่โดน dump ทับ
//   ส่วน test หน้าอื่นใช้ handoffToAdminTest เก็บใน test_status_conversation
import { conversationService } from "./conversationService";
import { statusConversationService } from "./statusConversationService";
import { testStatusConversationService, type TestSource } from "./testStatusConversationService";
import { assignmentService } from "./assignmentService";
import { logAdminEvent } from "./adminLogService";
import { getCollection, COLLECTIONS } from "../db/mongoClient";

/**
 * ดึงชื่อ admin จาก admin_id
 */
async function getAdminName(adminId: string): Promise<string | null> {
  const coll = await getCollection<{ admin_id: string; name?: string; username?: string }>(
    COLLECTIONS.admins
  );
  const admin = await coll.findOne({ admin_id: adminId });
  return admin?.name || admin?.username || null;
}

/**
 * ดึง admin คนสุดท้ายที่ตอบลูกค้าใน conversation นี้
 * (จาก messages collection — หา message ล่าสุดที่ sender เป็น admin)
 */
async function getLastReplyAdmin(
  conversationId: string
): Promise<string | null> {
  const coll = await getCollection<{
    conversation_id: string;
    sender: string;
    admin_id?: string;
    timestamp: Date;
  }>(COLLECTIONS.messages);
  const msg = await coll.findOne(
    {
      conversation_id: conversationId,
      sender: "admin",
      admin_id: { $exists: true, $nin: [""] },
    },
    { sort: { timestamp: -1 } }
  );
  return msg?.admin_id || null;
}

/**
 * บอทส่งต่อแอดมิน — ใช้ตอน trigger match handoff_admin หรือ data writer เห็นว่าควรส่งต่อ
 * ถ้า conversation ปิดอยู่ → reopen อัตโนมัติ + assign ใหม่
 * ถ้า conversation เปิดอยู่ → เปลี่ยน status เป็น handoff + assign (ถ้ายังไม่มี)
 *
 * ⚠️ ถ้าเคยมี admin ตอบแล้ว → ส่งคืน admin เดิมก่อนเสมอ (ก่อน round-robin)
 */
export async function handoffToAdmin(opts: {
  conversationId: string;
  shopId: string;
  platform: string;
  reason?: string;
  source?: string; // ⚡ C1 — source สำหรับ cursor separation (default: "ticket")
}): Promise<{
  assignedTo: string | null;
  assignedToName: string | null;
  reopened: boolean;
  assignmentReason: string;
}> {
  // ⚡ Phase 2J — อ่าน status/assigned_to จาก meta (ไม่ใช่ conversations ที่โดน dump ทับ)
  const conv = await conversationService.getConversation(opts.conversationId);
  if (!conv) {
    return { assignedTo: null, assignedToName: null, reopened: false, assignmentReason: "conversation not found" };
  }
  const meta = await statusConversationService.getMeta(opts.conversationId);

  const currentStatus = meta?.status || "bot";
  const wasClosed = currentStatus === "closed" || currentStatus === "resolved";
  let reopened = false;
  let assignmentReason = "unknown";

  // ถ้าปิดอยู่ → reopen ก่อน (เขียนลง meta)
  if (wasClosed) {
    await statusConversationService.reopenConversation({
      conversationId: opts.conversationId,
      reopenedBy: "bot",
      reopenReason: opts.reason || "ลูกค้าทักกลับมา — บอทส่งต่อแอดมิน",
    });
    reopened = true;
  }

  // ── Step 1: ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม ──
  let assignedTo = meta?.assigned_to || null;

  // ── Step 2: ถ้ายังไม่มี assigned_to → หา admin คนสุดท้ายที่เคยตอบ ──
  // ⚡ G2 — เช็ค config ว่าจะจ่ายให้คนเดิมหรือ round-robin เลย
  if (!assignedTo) {
    const { getSystemConfig } = await import("./systemConfigService");
    const sysConfig = await getSystemConfig();
    const preferPrevious = sysConfig.assignment_prefer_previous_admin !== false;
    if (preferPrevious) {
      const lastReplyAdmin = await getLastReplyAdmin(opts.conversationId);
      if (lastReplyAdmin) {
        // เช็คว่า admin ยัง active อยู่ไหม
        const adminColl = await getCollection<{
          admin_id: string; active: boolean; role: string; is_accepting_chats?: boolean;
        }>(COLLECTIONS.admins);
        const admin = await adminColl.findOne({
          admin_id: lastReplyAdmin,
          active: { $ne: false },
          is_accepting_chats: { $ne: false },
        });
        if (admin) {
          assignedTo = lastReplyAdmin;
          assignmentReason = "previous_reply_admin: ส่งคืน admin เดิมที่เคยตอบ";
        }
      }
    } else {
      assignmentReason = "round_robin_skipped_previous: config ปิดจ่ายคนเดิม → round-robin";
    }
  }

  // ── Step 3: ถ้ายังไม่มี → auto-assign round-robin ──
  if (!assignedTo) {
    const agentId = await assignmentService.autoAssignConversation({
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      platform: opts.platform,
      assigned_to: null,
    }, opts.source || "ticket");
    if (agentId) {
      assignedTo = agentId;
      assignmentReason = "round_robin: ไม่มี admin เดิม → จ่ายคิว";
    }
  } else if (!assignmentReason) {
    assignmentReason = "existing_assignment: มี admin ดูแลอยู่แล้ว";
  }

  // ── อัปเดต status + assigned_to (เขียนลง meta ไม่ใช่ conversations) ──
  if (assignedTo) {
    await statusConversationService.updateStatus(
      opts.conversationId,
      "handoff",
      assignedTo,
      "bot"
    );
  }

  // ── ดึงชื่อ admin ──
  const assignedToName = assignedTo ? await getAdminName(assignedTo) : null;

  await logAdminEvent({
    action_type: "conversation.handoff",
    actor: "bot",
    conversation_id: opts.conversationId,
    metadata: {
      assigned_to: assignedTo,
      assigned_to_name: assignedToName,
      reopened,
      reason: opts.reason,
      assignment_reason: assignmentReason,
    },
  });

  return { assignedTo, assignedToName, reopened, assignmentReason };
}

/**
 * ⚡ Phase 2J — Test version ของ handoffToAdmin
 *   ใช้ round-robin จริง (cursor ขยับจริง) แต่เก็บใน test_status_conversation ไม่ใช่ status_conversation
 *   ไม่เขียน admin_logs / close_history (test ไม่ต้อง audit)
 *   ใช้กับ: test-assignment, shadowbot, replay-compare, test-chat
 */
export async function handoffToAdminTest(opts: {
  conversationId: string;
  shopId: string;
  platform: string;
  reason?: string;
  source: TestSource;
}): Promise<{
  assignedTo: string | null;
  assignedToName: string | null;
  reopened: boolean;
  assignmentReason: string;
}> {
  const meta = await testStatusConversationService.getTestStatus(opts.conversationId, opts.source);
  const currentStatus = meta?.status || "bot";
  const wasClosed = currentStatus === "closed" || currentStatus === "resolved";
  let reopened = false;
  let assignmentReason = "unknown";

  if (wasClosed) {
    await testStatusConversationService.reopenTestConversation(opts.conversationId, opts.source);
    reopened = true;
  }

  // Step 1: ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม
  let assignedTo = meta?.assigned_to || null;

  // Step 2: หา admin คนสุดท้ายที่เคยตอบ
  if (!assignedTo) {
    const lastReplyAdmin = await getLastReplyAdmin(opts.conversationId);
    if (lastReplyAdmin) {
      const adminColl = await getCollection<{
        admin_id: string; active: boolean; role: string; is_accepting_chats?: boolean;
      }>(COLLECTIONS.admins);
      const admin = await adminColl.findOne({
        admin_id: lastReplyAdmin,
        active: { $ne: false },
        is_accepting_chats: { $ne: false },
      });
      if (admin) {
        assignedTo = lastReplyAdmin;
        assignmentReason = "previous_reply_admin: ส่งคืน admin เดิมที่เคยตอบ (test)";
      }
    }
  }

  // Step 3: round-robin (cursor ขยับจริง)
  if (!assignedTo) {
    const mode = await assignmentService.getActiveAssignmentConfig();
    const { poolKey, orderedAgentIds } = await assignmentService.buildPool(
      mode,
      { shop_id: opts.shopId, platform: opts.platform },
      opts.source
    );
    if (orderedAgentIds.length > 0) {
      const agentId = await assignmentService.pickNextAgent(poolKey, orderedAgentIds);
      if (agentId) {
        assignedTo = agentId;
        assignmentReason = `round_robin: ไม่มี admin เดิม → จ่ายคิว (test:${opts.source})`;
      }
    }
  } else if (!assignmentReason) {
    assignmentReason = "existing_assignment: มี admin ดูแลอยู่แล้ว (test)";
  }

  // เขียนลง test_status_conversation (ไม่ใช่ status_conversation จริง)
  if (assignedTo) {
    await testStatusConversationService.updateTestStatus(
      opts.conversationId,
      opts.source,
      "handoff",
      assignedTo,
      assignmentReason
    );
  }

  const assignedToName = assignedTo ? await getAdminName(assignedTo) : null;
  return { assignedTo, assignedToName, reopened, assignmentReason };
}

export const handoffService = {
  handoffToAdmin,
  handoffToAdminTest,
  getAdminName,
  getLastReplyAdmin,
};
