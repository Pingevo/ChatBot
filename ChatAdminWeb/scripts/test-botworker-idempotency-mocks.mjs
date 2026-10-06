// Shared mocks for test-botworker-idempotency.ts
// Mock อยู่ที่ module boundary เดิม — production ไม่เปลี่ยน
//
// จุดที่จงใจจำลองจริง:
//   - fake Mongo collection: findOne/find/insertOne/updateOne/deleteMany/
//     findOneAndUpdate(upsert)/distinct — matcher รองรับ $gt/$in/$ne/$exists/$or
//   - unique-key enforcement ต่อ collection เปิด/ปิดได้จาก test (จำลอง index
//     จริงของ DB — เช่น buffer_messages.message_id มีจริง, chat_processing ไม่มี)
//   - callBot นับจำนวนครั้ง + delay/throw ได้ → duplicate processing มองเห็นเป็น
//     bot-call count และ shadow_replies count
//
// ไม่มี Mongo/LLM/network จริง

// ── shared mutable test state ────────────────────────────────

// ── botworkerRuntime boundary (claim coordinator timing/worker identity) ──
// impl round: ไฟล์จริง src/backend/service/botworkerRuntime.ts export constants
// เดียวกัน — test redirect module นี้มาที่นี่ → ไม่ต้อง processMessage opts เพื่อ test
export const botworkerRuntime = {
  claimLeaseMs: 150000,      // production constant default (> timeout + finalize headroom)
  heartbeatMs: 50000,        // lease/3
  botCallTimeoutMs: 90000,   // = liveAssignmentService timeout (90s) — ห้ามต่ำกว่า valid latency
  flushErrorRetryMs: 5000,   // flush error → retry delay (claim owner เดิม re-fence ได้ทันที)
  ownerId: "test-worker",
  maxClaimAttempts: 3,
};

// ── canonical identities (implementation เดียวกับ botworkerRuntime.ts) ──
import { createHash } from "node:crypto";
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
export const claimIdFor = (mid) => `botworker:claim:${mid}`;
export function batchIdFor(platform, shopId, conv, messageIds) {
  const canon = JSON.stringify([platform, shopId, conv, ...[...messageIds].sort()]);
  return "botworker:batch:" + sha256hex(canon).slice(0, 32);
}
export function convLockIdFor(platform, shopId, conv) {
  return "botworker:convlock:" + sha256hex(JSON.stringify([platform, shopId, conv])).slice(0, 32);
}
export const replyIdFor = (batchId) => `botworker:reply:${batchId}`;
export const wfReplyId = (batchId, i) => `botworker:reply:${batchId}:wf${i}`;
export const opIdFor = (claimId, kind) => `botworker:op:${claimId}:${kind}`;

