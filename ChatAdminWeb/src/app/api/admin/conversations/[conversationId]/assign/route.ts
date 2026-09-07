// POST /api/admin/conversations/:id/assign — assign conversation to admin
// body: { admin_id: string }
// ⚡ C1 — เขียน statusConversation เท่านั้น (ไม่เขียน conversations ที่โดน dump ทับ)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { statusConversationService } from "@/backend/service/statusConversationService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
// ⚡ G-fix — invalidate botworker cache ด้วย (dynamic import กัน circular dep)
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
  const body = await readJson<{ admin_id?: string }>(req);
  if (!body || !body.admin_id) return error("admin_id is required", 422);

  // 🔒 coerce (NoSQL injection prevention)
  const targetAdminId = String(body.admin_id);
  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  // ⚡ C1 — ใช้ statusConversationService.manualAssign (atomic guard + เขียน statusConversation)
  //   ไม่เขียน conversations อีกต่อไป เพราะโดน sellcenter dump ทับทุก 2 วิ
  //   อ่าน previousAssignedTo จาก statusConversation (source of truth) แทน conv.assigned_to
  const meta = await statusConversationService.getMeta(conversationId);
  const previousAssignedTo = meta?.assigned_to ?? conv.assigned_to ?? null;

  const ok = await statusConversationService.manualAssign(
    conversationId,
    targetAdminId,
    previousAssignedTo,
    r.ctx.admin.admin_id
  );

  if (!ok) {
    // conversation ถูกเปลี่ยน assigned_to ระหว่างที่เราตรวจ — ปฏิเสธ
    return json({
      ok: false,
      conflict: true,
      message: "conversation was modified by another admin — please refresh",
    }, 409);
  }

  invalidateConversationsCache();
  invalidateBotworkerCache();
  return json({ ok: true, assigned_to: targetAdminId });
}
