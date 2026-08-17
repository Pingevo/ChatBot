const mongoose = require('mongoose');

const systemConfigSchema = new mongoose.Schema({
  config_key: { type: String, required: true, unique: true, default: 'main_config' },
  
  // Shopee Live API Switches (ควบคุมการอ่าน-เขียน Shopee API จริง)
  shopee_live_read_enabled: { type: Boolean, default: false },       // อ่านข้อมูลจริงจาก Shopee API (get_conversation_list, get_message)
  shopee_live_send_enabled: { type: Boolean, default: false },       // ส่งข้อความจริงออกไป Shopee API (send_message)
  shopee_live_mark_read_enabled: { type: Boolean, default: false },  // มาร์คอ่านจริงไป Shopee API (read_conversation)
  shopee_live_pin_enabled: { type: Boolean, default: false },        // ปักหมุดจริงไป Shopee API (pin_conversation)
  
  // Worker & Background Sync Switches
  shopee_poll_enabled: { type: Boolean, default: false },            // ดึงข้อความรอบตกหล่น (pollWorker)
  shopee_webhook_worker_enabled: { type: Boolean, default: false },  // ประมวลผลคิว PushEvent (webhookWorker)
  shopee_background_sync_enabled: { type: Boolean, default: false }, // Sync จาก sellcenter dbWallet
  
  // Development / Mock Settings
  mock_mode_enabled: { type: Boolean, default: false },              // โหมดทดสอบจำลอง (สร้าง mock response แทนการยิง Shopee API จริง)
  
  // Extra Settings
  poll_interval_ms: { type: Number, default: 20000 },
  updated_by: { type: String, default: 'system' },
}, { timestamps: true });

module.exports = mongoose.model('SystemConfig', systemConfigSchema);
