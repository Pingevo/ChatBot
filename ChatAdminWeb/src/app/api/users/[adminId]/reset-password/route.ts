// POST /api/users/[adminId]/reset-password — superadmin resets an admin's password
import { NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { requireSuperadmin, canEditTarget } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ adminId: string }> }
) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const { adminId } = await params;
  const body = await readJson(req).catch(() => null);
  if (!body) return error("invalid JSON body", 400);

  const newPassword = String(body.password || "");
  if (newPassword.length < 8) return error("password must be at least 8 characters", 400);

  const target = await auth.getAdminById(adminId);
  if (!target) return error("user not found", 404);

  if (!canEditTarget(r.ctx.admin, target)) {
    return error("cannot reset password for this user", 403);
  }

  const ok = await auth.updatePassword(adminId, newPassword);
  if (!ok) return error("failed to update password", 500);

  // Revoke all sessions for the target user
  await auth.revokeAllSessions(adminId);

  return json({ message: "password reset successful" });
}
