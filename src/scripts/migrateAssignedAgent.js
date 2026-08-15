require('dotenv').config();
const { connectMainDB } = require('../config/db');
const Conversation = require('../models/Conversation');
const User = require('../models/User');

// แปลง Conversation.assigned_agent (free-text ชื่อเดิม) -> assigned_to (ref User)
// จับคู่ด้วยชื่อ/nickname แบบ case-insensitive ตรงเป๊ะเท่านั้น — จับคู่ไม่ได้ปล่อย assigned_to เป็น null (ไม่เดา)
// รันซ้ำได้ปลอดภัย (idempotent) — ข้าม conversation ที่มี assigned_to อยู่แล้ว
async function migrate() {
  await connectMainDB();
  console.log('[migrateAssignedAgent] connected to DB');

  const users = await User.find({ isDeleted: false }).lean();
  const byName = new Map();
  for (const u of users) {
    if (u.name) byName.set(u.name.trim().toLowerCase(), u);
    if (u.nickname) byName.set(u.nickname.trim().toLowerCase(), u);
  }

  const conversations = await Conversation.find({
    assigned_agent: { $ne: null },
    assigned_to: null,
  }).lean();
  console.log(`[migrateAssignedAgent] ${conversations.length} conversation(s) มี assigned_agent แต่ยังไม่มี assigned_to`);

  let matched = 0;
  let unmatched = 0;
  const unmatchedNames = new Set();

  for (const conv of conversations) {
    const key = (conv.assigned_agent || '').trim().toLowerCase();
    const user = key ? byName.get(key) : null;

    if (user) {
      // eslint-disable-next-line no-await-in-loop
      await Conversation.updateOne(
        { _id: conv._id },
        { $set: { assigned_to: user._id, assigned_at: conv.updatedAt || new Date(), assignment_mode_used: 'migrated_from_free_text' } }
      );
      matched++;
    } else {
      unmatched++;
      unmatchedNames.add(conv.assigned_agent);
    }
  }

  console.log(`[migrateAssignedAgent] จับคู่สำเร็จ ${matched} แชท, จับคู่ไม่ได้ ${unmatched} แชท`);
  if (unmatchedNames.size > 0) {
    console.log('[migrateAssignedAgent] ชื่อที่จับคู่ไม่ได้ (ต้องสร้าง User หรือแก้ชื่อให้ตรงแล้วรันสคริปต์นี้ซ้ำ):', [...unmatchedNames]);
  }

  process.exit(0);
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('[migrateAssignedAgent] error:', err);
    process.exit(1);
  });
}

module.exports = { migrate };
