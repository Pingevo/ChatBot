// Bot call service — แยก callBot ออกจาก botWorkerService
// เหตุผล: workflowEngine ต้องเรียก callBot (action let_ai_respond)
// และ botWorkerService.processMessage ต้องเรียก workflowEngine
// ถ้าทั้งคู่ import กันตรงๆ จะเกิด circular dependency → แยก callBot เป็น module ตรงกลาง
import { serverConfig } from "../lib/config";
import type { Platform } from "./systemConfigService";
import { getChatEngine, getBotProductLimit, type ChatEngine } from "./systemConfigService";
import { getCollection, COLLECTIONS } from "../db/mongoClient";
import { botworkerRuntime } from "./botworkerRuntime";
import { getPersona, type ShopPersonaDoc } from "./personaService";

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
  includePersona?: boolean;
  persistImageDescription?: boolean;
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
  answer_segments?: unknown;
  intent?: unknown;
  timing?: unknown;
  retrieval_info?: unknown;
  web_search_used?: boolean;
  web_search_reason?: string;
  web_search_model?: string;
  steps?: unknown;
  routing_decision?: unknown;
  handoff_to_admin?: boolean;
}

export class ChatEngineDispatchError extends Error {
  constructor(readonly status: number, readonly responseBody: unknown, message: string, readonly chat_engine?: ChatEngine) {
    super(message);
    this.name = "ChatEngineDispatchError";
  }
}

export interface ChatEngineDispatchParams {
  platform: Platform;
  pythonPayload: Record<string, unknown>;
  v4Params: BotCallParams;
  engine?: ChatEngine;
  signal?: AbortSignal;
  pythonHeaders?: Record<string, string>;
  timeoutMs?: number;
  max429Retries?: number;
  retryWaitMs?: number;
  maxNon429Retries?: number;
  non429RetryWaitMs?: number;
  pythonUnsupportedMessage?: string;
}

export interface ChatEngineDispatchResult {
  chat_engine: ChatEngine;
  data: Record<string, any>;
}

/** Shared transport owner for Python chat engines and ChatBlackshark v4. */
export async function dispatchChatEngine(params: ChatEngineDispatchParams): Promise<ChatEngineDispatchResult> {
  const engine = params.engine || await getChatEngine();
  if (engine === "v4") {
    const v4Params = { ...params.v4Params, signal: params.signal || params.v4Params.signal };
    try {
      if (!v4Params.shopId?.trim() && v4Params.shopName?.trim()) {
        v4Params.shopId = await resolveChatShopId(params.platform, v4Params.shopName);
      }
      if (!v4Params.shopId?.trim()) throw new Error("chat_engine_shop_required");
      const data = await callChatBlacksharkV4(v4Params);
      return { chat_engine: engine, data: data as Record<string, any> };
    } catch (cause) {
      throw new ChatEngineDispatchError(502, {}, cause instanceof Error ? cause.message : String(cause), engine);
    }
  }
  if (params.pythonUnsupportedMessage) {
    throw new ChatEngineDispatchError(501, {}, params.pythonUnsupportedMessage, engine);
  }

  const baseUrl = serverConfig.chatbotBaseUrls[params.platform] || serverConfig.chatbotBaseUrls.shopee;
  const url = `${baseUrl.replace(/\/$/, "")}/chat`;
  const retries = Math.max(0, params.max429Retries || 0);
  const retryWaitMs = params.retryWaitMs ?? 60_000;
  const non429Retries = Math.max(0, params.maxNon429Retries || 0);
  const non429RetryWaitMs = params.non429RetryWaitMs ?? 2_000;
  let rateLimitRetriesUsed = 0;
  let non429RetriesUsed = 0;
  for (let attempt = 0; attempt <= retries + non429Retries; attempt++) {
    try {
      const signal = params.timeoutMs
        ? AbortSignal.any([...(params.signal ? [params.signal] : []), AbortSignal.timeout(params.timeoutMs)])
        : params.signal;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": serverConfig.chatbotInternalSecret,
          ...params.pythonHeaders,
        },
        body: JSON.stringify({
          ...params.pythonPayload,
          use_v2: engine === "v2",
          use_v3: engine === "v3",
        }),
        ...(signal ? { signal } : {}),
      });
      if (response.status === 429) {
        if (rateLimitRetriesUsed < retries) {
          rateLimitRetriesUsed++;
          await response.body?.cancel().catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
          continue;
        }
      }
      const text = await response.text();
      let data: Record<string, any> = {};
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
      } catch {
        if (text) data = { detail: text };
      }
      if (!response.ok) {
        if (response.status !== 429 && non429RetriesUsed < non429Retries) {
          non429RetriesUsed++;
          await new Promise((resolve) => setTimeout(resolve, non429RetryWaitMs));
          continue;
        }
        const message = response.status === 429 && retries > 0
          ? `bot 429 rate limit — ลอง ${retries} ครั้งแล้ว ยกเลิก`
          : `bot call failed (${response.status}): ${text.slice(0, 200)}`;
        throw new ChatEngineDispatchError(response.status, data, message, engine);
      }
      return { chat_engine: engine, data };
    } catch (cause) {
      if (cause instanceof ChatEngineDispatchError) {
        if (cause.status === 429 && rateLimitRetriesUsed < retries) {
          rateLimitRetriesUsed++;
          await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
          continue;
        }
        throw cause;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("429") && rateLimitRetriesUsed < retries) {
        rateLimitRetriesUsed++;
        await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
        continue;
      }
      if (non429RetriesUsed < non429Retries) {
        non429RetriesUsed++;
        await new Promise((resolve) => setTimeout(resolve, non429RetryWaitMs));
        continue;
      }
      throw new ChatEngineDispatchError(502, {}, message, engine);
    }
  }
  throw new ChatEngineDispatchError(429, {}, `bot 429 rate limit — ลอง ${retries} ครั้งแล้ว ยกเลิก`, engine);
}

