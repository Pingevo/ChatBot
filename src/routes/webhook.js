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

// ═══ Shopee ลงทะเบียน callback URL ได้เส้นเดียวต่อ partner ═══
// ตอนนี้เส้นที่ลงทะเบียนจริงคือของ sellcenter (/shp/push) ไม่ใช่ /webhook/shopee ข้างล่างนี้
// (ดู sellcenter/api/services/WebhookAuthService.js) — chat-center เลยไม่เคยได้รับ push ตรงจาก
// Shopee เลยในทางปฏิบัติ sellcenter เป็นคน "รับจริง" แล้ว forward code 10 มาที่ /internal/shopee-forward
// ด้านล่างแทน ใช้ shared secret แทน HMAC ของ Shopee เพราะ payload นี้ไม่ได้ถูกเซ็นด้วย URL ของเรา
// (เซ็นด้วย URL ของ sellcenter) จึง verifyPushSignature ที่นี่ไม่มีทางผ่านอยู่แล้ว
const INTERNAL_FORWARD_SECRET = process.env.INTERNAL_FORWARD_SECRET || '';

// ⚠️ raw body ถูกจับที่ global express.json() ใน server.js (verify hook)
// ไม่ต้องตั้ง express.json ซ้ำที่นี่ — จะทำให้ raw body หาย

/**
 * เข้าคิว webchat_push (Code 10) ลง PushEvent — ใช้ร่วมกันทั้งตอนรับตรงจาก Shopee
 * (/shopee) และตอนรับ forward มาจาก sellcenter (/internal/shopee-forward)
 *
 * dedupKey คำนวณจาก rawBody ตรงๆ (bytes ดิบ) เพื่อให้ Shopee retry push เดิม (ไม่ว่าจะมาทาง
 * ไหน) ยุบเหลือ event เดียวกันเสมอ — ต้องได้ rawBody ตัวเดียวกับที่ Shopee เซ็นจริง
 */
async function queueWebchatPush(body, rawBody) {
  const { code, shop_id, timestamp } = body;
  const dedupKey = `shopee:${shop_id}:${timestamp}:${require('crypto')
    .createHash('md5').update(rawBody).digest('hex').slice(0, 16)}`;

  await PushEvent.updateOne(
    { dedup_key: dedupKey },
    {
      $setOnInsert: {
        platform: 'shopee',
        push_code: code,
        shop_id: String(shop_id), // String เสมอ (int64 precision)
        timestamp: timestamp ? new Date(Number(timestamp) * 1000) : null,
        raw_payload: body,
        status: 'pending',
        dedup_key: dedupKey,
      },
    },
    { upsert: true }
  );
  return dedupKey;
}

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
    try {
      const dedupKey = await queueWebchatPush(body, rawBody);
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

/**
 * POST /webhook/internal/shopee-forward — sellcenter เรียกมาที่นี่ทุกครั้งที่ได้ push code 10
 * จาก Shopee จริง (Shopee ลงทะเบียน callback ไว้ที่ sellcenter เส้นเดียว เห็นก่อนเราเสมอ)
 *
 * ไม่ใช่ Shopee ส่งตรง — ตรวจด้วย shared secret (X-Internal-Secret) แทน HMAC ของ Shopee
 * เพราะ payload นี้เซ็นด้วย URL ของ sellcenter ไม่ใช่ของเรา verifyPushSignature ที่นี่ไม่มีทางผ่าน
 *
 * รับเฉพาะ code 10 — code อื่น sellcenter จัดการเองอยู่แล้ว ไม่ต้อง forward มาซ้ำ
 */
router.post('/internal/shopee-forward', async (req, res) => {
  const given = req.headers['x-internal-secret'] || '';
  if (!INTERNAL_FORWARD_SECRET) {
    console.error('[webhook] INTERNAL_FORWARD_SECRET not set — reject internal forward');
    return res.status(500).end();
  }
  if (given !== INTERNAL_FORWARD_SECRET) {
    console.warn('[webhook] internal forward: secret ไม่ตรง — ปฏิเสธ');
    return res.status(401).end();
  }

  const body = req.body || {};
  const rawBody = req.rawBody || '';
  if (body.code !== PUSH_CODE.WEBCHAT || !body.shop_id) {
    return res.status(200).end(); // ไม่ใช่ code 10 หรือข้อมูลไม่ครบ — ack เฉยๆ
  }

  try {
    const dedupKey = await queueWebchatPush(body, rawBody);
    console.log(`[webhook] queued (via sellcenter forward): shop=${body.shop_id} dedup=${dedupKey}`);
  } catch (err) {
    console.error(`[webhook] internal forward insert failed: ${err.message}`);
  }
  res.status(200).end();
});

// Health check endpoint — ใช้ตรวจสอบว่า webhook receiver ยังทำงานอยู่
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'shopee-webhook-receiver' });
});

module.exports = router;
