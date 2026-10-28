// test-workflow-binding-resolution.ts — RED tests: saveBindingResolutionBatch direct-resolution contract
//
// รัน: npx tsx scripts/test-workflow-binding-resolution.ts
//
// ทุก test บน fake Mongo (module-boundary mocks — hooks.mjs) ไม่มี Mongo/network/env จริง
//
// Contract ที่ assert:
//   owner อยู่บน workflowService เท่านั้น · strict-shape + forbidden keys → typed
//   reject + zero writes + zero audit · stale pointer/version → conflict · binding
//   นอก version scope → reject · typed switch: account/label/user resolvable,
//   team/ticket_field/url unresolvable · partial coverage → reject · happy path →
//   immutable version + version-scoped resolved bindings (server-computed source_fp,
//   via:"direct") + pointer+scope CAS เดียว + audit หลัง commit · crash →
//   deterministic artifacts retry ได้ · orphan ไม่เป็น current · concurrent same
//   expected_version → winner เดียว · Task 2: repeat:true → exact-equality
//   same-kind sibling expansion (via:"repeat" + repeated[] + merge fail-closed)

import { register } from "node:module";
register(new URL("./test-workflow-persistence-hooks.mjs", import.meta.url));

import { createHash } from "node:crypto";

type Mocks = typeof import("./test-workflow-persistence-mocks.mjs");
type Svc = typeof import("../src/backend/service/workflowService");
type Imp = typeof import("../src/lib/workflow/zaapiImport");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}
function eq<T>(a: T, b: T, name: string) { ok(a === b, `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`); }

// ─── Fixture: Zaapi-shaped flow — ทุก binding kind ที่ resolution contract ครอบคลุม ───
//   account(×2 values) · label · user · team · ticket_field · url
const SRC_BIND = {
  loadedVersionId: "wv-src-X",
  versions: [{ workflowVersionId: "wv-src-X", status: "active" }],
  nodes: [
    { id: "t1", type: "message_received", position: { x: 0, y: 0 },
      data: { name: "trig", nodeType: "trigger", accountIds: ["zacc_1", "zacc_2"], nextStepId: "c1" } },
    { id: "c1", type: "label", position: { x: 100, y: 0 },
      data: { name: "cond", nodeType: "condition",
              conditions: [{ labelIds: ["zlab_1"], nextStepId: "a1" }], noMatchNextStepId: "a2" } },
    { id: "a1", type: "chat_assign", position: { x: 200, y: 0 },
      data: { name: "assign", nodeType: "action",
              action: { assignment: { teamIds: ["zteam_1"], userIds: ["zusr_1"] } } } },
    { id: "a2", type: "set_ticket_field", position: { x: 300, y: 0 },
      data: { name: "tick", nodeType: "action",
              action: { setTicketField: { ticketFieldId: "ztf_1" } },
              imageUrl: "https://img.example.com/x.png?token=sekret-br" } },
  ],
  edges: [
    { source: "t1", target: "c1", sourceHandle: null },
    { source: "c1", target: "a1", sourceHandle: "condition-index-0" },
    { source: "c1", target: "a2", sourceHandle: "no-match" },
  ],
};

const FORBIDDEN_KEYS = ["node_id", "field_path", "kind", "source_value", "source_fp", "source_values", "requirement_fp", "display_value", "sources"];

// ─── Fixture: repeat-expansion siblings (Task 2) — trigger เดียว, bindings กระจาย ───
//   A1[zacc_1,zacc_2] · A2[zacc_1,zacc_9] partial sibling · A3[zacc_2] full sibling
//   A4 near-miss [ZACC_1, " zacc_1 ", zacc_12, 1] — ไม่มี exact match เลย
//   L1[zlab_1] · L2[zlab_1,"zacc_1"] — index0 label-match / index1 = account VALUE
//   ใน kind label (cross-kind trap) · U1[zusr_1,zusr_5] · U2[zusr_1] full sibling
//   T1[zteam_1] (unresolvable)
const SRC_REPEAT = {
  loadedVersionId: "wv-src-R",
  versions: [{ workflowVersionId: "wv-src-R", status: "active" }],
  nodes: [
    { id: "t1", type: "message_received", position: { x: 0, y: 0 },
      data: { name: "trig", nodeType: "trigger", accountIds: ["zacc_1", "zacc_2"], nextStepId: "c1" } },
    { id: "c1", type: "label", position: { x: 100, y: 0 },
      data: { name: "cond1", nodeType: "condition",
              conditions: [{ labelIds: ["zlab_1"], nextStepId: "c2" }], noMatchNextStepId: "a1" } },
    { id: "c2", type: "label", position: { x: 200, y: 0 },
      data: { name: "cond2", nodeType: "condition",
              conditions: [{ labelIds: ["zlab_1", "zacc_1"], nextStepId: "a1" }], noMatchNextStepId: "a2" } },
    { id: "a1", type: "chat_assign", position: { x: 300, y: 0 },
      data: { name: "assign", nodeType: "action",
              action: { assignment: { teamIds: ["zteam_1"], userIds: ["zusr_1", "zusr_5"] } },
              accountIds: ["zacc_1", "zacc_9"], nextStepId: "a3" } },
    { id: "a2", type: "chat_unassign", position: { x: 400, y: 0 },
      data: { name: "unassign", nodeType: "action",
              action: { userIds: ["zusr_1"], accountIds: ["zacc_2"] } } },
    { id: "a3", type: "send_message", position: { x: 500, y: 0 },
      data: { name: "reply", nodeType: "action",
              action: { accountIds: ["ZACC_1", " zacc_1 ", "zacc_12", 1] } } },
  ],
  edges: [
    { source: "t1", target: "c1", sourceHandle: null },
    { source: "c1", target: "c2", sourceHandle: "condition-index-0" },
    { source: "c1", target: "a1", sourceHandle: "no-match" },
    { source: "c2", target: "a1", sourceHandle: "condition-index-0" },
    { source: "c2", target: "a2", sourceHandle: "no-match" },
    { source: "a1", target: "a3", sourceHandle: null },
  ],
};

// ─── Fixture: zero account-kind requirements (Task 3) — label + user เท่านั้น ───
const SRC_NOACC = {
  loadedVersionId: "wv-src-N",
  versions: [{ workflowVersionId: "wv-src-N", status: "active" }],
  nodes: [
    { id: "t1", type: "message_received", position: { x: 0, y: 0 },
      data: { name: "trig", nodeType: "trigger", nextStepId: "c1" } },
    { id: "c1", type: "label", position: { x: 100, y: 0 },
      data: { name: "cond", nodeType: "condition",
              conditions: [{ labelIds: ["zlab_1"], nextStepId: "a1" }], noMatchNextStepId: "a2" } },
    { id: "a1", type: "chat_assign", position: { x: 200, y: 0 },
      data: { name: "assign", nodeType: "action",
              action: { assignment: { userIds: ["zusr_1"] } } } },
    { id: "a2", type: "send_message", position: { x: 300, y: 0 },
      data: { name: "reply", nodeType: "action",
              action: { message: { text: "hi" } } } },
  ],
  edges: [
    { source: "t1", target: "c1", sourceHandle: null },
    { source: "c1", target: "a1", sourceHandle: "condition-index-0" },
    { source: "c1", target: "a2", sourceHandle: "no-match" },
  ],
};

// ─── Fixture: overlap-ready imported flow (Task 5) — message_received + accountIds×1 ───
const SRC_OV = {
  loadedVersionId: "wv-src-OV",
  versions: [{ workflowVersionId: "wv-src-OV", status: "active" }],
  nodes: [
    { id: "t1", type: "message_received", position: { x: 0, y: 0 },
      data: { name: "trig", nodeType: "trigger", accountIds: ["zacc_o"], nextStepId: "a1" } },
    { id: "a1", type: "send_message", position: { x: 100, y: 0 },
      data: { name: "reply", nodeType: "action", action: { message: { text: "hi" } } } },
  ],
  edges: [
    { source: "t1", target: "a1", sourceHandle: null },
  ],
};

// label_added trigger — account scope มีแต่ไม่ใช่ message trigger → ไม่มี overlap eligibility
const SRC_OV_LAB = {
  loadedVersionId: "wv-src-OVL",
  versions: [{ workflowVersionId: "wv-src-OVL", status: "active" }],
  nodes: [
    { id: "t1", type: "label_added", position: { x: 0, y: 0 },
      data: { name: "trig", nodeType: "trigger", nextStepId: "a1" } },
    { id: "a1", type: "send_message", position: { x: 100, y: 0 },
      data: { name: "reply", nodeType: "action", action: { message: { text: "hi" } },
              accountIds: ["zacc_ol"] } },
  ],
  edges: [
    { source: "t1", target: "a1", sourceHandle: null },
  ],
};

