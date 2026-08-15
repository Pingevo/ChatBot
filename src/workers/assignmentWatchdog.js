require('dotenv').config();
const { connectMainDB } = require('../config/db');
const User = require('../models/User');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const ChatTurnMetric = require('../models/ChatTurnMetric');
const { getActiveConfig, buildPool, pickNextAgent } = require('../services/chatAssignment');
const { computePresence, OFFLINE_MS } = require('../services/presence');
const { logEvent } = require('../services/auditLog');
const { computeDailyStatsForDate, bangkokDateStr } = require('../services/dailyStats');

const TICK_MS = Number(process.env.ASSIGNMENT_WATCHDOG_INTERVAL_MS || 2 * 60 * 1000);
const SLA_ALERT_MS = Number(process.env.CHAT_SLA_ALERT_MS || 10 * 60 * 1000);
const SLA_REASSIGN_MS = Number(process.env.CHAT_SLA_REASSIGN_MS || 20 * 60 * 1000);

function minutesSince(date) {
  return Math.round((Date.now() - new Date(date).getTime()) / 60000);
}

// ส่วนที่ 1: agent ที่ isActiveAgent=true แต่ไม่มี heartbeat มานานเกิน OFFLINE_MS — ระบบดึงออกจากคิวให้เอง
// ไม่แตะคนที่ paused_by='user' อยู่แล้ว (พักเอง) และไม่แตะคนที่ isActiveAgent=false อยู่แล้ว (กันเขียน log ซ้ำทุก tick)
async function sweepIdleAgents() {
  const cutoff = new Date(Date.now() - OFFLINE_MS);
  const candidates = await User.find({
    isDeleted: false,
    isActiveAgent: true,
    $or: [{ last_seen_at: null }, { last_seen_at: { $lt: cutoff } }],
  });

  for (const user of candidates) {
    user.isActiveAgent = false;
    user.paused_by = 'system';
    // eslint-disable-next-line no-await-in-loop
    await user.save();
    // eslint-disable-next-line no-await-in-loop
    await logEvent({
      type: 'agent_auto_paused',
      actor: 'system',
      targetUserId: user._id,
      meta: { reason: 'no_heartbeat', last_seen_at: user.last_seen_at },
    });
    console.log(`[watchdog] auto-paused agent ${user.nickname || user.name} (no heartbeat)`);
  }
}

// ส่วนที่ 2a: แจ้งเตือน (ไม่ย้ายงาน) — รอบที่ยัง pending เกิน SLA_ALERT_MS และยังไม่เคยแจ้งเตือน
async function sweepSlaAlerts() {
  const cutoff = new Date(Date.now() - SLA_ALERT_MS);
  const turns = await ChatTurnMetric.find({
    status: 'pending',
    customer_message_at: { $lte: cutoff },
    sla_alerted_at: null,
  });

  for (const turn of turns) {
    turn.sla_alerted_at = new Date();
    // eslint-disable-next-line no-await-in-loop
    await turn.save();
    // eslint-disable-next-line no-await-in-loop
    await logEvent({
      type: 'chat_sla_alert',
      actor: 'system',
      conversationId: turn.conversation_id,
      shopId: turn.shop_id,
      targetUserId: turn.agent_id,
      meta: { waited_minutes: minutesSince(turn.customer_message_at) },
    });
  }
}

// ส่วนที่ 2b: โยกแชทให้คนถัดไปในคิว — รอบที่ยัง pending เกิน SLA_REASSIGN_MS และยังไม่เคยโยก
// เก็บ turn.agent_id เดิมไว้ (ไม่ทับ) เพื่อดูสถิติย้อนหลังได้ว่าใครเป็นคนพลาด
async function sweepSlaReassign() {
  const cutoff = new Date(Date.now() - SLA_REASSIGN_MS);
  const turns = await ChatTurnMetric.find({
    status: 'pending',
    customer_message_at: { $lte: cutoff },
    sla_reassigned: { $ne: true },
  });

  for (const turn of turns) {
    // eslint-disable-next-line no-await-in-loop
    const conv = await Conversation.findOne({ conversation_id: turn.conversation_id });
    if (!conv || conv.status !== 'open') {
      turn.sla_reassigned = true; // แชทปิดไปแล้ว/หายไป ไม่ต้องโยกอีก
      // eslint-disable-next-line no-await-in-loop
      await turn.save();
      continue; // eslint-disable-line no-continue
    }

    // eslint-disable-next-line no-await-in-loop
    const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).lean();
    if (!shop) continue; // eslint-disable-line no-continue

    // eslint-disable-next-line no-await-in-loop
    const config = await getActiveConfig();
    // eslint-disable-next-line no-await-in-loop
    const { poolKey, orderedAgentIds } = await buildPool(config.mode, shop);
    // eslint-disable-next-line no-await-in-loop
    const newAgent = await pickNextAgent(poolKey, orderedAgentIds);
    if (!newAgent) continue; // eslint-disable-line no-continue

    const fromUserId = conv.assigned_to || null;
    // eslint-disable-next-line no-await-in-loop
    await Conversation.updateOne(
      { _id: conv._id },
      { $set: { assigned_to: newAgent._id, assigned_at: new Date(), assignment_mode_used: config.mode } }
    );

    turn.sla_reassigned = true;
    // eslint-disable-next-line no-await-in-loop
    await turn.save();

    // eslint-disable-next-line no-await-in-loop
    await logEvent({
      type: 'chat_sla_reassigned',
      actor: 'system',
      conversationId: conv.conversation_id,
      shopId: conv.shop_id,
      targetUserId: newAgent._id,
      meta: { reason: 'sla_breach', waited_minutes: minutesSince(turn.customer_message_at), from_user_id: fromUserId },
    });
    console.log(`[watchdog] SLA reassign conv=${conv.conversation_id} -> ${newAgent.nickname || newAgent.name}`);
  }
}

let lastRollupDate = null;
// รวม AgentDailyStats ของ "เมื่อวาน" ครั้งเดียวต่อวัน (idempotent เรียกซ้ำได้ ไม่เสียหาย)
async function maybeRunDailyRollup() {
  const todayStr = bangkokDateStr();
  if (todayStr === lastRollupDate) return;

  const yesterdayStr = bangkokDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000));
  await computeDailyStatsForDate(yesterdayStr);
  lastRollupDate = todayStr;
  console.log(`[watchdog] daily rollup done for ${yesterdayStr}`);
}

async function tick() {
  try {
    await sweepIdleAgents();
    await sweepSlaAlerts();
    await sweepSlaReassign();
    await maybeRunDailyRollup();
  } catch (err) {
    console.error('[watchdog] tick error:', err.message);
  }
}

async function main() {
  await connectMainDB();

  if (process.env.ENABLE_ASSIGNMENT_WATCHDOG !== 'true') {
    console.log('[watchdog] ENABLE_ASSIGNMENT_WATCHDOG=false — worker หยุดทำงาน');
    return;
  }

  console.log(`[watchdog] started (interval=${TICK_MS}ms, sla_alert=${SLA_ALERT_MS}ms, sla_reassign=${SLA_REASSIGN_MS}ms, offline=${OFFLINE_MS}ms)`);
  await tick();
  setInterval(tick, TICK_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[watchdog] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { tick, sweepIdleAgents, sweepSlaAlerts, sweepSlaReassign };
