const mongoose = require('mongoose');

// เก็บการตั้งค่าระดับผู้ใช้ (theme เป็นหลักใน Phase 1)
// ⚠️ ตอนนี้ยังไม่มีระบบ login จริง — ใช้ user_id = 'admin' เป็น default ชั่วคราว
// พอมีระบบ auth ทีหลังค่อยผูก user_id จริง (megaplan ข้อ 11/ภายหลัง)
const userSettingSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true, index: true },
  theme: { type: String, default: 'blue' }, // ชื่อ theme preset (ดู THEMES ใน style.css)
  mode: { type: String, enum: ['light', 'gray', 'dark'], default: 'light' }, // 3 โหมดตาม modeTokens ใน template
  updated_at: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('UserSetting', userSettingSchema);
