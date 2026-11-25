// GET /api/bot-performance?view=summary|items|export — bot-performance page access, read-only analysis
export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import {
  exportBotPerformance, getBotPerformanceItems, getBotPerformanceSummary,
  type PerfFilters, type PerfGroup, type PerfHandoff, type PerfOutcome,
} from "@/backend/service/botPerformanceService";

const GROUPS: PerfGroup[] = ["day", "week", "month"];
const OUTCOMES: PerfOutcome[] = ["approved", "edited", "rejected", "pending", "none"];
const HANDOFFS: PerfHandoff[] = ["none", "requested", "approved", "rejected", "pending"];

export async function GET(req: NextRequest) {
  const access = await requirePageAccess(req, "bot-performance");
  if (!access.ok) return access.response;
  const params = new URL(req.url).searchParams;
  const view = params.get("view") || "summary";
  const outcome = params.get("outcome") as PerfOutcome | null;
  const handoff = params.get("handoff") as PerfHandoff | null;
  const filters: PerfFilters = {
    from: params.get("from") || "",
    to: params.get("to") || "",
    shopId: params.get("shop_id") || undefined,
    outcome: outcome && OUTCOMES.includes(outcome) ? outcome : undefined,
    handoff: handoff && HANDOFFS.includes(handoff) ? handoff : undefined,
    reviewer: params.get("reviewer") || undefined,
    minEditPct: Number(params.get("min_edit_pct")) || undefined,
    q: params.get("q") || undefined,
  };
  try {
    if (view === "summary") {
      const group = (params.get("group") || "day") as PerfGroup;
      if (!GROUPS.includes(group)) return error("group must be day/week/month", 422);
      return json(await getBotPerformanceSummary({ ...filters, group }));
    }
    if (view === "items") {
      return json(await getBotPerformanceItems({ ...filters, page: Number(params.get("page") || 1), pageSize: Number(params.get("page_size") || 25) }));
    }
    if (view === "export") {
      const format = params.get("format") === "jsonl" ? "jsonl" : "csv";
      const { body, truncated } = await exportBotPerformance(filters, format);
      return new NextResponse(body, {
        headers: {
          "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
          "content-disposition": `attachment; filename="bot-performance_${filters.from}_${filters.to}.${format}"`,
          "x-export-truncated": truncated ? "1" : "0",
        },
      });
    }
    return error("view must be summary/items/export", 422);
  } catch (e) {
    const message = e instanceof Error ? e.message : "analysis_failed";
    if (message === "date_range_too_large") return error("เลือกช่วงเวลาไม่เกิน 5 ปี", 422);
    if (message === "invalid_date_range") return error("ช่วงวันที่ไม่ถูกต้อง", 422);
    throw e;
  }
}
