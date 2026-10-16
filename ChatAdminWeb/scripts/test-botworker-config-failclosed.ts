// test-botworker-config-failclosed.ts — BW-5 config-owner contract on the REAL
// production systemConfigService (leaf-mocked mongoClient only)
//
// รัน: npx tsx scripts/test-botworker-config-failclosed.ts
//
// ⚡ module-cache honesty — ไม่มี exported cache invalidator; case order กำหนด
//   cache state จริง: cold-start รันก่อน healthy read เสมอ (cachedConfig ว่างจริง),
//   warm-cache failure รันหลัง healthy read เติม cache แล้ว
//
// Contract under test:
//   healthy DB read   → ค่าจริงจาก DB
//   read failure      → enable switches fail-closed (false), concurrency =
//                       last-validated (warm) หรือ fail-closed 1 (cold start)
//   recovery          → ค่าจริงกลับมา

import { register } from "node:module";

// ⚡ register ก่อน import service — static imports ของไฟล์นี้มีแค่ builtins
register(new URL("./test-botworker-config-failclosed-hooks.mjs", import.meta.url));

// strict env ของ lib/config ผูกตอน module eval — test-local constants (ไม่มี .env)
process.env.ADMIN_JWT_SECRET = "verify-only-jwt-nonsecret";
process.env.CHATBOT_INTERNAL_SECRET = "verify-only-internal-nonsecret";
process.env.CHATBOT_BASE_URL_SHOPEE = "http://verify-only-chatbot.invalid";

// ⚡ Finding A — จำลอง production env ที่เปิด switches ไว้ (admin เซ็ต env=true)
//   getSafeDefaults อ่าน env ตอน call → cold-start catch ต้อง fail-closed
//   ทุก switch แม้ env=true (DB outage = authoritative config หาย)
process.env.MOCK_MODE_ENABLED = "true";
process.env.SHADOW_BOT_ENABLED = "true";
process.env.BOT_WORKER_ENABLED = "true";
process.env.BOT_BUFFER_ENABLED = "true";
process.env.WORKFLOW_ENABLED = "true";
process.env.USE_GROUPED_RETRIEVAL_SHADOW = "true";
process.env.USE_GROUPED_RETRIEVAL_SELECTION = "true";

type Mocks = typeof import("./test-botworker-config-failclosed-mocks.mjs");
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

// ⚡ operational enable switches — ต้อง fail-closed เมื่อ DB read ล้ม
//   (stale-true = worker/workflow/shadow ยังทำงานกลาง outage = side effect จริง)
const FAIL_SWITCHES = [
  "mock_mode_enabled",
  "shadow_bot_enabled",
  "bot_worker_enabled",
  "bot_buffer_enabled",
  "workflow_enabled",
  "grouped_retrieval_shadow_enabled",
  "grouped_retrieval_selection_enabled",
] as const;

