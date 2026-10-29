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

  // ─── 9. delay timer — park → sweep → resume → complete ──
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    await wfs.deleteMany({}); await runs.deleteMany({});
    // workflow: trigger → delay → (no edge = จบ flow)
    await wfs.insertOne({
      workflow_id: "wf_d", name: "delay flow", enabled: true, status: "published",
      nodes: [
        { node_id: "t1", type: "trigger", subtype: "message_received", config: {}, position: { x: 0, y: 0 } },
        { node_id: "d1", type: "wait", subtype: "delay", config: { delay: { unit: "minutes", value: 9 } }, position: { x: 0, y: 0 } },
      ],
      edges: [
        { edge_id: "e1", source_node_id: "t1", target_node_id: "d1" },
      ],
    });
    // run park อยู่ที่ delay — due แล้ว
    const past = new Date(Date.now() - 60_000);
    await runs.insertOne({
      run_id: "r_due", workflow_id: "wf_d", conversation_id: "cv_1",
      status: "waiting_for_timer", current_node_id: "d1", waiting_for: "timer",
      resume_at: past, context: {}, updated_at: past,
    });
    // run ยังไม่ due — ต้องไม่ถูกปลุก
    await runs.insertOne({
      run_id: "r_early", workflow_id: "wf_d", conversation_id: "cv_1",
      status: "waiting_for_timer", current_node_id: "d1", waiting_for: "timer",
      resume_at: new Date(Date.now() + 600_000), context: {}, updated_at: new Date(),
    });
    const res = await eng.sweepDueTimerRuns(new Date());
    eq(res.due, 1, "sweep เจอเฉพาะ run ที่ due (r_early ไม่ถูกหยิบ)");
    const rDue = await runs.findOne({ run_id: "r_due" });
    eq(rDue?.status, "completed", "due run → delay ผ่าน → ไม่มี edge → completed");
    eq(rDue?.outcome, "actioned", "delay จบด้วย actioned (edge ถัดไปหมด)");
    const rEarly = await runs.findOne({ run_id: "r_early" });
    eq(rEarly?.status, "waiting_for_timer", "early run ยัง park อยู่");
    // sweep ซ้ำ — run จบแล้วไม่มีอะไร due
    const res2 = await eng.sweepDueTimerRuns(new Date());
    eq(res2.due, 0, "sweep ซ้ำ idempotent — ไม่มี due ค้าง");
    // inbound ระหว่าง park → ไม่ resume timer (in_flight)
    await runs.insertOne({
      run_id: "r_park", workflow_id: "wf_d", conversation_id: "cv_inb",
      status: "waiting_for_timer", current_node_id: "d1", waiting_for: "timer",
      resume_at: new Date(Date.now() + 600_000), context: {}, updated_at: new Date(),
    });
    const cfg = await mongo.getCollection(COLLECTIONS.systemConfigs);
    await cfg.updateOne({ config_key: "main_config" } as never,
      { $set: { config_key: "main_config", workflow_enabled: true, workflow_run_timeout_ms: 1800000 } }, { upsert: true });
    const stage = await eng.runInboundWorkflowStage({ conversation_id: "cv_inb", shop_id: "s1", platform: "shopee", text: "hi" } as never);
    eq(stage.status, "in_flight", "inbound ระหว่าง delay → in_flight (ไม่ resume timer)");
  }

  // ─── 10. canonical chat_assign — pool/round-robin/OOH/lastHandler ──
  {
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const admins = await mongo.getCollection(COLLECTIONS.admins);
    const cursors = await mongo.getCollection(COLLECTIONS.assignmentCursors);
    const msgs2 = await mongo.getCollection(COLLECTIONS.messages);
    await binds.deleteMany({}); await admins.deleteMany({});
    await cursors.deleteMany({}); await msgs2.deleteMany({});
    await admins.insertMany([
      { admin_id: "adm_a", role: "admin", active: true },
      { admin_id: "adm_b", role: "admin", active: true },
      { admin_id: "adm_c", role: "admin", active: true },
      { admin_id: "adm_dead", role: "admin", active: false },
      { admin_id: "dev_1", role: "dev", active: true },
    ]);
    const assignNode = node("assign_ticket", {
      action: { assignment: { teamIds: [], userIds: [], assignWhenAllOoh: true, assignToLastTicketHandledBy: false, lastAssignedUsersIndex: 2 } },
    });
    // 10.1 team=all_admins (resolved) — global pool round-robin, per-node cursor
    await binds.insertOne({
      binding_id: "wb_t1", workflow_id: "wf_x", version_id: "wv_1", node_id: "zn_t",
      field_path: "action.assignment.teamIds", kind: "team", count: 1,
      source_values: ["ext_team1"], status: "resolved",
      resolution: { mappings: [{ local_id: "all_admins", state: "valid" }] },
    });
    const p1 = await ce.pickCanonicalAssignee(assignNode, msg(), "wf_x", "wv_1");
    eq("pick" in p1 ? p1.pick : null, "adm_a", "team=all_admins → pick แรก adm_a");
    const p2 = await ce.pickCanonicalAssignee(assignNode, msg(), "wf_x", "wv_1");
    eq("pick" in p2 ? p2.pick : null, "adm_b", "round-robin หมุน → adm_b");
    const p3 = await ce.pickCanonicalAssignee(assignNode, msg(), "wf_x", "wv_1");
    eq("pick" in p3 ? p3.pick : null, "adm_c", "→ adm_c (adm_dead/dev_1 ถูกข้าม)");
    const p4 = await ce.pickCanonicalAssignee(assignNode, msg(), "wf_x", "wv_1");
    eq("pick" in p4 ? p4.pick : null, "adm_a", "วนกลับ adm_a");
    eq("mode" in p4 ? p4.mode : null, "all_admins", "mode = all_admins");
    // 10.2 bound userIds — subset pool แชร์ cursor node เดิม (last=adm_a → next adm_b)
    await binds.deleteMany({});
    await binds.insertOne({
      binding_id: "wb_u1", workflow_id: "wf_x", version_id: "wv_1", node_id: "zn_t",
      field_path: "action.assignment.userIds", kind: "user", count: 2,
      source_values: ["u1", "u2"], status: "resolved",
      resolution: { mappings: [{ local_id: "adm_b", state: "valid" }, { local_id: "adm_c", state: "valid" }] },
    });
    const p5 = await ce.pickCanonicalAssignee(assignNode, msg(), "wf_x", "wv_1");
    eq("pick" in p5 ? p5.pick : null, "adm_b", "user pool [b,c] cursor เดิม adm_a → next adm_b");
    eq("mode" in p5 ? p5.mode : null, "user_pool", "mode = user_pool");
    // 10.3 assignWhenAllOoh:false + ร้าน OOH → skip (Sunday 10:00 BKK)
    const oohNode = node("assign_ticket", {
      action: { assignment: { teamIds: [], userIds: [], assignWhenAllOoh: false } },
    });
    const ooh = await ce.pickCanonicalAssignee(oohNode, msg(), "wf_x", "wv_1", new Date("2026-10-25T03:00:00Z"));
    eq("skip" in ooh ? ooh.skip : null, "all_out_of_hours", "assignWhenAllOoh:false + OOH → skip");
    const inHours = await ce.pickCanonicalAssignee(oohNode, msg(), "wf_x", "wv_1", new Date("2026-10-26T03:00:00Z"));
    ok("pick" in inHours || "error" in inHours, "ในเวลา → ไม่ skip (เข้า pick path)");
    // 10.4 assignToLastTicketHandledBy → last replier ใน pool
    await binds.deleteMany({});
    await binds.insertOne({
      binding_id: "wb_t2", workflow_id: "wf_x", version_id: "wv_1", node_id: "zn_t",
      field_path: "action.assignment.teamIds", kind: "team", count: 1,
      source_values: ["ext_team1"], status: "resolved",
      resolution: { mappings: [{ local_id: "all_admins", state: "valid" }] },
    });
    await msgs2.insertOne({ conversation_id: "cv_1", sender: "admin", admin_id: "adm_c", timestamp: new Date() });
    const lhNode = node("assign_ticket", {
      action: { assignment: { teamIds: [], userIds: [], assignWhenAllOoh: true, assignToLastTicketHandledBy: true } },
    });
    const p6 = await ce.pickCanonicalAssignee(lhNode, msg(), "wf_x", "wv_1");
    eq("pick" in p6 ? p6.pick : null, "adm_c", "lastTicketHandledBy → adm_c (last replier ใน pool)");
    eq("mode" in p6 ? p6.mode : null, "last_ticket_handler", "mode = last_ticket_handler");
    // 10.5 unresolved binding → error (fail-closed)
    await binds.deleteMany({});
    const p7 = await ce.pickCanonicalAssignee(assignNode, msg(), "wf_x", "wv_1");
    ok("error" in p7, "ไม่มี binding resolve → error (fail-closed)");
    const p8 = await ce.pickCanonicalAssignee(assignNode, msg(), "wf_x", undefined);
    ok("error" in p8, "ไม่มี version_id → error (fail-closed)");
  }
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
