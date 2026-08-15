const express = require('express');
const router = express.Router();

const User = require('../models/User');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const AssignmentConfig = require('../models/AssignmentConfig');
const ShopTeamAssignment = require('../models/ShopTeamAssignment');
const AuditLog = require('../models/AuditLog');
const { requireRole } = require('../middlewares/authMiddleware');
const { getActiveConfig } = require('../services/chatAssignment');
const { touchPresence, computePresence } = require('../services/presence');
const { logEvent } = require('../services/auditLog');
const { getKpiSummary, bangkokDateStr } = require('../services/dailyStats');

// GET /api/agents — รายชื่อ agent ทั้งหมด + ภาระงานปัจจุบัน + สถานะ online/idle/offline
// ใช้ทั้งใน dropdown มอบหมายงาน และหน้า /team
router.get('/agents', async (req, res) => {
  const users = await User.find({ isDeleted: false }).sort({ createdAt: 1 }).lean();
  const openCounts = await Conversation.aggregate([
    { $match: { assigned_to: { $ne: null }, status: 'open' } },
    { $group: { _id: '$assigned_to', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(openCounts.map((c) => [String(c._id), c.count]));

  res.json(users.map((u) => ({
    _id: u._id,
    name: u.name,
    nickname: u.nickname,
    role: u.role,
    isActiveAgent: u.isActiveAgent,
    paused_by: u.paused_by,
    last_seen_at: u.last_seen_at,
    presence: computePresence(u.last_seen_at),
    open_conversations: countMap.get(String(u._id)) || 0,
  })));
});

// POST /api/presence/ping — heartbeat จากหน้า inbox ทุก 60 วิ ขณะ tab ยัง active
router.post('/presence/ping', async (req, res) => {
  await touchPresence(req.user._id);
  res.json({ ok: true });
});

// PATCH /api/agents/:id/active — พัก/เปิดรับงานเอง { isActiveAgent: true|false }
// ตัวเองทำได้เสมอ, lead/admin ทำแทนคนอื่นได้ด้วย
router.patch('/agents/:id/active', async (req, res) => {
  const isSelf = String(req.user._id) === String(req.params.id);
  const canManage = isSelf || req.user.role === 'admin' || req.user.role === 'lead';
  if (!canManage) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });

  const { isActiveAgent } = req.body;
  if (typeof isActiveAgent !== 'boolean') return res.status(400).json({ error: 'isActiveAgent_must_be_boolean' });

  const user = await User.findOne({ _id: req.params.id, isDeleted: false });
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  user.isActiveAgent = isActiveAgent;
  user.paused_by = isActiveAgent ? null : 'user';
  await user.save();

  await logEvent({
    type: isActiveAgent ? 'agent_manual_resumed' : 'agent_manual_paused',
    actor: req.user,
    targetUserId: user._id,
  });

  res.json({ ok: true, isActiveAgent: user.isActiveAgent });
});

// GET /api/assignment-config — โหมดแบ่งงานปัจจุบัน
router.get('/assignment-config', async (req, res) => {
  const config = await getActiveConfig();
  res.json({ mode: config.mode, updated_by: config.updated_by, updated_at: config.updatedAt });
});

// PUT /api/assignment-config — เปลี่ยนโหมด (admin เท่านั้น) { mode: 'equal_global'|'equal_per_shop'|'equal_per_platform' }
router.put('/assignment-config', requireRole('admin'), async (req, res) => {
  const { mode } = req.body;
  const validModes = ['equal_global', 'equal_per_shop', 'equal_per_platform'];
  if (!validModes.includes(mode)) return res.status(400).json({ error: 'invalid_mode' });

  const config = await getActiveConfig();
  const fromMode = config.mode;
  config.mode = mode;
  config.updated_by = req.user._id;
  await config.save();

  await logEvent({
    type: 'assignment_config_changed',
    actor: req.user,
    meta: { from: fromMode, to: mode },
  });

  res.json({ ok: true, mode: config.mode });
});

// GET /api/shop-team?shop_id=xxx — roster ปัจจุบัน (ไม่ระบุ shop_id = ทั้งหมด) — ใช้ทั้งหน้าจัดการทีมและ debug
router.get('/shop-team', async (req, res) => {
  const filter = { is_active: true };
  if (req.query.shop_id) filter.shop_id = req.query.shop_id;

  const rows = await ShopTeamAssignment.find(filter).sort({ shop_id: 1, added_at: 1 }).lean();
  const userIds = [...new Set(rows.map((r) => String(r.user_id)))];
  const users = await User.find({ _id: { $in: userIds } }).select('name nickname').lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  res.json(rows.map((r) => ({
    _id: r._id,
    shop_id: r.shop_id,
    platform: r.platform,
    user_id: r.user_id,
    user_name: userMap.get(String(r.user_id)) ? (userMap.get(String(r.user_id)).nickname || userMap.get(String(r.user_id)).name) : 'ไม่ทราบชื่อ',
    role_on_shop: r.role_on_shop,
    added_at: r.added_at,
  })));
});

// POST /api/shop-team — เพิ่ม agent เข้าทีมร้าน (admin/lead) { shop_id, user_id, role_on_shop? }
router.post('/shop-team', requireRole('admin', 'lead'), async (req, res) => {
  const { shop_id, user_id, role_on_shop = 'agent' } = req.body;
  if (!shop_id || !user_id) return res.status(400).json({ error: 'shop_id_and_user_id_required' });

  const shop = await Shop.findOne({ shop_id });
  if (!shop) return res.status(404).json({ error: 'shop_not_found' });

  const user = await User.findOne({ _id: user_id, isDeleted: false });
  if (!user) return res.status(404).json({ error: 'user_not_found' });

  // มีอยู่แล้วและ active อยู่ — ไม่ต้องสร้างซ้ำ
  const existing = await ShopTeamAssignment.findOne({ shop_id, user_id, is_active: true });
  if (existing) return res.json(existing);

  const row = await ShopTeamAssignment.create({
    shop_id,
    platform: shop.platform,
    user_id,
    role_on_shop,
    added_by: req.user._id,
    added_at: new Date(),
  });

  await logEvent({
    type: 'team_member_added',
    actor: req.user,
    shopId: shop_id,
    targetUserId: user_id,
    meta: { role_on_shop },
  });

  res.json(row);
});

// DELETE /api/shop-team/:id — ถอด agent ออกจากทีมร้าน (admin/lead) — soft-remove เก็บประวัติไว้
router.delete('/shop-team/:id', requireRole('admin', 'lead'), async (req, res) => {
  const row = await ShopTeamAssignment.findOne({ _id: req.params.id, is_active: true });
  if (!row) return res.status(404).json({ error: 'not_found' });

  row.is_active = false;
  row.removed_by = req.user._id;
  row.removed_at = new Date();
  await row.save();

  await logEvent({
    type: 'team_member_removed',
    actor: req.user,
    shopId: row.shop_id,
    targetUserId: row.user_id,
    meta: { reason: req.body && req.body.reason ? req.body.reason : null },
  });

  res.json({ ok: true });
});

// GET /api/reports/kpi?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id= — สรุปรายสัปดาห์/รายเดือน อ่านจาก AgentDailyStats
router.get('/reports/kpi', async (req, res) => {
  const today = bangkokDateStr();
  const from = req.query.from || today;
  const to = req.query.to || today;
  const userId = req.query.user_id || null;

  const rows = await getKpiSummary({ from, to, userId });
  res.json({ from, to, agents: rows });
});

// GET /api/audit-log?conversation_id=&shop_id=&user_id=&limit= — ประวัติดิบ สำหรับตรวจสอบย้อนหลัง
router.get('/audit-log', async (req, res) => {
  const filter = {};
  if (req.query.conversation_id) filter.conversation_id = req.query.conversation_id;
  if (req.query.shop_id) filter.shop_id = req.query.shop_id;
  if (req.query.user_id) filter.target_user_id = req.query.user_id;

  const limit = Math.min(200, Number(req.query.limit) || 50);
  const rows = await AuditLog.find(filter).sort({ at: -1 }).limit(limit).lean();
  res.json(rows);
});

module.exports = router;
