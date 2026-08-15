require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Shop = require('../models/Shop');
const shopeeAdapter = require('../platforms/shopee-adapter');

async function check() {
  await connectMainDB();
  const shop = await Shop.findOne({ shop_id: '1002936956', platform: 'shopee' }).lean();
  const result = await shopeeAdapter.fetchConversations(shop, { direction: 'latest' });
  console.log(JSON.stringify(result.conversations[0], null, 2));
  process.exit(0);
}
check();
