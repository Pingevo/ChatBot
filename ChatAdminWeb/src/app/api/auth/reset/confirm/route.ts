// POST /api/auth/reset/confirm — set new password with token from email link.
// Accepts both `password` and `new_password` for compatibility.
import { auth } from "@/backend/service/authService";
import { json, error, readJson } from "@/backend/lib/http";

interface ResetConfirmBody {
  token?: string;
  password?: string;
  new_password?: string; // alias
}

export async function POST(req: Request) {
  const body = await readJson<ResetConfirmBody>(req);
  if (!body || !body.token) {
    return error("token จำเป็นต้องกรอก", 422);
  }
  const newPassword = body.password ?? body.new_password;
  if (!newPassword) {
    return error("password จำเป็นต้องกรอก", 422);
  }
  if (newPassword.length < 8) {
    return error("password ต้องอย่างน้อย 8 ตัวอักษร", 422);
  }

  const payload = await auth.consumeAuthToken(body.token);
  if (!payload) {
    return error("token ไม่ถูกต้องหรือหมดอายุแล้ว", 401);
  }
  if (payload.purpose !== "reset_password") {
    return error("token ไม่ใช้สำหรับ reset password", 400);
  }
  if (!payload.admin_id) {
    return error("token ไม่มี admin_id", 400);
  }

  const admin = await auth.getAdminById(payload.admin_id);
  if (!admin) {
    return error("ไม่พบบัญชี admin", 404);
  }

  if (!(await auth.updatePassword(admin.admin_id, newPassword))) {
    return error("ไม่สามารถอัปเดตรหัสผ่านได้", 500);
  }

  // Revoke all sessions — force re-login
  await auth.revokeAllSessions(admin.admin_id);

  return json({ message: "รีเซตรหัสผ่านสำเร็จ กรุณา login ใหม่" });
}
