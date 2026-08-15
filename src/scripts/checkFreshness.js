require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();

  // เลือกร้าน active 3 ร้านแรกที่ enabled_for_chat
  const shops = await Shop.find({ enabled_for_chat: true, status: 'active' }).limit(3).lean();
  console.log('Checking', shops.length, 'active shops...\n');

  for (const shop of shops) {
    console.log('=== Shop:', shop.shop_name || shop.shopname, '(' + shop.shop_id + ') ===');

    try {
      // ดึง conversation list ล่าสุดจาก Shopee ตรงๆ
      const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'all' });
      console.log('  Shopee conversations:', conversations.length);

      if (conversations.length === 0) {
        console.log('  (no conversations from Shopee)\n');
        continue;
      }

      // ดู conversation ล่าสุด 3 อัน
      for (const conv of conversations.slice(0, 3)) {
        const shopeeTimestamp = conv.last_message_timestamp;
        const shopeeDate = shopeeTimestamp ? new Date(Number(BigInt(shopeeTimestamp) / 1000000n)) : null;

        // เทียบกับ DB
        const dbConv = await Conversation.findOne({
          shop_id: String(shop.shop_id),
          conversation_id: String(conv.conversation_id),
        }).lean();

        const dbDate = dbConv ? dbConv.last_message_timestamp : null;
        const dbMsgCount = await Message.countDocuments({ conversation_id: String(conv.conversation_id) });

        console.log('  conv:', conv.conversation_id);
        console.log('    Shopee last_msg:', shopeeDate ? shopeeDate.toISOString() : 'null');
        console.log('    DB last_msg:    ', dbDate ? dbDate.toISOString() : 'null');
        console.log('    DB msg count:   ', dbMsgCount);
        console.log('    unread_count:   ', conv.unread_count);

        // ถ้า Shopee มี timestamp ใหม่กว่า DB → มีของใหม่ที่ยังไม่ได้ดึง
        if (shopeeDate && (!dbDate || shopeeDate > dbDate)) {
          console.log('    ⚠️  NEW ACTIVITY — Shopee newer than DB!');
        }
        console.log('');
      }
    } catch (err) {
      console.log('  Error:', err.message, '\n');
    }
  }

  process.exit(0);
}

check();
