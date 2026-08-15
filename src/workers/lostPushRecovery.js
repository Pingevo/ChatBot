require('dotenv').config();
const { connectMainDB } = require('../config/db');
const PushEvent = require('../models/PushEvent');
const RequestLog = require('../models/RequestLog');
const {
  getLostPushMessage,
  confirmConsumedLostPushMessage,
  PUSH_CODES,
} = require('../services/pushConfig');

// รันทุก 1 ชั่วโมง — ดึง push ที่หลุด (server ดับตอน Shopee ส่งมา หรือตอบไม่เป็น 2xx)
const RECOVERY_INTERVAL_MS = Number(process.env.LOST_PUSH_RECOVERY_INTERVAL_MS || 3600000);

/**
 * ดึง lost push messages จาก Shopee แล้ว insert ลง PushEvent queue
 * หลัง insert เสร็จ ยืนยัน consume กับ Shopee เพื่อลบออกจาก lost queue
 */
async function recoverLostPushes() {
  let recovered = 0;
  let confirmed = 0;

  try {
    // ดึง lost push — Shopee เก็บไว้ให้ดึงทีหลังได้
    const response = await getLostPushMessage({ pageSize: 50 });
    const pushMessages = response?.push_message_list || [];

    if (pushMessages.length === 0) {
      console.log('[lost-push-recovery] no lost pushes found');
      return { recovered: 0, confirmed: 0 };
    }

    console.log(`[lost-push-recovery] found ${pushMessages.length} lost pushes`);

    const confirmedIds = [];

    for (const push of pushMessages) {
      // สนใจเฉพาะ webchat_push (Code 10)
      if (push.code !== PUSH_CODES.WEBCHAT) {
        // ยืนยัน consume แม้ไม่สนใจ เพื่อไม่ให้ค้างใน lost queue
        confirmedIds.push(push.push_message_id || push.id);
        continue;
      }

      const shopId = String(push.shop_id);
      const timestamp = push.timestamp ? new Date(Number(push.timestamp) * 1000) : null;
      const rawData = typeof push.data === 'string' ? JSON.parse(push.data) : push.data;

      // idempotency — ใช้ dedup_key เดียวกับ webhook receiver
      const dedupKey = `shopee:${shopId}:${push.timestamp}:lost:${require('crypto')
        .createHash('md5').update(JSON.stringify(push)).digest('hex').slice(0, 16)}`;

      try {
        await PushEvent.updateOne(
          { dedup_key: dedupKey },
          {
            $setOnInsert: {
              platform: 'shopee',
              push_code: push.code,
              shop_id: shopId,
              timestamp,
              raw_payload: { code: push.code, shop_id: push.shop_id, timestamp: push.timestamp, data: rawData },
              status: 'pending',
              dedup_key: dedupKey,
            },
          },
          { upsert: true }
        );
        recovered++;
      } catch (err) {
        console.error(`[lost-push-recovery] insert failed for shop=${shopId}: ${err.message}`);
      }

      // เก็บ ID เพื่อยืนยัน consume ทีหลัง
      const pushId = push.push_message_id || push.id;
      if (pushId) confirmedIds.push(pushId);
    }

    // ยืนยัน consume กับ Shopee — ลบออกจาก lost queue
    if (confirmedIds.length > 0) {
      try {
        await confirmConsumedLostPushMessage(confirmedIds);
        confirmed = confirmedIds.length;
        console.log(`[lost-push-recovery] confirmed ${confirmed} consumed`);
      } catch (err) {
        console.error(`[lost-push-recovery] confirm failed: ${err.message}`);
        // ไม่ throw — จะได้ดึงซ้ำรอบหน้า และ idempotency จะดักซ้ำอยู่แล้ว
      }
    }

    await RequestLog.create({
      platform: 'shopee',
      direction: 'poll_in',
      event_type: 'lost_push_recovery',
      response_payload: { found: pushMessages.length, recovered, confirmed },
      status_code: 200,
    });
  } catch (err) {
    console.error('[lost-push-recovery] error:', err.message);
    await RequestLog.create({
      platform: 'shopee',
      direction: 'poll_in',
      event_type: 'lost_push_recovery',
      error: err.message,
    }).catch(() => {});
  }

  return { recovered, confirmed };
}

async function main() {
  await connectMainDB();

  if (process.env.ENABLE_LOST_PUSH_RECOVERY !== 'true') {
    console.log('[lost-push-recovery] ENABLE_LOST_PUSH_RECOVERY=false — หยุดทำงาน');
    return;
  }

  console.log(`[lost-push-recovery] started (interval=${RECOVERY_INTERVAL_MS}ms)`);

  // รันทันทีครั้งแรก แล้วตั้ง interval
  await recoverLostPushes();
  setInterval(async () => {
    try {
      await recoverLostPushes();
    } catch (err) {
      console.error('[lost-push-recovery] unexpected error:', err.message);
    }
  }, RECOVERY_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[lost-push-recovery] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { recoverLostPushes };
