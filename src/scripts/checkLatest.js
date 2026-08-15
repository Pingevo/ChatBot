require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Message = require('../models/Message');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Shop:', shop.shop_id, shop.shop_name);
  console.log('Time now:', new Date().toISOString(), '\n');

  // ดึง type: unread
  const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
  console.log('Unread conversations:', conversations.length);

  for (const conv of conversations) {
    const ts = conv.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('\nconv:', conv.conversation_id, '| unread:', conv.unread_count, '| shopee last:', d ? d.toISOString() : 'null');

    // ดึง messages จาก Shopee
    const { messages } = await shopeeAdapter.fetchMessages(shop, String(conv.conversation_id));
    console.log('  Shopee messages:', messages.length);

    // ดึง messages จาก DB
    const dbMsgs = await Message.find({ conversation_id: String(conv.conversation_id) }).sort({ created_timestamp: -1 }).limit(3).lean();
    console.log('  DB messages:', dbMsgs.length, '| newest DB:', dbMsgs[0] ? dbMsgs[0].created_timestamp.toISOString() : 'none');

    // เทียบข้อความล่าสุดจาก Shopee กับ DB
    if (messages.length > 0) {
      const shopeeLatest = messages[messages.length - 1];
      const shopeeLatestDate = shopeeLatest.created_timestamp ? new Date(Number(shopeeLatest.created_timestamp) * 1000) : null;
      const shopeeLatestText = (shopeeLatest.content && shopeeLatest.content.text) || '[' + shopeeLatest.message_type + ']';
      const shopeeLatestDir = String(shopeeLatest.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';

      const dbLatest = dbMsgs[0];
      const dbLatestDate = dbLatest ? dbLatest.created_timestamp : null;

      console.log('  Shopee latest:', shopeeLatestDir, '|', shopeeLatestDate ? shopeeLatestDate.toISOString() : 'null', '|', shopeeLatestText.slice(0, 60));
      console.log('  DB latest:    ', dbLatest ? dbLatest.direction : '?', '|', dbLatestDate ? dbLatestDate.toISOString() : 'null');

      if (shopeeLatestDate && (!dbLatestDate || shopeeLatestDate > dbLatestDate)) {
        console.log('  ⚠️  SHOPEE HAS NEWER MESSAGE NOT IN DB!');
      }

      // แสดง 5 ข้อความล่าสุดจาก Shopee
      console.log('  --- Last 5 from Shopee ---');
      for (const m of messages.slice(-5)) {
        const text = (m.content && m.content.text) || '[' + m.message_type + ']';
        const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
        const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
        console.log('    ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
      }
    }
  }

  process.exit(0);
}

check();
