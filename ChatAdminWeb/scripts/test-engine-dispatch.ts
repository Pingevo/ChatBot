process.env.ADMIN_JWT_SECRET = "test-only-secret";
process.env.CHATBOT_INTERNAL_SECRET = "test-only-internal";
process.env.CHATBLACKSHARK_ENGINE_URL = "http://chatblackshark.test";
process.env.CHATBLACKSHARK_TOKEN_ISSUER_SECRET = "test-issuer-secret-012345678901234567890";
process.env.CHATBOT_BASE_URL_SHOPEE = "http://127.0.0.1:8010";

async function main() {
  const { dispatchChatEngine } = await import("../src/backend/service/botCallService");
  const calls: { url: string; body?: Record<string, unknown>; headers: Headers }[] = [];
  const pythonResponses: Response[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    if (url.endsWith("/api/engine/token")) {
      return Response.json({ access_token: "test-access", expires_in: 600 });
    }
    if (url.endsWith("/api/engine/test-answer")) {
      return Response.json({ answer: "v4 answer", products: [] });
    }
    if (url.endsWith("/chat")) {
      if (pythonResponses.length) return pythonResponses.shift()!;
      return Response.json({ answer: "python answer" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const base = {
    platform: "shopee" as const,
    pythonPayload: { message: "question", limit: 7 },
    v4Params: {
      platform: "shopee" as const,
      message: "question",
      shopId: "shop-1",
      shopName: "Shop One",
      history: [],
      simulate: true,
      includePersona: false,
    },
  };

  for (const engine of ["legacy", "v2", "v3"] as const) {
    const before = calls.length;
    await dispatchChatEngine({
      ...base,
      engine,
      ...(engine === "legacy" ? { pythonHeaders: { "X-Admin-Id": "admin-test" } } : {}),
    });
    const call = calls.slice(before).find((entry) => entry.url.endsWith("/chat"));
    if (!call || call.url !== "http://127.0.0.1:8010/chat") throw new Error(`${engine} did not use Python port 8010`);
    if (call.body?.use_v2 !== (engine === "v2") || call.body?.use_v3 !== (engine === "v3")) {
      throw new Error(`${engine} flags were not explicit: ${JSON.stringify(call.body)}`);
    }
    if (engine === "legacy" && call.headers.get("X-Admin-Id") !== "admin-test") {
      throw new Error("shared dispatcher did not preserve caller-provided Python admin headers");
    }
  }

  pythonResponses.push(
    Response.json({ detail: "temporary failure" }, { status: 503 }),
    Response.json({ answer: "retried answer" }),
  );
  const beforeRetry = calls.length;
  const retried = await dispatchChatEngine({ ...base, engine: "legacy", maxNon429Retries: 1, non429RetryWaitMs: 0 });
  const retryCalls = calls.slice(beforeRetry).filter((entry) => entry.url.endsWith("/chat"));
  if (retryCalls.length !== 2 || retried.data.answer !== "retried answer") {
    throw new Error(`configured non-429 retry changed: calls=${retryCalls.length}, answer=${retried.data.answer}`);
  }

  const beforeV4 = calls.length;
  const v4 = await dispatchChatEngine({ ...base, engine: "v4" });
  const v4Calls = calls.slice(beforeV4);
  if (v4.chat_engine !== "v4" || v4.data.answer !== "v4 answer") throw new Error("v4 response did not come from ChatBlackshark");
  if (v4Calls.some((entry) => entry.url.includes(":8010"))) throw new Error("v4 attempted a Python bot request");
  if (!v4Calls.some((entry) => entry.url.endsWith("/api/engine/test-answer"))) throw new Error("v4 did not use ChatBlackshark");

  console.log("PASS shared answer dispatcher routes legacy/v2/v3 to Python and v4 to ChatBlackshark only");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