async function main() {
  const mocks: Mocks = await import("./test-workflow-persistence-mocks.mjs");
  const imp: Imp = await import("../src/lib/workflow/zaapiImport");
  const svc: Svc = await import("../src/backend/service/workflowService");
  const { previewZaapiFlows, canonicalJson } = imp;
  const { state, mongo, COLLECTIONS } = mocks;
  const svcAny = svc as unknown as Record<string, (...a: any[]) => unknown>;
  const st = state as Record<string, unknown> & {
    insertOneHook?: (c: string, d?: unknown) => Promise<void>;
    updateOneHook?: (c: string, f?: unknown, u?: unknown) => Promise<void>;
  };

  const _sh = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h.toString(36); };
  const fp256 = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
  const act = async (fn: () => unknown) => { try { await fn(); return null; } catch (e) { return (e as Error).message; } };
  const sorted = (a: unknown) => JSON.stringify([...(Array.isArray(a) ? a : [])].sort());

  async function collDocs(name: string): Promise<Record<string, unknown>[]> {
    return (await (await mongo.getCollection(name)).find({}).toArray()) as Record<string, unknown>[];
  }
  async function allCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const c of Object.values(COLLECTIONS)) out[c] = await (await mongo.getCollection(c)).countDocuments({});
    return out;
  }
  const counters: Record<string, number> = {};
  function armInsertFail(coll: string, n: number) {
    for (const k of Object.keys(counters)) delete counters[k];
    st.insertOneHook = async (c: string) => {
      counters[c] = (counters[c] ?? 0) + 1;
      if (c === coll && counters[c] === n) throw new Error(`injected insert failure @${coll}#${n}`);
    };
  }
  function armUpdateFail(coll: string, n: number) {
    for (const k of Object.keys(counters)) delete counters[k];
    st.updateOneHook = async (c: string) => {
      counters[c] = (counters[c] ?? 0) + 1;
      if (c === coll && counters[c] === n) throw new Error(`injected update failure @${coll}#${n}`);
    };
  }
  function disarm() { st.insertOneHook = undefined; st.updateOneHook = undefined; }

  // ─── local identity fixtures (validation-read targets) ───
  await (await mongo.getCollection(COLLECTIONS.shops)).insertOne({ shop_id: "shop_s1", platform: "shopee", shopname: "S1", connected: true });
  await (await mongo.getCollection(COLLECTIONS.shops)).insertOne({ shop_id: "shop_s2", platform: "tiktok", shopname: "S2", connected: true });
  await (await mongo.getCollection(COLLECTIONS.conversations)).insertOne({ conversation_id: "conv_lab", labels: ["vip", "gold"] });
  await (await mongo.getCollection(COLLECTIONS.admins)).insertOne({ admin_id: "adm_u1", role: "agent", active: true });
  await (await mongo.getCollection(COLLECTIONS.admins)).insertOne({ admin_id: "adm_u2", role: "agent", active: true });
  await (await mongo.getCollection(COLLECTIONS.admins)).insertOne({ admin_id: "adm_off", role: "agent", active: false });

  type Fx = Awaited<ReturnType<typeof setupImported>>;
  async function setupImported(srcWfId: string) {
    const src = { ...SRC_BIND, workflowId: srcWfId,
      loadedVersionId: `wv-src-${srcWfId}`, versions: [{ workflowVersionId: `wv-src-${srcWfId}`, status: "active" }] };
    const batch = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: srcWfId, name: `bind ${srcWfId}` }] });
    await svcAny.applyImportBatch(batch, "admin_t");
    const wfId = "wf_imp_" + _sh(srcWfId);
    const wfDoc = (await svc.getWorkflow(wfId)) as Record<string, unknown>;
    const verDoc = (await collDocs(COLLECTIONS.workflowVersions))
      .find((v) => v.workflow_id === wfId && v.version_id === wfDoc.current_version_id) as Record<string, unknown>;
    const binds = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === wfId && b.version_id === verDoc.version_id);
    const byKind = (k: string) => binds.find((b) => b.kind === k) as Record<string, unknown>;
    // valid direct-resolution request — account×2 + label + user, team/ticket_field/url คง unresolved
    const req = () => ({
      workflow_id: wfId,
      expected_version: wfDoc.version,
      version_id: verDoc.version_id,
      proposed: [
        { binding_id: byKind("account").binding_id, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] },
        { binding_id: byKind("label").binding_id, mappings: [ { source_index: 0, local_id: "vip" } ] },
        { binding_id: byKind("user").binding_id, mappings: [ { source_index: 0, local_id: "adm_u1" } ] },
      ],
    });
    return { wfId, wfDoc, verDoc, binds, byKind, req };
  }

  async function setupRepeat(srcWfId: string) {
    const src = { ...SRC_REPEAT, workflowId: srcWfId,
      loadedVersionId: `wv-src-${srcWfId}`, versions: [{ workflowVersionId: `wv-src-${srcWfId}`, status: "active" }] };
    const batch = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: srcWfId, name: `repeat ${srcWfId}` }] });
    await svcAny.applyImportBatch(batch, "admin_t");
    const wfId = "wf_imp_" + _sh(srcWfId);
    const wfDoc = (await svc.getWorkflow(wfId)) as Record<string, unknown>;
    const verDoc = (await collDocs(COLLECTIONS.workflowVersions))
      .find((v) => v.workflow_id === wfId && v.version_id === wfDoc.current_version_id) as Record<string, unknown>;
    const binds = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === wfId && b.version_id === verDoc.version_id);
    // sibling selectors — exact source_values identity (assert ด้วยค่าจริง ไม่ใช่ index)
    const byVals = (kind: string, vals: unknown[], pool = binds) => pool.find((b) => b.kind === kind
      && canonicalJson(b.source_values) === canonicalJson(vals)) as Record<string, unknown>;
    const bA1 = (pool = binds) => byVals("account", ["zacc_1", "zacc_2"], pool);
    const bA2 = (pool = binds) => byVals("account", ["zacc_1", "zacc_9"], pool);
    const bA3 = (pool = binds) => byVals("account", ["zacc_2"], pool);
    const bA4 = (pool = binds) => pool.find((b) => b.kind === "account"
      && (b.source_values as unknown[]).includes("zacc_12")) as Record<string, unknown>;
    const bL1 = (pool = binds) => byVals("label", ["zlab_1"], pool);
    const bL2 = (pool = binds) => byVals("label", ["zlab_1", "zacc_1"], pool);
    const bU1 = (pool = binds) => byVals("user", ["zusr_1", "zusr_5"], pool);
    const bU2 = (pool = binds) => byVals("user", ["zusr_1"], pool);
    const bT1 = (pool = binds) => byVals("team", ["zteam_1"], pool);
    // request หลัก — ทุก proposal repeat:true (expansion ทุก sibling ที่ exact-match)
    const req = () => ({
      workflow_id: wfId,
      expected_version: wfDoc.version,
      version_id: verDoc.version_id,
      proposed: [
        { binding_id: bA1().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] },
        { binding_id: bL1().binding_id, repeat: true, mappings: [ { source_index: 0, local_id: "vip" } ] },
        { binding_id: bU1().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "adm_u1" }, { source_index: 1, local_id: "adm_u2" } ] },
      ],
    });
    const versionBinds = async (versionId: unknown) =>
      (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === versionId);
    const mapsOf = (b: Record<string, unknown> | undefined) =>
      (((b?.resolution as { mappings?: Record<string, unknown>[] })?.mappings) ?? [])
        .slice().sort((x, y) => (x.source_index as number) - (y.source_index as number));
    return { wfId, wfDoc, verDoc, binds, bA1, bA2, bA3, bA4, bL1, bL2, bU1, bU2, bT1, req, versionBinds, mapsOf };
  }

  // no-account fixture (Task 3) — bindings = label + user เท่านั้น
  async function setupNoAcc(srcWfId: string) {
    const src = { ...SRC_NOACC, workflowId: srcWfId,
      loadedVersionId: `wv-src-${srcWfId}`, versions: [{ workflowVersionId: `wv-src-${srcWfId}`, status: "active" }] };
    const batch = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: srcWfId, name: `noacc ${srcWfId}` }] });
    await svcAny.applyImportBatch(batch, "admin_t");
    const wfId = "wf_imp_" + _sh(srcWfId);
    const wfDoc = (await svc.getWorkflow(wfId)) as Record<string, unknown>;
    const verDoc = (await collDocs(COLLECTIONS.workflowVersions))
      .find((v) => v.workflow_id === wfId && v.version_id === wfDoc.current_version_id) as Record<string, unknown>;
    const binds = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === wfId && b.version_id === verDoc.version_id);
    const byKind = (k: string) => binds.find((b) => b.kind === k) as Record<string, unknown>;
    const req = () => ({
      workflow_id: wfId,
      expected_version: wfDoc.version,
      version_id: verDoc.version_id,
      proposed: [
        { binding_id: byKind("label").binding_id, mappings: [ { source_index: 0, local_id: "vip" } ] },
        { binding_id: byKind("user").binding_id, mappings: [ { source_index: 0, local_id: "adm_u1" } ] },
      ],
    });
    return { wfId, wfDoc, verDoc, binds, byKind, req };
  }

  async function callResolve(wfId: string, req: unknown): Promise<Record<string, unknown> | undefined> {
    const fn = svcAny.saveBindingResolutionBatch;
    if (typeof fn !== "function") return undefined; // RED — owner absent
    try { return await fn(wfId, req, "admin_t") as Record<string, unknown>; }
    catch (e) { return { __thrown: (e as Error).message }; }
  }
  function resolveEvents() { return state.adminEvents.filter((e) => (e as { action_type?: string }).action_type === "workflow.binding_resolve"); }

  // ทุก rejection case: typed reject + zero artifact writes + zero audit + pointer/scope byte-identical
  async function expectReject(name: string, wfId: string, req: unknown, check?: (res: Record<string, unknown>) => void) {
    const counts0 = await allCounts();
    const ev0 = state.adminEvents.length;
    const wf0 = canonicalJson(await svc.getWorkflow(wfId));
    const res = await callResolve(wfId, req);
    ok(res != null && res.ok === false
      && (typeof res.validation === "string" || res.conflict === true || res.not_found === true),
      `${name} → typed reject (${JSON.stringify(res)?.slice(0, 140)})`);
    if (res != null && res.ok === false && check) check(res);
    eq(canonicalJson(await allCounts()), canonicalJson(counts0), `${name} → zero artifact writes`);
    eq(state.adminEvents.length, ev0, `${name} → zero audit events`);
    eq(canonicalJson(await svc.getWorkflow(wfId)), wf0, `${name} → pointer+scope byte-identical`);
    return res;
  }

  const A = await setupImported("workflow_BIND_A");
  const B = await setupImported("workflow_BIND_B");

  // ═══ 1. owner presence + contract-unreachable probe ═══
  console.log("\n=== 1. Owner presence + contract-unreachable probe ===");
  ok(typeof svcAny.saveBindingResolutionBatch === "function", "saveBindingResolutionBatch exists on workflowService owner");

  // inert/stale call — absent owner หรือ typed reject ต้องเขียนอะไรไม่ได้เลย
  const preAbsent = await allCounts();
  const evAbsent = state.adminEvents.length;
  await callResolve(A.wfId, { ...A.req(), expected_version: 999 });
  eq(canonicalJson(await allCounts()), canonicalJson(preAbsent), "inert/rejected call → zero new docs");
  eq(state.adminEvents.length, evAbsent, "inert/rejected call → zero audit events");

  // existing CAS path ไม่มีทางผลิต resolution contract — carried bindings ยัง unresolved
  await svcAny.saveWorkflowDraft(B.wfId, { name: "cas-probe" }, B.wfDoc.version as number, "admin_t");
  const bV2 = (await collDocs(COLLECTIONS.workflowVersions))
    .find((v) => v.workflow_id === B.wfId && v.version_id !== B.verDoc.version_id) as Record<string, unknown>;
  const bV2binds = (await collDocs(COLLECTIONS.workflowBindings))
    .filter((b) => b.workflow_id === B.wfId && b.version_id === bV2.version_id);
  ok(bV2binds.length > 0 && bV2binds.every((b) => b.status === "unresolved" && b.resolution == null),
    "existing CAS path → carried bindings stay unresolved (resolution contract unmet)");
  eq(resolveEvents().length, 0, "no existing surface emits workflow.binding_resolve");

  // ═══ 2. validation matrix — ทุก reject = zero writes + zero audit + pointer/scope unchanged ═══
  console.log("\n=== 2. Validation matrix ===");

  await expectReject("stale expected_version", A.wfId, { ...A.req(), expected_version: 99 },
    (r) => { eq(r.conflict, true, "stale expected_version → conflict flag"); eq(r.current_version, A.wfDoc.version, "conflict echoes current_version"); });
  await expectReject("stale version_id", A.wfId, { ...A.req(), version_id: "wv_bogus_stale" },
    (r) => { eq(r.conflict, true, "stale version_id → conflict flag"); eq(r.current_version_id, A.verDoc.version_id, "conflict echoes current_version_id"); });
  await expectReject("route/body workflow_id mismatch", A.wfId, { ...A.req(), workflow_id: "wf_other_route_mismatch" });
  await expectReject("binding from another workflow", A.wfId,
    { ...A.req(), proposed: [{ binding_id: B.byKind("account").binding_id, mappings: [{ source_index: 0, local_id: "x" }] }] });
  await expectReject("binding from another version", B.wfId,
    { workflow_id: B.wfId, expected_version: 2, version_id: bV2.version_id,
      proposed: [{ binding_id: B.byKind("account").binding_id, mappings: [{ source_index: 0, local_id: "x" }] }] });
  await expectReject("source_index out of bounds", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("account").binding_id, mappings: [
      { source_index: 5, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] }] });
  await expectReject("duplicate binding_id", A.wfId,
    { ...A.req(), proposed: [...A.req().proposed, A.req().proposed[0]] });
  await expectReject("duplicate (binding_id, source_index)", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
      { source_index: 0, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });

  for (const k of FORBIDDEN_KEYS) {
    await expectReject(`forbidden key "${k}" (proposal)`, A.wfId,
      { ...A.req(), proposed: [{ ...A.req().proposed[1], [k]: "spoofed" }] });
  }
  await expectReject("forbidden key nested in mapping", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("label").binding_id, mappings: [
      { source_index: 0, local_id: "vip", node_id: "zn_spoof" } ] }] });
  await expectReject("forbidden key top-level", A.wfId, { ...A.req(), source_fp: "spoofed" });

  await expectReject("account missing platform", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_s1", shop_id: "shop_s1" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });
  await expectReject("account missing shop_id", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "shopee" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });
  await expectReject("account local_id !== shop_id", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "not_the_shop", platform: "shopee", shop_id: "shop_s1" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });
  await expectReject("account target not in shops", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_ghost", platform: "shopee", shop_id: "shop_ghost" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });
  await expectReject("label target not in conversations.labels", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("label").binding_id, mappings: [
      { source_index: 0, local_id: "lab_ghost" } ] }] });
  await expectReject("user target missing", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("user").binding_id, mappings: [
      { source_index: 0, local_id: "adm_ghost" } ] }] });
  await expectReject("user target inactive", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("user").binding_id, mappings: [
      { source_index: 0, local_id: "adm_off" } ] }] });
  await expectReject("team proposal → unresolvable", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("team").binding_id, mappings: [
      { source_index: 0, local_id: "team_any" } ] }] });
  await expectReject("ticket_field proposal → unresolvable", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("ticket_field").binding_id, mappings: [
      { source_index: 0, local_id: "tf_any" } ] }] });
  await expectReject("url proposal → unresolvable", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("url").binding_id, mappings: [
      { source_index: 0, local_id: "https://x.example" } ] }] });
  await expectReject("partial mapping (count=2, only index 0)", A.wfId,
    { ...A.req(), proposed: [{ binding_id: A.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] }] });

  const legacyWf = await svc.createWorkflow({ name: "legacy-nr", createdBy: "admin_t",
    nodes: [
      { node_id: "ln1", type: "trigger", subtype: "message", config: {}, position: { x: 0, y: 0 } },
      { node_id: "ln2", type: "action", subtype: "send_text", config: {}, position: { x: 100, y: 0 } },
    ],
    edges: [{ edge_id: "le1", source_node_id: "ln1", target_node_id: "ln2" }] });
  await expectReject("non-imported workflow", legacyWf.workflow_id,
    { workflow_id: legacyWf.workflow_id, expected_version: legacyWf.version, version_id: "wv_none",
      proposed: [{ binding_id: "wb_any", mappings: [{ source_index: 0, local_id: "x" }] }] });
  // Task 2 contract: repeat:true supported — sibling ไม่มี → resolve ปกติ (isolated fixture)
  const AR = await setupImported("workflow_BIND_AR");
  const rRep = await callResolve(AR.wfId, { ...AR.req(), proposed: [{ ...AR.req().proposed[1], repeat: true }] });
  ok(rRep != null && rRep.ok === true, "repeat:true with no same-kind sibling → resolves normally");
  eq((rRep?.repeated as unknown[] | undefined)?.length, 0, "repeat:true no sibling → repeated[] empty");
  await expectReject("unknown workflow → not_found", "wf_ghost_never_existed",
    { workflow_id: "wf_ghost_never_existed", expected_version: 1, version_id: "wv_x",
      proposed: [{ binding_id: "wb_x", mappings: [{ source_index: 0, local_id: "x" }] }] },
    (r) => eq(r.not_found, true, "not_found flag"));

  // ═══ 3. direct-resolution happy path ═══
  console.log("\n=== 3. Direct-resolution happy path ===");
  const countsPre = await allCounts();
  const evPre = state.adminEvents.length;
  const wfPre = canonicalJson(A.wfDoc);
  const v1Pre = canonicalJson(A.verDoc);
  const bindsPre = canonicalJson(A.binds);

  let auditAtCommit = -1;
  st.updateOneHook = async (coll: string) => {
    if (coll === COLLECTIONS.workflows && auditAtCommit < 0) auditAtCommit = state.adminEvents.length;
  };
  const res = await callResolve(A.wfId, A.req());
  disarm();

  ok(res != null && res.ok === true, `resolve → ok:true (${JSON.stringify(res)?.slice(0, 160)})`);
  eq(res?.version, 2, "resolve → version bumped");
  eq(res?.resolved, 3, "resolved=3 (account+label+user)");
  eq(res?.unresolved, 3, "unresolved=3 (team+ticket_field+url carried)");
  eq(res?.invalid, 0, "invalid=0");
  ok(Array.isArray(res?.repeated), "result carries repeated list");
  ok(Array.isArray(res?.publish_blockers), "result carries publish_blockers");
  ok(Array.isArray(res?.overlap_conflicts), "result carries overlap_conflicts");

  const versA = (await collDocs(COLLECTIONS.workflowVersions)).filter((v) => v.workflow_id === A.wfId);
  eq(versA.length, 2, "new immutable WorkflowVersionDoc appended (old untouched)");
  const v2doc = versA.find((v) => v.version_id !== A.verDoc.version_id) as Record<string, unknown> | undefined;
  ok(v2doc != null, "v2 version doc exists");
  eq(v2doc?.version_seq, 2, "v2 version_seq = expected+1");
  eq(canonicalJson(JSON.parse(JSON.stringify(v2doc?.nodes))), canonicalJson(JSON.parse(JSON.stringify(A.verDoc.nodes))), "v2 nodes identical to v1 (graph unchanged)");
  eq(canonicalJson(JSON.parse(JSON.stringify(v2doc?.edges))), canonicalJson(JSON.parse(JSON.stringify(A.verDoc.edges))), "v2 edges identical to v1 (BSON-canonical shape)");
  ok(typeof v2doc?.fingerprint === "string" && v2doc.fingerprint.startsWith("fnv64-"), "v2 fingerprint deterministic family");
  ok(v2doc?.fingerprint !== A.verDoc.fingerprint, "v2 fingerprint covers resolution payload (≠ v1)");
  eq(res?.version_id, v2doc?.version_id, "result version_id = new version doc id");
  eq(sorted(v2doc?.platforms), '["shopee","tiktok"]', "v2 carries derived platforms");
  eq(sorted(v2doc?.shop_ids), '["shop_s1","shop_s2"]', "v2 carries derived shop_ids");

  const bindsV2 = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === v2doc?.version_id);
  eq(bindsV2.length, 6, "all 6 bindings carried to new version scope");
  const v2ByKind = (k: string) => bindsV2.find((b) => b.kind === k) as Record<string, unknown> | undefined;
  const accBindV2 = v2ByKind("account");
  eq(accBindV2?.status, "resolved", "account binding → resolved");
  const accMaps = ((accBindV2?.resolution as { mappings?: Record<string, unknown>[] })?.mappings || [])
    .slice().sort((x, y) => (x.source_index as number) - (y.source_index as number));
  eq(accMaps.length, 2, "account binding → 2 mappings");
  eq(accMaps[0]?.local_id, "shop_s1", "account map[0] local_id");
  eq(accMaps[0]?.platform, "shopee", "account map[0] platform");
  eq(accMaps[0]?.shop_id, "shop_s1", "account map[0] shop_id");
  eq(accMaps[0]?.source_fp, fp256("zacc_1"), "account map[0] source_fp = server SHA-256");
  eq(accMaps[1]?.source_fp, fp256("zacc_2"), "account map[1] source_fp = server SHA-256");
  ok(accMaps.every((m) => m.state === "valid" && m.via === "direct" && m.resolved_by === "admin_t"),
    "account mappings → state:valid + via:direct + resolved_by actor");
  ok(accMaps.every((m) => !("requirement_fp" in m) && !("display_value" in m) && !("node_id" in m)),
    "mapping docs carry no client-trusted source identity");
  const labMaps = ((v2ByKind("label")?.resolution as { mappings?: Record<string, unknown>[] })?.mappings || []);
  eq(v2ByKind("label")?.status, "resolved", "label binding → resolved");
  eq(labMaps[0]?.local_id, "vip", "label map local_id = local label");
  eq(labMaps[0]?.source_fp, fp256("zlab_1"), "label source_fp = server SHA-256");
  eq(v2ByKind("user")?.status, "resolved", "user binding → resolved");
  eq(((v2ByKind("user")?.resolution as { mappings?: Record<string, unknown>[] })?.mappings || [])[0]?.local_id, "adm_u1", "user map local_id");
  for (const k of ["team", "ticket_field", "url"]) {
    eq(v2ByKind(k)?.status, "unresolved", `${k} binding → carried unresolved`);
    ok(v2ByKind(k)?.resolution == null, `${k} binding → no resolution field`);
  }

  // immutability — v1 version doc + v1 bindings byte-identical
  const v1After = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.version_id === A.verDoc.version_id);
  eq(canonicalJson(v1After), v1Pre, "v1 version doc byte-identical");
  const bindsV1After = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === A.verDoc.version_id);
  eq(canonicalJson(bindsV1After), bindsPre, "v1 bindings byte-identical");

  const wfAfter = (await svc.getWorkflow(A.wfId)) as Record<string, unknown>;
  eq(wfAfter?.current_version_id, v2doc?.version_id, "workflow pointer → new version");
  eq(wfAfter?.version, 2, "workflow version counter bumped");
  eq(wfAfter?.enabled, false, "commit forces enabled=false");
  eq(wfAfter?.status, "draft", "commit forces status=draft");
  eq(sorted(wfAfter?.platforms), '["shopee","tiktok"]', "derived platforms written in commit CAS");
  eq(sorted(wfAfter?.shop_ids), '["shop_s1","shop_s2"]', "derived shop_ids written in commit CAS");
  eq(wfAfter?.updated_by, "admin_t", "commit records actor");
  // graph fields on workflow doc ไม่ถูกแตะ (pointer move only)
  eq(canonicalJson(wfAfter?.nodes), (canonicalJson(A.wfDoc.nodes)), "workflow doc nodes unchanged by resolution");

  const ev = resolveEvents().slice(-1)[0] as { actor?: string; metadata?: Record<string, unknown> };
  ok(resolveEvents().filter((e) => (e as { metadata?: { workflow_id?: string } }).metadata?.workflow_id === A.wfId).length === 1,
    "exactly one workflow.binding_resolve audit event for this workflow");
  eq(ev?.actor, "admin_t", "audit actor");
  eq(ev?.metadata?.workflow_id, A.wfId, "audit metadata workflow_id");
  eq(auditAtCommit, evPre, "audit emitted only AFTER commit (events==baseline at CAS time)");
  eq(state.adminEvents.length, evPre + 1, "no other audit emitted");

  eq((await svc.listWorkflows({ enabledOnly: true, publishedOnly: true })).length, 0, "engine-visible list still zero (no activation)");
  const countsPost = await allCounts();
  eq(countsPost[COLLECTIONS.workflows], countsPre[COLLECTIONS.workflows], "no new workflow doc");
  eq(countsPost[COLLECTIONS.workflowVersions], countsPre[COLLECTIONS.workflowVersions] + 1, "exactly +1 version doc");
  eq(countsPost[COLLECTIONS.workflowBindings], countsPre[COLLECTIONS.workflowBindings] + 6, "exactly +6 binding docs");
  eq(countsPost[COLLECTIONS.workflowRawSnapshots], countsPre[COLLECTIONS.workflowRawSnapshots], "no new raw snapshot (no compiled artifact)");
  ok(canonicalJson(v2doc?.nodes || []).includes("zacc_1") === false && canonicalJson(v2doc?.nodes || []).includes("zlab_1") === false,
    "no local id written into version graph (executable config stays clean)");
  ok(!canonicalJson(await svc.getWorkflow(A.wfId)).includes("sekret-br"), "no credential in workflow doc");
  ok(JSON.stringify(state.adminEvents).includes("sekret-br") === false, "no credential in audit events");

  // ═══ 4. crash / conflict / recovery ═══
  console.log("\n=== 4. Crash + recovery — deterministic artifacts ===");

  // 4a. crash หลัง version insert (ก่อน binding แรก) → orphan version, retry resume
  const cA = await setupImported("workflow_BIND_CA");
  const wfA0 = canonicalJson(await svc.getWorkflow(cA.wfId));
  armInsertFail(COLLECTIONS.workflowBindings, 1);
  const thrA = await act(() => svcAny.saveBindingResolutionBatch?.(cA.wfId, cA.req(), "admin_t"));
  ok(thrA != null, "crash @first binding insert → throws (not silent)");
  disarm();
  eq(canonicalJson(await svc.getWorkflow(cA.wfId)), wfA0, "crash → pointer+scope byte-identical (no half-update)");
  const orphanA = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.workflow_id === cA.wfId && v.version_id !== cA.verDoc.version_id);
  ok(orphanA != null, "crash left orphan immutable version doc");
  const rA = await callResolve(cA.wfId, cA.req());
  eq(rA?.ok, true, "retry same payload → completes");
  eq(rA?.version_id, (orphanA as Record<string, unknown>)?.version_id, "retry reuses deterministic orphan version_id");
  eq((await collDocs(COLLECTIONS.workflowVersions)).filter((v) => v.workflow_id === cA.wfId).length, 2, "retry → still exactly 2 version docs (no dup)");
  eq((await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === (orphanA as Record<string, unknown>)?.version_id).length, 6, "retry → all 6 bindings present");

  // 4b. crash กลาง binding inserts → partial orphans, retry เติมครบ
  const cB = await setupImported("workflow_BIND_CB");
  const wfB0 = canonicalJson(await svc.getWorkflow(cB.wfId));
  armInsertFail(COLLECTIONS.workflowBindings, 3);
  const thrB = await act(() => svcAny.saveBindingResolutionBatch?.(cB.wfId, cB.req(), "admin_t"));
  ok(thrB != null, "crash mid-bindings → throws");
  disarm();
  eq(canonicalJson(await svc.getWorkflow(cB.wfId)), wfB0, "mid-bindings crash → pointer+scope unchanged");
  const rB = await callResolve(cB.wfId, cB.req());
  eq(rB?.ok, true, "mid-bindings retry → completes");
  const bindsB = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === (rB?.version_id as string));
  eq(bindsB.length, 6, "retry → binding set complete (6)");
  eq(new Set(bindsB.map((b) => b.binding_id as string)).size, 6, "retry → zero duplicate binding_ids");

  // 4c. crash ที่ commit CAS → artifacts ครบ, pointer เดิม, retry idempotent
  const cC = await setupImported("workflow_BIND_CC");
  const wfC0 = canonicalJson(await svc.getWorkflow(cC.wfId));
  const countsC0 = await allCounts();
  const evCC = resolveEvents().length;
  armUpdateFail(COLLECTIONS.workflows, 1);
  const thrC = await act(() => svcAny.saveBindingResolutionBatch?.(cC.wfId, cC.req(), "admin_t"));
  ok(thrC != null, "crash @commit CAS → throws");
  disarm();
  eq(canonicalJson(await svc.getWorkflow(cC.wfId)), wfC0, "commit crash → pointer+scope byte-identical");
  const countsC = await allCounts();
  eq(countsC[COLLECTIONS.workflowVersions], countsC0[COLLECTIONS.workflowVersions] + 1, "commit crash → orphan version doc exists");
  eq(countsC[COLLECTIONS.workflowBindings], countsC0[COLLECTIONS.workflowBindings] + 6, "commit crash → orphan bindings exist");
  eq(resolveEvents().length, evCC, "commit crash → zero success audit");
  const evC0 = resolveEvents().length;
  const rC = await callResolve(cC.wfId, cC.req());
  eq(rC?.ok, true, "commit-crash retry → completes");
  eq((await collDocs(COLLECTIONS.workflowVersions)).filter((v) => v.workflow_id === cC.wfId).length, 2, "commit-crash retry → no extra version doc");
  eq((await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === (rC?.version_id as string)).length, 6, "commit-crash retry → no extra bindings");
  eq(resolveEvents().length, evC0 + 1, "retry success → audit emitted exactly once");

  // 4d. concurrent writer flip → CAS matchedCount=0 → conflict + orphan ไม่เป็น current
  const cD = await setupImported("workflow_BIND_CD");
  const evD = resolveEvents().length;
  let flipped = false;
  st.updateOneHook = async (coll: string) => {
    if (coll === COLLECTIONS.workflows && !flipped) {
      flipped = true;
      st.updateOneHook = undefined;
      await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne({ workflow_id: cD.wfId }, { $set: { version: 99 } });
    }
  };
  const rD = await callResolve(cD.wfId, cD.req());
  disarm();
  eq(rD?.ok, false, "concurrent flip → resolve rejects");
  eq(rD?.conflict, true, "concurrent flip → conflict response");
  const wfD = (await svc.getWorkflow(cD.wfId)) as Record<string, unknown>;
  eq(wfD?.current_version_id, cD.verDoc.version_id, "CAS miss → pointer stays at old version (orphan never auto-current)");
  eq(wfD?.version, 99, "CAS miss → version = concurrent writer value");
  eq(canonicalJson(wfD?.platforms), canonicalJson(cD.wfDoc.platforms), "CAS miss → platforms untouched");
  eq(canonicalJson(wfD?.shop_ids), canonicalJson(cD.wfDoc.shop_ids), "CAS miss → shop_ids untouched");
  const orphanD = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.workflow_id === cD.wfId && v.version_id !== cD.verDoc.version_id);
  ok(orphanD != null, "CAS miss → orphan version doc exists but unreachable via pointer");
  eq(resolveEvents().length, evD, "CAS miss → zero success audit");

  // 4e. concurrent identical expected_version → winner เดียว
  const cE = await setupImported("workflow_BIND_CE");
  const fnE = svcAny.saveBindingResolutionBatch;
  const [r1, r2] = await Promise.allSettled([
    typeof fnE === "function" ? fnE(cE.wfId, cE.req(), "admin_t") : Promise.resolve(undefined),
    typeof fnE === "function" ? fnE(cE.wfId, cE.req(), "admin_t") : Promise.resolve(undefined),
  ]);
  const oks = [r1, r2].filter((r) => r.status === "fulfilled" && ((r as PromiseFulfilledResult<{ ok?: boolean } | undefined>).value?.ok === true));
  eq(oks.length, 1, "concurrent same expected_version → exactly one winner");
  const loserConf = [r1, r2].some((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ conflict?: boolean } | undefined>).value?.conflict === true);
  ok(loserConf, "loser → conflict response");
  const wfE = (await svc.getWorkflow(cE.wfId)) as Record<string, unknown>;
  eq(wfE?.version, 2, "winner pointer bumped");
  const winV = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.workflow_id === cE.wfId && v.version_id === wfE?.current_version_id);
  ok(winV != null, "pointer → real winner version doc");
  eq(sorted(wfE?.platforms), '["shopee","tiktok"]', "winner commit → derived scope written");

  // ═══ 5. C1 — concurrent different payloads + version-artifact E11000 ═══
  console.log("\n=== 5. C1 — version-artifact integrity ===");

  // Race A — different payloads บน expected_version เดียวกัน → winner เดียว + loser
  // conflict ที่รายงาน winner state จริง (fresh reread — ไม่ใช่ค่าที่จับก่อน race)
  // B เริ่มหลัง A ลง version doc (post-write onInsert) → B เห็น seq2 ถูกยึด → bump seq3
  // → CAS แพ้ (production compound unique จำลองด้วย seq-occupancy path)
  const cF = await setupImported("workflow_BIND_CF");
  const reqFA = cF.req();
  const reqFB = { ...cF.req(), proposed: [
    { binding_id: cF.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" },
      { source_index: 1, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] },
    ...cF.req().proposed.slice(1) ] };
  const fnF = svcAny.saveBindingResolutionBatch;
  let releaseFB!: () => void;
  const gateFB = new Promise<void>((r) => { releaseFB = r; });
  const stAnyF = st as unknown as { onInsert?: (coll: string, doc?: unknown) => void };
  const origOnInsertF = stAnyF.onInsert;
  stAnyF.onInsert = (coll: string, doc?: unknown) => {
    if (coll === COLLECTIONS.workflowVersions && (doc as { workflow_id?: string })?.workflow_id === cF.wfId) releaseFB();
  };
  const [rFA, rFB] = await Promise.allSettled([
    typeof fnF === "function" ? fnF(cF.wfId, reqFA, "admin_t") : Promise.resolve(undefined),
    gateFB.then(() => (typeof fnF === "function" ? fnF(cF.wfId, reqFB, "admin_t") : Promise.resolve(undefined))),
  ]);
  stAnyF.onInsert = origOnInsertF;
  const valF = [rFA, rFB].map((r) => (r.status === "fulfilled" ? (r as PromiseFulfilledResult<Record<string, unknown> | undefined>).value : undefined));
  const winnerF = valF.find((v) => v?.ok === true);
  const loserF = valF.find((v) => v != null && v !== winnerF);
  ok(winnerF != null, "Race A → exactly one pointer winner exists");
  eq(valF.filter((v) => v?.ok === true).length, 1, "Race A → exactly one ok result");
  eq(loserF?.ok, false, "Race A → loser rejected");
  eq(loserF?.conflict, true, "Race A → loser is conflict");
  const wfF = (await svc.getWorkflow(cF.wfId)) as Record<string, unknown>;
  eq(wfF?.current_version_id, winnerF?.version_id, "Race A → pointer = winner version_id");
  eq(loserF?.current_version, winnerF?.version, "Race A → loser conflict reports winner version (fresh reread)");
  eq(loserF?.current_version_id, winnerF?.version_id, "Race A → loser conflict reports winner version_id");
  const pointDocF = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.version_id === wfF?.current_version_id);
  ok(pointDocF != null, "Race A → current_version_id resolves to a real version doc");
  const pointBindsF = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === wfF?.current_version_id);
  eq(pointBindsF.length, 6, "Race A → pointed version has exact expected binding set (6)");
  const winnerReq = rFA.status === "fulfilled" && (rFA.value as { ok?: boolean } | undefined)?.ok === true ? reqFA : reqFB;
  const winnerAccMap = (((pointBindsF.find((b) => b.kind === "account")?.resolution as { mappings?: Record<string, unknown>[] })?.mappings || [])
    .slice().sort((x, y) => (x.source_index as number) - (y.source_index as number)));
  eq(winnerAccMap[0]?.local_id, (winnerReq.proposed[0].mappings[0] as { local_id?: string }).local_id, "Race A → pointed version payload matches winning request");
  ok(pointBindsF.every((b) => (b.version_id as string) === (pointDocF as Record<string, unknown>)?.version_id), "Race A → every pointed binding references existing version doc");

  // Race B — pre-seeded (workflow_id, version_seq) collision ด้วย payload ต่าง → bump
  const cG = await setupImported("workflow_BIND_CG");
  await (await mongo.getCollection(COLLECTIONS.workflowVersions)).insertOne({
    version_id: "wv_seeded_collision", workflow_id: cG.wfId, version_seq: 2,
    schema_version: "canonical-workflow/1", name: "foreign-payload", platforms: [],
    nodes: [], edges: [], handle_labels: {}, source_ref: { workflowId: "x", loadedVersionId: "x", versionStatuses: [], sourceStatus: "", fingerprint: "fnv64-foreign" },
    fingerprint: "fnv64-foreign", created_at: new Date(), created_by: "other",
  });
  const rG = await callResolve(cG.wfId, cG.req());
  eq(rG?.ok, true, "Race B → resolver completes despite seq collision");
  const wfG = (await svc.getWorkflow(cG.wfId)) as Record<string, unknown>;
  const pointDocG = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.version_id === wfG?.current_version_id);
  ok(pointDocG != null, "Race B → pointer references a real version doc");
  ok(pointDocG?.version_id !== "wv_seeded_collision", "Race B → resolver did not swallow foreign seq artifact");
  eq(pointDocG?.version_seq, 3, "Race B → bumped to next free seq");
  eq(wfG?.version, 3, "Race B → workflow.version equals landed version_seq");
  const seededStill = await (await mongo.getCollection(COLLECTIONS.workflowVersions)).findOne({ version_id: "wv_seeded_collision" });
  ok(seededStill != null, "Race B → seeded foreign artifact untouched (no overwrite)");

  // Race C — E11000 injected แต่ไม่มี artifact จริง → fail closed, no dangling pointer
  const cH = await setupImported("workflow_BIND_CH");
  const wfH0 = canonicalJson(await svc.getWorkflow(cH.wfId));
  const countsH0 = await allCounts();
  const evH0 = resolveEvents().length;
  st.insertOneHook = async (coll: string) => {
    if (coll === COLLECTIONS.workflowVersions) {
      const e = new Error("E11000 duplicate key error (phantom)") as Error & { code?: number };
      e.code = 11000; throw e;
    }
  };
  const thrH = await act(() => svcAny.saveBindingResolutionBatch?.(cH.wfId, cH.req(), "admin_t"));
  disarm();
  ok(thrH != null, "Race C → phantom E11000 → fails closed (throws)");
  const wfH = (await svc.getWorkflow(cH.wfId)) as Record<string, unknown>;
  eq(canonicalJson(wfH), wfH0, "Race C → pointer+scope byte-identical");
  eq(wfH?.current_version_id, cH.verDoc.version_id, "Race C → no dangling current_version_id");
  const orphanH = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.workflow_id === cH.wfId && v.version_id !== cH.verDoc.version_id);
  ok(orphanH == null, "Race C → no version doc created");
  eq((await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id !== cH.verDoc.version_id && b.workflow_id === cH.wfId).length, 0, "Race C → zero binding docs written");
  eq(resolveEvents().length, evH0, "Race C → zero success audit");
  eq(canonicalJson(await allCounts()), canonicalJson(countsH0), "Race C → zero writes total");

  // ═══ 6. H1 — exact binding-artifact verification ═══
  console.log("\n=== 6. H1 — binding-artifact exact verification ===");

  // 6a. pre-seeded corrupt binding ด้วย deterministic binding_id → fail closed ทุก field
  for (const [tag, patch] of [
    ["wrong workflow_id", { workflow_id: "wf_corrupt" }],
    ["wrong version_id", { version_id: "wv_corrupt" }],
    ["wrong node_id", { node_id: "zn_corrupt" }],
    ["wrong field_path", { field_path: "corrupt.path" }],
    ["wrong kind", { kind: "corrupt_kind" }],
    ["wrong source_values", { source_values: ["corrupt"] }],
    ["wrong status/resolution", { status: "resolved", resolution: { mappings: [{ source_index: 0, source_fp: "bogus", local_id: "evil", state: "valid", resolved_by: "x", resolved_at: new Date(), via: "direct" }] } }],
  ] as [string, Record<string, unknown>][]) {
    const fx = await setupImported(`workflow_BIND_H1_${tag.replace(/\W+/g, "_")}`);
    const wfX0 = canonicalJson(await svc.getWorkflow(fx.wfId));
    const evX0 = resolveEvents().length;
    let seeded = false;
    st.insertOneHook = async (coll: string, doc?: unknown) => {
      if (coll === COLLECTIONS.workflowBindings && !seeded) {
        seeded = true;
        await (await mongo.getCollection(COLLECTIONS.workflowBindings)).insertOne({ ...(doc as Record<string, unknown>), ...patch });
      }
    };
    const thr = await act(() => svcAny.saveBindingResolutionBatch?.(fx.wfId, fx.req(), "admin_t"));
    disarm();
    ok(thr != null, `H1 ${tag} → fails closed (threw, no silent carry)`);
    eq(canonicalJson(await svc.getWorkflow(fx.wfId)), wfX0, `H1 ${tag} → pointer+scope unchanged`);
    eq(resolveEvents().length, evX0, `H1 ${tag} → zero success audit`);
    const corruptRow = (await collDocs(COLLECTIONS.workflowBindings)).find((b) => JSON.stringify(b).includes("corrupt") || JSON.stringify(b).includes("evil"));
    ok(corruptRow != null, `H1 ${tag} → corrupt row left for inspection (never auto-deleted)`);
  }

  // 6b. expected set + 1 unexpected extra binding → fail closed
  const cI2 = await setupImported("workflow_BIND_H1_EXTRA");
  const wfI2_0 = canonicalJson(await svc.getWorkflow(cI2.wfId));
  let extraSeeded = false;
  st.insertOneHook = async (coll: string, doc?: unknown) => {
    if (coll === COLLECTIONS.workflowBindings && !extraSeeded) {
      extraSeeded = true;
      await (await mongo.getCollection(COLLECTIONS.workflowBindings)).insertOne({
        ...(doc as Record<string, unknown>), binding_id: "wb_extra_unexpected",
      });
    }
  };
  const thrI2 = await act(() => svcAny.saveBindingResolutionBatch?.(cI2.wfId, cI2.req(), "admin_t"));
  disarm();
  ok(thrI2 != null, "H1 extra binding → fails closed");
  eq(canonicalJson(await svc.getWorkflow(cI2.wfId)), wfI2_0, "H1 extra binding → pointer unchanged");
  ok((await collDocs(COLLECTIONS.workflowBindings)).some((b) => b.binding_id === "wb_extra_unexpected"), "H1 extra binding → unexpected row preserved for inspection");

  // 6c. duplicate same binding_id rows — uniqueness ปิดจน real insert ลงด้วย → 2 rows id เดียว
  const cI3 = await setupImported("workflow_BIND_H1_DUP");
  const wfI3_0 = canonicalJson(await svc.getWorkflow(cI3.wfId));
  let dupPhase = 0;
  let origKeys: string[] = [];
  st.insertOneHook = async (coll: string, doc?: unknown) => {
    if (coll !== COLLECTIONS.workflowBindings || dupPhase !== 0) return;
    dupPhase = 1;
    const u = st.uniqueKeys as Record<string, string[]>;
    origKeys = u.workflow_bindings;
    u.workflow_bindings = [];
    st.insertOneHook = undefined; // seed โดยไม่ยิง hook ซ้ำ — real insert ลงด้วย unique off
    await (await mongo.getCollection(COLLECTIONS.workflowBindings)).insertOne({ ...(doc as Record<string, unknown>) });
    st.insertOneHook = async (c2: string) => {
      if (c2 === COLLECTIONS.workflowBindings && dupPhase === 1) {
        dupPhase = 2;
        u.workflow_bindings = origKeys; // dup pair ลงครบแล้ว — restore ก่อน insert ถัดไป
      }
    };
  };
  const thrI3 = await act(() => svcAny.saveBindingResolutionBatch?.(cI3.wfId, cI3.req(), "admin_t"));
  disarm();
  (st.uniqueKeys as Record<string, string[]>).workflow_bindings = origKeys; // safety restore
  ok(thrI3 != null, "H1 dup binding_id rows → fails closed (multiplicity)");
  eq(canonicalJson(await svc.getWorkflow(cI3.wfId)), wfI3_0, "H1 dup rows → pointer unchanged");

  // 6d. binding หายระหว่าง insert→verify (findHook ลบก่อน verification query) → commit ไม่ได้
  const cI4 = await setupImported("workflow_BIND_H1_MISSING");
  const wfI4_0 = canonicalJson(await svc.getWorkflow(cI4.wfId));
  let deletedOne = false;
  (st as Record<string, unknown>).findHook = async (coll: string, filter?: Record<string, unknown>) => {
    if (coll === COLLECTIONS.workflowBindings && !deletedOne && filter?.version_id && filter.version_id !== cI4.verDoc.version_id) {
      deletedOne = true; // guard ก่อน inner find — กัน findHook recursion
      const c = await mongo.getCollection(COLLECTIONS.workflowBindings);
      const rows = await c.find({ version_id: filter.version_id }).toArray() as { binding_id?: string }[];
      if (rows[0]) await c.deleteOne({ binding_id: rows[0].binding_id });
    }
  };
  const thrI4 = await act(() => svcAny.saveBindingResolutionBatch?.(cI4.wfId, cI4.req(), "admin_t"));
  (st as Record<string, unknown>).findHook = undefined;
  ok(thrI4 != null, "H1 missing binding post-insert → fails closed (pointer cannot commit)");
  eq(canonicalJson(await svc.getWorkflow(cI4.wfId)), wfI4_0, "H1 missing → pointer unchanged");

  // ═══ 7. M1 — canonical mapping order (same fixture + crash-retry — ตัด confound ชื่อ wf) ═══
  console.log("\n=== 7. M1 — canonical mapping order ===");
  const cJ = await setupImported("workflow_BIND_CJ");
  const accJ = cJ.byKind("account");
  const reqJ = cJ.req(); // canonical order [0,1]
  const reqJr = { ...reqJ, proposed: [ { binding_id: accJ.binding_id, mappings: [
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" },
      { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] },
    ...reqJ.proposed.slice(1) ] }; // reversed order [1,0]
  // crash @commit ด้วย canonical order → orphan artifacts (v2) ค้างอยู่
  armUpdateFail(COLLECTIONS.workflows, 1);
  const thrJ = await act(() => svcAny.saveBindingResolutionBatch?.(cJ.wfId, reqJ, "admin_t"));
  disarm();
  ok(thrJ != null, "M1 → first attempt crashed at commit (orphan v2 left)");
  const orphanJ = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.workflow_id === cJ.wfId && v.version_seq === 2);
  ok(orphanJ != null, "M1 → orphan version artifact exists after crash");
  const versionsJ0 = (await collDocs(COLLECTIONS.workflowVersions)).length;
  // retry ด้วย reversed order → semantic เดิม → ต้อง reuse identity เดิม (ไม่สร้าง duplicate)
  const rJ2 = await callResolve(cJ.wfId, reqJr);
  eq(rJ2?.ok, true, "M1 → reversed-order retry ok");
  eq(rJ2?.version_id, (orphanJ as Record<string, unknown>)?.version_id, "M1 → identical semantic resolution → reuses same version_id (order-independent identity)");
  eq((await collDocs(COLLECTIONS.workflowVersions)).length, versionsJ0, "M1 → retry created no semantic-duplicate version doc");
  const bindsJ = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === (rJ2?.version_id as string));
  const accMapsJ = ((bindsJ.find((b) => b.kind === "account")?.resolution as { mappings?: Record<string, unknown>[] })?.mappings || []);
  eq(accMapsJ[0]?.source_index, 0, "M1 → stored mappings sorted by source_index (index 0 first)");
  eq(accMapsJ[1]?.source_index, 1, "M1 → stored mappings sorted by source_index (index 1 second)");
  const srcValsJ = (bindsJ.find((b) => b.kind === "account")?.source_values as string[]);
  eq(canonicalJson(srcValsJ), canonicalJson(["zacc_1", "zacc_2"]), "M1 → source_values stored order untouched (authoritative)");

  // ═══ 8. M2 — exact request shape (fresh fixture per case — pre-fix code อาจเขียนจริง) ═══
  console.log("\n=== 8. M2 — exact request shape ===");
  let m2n = 0;
  for (const [tag, build, check] of [
    ["top-level enabled", (fx: Fx) => ({ ...fx.req(), enabled: true }), undefined],
    ["top-level status", (fx: Fx) => ({ ...fx.req(), status: "published" }), undefined],
    ["top-level extra", (fx: Fx) => ({ ...fx.req(), extra: 1 }), undefined],
    ["proposal-level unknown", (fx: Fx) => ({ ...fx.req(), proposed: [{ ...fx.req().proposed[1], bogus: 1 }] }), undefined],
    ["mapping-level shopId typo", (fx: Fx) => ({ ...fx.req(), proposed: [{ binding_id: fx.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1", shopId: "shop_s1" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] }), undefined],
    ["mapping-level sourceIndex typo", (fx: Fx) => ({ ...fx.req(), proposed: [{ binding_id: fx.byKind("label").binding_id, mappings: [
      { source_index: 0, sourceIndex: 0, local_id: "vip" } ] }] }), undefined],
    ["negative expected_version", (fx: Fx) => ({ ...fx.req(), expected_version: -1 }),
      (r: Record<string, unknown>) => ok(typeof r.validation === "string", "negative → validation (not conflict)")],
    ["local_id whitespace-only", (fx: Fx) => ({ ...fx.req(), proposed: [{ binding_id: fx.byKind("label").binding_id, mappings: [
      { source_index: 0, local_id: "   " } ] }] }),
      (r: Record<string, unknown>) => ok(typeof r.validation === "string" && !r.validation.includes("not in"), "whitespace local_id → empty reject (not not-found)")],
    ["binding_id whitespace-only", (fx: Fx) => ({ ...fx.req(), proposed: [{ binding_id: " ", mappings: [{ source_index: 0, local_id: "x" }] }] }),
      (r: Record<string, unknown>) => ok(typeof r.validation === "string" && r.validation.includes("binding_id"), "whitespace binding_id → empty reject")],
    ["version_id whitespace-only", (fx: Fx) => ({ ...fx.req(), version_id: "  " }),
      (r: Record<string, unknown>) => ok(typeof r.validation === "string", "whitespace version_id → validation (not conflict)")],
    ["platform outside Platform union", (fx: Fx) => ({ ...fx.req(), proposed: [{ binding_id: fx.byKind("account").binding_id, mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "myspace", shop_id: "shop_s1" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] }),
      (r: Record<string, unknown>) => ok(typeof r.validation === "string" && r.validation.includes("must be one of"), "platform outside union → enum reject")],
  ] as [string, (fx: Fx) => unknown, ((r: Record<string, unknown>) => void) | undefined][]) {
    const fx = await setupImported(`workflow_BIND_M2_${m2n++}`);
    await expectReject(`M2 ${tag}`, fx.wfId, build(fx), check);
  }

  // ═══ 9. M3 — persisted binding invariants ═══
  console.log("\n=== 9. M3 — persisted binding invariants ===");
  async function expectCorruptFail(tag: string, fx: Fx, req: unknown, needMsg?: string) {
    const wf0 = canonicalJson(await svc.getWorkflow(fx.wfId));
    const counts0 = await allCounts();
    const ev0 = resolveEvents().length;
    const res = await callResolve(fx.wfId, req);
    ok(res != null && (res.__thrown != null || res.ok === false), `${tag} → fails closed`);
    if (needMsg) ok(String(res?.__thrown ?? res?.validation ?? "").includes(needMsg), `${tag} → rejected by invariant ("${needMsg}")`);
    eq(canonicalJson(await svc.getWorkflow(fx.wfId)), wf0, `${tag} → pointer+scope unchanged`);
    eq(canonicalJson(await allCounts()), canonicalJson(counts0), `${tag} → zero writes`);
    eq(resolveEvents().length, ev0, `${tag} → zero success audit`);
  }

  // count=1 (จริง 2) → propose เฉพาะ index 0 → pre-fix ผ่าน coverage แล้วเขียนจริง = ตัวพิสูจน์ invariant
  const cM = await setupImported("workflow_BIND_CM");
  const accM = cM.byKind("account");
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne({ binding_id: accM.binding_id as string }, { $set: { count: 1 } });
  await expectCorruptFail("M3 count < source_values.length", cM,
    { ...cM.req(), proposed: [{ binding_id: accM.binding_id as string, mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] }] },
    "corrupt persisted");

  // count=3 (จริง 2) → propose index 0,1,2 → pre-fix bounds ใช้ count → ผ่าน coverage แล้วเขียนจริง
  const cM2 = await setupImported("workflow_BIND_CM2");
  const accM2 = cM2.byKind("account");
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne({ binding_id: accM2.binding_id as string }, { $set: { count: 3 } });
  await expectCorruptFail("M3 count > source_values.length", cM2,
    { ...cM2.req(), proposed: [{ binding_id: accM2.binding_id as string, mappings: [
      { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
      { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" },
      { source_index: 2, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] }] },
    "corrupt persisted");

  // corrupt carried resolution — resolve ครั้งแรกให้ v2 มี resolved bindings แล้วเสีย stored fp
  // (propose account re-resolve ด้วย valid targets — team proposal จะ reject ก่อน invariant = ไม่ honest)
  const cM3 = await setupImported("workflow_BIND_CM3");
  const rM3 = await callResolve(cM3.wfId, cM3.req());
  eq(rM3?.ok, true, "M3 setup resolve ok");
  const labM3 = ((await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === (rM3?.version_id as string) && b.kind === "label")) as Record<string, unknown>;
  const labRes = labM3.resolution as { mappings: Record<string, unknown>[] };
  labRes.mappings[0].source_fp = "bogus_stored_fp";
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne({ binding_id: labM3.binding_id as string }, { $set: { resolution: labRes } });
  const wfM3 = (await svc.getWorkflow(cM3.wfId)) as Record<string, unknown>;
  await expectCorruptFail("M3 stale/wrong stored source_fp", cM3,
    { workflow_id: cM3.wfId, expected_version: wfM3.version, version_id: wfM3.current_version_id,
      proposed: [{ binding_id: (await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === wfM3.current_version_id && b.kind === "account")?.binding_id,
        mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
    "corrupt persisted");

  const cM4 = await setupImported("workflow_BIND_CM4");
  const rM4 = await callResolve(cM4.wfId, cM4.req());
  eq(rM4?.ok, true, "M3-2 setup resolve ok");
  const usrM4 = ((await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === (rM4?.version_id as string) && b.kind === "user")) as Record<string, unknown>;
  const usrRes = usrM4.resolution as { mappings: Record<string, unknown>[] };
  usrRes.mappings.push({ ...usrRes.mappings[0] }); // duplicate source_index 0
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne({ binding_id: usrM4.binding_id as string }, { $set: { resolution: usrRes } });
  const wfM4 = (await svc.getWorkflow(cM4.wfId)) as Record<string, unknown>;
  await expectCorruptFail("M3 duplicate stored source_index", cM4,
    { workflow_id: cM4.wfId, expected_version: wfM4.version, version_id: wfM4.current_version_id,
      proposed: [{ binding_id: (await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === wfM4.current_version_id && b.kind === "account")?.binding_id,
        mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
    "corrupt persisted");

  const cM5 = await setupImported("workflow_BIND_CM5");
  const rM5 = await callResolve(cM5.wfId, cM5.req());
  eq(rM5?.ok, true, "M3-3 setup resolve ok");
  const labM5 = ((await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === (rM5?.version_id as string) && b.kind === "label")) as Record<string, unknown>;
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne({ binding_id: labM5.binding_id as string }, { $set: { resolution: { mappings: [] } } });
  const wfM5 = (await svc.getWorkflow(cM5.wfId)) as Record<string, unknown>;
  await expectCorruptFail("M3 resolved status with partial/empty mappings", cM5,
    { workflow_id: cM5.wfId, expected_version: wfM5.version, version_id: wfM5.current_version_id,
      proposed: [{ binding_id: (await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === wfM5.current_version_id && b.kind === "account")?.binding_id,
        mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
    "corrupt persisted");

  // ═══ 10. M4 — fresh winner state on CAS conflict ═══
  console.log("\n=== 10. M4 — CAS conflict returns fresh winner state ===");
  const cN = await setupImported("workflow_BIND_CN");
  let flippedN = false;
  st.updateOneHook = async (coll: string) => {
    if (coll === COLLECTIONS.workflows && !flippedN) {
      flippedN = true;
      st.updateOneHook = undefined;
      await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne({ workflow_id: cN.wfId }, { $set: { version: 7, current_version_id: "wv_winner_other" } });
    }
  };
  const rN = await callResolve(cN.wfId, cN.req());
  disarm();
  eq(rN?.ok, false, "M4 → loser rejected");
  eq(rN?.conflict, true, "M4 → loser conflict");
  eq(rN?.current_version, 7, "M4 → conflict reports fresh winner version (reread)");
  eq(rN?.current_version_id, "wv_winner_other", "M4 → conflict reports fresh winner version_id (reread)");
  const evN = resolveEvents().length;
  eq(resolveEvents().length, evN, "M4 → zero success audit on conflict");

  // ═══ 11. BSON canonical persisted shape (undefined → null ใน real BSON) ═══
  console.log("\n=== 11. BSON canonical persisted shape ===");
  const { serialize: bsonSerialize, deserialize: bsonDeserialize } = await import("bson");
  const probeBson = bsonDeserialize(bsonSerialize({ a: undefined, b: 1 })) as Record<string, unknown>;
  ok(!("a" in probeBson) && probeBson.b === 1, "BSON probe — undefined-valued keys dropped (real Mongo wire shape)");

  // 11a. crash→orphan→BSON round-trip artifacts → retry ต้อง reuse artifact เดิม
  const cBs = await setupImported("workflow_BIND_CBSON");
  armUpdateFail(COLLECTIONS.workflows, 1);
  const thrBs = await act(() => svcAny.saveBindingResolutionBatch?.(cBs.wfId, cBs.req(), "admin_t"));
  disarm();
  ok(thrBs != null, "BSON → first attempt crashed at commit (orphan artifacts left)");
  const orphanB = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.workflow_id === cBs.wfId && v.version_seq === 2);
  ok(orphanB != null, "BSON → orphan version artifact exists");
  for (const collName of [COLLECTIONS.workflowVersions, COLLECTIONS.workflowBindings]) {
    const c = await mongo.getCollection(collName);
    const docs = await c.find({ workflow_id: cBs.wfId }).toArray() as Record<string, unknown>[];
    for (const d of docs) {
      const rt = bsonDeserialize(bsonSerialize(d)) as Record<string, unknown>;
      await c.deleteOne({ _id: d._id });
      await c.insertOne(rt);
    }
  }
  const rBs2 = await callResolve(cBs.wfId, cBs.req());
  eq(rBs2?.ok, true, "BSON → retry after BSON round-trip still resolves (no false-corruption)");
  eq(rBs2?.version_id, (orphanB as Record<string, unknown>)?.version_id, "BSON → retry reuses same version_id");

  // 11b. label/user mappings ต้องไม่เขียน platform/shop_id key ลง doc เลย (fake เก็บ undefined
  // ไว้ → "platform" in m ยัง true pre-fix; real BSON จะ drop key → shape เดียวกันทั้งสองฝั่ง)
  const bindsBs = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === (rBs2?.version_id as string));
  for (const kind of ["label", "user"]) {
    const stored = bindsBs.find((b) => b.kind === kind) as Record<string, unknown>;
    const maps = ((stored.resolution as { mappings?: Record<string, unknown>[] })?.mappings ?? []);
    ok(maps.length > 0 && maps.every((m) => !("platform" in m) && !("shop_id" in m)),
      `BSON → ${kind} mapping has NO platform/shop_id key in persisted shape`);
    const rtDoc = bsonDeserialize(bsonSerialize(stored)) as Record<string, unknown>;
    const rtMaps = ((rtDoc.resolution as { mappings?: Record<string, unknown>[] })?.mappings ?? []);
    ok(rtMaps.length > 0 && rtMaps.every((m) => !("platform" in m) && !("shop_id" in m)),
      `BSON → ${kind} mapping survives BSON round-trip without scope keys`);
  }

  // 11c. corrupt persisted artifact หลัง round-trip ยังต้อง reject (ไม่ loosen)
  const cBs2 = await setupImported("workflow_BIND_CBSON2");
  const rBs2a = await callResolve(cBs2.wfId, cBs2.req());
  eq(rBs2a?.ok, true, "BSON-2 setup resolve ok");
  const labBs2 = ((await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === (rBs2a?.version_id as string) && b.kind === "label")) as Record<string, unknown>;
  const labBs2Res = labBs2.resolution as { mappings: Record<string, unknown>[] };
  labBs2Res.mappings[0].source_fp = "bogus_after_roundtrip";
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne({ binding_id: labBs2.binding_id as string }, { $set: { resolution: labBs2Res } });
  const wfB2 = (await svc.getWorkflow(cBs2.wfId)) as Record<string, unknown>;
  await expectCorruptFail("BSON → corrupt stored artifact still rejected", cBs2,
    { workflow_id: cBs2.wfId, expected_version: wfB2.version, version_id: wfB2.current_version_id,
      proposed: [{ binding_id: (await collDocs(COLLECTIONS.workflowBindings)).find((b) => b.version_id === wfB2.current_version_id && b.kind === "account")?.binding_id,
        mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
    "corrupt persisted");

  // ═══ 12. version_seq / version_id multiplicity (no production DDL) ═══
  console.log("\n=== 12. version multiplicity gate ===");
  const ukeysV = st.uniqueKeys as Record<string, string[]>;
  const origVKeys = ukeysV.workflow_versions;

  // 12a. foreign doc seeded ที่ (workflow_id, version_seq) เดียวกัน → fail closed
  try {
    const cM6 = await setupImported("workflow_BIND_CM6");
    const wfM6_0 = canonicalJson(await svc.getWorkflow(cM6.wfId));
    const evM6_0 = resolveEvents().length;
    ukeysV.workflow_versions = [];
    let seqSeeded = false;
    st.insertOneHook = async (coll: string, doc?: unknown) => {
      if (coll === COLLECTIONS.workflowVersions && !seqSeeded) {
        seqSeeded = true;
        st.insertOneHook = undefined;
        await (await mongo.getCollection(COLLECTIONS.workflowVersions)).insertOne({
          ...(doc as Record<string, unknown>), version_id: "wv_foreign_seq" });
      }
    };
    const thrM6 = await act(() => svcAny.saveBindingResolutionBatch?.(cM6.wfId, cM6.req(), "admin_t"));
    disarm();
    ok(thrM6 != null, "seq multiplicity (foreign same-seq doc) → fails closed");
    eq(canonicalJson(await svc.getWorkflow(cM6.wfId)), wfM6_0, "seq multiplicity → pointer+scope unchanged");
    eq(resolveEvents().length, evM6_0, "seq multiplicity → zero success audit");
    eq((await collDocs(COLLECTIONS.workflowVersions)).filter((v) => v.workflow_id === cM6.wfId && v.version_seq === 2).length, 2,
      "seq multiplicity → both same-seq docs preserved for inspection");
  } finally { ukeysV.workflow_versions = origVKeys; }

  // 12b. concurrent different payloads — both version inserts land ก่อน CAS (barrier sync)
  try {
    const cM7 = await setupImported("workflow_BIND_CM7");
    const wfM7_0 = canonicalJson(await svc.getWorkflow(cM7.wfId));
    const evM7_0 = resolveEvents().length;
    ukeysV.workflow_versions = [];
    let insertedV = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    st.insertOneHook = async (coll: string) => {
      if (coll === COLLECTIONS.workflowVersions) {
        insertedV += 1;
        if (insertedV === 2) release();
        await barrier;
      }
    };
    const reqM7A = cM7.req();
    const reqM7B = { ...cM7.req(), proposed: [ { binding_id: cM7.byKind("account").binding_id, mappings: [
        { source_index: 0, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" },
        { source_index: 1, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] },
      ...cM7.req().proposed.slice(1) ] };
    const [sA, sB] = await Promise.allSettled([
      svcAny.saveBindingResolutionBatch?.(cM7.wfId, reqM7A, "admin_t"),
      svcAny.saveBindingResolutionBatch?.(cM7.wfId, reqM7B, "admin_t"),
    ]);
    disarm();
    const valsM7 = [sA, sB].map((s) => (s.status === "fulfilled" ? (s as PromiseFulfilledResult<Record<string, unknown> | undefined>).value : undefined));
    eq(valsM7.filter((v) => v?.ok === true).length, 0, "concurrent seq multiplicity → zero commits (fail closed)");
    eq(canonicalJson(await svc.getWorkflow(cM7.wfId)), wfM7_0, "concurrent multiplicity → pointer+scope unchanged");
    eq(resolveEvents().length, evM7_0, "concurrent multiplicity → zero success audit");
    eq((await collDocs(COLLECTIONS.workflowVersions)).filter((v) => v.workflow_id === cM7.wfId && v.version_seq === 2).length, 2,
      "concurrent multiplicity → both same-seq artifacts preserved for inspection");
  } finally { ukeysV.workflow_versions = origVKeys; }

  // 12c. version_id dup rows (no DDL) → fail closed
  try {
    const cM8 = await setupImported("workflow_BIND_CM8");
    const wfM8_0 = canonicalJson(await svc.getWorkflow(cM8.wfId));
    ukeysV.workflow_versions = [];
    let idSeeded = false;
    st.insertOneHook = async (coll: string, doc?: unknown) => {
      if (coll === COLLECTIONS.workflowVersions && !idSeeded) {
        idSeeded = true;
        st.insertOneHook = undefined;
        await (await mongo.getCollection(COLLECTIONS.workflowVersions)).insertOne({ ...(doc as Record<string, unknown>) });
      }
    };
    const thrM8 = await act(() => svcAny.saveBindingResolutionBatch?.(cM8.wfId, cM8.req(), "admin_t"));
    disarm();
    ok(thrM8 != null, "version_id dup rows → fails closed (multiplicity)");
    eq(canonicalJson(await svc.getWorkflow(cM8.wfId)), wfM8_0, "version_id dup → pointer unchanged");
    eq((await collDocs(COLLECTIONS.workflowVersions)).filter((v) => v.workflow_id === cM8.wfId && v.version_seq === 2).length, 2,
      "version_id dup → both rows preserved");
  } finally { ukeysV.workflow_versions = origVKeys; }

  // ═══ 13. M3 — persisted ResolutionMapping invariants (ครบ schema) ═══
  console.log("\n=== 13. M3 — persisted mapping invariants ===");
  async function corruptV2(tag: string, srcWfId: string, kind: string, mutate: (doc: Record<string, unknown>, maps: Record<string, unknown>[]) => Record<string, unknown>) {
    const fx = await setupImported(srcWfId);
    const r = await callResolve(fx.wfId, fx.req());
    eq(r?.ok, true, `${tag} setup resolve ok`);
    const all = await collDocs(COLLECTIONS.workflowBindings);
    const doc = all.find((b) => b.version_id === (r?.version_id as string) && b.kind === kind) as Record<string, unknown>;
    const maps = ((doc.resolution as { mappings?: Record<string, unknown>[] })?.mappings ?? []);
    await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne(
      { binding_id: doc.binding_id as string }, { $set: mutate(doc, maps) });
    const wf = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    const accBind = all.find((b) => b.version_id === wf.current_version_id && b.kind === "account");
    await expectCorruptFail(tag, fx,
      { workflow_id: fx.wfId, expected_version: wf.version, version_id: wf.current_version_id,
        proposed: [{ binding_id: accBind?.binding_id, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      "corrupt persisted");
  }

  await corruptV2("M3 stored local_id empty", "workflow_BIND_M3A", "label",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], local_id: " " }] } }));
  await corruptV2("M3 stored state bogus", "workflow_BIND_M3B", "user",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], state: "bogus" }] } }));
  await corruptV2("M3 stored via bogus", "workflow_BIND_M3C", "user",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], via: "bogus" }] } }));
  await corruptV2("M3 stored resolved_by empty", "workflow_BIND_M3D", "user",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], resolved_by: " " }] } }));
  await corruptV2("M3 stored resolved_at non-Date", "workflow_BIND_M3E", "label",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], resolved_at: "not-a-date" }] } }));
  await corruptV2("M3 account mapping missing platform", "workflow_BIND_M3F", "account",
    (d, maps) => ({ resolution: { mappings: maps.map((m, i) => i === 0 ? { ...m, platform: null } : m) } }));
  await corruptV2("M3 account mapping missing shop_id", "workflow_BIND_M3N", "account",
    (d, maps) => ({ resolution: { mappings: maps.map((m, i) => i === 0 ? { ...m, shop_id: null } : m) } }));
  await corruptV2("M3 account local_id != shop_id", "workflow_BIND_M3G", "account",
    (d, maps) => ({ resolution: { mappings: maps.map((m, i) => i === 0 ? { ...m, local_id: "shop_other" } : m) } }));
  await corruptV2("M3 non-account carrying scope fields", "workflow_BIND_M3H", "label",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], platform: "shopee", shop_id: "shop_s1" }] } }));
  await corruptV2("M3 account platform outside union", "workflow_BIND_M3I", "account",
    (d, maps) => ({ resolution: { mappings: maps.map((m, i) => i === 0 ? { ...m, platform: "myspace" } : m) } }));
  await corruptV2("M3 invalidated_at non-Date", "workflow_BIND_M3J", "user",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], invalidated_at: "bogus" }] } }));
  await corruptV2("M3 invalid_reason non-string", "workflow_BIND_M3K", "user",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], invalid_reason: 123 }] } }));
  await corruptV2("M3 binding status outside enum", "workflow_BIND_M3L", "label",
    () => ({ status: "bogus" }));
  await corruptV2("M3 resolved with non-valid coverage", "workflow_BIND_M3M", "label",
    (d, maps) => ({ resolution: { mappings: [{ ...maps[0], state: "invalid" }] } }));

  // ═══ 14. R1 Task 2 — basic exact repeat + cross-kind isolation + scope contract ═══
  console.log("\n=== 14. Repeat expansion — basic exact + cross-kind + scope ===");
  {
    const R = await setupRepeat("workflow_RPT_A");
    const expectedRepeated = [
      { binding_id: R.bA2().binding_id as string, source_index: 0 },
      { binding_id: R.bA3().binding_id as string, source_index: 0 },
      { binding_id: R.bL2().binding_id as string, source_index: 0 },
      { binding_id: R.bU2().binding_id as string, source_index: 0 },
    ].sort((x, y) => x.binding_id === y.binding_id ? x.source_index - y.source_index : (x.binding_id < y.binding_id ? -1 : 1));
    const res = await callResolve(R.wfId, R.req());
    ok(res != null && res.ok === true, `repeat batch → ok:true (${JSON.stringify(res)?.slice(0, 160)})`);
    eq(canonicalJson(res?.repeated), canonicalJson(expectedRepeated), "repeated[] = exact expanded (binding_id,source_index) pairs, sorted");
    eq(res?.resolved, 5, "resolved=5 (A1,L1,U1 direct + A3,U2 via repeat)");
    eq(res?.unresolved, 4, "unresolved=4 (A2,A4,L2,T1 — partial/untouched/team)");
    eq(res?.invalid, 0, "invalid=0");

    const vb = await R.versionBinds(res?.version_id);
    const mapsA1 = R.mapsOf(R.bA1(vb));
    eq(R.bA1(vb)?.status, "resolved", "A1 original proposal → resolved");
    ok(mapsA1.length === 2 && mapsA1.every((m) => m.via === "direct"),
      "A1 → only proposed mappings, all via:direct (no self-manufactured repeat rows)");
    const bA2v = R.bA2(vb);
    const mapsA2 = R.mapsOf(bA2v);
    eq(bA2v?.status, "unresolved", "A2 partial sibling → stays unresolved (no auto-complete)");
    eq(mapsA2.length, 1, "A2 → exactly the matched index persisted (unmatched index not fabricated)");
    eq(mapsA2[0]?.source_index, 0, "A2 → repeat applied at source_index 0 only");
    eq(mapsA2[0]?.local_id, "shop_s1", "A2 repeat → carries confirmed local_id");
    eq(mapsA2[0]?.platform, "shopee", "A2 repeat → carries confirmed platform");
    eq(mapsA2[0]?.shop_id, "shop_s1", "A2 repeat → carries confirmed shop_id");
    eq(mapsA2[0]?.via, "repeat", "A2 → via:repeat");
    eq(mapsA2[0]?.state, "valid", "A2 → repeat mapping validated (state:valid)");
    eq(mapsA2[0]?.source_fp, fp256("zacc_1"), "A2 → server-computed source_fp");
    const bA3v = R.bA3(vb);
    const mapsA3 = R.mapsOf(bA3v);
    eq(bA3v?.status, "resolved", "A3 full-coverage sibling → resolved via repeat");
    eq(mapsA3.length, 1, "A3 → complete coverage via repeat");
    eq(mapsA3[0]?.via, "repeat", "A3 → via:repeat");
    eq(mapsA3[0]?.local_id, "shop_s2", "A3 → proposal's confirmed target for zacc_2");
    eq(mapsA3[0]?.shop_id, "shop_s2", "A3 → confirmed shop_id (no inference)");
    const bA4v = R.bA4(vb);
    eq(bA4v?.status, "unresolved", "A4 near-miss sibling → untouched unresolved");
    eq(R.mapsOf(bA4v).length, 0, "A4 → zero mappings (case/whitespace/substring/numeric never repeat)");
    const bL2v = R.bL2(vb);
    const mapsL2 = R.mapsOf(bL2v);
    eq(bL2v?.status, "unresolved", "L2 partial sibling → unresolved");
    eq(mapsL2.length, 1, "L2 → only the label-matched index persisted");
    eq(mapsL2[0]?.source_index, 0, "L2 → repeat at label-matched index only");
    eq(mapsL2[0]?.local_id, "vip", "L2 → label repeat transfers only to label binding");
    eq(mapsL2[0]?.via, "repeat", "L2 → via:repeat");
    ok(mapsL2[0] != null && !("platform" in mapsL2[0]) && !("shop_id" in mapsL2[0]),
      "L2 → scope fields never written on non-account mapping");
    ok(!mapsL2.some((m) => m.source_index === 1),
      "L2[1] = zacc_1 inside label binding → NO account mapping transferred (cross-kind isolation)");
    const bU2v = R.bU2(vb);
    const mapsU2 = R.mapsOf(bU2v);
    eq(bU2v?.status, "resolved", "U2 user sibling → resolved via user repeat");
    eq(mapsU2[0]?.local_id, "adm_u1", "U2 → user repeat transfers only to user binding");
    ok(mapsU2[0] != null && !("platform" in mapsU2[0]) && !("shop_id" in mapsU2[0]),
      "U2 → no scope fields on user mapping");
    eq(R.bT1(vb)?.status, "unresolved", "T1 team → unresolved");
    const ev = resolveEvents().slice(-1)[0] as { metadata?: Record<string, unknown> } | undefined;
    eq(ev?.metadata?.repeated, expectedRepeated.length, "audit metadata repeated = repeated[].length");
    const wfR = (await svc.getWorkflow(R.wfId)) as Record<string, unknown>;
    eq(sorted(wfR?.platforms), '["shopee","tiktok"]', "repeat → derived platforms from direct+repeat account mappings");
    eq(sorted(wfR?.shop_ids), '["shop_s1","shop_s2"]', "repeat → derived shop_ids from direct+repeat account mappings");
  }

  // ═══ 15. R1 Task 2 — exact value authority (canonicalJson — no keyword/fuzzy) ═══
  console.log("\n=== 15. Repeat — exact value authority ===");
  {
    const R = await setupRepeat("workflow_RPT_B");
    // object value: คีย์สลับลำดับต้องนับ equal ตาม canonicalJson (ไม่ใช่ JSON.stringify)
    const bcoll = await mongo.getCollection(COLLECTIONS.workflowBindings);
    await bcoll.updateOne({ binding_id: R.bA1().binding_id as string },
      { $set: { source_values: ["zacc_1", { a: 1, b: 2 }] } });
    await bcoll.updateOne({ binding_id: R.bA2().binding_id as string },
      { $set: { source_values: ["zacc_1", { b: 2, a: 1 }] } });
    await bcoll.updateOne({ binding_id: R.bA4().binding_id as string },
      { $set: { source_values: ["ZACC_1", " zacc_1 ", "zacc_12", 1, { a: 1 }], count: 5 } });
    eq(fp256({ a: 1, b: 2 }), fp256({ b: 2, a: 1 }), "canonicalJson probe → object key-order equal");
    const reqB = {
      workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
      proposed: [{ binding_id: R.bA1().binding_id, repeat: true, mappings: [
        { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
        { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }],
    };
    const res = await callResolve(R.wfId, reqB);
    ok(res != null && res.ok === true, "object-value repeat batch → ok:true");
    const vb = await R.versionBinds(res?.version_id);
    // source_values เปลี่ยนแล้ว (mutate) → เลือก sibling ด้วย node/field/kind identity
    const key2 = (src: Record<string, unknown>) => vb.find((b) => b.node_id === src.node_id
      && b.field_path === src.field_path && b.kind === src.kind);
    const bA2v = key2(R.bA2());
    const mapsA2 = R.mapsOf(bA2v);
    eq(bA2v?.status, "resolved", "A2 → resolved (exact string + object key-order equality)");
    eq(mapsA2.length, 2, "A2 → both indexes repeated (zacc_1 exact + object canonical-equal)");
    eq(mapsA2[1]?.source_index, 1, "A2[1] → repeated by canonical object equality");
    eq(mapsA2[1]?.via, "repeat", "A2[1] → via:repeat");
    eq(mapsA2[1]?.source_fp, fp256({ b: 2, a: 1 }), "A2[1] → source_fp over canonical value");
    eq(mapsA2[1]?.local_id, "shop_s2", "A2[1] → proposal target for the object value");
    const bA4v = key2(R.bA4());
    eq(R.mapsOf(bA4v).length, 0,
      "near-miss values (case/whitespace/substring/numeric/partial-object) → never repeat");
    const expectedRep = [
      { binding_id: R.bA2().binding_id as string, source_index: 0 },
      { binding_id: R.bA2().binding_id as string, source_index: 1 },
    ];
    eq(canonicalJson(res?.repeated), canonicalJson(expectedRep), "repeated[] = only exact-equality expansions");
  }

  // ═══ 16. R1 Task 2 — same-binding isolation / coverage contract / default / unresolvable ═══
  console.log("\n=== 16. Repeat — isolation / coverage / default / unresolvable ===");
  {
    // G — repeat:true ไม่ยกเลิก complete-coverage ของ proposal เดิม
    const R = await setupRepeat("workflow_RPT_G");
    await expectReject("repeat:true + partial proposal coverage", R.wfId,
      { workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
        proposed: [{ binding_id: R.bA1().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] }] },
      (r) => ok(typeof r.validation === "string" && r.validation.includes("partial"),
        "repeat proposal → still held to complete-coverage contract"));

    // unresolvable kind + repeat → typed-switch reject (expansion ไม่ bypass target checks)
    const R2 = await setupRepeat("workflow_RPT_G2");
    await expectReject("repeat:true on team binding → unresolvable", R2.wfId,
      { workflow_id: R2.wfId, expected_version: R2.wfDoc.version, version_id: R2.verDoc.version_id,
        proposed: [{ binding_id: R2.bT1().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "team_any" } ] }] },
      (r) => ok(typeof r.validation === "string" && r.validation.includes("unresolvable"),
        "team repeat → unresolvable typed reject"));

    // H — repeat omitted → no expansion at all
    const R3 = await setupRepeat("workflow_RPT_H");
    const reqH = {
      workflow_id: R3.wfId, expected_version: R3.wfDoc.version, version_id: R3.verDoc.version_id,
      proposed: [
        { binding_id: R3.bA1().binding_id, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] },
        { binding_id: R3.bL1().binding_id, mappings: [ { source_index: 0, local_id: "vip" } ] },
        { binding_id: R3.bU1().binding_id, mappings: [
          { source_index: 0, local_id: "adm_u1" }, { source_index: 1, local_id: "adm_u2" } ] },
      ],
    };
    const resH = await callResolve(R3.wfId, reqH);
    ok(resH != null && resH.ok === true, "repeat omitted → resolves normally");
    eq((resH?.repeated as unknown[] | undefined)?.length, 0, "repeat omitted → repeated[] empty");
    const vbH = await R3.versionBinds(resH?.version_id);
    ok(R.mapsOf(R.bA1(vbH)).every((m) => m.via === "direct"), "repeat omitted → all mappings via:direct");
    for (const [tag, sel] of [["A2", R3.bA2], ["A3", R3.bA3], ["L2", R3.bL2], ["U2", R3.bU2]] as [string, (p?: never) => Record<string, unknown>][]) {
      const doc = sel(vbH as never);
      eq(doc?.status, "unresolved", `no-repeat → sibling ${tag} stays unresolved`);
      eq(R.mapsOf(doc).length, 0, `no-repeat → sibling ${tag} gets zero mappings`);
    }
    // repeat:false explicit → same as omitted
    const R4 = await setupRepeat("workflow_RPT_H2");
    const reqH2 = { ...reqH, workflow_id: R4.wfId, expected_version: R4.wfDoc.version, version_id: R4.verDoc.version_id,
      proposed: [
        { binding_id: R4.bA1().binding_id, repeat: false, mappings: reqH.proposed[0].mappings },
        { binding_id: R4.bL1().binding_id, repeat: false, mappings: reqH.proposed[1].mappings },
        { binding_id: R4.bU1().binding_id, repeat: false, mappings: reqH.proposed[2].mappings },
      ] };
    const resH2 = await callResolve(R4.wfId, reqH2);
    ok(resH2 != null && resH2.ok === true, "repeat:false → resolves normally");
    eq((resH2?.repeated as unknown[] | undefined)?.length, 0, "repeat:false → repeated[] empty");
    const vbH2 = await R4.versionBinds(resH2?.version_id);
    eq(R.mapsOf(R4.bA3(vbH2)).length, 0, "repeat:false → sibling untouched");
  }

  // ═══ 17. R1 Task 2 — no implicit overwrite (existing-mapping merge rules) ═══
  console.log("\n=== 17. Repeat — no implicit overwrite ===");
  {
    // F1 — existing EXACT same valid target → no-op (no duplicate row, not in repeated[])
    const R = await setupRepeat("workflow_RPT_F1");
    const reqStep1 = { workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
      proposed: [{ binding_id: R.bA2().binding_id, mappings: [
        { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
        { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] };
    const r1 = await callResolve(R.wfId, reqStep1);
    eq(r1?.ok, true, "F1 setup → sibling resolved directly first");
    const wfR = (await svc.getWorkflow(R.wfId)) as Record<string, unknown>;
    const vb2 = await R.versionBinds(wfR.current_version_id);
    const reqStep2 = { workflow_id: R.wfId, expected_version: wfR.version, version_id: wfR.current_version_id,
      proposed: [{ binding_id: R.bA1(vb2).binding_id, repeat: true, mappings: [
        { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
        { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] };
    const r2 = await callResolve(R.wfId, reqStep2);
    ok(r2 != null && r2.ok === true, "F1 → repeat against same-target sibling resolves (no-op merge)");
    const expectedRepF1 = [{ binding_id: R.bA3(vb2).binding_id as string, source_index: 0 }];
    eq(canonicalJson(r2?.repeated), canonicalJson(expectedRepF1),
      "F1 → repeated[] excludes no-op index (only newly applied listed)");
    const vb3 = await R.versionBinds(r2?.version_id);
    const mapsA2v3 = R.mapsOf(R.bA2(vb3));
    eq(mapsA2v3.length, 2, "F1 → sibling keeps exactly its 2 mappings (no duplicate row)");
    eq(mapsA2v3[0]?.local_id, "shop_s1", "F1 → existing valid mapping untouched (no overwrite)");
    ok(mapsA2v3.every((m) => m.via === "direct"), "F1 → existing direct mappings keep via:direct");

    // F2 — existing DIFFERENT valid mapping at same index → fail closed before writes
    const R5 = await setupRepeat("workflow_RPT_F2");
    const rF2a = await callResolve(R5.wfId, { workflow_id: R5.wfId, expected_version: R5.wfDoc.version,
      version_id: R5.verDoc.version_id,
      proposed: [{ binding_id: R5.bA2().binding_id, mappings: [
        { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
        { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });
    eq(rF2a?.ok, true, "F2 setup → sibling resolved directly first");
    const wfR5 = (await svc.getWorkflow(R5.wfId)) as Record<string, unknown>;
    const vbR5 = await R5.versionBinds(wfR5.current_version_id);
    await expectReject("repeat vs different valid existing mapping", R5.wfId,
      { workflow_id: R5.wfId, expected_version: wfR5.version, version_id: wfR5.current_version_id,
        proposed: [{ binding_id: R5.bA1(vbR5).binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      (r) => ok(typeof r.validation === "string" && !r.validation.includes("unsupported"),
        "different valid existing mapping → fail closed (requires explicit direct proposal)"));

    // F3 — existing INVALID/diverged mapping → still requires explicit direct (no hidden repeat repair)
    const R6 = await setupRepeat("workflow_RPT_F3");
    const rF3a = await callResolve(R6.wfId, { workflow_id: R6.wfId, expected_version: R6.wfDoc.version,
      version_id: R6.verDoc.version_id,
      proposed: [{ binding_id: R6.bA2().binding_id, mappings: [
        { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
        { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });
    eq(rF3a?.ok, true, "F3 setup → sibling resolved directly first");
    await (await mongo.getCollection(COLLECTIONS.shops)).deleteOne({ shop_id: "shop_s1" });
    const wfR6 = (await svc.getWorkflow(R6.wfId)) as Record<string, unknown>;
    const vbR6 = await R6.versionBinds(wfR6.current_version_id);
    await expectReject("repeat vs invalid carried mapping (target deleted)", R6.wfId,
      { workflow_id: R6.wfId, expected_version: wfR6.version, version_id: wfR6.current_version_id,
        proposed: [{ binding_id: R6.bA1(vbR6).binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      (r) => ok(typeof r.validation === "string" && !r.validation.includes("unsupported"),
        "invalid existing mapping → fail closed (no hidden repeat repair)"));
    await (await mongo.getCollection(COLLECTIONS.shops)).insertOne({ shop_id: "shop_s1", platform: "shopee", shopname: "S1", connected: true });

    // F4 — two repeat proposals same target → dedupe (one mapping, one repeated[] entry)
    const R7 = await setupRepeat("workflow_RPT_F4");
    await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne(
      { binding_id: R7.bA3().binding_id as string }, { $set: { source_values: ["zacc_1"] } });
    const rF4 = await callResolve(R7.wfId, { workflow_id: R7.wfId, expected_version: R7.wfDoc.version,
      version_id: R7.verDoc.version_id,
      proposed: [
        { binding_id: R7.bA1().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] },
        { binding_id: R7.bA2().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] },
      ] });
    ok(rF4 != null && rF4.ok === true, "F4 → same-target repeat proposals dedupe");
    const vbF4 = await R7.versionBinds(rF4?.version_id);
    const mapsA3F4 = R.mapsOf((vbF4 as Record<string, unknown>[]).find((b) => b.kind === "account" && (b.source_values as unknown[])[0] === "zacc_1" && (b.source_values as unknown[]).length === 1));
    eq(mapsA3F4.length, 1, "F4 → shared sibling index gets exactly one repeat mapping");
    eq((rF4?.repeated as unknown[] | undefined)?.length, 1, "F4 → repeated[] lists the deduped index once");

    // F5 — two repeat proposals different target at same sibling index → fail closed
    const R8 = await setupRepeat("workflow_RPT_F5");
    await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne(
      { binding_id: R8.bA3().binding_id as string }, { $set: { source_values: ["zacc_1"] } });
    await expectReject("repeat-vs-repeat conflicting targets", R8.wfId,
      { workflow_id: R8.wfId, expected_version: R8.wfDoc.version, version_id: R8.verDoc.version_id,
        proposed: [
          { binding_id: R8.bA1().binding_id, repeat: true, mappings: [
            { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
            { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] },
          { binding_id: R8.bA2().binding_id, repeat: true, mappings: [
            { source_index: 0, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" },
            { source_index: 1, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" } ] },
        ] },
      (r) => ok(typeof r.validation === "string" && !r.validation.includes("unsupported"),
        "repeat-vs-repeat conflict → fail closed (no silent winner)"));
  }

  // ═══ 18. R1 Task 2 — determinism + crash/retry with repeat artifacts ═══
  console.log("\n=== 18. Repeat — determinism + crash/retry ===");
  {
    // I — reversed proposal/mapping order → same deterministic artifacts (same-fixture crash-retry)
    const R = await setupRepeat("workflow_RPT_I");
    armUpdateFail(COLLECTIONS.workflows, 1);
    const thrI = await act(() => svcAny.saveBindingResolutionBatch?.(R.wfId, R.req(), "admin_t"));
    disarm();
    ok(thrI != null, "repeat → first attempt crashed at commit (orphan artifacts)");
    const orphanI = (await collDocs(COLLECTIONS.workflowVersions))
      .find((v) => v.workflow_id === R.wfId && v.version_seq === 2) as Record<string, unknown> | undefined;
    ok(orphanI != null, "repeat → orphan version artifact exists after crash");
    const reqRev = {
      workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
      proposed: [...R.req().proposed].reverse().map((p) => ({ ...p, mappings: [...p.mappings].reverse() })),
    };
    const rI = await callResolve(R.wfId, reqRev);
    eq(rI?.ok, true, "repeat → reversed-order retry resolves");
    eq(rI?.version_id, orphanI?.version_id, "repeat → order-independent fingerprint → same version_id");
    const vbI = await R.versionBinds(rI?.version_id);
    ok(R.mapsOf(R.bA2(vbI)).every((m) => m.source_index === 0), "repeat → expanded mappings sorted by source_index");
    ok((rI?.repeated as Record<string, unknown>[] | undefined)?.every((r2, i, a) => i === 0
      || String(a[i - 1].binding_id) < String(r2.binding_id)
      || (a[i - 1].binding_id === r2.binding_id && (a[i - 1].source_index as number) < (r2.source_index as number))) === true,
      "repeat → repeated[] sorted binding_id then source_index");

    // I2 — BSON round-trip artifacts → retry reuses same version_id (with repeat payload)
    const R9 = await setupRepeat("workflow_RPT_I2");
    armUpdateFail(COLLECTIONS.workflows, 1);
    const thrI2 = await act(() => svcAny.saveBindingResolutionBatch?.(R9.wfId, R9.req(), "admin_t"));
    disarm();
    ok(thrI2 != null, "repeat BSON → first attempt crashed at commit");
    const orphanI2 = (await collDocs(COLLECTIONS.workflowVersions))
      .find((v) => v.workflow_id === R9.wfId && v.version_seq === 2) as Record<string, unknown> | undefined;
    for (const collName of [COLLECTIONS.workflowVersions, COLLECTIONS.workflowBindings]) {
      const c = await mongo.getCollection(collName);
      const docs = await c.find({ workflow_id: R9.wfId }).toArray() as Record<string, unknown>[];
      for (const d of docs) {
        const rt = bsonDeserialize(bsonSerialize(d)) as Record<string, unknown>;
        await c.deleteOne({ _id: d._id });
        await c.insertOne(rt);
      }
    }
    const rI2 = await callResolve(R9.wfId, R9.req());
    eq(rI2?.ok, true, "repeat BSON → retry after round-trip resolves");
    eq(rI2?.version_id, orphanI2?.version_id, "repeat BSON → retry reuses same version_id");

    // J — crash @first binding insert → pointer unchanged + retry reuses deterministic artifacts
    const R10 = await setupRepeat("workflow_RPT_J1");
    const wfJ0 = canonicalJson(await svc.getWorkflow(R10.wfId));
    const evJ0 = resolveEvents().length;
    armInsertFail(COLLECTIONS.workflowBindings, 1);
    const thrJ1 = await act(() => svcAny.saveBindingResolutionBatch?.(R10.wfId, R10.req(), "admin_t"));
    ok(thrJ1 != null, "repeat crash @first binding insert → throws");
    disarm();
    eq(canonicalJson(await svc.getWorkflow(R10.wfId)), wfJ0, "repeat crash → pointer+scope byte-identical");
    eq(resolveEvents().length, evJ0, "repeat crash → zero success audit");
    const rJ1 = await callResolve(R10.wfId, R10.req());
    eq(rJ1?.ok, true, "repeat crash → retry resolves");
    const vbJ1 = await R10.versionBinds(rJ1?.version_id);
    eq(R.mapsOf(R.bA3(vbJ1))[0]?.via, "repeat", "repeat retry → expanded artifacts persisted deterministically");
    eq((await collDocs(COLLECTIONS.workflowVersions)).filter((v) => v.workflow_id === R10.wfId).length, 2,
      "repeat retry → zero duplicate version docs");

    // J2 — crash mid-bindings → retry completes exact set, zero dup ids
    const R11 = await setupRepeat("workflow_RPT_J2");
    armInsertFail(COLLECTIONS.workflowBindings, 5);
    const thrJ2 = await act(() => svcAny.saveBindingResolutionBatch?.(R11.wfId, R11.req(), "admin_t"));
    ok(thrJ2 != null, "repeat crash mid-bindings → throws");
    disarm();
    const rJ2 = await callResolve(R11.wfId, R11.req());
    eq(rJ2?.ok, true, "repeat mid-bindings → retry resolves");
    const bindsJ2 = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => b.version_id === rJ2?.version_id);
    eq(bindsJ2.length, 9, "repeat mid-bindings → binding set complete (9)");
    eq(new Set(bindsJ2.map((b) => b.binding_id as string)).size, 9, "repeat mid-bindings → zero duplicate binding_ids");

    // J3 — CAS loser reports fresh winner state (repeat payload)
    const R12 = await setupRepeat("workflow_RPT_J3");
    let flippedJ = false;
    st.updateOneHook = async (coll: string) => {
      if (coll === COLLECTIONS.workflows && !flippedJ) {
        flippedJ = true;
        st.updateOneHook = undefined;
        await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne(
          { workflow_id: R12.wfId }, { $set: { version: 7, current_version_id: "wv_winner_repeat" } });
      }
    };
    const rJ3 = await callResolve(R12.wfId, R12.req());
    disarm();
    eq(rJ3?.ok, false, "repeat CAS loser → rejected");
    eq(rJ3?.conflict, true, "repeat CAS loser → conflict");
    eq(rJ3?.current_version, 7, "repeat CAS loser → fresh winner version reported");
    eq(rJ3?.current_version_id, "wv_winner_repeat", "repeat CAS loser → fresh winner version_id reported");

    // J4 — concurrent identical repeat requests → exactly one pointer winner
    const R13 = await setupRepeat("workflow_RPT_J4");
    const fnJ4 = svcAny.saveBindingResolutionBatch;
    const [sJ4a, sJ4b] = await Promise.allSettled([
      typeof fnJ4 === "function" ? fnJ4(R13.wfId, R13.req(), "admin_t") : Promise.resolve(undefined),
      typeof fnJ4 === "function" ? fnJ4(R13.wfId, R13.req(), "admin_t") : Promise.resolve(undefined),
    ]);
    const valsJ4 = [sJ4a, sJ4b].map((s) => (s.status === "fulfilled" ? (s as PromiseFulfilledResult<Record<string, unknown> | undefined>).value : undefined));
    eq(valsJ4.filter((v) => v?.ok === true).length, 1, "concurrent repeat → exactly one winner");
    ok(valsJ4.some((v) => v?.conflict === true), "concurrent repeat → loser conflict");
    const wfJ4 = (await svc.getWorkflow(R13.wfId)) as Record<string, unknown>;
    const pointJ4 = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.version_id === wfJ4?.current_version_id);
    ok(pointJ4 != null, "concurrent repeat → pointer references real winner doc");
  }

  // ═══ 19. R1 Task 2 — safety regressions (repeat must not weaken any gate) ═══
  console.log("\n=== 19. Repeat — safety regressions ===");
  {
    const R = await setupRepeat("workflow_RPT_K");
    // client-supplied identity keys + repeat → forbidden-key reject ยังอยู่
    await expectReject("repeat + client-supplied source_value", R.wfId,
      { workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
        proposed: [{ binding_id: R.bA1().binding_id, repeat: true, source_value: "zacc_1", mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      (r) => ok(typeof r.validation === "string" && r.validation.includes("forbidden"),
        "repeat + forbidden key → forbidden reject"));
    await expectReject("repeat + client-supplied kind", R.wfId,
      { workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
        proposed: [{ binding_id: R.bA1().binding_id, repeat: true, kind: "account", mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      (r) => ok(typeof r.validation === "string" && r.validation.includes("forbidden"),
        "repeat + kind key → forbidden reject"));
    // out-of-scope binding + repeat → scope reject (ไม่ใช่ unsupported)
    const Rother = await setupRepeat("workflow_RPT_K2");
    await expectReject("repeat on out-of-scope binding", R.wfId,
      { workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
        proposed: [{ binding_id: Rother.bA1().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      (r) => ok(typeof r.validation === "string" && r.validation.includes("scope"),
        "repeat on foreign binding → out-of-scope reject"));
    // repeat non-boolean → type reject เดิมยังอยู่
    await expectReject("repeat non-boolean", R.wfId,
      { workflow_id: R.wfId, expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
        proposed: [{ binding_id: R.bA1().binding_id, repeat: "yes", mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      (r) => ok(typeof r.validation === "string" && r.validation.includes("boolean"),
        "repeat non-boolean → type reject"));
    // binding from another version + repeat → scope reject
    const Rold = await setupRepeat("workflow_RPT_K3");
    const rOld = await callResolve(Rold.wfId, Rold.req());
    eq(rOld?.ok, true, "K3 setup resolve ok");
    const wfOld = (await svc.getWorkflow(Rold.wfId)) as Record<string, unknown>;
    await expectReject("repeat on stale-version binding", Rold.wfId,
      { workflow_id: Rold.wfId, expected_version: wfOld.version, version_id: wfOld.current_version_id,
        proposed: [{ binding_id: Rold.bA1().binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_s1", platform: "shopee", shop_id: "shop_s1" },
          { source_index: 1, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] },
      (r) => ok(typeof r.validation === "string" && r.validation.includes("scope"),
        "repeat on stale-version binding → out-of-scope reject"));
  }

  // ═══ 20. R1 Task 3 — fail-closed derived account scope ═══
  console.log("\n=== 20. Account scope — zero valid mappings (A) ===");
  const BLOCKER_NONE = "account_scope: no resolved account mappings";
  const BLOCKER_PARTIAL = "account_scope: incomplete account mappings";

  {
    // A — account requirements exist + zero valid mappings: non-account resolution
    // commits disabled/draft + derived [] + exact blocker — empty scope ≠ authorization
    const fx = await setupImported("workflow_T3_A");
    const res = await callResolve(fx.wfId, { workflow_id: fx.wfId,
      expected_version: fx.wfDoc.version, version_id: fx.verDoc.version_id,
      proposed: [{ binding_id: fx.byKind("label").binding_id, mappings: [
        { source_index: 0, local_id: "vip" } ] }] });
    ok(res != null && res.ok === true, `A → non-account resolution still commits (${JSON.stringify(res)?.slice(0, 140)})`);
    eq(canonicalJson(res?.publish_blockers), canonicalJson([BLOCKER_NONE]),
      "A → publish_blockers = exactly [account_scope: no resolved account mappings]");
    const wfA = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    eq(wfA?.enabled, false, "A → stays disabled");
    eq(wfA?.status, "draft", "A → stays draft");
    eq(wfA?.current_version_id, res?.version_id, "A → pointer+scope land atomically");
    eq(canonicalJson(wfA?.platforms), "[]", "A → derived platforms = []");
    eq(canonicalJson(wfA?.shop_ids), "[]", "A → derived shop_ids = []");
    const vdocA = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.version_id === res?.version_id);
    eq(canonicalJson(vdocA?.platforms), "[]", "A → version doc platforms = []");
    eq(canonicalJson(vdocA?.shop_ids), "[]", "A → version doc shop_ids = []");
    const detA = await svc.getWorkflowImportDetail(fx.wfId) as { publish_blockers?: string[] } | null;
    ok((detA?.publish_blockers ?? []).includes(BLOCKER_NONE), "A → getWorkflowImportDetail reports same blocker");
    ok(!(await svc.listWorkflows({ enabledOnly: true, publishedOnly: true, shopId: "shop_s1", platform: "shopee" }))
      .some((w) => w.workflow_id === fx.wfId), "A → listWorkflows(enabledOnly+publishedOnly+scope) never exposes it");
  }

  console.log("\n=== 21. Account scope — partial resolution (B) ===");
  {
    // B — resolve เฉพาะบาง account requirement → derived เฉพาะ valid resolved;
    // unresolved account bindings คง block readiness; ไม่ infer scope เพิ่ม
    const R = await setupRepeat("workflow_T3_B");
    const res = await callResolve(R.wfId, { workflow_id: R.wfId,
      expected_version: R.wfDoc.version, version_id: R.verDoc.version_id,
      proposed: [{ binding_id: R.bA3().binding_id, mappings: [
        { source_index: 0, local_id: "shop_s2", platform: "tiktok", shop_id: "shop_s2" } ] }] });
    ok(res != null && res.ok === true, "B → partial account resolution commits");
    eq(canonicalJson(res?.publish_blockers), canonicalJson([BLOCKER_PARTIAL]),
      "B → exactly one deterministic incomplete blocker");
    const wfB = (await svc.getWorkflow(R.wfId)) as Record<string, unknown>;
    eq(canonicalJson(wfB?.platforms), '["tiktok"]', "B → derived platforms = only resolved account's platform");
    eq(canonicalJson(wfB?.shop_ids), '["shop_s2"]', "B → derived shop_ids = only resolved account's shop");
    eq(wfB?.enabled, false, "B → stays disabled");
    eq(wfB?.status, "draft", "B → stays draft");
    const detB = await svc.getWorkflowImportDetail(R.wfId) as { publish_blockers?: string[] } | null;
    ok((detB?.publish_blockers ?? []).includes(BLOCKER_PARTIAL), "B → getWorkflowImportDetail reports incomplete blocker");
  }

  console.log("\n=== 22. Account scope — invalid carried target (C) ===");
  {
    // C — resolve accounts ก่อน → ลบ shop target → re-resolution ถัดไป re-validate
    // carried → state:invalid + ออกจาก derived + ยัง block; ไม่มี hidden repair
    const fx = await setupImported("workflow_T3_C");
    const r1 = await callResolve(fx.wfId, fx.req());
    eq(r1?.ok, true, "C setup → accounts resolved");
    const wfC1 = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    const vbC = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === fx.wfId && b.version_id === wfC1.current_version_id);
    const labC = vbC.find((b) => b.kind === "label") as Record<string, unknown>;
    await (await mongo.getCollection(COLLECTIONS.shops)).deleteOne({ shop_id: "shop_s1" });
    const r2 = await callResolve(fx.wfId, { workflow_id: fx.wfId,
      expected_version: wfC1.version, version_id: wfC1.current_version_id,
      proposed: [{ binding_id: labC.binding_id, mappings: [{ source_index: 0, local_id: "vip" }] }] });
    await (await mongo.getCollection(COLLECTIONS.shops)).insertOne({ shop_id: "shop_s1", platform: "shopee", shopname: "S1", connected: true });
    ok(r2 != null && r2.ok === true, "C → carried invalid target does not fail the save (disabled draft)");
    eq(canonicalJson(r2?.publish_blockers), canonicalJson([BLOCKER_PARTIAL]),
      "C → incomplete blocker (one account mapping invalidated)");
    const wfC2 = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    eq(canonicalJson(wfC2?.shop_ids), '["shop_s2"]', "C → deleted target excluded from derived shop_ids");
    eq(canonicalJson(wfC2?.platforms), '["tiktok"]', "C → deleted target's platform excluded");
    const accC = ((await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.version_id === r2?.version_id))
      .find((b) => b.kind === "account") as Record<string, unknown>;
    eq(accC?.status, "invalid", "C → account binding marked invalid");
    const mapsC = ((accC?.resolution as { mappings?: Record<string, unknown>[] })?.mappings ?? [])
      .slice().sort((x, y) => (x.source_index as number) - (y.source_index as number));
    eq(mapsC[0]?.state, "invalid", "C → deleted-target mapping state:invalid (no hidden repair)");
    eq(mapsC[0]?.shop_id, "shop_s1", "C → original target preserved (no replacement shop)");
    ok(mapsC[0]?.invalidated_at != null, "C → invalidated_at recorded");
    eq(mapsC[1]?.state, "valid", "C → surviving target still valid");
  }

  console.log("\n=== 23. Account scope — last valid mapping disappears (D) ===");
  {
    // D — valid mapping สุดท้ายหาย → derived กลับ [] + no-resolved blocker + ineligible
    const fx = await setupImported("workflow_T3_D");
    const r1 = await callResolve(fx.wfId, fx.req());
    eq(r1?.ok, true, "D setup → accounts resolved");
    const wfD1 = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    eq(sorted(wfD1?.shop_ids), '["shop_s1","shop_s2"]', "D setup → derived had both shops");
    const vbD = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === fx.wfId && b.version_id === wfD1.current_version_id);
    const labD = vbD.find((b) => b.kind === "label") as Record<string, unknown>;
    const shopsColl = await mongo.getCollection(COLLECTIONS.shops);
    await shopsColl.deleteOne({ shop_id: "shop_s1" });
    await shopsColl.deleteOne({ shop_id: "shop_s2" });
    const r2 = await callResolve(fx.wfId, { workflow_id: fx.wfId,
      expected_version: wfD1.version, version_id: wfD1.current_version_id,
      proposed: [{ binding_id: labD.binding_id, mappings: [{ source_index: 0, local_id: "vip" }] }] });
    await shopsColl.insertOne({ shop_id: "shop_s1", platform: "shopee", shopname: "S1", connected: true });
    await shopsColl.insertOne({ shop_id: "shop_s2", platform: "tiktok", shopname: "S2", connected: true });
    ok(r2 != null && r2.ok === true, "D → save still commits as disabled draft");
    eq(canonicalJson(r2?.publish_blockers), canonicalJson([BLOCKER_NONE]),
      "D → zero valid account mappings → no-resolved blocker");
    const wfD2 = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    eq(canonicalJson(wfD2?.platforms), "[]", "D → derived platforms back to []");
    eq(canonicalJson(wfD2?.shop_ids), "[]", "D → derived shop_ids back to []");
    eq(wfD2?.enabled, false, "D → still disabled");
    eq(wfD2?.status, "draft", "D → still draft");
    const detD = await svc.getWorkflowImportDetail(fx.wfId) as { publish_blockers?: string[] } | null;
    ok((detD?.publish_blockers ?? []).includes(BLOCKER_NONE), "D → getWorkflowImportDetail reports no-resolved blocker");
    ok(!(await svc.listWorkflows({ enabledOnly: true, publishedOnly: true, shopId: "shop_s2", platform: "tiktok" }))
      .some((w) => w.workflow_id === fx.wfId), "D → engine-visible list excludes it");
  }

  console.log("\n=== 24. Account scope — fully resolved (E) ===");
  {
    // E — account requirements ครบทุก source ด้วย valid mapping → ไม่มี account_scope
    // blocker; scope server-derived เท่านั้น; non-account blockers ไม่เปลี่ยน
    const fx = await setupImported("workflow_T3_E");
    const res = await callResolve(fx.wfId, fx.req());
    eq(res?.ok, true, "E → full account resolution commits");
    eq(canonicalJson(res?.publish_blockers), "[]", "E → publish_blockers empty (no account_scope)");
    const wfE = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    eq(sorted(wfE?.platforms), '["shopee","tiktok"]', "E → derived platforms = unique sorted from mappings");
    eq(sorted(wfE?.shop_ids), '["shop_s1","shop_s2"]', "E → derived shop_ids = unique sorted from mappings");
    const v1E = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => v.version_id === fx.verDoc.version_id);
    eq(canonicalJson(v1E?.platforms), canonicalJson(fx.verDoc.platforms), "E → v1 version scope unchanged (old version immutable)");
    eq(canonicalJson(v1E?.shop_ids), canonicalJson(fx.verDoc.shop_ids), "E → v1 version shop_ids unchanged");
    const detE = await svc.getWorkflowImportDetail(fx.wfId) as { publish_blockers?: string[] } | null;
    ok(!(detE?.publish_blockers ?? []).some((b) => String(b).startsWith("account_scope")),
      "E → getWorkflowImportDetail has no account_scope blocker (non-account blockers unchanged)");
  }

  console.log("\n=== 25. Scope — no account requirements (F, corrected M2) ===");
  const BLOCKER_GLOBAL = "scope: explicit global scope approval required";
  {
    // F — workflow ไม่มี account-kind requirement → ไม่มี account_scope blocker
    // (ห้าม invent requirements) แต่ empty imported scope ≠ authorization →
    // global-scope blocker เดียว
    const fx = await setupNoAcc("workflow_T3_F");
    ok(fx.binds.length > 0 && fx.binds.every((b) => b.kind !== "account"), "F fixture → zero account-kind bindings");
    const res = await callResolve(fx.wfId, fx.req());
    eq(res?.ok, true, "F → label+user resolution commits");
    eq(canonicalJson(res?.publish_blockers), canonicalJson([BLOCKER_GLOBAL]),
      "F → exactly [scope: explicit global scope approval required] (no account_scope)");
    const wfF = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    eq(canonicalJson(wfF?.platforms), "[]", "F → derived platforms []");
    eq(canonicalJson(wfF?.shop_ids), "[]", "F → derived shop_ids []");
    eq(wfF?.enabled, false, "F → stays disabled");
    eq(wfF?.status, "draft", "F → stays draft");
    const detF = await svc.getWorkflowImportDetail(fx.wfId) as { publish_blockers?: string[] } | null;
    ok((detF?.publish_blockers ?? []).includes(BLOCKER_GLOBAL), "F → getWorkflowImportDetail reports global-scope blocker");
    ok(!(detF?.publish_blockers ?? []).some((b) => String(b).startsWith("account_scope")),
      "F → getWorkflowImportDetail has no account_scope blocker (none invented)");
    ok(!(await svc.listWorkflows({ enabledOnly: true, publishedOnly: true, shopId: "shop_s1", platform: "shopee" }))
      .some((w) => w.workflow_id === fx.wfId), "F → engine-visible list excludes it");
  }

  console.log("\n=== 26. Account scope — atomicity / regression pins (G) ===");
  {
    // stale expected_version → pointer + derived scope unchanged
    const fx1 = await setupImported("workflow_T3_G1");
    const wfG0 = canonicalJson(await svc.getWorkflow(fx1.wfId));
    await expectReject("G stale expected_version (unresolved accounts)", fx1.wfId,
      { ...fx1.req(), expected_version: 99 });
    eq(canonicalJson(await svc.getWorkflow(fx1.wfId)), wfG0, "G stale → pointer+scope byte-identical");

    // crash before pointer CAS → old pointer + old derived scope stay together
    const fx2 = await setupImported("workflow_T3_G2");
    const wfG20 = canonicalJson(await svc.getWorkflow(fx2.wfId));
    armUpdateFail(COLLECTIONS.workflows, 1);
    const thrG = await act(() => svcAny.saveBindingResolutionBatch?.(fx2.wfId,
      { workflow_id: fx2.wfId, expected_version: fx2.wfDoc.version, version_id: fx2.verDoc.version_id,
        proposed: [{ binding_id: fx2.byKind("label").binding_id, mappings: [{ source_index: 0, local_id: "vip" }] }] }, "admin_t"));
    disarm();
    ok(thrG != null, "G crash before commit CAS → throws");
    eq(canonicalJson(await svc.getWorkflow(fx2.wfId)), wfG20, "G crash → old pointer+old scope together (no half-flip)");

    // CAS conflict → no half-written scope
    const fx3 = await setupImported("workflow_T3_G3");
    let flippedG = false;
    st.updateOneHook = async (coll: string) => {
      if (coll === COLLECTIONS.workflows && !flippedG) {
        flippedG = true;
        st.updateOneHook = undefined;
        await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne(
          { workflow_id: fx3.wfId }, { $set: { version: 42 } });
      }
    };
    const rG3 = await callResolve(fx3.wfId, { workflow_id: fx3.wfId,
      expected_version: fx3.wfDoc.version, version_id: fx3.verDoc.version_id,
      proposed: [{ binding_id: fx3.byKind("label").binding_id, mappings: [{ source_index: 0, local_id: "vip" }] }] });
    disarm();
    eq(rG3?.conflict, true, "G CAS conflict → conflict response");
    const wfG3 = (await svc.getWorkflow(fx3.wfId)) as Record<string, unknown>;
    eq(canonicalJson(wfG3?.platforms), canonicalJson(fx3.wfDoc.platforms), "G conflict → platforms not half-written");
    eq(canonicalJson(wfG3?.shop_ids), canonicalJson(fx3.wfDoc.shop_ids), "G conflict → shop_ids not half-written");
    eq(wfG3?.current_version_id, fx3.wfDoc.current_version_id, "G conflict → pointer stays at old version");

    // Task 2 repeat semantics preserved: kind=account + state=valid contributes;
    // label/user repeats never contribute; partial account coverage still blocked
    const R = await setupRepeat("workflow_T3_G4");
    const rG4 = await callResolve(R.wfId, R.req());
    eq(rG4?.ok, true, "G repeat batch resolves");
    eq(canonicalJson(rG4?.publish_blockers), canonicalJson([BLOCKER_PARTIAL]),
      "G → repeat leaves partial account coverage → incomplete blocker");
    const wfG4 = (await svc.getWorkflow(R.wfId)) as Record<string, unknown>;
    eq(sorted(wfG4?.platforms), '["shopee","tiktok"]', "G → repeat scope = valid account mappings only");
    eq(sorted(wfG4?.shop_ids), '["shop_s1","shop_s2"]', "G → repeat scope has no label/user local_ids");
    const vbG4 = await R.versionBinds(rG4?.version_id);
    const accG4 = vbG4.find((b) => b.kind === "account" && (b.source_values as unknown[]).length === 1);
    eq(accG4?.status, "resolved", "G → sibling account binding resolved solely via repeat");
    eq(R.mapsOf(accG4)[0]?.via, "repeat", "G → its valid mapping is via:repeat (repeat contributes to scope)");

    // label mapping named like a shop → never enters account scope
    await (await mongo.getCollection(COLLECTIONS.conversations))
      .insertOne({ conversation_id: "conv_trap", labels: ["shop_s1"] });
    const fx5 = await setupNoAcc("workflow_T3_G5");
    const rG5 = await callResolve(fx5.wfId, { workflow_id: fx5.wfId,
      expected_version: fx5.wfDoc.version, version_id: fx5.verDoc.version_id,
      proposed: [
        { binding_id: fx5.byKind("label").binding_id, mappings: [{ source_index: 0, local_id: "shop_s1" }] },
        { binding_id: fx5.byKind("user").binding_id, mappings: [{ source_index: 0, local_id: "adm_u1" }] },
      ] });
    eq(rG5?.ok, true, "G → shop-named label resolves");
    const wfG5 = (await svc.getWorkflow(fx5.wfId)) as Record<string, unknown>;
    eq(canonicalJson(wfG5?.shop_ids), "[]", "G → label local_id 'shop_s1' never enters account scope");
    eq(canonicalJson(wfG5?.platforms), "[]", "G → no platform leaked from label/user mappings");
  }

  // ═══ 27. Task 3 correction M1 — sticky invalid status with count-complete mappings ═══
  console.log("\n=== 27. Account scope — invalid status + complete mappings stays blocked (M1) ===");
  {
    // resolve accounts → ลบ shop → carried invalid (status invalid) → restore shop
    // → carried revalidate กลับ valid ครบ count แต่ status ค้าง "invalid"
    // (sticky-invalid path — contract เดิม: explicit direct resolution เท่านั้นที่
    // repair ได้) → readiness ต้องยัง blocked
    const fx = await setupImported("workflow_T3_M1");
    const r1 = await callResolve(fx.wfId, fx.req());
    eq(r1?.ok, true, "M1 setup → accounts resolved");
    const wfM1 = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    const vbM1 = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === fx.wfId && b.version_id === wfM1.current_version_id);
    const labM1 = vbM1.find((b) => b.kind === "label") as Record<string, unknown>;

    await (await mongo.getCollection(COLLECTIONS.shops)).deleteOne({ shop_id: "shop_s1" });
    const r2 = await callResolve(fx.wfId, { workflow_id: fx.wfId,
      expected_version: wfM1.version, version_id: wfM1.current_version_id,
      proposed: [{ binding_id: labM1.binding_id, mappings: [{ source_index: 0, local_id: "vip" }] }] });
    eq(r2?.ok, true, "M1 → invalid carried target commits");
    const wfM2 = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    const accM1a = ((await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.version_id === wfM2.current_version_id))
      .find((b) => b.kind === "account") as Record<string, unknown>;
    eq(accM1a?.status, "invalid", "M1 → binding status invalid after target delete");

    await (await mongo.getCollection(COLLECTIONS.shops)).insertOne({ shop_id: "shop_s1", platform: "shopee", shopname: "S1", connected: true });
    const vbM1b = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === fx.wfId && b.version_id === wfM2.current_version_id);
    const labM1b = vbM1b.find((b) => b.kind === "label") as Record<string, unknown>;
    const r3 = await callResolve(fx.wfId, { workflow_id: fx.wfId,
      expected_version: wfM2.version, version_id: wfM2.current_version_id,
      proposed: [{ binding_id: labM1b.binding_id, mappings: [{ source_index: 0, local_id: "vip" }] }] });
    ok(r3 != null && r3.ok === true, "M1 → revalidating resolution commits");
    const accM1b = ((await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.version_id === r3?.version_id))
      .find((b) => b.kind === "account") as Record<string, unknown>;
    const mapsM1 = ((accM1b?.resolution as { mappings?: Record<string, unknown>[] })?.mappings ?? [])
      .filter((m) => m.state === "valid" && m.platform != null && m.shop_id != null);
    eq(mapsM1.length, 2, "M1 → both carried mappings revalidated to valid (count-complete eligible)");
    eq(accM1b?.status, "invalid", "M1 → binding status stays invalid — no hidden repair");
    eq(canonicalJson(r3?.publish_blockers), canonicalJson([BLOCKER_PARTIAL]),
      "M1 → invalid status + count-complete mappings still blocked (incomplete)");
    const detM1 = await svc.getWorkflowImportDetail(fx.wfId) as { publish_blockers?: string[] } | null;
    ok((detM1?.publish_blockers ?? []).includes(BLOCKER_PARTIAL), "M1 → getWorkflowImportDetail reports incomplete blocker");
    const wfM3 = (await svc.getWorkflow(fx.wfId)) as Record<string, unknown>;
    eq(wfM3?.enabled, false, "M1 → stays disabled");
    eq(wfM3?.status, "draft", "M1 → stays draft");

    // persisted read-model pin — status unresolved/invalid despite count-complete
    // valid mappings → detail ต้อง fail closed (ไม่เชื่อ count อย่างเดียว)
    const bindsColl = await mongo.getCollection(COLLECTIONS.workflowBindings);
    await bindsColl.updateOne({ binding_id: accM1b?.binding_id }, { $set: { status: "unresolved" } });
    const detPinU = await svc.getWorkflowImportDetail(fx.wfId) as { publish_blockers?: string[] } | null;
    ok((detPinU?.publish_blockers ?? []).includes(BLOCKER_PARTIAL),
      "M1 pin → detail fails closed on status:unresolved + complete mappings");
    await bindsColl.updateOne({ binding_id: accM1b?.binding_id }, { $set: { status: "resolved" } });
    const detPinR = await svc.getWorkflowImportDetail(fx.wfId) as { publish_blockers?: string[] } | null;
    ok(!(detPinR?.publish_blockers ?? []).some((b) => String(b).startsWith("account_scope")),
      "M1 pin → status:resolved + complete mappings clears blocker (contract intact)");
  }

  // ═══ 28. Task 5 — overlap readiness ═══
  console.log("\n=== 28. Task 5 — overlap readiness ===");
  // dedicated shops — scope ไม่ชน fixture เก่า (Task 1-4 sections resolve shop_s*/conv_lab)
  const shopsColl5 = await mongo.getCollection(COLLECTIONS.shops);
  for (const [sid, plat] of [["shop_o1", "shopee"], ["shop_o2", "shopee"], ["shop_o3", "tiktok"],
    ["shop_o4", "shopee"], ["shop_o5", "shopee"], ["shop_od", "shopee"]] as const) {
    await shopsColl5.insertOne({ shop_id: sid, platform: plat, shopname: sid, connected: true });
  }

  async function setupOv(srcWfId: string, srcBase: unknown) {
    const src = { ...(srcBase as Record<string, unknown>), workflowId: srcWfId,
      loadedVersionId: `wv-src-${srcWfId}`, versions: [{ workflowVersionId: `wv-src-${srcWfId}`, status: "active" }] };
    const batch = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: srcWfId, name: `ov ${srcWfId}` }] });
    await svcAny.applyImportBatch(batch, "admin_t");
    return { wfId: "wf_imp_" + _sh(srcWfId) };
  }
  // fresh-state request — version/binding เปลี่ยนทุก save → re-read ทุกครั้ง
  async function ovReq(wfId: string, platform: string, shopId: string) {
    const w = (await svc.getWorkflow(wfId)) as Record<string, unknown>;
    const v = (await collDocs(COLLECTIONS.workflowVersions))
      .find((x) => x.workflow_id === wfId && x.version_id === w.current_version_id) as Record<string, unknown>;
    const acc = (await collDocs(COLLECTIONS.workflowBindings))
      .find((b) => b.workflow_id === wfId && b.version_id === v.version_id && b.kind === "account") as Record<string, unknown>;
    return {
      workflow_id: wfId, expected_version: w.version as number, version_id: v.version_id as string,
      proposed: [{ binding_id: acc.binding_id as string, mappings: [
        { source_index: 0, local_id: shopId, platform, shop_id: shopId } ] }],
    };
  }
  // cast — server-only override param; suite ต้อง compile ได้ทั้งก่อน/หลัง implementation
  const detailFor = svc.getWorkflowImportDetail as unknown as
    (w: string, v?: string) => Promise<{ overlap_conflicts?: string[]; publish_blockers?: string[] } | null>;
  const ovStr = (wfId: string) => `overlap with imported workflow ${wfId}`;
  const legStr = (wfId: string) => `overlap with legacy workflow ${wfId}`;

  // ─── 28.1 imported/imported — resolved pair เดียวกัน + message_received ทั้งคู่ → conflict สองทิศ
  const O1 = await setupOv("workflow_OV_O1", SRC_OV);
  const O2 = await setupOv("workflow_OV_O2", SRC_OV);
  await callResolve(O1.wfId, await ovReq(O1.wfId, "shopee", "shop_o1"));
  await callResolve(O2.wfId, (await ovReq(O2.wfId, "shopee", "shop_o1")));
  const detO1 = await detailFor(O1.wfId);
  const detO2 = await detailFor(O2.wfId);
  eq(canonicalJson(detO1?.overlap_conflicts), canonicalJson([ovStr(O2.wfId)]), "O1 → overlap_conflicts lists O2");
  eq(canonicalJson(detO2?.overlap_conflicts), canonicalJson([ovStr(O1.wfId)]), "O2 → overlap_conflicts lists O1");
  ok((detO1?.publish_blockers ?? []).includes(ovStr(O2.wfId)), "O1 → publish_blockers carries overlap (activation gate)");
  ok((detO2?.publish_blockers ?? []).includes(ovStr(O1.wfId)), "O2 → publish_blockers carries overlap");

  // ─── 28.2 imported/legacy — enabled+published + trigger node + scope-intersect (empty = match-all)
  const mkLegacy = (name: string, platforms: string[], shopIds: string[], enabled: boolean, status: "draft" | "published") =>
    svc.createWorkflow({ name, createdBy: "admin_t",
      nodes: [
        { node_id: "ln1", type: "trigger", subtype: "message", config: {}, position: { x: 0, y: 0 } },
        { node_id: "ln2", type: "action", subtype: "send_text", config: {}, position: { x: 100, y: 0 } },
      ],
      edges: [{ edge_id: "le1", source_node_id: "ln1", target_node_id: "ln2" }],
      platforms: platforms as never[], shopIds, enabled, status });
  const LEG_SAME = await mkLegacy("ov-leg-same", ["shopee"], ["shop_o1"], true, "published");
  const LEG_EMPTY = await mkLegacy("ov-leg-empty", [], [], true, "published");
  const LEG_DRAFT = await mkLegacy("ov-leg-draft", ["shopee"], ["shop_o1"], true, "draft");
  const LEG_OFF = await mkLegacy("ov-leg-off", ["shopee"], ["shop_o1"], false, "published");
  const LEG_DISJ = await mkLegacy("ov-leg-disj", ["lazada"], ["shop_o9"], true, "published");
  // legacy ที่ไม่มี trigger node — insert ตรง (graph validation ไม่ให้สร้างผ่าน createWorkflow)
  await (await mongo.getCollection(COLLECTIONS.workflows)).insertOne({
    workflow_id: "wf_leg_notrig", name: "ov-leg-notrig", enabled: true, status: "published",
    platforms: ["shopee"], shop_ids: ["shop_o1"],
    nodes: [{ node_id: "la1", type: "action", subtype: "send_text", config: {}, position: { x: 0, y: 0 } }],
    edges: [], version: 1, is_deleted: false,
    created_at: new Date(), created_by: "admin_t", updated_at: new Date(), updated_by: "admin_t" });
  const ov1 = (await detailFor(O1.wfId))?.overlap_conflicts ?? [];
  ok(ov1.includes(legStr(LEG_SAME.workflow_id)), "legacy enabled+published same scope → conflict");
  ok(ov1.includes(legStr(LEG_EMPTY.workflow_id)), "legacy empty scope (match-all) → conflict");
  ok(ov1.includes(ovStr(O2.wfId)), "imported O2 conflict persists alongside legacy");
  ok(!ov1.includes(legStr(LEG_DRAFT.workflow_id)), "legacy draft → no conflict");
  ok(!ov1.includes(legStr(LEG_OFF.workflow_id)), "legacy disabled → no conflict");
  ok(!ov1.includes(legStr(LEG_DISJ.workflow_id)), "legacy disjoint scope → no conflict");
  ok(!ov1.includes(legStr("wf_leg_notrig")), "legacy without trigger node → no conflict");
  eq(ov1.length, 3, "O1 → exactly 3 overlap entries (O2 + 2 legacy)");
  // retire match-all fixture — ค้างไว้จะชน resolved scope ทุกตัวของ section นี้
  await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne(
    { workflow_id: LEG_EMPTY.workflow_id }, { $set: { enabled: false } });

  // ─── 28.3 disjoint imported scope — ไม่ conflict ทั้งสองทิศ
  const O3 = await setupOv("workflow_OV_O3", SRC_OV);
  await callResolve(O3.wfId, await ovReq(O3.wfId, "tiktok", "shop_o3"));
  eq(canonicalJson((await detailFor(O3.wfId))?.overlap_conflicts), "[]", "O3 disjoint scope → no conflicts");
  ok(!(((await detailFor(O1.wfId))?.overlap_conflicts ?? []).includes(ovStr(O3.wfId))), "O1 → O3 not listed (disjoint)");

  // ─── 28.4 non-message_received trigger — contribute scope แต่ไม่ใช่ message axis → ไม่ conflict
  const O_LAB = await setupOv("workflow_OV_OLAB", SRC_OV_LAB);
  await callResolve(O_LAB.wfId, await ovReq(O_LAB.wfId, "shopee", "shop_o1"));
  eq(canonicalJson((await detailFor(O_LAB.wfId))?.overlap_conflicts), "[]",
    "label_added trigger → own readiness contributes nothing");
  const ov1d = (await detailFor(O1.wfId))?.overlap_conflicts ?? [];
  ok(!ov1d.includes(ovStr(O_LAB.wfId)), "O1 → O_LAB (no message_received) not listed as candidate");
  eq(ov1d.length, 2, "O1 → still 2 after LEG_EMPTY retired (O_LAB adds none)");

  // ─── 28.5 zero-valid / unresolved / invalid — ไม่มี eligibility ไม่ใช่ match-all; Task-3 blockers คง
  const O_NOACC = await setupNoAcc("workflow_OV_NOACC");
  const detNOACC = await detailFor(O_NOACC.wfId);
  eq(canonicalJson(detNOACC?.overlap_conflicts), "[]", "no account reqs → no overlap scope (not match-all)");
  ok((detNOACC?.publish_blockers ?? []).includes(BLOCKER_GLOBAL), "no-account → global-scope blocker intact");
  const O_UNRES = await setupOv("workflow_OV_UNRES", SRC_OV);   // account ค้าง unresolved
  const detUNRES = await detailFor(O_UNRES.wfId);
  eq(canonicalJson(detUNRES?.overlap_conflicts), "[]", "unresolved account → no overlap contribution");
  ok((detUNRES?.publish_blockers ?? []).includes(BLOCKER_NONE), "unresolved → account_scope blocker intact");
  const O_DUP = await setupOv("workflow_OV_DUP", SRC_OV);
  const O_INV = await setupOv("workflow_OV_INV", SRC_OV);
  await callResolve(O_DUP.wfId, await ovReq(O_DUP.wfId, "shopee", "shop_od"));
  await callResolve(O_INV.wfId, await ovReq(O_INV.wfId, "shopee", "shop_od"));
  ok(((await detailFor(O_DUP.wfId))?.overlap_conflicts ?? []).includes(ovStr(O_INV.wfId)),
    "O_DUP → O_INV conflicted while mapping valid");
  await shopsColl5.deleteOne({ shop_id: "shop_od" });
  const wInv = (await svc.getWorkflow(O_INV.wfId)) as Record<string, unknown>;
  await svcAny.saveWorkflowDraft(O_INV.wfId, { name: "inv-reval" }, wInv.version as number, "admin_t");
  const detINV = await detailFor(O_INV.wfId);
  eq(canonicalJson(detINV?.overlap_conflicts), "[]", "invalid mapping → zero overlap scope (contributes nothing)");
  ok((detINV?.publish_blockers ?? []).includes(BLOCKER_NONE), "invalid → account_scope blocker returns (Task-3 intact)");
  const ovDUP = (await detailFor(O_DUP.wfId))?.overlap_conflicts ?? [];
  ok(!ovDUP.includes(ovStr(O_INV.wfId)), "O_DUP → invalid-scope O_INV no longer listed");
  eq(ovDUP.length, 0, "O_DUP → no remaining conflicts");

  // ─── 28.6 overlap-producing resolution — commit disabled/draft + report conflicts
  const O5 = await setupOv("workflow_OV_O5", SRC_OV);
  const O6 = await setupOv("workflow_OV_O6", SRC_OV);
  const r5 = await callResolve(O5.wfId, await ovReq(O5.wfId, "shopee", "shop_o2"));
  eq(canonicalJson(r5?.overlap_conflicts), "[]", "first occupant → no overlap (pin)");
  const evO6 = state.adminEvents.length;
  const r6 = await callResolve(O6.wfId, await ovReq(O6.wfId, "shopee", "shop_o2"));
  ok(r6 != null && r6.ok === true, "overlap-producing resolution → commits (save not blocked)");
  eq(canonicalJson(r6?.overlap_conflicts), canonicalJson([ovStr(O5.wfId)]), "res.overlap_conflicts reports O5");
  eq(canonicalJson(r6?.publish_blockers), "[]", "res.publish_blockers stays scope-only (overlap ไม่ปน)");
  const wO6 = (await svc.getWorkflow(O6.wfId)) as Record<string, unknown>;
  eq(wO6?.enabled, false, "O6 → enabled:false"); eq(wO6?.status, "draft", "O6 → status:draft");
  eq(wO6?.version, 2, "O6 → pointer bumped to v2");
  const evO6last = resolveEvents().slice(-1)[0] as { metadata?: Record<string, unknown> };
  eq(evO6last?.metadata?.workflow_id, O6.wfId, "audit → this workflow");
  eq(canonicalJson(evO6last?.metadata?.overlap), canonicalJson([ovStr(O5.wfId)]),
    "audit metadata.overlap = target-version conflicts");
  eq(state.adminEvents.length, evO6 + 1, "exactly one audit emitted");
  ok(((await detailFor(O5.wfId))?.overlap_conflicts ?? []).includes(ovStr(O6.wfId)),
    "O5 → symmetric conflict on next readiness read");

  // ─── 28.7 narrowing scope — conflict หายใน readiness รอบถัดไป (recompute ไม่มี persist)
  const r6b = await callResolve(O6.wfId, await ovReq(O6.wfId, "shopee", "shop_o4"));
  eq(canonicalJson(r6b?.overlap_conflicts), "[]", "narrowed resolution → no overlap (pin)");
  eq(canonicalJson((await detailFor(O6.wfId))?.overlap_conflicts), "[]", "O6 detail cleared after narrowing");
  ok(!(((await detailFor(O5.wfId))?.overlap_conflicts ?? []).includes(ovStr(O6.wfId))),
    "O5 → O6 no longer listed (symmetric clear)");

  // ─── 28.8 ordering — evaluate TARGET version (v2) ไม่ใช่ v1 ที่ pointer ชี้อยู่
  const W = await setupOv("workflow_OV_W", SRC_OV);
  await callResolve(W.wfId, await ovReq(W.wfId, "shopee", "shop_o5"));   // v1 → disjoint scope
  const rW = await callResolve(W.wfId, await ovReq(W.wfId, "shopee", "shop_o2"));  // v2 → overlaps O5
  eq(canonicalJson(rW?.overlap_conflicts), canonicalJson([ovStr(O5.wfId)]),
    "v2-overlap reported — evaluation reads proposed version not stale v1");

  // ─── 28.9 competing CAS — conflict path ไม่รายงาน overlap (ไม่ใช่ version ของเรา)
  const W2 = await setupOv("workflow_OV_W2", SRC_OV);
  const reqW2 = await ovReq(W2.wfId, "shopee", "shop_o2");
  st.updateOneHook = async (coll: string, filter?: unknown, update?: unknown) => {
    const f = filter as { workflow_id?: string } | undefined;
    const u = update as { $set?: { current_version_id?: string } } | undefined;
    if (coll === COLLECTIONS.workflows && f?.workflow_id === W2.wfId && u?.$set?.current_version_id) {
      const d = (await mongo.getCollection(COLLECTIONS.workflows)).docs
        .find((x: Record<string, unknown>) => x.workflow_id === W2.wfId) as Record<string, unknown> | undefined;
      if (d) { d.version = 99; d.current_version_id = "wv_competitor"; }
    }
  };
  const rW2 = await callResolve(W2.wfId, reqW2);
  disarm();
  ok(rW2?.ok === false && rW2?.conflict === true, "competing CAS → conflict (pin)");
  eq(rW2?.current_version, 99, "conflict echoes winner version (pin)");
  eq(rW2?.current_version_id, "wv_competitor", "conflict echoes winner version_id (pin)");
  ok(rW2?.overlap_conflicts === undefined,
    "conflict path → no overlap fields (evaluated version ไม่ใช่ committed version)");
  eq(resolveEvents().filter((e) => (e as { metadata?: { workflow_id?: string } }).metadata?.workflow_id === W2.wfId).length,
    0, "lost CAS → zero success audit for this workflow");

  // ─── 28.10 override fail-closed — missing/foreign version_id → null (ไม่ fallback เงียบ)
  const vO2 = (await collDocs(COLLECTIONS.workflowVersions)).find((x) => x.workflow_id === O2.wfId) as Record<string, unknown>;
  eq(await detailFor(O1.wfId, vO2.version_id as string), null, "foreign version_id → null (ownership-scoped)");
  eq(await detailFor(O1.wfId, "wv_nonexistent_target"), null, "missing version_id → null (fail closed)");
  ok((await detailFor(O1.wfId)) != null, "ordinary read unaffected (pin)");

  // ─── 28.11 evaluation failure ก่อน CAS — ไม่ commit, ไม่ audit; artifacts อาจ persist แล้ว (crash/retry)
  const O_FAIL = await setupOv("workflow_OV_FAIL", SRC_OV);
  const reqFail = await ovReq(O_FAIL.wfId, "shopee", "shop_o2");
  const evFail = resolveEvents().length;
  const wFailPre = canonicalJson(await svc.getWorkflow(O_FAIL.wfId));
  (st as { findOneHook?: (c: string, f?: unknown) => Promise<void> }).findOneHook =
    async (coll: string, filter?: unknown) => {
      const f = filter as Record<string, unknown> | undefined;
      // override lookup signature = {version_id, workflow_id} — ordinary reads ไม่ชน
      if (coll === COLLECTIONS.workflowVersions && typeof f?.workflow_id === "string" && typeof f?.version_id === "string") {
        throw new Error("injected readiness-eval failure");
      }
    };
  const rFail = await callResolve(O_FAIL.wfId, reqFail);
  (st as Record<string, unknown>).findOneHook = undefined;
  ok(typeof rFail?.__thrown === "string" && String(rFail.__thrown).includes("readiness-eval"),
    "evaluation failure → save rejects before pointer CAS");
  eq(canonicalJson(await svc.getWorkflow(O_FAIL.wfId)), wFailPre, "pointer/version/enabled/status unchanged");
  eq(resolveEvents().length, evFail, "no success audit emitted");
  // หมายเหตุ: version doc + binding rows อาจ persist แล้วก่อน eval (immutable artifacts
  // ตาม crash/retry design) — assert เฉพาะ pointer+audit ไม่ assert zero writes

  // ─── 28.12 target-version platforms — override ใช้ version.platforms ไม่ใช่ stale doc platforms
  const O_PLAT = await setupOv("workflow_OV_PLAT", SRC_OV);
  const rPlat = await callResolve(O_PLAT.wfId, await ovReq(O_PLAT.wfId, "shopee", "shop_o1"));
  const v2Plat = rPlat?.version_id as string | undefined;
  // จำลอง pre-CAS staleness — doc platforms ต่างจาก target-version platforms
  await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne(
    { workflow_id: O_PLAT.wfId }, { $set: { platforms: ["facebook"] } });
  const detV2Plat = await detailFor(O_PLAT.wfId, v2Plat);
  ok(!(detV2Plat?.publish_blockers ?? []).includes("2 node ไม่พร้อม publish"),
    "override read → capability ใช้ version.platforms (shopee→supported) ไม่ใช่ stale doc (facebook)");
  const detOrdPlat = await detailFor(O_PLAT.wfId);
  ok((detOrdPlat?.publish_blockers ?? []).includes("2 node ไม่พร้อม publish"),
    "ordinary read → คงใช้ doc-level platforms (facebook→requires_adapter) — semantics เดิม");
  await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne(
    { workflow_id: O_PLAT.wfId }, { $set: { platforms: ["shopee"] } });

  // ─── 28.13 overlap ไม่ persist — resolution.conflict ว่างทุก version ล่าสุด
  for (const [nm, wfId] of [["O5", O5.wfId], ["O6", O6.wfId], ["W", W.wfId]] as const) {
    const w = (await svc.getWorkflow(wfId)) as Record<string, unknown>;
    const bs = (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => b.workflow_id === wfId && b.version_id === w.current_version_id);
    ok(bs.length > 0 && bs.every((b) => (b.resolution as Record<string, unknown> | undefined)?.conflict === undefined),
      `${nm} → no persisted resolution.conflict (overlap = readiness-computed)`);
  }

  // ═══ summary ═══
  const countsEnd = await allCounts();
  const totalWfs = (await collDocs(COLLECTIONS.workflows)).length;
  const legacyWfs = (await collDocs(COLLECTIONS.workflows)).filter((w) => w.import == null).length;
  eq(countsEnd[COLLECTIONS.workflowRawSnapshots], totalWfs - legacyWfs, "raw snapshots = imported workflows only (resolution writes none)");
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
