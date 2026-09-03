// HttpOnly cookie helpers — server-side only.
import { serverConfig } from "./config";
import { NextResponse } from "next/server";

// 🔒 Cookie security:
//   - secure: ใช้ NODE_ENV=production เป็นหลัก แต่อนุญาตให้ override ด้วย COOKIE_SECURE env
//   - sameSite: "strict" เป็น default (admin panel ไม่มี cross-origin API)
//     แต่อนุญาตให้ override ด้วย COOKIE_SAMESITE env (สำหรับกรณีพิเศษ)
const cookieSecure = process.env.COOKIE_SECURE === "true" ? true
  : process.env.COOKIE_SECURE === "false" ? false
  : serverConfig.isProd;
const cookieSameSite = (process.env.COOKIE_SAMESITE as "strict" | "lax" | "none" | undefined) || "strict";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: cookieSecure,
  sameSite: cookieSameSite as "strict" | "lax" | "none",
  path: "/",
  maxAge: serverConfig.sessionHours * 3600,
};

export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(serverConfig.cookieName, token, COOKIE_OPTIONS);
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(serverConfig.cookieName, "", {
    ...COOKIE_OPTIONS,
    maxAge: 0,
  });
}

export function getCookieFromRequest(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k, v.join("=")];
    })
  );
  return cookies[serverConfig.cookieName] || null;
}
