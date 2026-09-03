// POST /api/admin/conversations/:id/send — admin reply
//
// ⚠️ IRON RULE: เขียนเฉพาะ admin DB (chatbot.messages)
// ห้ามยิง Shopee/TikTok/Lazada API
// ห้ามส่งข้อความจริงให้ลูกค้า
// ข้อความนี้เป็น internal admin note เท่านั้น — ลูกค้าจะไม่เห็น
//
// Phase 7.9 — เช็ค assigned_to สดๆ ก่อนเขียน
//   - ถ้า conv assigned ให้คนอื่น → คืน 409 + ข้อมูล assigned_to (frontend เตือน popup)
//   - ถ้า conv assigned ให้ตัวเอง หรือ ยังไม่ assigned → ตอบได้
//   - ปล่อยให้ frontend ยืนยัน + ส่ง force=true เพื่อข้าม (แต่ log ไว้)
//
// body: { text: string, force?: boolean }
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { messageService } from "@/backend/service/messageService";
import { conversationService } from "@/backend/service/conversationService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { assertPlatformApiDisabled } from "@/backend/lib/safety";
import { auth } from "@/backend/service/authService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
import type { ChatMessage } from "@/lib/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{ text?: string; force?: boolean }>(req);
  if (!body || !body.text || !body.text.trim()) {
    return error("text is required", 422);
  }
  const text = body.text.trim();
  const force = body.force === true;

  // อ่าน conversation สดๆ — กันกรณี A โยนให้ B แล้ว A ยังตอบทับ
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  // ⛔ Iron Rule guard — กันใครเพิ่ม code เรียก platform API โดยไม่ตั้งใจ
  assertPlatformApiDisabled(conv.platform, "send");

  // Phase 7.9 — เช็ค assigned_to สดๆ
  // ℹ️ Shared inbox model — admin ทุกคนตอบได้ แต่มี conflict detection
  //   - ถ้า assigned ให้คนอื่น → 409 + frontend เตือน popup
  //   - ถ้า assigned ให้ตัวเอง หรือ ยังไม่ assigned → ตอบได้
  //   - force=true ข้าม conflict ได้ (audit log บันทึกไว้)
  const me = r.ctx.admin.admin_id;
  const assignedToOther = conv.assigned_to && conv.assigned_to !== me;
  if (assignedToOther && !force) {
    return json({
      ok: false,
      conflict: true,
      assigned_to: conv.assigned_to,
      message: "conversation assigned to another admin",
    }, 409);
  }

  // เขียนลง admin DB เท่านั้น — ไม่ส่ง platform
  const doc = await messageService.addMessage({
    conversationId,
    shopId: conv.shop_id,
    platform: conv.platform,
    role: "admin",
    direction: "out",
    text,
    source: "admin",
    actor: me,
  });

  // audit log — บันทึก force ด้วย เพื่อ audit trail
  await logAdminEvent({
    action_type: "admin.reply",
    actor: me,
    conversation_id: conversationId,
    shop_id: conv.shop_id,
    metadata: {
      platform: conv.platform,
      message_id: doc.message_id,
      text_preview: text.slice(0, 100),
      delivered_to_platform: false,
      assigned_to: conv.assigned_to || null,
      reply_as_assigned_owner: !assignedToOther,
      forced_override: force && assignedToOther,
    },
  });

  // ดึง admin name เพื่อส่งกลับให้ UI แสดง
  const adminDoc = await auth.getAdminById(me);
  const adminName = adminDoc?.name || adminDoc?.username || me;

  const message: ChatMessage = {
    id: doc.message_id,
    role: doc.role,
    text: doc.text,
    timestamp: doc.created_timestamp.toISOString(),
    source: doc.source,
    admin_id: me,
    admin_name: adminName,
  };

  // ⚡ invalidate cache — ให้ list อัปเดตทันที (unanswered count เปลี่ยน)
  invalidateConversationsCache();
  return json({ message, assigned_to: conv.assigned_to || null });
}
