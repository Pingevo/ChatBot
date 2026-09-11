// GET /api/auth/sso/callback — system81 redirect กลับมาพร้อม ?token=<jwt>
// Flow:
//   1. รับ token จาก query param
//   2. เรียก system81 /system81/userinfo เพื่อดึง profile
//   3. หา admin ใน DB ของเราด้วย email หรือ system81_username
//   4. ถ้าไม่มี → สร้างใหม่เป็น role=admin (auto-provision)
//   5. สร้าง session + set cookie + log + redirect ไปหน้า dashboard
// 🔒 L1: Token ใน query string เป็น SSO flow มาตรฐาน — เพิ่ม headers ป้องกัน referrer/cache leak
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { setSessionCookie } from "@/backend/lib/cookies";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import type { AdminDoc } from "@/backend/service/authService";
import { serverConfig } from "@/backend/lib/config";

const SSO_BASE_URL = (process.env.SELLCENTER_OAUTH_BASE_URL || "https://data.digital.in.th").replace(/\/+$/, "");
const AUTO_PROVISION_DOMAIN = process.env.SSO_AUTO_PROVISION_DOMAIN || "@itsr.co.th";
// ⚠️ ห้ามใช้ req.url เป็น base ของ redirect ที่นี่ — Next.js standalone server (behind
// nginx reverse proxy) resolve req.url ด้วย HOSTNAME/PORT ของ container เอง
// (เช่น http://0.0.0.0:3000) ไม่ใช่โดเมนจริงที่ผู้ใช้เห็น แม้ nginx จะส่ง Host header
// ที่ถูกต้องมาแล้วก็ตาม — ต้องใช้ APP_BASE_URL เป็น base เสมอ
const REDIRECT_BASE = serverConfig.appBaseUrl;

function cleanName(str: string): string {
  return str ? String(str).trim().replace(/\s+/g, " ") : str;
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

// 🔒 L1: Add security headers to prevent token leakage via referrer/cache
function _secureRedirect(url: URL, req: NextRequest): NextResponse {
  const res = NextResponse.redirect(url);
  // 🔒 L1: Prevent token from leaking via Referer header
  res.headers.set("Referrer-Policy", "no-referrer");
  // 🔒 L1: Prevent caching of the callback response
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token");
  const ssoError = searchParams.get("error");
  const returnTo = req.cookies.get("sso_return_to")?.value || "/dashboard";

  // ล้าง cookie sso_return_to
  const clearCookie = (res: NextResponse) => {
    res.cookies.delete("sso_return_to");
    // 🔒 L1: Add security headers to all redirect responses
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return res;
  };

  if (ssoError) {
    const res = NextResponse.redirect(new URL(`/login?error=sso_failed`, REDIRECT_BASE));
    return clearCookie(res);
  }
  if (!token) {
    const res = NextResponse.redirect(new URL(`/login?error=no_token`, REDIRECT_BASE));
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
    const res = NextResponse.redirect(new URL(`/login?error=userinfo_failed`, REDIRECT_BASE));
    return clearCookie(res);
  }

  if (!userInfo?.username) {
    const res = NextResponse.redirect(new URL(`/login?error=invalid_token`, REDIRECT_BASE));
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
      const res = NextResponse.redirect(new URL(`/login?error=not_allowed`, REDIRECT_BASE));
      return clearCookie(res);
    }

    // 🔒 L3: Auto-provision with admin role but inactive — needs superadmin approval
    // Previously: created as active admin immediately (privilege escalation risk)
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
    // 🔒 L3: Mark as inactive — superadmin must manually activate
    await coll.updateOne(
      { admin_id: admin.admin_id },
      { $set: { active: false, sso_pending_approval: true } }
    );
    // 🔒 L3: Also remove password_hash since login is via SSO only
    await coll.updateOne({ admin_id: admin.admin_id }, { $unset: { password_hash: "" } });
    const res = NextResponse.redirect(new URL(`/login?error=pending_approval`, req.url));
    return clearCookie(res);
  }

  if (!admin.active) {
    const res = NextResponse.redirect(new URL(`/login?error=account_disabled`, REDIRECT_BASE));
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
  const res = NextResponse.redirect(new URL(target, REDIRECT_BASE));
  setSessionCookie(res, sessionToken);
  res.cookies.delete("sso_return_to");
  // 🔒 L1: Prevent token leakage via referrer/cache
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  return res;
}
