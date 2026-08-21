// POST /api/auth/signup/request — superadmin or dev invites a new admin by email.
// ⚠️ ปิดใช้งานแล้ว — ระบบใช้ SSO ขององค์กร ไม่มีการเชิญสมาชิกด้วย email อีกต่อไป
// ผู้ใช้ใหม่ login ผ่าน SSO แล้วจะถูกสร้างเป็น role=admin อัตโนมัติ
// import { auth } from "@/backend/service/authService";
// import { json, error, readJson } from "@/backend/lib/http";
// import { getCookieFromRequest } from "@/backend/lib/cookies";
// import { serverConfig } from "@/backend/lib/config";
// import { sendEmail, inviteEmailHtml } from "@/backend/lib/email";
//
// interface SignupRequestBody {
//   email?: string;
//   name?: string;
// }
//
// export async function POST(req: Request) {
//   const token = getCookieFromRequest(req);
//   if (!token) return error("unauthorized", 401);
//   const session = await auth.getSession(token);
//   if (!session) return error("invalid or expired session", 401);
//   const inviter = await auth.getAdminById(session.admin_id);
//   if (!inviter) return error("admin not found", 401);
//   if (inviter.role !== "superadmin" && inviter.role !== "dev") {
//     return error("เฉพาะ superadmin หรือ dev เท่านั้นที่เชิญสมาชิกได้", 403);
//   }
//   ...
// }

export async function POST() {
  return Response.json(
    { detail: "ระบบใช้ SSO ขององค์กร — ไม่มีการเชิญสมาชิกด้วย email อีกต่อไป" },
    { status: 410 }
  );
}
