// POST /api/auth/logout — revoke current session and clear cookie.
import { auth } from "@/backend/service/authService";
import { clearSessionCookie, getCookieFromRequest } from "@/backend/lib/cookies";
import { json, error } from "@/backend/lib/http";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function POST(req: Request) {
  const token = getCookieFromRequest(req);
  if (!token) {
    // Already logged out — clear cookie anyway
    const res = json({ message: "logout สำเร็จ" });
    clearSessionCookie(res);
    return res;
  }
  // Try to identify the user before revoking, for audit log
  const session = await auth.getSession(token).catch(() => null);
  await auth.revokeSession(token).catch(() => {});
  if (session?.admin_id) {
    await logAdminEvent({
      action_type: "logout",
      actor: session.admin_id,
    }).catch(() => {});
  }
  const res = json({ message: "logout สำเร็จ" });
  clearSessionCookie(res);
  return res;
}
