// GET  /api/permissions — matrix สำหรับ client gating (ทุก role ที่ login แล้วอ่านได้)
// PUT  /api/permissions — แก้ roles/matrix (dev only — page "role-admin" hardcode ใน matrix)
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requirePageEdit } from "@/backend/middleware/authorize";
import {
  getRolePermissions,
  updateRolePermissions,
} from "@/backend/service/rolePermissionService";
import { PAGES, ROLE_ADMIN_PAGE, type AccessLevel } from "@/lib/pages";

function error(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  try {
    const doc = await getRolePermissions();
    return NextResponse.json({
      ok: true,
      pages: PAGES,
      roles: doc.roles,
      permissions: doc.permissions,
      role_admin_page: ROLE_ADMIN_PAGE,
    });
  } catch {
    // DB ล่ม → client จะ fallback DEFAULT_PERMISSIONS เอง
    return error("load failed", 500);
  }
}

export async function PUT(req: NextRequest) {
  const r = await requirePageEdit(req, ROLE_ADMIN_PAGE); // dev only (hardcoded)
  if (!r.ok) return r.response;
  let body: {
    roles?: { key: string; label: string; builtin?: boolean }[];
    permissions?: Record<string, Record<string, AccessLevel>>;
  };
  try {
    body = await req.json();
  } catch {
    return error("invalid body");
  }
  const out = await updateRolePermissions(
    { roles: body.roles, permissions: body.permissions },
    r.ctx.admin.username || r.ctx.admin.email || "dev"
  );
  if (out.error) return error(out.error);
  return NextResponse.json({ ok: true });
}
