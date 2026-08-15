require('dotenv').config();
const { connectMainDB } = require('../config/db');
const pushConfig = require('../services/pushConfig');
const Shop = require('../models/Shop');

async function check() {
  await connectMainDB();
  // ใช้ร้านแรกที่ active สำหรับ app-level push config
  const shop = await Shop.findOne({ status: 'active' }).lean();
  console.log('Using shop for app-level config:', shop.shop_id, shop.shop_name);

  // 1. ดู push config ปัจจุบัน
  console.log('\n=== Current push config ===');
  try {
    const config = await pushConfig.getAppPushConfig(shop);
    console.log('Config:', JSON.stringify(config, null, 2));
  } catch (err) {
    console.log('Error:', err.message);
  }

  // 2. ดูค่าใน .env
  console.log('\n=== .env settings ===');
  console.log('SHOPEE_PUSH_CALLBACK_URL:', process.env.SHOPEE_PUSH_CALLBACK_URL || '(empty)');
  console.log('ENABLE_WEBHOOK_WORKER:', process.env.ENABLE_WEBHOOK_WORKER);
  console.log('ENABLE_LOST_PUSH_RECOVERY:', process.env.ENABLE_LOST_PUSH_RECOVERY);

  process.exit(0);
}

check();
