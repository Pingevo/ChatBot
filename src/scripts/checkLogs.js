require('dotenv').config();
const { connectMainDB } = require('../config/db');
const RequestLog = require('../models/RequestLog');

async function check() {
  await connectMainDB();
  const logs = await RequestLog.find({}).sort({ created_at: -1 }).limit(20).lean();
  console.log('Recent RequestLogs:', logs.length);
  for (const l of logs) {
    console.log('  ', l.event_type, '| shop:', l.shop_id, '| status:', l.status_code, '| error:', l.error || '-', '| time:', l.created_at && l.created_at.toISOString());
  }
  const successCount = await RequestLog.countDocuments({ event_type: 'poll_cycle', status_code: 200, error: { $in: [null, ''] } });
  const errorCount = await RequestLog.countDocuments({ event_type: 'poll_cycle', error: { $nin: [null, ''] } });
  console.log('\nPoll cycle success:', successCount, '| error:', errorCount);
  process.exit(0);
}

check();
