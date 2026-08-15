const ChatTurnMetric = require('../models/ChatTurnMetric');

// เรียกทุกครั้งที่มีข้อความขาเข้าใหม่จริง (ไม่ใช่ sync ซ้ำ) — ถ้ามีรอบที่ยัง pending อยู่แล้ว (ลูกค้าทักซ้ำก่อน agent ตอบ)
// ใช้รอบเดิมต่อ ไม่เปิดรอบใหม่ทับ (customer_message_at ต้องเป็นเวลาข้อความ "แรก" ของรอบนั้น)
async function onInboundMessage(conv, message) {
  const existing = await ChatTurnMetric.findOne({ conversation_id: conv.conversation_id, status: 'pending' });
  if (existing) return existing;

  return ChatTurnMetric.create({
    conversation_id: conv.conversation_id,
    shop_id: conv.shop_id,
    platform: conv.platform,
    agent_id: conv.assigned_to || null,
    customer_message_id: message.message_id,
    customer_message_at: message.created_timestamp || new Date(),
    status: 'pending',
  });
}

// เรียกตอน agent เปิดดูรายละเอียดแชท (GET /api/conversations/:id/messages) — ปั๊มแค่ครั้งแรกต่อรอบ (opened_at ต้องเป็น null อยู่)
async function onConversationOpened(conv, user) {
  if (!user) return;
  await ChatTurnMetric.updateMany(
    { conversation_id: conv.conversation_id, status: 'pending', opened_at: null },
    { $set: { opened_at: new Date(), opened_by: user._id } }
  );
}

// เรียกทุกครั้งที่ agent ส่งข้อความขาออก (reply/send-image/send-video/send-item) — ปิดรอบล่าสุดที่ยัง pending
async function onOutboundMessage(conv, message) {
  const turn = await ChatTurnMetric.findOne({ conversation_id: conv.conversation_id, status: 'pending' }).sort({ customer_message_at: 1 });
  if (!turn) return null;

  const now = message.created_timestamp || new Date();
  const responseSeconds = Math.max(0, Math.round((now - turn.customer_message_at) / 1000));
  const readDelaySeconds = turn.opened_at ? Math.max(0, Math.round((turn.opened_at - turn.customer_message_at) / 1000)) : null;

  turn.first_reply_message_id = message.message_id;
  turn.first_reply_at = now;
  turn.response_time_seconds = responseSeconds;
  turn.read_delay_seconds = readDelaySeconds;
  turn.status = 'replied';
  await turn.save();
  return turn;
}

module.exports = { onInboundMessage, onConversationOpened, onOutboundMessage };
