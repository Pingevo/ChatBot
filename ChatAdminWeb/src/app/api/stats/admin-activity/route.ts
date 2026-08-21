// GET /api/stats/admin-activity — "การทำงานของแอดมิน" — Zaapi-style overview
// Phase 4: ใช้ MongoDB aggregation สด
// Query: range = daily (default) | monthly | yearly | all
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { auth } from "@/backend/service/authService";
import { shopService } from "@/backend/service/shopService";
import { computeResponseStats } from "@/backend/lib/responseStats";

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

function fmtDay(d: Date): string {
  return d.toLocaleDateString("th-TH", { day: "2-digit", month: "short" });
}

export async function GET(req: NextRequest) {
  const r = await requireAuth(req);
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const range = url.searchParams.get("range") || "daily";
  const customStart = url.searchParams.get("start_date");
  const customEnd = url.searchParams.get("end_date");

  let weekStart: Date | null;
  let weekEnd: Date | null;
  if (customStart) {
    weekStart = new Date(customStart);
    weekStart.setHours(0, 0, 0, 0);
    weekEnd = customEnd ? new Date(customEnd) : new Date(weekStart);
    weekEnd.setHours(23, 59, 59, 999);
  } else {
    const bounds = getBounds(range);
    weekStart = bounds.start;
    weekEnd = bounds.end;
  }

  const convColl = await getCollection(COLLECTIONS.conversations);
  const msgColl = await getCollection(COLLECTIONS.messages);
  const [admins, shops] = await Promise.all([
    auth.listAdmins(),
    shopService.listShops(),
  ]);

  const adminMap = new Map(admins.map((a) => [a.admin_id, a]));

  // dayLabels ตาม range
  let dayLabels: string[] = [];
  if (range === "daily") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      dayLabels.push(d.toLocaleDateString("th-TH", { weekday: "short" }));
    }
  } else if (range === "monthly") {
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) dayLabels.push(String(i));
  } else if (range === "yearly") {
    dayLabels = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  } else {
    const yearsAgg = await convColl.aggregate<{ _id: number }>([
      { $group: { _id: { $year: "$created_at" } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    dayLabels = yearsAgg.map((y) => `${y._id + 543}`);
  }

  const dateFilter = (field: string) => {
    const f: Record<string, unknown> = {};
    if (weekStart) f.$gte = weekStart;
    if (weekEnd) f.$lt = weekEnd;
    return Object.keys(f).length ? { [field]: f } : {};
  };

  // 1. Top handled admins (by assigned conversation count) — aggregation
  const handledAgg = await convColl.aggregate<{ _id: string; count: number }>([
    { $match: { assigned_to: { $exists: true, $ne: null }, ...dateFilter("created_at") } },
    { $group: { _id: "$assigned_to", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]).toArray();
  const topAdminIds = handledAgg.map((a) => a._id);

  // bucket ตาม range
  let bucketId: Record<string, unknown>;
  if (range === "daily") {
    bucketId = { y: { $year: "$created_at" }, m: { $month: "$created_at" }, d: { $dayOfMonth: "$created_at" } };
  } else if (range === "monthly") {
    bucketId = { d: { $dayOfMonth: "$created_at" } };
  } else if (range === "yearly") {
    bucketId = { m: { $month: "$created_at" } };
  } else {
    bucketId = { y: { $year: "$created_at" } };
  }

  // 2. Conversations by admin per day — aggregation per top admin
  const conversationsByAdminPerDay: Record<string, unknown>[] = dayLabels.map((date) => ({ date }));
  for (const adminId of topAdminIds) {
    const name = adminMap.get(adminId)?.name || adminId;
    const agg = await convColl.aggregate<{ _id: Record<string, number>; count: number }>([
      { $match: { assigned_to: adminId, ...dateFilter("created_at") } },
      { $group: { _id: bucketId, count: { $sum: 1 } } },
      { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
    ]).toArray();
    const map = new Map<string, number>();
    for (const d of agg) {
      const key = range === "daily"
        ? `${d._id.y}-${d._id.m}-${d._id.d}`
        : range === "monthly"
        ? `${d._id.d}`
        : range === "yearly"
        ? `${d._id.m}`
        : `${d._id.y}`;
      map.set(key, d.count);
    }
    if (range === "daily") {
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - i);
        const idx = 6 - i;
        conversationsByAdminPerDay[idx][name] = map.get(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`) || 0;
      }
    } else if (range === "monthly") {
      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      for (let i = 1; i <= daysInMonth; i++) {
        conversationsByAdminPerDay[i - 1][name] = map.get(`${i}`) || 0;
      }
    } else if (range === "yearly") {
      for (let i = 1; i <= 12; i++) {
        conversationsByAdminPerDay[i - 1][name] = map.get(`${i}`) || 0;
      }
    } else {
      dayLabels.forEach((label, idx) => {
        const year = parseInt(label) - 543;
        conversationsByAdminPerDay[idx][name] = map.get(`${year}`) || 0;
      });
    }
  }

  // 3. Individual performance — ⚡ parallel aggregation + ใช้ helper แทน $lookup ต่อ admin
  //    คำนวณ response stats ครั้งเดียว (ไม่ใช่ 2 $lookup ต่อ admin)
  const [responseStats, ...perfAggs] = await Promise.all([
    computeResponseStats(msgColl, { start: weekStart, end: weekEnd, adminOnly: true }),
    ...admins.map((a) =>
      convColl.aggregate<{
        _id: null;
        total: number;
        resolved: number;
        unanswered: number;
      }>([
        { $match: { assigned_to: a.admin_id, ...dateFilter("created_at") } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            resolved: { $sum: { $cond: [{ $in: ["$status", ["resolved", "bot"]] }, 1, 0] } },
            unanswered: { $sum: { $cond: [{ $in: ["$status", ["handoff", "pending"]] }, 1, 0] } },
          },
        },
      ]).toArray().then((agg) => ({ admin: a, perf: agg[0] || { total: 0, resolved: 0, unanswered: 0 } }))
    ),
  ]);

  const individualPerformance = perfAggs.map(({ admin: a, perf }) => {
    const adminStats = responseStats.perAdmin.get(a.admin_id);
    const avgSeconds = adminStats?.avgSeconds ? Math.round(adminStats.avgSeconds) : 0;
    const fastCount = adminStats?.within10min || 0;
    const responseRate10min = perf.total ? Math.round((fastCount / perf.total) * 1000) / 10 : 0;
    return {
      admin_id: a.admin_id,
      name: a.name || a.username,
      role: a.role,
      conversations: perf.total,
      unanswered_12h: perf.unanswered,
      response_rate_12h: perf.total ? Math.round((perf.resolved / perf.total) * 1000) / 10 : 0,
      response_rate_10min: responseRate10min,
      avg_response_time_seconds: avgSeconds,
    };
  });

  // 4. Rankings
  const sorted = [...individualPerformance];
  const mostConversations = sorted.sort((a, b) => b.conversations - a.conversations)[0];
  const fastest10min = [...individualPerformance]
    .filter((a) => a.response_rate_10min > 0)
    .sort((a, b) => b.response_rate_10min - a.response_rate_10min)[0];
  const fastestOverall = [...individualPerformance]
    .filter((a) => a.avg_response_time_seconds > 0)
    .sort((a, b) => a.avg_response_time_seconds - b.avg_response_time_seconds)[0];
  const leastResponses = [...individualPerformance]
    .filter((a) => a.conversations > 0)
    .sort((a, b) => a.response_rate_12h - b.response_rate_12h)[0];

  const totalConversations = individualPerformance.reduce((s, a) => s + a.conversations, 0);

  // ⚠️ ถ้าไม่มี assigned admins (sellcenter ไม่ set assigned_to) ให้ดึง overall stats จาก messages
  // เพื่อให้หน้า admin-activity ยังแสดงข้อมูลรวมได้
  const [overallConv, overallMsgsIn, overallMsgsOut, overallClosed] = await Promise.all([
    convColl.countDocuments({ ...dateFilter("created_at") }),
    msgColl.countDocuments({ role: "user", direction: "in", ...dateFilter("created_timestamp") }),
    msgColl.countDocuments({ role: { $in: ["admin", "bot"] }, direction: "out", ...dateFilter("created_timestamp") }),
    convColl.countDocuments({ closed_at: { $exists: true, $ne: null }, ...dateFilter("created_at") }),
  ]);

  // date_range_label ตาม range
  let dateRangeLabel = "";
  if (range === "daily") {
    const start7 = new Date();
    start7.setDate(start7.getDate() - 6);
    dateRangeLabel = `${fmtDay(start7)} - ${fmtDay(new Date())}, ${new Date().getFullYear() + 543}`;
  } else if (range === "monthly") {
    dateRangeLabel = new Date().toLocaleDateString("th-TH", { month: "long", year: "numeric" });
  } else if (range === "yearly") {
    dateRangeLabel = `${new Date().getFullYear() + 543}`;
  } else {
    dateRangeLabel = "ทั้งหมด";
  }

  return json({
    has_real_data: overallConv > 0 || totalConversations > 0,
    range,
    connected_shops: shops.length,
    date_range_label: dateRangeLabel,
    compare_label: range === "daily" ? "7 วันที่แล้ว" : range === "monthly" ? "เดือนที่แล้ว" : range === "yearly" ? "ปีที่แล้ว" : "ทั้งหมด",
    // overall stats (แม้ไม่มี assigned admins ก็แสดง)
    overall: {
      total_conversations: overallConv,
      messages_received: overallMsgsIn,
      messages_sent: overallMsgsOut,
      closed: overallClosed,
      open: overallConv - overallClosed,
    },
    conversations_by_admin_per_day: conversationsByAdminPerDay,
    admin_series_keys: topAdminIds.map((id) => adminMap.get(id)?.name || id),
    rankings: {
      most_conversations: mostConversations && mostConversations.conversations > 0 ? mostConversations : null,
      least_responses: leastResponses || null,
      fastest_10min: fastest10min || null,
      fastest_overall: fastestOverall || null,
    },
    individual_performance: individualPerformance,
  });
}