export const state = {
  calls: {
    callBot: 0, botInFlight: 0, shadowReply: 0, handoffTest: 0, reopenTest: 0,
    matchAndRun: 0, resumeFlow: 0,
    // Part 1B — executions จริงของ side-effect owners (แยกจาก call count)
    handoffExec: 0, workflowExec: 0, resumeExec: 0,
  },
  events: [],
  // ⚡ hook seam — เรียกภายใน FakeCollection.findOne (จำลอง race ระหว่าง read→write)
  /** @type {null | ((coll: string, filter: any) => Promise<void> | void)} */
  findOneHook: null,
  /** @type {null | ((coll: string, filter: any, update: any) => Promise<void> | void)} */
  updateOneHook: null,
  /** @type {null | ((coll: string, filter: any, update: any) => Promise<unknown> | unknown)} */
  findOneAndUpdateHook: null,
  /** @type {null | ((coll: string, filter: any, update: any) => Promise<"skip" | void> | "skip" | void)} */
  updateManyHook: null,
  /** @type {null | ((coll: string, op: string, filter: any) => void)} */
  onQuery: null,
  queryDelayMs: 0,
  /** @type {null | ((coll: string, filter: any) => Promise<void> | void)} */
  deleteOneHook: null,
  /** @type {Record<string, unknown> | null} */
  activeRun: null,             // set → workflowEngine.getActiveRun returns it
  /** @type {Record<string, unknown> | null} */
  resumeResult: null,          // set → workflowEngine.resumeFlow returns it
  /** @type {Error | null} */
  conversationError: null,     // set → getConversation throws (flush error path)
  /** @type {Error | null} */
  triggerError: null,          // set → matchTrigger throws
  config: {
    bot_worker_enabled: true,
    bot_worker_interval_ms: 10,
    bot_concurrency_limit: 50,
    workflow_enabled: false,
    workflow_priority: "workflow_first",
    bot_buffer_enabled: false,
    bot_buffer_window_ms: 80,
    bot_buffer_max_messages: 10,
    bot_buffer_window_media_ms: 160,
    bot_buffer_max_media_messages: 20,
    // ⚠️ ไม่มี bot_claim_lease_ms ใน SystemConfig — lease เป็น internal constant
    //    ของ service; test ฉีด lease ผ่าน explicit dependency (opts.claimLeaseMs)
  },
  callBotDelayMs: 0,
  /** @type {Error | null} */
  callBotError: null,          // set → callBot throws
  callBotHang: false,          // set → callBot never resolves unless aborted via params.signal
  /** @type {Record<string, unknown> | null} */
  trigger: null,               // set → matchTrigger returns it
  /** @type {Record<string, unknown> | null} */
  testStatus: null,            // set → getTestStatus returns it
  /** @type {Record<string, unknown> | null} */
  workflowResult: null,        // set → matchAndRun returns it (workflow_enabled)
  /** @type {{ assignedTo: string | null, assignedToName?: string | null, reopened?: boolean, assignmentReason: string }} */
  handoffResult: { assignedTo: null, assignmentReason: "test_none" },
  // unique key enforcement per collection name (mirrors REAL DB indexes)
  uniqueKeys: {
    messages: ["message_id"],
    buffer_messages: ["message_id"],
    shadow_replies: ["shadow_reply_id"],
    // chat_processing ไม่มี unique index ใน DB จริง (audit พิสูจน์) —
    // test เปิดเฉพาะเมื่อต้องการจำลอง index เป้าหมาย
  },
};

export function resetState() {
  state.calls = { callBot: 0, botInFlight: 0, shadowReply: 0, handoffTest: 0, reopenTest: 0, matchAndRun: 0, resumeFlow: 0, handoffExec: 0, workflowExec: 0, resumeExec: 0 };
  state.events = [];
  state.findHook = null;
  state.findOneHook = null;
  state.updateOneHook = null;
  state.findOneAndUpdateHook = null;
  state.updateManyHook = null;
  state.deleteOneHook = null;
  state.onQuery = null;
  state.queryDelayMs = 0;
  state.activeRun = null;
  state.resumeResult = null;
  state.conversationError = null;
  state.triggerError = null;
  state.callBotDelayMs = 0;
  state.callBotError = null;
  state.callBotHang = false;
  botworkerRuntime.claimLeaseMs = 150000;
  botworkerRuntime.heartbeatMs = 50000;
  botworkerRuntime.botCallTimeoutMs = 90000;
  botworkerRuntime.flushErrorRetryMs = 5000;
  botworkerRuntime.ownerId = "test-worker";
  botworkerRuntime.maxClaimAttempts = 3;
  state.trigger = null;
  state.testStatus = null;
  state.workflowResult = null;
  state.handoffResult = { assignedTo: null, assignmentReason: "test_none" };
  store.clear();
}

// ── fake Mongo (shared engine — test-botworker-fakemongo.mjs) ─
// matcher/update/sort/projection semantics อยู่ใน shared module เดียว
// (harness เดิม + production-race harness ใช้ engine เดียวกัน คนละ store)

import {
  createFakeMongo,
  makeCallBotMock,
  makeGetSystemConfigMock,
  shouldUseChatV2,
  shouldUseChatV3,
  getBotProductLimit,
} from "./test-botworker-fakemongo.mjs";

