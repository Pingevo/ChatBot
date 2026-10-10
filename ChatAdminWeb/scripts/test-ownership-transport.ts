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
let responseStatsLib: typeof import("../src/backend/lib/responseStats");

// ── main ─────────────────────────────────────────────────────

async function main() {
  mocks = await import("./test-ownership-transport-mocks.mjs");
  statusSvc = await import("../src/backend/service/statusConversationService");
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

  await test("B1 manualAssign → meta{status:handoff,assigned_to} persist ก่อน return", async () => {
    const ok = await statusSvc.manualAssign("b1", "admin-1", null, "actor-1");
    assert(ok === true, "manualAssign should succeed");
    const m = metaOf("b1");
    assert(m?.status === "handoff" && m?.assigned_to === "admin-1",
      `meta=${JSON.stringify(m)} expected handoff/admin-1`);
  });

  await test("B1b manualAssign ทับเมื่อ previous ไม่ตรง → false + meta ไม่เปลี่ยน", async () => {
    seedMeta("b1b", { status: "handoff", assigned_to: "admin-1" });
    const ok = await statusSvc.manualAssign("b1b", "admin-2", "admin-9-wrong", "actor-1");
    assert(ok === false, "manualAssign with wrong previous should fail (CAS)");
    const m = metaOf("b1b");
    assert(m?.assigned_to === "admin-1", "meta.assigned_to must stay admin-1");
  });

  await test("B2 tryAssign → meta handoff+assigned_to; second tryAssign → false", async () => {
    const ok1 = await statusSvc.tryAssign("b2", "admin-1", "equal_global");
    assert(ok1 === true, "first tryAssign should succeed");
    const ok2 = await statusSvc.tryAssign("b2", "admin-2", "equal_global");
    assert(ok2 === false, "second tryAssign must lose (atomic guard)");
    const m = metaOf("b2");
    assert(m?.assigned_to === "admin-1" && m?.status === "handoff",
      `meta=${JSON.stringify(m)} expected admin-1/handoff`);
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

  await test("B5 setPendingAssignment(true) → meta{handoff,pending,assigned_to:null}", async () => {
    await statusSvc.setPendingAssignment("b5", true, "no_available_admin");
    const m = metaOf("b5");
    assert(m?.status === "handoff" && m?.pending_assignment === true && m?.assigned_to === null,
      `meta=${JSON.stringify(m)} expected handoff+pending+unassigned`);
  });

  await test("B6 assignPendingTicket → assign เฉพาะ pending; non-pending → false", async () => {
    await statusSvc.setPendingAssignment("b6a", true);
    const ok = await statusSvc.assignPendingTicket("b6a", "admin-1", "distributor");
    assert(ok === true, "assignPendingTicket on pending should succeed");
    const m = metaOf("b6a");
    assert(m?.assigned_to === "admin-1" && m?.pending_assignment === false,
      `meta=${JSON.stringify(m)} expected assigned+pending cleared`);
    const ok2 = await statusSvc.assignPendingTicket("b6b", "admin-1", "distributor");
    assert(ok2 === false, "assignPendingTicket on non-pending must fail");
  });

  await test("B7 meta write ที่ไม่ใช่ ownership → meta doc ไม่มี status (metadata ≠ ownership)", async () => {
    await statusSvc.setPendingAssignment("b7", false);
    const m = metaOf("b7");
    assert(m && m.status === undefined && m.assigned_to === undefined,
      `meta=${JSON.stringify(m)} — non-ownership write must not fabricate status/owner`);
  });

  await test("B9 autoAssign → persist meta{assigned_to,handoff} ผ่าน tryAssign", async () => {
    seedShop();
    seedAdmin("admin-1");
    const agentId = await assignSvc.autoAssignConversation({
      conversation_id: "b9", shop_id: "shop-1", platform: "shopee", assigned_to: null,
    });
    assert(agentId === "admin-1", `autoAssign should pick admin-1, got ${agentId}`);
    const m = metaOf("b9");
    assert(m?.assigned_to === "admin-1" && m?.status === "handoff",
      `meta=${JSON.stringify(m)} expected admin-1/handoff`);
  });

  await test("B10 raw assigned_to stale + meta ว่าง → autoAssign ยังจ่าย (meta = authority)", async () => {
    seedShop();
    seedAdmin("admin-1");
    const agentId = await assignSvc.autoAssignConversation({
      conversation_id: "b10", shop_id: "shop-1", platform: "shopee",
      assigned_to: "stale-ghost-from-dump",
    });
    assert(agentId === "admin-1",
      `raw stale assigned_to must NOT block assign (meta is authority) — got ${agentId}`);
    assert(metaOf("b10")?.assigned_to === "admin-1", "meta must record admin-1");
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
    assert(r.assignedTo === null, "no admin → assignedTo null");
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
    assert(r.assignedTo === "admin-1", `handoff should assign admin-1, got ${r.assignedTo}`);
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
      message_id: "m-b14", conversation_id: "b14", shop_id: "shop-1",
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
      message_id: "m-b15", conversation_id: "b15", shop_id: "shop-1",
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
    seedMetricSet("d", { last_message_timestamp: new Date() });
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
