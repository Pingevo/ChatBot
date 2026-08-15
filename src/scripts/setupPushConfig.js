require('dotenv').config();
const { connectMainDB } = require('../config/db');
const { setAppPushConfig, getAppPushConfig, PUSH_CODES } = require('../services/pushConfig');

/**
 * ตั้งค่า Shopee Push Mechanism (webhook) ครั้งแรก
 * 1. ตั้ง callback URL (HTTPS บังคับ)
 * 2. subscribe webchat_push (Code 10) เพื่อรับแจ้งเมื่อมีข้อความแชทใหม่
 *
 * วิธีใช้:
 *   SHOPEE_PUSH_CALLBACK_URL=https://your-domain.com/webhook/shopee npm run push:config
 *
 * หลังรันแล้ว Shopee จะส่ง HTTP POST มาที่ callback URL เพื่อ verify
 * ต้องตอบ 200 ก่อนถึงจะ subscribe สำเร็จ
 */
async function main() {
  await connectMainDB();

  const callbackUrl = process.env.SHOPEE_PUSH_CALLBACK_URL;
  if (!callbackUrl) {
    console.error('❌ SHOPEE_PUSH_CALLBACK_URL not set in .env');
    console.error('   ตั้งค่า HTTPS URL ที่ Shopee จะส่ง push มา เช่น:');
    console.error('   SHOPEE_PUSH_CALLBACK_URL=https://your-domain.com/webhook/shopee');
    process.exit(1);
  }

  if (!callbackUrl.startsWith('https://')) {
    console.error('❌ callback URL ต้องเป็น HTTPS เท่านั้น (Shopee บังคับ)');
    process.exit(1);
  }

  // เช็ค config ปัจจุบันก่อน
  console.log('📋 ตรวจสอบ push config ปัจจุบัน...');
  try {
    const current = await getAppPushConfig();
    console.log('   current config:', JSON.stringify(current, null, 2));
  } catch (err) {
    console.log(`   (ไม่สามารถดึง config ปัจจุบัน: ${err.message})`);
  }

  // ตั้ง callback URL + subscribe webchat_push
  console.log(`\n🔧 ตั้งค่า callback URL: ${callbackUrl}`);
  console.log('   subscribe: webchat_push (Code 10)');

  try {
    await setAppPushConfig({
      callbackUrl,
      enableCodes: [PUSH_CODES.WEBCHAT],
    });
    console.log('\n✅ สำเร็จ! Shopee จะส่ง push มาที่ callback URL เมื่อมีข้อความแชทใหม่');
    console.log('   ตรวจสอบว่า webhook receiver ทำงานอยู่ (server.js ต้องรัน)');
    console.log('   และเปิด ENABLE_WEBHOOK_WORKER=true เพื่อให้ worker ประมวลผล queue');
  } catch (err) {
    console.error(`\n❌ ล้มเหลว: ${err.message}`);
    console.error('   ตรวจสอบ:');
    console.error('   - callback URL ต้องเป็น HTTPS และเข้าถึงได้จากอินเทอร์เน็ต');
    console.error('   - webhook receiver ต้องรันอยู่และตอบ 200');
    console.error('   - PARTNER_ID และ PARTNER_KEY ต้องถูกต้อง');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