// onInsert → นับ reply insert จริงของ production path (shadow_replies)
state.onInsert = (name) => { if (name === "shadow_replies") state.calls.shadowReply++; };

const fm = createFakeMongo(state);
const store = fm.store; // collection name → docs[]
export const fakeColl = fm.fakeColl;
export const FakeCollection = fm.FakeCollection;
export const getCollection = fm.getCollection;

// ── mongoClient mock ─────────────────────────────────────────

export const COLLECTIONS = {
  messages: "messages",
  conversations: "conversations",
  chatProcessing: "chat_processing",
  shadowReplies: "shadow_replies",
  bufferMessages: "buffer_messages",
  testStatusConversation: "test_status_conversation",
  statusConversation: "status_conversation",
  botworkerMessages: "botworker_messages",
  botworkerEvents: "botworker_events",
  workflowRuns: "workflow_runs",
  workflows: "workflows",
  admins: "admins",
  adminLogs: "admin_logs",
  testChatSessions: "test_chat_sessions",
};

export const serverConfig = { mongoDbName: "fake_admin", collections: COLLECTIONS };

// ── service mocks ────────────────────────────────────────────

export const getSystemConfig = makeGetSystemConfigMock(state);
export { shouldUseChatV2, shouldUseChatV3, getBotProductLimit };

export const triggerService = {
  matchTrigger: async () => {
    if (state.triggerError) throw state.triggerError;
    return state.trigger;
  },
};

export const assignmentService = {
  getActiveAssignmentConfig: async () => "equal_global",
};

export const testStatusConversationService = {
  // test_status store — assignment เป็น side effect จริงของ handoff owner
  getTestStatus: async (conversationId, source) => {
    const doc = await new FakeCollection("test_status_conversation").findOne({ conversation_id: conversationId, source });
    return doc || state.testStatus; // fallback seed ของ test ที่ไม่ผ่าน store
  },
  reopenTestConversation: async (conversationId, source, _a, targetStatus) => {
    state.calls.reopenTest++;
    await new FakeCollection("test_status_conversation").updateOne(
      { conversation_id: conversationId, source },
      { $set: { status: targetStatus || "bot", assigned_to: null, updated_at: new Date() } },
      { upsert: true }
    );
  },
  updateTestStatus: async (conversationId, source, status, assignedTo, reason) => {
    await new FakeCollection("test_status_conversation").updateOne(
      { conversation_id: conversationId, source },
      { $set: { status, assigned_to: assignedTo, assignment_reason: reason, updated_at: new Date() } },
      { upsert: true }
    );
  },
  setTestPendingAssignment: async (conversationId, source, pending, reason) => {
    await new FakeCollection("test_status_conversation").updateOne(
      { conversation_id: conversationId, source },
      { $set: { pending_assignment: pending, pending_reason: reason, updated_at: new Date() } },
      { upsert: true }
    );
  },
};

