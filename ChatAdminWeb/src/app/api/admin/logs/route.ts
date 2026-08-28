// GET /api/admin/logs — list admin activity logs (join username/name)
// query: action_type, since, limit
// จำกัด: superadmin / dev เท่านั้น (admin → 403)
import { NextRequest } from "next/server";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { listAdminLogsExtended } from "@/backend/service/adminLogService";

export async function GET(req: NextRequest) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const actionType = url.searchParams.get("action_type") || undefined;
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : undefined;
  const limitParam = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.min(Math.max(limitParam, 1), 500);

  const logs = await listAdminLogsExtended({ actionType, since, limit });
  return json({ rows: logs, total: logs.length });
}
