// POST /api/botworker/conversations/:id/reopen — เปิดแชทใหม่ใน parallel sandbox
// → status=open (ถ้ามี assigned_to ค้าง — แอดมินเดิมดูแลต่อ) หรือ status=bot (ไม่มี assignee → กลับเข้าลูปบอท)
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
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const meta = await getBwMeta(conversationId);
  const hasAssignee = !!meta?.assigned_to;

  // มี assignee ค้าง → reopen กลับให้คนเดิม (status=open) / ไม่มี → กลับลูปบอท (status=bot)
  await testStatusConversationService.reopenTestConversation(
    conversationId,
    BW_SOURCE,
    hasAssignee ? meta!.assigned_to! : undefined,
    hasAssignee ? "handoff" : "bot"
  );
  // reopen เป็น open สำหรับ assignee เดิม
  if (hasAssignee) {
    await testStatusConversationService.updateTestStatus(conversationId, BW_SOURCE, "open", meta!.assigned_to!);
  }

  await logBotworkerEvent({
    conversation_id: conversationId,
    type: "reopen",
    actor: r.ctx.admin.admin_id,
    shop_id: conv.shop_id,
    platform: conv.platform,
    metadata: { assigned_to: meta?.assigned_to || null, new_status: hasAssignee ? "open" : "bot" },
  });

  await invalidateBotworkerCache();
  return json({ ok: true, status: hasAssignee ? "open" : "bot", assigned_to: meta?.assigned_to || null });
}
