const MOCK_URL = new URL("./test-test-chat-session-db.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("/backend/db/mongoClient.")) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}

