// test-shop-settings.ts — shop-settings writable contract tests (Phase 2B.7)
//
// รัน: npx tsx scripts/test-shop-settings.ts
//
// Production shopSettingsService runs on fake Mongo (same module hooks +
// fakemongo as test-ownership-transport.ts). No real DB / network / .env.
//
// Contract: post_handoff_exceptions was removed from the writable surface —
// the service must not persist it on create or update (existing docs keep it
// as inert legacy data). faq_liveagent_* remains the live contract.

import { register } from "node:module";

register(new URL("./test-ownership-transport-hooks.mjs", import.meta.url));

type Mocks = typeof import("./test-ownership-transport-mocks.mjs");

const results: { name: string; ok: boolean; err?: string }[] = [];
let mocks: Mocks;
let assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`assert: ${msg}`);
};

async function test(name: string, fn: () => Promise<void>) {
  mocks.resetState();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (e: any) {
    results.push({ name, ok: false, err: e?.message || String(e) });
    console.log(`FAIL ${name}\n     ${e?.message || e}`);
  }
}

async function main() {
  mocks = await import("./test-ownership-transport-mocks.mjs");
  const { upsertShopSettings } = await import(
    "../src/backend/service/shopSettingsService"
  );

  await test("create: post_handoff_exceptions arg is never persisted", async () => {
    const doc = await upsertShopSettings({
      shopname: "ShopA",
      platform: "shopee",
      post_handoff_exceptions: ["ทวนข้อมูลเคลม"],
      updatedBy: "admin-1",
    } as any);
    assert(doc, "upsert must return the created doc");
    assert(
      !("post_handoff_exceptions" in doc),
      `created doc must not carry post_handoff_exceptions: ${JSON.stringify(doc)}`
    );
  });

  await test("update: post_handoff_exceptions arg is never persisted", async () => {
    await upsertShopSettings({
      shopname: "ShopB",
      platform: "shopee",
      updatedBy: "admin-1",
    });
    const doc = await upsertShopSettings({
      shopname: "ShopB",
      platform: "shopee",
      faq_liveagent_action: "bot_reply",
      post_handoff_exceptions: ["เปลี่ยนเบอร์"],
      updatedBy: "admin-1",
    } as any);
    assert(doc, "update must return the doc");
    assert(
      !("post_handoff_exceptions" in doc),
      `update must not write post_handoff_exceptions: ${JSON.stringify(doc)}`
    );
    assert(
      doc?.faq_liveagent_action === "bot_reply",
      `live fields must still persist: ${JSON.stringify(doc)}`
    );
  });

  await test("legacy doc keeps inert field; service never rewrites it", async () => {
    const coll = await mocks.getCollection("shop_settings");
    await coll.insertOne({
      settings_id: "settings_legacy1",
      shopname: "ShopC",
      platform: "shopee",
      faq_liveagent_enabled: true,
      faq_liveagent_action: "handoff",
      post_handoff_exceptions: ["ทวนข้อมูล"],
      created_at: new Date(),
      updated_at: new Date(),
    });
    const doc = await upsertShopSettings({
      shopname: "ShopC",
      platform: "shopee",
      notes: "touched",
      updatedBy: "admin-1",
    });
    assert(doc?.notes === "touched", "live field update must persist");
    const stored = await coll.findOne({ settings_id: "settings_legacy1" });
    assert(
      JSON.stringify(stored?.post_handoff_exceptions) ===
        JSON.stringify(["ทวนข้อมูล"]),
      "legacy field stays inert historical data — never rewritten/deleted"
    );
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main();
