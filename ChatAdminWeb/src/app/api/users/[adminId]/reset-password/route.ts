// POST /api/users/[adminId]/reset-password — superadmin resets an admin's password
// ⚠️ ปิดใช้งานแล้ว — ระบบใช้ SSO ขององค์กร รีเซตรหัสผ่านผ่าน SSO provider
// import { NextRequest } from "next/server";
// import { auth } from "@/backend/service/authService";
// import { requireSuperadmin, canEditTarget } from "@/backend/middleware/authorize";
// import { json, error, readJson } from "@/backend/lib/http";
// import { logAdminEvent } from "@/backend/service/adminLogService";
//
// export async function POST(req, { params }) { ... }

export async function POST() {
  return Response.json(
    { detail: "ระบบใช้ SSO ขององค์กร — รีเซตรหัสผ่านผ่าน SSO provider" },
    { status: 410 }
  );
}
