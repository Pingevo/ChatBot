require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Conversation = require('../models/Conversation');
const Customer = require('../models/Customer');

async function backfill() {
  await connectMainDB();
  console.log('[backfillCustomers] Connected to DB');

  const conversations = await Conversation.find({}).lean();
  console.log(`[backfillCustomers] Aggregating ${conversations.length} conversations...`);

  const customerMap = new Map();
  for (const conv of conversations) {
    if (!conv.to_id) continue;
    const buyerId = String(conv.to_id);
    if (!customerMap.has(buyerId)) {
      customerMap.set(buyerId, {
        platform: conv.platform || 'shopee',
        buyer_id: buyerId,
        name: conv.to_name || 'ลูกค้า Shopee',
        avatar: conv.to_avatar || '',
        shops: new Set([conv.shop_id]),
        conversations: new Set([conv.conversation_id]),
        last_active_at: conv.last_message_timestamp || new Date(),
      });
    } else {
      const c = customerMap.get(buyerId);
      if (conv.shop_id) c.shops.add(conv.shop_id);
      if (conv.conversation_id) c.conversations.add(conv.conversation_id);
      if (conv.last_message_timestamp && new Date(conv.last_message_timestamp) > new Date(c.last_active_at)) {
        c.last_active_at = conv.last_message_timestamp;
      }
    }
  }

  const ops = [];
  for (const c of customerMap.values()) {
    ops.push({
      updateOne: {
        filter: { buyer_id: c.buyer_id },
        update: {
          $set: {
            platform: c.platform,
            name: c.name,
            avatar: c.avatar,
            shops: Array.from(c.shops),
            conversations: Array.from(c.conversations),
            total_conversations: c.conversations.size,
            last_active_at: c.last_active_at,
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length > 0) {
    await Customer.bulkWrite(ops);
  }

  const count = await Customer.countDocuments();
  console.log(`✅ [backfillCustomers] Successfully aggregated ${count} unique customer profiles in 'customers' collection!`);

  process.exit(0);
}

backfill().catch(err => {
  console.error('[backfillCustomers] Error:', err);
  process.exit(1);
});
