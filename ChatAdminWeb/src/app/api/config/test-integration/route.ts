// POST /api/config/test-integration — ทดสอบการเชื่อมต่อ MongoDB (read-only)
// ⚠️ ไม่ยิง HTTP ไป Shopee — ตัดออกจาก PDigg testShopeeIntegration()
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { systemConfigService } from "@/backend/service/systemConfigService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const results = await systemConfigService.testIntegration();
  const allOk = (Object.values(results) as { ok?: boolean }[]).every((x) => x.ok);
  await logAdminEvent({
    action_type: "config.test_integration",
    actor: r.ctx.admin.admin_id,
    metadata: { success: allOk },
  });
  return json({ ok: true, results });
}
