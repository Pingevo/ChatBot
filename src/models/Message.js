const mongoose = require('mongoose');

// Field names ตรงกับ response จริงของ v2.sellerchat.get_message (megaplan ข้อ 3)
// content เก็บแบบ Mixed เพราะ schema ต่างกันมากตาม message_type — อย่า flatten, เก็บ raw ตามที่ Shopee ส่งมา
const messageSchema = new mongoose.Schema({
  platform: { type: String, default: 'shopee' },
  shop_id: { type: String, required: true, index: true },
  conversation_id: { type: String, required: true, index: true }, // String เสมอ (int64 precision — ข้อ 3.1)
  message_id: { type: String, required: true, unique: true },      // String เสมอ, unique กัน insert ซ้ำ (idempotency)
  from_id: { type: String },
  from_shop_id: { type: String },
  to_id: { type: String },
  to_shop_id: { type: String },
  message_type: { type: String },
  direction: { type: String, enum: ['in', 'out'] }, // คำนวณเอง จาก from_shop_id เทียบกับ shop_id ของเรา
  content: { type: mongoose.Schema.Types.Mixed },
  status: { type: String }, // normal / auto_reply / blocked / ... (ค่าจาก Shopee)
  read_by_recipient: { type: Boolean, default: false },
  source: { type: String }, // old_webchat / openapi / ios / ...
  created_timestamp: { type: Date }, // ✅ get_message ใช้หน่วยวินาที (ยืนยันแล้ว — ข้อ 2)
  raw_payload: { type: mongoose.Schema.Types.Mixed }, // เก็บ payload ดิบทั้งก้อนไว้ debug

  // เผื่ออนาคต: AI Product DB Integration (megaplan ข้อ 11) — ยังไม่ implement ตอนนี้
  reply_source: { type: String, enum: ['manual', 'ai', null], default: null },
  linked_product_ids: { type: [String], default: [] },
  ai_context_used: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

// ⚡ High-performance compound indexes สำหรับดึงข้อความในห้องแชตแบบ instant (< 1ms)
messageSchema.index({ conversation_id: 1, created_timestamp: 1 });
messageSchema.index({ shop_id: 1, created_timestamp: -1 });

module.exports = mongoose.model('Message', messageSchema);
