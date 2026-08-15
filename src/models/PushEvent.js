const mongoose = require('mongoose');

// Webhook queue — เก็บ push events ที่รับจาก Shopee (webchat_push Code:10)
// ทำหน้าที่เป็น MongoDB-based queue: webhook receiver insert ที่นี่, worker ดึงไปประมวลผล
// เก็บประวัติถาวรเพื่อ audit + ตรวจสอบย้อนหลัง + ดึงของที่หลุดได้ (idempotency + replay)
const pushEventSchema = new mongoose.Schema({
  platform: { type: String, default: 'shopee' },
  push_code: { type: Number, required: true }, // 10 = webchat_push (เก็บไว้เผื่อ push type อื่น)
  shop_id: { type: String, required: true, index: true }, // String เสมอ (int64 precision — ข้อ 3.1)
  timestamp: { type: Date }, // timestamp ที่ Shopee ส่งมา (หน่วยวินาที)

  // raw payload ทั้งก้อนที่ Shopee ส่งมา — เก็บดิบไว้ debug + replay
  raw_payload: { type: mongoose.Schema.Types.Mixed, required: true },

  // Queue status — worker ดึงเฉพาะ pending มาทำ
  // pending: รอประมวลผล, processing: worker กำลังทำ, done: สำเร็จ, failed: ล้มเหลว
  status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending', index: true },
  retry_count: { type: Number, default: 0 },
  max_retries: { type: Number, default: 5 },
  last_error: { type: String },

  // idempotency key — กัน duplicate จาก Shopee retry (push ซ้ำ message_id เดิม)
  // Shopee ระบุว่า "Can Repeated Same Message: Yes" ต้องดักไว้
  dedup_key: { type: String, unique: true, sparse: true },

  // ผลลัพธ์หลัง worker ประมวลผล (เช่น message_id ที่ดึงได้, conversation_id)
  result: { type: mongoose.Schema.Types.Mixed },

  // เวลาที่ worker เริ่ม/เสร็จ — ใช้คำนวณ latency และหา event ที่ค้างนานเกินไป
  processing_started_at: { type: Date },
  completed_at: { type: Date },
}, { timestamps: { createdAt: 'created_at', updatedAt: true } });

// index สำหรับ worker ดึง queue — ดึง pending เก่าสุดก่อน (FIFO)
pushEventSchema.index({ status: 1, created_at: 1 });

// index สำหรับตรวจสอบ event ที่ค้าง processing นานเกินไป (worker ตายกลางคัน)
pushEventSchema.index({ status: 1, processing_started_at: 1 });

// ⚠️ TTL index — ลบ Push Event เก่าเกิน 14 วัน ออกจาก DB อัตโนมัติเพื่อไม่ให้เป็นภาระดิสก์
pushEventSchema.index({ created_at: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

module.exports = mongoose.model('PushEvent', pushEventSchema);
