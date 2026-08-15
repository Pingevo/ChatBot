require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Message = require('../models/Message');

async function check() {
  await connectMainDB();
  const msgs = await Message.find({ message_type: 'video' })
    .sort({ created_at: -1 })
    .limit(15)
    .lean();
  console.log('Recent video messages:', msgs.length);
  for (const m of msgs) {
    console.log('---');
    console.log('message_id:', m.message_id, '| direction:', m.direction, '| from_id:', m.from_id, '| conv:', m.conversation_id);
    console.log('content:', JSON.stringify(m.content));
  }
  process.exit(0);
}

check();
