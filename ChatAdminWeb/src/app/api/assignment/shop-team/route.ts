// GET  /api/assignment/shop-team — รายการ agent ที่ผูกกับร้าน (all active rows)
// POST /api/assignment/shop-team — เพิ่ม agent เข้าทีมร้าน
//    body: { shop_id, admin_id, role_on_shop? }
// DELETE /api/assignment/shop-team — ลบ agent ออกจากทีมร้าน
//    body: { shop_id, admin_id }
// ⚠️ เฉพาะ role=admin เท่านั้นที่สามารถเข้าทีมร้านได้ — superadmin และ dev ไม่ถูกจ่ายแชท
import { NextRequest } from "next/server";
import { requireEditor } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { assignmentService } from "@/backend/service/assignmentService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { auth } from "@/backend/service/authService";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";

export async function GET(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const shopId = url.searchParams.get("shop_id");

  const coll = await getCollection(COLLECTIONS.shopTeamAssignments);
  const filter = shopId ? { shop_id: shopId, is_active: true } : { is_active: true };
  const rows = await coll.find(filter).toArray();
  return json({ rows });
}

export async function POST(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ shop_id?: string; admin_id?: string; role_on_shop?: string }>(req);
  if (!body?.shop_id || !body?.admin_id) return error("shop_id and admin_id are required");

  // ตรวจสอบว่า target admin เป็น role=admin เท่านั้น
  const targetAdmin = await auth.getAdminById(body.admin_id);
  if (!targetAdmin) return error("admin not found", 404);
  if (targetAdmin.role !== "admin") {
    return error("ไม่สามารถเพิ่ม superadmin หรือ dev เข้าทีมร้านได้ — เฉพาะ admin เท่านั้น", 403);
  }

  await assignmentService.addAgentToShop(body.shop_id, body.admin_id, body.role_on_shop);
  await logAdminEvent({
    action_type: "assignment.shop_team_add",
    actor: r.ctx.admin.admin_id,
    target_admin_id: body.admin_id,
    shop_id: body.shop_id,
    metadata: { role_on_shop: body.role_on_shop },
  });
  return json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const r = await requireEditor(req);
  if (!r.ok) return r.response;

  const body = await readJson<{ shop_id?: string; admin_id?: string }>(req);
  if (!body?.shop_id || !body?.admin_id) return error("shop_id and admin_id are required");

  await assignmentService.removeAgentFromShop(body.shop_id, body.admin_id);
  await logAdminEvent({
    action_type: "assignment.shop_team_remove",
    actor: r.ctx.admin.admin_id,
    target_admin_id: body.admin_id,
    shop_id: body.shop_id,
  });
  return json({ ok: true });
}
