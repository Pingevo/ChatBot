const express = require('express');
const router = express.Router();

const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Customer = require('../models/Customer');
const UserSetting = require('../models/UserSetting');
const shopeeAdapter = require('../platforms/shopee-adapter');
const { syncCustomerFromConversation } = require('../services/customerSync');

// ⚠️ ตอนนี้ยังไม่มีระบบ login จริง — ใช้ 'admin' เป็น default user ชั่วคราว
// พอมีระบบ auth ทีหลังค่อยเปลี่ยนเป็น user_id จริงจาก session/token
const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || 'admin';

async function getOrCreateUserSetting() {
  const setting = await UserSetting.findOne({ user_id: DEFAULT_USER_ID });
  if (setting) return setting;
  return await UserSetting.create({ user_id: DEFAULT_USER_ID, theme: 'blue', mode: 'light' });
}

// GET /api/shops — list ร้านที่เปิดใช้แชท + สถานะ (อ่านจาก sellcenter แบบ read-only ผ่าน status field)
router.get('/shops', async (req, res) => {
  const shops = await Shop.find({}).sort({ shop_name: 1 });
  res.json(shops);
});

// ⛔ ปิดใช้งานแล้ว (ไม่ใช่ทางหลักอีกต่อไป) — เดิมฟังก์ชันนี้ยิง Shopee API จริงทุก 2 วิ
// (throttle ต่อ process แต่ "ต่อ browser tab ที่เปิด inbox ค้างไว้" ไม่ถูกแคป) ทำงานซ้ำกับ
// pollWorker.js เกือบทุกอย่าง (ดึง conversation list ทั้ง unread+all เหมือนกัน) เพียงแต่ถี่กว่า
// 10 เท่าโดยไม่ได้ประโยชน์เพิ่ม ตอนนี้ทางหลักคือ webhook (sellcenter forward code 10 →
// ChatBot/src/routes/webhook.js → PushEvent → webhookWorker.js → Message/Conversation เรียลไทม์)
// ส่วน pollWorker.js (20 วิ) ยังเก็บไว้เป็น reconciliation — ไม่ใช่แค่ safety net ตอน webhook
// เสีย แต่ยัง sync unread_count/pinned/mute ที่เปลี่ยนจากฝั่ง Shopee ตรงๆ (เช่น notification-type
// push code 10 ที่ webhookWorker.js ข้ามทิ้งเฉยๆ ไม่อัปเดตอะไรเลย — ดู webhookWorker.js บรรทัด
// "notification type — skip") ซึ่ง webhook คนเดียวไม่มีทางรู้ได้
//
// let lastBackgroundSyncTime = 0;
// async function triggerBackgroundConversationsSync() {
//   const now = Date.now();
//   if (now - lastBackgroundSyncTime < 2000) return; // throttle background sync every 2s (ultra-fast Shopee fetch)
//   lastBackgroundSyncTime = now;
//
//   try {
//     const shops = await Shop.find({});
//     for (const shop of shops) {
//       if (shop.platform === 'shopee') {
//         const [unreadRes, allRes] = await Promise.all([
//           shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' }).catch(() => null),
//           shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'all' }).catch(() => null),
//         ]);
//         const convList = [...((unreadRes && unreadRes.conversations) || []), ...((allRes && allRes.conversations) || [])];
//         const seen = new Set();
//         for (const conv of convList) {
//           if (!conv || !conv.conversation_id || seen.has(String(conv.conversation_id))) continue;
//           seen.add(String(conv.conversation_id));
//           const lastTs = conv.last_message_timestamp ? new Date(Number(BigInt(conv.last_message_timestamp) / 1000000n)) : null;
//           await Conversation.updateOne(
//             { shop_id: String(shop.shop_id), conversation_id: String(conv.conversation_id) },
//             {
//               $set: {
//                 platform: 'shopee',
//                 to_id: String(conv.to_id),
//                 to_name: conv.to_name,
//                 to_avatar: conv.to_avatar,
//                 unread_count: conv.unread_count,
//                 pinned: conv.pinned,
//                 mute: conv.mute,
//                 latest_message_id: conv.latest_message_id ? String(conv.latest_message_id) : null,
//                 latest_message_type: conv.latest_message_type,
//                 latest_message_content: conv.latest_message_content,
//                 latest_message_from_id: String(conv.latest_message_from_id),
//                 last_message_timestamp: lastTs,
//               },
//             },
//             { upsert: true }
//           );
//         }
//       }
//     }
//   } catch (err) {
//     /* ignore background sync errors */
//   }
// }

// GET /api/conversations — list conversations, filter ผ่าน query
// ?type=all|pinned|unread|answered  &platform=shopee,lazada  (คั่นด้วยจุลภาค)  &shop_id=id1,id2  &q=ค้นหาชื่อ
router.get('/conversations', async (req, res) => {
  const { shop_id, type = 'all', platform, q } = req.query;
  const filter = {};
  if (shop_id) {
    const ids = shop_id.split(',').map(s => s.trim()).filter(Boolean);
    filter.shop_id = ids.length === 1 ? ids[0] : { $in: ids };
  }
  if (platform) {
    const plats = platform.split(',').map(s => s.trim()).filter(Boolean);
    filter.platform = plats.length === 1 ? plats[0] : { $in: plats };
  }
  if (type === 'pinned') filter.pinned = true;
  if (type === 'unread') filter.unread_count = { $gt: 0 };
  if (type === 'answered') filter.unread_count = 0;
  if (q) filter.to_name = { $regex: q, $options: 'i' };

  // ⛔ ปิดใช้งานแล้ว — ไม่ใช่ทางหลักอีกต่อไป ตอนนี้มี webhook (เรียลไทม์) + pollWorker.js
  // (20 วิ, reconciliation) sync ให้อยู่แล้ว ไม่ต้องยิง Shopee API ซ้ำทุกครั้งที่เปิดหน้า inbox
  // ดูเหตุผลเต็มๆ ที่ comment เหนือฟังก์ชัน triggerBackgroundConversationsSync ด้านบน
  // triggerBackgroundConversationsSync();

  const conversations = await Conversation.find(filter).sort({ pinned: -1, last_message_timestamp: -1 }).limit(100).lean();
  res.json(conversations);
});

