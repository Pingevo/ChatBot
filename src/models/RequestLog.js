const mongoose = require('mongoose');

// Audit trail — เก็บทุก step ของ pipeline (megaplan ข้อ 7)
// ทุกรอบ polling และทุก API call ออกไป Shopee ต้อง log ที่นี่ ไม่มีข้อยกเว้น
const requestLogSchema = new mongoose.Schema({
  platform: { type: String, default: 'shopee' },
  direction: { type: String, enum: ['poll_in', 'api_out'], required: true },
  event_type: { type: String, required: true }, // เช่น "get_conversation_list", "send_message", "fallback_refresh_token"
  shop_id: { type: String },
  request_payload: { type: mongoose.Schema.Types.Mixed },
  response_payload: { type: mongoose.Schema.Types.Mixed },
  status_code: { type: Number },
  error: { type: String },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

requestLogSchema.index({ shop_id: 1, created_at: -1 });
// ⚠️ TTL index — ลบ Log เก่าเกิน 7 วัน (604,800 วินาที) ออกจาก DB อัตโนมัติเพื่อประหยัดพื้นที่
requestLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 604800 });

module.exports = mongoose.model('RequestLog', requestLogSchema);
