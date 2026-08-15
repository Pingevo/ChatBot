const mongoose = require('mongoose');

// เก็บ "คนล่าสุดที่ได้งาน" ไว้ 1 ค่าต่อคิว — pool_key แยกตามโหมด:
// 'global' | `shop:<shop_id>` | `platform:<platform>`
// จ่ายครั้งถัดไปวิ่งหาคนถัดไปในลำดับต่อจากนี้ (round-robin ล้วนๆ ไม่ดูภาระงาน — ดู services/chatAssignment.js)
const assignmentCursorSchema = new mongoose.Schema({
  pool_key: { type: String, required: true, unique: true },
  last_assigned_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('AssignmentCursor', assignmentCursorSchema);
