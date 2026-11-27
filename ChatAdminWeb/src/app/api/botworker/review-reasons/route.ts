import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { error, json, readJson } from "@/backend/lib/http";
import { logAdminEvent } from "@/backend/service/adminLogService";
import { systemConfigService } from "@/backend/service/systemConfigService";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const access = await requirePageAccess(req, "botworker");
  if (!access.ok) return access.response;
  return json({ categories: await systemConfigService.getBotWorkerEditReasonCategories() });
}

export async function POST(req: NextRequest) {
  const access = await requirePageAccess(req, "botworker");
  if (!access.ok) return access.response;

  const body = await readJson<{ category?: unknown }>(req);
  if (!body) return error("invalid body", 422);

  const result = await systemConfigService.addBotWorkerEditReasonCategory(
    body.category,
    access.ctx.admin.admin_id
  );
  if (!result.ok) return error(result.message, 422);

  if (result.added) {
    await logAdminEvent({
      action_type: "botworker.review_reason_category.add",
      actor: access.ctx.admin.admin_id,
      metadata: { category: result.category },
      ip: access.ctx.ip,
    });
  }
  return json({ ok: true, category: result.category, categories: result.categories });
}