// ⚡ handoff owner — mirror ของ production contract:
//   op doc (botworker_events._id=opKey) = operation record
//   test_status_conversation[conv+source] = assignment side-effect
//   E11000+result → dedupe · pending → เช็ก assignment จริงก่อน (crash หลัง
//   assignment commit ก่อน result → reconstruct ไม่ exec ซ้ำ) · ไม่มี → exec ครั้งเดียว
export const handoffService = {
  /** @param {{ conversationId?: string, source?: string, operationKey?: string, assignedStatus?: string }} [opts] */
  handoffToAdminTest: async (opts = {}) => {
    state.calls.handoffTest++;
    const opKey = opts.operationKey;
    if (!opKey) {
      state.calls.handoffExec++;
      const r = { ...state.handoffResult };
      await testStatusConversationService.updateTestStatus(opts.conversationId, opts.source, opts.assignedStatus || "handoff", r.assignedTo, r.assignmentReason);
      return r;
    }
    const opColl = new FakeCollection("botworker_events");
    let isFirst = true;
    try {
      await opColl.insertOne({ _id: opKey, status: "pending", created_at: new Date() });
    } catch (e) {
      if (e.code === 11000) isFirst = false;
      else throw e;
    }
    if (!isFirst) {
      const prior = await opColl.findOne({ _id: opKey });
      if (prior?.result) return prior.result; // done — คืนผลเดิม
      // pending ค้าง — ห้าม exec ซ้ำแบบไม่รู้สถานะ: เช็ก assignment store จริงก่อน
      const meta = await testStatusConversationService.getTestStatus(opts.conversationId, opts.source);
      if (meta?.assigned_to) {
        const recovered = {
          assignedTo: meta.assigned_to, assignedToName: meta.assigned_to,
          reopened: false, assignmentReason: "recovered_pending_op",
        };
        await opColl.updateOne({ _id: opKey }, { $set: { status: "done", result: recovered, updated_at: new Date() } });
        return recovered; // assignment commit แล้ว — reconstruct result ไม่ exec ซ้ำ
      }
      // assignment ยังไม่ commit → exec ปลอดภัย (first exec ที่แท้)
    }
    state.calls.handoffExec++;
    const result = { ...state.handoffResult };
    await testStatusConversationService.updateTestStatus(
      opts.conversationId, opts.source, opts.assignedStatus || "handoff", result.assignedTo, result.assignmentReason
    );
    await opColl.updateOne({ _id: opKey }, { $set: { status: "done", result, updated_at: new Date() } });
    return result;
  },
};

export async function listMessages() { return []; }
export async function getGroupedHistoryForBot() { return []; }
export function toBotText(msg) { return msg.text; }
export function toBotImages() { return []; }

export async function getConversation(conversationId) {
  if (state.conversationError) throw state.conversationError;
  return { conversation_id: conversationId, shop_name: "MockShop", customer_id: "cust_1" };
}

// callBot — shared impl (test-botworker-fakemongo.mjs); state contract เดียวกัน
export const callBot = makeCallBotMock(state);

// ⚡ workflowEngine mock — mirror production run-doc semantics (ไม่ใช่ opResults map):
//   run identity = deterministic run_id จาก operation_key+workflow_id → E11000 = run เดียว
//   running run มี owner_id/fencing_token/lease_expires_at — สอง worker run พร้อมกันไม่ได้
//   completed run เก็บ result snapshot → crash retry คืนผลเดิม
//   resume dedupe ด้วย resume_results[operation_key] บน run doc
const wfRunIdFor = (opKey, wfId) => "wfr_" + sha256hex(`${opKey}:${wfId}`).slice(0, 20);

async function wfPriorRun(coll, runId) {
  const prior = await coll.findOne({ run_id: runId });
  if (!prior) return { kind: "none" };
  if (prior.result) return { kind: "done", prior };
  // running/waiting — fencing: active other-owner → in-flight; else reclaim & continue
  const active = (prior.lease_expires_at?.getTime?.() || 0) > Date.now();
  if (active && prior.owner_id !== botworkerRuntime.ownerId) {
    return { kind: "inflight", prior };
  }
  const rec = await coll.findOneAndUpdate(
    {
      run_id: runId,
      status: { $in: ["running", "waiting_for_reply"] },
      $or: [{ owner_id: botworkerRuntime.ownerId }, { lease_expires_at: { $lt: new Date() } }],
    },
    {
      $set: { owner_id: botworkerRuntime.ownerId, lease_expires_at: new Date(Date.now() + botworkerRuntime.claimLeaseMs), updated_at: new Date() },
      $inc: { fencing_token: 1 },
    },
    { returnDocument: "after" }
  );
  return rec ? { kind: "reclaimed", prior: rec } : { kind: "inflight", prior };
}

