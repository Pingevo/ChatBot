// API: /api/admin-review-kpi
//
// ⚡ Phase 3A — KPI dashboard สำหรับ dev/superadmin
//
// GET /api/admin-review-kpi?from=2026-09-01&to=2026-09-07
//   → KPI รวมทุก admin ในช่วงเวลา
//
// GET /api/admin-review-kpi?admin_id=xxx&from=...&to=...
//   → KPI ของ admin คนเดียว
//
// GET /api/admin-review-kpi?drilldown=test_chat&admin_id=xxx&from=...&to=...
//   → drill-down session ของ admin คนนั้น
//
// GET /api/admin-review-kpi?drilldown=test_assignment&admin_id=xxx&from=...&to=...
//   → drill-down replay ของ admin คนนั้น
//
// GET /api/admin-review-kpi?drilldown=shadow&admin_id=xxx&from=...&to=...
//   → drill-down shadow reply ของ admin คนนั้น
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { adminKpiService } from "@/backend/service/adminKpiService";

export const dynamic = "force-dynamic";

function parseDate(s: string | null): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(d.getTime())) return undefined;
  return d;
}

export async function GET(req: NextRequest) {
  // ⚡ Phase 3A — dev/superadmin เท่านั้น (admin → 403)
  const r = await requirePageAccess(req, "admin-review-kpi");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  const adminId = url.searchParams.get("admin_id") || undefined;
  const drilldown = url.searchParams.get("drilldown");

  const range = { from, to };

  try {
    if (drilldown === "test_chat") {
      if (!adminId) return error("admin_id required for drilldown", 422);
      const sessions = await adminKpiService.getTestChatSessionsByAdmin(adminId, range);
      return json({ sessions });
    }
    if (drilldown === "test_assignment") {
      if (!adminId) return error("admin_id required for drilldown", 422);
      const replays = await adminKpiService.getTestAssignmentReplaysByAdmin(adminId, range);
      return json({ replays });
    }
    if (drilldown === "shadow") {
      if (!adminId) return error("admin_id required for drilldown", 422);
      const shadows = await adminKpiService.getShadowRepliesByAdmin(adminId, range);
      return json({ shadows });
    }

    // default — KPI summary
    const summary = await adminKpiService.getAdminKpiSummary(range, adminId);
    return json({ summary, range: { from: from?.toISOString(), to: to?.toISOString() } });
  } catch (e) {
    return error(`failed: ${e}`, 500);
  }
}
