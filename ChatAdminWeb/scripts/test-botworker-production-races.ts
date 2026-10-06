// test-botworker-production-races.ts — PRODUCTION-INTEGRATION race harness
//
// รัน: npx tsx scripts/test-botworker-production-races.ts
//
// ต่างจาก test-botworker-idempotency.ts ตรงที่ production modules
// ทำงานจริงทั้งหมดบน fake Mongo (shared engine):
//   ✅ workflowEngine    — matchAndRun/resumeFlow/runFlow/walkGraph จริง
//   ✅ handoffService    — op doc + assignment store + cursor จริง
//   ✅ botWorkerService  — claim/heartbeat/outcome/finalize จริง
//   ✅ bufferService     — conv lock/row CAS/re-fence/flush จริง
// mock เฉพาะ leaf: mongoClient / botCallService / systemConfigService
//
// T1 = redirect guard — ห้าม hooks ไฟล์นี้แตะ 4 production modules

import { register } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ⚡ ต้อง register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-botworker-production-races-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-production-races-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Buf = typeof import("../src/backend/service/bufferService");
type Wf = typeof import("../src/backend/service/workflowEngine");
type Ho = typeof import("../src/backend/service/handoffService");
type Rt = typeof import("../src/backend/service/botworkerRuntime");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mocks: Mocks;
let svc: Svc;
let buf: Buf;
let wf: Wf;
let ho: Ho;
let rt: Rt;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CLAIM_ID = (mid: string) => `botworker:claim:${mid}`;
const WF_RUN_ID = (opKey: string, wfId: string) => "wfr_" + sha(`${opKey}:${wfId}`).slice(0, 20);

const results: { name: string; ok: boolean; err?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  reset();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  }
}

function reset() {
  mocks.resetState();
  rt.botworkerRuntime.flushErrorRetryMs = 5000; // คืนค่า default หลัง test ที่ย่อเวลา
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── seeds ──────────────────────────────────────────────────

function seedConv(conversationId: string) {
  mocks.fakeColl("conversations").push({
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee",
    customer_id: "cust_1",
    shop_name: "TestShop",
    status: "open",
    assigned_to: null,
    last_message_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  });
}

function seedAdmins() {
  mocks.fakeColl("admins").push(
    { admin_id: "a1", role: "admin", active: true, is_accepting_chats: true, created_at: new Date(1000) },
    { admin_id: "a2", role: "admin", active: true, is_accepting_chats: true, created_at: new Date(2000) },
  );
}

/** workflow trigger(kw) → wait(legacy) → send_message — รันแรก park ที่ wait */
function seedWaitWorkflow(wfId: string, kw = "hello") {
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [kw] }, position: { x: 0, y: 0 } },
      { node_id: "n2", type: "wait", subtype: "wait_for_reply", config: { timeout_ms: 60000 }, position: { x: 0, y: 0 } },
      { node_id: "n3", type: "action", subtype: "send_message", config: { text: "resumed-reply" }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { edge_id: "e1", source_node_id: "n1", target_node_id: "n2" },
      { edge_id: "e2", source_node_id: "n2", target_node_id: "n3" },
    ],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

/** workflow trigger(kw) → let_ai_respond — นับ side effect ด้วย callBot */
function seedAiWorkflow(wfId: string, kw = "hello", freq = "every_time") {
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: freq,
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [kw] }, position: { x: 0, y: 0 } },
      { node_id: "n2", type: "action", subtype: "let_ai_respond", config: {}, position: { x: 0, y: 0 } },
    ],
    edges: [{ edge_id: "e1", source_node_id: "n1", target_node_id: "n2" }],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

/** workflow trigger(kw) → let_ai_respond (deliverable) → wait → send_message — park หลัง deliver */
function seedWaitWorkflowAiFirst(wfId: string, kw = "hello") {
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [kw] }, position: { x: 0, y: 0 } },
      { node_id: "n0", type: "action", subtype: "let_ai_respond", config: {}, position: { x: 0, y: 0 } },
      { node_id: "n2", type: "wait", subtype: "wait_for_reply", config: { timeout_ms: 60000 }, position: { x: 0, y: 0 } },
      { node_id: "n3", type: "action", subtype: "send_message", config: { text: "resumed-reply" }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { edge_id: "e1", source_node_id: "n1", target_node_id: "n0" },
      { edge_id: "e0", source_node_id: "n0", target_node_id: "n2" },
      { edge_id: "e2", source_node_id: "n2", target_node_id: "n3" },
    ],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

/** workflow trigger → wait → let_ai_respond — resume แล้ว callBot ครั้งเดียวแล้ว complete */
function seedWaitThenAiWorkflow(wfId: string, kw = "hello") {
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [kw] }, position: { x: 0, y: 0 } },
      { node_id: "n2", type: "wait", subtype: "wait_for_reply", config: { timeout_ms: 60000 }, position: { x: 0, y: 0 } },
      { node_id: "n3", type: "action", subtype: "let_ai_respond", config: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { edge_id: "e1", source_node_id: "n1", target_node_id: "n2" },
      { edge_id: "e2", source_node_id: "n2", target_node_id: "n3" },
    ],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

/** workflow trigger → wait1 → let_ai_respond → wait2 → send — resume park ที่ wait2 หลัง side effect */
function seedDoubleWaitWorkflow(wfId: string, kw = "hello") {
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [kw] }, position: { x: 0, y: 0 } },
      { node_id: "w1", type: "wait", subtype: "wait_for_reply", config: { timeout_ms: 60000 }, position: { x: 0, y: 0 } },
      { node_id: "na", type: "action", subtype: "let_ai_respond", config: {}, position: { x: 0, y: 0 } },
      { node_id: "w2", type: "wait", subtype: "wait_for_reply", config: { timeout_ms: 60000 }, position: { x: 0, y: 0 } },
      { node_id: "n3", type: "action", subtype: "send_message", config: { text: "final" }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { edge_id: "e1", source_node_id: "n1", target_node_id: "w1" },
      { edge_id: "e2", source_node_id: "w1", target_node_id: "na" },
      { edge_id: "e3", source_node_id: "na", target_node_id: "w2" },
      { edge_id: "e4", source_node_id: "w2", target_node_id: "n3" },
    ],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

/** workflow trigger → wait → assign_ticket → send — resume commit หลัง assign side effect */
function seedAssignWorkflow(wfId: string, kw = "hello") {
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [kw] }, position: { x: 0, y: 0 } },
      { node_id: "n2", type: "wait", subtype: "wait_for_reply", config: { timeout_ms: 60000 }, position: { x: 0, y: 0 } },
      { node_id: "nA", type: "action", subtype: "assign_ticket", config: { reason: "t" }, position: { x: 0, y: 0 } },
      { node_id: "n3", type: "action", subtype: "send_message", config: { text: "assigned" }, position: { x: 0, y: 0 } },
    ],
    edges: [
      { edge_id: "e1", source_node_id: "n1", target_node_id: "n2" },
      { edge_id: "e2", source_node_id: "n2", target_node_id: "nA" },
      { edge_id: "e3", source_node_id: "nA", target_node_id: "n3" },
    ],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

