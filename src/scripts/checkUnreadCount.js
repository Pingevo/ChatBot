require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

// เรียก API ตรงๆ ผ่าน adapter
async function callApi(shop, apiName, options) {
  // ใช้ function ภายใน adapter ผ่าน fetchMessages/fetchConversations
  // แต่บาง API ไม่มีใน adapter ต้องเรียกตรง
}

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Time now:', new Date().toISOString());

  // 1. ดึง unread count
  console.log('\n=== get_unread_conversation_count ===');
  try {
    // ลองเรียกผ่าน fetchConversations แบบ type: unread เพื่อนับ
    const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
    console.log('Unread conversations:', conversations.length);

    // 2. ดึง type: all ด้วย page_size 100
    console.log('\n=== type: all, page_size: 100 ===');
    const { conversations: allConvs } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'all' });
    console.log('All conversations:', allConvs.length);

    // 3. รวมทั้งหมด หา conv ที่มี timestamp ใหม่กว่า 1 ชม. ที่แล้ว
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const allConvMap = new Map();
    for (const c of [...allConvs, ...conversations]) {
      allConvMap.set(String(c.conversation_id), c);
    }
    console.log('\n=== Conversations with activity in last 1 hour ===');
    let foundRecent = false;
    for (const [id, c] of allConvMap) {
      const ts = c.last_message_timestamp;
      if (ts) {
        const d = new Date(Number(BigInt(ts) / 1000000n));
        if (d > oneHourAgo) {
          console.log('  conv:', id, '| unread:', c.unread_count, '| last:', d.toISOString());
          foundRecent = true;
        }
      }
    }
    if (!foundRecent) {
      console.log('  (none found in last 1 hour)');
    }

    // 4. ดึง messages ของ conv ที่ใหม่สุด
    if (conversations.length > 0) {
      let latestConv = null;
      let latestTime = null;
      for (const c of conversations) {
        const ts = c.last_message_timestamp;
        if (ts) {
          const d = new Date(Number(BigInt(ts) / 1000000n));
          if (!latestTime || d > latestTime) { latestTime = d; latestConv = c; }
        }
      }
      if (latestConv) {
        console.log('\n=== Latest conv messages:', latestConv.conversation_id, '===');
        const { messages } = await shopeeAdapter.fetchMessages(shop, String(latestConv.conversation_id), { pageSize: 50 });
        console.log('Messages:', messages.length);
        // แสดง 5 ล่าสุด
        for (const m of messages.slice(-5)) {
          const text = (m.content && m.content.text) || '[' + m.message_type + ']';
          const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
          const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
          console.log('  ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
        }
      }
    }
  } catch (err) {
    console.log('Error:', err.message);
  }

  // 5. รอ 2 นาทีแล้วเช็คอีกครั้ง
  console.log('\n=== Waiting 2 minutes then re-checking... ===');
  await new Promise(r => setTimeout(r, 120000));
  console.log('Time after wait:', new Date().toISOString());

  const { conversations: unread2 } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
  console.log('Unread after wait:', unread2.length);
  for (const c of unread2) {
    const ts = c.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('  conv:', c.conversation_id, '| unread:', c.unread_count, '| last:', d ? d.toISOString() : 'null');
  }

  // ดึง messages ของ conv ใหม่สุด
  if (unread2.length > 0) {
    let latestConv = null;
    let latestTime = null;
    for (const c of unread2) {
      const ts = c.last_message_timestamp;
      if (ts) {
        const d = new Date(Number(BigInt(ts) / 1000000n));
        if (!latestTime || d > latestTime) { latestTime = d; latestConv = c; }
      }
    }
    if (latestConv) {
      console.log('\n=== Latest conv after wait:', latestConv.conversation_id, '===');
      const { messages } = await shopeeAdapter.fetchMessages(shop, String(latestConv.conversation_id), { pageSize: 50 });
      console.log('Messages:', messages.length);
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
