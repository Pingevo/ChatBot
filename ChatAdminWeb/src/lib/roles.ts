// Role-based permission system — shared across client components.
//
// Access levels: "none" (เข้าไม่ได้) / "read" (ดูได้อย่างเดียว) / "edit" (เต็ม)
//
// Source of truth:
//   - page registry  → lib/pages.ts (PAGES)
//   - matrix         → MongoDB system_configs.role_permissions (แก้ผ่านหน้า /roles — dev เท่านั้น)
//   - fallback       → DEFAULT_PERMISSIONS (ค่าเดิมก่อนมีระบบจัดการ — ใช้เมื่อ API ยังไม่ตอบ)
//
// Caller ทุกตัวใช้ canAccessPage/canEditPage เหมือนเดิม — แค่เปลี่ยนแหล่งข้อมูล
import type { AdminUser } from "./types";
import {
  DEFAULT_PERMISSIONS,
  ROLE_ADMIN_PAGE,
  resolveAccess,
  SUPER_ROLE,
  type AccessLevel,
} from "./pages";

export type Role = string;
export type { AccessLevel } from "./pages";
export type PageKey = string;

// matrix ที่ client ใช้ตอนนี้ — เริ่มจาก DEFAULT แล้วถูกแทนที่เมื่อ loadPermissions() สำเร็จ
let _matrix: Record<string, Record<string, AccessLevel>> = DEFAULT_PERMISSIONS;
let _loaded = false;

/**
 * โหลด matrix ล่าสุดจาก API — เรียกครั้งเดียวหลัง login (AppShell)
 * fail → คง DEFAULT_PERMISSIONS เดิม (พฤติกรรมเหมือนก่อนมีระบบนี้)
 */
export async function loadPermissions(): Promise<void> {
  try {
    const res = await fetch("/api/permissions", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      permissions?: Record<string, Record<string, AccessLevel>>;
    };
    if (data?.permissions && typeof data.permissions === "object") {
      _matrix = data.permissions;
      _loaded = true;
    }
  } catch {
    // ใช้ default เดิม
  }
}

/** True ถ้า matrix โหลดจาก API แล้ว (ยังไม่โหลด = ใช้ DEFAULT) */
export function permissionsLoaded(): boolean {
  return _loaded;
}

/** True if the user can see/access the page at all (read or edit). */
export function canAccessPage(user: AdminUser | null, page: PageKey): boolean {
  if (!user) return false;
  return resolveAccess(_matrix, page, user.role) !== "none";
}

/** True if the user can edit/modify content on the page. */
export function canEditPage(user: AdminUser | null, page: PageKey): boolean {
  if (!user) return false;
  return resolveAccess(_matrix, page, user.role) === "edit";
}

/** True if the user has read-only access (can see but not edit). */
export function isReadOnly(user: AdminUser | null, page: PageKey): boolean {
  if (!user) return false;
  return resolveAccess(_matrix, page, user.role) === "read";
}

/** /roles — hardcode dev-only เสมอ (matrix เขียนทับไม่ได้) */
export function canManageRoles(user: AdminUser | null): boolean {
  return !!user && user.role === SUPER_ROLE;
}
export { ROLE_ADMIN_PAGE, SUPER_ROLE };

/* ------------------------------------------------------------------ */
/* Backward-compatible helpers (deprecated — use canEditPage instead) */
/* ------------------------------------------------------------------ */

/**
 * True if the user can edit their own settings (all roles).
 * @deprecated use canEditPage(user, "ticket") etc. for page-specific checks
 */
export function canEdit(user: AdminUser | null): boolean {
  if (!user) return false;
  return true; // all authenticated users can edit their own settings
}

/**
 * True if the user is superadmin or dev.
 * @deprecated use canEditPage(user, "team") etc. for page-specific checks
 */
export function canManage(user: AdminUser | null): boolean {
  if (!user) return false;
  return user.role === "superadmin" || user.role === "dev";
}

/** @deprecated alias for canManage */
export function isSuperadmin(user: AdminUser | null): boolean {
  return canManage(user);
}

/** @deprecated use canAccessPage(user, "user") */
export function canViewUsers(user: AdminUser | null): boolean {
  return canAccessPage(user, "user");
}

/** @deprecated use canEditPage(user, "user") */
export function canManageUsers(user: AdminUser | null): boolean {
  return canEditPage(user, "user");
}

/** @deprecated use canAccessPage(user, "testchat") */
export function canTestChat(user: AdminUser | null): boolean {
  return canAccessPage(user, "testchat");
}
