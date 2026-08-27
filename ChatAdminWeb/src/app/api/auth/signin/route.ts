// POST /api/auth/signin — login with email + password.
// ⚠️ ปิดใช้งานแล้ว — ระบบใช้ SSO ขององค์กร ไม่มีการ login ด้วย email+password อีกต่อไป
// ปุ่ม "เข้าสู่ระบบด้วย SSO" ในหน้า /login จะ redirect ไป /api/auth/sso/login แทน
// import { auth } from "@/backend/service/authService";
// import { setSessionCookie } from "@/backend/lib/cookies";
// import { json, error, clientIp, readJson } from "@/backend/lib/http";
// import { logAdminEvent } from "@/backend/service/adminLogService";
//
// interface SigninBody {
//   email?: string;
//   password?: string;
// }
//
// export async function POST(req: Request) {
//   const body = await readJson<SigninBody>(req);
//   if (!body || !body.email || !body.password) {
//     return error("email และ password จำเป็นต้องกรอก", 422);
//   }
//
//   const admin = await auth.getAdminByEmail(body.email);
//   if (!admin) {
//     // Don't reveal whether email exists
//     return error("email หรือรหัสผ่านไม่ถูกต้อง", 401);
//   }
//   if (!admin.active) {
//     return error("บัญชีนี้ถูกปิดใช้งาน", 403);
//   }
//   if (auth.isLocked(admin)) {
//     return error("บัญชีถูกล็อคชั่วคราว กรุณาลองใหม่ภายหลัง", 423);
//   }
//
//   const ok = await auth.verifyPassword(body.password, admin.password_hash);
//   if (!ok) {
//     const { locked } = await auth.recordLoginFailure(admin.admin_id);
//     if (locked) {
//       return error("บัญชีถูกล็อคชั่วคราว เนื่องจาก login ผิดหลายครั้ง", 423);
//     }
//     return error("email หรือรหัสผ่านไม่ถูกต้อง", 401);
//   }
//
//   const ip = clientIp(req);
//   await auth.recordLoginSuccess(admin.admin_id, ip);
//
//   const { token, exp } = await auth.createSessionToken(admin.admin_id);
//   await auth.createSession(token, admin.admin_id, exp, ip);
//
//   await logAdminEvent({
//     action_type: "login",
//     actor: admin.admin_id,
//     ip,
//     metadata: { username: admin.username, role: admin.role },
//   });
//
//   const res = json({ admin: auth.safeAdmin(admin) });
//   setSessionCookie(res, token);
//   return res;
// }

export async function POST() {
  return Response.json(
    { detail: "ระบบใช้ SSO ขององค์กร — กรุณาเข้าสู่ระบบผ่านปุ่ม SSO ที่หน้า /login" },
    { status: 410 }
  );
}
