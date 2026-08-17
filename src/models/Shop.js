const mongoose = require('mongoose');

// ดู megaplan ข้อ 3 + 2.3 — ไม่เก็บ access_token/refresh_token เอง
// อ่านจาก sellcenter's Shp2022Token แบบ real-time ทุกครั้งที่ใช้งานจริง
const shopSchema = new mongoose.Schema({
  platform: { type: String, enum: ['shopee', 'tiktok', 'lazada'], default: 'shopee', required: true },
  shop_id: { type: String, required: true, index: true }, // เก็บเป็น String เสมอ กัน int64 precision loss
  shopname: { type: String, index: true }, // key อ้างอิงไปหา Shp2022Token
  shop_name: { type: String }, // ชื่อแสดงผลใน UI
  enabled_for_chat: { type: Boolean, default: false },
  disabled_by_user: { type: Boolean, default: false }, // ผู้ใช้สั่งปิดร้านนี้เอง (เช่น token ตายถาวร) — sync ห้าม auto re-enable ทับ
  last_polled_at: { type: Date },
  poll_cursor: { type: mongoose.Schema.Types.Mixed, default: null }, // next_timestamp_nano ต่อร้าน
  status: { type: String, enum: ['active', 'token_error', 'disabled'], default: 'disabled' },
}, { timestamps: true });

shopSchema.index({ platform: 1, shop_id: 1 }, { unique: true });

module.exports = mongoose.model('Shop', shopSchema);
