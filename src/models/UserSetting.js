const mongoose = require('mongoose');

// เก็บการตั้งค่าระดับผู้ใช้ (theme เป็นหลักใน Phase 1) — ผูกกับ User._id จริงจาก session
const userSettingSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true, index: true },
  theme: { type: String, default: 'blue' }, // ชื่อ theme preset (ดู THEMES ใน style.css)
  mode: { type: String, enum: ['light', 'gray', 'dark'], default: 'light' }, // 3 โหมดตาม modeTokens ใน template
  updated_at: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('UserSetting', userSettingSchema);