// GET /api/conversations/counts — จำนวนจริงทั้งหมด/ยังไม่อ่าน/ตอบแล้ว/ปักหมุด (ไม่ผูกกับ limit 100 ของ list ด้านบน)
// รองรับ platform/shop_id filter เดียวกัน เพื่อให้ตัวเลขบน quick-view pills ตรงกับตัวกรองที่เลือกอยู่
router.get('/conversations/counts', async (req, res) => {
  const { shop_id, platform } = req.query;
  const filter = {};
  if (shop_id) {
    const ids = shop_id.split(',').map(s => s.trim()).filter(Boolean);
    filter.shop_id = ids.length === 1 ? ids[0] : { $in: ids };
  }
  if (platform) {
    const plats = platform.split(',').map(s => s.trim()).filter(Boolean);
    filter.platform = plats.length === 1 ? plats[0] : { $in: plats };
  }

  const [all, unread, answered, pinned] = await Promise.all([
    Conversation.countDocuments(filter),
    Conversation.countDocuments({ ...filter, unread_count: { $gt: 0 } }),
    Conversation.countDocuments({ ...filter, unread_count: 0 }),
    Conversation.countDocuments({ ...filter, pinned: true }),
  ]);
  res.json({ all, unread, answered, pinned });
});

// GET /api/customers — ตารางรายชื่อลูกค้า (Customer Directory) ค้นหาและดูง่าย
router.get('/customers', async (req, res) => {
  const { q, platform } = req.query;
  const filter = {};
  if (platform) filter.platform = platform;
  if (q) filter.name = { $regex: q, $options: 'i' };

  const customers = await Customer.find(filter).sort({ last_active_at: -1 }).limit(100);
  res.json(customers);
});

// GET /api/conversations/:id — รายละเอียดแชทเดียว (จาก local DB ไม่ยิง Shopee ตรง เพื่อลด API call)
router.get('/conversations/:id', async (req, res) => {
  const conv = await Conversation.findOne({ conversation_id: req.params.id });
  if (!conv) return res.status(404).json({ error: 'not_found' });
  res.json(conv);
});

// GET /api/conversations/:id/messages — ดึงประวัติข้อความ (พร้อม sync ข้อมูลล่าสุดจาก Shopee API ทันที)
router.get('/conversations/:id/messages', async (req, res) => {
  let conv = null;
  try {
    conv = await Conversation.findOne({ conversation_id: req.params.id });
    if (conv) {
      const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform });
      if (shop) {
        // 1. ดึงรายละเอียด conversation ล่าสุดจาก Shopee เพื่อให้ได้ opposite_last_read_msg_id
        try {
          const detail = await shopeeAdapter.fetchOneConversation(shop, conv.conversation_id);
          if (detail && detail.opposite_last_read_msg_id) {
            const oppReadId = String(detail.opposite_last_read_msg_id);
            await Conversation.updateOne({ _id: conv._id }, { $set: { opposite_last_read_msg_id: oppReadId } });
            conv.opposite_last_read_msg_id = oppReadId;
          }
        } catch (e) { /* ignore single conv fetch error */ }

        // 2. ดึงข้อความล่าสุดจาก Shopee API
        const { messages } = await shopeeAdapter.fetchMessages(shop, conv.conversation_id);
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            const direction = String(msg.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
            await Message.updateOne(
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
                  created_timestamp: msg.created_timestamp ? new Date(Number(msg.created_timestamp) * 1000) : null,
                  raw_payload: msg,
                },
              },
              { upsert: true }
            );
          }
          const latestMsg = messages[0];
          const latestTs = latestMsg.created_timestamp ? new Date(Number(latestMsg.created_timestamp) * 1000) : null;
          await Conversation.updateOne(
            { _id: conv._id },
            {
              $set: {
                last_message_timestamp: latestTs,
                latest_message_id: String(latestMsg.message_id),
                latest_message_type: latestMsg.message_type,
                latest_message_content: latestMsg.content,
                latest_message_from_id: String(latestMsg.from_id),
                recent_messages: messages.slice(0, 10),
              },
            }
          );
        }
      }
    }
  } catch (err) {
    // ถ้าเกิดข้อผิดพลาดในการยิง API ใช้ข้อมูลที่มีใน local DB ทำงานต่อ
  }

  const rawMessages = await Message.find({ conversation_id: req.params.id }).sort({ created_timestamp: 1 }).lean();

  // หาเวลาของข้อความขาเข้าล่าสุดจากลูกค้า (เพื่อใช้เช็คว่าลูกค้าตอบกลับหลังส่งข้อความออกไปหรือไม่)
  let latestIncomingTs = null;
  for (const m of rawMessages) {
    if (m.direction === 'in' && m.created_timestamp) {
      const ts = new Date(m.created_timestamp).getTime();
      if (!latestIncomingTs || ts > latestIncomingTs) latestIncomingTs = ts;
    }
  }

  const oppReadId = conv?.opposite_last_read_msg_id ? BigInt(conv.opposite_last_read_msg_id) : null;

  // คำนวณ delivery_status (read, sent, failed) สำหรับข้อความขาออก
  const messages = rawMessages.map(m => {
    if (m.direction === 'out') {
      let delivery_status = 'sent';
      if (m.status === 'failed' || m.status === 'error') {
        delivery_status = 'failed';
      } else {
        const msgTs = m.created_timestamp ? new Date(m.created_timestamp).getTime() : 0;
        const msgBigId = m.message_id && !m.message_id.startsWith('out-') ? BigInt(m.message_id) : null;

        const isReadByOppId = oppReadId && msgBigId && msgBigId <= oppReadId;
        const isReadByReply = latestIncomingTs && msgTs && latestIncomingTs >= msgTs;

        if (m.read_by_recipient || isReadByOppId || isReadByReply) {
          delivery_status = 'read';
        }
      }
      return { ...m, delivery_status };
    }
    return m;
  });

  res.json(messages);
});

