// Authorization helpers — server-side only.
// Used by Route Handlers to check the current user's role.
import { NextRequest, NextResponse } from "next/server";
import { auth } from "../service/authService";
import { getCookieFromRequest } from "../lib/cookies";
import type { AdminDoc } from "../service/authService";

// Role เป็น string — เพิ่ม/ลบ role ได้ผ่านหน้า /roles (matrix ใน system_configs.role_permissions)
export type Role = string;

export type { AccessLevel } from "@/lib/pages";
import { resolveAccess, type AccessLevel as _AL } from "@/lib/pages";
import { getRolePermissions } from "../service/rolePermissionService";

// Page keys — source of truth คือ PAGES registry ใน lib/pages.ts
// (matrix เดิมที่เคย hardcode ตรงนี้ย้ายไป DEFAULT_PERMISSIONS ใน lib/pages.ts แล้ว
//  ใช้เป็น seed/fallback เมื่อยังไม่มี doc role_permissions ใน system_configs)
export type PageKey = string;

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
// role ใหม่ที่เพิ่มผ่าน /roles ไม่มีใน map นี้ → hasRole = false (deny ปลอดภัย)
const ROLE_LEVEL: Record<string, number> = {
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

// ---- dynamic permission matrix (DB) ----
// cache 30s — แก้ใน /roles แล้วมีผลเกือบทันที โดยไม่ต้อง redeploy
let _permCache: { matrix: Record<string, Record<string, _AL>>; ts: number } | null = null;
const _PERM_TTL = 30_000;

async function _permMatrix(): Promise<Record<string, Record<string, _AL>>> {
  const now = Date.now();
  if (_permCache && now - _permCache.ts < _PERM_TTL) return _permCache.matrix;
  try {
    const doc = await getRolePermissions();
    _permCache = { matrix: doc.permissions, ts: now };
  } catch {
    // DB ล่ม → ใช้ cache เดิม หรือ matrix ว่าง (resolveAccess จะ deny ยกเว้น dev)
    if (!_permCache) _permCache = { matrix: {}, ts: now };
  }
  return _permCache.matrix;
}

/** Check if a role can access a page (read or edit). */
export async function roleCanAccess(role: Role, page: PageKey): Promise<boolean> {
  const m = await _permMatrix();
  return resolveAccess(m, page, role) !== "none";
}

/** Check if a role can edit on a page. */
export async function roleCanEdit(role: Role, page: PageKey): Promise<boolean> {
  const m = await _permMatrix();
  return resolveAccess(m, page, role) === "edit";
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
  if (!(await roleCanAccess(r.ctx.admin.role, page))) {
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
  if (!(await roleCanEdit(r.ctx.admin.role, page))) {
    return {
      ok: false,
      response: NextResponse.json({ detail: `forbidden — edit access required for ${page}` }, { status: 403 }),
    };
  }
  return r;
}
