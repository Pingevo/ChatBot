require('dotenv').config();
const { connectMainDB } = require('../config/db');
const RequestLog = require('../models/RequestLog');

async function check() {
  await connectMainDB();
  const logs = await RequestLog.find({ event_type: 'send_message' })
    .sort({ created_at: -1 })
    .limit(30)
    .lean();
  console.log('Recent send_message logs:', logs.length);
  for (const l of logs) {
    const isVideoAttempt = l.request_payload && l.request_payload.body && l.request_payload.body.message_type === 'video';
    console.log('---');
    console.log('time:', l.created_at && l.created_at.toISOString());
    console.log('status:', l.status_code, '| error:', l.error || '-');
    console.log('message_type sent:', l.request_payload && l.request_payload.body && l.request_payload.body.message_type);
    console.log('body:', JSON.stringify(l.request_payload && l.request_payload.body));
    console.log('response:', JSON.stringify(l.response_payload));
  }
  process.exit(0);
}

check();
