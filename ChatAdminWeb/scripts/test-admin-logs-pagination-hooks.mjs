// Node module customization hooks for test-admin-logs-pagination.ts
// Redirect leaf modules ที่แตะ Mongo/auth ไปยัง mock file เดียว — ไม่ใช้ Mongo/SSO จริง
// วิธีใช้: test script เรียก module.register(ไฟล์นี้) ก่อน dynamic import service/route

const MOCK_URL = new URL("./test-admin-logs-pagination-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/middleware/authorize.",
  "/src/backend/lib/http.",
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((t) => resolved.url.includes(t))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
