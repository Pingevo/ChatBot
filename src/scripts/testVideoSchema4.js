require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

const vid = 'th-11110120-6v8gu-mrwgdzu0hds4ec';

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();

  const info = await shopeeAdapter.getVideoUploadResult(shop, vid);
  console.log('current status:', JSON.stringify(info));
  if (info.status !== 'successful') {
    console.log('vid expired, aborting');
    process.exit(1);
  }

  const durationSeconds = Math.min(180, Math.max(1, Math.round(info.duration / 1000)));

  const content = {
    vid,
    video_url: info.video,
    thumb_url: info.thumbnail,
    thumb_width: info.width,
    thumb_height: info.height,
    duration_seconds: durationSeconds,
  };
  console.log('trying content:', JSON.stringify(content));

  try {
    const result = await shopeeAdapter.sendMessage(shop, {
      toId: '193103108',
      conversationId: '829371534619069559',
      messageType: 'video',
      content,
    });
    console.log('SUCCESS:', JSON.stringify(result));
  } catch (e) {
    console.log('FAILED:', e.message);
  }
  process.exit(0);
}
check();
