require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Shop:', shop.shop_id, shop.shop_name);

  // ลอง direction ต่างๆ
  for (const direction of ['latest', 'new', 'old', 'all']) {
    console.log('\n=== direction:', direction, '===');
    try {
      const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction, type: 'all' });
      console.log('  count:', conversations.length);
      if (conversations.length > 0) {
        // หา timestamp ใหม่สุดในก้อนนี้
        let newest = null;
        let newestConv = null;
        for (const c of conversations) {
          const ts = c.last_message_timestamp;
          if (ts) {
            const d = new Date(Number(BigInt(ts) / 1000000n));
            if (!newest || d > newest) { newest = d; newestConv = c; }
          }
        }
        console.log('  newest timestamp:', newest ? newest.toISOString() : 'null');
        console.log('  newest conv:', newestConv ? newestConv.conversation_id : 'null');
        console.log('  newest unread:', newestConv ? newestConv.unread_count : 'null');

        // หา unread > 0
        const unread = conversations.filter(c => c.unread_count > 0);
        console.log('  conversations with unread:', unread.length);
      }
    } catch (err) {
      console.log('  Error:', err.message);
    }
  }

  // ลอง type: 'unread'
  console.log('\n=== type: unread ===');
  try {
    const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
    console.log('  count:', conversations.length);
    for (const c of conversations.slice(0, 5)) {
      const ts = c.last_message_timestamp;
      const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
      console.log('  conv:', c.conversation_id, '| unread:', c.unread_count, '| time:', d ? d.toISOString() : 'null');
    }
  } catch (err) {
    console.log('  Error:', err.message);
  }

  process.exit(0);
}

check();
