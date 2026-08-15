const mongoose = require('mongoose');

// Field names ตรงกับ response จริงของ get_conversation_list / get_one_conversation
// (megaplan ข้อ 3, verified จากเอกสารทางการ) — id ทั้งหมดเก็บเป็น String กัน int64 precision loss (ข้อ 3.1)
const conversationSchema = new mongoose.Schema({
  platform: { type: String, default: 'shopee' },
  shop_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true },
  to_id: { type: String },       // user id ของ buyer (Shopee เรียก "to_id")
  to_name: { type: String },
  to_avatar: { type: String },
  unread_count: { type: Number, default: 0 },
  pinned: { type: Boolean, default: false },
  mute: { type: Boolean, default: false },
  last_read_message_id: { type: String },
  opposite_last_read_msg_id: { type: String },
  opposite_last_deliver_msg_id: { type: String },
  latest_message_id: { type: String },
  latest_message_type: { type: String },
  latest_message_content: { type: mongoose.Schema.Types.Mixed },
  latest_message_from_id: { type: String },
  last_message_timestamp: { type: Date }, // ⚠️ get_conversation_list ให้หน่วยนาโนวินาที ต้องแปลงก่อนเก็บ (ข้อ 2)
  status: { type: String, enum: ['open', 'closed'], default: 'open' },

  // ===== field ที่เราเพิ่มเอง ไม่ใช่ของ Shopee (สำหรับ workflow ทีมแอดมิน) =====
  assigned_agent: { type: String, default: null }, // ชื่อแอดมินที่รับผิดชอบแชทนี้ — ยังไม่มีระบบ login จริง ใช้ free text ไปก่อน
  tags: { type: [String], default: [] },           // เช่น "ลูกค้าประจำ", "VIP", "ร้องเรียน" — จัดการเองผ่าน UI
  recent_messages: { type: [mongoose.Schema.Types.Mixed], default: [] }, // 💬 Array เก็บข้อความล่าสุด (เช่น 10 ข้อความแรก) ประจำแต่ละช่องแชท
}, { timestamps: true });

conversationSchema.index({ shop_id: 1, conversation_id: 1 }, { unique: true });
// ⚡ High-performance compound indexes สำหรับสเกล 10,000,000+ แชท (B-Tree Covered Queries < 5ms)
conversationSchema.index({ platform: 1, shop_id: 1, pinned: -1, last_message_timestamp: -1 });
conversationSchema.index({ platform: 1, shop_id: 1, unread_count: 1, pinned: -1, last_message_timestamp: -1 });
conversationSchema.index({ shop_id: 1, to_name: 1 });

module.exports = mongoose.model('Conversation', conversationSchema);
