// Node module customization hooks for test-ownership-transport.ts
//
// ⚡ redirect เฉพาะ leaf dependencies:
//      mongoClient (Mongo), systemConfigService (config)
//    ทุกอย่างอื่น production code จริง — รวมถึง route handlers / auth / jwt

const MOCK_URL = new URL("./test-ownership-transport-mocks.mjs", import.meta.url).href;
const SVC_SPY_URL = new URL("./test-ownership-transport-inbound-svc-spy.mjs", import.meta.url).href;

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
  // ⚡ importer-aware leaf seam: เฉพาะ route ใต้ /src/app/api/internal/ ที่
  //    import statusConversationService → service spy (record calls)
  //    ไฟล์อื่น (test file, real services) ยังได้ real module → command missing = RED
  if (
    resolved.url.includes("/src/backend/service/statusConversationService.") &&
    context.parentURL && context.parentURL.includes("/src/app/api/internal/")
  ) {
    return { url: SVC_SPY_URL, shortCircuit: true };
  }
  return resolved;
}
