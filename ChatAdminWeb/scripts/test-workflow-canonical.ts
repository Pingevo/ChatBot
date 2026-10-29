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
    // run park อยู่ที่ delay — due แล้ว (scope fields สำหรับ worker-scope filter)
    const scope = { config: { workflow_enabled: true },
      pairs: [{ platform: "shopee", shop_id: "s1", config_shop_key: "s1", shopname: "shop1", cutoff: new Date(0) }],
      global_enabled_since: null } as never;
    const past = new Date(Date.now() - 60_000);
    await runs.insertOne({
      run_id: "r_due", workflow_id: "wf_d", conversation_id: "cv_1",
      shop_id: "s1", platform: "shopee",
      status: "waiting_for_timer", current_node_id: "d1", waiting_for: "timer",
      resume_at: past, context: {}, updated_at: past,
    });
    // run ยังไม่ due — ต้องไม่ถูกปลุก
    await runs.insertOne({
      run_id: "r_early", workflow_id: "wf_d", conversation_id: "cv_1",
      shop_id: "s1", platform: "shopee",
      status: "waiting_for_timer", current_node_id: "d1", waiting_for: "timer",
      resume_at: new Date(Date.now() + 600_000), context: {}, updated_at: new Date(),
    });
    const res = await eng.sweepDueTimerRuns(undefined, scope, new Date());
    eq(res.due, 1, "sweep เจอเฉพาะ run ที่ due (r_early ไม่ถูกหยิบ)");
    const rDue = await runs.findOne({ run_id: "r_due" });
    eq(rDue?.status, "completed", "due run → delay ผ่าน → ไม่มี edge → completed");
    eq(rDue?.outcome, "actioned", "delay จบด้วย actioned (edge ถัดไปหมด)");
    const rEarly = await runs.findOne({ run_id: "r_early" });
    eq(rEarly?.status, "waiting_for_timer", "early run ยัง park อยู่");
    // sweep ซ้ำ — run จบแล้วไม่มีอะไร due
    const res2 = await eng.sweepDueTimerRuns(undefined, scope, new Date());
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

  // ─── 11. Flow 01 e2e — trigger → delay → conditions → assign ──
  //   golden path: inbound → park 9m → sweep → in-hours → waiting>8m →
  //   assignee ไม่ตรง → chat_assign team=all_admins → handoff persisted
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const shops = await mongo.getCollection(COLLECTIONS.shops);
    const admins = await mongo.getCollection(COLLECTIONS.admins);
    const convs = await mongo.getCollection(COLLECTIONS.conversations);
    const msgs = await mongo.getCollection(COLLECTIONS.messages);
    const status = await mongo.getCollection(COLLECTIONS.statusConversation);
    const cfg = await mongo.getCollection(COLLECTIONS.systemConfigs);
    const cursors = await mongo.getCollection(COLLECTIONS.assignmentCursors);
    await Promise.all([wfs, runs, binds, admins, convs, msgs, status, cursors]
      .map((c) => c.deleteMany({}) as Promise<unknown>));

    // business_hours 24/7 → ไม่ขึ้นเวลาจริงของ test
    await shops.deleteMany({});
    await shops.insertOne({
      shop_id: "s1", shopname: "shop1", platform: "shopee",
      business_hours: { timezone: "Asia/Bangkok", schedule: {
        SUN: [{ start: 0, end: 1440 }], MON: [{ start: 0, end: 1440 }],
        TUE: [{ start: 0, end: 1440 }], WED: [{ start: 0, end: 1440 }],
        THU: [{ start: 0, end: 1440 }], FRI: [{ start: 0, end: 1440 }],
        SAT: [{ start: 0, end: 1440 }] } },
    });
    await admins.insertMany([
      { admin_id: "adm_a", role: "admin", active: true },
      { admin_id: "adm_b", role: "admin", active: true },
      { admin_id: "adm_bank", role: "admin", active: true },
    ]);
    await cfg.updateOne({ config_key: "main_config" } as never,
      { $set: { config_key: "main_config", workflow_enabled: true } }, { upsert: true });

    // flow 01 shape: trigger → delay → bh → waiting → assignee → assign
    const V = "wv_f01";
    await wfs.insertOne({
      workflow_id: "wf_f01", name: "เก็บตกแชทค้าง", enabled: true, status: "published",
      trigger_frequency: "every_time", current_version_id: V,
      import: { source: "zaapi", source_workflow_id: "WF-f01" },
      shop_ids: [], platforms: [], priority: 0,
      nodes: [
        { node_id: "zt", type: "trigger", subtype: "message_received",
          config: { label: "ได้รับข้อความ", triggerOncePerConversation: false, triggerOncePerOpen: false }, position: { x: 0, y: 0 } },
        { node_id: "zd", type: "wait", subtype: "delay",
          config: { delay: { unit: "minutes", value: 9 } }, position: { x: 100, y: 0 } },
        { node_id: "zb", type: "condition", subtype: "business_hours",
          config: { label: "เวลาทำการ", conditions: [{ operator: "within_office_hours" }, { operator: "outside_office_hours" }] }, position: { x: 200, y: 0 } },
        { node_id: "zw", type: "condition", subtype: "customer_waiting_time",
          config: { label: "รอเกิน 8 นาที", conditions: [{ operator: "greater_than", customerWaitingTime: { unit: "minutes", value: 8 } }] }, position: { x: 300, y: 0 } },
        { node_id: "za", type: "condition", subtype: "assignee",
          config: { label: "มีเจ้าของในลิสต์", conditions: [{ operator: "equals" }] }, position: { x: 400, y: 0 } },
        { node_id: "zs", type: "action", subtype: "assign_ticket",
          config: { action: { assignment: { teamIds: [], userIds: [], assignWhenAllOoh: false, assignToLastTicketHandledBy: false, lastAssignedUsersIndex: 0 } } }, position: { x: 500, y: 0 } },
      ],
      edges: [
        { edge_id: "e1", source_node_id: "zt", target_node_id: "zd" },
        { edge_id: "e2", source_node_id: "zd", target_node_id: "zb" },
        { edge_id: "e3", source_node_id: "zb", target_node_id: "zw", branch: "condition-index-0" },
        // e4: condition-index-1 (นอกเวลา) ไม่มี edge → flow จบ
        { edge_id: "e5", source_node_id: "zw", target_node_id: "za", branch: "condition-index-0" },
        // e6: waiting no-match → จบ; assignee condition-index-0 (มีเจ้าของ) → จบ
        { edge_id: "e7", source_node_id: "za", target_node_id: "zs", branch: "no-match" },
      ],
    });
    await binds.insertMany([
      { binding_id: "wb_acc", workflow_id: "wf_f01", version_id: V, node_id: "zt",
        field_path: "accountIds", kind: "account", count: 1, source_values: ["za_acct"],
        status: "resolved", resolution: { mappings: [{ local_id: "s1", platform: "shopee", state: "valid" }] } },
      { binding_id: "wb_asn", workflow_id: "wf_f01", version_id: V, node_id: "za",
        field_path: "conditions[0].assigneeUserId", kind: "user", count: 1, source_values: ["za_u"],
        status: "resolved", resolution: { mappings: [{ local_id: "adm_bank", state: "valid" }] } },
      { binding_id: "wb_tm", workflow_id: "wf_f01", version_id: V, node_id: "zs",
        field_path: "action.assignment.teamIds", kind: "team", count: 1, source_values: ["za_team"],
        status: "resolved", resolution: { mappings: [{ local_id: "all_admins", state: "valid" }] } },
    ]);
    // conv ลูกค้าส่งมา 20 นาทีแล้ว ไม่มี staff ตอบ → waiting > 8m; ยังไม่มีเจ้าของ
    await convs.insertOne({ conversation_id: "cv_e1", platform: "shopee", shop_id: "s1" });
    await msgs.insertOne({ conversation_id: "cv_e1", direction: "in", created_timestamp: new Date(Date.now() - 20 * 60_000) });
    await status.insertOne({ conversation_id: "cv_e1", status: "bot", assigned_to: null });

    // 1) inbound → trigger match (message_received ไม่ต้องมี keywords) → park ที่ delay
    const m: Record<string, unknown> = { conversation_id: "cv_e1", shop_id: "s1", platform: "shopee",
      config_shop_key: "s1", text: "สวัสดี" };
    const r1 = await eng.matchAndRun(m as never);
    eq(r1.status, "actioned", "e2e: inbound → delay park (actioned)");
    const run1 = await runs.findOne({ conversation_id: "cv_e1" });
    eq(run1?.status, "waiting_for_timer", "run park ที่ delay 9m");
    ok(run1?.resume_at instanceof Date, "resume_at ถูกตั้ง");

    // 2) account scope — ข้อความจาก shop อื่น (ไม่ใช่ bound account) → no_match
    const r2 = await eng.matchAndRun({ ...m, conversation_id: "cv_e2", shop_id: "s_other" } as never);
    eq(r2.status, "no_match", "account scope: shop ไม่อยู่ใน bound accounts → no_match");

    // 3) ถึงเวลา → sweep → resume → conditions ผ่าน → assign → handoff persisted
    const scope2 = { config: { workflow_enabled: true },
      pairs: [{ platform: "shopee", shop_id: "s1", config_shop_key: "s1", shopname: "shop1", cutoff: new Date(0) }],
      global_enabled_since: null } as never;
    await runs.updateOne({ conversation_id: "cv_e1" } as never,
      { $set: { resume_at: new Date(Date.now() - 1000) } });
    const swept = await eng.sweepDueTimerRuns(undefined, scope2, new Date());
    eq(swept.due, 1, "sweep เจอ run due");
    const runDone = await runs.findOne({ conversation_id: "cv_e1" });
    eq(runDone?.status, "completed", "e2e: run เดินครบ graph → completed");
    const meta = await status.findOne({ conversation_id: "cv_e1" });
    eq(meta?.assigned_to, "adm_a", "chat_assign → handoff persisted adm_a (round-robin แรก)");
    eq(runDone?.outcome, "actioned", "run outcome = actioned (assign สำเร็จ)");

    // 4) ครั้งสองบน conv เดียวกัน (flags ปิด → ยิงได้อีก) — เจ้าของ adm_a ไม่อยู่ใน
    //    assignee list (adm_bank เท่านั้น) → no-match → re-assign ตาม flow +
    //    round-robin หมุนต่อ adm_b (Zaapi semantics: list ยกเว้นเฉพาะคนที่ระบุ)
    await msgs.insertOne({ conversation_id: "cv_e1", direction: "in", created_timestamp: new Date(Date.now() - 19 * 60_000) });
    const r3 = await eng.matchAndRun(m as never);
    eq(r3.status, "actioned", "re-fire: message ใหม่ → run ใหม่ park (flags=false)");
    const runCount = await runs.countDocuments({ conversation_id: "cv_e1" });
    eq(runCount, 2, "run ที่สองถูกสร้าง (triggerOnce flags=false)");
    await runs.updateOne({ conversation_id: "cv_e1", status: "waiting_for_timer" } as never,
      { $set: { resume_at: new Date(Date.now() - 1000) } });
    await eng.sweepDueTimerRuns(undefined, scope2, new Date());
    const meta2 = await status.findOne({ conversation_id: "cv_e1" });
    eq(meta2?.assigned_to, "adm_b", "re-assign → round-robin หมุน adm_b (adm_a ไม่อยู่ใน assignee list)");
  }

  // ─── 12. trigger once flags ─────────────────────────────
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const closeHist = await mongo.getCollection(COLLECTIONS.closeHistory);
    await wfs.deleteMany({}); await runs.deleteMany({}); await closeHist.deleteMany({});
    const trig = (flags: Record<string, unknown>) => ({
      node_id: "zt", type: "trigger", subtype: "message_received", config: flags, position: { x: 0, y: 0 },
    }) as never;
    const m2: Record<string, unknown> = { conversation_id: "cv_o1", shop_id: "s1", platform: "shopee" };
    // ไม่มี accountIds binding → ทุก account
    const r0 = await ce.canonicalTriggerMatches(trig({}), m2 as never, "wf_o1", "wv_o1");
    eq(r0, true, "message_received + no accountIds binding → match");
    // once_per_conversation: run เก่าอยู่ → ไม่ match
    await runs.insertOne({ run_id: "r_old", workflow_id: "wf_o1", conversation_id: "cv_o1", status: "completed", started_at: new Date() });
    const r1 = await ce.canonicalTriggerMatches(trig({ triggerOncePerConversation: true }), m2 as never, "wf_o1", "wv_o1");
    eq(r1, false, "oncePerConversation + run เดิม → ไม่ match");
    const r1b = await ce.canonicalTriggerMatches(trig({ triggerOncePerConversation: true }), { ...m2, conversation_id: "cv_o2" } as never, "wf_o1", "wv_o1");
    eq(r1b, true, "oncePerConversation + conv ใหม่ → match");
    // once_per_open: close → run หลัง close นับเป็น episode ใหม่
    const closeAt = new Date(Date.now() - 60_000);
    await closeHist.insertOne({ conversation_id: "cv_o1", closed_at: closeAt });
    // r_old (created now > closeAt) อยู่ใน episode ปัจจุบัน → block อยู่แล้ว;
    //   ลบออกแล้วเหลือเฉพาะ run ก่อน close → episode ใหม่ว่าง → match
    await runs.updateOne({ run_id: "r_old" } as never, { $set: { started_at: new Date(closeAt.getTime() - 60_000) } });
    await runs.insertOne({ run_id: "r_ep2", workflow_id: "wf_o1", conversation_id: "cv_o1", status: "completed", started_at: new Date(closeAt.getTime() + 1000) });
    const r2 = await ce.canonicalTriggerMatches(trig({ triggerOncePerOpen: true }), m2 as never, "wf_o1", "wv_o1");
    eq(r2, false, "oncePerOpen + run ใน episode ปัจจุบัน → ไม่ match");
    await runs.deleteOne({ run_id: "r_ep2" } as never);
    const r3 = await ce.canonicalTriggerMatches(trig({ triggerOncePerOpen: true }), m2 as never, "wf_o1", "wv_o1");
    eq(r3, true, "oncePerOpen + reopen แล้วยังไม่มี run episode นี้ → match");
    // subtype ไม่ใช่ inbound → false (label_added ฯลฯ เป็น event source อื่น)
    const r4 = await ce.canonicalTriggerMatches(trig({}), m2 as never, "wf_o1", "wv_o1") &&
      await ce.canonicalTriggerMatches({ node_id: "zl", type: "trigger", subtype: "label_added", config: {}, position: { x: 0, y: 0 } } as never, m2 as never, "wf_o1", "wv_o1") === false;
    eq(r4, true, "label_added → ไม่ match inbound (event source ต่างหาก)");
    // accountIds binding unresolved → fail closed
    const binds2 = await mongo.getCollection(COLLECTIONS.workflowBindings);
    await binds2.deleteMany({});
    await binds2.insertOne({ binding_id: "wb_ax", workflow_id: "wf_o1", version_id: "wv_o1", node_id: "zt",
      field_path: "accountIds", kind: "account", count: 1, source_values: ["x"], status: "unresolved" });
    const r5 = await ce.canonicalTriggerMatches(trig({}), m2 as never, "wf_o1", "wv_o1");
    eq(r5, false, "accountIds binding unresolved → no match (fail-closed)");
    void eng;
  }

  // ─── 13. message_content + label conditions ──────────────
  {
    const kw = node("message_content", {
      conditions: [
        { operator: "contains_one_of", msgType: "text", text: ["สคบ", "แจ้งความ", "ฟ้องร้อง"] },
        { operator: "equals", msgType: "text", text: ["5"] },
        { operator: "equals", msgType: "image" },
      ],
    });
    const r1 = await ce.evalCanonicalConditions(kw, msg({ text: "จะไปแจ้งความแล้วนะ" }), "wf_x", undefined);
    eq(r1.branch, "condition-index-0", "contains_one_of hit → cond-0");
    const r2 = await ce.evalCanonicalConditions(kw, msg({ text: "5" }), "wf_x", undefined);
    eq(r2.branch, "condition-index-1", "equals ตรง '5' → cond-1");
    const r3 = await ce.evalCanonicalConditions(kw, msg({ text: "55" }), "wf_x", undefined);
    eq(r3.branch, "no-match", "equals '55' ≠ '5' → no-match");
    const r4 = await ce.evalCanonicalConditions(kw, msg({ text: "", images: ["https://x/y.jpg"] }), "wf_x", undefined);
    eq(r4.branch, "condition-index-2", "image msgType → cond-2");
    const r5 = await ce.evalCanonicalConditions(kw, msg({ text: "", images: ["https://x/y.mp4"] }), "wf_x", undefined);
    eq(r5.branch, "no-match", "video-only ≠ image → no-match");
    // label condition — bound labels ต้องมีครบใน conv
    const binds3 = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const convs2 = await mongo.getCollection(COLLECTIONS.conversations);
    await binds3.deleteMany({}); await convs2.deleteMany({ conversation_id: "cv_1" } as never);
    await binds3.insertOne({ binding_id: "wb_l", workflow_id: "wf_x", version_id: "wv_1", node_id: "zn_t",
      field_path: "conditions[0].labelIds", kind: "label", count: 2, source_values: ["l1", "l2"],
      status: "resolved", resolution: { mappings: [{ local_id: "เคสเสี่ยง-กฎหมาย", state: "valid" }, { local_id: "รอให้คะแนน", state: "valid" }] } });
    await convs2.updateOne({ conversation_id: "cv_1" } as never,
      { $set: { conversation_id: "cv_1", labels: ["เคสเสี่ยง-กฎหมาย", "รอให้คะแนน"] } }, { upsert: true });
    const lab = node("label", { conditions: [{ operator: "equals" }] });
    const r6 = await ce.evalCanonicalConditions(lab, msg(), "wf_x", "wv_1");
    eq(r6.branch, "condition-index-0", "conv มีครบ 2 bound labels → cond-0");
    await convs2.updateOne({ conversation_id: "cv_1" } as never, { $set: { labels: ["เคสเสี่ยง-กฎหมาย"] } });
    const r7 = await ce.evalCanonicalConditions(lab, msg(), "wf_x", "wv_1");
    eq(r7.branch, "no-match", "labels ขาด 1 → no-match");
    await binds3.updateOne({ binding_id: "wb_l" } as never, { $set: { status: "unresolved", resolution: null } });
    const r8 = await ce.evalCanonicalConditions(lab, msg(), "wf_x", "wv_1");
    eq(r8.branch, "no-match", "label binding unresolved → no-match (fail-closed)");
    // corpus operators จริง: contains_all (มีครบทุกตัว — semantics เดียวกับ equals)
    //   + does_not_contain_any_of (ไม่มีเลยสักตัว — flow 07)
    await binds3.updateOne({ binding_id: "wb_l" } as never, { $set: { status: "resolved",
      resolution: { mappings: [{ local_id: "เคสเสี่ยง-กฎหมาย", state: "valid" }, { local_id: "รอให้คะแนน", state: "valid" }] } } });
    const labAll = node("label", { conditions: [{ operator: "contains_all" }] });
    await convs2.updateOne({ conversation_id: "cv_1" } as never, { $set: { labels: ["เคสเสี่ยง-กฎหมาย", "รอให้คะแนน"] } });
    eq((await ce.evalCanonicalConditions(labAll, msg(), "wf_x", "wv_1")).branch, "condition-index-0",
      "contains_all: มีครบ 2 → cond-0");
    await convs2.updateOne({ conversation_id: "cv_1" } as never, { $set: { labels: ["เคสเสี่ยง-กฎหมาย"] } });
    eq((await ce.evalCanonicalConditions(labAll, msg(), "wf_x", "wv_1")).branch, "no-match",
      "contains_all: ขาด 1 → no-match");
    const labNone = node("label", { conditions: [{ operator: "does_not_contain_any_of" }] });
    await convs2.updateOne({ conversation_id: "cv_1" } as never, { $set: { labels: ["อื่น"] } });
    eq((await ce.evalCanonicalConditions(labNone, msg(), "wf_x", "wv_1")).branch, "condition-index-0",
      "does_not_contain_any_of: ไม่มีเลย → cond-0");
    await convs2.updateOne({ conversation_id: "cv_1" } as never, { $set: { labels: ["รอให้คะแนน", "อื่น"] } });
    eq((await ce.evalCanonicalConditions(labNone, msg(), "wf_x", "wv_1")).branch, "no-match",
      "does_not_contain_any_of: มี 1 ตัว → no-match");
  }

  // ─── 14. Flow 02 e2e — keyword → label → assign → send ──
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const admins = await mongo.getCollection(COLLECTIONS.admins);
    const convs = await mongo.getCollection(COLLECTIONS.conversations);
    const status = await mongo.getCollection(COLLECTIONS.statusConversation);
    const cursors = await mongo.getCollection(COLLECTIONS.assignmentCursors);
    await Promise.all([wfs, runs, binds, admins, convs, status, cursors]
      .map((c) => c.deleteMany({}) as Promise<unknown>));
    await admins.insertMany([
      { admin_id: "adm_a", role: "admin", active: true },
      { admin_id: "adm_b", role: "admin", active: true },
    ]);
    const V = "wv_f02";
    await wfs.insertOne({
      workflow_id: "wf_f02", name: "ดักคำเสี่ยง", enabled: true, status: "published",
      trigger_frequency: "every_time", current_version_id: V,
      import: { source: "zaapi", source_workflow_id: "WF-f02" },
      shop_ids: [], platforms: [], priority: 0,
      nodes: [
        { node_id: "zt", type: "trigger", subtype: "message_received",
          config: { triggerOncePerConversation: false, triggerOncePerOpen: false }, position: { x: 0, y: 0 } },
        { node_id: "zk", type: "condition", subtype: "message_content",
          config: { label: "คำเสี่ยง", conditions: [
            { operator: "contains_one_of", msgType: "text", text: ["สคบ", "แจ้งความ", "ไฟช็อต"] }] }, position: { x: 100, y: 0 } },
        { node_id: "zl", type: "action", subtype: "add_label",
          config: { action: { label: {} } }, position: { x: 200, y: 0 } },
        { node_id: "zs", type: "action", subtype: "assign_ticket",
          config: { action: { assignment: { teamIds: [], userIds: [], assignWhenAllOoh: true, assignToLastTicketHandledBy: false } } }, position: { x: 300, y: 0 } },
        { node_id: "zm", type: "action", subtype: "send_message",
          config: { action: { message: { type: "text", text: "รับเรื่องแล้วค่ะ เจ้าหน้าที่จะติดต่อกลับ" } } }, position: { x: 400, y: 0 } },
      ],
      edges: [
        { edge_id: "e1", source_node_id: "zt", target_node_id: "zk" },
        { edge_id: "e2", source_node_id: "zk", target_node_id: "zl", branch: "condition-index-0" },
        { edge_id: "e3", source_node_id: "zl", target_node_id: "zs" },
        { edge_id: "e4", source_node_id: "zs", target_node_id: "zm" },
      ],
    });
    await binds.insertMany([
      { binding_id: "wb_f2l", workflow_id: "wf_f02", version_id: V, node_id: "zl",
        field_path: "action.label.labelIds", kind: "label", count: 1, source_values: ["za_l"],
        status: "resolved", resolution: { mappings: [{ local_id: "เคสเสี่ยง-กฎหมาย", state: "valid" }] } },
      { binding_id: "wb_f2t", workflow_id: "wf_f02", version_id: V, node_id: "zs",
        field_path: "action.assignment.teamIds", kind: "team", count: 1, source_values: ["za_t"],
        status: "resolved", resolution: { mappings: [{ local_id: "all_admins", state: "valid" }] } },
    ]);
    await convs.insertOne({ conversation_id: "cv_f2", platform: "shopee", shop_id: "s1", labels: [] });
    await status.insertOne({ conversation_id: "cv_f2", status: "bot", assigned_to: null });
    const m: Record<string, unknown> = { conversation_id: "cv_f2", shop_id: "s1", platform: "shopee",
      config_shop_key: "s1", text: "ของไฟช็อตมือเลย จะแจ้งความ" };
    // keyword hit → label + assign + send
    const r1 = await eng.matchAndRun(m as never);
    eq(r1.status, "actioned", "f02: keyword hit → actioned");
    eq(r1.delivered?.[0]?.text, "รับเรื่องแล้วค่ะ เจ้าหน้าที่จะติดต่อกลับ", "f02: send_message delivered");
    const convAfter = await convs.findOne({ conversation_id: "cv_f2" });
    ok((convAfter?.labels || []).includes("เคสเสี่ยง-กฎหมาย"), "f02: label เคสเสี่ยง-กฎหมาย ถูกเพิ่ม");
    const meta = await status.findOne({ conversation_id: "cv_f2" });
    eq(meta?.assigned_to, "adm_a", "f02: assigned adm_a (team pool)");
    // keyword miss → no-match → flow จบ ไม่มี side effect
    await convs.updateOne({ conversation_id: "cv_f2" } as never, { $set: { labels: [] } });
    const r2 = await eng.matchAndRun({ ...m, conversation_id: "cv_f2b", text: "สวัสดีครับ" } as never);
    eq(r2.status, "actioned", "f02: keyword miss → run ยังทำ (walk จบที่ no-match)");
    const conv2 = await convs.findOne({ conversation_id: "cv_f2b" });
    ok(conv2 == null || !(conv2.labels || []).includes("เคสเสี่ยง-กฎหมาย"), "f02: miss → ไม่มี label ติด");
  }

  // ─── 15. Flow 03 e2e — delay → waiting → label dedupe → send ──
  //   ลูกค้ารอเกิน 9m → ติด รอตอบเกิน10นาที → ยังไม่มี tag dedupe → ส่งข้อความ
  //   + ติด tag (ลูกค้าที่มี tag อยู่แล้ว → ไม่ส่งซ้ำ)
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const convs = await mongo.getCollection(COLLECTIONS.conversations);
    const msgs = await mongo.getCollection(COLLECTIONS.messages);
    await Promise.all([wfs, runs, binds, convs, msgs].map((c) => c.deleteMany({}) as Promise<unknown>));
    const V = "wv_f03";
    await wfs.insertOne({
      workflow_id: "wf_f03", name: "รอเกิน 10 นาที", enabled: true, status: "published",
      trigger_frequency: "every_time", current_version_id: V,
      import: { source: "zaapi", source_workflow_id: "WF-f03" },
      shop_ids: [], platforms: [], priority: 0,
      nodes: [
        { node_id: "zt", type: "trigger", subtype: "message_received",
          config: { triggerOncePerConversation: false, triggerOncePerOpen: false }, position: { x: 0, y: 0 } },
        { node_id: "zd", type: "wait", subtype: "delay",
          config: { delay: { unit: "minutes", value: 10 } }, position: { x: 100, y: 0 } },
        { node_id: "zw", type: "condition", subtype: "customer_waiting_time",
          config: { conditions: [{ operator: "greater_than", customerWaitingTime: { unit: "minutes", value: 9 } }] }, position: { x: 200, y: 0 } },
        { node_id: "zl1", type: "action", subtype: "add_label",
          config: { action: { label: {} } }, position: { x: 300, y: 0 } },
        { node_id: "zlc", type: "condition", subtype: "label",
          config: { conditions: [{ operator: "contains_one_of" }] }, position: { x: 400, y: 0 } },
        { node_id: "zm", type: "action", subtype: "send_message",
          config: { action: { message: { type: "text", text: "ขออภัยที่ให้รอค่ะ" } } }, position: { x: 500, y: 0 } },
        { node_id: "zl2", type: "action", subtype: "add_label",
          config: { action: { label: {} } }, position: { x: 600, y: 0 } },
      ],
      edges: [
        { edge_id: "e1", source_node_id: "zt", target_node_id: "zd" },
        { edge_id: "e2", source_node_id: "zd", target_node_id: "zw" },
        { edge_id: "e3", source_node_id: "zw", target_node_id: "zl1", branch: "condition-index-0" },
        { edge_id: "e4", source_node_id: "zl1", target_node_id: "zlc" },
        { edge_id: "e5", source_node_id: "zlc", target_node_id: "zm", branch: "no-match" },
        { edge_id: "e6", source_node_id: "zm", target_node_id: "zl2" },
      ],
    });
    await binds.insertMany([
      { binding_id: "wb_f3a", workflow_id: "wf_f03", version_id: V, node_id: "zl1",
        field_path: "action.label.labelIds", kind: "label", count: 1, source_values: ["x1"],
        status: "resolved", resolution: { mappings: [{ local_id: "รอตอบเกิน10นาที", state: "valid" }] } },
      { binding_id: "wb_f3c", workflow_id: "wf_f03", version_id: V, node_id: "zlc",
        field_path: "conditions[0].labelIds", kind: "label", count: 1, source_values: ["x2"],
        status: "resolved", resolution: { mappings: [{ local_id: "ได้แค่ข้อความรอ", state: "valid" }] } },
      { binding_id: "wb_f3b", workflow_id: "wf_f03", version_id: V, node_id: "zl2",
        field_path: "action.label.labelIds", kind: "label", count: 1, source_values: ["x3"],
        status: "resolved", resolution: { mappings: [{ local_id: "ได้แค่ข้อความรอ", state: "valid" }] } },
    ]);
    // ลูกค้าส่งมา 20 นาที ยังไม่มีคนตอบ
    await convs.insertOne({ conversation_id: "cv_f3", platform: "shopee", shop_id: "s1", labels: [] });
    await msgs.insertOne({ conversation_id: "cv_f3", direction: "in", created_timestamp: new Date(Date.now() - 20 * 60_000) });
    const m3 = { conversation_id: "cv_f3", shop_id: "s1", platform: "shopee",
      config_shop_key: "s1", text: "ยังไม่ตอบเลย" };
    const scope3 = { config: { workflow_enabled: true },
      pairs: [{ platform: "shopee", shop_id: "s1", config_shop_key: "s1", shopname: "shop1", cutoff: new Date(0) }],
      global_enabled_since: null } as never;
    const r1 = await eng.matchAndRun(m3 as never);
    eq(r1.status, "actioned", "f03: inbound → delay park");
    // ถึงเวลา → sweep → waiting>9m → tag รอตอบ → dedupe miss → send + tag dedupe
    await runs.updateOne({ conversation_id: "cv_f3" } as never,
      { $set: { resume_at: new Date(Date.now() - 1000) } });
    await eng.sweepDueTimerRuns(undefined, scope3, new Date());
    const runDone = await runs.findOne({ conversation_id: "cv_f3", status: "completed" } as never);
    ok(runDone != null, "f03: run completed");
    const convA = await convs.findOne({ conversation_id: "cv_f3" });
    const labels1 = (convA?.labels || []) as string[];
    ok(labels1.includes("รอตอบเกิน10นาที"), "f03: tag รอตอบเกิน10นาที");
    ok(labels1.includes("ได้แค่ข้อความรอ"), "f03: tag dedupe ได้แค่ข้อความรอ (หลัง send)");
    // รอบสอง — ลูกค้ามี tag dedupe แล้ว → label cond match → ไม่ส่งซ้ำ
    await msgs.insertOne({ conversation_id: "cv_f3", direction: "in", created_timestamp: new Date(Date.now() - 19 * 60_000) });
    const r2 = await eng.matchAndRun(m3 as never);
    eq(r2.status, "actioned", "f03: re-fire → run ใหม่ park");
    await runs.updateOne({ conversation_id: "cv_f3", status: "waiting_for_timer" } as never,
      { $set: { resume_at: new Date(Date.now() - 1000) } });
    const sw2 = await eng.sweepDueTimerRuns(undefined, scope3, new Date());
    eq(sw2.errors.length, 0, "f03: re-fire sweep ไม่ error");
    const run2 = await runs.findOne({ conversation_id: "cv_f3", status: "completed", run_id: { $ne: runDone?.run_id } } as never);
    const del2 = (run2?.result as { delivered?: unknown[] } | undefined)?.delivered;
    ok(!del2 || del2.length === 0, "f03: dedupe — ลูกค้ามี tag แล้ว → ไม่ส่งซ้ำ (label cond match → cond-0 ไม่มี edge → จบ)");
  }

  // ─── 16. Flow 04 e2e — oncePerOpen trigger + remove_label ──
  //   tag dedupe ถูกลบเมื่อ conv เปิดใหม่ → flow 03 ส่งได้อีก (cross-flow contract)
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const convs = await mongo.getCollection(COLLECTIONS.conversations);
    const closeHist = await mongo.getCollection(COLLECTIONS.closeHistory);
    await Promise.all([wfs, runs, binds, convs, closeHist].map((c) => c.deleteMany({}) as Promise<unknown>));
    const V = "wv_f04";
    await wfs.insertOne({
      workflow_id: "wf_f04", name: "ล้างแท็กเมื่อเปิดใหม่", enabled: true, status: "published",
      trigger_frequency: "every_time", current_version_id: V,
      import: { source: "zaapi", source_workflow_id: "WF-f04" },
      shop_ids: [], platforms: [], priority: 0,
      nodes: [
        { node_id: "zt", type: "trigger", subtype: "message_received",
          config: { triggerOncePerConversation: false, triggerOncePerOpen: true }, position: { x: 0, y: 0 } },
        { node_id: "zr", type: "action", subtype: "remove_label",
          config: { action: { label: {} } }, position: { x: 100, y: 0 } },
      ],
      edges: [{ edge_id: "e1", source_node_id: "zt", target_node_id: "zr" }],
    });
    await binds.insertOne({ binding_id: "wb_f4", workflow_id: "wf_f04", version_id: V, node_id: "zr",
      field_path: "action.label.labelIds", kind: "label", count: 1, source_values: ["x"],
      status: "resolved", resolution: { mappings: [{ local_id: "ได้แค่ข้อความรอ", state: "valid" }] } });
    // conv เคยปิดแล้วเปิดใหม่ + มี dedupe tag ค้าง
    await closeHist.insertOne({ conversation_id: "cv_f4", closed_at: new Date(Date.now() - 3600_000) });
    await convs.insertOne({ conversation_id: "cv_f4", platform: "shopee", shop_id: "s1", labels: ["ได้แค่ข้อความรอ", "อื่นๆ"] });
    const m4 = { conversation_id: "cv_f4", shop_id: "s1", platform: "shopee",
      config_shop_key: "s1", text: "เปิดใหม่นะ" };
    const r1 = await eng.matchAndRun(m4 as never);
    eq(r1.status, "actioned", "f04: episode ใหม่ → run → remove_label");
    const convA = await convs.findOne({ conversation_id: "cv_f4" });
    const l1 = (convA?.labels || []) as string[];
    ok(!l1.includes("ได้แค่ข้อความรอ"), "f04: dedupe tag ถูกลบ");
    ok(l1.includes("อื่นๆ"), "f04: label อื่นคงอยู่");
    // ข้อความที่สองใน episode เดียวกัน → oncePerOpen block → no_match
    const r2 = await eng.matchAndRun(m4 as never);
    eq(r2.status, "no_match", "f04: oncePerOpen — ข้อความ 2 ใน episode เดียวกัน → ไม่ run ซ้ำ");
  }

  // ─── 17. canonical wfr — park → reply=wfr-success / expire=wfr-no-respond ──
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    await Promise.all([wfs, runs].map((c) => c.deleteMany({}) as Promise<unknown>));
    const V = "wv_wfr";
    const mk = (id: string) => wfs.insertOne({
      workflow_id: id, name: "wfr test", enabled: true, status: "published",
      trigger_frequency: "every_time", current_version_id: V,
      import: { source: "zaapi", source_workflow_id: "WF-w" },
      shop_ids: [], platforms: [], priority: 0,
      nodes: [
        { node_id: "t", type: "trigger", subtype: "message_received", config: {}, position: { x: 0, y: 0 } },
        { node_id: "w", type: "wait", subtype: "wait_for_reply",
          config: { waitForReply: { replyType: "any", expiresIn: { unit: "minutes", value: 5 } } }, position: { x: 1, y: 0 } },
        { node_id: "ok", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "got reply" } } }, position: { x: 2, y: 0 } },
        { node_id: "to", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "timeout msg" } } }, position: { x: 3, y: 0 } },
      ],
      edges: [
        { edge_id: "e1", source_node_id: "t", target_node_id: "w" },
        { edge_id: "e2", source_node_id: "w", target_node_id: "ok", branch: "wfr-success" },
        { edge_id: "e3", source_node_id: "w", target_node_id: "to", branch: "wfr-no-respond" },
      ],
    });
    await mk("wf_wfr");
    const scopeW = { config: { workflow_enabled: true },
      pairs: [{ platform: "shopee", shop_id: "s1", config_shop_key: "s1", shopname: "s", cutoff: new Date(0) }],
      global_enabled_since: null } as never;
    const m = { conversation_id: "cv_w1", shop_id: "s1", platform: "shopee", config_shop_key: "s1", text: "hi" };
    const r1 = await eng.matchAndRun(m as never);
    eq(r1.status, "actioned", "wfr: park on inbound");
    const parked = await runs.findOne({ conversation_id: "cv_w1" });
    eq(parked?.status, "waiting_for_reply", "wfr: status waiting_for_reply");
    ok(parked?.resume_at instanceof Date, "wfr: resume_at set from expiresIn");
    // reply → wfr-success (inbound entry = runInboundWorkflowStage — resume ก่อน match)
    const r2 = await eng.runInboundWorkflowStage({ ...m, text: "ตอบแล้ว" } as never);
    eq(r2.status, "resumed", "wfr: reply resumes");
    ok((r2.delivered || []).some((d: { text?: string }) => d.text === "got reply"), "wfr: reply → wfr-success edge (got reply)");
    // timeout → wfr-no-respond — direct resumeTimerRun assert edge เดินจริง
    const m2 = { ...m, conversation_id: "cv_w2" };
    await eng.matchAndRun(m2 as never);
    const parked2 = await runs.findOne({ conversation_id: "cv_w2" }) as never;
    const rTo = await eng.resumeTimerRun(parked2, m2 as never);
    ok((rTo.delivered || []).some((d: { text?: string }) => d.text === "timeout msg"), "wfr: expire → wfr-no-respond edge");
    // sweep pickup ยังทำงานสำหรับ waiting_for_reply + resume_at (regression ที่เพิ่ม)
    const m3 = { ...m, conversation_id: "cv_w3" };
    await eng.matchAndRun(m3 as never);
    await runs.updateOne({ conversation_id: "cv_w3" } as never, { $set: { resume_at: new Date(Date.now() - 1000) } });
    const sw = await eng.sweepDueTimerRuns(undefined, scopeW, new Date());
    eq(sw.resumed, 1, "wfr: sweep picks waiting_for_reply+resume_at due");
  }

  // ─── 18. canonical chatbot — park ai_bot → timeout/escalate ──
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    await Promise.all([wfs, runs].map((c) => c.deleteMany({}) as Promise<unknown>));
    const V = "wv_ai";
    await wfs.insertOne({
      workflow_id: "wf_ai", name: "ai test", enabled: true, status: "published",
      trigger_frequency: "every_time", current_version_id: V,
      import: { source: "zaapi", source_workflow_id: "WF-a" },
      shop_ids: [], platforms: [], priority: 0,
      nodes: [
        { node_id: "t", type: "trigger", subtype: "message_received", config: {}, position: { x: 0, y: 0 } },
        { node_id: "ai", type: "action", subtype: "let_ai_respond",
          config: { action: { chatbot: { timeout: { unit: "hours", value: 1 } } } }, position: { x: 1, y: 0 } },
        { node_id: "esc", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "escalated to human" } } }, position: { x: 2, y: 0 } },
        { node_id: "to", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "ai timed out" } } }, position: { x: 3, y: 0 } },
      ],
      edges: [
        { edge_id: "e1", source_node_id: "t", target_node_id: "ai" },
        { edge_id: "e2", source_node_id: "ai", target_node_id: "esc", branch: "ai-chatbot-escalate" },
        { edge_id: "e3", source_node_id: "ai", target_node_id: "to", branch: "ai-chatbot-timeout" },
      ],
    });
    const scopeA = { config: { workflow_enabled: true },
      pairs: [{ platform: "shopee", shop_id: "s1", config_shop_key: "s1", shopname: "s", cutoff: new Date(0) }],
      global_enabled_since: null } as never;
    const m = { conversation_id: "cv_a1", shop_id: "s1", platform: "shopee", config_shop_key: "s1", text: "hi" };
    const r1 = await eng.matchAndRun(m as never);
    eq(r1.status, "actioned", "ai: park");
    const parked = await runs.findOne({ conversation_id: "cv_a1" });
    eq(parked?.status, "waiting_for_timer", "ai: parked as timer (inbound ไม่ปลุก)");
    eq(parked?.park_kind, "ai_bot", "ai: park_kind ai_bot");
    // inbound ขณะ AI จัดการ → ไม่ resume workflow
    const r2 = await eng.matchAndRun({ ...m, text: "อีกข้อความ" } as never);
    ok(r2.status !== "resumed" || (await runs.findOne({ conversation_id: "cv_a1", status: "waiting_for_timer" })) != null,
      "ai: inbound during ai-bot → run stays parked (bot owns conv)");
    // escalate → ai-chatbot-escalate edge
    const r3 = await eng.escalateAiRun("cv_a1", m as never);
    eq(r3.status, "resumed", "ai: escalate resumes");
    ok((r3.delivered || []).some((d: { text?: string }) => d.text === "escalated to human"), "ai: escalate → escalate edge");
    // timeout → ai-chatbot-timeout edge — direct resumeTimerRun
    const m2 = { ...m, conversation_id: "cv_a2" };
    await eng.matchAndRun(m2 as never);
    const parked2 = await runs.findOne({ conversation_id: "cv_a2" }) as never;
    const rTo = await eng.resumeTimerRun(parked2, m2 as never);
    ok((rTo.delivered || []).some((d: { text?: string }) => d.text === "ai timed out"), "ai: timeout → timeout edge");
  }

  // ─── 19. button template / randomizer / unassign / set_ticket_field / marketplace+review / label_added chain ──
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const ce = await import("../src/backend/service/workflowCanonicalEval");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const convs = await mongo.getCollection(COLLECTIONS.conversations);
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const statuses = await mongo.getCollection(COLLECTIONS.statusConversation);
    await Promise.all([wfs, runs, convs, binds, statuses].map((c) => c.deleteMany({}) as Promise<unknown>));

    // review conditions — payload-driven
    {
      const cnode = { node_id: "c", type: "condition", subtype: "review_rating",
        config: { conditions: [{ operator: "equals", reviewRating: { value: 5 } }] } } as never;
      const r5 = await ce.evalCanonicalConditions(cnode, { conversation_id: "x", shop_id: "s", review: { rating: 5 } } as never, "w", "v");
      eq(r5.branch, "condition-index-0", "review_rating: rating 5 → cond-0");
      const r3v = await ce.evalCanonicalConditions(cnode, { conversation_id: "x", shop_id: "s", review: { rating: 3 } } as never, "w", "v");
      eq(r3v.branch, "no-match", "review_rating: rating 3 → no-match");
      const snode = { node_id: "c2", type: "condition", subtype: "ai_review_sentiment",
        config: { conditions: [{ operator: "equals", aiSentiment: "negative" }] } } as never;
      const sn = await ce.evalCanonicalConditions(snode, { conversation_id: "x", shop_id: "s", review: { sentiment: "negative" } } as never, "w", "v");
      eq(sn.branch, "condition-index-0", "ai_review_sentiment: negative → cond-0");
    }

    // marketplace event trigger + adapter actions
    {
      const calls: { kind: string }[] = [];
      eng.setMarketplaceAdapter(async (a: { kind: string }) => { calls.push({ kind: a.kind }); });
      const V = "wv_mkt";
      await wfs.insertOne({
        workflow_id: "wf_mkt", name: "order", enabled: true, status: "published",
        trigger_frequency: "every_time", current_version_id: V,
        import: { source: "zaapi", source_workflow_id: "WF-m" },
        shop_ids: [], platforms: [], priority: 0,
        nodes: [
          { node_id: "t", type: "trigger", subtype: "marketplace_order_created", config: {}, position: { x: 0, y: 0 } },
          { node_id: "oc", type: "action", subtype: "send_marketplace_order_card", config: { action: {} }, position: { x: 1, y: 0 } },
          { node_id: "rr", type: "action", subtype: "reply_to_review", config: { action: { replyToReview: "ขอบคุณค่ะ" } }, position: { x: 2, y: 0 } },
        ],
        edges: [
          { edge_id: "e1", source_node_id: "t", target_node_id: "oc" },
          { edge_id: "e2", source_node_id: "oc", target_node_id: "rr" },
        ],
      });
      const m = { conversation_id: "cv_m1", shop_id: "s1", platform: "shopee", config_shop_key: "s1" };
      const r = await eng.matchAndRunEvent(m as never, "marketplace_order_created");
      eq(r.status, "actioned", "mkt: order_created event → run");
      eq(calls.length, 2, "mkt: adapter called order_card + reply_to_review");
      eq(calls[0]?.kind, "send_marketplace_order_card", "mkt: order card first");
      // wrong event kind → no match
      const r2 = await eng.matchAndRunEvent(m as never, "marketplace_review_added");
      eq(r2.status, "no_match", "mkt: review_added ≠ order_created → no_match");
      // no adapter → fail-closed throw (เหมือน send_message image — caller เห็น error)
      eng.setMarketplaceAdapter(null);
      const m3 = { ...m, conversation_id: "cv_m3" };
      let threw = false;
      try { await eng.matchAndRunEvent(m3 as never, "marketplace_order_created"); } catch { threw = true; }
      ok(threw, "mkt: no adapter → fail closed (throw)");
      eng.setMarketplaceAdapter(async () => {});
    }

    // label_added chain — flow A add_label → flow B (label_added trigger) fires
    {
      const VA = "wv_la", VB = "wv_lb";
      await wfs.insertMany([
        {
          workflow_id: "wf_la", name: "tagger", enabled: true, status: "published",
          trigger_frequency: "every_time", current_version_id: VA,
          import: { source: "zaapi", source_workflow_id: "WF-la" },
          shop_ids: [], platforms: [], priority: 0,
          nodes: [
            { node_id: "t", type: "trigger", subtype: "message_received", config: {}, position: { x: 0, y: 0 } },
            { node_id: "al", type: "action", subtype: "add_label", config: { action: { label: {} } }, position: { x: 1, y: 0 } },
          ],
          edges: [{ edge_id: "e1", source_node_id: "t", target_node_id: "al" }],
        },
        {
          workflow_id: "wf_lb", name: "label listener", enabled: true, status: "published",
          trigger_frequency: "every_time", current_version_id: VB,
          import: { source: "zaapi", source_workflow_id: "WF-lb" },
          shop_ids: [], platforms: [], priority: 0,
          nodes: [
            { node_id: "t", type: "trigger", subtype: "label_added", config: {}, position: { x: 0, y: 0 } },
            { node_id: "sm", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "label chain fired" } } }, position: { x: 1, y: 0 } },
          ],
          edges: [{ edge_id: "e1", source_node_id: "t", target_node_id: "sm" }],
        },
      ] as never[]);
      await binds.insertMany([
        { binding_id: "b1", workflow_id: "wf_la", version_id: VA, node_id: "al",
          field_path: "action.label.labelIds", kind: "label", count: 1, source_values: ["x"],
          status: "resolved", resolution: { mappings: [{ local_id: "CHAIN", state: "valid" }] } },
        { binding_id: "b2", workflow_id: "wf_lb", version_id: VB, node_id: "t",
          field_path: "labelIds", kind: "label", count: 1, source_values: ["y"],
          status: "resolved", resolution: { mappings: [{ local_id: "CHAIN", state: "valid" }] } },
      ] as never[]);
      const m = { conversation_id: "cv_l1", shop_id: "s1", platform: "shopee", config_shop_key: "s1", text: "hi" };
      await eng.matchAndRun(m as never);
      const chainRun = await runs.findOne({ workflow_id: "wf_lb", conversation_id: "cv_l1" }) as { status?: string; outcome?: string } | null;
      ok(chainRun != null, "label chain: add_label fired label_added flow");
      eq(chainRun?.status, "completed", "label chain: listener flow executed (completed)");
      eq(chainRun?.outcome, "actioned", "label chain: listener outcome actioned");
      // unrelated label → no fire
      const r2 = await eng.matchAndRunEvent({ ...m, event_label: "OTHER" } as never, "label_added");
      eq(r2.status, "no_match", "label chain: ติด label อื่น → flow ไม่ยิง (binding filter)");
    }

    // unassign + set_ticket_field + randomizer + button_template e2e
    {
      const V = "wv_misc";
      await wfs.deleteMany({});
      await wfs.insertOne({
        workflow_id: "wf_misc", name: "misc", enabled: true, status: "published",
        trigger_frequency: "every_time", current_version_id: V,
        import: { source: "zaapi", source_workflow_id: "WF-x" },
        shop_ids: [], platforms: [], priority: 0,
        nodes: [
          { node_id: "t", type: "trigger", subtype: "message_received", config: {}, position: { x: 0, y: 0 } },
          { node_id: "stf", type: "action", subtype: "set_ticket_field", config: { action: { setTicketField: { value: true } } }, position: { x: 1, y: 0 } },
          { node_id: "ua", type: "action", subtype: "unassign_ticket", config: {}, position: { x: 2, y: 0 } },
          { node_id: "bt", type: "action", subtype: "send_button_template",
            config: { action: { buttonTemplate: { title: "เลือก", buttons: [{ title: "A" }, { title: "B" }], expiresIn: { unit: "minutes", value: 1 } } } }, position: { x: 3, y: 0 } },
          { node_id: "ra", type: "wait", subtype: "randomizer",
            config: { randomizer: { paths: [{ weight: 100 }, { weight: 0 }] } }, position: { x: 4, y: 0 } },
          { node_id: "pa", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "chose A" } } }, position: { x: 5, y: 0 } },
          { node_id: "pb", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "chose B" } } }, position: { x: 6, y: 0 } },
          { node_id: "r0", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "rnd path0" } } }, position: { x: 7, y: 0 } },
          { node_id: "r1", type: "action", subtype: "send_message", config: { action: { message: { type: "text", text: "rnd path1" } } }, position: { x: 8, y: 0 } },
        ],
        edges: [
          { edge_id: "e1", source_node_id: "t", target_node_id: "stf" },
          { edge_id: "e2", source_node_id: "stf", target_node_id: "ua" },
          { edge_id: "e3", source_node_id: "ua", target_node_id: "bt" },
          { edge_id: "e4", source_node_id: "bt", target_node_id: "pa", branch: "btn-template-condition-index-0" },
          { edge_id: "e5", source_node_id: "bt", target_node_id: "pb", branch: "btn-template-condition-index-1" },
          { edge_id: "e6", source_node_id: "pa", target_node_id: "ra" },
          { edge_id: "e7", source_node_id: "ra", target_node_id: "r0", branch: "randomizer-path-0" },
          { edge_id: "e8", source_node_id: "ra", target_node_id: "r1", branch: "randomizer-path-1" },
        ],
      });
      await binds.insertOne({ binding_id: "bf", workflow_id: "wf_misc", version_id: V, node_id: "stf",
        field_path: "action.setTicketField.ticketFieldId", kind: "ticket_field", count: 1, source_values: ["x"],
        status: "resolved", resolution: { mappings: [{ local_id: "is_order_chat", state: "valid" }] } } as never);
      await convs.insertOne({ conversation_id: "cv_x1", platform: "shopee", shop_id: "s1", labels: [] });
      await statuses.insertOne({ conversation_id: "cv_x1", status: "open", assigned_to: "adm_x" });
      const m = { conversation_id: "cv_x1", shop_id: "s1", platform: "shopee", config_shop_key: "s1", text: "hi" };
      const r1 = await eng.matchAndRun(m as never);
      eq(r1.status, "actioned", "misc: parks at button template");
      const convA = await convs.findOne({ conversation_id: "cv_x1" }) as { ticket_fields?: Record<string, unknown> } | null;
      eq(convA?.ticket_fields?.is_order_chat, true, "set_ticket_field: bound field written");
      const st = await statuses.findOne({ conversation_id: "cv_x1" }) as { assigned_to?: string | null } | null;
      eq(st?.assigned_to, null, "unassign: assigned_to cleared");
      // reply "A" → button index 0 → chose A → randomizer → rnd path0
      const r2 = await eng.runInboundWorkflowStage({ ...m, text: "A" } as never);
      if (r2.status !== "resumed") console.log("DBG misc resume:", JSON.stringify(r2).slice(0, 400));
      eq(r2.status, "resumed", "misc: reply resumes");
      const del = (r2.delivered || []) as { text?: string }[];
      ok(del.some((d) => d.text === "chose A"), "button: reply 'A' → index-0 edge");
      ok(del.some((d) => d.text === "rnd path0"), "randomizer: weight 100 → path-0");
      ok(!del.some((d) => d.text === "chose B"), "button: ไม่ไป edge B");
    }

    // send_message image → image_url passthrough (flow 08 requirement)
    {
      const V = "wv_img";
      await wfs.deleteMany({}); // กัน workflow ก่อนหน้า match trigger ก่อน
      await wfs.insertOne({
        workflow_id: "wf_img", name: "img", enabled: true, status: "published",
        trigger_frequency: "every_time", current_version_id: V,
        import: { source: "zaapi", source_workflow_id: "WF-i" },
        shop_ids: [], platforms: [], priority: 0,
        nodes: [
          { node_id: "t", type: "trigger", subtype: "message_received", config: {}, position: { x: 0, y: 0 } },
          { node_id: "im", type: "action", subtype: "send_message",
            config: { action: { message: { type: "image", imageUrl: "https://cdn.example.com/p.png" } } }, position: { x: 1, y: 0 } },
        ],
        edges: [{ edge_id: "e1", source_node_id: "t", target_node_id: "im" }],
      });
      const m = { conversation_id: "cv_i1", shop_id: "s1", platform: "shopee", config_shop_key: "s1", text: "hi" };
      const r = await eng.matchAndRun(m as never);
      eq(r.status, "actioned", "img: image send_message ไม่ throw");
      const d0 = (r.delivered || [])[0] as { image_url?: string } | undefined;
      eq(d0?.image_url, "https://cdn.example.com/p.png", "img: image_url passthrough");
      // image ไม่มี imageUrl → fail-closed
      await wfs.updateOne({ workflow_id: "wf_img" } as never, {
        $set: { "nodes.1.config.action.message.imageUrl": "" } } as never);
      let threw = false;
      try { await eng.matchAndRun({ ...m, conversation_id: "cv_i2" } as never); } catch { threw = true; }
      ok(threw, "img: image ไม่มี URL → fail closed (throw)");
    }
  }

  // ─── 20. Flow 05 e2e — ตอบปกติ 24 ชม. Round Robin V2 (graph จริง 48 nodes) ──
  //   เดิน graph จริงจาก corpus: trigger → add_label → label cond(contains_all)
  //   → message_content → assignee → chatbot park → escalate/timeout
  //   → business_hours → wfr → event_time → unassign/assign/close
  //   pin event_time schedules เพื่อ determinism (within=24/7, outside={})
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const { readFileSync } = await import("node:fs");
    const graph = JSON.parse(readFileSync(
      new URL("./fixtures/flow05-graph.json", import.meta.url), "utf8")) as {
      name?: string;
      nodes: { node_id: string; type: string; subtype?: string; config: Record<string, unknown> }[];
      edges: unknown[];
    };
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const shops = await mongo.getCollection(COLLECTIONS.shops);
    const admins = await mongo.getCollection(COLLECTIONS.admins);
    const convs = await mongo.getCollection(COLLECTIONS.conversations);
    const msgs = await mongo.getCollection(COLLECTIONS.messages);
    const status = await mongo.getCollection(COLLECTIONS.statusConversation);
    const cfg = await mongo.getCollection(COLLECTIONS.systemConfigs);
    const cursors = await mongo.getCollection(COLLECTIONS.assignmentCursors);
    await Promise.all([wfs, runs, binds, shops, admins, convs, msgs, status, cfg, cursors]
      .map((c) => c.deleteMany({}) as Promise<unknown>));

    const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const ALLDAY = Object.fromEntries(DAYS.map((d) => [d, [{ start: 0, end: 1440 }]]));
    const pinEventTime = (id: string, within: boolean) => {
      const n = graph.nodes.find((x) => x.node_id === id);
      (n!.config as { schedule?: unknown }).schedule = within ? ALLDAY : {};
    };
    pinEventTime("zn_c30m56", true);   // หลัง wfr-success → chatbot2 path
    pinEventTime("zn_19keuaq", true);  // หลัง escalate/no-respond → wfr2 path

    const V = "wv_f05";
    await wfs.insertOne({
      workflow_id: "wf_f05", name: graph.name || "f05", enabled: true, status: "published",
      trigger_frequency: "every_time", current_version_id: V,
      import: { source: "zaapi", source_workflow_id: "WF-f05" },
      shop_ids: [], platforms: [], priority: 0,
      nodes: graph.nodes, edges: graph.edges,
    } as never);
    const bind = (binding_id: string, node_id: string, field_path: string, kind: string, locals: string[]) =>
      ({ binding_id, workflow_id: "wf_f05", version_id: V, node_id, field_path, kind,
        count: locals.length, source_values: locals.map((_, i) => `za_${i}`),
        status: "resolved", resolution: { mappings: locals.map((l) => ({ local_id: l, state: "valid" })) } });
    await binds.insertMany([
      bind("b_acc", "zn_139xla7", "accountIds", "account", ["s1"]),
      bind("b_l0", "zn_1t4w21f", "conditions[0].labelIds", "label", ["LBL_A"]),
      bind("b_l1", "zn_1t4w21f", "conditions[1].labelIds", "label", ["LBL_B"]),
      bind("b_l2", "zn_1t4w21f", "conditions[2].labelIds", "label", ["LBL_C"]),
      bind("b_u0", "zn_qqajw6", "conditions[0].assigneeUserId", "user", ["adm_x"]),
      bind("b_u1", "zn_qqajw6", "conditions[1].assigneeUserId", "user", ["adm_y"]),
      bind("b_u2", "zn_qqajw6", "conditions[2].assigneeUserId", "user", ["adm_z"]),
      bind("b_sale", "zn_k15uxi", "action.label.labelIds", "label", ["SALE_TAG"]),
      bind("b_in1", "zn_15h6tm0", "action.label.labelIds", "label", ["TAG_IN1"]),
      bind("b_in2", "zn_yiaqdl", "action.label.labelIds", "label", ["TAG_IN2"]),
      bind("b_ooh1", "zn_wqwh08", "action.label.labelIds", "label", ["TAG_OOH1"]),
      bind("b_ooh2", "zn_nxmriv", "action.label.labelIds", "label", ["TAG_OOH2"]),
      bind("b_rm1", "zn_1997mfb", "action.label.labelIds", "label", ["STALE_TAG"]),
      bind("b_rm2", "zn_qurb41", "action.label.labelIds", "label", ["STALE_TAG"]),
      bind("b_rm3", "zn_8tw7ai", "action.label.labelIds", "label", ["STALE_TAG"]),
      bind("b_t1", "zn_1y5st52", "action.assignment.teamIds", "team", ["all_admins"]),
      bind("b_t2", "zn_xg675b", "action.assignment.teamIds", "team", ["all_admins"]),
      bind("b_t3", "zn_uk6fxu", "action.assignment.teamIds", "team", ["all_admins"]),
    ] as never[]);
    await shops.insertOne({
      shop_id: "s1", shopname: "shop1", platform: "shopee",
      business_hours: { timezone: "Asia/Bangkok", schedule: ALLDAY },
    });
    await admins.insertMany([
      { admin_id: "adm_a", role: "admin", active: true },
      { admin_id: "adm_b", role: "admin", active: true },
    ] as never[]);
    await cfg.updateOne({ config_key: "main_config" } as never,
      { $set: { config_key: "main_config", workflow_enabled: true } }, { upsert: true });

    const mkConv = async (cid: string, labels: string[] = [], assigned: string | null = null) => {
      await convs.insertOne({ conversation_id: cid, platform: "shopee", shop_id: "s1", labels } as never);
      await status.insertOne({ conversation_id: cid, status: "open", assigned_to: assigned } as never);
    };
    const mkMsg = (cid: string, text = "สวัสดีครับ") =>
      ({ conversation_id: cid, shop_id: "s1", platform: "shopee", config_shop_key: "s1", text }) as never;

    // A) ลูกค้าใหม่ไม่มีแท็ก/keyword → no-match chain → chatbot1 park (ai_bot)
    await mkConv("cv5a");
    const rA = await eng.matchAndRun(mkMsg("cv5a"));
    eq(rA.status, "actioned", "f05-A: inbound → walk → chatbot park");
    const runA = await runs.findOne({ conversation_id: "cv5a" }) as { park_kind?: string } | null;
    eq(runA?.park_kind, "ai_bot", "f05-A: park_kind ai_bot (AI เป็นเจ้าของ conv)");
    const convA = await convs.findOne({ conversation_id: "cv5a" }) as { labels?: string[] } | null;
    ok(!!convA?.labels?.includes("SALE_TAG"), "f05-A: add_label Sale ติดจริง");
    // oncePerOpen — ข้อความที่สอง episode เดียวกัน → run ใหม่ไม่ถูกสร้าง + park คงอยู่
    await eng.matchAndRun(mkMsg("cv5a", "อีกข้อความ"));
    eq(await runs.countDocuments({ conversation_id: "cv5a" }), 1, "f05-A: oncePerOpen — ไม่มี run ที่สอง");
    // escalate → business_hours(24/7=within) → TAG_IN chain → send12 → unassign → assign6
    const rA2 = await eng.escalateAiRun("cv5a", mkMsg("cv5a"));
    eq(rA2.status, "resumed", "f05-A: escalate resumes");
    const runA2 = await runs.findOne({ conversation_id: "cv5a" }) as { status?: string; outcome?: string } | null;
    eq(runA2?.status, "completed", "f05-A: escalate → assign path → completed");
    const stA = await status.findOne({ conversation_id: "cv5a" }) as { assigned_to?: string } | null;
    eq(stA?.assigned_to, "adm_a", "f05-A: assign6 (team=all_admins) → adm_a");
    const convA2 = await convs.findOne({ conversation_id: "cv5a" }) as { labels?: string[] } | null;
    ok(!!convA2?.labels?.includes("TAG_IN1") && !!convA2?.labels?.includes("TAG_IN2"), "f05-A: OOH→in-hours labels ติดครบ");

    // B) AI timeout → send10 → close_ticket
    await mkConv("cv5b");
    await eng.matchAndRun(mkMsg("cv5b"));
    const runB = await runs.findOne({ conversation_id: "cv5b" }) as never;
    const rB = await eng.resumeTimerRun(runB, mkMsg("cv5b"));
    eq(rB.status, "resumed", "f05-B: chatbot timeout resumes");
    const runB2 = await runs.findOne({ conversation_id: "cv5b" }) as { status?: string } | null;
    eq(runB2?.status, "completed", "f05-B: timeout → close → completed");
    const stB = await status.findOne({ conversation_id: "cv5b" }) as { status?: string } | null;
    eq(stB?.status, "closed", "f05-B: close_ticket → status closed");

    // C) นอกเวลา → OOH chain → wfr1 park → reply → event_time within → chatbot2 → escalate → assign3
    await shops.updateOne({ shop_id: "s1" } as never, { $set: { "business_hours.schedule": {} } });
    await mkConv("cv5c");
    await eng.matchAndRun(mkMsg("cv5c"));
    await eng.escalateAiRun("cv5c", mkMsg("cv5c"));
    const runC = await runs.findOne({ conversation_id: "cv5c" }) as { status?: string } | null;
    eq(runC?.status, "waiting_for_reply", "f05-C: OOH → send9 → wfr1 park");
    const convC = await convs.findOne({ conversation_id: "cv5c" }) as { labels?: string[] } | null;
    ok(!!convC?.labels?.includes("TAG_OOH1") && !!convC?.labels?.includes("TAG_OOH2"), "f05-C: OOH labels ติดครบ");
    const rC2 = await eng.runInboundWorkflowStage(mkMsg("cv5c", "ตอบกลับ"));
    eq(rC2.status, "resumed", "f05-C: reply → wfr-success resume");
    const runC2 = await runs.findOne({ conversation_id: "cv5c" }) as { status?: string; park_kind?: string } | null;
    eq(runC2?.park_kind, "ai_bot", "f05-C: wfr-success → event_time within → chatbot2 park");
    // ร้านเข้าเวลาทำการแล้ว (escalate เกิดเช้าวันถัดไป) — assignWhenAllOoh:false
    //   + ร้าน OOH → assign ถูก skip ตาม semantics Zaapi (จับได้จริงตอนเขียน e2e)
    await shops.updateOne({ shop_id: "s1" } as never, { $set: { "business_hours.schedule": ALLDAY } });
    const rC3 = await eng.escalateAiRun("cv5c", mkMsg("cv5c"));
    eq(rC3.status, "resumed", "f05-C: chatbot2 escalate resumes");
    const stC = await status.findOne({ conversation_id: "cv5c" }) as { assigned_to?: string } | null;
    eq(stC?.assigned_to, "adm_a", "f05-C: escalate → assign3 → adm_a (cursor ใหม่ของ node)");

    // D) wfr1 หมดเวลา → wfr-no-respond → jump11 → event_time2 within → wfr2 → reply → assign3
    await shops.updateOne({ shop_id: "s1" } as never, { $set: { "business_hours.schedule": {} } });
    await mkConv("cv5d");
    await eng.matchAndRun(mkMsg("cv5d"));
    await eng.escalateAiRun("cv5d", mkMsg("cv5d"));
    const runD = await runs.findOne({ conversation_id: "cv5d" }) as never;
    const rD = await eng.resumeTimerRun(runD, mkMsg("cv5d"));
    eq(rD.status, "resumed", "f05-D: wfr1 expire resumes");
    const runD2 = await runs.findOne({ conversation_id: "cv5d" }) as { status?: string } | null;
    eq(runD2?.status, "waiting_for_reply", "f05-D: no-respond → event_time2 → wfr2 park");
    await shops.updateOne({ shop_id: "s1" } as never, { $set: { "business_hours.schedule": ALLDAY } });
    const rD2 = await eng.runInboundWorkflowStage(mkMsg("cv5d", "ตอบรอบสอง"));
    eq(rD2.status, "resumed", "f05-D: wfr2 reply resumes");
    const stD = await status.findOne({ conversation_id: "cv5d" }) as { assigned_to?: string } | null;
    eq(stD?.assigned_to, "adm_b", "f05-D: wfr2-success → send6 → assign3 → adm_b (round-robin หมุน)");

    // E) label contains_all branch + last_interaction + remove_label + jump_to
    await shops.updateOne({ shop_id: "s1" } as never, { $set: { "business_hours.schedule": ALLDAY } });
    // E1: มี LBL_A + STALE → branch-0 → interaction 2h>1h → remove_label → jump6 → chatbot1
    await mkConv("cv5e", ["LBL_A", "STALE_TAG"]);
    await msgs.insertOne({ conversation_id: "cv5e", direction: "in",
      created_timestamp: new Date(Date.now() - 2 * 3600_000) } as never);
    await eng.matchAndRun(mkMsg("cv5e"));
    const runE1 = await runs.findOne({ conversation_id: "cv5e" }) as { park_kind?: string } | null;
    eq(runE1?.park_kind, "ai_bot", "f05-E1: label branch-0 → remove_label → jump → chatbot park");
    const convE1 = await convs.findOne({ conversation_id: "cv5e" }) as { labels?: string[] } | null;
    ok(!convE1?.labels?.includes("STALE_TAG") && !!convE1?.labels?.includes("LBL_A"),
      "f05-E1: remove_label ลบ STALE คง LBL_A");
    // E2: LBL_B + interaction 30m<1h → branch-1 → no-match → jump4 → chatbot1
    await mkConv("cv5f", ["LBL_B"]);
    await msgs.insertOne({ conversation_id: "cv5f", direction: "in",
      created_timestamp: new Date(Date.now() - 30 * 60_000) } as never);
    await eng.matchAndRun(mkMsg("cv5f"));
    const runE2 = await runs.findOne({ conversation_id: "cv5f" }) as { park_kind?: string } | null;
    eq(runE2?.park_kind, "ai_bot", "f05-E2: label branch-1 → no-match → jump4 → chatbot park");
    // E3: keyword "สินค้ามีปัญหา" → message_content index-0 → jump2 → bh within → assign6
    await mkConv("cv5g");
    const rE3 = await eng.matchAndRun(mkMsg("cv5g", "สินค้ามีปัญหา"));
    eq(rE3.status, "actioned", "f05-E3: keyword → jump2 → bh → assign path");
    const stE3 = await status.findOne({ conversation_id: "cv5g" }) as { assigned_to?: string } | null;
    ok(stE3?.assigned_to === "adm_a" || stE3?.assigned_to === "adm_b",
      "f05-E3: assign6 → round-robin admin");
    // E4: assignee match — assigned_to=adm_x (bound) → unassign2 → jump9 → chatbot1
    await mkConv("cv5h", [], "adm_x");
    await eng.matchAndRun(mkMsg("cv5h"));
    const runE4 = await runs.findOne({ conversation_id: "cv5h" }) as { park_kind?: string } | null;
    eq(runE4?.park_kind, "ai_bot", "f05-E4: assignee match → unassign → jump9 → chatbot park");
    const stE4 = await status.findOne({ conversation_id: "cv5h" }) as { assigned_to?: string | null } | null;
    eq(stE4?.assigned_to, null, "f05-E4: unassign2 ล้าง assigned_to ก่อน park");
  }

  // ─── 21. e2e per-flow เดิน graph จริง: 07/08/09/10-14/15/16/17/18/20 ──
  //   fixtures จาก version docs จริง (scripts/fixtures/flowNN-graph.json)
  {
    const eng = await import("../src/backend/service/workflowEngine");
    const { readFileSync } = await import("node:fs");
    const wfs = await mongo.getCollection(COLLECTIONS.workflows);
    const runs = await mongo.getCollection(COLLECTIONS.workflowRuns);
    const binds = await mongo.getCollection(COLLECTIONS.workflowBindings);
    const shops = await mongo.getCollection(COLLECTIONS.shops);
    const admins = await mongo.getCollection(COLLECTIONS.admins);
    const convs = await mongo.getCollection(COLLECTIONS.conversations);
    const msgs = await mongo.getCollection(COLLECTIONS.messages);
    const status = await mongo.getCollection(COLLECTIONS.statusConversation);
    const cfg = await mongo.getCollection(COLLECTIONS.systemConfigs);
    const cursors = await mongo.getCollection(COLLECTIONS.assignmentCursors);
    await Promise.all([wfs, runs, binds, shops, admins, convs, msgs, status, cfg, cursors]
      .map((c) => c.deleteMany({}) as Promise<unknown>));
    const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const ALLDAY = Object.fromEntries(DAYS.map((d) => [d, [{ start: 0, end: 1440 }]]));
    await shops.insertOne({ shop_id: "s1", shopname: "shop1", platform: "shopee",
      business_hours: { timezone: "Asia/Bangkok", schedule: ALLDAY } });
    await admins.insertMany([
      { admin_id: "adm_a", role: "admin", active: true },
      { admin_id: "adm_b", role: "admin", active: true },
    ] as never[]);
    await cfg.updateOne({ config_key: "main_config" } as never,
      { $set: { config_key: "main_config", workflow_enabled: true } }, { upsert: true });

    const loadGraph = (k: string) => JSON.parse(readFileSync(
      new URL(`./fixtures/flow${k}-graph.json`, import.meta.url), "utf8")) as {
      name?: string;
      nodes: { node_id: string; type: string; subtype?: string; config: Record<string, unknown> }[];
      edges: unknown[];
    };
    // ⚡ matchAndRun เลือก workflow แรกที่ enabled+match — ต้องเหลือตัวเดียวตอนเทส
    //   (เจอจริง: flow ที่ insert ก่อนหน้า intercept inbound ของตัวที่เทสอยู่)
    const only = async (keepIds: string[]) =>
      wfs.updateMany({ workflow_id: { $nin: keepIds } } as never, { $set: { enabled: false } } as never);
    const insertFlow = async (wfId: string, g: ReturnType<typeof loadGraph>) => {
      const V = `wv_${wfId}`;
      await wfs.insertOne({
        workflow_id: wfId, name: g.name || wfId, enabled: true, status: "published",
        trigger_frequency: "every_time", current_version_id: V,
        import: { source: "zaapi", source_workflow_id: `WF-${wfId}` },
        shop_ids: [], platforms: [], priority: 0,
        nodes: g.nodes, edges: g.edges,
      } as never);
      return V;
    };
    const bind = (wfId: string, V: string, node_id: string, field_path: string, kind: string, locals: string[]) =>
      ({ binding_id: `b_${wfId}_${node_id}_${field_path}`, workflow_id: wfId, version_id: V, node_id,
        field_path, kind, count: locals.length, source_values: locals.map((_, i) => `za_${i}`),
        status: "resolved", resolution: { mappings: locals.map((l) => ({ local_id: l, state: "valid" })) } });
    const mkConv = async (cid: string, labels: string[] = [], assigned: string | null = null) => {
      await convs.insertOne({ conversation_id: cid, platform: "shopee", shop_id: "s1", labels } as never);
      await status.insertOne({ conversation_id: cid, status: "open", assigned_to: assigned } as never);
    };
    const mkMsg = (cid: string, text = "hi") =>
      ({ conversation_id: cid, shop_id: "s1", platform: "shopee", config_shop_key: "s1", text }) as never;
    const del = (r: { delivered?: unknown[] }) => (r.delivered || []) as { text?: string; image_url?: string }[];

    // ── f18 เตือนลูกค้ารอเกิน 10 นาที: trigger → delay 10m → waiting>9m → add_label ──
    {
      const V = await insertFlow("wf_f18", loadGraph("18"));
      await binds.insertMany([
        bind("wf_f18", V, "zn_7kzz50", "accountIds", "account", ["s1"]),
        bind("wf_f18", V, "zn_9ilyqu", "action.label.labelIds", "label", ["WAIT_TAG"]),
      ] as never[]);
      await only(["wf_f18"]);
      const scope = { config: { workflow_enabled: true },
        pairs: [{ platform: "shopee", shop_id: "s1", config_shop_key: "s1", shopname: "s", cutoff: new Date(0) }],
        global_enabled_since: null } as never;
      // รอ 15m > 9m → tag ติด
      await mkConv("cv18a");
      await msgs.insertOne({ conversation_id: "cv18a", direction: "in",
        created_timestamp: new Date(Date.now() - 15 * 60_000) } as never);
      const r = await eng.matchAndRun(mkMsg("cv18a"));
      eq(r.status, "actioned", "f18: inbound → delay park");
      await runs.updateOne({ conversation_id: "cv18a" } as never, { $set: { resume_at: new Date(Date.now() - 1000) } });
      const sw = await eng.sweepDueTimerRuns(undefined, scope, new Date());
      eq(sw.resumed, 1, "f18: sweep resume หลัง delay 10m");
      const c18 = await convs.findOne({ conversation_id: "cv18a" }) as { labels?: string[] } | null;
      ok(!!c18?.labels?.includes("WAIT_TAG"), "f18: waiting>9m → add_label");
      // รอ 5m < 9m → condition fail → จบเงียบๆ ไม่ tag
      await mkConv("cv18b");
      await msgs.insertOne({ conversation_id: "cv18b", direction: "in",
        created_timestamp: new Date(Date.now() - 5 * 60_000) } as never);
      await eng.matchAndRun(mkMsg("cv18b"));
      await runs.updateOne({ conversation_id: "cv18b" } as never, { $set: { resume_at: new Date(Date.now() - 1000) } });
      await eng.sweepDueTimerRuns(undefined, scope, new Date());
      const c18b = await convs.findOne({ conversation_id: "cv18b" }) as { labels?: string[] } | null;
      ok(!c18b?.labels?.includes("WAIT_TAG"), "f18: waiting<9m → ไม่ tag");
    }

    // ── f20 ข้อความนอกเวลา tiktok: trigger oncePerOpen → add_label ──
    {
      const V = await insertFlow("wf_f20", loadGraph("20"));
      await binds.insertMany([
        bind("wf_f20", V, "zn_syraci", "accountIds", "account", ["s1"]),
        bind("wf_f20", V, "zn_sbtoq3", "action.label.labelIds", "label", ["OOH_TAG"]),
      ] as never[]);
      await only(["wf_f20"]);
      await mkConv("cv20a");
      const r = await eng.matchAndRun(mkMsg("cv20a"));
      eq(r.status, "actioned", "f20: inbound → add_label");
      const c20 = await convs.findOne({ conversation_id: "cv20a" }) as { labels?: string[] } | null;
      ok(!!c20?.labels?.includes("OOH_TAG"), "f20: tag ติด");
      const r2 = await eng.matchAndRun(mkMsg("cv20a"));
      eq(r2.status, "no_match", "f20: oncePerOpen — ข้อความ 2 ไม่ run ซ้ำ");
    }

    // ── f16 เคลม/ของเสีย: label gate(no-match) → keyword → add → send → assign ──
    {
      const V = await insertFlow("wf_f16", loadGraph("16"));
      await binds.insertMany([
        bind("wf_f16", V, "zn_wgpjz9", "accountIds", "account", ["s1"]),
        bind("wf_f16", V, "zn_106noak", "conditions[0].labelIds", "label", ["CLAIM_DONE"]),
        bind("wf_f16", V, "zn_qm1xyu", "action.label.labelIds", "label", ["CLAIM_DONE"]),
        bind("wf_f16", V, "zn_ubhkzl", "action.assignment.teamIds", "team", ["all_admins"]),
      ] as never[]);
      await only(["wf_f16"]);
      // keyword เคลม + ยังไม่มี tag → add → send → assign (assignWhenAllOoh:true → assign ได้เสมอ)
      await mkConv("cv16a");
      const r = await eng.matchAndRun(mkMsg("cv16a", "ขอเคลมสินค้าหน่อยครับ"));
      eq(r.status, "actioned", "f16: claim keyword → run");
      const c16 = await convs.findOne({ conversation_id: "cv16a" }) as { labels?: string[] } | null;
      ok(!!c16?.labels?.includes("CLAIM_DONE"), "f16: add_label CLAIM_DONE");
      const st16 = await status.findOne({ conversation_id: "cv16a" }) as { assigned_to?: string } | null;
      ok(st16?.assigned_to === "adm_a" || st16?.assigned_to === "adm_b", "f16: ต้องถึงมือคนเสมอ → assigned");
      // มี tag แล้ว → cond-0 dead end → ไม่ทำซ้ำ
      await mkConv("cv16b", ["CLAIM_DONE"]);
      await eng.matchAndRun(mkMsg("cv16b", "ขอเคลมอีก"));
      const st16b = await status.findOne({ conversation_id: "cv16b" }) as { assigned_to?: string | null } | null;
      eq(st16b?.assigned_to, null, "f16: มี CLAIM_DONE แล้ว → ไม่ assign ซ้ำ");
    }

    // ── f17 ปัญหาการใช้งาน รอบสอง: keyword → label contains_all → add→send→assign→remove / no-match→add ──
    {
      const V = await insertFlow("wf_f17", loadGraph("17"));
      await binds.insertMany([
        bind("wf_f17", V, "zn_1lisx21", "accountIds", "account", ["s1"]),
        bind("wf_f17", V, "zn_1ni8cq3", "conditions[0].labelIds", "label", ["SECOND_ROUND"]),
        bind("wf_f17", V, "zn_1pehdml", "action.label.labelIds", "label", ["FWD_TAG"]),
        bind("wf_f17", V, "zn_18ckz43", "action.label.labelIds", "label", ["FIRST_TAG"]),
        bind("wf_f17", V, "zn_bfcejv", "action.label.labelIds", "label", ["SECOND_ROUND"]),
        bind("wf_f17", V, "zn_yyv2iu", "action.assignment.teamIds", "team", ["all_admins"]),
      ] as never[]);
      await only(["wf_f17"]);
      // keyword + มี SECOND_ROUND → ส่งต่อคน: add FWD → send → assign → remove SECOND_ROUND
      await mkConv("cv17a", ["SECOND_ROUND"]);
      const r = await eng.matchAndRun(mkMsg("cv17a", "ของใช้ไม่ได้เลยครับ"));
      eq(r.status, "actioned", "f17: keyword + second-round label → forward path");
      const c17 = await convs.findOne({ conversation_id: "cv17a" }) as { labels?: string[] } | null;
      ok(!!c17?.labels?.includes("FWD_TAG") && !c17?.labels?.includes("SECOND_ROUND"),
        "f17: add FWD_TAG + remove SECOND_ROUND");
      const st17 = await status.findOne({ conversation_id: "cv17a" }) as { assigned_to?: string } | null;
      ok(!!st17?.assigned_to, "f17: assign → admin");
      // keyword แต่ไม่มี SECOND_ROUND → add FIRST_TAG เท่านั้น (ไม่ assign)
      await mkConv("cv17b");
      await eng.matchAndRun(mkMsg("cv17b", "ของพังครับ"));
      const c17b = await convs.findOne({ conversation_id: "cv17b" }) as { labels?: string[] } | null;
      ok(!!c17b?.labels?.includes("FIRST_TAG"), "f17: รอบแรก → add FIRST_TAG");
      const st17b = await status.findOne({ conversation_id: "cv17b" }) as { assigned_to?: string | null } | null;
      eq(st17b?.assigned_to, null, "f17: รอบแรก → ไม่ assign");
    }

    // ── f07 เก็บคะแนน iSUPER: does_not_contain_any_of gate → score 5/4/3/2,1 → thanks/apology+assign ──
    {
      const V = await insertFlow("wf_f07", loadGraph("07"));
      await binds.insertMany([
        bind("wf_f07", V, "zn_b1w3xv", "accountIds", "account", ["s1"]),
        bind("wf_f07", V, "zn_1k1d8j0", "conditions[0].labelIds", "label", ["RATED_DONE"]),
        bind("wf_f07", V, "zn_nywnzo", "action.label.labelIds", "label", ["SCORE_5"]),
        bind("wf_f07", V, "zn_tlt4tj", "action.label.labelIds", "label", ["SCORE_4"]),
        bind("wf_f07", V, "zn_dzd1g0", "action.label.labelIds", "label", ["SCORE_3"]),
        bind("wf_f07", V, "zn_1ygbo0q", "action.label.labelIds", "label", ["SCORE_LOW"]),
        bind("wf_f07", V, "zn_1s5wu56", "action.label.labelIds", "label", ["RATED_PENDING"]),
        bind("wf_f07", V, "zn_wpoau2", "action.label.labelIds", "label", ["RATED_PENDING"]),
        bind("wf_f07", V, "zn_1o7wuwv", "action.assignment.teamIds", "team", ["all_admins"]),
      ] as never[]);
      await only(["wf_f07"]);
      // score 5 → add SCORE_5 → remove RATED_PENDING → send thanks (ไม่ assign)
      await mkConv("cv7a");
      const r = await eng.matchAndRun(mkMsg("cv7a", "5"));
      eq(r.status, "actioned", "f07: score 5 → thanks path");
      const c7 = await convs.findOne({ conversation_id: "cv7a" }) as { labels?: string[] } | null;
      ok(!!c7?.labels?.includes("SCORE_5"), "f07: add SCORE_5");
      const st7 = await status.findOne({ conversation_id: "cv7a" }) as { assigned_to?: string | null } | null;
      eq(st7?.assigned_to, null, "f07: คะแนนสูง → ไม่ assign");
      // score 1 → apology + assign (ต้องถึงมือคน)
      await mkConv("cv7b");
      await eng.matchAndRun(mkMsg("cv7b", "1"));
      const st7b = await status.findOne({ conversation_id: "cv7b" }) as { assigned_to?: string } | null;
      ok(!!st7b?.assigned_to, "f07: score ต่ำ → apology + assign");
      // gate: conv มี RATED_DONE → does_not_contain_any_of false → dead end
      await mkConv("cv7c", ["RATED_DONE"]);
      const r7c = await eng.matchAndRun(mkMsg("cv7c", "5"));
      const run7c = await runs.findOne({ conversation_id: "cv7c" }) as { status?: string; outcome?: string } | null;
      ok(r7c.status === "actioned" || r7c.status === "no_match" || run7c?.status === "completed",
        "f07: RATED_DONE gate → ไม่ score ซ้ำ");
      const st7c = await status.findOne({ conversation_id: "cv7c" }) as { assigned_to?: string | null } | null;
      eq(st7c?.assigned_to, null, "f07: gate → ไม่ assign");
    }

    // ── f09 ประเมินแอดมิน 2: contains_all gate → score contains_one_of → thanks/apology+assign ──
    {
      const V = await insertFlow("wf_f09", loadGraph("09"));
      await binds.insertMany([
        bind("wf_f09", V, "zn_r4b9m6", "accountIds", "account", ["s1"]),
        bind("wf_f09", V, "zn_uki2po", "conditions[0].labelIds", "label", ["RATE_REQ"]),
        bind("wf_f09", V, "zn_1d0t1yk", "action.label.labelIds", "label", ["G5"]),
        bind("wf_f09", V, "zn_13yme6t", "action.label.labelIds", "label", ["G4"]),
        bind("wf_f09", V, "zn_1n7p4r0", "action.label.labelIds", "label", ["G3"]),
        bind("wf_f09", V, "zn_i7ylyg", "action.label.labelIds", "label", ["G_LOW"]),
        bind("wf_f09", V, "zn_1mtl6pj", "action.label.labelIds", "label", ["RATE_REQ"]),
        bind("wf_f09", V, "zn_13j05c0", "action.label.labelIds", "label", ["RATE_REQ"]),
        bind("wf_f09", V, "zn_1rrix76", "action.assignment.teamIds", "team", ["all_admins"]),
      ] as never[]);
      await only(["wf_f09"]);
      await mkConv("cv9a", ["RATE_REQ"]);
      const r = await eng.matchAndRun(mkMsg("cv9a", "4"));
      eq(r.status, "actioned", "f09: score 4 → thanks path");
      const c9 = await convs.findOne({ conversation_id: "cv9a" }) as { labels?: string[] } | null;
      ok(!!c9?.labels?.includes("G4") && !c9?.labels?.includes("RATE_REQ"),
        "f09: add G4 + remove RATE_REQ");
      await mkConv("cv9b", ["RATE_REQ"]);
      await eng.matchAndRun(mkMsg("cv9b", "1"));
      const st9 = await status.findOne({ conversation_id: "cv9b" }) as { assigned_to?: string } | null;
      ok(!!st9?.assigned_to, "f09: score ต่ำ → apology + assign");
      // ไม่มี RATE_REQ → gate no-match → dead end
      await mkConv("cv9c");
      await eng.matchAndRun(mkMsg("cv9c", "5"));
      const c9c = await convs.findOne({ conversation_id: "cv9c" }) as { labels?: string[] } | null;
      ok(!c9c?.labels?.includes("G5"), "f09: ไม่มี RATE_REQ → ไม่ score");
    }

    // ── f10-14 ประเมินแอดมิน 1X: label_added → send survey → add → remove ──
    {
      const KEYS = ["10", "11", "12", "13", "14"] as const;
      const LABELS: Record<string, { trig: string; add: string; rm: string }> = {
        "10": { trig: "RATE_AI", add: "SENT_AI", rm: "REQ_AI" },
        "11": { trig: "RATE_BOY", add: "SENT_BOY", rm: "REQ_BOY" },
        "12": { trig: "RATE_MOO", add: "SENT_MOO", rm: "REQ_MOO" },
        "13": { trig: "RATE_BANK", add: "SENT_BANK", rm: "REQ_BANK" },
        "14": { trig: "RATE_BONUS", add: "SENT_BONUS", rm: "REQ_BONUS" },
      };
      for (const k of KEYS) {
        const V = await insertFlow(`wf_f${k}`, loadGraph(k));
        const g = loadGraph(k);
        const trig = g.nodes.find((n) => n.type === "trigger")!.node_id;
        const addN = g.nodes.find((n) => n.subtype === "add_label")!.node_id;
        const rmN = g.nodes.find((n) => n.subtype === "remove_label")!.node_id;
        await binds.insertMany([
          bind(`wf_f${k}`, V, trig, "labelIds", "label", [LABELS[k].trig]),
          bind(`wf_f${k}`, V, addN, "action.label.labelIds", "label", [LABELS[k].add]),
          bind(`wf_f${k}`, V, rmN, "action.label.labelIds", "label", [LABELS[k].rm]),
        ] as never[]);
      }
      await only(KEYS.map((k) => `wf_f${k}`));
      // แต่ละ flow: ติด trigger label → survey ส่ง + add/remove ตาม graph จริง
      for (const k of KEYS) {
        const L = LABELS[k];
        const cid = `cv${k}x`;
        await mkConv(cid, [L.trig, L.rm]);
        const r = await eng.matchAndRunEvent(
          { conversation_id: cid, shop_id: "s1", platform: "shopee", config_shop_key: "s1", event_label: L.trig } as never,
          "label_added");
        eq(r.status, "actioned", `f${k}: label_added(${L.trig}) → run`);
        const cx = await convs.findOne({ conversation_id: cid }) as { labels?: string[] } | null;
        ok(!!cx?.labels?.includes(L.add) && !cx?.labels?.includes(L.rm),
          `f${k}: add ${L.add} + remove ${L.rm}`);
      }
      // label อื่นที่ไม่ได้ bind → ไม่มี flow ไหนยิง
      const rN = await eng.matchAndRunEvent(
        { conversation_id: "cv_none", shop_id: "s1", platform: "shopee", config_shop_key: "s1", event_label: "UNRELATED" } as never,
        "label_added");
      eq(rN.status, "no_match", "f10-14: label ที่ไม่ได้ bind → ไม่ยิง");
    }

    // ── f08 LINE รับเรื่องปัญหาสินค้า: last_interaction → buttons → AI/assign ──
    {
      const g = loadGraph("08");
      // image send nodes — corpus มี imageUrl จริง (redacted ใน dump) → ใส่คืนเพื่อเดิน graph
      for (const n of g.nodes) {
        if (n.subtype === "send_message" && (n.config as { action?: { message?: { type?: string } } })
          .action?.message?.type === "image") {
          (n.config as { action: { message: { imageUrl?: string } } }).action.message.imageUrl = "https://img.example.com/x.png";
        }
      }
      const V = await insertFlow("wf_f08", g);
      await binds.insertMany([
        bind("wf_f08", V, "zn_qdziq3", "accountIds", "account", ["s1"]),
        bind("wf_f08", V, "zn_1rhp1qh", "action.label.labelIds", "label", ["PROBLEM_TAG"]),
        bind("wf_f08", V, "zn_12hx8e1", "action.assignment.teamIds", "team", ["all_admins"]),
        bind("wf_f08", V, "zn_1pmgxxr", "action.assignment.teamIds", "team", ["all_admins"]),
        bind("wf_f08", V, "zn_wt11f2", "action.assignment.teamIds", "team", ["all_admins"]),
      ] as never[]);
      await only(["wf_f08"]);
      // A) fresh — interaction 30m <2h → no-match → jump → assign2 (assignWhenAllOoh:true)
      await mkConv("cv8a");
      await msgs.insertOne({ conversation_id: "cv8a", direction: "in",
        created_timestamp: new Date(Date.now() - 30 * 60_000) } as never);
      const r8a = await eng.matchAndRun(mkMsg("cv8a"));
      eq(r8a.status, "actioned", "f08-A: fresh → no-match → jump → assign");
      const st8a = await status.findOne({ conversation_id: "cv8a" }) as { assigned_to?: string } | null;
      ok(!!st8a?.assigned_to, "f08-A: assign2 → admin");
      // B) returning — interaction 3h >2h → send → delay 15s → button1 → กดปุ่ม → image → button2 → assign3
      await mkConv("cv8b");
      await msgs.insertOne({ conversation_id: "cv8b", direction: "in",
        created_timestamp: new Date(Date.now() - 3 * 3600_000) } as never);
      const r8b = await eng.matchAndRun(mkMsg("cv8b"));
      eq(r8b.status, "actioned", "f08-B: returning → delay park");
      const runB = await runs.findOne({ conversation_id: "cv8b" }) as never;
      const rB2 = await eng.resumeTimerRun(runB, mkMsg("cv8b"));
      eq(rB2.status, "resumed", "f08-B: delay → button template send");
      const runB2 = await runs.findOne({ conversation_id: "cv8b" }) as { status?: string; park_kind?: string } | null;
      ok(runB2?.status === "waiting_for_reply" || runB2?.park_kind === "wait_buttons",
        "f08-B: park รอกดปุ่ม (button template)");
      // ลูกค้ากดปุ่มแรก "แจ้งปัญหา" → index-0 → add_label → send+image → button2
      const rB3 = await eng.runInboundWorkflowStage(mkMsg("cv8b", "แจ้งปัญหา"));
      eq(rB3.status, "resumed", "f08-B: กดปุ่ม 1 resume");
      ok(del(rB3).some((d) => d.image_url === "https://img.example.com/x.png"), "f08-B: image send หลังเลือกปัญหา");
      const runB3 = await runs.findOne({ conversation_id: "cv8b" }) as { park_kind?: string; status?: string } | null;
      ok(runB3?.status === "waiting_for_reply" || runB3?.park_kind === "wait_buttons", "f08-B: park รอ button2");
      const c8b = await convs.findOne({ conversation_id: "cv8b" }) as { labels?: string[] } | null;
      ok(!!c8b?.labels?.includes("PROBLEM_TAG"), "f08-B: add_label หลังกดปุ่ม");
      // เลือกสินค้า "หัวชาร์จและสายชาร์จ" → send วิธีถ่ายคลิป → assign3
      const rB4 = await eng.runInboundWorkflowStage(mkMsg("cv8b", "หัวชาร์จและสายชาร์จ"));
      eq(rB4.status, "resumed", "f08-B: เลือกสินค้า resume");
      const st8b = await status.findOne({ conversation_id: "cv8b" }) as { assigned_to?: string } | null;
      ok(!!st8b?.assigned_to, "f08-B: เลือกสินค้า → assign3 → admin");
      // C) none-selected → chatbot park → escalate → assign4 / timeout → close
      await mkConv("cv8c");
      await msgs.insertOne({ conversation_id: "cv8c", direction: "in",
        created_timestamp: new Date(Date.now() - 3 * 3600_000) } as never);
      await eng.matchAndRun(mkMsg("cv8c"));
      const runC = await runs.findOne({ conversation_id: "cv8c" }) as never;
      await eng.resumeTimerRun(runC, mkMsg("cv8c"));
      // ตอบข้อความที่ไม่ตรงปุ่มไหนเลย → none-selected → chatbot park
      const rC2 = await eng.runInboundWorkflowStage(mkMsg("cv8c", "ข้อความอื่นไม่เกี่ยว"));
      eq(rC2.status, "resumed", "f08-C: none-selected resume");
      const runC2 = await runs.findOne({ conversation_id: "cv8c" }) as { park_kind?: string } | null;
      eq(runC2?.park_kind, "ai_bot", "f08-C: none-selected → chatbot park");
      const rC3 = await eng.escalateAiRun("cv8c", mkMsg("cv8c"));
      eq(rC3.status, "resumed", "f08-C: AI escalate → assign4");
      const st8c = await status.findOne({ conversation_id: "cv8c" }) as { assigned_to?: string } | null;
      ok(!!st8c?.assigned_to, "f08-C: escalate → assign4");
      // D) button หมดเวลา → expired → jump → assign1
      await mkConv("cv8d");
      await msgs.insertOne({ conversation_id: "cv8d", direction: "in",
        created_timestamp: new Date(Date.now() - 3 * 3600_000) } as never);
      await eng.matchAndRun(mkMsg("cv8d"));
      const runD = await runs.findOne({ conversation_id: "cv8d" }) as never;
      await eng.resumeTimerRun(runD, mkMsg("cv8d")); // → button1 park
      const runD2 = await runs.findOne({ conversation_id: "cv8d" }) as never;
      const rD = await eng.resumeTimerRun(runD2, mkMsg("cv8d")); // expire buttons
      eq(rD.status, "resumed", "f08-D: button expired resume");
      const st8d = await status.findOne({ conversation_id: "cv8d" }) as { assigned_to?: string } | null;
      ok(!!st8d?.assigned_to, "f08-D: expired → jump → assign1");
      // E) chatbot timeout → close (อีก conv — park ที่ ai แล้ว expire)
      await mkConv("cv8e");
      await msgs.insertOne({ conversation_id: "cv8e", direction: "in",
        created_timestamp: new Date(Date.now() - 3 * 3600_000) } as never);
      await eng.matchAndRun(mkMsg("cv8e"));
      const runE = await runs.findOne({ conversation_id: "cv8e" }) as never;
      await eng.resumeTimerRun(runE, mkMsg("cv8e"));
      await eng.runInboundWorkflowStage(mkMsg("cv8e", "ไม่ตรงปุ่ม"));
      const runE2 = await runs.findOne({ conversation_id: "cv8e" }) as never;
      await eng.resumeTimerRun(runE2, mkMsg("cv8e")); // ai timeout
      const st8e = await status.findOne({ conversation_id: "cv8e" }) as { status?: string } | null;
      eq(st8e?.status, "closed", "f08-E: ai timeout → close_ticket");
    }

    // ── f15 ตอบปกติ ทั้งทีม ฉบับปรับปรุง (36 nodes — ครอบคลุมเดียวกับ f05 ลบ assignee/event_time) ──
    {
      const V = await insertFlow("wf_f15", loadGraph("15"));
      await binds.insertMany([
        bind("wf_f15", V, "zn_1upqj8", "accountIds", "account", ["s1"]),
        bind("wf_f15", V, "zn_aunvsq", "conditions[0].labelIds", "label", ["LBL_A"]),
        bind("wf_f15", V, "zn_aunvsq", "conditions[1].labelIds", "label", ["LBL_B"]),
        bind("wf_f15", V, "zn_aunvsq", "conditions[2].labelIds", "label", ["LBL_C"]),
        bind("wf_f15", V, "zn_3z4ysy", "action.label.labelIds", "label", ["ENTRY_TAG"]),
        bind("wf_f15", V, "zn_9pfsqq", "action.label.labelIds", "label", ["IN1"]),
        bind("wf_f15", V, "zn_1a671pq", "action.label.labelIds", "label", ["IN2"]),
        bind("wf_f15", V, "zn_lk36pu", "action.label.labelIds", "label", ["OOH1"]),
        bind("wf_f15", V, "zn_1ukcplp", "action.label.labelIds", "label", ["OOH2"]),
        bind("wf_f15", V, "zn_x5uoy7", "action.label.labelIds", "label", ["STALE"]),
        bind("wf_f15", V, "zn_ajrrpp", "action.label.labelIds", "label", ["STALE"]),
        bind("wf_f15", V, "zn_1h81jdd", "action.label.labelIds", "label", ["STALE"]),
        bind("wf_f15", V, "zn_6rmwx", "action.assignment.teamIds", "team", ["all_admins"]),
        bind("wf_f15", V, "zn_f2k8i3", "action.assignment.teamIds", "team", ["all_admins"]),
      ] as never[]);
      await only(["wf_f15"]);
      // A) no labels + plain text → label no-match → content no-match → chatbot1 →
      //    escalate → bh within → IN labels → send → unassign → assign1 (assignWhenAllOoh:true)
      await mkConv("cv15a");
      await eng.matchAndRun(mkMsg("cv15a"));
      const runA = await runs.findOne({ conversation_id: "cv15a" }) as { park_kind?: string } | null;
      eq(runA?.park_kind, "ai_bot", "f15-A: no-match chain → chatbot1 park");
      const rA = await eng.escalateAiRun("cv15a", mkMsg("cv15a"));
      eq(rA.status, "resumed", "f15-A: escalate resumes");
      const stA = await status.findOne({ conversation_id: "cv15a" }) as { assigned_to?: string } | null;
      ok(!!stA?.assigned_to, "f15-A: within → unassign → assign1");
      const cA = await convs.findOne({ conversation_id: "cv15a" }) as { labels?: string[] } | null;
      ok(!!cA?.labels?.includes("ENTRY_TAG") && !!cA?.labels?.includes("IN1") && !!cA?.labels?.includes("IN2"),
        "f15-A: ENTRY + IN labels ครบ");
      // B) AI timeout → send → close
      await mkConv("cv15b");
      await eng.matchAndRun(mkMsg("cv15b"));
      const runB = await runs.findOne({ conversation_id: "cv15b" }) as never;
      await eng.resumeTimerRun(runB, mkMsg("cv15b"));
      const stB = await status.findOne({ conversation_id: "cv15b" }) as { status?: string } | null;
      eq(stB?.status, "closed", "f15-B: ai timeout → close");
      // C) OOH → escalate → outside → OOH labels → send → wfr → reply → chatbot2 → escalate → assign1
      await shops.updateOne({ shop_id: "s1" } as never, { $set: { "business_hours.schedule": {} } });
      await mkConv("cv15c");
      await eng.matchAndRun(mkMsg("cv15c"));
      await eng.escalateAiRun("cv15c", mkMsg("cv15c"));
      const runC = await runs.findOne({ conversation_id: "cv15c" }) as { status?: string } | null;
      eq(runC?.status, "waiting_for_reply", "f15-C: OOH → wfr park");
      const rC = await eng.runInboundWorkflowStage(mkMsg("cv15c", "ตอบกลับ"));
      eq(rC.status, "resumed", "f15-C: wfr-success resume → chatbot2");
      const runC2 = await runs.findOne({ conversation_id: "cv15c" }) as { park_kind?: string } | null;
      eq(runC2?.park_kind, "ai_bot", "f15-C: chatbot2 park");
      await eng.escalateAiRun("cv15c", mkMsg("cv15c"));
      const stC = await status.findOne({ conversation_id: "cv15c" }) as { assigned_to?: string } | null;
      ok(!!stC?.assigned_to, "f15-C: chatbot2 escalate → jump → assign1");
      // D) wfr no-respond → jump → unassign → assign1
      await mkConv("cv15d");
      await eng.matchAndRun(mkMsg("cv15d"));
      await eng.escalateAiRun("cv15d", mkMsg("cv15d"));
      const runD = await runs.findOne({ conversation_id: "cv15d" }) as never;
      await eng.resumeTimerRun(runD, mkMsg("cv15d"));
      const stD = await status.findOne({ conversation_id: "cv15d" }) as { assigned_to?: string } | null;
      ok(!!stD?.assigned_to, "f15-D: wfr no-respond → jump → assign1");
      // E) LBL_A + interaction 8d>7d → branch-0 → remove STALE → jump → chatbot1
      await shops.updateOne({ shop_id: "s1" } as never, { $set: { "business_hours.schedule": ALLDAY } });
      await mkConv("cv15e", ["LBL_A", "STALE"]);
      await msgs.insertOne({ conversation_id: "cv15e", direction: "in",
        created_timestamp: new Date(Date.now() - 8 * 24 * 3600_000) } as never);
      await eng.matchAndRun(mkMsg("cv15e"));
      const runE = await runs.findOne({ conversation_id: "cv15e" }) as { park_kind?: string } | null;
      eq(runE?.park_kind, "ai_bot", "f15-E: branch-0 → remove → jump → chatbot1");
      const cE = await convs.findOne({ conversation_id: "cv15e" }) as { labels?: string[] } | null;
      ok(!cE?.labels?.includes("STALE"), "f15-E: remove_label STALE");
    }
  }
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
