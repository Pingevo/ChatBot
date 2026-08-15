require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const RequestLog = require('../models/RequestLog');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Time now:', new Date().toISOString());
  console.log('Shop:', shop.shop_id, shop.shop_name, '| last_polled:', shop.last_polled_at && shop.last_polled_at.toISOString());

  // 1. เช็ค RequestLog ล่าสุดของ Yaber
  const logs = await RequestLog.find({ shop_id: shop.shop_id }).sort({ created_at: -1 }).limit(10).lean();
  console.log('\nRecent RequestLogs for Yaber:', logs.length);
  for (const l of logs) {
    console.log('  ', l.event_type, '| status:', l.status_code, '| error:', l.error || '-', '| time:', l.created_at && l.created_at.toISOString());
  }

  // 2. ดึงจาก Shopee ตรงๆ ตอนนี้
  console.log('\n=== Fetching from Shopee now ===');
  const { conversations } = await shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' });
  console.log('Unread conversations:', conversations.length);
  for (const conv of conversations) {
    const ts = conv.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('  conv:', conv.conversation_id, '| unread:', conv.unread_count, '| last:', d ? d.toISOString() : 'null');
  }

  // 3. ดึง messages ของ conv 80245417614920823
  console.log('\n=== Messages for conv 80245417614920823 ===');
  const { messages } = await shopeeAdapter.fetchMessages(shop, '80245417614920823', { pageSize: 50 });
  console.log('Shopee messages:', messages.length);

  const dbMsgs = await Message.find({ conversation_id: '80245417614920823' }).sort({ created_timestamp: -1 }).limit(5).lean();
  console.log('DB messages:', dbMsgs.length, '| newest DB:', dbMsgs[0] ? dbMsgs[0].created_timestamp.toISOString() : 'none');

  // แสดง 5 ข้อความล่าสุดจาก Shopee
  for (const m of messages.slice(-5)) {
    const text = (m.content && m.content.text) || '[' + m.message_type + ']';
    const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
    const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
    console.log('  ', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70));
  }

  // 4. เช็คว่า DB มีข้อความที่ส่งไป (out) ไหม
  console.log('\n=== Outbound messages in DB ===');
  const outMsgs = await Message.find({ conversation_id: '80245417614920823', direction: 'out' }).sort({ created_timestamp: -1 }).limit(3).lean();
  for (const m of outMsgs) {
    const text = (m.content && m.content.text) || '[' + m.message_type + ']';
    console.log('  ', m.direction, '|', m.created_timestamp.toISOString(), '|', text.slice(0, 70), '| msg_id:', m.message_id);
  }

  process.exit(0);
}

check();
