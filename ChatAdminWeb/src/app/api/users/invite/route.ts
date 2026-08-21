// POST /api/users/invite — superadmin invites a new admin by email
// ⚠️ ปิดใช้งานแล้ว — ระบบใช้ SSO ขององค์กร ไม่มีการเชิญสมาชิกด้วย email อีกต่อไป
// ผู้ใช้ใหม่ login ผ่าน SSO แล้วจะถูกสร้างเป็น role=admin อัตโนมัติ
// import { NextRequest } from "next/server";
// import { auth } from "@/backend/service/authService";
// import { requireSuperadmin } from "@/backend/middleware/authorize";
// import { json, error, readJson } from "@/backend/lib/http";
// import { serverConfig } from "@/backend/lib/config";
// import { sendEmail, inviteEmailHtml } from "@/backend/lib/email";
// import { logAdminEvent } from "@/backend/service/adminLogService";
//
// export async function POST(req: NextRequest) { ... }

export async function POST() {
  return Response.json(
    { detail: "ระบบใช้ SSO ขององค์กร — ไม่มีการเชิญสมาชิกด้วย email อีกต่อไป" },
    { status: 410 }
  );
}
