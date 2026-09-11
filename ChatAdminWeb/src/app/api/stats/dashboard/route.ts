// GET /api/stats/dashboard — top-line KPI cards + daily trend + platform/topic breakdown.
// Phase 4: ใช้ MongoDB aggregation สด แทน load-all + filter ใน memory
// Query: range = daily (default) | weekly | monthly | yearly | all
import { NextRequest } from "next/server";
import { requirePageAccess } from "@/backend/middleware/authorize";
import { json } from "@/backend/lib/http";
import { getCollection, COLLECTIONS } from "@/backend/db/mongoClient";
import { computeResponseStats } from "@/backend/lib/responseStats";

// ⚡ ป้องกัน Next.js cache — ต้องดึงข้อมูลสดทุกครั้ง
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ⚡ in-process cache: กันโหลดซ้ำในช่วงเวลาเดียวกัน (TTL 60s)
//   ลด load ตอน user สลับ tab ไปกลับ หรือ refresh รัวๆ
interface CacheEntry { data: unknown; ts: number; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000; // 60 วินาที

function getBounds(range: string): { start: Date | null; end: Date | null } {
  const now = new Date();
  if (range === "all") return { start: null, end: null };
  if (range === "weekly") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    return { start, end: now };
  }
  if (range === "monthly") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
  }
  if (range === "yearly") {
    return { start: new Date(now.getFullYear(), 0, 1), end: now };
  }
  // daily — วันนี้ 00:00 ถึง ตอนนี้
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return { start, end: now };
}

