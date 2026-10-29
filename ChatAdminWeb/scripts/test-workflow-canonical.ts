// Executable tests — canonical (Zaapi-import) node evaluators
// ครอบ: schedule eval (business_hours/event_time ร่วม), customer_waiting_time,
//   last_interaction, assignee (binding resolution), conditions[] dispatch +
//   condition-index-N / no-match branches, fail-closed เมื่อ config/binding ขาด
// Run: npx tsx scripts/test-workflow-canonical.ts

import { register } from "node:module";
register(new URL("./test-workflow-canonical-hooks.mjs", import.meta.url));

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}
function eq<T>(a: T, b: T, name: string) { ok(a === b, `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`); }

async function main() {
  const mocks = await import("./test-workflow-canonical-mocks.mjs");
  const { mongo, COLLECTIONS } = mocks;
  const ce = await import("../src/backend/service/workflowCanonicalEval");

  const node = (subtype: string, config: Record<string, unknown>, id = "zn_t") =>
    ({ node_id: id, type: "condition", subtype, config, position: { x: 0, y: 0 } }) as never;
  const msg = (over: Record<string, unknown> = {}) =>
    ({ conversation_id: "cv_1", shop_id: "s1", platform: "shopee", ...over }) as never;

  // ─── 1. schedule eval (pure) ────────────────────────────
  {
    const sched = { MON: [{ start: 540, end: 1080 }] }; // Mon 09:00-18:00
    // 2026-10-26 = Monday; 10:00 Asia/Bangkok = 03:00 UTC
    const inTz = new Date("2026-10-26T03:00:00Z");
    eq(ce.isWithinSchedule(inTz, sched, "Asia/Bangkok"), true, "schedule Mon 10:00 BKK → within");
    const out = new Date("2026-10-26T12:00:00Z"); // 19:00 BKK
    eq(ce.isWithinSchedule(out, sched, "Asia/Bangkok"), false, "schedule Mon 19:00 BKK → outside");
    const edge = new Date("2026-10-26T11:00:00Z"); // 18:00 BKK — end exclusive
    eq(ce.isWithinSchedule(edge, sched, "Asia/Bangkok"), false, "schedule end boundary exclusive (18:00 → outside)");
    const sun = new Date("2026-10-25T03:00:00Z"); // Sunday 10:00 BKK
    eq(ce.isWithinSchedule(sun, sched, "Asia/Bangkok"), false, "schedule ไม่มีวัน → outside");
    eq(ce.isWithinSchedule(new Date("2026-10-26T01:59:00Z"), sched, "Asia/Bangkok"), false,
      "schedule ก่อน start 1 นาที → outside (start 540 = 09:00)");
  }

  // ─── 2. hasCanonicalConditions guard ────────────────────
  eq(ce.hasCanonicalConditions({ conditions: [] }), true, "guard: conditions array → canonical");
  eq(ce.hasCanonicalConditions({ mode: "contains", text: "x" }), false, "guard: legacy config → ไม่ canonical");

  // ─── 3. business_hours — per-shop config ────────────────
  {
    const shops = await mongo.getCollection(COLLECTIONS.shops);
    await shops.insertOne({
      shop_id: "s1", shopname: "shop1", platform: "shopee",
      business_hours: { timezone: "Asia/Bangkok", schedule: { MON: [{ start: 540, end: 1080 }], TUE: [{ start: 540, end: 1080 }], WED: [{ start: 540, end: 1080 }], THU: [{ start: 540, end: 1080 }], FRI: [{ start: 540, end: 1080 }] } },
    });
    const bhNode = node("business_hours", { label: "ใน/นอกเวลา",
      conditions: [{ operator: "within_office_hours" }, { operator: "outside_office_hours" }] });
    const r1 = await ce.evalCanonicalConditions(bhNode, msg(), "wf_x", undefined, new Date("2026-10-26T03:00:00Z"));
    eq(r1.branch, "condition-index-0", "business_hours ในเวลา → condition-index-0");
    const r2 = await ce.evalCanonicalConditions(bhNode, msg(), "wf_x", undefined, new Date("2026-10-26T12:00:00Z"));
    eq(r2.branch, "condition-index-1", "business_hours นอกเวลา → condition-index-1");
    const r3 = await ce.evalCanonicalConditions(bhNode, msg(), "wf_x", undefined, new Date("2026-10-25T03:00:00Z"));
    eq(r3.branch, "condition-index-1", "business_hours วันหยุด → outside");
    // missing config → throw (evalCondition catch → fail-closed error)
    let threw = false;
    try { await ce.evalCanonicalConditions(bhNode, msg({ shop_id: "s_nocfg" }), "wf_x", undefined); }
    catch { threw = true; }
    ok(threw, "business_hours ไม่มี shop config → error (fail-closed)");
  }

  // ─── 4. event_time — schedule ใน node เอง ───────────────
  {
    const et = node("event_time", {
      schedule: { MON: [{ start: 1050, end: 1440 }] }, // Mon 17:30-24:00
      eventTimeZone: "Asia/Singapore",
      conditions: [{ operator: "within_time_range" }, { operator: "outside_time_range" }],
    });
    // 2026-10-26 Mon 20:00 SGT = 12:00 UTC → within
    const r = await ce.evalCanonicalConditions(et, msg(), "wf_x", undefined, new Date("2026-10-26T12:00:00Z"));
    eq(r.branch, "condition-index-0", "event_time 20:00 SGT → within");
    const r2 = await ce.evalCanonicalConditions(et, msg(), "wf_x", undefined, new Date("2026-10-26T03:00:00Z")); // 11:00 SGT
    eq(r2.branch, "condition-index-1", "event_time 11:00 SGT → outside");
  }

  // ─── 5. customer_waiting_time ───────────────────────────
  {
    const msgs = await mongo.getCollection(COLLECTIONS.messages);
    await msgs.deleteMany({});
    const wt = node("customer_waiting_time", {
      conditions: [{ operator: "greater_than", customerWaitingTime: { unit: "minutes", value: 8 } }],
    });
    const now = new Date("2026-10-26T03:00:00Z");
    await msgs.insertOne({ conversation_id: "cv_1", direction: "in", created_timestamp: new Date(now.getTime() - 10 * 60_000) });
    const r = await ce.evalCanonicalConditions(wt, msg(), "wf_x", undefined, now);
    eq(r.branch, "condition-index-0", "waiting 10m > 8m → condition-index-0");
    // staff ตอบแล้ว → waiting 0 → no-match
    await msgs.insertOne({ conversation_id: "cv_1", direction: "out", created_timestamp: new Date(now.getTime() - 5 * 60_000) });
    const r2 = await ce.evalCanonicalConditions(wt, msg(), "wf_x", undefined, now);
    eq(r2.branch, "no-match", "staff ตอบแล้ว → waiting 0 → no-match");
    // รอไม่ถึงเกณฑ์
    await msgs.deleteMany({});
    await msgs.insertOne({ conversation_id: "cv_1", direction: "in", created_timestamp: new Date(now.getTime() - 3 * 60_000) });
    const r3 = await ce.evalCanonicalConditions(wt, msg(), "wf_x", undefined, now);
    eq(r3.branch, "no-match", "waiting 3m < 8m → no-match");
  }

  // ─── 6. last_interaction ────────────────────────────────
  {
    const msgs = await mongo.getCollection(COLLECTIONS.messages);
    await msgs.deleteMany({});
    const li = node("last_interaction", {
      conditions: [{ operator: "greater_than", lastInteraction: { unit: "days", value: 3 } }],
    });
    const now = new Date("2026-10-26T03:00:00Z");
    await msgs.insertOne({ conversation_id: "cv_1", direction: "in", created_timestamp: new Date(now.getTime() - 4 * 86_400_000) });
    const r = await ce.evalCanonicalConditions(li, msg(), "wf_x", undefined, now);
    eq(r.branch, "condition-index-0", "last interaction 4d > 3d → condition-index-0");
    await msgs.deleteMany({});
    await msgs.insertOne({ conversation_id: "cv_1", direction: "in", created_timestamp: new Date(now.getTime() - 1 * 86_400_000) });
    const r2 = await ce.evalCanonicalConditions(li, msg(), "wf_x", undefined, now);
    eq(r2.branch, "no-match", "last interaction 1d < 3d → no-match");
  }

  // ─── 7. assignee — external id → binding resolution ─────
  {
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const status = await mongo.getCollection(COLLECTIONS.statusConversation);
    await binds.insertOne({
      binding_id: "wb_1", workflow_id: "wf_x", version_id: "wv_1", node_id: "zn_t",
      field_path: "conditions[0].assigneeUserId", kind: "user", count: 1,
      source_values: ["ext_u1"], status: "resolved",
      resolution: { mappings: [{ local_id: "adm_bank", state: "valid" }] },
    });
    const asn = node("assignee", {
      conditions: [{ operator: "equals" }, { operator: "equals" }, { operator: "equals" }],
    });
    await status.updateOne({ conversation_id: "cv_1" } as never,
      { $set: { conversation_id: "cv_1", assigned_to: "adm_bank" } }, { upsert: true });
    const r = await ce.evalCanonicalConditions(asn, msg(), "wf_x", "wv_1", new Date());
    eq(r.branch, "condition-index-0", "assignee bound ตุลย์=adm_bank + assigned_to match → condition-index-0");
    await status.updateOne({ conversation_id: "cv_1" } as never, { $set: { assigned_to: "adm_other" } });
    const r2 = await ce.evalCanonicalConditions(asn, msg(), "wf_x", "wv_1", new Date());
    eq(r2.branch, "no-match", "assigned_to คนอื่น → no-match");
    // binding unresolved → fail closed (ไม่ match)
    await binds.deleteMany({});
    await binds.insertOne({
      binding_id: "wb_2", workflow_id: "wf_x", version_id: "wv_1", node_id: "zn_t",
      field_path: "conditions[0].assigneeUserId", kind: "user", count: 1,
      source_values: ["ext_u1"], status: "unresolved",
    });
    await status.updateOne({ conversation_id: "cv_1" } as never, { $set: { assigned_to: "adm_bank" } });
    const r3 = await ce.evalCanonicalConditions(asn, msg(), "wf_x", "wv_1", new Date());
    eq(r3.branch, "no-match", "binding unresolved → no-match (fail-closed)");
    // ไม่มี version_id → resolve ไม่ได้ → no-match
    const r4 = await ce.evalCanonicalConditions(asn, msg(), "wf_x", undefined, new Date());
    eq(r4.branch, "no-match", "ไม่มี version_id → no-match");
  }

  // ─── 8. unknown subtype → error (fail-closed) ───────────
  {
    let err = "";
    try { await ce.evalCanonicalConditions(node("mystery_type", { conditions: [{ operator: "x" }] }), msg(), "wf_x", undefined); }
    catch (e) { err = (e as Error).message; }
    ok(err.includes("mystery_type"), `unknown subtype → error "${err}"`);
  }
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
