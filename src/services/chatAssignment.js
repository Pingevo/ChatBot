const User = require('../models/User');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const AssignmentConfig = require('../models/AssignmentConfig');
const AssignmentCursor = require('../models/AssignmentCursor');
const ShopTeamAssignment = require('../models/ShopTeamAssignment');
const { logEvent } = require('./auditLog');

// singleton config — สร้างค่า default ให้อัตโนมัติถ้ายังไม่มี
async function getActiveConfig() {
  let config = await AssignmentConfig.findOne();
  if (!config) {
    config = await AssignmentConfig.create({ mode: 'equal_global' });
  }
  return config;
}

// รายชื่อ agent ทั้งหมดเรียงตามวันที่เข้าร่วมระบบ — ใช้เป็น pool กลางของโหมด global และ per_platform
async function allAgentsOrdered() {
  const users = await User.find({ isDeleted: false }).sort({ createdAt: 1 }).select('_id').lean();
  return users.map((u) => u._id);
}

// สร้าง { poolKey, orderedAgentIds } ตามโหมดที่ตั้งไว้ — นี่คือจุดเดียวที่ตัดสินใจ "ขอบเขตคิว"
async function buildPool(mode, shop) {
  if (mode === 'equal_per_shop') {
    const rows = await ShopTeamAssignment.find({ shop_id: shop.shop_id, is_active: true })
      .sort({ added_at: 1 })
      .select('user_id')
      .lean();
    return { poolKey: `shop:${shop.shop_id}`, orderedAgentIds: rows.map((r) => r.user_id) };
  }
  if (mode === 'equal_per_platform') {
    return { poolKey: `platform:${shop.platform}`, orderedAgentIds: await allAgentsOrdered() };
  }
  // equal_global (default)
  return { poolKey: 'global', orderedAgentIds: await allAgentsOrdered() };
}

// เดินคิว 1→2→3→4→1 ไม่สนภาระงาน — ข้าม agent ที่ isActiveAgent=false แต่ไม่ขยับตำแหน่งคิวของเขา
async function pickNextAgent(poolKey, orderedAgentIds) {
  if (!orderedAgentIds || orderedAgentIds.length === 0) return null;

  const cursor = await AssignmentCursor.findOne({ pool_key: poolKey }).lean();
  const lastId = cursor && cursor.last_assigned_user_id ? String(cursor.last_assigned_user_id) : null;
  const startIdx = lastId ? orderedAgentIds.findIndex((id) => String(id) === lastId) : -1;

  for (let step = 1; step <= orderedAgentIds.length; step++) {
    const idx = (startIdx + step + orderedAgentIds.length) % orderedAgentIds.length;
    const agentId = orderedAgentIds[idx];
    // eslint-disable-next-line no-await-in-loop
    const agent = await User.findOne({ _id: agentId, isDeleted: false, isActiveAgent: true });
    if (agent) {
      await AssignmentCursor.findOneAndUpdate(
        { pool_key: poolKey },
        { $set: { last_assigned_user_id: agent._id } },
        { upsert: true }
      );
      return agent;
    }
  }
  return null; // ทั้งคิวพักหมด — ไม่มีใครรับได้ตอนนี้
}

// เรียกตอนมีข้อความขาเข้าใหม่ — assign แบบ atomic กันสองแชทชนกันแย่งคิวเดียวกัน (หรือ webhook/poll ยิงซ้อนกัน)
async function autoAssignConversation(conv) {
  if (conv.assigned_to) return null; // มีคนรับผิดชอบอยู่แล้ว ไม่ต้องจ่ายซ้ำ

  const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).lean();
  if (!shop) return null;

  const config = await getActiveConfig();
  const { poolKey, orderedAgentIds } = await buildPool(config.mode, shop);
  if (orderedAgentIds.length === 0) return null;

  const agent = await pickNextAgent(poolKey, orderedAgentIds);
  if (!agent) return null;

  const updated = await Conversation.findOneAndUpdate(
    { _id: conv._id, assigned_to: null },
    { $set: { assigned_to: agent._id, assigned_at: new Date(), assignment_mode_used: config.mode } },
    { new: true }
  );
  if (!updated) return null; // มีคนอื่น assign ไปแล้วระหว่างที่เรากำลังเลือกคิว (race) — เสียตาคิวไปหนึ่งตา ยอมรับได้

  await logEvent({
    type: 'chat_assigned',
    actor: 'system',
    conversationId: conv.conversation_id,
    shopId: conv.shop_id,
    targetUserId: agent._id,
    meta: { mode_used: config.mode, pool_size: orderedAgentIds.length },
  });

  return agent;
}

// lead/admin ย้ายงานเอง — ไม่แตะคิว round-robin (คิวขยับเฉพาะตอน auto-assign เท่านั้น)
async function reassignConversation(conv, newAgentId, actor, reason) {
  const fromUserId = conv.assigned_to || null;
  const config = await getActiveConfig();

  await Conversation.updateOne(
    { _id: conv._id },
    { $set: { assigned_to: newAgentId || null, assigned_at: new Date(), assignment_mode_used: config.mode } }
  );

  await logEvent({
    type: 'chat_reassigned',
    actor,
    conversationId: conv.conversation_id,
    shopId: conv.shop_id,
    targetUserId: newAgentId || null,
    meta: { from_user_id: fromUserId, reason: reason || null },
  });
}

module.exports = {
  getActiveConfig,
  buildPool,
  pickNextAgent,
  autoAssignConversation,
  reassignConversation,
};
