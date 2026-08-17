require('dotenv').config();
const { connectMainDB } = require('../config/db');
const { getSellcenterConnection } = require('../config/sellcenterDb');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const RequestLog = require('../models/RequestLog');
const shopeeAdapter = require('../platforms/shopee-adapter');
const { syncShopsFromSellcenter } = require('../services/shopSync');
const { syncCustomerFromConversation } = require('../services/customerSync');
const { handleNewMessage } = require('../services/chatEvents');

// ⚠️ webhook (webhookWorker.js) คือ real-time delivery หลักอยู่แล้ว (รับ push จาก sellcenter โดยตรง)
// poll ที่นี่เป็นแค่ safety-net เก็บตกข้อความที่ webhook พลาด — ไม่ควรถี่
// กัน .env ตั้ง POLL_INTERVAL_MS ต่ำเกินไปทับ production เฉยๆ (เคยเกิดจริง 2026-08-15 ตั้งไว้ 2000ms
// ทำให้แต่ละรอบ poll ซ้อนทับกันเอง เพราะ 1 รอบดึงจริงใช้เวลานานกว่า 2 วิ — ยิง Shopee API รัวจนกระทบทั้งระบบ)
// production (NODE_ENV=production) บังคับขั้นต่ำ 30 วิ โดย default
// แต่ถ้าตั้งใจอยากทดสอบ poll ถี่กว่านั้นจริงๆ (เช่นบน dev) ให้ set ALLOW_FAST_POLL=true คู่กับ
// POLL_INTERVAL_MS ที่ต้องการ — เป็น opt-in ชัดเจน ป้องกันไม่ให้ตั้ง POLL_INTERVAL_MS เฉยๆ แล้วหลุดมาโดนใน prod
const RAW_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 20000);
const ALLOW_FAST_POLL = process.env.ALLOW_FAST_POLL === 'true';
const PROD_MIN_POLL_INTERVAL_MS = 30000;
const POLL_INTERVAL_MS = (process.env.NODE_ENV === 'production' && !ALLOW_FAST_POLL)
  ? Math.max(RAW_POLL_INTERVAL_MS, PROD_MIN_POLL_INTERVAL_MS)
  : RAW_POLL_INTERVAL_MS;

// ⚠️ get_conversation_list ให้ last_message_timestamp เป็นนาโนวินาที (19 หลัก)
// ส่วน get_message ให้ created_timestamp เป็นวินาที (10 หลัก) — สองหน่วยต่างกันจริง (megaplan ข้อ 2)
function nanosToDate(nanosStr) {
  if (!nanosStr) return null;
  const ms = Number(BigInt(nanosStr) / 1000000n);
  return new Date(ms);
}
function secondsToDate(seconds) {
  if (!seconds) return null;
  return new Date(Number(seconds) * 1000);
}

async function upsertConversation(shop, conv) {
  await Conversation.updateOne(
    { shop_id: shop.shop_id, conversation_id: conv.conversation_id },
    {
      $set: {
        platform: 'shopee',
        to_id: String(conv.to_id),
        to_name: conv.to_name,
        to_avatar: conv.to_avatar,
        unread_count: conv.unread_count,
        pinned: conv.pinned,
        mute: conv.mute,
        last_read_message_id: conv.last_read_message_id ? String(conv.last_read_message_id) : null,
        opposite_last_read_msg_id: conv.opposite_last_read_msg_id ? String(conv.opposite_last_read_msg_id) : null,
        opposite_last_deliver_msg_id: conv.opposite_last_deliver_msg_id ? String(conv.opposite_last_deliver_msg_id) : null,
        latest_message_id: conv.latest_message_id ? String(conv.latest_message_id) : null,
        latest_message_type: conv.latest_message_type,
        latest_message_content: conv.latest_message_content,
        latest_message_from_id: String(conv.latest_message_from_id),
        last_message_timestamp: nanosToDate(conv.last_message_timestamp),
      },
    },
    { upsert: true }
  );
  await syncCustomerFromConversation(conv);
}

