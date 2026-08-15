const crypto = require('crypto');

const PARTNER_ID = process.env.SHOPEE_PARTNER_ID;
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;

function hmacSign(baseString) {
  return crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
}

/**
 * Shop-level signing (ใช้กับ endpoint ส่วนใหญ่ เช่น sellerchat.*)
 * base_string = partner_id + path + timestamp + access_token + shop_id
 * ⚠️ อย่าใช้ฟังก์ชันนี้กับ push/config endpoint — sign คนละแบบ (ดู signAppLevel)
 */
function signShopLevel(path, accessToken, shopId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`;
  return {
    timestamp,
    sign: hmacSign(baseString),
  };
}

/**
 * App-level signing (ใช้กับ v2.push.set_app_push_config และ endpoint อื่นที่ไม่ผูก shop)
 * base_string = partner_id + path + timestamp  (ไม่มี access_token/shop_id)
 * ⚠️ ยืนยันแล้วจากเอกสารทางการ — endpoint กลุ่มนี้เซ็นต่างจาก endpoint ทั่วไป ถ้าใช้ signShopLevel จะได้ "Invalid sign" ทันที
 */
function signAppLevel(path) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  return {
    timestamp,
    sign: hmacSign(baseString),
  };
}

/**
 * Verify Push Mechanism (webhook) signature
 * Shopee signs: callbackUrl + "|" + rawBody  (raw = exact bytes ที่ Shopee ส่งมา ห้าม re-stringify)
 * ใช้ PARTNER_KEY เป็น HMAC key เหมือน signing ปกติ
 * ⚠️ ต้องใช้ raw body ที่รับจาก Shopee ตรงๆ ห้ามใช้ JSON.stringify(req.body) เพราะ key order/whitespace เปลี่ยนได้
 */
function verifyPushSignature(callbackUrl, rawBody, signature) {
  const baseString = `${callbackUrl}|${rawBody}`;
  const expected = hmacSign(baseString);
  // ใช้ timingSafeEqual กัน timing attack
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signShopLevel, signAppLevel, verifyPushSignature, PARTNER_ID };
