// Authorization helpers — server-side only.
// Used by Route Handlers to check the current user's role.
import { NextRequest, NextResponse } from "next/server";
import { auth } from "../service/authService";
import { getCookieFromRequest } from "../lib/cookies";
import type { AdminDoc } from "../service/authService";

export type Role = "superadmin" | "admin" | "dev";

export type AccessLevel = "none" | "read" | "edit";

/** Page keys — mirror of lib/roles.ts PageKey (server-side copy). */
export type PageKey =
  | "dashboard" | "analytics" | "ticket"
  | "trigger" | "workflow" | "quickreply" | "kb" | "persona" | "shop-setting"
  | "testchat" | "shadow-inbox" | "botworker" | "test-assignment"
  | "live-assignment"
  | "replay-compare" | "test-result" | "admin-review-kpi" | "admin-chat-result"
  | "test-chat-result"
  | "shop" | "customer" | "team" | "user"
  | "admin-config" | "config" | "log";

/**
 * Per-page, per-role permission map (server-side copy — must stay in sync with lib/roles.ts).
 * admin:       edit on operational, read on management/process, none on analytics/config
 * superadmin:  edit on most, read on bot-testing tools, none on log/config
 * dev:         edit on everything
 */
const PAGE_PERMISSIONS: Record<PageKey, Record<Role, AccessLevel>> = {
  dashboard:          { admin: "none", superadmin: "edit", dev: "edit" },
  analytics:          { admin: "none", superadmin: "edit", dev: "edit" },
  ticket:             { admin: "edit", superadmin: "edit", dev: "edit" },
  trigger:            { admin: "read", superadmin: "edit", dev: "edit" },
  workflow:           { admin: "read", superadmin: "edit", dev: "edit" },
  quickreply:         { admin: "edit", superadmin: "edit", dev: "edit" },
  kb:                 { admin: "read", superadmin: "edit", dev: "edit" },
  persona:            { admin: "read", superadmin: "edit", dev: "edit" },
  "shop-setting":     { admin: "read", superadmin: "edit", dev: "edit" },
  testchat:           { admin: "edit", superadmin: "edit", dev: "edit" },
  "shadow-inbox":     { admin: "edit", superadmin: "edit", dev: "edit" },
  botworker:          { admin: "read", superadmin: "read", dev: "edit" },
  "test-assignment":  { admin: "edit", superadmin: "edit", dev: "edit" },
  "live-assignment":  { admin: "edit", superadmin: "edit", dev: "edit" },
  "replay-compare":   { admin: "read", superadmin: "read", dev: "edit" },
  "test-result":      { admin: "read", superadmin: "read", dev: "edit" },
  "admin-review-kpi": { admin: "none", superadmin: "edit", dev: "edit" },
  "admin-chat-result": { admin: "none", superadmin: "none", dev: "edit" },
  "test-chat-result":  { admin: "none", superadmin: "none", dev: "edit" },
  shop:               { admin: "read", superadmin: "edit", dev: "edit" },
  customer:           { admin: "read", superadmin: "edit", dev: "edit" },
  team:               { admin: "read", superadmin: "edit", dev: "edit" },
  user:               { admin: "none", superadmin: "edit", dev: "edit" },
  "admin-config":     { admin: "read", superadmin: "edit", dev: "edit" },
  config:             { admin: "none", superadmin: "none", dev: "edit" },
  log:                { admin: "none", superadmin: "none", dev: "edit" },
};

// ⚡ G1 — extract client IP จาก request (สำหรับ audit log)
function clientIp(req: NextRequest): string | undefined {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return undefined;
}

export interface AuthContext {
  admin: AdminDoc;
  safeAdmin: ReturnType<typeof auth.safeAdmin>;
  ip?: string; // ⚡ G1 — client IP สำหรับ audit log
}

// Legacy hierarchy (still used by requireEditor/requireSuperadmin)
const ROLE_LEVEL: Record<Role, number> = {
  superadmin: 3,
  dev: 3,
  admin: 2,
};

function hasRole(role: Role, required: Role): boolean {
  return ROLE_LEVEL[role] >= ROLE_LEVEL[required];
}

/**
 * Resolve the current admin from the session cookie.
 * Returns null if not authenticated.
 */
export async function getCurrentAdmin(req: NextRequest): Promise<AdminDoc | null> {
  const token = getCookieFromRequest(req);
  if (!token) return null;
  const session = await auth.getSession(token);
  if (!session) return null;
  const admin = await auth.getAdminById(session.admin_id);
  if (!admin || !admin.active) return null;
  return admin;
}

