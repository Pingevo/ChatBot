const { signAppLevel, PARTNER_ID } = require('./shopeeSign');
const RequestLog = require('../models/RequestLog');

const SHOPEE_HOST_URL = process.env.SHOPEE_HOST_URL || 'https://partner.shopeemobile.com';

// Push codes ที่ Shopee ใช้ (ดู push-mechanism docs)
const PUSH_CODES = {
  SHOP_AUTH: 1,
  SHOP_DEAUTH: 2,
  ORDER_STATUS: 3,
  TRACKING_NO: 4,
  SHOPEE_UPDATES: 5,
  BANNED_ITEM: 6,
  ITEM_PROMOTION: 7,
  RESERVED_STOCK: 8,
  PROMOTION_UPDATE: 9,
  WEBCHAT: 10, // ← สำคัญที่สุดสำหรับระบบแชท
  VIDEO_UPLOAD: 11,
  OPENAPI_AUTH_EXPIRY: 12,
  BRAND_REGISTER: 13,
};

/**
 * เรียก push config endpoint แบบ app-level signing
 * (endpoint กลุ่มนี้ไม่ผูก shop — sign แค่ partner_id + path + timestamp)
 */
async function callPushApi(apiName, { method = 'GET', query = {}, body = null } = {}) {
  const path = `/api/v2/push/${apiName}`;
  const { timestamp, sign } = signAppLevel(path);

  const params = new URLSearchParams({
    partner_id: String(PARTNER_ID),
    timestamp: String(timestamp),
    sign,
    ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
  });

  const url = `${SHOPEE_HOST_URL}${path}?${params.toString()}`;

  let statusCode;
  let parsedResponse;
  let errorMsg = '';

  try {
    const fetchOptions = { method };
    if (body) {
      fetchOptions.headers = { 'Content-Type': 'application/json' };
      fetchOptions.body = JSON.stringify(body);
    }
    const res = await fetch(url, fetchOptions);
    statusCode = res.status;
    const rawText = await res.text();
    parsedResponse = rawText ? JSON.parse(rawText) : {};
    if (parsedResponse.error) {
      errorMsg = parsedResponse.message || parsedResponse.error;
    }
  } catch (err) {
    errorMsg = err.message;
  }

  await RequestLog.create({
    platform: 'shopee',
    direction: 'api_out',
    event_type: apiName,
    request_payload: { path, query, body },
    response_payload: parsedResponse,
    status_code: statusCode,
    error: errorMsg,
  });

  if (errorMsg) {
    throw new Error(`shopee ${apiName} failed: ${errorMsg}`);
  }

  return parsedResponse.response;
}

/**
 * ตั้งค่า callback URL + subscribe/unsubscribe push types
 * @param {string} callbackUrl - HTTPS URL ที่ Shopee จะส่ง push มา (ต้องเป็น HTTPS)
 * @param {number[]} enableCodes - push codes ที่จะเปิดรับ (เช่น [10] สำหรับ webchat)
 * @param {number[]} disableCodes - push codes ที่จะปิด
 */
async function setAppPushConfig({ callbackUrl, enableCodes = [], disableCodes = [] }) {
  const body = {
    callback_url: callbackUrl,
  };
  if (enableCodes.length > 0) body.set_push_config_on = enableCodes;
  if (disableCodes.length > 0) body.set_push_config_off = disableCodes;

  return callPushApi('set_app_push_config', { method: 'POST', body });
}

/**
 * ดึง push config ปัจจุบัน — เช็คว่า callback URL ตั้งถูกไหม และ push ไหนเปิดอยู่
 */
async function getAppPushConfig() {
  return callPushApi('get_app_push_config');
}

/**
 * ดึง push messages ที่หลุด (server ดับตอน Shopee ส่งมา หรือตอบไม่เป็น 2xx)
 * Shopee เก็บ push ที่หลุดไว้ให้ดึงทีหลังได้
 * @param {number} pageSize - จำนวน push ที่จะดึง (max 50)
 */
async function getLostPushMessage({ pageSize = 50 } = {}) {
  return callPushApi('get_lost_push_message', { query: { page_size: pageSize } });
}

/**
 * ยืนยันว่าได้ประมวลผล lost push ที่ดึงไปแล้ว — Shopee จะลบออกจาก lost queue
 * ต้องเรียกหลังจากประมวลผล lost push สำเร็จ ไม่งั้น Shopee จะส่งซ้ำ
 * @param {number[]} messageIds - push message IDs ที่ประมวลผลเสร็จแล้ว
 */
async function confirmConsumedLostPushMessage(messageIds) {
  return callPushApi('confirm_consumed_lost_push_message', {
    method: 'POST',
    body: { push_message_list: messageIds },
  });
}

module.exports = {
  setAppPushConfig,
  getAppPushConfig,
  getLostPushMessage,
  confirmConsumedLostPushMessage,
  PUSH_CODES,
};
