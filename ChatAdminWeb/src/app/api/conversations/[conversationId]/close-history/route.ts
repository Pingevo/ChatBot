// GET /api/conversations/[conversationId]/close-history — ดึงประวัติการปิด/เปิด
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { closeHistoryService } from "@/backend/service/closeHistoryService";
import type { CloseHistoryRecord } from "@/lib/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const docs = await closeHistoryService.listCloseHistory(conversationId);
  const history: CloseHistoryRecord[] = docs.map((d) => ({
    record_id: d.record_id,
    conversation_id: d.conversation_id,
    closed_by: d.closed_by,
    closed_at: d.closed_at.toISOString(),
    reason: d.reason,
    category: d.category,
    resolution: d.resolution,
    note: d.note || undefined,
    reopened_by: d.reopened_by,
    reopened_at: d.reopened_at?.toISOString(),
    reopen_reason: d.reopen_reason,
    sequence: d.sequence,
  }));
  return json({ history });
}
