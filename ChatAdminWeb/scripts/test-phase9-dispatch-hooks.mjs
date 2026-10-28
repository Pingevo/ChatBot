// Node module customization hooks for test-phase9-dispatch.ts
//
// ⚡ redirect เฉพาะ leaf dependencies:
//      mongoClient (Mongo), systemConfigService (config)
//    botCallService ตั้งใจไม่ redirect — real callBot + real limiter
//    ผ่าน stubbed fetch (นับ invocation + canned response)
//
//    ทุกอย่างอื่น production code จริง:
//      botWorkerService / workflowEngine / triggerService / messageService / botCallService

const MOCK_URL = new URL("./test-phase9-dispatch-mocks.mjs", import.meta.url).href;

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
