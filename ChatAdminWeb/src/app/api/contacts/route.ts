// GET /api/contacts — list customers (contacts) with search, filter, sort, pagination
// Query params:
//   platform = shopee | tiktok | lazada
//   search   = free text (matches name or buyer_id)
//   sortBy   = name | last_active_at | created_at (default: last_active_at)
//   sortDir  = asc | desc (default: desc)
//   page     = 1-based page number (default: 1)
//   pageSize = items per page (default: 20, max: 100)
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { customerService } from "@/backend/service/customerService";
import type { Platform } from "@/backend/service/conversationService";

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") as Platform | null;
  const search = url.searchParams.get("search") || undefined;
  const sortBy = (url.searchParams.get("sortBy") || "last_active_at") as
    | "name"
    | "last_active_at"
    | "created_at";
  const sortDirParam = url.searchParams.get("sortDir") || "desc";
  const sortDir = sortDirParam === "asc" ? 1 : -1;
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(url.searchParams.get("pageSize") || "20", 10);

  const { rows, total } = await customerService.listCustomers({
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
  });
}
