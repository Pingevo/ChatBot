// Authorization helpers — server-side only.
// Used by Route Handlers to check the current user's role.
import { NextRequest, NextResponse } from "next/server";
import { auth } from "../service/authService";
import { getCookieFromRequest } from "../lib/cookies";
import type { AdminDoc } from "../service/authService";

export type Role = "superadmin" | "admin" | "dev";

export interface AuthContext {
  admin: AdminDoc;
  safeAdmin: ReturnType<typeof auth.safeAdmin>;
}

// Hierarchy: superadmin > admin > dev
const ROLE_LEVEL: Record<Role, number> = {
  superadmin: 3,
  admin: 2,
  dev: 1,
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
  return { ok: true, ctx: { admin, safeAdmin: auth.safeAdmin(admin) } };
}

/**
 * Require editor role (superadmin or admin).
 * dev users get 403.
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
 * Require superadmin only.
 */
export async function requireSuperadmin(req: NextRequest): Promise<
  | { ok: true; ctx: AuthContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireAuth(req);
  if (!r.ok) return r;
  if (r.ctx.admin.role !== "superadmin") {
    return {
      ok: false,
      response: NextResponse.json({ detail: "forbidden — superadmin access required" }, { status: 403 }),
    };
  }
  return r;
}

/**
 * Check if a target admin can be edited by the current admin.
 * Rules:
 *   - superadmin can edit admin only (not superadmin, not dev)
 *   - nobody can edit superadmin or dev via the user management UI
 *   - nobody can edit themselves via this path (use settings)
 */
export function canEditTarget(actor: AdminDoc, target: AdminDoc): boolean {
  if (actor.role !== "superadmin") return false;
  if (target.role !== "admin") return false;
  if (actor.admin_id === target.admin_id) return false;
  return true;
}
