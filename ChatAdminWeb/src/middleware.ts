// Edge middleware — protects all routes except auth pages and public API.
// Uses jose for JWT verification (Edge-compatible).
import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "cc_session";
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || "dev-only-secret-change-me";

// Paths that don't require authentication
// ⚠️ /signup และ /reset-password ถูกลบแล้ว — ระบบใช้ SSO ขององค์กร
const PUBLIC_PAGES = ["/login"];
const PUBLIC_API = [
  "/api/auth/sso/login", // SSO login — redirect ไป system81
  "/api/auth/sso/callback", // SSO callback — รับ token จาก system81
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  if (PUBLIC_API.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  // Static assets and Next.js internals
  if (pathname.startsWith("/_next/") || pathname.startsWith("/favicon")) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    // For API routes, return 401 JSON; for pages, redirect to /login
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ detail: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Verify JWT signature + expiry (lightweight, no DB call in Edge)
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (payload.type !== "session") {
      throw new Error("not a session token");
    }
    return NextResponse.next();
  } catch {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ detail: "invalid or expired session" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    const res = NextResponse.redirect(url);
    res.cookies.delete(COOKIE_NAME);
    return res;
  }
}

export const config = {
  // Match all paths except static files and Next.js internals
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
