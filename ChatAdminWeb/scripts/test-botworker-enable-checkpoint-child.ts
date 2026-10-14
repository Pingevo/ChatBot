// Child entry — register mock hooks แล้วรัน bot-worker.ts จริงใน process นี้
// (spawn โดย test-botworker-enable-checkpoint.ts เท่านั้น — ห้ามรันตรง)
import { register } from "node:module";

async function main() {
  register(new URL("./test-botworker-enable-checkpoint-hooks.mjs", import.meta.url));
  await import("./bot-worker");
}

main().catch((e) => { console.error(e); process.exit(1); });
