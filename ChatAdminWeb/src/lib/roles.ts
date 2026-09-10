// Role-based permission system — shared across client components.
//
// 3 roles: superadmin, admin, dev
// Permission model: page-based (each page has per-role access level)
//
// Access levels:
//   "none"  — cannot see or access the page
//   "read"  — can view the page but cannot modify (read-only)
//   "edit"  — full access (view + modify)
//
// Permission matrix:
//   admin:       edit on ticket/quickreply/testchat/shadow-inbox/test-assignment
//                read on team/trigger/workflow/kb/persona/shop-setting/shop/customer/admin-config/botworker/test-result/replay-compare
//                none on dashboard/analytics/admin-review-kpi/user/log/config
//   superadmin:  edit on everything admin can edit + team/trigger/workflow/kb/persona/shop-setting/shop/customer/admin-config/dashboard/analytics/admin-review-kpi/user
//                read on botworker/test-result/replay-compare
//                none on log/config
//   dev:         edit on everything
import type { AdminUser } from "./types";

export type Role = "superadmin" | "admin" | "dev";

export type AccessLevel = "none" | "read" | "edit";

/** Page keys — one per page/feature in the admin console. */
export type PageKey =
  // main
  | "dashboard"
  | "analytics"
  | "ticket"
  // process
  | "trigger"
  | "workflow"
  | "quickreply"
  | "kb"
  | "persona"
  | "shop-setting"
  // bot-testing
  | "testchat"
  | "shadow-inbox"
  | "botworker"
  | "test-assignment"
  | "live-assignment"
  | "replay-compare"
  | "test-result"
  | "admin-review-kpi"
  | "admin-chat-result"
  | "test-chat-result"
  // management
  | "shop"
  | "customer"
  | "team"
  | "user"
  // config
  | "admin-config"
  | "config"
  | "log";

/**
 * Per-page, per-role permission map.
 * admin: edit on operational pages, read-only on management/process, none on analytics/config
 * superadmin: edit on most, read-only on bot-testing tools, none on log/config (dev-only)
 * dev: edit on everything
 */
const PAGE_PERMISSIONS: Record<PageKey, Record<Role, AccessLevel>> = {
  // ---- main ----
  dashboard:          { admin: "none", superadmin: "edit", dev: "edit" },
  analytics:          { admin: "none", superadmin: "edit", dev: "edit" },
  ticket:             { admin: "edit", superadmin: "edit", dev: "edit" },
  // ---- process ----
  trigger:            { admin: "read", superadmin: "edit", dev: "edit" },
  workflow:           { admin: "read", superadmin: "edit", dev: "edit" },
  quickreply:         { admin: "edit", superadmin: "edit", dev: "edit" },
  kb:                 { admin: "read", superadmin: "edit", dev: "edit" },
  persona:            { admin: "read", superadmin: "edit", dev: "edit" },
  "shop-setting":     { admin: "read", superadmin: "edit", dev: "edit" },
  // ---- bot-testing ----
  testchat:           { admin: "edit", superadmin: "edit", dev: "edit" },
  "shadow-inbox":     { admin: "edit", superadmin: "edit", dev: "edit" },
  botworker:          { admin: "read", superadmin: "read", dev: "edit" },
  "test-assignment":  { admin: "edit", superadmin: "edit", dev: "edit" },
  "live-assignment":  { admin: "edit", superadmin: "edit", dev: "edit" },
  "replay-compare":   { admin: "read", superadmin: "read", dev: "edit" },
  "test-result":      { admin: "read", superadmin: "read", dev: "edit" },
  "admin-review-kpi": { admin: "none", superadmin: "edit", dev: "edit" },
  "admin-chat-result": { admin: "none", superadmin: "none", dev: "edit" },
  "test-chat-result": { admin: "none", superadmin: "none", dev: "edit" },
  // ---- management ----
  shop:               { admin: "read", superadmin: "edit", dev: "edit" },
  customer:           { admin: "read", superadmin: "edit", dev: "edit" },
  team:               { admin: "read", superadmin: "edit", dev: "edit" },
  user:               { admin: "none", superadmin: "edit", dev: "edit" },
  // ---- config ----
  "admin-config":     { admin: "read", superadmin: "edit", dev: "edit" },
  config:             { admin: "none", superadmin: "none", dev: "edit" },
  log:                { admin: "none", superadmin: "none", dev: "edit" },
};

/** True if the user can see/access the page at all (read or edit). */
export function canAccessPage(user: AdminUser | null, page: PageKey): boolean {
  if (!user) return false;
  return PAGE_PERMISSIONS[page][user.role] !== "none";
}

/** True if the user can edit/modify content on the page. */
export function canEditPage(user: AdminUser | null, page: PageKey): boolean {
  if (!user) return false;
  return PAGE_PERMISSIONS[page][user.role] === "edit";
}

/** True if the user has read-only access (can see but not edit). */
export function isReadOnly(user: AdminUser | null, page: PageKey): boolean {
  if (!user) return false;
  return PAGE_PERMISSIONS[page][user.role] === "read";
}

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
