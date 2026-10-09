// Node module customization hooks for test-botworker-config-failclosed.ts
//
// ⚡ redirect เฉพาะ mongoClient (leaf) — systemConfigService = PRODUCTION REAL
//    suite นี้พิสูจน์ config-owner contract จริง (ไม่ใช่ mock ที่ implement
//    desired behavior เอง)

const MOCK_URL = new URL("./test-botworker-config-failclosed-mocks.mjs", import.meta.url).href;

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
