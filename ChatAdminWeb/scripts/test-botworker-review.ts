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
import { diffLines } from "../src/lib/textDiff";

type Mocks = typeof import("./test-botworker-review-mocks.mjs");
type Svc = typeof import("../src/backend/service/botWorkerService");
type Rt = typeof import("../src/backend/service/botworkerRuntime");
type ReviewRoute = typeof import("../src/app/api/botworker/conversations/[conversationId]/review/route");
type HandoffRoute = typeof import("../src/app/api/botworker/conversations/[conversationId]/handoff-review/route");
type MsgsRoute = typeof import("../src/app/api/botworker/conversations/[conversationId]/messages/route");
type AnalyticsService = typeof import("../src/backend/service/botPerformanceService");
type AnalyticsRoute = typeof import("../src/app/api/bot-performance/route");
type CloseHistoryRoute = typeof import("../src/app/api/botworker/conversations/[conversationId]/close-history/route");

let closeHistoryRoute: CloseHistoryRoute;
let mocks: Mocks, svc: Svc, rt: Rt, reviewRoute: ReviewRoute, handoffRoute: HandoffRoute, msgsRoute: MsgsRoute, analyticsService: AnalyticsService, analyticsRoute: AnalyticsRoute;

const results: { name: string; ok: boolean; err?: string }[] = [];
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

async function test(name: string, fn: () => Promise<void>) {
  mocks.resetState();
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (e: any) { results.push({ name, ok: false, err: e?.message }); console.log(`FAIL ${name}\n     ${e?.message || e}`); }
}

// ── seeds ──
const MOCK_PLATFORM = "tiktok" as const;

function seedConv(conversationId = "conv_1", shopId = "shop_1", platform: "shopee" | "tiktok" | "lazada" = MOCK_PLATFORM) {
  mocks.fakeColl("conversations").push({
    conversation_id: conversationId, shop_id: shopId, platform,
    customer_id: "cust_1", shop_name: "TestShop", status: "bot",
    last_message_timestamp: new Date(), created_at: new Date(), updated_at: new Date(),
  });
}
function seedUserMsg(conversationId: string, messageId: string, text = "hello", shopId = "shop_1", platform: "shopee" | "tiktok" | "lazada" = MOCK_PLATFORM) {
  mocks.fakeColl("messages").push({
    message_id: messageId, conversation_id: conversationId, shop_id: shopId,
    platform, role: "user", direction: "in", text,
    created_timestamp: new Date(1_000_000),
  });
}
function seedClaim(messageId: string, conversationId: string, ctx: any, shopId = "shop_1", platform: "shopee" | "tiktok" | "lazada" = MOCK_PLATFORM) {
  mocks.fakeColl("chat_processing").push({
    _id: `botworker:claim:${messageId}`, message_id: messageId,
    conversation_id: conversationId, shop_id: shopId, platform,
    status: "processing", owner_id: ctx.owner_id, fencing_token: ctx.fencing_token,
    lease_expires_at: new Date(Date.now() + 120000), attempt: 1, created_at: new Date(),
  });
}
function seedAdmin(adminId: string, name: string, overrides: Record<string, unknown> = {}) {
  mocks.fakeColl("admins").push({
    admin_id: adminId, name, username: adminId, role: "admin", active: true,
    is_accepting_chats: true, is_active_agent: true, created_at: new Date(), ...overrides,
  });
}
function makeCtx(messageIds: string[]) {
  return {
    claim_id: `botworker:claim:${messageIds[0]}`,
    claim_ids: messageIds.map((id) => `botworker:claim:${id}`),
    owner_id: rt.botworkerRuntime.ownerId, fencing_token: 7,
    lease_expires_at: new Date(Date.now() + 120000),
    batch_id: `botworker:batch:${messageIds[0]}`,
    message_ids: messageIds, lost: false,
  };
}

/** run real pipeline: inbound → processMessage → shadow_replies doc */
async function runBotTurn(
  conversationId = "conv_1",
  messageId = "m_1",
  answer?: string,
  options: { shopId?: string; platform?: "shopee" | "tiktok" | "lazada"; expectReply?: boolean } = {},
) {
  const shopId = options.shopId || "shop_1";
  const platform = options.platform || MOCK_PLATFORM;
  if (answer !== undefined) mocks.state.callBotAnswer = answer;
  seedConv(conversationId, shopId, platform);
  seedUserMsg(conversationId, messageId, "hello", shopId, platform);
  const ctx = makeCtx([messageId]); seedClaim(messageId, conversationId, ctx, shopId, platform);
  const r = await svc.processMessage({
    message_id: messageId, conversation_id: conversationId, shop_id: shopId,
    platform, text: "hello", claimContext: ctx,
    shop_ctx: { config_shop_key: shopId, shopname: "TestShop" },
  });
  (mocks.state as any).lastProcessResult = r;
  const docs = mocks.fakeColl("shadow_replies").filter((row: any) => row.conversation_id === conversationId);
  if (options.expectReply !== false) assert(docs.length === 1, `expected 1 shadow reply, got ${docs.length} (status=${r.status} ${r.detail})`);
  return docs[0] as any;
}

