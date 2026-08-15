const Conversation = require('../models/Conversation');
const { autoAssignConversation } = require('./chatAssignment');
const { onInboundMessage, onOutboundMessage } = require('./chatMetrics');

// จุดเดียวที่ pollWorker / webhookWorker / api.js (sync ตอนเปิดแชท) เรียกทุกครั้งที่มีข้อความ "ใหม่จริง" ถูกบันทึกลง DB
// (เช็ค upsertedCount ก่อนเรียก ไม่ใช่ทุกครั้งที่ upsert เพราะ endpoint เดิม sync ซ้ำได้บ่อย)
// ทำ 2 อย่างแยกกัน: ข้อความเข้า → auto-assign (ถ้ายังไม่มีคนรับ) + เปิด/ต่อรอบ metric, ข้อความออก → ปิดรอบ metric
async function handleNewMessage(conv, message, direction) {
  if (!conv) return;

  if (direction === 'in') {
    let freshConv = conv;
    if (!conv.assigned_to) {
      const agent = await autoAssignConversation(conv).catch((err) => {
        console.error('[chatEvents] autoAssignConversation failed:', err.message);
        return null;
      });
      if (agent) {
        freshConv = await Conversation.findById(conv._id).lean();
      }
    }
    await onInboundMessage(freshConv, message).catch((err) => {
      console.error('[chatEvents] onInboundMessage failed:', err.message);
    });
  } else {
    await onOutboundMessage(conv, message).catch((err) => {
      console.error('[chatEvents] onOutboundMessage failed:', err.message);
    });
  }
}

module.exports = { handleNewMessage };
