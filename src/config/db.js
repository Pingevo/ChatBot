const mongoose = require('mongoose');

// การเชื่อมต่อ MongoDB หลักของระบบแชทเอง (แยกจาก sellcenter โดยสิ้นเชิง)
async function connectMainDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set in .env');
  }
  await mongoose.connect(uri);
  console.log('[db] connected to main MongoDB (chat-center)');
  return mongoose.connection;
}

module.exports = { connectMainDB };
