require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function test() {
  await connectMainDB();

  // หา conv ของ Yaber ที่มีข้อความล่าสุด
  const conv = await Conversation.findOne({
    shop_id: '1002936956',
    conversation_id: '80245417614920823',
  }).lean();

  if (!conv) {
    console.log('Conversation not found');
    process.exit(1);
  }

  console.log('Conversation:', conv.conversation_id);
  console.log('to_id:', conv.to_id);
  console.log('shop_id:', conv.shop_id);

  const shop = await Shop.findOne({ shop_id: conv.shop_id }).lean();
  console.log('Shop:', shop.shop_id, shop.shop_name);

  // ทดสอบส่งข้อความ
  console.log('\n=== Sending test message ===');
  try {
    const result = await shopeeAdapter.sendMessage(shop, {
      toId: conv.to_id,
      conversationId: conv.conversation_id,
      messageType: 'text',
      content: { text: 'ทดสอบระบบ — ขออภัยหากรบกวนนะคะ' },
    });
    console.log('✅ Send success:', JSON.stringify(result, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  } catch (err) {
    console.log('❌ Send failed:', err.message);
  }

  process.exit(0);
}

test();
