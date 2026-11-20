// Bot call service — แยก callBot ออกจาก botWorkerService
// เหตุผล: workflowEngine ต้องเรียก callBot (action let_ai_respond)
// และ botWorkerService.processMessage ต้องเรียก workflowEngine
// ถ้าทั้งคู่ import กันตรงๆ จะเกิด circular dependency → แยก callBot เป็น module ตรงกลาง
import { serverConfig } from "../lib/config";
import type { Platform } from "./systemConfigService";
import { getChatEngine, getBotProductLimit, type ChatEngine } from "./systemConfigService";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { botworkerRuntime } from "./botworkerRuntime";

export interface BotCallParams {
  platform: Platform;
  message: string;
  shopId: string;
  shopName?: string;
  itemId?: string;
  orderSn?: string;
  // ⚡ Phase 1A multimodal — history อาจมี images + image_desc ของ turn ก่อนหน้า
  history: { role: "user" | "model"; text: string; images?: string[]; image_desc?: string }[];
  // ⚡ Phase 1A multimodal — URL รูปที่ลูกค้าส่งใน turn นี้
  images?: string[];
  // ⚡ Phase 2A — state-driven handoff: conversation_id + simulate flag
  //    ถ้ามี → ดึง status จาก DB แล้วส่ง ticket_state ให้บอท
  conversationId?: string;
  messageId?: string;
  simulate?: boolean;
  // ⚡ botworker parallel — ระบุ test source ("botworker" ฯลฯ)
  //    → ticket_state อ่านจาก test_status_conversation(source)
  //    → Python _send_handoff ส่ง test_source กลับ → bot-handoff route เขียน test store
  testSource?: string;
  // ⚡ bounded HTTP timeout — caller (botworker) ส่ง AbortSignal.timeout(botCallTimeoutMs)
  //    รวมกับ ownership-abort; timeout ต้อง < claim lease
  signal?: AbortSignal;
}

export interface BotCallResponse {
  answer: string;
  source?: string;
  model?: string;
  elapsed?: number;
  usage?: { prompt: number; output: number; total: number };
  cost?: number;
  products?: unknown[];
  // ⚡ Phase 1A multimodal — description ที่สกัดจากรูปใน turn นี้
  //    caller เก็บไว้ใน message doc เพื่อส่งกลับใน history ของ turn ถัดไป
  image_desc?: string;
  // ⚡ chat_engine — engine กลางที่ตอบ (legacy / v2 / v3 / v4)
  chat_engine?: ChatEngine;
  handoff_required?: boolean;
  handoff_reason?: string;
  // ⚡ R5 — turn correlation id จาก Python (ตรง ai_usage.request_id) → shadow chain
  request_id?: string;
}

/** ⚡ Phase 2B.6 — admin claim outcome ที่ transport ไป Python (production เท่านั้น) */
interface ClaimOutcomeWire {
  episode_id: string;
  outcome: "resolved" | "cancelled";
  actor_id: string;
  occurred_at: Date;
}

/**
 * ⚡ Phase 2A — ดึง ticket state จาก DB
 *   testSource → test_status_conversation(source) — botworker parallel sandbox
 *   simulate=true (ไม่มี testSource) → test_chat_sessions (test-chat mock)
 *   production → status_conversation เท่านั้น (authoritative owner เดียว)
 *     - meta.status → ส่งค่าตรงๆ (handoff/open/pending → Python lock;
 *       bot/closed/resolved → Python unlock)
 *     - meta ไม่มี หรือไม่มี status → "bot" (explicit unlocked — ห้าม omit
 *       เพราะ Python fallback ไป history scan เมื่อ ticket_state เป็น null)
 *     - meta.claim_outcome → claim outcome transport (Phase 2B.6 —
 *       test/simulate ไม่มี outcome — isolation)
 *     - meta read error → throw (fail closed — caller ห้ามเรียก Python)
 *   คืน { state, claimOutcome } — state: "open"|"closed"|"handoff"|"resolved"|"pending"|"bot"|null
 */
