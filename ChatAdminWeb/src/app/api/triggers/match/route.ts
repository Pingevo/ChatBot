// POST /api/triggers/match — check trigger สำหรับ Test Chat
// รับ { message, shop_id, platform } → คืน { matched: boolean, trigger?: {...} }
// ใช้สำหรับ Test Chat ก่อนส่งข้อความให้ bot
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { triggerService } from "@/backend/service/triggerService";
import type { Platform } from "@/backend/service/conversationService";

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  try {
    const body = await readJson(req);
    const message: string = String(body?.message || "");
    const shopId: string | undefined = body?.shop_id ? String(body.shop_id) : undefined;
    const platform: Platform | undefined = body?.platform as Platform | undefined;

    if (!message.trim()) {
      return error("message is required");
    }

    const trigger = await triggerService.matchTrigger(message, { shopId, platform });

    if (!trigger) {
      return json({ matched: false });
    }

    return json({
      matched: true,
      trigger: {
        trigger_id: trigger.trigger_id,
        name: trigger.name,
        action: trigger.action,
        bot_template: trigger.bot_template,
        topic: trigger.topic,
        keywords: trigger.keywords,
      },
    });
  } catch (e) {
    return error(e instanceof Error ? e.message : "internal error", 500);
  }
}
