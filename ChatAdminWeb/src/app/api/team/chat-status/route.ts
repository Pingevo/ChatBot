// GET /api/team/chat-status — สถานะรับแชท + เวลาทำงานวันนี้ของทุก admin
// ใช้ในหน้า Team เพื่อแสดงใครเปิด/ปิดรับแชทอยู่ และเวลาทำงานวันนี้
//
// สิทธิ์: superadmin / dev / admin (admin ดูได้ แต่แก้ไม่ได้)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";
import { chatAcceptService } from "@/backend/service/chatAcceptService";

interface AdminBasic {
  admin_id: string;
  name: string;
  username: string;
  role: string;
  active: boolean;
  is_accepting_chats?: boolean;
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  // ดึง admins list (เฉพาะ active)
  const admins = await auth.listAdmins();
  const activeAdmins = admins.filter((a) => a.active);
  const adminIds = activeAdmins.map((a) => a.admin_id);

  // ดึงสถานะปัจจุบัน + stats วันนี้ batch
  const [currentStates, todayStats] = await Promise.all([
    chatAcceptService.getCurrentStates(adminIds),
    chatAcceptService.getTodayStatsBatch(adminIds),
  ]);

  const rows = activeAdmins.map((a) => {
    const current = currentStates[a.admin_id] || null;
    const stats = todayStats[a.admin_id] || {
      accepting_ms: 0,
      paused_ms: 0,
      accepting_sessions: 0,
      paused_sessions: 0,
    };
    return {
      admin_id: a.admin_id,
      name: a.name,
      username: a.username,
      role: a.role,
      // สถานะปัจจุบัน — ถ้าไม่มี session เปิดอยู่ ให้ดูจาก is_accepting_chats ของ profile
      current_state: current?.state || (a.is_accepting_chats === false ? "paused" : "accepting"),
      current_since: current?.since || null,
      // stats วันนี้
      accepting_ms: stats.accepting_ms,
      paused_ms: stats.paused_ms,
      accepting_sessions: stats.accepting_sessions,
      paused_sessions: stats.paused_sessions,
    };
  });

  return json({ rows });
}
