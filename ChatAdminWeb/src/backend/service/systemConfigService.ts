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
import { isSafeFetchUrl } from "../lib/urlSafety";

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
  // ⚡ Phase 2D — platform gate ของ botworker admission (missing = OFF ทุกตัว;
  //   เปิดได้เฉพาะ BOTWORKER_BACKENDS — tiktok/lazada backend ยังไม่ implement)
  bot_worker_platforms?: { shopee?: boolean; tiktok?: boolean; lazada?: boolean };
  // ⚡ per-platform enable rising-edge — เขียน atomic พร้อม bot_worker_platforms
  //   ใน updateSystemConfig (server-derived — ไม่อยู่ใน allowedKeys);
  //   flag=true แต่ timestamp หาย/null → resolver fail-closed
  bot_worker_platform_enabled_at?: { shopee?: Date | null; tiktok?: Date | null; lazada?: Date | null };

  // === Bot Message Buffering (Debounce) — admin-configurable ===
  bot_buffer_enabled: boolean;       // เปิด/ปิด message buffering
  bot_buffer_window_ms: number;      // รอ X ms หลัง message สุดท้ายก่อนประมวลผล
  bot_buffer_max_messages: number;   // ถ้าครบ X ข้อความใน window → ประมวลผลเลย
  // ⚡ Phase 1E — media-aware buffer: รอนานกว่า + รับได้มากกว่าเมื่อมีรูป/วิดีโอ
  bot_buffer_window_media_ms: number;    // window สำหรับ media (default = window * 2)
  bot_buffer_max_media_messages: number; // max สำหรับ media (default = max * 2)
  // ⚡ Phase 2Q — concurrency limit (จำนวน callBot ขนานกันสูงสุด)
  bot_concurrency_limit: number;         // default 50 — ป้องกัน Python bot โอเวอร์โหลด

  // === Workflow Engine (แบบ Zaapi Flow Builder) — superadmin/dev configurable ===
  workflow_enabled: boolean;              // สวิตช์เปิด/ปิด workflow engine ทั้งหมด
  // ⚡ Phase 9 — workflow_priority ถูกถอด: fixed order workflow→trigger→bot ใน owner เดียว
  //   (persisted legacy value ใน DB คงอยู่เป็น inert data — ไม่มี runtime reader)
  workflow_run_timeout_ms: number;        // flow รอ reply เกินเวลานี้ → cancel อัตโนมัติ

  // === Assignment — admin-configurable ===
  // ⚡ G2 — true = จ่ายงานให้แอดมินคนเดิมที่เคยตอบก่อน, false = round-robin เลย
  assignment_prefer_previous_admin: boolean;

  // === Bot service URLs (3 ตัว แยก port) ===
  shopee_bot_url: string;
  tiktok_bot_url: string;
  lazada_bot_url: string;

  // === Chat Engine — เลือก logic ตอบของบอท ===
  // "legacy" = app.py chat() (default, ปลอดภัย)
  // "v2"     = chat_v2.py (pipeline ใหม่ 8 stages)
  // "v3"     = chatbotv3/ (OpenRouter-first, LLM ตอบเอง + match สินค้าจริง)
  // มีผลทุกหน้า: shadowbot, botworker, test-assignment, live-assignment, replay-compare, testchat
  chat_engine: 'legacy' | 'v2' | 'v3';

  // ⚡ Phase 8 — LLM context limit (จำนวนสินค้าสูงสุดที่ส่งเข้า LLM เป็น context)
  // แยกจาก frontend display limit (req.limit) — ค่านี้ควบคุมว่า LLM เห็นสินค้ากี่ชิ้น
  // default 30, range 10-50 (ปรับได้จากหน้า config)
  llm_context_limit: number;

  // === Legacy Shopee grouped retrieval (Task 5B3-D) — dev-only ===
  // DB เป็น owner เมื่อเขียนค่าแล้ว · field absent → bot fallback env เดิม
  grouped_retrieval_shadow_enabled: boolean;    // observe-only pipeline (log เทียบ)
  grouped_retrieval_selection_enabled: boolean; // ⚠️ มีผลกับคำตอบจริงเมื่อเปิด

  // ⚡ Phase 10A — global web-search operator gate (bot อ่านจาก DB ≤5s)
  //   strict bool: เปิดได้เฉพาะ persisted true · missing/invalid → OFF
  //   ไม่มี env fallback — OFF = zero external web/provider calls ทุก path
  web_search_enabled: boolean;

  // === Workstream E — central evidence pool + strict KB selector ===
  // pool_sources: key absent/non-bool → ON (default เดิม); OFF = source ไม่ query
  // kb_source: strict "legacy"|"zaapi" — flip ผ่าน setKbSource (CAS+readiness) เท่านั้น
  pool_sources?: { kb?: boolean; mongo_catalog?: boolean; units?: boolean; image_text?: boolean };
  kb_source?: 'legacy' | 'zaapi';

  updated_by: string;
  updated_at: Date;
}

