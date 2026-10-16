// test-botworker-scope-gate.ts — Phase 2D platform+shop scope admission gate
//
// รัน: npx tsx scripts/test-botworker-scope-gate.ts
//
// Production modules ทำงานจริงบน fake Mongo:
//   ✅ botWorkerService / bufferService / workflowEngine / shopService /
//      adminLogService / route handlers (/shops, /config)
// mock เฉพาะ leaf: mongoClient / botCallService / systemConfigService / authorize
//
// Contract ภายใต้ทดสอบ:
//   eligible ⟺ global bot_worker_enabled AND platform enabled (BOTWORKER_BACKENDS)
//              AND exact (platform, shop_id) shop.bot_worker_enabled
//   - scope resolve 1 ครั้ง/pass → ทุก admission path กิน snapshot เดียวกัน (required arg)
//   - scope filter ผนวกเชิงโครงสร้าง ({$and:[base, $or-pair-filter]}) ไม่ทับ base query
//   - empty scope = structural deny-all (find คืน 0 แถวเสมอ)
//   - disabled rows ไม่ถูก claim/แก้ไข — poll + stale claim + stale buffer + wait-timeout เหมือนกัน
//   - enable-era/claim contract เดิม: pre-era rows ไม่ถูก admit; terminal claim ไม่ถูกเปิดใหม่;
//     retryable เดียว = stale in-flight claim ใน freshness window
//   - same-message replay (poll/buffer/recovery/restart/OFF→ON) → ≤1 claim, ≤1 provider, ≤1 reply

import { register } from "node:module";

// ⚡ register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-botworker-scope-gate-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-scope-gate-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Rt = typeof import("../src/backend/service/botworkerRuntime");
type ShopsRoute = typeof import("../src/app/api/shops/route");
type ShopIdRoute = typeof import("../src/app/api/shops/[id]/route");
type ConfigRoute = typeof import("../src/app/api/config/route");
type Buf = typeof import("../src/backend/service/bufferService");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mocks: Mocks;
let svc: Svc;
let rt: Rt;
let buf: Buf;
let shopsRoute: ShopsRoute;
let shopIdRoute: ShopIdRoute;
let configRoute: ConfigRoute;

