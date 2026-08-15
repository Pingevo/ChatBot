const dotenv = require('dotenv');
dotenv.config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const RequestLog = require('../models/RequestLog');

  const logs = await RequestLog.find({ direction: 'api_out' }).sort({ created_at: -1 }).limit(20).lean();
  console.log('--- RECENT API_OUT REQUEST LOGS ---');
  for (const l of logs) {
    console.log(`[${l.created_at}] Event: ${l.event_type} | Shop: ${l.shop_id} | Code: ${l.status_code} | Error: ${l.error || 'none'}`);
    console.log('  Req Body:', JSON.stringify(l.request_payload ? l.request_payload.body : null));
    console.log('  Res Payload:', JSON.stringify(l.response_payload));
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
