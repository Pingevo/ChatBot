// test-phase9-testchat-buffer.ts — Phase 9 review-fix: Test Chat dispatch
// route buffer lifecycle + explicit input-mode contract
//
// รัน: npx tsx scripts/test-phase9-testchat-buffer.ts
//
// Drive REAL POST /api/test-chat/dispatch handler บน fake Mongo:
//   ✅ route / requireAuth+jwt / workflowEngine.runInboundDispatch / triggerService
//      / handoffService (test path) — production code จริง
// mock เฉพาะ leaf: mongoClient / systemConfigService · fetch → stub (provider=0)
//
// Contract ภายใต้ทดสอบ (M1 — snapshot lifecycle):
//   consumed (terminal): workflow actioned/resumed · exit_drop · error
//     recoverable:false (bot_failed-equivalent) · trigger template/handoff/
//     bot_answer ok · bot fallback ok → ลบเฉพาะ snapshot message_ids
//   retained (non-consumed): in_flight · bot_error · thrown exception → rows คงอยู่
//   ห้าม delete ก่อน dispatch / ห้าม conversation-wide delete หลัง snapshot
//
// Contract ภายใต้ทดสอบ (M2 — explicit input mode):
//   input_mode:"direct"   → ใช้ body.message เท่านั้น ไม่แตะ buffer rows
//   input_mode:"buffered" → ใช้ snapshot rows เท่านั้น (body.message = combined
//                           เดิมจาก client — ห้ามนับซ้ำ)
//   input_mode ว่าง/ผิด    → 422 (ไม่ infer จาก row/prose/timing)
//
// RED-honest: เก่า (deleteMany ก่อน dispatch + rows-shadow body.message) ต้อง
//   fail — T1/T3/T4/T5 retain cases, T7 direct drop, T9 delete-filter shape,
//   T14 mode validation

import { register } from "node:module";

register(new URL("./test-phase9-dispatch-hooks.mjs", import.meta.url));

process.env.ADMIN_JWT_SECRET = "verify-only-jwt-nonsecret";
process.env.CHATBOT_INTERNAL_SECRET = "verify-only-internal-nonsecret";
process.env.CHATBOT_BASE_URL_SHOPEE = "http://verify-only-chatbot.invalid";

type Mocks = typeof import("./test-phase9-dispatch-mocks.mjs");
type Route = typeof import("../src/app/api/test-chat/dispatch/route");
type Wf = typeof import("../src/backend/service/workflowEngine");

let mocks: Mocks;
let route: Route;
let wf: Wf;

const results: { name: string; ok: boolean; err?: string }[] = [];

function assert(cond: boolean, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

async function test(name: string, fn: () => Promise<void>) {
  mocks.resetState();
  installFetchStub();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  }
}

// ── fetch stub (pattern เดียวกับ phase9 suite) ───────────────

