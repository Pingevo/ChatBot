// POST /api/admin/conversations/:id/resolve — mark conversation as resolved
// ⚠️ ไม่ส่ง platform — เปลี่ยนเฉพาะ status ใน admin DB
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  // ℹ️ Shared inbox — admin ทุกคน resolve ได้
  const ok = await conversationService.updateConversationStatus(
    conversationId,
    "resolved",
    undefined,
    r.ctx.admin.admin_id
  );
  if (!ok) return error("conversation not found", 404);

  invalidateConversationsCache();
  return json({ ok: true, status: "resolved" });
}
