require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Message = require('../models/Message');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Shop:', shop.shop_id, shop.shop_name);

  // ดึง type: unread (มีของใหม่จริง)
  console.log('\n=== type: unread — ดึงข้อความล่าสุดของแต่ละ conv ===');
  const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
  console.log('Unread conversations:', conversations.length);

  for (const conv of conversations) {
    const ts = conv.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('\n  conv:', conv.conversation_id, '| unread:', conv.unread_count, '| time:', d ? d.toISOString() : 'null');

    // ดึง messages ของ conv นี้
    try {
      const { messages } = await shopeeAdapter.fetchMessages(shop, String(conv.conversation_id));
      console.log('  messages from Shopee:', messages.length);

      // ดึง messages จาก DB เทียบ
      const dbMsgs = await Message.find({ conversation_id: String(conv.conversation_id) }).sort({ created_timestamp: -1 }).limit(3).lean();
      console.log('  messages in DB:', dbMsgs.length, '| newest DB:', dbMsgs[0] ? dbMsgs[0].created_timestamp : 'none');

      // แสดง 3 ข้อความล่าสุดจาก Shopee
      const recent = messages.slice(-3);
      for (const m of recent) {
        const text = (m.content && m.content.text) || '[' + m.message_type + ']';
        const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
        const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
        console.log('    ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 60));
      }
    } catch (err) {
      console.log('  Error fetching messages:', err.message);
    }
  }

  process.exit(0);
}

check();
