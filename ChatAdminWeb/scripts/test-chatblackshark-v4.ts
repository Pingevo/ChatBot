import { register } from "node:module";
register(new URL("./test-chatblackshark-v4-hooks.mjs", import.meta.url));

process.env.ADMIN_JWT_SECRET = "test-jwt-secret";
process.env.CHATBOT_INTERNAL_SECRET = "test-internal-secret";
process.env.CHATBLACKSHARK_ENGINE_URL = "https://engine.example";
process.env.CHATBLACKSHARK_TOKEN_ISSUER_SECRET = "issuer-secret-for-tests-at-least-32-characters";
process.env.TEST_CHAT_ENGINE = "v4";
delete process.env.CHATBLACKSHARK_BOTWORKER_SHOP_IDS;
delete process.env.CHATBLACKSHARK_ENGINE_TOKEN;

async function main() {
const { callBot } = await import("../src/backend/service/botCallService");
const { writes } = await import("./test-chatblackshark-v4-mongo.mjs");
const answerCalls: { url: string; authorization: string; body: Record<string, unknown> }[] = [];
let tokenRequests = 0;
let firstAnswerAttempt = true;
let legacyPayload: Record<string, unknown> = { answer: "legacy response" };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/engine/token")) {
    if (new Headers(init?.headers).get("authorization") !==
        `Bearer ${process.env.CHATBLACKSHARK_TOKEN_ISSUER_SECRET}`) {
      throw new Error("issuer secret was not sent to token endpoint");
    }
    tokenRequests++;
    return Response.json({ access_token: `access-${tokenRequests}`, token_type: "Bearer", expires_in: 600 });
  }
  if (url.endsWith("/api/engine/answer")) {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const authorization = new Headers(init?.headers).get("authorization") || "";
    answerCalls.push({ url, authorization, body });
    if (body.message_id === "m1" && firstAnswerAttempt) {
      firstAnswerAttempt = false;
      return Response.json({ detail: "expired" }, { status: 401 });
    }
    return Response.json({ answer: `ตอบร้าน ${body.shop_id} ครับ`, conversation_id: body.conversation_id,
      message_id: body.message_id, image_desc: "เห็นสินค้าจากภาพ", products: [{ item_id: "1" }], handoff_required: false });
  }
  if (url.endsWith("/chat")) return Response.json(legacyPayload);
  throw new Error(`unexpected URL ${url}`);
}) as typeof fetch;

const first = await callBot({ platform: "shopee", shopId: "1191420560", shopName: "Shop A",
  message: "GS3 มีไหม", history: [], conversationId: "c1", messageId: "m1", testSource: "botworker" });
const second = await callBot({ platform: "shopee", shopId: "another-shop", shopName: "Shop B",
  message: "มีสีอะไร", history: [], conversationId: "c2", messageId: "m2", testSource: "botworker" });
if (first.chat_engine !== "v4" || first.answer !== "ตอบร้าน 1191420560 ครับ") throw new Error("first V4 answer failed");
if (second.chat_engine !== "v4" || second.answer !== "ตอบร้าน another-shop ครับ") throw new Error("global V4 did not include the other shop");
if (tokenRequests !== 2) throw new Error(`expected one initial token and one refresh, got ${tokenRequests}`);
if (answerCalls.length !== 3) throw new Error(`expected one 401 retry plus two shop answers, got ${answerCalls.length}`);
if (answerCalls[0].authorization !== "Bearer access-1" || answerCalls[1].authorization !== "Bearer access-2" ||
    answerCalls[2].authorization !== "Bearer access-2") throw new Error("401 refresh/cache authorization failed");
for (const { body } of answerCalls) {
  const persona = body.persona as Record<string, unknown> | undefined;
  if (!persona || persona.bot_name !== `ผู้ช่วย ${body.shop_id === "1191420560" ? "Shop A" : "Shop B"}` ||
      persona.persona_text !== `บุคลิกของ ${body.shop_id === "1191420560" ? "Shop A" : "Shop B"}`) {
    throw new Error("shop persona was not included in the engine request");
  }
}
if (writes.length !== 2 || writes[0].filter.conversation_id !== "c1" || writes[1].filter.conversation_id !== "c2") {
  throw new Error("V4 image description persistence lost conversation scope");
}

process.env.TEST_CHAT_ENGINE = "legacy";
const legacy = await callBot({ platform: "shopee", shopId: "another-shop", shopName: "Shop B",
  message: "กลับไป legacy", history: [] });
if (legacy.chat_engine !== "legacy" || legacy.answer !== "legacy response") throw new Error("global selector did not switch back to legacy");
legacyPayload = { answer: "ส่งแอดมินแล้ว", handoff_to_admin: true, handoff_reason: "human_request" };
const reviewHandoff = await callBot({ platform: "shopee", shopId: "another-shop", shopName: "Shop B",
  message: "ขอคุยกับแอดมิน", history: [], conversationId: "c3", messageId: "m3", testSource: "botworker", simulate: true });
if (reviewHandoff.handoff_required !== true || reviewHandoff.handoff_to_admin !== false ||
    reviewHandoff.answer.includes("ส่งแอดมินแล้ว") || reviewHandoff.handoff_explanation !== "ส่งแอดมินแล้ว") {
  throw new Error("legacy BotWorker handoff was not converted to an honest review draft");
}
if (tokenRequests !== 2) throw new Error("legacy selection unexpectedly requested an engine token");
console.log("PASS global engine selection, shop-scoped V4, persona propagation, 10-minute token cache/401 refresh, and legacy switch-back");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
