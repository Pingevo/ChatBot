const state = globalThis.__PYTHON_ENGINE_V4_TEST;

export const serverConfig = {
  chatbotBaseUrls: {
    shopee: "http://127.0.0.1:8010",
    lazada: "http://127.0.0.1:8011",
    tiktok: "http://127.0.0.1:8012",
  },
  chatbotInternalSecret: "test-secret",
};

export async function getChatEngine() { return state.engine; }
export async function requireAuth() {
  return { ok: true, ctx: { admin: { admin_id: "admin-test", name: "Test", role: "dev" } } };
}
export async function requirePageEdit() {
  return { ok: true, ctx: { admin: { admin_id: "admin-test", name: "Test", role: "dev" } } };
}
export function json(body, status = 200) { return Response.json(body, { status }); }
export function error(message, status = 400) { return Response.json({ error: message }, { status }); }
export async function callChatBlacksharkV4() { throw new Error("unexpected v4 call in boundary test"); }
export async function resolveChatShopId() { throw new Error("unexpected shop lookup in boundary test"); }
export class ChatEngineDispatchError extends Error {}
export async function dispatchChatEngine(params) {
  const selected = { ...params, engine: params.engine || state.engine };
  state.dispatchCalls.push(selected);
  return { chat_engine: selected.engine, data: { answer: "bridge answer" } };
}
export async function readJson(req) { return req.json(); }
