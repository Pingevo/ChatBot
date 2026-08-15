require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Time now:', new Date().toISOString());

  // ดึง type: all และ type: unread
  const [allRes, unreadRes] = await Promise.all([
    shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'all' }),
    shopeeAdapter.fetchConversations(shop, { direction: 'latest', type: 'unread' }),
  ]);

  console.log('type:all count:', allRes.conversations.length);
  console.log('type:unread count:', unreadRes.conversations.length);

  // หา conv 80245417614920823 ในทั้งสอง
  const inAll = allRes.conversations.find(c => String(c.conversation_id) === '80245417614920823');
  const inUnread = unreadRes.conversations.find(c => String(c.conversation_id) === '80245417614920823');

  console.log('\nconv 80245417614920823:');
  console.log('  in type:all:', inAll ? 'YES' : 'NO');
  console.log('  in type:unread:', inUnread ? 'YES' : 'NO');

  if (inAll) {
    const ts = inAll.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('  Shopee last_message_timestamp:', d ? d.toISOString() : 'null');
    console.log('  Shopee unread_count:', inAll.unread_count);
  }
  if (inUnread) {
    const ts = inUnread.last_message_timestamp;
    const d = ts ? new Date(Number(BigInt(ts) / 1000000n)) : null;
    console.log('  Shopee (unread) last_message_timestamp:', d ? d.toISOString() : 'null');
  }

  // ดู DB
  const dbConv = await Conversation.findOne({ shop_id: shop.shop_id, conversation_id: '80245417614920823' }).lean();
  console.log('\nDB Conversation:');
  console.log('  last_message_timestamp:', dbConv ? dbConv.last_message_timestamp.toISOString() : 'null');
  console.log('  unread_count:', dbConv ? dbConv.unread_count : 'null');
  console.log('  latest_message_id:', dbConv ? dbConv.latest_message_id : 'null');

  // ดึง messages จาก Shopee ตอนนี้
  console.log('\n=== get_message now ===');
  const { messages } = await shopeeAdapter.fetchMessages(shop, '80245417614920823', { pageSize: 50 });
  console.log('Shopee messages count:', messages.length);

  // หาข้อความที่ใหม่กว่า DB
  const dbMsgs = await Message.find({ conversation_id: '80245417614920823' }).lean();
  const dbMsgIds = new Set(dbMsgs.map(m => String(m.message_id)));
  console.log('DB message count:', dbMsgs.length);

  const newMsgs = messages.filter(m => !dbMsgIds.has(String(m.message_id)));
  console.log('New messages from Shopee not in DB:', newMsgs.length);

  for (const m of newMsgs) {
    const text = (m.content && m.content.text) || '[' + m.message_type + ']';
    const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
    const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
    console.log('  NEW:', dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 70), '| msg_id:', m.message_id);
  }

  // แสดง 5 ข้อความล่าสุดจาก Shopee
  console.log('\nLast 5 from Shopee:');
  for (const m of messages.slice(-5)) {
    const text = (m.content && m.content.text) || '[' + m.message_type + ']';
    const dir = String(m.from_shop_id) === String(shop.shop_id) ? 'out' : 'in';
    const mt = m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000) : null;
    const inDb = dbMsgIds.has(String(m.message_id)) ? '✓' : '✗';
    console.log('  ', inDb, dir, '|', mt ? mt.toISOString() : 'null', '|', text.slice(0, 60));
  }

  process.exit(0);
}

check();
