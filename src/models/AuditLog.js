const mongoose = require('mongoose');

// append-only — ทุก action ที่กระทบการมอบหมายงาน/ทีม/สถานะ agent ไหลมาที่นี่ที่เดียว
// ใช้ตอบทั้ง "ใครมอบหมายให้ใคร", "ใครดูร้านไหนตอนไหน" และเป็นฐานคำนวณ KPI (ดู services/auditLog.js)
const auditLogSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: [
      'chat_assigned',        // ระบบ auto-assign (round-robin)
      'chat_reassigned',      // lead/admin ย้ายมือเอง
      'chat_closed', 'chat_reopened',
      'team_member_added', 'team_member_removed', 'team_role_changed',
      'assignment_config_changed',
      'agent_auto_paused', 'agent_auto_resumed',   // ไม่มี heartbeat / กลับมา ping
      'agent_manual_paused', 'agent_manual_resumed', // กดพัก/เปิดรับงานเอง (หรือ lead/admin กดแทน)
      'chat_sla_alert', 'chat_sla_reassigned',      // แชทค้างไม่มีคนตอบเกิน SLA
    ],
  },
  actor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }, // null = ระบบเป็นคนทำ
  actor_label: { type: String, default: 'system' }, // snapshot ชื่อไว้แสดงผลเร็วๆ ไม่ต้อง populate ทุกครั้ง
  conversation_id: { type: String, default: null, index: true },
  shop_id: { type: String, default: null, index: true },
  target_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }, // ผู้ถูกกระทำ เช่น ผู้รับงาน/ผู้ถูกถอดออกจากทีม
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  at: { type: Date, default: Date.now, index: true },
});

auditLogSchema.index({ type: 1, at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
