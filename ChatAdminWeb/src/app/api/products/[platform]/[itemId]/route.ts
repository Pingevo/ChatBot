import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { productService } from "@/backend/service/productService";
import type { Platform } from "@/backend/service/conversationService";

const VALID_PLATFORMS: Platform[] = ["shopee", "tiktok", "lazada"];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string; itemId: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { platform: rawPlatform, itemId } = await params;
  if (!VALID_PLATFORMS.includes(rawPlatform as Platform)) {
    return error("platform ต้องเป็น shopee, tiktok หรือ lazada", 422);
  }
  if (!itemId || itemId.length > 128) {
    return error("itemId ไม่ถูกต้อง", 422);
  }

  try {
    const product = await productService.getProductDetails({
      platform: rawPlatform as Platform,
      itemId,
    });
    if (!product) return error("ไม่พบสินค้า", 404);
    return json({ product });
  } catch (e) {
    const message = (e as Error).message || "ดึงรายละเอียดสินค้าไม่สำเร็จ";
    return error(message, 500);
  }
}
