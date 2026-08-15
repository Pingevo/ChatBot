require('dotenv').config();
const { connectMainDB } = require('../config/db');
const RequestLog = require('../models/RequestLog');

async function resetLogs() {
  await connectMainDB();
  console.log('[resetLogs] Connected to DB');

  const totalBefore = await RequestLog.countDocuments();
  console.log(`[resetLogs] Total RequestLog count before reset: ${totalBefore}`);

  // ล้างข้อมูลใน collection requestlogs ทั้งหมด
  const result = await RequestLog.deleteMany({});
  console.log(`[resetLogs] Deleted all ${result.deletedCount} RequestLog documents`);

  // สั่ง syncIndexes เพื่อสร้าง TTL Index (expireAfterSeconds 7 วัน) ให้สมบูรณ์
  await RequestLog.syncIndexes();
  console.log('[resetLogs] Re-created all indexes including TTL Index successfully');

  const totalAfter = await RequestLog.countDocuments();
  console.log(`[resetLogs] Total RequestLog count after reset: ${totalAfter}`);

  process.exit(0);
}

resetLogs().catch(err => {
  console.error('[resetLogs] Error:', err);
  process.exit(1);
});
