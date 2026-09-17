// GET /api/users — list all admins (superadmin & dev: full, admin: 403)
import { NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { requirePageAccess, roleCanEdit } from "@/backend/middleware/authorize";
import { getRolePermissions } from "@/backend/service/rolePermissionService";
import { json } from "@/backend/lib/http";

export async function GET(req: NextRequest) {
  const r = await requirePageAccess(req, "user");
  if (!r.ok) return r.response;
  const users = await auth.listAdmins();
  // role options สำหรับ dropdown assign — server filter ตาม canAssignRole อีกชั้นตอน PATCH
  let roles: { key: string; label: string }[] = [];
  try {
    roles = (await getRolePermissions()).roles.map((x) => ({ key: x.key, label: x.label }));
  } catch { /* ใช้ list ว่าง — UI จะ fallback builtin */ }
  return json({ users, roles, canEdit: await roleCanEdit(r.ctx.admin.role, "user") });
}