// Cache config in memory (TTL: 5 seconds)
let cachedConfig: SystemConfigDoc | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 5000;

// ⚡ fail-closed projection — operational enable switches = false เสมอเมื่อ DB read ล้ม
//   (warm: override บน cachedConfig / cold: override บน safety defaults —
//   env/DB/stale ห้ามรั่วเป็น true กลาง outage)
const FAIL_CLOSED_SWITCHES = {
  bot_worker_enabled: false,
  // ⚡ Phase 2D — platform scope ต้อง fail-closed เหมือน global switch
  bot_worker_platforms: { shopee: false, tiktok: false, lazada: false },
  bot_buffer_enabled: false,
  workflow_enabled: false,
  shadow_bot_enabled: false,
  mock_mode_enabled: false,
  grouped_retrieval_shadow_enabled: false,
  grouped_retrieval_selection_enabled: false,
  web_search_enabled: false,
} as const;

// ค่า default สำหรับสวิตช์ปลอดภัย (อ่านจาก env ตอน boot)
function getSafeDefaults(): Partial<SystemConfigDoc> {
  return {
    mock_mode_enabled: process.env.MOCK_MODE_ENABLED === 'true',
    shadow_bot_enabled: process.env.SHADOW_BOT_ENABLED === 'true',
    polling_interval_ms: Number(process.env.POLLING_INTERVAL_MS || 1000),
    bot_worker_enabled: process.env.BOT_WORKER_ENABLED === 'true',
    bot_worker_interval_ms: Number(process.env.BOT_WORKER_INTERVAL_MS || 1000),
    bot_buffer_enabled: process.env.BOT_BUFFER_ENABLED === 'true',
    bot_buffer_window_ms: Number(process.env.BOT_BUFFER_WINDOW_MS || 6000),
    bot_buffer_max_messages: Number(process.env.BOT_BUFFER_MAX_MESSAGES || 5),
    bot_buffer_window_media_ms: Number(process.env.BOT_BUFFER_WINDOW_MEDIA_MS || 12000),
    bot_buffer_max_media_messages: Number(process.env.BOT_BUFFER_MAX_MEDIA_MESSAGES || 10),
    bot_concurrency_limit: Number(process.env.BOT_CONCURRENCY_LIMIT || 50),
    workflow_enabled: process.env.WORKFLOW_ENABLED === 'true',
    workflow_run_timeout_ms: Number(process.env.WORKFLOW_RUN_TIMEOUT_MS || 1800000),
    // ⚡ G2 — default true = จ่ายงานให้แอดมินคนเดิม (behavior เดิม)
    assignment_prefer_previous_admin: process.env.ASSIGNMENT_PREFER_PREVIOUS_ADMIN !== 'false',
    shopee_bot_url: process.env.CHATBOT_BASE_URL_SHOPEE || 'http://127.0.0.1:8010',
    // ⚡ BUG-G fix — สลับ port ให้ตรงกับ config.ts / docker-compose.yml
    //   tiktok → 8012, lazada → 8011 (ไม่ใช่ tiktok=8011, lazada=8012 แบบเดิม)
    tiktok_bot_url: process.env.CHATBOT_BASE_URL_TIKTOK || 'http://127.0.0.1:8012',
    lazada_bot_url: process.env.CHATBOT_BASE_URL_LAZADA || 'http://127.0.0.1:8011',
    // ⚡ chat_engine — default "legacy" (ปลอดภัย), เปลี่ยนได้จากหน้า config
    chat_engine: (process.env.CHAT_ENGINE as 'legacy' | 'v2' | 'v3') || 'legacy',
    // ⚡ Phase 8 — LLM context limit (default 30, range 10-50)
    llm_context_limit: Number(process.env.LLM_CONTEXT_LIMIT || 30),
    // ⚡ Task 5B3-D — grouped retrieval flags (default ปิด — DB เป็น owner หลังเขียน)
    grouped_retrieval_shadow_enabled: process.env.USE_GROUPED_RETRIEVAL_SHADOW === 'true',
    grouped_retrieval_selection_enabled: process.env.USE_GROUPED_RETRIEVAL_SELECTION === 'true',
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
    // ⚡ Phase 2D — normalize เป็น {platform:boolean} เสมอ; missing/unknown key = OFF
    //   (ไม่มี env fallback — เปิด platform ต้องเขียน DB ผ่าน config owner เท่านั้น)
    bot_worker_platforms: {
      shopee: dbConfig.bot_worker_platforms?.shopee === true,
      tiktok: dbConfig.bot_worker_platforms?.tiktok === true,
      lazada: dbConfig.bot_worker_platforms?.lazada === true,
    },
    // ⚡ carry enable edges — ไม่ normalize (Date เท่านั้นที่นับเป็นเปิด;
    //   null/missing = fail-closed ใน resolver)
    bot_worker_platform_enabled_at: dbConfig.bot_worker_platform_enabled_at,

    // Buffer — จาก DB หรือ env
    bot_buffer_enabled: dbConfig.bot_buffer_enabled ?? safeDefaults.bot_buffer_enabled ?? false,
    bot_buffer_window_ms: dbConfig.bot_buffer_window_ms ?? safeDefaults.bot_buffer_window_ms ?? 6000,
    bot_buffer_max_messages: dbConfig.bot_buffer_max_messages ?? safeDefaults.bot_buffer_max_messages ?? 5,
    bot_buffer_window_media_ms: dbConfig.bot_buffer_window_media_ms ?? safeDefaults.bot_buffer_window_media_ms ?? 12000,
    bot_buffer_max_media_messages: dbConfig.bot_buffer_max_media_messages ?? safeDefaults.bot_buffer_max_media_messages ?? 10,
    bot_concurrency_limit: dbConfig.bot_concurrency_limit ?? safeDefaults.bot_concurrency_limit ?? 50,

    // Workflow engine — จาก DB หรือ env (default: ปิด + timeout 30 นาที)
    workflow_enabled: dbConfig.workflow_enabled ?? safeDefaults.workflow_enabled ?? false,
    workflow_run_timeout_ms: dbConfig.workflow_run_timeout_ms ?? safeDefaults.workflow_run_timeout_ms ?? 1800000,

    // ⚡ G2 — assignment: จ่ายงานให้แอดมินคนเดิม (default true = behavior เดิม)
    assignment_prefer_previous_admin: dbConfig.assignment_prefer_previous_admin ?? safeDefaults.assignment_prefer_previous_admin ?? true,

    // Bot URLs — จาก DB หรือ env
    shopee_bot_url: dbConfig.shopee_bot_url ?? safeDefaults.shopee_bot_url ?? 'http://127.0.0.1:8010',
    // ⚡ BUG-G fix — สลับ port ให้ตรงกับ config.ts (tiktok=8012, lazada=8011)
    tiktok_bot_url: dbConfig.tiktok_bot_url ?? safeDefaults.tiktok_bot_url ?? 'http://127.0.0.1:8012',
    lazada_bot_url: dbConfig.lazada_bot_url ?? safeDefaults.lazada_bot_url ?? 'http://127.0.0.1:8011',

    // ⚡ chat_engine — "legacy" (default) หรือ "v2"
    chat_engine: dbConfig.chat_engine ?? safeDefaults.chat_engine ?? 'legacy',

    // ⚡ Phase 8 — LLM context limit (default 30, range 10-50)
    llm_context_limit: dbConfig.llm_context_limit ?? safeDefaults.llm_context_limit ?? 30,

    // ⚡ Task 5B3-D — grouped retrieval (default ปิด)
    grouped_retrieval_shadow_enabled: dbConfig.grouped_retrieval_shadow_enabled ?? safeDefaults.grouped_retrieval_shadow_enabled ?? false,
    grouped_retrieval_selection_enabled: dbConfig.grouped_retrieval_selection_enabled ?? safeDefaults.grouped_retrieval_selection_enabled ?? false,

    // ⚡ Phase 10A — web-search operator gate: strict bool, no env fallback
    //   (persisted true เท่านั้นที่เปิด — invalid/missing → OFF)
    web_search_enabled: dbConfig.web_search_enabled === true,

    // ⚡ Workstream E — normalize เป็น effective state เสมอ: key absent/non-bool → ON
    //   (ตรง semantics ฝั่ง bot) เพื่อให้ UI อ่านค่าจริงได้
    pool_sources: {
      kb: dbConfig.pool_sources?.kb !== false,
      mongo_catalog: dbConfig.pool_sources?.mongo_catalog !== false,
      units: dbConfig.pool_sources?.units !== false,
      image_text: dbConfig.pool_sources?.image_text !== false,
    },
    kb_source: dbConfig.kb_source === 'zaapi' ? 'zaapi' : 'legacy',

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
        bot_buffer_enabled: safeDefaults.bot_buffer_enabled ?? false,
        bot_buffer_window_ms: safeDefaults.bot_buffer_window_ms ?? 6000,
        bot_buffer_max_messages: safeDefaults.bot_buffer_max_messages ?? 5,
        bot_buffer_window_media_ms: safeDefaults.bot_buffer_window_media_ms ?? 12000,
        bot_buffer_max_media_messages: safeDefaults.bot_buffer_max_media_messages ?? 10,
        bot_concurrency_limit: safeDefaults.bot_concurrency_limit ?? 50,
        workflow_enabled: safeDefaults.workflow_enabled ?? false,
        workflow_run_timeout_ms: safeDefaults.workflow_run_timeout_ms ?? 1800000,
        // ⚡ G2 — default true = จ่ายงานให้แอดมินคนเดิม
        assignment_prefer_previous_admin: safeDefaults.assignment_prefer_previous_admin ?? true,
        shopee_bot_url: safeDefaults.shopee_bot_url ?? 'http://127.0.0.1:8010',
        // ⚡ BUG-G fix — สลับ port ให้ตรงกับ config.ts (tiktok=8012, lazada=8011)
        tiktok_bot_url: safeDefaults.tiktok_bot_url ?? 'http://127.0.0.1:8012',
        lazada_bot_url: safeDefaults.lazada_bot_url ?? 'http://127.0.0.1:8011',
        // ⚡ chat_engine — default "legacy"
        chat_engine: safeDefaults.chat_engine ?? 'legacy',
        // ⚡ Phase 8 — LLM context limit (default 30)
        llm_context_limit: safeDefaults.llm_context_limit ?? 30,
        // ⚡ Task 5B3-D — grouped retrieval (default ปิด)
        grouped_retrieval_shadow_enabled: safeDefaults.grouped_retrieval_shadow_enabled ?? false,
        grouped_retrieval_selection_enabled: safeDefaults.grouped_retrieval_selection_enabled ?? false,
        // ⚡ Phase 10A — web-search operator gate (default ปิด, no env fallback)
        web_search_enabled: false,
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
    // ⚡ explicit fail policy on read failure — owner เดียวที่นี่:
    //   fail-closed (false) = operational enable switches (FAIL_CLOSED_SWITCHES
    //     — ใช้ร่วมทั้ง warm/cold; env หรือ stale cache ห้ามรั่วเป็น true)
    //   fail-stale  = limits/windows/URLs/engine (ค่าล่าสุดที่ validate แล้ว
    //     — เช่น bot_concurrency_limit ป้องกัน burst)
    //   cold start (ไม่เคยอ่านสำเร็จ) = safety defaults + concurrency fail-closed 1
    if (cachedConfig) {
      return { ...cachedConfig, ...FAIL_CLOSED_SWITCHES };
    }
    return { ...mergeWithSafety({}), ...FAIL_CLOSED_SWITCHES, bot_concurrency_limit: 1 };
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
    // ⚡ bot_worker_platforms ไม่อยู่ใน whitelist นี้ — enable edge ต้องเขียนผ่าน
    //   setBotWorkerPlatformEnabled (CAS on expected state) เจ้าของเดียวเท่านั้น
    'bot_buffer_enabled',
    'bot_buffer_window_ms',
    'bot_buffer_max_messages',
    'bot_buffer_window_media_ms',
    'bot_buffer_max_media_messages',
    'workflow_enabled',
    'workflow_run_timeout_ms',
    'shopee_bot_url',
    'tiktok_bot_url',
    'lazada_bot_url',
    'chat_engine',
    // ⚡ Phase 8 — LLM context limit (admin-configurable)
    'llm_context_limit',
    // ⚡ Task 5B3-D — grouped retrieval (dev-only)
    'grouped_retrieval_shadow_enabled',
    'grouped_retrieval_selection_enabled',
    // ⚡ Phase 10A — web-search operator gate (dev-only)
    'web_search_enabled',
    // ⚡ Workstream E — pool source switches (kb_source ไม่อยู่ตรงนี้ — flip ผ่าน setKbSource CAS เท่านั้น)
    'pool_sources',
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
 * ⚡ Phase 2D — platform enable-edge CAS owner เดียว (concurrency-safe):
 *   client ส่ง expected persisted state → Mongo write filter บน expected เท่านั้น
 *   (missing field ≡ false canonical) — write เดียวครอบ flag + timestamp edge:
 *   OFF→ON stamp `bot_worker_platform_enabled_at.<platform>` ใน successful write
 *   เดียวกัน · ON→OFF clear null · true→true idempotent = no write ไม่ขยับ edge
 *   CAS miss → reread 1 ครั้ง (bounded) → caller แปลเป็น 409 · ไม่มี auto retry
 */
export async function setBotWorkerPlatformEnabled(
  platform: string,
  enabled: boolean,
  expected: boolean,
  updatedBy = 'admin'
): Promise<{ applied: true; changed: boolean } | { applied: false; current: boolean }> {
  const coll = await getCollection<SystemConfigDoc>(COLLECTIONS.systemConfigs);
  const flagField = `bot_worker_platforms.${platform}`;
  const atField = `bot_worker_platform_enabled_at.${platform}`;
  const stateFilter: Record<string, unknown> = expected
    ? { [flagField]: true }
    : { $or: [{ [flagField]: false }, { [flagField]: { $exists: false } }] };
  const reportCurrent = async () => {
    const cur = await coll.findOne({ config_key: 'main_config' });
    const flags = cur?.bot_worker_platforms as Record<string, unknown> | undefined;
    return { applied: false as const, current: flags?.[platform] === true };
  };

  // ⚡ desired === caller's expected persisted state → idempotent no-op —
  //   probe persisted จริง (zero write, edge ไม่ขยับ): persisted≠expected = stale
  //   expectation → miss → caller แปลเป็น 409 (ห้ามตอบ applied ลอยๆ)
  if (enabled === expected) {
    const probe = await coll.findOne(
      { config_key: 'main_config', ...stateFilter },
      { projection: { _id: 1 } }
    );
    if (probe) return { applied: true, changed: false };
    return reportCurrent();
  }

  try {
    const applied = await coll.updateOne(
      { config_key: 'main_config', ...stateFilter },
      {
        $set: {
          [flagField]: enabled,
          [atField]: enabled ? new Date() : null,
          updated_by: updatedBy,
          updated_at: new Date(),
        },
      },
      // upsert เฉพาะ expected=false (missing ≡ false → OFF→ON บน doc ใหม่ถือว่าตรง CAS)
      //   expected=true + missing doc ต้อง CAS miss → 409 ไม่ใช่ upsert
      { upsert: !expected }
    );
    if (applied.matchedCount === 1 || applied.upsertedCount > 0) {
      cachedConfig = null;
      return { applied: true, changed: true };
    }
  } catch (e) {
    // ⚡ expected=false + persisted=true → filter miss → upsert insert ชน unique
    //   config_key → E11000 = CAS miss ของ race — แปลเป็น reread path เดียวกัน
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  // CAS miss → one bounded reread to report persisted truth (no retry)
  return reportCurrent();
}

/**
 * ⚡ Workstream E — zaapi_kb readiness gate (single owner).
 * flip kb_source=zaapi ได้ก็ต่อเมื่อ zaapi_kb พร้อม: collection มี doc active อย่างน้อย 1
 * (P2 เพิ่ม: schema/indexes/embeddings + retrieval smoke)
 */
export async function zaapiKbReady(): Promise<{ ready: boolean; reason: string }> {
  try {
    const coll = await getCollection<Document>('zaapi_kb');
    const count = await coll.countDocuments({ active: { $ne: false } }, { limit: 1 });
    return count > 0
      ? { ready: true, reason: `zaapi_kb active docs >= 1` }
      : { ready: false, reason: 'zaapi_kb has no active documents' };
  } catch (e) {
    return { ready: false, reason: `zaapi_kb unreadable: ${(e as Error).message}` };
  }
}

/**
 * ⚡ Workstream E — kb_source strict selector CAS owner เดียว.
 *   legacy→zaapi ต้องผ่าน zaapiKbReady() (fail-closed, ไม่มี implicit fallback)
 *   zaapi→legacy = rollback path ไม่ต้อง readiness (legacy dataset ไม่เคยถูกแตะ)
 *   expected = caller's expected persisted state → stale → applied:false + current
 */
export async function setKbSource(
  source: 'legacy' | 'zaapi',
  expected: 'legacy' | 'zaapi',
  updatedBy = 'admin'
): Promise<{ applied: true; changed: boolean } | { applied: false; current: 'legacy' | 'zaapi'; reason?: string }> {
  const coll = await getCollection<SystemConfigDoc>(COLLECTIONS.systemConfigs);
  const stateFilter: Record<string, unknown> = expected === 'zaapi'
    ? { kb_source: 'zaapi' }
    : { $or: [{ kb_source: 'legacy' }, { kb_source: { $exists: false } }] };
  const reportCurrent = async () => {
    const cur = await coll.findOne({ config_key: 'main_config' });
    return { applied: false as const, current: cur?.kb_source === 'zaapi' ? 'zaapi' as const : 'legacy' as const };
  };

  if (source === expected) {
    const probe = await coll.findOne({ config_key: 'main_config', ...stateFilter }, { projection: { _id: 1 } });
    if (probe) return { applied: true, changed: false };
    return reportCurrent();
  }

  // readiness gate — zaapi เท่านั้น; rollback → legacy เสมอผ่าน
  if (source === 'zaapi') {
    const gate = await zaapiKbReady();
    if (!gate.ready) return { ...(await reportCurrent()), reason: gate.reason };
  }

  try {
    const applied = await coll.updateOne(
      { config_key: 'main_config', ...stateFilter },
      {
        $set: {
          kb_source: source,
          kb_source_updated_at: new Date(),
          updated_by: updatedBy,
          updated_at: new Date(),
        } as Record<string, unknown>,
      },
      { upsert: expected === 'legacy' }
    );
    if (applied.matchedCount === 1 || applied.upsertedCount > 0) {
      cachedConfig = null;
      return { applied: true, changed: true };
    }
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  return reportCurrent();
}

/**
 * ⚡ shouldUseChatV2 — อ่าน chat_engine จาก SystemConfig
 * ใช้ตัดสินใจว่าจะส่ง use_v2=true ให้ bot หรือไม่
 * "legacy" → false (default, ปลอดภัย)
 * "v2"     → true (ใช้ chat_v2 pipeline)
 * "v3"     → false (ใช้ chatbotv3 — ส่ง use_v3 แทน)
 */
export async function shouldUseChatV2(): Promise<boolean> {
  const config = await getSystemConfig();
  return config.chat_engine === 'v2';
}

/**
 * ⚡ shouldUseChatV3 — อ่าน chat_engine จาก SystemConfig
 * ใช้ตัดสินใจว่าจะส่ง use_v3=true ให้ bot หรือไม่
 * "legacy" → false (default, ปลอดภัย)
 * "v2"     → false (ใช้ chat_v2 — ส่ง use_v2 แทน)
 * "v3"     → true (ใช้ chatbotv3 pipeline)
 */
export async function shouldUseChatV3(): Promise<boolean> {
  const config = await getSystemConfig();
  return config.chat_engine === 'v3';
}

/**
 * ⚡ getBotProductLimit — อ่าน llm_context_limit จาก SystemConfig
 * ใช้แทนค่า hardcode 5 หรือ 10 ในทุกหน้าที่เรียก bot
 * (shadow-inbox, test-assignment, live-assignment, test-chat, generate-all-shadow)
 * default 30, range 10-50 — ปรับได้จากหน้า config
 */
export async function getBotProductLimit(): Promise<number> {
  const config = await getSystemConfig();
  return config.llm_context_limit ?? 30;
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
      // 🔒 SSRF defense-in-depth — ตรวจ URL อีกครั้งก่อน fetch
      const safe = isSafeFetchUrl(url);
      if (!safe.ok) {
        results[key].message = `URL rejected: ${safe.reason}`;
        return;
      }
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

// ─── Admin-configurable fields ───────────────────────────
// Fields ที่ admin (ไม่ใช่ superadmin/dev) แก้ได้ — ปลอดภัย ไม่กระทบระบบหลัก
export const ADMIN_CONFIGURABLE_KEYS = [
  'bot_buffer_enabled',
  'bot_buffer_window_ms',
  'bot_buffer_max_messages',
  'bot_buffer_window_media_ms',
  'bot_buffer_max_media_messages',
  // ⚡ Phase 2Q — concurrency limit (admin ปรับได้)
  'bot_concurrency_limit',
  // Workflow engine — admin เปิด/ปิดได้ (order คงที่ — Phase 9)
  'workflow_enabled',
  'workflow_run_timeout_ms',
  // ⚡ G2 — assignment: จ่ายงานให้แอดมินคนเดิมที่เคยตอบ หรือ round-robin
  'assignment_prefer_previous_admin',
  // ⚡ Phase 8 — LLM context limit (จำนวนสินค้าที่ส่งเข้า LLM)
  'llm_context_limit',
] as const;

export type AdminConfigKey = (typeof ADMIN_CONFIGURABLE_KEYS)[number];

export async function getAdminConfig(): Promise<Pick<SystemConfigDoc, AdminConfigKey | 'updated_by' | 'updated_at'>> {
  const config = await getSystemConfig();
  const result: Record<string, unknown> = {};
  for (const key of ADMIN_CONFIGURABLE_KEYS) {
    result[key] = config[key];
  }
  result.updated_by = config.updated_by;
  result.updated_at = config.updated_at;
  return result as Pick<SystemConfigDoc, AdminConfigKey | 'updated_by' | 'updated_at'>;
}

export async function updateAdminConfig(
  updates: Partial<Pick<SystemConfigDoc, AdminConfigKey>>,
  updatedBy = 'admin'
): Promise<Pick<SystemConfigDoc, AdminConfigKey | 'updated_by' | 'updated_at'>> {
  // Whitelist — อนุญาตเฉพาะ admin-configurable keys
  const sanitized: Record<string, unknown> = { updated_by: updatedBy, updated_at: new Date() };
  for (const key of ADMIN_CONFIGURABLE_KEYS) {
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
  return getAdminConfig();
}

export const systemConfigService = {
  getSystemConfig,
  updateSystemConfig,
  setBotWorkerPlatformEnabled,
  setKbSource,
  zaapiKbReady,
  testIntegration,
  getAdminConfig,
  updateAdminConfig,
};
