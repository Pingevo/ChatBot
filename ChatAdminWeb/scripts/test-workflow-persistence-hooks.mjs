// test-workflow-persistence-hooks.mjs — module.register hooks สำหรับ workflow persistence tests
// Redirect leaf modules ที่แตะ Mongo/env ไปยัง mocks — convention เดียวกับ test-botworker-*-hooks.mjs

const MOCK_URL = new URL("./test-workflow-persistence-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/adminLogService.",
];

function isTarget(url) {
  return TARGETS.some((t) => url.includes(t));
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (isTarget(resolved.url)) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
