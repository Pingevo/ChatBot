// POST /api/auth/otp/request — request an OTP for self-service actions
// (e.g. changing own password). Sends the code to the admin's own email.
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";
import { sendEmail, otpEmailHtml } from "@/backend/lib/email";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ purpose?: string }>(req).catch(() => ({} as { purpose?: string }));
  const purpose = String(body?.purpose || "เปลี่ยนรหัสผ่าน");

  const code = await auth.createSelfOtp(r.ctx.admin.admin_id, r.ctx.admin.email);
  const emailResult = await sendEmail({
    to: r.ctx.admin.email,
    subject: `รหัสยืนยัน OTP — ${purpose}`,
    html: otpEmailHtml(code, purpose),
  });

  return json({
    message: emailResult.sent
      ? "ส่งรหัส OTP ไปยังอีเมลของคุณแล้ว"
      : emailResult.devMode
      ? "สร้างรหัส OTP แล้ว (dev mode — ยังไม่ส่งอีเมลจริง)"
      : `ส่งอีเมลไม่สำเร็จ: ${emailResult.error}`,
    email_sent: emailResult.sent,
    dev_mode: emailResult.devMode,
    // In dev mode, expose the code so the developer can test the UI.
    dev_code: emailResult.devMode ? code : undefined,
    expires_in_minutes: 10,
  });
}
