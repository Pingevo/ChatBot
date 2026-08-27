// GET /api/stats/live — "ข้อมูลสด" — real-time-ish snapshot widgets
// Phase 4: ใช้ aggregation สด แทน load-all
// Query: range = daily (default) | monthly | yearly | all
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { auth } from "@/backend/service/authService";
import { shopService } from "@/backend/service/shopService";

function getBounds(range: string): { start: Date | null; end: Date | null } {
  const now = new Date();
  if (range === "all") return { start: null, end: null };
  if (range === "monthly") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  }
  if (range === "yearly") {
    return { start: new Date(now.getFullYear(), 0, 1), end: now };
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  return { start, end: now };
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const range = url.searchParams.get("range") || "daily";
  const customStart = url.searchParams.get("start_date");
  const customEnd = url.searchParams.get("end_date");

  let start: Date | null;
  let end: Date | null;
  if (customStart) {
    start = new Date(customStart);
    start.setHours(0, 0, 0, 0);
    end = customEnd ? new Date(customEnd) : new Date(start);
    end.setHours(23, 59, 59, 999);
  } else {
    const bounds = getBounds(range);
    start = bounds.start;
    end = bounds.end;
  }

  const convColl = await getCollection(COLLECTIONS.conversations);
  const [admins, shops] = await Promise.all([
    auth.listAdmins(),
    shopService.listShops(),
  ]);

  // ⚠️ sellcenter ไม่เขียน status → ใช้ derived: closed_at = ปิด, assigned_to = เปิด, อื่นๆ = บอทตอบ
  const dateFilter = () => {
    const f: Record<string, unknown> = {};
    if (start) f.$gte = start;
    if (end) f.$lt = end;
    return Object.keys(f).length ? { created_at: f } : {};
  };

  // 1. Open conversation counts — "เปิด" = ไม่มี closed_at
  const openAgg = await convColl.aggregate<{
    _id: null;
    total: number;
    assigned: number;
    unassigned: number;
  }>([
    { $match: { closed_at: { $in: [null, undefined] }, ...dateFilter() } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        assigned: { $sum: { $cond: [{ $ifNull: ["$assigned_to", false] }, 1, 0] } },
        unassigned: { $sum: { $cond: [{ $ifNull: ["$assigned_to", false] }, 0, 1] } },
      },
    },
  ]).toArray();
  const openStats = openAgg[0] || { _id: null, total: 0, assigned: 0, unassigned: 0 };

  // 2. Closed conversations count — มี closed_at
  const closedCount = await convColl.countDocuments({
    closed_at: { $exists: true, $ne: null },
    ...dateFilter(),
  });

  // 3. Unanswered — open conversations with unread_count > 0
  const UNANSWERED_MINUTES = 10;
  const threshold = new Date(Date.now() - UNANSWERED_MINUTES * 60_000);
  const unansweredCount = await convColl.countDocuments({
    closed_at: { $in: [null, undefined] },
    unread_count: { $gt: 0 },
    last_message_timestamp: { $lt: threshold },
    ...dateFilter(),
  });

  // 4. Workload by admin — aggregation (เฉพาะที่มี assigned_to)
  const workloadAgg = await convColl.aggregate<{ _id: string; count: number }>([
    { $match: { closed_at: { $in: [null, undefined] }, assigned_to: { $exists: true, $nin: [null, ""] }, ...dateFilter() } },
    { $group: { _id: "$assigned_to", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();
  const adminMap = new Map(admins.map((a) => [a.admin_id, a]));
  const workload = workloadAgg.map((w) => ({
    admin_id: w._id,
    name: adminMap.get(w._id)?.name || w._id,
    count: w.count,
  }));

  // 5. Breakdown by shop — all open conversations
  const shopAgg = await convColl.aggregate<{ _id: string; count: number }>([
    { $match: { closed_at: { $in: [null, undefined] }, ...dateFilter() } },
    { $group: { _id: { $ifNull: ["$shop_name", "unknown"] }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 },
  ]).toArray();
  const byConnection = shopAgg.map((s) => ({ name: s._id, value: s.count }));

  // 6. Breakdown by derived status (บอทตอบ / เปิด / ปิด)
  const [botAnsweredCount, openHandoffCount] = await Promise.all([
    convColl.countDocuments({ closed_at: { $in: [null, undefined] }, assigned_to: { $in: [null, undefined, ""] }, ...dateFilter() }),
    convColl.countDocuments({ closed_at: { $in: [null, undefined] }, assigned_to: { $exists: true, $nin: [null, ""] }, ...dateFilter() }),
  ]);
  const statusBreakdown = [
    { status: "bot_answered", label: "บอทตอบ", count: botAnsweredCount },
    { status: "open", label: "เปิด", count: openHandoffCount },
    { status: "closed", label: "ปิด", count: closedCount },
  ];

  return json({
    has_real_data: openStats.total > 0 || closedCount > 0,
    range,
    connected_shops: shops.length,
    open_total: openStats.total,
    open_assigned: openStats.assigned,
    open_unassigned: openStats.unassigned,
    closed_total: closedCount,
    unanswered_total: unansweredCount,
    unanswered_threshold_minutes: UNANSWERED_MINUTES,
    workload_by_admin: workload,
    breakdown_by_connection: byConnection,
    breakdown_by_status: statusBreakdown,
    generated_at: new Date().toISOString(),
  });
}
