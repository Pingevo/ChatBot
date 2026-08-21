// Handoff service — จุดกลางสำหรับ "บอทส่งต่อแอดมิน"
// ทำ 2 อย่าง:
//   1. reopen conversation ถ้าสถานะเป็น closed (ลูกค้าทักกลับมา)
//   2. auto-assign ให้ admin คนถัดไป (round-robin)
// เรียกจาก: data writer (sellcenter เขียนลง MongoDB) หรือ trigger match
import { conversationService } from "./conversationService";
import { assignmentService } from "./assignmentService";
import { logAdminEvent } from "./adminLogService";

/**
 * บอทส่งต่อแอดมิน — ใช้ตอน trigger match handoff_admin หรือ data writer เห็นว่าควรส่งต่อ
 * ถ้า conversation ปิดอยู่ → reopen อัตโนมัติ + assign ใหม่
 * ถ้า conversation เปิดอยู่ → เปลี่ยน status เป็น handoff + assign (ถ้ายังไม่มี)
 */
export async function handoffToAdmin(opts: {
  conversationId: string;
  shopId: string;
  platform: string;
  reason?: string;
}): Promise<{ assignedTo: string | null; reopened: boolean }> {
  const conv = await conversationService.getConversation(opts.conversationId);
  if (!conv) return { assignedTo: null, reopened: false };

  const wasClosed = conv.status === "closed" || conv.status === "resolved";
  let reopened = false;

  // ถ้าปิดอยู่ → reopen ก่อน
  if (wasClosed) {
    await conversationService.reopenConversation({
      conversationId: opts.conversationId,
      reopenedBy: "bot",
      reopenReason: opts.reason || "ลูกค้าทักกลับมา — บอทส่งต่อแอดมิน",
    });
    reopened = true;
  }

  // ถ้ายังไม่มี assigned_to → auto-assign
  let assignedTo = conv.assigned_to || null;
  if (!assignedTo) {
    const agentId = await assignmentService.autoAssignConversation({
      conversation_id: opts.conversationId,
      shop_id: opts.shopId,
      platform: opts.platform,
      assigned_to: null,
    });
    if (agentId) {
      assignedTo = agentId;
      await conversationService.updateConversationStatus(
        opts.conversationId,
        "handoff",
        agentId,
        "bot"
      );
    }
  } else if (wasClosed) {
    // มี admin เดิม → เปลี่ยน status เป็น handoff
    await conversationService.updateConversationStatus(
      opts.conversationId,
      "handoff",
      assignedTo,
      "bot"
    );
  }

  await logAdminEvent({
    action_type: "conversation.handoff",
    actor: "bot",
    conversation_id: opts.conversationId,
    metadata: {
      assigned_to: assignedTo,
      reopened,
      reason: opts.reason,
    },
  });

  return { assignedTo, reopened };
}

export const handoffService = {
  handoffToAdmin,
};
