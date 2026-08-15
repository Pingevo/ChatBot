const User = require('../models/User');

// อักษรย่อ avatar จาก "ชื่อจริง นามสกุล" — เอาตัวแรกของแต่ละคำ (ไม่ใช่ 2 ตัวแรกของคำแรก)
function computeInitials(name) {
  if (!name) return 'CS';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    req.user = await User.findOne({ _id: req.session.userId, isDeleted: false });
  }
  res.locals.currentUser = req.user || null;
  res.locals.avatarInitials = req.user ? computeInitials(req.user.name) : 'CS';
  next();
}

function isAjaxRequest(req) {
  return req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (isAjaxRequest(req)) {
      return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ', redirect: `/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}` });
    }
    return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// ใช้หลัง requireAuth เสมอ — จำกัดเฉพาะ role ที่ระบุ เช่น requireRole('admin') หรือ requireRole('admin', 'lead')
function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      if (isAjaxRequest(req)) {
        return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงส่วนนี้' });
      }
      return res.status(403).send('ไม่มีสิทธิ์เข้าถึงส่วนนี้');
    }
    next();
  };
}

module.exports = { loadUser, requireAuth, requireRole };
