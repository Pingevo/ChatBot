// POST /api/profile/password — change own password
// Requires: current_password, new_password, otp_code
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";
import { verifyPassword } from "@/backend/lib/password";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    current_password?: string;
    new_password?: string;
    otp_code?: string;
  }>(req).catch(() => null);

  if (!body?.current_password || !body?.new_password || !body?.otp_code) {
    return error("current_password, new_password, otp_code จำเป็นต้องกรอก", 422);
  }
  if (body.new_password.length < 8) {
    return error("รหัสผ่านใหม่ต้องอย่างน้อย 8 ตัวอักษร", 422);
  }

  // Verify OTP
  const otpOk = await auth.verifySelfOtp(r.ctx.admin.admin_id, String(body.otp_code).trim());
  if (!otpOk) return error("รหัส OTP ไม่ถูกต้องหรือหมดอายุ", 401);

  // Verify current password against stored hash
  const valid = await verifyPassword(body.current_password, r.ctx.admin.password_hash);
  if (!valid) return error("รหัสผ่านปัจจุบันไม่ถูกต้อง", 401);

  // Update password
  const ok = await auth.updatePassword(r.ctx.admin.admin_id, body.new_password);
  if (!ok) return error("เปลี่ยนรหัสผ่านไม่สำเร็จ", 500);

  return json({ ok: true });
}
