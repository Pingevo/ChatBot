// PATCH /api/shops/[id] — update shop (toggle connected)
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { shopService } from "@/backend/service/shopService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const r = await requirePageEdit(req, "shop");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await readJson<{ connected?: boolean }>(req).catch(() => null);
  if (!body || typeof body.connected !== "boolean") {
    return error("connected (boolean) is required", 400);
  }
  const ok = await shopService.setShopConnected(id, body.connected);
  if (!ok) return error("shop not found", 404);
  // ⚡ G1 — log shop connected toggle
  await logAdminEvent({
    action_type: "config.shop_toggle",
    actor: r.ctx.admin.admin_id,
    shop_id: id,
    metadata: { field: "connected", value: body.connected },
    ip: r.ctx.ip,
  });
  return json({ ok: true });
}
