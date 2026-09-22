// POST /api/botworker/conversations/:id/close — ปิดแชทใน parallel sandbox
// body: { reason?, category?, resolution?, note? }
// → status=closed + close_history[] ใน test_status_conversation[botworker]
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { logBotworkerEvent } from "@/backend/service/botworkerEventService";
import { BW_SOURCE, invalidateBotworkerCache } from "../../../_shared";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{ reason?: string; category?: string; resolution?: string; note?: string }>(req) || {};

  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const me = r.ctx.admin.admin_id;
  const reason = String(body.reason || "closed by admin (botworker)");
  const category = String(body.category || "other");
  const resolution = String(body.resolution || "resolved");

  await testStatusConversationService.closeTestConversation(conversationId, BW_SOURCE, me);
  await testStatusConversationService.pushTestCloseHistory(conversationId, BW_SOURCE, {
    closed_at: new Date(),
    closed_by: me,
    reason,
    category,
    resolution,
    note: body.note ? String(body.note) : undefined,
  });

  await logBotworkerEvent({
    conversation_id: conversationId,
    type: "close",
    actor: me,
    shop_id: conv.shop_id,
    platform: conv.platform,
    metadata: { reason, category, resolution },
  });

  await invalidateBotworkerCache();
  return json({ ok: true, status: "closed" });
}
