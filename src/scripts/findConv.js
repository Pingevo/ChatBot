require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Conversation = require('../models/Conversation');

async function check() {
  await connectMainDB();
  const convs = await Conversation.find({ to_id: '193103108' }).lean();
  console.log(JSON.stringify(convs.map(c => ({ conversation_id: c.conversation_id, to_id: c.to_id, shop_id: c.shop_id })), null, 2));
  process.exit(0);
}
check();
