const mongoose = require('mongoose');

// 1 doc ต่อ "รอบที่ลูกค้าถามหนึ่งรอบ" — ใช้แยกให้ชัดว่า agent "เห็นแล้วไม่อ่าน" หรือ "อ่านแล้วไม่ตอบ"
// วงจร: ข้อความลูกค้าเข้า (pending) → agent เปิดแชท (opened_at) → agent ตอบ (replied)
// สร้าง/ปิดจาก services/chatMetrics.js เท่านั้น — เก็บ raw ไว้ให้ workers/assignmentWatchdog.js รวมเป็น AgentDailyStats รายวัน
const chatTurnMetricSchema = new mongoose.Schema({
  conversation_id: { type: String, required: true, index: true },
  shop_id: { type: String, required: true, index: true },
  platform: { type: String },
  agent_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }, // snapshot ของ assigned_to ตอนรอบนี้เปิด

  customer_message_id: { type: String },
  customer_message_at: { type: Date, required: true, index: true },

  opened_at: { type: Date, default: null },
  opened_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  first_reply_message_id: { type: String, default: null },
  first_reply_at: { type: Date, default: null },

  read_delay_seconds: { type: Number, default: null },     // opened_at - customer_message_at — null แปลว่ายังไม่เคยเปิด
  response_time_seconds: { type: Number, default: null },  // first_reply_at - customer_message_at

  status: { type: String, enum: ['pending', 'replied'], default: 'pending', index: true },

  // ===== SLA watchdog (workers/assignmentWatchdog.js) — กันแจ้งเตือน/โยกงานซ้ำทุกรอบ cron =====
  sla_alerted_at: { type: Date, default: null },
  sla_reassigned: { type: Boolean, default: false },
}, { timestamps: true });

chatTurnMetricSchema.index({ conversation_id: 1, status: 1 });
chatTurnMetricSchema.index({ agent_id: 1, customer_message_at: 1 });

module.exports = mongoose.model('ChatTurnMetric', chatTurnMetricSchema);
