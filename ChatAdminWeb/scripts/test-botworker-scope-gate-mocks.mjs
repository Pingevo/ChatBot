// Leaf mocks for test-botworker-scope-gate.ts
//
// mock เฉพาะ leaf boundary:
//   mongoClient         → in-memory Mongo engine (shared fakemongo + hooks)
//   botCallService      → callBot บันทึก params + นับจำนวน (provider จริง = 0)
//   systemConfigService → config mutable per-test (+ updateSystemConfig เขียน fake coll)
//   authorize           → requireAuth/requirePageEdit/requireSuperadmin ตาม state.authOk
//
// ทุกอย่างอื่น production code จริง: botWorkerService / bufferService /
// workflowEngine / shopService / adminLogService / route handlers

import {
  createFakeMongo,
  makeCallBotMock,
  makeGetSystemConfigMock,
  shouldUseChatV2,
  shouldUseChatV3,
  getBotProductLimit,
} from "./test-botworker-fakemongo.mjs";
// ⚡ production CAS owner จริง — wrapper ด้านล่าง delegate เข้าฟังก์ชันนี้
//   (hooks: parentURL===MOCK_URL → resolve จริง; ภายในจริงเรียก fake getCollection)
import { setBotWorkerPlatformEnabled as realSetBotWorkerPlatformEnabled } from "../src/backend/service/systemConfigService";

// ── shared mutable test state ────────────────────────────────

export const state = {
  calls: { callBot: 0, botInFlight: 0 },
  /** @type {any[]} params ที่ callBot ถูกเรียกด้วย */
  callBotParams: [],
  /** @type {{coll:string, op:string, filter:any}[]} query counter สำหรับ structure pins */
  queryLog: [],
  queryDelayMs: 0,
  /** @type {null | ((coll:string, filter:any)=>any)} findOne race seam (fake mongo) */
  findOneHook: null,
  /** @type {null | ((coll:string, filter:any, update:any)=>any)} updateOne race seam */
  updateOneHook: null,
  /** @type {null | ((coll:string, filter:any)=>any)} findOneAndUpdate race seam */
  findOneAndUpdateHook: null,
  callBotDelayMs: 0,
  /** @type {Error | null} */
  callBotError: null,
  callBotHang: false,
  /** auth seam — false → ทุก require* คืน 401/403 (route run real handlers) */
  authOk: true,
  config: {
    bot_worker_enabled: true,
    bot_worker_platforms: { shopee: true, tiktok: false, lazada: false },
    // ⚡ per-platform enable timestamp — epoch default (admit-anything cutoff)
    //   JSON round-trip ใน reset ทำ Date หาย → re-stamp ใน resetState
    bot_worker_platform_enabled_at: /** @type {Record<string, Date | null>} */ ({ shopee: new Date(0) }),
    bot_concurrency_limit: 50,
    workflow_enabled: false,
    workflow_priority: "workflow_first",
    bot_buffer_enabled: false,
    bot_buffer_window_ms: 60,
    bot_buffer_max_messages: 10,
    bot_buffer_window_media_ms: 120,
    bot_buffer_max_media_messages: 20,
    workflow_run_timeout_ms: 1800000,
    assignment_prefer_previous_admin: false,
  },
  uniqueKeys: {
    messages: ["message_id"],
    buffer_messages: ["message_id"],
    shadow_replies: ["shadow_reply_id"],
    conversations: ["conversation_id"],
    status_conversation: ["conversation_id"],
    workflow_runs: ["run_id"],
    // ⚡ system_configs.config_key unique — production platform-CAS upsert-miss
    //   ต้องชน E11000 ตาม Mongo จริง (tests pin 409 ไม่ใช่ 500)
    system_configs: ["config_key"],
  },
};

const DEFAULT_CONFIG = JSON.parse(JSON.stringify(state.config));

const fm = createFakeMongo(state);
export const fakeColl = fm.fakeColl;
export const getCollection = fm.getCollection;
export const store = fm.store;

state.onQuery = (coll, op, filter) => {
  state.queryLog.push({ coll, op, filter });
};

// ⚡ mongoClient mock COLLECTIONS ต้อง mirror lib/config.ts — รวม shops
//   (fakemongo สร้าง collection ตามชื่อเสมอ — key ต้องตรงเท่านั้น)
export const COLLECTIONS = {
  admins: "admins",
  authTokens: "auth_tokens",
  sessions: "sessions",
  knowledgeBase: "knowledge_base",
  guardrails: "guardrails",
  tickets: "tickets",
  adminLogs: "admin_logs",
  conversations: "conversations",
  messages: "messages",
  shops: "shops",
  customers: "customers",
  triggers: "triggers",
  pushEvents: "pushevents",
  requestLogs: "requestlogs",
  systemConfigs: "system_configs",
  assignmentConfigs: "assignment_configs",
  assignmentCursors: "assignment_cursors",
  shopTeamAssignments: "shop_team_assignments",
  platformTeamAssignments: "platform_team_assignments",
  shadowReplies: "shadow_replies",
  quickReplies: "quick_replies",
  closeHistory: "close_history",
  chatAcceptSessions: "chat_accept_sessions",
  chatProcessing: "chat_processing",
  shopPersonas: "shop_personas",
  shopSettings: "shop_settings",
  testChatRatings: "test_chat_ratings",
  testAssignment: "test_assignment",
  bufferMessages: "buffer_messages",
  testChatUploads: "test_chat_uploads",
  workflows: "workflows",
  workflowRuns: "workflow_runs",
  statusConversation: "status_conversation",
  testStatusConversation: "test_status_conversation",
  testChatSessions: "test_chat_sessions",
  chatAnnotations: "chat_annotations",
  botworkerMessages: "botworker_messages",
  botworkerEvents: "botworker_events",
  botworkerState: "botworker_state",
};

