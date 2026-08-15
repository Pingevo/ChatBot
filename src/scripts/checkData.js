require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Shop = require('../models/Shop');

async function check() {
  await connectMainDB();
  const convCount = await Conversation.countDocuments();
  const msgCount = await Message.countDocuments();
  console.log('Conversations:', convCount);
  console.log('Messages:', msgCount);

  // ข้อความ 10 ล่าสุด
  const recentMsgs = await Message.find({}).sort({ created_timestamp: -1 }).limit(10).lean();
  console.log('\nRecent 10 messages:');
  for (const m of recentMsgs) {
    const text = (m.content && m.content.text) || '[' + m.message_type + ']';
    console.log('  ', m.direction, '|', m.shop_id, '|', text.slice(0, 50), '|', m.created_timestamp && m.created_timestamp.toISOString());
  }

  // ร้านที่ last_polled_at ภายใน 1 นาทีล่าสุด
  const oneMinAgo = new Date(Date.now() - 60000);
  const recentShops = await Shop.find({ last_polled_at: { $gte: oneMinAgo } }).lean();
  console.log('\nShops polled in last 1 min:', recentShops.length);
  for (const s of recentShops.slice(0, 5)) {
    console.log('  ', s.shop_id, '|', s.shop_name || s.shopname, '| status:', s.status, '| last_polled:', s.last_polled_at && s.last_polled_at.toISOString());
  }

  process.exit(0);
}

check();
