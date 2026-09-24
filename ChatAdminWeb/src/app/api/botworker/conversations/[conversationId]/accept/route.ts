// POST /api/botworker/conversations/:id/accept — รับเรื่อง (self-assign) ใน parallel sandbox
// assign ตัวเอง → status=open ใน test_status_conversation[botworker]
// ไม่แตะ status_conversation จริง — ไม่กระทบ /tickets
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { logBotworkerEvent } from "@/backend/service/botworkerEventService";
import { BW_SOURCE, getBwMeta, invalidateBotworkerCache } from "../../../_shared";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const me = r.ctx.admin.admin_id;

  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const meta = await getBwMeta(conversationId);
  // ถ้าแชทถูก assign ให้คนอื่นแล้ว → ห้ามกดรับทับ (ใช้ transfer แทน)
  if (meta?.assigned_to && meta.assigned_to !== me) {
    return json({
      ok: false,
      conflict: true,
      assigned_to: meta.assigned_to,
      message: "conversation already assigned to another admin",
    }, 409);
  }

  const ok = await testStatusConversationService.manualTestAssign(
    conversationId,
    BW_SOURCE,
    me,
    meta?.assigned_to,
    "open"
  );
  if (!ok) {
    return json({ ok: false, conflict: true, message: "conversation was modified — please refresh" }, 409);
  }

  await logBotworkerEvent({
    conversation_id: conversationId,
    type: "accept",
    actor: me,
    shop_id: conv.shop_id,
    platform: conv.platform,
    metadata: { assigned_to: me },
  });

  await invalidateBotworkerCache();
  return json({
    ok: true,
    assigned_to: me,
    assigned_to_name: r.ctx.admin.name || r.ctx.admin.username || me,
    status: "open",
  });
}
