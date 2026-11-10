// Node module customization hooks for test-botworker-global-enabled-cas.ts
// ⚡ redirect เฉพาะ mongoClient (leaf) — systemConfigService = PRODUCTION REAL

const MOCK_URL = new URL("./test-botworker-global-enabled-cas-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/db/mongoClient.",
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((t) => resolved.url.includes(t))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
