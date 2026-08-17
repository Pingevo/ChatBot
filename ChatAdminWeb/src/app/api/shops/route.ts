// GET /api/shops — list shops (optionally filtered by platform)
// PATCH /api/shops/[id]/connected — toggle connected state (handled in [id]/route)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { shopService } from "@/backend/service/shopService";
import type { Platform } from "@/backend/service/conversationService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") as Platform | null;
  const shops = await shopService.listShops(platform || undefined);
  return json({ rows: shops, total: shops.length });
}
