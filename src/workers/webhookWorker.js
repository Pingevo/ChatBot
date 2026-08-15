require('dotenv').config();
const { connectMainDB } = require('../config/db');
const PushEvent = require('../models/PushEvent');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');
const RequestLog = require('../models/RequestLog');

const POLL_INTERVAL_MS = Number(process.env.WEBHOOK_WORKER_INTERVAL_MS || 3000);
const MAX_RETRIES = Number(process.env.WEBHOOK_WORKER_MAX_RETRIES || 5);
const BATCH_SIZE = Number(process.env.WEBHOOK_WORKER_BATCH_SIZE || 20);
// ถ้า event ค้าง processing นานเกิน STALE_MS ถือว่า worker ตายกลางคัน → ดึงกลับมาทำใหม่
const STALE_MS = Number(process.env.WEBHOOK_WORKER_STALE_MS || 60000);

function secondsToDate(seconds) {
  if (!seconds) return null;
  return new Date(Number(seconds) * 1000);
}

/**
 * ดึงข้อมูลจาก webchat_push payload (Code 10)
 * Shopee ส่ง content ครบแล้วใน payload — ไม่ต้องเรียก get_message ซ้ำ
 * payload format:
 *   data.type = "message" | "notification"
 *   data.content = { message_id, conversation_id, from_id, to_id, message_type, content, created_timestamp, ... }
 */
function extractPushData(pushEvent) {
  const data = pushEvent.raw_payload?.data;
  if (!data) return null;

  // type: "notification" (mark_as_replied ฯลฯ) — ไม่ใช่ข้อความ ข้ามได้
  if (data.type === 'notification') {
    return { type: 'notification', conversationId: String(data.content?.conversation_id || '') };
  }

  // type: "message" — ข้อความจริง มี content ครบ
  if (data.type === 'message') {
    const c = data.content || {};
    return {
      type: 'message',
      conversationId: String(c.conversation_id || ''),
      message: {
        message_id: String(c.message_id || ''),
        conversation_id: String(c.conversation_id || ''),
        from_id: String(c.from_id || ''),
        from_shop_id: String(c.from_shop_id || c.shop_id || ''),
        to_id: String(c.to_id || ''),
        to_shop_id: String(c.to_shop_id || ''),
        message_type: c.message_type || 'text',
        content: c.content || {},
        status: c.status || 'normal',
        source: c.source_content || {},
        created_timestamp: c.created_timestamp,
        from_user_name: c.from_user_name || '',
        to_user_name: c.to_user_name || '',
        region: c.region || data.region || '',
        is_in_chatbot_session: c.is_in_chatbot_session || false,
        raw_payload: c,
      },
    };
  }

  // type อื่นๆ — ลองดึง conversation_id จากหลาย field
  return {
    type: 'unknown',
    conversationId: String(data.conversation_id || data.content?.conversation_id || ''),
  };
}

/**
 * ประมวลผล push event 1 รายการ
 * 1. หา shop จาก shop_id
 * 2. ดึงข้อมูลจาก payload โดยตรง (webchat_push ส่ง content ครบแล้ว)
 * 3. บันทึกลง Message collection (idempotent)
 * 4. อัปเดต Conversation
 * 5. อัปเดต PushEvent status=done
 */
