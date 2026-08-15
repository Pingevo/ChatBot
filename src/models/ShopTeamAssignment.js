const mongoose = require('mongoose');

// ใครดูร้านไหนได้บ้าง — ใช้เป็น pool ของโหมด equal_per_shop และเป็นสิทธิ์เข้าถึงร้าน
// ไม่ลบแถวทิ้งตอนถอดคนออก — set is_active=false + removed_by/removed_at ไว้ เพื่อเก็บประวัติทั้งหมด
// ถ้าเพิ่มกลับมาใหม่ให้สร้างแถวใหม่ (added_at ใหม่ = ต่อท้ายคิว)
const shopTeamAssignmentSchema = new mongoose.Schema({
  shop_id: { type: String, required: true, index: true },
  platform: { type: String, required: true }, // denormalize จาก Shop กันต้อง join ทุกครั้ง
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  role_on_shop: { type: String, enum: ['agent', 'lead'], default: 'agent' },
  is_active: { type: Boolean, default: true },
  added_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  added_at: { type: Date, default: Date.now },
  removed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  removed_at: { type: Date, default: null },
}, { timestamps: true });

shopTeamAssignmentSchema.index({ shop_id: 1, is_active: 1, added_at: 1 });
shopTeamAssignmentSchema.index({ shop_id: 1, user_id: 1, is_active: 1 });

module.exports = mongoose.model('ShopTeamAssignment', shopTeamAssignmentSchema);
