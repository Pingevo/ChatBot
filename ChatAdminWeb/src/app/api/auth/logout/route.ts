// POST /api/auth/logout — revoke current session and clear cookie.
import { auth } from "@/backend/service/authService";
import { clearSessionCookie, getCookieFromRequest } from "@/backend/lib/cookies";
import { json, error } from "@/backend/lib/http";

export async function POST(req: Request) {
  const token = getCookieFromRequest(req);
  if (!token) {
    // Already logged out — clear cookie anyway
    const res = json({ message: "logout สำเร็จ" });
    clearSessionCookie(res);
    return res;
  }
  await auth.revokeSession(token).catch(() => {});
  const res = json({ message: "logout สำเร็จ" });
  clearSessionCookie(res);
  return res;
}
