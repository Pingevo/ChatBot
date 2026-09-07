// PATCH /api/profile — update own profile (name, channels_access)
// POST  /api/profile/password — change own password (requires OTP verification)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { auth } from "@/backend/service/authService";

export async function PATCH(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ name?: string; channels_access?: string[]; bubble_color?: string }>(req).catch(() => null);
  if (!body) return error("invalid body", 400);

  const updates: { name?: string; channels_access?: string[]; bubble_color?: string } = {};
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  if (Array.isArray(body.channels_access)) updates.channels_access = body.channels_access;
  // ⚡ สี bubble — validate เป็น hex 7 ตัว (#RRGGBB)
  if (typeof body.bubble_color === "string") {
    const hex = body.bubble_color.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      updates.bubble_color = hex;
    } else if (hex === "") {
      updates.bubble_color = ""; // เคลียร์กลับเป็น default
    }
  }

  if (Object.keys(updates).length === 0) return error("no fields to update", 400);

  const ok = await auth.updateAdminProfile(r.ctx.admin.admin_id, updates);
  if (!ok) return error("update failed", 500);
  return json({ ok: true });
}
