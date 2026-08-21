// GET /api/users — list all admins (superadmin & dev: full, admin: 403)
import { NextRequest } from "next/server";
import { auth } from "@/backend/service/authService";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  // admin role cannot see user management
  if (r.ctx.admin.role === "admin") {
    return error("forbidden — user management is not available for your role", 403);
  }
  const users = await auth.listAdmins();
  // superadmin และ dev มีสิทธิ์เท่ากัน — แก้ไขได้ทั้งคู่
  return json({ users, canEdit: r.ctx.admin.role === "superadmin" || r.ctx.admin.role === "dev" });
}
