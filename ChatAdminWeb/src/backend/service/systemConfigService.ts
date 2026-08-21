// SystemConfig service — adapted from ChatBotPDigg/src/services/configService.js
// แต่ปรับให้ปลอดภัยกว่า: สวิตช์อันตราย (live read/send/mark_read/pin/poll)
// hard-coded เป็น false ใน safety.ts ไม่สามารถเปิดจาก DB หรือ env ได้
//
// สถาปัตยกรรมใหม่ (Phase 7): พี่เขา (sellcenter) เขียนข้อมูลแชทลง MongoDB ของเราตรงๆ
// ผ่าน collection conversations + messages (user: chatbot_writer ของพี่เขา)
// เราไม่ต้อง sync จาก dbWallet แล้ว — อ่านจาก chatbot DB ของเราเอง
//
// สวิตช์ที่ปลอดภัย — เปิด/ปิดได้:
// - mock_mode_enabled (สำหรับทดสอบระบบโดยไม่ยิง API จริง)
// - shadow_bot_enabled (bot generate reply แต่ไม่ส่งจริง)
// - polling_interval_ms (realtime inbox refresh — default 1000ms)
//
// สวิตช์อันตราย — ทุก platform ล็อค false ใน safety.ts:
// - shopee/tiktok/lazada live send/read
import { Document } from "mongodb";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { SAFETY } from "../lib/safety";

export type Platform = "shopee" | "tiktok" | "lazada";

export interface SystemConfigDoc extends Document {
  config_key: string;

  // === สวิตช์อันตราย — คืนค่าจาก SAFETY เสมอ (hard-coded false) ===
  shopee_live_read_enabled: boolean;
  shopee_live_send_enabled: boolean;
  shopee_live_mark_read_enabled: boolean;
  shopee_live_pin_enabled: boolean;
  shopee_poll_enabled: boolean;
  // เผื่ออนาคต — TikTok / Lazada
  tiktok_live_send_enabled: boolean;
  tiktok_live_read_enabled: boolean;
  lazada_live_send_enabled: boolean;
  lazada_live_read_enabled: boolean;

  // === สวิตช์ปลอดภัย — เก็บใน DB ได้ ===
  mock_mode_enabled: boolean;
  shadow_bot_enabled: boolean;
  polling_interval_ms: number;
  bot_worker_enabled: boolean;       // Phase 9 — เปิด/ปิด bot worker (auto pipeline)
  bot_worker_interval_ms: number;    // Phase 9 — worker poll interval (default 2000)

  // === Bot service URLs (3 ตัว แยก port) ===
  shopee_bot_url: string;
  tiktok_bot_url: string;
  lazada_bot_url: string;

  updated_by: string;
  updated_at: Date;
}

// Cache config in memory (TTL: 5 seconds)
let cachedConfig: SystemConfigDoc | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5000;

// ค่า default สำหรับสวิตช์ปลอดภัย (อ่านจาก env ตอน boot)
function getSafeDefaults(): Partial<SystemConfigDoc> {
  return {
    mock_mode_enabled: process.env.MOCK_MODE_ENABLED === 'true',
    shadow_bot_enabled: process.env.SHADOW_BOT_ENABLED === 'true',
    polling_interval_ms: Number(process.env.POLLING_INTERVAL_MS || 1000),
    bot_worker_enabled: process.env.BOT_WORKER_ENABLED === 'true',
    bot_worker_interval_ms: Number(process.env.BOT_WORKER_INTERVAL_MS || 1000),
    shopee_bot_url: process.env.CHATBOT_BASE_URL_SHOPEE || 'http://127.0.0.1:8010',
    tiktok_bot_url: process.env.CHATBOT_BASE_URL_TIKTOK || 'http://127.0.0.1:8011',
    lazada_bot_url: process.env.CHATBOT_BASE_URL_LAZADA || 'http://127.0.0.1:8012',
  };
}

