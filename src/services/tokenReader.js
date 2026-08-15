const crypto = require('crypto');
const { getShpTokenModel } = require('../config/sellcenterDb');
const RequestLog = require('../models/RequestLog');

// ดู megaplan ข้อ 2.3 — อ่าน token จาก sellcenter แบบ read-only เป็นหลัก
// fallback refresh เองเฉพาะกรณีจำเป็น (token ใกล้หมดอายุและ sellcenter ไม่ได้รีเฟรชให้ทันเวลา)

const SHOPEE_HOST_URL = process.env.SHOPEE_HOST_URL || 'https://partner.shopeemobile.com';
const PARTNER_ID = process.env.SHOPEE_PARTNER_ID;
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;

function sign(baseString) {
  return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}

/**
 * ดึง token document ล่าสุดของร้าน จาก sellcenter's Shp2022Token (read-only)
 * @param {{shop_id?: string, shopname?: string}} query
 */
async function getTokenDoc({ shop_id, shopname }) {
  const ShpToken = getShpTokenModel();
  const filter = shopname ? { shopname } : { shop_id: Number(shop_id) };
  // lean() เพราะเราแค่อ่าน ไม่ต้องการ mongoose document overhead
  return ShpToken.findOne(filter).sort({ access_token_time_unix: -1 }).lean();
}

function isTokenFresh(tokenDoc) {
  if (!tokenDoc || !tokenDoc.access_token || !tokenDoc.access_token_time_unix || !tokenDoc.expire_in) {
    return false;
  }
  const expiresAtUnix = tokenDoc.access_token_time_unix + tokenDoc.expire_in;
  const nowUnix = Math.floor(Date.now() / 1000);
  // เผื่อ buffer 5 นาทีก่อนหมดอายุจริง กัน request ระหว่างทางพัง
  return expiresAtUnix - nowUnix > 300;
}

/**
 * Fallback refresh — ใช้เฉพาะกรณี sellcenter หลักไม่ได้รีเฟรชให้ทันเวลาเท่านั้น
 * ต้อง log ทุกครั้งที่เรียก (megaplan ข้อ 12.1) และ upsert กลับเข้า Shp2022Token
 */
async function fallbackRefreshToken(tokenDoc) {
  if (!PARTNER_KEY) {
    throw new Error('SHOPEE_PARTNER_KEY not set — cannot perform fallback refresh');
  }

  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  // ⚠️ endpoint นี้ sign แบบไม่มี access_token/shop_id (ยืนยันจากโค้ด sellcenter เดิม)
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  const signature = sign(baseString);
  const url = `${SHOPEE_HOST_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${signature}`;

  const body = {
    refresh_token: tokenDoc.refresh_token,
    partner_id: Number(PARTNER_ID),
    shop_id: tokenDoc.shop_id,
  };

  let responseBody;
  let statusCode;
  let errorMsg = '';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    statusCode = res.status;
    responseBody = await res.json();
    if (responseBody.error) {
      errorMsg = responseBody.message || responseBody.error;
    }
  } catch (err) {
    errorMsg = err.message;
  }

  await RequestLog.create({
    platform: 'shopee',
    direction: 'api_out',
    event_type: 'fallback_refresh_token',
    shop_id: String(tokenDoc.shop_id),
    request_payload: { ...body, refresh_token: '[REDACTED]' },
    response_payload: responseBody,
    status_code: statusCode,
    error: errorMsg,
  });

  if (errorMsg || !responseBody || !responseBody.access_token) {
    throw new Error(`fallback refresh failed: ${errorMsg || 'no access_token in response'}`);
  }

  // upsert กลับเข้า Shp2022Token เพื่อไม่ให้ sellcenter หลักใช้ token เก่าซ้ำ
  const ShpToken = getShpTokenModel();
  const nowUnix = Math.floor(Date.now() / 1000);
  await ShpToken.updateOne(
    { shop_id: tokenDoc.shop_id },
    {
      $set: {
        access_token: responseBody.access_token,
        refresh_token: responseBody.refresh_token,
        expire_in: responseBody.expire_in,
        access_token_time_unix: nowUnix,
      },
    }
  );

  return {
    ...tokenDoc,
    access_token: responseBody.access_token,
    refresh_token: responseBody.refresh_token,
    expire_in: responseBody.expire_in,
    access_token_time_unix: nowUnix,
  };
}

// ⚡ cache token สั้นๆ ในหน่วยความจำ — ก่อนหน้านี้ทุก Shopee API call (แม้แต่ 2 call คู่กันในหน้าเดียว, หรือ poll ทุก
// 1-2 วิ) ต้องยิง query ไป sellcenter MongoDB (digital.in.th) ใหม่ทุกครั้ง ไม่มี cache เลย — เป็นสาเหตุหลักของดีเลย์
// 30 วิ สั้นพอที่จะไม่ค้างข้าม token rotation ของ sellcenter (buffer หมดอายุจริงคือ 5 นาที ใน isTokenFresh)
// แต่ยาวพอตัดรอบ query ซ้ำถี่ๆ ระหว่างนั้นได้เกือบทั้งหมด
const TOKEN_CACHE_TTL_MS = 30 * 1000;
const tokenCache = new Map(); // key: shopname || String(shop_id) -> { tokenDoc, cachedAt }

/**
 * ฟังก์ชันหลักที่ adapter เรียกใช้ — คืน access_token ที่ใช้งานได้จริง
 */
async function getValidAccessToken({ shop_id, shopname }) {
  const cacheKey = shopname || String(shop_id);
  const cached = tokenCache.get(cacheKey);
  if (cached && (Date.now() - cached.cachedAt) < TOKEN_CACHE_TTL_MS && isTokenFresh(cached.tokenDoc)) {
    return { access_token: cached.tokenDoc.access_token, shop_id: cached.tokenDoc.shop_id };
  }

  let tokenDoc = await getTokenDoc({ shop_id, shopname });
  if (!tokenDoc) {
    throw new Error(`No token found in sellcenter for shop_id=${shop_id} shopname=${shopname}`);
  }
  if (!isTokenFresh(tokenDoc)) {
    tokenDoc = await fallbackRefreshToken(tokenDoc);
  }

  tokenCache.set(cacheKey, { tokenDoc, cachedAt: Date.now() });
  return {
    access_token: tokenDoc.access_token,
    shop_id: tokenDoc.shop_id,
  };
}

module.exports = { getTokenDoc, isTokenFresh, fallbackRefreshToken, getValidAccessToken };
