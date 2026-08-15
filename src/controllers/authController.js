const axios = require('axios');
const User = require('../models/User');
const { getSellcenterUserModel } = require('../config/sellcenterDb');

function getBaseUrl() {
  return (process.env.BASE_URL || 'http://localhost:8123').replace(/\/+$/, '');
}

function getSellcenterBaseUrl() {
  return (process.env.SELLCENTER_OAUTH_BASE_URL || 'https://data.digital.in.th').replace(/\/+$/, '');
}

function getCallbackUrl() {
  return `${getBaseUrl()}/auth/callback`;
}

// พนักงานที่ login ด้วยอีเมลโดเมนนี้ผ่าน system81 จะถูกสร้างบัญชี staff ให้อัตโนมัติ
// ไม่ต้องรอ superadmin มาผูกบัญชีเอง
const AUTO_PROVISION_DOMAIN = process.env.SSO_AUTO_PROVISION_DOMAIN || '@itsr.co.th';

// ดึง profile จริง (ชื่อเต็ม/ชื่อเล่นไทย/แผนก/ตำแหน่ง/อีเมล) จากทำเนียบพนักงาน system81 ใน dbWallet
// อ่านอย่างเดียว — ไม่ select field password เด็ดขาด
// ⚠️ username จาก userinfo API มีโดเมนต่อท้าย (เช่น sarawut.cha@itsr.co.th) แต่ username ใน dbWallet.Users
// ไม่มีโดเมน (sarawut.cha) — ต้อง fallback ไปลองตัดโดเมนออกด้วย ถ้าหาแบบเต็มไม่เจอ
async function lookupSystem81Profile(username) {
  try {
    const SellcenterUser = getSellcenterUserModel();
    let profile = await SellcenterUser.findOne({ username }).select('-password').lean();
    if (!profile && username.includes('@')) {
      const localPart = username.split('@')[0];
      profile = await SellcenterUser.findOne({ username: localPart }).select('-password').lean();
    }
    return profile;
  } catch (err) {
    return null;
  }
}

// full_name ใน dbWallet มักมีช่องว่างเกินตรงกลาง/ท้าย (เช่น "ศราวุฒิ  ชัยมี ") — clean ก่อนเก็บ/แสดงผล
function cleanName(str) {
  return str ? String(str).trim().replace(/\s+/g, ' ') : str;
}

async function findOrProvisionUser(userInfo) {
  let user = await User.findOne({ system81_username: userInfo.username, isDeleted: false });
  const profile = await lookupSystem81Profile(userInfo.username);

  if (user) {
    if (profile) {
      user.name = cleanName(profile.full_name) || profile.name || user.name;
      user.nickname = cleanName(profile.nickname) || user.nickname;
      user.email = (profile.email || user.email || '').toLowerCase() || undefined;
      user.department = profile.department || user.department;
      user.position = profile.position || user.position;
    }
    return user;
  }

  if (!userInfo.username.toLowerCase().endsWith(AUTO_PROVISION_DOMAIN)) return null;

  const email = (profile && profile.email ? profile.email : userInfo.username).toLowerCase();
  user = await User.findOne({ email, isDeleted: false });
  if (user) {
    user.system81_username = userInfo.username;
  } else {
    user = new User({
      name: cleanName(profile && (profile.full_name || profile.name)) || userInfo.name || userInfo.username,
      nickname: profile ? cleanName(profile.nickname) : undefined,
      email,
      department: profile ? profile.department : undefined,
      position: profile ? profile.position : undefined,
      role: 'staff',
      system81_username: userInfo.username,
    });
  }
  return user;
}

function renderLoginPage(res, error, returnTo) {
  return res.render('auth/login', { title: 'เข้าสู่ระบบ', error: error || null, returnTo: returnTo || null });
}

// GET /auth/login
function showLogin(req, res) {
  if (req.user) return res.redirect('/inbox');
  return renderLoginPage(res, null, req.query.returnTo);
}

// GET /auth/redirect — ส่งไปหน้า login กลางของ system81 (sellcenter)
function redirectToSellcenter(req, res) {
  req.session.authReturnTo = req.query.returnTo || '/inbox';

  const params = new URLSearchParams({
    redirect_uri: getCallbackUrl(),
    app_name: 'Chat Center',
  });

  res.redirect(`${getSellcenterBaseUrl()}/system81/login?${params.toString()}`);
}

// GET /auth/callback — sellcenter redirect กลับมาพร้อม ?token=<jwt>
async function callback(req, res) {
  const { token, error } = req.query;

  if (error) {
    return renderLoginPage(res, 'การเข้าสู่ระบบผ่าน ITSR ไม่สำเร็จ กรุณาลองใหม่');
  }
  if (!token) {
    return renderLoginPage(res, 'ไม่ได้รับ token จาก ITSR กรุณาลองใหม่');
  }

  let userInfo;
  try {
    const userInfoRes = await axios.get(`${getSellcenterBaseUrl()}/system81/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    userInfo = userInfoRes.data && userInfoRes.data.success ? userInfoRes.data.user : null;
  } catch (err) {
    return renderLoginPage(res, 'ไม่สามารถตรวจสอบ token กับ ITSR ได้');
  }

  if (!userInfo || !userInfo.username) {
    return renderLoginPage(res, 'ITSR token ไม่ถูกต้อง');
  }

  const user = await findOrProvisionUser(userInfo);
  if (!user) {
    return renderLoginPage(res, 'บัญชี ITSR นี้ไม่มีสิทธิ์เข้าถึง Chat Center');
  }

  user.last_login_at = new Date();
  await user.save();

  const returnTo = req.session.authReturnTo;
  delete req.session.authReturnTo;

  req.session.regenerate((err) => {
    if (err) return renderLoginPage(res, 'เกิดข้อผิดพลาด กรุณาลองใหม่');
    req.session.userId = user._id.toString();
    res.redirect(returnTo && returnTo.startsWith('/') ? returnTo : '/inbox');
  });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
}

module.exports = { showLogin, redirectToSellcenter, callback, logout };