async function processPushEvent(pushEvent) {
  // หา shop — ต้องมีในระบบถึงจะบันทึกได้
  const shop = await Shop.findOne({ platform: 'shopee', shop_id: pushEvent.shop_id });
  if (!shop) {
    throw new Error(`shop ${pushEvent.shop_id} not found in DB — skip (will retry)`);
  }

  const pushData = extractPushData(pushEvent);
  if (!pushData || !pushData.conversationId) {
    console.warn(`[webhook-worker] no conversation_id in push ${pushEvent._id} — marking done`);
    await PushEvent.updateOne(
      { _id: pushEvent._id },
      { $set: { status: 'done', completed_at: new Date(), result: { skipped: 'no_conversation_id' } } }
    );
    return;
  }

  // notification type — ไม่ใช่ข้อความ ข้าม (mark_as_replied ฯลฯ)
  if (pushData.type === 'notification') {
    console.log(`[webhook-worker] notification type — skip (conv=${pushData.conversationId})`);
    await PushEvent.updateOne(
      { _id: pushEvent._id },
      { $set: { status: 'done', completed_at: new Date(), result: { skipped: 'notification_type' } } }
    );
    return;
  }

  // unknown type — ข้าม
  if (pushData.type !== 'message') {
    console.warn(`[webhook-worker] unknown push type — skip`);
    await PushEvent.updateOne(
      { _id: pushEvent._id },
      { $set: { status: 'done', completed_at: new Date(), result: { skipped: 'unknown_type' } } }
    );
    return;
  }

  // type: "message" — บันทึกข้อความจาก payload โดยตรง (ไม่ต้องเรียก get_message)
  const msg = pushData.message;
  const direction = String(msg.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';

  await Message.updateOne(
    { message_id: String(msg.message_id) },
    {
      $set: {
        platform: 'shopee',
        shop_id: shop.shop_id,
        conversation_id: String(msg.conversation_id),
        from_id: String(msg.from_id),
        from_shop_id: String(msg.from_shop_id),
        to_id: String(msg.to_id),
        to_shop_id: String(msg.to_shop_id),
        message_type: msg.message_type,
        direction,
        content: msg.content,
        status: msg.status,
        source: msg.source,
        created_timestamp: secondsToDate(msg.created_timestamp),
        raw_payload: msg.raw_payload,
      },
    },
    { upsert: true }
  );

  // อัปเดต Conversation ให้สอดคล้องกับข้อความใหม่
  // ถ้า Conversation ยังไม่มีใน DB ให้ upsert ขึ้นมา (webhook อาจมาก่อน pollWorker)
  const update = {
    $set: {
      platform: 'shopee',
      latest_message_id: String(msg.message_id),
      latest_message_type: msg.message_type,
      latest_message_content: msg.content,
      latest_message_from_id: String(msg.from_id),
      last_message_timestamp: secondsToDate(msg.created_timestamp),
    },
    $setOnInsert: {
      to_id: String(msg.to_id),
      status: 'open',
    },
  };
  // นับ unread เฉพาะข้อความเข้า (in) — ถ้าเป็นข้อความออก (out) ไม่เพิ่ม unread
  if (direction === 'in') {
    update.$inc = { unread_count: 1 };
  }
  await Conversation.updateOne(
    { shop_id: shop.shop_id, conversation_id: pushData.conversationId },
    update,
    { upsert: true }
  );

  // อัปเดต PushEvent — ทำเสร็จ
  await PushEvent.updateOne(
    { _id: pushEvent._id },
    {
      $set: {
        status: 'done',
        completed_at: new Date(),
        result: { conversation_id: pushData.conversationId, message_id: msg.message_id, direction },
      },
    }
  );

  console.log(`[webhook-worker] done: push=${pushEvent._id} conv=${pushData.conversationId} msg=${msg.message_id} dir=${direction}`);
}

/**
 * ดึง batch ของ pending events มาประมวลผล
 * รวม events ที่ "ค้าง processing นานเกินไป" (worker ตายกลางคัน) มาทำใหม่ด้วย
 */
async function processBatch() {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_MS);

  // ดึง pending + stale processing (worker ตายกลางคัน)
  const events = await PushEvent.find({
    $or: [
      { status: 'pending' },
      { status: 'processing', processing_started_at: { $lt: staleThreshold } },
    ],
  })
    .sort({ created_at: 1 }) // FIFO — เก่าสุดก่อน
    .limit(BATCH_SIZE);

  if (events.length === 0) return;

  for (const event of events) {
    // claim event — อัปเดต status=processing พร้อมเวลาเริ่ม
    // ใช้ findOneAndUpdate เพื่อ atomic (กัน worker หลายตัวจับ event เดียวกัน)
    const claimed = await PushEvent.findOneAndUpdate(
      { _id: event._id, status: { $in: ['pending', 'processing'] } },
      {
        $set: {
          status: 'processing',
          processing_started_at: new Date(),
        },
      },
      { new: true }
    );

    if (!claimed) continue; // event ถูก worker อื่นจับไปแล้ว

    try {
      await processPushEvent(claimed);
    } catch (err) {
      // ล้มเหลว — เพิ่ม retry_count แล้วเปลี่ยนกลับเป็น pending (ถ้ายังไม่เกิน max)
      const newRetryCount = claimed.retry_count + 1;
      const shouldRetry = newRetryCount < MAX_RETRIES;

      await PushEvent.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: shouldRetry ? 'pending' : 'failed',
            retry_count: newRetryCount,
            last_error: err.message,
          },
        }
      );

      console.error(`[webhook-worker] failed: push=${claimed._id} retry=${newRetryCount}/${MAX_RETRIES} err=${err.message}`);

      await RequestLog.create({
        platform: 'shopee',
        direction: 'api_out',
        event_type: 'webhook_worker_error',
        shop_id: claimed.shop_id,
        error: err.message,
        response_payload: { push_event_id: claimed._id, retry_count: newRetryCount },
      }).catch(() => {});
    }
  }
}

async function main() {
  await connectMainDB();

  // ⚠️ Kill switch — ถ้า ENABLE_WEBHOOK_WORKER ไม่ใช่ true จะไม่ทำงาน
  if (process.env.ENABLE_WEBHOOK_WORKER !== 'true') {
    console.log('[webhook-worker] ENABLE_WEBHOOK_WORKER=false — worker หยุดทำงาน');
    return;
  }

  console.log(`[webhook-worker] started (interval=${POLL_INTERVAL_MS}ms batch=${BATCH_SIZE} maxRetries=${MAX_RETRIES})`);

  // รันทันทีครั้งแรก แล้วตั้้ง interval
  await processBatch();
  setInterval(async () => {
    try {
      await processBatch();
    } catch (err) {
      console.error('[webhook-worker] batch error:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[webhook-worker] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { processBatch, processPushEvent };
