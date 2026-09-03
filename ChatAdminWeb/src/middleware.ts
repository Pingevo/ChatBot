// Edge middleware — protects all routes except auth pages and public API.
// Uses jose for JWT verification (Edge-compatible).
import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { rateLimit, rateLimitKey, cleanupRateLimitBuckets } from "@/backend/lib/rateLimit";

const COOKIE_NAME = "cc_session";
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("ADMIN_JWT_SECRET env var is required — refusing to start with insecure default");
}

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

// 🔒 CSRF defense-in-depth — ตรวจ Origin header สำหรับ state-changing requests
// ป้องกัน cross-site form submission แม้ sameSite=strict ถูก bypass ในอนาคต
// ถ้า APP_BASE_URL ตั้งไว้ จะเช็ค origin ตรงๆ ถ้าไม่ตั้ง จะเช็คว่า origin == host (same-origin)
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const APP_BASE_URL = process.env.APP_BASE_URL;

function isOriginAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  // ถ้าไม่มี Origin header (เช่น curl, internal service) — อนุญาต
  // browser จะส่ง Origin เสมอสำหรับ cross-origin และ state-changing requests
  if (!origin) return true;

  // ถ้าตั้ง APP_BASE_URL — เช็คว่า origin ตรงกับที่ตั้งไว้
  if (APP_BASE_URL) {
    try {
      const allowed = new URL(APP_BASE_URL);
      const requestOrigin = new URL(origin);
      return (
        requestOrigin.protocol === allowed.protocol &&
        requestOrigin.host === allowed.host
      );
    } catch {
      return false;
    }
  }

  // ถ้าไม่ตั้ง APP_BASE_URL — เช็คว่า origin == request host (same-origin)
  try {
    const requestOrigin = new URL(origin);
    const requestHost = req.headers.get("host");
    return requestOrigin.host === requestHost;
  } catch {
    return false;
  }
}

// 🔒 Rate limit config — เข้มข้นสำหรับ auth endpoints, เบาสำหรับทั่วไป
const AUTH_RATE_LIMIT = { limit: 20, windowMs: 60_000 }; // 20 req/min สำหรับ SSO login/callback
const API_RATE_LIMIT = { limit: 300, windowMs: 60_000 }; // 300 req/min สำหรับ API ทั่วไป
let lastCleanup = Date.now();

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 🔒 Rate limiting — ทำก่อนอื่นเพื่อป้องกัน DoS
  // cleanup เป็นครั้งคราว (ทุก 5 นาที) เพื่อป้องกัน memory leak
  const now = Date.now();
  if (now - lastCleanup > 300_000) {
    cleanupRateLimitBuckets();
    lastCleanup = now;
  }

  const isAuthEndpoint = pathname === "/api/auth/sso/login" || pathname === "/api/auth/sso/callback";
  const isApi = pathname.startsWith("/api/");
  if (isAuthEndpoint) {
    const key = rateLimitKey(req);
    const result = rateLimit(key, AUTH_RATE_LIMIT);
    if (!result.ok) {
      return NextResponse.json(
        { detail: "too many requests — please try again later" },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil((result.resetAt - now) / 1000)),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": "0",
          },
        }
      );
    }
  } else if (isApi) {
    const key = rateLimitKey(req);
    const result = rateLimit(key, API_RATE_LIMIT);
    if (!result.ok) {
      return NextResponse.json(
        { detail: "too many requests — please try again later" },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil((result.resetAt - now) / 1000)),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": "0",
          },
        }
      );
    }
  }

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // 🔒 CSRF origin check — สำหรับ state-changing API requests
  // ข้าม SSO callback (รับ token จาก external service — ไม่ใช่ browser form)
  const isStateChanging = STATE_CHANGING_METHODS.has(req.method);
  const isSsoCallback = pathname === "/api/auth/sso/callback";
  if (isApi && isStateChanging && !isSsoCallback) {
    if (!isOriginAllowed(req)) {
      return NextResponse.json(
        { detail: "cross-origin request blocked" },
        { status: 403 }
      );
    }
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
