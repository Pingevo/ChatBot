const mongoose = require('mongoose');

// Singleton (มีแค่ 1 doc) — คุมว่าตอนแชทใหม่เข้า จะหมุนคิว agent ยังไง
// เปลี่ยนค่านี้แล้วมีผลกับแชทใหม่ทันที ไม่ต้อง deploy — วิธีเลือกคนในคิวเป็น round-robin ตายตัวเสมอ (ดู services/chatAssignment.js)
const assignmentConfigSchema = new mongoose.Schema({
  mode: {
    type: String,
    enum: ['equal_global', 'equal_per_shop', 'equal_per_platform'],
    default: 'equal_global',
  },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('AssignmentConfig', assignmentConfigSchema);
