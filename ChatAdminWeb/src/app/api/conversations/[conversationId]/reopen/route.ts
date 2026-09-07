// POST /api/conversations/[conversationId]/reopen — เปิดแชทใหม่
// body: { reason?, assignedTo? }
// ใช้ตอนแอดมินเปิดใหม่手动 — บอทส่งต่อจะเรียกจาก backend service โดยตรง
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
// ⚡ G-fix — invalidate conversation caches เมื่อ reopen
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
async function invalidateBotworkerCache() {
  try {
    const mod = await import("@/app/api/botworker/conversations/route");
    if (typeof (mod as unknown as { invalidateBotworkerCache?: () => void }).invalidateBotworkerCache === "function") {
      (mod as unknown as { invalidateBotworkerCache: () => void }).invalidateBotworkerCache();
    }
  } catch { /* ignore */ }
}

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
  invalidateConversationsCache();
  invalidateBotworkerCache();
  return json({ ok: true });
}
