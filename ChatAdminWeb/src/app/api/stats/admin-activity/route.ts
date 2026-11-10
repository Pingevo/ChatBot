// GET /api/stats/admin-activity — "การทำงานของแอดมิน" — Zaapi-style overview
// Phase 4: ใช้ MongoDB aggregation สด
// Query: range = daily | weekly (default page) | monthly | yearly | all | custom dates
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { auth } from "@/backend/service/authService";
import { shopService } from "@/backend/service/shopService";
import { computeResponseStats } from "@/backend/lib/responseStats";

import {
  parseStatsRange, statsSeries,
  statsRangeLabel, statsCompareLabel,
} from "@/backend/lib/statsRange";


export async function GET(req: NextRequest) {
  const r = await requirePageAccess(req, "analytics");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const range = url.searchParams.get("range") || "daily";
  const customStart = url.searchParams.get("start_date");
  const customEnd = url.searchParams.get("end_date");

  const { start: weekStart, end: weekEnd } =
    parseStatsRange(range, customStart, customEnd);
  const series = statsSeries(range, weekStart, weekEnd);

  const convColl = await getCollection(COLLECTIONS.conversations);
  const msgColl = await getCollection(COLLECTIONS.messages);
  const statusColl = await getCollection(COLLECTIONS.statusConversation);
  const [admins, shops] = await Promise.all([
    auth.listAdmins(),
    shopService.listShops(),
  ]);

  const adminMap = new Map(admins.map((a) => [a.admin_id, a]));

  // chart slots derive จาก bounds — all → data-driven years
  let slots = series.slots;
  if (!slots.length) {
    const yearsAgg = await convColl.aggregate<{ _id: number }>([
      { $group: { _id: { $year: { date: "$created_at", timezone: "Asia/Bangkok" } } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    slots = yearsAgg.map((y) => ({ key: `${y._id}`, label: `${y._id + 543}` }));
  }

  const dateFilter = (field: string) => {
    const f: Record<string, unknown> = {};
    if (weekStart) f.$gte = weekStart;
    if (weekEnd) f.$lt = weekEnd;
    return Object.keys(f).length ? { [field]: f } : {};
  };

  // ownership อ่านจาก status_conversation เท่านั้น
  //   (raw conversations(_shp).status="open" ทั้งหมด + assigned_to/closed_at ถูก dump ทับ)
  //   - handled per admin = meta.assigned_to ∩ in-range convs (รวม closed ที่ค้าง owner = activity history)
  //   - closed = meta status ∈ {closed,resolved}
  //   bounded: meta-driven $lookup (assigned_to index → unique conversation_id index)
  //   group by owner×status + push created_at สำหรับ per-day series — ไม่มี find({}) / full conv load
  const convJoin = [
    { $lookup: { from: COLLECTIONS.conversations, localField: "conversation_id", foreignField: "conversation_id", as: "conv" } },
    { $unwind: "$conv" },
  ];
  const convCreatedCond = dateFilter("created_at").created_at as Record<string, unknown> | undefined;
  const convJoinMatch = convCreatedCond ? { "conv.created_at": convCreatedCond } : {};
  const [ownerAgg, closedInRangeAgg, overallConv] = await Promise.all([
    statusColl.aggregate<{ _id: { o: string | null; s: string | null }; n: number; dates: Date[] }>([
      { $match: { assigned_to: { $exists: true, $nin: [null, ""] } } },
      ...convJoin,
      ...(Object.keys(convJoinMatch).length ? [{ $match: convJoinMatch }] : []),
      { $group: { _id: { o: "$assigned_to", s: "$status" }, n: { $sum: 1 }, dates: { $push: "$conv.created_at" } } },
    ]).toArray(),
    statusColl.aggregate<{ n: number }>([
      { $match: { status: { $in: ["closed", "resolved"] } } },
      ...convJoin,
      ...(Object.keys(convJoinMatch).length ? [{ $match: convJoinMatch }] : []),
      { $count: "n" },
    ]).toArray(),
    convColl.countDocuments({ ...dateFilter("created_at") }),
  ]);
  const overallClosed = closedInRangeAgg[0]?.n || 0;

  // pivot owner×status → per-admin handled/resolved/unanswered + created dates
  //   resolved   = {closed,resolved,bot}   (ตอบ/ปิดแล้ว — retained owner = activity history)
  //   unanswered = {handoff,open,pending}  (non-closed human-owned — รวม open+no-owner case)
  const perOwner = new Map<string, { total: number; resolved: number; unanswered: number; dates: Date[] }>();
  for (const g of ownerAgg) {
    const owner = g._id.o;
    if (!owner) continue;
    const e = perOwner.get(owner) || { total: 0, resolved: 0, unanswered: 0, dates: [] };
    e.total += g.n;
    const s = g._id.s;
    if (s === "closed" || s === "resolved" || s === "bot") e.resolved += g.n;
    else if (s === "handoff" || s === "open" || s === "pending") e.unanswered += g.n;
    e.dates.push(...g.dates);
    perOwner.set(owner, e);
  }

  // 1. Top handled admins (by owned conversation count in range)
  const topAdminIds = [...perOwner.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10)
    .map(([id]) => id);

  // 2. Conversations by admin per slot — bucket ใน JS จาก in-range dates ของ meta owner
  const conversationsByAdminPerDay: Record<string, unknown>[] = slots.map((s) => ({ date: s.label }));
  for (const adminId of topAdminIds) {
    const name = adminMap.get(adminId)?.name || adminId;
    const map = new Map<string, number>();
    for (const d of perOwner.get(adminId)?.dates || []) {
      const key = series.keyOf(d);
      map.set(key, (map.get(key) || 0) + 1);
    }
    slots.forEach((s, idx) => {
      conversationsByAdminPerDay[idx][name] = map.get(s.key) || 0;
    });
  }

  // 3. Individual performance — ⚡ parallel aggregation + ใช้ helper แทน $lookup ต่อ admin
  //    คำนวณ response stats ครั้งเดียว (ไม่ใช่ 2 $lookup ต่อ admin)
  const [responseStats, ...perfAggs] = await Promise.all([
    computeResponseStats(msgColl, { start: weekStart, end: weekEnd, adminOnly: true }),
    // ⚡ per-admin perf — partition บน meta status (raw conv.status = "open" เสมอ ใช้ไม่ได้)
    ...admins.map(async (a) => {
      const p = perOwner.get(a.admin_id);
      return { admin: a, perf: { total: p?.total || 0, resolved: p?.resolved || 0, unanswered: p?.unanswered || 0 } };
    }),
  ]);

  const individualPerformance = perfAggs.map(({ admin: a, perf }) => {
    const adminStats = responseStats.perAdmin.get(a.admin_id);
    const avgSeconds = adminStats?.avgSeconds ? Math.round(adminStats.avgSeconds) : 0;
    // ⚡ rate = within10min turns / admin's answered turns — population เดียวกัน (≤100)
    const responseRate10min = adminStats?.total
      ? Math.round((adminStats.within10min / adminStats.total) * 1000) / 10
      : 0;
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

  // ⚠️ ถ้าไม่มี assigned admins ให้ดึง overall stats จาก messages
  // เพื่อให้หน้า admin-activity ยังแสดงข้อมูลรวมได้
  //   ⚡ overall closed = meta closed ∩ in-range (raw closed_at ถูก dump ทับ ใช้ไม่ได้)
  const [overallMsgsIn, overallMsgsOut] = await Promise.all([
    msgColl.countDocuments({ role: "user", direction: "in", ...dateFilter("created_timestamp") }),
    msgColl.countDocuments({ role: { $in: ["admin", "bot"] }, direction: "out", ...dateFilter("created_timestamp") }),
  ]);
  // overallConv / overallClosed — จาก Promise.all ข้างบน (countDocuments + meta-closed agg)

  const dateRangeLabel = statsRangeLabel(range, weekStart, weekEnd, slots.length);

  return json({
    has_real_data: overallConv > 0 || totalConversations > 0,
    range,
    connected_shops: shops.length,
    date_range_label: dateRangeLabel,
    compare_label: statsCompareLabel(range),
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