interface EngineAccessToken {
  value: string;
  refreshAt: number;
}

const engineAccessTokens = new Map<string, EngineAccessToken>();
const pendingEngineTokens = new Map<string, Promise<string>>();

async function getEngineAccessToken(
  baseUrl: string,
  issuerSecret: string,
  signal?: AbortSignal,
  rejectedToken?: string,
): Promise<string> {
  const cacheKey = `${baseUrl}\n${issuerSecret}`;
  const cached = engineAccessTokens.get(cacheKey);
  if (rejectedToken && cached && cached.value !== rejectedToken) return cached.value;
  if (!rejectedToken && cached && Date.now() < cached.refreshAt) return cached.value;

  const pending = pendingEngineTokens.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const response = await fetch(`${baseUrl}/api/engine/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${issuerSecret}` },
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`chatblackshark_token_request_failed:${response.status}`);
    }
    const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token ||
        typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
      throw new Error("chatblackshark_token_response_invalid");
    }
    const refreshLeadSeconds = Math.min(60, Math.floor(body.expires_in / 3));
    engineAccessTokens.set(cacheKey, {
      value: body.access_token,
      refreshAt: Date.now() + Math.max(1, body.expires_in - refreshLeadSeconds) * 1000,
    });
    return body.access_token;
  })();
  pendingEngineTokens.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (pendingEngineTokens.get(cacheKey) === request) pendingEngineTokens.delete(cacheKey);
  }
}

function boundedPersonaNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : fallback;
}

function toEnginePersona(persona: ShopPersonaDoc): Record<string, unknown> | undefined {
  if (!persona.enabled || !persona.bot_name.trim()) return undefined;
  const length = ["short", "medium", "long"].includes(persona.length || "")
    ? persona.length
    : "medium";
  const voice = persona.voice === "female" ? "female" : "male";
  return {
    bot_name: persona.bot_name.trim().slice(0, 80),
    persona_text: (persona.persona_text ?? persona.notes ?? "").trim().slice(0, 2000),
    friendliness: boundedPersonaNumber(persona.friendliness, 50),
    length,
    detail_level: boundedPersonaNumber(persona.detail_level, 50),
    voice,
  };
}

