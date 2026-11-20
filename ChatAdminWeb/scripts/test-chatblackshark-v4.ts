import { register } from "node:module";
register(new URL("./test-chatblackshark-v4-hooks.mjs", import.meta.url));

process.env.ADMIN_JWT_SECRET = "test-jwt-secret";
process.env.CHATBOT_INTERNAL_SECRET = "test-internal-secret";
process.env.CHATBLACKSHARK_BOTWORKER_SHOP_IDS = "1191420560";
process.env.CHATBLACKSHARK_ENGINE_URL = "https://engine.example";
process.env.CHATBLACKSHARK_ENGINE_TOKEN = "test-token";

async function main() {
const { callBot } = await import("../src/backend/service/botCallService");
const { writes } = await import("./test-chatblackshark-v4-mongo.mjs");
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  if (url.endsWith("/api/engine/answer")) {
    const body = JSON.parse(String(init?.body));
    if (body.message_id !== "m1" || body.shop_id !== "1191420560") throw new Error("wrong identity");
    return Response.json({ answer: "มี GS3 ครับ", conversation_id: "c1", message_id: "m1",
      image_desc: "เห็น GS3", products: [{ item_id: "1" }], handoff_required: false });
  }
  return Response.json({ answer: "legacy response" });
}) as typeof fetch;

const base = { platform: "shopee" as const, shopId: "1191420560", message: "GS3 มีไหม",
  history: [], conversationId: "c1", messageId: "m1", testSource: "botworker" };
const v4 = await callBot(base);
if (v4.chat_engine !== "v4" || v4.answer !== "มี GS3 ครับ" || writes.length !== 1 ||
    writes[0].filter.conversation_id !== "c1") throw new Error("v4 response/persistence failed");
const old = await callBot({ ...base, shopId: "another-shop" });
if (old.chat_engine !== "legacy" || old.answer !== "legacy response") throw new Error("shop opt-in leaked");
if (calls.filter((url) => url.endsWith("/api/engine/answer")).length !== 1) throw new Error("wrong v4 call count");
console.log("PASS v4 exact-shop opt-in, BotWorker response, image description persistence, other-shop isolation");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
