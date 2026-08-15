const crypto = require('crypto');
require('dotenv').config();

const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY;
const receivedSig = '761db8146e1a7d1b3225d0a05cc16f3749c24467a2b34ffe22444fb05ca9f320';

// raw request จาก ngrok (base64 encoded)
const rawRequestB64 = 'UE9TVCAvd2ViaG9vay9zaG9wZWUgSFRUUC8xLjENCkhvc3Q6IGNhcmxvYWQtc2libGluZy1sYWJvcmlvdXMubmdyb2stZnJlZS5kZXYNClVzZXItQWdlbnQ6IEdvLWh0dHAtY2xpZW50LzIuMA0KQ29udGVudC1MZW5ndGg6IDEwNA0KQWNjZXB0LUVuY29kaW5nOiBnemlwDQpBdXRob3JpemF0aW9uOiA3NjFkYjgxNDZlMWE3ZDFiMzIyNWQwYTA1Y2MxNmYzNzQ5YzI0NDY3YTJiMzRmZmUyMjQ0NGZiMDVjYTlmMzIwDQpDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24NClgtRm9yd2FyZGVkLUZvcjogMjAyLjE4MS45MC4zNg0KWC1Gb3J3YXJkZWQtSG9zdDogY2FybG9hZC1zaWJsaW5nLWxhYm9yaW91cy5uZ3Jvay1mcmVlLmRldg0KWC1Gb3J3YXJkZWQtUHJvdG86IGh0dHBzDQoNCnsiY29kZSI6MCwiZGF0YSI6eyJ2ZXJpZnlfaW5mbyI6IlRoaXMgaXMgYSBWZXJpZmljYXRpb24gbWVzc2FnZS5QbGVhc2UgcmVzcG9uZCBpbiB0aGUgY2VydGFpbiBmb3JtYXQuIn19';

const rawRequest = Buffer.from(rawRequestB64, 'base64').toString('utf8');
console.log('=== Raw request from ngrok ===');
console.log(rawRequest);
console.log('');

// แยก body ออกจาก headers (หลัง \r\n\r\n)
const bodyStart = rawRequest.indexOf('\r\n\r\n');
const rawBody = rawRequest.slice(bodyStart + 4);
console.log('=== Extracted body ===');
console.log(JSON.stringify(rawBody));
console.log('body length:', rawBody.length);
console.log('');

// URL ที่ Shopee ใช้ sign อาจเป็นแบบต่างๆ
const urls = [
  'https://carload-sibling-laborious.ngrok-free.dev/webhook/shopee',
  'https://carload-sibling-laborious.ngrok-free.dev/webhook/shopee/',
  'carload-sibling-laborious.ngrok-free.dev/webhook/shopee',
];

for (const url of urls) {
  const sig = crypto.createHmac('sha256', PARTNER_KEY).update(`${url}|${rawBody}`).digest('hex');
  const match = sig === receivedSig ? '✅ MATCH!' : '❌';
  console.log(`${match} url=${url}`);
  console.log(`   sig=${sig}`);
}

// ลองใช้ body แบบที่เราเห็นใน debug log (อาจมี whitespace ต่าง)
const debugBody = '{"code":0,"data":{"verify_info":"This is a Verification message.Please respond in the certain format."}}';
console.log('');
console.log('debugBody === rawBody?', debugBody === rawBody);
console.log('debugBody length:', debugBody.length, '| rawBody length:', rawBody.length);

// เช็ค byte ต่างกัน
if (debugBody !== rawBody) {
  for (let i = 0; i < Math.max(debugBody.length, rawBody.length); i++) {
    if (debugBody[i] !== rawBody[i]) {
      console.log(`diff at byte ${i}: debugBody='${debugBody[i]}' (${debugBody.charCodeAt(i)}) rawBody='${rawBody[i]}' (${rawBody.charCodeAt(i)})`);
      break;
    }
  }
}
