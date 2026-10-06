// test-botworker-boundary.ts — Round 4: source isolation + current-turn exclusion + measured perf
//
// รัน: npx tsx scripts/test-botworker-boundary.ts
//
// Production modules ทำงานจริงบน fake Mongo:
//   ✅ messageService (getGroupedHistoryForBot) / botWorkerService / workflowEngine
//   ✅ route handlers: messages / replies / conversations
// mock เฉพาะ leaf: mongoClient / botCallService / systemConfigService / authorize / productService
// react stub เฉพาะ usePolling (overlap measurement)
//
// Contracts ภายใต้ทดสอบ (จาก audit โค้ดจริง):
//   B — /botworker แสดงเฉพาะ origin∈{worker,workflow} + mode=standalone|absent + !deleted + text ไม่ว่าง
//   C — history = turns ก่อนหน้าเท่านั้น; current batch อยู่เฉพาะ message/images
//   E — cache TTL ครอบ ≥1 poll interval; ts จับตอน data พร้อม; request ไม่ซ้อน
//   F — bot call failure → claim terminal bot_failed (ไม่วน)

import { register } from "node:module";
import { createHash } from "node:crypto";

// ⚡ ต้อง register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-botworker-boundary-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-boundary-mocks.mjs");
type MsgSvc = typeof import("../src/backend/service/messageService");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Rt = typeof import("../src/backend/service/botworkerRuntime");
type MsgsRoute = typeof import("../src/app/api/botworker/conversations/[conversationId]/messages/route");
type RepliesRoute = typeof import("../src/app/api/botworker/replies/route");
type ConvsRoute = typeof import("../src/app/api/botworker/conversations/route");
type Poll = typeof import("../src/lib/usePolling");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let mocks: Mocks;
let msgSvc: MsgSvc;
let svc: Svc;
let rt: Rt;
let msgsRoute: MsgsRoute;
let repliesRoute: RepliesRoute;
let convsRoute: ConvsRoute;
let poll: Poll;

// ── minimal hooks dispatcher — drive real usePolling outside a component ──
// React 19: hooks dispatch ผ่าน __CLIENT_INTERNALS.H — set dispatcher ของเรา
// แล้วเรียก usePolling ตรงๆ ได้เหมือนอยู่ใน component (test seam ไม่ใช่ mock)
const pendingEffects: (() => void | (() => void))[] = [];
function mountEffects(): () => void {
  const cbs = pendingEffects.splice(0);
  const cleanups = cbs.map((cb) => cb());
  return () => cleanups.forEach((c) => { if (typeof c === "function") c(); });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

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
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── seeds ──────────────────────────────────────────────────

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
    created_timestamp: nextTs(),
    ...extra,
  });
}

function seedZaapiReply(conversationId: string, messageId: string, text: string) {
  mocks.fakeColl("messages").push({
    message_id: messageId,
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee",
    role: "bot",
    direction: "out",
    text,
    created_timestamp: nextTs(),
  });
}

