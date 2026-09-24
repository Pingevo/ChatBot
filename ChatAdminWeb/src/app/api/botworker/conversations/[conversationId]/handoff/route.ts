// POST /api/botworker/conversations/:id/handoff — ส่งเข้า pool (round-robin) ใน parallel sandbox
// → handoffToAdminTest(source=botworker, assignedStatus=open)
//   ได้คน → status=open + assigned_to / ไม่ได้ → status=handoff + pending_assignment=true
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { handoffService } from "@/backend/service/handoffService";
import { logBotworkerEvent } from "@/backend/service/botworkerEventService";
import { BW_SOURCE, invalidateBotworkerCache } from "../../../_shared";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const result = await handoffService.handoffToAdminTest({
    conversationId,
    shopId: conv.shop_id,
    platform: conv.platform,
    reason: `manual handoff by ${r.ctx.admin.admin_id} (botworker)`,
    source: BW_SOURCE,
    assignedStatus: "open",
  });

  await logBotworkerEvent({
    conversation_id: conversationId,
    type: "handoff",
    actor: r.ctx.admin.admin_id,
    shop_id: conv.shop_id,
    platform: conv.platform,
    metadata: {
      assigned_to: result.assignedTo,
      assignment_reason: result.assignmentReason,
      pending: !result.assignedTo,
    },
  });

  await invalidateBotworkerCache();
  return json({
    ok: true,
    assigned_to: result.assignedTo,
    assigned_to_name: result.assignedToName,
    pending: !result.assignedTo,
    status: result.assignedTo ? "open" : "handoff",
  });
}