export function resetState() {
  state.calls = { callBot: 0, botInFlight: 0 };
  state.callBotParams.length = 0;
  state.queryLog.length = 0;
  state.queryDelayMs = 0;
  state.findOneHook = null;
  state.updateOneHook = null;
  state.findOneAndUpdateHook = null;
  state.callBotDelayMs = 0;
  state.callBotError = null;
  state.callBotHang = false;
  state.authOk = true;
  Object.assign(state.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  // Date objects die in the JSON round-trip above — re-stamp them
  state.config.bot_worker_platform_enabled_at = { shopee: new Date(0) };
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
export { shouldUseChatV2, shouldUseChatV3, getBotProductLimit };
export const systemConfigService = {
  getSystemConfig,
  updateSystemConfig,
  setBotWorkerPlatformEnabled,
  shouldUseChatV2,
  shouldUseChatV3,
  getBotProductLimit,
};

// ⚡ updateSystemConfig — whitelist เดียวกับ service จริง + persist ลง fake coll
//   (test ต้องพิสูจน์ bot_worker_platforms ผ่าน route → service → store)
const ALLOWED = new Set([
  "mock_mode_enabled", "shadow_bot_enabled", "polling_interval_ms",
  "bot_worker_enabled", "bot_worker_interval_ms",
  "bot_buffer_enabled", "bot_buffer_window_ms", "bot_buffer_max_messages",
  "bot_buffer_window_media_ms", "bot_buffer_max_media_messages",
  "workflow_enabled", "workflow_priority", "workflow_run_timeout_ms",
  "shopee_bot_url", "tiktok_bot_url", "lazada_bot_url",
  "chat_engine", "llm_context_limit",
  "grouped_retrieval_shadow_enabled", "grouped_retrieval_selection_enabled",
]);

export async function updateSystemConfig(updates = {}, updatedBy = "admin") {
  const sanitized = { updated_by: updatedBy, updated_at: new Date() };
  for (const k of Object.keys(updates)) {
    if (ALLOWED.has(k) && updates[k] !== undefined) sanitized[k] = updates[k];
  }
  const coll = await getCollection("system_configs");
  await coll.updateOne(
    { config_key: "main_config" },
    { $set: sanitized },
    { upsert: true }
  );
  Object.assign(state.config, sanitized);
  return { config_key: "main_config", ...state.config };
}

// ⚡ delegate เข้า production setBotWorkerPlatformEnabled จริง — mock นี้เป็น
//   leaf-boundary เท่านั้น (mongoClient); CAS filter/upsert/E11000 ต้องทำงาน
//   ตาม production ไม่ใช่ reimplement เอง
//   bridge: state.config = read-cache ของ admin → materialize platform maps
//   เข้า fake coll ก่อนเรียก real CAS (persisted truth = coll doc);
//   เขียนสำเร็จ (applied) → sync persisted doc กลับเข้า read-cache
export async function setBotWorkerPlatformEnabled(platform, enabled, expected, updatedBy = "admin") {
  const coll = await getCollection("system_configs");
  await coll.updateOne(
    { config_key: "main_config" },
    { $set: {
      bot_worker_platforms: { ...(state.config.bot_worker_platforms || {}) },
      bot_worker_platform_enabled_at: { ...(state.config.bot_worker_platform_enabled_at || {}) },
    } },
    { upsert: true }
  );
  const res = await realSetBotWorkerPlatformEnabled(platform, enabled, expected, updatedBy);
  if (res.applied) {
    const doc = await coll.findOne({ config_key: "main_config" });
    state.config.bot_worker_platforms = { shopee: false, tiktok: false, lazada: false, ...(doc?.bot_worker_platforms || {}) };
    state.config.bot_worker_platform_enabled_at = { ...(doc?.bot_worker_platform_enabled_at || {}) };
  }
  return res;
}

// ── authorize mock — authOk flag seam ────────────────────────

const FORBIDDEN = { status: 403, json: async () => ({ error: "forbidden" }) };

function ctx() {
  return {
    ok: true,
    ctx: {
      admin: { admin_id: "t_admin", role: "superadmin", active: true, username: "t_admin" },
      safeAdmin: { admin_id: "t_admin", role: "superadmin" },
      ip: "127.0.0.1",
    },
  };
}

export async function requireAuth() {
  return state.authOk ? ctx() : { ok: false, response: FORBIDDEN };
}
export async function requirePageEdit() {
  return state.authOk ? ctx() : { ok: false, response: FORBIDDEN };
}
export async function requireSuperadmin() {
  return state.authOk ? ctx() : { ok: false, response: FORBIDDEN };
}
