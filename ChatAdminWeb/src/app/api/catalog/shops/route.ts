// GET /api/catalog/shops — product catalog shop names (read-only dbWallet).
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { productService } from "@/backend/service/productService";
import type { Platform } from "@/backend/service/conversationService";

const PLATFORMS: Platform[] = ["shopee", "tiktok", "lazada"];

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const requested = new URL(req.url).searchParams.get("platform") || "shopee";
  if (!PLATFORMS.includes(requested as Platform)) {
    return error("platform must be one of: shopee, tiktok, lazada", 400);
  }

  try {
    return json({ shops: await productService.listCatalogShopNames(requested as Platform) });
  } catch {
    return error("failed to load catalog shops", 500);
  }
}
