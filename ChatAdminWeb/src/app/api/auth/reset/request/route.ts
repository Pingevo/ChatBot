// POST /api/auth/reset/request — request password reset link by email.
// ⚠️ ปิดใช้งานแล้ว — ระบบใช้ SSO ขององค์กร รีเซตรหัสผ่านผ่าน SSO provider
// import { auth } from "@/backend/service/authService";
// import { json, error, readJson } from "@/backend/lib/http";
// import { serverConfig } from "@/backend/lib/config";
// import { sendEmail, resetLinkEmailHtml } from "@/backend/lib/email";
//
// export async function POST(req: Request) { ... }

export async function POST() {
  return Response.json(
    { detail: "ระบบใช้ SSO ขององค์กร — รีเซตรหัสผ่านผ่าน SSO provider" },
    { status: 410 }
  );
}
