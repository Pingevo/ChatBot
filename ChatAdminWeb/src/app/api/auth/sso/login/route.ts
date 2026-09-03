// GET /api/auth/sso/login — redirect ไปหน้า login กลางของ system81 (sellcenter)
// หลัง login สำเร็จ system81 จะ redirect กลับมาที่ /api/auth/sso/callback?token=<jwt>
import { NextResponse, type NextRequest } from "next/server";

const SSO_BASE_URL = (process.env.SELLCENTER_OAUTH_BASE_URL || "https://data.digital.in.th").replace(/\/+$/, "");
const APP_NAME = process.env.SSO_APP_NAME || "Chat Admin";
const AUTO_PROVISION_DOMAIN = process.env.SSO_AUTO_PROVISION_DOMAIN || "@itsr.co.th";

function getBaseUrl(req: NextRequest): string {
  // ใช้ origin ของ request เป็น base url
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  // Prefer APP_BASE_URL env var (secure) — fallback to request headers only for local dev
  const baseUrl = process.env.APP_BASE_URL?.replace(/\/+$/, "") || getBaseUrl(req);
  const callbackUrl = `${baseUrl}/api/auth/sso/callback`;

  const params = new URLSearchParams({
    redirect_uri: callbackUrl,
    app_name: APP_NAME,
  });

  // เก็บ returnTo ไว้ใน cookie เพื่อ callback ใช้ redirect กลับ
  const returnTo = req.nextUrl.searchParams.get("returnTo") || "/dashboard";
  const res = NextResponse.redirect(`${SSO_BASE_URL}/system81/login?${params.toString()}`);
  res.cookies.set("sso_return_to", returnTo, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600, // 10 นาที
    path: "/",
  });
  return res;
}

// export ให้ callback ใช้
export { SSO_BASE_URL, AUTO_PROVISION_DOMAIN };
