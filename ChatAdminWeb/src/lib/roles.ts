// Role-based UI helpers — shared across client components.
import type { AdminUser } from "./types";

export type Role = "superadmin" | "admin" | "dev";

// Hierarchy: superadmin = dev (full access) > admin (read-only on team/config)
const ROLE_LEVEL: Record<Role, number> = {
  superadmin: 3,
  dev: 3,
  admin: 2,
};

/** True if the user can edit content (superadmin or dev). admin is read-only on team/config. */
export function canEdit(user: AdminUser | null): boolean {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL.admin;
}

/** True if the user has full access (superadmin or dev — equal permissions). */
export function canManage(user: AdminUser | null): boolean {
  if (!user) return false;
  return user.role === "superadmin" || user.role === "dev";
}

/** True if the user is superadmin or dev (used for team/config editing). */
export function isSuperadmin(user: AdminUser | null): boolean {
  return canManage(user);
}

/** True if the user can access user management (superadmin or dev). */
export function canViewUsers(user: AdminUser | null): boolean {
  return canManage(user);
}

/** True if the user can manage users (superadmin or dev — equal). */
export function canManageUsers(user: AdminUser | null): boolean {
  return canManage(user);
}

/** True if the user can access test chat. */
export function canTestChat(user: AdminUser | null): boolean {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL.dev;
}
