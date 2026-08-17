// POST /api/auth/reset/request — request password reset link by email.
// Sends the reset link via Resend automatically. In dev mode (no
// RESEND_API_KEY), returns the link in the response for testing.
import { auth } from "@/backend/service/authService";
import { json, error, readJson } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";
import { sendEmail, resetLinkEmailHtml } from "@/backend/lib/email";

interface ResetRequestBody {
  email?: string;
}

export async function POST(req: Request) {
  const body = await readJson<ResetRequestBody>(req);
  if (!body || !body.email) {
    return error("email จำเป็นต้องกรอก", 422);
  }

  const admin = await auth.getAdminByEmail(body.email);
  if (!admin) {
    // Don't reveal whether email exists
    return json({ message: "หาก email นี้มีในระบบ เราจะส่งลิงก์รีเซตรหัสผ่านไปที่อีเมลของคุณ" });
  }

  const { token, exp } = await auth.createAuthToken("reset_password", body.email, admin.admin_id);
  await auth.storeAuthToken(token, "reset_password", body.email, exp, admin.admin_id);

  const link = `${serverConfig.appBaseUrl}/reset-password?token=${token}`;

  // Send reset link via Resend
  const emailResult = await sendEmail({
    to: body.email,
    subject: "รีเซ็ตรหัสผ่าน ITSRC",
    html: resetLinkEmailHtml(link, admin.name),
  });

  if (emailResult.devMode) {
    // Dev mode — return the link so the developer can test
    return json({
      message: "สร้างลิงก์รีเซตแล้ว (dev mode — ยังไม่ส่งอีเมลจริง)",
      reset_link: link,
      expires_in_minutes: serverConfig.authTokenMinutes,
    });
  }

  if (!emailResult.sent) {
    return json({
      message: `สร้างลิงก์แล้ว แต่ส่งอีเมลไม่สำเร็จ: ${emailResult.error}`,
    });
  }

  return json({ message: "หาก email นี้มีในระบบ เราจะส่งลิงก์รีเซตรหัสผ่านไปที่อีเมลของคุณ" });
}
