require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

const SAMPLE_VIDEO_URL = 'https://down-tx-sg.vod.susercontent.com/api/v4/11110133/mms/th-11110133-6v8gr-mnk5stpewv7pcc.default.mp4';

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();

  console.log('downloading sample video...');
  const res = await fetch(SAMPLE_VIDEO_URL);
  if (!res.ok) {
    console.log('download failed:', res.status);
    process.exit(1);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  console.log('downloaded', buffer.length, 'bytes');

  console.log('uploading to shopee...');
  const uploadInfo = await shopeeAdapter.uploadVideoAndWait(shop, buffer);
  console.log('upload result:', JSON.stringify(uploadInfo));

  if (!uploadInfo.vid) {
    console.log('no vid, aborting');
    process.exit(1);
  }
  const status = (uploadInfo.status || '').toLowerCase();
  if (status !== 'successful' && status !== 'succeeded') {
    console.log('video not in successful state, aborting. status=', status);
    process.exit(1);
  }

  const content = {
    video: uploadInfo.video,
    thumbnail: uploadInfo.thumbnail,
    duration: uploadInfo.duration,
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
