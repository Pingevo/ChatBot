// GET /api/products — ดึงสินค้าจาก dbWallet (read-only)
// params: platform (required), shop_id?, search?, limit?, skip?
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { productService } from "@/backend/service/productService";
import type { Platform } from "@/backend/service/conversationService";

const VALID_PLATFORMS: Platform[] = ["shopee", "tiktok", "lazada"];

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const { searchParams } = req.nextUrl;
  const platform = searchParams.get("platform") as Platform | null;
  const shopId = searchParams.get("shop_id") || undefined;
  const shopName = searchParams.get("shop_name") || undefined;
  const search = searchParams.get("search") || undefined;
  const limit = parseInt(searchParams.get("limit") || "50", 10);
  const skip = parseInt(searchParams.get("skip") || "0", 10);

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return error("platform จำเป็นต้องระบุ และต้องเป็น: shopee, tiktok, lazada", 422);
  }

  try {
    const result = await productService.listProducts({
      platform,
      shopId: shopId || undefined,
      shopName: shopName || undefined,
      search: search || undefined,
      limit,
      skip,
    });
    return json(result);
  } catch (e) {
    const msg = (e as Error).message || "ดึงสินค้าไม่สำเร็จ";
    return error(msg, 500);
  }
}
