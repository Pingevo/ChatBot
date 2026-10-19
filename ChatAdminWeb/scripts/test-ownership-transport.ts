// test-ownership-transport.ts — Phase 2B.1 ownership writer/reader contract tests
//
// รัน: npx tsx scripts/test-ownership-transport.ts
//
// Production modules ทำงานจริงบน fake Mongo + real auth/jwt:
//   ✅ statusConversationService / conversationService / assignmentService
//   ✅ handoffService / botCallService (real callBot → stubbed fetch)
//   ✅ admin route handlers (send/assign/[id] GET/list/team) + workflowEngine
// mock เฉพาะ leaf: mongoClient / systemConfigService
// fetch → stub (นับ calls + capture body.ticket_state) — provider จริง = 0
//
// Contract ภายใต้ทดสอบ (business semantics ที่อนุมัติแล้ว):
//   1. conversations(_shp).status="open" = dump state ไม่ใช่ human ownership
//   2. ไม่มี status_conversation doc → bot-owned (bot ตอบได้)
//   3. meta.status ∈ {handoff,open,pending} → admin owns → bot lock
//   4. meta.status ∈ {bot,closed,resolved} → bot ตอบได้
//   5. ownership writers persist meta ก่อน claim success
//   6. handoff จ่ายคนไม่ได้ → persist pending marker ชัดเจน
//   7. meta read error → fail closed (ไม่เรียก Python)
//
// Python boundary (audited): turn_decision._ACTIVE_TICKET_STATES =
//   {handoff,open,pending} → locked; "bot"/closed/resolved → unlocked;
//   None → history-scan fallback ⇒ missing meta ต้องส่ง "bot" explicit

import { register } from "node:module";
import { ObjectId } from "mongodb";

// ⚡ register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-ownership-transport-hooks.mjs", import.meta.url));

// ⚡ strict env ของ lib/config ผูกตอน module eval — ตั้ง test-local constants
//    ก่อน import ใดๆ (ไม่มี .env)
process.env.ADMIN_JWT_SECRET = "verify-only-jwt-nonsecret";
process.env.CHATBOT_INTERNAL_SECRET = "verify-only-internal-nonsecret";
process.env.CHATBOT_BASE_URL_SHOPEE = "http://verify-only-chatbot.invalid";

type Mocks = typeof import("./test-ownership-transport-mocks.mjs");

const results: { name: string; ok: boolean; err?: string }[] = [];
let mocks: Mocks;
let assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`assert: ${msg}`);
};

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
  mocks.resetState();
  // ⚡ fetch stub — capture request bodies, canned 200
  (globalThis as any).fetch = async (_url: string, init: any) => {
    mocks.state.fetchCalls++;
    mocks.state.fetchBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        answer: "stub answer",
        source: "stub",
        model: "stub-model",
        elapsed: 0.01,
        usage: { prompt: 1, output: 1, total: 2 },
      }),
    };
  };
}

// ── seed helpers ─────────────────────────────────────────────

function seedConv(id: string, fields: Record<string, unknown> = {}) {
  mocks.fakeColl("conversations").push({
    conversation_id: id,
    shop_id: "shop-1",
    shop_name: "Test Shop",
    platform: "shopee",
    customer_id: `cust-${id}`,
    to_name: `Customer ${id}`,
    status: "open",
    pinned: false,
    unread_count: 0,
    last_message_text: "hi",
    last_message_timestamp: new Date("2026-10-01T00:00:00Z"),
    created_at: new Date("2026-10-01T00:00:00Z"),
    updated_at: new Date("2026-10-01T00:00:00Z"),
    ...fields,
  });
}

function seedMeta(id: string, fields: Record<string, unknown>) {
  mocks.fakeColl("status_conversation").push({
    conversation_id: id,
    updated_at: new Date(),
    ...fields,
  });
}

function seedAdmin(id: string, fields: Record<string, unknown> = {}) {
  mocks.fakeColl("admins").push({
    admin_id: id,
    name: `Admin ${id}`,
    username: id,
    role: "admin",
    active: true,
    is_accepting_chats: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...fields,
  });
}

function seedShop() {
  mocks.fakeColl("shops").push({
    shop_id: "shop-1",
    platform: "shopee",
    enabled_for_chat: true,
  });
}

function seedMsg(convId: string, fields: Record<string, unknown> = {}) {
  mocks.fakeColl("messages").push({
    message_id: `m-${convId}-${mocks.fakeColl("messages").length}`,
    conversation_id: convId,
    role: "user",
    direction: "in",
    text: "msg",
    created_timestamp: new Date("2026-10-01T00:00:00Z"),
    ...fields,
  });
}

const metaOf = (id: string) =>
  mocks.fakeColl("status_conversation").find((d: any) => d.conversation_id === id);

async function authReq(adminId: string, url: string, init: any = {}) {
  const jwt = await import("../src/backend/lib/jwt");
  const { NextRequest } = await import("next/server");
  const { token } = await jwt.createSessionToken(adminId);
  mocks.fakeColl("sessions").push({
    token_hash: jwt.hashToken(token),
    admin_id: adminId,
    revoked: false,
    created_at: new Date(),
  });
  const headers = new Headers(init.headers || {});
  headers.set("cookie", `cc_session=${token}`);
  return new NextRequest(url, { ...init, headers });
}

const jsonHeaders = { "content-type": "application/json" };
const paramsOf = (conversationId: string) => ({
  params: Promise.resolve({ conversationId }),
});

// ── module refs (dynamic import หลัง env+hooks) ───────────────

let statusSvc: typeof import("../src/backend/service/statusConversationService");
let adminLogSvc: typeof import("../src/backend/service/adminLogService");
let assignSvc: typeof import("../src/backend/service/assignmentService");
let handoffSvc: typeof import("../src/backend/service/handoffService");
let botCall: typeof import("../src/backend/service/botCallService");
let wf: typeof import("../src/backend/service/workflowEngine");
let listRoute: typeof import("../src/app/api/admin/conversations/route");
let sendRoute: typeof import("../src/app/api/admin/conversations/[conversationId]/send/route");
let assignRoute: typeof import("../src/app/api/admin/conversations/[conversationId]/assign/route");
let detailRoute: typeof import("../src/app/api/admin/conversations/[conversationId]/route");
let teamRoute: typeof import("../src/app/api/team/route");
let statsLiveRoute: typeof import("../src/app/api/stats/live/route");
let statsDashboardRoute: typeof import("../src/app/api/stats/dashboard/route");
let statsPerfRoute: typeof import("../src/app/api/stats/performance/route");
let statsAdminActivityRoute: typeof import("../src/app/api/stats/admin-activity/route");
let botHandoffRoute: typeof import("../src/app/api/admin/conversations/bot-handoff/route");
let responseStatsLib: typeof import("../src/backend/lib/responseStats");

// ── main ─────────────────────────────────────────────────────

