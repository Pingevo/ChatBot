// Node module customization hooks for test-botworker-production-races.ts
//
// ⚡ PRODUCTION-INTEGRATION harness — redirect เฉพาะ leaf dependencies:
//      mongoClient (Mongo), botCallService (HTTP), systemConfigService (config)
//    ทุกอย่างอื่นเป็น production code จริง รวมถึงสี่ module ภายใต้ทดสอบ:
//      workflowEngine / handoffService / botWorkerService / bufferService
//    (ห้ามเพิ่มสี่ตัวนี้ใน TARGETS — test file มี static guard บังคับ)

const MOCK_URL = new URL("./test-botworker-production-races-mocks.mjs", import.meta.url).href;

// resolved URL ที่ต้องถูก redirect — match ด้วย path suffix
const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/botCallService.",
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
