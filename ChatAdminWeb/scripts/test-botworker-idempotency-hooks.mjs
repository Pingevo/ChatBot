// Node module customization hooks for test-botworker-idempotency.ts
// Redirect leaf modules ที่แตะ Mongo/env/bot/HTTP ไปยัง mock file เดียว — ไม่ใช้ Mongo จริง
// วิธีใช้: test script เรียก module.register(ไฟล์นี้) ก่อน dynamic import service
//
// mock อยู่ที่ boundary เดิม (module boundary) — ไม่แก้ production

const MOCK_URL = new URL("./test-botworker-idempotency-mocks.mjs", import.meta.url).href;

// resolved URL ที่ต้องถูก redirect — match ด้วย path suffix
const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/lib/config.",
  "/src/backend/service/messageService.",
  "/src/backend/service/conversationService.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/service/triggerService.",
  "/src/backend/service/assignmentService.",
  "/src/backend/service/handoffService.",
  "/src/backend/service/botCallService.",
  "/src/backend/service/botworkerRuntime.", // claim coordinator boundary — impl round
  "/src/backend/service/workflowEngine.",
  "/src/backend/service/botworkerEventService.",
  "/src/backend/service/testStatusConversationService.",
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
