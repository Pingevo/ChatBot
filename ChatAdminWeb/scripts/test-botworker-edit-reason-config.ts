import { register } from "node:module";
register(new URL("./test-botworker-config-failclosed-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-botworker-config-failclosed-mocks.mjs");
type Config = typeof import("../src/backend/service/systemConfigService");

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const mocks: Mocks = await import("./test-botworker-config-failclosed-mocks.mjs");
  const config: Config = await import("../src/backend/service/systemConfigService");

  const initial = await config.getBotWorkerEditReasonCategories();
  assert(initial.includes("สเปคผิด") && initial.includes("ตอบไม่ได้"), "default edit reasons missing");

  const added = await config.addBotWorkerEditReasonCategory("  หัวข้อที่แอดมินเพิ่ม  ", "admin_1");
  assert(added.ok, "valid custom category was rejected");
  assert(added.categories.includes("หัวข้อที่แอดมินเพิ่ม"), "trimmed category missing from result");

  const stored = mocks.fakeColl("system_configs")[0];
  assert(stored?.botworker_edit_reason_categories?.includes("หัวข้อที่แอดมินเพิ่ม"), "category not persisted in shared system config");
  assert(stored?.updated_by === "admin_1", "category creator not recorded on config update");

  const duplicate = await config.addBotWorkerEditReasonCategory("หัวข้อที่แอดมินเพิ่ม", "admin_2");
  assert(duplicate.ok, "duplicate category should be idempotent");
  assert(duplicate.categories.filter((category) => category === "หัวข้อที่แอดมินเพิ่ม").length === 1, "duplicate category returned more than once");

  const blank = await config.addBotWorkerEditReasonCategory("   ", "admin_1");
  assert(!blank.ok, "blank category accepted");
  const tooLong = await config.addBotWorkerEditReasonCategory("ก".repeat(61), "admin_1");
  assert(!tooLong.ok, "category longer than 60 characters accepted");

  console.log("PASS shared BotWorker edit-reason category storage behavior");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
