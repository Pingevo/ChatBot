// test-botworker-error-policy.ts — BW-4 error/carry-forward + BW-5 concurrency contracts
//
// รัน: npx tsx scripts/test-botworker-error-policy.ts
//
// Production modules ทำงานจริงบน fake Mongo:
//   ✅ botWorkerService / workflowEngine / messageService / **botCallService (real)**
// mock เฉพาะ leaf: mongoClient / systemConfigService
// fetch → stub (นับ + status/reject/hang/gate) — provider จริง = 0
//
// BW-4 contract (error → terminal, carry-forward history):
//   429/500/timeout/network → fetch 1 ครั้ง → claim bot_failed → ไม่ retry
//   ไม่ auto-handoff · ไม่มี phantom reply · poll ซ้ำไม่ยิงซ้ำ
//   new inbound → fetch เพิ่ม 1 · failed inbound ใน history ครั้งเดียว · current ไม่ซ้ำ
//
// BW-5 contract (single outbound concurrency owner):
//   ทุก botworker outbound (direct/trigger/workflow) ผ่าน limiter เดียว
//   queued call ที่ signal abort → ออกโดยไม่เรียก fetch · limit ลด → drain ไม่ admit
//   non-botworker callers ไม่เปลี่ยน behavior

import { register } from "node:module";
import { createHash } from "node:crypto";

// ⚡ register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-botworker-error-policy-hooks.mjs", import.meta.url));

// ⚡ strict env ของ lib/config ผูกตอน module eval — ตั้ง test-local constants
//    ก่อน import ใดๆ (pattern เดียวกับ verify-botworker-runtime-mongo.ts; ไม่มี .env)
process.env.ADMIN_JWT_SECRET = "verify-only-jwt-nonsecret";
process.env.CHATBOT_INTERNAL_SECRET = "verify-only-internal-nonsecret";
process.env.CHATBOT_BASE_URL_SHOPEE = "http://verify-only-chatbot.invalid";
const EXPECTED_CHAT_URL = "http://verify-only-chatbot.invalid/chat";

type Mocks = typeof import("./test-botworker-error-policy-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Rt = typeof import("../src/backend/service/botworkerRuntime");
type BotCall = typeof import("../src/backend/service/botCallService");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mocks: Mocks;
let svc: Svc;
let rt: Rt;
let botCall: BotCall["callBot"];
// ⚡ Phase 2D — required cycle-scope snapshot (fixtures ทั้งหมดอยู่ใน shop_1/shopee)
let SCOPE: import("../src/backend/service/botworkerRuntime").BotworkerCycleScope;

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
  // ⚡ drain leaked gated fetches ของ test ก่อน — admitted fetch ที่ค้าง gate ต้อง
  //   settle ก่อน มิฉะนั้น limiter slot รั่วไป test ถัดไป (module state ค้างข้าม test)
  releaseGate(999);
  await sleep(60);
  mocks.resetState();
  try { await svc.botWorkerService.clearPendingWork(); } catch { /* era may not exist */ }
  installFetchStub();
}

function assert(cond: boolean, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── fetch stub — real callBot ต้องมาเส้นทางนี้เท่านั้น ──────
// นับ invocation + in-flight peak + gate (hold จน test ปล่อย)
// modes: fetchResponse(200/4xx/5xx) · fetchReject(network error) · fetchHang(abort-aware)

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
        throw abortErr(); // unreachable — hang จบที่ abort เท่านั้น
      }
      if (s.fetchGate) {
        if (s.gateReleased > 0) s.gateReleased--;
        else await new Promise<void>((r) => s.gateResolvers.push(r));
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

/** เพิ่ม quota ปล่อย fetch n ครั้ง — resolver ที่ push ทีหลังผ่านได้ทันที (ไม่พึ่ง timing) */
function releaseGate(n = 1) {
  const s = mocks.state;
  s.gateReleased += n;
  while (s.gateReleased > 0 && s.gateResolvers.length) {
    s.gateResolvers.shift()!();
    s.gateReleased--;
  }
}

// ── seeds (pattern เดียวกับ boundary suite) ─────────────────

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
const callParams = () => mocks.state; // fetch counters live on state

/** poll cond จนจริงหรือหมดเวลา (deterministic wait — ไม่พึ่ง sleep เดี่ยว) */
async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return;
    await sleep(15);
  }
}

/** pause fake-mongo write ชนิดเดียวกลางทาง — persist boundary gate (kill-switch post-response)
 *  คืน release() — เรียกเพื่อปล่อย write ให้เดินต่อ */
function pauseQuery(coll: string, op: string): () => void {
  let release!: () => void;
  mocks.state.queryPause = { coll, op, promise: new Promise<void>((r) => (release = r)) };
  return release;
}

/** seed workflow ที่ trigger("wfkw") → let_ai_respond (pattern เดียวกับ E7 boundary) */
function seedAiWorkflow() {
  mocks.state.config.workflow_enabled = true;
  mocks.state.config.workflow_priority = "workflow_first";
  mocks.fakeColl("workflows").push({
    workflow_id: "wf_ai", name: "wf_ai", enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: ["wfkw"] }, position: { x: 0, y: 0 } },
      // ⚡ prompt marker — let_ai_respond ส่ง promptPrefix+text → fetch body ต้องขึ้นต้น
      //    ด้วย marker (หลักฐานว่า workflow path จริง ไม่ใช่ direct fallback)
      { node_id: "n2", type: "action", subtype: "let_ai_respond", config: { prompt: "WF_PROMPT_MARKER" }, position: { x: 0, y: 0 } },
    ],
    edges: [{ edge_id: "e1", source_node_id: "n1", target_node_id: "n2" }],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

const wc = { platform: "shopee" as const, shopId: "shop_1", history: [] as any[], testSource: "botworker" };

// ════════════════════════════════════════════════════════════

