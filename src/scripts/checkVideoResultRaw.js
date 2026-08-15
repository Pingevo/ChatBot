require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();
  if (!shop) {
    console.log('shop not found, listing available shops:');
    const shops = await Shop.find({ platform: 'shopee' }).lean();
    console.log(shops.map(s => ({ shop_id: s.shop_id, shopname: s.shopname })));
    process.exit(1);
  }

  const vids = [
    'th-11110120-6v8go-mrwg02sylw5h5a',
    'th-11110120-6v8gs-mrwfs66gui9x0a',
    'th-11110120-6v8gw-mrwez9k5t4aue0',
  ];

  for (const vid of vids) {
    try {
      const result = await shopeeAdapter.getVideoUploadResult(shop, vid);
      console.log('---');
      console.log('vid:', vid);
      console.log('raw result:', JSON.stringify(result, null, 2));
    } catch (e) {
      console.log('---');
      console.log('vid:', vid, 'ERROR:', e.message);
    }
  }
  process.exit(0);
}

check();
