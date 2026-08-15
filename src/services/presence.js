const User = require('../models/User');
const { logEvent } = require('./auditLog');

const IDLE_MS = Number(process.env.PRESENCE_IDLE_MS || 10 * 60 * 1000);
const OFFLINE_MS = Number(process.env.PRESENCE_OFFLINE_MS || 30 * 60 * 1000);

// เรียกจาก POST /api/presence/ping ทุกครั้งที่หน้า inbox ยัง active อยู่
// ถ้าระบบเป็นคนสั่งพักไว้ (paused_by='system') ให้กลับเข้าคิวทันทีที่ ping กลับมา — ไม่แตะกรณีพักเองด้วยมือ
async function touchPresence(userId) {
  const user = await User.findById(userId);
  if (!user) return null;

  const wasSystemPaused = user.paused_by === 'system';
  user.last_seen_at = new Date();
  if (wasSystemPaused) {
    user.isActiveAgent = true;
    user.paused_by = null;
  }
  await user.save();

  if (wasSystemPaused) {
    await logEvent({ type: 'agent_auto_resumed', actor: 'system', targetUserId: user._id, meta: {} });
  }
  return user;
}

// ใช้แสดงผลในหน้า /team และ /api/agents — ไม่ผูกกับ isActiveAgent (ซึ่งเป็น "รับงานไหม" ไม่ใช่ "อยู่หน้าจอไหม")
function computePresence(lastSeenAt) {
  if (!lastSeenAt) return 'offline';
  const elapsed = Date.now() - new Date(lastSeenAt).getTime();
  if (elapsed < IDLE_MS) return 'online';
  if (elapsed < OFFLINE_MS) return 'idle';
  return 'offline';
}

module.exports = { touchPresence, computePresence, IDLE_MS, OFFLINE_MS };
