// PATCH /api/profile/accepting-chats — toggle สถานะรับแชทของตัวเอง
// body: { is_accepting_chats: boolean }
//
// เมื่อ false → ระบบจะไม่จ่ายแชทใหม่ให้ (แต่แชทเดิมที่ assign อยู่ยังเป็นของตัวเอง)
// ใช้ตอนลาหยุด ลาพัก หรืออยากพักตอบแชท
//
// Phase 8 — เพิ่ม session tracking + log เป็น action เฉพาะ (chat_accept.start/stop)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { chatAcceptService } from "@/backend/service/chatAcceptService";

export async function PATCH(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ is_accepting_chats?: boolean }>(req).catch(() => null);
  if (!body || typeof body.is_accepting_chats !== "boolean") {
    return error("is_accepting_chats (boolean) is required", 400);
  }

  const ok = await auth.updateAdminProfile(r.ctx.admin.admin_id, {
    is_accepting_chats: body.is_accepting_chats,
  });
  if (!ok) return error("update failed", 500);

  // Phase 8 — start session (ปิด session เดิมอัตโนมัติ แล้วเปิดใหม่)
  const state = body.is_accepting_chats ? "accepting" : "paused";
  await chatAcceptService.startSession(r.ctx.admin.admin_id, state);

  // audit log — action เฉพาะ (ไม่ใช่ user.update ทั่วไป)
  await logAdminEvent({
    action_type: body.is_accepting_chats ? "chat_accept.start" : "chat_accept.stop",
    actor: r.ctx.admin.admin_id,
    target_admin_id: r.ctx.admin.admin_id,
    metadata: { is_accepting_chats: body.is_accepting_chats, state },
  });

  return json({ ok: true, is_accepting_chats: body.is_accepting_chats });
}
