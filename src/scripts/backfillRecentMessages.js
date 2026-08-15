require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

async function backfill() {
  await connectMainDB();
  console.log('[backfillRecentMessages] Connected to DB');

  const conversations = await Conversation.find({}).lean();
  console.log(`[backfillRecentMessages] Backfilling recent_messages for ${conversations.length} conversations...`);

  // Batch process in parallel chunks of 50
  const chunkSize = 50;
  let updatedCount = 0;
  for (let i = 0; i < conversations.length; i += chunkSize) {
    const chunk = conversations.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async conv => {
        const recentMsgs = await Message.find({ conversation_id: conv.conversation_id })
          .sort({ created_timestamp: -1 })
          .limit(10)
          .lean();

        if (recentMsgs.length > 0) {
          await Conversation.updateOne(
            { _id: conv._id },
            { $set: { recent_messages: recentMsgs } }
          );
          updatedCount++;
        }
      })
    );
  }

  console.log(`✅ [backfillRecentMessages] Successfully backfilled recent_messages array for ${updatedCount} chat rooms!`);
  process.exit(0);
}

backfill().catch(err => {
  console.error('[backfillRecentMessages] Error:', err);
  process.exit(1);
});