async function main() {
  mocks = await import("./test-botworker-config-failclosed-mocks.mjs");
  cfg = await import("../src/backend/service/systemConfigService");

  // ⚡ F1 รันแรกสุด — cachedConfig ยังว่างจริง = cold start จริง
  await test("F1 cold-start DB outage → worker=false + concurrency=1 (fail-closed)", async () => {
    mocks.state.findOneHook = (coll: string) => {
      if (coll === "system_configs") throw new Error("injected DB outage");
    };
    const c = await cfg.getSystemConfig(true);
    assert(c.bot_concurrency_limit === 1,
      `limit=${c.bot_concurrency_limit} — cold-start outage must not admit fallback-50`);
    for (const k of FAIL_SWITCHES) {
      assert((c as any)[k] === false,
        `${k}=${(c as any)[k]} — enable switches must fail closed on cold-start outage`);
    }
  });

  await test("F2 healthy DB read → real config fields pass through", async () => {
    mocks.state.findOneHook = null;
    mocks.fakeColl("system_configs").push({
      config_key: "main_config",
      bot_worker_enabled: true,
      bot_buffer_enabled: true,
      workflow_enabled: true,
      shadow_bot_enabled: true,
      grouped_retrieval_selection_enabled: true,
      bot_concurrency_limit: 7,
      workflow_run_timeout_ms: 42000,
      llm_context_limit: 21,
      updated_by: "t",
      updated_at: new Date(),
    });
    const c = await cfg.getSystemConfig(true);
    assert(c.bot_worker_enabled === true && c.bot_concurrency_limit === 7
      && c.workflow_enabled === true && c.shadow_bot_enabled === true,
      `healthy read must return DB values — worker=${c.bot_worker_enabled} limit=${c.bot_concurrency_limit}`);
    assert(c.llm_context_limit === 21 && c.workflow_run_timeout_ms === 42000,
      "non-switch fields must pass through from DB");
    // ⚡ pin healthy env-fallback — switch ที่ DB ไม่ได้เซ็ตยังอ่าน env ตามเดิม
    //   (fix ต้อง fail-closed เฉพาะ failure path ไม่ใช่เปลี่ยน healthy semantics)
    assert(c.mock_mode_enabled === true,
      `healthy: mock_mode_enabled=${c.mock_mode_enabled} — env fallback must apply when DB field absent`);
  });

  await test("F3 warm-cache outage → switches fail closed, concurrency keeps last-validated", async () => {
    // ⚡ warm cache จาก F2 (worker=true, limit=7) → DB outage
    mocks.state.findOneHook = (coll: string) => {
      if (coll === "system_configs") throw new Error("injected DB outage");
    };
    const c = await cfg.getSystemConfig(true);
    assert(c.bot_concurrency_limit === 7,
      `limit=${c.bot_concurrency_limit} — last-validated value may persist on failure`);
    for (const k of FAIL_SWITCHES) {
      assert((c as any)[k] === false,
        `${k}=${(c as any)[k]} — stale-true operational switch during outage (worker kept running)`);
    }
  });

  await test("F4 outage recovery → healthy values restored", async () => {
    mocks.state.findOneHook = null;
    const c = await cfg.getSystemConfig(true);
    assert(c.bot_worker_enabled === true && c.bot_concurrency_limit === 7
      && c.workflow_enabled === true,
      `recovery must restore DB values — worker=${c.bot_worker_enabled} limit=${c.bot_concurrency_limit}`);
  });

  // ═══ F5–F8 — setBotWorkerPlatformEnabled CAS owner contract (production fn, fake mongo) ═══
  //   expected=false CAS miss + upsert → insert ชน unique config_key → E11000
  //   ต้องถูก map เป็น applied:false (route→409) — ห้าม throw 500 ออกไป
  //   enabled===expected → zero-write probe; persisted≠expected → applied:false
  //   (คำขอ idempotent ที่ expectation ตายแล้ว ไม่ใช่ "applied ลอยๆ")

  await test("F5 enable race loser (expected=false, persisted=true) → applied:false — E11000 must not escape", async () => {
    mocks.fakeColl("system_configs").length = 0;
    mocks.fakeColl("system_configs").push({
      config_key: "main_config", bot_worker_platforms: { shopee: true },
      bot_worker_platform_enabled_at: { shopee: new Date(Date.now() - 60_000) },
    });
    const res = await cfg.setBotWorkerPlatformEnabled("shopee", true, false);
    assert(res.applied === false && res.current === true,
      `loser must get applied:false current:true, got ${JSON.stringify(res)}`);
  });

  await test("F6 idempotent intent on stale expectation (true, expected=true, persisted=false) → applied:false", async () => {
    mocks.fakeColl("system_configs").length = 0;
    mocks.fakeColl("system_configs").push({
      config_key: "main_config", bot_worker_platforms: { shopee: false },
    });
    const res = await cfg.setBotWorkerPlatformEnabled("shopee", true, true);
    assert(res.applied === false && res.current === false,
      `stale expectation must be applied:false, got ${JSON.stringify(res)}`);
  });

  await test("F7 enable on missing doc (expected=false) → upsert applies + stamps edge", async () => {
    mocks.fakeColl("system_configs").length = 0; // no main_config doc at all
    const res = await cfg.setBotWorkerPlatformEnabled("shopee", true, false);
    assert(res.applied === true && res.changed === true,
      `missing-doc enable must apply via upsert: ${JSON.stringify(res)}`);
    const doc = mocks.fakeColl("system_configs").find((d: any) => d.config_key === "main_config")!;
    assert(doc.bot_worker_platforms?.shopee === true, "flag must persist");
    assert(doc.bot_worker_platform_enabled_at?.shopee instanceof Date, "edge must stamp in the same write");
  });

  await test("F8 idempotent re-enable (expected=true, persisted=true) → applied no-change, edge preserved", async () => {
    mocks.fakeColl("system_configs").length = 0;
    const t0 = new Date(Date.now() - 60_000);
    mocks.fakeColl("system_configs").push({
      config_key: "main_config", bot_worker_platforms: { shopee: true },
      bot_worker_platform_enabled_at: { shopee: t0 },
    });
    const res = await cfg.setBotWorkerPlatformEnabled("shopee", true, true);
    assert(res.applied === true && res.changed === false,
      `idempotent re-enable must be applied unchanged: ${JSON.stringify(res)}`);
    const doc = mocks.fakeColl("system_configs").find((d: any) => d.config_key === "main_config")!;
    assert(doc.bot_worker_platform_enabled_at?.shopee?.getTime() === t0.getTime(),
      "enable edge must not move on no-op");
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
