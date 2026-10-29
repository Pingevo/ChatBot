// test-workflow-binding-routes-hooks.mjs — module.register hooks สำหรับ bindings-route tests
// Redirect authorize + workflowService + mongoClient ไปยัง mocks —
// service stub จับ delegation args · mongoClient throw = zero-Mongo proof

const MOCK_URL = new URL("./test-workflow-binding-routes-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/middleware/authorize.",
  "/src/backend/service/workflowService.",
  "/src/backend/db/mongoClient.",
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
