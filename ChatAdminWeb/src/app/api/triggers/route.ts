// GET  /api/triggers — list triggers (multi-platform/shop aware)
// POST /api/triggers — create new trigger
//
// Phase 7.10 — trigger ใช้งานจริง ไม่ใช่ mockup
// รองรับ multi-platform (platforms[]) + multi-shop (shop_ids[]) + select all ([] = ทั้งหมด)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { triggerService } from "@/backend/service/triggerService";
import { logAdminEvent } from "@/backend/service/adminLogService";
import type { Platform } from "@/backend/service/conversationService";
import type { TriggerAction } from "@/backend/service/triggerService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const shopId = url.searchParams.get("shop_id") || undefined;
  const platform = (url.searchParams.get("platform") as Platform | null) || undefined;
  const enabledOnly = url.searchParams.get("enabled_only") === "true";

  const triggers = await triggerService.listTriggers({ shopId, platform, enabledOnly });
  return json({ rows: triggers, total: triggers.length });
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

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

  if (!body || !body.name || !body.name.trim()) return error("name is required", 422);
  if (!body.keywords || !Array.isArray(body.keywords) || body.keywords.length === 0) {
    return error("keywords (string[]) is required", 422);
  }
  if (!body.action || !["bot_answer", "handoff_admin"].includes(body.action)) {
    return error("action must be bot_answer or handoff_admin", 422);
  }

  const doc = await triggerService.createTrigger({
    name: body.name.trim(),
    keywords: body.keywords,
    shopIds: body.shop_ids || [],
    platforms: body.platforms || [],
    topic: body.topic,
    action: body.action,
    botTemplate: body.bot_template,
    enabled: body.enabled ?? true,
    createdBy: r.ctx.admin.admin_id,
  });

  await logAdminEvent({
    action_type: "trigger.create",
    actor: r.ctx.admin.admin_id,
    metadata: { trigger_id: doc.trigger_id, name: doc.name, action: doc.action },
  });

  return json({ trigger: doc });
}
