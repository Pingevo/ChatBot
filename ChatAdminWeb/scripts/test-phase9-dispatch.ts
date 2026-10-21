// test-phase9-dispatch.ts — Phase 9 single-dispatch ownership contracts
//
// รัน: npx tsx scripts/test-phase9-dispatch.ts
//
// Production modules ทำงานจริงบน fake Mongo:
//   ✅ botWorkerService.processMessage / workflowEngine / triggerService /
//      messageService / botCallService (real — ผ่าน stubbed fetch)
// mock เฉพาะ leaf: mongoClient / systemConfigService
//
// Phase 9 contract — dispatch owner เดียว (processClaimedMessage) ตัดสิน path
// เดียวต่อ claimed message; precedence คงที่ ไม่มี config reorder:
//   ownership gate → active workflow resume → new workflow match → trigger
//   → chatbot fallback → one terminal outcome
//
//   workflow handled/resumed        → trigger 0, bot 0
//   workflow exit_drop              → trigger 0, bot 0 (no_action)
//   workflow exit_to_bot / no_match → trigger → bot (ตามลำดับ)
//   workflow in_flight              → stop, claim ไม่ finalize
//   workflow error recoverable:false→ bot_failed terminal, trigger 0, bot 0
//   trigger match                   → terminal (template/bot_answer/handoff)
//   persisted workflow_priority     → inert — เปลี่ยน runtime order ไม่ได้
//   Test Chat                       → ใช้ shared decision boundary เดียวกัน
//
// RED-honest: cases A2/A3/D15/D16/F29/F30 fail บนโค้ดปัจจุบัน (duplicate
// precedence + resume settle bug) — ที่เหลือเป็น pins ที่ต้องยังเขียวหลังแก้

import { register } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ⚡ register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-phase9-dispatch-hooks.mjs", import.meta.url));

process.env.ADMIN_JWT_SECRET = "verify-only-jwt-nonsecret";
process.env.CHATBOT_INTERNAL_SECRET = "verify-only-internal-nonsecret";
process.env.CHATBOT_BASE_URL_SHOPEE = "http://verify-only-chatbot.invalid";

type Mocks = typeof import("./test-phase9-dispatch-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Rt = typeof import("../src/backend/service/botworkerRuntime");
type Wf = typeof import("../src/backend/service/workflowEngine");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mocks: Mocks;
let svc: Svc;
let rt: Rt;
let wf: Wf;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const results: { name: string; ok: boolean; err?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  await reset();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  }
}

async function reset() {
  await sleep(60);
  mocks.resetState();
  try { await svc.botWorkerService.clearPendingWork(); } catch { /* era may not exist */ }
  installFetchStub();
}

