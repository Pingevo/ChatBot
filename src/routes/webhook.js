const express = require('express');
const router = express.Router();
const PushEvent = require('../models/PushEvent');
const RequestLog = require('../models/RequestLog');
const { verifyPushSignature } = require('../services/shopeeSign');

// Push codes ที่ Shopee ใช้ (ดู push-mechanism docs)
// 10 = webchat_push — แจ้งว่ามีข้อความแชทใหม่จาก buyer
const PUSH_CODE = {
  WEBCHAT: 10,
};

// URL ของระบบเดิม — chat-center จะ forward push ที่ไม่ใช่ Code 10 ไปที่นี่
// เพื่อไม่ให้ระบบเดิม (sellcenter) พังเมื่อเปลี่ยน callback URL มา chat-center
const LEGACY_FORWARD_URL = process.env.SHOPEE_PUSH_LEGACY_FORWARD_URL || 'https://sales.digital.in.th/shp/push';

// ⚠️ raw body ถูกจับที่ global express.json() ใน server.js (verify hook)
// ไม่ต้องตั้ง express.json ซ้ำที่นี่ — จะทำให้ raw body หาย

/**
 * POST /webhook/shopee — callback URL ที่ Shopee ส่ง push มา
 *
 * ทำ 4 อย่าง ตอบ 200 ทันที (Shopee timeout 2 วินาที):
 * 1. ตรวจ signature (กัน fake request)
 * 2. ดึง push code + shop_id + data
 * 3. ถ้า Code 10 (webchat) → insert ลง PushEvent queue
 * 4. ถ้า Code อื่น → forward ไประบบเดิม (LEGACY_FORWARD_URL)
 *
 * ไม่ประมวลผลข้อความที่นี่ — worker ดึงจาก queue ไปทำต่างหาก
 */
router.post('/shopee', async (req, res) => {
  const rawBody = req.rawBody || '';
  const callbackUrl = process.env.SHOPEE_PUSH_CALLBACK_URL || '';

  // 0. ⚠️ กรณีพิเศษ: Verification message (code=0, มี verify_info)
  // Shopee ส่ง test push นี้มาเพื่อ verify callback URL ตอน set_app_push_config
  // ไม่ต้องตรวจ signature — แค่ตอบ 200 ทันที (Shopee ไม่ sign verification message)
  const body = req.body || {};
  if (body.code === 0 && body.data && body.data.verify_info) {
    console.log('[webhook] verification message — ack 200');
    return res.status(200).end();
  }

  // 1. ตรวจ signature — ถ้าไม่ผ่านปฏิเสธทันที (กัน spoofing)
  const signature = req.headers.authorization || '';
  if (!callbackUrl) {
    console.error('[webhook] SHOPEE_PUSH_CALLBACK_URL not set — cannot verify signature');
    return res.status(500).end();
  }

  const isValid = verifyPushSignature(callbackUrl, rawBody, signature);
  if (!isValid) {
    console.warn('[webhook] invalid signature — rejected');
    await RequestLog.create({
      platform: 'shopee',
      direction: 'poll_in',
      event_type: 'webhook_invalid_signature',
      status_code: 401,
      error: 'signature verification failed',
    }).catch(() => {});
    return res.status(401).end();
  }

  // 2. ดึงข้อมูลจาก push payload
  const { code, shop_id, timestamp, data } = body;

  // ตอบ 200 เสมอถ้า signature ผ่าน — แม้จะไม่รู้จัก code ก็ตาม
  // เพื่อไม่ให้ Shopee retry (retry มากไปอาจถูก suspend push)
  if (!code || !shop_id) {
    console.warn('[webhook] missing code or shop_id — ack only');
    return res.status(200).end();
  }

  // 3. สนใจเฉพาะ webchat_push (Code 10) — insert ลง queue
  if (code === PUSH_CODE.WEBCHAT) {
    const dedupKey = `shopee:${shop_id}:${timestamp}:${require('crypto')
      .createHash('md5').update(rawBody).digest('hex').slice(0, 16)}`;

    try {
      await PushEvent.updateOne(
        { dedup_key: dedupKey },
        {
          $setOnInsert: {
            platform: 'shopee',
            push_code: code,
            shop_id: String(shop_id), // String เสมอ (int64 precision)
            timestamp: timestamp ? new Date(Number(timestamp) * 1000) : null,
            raw_payload: req.body,
            status: 'pending',
            dedup_key: dedupKey,
          },
        },
        { upsert: true }
      );
      console.log(`[webhook] queued: shop=${shop_id} code=${code} dedup=${dedupKey}`);
    } catch (err) {
      // ถ้า insert ล้มเหลว ยังตอบ 200 เพื่อไม่ให้ Shopee retry
      console.error(`[webhook] insert failed (ack anyway): ${err.message}`);
    }
  } else {
    // 4. Code อื่น (3=order, 4=tracking, 29, ฯลฯ) — forward ไประบบเดิม
    // ทำแบบ fire-and-forget ไม่รอผล (Shopee timeout 2 วินาที)
    console.log(`[webhook] code=${code} shop=${shop_id} — forwarding to legacy`);
    try {
      await fetch(LEGACY_FORWARD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: signature },
        body: rawBody,
      });
    } catch (err) {
      console.error(`[webhook] forward to legacy failed: ${err.message}`);
    }
  }

  // ตอบ 200 ทันที — ไม่รอประมวลผล (Shopee timeout 2 วินาที)
  res.status(200).end();
});

// Health check endpoint — ใช้ตรวจสอบว่า webhook receiver ยังทำงานอยู่
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'shopee-webhook-receiver' });
});

module.exports = router;
