// Role-based UI helpers — shared across client components.
import type { AdminUser } from "./types";

export type Role = "superadmin" | "admin" | "dev";

const ROLE_LEVEL: Record<Role, number> = {
  superadmin: 3,
  admin: 2,
  dev: 1,
};

/** True if the user can edit content (superadmin or admin). dev is read-only. */
export function canEdit(user: AdminUser | null): boolean {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL.admin;
}

/** True if the user is superadmin. */
export function isSuperadmin(user: AdminUser | null): boolean {
  return user?.role === "superadmin";
}

/** True if the user can access user management (superadmin or dev). */
export function canViewUsers(user: AdminUser | null): boolean {
  if (!user) return false;
  return user.role === "superadmin" || user.role === "dev";
}

/** True if the user can manage users (superadmin only). */
export function canManageUsers(user: AdminUser | null): boolean {
  return user?.role === "superadmin";
}

/** True if the user can access test chat. */
export function canTestChat(user: AdminUser | null): boolean {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL.dev;
}
