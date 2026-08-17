// HttpOnly cookie helpers — server-side only.
import { serverConfig } from "./config";
import { NextResponse } from "next/server";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: serverConfig.isProd,
  sameSite: "lax" as const,
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
