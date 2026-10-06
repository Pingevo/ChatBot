// Node module customization hooks for test-botworker-boundary.ts
//
// ⚡ redirect เฉพาะ leaf/UI dependencies:
//      mongoClient (Mongo), botCallService (HTTP), systemConfigService (config)
//      authorize (session/JWT — route tests ไม่ต้องการ auth จริง)
//      productService (dbWallet read — test ใช้ spy)
//      react (เฉพาะตอน import จาก usePolling.ts — hook overlap test)
//    ทุกอย่างอื่นเป็น production code จริง:
//      messageService / botWorkerService / workflowEngine / route handlers

const MOCK_URL = new URL("./test-botworker-boundary-mocks.mjs", import.meta.url).href;

// resolved URL ที่ต้องถูก redirect — match ด้วย path suffix
const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/botCallService.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/middleware/authorize.",
  "/src/backend/service/productService.",
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
