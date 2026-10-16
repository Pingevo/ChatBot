// GET /api/shops — list shops with optional platform filter, search, sort, pagination
// Query params:
//   platform = shopee | tiktok | lazada
//   search   = free text (matches shopname or shop_id)
//   sortBy   = shopname | created_at | conversation_count | product_count (default: created_at)
//   sortDir  = asc | desc (default: desc)
//   page     = 1-based page number (default: 1)
//   pageSize = items per page (default: 20, max: 100)
//
// Backward compat: if no pagination params are sent, returns all shops (legacy behavior
// used by the config page and other callers that expect { rows, total }).
// ⚡ Phase 2D — response ทุกรูปแบบแนบ `bot_worker` meta (global + per-platform +
//   implemented backends) เพื่อให้ /shops คำนวณ effective state ของแต่ละ shop ได้
//   โดยไม่ต้องอ่าน /api/config (ที่ล็อคเฉพาะ dev)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { shopService } from "@/backend/service/shopService";
import { systemConfigService } from "@/backend/service/systemConfigService";
import { BOTWORKER_BACKENDS } from "@/backend/lib/safety";
import type { Platform } from "@/backend/service/conversationService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") as Platform | null;
  const search = url.searchParams.get("search") || undefined;
  const sortByParam = url.searchParams.get("sortBy");
  const sortDirParam = url.searchParams.get("sortDir");
  const pageParam = url.searchParams.get("page");
  const pageSizeParam = url.searchParams.get("pageSize");

  // ⚡ Phase 2D — botworker scope meta (fail-closed: config อ่านไม่ได้ → ทุกชั้น OFF)
  const config = await systemConfigService.getSystemConfig().catch(() => null);
  const botWorker = {
    global: config?.bot_worker_enabled === true,
    platforms: {
      shopee: config?.bot_worker_platforms?.shopee === true,
      tiktok: config?.bot_worker_platforms?.tiktok === true,
      lazada: config?.bot_worker_platforms?.lazada === true,
    },
    implemented: [...BOTWORKER_BACKENDS],
  };

  // Legacy mode: no pagination params → return all (for config page + simple callers)
  if (!pageParam && !pageSizeParam && !search && !sortByParam) {
    const shops = await shopService.listShops(platform || undefined);
    return json({ rows: shops, total: shops.length, bot_worker: botWorker });
  }

  const sortBy = (sortByParam || "created_at") as
    | "shopname"
    | "created_at"
    | "conversation_count"
    | "product_count";
  const sortDir = sortDirParam === "asc" ? 1 : -1;
  const page = parseInt(pageParam || "1", 10);
  const pageSize = parseInt(pageSizeParam || "20", 10);

  const { rows, total } = await shopService.listShopsPaged({
    platform: platform || undefined,
    search,
    sortBy,
    sortDir,
    page,
    pageSize,
  });

  return json({
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    bot_worker: botWorker,
  });
}
