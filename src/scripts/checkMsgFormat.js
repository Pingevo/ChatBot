require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Message = require('../models/Message');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();

  const { messages } = await shopeeAdapter.fetchMessages(shop, '80245417614920823', { pageSize: 50 });
  console.log('Shopee messages:', messages.length);

  // ดู message_id ของ 3 ข้อความที่ไม่อยู่ใน DB
  const dbMsgs = await Message.find({ conversation_id: '80245417614920823' }).lean();
  const dbMsgIds = new Set(dbMsgs.map(m => String(m.message_id)));

  for (const m of messages) {
    const inDb = dbMsgIds.has(String(m.message_id));
    if (!inDb) {
      console.log('\nNOT IN DB:');
      console.log('  message_id:', m.message_id);
      console.log('  type:', typeof m.message_id);
      console.log('  String(message_id):', String(m.message_id));
      console.log('  message_type:', m.message_type);
      console.log('  from_shop_id:', m.from_shop_id, '| shop_id:', shop.shop_id);
      console.log('  created_timestamp:', m.created_timestamp);

      // ลอง query ตรงๆ
      const found = await Message.findOne({ message_id: String(m.message_id) }).lean();
      console.log('  Direct query by message_id:', found ? 'FOUND' : 'NOT FOUND');

      // ลอง query แบบอื่น
      const found2 = await Message.findOne({ message_id: m.message_id.toString() }).lean();
      console.log('  Direct query .toString():', found2 ? 'FOUND' : 'NOT FOUND');
    }
  }

  // ดู DB message_id ตัวอย่าง
  console.log('\nDB message_id samples:');
  for (const m of dbMsgs.slice(0, 3)) {
    console.log('  ', m.message_id, '| type:', typeof m.message_id);
  }

  process.exit(0);
}

check();
