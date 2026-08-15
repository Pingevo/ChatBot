const ChatTurnMetric = require('../models/ChatTurnMetric');
const AgentDailyStats = require('../models/AgentDailyStats');
const User = require('../models/User');

// โปรเจกต์นี้ทำงานกับทีมในไทย — รวมเป็นวันตามเวลา Bangkok (UTC+7) เสมอ ไม่ใช่ UTC ของ server
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function bangkokDayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function bangkokDateStr(date = new Date()) {
  const bkk = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  return bkk.toISOString().slice(0, 10);
}

function listDateStrings(fromStr, toStr) {
  const dates = [];
  let cursor = new Date(`${fromStr}T00:00:00+07:00`);
  const end = new Date(`${toStr}T00:00:00+07:00`);
  while (cursor <= end) {
    dates.push(bangkokDateStr(cursor));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

// คำนวณ rollup ของวันเดียว — idempotent (เรียกซ้ำได้ ผลลัพธ์เดิม) ใช้ทั้งจาก cron รายวันและตอนขอรายงานสด
async function computeDailyStatsForDate(dateStr) {
  const { start, end } = bangkokDayRange(dateStr);

  const rows = await ChatTurnMetric.aggregate([
    { $match: { customer_message_at: { $gte: start, $lt: end }, agent_id: { $ne: null } } },
    {
      $group: {
        _id: '$agent_id',
        messages_received: { $sum: 1 },
        messages_replied: { $sum: { $cond: [{ $eq: ['$status', 'replied'] }, 1, 0] } },
        unopened_count: { $sum: { $cond: [{ $eq: ['$opened_at', null] }, 1, 0] } },
        total_read_delay_seconds: { $sum: { $ifNull: ['$read_delay_seconds', 0] } },
        read_delay_sample_count: { $sum: { $cond: [{ $ne: ['$read_delay_seconds', null] }, 1, 0] } },
        total_response_time_seconds: { $sum: { $ifNull: ['$response_time_seconds', 0] } },
        response_time_sample_count: { $sum: { $cond: [{ $ne: ['$response_time_seconds', null] }, 1, 0] } },
      },
    },
  ]);

  await Promise.all(rows.map((row) =>
    AgentDailyStats.findOneAndUpdate(
      { user_id: row._id, date: dateStr },
      {
        $set: {
          messages_received: row.messages_received,
          messages_replied: row.messages_replied,
          unopened_count: row.unopened_count,
          total_read_delay_seconds: row.total_read_delay_seconds,
          read_delay_sample_count: row.read_delay_sample_count,
          total_response_time_seconds: row.total_response_time_seconds,
          response_time_sample_count: row.response_time_sample_count,
        },
      },
      { upsert: true }
    )
  ));

  return rows.length;
}

// รายงานรายสัปดาห์/รายเดือน — คำนวณ rollup ของทุกวันในช่วงใหม่ก่อนเสมอ (เผื่อ cron ยังไม่ทันรัน หรือขอวันนี้ที่ยังไม่จบวัน)
// ปริมาณข้อมูลระดับทีมภายในองค์กร คำนวณสดแบบนี้เร็วพอ ไม่จำเป็นต้องพึ่ง cron อย่างเดียว
async function getKpiSummary({ from, to, userId = null }) {
  const dates = listDateStrings(from, to);
  await Promise.all(dates.map((d) => computeDailyStatsForDate(d)));

  const match = { date: { $in: dates } };
  if (userId) match.user_id = userId;

  const rows = await AgentDailyStats.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$user_id',
        messages_received: { $sum: '$messages_received' },
        messages_replied: { $sum: '$messages_replied' },
        unopened_count: { $sum: '$unopened_count' },
        total_read_delay_seconds: { $sum: '$total_read_delay_seconds' },
        read_delay_sample_count: { $sum: '$read_delay_sample_count' },
        total_response_time_seconds: { $sum: '$total_response_time_seconds' },
        response_time_sample_count: { $sum: '$response_time_sample_count' },
      },
    },
  ]);

  const users = await User.find({ _id: { $in: rows.map((r) => r._id) } }).select('name nickname').lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  return rows
    .map((r) => {
      const user = userMap.get(String(r._id));
      return {
        user_id: r._id,
        name: user ? (user.nickname || user.name) : 'ไม่ทราบชื่อ',
        messages_received: r.messages_received,
        messages_replied: r.messages_replied,
        unopened_count: r.unopened_count,
        avg_read_delay_seconds: r.read_delay_sample_count > 0 ? Math.round(r.total_read_delay_seconds / r.read_delay_sample_count) : null,
        avg_response_time_seconds: r.response_time_sample_count > 0 ? Math.round(r.total_response_time_seconds / r.response_time_sample_count) : null,
      };
    })
    .sort((a, b) => b.messages_received - a.messages_received);
}

module.exports = { computeDailyStatsForDate, getKpiSummary, bangkokDateStr, bangkokDayRange, listDateStrings };
