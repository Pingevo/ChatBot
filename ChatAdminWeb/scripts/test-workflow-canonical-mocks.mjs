// test-workflow-canonical-mocks.mjs — fake Mongo สำหรับ canonical evaluator tests
// Convention เดียวกับ test-workflow-persistence-mocks.mjs — redirect module boundary เท่านั้น
// ไม่มี Mongo/network/env จริง — state.* = observable
import { createFakeMongo } from "./test-botworker-fakemongo.mjs";

export const state = { queryLog: [], onQuery(coll, op) { state.queryLog.push({ coll, op }); } };
export const mongo = createFakeMongo(state);

export const COLLECTIONS = {
  workflows: "workflows",
  workflowVersions: "workflow_versions",
  workflowBindings: "workflow_bindings",
  shops: "shops",
  admins: "admins",
  conversations: "conversations",
  messages: "messages",
  statusConversation: "status_conversation",
  testStatusConversation: "test_status_conversation",
};

export async function getCollection(name) { return mongo.getCollection(name); }
export async function getDb() { throw new Error("fake harness: getDb not available"); }
export async function ensureIndexes() {}

export async function logAdminEvent() {}