function seedShadowReply(conversationId: string, fields: Record<string, unknown>) {
  mocks.fakeColl("shadow_replies").push({
    shadow_reply_id: fields.shadow_reply_id || `sr_${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee",
    bot_reply_text: "reply text",
    inbound_message_id: "m_old",
    created_at: nextTs(),
    ...fields,
  });
}

function seedBwAdminMsg(conversationId: string, messageId: string, text: string) {
  mocks.fakeColl("botworker_messages").push({
    message_id: messageId,
    conversation_id: conversationId,
    shop_id: "shop_1",
    platform: "shopee",
    role: "admin",
    actor: "t_admin",
    text,
    created_at: nextTs(),
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

/** seed processing claims ที่ตรง fenced finalize filter ของ ctx */
function seedClaimsForCtx(ctx: ReturnType<typeof makeCtx>, conversationId: string) {
  for (const mid of ctx.message_ids) seedProcessingClaim(mid, conversationId, ctx);
}

// ── S: source boundary (Part B) ────────────────────────────

/** seed shadow_replies ครบทุก source ใน conv เดียว — คืน map label→id */
function seedShadowMatrix(convId: string) {
  const ids: Record<string, string> = {};
  const add = (label: string, fields: Record<string, unknown>) => {
    const id = `sr_${label}`;
    ids[label] = id;
    seedShadowReply(convId, { shadow_reply_id: id, ...fields });
    return id;
  };
  add("worker", { origin: "worker", mode: "standalone" });
  add("workflow", { origin: "workflow", mode: "standalone" });
  add("worker_legacy", { origin: "worker" });                    // mode absent — legacy
  add("workflow_legacy", { origin: "workflow" });                // mode absent — legacy
  add("manual", { origin: "manual", mode: "shadowbot" });
  add("manual_conv", { origin: "manual_conversation", mode: "shadowbot" });
  add("manual_nomode", { origin: "manual" });                    // manual โดยไม่มี mode
  add("other_mode", { origin: "worker", mode: "ticket" });       // mode ผิด
  add("deleted", { origin: "worker", mode: "standalone", deleted_at: new Date() });
  add("empty", { origin: "worker", mode: "standalone", bot_reply_text: "" });
  add("notext", { origin: "worker", mode: "standalone", bot_reply_text: undefined });
  return ids;
}

const EXPECTED_INCLUDED = ["worker", "workflow", "worker_legacy", "workflow_legacy"];

async function callMessagesRoute(convId: string, platform = "shopee") {
  const req = { url: `http://localhost/api/botworker/conversations/${convId}/messages?platform=${platform}` } as any;
  const res = await msgsRoute.GET(req, { params: Promise.resolve({ conversationId: convId }) } as any);
  return (await res.json()) as { messages: { id: string; role: string; text: string }[]; total: number };
}

async function callRepliesRoute(convId?: string) {
  const q = convId ? `?conversation_id=${convId}` : "";
  const req = { url: `http://localhost/api/botworker/replies${q}` } as any;
  const res = await repliesRoute.GET(req);
  return (await res.json()) as { rows: { shadow_reply_id: string }[]; total?: number };
}

async function main() {
  mocks = await import("./test-botworker-boundary-mocks.mjs");
  msgSvc = await import("../src/backend/service/messageService");
  svc = await import("../src/backend/service/botWorkerService");
  rt = await import("../src/backend/service/botworkerRuntime");
  msgsRoute = await import("../src/app/api/botworker/conversations/[conversationId]/messages/route");
  repliesRoute = await import("../src/app/api/botworker/replies/route");
  convsRoute = await import("../src/app/api/botworker/conversations/route");
  poll = await import("../src/lib/usePolling");

  // ⚡ install hooks dispatcher — usePolling รันจริง ผ่าน dispatcher ที่ test ควบคุม
  const reactMod: any = await import("react");
  const React = reactMod.default || reactMod;
  React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
    useRef: (init: unknown) => ({ current: init }),
    useEffect: (cb: () => void | (() => void)) => { pendingEffects.push(cb); },
  };

  // ══════════════════════════════════════════════════════════
  // S — Botworker reply source boundary
  // ══════════════════════════════════════════════════════════

  await test("S1 messages route: worker/workflow standalone+legacy เท่านั้น — manual/replay/empty/deleted ห้ามปน", async () => {
    const conv = "conv_s1";
    seedConv(conv);
    seedUserMsg(conv, "m_u1", "hello");
    const ids = seedShadowMatrix(conv);
    const body = await callMessagesRoute(conv);
    const botIds = body.messages.filter((m) => m.role === "bot").map((m) => m.id);
    for (const label of EXPECTED_INCLUDED) {
      assert(botIds.includes(ids[label]), `missing ${label} (${ids[label]}) — got bot ids: ${botIds}`);
    }
    const leaked = botIds.filter((id) => !EXPECTED_INCLUDED.map((l) => ids[l]).includes(id));
    assert(leaked.length === 0, `leaked non-botworker replies: ${leaked}`);
  });

  await test("S2 messages route: conversation/platform isolation คงเดิม", async () => {
    const conv = "conv_s2";
    seedConv(conv);
    seedUserMsg(conv, "m_u1", "hello");
    seedShadowReply(conv, { shadow_reply_id: "sr_own", origin: "worker", mode: "standalone" });
    seedShadowReply("conv_other", { shadow_reply_id: "sr_other_conv", origin: "worker", mode: "standalone" });
    seedShadowReply(conv, { shadow_reply_id: "sr_other_plat", origin: "worker", mode: "standalone", platform: "tiktok" });
    const body = await callMessagesRoute(conv);
    const botIds = body.messages.filter((m) => m.role === "bot").map((m) => m.id);
    assert(botIds.includes("sr_own"), "own worker reply missing");
    assert(!botIds.includes("sr_other_conv"), "other conversation leaked");
    assert(!botIds.includes("sr_other_plat"), "other platform leaked");
  });

  await test("S3 replies route: contract เดียวกัน — standalone+legacy worker/workflow เท่านั้น", async () => {
    const conv = "conv_s3";
    seedConv(conv);
    const ids = seedShadowMatrix(conv);
    const body = await callRepliesRoute(conv);
    const got = (body.rows || []).map((r: any) => r.shadow_reply_id);
    for (const label of EXPECTED_INCLUDED) {
      assert(got.includes(ids[label]), `replies route missing ${label}`);
    }
    const leaked = got.filter((id: string) => !EXPECTED_INCLUDED.map((l) => ids[l]).includes(id));
    assert(leaked.length === 0, `replies route leaked: ${leaked}`);
  });

  await test("S4 getGroupedHistoryForBot: model turn ใช้ worker reply เท่านั้น — manual/shadowbot ไม่ถูกเลือก", async () => {
    const conv = "conv_s4";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "old question");
    seedShadowReply(conv, { shadow_reply_id: "sr_wrong", origin: "manual", mode: "shadowbot", bot_reply_text: "WRONG manual reply" });
    seedShadowReply(conv, { shadow_reply_id: "sr_right", origin: "worker", mode: "standalone", bot_reply_text: "worker answer" });
    const history = await msgSvc.getGroupedHistoryForBot({ conversationId: conv, platform: "shopee" });
    const modelTurn = history.find((h) => h.role === "model");
    assert(!!modelTurn, "no model turn found");
    assert(modelTurn!.text === "worker answer", `expected worker reply, got: ${modelTurn!.text}`);
  });

  await test("S5 getGroupedHistoryForBot: มีแต่ manual reply → fallback Zaapi (manual ไม่ถูกใช้)", async () => {
    const conv = "conv_s5";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "old question");
    seedZaapiReply(conv, "m_z1", "zaapi answer");
    seedShadowReply(conv, { shadow_reply_id: "sr_m", origin: "manual", mode: "shadowbot", bot_reply_text: "WRONG manual" });
    const history = await msgSvc.getGroupedHistoryForBot({ conversationId: conv, platform: "shopee" });
    const modelTurn = history.find((h) => h.role === "model");
    assert(modelTurn?.text === "zaapi answer", `expected zaapi fallback, got: ${modelTurn?.text}`);
  });

  // ══════════════════════════════════════════════════════════
  // E — current-turn exclusion (Part C)
  // ══════════════════════════════════════════════════════════

  await test("E1 excludeMessageIds: current message ไม่อยู่ใน history", async () => {
    const conv = "conv_e1";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "previous question");
    seedShadowReply(conv, { origin: "worker", mode: "standalone", bot_reply_text: "previous answer" });
    seedUserMsg(conv, "m_cur", "CURRENT question text");
    const history = await msgSvc.getGroupedHistoryForBot({
      conversationId: conv, platform: "shopee", excludeMessageIds: ["m_cur"],
    });
    const allText = history.map((h) => h.text).join(" | ");
    assert(!allText.includes("CURRENT question text"), `current text leaked into history: ${allText}`);
    assert(allText.includes("previous question"), "previous turn missing");
    assert(allText.includes("previous answer"), "previous model turn missing");
  });

  await test("E2 excludeMessageIds: batch 3 ids ถูกตัดครบ", async () => {
    const conv = "conv_e2";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "previous question");
    seedUserMsg(conv, "m_b1", "batch part one");
    seedUserMsg(conv, "m_b2", "batch part two");
    seedUserMsg(conv, "m_b3", "batch part three");
    const history = await msgSvc.getGroupedHistoryForBot({
      conversationId: conv, platform: "shopee",
      excludeMessageIds: ["m_b1", "m_b2", "m_b3"],
    });
    const allText = history.map((h) => h.text).join(" | ");
    for (const t of ["batch part one", "batch part two", "batch part three"]) {
      assert(!allText.includes(t), `batch text leaked: ${t}`);
    }
    assert(allText.includes("previous question"), "previous turn missing");
  });

  await test("E3 control: ไม่ส่ง excludeMessageIds → behavior เดิม (current อยู่ใน history)", async () => {
    const conv = "conv_e3";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "previous question");
    seedUserMsg(conv, "m_cur", "CURRENT question text");
    const history = await msgSvc.getGroupedHistoryForBot({ conversationId: conv, platform: "shopee" });
    const allText = history.map((h) => h.text).join(" | ");
    assert(allText.includes("CURRENT question text"), "backward-compat broken — current should appear without exclusion");
  });

  await test("E4 excludeMessageIds: current image ไม่อยู่ใน history.images — historical image_desc คงอยู่", async () => {
    const conv = "conv_e4";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "look at this", {
      image_desc: "รูปเก่า: สินค้าสีแดง",
      raw_payload: { type: "image", url: "https://img.example.com/old.png" },
    });
    seedUserMsg(conv, "m_cur", "and this", {
      raw_payload: { type: "image", url: "https://img.example.com/current.png" },
    });
    const history = await msgSvc.getGroupedHistoryForBot({
      conversationId: conv, platform: "shopee", excludeMessageIds: ["m_cur"],
    });
    const allImages = history.flatMap((h) => h.images || []);
    const allDesc = history.map((h) => h.image_desc || "").join(" | ");
    assert(!allImages.includes("https://img.example.com/current.png"), "current image leaked into history");
    assert(allDesc.includes("รูปเก่า: สินค้าสีแดง"), "historical image_desc missing");
  });

  await test("E5 processMessage→callBot: current text ส่งใน message ครั้งเดียว + history ไม่มี current", async () => {
    const conv = "conv_e5";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "previous question");
    seedUserMsg(conv, "m_cur", "CURRENT combined text");
    const ctx = makeCtx(["m_cur"]);
    seedClaimsForCtx(ctx, conv);
    const r = await svc.processMessage({
      message_id: "m_cur", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee", text: "CURRENT combined text", claimContext: ctx,
    });
    assert(mocks.state.calls.callBot === 1, `callBot=${mocks.state.calls.callBot} status=${r.status}: ${r.detail}`);
    const params = mocks.state.callBotParams[0];
    assert(params.message === "CURRENT combined text", `message field wrong: ${params.message}`);
    const histText = (params.history || []).map((h: any) => h.text).join(" | ");
    assert(!histText.includes("CURRENT combined text"), `current text duplicated in history: ${histText}`);
    assert(histText.includes("previous question"), "previous turn missing from history");
  });

  await test("E6 processMessage batch ctx: current batch 2 ids ไม่อยู่ใน history + image ส่งครั้งเดียว", async () => {
    const conv = "conv_e6";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "previous question");
    seedUserMsg(conv, "m_b1", "first of batch");
    seedUserMsg(conv, "m_b2", "second of batch", {
      raw_payload: { type: "image", url: "https://img.example.com/batch.png" },
    });
    const ctx = makeCtx(["m_b1", "m_b2"]);
    seedClaimsForCtx(ctx, conv);
    const r = await svc.processMessage({
      message_id: "m_b1", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee", text: "first of batch second of batch",
      images: ["https://img.example.com/batch.png"], claimContext: ctx,
    });
    assert(mocks.state.calls.callBot === 1, `callBot=${mocks.state.calls.callBot} status=${r.status}`);
    const params = mocks.state.callBotParams[0];
    const histText = (params.history || []).map((h: any) => h.text).join(" | ");
    assert(!histText.includes("first of batch") && !histText.includes("second of batch"),
      `batch text leaked: ${histText}`);
    const histImgs = (params.history || []).flatMap((h: any) => h.images || []);
    assert(!histImgs.includes("https://img.example.com/batch.png"), "current image duplicated in history");
    assert((params.images || []).filter((u: string) => u === "https://img.example.com/batch.png").length === 1,
      "current image must appear exactly once in req.images");
  });

  await test("E7 workflow let_ai_respond: history ตัด current batch เหมือน path ปกติ", async () => {
    const conv = "conv_e7";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "previous question");
    seedUserMsg(conv, "m_cur", "CURRENT wf question");
    // workflow trigger("wfkw") → let_ai_respond
    mocks.state.config.workflow_enabled = true;
    mocks.state.config.workflow_priority = "workflow_first";
    mocks.fakeColl("workflows").push({
      workflow_id: "wf_ai", name: "wf_ai", enabled: true, status: "published", is_deleted: false,
      shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
      false_branch_policy: "exit_to_bot",
      nodes: [
        { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: ["wfkw"] }, position: { x: 0, y: 0 } },
        { node_id: "n2", type: "action", subtype: "let_ai_respond", config: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "n1", target_node_id: "n2" }],
      priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
    });
    const ctx = makeCtx(["m_cur"]);
    seedClaimsForCtx(ctx, conv);
    const r = await svc.processMessage({
      message_id: "m_cur", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee", text: "wfkw CURRENT wf question", claimContext: ctx,
    });
    assert(mocks.state.calls.callBot === 1, `callBot=${mocks.state.calls.callBot} status=${r.status} ${r.detail}`);
    const params = mocks.state.callBotParams[0];
    const histText = (params.history || []).map((h: any) => h.text).join(" | ");
    assert(!histText.includes("CURRENT wf question"), `workflow history leaked current: ${histText}`);
    assert(histText.includes("previous question"), "previous turn missing in workflow path");
  });

  await test("E8 exclusion ไม่กระทบ conversation/platform อื่น + reply priority คงเดิม", async () => {
    const conv = "conv_e8";
    seedConv(conv);
    seedUserMsg(conv, "m_old", "old q");
    seedZaapiReply(conv, "m_z", "zaapi reply");
    seedBwAdminMsg(conv, "bw_a1", "admin sandbox reply");
    seedShadowReply(conv, { origin: "worker", mode: "standalone", bot_reply_text: "worker reply wins" });
    seedUserMsg(conv, "m_cur", "current q");
    seedUserMsg("conv_other_e8", "m_x", "other conv msg");
    const history = await msgSvc.getGroupedHistoryForBot({
      conversationId: conv, platform: "shopee",
      includeSandboxAdmin: true, excludeMessageIds: ["m_cur"],
    });
    const allText = history.map((h) => h.text).join(" | ");
    assert(!allText.includes("current q"), "current leaked");
    assert(!allText.includes("other conv msg"), "cross-conversation leak");
    const modelTurn = history.find((h) => h.role === "model");
    assert(modelTurn?.text === "worker reply wins", `priority broken: ${modelTurn?.text}`);
  });

  // ══════════════════════════════════════════════════════════
  // P — measured UI performance (Part E)
  // ══════════════════════════════════════════════════════════

  async function callConvsRoute() {
    const req = { url: "http://localhost/api/botworker/conversations?limit=200&include_count=true" } as any;
    const res = await convsRoute.GET(req);
    return (await res.json()) as { rows: unknown[]; total_count: number };
  }

  await test("P1 inbox cache: poll ที่ +3s หลัง fill ต้อง HIT (TTL ต้องครอบ ≥1 poll interval)", async () => {
    seedConv("conv_p1");
    const realNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    try {
      await callConvsRoute();                                   // t=0 → miss → fill
      const q1 = mocks.state.queryLog.length;
      assert(q1 > 0, "first call should query");
      fakeNow += 3000;                                          // t=+3s — poll interval
      mocks.state.queryLog.length = 0;
      await callConvsRoute();                                   // ต้อง HIT
      assert(mocks.state.queryLog.length === 0,
        `cache miss at +3s poll — ${mocks.state.queryLog.length} queries: ${JSON.stringify(mocks.state.queryLog.map(q => q.coll + "." + q.op))}`);
    } finally {
      Date.now = realNow;
      convsRoute.invalidateBotworkerCache();
    }
  });

  await test("P2 inbox cache: timestamp ต้องจับตอน data พร้อม (query ช้ากว่า TTL → data เกิดมาตั้งแต่ก่อนเสร็จ)", async () => {
    seedConv("conv_p2");
    // 4 sequential queries × 1.5s ≈ 6s — ts ที่จับก่อน query → หมดอายุก่อน data พร้อมเสียอีก
    mocks.state.queryDelayMs = 1500;
    try {
      await callConvsRoute();                                   // fill ช้า ~6s → เสร็จตอนนี้
      mocks.state.queryDelayMs = 0;
      mocks.state.queryLog.length = 0;
      await callConvsRoute();                                   // data เพิ่งพร้อม → ต้อง HIT
      assert(mocks.state.queryLog.length === 0,
        `fresh data treated as stale — cache ts captured before queries finished (${mocks.state.queryLog.length} queries)`);
    } finally {
      convsRoute.invalidateBotworkerCache();
      mocks.state.queryDelayMs = 0;
    }
  });

  await test("P3 usePolling: option immediate ยิง fn ทันทีตอน mount (ก่อน interval แรก)", async () => {
    let calls = 0;
    poll.usePolling(() => { calls++; }, 40, { immediate: true });
    const cleanup = mountEffects();
    await Promise.resolve();  // run() เป็น async — รอ microtask ให้ fn() execute
    cleanup();
    assert(calls === 1, `expected immediate call at mount, got calls=${calls}`);
  });

  await test("P4 overlap measurement: two-mechanism page pattern vs single usePolling(immediate)", async () => {
    // จำลอง page pattern ปัจจุบัน: effect(fn) + usePolling(fn) — fn ช้ากว่า interval → ซ้อน
    let inFlight = 0;
    let maxInFlight = 0;
    const slowFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(120);
      inFlight--;
    };
    // mechanism 1: initial effect call (page.tsx: useEffect(()=>loadConversations()))
    const p1 = slowFn();
    // mechanism 2: usePolling tick
    poll.usePolling(slowFn, 40);
    const cleanup = mountEffects();
    await sleep(60);                                            // tick แรกเกิดขณะ p1 ยังไม่จบ
    cleanup();
    await p1;
    assert(maxInFlight >= 2, `expected overlap in two-mechanism pattern, got maxInFlight=${maxInFlight}`);
    // (test นี้ PASS เมื่อ overlap พิสูจน์ได้ — fix อยู่ที่ page เปลี่ยนเป็น mechanism เดียว)
  });

  await test("P5 single mechanism: usePolling(immediate) ไม่ซ้อน แม้ fn ช้ากว่า interval", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(100);
      inFlight--;
    };
    poll.usePolling(slowFn, 30, { immediate: true });
    const cleanup = mountEffects();
    await sleep(180);                                           // หลาย tick ระหว่าง fn ยังช้า
    cleanup();
    assert(maxInFlight === 1, `overlap inside usePolling: maxInFlight=${maxInFlight}`);
  });

  await test("P6 measure: query counts per inbox poll + message poll (instrumentation)", async () => {
    const conv = "conv_p6";
    seedConv(conv);
    seedUserMsg(conv, "m_u1", "hi");
    seedShadowReply(conv, { shadow_reply_id: "sr_p6", origin: "worker", mode: "standalone" });
    convsRoute.invalidateBotworkerCache();
    mocks.state.queryLog.length = 0;
    await callConvsRoute();
    const inboxQueries = mocks.state.queryLog.length;
    mocks.state.queryLog.length = 0;
    mocks.state.productCalls.length = 0;
    await callMessagesRoute(conv);
    const msgQueries = mocks.state.queryLog.length;
    const productLookups = mocks.state.productCalls.length;
    console.log(`     [measure] inbox miss: ${inboxQueries} queries · messages: ${msgQueries} queries + ${productLookups} product lookups`);
    assert(inboxQueries > 0 && msgQueries > 0, "instrumentation failed");
  });

  // ══════════════════════════════════════════════════════════
  // F — callBot failure → terminal bot_failed (pin)
  // ══════════════════════════════════════════════════════════

  await test("F1 callBot error → claim terminal bot_failed + finalized (ไม่ค้าง processing)", async () => {
    const conv = "conv_f1";
    seedConv(conv);
    seedUserMsg(conv, "m_cur", "hello");
    const ctx = makeCtx(["m_cur"]);
    seedClaimsForCtx(ctx, conv);
    mocks.state.callBotError = new Error("connect ECONNREFUSED 127.0.0.1:8010");
    const r = await svc.processMessage({
      message_id: "m_cur", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee", text: "hello", claimContext: ctx,
    });
    assert(r.status === "bot_failed", `expected bot_failed, got ${r.status}`);
    assert(r.finalized === true, "claim must be finalized terminal, not left processing");
    const claim = mocks.fakeColl("chat_processing").find((d: any) => d._id === "botworker:claim:m_cur");
    assert(claim?.status === "bot_failed", `claim status=${claim?.status}`);
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
