const mongoose = require('mongoose');

// rollup รายวันต่อ agent — คำนวณจาก ChatTurnMetric โดย workers/assignmentWatchdog.js (idempotent, คำนวณซ้ำได้)
// เก็บเป็นผลรวม (sum) + จำนวนตัวอย่าง (count) แทนค่าเฉลี่ยสำเร็จรูป เพื่อให้รวมข้ามหลายวัน (รายสัปดาห์/รายเดือน) ได้ถูกต้อง
const agentDailyStatsSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: String, required: true, index: true }, // 'YYYY-MM-DD' (Asia/Bangkok)

  messages_received: { type: Number, default: 0 },
  messages_replied: { type: Number, default: 0 },
  unopened_count: { type: Number, default: 0 }, // จำนวนรอบที่ไม่เคยเปิดอ่านเลยจนตอบ (หรือจนโดน SLA จับ)

  total_read_delay_seconds: { type: Number, default: 0 },
  read_delay_sample_count: { type: Number, default: 0 },

  total_response_time_seconds: { type: Number, default: 0 },
  response_time_sample_count: { type: Number, default: 0 },
}, { timestamps: true });

agentDailyStatsSchema.index({ user_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('AgentDailyStats', agentDailyStatsSchema);
