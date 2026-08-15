require('dotenv').config();
const { connectMainDB } = require('../config/db');
const RequestLog = require('../models/RequestLog');

async function check() {
  await connectMainDB();
  const logs = await RequestLog.find({ event_type: 'product/get_item_base_info' })
    .sort({ created_at: -1 })
    .limit(3)
    .lean();
  for (const l of logs) {
    console.log('---');
    console.log('time:', l.created_at);
    console.log('request:', JSON.stringify(l.request_payload));
    console.log('warning/error:', l.error, JSON.stringify(l.response_payload && l.response_payload.warning));
    console.log('top-level keys:', l.response_payload && Object.keys(l.response_payload));
    const item = l.response_payload && l.response_payload.response && l.response_payload.response.item_list && l.response_payload.response.item_list[0];
    console.log('item keys:', item && Object.keys(item));
  }
  process.exit(0);
}
check();
