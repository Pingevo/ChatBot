// DELETE /api/shop-settings/[id] — soft delete shop settings
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { shopSettingsService } from "@/backend/service/shopSettingsService";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { id } = await params;
  if (!id) return error("id is required", 400);

  const ok = await shopSettingsService.deleteShopSettings(
    id,
    r.ctx.admin.admin_id
  );
  if (!ok) return error("not found", 404);
  return json({ ok: true });
}
