require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

const vid = 'th-11110120-6v8gu-mrwgdzu0hds4ec';

async function trySend(shop, label, content) {
  console.log('---', label, JSON.stringify(content));
  try {
    const result = await shopeeAdapter.sendMessage(shop, {
      toId: '193103108',
      conversationId: '829371534619069559',
      messageType: 'video',
      content,
    });
    console.log('SUCCESS:', JSON.stringify(result));
    return true;
  } catch (e) {
    console.log('FAILED:', e.message);
    return false;
  }
}

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();

  const info = await shopeeAdapter.getVideoUploadResult(shop, vid);
  console.log('current status:', JSON.stringify(info));
  if (info.status !== 'successful') {
    console.log('vid expired, aborting');
    process.exit(1);
  }

  const variants = [
    ['bare video_url (relative path)', { video_url: info.video }],
    ['bare video_url + thumb_url (relative)', { video_url: info.video, thumb_url: info.thumbnail }],
    ['just vid field', { vid }],
    ['video_id only', { video_id: vid }],
  ];

  for (const [label, content] of variants) {
    const ok = await trySend(shop, label, content);
    if (ok) {
      console.log('*** FOUND WORKING SCHEMA:', label);
      break;
    }
  }
  process.exit(0);
}
check();
