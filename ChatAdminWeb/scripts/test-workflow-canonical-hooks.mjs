// test-workflow-canonical-hooks.mjs — module.register hooks สำหรับ canonical eval tests
// Redirect leaf modules ที่แตะ Mongo/env ไปยัง mocks — convention เดียวกับ persistence-hooks

const MOCK_URL = new URL("./test-workflow-canonical-mocks.mjs", import.meta.url).href;
const TARGETS = ["/src/backend/db/mongoClient.", "/src/backend/lib/config.", "/src/backend/service/adminLogService."];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((t) => resolved.url.includes(t))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
