// test-botworker-review.ts — H1–H3 per-bubble human review + mock send
// รัน: npx tsx scripts/test-botworker-review.ts
//
// Behavioral tests (Mongo state + route response จริง):
//   A  A|||B|||C → 3 review_bubbles ใน shadow_replies, 0 mock requests
//   B  approve ข้อความเดิม / out-of-order reject
//   C  save edit → pending + persist, 0 mock
//   D  save_and_approve → edited_approved + mock ใช้ข้อความแก้
//   E  reject → 0 mock/0 approved_text
//   F  op dedupe / wrong admin / wrong shop / legacy draft
//   G  mock fail → mock_failed + block ถัดไป + retry ผ่าน
//   H  product card: verified item+shop → product_card request; unverifiable → block
//   I  1/2/3 bubble mock count + sent_text absent เสมอ
import { register } from "node:module";
register(new URL("./test-botworker-review-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-review-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Rt = typeof import("../src/backend/service/botworkerRuntime");
type ReviewRoute = typeof import("../src/app/api/botworker/conversations/[conversationId]/review/route");
type MsgsRoute = typeof import("../src/app/api/botworker/conversations/[conversationId]/messages/route");

let mocks: Mocks, svc: Svc, rt: Rt, reviewRoute: ReviewRoute, msgsRoute: MsgsRoute;

const results: { name: string; ok: boolean; err?: string }[] = [];
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

async function test(name: string, fn: () => Promise<void>) {
  mocks.resetState();
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (e: any) { results.push({ name, ok: false, err: e?.message }); console.log(`FAIL ${name}\n     ${e?.message || e}`); }
}

// ── seeds ──
function seedConv(conversationId = "conv_1", shopId = "shop_1") {
  mocks.fakeColl("conversations").push({
    conversation_id: conversationId, shop_id: shopId, platform: "shopee",
    customer_id: "cust_1", shop_name: "TestShop", status: "bot",
    last_message_timestamp: new Date(), created_at: new Date(), updated_at: new Date(),
  });
}
function seedUserMsg(conversationId: string, messageId: string, text = "hello") {
  mocks.fakeColl("messages").push({
    message_id: messageId, conversation_id: conversationId, shop_id: "shop_1",
    platform: "shopee", role: "user", direction: "in", text,
    created_timestamp: new Date(1_000_000),
  });
}
function seedClaim(messageId: string, conversationId: string, ctx: any) {
  mocks.fakeColl("chat_processing").push({
    _id: `botworker:claim:${messageId}`, message_id: messageId,
    conversation_id: conversationId, shop_id: "shop_1", platform: "shopee",
    status: "processing", owner_id: ctx.owner_id, fencing_token: ctx.fencing_token,
    lease_expires_at: new Date(Date.now() + 120000), attempt: 1, created_at: new Date(),
  });
}
function makeCtx(messageIds: string[]) {
  return {
    claim_id: `botworker:claim:${messageIds[0]}`,
    claim_ids: messageIds.map((id) => `botworker:claim:${id}`),
    owner_id: rt.botworkerRuntime.ownerId, fencing_token: 7,
    lease_expires_at: new Date(Date.now() + 120000),
    batch_id: "botworker:batch:testbatch",
    message_ids: messageIds, lost: false,
  };
}

/** run real pipeline: inbound → processMessage → shadow_replies doc */
async function runBotTurn(conversationId = "conv_1", messageId = "m_1", answer?: string) {
  if (answer !== undefined) mocks.state.callBotAnswer = answer;
  seedConv(conversationId); seedUserMsg(conversationId, messageId);
  const ctx = makeCtx([messageId]); seedClaim(messageId, conversationId, ctx);
  const r = await svc.processMessage({
    message_id: messageId, conversation_id: conversationId, shop_id: "shop_1",
    platform: "shopee", text: "hello", claimContext: ctx,
    shop_ctx: { config_shop_key: "shop_1", shopname: "TestShop" },
  });
  const docs = mocks.fakeColl("shadow_replies");
  assert(docs.length === 1, `expected 1 shadow reply, got ${docs.length} (status=${r.status} ${r.detail})`);
  return docs[0] as any;
}

let opSeq = 0;
async function callReview(conversationId: string, body: Record<string, unknown>) {
  const op = `op_${++opSeq}`;
  const req = {
    url: `http://localhost/api/botworker/conversations/${conversationId}/review`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
  const res = await reviewRoute.POST(req, { params: Promise.resolve({ conversationId }) } as any);
  return { status: res.status, body: await res.json() };
}
async function review(conversationId: string, replyId: string, bubbleId: string, action: string, extra: Record<string, unknown> = {}, opId?: string) {
  return callReview(conversationId, {
    reply_id: replyId, bubble_id: bubbleId, action,
    operation_id: opId || `op_${++opSeq}`, ...extra,
  });
}
async function getReplyDoc() {
  return (await mocks.getCollection("shadow_replies").then((c) => c.find({}).toArray()))[0] as any;
}
const mockEvents = () =>
  mocks.fakeColl("botworker_events").filter((e: any) => e.type === "mock_send");

async function main() {
  mocks = await import("./test-botworker-review-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  rt = await import("../src/backend/service/botworkerRuntime");
  reviewRoute = await import("../src/app/api/botworker/conversations/[conversationId]/review/route");
  msgsRoute = await import("../src/app/api/botworker/conversations/[conversationId]/messages/route");

  // ═══ A — freeze at insert ═══
  await test("A1 A|||B|||C → 3 review_bubbles ใน Mongo + 0 mock request", async () => {
    const doc = await runBotTurn();
    const rb = doc.review_bubbles;
    assert(Array.isArray(rb) && rb.length === 3, `expected 3 bubbles, got ${JSON.stringify(rb)}`);
    assert(rb[0].original_text === "A" && rb[1].original_text === "B" && rb[2].original_text === "C", "original_text wrong");
    assert(rb.every((b: any, i: number) => b.ordinal === i && b.bubble_id === `${doc.shadow_reply_id}:b${i}`), "ids/ordinals not stable");
    assert(rb.every((b: any) => b.decision === "pending" && b.delivery?.state === "not_requested"), "initial state wrong");
    assert(doc.bot_reply_text === "A|||B|||C", "original answer mutated");
    assert(mockEvents().length === 0, "mock request before approval");
  });

  await test("A2 messages route คืน review_bubbles + can_review (designated admin+shop)", async () => {
    await runBotTurn();
    const req = { url: "http://localhost/api/botworker/conversations/conv_1/messages" } as any;
    const res = await msgsRoute.GET(req, { params: Promise.resolve({ conversationId: "conv_1" }) } as any);
    const body = await res.json();
    assert(body.can_review === true, `can_review=${body.can_review}`);
    const bot = body.messages.find((m: any) => m.role === "bot");
    assert(Array.isArray(bot?.review_bubbles) && bot.review_bubbles.length === 3, "review_bubbles missing in API");
    assert(mockEvents().length === 0, "mock request appeared");
  });

  // ═══ B — approve unchanged + ordering ═══
  await test("B1 approve bubble 0 ข้อความเดิม → approved + 1 mock text request", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.bubble.decision === "approved" && r.body.bubble.approved_text === "A", "decision/approved_text wrong");
    assert(r.body.bubble.delivery.state === "mock_sent" && r.body.bubble.delivery.receipt?.provider === "mock", "receipt wrong");
    assert(r.body.bubble.delivery.receipt.delivered === false, "delivered must be false");
    assert(!("sent_text" in r.body.bubble), "sent_text must be absent");
    assert(!("sent_text" in (await getReplyDoc()).review_bubbles[0]), "sent_text persisted");
    assert(mockEvents().length === 1 && mockEvents()[0].metadata.send_part === "text" && mockEvents()[0].metadata.text === "A", "mock log wrong");
    assert(mockEvents()[0].metadata.delivered === false, "log claims delivery");
  });

  await test("B2 approve bubble 1 ก่อน bubble 0 → 409 out of order + 0 mock", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[1].bubble_id, "approve");
    assert(r.status === 409, `expected 409 got ${r.status}`);
    assert(mockEvents().length === 0, "mock request on out-of-order");
    const doc2 = await getReplyDoc();
    assert(doc2.review_bubbles.every((b: any) => b.decision === "pending"), "decision changed on rejected gate");
  });

  await test("B3 reject A → approve B ผ่าน (reject settle gate)", async () => {
    const doc = await runBotTurn();
    const rr = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject");
    assert(rr.status === 200, `reject ${rr.status}`);
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[1].bubble_id, "approve");
    assert(r.status === 200, `approve ${r.status} ${JSON.stringify(r.body)}`);
    assert(mockEvents().length === 1 && mockEvents()[0].metadata.text === "B", "exactly one mock for B");
    const d2 = await getReplyDoc();
    assert(d2.review_bubbles[0].decision === "rejected" && !d2.review_bubbles[0].approved_text, "reject state wrong");
  });

  // ═══ C — save edit ═══
  await test("C1 save edit → pending + persisted + 0 mock", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "A edited" });
    assert(r.status === 200, `status=${r.status}`);
    const d2 = await getReplyDoc();
    assert(d2.review_bubbles[0].edited_text === "A edited", "edit not persisted");
    assert(d2.review_bubbles[0].decision === "pending", "save must stay pending");
    assert(mockEvents().length === 0, "save must not mock-send");
    // จำลอง refresh — อ่าน doc ใหม่ยังเห็น edit
    assert((await getReplyDoc()).review_bubbles[0].edited_text === "A edited", "edit lost on re-read");
  });

  await test("C2 บันทึก edit แล้ว approve ภายหลัง → edited_approved (ไม่ใช่ approved)", async () => {
    const doc = await runBotTurn();
    await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "A edited" });
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 200, `status=${r.status}`);
    assert(r.body.bubble.decision === "edited_approved", `decision=${r.body.bubble.decision}`);
    assert(mockEvents()[0].metadata.text === "A edited", "mock must use saved edit");
  });

  // ═══ D — save_and_approve ═══
  await test("D1 save_and_approve → edited_approved + mock ใช้ข้อความที่แก้", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save_and_approve", { edited_text: "A new" });
    assert(r.status === 200, `status=${r.status}`);
    const d2 = await getReplyDoc();
    assert(d2.review_bubbles[0].decision === "edited_approved" && d2.review_bubbles[0].original_text === "A", "state wrong");
    assert(mockEvents()[0].metadata.text === "A new", "mock text not the edit");
  });

  await test("D2 save empty edit → 422 + 0 mock", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "   " });
    assert(r.status === 422, `status=${r.status}`);
    assert(mockEvents().length === 0, "mock on invalid save");
  });

  // ═══ E/F — reject + dedupe + authz ═══
  await test("E1 reject → 0 mock + no approved_text/sent_text", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject");
    assert(r.status === 200, `status=${r.status}`);
    const b = (await getReplyDoc()).review_bubbles[0];
    assert(b.decision === "rejected" && b.decided_by === "t_admin" && b.decided_at, "reject fields wrong");
    assert(!("approved_text" in b) && !("sent_text" in b), "reject must not set approved/sent text");
    assert(mockEvents().length === 0, "mock on reject");
  });

  await test("F1 กดซ้ำ operation_id เดิม → outcome เดิม + mock request เดียว", async () => {
    const doc = await runBotTurn();
    const op = "op_dup_1";
    const r1 = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve", {}, op);
    const r2 = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve", {}, op);
    assert(r1.status === 200 && r2.status === 200, `status ${r1.status}/${r2.status}`);
    assert(mockEvents().length === 1, `duplicate op created ${mockEvents().length} mock requests`);
  });

  await test("F2 second click operation ใหม่บน bubble เดิม → 409 + mock เดียว", async () => {
    const doc = await runBotTurn();
    await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 409, `expected 409 got ${r.status}`);
    assert(mockEvents().length === 1, "second mock request created");
  });

  await test("F3 wrong admin → 403; wrong shop → 403", async () => {
    const doc = await runBotTurn();
    mocks.state.authAdminId = "evil_admin";
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 403, `expected 403 got ${r.status}`);
    mocks.state.authAdminId = "t_admin";
    mocks.state.config.bot_review_shop_id = "other_shop";
    const r2 = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r2.status === 403, `expected 403 got ${r2.status}`);
    assert(mockEvents().length === 0, "unauthorized created mock");
  });

  await test("F4 legacy draft (ไม่มี review_bubbles) → แสดงได้ แต่ approve → 409", async () => {
    seedConv(); seedUserMsg("conv_1", "m_old");
    mocks.fakeColl("shadow_replies").push({
      shadow_reply_id: "sr_legacy", conversation_id: "conv_1", shop_id: "shop_1",
      platform: "shopee", bot_reply_text: "A|||B", inbound_message_id: "m_old",
      origin: "worker", mode: "standalone", created_at: new Date(),
    });
    const r = await review("conv_1", "sr_legacy", "sr_legacy:b0", "approve");
    assert(r.status === 409, `expected 409 got ${r.status}`);
    assert(mockEvents().length === 0, "legacy draft mock-sent");
  });

  await test("F5 config ไม่ตั้ง designated → 403", async () => {
    const doc = await runBotTurn();
    delete (mocks.state.config as any).bot_review_admin_id;
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 403, `expected 403 got ${r.status}`);
  });

  // ═══ G — mock failure ═══
  await test("G1 mock fail บน bubble 1 → mock_failed + block ถัดไป + retry ผ่าน", async () => {
    const doc = await runBotTurn();
    await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    mocks.state.mockFail = true;
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[1].bubble_id, "approve");
    assert(r.status === 409, `expected 409 got ${r.status}`);
    const d2 = await getReplyDoc();
    assert(d2.review_bubbles[1].delivery.state === "mock_failed", "failure state missing");
    // bubble 2 blocked จนกว่า bubble 1 (index 1) ผ่าน
    mocks.state.mockFail = false;
    const r2 = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[2].bubble_id, "approve");
    assert(r2.status === 409, "later bubble must stay blocked after mock failure");
    // retry bubble index 1 (decision approved + mock_failed → pending? contract: retry failed bubble)
    const d3 = await getReplyDoc();
    assert(d3.review_bubbles[0].delivery.state === "mock_sent" && d3.review_bubbles[1].delivery.state === "mock_failed", "states wrong");
    // retry: ต้อง approve ซ้ำ — แต่ decision ไม่ pending แล้ว → ต้องมี retry path
    // (test นี้จะล็อกว่ามีทาง retry ได้ — implementation ต้องรองรับ)
    const r3 = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[1].bubble_id, "approve");
    assert(r3.status === 200, `retry after mock failure must succeed, got ${r3.status} ${JSON.stringify(r3.body)}`);
    const events = mockEvents();
    assert(events.filter((e: any) => e._id.includes(":b1:")).length === 1, "retry created second request");
  });

  // ═══ H — product card ═══
  await test("H1 verified card → typed product_card mock request", async () => {
    mocks.state.callBotProducts = [{ item_id: "item123", name: "Charger", shop_id: "shop_1" }];
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "send_card", { card_item_id: "item123" });
    assert(r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    const ev = mockEvents().find((e: any) => e.metadata.send_part === "product_card");
    assert(ev && ev.metadata.item_id === "item123", "product_card request missing/wrong item");
    assert(ev.metadata.delivered === false, "card claims delivery");
    const b = (await getReplyDoc()).review_bubbles[0];
    assert(b.card?.item_id === "item123" && b.card.delivery.state === "mock_sent", "card state wrong");
    assert(!("sent_text" in b) && !("sent_text" in (b.card || {})), "sent_text on card");
  });

  await test("H2 missing item → 422; foreign shop → 422; no URL inference", async () => {
    mocks.state.callBotProducts = [{ item_id: "item123", shop_id: "OTHER_SHOP" }];
    const doc = await runBotTurn();
    const r1 = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "send_card", { card_item_id: "item999" });
    assert(r1.status === 422, `missing item → ${r1.status}`);
    const r2 = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "send_card", { card_item_id: "item123" });
    assert(r2.status === 422, `foreign shop → ${r2.status}`);
    assert(mockEvents().length === 0, "unverifiable card sent");
  });

  // ═══ I — counts + no live send ═══
  await test("I1 3 bubbles approved ครบ → 3 mock text requests (1 ต่อ bubble)", async () => {
    const doc = await runBotTurn();
    for (const b of doc.review_bubbles) {
      const r = await review("conv_1", doc.shadow_reply_id, b.bubble_id, "approve");
      assert(r.status === 200, `approve ${b.bubble_id} → ${r.status}`);
    }
    const texts = mockEvents().filter((e: any) => e.metadata.send_part === "text");
    assert(texts.length === 3, `expected 3 text requests got ${texts.length}`);
    assert(texts.every((e: any) => e.metadata.provider === "mock" && e.metadata.delivered === false), "receipt wrong");
    const d2 = await getReplyDoc();
    assert(d2.review_bubbles.every((b: any) => !("sent_text" in b)), "sent_text appeared");
    assert(mocks.fakeColl("botworker_messages").length === 0, "mock polluted sandbox composer");
    assert(mocks.fakeColl("messages").filter((m: any) => m.direction === "out").length === 0, "mock wrote messages_shp");
  });

  await test("I2 workflow delivered reply (storeWorkflowDelivered จริง) มี review_bubbles + review ได้", async () => {
    // workflow trigger("wfkw") → let_ai_respond → settleWorkflowResult → storeWorkflowDelivered
    const conv = "conv_wf";
    seedConv(conv); seedUserMsg(conv, "m_wf", "wfkw hi");
    mocks.state.config.workflow_enabled = true;
    mocks.state.callBotAnswer = "W1|||W2";
    mocks.fakeColl("workflows").push({
      workflow_id: "wf_t", name: "wf_t", enabled: true, status: "published", is_deleted: false,
      shop_ids: ["shop_1"], platforms: ["shopee"], trigger_frequency: "every_time",
      false_branch_policy: "exit_to_bot",
      nodes: [
        { node_id: "n1", type: "trigger", subtype: "message_content", config: { keywords: ["wfkw"] }, position: { x: 0, y: 0 } },
        { node_id: "n2", type: "action", subtype: "let_ai_respond", config: {}, position: { x: 0, y: 0 } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "n1", target_node_id: "n2" }],
      priority: 1, version: 1, created_by: "t", created_at: new Date(), updated_at: new Date(),
    });
    const ctx = makeCtx(["m_wf"]); seedClaim("m_wf", conv, ctx);
    const r = await svc.processMessage({
      message_id: "m_wf", conversation_id: conv, shop_id: "shop_1",
      platform: "shopee", text: "wfkw hi", claimContext: ctx,
      shop_ctx: { config_shop_key: "shop_1", shopname: "TestShop" },
    });
    const wfDocs = mocks.fakeColl("shadow_replies").filter((d: any) => d.origin === "workflow");
    assert(wfDocs.length > 0, `no workflow reply persisted (status=${r.status} ${r.detail})`);
    const doc = wfDocs[0] as any;
    assert(Array.isArray(doc.review_bubbles) && doc.review_bubbles.length === 2,
      `workflow reply missing review_bubbles: ${JSON.stringify(doc.review_bubbles)}`);
    const rr = await review(conv, doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(rr.status === 200, `workflow bubble approve → ${rr.status} ${JSON.stringify(rr.body)}`);
    assert(mockEvents().length === 1 && mockEvents()[0].metadata.text === "W1", "workflow mock request wrong");
  });

  // ═══ J — concurrency + op binding + crash recovery (independent review findings) ═══

  await test("J1 concurrent save_and_approve 2 requests ข้อความต่างกัน → winner เดียว + mock event ตรง approved_text", async () => {
    const doc = await runBotTurn();
    const b0 = doc.review_bubbles[0].bubble_id;
    const rid = doc.shadow_reply_id;
    const [r1, r2] = await Promise.all([
      review("conv_1", rid, b0, "save_and_approve", { edited_text: "WINNER text" }),
      review("conv_1", rid, b0, "save_and_approve", { edited_text: "LOSER text" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert(statuses.join() === "200,409", `expected 200+409 got ${statuses} (${JSON.stringify([r1.body, r2.body])})`);
    const events = mockEvents();
    assert(events.length === 1, `expected 1 mock event got ${events.length}`);
    const persisted = (await getReplyDoc()).review_bubbles[0];
    assert(persisted.approved_text === events[0].metadata.text,
      `approved_text "${persisted.approved_text}" ≠ mock text "${events[0].metadata.text}"`);
    assert(events[0].metadata.text === "WINNER text", `loser text logged as request: ${events[0].metadata.text}`);
    assert(!mockEvents().some((e: any) => e.metadata.text === "LOSER text"), "loser request logged");
  });

  await test("J2 operation id ซ้ำ request ต่าง → 409 ไม่มี state/mock เปลี่ยน", async () => {
    const doc = await runBotTurn();
    const b0 = doc.review_bubbles[0].bubble_id;
    const op = "op_bind_1";
    const r1 = await review("conv_1", doc.shadow_reply_id, b0, "save", { edited_text: "v1" }, op);
    assert(r1.status === 200, `first ${r1.status}`);
    // op id เดิม + action ต่าง
    const r2 = await review("conv_1", doc.shadow_reply_id, b0, "reject", {}, op);
    assert(r2.status === 409, `different action → ${r2.status}`);
    // op id เดิม + payload ต่าง
    const r3 = await review("conv_1", doc.shadow_reply_id, b0, "save", { edited_text: "v2" }, op);
    assert(r3.status === 409, `different payload → ${r3.status}`);
    // op id เดิม + request เดิม → outcome เดิม
    const r4 = await review("conv_1", doc.shadow_reply_id, b0, "save", { edited_text: "v1" }, op);
    assert(r4.status === 200 && r4.body.bubble.edited_text === "v1", `same request → ${r4.status}`);
    const d = await getReplyDoc();
    assert(d.review_bubbles[0].decision === "pending" && d.review_bubbles[0].edited_text === "v1", "state changed by rejected ops");
    assert(mockEvents().length === 0, "rejected ops created mock events");
  });

  await test("J3 crash หลัง decision CAS ก่อน mock (decided+not_requested) → retry ส่ง persisted text เท่านั้น", async () => {
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    // จำลอง crash: decided + approved_text + delivery not_requested (เขียน state ตรง = persisted crash window)
    const coll = mocks.fakeColl("shadow_replies")[0] as any;
    coll.review_bubbles[0] = {
      ...coll.review_bubbles[0],
      decision: "edited_approved", decided_by: "t_admin", decided_at: new Date(),
      approved_text: "PERSISTED edit", edited_text: "PERSISTED edit",
      delivery: { state: "not_requested" },
    };
    const r = await review("conv_1", rid, b0, "approve", { edited_text: "FORGED new text" });
    assert(r.status === 200, `retry ${r.status} ${JSON.stringify(r.body)}`);
    const events = mockEvents();
    assert(events.length === 1 && events[0].metadata.text === "PERSISTED edit",
      `retry must send persisted text, got ${JSON.stringify(events.map((e: any) => e.metadata.text))}`);
    const d = await getReplyDoc();
    assert(d.review_bubbles[0].delivery.state === "mock_sent" && d.review_bubbles[0].approved_text === "PERSISTED edit", "state wrong");
  });

  await test("J4 crash หลัง mock insert ก่อน delivery CAS → retry ไม่สร้าง event ซ้ำ", async () => {
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const coll = mocks.fakeColl("shadow_replies")[0] as any;
    coll.review_bubbles[0] = {
      ...coll.review_bubbles[0],
      decision: "approved", decided_by: "t_admin", decided_at: new Date(),
      approved_text: "A", delivery: { state: "not_requested" },
    };
    // จำลอง crash: mock event insert แล้วแต่ delivery ยังไม่ mock_sent
    mocks.fakeColl("botworker_events").push({
      _id: `mocksend:${rid}:${b0}:text`, event_id: `mocksend:${rid}:${b0}:text`,
      conversation_id: "conv_1", type: "mock_send", actor: "t_admin",
      shop_id: "shop_1", platform: "shopee",
      metadata: { reply_id: rid, bubble_id: b0, send_part: "text", text: "A", provider: "mock", delivered: false },
      created_at: new Date(),
    });
    const r = await review("conv_1", rid, b0, "approve");
    assert(r.status === 200, `retry ${r.status}`);
    assert(mockEvents().length === 1, `expected 1 event (no dup) got ${mockEvents().length}`);
    assert((await getReplyDoc()).review_bubbles[0].delivery.state === "mock_sent", "delivery not settled");
  });

  await test("J5 card cases: dup send → 409, card+text approve → ทั้งคู่สำเร็จแยก request", async () => {
    mocks.state.callBotProducts = [{ item_id: "it1", name: "P1", shop_id: "shop_1" }];
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const r1 = await review("conv_1", rid, b0, "send_card", { card_item_id: "it1" });
    assert(r1.status === 200, `card ${r1.status}`);
    const r2 = await review("conv_1", rid, b0, "send_card", { card_item_id: "it1" });
    assert(r2.status === 409, `dup card → ${r2.status}`);
    const r3 = await review("conv_1", rid, b0, "approve");
    assert(r3.status === 200, `text approve after card → ${r3.status}`);
    const parts = mockEvents().map((e: any) => e.metadata.send_part).sort();
    assert(parts.join() === "product_card,text", `expected card+text got ${parts}`);
  });

  await test("J6 UI seam: mergeBubbleResult merge เฉพาะ bubble เป้าหมาย — act failure path ไม่แตะ state", async () => {
    const { mergeBubbleResult } = await import("../src/lib/reviewUi");
    const msgs = [{
      id: "r1", review_bubbles: [
        { bubble_id: "r1:b0", decision: "pending" },
        { bubble_id: "r1:b1", decision: "pending" },
      ] as any[],
    }];
    const updated = { bubble_id: "r1:b1", decision: "rejected" } as any;
    const merged = mergeBubbleResult(msgs as any[], "r1", updated);
    assert(merged[0].review_bubbles![0].decision === "pending", "wrong bubble touched");
    assert((merged[0].review_bubbles![1] as any).decision === "rejected", "target not merged");
    assert(msgs[0].review_bubbles![1].decision === "pending", "in-place mutation");
    // editor-close contract: page act() คืน boolean และ setEditingId(null) เฉพาะตอน true —
    //   failure → editor เปิด + draft คง + error แสดง (component gate verified ใน diff; ไม่มี DOM harness)
  });

  await test("J7 crash retry ด้วย operation_id เดิม (review_op in_progress) → กู้คำขอเดิม + persisted text", async () => {
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const OP = "op_crash_sna_1";
    // จำลอง crash window เต็ม: op เดิมค้าง in_progress + request binding เดิม
    //   + บับเบิ้ลตัดสินแล้ว (edited_approved) แต่ delivery ยังไม่ mock_sent
    mocks.fakeColl("botworker_events").push({
      _id: `reviewop:${OP}`, event_id: `reviewop:${OP}`,
      conversation_id: "conv_1", type: "review_op", actor: "t_admin",
      shop_id: "shop_1", platform: "shopee",
      metadata: {
        request: {
          actor: "t_admin", shop_id: "shop_1", conversation_id: "conv_1",
          reply_id: rid, bubble_id: b0, action: "save_and_approve",
          edited_text: "PERSISTED s&a edit", card_item_id: null,
        },
        status: "in_progress",
      },
      created_at: new Date(),
    });
    const coll = mocks.fakeColl("shadow_replies")[0] as any;
    coll.review_bubbles[0] = {
      ...coll.review_bubbles[0],
      decision: "edited_approved", decided_by: "t_admin", decided_at: new Date(),
      approved_text: "PERSISTED s&a edit", edited_text: "PERSISTED s&a edit",
      delivery: { state: "not_requested" },
    };
    // retry ด้วย request เดิมเป๊ะ (op id เดิม + payload เดิม = คำขอเดิมหลัง crash)
    const r = await review("conv_1", rid, b0, "save_and_approve", { edited_text: "PERSISTED s&a edit" }, OP);
    assert(r.status === 200, `same-op retry → ${r.status} ${JSON.stringify(r.body)}`);
    // op ทำเสร็จ + outcome ถูกบันทึก
    const opDoc = mocks.fakeColl("botworker_events").find((e: any) => e._id === `reviewop:${OP}`) as any;
    assert(opDoc.metadata.status === "done" && opDoc.metadata.outcome?.ok === true, "op not completed");
    // mock event เดียว + text = persisted approved_text
    const events = mockEvents();
    assert(events.length === 1 && events[0].metadata.text === "PERSISTED s&a edit",
      `expected 1 mock with persisted text, got ${JSON.stringify(events.map((e: any) => e.metadata.text))}`);
    // retry อีกครั้งด้วย op เดิม → outcome เดิม + event ยัง 1
    const r2 = await review("conv_1", rid, b0, "save_and_approve", { edited_text: "PERSISTED s&a edit" }, OP);
    assert(r2.status === 200 && r2.body.bubble.delivery.state === "mock_sent", "replay not idempotent");
    assert(mockEvents().length === 1, "duplicate mock event on replay");
  });

  await test("J8 rejected bubble → send_card = 409 + 0 card request", async () => {
    mocks.state.callBotProducts = [{ item_id: "it1", shop_id: "shop_1" }];
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const rr = await review("conv_1", rid, b0, "reject");
    assert(rr.status === 200, `reject ${rr.status}`);
    const r = await review("conv_1", rid, b0, "send_card", { card_item_id: "it1" });
    assert(r.status === 409, `send_card on rejected → ${r.status}`);
    assert(mockEvents().length === 0, "card request on rejected bubble");
  });

  // ═══ K — review fixes (Critical/Important จาก independent review) ═══

  await test("K1 send_card real-shaped product {shop:'TestShop'} → 200 mock_sent (shop verify ผ่าน conv.shop_name)", async () => {
    mocks.state.callBotProducts = [{ item_id: "real1", name: "Charger", shop: "TestShop", price: 199 }];
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const r = await review("conv_1", rid, b0, "send_card", { card_item_id: "real1" });
    assert(r.status === 200, `real-shaped card → ${r.status} ${JSON.stringify(r.body)}`);
    const ev = mockEvents().find((e: any) => e.metadata.send_part === "product_card");
    assert(ev && ev.metadata.item_id === "real1" && ev.metadata.delivered === false, "card event wrong");
    const b = r.body.bubble;
    assert(b.card?.item_id === "real1" && b.card.delivery.state === "mock_sent", "card state wrong");
  });

  await test("K2 send_card foreign shop name → 422 blocked", async () => {
    mocks.state.callBotProducts = [{ item_id: "real1", name: "Charger", shop: "OtherShopName" }];
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "send_card", { card_item_id: "real1" });
    assert(r.status === 422, `foreign shop → ${r.status}`);
    assert(mockEvents().length === 0, "foreign card sent");
  });

  await test("K3 send_card missing/empty card_item_id → 422", async () => {
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const r = await review("conv_1", rid, b0, "send_card", {});
    assert(r.status === 422, `empty item → ${r.status}`);
    const r2 = await review("conv_1", rid, b0, "send_card", { card_item_id: "   " });
    assert(r2.status === 422, `blank item → ${r2.status}`);
  });

  await test("K4 deleted draft (deleted_at set) → 404 not_found", async () => {
    const doc = await runBotTurn();
    (mocks.fakeColl("shadow_replies")[0] as any).deleted_at = new Date();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert([403, 404].includes(r.status), `deleted draft → ${r.status}`);
  });

  await test("K5 reject after card mock_sent → 409", async () => {
    mocks.state.callBotProducts = [{ item_id: "it1", shop_id: "shop_1" }];
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const rc = await review("conv_1", rid, b0, "send_card", { card_item_id: "it1" });
    assert(rc.status === 200, `card ${rc.status}`);
    const rr = await review("conv_1", rid, b0, "reject");
    assert(rr.status === 409, `reject after card → ${rr.status}`);
    const d = await getReplyDoc();
    assert(d.review_bubbles[0].decision === "pending", "reject overwrote card-sent bubble");
  });

  await test("K6 expectedUpdatedAt mismatch → 409; match → 200", async () => {
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const stale = await review("conv_1", rid, b0, "approve", { updated_at: new Date(0).toISOString() });
    assert(stale.status === 409, `stale version → ${stale.status}`);
    const fresh = (await getReplyDoc()).updated_at;
    const okR = await review("conv_1", rid, b0, "approve", { updated_at: new Date(fresh).toISOString() });
    assert(okR.status === 200, `matching version → ${okR.status} ${JSON.stringify(okR.body)}`);
  });

  await test("K7 op outcome CAS — finisher เดียวเขียน outcome (same-opId replay ไม่ทับ)", async () => {
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const OP = "op_k7_1";
    const r1 = await review("conv_1", rid, b0, "approve", {}, OP);
    assert(r1.status === 200, `first → ${r1.status}`);
    const opDoc = mocks.fakeColl("botworker_events").find((e: any) => e._id === `reviewop:${OP}`) as any;
    assert(opDoc.metadata.status === "done" && opDoc.metadata.outcome?.ok === true, "outcome not persisted");
    // same opId + same payload → outcome เดิม (200) ไม่ถูกเขียนทับด้วย conflict
    const r2 = await review("conv_1", rid, b0, "approve", {}, OP);
    assert(r2.status === 200, `replay → ${r2.status}`);
    const opDoc2 = mocks.fakeColl("botworker_events").find((e: any) => e._id === `reviewop:${OP}`) as any;
    assert(opDoc2.metadata.outcome?.ok === true, "outcome overwritten");
  });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => { console.error("harness error", e); process.exit(1); });