async function pollShop(shop) {
  try {
    // ⚠️ ดึง 2 แบบ เพราะ Shopee แยกกัน:
    // - type: 'unread' → conv ที่มีข้อความใหม่ (มี unread_count > 0) — สำคัญที่สุด มีของใหม่จริง
    // - type: 'all' → conv ทั้งหมด (เรียงตาม latest) — sync conv ที่ไม่มี unread แต่มี activity (เช่น admin ส่งออก)
    // ถ้าดึงแค่ type: 'all' จะพลาด conv ที่มี unread เพราะมันไม่ได้อยู่ใน 25 อันแรกของ 'all'
    const [unreadRes, allRes] = await Promise.all([
      shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' }),
      shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'all' }),
    ]);

    // merge + dedup โดยใช้ conversation_id เป็น key (unread มีสิทธิ์ซ้ำกับ all)
    const convMap = new Map();
    for (const conv of [...(allRes.conversations || []), ...(unreadRes.conversations || [])]) {
      convMap.set(String(conv.conversation_id), conv);
    }

    // ⚠️ ดึง "recent conversations" จาก DB ด้วย — conv ที่มี activity ภายใน 2 ชม. ล่าสุด
    // เพราะ Shopee อาจไม่ส่ง conv กลับมาใน list (เช่น หลังเราส่งข้อความไป unread=0 และไม่อยู่ใน 25 อันแรก)
    // แต่ลูกค้าอาจตอบกลับมาทันที — ต้องดึง get_message ตรงๆ เพื่อเช็คของใหม่
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recentDbConvs = await Conversation.find({
      shop_id: shop.shop_id,
      last_message_timestamp: { $gte: twoHoursAgo },
    }).lean();
    for (const dbConv of recentDbConvs) {
      if (!convMap.has(String(dbConv.conversation_id))) {
        // สร้าง object ที่เหมือน format Shopee เพื่อใช้ใน loop ด้านล่าง
        convMap.set(String(dbConv.conversation_id), {
          conversation_id: dbConv.conversation_id,
          unread_count: dbConv.unread_count || 0,
          last_message_timestamp: null, // null = ให้ timestamp delta ตัดสินใจเอง
          _fromDb: true, // mark ว่ามาจาก DB ไม่ใช่ Shopee list
        });
      }
    }

    const conversations = [...convMap.values()];

    for (const conv of conversations) {
      // ⚠️ อ่าน dbTimestamp เก่าจาก DB ก่อนทำการ upsert
      // เพราะถ้า upsertConversation ก่อน findOne จะได้ timestamp ใหม่ที่เพิ่งบันทึก ทำให้ dbTimestamp == shopeeTimestamp เสมอ (hasNewActivity เป็น false ตลอด)
      const existingConv = await Conversation.findOne(
        { shop_id: shop.shop_id, conversation_id: conv.conversation_id },
        { last_message_timestamp: 1 }
      ).lean();

      // upsertConversation เฉพาะ conv ที่มาจาก Shopee (มีข้อมูลเต็ม)
      // conv ที่มาจาก DB ไม่ต้อง upsert เพราะมีอยู่แล้ว
      if (!conv._fromDb) {
        await upsertConversation(shop, conv);
      }

      const shopeeTimestamp = conv.last_message_timestamp ? nanosToDate(conv.last_message_timestamp) : null;
      const dbTimestamp = existingConv?.last_message_timestamp || null;
      const hasNewActivity = !dbTimestamp || (shopeeTimestamp && shopeeTimestamp > dbTimestamp);
      const isFirstSync = !existingConv;
      // ดึงด้วยถ้ามี unread — เพราะอาจเป็น conv ที่มี unread แต่ timestamp ยังไม่อัปเดต
      const hasUnread = conv.unread_count > 0;
      // ⚠️ ดึงเสมอถ้า conv มาจาก DB (recent) — เพราะ Shopee ไม่ส่ง timestamp มา
      // ต้องเช็ค get_message ตรงๆ เพื่อดูว่ามีข้อความใหม่ไหม
      const isRecentFromDb = !!conv._fromDb;

      if (hasNewActivity || isFirstSync || hasUnread || isRecentFromDb) {
        const { messages } = await shopeeAdapter.fetchMessages(shop, conv.conversation_id);
        let newMsgCount = 0;
        // ⚠️ debug log ชั่วคราว — ดูว่าดึง messages ได้กี่ข้อความ สำหรับ conv ที่มีปัญหา
        if (isRecentFromDb || messages.length > 0) {
          console.log(`[poll] debug: shop=${shop.shop_id} conv=${conv.conversation_id} msgs=${messages.length} fromDb=${isRecentFromDb}`);
        }
        // เรียงเก่า→ใหม่ก่อนประมวลผล event — Shopee ให้ messages[0] เป็นข้อความล่าสุด (ใหม่→เก่า)
        // แต่ chatEvents ต้องเห็นลำดับเวลาจริงถึงจะเปิด/ปิด "รอบ" (ChatTurnMetric) ถูกต้อง
        const messagesChronological = [...messages].reverse();
        let convDocForEvents = null; // lazy-load ครั้งแรกที่เจอข้อความใหม่จริง กันยิง DB ทุกข้อความที่ sync ซ้ำ
        for (const msg of messagesChronological) {
          const direction = String(msg.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
          // ⚠️ idempotency: message_id เป็น unique index ใน schema อยู่แล้ว — insert ซ้ำจะ error
          // ใช้ updateOne+upsert แทน insert ตรงๆ กัน error กรณี poll ซ้อนกัน (megaplan ข้อ 12)
          const result = await Message.updateOne(
            { message_id: String(msg.message_id) },
            {
              $set: {
                platform: 'shopee',
                shop_id: shop.shop_id,
                conversation_id: msg.conversation_id,
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
                raw_payload: msg,
              },
            },
            { upsert: true }
          );
          if (result.upsertedCount > 0) {
            newMsgCount++;
            if (!convDocForEvents) {
              convDocForEvents = await Conversation.findOne({ shop_id: shop.shop_id, conversation_id: conv.conversation_id }).lean();
            }
            await handleNewMessage(
              convDocForEvents,
              { message_id: String(msg.message_id), created_timestamp: secondsToDate(msg.created_timestamp) },
              direction
            );
            // refresh เผื่อ handleNewMessage เพิ่ง auto-assign ไป (assigned_to เปลี่ยน) ก่อนข้อความถัดไปในลูปเดียวกัน
            convDocForEvents = await Conversation.findOne({ shop_id: shop.shop_id, conversation_id: conv.conversation_id }).lean();
          }
        }

        // ถ้ามีข้อความใหม่จาก get_message ให้อัปเดต last_message_timestamp, preview และ recent_messages ของ conv
        if (messages.length > 0) {
          const latestMsg = messages[0];
          const latestTs = secondsToDate(latestMsg.created_timestamp);
          const recent10 = messages.slice(0, 10);
          await Conversation.updateOne(
            { shop_id: shop.shop_id, conversation_id: conv.conversation_id },
            {
              $set: {
                last_message_timestamp: latestTs,
                latest_message_id: String(latestMsg.message_id),
                latest_message_type: latestMsg.message_type,
                latest_message_content: latestMsg.content,
                latest_message_from_id: String(latestMsg.from_id),
                recent_messages: recent10,
              },
            }
          );
        }
      }
    }

    await Shop.updateOne(
      { _id: shop._id },
      { $set: { last_polled_at: new Date(), status: 'active' } }
    );

    if (process.env.ENABLE_SUCCESS_LOGS === 'true') {
      await RequestLog.create({
        platform: 'shopee',
        direction: 'poll_in',
        event_type: 'poll_cycle',
        shop_id: shop.shop_id,
        response_payload: { conversation_count: conversations.length },
        status_code: 200,
      });
    }
  } catch (err) {
    console.error(`[poll] shop ${shop.shop_id} error:`, err.message);
    await Shop.updateOne({ _id: shop._id }, { $set: { status: 'token_error' } });
    await RequestLog.create({
      platform: 'shopee',
      direction: 'poll_in',
      event_type: 'poll_cycle',
      shop_id: shop.shop_id,
      error: err.message,
    });
  }
}