function assert(cond: boolean, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── fetch stub — real callBot ต้องมาเส้นทางนี้เท่านั้น ──────

function installFetchStub() {
  const s = mocks.state;
  const abortErr = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  globalThis.fetch = async (url: any, opts: any = {}) => {
    s.fetchCalls++;
    s.fetchUrls.push(String(url));
    try { s.fetchBodies.push(JSON.parse(opts?.body ?? "null")); } catch { s.fetchBodies.push(null); }
    s.fetchInFlight++;
    if (s.fetchInFlight > s.fetchPeak) s.fetchPeak = s.fetchInFlight;
    try {
      if (opts?.signal?.aborted) throw abortErr();
      if (s.fetchReject) throw s.fetchReject;
      if (s.fetchHang) {
        await new Promise((_, rej) => {
          opts?.signal?.addEventListener("abort", () => rej(abortErr()), { once: true });
        });
        throw abortErr();
      }
      const st = s.fetchResponse?.status ?? 200;
      const body = s.fetchResponse?.body ?? {
        answer: "synthetic bot answer", source: "synthetic", model: "none",
        usage: { prompt: 1, output: 1, total: 2 }, cost: 0,
      };
      return {
        ok: st >= 200 && st < 300,
        status: st,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    } finally {
      s.fetchInFlight--;
    }
  };
}

// ── seeds (pattern เดียวกับ error-policy/boundary suites) ────

function seedConv(conversationId: string, platform = "shopee") {
  mocks.fakeColl("conversations").push({
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform,
    customer_id: "cust_1",
    shop_name: "TestShop",
    status: "open",
    assigned_to: null,
    last_message_at: new Date(),
    last_message_timestamp: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  });
}

let tsSeq = 0;
const nextTs = () => new Date(1_000_000 + ++tsSeq * 1000);

function seedUserMsg(conversationId: string, messageId: string, text: string, extra: Record<string, unknown> = {}) {
  mocks.fakeColl("messages").push({
    message_id: messageId,
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee",
    role: "user",
    direction: "in",
    text,
    created_timestamp: extra.created_timestamp ?? nextTs(),
    ...extra,
  });
}

function seedProcessingClaim(messageId: string, conversationId: string, ctx: { owner_id: string; fencing_token: number }) {
  mocks.fakeColl("chat_processing").push({
    _id: `botworker:claim:${messageId}`,
    message_id: messageId,
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee",
    status: "processing",
    owner_id: ctx.owner_id,
    fencing_token: ctx.fencing_token,
    lease_expires_at: new Date(Date.now() + 120000),
    attempt: 1,
    created_at: new Date(),
  });
}

function makeCtx(messageIds: string[], claimIds?: string[]) {
  const owner = rt.botworkerRuntime.ownerId;
  return {
    claim_id: `botworker:claim:${messageIds[0]}`,
    claim_ids: claimIds || messageIds.map((id) => `botworker:claim:${id}`),
    owner_id: owner,
    fencing_token: 7,
    lease_expires_at: new Date(Date.now() + 120000),
    batch_id: "botworker:batch:" + sha(JSON.stringify(messageIds)).slice(0, 16),
    message_ids: messageIds,
    lost: false,
  };
}

function seedClaimsForCtx(ctx: ReturnType<typeof makeCtx>, conversationId: string) {
  for (const mid of ctx.message_ids) seedProcessingClaim(mid, conversationId, ctx);
}

async function processOne(conversationId: string, mid: string, text: string, extra: Record<string, unknown> = {}) {
  const ctx = makeCtx([mid]);
  seedClaimsForCtx(ctx, conversationId);
  return svc.processMessage({
    message_id: mid, conversation_id: conversationId, shop_id: "shop_1",
    platform: "shopee", text, claimContext: ctx,
    shop_ctx: { config_shop_key: "shop_1", shopname: "shop_1" }, ...extra,
  });
}

const claimDoc = (mid: string) =>
  mocks.fakeColl("chat_processing").find((d: any) => d._id === `botworker:claim:${mid}`);
const repliesIn = (conv: string) =>
  mocks.fakeColl("shadow_replies").filter((d: any) => d.conversation_id === conv);
const runsIn = (conv: string) =>
  mocks.fakeColl("workflow_runs").filter((d: any) => d.conversation_id === conv);
const triggerReads = () => mocks.queriesFor("triggers").length;

// ── workflow / trigger / run seeds ───────────────────────────

function wfBase(id: string, nodes: any[], edges: any[], extra: Record<string, unknown> = {}) {
  return {
    workflow_id: id, name: id, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes, edges,
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
    ...extra,
  };
}
const nd = (node_id: string, type: string, subtype: string, config: Record<string, unknown> = {}) =>
  ({ node_id, type, subtype, config, position: { x: 0, y: 0 } });
const ed = (edge_id: string, s: string, t: string, branch?: string) =>
  ({ edge_id, source_node_id: s, target_node_id: t, ...(branch ? { branch } : {}) });

/** trigger(kw) → send "WF_ANSWER" → จบ (actioned, 1 delivered, 0 fetch) */
function seedWfSend(kw: string) {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push(wfBase("wf_send", [
    nd("t1", "trigger", "message_content", { keywords: [kw] }),
    nd("a1", "action", "send_message", { text: "WF_ANSWER" }),
  ], [ed("e1", "t1", "a1")]));
}

/** trigger(kw) → condition contains "yes" → true: send "WF_DONE" · false→policy */
function seedWfCond(kw: string, policy: "exit_to_bot" | "exit_drop") {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push(wfBase("wf_cond", [
    nd("t1", "trigger", "message_content", { keywords: [kw] }),
    nd("c1", "condition", "message_content", { mode: "contains", text: "yes" }),
    nd("a2", "action", "send_message", { text: "WF_DONE" }),
  ], [ed("e1", "t1", "c1"), ed("e2", "c1", "a2", "true")], { false_branch_policy: policy }));
}

/** trigger → send "MENU" → wait w2 → condition "yes" → true: send "WF_DONE" · false→policy */
function seedWfWaitCond(kw: string, policy: "exit_to_bot" | "exit_drop") {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push(wfBase("wf_wait", [
    nd("t1", "trigger", "message_content", { keywords: [kw] }),
    nd("a1", "action", "send_message", { text: "MENU" }),
    nd("w2", "wait", "wait_for_reply", {}),
    nd("c1", "condition", "message_content", { mode: "contains", text: "yes" }),
    nd("a2", "action", "send_message", { text: "WF_DONE" }),
  ], [ed("e1", "t1", "a1"), ed("e2", "a1", "w2"), ed("e3", "w2", "c1"), ed("e4", "c1", "a2", "true")],
    { false_branch_policy: policy }));
}

/** trigger(kw) → edge ไป node ที่ไม่มีอยู่ → error recoverable:false หลัง run commit */
function seedWfBroken(kw: string) {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push(wfBase("wf_broken", [
    nd("t1", "trigger", "message_content", { keywords: [kw] }),
  ], [ed("e1", "t1", "n_missing")]));
}

/** trigger(kw) → let_ai_respond (bot call ข้างใน workflow stage) */
function seedWfAi(kw: string) {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push(wfBase("wf_ai", [
    nd("t1", "trigger", "message_content", { keywords: [kw] }),
    nd("a1", "action", "let_ai_respond", { prompt: "WF_PROMPT_MARKER" }),
  ], [ed("e1", "t1", "a1")]));
}

/** waiting_for_reply run ที่ wait node w2 (acquirable — ไม่มี owner) */
function seedWaitingRun(conv: string, workflowId: string, waitNodeId = "w2", extra: Record<string, unknown> = {}) {
  mocks.fakeColl("workflow_runs").push({
    run_id: `run_${conv}`, workflow_id: workflowId, workflow_version: 1,
    conversation_id: conv, shop_id: "shop_1", config_shop_key: "shop_1",
    platform: "shopee", status: "waiting_for_reply",
    current_node_id: waitNodeId, waiting_for: "next_message",
    context: {}, test_source: "botworker",
    started_at: new Date(), updated_at: new Date(), ...extra,
  });
}

/** trigger doc (substring keyword match) */
function seedTrigger(opts: { keywords: string[]; action: "bot_answer" | "handoff_admin"; bot_template?: string }) {
  mocks.fakeColl("triggers").push({
    trigger_id: `tr_${opts.keywords[0]}`, name: opts.keywords[0],
    keywords: opts.keywords, shop_ids: [], platforms: [],
    action: opts.action, ...(opts.bot_template ? { bot_template: opts.bot_template } : {}),
    enabled: true, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

// ════════════════════════════════════════════════════════════

async function main() {
  mocks = await import("./test-phase9-dispatch-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  rt = await import("../src/backend/service/botworkerRuntime");
  wf = await import("../src/backend/service/workflowEngine");
  installFetchStub();

  // ═══ A. Active workflow — resume stage ═════════════════════

  await test("A1 active run resumes+actions → workflow once · trigger 0 · bot 0", async () => {
    const conv = "conv_a1";
    seedConv(conv);
    seedUserMsg(conv, "m1", "yes please");
    seedWfWaitCond("wfkw", "exit_to_bot");
    seedWaitingRun(conv, "wf_wait");
    const r = await processOne(conv, "m1", "yes please");
    assert(r.status === "workflow_resumed", `status=${r.status} ${r.detail}`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].bot_reply_text === "WF_DONE" && reps[0].origin === "workflow",
      `replies=${JSON.stringify(reps.map((d: any) => d.bot_reply_text))}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}× — workflow terminal must skip trigger`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    assert(claimDoc("m1")?.status === "workflow_resumed", `claim=${claimDoc("m1")?.status}`);
  });

  await test("A2 active run exit_to_bot → trigger stage checked (template wins) · bot 0 · workflow delivered 0", async () => {
    const conv = "conv_a2";
    seedConv(conv);
    seedUserMsg(conv, "m1", "no trigkw");
    seedWfWaitCond("wfkw", "exit_to_bot");
    seedWaitingRun(conv, "wf_wait");
    seedTrigger({ keywords: ["trigkw"], action: "bot_answer", bot_template: "TRIG_TEMPLATE" });
    const r = await processOne(conv, "m1", "no trigkw");
    assert(r.status === "trigger_matched", `status=${r.status} ${r.detail} — exit_to_bot must continue to trigger`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].bot_reply_text === "TRIG_TEMPLATE" && reps[0].origin === "worker",
      `replies=${JSON.stringify(reps.map((d: any) => [d.origin, d.bot_reply_text]))} — exit_to_bot delivered must not persist`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    const run = runsIn(conv)[0];
    assert(run?.status === "cancelled", `run=${run?.status} — exit_to_bot cancels the flow`);
  });

  await test("A3 active run exit_drop → no_action terminal · trigger 0 · bot 0 · reply 0", async () => {
    const conv = "conv_a3";
    seedConv(conv);
    seedUserMsg(conv, "m1", "no thanks");
    seedWfWaitCond("wfkw", "exit_drop");
    seedWaitingRun(conv, "wf_wait");
    seedTrigger({ keywords: ["thanks"], action: "bot_answer", bot_template: "TRIG" });
    const r = await processOne(conv, "m1", "no thanks");
    assert(r.status === "workflow_exit_drop",
      `status=${r.status} ${r.detail} — exit_drop must be terminal no_action`);
    assert(claimDoc("m1")?.status === "no_action", `claim=${claimDoc("m1")?.status}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}× — exit_drop must skip trigger`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    assert(repliesIn(conv).length === 0, "exit_drop must not persist replies");
  });

  await test("A4 active run in_flight → stop non-terminal · trigger 0 · bot 0 · claim stays processing", async () => {
    const conv = "conv_a4";
    seedConv(conv);
    seedUserMsg(conv, "m1", "yes");
    seedWfWaitCond("wfkw", "exit_to_bot");
    seedWaitingRun(conv, "wf_wait", "w2", {
      status: "running", owner_id: "other-worker", fencing_token: 3,
      lease_expires_at: new Date(Date.now() + 120000),
    });
    const r = await processOne(conv, "m1", "yes");
    assert(r.status === "in_flight", `status=${r.status} ${r.detail}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}×`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    assert(claimDoc("m1")?.status === "processing", `claim=${claimDoc("m1")?.status} — in_flight must not finalize`);
    assert(repliesIn(conv).length === 0, "phantom reply");
  });

  await test("A5 active run non-recoverable error (workflow deleted) → bot_failed · trigger 0 · bot 0", async () => {
    const conv = "conv_a5";
    seedConv(conv);
    seedUserMsg(conv, "m1", "yes");
    mocks.state.config.workflow_enabled = true;
    seedWaitingRun(conv, "wf_deleted"); // run ชี้ workflow ที่ไม่มี doc → doResumeFlow error
    const r = await processOne(conv, "m1", "yes");
    assert(r.status === "bot_failed", `status=${r.status} ${r.detail}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}× — terminal error must skip trigger`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    assert(claimDoc("m1")?.status === "bot_failed", `claim=${claimDoc("m1")?.status}`);
  });

  // ═══ B. New workflow — match stage ═════════════════════════

  await test("B6 workflow match actions → workflow once · trigger 0 · bot 0", async () => {
    const conv = "conv_b6";
    seedConv(conv);
    seedUserMsg(conv, "m1", "wfkw please");
    seedWfSend("wfkw");
    seedTrigger({ keywords: ["wfkw"], action: "bot_answer", bot_template: "TRIG" });
    const r = await processOne(conv, "m1", "wfkw please");
    assert(r.status === "workflow_actioned", `status=${r.status} ${r.detail}`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].bot_reply_text === "WF_ANSWER" && reps[0].origin === "workflow",
      `replies=${JSON.stringify(reps.map((d: any) => [d.origin, d.bot_reply_text]))}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}× — workflow terminal must skip trigger`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
  });

  await test("B7 workflow no-match → trigger checked once (template) · bot 0", async () => {
    const conv = "conv_b7";
    seedConv(conv);
    seedUserMsg(conv, "m1", "trigkw hello");
    seedWfSend("otherkw"); // workflow exists แต่ keyword ไม่แมทช์
    seedTrigger({ keywords: ["trigkw"], action: "bot_answer", bot_template: "TRIG_TEMPLATE" });
    const r = await processOne(conv, "m1", "trigkw hello");
    assert(r.status === "trigger_matched", `status=${r.status} ${r.detail}`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].bot_reply_text === "TRIG_TEMPLATE",
      `replies=${JSON.stringify(reps.map((d: any) => d.bot_reply_text))}`);
    assert(triggerReads() === 1, `trigger queried ${triggerReads()}× want 1`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    assert(runsIn(conv).length === 0, "run created for non-matching message");
  });

  await test("B8 workflow exit_to_bot + trigger miss → fallback bot once · shadow once", async () => {
    const conv = "conv_b8";
    seedConv(conv);
    seedUserMsg(conv, "m1", "wfkw no");
    seedWfCond("wfkw", "exit_to_bot"); // condition "yes" false บนข้อความแรก
    const r = await processOne(conv, "m1", "wfkw no");
    assert(r.status === "bot_answered", `status=${r.status} ${r.detail}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls} want 1`);
    assert(triggerReads() === 1, `trigger queried ${triggerReads()}× want 1`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].origin === "worker" && reps[0].bot_reply_text === "synthetic bot answer",
      `replies=${JSON.stringify(reps.map((d: any) => [d.origin, d.bot_reply_text]))}`);
    const run = runsIn(conv)[0];
    assert(run?.status === "cancelled", `run=${run?.status} — exit_to_bot cancels flow`);
  });

  await test("B9 [source pin] dispatcher gates on typed recoverable===false · no recoverable:true producers", async () => {
    const worker = readFileSync(new URL("../src/backend/service/botWorkerService.ts", import.meta.url), "utf8");
    const engine = readFileSync(new URL("../src/backend/service/workflowEngine.ts", import.meta.url), "utf8");
    // contract: error fall through เฉพาะเมื่อ typed evidence บอก zero committed side effects
    //   — producer ปัจจุบันทั้งหมด recoverable:false (matched-path death) ดังนั้น arm
    //   recoverable:true เป็น type-space เท่านั้น; pin ทั้งสองฝั่งกัน regression
    // ⚡ Phase 9 — gate ย้ายเข้า runInboundDispatch (owner เดียวใน engine)
    assert(/recoverable === false/.test(engine), "dispatch owner must gate on typed recoverable===false");
    assert(/runInboundDispatch/.test(worker), "worker must delegate precedence to the shared owner");
    assert(!/recoverable:\s*true/.test(engine), "engine must not emit recoverable:true without zero-side-effect evidence");
  });

  await test("B10 workflow error after committed run (broken graph) → bot_failed · trigger 0 · bot 0", async () => {
    const conv = "conv_b10";
    seedConv(conv);
    seedUserMsg(conv, "m1", "wfkw broken");
    seedWfBroken("wfkw");
    seedTrigger({ keywords: ["wfkw"], action: "bot_answer", bot_template: "TRIG" });
    const r = await processOne(conv, "m1", "wfkw broken");
    assert(r.status === "bot_failed", `status=${r.status} ${r.detail} — committed-side-effect error must not fall through`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}×`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    const run = runsIn(conv)[0];
    assert(run && run.status === "errored", `run=${run?.status} — failed run must persist errored evidence`);
    assert(claimDoc("m1")?.status === "bot_failed", `claim=${claimDoc("m1")?.status}`);
  });

  // ═══ C. Trigger stage ═════════════════════════════════════

  await test("C11 trigger template → one shadow reply · bot 0", async () => {
    const conv = "conv_c11";
    seedConv(conv);
    seedUserMsg(conv, "m1", "trigkw");
    seedTrigger({ keywords: ["trigkw"], action: "bot_answer", bot_template: "TRIG_TEMPLATE" });
    const r = await processOne(conv, "m1", "trigkw");
    assert(r.status === "trigger_matched", `status=${r.status}`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls} — template must not call bot`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].bot_reply_text === "TRIG_TEMPLATE" && reps[0].bot_source === "trigger_bot_answer",
      `replies=${JSON.stringify(reps.map((d: any) => [d.bot_source, d.bot_reply_text]))}`);
    assert(claimDoc("m1")?.status === "trigger_matched");
  });

  await test("C12 trigger handoff → one handoff · bot 0 · reply 0", async () => {
    const conv = "conv_c12";
    seedConv(conv);
    seedUserMsg(conv, "m1", "handoffkw");
    mocks.fakeColl("admins").push({ admin_id: "a1", username: "a1", role: "admin", is_active: true });
    seedTrigger({ keywords: ["handoffkw"], action: "handoff_admin" });
    const r = await processOne(conv, "m1", "handoffkw");
    assert(r.status === "handed_off", `status=${r.status} ${r.detail}`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    assert(repliesIn(conv).length === 0, "handoff must not write reply");
    const tdoc = mocks.fakeColl("test_status_conversation").find((d: any) => d.conversation_id === conv && d.source === "botworker");
    assert(tdoc?.assigned_to === "a1", `assigned_to=${tdoc?.assigned_to}`);
  });

  await test("C13 trigger bot_answer (no template) → chatbot once + shadow once", async () => {
    const conv = "conv_c13";
    seedConv(conv);
    seedUserMsg(conv, "m1", "botkw");
    seedTrigger({ keywords: ["botkw"], action: "bot_answer" });
    const r = await processOne(conv, "m1", "botkw");
    assert(r.status === "trigger_matched", `status=${r.status} ${r.detail}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls} want 1`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].bot_reply_text === "synthetic bot answer",
      `replies=${reps.length} — exactly one shadow reply`);
  });

  await test("C14 trigger miss → generic chatbot fallback once + shadow once", async () => {
    const conv = "conv_c14";
    seedConv(conv);
    seedUserMsg(conv, "m1", "hello there");
    const r = await processOne(conv, "m1", "hello there");
    assert(r.status === "bot_answered", `status=${r.status} ${r.detail}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls} want 1`);
    assert(triggerReads() === 1, `trigger queried ${triggerReads()}× want 1`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].bot_reply_text === "synthetic bot answer" && reps[0].origin === "worker");
  });

  // ═══ D. Duplicate prevention ══════════════════════════════

  await test("D15 persisted priority='both' → workflow terminal · trigger 0 · replies exactly 1 (no double answer)", async () => {
    const conv = "conv_d15";
    seedConv(conv);
    seedUserMsg(conv, "m1", "wfkw trigkw");
    seedWfSend("wfkw");
    mocks.state.config.workflow_priority = "both";
    seedTrigger({ keywords: ["trigkw"], action: "bot_answer", bot_template: "TRIG_TEMPLATE" });
    const r = await processOne(conv, "m1", "wfkw trigkw");
    assert(r.status === "workflow_actioned", `status=${r.status} ${r.detail} — workflow must be terminal even under 'both'`);
    const reps = repliesIn(conv);
    assert(reps.length === 1, `replies=${reps.length} want 1 — 'both' must not double-answer: ${JSON.stringify(reps.map((d: any) => [d.origin, d.bot_reply_text]))}`);
    assert(reps[0].origin === "workflow", `reply origin=${reps[0].origin}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}× — fixed order must not reach trigger`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
  });

  await test("D16 persisted priority='trigger_first' → workflow still outranks trigger (fixed order)", async () => {
    const conv = "conv_d16";
    seedConv(conv);
    seedUserMsg(conv, "m1", "wfkw trigkw");
    seedWfSend("wfkw");
    mocks.state.config.workflow_priority = "trigger_first";
    seedTrigger({ keywords: ["trigkw"], action: "bot_answer", bot_template: "TRIG_TEMPLATE" });
    const r = await processOne(conv, "m1", "wfkw trigkw");
    assert(r.status === "workflow_actioned", `status=${r.status} ${r.detail} — 'trigger_first' must not reorder runtime`);
    const reps = repliesIn(conv);
    assert(reps.length === 1 && reps[0].origin === "workflow",
      `replies=${JSON.stringify(reps.map((d: any) => [d.origin, d.bot_reply_text]))}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}× — workflow handled before trigger stage`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
  });

  await test("D17 same message processed twice → at most one answer-producing dispatch", async () => {
    const conv = "conv_d17";
    seedConv(conv);
    seedUserMsg(conv, "m1", "hello dup");
    const args = {
      message_id: "m1", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee" as const, text: "hello dup",
      shop_ctx: { config_shop_key: "shop_1", shopname: "shop_1" },
    };
    const r1 = await svc.processMessage(args);
    assert(r1.status === "bot_answered", `r1=${r1.status} ${r1.detail}`);
    // รอบสองผ่าน claimMessage — claim terminal แล้ว → finalized-only ไม่ dispatch ซ้ำ
    const r2 = await svc.processMessage(args);
    assert(r2.status === "skip", `r2 should short-circuit at claim gate, got ${JSON.stringify(r2)}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls} — second call must not re-dispatch (r2=${r2.status})`);
    assert(repliesIn(conv).length === 1, `replies=${repliesIn(conv).length}`);
  });

  await test("D18 pre-terminal claim (recovery evidence) → no re-execution · no new side effects", async () => {
    const conv = "conv_d18";
    seedConv(conv);
    seedUserMsg(conv, "m1", "hello term");
    const args = {
      message_id: "m1", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee" as const, text: "hello term",
      shop_ctx: { config_shop_key: "shop_1", shopname: "shop_1" },
    };
    await svc.processMessage(args);
    assert(claimDoc("m1")?.status === "bot_answered");
    const repsBefore = repliesIn(conv).length;
    const fetchBefore = mocks.state.fetchCalls;
    // recovery re-poll เห็น claim เดิม — ต้องไม่ยิง dispatch ซ้ำ
    const r = await svc.processMessage(args);
    assert(r.status === "skip", `recovery should resolve at claim gate (r=${r.status})`);
    assert(mocks.state.fetchCalls === fetchBefore, `fetch grew — recovered claim re-dispatched (r=${r.status})`);
    assert(repliesIn(conv).length === repsBefore, "recovery must reuse evidence not re-persist");
    assert(runsIn(conv).length === 0, "recovery must not create workflow runs");
  });

  await test("D19 buffered multi-message turn → one dispatch · one reply", async () => {
    const conv = "conv_d19";
    seedConv(conv);
    seedUserMsg(conv, "m1", "first part");
    seedUserMsg(conv, "m2", "second part");
    const ctx = makeCtx(["m1", "m2"]);
    seedClaimsForCtx(ctx, conv);
    const r = await svc.processMessage({
      message_id: "m1", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee", text: "first part\nsecond part", claimContext: ctx,
      shop_ctx: { config_shop_key: "shop_1", shopname: "shop_1" },
    });
    assert(r.status === "bot_answered", `status=${r.status}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls} want 1 — batch = one dispatch`);
    assert(repliesIn(conv).length === 1, `replies=${repliesIn(conv).length}`);
  });

  await test("D20 active admin ownership → workflow/trigger/bot all 0 (gate runs first)", async () => {
    const conv = "conv_d20";
    seedConv(conv);
    seedUserMsg(conv, "m1", "wfkw trigkw hello");
    seedWfSend("wfkw");
    seedTrigger({ keywords: ["trigkw"], action: "bot_answer", bot_template: "TRIG" });
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: conv, source: "botworker", status: "open",
      assigned_to: "admin_1", updated_at: new Date(),
    });
    const r = await processOne(conv, "m1", "wfkw trigkw hello");
    assert(r.status === "skip_assigned", `status=${r.status} ${r.detail}`);
    assert(mocks.state.fetchCalls === 0, `fetch=${mocks.state.fetchCalls}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}×`);
    assert(repliesIn(conv).length === 0, "phantom reply under admin ownership");
    assert(runsIn(conv).every((d: any) => d.status === "cancelled"), "active runs must be cancelled not executed");
    assert(claimDoc("m1")?.status === "no_action",
      `claim=${claimDoc("m1")?.status} — skip outcome must finalize as no_action (terminal)`);
  });

  // ═══ E. Input / scope parity ═══════════════════════════════

  await test("E21 text input → bot once + shadow once", async () => {
    const conv = "conv_e21";
    seedConv(conv);
    seedUserMsg(conv, "m1", "plain text question");
    const r = await processOne(conv, "m1", "plain text question");
    assert(r.status === "bot_answered" && mocks.state.fetchCalls === 1, `status=${r.status} fetch=${mocks.state.fetchCalls}`);
    assert(repliesIn(conv).length === 1);
  });

  await test("E22 image input → bot once (images forwarded) + shadow once", async () => {
    const conv = "conv_e22";
    seedConv(conv);
    const rp = { message_type: "image", content: { url: "https://img.example.com/e22.png" } };
    seedUserMsg(conv, "m1", "", { raw_payload: rp });
    const r = await processOne(conv, "m1", "", { raw_payload: rp });
    assert(r.status === "bot_answered", `status=${r.status} ${r.detail}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls}`);
    assert((mocks.state.fetchBodies[0]?.images || []).includes("https://img.example.com/e22.png"),
      `images=${JSON.stringify(mocks.state.fetchBodies[0]?.images)}`);
    assert(repliesIn(conv).length === 1);
  });

  await test("E23 image_text input → bot once + shadow once", async () => {
    const conv = "conv_e23";
    seedConv(conv);
    const rp = { message_type: "image_with_text", content: { text: "what is this", image_url: "https://img.example.com/e23.png" } };
    seedUserMsg(conv, "m1", "what is this", { raw_payload: rp });
    const r = await processOne(conv, "m1", "what is this", { raw_payload: rp });
    assert(r.status === "bot_answered" && mocks.state.fetchCalls === 1, `status=${r.status}`);
    assert(mocks.state.fetchBodies[0]?.message === "what is this", `message=${mocks.state.fetchBodies[0]?.message}`);
    assert((mocks.state.fetchBodies[0]?.images || []).includes("https://img.example.com/e23.png"));
    assert(repliesIn(conv).length === 1);
  });

  await test("E24 video input → bot once + shadow once", async () => {
    const conv = "conv_e24";
    seedConv(conv);
    const rp = { message_type: "video", content: { video_url: "https://vid.example.com/e24.mp4" } };
    seedUserMsg(conv, "m1", "", { raw_payload: rp });
    const r = await processOne(conv, "m1", "", { raw_payload: rp });
    assert(r.status === "bot_answered" && mocks.state.fetchCalls === 1, `status=${r.status} fetch=${mocks.state.fetchCalls}`);
    assert((mocks.state.fetchBodies[0]?.images || []).includes("https://vid.example.com/e24.mp4"),
      `video url must reach images field`);
    assert(repliesIn(conv).length === 1);
  });

  await test("E25 item card input → bot once + shadow once (product tag in message)", async () => {
    const conv = "conv_e25";
    seedConv(conv);
    const rp = { message_type: "item", content: { item_id: "12345" } };
    seedUserMsg(conv, "m1", "[item]", { raw_payload: rp });
    const r = await processOne(conv, "m1", "[item]", { raw_payload: rp });
    assert(r.status === "bot_answered" && mocks.state.fetchCalls === 1, `status=${r.status}`);
    assert(String(mocks.state.fetchBodies[0]?.message || "").includes("12345"),
      `message=${mocks.state.fetchBodies[0]?.message} — item tag must reach bot`);
    assert(repliesIn(conv).length === 1);
  });

  await test("E26 workflow_enabled=false → zero workflow stage reads · trigger→bot", async () => {
    const conv = "conv_e26";
    seedConv(conv);
    seedUserMsg(conv, "m1", "hello");
    mocks.state.config.workflow_enabled = false;
    const r = await processOne(conv, "m1", "hello");
    assert(r.status === "bot_answered", `status=${r.status}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls}`);
    assert(triggerReads() === 1, `trigger queried ${triggerReads()}× want 1`);
    assert(mocks.queriesFor("workflow_runs").length === 0,
      `workflow_runs queried ${mocks.queriesFor("workflow_runs").length}× — disabled workflow must skip stage entirely`);
  });

  await test("E27 missing shop_ctx → fail closed (processMessage rejects)", async () => {
    const conv = "conv_e27";
    seedConv(conv);
    seedUserMsg(conv, "m1", "hello");
    const ctx = makeCtx(["m1"]);
    seedClaimsForCtx(ctx, conv);
    let threw = false;
    try {
      await svc.processMessage({
        message_id: "m1", conversation_id: conv, shop_id: "shop_1",
        platform: "shopee", text: "hello", claimContext: ctx,
      } as any);
    } catch (e: any) {
      threw = /shop_ctx/.test(e?.message || "");
    }
    assert(threw, "processMessage must reject missing shop_ctx");
    assert(mocks.state.fetchCalls === 0, "closed failure must not call bot");
  });

  await test("E28 shadow output records delivered_to_platform=false", async () => {
    const conv = "conv_e28";
    seedConv(conv);
    seedUserMsg(conv, "m1", "hello shadow");
    await processOne(conv, "m1", "hello shadow");
    const reps = repliesIn(conv);
    assert(reps.length === 1, `replies=${reps.length}`);
    const evts = mocks.fakeColl("botworker_events").filter(
      (d: any) => d.type === "bot_reply" && d.conversation_id === conv);
    assert(evts.length >= 1, "bot_reply event missing");
    assert(evts.every((d: any) => d.metadata?.delivered_to_platform === false),
      `events=${JSON.stringify(evts.map((d: any) => d.metadata))}`);
  });

  // ═══ F. shared dispatch owner — executable parity ══════════
  // runInboundDispatch = owner เดียวกันที่ bot-worker + Test Chat ใช้ —
  // leaf spies นับ invocation เพื่อพิสูจน์ precedence + exactly-one-outcome

  const leafSpies = () => {
    const calls = { handled: 0, drop: 0, err: 0, inflight: 0, trig: 0, bot: 0 };
    const leaves = {
      workflowHandled: () => { calls.handled++; return "handled"; },
      workflowExitDrop: () => { calls.drop++; return "drop"; },
      workflowError: () => { calls.err++; return "err"; },
      workflowInFlight: () => { calls.inflight++; return "inflight"; },
      triggerMatched: () => { calls.trig++; return "trig"; },
      botFallback: () => { calls.bot++; return "bot"; },
    };
    const total = () => calls.handled + calls.drop + calls.err + calls.inflight + calls.trig + calls.bot;
    return { calls, leaves, total };
  };
  const dispatchMsg = (conv: string, text: string) => ({
    message_id: `dm_${conv}`, conversation_id: conv, shop_id: "shop_1",
    config_shop_key: "shop_1", platform: "shopee" as const, text,
    operation_key: `op_${conv}`,
  });

  await test("F29 workflow action → handled once · trigger 0 · bot 0 · one outcome", async () => {
    const conv = "conv_f29";
    seedConv(conv);
    seedWfSend("wfkw");
    seedTrigger({ keywords: ["wfkw"], action: "bot_answer", bot_template: "TRIG" });
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "wfkw please"), "wfkw please", leaves);
    assert(out === "handled" && calls.handled === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(calls.trig === 0 && calls.bot === 0 && total() === 1, `calls=${JSON.stringify(calls)}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}× — handled must short-circuit`);
    assert(runsIn(conv).length === 1, `runs=${runsIn(conv).length}`);
  });

  await test("F30 new workflow exit_to_bot → trigger 1 · bot 0 (trigger seeded)", async () => {
    const conv = "conv_f30";
    seedConv(conv);
    seedWfCond("wfkw", "exit_to_bot"); // "wfkw no" → trigger kw match → condition "yes" fail → exit_to_bot
    seedTrigger({ keywords: ["no"], action: "bot_answer", bot_template: "TRIG" });
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "wfkw no"), "wfkw no", leaves);
    assert(out === "trig" && calls.trig === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(calls.bot === 0 && calls.handled === 0 && total() === 1, `calls=${JSON.stringify(calls)}`);
    assert(runsIn(conv).length === 1, `workflow stage must have run — runs=${runsIn(conv).length}`);
    assert(triggerReads() === 1, `trigger queried ${triggerReads()}×`);
  });

  await test("F31 new workflow exit_to_bot + trigger miss → bot 1", async () => {
    const conv = "conv_f31";
    seedConv(conv);
    seedWfCond("wfkw", "exit_to_bot");
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "wfkw no"), "wfkw no", leaves);
    assert(out === "bot" && calls.bot === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(calls.trig === 0 && calls.handled === 0 && total() === 1, `calls=${JSON.stringify(calls)}`);
    assert(runsIn(conv).length === 1, `workflow stage must have run — runs=${runsIn(conv).length}`);
    assert(triggerReads() === 1, `trigger queried ${triggerReads()}×`);
  });

  await test("F32 workflow miss + trigger miss → bot 1 · one outcome", async () => {
    const conv = "conv_f32";
    seedConv(conv);
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "hello"), "hello", leaves);
    assert(out === "bot" && calls.bot === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(triggerReads() === 1 && total() === 1, `triggerReads=${triggerReads()} calls=${JSON.stringify(calls)}`);
  });

  await test("F33 workflow exit_drop → drop terminal · trigger 0 · bot 0", async () => {
    const conv = "conv_f33";
    seedConv(conv);
    seedWfCond("wfkw", "exit_drop");
    seedTrigger({ keywords: ["no"], action: "bot_answer", bot_template: "TRIG" });
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "wfkw no"), "wfkw no", leaves);
    assert(out === "drop" && calls.drop === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(calls.trig === 0 && calls.bot === 0 && total() === 1, `calls=${JSON.stringify(calls)}`);
    assert(runsIn(conv).length === 1, `workflow stage must have run — runs=${runsIn(conv).length}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}×`);
  });

  await test("F34 resume in_flight → inflight stop · trigger 0 · bot 0", async () => {
    const conv = "conv_f34";
    seedConv(conv);
    seedWfWaitCond("wfkw", "exit_to_bot");
    seedWaitingRun(conv, "wf_wait", "w2", {
      status: "running", owner_id: "other-worker", fencing_token: 3,
      lease_expires_at: new Date(Date.now() + 120000),
    });
    seedTrigger({ keywords: ["yes"], action: "bot_answer", bot_template: "TRIG" });
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "yes"), "yes", leaves);
    assert(out === "inflight" && calls.inflight === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(calls.trig === 0 && calls.bot === 0 && total() === 1, `calls=${JSON.stringify(calls)}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}×`);
  });

  await test("F35 non-recoverable workflow error → error leaf · trigger 0 · bot 0", async () => {
    const conv = "conv_f35";
    seedConv(conv);
    seedWfBroken("wfkw");
    seedTrigger({ keywords: ["wfkw"], action: "bot_answer", bot_template: "TRIG" });
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "wfkw please"), "wfkw please", leaves);
    assert(out === "err" && calls.err === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(calls.trig === 0 && calls.bot === 0 && total() === 1, `calls=${JSON.stringify(calls)}`);
    assert(triggerReads() === 0, `trigger queried ${triggerReads()}×`);
  });

  await test("F36 resume exit_to_bot → trigger · NO second matchAndRun (run เดิมอาจยังอยู่)", async () => {
    const conv = "conv_f36";
    seedConv(conv);
    seedWfWaitCond("wfkw", "exit_to_bot");
    seedWaitingRun(conv, "wf_wait", "w2");
    // workflow ที่ "no" match ได้ถ้า matchAndRun ถูกเรียกผิด — ห้ามเกิด run ใหม่
    seedWfSend("no");
    seedTrigger({ keywords: ["no"], action: "bot_answer", bot_template: "TRIG" });
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "no"), "no", leaves);
    assert(out === "trig" && calls.trig === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(calls.handled === 0 && calls.bot === 0 && total() === 1, `calls=${JSON.stringify(calls)}`);
    const newRuns = runsIn(conv).filter((d: any) => d.workflow_id === "wf_send");
    assert(newRuns.length === 0, `matchAndRun ran after exit_to_bot — runs=${JSON.stringify(runsIn(conv).map((d: any) => [d.workflow_id, d.status]))}`);
    assert(triggerReads() === 1, `trigger queried ${triggerReads()}×`);
  });

  await test("F37 resume no_match (run จบระหว่างทาง) → matchAndRun ต่อได้", async () => {
    const conv = "conv_f37";
    seedConv(conv);
    seedWfWaitCond("wfkw", "exit_to_bot");
    seedWaitingRun(conv, "wf_wait", "w2");
    seedWfSend("hello"); // workflow ใหม่ที่ข้อความนี้ match ได้
    // resumeFlow อ่าน run ซ้ำตอน acquire → flip เป็น completed → resume no_match → matchAndRun
    let reads = 0;
    mocks.state.findOneHook = async (coll: string, filter: any) => {
      if (coll !== "workflow_runs" || !filter?.run_id) return;
      if (++reads === 1) {
        const run = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === filter.run_id);
        if (run) { run.status = "completed"; }
      }
    };
    const { calls, leaves, total } = leafSpies();
    const out = await wf.runInboundDispatch(dispatchMsg(conv, "hello"), "hello", leaves);
    assert(out === "handled" && calls.handled === 1, `out=${out} calls=${JSON.stringify(calls)}`);
    assert(total() === 1, `calls=${JSON.stringify(calls)}`);
    const newRuns = runsIn(conv).filter((d: any) => d.workflow_id === "wf_send");
    assert(newRuns.length === 1, `expected matchAndRun to create wf_send run — runs=${JSON.stringify(runsIn(conv).map((d: any) => [d.workflow_id, d.status]))}`);
  });

  await test("F38 [source pin] dispatch route delegates to shared owner · client single request · no phase/priority copy", async () => {
    const route = readFileSync(new URL("../src/app/api/test-chat/dispatch/route.ts", import.meta.url), "utf8");
    assert(/runInboundDispatch/.test(route), "dispatch route must call the shared owner");
    assert(!/workflow_priority/.test(route), "route must not read workflow_priority");
    assert(!/["'`]phase["'`]?/.test(route), "route must not take a phase param");
    assert(!/getActiveRun|resumeFlow|matchAndRun\(/.test(route), "route must not re-implement workflow stage");
    const client = readFileSync(new URL("../src/components/chat/TestChatClient.tsx", import.meta.url), "utf8");
    assert(!/after_trigger/.test(client), "client must not keep after_trigger (trigger_first)");
    assert(!/test-chat\/workflow-step|test-chat\/flush|triggers\/match/.test(client),
      "client must not call the old orchestration chain");
    const dispatchCalls = client.match(/test-chat\/dispatch/g) || [];
    assert(dispatchCalls.length === 1, `client must call dispatch exactly once, found ${dispatchCalls.length}`);
    const deleted = ["workflow-step", "flush"];
    for (const dir of deleted) {
      let exists = true;
      try { readFileSync(new URL(`../src/app/api/test-chat/${dir}/route.ts`, import.meta.url)); }
      catch { exists = false; }
      assert(!exists, `old test-chat/${dir} route must be deleted`);
    }
  });

  // ── summary ────────────────────────────────────────────────

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);
  if (failed > 0) {
    console.log("\nfailed cases:");
    for (const r of results.filter((r) => !r.ok)) console.log(`  ✗ ${r.name}\n      ${r.err}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
