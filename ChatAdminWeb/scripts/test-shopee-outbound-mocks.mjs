// Fake leaf modules for test-shopee-outbound.ts — no network: Sellcenter token via fake fetch, Shopee via fake https.request
import { EventEmitter } from "node:events";
import { createFakeMongo } from "./test-botworker-fakemongo.mjs";

export const state = {
  uniqueKeys: {},
  config: { shopee_console_send_enabled: true },
  conversations: { conv_bs: { conversation_id: "conv_bs", platform: "shopee", shop_id: "1191420560", customer_id: "47475337", shop_name: "BlackShark" } },
  tokenCalls: [],
  shopeeCalls: [],
  tokenResponder: null,
  shopeeResponder: null,
  product: null,
};
const fm = createFakeMongo(state);
export const getCollection = fm.getCollection;
export const COLLECTIONS = fm.COLLECTIONS;
export const fakeColl = fm.fakeColl;
export const store = fm.store;

export const systemConfigService = { getSystemConfig: async () => ({ ...state.config }) };
export const conversationService = { getConversation: async (id) => state.conversations[id] || null };
export const productService = { getProduct: async () => state.product };

globalThis.fetch = async (url, init) => {
  state.tokenCalls.push({ url: String(url), headers: init?.headers });
  const r = state.tokenResponder(String(url));
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
};

export function request(url, _opts, callback) {
  const listeners = {};
  let body;
  const req = {
    on(event, fn) { listeners[event] = fn; return req; },
    write(chunk) { body = chunk; },
    destroy(err) { listeners.error?.(err); },
    end() {
      setImmediate(() => {
        state.shopeeCalls.push({ url: String(url), body: body ? Buffer.from(body).toString("utf8") : "" });
        const r = state.shopeeResponder(String(url));
        if (r.networkError) { listeners.error?.(r.networkError); return; }
        const res = new EventEmitter();
        res.statusCode = r.status ?? 200;
        callback(res);
        res.emit("data", Buffer.from(JSON.stringify(r.body)));
        res.emit("end");
      });
    },
  };
  return req;
}

export function reset() {
  state.config = { shopee_console_send_enabled: true };
  state.tokenCalls.length = 0;
  state.shopeeCalls.length = 0;
  fm.store.clear?.();
  for (const key of Object.keys(fm.store || {})) delete fm.store[key];
}
