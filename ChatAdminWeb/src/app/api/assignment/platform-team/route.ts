// GET  /api/assignment/platform-team — รายการ agent ที่ผูกกับ platform (all active rows)
// POST /api/assignment/platform-team — เพิ่ม agent เข้าทีม platform
//    body: { platform, admin_id }
// DELETE /api/assignment/platform-team — ลบ agent ออกจากทีม platform
//    body: { platform, admin_id }
// ⚠️ เฉพาะ role=admin เท่านั้นที่สามารถเข้าทีม platform ได้ — superadmin และ dev ไม่ถูกจ่ายแชท
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { assignmentService } from "@/backend/service/assignmentService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { auth } from "@/backend/service/authService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

const VALID_PLATFORMS = ["shopee", "tiktok", "lazada"];

export async function GET(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");

  const coll = await getCollection(COLLECTIONS.platformTeamAssignments);
  const filter = platform ? { platform, is_active: true } : { is_active: true };
  const rows = await coll.find(filter).toArray();
  return json({ rows });
}

export async function POST(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ platform?: string; admin_id?: string }>(req);
  if (!body?.platform || !body?.admin_id) return error("platform and admin_id are required");
  if (!VALID_PLATFORMS.includes(body.platform)) {
    return error(`platform must be one of: ${VALID_PLATFORMS.join(", ")}`);
  }

  // ตรวจสอบว่า target admin เป็น role=admin เท่านั้น
  const targetAdmin = await auth.getAdminById(body.admin_id);
  if (!targetAdmin) return error("admin not found", 404);
  if (targetAdmin.role !== "admin") {
    return error("ไม่สามารถเพิ่ม superadmin หรือ dev เข้าทีม platform ได้ — เฉพาะ admin เท่านั้น", 403);
  }

  await assignmentService.addAgentToPlatform(body.platform, body.admin_id);
  await logAdminEvent({
    action_type: "assignment.platform_team_add",
    actor: r.ctx.admin.admin_id,
    target_admin_id: body.admin_id,
    metadata: { platform: body.platform },
  });
  return json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ platform?: string; admin_id?: string }>(req);
  if (!body?.platform || !body?.admin_id) return error("platform and admin_id are required");

  await assignmentService.removeAgentFromPlatform(body.platform, body.admin_id);
  await logAdminEvent({
    action_type: "assignment.platform_team_remove",
    actor: r.ctx.admin.admin_id,
    target_admin_id: body.admin_id,
    metadata: { platform: body.platform },
  });
  return json({ ok: true });
}
