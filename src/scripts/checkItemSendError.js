require('dotenv').config();
const { connectMainDB } = require('../config/db');
const RequestLog = require('../models/RequestLog');

async function check() {
  await connectMainDB();
  const logs = await RequestLog.find({ event_type: 'send_message' })
    .sort({ created_at: -1 })
    .limit(3)
    .lean();
  for (const l of logs) {
    console.log('---');
    console.log('body:', JSON.stringify(l.request_payload && l.request_payload.body));
    console.log('response:', JSON.stringify(l.response_payload));
  }
  process.exit(0);
}
check();