async function main() {
  mocks = await import("./test-botworker-error-policy-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  rt = await import("../src/backend/service/botworkerRuntime");
  botCall = (await import("../src/backend/service/botCallService")).callBot;
  SCOPE = { config: mocks.state.config as never, global_enabled_since: new Date(0), pairs: [{ platform: "shopee", shop_id: "shop_1", config_shop_key: "shop_1", shopname: "shop_1", cutoff: new Date(0) }] };
  installFetchStub();

  // ═══ BW-4: HTTP error mapping → terminal bot_failed ═══════

  await test("E1 HTTP 429 → fetch×1 → claim terminal bot_failed, no reply/handoff", async () => {
    const conv = "conv_e1";
    seedConv(conv);
    seedUserMsg(conv, "m1", "q429");
    mocks.state.fetchResponse = { status: 429, body: { error: "rate_limited" } };
    const r = await processOne(conv, "m1", "q429");
    const s = callParams();
    assert(r.status === "bot_failed", `status=${r.status}`);
    assert(s.fetchCalls === 1, `fetch=${s.fetchCalls} want 1 — no retry allowed`);
    assert(s.fetchUrls[0] === EXPECTED_CHAT_URL, `url=${s.fetchUrls[0]}`);
    assert(claimDoc("m1")?.status === "bot_failed", `claim=${claimDoc("m1")?.status}`);
    assert(repliesIn(conv).length === 0, "phantom reply");
    const hand = mocks.fakeColl("test_status_conversation").find((d: any) => d.conversation_id === conv && d.status === "handoff");
    assert(!hand, "429 must not auto-handoff");
  });

  await test("E2 HTTP 500 → fetch×1 → bot_failed terminal", async () => {
    const conv = "conv_e2";
    seedConv(conv);
    seedUserMsg(conv, "m1", "q500");
    mocks.state.fetchResponse = { status: 500, body: { error: "internal" } };
    const r = await processOne(conv, "m1", "q500");
    assert(r.status === "bot_failed", `status=${r.status}`);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1`);
    assert(claimDoc("m1")?.status === "bot_failed");
    assert(repliesIn(conv).length === 0);
  });

  await test("E3 network error → fetch×1 → bot_failed terminal", async () => {
    const conv = "conv_e3";
    seedConv(conv);
    seedUserMsg(conv, "m1", "qnet");
    mocks.state.fetchReject = new TypeError("fetch failed — ECONNREFUSED");
    const r = await processOne(conv, "m1", "qnet");
    assert(r.status === "bot_failed", `status=${r.status}`);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1`);
    assert(claimDoc("m1")?.status === "bot_failed");
  });

  await test("E4 timeout → AbortError → fetch×1 → bot_failed terminal", async () => {
    const conv = "conv_e4";
    seedConv(conv);
    seedUserMsg(conv, "m1", "qtimeout");
    const old = rt.botworkerRuntime.botCallTimeoutMs;
    rt.botworkerRuntime.botCallTimeoutMs = 60;
    try {
      mocks.state.fetchHang = true; // hangs until caller's signal aborts
      const r = await processOne(conv, "m1", "qtimeout");
      assert(r.status === "bot_failed", `status=${r.status} detail=${r.detail}`);
      assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1`);
      assert(claimDoc("m1")?.status === "bot_failed");
    } finally {
      rt.botworkerRuntime.botCallTimeoutMs = old;
    }
  });

  await test("E5 repeated polls after 429 → fetch stays 1 (terminal never refires)", async () => {
    const conv = "conv_e5";
    seedConv(conv);
    const since = new Date();
    await sleep(5);
    seedUserMsg(conv, "m1", "qpoll", { created_timestamp: new Date() });
    mocks.state.fetchResponse = { status: 429, body: {} };
    await svc.ensureLeadership();
    const p1 = await svc.pollNewMessages(SCOPE);
    await svc.waitForInFlight(5000);
    assert(p1.found === 1, `found=${p1.found}`);
    assert(claimDoc("m1")?.status === "bot_failed", `claim=${claimDoc("m1")?.status}`);
    const n1 = callParams().fetchCalls;
    // poll ซ้ำสองรอบ — terminal claim ต้อง skip ไม่ยิง fetch เพิ่ม
    await svc.pollNewMessages(SCOPE);
    await svc.waitForInFlight(5000);
    await svc.pollNewMessages(SCOPE);
    await svc.waitForInFlight(5000);
    assert(callParams().fetchCalls === n1, `fetch grew ${n1}→${callParams().fetchCalls} — terminal refired`);
    assert(n1 === 1, `fetch=${n1} want 1`);
  });

  await test("E6 new inbound after failed turn → fetch+1 · failed inbound in history once · current not dup", async () => {
    const conv = "conv_e6";
    seedConv(conv);
    seedUserMsg(conv, "m1", "FAILED TURN TEXT");
    mocks.state.fetchResponse = { status: 500, body: {} };
    await processOne(conv, "m1", "FAILED TURN TEXT");
    assert(claimDoc("m1")?.status === "bot_failed");
    // ข้อความใหม่ — history ต้องมี failed inbound ครั้งเดียว และไม่มี text ปัจจุบัน
    seedUserMsg(conv, "m2", "NEW TURN TEXT");
    mocks.state.fetchResponse = null;
    const bodies: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (u: any, o: any) => { bodies.push(JSON.parse(o.body)); return orig(u, o); };
    const r = await processOne(conv, "m2", "NEW TURN TEXT");
    assert(r.status === "bot_answered", `status=${r.status} ${r.detail}`);
    assert(callParams().fetchCalls === 2, `fetch=${callParams().fetchCalls} want 2`);
    const hist = JSON.stringify(bodies[0]?.history ?? []);
    const failedCount = (hist.match(/FAILED TURN TEXT/g) || []).length;
    assert(failedCount === 1, `failed inbound in history ${failedCount}× want 1 — hist=${hist}`);
    assert(!hist.includes("NEW TURN TEXT"), "current text must not appear in history");
    assert(bodies[0].message === "NEW TURN TEXT", `message=${bodies[0].message}`);
  });

  await test("E7 two consecutive failed inbounds → next turn history bounded/deduped by owner", async () => {
    const conv = "conv_e7";
    seedConv(conv);
    seedUserMsg(conv, "m1", "FAIL ONE");
    seedUserMsg(conv, "m2", "FAIL TWO");
    mocks.state.fetchResponse = { status: 500, body: {} };
    await processOne(conv, "m1", "FAIL ONE");
    await processOne(conv, "m2", "FAIL TWO");
    seedUserMsg(conv, "m3", "NEW QUESTION");
    mocks.state.fetchResponse = null;
    const bodies: any[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (u: any, o: any) => { bodies.push(JSON.parse(o.body)); return orig(u, o); };
    await processOne(conv, "m3", "NEW QUESTION");
    const hist = bodies[0]?.history ?? [];
    const userTurns = hist.filter((h: any) => h.role === "user");
    // owner เดิม: failed inbounds ที่ติดกัน group เป็น user turn เดียว (join text)
    const failTexts = JSON.stringify(hist).match(/FAIL (ONE|TWO)/g) || [];
    assert(userTurns.length <= 2, `user turns=${userTurns.length} — history ต้อง bounded`);
    assert(failTexts.length === 2, `failed texts must appear once each, got ${JSON.stringify(failTexts)}`);
    assert(!JSON.stringify(hist).includes("NEW QUESTION"), "current leaked into history");
  });

  await test("E8 failure → no auto-handoff + no platform delivery artifacts", async () => {
    const conv = "conv_e8";
    seedConv(conv);
    seedUserMsg(conv, "m1", "qnohand");
    mocks.state.fetchResponse = { status: 503, body: {} };
    await processOne(conv, "m1", "qnohand");
    const tsc = mocks.fakeColl("test_status_conversation").filter((d: any) => d.conversation_id === conv);
    assert(!tsc.some((d: any) => d.status === "handoff"), "auto handoff on provider failure");
    assert(repliesIn(conv).length === 0, "no reply rows may persist");
    assert(claimDoc("m1")?.status === "bot_failed");
  });

  await test("E9 empty answer → handed_off (existing contract — pin)", async () => {
    const conv = "conv_e9";
    seedConv(conv);
    seedUserMsg(conv, "m1", "qempty");
    mocks.state.fetchResponse = { status: 200, body: { answer: "", source: "synthetic" } };
    const r = await processOne(conv, "m1", "qempty");
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls}`);
    assert(r.status === "handed_off", `status=${r.status} — empty answer must hand off, not fail`);
    assert(claimDoc("m1")?.status === "handed_off", `claim=${claimDoc("m1")?.status}`);
  });

  // ═══ BW-5: single outbound concurrency owner ═════════════

  await test("C1 direct worker callBot ×5, limit=2 → fetch peak ≤2, FIFO drains", async () => {
    mocks.state.config.bot_concurrency_limit = 2;
    mocks.state.fetchGate = true;
    const calls = Array.from({ length: 5 }, (_, i) =>
      botCall({ ...wc, message: `q${i}` }).then((r) => r.answer));
    await sleep(20);
    const s = callParams();
    assert(s.fetchCalls === 2, `fetch=${s.fetchCalls} want 2 — limiter must hold queue`);
    assert(s.fetchPeak <= 2, `peak=${s.fetchPeak} > limit 2`);
    releaseGate(1);
    await sleep(20);
    assert(callParams().fetchCalls === 3, `fetch=${callParams().fetchCalls} want 3 after one release`);
    releaseGate(4);
    const answers = await Promise.all(calls);
    assert(answers.every((a) => a === "synthetic bot answer"), "all calls must resolve");
    assert(callParams().fetchCalls === 5, `fetch=${callParams().fetchCalls} want 5`);
    assert(callParams().fetchPeak <= 2, `peak=${callParams().fetchPeak}`);
  });

  await test("C2 processMessage direct path, limit=1 → second message queues (pin)", async () => {
    const conv = "conv_c2";
    seedConv(conv);
    seedUserMsg(conv, "m1", "q1");
    seedUserMsg(conv, "m2", "q2");
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const p1 = processOne(conv, "m1", "q1");
    const p2 = processOne(conv, "m2", "q2");
    await sleep(30);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1 — second must queue`);
    releaseGate(2);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert(r1.status === "bot_answered" && r2.status === "bot_answered", `${r1.status}/${r2.status}`);
    assert(callParams().fetchCalls === 2);
  });

  await test("C3 workflow let_ai_respond → same limiter (queue behind direct call)", async () => {
    const conv = "conv_c3";
    seedConv(conv);
    seedAiWorkflow();
    seedUserMsg(conv, "m1", "wfkw hello");
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const direct = botCall({ ...wc, message: "direct" }).then((r) => r.answer);
    await sleep(20);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1 — direct holds the only slot`);
    const wf = processOne(conv, "m1", "wfkw hello");
    await sleep(40);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} want 1 — workflow let_ai_respond bypassed limiter`);
    releaseGate(2);
    const [a, r] = await Promise.all([direct, wf]);
    assert(a === "synthetic bot answer");
    // ⚡ exact workflow evidence — ห้ามยอมให้ direct fallback ทำให้ผ่าน
    assert(r.status === "workflow_actioned", `wf status=${r.status} ${r.detail} — let_ai_respond ต้อง execute จริง`);
    const runs = mocks.fakeColl("workflow_runs").filter((d: any) => d.conversation_id === conv);
    assert(runs.length === 1 && runs[0].workflow_id === "wf_ai", `run evidence missing: ${JSON.stringify(runs.map((x: any) => x.workflow_id))}`);
    const wfBody = mocks.state.fetchBodies.find((b: any) => typeof b?.message === "string" && b.message.startsWith("WF_PROMPT_MARKER"));
    assert(!!wfBody, "no fetch body carries workflow prompt — let_ai_respond path not proven");
    assert(callParams().fetchCalls === 2, `fetch=${callParams().fetchCalls}`);
    assert(callParams().fetchPeak <= 1, `peak=${callParams().fetchPeak}`);
  });

  await test("C4 mixed direct+workflow+direct, limit=2 → combined peak ≤2", async () => {
    const conv = "conv_c4";
    seedConv(conv);
    seedAiWorkflow();
    seedUserMsg(conv, "m1", "wfkw hi");
    mocks.state.config.bot_concurrency_limit = 2;
    mocks.state.fetchGate = true;
    const c1 = botCall({ ...wc, message: "d1" }).then((r) => r.answer);
    const c2 = botCall({ ...wc, message: "d2" }).then((r) => r.answer);
    const wf = processOne(conv, "m1", "wfkw hi");
    await sleep(40);
    assert(callParams().fetchCalls === 2,
      `fetch=${callParams().fetchCalls} want 2 — workflow call bypassed the shared limit`);
    releaseGate(3);
    const [, , r] = await Promise.all([c1, c2, wf]);
    assert(r.status === "workflow_actioned", `wf status=${r.status} ${r.detail}`);
    const wfBody = mocks.state.fetchBodies.find((b: any) => typeof b?.message === "string" && b.message.startsWith("WF_PROMPT_MARKER"));
    assert(!!wfBody, "workflow prompt marker missing — direct fallback path would pass falsely");
    assert(callParams().fetchPeak <= 2, `peak=${callParams().fetchPeak} > limit 2`);
    assert(callParams().fetchCalls === 3);
  });

  await test("C5 queued callBot aborted mid-queue → exits without fetch", async () => {
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const first = botCall({ ...wc, message: "hold" }).then((r) => r.answer);
    await sleep(20);
    assert(callParams().fetchCalls === 1);
    const ctrl = new AbortController();
    const second = botCall({ ...wc, message: "queued", signal: ctrl.signal }).then(
      () => "resolved",
      (e: any) => `rejected:${e?.name || e}`
    );
    await sleep(20);
    ctrl.abort();
    // ⚡ release ก่อน await — โค้ดเก่า (ไม่มี limiter/abort ใน callBot) second ติด gate
    //    ต้องปล่อยให้มัน resolve มิฉะนั้น suite ค้าง
    releaseGate(1);
    const r2 = await Promise.race([second, sleep(3000).then(() => "P2_STUCK" as const)]);
    assert(r2 !== "P2_STUCK" && r2.startsWith("rejected:"),
      `queued call must reject on abort, got ${r2}`);
    await sleep(20);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — aborted queued call must never reach fetch`);
    await first;
  });

  await test("C6 queued processMessage + ownership loss mid-queue → exits without fetch", async () => {
    const conv = "conv_c6";
    seedConv(conv);
    seedUserMsg(conv, "m1", "q1");
    seedUserMsg(conv, "m2", "q2");
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const oldHb = rt.botworkerRuntime.heartbeatMs;
    rt.botworkerRuntime.heartbeatMs = 30;
    try {
      const p1 = processOne(conv, "m1", "q1");
      const p2 = processOne(conv, "m2", "q2");
      await sleep(40);
      assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1 (m2 queued)`);
      // ทำ claim ของ m2 เป็น foreign → claim heartbeat CAS miss → ctx.lost+abort กลาง queue
      const c2 = claimDoc("m2");
      c2.owner_id = "foreign-owner";
      await sleep(120); // ≥2 heartbeat ticks
      releaseGate(2);
      const r1 = await p1;
      // ⚡ strict — waiter ต้อง settle ภายในเวลา ไม่ใช่ค้างถาวร (no P2_STUCK allowance)
      const r2 = await Promise.race([
        p2,
        sleep(3000).then(() => "P2_STUCK_IN_QUEUE" as const),
      ]);
      assert(r1.status === "bot_answered", `r1=${r1.status}`);
      assert(r2 !== "P2_STUCK_IN_QUEUE", "queued call stuck after ownership loss — must settle");
      assert(callParams().fetchCalls === 1,
        `fetch=${callParams().fetchCalls} — aborted queued call must never reach fetch`);
      assert(!r2.finalized, "lost claim must not finalize");
      const c2doc = claimDoc("m2");
      assert(c2doc?.status === "processing",
        `claim=${c2doc?.status} — cancellation ต้องคง recoverable ไม่ใช่ terminal`);
    } finally {
      rt.botworkerRuntime.heartbeatMs = oldHb;
    }
  });

  await test("C7 limit decrease mid-flight → no new admit until active < new limit", async () => {
    mocks.state.config.bot_concurrency_limit = 3;
    mocks.state.fetchGate = true;
    const calls = Array.from({ length: 5 }, (_, i) =>
      botCall({ ...wc, message: `q${i}` }).then((r) => r.answer));
    await sleep(20);
    assert(callParams().fetchCalls === 3, `fetch=${callParams().fetchCalls} want 3`);
    mocks.state.config.bot_concurrency_limit = 1; // admin ลด limit กลางคัน
    releaseGate(1);
    await sleep(30);
    assert(callParams().fetchCalls === 3, `fetch=${callParams().fetchCalls} — must not admit while active(2) ≥ limit(1)`);
    releaseGate(1);
    await sleep(30);
    assert(callParams().fetchCalls === 3, `fetch=${callParams().fetchCalls} — still active(1) ≥ limit(1)`);
    releaseGate(1);
    await sleep(30);
    assert(callParams().fetchCalls === 4, `fetch=${callParams().fetchCalls} want 4 — admit only when active<1`);
    releaseGate(1);
    await sleep(30);
    assert(callParams().fetchCalls === 5, `fetch=${callParams().fetchCalls} want 5`);
    releaseGate(1); // call 5 ถูก admit หลัง assert — fetch ของมันยังติด gate
    await Promise.all(calls);
  });

  await test("C8 limit increase → queue drains without double-fire", async () => {
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const calls = Array.from({ length: 3 }, (_, i) =>
      botCall({ ...wc, message: `q${i}` }).then((r) => r.answer));
    await sleep(20);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1 — limit=1 must queue`);
    mocks.state.config.bot_concurrency_limit = 3;
    releaseGate(1);
    await sleep(30);
    assert(callParams().fetchCalls === 3, `fetch=${callParams().fetchCalls} want 3 — queue must proceed`);
    releaseGate(3);
    await Promise.all(calls);
    assert(callParams().fetchPeak <= 3, `peak=${callParams().fetchPeak}`);
  });

  await test("C9 terminal claim / duplicate → fetch=0 (pin)", async () => {
    const conv = "conv_c9";
    seedConv(conv);
    seedUserMsg(conv, "m1", "q");
    const r1 = await svc.processMessage({ message_id: "m1", conversation_id: conv, shop_id: "shop_1", platform: "shopee", text: "q", shop_ctx: { config_shop_key: "shop_1", shopname: "shop_1" } });
    assert(r1.status === "bot_answered" && callParams().fetchCalls === 1, `r1=${r1.status} fetch=${callParams().fetchCalls}`);
    const r2 = await svc.processMessage({ message_id: "m1", conversation_id: conv, shop_id: "shop_1", platform: "shopee", text: "q", shop_ctx: { config_shop_key: "shop_1", shopname: "shop_1" } });
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} — terminal must never refire`);
    assert(r2.status === "skip" || r2.status === "bot_answered" || r2.finalized === true,
      `r2=${r2.status} — terminal/duplicate must skip without refire`);
  });

  await test("C10 429 failure releases slot → queued call proceeds (no deadlock)", async () => {
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchResponse = { status: 429, body: {} };
    const r1 = await botCall({ ...wc, message: "f1" }).then(() => "ok", (e: any) => `err:${e.message}`);
    assert(r1.startsWith("err:"), `429 must throw, got ${r1}`);
    mocks.state.fetchResponse = null;
    const r2 = await botCall({ ...wc, message: "f2" });
    assert(r2.answer === "synthetic bot answer", "queued/next call must proceed after terminal failure");
    assert(callParams().fetchCalls === 2, `fetch=${callParams().fetchCalls}`);
  });

  await test("C11 non-botworker callBot → not limited (behavior unchanged)", async () => {
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const calls = Array.from({ length: 3 }, (_, i) =>
      botCall({ platform: "shopee", shopId: "shop_1", message: `nw${i}`, history: [] }).then((r) => r.answer));
    await sleep(20);
    assert(callParams().fetchCalls === 3,
      `fetch=${callParams().fetchCalls} want 3 — non-botworker path must not hit worker limiter`);
    releaseGate(3);
    await Promise.all(calls);
  });

  await test("C12 all fetch calls hit configured base URL only (provider=stub)", async () => {
    const conv = "conv_c12";
    seedConv(conv);
    seedUserMsg(conv, "m1", "q");
    await processOne(conv, "m1", "q");
    const s = callParams();
    assert(s.fetchCalls >= 1);
    assert(s.fetchUrls.every((u) => u === EXPECTED_CHAT_URL),
      `unexpected URL: ${s.fetchUrls.join(",")}`);
  });

  // ═══ Review-fix: signal threading + kill switch + fail-stale ═══

  await test("D1 workflow queued + ownership loss → settles, never fetches, no finalize", async () => {
    const conv = "conv_d1";
    seedConv(conv);
    seedAiWorkflow();
    seedUserMsg(conv, "m1", "wfkw hi");
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const holder = botCall({ ...wc, message: "holder" }).then((r) => r.answer);
    await sleep(20);
    assert(callParams().fetchCalls === 1, `holder fetch=${callParams().fetchCalls}`);
    const oldHb = rt.botworkerRuntime.heartbeatMs;
    rt.botworkerRuntime.heartbeatMs = 30;
    try {
      const wf = processOne(conv, "m1", "wfkw hi");
      await sleep(60);
      assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} — workflow call must be queued`);
      // ownership loss กลาง queue — heartbeat CAS miss → ctx.lost + abort
      claimDoc("m1")!.owner_id = "foreign-owner";
      await sleep(120);
      releaseGate(1);
      const rwf = await Promise.race([wf, sleep(3000).then(() => "WF_STUCK" as const)]);
      assert(rwf !== "WF_STUCK", "workflow queued call must settle after ownership loss");
      assert(callParams().fetchCalls === 1,
        `fetch=${callParams().fetchCalls} — aborted workflow call must never reach fetch`);
      assert(!rwf.finalized, "lost claim must not finalize");
      assert(claimDoc("m1")?.status === "processing",
        `claim=${claimDoc("m1")?.status} — cancellation must stay recoverable`);
      // workflow path จริง — run doc ถูกสร้างก่อนเดิน graph
      const runs = mocks.fakeColl("workflow_runs").filter((d: any) => d.conversation_id === conv);
      assert(runs.length >= 1, "no workflow run — workflow path not proven");
      await holder;
    } finally {
      rt.botworkerRuntime.heartbeatMs = oldHb;
    }
  });

  await test("D3 falling edge mid-queue (direct path) → no fetch, promise settles, claim recoverable", async () => {
    const conv = "conv_d3";
    seedConv(conv);
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const holder = botCall({ ...wc, message: "holder" }).then((r) => r.answer);
    await sleep(20);
    assert(callParams().fetchCalls === 1);
    await svc.ensureLeadership();
    const since = new Date();
    await sleep(5);
    seedUserMsg(conv, "m1", "queued msg", { created_timestamp: new Date() });
    await svc.pollNewMessages(SCOPE);
    await sleep(80);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — m1 must be queued behind holder`);
    // ⚡ production kill switch — falling edge / shutdown
    await svc.botWorkerService.clearPendingWork();
    await svc.waitForInFlight(5000);
    releaseGate(1);
    await holder;
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — queued call must never start after kill switch`);
    const c = claimDoc("m1");
    assert(c?.status === "processing",
      `claim=${c?.status} — kill-switch cancellation ต้องไม่ terminal (recoverable by rising edge)`);
  });

  await test("D4 falling edge mid-queue (workflow path) → no fetch, claim recoverable, run evidence", async () => {
    const conv = "conv_d4";
    seedConv(conv);
    seedAiWorkflow();
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const holder = botCall({ ...wc, message: "holder" }).then((r) => r.answer);
    await sleep(20);
    await svc.ensureLeadership();
    const since = new Date();
    await sleep(5);
    seedUserMsg(conv, "m1", "wfkw queued", { created_timestamp: new Date() });
    await svc.pollNewMessages(SCOPE);
    await sleep(100);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — workflow call must be queued`);
    // workflow path ถูกเดินจริงก่อนรอ queue — run doc เป็น evidence
    const runs = mocks.fakeColl("workflow_runs").filter((d: any) => d.conversation_id === conv);
    assert(runs.length >= 1, "no workflow run — m1 did not take workflow path");
    await svc.botWorkerService.clearPendingWork();
    await svc.waitForInFlight(5000);
    releaseGate(1);
    await holder;
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — queued workflow call must never start after kill switch`);
    const c = claimDoc("m1");
    assert(c?.status === "processing",
      `claim=${c?.status} — kill-switch cancellation must stay recoverable`);
  });

  await test("D5 config read failure at release → fail-stale (no burst to default)", async () => {
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const calls = Array.from({ length: 3 }, (_, i) =>
      botCall({ ...wc, message: `q${i}` }).then((r) => r.answer));
    await sleep(20);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} want 1`);
    // config read ล้มกลาง drain — ต้อง fail-stale ที่ last accepted (1) ไม่ใช่ fallback 50
    mocks.state.configError = true;
    releaseGate(1);
    await sleep(40);
    assert(callParams().fetchCalls === 2,
      `fetch=${callParams().fetchCalls} — drain must not burst beyond last accepted limit 1`);
    assert(callParams().fetchPeak <= 1, `peak=${callParams().fetchPeak} — never exceed limit on read failure`);
    // config กลับมาปกติ → queue เดินต่อ
    mocks.state.configError = false;
    releaseGate(1);
    await sleep(40);
    assert(callParams().fetchCalls === 3, `fetch=${callParams().fetchCalls} want 3`);
    releaseGate(1);
    await Promise.all(calls);
  });

  // ═══ BW-5 final corrective: config failure at admission + post-response
  //     kill switch + wait-timeout abort rollback ═══

  await test("D6 config failure at ADMISSION → fallback-50 must never raise the ceiling", async () => {
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchGate = true;
    const holder = botCall({ ...wc, message: "holder" }).then((r) => r.answer);
    await sleep(20);
    assert(callParams().fetchCalls === 1, `holder fetch=${callParams().fetchCalls}`);
    // ⚡ production-faithful failure — getSystemConfig ไม่ throw แต่คืน fresh
    //   fallback doc (bot_concurrency_limit=50) ทุก call — call ใหม่ห้ามยึด 50 เป็นเพดาน
    mocks.state.configError = true;
    const queued = Array.from({ length: 3 }, (_, i) =>
      botCall({ ...wc, message: `burst${i}` }).then((r) => r.answer));
    await sleep(60);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — config failure must not admit beyond last-known-good 1`);
    assert(callParams().fetchPeak <= 1, `peak=${callParams().fetchPeak}`);
    // config กลับมา + increase มีผลจริง — queue เดินตาม limit ใหม่
    mocks.state.configError = false;
    mocks.state.config.bot_concurrency_limit = 3;
    releaseGate(1);
    await sleep(60);
    assert(callParams().fetchCalls === 4,
      `fetch=${callParams().fetchCalls} want 4 — healthy increase must drain`);
    assert(callParams().fetchPeak <= 3, `peak=${callParams().fetchPeak}`);
    releaseGate(4);
    await Promise.all([holder, ...queued]);
  });

  await test("D7 cold-start config failure → fail-closed 1 (never fallback-50)", async () => {
    // ⚡ cold start — ไม่มี healthy read เลย (ไม่มี last-known-good)
    //   failure ต้อง fail-closed ที่ 1 — ห้าม admit ตาม fallback default 50
    mocks.state.configError = true;
    mocks.state.fetchGate = true;
    const calls = Array.from({ length: 3 }, (_, i) =>
      botCall({ ...wc, message: `cold${i}` }).then((r) => r.answer));
    await sleep(60);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — cold-start failure must admit at most 1`);
    assert(callParams().fetchPeak <= 1, `peak=${callParams().fetchPeak}`);
    // config กลับมา → drain ตาม healthy config จริง
    mocks.state.configError = false;
    releaseGate(3);
    await Promise.all(calls);
    assert(callParams().fetchCalls === 3, `fetch=${callParams().fetchCalls} want 3`);
  });

  await test("D8 kill switch AFTER provider response (direct) → no finalize, recovery reuses evidence", async () => {
    const conv = "conv_d8";
    seedConv(conv);
    // ⚡ pause ที่ persist boundary — provider response สำเร็จแล้ว แต่ reply write ค้าง
    const release = pauseQuery("shadow_replies", "insertOne");
    await svc.ensureLeadership();
    const since = new Date();
    await sleep(5);
    seedUserMsg(conv, "m1", "direct post-resp", { created_timestamp: new Date() });
    await svc.pollNewMessages(SCOPE);
    await waitFor(() => mocks.state.queryPauseHits === 1);
    assert(mocks.state.queryPauseHits === 1,
      `pauseHits=${mocks.state.queryPauseHits} — reply persist boundary never reached`);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls}`);
    // kill switch กลาง persist — era abort หลัง provider response สำเร็จ
    await svc.botWorkerService.clearPendingWork();
    release();
    await svc.waitForInFlight(5000);
    const c = claimDoc("m1");
    assert(c?.status === "processing",
      `claim=${c?.status} — post-response era-abort must not finalize claim`);
    // deterministic evidence persist ไปแล้ว (หยุด write กลางทางไม่ได้) — recovery reuse
    assert(repliesIn(conv).length === 1, `replies=${repliesIn(conv).length} — one persisted reply`);
    c!.lease_expires_at = new Date(Date.now() - 1000);
    await svc.botWorkerService.recoverStaleBuffers(SCOPE);
    assert(claimDoc("m1")?.status !== "processing",
      `claim=${claimDoc("m1")?.status} — recovery must finalize claim from committed evidence`);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — recovery must not call provider again`);
    assert(repliesIn(conv).length === 1, "no duplicate reply after recovery");
  });

  await test("D9 kill switch AFTER provider response (workflow) → no finalize, no dup delivery", async () => {
    const conv = "conv_d9";
    seedConv(conv);
    seedAiWorkflow();
    const release = pauseQuery("shadow_replies", "insertOne");
    await svc.ensureLeadership();
    const since = new Date();
    await sleep(5);
    seedUserMsg(conv, "m1", "wfkw post-resp", { created_timestamp: new Date() });
    await svc.pollNewMessages(SCOPE);
    await waitFor(() => mocks.state.queryPauseHits === 1);
    assert(mocks.state.queryPauseHits === 1,
      `pauseHits=${mocks.state.queryPauseHits} — workflow persist boundary never reached`);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls}`);
    // workflow path จริง — run doc เป็น evidence ก่อน assert cancellation
    const runs = mocks.fakeColl("workflow_runs").filter((d: any) => d.conversation_id === conv);
    assert(runs.length >= 1, "no workflow run — m1 did not take workflow path");
    await svc.botWorkerService.clearPendingWork();
    release();
    await svc.waitForInFlight(5000);
    const c = claimDoc("m1");
    assert(c?.status === "processing",
      `claim=${c?.status} — post-response era-abort must not finalize claim`);
    assert(repliesIn(conv).length === 1, `replies=${repliesIn(conv).length} — one workflow reply persisted`);
    c!.lease_expires_at = new Date(Date.now() - 1000);
    await svc.botWorkerService.recoverStaleBuffers(SCOPE);
    assert(claimDoc("m1")?.status !== "processing",
      `claim=${claimDoc("m1")?.status} — recovery must finalize from committed evidence`);
    assert(callParams().fetchCalls === 1, "no provider call on recovery");
    assert(repliesIn(conv).length === 1, "no duplicate workflow reply");
  });

  await test("D10 wait-timeout abort (fenced run) → parked state restored, retry once", async () => {
    const conv = "conv_d10";
    seedConv(conv);
    seedWaitWorkflow("wf_wait");
    const parkedAt = seedParkedRun("run_d10", "wf_wait", conv);
    mocks.state.fetchHang = true; // resumed let_ai_respond ค้างจน abort
    await svc.ensureLeadership();
    const p = svc.botWorkerService.checkWaitTimeouts(SCOPE);
    await waitFor(() => callParams().fetchCalls === 1, 3000);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — resumed let_ai_respond must reach the stub`);
    // kill switch กลางเดิน no_reply branch — abort หลัง acquire + running flip
    await svc.botWorkerService.clearPendingWork();
    await p; // ต้อง settle ไม่ค้าง
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} — no provider call after abort`);
    const run = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d10");
    assert(run.status === "waiting_for_reply",
      `run.status=${run.status} — abort must restore parked state (fenced rollback)`);
    assert(run.wait_started_at?.getTime?.() === parkedAt.getTime(),
      `wait_started_at=${run.wait_started_at} — parked wait context must be preserved`);
    assert(run.wait_node_id === "w1" && run.current_node_id === "w1" && run.waiting_for === "next_message",
      `wait context lost — node=${run.wait_node_id} current=${run.current_node_id} waiting_for=${run.waiting_for}`);
    // era ใหม่ — timeout retry ทำต่อครั้งเดียว
    mocks.state.fetchHang = false;
    await svc.botWorkerService.checkWaitTimeouts(SCOPE);
    assert(callParams().fetchCalls === 2, `fetch=${callParams().fetchCalls} — retry once only`);
    const after = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d10");
    assert(after.status === "completed",
      `run.status=${after.status} — retried no_reply branch must complete`);
    assert(repliesIn(conv).length === 0, "wait-timeout path must not emit duplicate replies");
  });

  await test("D11 wait-timeout abort (legacy unfenced run) → parked state restored", async () => {
    const conv = "conv_d11";
    seedConv(conv);
    seedWaitWorkflow("wf_wait_l");
    // ⚡ legacy run — ไม่มี owner_id/fencing_token/lease (pre-fencing era)
    const parkedAt = seedParkedRun("run_d11", "wf_wait_l", conv, false);
    mocks.state.fetchHang = true;
    await svc.ensureLeadership();
    const p = svc.botWorkerService.checkWaitTimeouts(SCOPE);
    await waitFor(() => callParams().fetchCalls === 1, 3000);
    assert(callParams().fetchCalls === 1,
      `fetch=${callParams().fetchCalls} — resumed let_ai_respond must reach the stub`);
    await svc.botWorkerService.clearPendingWork();
    await p;
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} — no provider call after abort`);
    const run = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d11");
    // ⚡ legacy contract — era abort ห้าม terminalize เป็น errored; state ต้อง retryable
    //   (rollback ผ่าน acquired doc ที่ acquire ใส่ owner ให้แล้ว — ไม่ใช่ fenced guarantee
    //   ของ run เดิม แต่ต้องไม่ทิ้ง run ค้าง running/errored)
    assert(run.status === "waiting_for_reply",
      `run.status=${run.status} — legacy abort must not terminalize (pre-fix: errored)`);
    assert(run.wait_started_at?.getTime?.() === parkedAt.getTime(),
      `wait_started_at=${run.wait_started_at} — wait context must be preserved`);
  });

  // ═══ BW-5 root-cause correction: abort boundary + acquired-context terminalize ═══

  /** seed workflow พร้อม wait node → no_reply → let_ai_respond */
  function seedWaitWorkflow(wfId: string) {
    mocks.state.config.workflow_enabled = true;
    mocks.fakeColl("workflows").push({
      workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
      shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
      false_branch_policy: "exit_to_bot",
      nodes: [
        { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: ["waitkw"] }, position: { x: 0, y: 0 } },
        { node_id: "w1", type: "wait", subtype: "wait_for_reply", config: { answer_type: "any", max_retries: 3, timeout_ms: 50 }, position: { x: 0, y: 0 } },
        { node_id: "n3", type: "action", subtype: "let_ai_respond", config: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { edge_id: "e1", source_node_id: "n1", target_node_id: "w1" },
        { edge_id: "e2", source_node_id: "w1", target_node_id: "n3", branch: "no_reply" },
      ],
      priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
    });
  }

  /** fenced parked run (lease+timeout ครบแล้ว) — owner เก่า stale, token=5 */
  function seedParkedRun(runId: string, wfId: string, conv: string, fenced = true) {
    const parkedAt = new Date(Date.now() - 60000);
    mocks.fakeColl("workflow_runs").push({
      run_id: runId, workflow_id: wfId,
      conversation_id: conv, shop_id: "shop_1", platform: "shopee",
      customer_id: "cust_1",
      status: "waiting_for_reply", current_node_id: "w1",
      waiting_for: "next_message", wait_node_id: "w1",
      wait_started_at: parkedAt, wait_retry_count: 0,
      context: {}, test_source: "botworker",
      ...(fenced
        ? { owner_id: "stale-owner", fencing_token: 5, lease_expires_at: new Date(Date.now() - 1000) }
        : {}),
      started_at: new Date(Date.now() - 61000), updated_at: new Date(Date.now() - 60000),
      version: 1,
    });
    return parkedAt;
  }

  const runWrites = () =>
    mocks.state.queryLog.filter((q: any) =>
      q.coll === "workflow_runs" && (q.op === "findOneAndUpdate" || q.op === "updateOne" || q.op === "updateMany"));

  await test("D12 pre-aborted signal → checkWaitTimeouts must not acquire/write/fetch", async () => {
    const conv = "conv_d12";
    seedConv(conv);
    seedWaitWorkflow("wf_wait_d12");
    seedParkedRun("run_d12", "wf_wait_d12", conv);
    const engine = await import("../src/backend/service/workflowEngine");
    const ac = new AbortController();
    ac.abort();
    // ⚡ abort ก่อนเริ่ม candidate → zero acquire/write/provider calls
    const n = await engine.workflowEngine.checkWaitTimeouts(ac.signal, SCOPE);
    assert(n === 0, `processed=${n} — aborted scan must report 0`);
    assert(callParams().fetchCalls === 0, `fetch=${callParams().fetchCalls} — no provider call`);
    assert(runWrites().length === 0,
      `workflow_runs writes=${runWrites().length} — aborted scan must not touch runs`);
    const run = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d12");
    assert(run.status === "waiting_for_reply" && run.fencing_token === 5,
      `run mutated — status=${run.status} token=${run.fencing_token}`);
  });

  await test("D13 abort between candidates → next candidate untouched, processed=0", async () => {
    const conv = "conv_d13";
    seedConv(conv);
    seedWaitWorkflow("wf_wait_d13");
    const parkedAt = seedParkedRun("run_d13a", "wf_wait_d13", conv);
    seedParkedRun("run_d13b", "wf_wait_d13", conv);
    mocks.state.fetchHang = true; // candidate แรกค้างใน fetch จน abort
    await svc.ensureLeadership();
    const p = svc.botWorkerService.checkWaitTimeouts(SCOPE);
    await waitFor(() => callParams().fetchCalls === 1, 3000);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls}`);
    await svc.botWorkerService.clearPendingWork();
    const n = await p;
    const runA = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d13a");
    const runB = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d13b");
    assert(runA.status === "waiting_for_reply" && runA.wait_started_at?.getTime?.() === parkedAt.getTime(),
      `run_a=${runA.status} — aborted candidate must be restored to parked`);
    // ⚡ abort ระหว่าง candidates → ห้ามแตะ candidate ถัดไป (zero acquire/write)
    assert(runB.status === "waiting_for_reply" && runB.fencing_token === 5 && runB.owner_id === "stale-owner",
      `run_b mutated after abort — status=${runB.status} token=${runB.fencing_token} owner=${runB.owner_id}`);
    assert(callParams().fetchCalls === 1, `fetch=${callParams().fetchCalls} — no provider call after abort`);
    assert(n === 0, `processed=${n} — aborted work must not count as processed`);
  });

  await test("D14 non-abort error after acquire → terminalize with acquired fencing context", async () => {
    const conv = "conv_d14";
    seedConv(conv);
    seedWaitWorkflow("wf_wait_d14");
    seedParkedRun("run_d14", "wf_wait_d14", conv);
    // ⚡ real processing error (provider 500) — ไม่ใช่ abort → run ต้อง errored ด้วย
    //    fencing token ปัจจุบัน (acquired) ไม่ใช่ stale snapshot
    mocks.state.fetchResponse = { status: 500, body: { error: "boom" } };
    await svc.ensureLeadership();
    const n = await svc.botWorkerService.checkWaitTimeouts(SCOPE);
    assert(n === 1, `processed=${n} — handled run counts once`);
    const run = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d14");
    assert(run.status === "errored",
      `run.status=${run.status} — real error post-acquire must terminalize (stale-snapshot failRun leaves it running)`);
    assert(run.outcome === "error", `outcome=${run.outcome}`);
    assert(typeof run.error === "string" && run.error.includes("wait timeout"),
      `error=${run.error} — terminal record must name the cause`);
  });

  await test("D15 abort during workflow lookup → zero writes (cancelIfAbandoned must not run)", async () => {
    const conv = "conv_d15";
    seedConv(conv);
    mocks.state.config.workflow_enabled = true;
    // ⚡ workflow หาย (ไม่ seed) → getWorkflow→null → cancelIfAbandoned path
    //   abort ลงกลาง await lookup → ห้ามเขียน cancellation เลย
    seedParkedRun("run_d15", "wf_gone_d15", conv);
    const engine = await import("../src/backend/service/workflowEngine");
    const ac = new AbortController();
    let lookupEntered = false;
    let releaseLookup: () => void = () => {};
    mocks.state.findOneHook = (coll: string) => {
      if (coll !== "workflows") return undefined;
      lookupEntered = true;
      return new Promise<void>((r) => { releaseLookup = r; });
    };
    try {
      const p = engine.workflowEngine.checkWaitTimeouts(ac.signal, SCOPE);
      await waitFor(() => lookupEntered, 3000);
      ac.abort();          // ⚡ abort ระหว่าง workflow lookup (async gap)
      releaseLookup();     // lookup คืน null หลัง abort
      const n = await p;
      const run = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d15");
      assert(n === 0, `processed=${n} — aborted scan must report 0`);
      assert(runWrites().length === 0,
        `workflow_runs writes=${runWrites().length} — abort mid-lookup must not write cancellation`);
      assert(run.status === "waiting_for_reply" && run.fencing_token === 5
        && run.owner_id === "stale-owner" && !run.completed_at,
        `run mutated — status=${run.status} token=${run.fencing_token} owner=${run.owner_id}`);
      assert(callParams().fetchCalls === 0, `fetch=${callParams().fetchCalls}`);
    } finally {
      mocks.state.findOneHook = null;
    }
  });

  await test("D16 terminal CAS miss after acquire → processed must not count fake terminal", async () => {
    const conv = "conv_d16";
    seedConv(conv);
    seedWaitWorkflow("wf_wait_d16");
    seedParkedRun("run_d16", "wf_wait_d16", conv);
    mocks.state.fetchResponse = { status: 500, body: { error: "boom" } };
    // ⚡ foreign owner reclaim ก่อน terminal CAS — flip owner/token ตอน failRun write
    //   (updateOneHook fires pre-apply → เทียบเท่า findOneAndUpdate ของ owner ใหม่ชนะ)
    mocks.state.updateOneHook = (coll: string, _filter: any, update: any) => {
      if (coll === "workflow_runs" && update?.$set?.status === "errored") {
        const d = mocks.fakeColl("workflow_runs").find((x: any) => x.run_id === "run_d16");
        if (d) { d.owner_id = "foreign-owner"; d.fencing_token = 999; }
      }
    };
    try {
      await svc.ensureLeadership();
      const n = await svc.botWorkerService.checkWaitTimeouts(SCOPE);
      assert(n === 0,
        `processed=${n} — terminal CAS miss = fencing loss, must not count as handled`);
      const run = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "run_d16");
      assert(run.owner_id === "foreign-owner" && run.fencing_token === 999,
        `foreign-owned run overwritten — owner=${run.owner_id} token=${run.fencing_token}`);
      assert(run.status !== "errored",
        `status=${run.status} — stale owner must not write terminal outcome on foreign run`);
      assert(callParams().fetchCalls === 1,
        `fetch=${callParams().fetchCalls} — no provider retry on fencing loss`);
    } finally {
      mocks.state.updateOneHook = null;
    }
  });

  // ═══ OT-B — Phase 2B.1 ownership transport boundary pin
  //   (blocker characterization B1–B4 removed — ห้ามล็อก defect เป็น PASS;
  //    lifecycle evidence อยู่ใน active log + architecture audit)

  await test("B5 no conversationId → ไม่มี ownership query + ticket_state omitted (pin — boundary เดิม)", async () => {
    await botCall({ platform: "shopee", shopId: "shop_1", message: "q", history: [] });
    const body = (mocks.state.fetchBodies[0] || {}) as Record<string, unknown>;
    assert(!("ticket_state" in body), `ticket_state=${body.ticket_state}`);
    assert(!mocks.state.queryLog.some((q: any) => q.coll === "conversations" || q.coll === "status_conversation"),
      "no-conversationId path ต้องไม่ทำ ownership query เลย");
  });

  // ⚡ D2 รันสุดท้าย — โค้ดเก่าที่ signal ไม่ถึง workflow call จะ leak slot ถาวร
  //    (hang ไม่มี abort) — อยู่ท้ายเพื่อไม่ให้ contamination กับ test อื่น
  await test("D2 workflow let_ai_respond hang → bounded timeout → bot_failed, slot released", async () => {
    const conv = "conv_d2";
    seedConv(conv);
    seedAiWorkflow();
    seedUserMsg(conv, "m1", "wfkw hi");
    mocks.state.config.bot_concurrency_limit = 1;
    mocks.state.fetchHang = true; // hang จน signal abort — timeout ต้องผูกกับ workflow call ด้วย
    const oldT = rt.botworkerRuntime.botCallTimeoutMs;
    rt.botworkerRuntime.botCallTimeoutMs = 80;
    try {
      const wf = processOne(conv, "m1", "wfkw hi");
      const rwf = await Promise.race([wf, sleep(4000).then(() => "WF_NO_TIMEOUT" as const)]);
      assert(rwf !== "WF_NO_TIMEOUT",
        "workflow callBot hung — no bounded timeout on workflow path (signal never threaded)");
      assert(rwf.status === "bot_failed", `status=${rwf.status} ${rwf.detail} — timeout → bot_failed policy`);
      assert(claimDoc("m1")?.status === "bot_failed", `claim=${claimDoc("m1")?.status}`);
      // slot ถูกคืน — next call ต้องเดินต่อ ไม่ deadlock
      mocks.state.fetchHang = false;
      const r2 = await botCall({ ...wc, message: "after-timeout" });
      assert(r2.answer === "synthetic bot answer", "queue deadlocked after timed-out slot");
    } finally {
      rt.botworkerRuntime.botCallTimeoutMs = oldT;
    }
  });

  // ── summary ──────────────────────────────────────────────

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