async function loadEnginePersona(params: BotCallParams): Promise<Record<string, unknown> | undefined> {
  if (params.includePersona === false || !params.shopName?.trim()) return undefined;
  try {
    const persona = await getPersona(params.shopName.trim(), params.platform);
    return persona ? toEnginePersona(persona) : undefined;
  } catch (error) {
    // Persona is presentation metadata; a Mongo persona read failure must not block a scoped answer.
    console.warn("[chatblackshark-engine] persona_lookup_failed", {
      platform: params.platform,
      shop_id: params.shopId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
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
  // ⚡ Phase 2A — ดึง ticket_state + claim_outcome จาก DB (testSource → test store)
  const { state: ticketState, claimOutcome } =
    await resolveTicketState(params.conversationId, params.simulate, params.testSource);
  // ⚡ chat_engine — อ่านจาก SystemConfig (หน้า config ควบคุม)
  const chatEngine = await getChatEngine();
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
    const { data } = await dispatchChatEngine({
      platform: params.platform,
      engine: chatEngine,
      signal: fetchSignal,
      pythonPayload: {
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
        llm_context_limit: llmContextLimit,
      },
      v4Params: { ...params, signal: fetchSignal },
    });
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
      answer_segments: data.answer_segments,
      intent: data.intent,
      timing: data.timing,
      retrieval_info: data.retrieval_info,
      web_search_used: data.web_search_used === true,
      web_search_reason: data.web_search_reason,
      web_search_model: data.web_search_model,
      steps: data.steps,
      routing_decision: data.routing_decision,
      handoff_to_admin: data.handoff_to_admin === true || data.handoff_required === true,
      handoff_required: data.handoff_required === true,
      handoff_reason: typeof data.handoff_reason === "string" ? data.handoff_reason : undefined,
    };
  } finally {
    if (slotHeld) await releaseBotCallSlot();
  }
}

/** Route a call from any page through the globally selected ChatBlackshark engine. */
export async function callChatBlacksharkV4(params: BotCallParams): Promise<BotCallResponse> {
  if (!params.shopId?.trim()) throw new Error("chatblackshark_shop_required");
  const baseUrl = process.env.CHATBLACKSHARK_ENGINE_URL?.replace(/\/$/, "");
  const issuerSecret = process.env.CHATBLACKSHARK_TOKEN_ISSUER_SECRET;
  if (!baseUrl || !issuerSecret || issuerSecret.length < 32) {
    throw new Error("chatblackshark_engine_not_configured");
  }

  const useStoredConversation = !!params.conversationId && !!params.messageId &&
    (!params.simulate || params.testSource === "botworker" || params.testSource === "test_assignment") &&
    params.testSource !== "test_chat" && params.testSource !== "shadow";
  const endpoint = useStoredConversation ? "/api/engine/answer" : "/api/engine/test-answer";
  const explicitItemId = params.itemId || params.message.match(/\[สินค้า:\s*([^\]]+)\]/)?.[1]?.trim();
  const persona = await loadEnginePersona(params);
  const payload = useStoredConversation
    ? { conversation_id: params.conversationId, message_id: params.messageId,
        shop_id: params.shopId, platform: params.platform, ...(persona ? { persona } : {}) }
    : { question: params.message, history: params.history, shop_id: params.shopId,
        shop_name: params.shopName,
        platform: params.platform, images: params.images || [],
        item_ids: explicitItemId ? [explicitItemId] : [], order_sn: params.orderSn,
        ...(persona ? { persona } : {}) };
  const requestWithToken = async (token: string) => fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  let token = await getEngineAccessToken(baseUrl, issuerSecret, params.signal);
  let response = await requestWithToken(token);
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    token = await getEngineAccessToken(baseUrl, issuerSecret, params.signal, token);
    response = await requestWithToken(token);
  }
  if (!response.ok) throw new Error(`chatblackshark_engine_failed:${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  if (useStoredConversation && (data.conversation_id !== params.conversationId || data.message_id !== params.messageId)) {
    throw new Error("chatblackshark_engine_identity_mismatch");
  }
  const imageDesc = typeof data.image_desc === "string" ? data.image_desc :
    typeof data.image_description === "string" ? data.image_description : "";
  if (imageDesc && params.persistImageDescription !== false && useStoredConversation && !params.simulate && params.messageId && params.conversationId) {
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
    intent: data.intent,
    timing: data.timing,
    retrieval_info: data.retrieval_info,
    web_search_used: data.web_search_used === true,
    web_search_reason: typeof data.web_search_reason === "string" ? data.web_search_reason : undefined,
    web_search_model: typeof data.web_search_model === "string" ? data.web_search_model : undefined,
    answer_segments: data.answer_segments,
    steps: data.steps,
    routing_decision: data.routing_decision,
    handoff_to_admin: data.handoff_to_admin === true || data.handoff_required === true,
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