export const workflowEngine = {
  // getActiveRun อ่านจาก run docs จริง — เหมือน production (status running/waiting)
  getActiveRun: async (conversationId) => {
    return new FakeCollection("workflow_runs").findOne({
      conversation_id: conversationId,
      status: { $in: ["running", "waiting_for_reply"] },
    });
  },
  /** @param {{ operation_key?: string, conversation_id?: string, shop_id?: string, platform?: string }} [msg] */
  matchAndRun: async (msg = {}) => {
    state.calls.matchAndRun++;
    if (!state.workflowResult) return { status: "no_match", detail: "mock no match", delivered: [] };
    const wfId = state.workflowResult.workflow_id || "wf_test";
    const coll = new FakeCollection("workflow_runs");
    const runId = msg.operation_key ? wfRunIdFor(msg.operation_key, wfId) : `wfr_mock_${(++oidCounter)}`;

    if (msg.operation_key) {
      const p = await wfPriorRun(coll, runId);
      if (p.kind === "done") return { ...p.prior.result, run_id: p.prior.run_id, workflow_id: wfId };
      if (p.kind === "inflight") {
        return { status: "actioned", detail: "run in-flight (other owner)", delivered: [], run_id: p.prior.run_id, workflow_id: wfId };
      }
      // none → create run (E11000 = concurrent same-op → prior logic); reclaimed → continue
      if (p.kind === "none") {
        try {
          await coll.insertOne({
            _id: runId, run_id: runId, workflow_id: wfId,
            conversation_id: msg.conversation_id, shop_id: msg.shop_id, platform: msg.platform,
            operation_key: msg.operation_key, status: "running",
            owner_id: botworkerRuntime.ownerId, fencing_token: 1,
            lease_expires_at: new Date(Date.now() + botworkerRuntime.claimLeaseMs),
            started_at: new Date(), updated_at: new Date(),
          });
        } catch (e) {
          if (e.code !== 11000) throw e;
          const p2 = await wfPriorRun(coll, runId);
          if (p2.kind === "done") return { ...p2.prior.result, run_id: p2.prior.run_id, workflow_id: wfId };
          return { status: "actioned", detail: "run in-flight (concurrent)", delivered: [], run_id: runId, workflow_id: wfId };
        }
      }
    } else {
      await coll.insertOne({
        _id: runId, run_id: runId, workflow_id: wfId,
        conversation_id: msg.conversation_id, shop_id: msg.shop_id, platform: msg.platform,
        status: "running", owner_id: botworkerRuntime.ownerId, fencing_token: 1,
        lease_expires_at: new Date(Date.now() + botworkerRuntime.claimLeaseMs),
        started_at: new Date(), updated_at: new Date(),
      });
    }

    // graph exec (mocked graph — owner semantics real)
    state.calls.workflowExec++;
    const result = { ...state.workflowResult };
    await coll.updateOne(
      { run_id: runId },
      { $set: { status: result.run_id ? "waiting_for_reply" : "completed", result, updated_at: new Date() } }
    );
    return { ...result, run_id: runId, workflow_id: wfId };
  },
  /** @param {{ run_id: string, workflow_id?: string }} run @param {{ operation_key?: string }} [msg] */
  resumeFlow: async (run, msg = {}) => {
    state.calls.resumeFlow++;
    const coll = new FakeCollection("workflow_runs");
    const key = msg.operation_key;
    const doc = await coll.findOne({ run_id: run.run_id });
    // dedupe: op key เดิมเคย resume แล้ว → คืนผลเดิม (crash ก่อน caller record outcome)
    if (key && doc?.resume_results?.[key]) return doc.resume_results[key];
    state.calls.resumeExec++;
    const base = state.resumeResult || { status: "resumed", detail: "resumed", delivered: [] };
    const out = { ...base, run_id: run.run_id, workflow_id: run.workflow_id };
    if (key) {
      await coll.updateOne(
        { run_id: run.run_id },
        { $set: { [`resume_results.${key}`]: out, status: out.status === "resumed" ? "completed" : doc?.status, updated_at: new Date() } }
      );
    }
    return out;
  },
  cancelActiveRuns: async () => 0,
  checkWaitTimeouts: async () => 0,
};

export async function logBotworkerEvent(evt) {
  state.events.push(evt);
}
export async function logAdminEvent(evt) {
  state.events.push({ admin: true, ...evt });
}