export async function GET(req: NextRequest) {
  const r = await requirePageAccess(req, "dashboard");
  if (!r.ok) return r.response;

  const url = new URL(req.url);
  const range = url.searchParams.get("range") || "daily";
  const customStart = url.searchParams.get("start_date");
  const customEnd = url.searchParams.get("end_date");

  // ⚡ cache key — รวม range + custom dates
  const cacheKey = `${range}|${customStart || ""}|${customEnd || ""}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return json(cached.data);
  }

  // ถ้ามี custom date ให้ใช้แทน range
  // ⚡ สร้าง Date จาก "YYYY-MM-DD" โดยตรง ไม่ใช้ new Date(string) เพราะมัน parse เป็น UTC midnight
  // แล้ว setHours ใช้ local timezone → ผิด 1 วันใน timezone +7
  let start: Date | null;
  let end: Date | null;
  if (customStart) {
    // parse "YYYY-MM-DD" → local date 00:00
    const [sy, sm, sd] = customStart.split("-").map(Number);
    start = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
    if (customEnd) {
      const [ey, em, ed] = customEnd.split("-").map(Number);
      end = new Date(ey, em - 1, ed, 23, 59, 59, 999);
    } else {
      end = new Date(sy, sm - 1, sd, 23, 59, 59, 999);
    }
  } else {
    const bounds = getBounds(range);
    start = bounds.start;
    end = bounds.end;
  }

  // ⚡ debug log — เช็คว่า range ส่งมาถูกไหม + ช่วงเวลาที่คำนวณ
  console.log(`[dashboard] range=${range} customStart=${customStart || "-"} start=${start?.toISOString()} end=${end?.toISOString()}`);

  const convColl = await getCollection(COLLECTIONS.conversations);
  const msgColl = await getCollection(COLLECTIONS.messages);
  const ticketColl = await getCollection(COLLECTIONS.tickets);

  // ⚡ ใช้ last_message_timestamp แทน created_at
  //   - last_message_timestamp = วันที่ข้อความล่าสุด → นับแชทที่มี activity จริงในช่วงเวลานั้น
  //   - created_at = วันที่เริ่มแชทครั้งแรก → ไม่นับแชทเก่าที่ทักวันนี้
  //   - last_message_timestamp มี index อยู่แล้ว → เร็วกว่า created_at (ไม่มี index)
  const TS_FIELD = "last_message_timestamp";
  const dateFilter = (field: string = TS_FIELD) => {
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
      { $match: { ...dateFilter() } },
      { $group: { _id: "$platform", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    // 2a. Topic breakdown — conversations
    convColl.aggregate<{ _id: string; count: number }>([
      { $match: { ...dateFilter(), topic: { $exists: true, $nin: [null, ""] } } },
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
    //    ⚡ จำกัดเป็น 30 วันล่าสุดเสมอ แม้ range=all → กันโหลด 1.1M messages เข้า memory
    //       (response time เฉลี่ย 30 วันล่าสุด พอเป็นตัวแทน ไม่ต้องย้อนไปตั้งแต่ 2020)
    (() => {
      const rsEnd = end || new Date();
      const rsStart = new Date(rsEnd);
      rsStart.setDate(rsStart.getDate() - 30);
      // ถ้า range แคบกว่า 30 วัน (daily/weekly) → ใช้ range เดิม
      const finalStart = start && start > rsStart ? start : rsStart;
      return computeResponseStats(msgColl, { start: finalStart, end: rsEnd });
    })(),
    // 4. Total conversations
    convColl.countDocuments({ ...dateFilter() }),
    // 5. ปิดแล้ว = มี closed_at หรือ status=closed/resolved (sellcenter อาจเขียน status แต่ไม่เขียน closed_at)
    convColl.countDocuments({
      $or: [
        { closed_at: { $exists: true, $ne: null } },
        { status: { $in: ["closed", "resolved"] } },
      ],
      ...dateFilter(),
    }),
    // 6. กำลังตอบอยู่ = มี assigned_to และไม่มี closed_at และ status ไม่ใช่ closed/resolved
    convColl.countDocuments({
      assigned_to: { $exists: true, $nin: [null, ""] },
      closed_at: { $in: [null, undefined] },
      status: { $nin: ["closed", "resolved"] },
      ...dateFilter(),
    }),
    // 7. บอทตอบ = ไม่มี assigned_to และไม่มี closed_at และ status ไม่ใช่ closed/resolved
    convColl.countDocuments({
      assigned_to: { $in: [null, undefined, ""] },
      closed_at: { $in: [null, undefined] },
      status: { $nin: ["closed", "resolved"] },
      ...dateFilter(),
    }),
    // 8. Unread conversations (unread_count > 0)
    convColl.countDocuments({ unread_count: { $gt: 0 }, ...dateFilter() }),
    // 9. Message counts (user in / admin out)
    Promise.all([
      msgColl.countDocuments({ role: "user", direction: "in", ...dateFilter("created_timestamp") }),
      msgColl.countDocuments({ role: { $in: ["admin", "bot"] }, direction: "out", ...dateFilter("created_timestamp") }),
    ]),
  ]);

  const total = totalConv;
  const [messagesReceived, messagesSent] = msgCounts;

  // ⚡ debug log ผลลัพธ์ KPI หลัก
  console.log(`[dashboard] totalConv=${totalConv} messagesReceived=${messagesReceived} messagesSent=${messagesSent}`);

  const topicMap = new Map<string, number>();
  for (const t of convTopics) topicMap.set(t._id, (topicMap.get(t._id) || 0) + t.count);
  for (const t of ticketTopics) topicMap.set(t._id, (topicMap.get(t._id) || 0) + t.count);

  // 4. Daily trend — count of CONVERSATIONS with activity per day (by last_message_timestamp)
  //    ⚡ ใช้ last_message_timestamp แทน created_at → นับแชทที่มี activity จริงในวันนั้น
  //       (รวมแชทเก่าที่ลูกค้าทักวันนี้) + ใช้ index ที่มีอยู่แล้ว
  let dailyTrend: { date: string; count: number }[] = [];
  if (range === "daily") {
    // รายวัน — โชว์แค่วันที่เลือก (1 แท่ง) ใช้ start/end ที่คำนวณแล้ว
    const dayCount = await convColl.countDocuments({
      last_message_timestamp: { $gte: start as Date, $lt: end as Date },
    });
    dailyTrend = [{
      date: (start as Date).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short" }),
      count: dayCount,
    }];
  } else if (range === "weekly") {
    // รายสัปดาห์ — แยกตามวัน ใช้ timezone Asia/Bangkok
    const sevenDaysAgo = start || new Date(Date.now() - 7 * 86400000);
    const dailyAgg = await convColl.aggregate<{ _id: { year: number; month: number; day: number }; count: number }>([
      { $match: { last_message_timestamp: { $gte: sevenDaysAgo, ...(end ? { $lt: end } : {}) } } },
      {
        $group: {
          _id: {
            year: { $year: { date: "$last_message_timestamp", timezone: "Asia/Bangkok" } },
            month: { $month: { date: "$last_message_timestamp", timezone: "Asia/Bangkok" } },
            day: { $dayOfMonth: { date: "$last_message_timestamp", timezone: "Asia/Bangkok" } },
          },
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
    // แยกตามวันในเดือน — นับ conversation ที่มี activity (timezone Asia/Bangkok)
    const monthStart = start || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const dailyAgg = await convColl.aggregate<{ _id: { day: number }; count: number }>([
      { $match: { last_message_timestamp: { $gte: monthStart, ...(end ? { $lt: end } : {}) } } },
      { $group: { _id: { day: { $dayOfMonth: { date: "$last_message_timestamp", timezone: "Asia/Bangkok" } } }, count: { $sum: 1 } } },
      { $sort: { "_id.day": 1 } },
    ]).toArray();
    dailyTrend = dailyAgg.map((d) => ({ date: `${d._id.day}`, count: d.count }));
  } else if (range === "yearly") {
    // แยกตามเดือนในปี — นับ conversation ที่มี activity (timezone Asia/Bangkok)
    const yearStart = start || new Date(new Date().getFullYear(), 0, 1);
    const monthlyAgg = await convColl.aggregate<{ _id: { month: number }; count: number }>([
      { $match: { last_message_timestamp: { $gte: yearStart, ...(end ? { $lt: end } : {}) } } },
      { $group: { _id: { month: { $month: { date: "$last_message_timestamp", timezone: "Asia/Bangkok" } } }, count: { $sum: 1 } } },
      { $sort: { "_id.month": 1 } },
    ]).toArray();
    const monthNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    dailyTrend = monthlyAgg.map((d) => ({ date: monthNames[d._id.month - 1], count: d.count }));
  } else {
    // all — แยกตามปี — นับ conversation ที่มี activity
    const yearlyAgg = await convColl.aggregate<{ _id: { year: number }; count: number }>([
      { $match: {} },
      { $group: { _id: { year: { $year: "$last_message_timestamp" } }, count: { $sum: 1 } } },
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
    // ⚡ debug — ลบทิ้งภายหลัง
    _debug: {
      range,
      customStart: customStart || null,
      start: start?.toISOString() || null,
      end: end?.toISOString() || null,
      totalConv,
      messagesReceived,
      messagesSent,
    },
  });

  // ⚡ cache result 60s — ลด load ตอน user สลับ tab/refresh รัวๆ
  const result = {
    has_real_data: hasRealData,
    range,
    total_conversations: total,
    bot_answered: botAnsweredCount,
    with_admin: withAdminCount,
    closed: closedCount,
    unread_count: unreadCount,
    messages_received: messagesReceived,
    messages_sent: messagesSent,
    avg_response_time: avgResponseTime,
    platform_breakdown: platformBreakdown.map((p) => ({ platform: p._id || "unknown", count: p.count })),
    topic_breakdown: Array.from(topicMap.entries()).map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    daily_trend: dailyTrend,
    _debug: {
      range,
      customStart: customStart || null,
      start: start?.toISOString() || null,
      end: end?.toISOString() || null,
      totalConv,
      messagesReceived,
      messagesSent,
      cached: false,
    },
  };
  cache.set(cacheKey, { data: result, ts: Date.now() });
  // ⚡ กัน cache โตไม่จำกัด — เก็บแค่ 20 key ล่าสุด
  if (cache.size > 20) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return json(result);
}
