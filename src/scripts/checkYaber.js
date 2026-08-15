require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();

  // หาร้าน Yaber Thailand
  const shops = await Shop.find({
    $or: [
      { shop_name: { $regex: 'yaber', $options: 'i' } },
      { shopname: { $regex: 'yaber', $options: 'i' } },
    ],
  }).lean();

  console.log('Shops matching "yaber":', shops.length);
  for (const s of shops) {
    console.log('  shop_id:', s.shop_id, '| name:', s.shop_name || s.shopname, '| enabled_for_chat:', s.enabled_for_chat, '| status:', s.status, '| last_polled:', s.last_polled_at && s.last_polled_at.toISOString());
  }

  if (shops.length === 0) {
    console.log('\n❌ ไม่พบร้าน Yaber Thailand ใน DB — ร้านนี้อาจยังไม่ได้ authorize หรือชื่อเก็บต่าง');
    // แสดงร้านทั้งหมดเพื่อหาชื่อที่ใกล้เคียง
    const allShops = await Shop.find({}).lean();
    console.log('\nAll shops in DB:');
    for (const s of allShops) {
      console.log('  ', s.shop_id, '|', s.shop_name || s.shopname, '| enabled:', s.enabled_for_chat, '| status:', s.status);
    }
    process.exit(0);
  }

  const shop = shops[0];

  // ดึง conversation list จาก Shopee ตรงๆ
  console.log('\n=== Fetching from Shopee directly ===');
  try {
    const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'all' });
    console.log('Shopee conversations:', conversations.length);

    // หา conversation ที่มี unread > 0 หรือ timestamp ใหม่
    for (const conv of conversations.slice(0, 10)) {
      const shopeeTs = conv.last_message_timestamp;
      const shopeeDate = shopeeTs ? new Date(Number(BigInt(shopeeTs) / 1000000n)) : null;

      const dbConv = await Conversation.findOne({
        shop_id: String(shop.shop_id),
        conversation_id: String(conv.conversation_id),
      }).lean();
      const dbDate = dbConv ? dbConv.last_message_timestamp : null;
      const dbMsgCount = await Message.countDocuments({ conversation_id: String(conv.conversation_id) });

      const isNew = shopeeDate && (!dbDate || shopeeDate > dbDate);
      console.log('  conv:', conv.conversation_id,
        '| unread:', conv.unread_count,
        '| shopee:', shopeeDate ? shopeeDate.toISOString() : 'null',
        '| db:', dbDate ? dbDate.toISOString() : 'null',
        '| dbMsgs:', dbMsgCount,
        isNew ? ' | ⚠️ NEW!' : '');
    }
  } catch (err) {
    console.log('Error fetching from Shopee:', err.message);
  }

  process.exit(0);
}

check();
