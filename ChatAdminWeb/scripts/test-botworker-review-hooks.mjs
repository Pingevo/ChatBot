// Node module hooks for test-botworker-review.ts
// redirect leaf deps เท่านั้น — production modules รันจริงบน fake mongo
const MOCK_URL = new URL("./test-botworker-review-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/botCallService.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/middleware/authorize.",
  "/src/backend/service/productService.",
  "/src/backend/service/mockSendService.", // mock transport seam — failure injection
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((t) => resolved.url.includes(t))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
