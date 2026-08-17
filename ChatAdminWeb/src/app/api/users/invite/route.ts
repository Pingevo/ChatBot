// POST /api/users/invite — superadmin invites a new admin by email
// Sends the signup link to the invitee's email via Resend automatically.
// In dev mode (no RESEND_API_KEY), the link is returned in the response so
// the superadmin can share it manually.
import { NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { serverConfig } from "@/backend/lib/config";
import { sendEmail, inviteEmailHtml } from "@/backend/lib/email";

export async function POST(req: NextRequest) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const body = await readJson(req).catch(() => null);
  if (!body) return error("invalid JSON body", 400);

  const email = String(body.email || "").trim().toLowerCase();
  const role: "admin" | "dev" = body.role === "dev" ? "dev" : "admin";
  const name = String(body.name || "").trim();

  if (!email || !email.includes("@")) return error("valid email required", 400);

  // Check if email already exists
  const existing = await auth.getAdminByEmail(email);
  if (existing) return error("email already registered", 409);

  // Create auth token for signup
  const { token, exp } = await auth.createAuthToken("signup", email);
  await auth.storeAuthToken(token, "signup", email, exp);

  const base = serverConfig.appBaseUrl || "http://localhost:3000";
  const link = `${base}/signup?token=${token}&role=${role}&name=${encodeURIComponent(name)}`;

  // Send invitation email automatically
  const emailResult = await sendEmail({
    to: email,
    subject: "คำเชิญเข้าร่วมระบบ ITSRC",
    html: inviteEmailHtml(link, role),
  });

  return json({
    message: emailResult.sent
      ? "ส่งคำเชิญไปยังอีเมลเรียบร้อยแล้ว"
      : emailResult.devMode
      ? "สร้างคำเชิญแล้ว (dev mode — ส่งลิงก์กลับมาให้แชร์เอง)"
      : `สร้างคำเชิญแล้ว แต่ส่งอีเมลไม่สำเร็จ: ${emailResult.error}`,
    email_sent: emailResult.sent,
    dev_mode: emailResult.devMode,
    // Only expose the link in dev mode so superadmin can share manually.
    // In production with Resend configured, the link is delivered via email.
    link: emailResult.devMode ? link : undefined,
    email,
    role,
  });
}
