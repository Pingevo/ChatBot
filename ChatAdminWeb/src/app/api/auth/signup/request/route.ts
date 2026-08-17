// POST /api/auth/signup/request — superadmin invites a new admin by email.
// Sends a signup link with a 15-minute token via Resend automatically.
import { auth } from "@/backend/service/authService";
import { json, error, readJson } from "@/backend/lib/http";
import { getCookieFromRequest } from "@/backend/lib/cookies";
import { serverConfig } from "@/backend/lib/config";
import { sendEmail, inviteEmailHtml } from "@/backend/lib/email";

interface SignupRequestBody {
  email?: string;
  role?: "admin" | "dev";
  name?: string;
}

export async function POST(req: Request) {
  // Authorization: only logged-in superadmin can invite
  const token = getCookieFromRequest(req);
  if (!token) return error("unauthorized", 401);
  const session = await auth.getSession(token);
  if (!session) return error("invalid or expired session", 401);
  const inviter = await auth.getAdminById(session.admin_id);
  if (!inviter) return error("admin not found", 401);
  if (inviter.role !== "superadmin") {
    return error("เฉพาะ superadmin เท่านั้นที่เชิญสมาชิกได้", 403);
  }

  const body = await readJson<SignupRequestBody>(req);
  if (!body || !body.email) {
    return error("email จำเป็นต้องกรอก", 422);
  }

  const role: "admin" | "dev" = body.role === "dev" ? "dev" : "admin";

  const existing = await auth.getAdminByEmail(body.email);
  if (existing) {
    // Don't reveal whether email exists — respond as success
    return json({ message: "หาก email นี้ไม่มีในระบบ เราจะส่งลิงก์สมัครไปที่อีเมลของคุณ" });
  }

  const { token: signupToken, exp } = await auth.createAuthToken("signup", body.email);
  await auth.storeAuthToken(signupToken, "signup", body.email, exp);

  const link = `${serverConfig.appBaseUrl}/signup?token=${signupToken}&role=${role}&name=${encodeURIComponent(body.name || "")}`;

  // Send invitation email via Resend
  const emailResult = await sendEmail({
    to: body.email,
    subject: "คำเชิญเข้าร่วมระบบ ITSRC",
    html: inviteEmailHtml(link, role),
  });

  if (emailResult.devMode) {
    return json({
      message: "สร้างลิงก์เชิญแล้ว (dev mode — ยังไม่ส่งอีเมลจริง)",
      invite_link: link,
      expires_in_minutes: serverConfig.authTokenMinutes,
    });
  }

  if (!emailResult.sent) {
    return json({ message: `สร้างลิงก์แล้ว แต่ส่งอีเมลไม่สำเร็จ: ${emailResult.error}` });
  }

  return json({ message: "ส่งลิงก์สมัครไปที่อีเมลแล้ว" });
}
