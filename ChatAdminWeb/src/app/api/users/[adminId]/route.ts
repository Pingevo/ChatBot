// PATCH /api/users/[adminId] — superadmin updates an admin's profile (name, username, role, active)
import { NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { requireSuperadmin, canEditTarget } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ adminId: string }> }
) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const { adminId } = await params;
  const body = await readJson(req).catch(() => null);
  if (!body) return error("invalid JSON body", 400);

  const target = await auth.getAdminById(adminId);
  if (!target) return error("user not found", 404);

  if (!canEditTarget(r.ctx.admin, target)) {
    return error("cannot edit this user", 403);
  }

  const updates: { name?: string; username?: string; channels_access?: string[]; role?: "admin" } = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name) updates.name = name;
  }
  if (body.username !== undefined) {
    const username = String(body.username).trim();
    if (username.length < 3) return error("username must be at least 3 characters", 400);
    // Check uniqueness
    const existing = await auth.getAdminByUsername(username);
    if (existing && existing.admin_id !== adminId) return error("username already taken", 409);
    updates.username = username;
  }
  if (body.channels_access !== undefined) {
    if (!Array.isArray(body.channels_access)) return error("channels_access must be an array", 400);
    updates.channels_access = body.channels_access;
  }
  // Role: superadmin can only set admin role (cannot promote to superadmin or dev via this path)
  if (body.role !== undefined) {
    if (body.role !== "admin") return error("can only assign admin role via this endpoint", 400);
    updates.role = "admin";
  }

  const ok = await auth.updateAdminProfile(adminId, updates);
  if (!ok && Object.keys(updates).length > 0) return error("failed to update", 500);

  // Handle active toggle separately
  if (body.active !== undefined) {
    await auth.toggleAdminActive(adminId, Boolean(body.active));
  }

  const updated = await auth.getAdminById(adminId);
  return json({ user: updated ? auth.safeAdmin(updated) : null });
}

// DELETE /api/users/[adminId] — superadmin deletes an admin
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ adminId: string }> }
) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const { adminId } = await params;
  const target = await auth.getAdminById(adminId);
  if (!target) return error("user not found", 404);

  if (!canEditTarget(r.ctx.admin, target)) {
    return error("cannot delete this user", 403);
  }

  // Revoke all sessions before deletion
  await auth.revokeAllSessions(adminId);
  const ok = await auth.deleteAdmin(adminId);
  if (!ok) return error("failed to delete", 500);

  return json({ message: "user deleted" });
}
