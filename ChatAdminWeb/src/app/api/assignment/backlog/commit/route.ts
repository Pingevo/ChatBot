// POST /api/assignment/backlog/commit — จ่ายงานค้างจริงตามแผน (re-run planner server-side)
// body: { source, admin_ids, mode, limit?, quotas?, idem_key }
// idem_key กัน double-commit; atomic re-check pending ทีละตัวกัน race
// superadmin/dev only
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requireSuperadmin } from "@/backend/middleware/authorize";
import { json, error, readJson } from "@/backend/lib/http";
import { commitPlan, validateAdminPool, type BacklogSource, type BacklogMode } from "@/backend/service/backlogService";

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
    idem_key?: string;
  }>(req);
  if (!body) return error("invalid body", 422);
  if (!body.idem_key || !String(body.idem_key).trim()) return error("idem_key is required", 422);

  const source = (body.source || "ticket") as BacklogSource;
  if (source !== "ticket" && source !== "botworker") return error("source must be ticket|botworker", 422);
  const mode = body.mode as BacklogMode;
  if (!MODES.includes(mode)) return error(`mode must be one of ${MODES.join("|")}`, 422);

  const adminIds = (body.admin_ids || []).map(String);
  const pool = await validateAdminPool(adminIds);
  if (pool.ok.length === 0) {
    return json({ ok: false, error: "no eligible admin in selected pool", admin_pool: pool }, 422);
  }

  const result = await commitPlan(
    {
      source,
      admin_ids: pool.ok,
      mode,
      limit: body.limit,
      quotas: body.quotas,
      idem_key: String(body.idem_key).trim(),
    },
    r.ctx.admin.admin_id
  );

  return json({
    ok: true,
    applied: result.applied,
    skipped_race: result.skipped_race,
    idempotent_replay: result.idempotent_replay || false,
    plan: result.plan,
    admin_pool: { ok: pool.ok, rejected: pool.rejected },
  });
}
