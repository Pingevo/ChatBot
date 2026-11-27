const MOCK_URL = new URL("./test-admin-conversation-order-search-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/db/orderMongoClient.",
  "/src/backend/service/testStatusConversationService.",
  "/src/backend/service/statusConversationService.",
  "/src/backend/service/botworkerConversationCache.",
  "/src/backend/lib/inboxFilters.",
  "/src/backend/middleware/authorize.",
  "/src/backend/lib/http.",
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((target) => resolved.url.includes(target))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
