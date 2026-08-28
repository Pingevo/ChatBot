// Handoff service — จุดกลางสำหรับ "บอทส่งต่อแอดมิน"
// ทำ 3 อย่าง:
//   1. reopen conversation ถ้าสถานะเป็น closed (ลูกค้าทักกลับมา)
//   2. assign ให้ admin — ถ้าเคยมี admin ตอบแล้ว → ส่งคืน admin เดิมก่อนเสมอ
//      ถ้าไม่เคยมี → auto-assign แบบ round-robin
//   3. ส่ง assigned_admin_name กลับให้บอทบอกลูกค้าได้
// เรียกจาก: data writer (sellcenter เขียนลง MongoDB) หรือ trigger match
import { conversationService } from "./conversationService";
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
}): Promise<{
  assignedTo: string | null;
  assignedToName: string | null;
  reopened: boolean;
  assignmentReason: string;
}> {
  const conv = await conversationService.getConversation(opts.conversationId);
  if (!conv) {
    return { assignedTo: null, assignedToName: null, reopened: false, assignmentReason: "conversation not found" };
  }

  const wasClosed = conv.status === "closed" || conv.status === "resolved";
  let reopened = false;
  let assignmentReason = "unknown";

  // ถ้าปิดอยู่ → reopen ก่อน
  if (wasClosed) {
    await conversationService.reopenConversation({
      conversationId: opts.conversationId,
      reopenedBy: "bot",
      reopenReason: opts.reason || "ลูกค้าทักกลับมา — บอทส่งต่อแอดมิน",
    });
    reopened = true;
  }

  // ── Step 1: ถ้ามี assigned_to อยู่แล้ว → ใช้คนเดิม ──
  let assignedTo = conv.assigned_to || null;

  // ── Step 2: ถ้ายังไม่มี assigned_to → หา admin คนสุดท้ายที่เคยตอบ ──
  if (!assignedTo) {
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
  }

  // ── Step 3: ถ้ายังไม่มี → auto-assign round-robin ──
  if (!assignedTo) {
    const agentId = await assignmentService.autoAssignConversation({
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      platform: opts.platform,
      assigned_to: null,
    });
    if (agentId) {
      assignedTo = agentId;
      assignmentReason = "round_robin: ไม่มี admin เดิม → จ่ายคิว";
    }
  } else if (!assignmentReason) {
    assignmentReason = "existing_assignment: มี admin ดูแลอยู่แล้ว";
  }

  // ── อัปเดต status + assigned_to ──
  if (assignedTo) {
    await conversationService.updateConversationStatus(
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

export const handoffService = {
  handoffToAdmin,
  getAdminName,
  getLastReplyAdmin,
};
