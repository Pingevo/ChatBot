// Node module customization hooks for test-shadow-batch-isolation.ts
// Redirect leaf modules ที่แตะ Mongo/env ไปยัง mock file เดียว — ไม่ใช้ Mongo จริง
// วิธีใช้: test script เรียก module.register(ไฟล์นี้) ก่อน dynamic import service/route
//
// mock อยู่ที่ boundary เดิม (module boundary) — ไม่แก้ production

const MOCK_URL = new URL("./test-shadow-batch-isolation-mocks.mjs", import.meta.url).href;

// resolved URL ที่ต้องถูก redirect — match ด้วย path suffix (ครอบคลุมทั้ง relative
// imports ของ service และ "@/backend/..." alias ของ route เพราะ resolved URL เหมือนกัน)
const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/messageService.",
  "/src/backend/service/conversationService.",
  "/src/backend/service/adminLogService.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/middleware/authorize.",
  "/src/backend/lib/config.",
  "/src/backend/lib/http.",
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