let isCycleRunning = false; // ⚠️ กัน setInterval ยิงรอบใหม่ซ้อนรอบเก่าที่ยังไม่จบ (เคยเกิดจริงตอน interval ตั้งไว้ต่ำกว่าเวลาที่ 1 รอบใช้จริง)

async function pollAllShops() {
  if (isCycleRunning) {
    console.warn('[poll] previous cycle still running — skip this tick (interval สั้นกว่าเวลาที่ 1 รอบใช้จริง)');
    return;
  }
  isCycleRunning = true;
  try {
    await pollAllShopsOnce();
  } finally {
    isCycleRunning = false;
  }
}

async function pollAllShopsOnce() {
  // auto-discover shops จาก sellcenter ก่อนทุกรอบ — ร้านใหม่ที่ authorize จะถูกเพิ่มอัตโนมัติ
  try {
    const result = await syncShopsFromSellcenter({ enableForChat: true });
    if (result.upserted > 0) {
      console.log(`[poll] shop sync: ${result.discovered} shops (${result.fresh} fresh, ${result.stale} stale)`);
    }
  } catch (err) {
    console.error('[poll] shop sync failed:', err.message);
  }

  const shops = await Shop.find({ platform: 'shopee', enabled_for_chat: true });
  // รัน pollShop ขนานกันทีละ 10 ร้าน เพื่อให้วนลูปครบรอบเร็วที่สุด (ไม่ค้างที่ร้านเดียว)
  const BATCH_SIZE = 10;
  for (let i = 0; i < shops.length; i += BATCH_SIZE) {
    const chunk = shops.slice(i, i + BATCH_SIZE);
    await Promise.all(chunk.map((shop) => pollShop(shop)));
  }
}

