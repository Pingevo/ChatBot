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

module.exports = { getSellcenterConnection, getShpTokenModel };
