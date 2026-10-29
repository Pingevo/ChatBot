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
    await runs.insertOne({ run_id: "r_old", workflow_id: "wf_o1", conversation_id: "cv_o1", status: "completed", created_at: new Date() });
    const r1 = await ce.canonicalTriggerMatches(trig({ triggerOncePerConversation: true }), m2 as never, "wf_o1", "wv_o1");
    eq(r1, false, "oncePerConversation + run เดิม → ไม่ match");
    const r1b = await ce.canonicalTriggerMatches(trig({ triggerOncePerConversation: true }), { ...m2, conversation_id: "cv_o2" } as never, "wf_o1", "wv_o1");
    eq(r1b, true, "oncePerConversation + conv ใหม่ → match");
    // once_per_open: close → run หลัง close นับเป็น episode ใหม่
    const closeAt = new Date(Date.now() - 60_000);
    await closeHist.insertOne({ conversation_id: "cv_o1", closed_at: closeAt });
    // r_old (created now > closeAt) อยู่ใน episode ปัจจุบัน → block อยู่แล้ว;
    //   ลบออกแล้วเหลือเฉพาะ run ก่อน close → episode ใหม่ว่าง → match
    await runs.updateOne({ run_id: "r_old" } as never, { $set: { created_at: new Date(closeAt.getTime() - 60_000) } });
    await runs.insertOne({ run_id: "r_ep2", workflow_id: "wf_o1", conversation_id: "cv_o1", status: "completed", created_at: new Date(closeAt.getTime() + 1000) });
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
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
