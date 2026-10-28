// test-workflow-persistence-mocks.mjs — fake Mongo + audit capture for workflow persistence tests
// Convention เดียวกับ test-botworker-*-mocks.mjs — redirect module boundary เดิมเท่านั้น
//   - mongoClient → fake in-memory collections + COLLECTIONS map
//   - adminLogService → captured events (assert credential absence)
// ไม่มี Mongo/network/env จริง

import { createFakeMongo } from "./test-botworker-fakemongo.mjs";

export const state = {
  uniqueKeys: {
    workflows: ["workflow_id"],
    // production-declared unique: version_id + compound (workflow_id, version_seq)
    workflow_versions: ["version_id", "workflow_id+version_seq"],
    workflow_import_batches: ["batch_id"],
    workflow_raw_snapshots: ["snapshot_id"],
    workflow_bindings: ["binding_id"],
  },
  adminEvents: [],
  queryLog: [],
  onQuery(coll, op) { state.queryLog.push({ coll, op }); },
  // failure-injection seams (fake-mongo hooks — consumed lazily by createFakeMongo)
  insertOneHook: undefined,
  updateOneHook: undefined,
  findOneHook: undefined,
};

export const mongo = createFakeMongo(state);

export const COLLECTIONS = {
  workflows: "workflows",
  workflowVersions: "workflow_versions",
  workflowImportBatches: "workflow_import_batches",
  workflowRawSnapshots: "workflow_raw_snapshots",
  workflowBindings: "workflow_bindings",
  // binding-resolution local-target identities (validation reads only)
  shops: "shops",
  admins: "admins",
  conversations: "conversations",
};

export async function getCollection(name) { return mongo.getCollection(name); }
export async function getDb() { throw new Error("fake harness: getDb not available"); }
export async function ensureIndexes() {}

// adminLogService mock — capture audit events (credential-absence assertions)
export async function logAdminEvent(evt) { state.adminEvents.push(evt); }