async function resolveTicketState(
  conversationId: string | undefined,
  simulate: boolean | undefined,
  testSource: string | undefined
): Promise<{ state: string | null; claimOutcome: ClaimOutcomeWire | null }> {
  if (!conversationId) return { state: null, claimOutcome: null };
  if (testSource) {
    // ⚡ parallel sandbox — อ่านจาก test_status_conversation เท่านั้น
    const coll = await getCollection<{ conversation_id: string; source: string; status?: string }>(COLLECTIONS.testStatusConversation);
    const doc = await coll.findOne({ conversation_id: conversationId, source: testSource });
    return { state: doc?.status || null, claimOutcome: null };
  }
  if (simulate) {
    // test chat — ดึงจาก test_chat_sessions
    const { ObjectId } = await import("mongodb");
    const coll = await getCollection<{ _id: typeof ObjectId.prototype; status?: string }>(COLLECTIONS.testChatSessions);
    const doc = await coll.findOne({ _id: new ObjectId(conversationId) });
    return { state: doc?.status || null, claimOutcome: null };
  }
  // production ownership authority = status_conversation เท่านั้น
  //   ห้าม fallback ไป conversations(_shp).status — dump เขียนทับทุก 2 วิ
  const coll = await getCollection<{
    conversation_id: string; status?: string; claim_outcome?: ClaimOutcomeWire | null;
  }>(COLLECTIONS.statusConversation);
  const doc = await coll.findOne({ conversation_id: conversationId });
  return { state: doc?.status || "bot", claimOutcome: doc?.claim_outcome ?? null };
}

/** เรียก Python bot ตรง (server-to-server ใช้ x-internal-secret — ไม่ใช้ cookie) */
// ─── Botworker outbound concurrency — owner เดียวสำหรับทุก worker path ──
// ⚡ limiter ต้องอยู่ที่ outbound boundary (callBot) — botWorkerService มี 2 call sites
//   (direct + trigger bot_answer) และ workflowEngine.let_ai_respond เรียก callBot ตรง
//   ถ้า limiter อยู่ฝั่ง worker workflow path จะ bypass → ย้ายมาที่นี่จุดเดียว
//   apply เฉพาะ testSource === "botworker" — normal ticket/live callers ไม่เปลี่ยน behavior
//   queue รองรับ AbortSignal — abort ก่อน/กลาง queue → waiter ถูก remove ไม่เรียก fetch
//   เพดานมาจาก config owner (systemConfigService) จุดเดียว — healthy = ค่าจริง,
//   read failure = last-known-good / cold-start fail-closed 1 — fallback default 50
//   ไม่มีทางขยายเพดานตอน admission หรือ drain
//   admin ลด limit มีผลทันที, เพิ่ม limit propagate ผ่าน acquire/drain ตามค่าอ่านได้

interface BotCallWaiter {
  resolve(): void;
  reject(err: unknown): void;
  signal?: AbortSignal;
  onAbort(): void;
}

let activeBotCalls = 0;
const botCallQueue: BotCallWaiter[] = [];

function acquireBotCallSlot(limit: number, signal?: AbortSignal): Promise<void> | void {
  if (signal?.aborted) throw signal.reason ?? new Error("bot call aborted");
  if (activeBotCalls < limit) {
    activeBotCalls++;
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: BotCallWaiter = {
      resolve,
      reject,
      signal,
      onAbort() {
        const i = botCallQueue.indexOf(waiter);
        if (i >= 0) botCallQueue.splice(i, 1);
        reject(signal!.reason ?? new Error("bot call aborted"));
      },
    };
    botCallQueue.push(waiter);
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
  });
}

async function releaseBotCallSlot(): Promise<void> {
  activeBotCalls--;
  // ⚡ drain อ่าน limit จาก config owner จุดเดียว — getSystemConfig คืน last-known-good
  //   เมื่อ read ล้ม (cold-start → fail-closed 1) — เพดานไม่ขยายจากค่า fallback
  let limit = 1;
  try {
    const { getSystemConfig } = await import("./systemConfigService");
    const fresh = (await getSystemConfig()).bot_concurrency_limit;
    if (typeof fresh === "number" && fresh > 0) limit = fresh;
  } catch {
    // read throw ที่ไม่คาด → fail-closed ที่ 1 (ข้าม drain ไป slot ถัดไปรอ release ถัดไป)
  }
  while (botCallQueue.length && activeBotCalls < limit) {
    const w = botCallQueue.shift()!;
    w.signal?.removeEventListener("abort", w.onAbort);
    activeBotCalls++;
    w.resolve();
  }
}

