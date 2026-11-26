// GET /api/botworker/conversations/:id/close-history — ประวัติปิดแชทของ parallel sandbox
// → close_history[] จาก test_status_conversation[botworker] (ไม่ใช่ของจริง)
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { getBwMeta } from "../../../_shared";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const meta = await getBwMeta(conversationId);
  return json({
    // sandbox entries have no record_id/sequence — derive them (history is append-only, so index is stable)
    close_history: (meta?.close_history || []).map((entry, index) => ({
      ...entry,
      record_id: `${conversationId}:close:${index + 1}`,
      conversation_id: conversationId,
      sequence: index + 1,
    })),
    close_count: meta?.close_count || 0,
    reopen_count: meta?.reopen_count || 0,
  });
}
