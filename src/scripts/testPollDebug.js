require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

// จำลอง logic ของ pollWorker สำหรับ Yaber เพื่อ debug
async function debug() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_name: { $regex: 'yaber', $options: 'i' } }).lean();
  console.log('Shop:', shop.shop_id);

  // จำลอง recent conv query
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  console.log('twoHoursAgo:', twoHoursAgo.toISOString());

  const recentDbConvs = await Conversation.find({
    shop_id: shop.shop_id,
    last_message_timestamp: { $gte: twoHoursAgo },
  }).lean();
  console.log('Recent DB conversations:', recentDbConvs.length);
  for (const c of recentDbConvs) {
    console.log('  conv:', c.conversation_id, '| last_msg:', c.last_message_timestamp ? c.last_message_timestamp.toISOString() : 'null');
  }

  // จำลอง convMap
  const convMap = new Map();
  // สมมุติว่า Shopee ส่งมา 5 conv (unread) + 25 conv (all) แต่ไม่มี 80245417614920823
  // แล้ว recent DB convs เพิ่ม 80245417614920823 เข้าไป
  for (const dbConv of recentDbConvs) {
    if (!convMap.has(String(dbConv.conversation_id))) {
      convMap.set(String(dbConv.conversation_id), {
        conversation_id: dbConv.conversation_id,
        unread_count: dbConv.unread_count || 0,
        last_message_timestamp: null,
        _fromDb: true,
      });
    }
  }

  console.log('\nconvMap entries:', convMap.size);
  for (const [id, conv] of convMap) {
    console.log('  ', id, '| _fromDb:', conv._fromDb, '| unread:', conv.unread_count);
  }

  // จำลองเงื่อนไขการดึง messages
  const targetConv = convMap.get('80245417614920823');
  if (targetConv) {
    console.log('\nTarget conv 80245417614920823 found in convMap');
    const existingConv = await Conversation.findOne(
      { shop_id: shop.shop_id, conversation_id: '80245417614920823' },
      { last_message_timestamp: 1 }
    ).lean();
    console.log('existingConv:', existingConv ? 'FOUND' : 'NOT FOUND');
    console.log('dbTimestamp:', existingConv?.last_message_timestamp);

    const isRecentFromDb = !!targetConv._fromDb;
    console.log('isRecentFromDb:', isRecentFromDb);
    console.log('Should fetch messages:', isRecentFromDb ? 'YES' : 'NO');
  } else {
    console.log('\n❌ Target conv NOT in convMap!');
  }

  process.exit(0);
}

debug();
