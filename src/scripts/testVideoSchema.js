require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();

  const vid = 'th-11110120-6v8go-mrwg02sylw5h5a';
  const info = await shopeeAdapter.getVideoUploadResult(shop, vid);
  console.log('current status:', JSON.stringify(info));
  if (info.status !== 'successful') {
    console.log('vid no longer valid, aborting test');
    process.exit(1);
  }

  // Hypothesis: content must use the exact raw field names/values Shopee itself returned
  // from get_video_upload_result (video/thumbnail), not reconstructed video_url/thumb_url.
  const content = {
    video: info.video,
    thumbnail: info.thumbnail,
    duration: info.duration,
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
