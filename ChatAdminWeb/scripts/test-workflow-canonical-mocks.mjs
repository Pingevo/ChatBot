// test-workflow-canonical-mocks.mjs — fake Mongo สำหรับ canonical evaluator tests
// Convention เดียวกับ test-workflow-persistence-mocks.mjs — redirect module boundary เท่านั้น
// ไม่มี Mongo/network/env จริง — state.* = observable
import { createFakeMongo } from "./test-botworker-fakemongo.mjs";

export const state = { queryLog: [], onQuery(coll, op) { state.queryLog.push({ coll, op }); } };
export const mongo = createFakeMongo(state);

export const COLLECTIONS = {
  workflows: "workflows",
  workflowVersions: "workflow_versions",
  workflowRuns: "workflow_runs",
  workflowBindings: "workflow_bindings",
  shops: "shops",
  admins: "admins",
  conversations: "conversations",
  messages: "messages",
  statusConversation: "status_conversation",
  testStatusConversation: "test_status_conversation",
  systemConfigs: "system_configs",
  triggers: "triggers",
  assignmentCursors: "assignment_cursors",
};

export async function getCollection(name) { return mongo.getCollection(name); }
export async function getDb() { throw new Error("fake harness: getDb not available"); }
export async function ensureIndexes() {}

export async function logAdminEvent() {}

// lib/config mock — env strict ห้ามยิงตอน import; key names mirror จริง
export const serverConfig = {
  mongoUri: "mongodb://fake",
  mongoDbName: "chatbot_admin_test",
  collections: {
    admins: "admins", authTokens: "auth_tokens", sessions: "sessions",
    knowledgeBase: "knowledge_base", guardrails: "guardrails", tickets: "tickets",
    adminLogs: "admin_logs", conversations: "conversations", messages: "messages",
    shops: "shops", customers: "customers", triggers: "triggers",
    pushEvents: "pushevents", requestLogs: "requestlogs",
    systemConfigs: "system_configs", assignmentConfigs: "assignment_configs",
    assignmentCursors: "assignment_cursors",
    workflows: "workflows", workflowRuns: "workflow_runs",
    workflowVersions: "workflow_versions", workflowBindings: "workflow_bindings",
    workflowImportBatches: "workflow_import_batches",
    workflowRawSnapshots: "workflow_raw_snapshots",
    statusConversation: "status_conversation",
    testStatusConversation: "test_status_conversation",
    closeHistory: "close_history", reopenHistory: "reopen_history",
    shadowReplies: "shadow_replies", botCalls: "bot_calls",
    handoffs: "handoffs", botworkerEvents: "botworker_events",
    testConversations: "test_conversations", customers_analytics: "customers_analytics",
  },
};
export const MAX_FAILED_LOGIN = 5;
export const LOCK_MINUTES = 15;