// รวมค่าจาก DB กับค่า hard-coded จาก SAFETY
// สวิตช์อันตรายเสมอจาก SAFETY (false) ไม่อ่านจาก DB
function mergeWithSafety(dbConfig: Partial<SystemConfigDoc>): SystemConfigDoc {
  const safeDefaults = getSafeDefaults();
  return {
    config_key: dbConfig.config_key || 'main_config',

    // Shopee — hard-coded false จาก SAFETY
    shopee_live_read_enabled: SAFETY.shopeeLiveRead,
    shopee_live_send_enabled: SAFETY.shopeeLiveSend,
    shopee_live_mark_read_enabled: SAFETY.shopeeLiveMarkRead,
    shopee_live_pin_enabled: SAFETY.shopeeLivePin,
    shopee_poll_enabled: SAFETY.shopeePoll,
    // TikTok — เผื่ออนาคต
    tiktok_live_send_enabled: SAFETY.tiktokLiveSend,
    tiktok_live_read_enabled: SAFETY.tiktokLiveRead,
    // Lazada — เผื่ออนาคต
    lazada_live_send_enabled: SAFETY.lazadaLiveSend,
    lazada_live_read_enabled: SAFETY.lazadaLiveRead,

    // สวิตช์ปลอดภัย — จาก DB หรือ env
    mock_mode_enabled: dbConfig.mock_mode_enabled ?? safeDefaults.mock_mode_enabled ?? false,
    shadow_bot_enabled: dbConfig.shadow_bot_enabled ?? safeDefaults.shadow_bot_enabled ?? false,
    polling_interval_ms: dbConfig.polling_interval_ms ?? safeDefaults.polling_interval_ms ?? 1000,
    bot_worker_enabled: dbConfig.bot_worker_enabled ?? safeDefaults.bot_worker_enabled ?? false,
    bot_worker_interval_ms: dbConfig.bot_worker_interval_ms ?? safeDefaults.bot_worker_interval_ms ?? 1000,

    // Bot URLs — จาก DB หรือ env
    shopee_bot_url: dbConfig.shopee_bot_url ?? safeDefaults.shopee_bot_url ?? 'http://127.0.0.1:8010',
    tiktok_bot_url: dbConfig.tiktok_bot_url ?? safeDefaults.tiktok_bot_url ?? 'http://127.0.0.1:8011',
    lazada_bot_url: dbConfig.lazada_bot_url ?? safeDefaults.lazada_bot_url ?? 'http://127.0.0.1:8012',

    updated_by: dbConfig.updated_by || 'system',
    updated_at: dbConfig.updated_at || new Date(),
  };
}

/**
 * ดึง SystemConfig ปัจจุบัน — สวิตช์อันตรายเสมอเป็น false จาก SAFETY
 */
export async function getSystemConfig(forceRefresh = false): Promise<SystemConfigDoc> {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedConfig;
  }

  try {
    const coll = await getCollection<SystemConfigDoc>(COLLECTIONS.systemConfigs);
    let config = await coll.findOne({ config_key: 'main_config' });

    if (!config) {
      // สร้าง default config ครั้งแรก
      const safeDefaults = getSafeDefaults();
      const defaultDoc: Omit<SystemConfigDoc, '_id'> = {
        config_key: 'main_config',
        // อันตราย — false เสมอ
        shopee_live_read_enabled: SAFETY.shopeeLiveRead,
        shopee_live_send_enabled: SAFETY.shopeeLiveSend,
        shopee_live_mark_read_enabled: SAFETY.shopeeLiveMarkRead,
        shopee_live_pin_enabled: SAFETY.shopeeLivePin,
        shopee_poll_enabled: SAFETY.shopeePoll,
        tiktok_live_send_enabled: SAFETY.tiktokLiveSend,
        tiktok_live_read_enabled: SAFETY.tiktokLiveRead,
        lazada_live_send_enabled: SAFETY.lazadaLiveSend,
        lazada_live_read_enabled: SAFETY.lazadaLiveRead,
        // ปลอดภัย
        mock_mode_enabled: safeDefaults.mock_mode_enabled ?? false,
        shadow_bot_enabled: safeDefaults.shadow_bot_enabled ?? false,
        polling_interval_ms: safeDefaults.polling_interval_ms ?? 1000,
        bot_worker_enabled: safeDefaults.bot_worker_enabled ?? false,
        bot_worker_interval_ms: safeDefaults.bot_worker_interval_ms ?? 1000,
        shopee_bot_url: safeDefaults.shopee_bot_url ?? 'http://127.0.0.1:8010',
        tiktok_bot_url: safeDefaults.tiktok_bot_url ?? 'http://127.0.0.1:8011',
        lazada_bot_url: safeDefaults.lazada_bot_url ?? 'http://127.0.0.1:8012',
        updated_by: 'initial_setup',
        updated_at: new Date(),
      };
      await coll.insertOne(defaultDoc as SystemConfigDoc);
      config = await coll.findOne({ config_key: 'main_config' });
    }

    cachedConfig = mergeWithSafety(config || {});
    lastFetchTime = now;
    return cachedConfig;
  } catch (err) {
    console.error('[systemConfigService] error getting SystemConfig:', err);
    // Fallback — สวิตช์อันตรายเสมอ false จาก SAFETY
    return mergeWithSafety({});
  }
}

/**
 * อัปเดต SystemConfig — สวิตช์อันตรายไม่สามารถเปลี่ยนได้
 * ถ้ามีคนส่ง *_live_*_enabled มา จะถูก ignore และใช้ค่าจาก SAFETY
 */
