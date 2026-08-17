// GET /api/auth/me — return current admin profile (requires session).
import { auth } from "@/backend/service/authService";
import { getCookieFromRequest } from "@/backend/lib/cookies";
import { json, error } from "@/backend/lib/http";

export async function GET(req: Request) {
  const token = getCookieFromRequest(req);
  if (!token) return error("unauthorized", 401);
  const session = await auth.getSession(token);
  if (!session) return error("invalid or expired session", 401);
  const admin = await auth.getAdminById(session.admin_id);
  if (!admin) return error("admin not found", 401);
  if (!admin.active) return error("admin disabled", 403);
  await auth.updateSessionActivity(token);
  return json({ admin: auth.safeAdmin(admin) });
}
