// GET    /api/triggers/[triggerId] — get one trigger
// PATCH  /api/triggers/[triggerId] — update trigger
// POST   /api/triggers/[triggerId]/toggle — enable/disable
// DELETE /api/triggers/[triggerId] — soft delete
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { triggerService } from "@/backend/service/triggerService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import type { Platform } from "@/backend/service/conversationService";
import type { TriggerAction } from "@/backend/service/triggerService";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { triggerId } = await params;
  const trigger = await triggerService.getTrigger(triggerId);
  if (!trigger) return error("trigger not found", 404);
  return json({ trigger });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { triggerId } = await params;

  const body = await readJson<{
    name?: string;
    keywords?: string[];
    shop_ids?: string[];
    platforms?: Platform[];
    topic?: string;
    action?: TriggerAction;
    bot_template?: string;
    enabled?: boolean;
  }>(req);

  if (!body) return error("invalid body", 400);

  // ถ้ามี action ต้องเป็นค่าที่ถูกต้อง
  if (body.action && !["bot_answer", "handoff_admin"].includes(body.action)) {
    return error("action must be bot_answer or handoff_admin", 422);
  }

  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) fields.name = body.name;
  if (body.keywords !== undefined) fields.keywords = body.keywords;
  if (body.shop_ids !== undefined) fields.shop_ids = body.shop_ids;
  if (body.platforms !== undefined) fields.platforms = body.platforms;
  if (body.topic !== undefined) fields.topic = body.topic;
  if (body.action !== undefined) fields.action = body.action;
  if (body.bot_template !== undefined) fields.bot_template = body.bot_template;
  if (body.enabled !== undefined) fields.enabled = body.enabled;

  const ok = await triggerService.updateTrigger(triggerId, fields as never, r.ctx.admin.admin_id);
  if (!ok) return error("trigger not found or no changes", 404);

  await logAdminEvent({
    action_type: "trigger.update",
    actor: r.ctx.admin.admin_id,
    metadata: { trigger_id: triggerId, fields: Object.keys(fields) },
  });

  return json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ triggerId: string }> }
) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;
  const { triggerId } = await params;

  const ok = await triggerService.deleteTrigger(triggerId, r.ctx.admin.admin_id);
  if (!ok) return error("trigger not found", 404);

  await logAdminEvent({
    action_type: "trigger.delete",
    actor: r.ctx.admin.admin_id,
    metadata: { trigger_id: triggerId },
  });

  return json({ ok: true });
}
