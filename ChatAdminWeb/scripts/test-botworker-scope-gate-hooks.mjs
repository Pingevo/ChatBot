// Node module customization hooks for test-botworker-scope-gate.ts
//
// ⚡ redirect เฉพาะ leaf dependencies:
//      mongoClient (Mongo), botCallService (HTTP), systemConfigService (config)
//      authorize (auth seam — authOk flag)
//    ทุกอย่างอื่นเป็น production code จริง:
//      botWorkerService / bufferService / workflowEngine / shopService /
//      adminLogService / route handlers

const MOCK_URL = new URL("./test-botworker-scope-gate-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/db/mongoClient.",
  "/src/backend/service/botCallService.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/middleware/authorize.",
];

function isTarget(url) {
  return TARGETS.some((t) => url.includes(t));
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  // ⚡ mock module เอง import production code จริงได้ (delegate-to-real seam —
  //    setBotWorkerPlatformEnabled wrapper เรียก implementation จริง)
  if (context.parentURL === MOCK_URL) return resolved;
  if (isTarget(resolved.url)) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
