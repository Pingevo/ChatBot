// POST /api/admin/conversations/:id/assign — assign conversation to admin
// body: { admin_id: string }
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{ admin_id?: string }>(req);
  if (!body || !body.admin_id) return error("admin_id is required", 422);

  const ok = await conversationService.updateConversationStatus(
    conversationId,
    "handoff",
    body.admin_id,
    r.ctx.admin.admin_id
  );
  if (!ok) return error("conversation not found", 404);

  invalidateConversationsCache();
  return json({ ok: true, assigned_to: body.admin_id });
}