export async function callBot(params: BotCallParams): Promise<BotCallResponse> {
  const baseUrl = serverConfig.chatbotBaseUrls[params.platform] || serverConfig.chatbotBaseUrls.shopee;
  const url = baseUrl.replace(/\/$/, "") + "/chat";
  // ⚡ Phase 2A — ดึง ticket_state + claim_outcome จาก DB (testSource → test store)
  const { state: ticketState, claimOutcome } =
    await resolveTicketState(params.conversationId, params.simulate, params.testSource);
  // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม)
  const chatEngine = await getChatEngine();
  const useV2 = chatEngine === "v2";
  const useV3 = chatEngine === "v3";
  // ⚡ Phase 8 — อ่าน llm_context_limit จาก SystemConfig (หน้า config ควบคุม)
  const { getSystemConfig } = await import("./systemConfigService");
  const sysConfig = await getSystemConfig();
  const llmContextLimit = sysConfig.llm_context_limit ?? 30;
  // ⚡ ใช้ค่าเดียวกับ llm_context_limit เป็น limit (frontend display) ด้วย
  //   ก่อนหน้านี้ไม่ได้ส่ง limit → bot default 10 → shadow inbox เห็นแค่ 10 สินค้า
  //   ตอนนี้ส่ง limit = llm_context_limit → shadow inbox เห็นสินค้าเท่ากับที่ LLM เห็น
  const productLimit = await getBotProductLimit();
  // ⚡ botworker outbound ทุก path (direct/trigger/workflow) ผ่าน limiter เดียวที่นี่ —
  //   acquire ก่อน fetch, release ใน finally; non-botworker callers ไม่ถูก limit
  const isWorkerCall = params.testSource === "botworker";
  let slotHeld = false;
  if (isWorkerCall) {
    // ⚡ admission limit มาจาก config owner เดียว — getSystemConfig รับประกัน
    //   last-known-good/fail-closed แล้ว (ไม่มี fallback-50 รั่วมาที่นี่)
    const confLimit = sysConfig.bot_concurrency_limit;
    await acquireBotCallSlot(typeof confLimit === "number" && confLimit > 0 ? confLimit : 1, params.signal);
    slotHeld = true;
  }
  // ⚡ bounded timeout สำหรับ worker outbound ทุก path — composition owner เดียวที่นี่
  //   (direct/trigger/workflow เข้าทาง params.signal = era+ownership แล้ว;
  //   non-worker callers ไม่เพิ่ม timeout — signal semantics เดิม)
  const fetchSignal = isWorkerCall
    ? AbortSignal.any([
        ...(params.signal ? [params.signal] : []),
        AbortSignal.timeout(botworkerRuntime.botCallTimeoutMs),
      ])
    : params.signal;
  try {
    if (chatEngine === "v4") {
      return await callChatBlacksharkV4({ ...params, signal: fetchSignal });
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": serverConfig.chatbotInternalSecret,
      },
      body: JSON.stringify({
        message: params.message,
        shop: params.shopName || params.shopId,
        history: params.history,
        limit: productLimit,
        ...(params.images?.length ? { images: params.images } : {}),
        ...(ticketState ? { ticket_state: ticketState } : {}),
        ...(claimOutcome ? { claim_outcome: {
          episode_id: claimOutcome.episode_id,
          outcome: claimOutcome.outcome,
          actor_id: claimOutcome.actor_id,
          occurred_at: claimOutcome.occurred_at instanceof Date
            ? claimOutcome.occurred_at.toISOString()
            : String(claimOutcome.occurred_at),
        } } : {}),
        ...(params.conversationId ? { conversation_id: params.conversationId } : {}),
        ...(params.simulate || params.testSource ? { simulate_assignment: true } : {}),
        ...(params.testSource ? { test_source: params.testSource } : {}),
        use_v3: useV3,
        use_v2: useV2,
        llm_context_limit: llmContextLimit,
      }),
      ...(fetchSignal ? { signal: fetchSignal } : {}),
    });
    if (!resp.ok) throw new Error(`bot call failed: ${resp.status}`);
    const data = await resp.json();
    return {
      answer: data.answer || "",
      source: data.source,
      model: data.model,
      elapsed: typeof data.elapsed === "number" ? data.elapsed : undefined,
      usage: data.usage,
      cost: typeof data.cost === "number" ? data.cost : undefined,
      products: data.products,
      image_desc: typeof data.image_desc === "string" ? data.image_desc : undefined,
      chat_engine: chatEngine,
      request_id: typeof data.request_id === "string" ? data.request_id : undefined,
    };
  } finally {
    if (slotHeld) await releaseBotCallSlot();
  }
}

