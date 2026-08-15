require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Time now:', new Date().toISOString());

  // ดึง unread
  const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
  console.log('\nUnread conversations:', conversations.length);
  for (const conv of conversations) {
    const ts = conv.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('  conv:', conv.conversation_id, '| unread:', conv.unread_count, '| last:', d ? d.toISOString() : 'null');
  }

  // ดึง type: all
  const { conversations: allConvs } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'all' });
  console.log('\nAll conversations:', allConvs.length);
  let newest = null;
  let newestConv = null;
  for (const c of allConvs) {
    const ts = c.last_message_timestamp;
    if (ts) {
      const d = new Date(Number(BigInt(ts) / 1000000n));
      if (!newest || d > newest) { newest = d; newestConv = c; }
    }
  }
  console.log('Newest in type:all:', newest ? newest.toISOString() : 'null', '| conv:', newestConv ? newestConv.conversation_id : 'null');

  // ดึง messages ของ conv ที่ใหม่สุดจาก unread
  if (conversations.length > 0) {
    // เรียงตาม timestamp หา conv ที่ใหม่สุด
    let latestUnread = null;
    let latestTime = null;
    for (const c of conversations) {
      const ts = c.last_message_timestamp;
      if (ts) {
        const d = new Date(Number(BigInt(ts) / 1000000n));
        if (!latestTime || d > latestTime) { latestTime = d; latestUnread = c; }
      }
    }
    if (latestUnread) {
      console.log('\n=== Latest unread conv:', latestUnread.conversation_id, '===');
      const { messages } = await shopeeAdapter.fetchMessages(shop, String(latestUnread.conversation_id));
      console.log('Messages from Shopee:', messages.length);
      for (const m of messages.slice(-5)) {
        const text = (m.content && m.content.text) || '[' + m.message_type + ']';
        const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
        const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
        console.log('  ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
      }
    }
  }

  process.exit(0);
}

check();
