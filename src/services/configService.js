const SystemConfig = require('../models/SystemConfig');
const Shop = require('../models/Shop');
const { getSellcenterConnection } = require('../config/sellcenterDb');
const { getTokenDoc, isTokenFresh } = require('./tokenReader');
const axios = require('axios');

// Cache config in memory for fast synchronous checks (TTL: 5 seconds)
let cachedConfig = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5000;

/**
 * ดึง SystemConfig ปัจจุบันจาก DB (พร้อม fallback ไปค่าจาก .env หากยังไม่มีข้อมูลใน DB)
 */
async function getSystemConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedConfig;
  }

  try {
    let config = await SystemConfig.findOne({ config_key: 'main_config' }).lean();
    if (!config) {
      // สร้างค่าเริ่มต้นโดยอิงจาก .env
      const defaultConfig = {
        config_key: 'main_config',
        shopee_live_read_enabled: process.env.ENABLE_POLL === 'true' || false,
        shopee_live_send_enabled: process.env.ENABLE_SEND_MESSAGE === 'true',
        shopee_live_mark_read_enabled: process.env.ENABLE_MARK_READ === 'true',
        shopee_live_pin_enabled: process.env.ENABLE_PIN === 'true',
        shopee_poll_enabled: process.env.ENABLE_POLL === 'true',
        shopee_webhook_worker_enabled: process.env.ENABLE_WEBHOOK_WORKER === 'true',
        shopee_background_sync_enabled: process.env.ENABLE_BACKGROUND_SHOPEE_SYNC === 'true',
        mock_mode_enabled: false,
        poll_interval_ms: Number(process.env.POLL_INTERVAL_MS || 20000),
        updated_by: 'initial_setup',
      };
      config = await SystemConfig.create(defaultConfig);
      config = config.toObject();
    }
    cachedConfig = config;
    lastFetchTime = now;
    return config;
  } catch (err) {
    console.error('[configService] error getting SystemConfig:', err.message);
    // Fallback to env-based object
    return {
      shopee_live_read_enabled: process.env.ENABLE_POLL === 'true' || false,
      shopee_live_send_enabled: process.env.ENABLE_SEND_MESSAGE === 'true',
      shopee_live_mark_read_enabled: process.env.ENABLE_MARK_READ === 'true',
      shopee_live_pin_enabled: process.env.ENABLE_PIN === 'true',
      shopee_poll_enabled: process.env.ENABLE_POLL === 'true',
      shopee_webhook_worker_enabled: process.env.ENABLE_WEBHOOK_WORKER === 'true',
      shopee_background_sync_enabled: process.env.ENABLE_BACKGROUND_SHOPEE_SYNC === 'true',
      mock_mode_enabled: false,
      poll_interval_ms: Number(process.env.POLL_INTERVAL_MS || 20000),
    };
  }
}

/**
 * อัปเดตการตั้งค่าระบบ
 */
async function updateSystemConfig(updates, updatedBy = 'user') {
  const allowedKeys = [
    'shopee_live_read_enabled',
    'shopee_live_send_enabled',
    'shopee_live_mark_read_enabled',
    'shopee_live_pin_enabled',
    'shopee_poll_enabled',
    'shopee_webhook_worker_enabled',
    'shopee_background_sync_enabled',
    'mock_mode_enabled',
    'poll_interval_ms',
  ];

  const sanitized = { updated_by: updatedBy };
  for (const key of allowedKeys) {
    if (updates[key] !== undefined) {
      sanitized[key] = updates[key];
    }
  }

  const updated = await SystemConfig.findOneAndUpdate(
    { config_key: 'main_config' },
    { $set: sanitized },
    { new: true, upsert: true }
  ).lean();

  cachedConfig = updated;
  lastFetchTime = Date.now();
  return updated;
}

/**
 * ทดสอบการเชื่อมต่อไปยัง Shopee API และ Sellcenter Token Database
 */
async function testShopeeIntegration() {
  const results = {
    sellcenterDb: { ok: false, message: '' },
    shopeeHost: { ok: false, message: '', latencyMs: 0 },
    shops: [],
  };

  // 1. ตรวจสอบ Sellcenter DB
  try {
    const sellcenterConn = getSellcenterConnection();
    if (sellcenterConn && (sellcenterConn.readyState === 1 || sellcenterConn.readyState === 2)) {
      results.sellcenterDb.ok = true;
      results.sellcenterDb.message = 'เชื่อมต่อฐานข้อมูล Sellcenter (dbWallet) สำเร็จ (Read-only)';
    } else {
      results.sellcenterDb.message = `สถานะการเชื่อมต่อ: readyState=${sellcenterConn ? sellcenterConn.readyState : 'none'}`;
    }
  } catch (err) {
    results.sellcenterDb.message = `เกิดข้อผิดพลาด: ${err.message}`;
  }

  // 2. ทดสอบ Shopee Host Ping
  const host = process.env.SHOPEE_HOST_URL || 'https://partner.shopeemobile.com';
  const startTime = Date.now();
  try {
    const res = await axios.get(`${host}/api/v2/public/get_shops_by_partner`, {
      timeout: 5000,
      validateStatus: () => true, // ยอมรับทุก status code เพื่อเช็คว่าเชื่อมต่อ server Shopee ได้
    });
    results.shopeeHost.ok = true;
    results.shopeeHost.latencyMs = Date.now() - startTime;
    results.shopeeHost.message = `เชื่อมต่อ Shopee API Host (${host}) สำเร็จ (HTTP ${res.status})`;
  } catch (err) {
    results.shopeeHost.latencyMs = Date.now() - startTime;
    results.shopeeHost.message = `ไม่สามารถเชื่อมต่อ Shopee Host ได้: ${err.message}`;
  }

  // 3. ตรวจสอบ Token ของแต่ละร้าน
  try {
    const shops = await Shop.find({ platform: 'shopee' }).lean();
    for (const s of shops) {
      let tokenStatus = 'unknown';
      let tokenError = null;
      try {
        const tokenDoc = await getTokenDoc({ shop_id: s.shop_id, shopname: s.shopname });
        if (tokenDoc && tokenDoc.access_token) {
          tokenStatus = isTokenFresh(tokenDoc) ? 'active' : 'expired';
        } else {
          tokenStatus = 'not_found';
        }
      } catch (err) {
        tokenStatus = 'error';
        tokenError = err.message;
      }
      results.shops.push({
        shop_id: s.shop_id,
        shop_name: s.shop_name || s.shopname || s.shop_id,
        enabled_for_chat: s.enabled_for_chat,
        tokenStatus,
        tokenError,
      });
    }
  } catch (err) {
    console.error('[configService] error checking shop tokens:', err.message);
  }

  return results;
}

module.exports = {
  getSystemConfig,
  updateSystemConfig,
  testShopeeIntegration,
};