/**
 * Require any authenticated user (any role).
 * Returns { ok: true, ctx } or { ok: false, response }.
 */
export async function requireAuth(req: NextRequest): Promise<
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: NextResponse }
> {
  const admin = await getCurrentAdmin(req);
  if (!admin) {
    return {
      ok: false,
      response: NextResponse.json({ detail: "unauthorized" }, { status: 401 }),
    };
  }
  return { ok: true, ctx: { admin, safeAdmin: auth.safeAdmin(admin), ip: clientIp(req) } };
}

/**
 * Require editor role (superadmin, dev, or admin).
 * dev ผ่านได้เพราะมี ROLE_LEVEL เท่า superadmin (3 >= 2).
 */
export async function requireEditor(req: NextRequest): Promise<
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireAuth(req);
  if (!r.ok) return r;
  if (!hasRole(r.ctx.admin.role, "admin")) {
    return {
      ok: false,
      response: NextResponse.json({ detail: "forbidden — editor access required" }, { status: 403 }),
    };
  }
  return r;
}

/**
 * Require superadmin or dev (both have full access).
 * admin users get 403.
 */
export async function requireSuperadmin(req: NextRequest): Promise<
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireAuth(req);
  if (!r.ok) return r;
  if (r.ctx.admin.role !== "superadmin" && r.ctx.admin.role !== "dev") {
    return {
      ok: false,
      response: NextResponse.json({ detail: "forbidden — superadmin or dev access required" }, { status: 403 }),
    };
  }
  return r;
}

/**
 * Require dev only — เฉพาะ dev เท่านั้น (superadmin/admin → 403)
 * ใช้สำหรับหน้าที่เป็น evaluation/shadow testing
 */
export async function requireDev(req: NextRequest): Promise<
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireAuth(req);
  if (!r.ok) return r;
  if (r.ctx.admin.role !== "dev") {
    return {
      ok: false,
      response: NextResponse.json({ detail: "forbidden — dev access required" }, { status: 403 }),
    };
  }
  return r;
}

/**
 * Check if a target admin can be edited by the current admin.
 * Rules:
 *   - superadmin and dev can edit admin only (not superadmin, not dev)
 *   - nobody can edit superadmin or dev via the user management UI
 *   - nobody can edit themselves via this path (use settings)
 */
export function canEditTarget(actor: AdminDoc, target: AdminDoc): boolean {
  if (actor.role !== "superadmin" && actor.role !== "dev") return false;
  if (target.role !== "admin") return false;
  if (actor.admin_id === target.admin_id) return false;
  return true;
}

/**
 * Check if actor can access/modify a conversation.
 * Rules:
 *   - superadmin and dev: full access to any conversation
 *   - admin: only conversations assigned to them
 *
 * Returns true if access is granted.
 */
export function canAccessConversation(
  actor: AdminDoc,
  assignedTo: string | null | undefined
): boolean {
  if (actor.role === "superadmin" || actor.role === "dev") return true;
  if (!assignedTo) return false; // unassigned → only superadmin/dev
  return assignedTo === actor.admin_id;
}

/* ------------------------------------------------------------------ */
/* Page-based guards (new permission system)                          */
/* ------------------------------------------------------------------ */

/** Check if a role can access a page (read or edit). */
export function roleCanAccess(role: Role, page: PageKey): boolean {
  return PAGE_PERMISSIONS[page][role] !== "none";
}

/** Check if a role can edit on a page. */
export function roleCanEdit(role: Role, page: PageKey): boolean {
  return PAGE_PERMISSIONS[page][role] === "edit";
}

/**
 * Require page access (read or edit).
 * Returns 403 if the user's role has "none" on this page.
 */
export async function requirePageAccess(req: NextRequest, page: PageKey): Promise<
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireAuth(req);
  if (!r.ok) return r;
  if (!roleCanAccess(r.ctx.admin.role, page)) {
    return {
      ok: false,
      response: NextResponse.json({ detail: `forbidden — no access to ${page}` }, { status: 403 }),
    };
  }
  return r;
}

/**
 * Require page edit permission.
 * Returns 403 if the user's role has "none" or "read" on this page.
 */
export async function requirePageEdit(req: NextRequest, page: PageKey): Promise<
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireAuth(req);
  if (!r.ok) return r;
  if (!roleCanEdit(r.ctx.admin.role, page)) {
    return {
      ok: false,
      response: NextResponse.json({ detail: `forbidden — edit access required for ${page}` }, { status: 403 }),
    };
  }
  return r;
}
