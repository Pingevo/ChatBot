// PATCH /api/config/shop/:shopId — เปิด/ปิด background sync เฉพาะร้าน
// adapted from ChatBotPDigg routes/config.js: PATCH /api/config/shopee/shop/:shop_id/toggle
//
// enabled_for_chat = true → background sync ดึงข้อความจากร้านนี้
// enabled_for_chat = false → ข้ามร้านนี้ (ไม่ดึงข้อความ)
//
// ⚠️ ไม่ยิง Shopee API — แค่ตั้งค่าใน MongoDB ของเรา
import { NextRequest } from "next/server";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { shopService } from "@/backend/service/shopService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  const r = await requireSuperadmin(req); // superadmin or dev only
  if (!r.ok) return r.response;

  const { shopId } = await params;
  const body = await readJson<{ enabled_for_chat?: boolean }>(req);
  if (!body || typeof body.enabled_for_chat !== "boolean") {
    return error("enabled_for_chat must be boolean");
  }

  const shop = await shopService.toggleShopChatSync(shopId, body.enabled_for_chat);
  if (!shop) return error("shop_not_found", 404);

  await logAdminEvent({
    action_type: "config.shop_toggle",
    actor: r.ctx.admin.admin_id,
    shop_id: shopId,
    metadata: { shopname: shop.shopname, enabled_for_chat: body.enabled_for_chat },
  });

  return json({
    ok: true,
    shop,
    message: `อัปเดตสถานะร้าน ${shop.shopname || shopId} เรียบร้อยแล้ว`,
  });
}
