// Leaf mocks for test-botworker-review.ts
// mock เฉพาะ leaf: mongoClient / botCallService / systemConfigService / authorize /
//   productService / mockSendService — ที่เหลือ production จริง
import {
  createFakeMongo,
  makeCallBotMock,
  makeGetSystemConfigMock,
  shouldUseChatV2,
  shouldUseChatV3,
  getBotProductLimit,
} from "./test-botworker-fakemongo.mjs";

const DEFAULT_EDIT_REASON_CATEGORIES = ["สเปคผิด", "ควรส่งแอดมิน", "การแก้ปัญหาผิด", "ผิดรุ่น", "ตอบไม่ได้"];

export const state = {
  calls: { callBot: 0 },
  callBotParams: [],
  callBotAnswer: "A|||B|||C",       // answer ที่ callBot mock คืน
  callBotProducts: /** @type {any[]|undefined} */ (undefined), // botResp.products
  callBotExtra: {},
  lastProcessResult: null,
  authAdminId: "t_admin",         // actor ที่ requireAuth คืน (เปลี่ยนต่อเทสได้)
  authAdminName: "Test Reviewer",
  pageAccessAllowed: true,
  editReasonCategories: [...DEFAULT_EDIT_REASON_CATEGORIES],
  shopeeSendEnabled: false,
  fakeShopeeCalls: [],
  mockFail: false,                // mockSendService throw → mock_failed path
  mockCalls: [],                  // args ของ sendMockPart จริง (request log ของ seam)
  config: {
    bot_worker_enabled: true,
    bot_worker_platforms: { shopee: true, tiktok: true, lazada: false },
    bot_concurrency_limit: 50,
    workflow_enabled: false,
    bot_buffer_enabled: false,
    bot_buffer_window_ms: 60,
    bot_buffer_max_messages: 10,
    workflow_run_timeout_ms: 1800000,
    assignment_prefer_previous_admin: false,
    bot_review_admin_id: "t_admin",   // legacy config must not restrict review
    bot_review_shop_id: "shop_1",     // legacy config must not restrict shops
  },
  uniqueKeys: {
    messages: ["message_id"],
    buffer_messages: ["message_id"],
    shadow_replies: ["shadow_reply_id"],
  },
};

const DEFAULT_CONFIG = JSON.parse(JSON.stringify(state.config));

const fm = createFakeMongo(state);
export const fakeColl = fm.fakeColl;
export const getCollection = fm.getCollection;
export const COLLECTIONS = fm.COLLECTIONS;
export const store = fm.store;

export function resetState() {
  state.calls = { callBot: 0 };
  state.callBotParams.length = 0;
  state.callBotAnswer = "A|||B|||C";
  state.callBotProducts = undefined;
  state.callBotExtra = {};
  state.lastProcessResult = null;
  state.authAdminId = "t_admin";
  state.authAdminName = "Test Reviewer";
  state.pageAccessAllowed = true;
  state.editReasonCategories = [...DEFAULT_EDIT_REASON_CATEGORIES];
  state.shopeeSendEnabled = false;
  state.fakeShopeeCalls.length = 0;
  state.mockFail = false;
  state.mockCalls.length = 0;
  Object.assign(state.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  fm.store.clear();
}

// ── mongoClient mock ──
export const serverConfig = { mongoDbName: "fake_admin", collections: COLLECTIONS };
export async function getDb() { throw new Error("fake mongo: getDb not supported"); }
export async function ensureIndexes() {}

// ── botCallService mock — answer configurable per test ──
const baseCallBot = makeCallBotMock(state);
export async function callBot(params) {
  const resp = await baseCallBot(params);
  return { ...resp, answer: state.callBotAnswer, products: state.callBotProducts, ...state.callBotExtra };
}

// ── systemConfigService mock ──
export const getSystemConfig = makeGetSystemConfigMock(state);
export async function getBotWorkerEditReasonCategories() {
  return [...state.editReasonCategories];
}
export async function addBotWorkerEditReasonCategory(category) {
  if (typeof category !== "string") return { ok: false, message: "กรุณาระบุหัวข้อ" };
  const value = category.trim();
  if (!value) return { ok: false, message: "หัวข้อห้ามว่าง" };
  if (value.length > 60) return { ok: false, message: "หัวข้อต้องไม่เกิน 60 ตัวอักษร" };
  const added = !state.editReasonCategories.includes(value);
  if (added) state.editReasonCategories.push(value);
  return { ok: true, category: value, categories: await getBotWorkerEditReasonCategories(), added };
}
export const systemConfigService = { getSystemConfig, getBotWorkerEditReasonCategories, addBotWorkerEditReasonCategory };
export { shouldUseChatV2, shouldUseChatV3, getBotProductLimit };

// ── authorize mock — admin จาก state.authAdminId ──
export async function requireAuth() {
  return {
    ok: true,
    ctx: {
      admin: { admin_id: state.authAdminId, name: state.authAdminName, role: "admin", active: true },
      safeAdmin: { admin_id: state.authAdminId, role: "admin" },
    },
  };
}

export async function requirePageAccess() {
  if (!state.pageAccessAllowed) return { ok: false, response: new Response(JSON.stringify({ detail: "forbidden" }), { status: 403 }) };
  return requireAuth();
}

// ── productService mock ──
export const productService = {
  async getProductsByIds() { return []; },
  async listProducts() { return []; },
  async getProduct() { return null; },
  async listShopsByPlatform() { return []; },
};

// ── mockSendService stub — mirror production semantics บน fake mongo ──
//   mockFail → throw ก่อน insert (transport ล้ม = ไม่มี request log)
//   ปกติ → deterministic insert เหมือน production; E11000 → reuse receipt
export async function sendMockPart(part) {
  if (state.mockFail) throw new Error("mock transport exploded");
  state.mockCalls.push(part);
  try {
    await (await getCollection("botworker_events")).insertOne({
      _id: part.eventId, event_id: part.eventId,
      conversation_id: part.conversationId, type: "mock_send",
      actor: part.actor, shop_id: part.shopId, platform: part.platform,
      metadata: {
        reply_id: part.replyId, bubble_id: part.bubbleId, send_part: part.part,
        ...(part.part === "text" ? { text: part.text } : { item_id: part.item_id }),
        ...(part.inboundMessageId ? { reply_to_message_id: part.inboundMessageId } : {}),
        provider: "mock", delivered: false,
      },
      created_at: new Date(),
    });
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
  return { provider: "mock", delivered: false, request_id: part.eventId };
}

// ── Shopee outbound fake — safe test-only seam; no credentials or network ──
export const isShopeeConsoleSendEnabled = async () => state.shopeeSendEnabled;
export const outboundMessageId = (requestId) => "fake_" + requestId;
export async function sendShopeeMessage(request) {
  state.fakeShopeeCalls.push(request);
  return {
    state: "sent",
    type: request.input?.type || "text",
    text: request.input?.text || "",
    providerMessageId: "fake-provider-" + state.fakeShopeeCalls.length,
  };
}
