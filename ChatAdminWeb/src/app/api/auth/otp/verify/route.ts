// POST /api/auth/otp/verify — verify an OTP code for the current admin
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson(req).catch(() => null);
  if (!body?.code) return error("code จำเป็นต้องกรอก", 400);

  const ok = await auth.verifySelfOtp(r.ctx.admin.admin_id, String(body.code).trim());
  if (!ok) return error("รหัส OTP ไม่ถูกต้องหรือหมดอายุแล้ว", 401);

  return json({ verified: true });
}
