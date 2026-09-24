// GET /api/botworker/conversations/:id/events — ประวัติ event ของ parallel sandbox
// → botworker_events (accept/transfer/handoff/close/reopen/send/bot_*/workflow)
//   แยกจาก admin_logs จริง — หน้า /botworker อ่านตรงนี้เท่านั้น
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { listBotworkerEvents } from "@/backend/service/botworkerEventService";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  const events = await listBotworkerEvents(conversationId, 200);
  return json({ events, total: events.length });
}
