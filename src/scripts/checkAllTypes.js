require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Time now:', new Date().toISOString());
  console.log('Shop:', shop.shop_id, shop.shop_name);

  // ลอง type ต่างๆ ที่ Shopee อาจรองรับ
  for (const type of ['all', 'unread', 'read', 'new', 'opened', 'closed']) {
    console.log('\n=== type:', type, '===');
    try {
      const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type });
      console.log('  count:', conversations.length);
      if (conversations.length > 0) {
        let newest = null;
        for (const c of conversations) {
          const ts = c.last_message_timestamp;
          if (ts) {
            const d = new Date(Number(BigInt(ts) / 1000000n));
            if (!newest || d > newest) newest = d;
          }
        }
        console.log('  newest:', newest ? newest.toISOString() : 'null');
        // แสดง 3 อันแรก
        for (const c of conversations.slice(0, 3)) {
          const ts = c.last_message_timestamp;
          const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
          console.log('    conv:', c.conversation_id, '| unread:', c.unread_count, '| last:', d ? d.toISOString() : 'null');
        }
      }
    } catch (err) {
      console.log('  Error:', err.message);
    }
  }

  // รอ 30 วินาทีแล้วเช็ค unread อีกครั้ง
  console.log('\n=== Waiting 30s then re-checking unread... ===');
  await new Promise(r => setTimeout(r, 30000));
  console.log('Time after wait:', new Date().toISOString());
  const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
  console.log('Unread conversations after wait:', conversations.length);
  for (const c of conversations) {
    const ts = c.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('  conv:', c.conversation_id, '| unread:', c.unread_count, '| last:', d ? d.toISOString() : 'null');
  }

  process.exit(0);
}

check();
