const mongoose = require('mongoose');

// 👤 ตารางรวบรวมข้อมูลรายชื่อลูกค้า (Customer Directory)
// ดึงและรวบรวมข้อมูลลูกค้าอัตโนมัติจากทุกร้านและทุกการแชต
const customerSchema = new mongoose.Schema({
  platform: { type: String, default: 'shopee', index: true },
  buyer_id: { type: String, required: true, unique: true, index: true }, // to_id ของลูกค้า (Shopee Buyer User ID)
  name: { type: String, index: true },                                  // ชื่อลูกค้า (to_name)
  avatar: { type: String },                                             // ลิงก์รูปโปรไฟล์ (to_avatar)
  phone: { type: String, default: '' },                                 // เบอร์โทรศัพท์ (เพิ่มเองผ่าน UI แอดมิน)
  email: { type: String, default: '' },                                 // อีเมล
  shops: { type: [String], default: [] },                               // Array เก็บรายชื่อ shop_id ทั้งหมดที่ลูกค้ารายนี้เคยทัก
  conversations: { type: [String], default: [] },                       // Array เก็บ conversation_id ทั้งหมดของลูกค้าคนนี้
  total_conversations: { type: Number, default: 0 },                    // จำนวนห้องแชตทั้งหมด
  tags: { type: [String], default: [] },                                // ป้ายกำกับลูกค้า เช่น ['VIP', 'ลูกค้าประจำ', 'ส่งเคลม']
  notes: { type: String, default: '' },                                 // โน้ตความจำเกี่ยวกับลูกค้า
  last_active_at: { type: Date },                                       // ทักแชทเข้ามาล่าสุดเมื่อไหร่
}, { timestamps: true });

customerSchema.index({ platform: 1, buyer_id: 1 }, { unique: true });
// ⚡ Compound indexes สำหรับสเกลค้นหาลูกค้าระดับ 100,000,000+ ราย
customerSchema.index({ platform: 1, last_active_at: -1 });
customerSchema.index({ platform: 1, name: 1 });

module.exports = mongoose.model('Customer', customerSchema);