/**
 * crash seam ของ HIGH1 — arm เมื่อเห็น terminal/park commit ที่ยังไม่มี resume_results
 * ใน write เดียวกัน แล้ว throw เมื่อ wrapper พยายามเขียน resume_results แยกภายหลัง
 * (= process ตายระหว่าง state commit กับ result write)
 */
function crashBetweenCommitAndResultWrite() {
  let armed = false;
  return (coll: string, _filter: unknown, update: Record<string, Record<string, unknown>>) => {
    if (coll !== "workflow_runs") return;
    const sets = update?.$set || {};
    const hasResumeWrite = Object.keys(sets).some((k) => k.startsWith("resume_results."));
    if (!armed && !hasResumeWrite &&
        (sets.status === "completed" || sets.status === "waiting_for_reply" || sets.status === "cancelled")) {
      armed = true;
      return;
    }
    if (armed && hasResumeWrite) {
      armed = false;
      throw new Error("crash: run state committed but resume_results write lost");
    }
  };
}

function seedRun(fields: Record<string, unknown>) {
  const now = new Date();
  mocks.fakeColl("workflow_runs").push({
    run_id: "wfr_seed", workflow_id: "wf_x",
    conversation_id: "conv_a", shop_id: "shop_1", platform: "shopee",
    status: "running", current_node_id: "n2", context: {},
    owner_id: "w-foreign", fencing_token: 9,
    lease_expires_at: new Date(now.getTime() + 300000),
    started_at: now, updated_at: now,
    ...fields,
  });
}

function engineMsg(over: Record<string, unknown> = {}) {
  return {
    message_id: "m_e1",
    conversation_id: "conv_a",
    shop_id: "shop_1",
    platform: "shopee" as const,
    text: "hello",
    testSource: "botworker" as const,
    ...over,
  };
}

function bufferRow(mid: string, conv: string, over: Record<string, unknown> = {}) {
  return {
    message_id: mid, conversation_id: conv, shop_id: "shop_1", platform: "shopee",
    text: `buffered ${mid}`, kind: "message", status: "buffered",
    received_at: new Date(),
    ...over,
  };
}

function claimDoc(mid: string, over: Record<string, unknown> = {}) {
  return {
    _id: CLAIM_ID(mid), message_id: mid, conversation_id: "conv_c", shop_id: "shop_1", platform: "shopee",
    status: "processing", owner_id: rt.botworkerRuntime.ownerId, fencing_token: 1, attempt: 1,
    claimed_at: new Date(), lease_expires_at: new Date(Date.now() + 300000), updated_at: new Date(),
    ...over,
  };
}

// ── main ───────────────────────────────────────────────────

