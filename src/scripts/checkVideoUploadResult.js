require('dotenv').config();
const { connectMainDB } = require('../config/db');
const RequestLog = require('../models/RequestLog');

async function check() {
  await connectMainDB();
  const logs = await RequestLog.find({ event_type: { $in: ['get_video_upload_result', 'upload_video'] } })
    .sort({ created_at: -1 })
    .limit(20)
    .lean();
  console.log('Recent upload/result logs:', logs.length);
  for (const l of logs) {
    console.log('---');
    console.log('event:', l.event_type, '| time:', l.created_at && l.created_at.toISOString());
    console.log('status:', l.status_code, '| error:', l.error || '-');
    console.log('response:', JSON.stringify(l.response_payload));
  }
  process.exit(0);
}

check();
