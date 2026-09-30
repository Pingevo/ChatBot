// Shared in-memory mock สำหรับ backend modules ที่แตะ Mongo/env
// ถูก redirect มาที่นี่โดย test-shadow-batch-isolation-hooks.mjs (resolve hook)
// behavior ทั้งหมดขับเคลื่อนโดย globalThis.__SHADOW_TEST ที่ test script ตั้งไว้

const st = () => globalThis.__SHADOW_TEST;

// ── mongoClient ──────────────────────────────────────────────
export const COLLECTIONS = {
  shadowReplies: "shadow_replies",
  messages: "messages",
  conversations: "conversations",
};
export async function getCollection(name) {
  return st().getCollection(name);
}

// ── messageService ───────────────────────────────────────────
export async function listMessages(conversationId, opts) {
  return st().listMessages(conversationId, opts);
}
export async function getHistoryForBot(opts) {
  return st().getHistoryForBot(opts);
}
export function toBotText(msg) {
  return st().toBotText(msg);
}
export function toBotImages(msg) {
  return st().toBotImages(msg);
}

// ── conversationService ──────────────────────────────────────
export async function getConversation(conversationId) {
  return st().getConversation(conversationId);
}

// ── adminLogService ──────────────────────────────────────────
export async function logAdminEvent(opts) {
  return st().logAdminEvent(opts);
}

// ── config (route-level: callOurBot อ่าน chatbotBaseUrls/internalSecret) ──
export const serverConfig = st().serverConfig;
export const MAX_FAILED_LOGIN = 5;
export const LOCK_MINUTES = 15;

// ── systemConfigService (route-level: engine flags + product limit) ──
export async function shouldUseChatV2() {
  return false;
}
export async function shouldUseChatV3() {
  return false;
}
export async function getBotProductLimit() {
  return 10;
}

// ── authorize (route-level: requireAuth) ─────────────────────
export async function requireAuth() {
  return st().requireAuth();
}

// ── http (route-level: readJson/json/error) ──────────────────
export async function readJson(req) {
  return st().readJson(req);
}
export function json(body, status = 200) {
  return Response.json(body, { status });
}
export function error(detail, status = 400) {
  return Response.json({ detail }, { status });
}
export function unauthorized(detail = "unauthorized") {
  return error(detail, 401);
}
export function forbidden(detail = "forbidden") {
  return error(detail, 403);
}
export function clientIp() {
  return "";
}
