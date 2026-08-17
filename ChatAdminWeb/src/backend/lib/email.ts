// Email sending — server-side only. Uses Resend REST API directly (no SDK
// dependency needed). Falls back to dev-mode (console log + return content)
// when RESEND_API_KEY is not configured, matching the existing convention
// used by /api/auth/signup/request and /api/auth/reset/request.
import { serverConfig } from "./config";

export interface SendEmailResult {
  sent: boolean;
  devMode: boolean;
  error?: string;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<SendEmailResult> {
  if (!serverConfig.resendApiKey) {
    // Dev mode — no real email provider configured. Log so the developer
    // can see the content, and let the caller decide whether to expose the
    // link/code directly in the API response for testing.
    console.warn(
      `[email:dev-mode] to=${opts.to} subject=${opts.subject}\n${opts.html}`
    );
    return { sent: false, devMode: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serverConfig.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: serverConfig.emailFrom,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[email] Resend API error ${res.status}: ${text}`);
      return { sent: false, devMode: false, error: `resend_error_${res.status}` };
    }
    return { sent: true, devMode: false };
  } catch (e) {
    console.error("[email] send failed:", e);
    return { sent: false, devMode: false, error: "send_failed" };
  }
}

// ---- Email templates (simple inline HTML) ----

export function otpEmailHtml(code: string, purpose: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0b3954;">รหัสยืนยัน OTP</h2>
      <p>รหัส OTP สำหรับ${purpose}ของคุณคือ:</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; background:#f1f5f9; padding: 16px; text-align:center; border-radius: 8px; color:#0b3954;">
        ${code}
      </div>
      <p style="color:#64748b; font-size: 13px; margin-top: 16px;">รหัสนี้จะหมดอายุใน 10 นาที หากคุณไม่ได้ทำรายการนี้ กรุณาละเว้นอีเมลฉบับนี้</p>
    </div>
  `;
}

export function resetLinkEmailHtml(link: string, targetName?: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0b3954;">รีเซ็ตรหัสผ่านของคุณ</h2>
      <p>${targetName ? `สวัสดีคุณ ${targetName},` : "สวัสดีค่ะ,"}</p>
      <p>ผู้ดูแลระบบได้ทำการร้องขอให้คุณรีเซ็ตรหัสผ่านบัญชีของคุณ กรุณากดลิงก์ด้านล่างเพื่อตั้งรหัสผ่านใหม่:</p>
      <p style="text-align:center; margin: 24px 0;">
        <a href="${link}" style="background:#087e8b; color:#fff; padding: 12px 24px; border-radius: 8px; text-decoration:none; font-weight:600;">ตั้งรหัสผ่านใหม่</a>
      </p>
      <p style="color:#64748b; font-size: 13px;">ลิงก์นี้จะหมดอายุใน 15 นาที หากคุณไม่ได้ร้องขอ กรุณาละเว้นอีเมลฉบับนี้</p>
    </div>
  `;
}

export function inviteEmailHtml(link: string, role: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0b3954;">คำเชิญเข้าร่วมระบบ ITSRC</h2>
      <p>คุณได้รับเชิญให้เข้าร่วมระบบในบทบาท <strong>${role}</strong></p>
      <p style="text-align:center; margin: 24px 0;">
        <a href="${link}" style="background:#087e8b; color:#fff; padding: 12px 24px; border-radius: 8px; text-decoration:none; font-weight:600;">สมัครใช้งาน</a>
      </p>
      <p style="color:#64748b; font-size: 13px;">ลิงก์นี้จะหมดอายุใน 15 นาที</p>
    </div>
  `;
}