async function main() {
  mocks = await import("./test-ownership-transport-mocks.mjs");
  statusSvc = await import("../src/backend/service/statusConversationService");
  adminLogSvc = await import("../src/backend/service/adminLogService");
  assignSvc = await import("../src/backend/service/assignmentService");
  handoffSvc = await import("../src/backend/service/handoffService");
  botCall = await import("../src/backend/service/botCallService");
  wf = await import("../src/backend/service/workflowEngine");
  listRoute = await import("../src/app/api/admin/conversations/route");
  sendRoute = await import("../src/app/api/admin/conversations/[conversationId]/send/route");
  assignRoute = await import("../src/app/api/admin/conversations/[conversationId]/assign/route");
  detailRoute = await import("../src/app/api/admin/conversations/[conversationId]/route");
  teamRoute = await import("../src/app/api/team/route");
  statsLiveRoute = await import("../src/app/api/stats/live/route");
  statsDashboardRoute = await import("../src/app/api/stats/dashboard/route");
  statsPerfRoute = await import("../src/app/api/stats/performance/route");
  statsAdminActivityRoute = await import("../src/app/api/stats/admin-activity/route");
  botHandoffRoute = await import("../src/app/api/admin/conversations/bot-handoff/route");
  responseStatsLib = await import("../src/backend/lib/responseStats");

  const callBotOnce = async (conversationId: string | undefined, extra: any = {}) => {
    await botCall.callBot({
      platform: "shopee",
      message: "hello",
      shopId: "shop-1",
      shopName: "Test Shop",
      history: [],
      conversationId,
      ...extra,
    });
    return mocks.state.fetchBodies[0] || {};
  };

  // ═══ A. ticket_state transport (resolveTicketState via real callBot) ═══

  await test("A1 raw status=open + no meta → ticket_state=bot (dump ไม่ใช่ ownership)", async () => {
    seedConv("a1");
    const body = await callBotOnce("a1");
    assert(body.ticket_state === "bot", `ticket_state=${body.ticket_state} expected bot`);
  });

  await test("A2 raw open + meta handoff → ticket_state=handoff", async () => {
    seedConv("a2");
    seedMeta("a2", { status: "handoff", assigned_to: "admin-x" });
    const body = await callBotOnce("a2");
    assert(body.ticket_state === "handoff", `ticket_state=${body.ticket_state} expected handoff`);
  });

  await test("A3 raw open + meta pending → ticket_state=pending", async () => {
    seedConv("a3");
    seedMeta("a3", { status: "pending", assigned_to: null, pending_assignment: true });
    const body = await callBotOnce("a3");
    assert(body.ticket_state === "pending", `ticket_state=${body.ticket_state} expected pending`);
  });

  await test("A4 raw open + meta closed → ticket_state=closed", async () => {
    seedConv("a4");
    seedMeta("a4", { status: "closed", closed_at: new Date() });
    const body = await callBotOnce("a4");
    assert(body.ticket_state === "closed", `ticket_state=${body.ticket_state} expected closed`);
  });

  await test("A5 raw closed + meta handoff → meta ชนะ (handoff)", async () => {
    seedConv("a5", { status: "closed", closed_at: new Date() });
    seedMeta("a5", { status: "handoff", assigned_to: "admin-x" });
    const body = await callBotOnce("a5");
    assert(body.ticket_state === "handoff", `ticket_state=${body.ticket_state} expected handoff`);
  });

  await test("A6 raw assigned_to แต่ไม่มี meta → bot (raw ไม่ใช่ ownership)", async () => {
    seedConv("a6", { assigned_to: "ghost-admin" });
    const body = await callBotOnce("a6");
    assert(body.ticket_state === "bot", `ticket_state=${body.ticket_state} expected bot`);
  });

  await test("A7 meta read error → fail closed: callBot rejects, fetch ไม่ถูกเรียก", async () => {
    seedConv("a7");
    mocks.state.findOneHook = async (coll: string) => {
      if (coll === "status_conversation") throw new Error("injected meta read failure");
    };
    let threw = false;
    try {
      await callBotOnce("a7");
    } catch {
      threw = true;
    }
    assert(threw, "callBot should reject on meta read error (fail closed)");
    assert(mocks.state.fetchCalls === 0, "fetch must NOT be called when ownership read fails");
  });

  await test("A8 testSource → test_status_conversation status verbatim (pin)", async () => {
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: "a8",
      source: "botworker",
      status: "handoff",
    });
    const body = await callBotOnce("a8", { testSource: "botworker" });
    assert(body.ticket_state === "handoff", `ticket_state=${body.ticket_state} expected handoff`);
  });

  await test("A9 simulate → test_chat_sessions status (pin)", async () => {
    const oid = new ObjectId();
    mocks.fakeColl("test_chat_sessions").push({ _id: oid, status: "resolved" });
    const body = await callBotOnce(oid.toHexString(), { simulate: true });
    assert(body.ticket_state === "resolved", `ticket_state=${body.ticket_state} expected resolved`);
  });

  await test("A10 no conversation_id → ไม่มี ticket_state key (pin)", async () => {
    const body = await callBotOnce(undefined);
    assert(!("ticket_state" in body), "ticket_state must be absent without conversation_id");
  });

  await test("A11 meta exists w/o status (topic-only doc) → ticket_state=bot", async () => {
    seedConv("a11");
    seedMeta("a11", { topic: "warranty" });
    const body = await callBotOnce("a11");
    assert(body.ticket_state === "bot", `ticket_state=${body.ticket_state} expected bot`);
  });

  // ═══ B. writer contracts — persist meta ก่อน claim success ═══

  await test("B1 direct assign (targetAdminId) → typed assigned + meta persist ก่อน return", async () => {
    seedConv("b1"); seedShop(); seedAdmin("admin-1");
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "b1", shopId: "shop-1", platform: "shopee",
      targetAdminId: "admin-1",
    });
    assert(r?.state === "assigned" && r.assigned_to === "admin-1" && r.persisted === true,
      `direct assign must return typed outcome — got ${JSON.stringify(r)}`);
    const m = metaOf("b1");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1",
      `meta=${JSON.stringify(m)} expected handoff/admin-1`);
  });

  await test("B1b direct assign CAS guard — owner เปลี่ยนระหว่าง read→commit → converge persisted winner", async () => {
    seedConv("b1b"); seedShop(); seedAdmin("admin-2"); seedAdmin("admin-9");
    seedMeta("b1b", { status: "handoff", assigned_to: "admin-1" });
    // winner admin-9 ลงระหว่าง meta-read กับ commit CAS — fence ต้องกันการทับ
    let landed = false;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !landed) {
        landed = true;
        const d = metaOf("b1b");
        if (d) { d.assigned_to = "admin-9"; d.assigned_at = new Date(); }
      }
    };
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "b1b", shopId: "shop-1", platform: "shopee",
      targetAdminId: "admin-2",
    });
    (mocks.state as any).findOneAndUpdateHook = null;
    assert(r?.assigned_to === "admin-9",
      `must converge to persisted winner, not stale target — got ${JSON.stringify(r)}`);
    const m = metaOf("b1b");
    assert(m?.assigned_to === "admin-9", "meta must keep the real winner");
  });

  await test("B3 closeConversation → meta{closed,closed_at,closed_by,close_count++}", async () => {
    await statusSvc.closeConversation({
      conversationId: "b3", closedBy: "admin-1", reason: "done",
      category: "product", resolution: "answered",
    });
    const m1 = metaOf("b3");
    assert(m1?.status === "closed" && m1?.closed_at instanceof Date
      && m1?.closed_by === "admin-1" && m1?.close_count === 1,
      `meta=${JSON.stringify(m1)} expected closed/closed_by/admin-1/close_count=1`);
    await statusSvc.closeConversation({
      conversationId: "b3", closedBy: "admin-1", reason: "again",
      category: "product", resolution: "answered",
    });
    assert(metaOf("b3")?.close_count === 2, "close_count must increment");
  });

  await test("B4 reopenConversation admin→handoff / bot→bot+assigned_to cleared", async () => {
    seedMeta("b4a", { status: "closed", closed_at: new Date(), assigned_to: "admin-1" });
    await statusSvc.reopenConversation({ conversationId: "b4a", reopenedBy: "admin-1" });
    const m1 = metaOf("b4a");
    assert(m1?.status === "handoff" && m1?.closed_at === null,
      `reopen admin → handoff, got ${JSON.stringify(m1)}`);
    seedMeta("b4b", { status: "closed", closed_at: new Date(), assigned_to: "admin-1" });
    await statusSvc.reopenConversation({ conversationId: "b4b", reopenedBy: "bot", targetStatus: "bot" });
    const m2 = metaOf("b4b");
    assert(m2?.status === "bot" && m2?.assigned_to === null && m2?.closed_at === null,
      `reopen bot → bot+assigned cleared, got ${JSON.stringify(m2)}`);
  });

  await test("B6 assignPendingTicket → assign เฉพาะ pending; non-pending → false", async () => {
    seedMeta("b6a", { status: "handoff", assigned_to: null, pending_assignment: true });
    const ok = await statusSvc.assignPendingTicket("b6a", "admin-1", "distributor");
    assert(ok === true, "assignPendingTicket on pending should succeed");
    const m = metaOf("b6a");
    assert(m?.assigned_to === "admin-1" && m?.pending_assignment === false,
      `meta=${JSON.stringify(m)} expected assigned+pending cleared`);
    const ok2 = await statusSvc.assignPendingTicket("b6b", "admin-1", "distributor");
    assert(ok2 === false, "assignPendingTicket on non-pending must fail");
  });

  await test("B11 reassign: from_admin_id ใน log ต้องมาจาก meta ไม่ใช่ raw", async () => {
    seedMeta("b11", { status: "handoff", assigned_to: "real-admin" });
    await assignSvc.reassignConversation(
      { _id: new ObjectId(), conversation_id: "b11", shop_id: "shop-1" },
      "admin-2", "actor-1",
    );
    const log = mocks.fakeColl("admin_logs").find(
      (d: any) => d.conversation_id === "b11" && d.action_type === "chat_reassigned");
    assert(log?.metadata?.from_admin_id === "real-admin",
      `from_admin_id=${log?.metadata?.from_admin_id} expected real-admin (meta), not stale-raw`);
    assert(metaOf("b11")?.assigned_to === "admin-2", "meta must move to admin-2");
  });

  await test("B12 handoff จ่ายคนไม่ได้ → persist pending marker (assigned_to:null)", async () => {
    seedConv("b12");
    // no admins → no pool → pending path
    const r = await handoffSvc.handoffToAdmin({
      conversationId: "b12", shopId: "shop-1", platform: "shopee",
    });
    assert(r.assigned_to === null, "no admin → assigned_to null");
    const m = metaOf("b12");
    assert(m?.pending_assignment === true && m?.assigned_to === null
      && (m?.status === "handoff" || m?.status === "pending"),
      `meta=${JSON.stringify(m)} — pending outcome must be durably persisted`);
  });

  await test("B13 handoff สำเร็จ → meta{handoff,assigned_to} persist ก่อน return", async () => {
    seedConv("b13");
    seedShop();
    seedAdmin("admin-1");
    const r = await handoffSvc.handoffToAdmin({
      conversationId: "b13", shopId: "shop-1", platform: "shopee",
    });
    assert(r.assigned_to === "admin-1", `handoff should assign admin-1, got ${r.assigned_to}`);
    const m = metaOf("b13");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1",
      `meta=${JSON.stringify(m)} expected handoff/admin-1 persisted before return`);
  });

  const seedAssignWorkflow = () => {
    (mocks.state as any).config.workflow_enabled = true;
    mocks.fakeColl("workflows").push({
      workflow_id: "wf-assign", name: "direct assign",
      shop_ids: ["shop-1"], platforms: ["shopee"],
      enabled: true, status: "published", is_deleted: false,
      trigger_frequency: "every_time", priority: 1, created_at: new Date(),
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: { keywords: ["สวัสดี"] } },
        { node_id: "a1", type: "action", subtype: "assign_ticket", config: { admin_id: "admin-9", reason: "wf" } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }],
    });
  };

  await test("B14 workflow assign_ticket (direct, prod) → เขียน meta เท่านั้น ไม่เขียน raw", async () => {
    seedAssignWorkflow();
    seedConv("b14"); // raw conv มีอยู่ — ไม่มี assigned_to
    const res = await wf.matchAndRun({
      message_id: "m-b14", conversation_id: "b14", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    assert(res.status === "actioned", `matchAndRun status=${res.status} detail=${res.detail}`);
    const meta = metaOf("b14");
    assert(meta?.status === "handoff" && meta?.assigned_to === "admin-9",
      `meta must be handoff/admin-9 — got status=${meta?.status} assigned_to=${meta?.assigned_to}`);
    const raw = mocks.fakeColl("conversations").find((d: any) => d.conversation_id === "b14");
    assert(!raw?.assigned_to,
      `raw conversations.assigned_to ต้องไม่ถูกเขียน — got ${raw?.assigned_to}`);
  });

  await test("B15 workflow assign_ticket = transfer — meta owner เดิมถูกย้ายผ่าน meta เท่านั้น", async () => {
    seedAssignWorkflow();
    seedConv("b15");
    seedMeta("b15", { status: "handoff", assigned_to: "admin-1" });
    const res = await wf.matchAndRun({
      message_id: "m-b15", conversation_id: "b15", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    assert(res.handoff?.agentId === "admin-9",
      `direct assign = transfer → admin-9 — got ${res.handoff?.agentId}`);
    const meta = metaOf("b15");
    assert(meta?.status === "handoff" && meta?.assigned_to === "admin-9",
      `meta must transfer to admin-9 — got ${meta?.status}/${meta?.assigned_to}`);
    const raw = mocks.fakeColl("conversations").find((d: any) => d.conversation_id === "b15");
    assert(!raw?.assigned_to, "raw conversations.assigned_to ต้องไม่ถูกเขียน");
  });

  // ═══ C. reader contracts — meta เท่านั้น ห้าม raw fallback ═══

  await test("C1 mapToConversation: meta ชนะ raw (pin)", async () => {
    const { mapToConversation } = listRoute as any;
    seedConv("c1", { status: "open" });
    const raw = mocks.fakeColl("conversations")[0];
    const conv = mapToConversation(raw, new Map(), 0,
      { status: "handoff", assigned_to: "admin-1" });
    assert(conv.status === "handoff" && conv.assigned_to === "admin-1",
      `got status=${conv.status} assigned_to=${conv.assigned_to}`);
  });

  await test("C2 mapToConversation: ไม่มี meta + raw evidence → bot (raw ไม่นับ)", async () => {
    const { mapToConversation } = listRoute as any;
    const raw = {
      conversation_id: "c2", platform: "shopee", shop_id: "s", shop_name: "s",
      customer_id: "x", to_name: "t", status: "open",
      assigned_to: "ghost-legacy", closed_at: new Date(),
      last_message_text: "", last_message_timestamp: new Date(),
    } as any;
    const conv = mapToConversation(raw, new Map(), 0, undefined);
    assert(conv.status === "bot",
      `missing meta + raw assigned_to/closed_at → expected bot, got ${conv.status}`);
    assert(!conv.assigned_to, `assigned_to must be undefined, got ${conv.assigned_to}`);
  });

  await test("C3 mapToConversation: meta ไม่มี status + raw closed_at → bot", async () => {
    const { mapToConversation } = listRoute as any;
    const raw = {
      conversation_id: "c3", platform: "shopee", shop_id: "s", shop_name: "s",
      customer_id: "x", to_name: "t", status: "open", closed_at: new Date(),
      last_message_text: "", last_message_timestamp: new Date(),
    } as any;
    const conv = mapToConversation(raw, new Map(), 0, { topic: "warranty" });
    assert(conv.status === "bot",
      `meta w/o status + raw closed_at → expected bot, got ${conv.status}`);
  });

  await test("C4 assigned_to filter: meta เท่านั้น — raw-only assignment ไม่นับ", async () => {
    seedAdmin("me");
    seedConv("c4-meta"); seedMeta("c4-meta", { status: "handoff", assigned_to: "admin-1" });
    seedConv("c4-raw", { assigned_to: "admin-1" }); // raw stale — no meta
    const req = await authReq("me", "http://t/api/admin/conversations?assigned_to=admin-1");
    listRoute.invalidateConversationsCache();
    const rows = (await (await listRoute.GET(req as any)).json()) as any[];
    const ids = rows.map((r: any) => r.id);
    assert(ids.includes("c4-meta"), "meta assignment must be counted");
    assert(!ids.includes("c4-raw"),
      `raw-only assigned_to must NOT be counted — got ${JSON.stringify(ids)}`);
  });

  await test("C5 send: meta.assigned_to=คนอื่น → 409 conflict", async () => {
    seedAdmin("me");
    seedAdmin("other");
    seedConv("c5");
    seedMeta("c5", { status: "handoff", assigned_to: "other" });
    const req = await authReq("me", "http://t/api/admin/conversations/c5/send", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ text: "note" }),
    });
    const res = await sendRoute.POST(req as any, paramsOf("c5"));
    assert(res.status === 409,
      `send while meta.assigned_to=other → expected 409, got ${res.status}`);
    const body = await res.json();
    assert(body.conflict === true && body.assigned_to === "other",
      `conflict body must carry meta assigned_to, got ${JSON.stringify(body)}`);
  });

  await test("C6 send: raw.assigned_to=คนอื่น + meta=me → 200 (raw ห้ามชนะ meta)", async () => {
    seedAdmin("me");
    seedConv("c6", { assigned_to: "other-ghost" });
    seedMeta("c6", { status: "handoff", assigned_to: "me" });
    const req = await authReq("me", "http://t/api/admin/conversations/c6/send", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ text: "note" }),
    });
    const res = await sendRoute.POST(req as any, paramsOf("c6"));
    assert(res.status === 200,
      `raw stale assigned_to must not trigger conflict — expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.assigned_to === "me",
      `response assigned_to must come from meta (me), got ${JSON.stringify(body.assigned_to)}`);
  });

  await test("C7 [id] GET: status/assigned_to จาก meta (raw เป็น display เท่านั้น)", async () => {
    seedAdmin("me");
    seedConv("c7", { status: "open", assigned_to: "ghost" });
    seedMeta("c7", { status: "handoff", assigned_to: "admin-1" });
    const req = await authReq("me", "http://t/api/admin/conversations/c7");
    const res = await detailRoute.GET(req as any, paramsOf("c7"));
    const body = await res.json();
    assert(body.status === "handoff", `status must be meta handoff, got ${body.status}`);
    assert(body.assigned_to === "admin-1",
      `assigned_to must be meta admin-1, got ${body.assigned_to}`);
  });

  await test("C8 team workload: assigned นับจาก meta เท่านั้น", async () => {
    seedAdmin("me");
    seedAdmin("admin-1");
    seedConv("c8-a"); // raw open, no meta → bot-owned
    seedConv("c8-b", { assigned_to: "ghost-legacy" }); // raw stale → must NOT count
    seedMeta("c8-a", { status: "handoff", assigned_to: "admin-1" });
    const req = await authReq("me", "http://t/api/team");
    const res = await teamRoute.GET(req as any);
    const body = await res.json();
    assert(body.total_open_conversations === 1,
      `assigned count must be meta-only = 1, got ${body.total_open_conversations}`);
  });

  await test("C9 workflowEngine assignee node: อ่าน meta (prod branch)", async () => {
    seedConv("c9", { assigned_to: "ghost-raw" }); // raw stale
    seedMeta("c9", { status: "handoff", assigned_to: "admin-1" });
    const evalCond = (wf as any).evalLegacyCondition;
    assert(typeof evalCond === "function", "evalLegacyCondition must be exported for tests");
    const node: any = { subtype: "assignee", config: { admin_id: "admin-1" } };
    const msg: any = { conversation_id: "c9", text: "", platform: "shopee", customer_id: "x" };
    const hit = await evalCond(node, msg, {});
    assert(hit === true, `meta.assigned_to=admin-1 should match wantAdmin — got ${hit}`);
    const anyAssignee = await evalCond(
      { subtype: "assignee", config: {} } as any, msg, {});
    assert(anyAssignee === true, `meta assigned → assignee(any) should be true, got ${anyAssignee}`);
    // raw-only stale ไม่นับ: ลบ meta → false
    mocks.fakeColl("status_conversation").length = 0;
    const staleOnly = await evalCond(
      { subtype: "assignee", config: { admin_id: "ghost-raw" } } as any, msg, {});
    assert(staleOnly === false,
      `raw-only assigned_to must NOT satisfy assignee node — got ${staleOnly}`);
  });

  await test("C10 assign route: meta.assigned_to=null + raw stale → assign ได้", async () => {
    seedAdmin("me");
    seedAdmin("admin-2");
    seedConv("c10", { assigned_to: "stale-ghost" });
    seedMeta("c10", { status: "bot", assigned_to: null });
    const req = await authReq("me", "http://t/api/admin/conversations/c10/assign", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ admin_id: "admin-2" }),
    });
    const res = await assignRoute.POST(req as any, paramsOf("c10"));
    assert(res.status === 200, `assign should succeed, got ${res.status}`);
    assert(metaOf("c10")?.assigned_to === "admin-2", "meta must record admin-2");
  });

  // ═══ F1. explicit owner-clear semantics (review fix) ═══
  //   contract: undefined = ไม่แตะ owner / null = ล้าง owner / string = ตั้ง owner

  await test("F1-1 updateStatus(…, undefined) → คง owner เดิม", async () => {
    seedMeta("f1a", { status: "handoff", assigned_to: "admin-1", assigned_at: new Date("2026-01-01") });
    await statusSvc.updateStatus("f1a", "open", undefined);
    const m = metaOf("f1a")!;
    assert(m.status === "open", `status must be open, got ${m.status}`);
    assert(m.assigned_to === "admin-1", `owner must be preserved, got ${m.assigned_to}`);
  });

  await test("F1-2 updateStatus(…, null) → ล้าง owner + ไม่ตั้ง assigned_at ใหม่", async () => {
    seedMeta("f1b", { status: "handoff", assigned_to: "admin-1", assigned_at: new Date("2026-01-01") });
    await statusSvc.updateStatus("f1b", "open", null);
    const m = metaOf("f1b")!;
    assert(m.assigned_to === null, `assigned_to must be null, got ${JSON.stringify(m.assigned_to)}`);
    assert(!(m.assigned_at instanceof Date),
      `assigned_at must not be a fresh Date after clear, got ${m.assigned_at}`);
  });

  await test("F1-3 updateStatus(…, 'admin-2') → ตั้ง owner ใหม่ + assigned_at", async () => {
    seedMeta("f1c", { status: "handoff", assigned_to: "admin-1" });
    await statusSvc.updateStatus("f1c", "handoff", "admin-2");
    const m = metaOf("f1c")!;
    assert(m.assigned_to === "admin-2", `owner must be admin-2, got ${m.assigned_to}`);
    assert(m.assigned_at instanceof Date, "assigned_at must be Date on assign");
  });

  await test("F1-4 reassign new_admin_id=null → unassign: status=handoff + assigned_to=null", async () => {
    seedAdmin("actor-1");
    seedConv("f1d");
    seedMeta("f1d", { status: "handoff", assigned_to: "admin-1" });
    await assignSvc.reassignConversation(
      { _id: new ObjectId(), conversation_id: "f1d", shop_id: "shop-1" },
      null,
      "actor-1",
    );
    const m = metaOf("f1d")!;
    assert(m.status === "handoff", `unassign must stay handoff (awaiting), got ${m.status}`);
    assert(m.assigned_to === null, `assigned_to must be null, got ${JSON.stringify(m.assigned_to)}`);
  });

  await test("F1-5 list GET: closed meta + msg ใหม่ → read-only (ไม่เขียน meta)", async () => {
    seedAdmin("me");
    seedConv("f1e", { last_message_timestamp: new Date() });
    seedMeta("f1e", { status: "closed", assigned_to: "admin-1", closed_at: new Date("2020-01-01") });
    listRoute.invalidateConversationsCache();
    const req = await authReq("me", "http://t/api/admin/conversations");
    const rows = await (await listRoute.GET(req as any)).json() as any[];
    const m = metaOf("f1e")!;
    assert(m.status === "closed" && m.assigned_to === "admin-1",
      `read-only GET must not rewrite meta, got ${JSON.stringify({ s: m.status, a: m.assigned_to })}`);
    const row = rows.find((r: any) => r.id === "f1e");
    assert(row?.status === "closed" && row?.assigned_to === "admin-1",
      `row must show authoritative meta (closed+owner history), got status=${row?.status} assigned=${row?.assigned_to}`);
  });

  // ═══ F2. status filter อ่าน meta (ไม่ใช่ raw dump) ═══

  const listGet = async (qs: string) => {
    listRoute.invalidateConversationsCache();
    const req = await authReq("me", `http://t/api/admin/conversations${qs}`);
    return (await listRoute.GET(req as any)).json();
  };
  const rowIds = (body: any): string[] =>
    (Array.isArray(body) ? body : body.rows).map((r: any) => r.id).sort();

  await test("F2-1 raw open + meta handoff → status=handoff พบ / status=bot ไม่พบ", async () => {
    seedAdmin("me");
    seedConv("f2a");
    seedMeta("f2a", { status: "handoff", assigned_to: "admin-1" });
    assert(rowIds(await listGet("?status=handoff")).includes("f2a"),
      "status=handoff must find conv via meta");
    assert(!rowIds(await listGet("?status=bot")).includes("f2a"),
      "status=bot must NOT find human-owned conv");
  });

  await test("F2-2 raw open + meta closed → status=closed พบ", async () => {
    seedAdmin("me");
    seedConv("f2b");
    seedMeta("f2b", { status: "closed", assigned_to: "admin-1", closed_at: new Date("2099-01-01") });
    assert(rowIds(await listGet("?status=closed")).includes("f2b"),
      "status=closed must find conv via meta");
    assert(!rowIds(await listGet("?status=handoff")).includes("f2b"),
      "status=handoff must NOT find closed conv");
  });

  await test("F2-3 raw open + missing meta → status=bot พบ (missing = bot)", async () => {
    seedAdmin("me");
    seedConv("f2c");
    assert(rowIds(await listGet("?status=bot")).includes("f2c"),
      "status=bot must find missing-meta conv");
    assert(!rowIds(await listGet("?status=handoff")).includes("f2c"),
      "status=handoff must NOT find missing-meta conv");
  });

  await test("F2-4 topic-only meta (no status) → status=bot พบ", async () => {
    seedAdmin("me");
    seedConv("f2d");
    seedMeta("f2d", { topic: "refund" });
    assert(rowIds(await listGet("?status=bot")).includes("f2d"),
      "status=bot must find no-status meta conv");
  });

  await test("F2-5 raw closed + assigned stale + missing meta → status=bot พบ (raw ignored)", async () => {
    seedAdmin("me");
    seedConv("f2e", { status: "closed", assigned_to: "ghost", closed_at: new Date() });
    assert(rowIds(await listGet("?status=bot")).includes("f2e"),
      "status=bot must find conv regardless of raw closed/assigned");
    assert(!rowIds(await listGet("?status=closed")).includes("f2e"),
      "status=closed must NOT honor raw closed status");
  });

  await test("F2-6 status + assigned_to filter → intersect ถูก", async () => {
    seedAdmin("me");
    seedConv("f2f"); seedMeta("f2f", { status: "handoff", assigned_to: "admin-1" });
    seedConv("f2g"); seedMeta("f2g", { status: "handoff", assigned_to: "admin-2" });
    seedConv("f2h"); seedMeta("f2h", { status: "closed", assigned_to: "admin-1", closed_at: new Date("2099-01-01") });
    const rows = rowIds(await listGet("?status=handoff&assigned_to=admin-1"));
    assert(rows.length === 1 && rows[0] === "f2f",
      `status=handoff ∩ assigned_to=admin-1 must return only f2f, got ${JSON.stringify(rows)}`);
  });

  await test("F2-7 include_count → total_count ใช้ constraint เดียวกับ rows", async () => {
    seedAdmin("me");
    seedConv("f2i"); seedConv("f2j"); // missing meta → bot ×2
    seedConv("f2k"); seedMeta("f2k", { status: "handoff", assigned_to: "admin-1" });
    const body = await listGet("?status=bot&include_count=true");
    assert(body.total_count === 2, `total_count must be 2 bot convs, got ${body.total_count}`);
    assert(body.rows.length === 2, `rows must be 2 bot convs, got ${body.rows.length}`);
  });

  await test("F2-8 pagination → กรองก่อน limit/cursor (ไม่ใช่ fetch แล้ว filter ใน JS)", async () => {
    seedAdmin("me");
    seedConv("p1", { last_message_timestamp: new Date("2026-10-03") });
    seedConv("p2", { last_message_timestamp: new Date("2026-10-02") });
    seedConv("p3", { last_message_timestamp: new Date("2026-10-01") });
    seedConv("p4", { last_message_timestamp: new Date("2026-10-04") });
    seedMeta("p4", { status: "handoff", assigned_to: "admin-1" }); // newest raw — must be filtered out
    const page1 = await listGet("?status=bot&limit=2&include_count=true");
    assert(page1.rows.length === 2 && page1.has_more === true,
      `page1 must have 2 bot rows + has_more, got rows=${page1.rows.length} more=${page1.has_more}`);
    const ids1 = page1.rows.map((r: any) => r.id);
    assert(ids1.includes("p1") && ids1.includes("p2") && !ids1.includes("p4"),
      `page1 must be bot rows p1,p2 (p4 handoff excluded pre-limit), got ${JSON.stringify(ids1)}`);
    const page2 = await listGet(`?status=bot&limit=2&include_count=true&cursor=${encodeURIComponent(page1.cursor)}`);
    const ids2 = page2.rows.map((r: any) => r.id);
    assert(ids2.length === 1 && ids2[0] === "p3",
      `page2 must continue with p3, got ${JSON.stringify(ids2)}`);
  });

  // ═══ F3. canonical ownership metrics ═══
  //   partition: active(h/o/p+assigned) | awaiting(h/p+unassigned) | closed(c/r) | bot(else)

  const seedMetricSet = (prefix: string, convFields: Record<string, unknown> = {}) => {
    seedConv(`${prefix}1`, convFields); seedMeta(`${prefix}1`, { status: "closed", assigned_to: "admin-1", closed_at: new Date() });
    seedConv(`${prefix}2`, convFields); seedMeta(`${prefix}2`, { status: "handoff", assigned_to: "admin-1" });
    seedConv(`${prefix}3`, convFields); seedMeta(`${prefix}3`, { status: "pending", assigned_to: null });
    seedConv(`${prefix}4`, convFields); // missing meta → bot
    seedConv(`${prefix}5`, convFields); seedMeta(`${prefix}5`, { topic: "refund" }); // no-status → bot
  };

  await test("F3-1 team: closed+assigned → closed เท่านั้น + partition mutually exclusive", async () => {
    seedAdmin("me"); seedAdmin("admin-1");
    seedMetricSet("t");
    const req = await authReq("me", "http://t/api/team");
    const body = await (await teamRoute.GET(req as any)).json();
    assert(body.total_conversations === 5, `total must be 5, got ${body.total_conversations}`);
    assert(body.total_open_conversations === 1,
      `active assigned must be 1 (closed+assigned excluded), got ${body.total_open_conversations}`);
    assert(body.unassigned_handoff === 1,
      `awaiting must be 1 (pending unassigned), got ${body.unassigned_handoff}`);
    assert(body.unassigned === 3, `unassigned = awaiting+bot = 3, got ${body.unassigned}`);
    assert(body.unassigned_open === 2, `bot-owned must be 2, got ${body.unassigned_open}`);
    const a1 = body.agents.find((a: any) => a.admin_id === "admin-1");
    assert(a1.workload.active === 1,
      `workload.active must be 1 (closed not active), got ${JSON.stringify(a1.workload)}`);
    assert(a1.workload.closed === 1,
      `workload.closed must count retained-owner closed, got ${JSON.stringify(a1.workload)}`);
  });

  await test("F3-2 stats/live: ownership จาก meta เท่านั้น (partition)", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    seedMetricSet("s");
    const req = await authReq("me", "http://t/api/stats/live?range=all");
    const body = await (await statsLiveRoute.GET(req as any)).json();
    assert(body.open_total === 4, `open_total must be 4 (not-closed), got ${body.open_total}`);
    assert(body.open_assigned === 1,
      `open_assigned must be 1 (active only), got ${body.open_assigned}`);
    assert(body.closed_total === 1, `closed_total must be 1, got ${body.closed_total}`);
    const w = body.workload_by_admin;
    assert(w.length === 1 && w[0].admin_id === "admin-1" && w[0].count === 1,
      `workload must be admin-1:1 (closed excluded), got ${JSON.stringify(w)}`);
    const bd = Object.fromEntries(body.breakdown_by_status.map((s: any) => [s.status, s.count]));
    assert(bd.bot_answered === 2, `bot_answered must be 2, got ${bd.bot_answered}`);
    assert(bd.open === 2, `open (human-owned incl awaiting) must be 2, got ${bd.open}`);
    assert(bd.closed === 1, `closed must be 1, got ${bd.closed}`);
    assert(bd.bot_answered + bd.open + bd.closed === 5, "partition must sum to total");
  });

  await test("F3-3 stats/dashboard: bot_answered/with_admin/closed จาก meta", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    // ⚡ seed ย้อน 1s — end bound ของ route ใช้ $lt (exclusive); ถ้า ts == end
    //    millisecond เดียวกัน (JWT path เร็ว) จะหลุดจาก range → flake 0/5
    //    (clamp ไม่ให้ข้ามเที่ยงคืน local — range daily = [00:00, now))
    seedMetricSet("d", {
      last_message_timestamp: new Date(Math.max(Date.now() - 1000, new Date().setHours(0, 0, 0, 1))),
    });
    const req = await authReq("me", "http://t/api/stats/dashboard?range=daily");
    const body = await (await statsDashboardRoute.GET(req as any)).json();
    assert(body.total_conversations === 5, `total must be 5, got ${body.total_conversations}`);
    assert(body.closed === 1, `closed must be 1, got ${body.closed}`);
    assert(body.with_admin === 2, `with_admin (h/o/p) must be 2, got ${body.with_admin}`);
    assert(body.bot_answered === 2, `bot_answered must be 2, got ${body.bot_answered}`);
    assert(body.bot_answered + body.with_admin + body.closed === body.total_conversations,
      "partition must sum to total");
  });

  // ═══ G. response rate — customer-turn measurement (Round 2) ═══
  //   contract (จาก UI labels "อัตราการตอบกลับภายใน 10 นาที"):
  //     customer turn = run ของ user msgs ต่อเนื่อง (ts = user msg สุดท้ายของ run)
  //     denominator   = eligible turns (user ts ∈ range)
  //     numerator     = turns ที่มี first qualifying response ≤10min
  //     first response = out msg แรกหลัง turn (adminOnly → เฉพาะ role=admin)
  //   ห้ามนับ reply ทุกข้อความ / ห้ามหารด้วย conversation count (คนละ population)

  const msgCollFor = async () => (await mocks.getCollection("messages")) as any;
  const T0 = new Date("2026-10-01T00:00:00Z").getTime();
  const at = (sec: number) => new Date(T0 + sec * 1000);

  await test("G1 1 customer turn + admin 3 replies → 1 answered turn (≤100%)", async () => {
    seedMsg("g1", { created_timestamp: at(0) });
    for (const s of [300, 900, 1500]) {
      seedMsg("g1", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(s) });
    }
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), {});
    assert(s.totalTurns === 1, `totalTurns must be 1 turn not 3 replies, got ${s.totalTurns}`);
    assert(s.within10minTurns === 1, `within10minTurns must be 1, got ${s.within10minTurns}`);
    const a = s.perAdmin.get("admin-1");
    assert(a?.total === 1 && a.within10min === 1,
      `perAdmin must count 1 turn, got ${JSON.stringify(a)}`);
  });

  await test("G2 2 eligible turns ตอบทัน 1 → basis 1/2 (unanswered turn อยู่ใน denominator)", async () => {
    seedMsg("g2a", { created_timestamp: at(0) });
    seedMsg("g2a", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(300) });
    seedMsg("g2b", { created_timestamp: at(0) });
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), {});
    assert(s.totalTurns === 2, `totalTurns must include unanswered = 2, got ${s.totalTurns}`);
    assert(s.answeredTurns === 1, `answeredTurns must be 1, got ${s.answeredTurns}`);
    assert(s.within10minTurns === 1, `within10minTurns must be 1, got ${s.within10minTurns}`);
  });

  await test("G3 sequential turns ในแชทเดียว: user→reply→user(ไม่ตอบ) → 2 turns", async () => {
    seedMsg("g3", { created_timestamp: at(0) });
    seedMsg("g3", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(300) });
    seedMsg("g3", { created_timestamp: at(3600) });
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), {});
    assert(s.totalTurns === 2, `sequential turns must be 2, got ${s.totalTurns}`);
    assert(s.answeredTurns === 1, `answered must be 1, got ${s.answeredTurns}`);
  });

  await test("G4 reassign: perAdmin ตาม first-reply actor ไม่ใช่ owner ปัจจุบัน", async () => {
    seedMsg("g4", { created_timestamp: at(0) });
    seedMsg("g4", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(300) });
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), { adminOnly: true });
    assert(s.perAdmin.get("admin-1")?.total === 1,
      "turn must attribute to first-reply actor admin-1");
    assert(!s.perAdmin.has("admin-2"), "current owner admin-2 must not steal numerator");
  });

  await test("G5 adminOnly: bot reply ไม่นับ — first qualifying = first ADMIN reply", async () => {
    seedMsg("g5", { created_timestamp: at(0) });
    seedMsg("g5", { role: "bot", direction: "out", created_timestamp: at(60) });
    seedMsg("g5", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(1200) });
    const adminOnly = await responseStatsLib.computeResponseStats(await msgCollFor(), { adminOnly: true });
    assert(adminOnly.within10minTurns === 0,
      `admin-only must not count bot@60s within10, got ${adminOnly.within10minTurns}`);
    assert(adminOnly.answeredTurns === 1, `admin@1200s answers turn, got ${adminOnly.answeredTurns}`);
    const all = await responseStatsLib.computeResponseStats(await msgCollFor(), {});
    assert(all.within10minTurns === 1, `bot+admin mode counts bot@60s, got ${all.within10minTurns}`);
  });

  await test("G6 zero turns → all-zero ไม่ใช่ NaN", async () => {
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), {});
    assert(s.totalTurns === 0 && s.avgResponseSeconds === 0 && s.within10minTurns === 0,
      `empty must be all-zero, got turns=${s.totalTurns} avg=${s.avgResponseSeconds}`);
  });

  await test("G7 avg response time ใช้ first eligible reply เท่านั้น", async () => {
    seedMsg("g7", { created_timestamp: at(0) });
    seedMsg("g7", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(300) });
    seedMsg("g7", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(7200) });
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), { adminOnly: true });
    assert(s.avgResponseSeconds === 300,
      `avg must be first-response 300s only, got ${s.avgResponseSeconds}`);
  });

  await test("G8 performance route: 1 turn ตอบ 3 replies + 1 turn ไม่ตอบ → rate=50 ไม่ใช่ 150", async () => {
    seedAdmin("me", { role: "dev" });
    seedConv("g8a", { created_at: new Date() });
    seedConv("g8b", { created_at: new Date() });
    const now = Date.now();
    seedMsg("g8a", { created_timestamp: new Date(now - 60000) });
    for (const s of [30000, 45000, 55000]) {
      seedMsg("g8a", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: new Date(now - 60000 + s) });
    }
    seedMsg("g8b", { created_timestamp: new Date(now - 60000) });
    const req = await authReq("me", "http://t/api/stats/performance?range=all");
    const body = await (await statsPerfRoute.GET(req as any)).json();
    const rate = body.overview.response_rate_10min.value;
    assert(rate === 50, `1/2 turns answered ≤10min must be 50%, got ${rate}%`);
  });

  await test("G9 admin-activity route: per-admin rate จาก turn population เดียวกัน", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    seedConv("g9a", { created_at: new Date() }); seedMeta("g9a", { status: "handoff", assigned_to: "admin-1" });
    seedConv("g9b", { created_at: new Date() }); seedMeta("g9b", { status: "handoff", assigned_to: "admin-1" });
    const now = Date.now();
    seedMsg("g9a", { created_timestamp: new Date(now - 60000) });
    for (const s of [30000, 40000, 50000]) {
      seedMsg("g9a", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: new Date(now - 60000 + s) });
    }
    seedMsg("g9b", { created_timestamp: new Date(now - 60000) });
    seedMsg("g9b", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: new Date(now - 60000 + 1200000) });
    const req = await authReq("me", "http://t/api/stats/admin-activity?range=all");
    const body = await (await statsAdminActivityRoute.GET(req as any)).json();
    const row = body.individual_performance.find((r: any) => r.admin_id === "admin-1");
    assert(row, "admin-1 row must exist");
    assert(row.response_rate_10min === 50,
      `admin-1: 2 turns answered (1 fast 1 slow) → 50%, got ${row.response_rate_10min}%`);
  });

  await test("G10 performance route: zero turns → rate=0 ไม่ใช่ NaN/Infinity", async () => {
    seedAdmin("me", { role: "dev" });
    seedConv("g10", { created_at: new Date() });
    const req = await authReq("me", "http://t/api/stats/performance?range=all");
    const body = await (await statsPerfRoute.GET(req as any)).json();
    const rate = body.overview.response_rate_10min.value;
    assert(rate === 0 && Number.isFinite(rate), `zero denominator must give 0, got ${rate}`);
  });

  // ═══ K. response-time contract (Option B approved: 24h grace) ═══
  //   turn เข้า period เมื่อ turn_ts ∈ [start,end); post-end events ใน
  //   [end, end+24h) resolve open turn; ≥ graceEnd ไม่เปลี่ยน period (freeze)
  //   equal-ts user+reply → user ชนะ (run ต่อ); turn ก่อน start ไม่เพิ่ม denominator

  const K_START = at(0);
  const K_END = at(3600);

  await test("K2 user ก่อน end + reply ช้ากว่า 10min หลัง end → answered ไม่ within10", async () => {
    seedMsg("k2", { created_timestamp: at(3540) });
    seedMsg("k2", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(3540 + 1200) });
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), { start: K_START, end: K_END, adminOnly: true });
    assert(s.answeredTurns === 1, `late reply must still answer the turn, got ${s.answeredTurns}`);
    assert(s.within10minTurns === 0, `latency >600 must not count within10, got ${s.within10minTurns}`);
    assert(s.avgResponseSeconds === 1200, `avg must be 1200s, got ${s.avgResponseSeconds}`);
  });

  await test("K4 turn ก่อน start + reply ใน range → ไม่เพิ่ม denominator", async () => {
    seedMsg("k4", { created_timestamp: at(-600) });                                      // before start
    seedMsg("k4", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(300) });
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), { start: K_START, end: K_END, adminOnly: true });
    assert(s.totalTurns === 0 && s.answeredTurns === 0,
      `pre-start turn's in-range reply must not count, got turns=${s.totalTurns} answered=${s.answeredTurns}`);
  });

  await test("K5 replies หลายฉบับหลัง boundary → นับ first response ครั้งเดียว", async () => {
    seedMsg("k5", { created_timestamp: at(3540) });
    for (const s of [3660, 3900, 5340]) {
      seedMsg("k5", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: at(s) });
    }
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), { start: K_START, end: K_END, adminOnly: true });
    assert(s.answeredTurns === 1 && s.avgResponseSeconds === 120,
      `first post-end reply only: answered=1 avg=120, got answered=${s.answeredTurns} avg=${s.avgResponseSeconds}`);
  });

  await test("K7 route parity: performance range=daily — reply ข้าม end ยังนับ turn", async () => {
    seedAdmin("me", { role: "dev" });
    seedConv("k7", { created_at: new Date(Date.now() - 7200_000) });
    seedMsg("k7", { created_timestamp: new Date(Date.now() - 60_000) });                 // now-60s
    seedMsg("k7", { role: "admin", direction: "out", actor: "admin-1", created_timestamp: new Date(Date.now() + 60_000) }); // beyond route's end=now
    const req = await authReq("me", "http://t/api/stats/performance?range=daily");
    const body = await (await statsPerfRoute.GET(req as any)).json();
    const rate = body.overview.response_rate_10min.value;
    assert(rate === 100, `cross-boundary reply must resolve turn → rate=100, got ${rate}`);
  });

  // ═══ L. list GET = read-only transport (Phase 2B.1 closure) ═══
  //   audit: ไม่มี inbound-lifecycle owner ใน repo — messages_shp เขียนโดย external
  //   dump (นอก repo), botworker เขียน test_status_conversation sandbox เท่านั้น,
  //   botCallService เป็น reader, bot-handoff เป็น handoff callback
  //   → closed→bot reopen on inbound = BLOCKED_BY_MISSING_INBOUND_LIFECYCLE_OWNER
  //   list GET ต้องเป็น pure read: ไม่เขียน, ไม่ query lifecycle candidates

  const listGetRaw = async (qs: string) => {
    const req = await authReq("me", `http://t/api/admin/conversations${qs}`);
    return (await listRoute.GET(req as any)).json();
  };
  const listRows = (body: any): string[] =>
    (Array.isArray(body) ? body : body.rows).map((r: any) => r.id).sort();
  const metaOps = (q: any) => q.coll === "status_conversation";
  const WRITE_OPS = new Set(["updateOne", "updateMany", "findOneAndUpdate", "insertOne", "deleteOne", "deleteMany", "replaceOne"]);

  await test("L1 source pin: list route ไม่มี write call (no lifecycle in GET)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new URL("../src/app/api/admin/conversations/route.ts", import.meta.url)),
      "utf8",
    );
    const writeCalls = src.match(/\bupdateStatus\(|\bupdateOne\(|\bupdateMany\(|\bfindOneAndUpdate\(|\binsertOne\(|\bdeleteMany\(|\bdeleteOne\(|\.update\(|\.save\(/g) || [];
    assert(writeCalls.length === 0,
      `list route must have zero write calls, found: ${[...new Set(writeCalls)].join(",")}`);
    assert(!/statusConversationService\./.test(src),
      "list route must not call statusConversationService (read path uses join)");
  });

  await test("L2 closed+inbound ใหม่ → list อ่าน meta ตรงๆ (closed ค้าง — lifecycle owner missing)", async () => {
    seedAdmin("me");
    seedConv("h1", { last_message_timestamp: new Date("2026-10-10") });
    seedMeta("h1", { status: "closed", assigned_to: "admin-1", closed_at: new Date("2026-10-01") });
    listRoute.invalidateConversationsCache();
    const body = await listGetRaw("?status=closed&include_count=true");
    assert(listRows(body).includes("h1") && body.total_count === 1,
      `closed conv must stay visible as closed (meta truth), got ${JSON.stringify(listRows(body))} total=${body.total_count}`);
    const m = metaOf("h1")!;
    assert(m.status === "closed" && m.assigned_to === "admin-1",
      `GET must not rewrite meta (read-only), got ${JSON.stringify({ s: m.status, a: m.assigned_to })}`);
  });

  await test("L3 GET×2 → zero writes + zero status_conversation queries", async () => {
    seedAdmin("me");
    seedConv("h4", { last_message_timestamp: new Date("2026-10-10") });
    seedMeta("h4", { status: "closed", closed_at: new Date("2026-10-01") });
    listRoute.invalidateConversationsCache();
    mocks.state.queryLog.length = 0;
    await listGetRaw("?status=bot");
    listRoute.invalidateConversationsCache();
    await listGetRaw("?status=closed");
    const writes = mocks.state.queryLog.filter((q: any) => WRITE_OPS.has(q.op));
    assert(writes.length === 0,
      `GET must produce zero writes, got ${JSON.stringify(writes.map((q: any) => `${q.coll}.${q.op}`))}`);
    // meta-first aggregate = indexed read path — ห้ามเฉพาะ find/findOne/count census
    const metaQ = mocks.state.queryLog.filter((q: any) => metaOps(q) && q.op !== "aggregate");
    assert(metaQ.length === 0,
      `GET must not census status_conversation (meta-bound filters use indexed aggregate), got ${JSON.stringify(metaQ.map((q: any) => q.op))}`);
  });

  await test("L4 cache hit → zero DB queries (ไม่ถาม lifecycle candidates)", async () => {
    seedAdmin("me");
    seedConv("h5", { last_message_timestamp: new Date("2026-09-01") });
    seedMeta("h5", { status: "closed", closed_at: new Date("2026-10-01") });
    listRoute.invalidateConversationsCache();
    await listGetRaw("?status=closed"); // warm cache
    mocks.state.queryLog.length = 0;
    const body = await listGetRaw("?status=closed"); // hit (TTL 5s)
    assert(listRows(body).includes("h5"), "cache hit must return closed row");
    const dataQ = mocks.state.queryLog.filter((q: any) =>
      q.coll === "conversations" || q.coll === "status_conversation" || q.coll === "messages");
    assert(dataQ.length === 0,
      `cache hit must not query data collections, got ${JSON.stringify(dataQ.map((q: any) => `${q.coll}.${q.op}`))}`);
  });

  // ═══ J. stats endpoints — exhaustive partition + bounded queries ═══
  //   canonical partition (ทุก endpoint เห็นเหมือนกัน):
  //     active_assigned     = meta {handoff,open,pending} + owner
  //     awaiting_assignment = meta {handoff,open,pending} + ไม่มี owner  ← open+no-owner อยู่ตรงนี้
  //     closed              = meta {closed,resolved} (owner ค้าง = history)
  //     bot                 = missing meta | no status | status=bot

  await test("J1 team: open+no-owner meta → awaiting_assignment (ไม่ใช่ bot)", async () => {
    seedAdmin("me"); seedAdmin("admin-1");
    seedConv("j1a"); seedMeta("j1a", { status: "open", assigned_to: null });
    seedConv("j1b");
    const req = await authReq("me", "http://t/api/team");
    const body = await (await teamRoute.GET(req as any)).json();
    assert(body.unassigned_handoff === 1,
      `open+no-owner must be awaiting=1, got ${body.unassigned_handoff}`);
    assert(body.unassigned_open === 1,
      `bot must be only missing-meta conv = 1, got ${body.unassigned_open}`);
    assert(body.unassigned === 2, `awaiting+bot=2, got ${body.unassigned}`);
  });

  await test("J2 stats/live: open_unassigned = awaiting เท่านั้น (ไม่รวม bot)", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    seedConv("j2a"); seedMeta("j2a", { status: "open", assigned_to: null });
    seedConv("j2b");
    const req = await authReq("me", "http://t/api/stats/live?range=all");
    const body = await (await statsLiveRoute.GET(req as any)).json();
    assert(body.open_unassigned === 1,
      `open_unassigned must be awaiting=1 not bot+awaiting=2, got ${body.open_unassigned}`);
    const bd = Object.fromEntries(body.breakdown_by_status.map((s: any) => [s.status, s.count]));
    assert(bd.open === 1 && bd.bot_answered === 1,
      `open(awaiting)=1 bot=1, got ${JSON.stringify(bd)}`);
  });

  await test("J3 query shape: stats endpoints — ไม่มี statusColl.find({}) / conv id arrays / unbounded find", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    seedMetricSet("q");
    const routes: [string, () => Promise<any>][] = [
      ["performance", async () => statsPerfRoute.GET(await authReq("me", "http://t/api/stats/performance?range=all") as any)],
      ["admin-activity", async () => statsAdminActivityRoute.GET(await authReq("me", "http://t/api/stats/admin-activity?range=all") as any)],
      ["live", async () => statsLiveRoute.GET(await authReq("me", "http://t/api/stats/live?range=all") as any)],
      ["dashboard", async () => statsDashboardRoute.GET(await authReq("me", "http://t/api/stats/dashboard?range=all") as any)],
      ["team", async () => teamRoute.GET(await authReq("me", "http://t/api/team") as any)],
    ];
    const bad: string[] = [];
    for (const [name, call] of routes) {
      mocks.state.queryLog.length = 0;
      await call();
      const metaFullScan = mocks.state.queryLog.some(
        (q: any) => q.coll === "status_conversation" && q.op === "find" &&
          Object.keys(q.filter || {}).length === 0);
      const convUnboundedFind = mocks.state.queryLog.some(
        (q: any) => q.coll === "conversations" && q.op === "find" &&
          Object.keys(q.filter || {}).length === 0);
      const convIdArrays = mocks.state.queryLog.filter(
        (q: any) => q.coll === "conversations" &&
          (Array.isArray(q.filter?.conversation_id?.$in) || Array.isArray(q.filter?.conversation_id?.$nin)));
      if (metaFullScan || convUnboundedFind || convIdArrays.length > 0) {
        bad.push(`${name}(metaScan=${metaFullScan},convScan=${convUnboundedFind},idArrays=${convIdArrays.length})`);
      }
    }
    assert(bad.length === 0, `unbounded queries: ${bad.join(", ")}`);
  });

  await test("J4 partition matrix ครบ status×owner — team/live/dashboard สอดคล้องกัน", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    seedConv("m-ho"); seedMeta("m-ho", { status: "handoff", assigned_to: "admin-1" });
    seedConv("m-hx"); seedMeta("m-hx", { status: "handoff" });
    seedConv("m-oo"); seedMeta("m-oo", { status: "open", assigned_to: "admin-1" });
    seedConv("m-ox"); seedMeta("m-ox", { status: "open", assigned_to: null });
    seedConv("m-po"); seedMeta("m-po", { status: "pending", assigned_to: "admin-1" });
    seedConv("m-px"); seedMeta("m-px", { status: "pending" });
    seedConv("m-co"); seedMeta("m-co", { status: "closed", assigned_to: "admin-1", closed_at: new Date("2099-01-01") });
    seedConv("m-cx"); seedMeta("m-cx", { status: "closed", closed_at: new Date("2099-01-01") });
    seedConv("m-ro"); seedMeta("m-ro", { status: "resolved", assigned_to: "admin-1" });
    seedConv("m-bm");
    seedConv("m-bt"); seedMeta("m-bt", { status: "bot" });
    seedConv("m-bn"); seedMeta("m-bn", { topic: "refund" });
    // active=3 (ho,oo,po) · awaiting=3 (hx,ox,px) · closed=3 (co,cx,ro) · bot=3 (bm,bt,bn)
    const team = await (await teamRoute.GET(await authReq("me", "http://t/api/team") as any)).json();
    assert(team.total_open_conversations === 3, `team active=3, got ${team.total_open_conversations}`);
    assert(team.unassigned_handoff === 3, `team awaiting=3 (incl open+no-owner), got ${team.unassigned_handoff}`);
    assert(team.unassigned_open === 3, `team bot=3, got ${team.unassigned_open}`);
    const live = await (await statsLiveRoute.GET(await authReq("me", "http://t/api/stats/live?range=all") as any)).json();
    assert(live.open_assigned === 3, `live active=3, got ${live.open_assigned}`);
    assert(live.open_unassigned === 3, `live awaiting=3, got ${live.open_unassigned}`);
    assert(live.closed_total === 3, `live closed=3, got ${live.closed_total}`);
    const bd = Object.fromEntries(live.breakdown_by_status.map((s: any) => [s.status, s.count]));
    assert(bd.bot_answered === 3 && bd.open === 6 && bd.closed === 3,
      `live breakdown bot=3 open=6 closed=3, got ${JSON.stringify(bd)}`);
    const dash = await (await statsDashboardRoute.GET(await authReq("me", "http://t/api/stats/dashboard?range=all") as any)).json();
    assert(dash.with_admin === 6 && dash.closed === 3 && dash.bot_answered === 3,
      `dashboard with_admin=6 closed=3 bot=3, got ${JSON.stringify({ w: dash.with_admin, c: dash.closed, b: dash.bot_answered })}`);
  });

  await test("J5 admin-activity: closed+retained owner = history, open±owner นับ unanswered", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    seedConv("j5a", { created_at: new Date() }); seedMeta("j5a", { status: "closed", assigned_to: "admin-1", closed_at: new Date() });
    seedConv("j5b", { created_at: new Date() }); seedMeta("j5b", { status: "open", assigned_to: null });
    seedConv("j5c", { created_at: new Date() }); seedMeta("j5c", { status: "open", assigned_to: "admin-1" });
    const body = await (await statsAdminActivityRoute.GET(await authReq("me", "http://t/api/stats/admin-activity?range=all") as any)).json();
    const row = body.individual_performance.find((r: any) => r.admin_id === "admin-1");
    assert(row, "admin-1 row must exist");
    assert(row.conversations === 2, `handled = closed-owner + open-owner = 2, got ${row.conversations}`);
    assert(row.unanswered_12h === 1, `open+owner counts unanswered=1, got ${row.unanswered_12h}`);
    assert(row.response_rate_12h === 50, `resolved 1/2 = 50, got ${row.response_rate_12h}`);
    assert(body.overall.closed === 1 && body.overall.open === 2,
      `overall closed=1 open=2, got ${JSON.stringify(body.overall)}`);
  });

  await test("J6 date-filter parity: range ใช้กับ meta join เหมือน inventory", async () => {
    seedAdmin("me", { role: "dev" }); seedAdmin("admin-1");
    // created_at ต้องอยู่ก่อน route's end=now อย่างน้อย 1ms — seed ด้วย new Date()
    // เดี่ยวๆ เสี่ยงชน ms เดียวกับ weekEnd (exclusive $lt) แล้ว flake
    const j6now = new Date(Date.now() - 5000);
    seedConv("j6in", { created_at: j6now }); seedMeta("j6in", { status: "closed", assigned_to: "admin-1", closed_at: j6now });
    seedConv("j6out", { created_at: new Date("2020-01-01") }); seedMeta("j6out", { status: "closed", assigned_to: "admin-1", closed_at: new Date("2020-06-01") });
    const body = await (await statsAdminActivityRoute.GET(await authReq("me", "http://t/api/stats/admin-activity?range=daily") as any)).json();
    const row = body.individual_performance.find((r: any) => r.admin_id === "admin-1");
    assert(row?.conversations === 1,
      `range=daily must count only in-range conv, got ${row?.conversations}`);
    assert(body.overall.total_conversations === 1,
      `overall in-range total must be 1, got ${body.overall.total_conversations}`);
  });

  // ═══ M. list query shape — DB-side status/assigned filter (Phase 2B.1 closure) ═══
  //   ห้ามโหลด conversation_ids จาก status_conversation มาทำ $in/$nin
  //   status/assigned predicate ต้องอยู่ใน pipeline เดียวกับ rows/count

  const qlogHasIdArray = () =>
    mocks.state.queryLog.some((q: any) => {
      // census pattern = conversation_id $in/$nin arrays on the conversations coll
      // (page-scoped $in on messages is bounded by page limit — allowed)
      if (q.coll !== "conversations") return false;
      const blob = JSON.stringify(q.filter || {});
      return /"conversation_id"\s*:\s*\{\s*"?\$(in|nin)"?\s*:\s*\[/.test(blob);
    });

  await test("M1 status/assigned filter → meta-driven pipeline, ไม่มี census/ID array", async () => {
    seedAdmin("me");
    seedConv("m1a"); seedMeta("m1a", { status: "handoff", assigned_to: "admin-1" });
    seedConv("m1b"); seedMeta("m1b", { status: "handoff", assigned_to: "admin-2" });
    mocks.state.queryLog.length = 0;
    const body = await listGetRaw("?status=handoff&assigned_to=admin-1&include_count=true");
    assert(listRows(body).join() === "m1a",
      `intersect must return m1a only, got ${JSON.stringify(listRows(body))}`);
    assert(body.total_count === 1, `count must match rows, got ${body.total_count}`);
    assert(!qlogHasIdArray(),
      `no conversation_id $in/$nin arrays allowed, log=${JSON.stringify(mocks.state.queryLog.map((q: any) => q.filter))}`);
    // meta ปรากฏได้เฉพาะในรูปแบบ aggregate (join ใน pipeline) — ห้าม find().toArray() census
    const metaCensus = mocks.state.queryLog.some(
      (q: any) => q.coll === "status_conversation" && q.op !== "aggregate");
    assert(!metaCensus,
      `no status_conversation find/scan allowed, log=${JSON.stringify(mocks.state.queryLog.map((q: any) => [q.coll, q.op]))}`);
  });

  await test("M2 3-page cursor parity — filter ก่อน sort/limit ทุก page", async () => {
    seedAdmin("me");
    const names = ["m2a", "m2b", "m2c", "m2d", "m2e", "m2f"];
    names.forEach((id, i) =>
      seedConv(id, { last_message_timestamp: new Date(`2026-10-0${i + 1}`) }));
    seedConv("m2x", { last_message_timestamp: new Date("2026-10-07") }); // newest — handoff (excluded)
    seedMeta("m2x", { status: "handoff", assigned_to: "admin-1" });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const qs = `?status=bot&limit=2&include_count=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await listGetRaw(qs);
      assert(body.total_count === 6,
        `total_count must stay 6 across pages, got ${body.total_count} on page ${page + 1}`);
      seen.push(...body.rows.map((r: any) => r.id));
      cursor = body.cursor;
      if (page < 2) assert(body.has_more === true, `page ${page + 1} must have more`);
    }
    assert(seen.join() === [...names].reverse().join(),
      `3 pages must yield 6 distinct bot convs newest-first, got ${seen.join()}`);
  });

  await test("M3 unassigned + bot compound filter → meta predicates ทำงานใน pipeline เดียว", async () => {
    seedAdmin("me");
    seedConv("m3a");                                              // no meta → bot+unassigned
    seedConv("m3b"); seedMeta("m3b", { status: "bot" });           // bot+unassigned
    seedConv("m3c"); seedMeta("m3c", { status: "handoff" });       // awaiting (no owner)
    seedConv("m3d"); seedMeta("m3d", { status: "open", assigned_to: "admin-1" });
    const botRows = listRows(await listGetRaw("?status=bot"));
    assert(botRows.join() === "m3a,m3b", `status=bot → missing+explicit bot only, got ${botRows.join()}`);
    const unRows = listRows(await listGetRaw("?assigned_to=unassigned"));
    assert(unRows.join() === "m3a,m3b,m3c",
      `unassigned = no owner regardless of status, got ${unRows.join()}`);
    const both = listRows(await listGetRaw("?status=bot&assigned_to=unassigned"));
    assert(both.join() === "m3a,m3b", `bot∩unassigned, got ${both.join()}`);
  });

  // ═══ N. channel authorization ก่อน pagination (Review Correction) ═══
  //   channels_access ต้อง fold เข้า baseMatch — filter ใน JS หลัง $limit ทำ page/starve/count ผิด

  await test("N1 channels_access=[shopee] + lazada ดอกหน้า → ยังได้ shopee ครบ limit", async () => {
    seedAdmin("me", { channels_access: ["shopee"] });
    for (let i = 0; i < 5; i++)
      seedConv(`n1-laz-${i}`, { platform: "lazada", last_message_timestamp: new Date(`2026-10-0${9 - i}`) });
    ["n1-shp-a", "n1-shp-b", "n1-shp-c"].forEach((id, i) =>
      seedConv(id, { platform: "shopee", last_message_timestamp: new Date(`2026-10-0${3 - i}`) }));
    listRoute.invalidateConversationsCache();
    const body = await listGetRaw("?limit=3&include_count=true");
    assert(body.rows.length === 3 && body.rows.every((r: any) => r.platform === "shopee"),
      `limit=3 must fill with shopee rows, got ${JSON.stringify(body.rows.map((r: any) => r.id))}`);
    assert(body.rows.map((r: any) => r.id).join() === "n1-shp-a,n1-shp-b,n1-shp-c",
      `newest-first shopee only, got ${body.rows.map((r: any) => r.id).join()}`);
  });

  await test("N2 total_count นับเฉพาะ channel ที่มีสิทธิ์", async () => {
    seedAdmin("me", { channels_access: ["shopee"] });
    for (let i = 0; i < 5; i++) seedConv(`n2-laz-${i}`, { platform: "lazada" });
    for (let i = 0; i < 3; i++) seedConv(`n2-shp-${i}`, { platform: "shopee" });
    listRoute.invalidateConversationsCache();
    const body = await listGetRaw("?include_count=true&limit=50");
    assert(body.total_count === 3,
      `total_count must be authorized-only (3 shopee), got ${body.total_count}`);
  });

  await test("N3 cursor/has_more อิง authorized population เท่านั้น", async () => {
    seedAdmin("me", { channels_access: ["shopee"] });
    ["n3-shp-1", "n3-shp-2", "n3-shp-3", "n3-shp-4"].forEach((id, i) =>
      seedConv(id, { platform: "shopee", last_message_timestamp: new Date(`2026-10-0${9 - i}`) }));
    seedConv("n3-laz-newest", { platform: "lazada", last_message_timestamp: new Date("2026-10-10") });
    seedConv("n3-laz-mid", { platform: "lazada", last_message_timestamp: new Date("2026-10-08") });
    const p1 = await listGetRaw("?limit=2&include_count=true");
    assert(p1.rows.map((r: any) => r.id).join() === "n3-shp-1,n3-shp-2",
      `page1 = 2 newest shopee (lazada แซงเวลาแต่ไม่มีสิทธิ์), got ${p1.rows.map((r: any) => r.id).join()}`);
    assert(p1.has_more === true && p1.total_count === 4,
      `has_more+count on authorized pop, got has_more=${p1.has_more} count=${p1.total_count}`);
    const p2 = await listGetRaw(`?limit=2&include_count=true&cursor=${encodeURIComponent(p1.cursor)}`);
    assert(p2.rows.map((r: any) => r.id).join() === "n3-shp-3,n3-shp-4",
      `page2 via cursor continues authorized pop, got ${p2.rows.map((r: any) => r.id).join()}`);
    assert(p2.has_more === false, `no more authorized rows after page2`);
  });

  await test("N4 superadmin/dev — channels_access ไม่จำกัด (contract เดิม)", async () => {
    seedAdmin("boss", { role: "superadmin", channels_access: ["shopee"] });
    seedConv("n4-laz", { platform: "lazada" });
    seedConv("n4-shp", { platform: "shopee" });
    listRoute.invalidateConversationsCache();
    const req = await authReq("boss", "http://t/api/admin/conversations?limit=50");
    const rows = (await (await listRoute.GET(req as any)).json()) as any[];
    assert(rows.length === 2, `superadmin sees all channels, got ${rows.map((r: any) => r.id).join()}`);
  });

  await test("N5 channels_access=[] → เห็นทุก channel (backward compat)", async () => {
    seedAdmin("me", { channels_access: [] });
    seedConv("n5-laz", { platform: "lazada" });
    seedConv("n5-shp", { platform: "shopee" });
    listRoute.invalidateConversationsCache();
    const body = await listGetRaw("?limit=50&include_count=true");
    assert(body.total_count === 2 && body.rows.length === 2,
      `empty channels_access = unrestricted, got ${body.total_count}`);
  });

  // ═══ O. query scalability — meta-bound filter ต้องเริ่มจาก status_conversation ═══
  //   (human status/assigned → indexed meta $match → $lookup conv; ห้าม conv-first full join)

  const metaFirstAggs = () =>
    mocks.state.queryLog.filter((q: any) =>
      q.coll === "status_conversation" && q.op === "aggregate" &&
      JSON.stringify(q.filter).includes('"$lookup"'));
  const convFirstMetaJoin = () =>
    mocks.state.queryLog.some((q: any) => {
      if (q.coll !== "conversations" || q.op !== "aggregate") return false;
      const pipe = Array.isArray(q.filter) ? q.filter : [];
      // conv-first + meta join = $lookup ก่อน sort/limit (full join)
      const idxLookup = pipe.findIndex((s: any) => s.$lookup);
      const idxLimit = pipe.findIndex((s: any) => s.$limit);
      return idxLookup >= 0 && (idxLimit === -1 || idxLookup < idxLimit);
    });

  await test("O1 assigned_to=<id> → meta-first aggregate (ไม่ conv-first full join)", async () => {
    seedAdmin("me");
    seedConv("o1a"); seedMeta("o1a", { status: "handoff", assigned_to: "admin-1" });
    seedConv("o1b"); seedMeta("o1b", { status: "handoff", assigned_to: "admin-2" });
    seedConv("o1c"); // bot — ไม่มี meta
    mocks.state.queryLog.length = 0;
    const body = await listGetRaw("?assigned_to=admin-1&include_count=true&limit=10");
    assert(listRows(body).join() === "o1a" && body.total_count === 1,
      `assigned_to=admin-1 → o1a only, got ${JSON.stringify(listRows(body))}/${body.total_count}`);
    assert(metaFirstAggs().length > 0,
      `must aggregate from status_conversation (meta-first), log=${JSON.stringify(mocks.state.queryLog.map((q: any) => [q.coll, q.op]))}`);
    assert(!convFirstMetaJoin(),
      `no conv-first meta $lookup before limit, log=${JSON.stringify(mocks.state.queryLog.map((q: any) => q.filter))}`);
    assert(!qlogHasIdArray(), "no $in/$nin arrays");
  });

  await test("O2 human status (handoff) → meta-first aggregate", async () => {
    seedAdmin("me");
    seedConv("o2a"); seedMeta("o2a", { status: "handoff", assigned_to: "admin-1" });
    seedConv("o2b"); seedMeta("o2b", { status: "closed", assigned_to: "admin-1" });
    seedConv("o2c"); // bot
    mocks.state.queryLog.length = 0;
    const body = await listGetRaw("?status=handoff&include_count=true&limit=10");
    assert(listRows(body).join() === "o2a" && body.total_count === 1,
      `status=handoff → o2a only, got ${JSON.stringify(listRows(body))}/${body.total_count}`);
    assert(metaFirstAggs().length > 0, `status filter must start from status_conversation`);
    assert(!convFirstMetaJoin(), `no conv-first meta join before limit`);
  });

  await test("O3 default (no meta filter) → conv-first, meta join หลัง limit (page-scoped)", async () => {
    seedAdmin("me");
    seedConv("o3a"); seedConv("o3b"); seedConv("o3c");
    mocks.state.queryLog.length = 0;
    const body = await listGetRaw("?limit=2");
    assert(listRows(body).length === 2, `default page, got ${JSON.stringify(listRows(body))}`);
    // meta join ต้องอยู่หลัง $limit — page-scoped (ไม่ join ทั้ง collection)
    const convAgg = mocks.state.queryLog.find((q: any) => q.coll === "conversations" && q.op === "aggregate");
    const pipe = convAgg ? (convAgg.filter as any[]) : [];
    const idxLookup = pipe.findIndex((s: any) => s.$lookup);
    const idxLimit = pipe.findIndex((s: any) => s.$limit);
    assert(idxLimit >= 0 && idxLookup > idxLimit,
      `default path must join meta AFTER limit (page-scoped), pipe=${JSON.stringify(pipe)}`);
  });

  await test("O4 status=bot → conv-first anti-join (missing-meta ทำ meta-first ไม่ได้)", async () => {
    // residual: bounded bot query ต้องการ complete meta ที่ ingress — ผูกกับ
    // BLOCKED_BY_EXTERNAL_INBOUND_WRITER (Part 1) — pin ว่า bot filter ใช้ conv-first
    seedAdmin("me");
    seedConv("o4a"); // no meta → bot
    seedConv("o4b"); seedMeta("o4b", { status: "handoff" });
    mocks.state.queryLog.length = 0;
    const body = await listGetRaw("?status=bot&include_count=true&limit=10");
    assert(listRows(body).join() === "o4a" && body.total_count === 1,
      `status=bot → missing-meta only, got ${JSON.stringify(listRows(body))}`);
    assert(convFirstMetaJoin(),
      `status=bot (missing-meta admission) requires conv-first anti-join — pin shape`);
  });

  await test("O5 compound bot+assigned → meta-bound → meta-first (assigned บังคับ meta มี)", async () => {
    seedAdmin("me");
    seedConv("o5a"); seedMeta("o5a", { status: "bot", assigned_to: "admin-1" });
    seedConv("o5b"); seedMeta("o5b", { status: "handoff", assigned_to: "admin-1" });
    seedConv("o5c"); // no meta
    mocks.state.queryLog.length = 0;
    const body = await listGetRaw("?status=bot&assigned_to=admin-1&include_count=true&limit=10");
    assert(listRows(body).join() === "o5a" && body.total_count === 1,
      `bot∩assigned → o5a only, got ${JSON.stringify(listRows(body))}`);
    assert(metaFirstAggs().length > 0, `assigned predicate makes query meta-bound → meta-first`);
    assert(!convFirstMetaJoin(), `no conv-first join for meta-bound compound`);
  });

  await test("O6 status+channel+cursor parity บน meta-first (filter ก่อน sort/limit)", async () => {
    seedAdmin("me", { channels_access: ["shopee"] });
    ["o6a", "o6b", "o6c"].forEach((id, i) => {
      seedConv(id, { platform: "shopee", last_message_timestamp: new Date(`2026-10-0${3 - i}`) });
      seedMeta(id, { status: "handoff", assigned_to: "admin-1" });
    });
    seedConv("o6-laz", { platform: "lazada", last_message_timestamp: new Date("2026-10-05") });
    seedMeta("o6-laz", { status: "handoff", assigned_to: "admin-1" });
    const p1 = await listGetRaw("?status=handoff&limit=2&include_count=true");
    assert(p1.rows.map((r: any) => r.id).join() === "o6a,o6b" && p1.total_count === 3,
      `meta-first honors channel+sort+limit, got ${p1.rows.map((r: any) => r.id).join()}/${p1.total_count}`);
    const p2 = await listGetRaw(`?status=handoff&limit=2&include_count=true&cursor=${encodeURIComponent(p1.cursor)}`);
    assert(p2.rows.map((r: any) => r.id).join() === "o6c" && p2.has_more === false,
      `cursor continues meta-first page, got ${p2.rows.map((r: any) => r.id).join()}`);
  });

  // ═══ T. response attribution — approved contract (Option B: 24h grace) ═══
  //   grace window = [end, end+24h) — post-end events ใน window resolve open turn
  //   events ที่/หลัง graceEnd ไม่เปลี่ยน historical period (report freeze)
  //   policy constants owner = responseStats.ts (ไม่ใช่ env/flag)
  //   equal-ts user+reply → user ชนะ; probe = bounded [end,graceEnd) + batched $in

  const GRACE_MS = responseStatsLib.RESPONSE_ATTRIBUTION_GRACE_MS;
  const BATCH = responseStatsLib.RESPONSE_PROBE_BATCH_SIZE;

  const T_START = new Date("2026-10-01T00:00:00Z");
  const T_END = new Date("2026-10-02T00:00:00Z");
  const GRACE_END = new Date(T_END.getTime() + GRACE_MS);
  const tStats = async (extra: Record<string, unknown> = {}) =>
    responseStatsLib.computeResponseStats(await msgCollFor(), { start: T_START, end: T_END, ...extra } as any);
  const probeAggs = () =>
    mocks.state.queryLog.filter((q: any) =>
      q.coll === "messages" && q.op === "aggregate" &&
      Array.isArray(q.filter) && q.filter.some((s: any) => s.$match?.conversation_id?.$in));

  await test("T1 reply ข้าม end แต่ใน grace (end+2min) → answered, latency จาก user ล่าสุด", async () => {
    assert(GRACE_MS === 86_400_000, `grace must be exactly 24h (owner=responseStats.ts), got ${GRACE_MS}`);
    assert(typeof BATCH === "number" && BATCH > 0 && Number.isInteger(BATCH),
      `probe batch must be a positive exported constant, got ${BATCH}`);
    seedMsg("t1", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t1", { created_timestamp: new Date(T_END.getTime() - 30_000) }); // last user
    seedMsg("t1", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(T_END.getTime() + 120_000) });
    const s = await tStats();
    assert(s.totalTurns === 1 && s.answeredTurns === 1 && s.avgResponseSeconds === 150,
      `in-grace reply closes turn w/ latency from last user (150s), got ${JSON.stringify({ t: s.totalTurns, a: s.answeredTurns, avg: s.avgResponseSeconds })}`);
  });

  await test("T2 reply ที่ graceEnd-1ms → answered (ขอบล่างของ window)", async () => {
    seedMsg("t2", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t2", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(GRACE_END.getTime() - 1) });
    const s = await tStats();
    assert(s.answeredTurns === 1, `reply at graceEnd-1ms must close turn, got answered=${s.answeredTurns}`);
  });

  await test("T3 reply ตรง graceEnd → ไม่แก้ผล (old turn unanswered)", async () => {
    seedMsg("t3", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t3", { role: "admin", direction: "out", actor: "a1", created_timestamp: GRACE_END });
    const s = await tStats();
    assert(s.totalTurns === 1 && s.answeredTurns === 0,
      `reply at graceEnd excluded — window is [end, graceEnd), got ${JSON.stringify({ t: s.totalTurns, a: s.answeredTurns })}`);
  });

  await test("T4 reply หลัง grace (graceEnd+1ms) → old turn unanswered", async () => {
    seedMsg("t4", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t4", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(GRACE_END.getTime() + 1) });
    const s = await tStats();
    assert(s.totalTurns === 1 && s.answeredTurns === 0,
      `post-grace reply must not change period, got ${JSON.stringify({ t: s.totalTurns, a: s.answeredTurns })}`);
  });

  await test("T5 user ใหม่ใน grace ก่อน reply → original turn ย้าย period", async () => {
    seedMsg("t5", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t5", { created_timestamp: new Date(T_END.getTime() + 3_600_000) });           // user @end+1h
    seedMsg("t5", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(T_END.getTime() + 7_200_000) }); // reply @end+2h
    const p1 = await tStats();
    assert(p1.totalTurns === 0, `in-grace user extends run → turn leaves this period, got ${p1.totalTurns}`);
    // merged turn นับใน period ที่ครอบ turn_ts ใหม่
    const wide = await responseStatsLib.computeResponseStats(await msgCollFor(),
      { start: T_START, end: GRACE_END, adminOnly: true } as any);
    assert(wide.totalTurns === 1 && wide.answeredTurns === 1 && wide.avgResponseSeconds === 3600,
      `later period counts moved turn once (avg=1h), got ${JSON.stringify({ t: wide.totalTurns, a: wide.answeredTurns, avg: wide.avgResponseSeconds })}`);
  });

  await test("T6 user ใหม่หลัง grace → old turn freeze unanswered (post-grace events ignored)", async () => {
    seedMsg("t6", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t6", { created_timestamp: new Date(GRACE_END.getTime() + 3_600_000) });        // user post-grace
    seedMsg("t6", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(GRACE_END.getTime() + 7_200_000) }); // reply post-grace
    const s = await tStats();
    assert(s.totalTurns === 1 && s.answeredTurns === 0,
      `post-grace user+reply must not move/close old turn — frozen unanswered, got ${JSON.stringify({ t: s.totalTurns, a: s.answeredTurns })}`);
  });

  await test("T7 equal-ts post-end user+reply → user ชนะ → turn ย้าย period", async () => {
    const tie = new Date(T_END.getTime() + 3_600_000);
    seedMsg("t7", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t7", { created_timestamp: tie });                                              // user @ tie
    seedMsg("t7", { role: "admin", direction: "out", actor: "a1", created_timestamp: tie }); // reply @ tie
    const s = await tStats();
    assert(s.totalTurns === 0,
      `equal-ts: user wins → run extends → turn leaves period (total=0), got ${s.totalTurns}`);
  });

  await test("T8 adminOnly: bot reply ใน grace ไม่ปิด; admin reply ปิดได้ (ไม่มี user ก่อน)", async () => {
    seedMsg("t8a", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t8a", { role: "bot", direction: "out", created_timestamp: new Date(T_END.getTime() + 3_600_000) });
    seedMsg("t8b", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t8b", { role: "bot", direction: "out", created_timestamp: new Date(T_END.getTime() + 3_600_000) });
    seedMsg("t8b", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(T_END.getTime() + 7_200_000) });
    const s = await tStats({ adminOnly: true });
    assert(s.totalTurns === 2 && s.answeredTurns === 1 && s.avgResponseSeconds === 7260,
      `bot-only conv stays unanswered; admin reply @+2h1m closes t8b (avg=7260s), got ${JSON.stringify({ t: s.totalTurns, a: s.answeredTurns, avg: s.avgResponseSeconds })}`);
  });

  await test("T9 report freeze — events หลัง grace ไม่เปลี่ยน result (byte-equivalent counters)", async () => {
    seedMsg("t9a", { created_timestamp: new Date(T_END.getTime() - 60_000) });               // stays unanswered
    seedMsg("t9b", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    seedMsg("t9b", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(T_END.getTime() + 120_000) }); // in-grace reply
    const snap = (s: any) => JSON.stringify({
      t: s.totalTurns, a: s.answeredTurns, w: s.within10minTurns,
      avg: s.avgResponseSeconds, p: Object.fromEntries(s.perAdmin),
    });
    const before = snap(await tStats());
    // observation หลัง grace + events post-grace มาถึงทีหลัง → period เดิมต้องไม่เปลี่ยน
    seedMsg("t9a", { created_timestamp: new Date(GRACE_END.getTime() + 86_400_000) });
    seedMsg("t9a", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(GRACE_END.getTime() + 86_460_000) });
    seedMsg("t9b", { role: "admin", direction: "out", actor: "a2", created_timestamp: new Date(GRACE_END.getTime() + 60_000) });
    const after = snap(await tStats());
    assert(before === after,
      `post-grace events must not change frozen period, before=${before} after=${after}`);
  });

  await test("T10 ทุก post-end query bounded [end, graceEnd) — ไม่มี [end,∞) scan", async () => {
    seedMsg("t10", { created_timestamp: new Date(T_END.getTime() - 60_000) });
    mocks.state.queryLog.length = 0;
    await tStats();
    const probes = probeAggs();
    assert(probes.length > 0, "open turn must trigger post-end probe queries");
    for (const q of probes) {
      const c = q.filter.find((s: any) => s.$match?.created_timestamp)?.$match?.created_timestamp;
      assert(c && c.$gte?.getTime() === T_END.getTime() && c.$lt?.getTime() === GRACE_END.getTime(),
        `probe must be [end, end+24h) bounded, got ${JSON.stringify(c)}`);
    }
    // initial fetch ก็ต้อง bounded [start,end) ด้วย
    const finds = mocks.state.queryLog.filter((q: any) => q.coll === "messages" && q.op === "find");
    assert(finds.every((q: any) => {
      const c = (q.filter as any)?.created_timestamp;
      return c && c.$gte?.getTime() === T_START.getTime() && c.$lt?.getTime() === T_END.getTime();
    }), `initial fetch must stay [start,end), got ${JSON.stringify(finds.map((q: any) => q.filter))}`);
  });

  await test("T11 open runs เกิน 1 batch → batched $in, query count = batches ไม่ใช่ N+1", async () => {
    const N_OPEN = BATCH + 1;
    for (let i = 0; i < N_OPEN; i++)
      seedMsg(`t11-${i}`, { created_timestamp: new Date(T_END.getTime() - 60_000) });
    mocks.state.queryLog.length = 0;
    const s = await tStats();
    assert(s.totalTurns === N_OPEN, `all open turns counted, got ${s.totalTurns}`);
    const probes = probeAggs();
    assert(probes.length === 4, `expected 2 probes × 2 batches, got ${probes.length} queries`);
    for (const q of probes) {
      const inArr = q.filter.find((s: any) => s.$match?.conversation_id?.$in).$match.conversation_id.$in;
      assert(inArr.length <= BATCH && inArr.length >= 1,
        `each probe $in must be ≤ batch size (${BATCH}), got ${inArr.length}`);
    }
  });

  await test("T12 ไม่มี open run → zero post-end queries", async () => {
    seedMsg("t12", { created_timestamp: new Date(T_END.getTime() - 120_000) });
    seedMsg("t12", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date(T_END.getTime() - 60_000) }); // closed in-range
    mocks.state.queryLog.length = 0;
    const s = await tStats();
    assert(s.totalTurns === 1 && s.answeredTurns === 1,
      `in-range closed turn must count, got ${JSON.stringify({ t: s.totalTurns, a: s.answeredTurns })}`);
    assert(probeAggs().length === 0,
      `no open runs → no post-end queries, got ${probeAggs().length}`);
  });

  await test("T13 end=null → ไม่มี grace probe + range=all behavior คงเดิม", async () => {
    seedMsg("t13", { created_timestamp: new Date("2026-10-01T12:00:00Z") }); // open
    seedMsg("t13b", { created_timestamp: new Date("2026-10-01T13:00:00Z") });
    seedMsg("t13b", { role: "admin", direction: "out", actor: "a1", created_timestamp: new Date("2026-10-01T13:05:00Z") });
    mocks.state.queryLog.length = 0;
    const s = await responseStatsLib.computeResponseStats(await msgCollFor(), {});
    assert(s.totalTurns === 2 && s.answeredTurns === 1,
      `endless range=all keeps current semantics, got ${JSON.stringify({ t: s.totalTurns, a: s.answeredTurns })}`);
    assert(probeAggs().length === 0,
      `no end → no grace probe queries, got ${probeAggs().length}`);
  });

  // ═══ Q. generate-all-shadow — single DB owner (Final Review Fix Part 2) ═══
  //   contract: script ใช้ getDb singleton เดียวกับ listMessages/shadowReplyService
  //   ไม่เปิด direct MongoClient ขนานกับ singleton; ปิดใน finally ทุก path

  const shadowScriptSrc = async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(
      fileURLToPath(new URL("./generate-all-shadow.ts", import.meta.url)), "utf8");
  };

  await test("Q1 script ไม่มี direct new MongoClient (ต้องใช้ shared DB owner)", async () => {
    const src = await shadowScriptSrc();
    assert(!/new MongoClient\(/.test(src),
      `direct MongoClient runs parallel to mongoClient singleton — must use getDb()`);
  });

  await test("Q2 script ใช้ DB owner เดียวกับ services (getDb จาก db/mongoClient)", async () => {
    const src = await shadowScriptSrc();
    assert(/from\s+["'][^"']*db\/mongoClient["']/.test(src) && /\bgetDb\b|\bgetCollection\b/.test(src),
      `script must import getDb/getCollection from the shared mongoClient owner`);
  });

  await test("Q3 client ปิดใน finally + close error ไม่ mask operation error", async () => {
    const src = await shadowScriptSrc();
    assert(/finally[\s\S]{0,400}client\.close\(\)/.test(src),
      `client must be closed inside a finally block`);
    // close failure ต้องถูกจับเอง (try/catch หรือ .catch) — ไม่งั้น throw ทับ op error
    const closeIdx = src.indexOf("client.close()");
    const window = src.slice(closeIdx - 400, closeIdx + 400);
    assert(/\.catch\(|catch\s*\(/.test(window),
      `close failure must be caught (not mask a pending operation error)`);
  });

  await test("Q4 operation failure → exit non-zero (main().catch)", async () => {
    const src = await shadowScriptSrc();
    assert(/main\(\)\s*\.catch[\s\S]{0,300}exit\(1\)/.test(src),
      `main().catch must exit(1) on operation failure`);
  });

  await test("Q5 early-return paths (dry-run/empty) อยู่ก่อน finally → ผ่าน cleanup", async () => {
    const src = await shadowScriptSrc();
    const mainBody = src.slice(src.indexOf("async function main("));
    const finallyIdx = mainBody.indexOf("} finally");
    const returns = [...mainBody.matchAll(/\breturn\b/g)].map((m) => m.index!);
    assert(finallyIdx > 0 && returns.every((i) => i < finallyIdx),
      `every early return in main must precede the finally block (cleanup covers all paths)`);
  });

  // ═══ W. inbound lifecycle command contract — Phase 2B.1 review-fix ═══
  // RED forward contract (review A3): production command does NOT exist yet.
  // Seam = statusConversationService.applyInboundOwnershipTransition(event)
  //   event   = { conversationId, messageId, inboundAt: Date }
  //   returns = "initialized" | "reopened" | "unchanged"
  // Same single owner (statusConversationService) — separate command boundary
  // from reopenConversation (manual admin reopen / handoffService / reopen
  // route keep calling the existing function — their semantics unchanged).
  // Every W2+ test fails today ONLY because the command is missing; behavior
  // assertions encode the approved contract for implementation review.
  type InboundOutcome = "initialized" | "reopened" | "unchanged";
  type InboundEvent = { conversationId: string; messageId: string; inboundAt: Date };
  const applyInbound = (ev: InboundEvent): Promise<InboundOutcome> => {
    const cmd = (statusSvc as unknown as Record<string, (e: InboundEvent) => Promise<InboundOutcome>>)
      .applyInboundOwnershipTransition;
    assert(typeof cmd === "function",
      "statusConversationService.applyInboundOwnershipTransition missing — RED forward contract");
    return cmd(ev);
  };
  const metaWrites = () =>
    mocks.state.queryLog.filter((q: any) => q.coll === "status_conversation"
      && (q.op === "updateOne" || q.op === "findOneAndUpdate" || q.op === "updateMany"));
  const reopenLogs = () =>
    mocks.fakeColl("admin_logs").filter((d: any) => d.action_type === "conversation.open");
  const closeHistOf = (id: string) =>
    mocks.fakeColl("close_history").filter((d: any) => d.conversation_id === id);
  const adminLogs = (id?: string) =>
    mocks.fakeColl("admin_logs").filter((d: any) => !id || d.conversation_id === id);
  const noSideEffects = () =>
    adminLogs().length === 0 && mocks.fakeColl("close_history").length === 0;

  const CT0 = new Date("2026-10-01T00:00:00Z");
  const CT1 = new Date("2026-10-05T00:00:00Z"); // newer inbound
  const ev = (id: string, at: Date = CT1): InboundEvent =>
    ({ conversationId: id, messageId: `m-${id}`, inboundAt: at });

  await test("W1 [in-repo pin] raw dump rewrite{status:open,assigned_to} → meta ไม่เปลี่ยน", async () => {
    // structural in-repo pin เท่านั้น — พิสูจน์ว่าไม่มี code path raw→meta ใน repo
    // ห้ามอ้างเป็นหลักฐาน behavior ของ external process (A4)
    seedConv("w1");
    seedMeta("w1", { status: "handoff", assigned_to: "admin-1" });
    const raw = mocks.fakeColl("conversations").find((d: any) => d.conversation_id === "w1");
    raw.status = "open"; raw.assigned_to = "ghost-from-dump"; raw.closed_at = null;
    const m = metaOf("w1");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1",
      `meta=${JSON.stringify(m)} — in-repo raw write must not touch meta`);
  });

  // ── W.service state contract (boundary: command missing) ──

  await test("W2 missing meta + first inbound → initialized{status:bot} ไม่มี reopen side-effects", async () => {
    const r = await applyInbound(ev("w2"));
    assert(r === "initialized", `expected initialized, got ${r}`);
    const m = metaOf("w2");
    assert(m?.status === "bot" && m?.assigned_to === null,
      `ingress must create authoritative meta — got ${JSON.stringify(m)}`);
    assert(noSideEffects(),
      `initialization is not a reopen — zero history/log expected, got logs=${adminLogs().length} history=${closeHistOf("w2").length}`);
  });

  await test("W3 topic-only meta (no status) + inbound → เติม status:bot รักษา metadata เดิม", async () => {
    seedMeta("w3", { topic: "warranty", pinned: true, item_ids: ["p1"] });
    const r = await applyInbound(ev("w3"));
    assert(r === "initialized", `expected initialized, got ${r}`);
    const m = metaOf("w3");
    assert(m?.status === "bot" && m?.topic === "warranty" && m?.pinned === true
      && JSON.stringify(m?.item_ids) === JSON.stringify(["p1"]),
      `existing metadata must be preserved — got ${JSON.stringify(m)}`);
  });

  await test("W4 closed + new inbound → reopened: bot + clear owner/close/pending + audit identity", async () => {
    seedMeta("w4", {
      status: "closed", closed_at: CT0, closed_by: "admin-1",
      assigned_to: "admin-1", assigned_at: new Date("2026-09-01T00:00:00Z"),
      assignment_mode_used: "manual", close_count: 1, pending_assignment: true,
    });
    mocks.fakeColl("close_history").push({
      record_id: "chr-w4", conversation_id: "w4", shop_id: "shop-1",
      customer_id: "cust-w4", closed_by: "admin-1", closed_at: CT0,
      reason: "done", category: "product", resolution: "answered", sequence: 1,
    });
    const e = ev("w4");
    const r = await applyInbound(e);
    assert(r === "reopened", `expected reopened, got ${r}`);
    const m = metaOf("w4");
    assert(m?.status === "bot" && m?.assigned_to === null && m?.assigned_at == null
      && m?.closed_at === null && m?.closed_by == null && !m?.pending_assignment,
      `reopen must clear owner+close+pending residue — got ${JSON.stringify(m)}`);
    assert(m?.close_count === 1, `close_count is history — must survive, got ${m?.close_count}`);
    assert(reopenLogs().length === 1 && reopenLogs()[0].metadata?.message_id === "m-w4",
      `reopen audit must carry inbound message_id — logs=${JSON.stringify(reopenLogs().map((l: any) => l.metadata))}`);
    assert(adminLogs("w4").length === 1,
      `single side-effect owner — exactly ONE conversation.open total, got ${adminLogs("w4").length} (recordReopen already logs internally; a second logAdminEvent = double)`);
    const hr = closeHistOf("w4")[0];
    assert(hr?.reopened_at instanceof Date,
      `successful closed→bot must mark latest close record reopened — got ${JSON.stringify(hr)}`);
  });

  await test("W5 bot + inbound → unchanged (zero write attempt + zero side-effects)", async () => {
    seedMeta("w5", { status: "bot", assigned_to: null });
    const r = await applyInbound(ev("w5"));
    const m = metaOf("w5");
    assert(r === "unchanged" && m?.status === "bot",
      `already-bot must be unchanged — r=${r} meta=${JSON.stringify(m)}`);
    assert(metaWrites().length === 0 && noSideEffects(),
      `no-op state must not attempt any write — writes=${metaWrites().length} logs=${adminLogs().length}`);
  });

  await test("W6 open+assigned + inbound → unchanged (admin-owned preserved, zero write)", async () => {
    seedMeta("w6", { status: "open", assigned_to: "admin-1" });
    const r = await applyInbound(ev("w6"));
    const m = metaOf("w6");
    assert(r === "unchanged" && m?.status === "open" && m?.assigned_to === "admin-1",
      `inbound must not flip admin-owned open — r=${r} meta=${JSON.stringify(m)}`);
    assert(metaWrites().length === 0 && noSideEffects(), "no write attempt / no side-effects");
  });

  await test("W7 handoff+assigned + inbound → unchanged (locked, zero write)", async () => {
    seedMeta("w7", { status: "handoff", assigned_to: "admin-1" });
    const r = await applyInbound(ev("w7"));
    const m = metaOf("w7");
    assert(r === "unchanged" && m?.status === "handoff" && m?.assigned_to === "admin-1",
      `handoff must refuse inbound transition — r=${r} meta=${JSON.stringify(m)}`);
    assert(metaWrites().length === 0 && noSideEffects(), "no write attempt / no side-effects");
  });

  await test("W8 handoff+pending_assignment + inbound → unchanged (pending kept, zero write)", async () => {
    seedMeta("w8", { status: "handoff", pending_assignment: true, assigned_to: null });
    const r = await applyInbound(ev("w8"));
    const m = metaOf("w8");
    assert(r === "unchanged" && m?.status === "handoff" && m?.pending_assignment === true,
      `pending must refuse inbound transition — r=${r} meta=${JSON.stringify(m)}`);
    assert(metaWrites().length === 0 && noSideEffects(), "no write attempt / no side-effects");
  });

  await test("W9 reopened write = exact CAS {conversation_id, status∈{closed,resolved}, closed_at<$lt inboundAt}", async () => {
    seedMeta("w9", { status: "closed", closed_at: CT0, assigned_to: "admin-1" });
    const e = ev("w9");
    await applyInbound(e);
    const fenced = metaWrites().find((q: any) => q.filter && q.filter.status !== undefined);
    assert(fenced,
      `transition must write via fenced CAS — writes=${JSON.stringify(metaWrites().map((q: any) => q.filter))}`);
    const f = fenced!.filter;
    assert(f.conversation_id === "w9", `filter.conversation_id=${f.conversation_id}`);
    const stSet: string[] = f.status?.$in ?? [f.status];
    assert(stSet.length === 2 && stSet.includes("closed") && stSet.includes("resolved"),
      `status fence must be exactly {closed,resolved} — ${JSON.stringify(f.status)}`);
    assert(f.closed_at?.$lt instanceof Date && f.closed_at.$lt.getTime() === e.inboundAt.getTime(),
      `closed_at must bound to event inboundAt ($lt) — ${JSON.stringify(f.closed_at)}`);
  });

  await test("W10 stale inbound (inboundAt < closed_at) → unchanged + meta identical + zero write/side-effects", async () => {
    seedMeta("w10", { status: "closed", closed_at: CT1, closed_by: "admin-1", assigned_to: "admin-1" });
    const r = await applyInbound(ev("w10", CT0)); // inbound older than close
    const m = metaOf("w10");
    assert(r === "unchanged",
      `stale inbound must not transition — r=${r}`);
    assert(m?.status === "closed" && m?.assigned_to === "admin-1"
      && m?.closed_at?.getTime?.() === CT1.getTime() && m?.closed_by === "admin-1",
      `meta must be identical — got ${JSON.stringify(m)}`);
    assert(metaWrites().length === 0 && noSideEffects(),
      "stale inbound must not attempt write / must not write history+log");
  });

  await test("W11 equal inbound (inboundAt === closed_at) → unchanged + zero write", async () => {
    seedMeta("w11", { status: "closed", closed_at: CT0 });
    const r = await applyInbound(ev("w11", CT0));
    const m = metaOf("w11");
    assert(r === "unchanged" && m?.status === "closed",
      `equal ts is not a new inbound — r=${r} meta=${JSON.stringify(m)}`);
    assert(metaWrites().length === 0 && noSideEffects(), "no write attempt / no side-effects");
  });

  await test("W12 resolved + new inbound → reopened: bot + residue cleared + audit", async () => {
    seedMeta("w12", { status: "resolved", closed_at: CT0, closed_by: "admin-1", assigned_to: "admin-1" });
    const r = await applyInbound(ev("w12"));
    const m = metaOf("w12");
    assert(r === "reopened" && m?.status === "bot" && m?.assigned_to === null
      && m?.closed_at === null && m?.closed_by == null,
      `resolved = wasClosed → must reopen like closed — r=${r} meta=${JSON.stringify(m)}`);
    assert(reopenLogs().length === 1, `reopened must emit audit — logs=${reopenLogs().length}`);
  });

  await test("W13 replay same event after reopened → unchanged + no duplicate side-effects", async () => {
    seedMeta("w13", { status: "closed", closed_at: CT0, assigned_to: "admin-1" });
    const e = ev("w13");
    const r1 = await applyInbound(e);
    assert(r1 === "reopened", `first call should reopen — got ${r1}`);
    const logsAfterFirst = reopenLogs().length;
    const r2 = await applyInbound(e); // duplicate poll/import replay
    assert(r2 === "unchanged" && reopenLogs().length === logsAfterFirst,
      `replay must be no-op — r2=${r2} logs ${logsAfterFirst}→${reopenLogs().length}`);
  });

  // ── W.init/race contract (boundary: command missing) ──
  // fake-mongo write hooks (findOneAndUpdateHook/updateOneHook) fire right
  // BEFORE the write executes — letting the admin mutation land between the
  // command's dispatch read and its fenced CAS = a genuine interleaving,
  // not a pre-call state change.
  const withWriteInterleave = (fn: (coll: string, filter: any) => Promise<void>) => {
    (mocks.state as any).findOneAndUpdateHook = fn;
    (mocks.state as any).updateOneHook = fn;
  };
  const clearWriteInterleave = () => {
    (mocks.state as any).findOneAndUpdateHook = null;
    (mocks.state as any).updateOneHook = null;
  };
  const metaReads = () =>
    mocks.state.queryLog.filter((q: any) => q.coll === "status_conversation" && q.op === "findOne");

  await test("W14 real read/CAS race: read sees closed → admin flip lands before CAS write → miss → bounded re-read → unchanged", async () => {
    seedMeta("w14", { status: "closed", closed_at: CT0 });
    let casAttempts = 0;
    withWriteInterleave(async (coll: string, filter: any) => {
      if (coll === "status_conversation" && filter?.status !== undefined && casAttempts === 0) {
        casAttempts++; // fenced-CAS write attempt → admin wins the interleaving at write time
        const d = metaOf("w14")!;
        d.status = "open"; d.assigned_to = "admin-2"; d.assigned_at = new Date();
      }
    });
    const r = await applyInbound(ev("w14"));
    clearWriteInterleave();
    const m = metaOf("w14");
    assert(r === "unchanged", `CAS must lose to admin-owned open — r=${r}`);
    assert(m?.status === "open" && m?.assigned_to === "admin-2",
      `admin-owned state must survive — meta=${JSON.stringify(m)}`);
    assert(casAttempts === 1, `exactly one fenced-CAS write attempt, no retry loop — got ${casAttempts}`);
    assert(metaReads().length <= 2, `read must be bounded (dispatch + ≤1 re-read) — got ${metaReads().length}`);
    assert(noSideEffects(), "zero history/log on lost race");
  });

  await test("W15 replay-after-reclose: E1 reopened → admin reclose(T2) → replay E1 → unchanged", async () => {
    seedMeta("w15", { status: "closed", closed_at: CT0 });
    const e = ev("w15", CT1);
    const r1 = await applyInbound(e);
    assert(r1 === "reopened", `first event should reopen — got ${r1}`);
    const doc = metaOf("w15")!; // admin closes again at T2 > E1.inboundAt
    doc.status = "closed"; doc.closed_at = new Date("2026-10-10T00:00:00Z"); doc.closed_by = "admin-1";
    const r2 = await applyInbound(e); // replay E1 — now stale vs new closed_at
    assert(r2 === "unchanged" && metaOf("w15")?.status === "closed",
      `stale replay must not reopen the second close — r2=${r2} meta=${JSON.stringify(metaOf("w15"))}`);
  });

  await test("W16 missing-meta replay: first initialized → second unchanged + single doc + no logs", async () => {
    const e = ev("w16");
    const r1 = await applyInbound(e);
    assert(r1 === "initialized", `first should initialize — got ${r1}`);
    const r2 = await applyInbound(e);
    assert(r2 === "unchanged",
      `init must be idempotent — r2=${r2}`);
    const docs = mocks.fakeColl("status_conversation").filter((d: any) => d.conversation_id === "w16");
    assert(docs.length === 1 && docs[0].status === "bot",
      `single meta doc — got ${docs.length}`);
    assert(noSideEffects(), "init replay must not emit reopen history/log");
  });

  await test("W17 successful reopened → conversation_products untouched (claim preserved)", async () => {
    seedMeta("w17", { status: "closed", closed_at: CT0, assigned_to: "admin-1" });
    await applyInbound(ev("w17"));
    assert(!mocks.state.queryLog.some((q: any) => q.coll === "conversation_products"),
      "ownership transition must not touch claim-state collection");
  });

  await test("W18 literal status:'pending' + inbound → unchanged (distinct from handoff+pending_assignment)", async () => {
    // "pending" เป็น status literal ของตัวเอง — คนละ representation กับ W8
    // (handoff + pending_assignment:true) — ทั้งคู่ต้อง refuse
    seedMeta("w18", { status: "pending", assigned_to: "admin-1" });
    const r = await applyInbound(ev("w18"));
    const m = metaOf("w18");
    assert(r === "unchanged" && m?.status === "pending" && m?.assigned_to === "admin-1",
      `literal pending must refuse inbound transition — r=${r} meta=${JSON.stringify(m)}`);
    assert(metaWrites().length === 0 && noSideEffects(), "no write attempt / no side-effects");
  });

  // ── W.side-effect policy (missing boundary: side-effect contract on the command) ──

  await test("W19 reopened → exactly ONE conversation.open total (recordReopen is sole owner)", async () => {
    seedMeta("w19", { status: "closed", closed_at: CT0, assigned_to: "admin-1" });
    await applyInbound(ev("w19"));
    assert(reopenLogs().length === 1 && adminLogs("w19").length === 1,
      `double-emit contract: recordReopen logs conversation.open internally — a second logAdminEvent after it = 2. got reopen=${reopenLogs().length} total=${adminLogs("w19").length}`);
  });

  await test("W20 CAS-miss (admin-owned) → zero history + zero logs", async () => {
    seedMeta("w20", { status: "handoff", assigned_to: "admin-1" });
    await applyInbound(ev("w20"));
    assert(noSideEffects(),
      `refused transition must emit nothing — logs=${adminLogs().length} history=${mocks.fakeColl("close_history").length}`);
  });

  await test("W21 initialization → zero history + zero logs (init ≠ reopen)", async () => {
    await applyInbound(ev("w21"));
    assert(noSideEffects(),
      `initialization must not produce reopen artifacts — logs=${adminLogs().length} history=${mocks.fakeColl("close_history").length}`);
  });

  // ── W.concurrent reconciliation (boundary: command missing) ──

  await test("W22 crash window: side-effect failure after CAS → state commits + retry converges audit once", async () => {
    // option-B contract: CAS is authoritative; a crash between CAS and audit
    // must not roll back state, and an external retry of the SAME event must
    // converge audit to exactly-once via stored event identity
    seedMeta("w22", { status: "closed", closed_at: CT0, assigned_to: "admin-1" });
    mocks.fakeColl("close_history").push({
      record_id: "chr-w22", conversation_id: "w22", shop_id: "shop-1",
      customer_id: "cust-w22", closed_by: "admin-1", closed_at: CT0,
      reason: "done", category: "product", resolution: "answered", sequence: 1,
    });
    assert(typeof (statusSvc as any).applyInboundOwnershipTransition === "function",
      "statusConversationService.applyInboundOwnershipTransition missing — RED forward contract");
    const e = ev("w22");
    (mocks.state as any).findOneHook = async (coll: string) => {
      if (coll === "close_history") throw new Error("simulated crash between CAS and audit");
    };
    let crashed = false;
    try { await applyInbound(e); } catch { crashed = true; }
    assert(crashed, "side-effect failure must surface to caller (transport retries)");
    assert(metaOf("w22")?.status === "bot",
      `CAS must commit despite audit crash — meta=${JSON.stringify(metaOf("w22"))}`);
    (mocks.state as any).findOneHook = null;
    const r2 = await applyInbound(e); // external retry of the same event
    assert(r2 === "unchanged", `retry on committed state → unchanged, got ${r2}`);
    assert(adminLogs("w22").length === 1 && closeHistOf("w22")[0]?.reopened_at instanceof Date,
      `retry must converge audit to exactly-once — logs=${adminLogs("w22").length} history=${JSON.stringify(closeHistOf("w22"))}`);
  });

  await test("W23 duplicate transport request (same event twice) → converged side-effects", async () => {
    seedMeta("w23", { status: "closed", closed_at: CT0, assigned_to: "admin-1" });
    mocks.fakeColl("close_history").push({
      record_id: "chr-w23", conversation_id: "w23", shop_id: "shop-1",
      customer_id: "cust-w23", closed_by: "admin-1", closed_at: CT0,
      reason: "done", category: "product", resolution: "answered", sequence: 1,
    });
    const e = ev("w23");
    await applyInbound(e);
    await applyInbound(e); // duplicate HTTP delivery of the same event
    assert(adminLogs("w23").length === 1,
      `duplicate request must not double-emit — logs=${adminLogs("w23").length}`);
  });

  await test("W27 concurrent loser reconcile: A wins CAS + dies mid-audit → B's CAS misses → re-read sees matching event id → B settles", async () => {
    // timeline: A reads closed, wins fenced CAS (status=bot +
    // inbound_reopen_event_id=E1.messageId), dies before audit completes.
    // B (same event) read closed before A's commit; B's CAS must miss,
    // B re-reads (bounded ≤1), sees bot + matching event id → settles the
    // missing audit idempotently, returns unchanged. (A's throw contract
    // — transport knows the operation was incomplete — is pinned by W22.)
    seedMeta("w27", { status: "closed", closed_at: CT0 });
    mocks.fakeColl("close_history").push({
      record_id: "chr-w27", conversation_id: "w27", shop_id: "shop-1",
      customer_id: "cust-w27", closed_by: "admin-1", closed_at: CT0,
      reason: "done", category: "product", resolution: "answered", sequence: 1,
    });
    const e = ev("w27");
    let bCas = 0;
    withWriteInterleave(async (coll: string, filter: any) => {
      if (coll === "status_conversation" && filter?.status !== undefined && bCas === 0) {
        bCas++; // A's CAS commits between B's read and B's write
        const d = metaOf("w27")!;
        d.status = "bot"; d.assigned_to = null; d.assigned_at = null;
        d.closed_at = null; d.closed_by = null; d.pending_assignment = false;
        d.inbound_reopen_event_id = e.messageId;
      }
    });
    const r = await applyInbound(e);
    clearWriteInterleave();
    assert(r === "unchanged", `CAS loser reports unchanged (state committed by winner) — r=${r}`);
    assert(metaOf("w27")?.status === "bot",
      `winner state preserved — meta=${JSON.stringify(metaOf("w27"))}`);
    assert(bCas === 1, `exactly one fenced CAS attempt by the loser — got ${bCas}`);
    assert(adminLogs("w27").length === 1 && closeHistOf("w27")[0]?.reopened_at instanceof Date,
      `loser must settle matching event's audit — logs=${adminLogs("w27").length} hist=${JSON.stringify(closeHistOf("w27"))}`);
    assert(metaReads().length <= 2, `bounded re-read only — got ${metaReads().length}`);
  });

  await test("W28 CAS loser sees DIFFERENT inbound_reopen_event_id → must NOT settle side-effects", async () => {
    // same race but the committed bot state belongs to a different inbound
    // event — settling E1's audit now would fabricate E1's reopen.
    seedMeta("w28", { status: "closed", closed_at: CT0 });
    withWriteInterleave(async (coll: string, filter: any) => {
      if (coll === "status_conversation" && filter?.status !== undefined) {
        const d = metaOf("w28")!; // winner was a different event
        d.status = "bot"; d.assigned_to = null; d.closed_at = null;
        d.inbound_reopen_event_id = "m-older-event";
      }
    });
    const r = await applyInbound(ev("w28"));
    clearWriteInterleave();
    assert(r === "unchanged" && metaOf("w28")?.status === "bot",
      `unchanged + winner state kept — r=${r} meta=${JSON.stringify(metaOf("w28"))}`);
    assert(adminLogs().length === 0,
      `different event id → zero audit settle — logs=${adminLogs().length}`);
  });

  // ── W.deterministic audit identity (boundary: logAdminEvent eventId support) ──
  // contract: _id = "adminlog:event:" + sha256(JSON.stringify([action, convId, messageId])).slice(0,32)
  // E11000 + matching existing identity → already-logged (no throw, no dup)
  // E11000 + mismatched identity / non-E11000 → throw (no blind swallow)
  // legacy callers without eventId → auto _id, unchanged
  const { createHash } = await import("node:crypto");
  const detLogId = (action: string, convId: string, messageId: string) =>
    "adminlog:event:" + createHash("sha256")
      .update(JSON.stringify([action, convId, messageId])).digest("hex").slice(0, 32);
  const logEvt = (over: any = {}): any =>
    ({ action_type: "conversation.open", actor: "test-suite",
      conversation_id: "w-log", metadata: {}, eventId: "m-log", ...over });

  await test("W29 same action+conversation+message → deterministic _id + single doc", async () => {
    const expected = detLogId("conversation.open", "w29", "m-w29");
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w29", eventId: "m-w29" }));
    const docs = adminLogs("w29");
    assert(docs.length === 1 && docs[0]._id === expected,
      `deterministic _id contract — got ${JSON.stringify(docs.map((d: any) => d._id))} expected ${expected}`);
  });

  await test("W30 same message + different conversation → different _id (both persist)", async () => {
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w30a", eventId: "m-x" }));
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w30b", eventId: "m-x" }));
    const a = adminLogs("w30a")[0], b = adminLogs("w30b")[0];
    assert(a?._id === detLogId("conversation.open", "w30a", "m-x")
        && b?._id === detLogId("conversation.open", "w30b", "m-x") && a._id !== b._id,
      `conversation must participate in id — got ${a?._id} / ${b?._id}`);
  });

  await test("W31 same conversation+message + different action → different _id", async () => {
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w31", eventId: "m-w31" }));
    await adminLogSvc.logAdminEvent(logEvt({ action_type: "conversation.assign", conversation_id: "w31", eventId: "m-w31" }));
    const ids = adminLogs("w31").map((d: any) => d._id);
    assert(ids.includes(detLogId("conversation.open", "w31", "m-w31"))
        && ids.includes(detLogId("conversation.assign", "w31", "m-w31")),
      `action must participate in id — got ${JSON.stringify(ids)}`);
  });

  await test("W32 delimiter-like values must not collide (JSON-array serialization)", async () => {
    const a = detLogId("conversation.open", 'c"],["x', "m");
    const b = detLogId("conversation.open", "c", 'm"],["x');
    assert(a !== b, "crafted values collided");
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: 'c"],["x', eventId: "m" }));
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "c", eventId: 'm"],["x' }));
    const docs = adminLogs().filter((d: any) =>
      typeof d._id === "string" && d._id.startsWith("adminlog:event:"));
    assert(docs.length === 2, `crafted events must produce 2 distinct docs — got ${docs.length}`);
  });

  await test("W33 duplicate exact event redelivery → single doc, no throw", async () => {
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w33", eventId: "m-w33" }));
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w33", eventId: "m-w33" })); // retry
    assert(adminLogs("w33").length === 1,
      `idempotent redelivery must converge to one doc — got ${adminLogs("w33").length}`);
  });

  await test("W34 _id collision with DIFFERENT identity → throw (no blind E11000 swallow)", async () => {
    mocks.fakeColl("admin_logs").push({
      _id: detLogId("conversation.open", "w34", "m-w34"),
      action_type: "conversation.close", conversation_id: "w34",
      actor: "seeded", metadata: {},
    });
    let threw = false;
    try {
      await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w34", eventId: "m-w34" }));
    } catch { threw = true; }
    assert(threw, "E11000 + mismatched existing identity must surface, not be swallowed");
  });

  await test("W35 non-E11000 insert failure → throw (no silent swallow)", async () => {
    (mocks.state as any).insertOneHook = async (coll: string) => {
      if (coll === "admin_logs") throw new Error("simulated write concern failure");
    };
    let threw = false;
    try { await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w35" })); } catch { threw = true; }
    (mocks.state as any).insertOneHook = null;
    assert(threw, "non-E11000 errors must propagate to caller");
  });

  await test("W36 legacy caller without eventId → unchanged behavior (auto _id, no dedupe)", async () => {
    await adminLogSvc.logAdminEvent(logEvt({ conversation_id: "w36", eventId: undefined }));
    const d = adminLogs("w36")[0];
    assert(d && !(typeof d._id === "string" && d._id.startsWith("adminlog:event:")),
      `no eventId → no deterministic _id — got ${d?._id}`);
  });

  // ── W.executable transport (boundary: route module missing) ──
  // route runs against REAL lib/config (env CHATBOT_INTERNAL_SECRET set at
  // suite top) + service spy leaf (importer-filtered to /src/app/api/internal/)
  // — auth/validation/delegation asserted via runtime calls, not regex.
  const INTERNAL_SECRET = "verify-only-internal-nonsecret"; // set as env at suite top
  const loadInboundRoute = async () => {
    // dynamic specifier — the route file may not exist yet (RED boundary);
    // a literal specifier would fail tsc resolution instead of asserting at runtime
    const routePath = "../src/app/api/internal/inbound-lifecycle/route";
    try { return await import(routePath); }
    catch { return null; }
  };
  const postInbound = async (body: any, secret?: string) => {
    const mod = await loadInboundRoute();
    assert(mod?.POST,
      "route module missing — RED forward contract (api/internal/inbound-lifecycle/route.ts)");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/internal/inbound-lifecycle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-internal-secret": secret } : {}),
      },
      body: JSON.stringify(body),
    });
    return mod.POST(req);
  };
  const validBody = { conversation_id: "w-t1", message_id: "m-w-t1", inbound_at: CT1.toISOString() };
  const expectReject = async (body: any, secret: string | undefined, status: number, label: string) => {
    const res = await postInbound(body, secret);
    assert(res.status === status && mocks.state.inboundTransitionCalls === 0,
      `${label}: expected ${status} + zero service calls — got ${res.status} calls=${mocks.state.inboundTransitionCalls}`);
  };

  await test("W37 route: no x-internal-secret → 401 + service never invoked (auth before service, by call count)", async () => {
    await expectReject(validBody, undefined, 401, "no secret");
  });

  await test("W38 route: wrong secret → 401 + calls=0", async () => {
    await expectReject(validBody, "wrong-secret", 401, "wrong secret");
  });

  await test("W39 route: missing conversation_id → 422 + calls=0", async () => {
    await expectReject({ ...validBody, conversation_id: undefined }, INTERNAL_SECRET, 422, "missing conversation_id");
  });

  await test("W40 route: missing message_id → 422 + calls=0", async () => {
    await expectReject({ ...validBody, message_id: undefined }, INTERNAL_SECRET, 422, "missing message_id");
  });

  await test("W41 route: missing/invalid inbound_at → 422 + calls=0", async () => {
    await expectReject({ ...validBody, inbound_at: undefined }, INTERNAL_SECRET, 422, "missing inbound_at");
    await expectReject({ ...validBody, inbound_at: "not-a-date" }, INTERNAL_SECRET, 422, "unparseable inbound_at");
  });

  await test("W42 route: non-string/empty fields → 422 + calls=0", async () => {
    await expectReject({ ...validBody, conversation_id: "" }, INTERNAL_SECRET, 422, "empty conversation_id");
    await expectReject({ ...validBody, conversation_id: 123 }, INTERNAL_SECRET, 422, "non-string conversation_id");
    await expectReject({ ...validBody, message_id: " " }, INTERNAL_SECRET, 422, "blank message_id");
  });

  await test("W43 route: valid request → delegates once, camelCase args, 200 {outcome}", async () => {
    const res = await postInbound(validBody, INTERNAL_SECRET);
    const body = await res.json().catch(() => null);
    assert(res.status === 200, `expected 200 — got ${res.status} body=${JSON.stringify(body)}`);
    assert(mocks.state.inboundTransitionCalls === 1,
      `exactly one service call — got ${mocks.state.inboundTransitionCalls}`);
    const arg = mocks.state.inboundTransitionArgs[0];
    assert(arg?.conversationId === "w-t1" && arg?.messageId === "m-w-t1" && arg?.inboundAt instanceof Date,
      `route must map snake→camel and parse ISO→Date — got ${JSON.stringify(arg)}`);
    assert(body && typeof body.outcome === "string",
      `200 body must carry typed outcome — got ${JSON.stringify(body)}`);
  });

  await test("W44 route: service throws → 500 + no raw error/secret leak", async () => {
    mocks.state.inboundTransitionError = new Error("simulated-failure-should-not-leak");
    const res = await postInbound(validBody, INTERNAL_SECRET);
    const body = await res.json().catch(() => null);
    assert(res.status === 500, `expected 500 — got ${res.status} body=${JSON.stringify(body)}`);
    const leak = JSON.stringify(body);
    assert(!leak.includes("simulated-failure-should-not-leak") && !leak.includes(INTERNAL_SECRET),
      `500 body must not expose raw error/secret — got ${leak}`);
  });

  await test("W45 route: duplicate valid delivery → route delegates every time (dedupe lives in command)", async () => {
    const r1 = await postInbound(validBody, INTERNAL_SECRET);
    const r2 = await postInbound(validBody, INTERNAL_SECRET);
    assert(r1.status === 200 && r2.status === 200 && mocks.state.inboundTransitionCalls === 2,
      `route must not self-dedupe — got statuses ${r1.status}/${r2.status} calls=${mocks.state.inboundTransitionCalls}`);
  });

  await test("W46 middleware: exact path in PUBLIC_API → unauthenticated POST passes through to route", async () => {
    const { middleware } = await import("../src/middleware");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/internal/inbound-lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await middleware(req);
    assert(res.status === 200,
      `middleware must pass the allowlisted route through — got ${res.status}`);
    assert(res.headers.get("x-middleware-next") === "1",
      `NextResponse.next() marker expected — got ${res.headers.get("x-middleware-next")}`);
  });

  await test("W48 route: overlong conversation_id/message_id → 422 + calls=0", async () => {
    const long = "x".repeat(300);
    await expectReject({ ...validBody, conversation_id: long }, INTERNAL_SECRET, 422, "overlong conversation_id");
    await expectReject({ ...validBody, message_id: long }, INTERNAL_SECRET, 422, "overlong message_id");
  });

  await test("W49 route: ISO string without timezone → 422 + calls=0", async () => {
    await expectReject({ ...validBody, inbound_at: "2026-10-05T00:00:00" }, INTERNAL_SECRET, 422, "no-timezone ISO");
  });

  await test("W50 route: valid timezone offset → delegates with correct Date", async () => {
    const res = await postInbound(
      { ...validBody, inbound_at: "2026-10-05T07:00:00+07:00" }, INTERNAL_SECRET);
    assert(res.status === 200 && mocks.state.inboundTransitionCalls === 1,
      `offset timestamp must be accepted — got ${res.status}`);
    const arg = mocks.state.inboundTransitionArgs[0];
    assert(arg?.inboundAt instanceof Date
      && arg.inboundAt.getTime() === new Date("2026-10-05T00:00:00Z").getTime(),
      `offset must parse to correct UTC instant — got ${arg?.inboundAt}`);
  });

  await test("W51 route: calendar-invalid date 2026-02-30 → 422 + calls=0 (no Date normalization)", async () => {
    // new Date("2026-02-30T00:00:00Z") silently normalizes to Mar 2 — an
    // invented instant must never drive the closed→bot staleness fence
    await expectReject({ ...validBody, inbound_at: "2026-02-30T00:00:00Z" }, INTERNAL_SECRET, 422, "2026-02-30");
    await expectReject({ ...validBody, inbound_at: "2026-13-01T00:00:00Z" }, INTERNAL_SECRET, 422, "month 13");
  });

  await test("W52 route: out-of-range clock/offset fields → 422 + calls=0", async () => {
    await expectReject({ ...validBody, inbound_at: "2026-10-05T25:00:00Z" }, INTERNAL_SECRET, 422, "hour 25");
    await expectReject({ ...validBody, inbound_at: "2026-10-05T00:00:00+24:00" }, INTERNAL_SECRET, 422, "offset hour 24");
    await expectReject({ ...validBody, inbound_at: "2026-10-05T00:00:60Z" }, INTERNAL_SECRET, 422, "second 60");
  });

  await test("W53 route: real leap day 2028-02-29 → 200 + correct Date", async () => {
    const res = await postInbound({ ...validBody, inbound_at: "2028-02-29T00:00:00Z" }, INTERNAL_SECRET);
    assert(res.status === 200 && mocks.state.inboundTransitionCalls === 1,
      `valid leap day must be accepted — got ${res.status}`);
    const arg = mocks.state.inboundTransitionArgs[0];
    assert(arg?.inboundAt instanceof Date
      && arg.inboundAt.getTime() === new Date("2028-02-29T00:00:00Z").getTime(),
      `leap-day instant must be exact — got ${arg?.inboundAt}`);
  });

  await test("W54 route: fractional seconds canonicalize to ms by truncation (no round, no carry)", async () => {
    // Python-style microsecond timestamps — receiver contract stores ms only
    let res = await postInbound(
      { ...validBody, inbound_at: "2026-10-05T00:00:00.123456Z" }, INTERNAL_SECRET);
    assert(res.status === 200 && mocks.state.inboundTransitionCalls === 1,
      `microsecond timestamp must be accepted — got ${res.status}`);
    let arg = mocks.state.inboundTransitionArgs[0];
    assert(arg?.inboundAt instanceof Date
      && arg.inboundAt.getTime() === new Date("2026-10-05T00:00:00.123Z").getTime(),
      `.123456 must truncate to .123 — got ${arg?.inboundAt?.toISOString()}`);

    mocks.state.inboundTransitionCalls = 0;
    mocks.state.inboundTransitionArgs.length = 0;
    res = await postInbound(
      { ...validBody, inbound_at: "2026-10-05T07:00:00.999999+07:00" }, INTERNAL_SECRET);
    assert(res.status === 200 && mocks.state.inboundTransitionCalls === 1,
      `.999999 must be accepted (no second carry) — got ${res.status}`);
    arg = mocks.state.inboundTransitionArgs[0];
    assert(arg?.inboundAt instanceof Date
      && arg.inboundAt.getTime() === new Date("2026-10-05T00:00:00.999Z").getTime(),
      `.999999+07:00 must be 00:00:00.999Z, not carried — got ${arg?.inboundAt?.toISOString()}`);
  });

  // ═══ H. typed handoff outcome — Phase 2B.2 contract ═══
  // HandoffOutcome = { state:"assigned"|"queued"|"failed", assigned_to,
  //   assigned_to_name, persisted, reason, error_code, reopened, emit_incomplete }
  // state ต้องสะท้อน persisted DB truth เท่านั้น — ห้าม derive จาก selection
  // assigned ⇔ meta{status:handoff,assigned_to:X} committed/converged
  // queued   ⇔ meta{status:handoff,assigned_to:null,pending_assignment:true}
  // failed   ⇔ ไม่มี durable state ที่ verify ได้ — ห้าม claim success

  await test("H1 persisted assignment → outcome{state:assigned,assigned_to,persisted:true}", async () => {
    seedConv("h1"); seedShop(); seedAdmin("admin-1");
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h1", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "assigned" && r.assigned_to === "admin-1"
      && r.persisted === true && r.error_code === null,
      `typed outcome missing/incorrect — got ${JSON.stringify(r)}`);
    const m = metaOf("h1");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1",
      `persisted meta must back the outcome — got ${JSON.stringify(m)}`);
  });

  await test("H2 no admin in pool → outcome{state:queued} + durable pending marker", async () => {
    seedConv("h2"); seedShop();
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h2", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "queued" && r.assigned_to === null && r.persisted === true,
      `queued outcome required — got ${JSON.stringify(r)}`);
    const m = metaOf("h2");
    assert(m?.pending_assignment === true && m?.assigned_to === null
      && m?.status === "handoff",
      `durable queued state = handoff + pending_assignment — got ${JSON.stringify(m)}`);
  });

  await test("H3 conversation missing → outcome{state:failed,persisted:false} + zero writes/audit", async () => {
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h3-ghost", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "failed" && r.persisted === false && r.error_code,
      `missing conv must be typed failure — got ${JSON.stringify(r)}`);
    assert(!metaOf("h3-ghost") && noSideEffects(),
      "failed outcome must leave no meta doc / audit rows");
  });

  await test("H4 assignment CAS throws → outcome{state:failed}; no owner persisted, no success audit", async () => {
    seedConv("h4"); seedShop(); seedAdmin("admin-1");
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation") throw new Error("simulated db failure");
    };
    let r: any;
    try {
      r = await (handoffSvc.handoffToAdmin as any)({
        conversationId: "h4", shopId: "shop-1", platform: "shopee",
      });
    } catch { /* raw throw is NOT a typed outcome */ }
    (mocks.state as any).findOneAndUpdateHook = null;
    assert(r?.state === "failed" && r.persisted === false && r.error_code,
      `commit failure must surface as failed outcome — got ${JSON.stringify(r)}`);
    const m = metaOf("h4");
    assert(!m?.assigned_to, `failed outcome must not persist an owner — got ${JSON.stringify(m)}`);
    const audit = mocks.fakeColl("admin_logs").filter((d: any) =>
      d.conversation_id === "h4" && (d.action_type === "chat_assigned" || d.action_type === "conversation.handoff"));
    assert(audit.length === 0, `failed handoff must emit zero success audit — got ${audit.length}`);
  });

  await test("H5 existing admin owner → converge assigned; zero writes + zero new audit (no duplicate)", async () => {
    seedConv("h5"); seedShop(); seedAdmin("admin-1");
    seedMeta("h5", { status: "handoff", assigned_to: "admin-1", assigned_at: new Date() });
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h5", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "assigned" && r.assigned_to === "admin-1",
      `existing owner must converge as assigned — got ${JSON.stringify(r)}`);
    assert(metaWrites().length === 0,
      `converge on owned conv must not rewrite meta — writes=${metaWrites().length}`);
    const audit = mocks.fakeColl("admin_logs").filter((d: any) => d.conversation_id === "h5");
    assert(audit.length === 0,
      `converge must not emit assignment/handoff audit — got ${audit.length} rows`);
    assert(metaOf("h5")?.assigned_to === "admin-1",
      "existing owner must survive unchanged");
  });

  await test("H6 duplicate handoff → converge; assignment/log exactly once", async () => {
    seedConv("h6"); seedShop(); seedAdmin("admin-1");
    const opts = { conversationId: "h6", shopId: "shop-1", platform: "shopee" };
    const r1 = await (handoffSvc.handoffToAdmin as any)(opts);
    const r2 = await (handoffSvc.handoffToAdmin as any)(opts);
    assert(r1?.state === "assigned" && r2?.state === "assigned"
      && r1.assigned_to === "admin-1" && r2.assigned_to === "admin-1",
      `duplicate must converge to same owner — r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
    const assignedLogs = mocks.fakeColl("admin_logs").filter((d: any) =>
      d.conversation_id === "h6" && d.action_type === "chat_assigned").length;
    const handoffLogs = mocks.fakeColl("admin_logs").filter((d: any) =>
      d.conversation_id === "h6" && d.action_type === "conversation.handoff").length;
    assert(assignedLogs === 1 && handoffLogs === 1,
      `audit must be exactly-once — chat_assigned=${assignedLogs} handoff=${handoffLogs}`);
    assert(metaOf("h6")?.assigned_to === "admin-1" && metaOf("h6")?.pending_assignment !== true,
      "duplicate must not flip to pending");
  });

  await test("H7 stale-read race: winner lands between dispatch-read and CAS → loser converges, no clobber", async () => {
    seedConv("h7"); seedShop(); seedAdmin("admin-1");
    // genuine interleave (W14 pattern): findOneAndUpdateHook fires right before
    // the fenced CAS write — a concurrent winner's assignment lands in between
    let landed = false;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !landed) {
        landed = true;
        const d = metaOf("h7");
        if (d) { d.status = "handoff"; d.assigned_to = "admin-1"; d.assigned_at = new Date(); }
        else seedMeta("h7", { status: "handoff", assigned_to: "admin-1", assigned_at: new Date() });
      }
    };
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h7", shopId: "shop-1", platform: "shopee",
    });
    (mocks.state as any).findOneAndUpdateHook = null;
    assert(r?.state === "assigned" && r.assigned_to === "admin-1",
      `CAS loser must converge to committed winner — got ${JSON.stringify(r)}`);
    const m = metaOf("h7");
    assert(m?.assigned_to === "admin-1" && m?.pending_assignment !== true,
      `winner's assignment must survive — loser's pending write must be fenced out — meta=${JSON.stringify(m)}`);
  });

  await test("H8 queued conv + retry (admin now in pool) → assigned upgrade, pending cleared", async () => {
    seedConv("h8"); seedShop(); seedAdmin("admin-1");
    seedMeta("h8", { status: "handoff", assigned_to: null, pending_assignment: true, assignment_reason: "no_available_admin" });
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h8", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "assigned" && r.assigned_to === "admin-1",
      `queued retry must upgrade to assigned — got ${JSON.stringify(r)}`);
    const m = metaOf("h8");
    assert(m?.assigned_to === "admin-1" && m?.pending_assignment === false,
      `pending flag must clear on upgrade — got ${JSON.stringify(m)}`);
  });

  await test("H9 bot-handoff route response carries typed outcome", async () => {
    seedConv("h9"); seedShop(); seedAdmin("admin-1");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "verify-only-internal-nonsecret",
      },
      body: JSON.stringify({ conversation_id: "h9" }),
    });
    const res = await (botHandoffRoute as any).POST(req);
    const j = await res.json();
    assert(j?.outcome?.state === "assigned" && j.outcome.assigned_to === "admin-1"
      && j.outcome.persisted === true,
      `route must return typed outcome — got ${JSON.stringify(j)}`);
  });

  await test("H10 workflow assign_ticket (auto) → handoff outcome state surfaced", async () => {
    (mocks.state as any).config.workflow_enabled = true;
    seedAdmin("admin-1"); seedShop();
    mocks.fakeColl("workflows").push({
      workflow_id: "wf-auto", name: "auto assign",
      shop_ids: ["shop-1"], platforms: ["shopee"],
      enabled: true, status: "published", is_deleted: false,
      trigger_frequency: "every_time", priority: 1, created_at: new Date(),
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: { keywords: ["สวัสดี"] } },
        { node_id: "a1", type: "action", subtype: "assign_ticket", config: { reason: "wf-auto" } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }],
    });
    seedConv("h10");
    const res = await wf.matchAndRun({
      message_id: "m-h10", conversation_id: "h10", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    assert((res.handoff as any)?.state === "assigned" && res.handoff?.agentId === "admin-1",
      `workflow auto-assign must surface typed outcome — got ${JSON.stringify(res.handoff)}`);
  });

  await test("H11 closed conv + handoff → assigned + reopened; single reopen settle + single assignment audit", async () => {
    seedConv("h11"); seedShop(); seedAdmin("admin-1");
    seedMeta("h11", { status: "closed", closed_at: new Date("2026-10-01"), closed_by: "admin-1", assigned_to: null });
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h11", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "assigned" && r.assigned_to === "admin-1" && r.reopened === true,
      `closed conv must reopen+assign — got ${JSON.stringify(r)}`);
    const m = metaOf("h11");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1" && m?.closed_at === null,
      `closed residue must clear in the same commit — got ${JSON.stringify(m)}`);
    const openLogs = mocks.fakeColl("admin_logs").filter((d: any) =>
      d.conversation_id === "h11" && d.action_type === "conversation.open").length;
    const assignedLogs = mocks.fakeColl("admin_logs").filter((d: any) =>
      d.conversation_id === "h11" && d.action_type === "chat_assigned").length;
    assert(openLogs === 1 && assignedLogs === 1,
      `exactly-once audit — open=${openLogs} assigned=${assignedLogs}`);
  });

  await test("H12 assigned outcome → ticket_state resolves handoff (bot-stop derives from persisted meta)", async () => {
    seedConv("h12"); seedShop(); seedAdmin("admin-1");
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h12", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "assigned", `need assigned outcome — got ${JSON.stringify(r)}`);
    await botCall.callBot({
      conversationId: "h12", shopId: "shop-1", platform: "shopee",
      message: "test", history: [],
    } as any);
    const last = mocks.state.fetchBodies[mocks.state.fetchBodies.length - 1];
    assert(last?.ticket_state === "handoff",
      `persisted handoff must lock bot via ticket_state — got ${last?.ticket_state}`);
  });

  await test("H13 queued conv + repeat handoff (still no admin) → converge queued, zero re-write", async () => {
    seedConv("h13"); seedShop();
    seedMeta("h13", { status: "handoff", assigned_to: null, pending_assignment: true, assignment_reason: "no_available_admin" });
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h13", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "queued" && r.persisted === true,
      `queued repeat must converge — got ${JSON.stringify(r)}`);
    assert(metaWrites().length === 0,
      `already-queued conv must not be rewritten — writes=${metaWrites().length}`);
    assert(metaOf("h13")?.pending_assignment === true && metaOf("h13")?.assigned_to === null,
      "queued state must persist unchanged");
  });

  await test("H14 meta status:'bot'+assigned_to (inconsistent) → owner เดิม normalize เป็น handoff; call ซ้ำ converge zero-write", async () => {
    // assigned outcome ต้องสอดคล้อง persisted lifecycle — status:"bot" หมายถึง bot ยังถือ ownership
    // ตาม resolveTicketState → converge zero-write บน state นี้จะโกหก (คืน assigned แต่ ticket_state=bot)
    seedConv("h14"); seedShop();
    seedMeta("h14", { status: "bot", assigned_to: "admin-1" });
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h14", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "assigned" && r.assigned_to === "admin-1" && r.persisted === true,
      `inconsistent bot-owned state must normalize to assigned outcome — got ${JSON.stringify(r)}`);
    const m = metaOf("h14");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1",
      `persisted meta must be handoff after call — got ${JSON.stringify({ status: m?.status, assigned_to: m?.assigned_to })}`);
    const handoffLogs = adminLogs("h14").filter((d: any) => d.action_type === "chat_assigned" || d.action_type === "conversation.handoff").length;
    assert(handoffLogs >= 1, `normalize transition must audit — logs=${handoffLogs}`);
    mocks.state.queryLog.length = 0;
    const r2 = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "h14", shopId: "shop-1", platform: "shopee",
    });
    assert(r2?.state === "assigned" && r2.assigned_to === "admin-1",
      `second call must converge assigned — got ${JSON.stringify(r2)}`);
    assert(metaWrites().length === 0,
      `converge on normalized state must be zero-write — writes=${metaWrites().length}`);
    assert(adminLogs("h14").filter((d: any) => d.action_type === "chat_assigned" || d.action_type === "conversation.handoff").length === handoffLogs,
      "converge must not duplicate transition audit (eid dedupe)");
  });

  // ═══ I. persisted-outcome settlement + workflow truth + cursor race — Phase 2B.2 review-fix ═══
  // Contract:
  //   - commit สำเร็จ = ownership เป็น authoritative แล้ว — outcome ห้าม persisted:false
  //   - settle (reopen/audit/cursor) ต้อง converge idempotently ด้วย transition identity เดิม
  //   - workflow assign_ticket: failed → ไม่มี handoff ให้ downstream finalize เป็น handed_off
  //   - workflow direct admin_id → owner typed เดียวกัน; CAS แพ้ต้องคืน persisted winner
  //   - cursor ขยับ 1 ครั้งต่อ committed assignment เท่านั้น
  //   - outcome.reason/API/stdout ห้าม expose raw exception text

  const insertErrorOnce = (matchAction: string) => {
    let fired = false;
    (mocks.state as any).insertOneHook = async (coll: string, doc: any) => {
      if (!fired && coll === "admin_logs" && doc?.action_type === matchAction) {
        fired = true;
        throw new Error("simulated settle crash");
      }
    };
  };
  const clearHooks = () => {
    (mocks.state as any).insertOneHook = null;
    (mocks.state as any).updateOneHook = null;
    (mocks.state as any).findOneAndUpdateHook = null;
    (mocks.state as any).findOneHook = null;
  };
  const logsOf = (id: string, action: string) =>
    mocks.fakeColl("admin_logs").filter((d: any) =>
      d.conversation_id === id && d.action_type === action);

  await test("I1 commit assigned + recordReopen throws → persisted truth kept; retry settles reopen+audit exactly once", async () => {
    seedConv("i1"); seedShop(); seedAdmin("admin-1");
    seedMeta("i1", { status: "closed", closed_at: new Date("2026-10-01"), closed_by: "admin-9", assigned_to: null });
    mocks.fakeColl("close_history").push({
      record_id: "chr-i1", conversation_id: "i1", shop_id: "shop-1",
      customer_id: "cust-i1", closed_by: "admin-9", closed_at: new Date("2026-10-01"),
      reason: "done", category: "other", resolution: "answered", sequence: 1,
    });
    insertErrorOnce("conversation.open");
    const opts = { conversationId: "i1", shopId: "shop-1", platform: "shopee" };
    const r1 = await (handoffSvc.handoffToAdmin as any)(opts);
    const m1 = metaOf("i1");
    assert(m1?.status === "handoff" && m1?.assigned_to === "admin-1",
      `commit must persist despite settle crash — meta=${JSON.stringify(m1)}`);
    assert(r1?.persisted === true && r1?.state === "assigned" && r1?.emit_incomplete === true,
      `committed ownership + emit-incomplete signal — got ${JSON.stringify(r1)}`);
    // retry — same transition must converge missing close-history/audit exactly once
    const r2 = await (handoffSvc.handoffToAdmin as any)(opts);
    clearHooks();
    assert(r2?.state === "assigned" && r2.persisted === true,
      `retry must converge — got ${JSON.stringify(r2)}`);
    const hr = closeHistOf("i1")[0];
    assert(hr?.reopened_at instanceof Date,
      `retry must settle the missing close-history stamp — got ${JSON.stringify(hr)}`);
    assert(logsOf("i1", "conversation.open").length === 1
      && logsOf("i1", "chat_assigned").length === 1
      && logsOf("i1", "conversation.handoff").length === 1,
      `settle must be exactly-once across retry — open=${logsOf("i1", "conversation.open").length} assigned=${logsOf("i1", "chat_assigned").length} handoff=${logsOf("i1", "conversation.handoff").length}`);
  });

  await test("I2 commit + conversation.handoff audit throws → retry settles audit only (no dup chat_assigned)", async () => {
    seedConv("i2"); seedShop(); seedAdmin("admin-1");
    insertErrorOnce("conversation.handoff");
    const opts = { conversationId: "i2", shopId: "shop-1", platform: "shopee" };
    const r1 = await (handoffSvc.handoffToAdmin as any)(opts);
    assert(metaOf("i2")?.assigned_to === "admin-1",
      "commit must persist despite audit crash");
    assert(r1?.persisted === true && r1?.state === "assigned" && r1?.emit_incomplete === true,
      `committed assignment + emit-incomplete signal — got ${JSON.stringify(r1)}`);
    const r2 = await (handoffSvc.handoffToAdmin as any)(opts);
    clearHooks();
    assert(r2?.state === "assigned", `retry must converge — got ${JSON.stringify(r2)}`);
    assert(logsOf("i2", "chat_assigned").length === 1,
      `chat_assigned must not duplicate on retry — got ${logsOf("i2", "chat_assigned").length}`);
    assert(logsOf("i2", "conversation.handoff").length === 1,
      `missing handoff audit must be settled by retry — got ${logsOf("i2", "conversation.handoff").length}`);
  });

  await test("I4 workflow auto + handoff commit throws → no handoff surfaced; no success audit", async () => {
    (mocks.state as any).config.workflow_enabled = true;
    seedShop(); seedAdmin("admin-1");
    mocks.fakeColl("workflows").push({
      workflow_id: "wf-fail", name: "auto assign fail",
      shop_ids: ["shop-1"], platforms: ["shopee"],
      enabled: true, status: "published", is_deleted: false,
      trigger_frequency: "every_time", priority: 1, created_at: new Date(),
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: { keywords: ["สวัสดี"] } },
        { node_id: "a1", type: "action", subtype: "assign_ticket", config: { reason: "wf-fail" } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }],
    });
    seedConv("i4");
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation") throw new Error("simulated commit failure");
    };
    const res = await wf.matchAndRun({
      message_id: "m-i4", conversation_id: "i4", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    clearHooks();
    assert(res.handoff === undefined,
      `failed outcome must not surface a handoff for downstream handed_off — got ${JSON.stringify(res.handoff)}`);
    const wfAudit = logsOf("i4", "workflow.assign_ticket");
    assert(!wfAudit.some((d: any) => d.metadata?.assigned_to || d.metadata?.outcome_state === "assigned"),
      `no success-shaped workflow audit — got ${JSON.stringify(wfAudit)}`);
    assert(!metaOf("i4")?.assigned_to,
      "no owner may persist on failed handoff");
  });

  await test("I5 workflow auto + no admin → handoff{state:queued,agentId:null} distinguishable from assigned", async () => {
    (mocks.state as any).config.workflow_enabled = true;
    seedShop();
    mocks.fakeColl("workflows").push({
      workflow_id: "wf-queued", name: "auto assign queued",
      shop_ids: ["shop-1"], platforms: ["shopee"],
      enabled: true, status: "published", is_deleted: false,
      trigger_frequency: "every_time", priority: 1, created_at: new Date(),
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: { keywords: ["สวัสดี"] } },
        { node_id: "a1", type: "action", subtype: "assign_ticket", config: { reason: "wf-queued" } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }],
    });
    seedConv("i5");
    const res = await wf.matchAndRun({
      message_id: "m-i5", conversation_id: "i5", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    assert(res.handoff?.state === "queued" && res.handoff.agentId === null,
      `queued must surface as typed queued (durable, bot stops) — got ${JSON.stringify(res.handoff)}`);
    const m = metaOf("i5");
    assert(m?.status === "handoff" && m?.pending_assignment === true && m?.assigned_to === null,
      `durable queued = handoff + pending + no owner — got ${JSON.stringify(m)}`);
  });

  await test("I6 workflow direct admin_id → typed assigned via same persisted owner", async () => {
    (mocks.state as any).config.workflow_enabled = true;
    seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    mocks.fakeColl("workflows").push({
      workflow_id: "wf-direct", name: "direct assign",
      shop_ids: ["shop-1"], platforms: ["shopee"],
      enabled: true, status: "published", is_deleted: false,
      trigger_frequency: "every_time", priority: 1, created_at: new Date(),
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: { keywords: ["สวัสดี"] } },
        { node_id: "a1", type: "action", subtype: "assign_ticket", config: { admin_id: "admin-2", reason: "wf-direct" } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }],
    });
    seedConv("i6");
    const res = await wf.matchAndRun({
      message_id: "m-i6", conversation_id: "i6", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    assert(res.handoff?.state === "assigned" && res.handoff.agentId === "admin-2",
      `direct assign must return typed outcome — got ${JSON.stringify(res.handoff)}`);
    const m = metaOf("i6");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-2" && m?.pending_assignment === false,
      `direct assign must persist via same commit — got ${JSON.stringify(m)}`);
  });

  await test("I7 workflow direct CAS-loser → returns persisted winner (not stale pre-race meta)", async () => {
    (mocks.state as any).config.workflow_enabled = true;
    seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-9");
    mocks.fakeColl("workflows").push({
      workflow_id: "wf-race", name: "direct assign race",
      shop_ids: ["shop-1"], platforms: ["shopee"],
      enabled: true, status: "published", is_deleted: false,
      trigger_frequency: "every_time", priority: 1, created_at: new Date(),
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: { keywords: ["สวัสดี"] } },
        { node_id: "a1", type: "action", subtype: "assign_ticket", config: { admin_id: "admin-2", reason: "wf-race" } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }],
    });
    seedConv("i7");
    // meta read says owner admin-1 → CAS wants admin-2; winner admin-9 lands between read and CAS
    seedMeta("i7", { status: "handoff", assigned_to: "admin-1", assigned_at: new Date("2026-10-01") });
    let landed = false;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !landed) {
        landed = true;
        const d = metaOf("i7");
        if (d) { d.assigned_to = "admin-9"; d.assigned_at = new Date(); }
      }
    };
    const res = await wf.matchAndRun({
      message_id: "m-i7", conversation_id: "i7", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    clearHooks();
    assert(res.handoff?.agentId === "admin-9",
      `CAS loser must report the persisted winner, not stale meta — got ${JSON.stringify(res.handoff)}`);
    assert(metaOf("i7")?.assigned_to === "admin-9",
      "winner must not be clobbered");
  });

  await test("I9 raw exception → sanitized outcome.reason/error_code; API + stdout clean", async () => {
    seedConv("i9"); seedShop(); seedAdmin("admin-1");
    const RAW = "mongodb://admin:secret-pw@db.internal.corp:27017/chat\nquery: { assigned_to: 1 }";
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation") throw new Error(RAW);
    };
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "i9", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "failed" && r.persisted === false,
      `commit failure stays typed failed — got ${JSON.stringify(r)}`);
    assert(typeof r.error_code === "string" && r.error_code.length > 0,
      `stable error_code required — got ${JSON.stringify(r)}`);
    for (const leak of ["mongodb://", "secret-pw", "db.internal", "assigned_to", "\n"]) {
      assert(!String(r.reason ?? "").includes(leak),
        `outcome.reason must not expose raw error text (${leak}) — got ${JSON.stringify(r)}`);
    }
    // route level: response body + stdout must not leak either
    const { NextRequest } = await import("next/server");
    const seen: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
    try {
      const req = new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
        body: JSON.stringify({ conversation_id: "i9b" }),
      });
      seedConv("i9b");
      const res = await (botHandoffRoute as any).POST(req);
      const j = await res.json();
      for (const leak of ["mongodb://", "secret-pw", "db.internal"]) {
        assert(!JSON.stringify(j).includes(leak), `API response leaked ${leak}`);
        assert(!seen.join(" ").includes(leak), `stdout leaked ${leak}`);
      }
    } finally {
      console.log = origLog;
      clearHooks();
    }
  });

  // ═══ J. architecture correction — single-phase ownership + reservation-order round-robin ═══
  // Contract ที่ตัดสินแล้ว (PART 2 gate — audit ยืนยันไม่มี caller ใดเป็น guaranteed
  // repair owner ของ pending-settlement phase):
  //   1. ownership CAS = durable phase เดียวที่ระบบ guarantee — ไม่มี pending-settlement phase
  //      side effects = eid-idempotent emissions: emit หลัง commit + re-emit ทุก converge
  //      (dedupe = free repair — ไม่มี marker ที่ต้องหา owner มาซ่อม)
  //   2. outcome = ownership truth เท่านั้น — ไม่มี settled field อ้าง side-effect completion
  //   3. round-robin = reservation-order: selection atomically claim ตำแหน่งบน cursor doc
  //      (unique index เดิม) — commit miss → position forfeit (bounded skip, business contract)
  //   4. ไม่มี cursor write หลัง commit → delayed emit ไม่มีทาง rewind cursor
  //   5. legacy/dead ownership paths ถูกลบ — writer เดียวต่อ transition kind

  const cursorOps = () =>
    mocks.state.queryLog.filter((q: any) =>
      q.coll === "assignment_cursors"
      && (q.op === "updateOne" || q.op === "findOneAndUpdate" || q.op === "insertOne"));

  await test("J1 emit crash post-commit → outcome = ownership truth only (no settled); converge re-emit repairs exactly once", async () => {
    seedConv("j1"); seedShop(); seedAdmin("admin-1");
    seedMeta("j1", { status: "closed", closed_at: new Date("2026-10-01"), closed_by: "admin-9", assigned_to: null });
    mocks.fakeColl("close_history").push({
      record_id: "chr-j1", conversation_id: "j1", shop_id: "shop-1",
      customer_id: "cust-j1", closed_by: "admin-9", closed_at: new Date("2026-10-01"),
      reason: "done", category: "other", resolution: "answered", sequence: 1,
    });
    insertErrorOnce("conversation.open");
    const opts = { conversationId: "j1", shopId: "shop-1", platform: "shopee" };
    const r1 = await (handoffSvc.handoffToAdmin as any)(opts);
    assert(r1?.state === "assigned" && r1.persisted === true && !("settled" in r1)
      && r1?.emit_incomplete === true,
      `outcome = ownership truth + emit-incomplete signal — got ${JSON.stringify(r1)}`);
    const m1 = metaOf("j1");
    assert(m1?.status === "handoff" && m1?.assigned_to === "admin-1"
      && !("handoff_settled" in m1) && !("handoff_rr_pool_key" in m1),
      `ห้ามมี pending-settlement fields บน doc — ${JSON.stringify(m1)}`);
    const r2 = await (handoffSvc.handoffToAdmin as any)(opts);
    clearHooks();
    assert(r2?.state === "assigned" && r2.persisted === true,
      `converge ต้องคืน ownership truth เดิม — got ${JSON.stringify(r2)}`);
    const hr = closeHistOf("j1")[0];
    assert(hr?.reopened_at instanceof Date,
      `converge ต้อง emit close-history stamp ที่ขาด — got ${JSON.stringify(hr)}`);
    assert(logsOf("j1", "conversation.open").length === 1
      && logsOf("j1", "chat_assigned").length === 1
      && logsOf("j1", "conversation.handoff").length === 1,
      `converge-emit ต้องเป็น exactly-once — open=${logsOf("j1", "conversation.open").length} assigned=${logsOf("j1", "chat_assigned").length} handoff=${logsOf("j1", "conversation.handoff").length}`);
  });

  await test("J2 bot-handoff route + audit emit throws → 503 retryable + ownership truth kept; retry converges emit", async () => {
    seedConv("j2"); seedShop(); seedAdmin("admin-1");
    insertErrorOnce("chat_assigned");
    const { NextRequest } = await import("next/server");
    const mkReq = () => new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({ conversation_id: "j2" }),
    });
    const res = await (botHandoffRoute as any).POST(mkReq());
    const j = await res.json();
    assert(res.status === 503 && j?.ok === false
      && j?.outcome?.state === "assigned" && j?.outcome?.persisted === true
      && j?.outcome?.emit_incomplete === true,
      `emit-incomplete ต้องเป็น retryable non-2xx (ownership truth ไม่ย้อน) — status=${res.status} body=${JSON.stringify(j)}`);
    assert(!("settled" in (j?.outcome ?? {})),
      `ห้ามมี settled ใน outcome — body=${JSON.stringify(j)}`);
    assert(!("handoff_settled" in (metaOf("j2") ?? {})),
      "ห้ามมี pending-settlement marker บน doc");
    // retry request เดิม → converge owner เดิม + re-emit ด้วย eid เดิม → 200
    const res2 = await (botHandoffRoute as any).POST(mkReq());
    clearHooks();
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.emit_incomplete === false,
      `retry ต้อง converge+emit สำเร็จ — status=${res2.status} body=${JSON.stringify(j2)}`);
    assert(logsOf("j2", "chat_assigned").length === 1
      && logsOf("j2", "conversation.handoff").length === 1,
      "re-emit ต้อง exactly-once ด้วย eid เดิม");
  });

  await test("J3 converge บน committed-but-never-emitted transition → emit audits ซ่อม exactly once (caller ใดก็ซ่อมได้)", async () => {
    seedConv("j3"); seedShop(); seedAdmin("admin-1");
    // จำลอง crash-หลัง-commit: doc committed (owner + eid) แต่ audits ไม่เคยถูก emit
    seedMeta("j3", {
      status: "handoff", assigned_to: "admin-1", assigned_at: new Date(),
      assignment_mode_used: "equal_global", handoff_event_id: "eid-j3", handoff_reopened: false,
    });
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "j3", shopId: "shop-1", platform: "shopee",
    });
    assert(r?.state === "assigned" && r.assigned_to === "admin-1",
      `converge ต้องคืน persisted owner — got ${JSON.stringify(r)}`);
    assert(logsOf("j3", "chat_assigned").length === 1
      && logsOf("j3", "conversation.handoff").length === 1,
      `converge ต้อง emit audits ของ transition ที่ยังไม่ได้ emit — assigned=${logsOf("j3", "chat_assigned").length} handoff=${logsOf("j3", "conversation.handoff").length}`);
    // call ซ้ำ → dedupe — ยัง exactly-once
    await (handoffSvc.handoffToAdmin as any)({ conversationId: "j3", shopId: "shop-1", platform: "shopee" });
    assert(logsOf("j3", "chat_assigned").length === 1
      && logsOf("j3", "conversation.handoff").length === 1,
      "re-emit ต้อง dedupe ด้วย eid เดิม — ห้ามเขียน audit ซ้ำ");
  });

  await test("J4 [source pin] pending-settlement + parallel cursor/ownership paths ถูกลบ — เหลือ owner เดียวต่อ transition kind", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    const hs = read("../src/backend/service/handoffService.ts");
    const as_ = read("../src/backend/service/assignmentService.ts");
    const ss = read("../src/backend/service/statusConversationService.ts");
    for (const gone of ["settleHandoffTransition", "markHandoffSettled", "handoff_settled",
      "handoff_rr_pool_key", "markCursorAssigned", "pickNextAgent", "peekNextAgent"]) {
      assert(!hs.includes(gone) && !as_.includes(gone) && !ss.includes(gone),
        `${gone} ต้องถูกลบออกจาก runtime sources`);
    }
    assert(!/\bsettled\b/.test(hs), "outcome ห้ามมี settled field");
    assert(as_.includes("reserveNextAgent"), "reservation-order cursor owner required");
    for (const gone of ["tryAssign", "autoAssignConversation", "setPendingAssignment"]) {
      assert(!ss.includes(`export async function ${gone}`)
        && !as_.includes(`export async function ${gone}`),
        `${gone} = dead parallel ownership path — ต้องถูกลบ`);
    }
  });

  await test("J5 multi-conv concurrent → reservation serializes → conv ละคน ตามลำดับตำแหน่ง", async () => {
    seedConv("j5x"); seedConv("j5y"); seedShop();
    seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-3");
    // interleave: Y รันเต็มรอบอยู่ระหว่าง X's reserve → commit window
    let fired = false;
    let inner: any = null;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !fired) {
        fired = true;
        inner = await (handoffSvc.handoffToAdmin as any)({
          conversationId: "j5y", shopId: "shop-1", platform: "shopee",
        });
      }
    };
    const outer = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "j5x", shopId: "shop-1", platform: "shopee",
    });
    clearHooks();
    const mx = metaOf("j5x"); const my = metaOf("j5y");
    assert(mx?.assigned_to && my?.assigned_to && mx.assigned_to !== my.assigned_to,
      `conversations พร้อมกันห้ามได้ admin คนเดียวกัน — x=${mx?.assigned_to} y=${my?.assigned_to}`);
    assert(outer?.assigned_to === mx?.assigned_to && inner?.assigned_to === my?.assigned_to,
      `outcome ต้องตรง persisted owner — outer=${JSON.stringify(outer)} inner=${JSON.stringify(inner)}`);
  });

  await test("J6 reserve แล้ว commit แพ้ → position ถูก consume (forfeit) — rotation เดินต่อไม่ rollback", async () => {
    seedConv("j6"); seedShop();
    seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-9");
    // winner admin-9 ลงระหว่าง reserve → commit ของ X
    let landed = false;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !landed) {
        landed = true;
        const d = metaOf("j6");
        if (d) { d.status = "handoff"; d.assigned_to = "admin-9"; d.assigned_at = new Date(); }
        else seedMeta("j6", { status: "handoff", assigned_to: "admin-9", assigned_at: new Date() });
      }
    };
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "j6", shopId: "shop-1", platform: "shopee",
    });
    clearHooks();
    assert(r?.state === "assigned" && r.assigned_to === "admin-9",
      `commit แพ้ต้อง converge ไปที่ผู้ชนะ — got ${JSON.stringify(r)}`);
    const cursor = mocks.fakeColl("assignment_cursors").find((d: any) => d.pool_key === "global:ticket");
    assert(cursor?.last_assigned_admin_id === "admin-1",
      `reservation consume ณ เวลา claim — commit miss = forfeit (bounded skip, contract) — cursor=${JSON.stringify(cursor)}`);
    seedConv("j6z");
    const rz = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "j6z", shopId: "shop-1", platform: "shopee",
    });
    assert(rz?.assigned_to === "admin-2",
      `rotation ต้องเดินต่อหลัง forfeited position — got ${JSON.stringify(rz)}`);
  });

  await test("J7 same-conv duplicate concurrent → 1 commit; reservation สูงสุด 2 ตำแหน่ง (bounded forfeit); rotation ต่อ", async () => {
    seedConv("j7"); seedShop();
    seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-3");
    const opts = { conversationId: "j7", shopId: "shop-1", platform: "shopee" };
    let fired = false;
    let inner: any = null;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !fired) {
        fired = true;
        inner = await (handoffSvc.handoffToAdmin as any)(opts);
      }
    };
    const outer = await (handoffSvc.handoffToAdmin as any)(opts);
    clearHooks();
    const m = metaOf("j7");
    assert(m?.assigned_to && outer?.assigned_to === m.assigned_to
      && inner?.assigned_to === m.assigned_to,
      `ownership transition เดียว — loser converge เป็นผู้ชนะ — outer=${JSON.stringify(outer)} inner=${JSON.stringify(inner)} meta=${JSON.stringify(m)}`);
    const ops = cursorOps();
    assert(ops.length >= 1 && ops.length <= 2,
      `duplicate pair consume อย่างมาก 2 reservation (1 committed + ≤1 forfeit) — ops=${ops.length}`);
    seedConv("j7z");
    const rz = await (handoffSvc.handoffToAdmin as any)({ ...opts, conversationId: "j7z" });
    assert(rz?.assigned_to === "admin-3",
      `rotation ต้องเดินต่อหลัง reservation ทั้งสอง — got ${JSON.stringify(rz)}`);
  });

  await test("J8 commit order ≠ reservation order → cursor = last reservation (no rewind)", async () => {
    seedConv("j8x"); seedConv("j8y"); seedShop();
    seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-3");
    // X reserve ก่อน แต่ commit หลัง Y: X(admin-1) → Y(admin-2) commit ก่อน → X commit ทีหลัง
    let innerDone = false;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !innerDone) {
        innerDone = true;
        await (handoffSvc.handoffToAdmin as any)({
          conversationId: "j8y", shopId: "shop-1", platform: "shopee",
        });
      }
    };
    await (handoffSvc.handoffToAdmin as any)({
      conversationId: "j8x", shopId: "shop-1", platform: "shopee",
    });
    clearHooks();
    const cursor = mocks.fakeColl("assignment_cursors").find((d: any) => d.pool_key === "global:ticket");
    seedConv("j8z");
    const rz = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "j8z", shopId: "shop-1", platform: "shopee",
    });
    assert(rz?.assigned_to === "admin-3",
      `cursor ต้องอยู่ที่ reservation ล่าสุด (admin-2) — ห้าม rewind จาก commit ที่ช้ากว่า — next=${JSON.stringify(rz)} cursor=${JSON.stringify(cursor)}`);
  });

  await test("J9 workflow assign + audit emit throws → truthful assigned; ไม่มี pending-settlement marker ทิ้งไว้", async () => {
    (mocks.state as any).config.workflow_enabled = true;
    seedShop(); seedAdmin("admin-1");
    mocks.fakeColl("workflows").push({
      workflow_id: "wf-emit", name: "emit crash",
      shop_ids: ["shop-1"], platforms: ["shopee"],
      enabled: true, status: "published", is_deleted: false,
      trigger_frequency: "every_time", priority: 1, created_at: new Date(),
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: { keywords: ["สวัสดี"] } },
        { node_id: "a1", type: "action", subtype: "assign_ticket", config: { reason: "wf-emit" } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }],
    });
    seedConv("j9");
    insertErrorOnce("chat_assigned");
    const res = await wf.matchAndRun({
      message_id: "m-j9", conversation_id: "j9", shop_id: "shop-1", config_shop_key: "shop-1",
      platform: "shopee", text: "สวัสดีครับ",
    });
    clearHooks();
    assert(res.handoff?.state === "assigned" && res.handoff.agentId === "admin-1",
      `committed ownership ต้อง surface ตรงๆ — got ${JSON.stringify(res.handoff)}`);
    const m = metaOf("j9");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1"
      && !("handoff_settled" in m) && !("handoff_rr_pool_key" in m),
      `workflow ห้ามทิ้ง pending-settlement marker — ${JSON.stringify(m)}`);
    // audit gap ซ่อมได้ด้วย call ใดๆ ของ conv นั้น (converge-emit — dedupe ด้วย eid เดิม)
    await (handoffSvc.handoffToAdmin as any)({
      conversationId: "j9", shopId: "shop-1", platform: "shopee",
    });
    assert(logsOf("j9", "chat_assigned").length === 1,
      `audit ที่ขาดต้องถูกซ่อมด้วย converge-emit — got ${logsOf("j9", "chat_assigned").length}`);
  });

  // ═══ K. Final Root-Cause — selection typing + HTTP contract + emit signal ═══
  // Contract:
  //   - selection แยก 3 ชนิด: reserved / no_eligible_agent / contention
  //   - contention = retryable failure — ห้าม persist queued/no_available_admin (โกหก)
  //   - route: assigned/queued persisted → 2xx เท่านั้น; failed → non-2xx ตาม
  //     error_code (contention/5xx-like → 503 retryable, not_found → 404);
  //     emit_incomplete → 503 retryable (ownership truth ไม่ย้อน)
  //   - test/simulate path ส่ง outcome เดียวกัน (uniform typed truth สำหรับ Python)

  // rival claimant ชนะ cursor race ทุก attempt — mutation จริงบน doc →
  // filter last:observed miss ของจริง (ไม่ใช่ return-value forgery)
  //   ⚠️ sentinel ต้องไม่เท่า observed เสมอ — เซ็ตเป็น admin ใน pool อาจชน observed
  //   แล้ว CAS ผ่าน (miss ปลอม) → ใช้ค่านอก pool ที่เปลี่ยนทุกครั้งแทน
  const forceCursorMiss = (limit = 99) => {
    let n = 0;
    (mocks.state as any).updateOneHook = async (coll: string) => {
      if (coll === "assignment_cursors" && n < limit) {
        n++;
        const cur = mocks.fakeColl("assignment_cursors")[0];
        if (cur) cur.last_assigned_admin_id = `__rival_claim_${n}`;
      }
    };
  };
  const seedCursor = (last: string, poolKey = "global:ticket") =>
    mocks.fakeColl("assignment_cursors").push({
      pool_key: poolKey, last_assigned_admin_id: last, updated_at: new Date(),
    });

  await test("K1 reserveNextAgent typing — reserved / no_eligible_agent / contention", async () => {
    const empty = await (assignSvc as any).reserveNextAgent("global:k1-empty", []);
    assert(empty?.result === "no_eligible_agent",
      `pool ว่าง → no_eligible_agent — got ${JSON.stringify(empty)}`);
    seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-3");
    seedCursor("admin-3", "global:k1");
    const r = await (assignSvc as any).reserveNextAgent("global:k1", ["admin-1", "admin-2", "admin-3"]);
    assert(r?.result === "reserved" && r?.agentId === "admin-1",
      `claim สำเร็จ → reserved — got ${JSON.stringify(r)}`);
    forceCursorMiss();
    const c = await (assignSvc as any).reserveNextAgent("global:k1", ["admin-1", "admin-2", "admin-3"]);
    clearHooks();
    assert(c?.result === "contention",
      `CAS miss ครบ cap + eligible admins มี → contention ห้ามเป็น no_eligible — got ${JSON.stringify(c)}`);
  });

  await test("K2 selectNextAgent propagate outcome — contention ไม่ใช่ agentId:null เฉยๆ", async () => {
    seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2");
    forceCursorMiss();
    const sel = await (assignSvc as any).selectNextAgent({ shop_id: "shop-1", platform: "shopee" }, "ticket");
    clearHooks();
    assert(sel?.result === "contention",
      `selectNextAgent ต้อง surface contention — got ${JSON.stringify(sel)}`);
  });

  await test("K3 contention ครบ cap → failed{reservation_contention}; ห้าม persist queued/no_available_admin", async () => {
    seedConv("k3"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-3");
    seedCursor("admin-3");
    forceCursorMiss();
    const r = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "k3", shopId: "shop-1", platform: "shopee",
    });
    clearHooks();
    assert(r?.state === "failed" && r?.error_code === "reservation_contention",
      `contention = retryable failure — got ${JSON.stringify(r)}`);
    const m = metaOf("k3");
    assert(!m || (m.pending_assignment !== true && !m.assigned_to),
      `ห้าม persist queued/false pending จาก contention — meta=${JSON.stringify(m)}`);
  });

  await test("K4 >3 contenders: winner assigned / losers retryable-failed — แยกประเภทถูก ไม่มี queued", async () => {
    seedConv("k4x"); seedConv("k4y"); seedShop();
    seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-3");
    seedCursor("admin-3");
    // X loses every race (rival winner ทุก attempt) → retryable contention
    forceCursorMiss(3);
    const rx = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "k4x", shopId: "shop-1", platform: "shopee",
    });
    clearHooks();
    // Y claims normally → assigned
    const ry = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "k4y", shopId: "shop-1", platform: "shopee",
    });
    assert(rx?.state === "failed" && rx?.error_code === "reservation_contention",
      `contention loser → retryable failed — got ${JSON.stringify(rx)}`);
    assert(ry?.state === "assigned" && ry?.assigned_to,
      `winner → assigned — got ${JSON.stringify(ry)}`);
    const mx = metaOf("k4x");
    assert(!mx || mx.pending_assignment !== true,
      `contention loser ห้ามกลายเป็น pending_assignment — meta=${JSON.stringify(mx)}`);
  });

  await test("K5 real cursor-CAS interleave (2 rivals claim ระหว่าง outer's reserve→commit) → 3 convs ได้ admin คนละคน ไม่มี queued/failed", async () => {
    seedConv("k5-0"); seedConv("k5-1"); seedConv("k5-2"); seedShop();
    seedAdmin("admin-1"); seedAdmin("admin-2"); seedAdmin("admin-3");
    seedCursor("admin-3");
    let fired = 0;
    const inners: any[] = [];
    // hook บน cursor claim ของ caller ใดก็ได้ — rival จริง 2 คนยิง claim+commit เต็มรอบ
    //   (genuine interleave: inner ทำ reserve→commit จริงก่อน outer's write execute)
    (mocks.state as any).updateOneHook = async (coll: string) => {
      if (coll === "assignment_cursors" && fired < 2) {
        fired++;
        inners.push(await (handoffSvc.handoffToAdmin as any)({
          conversationId: `k5-${fired}`, shopId: "shop-1", platform: "shopee",
        }));
      }
    };
    const outer = await (handoffSvc.handoffToAdmin as any)({
      conversationId: "k5-0", shopId: "shop-1", platform: "shopee",
    });
    clearHooks();
    assert(fired === 2, `rival ต้องชนกันที่ cursor CAS จริง — fired=${fired}`);
    const owners = new Set([outer, ...inners].map((r: any) => r?.assigned_to));
    assert(owners.size === 3 && outer?.state === "assigned"
      && inners.every((r: any) => r?.state === "assigned"),
      `ทุก conv ต้อง assigned คนละ admin — outer=${JSON.stringify(outer)} inners=${JSON.stringify(inners)}`);
  });

  await test("K6 bot-handoff route + contention → non-2xx retryable (503) + ok:false; ไม่มี pending write", async () => {
    seedConv("k6"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2");
    forceCursorMiss();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({ conversation_id: "k6" }),
    });
    const res = await (botHandoffRoute as any).POST(req);
    clearHooks();
    const j = await res.json();
    assert(res.status === 503 && j?.ok === false && j?.outcome?.state === "failed"
      && j?.outcome?.error_code === "reservation_contention",
      `contention → 503 retryable — status=${res.status} body=${JSON.stringify(j)}`);
    const m = metaOf("k6");
    assert(!m || m.pending_assignment !== true,
      `ห้าม persist false pending — meta=${JSON.stringify(m)}`);
  });

  await test("K7 bot-handoff route + internal throw → non-2xx retryable (503) + sanitized body", async () => {
    seedConv("k7"); seedShop(); seedAdmin("admin-1");
    (mocks.state as any).findOneHook = async (coll: string) => {
      if (coll === "status_conversation") {
        throw new Error("mongodb://admin:secret-pw@db.internal.corp assigned_to\nquery failed");
      }
    };
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({ conversation_id: "k7" }),
    });
    const res = await (botHandoffRoute as any).POST(req);
    clearHooks();
    const j = await res.json();
    const bodyStr = JSON.stringify(j);
    assert(res.status === 503 && j?.ok === false && j?.outcome?.state === "failed",
      `internal failure → 503 retryable — status=${res.status} body=${bodyStr}`);
    for (const leak of ["mongodb://", "secret-pw", "db.internal", "\n"]) {
      assert(!bodyStr.includes(leak), `response ห้าม leak '${leak}' — body=${bodyStr}`);
    }
  });

  await test("K8 admin assign route + emit throws → non-2xx retryable (503); retry converges emit", async () => {
    seedConv("k8"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedAdmin("lead-1", { role: "lead" });
    insertErrorOnce("chat_assigned");
    const { NextRequest } = await import("next/server");
    const mkReq = () => authReq("lead-1", "http://localhost/api/admin/conversations/k8/assign", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ admin_id: "admin-1" }),
    });
    const res = await (assignRoute as any).POST(await mkReq(), paramsOf("k8"));
    const j = await res.json();
    assert(res.status === 503,
      `assign route emit-incomplete → 503 retryable — status=${res.status} body=${JSON.stringify(j)}`);
    const res2 = await (assignRoute as any).POST(await mkReq(), paramsOf("k8"));
    clearHooks();
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.ok === true,
      `retry converge+emit → 200 — status=${res2.status} body=${JSON.stringify(j2)}`);
    assert(logsOf("k8", "chat_assigned").length === 1,
      "re-emit ต้อง exactly-once");
  });

  await test("K9 bot-handoff queued (pool ว่างจริง) → 200 + outcome.state=queued (contract pin)", async () => {
    seedConv("k9"); seedShop();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({ conversation_id: "k9" }),
    });
    const res = await (botHandoffRoute as any).POST(req);
    const j = await res.json();
    assert(res.status === 200 && j?.outcome?.state === "queued"
      && metaOf("k9")?.pending_assignment === true,
      `queued persisted → 200 — status=${res.status} body=${JSON.stringify(j)}`);
  });

  await test("K10 test_source path มี outcome เดียวกัน; contention → failed + non-2xx (503); ไม่มี pending_assignment โกหก", async () => {
    seedConv("k10"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2", "global:botworker");
    forceCursorMiss();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({ conversation_id: "k10", test_source: "botworker" }),
    });
    const res = await (botHandoffRoute as any).POST(req);
    clearHooks();
    const j = await res.json();
    assert(res.status === 503 && j?.outcome?.state === "failed",
      `test_source contention → 503 + outcome.failed — status=${res.status} body=${JSON.stringify(j)}`);
    const tdoc = mocks.fakeColl("test_status_conversation")
      .find((d: any) => d.conversation_id === "k10");
    assert(!tdoc || tdoc.pending_assignment !== true,
      `test path ห้าม persist false pending — doc=${JSON.stringify(tdoc)}`);
  });

  await test("K11 handoffToAdminTest contention → in_flight result (retryable) ไม่ใช่ no_available_admin", async () => {
    seedConv("k11"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2", "global:test_chat");
    forceCursorMiss();
    const r = await (handoffSvc.handoffToAdminTest as any)({
      conversationId: "k11", shopId: "shop-1", platform: "shopee",
      reason: "k11", source: "test_chat",
    });
    clearHooks();
    assert(r?.in_flight === true,
      `contention ใน test path → in_flight (retryable) — got ${JSON.stringify(r)}`);
    const tdoc = mocks.fakeColl("test_status_conversation")
      .find((d: any) => d.conversation_id === "k11");
    assert(!tdoc || tdoc.pending_assignment !== true,
      `ห้าม persist false pending จาก contention — doc=${JSON.stringify(tdoc)}`);
  });

  await test("K12 test_source in_flight → 503 + zero success side-effects (claim/log/audit) — retry converges exactly once", async () => {
    seedConv("k12"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2", "global:botworker");
    forceCursorMiss();
    const { NextRequest } = await import("next/server");
    const mkReq = () => new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({
        conversation_id: "k12", test_source: "botworker",
        reason: "warranty_claim", claim: { customer_name: "ลูกค้า K12" },
      }),
    });
    const res = await (botHandoffRoute as any).POST(mkReq());
    clearHooks();
    const j = await res.json();
    assert(res.status === 503 && j?.ok === false && j?.outcome?.state === "failed",
      `in_flight → 503 failed — status=${res.status} body=${JSON.stringify(j)}`);
    const tdoc = mocks.fakeColl("test_status_conversation")
      .find((d: any) => d.conversation_id === "k12");
    assert(!tdoc?.bot_claim_info,
      `failed outcome ห้ามเขียน claim metadata ก่อน classify — doc=${JSON.stringify(tdoc)}`);
    const evts = mocks.fakeColl("botworker_events")
      .filter((d: any) => d.conversation_id === "k12" && d.type === "bot_handoff");
    assert(evts.length === 0,
      `failed outcome ห้ามเขียน bot_handoff success audit — events=${JSON.stringify(evts)}`);
    // retry สำเร็จภายหลัง → side effects ครบครั้งเดียว (single emission point)
    const res2 = await (botHandoffRoute as any).POST(mkReq());
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.state === "assigned",
      `retry → assigned 200 — status=${res2.status} body=${JSON.stringify(j2)}`);
    const tdoc2 = mocks.fakeColl("test_status_conversation")
      .find((d: any) => d.conversation_id === "k12");
    const evts2 = mocks.fakeColl("botworker_events")
      .filter((d: any) => d.conversation_id === "k12" && d.type === "bot_handoff");
    assert(tdoc2?.bot_claim_info?.customer_name === "ลูกค้า K12" && evts2.length === 1,
      `retry success → claim+audit exactly once — claim=${JSON.stringify(tdoc2?.bot_claim_info)} events=${evts2.length}`);
  });

  await test("K13 simulate in_flight → 503 + zero claim write (same ordering bug, same owner)", async () => {
    seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2", "global:test_chat");
    forceCursorMiss();
    const oid = new ObjectId();
    mocks.fakeColl("test_chat_sessions").push({ _id: oid, status: "open" });
    const convId = oid.toHexString();
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({
        conversation_id: convId, simulate: true,
        claim: { customer_name: "ลูกค้า K13" },
      }),
    });
    const res = await (botHandoffRoute as any).POST(req);
    clearHooks();
    const j = await res.json();
    assert(res.status === 503 && j?.outcome?.state === "failed",
      `simulate in_flight → 503 failed — status=${res.status} body=${JSON.stringify(j)}`);
    const sess = mocks.fakeColl("test_chat_sessions").find((d: any) => d._id === oid);
    assert(!(sess as any)?.bot_claim_info,
      `failed outcome ห้ามเขียน claim metadata ก่อน classify — session=${JSON.stringify(sess)}`);
  });

  // ── L. production path outcome ordering (Finding 2 — same bug class as K12/K13) ──
  const mkProdReq = async (convId: string, extra: Record<string, unknown> = {}) => {
    const { NextRequest } = await import("next/server");
    return new NextRequest("http://localhost/api/admin/conversations/bot-handoff", {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": "verify-only-internal-nonsecret" },
      body: JSON.stringify({
        conversation_id: convId,
        reason: "warranty_claim",
        claim: { customer_name: `ลูกค้า ${convId}` },
        ...extra,
      }),
    });
  };

  await test("K14 production failed (contention) → 503 + zero claim/handoff metadata + zero route audit", async () => {
    seedConv("k14"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2");
    forceCursorMiss();
    const res = await (botHandoffRoute as any).POST(await mkProdReq("k14"));
    clearHooks();
    const j = await res.json();
    assert(res.status === 503 && j?.ok === false && j?.outcome?.state === "failed",
      `production failed → non-2xx — status=${res.status} body=${JSON.stringify(j)}`);
    const conv = mocks.fakeColl("conversations")
      .find((d: any) => d.conversation_id === "k14");
    const meta14 = metaOf("k14");
    assert(!conv?.bot_claim_info && !conv?.bot_handoff_at && !conv?.bot_handoff_reason
      && !meta14?.bot_claim_info && !meta14?.active_claim_episode_id,
      `failed outcome ห้ามเขียน claim metadata ทั้งบน dump/meta — conv=${JSON.stringify(conv)} meta=${JSON.stringify(meta14)}`);
    const routeLogs = mocks.fakeColl("admin_logs")
      .filter((d: any) => d.conversation_id === "k14");
    assert(routeLogs.length === 0,
      `failed outcome ห้ามมี audit จาก route — logs=${JSON.stringify(routeLogs)}`);
  });

  await test("K15 production assigned + claim → 200 + claim write = 1 query พอดี (measured)", async () => {
    seedConv("k15"); seedShop(); seedAdmin("admin-1");
    mocks.state.queryLog.length = 0;
    const res = await (botHandoffRoute as any).POST(await mkProdReq("k15"));
    const j = await res.json();
    assert(res.status === 200 && j?.ok === true && j?.outcome?.state === "assigned",
      `assigned → 200 — status=${res.status} body=${JSON.stringify(j)}`);
    // ⚡ 2B.6 — claim metadata ย้ายไป status_conversation (owner เดียว)
    const meta15 = metaOf("k15");
    assert(meta15?.bot_claim_info?.customer_name === "ลูกค้า k15"
      && meta15?.bot_handoff_at instanceof Date && meta15?.bot_handoff_reason === "warranty_claim",
      `assigned → claim metadata บน status_conversation — meta=${JSON.stringify(meta15)}`);
    const conv15 = mocks.fakeColl("conversations")
      .find((d: any) => d.conversation_id === "k15");
    assert(!conv15?.bot_claim_info && !conv15?.bot_handoff_at,
      `ห้ามเขียน claim ลง raw conversations อีก — doc=${JSON.stringify(conv15)}`);
    const writes = mocks.state.queryLog.filter((q: any) =>
      q.coll === "status_conversation" && q.op === "updateOne"
      && q.filter?.conversation_id === "k15");
    assert(writes.length === 1,
      `assigned request เดียว → claim metadata write ต้อง 1 query พอดี — writes=${writes.length}`);
  });

  await test("K16 production queued (pool ว่าง) + claim → 200 + claim metadata written", async () => {
    seedConv("k16"); seedShop();
    const res = await (botHandoffRoute as any).POST(await mkProdReq("k16"));
    const j = await res.json();
    assert(res.status === 200 && j?.outcome?.state === "queued",
      `queued → 200 — status=${res.status} body=${JSON.stringify(j)}`);
    const meta16 = metaOf("k16");
    assert(meta16?.bot_claim_info?.customer_name === "ลูกค้า k16",
      `queued persisted → claim metadata บน status_conversation — meta=${JSON.stringify(meta16)}`);
  });

  await test("K17 production emit_incomplete → 503 → retry converge 200 + audit once + claim ไม่เสีย", async () => {
    seedConv("k17"); seedShop(); seedAdmin("admin-1");
    insertErrorOnce("chat_assigned");
    const res = await (botHandoffRoute as any).POST(await mkProdReq("k17"));
    const j = await res.json();
    assert(res.status === 503 && j?.ok === false
      && j?.outcome?.state === "assigned" && j?.outcome?.persisted === true
      && j?.outcome?.emit_incomplete === true,
      `emit_incomplete → 503 + persisted truth — status=${res.status} body=${JSON.stringify(j)}`);
    const meta17 = metaOf("k17");
    assert(meta17?.bot_claim_info?.customer_name === "ลูกค้า k17",
      `ownership persisted แล้ว → claim metadata บน status_conversation — meta=${JSON.stringify(meta17)}`);
    const t1 = meta17?.bot_handoff_at;
    assert(t1 instanceof Date,
      `request แรกต้องตั้ง bot_handoff_at — meta=${JSON.stringify(meta17)}`);

    // ── retry payload เดิม (transport เห็น 503 → bounded retry) — converge owner เดิม
    await new Promise((r) => setTimeout(r, 10));
    mocks.state.queryLog.length = 0;
    const res2 = await (botHandoffRoute as any).POST(await mkProdReq("k17"));
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.ok === true
      && j2?.outcome?.state === "assigned" && j2?.outcome?.persisted === true
      && j2?.outcome?.emit_incomplete === false
      && j2?.outcome?.reason === "existing_assignment",
      `retry → converge 200 + emit สมบูรณ์ — status=${res2.status} body=${JSON.stringify(j2)}`);
    const meta17b = metaOf("k17");
    assert(meta17b?.bot_claim_info?.customer_name === "ลูกค้า k17"
      && meta17b?.bot_handoff_reason === "warranty_claim",
      `retry → claim fields ต้องไม่เสีย — meta=${JSON.stringify(meta17b)}`);
    assert(meta17b?.bot_handoff_at instanceof Date
      && meta17b.bot_handoff_at.getTime() >= t1.getTime(),
      `retry → bot_handoff_at เป็น Date (refresh ได้ — contract: last write time) — t1=${t1?.toISOString?.()} t2=${meta17b?.bot_handoff_at}`);
    // claim refresh ยังเขียนได้ (เติม claim ภายหลังไม่ถูกปิดกั้น) — 1 write/req
    const retryWrites = mocks.state.queryLog.filter((q: any) =>
      q.coll === "status_conversation" && q.op === "updateOne"
      && q.filter?.conversation_id === "k17");
    assert(retryWrites.length === 1,
      `retry → claim write ต้อง 1 query (refresh เดิม ไม่ใช่ parallel write) — writes=${retryWrites.length}`);
    // ownership/audit exactly-once: re-emit เติม audit ที่ขาดพอดี (eid dedupe)
    assert(logsOf("k17", "chat_assigned").length === 1
      && logsOf("k17", "conversation.handoff").length === 1,
      `retry ต้องเติม audit ที่ขาดพอดี — chat_assigned=${logsOf("k17", "chat_assigned").length} handoff=${logsOf("k17", "conversation.handoff").length}`);
  });

  await test("K18 production close→reopen→handoff ใหม่ → 200 + claim refresh + audit แยกต่อ transition", async () => {
    seedConv("k18"); seedShop(); seedAdmin("admin-1");
    const res1 = await (botHandoffRoute as any).POST(await mkProdReq("k18"));
    const j1 = await res1.json();
    assert(res1.status === 200 && j1?.outcome?.state === "assigned",
      `episode1 assigned → 200 — status=${res1.status} body=${JSON.stringify(j1)}`);
    const meta18a = metaOf("k18");
    const t1 = meta18a?.bot_handoff_at;
    assert(t1 instanceof Date,
      `episode1 ต้องตั้ง bot_handoff_at — meta=${JSON.stringify(meta18a)}`);

    // close (admin resolves) → reopen เป็น bot (ลูกค้าทักกลับ) — production owners จริง
    await statusSvc.closeConversation({
      conversationId: "k18", closedBy: "admin-1",
      reason: "done", category: "product", resolution: "answered",
    });
    await statusSvc.reopenConversation({
      conversationId: "k18", reopenedBy: "bot", targetStatus: "bot",
    });

    await new Promise((r) => setTimeout(r, 10));
    const res2 = await (botHandoffRoute as any).POST(await mkProdReq("k18"));
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.state === "assigned"
      && j2?.outcome?.persisted === true && j2?.outcome?.reason === "round_robin",
      `episode2 ต้องเป็น transition ใหม่ — status=${res2.status} body=${JSON.stringify(j2)}`);
    const meta18b = metaOf("k18");
    assert(meta18b?.bot_handoff_at instanceof Date
      && meta18b.bot_handoff_at.getTime() >= t1.getTime(),
      `handoff รอบใหม่ → bot_handoff_at เป็น Date (refresh ได้ — contract: last write time) — t1=${t1?.toISOString?.()} t2=${meta18b?.bot_handoff_at}`);
    assert(meta18b?.bot_claim_info?.customer_name === "ลูกค้า k18"
      && meta18b?.bot_handoff_reason === "warranty_claim",
      `episode2 → claim fields ของรอบใหม่ — meta=${JSON.stringify(meta18b)}`);
    // audit per-episode exactly once (eid ต่างกัน → 2 docs/action รวม 2 episodes)
    assert(logsOf("k18", "chat_assigned").length === 2
      && logsOf("k18", "conversation.handoff").length === 2,
      `แต่ละ episode audit พอดีครั้งเดียว — chat_assigned=${logsOf("k18", "chat_assigned").length} handoff=${logsOf("k18", "conversation.handoff").length}`);
  });

  await test("K19 production queued retry → converge queued + audit ไม่ซ้ำ + claim ไม่เสีย", async () => {
    seedConv("k19"); seedShop(); // ไม่มี admin → queued
    const res1 = await (botHandoffRoute as any).POST(await mkProdReq("k19"));
    const j1 = await res1.json();
    assert(res1.status === 200 && j1?.outcome?.state === "queued",
      `first queued → 200 — status=${res1.status} body=${JSON.stringify(j1)}`);

    const res2 = await (botHandoffRoute as any).POST(await mkProdReq("k19"));
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.state === "queued"
      && j2?.outcome?.persisted === true,
      `queued retry → converge queued persisted — status=${res2.status} body=${JSON.stringify(j2)}`);
    const meta19 = metaOf("k19");
    assert(meta19?.bot_handoff_at instanceof Date
      && meta19?.bot_claim_info?.customer_name === "ลูกค้า k19"
      && meta19?.bot_handoff_reason === "warranty_claim",
      `claim fields ต้องไม่เสีย + timestamp เป็น Date — meta=${JSON.stringify(meta19)}`);
    // queued emit = conversation.handoff เท่านั้น (ไม่มี owner → ไม่มี chat_assigned) — eid dedupe
    assert(logsOf("k19", "conversation.handoff").length === 1
      && logsOf("k19", "chat_assigned").length === 0,
      `queued retry audit ต้องพอดีครั้งเดียว — handoff=${logsOf("k19", "conversation.handoff").length} chat_assigned=${logsOf("k19", "chat_assigned").length}`);
  });

  await test("K20 production queued→assigned upgrade → owner persisted + pending cleared + audit", async () => {
    seedConv("k20"); seedShop(); // ไม่มี admin → queued
    const res1 = await (botHandoffRoute as any).POST(await mkProdReq("k20"));
    const j1 = await res1.json();
    assert(res1.status === 200 && j1?.outcome?.state === "queued",
      `first queued → 200 — status=${res1.status} body=${JSON.stringify(j1)}`);

    // admin พร้อมแล้ว → request เดิม → upgrade assigned
    seedAdmin("admin-1");
    const res2 = await (botHandoffRoute as any).POST(await mkProdReq("k20"));
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.state === "assigned"
      && j2?.outcome?.persisted === true,
      `queued→assigned upgrade → 200 persisted — status=${res2.status} body=${JSON.stringify(j2)}`);
    const meta20 = metaOf("k20");
    assert(meta20?.bot_handoff_at instanceof Date
      && meta20?.bot_claim_info?.customer_name === "ลูกค้า k20",
      `claim fields ต้องไม่เสีย + timestamp เป็น Date — meta=${JSON.stringify(meta20)}`);
    // owner persisted + pending cleared
    const meta = mocks.fakeColl("status_conversation")
      .find((d: any) => d.conversation_id === "k20");
    assert(meta?.assigned_to === "admin-1" && meta?.pending_assignment === false,
      `upgrade ต้อง persist owner + clear pending — meta=${JSON.stringify(meta)}`);
    // audit per-transition: queued emit (eid1) + assigned emit (eid2 — transition ใหม่) พอดี
    assert(logsOf("k20", "chat_assigned").length === 1
      && logsOf("k20", "conversation.handoff").length === 2,
      `upgrade audit — chat_assigned=${logsOf("k20", "chat_assigned").length} handoff=${logsOf("k20", "conversation.handoff").length}`);
  });

  // ═══ CO. explicit admin claim outcome — Phase 2B.6 ═══
  //   status_conversation = claim-outcome transport owner เดียว:
  //   - bot_claim_info/episode ย้ายจาก raw conversations → meta (route เดิม)
  //   - statusSvc.applyClaimOutcome = episode-scoped CAS command เดียว
  //     → applied | already_applied | stale_episode | no_active_claim | invalid
  //   - /api/admin/conversations/[id]/claim-outcome = transport adapter เดียว
  //   - botCallService ส่ง claim_outcome (occurred_at = ISO บน wire) → Python
  //   - ordinary close ห้ามแตะ claim episode / ห้ามสร้าง outcome

  let claimOutcomeRoute: any = null;
  try {
    claimOutcomeRoute = await import(
      "../src/app/api/admin/conversations/[conversationId]/claim-outcome/route");
  } catch { /* ยังไม่มีไฟล์ → assertions ข้างล่าง fail เป็น RED */ }

  const mkOutcomeReq = async (adminId: string | null, convId: string,
                              body: Record<string, unknown> = {}) => {
    const url = `http://localhost/api/admin/conversations/${convId}/claim-outcome`;
    const init = {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    };
    if (adminId) return authReq(adminId, url, init);
    const { NextRequest } = await import("next/server");
    return new NextRequest(url, init);
  };

  await test("CO1 production handoff → claim metadata + active_claim_episode_id บน status_conversation (ย้ายจาก raw dump)", async () => {
    seedConv("co1"); seedShop(); seedAdmin("admin-1");
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("co1", { episode_id: "ep-co1" }));
    assert(res.status === 200 && (await res.json())?.outcome?.state === "assigned",
      `assigned → 200 — status=${res.status}`);
    const meta = metaOf("co1");
    assert(meta?.bot_claim_info?.customer_name === "ลูกค้า co1"
      && meta?.bot_handoff_at instanceof Date
      && meta?.bot_handoff_reason === "warranty_claim",
      `claim metadata ต้องอยู่บน status_conversation — meta=${JSON.stringify(meta)}`);
    assert(meta?.active_claim_episode_id === "ep-co1",
      `episode_id ต้อง transport เป็น active_claim_episode_id — meta=${JSON.stringify(meta)}`);
    const conv = mocks.fakeColl("conversations")
      .find((d: any) => d.conversation_id === "co1");
    assert(conv && !("bot_claim_info" in conv) && !("bot_handoff_at" in conv)
      && !("bot_handoff_reason" in conv),
      `ห้ามเขียน claim ลง raw conversations อีก — doc=${JSON.stringify(conv)}`);
  });

  await test("CO2 handoff ไม่มี claim info แต่มี episode_id → episode ยัง transport", async () => {
    seedConv("co2"); seedShop(); seedAdmin("admin-1");
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("co2", { episode_id: "ep-co2", claim: null }));
    assert(res.status === 200, `status=${res.status}`);
    const meta = metaOf("co2");
    assert(meta?.active_claim_episode_id === "ep-co2" && !meta?.bot_claim_info,
      `episode_id transport ต้องไม่ผูกกับ claim info — meta=${JSON.stringify(meta)}`);
  });

  await test("CO3 applyClaimOutcome resolved → applied + persisted + episode cleared + ownership ไม่ถูกแตะ", async () => {
    seedConv("co3");
    seedMeta("co3", { status: "handoff", assigned_to: "admin-1",
                      active_claim_episode_id: "ep-co3" });
    const r = await (statusSvc as any).applyClaimOutcome("co3", {
      episodeId: "ep-co3", outcome: "resolved", actorId: "admin-1" });
    assert(r.result === "applied", `result=${JSON.stringify(r)}`);
    const meta = metaOf("co3");
    assert(meta?.claim_outcome?.episode_id === "ep-co3"
      && meta?.claim_outcome?.outcome === "resolved"
      && meta?.claim_outcome?.actor_id === "admin-1"
      && meta?.claim_outcome?.occurred_at instanceof Date,
      `claim_outcome ต้อง persist ครบ (Date ไม่ใช่ string) — meta=${JSON.stringify(meta)}`);
    assert(meta?.active_claim_episode_id === null,
      `episode ที่ outcome แล้วต้อง clear — meta=${JSON.stringify(meta)}`);
    assert(meta?.status === "handoff" && meta?.assigned_to === "admin-1",
      `claim outcome ห้ามแตะ ownership/status — meta=${JSON.stringify(meta)}`);
    assert(logsOf("co3", "conversation.claim_outcome").length === 1,
      `audit claim_outcome ครั้งเดียว — ${logsOf("co3", "conversation.claim_outcome").length}`);
  });

  await test("CO4 repeat same command → already_applied + state เดิม + audit ไม่ซ้ำ", async () => {
    seedConv("co4");
    seedMeta("co4", { status: "handoff", assigned_to: "admin-1",
                      active_claim_episode_id: "ep-co4" });
    const r1 = await (statusSvc as any).applyClaimOutcome("co4", {
      episodeId: "ep-co4", outcome: "resolved", actorId: "admin-1" });
    const r2 = await (statusSvc as any).applyClaimOutcome("co4", {
      episodeId: "ep-co4", outcome: "resolved", actorId: "admin-1" });
    assert(r1.result === "applied" && r2.result === "already_applied",
      `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
    const meta = metaOf("co4");
    assert(meta?.claim_outcome?.outcome === "resolved"
      && meta?.active_claim_episode_id === null,
      `state ต้องคงเดิม — meta=${JSON.stringify(meta)}`);
    assert(logsOf("co4", "conversation.claim_outcome").length === 1,
      "audit ต้อง dedupe (eventId=episode) ไม่ซ้ำ");
  });

  await test("CO5 conflicting outcome same episode → already_applied + first terminal wins", async () => {
    seedConv("co5");
    seedMeta("co5", { status: "handoff", active_claim_episode_id: "ep-co5" });
    const r1 = await (statusSvc as any).applyClaimOutcome("co5", {
      episodeId: "ep-co5", outcome: "resolved", actorId: "admin-1" });
    const r2 = await (statusSvc as any).applyClaimOutcome("co5", {
      episodeId: "ep-co5", outcome: "cancelled", actorId: "admin-2" });
    assert(r1.result === "applied" && r2.result === "already_applied", `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
    const meta = metaOf("co5");
    assert(meta?.claim_outcome?.outcome === "resolved"
      && meta?.claim_outcome?.actor_id === "admin-1",
      `terminal แรกต้องชนะ — meta=${JSON.stringify(meta)}`);
  });

  await test("CO6 stale episode → stale_episode + zero write", async () => {
    seedConv("co6");
    seedMeta("co6", { status: "handoff", active_claim_episode_id: "ep-new" });
    const r = await (statusSvc as any).applyClaimOutcome("co6", {
      episodeId: "ep-old", outcome: "resolved", actorId: "admin-1" });
    assert(r.result === "stale_episode", `result=${JSON.stringify(r)}`);
    const meta = metaOf("co6");
    assert(meta?.active_claim_episode_id === "ep-new" && !meta?.claim_outcome,
      `stale command ห้ามเขียน — meta=${JSON.stringify(meta)}`);
    assert(logsOf("co6", "conversation.claim_outcome").length === 0,
      "stale ห้าม audit");
  });

  await test("CO7 no active claim → no_active_claim + zero write", async () => {
    seedConv("co7");
    seedMeta("co7", { status: "handoff", assigned_to: "admin-1" });
    const r = await (statusSvc as any).applyClaimOutcome("co7", {
      episodeId: "ep-x", outcome: "resolved", actorId: "admin-1" });
    assert(r.result === "no_active_claim", `result=${JSON.stringify(r)}`);
    const meta = metaOf("co7");
    assert(!meta?.claim_outcome && meta?.status === "handoff",
      `ห้ามเขียน outcome — meta=${JSON.stringify(meta)}`);
  });

  await test("CO8 race — rival commits first → loser already_applied (terminal wins)", async () => {
    seedConv("co8");
    seedMeta("co8", { status: "handoff", active_claim_episode_id: "ep-co8" });
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll !== "status_conversation") return;
      (mocks.state as any).findOneAndUpdateHook = null;
      const doc = metaOf("co8")!;
      doc.claim_outcome = { episode_id: "ep-co8", outcome: "resolved",
                            actor_id: "admin-9", occurred_at: new Date() };
      doc.active_claim_episode_id = null;
    };
    const r = await (statusSvc as any).applyClaimOutcome("co8", {
      episodeId: "ep-co8", outcome: "cancelled", actorId: "admin-1" });
    (mocks.state as any).findOneAndUpdateHook = null;
    assert(r.result === "already_applied",
      `loser ต้อง reconcile เป็น already_applied — r=${JSON.stringify(r)}`);
    const meta = metaOf("co8");
    assert(meta?.claim_outcome?.outcome === "resolved"
      && meta?.claim_outcome?.actor_id === "admin-9",
      `winner ห้ามถูก overwrite — meta=${JSON.stringify(meta)}`);
  });

  await test("CO9 route: no session → 401 + zero write", async () => {
    seedConv("co9");
    seedMeta("co9", { status: "handoff", active_claim_episode_id: "ep-co9" });
    assert(claimOutcomeRoute, "claim-outcome route missing");
    const res = await claimOutcomeRoute.POST(
      await mkOutcomeReq(null, "co9",
        { episode_id: "ep-co9", outcome: "resolved" }),
      paramsOf("co9"));
    assert(res.status === 401, `status=${res.status}`);
    assert(!metaOf("co9")?.claim_outcome, "unauth ห้ามเขียน");
  });

  await test("CO10 route: invalid body → 422 (missing episode / bad outcome / wrong type)", async () => {
    seedAdmin("admin-1");
    assert(claimOutcomeRoute, "claim-outcome route missing");
    for (const [label, body] of [
      ["missing episode_id", { outcome: "resolved" }],
      ["missing outcome", { episode_id: "ep-co10" }],
      ["bad outcome enum", { episode_id: "ep-co10", outcome: "done" }],
      ["episode non-string", { episode_id: 42, outcome: "resolved" }],
      ["episode overlong", { episode_id: "x".repeat(300), outcome: "resolved" }],
    ] as const) {
      const res = await claimOutcomeRoute.POST(
        await mkOutcomeReq("admin-1", "co10", body), paramsOf("co10"));
      assert(res.status === 422,
        `${label} → 422 expected — got ${res.status} body=${JSON.stringify(await res.json().catch(() => null))}`);
    }
  });

  await test("CO11 route: valid → 200 {ok,result:'applied'} + meta persisted + audit", async () => {
    seedConv("co11"); seedAdmin("admin-1");
    seedMeta("co11", { status: "handoff", assigned_to: "admin-1",
                       active_claim_episode_id: "ep-co11" });
    assert(claimOutcomeRoute, "claim-outcome route missing");
    const res = await claimOutcomeRoute.POST(
      await mkOutcomeReq("admin-1", "co11",
        { episode_id: "ep-co11", outcome: "cancelled" }),
      paramsOf("co11"));
    const body = await res.json();
    assert(res.status === 200 && body?.ok === true && body?.result === "applied",
      `status=${res.status} body=${JSON.stringify(body)}`);
    const meta = metaOf("co11");
    assert(meta?.claim_outcome?.outcome === "cancelled"
      && meta?.claim_outcome?.actor_id === "admin-1"
      && meta?.active_claim_episode_id === null,
      `meta=${JSON.stringify(meta)}`);
    assert(logsOf("co11", "conversation.claim_outcome").length === 1,
      "audit ครั้งเดียว");
  });

  await test("CO12 route: stale → 409 {result:'stale_episode'}; no active → 409", async () => {
    seedConv("co12a"); seedAdmin("admin-1");
    seedMeta("co12a", { status: "handoff", active_claim_episode_id: "ep-new" });
    assert(claimOutcomeRoute, "claim-outcome route missing");
    const r1 = await claimOutcomeRoute.POST(
      await mkOutcomeReq("admin-1", "co12a",
        { episode_id: "ep-old", outcome: "resolved" }), paramsOf("co12a"));
    const b1 = await r1.json();
    assert(r1.status === 409 && b1?.result === "stale_episode",
      `stale → 409 — status=${r1.status} body=${JSON.stringify(b1)}`);
    seedConv("co12b");
    seedMeta("co12b", { status: "handoff" });
    const r2 = await claimOutcomeRoute.POST(
      await mkOutcomeReq("admin-1", "co12b",
        { episode_id: "ep-x", outcome: "resolved" }), paramsOf("co12b"));
    const b2 = await r2.json();
    assert(r2.status === 409 && b2?.result === "no_active_claim",
      `no active → 409 — status=${r2.status} body=${JSON.stringify(b2)}`);
  });

  await test("CO13 route: service throws → 500 sanitized (no raw error leak)", async () => {
    seedConv("co13"); seedAdmin("admin-1");
    seedMeta("co13", { status: "handoff", active_claim_episode_id: "ep-co13" });
    assert(claimOutcomeRoute, "claim-outcome route missing");
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation") {
        throw new Error("simulated-failure-should-not-leak");
      }
    };
    const res = await claimOutcomeRoute.POST(
      await mkOutcomeReq("admin-1", "co13",
        { episode_id: "ep-co13", outcome: "resolved" }), paramsOf("co13"));
    (mocks.state as any).findOneAndUpdateHook = null;
    const body = await res.json().catch(() => null);
    assert(res.status === 500, `status=${res.status}`);
    const leak = JSON.stringify(body);
    assert(!leak.includes("simulated-failure-should-not-leak"),
      `500 ห้าม leak raw error — body=${leak}`);
  });

  await test("CO14 botCall: meta.claim_outcome → claim_outcome บน wire (occurred_at ISO); absent → key absent; test/simulate → absent", async () => {
    seedConv("co14");
    seedMeta("co14", { status: "bot",
      claim_outcome: { episode_id: "ep-co14", outcome: "resolved",
                       actor_id: "admin-1",
                       occurred_at: new Date("2026-10-01T01:02:03Z") } });
    const body = await callBotOnce("co14");
    assert(body.claim_outcome?.episode_id === "ep-co14"
      && body.claim_outcome?.outcome === "resolved"
      && body.claim_outcome?.actor_id === "admin-1",
      `claim_outcome ต้องอยู่บน /chat payload — body=${JSON.stringify(body)}`);
    assert(typeof body.claim_outcome?.occurred_at === "string"
      && body.claim_outcome.occurred_at.startsWith("2026-10-01T01:02:03"),
      `occurred_at ต้องเป็น ISO string บน wire — ${body.claim_outcome?.occurred_at}`);
    mocks.state.fetchBodies.length = 0;
    seedConv("co14b"); seedMeta("co14b", { status: "bot" });
    const body2 = await callBotOnce("co14b");
    assert(!("claim_outcome" in body2),
      `ไม่มี outcome → ห้ามส่ง key — body=${JSON.stringify(body2)}`);
    mocks.state.fetchBodies.length = 0;
    mocks.fakeColl("test_status_conversation").push({
      conversation_id: "co14c", source: "botworker", status: "bot",
      claim_outcome: { episode_id: "ep-t", outcome: "resolved" },
    });
    const body3 = await callBotOnce("co14c", { testSource: "botworker" });
    assert(!("claim_outcome" in body3),
      `test/simulate isolation — outcome ห้ามรั่วเข้า test path — body=${JSON.stringify(body3)}`);
  });

  await test("CO15 ordinary close → status closed + claim episode preserved + ไม่มี outcome", async () => {
    seedConv("co15");
    seedMeta("co15", { status: "handoff", assigned_to: "admin-1",
                       active_claim_episode_id: "ep-co15" });
    await statusSvc.closeConversation({
      conversationId: "co15", closedBy: "admin-1",
      reason: "done", category: "product", resolution: "answered" });
    const meta = metaOf("co15");
    assert(meta?.status === "closed", `close ต้องทำงานปกติ — meta=${JSON.stringify(meta)}`);
    assert(meta?.active_claim_episode_id === "ep-co15",
      `close ห้ามจบ claim episode — meta=${JSON.stringify(meta)}`);
    assert(!meta?.claim_outcome, "close ห้ามสร้าง claim_outcome");
  });

  await test("CO16 [source pin] claim-outcome route = transport adapter (no direct Mongo)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    let src = "";
    try {
      src = readFileSync(fileURLToPath(new URL(
        "../src/app/api/admin/conversations/[conversationId]/claim-outcome/route.ts",
        import.meta.url)), "utf8");
    } catch { /* missing → RED */ }
    assert(src.length > 0, "route file missing — RED forward contract");
    assert(!/getCollection|mongoClient|insertOne|updateOne|findOneAndUpdate|deleteOne|deleteMany/.test(src),
      "route ต้องเป็น transport adapter — Mongo/CAS อยู่ใน statusConversationService");
  });

  // ── R. Phase 2B.6 review-fix — episode fencing / metadata contract / UI scope / shape ──

  await test("R1 terminal ep1 → retry recordClaimHandoff(ep1) → ห้าม reopen (active null, outcome คงอยู่)", async () => {
    seedMeta("r1", { status: "handoff", active_claim_episode_id: null,
      claim_outcome: { episode_id: "ep-r1", outcome: "resolved",
                       actor_id: "admin-1", occurred_at: new Date() } });
    await (statusSvc as any).recordClaimHandoff({
      conversationId: "r1",
      claim: { customer_name: "retry" }, reason: "warranty_claim",
      episodeId: "ep-r1" });
    const meta = metaOf("r1");
    assert(meta?.active_claim_episode_id == null,
      `terminal episode ห้าม reopen — meta=${JSON.stringify(meta)}`);
    assert(meta?.claim_outcome?.episode_id === "ep-r1"
      && meta?.claim_outcome?.outcome === "resolved",
      `terminal outcome ต้องคงอยู่ — meta=${JSON.stringify(meta)}`);
  });

  await test("R2 ep1 resolved → retry handoff ep1 → cancelled command → first terminal wins + audit เดิม", async () => {
    seedConv("r2"); seedAdmin("admin-1");
    seedMeta("r2", { status: "handoff", active_claim_episode_id: "ep-r2" });
    const r1 = await (statusSvc as any).applyClaimOutcome("r2", {
      episodeId: "ep-r2", outcome: "resolved", actorId: "admin-1" });
    assert(r1.result === "applied", `setup apply ต้องสำเร็จ — r1=${JSON.stringify(r1)}`);
    // delayed/duplicate handoff ของ ep1 มาหลัง terminal
    await (statusSvc as any).recordClaimHandoff({
      conversationId: "r2", claim: { customer_name: "dup" },
      reason: "warranty_claim", episodeId: "ep-r2" });
    // conflicting outcome command ของ episode เดิม
    const r2 = await (statusSvc as any).applyClaimOutcome("r2", {
      episodeId: "ep-r2", outcome: "cancelled", actorId: "admin-1" });
    const meta = metaOf("r2");
    assert(r2.result === "already_applied",
      `cancelled ห้าม overwrite resolved — r2=${JSON.stringify(r2)}`);
    assert(meta?.claim_outcome?.outcome === "resolved"
      && meta?.claim_outcome?.actor_id === "admin-1"
      && meta?.active_claim_episode_id == null,
      `resolved ต้องชนะ + episode ห้าม reopen — meta=${JSON.stringify(meta)}`);
    assert(logsOf("r2", "conversation.claim_outcome").length === 1,
      `audit ต้องคงครั้งเดียว — ${logsOf("r2", "conversation.claim_outcome").length}`);
  });

  await test("R3 active ep2 + delayed recordClaimHandoff(ep1) → stale fenced: ep2 + metadata ไม่ถูกทับ", async () => {
    seedMeta("r3", { status: "handoff", active_claim_episode_id: "ep-r3-new",
      bot_claim_info: { customer_name: "episode-2" } });
    await (statusSvc as any).recordClaimHandoff({
      conversationId: "r3",
      claim: { customer_name: "stale-ep1" }, reason: "warranty_claim",
      episodeId: "ep-r3-old" });
    const meta = metaOf("r3");
    assert(meta?.active_claim_episode_id === "ep-r3-new",
      `stale writer ห้ามทับ active — meta=${JSON.stringify(meta)}`);
    assert((meta?.bot_claim_info as any)?.customer_name === "episode-2",
      `stale handoff ห้ามทับ claim metadata — meta=${JSON.stringify(meta)}`);
  });

  await test("R4 terminal ep1 → new recordClaimHandoff(ep2) → ep2 open + outcome เก่าถูก supersede + ep2 apply ได้", async () => {
    seedMeta("r4", { status: "handoff", active_claim_episode_id: "ep-r4-1" });
    const r1 = await (statusSvc as any).applyClaimOutcome("r4", {
      episodeId: "ep-r4-1", outcome: "resolved", actorId: "admin-1" });
    assert(r1.result === "applied", `setup — r1=${JSON.stringify(r1)}`);
    await (statusSvc as any).recordClaimHandoff({
      conversationId: "r4",
      claim: { customer_order_id: "ord-2" }, reason: "claim",
      episodeId: "ep-r4-2" });
    const meta = metaOf("r4");
    assert(meta?.active_claim_episode_id === "ep-r4-2",
      `episode ใหม่ต้อง open — meta=${JSON.stringify(meta)}`);
    assert(meta?.claim_outcome == null,
      `outcome ของ ep1 ต้องถูก clear ใน transition เดียว — meta=${JSON.stringify(meta)}`);
    const r2 = await (statusSvc as any).applyClaimOutcome("r4", {
      episodeId: "ep-r4-2", outcome: "cancelled", actorId: "admin-1" });
    assert(r2.result === "applied", `ep2 outcome ต้อง apply ได้ — r2=${JSON.stringify(r2)}`);
    const meta2 = metaOf("r4");
    assert(meta2?.claim_outcome?.episode_id === "ep-r4-2"
      && meta2?.claim_outcome?.outcome === "cancelled",
      `ep2 outcome persist — meta=${JSON.stringify(meta2)}`);
  });

  await test("R5 concurrent — winner(ep2) lands before stale(ep1) fenced write → loser cannot overwrite (bounded)", async () => {
    seedConv("r5");
    // genuine interleave: hook fires right before the fenced write — winner lands first
    let landed = false;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string) => {
      if (coll === "status_conversation" && !landed) {
        landed = true;
        const d = metaOf("r5");
        if (d) d.active_claim_episode_id = "ep-r5-new";
        else mocks.fakeColl("status_conversation").push({
          conversation_id: "r5", status: "handoff",
          active_claim_episode_id: "ep-r5-new",
          bot_claim_info: { customer_name: "winner" }, updated_at: new Date() });
      }
    };
    await (statusSvc as any).recordClaimHandoff({
      conversationId: "r5",
      claim: { customer_name: "stale-loser" }, reason: "warranty_claim",
      episodeId: "ep-r5-old" });
    (mocks.state as any).findOneAndUpdateHook = null;
    const meta = metaOf("r5");
    assert(meta?.active_claim_episode_id === "ep-r5-new",
      `loser ห้าม overwrite winner — meta=${JSON.stringify(meta)}`);
    assert((meta?.bot_claim_info as any)?.customer_name === "winner",
      `stale claim metadata ห้ามเขียน — meta=${JSON.stringify(meta)}`);
  });

  await test("R6 malformed {active:ep1, outcome:ep1} → applyClaimOutcome ห้าม overwrite terminal", async () => {
    seedMeta("r6", { status: "handoff", active_claim_episode_id: "ep-r6",
      claim_outcome: { episode_id: "ep-r6", outcome: "resolved",
                       actor_id: "admin-9", occurred_at: new Date() } });
    const r = await (statusSvc as any).applyClaimOutcome("r6", {
      episodeId: "ep-r6", outcome: "cancelled", actorId: "admin-1" });
    const meta = metaOf("r6");
    assert(r.result === "already_applied",
      `terminal outcome ต้องชนะแม้ storage ผิดปกติ — r=${JSON.stringify(r)}`);
    assert(meta?.claim_outcome?.outcome === "resolved"
      && meta?.claim_outcome?.actor_id === "admin-9",
      `terminal outcome ห้ามถูกเขียนทับ — meta=${JSON.stringify(meta)}`);
  });

  // round-3 ordering: episode fence มาก่อน handoff — metadata fail →
  //   503 ก่อน ownership mutation (เดิม: commit ก่อน → ownership คงอยู่)
  await test("R7 metadata write failure → non-2xx retryable + ไม่มี ownership commit + sanitized", async () => {
    seedConv("r7"); seedShop(); seedAdmin("admin-1");
    const orig = (statusSvc.statusConversationService as any).recordClaimHandoff;
    (statusSvc.statusConversationService as any).recordClaimHandoff = async () => {
      throw new Error("simulated-metadata-persist-failure");
    };
    const res = await (botHandoffRoute as any).POST(await mkProdReq("r7", { episode_id: "ep-r7" }));
    (statusSvc.statusConversationService as any).recordClaimHandoff = orig;
    const body = await res.json().catch(() => null);
    assert(!(res.status >= 200 && res.status < 300),
      `metadata failure ห้ามคืน success — status=${res.status} body=${JSON.stringify(body)}`);
    assert(res.status === 503 || res.status === 500 || res.status === 429,
      `ต้องเป็น retryable failure — status=${res.status}`);
    const meta = metaOf("r7");
    assert(meta?.status !== "handoff" && !meta?.assigned_to,
      `episode fence fail ก่อน handoff → ห้ามมี ownership commit — meta=${JSON.stringify(meta)}`);
    assert(!JSON.stringify(body).includes("simulated-metadata-persist-failure"),
      `response ห้าม leak raw error — body=${JSON.stringify(body)}`);
  });

  await test("R9 retry after metadata failure → converge: ownership เดิม + metadata once + audit once", async () => {
    seedConv("r9"); seedShop(); seedAdmin("admin-1");
    const orig = (statusSvc.statusConversationService as any).recordClaimHandoff;
    let failFirst = true;
    let calls = 0;
    (statusSvc.statusConversationService as any).recordClaimHandoff = async (o: any) => {
      calls++;
      if (failFirst) { failFirst = false; throw new Error("transient"); }
      return orig(o);
    };
    const res1 = await (botHandoffRoute as any).POST(await mkProdReq("r9", { episode_id: "ep-r9" }));
    assert(!(res1.status >= 200 && res1.status < 300),
      `first attempt ต้อง fail — status=${res1.status}`);
    const res2 = await (botHandoffRoute as any).POST(await mkProdReq("r9", { episode_id: "ep-r9" }));
    (statusSvc.statusConversationService as any).recordClaimHandoff = orig;
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.state === "assigned",
      `retry ต้อง converge — status=${res2.status} body=${JSON.stringify(j2)}`);
    const meta = metaOf("r9");
    assert(meta?.status === "handoff" && meta?.active_claim_episode_id === "ep-r9"
      && (meta?.bot_claim_info as any)?.customer_name,
      `metadata persist หลัง retry — meta=${JSON.stringify(meta)}`);
    assert(calls === 2,
      `recordClaimHandoff ถูกเรียกพอดี 2 ครั้ง (1 fail + 1 success) — calls=${calls}`);
    assert(logsOf("r9", "conversation.handoff").length === 1
      && logsOf("r9", "chat_assigned").length === 1,
      `audit ห้ามซ้ำบน retry — handoff=${logsOf("r9", "conversation.handoff").length} assigned=${logsOf("r9", "chat_assigned").length}`);
  });

  await test("R10 [source pin] ClaimSection keyed by conversation.id → state reset เมื่อ switch conversation", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL(
      "../src/components/chat/InfoTab.tsx", import.meta.url)), "utf8");
    const usage = src.match(/<ClaimSection\b[\s\S]*?\/>/)?.[0] || "";
    assert(/key=\{/.test(usage) && usage.includes("conversation.id"),
      `ClaimSection ต้อง key ตาม conversation.id — usage=${usage}`);
  });

  await test("R11 [source pin] ClaimSection key รวม episode identity → reset เมื่อ episode เปลี่ยน", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL(
      "../src/components/chat/InfoTab.tsx", import.meta.url)), "utf8");
    const usage = src.match(/<ClaimSection\b[\s\S]*?\/>/)?.[0] || "";
    assert(usage.includes("active_claim_episode_id") || usage.includes("episodeId"),
      `key ต้องผูก episode identity — usage=${usage}`);
  });

  await test("R12 production claim shape → customer_order_id ไหลถึง meta + UI อ่าน canonical key เดียว", async () => {
    seedConv("r12"); seedShop(); seedAdmin("admin-1");
    const claim = {
      customer_name: "ลูกค้า r12", customer_phone: "0810000000",
      customer_order_id: "ord-r12-99", purchase_date: "2026-09-01",
      claim_topic: "เคลม/ซ่อม/ประกันสินค้า",
    };
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r12", { episode_id: "ep-r12", claim }));
    assert(res.status === 200, `status=${res.status}`);
    const meta = metaOf("r12");
    assert((meta?.bot_claim_info as any)?.customer_order_id === "ord-r12-99",
      `customer_order_id ต้อง persist — meta=${JSON.stringify(meta?.bot_claim_info)}`);
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const ui = readFileSync(fileURLToPath(new URL(
      "../src/components/chat/InfoTab.tsx", import.meta.url)), "utf8");
    assert(!/info\?\.order_id\b/.test(ui),
      "UI ห้ามอ่าน order_id — production ส่ง customer_order_id");
    assert(/info\?\.customer_order_id/.test(ui),
      "UI ต้องอ่าน customer_order_id (canonical)");
    const types = readFileSync(fileURLToPath(new URL(
      "../src/lib/types.ts", import.meta.url)), "utf8");
    const claimBlock = types.match(/bot_claim_info\?:\s*\{[^}]*\}/)?.[0] || "";
    assert(/customer_order_id/.test(claimBlock) && !/\border_id\?:/.test(claimBlock),
      `Conversation.bot_claim_info ต้องใช้ customer_order_id — block=${claimBlock}`);
  });

  // ═══ R13–R16 — Phase 2B.6 review-fix round 2 (typed metadata result,
  //   audit convergence, authoritative outcome on wire) ═══

  await test("R13 stale ep1 while ep2 active → typed stale_episode + route 409 + ep2 metadata intact", async () => {
    seedConv("r13"); seedShop(); seedAdmin("admin-1");
    seedMeta("r13", { status: "handoff", assigned_to: "admin-1",
                      active_claim_episode_id: "ep2",
                      bot_claim_info: { customer_order_id: "ep2-order" } });
    const wr = await (statusSvc as any).recordClaimHandoff({
      conversationId: "r13", claim: { customer_order_id: "ep1-order" },
      reason: "warranty_claim", episodeId: "ep1" });
    assert(wr?.status === "stale_episode",
      `recordClaimHandoff ต้อง classify stale — got ${JSON.stringify(wr)}`);
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r13", { episode_id: "ep1",
                               claim: { customer_order_id: "ep1-order" } }));
    const j = await res.json();
    // 409 permanent → Python _send_handoff ห้าม classify เป็น confirmed
    //   (4xx ไม่ retry — ownership ที่ commit แล้วคงอยู่ แต่ episode metadata
    //   ของ stale ep ห้ามกลายเป็น success)
    assert(res.status === 409 && j?.ok === false,
      `stale episode → 409 — status=${res.status} body=${JSON.stringify(j)}`);
    const meta = metaOf("r13");
    assert(meta?.active_claim_episode_id === "ep2"
      && (meta?.bot_claim_info as any)?.customer_order_id === "ep2-order",
      `ep2 metadata ห้ามถูก stale ep1 ทับ — meta=${JSON.stringify(meta)}`);
  });

  await test("R14 same episode already terminal → already_terminal + converged 200 carrying outcome truth", async () => {
    seedConv("r14"); seedShop(); seedAdmin("admin-1");
    seedMeta("r14", { status: "handoff", assigned_to: "admin-1",
      active_claim_episode_id: null,
      claim_outcome: { episode_id: "ep1", outcome: "resolved",
                       actor_id: "admin-1",
                       occurred_at: new Date("2026-10-14T01:00:00Z") } });
    const wr = await (statusSvc as any).recordClaimHandoff({
      conversationId: "r14", claim: { customer_order_id: "x" },
      reason: "warranty_claim", episodeId: "ep1" });
    assert(wr?.status === "already_terminal",
      `recordClaimHandoff ต้อง classify terminal — got ${JSON.stringify(wr)}`);
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r14", { episode_id: "ep1" }));
    const j = await res.json();
    assert(res.status === 200 && j?.claim_metadata === "already_terminal"
        && j?.claim_outcome?.outcome === "resolved"
        && j?.claim_outcome?.actor_id === "admin-1",
      `terminal episode → converged 200 carrying authoritative outcome — status=${res.status} body=${JSON.stringify(j)}`);
    const meta = metaOf("r14");
    assert(meta?.claim_outcome?.outcome === "resolved"
      && meta?.claim_outcome?.actor_id === "admin-1"
      && meta?.active_claim_episode_id === null,
      `terminal outcome ห้าม reopen/overwrite — meta=${JSON.stringify(meta)}`);
  });

  await test("R15 audit crash window → committed outcome kept; retry repairs audit exactly-once", async () => {
    seedConv("r15");
    seedMeta("r15", { status: "handoff", assigned_to: "admin-1",
                      active_claim_episode_id: "ep-r15" });
    insertErrorOnce("conversation.claim_outcome");
    let threw = false;
    try {
      await (statusSvc as any).applyClaimOutcome("r15", {
        episodeId: "ep-r15", outcome: "resolved", actorId: "admin-1" });
    } catch { threw = true; }
    assert(threw, "audit crash ต้อง propagate");
    const mid = metaOf("r15");
    assert(mid?.claim_outcome?.episode_id === "ep-r15"
      && mid?.active_claim_episode_id === null,
      `CAS committed ต้องคงอยู่แม้ audit fail — meta=${JSON.stringify(mid)}`);
    assert(logsOf("r15", "conversation.claim_outcome").length === 0,
      "audit ต้องยังไม่มีหลัง crash");
    const r2 = await (statusSvc as any).applyClaimOutcome("r15", {
      episodeId: "ep-r15", outcome: "resolved", actorId: "admin-1" });
    assert(r2.result === "already_applied",
      `retry ต้อง already_applied — got ${JSON.stringify(r2)}`);
    assert(logsOf("r15", "conversation.claim_outcome").length === 1,
      `retry ต้อง repair audit exactly-once — got ${logsOf("r15", "conversation.claim_outcome").length}`);
    const meta = metaOf("r15");
    assert(meta?.claim_outcome?.outcome === "resolved"
      && meta?.claim_outcome?.actor_id === "admin-1",
      `first terminal ต้องคงเป็น authoritative — meta=${JSON.stringify(meta)}`);
  });

  await test("R16 conflicting retry → already_applied + authoritative persisted outcome (route→UI)", async () => {
    seedConv("r16"); seedAdmin("admin-b");
    seedMeta("r16", { status: "handoff", assigned_to: "admin-a",
      active_claim_episode_id: null,
      claim_outcome: { episode_id: "ep-r16", outcome: "resolved",
                       actor_id: "admin-a", occurred_at: new Date() } });
    const res = await claimOutcomeRoute.POST(
      await mkOutcomeReq("admin-b", "r16",
        { episode_id: "ep-r16", outcome: "cancelled" }),
      paramsOf("r16"));
    const j = await res.json();
    assert(res.status === 200 && j?.result === "already_applied",
      `conflict → already_applied — status=${res.status} body=${JSON.stringify(j)}`);
    assert(j?.claim_outcome?.outcome === "resolved"
      && j?.claim_outcome?.actor_id === "admin-a",
      `route ต้องคืน authoritative persisted outcome — body=${JSON.stringify(j)}`);
    // UI pin — ClaimSection ต้องอ่าน persisted outcome จาก body ไม่ใช่ค่าที่กด
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const ui = readFileSync(fileURLToPath(new URL(
      "../src/components/chat/InfoTab.tsx", import.meta.url)), "utf8");
    assert(/body\??\.claim_outcome\??\.outcome/.test(ui),
      "UI ต้องอ่าน authoritative outcome จาก body.claim_outcome.outcome");
    assert(!/setApplied\(o\)/.test(ui),
      "UI ห้าม set applied จากค่าที่กด (o) — ต้องใช้ persisted outcome");
  });

  // ═══ R17–R20 — Phase 2B.6 review-fix round 3 (handoff ordering) ═══
  //   episode fence verdict ต้องมาก่อน ownership mutation:
  //   conversation exists → episode fence/metadata → handoff ownership

  await test("R17 stale ep → 409 + handoffToAdmin calls=0 + status/owner/audit/meta ไม่เปลี่ยน", async () => {
    seedConv("r17"); seedShop(); seedAdmin("admin-1");
    seedMeta("r17", { status: "bot", assigned_to: null,
                      active_claim_episode_id: "ep-new",
                      bot_claim_info: { customer_order_id: "epnew-order" } });
    const metaBefore = JSON.stringify(metaOf("r17"));
    let handoffCalls = 0;
    const origH = (handoffSvc.handoffService as any).handoffToAdmin;
    (handoffSvc.handoffService as any).handoffToAdmin = async (o: any) => {
      handoffCalls++; return origH(o);
    };
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r17", { episode_id: "ep-old",
                               claim: { customer_order_id: "epold-order" } }));
    (handoffSvc.handoffService as any).handoffToAdmin = origH;
    const j = await res.json();
    assert(res.status === 409 && j?.ok === false
        && j?.claim_metadata === "stale_episode",
      `stale → 409 — status=${res.status} body=${JSON.stringify(j)}`);
    assert(handoffCalls === 0,
      `stale verdict ต้องมาก่อน handoff — handoffToAdmin calls=${handoffCalls}`);
    assert(JSON.stringify(metaOf("r17")) === metaBefore,
      `status/owner/ep-new metadata ต้อง byte-equivalent — meta=${JSON.stringify(metaOf("r17"))}`);
    assert(logsOf("r17", "chat_assigned").length === 0
      && logsOf("r17", "conversation.handoff").length === 0
      && logsOf("r17", "conversation.open").length === 0,
      `stale → ownership/reopen/handoff audits ต้อง = 0`);
  });

  await test("R18 terminal ep retry → converged 200 + persisted outcome + zero handoff/reopen", async () => {
    seedConv("r18"); seedShop(); seedAdmin("admin-1");
    seedMeta("r18", { status: "closed",
      closed_at: new Date("2026-10-13T00:00:00Z"), closed_by: "admin-1",
      assigned_to: null, active_claim_episode_id: null,
      claim_outcome: { episode_id: "ep-term", outcome: "resolved",
                       actor_id: "admin-1",
                       occurred_at: new Date("2026-10-14T01:00:00Z") } });
    const metaBefore = JSON.stringify(metaOf("r18"));
    let handoffCalls = 0;
    const origH = (handoffSvc.handoffService as any).handoffToAdmin;
    (handoffSvc.handoffService as any).handoffToAdmin = async (o: any) => {
      handoffCalls++; return origH(o);
    };
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r18", { episode_id: "ep-term" }));
    (handoffSvc.handoffService as any).handoffToAdmin = origH;
    const j = await res.json();
    assert(res.status === 200 && j?.claim_metadata === "already_terminal"
      && j?.claim_outcome?.outcome === "resolved"
      && j?.claim_outcome?.actor_id === "admin-1",
      `terminal → converged 200 carrying persisted outcome — status=${res.status} body=${JSON.stringify(j)}`);
    assert(j?.outcome?.state !== "assigned" && j?.outcome?.state !== "queued",
      `ห้าม synthesize typed handoff outcome — Python confirm เฉพาะ outcome.state∈{assigned,queued} — body=${JSON.stringify(j)}`);
    assert(handoffCalls === 0,
      `terminal verdict ต้องมาก่อน handoff — handoffToAdmin calls=${handoffCalls}`);
    assert(JSON.stringify(metaOf("r18")) === metaBefore,
      `closed/status/owner/claim_outcome ต้อง byte-equivalent — meta=${JSON.stringify(metaOf("r18"))}`);
    assert(logsOf("r18", "chat_assigned").length === 0
      && logsOf("r18", "conversation.handoff").length === 0
      && logsOf("r18", "conversation.open").length === 0,
      `terminal → ownership/reopen/handoff audits ต้อง = 0`);
  });

  await test("R19 metadata persist failure → sanitized 503 ก่อน handoff + calls=0", async () => {
    seedConv("r19"); seedShop(); seedAdmin("admin-1");
    const orig = (statusSvc.statusConversationService as any).recordClaimHandoff;
    (statusSvc.statusConversationService as any).recordClaimHandoff = async () => {
      throw new Error("simulated-metadata-persist-failure");
    };
    let handoffCalls = 0;
    const origH = (handoffSvc.handoffService as any).handoffToAdmin;
    (handoffSvc.handoffService as any).handoffToAdmin = async (o: any) => {
      handoffCalls++; return origH(o);
    };
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r19", { episode_id: "ep-r19" }));
    (statusSvc.statusConversationService as any).recordClaimHandoff = orig;
    (handoffSvc.handoffService as any).handoffToAdmin = origH;
    const body = await res.json().catch(() => null);
    assert(res.status === 503 && body?.ok === false,
      `metadata failure → retryable 503 — status=${res.status} body=${JSON.stringify(body)}`);
    assert(handoffCalls === 0,
      `metadata gate ต้องมาก่อน handoff — handoffToAdmin calls=${handoffCalls}`);
    const meta = metaOf("r19");
    assert(!meta?.assigned_to && meta?.status !== "handoff",
      `ownership ห้าม commit เมื่อ episode fence fail — meta=${JSON.stringify(meta)}`);
    assert(!JSON.stringify(body).includes("simulated-metadata-persist-failure"),
      `response ห้าม leak raw error — body=${JSON.stringify(body)}`);
    assert(logsOf("r19", "chat_assigned").length === 0
      && logsOf("r19", "conversation.handoff").length === 0,
      `metadata failure → handoff audits ต้อง = 0`);
  });

  await test("R20 metadata written + handoff retryable fail → ownership unassigned → retry converge + audit once", async () => {
    seedConv("r20"); seedShop(); seedAdmin("admin-1"); seedAdmin("admin-2");
    seedCursor("admin-2");
    forceCursorMiss(); // contention → failed retryable, ไม่มี ownership commit
    const res1 = await (botHandoffRoute as any).POST(
      await mkProdReq("r20", { episode_id: "ep-r20" }));
    const j1 = await res1.json();
    assert(res1.status === 503 && j1?.outcome?.state === "failed",
      `contention → retryable failed — status=${res1.status} body=${JSON.stringify(j1)}`);
    const m1 = metaOf("r20");
    assert(m1?.active_claim_episode_id === "ep-r20"
      && !m1?.assigned_to
      && (m1?.bot_claim_info as any)?.customer_name === "ลูกค้า r20",
      `metadata ต้องเขียนก่อน handoff และ ownership ยังไม่ commit — meta=${JSON.stringify(m1)}`);
    // retry identity เดิม → fence ผ่าน (same-ep refresh) → handoff converge
    clearHooks();
    const res2 = await (botHandoffRoute as any).POST(
      await mkProdReq("r20", { episode_id: "ep-r20" }));
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.state === "assigned",
      `retry ต้อง converge — status=${res2.status} body=${JSON.stringify(j2)}`);
    const m2 = metaOf("r20");
    assert(m2?.active_claim_episode_id === "ep-r20"
      && (m2?.bot_claim_info as any)?.customer_name === "ลูกค้า r20"
      && m2?.assigned_to === "admin-1",
      `retry → metadata ไม่ซ้ำ/ไม่เสีย + owner persisted — meta=${JSON.stringify(m2)}`);
    assert(logsOf("r20", "chat_assigned").length === 1
      && logsOf("r20", "conversation.handoff").length === 1,
      `handoff success audit exactly once — chat_assigned=${logsOf("r20", "chat_assigned").length} handoff=${logsOf("r20", "conversation.handoff").length}`);
  });

  // ═══ R21–R24 — Phase 2B.6 review-fix round 4 (atomic episode fence) ═══
  //   TOCTOU: gate written → terminalize/E2 interleave → ownership CAS ต้อง miss
  //   interleave seam = findOneAndUpdateHook fires pre-op; commit CAS แยกจาก
  //   metadata gate ด้วย $or keys (assigned_to) — gate/outcome CAS ไม่มี

  const onCommitCas = (fn: () => Promise<void>) => {
    let fired = false;
    (mocks.state as any).findOneAndUpdateHook = async (coll: string, filter: any) => {
      if (fired || coll !== "status_conversation") return;
      const orKeys = (filter?.$or ?? [])
        .map((c: any) => Object.keys(c ?? {}).join(",")).join("|");
      const isOwnershipCommit = orKeys.includes("assigned_to")
        || "assigned_to" in (filter ?? {});
      if (!isOwnershipCommit) return;
      fired = true;
      await fn();
    };
  };

  await test("R21 terminal outcome interleave gate↔CAS → no assign/reopen + converged terminal", async () => {
    seedConv("r21"); seedShop(); seedAdmin("admin-1");
    seedMeta("r21", { status: "bot", assigned_to: null });
    onCommitCas(async () => {
      await (statusSvc as any).applyClaimOutcome("r21", {
        episodeId: "ep-r21", outcome: "resolved", actorId: "admin-1" });
    });
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r21", { episode_id: "ep-r21" }));
    clearHooks();
    const j = await res.json();
    // contract: terminal interleave → converged permanent 200 carrying
    //   persisted outcome — ห้าม 503 retry-loop, ห้าม handoff success
    assert(res.status === 200 && j?.claim_metadata === "already_terminal"
      && j?.claim_outcome?.outcome === "resolved"
      && j?.claim_outcome?.actor_id === "admin-1",
      `terminal interleave → converged 200 + persisted outcome — status=${res.status} body=${JSON.stringify(j)}`);
    assert(j?.outcome?.state !== "assigned" && j?.outcome?.state !== "queued",
      `ห้ามรายงาน handoff success — body=${JSON.stringify(j)}`);
    const meta = metaOf("r21");
    assert(meta?.claim_outcome?.episode_id === "ep-r21"
      && meta?.claim_outcome?.outcome === "resolved"
      && meta?.active_claim_episode_id === null
      && !meta?.assigned_to
      && meta?.status !== "handoff" && meta?.status !== "open",
      `terminal outcome คงอยู่ + active cleared + ownership ไม่เปลี่ยน — meta=${JSON.stringify(meta)}`);
    assert(logsOf("r21", "chat_assigned").length === 0
      && logsOf("r21", "conversation.handoff").length === 0
      && logsOf("r21", "conversation.open").length === 0,
      `rejected claim handoff → audits=0 — logs=${JSON.stringify(mocks.fakeColl("admin_logs").filter((d: any) => d.conversation_id === "r21"))}`);
  });

  await test("R22 newer episode E2 interleave gate↔CAS → E1 ไม่ assign + E2 intact + 409", async () => {
    seedConv("r22"); seedShop(); seedAdmin("admin-1");
    seedMeta("r22", { status: "bot", assigned_to: null });
    onCommitCas(async () => {
      // E2 กลายเป็น active ผ่าน owner จริง: terminalize E1 แล้วเปิด E2
      await (statusSvc as any).applyClaimOutcome("r22", {
        episodeId: "ep-1", outcome: "resolved", actorId: "admin-1" });
      await (statusSvc.statusConversationService as any).recordClaimHandoff({
        conversationId: "r22",
        claim: { customer_order_id: "ep2-order" },
        reason: "warranty_claim", episodeId: "ep2" });
    });
    const res = await (botHandoffRoute as any).POST(
      await mkProdReq("r22", { episode_id: "ep-1",
                               claim: { customer_order_id: "ep1-order" } }));
    clearHooks();
    const j = await res.json();
    assert(res.status === 409 && j?.ok === false
      && j?.claim_metadata === "stale_episode",
      `E1 stale → 409 permanent — status=${res.status} body=${JSON.stringify(j)}`);
    const meta = metaOf("r22");
    assert(meta?.active_claim_episode_id === "ep2"
      && (meta?.bot_claim_info as any)?.customer_order_id === "ep2-order"
      && !meta?.assigned_to
      && meta?.status !== "handoff" && meta?.status !== "open",
      `E2 + metadata ห้ามถูก E1 ทับ + ownership ไม่เปลี่ยน — meta=${JSON.stringify(meta)}`);
    assert(logsOf("r22", "chat_assigned").length === 0
      && logsOf("r22", "conversation.handoff").length === 0
      && logsOf("r22", "conversation.open").length === 0,
      `E1 rejected → ownership/reopen/handoff audits = 0`);
  });

  await test("R23 non-episode request → handoff path เดิม assigned (no episode fence forced)", async () => {
    seedConv("r23"); seedShop(); seedAdmin("admin-1");
    seedMeta("r23", { status: "bot", assigned_to: null });
    const res = await (botHandoffRoute as any).POST(await mkProdReq("r23"));
    const j = await res.json();
    assert(res.status === 200 && j?.outcome?.state === "assigned"
      && j?.outcome?.persisted === true,
      `non-episode → assigned เดิม — status=${res.status} body=${JSON.stringify(j)}`);
    const meta = metaOf("r23");
    assert(meta?.status === "handoff" && meta?.assigned_to === "admin-1"
      && meta?.active_claim_episode_id == null,
      `ownership commit เดิม + ไม่มี episode fields — meta=${JSON.stringify(meta)}`);
    assert(logsOf("r23", "chat_assigned").length === 1
      && logsOf("r23", "conversation.handoff").length === 1,
      `non-episode audit เดิม exactly-once`);
  });

  await test("R24 same active episode ตลอด CAS → assigned + audit once + retry converge", async () => {
    seedConv("r24"); seedShop(); seedAdmin("admin-1");
    seedMeta("r24", { status: "bot", assigned_to: null,
                      active_claim_episode_id: "ep-r24",
                      bot_claim_info: { customer_order_id: "ep24-order" } });
    const res1 = await (botHandoffRoute as any).POST(
      await mkProdReq("r24", { episode_id: "ep-r24" }));
    const j1 = await res1.json();
    assert(res1.status === 200 && j1?.outcome?.state === "assigned",
      `same-ep active → assigned — status=${res1.status} body=${JSON.stringify(j1)}`);
    const meta = metaOf("r24");
    assert(meta?.status === "handoff" && meta?.assigned_to === "admin-1"
      && meta?.active_claim_episode_id === "ep-r24",
      `ownership commit + episode คงอยู่ — meta=${JSON.stringify(meta)}`);
    const res2 = await (botHandoffRoute as any).POST(
      await mkProdReq("r24", { episode_id: "ep-r24" }));
    const j2 = await res2.json();
    assert(res2.status === 200 && j2?.outcome?.state === "assigned",
      `retry → converge — status=${res2.status} body=${JSON.stringify(j2)}`);
    assert(logsOf("r24", "chat_assigned").length === 1
      && logsOf("r24", "conversation.handoff").length === 1,
      `audit exactly-once across retry — assigned=${logsOf("r24", "chat_assigned").length} handoff=${logsOf("r24", "conversation.handoff").length}`);
  });

  await test("R25 expectedClaimEpisodeId with missing meta doc → must NOT upsert-create episode or ownership", async () => {
    seedConv("r25a"); seedConv("r25b"); seedShop(); seedAdmin("admin-1");
    // 1) commitHandoffState ตรงเมื่อไม่มี status_conversation doc
    const c = await statusSvc.commitHandoffState({
      conversationId: "r25a",
      adminId: "admin-1",
      expectedClaimEpisodeId: "ep-ghost",
    });
    assert(c.committed === false && !metaOf("r25a"),
      `commitHandoffState ห้าม upsert สร้าง episode เองเมื่อไม่มี meta doc — got committed=${c.committed} meta=${JSON.stringify(metaOf("r25a"))}`);
    // 2) handoffToAdmin เมื่อไม่มี meta doc แต่ส่ง expectedClaimEpisodeId
    const h = await handoffSvc.handoffToAdmin({
      conversationId: "r25b",
      shopId: "shop-1",
      platform: "shopee",
      expectedClaimEpisodeId: "ep-ghost",
    });
    assert(h.state === "failed" && h.claim_verdict === "stale_episode" && !metaOf("r25b"),
      `handoffToAdmin ห้าม upsert/assign เมื่อไม่มี active episode doc — got ${JSON.stringify(h)} meta=${JSON.stringify(metaOf("r25b"))}`);
  });

  // ── W.source pins (structure only — never cited as runtime behavior) ──

  await test("W47 [source pin] route file contains no direct Mongo access", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    let src = "";
    try {
      src = readFileSync(fileURLToPath(
        new URL("../src/app/api/internal/inbound-lifecycle/route.ts", import.meta.url)), "utf8");
    } catch { /* missing */ }
    assert(src.length > 0, "route missing — RED forward contract");
    assert(!/getCollection|mongoClient|insertOne|updateOne|findOneAndUpdate|deleteOne|deleteMany/.test(src),
      "route must be a transport adapter only — Mongo/CAS lives in the service owner");
  });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n═══ ownership transport contracts: ${passed}/${results.length} passed ═══`);
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) console.log(`  FAIL ${f.name}: ${f.err}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("suite crashed:", e);
  process.exit(1);
});
