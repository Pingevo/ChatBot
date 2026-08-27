// PATCH /api/users/[adminId] — superadmin/dev updates an admin's profile (name, username, active)
// DELETE /api/users/[adminId] — soft delete (superadmin/dev only, admin target only)
// ⚠️ ไม่มีการเปลี่ยน role ผ่าน API แล้ว — แก้ role ใน collection ตรงๆ
// ⚠️ active toggle ทำได้ทุก role (รวม superadmin/dev) เพื่อให้ปิดบัญชีตัวเอง/กันได้
import { NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { requireSuperadmin, canEditTarget } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { logAdminEvent } from "@/backend/service/adminLogService";

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

  // Profile edits (name, username, channels_access) — only for admin role targets
  const updates: { name?: string; username?: string; channels_access?: string[] } = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name) updates.name = name;
  }
  if (body.username !== undefined) {
    const username = String(body.username).trim();
    if (username.length < 3) return error("username must be at least 3 characters", 400);
    const existing = await auth.getAdminByUsername(username);
    if (existing && existing.admin_id !== adminId) return error("username already taken", 409);
    updates.username = username;
  }
  if (body.channels_access !== undefined) {
    if (!Array.isArray(body.channels_access)) return error("channels_access must be an array", 400);
    updates.channels_access = body.channels_access;
  }

  // Profile updates only allowed for admin targets (not superadmin/dev)
  if (Object.keys(updates).length > 0) {
    if (!canEditTarget(r.ctx.admin, target)) {
      return error("cannot edit profile of this user", 403);
    }
    const ok = await auth.updateAdminProfile(adminId, updates);
    if (!ok) return error("failed to update", 500);
    await logAdminEvent({
      action_type: "user.update",
      actor: r.ctx.admin.admin_id,
      target_admin_id: adminId,
      metadata: { changes: updates },
    });
  }

  // Active toggle — allowed for ANY role target (including superadmin/dev)
  // แต่ห้าม toggle ตัวเอง
  if (body.active !== undefined) {
    if (r.ctx.admin.admin_id === adminId) {
      return error("cannot toggle your own account", 400);
    }
    await auth.toggleAdminActive(adminId, Boolean(body.active));
    await logAdminEvent({
      action_type: "user.toggle_active",
      actor: r.ctx.admin.admin_id,
      target_admin_id: adminId,
      metadata: { active: Boolean(body.active), target_role: target.role },
    });
  }

  const updated = await auth.getAdminById(adminId);
  return json({ user: updated ? auth.safeAdmin(updated) : null });
}

// DELETE /api/users/[adminId] — soft delete (superadmin/dev only, admin target only)
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
    return error("cannot delete this user — only admin role can be deleted", 403);
  }

  // Revoke all sessions before deletion
  await auth.revokeAllSessions(adminId);
  const ok = await auth.deleteAdmin(adminId, r.ctx.admin.admin_id);
  if (!ok) return error("failed to delete", 500);

  await logAdminEvent({
    action_type: "user.delete",
    actor: r.ctx.admin.admin_id,
    target_admin_id: adminId,
    metadata: { email: target.email, username: target.username },
  });

  return json({ message: "user deleted" });
}