// POST /api/conversations/:id/reply — ส่งข้อความออก (ผ่าน kill switch ENABLE_SEND_MESSAGE ในตัว adapter)
router.post('/conversations/:id/reply', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id });
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform });
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    const { text, sourceContent } = req.body;

    // ⚠️ Guard: จำกัด 5 ข้อความติดกันก่อน buyer ตอบ (megaplan ข้อ 2.2.3 + 12.4)
    // นับข้อความ out ล่าสุดติดกัน ถ้าเกิน 5 บล็อกก่อนยิง Shopee (กันโดน reach_5_message_limit)
    const recentMessages = await Message.find({ conversation_id: conv.conversation_id })
      .sort({ created_timestamp: -1 })
      .limit(5)
      .select('direction');
    let consecutiveOut = 0;
    for (const m of recentMessages) {
      if (m.direction === 'out') consecutiveOut++;
      else break; // เจอ in หยุดนับ
    }
    if (consecutiveOut >= 5) {
      return res.status(400).json({
        error: 'reach_5_message_limit',
        message: 'ส่งได้สูงสุด 5 ข้อความติดกันก่อนลูกค้าตอบ — รอลูกค้าตอบก่อนส่งเพิ่ม (กฎของ Shopee)',
      });
    }

    // ⚠️ Guard: ข้อความ text ยาวไม่เกิน 600 ตัวอักษร (megaplan ข้อ 2.2.4)
    if (text && text.length > 600) {
      return res.status(400).json({
        error: 'message_too_long',
        message: 'ข้อความยาวเกิน 600 ตัวอักษร (กฎของ Shopee)',
      });
    }

    const result = await shopeeAdapter.sendMessage(shop, {
      toId: conv.to_id,
      conversationId: conv.conversation_id,
      messageType: 'text',
      content: { text },
      sourceContent, // ⚠️ ต้องมีถ้าเป็นข้อความแรกของ conversation ใหม่ (megaplan ข้อ 2.2)
    });

    // บันทึกข้อความที่ส่งออกลง local DB — ให้ admin เห็นข้อความตัวเองในหน้าแชท
    // ใช้ message_id ที่ Shopee ตอบกลับมา (ถ้ามี) เป็น idempotency key
    const sentMessageId = result?.message_id ? String(result.message_id) : `out-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await Message.updateOne(
      { message_id: sentMessageId },
      {
        $set: {
          platform: 'shopee',
          shop_id: shop.shop_id,
          conversation_id: conv.conversation_id,
          from_id: String(shop.shop_id),
          from_shop_id: String(shop.shop_id),
          to_id: String(conv.to_id),
          to_shop_id: null,
          message_type: 'text',
          direction: 'out',
          content: { text },
          status: 'normal',
          source: 'openapi',
          created_timestamp: new Date(),
          raw_payload: result,
          reply_source: 'manual',
        },
      },
      { upsert: true }
    );

    // อัปเดต Conversation ให้สอดคล้องกับข้อความล่าสุดที่ส่ง
    await Conversation.updateOne(
      { _id: conv._id },
      {
        $set: {
          latest_message_id: sentMessageId,
          latest_message_type: 'text',
          latest_message_content: { text },
          latest_message_from_id: String(shop.shop_id),
          last_message_timestamp: new Date(),
        },
      }
    );

    res.json(result);
  } catch (err) {
    // error_code จาก Shopee เช่น user_is_forbidden / reach_5_message_limit / first_chat_without_order_info
    // เป็น business rule ไม่ใช่ bug ของระบบ — ส่งกลับให้ UI แสดงผลตรงๆ (megaplan ข้อ 2.2)
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/send-image — ส่งรูปภาพในแชท
router.post('/conversations/:id/send-image', async (req, res) => {
  const { url, base64 } = req.body;
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id });
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform });
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    let imageUrl = url;
    if (!imageUrl && base64) {
      const uploadRes = await shopeeAdapter.uploadImage(shop, base64);
      if (uploadRes && uploadRes.url) imageUrl = uploadRes.url;
    }
    if (!imageUrl) {
      return res.status(400).json({ error: 'invalid_image_data', message: 'ไม่สามารถอัปโหลดรูปภาพไปยัง Shopee ได้' });
    }

    const result = await shopeeAdapter.sendMessage(shop, {
      toId: conv.to_id,
      conversationId: conv.conversation_id,
      messageType: 'image',
      content: { image_url: imageUrl },
    });

    const sentMessageId = result?.message_id ? String(result.message_id) : `out-img-${Date.now()}`;
    await Message.updateOne(
      { message_id: sentMessageId },
      {
        $set: {
          platform: 'shopee',
          shop_id: shop.shop_id,
          conversation_id: conv.conversation_id,
          from_id: String(shop.shop_id),
          from_shop_id: String(shop.shop_id),
          to_id: String(conv.to_id),
          message_type: 'image',
          direction: 'out',
          content: { url: imageUrl, image_url: imageUrl },
          status: 'normal',
          source: 'openapi',
          created_timestamp: new Date(),
          raw_payload: result,
          reply_source: 'manual',
        },
      },
      { upsert: true }
    );

    await Conversation.updateOne(
      { _id: conv._id },
      {
        $set: {
          latest_message_id: sentMessageId,
          latest_message_type: 'image',
          latest_message_content: { url: imageUrl },
          latest_message_from_id: String(shop.shop_id),
          last_message_timestamp: new Date(),
        },
      }
    );

    res.json({ success: true, url: imageUrl, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/send-video — อัปโหลดวิดีโอและส่งให้ลูกค้าทาง Shopee
router.post('/conversations/:id/send-video', async (req, res) => {
  try {
    const { video_data, video_id } = req.body;
    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).lean();
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    let videoInfo = { vid: video_id };
    if (!video_id && video_data) {
      videoInfo = await shopeeAdapter.uploadVideoAndWait(shop, video_data);
    }

    if (!videoInfo || !videoInfo.vid) {
      return res.status(400).json({ error: 'video_upload_failed', message: 'ไม่สามารถอัปโหลดวิดีโอไปยัง Shopee ได้' });
    }

    // สร้าง Full Video URL ไว้ใช้แสดงผลใน Chat Center เท่านั้น (ใช้โดเมนหลัก Shopee Thailand CDN: cvf.shopee.co.th/file)
    // ⚠️ ห้ามส่ง URL ที่ประกอบขึ้นเองแบบนี้ไปให้ Shopee — send_message ต้องใช้ค่า "video"/"thumbnail" ดิบจาก
    // get_video_upload_result ตรงๆ ตามที่ v2.sellerchat.send_message doc ระบุ (ดู contentPayload ด้านล่าง)
    let fullVideoUrl = videoInfo.video || '';
    if (fullVideoUrl && !fullVideoUrl.startsWith('http')) {
      fullVideoUrl = `https://cvf.shopee.co.th/file/${fullVideoUrl.replace(/^\//, '')}`;
    }
    let fullThumbUrl = videoInfo.thumbnail || '';
    if (fullThumbUrl && !fullThumbUrl.startsWith('http')) {
      fullThumbUrl = `https://cf.shopee.co.th/file/${fullThumbUrl.replace(/^\//, '')}`;
    }

    // Payload ที่ยิงให้ Shopee จริง — field name/ค่าตรงตาม v2.sellerchat.send_message doc:
    // vid, video_url (=ค่า "video" ดิบ), thumb_url (=ค่า "thumbnail" ดิบ), thumb_width/height, duration_seconds (วินาที ไม่ใช่ ms, จำกัด 1-180s)
    const shopeeContentPayload = {
      vid: videoInfo.vid,
      video_url: videoInfo.video,
      thumb_url: videoInfo.thumbnail,
      thumb_width: videoInfo.width,
      thumb_height: videoInfo.height,
      duration_seconds: Math.min(180, Math.max(1, Math.round((videoInfo.duration || 1000) / 1000))),
    };

    // Payload ที่เก็บลง DB ของเราเอง — ใช้ full URL เพื่อ render <video> ในหน้า Chat Center
    const contentPayload = {
      video_id: videoInfo.vid,
      video_url: fullVideoUrl,
      thumb_url: fullThumbUrl,
      duration: videoInfo.duration || 0,
    };

    let result;
    let isFallbackText = false;
    try {
      result = await shopeeAdapter.sendMessage(shop, {
        toId: conv.to_id,
        conversationId: conv.conversation_id,
        messageType: 'video',
        content: shopeeContentPayload,
      });
    } catch (apiErr) {
      // Fallback เผื่อ error จริง (เช่น user_is_forbidden, video ยังไม่ successful ฯลฯ) -> ส่งเป็นข้อความ Text แจ้งลิงก์วิดีโอแทน
      isFallbackText = true;
      const textMsg = fullVideoUrl ? `🎥 วิดีโอแนบ: ${fullVideoUrl}` : `🎥 วิดีโอแนบ (vid: ${videoInfo.vid})`;
      result = await shopeeAdapter.sendMessage(shop, {
        toId: conv.to_id,
        conversationId: conv.conversation_id,
        messageType: 'text',
        content: { text: textMsg },
      });
    }

    const sentMessageId = (result && result.response && result.response.message_id) || (result && result.message_id) || `out-v-${Date.now()}`;

    // บันทึกเป็น message_type: 'video' ในระบบเพื่อให้หน้าจอ Chat Center แสดงเป็น Video Player
    await Message.updateOne(
      { message_id: String(sentMessageId) },
      {
        $set: {
          message_id: String(sentMessageId),
          conversation_id: conv.conversation_id,
          platform: conv.platform,
          shop_id: conv.shop_id,
          from_id: String(shop.shop_id),
          to_id: String(conv.to_id),
          message_type: 'video',
          direction: 'out',
          content: contentPayload,
          status: 'normal',
          source: 'openapi',
          created_timestamp: new Date(),
          raw_payload: result,
          reply_source: 'manual',
        },
      },
      { upsert: true }
    );

    await Conversation.updateOne(
      { _id: conv._id },
      {
        $set: {
          latest_message_id: String(sentMessageId),
          latest_message_type: 'video',
          latest_message_content: contentPayload,
          latest_message_from_id: String(shop.shop_id),
          last_message_timestamp: new Date(),
        },
      }
    );

    res.json({ success: true, video_info: videoInfo, result, isFallbackText });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/conversations/:id/products — ดึงรายการสินค้าของร้าน (สำหรับ panel "แนะนำสินค้า" ในหน้า composer)
