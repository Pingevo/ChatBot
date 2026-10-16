// GET /api/stats/live — "ข้อมูลสด" — real-time-ish snapshot widgets
// Phase 4: ใช้ aggregation สด แทน load-all
// Query: range = daily (default) | monthly | yearly | all
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
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
  const r = await requirePageAccess(req, "analytics");
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
  const statusColl = await getCollection(COLLECTIONS.statusConversation);
  const [admins, shops] = await Promise.all([
    auth.listAdmins(),
    shopService.listShops(),
  ]);

  // ownership อ่านจาก status_conversation เท่านั้น
  //   (raw conversations(_shp).status="open" ทั้งหมด + assigned_to/closed_at ถูก dump ทับ)
  //   canonical partition (mutually exclusive):
  //     closed    = meta status ∈ {closed,resolved} (assigned_to ที่ค้างไว้ = history ไม่ใช่ active)
  //     active    = meta status ∈ {handoff,open,pending} + assigned_to nonempty
  //     awaiting  = meta status ∈ {handoff,open,pending} + ไม่มี owner (open+no-owner อยู่ตรงนี้)
  //     bot       = ไม่มี meta | ไม่มี status | status="bot"
  //   bounded: meta-driven $lookup (status index → unique conversation_id index)
  //   + range match ใน pipeline — ไม่มี find({}) / id arrays
  const rangeCond = () => {
    const f: Record<string, unknown> = {};
    if (start) f.$gte = start;
    if (end) f.$lt = end;
    return f;
  };
  const convRange = rangeCond();
  const dateFilter = () => (Object.keys(convRange).length ? { created_at: convRange } : {});
  const convJoinMatch = Object.keys(convRange).length ? { "conv.created_at": convRange } : {};
  const convJoin = [
    { $lookup: { from: COLLECTIONS.conversations, localField: "conversation_id", foreignField: "conversation_id", as: "conv" } },
    { $unwind: "$conv" },
  ];

  // partition agg — meta status×owner ∩ in-range convs (DB-side ทั้งหมด)
  const partitionAgg = await statusColl.aggregate<{ _id: { s: string | null; o: string | null }; n: number }>([
    { $match: { status: { $in: ["handoff", "open", "pending", "closed", "resolved"] } } },
    ...convJoin,
    ...(Object.keys(convJoinMatch).length ? [{ $match: convJoinMatch }] : []),
    { $group: { _id: { s: "$status", o: { $ifNull: ["$assigned_to", null] } }, n: { $sum: 1 } } },
  ]).toArray();
  let activeCount = 0;
  let awaitingCount = 0;
  let closedCount = 0;
  const workloadCount = new Map<string, number>(); // owner → active convs (in range)
  for (const g of partitionAgg) {
    const s = g._id.s;
    const owner = g._id.o;
    if (s === "closed" || s === "resolved") { closedCount += g.n; continue; }
    if (owner != null && owner !== "") {
      activeCount += g.n;
      workloadCount.set(owner, (workloadCount.get(owner) || 0) + g.n);
    } else {
      awaitingCount += g.n;
    }
  }
  const humanOpenCount = activeCount + awaitingCount;

  // 1-3. open / assigned / closed / unanswered — partition DB-side; total จาก inventory
  const UNANSWERED_MINUTES = 10;
  const threshold = new Date(Date.now() - UNANSWERED_MINUTES * 60_000);
  const unreadJoinMatch = {
    "conv.unread_count": { $gt: 0 },
    "conv.last_message_timestamp": { $lt: threshold },
    ...convJoinMatch,
  };
  const [totalInRange, unansweredAll, closedUnansweredAgg] = await Promise.all([
    convColl.countDocuments(dateFilter()),
    convColl.countDocuments({
      unread_count: { $gt: 0 },
      last_message_timestamp: { $lt: threshold },
      ...dateFilter(),
    }),
    statusColl.aggregate<{ n: number }>([
      { $match: { status: { $in: ["closed", "resolved"] } } },
      ...convJoin,
      { $match: unreadJoinMatch },
      { $count: "n" },
    ]).toArray(),
  ]);
  const openTotal = totalInRange - closedCount;
  const unansweredCount = unansweredAll - (closedUnansweredAgg[0]?.n || 0);
  const openStats = { total: openTotal, assigned: activeCount, unassigned: awaitingCount };

  // 4. Workload by admin — active meta owner ∩ in-range (closed+retained owner ไม่นับ)
  const adminMap = new Map(admins.map((a) => [a.admin_id, a]));
  const workload = [...workloadCount.entries()]
    .map(([adminId, count]) => ({ admin_id: adminId, name: adminMap.get(adminId)?.name || adminId, count }))
    .sort((a, b) => b.count - a.count);

  // 5. Breakdown by shop — open conversations = all in-range − meta-closed per shop
  const [shopAggAll, shopAggClosed] = await Promise.all([
    convColl.aggregate<{ _id: string; count: number }>([
      { $match: dateFilter() },
      { $group: { _id: { $ifNull: ["$shop_name", "unknown"] }, count: { $sum: 1 } } },
    ]).toArray(),
    statusColl.aggregate<{ _id: string; count: number }>([
      { $match: { status: { $in: ["closed", "resolved"] } } },
      ...convJoin,
      ...(Object.keys(convJoinMatch).length ? [{ $match: convJoinMatch }] : []),
      { $group: { _id: { $ifNull: ["$conv.shop_name", "unknown"] }, count: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const closedByShop = new Map(shopAggClosed.map((s) => [s._id, s.count]));
  const byConnection = shopAggAll
    .map((s) => ({ name: s._id, value: s.count - (closedByShop.get(s._id) || 0) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 20);

  // 6. Breakdown by status (บอทตอบ / เปิด / ปิด) — partition: openTotal = bot + humanOpen
  const statusBreakdown = [
    { status: "bot_answered", label: "บอทตอบ", count: openTotal - humanOpenCount },
    { status: "open", label: "เปิด", count: humanOpenCount },
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