const results: { name: string; ok: boolean; err?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  mocks.resetState();
  try { await svc.botWorkerService.clearPendingWork(); } catch { /* era may not exist */ }
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── seeds ──────────────────────────────────────────────────

const CLAIM_ID = (mid: string) => `botworker:claim:${mid}`;

function seedShop(shopId: string, platform: string, botWorkerEnabled?: boolean, opts?: {
  // ⚡ enable timestamp — default epoch (admit-anything cutoff); null = fail-closed case
  enabledAt?: Date | null;
}) {
  const doc: Record<string, unknown> = {
    shop_id: shopId, shopname: `Shop ${shopId}`, platform,
    connected: true, enabled_for_chat: false, created_at: new Date(), updated_at: new Date(),
  };
  if (botWorkerEnabled !== undefined) {
    doc.bot_worker_enabled = botWorkerEnabled;
    if (botWorkerEnabled === true) doc.bot_worker_enabled_at = opts?.enabledAt === null ? null : (opts?.enabledAt ?? new Date(0));
    else if (opts?.enabledAt !== undefined) doc.bot_worker_enabled_at = opts.enabledAt;
  }
  mocks.fakeColl("shops").push(doc);
}

function seedConv(conversationId: string, shopId = "shop_1", platform = "shopee") {
  mocks.fakeColl("conversations").push({
    conversation_id: conversationId, shop_id: shopId, platform,
    customer_id: `cust_${conversationId}`,
  });
}

function seedMsg(mid: string, conv: string, opts: {
  shop?: string; platform?: string; created?: Date; text?: string;
} = {}) {
  mocks.fakeColl("messages").push({
    message_id: mid, conversation_id: conv,
    shop_id: opts.shop ?? "shop_1", platform: opts.platform ?? "shopee",
    role: "user", direction: "in", text: opts.text ?? `text ${mid}`,
    customer_id: `cust_${conv}`,
    created_timestamp: opts.created ?? new Date(),
  });
}

function seedClaim(mid: string, opts: {
  conv?: string; shop?: string; platform?: string; status?: string | null;
  claimedAgoMs?: number | null; leaseExpired?: boolean; attempt?: number;
  outcome_type?: string; reply_ids?: string[];
}) {
  const now = Date.now();
  const doc: Record<string, unknown> = {
    _id: CLAIM_ID(mid), message_id: mid,
    conversation_id: opts.conv ?? `conv_${mid}`,
    shop_id: opts.shop ?? "shop_1", platform: opts.platform ?? "shopee",
    owner_id: "worker-dead", fencing_token: 1, attempt: opts.attempt ?? 1,
    lease_expires_at: new Date(now - 1000),  // expired → stale-claim path
    updated_at: new Date(now - 2000),
  };
  if (opts.status !== null) doc.status = opts.status ?? "processing";
  if (opts.claimedAgoMs !== null) doc.claimed_at = new Date(now - (opts.claimedAgoMs ?? 5000));
  if (opts.outcome_type) doc.outcome_type = opts.outcome_type;
  if (opts.reply_ids) doc.reply_ids = opts.reply_ids;
  mocks.fakeColl("chat_processing").push(doc);
}

function seedBufferRow(mid: string, conv: string, receivedAgoMs: number | null, opts: {
  shop?: string; platform?: string; msgCreated?: Date;
} = {}) {
  mocks.fakeColl("buffer_messages").push({
    message_id: mid, conversation_id: conv,
    shop_id: opts.shop ?? "shop_1", platform: opts.platform ?? "shopee",
    text: `msg ${mid}`, kind: "message", status: "buffered",
    ...(receivedAgoMs === null ? {} : { received_at: new Date(Date.now() - receivedAgoMs) }),
    // ⚡ Phase 2D correction — admission proof for delayed-execution/recovery gate
    msg_created_at: opts.msgCreated ?? new Date(), admitted_edge: new Date(0),
    claim_id: CLAIM_ID(mid), owner_id: "worker-dead", fencing_token: 1,
  });
}

/** dormant failed-batch row — payload retained for carry-forward replay */
function seedFailedRow(mid: string, conv: string, opts: {
  shop?: string; platform?: string; text?: string; raw?: unknown;
} = {}) {
  mocks.fakeColl("buffer_messages").push({
    message_id: mid, conversation_id: conv,
    shop_id: opts.shop ?? "shop_1", platform: opts.platform ?? "shopee",
    text: opts.text ?? `failed ${mid}`, kind: "message", status: "failed",
    raw_payload: opts.raw,
    received_at: new Date(Date.now() - 30000),
    msg_created_at: new Date(Date.now() - 30000), admitted_edge: new Date(0),
    claim_id: CLAIM_ID(mid), owner_id: "worker-dead", fencing_token: 1,
    error: "HTTP 429", failed_at: new Date(Date.now() - 30000),
  });
  // ⚠️ dormant claim counterpart = explicit seedClaim(status:"bot_failed") ที่ call site
}

function seedWaitWorkflow(wfId: string, shopId = "shop_1") {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: [shopId], platforms: ["shopee"], trigger_frequency: "every_time",
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

function seedParkedRun(runId: string, wfId: string, conv: string, shopId = "shop_1", opts?: {
  waitStartedAt?: Date;
}) {
  const parkedAt = opts?.waitStartedAt ?? new Date(Date.now() - 60000);
  mocks.fakeColl("workflow_runs").push({
    run_id: runId, workflow_id: wfId,
    conversation_id: conv, shop_id: shopId, platform: "shopee",
    customer_id: "cust_1",
    status: "waiting_for_reply", current_node_id: "w1",
    waiting_for: "next_message", wait_node_id: "w1",
    wait_started_at: parkedAt, wait_retry_count: 0,
    context: {}, test_source: "botworker",
    owner_id: "stale-owner", fencing_token: 5,
    lease_expires_at: new Date(Date.now() - 1000),
    started_at: new Date(Date.now() - 61000), updated_at: new Date(Date.now() - 60000),
    version: 1,
  });
}

// ── accessors ──────────────────────────────────────────────

const claimOf = (mid: string) =>
  mocks.fakeColl("chat_processing").find((d: any) => d._id === CLAIM_ID(mid));
const bufRow = (mid: string) =>
  mocks.fakeColl("buffer_messages").find((d: any) => d.message_id === mid);
const replies = () => mocks.fakeColl("shadow_replies");
const calls = () => mocks.state.calls.callBot;
const runOf = (runId: string) =>
  mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === runId);
const auditOf = (type: string) =>
  mocks.fakeColl("admin_logs").filter((d: any) => d.action_type === type);

/** scope ผ่าน production resolver — config จาก state หรือ override
 *  edge = in-memory global enable edge (epoch = admit-anything cutoff) */
async function scopeOf(overrides: Record<string, unknown> = {}, edge: Date | null = new Date(0)) {
  const cfg = { ...mocks.state.config, ...overrides };
  return svc.botWorkerService.resolveBotworkerScope(cfg as never, edge);
}

const pairKeys = (scope: { pairs: { platform: string; shop_id: string }[] }) =>
  scope.pairs.map((p) => `${p.platform}/${p.shop_id}`).sort();

async function drain() {
  for (let i = 0; i < 30; i++) {
    await svc.botWorkerService.waitForInFlight(80).catch(() => {});
    await sleep(25);
    if (mocks.state.calls.botInFlight === 0) return;
  }
}

const REQ = (url: string, method: string, body?: unknown) =>
  new Request(`http://t${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// ══════════════════════════════════════════════════════════

async function main() {
  mocks = await import("./test-botworker-scope-gate-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  rt = await import("../src/backend/service/botworkerRuntime");
  buf = await import("../src/backend/service/bufferService");
  shopsRoute = await import("../src/app/api/shops/route");
  shopIdRoute = await import("../src/app/api/shops/[id]/route");
  configRoute = await import("../src/app/api/config/route");

  // ═══ C — scope resolver truth table ═══

  await test("C1 missing bot_worker_platforms → empty scope (fail-closed)", async () => {
    seedShop("s1", "shopee", true);
    const scope = await scopeOf({ bot_worker_platforms: undefined });
    assert(scope.pairs.length === 0, `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("C2 platform OFF + shop ON → empty scope", async () => {
    seedShop("s1", "shopee", true);
    const scope = await scopeOf({ bot_worker_platforms: { shopee: false, tiktok: false, lazada: false } });
    assert(scope.pairs.length === 0, `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("C3 platform ON + exact (platform,shop_id) ON → 1 pair; missing/false/other-platform excluded", async () => {
    seedShop("s1", "shopee", true);
    seedShop("s2", "shopee", false);
    seedShop("s3", "shopee");            // missing → OFF
    seedShop("t1", "tiktok", true);      // platform flag OFF → excluded
    seedShop("w1", "wechat" as never, true); // unknown platform → excluded
    const scope = await scopeOf();
    assert(JSON.stringify(pairKeys(scope)) === JSON.stringify(["shopee/s1"]),
      `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("C4 tiktok:true in config + tiktok shop ON → still empty (backend not implemented)", async () => {
    seedShop("t1", "tiktok", true);
    const scope = await scopeOf({ bot_worker_platforms: { shopee: false, tiktok: true, lazada: true } });
    assert(scope.pairs.length === 0, `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("C5 connected/enabled_for_chat must not grant eligibility", async () => {
    seedShop("s1", "shopee"); // missing bot_worker_enabled — connected/enabled_for_chat ไม่เกี่ยว
    mocks.fakeColl("shops").forEach((d: any) => { d.enabled_for_chat = true; });
    const scope = await scopeOf();
    assert(scope.pairs.length === 0, `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("C8 global OFF + platform/shop ON → resolver returns zero pairs (global inside scope owner)", async () => {
    seedShop("s1", "shopee", true);
    const scope = await scopeOf({ bot_worker_enabled: false });
    assert(scope.pairs.length === 0,
      `global OFF must yield empty scope: pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("C6 same shop_id on another platform must not inherit access", async () => {
    seedShop("dup", "shopee", true);
    seedShop("dup", "tiktok", true);
    const scope = await scopeOf();
    assert(JSON.stringify(pairKeys(scope)) === JSON.stringify(["shopee/dup"]),
      `pairs=${JSON.stringify(scope.pairs)}`);
  });

  // ═══ A — poll admission ═══

  await test("A1 in-scope shop admitted; other shops/platforms zero claim/buffer/provider", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_a1", "s1"); seedConv("conv_a2", "s2"); seedConv("conv_a3", "t1");
    seedMsg("m_a1", "conv_a1", { shop: "s1" });
    seedMsg("m_a2", "conv_a2", { shop: "s2" });
    seedMsg("m_a3", "conv_a3", { shop: "t1", platform: "tiktok" });
    const scope = await scopeOf();
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 1, `found=${r.found}`);
    assert(calls() === 1, `callBot=${calls()}`);
    assert(!!claimOf("m_a1"), "s1 claim missing");
    assert(claimOf("m_a1")!.status === "bot_answered", `claim=${claimOf("m_a1")!.status}`);
    assert(!claimOf("m_a2") && !claimOf("m_a3"), "disabled rows must not be claimed");
    assert(!bufRow("m_a2") && !bufRow("m_a3"), "disabled rows must not enter buffer");
    assert(replies().length === 1, `replies=${replies().length}`);
  });

  await test("A2 empty scope → structural deny-all: zero find results/claims/provider/replies", async () => {
    seedConv("conv_b1"); seedMsg("m_b1", "conv_b1");
    const scope = await scopeOf({ bot_worker_platforms: { shopee: false, tiktok: false, lazada: false } });
    const r = await svc.botWorkerService.pollNewMessages(scope);
    assert(r.found === 0, `found=${r.found}`);
    assert(mocks.fakeColl("chat_processing").length === 0, "claims must be 0");
    assert(calls() === 0 && replies().length === 0, "no provider/reply");
    const finds = mocks.queriesFor("messages").filter((q) => q.op === "find");
    assert(finds.length === 0 || finds.every((q) =>
      JSON.stringify(q.filter).includes('"shop_id":{"$in":[]}') ||
      JSON.stringify(q.filter).includes('"$in":[]')),
      "empty scope must not produce an unscoped find");
  });

  await test("A3 discovery query composed structurally: base conditions + scope retained", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_c1", "s1"); seedMsg("m_c1", "conv_c1", { shop: "s1" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    const f = mocks.queriesFor("messages").find((q) => q.op === "find")?.filter;
    assert(f, "no messages.find observed");
    const s = JSON.stringify(f);
    // base conditions retained (role/direction/era) — inside $and[0]
    assert(s.includes('"role":"user"') && s.includes('"direction":"in"'), `base dropped: ${s}`);
    assert(s.includes("created_timestamp"), `era boundary dropped: ${s}`);
    // scope pair-exact retained
    assert(s.includes('"platform":"shopee"') && s.includes("s1"), `scope dropped: ${s}`);
    assert(s.includes("$and"), `structural compose expected: ${s}`);
  });

  await test("A4 scope snapshot immutable per pass — later DB flip not observed mid-pass", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_d1", "s1"); seedMsg("m_d1", "conv_d1", { shop: "s1" });
    const scope = await scopeOf();
    // ปิด shop หลัง resolve — snapshot ของ pass นี้ต้องไม่เปลี่ยน
    mocks.fakeColl("shops").forEach((d: any) => { d.bot_worker_enabled = false; });
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 1 && calls() === 1, `snapshot violated: found=${r.found} calls=${calls()}`);
    // pass ถัดไปเห็น scope ใหม่
    const scope2 = await scopeOf();
    const r2 = await svc.botWorkerService.pollNewMessages(scope2);
    assert(r2.found === 0, `second pass must see disabled shop: found=${r2.found}`);
  });

  await test("A5 same shop_id on tiktok message not admitted by shopee pair", async () => {
    seedShop("dup", "shopee", true);
    seedConv("conv_e1", "dup", "tiktok");
    seedMsg("m_e1", "conv_e1", { shop: "dup", platform: "tiktok" });
    const scope = await scopeOf();
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 0 && calls() === 0 && !claimOf("m_e1"), "tiktok row must not be admitted");
  });

  await test("A6 global OFF → direct poll/recoverStaleBuffers/checkWaitTimeouts admit zero (real entry points)", async () => {
    // shop ON + platform ON — only the global switch is OFF; every admission path
    //   must still deny because the resolver folds global into the scope
    seedShop("shop_1", "shopee", true);
    seedConv("conv_g1"); seedMsg("m_g1", "conv_g1");                       // inbound poll candidate
    seedClaim("m_g2", { conv: "conv_g2", claimedAgoMs: 5000 });           // fresh stale claim
    seedBufferRow("m_g3", "conv_g3", 2000);                               // stale buffer row
    seedClaim("m_g3", { conv: "conv_g3", claimedAgoMs: 5000 });
    seedWaitWorkflow("wf_g1"); seedParkedRun("run_g1", "wf_g1", "conv_g4"); // parked run
    const scope = await scopeOf({ bot_worker_enabled: false });
    assert(scope.pairs.length === 0, `scope must be empty under global OFF: ${JSON.stringify(scope.pairs)}`);
    const poll = await svc.botWorkerService.pollNewMessages(scope);
    assert(poll.found === 0 && poll.processed === 0, `poll admitted: ${JSON.stringify(poll)}`);
    const rec = await svc.botWorkerService.recoverStaleBuffers(scope);
    assert(rec.recovered === 0, `recovery admitted: ${JSON.stringify(rec)}`);
    const n = await svc.botWorkerService.checkWaitTimeouts(scope);
    assert(n === 0, `wait-timeout admitted: ${n}`);
    await drain();
    assert(calls() === 0, `provider called: ${calls()}`);
    assert(replies().length === 0, "shadow reply written under global OFF");
    assert(mocks.fakeColl("chat_processing").every((d: any) => d.status === "processing"),
      "claims must be untouched");  // m_g2/m_g3 seeded processing; m_g1 must have no claim
    assert(!claimOf("m_g1"), "poll must not create a claim");
    assert(bufRow("m_g3")?.status === "buffered", "buffer row modified under global OFF");
    assert(runOf("run_g1")!.status === "waiting_for_reply", "parked run modified under global OFF");
  });

  // ═══ R — recovery admission ═══

  await test("R1 expired processing claim (no evidence) → reconcile to bot_failed, provider=0", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_r1", "s1"); seedMsg("m_r1", "conv_r1", { shop: "s1" });
    seedClaim("m_r1", { conv: "conv_r1", shop: "s1", claimedAgoMs: 5000 });
    const scope = await scopeOf();
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(calls() === 0, `recovery must never call provider: callBot=${calls()}`);
    const c = claimOf("m_r1")!;
    assert(c.status === "bot_failed", `interrupted claim must reconcile to bot_failed: ${c.status}`);
    assert(c.error === "interrupted_before_durable_outcome", `error=${c.error}`);
  });

  await test("R2 out-of-scope stale claim → untouched (still processing, same fencing)", async () => {
    seedShop("s1", "shopee", true);   // scope = s1 only
    seedMsg("m_r2", "conv_r2", { shop: "s2" });
    seedClaim("m_r2", { conv: "conv_r2", shop: "s2", claimedAgoMs: 5000 });
    const before = { ...claimOf("m_r2")! };
    const scope = await scopeOf();
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    const after = claimOf("m_r2")!;
    assert(after.status === "processing" && after.fencing_token === before.fencing_token,
      `disabled claim modified: ${JSON.stringify(after)}`);
    assert(calls() === 0 && replies().length === 0, "no provider/reply for disabled shop");
  });

  await test("R3 out-of-scope stale buffer row → untouched, no flush", async () => {
    seedShop("s1", "shopee", true);
    seedClaim("m_r3", { conv: "conv_r3", shop: "s2", claimedAgoMs: 5000 });
    seedBufferRow("m_r3", "conv_r3", 2000, { shop: "s2" });
    const scope = await scopeOf();
    const r = await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(r.recovered === 0, `recovered=${r.recovered}`);
    assert(bufRow("m_r3")?.status === "buffered", "disabled buffer row must stay untouched");
    assert(calls() === 0, `callBot=${calls()}`);
  });

  await test("R4 in-scope buffer row + interrupted claim → claim reconciled + row settled, provider=0", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_r4", "s1");
    seedClaim("m_r4", { conv: "conv_r4", shop: "s1", claimedAgoMs: 5000 });
    seedBufferRow("m_r4", "conv_r4", 2000, { shop: "s1" });
    const scope = await scopeOf();
    const r = await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(calls() === 0 && replies().length === 0, `recovery flush is gone: calls=${calls()}`);
    assert(claimOf("m_r4")!.status === "bot_failed", `claim=${claimOf("m_r4")!.status}`);
    assert(bufRow("m_r4")?.status === "failed", `row must settle to failed dormant: ${bufRow("m_r4")?.status}`);
  });

  await test("R5 out-of-scope parked workflow run → untouched, zero provider", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_r5", "s2");
    seedWaitWorkflow("wf_r5", "s2");
    seedParkedRun("run_r5", "wf_r5", "conv_r5", "s2");
    const scope = await scopeOf();
    const n = await svc.botWorkerService.checkWaitTimeouts(scope);
    await drain();
    assert(n === 0, `processed=${n}`);
    const run = runOf("run_r5")!;
    assert(run.status === "waiting_for_reply" && run.fencing_token === 5,
      `disabled run modified: ${JSON.stringify(run)}`);
    assert(calls() === 0, `callBot=${calls()}`);
  });

  await test("R6 in-scope parked run → timeout resume once", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_r6", "s1");
    seedWaitWorkflow("wf_r6", "s1");
    seedParkedRun("run_r6", "wf_r6", "conv_r6", "s1");
    const scope = await scopeOf();
    const n = await svc.botWorkerService.checkWaitTimeouts(scope);
    await drain();
    assert(n === 1, `processed=${n}`);
    assert(calls() === 1, `callBot=${calls()}`);
  });

  await test("R7 deny-all compose: base query with $or + empty scope → zero docs, nothing overwritten", async () => {
    seedShop("s1", "shopee", true);
    const emptyScope = await scopeOf({ bot_worker_platforms: { shopee: false, tiktok: false, lazada: false } });
    const base = { status: "processing", $or: [{ a: 1 }, { b: 2 }] };
    const scoped = rt.withScope(base as never, emptyScope);
    const s = JSON.stringify(scoped);
    assert(s.includes('"status":"processing"') && s.includes('"$or"'), `base lost: ${s}`);
    const coll = await mocks.getCollection("chat_processing");
    const found = await coll.find(scoped as never).toArray();
    assert(found.length === 0, "deny-all must match nothing");
    // ขนานกัน: scope ไม่ว่างต้อง retain ทั้ง base + pair
    const nonEmpty = await scopeOf();
    const full = rt.withScope(base as never, nonEmpty) as never;
    const s2 = JSON.stringify(full);
    assert(s2.includes('"status":"processing"') && s2.includes('"$or"') && s2.includes("s1"),
      `compose lost clauses: ${s2}`);
  });

  // ═══ I — same-message replay / idempotency ═══

  await test("I1 duplicate discovery in one cycle (2 docs same message_id) → 1 claim/1 provider/1 reply", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_i1", "s1");
    seedMsg("m_i1", "conv_i1", { shop: "s1" });
    mocks.fakeColl("messages").push({   // bypass uniqueKeys — writer-dup row
      message_id: "m_i1", conversation_id: "conv_i1", shop_id: "s1", platform: "shopee",
      role: "user", direction: "in", text: "dup", created_timestamp: new Date(),
    });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    assert(replies().length === 1, `replies=${replies().length}`);
    assert(mocks.fakeColl("chat_processing").filter((d: any) => d.message_id === "m_i1").length === 1,
      "exactly one claim doc");
  });

  await test("I2 poll + recovery see same expired claim concurrently → one reconciler, provider=0", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_i2", "s1"); seedMsg("m_i2", "conv_i2", { shop: "s1" });
    seedClaim("m_i2", { conv: "conv_i2", shop: "s1", claimedAgoMs: 5000 });
    const scope = await scopeOf();
    await Promise.all([
      svc.botWorkerService.pollNewMessages(scope),
      svc.botWorkerService.recoverStaleBuffers(scope),
    ]);
    await drain();
    assert(calls() === 0, `provider must not run for interrupted claim: callBot=${calls()}`);
    assert(claimOf("m_i2")!.status === "bot_failed", `claim=${claimOf("m_i2")!.status}`);
  });

  await test("I3 buffer + discovery concurrently → duplicate insert suppressed, single flush", async () => {
    seedShop("s1", "shopee", true);
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 40;
    seedConv("conv_i3", "s1"); seedMsg("m_i3", "conv_i3", { shop: "s1" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.pollNewMessages(scope); // same cycle dup
    await sleep(150); // debounce window
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    assert(replies().length === 1, `replies=${replies().length}`);
  });

  await test("I4 restart replay: terminal claim + poll again → zero reprocessing", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_i4", "s1"); seedMsg("m_i4", "conv_i4", { shop: "s1" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `first poll must process once (calls=${calls()})`);
    await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(calls() === 1 && replies().length === 1, `replay violated: calls=${calls()} replies=${replies().length}`);
  });

  await test("I5 shop OFF→ON: message admitted at most once across scope flips", async () => {
    seedShop("s1", "shopee", false);
    seedConv("conv_i5", "s1"); seedMsg("m_i5", "conv_i5", { shop: "s1", created: new Date(Date.now() - 5000) });
    const off = await scopeOf();
    await svc.botWorkerService.pollNewMessages(off);
    assert(calls() === 0 && !claimOf("m_i5"), "disabled shop must not be claimed");
    // enable edge = CAS write stamps enabled_at — message arrived pre-enable stays excluded
    const enableAt = new Date(Date.now() - 1000);
    mocks.fakeColl("shops").forEach((d: any) => { d.bot_worker_enabled = true; d.bot_worker_enabled_at = enableAt; });
    const on = await scopeOf();
    await svc.botWorkerService.pollNewMessages(on);
    seedMsg("m_i5_post", "conv_i5", { shop: "s1" });   // post-enable inbound
    await svc.botWorkerService.pollNewMessages(on);
    await svc.botWorkerService.pollNewMessages(on); // replay while ON
    await drain();
    assert(calls() === 1 && replies().length === 1, `calls=${calls()} replies=${replies().length}`);
    assert(!claimOf("m_i5"), "pre-enable message must never be admitted");
    assert(claimOf("m_i5_post")?.status === "bot_answered", "post-enable must be admitted");
  });

  await test("I6 platform OFF→ON: message admitted at most once", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_i6", "s1"); seedMsg("m_i6", "conv_i6", { shop: "s1" });
    const off = await scopeOf({ bot_worker_platforms: { shopee: false, tiktok: false, lazada: false } });
    await svc.botWorkerService.pollNewMessages(off);
    assert(calls() === 0, "platform OFF must not admit");
    const on = await scopeOf();
    await svc.botWorkerService.pollNewMessages(on);
    await svc.botWorkerService.pollNewMessages(on);
    await drain();
    assert(calls() === 1 && replies().length === 1, `calls=${calls()} replies=${replies().length}`);
  });

  await test("I7 global OFF→ON era: pre-era processed message never re-enters", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_i7", "s1"); seedMsg("m_i7", "conv_i7", { shop: "s1", created: new Date(Date.now() - 5000) });
    const era1 = new Date(Date.now() - 60000);
    const scope = await scopeOf({}, era1);
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `era1 process once (calls=${calls()})`);
    const era2 = new Date(); // global re-enable → new boundary (new scope snapshot)
    const scope2 = await scopeOf({}, era2);
    const r = await svc.botWorkerService.pollNewMessages(scope2);
    await drain();
    assert(r.found === 0 && calls() === 1 && replies().length === 1,
      `era2 replay violated: found=${r.found} calls=${calls()}`);
  });

  // ═══ H — historical / first-enable matrix ═══

  await test("H1 pre-era message + no processing record → not admitted", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_h1", "s1");
    seedMsg("m_h1", "conv_h1", { shop: "s1", created: new Date(Date.now() - 86400000) });
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 0 && calls() === 0 && !claimOf("m_h1"), "pre-era must not admit");
  });

  await test("H2 old message + claim missing status marker → not admitted", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_h2", "s1");
    seedMsg("m_h2", "conv_h2", { shop: "s1", created: new Date(Date.now() - 86400000) });
    seedClaim("m_h2", { conv: "conv_h2", shop: "s1", status: null, claimedAgoMs: 86400000 });
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(r.found === 0 && calls() === 0, `found=${r.found} calls=${calls()}`);
  });

  await test("H3 old message + empty status → not admitted", async () => {
    seedShop("s1", "shopee", true);
    seedMsg("m_h3", "conv_h3", { shop: "s1", created: new Date(Date.now() - 86400000) });
    seedClaim("m_h3", { conv: "conv_h3", shop: "s1", status: "", claimedAgoMs: 86400000 });
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(r.found === 0 && calls() === 0, `found=${r.found} calls=${calls()}`);
  });

  await test("H4 old message + unknown status/error → not admitted", async () => {
    seedShop("s1", "shopee", true);
    seedMsg("m_h4", "conv_h4", { shop: "s1", created: new Date(Date.now() - 86400000) });
    seedClaim("m_h4", { conv: "conv_h4", shop: "s1", status: "mystery", claimedAgoMs: 86400000 });
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(r.found === 0 && calls() === 0, `found=${r.found} calls=${calls()}`);
  });

  await test("H5 old completed (bot_answered) → never re-admitted", async () => {
    seedShop("s1", "shopee", true);
    seedMsg("m_h5", "conv_h5", { shop: "s1", created: new Date(Date.now() - 86400000) });
    seedClaim("m_h5", { conv: "conv_h5", shop: "s1", status: "bot_answered", claimedAgoMs: 86400000 });
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(r.found === 0 && calls() === 0 && replies().length === 0, "completed must stay terminal");
  });

  await test("H6 stale non-retryable claim beyond freshness → settled, never calls bot", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_h6", "s1"); seedMsg("m_h6", "conv_h6", { shop: "s1" });
    seedClaim("m_h6", { conv: "conv_h6", shop: "s1", claimedAgoMs: 86400000 });
    const scope = await scopeOf();
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    const c = claimOf("m_h6")!;
    assert(c.status === "bot_failed", `interrupted claim must reach canonical error terminal (got ${c.status})`);
    assert(calls() === 0 && replies().length === 0, "stale claim must not call bot");
  });

  await test("H7 permanent failure (bot_failed) → never retried by poll or recovery", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_h7", "s1"); seedMsg("m_h7", "conv_h7", { shop: "s1" });
    seedClaim("m_h7", { conv: "conv_h7", shop: "s1", status: "bot_failed", claimedAgoMs: 5000 });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(calls() === 0 && replies().length === 0, "bot_failed is terminal");
    assert(claimOf("m_h7")!.status === "bot_failed", "terminal status must remain");
  });

  await test("H8 interrupted in-flight claim → reconcile once to bot_failed, repeated passes stable", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_h8", "s1"); seedMsg("m_h8", "conv_h8", { shop: "s1" });
    seedClaim("m_h8", { conv: "conv_h8", shop: "s1", claimedAgoMs: 5000 });
    const scope = await scopeOf();
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(calls() === 0, `recovery never re-executes (calls=${calls()})`);
    assert(claimOf("m_h8")!.status === "bot_failed", `claim=${claimOf("m_h8")!.status}`);
  });

  await test("H9 interrupted claim visible via poll+recovery → single bot_failed winner, provider=0", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_h9", "s1"); seedMsg("m_h9", "conv_h9", { shop: "s1" });
    seedClaim("m_h9", { conv: "conv_h9", shop: "s1", claimedAgoMs: 5000 });
    const scope = await scopeOf();
    await Promise.all([
      svc.botWorkerService.pollNewMessages(scope),
      svc.botWorkerService.recoverStaleBuffers(scope),
      svc.botWorkerService.recoverStaleBuffers(scope),
    ]);
    await drain();
    assert(calls() === 0 && replies().length === 0, `calls=${calls()} replies=${replies().length}`);
    assert(claimOf("m_h9")!.status === "bot_failed", `claim=${claimOf("m_h9")!.status}`);
  });

  await test("H10 shop OFF→ON: pre-enable row stays out; post-enable inbound admitted once", async () => {
    seedShop("s1", "shopee", false);
    seedConv("conv_h10", "s1");
    seedMsg("m_h10_old", "conv_h10", { shop: "s1", created: new Date(Date.now() - 5000) }); // pre-enable
    const off = await scopeOf();
    await svc.botWorkerService.pollNewMessages(off);
    assert(calls() === 0, "disabled shop must not admit");
    // enable edge stamps enabled_at — ข้อความก่อน edge ไม่เข้า; หลัง edge เข้า
    const enableAt = new Date(Date.now() - 1000);
    mocks.fakeColl("shops").forEach((d: any) => { d.bot_worker_enabled = true; d.bot_worker_enabled_at = enableAt; });
    const on = await scopeOf();
    await svc.botWorkerService.pollNewMessages(on);
    seedMsg("m_h10_new", "conv_h10", { shop: "s1", created: new Date() });
    await svc.botWorkerService.pollNewMessages(on);
    await drain();
    assert(!claimOf("m_h10_old"), "pre-enable row must never be admitted");
    assert(claimOf("m_h10_new")?.status === "bot_answered", "post-enable inbound admitted once");
    assert(calls() === 1 && replies().length === 1, `calls=${calls()}`);
  });

  // ═══ CU — per-scope enable cutoff (clean-start contract) ═══

  await test("CU1 shop flag=true + enabled_at missing → fail-closed zero pairs", async () => {
    seedShop("s1", "shopee", true, { enabledAt: null });
    const scope = await scopeOf();
    assert(scope.pairs.length === 0, `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("CU2 platform flag=true + enabled_at missing → fail-closed zero pairs", async () => {
    seedShop("s1", "shopee", true);
    const scope = await scopeOf({ bot_worker_platform_enabled_at: { shopee: null } });
    assert(scope.pairs.length === 0, `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("CU3 global flag=true + edge missing → fail-closed zero pairs", async () => {
    seedShop("s1", "shopee", true);
    const scope = await scopeOf({}, null);
    assert(scope.pairs.length === 0, `pairs=${JSON.stringify(scope.pairs)}`);
  });

  await test("CU4 effective cutoff = max(global edge, platform_at, shop_at)", async () => {
    const g = new Date(1000), p = new Date(2000), s = new Date(3000);
    seedShop("s1", "shopee", true, { enabledAt: s });
    const scope = await scopeOf({ bot_worker_platform_enabled_at: { shopee: p } }, g);
    assert(scope.pairs.length === 1, `pairs=${JSON.stringify(scope.pairs)}`);
    assert(scope.pairs[0].cutoff.getTime() === 3000, `cutoff=${scope.pairs[0].cutoff?.toISOString()}`);
  });

  await test("CU5 poll admits only created_timestamp strictly > pair cutoff (<, ==, > boundaries)", async () => {
    const g = new Date(1000), p = new Date(2000), s = new Date(5000);
    seedShop("s1", "shopee", true, { enabledAt: s });
    seedConv("conv_cu5", "s1");
    seedMsg("m_pre", "conv_cu5", { shop: "s1", created: new Date(4999) });
    seedMsg("m_eq", "conv_cu5", { shop: "s1", created: new Date(5000) });
    seedMsg("m_post", "conv_cu5", { shop: "s1", created: new Date(5001) });
    const scope = await scopeOf({ bot_worker_platform_enabled_at: { shopee: p } }, g);
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 1 && calls() === 1, `found=${r.found} calls=${calls()}`);
    assert(claimOf("m_post")?.status === "bot_answered", "post-cutoff must be admitted");
    assert(!claimOf("m_pre") && !claimOf("m_eq"), "pre/equal-cutoff must never be claimed");
  });

  await test("CU6 shop re-enable stamps fresh cutoff — between-edge message excluded", async () => {
    const t0 = new Date(1000), t1 = new Date(9000);
    seedShop("s1", "shopee", true, { enabledAt: t0 });
    seedConv("conv_cu6", "s1");
    seedMsg("m_between", "conv_cu6", { shop: "s1", created: new Date(5000) }); // after 1st enable, before 2nd
    mocks.fakeColl("shops").forEach((d: any) => { d.bot_worker_enabled_at = t1; }); // re-enable → t1
    const scope = await scopeOf({}, new Date(0));
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 0 && calls() === 0, `found=${r.found} calls=${calls()}`);
    assert(!claimOf("m_between"), "between-edge message must be excluded by fresh cutoff");
  });

  await test("CU7 one year of historical inbound → opening worker admits zero", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_cu7", "s1");
    for (let i = 0; i < 50; i++) {
      seedMsg(`m_hist_${i}`, "conv_cu7", { shop: "s1", created: new Date(Date.now() - 31536000000 + i * 1000) });
    }
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 0 && calls() === 0 && replies().length === 0,
      `found=${r.found} calls=${calls()} replies=${replies().length}`);
    assert(mocks.fakeColl("chat_processing").length === 0, "no claims for historical rows");
  });

  // ═══ D — failed flush dormancy ═══

  await test("D1 technical flush failure → dormant failed state; no retry by poll/timer/restart/recovery", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 40;
    seedShop("s1", "shopee", true);
    seedConv("conv_d1", "s1"); seedMsg("m_d1", "conv_d1", { shop: "s1" });
    mocks.state.callBotError = new Error("HTTP 429");
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await sleep(200); // debounce → flush → technical failure
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    assert(claimOf("m_d1")!.status === "bot_failed", `claim=${claimOf("m_d1")!.status}`);
    assert(bufRow("m_d1")?.status === "failed", `row must be dormant failed: ${bufRow("m_d1")?.status}`);
    // no autonomous wake path may fire — 100 poll+recovery passes + wait past any retry timer
    for (let i = 0; i < 100; i++) {
      await svc.botWorkerService.pollNewMessages(scope);
      await svc.botWorkerService.recoverStaleBuffers(scope);
    }
    await sleep(200);
    await drain();
    assert(calls() === 1, `provider must stay 1 without new inbound: calls=${calls()}`);
    assert(replies().length === 0, "no reply may be persisted for failed batch");
  });

  await test("D2 unbuffered technical failure → dormant failed row retained", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_d2", "s1"); seedMsg("m_d2", "conv_d2", { shop: "s1" });
    mocks.state.callBotError = new Error("network error");
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    assert(claimOf("m_d2")!.status === "bot_failed", `claim=${claimOf("m_d2")!.status}`);
    assert(bufRow("m_d2")?.status === "failed", `unbuffered failure must retain dormant row: ${bufRow("m_d2")?.status}`);
  });

  // ═══ CF — error carry-forward on distinct new inbound ═══

  await test("CF1 dormant batch + new distinct inbound same conv → carry+debounce+1 combined call, old+new terminal", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_cf1", "s1");
    seedMsg("m_old", "conv_cf1", { shop: "s1", text: "old failed text" });
    seedMsg("m_new", "conv_cf1", { shop: "s1", text: "new text" });
    seedClaim("m_old", { conv: "conv_cf1", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old", "conv_cf1", { shop: "s1", text: "old failed text" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await sleep(250);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    const botMsg = JSON.stringify(mocks.state.callBotParams[0]);
    assert(botMsg.includes("old failed text") && botMsg.includes("new text"),
      `combined batch must carry original payload: ${botMsg}`);
    assert(claimOf("m_old")!.status === "bot_answered", `old=${claimOf("m_old")!.status}`);
    assert(claimOf("m_new")!.status === "bot_answered", `new=${claimOf("m_new")!.status}`);
    assert(!bufRow("m_old") && !bufRow("m_new"), "member rows must be deleted once");
    assert(replies().length === 1, `replies=${replies().length}`);
  });

  await test("CF2 new inbound in another conversation does not wake dormant batch", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_cf2a", "s1"); seedConv("conv_cf2b", "s1");
    seedMsg("m_other", "conv_cf2b", { shop: "s1" });
    seedClaim("m_old", { conv: "conv_cf2a", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old", "conv_cf2a", { shop: "s1" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    assert(claimOf("m_other")!.status === "bot_answered", "other conv msg processed independently");
    assert(claimOf("m_old")!.status === "bot_failed", "dormant batch must stay dormant");
    assert(bufRow("m_old")?.status === "failed", "row must stay failed");
  });

  await test("CF3 same conversation_id in another shop does not wake dormant batch", async () => {
    seedShop("s1", "shopee", true); seedShop("s2", "shopee", true);
    seedConv("shared_conv", "s2");
    seedMsg("m_s2", "shared_conv", { shop: "s2" });
    seedClaim("m_old", { conv: "shared_conv", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old", "shared_conv", { shop: "s1" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(claimOf("m_old")!.status === "bot_failed", "cross-shop dormant must not be carried");
    assert(bufRow("m_old")?.status === "failed", "row must stay failed");
  });

  await test("CF4 pre-cutoff inbound does not wake dormant batch", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_cf4", "s1");
    seedMsg("m_pre", "conv_cf4", { shop: "s1", created: new Date(Date.now() - 86400000) });
    seedClaim("m_old", { conv: "conv_cf4", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old", "conv_cf4", { shop: "s1" });
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 0, `callBot=${calls()}`);
    assert(bufRow("m_old")?.status === "failed", "row must stay failed");
    assert(claimOf("m_old")!.status === "bot_failed", "claim must stay bot_failed");
  });

  await test("CF5 attempt cap reached → batch quarantined; new inbound still processed independently", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_cf5", "s1");
    seedMsg("m_new5", "conv_cf5", { shop: "s1" });
    seedClaim("m_cap", { conv: "conv_cf5", shop: "s1", status: "bot_failed", attempt: 3 });
    seedFailedRow("m_cap", "conv_cf5", { shop: "s1" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    assert(claimOf("m_new5")!.status === "bot_answered", "new message must process");
    assert(claimOf("m_cap")!.status === "bot_failed", "capped claim stays terminal");
    assert(bufRow("m_cap")?.status === "quarantined", `exhausted batch must quarantine: ${bufRow("m_cap")?.status}`);
  });

  await test("CF6 combined retry fails again → dormant again, provider=2, no timer", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 40;
    seedShop("s1", "shopee", true);
    seedConv("conv_cf6", "s1");
    seedMsg("m_new6", "conv_cf6", { shop: "s1" });
    seedClaim("m_old6", { conv: "conv_cf6", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old6", "conv_cf6", { shop: "s1" });
    mocks.state.callBotError = new Error("HTTP 500");
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await sleep(200);
    await drain();
    assert(calls() === 1, `combined flush once: callBot=${calls()}`);
    assert(claimOf("m_old6")!.status === "bot_failed" && claimOf("m_new6")!.status === "bot_failed",
      "both members return to dormant failed");
    assert(bufRow("m_old6")?.status === "failed" && bufRow("m_new6")?.status === "failed",
      "both rows back to failed");
    await sleep(200); // beyond any retry timer
    await drain();
    assert(calls() === 1, `no autonomous retry: calls=${calls()}`);
  });

  await test("CF7 two concurrent new inbounds same conv → one carrier, one combined attempt", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_cf7", "s1");
    seedMsg("m_n1", "conv_cf7", { shop: "s1" });
    seedMsg("m_n2", "conv_cf7", { shop: "s1" });
    seedClaim("m_old7", { conv: "conv_cf7", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old7", "conv_cf7", { shop: "s1" });
    const scope = await scopeOf();
    await Promise.all([
      svc.botWorkerService.pollNewMessages(scope),
      svc.botWorkerService.pollNewMessages(scope),
    ]);
    await sleep(250);
    await drain();
    assert(calls() === 1, `one combined flush: callBot=${calls()}`);
    assert(replies().length === 1, `replies=${replies().length}`);
  });

  await test("CF8 media in failed batch preserved through carry-forward", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_cf8", "s1");
    seedMsg("m_new8", "conv_cf8", { shop: "s1", text: "new" });
    seedClaim("m_img", { conv: "conv_cf8", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_img", "conv_cf8", {
      shop: "s1",
      raw: { message_type: "image", content: { url: "https://img.example/x.png" } },
    });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await sleep(250);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    const imgs = mocks.state.callBotParams[0]?.images || [];
    assert(imgs.includes("https://img.example/x.png"), `carried media lost: ${JSON.stringify(imgs)}`);
  });

  await test("CF9 re-poll of the failed message_id itself does not wake dormant batch", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_cf9", "s1");
    seedMsg("m_old9", "conv_cf9", { shop: "s1" });
    seedClaim("m_old9", { conv: "conv_cf9", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old9", "conv_cf9", { shop: "s1" });
    const scope = await scopeOf();
    for (let i = 0; i < 100; i++) await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 0, `duplicate self-repoll must not wake: calls=${calls()}`);
    assert(bufRow("m_old9")?.status === "failed", "row stays failed");
  });

  await test("CF10 unbuffered dormant batch + new inbound → combined immediate flush", async () => {
    seedShop("s1", "shopee", true);   // bot_buffer_enabled=false
    seedConv("conv_cf10", "s1");
    seedMsg("m_new10", "conv_cf10", { shop: "s1", text: "new10" });
    seedClaim("m_old10", { conv: "conv_cf10", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_old10", "conv_cf10", { shop: "s1", text: "old10" });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    const botMsg = JSON.stringify(mocks.state.callBotParams[0]);
    assert(botMsg.includes("old10") && botMsg.includes("new10"),
      `combined batch expected: ${botMsg}`);
    assert(claimOf("m_old10")!.status === "bot_answered" && claimOf("m_new10")!.status === "bot_answered",
      "both members terminal");
  });

  // ═══ RE — recovery reconciliation-only extras ═══

  await test("RE1 claim with persisted outcome → finalize-only, provider=0", async () => {
    seedShop("s1", "shopee", true);
    seedMsg("m_re2", "conv_re2", { shop: "s1" });
    seedClaim("m_re2", { conv: "conv_re2", shop: "s1", claimedAgoMs: 5000, outcome_type: "bot_answered", reply_ids: [] });
    const scope = await scopeOf();
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(calls() === 0, `finalize-only must not call provider: ${calls()}`);
    assert(claimOf("m_re2")!.status === "bot_answered", `claim=${claimOf("m_re2")!.status}`);
  });

  await test("RE2 orphan buffer row (claim missing) → deleted, provider=0", async () => {
    seedShop("s1", "shopee", true);
    seedBufferRow("m_re3", "conv_re3", 2000, { shop: "s1" });
    const scope = await scopeOf();
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(calls() === 0 && !bufRow("m_re3"), "orphan row must be deleted without provider");
  });

  await test("RE3 pre-cutoff parked run → settled without provider resume", async () => {
    seedShop("s1", "shopee", true);
    seedConv("conv_re4", "s1");
    seedWaitWorkflow("wf_re4", "s1");
    seedParkedRun("run_re4", "wf_re4", "conv_re4", "s1", { waitStartedAt: new Date(Date.now() - 86400000) });
    const scope = await scopeOf({}, new Date(Date.now() - 60000));
    const n = await svc.botWorkerService.checkWaitTimeouts(scope);
    await drain();
    const run = runOf("run_re4")!;
    assert(run.status === "cancelled", `pre-cutoff run must settle: ${run.status}`);
    assert(calls() === 0, `provider=${calls()}`);
  });

  await test("R8 recovery re-run joined by newer scope — pre-new-cutoff row settles no_action (not dormant)", async () => {
    // ⚡ joiner mechanics: คำขอแรกกำลังวิ่งอยู่ → คำขอสองเข้ามา → rerun เดียว
    //   ที่ใช้ scope ล่าสุด (passScope) — classification ต้องตาม scope ล่าสุดเช่นกัน
    //   ไม่งั้น row ที่ถูก supersede โดย edge ใหม่จะกลายเป็น dormant carryable ผิด
    seedShop("s1", "shopee", true);             // enabled_at = epoch → in scope since era
    seedConv("conv_r8", "s1");
    seedMsg("m_r8", "conv_r8", { shop: "s1" }); // created now
    seedClaim("m_r8", { conv: "conv_r8", shop: "s1" });            // expired lease, foreign owner
    seedBufferRow("m_r8", "conv_r8", 0, { shop: "s1" });           // buffered w/ admission proof
    const scope1 = await scopeOf();             // cutoff = epoch → row admissible
    // re-enable shop → fresh edge AFTER the row's msg_created_at
    const doc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "s1")!;
    doc.bot_worker_enabled_at = new Date(Date.now() + 60_000);
    const scope2 = await scopeOf();             // cutoff ≈ +60s → row pre-cutoff under scope2
    await Promise.all([
      svc.botWorkerService.recoverStaleBuffers(scope1),
      svc.botWorkerService.recoverStaleBuffers(scope2), // joiner → single rerun, passScope=scope2
    ]);
    assert(calls() === 0, `provider=${calls()}`);
    assert(claimOf("m_r8")?.status === "no_action",
      `scope-superseded claim must settle no_action, got ${claimOf("m_r8")?.status}`);
    assert(bufRow("m_r8") === undefined,
      "pre-new-cutoff row must be deleted — not left dormant/carryable");
  });

  // ═══ X — API ═══

  await test("X1 PUT /api/config rejects bot_worker_platforms.tiktok=true (backend unimplemented)", async () => {
    const res = await configRoute.PUT(REQ("/api/config", "PUT", {
      bot_worker_platforms: { tiktok: true },
      expected_bot_worker_platforms: { tiktok: false },
    }) as never);
    assert(res.status === 422 || res.status === 400, `status=${res.status}`);
    assert(mocks.state.config.bot_worker_platforms.tiktok === false, "must not persist");
  });

  await test("X2 PUT /api/config rejects bot_worker_platforms.lazada=true", async () => {
    const res = await configRoute.PUT(REQ("/api/config", "PUT", {
      bot_worker_platforms: { lazada: true },
      expected_bot_worker_platforms: { lazada: false },
    }) as never);
    assert(res.status === 422 || res.status === 400, `status=${res.status}`);
    assert(mocks.state.config.bot_worker_platforms.lazada === false, "must not persist");
  });

  await test("X3 PUT {shopee:true} persists + config.update audit once", async () => {
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: false, lazada: false };
    const res = await configRoute.PUT(REQ("/api/config", "PUT", {
      bot_worker_platforms: { shopee: true },
      expected_bot_worker_platforms: { shopee: false },
    }) as never);
    assert(res.status === 200, `status=${res.status}`);
    assert(mocks.state.config.bot_worker_platforms.shopee === true, "not persisted");
    const logs = auditOf("config.update");
    assert(logs.length === 1, `audit=${logs.length}`);
  });

  await test("X4 PUT rejects unknown platform key + non-boolean + non-object", async () => {
    for (const body of [
      { bot_worker_platforms: { wechat: true } },
      { bot_worker_platforms: { shopee: "yes" } },
      { bot_worker_platforms: "yes" },
      { bot_worker_platforms: 42 },
    ]) {
      const res = await configRoute.PUT(REQ("/api/config", "PUT", body) as never);
      assert(res.status === 422 || res.status === 400, `body=${JSON.stringify(body)} status=${res.status}`);
    }
  });

  await test("X5 PATCH /api/shops/[id] bot_worker_enabled persists + shop_toggle audit (CAS)", async () => {
    seedShop("s1", "shopee", false);
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/s1", "PATCH",
        { bot_worker_enabled: true, expected_bot_worker_enabled: false }) as never,
      { params: Promise.resolve({ id: "s1" }) }
    );
    assert(res.status === 200, `status=${res.status}`);
    const doc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "s1")!;
    assert(doc.bot_worker_enabled === true, "not persisted");
    const logs = auditOf("config.shop_toggle");
    assert(logs.length === 1 && JSON.stringify(logs[0].metadata).includes("bot_worker_enabled"),
      `audit=${JSON.stringify(logs)}`);
  });

  await test("X6 PATCH unauthorized → rejected, no write, no audit", async () => {
    seedShop("s1", "shopee", false);
    mocks.state.authOk = false;
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/s1", "PATCH",
        { bot_worker_enabled: true, expected_bot_worker_enabled: false }) as never,
      { params: Promise.resolve({ id: "s1" }) }
    );
    assert(res.status === 403 || res.status === 401, `status=${res.status}`);
    assert(mocks.fakeColl("shops").find((d: any) => d.shop_id === "s1")!.bot_worker_enabled === false,
      "unauthorized write must not persist");
    assert(auditOf("config.shop_toggle").length === 0, "no audit on rejection");
  });

  await test("X7b PATCH connected-only preserved (existing behavior unchanged)", async () => {
    seedShop("s1", "shopee", false);
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/s1", "PATCH", { connected: false }) as never,
      { params: Promise.resolve({ id: "s1" }) }
    );
    assert(res.status === 200, `status=${res.status}`);
    const doc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "s1")!;
    assert(doc.connected === false && doc.bot_worker_enabled === false, "only connected must flip");
    const logs = auditOf("config.shop_toggle");
    assert(logs.length === 1 && logs[0].metadata.field === "connected", `audit=${JSON.stringify(logs)}`);
  });

  await test("X13 PATCH combined connected + bot_worker_enabled → 422, zero write, zero audit", async () => {
    // ⚡ CAS round — one request = one command: mixed command rejected ก่อน write
    //   (ไม่มี production caller ต้องการ combined — partial-write path ถูกลบ)
    seedShop("s1", "shopee", false);
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/s1", "PATCH",
        { connected: true, bot_worker_enabled: true, expected_bot_worker_enabled: false }) as never,
      { params: Promise.resolve({ id: "s1" }) }
    );
    assert(res.status === 422, `status=${res.status}`);
    const doc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "s1")!;
    assert(doc.connected === true && doc.bot_worker_enabled === false,
      `nothing may persist: ${JSON.stringify(doc)}`);
    assert(auditOf("config.shop_toggle").length === 0, "must not audit a rejected write");
  });

  await test("X7 PATCH bot_worker_enabled non-boolean → 400", async () => {
    seedShop("s1", "shopee", false);
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/s1", "PATCH",
        { bot_worker_enabled: "yes", expected_bot_worker_enabled: false }) as never,
      { params: Promise.resolve({ id: "s1" }) }
    );
    assert(res.status === 400 || res.status === 422, `status=${res.status}`);
  });

  await test("X8 GET /api/shops embeds bot_worker meta + row flag", async () => {
    seedShop("s1", "shopee", true);
    seedShop("s2", "shopee");
    const res = await shopsRoute.GET(REQ("/api/shops?page=1&pageSize=10", "GET") as never);
    const body = await res.json();
    const s1 = body.rows.find((r: any) => r.shop_id === "s1");
    const s2 = body.rows.find((r: any) => r.shop_id === "s2");
    assert(s1.bot_worker_enabled === true, "row flag missing");
    assert(s2.bot_worker_enabled !== true, "missing field must read OFF");
    assert(body.bot_worker?.global === true, `meta=${JSON.stringify(body.bot_worker)}`);
    assert(body.bot_worker?.platforms?.shopee === true, "platform flag missing");
    assert(Array.isArray(body.bot_worker?.implemented) && body.bot_worker.implemented.includes("shopee")
      && !body.bot_worker.implemented.includes("tiktok"), `implemented=${JSON.stringify(body.bot_worker?.implemented)}`);
  });

  await test("X9 PATCH bot_worker_enabled:true on tiktok shop → 422, zero write, zero audit", async () => {
    seedShop("tt1", "tiktok", false);
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/tt1", "PATCH",
        { bot_worker_enabled: true, expected_bot_worker_enabled: false }) as never,
      { params: Promise.resolve({ id: "tt1" }) }
    );
    assert(res.status === 422, `status=${res.status}`);
    const doc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "tt1")!;
    assert(doc.bot_worker_enabled === false || doc.bot_worker_enabled === undefined,
      `must not persist: ${JSON.stringify(doc.bot_worker_enabled)}`);
    assert(auditOf("config.shop_toggle").length === 0, "must not audit a rejected write");
  });

  await test("X10 PATCH bot_worker_enabled:true on lazada shop → 422, zero write, zero audit", async () => {
    seedShop("lz1", "lazada", false);
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/lz1", "PATCH",
        { bot_worker_enabled: true, expected_bot_worker_enabled: false }) as never,
      { params: Promise.resolve({ id: "lz1" }) }
    );
    assert(res.status === 422, `status=${res.status}`);
    const doc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "lz1")!;
    assert(doc.bot_worker_enabled === false || doc.bot_worker_enabled === undefined,
      `must not persist: ${JSON.stringify(doc.bot_worker_enabled)}`);
    assert(auditOf("config.shop_toggle").length === 0, "must not audit a rejected write");
  });

  await test("X11 PATCH bot_worker_enabled:false on unsupported platform stays allowed (disable latent flag)", async () => {
    seedShop("tt2", "tiktok", true);   // latent bad flag — must remain clearable
    const res = await shopIdRoute.PATCH(
      REQ("/api/shops/tt2", "PATCH",
        { bot_worker_enabled: false, expected_bot_worker_enabled: true }) as never,
      { params: Promise.resolve({ id: "tt2" }) }
    );
    assert(res.status === 200, `status=${res.status}`);
    const doc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "tt2")!;
    assert(doc.bot_worker_enabled === false, `must persist disable: ${JSON.stringify(doc.bot_worker_enabled)}`);
    const logs = auditOf("config.shop_toggle");
    assert(logs.length === 1 && logs[0].metadata.field === "bot_worker_enabled",
      `audit=${JSON.stringify(logs)}`);
  });

  await test("X12 bot_worker_platforms is single-command — multi-key/mixed payloads → 422 zero write", async () => {
    // ⚡ payload contract — platform toggle ต้องเป็น single-command (เหมือน PATCH shop):
    //   >1 platform key = partial-commit risk (key1 writes, key2 409 → half-applied)
    //   fields อื่นในคำสั่งเดียว ห้ามถูก drop เงียบๆ — reject ทั้งก้อนก่อน CAS เลย
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: false, lazada: false };
    const r1 = await configRoute.PUT(REQ("/api/config", "PUT", {
      bot_worker_platforms: { shopee: true, tiktok: false },
      expected_bot_worker_platforms: { shopee: false, tiktok: false },
    }) as never);
    assert(r1.status === 422, `multi-key payload must reject 422: ${r1.status}`);
    const r2 = await configRoute.PUT(REQ("/api/config", "PUT", {
      bot_worker_platforms: { shopee: true },
      expected_bot_worker_platforms: { shopee: false },
      bot_buffer_window_ms: 5000,
    }) as never);
    assert(r2.status === 422,
      `mixed payload must reject 422 — other fields must not be silently dropped: ${r2.status}`);
    assert(mocks.state.config.bot_worker_platforms.shopee === false,
      "rejected payload must persist nothing");
    assert(auditOf("config.update").length === 0, "zero audit on rejection");
    // single-key path still works — real CAS applies
    const r3 = await configRoute.PUT(REQ("/api/config", "PUT", {
      bot_worker_platforms: { shopee: true },
      expected_bot_worker_platforms: { shopee: false },
    }) as never);
    assert(r3.status === 200, `single-key enable: ${r3.status}`);
    assert((mocks.state.config.bot_worker_platforms as Record<string, boolean>).shopee === true, "not persisted");
  });

  // ═══ X14–X17 — optimistic CAS on per-shop botworker write ═══
  //   contract: PATCH {bot_worker_enabled:next, expected_bot_worker_enabled:seen}
  //   write succeeds only if persisted === expected; miss → 409 zero write/zero audit;
  //   missing field ≡ false (canonical)

  const shopDoc = (id: string) =>
    mocks.fakeColl("shops").find((d: any) => d.shop_id === id);
  const shopWrites = () =>
    mocks.state.queryLog.filter((q: any) => q.coll === "shops" && q.op === "updateOne");
  const PATCH_BW = (id: string, next: boolean, expected?: boolean) =>
    shopIdRoute.PATCH(
      REQ(`/api/shops/${id}`, "PATCH",
        expected === undefined
          ? { bot_worker_enabled: next }
          : { bot_worker_enabled: next, expected_bot_worker_enabled: expected }) as never,
      { params: Promise.resolve({ id }) }
    );

  await test("X14a CAS false→true expected=false → 200 + persist + exactly 1 update + 1 audit", async () => {
    seedShop("s1", "shopee", false);
    const res = await PATCH_BW("s1", true, false);
    assert(res.status === 200, `status=${res.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === true, "not persisted");
    assert(shopWrites().length === 1, `CAS write must be a single updateOne: ${shopWrites().length}`);
    assert(auditOf("config.shop_toggle").length === 1, "exactly one audit on success");
  });

  await test("X14b CAS true→false expected=true → 200 + persist + 1 audit", async () => {
    seedShop("s1", "shopee", true);
    const res = await PATCH_BW("s1", false, true);
    assert(res.status === 200, `status=${res.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === false, "not persisted");
    assert(auditOf("config.shop_toggle").length === 1, "exactly one audit on success");
  });

  await test("X14c missing field ≡ false — expected=false → set true → 200", async () => {
    seedShop("s1", "shopee"); // no bot_worker_enabled field at all
    const res = await PATCH_BW("s1", true, false);
    assert(res.status === 200, `status=${res.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === true, "missing field must be writable via expected=false");
  });

  await test("X14d missing field + expected=true → 409 zero write/audit", async () => {
    seedShop("s1", "shopee"); // missing ≡ false — expected true can never match
    const res = await PATCH_BW("s1", true, true);
    assert(res.status === 409, `status=${res.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === undefined, "CAS miss must not write");
    assert(auditOf("config.shop_toggle").length === 0, "no audit on conflict");
  });

  await test("X14e persisted≠expected → 409 unchanged, zero audit, zero write (probe miss)", async () => {
    seedShop("s1", "shopee", true);
    const res = await PATCH_BW("s1", false, false); // caller saw false; doc is true
    assert(res.status === 409, `status=${res.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === true, "value must be unchanged");
    assert(auditOf("config.shop_toggle").length === 0, "no audit on conflict");
    // enabled===expected → zero-write probe (findOne) — miss → no updateOne at all
    assert(shopWrites().length === 0, `idempotent-intent miss must not write: ${shopWrites().length}`);
  });

  await test("X14f idempotent enable (true, expected=true) → 200 no-op — edge must not move, zero write", async () => {
    // ⚡ repeated idempotent enable ต้องไม่ restamp bot_worker_enabled_at —
    //   edge ขยับ = buffered rows ที่ admitted แล้วถูก supersede โดยไม่ตั้งใจ
    const t0 = new Date(Date.now() - 60_000);
    seedShop("s1", "shopee", true, { enabledAt: t0 });
    const writes1 = shopWrites().length;
    const res = await PATCH_BW("s1", true, true);
    assert(res.status === 200, `idempotent enable: ${res.status}`);
    assert((shopDoc("s1")!.bot_worker_enabled_at as Date).getTime() === t0.getTime(),
      `enable edge must not move: ${shopDoc("s1")!.bot_worker_enabled_at}`);
    assert(shopWrites().length === writes1, "idempotent enable must be zero-write (probe only)");
  });

  await test("X14g enable with stale expectation (true, expected=true) while OFF → 409 zero write", async () => {
    seedShop("s1", "shopee", false);
    const res = await PATCH_BW("s1", true, true);
    assert(res.status === 409, `stale expectation → 409, got ${res.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === false, "no write on stale expectation");
    assert(auditOf("config.shop_toggle").length === 0, "no audit on conflict");
  });

  await test("X15 two stale callers, same expected → one winner + one 409, final value winner's", async () => {
    // Admin A และ B เห็น false พร้อมกัน → ทั้งคู่ส่ง {true, expected:false}
    //   (sequential = interleaving เดียวกัน: CAS ที่สองประเมินหลัง write แรก persist แล้ว)
    seedShop("s1", "shopee", false);
    const r1 = await PATCH_BW("s1", true, false);
    const r2 = await PATCH_BW("s1", true, false);
    assert(r1.status === 200 && r2.status === 409,
      `one winner + one loser: r1=${r1.status} r2=${r2.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === true, "winner's value stands");
    assert(auditOf("config.shop_toggle").length === 1,
      "exactly one audit — duplicate audit prevented");
  });

  await test("X16 different shops CAS independently (no cross-shop lock)", async () => {
    seedShop("sa", "shopee", false);
    seedShop("sb", "shopee", false);
    const ra = await PATCH_BW("sa", true, false);
    const rb = await PATCH_BW("sb", true, false);
    assert(ra.status === 200 && rb.status === 200, `ra=${ra.status} rb=${rb.status}`);
    assert(shopDoc("sa")!.bot_worker_enabled === true && shopDoc("sb")!.bot_worker_enabled === true,
      "both must persist");
    assert(auditOf("config.shop_toggle").length === 2, "one audit per shop");
  });

  await test("X17 missing/non-boolean expected_bot_worker_enabled → 400 zero write/audit", async () => {
    seedShop("s1", "shopee", false);
    for (const body of [
      { bot_worker_enabled: true },                                   // missing
      { bot_worker_enabled: true, expected_bot_worker_enabled: "yes" }, // non-boolean
      { bot_worker_enabled: true, expected_bot_worker_enabled: 1 },     // non-boolean
    ]) {
      const res = await shopIdRoute.PATCH(
        REQ("/api/shops/s1", "PATCH", body) as never,
        { params: Promise.resolve({ id: "s1" }) }
      );
      assert(res.status === 400 || res.status === 422,
        `body=${JSON.stringify(body)} status=${res.status}`);
    }
    assert(shopDoc("s1")!.bot_worker_enabled === false, "no write without expected");
    assert(auditOf("config.shop_toggle").length === 0, "no audit on rejected shapes");
  });

  // ═══ X18–X20 — platform fence ใน CAS filter ═══
  //   route pre-read เห็น platform เก่า → sync flip ก่อน updateOne → enable ต้องไม่ persist

  await test("X18 platform flip shopee→tiktok between pre-read and CAS → 422, zero write/audit, 1 attempt", async () => {
    seedShop("s1", "shopee", false);
    let armed = true;
    // ⚡ simulate external shop sync: flip platform หลัง route อ่านแล้ว ก่อน updateOne evaluate
    mocks.state.updateOneHook = async (coll: string) => {
      if (armed && coll === "shops") { armed = false; shopDoc("s1")!.platform = "tiktok"; }
    };
    try {
      const res = await PATCH_BW("s1", true, false);
      assert(res.status === 422, `status=${res.status}`);
      assert(shopDoc("s1")!.bot_worker_enabled === false,
        "enable on now-unsupported platform must not persist");
      assert(auditOf("config.shop_toggle").length === 0, "no audit on fenced write");
      assert(shopWrites().length === 1,
        `exactly one CAS attempt — no retry: ${shopWrites().length}`);
    } finally {
      mocks.state.updateOneHook = null;
    }
  });

  await test("X19 disable latent true on unsupported platform — no platform fence on disable → 200", async () => {
    seedShop("tt2", "tiktok", true); // latent flag — operator ต้อง clear ได้เสมอ
    const res = await PATCH_BW("tt2", false, true);
    assert(res.status === 200, `status=${res.status}`);
    assert(shopDoc("tt2")!.bot_worker_enabled === false, "latent flag must clear");
    assert(auditOf("config.shop_toggle").length === 1, "one audit on success");
    assert(shopWrites().length === 1, "single updateOne");
  });

  await test("X20 enable with stale expected (platform still supported) → 409 not 422", async () => {
    seedShop("s1", "shopee", true); // caller saw false, doc already true
    const res = await PATCH_BW("s1", true, false);
    assert(res.status === 409, `stale expected must be 409 not 422: status=${res.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled === true, "value unchanged");
    assert(auditOf("config.shop_toggle").length === 0, "no audit on conflict");
  });

  // ═══ X21–X22 — enable timestamp atomic writers ═══

  await test("X21 PATCH shop enable stamps bot_worker_enabled_at; disable clears it", async () => {
    seedShop("s1", "shopee", false);
    const r1 = await PATCH_BW("s1", true, false);
    assert(r1.status === 200, `enable: ${r1.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled_at instanceof Date,
      `enable must stamp enabled_at: ${JSON.stringify(shopDoc("s1")!.bot_worker_enabled_at)}`);
    const r2 = await PATCH_BW("s1", false, true);
    assert(r2.status === 200, `disable: ${r2.status}`);
    assert(shopDoc("s1")!.bot_worker_enabled_at == null,
      `disable must clear enabled_at: ${JSON.stringify(shopDoc("s1")!.bot_worker_enabled_at)}`);
    // re-enable → new timestamp (fresh cutoff each edge)
    const r3 = await PATCH_BW("s1", true, false);
    assert(r3.status === 200 && shopDoc("s1")!.bot_worker_enabled_at instanceof Date,
      "re-enable must stamp a fresh edge");
  });

  await test("X22 PUT platform enable stamps bot_worker_platform_enabled_at; disable clears it", async () => {
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: false, lazada: false };
    mocks.state.config.bot_worker_platform_enabled_at = { shopee: null };
    const PUTP = (next: boolean, expected: boolean) =>
      configRoute.PUT(REQ("/api/config", "PUT", {
        bot_worker_platforms: { shopee: next },
        expected_bot_worker_platforms: { shopee: expected },
      }) as never);
    const r1 = await PUTP(true, false);
    assert(r1.status === 200, `enable: ${r1.status}`);
    const at1 = mocks.state.config.bot_worker_platform_enabled_at.shopee;
    assert(at1 instanceof Date, `enable must stamp platform enabled_at: ${JSON.stringify(at1)}`);
    // re-PUT while already true (expected=true) → idempotent no-op, edge preserved
    const r2 = await PUTP(true, true);
    assert(r2.status === 200, `re-put: ${r2.status}`);
    assert((mocks.state.config.bot_worker_platform_enabled_at.shopee as Date).getTime() === at1.getTime(),
      "true→true must preserve the original edge");
    const r3 = await PUTP(false, true);
    assert(r3.status === 200, `disable: ${r3.status}`);
    assert(mocks.state.config.bot_worker_platform_enabled_at.shopee == null,
      "disable must clear platform enabled_at");
  });

  // ═══ K — canary simulation (offline pin) ═══

  await test("K1 canary config: global ON + shopee ON + 1 shop ON → selected admitted only, all else untouched", async () => {
    seedShop("s1", "shopee", true);
    seedShop("s2", "shopee");          // OFF
    seedShop("t1", "tiktok", true);    // backend off anyway
    seedConv("conv_k1", "s1"); seedConv("conv_k2", "s2"); seedConv("conv_k3", "t1");
    seedMsg("m_k1", "conv_k1", { shop: "s1" });
    seedMsg("m_k2", "conv_k2", { shop: "s2" });
    seedMsg("m_k3", "conv_k3", { shop: "t1", platform: "tiktok" });
    mocks.state.config.bot_worker_enabled = true;
    mocks.state.config.bot_worker_platforms = { shopee: true, tiktok: false, lazada: false };
    mocks.state.config.workflow_enabled = false;
    mocks.state.config.bot_concurrency_limit = 1;
    const scope = await scopeOf();
    assert(JSON.stringify(pairKeys(scope)) === JSON.stringify(["shopee/s1"]),
      `canary scope: ${JSON.stringify(scope.pairs)}`);
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await svc.botWorkerService.checkWaitTimeouts(scope);
    await svc.botWorkerService.recoverStaleBuffers(scope);
    await drain();
    assert(r.found === 1 && calls() === 1 && replies().length === 1,
      `found=${r.found} calls=${calls()} replies=${replies().length}`);
    assert(claimOf("m_k1")?.status === "bot_answered", "selected shop must process");
    assert(!claimOf("m_k2") && !claimOf("m_k3"), "non-selected rows must stay unclaimed");
    // reply อยู่ใน shadow_replies เท่านั้น — platform delivery callsite = 0 (callBot mock = provider boundary)
    const rep = replies()[0] as any;
    assert(rep?.origin === "worker", `reply origin=${rep?.origin}`);
  });

  await test("K2 canary concurrency pin — scope.config.bot_concurrency_limit === 1", async () => {
    mocks.state.config.bot_concurrency_limit = 1;
    const scope = await scopeOf();
    assert((scope.config as Record<string, unknown>).bot_concurrency_limit === 1,
      "concurrency must flow through snapshot");
  });

  // ═══ SD — scope disabled between admission and debounce (correction PART B) ═══
  //   contract: the delayed flush boundary revalidates global+platform+exact-shop
  //   once — superseded ordinary buffered work settles terminal `no_action`
  //   (provider=0, row deleted, NOT carryable dormant); only a new inbound
  //   strictly after the fresh re-enable cutoff may execute.

  await test("SD1 exact shop disabled mid-debounce → settle no_action + delete row, provider=0", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_sd1", "s1");
    seedMsg("m_sd1", "conv_sd1", { shop: "s1", text: "sd1-old" });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    await svc.botWorkerService.waitForInFlight(2000).catch(() => {});
    assert(bufRow("m_sd1")?.status === "buffered", "admitted row must buffer");
    const shopDoc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "s1")!;
    shopDoc.bot_worker_enabled = false;
    shopDoc.bot_worker_enabled_at = null;
    await sleep(300); // debounce fires while scope is disabled
    await drain();
    assert(calls() === 0, `provider=${calls()}`);
    assert(replies().length === 0, "no reply may be produced");
    assert(bufRow("m_sd1") === undefined, "scope-superseded row must be deleted");
    assert(claimOf("m_sd1")!.status === "no_action",
      `claim must settle terminal no_action (not dormant bot_failed): ${claimOf("m_sd1")?.status}`);
  });

  await test("SD2 re-enable stamps fresh cutoff → old buffered work never runs; new post-cutoff inbound does", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_sd2", "s1");
    seedMsg("m_sd2old", "conv_sd2", { shop: "s1", text: "sd2-old" });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    const shopDoc = mocks.fakeColl("shops").find((d: any) => d.shop_id === "s1")!;
    shopDoc.bot_worker_enabled = false;
    shopDoc.bot_worker_enabled_at = null;
    await sleep(300);
    await drain();
    assert(calls() === 0, `provider=${calls()}`);
    // re-enable — fresh cutoff edge
    const freshEdge = new Date();
    shopDoc.bot_worker_enabled = true;
    shopDoc.bot_worker_enabled_at = freshEdge;
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    await sleep(300);
    await drain();
    assert(calls() === 0, `pre-cutoff work must never execute: calls=${calls()}`);
    assert(claimOf("m_sd2old")?.status === "no_action",
      "old claim must be terminal no_action — not carryable");
    // new inbound strictly after the fresh cutoff executes once, old text not carried
    seedMsg("m_sd2new", "conv_sd2", { shop: "s1", text: "sd2-new", created: new Date(Date.now() + 1000) });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    await sleep(300);
    await drain();
    assert(calls() === 1, `new post-cutoff inbound must execute once: calls=${calls()}`);
    const txt = String(mocks.state.callBotParams[0]?.message ?? "");
    assert(txt.includes("sd2-new") && !txt.includes("sd2-old"),
      `batch must contain only the new inbound: ${txt}`);
  });

  await test("SD3 platform disabled mid-debounce → settle no_action + delete row, provider=0", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_sd3", "s1");
    seedMsg("m_sd3", "conv_sd3", { shop: "s1" });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    await svc.botWorkerService.waitForInFlight(2000).catch(() => {});
    assert(bufRow("m_sd3")?.status === "buffered", "admitted row must buffer");
    mocks.state.config.bot_worker_platforms.shopee = false;
    mocks.state.config.bot_worker_platform_enabled_at = { shopee: null };
    await sleep(300);
    await drain();
    assert(calls() === 0, `provider=${calls()}`);
    assert(replies().length === 0, "no reply");
    assert(bufRow("m_sd3") === undefined, "row must be deleted");
    assert(claimOf("m_sd3")!.status === "no_action",
      `claim=${claimOf("m_sd3")?.status}`);
  });

  await test("SD4 global switch off mid-debounce → settle no_action, provider=0", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_sd4", "s1");
    seedMsg("m_sd4", "conv_sd4", { shop: "s1" });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    await svc.botWorkerService.waitForInFlight(2000).catch(() => {});
    assert(bufRow("m_sd4")?.status === "buffered", "admitted row must buffer");
    mocks.state.config.bot_worker_enabled = false;
    await sleep(300);
    await drain();
    assert(calls() === 0, `provider=${calls()}`);
    assert(bufRow("m_sd4") === undefined, "row must be deleted");
    assert(claimOf("m_sd4")!.status === "no_action",
      `claim=${claimOf("m_sd4")?.status}`);
  });

  // ═══ TP — exact (platform, shop_id, conversation_id) partition (PART C) ═══
  //   contract: timers/batches/rows are keyed by the full tuple — the same
  //   conversation_id on different shops/platforms must never merge.

  await test("TP1 same conversation_id on two shops → separate flushes, no cross-shop merge", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("sA", "shopee", true);
    seedShop("sB", "shopee", true);
    seedConv("conv_tp", "sA");
    seedConv("conv_tp", "sB");
    seedMsg("m_tpa", "conv_tp", { shop: "sA", text: "AAA_ONLY" });
    seedMsg("m_tpb", "conv_tp", { shop: "sB", text: "BBB_ONLY" });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    await sleep(300);
    await drain();
    assert(calls() === 2, `each tuple must flush separately: calls=${calls()}`);
    const texts = mocks.state.callBotParams.map((p: any) => String(p?.message ?? ""));
    const withA = texts.filter((t: string) => t.includes("AAA_ONLY"));
    const withB = texts.filter((t: string) => t.includes("BBB_ONLY"));
    assert(withA.length === 1 && withB.length === 1 && withA[0] !== withB[0],
      `cross-shop merge detected: ${JSON.stringify(texts)}`);
  });

  await test("TP2 same conversation_id across platforms → partitioned at pure buffer boundary", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_tp2", "s1");
    seedMsg("m_tp2s", "conv_tp2", { shop: "s1", text: "SHOPEE_TXT" });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    // tiktok leg — real self-owned claim + pure bufferOrProcess boundary call
    const self = rt.botworkerRuntime.ownerId;
    mocks.fakeColl("chat_processing").push({
      _id: CLAIM_ID("m_tp2t"), message_id: "m_tp2t", conversation_id: "conv_tp2",
      shop_id: "s1", platform: "tiktok", status: "processing",
      owner_id: self, fencing_token: 3, attempt: 1,
      claimed_at: new Date(), lease_expires_at: new Date(Date.now() + 300000), updated_at: new Date(),
    });
    await buf.bufferOrProcess({
      message_id: "m_tp2t", conversation_id: "conv_tp2", shop_id: "s1", platform: "tiktok",
      text: "TIKTOK_TXT", created_timestamp: new Date(), admitted_edge: new Date(0),
      claimContext: {
        claim_id: CLAIM_ID("m_tp2t"), claim_ids: [CLAIM_ID("m_tp2t")],
        owner_id: self, fencing_token: 3,
        lease_expires_at: new Date(Date.now() + 300000),
        batch_id: "b_tp2", message_ids: ["m_tp2t"], platform: "tiktok",
      },
    } as never,
      { bufferEnabled: true, bufferWindowMs: 60, bufferMaxMessages: 10 },
      svc.botWorkerService.processMessage, async () => {});
    await sleep(300);
    await drain();
    assert(calls() === 1, `only the enabled shopee tuple may execute: calls=${calls()}`);
    const txt = String(mocks.state.callBotParams[0]?.message ?? "");
    assert(txt.includes("SHOPEE_TXT") && !txt.includes("TIKTOK_TXT"),
      `cross-platform merge detected: ${txt}`);
  });

  // ═══ XP — platform enable-edge CAS (PART D) ═══
  //   contract: PUT {bot_worker_platforms:{p:next}, expected_bot_worker_platforms:{p:seen}}
  //   — the Mongo write filters on persisted===expected (missing ≡ false);
  //   stale caller → 409 zero write/zero audit; OFF→ON stamps enabled_at in the
  //   same write; idempotent true→true cannot move the edge; sibling platforms
  //   untouched.

  // ⚡ นับเฉพาะ production CAS attempt — mock bridge pre-sync เขียนด้วย
  //   bare {config_key} filter (ไม่มีเงื่อนไข platform) → ไม่นับ
  const sysWrites = () =>
    mocks.state.queryLog.filter((q: any) => q.coll === "system_configs" && q.op === "updateOne"
      && Object.keys(q.filter ?? {}).some((k: string) => k === "$or" || k.startsWith("bot_worker_platforms.")));
  const PUTP = (platform: string, next: boolean, expected?: boolean) =>
    configRoute.PUT(REQ("/api/config", "PUT", expected === undefined
      ? { bot_worker_platforms: { [platform]: next } }
      : { bot_worker_platforms: { [platform]: next },
          expected_bot_worker_platforms: { [platform]: expected } }) as never);

  await test("XP1 bot_worker_platforms without expected map → 400, zero write/audit", async () => {
    const res = await PUTP("shopee", true);
    assert(res.status === 400, `missing expected must be 400: ${res.status}`);
    assert(sysWrites().length === 0, "no config write");
    assert(auditOf("config.update").length === 0, "no audit");
  });

  await test("XP2 expected key missing/non-boolean/non-object → 400", async () => {
    for (const body of [
      { bot_worker_platforms: { shopee: true }, expected_bot_worker_platforms: {} },
      { bot_worker_platforms: { shopee: true }, expected_bot_worker_platforms: { shopee: "yes" } },
      { bot_worker_platforms: { shopee: true }, expected_bot_worker_platforms: "yes" },
    ]) {
      const res = await configRoute.PUT(REQ("/api/config", "PUT", body) as never);
      assert(res.status === 400, `body=${JSON.stringify(body)} status=${res.status}`);
    }
    assert(sysWrites().length === 0, "no config write");
  });

  await test("XP3 two stale callers → first wins 200, second 409 — zero write/audit, edge unmoved", async () => {
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: false, lazada: false };
    mocks.state.config.bot_worker_platform_enabled_at = {};
    const r1 = await PUTP("shopee", true, false);
    assert(r1.status === 200, `winner: ${r1.status}`);
    const at1 = mocks.state.config.bot_worker_platform_enabled_at.shopee;
    assert(at1 instanceof Date, "winner must stamp the enable edge");
    const writes1 = sysWrites().length;
    const r2 = await PUTP("shopee", true, false); // stale expected vs persisted true
    assert(r2.status === 409, `stale caller must get 409: ${r2.status}`);
    assert(sysWrites().length === writes1 + 1,
      "loser issues exactly one bounded CAS attempt — no retry");
    assert((mocks.state.config.bot_worker_platform_enabled_at.shopee as Date).getTime() === at1.getTime(),
      "loser must not move the enable edge");
    assert(auditOf("config.update").length === 1, "loser performs zero audit");
  });

  await test("XP4 idempotent re-enable (expected matches persisted) → 200 no-op, edge preserved, zero write", async () => {
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: false, lazada: false };
    mocks.state.config.bot_worker_platform_enabled_at = {};
    const r1 = await PUTP("shopee", true, false);
    assert(r1.status === 200, `enable: ${r1.status}`);
    const at1 = mocks.state.config.bot_worker_platform_enabled_at.shopee as Date;
    const writes1 = sysWrites().length;
    const audits1 = auditOf("config.update").length;
    const r2 = await PUTP("shopee", true, true); // already true → no-op
    assert(r2.status === 200, `idempotent re-enable: ${r2.status}`);
    assert(sysWrites().length === writes1, "no-op must perform zero write");
    assert(auditOf("config.update").length === audits1, "no-op must not audit");
    assert((mocks.state.config.bot_worker_platform_enabled_at.shopee as Date).getTime() === at1.getTime(),
      "idempotent enable must not move the edge");
  });

  await test("XP5 unsupported platform enable → 422 before CAS, zero write/audit", async () => {
    const res = await PUTP("tiktok", true, false);
    assert(res.status === 422, `status=${res.status}`);
    assert(sysWrites().length === 0, "no config write");
    assert(auditOf("config.update").length === 0, "no audit");
  });

  await test("XP6 disabling a latent unsupported value stays allowed", async () => {
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: true, lazada: false };
    mocks.state.config.bot_worker_platform_enabled_at = { tiktok: new Date(Date.now() - 5000) };
    const res = await PUTP("tiktok", false, true);
    assert(res.status === 200, `disable unsupported latent must be allowed: ${res.status}`);
    assert(mocks.state.config.bot_worker_platforms.tiktok === false, "must persist disable");
    assert(mocks.state.config.bot_worker_platform_enabled_at.tiktok == null, "disable clears edge");
  });

  await test("XP7 toggling one platform cannot overwrite another platform's state/edge", async () => {
    const ttEdge = new Date(Date.now() - 5000);
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: true, lazada: false };
    mocks.state.config.bot_worker_platform_enabled_at = { tiktok: ttEdge };
    const res = await PUTP("shopee", true, false);
    assert(res.status === 200, `status=${res.status}`);
    assert(mocks.state.config.bot_worker_platforms.tiktok === true, "sibling state must be untouched");
    assert((mocks.state.config.bot_worker_platform_enabled_at.tiktok as Date).getTime() === ttEdge.getTime(),
      "sibling edge must be untouched");
  });

  await test("XP8 idempotent intent with stale expectation → 409 (persisted verified, not assumed)", async () => {
    // ⚡ enabled===expected no-op ต้อง probe persisted จริง — caller คิดว่า ON อยู่แล้ว
    //   แต่ persisted=OFF → miss → 409 (ห้ามตอบ applied ลอยๆ ขณะ flag จริงเป็น false)
    mocks.state.config.bot_worker_platforms = { shopee: false, tiktok: false, lazada: false };
    const res = await PUTP("shopee", true, true);
    assert(res.status === 409, `stale expectation must 409: ${res.status}`);
    assert(mocks.state.config.bot_worker_platforms.shopee === false, "must not write on stale expectation");
    assert(auditOf("config.update").length === 0, "no audit on conflict");
  });

  // ═══ CF11–CF12 — media carry-forward per type (PART E pins) ═══
  //   CF8 covers `image` (content.url); these pin the other two media types —
  //   one image test is not proof of all three.

  await test("CF11 image_with_text media survives carry-forward into combined /chat payload", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_cf11", "s1");
    seedMsg("m_new11", "conv_cf11", { shop: "s1", text: "new" });
    seedClaim("m_iwt", { conv: "conv_cf11", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_iwt", "conv_cf11", {
      shop: "s1",
      raw: { message_type: "image_with_text", content: { image_url: "https://img.example/iwt.png" } },
    });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await sleep(250);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    const imgs = mocks.state.callBotParams[0]?.images || [];
    assert(imgs.includes("https://img.example/iwt.png"), `image_with_text media lost: ${JSON.stringify(imgs)}`);
  });

  await test("CF12 video media survives carry-forward into combined /chat payload", async () => {
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 60;
    seedShop("s1", "shopee", true);
    seedConv("conv_cf12", "s1");
    seedMsg("m_new12", "conv_cf12", { shop: "s1", text: "new" });
    seedClaim("m_vid", { conv: "conv_cf12", shop: "s1", status: "bot_failed" });
    seedFailedRow("m_vid", "conv_cf12", {
      shop: "s1",
      raw: { message_type: "video", content: { video_url: "https://v.example/clip.mp4" } },
    });
    const scope = await scopeOf();
    await svc.botWorkerService.pollNewMessages(scope);
    await sleep(250);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    const imgs = mocks.state.callBotParams[0]?.images || [];
    assert(imgs.includes("https://v.example/clip.mp4"), `video media lost: ${JSON.stringify(imgs)}`);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length} passed, ${failed.length} failed (of ${results.length}) ===`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