router.get('/conversations/:id/products', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).lean();
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    const offset = Number(req.query.offset) || 0;
    const pageSize = Math.min(50, Number(req.query.limit) || 20);
    const keyword = (req.query.keyword || '').trim().toLowerCase();

    // get_item_list คืนแค่ item_id — ต้องเรียก get_item_base_info เพิ่มเพื่อเอาชื่อ/รูป/ราคา
    const listResult = await shopeeAdapter.getItemList(shop, { offset, pageSize });
    const itemIds = (listResult.item || []).map((i) => i.item_id);
    if (itemIds.length === 0) return res.json({ items: [], hasMore: false, nextOffset: offset });

    const baseInfo = await shopeeAdapter.getItemBaseInfo(shop, itemIds.join(','));

    // ⚠️ price_info จาก get_item_base_info ใช้ได้เฉพาะสินค้าไม่มีตัวเลือก (has_model: false)
    // สินค้าที่มีตัวเลือกต้องเรียก get_model_list แยกเพื่อเอาราคาต่ำสุดมาแสดงแทน (แบบ "เริ่มต้น ฿x")
    const itemsWithModel = (baseInfo.item_list || []).filter((item) => item.has_model);
    const modelPriceByItemId = {};
    await Promise.all(itemsWithModel.map(async (item) => {
      try {
        const modelResult = await shopeeAdapter.getModelList(shop, item.item_id);
        const prices = (modelResult.model || [])
          .map((m) => m.price_info && m.price_info[0] && (m.price_info[0].current_price || m.price_info[0].original_price))
          .filter((p) => p != null);
        if (prices.length > 0) modelPriceByItemId[item.item_id] = Math.min(...prices);
      } catch {
        // ไม่ต้อง fail ทั้ง request แค่เพราะ item เดียวดึงราคาไม่ได้
      }
    }));

    let items = (baseInfo.item_list || []).map((item) => ({
      item_id: item.item_id,
      item_name: item.item_name,
      image_url: item.image && item.image.image_url_list && item.image.image_url_list[0],
      price: item.has_model
        ? modelPriceByItemId[item.item_id]
        : (item.price_info && item.price_info[0] && (item.price_info[0].current_price || item.price_info[0].original_price)),
      // ⚡ ป้าย "ส่งทันที" — logistic_id 70126 = "Instant Delivery" ต้องเปิดใช้งานอยู่สำหรับสินค้านี้
      hasInstantDelivery: !!(item.logistic_info && item.logistic_info.some((l) => l.logistic_id === 70126 && l.enabled)),
    }));

    if (keyword) {
      items = items.filter((i) => (i.item_name || '').toLowerCase().includes(keyword));
    }

    res.json({
      items,
      hasMore: !!(listResult.has_next_page),
      nextOffset: offset + pageSize,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/send-item — ส่งการ์ดแนะนำสินค้าให้ลูกค้าทาง Shopee
router.post('/conversations/:id/send-item', async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'missing_item_id' });

    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const shop = await Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).lean();
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    const contentPayload = { item_id: String(item_id) };

    const result = await shopeeAdapter.sendMessage(shop, {
      toId: conv.to_id,
      conversationId: conv.conversation_id,
      messageType: 'item',
      // ⚠️ item_id ต้องเป็น int ตาม v2.sellerchat.send_message doc — ส่ง string ไปจะได้ param_error
      content: { item_id: Number(item_id) },
    });

    const sentMessageId = (result && result.response && result.response.message_id) || (result && result.message_id) || `out-i-${Date.now()}`;

    await Message.updateOne(
      { message_id: String(sentMessageId) },
      {
        $set: {
          message_id: String(sentMessageId),
          conversation_id: conv.conversation_id,
          platform: conv.platform,
          shop_id: conv.shop_id,
          from_id: String(shop.shop_id),
          to_id: String(conv.to_id),
          message_type: 'item',
          direction: 'out',
          content: contentPayload,
          status: 'normal',
          source: 'openapi',
          created_timestamp: new Date(),
          raw_payload: result,
          reply_source: 'manual',
        },
      },
      { upsert: true }
    );

    await Conversation.updateOne(
      { _id: conv._id },
      {
        $set: {
          latest_message_id: String(sentMessageId),
          latest_message_type: 'item',
          latest_message_content: contentPayload,
          latest_message_from_id: String(shop.shop_id),
          last_message_timestamp: new Date(),
        },
      }
    );

    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/customers/:buyer_id/notes — บันทึกโน้ตและแท็กของลูกค้า
