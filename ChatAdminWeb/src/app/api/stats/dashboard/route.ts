// GET /api/stats/dashboard — top-line KPI cards + daily trend + platform/topic breakdown.
// Phase 4: ใช้ MongoDB aggregation สด แทน load-all + filter ใน memory
// Query: range = daily (default) | monthly | yearly | all
import { NextRequest } from "next/server";
import { requireAuth } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
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
  // daily — 7 วันล่าสุด
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

  // ถ้ามี custom date ให้ใช้แทน range
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
  const msgColl = await getCollection(COLLECTIONS.messages);
  const ticketColl = await getCollection(COLLECTIONS.tickets);

  // date filter helper
  const dateFilter = (field: string) => {
    const f: Record<string, unknown> = {};
    if (start) f.$gte = start;
    if (end) f.$lt = end;
    return Object.keys(f).length ? { [field]: f } : {};
  };

  // ⚡ parallel — รัน aggregation ทั้งหมดพร้อมกัน + ใช้ helper แทน $lookup
  // ⚠️ sellcenter ไม่เขียน status → ใช้ derived counts แทน:
  //   บอทตอบ = ไม่มี assigned_to และไม่มี closed_at
  //   กำลังตอบอยู่ (ส่งแอดมิน) = มี assigned_to และไม่มี closed_at
  //   ปิดแล้ว = มี closed_at
  const [platformBreakdown, convTopics, ticketTopics, responseStats, totalConv, closedCount, withAdminCount, botAnsweredCount, unreadCount, msgCounts] = await Promise.all([
    // 1. Platform breakdown
    convColl.aggregate<{ _id: string; count: number }>([
      { $match: { ...dateFilter("created_at") } },
      { $group: { _id: "$platform", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    // 2a. Topic breakdown — conversations
    convColl.aggregate<{ _id: string; count: number }>([
      { $match: { ...dateFilter("created_at"), topic: { $exists: true, $nin: [null, ""] } } },
      { $group: { _id: "$topic", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]).toArray(),
    // 2b. Topic breakdown — tickets
    ticketColl.aggregate<{ _id: string; count: number }>([
      { $match: { ...dateFilter("created_at"), topic: { $exists: true, $nin: [null, ""] }, is_deleted: { $ne: true } } },
      { $group: { _id: "$topic", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]).toArray(),
    // 3. Avg response time — ใช้ helper แทน $lookup
    computeResponseStats(msgColl, { start, end }),
    // 4. Total conversations
    convColl.countDocuments({ ...dateFilter("created_at") }),
    // 5. ปิดแล้ว = มี closed_at หรือ status=closed/resolved (sellcenter อาจเขียน status แต่ไม่เขียน closed_at)
    convColl.countDocuments({
      $or: [
        { closed_at: { $exists: true, $ne: null } },
        { status: { $in: ["closed", "resolved"] } },
      ],
      ...dateFilter("created_at"),
    }),
    // 6. กำลังตอบอยู่ = มี assigned_to และไม่มี closed_at และ status ไม่ใช่ closed/resolved
    convColl.countDocuments({
      assigned_to: { $exists: true, $nin: [null, ""] },
      closed_at: { $in: [null, undefined] },
      status: { $nin: ["closed", "resolved"] },
      ...dateFilter("created_at"),
    }),
    // 7. บอทตอบ = ไม่มี assigned_to และไม่มี closed_at และ status ไม่ใช่ closed/resolved
    convColl.countDocuments({
      assigned_to: { $in: [null, undefined, ""] },
      closed_at: { $in: [null, undefined] },
      status: { $nin: ["closed", "resolved"] },
      ...dateFilter("created_at"),
    }),
    // 8. Unread conversations (unread_count > 0)
    convColl.countDocuments({ unread_count: { $gt: 0 }, ...dateFilter("created_at") }),
    // 9. Message counts (user in / admin out)
    Promise.all([
      msgColl.countDocuments({ role: "user", direction: "in", ...dateFilter("created_timestamp") }),
      msgColl.countDocuments({ role: { $in: ["admin", "bot"] }, direction: "out", ...dateFilter("created_timestamp") }),
    ]),
  ]);

  const total = totalConv;
  const [messagesReceived, messagesSent] = msgCounts;

  const topicMap = new Map<string, number>();
  for (const t of convTopics) topicMap.set(t._id, (topicMap.get(t._id) || 0) + t.count);
  for (const t of ticketTopics) topicMap.set(t._id, (topicMap.get(t._id) || 0) + t.count);

  // 4. Daily trend — count of CONVERSATIONS created per day (not messages)
  //    เพราะ user ต้องการรายงาน conversation รายวัน (00:00-23:59 ของแต่ละวัน)
  let dailyTrend: { date: string; count: number }[] = [];
  if (range === "daily") {
    const sevenDaysAgo = start || new Date(Date.now() - 7 * 86400000);
    const dailyAgg = await convColl.aggregate<{ _id: { year: number; month: number; day: number }; count: number }>([
      { $match: { created_at: { $gte: sevenDaysAgo, ...(end ? { $lt: end } : {}) } } },
      {
        $group: {
          _id: { year: { $year: "$created_at" }, month: { $month: "$created_at" }, day: { $dayOfMonth: "$created_at" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]).toArray();
    const dailyMap = new Map<string, number>();
    for (const d of dailyAgg) dailyMap.set(`${d._id.year}-${d._id.month}-${d._id.day}`, d.count);
    for (let i = 6; i >= 0; i--) {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - i);
      const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
      dailyTrend.push({ date: day.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" }), count: dailyMap.get(key) || 0 });
    }
  } else if (range === "monthly") {
    // แยกตามวันในเดือน — นับ conversation
    const monthStart = start || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const dailyAgg = await convColl.aggregate<{ _id: { day: number }; count: number }>([
      { $match: { created_at: { $gte: monthStart, ...(end ? { $lt: end } : {}) } } },
      { $group: { _id: { day: { $dayOfMonth: "$created_at" } }, count: { $sum: 1 } } },
      { $sort: { "_id.day": 1 } },
    ]).toArray();
    dailyTrend = dailyAgg.map((d) => ({ date: `${d._id.day}`, count: d.count }));
  } else if (range === "yearly") {
    // แยกตามเดือนในปี — นับ conversation
    const yearStart = start || new Date(new Date().getFullYear(), 0, 1);
    const monthlyAgg = await convColl.aggregate<{ _id: { month: number }; count: number }>([
      { $match: { created_at: { $gte: yearStart, ...(end ? { $lt: end } : {}) } } },
      { $group: { _id: { month: { $month: "$created_at" } }, count: { $sum: 1 } } },
      { $sort: { "_id.month": 1 } },
    ]).toArray();
    const monthNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    dailyTrend = monthlyAgg.map((d) => ({ date: monthNames[d._id.month - 1], count: d.count }));
  } else {
    // all — แยกตามปี — นับ conversation
    const yearlyAgg = await convColl.aggregate<{ _id: { year: number }; count: number }>([
      { $match: {} },
      { $group: { _id: { year: { $year: "$created_at" } }, count: { $sum: 1 } } },
      { $sort: { "_id.year": 1 } },
    ]).toArray();
    dailyTrend = yearlyAgg.map((d) => ({ date: `${d._id.year + 543}`, count: d.count }));
  }

  // 5. Avg response time — ใช้ค่าจาก helper (คำนวณแล้วใน Promise.all ด้านบน)
  const avgResponseTime = responseStats.avgResponseSeconds
    ? Math.round(responseStats.avgResponseSeconds * 10) / 10
    : 0;

  const hasRealData = total > 0;

  return json({
    has_real_data: hasRealData,
    range,
    // สถานะ conversation (derived จากข้อมูลจริง)
    total_conversations: total,           // แชททั้งหมด
    bot_answered: botAnsweredCount,       // บอทตอบ (ไม่มี assigned_to, ไม่มี closed_at)
    with_admin: withAdminCount,           // กำลังตอบอยู่ (มี assigned_to, ไม่มี closed_at)
    closed: closedCount,                  // ปิดแล้ว (มี closed_at)
    unread_count: unreadCount,            // conversations ที่มี unread > 0
    // ข้อความ
    messages_received: messagesReceived,  // ข้อความที่ลูกค้าส่งเข้า
    messages_sent: messagesSent,          // ข้อความที่บอท/แอดมินตอบ
    // เวลาตอบเฉลี่ย (วินาที) — diff ระหว่าง user message กับ out message ถัดไป
    avg_response_time: avgResponseTime,
    // breakdown
    platform_breakdown: platformBreakdown.map((p) => ({ platform: p._id || "unknown", count: p.count })),
    topic_breakdown: Array.from(topicMap.entries()).map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    daily_trend: dailyTrend,
  });
}