let opSeq = 0;
async function callReview(conversationId: string, body: Record<string, unknown>) {
  const op = `op_${++opSeq}`;
  const req = {
    url: `http://localhost/api/botworker/conversations/${conversationId}/review`,
    headers: { get: (name: string) => name.toLowerCase() === "x-shopee-send-mode" ? (mocks.state.shopeeSendEnabled ? "on" : "off") : null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
  const res = await reviewRoute.POST(req, { params: Promise.resolve({ conversationId }) } as any);
  if (!res) throw new Error("review route returned no response");
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
async function callHandoffReview(conversationId: string, replyId: string, body?: Record<string, unknown>, messageId?: string) {
  const messageQuery = messageId ? `&message_id=${encodeURIComponent(messageId)}` : "";
  const req = {
    url: `http://localhost/api/botworker/conversations/${conversationId}/handoff-review?reply_id=${encodeURIComponent(replyId)}${messageQuery}`,
    headers: { get: () => null },
    json: async () => body || {},
    text: async () => JSON.stringify(body || {}),
  } as any;
  const params = { params: Promise.resolve({ conversationId }) } as any;
  const res = body
    ? await handoffRoute.POST(req, params)
    : await handoffRoute.GET(req, params);
  if (!res) throw new Error("handoff review route returned no response");
  return { status: res.status, body: await res.json() };
}
const mockEvents = () =>
  mocks.fakeColl("botworker_events").filter((e: any) => e.type === "mock_send");

async function main() {
  mocks = await import("./test-botworker-review-mocks.mjs");
  svc = await import("../src/backend/service/botWorkerService");
  rt = await import("../src/backend/service/botworkerRuntime");
  reviewRoute = await import("../src/app/api/botworker/conversations/[conversationId]/review/route");
  handoffRoute = await import("../src/app/api/botworker/conversations/[conversationId]/handoff-review/route");
  msgsRoute = await import("../src/app/api/botworker/conversations/[conversationId]/messages/route");
  analyticsService = await import("../src/backend/service/botPerformanceService");
  analyticsRoute = await import("../src/app/api/bot-performance/route");
  closeHistoryRoute = await import("../src/app/api/botworker/conversations/[conversationId]/close-history/route");

  await test("review diff treats a full Thai answer replacement as removed and added lines", async () => {
    const before = "รับทราบค่ะ ข้อมูลที่ลูกค้าให้มา: ชื่อ-นามสกุล: สวัสดีวันจันทร์\nรวบรวมแจ้งข้อมูลเพิ่มเติมด้วยนะคะ: เบอร์โทร\nและหากมีรูปหรือวิดีโอแสดงอาการ ส่งมาได้เลยค่ะ";
    const after = "สวัสดีฮ้าฟฟู๋ววว";
    assert(JSON.stringify(diffLines(before, after)) === JSON.stringify([{ op: "del", text: before }, { op: "add", text: after }]), "full rewrite must not preserve arbitrary matching fragments");
  });

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

  await test("A2 messages route ให้แอดมินที่เข้าถึง BotWorker ตรวจได้แม้ไม่มี fixed reviewer", async () => {
    await runBotTurn();
    delete (mocks.state.config as any).bot_review_admin_id;
    mocks.state.authAdminId = "other_admin";
    const req = { url: "http://localhost/api/botworker/conversations/conv_1/messages" } as any;
    const res = await msgsRoute.GET(req, { params: Promise.resolve({ conversationId: "conv_1" }) } as any);
    const body = await res.json();
    assert(body.can_review === true, `can_review=${body.can_review}`);
    const bot = body.messages.find((m: any) => m.role === "bot");
    assert(Array.isArray(bot?.review_bubbles) && bot.review_bubbles.length === 3, "review_bubbles missing in API");
    assert(bot.inbound_message_id === "m_1", "inbound turn identity missing from bot reply API");
    assert(mockEvents().length === 0, "mock request appeared");
  });

  await test("A3 page-authorized admin can inspect review drafts across BotWorker shops", async () => {
    const doc = await runBotTurn("conv_shop_2", "m_shop_2", undefined, { shopId: "shop_2" });
    const req = { url: "http://localhost/api/botworker/conversations/conv_shop_2/messages" } as any;
    const res = await msgsRoute.GET(req, { params: Promise.resolve({ conversationId: "conv_shop_2" }) } as any);
    const body = await res.json();
    assert(body.can_review === true, "reviewer was incorrectly fenced to one pilot shop");
    const bot = body.messages.find((m: any) => m.role === "bot");
    assert(Array.isArray(bot?.review_bubbles) && bot.review_bubbles.length === 3, "cross-shop review draft was hidden");
    assert(doc.shop_id === "shop_2", "fixture did not use second shop");
  });

  await test("A4 page access denied blocks review, handoff preview, messages and analysis", async () => {
    const doc = await runBotTurn();
    mocks.state.pageAccessAllowed = false;
    const messages = await msgsRoute.GET({ url: "http://localhost/api/botworker/conversations/conv_1/messages" } as any,
      { params: Promise.resolve({ conversationId: "conv_1" }) } as any);
    const reviewed = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "blocked" });
    const handoff = await callHandoffReview("conv_1", doc.shadow_reply_id);
    const analysis = await analyticsRoute.GET({ url: "http://localhost/api/bot-performance?from=2026-11-25&to=2026-11-25" } as any);
    assert([messages.status, reviewed.status, handoff.status, analysis.status].every((status) => status === 403),
      `page access bypass: ${[messages.status, reviewed.status, handoff.status, analysis.status].join()}`);
    assert(mockEvents().length === 0, "denied page access sent a message");
  });

  await test("A5 analysis is available to another page-authorized admin without fixed reviewer", async () => {
    delete (mocks.state.config as any).bot_review_admin_id;
    mocks.state.authAdminId = "other_admin";
    const res = await analyticsRoute.GET({ url: "http://localhost/api/bot-performance?view=items&from=2026-11-25&to=2026-11-25" } as any);
    assert(res.status === 200, `analysis -> ${res.status}`);
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
    const rr = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject", { rejection_category: "ควรส่งแอดมิน", rejection_reason: "ส่งต่อเคสให้ตรวจ" });
    assert(rr.status === 200, `reject ${rr.status}`);
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[1].bubble_id, "approve");
    assert(r.status === 200, `approve ${r.status} ${JSON.stringify(r.body)}`);
    assert(mockEvents().length === 1 && mockEvents()[0].metadata.text === "B", "exactly one mock for B");
    const d2 = await getReplyDoc();
    assert(d2.review_bubbles[0].decision === "rejected" && !d2.review_bubbles[0].approved_text, "reject state wrong");
  });

  // ═══ C — save edit ═══
  await test("C0 save edit requires reason category and explanation", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "A edited" });
    assert(r.status === 422, `missing edit reason -> ${r.status}`);
    const invalidCategory = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", {
      edited_text: "A edited", reason_category: "เหตุผลอื่น", reason_text: "ข้อมูลไม่ตรง",
    });
    assert(invalidCategory.status === 422, `unknown edit category -> ${invalidCategory.status}`);
    const blankExplanation = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", {
      edited_text: "A edited", reason_category: "สเปคผิด", reason_text: "  ",
    });
    assert(blankExplanation.status === 422, `blank edit explanation -> ${blankExplanation.status}`);
    const bubble = (await getReplyDoc()).review_bubbles[0];
    assert(bubble.edited_text === undefined && bubble.edit_history?.length !== 1, "invalid edit reason changed draft history");
    assert(mockEvents().length === 0, "invalid edit reason caused delivery");
  });

  await test("C0b save edit stores category and explanation on its revision", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", {
      edited_text: "A edited", reason_category: "สเปคผิด", reason_text: "สเปคของรุ่นนี้ไม่ตรงกับคำตอบเดิม",
    });
    assert(r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    const revision = (await getReplyDoc()).review_bubbles[0].edit_history?.[0];
    assert(revision?.reason_category === "สเปคผิด", "edit category missing from revision");
    assert(revision?.reason_text === "สเปคของรุ่นนี้ไม่ตรงกับคำตอบเดิม", "edit explanation missing from revision");
    assert(revision?.before_text === "A" && revision?.after_text === "A edited", "edit diff was not preserved");
  });

  await test("C1 save edit → pending + persisted + 0 mock", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "A edited", reason_category: "ตอบไม่ได้", reason_text: "เติมข้อมูลที่ตอบได้ให้ชัดเจน" });
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
    await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "A edited", reason_category: "สเปคผิด", reason_text: "สเปคไม่ตรง" });
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 200, `status=${r.status}`);
    assert(r.body.bubble.decision === "edited_approved", `decision=${r.body.bubble.decision}`);
    assert(mockEvents()[0].metadata.text === "A edited", "mock must use saved edit");
  });

  // ═══ D — save_and_approve ═══
  await test("D1 save_and_approve → edited_approved + mock ใช้ข้อความที่แก้", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save_and_approve", { edited_text: "A new", reason_category: "ตอบไม่ได้", reason_text: "เติมข้อมูลให้ตรงกับที่ตอบได้" });
    assert(r.status === 200, `status=${r.status}`);
    const d2 = await getReplyDoc();
    assert(d2.review_bubbles[0].decision === "edited_approved" && d2.review_bubbles[0].original_text === "A", "state wrong");
    assert(mockEvents()[0].metadata.text === "A new", "mock text not the edit");
  });

  await test("D1b save_and_approve stores edit reason and sends the exact edited text", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save_and_approve", {
      edited_text: "A corrected", reason_category: "ผิดรุ่น", reason_text: "คำตอบเดิมเป็นข้อมูลคนละรุ่น",
    });
    assert(r.status === 200, `status=${r.status} ${JSON.stringify(r.body)}`);
    const bubble = (await getReplyDoc()).review_bubbles[0];
    assert(bubble.edit_history?.[0]?.reason_category === "ผิดรุ่น", "sent edit category missing");
    assert(bubble.edit_history?.[0]?.reason_text === "คำตอบเดิมเป็นข้อมูลคนละรุ่น", "sent edit explanation missing");
    assert(mockEvents()[0].metadata.text === "A corrected", "sender did not receive the edited text");
  });

  await test("D2 save empty edit → 422 + 0 mock", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "   " });
    assert(r.status === 422, `status=${r.status}`);
    assert(mockEvents().length === 0, "mock on invalid save");
  });

  await test("E0 reject without a reason → 422 and no state change", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject");
    assert(r.status === 422, "expected 422, got " + r.status);
    const b = (await getReplyDoc()).review_bubbles[0];
    assert(b.decision === "pending", "missing reason changed the decision");
    assert(mockEvents().length === 0 && mocks.state.fakeShopeeCalls.length === 0, "missing reason caused delivery");
  });

  await test("E0b reject requires a fixed reason category", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject", {
      rejection_reason: "คำตอบต้องส่งให้แอดมินตรวจ",
    });
    assert(r.status === 422, `missing rejection category -> ${r.status}`);
    assert((await getReplyDoc()).review_bubbles[0].decision === "pending", "missing category changed the decision");
    assert(mockEvents().length === 0, "reject without category caused delivery");
  });

  await test("E0c reject requires a non-empty explanation", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject", {
      rejection_category: "ตอบไม่ได้", rejection_reason: "  ",
    });
    assert(r.status === 422, `blank rejection explanation -> ${r.status}`);
    assert((await getReplyDoc()).review_bubbles[0].decision === "pending", "blank explanation changed the decision");
  });

  await test("E2 reject keeps reason, reviewer identity, and edit history in the audit trail", async () => {
    const doc = await runBotTurn();
    const bubbleId = doc.review_bubbles[0].bubble_id;
    const edited = await review("conv_1", doc.shadow_reply_id, bubbleId, "save", { edited_text: "Edited answer", reason_category: "การแก้ปัญหาผิด", reason_text: "ขั้นตอนเดิมไม่ตรงอาการ" });
    assert(edited.status === 200, "save edit -> " + edited.status);
    const rejected = await review("conv_1", doc.shadow_reply_id, bubbleId, "reject", { rejection_category: "ผิดรุ่น", rejection_reason: "ข้อมูลสินค้าไม่ตรง" });
    assert(rejected.status === 200, "reject -> " + rejected.status + " " + JSON.stringify(rejected.body));
    const b = (await getReplyDoc()).review_bubbles[0];
    assert(b.original_text === "A" && b.edited_text === "Edited answer", "original or edited text was lost");
    assert(b.rejection_category === "ผิดรุ่น" && b.rejection_reason === "ข้อมูลสินค้าไม่ตรง", "rejection category/explanation was not persisted");
    assert(b.decided_by === "t_admin" && b.decided_by_name === "Test Reviewer", "reviewer identity snapshot missing");
    assert(Array.isArray(b.edit_history) && b.edit_history.length === 1, "edit history missing");
    assert(b.edit_history[0].before_text === "A" && b.edit_history[0].after_text === "Edited answer", "edit delta wrong");
    assert(b.edit_history[0].reason_category === "การแก้ปัญหาผิด" && b.edit_history[0].reason_text === "ขั้นตอนเดิมไม่ตรงอาการ", "edit reason missing from history");
    const audit = mocks.fakeColl("botworker_events").filter((e: any) => e.type === "review_action");
    assert(audit.length === 2, "expected edit and reject audit events, got " + audit.length);
    assert(audit.some((e: any) => e.metadata.rejection_category === "ผิดรุ่น" && e.metadata.rejection_reason === "ข้อมูลสินค้าไม่ตรง"), "rejection category/explanation missing from event");
    assert(audit.every((e: any) => e.actor === "t_admin" && e.metadata.actor_name === "Test Reviewer"), "action actor missing from event");
  });

  await test("Handoff flag persists separate reason/explanation/answer and waits for review", async () => {
    mocks.state.callBotExtra = {
      handoff_required: true,
      reason: "legal_or_platform_dispute",
      handoff_reason: "legal_or_platform_dispute",
      handoff_explanation: "ต้องให้เจ้าหน้าที่ตรวจข้อพิพาท",
      conversation_id: "conv_handoff",
      message_id: "m_handoff",
    };
    const doc = await runBotTurn("conv_handoff", "m_handoff", "ขออภัย จะให้เจ้าหน้าที่ตรวจสอบ", { platform: "shopee" });
    assert(doc.bot_reply_text === "ขออภัย จะให้เจ้าหน้าที่ตรวจสอบ", "customer-facing answer was not preserved separately");
    assert(doc.bot_handoff_required === true && doc.bot_handoff_reason === "legal_or_platform_dispute", "handoff flag/reason missing");
    assert(doc.bot_handoff_explanation === "ต้องให้เจ้าหน้าที่ตรวจข้อพิพาท", "review explanation missing");
    assert(doc.upstream_conversation_id === "conv_handoff" && doc.upstream_message_id === "m_handoff", "upstream IDs missing");
    assert(doc.handoff_review.status === "pending", "handoff did not wait for reviewer");
    assert((mocks.state.lastProcessResult as any)?.status === "handoff_review_pending", "worker did not report pending review");
    assert(mocks.fakeColl("test_status_conversation").every((row: any) => !row.assigned_to), "bot auto-assigned before reviewer approval");
  });

  await test("Handoff flag with empty answer still creates a visible review draft", async () => {
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "insufficient_shop_evidence", chat_engine: "v4" };
    const doc = await runBotTurn("conv_flag_empty", "m_flag_empty", "", { platform: "shopee" });
    assert(doc.bot_reply_text.trim().length > 0, "flagged handoff draft is empty");
    assert(doc.review_bubbles?.length === 1, "flagged handoff has no reviewable bubble");
    assert(doc.handoff_review?.status === "pending", "flagged handoff skipped reviewer");
    assert(mocks.fakeColl("test_status_conversation").every((row: any) => row.conversation_id !== "conv_flag_empty" || !row.assigned_to), "flagged handoff assigned before approval");
  });

  await test("A handoff draft cannot be rejected as an ordinary answer bubble", async () => {
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved",
      handoff_explanation: "ต้องให้ผู้ตรวจตัดสิน", conversation_id: "conv_handoff_bubble_reject", message_id: "m_handoff_bubble_reject" };
    const doc = await runBotTurn("conv_handoff_bubble_reject", "m_handoff_bubble_reject", "ร่างข้อความ", { platform: "shopee" });
    const rejected = await review("conv_handoff_bubble_reject", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject", {
      rejection_category: "ควรส่งแอดมิน", rejection_reason: "ขอปฏิเสธ handoff",
    });
    assert(rejected.status === 409, `ordinary bubble reject -> ${rejected.status}`);
    const saved = await getReplyDoc();
    assert(saved.review_bubbles[0].decision === "pending" && saved.handoff_review.status === "pending", "handoff state changed through bubble rejection");
    assert(mockEvents().length === 0 && mocks.fakeColl("messages").every((row: any) => row.conversation_id !== "conv_handoff_bubble_reject" || row.direction !== "out"), "rejected handoff draft sent a message");
  });

  await test("Empty bot answer without handoff flag keeps bot ownership", async () => {
    mocks.state.callBotExtra = { source: "no_reply" };
    await runBotTurn("conv_empty", "m_empty", "", { platform: "shopee", expectReply: false });
    assert((mocks.state.lastProcessResult as any)?.status === "bot_no_reply", "empty unflagged reply did not remain a bot no-reply");
    assert(mocks.fakeColl("shadow_replies").length === 0, "empty unflagged reply created a review draft");
    assert(mocks.fakeColl("test_status_conversation").every((row: any) => row.conversation_id !== "conv_empty" || (row.status === "bot" && !row.assigned_to)), "empty unflagged reply handed off");
    assert(mocks.fakeColl("botworker_events").every((event: any) => event.conversation_id !== "conv_empty" || event.type !== "handoff"), "empty unflagged reply logged an assignment");
  });

  await test("Unexpected empty bot answer is recorded as failure without handoff", async () => {
    mocks.state.callBotExtra = { source: "unexpected_empty" };
    await runBotTurn("conv_bad_empty", "m_bad_empty", "", { platform: "shopee", expectReply: false });
    assert((mocks.state.lastProcessResult as any)?.status === "bot_failed", "unexpected empty answer was silently accepted");
    assert(mocks.fakeColl("test_status_conversation").every((row: any) => row.conversation_id !== "conv_bad_empty" || !row.assigned_to), "unexpected empty answer assigned an admin");
  });

  await test("New customer message reopens closed assigned chat for bot reply", async () => {
    mocks.fakeColl("test_status_conversation").push({ conversation_id: "conv_closed_bot", source: "botworker", status: "closed", assigned_to: "adm_previous", close_count: 1, updated_at: new Date() });
    const doc = await runBotTurn("conv_closed_bot", "m_closed_bot", "ตอบลูกค้า", { platform: "shopee" });
    const status = mocks.fakeColl("test_status_conversation").find((row: any) => row.conversation_id === "conv_closed_bot");
    assert((mocks.state.lastProcessResult as any)?.status === "bot_answered", "closed chat was skipped");
    assert(doc.bot_reply_text === "ตอบลูกค้า", "bot answer was not stored for review");
    assert(status?.status === "bot" && !status?.assigned_to, "closed chat did not reopen as bot");
    assert(status?.previous_assigned_to === "adm_previous", "prior assignee was lost for the next reviewed handoff");
  });

  await test("Reviewed handoff suggests prior assignee only when admin config enables it", async () => {
    seedAdmin("adm_previous", "Previous Admin");
    seedAdmin("adm_other", "Other Admin");
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved" };
    mocks.fakeColl("test_status_conversation").push({ conversation_id: "conv_prior_preview", source: "botworker", status: "bot", previous_assigned_to: "adm_previous", updated_at: new Date() });
    const doc = await runBotTurn("conv_prior_preview", "m_prior_preview", "ร่างตอบ", { platform: "shopee" });
    mocks.state.config.assignment_prefer_previous_admin = true;
    const preferred = await callHandoffReview("conv_prior_preview", doc.shadow_reply_id);
    assert(preferred.status === 200 && preferred.body.candidates.find((row: any) => row.admin_id === "adm_previous")?.suggested === true, "previous assignee was not suggested");
    mocks.fakeColl("assignment_cursors").push({ pool_key: "global:botworker", last_assigned_admin_id: "adm_previous", updated_at: new Date() });
    mocks.state.config.assignment_prefer_previous_admin = false;
    const roundRobin = await callHandoffReview("conv_prior_preview", doc.shadow_reply_id);
    assert(roundRobin.status === 200 && roundRobin.body.candidates.find((row: any) => row.admin_id === "adm_previous")?.suggested !== true, "previous assignee bypassed RR config");
    assert(roundRobin.body.candidates.filter((row: any) => row.suggested).length === 1, "RR did not suggest exactly one eligible admin");
  });

  await test("Two reviewer-approved RR suggestions advance to different admins", async () => {
    seedAdmin("adm_rr_1", "RR Admin 1");
    seedAdmin("adm_rr_2", "RR Admin 2");
    mocks.state.config.assignment_prefer_previous_admin = false;
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved" };
    const first = await runBotTurn("conv_rr_1", "m_rr_1", "ร่างตอบ", { platform: "shopee" });
    const preview1 = await callHandoffReview("conv_rr_1", first.shadow_reply_id);
    const selected1 = preview1.body.candidates.find((row: any) => row.suggested)?.admin_id;
    assert(selected1, "first RR suggestion missing");
    const approved1 = await callHandoffReview("conv_rr_1", first.shadow_reply_id, {
      reply_id: first.shadow_reply_id, action: "approve", selected_admin_id: selected1, operation_id: "rr_review_1", updated_at: preview1.body.updated_at,
    });
    assert(approved1.status === 200, "first RR approval failed");
    const second = await runBotTurn("conv_rr_2", "m_rr_2", "ร่างตอบ", { platform: "shopee" });
    const preview2 = await callHandoffReview("conv_rr_2", second.shadow_reply_id);
    const selected2 = preview2.body.candidates.find((row: any) => row.suggested)?.admin_id;
    assert(selected2 && selected2 !== selected1, "RR cursor did not advance after first approval");
    const approved2 = await callHandoffReview("conv_rr_2", second.shadow_reply_id, {
      reply_id: second.shadow_reply_id, action: "approve", selected_admin_id: selected2, operation_id: "rr_review_2", updated_at: preview2.body.updated_at,
    });
    assert(approved2.status === 200 && approved2.body.handoff_review.selected_admin_id === selected2, "second RR recipient changed after approval");
  });

  await test("Conflicting upstream turn IDs fail closed without a shadow draft", async () => {
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved",
      handoff_explanation: "ต้องตรวจเพิ่ม", conversation_id: "other_conv", message_id: "other_msg" };
    await runBotTurn("conv_mismatch", "m_mismatch", "answer", { platform: "shopee", expectReply: false });
    assert(mocks.fakeColl("shadow_replies").length === 0, "identity mismatch stored a draft on the wrong turn");
    assert((mocks.state.lastProcessResult as any)?.status === "bot_failed", "identity mismatch was not marked failed");
  });

  await test("Handoff preview rejects a reply paired with a different inbound message", async () => {
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved",
      handoff_explanation: "ต้องตรวจเพิ่ม", conversation_id: "conv_handoff_pair", message_id: "m_handoff_pair" };
    const doc = await runBotTurn("conv_handoff_pair", "m_handoff_pair", "ต้องให้เจ้าหน้าที่ตรวจ", { platform: "shopee" });
    const response = await callHandoffReview("conv_handoff_pair", doc.shadow_reply_id, undefined, "m_other");
    assert(response.status === 409, `wrong inbound message preview -> ${response.status}`);
  });

  await test("Reviewer previews eligible admins then approves the selected handoff in sandbox", async () => {
    delete (mocks.state.config as any).bot_review_admin_id;
    mocks.state.authAdminId = "other_admin";
    mocks.state.callBotExtra = { handoff_required: true, reason: "insufficient_shop_evidence",
      handoff_reason: "insufficient_shop_evidence", handoff_explanation: "หลักฐานร้านไม่พอ",
      conversation_id: "conv_handoff_approve", message_id: "m_handoff_approve" };
    seedAdmin("adm_online_1", "Online Admin 1");
    seedAdmin("adm_offline", "Offline Admin", { is_active_agent: false });
    const doc = await runBotTurn("conv_handoff_approve", "m_handoff_approve", "ร่างตอบลูกค้า", { platform: "shopee" });
    const preview = await callHandoffReview("conv_handoff_approve", doc.shadow_reply_id);
    assert(preview.status === 200, `preview -> ${preview.status} ${JSON.stringify(preview.body)}`);
    assert(preview.body.candidates.some((candidate: any) => candidate.admin_id === "adm_online_1"), "online admin missing from candidates");
    assert(!preview.body.candidates.some((candidate: any) => candidate.admin_id === "adm_offline"), "offline admin was selectable");
    const approved = await callHandoffReview("conv_handoff_approve", doc.shadow_reply_id, {
      reply_id: doc.shadow_reply_id, action: "approve", selected_admin_id: "adm_online_1",
      operation_id: "handoff_approve_1", updated_at: preview.body.updated_at,
    });
    assert(approved.status === 200, `approve -> ${approved.status} ${JSON.stringify(approved.body)}`);
    assert(approved.body.handoff_review.status === "approved" && approved.body.handoff_review.selected_admin_id === "adm_online_1", "approved assignment not recorded");
    assert(approved.body.handoff_review.reviewed_by === "other_admin", "actual reviewer identity not recorded");
    assert(mocks.fakeColl("test_status_conversation").some((row: any) => row.conversation_id === "conv_handoff_approve" && row.assigned_to === "adm_online_1"), "selected sandbox assignment missing");
    assert(mocks.fakeColl("messages").filter((m: any) => m.direction === "out").length === 0, "handoff review wrote a customer message");
  });

  await test("Reviewer reload resumes an approving handoff with the persisted operation id", async () => {
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved",
      handoff_explanation: "ต้องตรวจเพิ่ม", conversation_id: "conv_handoff_resume", message_id: "m_handoff_resume" };
    seedAdmin("adm_resume", "Resume Admin");
    const doc = await runBotTurn("conv_handoff_resume", "m_handoff_resume", "ร่างตอบลูกค้า", { platform: "shopee" });
    const operationId = "handoff_resume_after_reload";
    const stored = mocks.fakeColl("shadow_replies").find((row: any) => row.shadow_reply_id === doc.shadow_reply_id) as any;
    stored.handoff_review = { ...stored.handoff_review, status: "approving", selected_admin_id: "adm_resume",
      selected_admin_name: "Resume Admin", assignment_operation_id: operationId,
      assignment_operation_key: `${doc.shadow_reply_id}:${operationId}` };
    stored.updated_at = new Date();

    const preview = await callHandoffReview("conv_handoff_resume", doc.shadow_reply_id);
    assert(preview.status === 200 && preview.body.handoff_review.status === "approving", "reload did not restore approving state");
    assert(preview.body.handoff_review.assignment_operation_id === operationId, "persisted operation id missing from preview");
    assert(preview.body.candidates.some((candidate: any) => candidate.admin_id === "adm_resume"), "selected online admin missing from resume options");
    const resumed = await callHandoffReview("conv_handoff_resume", doc.shadow_reply_id, {
      reply_id: doc.shadow_reply_id, action: "approve", selected_admin_id: "adm_resume",
      operation_id: operationId, updated_at: preview.body.updated_at,
    });
    assert(resumed.status === 200 && resumed.body.handoff_review.status === "approved", `resume -> ${resumed.status} ${JSON.stringify(resumed.body)}`);
    assert(mocks.fakeColl("test_status_conversation").filter((row: any) => row.conversation_id === "conv_handoff_resume" && row.assigned_to === "adm_resume").length === 1,
      "resume did not create exactly one sandbox assignment");
    assert(mocks.fakeColl("messages").filter((m: any) => m.direction === "out").length === 0, "resume sent a customer message");
  });

  await test("Rejecting a bot handoff requires reason and records reviewer without assignment", async () => {
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved",
      handoff_explanation: "ยังยืนยันข้อมูลไม่ได้", conversation_id: "conv_handoff_reject", message_id: "m_handoff_reject" };
    seedAdmin("adm_online_1", "Online Admin 1");
    const doc = await runBotTurn("conv_handoff_reject", "m_handoff_reject", "ร่างคำตอบ", { platform: "shopee" });
    const missing = await callHandoffReview("conv_handoff_reject", doc.shadow_reply_id, {
      reply_id: doc.shadow_reply_id, action: "reject", rejection_reason: "ยังไม่ครบข้อมูล", operation_id: "handoff_reject_missing",
    });
    assert(missing.status === 422, `missing rejection category -> ${missing.status}`);
    const blank = await callHandoffReview("conv_handoff_reject", doc.shadow_reply_id, {
      reply_id: doc.shadow_reply_id, action: "reject", rejection_category: "ควรส่งแอดมิน", rejection_reason: "  ", operation_id: "handoff_reject_blank",
    });
    assert(blank.status === 422, `blank rejection explanation -> ${blank.status}`);
    const rejected = await callHandoffReview("conv_handoff_reject", doc.shadow_reply_id, {
      reply_id: doc.shadow_reply_id, action: "reject", rejection_category: "ควรส่งแอดมิน", rejection_reason: "ยังไม่ครบข้อมูล",
      operation_id: "handoff_reject_1",
    });
    assert(rejected.status === 200, `reject -> ${rejected.status} ${JSON.stringify(rejected.body)}`);
    assert(rejected.body.handoff_review.status === "rejected" && rejected.body.handoff_review.rejection_category === "ควรส่งแอดมิน" && rejected.body.handoff_review.rejection_reason === "ยังไม่ครบข้อมูล", "handoff rejection category/explanation not persisted");
    assert(rejected.body.handoff_review.reviewed_by_name === "Test Reviewer", "reviewer name missing");
    assert(mocks.fakeColl("test_status_conversation").every((row: any) => row.conversation_id !== "conv_handoff_reject" || !row.assigned_to), "rejected handoff assigned an admin");
    assert(mocks.fakeColl("messages").every((row: any) => row.conversation_id !== "conv_handoff_reject" || row.direction !== "out"), "rejected handoff sent a customer message");
  });

  await test("Analysis includes workflow replies and all linked actions after the selected creation date", async () => {
    const created = new Date("2026-11-24T09:00:00+07:00");
    const reviewed = new Date("2026-11-25T10:00:00+07:00");
    mocks.fakeColl("shadow_replies").push(
      { _id: "analytics_worker", shadow_reply_id: "sr_analytics_worker", conversation_id: "conv_analytics_worker",
        shop_id: "shop_1", platform: "shopee", origin: "worker", created_at: created, updated_at: created,
        inbound_text: "ถามสินค้า", bot_reply_text: "ร่างตอบ", bot_handoff_required: true,
        bot_handoff_reason: "clarification_unresolved", bot_handoff_explanation: "ต้องตรวจ",
        handoff_review: { status: "rejected", reviewed_by_name: "Test Reviewer", rejection_category: "ควรส่งแอดมิน", rejection_reason: "ต้องให้เจ้าหน้าที่ตรวจ" }, review_bubbles: [{ bubble_id: "b1", ordinal: 0, original_text: "เดิม",
          edited_text: "แก้", approved_text: "แก้", decision: "edited_approved", decided_by: "t_admin",
          decided_by_name: "Test Reviewer", edit_history: [{ before_text: "เดิม", after_text: "แก้", reason_category: "สเปคผิด", reason_text: "ข้อมูลเดิมไม่ตรง",
            actor: "t_admin", actor_name: "Test Reviewer", at: reviewed }],
          delivery: { state: "not_sent_switch_off" }, card: { item_id: "item-analytics", delivery: { state: "mock_sent" } } }] },
      { _id: "analytics_workflow", shadow_reply_id: "sr_analytics_workflow", conversation_id: "conv_analytics_workflow",
        shop_id: "shop_2", platform: "shopee", origin: "workflow", created_at: created, updated_at: created,
        inbound_text: "ถามจาก flow", bot_reply_text: "ตอบจาก flow", review_bubbles: [], }
    );
    mocks.fakeColl("botworker_events").push(
      { _id: "reviewop:analytics_op", event_id: "reviewop:analytics_op", conversation_id: "conv_analytics_worker",
        type: "review_op", actor: "t_admin", metadata: { request: { reply_id: "sr_analytics_worker", action: "save_and_approve" },
          actor_name: "Test Reviewer", status: "done" }, created_at: reviewed },
      { _id: "reviewaction:analytics_op", event_id: "reviewaction:analytics_op", conversation_id: "conv_analytics_worker",
        type: "review_action", actor: "t_admin", metadata: { reply_id: "sr_analytics_worker", action: "save_and_approve",
          actor_name: "Test Reviewer", edited_text: "แก้" }, created_at: reviewed }
    );
    const summary = await analyticsService.getBotPerformanceSummary({ from: "2026-11-24", to: "2026-11-24", group: "day" });
    assert(summary.kpi.replies === 2 && summary.kpi.conversations === 2, `worker/workflow total=${summary.kpi.replies}`);
    assert(summary.series[0].replies === 2 && summary.kpi.handoff_requested === 1, "daily series omitted replies or handoff flag");
    const result = await analyticsService.getBotPerformanceItems({ from: "2026-11-24", to: "2026-11-24" });
    const item = result.items.find((row) => row.reply_id === "sr_analytics_worker");
    if (!item) throw new Error("analysis item missing");
    assert(item.timeline.length === 1 && item.timeline[0].type === "review_action", "linked event timeline missing or duplicated");
    assert(item.timeline[0].actor_name === "Test Reviewer", "reviewer identity missing in timeline");
    assert(item.bubbles[0].edit_history?.[0].after_text === "แก้", "edit history missing from analysis item");
    assert(item.bubbles[0].edit_history?.[0].reason_category === "สเปคผิด" && item.bubbles[0].edit_history?.[0].reason_text === "ข้อมูลเดิมไม่ตรง", "edit reason missing from analysis item");
    assert(item.bubbles[0].delivery_state === "not_sent_switch_off", "per-bubble send outcome missing from analysis item");
    assert(item.bubbles[0].card_item_id === "item-analytics" && item.bubbles[0].card_delivery_state === "mock_sent", "separate product-card send outcome missing from analysis item");
    assert(item.handoff === "rejected" && item.handoff_rejection_category === "ควรส่งแอดมิน" && item.handoff_rejection_reason === "ต้องให้เจ้าหน้าที่ตรวจ", "handoff rejection category/explanation missing from analysis item");
  });

  await test("P1 bot performance KPIs: pass/edit/reject rates, human workload % of all BotWorker chats, edit %, reviewer timing", async () => {
    const created = new Date("2026-11-20T09:00:00+07:00");
    const at = (min: number) => new Date(created.getTime() + min * 60_000);
    const bubble = (id: string, decision: string, extra: Record<string, unknown> = {}) => ({ bubble_id: id, ordinal: 0, original_text: "สวัสดีค่ะ", decision,
      decided_by: "t_admin", decided_by_name: "Reviewer A", decided_at: at(10), delivery: { state: "not_sent_switch_off" }, ...extra });
    const reply = (id: string, conv: string, bubbles: unknown[], extra: Record<string, unknown> = {}) => ({ _id: id, shadow_reply_id: id, conversation_id: conv,
      shop_id: "shop_1", platform: "shopee", origin: "worker", created_at: created, updated_at: created, inbound_text: `q ${id}`, bot_reply_text: "สวัสดีค่ะ", review_bubbles: bubbles, ...extra });
    mocks.fakeColl("shadow_replies").push(
      reply("p1", "c1", [bubble("p1b", "approved")]),
      reply("p2", "c1", [bubble("p2b", "approved")]),
      reply("p3", "c2", [bubble("p3b", "edited_approved", { edited_text: "สวัสดีครับ", approved_text: "สวัสดีครับ", decided_at: at(30) })]),
      reply("p4", "c3", [bubble("p4b", "rejected", { rejection_reason: "ราคาผิด" })]),
      reply("p5", "c4", [bubble("p5b", "pending", { decided_by: undefined, decided_by_name: undefined, decided_at: undefined })],
        { bot_handoff_required: true, bot_handoff_reason: "clarification_unresolved", handoff_review: { status: "approved", reviewed_by_name: "Reviewer A", selected_admin_name: "Agent B" } }),
      reply("p_manual", "c9", [bubble("pmb", "rejected")], { origin: "manual" }),
      reply("p_deleted", "c9", [bubble("pdb", "rejected")], { deleted_at: created }),
    );
    const s = await analyticsService.getBotPerformanceSummary({ from: "2026-11-20", to: "2026-11-20", group: "week" });
    const k = s.kpi;
    assert(k.replies === 5 && k.conversations === 4, `scope must exclude manual/deleted: replies=${k.replies} conv=${k.conversations}`);
    assert(k.decided === 4 && k.approved === 2 && k.edited === 1 && k.rejected === 1 && k.pending === 1, `bubble counts ${JSON.stringify(k)}`);
    assert(k.pass_rate === 50 && k.edited_rate === 25 && k.rejected_rate === 25, `rates ${k.pass_rate}/${k.edited_rate}/${k.rejected_rate}`);
    assert(k.human_conversations === 3 && k.human_conversation_rate === 75, `human conv ${k.human_conversations} ${k.human_conversation_rate}`);
    assert(k.human_replies === 3 && k.human_reply_rate === 60, `human replies ${k.human_replies} ${k.human_reply_rate}`);
    assert(k.handoff_rate === 20 && k.handoff_agree_rate === 100, `handoff ${k.handoff_rate} ${k.handoff_agree_rate}`);
    assert(k.avg_edit_pct > 0 && k.avg_edit_pct < 60, `edit pct ${k.avg_edit_pct}`);
    assert(k.median_review_minutes === 10, `median review minutes ${k.median_review_minutes}`);
    assert(s.series.length === 1 && s.series[0].period === "2026-11-16", `week bucket starts Monday: ${s.series[0]?.period}`);
    assert(s.rejection_reasons[0]?.label === "ราคาผิด", "rejection reason ranking missing");
    const a = s.by_reviewer.find((r) => r.name === "Reviewer A");
    assert(a?.decided === 4 && a.handoffs_reviewed === 1, `reviewer row ${JSON.stringify(a)}`);
    assert(s.by_reviewer.find((r) => r.name === "Agent B")?.handoffs_received === 1, "handoff recipient workload missing");
  });

  await test("P2 bot performance Q&A filters and export carry admin reasons and final text", async () => {
    const created = new Date("2026-11-21T09:00:00+07:00");
    mocks.fakeColl("shadow_replies").push(
      { _id: "f1", shadow_reply_id: "f1", conversation_id: "cf1", shop_id: "shop_1", origin: "worker", created_at: created, inbound_text: "มีสีดำไหม",
        bot_reply_text: "มีค่ะ", review_bubbles: [{ bubble_id: "f1b", ordinal: 0, original_text: "มีค่ะ", decision: "rejected", rejection_reason: "สีดำหมดแล้ว", decided_by_name: "Reviewer A", delivery: { state: "not_requested" } }] },
      { _id: "f2", shadow_reply_id: "f2", conversation_id: "cf2", shop_id: "shop_2", origin: "workflow", created_at: created, inbound_text: "ส่งกี่วัน",
        bot_reply_text: "2 วัน", review_bubbles: [{ bubble_id: "f2b", ordinal: 0, original_text: "2 วัน", approved_text: "2-3 วันทำการค่ะ", decision: "edited_approved", decided_by_name: "Reviewer B", delivery: { state: "live_sent", request_id: "send-f2" } }] },
    );
    const scope = { from: "2026-11-21", to: "2026-11-21" };
    const rejected = await analyticsService.getBotPerformanceItems({ ...scope, outcome: "rejected" });
    assert(rejected.total === 1 && rejected.items[0].admin_reasons[0] === "สีดำหมดแล้ว", "outcome filter / reason");
    assert((await analyticsService.getBotPerformanceItems({ ...scope, reviewer: "Reviewer B" })).total === 1, "reviewer filter");
    assert((await analyticsService.getBotPerformanceItems({ ...scope, q: "สีดำหมด" })).total === 1, "search over admin reasons");
    assert((await analyticsService.getBotPerformanceItems({ ...scope, minEditPct: 30 })).items[0]?.reply_id === "f2", "min edit filter");
    assert((await analyticsService.getBotPerformanceItems({ ...scope, shopId: "shop_2" })).total === 1, "shop scope");
    const csv = await analyticsService.exportBotPerformance(scope, "csv");
    assert(csv.body.includes("สีดำหมดแล้ว") && csv.body.includes("2-3 วันทำการค่ะ") && csv.body.split("\n").length === 3, "csv rows/fields");
    const jsonl = await analyticsService.exportBotPerformance({ ...scope, outcome: "edited" }, "jsonl");
    const parsed = jsonl.body.split("\n").map((line) => JSON.parse(line));
    assert(parsed.length === 1 && parsed[0].bubbles[0].final_text === "2-3 วันทำการค่ะ", "jsonl export");
    assert(parsed[0].bubbles[0].outbound_text === "2-3 วันทำการค่ะ" && parsed[0].bubbles[0].delivery_state === "live_sent", "jsonl omitted actual outbound text or state");
    assert(csv.body.includes("outbound_text") && csv.body.includes("delivery_state") && csv.body.includes("2-3 วันทำการค่ะ"), "csv omitted actual outbound text or state");
    const badRange = await analyticsRoute.GET({ url: "http://localhost/api/bot-performance?from=2026-11-22&to=2026-11-21" } as any);
    assert(badRange.status === 422, `bad range -> ${badRange.status}`);
  });

  await test("C-H1 BotWorker close history returns unique record ids and sequence for sandbox entries", async () => {
    seedConv("conv_close");
    const at = (h: number) => new Date(`2026-11-25T0${h}:00:00+07:00`);
    mocks.fakeColl("test_status_conversation").push({ conversation_id: "conv_close", source: "botworker", status: "bot", close_count: 2, updated_at: at(3),
      close_history: [
        { closed_at: at(1), closed_by: "t_admin", reason: "จบ", category: "other", resolution: "resolved" },
        { closed_at: at(2), closed_by: "t_admin", reason: "จบอีก", category: "other", resolution: "resolved" },
      ] });
    const res = await closeHistoryRoute.GET({ url: "http://localhost/api/botworker/conversations/conv_close/close-history" } as any,
      { params: Promise.resolve({ conversationId: "conv_close" }) } as any);
    const body = await res.json();
    const ids = body.close_history.map((r: any) => r.record_id);
    assert(ids.length === 2 && ids.every((id: unknown) => typeof id === "string" && id) && new Set(ids).size === 2, `record ids ${JSON.stringify(ids)}`);
    assert(body.close_history.map((r: any) => r.sequence).join() === "1,2", `sequence ${JSON.stringify(body.close_history)}`);
    assert(body.close_history.every((r: any) => r.conversation_id === "conv_close"), "conversation_id missing");
  });

  await test("E3 Shopee approval while live-send switch is OFF is recorded without calling any sender", async () => {
    mocks.state.shopeeSendEnabled = false;
    const doc = await runBotTurn("conv_off", "m_off", "Safe draft", { platform: "shopee" });
    const r = await review("conv_off", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 200, "approval while OFF -> " + r.status);
    assert(r.body.bubble.decision === "approved", "review decision not recorded");
    assert(r.body.bubble.delivery.state === "not_sent_switch_off", "delivery=" + r.body.bubble.delivery.state);
    assert(mocks.state.fakeShopeeCalls.length === 0, "fake Shopee sender was called while OFF");
    assert(mocks.state.mockCalls.length === 0, "mock sender was called while OFF");
  });

  await test("E4 explicit Shopee approval while switch is ON uses only fake sender", async () => {
    mocks.state.shopeeSendEnabled = true;
    const doc = await runBotTurn("conv_fake_on", "m_fake_on", "Safe draft", { platform: "shopee" });
    const r = await review("conv_fake_on", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "approve");
    assert(r.status === 200, "fake approval -> " + r.status);
    assert(r.body.bubble.delivery.state === "live_sent", "fake delivery outcome missing");
    assert(r.body.bubble.delivery.outbound_text === "Safe draft", "exact text passed to Shopee was not returned");
    assert((await getReplyDoc()).review_bubbles[0].delivery.outbound_text === "Safe draft", "outbound text was not persisted");
    assert(mocks.state.fakeShopeeCalls.length === 1, "explicit ON action did not call fake sender once");
    const sent = (mocks.state.fakeShopeeCalls as unknown as any[])[0];
    assert(sent.conversationId === "conv_fake_on", "fake sender received wrong conversation");
    assert(sent.input.text === "Safe draft", "different text was passed to Shopee");
  });

  // ═══ E/F — reject + dedupe + authz ═══
  await test("E1 reject → 0 mock + no approved_text/sent_text", async () => {
    const doc = await runBotTurn();
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "reject", { rejection_category: "ควรส่งแอดมิน", rejection_reason: "ไม่ผ่านการตรวจ" });
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

  await test("F3 another BotWorker admin may review; decision records that admin", async () => {
    const doc = await runBotTurn();
    mocks.state.authAdminId = "other_admin";
    mocks.state.config.bot_review_shop_id = "other_shop";
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "review remains cross-shop", reason_category: "สเปคผิด", reason_text: "สเปคเดิมไม่ตรง" });
    assert(r.status === 200, `page-authorized admin must review, got ${r.status}`);
    const updated = await getReplyDoc();
    assert(updated.review_bubbles[0].edit_history?.[0]?.actor === "other_admin", "actual reviewer identity missing from edit history");
    assert(mockEvents().length === 0, "save must not create delivery event");
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

  await test("F5 config ไม่ตั้ง fixed reviewer → page-authorized admin still reviews", async () => {
    const doc = await runBotTurn();
    delete (mocks.state.config as any).bot_review_admin_id;
    const r = await review("conv_1", doc.shadow_reply_id, doc.review_bubbles[0].bubble_id, "save", { edited_text: "reviewed", reason_category: "การแก้ปัญหาผิด", reason_text: "วิธีแก้ไม่ตรงอาการ" });
    assert(r.status === 200, `expected 200 got ${r.status}`);
    assert(mockEvents().length === 0, "saving an edit must not send");
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
    seedConv(conv, "shop_1", MOCK_PLATFORM); seedUserMsg(conv, "m_wf", "wfkw hi", "shop_1", MOCK_PLATFORM);
    mocks.state.config.workflow_enabled = true;
    mocks.state.callBotAnswer = "W1|||W2";
    mocks.fakeColl("workflows").push({
      workflow_id: "wf_t", name: "wf_t", enabled: true, status: "published", is_deleted: false,
      shop_ids: ["shop_1"], platforms: [MOCK_PLATFORM], trigger_frequency: "every_time",
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
      platform: MOCK_PLATFORM, text: "wfkw hi", claimContext: ctx,
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
      review("conv_1", rid, b0, "save_and_approve", { edited_text: "WINNER text", reason_category: "สเปคผิด", reason_text: "สเปคเดิมไม่ตรง" }),
      review("conv_1", rid, b0, "save_and_approve", { edited_text: "LOSER text", reason_category: "สเปคผิด", reason_text: "สเปคเดิมไม่ตรง" }),
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
    const r1 = await review("conv_1", doc.shadow_reply_id, b0, "save", { edited_text: "v1", reason_category: "สเปคผิด", reason_text: "แก้ไขข้อมูล" }, op);
    assert(r1.status === 200, `first ${r1.status}`);
    // op id เดิม + action ต่าง
    const r2 = await review("conv_1", doc.shadow_reply_id, b0, "reject", { rejection_category: "ตอบไม่ได้", rejection_reason: "different action" }, op);
    assert(r2.status === 409, `different action → ${r2.status}`);
    // op id เดิม + payload ต่าง
    const r3 = await review("conv_1", doc.shadow_reply_id, b0, "save", { edited_text: "v2", reason_category: "สเปคผิด", reason_text: "แก้ไขข้อมูล" }, op);
    assert(r3.status === 409, `different payload → ${r3.status}`);
    // op id เดิม + request เดิม → outcome เดิม
    const r4 = await review("conv_1", doc.shadow_reply_id, b0, "save", { edited_text: "v1", reason_category: "สเปคผิด", reason_text: "แก้ไขข้อมูล" }, op);
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
          actor: "t_admin", conversation_id: "conv_1",
          reply_id: rid, bubble_id: b0, action: "save_and_approve",
          edited_text: "PERSISTED s&a edit", card_item_id: null, reason_category: "สเปคผิด",
          reason_text: "แก้สเปคก่อนส่ง", rejection_reason: null,
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
    const r = await review("conv_1", rid, b0, "save_and_approve", { edited_text: "PERSISTED s&a edit", reason_category: "สเปคผิด", reason_text: "แก้สเปคก่อนส่ง" }, OP);
    assert(r.status === 200, `same-op retry → ${r.status} ${JSON.stringify(r.body)}`);
    // op ทำเสร็จ + outcome ถูกบันทึก
    const opDoc = mocks.fakeColl("botworker_events").find((e: any) => e._id === `reviewop:${OP}`) as any;
    assert(opDoc.metadata.status === "done" && opDoc.metadata.outcome?.ok === true, "op not completed");
    // mock event เดียว + text = persisted approved_text
    const events = mockEvents();
    assert(events.length === 1 && events[0].metadata.text === "PERSISTED s&a edit",
      `expected 1 mock with persisted text, got ${JSON.stringify(events.map((e: any) => e.metadata.text))}`);
    // retry อีกครั้งด้วย op เดิม → outcome เดิม + event ยัง 1
    const r2 = await review("conv_1", rid, b0, "save_and_approve", { edited_text: "PERSISTED s&a edit", reason_category: "สเปคผิด", reason_text: "แก้สเปคก่อนส่ง" }, OP);
    assert(r2.status === 200 && r2.body.bubble.delivery.state === "mock_sent", "replay not idempotent");
    assert(mockEvents().length === 1, "duplicate mock event on replay");
  });

  await test("J8 rejected bubble → send_card = 409 + 0 card request", async () => {
    mocks.state.callBotProducts = [{ item_id: "it1", shop_id: "shop_1" }];
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const rr = await review("conv_1", rid, b0, "reject", { rejection_category: "ควรส่งแอดมิน", rejection_reason: "ต้องตรวจใหม่" });
    assert(rr.status === 200, `reject ${rr.status}`);
    const r = await review("conv_1", rid, b0, "send_card", { card_item_id: "it1" });
    assert(r.status === 409, `send_card on rejected → ${r.status}`);
    assert(mockEvents().length === 0, "card request on rejected bubble");
  });

  await test("J9 retry an in-flight approve created before reason fields keeps its old request binding", async () => {
    const doc = await runBotTurn();
    const rid = doc.shadow_reply_id; const b0 = doc.review_bubbles[0].bubble_id;
    const operationId = "op_legacy_approve_retry";
    mocks.fakeColl("botworker_events").push({
      _id: `reviewop:${operationId}`, event_id: `reviewop:${operationId}`,
      conversation_id: "conv_1", type: "review_op", actor: "t_admin", shop_id: "shop_1", platform: "shopee",
      metadata: { request: { actor: "t_admin", conversation_id: "conv_1", reply_id: rid, bubble_id: b0,
        action: "approve", edited_text: null, card_item_id: null, rejection_reason: null }, actor_name: "Test Reviewer", status: "in_progress" },
      created_at: new Date(),
    });
    const stored = mocks.fakeColl("shadow_replies")[0] as any;
    stored.review_bubbles[0] = { ...stored.review_bubbles[0], decision: "approved", decided_by: "t_admin",
      approved_text: "Persisted legacy answer", delivery: { state: "not_requested" } };
    const r = await review("conv_1", rid, b0, "approve", {}, operationId);
    assert(r.status === 200, `legacy approve retry -> ${r.status} ${JSON.stringify(r.body)}`);
    assert(mockEvents().length === 1 && mockEvents()[0].metadata.text === "Persisted legacy answer", "legacy retry did not deliver persisted answer once");
  });

  await test("J10 retry an in-flight handoff approval created before reason fields keeps its old request binding", async () => {
    mocks.state.callBotExtra = { handoff_required: true, handoff_reason: "clarification_unresolved",
      conversation_id: "conv_legacy_handoff_retry", message_id: "m_legacy_handoff_retry" };
    seedAdmin("adm_legacy_retry", "Legacy Retry Admin");
    const doc = await runBotTurn("conv_legacy_handoff_retry", "m_legacy_handoff_retry", "ร่างข้อความ", { platform: "shopee" });
    const operationId = "handoff_legacy_retry";
    const stored = mocks.fakeColl("shadow_replies").find((row: any) => row.shadow_reply_id === doc.shadow_reply_id) as any;
    stored.handoff_review = { ...stored.handoff_review, status: "approving", selected_admin_id: "adm_legacy_retry",
      selected_admin_name: "Legacy Retry Admin", assignment_operation_id: operationId,
      assignment_operation_key: `${doc.shadow_reply_id}:${operationId}` };
    stored.updated_at = new Date();
    mocks.fakeColl("botworker_events").push({
      _id: `handoffreviewop:${operationId}`, event_id: `handoffreviewop:${operationId}`,
      conversation_id: "conv_legacy_handoff_retry", type: "review_op", actor: "t_admin", shop_id: "shop_1", platform: "shopee",
      metadata: { request: { action: "approve", actor: "t_admin", conversation_id: "conv_legacy_handoff_retry",
        reply_id: doc.shadow_reply_id, selected_admin_id: "adm_legacy_retry", rejection_reason: null },
        actor_name: "Test Reviewer", status: "in_progress" }, created_at: new Date(),
    });
    const resumed = await callHandoffReview("conv_legacy_handoff_retry", doc.shadow_reply_id, {
      reply_id: doc.shadow_reply_id, action: "approve", selected_admin_id: "adm_legacy_retry", operation_id: operationId,
    });
    assert(resumed.status === 200 && resumed.body.handoff_review.status === "approved", `legacy handoff retry -> ${resumed.status} ${JSON.stringify(resumed.body)}`);
    assert(resumed.body.handoff_review.selected_admin_id === "adm_legacy_retry", "legacy retry changed the selected recipient");
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
    const rr = await review("conv_1", rid, b0, "reject", { rejection_category: "ตอบไม่ได้", rejection_reason: "ไม่อนุมัติ" });
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
