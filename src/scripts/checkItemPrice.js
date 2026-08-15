require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();
  const info = await shopeeAdapter.getItemBaseInfo(shop, '23169454212');
  console.log('warning/keys:', Object.keys(info));
  console.log('price_info:', JSON.stringify(info.item_list && info.item_list[0] && info.item_list[0].price_info));
  process.exit(0);
}
check();
