// POST /api/botworker/conversations/:id/transfer — โยนงานให้แอดมินคนอื่นใน parallel sandbox
// body: { admin_id }
// validate eligibility: active=true, role="admin", is_accepting_chats !== false
// → assigned_to=admin_id, status=open ใน test_status_conversation[botworker]
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { conversationService } from "@/backend/service/conversationService";
import { testStatusConversationService } from "@/backend/service/testStatusConversationService";
import { logBotworkerEvent } from "@/backend/service/botworkerEventService";
import { auth } from "@/backend/service/authService";
import { BW_SOURCE, getBwMeta, invalidateBotworkerCache } from "../../../_shared";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { conversationId } = await params;
  const body = await readJson<{ admin_id?: string }>(req);
  if (!body || !body.admin_id) return error("admin_id is required", 422);

  const targetAdminId = String(body.admin_id);
  const me = r.ctx.admin.admin_id;

  const conv = await conversationService.getConversation(conversationId);
  if (!conv) return error("conversation not found", 404);

  // ⚡ eligibility — โยนได้เฉพาะ admin ที่ active + role=admin + เปิดรับแชท
  const target = await auth.getAdminById(targetAdminId);
  if (!target || target.active === false) {
    return error("target admin not found or inactive", 422);
  }
  if (target.role !== "admin") {
    return error("target must have role=admin", 422);
  }
  if (target.is_accepting_chats === false) {
    return error("target admin is not accepting chats", 422);
  }

  const meta = await getBwMeta(conversationId);
  const ok = await testStatusConversationService.manualTestAssign(
    conversationId,
    BW_SOURCE,
    targetAdminId,
    meta?.assigned_to,
    "open"
  );
  if (!ok) {
    return json({ ok: false, conflict: true, message: "conversation was modified — please refresh" }, 409);
  }

  await logBotworkerEvent({
    conversation_id: conversationId,
    type: "transfer",
    actor: me,
    shop_id: conv.shop_id,
    platform: conv.platform,
    metadata: { from: meta?.assigned_to || null, to: targetAdminId, to_name: target.name },
  });

  await invalidateBotworkerCache();
  return json({ ok: true, assigned_to: targetAdminId, assigned_to_name: target.name, status: "open" });
}
