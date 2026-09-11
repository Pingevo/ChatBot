// DELETE /api/shop-settings/[id] — soft delete shop settings
// 🔒 H4: Changed from requireAuth → requirePageEdit to enforce role-based access
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { shopSettingsService } from "@/backend/service/shopSettingsService";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 🔒 H4: Only superadmin/dev can delete (admin has read-only on shop-setting)
  const r = await requirePageEdit(req, "shop-setting");
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
