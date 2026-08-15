const mongoose = require('mongoose');

// staff account ของ chat-center — auth ผ่าน SSO system81 (sellcenter) เท่านั้น ไม่มี password ของตัวเอง
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  nickname: { type: String }, // ชื่อเล่นภาษาไทย จาก dbWallet.Users.nickname — ใช้แสดงผลแทน name เต็ม
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  system81_username: { type: String, unique: true, sparse: true, trim: true },
  department: { type: String },
  position: { type: String },
  role: { type: String, enum: ['staff', 'lead', 'admin'], default: 'staff' },
  isDeleted: { type: Boolean, default: false },
  last_login_at: { type: Date },

  // ===== ระบบแบ่งงานแชท (round-robin) — ดู services/chatAssignment.js =====
  isActiveAgent: { type: Boolean, default: true }, // false = ไม่รับแชทใหม่ชั่วคราว (พักเอง หรือระบบสั่งพักเพราะไม่มี heartbeat)
  last_seen_at: { type: Date, default: null },     // อัปเดตจาก POST /api/presence/ping ตอน agent เปิดหน้า inbox ค้างไว้
  paused_by: { type: String, enum: ['user', 'system', null], default: null }, // แยกพักเอง vs ระบบสั่งพัก กัน auto-resume ไปเปิดคิวคืนให้คนที่ตั้งใจพัก
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