export async function updateSystemConfig(
  updates: Partial<SystemConfigDoc>,
  updatedBy = 'admin'
): Promise<SystemConfigDoc> {
  // Whitelist — อนุญาตเฉพาะสวิตช์ปลอดภัย + bot URLs
  const allowedKeys: (keyof SystemConfigDoc)[] = [
    'mock_mode_enabled',
    'shadow_bot_enabled',
    'polling_interval_ms',
    'bot_worker_enabled',
    'bot_worker_interval_ms',
    'shopee_bot_url',
    'tiktok_bot_url',
    'lazada_bot_url',
  ];

  const sanitized: Record<string, unknown> = { updated_by: updatedBy, updated_at: new Date() };
  for (const key of allowedKeys) {
    if (updates[key] !== undefined) {
      sanitized[key] = updates[key];
    }
  }

  const coll = await getCollection<SystemConfigDoc>(COLLECTIONS.systemConfigs);
  await coll.updateOne(
    { config_key: 'main_config' },
    { $set: sanitized },
    { upsert: true }
  );

  // Force refresh cache
  cachedConfig = null;
  return getSystemConfig(true);
}

/**
 * ตรวจสอบการเชื่อมต่อ (ปรับใหม่ Phase 7):
 * 1. Admin DB (chatbot) — ต้องเชื่อมได้
 * 2. dbWallet (สินค้า) — สำหรับ productService (read-only)
 * 3. Bot services (3 ตัว) — เช็ค health endpoint
 * 4. Data activity — ดู last message timestamp ใน conversations/messages
 *
 * ไม่ยิง Shopee API ใดๆ
 */
export async function testIntegration(): Promise<{
  adminDb: { ok: boolean; message: string };
  dbWallet: { ok: boolean; message: string };
  shopeeBot: { ok: boolean; message: string };
  tiktokBot: { ok: boolean; message: string };
  lazadaBot: { ok: boolean; message: string };
  dataActivity: { ok: boolean; message: string };
}> {
  const results = {
    adminDb: { ok: false, message: '' },
    dbWallet: { ok: false, message: '' },
    shopeeBot: { ok: false, message: '' },
    tiktokBot: { ok: false, message: '' },
    lazadaBot: { ok: false, message: '' },
    dataActivity: { ok: false, message: '' },
  };

  // 1. ตรวจสอบ Admin DB (chatbot)
  try {
    const coll = await getCollection(COLLECTIONS.systemConfigs);
    await coll.countDocuments({ limit: 1 });
    results.adminDb.ok = true;
    results.adminDb.message = 'เชื่อมต่อ Admin DB (chatbot) สำเร็จ';
  } catch (err) {
    results.adminDb.message = `Admin DB error: ${(err as Error).message}`;
  }

  // 2. ตรวจสอบ dbWallet — สินค้า (MONGO_URI / dbwallet_ro)
  try {
    const { getDbWalletCollection } = await import("../db/dbWalletClient");
    const coll = await getDbWalletCollection(process.env.SHP_PRODUCTS_COLLECTION || "ShpProducts");
    const count = await coll.estimatedDocumentCount();
    results.dbWallet.ok = true;
    results.dbWallet.message = `dbWallet OK — สินค้า ${count} รายการ`;
  } catch (err) {
    results.dbWallet.message = `dbWallet (สินค้า) error: ${(err as Error).message}`;
  }

  // 3. ตรวจสอบ Bot services (3 ตัว แยก port)
  const config = await getSystemConfig(true);
  const botUrls: { key: 'shopeeBot' | 'tiktokBot' | 'lazadaBot'; url: string }[] = [
    { key: 'shopeeBot', url: config.shopee_bot_url },
    { key: 'tiktokBot', url: config.tiktok_bot_url },
    { key: 'lazadaBot', url: config.lazada_bot_url },
  ];

  await Promise.all(botUrls.map(async ({ key, url }) => {
    try {
      const resp = await fetch(`${url.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        results[key].ok = true;
        results[key].message = `${url} — ตอบกลับ OK`;
      } else {
        results[key].message = `${url} — HTTP ${resp.status}`;
      }
    } catch (err) {
      results[key].message = `${url} — ${(err as Error).message}`;
    }
  }));

  // 4. ตรวจสอบ data activity — ดู last message timestamp ใน conversations
  try {
    const coll = await getCollection(COLLECTIONS.conversations);
    const last = await coll.findOne({}, { sort: { last_message_timestamp: -1 } });
    if (last) {
      const ts = last.last_message_timestamp as Date;
      const ageSec = Math.floor((Date.now() - ts.getTime()) / 1000);
      results.dataActivity.ok = true;
      results.dataActivity.message = `Data writer ใช้งาน — ข้อความล่าสุด ${ageSec}s ที่แล้ว`;
    } else {
      results.dataActivity.ok = false;
      results.dataActivity.message = 'ยังไม่มีข้อมูลใน conversations (รอ data writer จาก sellcenter)';
    }
  } catch (err) {
    results.dataActivity.message = `Data activity check error: ${(err as Error).message}`;
  }

  return results;
}

export const systemConfigService = {
  getSystemConfig,
  updateSystemConfig,
  testIntegration,
};
