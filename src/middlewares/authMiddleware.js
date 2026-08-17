const User = require('../models/User');

// อักษรย่อ avatar จาก "ชื่อจริง นามสกุล" — เอาตัวแรกของแต่ละคำ (ไม่ใช่ 2 ตัวแรกของคำแรก)
function computeInitials(name) {
  if (!name) return 'CS';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

async function loadUser(req, res, next) {
  try {
    if (req.session && req.session.userId) {
      req.user = await User.findOne({ _id: req.session.userId, isDeleted: false });
    }
    
    // ⚡ Auto-login: หากรันบน localhost / dev หรือตั้งค่า DEV_AUTO_LOGIN=true
    // ให้ล็อกอินด้วยบัญชี Admin อัตโนมัติ เพื่อไม่ให้ผู้ใช้ต้องมากดล็อกอินซ้ำๆ ตลอดเวลา
    const shouldAutoLogin = process.env.DEV_AUTO_LOGIN !== 'false' && (process.env.NODE_ENV !== 'production' || process.env.DEV_AUTO_LOGIN === 'true');
    if (!req.user && shouldAutoLogin) {
      const defaultAdmin = await User.findOne({ role: 'admin', isDeleted: false }) || await User.findOne({ isDeleted: false });
      if (defaultAdmin) {
        req.user = defaultAdmin;
        if (req.session) {
          req.session.userId = defaultAdmin._id.toString();
        }
      }
    }
  } catch (err) {
    console.error('[authMiddleware] loadUser error:', err.message);
  }

  res.locals.currentUser = req.user || null;
  res.locals.avatarInitials = req.user ? computeInitials(req.user.name) : 'CS';
  next();
}

function isAjaxRequest(req) {
  return Boolean(
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
    (req.path && req.path.startsWith('/api')) ||
    (req.baseUrl && req.baseUrl.startsWith('/api')) ||
    (req.originalUrl && req.originalUrl.startsWith('/api'))
  );
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
