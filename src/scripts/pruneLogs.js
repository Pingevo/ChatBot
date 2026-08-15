require('dotenv').config();
const { connectMainDB } = require('../config/db');
const RequestLog = require('../models/RequestLog');

async function prune() {
  await connectMainDB();
  console.log('[prune] Connected to DB');

  const totalBefore = await RequestLog.countDocuments();
  console.log(`[prune] Total RequestLog count before cleanup: ${totalBefore}`);

  // ลบ Log ที่เป็น routine poll/api ที่สำเร็จ (ไม่มี error) เก่าเกิน 2 ชั่วโมงทิ้งเพื่อเคลียร์พื้นที่สะสม
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const result = await RequestLog.deleteMany({
    created_at: { $lt: twoHoursAgo },
    error: { $in: [null, ''] }
  });
  console.log(`[prune] Deleted ${result.deletedCount} routine successful logs older than 2 hours`);

  const totalAfter = await RequestLog.countDocuments();
  console.log(`[prune] Total RequestLog count after cleanup: ${totalAfter}`);

  // ตรวจสอบและสร้าง TTL Index
  try {
    await RequestLog.createIndexes();
    console.log('[prune] RequestLog TTL indexes verified successfully');
  } catch (e) {
    console.log('[prune] Index creation notice:', e.message);
  }

  process.exit(0);
}

prune().catch(err => {
  console.error('[prune] Error:', err);
  process.exit(1);
});
