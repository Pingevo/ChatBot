const MOCK_URL = new URL("./test-python-engine-v4-boundaries-mocks.mjs", import.meta.url).href;
const TARGETS = [
  "/src/backend/middleware/authorize.",
  "/src/backend/lib/http.",
  "/src/backend/lib/config.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/service/botCallService.",
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((target) => resolved.url.includes(target))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