async function main() {
  mocks = await import("./test-botworker-production-races-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  buf = await import("../src/backend/service/bufferService");
  wf = await import("../src/backend/service/workflowEngine");
  ho = await import("../src/backend/service/handoffService");
  rt = await import("../src/backend/service/botworkerRuntime");
  const { state } = mocks;

  // ── T. test honesty ──────────────────────────────────────

  await test("T1 redirect guard — hooks ห้ามแตะ 4 production modules + modules ที่โหลดเป็น production จริง", async () => {
    const hooksSrc = readFileSync(new URL("./test-botworker-production-races-hooks.mjs", import.meta.url), "utf8");
    const protectedPaths = ["service/workflowEngine.", "service/handoffService.", "service/botWorkerService.", "service/bufferService."];
    for (const p of protectedPaths) {
      assert(!hooksSrc.includes(`"${p}"`), `hooks must not redirect ${p}`);
    }
    // runtime proof — production internals ต้องอยู่ใน function source (mock จะไม่มี)
    assert(wf.matchAndRun.toString().includes("opRunIdFor"), "workflowEngine.matchAndRun is not production code");
    assert(wf.resumeFlow.toString().includes("resume_results"), "workflowEngine.resumeFlow is not production code");
    assert(ho.handoffToAdminTest.toString().includes("doHandoffToAdminTest"), "handoffService.handoffToAdminTest is not production code");
    assert(buf.flushBuffer.toString().includes("acquireConvLock"), "bufferService.flushBuffer is not production code");
    assert(svc.processMessage.toString().includes("processClaimedMessage"), "botWorkerService.processMessage is not production code");
  });

  // ── A. workflow ownership/fencing ────────────────────────

  await test("A1 stale owner ห้าม write/complete หลัง worker อื่น reclaim", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedWaitWorkflow("wf_a1");
    // worker-A (self) เริ่ม run → park ที่ wait node
    const r1 = await wf.matchAndRun(engineMsg({ operation_key: "op_a1", message_id: "m_a1" }));
    assert(r1.status === "actioned", `first run must park waiting, got ${r1.status}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a1")!;
    assert(runDoc.owner_id === rt.botworkerRuntime.ownerId, "run must record creator owner");
    const staleSnapshot = JSON.parse(JSON.stringify(runDoc)); // สำเนาก่อน reclaim
    // worker-B reclaim หลัง lease หมด (test ทำ DB-op ตรงๆ = CAS ของ B)
    await (await mocks.getCollection("workflow_runs")).findOneAndUpdate(
      { run_id: runDoc.run_id, owner_id: staleSnapshot.owner_id, fencing_token: staleSnapshot.fencing_token },
      { $set: { owner_id: "worker-B", lease_expires_at: new Date(Date.now() + 300000), status: "running" }, $inc: { fencing_token: 1 } },
    );
    // worker-A stale snapshot พยายาม resume/เขียนทับ → ต้องโดนปฏิเสธ
    const stale = await wf.resumeFlow(staleSnapshot, engineMsg({ operation_key: "op_a1_resume", message_id: "m_a1b" }));
    const after = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!;
    assert(stale.status === "in_flight", `stale resume must be in_flight, got ${stale.status}`);
    // ⚡ fakeColl คืน live refs — runDoc ถูก B's reclaim mutate แล้ว ใช้ staleSnapshot เป็น expected
    assert(after.owner_id === "worker-B" && after.fencing_token === staleSnapshot.fencing_token + 1,
      `stale write leaked: owner=${after.owner_id} fence=${after.fencing_token}`);
    assert(!after.resume_results || Object.keys(after.resume_results).length === 0, "stale worker wrote resume_results");
  });

  await test("A1b walk กลางทางเสีย ownership → หยุดเดิน graph ทันที (fenced write fails → in_flight)", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_a1b");
    // hook ที่ first run write → เปลี่ยน owner ก่อน update ถึง (CAS ต้อง fail)
    state.updateOneHook = async (coll: string) => {
      if (coll !== "workflow_runs") return;
      state.updateOneHook = null; // ยิงครั้งเดียว
      await (await mocks.getCollection("workflow_runs")).updateOne(
        { run_id: WF_RUN_ID("op_a1b", "wf_a1b") },
        { $set: { owner_id: "worker-B", fencing_token: 99, lease_expires_at: new Date(Date.now() + 300000) } },
      );
    };
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_a1b", message_id: "m_a1c" }));
    const doc = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === WF_RUN_ID("op_a1b", "wf_a1b"))!;
    assert(res.status === "in_flight", `lost-owner walk must return in_flight, got ${res.status}`);
    assert(state.calls.callBot === 0, `callBot=${state.calls.callBot} — stale worker executed graph side effects`);
    assert(doc.owner_id === "worker-B" && doc.fencing_token === 99 && doc.status === "running",
      `stale writer overwrote run: ${JSON.stringify({ owner: doc.owner_id, fence: doc.fencing_token, status: doc.status })}`);
    assert(!doc.result, "stale worker wrote result snapshot");
  });

  await test("A2 concurrent matchAndRun same operation_key → production graph executes exactly once", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_a2");
    const msg = engineMsg({ operation_key: "op_a2", message_id: "m_a2" });
    const [r1, r2] = await Promise.all([wf.matchAndRun(msg), wf.matchAndRun({ ...msg })]);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — graph must execute once`);
    const runs = mocks.fakeColl("workflow_runs").filter((d: any) => d.operation_key === "op_a2");
    assert(runs.length === 1, `runs=${runs.length} want 1 deterministic run`);
    const statuses = [r1.status, r2.status].sort();
    assert(statuses.includes("in_flight") || (statuses[0] === "actioned" && statuses[1] === "actioned" && !!runs[0].result),
      `loser must be in_flight (or cached result), got ${JSON.stringify(statuses)}`);
    // ⚡ loser ห้ามถูกโกหกเป็น actioned ขณะ run ยังไม่มีผลลัพธ์ — ถ้า in_flight = pass
    assert(statuses.includes("in_flight"), `concurrent loser got ${JSON.stringify(statuses)} — must be explicit in_flight, not actioned`);
  });

  await test("A3 active run ของ owner อื่น → explicit in_flight result ไม่ใช่ actioned", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_a3");
    seedRun({ run_id: WF_RUN_ID("op_a3", "wf_a3"), workflow_id: "wf_a3", operation_key: "op_a3" });
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_a3", message_id: "m_a3" }));
    assert(res.status === "in_flight", `foreign-active run must return in_flight, got ${res.status}`);
    assert(state.calls.callBot === 0, "must not execute graph for foreign-owned run");
  });

  await test("A4 Botworker ได้ in_flight → claim ไม่ terminal + ไม่สร้าง empty workflow outcome", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedWaitWorkflow("wf_a4");
    // run กำลังเดิน (running) โดย worker อื่น — resume ต้องไม่แย่ง/ไม่ finalize
    seedRun({ run_id: "wfr_a4", workflow_id: "wf_a4", conversation_id: "conv_a", current_node_id: "n2" });
    const res = await svc.processMessage(engineMsg({ message_id: "m_a4" }) as any);
    const claims = mocks.fakeColl("chat_processing").filter((d: any) => d._id === CLAIM_ID("m_a4"));
    assert(claims.length === 1 && claims[0].status === "processing",
      `claim must stay non-terminal processing, got ${JSON.stringify(claims.map((c: any) => c.status))}`);
    assert(!res.finalized, "in-flight result must not finalize claim");
    const wfReplies = mocks.fakeColl("shadow_replies").filter((d: any) => d.origin === "workflow");
    assert(wfReplies.length === 0, `empty workflow outcome persisted: ${JSON.stringify(wfReplies)}`);
    assert(mocks.fakeColl("workflow_replies").length === 0, "workflow_replies doc created for in-flight result");
  });

  await test("A5 concurrent resume ต่าง operation_key บน run เดียว → execute ครั้งเดียว", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedWaitWorkflow("wf_a5");
    // park run ที่ wait node (ผ่าน production matchAndRun จริง)
    const r0 = await wf.matchAndRun(engineMsg({ operation_key: "op_a5", message_id: "m_a5" }));
    assert(r0.status === "actioned", `setup: run must park waiting, got ${r0.status}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a5")!;
    // สอง caller พร้อมกัน คนละ message (op key ต่างกัน) — run ต้อง execute resume ครั้งเดียว
    const [ra, rb] = await Promise.all([
      wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a5_a", message_id: "m_a5a", text: "reply-a" })),
      wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a5_b", message_id: "m_a5b", text: "reply-b" })),
    ]);
    const after = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!;
    const resumeKeys = Object.keys(after.resume_results || {});
    assert(resumeKeys.length === 1, `resume_results has ${resumeKeys.length} keys — run executed resume ${resumeKeys.length} times`);
    const outcomes = [ra.status, rb.status].sort();
    assert(outcomes.includes("in_flight"), `loser must get in_flight, got ${JSON.stringify(outcomes)}`);
  });

  await test("A6 crash หลัง resume side effect ก่อน caller finalize → retry ด้วย key เดิมไม่ทำซ้ำ", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedWaitWorkflow("wf_a6");
    const r0 = await wf.matchAndRun(engineMsg({ operation_key: "op_a6", message_id: "m_a6" }));
    assert(r0.status === "actioned", `setup: ${r0.status}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a6")!;
    // resume ครั้งแรก commit แล้ว (side effect ส่ง message + resume_results[key])
    const r1 = await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a6_r", message_id: "m_a6a", text: "ans" }));
    assert(r1.status === "resumed", `first resume: ${r1.status}`);
    // crash ก่อน caller finalize → retry ด้วย key เดิม → ผลเดิม ไม่เดิน graph ซ้ำ
    const snapshot = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!;
    const r2 = await wf.resumeFlow(snapshot, engineMsg({ operation_key: "op_a6_r", message_id: "m_a6a", text: "ans" }));
    assert(r2.status === "resumed", `retry resume: ${r2.status}`);
    assert(Object.keys(snapshot.resume_results || {}).length === 1 &&
      Object.keys(mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!.resume_results || {}).length === 1,
      "resume side effect ran more than once for same op key");
  });

  await test("A7 initial result เป็น immutable snapshot — resume op ห้ามเขียนทับ", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedWaitWorkflowAiFirst("wf_a7");
    // op_initial เริ่ม run → let_ai_respond deliver → park ที่ wait → result A (parked snapshot)
    const r0 = await wf.matchAndRun(engineMsg({ operation_key: "op_a7_init", message_id: "m_a7a" }));
    assert(r0.status === "actioned" && r0.delivered.length > 0, `setup: initial must park+deliver, got ${r0.status} delivered=${r0.delivered.length}`);
    assert(state.calls.callBot === 1, `setup: let_ai_respond must run once, got ${state.calls.callBot}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a7_init")!;
    const snapshotA = JSON.parse(JSON.stringify(runDoc.result)); // result A — deep copy ก่อน resume
    assert(snapshotA?.status === "actioned", `setup: initial result must persist, got ${JSON.stringify(snapshotA)}`);
    // op_resume (op อื่น) resume → เดินต่อ → send_message → complete → result B
    const rb = await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a7_resume", message_id: "m_a7b", text: "ans" }));
    assert(rb.status === "resumed", `resume must succeed, got ${rb.status}`);
    const afterResume = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!;
    // result B ต้องอยู่แค่ resume_results.op_a7_resume — ห้ามทับ initial result
    assert(afterResume.resume_results?.op_a7_resume?.status === "resumed",
      `resume result must live in resume_results only, got ${JSON.stringify(Object.keys(afterResume.resume_results || {}))}`);
    assert(JSON.stringify(afterResume.result) === JSON.stringify(snapshotA),
      `initial result overwritten by resume: ${JSON.stringify({ was: snapshotA, now: afterResume.result })}`);
    // retry op_initial → ต้องคืน result A เดิม (ไม่ใช่ผลของ resume)
    const retry = await wf.matchAndRun(engineMsg({ operation_key: "op_a7_init", message_id: "m_a7a" }));
    assert(retry.status === "actioned" && retry.detail === snapshotA.detail,
      `retry of initial op must return original result A, got ${JSON.stringify({ status: retry.status, detail: retry.detail })}`);
    assert(JSON.stringify(retry.delivered) === JSON.stringify(snapshotA.delivered),
      "retry delivered must equal initial delivered — no re-execution");
    // resume op เดิม retry → คืน resume_results เดิม ไม่ execute ซ้ำ
    const rbRetry = await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a7_resume", message_id: "m_a7b", text: "ans" }));
    assert(rbRetry.status === "resumed" && rbRetry.detail === rb.detail, "same resume key must return persisted result");
    // resume คนละ key → ห้ามอ่านผลของ op_resume (run จบแล้ว → cannot resume, ไม่ใช่ผลของ key อื่น)
    const rOther = await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a7_other", message_id: "m_a7c", text: "x" }));
    assert(rOther.detail !== rb.detail || rOther.status !== "resumed",
      `different resume key must not read another key's result, got ${JSON.stringify(rOther)}`);
    // side effect ต้องไม่เกิดซ้ำ — callBot คง 1 ตลอด retry ทั้งสอง key
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — graph re-executed on retry`);
  });

  await test("A8 initial op จบในรอบเดียว → result persist + retry คืนผลเดิม ไม่ re-exec", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_a8");
    const r1 = await wf.matchAndRun(engineMsg({ operation_key: "op_a8", message_id: "m_a8" }));
    assert(r1.status === "actioned" && r1.delivered.length > 0, `setup: must complete+deliver, got ${r1.status}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a8")!;
    assert(runDoc.status === "completed" && runDoc.result?.status === "actioned" && runDoc.result.detail === r1.detail,
      `initial result must persist on completed run, got ${JSON.stringify(runDoc.result)}`);
    const retry = await wf.matchAndRun(engineMsg({ operation_key: "op_a8", message_id: "m_a8" }));
    assert(retry.status === "actioned" && retry.detail === r1.detail &&
      JSON.stringify(retry.delivered) === JSON.stringify(r1.delivered),
      `retry must return persisted result, got ${JSON.stringify(retry)}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — graph re-executed on retry`);
  });

  // ── A9. HIGH1 — resume outcome atomicity (crash ระหว่าง state commit กับ result write) ──

  await test("A9a crash หลัง resume commit-completed ก่อน result write → retry คืนผลเดิม ไม่ re-exec", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedWaitThenAiWorkflow("wf_a9a");
    const r0 = await wf.matchAndRun(engineMsg({ operation_key: "op_a9a_init", message_id: "m_a9a" }));
    assert(r0.status === "actioned", `setup: park expected, got ${r0.status}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a9a_init")!;
    const snapA = JSON.parse(JSON.stringify(runDoc.result));
    state.updateOneHook = crashBetweenCommitAndResultWrite();
    let rb: any = null, crashed = false;
    try {
      rb = await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a9a_r1", message_id: "m_a9b", text: "ans" }));
    } catch { crashed = true; }
    state.updateOneHook = null;
    // retry key เดิม — ต้องคืน outcome ที่ commit แล้ว (callBot=1 = side effect ครั้งเดียว)
    const r1 = crashed ? await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a9a_r1", message_id: "m_a9b", text: "ans" })) : rb;
    assert(r1?.status === "resumed", `retry after commit must return resumed outcome, got ${JSON.stringify(r1)}`);
    const after = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!;
    assert(after.resume_results?.op_a9a_r1?.status === "resumed",
      `resume_results.op_a9a_r1 must be persisted atomically with commit, got ${JSON.stringify(after.resume_results)}`);
    assert(JSON.stringify(after.result) === JSON.stringify(snapA), "initial result must stay immutable");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — let_ai_respond re-executed on retry`);
  });

  await test("A9b crash หลัง resume re-park (wait อีกรอบ) → retry คืนผลเดิม", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedDoubleWaitWorkflow("wf_a9b");
    const r0 = await wf.matchAndRun(engineMsg({ operation_key: "op_a9b_init", message_id: "m_a9c" }));
    assert(r0.status === "actioned", `setup: park at w1, got ${r0.status}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a9b_init")!;
    const snapA = JSON.parse(JSON.stringify(runDoc.result));
    state.updateOneHook = crashBetweenCommitAndResultWrite();
    let rb: any = null, crashed = false;
    try {
      rb = await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a9b_r1", message_id: "m_a9d", text: "ans" }));
    } catch { crashed = true; }
    state.updateOneHook = null;
    const r1 = crashed ? await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a9b_r1", message_id: "m_a9d", text: "ans" })) : rb;
    // parked outcome — run ต้องยังรอที่ wait2 และผลต้องเหมือนเดิม
    assert(r1?.status === "resumed" && r1.detail.includes("w2"),
      `re-parked resume must return parked outcome, got ${JSON.stringify(r1)}`);
    const after = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!;
    assert(after.status === "waiting_for_reply" && after.current_node_id === "w2",
      `run must stay parked at w2, got ${after.status}@${after.current_node_id}`);
    assert(after.resume_results?.op_a9b_r1?.detail === r1.detail, "resume_results must hold the parked outcome");
    assert(JSON.stringify(after.result) === JSON.stringify(snapA), "initial result must stay immutable");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — let_ai_respond re-executed`);
  });

  await test("A9c crash หลัง resume commit (assign_ticket) → retry คืนผลเดิม assign ไม่ซ้ำ", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAdmins();
    seedAssignWorkflow("wf_a9c");
    const r0 = await wf.matchAndRun(engineMsg({ operation_key: "op_a9c_init", message_id: "m_a9e" }));
    assert(r0.status === "actioned", `setup: park, got ${r0.status}`);
    const runDoc = mocks.fakeColl("workflow_runs").find((d: any) => d.operation_key === "op_a9c_init")!;
    const snapA = JSON.parse(JSON.stringify(runDoc.result));
    state.updateOneHook = crashBetweenCommitAndResultWrite();
    let rb: any = null, crashed = false;
    try {
      rb = await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a9c_r1", message_id: "m_a9f", text: "ans" }));
    } catch { crashed = true; }
    state.updateOneHook = null;
    const r1 = crashed ? await wf.resumeFlow(runDoc, engineMsg({ operation_key: "op_a9c_r1", message_id: "m_a9f", text: "ans" })) : rb;
    assert(r1?.status === "resumed", `retry must return committed outcome, got ${JSON.stringify(r1)}`);
    assert(r1.handoff?.agentId, `handoff evidence must survive in result, got ${JSON.stringify(r1)}`);
    // assign op doc ต้องมี doc เดียว (idempotent) — opKey = `${op}:assign:nA`
    const assignOps = mocks.fakeColl("botworker_events").filter((d: any) => d._id === "op_a9c_r1:assign:nA");
    assert(assignOps.length === 1, `assign op docs=${assignOps.length} want 1 — assignment must be idempotent`);
    const tstat = mocks.fakeColl("test_status_conversation").find((d: any) => d.conversation_id === "conv_a" && d.source === "botworker");
    assert(tstat?.assigned_to === r1.handoff.agentId, `assignment must match result, got ${tstat?.assigned_to}`);
    assert(JSON.stringify(mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runDoc.run_id)!.result) === JSON.stringify(snapA),
      "initial result must stay immutable");
  });

  // ── R. HIGH2 — existing-operation recovery ต้องมาก่อน eligibility gates ──

  await test("R1 initial complete + once_per_conversation → retry key เดิมคืน result เดิม", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_r1", "hello", "once_per_conversation");
    const r1 = await wf.matchAndRun(engineMsg({ operation_key: "op_r1", message_id: "m_r1" }));
    assert(r1.status === "actioned" && state.calls.callBot === 1, `setup: complete once, got ${r1.status}`);
    const retry = await wf.matchAndRun(engineMsg({ operation_key: "op_r1", message_id: "m_r1" }));
    assert(retry.status === "actioned" && retry.detail === r1.detail,
      `existing op must bypass frequency gate and return persisted result, got ${JSON.stringify(retry)}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — re-executed`);
  });

  await test("R2 initial complete + once_per_customer → retry key เดิมคืน result เดิม", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_r2", "hello", "once_per_customer");
    const r1 = await wf.matchAndRun(engineMsg({ operation_key: "op_r2", message_id: "m_r2", customer_id: "cust_x" }));
    assert(r1.status === "actioned", `setup: complete, got ${r1.status}`);
    const retry = await wf.matchAndRun(engineMsg({ operation_key: "op_r2", message_id: "m_r2", customer_id: "cust_x" }));
    assert(retry.status === "actioned" && retry.detail === r1.detail,
      `existing op must bypass once_per_customer gate, got ${JSON.stringify(retry)}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — re-executed`);
  });

  await test("R3 workflow disabled/unpublished หลัง initial commit → retry key เดิมยัง recover", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_r3");
    const r1 = await wf.matchAndRun(engineMsg({ operation_key: "op_r3", message_id: "m_r3" }));
    assert(r1.status === "actioned", `setup: complete, got ${r1.status}`);
    // ปิด workflow หลัง commit แล้ว (enabled=false — listWorkflows จะไม่เห็น)
    const wdoc = mocks.fakeColl("workflows").find((d: any) => d.workflow_id === "wf_r3")!;
    wdoc.enabled = false;
    const retry = await wf.matchAndRun(engineMsg({ operation_key: "op_r3", message_id: "m_r3" }));
    assert(retry.status === "actioned" && retry.detail === r1.detail,
      `existing op must recover despite disabled workflow, got ${JSON.stringify(retry)}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — re-executed`);
  });

  await test("R4 global workflow flag ปิดหลัง initial commit → retry key เดิมยัง recover", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_r4");
    const r1 = await wf.matchAndRun(engineMsg({ operation_key: "op_r4", message_id: "m_r4" }));
    assert(r1.status === "actioned", `setup: complete, got ${r1.status}`);
    state.config.workflow_enabled = false; // flag off หลัง commit
    const retry = await wf.matchAndRun(engineMsg({ operation_key: "op_r4", message_id: "m_r4" }));
    assert(retry.status === "actioned" && retry.detail === r1.detail,
      `existing op must recover despite global flag off, got ${JSON.stringify(retry)}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — re-executed`);
  });

  await test("R5 op key ใหม่ยังโดน gates ปกติ + key อื่นห้ามอ่านผลของกัน", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_r5", "hello", "once_per_conversation");
    const r1 = await wf.matchAndRun(engineMsg({ operation_key: "op_r5", message_id: "m_r5" }));
    assert(r1.status === "actioned", `setup: complete, got ${r1.status}`);
    // op key ใหม่ข้อความใหม่ — frequency gate ต้องยังกัน (once_per_conversation + completed run)
    const fresh = await wf.matchAndRun(engineMsg({ operation_key: "op_r5_new", message_id: "m_r5b" }));
    assert(fresh.status === "no_match", `new op must still hit frequency gate, got ${JSON.stringify(fresh)}`);
    // key อื่นห้ามได้ผลของ op_r5
    assert(fresh.detail !== r1.detail, "different key must not read another op's result");
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} — new op re-executed`);
  });

  // ── D. HIGH-R3 — terminal run ไม่มี result ห้ามโกหกเป็น in_flight ──

  await test("D1 prior errored run ไม่มี result → terminal error (recoverable=false) ไม่ใช่ in_flight", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d1");
    seedRun({
      run_id: "wfr_d1", workflow_id: "wf_d1", conversation_id: "conv_a",
      operation_key: "op_d1", status: "errored", outcome: "error", completed_at: new Date(),
    });
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d1", message_id: "m_d1" }));
    assert(res.status !== "in_flight", `terminal errored run must not return in_flight, got ${JSON.stringify(res)}`);
    assert(res.status === "error" && (res as any).recoverable === false,
      `terminal op must return non-recoverable error, got ${JSON.stringify(res)}`);
    assert(state.calls.callBot === 0, "must not execute graph for terminal op");
    assert(mocks.fakeColl("workflow_runs").filter((d: any) => d.operation_key === "op_d1").length === 1,
      "must not create a new run for a dead op");
  });

  await test("D2 prior cancelled run ไม่มี result → terminal error ตาม outcome", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d2");
    seedRun({
      run_id: "wfr_d2", workflow_id: "wf_d2", conversation_id: "conv_a",
      operation_key: "op_d2", status: "cancelled", outcome: "cancelled_by_admin", completed_at: new Date(),
    });
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d2", message_id: "m_d2" }));
    assert(res.status !== "in_flight", `cancelled run must not return in_flight, got ${JSON.stringify(res)}`);
    assert(res.status === "error" && (res as any).recoverable === false,
      `cancelled op must return non-recoverable error, got ${JSON.stringify(res)}`);
    assert(res.detail.includes("cancelled"), `detail must name terminal state, got ${res.detail}`);
    assert(state.calls.callBot === 0, "must not execute graph for terminal op");
  });

  await test("D3 prior completed run แต่ result หาย (corrupt) → terminal error ไม่ใช่ in_flight", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d3");
    seedRun({
      run_id: "wfr_d3", workflow_id: "wf_d3", conversation_id: "conv_a",
      operation_key: "op_d3", status: "completed", outcome: "actioned", completed_at: new Date(),
    });
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d3", message_id: "m_d3" }));
    assert(res.status !== "in_flight", `corrupt completed run must not return in_flight, got ${JSON.stringify(res)}`);
    assert(res.status === "error" && (res as any).recoverable === false,
      `corrupt op must return non-recoverable error, got ${JSON.stringify(res)}`);
    assert(state.calls.callBot === 0, "must not execute graph for terminal op");
  });

  await test("D4 run doc หายระหว่าง first read กับ acquire → terminal error ไม่ใช่ fake in_flight", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d4");
    seedRun({
      run_id: "wfr_d4", workflow_id: "wf_d4", conversation_id: "conv_a",
      operation_key: "op_d4", status: "waiting_for_reply", current_node_id: "n2",
    });
    // doc ถูกลบระหว่าง recovery read กับ acquire CAS — simulate ด้วย hook
    state.findOneAndUpdateHook = async (coll: string, filter: Record<string, unknown>) => {
      if (coll !== "workflow_runs" || !filter?.run_id) return;
      state.findOneAndUpdateHook = null;
      await (await mocks.getCollection("workflow_runs")).deleteOne({ run_id: "wfr_d4" });
    };
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d4", message_id: "m_d4" }));
    assert(res.status !== "in_flight", `deleted run must not return fake in_flight, got ${JSON.stringify(res)}`);
    assert(res.status === "error" && (res as any).recoverable === false,
      `missing doc must return non-recoverable error, got ${JSON.stringify(res)}`);
  });

  await test("D5 prior running foreign-active owner → ยังต้องคืน in_flight (control)", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d5");
    // seedRun default = running + owner w-foreign + lease active → acquire แพ้ → in_flight เดิม
    seedRun({ run_id: "wfr_d5", workflow_id: "wf_d5", conversation_id: "conv_a", operation_key: "op_d5" });
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d5", message_id: "m_d5" }));
    assert(res.status === "in_flight", `active foreign run must stay in_flight, got ${JSON.stringify(res)}`);
    assert(state.calls.callBot === 0, "must not execute foreign-owned run");
  });

  await test("D6 prior waiting_for_reply ไม่มี result (timeout re-park) → acquire เดินต่อตาม contract เดิม", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedWaitWorkflow("wf_d6");
    // run ถูก timeout-checker เดินกลับมา park ที่ wait โดยไม่เขียน result — retry op เดิมต้องเดินต่อได้
    seedRun({
      run_id: "wfr_d6", workflow_id: "wf_d6", conversation_id: "conv_a",
      operation_key: "op_d6", status: "waiting_for_reply", current_node_id: "n2",
      owner_id: "w-dead", fencing_token: 3, lease_expires_at: new Date(Date.now() - 1000),
    });
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d6", message_id: "m_d6" }));
    assert(res.status === "actioned" || res.status === "resumed",
      `parked op retry must continue the run, got ${JSON.stringify(res)}`);
  });

  await test("D7 terminal op ผ่าน processMessage จริง → claim settle bot_failed ไม่ค้าง processing", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d7");
    const mid = "m_d7";
    const opKey = `botworker:op:${CLAIM_ID(mid)}:workflow`;
    seedRun({
      run_id: "wfr_d7", workflow_id: "wf_d7", conversation_id: "conv_a",
      operation_key: opKey, status: "errored", outcome: "error", completed_at: new Date(),
    });
    const res = await svc.processMessage(engineMsg({ message_id: mid }) as any);
    assert(res.status === "bot_failed",
      `terminal op must settle claim as bot_failed, got ${JSON.stringify(res)}`);
    assert(res.finalized === true, "terminal op must finalize — claim must not spin on retries");
    const claim = mocks.fakeColl("chat_processing").find((d: any) => d._id === CLAIM_ID(mid));
    assert(claim?.status === "bot_failed" && claim.outcome_type === "bot_failed",
      `claim must be terminal bot_failed, got ${JSON.stringify({ status: claim?.status, outcome: claim?.outcome_type })}`);
    assert(state.calls.callBot === 0, "terminal op must not fall through to bot/LLM");
  });

  await test("D8 legacy run ไม่มี operation_key → recovery boundary ไม่ match, op ใหม่ทำงานปกติ", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d8");
    // legacy terminal run (ไม่มี operation_key) ใน conv เดียวกัน — ห้ามถูก recovery จับผิด
    seedRun({ run_id: "wfr_d8_legacy", workflow_id: "wf_d8", conversation_id: "conv_a", status: "errored", outcome: "error" });
    // (seedRun ไม่ใส่ operation_key → legacy doc field ไม่เคยมี)
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d8", message_id: "m_d8" }));
    assert(res.status === "actioned" && res.delivered.length > 0,
      `new op must execute normally past legacy terminal run, got ${JSON.stringify(res)}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1`);
  });

  await test("D9 recovery lookup ต้องส่ง compound filter {conversation_id, operation_key} เข้า Mongo", async () => {
    state.config.workflow_enabled = true;
    seedConv("conv_a");
    seedAiWorkflow("wf_d9");
    // สอง run ใน conv เดียวกัน คนละ op key — ต้องคืนเฉพาะของ key ที่ขอ
    seedRun({
      run_id: "wfr_d9_a", workflow_id: "wf_d9", conversation_id: "conv_a",
      operation_key: "op_d9_a", status: "completed", outcome: "actioned",
      completed_at: new Date(),
      result: { status: "actioned", detail: "result-of-op-a", delivered: [] },
    });
    seedRun({ run_id: "wfr_d9_b", workflow_id: "wf_d9", conversation_id: "conv_a", operation_key: "op_d9_b" });
    const filters: Record<string, unknown>[] = [];
    state.findOneHook = async (coll: string, filter: Record<string, unknown>) => {
      if (coll === "workflow_runs") filters.push(filter);
    };
    const res = await wf.matchAndRun(engineMsg({ operation_key: "op_d9_a", message_id: "m_d9" }));
    state.findOneHook = null;
    assert(res.status === "actioned" && res.detail === "result-of-op-a",
      `must return only op_d9_a's committed result, got ${JSON.stringify(res)}`);
    assert(filters.some((f) => f.conversation_id === "conv_a" && f.operation_key === "op_d9_a"),
      `recovery must query {conversation_id, operation_key} server-side — no toArray/in-memory filter, saw ${JSON.stringify(filters)}`);
  });

  // ── B. handoff operation ownership ───────────────────────

  const handoff = (conv: string, opKey: string) => ho.handoffToAdminTest({
    conversationId: conv, shopId: "shop_1", platform: "shopee",
    reason: "t", source: "botworker", assignedStatus: "open", operationKey: opKey,
  });
  const cursor = () => mocks.fakeColl("assignment_cursors").find((d: any) => d.pool_key === "global:botworker");
  const testStatus = (conv: string) => mocks.fakeColl("test_status_conversation").find((d: any) => d.conversation_id === conv && d.source === "botworker");

  await test("B1 concurrent callers same operationKey → assignment executor runs once", async () => {
    seedAdmins();
    const [r1, r2] = await Promise.all([handoff("conv_b1", "op_b1"), handoff("conv_b1", "op_b1")]);
    assert(r1.assignedTo === "a1" && r2.assignedTo === "a1",
      `both callers must converge to a1, got ${r1.assignedTo}/${r2.assignedTo}`);
    assert(cursor()?.last_assigned_admin_id === "a1",
      `cursor moved more than once: ${JSON.stringify(cursor())}`);
    assert(testStatus("conv_b1")?.assigned_to === "a1", "assignment must be a1 (first exec), not overwritten by second");
  });

  await test("B2 crash หลัง assignment commit ก่อน op result → retry reconstruct ไม่ขยับ cursor", async () => {
    seedAdmins();
    // assignment commit แล้ว (a2, key ตรง) แต่ op ยัง pending — simulate crash window
    mocks.fakeColl("botworker_events").push({
      _id: "op_b2", status: "pending", owner_id: "w-old", fencing_token: 1,
      lease_expires_at: new Date(Date.now() - 1000), created_at: new Date(),
    });
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: "conv_b2", source: "botworker", status: "open",
      assigned_to: "a2", assignment_operation_key: "op_b2", updated_at: new Date(),
    });
    mocks.fakeColl("assignment_cursors").push({ pool_key: "global:botworker", last_assigned_admin_id: "a2", updated_at: new Date() });
    const r = await handoff("conv_b2", "op_b2");
    assert(r.assignedTo === "a2", `must reconstruct committed assignment a2, got ${r.assignedTo}`);
    assert(cursor()?.last_assigned_admin_id === "a2", "cursor must not move on reconstruct");
    const op = mocks.fakeColl("botworker_events").find((d: any) => d._id === "op_b2")!;
    assert(op.status === "done" && op.result?.assignedTo === "a2", `op must record result, got ${JSON.stringify(op.status)}`);
    assert(op.owner_id === rt.botworkerRuntime.ownerId && op.fencing_token === 2,
      `reclaim must stamp new owner/fence (CAS evidence), got ${JSON.stringify({ owner: op.owner_id, fence: op.fencing_token })}`);
  });

  await test("B3 assigned_to เก่า (op key ต่าง) → ห้ามถือว่า current op สำเร็จ", async () => {
    seedAdmins();
    mocks.fakeColl("botworker_events").push({ _id: "op_b3", status: "pending", created_at: new Date() });
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: "conv_b3", source: "botworker", status: "open",
      assigned_to: "a2", assignment_operation_key: "op_OLD_OTHER", updated_at: new Date(),
    });
    const r = await handoff("conv_b3", "op_b3");
    const op = mocks.fakeColl("botworker_events").find((d: any) => d._id === "op_b3")!;
    // stale assigned_to ไม่ใช่หลักฐานของ op นี้ → ต้องผ่าน exec path จริง (existing_assignment)
    assert(r.assignmentReason.includes("existing_assignment"),
      `stale assignment used as success evidence — reason=${r.assignmentReason}`);
    assert(!op.result?.assignmentReason?.includes("recovered"),
      `op result must come from real exec, got ${op.result?.assignmentReason}`);
  });

  await test("B4 expired operation owner → fenced reclaim โดย caller เดียว", async () => {
    seedAdmins();
    mocks.fakeColl("botworker_events").push({
      _id: "op_b4", status: "pending", owner_id: "w-dead", fencing_token: 5,
      lease_expires_at: new Date(Date.now() - 1000), created_at: new Date(),
    });
    // ชะลอ cursor-read ของ caller แรกใน pickNextAgent — caller สอง exec เสร็จ
    // (commit a1) ก่อน caller หนึ่งอ่าน cursor → ถ้าไม่มี ownership fencing
    // ทั้งคู่ exec → caller หนึ่งจะเห็น a1 แล้วจ่าย a2 (double-assign)
    let delayed = false;
    state.findOneHook = async (coll: string, filter: any) => {
      if (delayed || coll !== "assignment_cursors" || !filter?.pool_key) return;
      delayed = true;
      await sleep(60);
    };
    const [r1, r2] = await Promise.all([handoff("conv_b4", "op_b4"), handoff("conv_b4", "op_b4")]);
    assert(cursor()?.last_assigned_admin_id === "a1",
      `expired op reclaimed by two callers — cursor=${cursor()?.last_assigned_admin_id} want a1`);
    const op = mocks.fakeColl("botworker_events").find((d: any) => d._id === "op_b4")!;
    assert(op.status === "done" && op.result?.assignedTo === "a1", `op must settle once with a1, got ${JSON.stringify(op.result)}`);
    const inflight = [r1, r2].some((r: any) => r.in_flight || r.assignedTo === "a1");
    assert(inflight, "loser must get in_flight or the committed result");
  });

  await test("B5 active operation owner → caller อื่นได้ in_flight ไม่ execute", async () => {
    seedAdmins();
    mocks.fakeColl("botworker_events").push({
      _id: "op_b5", status: "pending", owner_id: "w-alive", fencing_token: 1,
      lease_expires_at: new Date(Date.now() + 300000), created_at: new Date(),
    });
    const r: any = await handoff("conv_b5", "op_b5");
    assert(r.in_flight === true, `active foreign op must return in_flight, got ${JSON.stringify(r)}`);
    assert(r.assignedTo === null, "must not execute assignment for foreign-owned op");
    assert(!cursor(), "cursor must not exist — no exec happened");
    assert(!testStatus("conv_b5"), "no assignment side effect allowed");
  });

  await test("B6 recovery result write ต้อง fenced — stale owner ห้ามเขียนทับหลัง reclaim", async () => {
    seedAdmins();
    // pending op (expired w-old, fence=1) + assignment evidence ของ op นี้ commit แล้ว
    mocks.fakeColl("botworker_events").push({
      _id: "op_b6", status: "pending", owner_id: "w-old", fencing_token: 1,
      lease_expires_at: new Date(Date.now() - 1000), created_at: new Date(),
    });
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: "conv_b6", source: "botworker", status: "open",
      assigned_to: "a2", assignment_operation_key: "op_b6", updated_at: new Date(),
    });
    // A acquire (fence→2) → เจอ evidence → ก่อน A เขียน done/result ให้ B reclaim (fence→3)
    let fired = false;
    state.updateOneHook = async (coll: string, filter: any, update: any) => {
      if (fired || coll !== "botworker_events" || update?.$set?.status !== "done") return;
      fired = true;
      // worker-B reclaim (owner/fence เปลี่ยน) ก่อน A's terminal write ถึง
      await (await mocks.getCollection("botworker_events")).updateOne(
        { _id: "op_b6" },
        { $set: { owner_id: "w-B", lease_expires_at: new Date(Date.now() + 300000) }, $inc: { fencing_token: 1 } },
      );
    };
    const r: any = await handoff("conv_b6", "op_b6");
    const op = mocks.fakeColl("botworker_events").find((d: any) => d._id === "op_b6")!;
    assert(fired, "hook must fire at A's recovery result write");
    assert(r.in_flight === true, `stale owner A must get in_flight (no winner result yet), got ${JSON.stringify(r)}`);
    assert(op.status === "pending" && op.owner_id === "w-B" && op.fencing_token === 3 && !op.result,
      `stale write leaked into B's op: ${JSON.stringify({ status: op.status, owner: op.owner_id, fence: op.fencing_token, hasResult: !!op.result })}`);
  });

  // ── C. buffer terminal cleanup ───────────────────────────

  const markProcessedCalls: { id: string; status: string }[] = [];
  const markProcessed = async (doc: any) => { markProcessedCalls.push({ id: doc.message_id, status: doc.status }); };
  const processFn = (m: any) => svc.processMessage(m);

  await test("C1 buffer row ที่ claim terminal → ถูกลบ/settle ไม่กลับ buffered", async () => {
    seedConv("conv_c1");
    mocks.fakeColl("buffer_messages").push(
      bufferRow("m_c1", "conv_c1", { claim_id: CLAIM_ID("m_c1"), owner_id: rt.botworkerRuntime.ownerId, fencing_token: 1 }),
    );
    mocks.fakeColl("chat_processing").push(claimDoc("m_c1", { status: "bot_answered", fencing_token: 3 }));
    await buf.flushBuffer("conv_c1", processFn, markProcessed);
    const rows = mocks.fakeColl("buffer_messages").filter((d: any) => d.kind !== "conv_lock");
    assert(rows.length === 0, `terminal-claim row must be deleted, got ${JSON.stringify(rows.map((r: any) => r.status))}`);
    assert(markProcessedCalls.some((m) => m.id === "m_c1" && m.status === "bot_answered"),
      `terminal row must settle message as claim's outcome, got ${JSON.stringify(markProcessedCalls)}`);
  });

  await test("C2 claim ของ owner อื่นที่ยัง active → row คง buffered", async () => {
    seedConv("conv_c2");
    mocks.fakeColl("buffer_messages").push(
      bufferRow("m_c2", "conv_c2", { claim_id: CLAIM_ID("m_c2"), owner_id: "w-other", fencing_token: 7 }),
    );
    mocks.fakeColl("chat_processing").push(claimDoc("m_c2", {
      status: "processing", owner_id: "w-other", fencing_token: 7, conversation_id: "conv_c2",
    }));
    const res = await buf.flushBuffer("conv_c2", processFn, markProcessed);
    const row = mocks.fakeColl("buffer_messages").find((d: any) => d.message_id === "m_c2")!;
    assert(row && row.status === "buffered", `foreign active row must stay buffered, got ${row?.status}`);
    assert(state.calls.callBot === 0, "must not process foreign-owned claim");
    const claim = mocks.fakeColl("chat_processing").find((d: any) => d._id === CLAIM_ID("m_c2"))!;
    assert(claim.owner_id === "w-other" && claim.fencing_token === 7, "foreign claim must not be stolen");
  });

  await test("C3 claimedIds=0 แต่มี retryable rows → ต้อง schedule retry", async () => {
    seedConv("conv_c3");
    rt.botworkerRuntime.flushErrorRetryMs = 40; // ย่อเวลา retry ให้ observe ได้
    mocks.fakeColl("buffer_messages").push(
      bufferRow("m_c3", "conv_c3", { claim_id: CLAIM_ID("m_c3"), owner_id: "w-other", fencing_token: 7 }),
    );
    mocks.fakeColl("chat_processing").push(claimDoc("m_c3", {
      status: "processing", owner_id: "w-other", fencing_token: 7, conversation_id: "conv_c3",
    }));
    let rowOps = 0;
    state.updateOneHook = (coll: string) => { if (coll === "buffer_messages") rowOps++; };
    await buf.flushBuffer("conv_c3", processFn, markProcessed);
    const baseline = rowOps;
    assert(baseline > 0, "setup: first flush must touch row ops");
    await sleep(400); // รอ scheduled retry ยิง flush อีกรอบ
    assert(rowOps > baseline, `no retry scheduled — rowOps stuck at ${baseline}`);
  });

  await test("C4 terminal ปน owned → owned batch สำเร็จ + terminal rows ไม่ค้าง", async () => {
    seedConv("conv_c4");
    mocks.fakeColl("buffer_messages").push(
      bufferRow("m_c4a", "conv_c4", { claim_id: CLAIM_ID("m_c4a"), owner_id: rt.botworkerRuntime.ownerId, fencing_token: 1 }),
      bufferRow("m_c4b", "conv_c4", { claim_id: CLAIM_ID("m_c4b"), owner_id: "w-dead", fencing_token: 2 }),
    );
    mocks.fakeColl("chat_processing").push(
      claimDoc("m_c4a", { conversation_id: "conv_c4" }),                 // owned active
      claimDoc("m_c4b", { conversation_id: "conv_c4", status: "bot_answered", owner_id: "w-dead", fencing_token: 5 }), // terminal
    );
    const res = await buf.flushBuffer("conv_c4", processFn, markProcessed);
    assert(res.status === "buffer_flushed", `owned batch must process, got ${res.status}: ${res.detail}`);
    assert(state.calls.callBot === 1, `callBot=${state.calls.callBot} want 1 — owned member processed once`);
    const rows = mocks.fakeColl("buffer_messages").filter((d: any) => d.kind !== "conv_lock");
    assert(rows.length === 0, `no rows may remain (terminal cleaned + owned finalized), got ${JSON.stringify(rows.map((r: any) => [r.message_id, r.status]))}`);
    assert(markProcessedCalls.some((m) => m.id === "m_c4b"), "terminal row m_c4b must be settled");
  });

  // ── report ───────────────────────────────────────────────

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${pass} passed, ${fail} failed (of ${results.length})`);
  console.log("\n── production modules executed (real, unmocked) ──");
  console.log("  workflowEngine.matchAndRun/resumeFlow  — src/backend/service/workflowEngine.ts");
  console.log("  handoffService.handoffToAdminTest    — src/backend/service/handoffService.ts");
  console.log("  botWorkerService.processMessage      — src/backend/service/botWorkerService.ts");
  console.log("  bufferService.flushBuffer            — src/backend/service/bufferService.ts");
  console.log("  leaf mocks: mongoClient / botCallService / systemConfigService only");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
