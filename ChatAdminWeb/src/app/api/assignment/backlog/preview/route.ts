// POST /api/assignment/backlog/preview — คำนวณแผนจ่ายงานค้าง (ไม่เขียน DB)
// body: { source, admin_ids, mode, limit?, quotas? }
// superadmin/dev only
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { buildPlan, validateAdminPool, type BacklogSource, type BacklogMode } from "@/backend/service/backlogService";

const MODES: BacklogMode[] = ["round_robin_selected", "least_loaded_selected", "manual_quota"];

export async function POST(req: NextRequest) {
  const r = await requireSuperadmin(req);
  if (!r.ok) return r.response;

  const body = await readJson<{
    source?: string;
    admin_ids?: string[];
    mode?: string;
    limit?: number;
    quotas?: Record<string, number>;
  }>(req);
  if (!body) return error("invalid body", 422);

  const source = (body.source || "ticket") as BacklogSource;
  if (source !== "ticket" && source !== "botworker") return error("source must be ticket|botworker", 422);
  const mode = body.mode as BacklogMode;
  if (!MODES.includes(mode)) return error(`mode must be one of ${MODES.join("|")}`, 422);

  const adminIds = (body.admin_ids || []).map(String);
  const pool = await validateAdminPool(adminIds);
  const plan = await buildPlan({
    source,
    admin_ids: pool.ok,
    mode,
    limit: body.limit,
    quotas: body.quotas,
  });

  return json({ ok: true, plan, admin_pool: { ok: pool.ok, rejected: pool.rejected } });
}
