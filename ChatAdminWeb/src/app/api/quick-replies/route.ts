// GET /api/quick-replies — list quick replies for current admin (ของใครของมัน)
// POST /api/quick-replies — create a new quick reply for current admin
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { quickReplyService } from "@/backend/service/quickReplyService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") || undefined;
  const shopId = url.searchParams.get("shop_id") || undefined;
  const category = url.searchParams.get("category") || undefined;
  const enabledOnly = url.searchParams.get("enabled_only") === "1";

  // แต่ละ admin เห็น quick replies ของตัวเองเท่านั้น
  const rows = await quickReplyService.listQuickReplies({
    adminId: r.ctx.admin.admin_id,
    platform: platform || undefined,
    shopId: shopId || undefined,
    category: category || undefined,
    enabledOnly,
  });

  return json({ rows });
}

export async function POST(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    category?: string;
    title?: string;
    body?: string;
    platforms?: string[];
    shop_ids?: string[];
    sort_order?: number;
  }>(req);

  if (!body?.title || !body?.body) return error("title and body are required", 400);

  const doc = await quickReplyService.createQuickReply({
    adminId: r.ctx.admin.admin_id,
    platforms: body.platforms ?? [],
    shopIds: body.shop_ids ?? [],
    category: body.category || "ทั่วไป",
    title: body.title,
    body: body.body,
    createdBy: r.ctx.admin.admin_id,
    sortOrder: body.sort_order,
  });

  return json(doc, 201);
}
