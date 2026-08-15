const AuditLog = require('../models/AuditLog');

// actor: User document/lean object, User._id, หรือ literal 'system' — เขียน log ไม่มีวันพัง flow หลัก (fire-and-forget แบบ log เฉยๆ)
async function logEvent({ type, actor, conversationId = null, shopId = null, targetUserId = null, meta = {} }) {
  let actorId = null;
  let actorLabel = 'system';

  if (actor && actor !== 'system') {
    actorId = actor._id || actor;
    actorLabel = actor.nickname || actor.name || String(actorId);
  }

  try {
    await AuditLog.create({
      type,
      actor_id: actorId,
      actor_label: actorLabel,
      conversation_id: conversationId,
      shop_id: shopId,
      target_user_id: targetUserId || null,
      meta,
    });
  } catch (err) {
    console.error(`[auditLog] failed to write ${type}:`, err.message);
  }
}

module.exports = { logEvent };
