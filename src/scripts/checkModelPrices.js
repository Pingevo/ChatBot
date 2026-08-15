require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();
  const result = await shopeeAdapter.getModelList(shop, '28914191235');
  console.log(JSON.stringify(result.model, null, 2));
  process.exit(0);
}
check();
