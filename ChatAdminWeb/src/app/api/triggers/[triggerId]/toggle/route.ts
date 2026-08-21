// POST /api/triggers/[triggerId]/toggle — enable/disable trigger
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { triggerService } from "@/backend/service/triggerService";
import { logAdminEvent } from "@/backend/service/adminLogService";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { triggerId } = await params;

  const body = await readJson<{ enabled?: boolean }>(req);
  if (!body || typeof body.enabled !== "boolean") {
    return error("enabled (boolean) is required", 422);
  }

  const ok = await triggerService.toggleTrigger(triggerId, body.enabled, r.ctx.admin.admin_id);
  if (!ok) return error("trigger not found", 404);

  await logAdminEvent({
    action_type: "trigger.toggle",
    actor: r.ctx.admin.admin_id,
    metadata: { trigger_id: triggerId, enabled: body.enabled },
  });

  return json({ ok: true, enabled: body.enabled });
}
