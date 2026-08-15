const crypto = require('crypto');
require('dotenv').config();

const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const callbackUrl = 'https://carload-sibling-laborious.ngrok-free.dev/webhook/shopee';
const rawBody = '{"code":0,"data":{"verify_info":"This is a Verification message.Please respond in the certain format."}}';
const receivedSig = '761db8146e1a7d1b3225d0a05cc16f3749c24467a2b34ffe22444fb05ca9f320';

console.log('PARTNER_KEY (first 8):', PARTNER_KEY.slice(0, 8), '...');
console.log('receivedSig:', receivedSig);
console.log('');

// ลองหลายสูตร
const tests = [
  { name: 'HMAC(callbackUrl|rawBody)', calc: () => crypto.createHmac('sha256', PARTNER_KEY).update(`${callbackUrl}|${rawBody}`).digest('hex') },
  { name: 'HMAC(rawBody)', calc: () => crypto.createHmac('sha256', PARTNER_KEY).update(rawBody).digest('hex') },
  { name: 'HMAC(callbackUrl)', calc: () => crypto.createHmac('sha256', PARTNER_KEY).update(callbackUrl).digest('hex') },
  { name: 'SHA256(callbackUrl|rawBody)', calc: () => crypto.createHash('sha256').update(`${callbackUrl}|${rawBody}`).digest('hex') },
  { name: 'SHA256(rawBody)', calc: () => crypto.createHash('sha256').update(rawBody).digest('hex') },
  { name: 'HMAC(callbackUrl|rawBody) with PARTNER_ID as key', calc: () => crypto.createHmac('sha256', process.env.SHOPEE_PARTNER_ID).update(`${callbackUrl}|${rawBody}`).digest('hex') },
  { name: 'HMAC(rawBody) with PARTNER_ID as key', calc: () => crypto.createHmac('sha256', process.env.SHOPEE_PARTNER_ID).update(rawBody).digest('hex') },
  // ลองแบบมี newline ท้าย rawBody
  { name: 'HMAC(callbackUrl|rawBody\\n)', calc: () => crypto.createHmac('sha256', PARTNER_KEY).update(`${callbackUrl}|${rawBody}\n`).digest('hex') },
  // ลอกแบบไม่มี |
  { name: 'HMAC(callbackUrl+rawBody)', calc: () => crypto.createHmac('sha256', PARTNER_KEY).update(`${callbackUrl}${rawBody}`).digest('hex') },
];

for (const t of tests) {
  const sig = t.calc();
  const match = sig === receivedSig ? '✅ MATCH!' : '';
  console.log(`${match} ${t.name}: ${sig.slice(0, 20)}...`);
}
