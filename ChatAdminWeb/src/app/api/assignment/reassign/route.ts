// POST /api/assignment/reassign — ย้าย conversation ให้ agent คนอื่่น (manual)
// body: { conversation_id, new_admin_id, reason? }
// new_admin_id = null หมายถึงปล่อยงาน (unassign)
// ⚠️ ไม่สามารถ reassign ให้ superadmin หรือ dev ได้ — เฉพาะ role=admin เท่านั้น
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { assignmentService } from "@/backend/service/assignmentService";
import { conversationService } from "@/backend/service/conversationService";
import { auth } from "@/backend/service/authService";
import { ObjectId } from "mongodb";

export async function POST(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    conversation_id?: string;
    new_admin_id?: string | null;
    reason?: string;
  }>(req);
  if (!body?.conversation_id) return error("conversation_id is required");

  const conv = await conversationService.getConversation(body.conversation_id);
  if (!conv) return error("conversation not found", 404);

  // ตรวจสอบว่า target admin เป็น role=admin เท่านั้น
  if (body.new_admin_id) {
    const targetAdmin = await auth.getAdminById(body.new_admin_id);
    if (!targetAdmin) return error("target admin not found", 404);
    if (targetAdmin.role !== "admin") {
      return error("ไม่สามารถมอบหมายงานให้ superadmin หรือ dev ได้ — เฉพาะ admin เท่านั้น", 403);
    }
  }

  const actor = r.ctx.admin.username || r.ctx.admin.email || "admin";
  await assignmentService.reassignConversation(
    {
      _id: conv._id as unknown as ObjectId,
      conversation_id: conv.conversation_id,
      shop_id: conv.shop_id,
      assigned_to: conv.assigned_to,
    },
    body.new_admin_id || null,
    actor,
    body.reason
  );

  return json({ ok: true });
}
