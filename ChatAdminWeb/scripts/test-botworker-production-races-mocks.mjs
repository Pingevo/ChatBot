// Leaf-only mocks for test-botworker-production-races.ts
//
// mock เฉพาะ leaf boundary สามตัว (ตาม hooks file):
//   mongoClient         → in-memory Mongo engine (shared fakemongo)
//   botCallService      → callBot นับจำนวนครั้ง + delay/throw/hang ได้
//   systemConfigService → config mutable per-test (หลีกเลี่ยง 5s cache ของ production)
//
// ⚡ production modules ทั้งหมด (workflowEngine/handoffService/botWorkerService/
//    bufferService + services ลูกโซ่) ทำงานจริงบน fake mongo — ห้ามเพิ่ม service
//    mocks ที่นี่

import {
  createFakeMongo,
  makeCallBotMock,
  makeGetSystemConfigMock,
  shouldUseChatV2,
  shouldUseChatV3,
  getBotProductLimit,
} from "./test-botworker-fakemongo.mjs";

// ── shared mutable test state ────────────────────────────────

export const state = {
  calls: { callBot: 0, botInFlight: 0 },
  // race seams — inject ข้างใน FakeCollection methods
  /** @type {null | ((coll: string, filter: any) => Promise<void> | void)} */
  findOneHook: null,
  /** @type {null | ((coll: string, filter: any, update: any) => Promise<void> | void)} */
  updateOneHook: null,
  /** @type {null | ((coll: string, filter: any) => Promise<void> | void)} */
  findOneAndUpdateHook: null,
  callBotDelayMs: 0,
  /** @type {Error | null} */
  callBotError: null,
  callBotHang: false, // ค้างจน caller abort ผ่าน params.signal
  config: {
    bot_worker_enabled: true,
    bot_concurrency_limit: 50,
    workflow_enabled: false,
    workflow_priority: "workflow_first",
    bot_buffer_enabled: false,
    bot_buffer_window_ms: 60,
    bot_buffer_max_messages: 10,
    workflow_run_timeout_ms: 1800000,
    assignment_prefer_previous_admin: false,
  },
  // unique key enforcement — mirrors REAL DB indexes
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

export function resetState() {
  state.calls = { callBot: 0, botInFlight: 0 };
  state.findOneHook = null;
  state.updateOneHook = null;
  state.findOneAndUpdateHook = null;
  state.callBotDelayMs = 0;
  state.callBotError = null;
  state.callBotHang = false;
  Object.assign(state.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  fm.store.clear();
}

// ── mongoClient mock ─────────────────────────────────────────

export const serverConfig = { mongoDbName: "fake_admin", collections: COLLECTIONS };
export async function getDb() { throw new Error("fake mongo: getDb not supported — use getCollection"); }
export async function ensureIndexes() {}

// ── botCallService mock (shared impl — test-botworker-fakemongo.mjs) ──

export const callBot = makeCallBotMock(state);

// ── systemConfigService mock (shared impl) ───────────────────

export const getSystemConfig = makeGetSystemConfigMock(state);
export const systemConfigService = { getSystemConfig };
export { shouldUseChatV2, shouldUseChatV3, getBotProductLimit };
