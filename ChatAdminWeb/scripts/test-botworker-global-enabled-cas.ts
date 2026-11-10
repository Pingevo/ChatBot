// test-botworker-global-enabled-cas.ts — CAS contract ของ
// setBotWorkerGlobalEnabled + whitelist gate ของ bot_worker_enabled
// บน production systemConfigService จริง (leaf-mocked mongoClient เท่านั้น)
//
// รัน: npx tsx scripts/test-botworker-global-enabled-cas.ts
//
// Contract under test (global enable edge — เหมือน platform writer):
//   OFF→ON    → flag=true + stamp bot_worker_enabled_at ใน write เดียว
//   ON→OFF    → flag=false + edge=null
//   true→true / false→false → idempotent no-op (zero write, edge ไม่ขยับ)
//   stale expected → applied:false + current จริง (zero write)
//   updateSystemConfig({bot_worker_enabled}) → key ถูก drop (whitelist)
//   getSystemConfig carry bot_worker_enabled_at ออกไป

import { register } from "node:module";
register(new URL("./test-botworker-global-enabled-cas-hooks.mjs", import.meta.url));

// strict env ของ lib/config ผูกตอน module eval — test-local constants (ไม่มี .env)
process.env.ADMIN_JWT_SECRET = "verify-only-jwt-nonsecret";
process.env.CHATBOT_INTERNAL_SECRET = "verify-only-internal-nonsecret";
process.env.CHATBOT_BASE_URL_SHOPEE = "http://verify-only-chatbot.invalid";

type Mocks = typeof import("./test-botworker-global-enabled-cas-mocks.mjs");
type Cfg = typeof import("../src/backend/service/systemConfigService");

let mocks: Mocks;
let cfg: Cfg;

const results: { name: string; ok: boolean; err?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  }
}

function assert(cond: boolean, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

function cfgDoc(): any {
  return (mocks.fakeColl("system_configs") as any[])
    .find((d) => d.config_key === "main_config");
}

const writes = () =>
  mocks.state.queryLog.filter((q: any) => q.coll === "system_configs" && q.op === "updateOne");

async function main() {
  mocks = await import("./test-botworker-global-enabled-cas-mocks.mjs");
  cfg = await import("../src/backend/service/systemConfigService");

  await test("G1 OFF→ON (doc missing) → upsert flag=true + edge stamped + changed", async () => {
    mocks.resetState();
    const res = await cfg.setBotWorkerGlobalEnabled(true, false, "tester");
    assert(res.applied === true && res.changed === true, `must apply: ${JSON.stringify(res)}`);
    const doc = cfgDoc();
    assert(doc?.bot_worker_enabled === true, `flag must be true: ${JSON.stringify(doc)}`);
    assert(doc?.bot_worker_enabled_at instanceof Date,
      `edge must be stamped Date: ${JSON.stringify(doc?.bot_worker_enabled_at)}`);
    assert(doc?.updated_by === "tester", "updated_by must be recorded");
  });

  await test("G2 ON→ON expected=true → idempotent no-op (zero write, edge ไม่ขยับ)", async () => {
    const edge = cfgDoc()!.bot_worker_enabled_at;
    mocks.state.queryLog.length = 0;
    const res = await cfg.setBotWorkerGlobalEnabled(true, true, "tester");
    assert(res.applied === true && res.changed === false, `must no-op: ${JSON.stringify(res)}`);
    assert(writes().length === 0, `must be zero write: ${JSON.stringify(writes())}`);
    assert(cfgDoc()!.bot_worker_enabled_at === edge, "edge must not move");
  });

  await test("G3 stale expected=false while persisted=true → applied:false + current:true + flag ไม่เปลี่ยน", async () => {
    const res = await cfg.setBotWorkerGlobalEnabled(true, false, "tester");
    assert(res.applied === false && res.current === true,
      `must report stale: ${JSON.stringify(res)}`);
    assert(cfgDoc()!.bot_worker_enabled === true, "persisted flag must stay true");
    assert(cfgDoc()!.bot_worker_enabled_at instanceof Date, "edge must stay stamped");
  });

  await test("G4 ON→OFF expected=true → flag=false + edge cleared null", async () => {
    const res = await cfg.setBotWorkerGlobalEnabled(false, true, "tester");
    assert(res.applied === true && res.changed === true, `must apply: ${JSON.stringify(res)}`);
    const doc = cfgDoc()!;
    assert(doc.bot_worker_enabled === false, "flag must be false");
    assert(doc.bot_worker_enabled_at === null,
      `edge must clear: ${JSON.stringify(doc.bot_worker_enabled_at)}`);
  });

  await test("G5 OFF→OFF expected=false → idempotent no-op (zero write)", async () => {
    mocks.state.queryLog.length = 0;
    const res = await cfg.setBotWorkerGlobalEnabled(false, false, "tester");
    assert(res.applied === true && res.changed === false, `must no-op: ${JSON.stringify(res)}`);
    assert(writes().length === 0, "must be zero write");
  });

  await test("G6 updateSystemConfig({bot_worker_enabled:true}) → key dropped, flag stays false", async () => {
    const updated = await cfg.updateSystemConfig(
      { bot_worker_enabled: true } as never, "tester");
    const doc = cfgDoc()!;
    assert(doc.bot_worker_enabled === false,
      `whitelist must drop the key: ${JSON.stringify(doc.bot_worker_enabled)}`);
    assert(updated.bot_worker_enabled === false, "returned config must stay OFF");
  });

  await test("G7 getSystemConfig carries bot_worker_enabled_at edge out", async () => {
    mocks.resetState();
    (mocks.fakeColl("system_configs") as any[]).push({
      config_key: "main_config",
      bot_worker_enabled: true,
      bot_worker_enabled_at: new Date("2026-11-10T05:00:00Z"),
    });
    const c = await cfg.getSystemConfig(true);
    assert(c.bot_worker_enabled === true, "flag must read true");
    assert(c.bot_worker_enabled_at instanceof Date,
      `edge must carry out: ${JSON.stringify(c.bot_worker_enabled_at)}`);
  });

  await test("G8 persisted flag + missing edge → resolver sees flag ON แต่ edge null (fail-closed path intact)", async () => {
    mocks.resetState();
    (mocks.fakeColl("system_configs") as any[]).push({
      config_key: "main_config",
      bot_worker_enabled: true,
      // ไม่มี bot_worker_enabled_at — สถานะเดียวกับ bug ที่เจอใน prod
    });
    const c = await cfg.getSystemConfig(true);
    assert(c.bot_worker_enabled === true, "flag reads true");
    assert(c.bot_worker_enabled_at == null,
      "edge must be null — resolveBotworkerScope fail-closed ที่ชั้นนี้");
  });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});
