// GET /api/botworker/review-analysis — BotWorker page access, server-filtered analysis
export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json, error } from "@/backend/lib/http";
import { getBotworkerReviewAnalysis, type ReviewAnalysisGroup } from "@/backend/service/botworkerReviewAnalyticsService";

const GROUPS: ReviewAnalysisGroup[] = ["day", "month", "year"];

export async function GET(req: NextRequest) {
  const access = await requirePageAccess(req, "botworker");
  if (!access.ok) return access.response;
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const group = (url.searchParams.get("group") || "day") as ReviewAnalysisGroup;
  if (!GROUPS.includes(group)) return error("group must be day/month/year", 422);
  try {
    const data = await getBotworkerReviewAnalysis({
      from, to, group,
      page: Number(url.searchParams.get("page") || 1),
      pageSize: Number(url.searchParams.get("page_size") || 25),
    });
    return json(data);
  } catch (e) {
    const message = e instanceof Error ? e.message : "analysis_failed";
    return error(message === "date_range_too_large" ? "เลือกช่วงเวลาไม่เกิน 5 ปี" : "ช่วงวันที่ไม่ถูกต้อง", 422);
  }
}
