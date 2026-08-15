const mongoose = require('mongoose');

// ⚠️ READ-ONLY เสมอ — ระบบแชทนี้ห้ามเขียนลง dbWallet ยกเว้นกรณี fallback refresh
// (megaplan ข้อ 2.3 / ข้อ 12.1) ใช้ createConnection แยกจาก main DB โดยสิ้นเชิง
// เพราะเป็นคนละ MongoDB instance/database กัน

let sellcenterConnection = null;

function getSellcenterConnection() {
  if (sellcenterConnection) return sellcenterConnection;

  const uri = process.env.SELLCENTER_MONGO_URI;
  if (!uri) {
    throw new Error('SELLCENTER_MONGO_URI is not set in .env');
  }

  sellcenterConnection = mongoose.createConnection(uri);

  sellcenterConnection.on('connected', () => {
    console.log('[sellcenter-db] connected (read-only) to dbWallet');
  });
  sellcenterConnection.on('error', (err) => {
    console.error('[sellcenter-db] connection error:', err.message);
  });

  return sellcenterConnection;
}

// Schema แบบหลวมๆ (strict: false) เพราะเราแค่ "อ่าน" เอกสารที่ sellcenter
// เป็นคนกำหนดโครงสร้าง ไม่ควร lock schema แน่นจนพังตอน sellcenter เพิ่ม field ใหม่
const shpTokenSchema = new mongoose.Schema({}, { strict: false, collection: process.env.SELLCENTER_TOKEN_COLLECTION || 'Shp2022Token' });

function getShpTokenModel() {
  const conn = getSellcenterConnection();
  const collectionName = process.env.SELLCENTER_TOKEN_COLLECTION || 'Shp2022Token';
  // ป้องกัน OverwriteModelError ถ้าเรียกซ้ำ
  return conn.models[collectionName] || conn.model(collectionName, shpTokenSchema, collectionName);
}

// ทำเนียบพนักงาน (system81) — อ่าน profile (full_name/department/position/email) มา enrich
// บัญชี staff ของ chat-center ตอน login เท่านั้น ห้ามเขียนกลับ และห้ามอ่าน field password
const usersSchema = new mongoose.Schema({}, { strict: false, collection: process.env.SELLCENTER_USERS_COLLECTION || 'Users' });

function getSellcenterUserModel() {
  const conn = getSellcenterConnection();
  const collectionName = process.env.SELLCENTER_USERS_COLLECTION || 'Users';
  return conn.models[collectionName] || conn.model(collectionName, usersSchema, collectionName);
}

// ห้องแชท/ข้อความที่ sellcenter เก็บไว้เอง (ShpPushController.js case 10 — รับ push code 10
// จาก Shopee โดยตรงแล้ว upsert ลง 2 collection นี้) ใช้เป็นแหล่งอ่านสำรอง read-only เหมือนกัน
// เผื่อ environment นี้ยังไม่ได้ต่อ webhook forward เอง (ดู ENABLE_BACKGROUND_SHOPEE_SYNC ใน
// routes/api.js) — schema หลวมๆ เหมือนกันเพราะ sellcenter เป็นคนกำหนดโครงสร้างจริง
const shpChatConversationsSchema = new mongoose.Schema({}, { strict: false, collection: 'ShpChatConversations' });
const shpChatMessagesSchema = new mongoose.Schema({}, { strict: false, collection: 'ShpChatMessages' });

function getShpChatConversationsModel() {
  const conn = getSellcenterConnection();
  return conn.models.ShpChatConversations || conn.model('ShpChatConversations', shpChatConversationsSchema, 'ShpChatConversations');
}

function getShpChatMessagesModel() {
  const conn = getSellcenterConnection();
  return conn.models.ShpChatMessages || conn.model('ShpChatMessages', shpChatMessagesSchema, 'ShpChatMessages');
}

module.exports = {
  getSellcenterConnection,
  getShpTokenModel,
  getSellcenterUserModel,
  getShpChatConversationsModel,
  getShpChatMessagesModel,
};
