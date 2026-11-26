// Node module hooks for test-shopee-outbound.ts — redirect leaf deps to fakes; shopeeOutboundService runs for real
const MOCK_URL = new URL("./test-shopee-outbound-mocks.mjs", import.meta.url).href;
const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/service/conversationService.",
  "/src/backend/service/productService.",
];

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only" || specifier === "node:https") return { url: MOCK_URL, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((t) => resolved.url.includes(t))) return { url: MOCK_URL, shortCircuit: true };
  return resolved;
}
