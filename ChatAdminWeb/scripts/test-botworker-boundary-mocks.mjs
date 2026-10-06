// Leaf mocks for test-botworker-boundary.ts
//
// mock เฉพาะ leaf boundary (ตาม hooks file):
//   mongoClient         → in-memory Mongo engine (shared fakemongo + onQuery counter)
//   botCallService      → callBot บันทึก params + นับจำนวน + delay/throw ได้
//   systemConfigService → config mutable per-test
//   authorize           → requireAuth ผ่านทันที (route tests ไม่ใช้ session จริง)
//   productService      → spy นับ getProductsByIds (Product DB read-only จริง)
//
// ⚡ production modules ทั้งหมดรันจริงบน fake mongo — ห้ามเพิ่ม service mocks ที่นี่

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
  /** @type {any[]} params ที่ callBot ถูกเรียกด้วย — pin history/images contract */
  callBotParams: [],
  /** @type {{coll:string, op:string, filter:any}[]} query counter สำหรับ perf tests */
  queryLog: [],
  queryDelayMs: 0, // artificial read latency (find/toArray/findOne/countDocuments)
  /** @type {number[]} getProductsByIds call timestamps/args — spy */
  productCalls: [],
  findOneHook: null,
  updateOneHook: null,
  findOneAndUpdateHook: null,
  callBotDelayMs: 0,
  /** @type {Error | null} */
  callBotError: null,
  callBotHang: false,
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
};

export function resetState() {
  state.calls = { callBot: 0, botInFlight: 0 };
  state.callBotParams.length = 0;
  state.queryLog.length = 0;
  state.queryDelayMs = 0;
  state.productCalls.length = 0;
  state.findOneHook = null;
  state.updateOneHook = null;
  state.findOneAndUpdateHook = null;
  state.callBotDelayMs = 0;
  state.callBotError = null;
  state.callBotHang = false;
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

// ── botCallService mock — shared impl + params capture ───────

export const callBot = makeCallBotMock(state);

// ── systemConfigService mock ─────────────────────────────────

export const getSystemConfig = makeGetSystemConfigMock(state);
export const systemConfigService = { getSystemConfig };
export { shouldUseChatV2, shouldUseChatV3, getBotProductLimit };

// ── authorize mock — route tests ผ่าน auth ตลอด ──────────────

export async function requireAuth() {
  return {
    ok: true,
    ctx: {
      admin: { admin_id: "t_admin", role: "admin", active: true },
      safeAdmin: { admin_id: "t_admin", role: "admin" },
    },
  };
}

// ── productService mock — spy นับ Product DB reads ───────────

export const productService = {
  async getProductsByIds(opts) {
    state.productCalls.push(opts.itemIds?.length ?? 0);
    return [];
  },
  async listProducts() { return []; },
  async getProduct() { return null; },
  async listShopsByPlatform() { return []; },
};
