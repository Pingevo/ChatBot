const Customer = require('../models/Customer');

/**
 * ซิงค์/สร้างโปรไฟล์ลูกค้าใน collection 'customers' อัตโนมัติเมื่อมีแชทเข้ามา
 */
async function syncCustomerFromConversation(conv) {
  if (!conv || !conv.to_id) return;
  try {
    await Customer.updateOne(
      { buyer_id: String(conv.to_id) },
      {
        $set: {
          platform: conv.platform || 'shopee',
          buyer_id: String(conv.to_id),
          name: conv.to_name || 'ลูกค้า Shopee',
          avatar: conv.to_avatar || '',
          last_active_at: conv.last_message_timestamp || new Date(),
        },
        $addToSet: {
          shops: conv.shop_id,
          conversations: conv.conversation_id,
        },
      },
      { upsert: true }
    );

    // อัปเดตยอดรวมแชท
    const cust = await Customer.findOne({ buyer_id: String(conv.to_id) });
    if (cust) {
      cust.total_conversations = cust.conversations ? cust.conversations.length : 0;
      await cust.save();
    }
  } catch (err) {
    // เงียบไว้ ไม่ให้ขัดจังหวะ pipeline หลัก
  }
}

module.exports = { syncCustomerFromConversation };