function installFetchStub() {
  const s = mocks.state;
  globalThis.fetch = async (url: any, opts: any = {}) => {
    s.fetchCalls++;
    s.fetchUrls.push(String(url));
    try { s.fetchBodies.push(JSON.parse(opts?.body ?? "null")); } catch { s.fetchBodies.push(null); }
    if (s.fetchReject) throw s.fetchReject;
    const st = s.fetchResponse?.status ?? 200;
    const body = s.fetchResponse?.body ?? {
      answer: "stub bot answer", source: "stub", model: "stub-model",
      usage: { prompt: 1, output: 1, total: 2 }, cost: 0,
    };
    return {
      ok: st >= 200 && st < 300,
      status: st,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  };
}

// ── helpers ──────────────────────────────────────────────────

async function postDispatch(body: Record<string, unknown>) {
  const jwt = await import("../src/backend/lib/jwt");
  const { NextRequest } = await import("next/server");
  const { token } = await jwt.createSessionToken("adm_1");
  if (!mocks.fakeColl("sessions").some((d: any) => d.token_hash === jwt.hashToken(token))) {
    mocks.fakeColl("sessions").push({
      token_hash: jwt.hashToken(token), admin_id: "adm_1", revoked: false, created_at: new Date(),
    });
  }
  seedAdmin();
  const headers = new Headers({ "content-type": "application/json", cookie: `cc_session=${token}` });
  const req = new NextRequest("http://localhost/api/test-chat/dispatch", {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const res = await route.POST(req);
  let parsed: any = {};
  try { parsed = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body: parsed };
}

function seedAdmin() {
  if (mocks.fakeColl("admins").some((d: any) => d.admin_id === "adm_1")) return;
  mocks.fakeColl("admins").push({
    admin_id: "adm_1", name: "Admin One", username: "adm_1", role: "admin",
    active: true, is_accepting_chats: true, created_at: new Date(),
  });
}

function seedBufRow(conv: string, mid: string, text: string, receivedAt?: Date) {
  mocks.fakeColl("buffer_messages").push({
    message_id: mid, conversation_id: conv, shop_id: "shop_1", platform: "shopee",
    text, raw_payload: { source: "test_chat", session_id: conv },
    received_at: receivedAt ?? new Date(),
  });
}

const bufRows = (conv: string) =>
  mocks.fakeColl("buffer_messages").filter((d: any) => d.conversation_id === conv);

const bufDeletes = () => mocks.queriesFor("buffer_messages").filter((q) => q.op === "deleteMany");

const baseBody = (conv: string, extra: Record<string, unknown> = {}) => ({
  session_id: conv, shop: "shop_1", platform: "shopee", history: [], limit: 5, ...extra,
});

// ── workflow / trigger seeds (pattern เดียวกับ phase9 suite) ──

const nd = (node_id: string, type: string, subtype: string, config: Record<string, unknown> = {}) =>
  ({ node_id, type, subtype, config, position: { x: 0, y: 0 } });
const ed = (edge_id: string, s: string, t: string, branch?: string) =>
  ({ edge_id, source_node_id: s, target_node_id: t, ...(branch ? { branch } : {}) });

function wfBase(id: string, nodes: any[], edges: any[], extra: Record<string, unknown> = {}) {
  return {
    workflow_id: id, name: id, enabled: true, status: "published", is_deleted: false,
    shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
    false_branch_policy: "exit_to_bot",
    nodes, edges, priority: 1, version: 1, created_by: "t",
    created_at: new Date(), updated_at: new Date(), ...extra,
  };
}

/** trigger(kw) → send "WF_ANSWER" → actioned */
function seedWfSend(kw: string) {
  mocks.state.config.workflow_enabled = true;
  mocks.fakeColl("workflows").push(wfBase("wf_send", [
    nd("t1", "trigger", "message_content", { keywords: [kw] }),
    nd("a1", "action", "send_message", { text: "WF_ANSWER" }),
  ], [ed("e1", "t1", "a1")]));
}

/** trigger → send MENU → wait w2 → condition yes → WF_DONE · false→policy */
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

function seedWaitingRun(conv: string, workflowId: string, extra: Record<string, unknown> = {}) {
  mocks.fakeColl("workflow_runs").push({
    run_id: `run_${conv}`, workflow_id: workflowId, workflow_version: 1,
    conversation_id: conv, shop_id: "shop_1", config_shop_key: "shop_1",
    platform: "shopee", status: "waiting_for_reply",
    current_node_id: "w2", waiting_for: "next_message",
    context: {}, test_source: "test_chat",
    started_at: new Date(), updated_at: new Date(), ...extra,
  });
}

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
  route = await import("../src/app/api/test-chat/dispatch/route");
  wf = await import("../src/backend/service/workflowEngine");
  installFetchStub();

  // ═══ M1 — snapshot lifecycle ═══════════════════════════════

  await test("T1 in_flight → snapshot rows retained (resume foreign-run)", async () => {
    const conv = "conv_t1";
    seedWfWaitCond("wfkw", "exit_to_bot");
    seedWaitingRun(conv, "wf_wait", {
      status: "running", owner_id: "other-worker", fencing_token: 3,
      lease_expires_at: new Date(Date.now() + 120000),
    });
    seedBufRow(conv, "b1", "hello a", new Date(1000));
    seedBufRow(conv, "b2", "hello b", new Date(2000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "in_flight", `status=${r.body.status}`);
    assert(bufRows(conv).length === 2,
      `rows=${bufRows(conv).length} — in_flight must retain snapshot for retry`);
  });

  await test("T2 consumed terminal (bot_answered) → delete exactly snapshot ids · late row survives", async () => {
    const conv = "conv_t2";
    mocks.state.config.workflow_enabled = true; // ให้ getActiveRun findOne ยิง hook
    seedBufRow(conv, "b1", "hello a", new Date(1000));
    seedBufRow(conv, "b2", "hello b", new Date(2000));
    // row แทรกหลัง snapshot read (ก่อน cleanup) ต้องรอด
    mocks.state.findOneHook = (coll) => {
      if (coll === "workflow_runs") {
        seedBufRow(conv, "b3_late", "late msg", new Date(3000));
        mocks.state.findOneHook = null;
      }
    };
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "bot_answered", `status=${r.body.status}`);
    const rest = bufRows(conv);
    assert(rest.length === 1 && rest[0].message_id === "b3_late",
      `rows=${JSON.stringify(rest.map((d: any) => d.message_id))} — want only late row`);
    const dels = bufDeletes();
    assert(dels.length === 1, `deleteMany calls=${dels.length} want 1`);
    assert(dels[0].filter.message_id?.$in?.length === 2,
      `delete filter=${JSON.stringify(dels[0].filter)} — want snapshot message_id $in`);
  });

  await test("T3 bot 5xx → snapshot rows retained", async () => {
    const conv = "conv_t3";
    seedBufRow(conv, "b1", "hello", new Date(1000));
    mocks.state.fetchResponse = { status: 500, body: { detail: "bot exploded" } };
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "bot_error", `status=${r.body.status}`);
    assert(bufRows(conv).length === 1, "bot error must retain snapshot for retry");
  });

  await test("T4 fetch network reject → snapshot rows retained", async () => {
    const conv = "conv_t4";
    seedBufRow(conv, "b1", "hello", new Date(1000));
    mocks.state.fetchReject = new Error("ECONNREFUSED");
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "bot_error", `status=${r.body.status}`);
    assert(bufRows(conv).length === 1, "network error must retain snapshot");
  });

  await test("T5 dispatch exception → snapshot rows retained", async () => {
    const conv = "conv_t5";
    mocks.state.config.workflow_enabled = true;
    seedBufRow(conv, "b1", "hello", new Date(1000));
    mocks.state.findOneHook = (coll) => {
      if (coll === "workflow_runs") throw new Error("mongo blew up");
    };
    await postDispatch(baseBody(conv, { input_mode: "buffered" })).then(
      () => { /* route may surface error response */ },
      () => { /* or throw */ },
    );
    assert(bufRows(conv).length === 1, "thrown dispatch must retain snapshot");
  });

  await test("T6 consumed cleanup ไม่แตะ rows ของ session อื่น", async () => {
    const conv = "conv_t6";
    seedBufRow(conv, "b1", "hello", new Date(1000));
    seedBufRow("other_conv", "x1", "other", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "bot_answered", `status=${r.body.status}`);
    assert(bufRows(conv).length === 0, "own snapshot consumed");
    assert(bufRows("other_conv").length === 1, "other session rows must survive");
  });

  // ═══ M2 — explicit input mode ══════════════════════════════

  await test("T7 direct mode + stale buffer rows → dispatch body B · rows ไม่ถูกแตะ", async () => {
    const conv = "conv_t7";
    seedBufRow(conv, "b1", "STALE_A", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "direct", message: "FRESH_B" }));
    assert(r.body.status === "bot_answered", `status=${r.body.status}`);
    const sent = mocks.state.fetchBodies[0];
    assert(sent?.message === "FRESH_B",
      `dispatched=${sent?.message} — direct body must not be shadowed by stale rows`);
    assert(bufRows(conv).length === 1, "direct mode must not drain buffer");
  });

  await test("T8 buffered mode: rows A+B dispatched once · body combined text ไม่ถูกนับซ้ำ", async () => {
    const conv = "conv_t8";
    seedBufRow(conv, "b1", "msgA", new Date(1000));
    seedBufRow(conv, "b2", "msgB", new Date(2000));
    // client ส่ง combined text ใน body.message เดิม — server ต้องไม่เอามาต่อซ้ำ
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered", message: "msgA msgB" }));
    assert(r.body.status === "bot_answered", `status=${r.body.status}`);
    const sent = mocks.state.fetchBodies[0];
    assert(sent?.message === "msgA msgB",
      `dispatched=${sent?.message} — rows+body duplication`);
    assert(r.body.message_count === 2, `message_count=${r.body.message_count}`);
  });

  await test("T9 trigger template → consumed once · delete filter = snapshot ids", async () => {
    const conv = "conv_t9";
    seedTrigger({ keywords: ["trigkw"], action: "bot_answer", bot_template: "TRIG_TEMPLATE" });
    seedBufRow(conv, "b1", "trigkw hi", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "trigger_template", `status=${r.body.status}`);
    assert(mocks.state.fetchCalls === 0, "template must not call bot");
    assert(bufRows(conv).length === 0, "consumed snapshot must be deleted");
    const dels = bufDeletes();
    assert(dels.length === 1 && dels[0].filter.message_id?.$in?.includes("b1"),
      `deletes=${JSON.stringify(dels.map((d) => d.filter))} — want $in [b1]`);
  });

  await test("T10 trigger handoff → consumed once · snapshot deleted", async () => {
    const conv = "conv_t10";
    seedAdmin();
    seedTrigger({ keywords: ["helpme"], action: "handoff_admin" });
    seedBufRow(conv, "b1", "helpme please", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "trigger_handoff", `status=${r.body.status}`);
    assert(bufRows(conv).length === 0, "consumed snapshot must be deleted");
  });

  await test("T11 workflow actioned → consumed once · trigger/bot 0 · snapshot deleted", async () => {
    const conv = "conv_t11";
    seedWfSend("wfkw");
    seedBufRow(conv, "b1", "wfkw go", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "workflow_actioned", `status=${r.body.status}`);
    assert(mocks.state.fetchCalls === 0, "workflow terminal must not call bot");
    assert(mocks.queriesFor("triggers").length === 0, "workflow terminal must skip trigger");
    assert(bufRows(conv).length === 0, "consumed snapshot must be deleted");
  });

  await test("T12 workflow exit_drop → consumed intentionally · snapshot deleted", async () => {
    const conv = "conv_t12";
    seedWfWaitCond("wfkw", "exit_drop");
    seedWaitingRun(conv, "wf_wait");
    seedBufRow(conv, "b1", "no thanks", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "exit_drop", `status=${r.body.status}`);
    assert(bufRows(conv).length === 0, "exit_drop = intentional consume");
    assert(mocks.state.fetchCalls === 0, "exit_drop must not reach bot");
  });

  await test("T13 workflow non-recoverable error → consumed (bot_failed-equivalent) · snapshot deleted", async () => {
    const conv = "conv_t13";
    mocks.state.config.workflow_enabled = true;
    seedWaitingRun(conv, "wf_deleted"); // run ชี้ workflow หาย → error !recoverable
    seedBufRow(conv, "b1", "yes", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "workflow_error", `status=${r.body.status}`);
    assert(bufRows(conv).length === 0, "terminal workflow_error = consumed");
    assert(mocks.state.fetchCalls === 0, "terminal error must not reach bot");
  });

  await test("T14 input_mode ผิด → 422 · ไม่มี dispatch/delete", async () => {
    const conv = "conv_t14";
    seedBufRow(conv, "b1", "hello", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "bogus", message: "hi" }));
    assert(r.status === 422, `http=${r.status} want 422`);
    assert(mocks.state.fetchCalls === 0, "no dispatch on bad mode");
    assert(bufDeletes().length === 0, "no cleanup on bad mode");
    assert(bufRows(conv).length === 1, "rows untouched");
  });

  await test("T15 input_mode ว่าง → default direct (body.message ชนะ, rows คงอยู่)", async () => {
    const conv = "conv_t15";
    seedBufRow(conv, "b1", "STALE_A", new Date(1000));
    const r = await postDispatch(baseBody(conv, { message: "FRESH_B" }));
    assert(r.body.status === "bot_answered", `status=${r.body.status}`);
    const sent = mocks.state.fetchBodies[0];
    assert(sent?.message === "FRESH_B",
      `dispatched=${sent?.message} — absent mode must default to direct`);
    assert(bufRows(conv).length === 1, "direct default must not drain buffer");
  });

  await test("T16 buffered consumed → runInboundDispatch once · leaf once", async () => {
    const conv = "conv_t16";
    seedBufRow(conv, "b1", "hello", new Date(1000));
    const r = await postDispatch(baseBody(conv, { input_mode: "buffered" }));
    assert(r.body.status === "bot_answered", `status=${r.body.status}`);
    assert(mocks.state.fetchCalls === 1, `fetch=${mocks.state.fetchCalls} want exactly 1`);
    assert(mocks.queriesFor("workflow_runs").length === 0,
      "workflow disabled → engine short-circuit; no run queries");
    assert(mocks.queriesFor("triggers").length === 1, "trigger matched once");
  });

  // ═══ summary ═══
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} passed`);
  for (const r of results) if (!r.ok) console.log(`  FAILED: ${r.name} — ${r.err}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error("harness error:", e); process.exit(2); });
