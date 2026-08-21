// GET /api/conversations/[conversationId]/close-history — ดึงประวัติการปิด/เปิด
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { closeHistoryService } from "@/backend/service/closeHistoryService";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const history = await closeHistoryService.listCloseHistory(conversationId);
  return json({ history });
}