/** Route a call from any page through the globally selected ChatBlackshark engine. */
export async function callChatBlacksharkV4(params: BotCallParams): Promise<BotCallResponse> {
  const allowedShops = new Set((process.env.CHATBLACKSHARK_BOTWORKER_SHOP_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  if (!allowedShops.has(params.shopId)) throw new Error("chatblackshark_shop_not_enabled_for_v4");
  const baseUrl = process.env.CHATBLACKSHARK_ENGINE_URL?.replace(/\/$/, "");
  const token = process.env.CHATBLACKSHARK_ENGINE_TOKEN;
  if (!baseUrl || !token) throw new Error("chatblackshark_engine_not_configured");

  const useStoredConversation = !!params.conversationId && !!params.messageId &&
    (!params.simulate || params.testSource === "botworker" || params.testSource === "test_assignment") &&
    params.testSource !== "test_chat" && params.testSource !== "shadow";
  const endpoint = useStoredConversation ? "/api/engine/answer" : "/api/engine/test-answer";
  const explicitItemId = params.itemId || params.message.match(/\[สินค้า:\s*([^\]]+)\]/)?.[1]?.trim();
  const payload = useStoredConversation
    ? { conversation_id: params.conversationId, message_id: params.messageId,
        shop_id: params.shopId, platform: params.platform }
    : { question: params.message, history: params.history, shop_id: params.shopId,
        shop_name: params.shopName,
        platform: params.platform, images: params.images || [],
        item_ids: explicitItemId ? [explicitItemId] : [], order_sn: params.orderSn };
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!response.ok) throw new Error(`chatblackshark_engine_failed:${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  if (useStoredConversation && (data.conversation_id !== params.conversationId || data.message_id !== params.messageId)) {
    throw new Error("chatblackshark_engine_identity_mismatch");
  }
  const imageDesc = typeof data.image_desc === "string" ? data.image_desc :
    typeof data.image_description === "string" ? data.image_description : "";
  if (imageDesc && useStoredConversation && !params.simulate && params.messageId && params.conversationId) {
    const messages = await getCollection(COLLECTIONS.messages);
    await messages.updateOne({ message_id: params.messageId, conversation_id: params.conversationId,
      shop_id: params.shopId, platform: params.platform, image_desc: { $exists: false } },
      { $set: { image_desc: imageDesc } });
  }
  return {
    answer: typeof data.answer === "string" ? data.answer : "",
    source: "chatblackshark",
    products: Array.isArray(data.products) ? data.products :
      Array.isArray(data.product_cards) ? data.product_cards : [],
    image_desc: imageDesc,
    chat_engine: "v4",
    handoff_required: data.handoff_required === true,
    handoff_reason: typeof data.handoff_reason === "string" ? data.handoff_reason : undefined,
    request_id: typeof data.request_id === "string" ? data.request_id : undefined,
  };
}

export async function resolveChatShopId(platform: Platform, shopName: string): Promise<string> {
  const shops = await getCollection<{ shop_id: string; shopname: string; platform: Platform }>(COLLECTIONS.shops);
  const key = shopName.trim();
  const matches = await shops.find({ platform, $or: [{ shop_id: key }, { shopname: key }] },
    { projection: { shop_id: 1 } }).limit(2).toArray();
  if (matches.length !== 1 || !matches[0]?.shop_id) throw new Error("chat_engine_shop_scope_ambiguous");
  return matches[0].shop_id;
}
