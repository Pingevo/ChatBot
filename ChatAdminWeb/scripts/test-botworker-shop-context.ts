// test-botworker-shop-context.ts — Botworker Shop Context + Single Dispatch
//
// รัน: npx tsx scripts/test-botworker-shop-context.ts
//
// Contract ภายใต้ทดสอบ:
//   scope pair = {platform, shop_id=transportShopId, config_shop_key=shops.shop_id,
//                 shopname, cutoff} — resolve ครั้งเดียวต่อ cycle
//   - shops row ที่ shop_id เป็น name-fallback → map ผ่าน (platform, shopname)
//     จาก conversations evidence เท่านั้น (1:1 เท่านั้น; missing/ambiguous → fail-closed)
//   - shops row ที่ shop_id เป็น canonical transport id → ทำงานต่อได้เหมือนเดิม
//   - poll/messages/claim/buffer/shadow = transportShopId;
//     workflow/trigger/assignment matching = config_shop_key; /chat shop = shopname
//   - dispatch owner เดียว (processClaimedMessage): resume → workflow → trigger → bot
//     matched-path error → bot_failed terminal — ห้าม fall through ไป LLM
//   - mapping query = 1 aggregate/resolve, 0 ต่อ message
//
// mock เฉพาะ leaf (hooks เดียวกับ scope-gate): mongoClient / botCallService /
//   systemConfigService / authorize — production modules ทำงานจริง

import { register } from "node:module";
import { readFileSync } from "node:fs";
register(new URL("./test-botworker-scope-gate-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-scope-gate-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mocks: Mocks;
let svc: Svc;

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

// shops row รูปแบบ production จริง: shop_id อาจเป็น name-fallback หรือ canonical id
function seedShop(shopId: string, platform: string, opts?: {
  shopname?: string; enabledAt?: Date | null; enabledForChat?: boolean;
}) {
  mocks.fakeColl("shops").push({
    shop_id: shopId, shopname: opts?.shopname ?? shopId, platform,
    connected: true, enabled_for_chat: opts?.enabledForChat === true,
    bot_worker_enabled: true,
    bot_worker_enabled_at: opts?.enabledAt === undefined ? new Date(0) : opts.enabledAt,
    created_at: new Date(), updated_at: new Date(),
  });
}

// conversation doc — shop_name optional (production: ~97% docs ไม่มี shop_name)
function seedConv(conversationId: string, shopId: string, platform = "shopee", shopName?: string) {
  const doc: Record<string, unknown> = {
    conversation_id: conversationId, shop_id: shopId, platform,
    customer_id: `cust_${conversationId}`,
  };
  if (shopName !== undefined) doc.shop_name = shopName;
  mocks.fakeColl("conversations").push(doc);
}

function seedMsg(mid: string, conv: string, opts: {
  shop?: string; platform?: string; created?: Date; text?: string; raw?: unknown;
} = {}) {
  mocks.fakeColl("messages").push({
    message_id: mid, conversation_id: conv,
    shop_id: opts.shop ?? "22997004", platform: opts.platform ?? "shopee",
    role: "user", direction: "in", text: opts.text ?? `text ${mid}`,
    customer_id: `cust_${conv}`,
    ...(opts.raw ? { raw_payload: opts.raw } : {}),
    created_timestamp: opts.created ?? new Date(),
  });
}

// workflow ที่ match keyword → action nodes (send_message = ไม่เรียก LLM)
function seedSendWorkflow(wfId: string, shopIds: string[], keyword: string) {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: shopIds, platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [keyword] }, position: { x: 0, y: 0 } },
      { node_id: "n2", type: "action", subtype: "send_message", config: { text: "wf reply" }, position: { x: 0, y: 0 } },
    ],
    edges: [{ edge_id: "e1", source_node_id: "n1", target_node_id: "n2" }],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

