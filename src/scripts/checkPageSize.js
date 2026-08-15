require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Time now:', new Date().toISOString());

  // ลอง type: unread ด้วย page_size 100
  console.log('\n=== type: unread, page_size: 100 ===');
  const res1 = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
  console.log('Conversations:', res1.conversations.length);

  // หา timestamp ใหม่สุด
  let newestUnread = null;
  let newestUnreadConv = null;
  for (const c of res1.conversations) {
    const ts = c.last_message_timestamp;
    if (ts) {
      const d = new Date(Number(BigInt(ts) / 1000000n));
      if (!newestUnread || d > newestUnread) { newestUnread = d; newestUnreadConv = c; }
    }
  }
  console.log('Newest unread:', newestUnread ? newestUnread.toISOString() : 'null');

  // ลองดึง messages ของ conv ที่ใหม่สุด ด้วย page_size ใหญ่
  if (newestUnreadConv) {
    console.log('\n=== Fetching messages for', newestUnreadConv.conversation_id, 'with page_size=100 ===');
    const { messages, nextOffset } = await shopeeAdapter.fetchMessages(shop, String(newestUnreadConv.conversation_id), { pageSize: 100 });
    console.log('Messages:', messages.length, '| nextOffset:', nextOffset);

    // แสดง 10 ข้อความล่าสุด
    for (const m of messages.slice(-10)) {
      const text = (m.content && m.content.text) || '[' + m.message_type + ']';
      const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
      const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
      console.log('  ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
    }

    // ถ้ามี nextOffset ดึงหน้าถัดไป
    if (nextOffset) {
      console.log('\n=== Page 2 (offset:', nextOffset, ') ===');
      const res2 = await shopeeAdapter.fetchMessages(shop, String(newestUnreadConv.conversation_id), { offset: nextOffset, pageSize: 100 });
      console.log('Messages page 2:', res2.messages.length);
      for (const m of res2.messages.slice(-5)) {
        const text = (m.content && m.content.text) || '[' + m.message_type + ']';
        const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
        const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
        console.log('  ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
      }
    }
  }

  // ลองดึง type: all ด้วย page_size ใหญ่ ผ่าน API ตรงๆ
  console.log('\n=== type: all, page_size: 100 (direct API) ===');
  try {
    const { callSellerChatApi } = require('../platforms/shopee-adapter');
    const response = await callSellerChatApi(shop, 'get_conversation_list', {
      query: { page_size: 100, direction: 'latest', type: 'all' }
    });
    const allConvs = response.conversations || [];
    console.log('All conversations (page_size=100):', allConvs.length);
    let newest = null;
    for (const c of allConvs) {
      const ts = c.last_message_timestamp;
      if (ts) {
        const d = new Date(Number(BigInt(ts) / 1000000n));
        if (!newest || d > newest) newest = d;
      }
    }
    console.log('Newest in all:', newest ? newest.toISOString() : 'null');
  } catch (err) {
    console.log('Error:', err.message);
  }

  process.exit(0);
}

check();
