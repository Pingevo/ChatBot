// POST /api/admin/conversations/:id/assign — assign conversation to admin
// body: { admin_id: string }
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { invalidateConversationsCache } from "@/app/api/admin/conversations/route";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

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

  // ℹ️ Shared inbox — admin ทุกคน assign ได้
  // 🔒 Race condition fix — ใช้ findOneAndUpdate แบบ atomic
  const coll = await getCollection(COLLECTIONS.conversations);
  const result = await coll.findOneAndUpdate(
    {
      conversation_id: conversationId,
      // ต้องยังเป็น assigned_to เดิม หรือยังไม่ assigned (กันทับคนอื่น)
      $or: [
        { assigned_to: conv.assigned_to },
        { assigned_to: null },
      ],
    },
    {
      $set: {
        status: "handoff",
        assigned_to: targetAdminId,
        updated_at: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (!result) {
    // conversation ถูกเปลี่ยน assigned_to ระหว่างที่เราตรวจ — ปฏิเสธ
    return json({
      ok: false,
      conflict: true,
      message: "conversation was modified by another admin — please refresh",
    }, 409);
  }

  await logAdminEvent({
    action_type: "conversation.handoff",
    actor: r.ctx.admin.admin_id,
    conversation_id: conversationId,
    metadata: {
      assigned_to: targetAdminId,
      previous_assigned_to: conv.assigned_to || null,
    },
  });

  invalidateConversationsCache();
  return json({ ok: true, assigned_to: targetAdminId });
}
