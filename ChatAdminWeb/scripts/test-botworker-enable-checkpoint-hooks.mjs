// Node module customization hooks for test-botworker-enable-checkpoint.ts
//
// ⚡ redirect เฉพาะ leaf dependencies ของ scripts/bot-worker.ts:
//      dotenv/config (env load — test ไม่อ่าน .env), systemConfigService (scripted),
//      botWorkerService (poll spy — บันทึก since boundary), workflowEngine (no-op)

const MOCK_URL = new URL("./test-botworker-enable-checkpoint-mocks.mjs", import.meta.url).href;

const TARGETS = [
  "/src/backend/service/botWorkerService.",
  "/src/backend/service/systemConfigService.",
  "/src/backend/service/workflowEngine.",
];

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "dotenv/config") {
    return { url: MOCK_URL, shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (TARGETS.some((t) => resolved.url.includes(t))) {
    return { url: MOCK_URL, shortCircuit: true };
  }
  return resolved;
}
