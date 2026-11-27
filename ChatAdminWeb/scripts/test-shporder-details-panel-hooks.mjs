const MOCK_URL = new URL("./test-shporder-details-panel-mocks.mjs", import.meta.url).href;
const TARGETS = [
  "/src/backend/db/orderMongoClient.",
  "/src/backend/middleware/authorize.",
  "/src/backend/lib/http.",
  "/src/backend/service/conversationService.",
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((target) => resolved.url.includes(target))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
