// GET /api/stats/performance — "ภาพรวม Performance" — Zaapi-style KPI grid
// Phase 4: ใช้ MongoDB aggregation สด
// Query: range = daily (default) | monthly | yearly | all
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { shopService } from "@/backend/service/shopService";
import { computeResponseStats } from "@/backend/lib/responseStats";
import type { Platform } from "@/backend/service/conversationService";

const PLATFORMS: Platform[] = ["shopee", "tiktok", "lazada"];

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
  const shops = await shopService.listShops();

  // สร้าง dayLabels ตาม range
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
    for (let i = 1; i <= daysInMonth; i++) {
      dayLabels.push(String(i));
    }
  } else if (range === "yearly") {
    const monthNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    dayLabels = monthNames;
  } else {
    // all — ดึงปีทั้งหมดที่มีข้อมูล
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

  // 1. Conversations per day (overall) — aggregation
  // bucket ตาม range type
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

  const convPerDayAgg = await convColl.aggregate<{ _id: Record<string, number>; count: number }>([
    { $match: { ...dateFilter("created_at") } },
    { $group: { _id: bucketId, count: { $sum: 1 } } },
    { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
  ]).toArray();
  // map index ตาม label
  const convPerDayMap = new Map<string, number>();
  for (const d of convPerDayAgg) {
    const key = range === "daily"
      ? `${d._id.y}-${d._id.m}-${d._id.d}`
      : range === "monthly"
      ? `${d._id.d}`
      : range === "yearly"
      ? `${d._id.m}`
      : `${d._id.y}`;
    convPerDayMap.set(key, d.count);
  }
  // build conversationsPerDay array
  let conversationsPerDay: number[] = [];
  if (range === "daily") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      conversationsPerDay.push(convPerDayMap.get(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`) || 0);
    }
  } else if (range === "monthly") {
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) {
      conversationsPerDay.push(convPerDayMap.get(`${i}`) || 0);
    }
  } else if (range === "yearly") {
    for (let i = 1; i <= 12; i++) {
      conversationsPerDay.push(convPerDayMap.get(`${i}`) || 0);
    }
  } else {
    // all — ใช้ label เป็นปี พ.ศ.
    for (const label of dayLabels) {
      const year = parseInt(label) - 543;
      conversationsPerDay.push(convPerDayMap.get(`${year}`) || 0);
    }
  }

  // 2. Customers by channel per day — ⚡ parallel per platform (แทน sequential loop)
  const customersByChannel: Record<string, unknown>[] = dayLabels.map((date) => ({ date }));
  const platformAggs = await Promise.all(
    PLATFORMS.map((p) =>
      convColl.aggregate<{ _id: Record<string, number>; count: number }>([
        { $match: { platform: p, ...dateFilter("created_at") } },
        { $group: { _id: bucketId, count: { $sum: 1 } } },
        { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
      ]).toArray().then((agg) => ({ platform: p, agg }))
    )
  );
  for (const { platform: p, agg } of platformAggs) {
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
        customersByChannel[idx][p] = map.get(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`) || 0;
      }
    } else if (range === "monthly") {
      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      for (let i = 1; i <= daysInMonth; i++) {
        customersByChannel[i - 1][p] = map.get(`${i}`) || 0;
      }
    } else if (range === "yearly") {
      for (let i = 1; i <= 12; i++) {
        customersByChannel[i - 1][p] = map.get(`${i}`) || 0;
      }
    } else {
      dayLabels.forEach((label, idx) => {
        const year = parseInt(label) - 543;
        customersByChannel[idx][p] = map.get(`${year}`) || 0;
      });
    }
  }

  // 3. Messages received / sent totals
  const [messagesReceived, messagesSent] = await Promise.all([
    msgColl.countDocuments({ role: "user", ...dateFilter("created_timestamp") }),
    msgColl.countDocuments({ role: { $in: ["bot", "admin"] }, ...dateFilter("created_timestamp") }),
  ]);

  // 4. Total conversations + derived counts (ไม่กรองตาม status เพราะ sellcenter ไม่เขียน)
  const [totalConv, closedCount, handoffCount] = await Promise.all([
    convColl.countDocuments({ ...dateFilter("created_at") }),
    convColl.countDocuments({ closed_at: { $exists: true, $ne: null }, ...dateFilter("created_at") }),
    convColl.countDocuments({ assigned_to: { $exists: true, $nin: [null, ""] }, ...dateFilter("created_at") }),
  ]);
  const totals = { total: totalConv, resolved: totalConv - closedCount, weekCount: totalConv };
  const newCustomers = totals.weekCount;
  const existingCustomers = 0;
  const responseRate12h = totals.total ? Math.round((totals.resolved / totals.total) * 1000) / 10 : 0;

  // 5+6. Response rate 10min + Avg response time — ⚡ ใช้ helper แทน $lookup (เร็วขึ้นมาก)
  //    คำนวณทั้งสองค่าในการ scan ครั้งเดียว
  const responseStats = await computeResponseStats(msgColl, { start: weekStart, end: weekEnd });
  const reply10minCount = responseStats.replyWithin10min;
  const responseRate10min = totals.total ? Math.round((reply10minCount / totals.total) * 1000) / 10 : 0;
  const avgResponseTimeSeconds = responseStats.avgResponseSeconds
    ? Math.round(responseStats.avgResponseSeconds)
    : 0;

  // 7. Unanswered — conversations ที่ยังไม่ปิด + มี unread > 0
  const unanswered12h = await convColl.countDocuments({
    closed_at: { $in: [null, undefined] },
    unread_count: { $gt: 0 },
    ...dateFilter("created_at"),
  });

  // 8. Heatmap — messages by hour-of-day × day-of-week
  const heatmapAgg = await msgColl.aggregate<{
    _id: { hour: number; dow: number };
    count: number;
  }>([
    { $match: { role: "user", ...dateFilter("created_timestamp") } },
    {
      $group: {
        _id: {
          hour: { $floor: { $divide: [{ $hour: "$created_timestamp" }, 3] } }, // 0-7 (3-hour buckets)
          dow: { $dayOfWeek: "$created_timestamp" }, // 1=Sun..7=Sat
        },
        count: { $sum: 1 },
      },
    },
  ]).toArray();
  // dayOfWeek: 1=Sunday → map to col index: จ(1)=Mon..อา(7)=Sun
  // MongoDB dayOfWeek: 1=Sun, 2=Mon, ..., 7=Sat
  // cols = [จ, อ, พ, พฤ, ศ, ส, อา] = [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
  const dowToCol = (dow: number): number => {
    // Mon=2→0, Tue=3→1, Wed=4→2, Thu=5→3, Fri=6→4, Sat=7→5, Sun=1→6
    const map: Record<number, number> = { 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 1: 6 };
    return map[dow] ?? 0;
  };
  const heatmapValues = Array.from({ length: 8 }, () => Array.from({ length: 7 }, () => 0));
  for (const h of heatmapAgg) {
    const row = h._id.hour; // 0-7
    const col = dowToCol(h._id.dow);
    if (row >= 0 && row < 8 && col >= 0 && col < 7) {
      heatmapValues[row][col] = h.count;
    }
  }

  const spark = conversationsPerDay.map((v, i) => ({ date: dayLabels[i], value: v }));

  const overview = {
    new_vs_existing: { new: newCustomers, existing: existingCustomers },
    conversations: { value: totals.total, spark },
    unanswered_12h: { value: unanswered12h, spark },
    response_rate_12h: { value: responseRate12h, spark },
    response_rate_10min: { value: responseRate10min, spark },
    avg_response_time_seconds: { value: avgResponseTimeSeconds, spark },
    messages_received: { value: messagesReceived, spark },
    messages_sent: { value: messagesSent, spark },
  };

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
    has_real_data: totals.total > 0,
    range,
    connected_shops: shops.length,
    date_range_label: dateRangeLabel,
    compare_label: range === "daily" ? "7 วันที่แล้ว" : range === "monthly" ? "เดือนที่แล้ว" : range === "yearly" ? "ปีที่แล้ว" : "ทั้งหมด",
    overview,
    insight: {
      customers_by_channel: customersByChannel,
      unanswered_by_channel: customersByChannel,
      response_rate_12h_by_channel: customersByChannel,
      response_rate_10min_by_channel: customersByChannel,
      avg_response_time_by_channel: customersByChannel,
    },
    heatmap: {
      rows: ["0:00-3:00", "3:00-6:00", "6:00-9:00", "9:00-12:00", "12:00-15:00", "15:00-18:00", "18:00-21:00", "21:00-00:00"],
      cols: ["จ", "อ", "พ", "พฤ", "ศ", "ส", "อา"],
      values: heatmapValues,
    },
  });
}
