// GET /api/users — list all admins (superadmin & dev: full, admin: 403)
import { NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { requirePageAccess, roleCanEdit } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";

export async function GET(req: NextRequest) {
  const r = await requirePageAccess(req, "user");
  if (!r.ok) return r.response;
  const users = await auth.listAdmins();
  // superadmin และ dev มีสิทธิ์เท่ากัน — แก้ไขได้ทั้งคู่
  return json({ users, canEdit: roleCanEdit(r.ctx.admin.role, "user") });
}
