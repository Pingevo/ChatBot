require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Conversation = require('../models/Conversation');

async function check() {
  await connectMainDB();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  console.log('Time now:', new Date().toISOString());
  console.log('Two hours ago:', twoHoursAgo.toISOString());

  const recentDbConvs = await Conversation.find({
    shop_id: '1002936956',
    last_message_timestamp: { $gte: twoHoursAgo },
  }).lean();
  console.log('Recent conversations (last 2h) for Yaber:', recentDbConvs.length);
  for (const c of recentDbConvs) {
    console.log('  conv:', c.conversation_id, '| last_msg:', c.last_message_timestamp ? c.last_message_timestamp.toISOString() : 'null');
  }

  // ลองไม่กรองเวลา ดูทั้งหมดของ Yaber
  const allYaber = await Conversation.find({ shop_id: '1002936956' }).sort({ last_message_timestamp: -1 }).limit(5).lean();
  console.log('\nAll Yaber conversations (newest 5):');
  for (const c of allYaber) {
    console.log('  conv:', c.conversation_id, '| last_msg:', c.last_message_timestamp ? c.last_message_timestamp.toISOString() : 'null');
  }

  process.exit(0);
}

check();
