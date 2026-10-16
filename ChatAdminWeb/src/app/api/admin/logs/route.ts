// GET /api/admin/logs — list admin activity logs (join username/name) แบบ numbered pagination
// query: page (default 1, min 1) · pageSize (default 100, clamp 1–100)
//        admin_id · action_type (exact — ชนะ action_types) · action_types (CSV, dedupe)
//        since (ISO — invalid ถูก ignore) · q (search ≤100 chars)
// จำกัด: dev เท่านั้น (admin/superadmin → 403)
import { NextRequest } from "next/server";
import { requirePageEdit } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { listAdminLogsExtended } from "@/backend/service/adminLogService";

function clampInt(v: string | null, dflt: number, min: number, max: number): number {
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

export async function GET(req: NextRequest) {
  const r = await requirePageEdit(req, "log");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const page = clampInt(url.searchParams.get("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(url.searchParams.get("pageSize"), 100, 1, 100);
  const adminId = url.searchParams.get("admin_id")?.trim() || undefined;
  const actionType = url.searchParams.get("action_type")?.trim() || undefined;
  const actionTypes = url.searchParams.get("action_types")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sinceParam = url.searchParams.get("since");
  const sinceDate = sinceParam ? new Date(sinceParam) : undefined;
  const since = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : undefined;
  const q = url.searchParams.get("q")?.trim().slice(0, 100) || undefined;

  const result = await listAdminLogsExtended({
    adminId,
    actionType,
    actionTypes: actionTypes?.length ? [...new Set(actionTypes)] : undefined,
    since,
    search: q,
    page,
    pageSize,
  });
  return json(result);
}
