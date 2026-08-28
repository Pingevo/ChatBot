// GET /api/shop-settings — list shop settings
// POST /api/shop-settings — upsert shop settings
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import {
  shopSettingsService,
  type FaqLiveagentAction,
} from "@/backend/service/shopSettingsService";
import type { PersonaPlatform } from "@/backend/service/personaService";

const VALID_PLATFORMS: PersonaPlatform[] = ["shopee", "tiktok", "lazada"];
const VALID_ACTIONS: FaqLiveagentAction[] = ["handoff", "bot_reply"];

function isValidPlatform(p: string | undefined | null): p is PersonaPlatform {
  return !!p && (VALID_PLATFORMS as string[]).includes(p);
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platformParam = url.searchParams.get("platform") || undefined;
  const search = url.searchParams.get("search") || undefined;

  if (platformParam && !isValidPlatform(platformParam)) {
    return error("platform must be one of: shopee, tiktok, lazada", 400);
  }

  const rows = await shopSettingsService.listShopSettings({
    platform: platformParam as PersonaPlatform | undefined,
    search: search || undefined,
  });

  return json({ rows });
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    shopname?: string;
    platform?: string;
    // batch mode
    shops?: string[];
    platforms?: string[];
    faq_liveagent_enabled?: boolean;
    faq_liveagent_action?: string;
    notes?: string;
  }>(req);

  // ── batch mode: shops[] + platforms[] ──
  if (body?.shops && body?.platforms) {
    if (!Array.isArray(body.shops) || body.shops.length === 0) {
      return error("shops must be a non-empty array", 400);
    }
    if (!Array.isArray(body.platforms) || body.platforms.length === 0) {
      return error("platforms must be a non-empty array", 400);
    }
    for (const p of body.platforms) {
      if (!isValidPlatform(p)) {
        return error(`invalid platform: ${p}`, 400);
      }
    }
    if (
      body.faq_liveagent_action &&
      !VALID_ACTIONS.includes(body.faq_liveagent_action as FaqLiveagentAction)
    ) {
      return error("faq_liveagent_action must be 'handoff' or 'bot_reply'", 400);
    }

    try {
      const docs = await shopSettingsService.upsertShopSettingsBatch({
        shops: body.shops.map((s) => s.trim()),
        platforms: body.platforms as PersonaPlatform[],
        faq_liveagent_enabled: body.faq_liveagent_enabled,
        faq_liveagent_action: body.faq_liveagent_action as FaqLiveagentAction | undefined,
        notes: body.notes,
        updatedBy: r.ctx.admin.admin_id,
      });
      return json({ created: docs.length, rows: docs }, 201);
    } catch (e) {
      return error(e instanceof Error ? e.message : "batch upsert failed", 500);
    }
  }

  // ── single mode (backward compat) ──
  if (!body?.shopname || !body?.platform) {
    return error("shopname, platform are required (or shops[] + platforms[] for batch)", 400);
  }
  if (!isValidPlatform(body.platform)) {
    return error("platform must be one of: shopee, tiktok, lazada", 400);
  }
  if (
    body.faq_liveagent_action &&
    !VALID_ACTIONS.includes(body.faq_liveagent_action as FaqLiveagentAction)
  ) {
    return error("faq_liveagent_action must be 'handoff' or 'bot_reply'", 400);
  }

  try {
    const doc = await shopSettingsService.upsertShopSettings({
      shopname: body.shopname.trim(),
      platform: body.platform,
      faq_liveagent_enabled: body.faq_liveagent_enabled,
      faq_liveagent_action: body.faq_liveagent_action as FaqLiveagentAction | undefined,
      notes: body.notes,
      updatedBy: r.ctx.admin.admin_id,
    });
    return json(doc, 201);
  } catch (e) {
    return error(e instanceof Error ? e.message : "upsert failed", 500);
  }
}
