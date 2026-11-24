import { register } from "node:module";
register(new URL("./test-python-engine-v4-boundaries.mjs", import.meta.url));

const state = { engine: "v4", calls: [] as string[], dispatchCalls: [] as any[] };
(globalThis as any).__PYTHON_ENGINE_V4_TEST = state;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  state.calls.push(url);
  throw new Error(`unexpected Python request: ${url}`);
}) as typeof fetch;

function request(path: string, method = "GET", body?: unknown) {
  const req = new Request(`http://admin.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }) as Request & { nextUrl: URL };
  req.nextUrl = new URL(req.url);
  return req;
}

async function main() {
  const files = await import("../src/app/api/zaapi-kb/files/route");
  const imports = await import("../src/app/api/zaapi-kb/import/route");
  const exportsRoute = await import("../src/app/api/zaapi-kb/export/route");
  const bind = await import("../src/app/api/zaapi-kb/bind/route");
  const importLog = await import("../src/app/api/zaapi-kb/import-log/route");
  const generations = await import("../src/app/api/generations/[...segments]/route");
  const chatbot = await import("../src/app/api/chatbot/[...path]/route");
  const replayBridge = await import("../src/app/api/replay-compare/engine-call/route");

  const responses = await Promise.all([
    files.GET(request("/api/zaapi-kb/files") as any),
    files.POST(request("/api/zaapi-kb/files", "POST") as any),
    imports.POST(request("/api/zaapi-kb/import", "POST") as any),
    exportsRoute.GET(request("/api/zaapi-kb/export") as any),
    bind.GET(request("/api/zaapi-kb/bind") as any),
    bind.POST(request("/api/zaapi-kb/bind", "POST") as any),
    importLog.GET(request("/api/zaapi-kb/import-log") as any),
    generations.GET(request("/api/generations/pending") as any, {
      params: Promise.resolve({ segments: ["pending"] }),
    }),
    generations.POST(request("/api/generations/start", "POST") as any, {
      params: Promise.resolve({ segments: ["start"] }),
    }),
    chatbot.GET(request("/api/chatbot/shopee/admin/generations/pending") as any),
  ]);

  const statuses = await Promise.all(responses.map((response) => response.status));
  const expected = [409, 409, 409, 409, 409, 409, 200, 200, 409, 409];
  if (statuses.some((status, index) => status !== expected[index])) {
    throw new Error(`unexpected v4 statuses: ${statuses.join(", ")}`);
  }
  const importLogBody = await responses[6].json() as { unavailable?: boolean; log?: unknown[] };
  if (!importLogBody.unavailable || importLogBody.log?.length !== 0) {
    throw new Error(`import-log should be marked unavailable: ${JSON.stringify(importLogBody)}`);
  }
  if (state.calls.length !== 0) {
    throw new Error(`v4 boundary made Python requests: ${state.calls.join(", ")}`);
  }

  const compatibilityChat = await chatbot.POST(request("/api/chatbot/shopee/chat", "POST", {
    message: "ถามสินค้า", shop: "Test Shop", conversation_id: "conv-test", simulate_assignment: true,
  }) as any);
  const compatibilityBody = await compatibilityChat.json() as { answer?: string };
  const compatibilityCall = state.dispatchCalls.at(-1);
  if (compatibilityChat.status !== 200 || compatibilityBody.answer !== "bridge answer" ||
      compatibilityCall?.engine !== "v4" || compatibilityCall?.v4Params?.shopName !== "Test Shop" ||
      compatibilityCall?.v4Params?.conversationId !== "conv-test" ||
      compatibilityCall?.v4Params?.testSource !== "test_chat" || state.calls.length !== 0) {
    throw new Error("compatibility chat route must use the shared v4 dispatcher without Python");
  }

  state.engine = "legacy";
  const compatibilityLegacy = await chatbot.POST(request("/api/chatbot/shopee/chat", "POST", {
    message: "ถามสินค้า", shop: "Test Shop",
  }) as any);
  const legacyCall = state.dispatchCalls.at(-1);
  if (compatibilityLegacy.status !== 200 || legacyCall?.engine !== "legacy" ||
      legacyCall?.pythonHeaders?.["X-Admin-Id"] !== "admin-test" || state.calls.length !== 0) {
    throw new Error("compatibility chat route must preserve Python caller headers through shared dispatch");
  }
  state.engine = "v4";
  state.dispatchCalls.length = 0;

  const unauthorized = await replayBridge.POST(new Request("http://admin.test/api/replay-compare/engine-call", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "v4", platform: "shopee", python_payload: {}, v4: {} }),
  }) as any);
  if (unauthorized.status !== 401 || state.dispatchCalls.length !== 0) {
    throw new Error("replay bridge must reject a missing internal secret before dispatch");
  }
  const bridged = await replayBridge.POST(new Request("http://admin.test/api/replay-compare/engine-call", {
    method: "POST",
    headers: { "content-type": "application/json", "x-chatadmin-replay-secret": "test-secret" },
    body: JSON.stringify({ engine: "v4", platform: "shopee", python_payload: {}, v4: { shop_id: "shop-1" } }),
  }) as any);
  const bridgeBody = await bridged.json() as { answer?: string; chat_engine?: string };
  if (bridged.status !== 200 || bridgeBody.chat_engine !== "v4" || bridgeBody.answer !== "bridge answer" ||
      state.dispatchCalls.at(-1)?.engine !== "v4" || state.calls.length !== 0) {
    throw new Error("replay bridge must dispatch v4 centrally without a Python request");
  }

  console.log("PASS v4 Zaapi/generation and Replay bridge avoid Python; unsupported actions return 409");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
