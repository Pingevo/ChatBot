// Leaf mocks for test-ownership-transport.ts
//
// mock เฉพาะ leaf boundary:
//   mongoClient         → in-memory Mongo engine (shared fakemongo + hooks)
//   systemConfigService → config mutable per-test
//
// ทุกอย่างอื่น production code จริง: statusConversationService /
// conversationService / assignmentService / handoffService / botCallService /
// workflowEngine / auth+jwt / admin API route handlers
//
// ⚡ COLLECTIONS ต้อง mirror key names ของ lib/config.ts เป๊ะ — service อ่าน
//    COLLECTIONS.<key> แล้วส่งชื่อเข้า getCollection; ถ้า key หาย → coll name
//    undefined → เทสท์ผ่านบน phantom collection (เจอจริงใน fakemongo key เดิม
//    `statusConversations` ที่ไม่ตรง `statusConversation`)

import { createFakeMongo } from "./test-botworker-fakemongo.mjs";

// ── shared mutable test state ────────────────────────────────

export const state = {
  // fetch stub counters (real callBot → stubbed fetch — provider จริง = 0)
  fetchCalls: 0,
  /** @type {any[]} parsed request bodies — proves ticket_state ที่ส่งจริง */
  fetchBodies: [],
  fetchResponse: null,
  configError: false,
  /** @type {{coll:string, op:string, filter:any}[]} */
  queryLog: [],
  /** @type {null | ((coll:string, filter:any)=>any)} read-error seam (findOne) */
  findOneHook: null,
  // ── inbound-lifecycle service spy counters (route leaf seam — ไม่ใช่ impl จริง)
  inboundTransitionCalls: 0,
  /** @type {any[]} */
  inboundTransitionArgs: [],
  inboundTransitionResult: "unchanged",
  /** @type {Error | null} */
  inboundTransitionError: null,
  config: {
    bot_worker_enabled: true,
    bot_concurrency_limit: 50,
    workflow_enabled: false,
    workflow_priority: "workflow_first",
    bot_buffer_enabled: false,
    assignment_prefer_previous_admin: false,
    llm_context_limit: 30,
  },
  uniqueKeys: {
    messages: ["message_id"],
    conversations: ["conversation_id"],
    status_conversation: ["conversation_id"],
    sessions: ["token_hash"],
  },
};

const DEFAULT_CONFIG = JSON.parse(JSON.stringify(state.config));

const fm = createFakeMongo(state);
export const fakeColl = fm.fakeColl;
export const store = fm.store;
export const getCollection = fm.getCollection;

state.onQuery = (coll, op, filter) => {
  state.queryLog.push({ coll, op, filter });
};

export function resetState() {
  state.fetchCalls = 0;
  state.fetchBodies.length = 0;
  state.fetchResponse = null;
  state.configError = false;
  state.findOneHook = null;
  state.inboundTransitionCalls = 0;
  state.inboundTransitionArgs.length = 0;
  state.inboundTransitionResult = "unchanged";
  state.inboundTransitionError = null;
  state.queryLog.length = 0;
  lastGoodConfig = null;
  Object.assign(state.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  fm.store.clear();
}

// ── mongoClient mock ─────────────────────────────────────────
// key set mirror lib/config.ts collections — ค่าเป็นชื่อ collection จริง
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

export const serverConfig = { mongoDbName: "fake_admin", collections: COLLECTIONS };
export async function getDb() { throw new Error("fake mongo: getDb not supported — use getCollection"); }
export async function ensureIndexes() {}

// ── systemConfigService mock ─────────────────────────────────
// mirror last-known-good contract: healthy → snapshot; fail → fail-closed switches
let lastGoodConfig = null;

export const getSystemConfig = async () => {
  if (state.configError) {
    return {
      ...(lastGoodConfig ?? state.config),
      mock_mode_enabled: false,
      shadow_bot_enabled: false,
      bot_worker_enabled: false,
      bot_buffer_enabled: false,
      workflow_enabled: false,
      grouped_retrieval_shadow_enabled: false,
      grouped_retrieval_selection_enabled: false,
      bot_concurrency_limit: lastGoodConfig?.bot_concurrency_limit ?? 1,
    };
  }
  lastGoodConfig = { ...state.config };
  return lastGoodConfig;
};

export const shouldUseChatV2 = async () => false;
export const shouldUseChatV3 = async () => false;
export const getBotProductLimit = async () => 10;
