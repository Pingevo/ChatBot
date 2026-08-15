require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Shop = require('../models/Shop');
const PushEvent = require('../models/PushEvent');
const RequestLog = require('../models/RequestLog');

async function buildAllIndexes() {
  await connectMainDB();
  console.log('[buildIndexes] Connected to DB');

  console.log('[buildIndexes] Building indexes for Conversation model...');
  await Conversation.createIndexes();

  console.log('[buildIndexes] Building indexes for Message model...');
  await Message.createIndexes();

  console.log('[buildIndexes] Building indexes for Shop model...');
  await Shop.createIndexes();

  console.log('[buildIndexes] Building indexes for PushEvent model...');
  await PushEvent.createIndexes();

  console.log('[buildIndexes] Building indexes for RequestLog model...');
  await RequestLog.createIndexes();

  console.log('✅ [buildIndexes] All high-performance 10M+ indexes built successfully!');
  process.exit(0);
}

buildAllIndexes().catch(err => {
  console.error('[buildIndexes] Error building indexes:', err);
  process.exit(1);
});
