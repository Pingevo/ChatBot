// GET /api/persona — list personas (all admins can see — เป็น config ระดับร้าน)
// POST /api/persona — upsert persona (create หรือ overwrite ถ้ามีแล้ว)
//
// Query params:
//   ?platform=shopee|tiktok|lazada
//   ?search=<text>            — search ใน shopname/bot_name
//   ?enabled_only=1
//
// Body (POST):
//   { shopname, platform, bot_name, enabled?, notes? }
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { personaService, type PersonaPlatform } from "@/backend/service/personaService";

const VALID_PLATFORMS: PersonaPlatform[] = ["shopee", "tiktok", "lazada"];

function isValidPlatform(p: string | undefined | null): p is PersonaPlatform {
  return !!p && (VALID_PLATFORMS as string[]).includes(p);
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platformParam = url.searchParams.get("platform") || undefined;
  const search = url.searchParams.get("search") || undefined;
  const enabledOnly = url.searchParams.get("enabled_only") === "1";

  // validate platform ถ้าส่งมา
  if (platformParam && !isValidPlatform(platformParam)) {
    return error("platform must be one of: shopee, tiktok, lazada", 400);
  }

  const rows = await personaService.listPersonas({
    platform: platformParam as PersonaPlatform | undefined,
    search: search || undefined,
    enabledOnly,
  });

  return json({ rows });
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    shopname?: string;
    platform?: string;
    bot_name?: string;
    enabled?: boolean;
    notes?: string;
  }>(req);

  if (!body?.shopname || !body?.platform || !body?.bot_name) {
    return error("shopname, platform, bot_name are required", 400);
  }
  if (!isValidPlatform(body.platform)) {
    return error("platform must be one of: shopee, tiktok, lazada", 400);
  }
  if (!body.bot_name.trim()) {
    return error("bot_name ต้องไม่ว่าง", 400);
  }

  try {
    const doc = await personaService.upsertPersona({
      shopname: body.shopname.trim(),
      platform: body.platform,
      botName: body.bot_name,
      enabled: body.enabled,
      notes: body.notes,
      updatedBy: r.ctx.admin.admin_id,
    });
    return json(doc, 201);
  } catch (e) {
    return error(e instanceof Error ? e.message : "upsert failed", 500);
  }
}
