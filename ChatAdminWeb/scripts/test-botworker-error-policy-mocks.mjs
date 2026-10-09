// Leaf mocks for test-botworker-error-policy.ts
//
// mock เฉพาะ leaf boundary (ตาม hooks file):
//   mongoClient         → in-memory Mongo engine (shared fakemongo + onQuery counter)
//   systemConfigService → config mutable per-test
//
// ⚡ botCallService ไม่ถูก mock — suite นี้ทดสอบ real callBot + real limiter
//    ผ่าน stubbed fetch (นับ + gate ได้) — production modules ทั้งหมดรันจริง

import {
  createFakeMongo,
  shouldUseChatV2,
  shouldUseChatV3,
  getBotProductLimit,
} from "./test-botworker-fakemongo.mjs";

// ── shared mutable test state ────────────────────────────────

export const state = {
  // fetch stub counters (real callBot → stubbed fetch — provider จริง = 0)
  fetchCalls: 0,
  /** @type {string[]} */ fetchUrls: [],
  fetchInFlight: 0,
  fetchPeak: 0,
  /** @type {null | {status:number, body?:any}} canned response */
  fetchResponse: null,
  /** @type {Error | null} set → fetch rejects (network error simulation) */
  fetchReject: null,
  fetchHang: false,          // hang until caller's AbortSignal fires
  fetchGate: false,          // hold responses until test releases gate
  /** @type {(() => void)[]} */ gateResolvers: [],
  gateReleased: 0,           // quota-based release — survives resolver timing
  /** @type {any[]} parsed request bodies — proves which call path reached fetch */
  fetchBodies: [],
  configError: false,        // true → getSystemConfig failure (production-faithful: fresh fallback doc, no throw)
  /** @type {null | {coll:string, op:string, promise:Promise<void>}} persistence-boundary pause gate */
  queryPause: null,
  queryPauseHits: 0,
  /** @type {{coll:string, op:string, filter:any}[]} */ queryLog: [],
  config: {
    bot_worker_enabled: true,
    bot_concurrency_limit: 50,
    workflow_enabled: false,
    workflow_priority: "workflow_first",
    bot_buffer_enabled: false,
    bot_buffer_window_ms: 60,
    bot_buffer_max_messages: 10,
    bot_buffer_window_media_ms: 60,
    bot_buffer_max_media_messages: 10,
    workflow_run_timeout_ms: 1800000,
    assignment_prefer_previous_admin: false,
    llm_context_limit: 30,
  },
  uniqueKeys: {
    messages: ["message_id"],
    buffer_messages: ["message_id"],
    shadow_replies: ["shadow_reply_id"],
  },
};

const DEFAULT_CONFIG = JSON.parse(JSON.stringify(state.config));

const fm = createFakeMongo(state);
export const fakeColl = fm.fakeColl;
export const getCollection = fm.getCollection;
export const COLLECTIONS = fm.COLLECTIONS;
export const store = fm.store;

state.onQuery = (coll, op, filter) => {
  state.queryLog.push({ coll, op, filter });
  // ⚡ persistence-boundary pause — test ค้าง write ชนิดเดียวกลางทาง (kill-switch
  //   post-response race) — fakemongo await return นี้; ปล่อยด้วย release() จาก pauseQuery
  const p = state.queryPause;
  if (p && p.coll === coll && p.op === op) {
    state.queryPauseHits++;
    return p.promise;
  }
};

export function resetState() {
  state.gateReleased = 0;
  state.fetchCalls = 0;
  state.fetchUrls.length = 0;
  state.fetchInFlight = 0;
  state.fetchPeak = 0;
  state.fetchResponse = null;
  state.fetchReject = null;
  state.fetchHang = false;
  state.fetchGate = false;
  state.gateResolvers.length = 0;
  state.fetchBodies.length = 0;
  state.configError = false;
  lastGoodConfig = null;
  state.queryPause = null;
  state.queryPauseHits = 0;
  state.queryLog.length = 0;
  Object.assign(state.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  fm.store.clear();
}

export function queriesFor(coll) {
  return state.queryLog.filter((q) => q.coll === coll);
}

// ── mongoClient mock ─────────────────────────────────────────

export const serverConfig = { mongoDbName: "fake_admin", collections: COLLECTIONS };
export async function getDb() { throw new Error("fake mongo: getDb not supported — use getCollection"); }
export async function ensureIndexes() {}

// ── systemConfigService mock ─────────────────────────────────

// ⚡ last-known-good — mirror ของ systemConfigService contract:
//   healthy read → snapshot ล่าสุด; read ล้ม → last-known-good เดิม;
//   cold start ไม่เคยสำเร็จ → fail-closed ที่ concurrency=1 (ไม่ใช่ default 50)
let lastGoodConfig = null;

export const getSystemConfig = async () => {
  if (state.configError) {
    return lastGoodConfig ?? { ...state.config, bot_concurrency_limit: 1 };
  }
  lastGoodConfig = { ...state.config };
  return lastGoodConfig;
};
export const systemConfigService = { getSystemConfig };
export { shouldUseChatV2, shouldUseChatV3, getBotProductLimit };