// workflow ที่ match แล้ว error กลาง run (matched-path failure — edge ชี้ node ที่ไม่มี)
function seedBrokenWorkflow(wfId: string, shopIds: string[], keyword: string) {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push({
    workflow_id: wfId, name: wfId, enabled: true, status: "published", is_deleted: false,
    shop_ids: shopIds, platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes: [
      { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: [keyword] }, position: { x: 0, y: 0 } },
    ],
    edges: [{ edge_id: "e1", source_node_id: "n1", target_node_id: "ghost" }],
    priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

function seedTrigger(triggerId: string, shopIds: string[], keyword: string, opts?: {
  action?: "bot_answer" | "handoff_admin"; botTemplate?: string;
}) {
  mocks.fakeColl("triggers").push({
    trigger_id: triggerId, name: triggerId, keywords: [keyword],
    shop_ids: shopIds, platforms: ["shopee"],
    action: opts?.action ?? "bot_answer",
    ...(opts?.botTemplate ? { bot_template: opts.botTemplate } : {}),
    enabled: true, created_by: "t", created_at: new Date(), updated_at: new Date(),
  });
}

// parked run ที่ชี้ workflow ถูกลบไปแล้ว → resumeFlow returns error (matched-path)
function seedOrphanedRun(runId: string, conv: string, shopId = "22997004") {
  mocks.fakeColl("workflow_runs").push({
    run_id: runId, workflow_id: "wf_deleted",
    conversation_id: conv, shop_id: shopId, platform: "shopee",
    status: "waiting_for_reply", current_node_id: "w1",
    waiting_for: "next_message", wait_node_id: "w1",
    wait_started_at: new Date(Date.now() - 60000), wait_retry_count: 0,
    context: {}, test_source: "botworker",
    owner_id: "stale-owner", fencing_token: 5,
    lease_expires_at: new Date(Date.now() - 1000),
    started_at: new Date(Date.now() - 61000), updated_at: new Date(Date.now() - 60000),
    version: 1,
  });
}

// ── helpers ────────────────────────────────────────────────

const claimOf = (mid: string) =>
  mocks.fakeColl("chat_processing").find((d: any) => d._id === CLAIM_ID(mid));
const replies = () => mocks.fakeColl("shadow_replies");
const calls = () => mocks.state.calls.callBot;
const botParams = () => mocks.state.callBotParams;

// SuperITMall production topology: shops.shop_id="SuperITMall" (name-fallback),
// transport identity "22997004" — mapping evidence = named conv doc
const SHOP_CFG = "SuperITMall";
const SHOP_TRANSPORT = "22997004";

function seedSuperITMall(opts?: { convNamed?: boolean }) {
  seedShop(SHOP_CFG, "shopee", { shopname: SHOP_CFG });
  // mapping evidence — doc ที่มี shop_name (production: 3/131 docs)
  seedConv("conv_map", SHOP_TRANSPORT, "shopee", SHOP_CFG);
  if (opts?.convNamed !== false) {
    // conversation จริงที่ลูกค้าทัก — production docs ส่วนใหญ่ไม่มี shop_name
    seedConv("conv_real", SHOP_TRANSPORT, "shopee");
  }
}

/** scope ผ่าน production resolver — edge epoch = admit-anything cutoff */
async function scopeOf(overrides: Record<string, unknown> = {}, edge: Date | null = new Date(0)) {
  const cfg = { ...mocks.state.config, ...overrides };
  return svc.botWorkerService.resolveBotworkerScope(cfg as never, edge);
}

async function drain() {
  for (let i = 0; i < 30; i++) {
    await svc.botWorkerService.waitForInFlight(80).catch(() => {});
    await sleep(25);
    if (mocks.state.calls.botInFlight === 0) return;
  }
}

// processMessage direct (bypass poll) — msg ที่ claim ผ่านแล้ว + ctx เหมือน flush ส่งมา
async function processWithCtx(mid: string, conv: string, opts?: {
  text?: string; raw?: unknown; ctx?: { config_shop_key: string; shopname?: string };
}) {
  return svc.processMessage({
    message_id: mid, conversation_id: conv,
    shop_id: SHOP_TRANSPORT, platform: "shopee",
    text: opts?.text ?? `text ${mid}`,
    ...(opts?.raw ? { raw_payload: opts.raw } : {}),
    ...(opts?.ctx ? { shop_ctx: opts.ctx } : {}),
  } as never);
}

// ══════════════════════════════════════════════════════════

async function main() {
  mocks = await import("./test-botworker-scope-gate-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");

  // ── A. scope mapping (platform,shopname)→transport, fail-closed ──
  await test("A1 name-fallback row resolves transport pair w/ config key + shopname", async () => {
    seedSuperITMall();
    const scope = await scopeOf();
    assert(scope.pairs.length === 1, `pairs=${scope.pairs.length} — name-fallback must resolve`);
    const p = scope.pairs[0];
    assert(p.shop_id === SHOP_TRANSPORT, `pair.shop_id=${p.shop_id} want ${SHOP_TRANSPORT}`);
    assert((p as any).config_shop_key === SHOP_CFG, `config_shop_key=${(p as any).config_shop_key} want ${SHOP_CFG}`);
    assert((p as any).shopname === SHOP_CFG, `shopname=${(p as any).shopname} want ${SHOP_CFG}`);
  });

  await test("A2 canonical shops row (shop_id=transport id) still resolves", async () => {
    seedShop("987863120", "shopee", { shopname: "CukTechThailand" });
    seedConv("conv_c", "987863120", "shopee", "CukTechThailand");
    const scope = await scopeOf();
    assert(scope.pairs.length === 1, `pairs=${scope.pairs.length}`);
    assert(scope.pairs[0].shop_id === "987863120", `pair.shop_id=${scope.pairs[0].shop_id}`);
    assert((scope.pairs[0] as any).config_shop_key === "987863120", "canonical config key = same id");
  });

  await test("A3 same shopname on another platform does not cross-match", async () => {
    // conv evidence มีแค่ฝั่ง tiktok — shopee row ชื่อเดียวกันห้าม map ข้าม platform
    seedShop(SHOP_CFG, "shopee", { shopname: SHOP_CFG });
    seedConv("conv_tt_evi", "tt_9001", "tiktok", SHOP_CFG);
    const scope = await scopeOf();
    assert(scope.pairs.length === 0, `pairs=${scope.pairs.length} — cross-platform map must fail closed`);
  });

  await test("A4 no conv mapping evidence → row excluded, zero admission", async () => {
    seedShop("NoConvShop", "shopee", { shopname: "NoConvShop" });
    seedMsg("m_a4", "conv_x", { shop: "99999" });
    const scope = await scopeOf();
    assert(scope.pairs.length === 0, `pairs=${scope.pairs.length}`);
    const r = await svc.botWorkerService.pollNewMessages(scope);
    assert(r.found === 0, `found=${r.found}`);
    assert(claims() === 0 && calls() === 0, "no claim/provider on unmapped shop");
  });

  await test("A5 multiple transport ids for one (platform,shopname) → fail closed", async () => {
    seedShop(SHOP_CFG, "shopee", { shopname: SHOP_CFG });
    seedConv("conv_map1", SHOP_TRANSPORT, "shopee", SHOP_CFG);
    seedConv("conv_map2", "22997005", "shopee", SHOP_CFG); // same name, second id
    seedMsg("m_a5", "conv_map1", { shop: SHOP_TRANSPORT });
    const scope = await scopeOf();
    assert(scope.pairs.length === 0, `pairs=${scope.pairs.length} — ambiguous must fail closed`);
    const r = await svc.botWorkerService.pollNewMessages(scope);
    assert(r.found === 0 && calls() === 0, "ambiguous shop must admit nothing");
  });

  await test("A6 mapping aggregate = 1/resolve; zero mapping queries per message", async () => {
    seedSuperITMall();
    seedMsg("m_a6", "conv_real", { shop: SHOP_TRANSPORT });
    mocks.state.queryLog.length = 0;
    const scope = await scopeOf();
    const aggDuringResolve = mocks.queriesFor("conversations").filter((q) => q.op === "aggregate").length;
    assert(aggDuringResolve === 1, `conv aggregate during resolve=${aggDuringResolve} want 1`);
    await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    const aggAfter = mocks.queriesFor("conversations").filter((q) => q.op === "aggregate").length;
    assert(aggAfter === 1, `conv aggregate after poll+process=${aggAfter} want 1 (0 per message)`);
  });

  // ── B. single dispatch owner — Workflow OR Trigger OR Bot ──
  const CTX = { config_shop_key: SHOP_CFG, shopname: SHOP_CFG };

  await test("B1 workflow hit (config key match) → workflow once; trigger/buffer/LLM = 0", async () => {
    seedSuperITMall();
    seedConv("conv_b1", SHOP_TRANSPORT, "shopee");
    seedSendWorkflow("wf_b1", [SHOP_CFG], "wfkw");
    // trigger ที่จะ match ถ้า dispatcher รั่ว — ต้องไม่ถูก execute
    seedTrigger("tr_b1", [SHOP_CFG], "wfkw", { action: "bot_answer" });
    const r = await processWithCtx("m_b1", "conv_b1", { text: "wfkw hello", ctx: CTX });
    assert(r.status === "workflow_actioned", `status=${r.status} ${r.detail}`);
    assert(calls() === 0, `callBot=${calls()} — workflow hit must not reach LLM`);
    assert(replies().filter((d: any) => d.trigger_id).length === 0,
      "trigger must not execute after workflow hit");
    assert(replies().length === 1, `replies=${replies().length} — workflow deliver reply exactly once`);
    const run = mocks.fakeColl("workflow_runs").find((d: any) => d.workflow_id === "wf_b1");
    assert(!!run, "workflow_runs evidence missing");
  });

  await test("B2 workflow miss + trigger template hit (config key) → trigger once; LLM=0", async () => {
    seedSuperITMall();
    seedConv("conv_b2", SHOP_TRANSPORT, "shopee");
    seedTrigger("tr_b2", [SHOP_CFG], "trkw", { action: "bot_answer", botTemplate: "tpl answer" });
    const r = await processWithCtx("m_b2", "conv_b2", { text: "trkw please", ctx: CTX });
    assert(r.status === "trigger_matched", `status=${r.status} ${r.detail}`);
    assert(calls() === 0, `callBot=${calls()} — bot_template must not reach LLM`);
    assert(replies().length === 1 && replies()[0].bot_reply_text === "tpl answer",
      `shadow reply missing template: ${JSON.stringify(replies().map((d: any) => d.bot_reply_text))}`);
  });

  await test("B3 no workflow/trigger hit → bot exactly once; shadow by transport id", async () => {
    seedSuperITMall();
    seedConv("conv_b3", SHOP_TRANSPORT, "shopee");
    const r = await processWithCtx("m_b3", "conv_b3", { text: "ordinary question", ctx: CTX });
    assert(r.status === "bot_answered", `status=${r.status} ${r.detail}`);
    assert(calls() === 1, `callBot=${calls()}`);
    assert(replies().length === 1 && replies()[0].shop_id === SHOP_TRANSPORT,
      `shadow reply shop_id=${replies()[0]?.shop_id} want ${SHOP_TRANSPORT}`);
    assert(botParams()[0]?.shopName === SHOP_CFG,
      `callBot shopName=${botParams()[0]?.shopName} want ${SHOP_CFG}`);
    assert(botParams()[0]?.shopId === SHOP_TRANSPORT,
      `callBot shopId=${botParams()[0]?.shopId} want ${SHOP_TRANSPORT}`);
  });

  await test("B4 matched workflow error → bot_failed terminal; LLM=0", async () => {
    seedSuperITMall();
    seedConv("conv_b4", SHOP_TRANSPORT, "shopee");
    seedBrokenWorkflow("wf_b4", [SHOP_CFG], "errkw");
    const r = await processWithCtx("m_b4", "conv_b4", { text: "errkw now", ctx: CTX });
    assert(r.status === "bot_failed", `status=${r.status} ${r.detail} — matched error must not fall to bot`);
    assert(calls() === 0, `callBot=${calls()} — matched-path failure must never reach LLM`);
    const c = claimOf("m_b4");
    assert(c?.status === "bot_failed", `claim=${c?.status}`);
  });

  await test("B4b resume error (orphaned active run) → bot_failed terminal; LLM=0", async () => {
    seedSuperITMall();
    seedConv("conv_b4b", SHOP_TRANSPORT, "shopee");
    seedOrphanedRun("wfr_b4b", "conv_b4b");
    mocks.state.config.workflow_enabled = true;
    const r = await processWithCtx("m_b4b", "conv_b4b", { text: "any text", ctx: CTX });
    assert(r.status === "bot_failed", `status=${r.status} ${r.detail} — resume failure must not fall to bot`);
    assert(calls() === 0, `callBot=${calls()} — matched-path failure must never reach LLM`);
  });

  await test("B5 trigger bot_answer error → bot_failed; exactly 1 LLM attempt", async () => {
    seedSuperITMall();
    seedConv("conv_b5", SHOP_TRANSPORT, "shopee");
    seedTrigger("tr_b5", [SHOP_CFG], "botkw", { action: "bot_answer" });
    mocks.state.callBotError = new Error("HTTP 500");
    const r = await processWithCtx("m_b5", "conv_b5", { text: "botkw ping", ctx: CTX });
    assert(r.status === "bot_failed", `status=${r.status} ${r.detail}`);
    assert(calls() === 1, `callBot=${calls()} — error must not re-dispatch`);
  });

  await test("B6 trigger handoff uses config key for assignment lookups", async () => {
    seedSuperITMall();
    mocks.fakeColl("shops")[0].enabled_for_chat = true; // pass selectNextAgent shop gate
    seedConv("conv_b6", SHOP_TRANSPORT, "shopee");
    seedTrigger("tr_b6", [SHOP_CFG], "handme", { action: "handoff_admin" });
    // assignment config: per-shop pool keyed by shops.shop_id (config domain)
    mocks.fakeColl("assignment_configs").push({
      config_key: "main_config", mode: "equal_per_shop",
      updated_by: "t", updated_at: new Date(),
    });
    mocks.fakeColl("admins").push({
      admin_id: "adm_1", role: "admin", active: true, is_accepting_chats: true,
      created_at: new Date(),
    });
    mocks.fakeColl("shop_team_assignments").push({
      shop_id: SHOP_CFG, admin_id: "adm_1", is_active: true,
      created_at: new Date(), updated_at: new Date(),
    });
    const r = await processWithCtx("m_b6", "conv_b6", { text: "handme admin", ctx: CTX });
    assert(r.status === "handed_off", `status=${r.status} ${r.detail}`);
    assert(calls() === 0, `callBot=${calls()}`);
    // config-domain queries (team assignments / shops findOne) ต้องถามด้วย config key
    // config-domain lookups (shops gate + team pool) ต้องถามด้วย config key
    //   transport id ห้ามรั่วเข้า config query เลย
    const shopQ = [...mocks.queriesFor("shop_team_assignments"), ...mocks.queriesFor("shops")]
      .map((q) => JSON.stringify(q.filter));
    assert(shopQ.some((f) => f.includes(SHOP_CFG)), `no config-key lookup: ${shopQ.join(" | ")}`);
    assert(shopQ.every((f) => !f.includes(SHOP_TRANSPORT)),
      "transport id leaked into config-domain lookup");
  });

  // ── C. idempotency + history boundary ──
  await test("C1 repeated poll of same message → one claim, one reply, one LLM", async () => {
    seedSuperITMall();
    seedMsg("m_c1", "conv_real", { shop: SHOP_TRANSPORT });
    const scope = await scopeOf();
    for (let i = 0; i < 3; i++) await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    assert(replies().length === 1, `replies=${replies().length}`);
    assert(claimOf("m_c1")?.status === "bot_answered", `claim=${claimOf("m_c1")?.status}`);
  });

  await test("C2 pre-edge message excluded; post-edge admitted once", async () => {
    seedSuperITMall({ convNamed: false });
    const edge = new Date(1000);
    seedMsg("m_old", "conv_real", { shop: SHOP_TRANSPORT, created: new Date(500) });
    seedMsg("m_new", "conv_real", { shop: SHOP_TRANSPORT, created: new Date(5000) });
    const scope = await scopeOf({}, edge);
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 1, `found=${r.found}`);
    assert(!claimOf("m_old"), "pre-edge message must never be claimed");
    assert(claimOf("m_new")?.status === "bot_answered", `claim=${claimOf("m_new")?.status}`);
    assert(calls() === 1, `callBot=${calls()}`);
  });

  // ── D. end-to-end SuperITMall — name-fallback → /chat → shadow → /botworker ──
  await test("D1 inbound msg@22997004 → claim → /chat shop=SuperITMall → shadow@22997004", async () => {
    seedSuperITMall(); // conv_real has NO shop_name — ctx must carry it
    seedMsg("m_d1", "conv_real", { shop: SHOP_TRANSPORT });
    const scope = await scopeOf();
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 1, `found=${r.found} — transport id must be admitted`);
    assert(claimOf("m_d1")?.status === "bot_answered", `claim=${claimOf("m_d1")?.status}`);
    assert(calls() === 1, `callBot=${calls()}`);
    // shopname ต้องมาจาก resolved context (shops row) — conv_real ไม่มี shop_name
    assert(botParams()[0]?.shopName === SHOP_CFG,
      `callBot shopName=${botParams()[0]?.shopName} — name must come from resolved ctx, not conv`);
    const rep = replies()[0];
    assert(rep?.shop_id === SHOP_TRANSPORT && rep?.platform === "shopee",
      `shadow reply identity=${rep?.shop_id}/${rep?.platform} — /botworker reads transport domain`);
    assert(rep?.conversation_id === "conv_real", `reply conv=${rep?.conversation_id}`);
    // poll filter ต้องใช้ transport id เสมอ — config key ห้ามเข้า messages query
    const f = mocks.queriesFor("messages").find((q) => q.op === "find")?.filter;
    const fs = JSON.stringify(f);
    assert(fs.includes(SHOP_TRANSPORT), `poll filter missing transport id: ${fs}`);
    assert(!fs.includes(`"${SHOP_CFG}"`), `config key leaked into transport filter: ${fs}`);
  });

  // ── E. media paths keep resolved context ──
  const MEDIA_RAW = (t: string, url: string) => ({ message_type: t, content: { url } });

  await test("E1 text/image/image_text/video admitted with resolved ctx → shopname to bot", async () => {
    seedSuperITMall();
    seedMsg("m_e1", "conv_real", { shop: SHOP_TRANSPORT, text: "plain text" });
    seedMsg("m_e2", "conv_real", { shop: SHOP_TRANSPORT, text: "[รูปภาพ]", raw: MEDIA_RAW("image", "https://img.example.com/a.png") });
    seedMsg("m_e3", "conv_real", { shop: SHOP_TRANSPORT, text: "with text", raw: MEDIA_RAW("image_with_text", "https://img.example.com/b.png") });
    seedMsg("m_e4", "conv_real", { shop: SHOP_TRANSPORT, text: "[วิดีโอ]", raw: MEDIA_RAW("video", "https://vid.example.com/c.mp4") });
    const scope = await scopeOf();
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 4, `found=${r.found} — all media types must admit`);
    assert(calls() === 4, `callBot=${calls()} — one dispatch per message`);
    assert(botParams().every((p: any) => p.shopName === SHOP_CFG),
      `shopname lost on media path: ${JSON.stringify(botParams().map((p: any) => p.shopName))}`);
    assert(replies().length === 4 && replies().every((d: any) => d.shop_id === SHOP_TRANSPORT),
      `shadow replies=${replies().length} must carry transport id`);
    // image url ต้องถึง bot (multimodal) — image/image_with_text/video
    assert(botParams().some((p: any) => Array.isArray(p.images) && p.images.length > 0),
      "media URLs must reach callBot images field");
  });

  // ── F. resolver query contract (H1 — review finding) ──
  //   หลักฐาน executable: aggregate ต้อง bounded ด้วย enabled-shop identities,
  //   ห้าม platform-only scan; 0 enabled rows → 0 conv query; resolve ≤1/pass
  await test("F1 conv aggregate $match bounded by enabled-shop identities only", async () => {
    seedSuperITMall();
    mocks.state.queryLog.length = 0;
    await scopeOf();
    const agg = mocks.queriesFor("conversations").filter((q) => q.op === "aggregate");
    assert(agg.length === 1, `aggregates=${agg.length} want 1`);
    const match = (agg[0].filter as any[])?.[0]?.$match;
    assert(Array.isArray(match?.$or) && match.$or.length > 0,
      `$match must be $or of per-candidate identity clauses — got ${JSON.stringify(match)}`);
    for (const clause of match.$or) {
      const keys = Object.keys(clause);
      assert(clause.platform === "shopee" && keys.length === 2,
        `each clause platform-qualified pair-keyed — got ${JSON.stringify(clause)}`);
      assert(clause.shop_id?.$in !== undefined || typeof clause.shop_name === "string",
        `clause must carry enabled-shop identity — got ${JSON.stringify(clause)}`);
      if (clause.shop_id?.$in) {
        assert(JSON.stringify(clause.shop_id.$in) === JSON.stringify([SHOP_CFG]),
          `shop_id candidates = enabled rows' values — got ${JSON.stringify(clause.shop_id.$in)}`);
      }
      if (typeof clause.shop_name === "string") {
        // ⚡ per-name eq term — partial index {platform,shop_name,shop_id} ใช้ได้
        //   เฉพาะ eq บนค่าคงที่ (prove $gt:"" ได้); $in ทำ index หลุด
        assert(clause.shop_name === SHOP_CFG,
          `shop_name candidate = enabled row's shopname — got ${clause.shop_name}`);
      }
    }
  });

  await test("F2 zero enabled shops → empty scope with ZERO conversations queries", async () => {
    mocks.state.queryLog.length = 0;
    const scope = await scopeOf();
    assert(scope.pairs.length === 0, `pairs=${scope.pairs.length}`);
    const convQ = mocks.queriesFor("conversations").length;
    assert(convQ === 0, `conversations queries=${convQ} — no enabled shops must skip mapping query`);
  });

  await test("F3 flush pass resolves scope exactly once regardless of row count", async () => {
    const buf = await import("../src/backend/service/bufferService");
    seedSuperITMall();
    mocks.state.config.bot_buffer_enabled = true;
    mocks.state.config.bot_buffer_window_ms = 40;
    const scope = await scopeOf();
    seedMsg("m_f3a", "conv_real", { shop: SHOP_TRANSPORT });
    seedMsg("m_f3b", "conv_real", { shop: SHOP_TRANSPORT });
    seedMsg("m_f3c", "conv_real", { shop: SHOP_TRANSPORT });
    const r = await svc.botWorkerService.pollNewMessages(scope);
    await drain();
    assert(r.found === 3, `found=${r.found}`);
    await sleep(300); // debounce flush
    const aggTotal = mocks.queriesFor("conversations").filter((q) => q.op === "aggregate").length;
    assert(aggTotal === 2, `conv aggregates=${aggTotal} — 1 cycle resolve + 1 flush resolve (3 rows share one pass)`);
  });

  // ── G. mandatory context (H2 — review finding) ──
  await test("G1 dispatcher source has no optional ctx / identity fallback", async () => {
    const src = readFileSync(new URL("../src/backend/service/botWorkerService.ts", import.meta.url), "utf8");
    assert(!/shop_ctx\?\s*:/.test(src), "shop_ctx must be required on the processing envelope");
    assert(!/shop_ctx\?\./.test(src), "dispatcher must not read ctx through optional chain");
    assert(!/configShopKey[^;]*\?\?\s*msg\.shop_id/.test(src), "no config-key ← transport-id fallback");
    assert(!/shopName[^;]*\?\?\s*\(?conv\?\.shop_name/.test(src), "no shopname ← conv.shop_name fallback");
  });

  await test("G2 enabled row without shopname → excluded fail-closed (ctx unconstructable)", async () => {
    mocks.fakeColl("shops").push({
      shop_id: "987863120", platform: "shopee", // NO shopname — contract violation
      connected: true, bot_worker_enabled: true, bot_worker_enabled_at: new Date(0),
    });
    seedConv("conv_g2", "987863120", "shopee");
    const scope = await scopeOf();
    assert(scope.pairs.length === 0,
      `pairs=${scope.pairs.length} — row without catalog key cannot own a shop context`);
  });

  await test("G3 processMessage without shop_ctx → fail closed, never reaches Workflow/Trigger/Bot", async () => {
    seedSuperITMall();
    mocks.fakeColl("conversations").push({
      conversation_id: "conv_g3", shop_id: SHOP_TRANSPORT, platform: "shopee",
      customer_id: "cust_g3",
    });
    // bypass type — กรณี production caller ลืมส่ง ctx ต้อง throw ที่ boundary (fail closed)
    let threw = false;
    try {
      await svc.processMessage({
        message_id: "m_g3", conversation_id: "conv_g3",
        shop_id: SHOP_TRANSPORT, platform: "shopee", text: "ctxless",
      } as never);
    } catch { threw = true; }
    assert(threw, "missing shop_ctx must throw at the processing boundary");
    assert(calls() === 0, `callBot=${calls()} — missing ctx must never reach provider`);
    assert(replies().length === 0, "no response row may be emitted without ctx");
  });

  await test("G4 /chat shop param is never a transport id", async () => {
    seedSuperITMall();
    seedMsg("m_g4", "conv_real", { shop: SHOP_TRANSPORT });
    await svc.botWorkerService.pollNewMessages(await scopeOf());
    await drain();
    assert(calls() === 1, `callBot=${calls()}`);
    const p = botParams()[0] as any;
    assert(p.shopName === SHOP_CFG && p.shopName !== SHOP_TRANSPORT,
      `shopName=${p.shopName} — transport id must never become product/persona shopname`);
  });

  // ── H. workflow error truth table (M2 — review finding) ──
  await test("H1 matched-execution error carries recoverable:false (typed field, not reason text)", async () => {
    seedSuperITMall();
    seedConv("conv_h1", SHOP_TRANSPORT, "shopee");
    seedBrokenWorkflow("wf_h1", [SHOP_CFG], "errkw");
    const wf = (await import("../src/backend/service/workflowEngine")).workflowEngine;
    const res = await wf.matchAndRun({
      message_id: "m_h1", conversation_id: "conv_h1", shop_id: SHOP_TRANSPORT,
      config_shop_key: SHOP_CFG, shopname: SHOP_CFG,
      platform: "shopee", text: "errkw", testSource: "botworker",
    } as never);
    assert(res.status === "error", `status=${res.status} — broken flow must error`);
    assert(res.recoverable === false,
      `recoverable=${res.recoverable} — matched death must be typed non-recoverable (op ตาย ห้าม fallback)`);
  });

  await test("H2 pre-match lookup failure (workflows find throws) → bot_failed, no fallback", async () => {
    seedSuperITMall();
    seedConv("conv_h2", SHOP_TRANSPORT, "shopee");
    seedTrigger("tr_h2", [SHOP_CFG], "anything", { action: "bot_answer" });
    mocks.state.config.workflow_enabled = true;
    const orig = (mocks.state as any).onQuery;
    (mocks.state as any).onQuery = (coll: string, op: string, filter: unknown) => {
      orig?.(coll, op, filter);
      if (coll === "workflows" && (op === "find" || op === "aggregate")) {
        throw new Error("injected workflows lookup failure");
      }
    };
    try {
      const r = await processWithCtx("m_h2", "conv_h2", { text: "anything", ctx: CTX });
      assert(r.status === "bot_failed", `status=${r.status} — pre-match failure must fail closed`);
      assert(calls() === 0, `callBot=${calls()} — pre-match failure must not reach trigger/bot`);
      assert(replies().length === 0, "no response may be emitted on pre-match failure");
    } finally {
      (mocks.state as any).onQuery = orig;
    }
  });

  await test("H3 resume on terminal run → non-error no_match (superseded by M1: error+absent removed)", async () => {
    const wf = (await import("../src/backend/service/workflowEngine")).workflowEngine;
    mocks.fakeColl("workflow_runs").push({
      run_id: "wfr_h3", workflow_id: "wf_done", conversation_id: "conv_h3",
      shop_id: SHOP_TRANSPORT, platform: "shopee",
      status: "completed", current_node_id: "w1",
      context: {}, started_at: new Date(), updated_at: new Date(), version: 1,
    });
    const res = await wf.resumeFlow(
      mocks.fakeColl("workflow_runs")[0] as never,
      { message_id: "m_h3", conversation_id: "conv_h3", shop_id: SHOP_TRANSPORT, platform: "shopee", text: "next turn", operation_key: "k_h3" } as never
    );
    assert(res.status === "no_match",
      `status=${res.status} — terminal run = "nothing applicable" ไม่ใช่ error`);
    assert((res as any).recoverable === undefined,
      "non-error result ต้องไม่พก recoverable");
  });

  await test("H4 trigger match-error → bot_failed terminal; LLM=0", async () => {
    seedSuperITMall();
    seedConv("conv_h4", SHOP_TRANSPORT, "shopee");
    seedTrigger("tr_h4", [SHOP_CFG], "tghit", { action: "bot_answer" });
    // trigger match throws (listTriggers) → matched-path unknown → fail closed
    const orig = (mocks.state as any).onQuery;
    (mocks.state as any).onQuery = (coll: string, op: string, filter: unknown) => {
      orig?.(coll, op, filter);
      if (coll === "triggers" && (op === "find" || op === "aggregate")) {
        throw new Error("injected triggers lookup failure");
      }
    };
    try {
      const r = await processWithCtx("m_h4", "conv_h4", { text: "tghit", ctx: CTX });
      assert(r.status === "bot_failed", `status=${r.status} — trigger lookup failure must fail closed`);
      assert(calls() === 0, `callBot=${calls()}`);
    } finally {
      (mocks.state as any).onQuery = orig;
    }
  });

  // ── I. conversations mapping index contract (H1 — final round) ──
  await test("I1 exactly one index declaration supports {platform,shop_name,shop_id} — non-unique, partial usable-string", async () => {
    const src = readFileSync(new URL("../src/backend/db/mongoClient.ts", import.meta.url), "utf8");
    const decls = src.match(/conversations,\s*\{\s*platform:\s*1,\s*shop_name:\s*1,\s*shop_id:\s*1\s*\}[^)]*\)/g) ?? [];
    assert(decls.length === 1,
      `declarations=${decls.length} — owner ต้องประกาศ {platform:1,shop_name:1,shop_id:1} ตัวเดียว`);
    const decl = decls[0] ?? "";
    assert(!/unique\s*:\s*true/.test(decl), "index must be non-unique");
    assert(/partialFilterExpression/.test(decl),
      "usable-string partial filter required — ข้อมูล 97% ไม่มี shop_name ห้าม bloat index");
    assert(/name\s*:\s*"platform_1_shop_name_1_shop_id_1"/.test(decl),
      "stable explicit name platform_1_shop_name_1_shop_id_1 (auto-name convention)");
  });

  await test("I2 resolver name branch is platform-qualified and index-compatible", async () => {
    seedSuperITMall();
    const q = mocks.state.queryLog.filter(
      (e) => e.coll === "conversations" && e.op === "aggregate"
    );
    assert(q.length === 0, "resolver not invoked yet");
    await scopeOf();
    const agg = mocks.state.queryLog.find(
      (e) => e.coll === "conversations" && e.op === "aggregate"
    );
    const match = (agg?.filter as any)?.[0]?.$match;
    assert(Array.isArray(match?.$or), "$match must be $or of bounded candidates");
    const nameBranches = (match.$or as any[]).filter((c) => typeof c.shop_name === "string" && c.platform);
    assert(nameBranches.length === 1 && nameBranches[0].shop_name === SHOP_CFG && nameBranches[0].platform === "shopee",
      `name branch must be per-name eq {platform,shop_name:<name>} — partial index {platform,shop_name,shop_id} prove-able เฉพาะ eq บนค่าคงที่; got ${JSON.stringify(match)}`);
    const idBranch = (match.$or as any[]).find((c) => c.shop_id?.$in);
    assert(!!idBranch, "canonical branch {platform,shop_id:{$in}} must exist");
  });

  // ── J. EngineResult exhaustiveness (M1 — final round) ──
  await test("J1 resume on terminal run → non-error fall-through status (not error)", async () => {
    const wf = (await import("../src/backend/service/workflowEngine")).workflowEngine;
    mocks.fakeColl("workflow_runs").push({
      run_id: "wfr_j1", workflow_id: "wf_done", conversation_id: "conv_j1",
      shop_id: SHOP_TRANSPORT, platform: "shopee",
      status: "completed", current_node_id: "w1",
      context: {}, started_at: new Date(), updated_at: new Date(), version: 1,
    });
    const res = await wf.resumeFlow(
      mocks.fakeColl("workflow_runs")[0] as never,
      { message_id: "m_j1", conversation_id: "conv_j1", shop_id: SHOP_TRANSPORT, platform: "shopee", text: "next", operation_key: "k_j1", config_shop_key: SHOP_CFG } as never
    );
    assert(res.status !== "error",
      `status=${res.status} — "ไม่มี run ที่ resume ได้" ต้องไม่ใช่ error (missing data ห้ามเป็น behavioral control)`);
    assert((res as any).recoverable === undefined,
      `non-error result must not carry recoverable — got ${(res as any).recoverable}`);
  });

  await test("J2 every error producer returns typed recoverable boolean (runtime enumerable)", async () => {
    const wf = (await import("../src/backend/service/workflowEngine")).workflowEngine;
    seedBrokenWorkflow("wf_j2", [SHOP_CFG], "errkw");
    mocks.state.config.workflow_enabled = true;
    const res = await wf.matchAndRun({
      message_id: "m_j2", conversation_id: "conv_j2", shop_id: SHOP_TRANSPORT,
      config_shop_key: SHOP_CFG, shopname: SHOP_CFG,
      platform: "shopee", text: "errkw", testSource: "botworker",
    } as never);
    assert(res.status === "error" && typeof res.recoverable === "boolean",
      `status=${res.status} recoverable=${res.recoverable} — error ต้อง declare recoverability เสมอ`);
    const engSrc = readFileSync(new URL("../src/backend/service/workflowEngine.ts", import.meta.url), "utf8");
    const errorLiterals = engSrc.match(/status:\s*"error"\s*,/g) ?? [];
    const withField = engSrc.match(/status:\s*"error"\s*,[\s\S]{0,300}?recoverable:\s*(false|true)/g) ?? [];
    assert(errorLiterals.length > 0 && withField.length === errorLiterals.length,
      `error literals=${errorLiterals.length} with typed recoverable=${withField.length} — ทุก error producer ต้องมี field`);
    assert(/status:\s*"error";\s*recoverable:\s*boolean/.test(engSrc),
      "EngineResult union ต้องบังคับ recoverable:boolean บน error arm (type-level)");
  });

  await test("J3 resume no_match → dispatcher falls through to trigger/bot (run ไม่ได้กินข้อความ)", async () => {
    seedSuperITMall();
    seedConv("conv_j3", SHOP_TRANSPORT, "shopee");
    seedTrigger("tr_j3", [SHOP_CFG], "hello", { action: "bot_answer" });
    mocks.state.config.workflow_enabled = true;
    // run snapshot = waiting (getActiveRun picks it) → flip to completed during resume
    //   (จำลอง race: snapshot เป็น active แต่ run จบก่อน acquire)
    mocks.fakeColl("workflow_runs").push({
      run_id: "wfr_j3", workflow_id: "wf_any", conversation_id: "conv_j3",
      shop_id: SHOP_TRANSPORT, platform: "shopee",
      status: "waiting_for_reply", current_node_id: "w1", waiting_for: "next_message",
      wait_node_id: "w1", wait_started_at: new Date(), context: {},
      owner_id: "stale", fencing_token: 1, lease_expires_at: new Date(Date.now() - 1000),
      started_at: new Date(), updated_at: new Date(), version: 1,
    });
    const orig = (mocks.state as any).findOneHook;
    (mocks.state as any).findOneHook = async (coll: string, filter: any) => {
      await orig?.(coll, filter);
      if (coll === "workflow_runs" && filter?.run_id === "wfr_j3") {
        const doc = mocks.fakeColl("workflow_runs").find((d: any) => d.run_id === "wfr_j3");
        if (doc) doc.status = "completed";
      }
    };
    try {
      const r = await processWithCtx("m_j3", "conv_j3", { text: "hello", ctx: CTX });
      assert(r.status === "trigger_matched" || r.status === "bot_answered",
        `status=${r.status} — terminal-run resume must fall through to normal dispatch, not settle workflow_resumed`);
      assert(calls() === 1, `callBot=${calls()} — trigger bot_answer must reach LLM once`);
    } finally {
      (mocks.state as any).findOneHook = orig;
    }
  });

  await test("J4 dispatcher/engine never branches on recoverable===undefined or reason strings", async () => {
    const svcSrc = readFileSync(new URL("../src/backend/service/botWorkerService.ts", import.meta.url), "utf8");
    assert(!/recoverable\s*===?\s*undefined/.test(svcSrc), "no recoverable===undefined behavioral check");
    assert(!/recoverable\s*\?\?/.test(svcSrc), "no recoverable default — absent ห้ามมี semantics");
    const engSrc = readFileSync(new URL("../src/backend/service/workflowEngine.ts", import.meta.url), "utf8");
    assert(!/status:\s*"error"[^}]*delivered:\s*\[\]\s*\}/.test(engSrc) ||
           /recoverable/.test(engSrc), "engine error literals must all carry recoverable");
  });

  // ── summary ──
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  for (const r of results) if (!r.ok) console.log(`  FAIL ${r.name}: ${r.err}`);
  process.exit(pass === results.length ? 0 : 1);
}

function claims() {
  return mocks.fakeColl("chat_processing").length;
}

main().catch((e) => { console.error("harness error:", e); process.exit(1); });
