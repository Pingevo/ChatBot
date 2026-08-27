// POST /api/conversations/[conversationId]/reopen — เปิดแชทใหม่
// body: { reason?, assignedTo? }
// ใช้ตอนแอดมินเปิดใหม่手动 — บอทส่งต่อจะเรียกจาก backend service โดยตรง
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{ reason?: string; assignedTo?: string }>(req).catch(() => ({ reason: undefined, assignedTo: undefined }));

  const ok = await conversationService.reopenConversation({
    conversationId,
    reopenedBy: r.ctx.admin.admin_id,
    reopenReason: body?.reason || "แอดมินเปิดแชทใหม่",
    assignedTo: body?.assignedTo,
  });

  if (!ok) return error("ไม่พบแชท หรือไม่สามารถเปิดใหม่ได้", 404);
  return json({ ok: true });
}
