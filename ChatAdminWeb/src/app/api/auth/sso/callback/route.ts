// GET /api/auth/sso/callback — system81 redirect กลับมาพร้อม ?token=<jwt>
// Flow:
//   1. รับ token จาก query param
//   2. เรียก system81 /system81/userinfo เพื่อดึง profile
//   3. หา admin ใน DB ของเราด้วย email หรือ system81_username
//   4. ถ้าไม่มี → สร้างใหม่เป็น role=admin (auto-provision)
//   5. สร้าง session + set cookie + log + redirect ไปหน้า dashboard
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { setSessionCookie } from "@/backend/lib/cookies";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { AdminDoc } from "@/backend/service/authService";

const SSO_BASE_URL = (process.env.SELLCENTER_OAUTH_BASE_URL || "https://data.digital.in.th").replace(/\/+$/, "");
const AUTO_PROVISION_DOMAIN = process.env.SSO_AUTO_PROVISION_DOMAIN || "@itsr.co.th";

function cleanName(str: string): string {
  return str ? String(str).trim().replace(/\s+/g, " ") : str;
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token");
  const ssoError = searchParams.get("error");
  const returnTo = req.cookies.get("sso_return_to")?.value || "/dashboard";

  // ล้าง cookie sso_return_to
  const clearCookie = (res: NextResponse) => {
    res.cookies.delete("sso_return_to");
    return res;
  };

  if (ssoError) {
    const res = NextResponse.redirect(new URL(`/login?error=sso_failed`, req.url));
    return clearCookie(res);
  }
  if (!token) {
    const res = NextResponse.redirect(new URL(`/login?error=no_token`, req.url));
    return clearCookie(res);
  }

  // ดึง userinfo จาก system81
  let userInfo: { username?: string; name?: string; email?: string };
  try {
    const resp = await fetch(`${SSO_BASE_URL}/system81/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`userinfo ${resp.status}`);
    const data = await resp.json();
    userInfo = data.success ? data.user : data;
  } catch {
    const res = NextResponse.redirect(new URL(`/login?error=userinfo_failed`, req.url));
    return clearCookie(res);
  }

  if (!userInfo?.username) {
    const res = NextResponse.redirect(new URL(`/login?error=invalid_token`, req.url));
    return clearCookie(res);
  }

  const ssoUsername = userInfo.username;
  const email = (userInfo.email || ssoUsername).toLowerCase();

  // หา admin ใน DB ของเรา
  let admin = await auth.getAdminByEmail(email);
  if (!admin && ssoUsername.includes("@")) {
    // fallback: ลองตัดโดเมนออก แล้วหาด้วย username
    const localPart = ssoUsername.split("@")[0];
    admin = await auth.getAdminByUsername(localPart);
  }

  // Auto-provision: สร้าง admin ใหม่ถ้าอีเมลอยู่ในโดเมนที่อนุญาต
  if (!admin) {
    if (!ssoUsername.toLowerCase().endsWith(AUTO_PROVISION_DOMAIN)) {
      const res = NextResponse.redirect(new URL(`/login?error=not_allowed`, req.url));
      return clearCookie(res);
    }

    // สร้าง admin ใหม่ — role=admin (default), ไม่มี password (ใช้ SSO)
    const username = ssoUsername.includes("@") ? ssoUsername.split("@")[0] : ssoUsername;
    const coll = await getCollection<AdminDoc>(COLLECTIONS.admins);
    const randomPassword = Math.random().toString(36).slice(2) + Date.now().toString(36);
    admin = await auth.createAdmin({
      email,
      username,
      password: randomPassword, // ไม่ได้ใช้ — login ผ่าน SSO เท่านั้น
      name: cleanName(userInfo.name || username),
      role: "admin",
      createdBy: "sso_auto_provision",
    });
    // ลบ password_hash ออก — ไม่จำเป็นเพราะ login ผ่าน SSO
    await coll.updateOne({ admin_id: admin.admin_id }, { $unset: { password_hash: "" } });
  }

  if (!admin.active) {
    const res = NextResponse.redirect(new URL(`/login?error=account_disabled`, req.url));
    return clearCookie(res);
  }

  // บันทึก last login
  const ip = clientIp(req);
  await auth.recordLoginSuccess(admin.admin_id, ip);

  // สร้าง session
  const { token: sessionToken, exp } = await auth.createSessionToken(admin.admin_id);
  await auth.createSession(sessionToken, admin.admin_id, exp, ip);

  // Log login event
  await logAdminEvent({
    action_type: "login",
    actor: admin.admin_id,
    ip,
    metadata: {
      username: admin.username,
      role: admin.role,
      sso_username: ssoUsername,
      method: "sso",
    },
  });

  // Redirect ไปหน้า dashboard พร้อม set cookie
  const target = returnTo.startsWith("/") ? returnTo : "/dashboard";
  const res = NextResponse.redirect(new URL(target, req.url));
  setSessionCookie(res, sessionToken);
  res.cookies.delete("sso_return_to");
  return res;
}
