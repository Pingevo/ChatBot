import assert from "node:assert/strict";
import Module from "node:module";
const mocks = await import("./test-shopee-outbound-mocks.mjs");
const sendErrors = await import("../src/lib/shopeeSendErrors.ts");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith("shopeeOutboundService.ts")) {
    if (request === "server-only") return {};
    if (request === "node:https") return { request: mocks.request };
    if (["../db/mongoClient", "./systemConfigService", "./conversationService", "./productService"].includes(request)) return mocks;
    if (request === "@/lib/shopeeSendErrors") return sendErrors;
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.SHOPEE_TOKEN_API_SERVICE_TOKEN = "fake-service-token";
process.env.SHOPEE_PARTNER_KEY = "fake-partner-key";

const { sendShopeeMessage } = await import("../src/backend/service/shopeeOutboundService.ts");
const token = { success: true, shop_id: "1191420560", partner_id: "2006107", access_token: "fake-access-token" };
let number = 0;

async function send(response) {
  mocks.reset();
  mocks.state.tokenResponder = () => ({ status: 200, body: token });
  mocks.state.shopeeResponder = () => response;
  number += 1;
  return sendShopeeMessage({ conversationId: "conv_bs", requestId: `fake_request_${number}`, input: { type: "text", text: "hello" } });
}

const diagnostics = [];
const originalInfo = console.info;
console.info = (...args) => diagnostics.push(args);
const rejected = await send({ status: 403, body: { error: "error_sign", message: "sign failed", request_id: "shopee-403" } });
const requestDiagnostic = diagnostics.find(([label]) => label === "[shopee-send] request")?.[1];
const responseDiagnostic = diagnostics.find(([label]) => label === "[shopee-send] response")?.[1];
assert.equal(requestDiagnostic?.method, "POST");
assert.equal(requestDiagnostic?.path, "/api/v2/sellerchat/send_message");
assert.deepEqual(requestDiagnostic?.sign_base_order, ["partner_id", "path", "timestamp", "access_token", "shop_id"]);
assert.equal(requestDiagnostic?.query?.partner_id, "2006107");
assert.equal(requestDiagnostic?.query?.shop_id, "1191420560");
assert.match(requestDiagnostic?.query?.access_token_sha256 || "", /^[a-f0-9]{12}$/);
assert.match(requestDiagnostic?.partner_key_sha256 || "", /^[a-f0-9]{12}$/);
assert.equal(requestDiagnostic?.body?.to_id, 47475337);
assert.equal(requestDiagnostic?.body?.message_type, "text");
assert.deepEqual(requestDiagnostic?.body?.content_fields, ["text"]);
assert.equal(responseDiagnostic?.http_status, 403);
assert.equal(responseDiagnostic?.error, "error_sign");
assert.equal(responseDiagnostic?.provider_request_id, "shopee-403");
const diagnosticText = JSON.stringify(diagnostics);
for (const secret of ["fake-access-token", "fake-partner-key", "hello", "sign failed"]) {
  assert.equal(diagnosticText.includes(secret), false, `diagnostic leaked ${secret}`);
}
assert.equal(rejected.state, "failed", "Shopee error_sign 403 is a definite rejection");
assert.equal(rejected.code, "shopee_error_sign");
assert.equal(rejected.providerError, "error_sign");
assert.equal(rejected.providerHttpStatus, 403);
assert.equal(rejected.providerRequestId, "shopee-403");
assert.match(sendErrors.describeSendFailure(rejected.code).action, /partner/);
assert.equal(mocks.state.shopeeCalls.length, 1);
const outbound = mocks.state.shopeeCalls[0];
const outboundUrl = new URL(outbound.url);
assert.equal(outboundUrl.pathname, "/api/v2/sellerchat/send_message");
for (const key of ["partner_id", "timestamp", "access_token", "shop_id", "sign"]) assert.ok(outboundUrl.searchParams.get(key), `${key} is signed into URL`);
assert.deepEqual(JSON.parse(outbound.body), { to_id: 47475337, message_type: "text", content: { text: "hello" } });
const replay = await sendShopeeMessage({ conversationId: "conv_bs", requestId: `fake_request_${number}`, input: { type: "text", text: "hello" } });
assert.equal(replay.state, "failed");
assert.equal(replay.providerError, "error_sign");
assert.equal(mocks.state.shopeeCalls.length, 1, "same request does not send again");
assert.equal(diagnostics.find(([label]) => label === "[shopee-send] replay")?.[1]?.state, "failed");
console.info = originalInfo;

const unknown = await send({ status: 491, body: {} });
assert.equal(unknown.state, "unknown", "HTTP failure without explicit Shopee error stays ambiguous");
assert.equal(unknown.providerHttpStatus, 491);

const timeout = await send({ networkError: new Error("provider_timeout") });
assert.equal(timeout.state, "unknown", "network timeout stays ambiguous");

const rejected200 = await send({ status: 200, body: { error: "param_error", request_id: "shopee-200" } });
assert.equal(rejected200.state, "failed");
assert.equal(rejected200.providerError, "param_error");

const rejected491 = await send({ status: 491, body: { error: "param_error", request_id: "shopee-param-491" } });
assert.equal(rejected491.state, "failed", "known rejection is classified from body even with HTTP 491");
assert.equal(rejected491.providerRequestId, "shopee-param-491");

const networkError = await send({ status: 491, body: { error: "error_network", request_id: "shopee-network" } });
assert.equal(networkError.state, "unknown", "Shopee internal network error must not be marked definitely failed");
assert.equal(networkError.providerError, "error_network");

const accepted = await send({ status: 200, body: { error: "", response: { message_id: "msg-123" } } });
assert.equal(accepted.state, "sent");
assert.equal(accepted.providerMessageId, "msg-123");

console.log("Shopee outbound response: 8 cases passed");