router.put('/customers/:buyer_id/notes', async (req, res) => {
  const { notes, tags } = req.body;
  try {
    const update = {};
    if (notes !== undefined) update.notes = notes;
    if (tags !== undefined) update.tags = tags;

    const customer = await Customer.findOneAndUpdate(
      { buyer_id: req.params.buyer_id },
      { $set: update },
      { new: true, upsert: true }
    );
    res.json(customer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/read
// ⚠️ ป้องกันด้วย ENABLE_MARK_READ — ถ้าปิด จะอัปเดตแค่ local DB ไม่ยิง Shopee API
// เพื่อไม่ให้ unread หายไปจาก Zaapi หรือ Shopee admin
router.post('/conversations/:id/read', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    // 1. ตอบผลการอัปเดตกลับไปที่ client ทันที (0-3ms)
    await Conversation.updateOne({ _id: conv._id }, { $set: { unread_count: 0 } });
    res.json({ ok: true, shopee_synced: process.env.ENABLE_MARK_READ === 'true' });

    // 2. ยิง API Shopee แบบ Asynchronous เบื้องหลัง (ไม่ดึงบล็อก HTTP response)
    if (process.env.ENABLE_MARK_READ === 'true') {
      let lastMsgId = conv.latest_message_id;
      if (!lastMsgId) {
        const latestMsg = await Message.findOne({ conversation_id: conv.conversation_id }).sort({ created_timestamp: -1 }).lean();
        if (latestMsg) lastMsgId = latestMsg.message_id;
      }
      Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).then(shop => {
        if (shop) shopeeAdapter.markRead(shop, conv.conversation_id, lastMsgId).catch(() => null);
      });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/pin  |  /unpin
router.post('/conversations/:id/:action(pin|unpin)', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const pinned = req.params.action === 'pin';
    await Conversation.updateOne({ _id: conv._id }, { $set: { pinned } });
    res.json({ ok: true, pinned, shopee_synced: process.env.ENABLE_PIN === 'true' });

    if (process.env.ENABLE_PIN === 'true') {
      Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).then(shop => {
        if (shop) shopeeAdapter.pinConversation(shop, conv.conversation_id, pinned).catch(() => null);
      });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/:action(mute|unmute) — ปิด/เปิดเสียงการแจ้งเตือนแชท
router.post('/conversations/:id/:action(mute|unmute)', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const mute = req.params.action === 'mute';
    await Conversation.updateOne({ _id: conv._id }, { $set: { mute } });
    res.json({ ok: true, mute });

    Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).then(shop => {
      if (shop) shopeeAdapter.muteConversation(shop, conv.conversation_id, mute).catch(() => null);
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/unread — ทำเป็นยังไม่อ่าน (Unread)
router.post('/conversations/:id/unread', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    await Conversation.updateOne({ _id: conv._id }, { $set: { unread_count: 1 } });
    res.json({ ok: true, unread_count: 1 });

    Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).then(shop => {
      if (shop) shopeeAdapter.unreadConversation(shop, conv.conversation_id).catch(() => null);
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/conversations/:id — ลบแชท (Delete Chat)
router.delete('/conversations/:id', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id }).lean();
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    await Conversation.deleteOne({ _id: conv._id });
    await Message.deleteMany({ conversation_id: conv.conversation_id });
    res.json({ ok: true, deleted: true });

    Shop.findOne({ shop_id: conv.shop_id, platform: conv.platform }).then(shop => {
      if (shop) shopeeAdapter.deleteConversation(shop, conv.conversation_id).catch(() => null);
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/items/:item_id — ดึงรายละเอียดสินค้าจาก Shopee API (v2.product.get_item_base_info)
router.get('/items/:item_id', async (req, res) => {
  try {
    const shopId = req.query.shop_id;
    let shop;
    if (shopId) {
      shop = await Shop.findOne({ shop_id: shopId, platform: 'shopee' }).lean();
    }
    if (!shop) {
      shop = await Shop.findOne({ platform: 'shopee' }).lean();
    }
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    const info = await shopeeAdapter.getItemBaseInfo(shop, req.params.item_id);

    // ⚠️ สินค้าที่มีตัวเลือก (has_model: true) ไม่มี price_info ติดมาจาก get_item_base_info
    // ต้องเรียก get_model_list แยกแล้วสังเคราะห์ price_info ขึ้นมาเอง เพื่อให้หน้าแชทแสดงราคาได้เหมือนสินค้าไม่มีตัวเลือก
    const item = info.item_list && info.item_list[0];
    if (item && item.has_model && !item.price_info) {
      try {
        const modelResult = await shopeeAdapter.getModelList(shop, item.item_id);
        const priceInfos = (modelResult.model || [])
          .map((m) => m.price_info && m.price_info[0])
          .filter((p) => p && p.current_price != null);
        // เอาโมเดลที่ current_price ต่ำสุดมาแสดง (แบบ "เริ่มต้นที่") พร้อม original_price คู่กันเพื่อขีดฆ่าได้ถูกต้อง
        const cheapest = priceInfos.sort((a, b) => a.current_price - b.current_price)[0];
        if (cheapest) {
          item.price_info = [{ current_price: cheapest.current_price, original_price: cheapest.original_price }];
        }
      } catch {
        // ไม่ต้อง fail ทั้ง request แค่เพราะดึงราคาไม่ได้
      }
    }

    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/csat/messages — ตรวจสอบข้อความประเมินความพึงพอใจ (CSAT: Good, Bad, Average)
router.get('/csat/messages', async (req, res) => {
  try {
    const { shop_id, csat_result = 'Bad', time_from, time_to, page_no = 0, page_size = 25 } = req.query;
    let shop;
    if (shop_id) {
      shop = await Shop.findOne({ shop_id, platform: 'shopee' }).lean();
    }
    if (!shop) {
      shop = await Shop.findOne({ platform: 'shopee' }).lean();
    }
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    const info = await shopeeAdapter.getCsatMsgDetails(shop, {
      csatResult: csat_result,
      timeFrom: time_from,
      timeTo: time_to,
      pageNo: page_no,
      pageSize: page_size,
    });
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== Workflow fields ที่เราเพิ่มเอง (ไม่ใช่ของ Shopee) — มอบหมาย/ปิดแชท/แท็ก =====

// POST /api/conversations/:id/assign — มอบหมายแชทให้แอดมิน { agent: 'ชื่อ' | null }
// local DB เท่านั้น ไม่มี concept นี้บน Shopee ไม่ต้องยิง API ออก
router.post('/conversations/:id/assign', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id });
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const { agent } = req.body;
    await Conversation.updateOne({ _id: conv._id }, { $set: { assigned_agent: agent || null } });
    res.json({ ok: true, assigned_agent: agent || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/conversations/:id/close  |  /reopen — ปิด/เปิดการสนทนา (local DB เท่านั้น)
router.post('/conversations/:id/:action(close|reopen)', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id });
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const status = req.params.action === 'close' ? 'closed' : 'open';
    await Conversation.updateOne({ _id: conv._id }, { $set: { status } });
    res.json({ ok: true, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/conversations/:id/tags — บันทึก tags ทั้งชุด { tags: ['ลูกค้าประจำ', 'VIP'] }
router.put('/conversations/:id/tags', async (req, res) => {
  try {
    const conv = await Conversation.findOne({ conversation_id: req.params.id });
    if (!conv) return res.status(404).json({ error: 'conversation_not_found' });

    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags_must_be_array' });
    await Conversation.updateOne({ _id: conv._id }, { $set: { tags } });
    res.json({ ok: true, tags });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== Theme + mode (per user) =====
// GET /api/settings/theme — ดึง theme + mode ปัจจุบันของ user
router.get('/settings/theme', async (req, res) => {
  try {
    const setting = await getOrCreateUserSetting();
    res.json({ user_id: setting.user_id, theme: setting.theme, mode: setting.mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/theme — บันทึก theme และ/หรือ mode { theme?: 'name', mode?: 'light'|'dark' }
router.put('/settings/theme', async (req, res) => {
  try {
    const { theme, mode } = req.body;
    const update = {};
    if (theme && typeof theme === 'string') update.theme = theme;
    if (mode === 'light' || mode === 'gray' || mode === 'dark') update.mode = mode;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'theme_or_mode_required' });
    }
    const setting = await UserSetting.findOneAndUpdate(
      { user_id: DEFAULT_USER_ID },
      { $set: update },
      { upsert: true, new: true }
    );
    res.json({ user_id: setting.user_id, theme: setting.theme, mode: setting.mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/unread-count — badge รวมสำหรับ nav bar
router.get('/unread-count', async (req, res) => {
  const result = await Conversation.aggregate([
    { $match: { unread_count: { $gt: 0 } } },
    { $group: { _id: null, total: { $sum: '$unread_count' } } },
  ]);
  res.json({ total_unread_count: result[0] ? result[0].total : 0 });
});

// POST /api/shops/:shopId/reconnect — ลองอ่าน token ใหม่จาก sellcenter + รีเซ็ตสถานะ
// ใช้ตอนร้านเป็น token_error แล้วแอดมินกดลองใหม่ (megaplan ข้อ 6)
router.post('/shops/:shopId/reconnect', async (req, res) => {
  try {
    const shop = await Shop.findOne({ shop_id: req.params.shopId });
    if (!shop) return res.status(404).json({ error: 'shop_not_found' });

    const { getValidAccessToken } = require('../services/tokenReader');
    // ลองดึง token ใหม่ — ถ้าได้แปลว่า token ใช้ได้ รีเซ็ตสถานะเป็น active
    await getValidAccessToken({ shop_id: shop.shop_id, shopname: shop.shopname });
    await Shop.updateOne({ _id: shop._id }, { $set: { status: 'active' } });
    res.json({ ok: true, shop_id: shop.shop_id, status: 'active' });
  } catch (err) {
    // ถ้าดึง token ไม่ได้ อัปเดตสถานะเป็น token_error
    await Shop.updateOne(
      { shop_id: req.params.shopId },
      { $set: { status: 'token_error' } }
    ).exec();
    res.status(400).json({ error: err.message, status: 'token_error' });
  }
});

// GET /api/dashboard — สถิติภาพรวมสำหรับหน้า Dashboard (ดึงจากข้อมูลจริง ไม่มี mock)
// ?platform=shopee,lazada — กรองทุก metric ตาม platform ที่เลือก (คั่นจุลภาค, ไม่ระบุ = ทั้งหมด)
router.get('/dashboard', async (req, res) => {
  const { platform } = req.query;
  const platformFilter = {};
  let platformList = null;
  if (platform) {
    platformList = platform.split(',').map(s => s.trim()).filter(Boolean);
    platformFilter.platform = platformList.length === 1 ? platformList[0] : { $in: platformList };
  }

  const [
    totalConversations,
    unreadConversations,
    pinnedConversations,
    totalUnreadAgg,
    byPlatformAgg,
    byShopAgg,
    recentMessagesAgg,
    todayMessageCount,
    yesterdayMessageCount,
    urgentChats,
    shops,
  ] = await Promise.all([
    Conversation.countDocuments(platformFilter),
    Conversation.countDocuments({ ...platformFilter, unread_count: { $gt: 0 } }),
    Conversation.countDocuments({ ...platformFilter, pinned: true }),
    Conversation.aggregate([
      { $match: { ...platformFilter, unread_count: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$unread_count' } } },
    ]),
    // กระจายตามแพลตฟอร์ม (ไม่กรองตาม platformFilter เพราะใช้แสดงสัดส่วนทั้งหมดเทียบกัน)
    Conversation.aggregate([
      { $group: { _id: '$platform', count: { $sum: 1 }, unread: { $sum: { $cond: [{ $gt: ['$unread_count', 0] }, 1, 0] } } } },
      { $sort: { count: -1 } },
    ]),
    // กระจายตามร้าน
    Conversation.aggregate([
      { $match: platformFilter },
      { $group: { _id: '$shop_id', count: { $sum: 1 }, unread: { $sum: { $cond: [{ $gt: ['$unread_count', 0] }, 1, 0] } } } },
      { $sort: { count: -1 } },
    ]),
    // ข้อความ 7 วันล่าสุด (group by วัน + ทิศทาง)
    Message.aggregate([
      { $match: { ...platformFilter, created_timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
      { $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$created_timestamp' } }, dir: '$direction' },
        count: { $sum: 1 },
      } },
      { $sort: { '_id.day': 1 } },
    ]),
    // เทรนด์: ข้อความวันนี้ vs เมื่อวาน (real data ไม่ใช่ mock)
    Message.countDocuments({ ...platformFilter, created_timestamp: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
    Message.countDocuments({ ...platformFilter, created_timestamp: {
      $gte: new Date(new Date(new Date().setHours(0,0,0,0)).getTime() - 24*60*60*1000),
      $lt: new Date(new Date().setHours(0,0,0,0)),
    } }),
    // แชทรอด่วน — unread จริง เรียงตามเวลาข้อความล่าสุดเก่าสุดก่อน (รอนานสุด)
    Conversation.find({ ...platformFilter, unread_count: { $gt: 0 } })
      .sort({ last_message_timestamp: 1 })
      .limit(5)
      .select('to_name platform last_message_timestamp unread_count'),
    Shop.find({}).sort({ shop_name: 1 }),
  ]);

  // จับคู่ shop_id -> shop_name เพื่อใช้ใน byShop
  const shopMap = new Map(shops.map(s => [s.shop_id, s.shop_name || s.shopname || s.shop_id]));

  res.json({
    totals: {
      conversations: totalConversations,
      unread_conversations: unreadConversations,
      pinned: pinnedConversations,
      total_unread: totalUnreadAgg[0] ? totalUnreadAgg[0].total : 0,
      shops: shops.length,
      shops_enabled: shops.filter(s => s.enabled_for_chat).length,
      messages_today: todayMessageCount,
      messages_yesterday: yesterdayMessageCount,
    },
    by_platform: byPlatformAgg.map(r => ({ platform: r._id || 'unknown', count: r.count, unread: r.unread })),
    by_shop: byShopAgg.map(r => ({ shop_id: r._id, shop_name: shopMap.get(r._id) || r._id, count: r.count, unread: r.unread })),
    message_activity_7d: recentMessagesAgg.map(r => ({ day: r._id.day, direction: r._id.dir, count: r.count })),
    urgent_chats: urgentChats.map(c => ({
      name: c.to_name || 'ไม่ทราบชื่อ',
      platform: c.platform,
      unread_count: c.unread_count,
      last_message_timestamp: c.last_message_timestamp,
    })),
    shops: shops.map(s => ({
      shop_id: s.shop_id,
      shop_name: s.shop_name || s.shopname || '-',
      status: s.status,
      enabled_for_chat: s.enabled_for_chat,
      last_polled_at: s.last_polled_at,
    })),
  });
});

// GET /api/contacts — รายชื่อผู้ติดต่อ (group จาก Conversation จริง ไม่มี mock)
// ?q= ค้นหาชื่อ, ?platform= กรองแพลตฟอร์ม
router.get('/contacts', async (req, res) => {
  const { q, platform } = req.query;
  const match = {};
  if (platform) match.platform = platform;
  if (q) match.to_name = { $regex: q, $options: 'i' };

  const contacts = await Conversation.aggregate([
    { $match: match },
    { $group: {
      _id: { to_id: '$to_id', platform: '$platform' },
      to_name: { $first: '$to_name' },
      to_avatar: { $first: '$to_avatar' },
      platform: { $first: '$platform' },
      shop_ids: { $addToSet: '$shop_id' },
      conversation_count: { $sum: 1 },
      unread_total: { $sum: '$unread_count' },
      last_message_timestamp: { $max: '$last_message_timestamp' },
      pinned_any: { $max: { $cond: ['$pinned', 1, 0] } },
    } },
    { $sort: { last_message_timestamp: -1 } },
    { $limit: 200 },
  ]);

  res.json(contacts.map(c => ({
    to_id: c._id.to_id,
    platform: c._id.platform,
    to_name: c.to_name,
    to_avatar: c.to_avatar,
    shop_ids: c.shop_ids,
    conversation_count: c.conversation_count,
    unread_total: c.unread_total,
    last_message_timestamp: c.last_message_timestamp,
    pinned: c.pinned_any === 1,
  })));
});

// GET /api/system/status — สุขภาพระบบสำหรับ status bar (ตามภาพ template: Server/Database/API's/Shopee/Lazada/TikTok)
// ข้อมูลจริงทั้งหมด: mongoose connection state, sellcenter DB, poll worker freshness, token status ต่อร้าน
router.get('/system/status', async (req, res) => {
  const mongoose = require('mongoose');

  // Server ตัวเองรันอยู่แน่ (ถ้า endpoint นี้ตอบได้)
  const serverOk = true;

  // Database หลัก (chat-center) — เช็ค readyState ของ mongoose connection (1 = connected)
  const dbOk = mongoose.connection.readyState === 1;

  // sellcenter DB (อ่าน token แบบ read-only) — เช็คแยก เพราะเป็นคนละ connection
  let sellcenterOk = false;
  try {
    const { getSellcenterConnection } = require('../config/sellcenterDb');
    const conn = getSellcenterConnection();
    sellcenterOk = conn.readyState === 1;
  } catch (err) {
    sellcenterOk = false;
  }

  // Poll worker — เช็คว่ามีร้านที่ poll ล่าสุดภายใน 3x POLL_INTERVAL_MS หรือไม่ (ถือว่า worker ยังทำงาน)
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 20000);
  const pollEnabled = process.env.ENABLE_POLL === 'true';
  const freshestShop = await Shop.findOne({ last_polled_at: { $ne: null } }).sort({ last_polled_at: -1 });
  const pollFresh = pollEnabled && freshestShop && (Date.now() - new Date(freshestShop.last_polled_at).getTime() < pollIntervalMs * 3);

  // สถานะแต่ละ platform — จาก Shop.status จริง (active/token_error/disabled) รวมทุกร้านของ platform นั้น
  const platforms = ['shopee', 'lazada', 'tiktok'];
  const platformStatus = {};
  for (const p of platforms) {
    const shopsOfPlatform = await Shop.find({ platform: p });
    if (shopsOfPlatform.length === 0) {
      platformStatus[p] = 'no_shops';
    } else if (shopsOfPlatform.every(s => s.status === 'active')) {
      platformStatus[p] = 'active';
    } else if (shopsOfPlatform.some(s => s.status === 'active')) {
      platformStatus[p] = 'partial';
    } else {
      platformStatus[p] = 'token_error';
    }
  }

  res.json({
    server: serverOk ? 'ok' : 'down',
    database: dbOk ? 'ok' : 'down',
    sellcenter_database: sellcenterOk ? 'ok' : 'down',
    poll_worker: pollEnabled ? (pollFresh ? 'running' : 'stale') : 'disabled',
    platforms: platformStatus,
    checked_at: new Date().toISOString(),
  });
});

module.exports = router;