async function main() {
  await connectMainDB();
  // บังคับเชื่อม sellcenter DB ตอน startup (read-only)
  getSellcenterConnection();

  // ⚠️ Kill switch — ถ้า ENABLE_POLL ไม่ใช่ true จะไม่ยิง Shopee API เลย
  // ป้องกันไม่ให้กระทบ Zaapi หรือ Shopee admin ระหว่างพัฒนา
  if (process.env.ENABLE_POLL !== 'true') {
    console.log('[poll] ENABLE_POLL=false — worker จะทำแค่ shop sync (read-only) ไม่ยิง Shopee chat API');
    console.log('[poll] ข้อมูลที่ sync ไว้แล้วยังอยู่ใน DB ใช้ดูได้ปกติ แต่จะไม่ดึงของใหม่');
    // sync แค่ shops (อ่านจาก sellcenter DB เท่านั้น ไม่ยิง Shopee API)
    try {
      const result = await syncShopsFromSellcenter({ enableForChat: true });
      console.log(`[poll] shop sync only: ${result.discovered} shops (${result.fresh} fresh, ${result.stale} stale)`);
    } catch (err) {
      console.error('[poll] shop sync failed:', err.message);
    }
    console.log('[poll] worker หยุดทำงาน — ตั้ง ENABLE_POLL=true เพื่อเริ่มดึงข้อมูลจริง');
    return;
  }

  console.log(`[poll] worker started (POLL ENABLED), interval=${POLL_INTERVAL_MS}ms${ALLOW_FAST_POLL ? ' (ALLOW_FAST_POLL=true — prod floor bypassed)' : ''}`);
  // รันทันทีครั้งแรก แล้วค่อยตั้ง interval
  await pollAllShops();
  setInterval(pollAllShops, POLL_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[poll] fatal error:', err);
    process.exit(1);
  });
}

module.exports = { pollAllShops, pollShop };
