// Node module customization hooks for test-botworker-error-policy.ts
//
// ⚡ redirect เฉพาะ leaf dependencies:
//      mongoClient (Mongo), systemConfigService (config)
//    botCallService ตั้งใจไม่ redirect — ทดสอบ real HTTP mapping
//    (429/500/timeout/network → bot_failed) ผ่าน stubbed fetch
//    และ real limiter ที่ outbound boundary
//
//    ทุกอย่างอื่น production code จริง:
//      botWorkerService / workflowEngine / messageService / botCallService

const MOCK_URL = new URL("./test-botworker-error-policy-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/systemConfigService.",
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
