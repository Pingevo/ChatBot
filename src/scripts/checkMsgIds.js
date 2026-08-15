require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Message = require('../models/Message');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();

  // ดึง 25 ข้อความจาก Shopee (เหมือน pollWorker)
  const { messages } = await shopeeAdapter.fetchMessages(shop, '80245417614920823', { pageSize: 25 });
  console.log('Shopee messages (page_size=25):', messages.length);

  // ดึง DB messages
  const dbMsgs = await Message.find({ conversation_id: '80245417614920823' }).lean();
  const dbMsgIds = new Set(dbMsgs.map(m => String(m.message_id)));
  console.log('DB messages:', dbMsgs.length);

  // เช็คแต่ละข้อความจาก Shopee ว่าอยู่ใน DB ไหม
  let inDbCount = 0;
  let notInDbCount = 0;
  for (const m of messages) {
    const inDb = dbMsgIds.has(String(m.message_id));
    if (inDb) {
      inDbCount++;
    } else {
      notInDbCount++;
      const text = (m.content && m.content.text) || '[' + m.message_type + ']';
      console.log('  NOT IN DB:', m.message_id, '|', m.message_type, '|', text.slice(0, 50));
    }
  }
  console.log('In DB:', inDbCount, '| Not in DB:', notInDbCount);

  // ลองบันทึกเองเพื่อดู error
  console.log('\n=== Try saving one missing message ===');
  const missing = messages.find(m => !dbMsgIds.has(String(m.message_id)));
  if (missing) {
    console.log('Missing message_id:', missing.message_id, '| type:', missing.message_type);
    try {
      const result = await Message.updateOne(
        { message_id: String(missing.message_id) },
        {
          $set: {
            platform: 'shopee',
            shop_id: shop.shop_id,
            conversation_id: String(missing.conversation_id),
            from_id: String(missing.from_id),
            from_shop_id: String(missing.from_shop_id),
            to_id: String(missing.to_id),
            to_shop_id: String(missing.to_shop_id),
            message_type: missing.message_type,
            direction: 'in',
            content: missing.content,
            status: missing.status,
            source: missing.source,
            created_timestamp: new Date(Number(missing.created_timestamp) * 1000),
            raw_payload: missing,
          },
        },
        { upsert: true }
      );
      console.log('Save result:', JSON.stringify(result));
    } catch (err) {
      console.log('❌ Save error:', err.message);
    }
  }

  process.exit(0);
}

check();
