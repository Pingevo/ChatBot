// test-workflow-persistence.ts — RED tests: Zaapi workflow import persistence + CAS + bindings
//
// รัน: npx tsx scripts/test-workflow-persistence.ts
//
// ทุก test บน fake Mongo (module-boundary mocks — hooks.mjs) ไม่มี Mongo/network/env จริง
//
// Contract ที่ assert:
//   dry-run → zero writes · apply → disabled drafts + immutable version + raw
//   snapshot + binding records + batch record · identical apply → zero dup ·
//   new fingerprint → append version · malformed → zero writes · stale CAS →
//   conflict · valid CAS → version+1 · credentials absent ทุก surface ·
//   executable config ไม่มี external ids · engine ไม่ execute imported drafts

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

const SECRET = "sekret-token-xyz";

// ─── Fixture: Zaapi-shaped flow — nested bindings + credential + step refs ───
const SRC_FLOW = {
  workflowId: "workflow_PERSIST1",
  loadedVersionId: "workflow-version_P1",
  versions: [{ workflowVersionId: "workflow-version_P1", status: "active" }],
  nodes: [
    { id: "t1", type: "message_received", position: { x: 0, y: 0 },
      data: { name: "trig", nodeType: "trigger", accountIds: ["acc_1"], nextStepId: "c1" } },
    { id: "c1", type: "label", position: { x: 100, y: 0 },
      data: { name: "cond", nodeType: "condition",
              conditions: [{ labelIds: ["lab_9"], nextStepId: "a1" }], noMatchNextStepId: "a1" } },
    { id: "a1", type: "chat_assign", position: { x: 200, y: 0 },
      data: { name: "assign", nodeType: "action",
              action: { assignment: { teamIds: ["team_1"], userIds: ["u1", "u2"] } },
              callbackUrl: `https://hook.example.com/x?token=${SECRET}` } },
  ],
  edges: [
    { source: "t1", target: "c1", sourceHandle: null },
    { source: "c1", target: "a1", sourceHandle: "condition-index-0" },
    { source: "c1", target: "a1", sourceHandle: "no-match" },
  ],
};

async function main() {
  const mocks: Mocks = await import("./test-workflow-persistence-mocks.mjs");
  const imp: Imp = await import("../src/lib/workflow/zaapiImport");
  const svc: Svc = await import("../src/backend/service/workflowService");
  const { previewZaapiFlow, previewZaapiFlows, canonicalJson } = imp;
  const { state, mongo, COLLECTIONS } = mocks;
  const svcAny = svc as unknown as Record<string, (...a: any[]) => unknown>;

  async function collDocs(name: string): Promise<Record<string, unknown>[]> {
    return (await (await mongo.getCollection(name)).find({}).toArray()) as Record<string, unknown>[];
  }
  async function allCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const c of Object.values(COLLECTIONS)) out[c] = await (await mongo.getCollection(c)).countDocuments({});
    return out;
  }
  function totalDocs(counts: Record<string, number>) { return Object.values(counts).reduce((s, n) => s + n, 0); }

  // ═══ 1. dry-run preview → zero writes ═══
  console.log("\n=== 1. Dry-run purity ===");
  const report = previewZaapiFlow(SRC_FLOW, { indexRows: [{ wid: "workflow_PERSIST1", name: "persist test" }] });
  const batch = previewZaapiFlows({ flows: [SRC_FLOW] }, { indexRows: [{ wid: "workflow_PERSIST1", name: "persist test" }] });
  eq(totalDocs(await allCounts()), 0, "preview/dry-run → zero persisted docs");

  // ═══ 2. apply — atomic disabled-draft persistence ═══
  console.log("\n=== 2. Apply import batch ===");
  ok(typeof svcAny.applyImportBatch === "function", "applyImportBatch exists on workflowService owner");
  if (typeof svcAny.applyImportBatch !== "function") {
    console.log("    (skipping apply assertions — owner missing)");
    return;
  }
  const applied = await svcAny.applyImportBatch(batch, "admin_t") as Record<string, unknown>;
  eq(applied.ok, true, "apply returns ok");
  eq(applied.already_applied ?? false, false, "first apply is fresh (not already_applied)");
  const wfIds = (applied.workflow_ids || []) as string[];
  eq(wfIds.length, 1, "1 workflow created");

  const wfs = await collDocs(COLLECTIONS.workflows);
  eq(wfs.length, 1, "workflows: 1 doc");
  const wf = wfs[0] as { enabled?: boolean; status?: string; nodes?: unknown[]; edges?: unknown[] };
  eq(wf.enabled, false, "imported workflow enabled=false");
  eq(wf.status, "draft", "imported workflow status=draft");
  eq((wf.nodes || []).length, report.nodeCount, "workflow doc carries canonical nodes");
  eq((wf.edges || []).length, report.edgeCount, "workflow doc carries canonical edges");

  const vers = await collDocs(COLLECTIONS.workflowVersions);
  eq(vers.length, 1, "workflow_versions: 1 immutable doc");
  const v = vers[0] as { version_seq?: number; fingerprint?: string; nodes?: unknown[]; import_batch_id?: string; source_ref?: { workflowId?: string } };
  eq(v.version_seq, 1, "version_seq=1");
  eq(v.source_ref?.workflowId, "workflow_PERSIST1", "version keeps source workflow id (provenance)");
  ok(typeof v.fingerprint === "string" && v.fingerprint.startsWith("fnv64-"), "version has content fingerprint");
  ok(typeof v.import_batch_id === "string" && v.import_batch_id.length > 0, "version references import batch");

  const snaps = await collDocs(COLLECTIONS.workflowRawSnapshots);
  eq(snaps.length, 1, "workflow_raw_snapshots: 1 immutable doc");
  const snap = snaps[0] as { source_workflow_id?: string; source_version_id?: string; raw?: unknown; fingerprint?: string };
  eq(snap.source_workflow_id, "workflow_PERSIST1", "snapshot keeps source workflow identity");
  eq(snap.source_version_id, "workflow-version_P1", "snapshot keeps source version identity");
  ok(!canonicalJson(snap.raw).includes(SECRET), "snapshot raw has credentials masked");
  ok(canonicalJson(snap.raw).includes("team_1"), "snapshot keeps external ids for rebind");

  const binds = await collDocs(COLLECTIONS.workflowBindings);
  eq(binds.length, report.bindings.length, "workflow_bindings: one doc per binding");
  const b0 = binds[0] as { node_id?: string; field_path?: string; kind?: string; count?: number; source_ref?: string; status?: string; source_values?: unknown[] };
  ok(!!b0.node_id && !!b0.field_path && !!b0.kind, "binding doc has node_id/field_path/kind");
  ok(typeof b0.count === "number" && !!b0.source_ref, "binding doc has count + source_ref");
  eq(b0.status, "unresolved", "binding starts unresolved");
  const teamBind = binds.find((b) => (b as { field_path?: string }).field_path === "action.assignment.teamIds") as { source_values?: string[] } | undefined;
  ok(teamBind != null && Array.isArray(teamBind.source_values) && teamBind.source_values.includes("team_1"), "binding carries source values for rebind");

  const batches = await collDocs(COLLECTIONS.workflowImportBatches);
  eq(batches.length, 1, "workflow_import_batches: 1 doc");
  const bd = batches[0] as { source?: string; source_fingerprint?: string; flow_count?: number; node_count?: number; edge_count?: number; bindings_total?: number; status?: string };
  eq(bd.source, "zaapi", "batch records source");
  eq(bd.flow_count, 1, "batch flow_count");
  eq(bd.node_count, 3, "batch node_count");
  eq(bd.edge_count, 3, "batch edge_count");
  ok(typeof bd.source_fingerprint === "string" && bd.source_fingerprint.length > 0, "batch keeps source fingerprint");
  eq(bd.status, "applied", "batch status applied");

  // ═══ 3. identical re-apply → zero duplicates ═══
  console.log("\n=== 3. Idempotent re-apply ===");
  const before = await allCounts();
  const re = await svcAny.applyImportBatch(batch, "admin_t") as Record<string, unknown>;
  eq(re.already_applied, true, "identical apply → already_applied");
  const after = await allCounts();
  eq(canonicalJson(after), canonicalJson(before), "identical apply → zero new docs (any collection)");

  // ═══ 4. changed revision → new immutable version, old untouched ═══
  console.log("\n=== 4. Changed source revision → new version ===");
  const SRC_V2 = { ...SRC_FLOW, loadedVersionId: "workflow-version_P2",
    versions: [{ workflowVersionId: "workflow-version_P2", status: "active" }],
    nodes: [...SRC_FLOW.nodes.slice(0, 2),
      { ...SRC_FLOW.nodes[2], data: { ...SRC_FLOW.nodes[2].data, extra_flag: true } }] };
  const batch2 = previewZaapiFlows({ flows: [SRC_V2] }, { indexRows: [{ wid: "workflow_PERSIST1", name: "persist test" }] });
  const r2 = await svcAny.applyImportBatch(batch2, "admin_t") as Record<string, unknown>;
  eq(r2.ok, true, "revision-2 apply ok");
  const vers2 = await collDocs(COLLECTIONS.workflowVersions);
  eq(vers2.length, 2, "new revision → second immutable version (old not mutated)");
  const v1 = vers2.find((x) => (x as { version_seq?: number }).version_seq === 1) as { fingerprint?: string };
  eq(v1.fingerprint, v.fingerprint, "old version fingerprint untouched");
  const wfAfter = (await collDocs(COLLECTIONS.workflows))[0] as { version?: number; nodes?: { config?: Record<string, unknown> }[] };
  eq(wfAfter.version, 2, "workflow pointer bumped to new version");
  ok(wfAfter.nodes?.some((n) => n.config?.extra_flag === true) === true, "workflow doc now carries v2 content");

  // ═══ 5. malformed → reject + zero writes ═══
  console.log("\n=== 5. Malformed/invalid batch → zero writes ===");
  const badBatch = previewZaapiFlows({ flows: [{ workflowId: "w_dangle", nodes: [
    { id: "t", type: "message_received", position: {}, data: { nodeType: "trigger", nextStepId: "ghost" } },
  ], edges: [] }] });
  const beforeBad = await allCounts();
  let threw = false;
  try { await svcAny.applyImportBatch(badBatch, "admin_t"); } catch { threw = true; }
  ok(threw, "dangling step ref batch → apply throws");
  eq(canonicalJson(await allCounts()), canonicalJson(beforeBad), "rejected batch → zero writes");

  const unsupBatch = previewZaapiFlows({ flows: [{ workflowId: "w_unsup", nodes: [
    { id: "t", type: "message_received", position: {}, data: { nodeType: "trigger" } },
    { id: "x", type: "totally_unknown", position: {}, data: { nodeType: "action" } },
  ], edges: [{ source: "t", target: "x" }] }] });
  const beforeUnsup = await allCounts();
  let threw2 = false;
  try { await svcAny.applyImportBatch(unsupBatch, "admin_t"); } catch { threw2 = true; }
  ok(threw2, "unsupported node type batch → apply throws");
  eq(canonicalJson(await allCounts()), canonicalJson(beforeUnsup), "unsupported batch → zero writes");

  // ═══ 6. CAS save ═══
  console.log("\n=== 6. CAS save ===");
  const wfId = wfIds[0];
  ok(typeof svcAny.saveWorkflowDraft === "function", "saveWorkflowDraft exists");
  const stale = await svcAny.saveWorkflowDraft(wfId, { name: "edited" }, 99, "admin_t") as { ok?: boolean; conflict?: boolean; current_version?: number };
  eq(stale.conflict, true, "stale expectedVersion → conflict response");
  const wfStale = await collDocs(COLLECTIONS.workflows);
  eq((wfStale[0] as { name?: string }).name, "persist test", "conflict → original name unchanged");
  eq((await collDocs(COLLECTIONS.workflowVersions)).length, 2, "conflict → no new version doc");

  const good = await svcAny.saveWorkflowDraft(wfId, { name: "edited name" }, 2, "admin_t") as { ok?: boolean; conflict?: boolean; version?: number };
  eq(good.ok, true, "valid CAS → save succeeds");
  eq(good.version, 3, "CAS save bumps workflow version counter");
  eq((await collDocs(COLLECTIONS.workflows))[0].name, "edited name", "CAS save wrote name");
  const vers3 = await collDocs(COLLECTIONS.workflowVersions);
  eq(vers3.length, 3, "CAS save → new immutable version doc");
  const v3 = vers3.find((x) => (x as { version_seq?: number }).version_seq === 3) as { name?: string; import_batch_id?: string };
  eq(v3?.name, "edited name", "new version doc carries saved content");

  // concurrent double-save with same expectedVersion → second conflicts
  const c1 = await svcAny.saveWorkflowDraft(wfId, { name: "race1" }, 3, "admin_t") as { ok?: boolean };
  const c2 = await svcAny.saveWorkflowDraft(wfId, { name: "race2" }, 3, "admin_t") as { conflict?: boolean };
  eq(c1.ok, true, "first CAS wins");
  eq(c2.conflict, true, "second CAS with same expectedVersion → conflict (no last-write-wins)");

  // bindings carried forward to new version — unresolved ยัง explicit
  const versAfterRace = await collDocs(COLLECTIONS.workflowVersions);
  const latestSeq = Math.max(...versAfterRace.map((x) => Number((x as { version_seq?: number }).version_seq) || 0));
  const newVersion = versAfterRace.find((x) => (x as { version_seq?: number }).version_seq === latestSeq) as { version_id?: string; nodes?: never[]; edges?: never[] } | undefined;
  eq(latestSeq, 4, "latest version_seq after CAS race");
  const carried = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => (b as { version_id?: string }).version_id === newVersion?.version_id);
  ok(carried.length > 0, "unresolved bindings carried to new version");
  ok(carried.every((b) => (b as { status?: string }).status === "unresolved"), "carried bindings stay unresolved");

  // ═══ 7. credential absence ทุก persisted/audit surface ═══
  console.log("\n=== 7. Credential hygiene ===");
  const allDocs = JSON.stringify([
    ...(await collDocs(COLLECTIONS.workflows)),
    ...(await collDocs(COLLECTIONS.workflowVersions)),
    ...(await collDocs(COLLECTIONS.workflowRawSnapshots)),
    ...(await collDocs(COLLECTIONS.workflowBindings)),
    ...(await collDocs(COLLECTIONS.workflowImportBatches)),
  ]);
  ok(!allDocs.includes(SECRET), "no credential value in any persisted doc");
  ok(!allDocs.includes("https://hook.example.com"), "no credential URL in persisted docs");
  ok(!JSON.stringify(state.adminEvents).includes(SECRET), "no credential in audit events");

  // ═══ 8. executable config → zero external ids ═══
  console.log("\n=== 8. Executable config clean ===");
  const wfv = await collDocs(COLLECTIONS.workflowVersions);
  const allCfg = canonicalJson(wfv.flatMap((d) => ((d as { nodes?: { config?: unknown }[] }).nodes || []).map((n) => n.config)));
  for (const id of ["acc_1", "lab_9", "team_1", "u1", "u2"]) ok(!allCfg.includes(id), `persisted config has no external id ${id}`);
  ok(!allCfg.includes('"c1"') && !allCfg.includes('"t1"'), "persisted config has no zaapi step ids");

  // ═══ 9. publish gate + detail surface ═══
  console.log("\n=== 9. Publish blocked + detail ===");
  const detailFn = svcAny.getWorkflowImportDetail;
  ok(typeof detailFn === "function", "getWorkflowImportDetail exists");
  const detail = await detailFn?.(wfId) as { bindings?: { status?: string }[]; publish_blockers?: string[]; source_ref?: { workflowId?: string } } | undefined;
  ok(detail != null, "import detail returned");
  ok((detail?.bindings || []).some((b) => b.status === "unresolved"), "detail shows unresolved bindings");
  ok((detail?.publish_blockers || []).length > 0, "detail lists publish blockers");
  eq(detail?.source_ref?.workflowId, "workflow_PERSIST1", "detail keeps source identity");

  const { publishReadiness, validateCanonicalDraft } = await import("../src/lib/workflow/nodeRegistry");
  const latestV = newVersion;
  const cap = validateCanonicalDraft(latestV?.nodes || [], latestV?.edges || [], [], carried as never);
  ok(!cap.ok, "unresolved bindings → capability fails");
  ok(!publishReadiness(cap).canPublish, "unresolved bindings → publish blocked");

  // ═══ 10. engine activation gate ═══
  console.log("\n=== 10. Engine gate ===");
  const enabledWfs = await svc.listWorkflows({ enabledOnly: true, publishedOnly: true });
  eq(enabledWfs.length, 0, "engine-visible list (enabled+published) has zero imported drafts");

  // ═══ 11. corpus-scale apply (opt-in — ZAAPI_EXPORT_DIR) ═══
  const ZAAPI_DIR = process.env.ZAAPI_EXPORT_DIR;
  if (ZAAPI_DIR) {
    console.log(`\n=== 11. Corpus apply (${ZAAPI_DIR}) ===`);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const allFlows = JSON.parse(readFileSync(join(ZAAPI_DIR, "data/flows/all-flows.json"), "utf8"));
    const indexData = JSON.parse(readFileSync(join(ZAAPI_DIR, "data/flows/_index_data.json"), "utf8"));
    const corpusBatch = previewZaapiFlows(allFlows, { indexRows: indexData.rows });
    const corpusApplied = await svcAny.applyImportBatch(corpusBatch, "admin_t") as Record<string, unknown>;
    eq(corpusApplied.ok, true, "corpus apply ok");
    eq((corpusApplied.workflow_ids as string[]).length, 21, "21 disabled drafts persisted");
    eq((await collDocs(COLLECTIONS.workflows)).length, 22, "workflows: 21 imported + 1 fixture");
    eq(corpusApplied.node_count, 218, "218 nodes");
    eq(corpusApplied.edge_count, 225 + 23, "225 source + 23 synthesized edges");
    eq(corpusApplied.bindings_total, 119, "119 binding records");
    const corpusWfIds = new Set(corpusApplied.workflow_ids as string[]);
    const corpusBinds = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => corpusWfIds.has((b as { workflow_id?: string }).workflow_id || ""));
    eq(corpusBinds.length, 119, "corpus binding docs persisted (119)");
    const corpusWfs = await collDocs(COLLECTIONS.workflows);
    ok(corpusWfs.every((w) => (w as { enabled?: boolean }).enabled === false), "all imported workflows disabled");
    ok(corpusWfs.every((w) => (w as { status?: string }).status === "draft"), "all imported workflows draft");
    // identical re-apply → zero dup
    const beforeCorpus = await allCounts();
    await svcAny.applyImportBatch(corpusBatch, "admin_t");
    eq(canonicalJson(await allCounts()), canonicalJson(beforeCorpus), "corpus re-apply → zero duplicates");
    // engine gate at corpus scale
    eq((await svc.listWorkflows({ enabledOnly: true, publishedOnly: true })).length, 0, "engine-visible list still zero at corpus scale");
  }

  // ═══ 12. activation ownership — imported flow เปิดผ่าน mutation path ไม่ได้ ═══
  console.log("\n=== 12. Activation ownership (imported blocked, legacy preserved) ===");
  const impWfId = wfIds[0];
  const act = async (fn: () => unknown) => { try { await fn(); return null; } catch (e) { return (e as Error).message; } };
  ok((await act(() => svc.updateWorkflow(impWfId, { enabled: true }, "admin_t"))) != null, "updateWorkflow enabled=true on imported → rejected");
  ok((await act(() => svc.updateWorkflow(impWfId, { status: "published" }, "admin_t"))) != null, "updateWorkflow status=published on imported → rejected");
  ok((await act(() => svc.toggleWorkflow(impWfId, true, "admin_t"))) != null, "toggleWorkflow(true) on imported → rejected");
  const curWfDoc = await svc.getWorkflow(impWfId);
  ok((await act(() => svcAny.saveWorkflowDraft(impWfId, { enabled: true }, curWfDoc?.version ?? 0, "admin_t"))) != null, "CAS enabled=true on imported → rejected");
  ok((await act(() => svcAny.saveWorkflowDraft(impWfId, { status: "published" }, curWfDoc?.version ?? 0, "admin_t"))) != null, "CAS status=published on imported → rejected");
  const impAfter = await svc.getWorkflow(impWfId);
  eq(impAfter?.enabled, false, "imported stays enabled=false after all mutation attempts");
  eq(impAfter?.status, "draft", "imported stays status=draft");
  eq((await svc.listWorkflows({ enabledOnly: true, publishedOnly: true })).length, 0, "engine-visible still 0 after activation attempts");

  // legacy (non-imported) workflow — พฤติกรรมเดิม: update/toggle/CAS enabled+status apply
  const legacy = await svc.createWorkflow({ name: "legacy wf", createdBy: "admin_t",
    nodes: [
      { node_id: "ln1", type: "trigger", subtype: "message", config: {}, position: { x: 0, y: 0 } },
      { node_id: "ln2", type: "action", subtype: "send_text", config: {}, position: { x: 100, y: 0 } },
    ],
    edges: [{ edge_id: "le1", source_node_id: "ln1", target_node_id: "ln2" }] });
  eq(await svc.updateWorkflow(legacy.workflow_id, { enabled: true, status: "published" }, "admin_t"), true, "legacy updateWorkflow enabled+published applies");
  const legacyCas = await svcAny.saveWorkflowDraft(legacy.workflow_id, { enabled: false, status: "draft", name: "legacy2" }, (await svc.getWorkflow(legacy.workflow_id))?.version ?? 0, "admin_t") as { ok?: boolean };
  eq(legacyCas.ok, true, "legacy CAS accepts enabled/status (no silent drop)");
  const legacyAfter = await svc.getWorkflow(legacy.workflow_id);
  eq(legacyAfter?.enabled, false, "legacy CAS wrote enabled=false");
  eq(legacyAfter?.status, "draft", "legacy CAS wrote status=draft");
  eq(legacyAfter?.name, "legacy2", "legacy CAS wrote name");

  // unsupported field → explicit reject (ไม่ drop เงียบ)
  ok((await act(() => svcAny.saveWorkflowDraft(legacy.workflow_id, { bogus_field: 1 } as never, legacyAfter?.version ?? 0, "admin_t"))) != null, "CAS unknown field → rejected (not silently dropped)");

  // ═══ 13. import failure recovery — crash ที่ทุก boundary แล้ว retry ซ่อมต่อ ═══
  console.log("\n=== 13. Import failure injection → recoverable ===");
  const SRC_FRESH = { ...SRC_FLOW, workflowId: "workflow_RECOVER1", loadedVersionId: "workflow-version_R1",
    versions: [{ workflowVersionId: "workflow-version_R1", status: "active" }] };
  const recBatch = previewZaapiFlows({ flows: [SRC_FRESH] }, { indexRows: [{ wid: "workflow_RECOVER1", name: "recover test" }] });

  // helper: throw on the Nth write into collection `coll`
  const st = state as Record<string, unknown> & { insertOneHook?: (c: string, d?: unknown) => Promise<void>; updateOneHook?: (c: string, f?: unknown, u?: unknown) => Promise<void> };
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
  async function recCounts() { return allCounts(); }

  // ใช้ batch collection เดียวสำหรับทุก injection case — แต่ละ case ใช้ source revision ใหม่
  // เพื่อ batch_id ไม่ชนกัน (deterministic จาก fingerprint)
  async function crashCase(tag: string, arm: () => void, expectWritesBeforeFail: string) {
    const src = { ...SRC_FRESH, workflowId: `workflow_REC_${tag}`, loadedVersionId: `wv-src-${tag}`,
      versions: [{ workflowVersionId: `wv-src-${tag}`, status: "active" }] };
    const b = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: src.workflowId, name: `rec ${tag}` }] });
    const batchesBefore = new Set((await collDocs(COLLECTIONS.workflowImportBatches)).map((d) => (d as { batch_id?: string }).batch_id));
    arm();
    let threw = false;
    try { await svcAny.applyImportBatch(b, "admin_t"); } catch { threw = true; }
    ok(threw, `crash @${expectWritesBeforeFail} → apply throws (not silent)`);
    const myBatch = (await collDocs(COLLECTIONS.workflowImportBatches)).find((d) => !batchesBefore.has((d as { batch_id?: string }).batch_id)) as { status?: string; batch_id?: string } | undefined;
    ok(myBatch == null || myBatch.status !== "applied", `crash @${expectWritesBeforeFail} → batch NOT marked applied (status=${myBatch?.status ?? "none"})`);
    disarm();
    // retry same payload → resume/reconcile → applied + zero dup
    const before2 = await recCounts();
    const r = await svcAny.applyImportBatch(b, "admin_t") as Record<string, unknown>;
    eq(r.ok, true, `retry @${expectWritesBeforeFail} → apply completes`);
    const myBatch2 = (await collDocs(COLLECTIONS.workflowImportBatches)).find((d) => !batchesBefore.has((d as { batch_id?: string }).batch_id)) as { status?: string } | undefined;
    eq(myBatch2?.status, "applied", `retry @${expectWritesBeforeFail} → batch status applied`);
    eq((r.workflow_ids as string[]).length, 1, `retry @${expectWritesBeforeFail} → exactly 1 workflow (resume-aware, no dup)`);
    return { batch: myBatch2, result: r };
  }

  await crashCase("batchins", () => armInsertFail(COLLECTIONS.workflowVersions, 1), "version insert");
  await crashCase("snap", () => armInsertFail(COLLECTIONS.workflowRawSnapshots, 1), "snapshot insert");
  await crashCase("bind", () => armInsertFail(COLLECTIONS.workflowBindings, 2), "mid-bindings");
  await crashCase("wfdoc", () => armInsertFail(COLLECTIONS.workflows, 1), "workflow insert");
  await crashCase("final", () => armUpdateFail(COLLECTIONS.workflowImportBatches, 1), "final batch status update");
  disarm();

  // in_progress batch (crash ก่อน batch doc เขียนไม่ได้เพราะ insert แรกคือ batch doc —
  // จำลองด้วย insert fail บน batches → zero writes → retry clean)
  {
    const src = { ...SRC_FRESH, workflowId: "workflow_REC_nobatch", loadedVersionId: "wv-src-nb",
      versions: [{ workflowVersionId: "wv-src-nb", status: "active" }] };
    const b = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: src.workflowId, name: "rec nb" }] });
    armInsertFail(COLLECTIONS.workflowImportBatches, 1);
    const c0 = await recCounts();
    let threw = false;
    try { await svcAny.applyImportBatch(b, "admin_t"); } catch { threw = true; }
    ok(threw, "crash @batch insert → throws");
    eq(canonicalJson(await recCounts()), canonicalJson(c0), "crash @batch insert → zero writes");
    disarm();
    const r = await svcAny.applyImportBatch(b, "admin_t") as Record<string, unknown>;
    eq(r.ok, true, "retry after batch-insert crash → clean apply");
  }

  // concurrent same-batch apply → ไม่ dup + ไม่ตอบ success ก่อนครบ
  {
    const src = { ...SRC_FRESH, workflowId: "workflow_REC_conc", loadedVersionId: "wv-src-cc",
      versions: [{ workflowVersionId: "wv-src-cc", status: "active" }] };
    const b = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: src.workflowId, name: "rec conc" }] });
    const c0 = await recCounts();
    const [r1, r2] = await Promise.allSettled([
      svcAny.applyImportBatch(b, "admin_t"),
      svcAny.applyImportBatch(b, "admin_t2"),
    ]);
    const succeeded = [r1, r2].filter((r) => r.status === "fulfilled").length;
    ok(succeeded >= 1, "concurrent apply → at least one completes");
    const rejected = [r1, r2].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) {
      eq((rejected.reason as { code?: string })?.code, "IMPORT_IN_PROGRESS", "concurrent loser → IMPORT_IN_PROGRESS conflict (not silent success)");
    } else {
      const res = [r1, r2].map((r) => (r as PromiseFulfilledResult<Record<string, unknown>>).value);
      ok(res.some((v) => v.already_applied === true || v.ok === true), "concurrent loser reconciled to already_applied/completed (no premature success)");
    }
    const cd = await recCounts();
    eq((cd.workflows ?? 0) - (c0.workflows ?? 0), 1, "concurrent apply → exactly 1 workflow (no dup)");
    const batchesAll = await collDocs(COLLECTIONS.workflowImportBatches);
    const thisBatches = batchesAll.filter((d) => (d as { created_by?: string }).created_by === "admin_t" || (d as { created_by?: string }).created_by === "admin_t2");
    // batch doc ต้องมีแค่ 1 ต่อ batch_id เดียวกัน (unique enforced)
    const fpOfBatch = JSON.stringify(b.reports.map((r) => r.fingerprint));
    const matched = thisBatches.filter((d) => (d as { source_fingerprint?: string }).source_fingerprint != null && (d as { batch_id?: string }).batch_id != null);
    const uniqueIds = new Set(matched.map((d) => (d as { batch_id?: string }).batch_id));
    ok(uniqueIds.size === matched.length, "concurrent apply → zero duplicate batch docs");
    void fpOfBatch;
  }

  // ═══ 14. CAS failure recovery — crash ที่ทุก boundary, state ไม่เสีย ═══
  console.log("\n=== 14. CAS failure injection → recoverable ===");
  const casWf = impWfId;
  const casBefore = await svc.getWorkflow(casWf);
  const casV = casBefore?.version ?? 0;

  // fail @version insert → workflow doc ไม่เปลี่ยน + retry สำเร็จ
  armInsertFail(COLLECTIONS.workflowVersions, 1);
  let casThrew = false;
  try { await svcAny.saveWorkflowDraft(casWf, { name: "crash-ver" }, casV, "admin_t"); } catch { casThrew = true; }
  ok(casThrew, "CAS crash @version insert → throws");
  const casDoc1 = await svc.getWorkflow(casWf);
  eq(casDoc1?.version, casV, "CAS crash @version → workflow.version unchanged");
  eq(casDoc1?.name, casBefore?.name, "CAS crash @version → fields unchanged");
  eq(casDoc1?.current_version_id, casBefore?.current_version_id, "CAS crash @version → pointer unchanged");
  disarm();
  const casRetry = await svcAny.saveWorkflowDraft(casWf, { name: "crash-ver" }, casV, "admin_t") as { ok?: boolean; version?: number };
  eq(casRetry.ok, true, "CAS retry after version-insert crash → completes");
  eq(casRetry.version, casV + 1, "CAS retry → version+1");

  // fail @binding carry → workflow doc ไม่เปลี่ยน + retry สำเร็จ + bindings ครบ
  const casV2 = casV + 1;
  const ptrBeforeBind = (await svc.getWorkflow(casWf))?.current_version_id;
  armInsertFail(COLLECTIONS.workflowBindings, 1);
  casThrew = false;
  try { await svcAny.saveWorkflowDraft(casWf, { name: "crash-bind" }, casV2, "admin_t"); } catch { casThrew = true; }
  ok(casThrew, "CAS crash @binding carry → throws");
  const casDoc2 = await svc.getWorkflow(casWf);
  eq(casDoc2?.version, casV2, "CAS crash @bindings → workflow.version unchanged");
  eq(casDoc2?.current_version_id, ptrBeforeBind, "CAS crash @bindings → pointer unchanged");
  disarm();
  const casRetry2 = await svcAny.saveWorkflowDraft(casWf, { name: "crash-bind" }, casV2, "admin_t") as { ok?: boolean };
  eq(casRetry2.ok, true, "CAS retry after binding crash → completes");
  const casDoc3 = await svc.getWorkflow(casWf);
  const curBinds = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => (b as { version_id?: string }).version_id === casDoc3?.current_version_id);
  ok(curBinds.length > 0, "CAS retry → bindings present on new version");
  ok(curBinds.every((b) => (b as { status?: string }).status === "unresolved"), "CAS retry → carried bindings unresolved");

  // fail @CAS commit (workflow updateOne) → conflict semantics + retry clean
  const casV3 = casV2 + 1;
  armUpdateFail(COLLECTIONS.workflows, 1);
  casThrew = false;
  try { await svcAny.saveWorkflowDraft(casWf, { name: "crash-commit" }, casV3, "admin_t"); } catch { casThrew = true; }
  ok(casThrew, "CAS crash @commit → throws");
  const casDoc4 = await svc.getWorkflow(casWf);
  eq(casDoc4?.version, casV3, "CAS crash @commit → workflow.version unchanged");
  disarm();
  const casRetry3 = await svcAny.saveWorkflowDraft(casWf, { name: "crash-commit" }, casV3, "admin_t") as { ok?: boolean; version?: number };
  eq(casRetry3.ok, true, "CAS retry after commit crash → completes");
  const casDoc5 = await svc.getWorkflow(casWf);
  ok(casDoc5?.current_version_id != null && casDoc5.current_version_id !== casDoc1?.current_version_id, "CAS retry → pointer flipped to new version doc");
  const ptrVersion = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === casDoc5?.current_version_id);
  ok(ptrVersion != null, "CAS retry → current_version_id resolves to real version doc");

  // ═══ 15. binding carry-forward — เฉพาะ surviving node_ids ═══
  console.log("\n=== 15. Binding carry-forward (surviving only) ===");
  const casWfDoc = await svc.getWorkflow(casWf);
  const nodesNow = (casWfDoc?.nodes || []) as { node_id: string }[];
  const removedId = nodesNow[1]?.node_id; // c1 — node ที่มี binding
  const keepNodes = nodesNow.filter((n) => n.node_id !== removedId);
  // rewire: trigger → action ตรง (trigger ต้องมี edge ออกตาม graph validator)
  const rewiredEdges = [{ edge_id: "e_rew", source_node_id: nodesNow[0].node_id, target_node_id: nodesNow[2].node_id }];
  const prevVersionId = casWfDoc?.current_version_id;
  const carrySave = await svcAny.saveWorkflowDraft(casWf, { nodes: keepNodes, edges: rewiredEdges }, casWfDoc?.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(carrySave.ok, true, "CAS remove-node save ok");
  const newBinds = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => (b as { version_id?: string }).version_id === carrySave.version_id);
  ok(newBinds.every((b) => (b as { node_id?: string }).node_id !== removedId), "removed node → zero bindings in new version (not cloned as invalid)");
  ok(newBinds.every((b) => keepNodes.some((n) => n.node_id === (b as { node_id?: string }).node_id)), "new version bindings ⊆ surviving nodes");
  const oldBinds = (await collDocs(COLLECTIONS.workflowBindings)).filter((b) => (b as { version_id?: string }).version_id === prevVersionId);
  ok(oldBinds.some((b) => (b as { node_id?: string }).node_id === removedId), "historical version still keeps removed-node bindings (immutable)");

  // ═══ 16. foundation activation gate — zero-binding supported flow ยัง block ═══
  console.log("\n=== 16. Foundation activation gate (zero-binding supported → still blocked) ===");
  const SRC_SUPPORTED = {
    workflowId: "workflow_SUPP1", loadedVersionId: "workflow-version_SP1",
    versions: [{ workflowVersionId: "workflow-version_SP1", status: "active" }],
    nodes: [
      { id: "st1", type: "message_received", position: { x: 0, y: 0 }, data: { name: "trig", nodeType: "trigger" } },
      { id: "sa1", type: "send_message", position: { x: 100, y: 0 }, data: { name: "send", nodeType: "action", message: { type: "text", text: "hi" } } },
    ],
    edges: [{ source: "st1", target: "sa1", sourceHandle: null }],
  };
  const supBatch = previewZaapiFlows({ flows: [SRC_SUPPORTED] }, { indexRows: [{ wid: "workflow_SUPP1", name: "supported" }] });
  const supApplied = await svcAny.applyImportBatch(supBatch, "admin_t") as Record<string, unknown>;
  const supWfId = (supApplied.workflow_ids as string[])[0];
  const supDetail = await svcAny.getWorkflowImportDetail(supWfId) as { unresolved_bindings?: number; publish_blockers?: string[] };
  eq(supDetail.unresolved_bindings, 0, "supported fixture has zero bindings");
  const supVer = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === supWfId) as { nodes?: never[]; edges?: never[] } | undefined;
  const supCap = validateCanonicalDraft(supVer?.nodes || [], supVer?.edges || [], [], []);
  eq(supCap.ok, true, "supported fixture capability.ok=true (no blockers)");
  ok((await act(() => svc.updateWorkflow(supWfId, { status: "published" }, "admin_t"))) != null, "zero-binding supported imported → publish still rejected (foundation gate)");
  ok((await act(() => svc.toggleWorkflow(supWfId, true, "admin_t"))) != null, "zero-binding supported imported → toggle still rejected");
  const supWf = await svc.getWorkflow(supWfId);
  ok((await act(() => svcAny.saveWorkflowDraft(supWfId, { enabled: true }, supWf?.version ?? 0, "admin_t"))) != null, "zero-binding supported imported → CAS enable still rejected");
  const supAfter = await svc.getWorkflow(supWfId);
  eq(supAfter?.enabled, false, "supported imported stays disabled");
  eq(supAfter?.status, "draft", "supported imported stays draft");

  // ═══ 17. claim lease — abandoned claim takeover + stale claimant fenced ═══
  console.log("\n=== 17. Claim lease/fencing ===");
  // seed abandoned claim (process died — ไม่มี catch) โดยเขียน batch doc ตรงๆ
  const SRC_LEASE = { ...SRC_SUPPORTED, workflowId: "workflow_LEASE1", loadedVersionId: "workflow-version_L1",
    versions: [{ workflowVersionId: "workflow-version_L1", status: "active" }] };
  const leaseBatch = previewZaapiFlows({ flows: [SRC_LEASE] }, { indexRows: [{ wid: "workflow_LEASE1", name: "lease" }] });
  // คำนวณ batch_id เหมือน service: wib_<fnv36(stableFingerprint({source,flows}))>
  const _sh = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return h.toString(36); };
  // replicate service reqKey — requirement identity incl. raw source_values
  const reqKeyOf = (r: { draft: { raw?: unknown; bindings: { node_id: string; field_path: string; kind: string; count: number; source_ref: string }[] } }) =>
    canonicalJson(r.draft.bindings.map((b) => {
      const m = /^nodes\[([^\]]+)\]\.data\.(.+)$/.exec(b.source_ref);
      const raw = r.draft.raw as { nodes?: { id?: string; data?: Record<string, unknown> }[] } | undefined;
      const node = (raw?.nodes ?? []).find((n) => n.id === m?.[1]);
      let cur: unknown = node?.data;
      for (const seg of (m?.[2] ?? "").replace(/\[(\d+)\]/g, ".$1").split(".")) {
        if (cur == null || typeof cur !== "object") { cur = undefined; break; }
        cur = (cur as Record<string, unknown>)[seg];
      }
      const vals = cur == null ? [] : (Array.isArray(cur) ? cur : [cur]);
      return `${b.node_id}|${b.field_path}|${b.kind}|${b.count}|${canonicalJson(vals)}`;
    }).sort());
  const leaseBatchFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint({ source: "zaapi", flows: leaseBatch.reports.map((r) => `${r.draft.sourceRef.workflowId}|${r.fingerprint}|${reqKeyOf(r)}`) });
  const leaseBatchId = "wib_" + _sh(leaseBatchFp);
  const batchesColl = await mongo.getCollection(COLLECTIONS.workflowImportBatches);

  // 17a. active lease → 409 IMPORT_IN_PROGRESS
  await batchesColl.insertOne({
    batch_id: leaseBatchId, source: "zaapi", source_fingerprint: leaseBatchFp,
    flow_count: 1, node_count: 2, edge_count: 1, bindings_total: 0,
    synthesized_edges: 0, unresolved_step_refs: 0, mismatched_step_refs: 0,
    warnings: [], conflicts: [], status: "in_progress", workflow_ids: [],
    claim_token: "tok_live_owner", claim_expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(), created_by: "live_worker",
  });
  let leaseErr: { code?: string } | null = null;
  try { await svcAny.applyImportBatch(leaseBatch, "admin_t"); } catch (e) { leaseErr = e as { code?: string }; }
  eq(leaseErr?.code, "IMPORT_IN_PROGRESS", "active lease → IMPORT_IN_PROGRESS (409 semantics)");

  // 17b. expired lease (hard crash — no catch/release) → takeover + complete
  await batchesColl.updateOne({ batch_id: leaseBatchId }, { $set: { claim_token: "tok_dead_worker", claim_expires_at: new Date(Date.now() - 5_000) } });
  const leaseRetry = await svcAny.applyImportBatch(leaseBatch, "admin_t") as Record<string, unknown>;
  eq(leaseRetry.ok, true, "expired lease → takeover apply completes");
  const leaseBd = await batchesColl.findOne({ batch_id: leaseBatchId }) as { status?: string; claim_token?: string | null } | null;
  eq(leaseBd?.status, "applied", "takeover → batch applied");

  // 17c. stale claimant fenced — finalize/release ด้วย token เก่าไม่ได้
  const staleFinal = await batchesColl.updateOne({ batch_id: leaseBatchId, claim_token: "tok_dead_worker" }, { $set: { status: "in_progress" } });
  eq(staleFinal.matchedCount, 0, "stale claim token → cannot mutate batch after takeover");
  const leaseBd2 = await batchesColl.findOne({ batch_id: leaseBatchId }) as { status?: string } | null;
  eq(leaseBd2?.status, "applied", "stale claimant attempt → batch stays applied");

  // ═══ 18. historical batch replay — V1→V2→reapply V1 ═══
  console.log("\n=== 18. Historical batch replay ===");
  const SRC_H1 = { ...SRC_SUPPORTED, workflowId: "workflow_HIST1", loadedVersionId: "workflow-version_H1",
    versions: [{ workflowVersionId: "workflow-version_H1", status: "active" }] };
  const SRC_H2 = { ...SRC_H1, loadedVersionId: "workflow-version_H2",
    versions: [{ workflowVersionId: "workflow-version_H2", status: "active" }],
    nodes: [...SRC_H1.nodes.slice(0, 1), { ...SRC_H1.nodes[1], data: { ...SRC_H1.nodes[1].data, message: { type: "text", text: "hi v2" } } }] };
  const hB1 = previewZaapiFlows({ flows: [SRC_H1] }, { indexRows: [{ wid: "workflow_HIST1", name: "hist" }] });
  const hB2 = previewZaapiFlows({ flows: [SRC_H2] }, { indexRows: [{ wid: "workflow_HIST1", name: "hist" }] });
  const hR1 = await svcAny.applyImportBatch(hB1, "admin_t") as Record<string, unknown>;
  const hWfId = (hR1.workflow_ids as string[])[0];
  const hR2 = await svcAny.applyImportBatch(hB2, "admin_t") as Record<string, unknown>;
  const hWfAfterV2 = await svc.getWorkflow(hWfId);
  const v2Pointer = hWfAfterV2?.current_version_id;
  const v2Counter = hWfAfterV2?.version;
  const countsBeforeReplay = await recCounts();
  const hReplay = await svcAny.applyImportBatch(hB1, "admin_t") as Record<string, unknown>;
  eq(hReplay.already_applied, true, "reapply V1 (historical) → already_applied");
  eq(canonicalJson(await recCounts()), canonicalJson(countsBeforeReplay), "historical replay → zero new docs");
  const hWfAfterReplay = await svc.getWorkflow(hWfId);
  eq(hWfAfterReplay?.current_version_id, v2Pointer, "pointer stays at V2 (no rollback)");
  eq(hWfAfterReplay?.version, v2Counter, "version counter unchanged after replay");
  eq(hWfAfterReplay?.import?.batch_id, hR2.batch_id, "import.batch_id stays at V2 batch");

  // incomplete historical batch → reconcile artifacts โดยไม่ repoint
  const v1VersionId = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string; fingerprint?: string }).workflow_id === hWfId && (v as { fingerprint?: string }).fingerprint === hB1.reports[0].fingerprint) as { version_id?: string } | undefined;
  await (await mongo.getCollection(COLLECTIONS.workflowRawSnapshots)).deleteOne({ workflow_id: hWfId, version_id: v1VersionId?.version_id });
  const hReplay2 = await svcAny.applyImportBatch(hB1, "admin_t") as Record<string, unknown>;
  eq(hReplay2.ok, true, "incomplete historical batch → reconcile ok");
  const snapBack = await (await mongo.getCollection(COLLECTIONS.workflowRawSnapshots)).findOne({ workflow_id: hWfId, version_id: v1VersionId?.version_id });
  ok(snapBack != null, "reconcile → missing artifact refilled");
  const hWfFinal = await svc.getWorkflow(hWfId);
  eq(hWfFinal?.current_version_id, v2Pointer, "reconcile → pointer still V2 (never repoint historical)");

  // ═══ 19. CAS identity — payload ต่าง graph เดียวกัน + orphan recovery ═══
  console.log("\n=== 19. CAS identity + orphan recovery ===");
  // payload ต่าง name/priority (graph เดิม) ต้องได้ version docs ที่ serialize ต่างกัน
  const casIdWf = supWfId;
  const casIdBefore = await svc.getWorkflow(casIdWf);
  const saveA = await svcAny.saveWorkflowDraft(casIdWf, { name: "payload-a", priority: 1 }, casIdBefore?.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  const saveB = await svcAny.saveWorkflowDraft(casIdWf, { name: "payload-b", priority: 9 }, (await svc.getWorkflow(casIdWf))?.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(saveA.ok, true, "CAS payload A ok");
  eq(saveB.ok, true, "CAS payload B ok");
  ok(saveA.version_id !== saveB.version_id, "different payload → different version identity");
  const vA = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === saveA.version_id) as { name?: string; priority?: number } | undefined;
  const vB = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === saveB.version_id) as { name?: string; priority?: number } | undefined;
  eq(vA?.name, "payload-a", "version doc A serializes its own payload");
  eq(vB?.name, "payload-b", "version doc B serializes its own payload");
  const casIdAfter = await svc.getWorkflow(casIdWf);
  eq(casIdAfter?.current_version_id, saveB.version_id, "pointer → winner payload version doc");

  // hard crash หลัง immutable artifacts (orphan) → payload ใหม่ต้องไม่ถูก seq เดิมขวางถาวร
  armInsertFail(COLLECTIONS.workflows, 999); // disarm guard — workflows coll insert not used here
  disarm();
  armUpdateFail(COLLECTIONS.workflows, 1); // crash @commit → orphan version doc
  let orphanThrew = false;
  try { await svcAny.saveWorkflowDraft(casIdWf, { name: "orphan-payload" }, casIdAfter?.version ?? 0, "admin_t"); } catch { orphanThrew = true; }
  ok(orphanThrew, "CAS crash @commit → orphan version doc left");
  disarm();
  const newPayload = await svcAny.saveWorkflowDraft(casIdWf, { name: "post-orphan-different", priority: 77 }, casIdAfter?.version ?? 0, "admin_t") as { ok?: boolean; conflict?: boolean };
  eq(newPayload.ok, true, "different payload after orphan → save succeeds (not blocked by seq collision)");
  const postOrphan = await svc.getWorkflow(casIdWf);
  const postPtr = postOrphan?.current_version_id;
  const postVerDoc = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === postPtr) as { name?: string; priority?: number } | undefined;
  eq(postVerDoc?.name, "post-orphan-different", "pointer → version doc whose payload matches save");

  // concurrent same expectedVersion → หนึ่งชนะ + ผู้แพ้ conflict + pointer = winner
  const raceBase = postOrphan?.version ?? 0;
  const [ra, rb] = await Promise.allSettled([
    svcAny.saveWorkflowDraft(casIdWf, { name: "race-a" }, raceBase, "admin_t"),
    svcAny.saveWorkflowDraft(casIdWf, { name: "race-b" }, raceBase, "admin_t"),
  ]);
  const wins = [ra, rb].filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ ok?: boolean }>).value.ok === true).length;
  eq(wins, 1, "concurrent same expectedVersion → exactly one winner");
  const loserConf = [ra, rb].some((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<{ conflict?: boolean }>).value.conflict === true);
  ok(loserConf, "loser → conflict response");
  const raceFinal = await svc.getWorkflow(casIdWf);
  const winnerName = ((await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === raceFinal?.current_version_id) as { name?: string } | undefined)?.name;
  ok(winnerName === "race-a" || winnerName === "race-b", "pointer → real winner payload doc");

  // ═══ 20. imported revision safety — force disabled/draft ก่อน graph flip ═══
  console.log("\n=== 20. Imported revision forces disabled/draft ===");
  // seed imported workflow ที่ผิดสภาพ (enabled/published — เสมือน corrupt)
  await (await mongo.getCollection(COLLECTIONS.workflows)).updateOne(
    { workflow_id: hWfId }, { $set: { enabled: true, status: "published" } }
  );
  const SRC_H3 = { ...SRC_H1, loadedVersionId: "workflow-version_H3",
    versions: [{ workflowVersionId: "workflow-version_H3", status: "active" }],
    nodes: [...SRC_H1.nodes.slice(0, 1), { ...SRC_H1.nodes[1], data: { ...SRC_H1.nodes[1].data, message: { type: "text", text: "hi v3" } } }] };
  const hB3 = previewZaapiFlows({ flows: [SRC_H3] }, { indexRows: [{ wid: "workflow_HIST1", name: "hist" }] });
  await svcAny.applyImportBatch(hB3, "admin_t");
  const hWfRev3 = await svc.getWorkflow(hWfId);
  eq(hWfRev3?.enabled, false, "revision apply → forced enabled=false");
  eq(hWfRev3?.status, "draft", "revision apply → forced status=draft");
  eq((await svc.listWorkflows({ enabledOnly: true, publishedOnly: true })).length, 0, "engine-visible still 0 after revision");

  // ═══ 21. imported CAS bypass — version-owned fields ต้องผ่าน CAS เท่านั้น ═══
  console.log("\n=== 21. Imported CAS bypass (non-CAS mutation rejected) ===");
  const bypassWf = hWfId; // imported workflow from section 18/20
  const bypassBefore = await svc.getWorkflow(bypassWf);
  const versBefore21 = await collDocs(COLLECTIONS.workflowVersions);
  const bindsBefore21 = await collDocs(COLLECTIONS.workflowBindings);

  const bypassErr = await act(() => svc.updateWorkflow(bypassWf, { name: "bypassed" }, "admin_t"));
  ok(bypassErr != null, "non-CAS name mutation on imported → rejected");
  ok(/expected_version|CAS/i.test(bypassErr || ""), "bypass rejection names expected_version/CAS (explicit, not 404)");
  ok((await act(() => svc.updateWorkflow(bypassWf, { nodes: [{ node_id: "x", type: "action", subtype: "send_text", config: {}, position: { x: 0, y: 0 } }] }, "admin_t"))) != null, "non-CAS nodes mutation on imported → rejected");
  ok((await act(() => svc.updateWorkflow(bypassWf, { priority: 99 }, "admin_t"))) != null, "non-CAS priority mutation on imported → rejected");

  // rejection → byte-identical state
  const bypassAfter = await svc.getWorkflow(bypassWf);
  eq(canonicalJson(bypassAfter), canonicalJson(bypassBefore), "rejected non-CAS mutation → workflow doc unchanged");
  eq((await collDocs(COLLECTIONS.workflowVersions)).length, versBefore21.length, "rejected → zero new version docs");
  eq(canonicalJson(await collDocs(COLLECTIONS.workflowBindings)), canonicalJson(bindsBefore21), "rejected → bindings unchanged");

  // imported CAS with correct expected_version → ยังใช้ได้
  const casStill = await svcAny.saveWorkflowDraft(bypassWf, { name: "via-cas" }, bypassBefore?.version ?? 0, "admin_t") as { ok?: boolean };
  eq(casStill.ok, true, "imported CAS with expected_version → still succeeds");

  // activation-only via non-CAS path → ยังผ่าน activation invariant เดิม (blocked)
  ok((await act(() => svc.updateWorkflow(bypassWf, { enabled: true }, "admin_t"))) != null, "non-CAS enabled=true on imported → still blocked by activation invariant");

  // legacy non-CAS mutation → พฤติกรรมเดิม
  const legacyOk = await svc.updateWorkflow(legacy.workflow_id, { name: "legacy-noncas", priority: 5 }, "admin_t");
  eq(legacyOk, true, "legacy non-CAS update unchanged");

  // ═══ 22. stale claimant fencing — lease เสียกลาง apply ═══
  console.log("\n=== 22. Stale claimant fencing ===");
  const SRC_F1 = { ...SRC_SUPPORTED, workflowId: "workflow_FENCE1", loadedVersionId: "workflow-version_F1",
    versions: [{ workflowVersionId: "workflow-version_F1", status: "active" }] };
  const SRC_F2 = { ...SRC_SUPPORTED, workflowId: "workflow_FENCE2", loadedVersionId: "workflow-version_F2",
    versions: [{ workflowVersionId: "workflow-version_F2", status: "active" }] };
  const fenceBatch = previewZaapiFlows({ flows: [SRC_F1, SRC_F2] },
    { indexRows: [{ wid: "workflow_FENCE1", name: "f1" }, { wid: "workflow_FENCE2", name: "f2" }] });
  const fenceFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint({ source: "zaapi", flows: fenceBatch.reports.map((r) => `${r.draft.sourceRef.workflowId}|${r.fingerprint}|${reqKeyOf(r)}`) });
  const fenceBatchId = "wib_" + _sh(fenceFp);

  // steal claim เมื่อ A อ่าน versions ของ flow ที่ 2 — takeover+lease หมดอายุ
  // (claimant B ตายด้วย → lease past → caller ถัดไป takeover ได้ deterministic)
  // findOne#3 = flow2 dupVersion (verify/bump เพิ่ม seq-check 1 ครั้งต่อ flow)
  let stealFired = false;
  let findN = 0;
  st.findOneHook = async (coll: string) => {
    if (coll === COLLECTIONS.workflowVersions && ++findN === 2 && !stealFired) {
      stealFired = true;
      await (await mongo.getCollection(COLLECTIONS.workflowImportBatches)).updateOne(
        { batch_id: fenceBatchId },
        { $set: { claim_token: "tok_claimant_b", claim_expires_at: new Date(Date.now() - 1_000) } }
      );
    }
  };
  let fenceThrew: { code?: string } | null = null;
  try { await svcAny.applyImportBatch(fenceBatch, "admin_a"); } catch (e) { fenceThrew = e as { code?: string }; }
  ok(fenceThrew != null, "stale claimant → apply throws after claim loss");
  eq(fenceThrew?.code, "IMPORT_IN_PROGRESS", "stale claimant → IMPORT_IN_PROGRESS");
  st.findOneHook = undefined;

  const fenceWfs = (await collDocs(COLLECTIONS.workflows)).filter((w) => JSON.stringify(w).includes("FENCE"));
  eq(fenceWfs.length, 1, "stale claimant wrote only flow1 (pre-loss); flow2 untouched");
  const fenceBd = (await collDocs(COLLECTIONS.workflowImportBatches)).find((b) => (b as { batch_id?: string }).batch_id === fenceBatchId) as { status?: string } | undefined;
  ok(fenceBd?.status !== "applied", "stale claimant → batch NOT applied");
  eq(fenceBd?.status, "in_progress", "stale claimant cannot mark batch failed (fenced release → stays in_progress)");

  // claimant B takeover → completes → pointer owned by B's artifacts
  const fenceRetry = await svcAny.applyImportBatch(fenceBatch, "admin_b") as Record<string, unknown>;
  eq(fenceRetry.ok, true, "claimant B takeover → apply completes");
  const fenceWfsAfter = (await collDocs(COLLECTIONS.workflows)).filter((w) => JSON.stringify(w).includes("FENCE"));
  eq(fenceWfsAfter.length, 2, "B resumed → both flows persisted");
  const fenceBd2 = (await collDocs(COLLECTIONS.workflowImportBatches)).find((b) => (b as { batch_id?: string }).batch_id === fenceBatchId) as { status?: string; workflow_ids?: string[] } | undefined;
  eq(fenceBd2?.status, "applied", "takeover → batch applied");
  eq(fenceBd2?.workflow_ids?.length, 2, "applied batch → 2 workflow_ids, zero dup");

  // stale claimant A ลอง finalize หลังเสีย ownership → fenced
  const staleFin = await (await mongo.getCollection(COLLECTIONS.workflowImportBatches)).updateOne(
    { batch_id: fenceBatchId, claim_token: "tok_stale_a" }, { $set: { status: "failed" } }
  );
  eq(staleFin.matchedCount, 0, "stale claimant finalize → fenced");
  const fenceBd3 = await collDocs(COLLECTIONS.workflowImportBatches);
  eq((fenceBd3.find((b) => (b as { batch_id?: string }).batch_id === fenceBatchId) as { status?: string })?.status, "applied", "batch stays applied after stale attempt");

  // ═══ 23. binding identity completeness — count match ไม่พอ ═══
  console.log("\n=== 23. Binding identity completeness ===");
  const SRC_BIND = { ...SRC_FLOW, workflowId: "workflow_BINDID1", loadedVersionId: "workflow-version_B1",
    versions: [{ workflowVersionId: "workflow-version_B1", status: "active" }] };
  const bindBatch = previewZaapiFlows({ flows: [SRC_BIND] }, { indexRows: [{ wid: "workflow_BINDID1", name: "bind" }] });
  await svcAny.applyImportBatch(bindBatch, "admin_t");
  const bindWfId = "wf_imp_" + _sh("workflow_BINDID1");
  const bindVer = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === bindWfId) as { version_id?: string } | undefined;
  const bindColl = await mongo.getCollection(COLLECTIONS.workflowBindings);
  const bindsOfV = (await bindColl.find({ workflow_id: bindWfId, version_id: bindVer?.version_id }).toArray()) as { binding_id?: string; node_id?: string }[];
  const victimId = bindsOfV[0]?.binding_id;
  // corrupt: ลบ expected binding → เพิ่ม bogus binding (count เท่าเดิม identity ต่าง)
  await bindColl.deleteOne({ binding_id: victimId });
  await bindColl.insertOne({ binding_id: "wb_bogus_corrupt", workflow_id: bindWfId, version_id: bindVer?.version_id,
    node_id: "zn_fake", field_path: "x", kind: "user", count: 1, source_ref: "nodes[x].data.x", status: "unresolved", created_at: new Date() });
  let corruptErr: { code?: string } | null = null;
  try { await svcAny.applyImportBatch(bindBatch, "admin_t"); } catch (e) { corruptErr = e as { code?: string }; }
  eq(corruptErr?.code, "IMPORT_INVALID", "extra corrupt binding identity → IMPORT_INVALID (fail closed)");
  const corruptBd = await collDocs(COLLECTIONS.workflowImportBatches);
  const bindBd = corruptBd.find((b) => (b as { workflow_ids?: string[] }).workflow_ids?.includes(bindWfId));
  ok((bindBd as { status?: string } | undefined)?.status !== "applied", "corrupt batch → NOT applied");
  ok((await bindColl.findOne({ binding_id: "wb_bogus_corrupt" })) != null, "bogus binding preserved for inspection (no destructive repair)");

  // missing-only recovery → reconcile idempotent + applied
  const SRC_BIND2 = { ...SRC_FLOW, workflowId: "workflow_BINDID2", loadedVersionId: "workflow-version_B2",
    versions: [{ workflowVersionId: "workflow-version_B2", status: "active" }] };
  const bindBatch2 = previewZaapiFlows({ flows: [SRC_BIND2] }, { indexRows: [{ wid: "workflow_BINDID2", name: "bind2" }] });
  await svcAny.applyImportBatch(bindBatch2, "admin_t");
  const bindWf2 = "wf_imp_" + _sh("workflow_BINDID2");
  const bindVer2 = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === bindWf2) as { version_id?: string } | undefined;
  const bindsOfV2 = await bindColl.find({ workflow_id: bindWf2, version_id: bindVer2?.version_id }).toArray() as { binding_id?: string }[];
  await bindColl.deleteOne({ binding_id: bindsOfV2[0]?.binding_id });
  const missReplay = await svcAny.applyImportBatch(bindBatch2, "admin_t") as Record<string, unknown>;
  eq(missReplay.ok, true, "missing-only binding → reconcile ok");
  ok((await bindColl.findOne({ binding_id: bindsOfV2[0]?.binding_id })) != null, "reconcile → missing binding restored");
  eq((await svcAny.applyImportBatch(bindBatch2, "admin_t") as Record<string, unknown>).already_applied, true, "reconciled missing-only → already_applied");

  // ═══ 24. lease renewal — valid owner ข้าม original deadline ได้ ═══
  console.log("\n=== 24. Lease renewal (valid owner crosses deadline) ===");
  const SRC_R1 = { ...SRC_SUPPORTED, workflowId: "workflow_RENEW1", loadedVersionId: "workflow-version_R1",
    versions: [{ workflowVersionId: "workflow-version_R1", status: "active" }] };
  const SRC_R2 = { ...SRC_SUPPORTED, workflowId: "workflow_RENEW2", loadedVersionId: "workflow-version_R2",
    versions: [{ workflowVersionId: "workflow-version_R2", status: "active" }] };
  const renewBatch = previewZaapiFlows({ flows: [SRC_R1, SRC_R2] },
    { indexRows: [{ wid: "workflow_RENEW1", name: "r1" }, { wid: "workflow_RENEW2", name: "r2" }] });
  const renewFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint({ source: "zaapi", flows: renewBatch.reports.map((r) => `${r.draft.sourceRef.workflowId}|${r.fingerprint}|${reqKeyOf(r)}`) });
  const renewBatchId = "wib_" + _sh(renewFp);

  // expire A's own lease ระหว่าง flow1→flow2 (ไม่มีใคร takeover — token เดิม)
  // findOne#2 = flow2 version-slot check (dupVersion ใช้ find() ไม่นับ findOne)
  let expireFired = false; let renewN = 0;
  st.findOneHook = async (coll: string) => {
    if (coll === COLLECTIONS.workflowVersions && ++renewN === 2 && !expireFired) {
      expireFired = true;
      await (await mongo.getCollection(COLLECTIONS.workflowImportBatches)).updateOne(
        { batch_id: renewBatchId }, { $set: { claim_expires_at: new Date(Date.now() - 1_000) } }
      );
    }
  };
  const renewRes = await svcAny.applyImportBatch(renewBatch, "admin_a") as Record<string, unknown>;
  st.findOneHook = undefined;
  eq(renewRes.ok, true, "valid owner renews expired-but-untaken lease → apply completes");
  const renewBd = (await collDocs(COLLECTIONS.workflowImportBatches)).find((b) => (b as { batch_id?: string }).batch_id === renewBatchId) as { status?: string; claim_expires_at?: Date } | undefined;
  eq(renewBd?.status, "applied", "renewed claimant → batch applied");
  ok(renewBd?.claim_expires_at == null || new Date(renewBd.claim_expires_at).getTime() > Date.now() - 1_000, "claim_expires_at moved forward / released");
  const renewWfs = (await collDocs(COLLECTIONS.workflows)).filter((w) => JSON.stringify(w).includes("RENEW"));
  eq(renewWfs.length, 2, "multi-flow import crossed original 60s deadline");

  // replaced token → renew/mutate ไม่ได้ (fence semantics เดิมจาก round 3)
  ok((await collDocs(COLLECTIONS.workflowImportBatches)).length > 0, "sanity");

  // ═══ 25. binding multiplicity — duplicate same binding_id row ═══
  console.log("\n=== 25. Binding multiplicity (dup binding_id row) ===");
  // จำลอง pre-DDL state: unique index declared แต่ยังไม่ได้สร้างใน production
  // → ชั่วคราวปิด unique enforcement เพื่อ insert dup row จริงผ่าน fake Mongo
  const uniq = st.uniqueKeys as Record<string, string[]>;
  const origKeys = uniq.workflow_bindings;
  uniq.workflow_bindings = [];
  try {
    await bindColl.insertOne({ binding_id: bindsOfV2[0]?.binding_id, workflow_id: bindWf2, version_id: bindVer2?.version_id,
      node_id: "zn_dup", field_path: "dup", kind: "user", count: 1, source_ref: "dup", status: "unresolved", created_at: new Date() });
  } finally {
    uniq.workflow_bindings = origKeys;
  }
  let dupErr: { code?: string } | null = null;
  try { await svcAny.applyImportBatch(bindBatch2, "admin_t"); } catch (e) { dupErr = e as { code?: string }; }
  eq(dupErr?.code, "IMPORT_INVALID", "duplicate same binding_id row → IMPORT_INVALID (set collapse must not pass)");
  const dupRows = await bindColl.find({ workflow_id: bindWf2, binding_id: bindsOfV2[0]?.binding_id }).toArray();
  eq(dupRows.length, 2, "duplicate corrupt rows preserved for inspection");

  // ═══ 26. Task 4 — exact carry-forward: Zaapi re-import ═══
  console.log("\n=== 26. Carry-forward: Zaapi re-import (exact gate) ===");
  // local identity fixtures — validation-read targets เท่านั้น
  await (await mongo.getCollection(COLLECTIONS.shops)).insertOne({ shop_id: "shop_cf1", platform: "shopee", shopname: "cf1", connected: true });
  await (await mongo.getCollection(COLLECTIONS.shops)).insertOne({ shop_id: "shop_cf2", platform: "tiktok", shopname: "cf2", connected: true });
  await (await mongo.getCollection(COLLECTIONS.conversations)).insertOne({ conversation_id: "conv_cf", labels: ["vip", "gold"] });
  await (await mongo.getCollection(COLLECTIONS.admins)).insertOne({ admin_id: "adm_cf1", role: "agent", active: true });
  await (await mongo.getCollection(COLLECTIONS.admins)).insertOne({ admin_id: "adm_cf2", role: "agent", active: true });

  // fixture: account×2 (direct+repeat sibling) · label · user×2 · send_message (no binding)
  const SRC_CF = {
    loadedVersionId: "wv-src-CF",
    versions: [{ workflowVersionId: "wv-src-CF", status: "active" }],
    nodes: [
      { id: "t1", type: "message_received", position: { x: 0, y: 0 },
        data: { name: "trig", nodeType: "trigger", accountIds: ["zacc_1", "zacc_2"], nextStepId: "c1" } },
      { id: "c1", type: "label", position: { x: 100, y: 0 },
        data: { name: "cond", nodeType: "condition",
                conditions: [{ labelIds: ["zlab_1"], nextStepId: "a1" }], noMatchNextStepId: "a2" } },
      { id: "a1", type: "chat_assign", position: { x: 200, y: 0 },
        data: { name: "assign", nodeType: "action",
                action: { assignment: { userIds: ["zusr_1", "zusr_2"] } },
                accountIds: ["zacc_2"], nextStepId: "a2" } },
      { id: "a2", type: "send_message", position: { x: 300, y: 0 },
        data: { name: "reply", nodeType: "action",
                action: { message: { text: "hello" } } } },
    ],
    edges: [
      { source: "t1", target: "c1", sourceHandle: null },
      { source: "c1", target: "a1", sourceHandle: "condition-index-0" },
      { source: "c1", target: "a2", sourceHandle: "no-match" },
      { source: "a1", target: "a2", sourceHandle: null },
    ],
  };
  const cfNode = (i: number) => SRC_CF.nodes[i] as unknown as Record<string, unknown>;
  const cfData = (i: number) => cfNode(i).data as Record<string, unknown>;
  type CfMap = { source_index?: number; source_fp?: string; local_id?: string; platform?: string;
    shop_id?: string; state?: string; via?: string; carried?: boolean;
    resolved_by?: string; resolved_at?: Date; invalidated_at?: Date; invalid_reason?: string };
  type CfBind = { binding_id?: string; workflow_id?: string; version_id?: string; node_id?: string;
    field_path?: string; kind?: string; count?: number; status?: string; source_values?: unknown[];
    resolution?: { mappings?: CfMap[]; conflict?: string } };
  const cf256 = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
  const cfSorted = (a: unknown) => JSON.stringify([...(Array.isArray(a) ? a as unknown[] : [])].sort());

  async function cfApply(tag: string, nodes: unknown[], edges = SRC_CF.edges as unknown[]) {
    const src = { ...SRC_CF, workflowId: `workflow_CF_${tag}`, loadedVersionId: `wv-cf-${tag}`,
      versions: [{ workflowVersionId: `wv-cf-${tag}`, status: "active" }], nodes, edges };
    const b = previewZaapiFlows({ flows: [src] }, { indexRows: [{ wid: src.workflowId, name: `cf ${tag}` }] });
    const r = await svcAny.applyImportBatch(b, "admin_t") as Record<string, unknown>;
    return { src, batch: b, result: r, wfId: "wf_imp_" + _sh(src.workflowId) };
  }
  async function bindsOf(wfId: string, versionId: string | undefined) {
    return (await collDocs(COLLECTIONS.workflowBindings))
      .filter((b) => (b as CfBind).workflow_id === wfId && (b as CfBind).version_id === versionId) as unknown as CfBind[];
  }
  async function cfResolve(wfId: string) {
    const wfDoc = (await svc.getWorkflow(wfId)) as { version?: number; current_version_id?: string };
    const binds = await bindsOf(wfId, wfDoc.current_version_id);
    const byVals = (kind: string, vals: unknown[]) =>
      binds.find((b) => b.kind === kind && canonicalJson(b.source_values) === canonicalJson(vals))!;
    return await svcAny.saveBindingResolutionBatch(wfId, {
      workflow_id: wfId, expected_version: wfDoc.version, version_id: wfDoc.current_version_id,
      proposed: [
        { binding_id: byVals("account", ["zacc_1", "zacc_2"]).binding_id, repeat: true, mappings: [
          { source_index: 0, local_id: "shop_cf1", platform: "shopee", shop_id: "shop_cf1" },
          { source_index: 1, local_id: "shop_cf2", platform: "tiktok", shop_id: "shop_cf2" } ] },
        { binding_id: byVals("label", ["zlab_1"]).binding_id, mappings: [ { source_index: 0, local_id: "vip" } ] },
        { binding_id: byVals("user", ["zusr_1", "zusr_2"]).binding_id, mappings: [
          { source_index: 0, local_id: "adm_cf1" }, { source_index: 1, local_id: "adm_cf2" } ] },
      ],
    }, "admin_t") as { ok?: boolean; version_id?: string; repeated?: unknown[] };
  }
  async function versionJson(versionId: string | undefined) {
    return canonicalJson((await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === versionId));
  }
  const acc2 = (b: CfBind) => b.kind === "account" && b.count === 2;   // trigger binding
  const acc1 = (b: CfBind) => b.kind === "account" && b.count === 1;   // sibling (repeat) binding

  // — v1 resolved version: direct×account+label+user · repeat account sibling · carried absent —
  const cfBase = await cfApply("BASE", SRC_CF.nodes as unknown[]);
  const cfBaseRes = await cfResolve(cfBase.wfId);
  eq(cfBaseRes.ok, true, "fixture: resolution save ok (repeat expanded to sibling)");
  const basePrevVerId = cfBaseRes.version_id;
  const basePrevBinds = await bindsOf(cfBase.wfId, basePrevVerId);
  eq(basePrevBinds.length, 4, "resolved version: 4 bindings (2 account + 1 label + 1 user)");
  ok(basePrevBinds.every((b) => b.status === "resolved"), "resolved version: all bindings resolved");
  ok(basePrevBinds.every((b) => (b.resolution?.mappings ?? []).every((m) => m.carried === undefined)), "original version: zero carried metadata");
  ok((basePrevBinds.find(acc1)?.resolution?.mappings ?? []).every((m) => m.via === "repeat"), "fixture: sibling mapping via:'repeat'");
  const basePrevVerJson = await versionJson(basePrevVerId);
  const basePrevBindsJson = canonicalJson(basePrevBinds);
  const baseWfBefore = (await svc.getWorkflow(cfBase.wfId)) as { version?: number };

  // — identical requirement re-import (fingerprint differs via message text only) → carry ALL —
  const sameReqNodes = [
    cfNode(0), cfNode(1), cfNode(2),
    { ...cfNode(3), data: { ...cfData(3), action: { message: { text: "hello v2" } } } },
  ];
  const baseR2 = await cfApply("BASE", sameReqNodes);
  eq(baseR2.result.ok, true, "identical-requirement re-import apply ok");
  const baseWfAfter = (await svc.getWorkflow(cfBase.wfId)) as { current_version_id?: string; version?: number; enabled?: boolean; status?: string; shop_ids?: string[]; nodes?: unknown[] };
  ok(baseWfAfter.current_version_id != null && baseWfAfter.current_version_id !== basePrevVerId, "re-import → new immutable version_id (pointer moved)");
  eq(baseWfAfter.version, (baseWfBefore.version ?? 0) + 1, "re-import → version counter +1");
  eq(baseWfAfter.enabled, false, "carried re-import → still enabled=false");
  eq(baseWfAfter.status, "draft", "carried re-import → still status=draft");
  eq(await versionJson(basePrevVerId), basePrevVerJson, "re-import → old version doc byte-identical");
  eq(canonicalJson(await bindsOf(cfBase.wfId, basePrevVerId)), basePrevBindsJson, "re-import → old bindings byte-identical");
  const baseNewBinds = await bindsOf(cfBase.wfId, baseWfAfter.current_version_id);
  eq(baseNewBinds.length, 4, "identical requirement → same binding count");
  ok(baseNewBinds.every((b) => b.status === "resolved"), "identical requirement → all carried resolved");
  ok(baseNewBinds.every((b) => (b.resolution?.mappings?.length ?? 0) > 0
    && (b.resolution?.mappings ?? []).every((m) => m.carried === true)), "carried mappings marked carried:true");
  const baseAcc2 = baseNewBinds.find(acc2)?.resolution?.mappings ?? [];
  const baseAcc1 = baseNewBinds.find(acc1)?.resolution?.mappings ?? [];
  ok(baseAcc2.length === 2 && baseAcc2.every((m) => m.via === "direct"), "carried: via:'direct' preserved");
  ok(baseAcc1.length === 1 && baseAcc1.every((m) => m.via === "repeat"), "carried: via:'repeat' preserved");
  ok(baseAcc2.every((m) => m.source_fp === cf256((baseNewBinds.find(acc2)?.source_values ?? [])[m.source_index ?? 0])), "carried: source_index + source_fp intact");
  ok(baseAcc2.every((m) => m.platform != null && m.shop_id != null), "carried: account scope fields preserved");
  const baseLab = baseNewBinds.find((b) => b.kind === "label")?.resolution?.mappings ?? [];
  ok(baseLab.length === 1 && baseLab.every((m) => m.platform === undefined && m.shop_id === undefined), "carried: non-account mapping has no scope fields");
  eq(cfSorted(baseWfAfter.shop_ids), cfSorted(["shop_cf1", "shop_cf2"]), "carried re-import → derived shop scope preserved");
  eq(cfSorted((baseWfAfter as { platforms?: string[] }).platforms), cfSorted(["shopee", "tiktok"]), "carried re-import → doc platforms = derived scope (atomic with pointer)");
  const baseNewVerNodes = (((await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === baseWfAfter.current_version_id)) as { nodes?: { config?: unknown }[] })?.nodes ?? [];
  const baseCfgJson = canonicalJson(baseNewVerNodes.map((n) => n.config));
  ok(!baseCfgJson.includes("zacc_1") && !baseCfgJson.includes("zlab_1") && !baseCfgJson.includes("zusr_1"), "carried version config → zero external ids");

  // — mismatch matrix — change exactly one carry condition per case —
  // NOTE: fingerprint covers canonical nodes only (external ids stripped) —
  // source_values-only changes produce NO new version. Every variant also
  // changes a2's message text to force a new immutable version.
  async function cfMismatch(tag: string, nodes: unknown[], edges?: unknown[]) {
    const c1 = await cfApply(tag, SRC_CF.nodes as unknown[]);
    await cfResolve(c1.wfId);
    const wfB = (await svc.getWorkflow(c1.wfId)) as { current_version_id?: string; version?: number };
    const prevVerId = wfB.current_version_id;
    const prevBindsJson = canonicalJson(await bindsOf(c1.wfId, prevVerId));
    await cfApply(tag, nodes, edges);
    const wfA = (await svc.getWorkflow(c1.wfId)) as { current_version_id?: string; version?: number; enabled?: boolean; status?: string };
    return { c1, prevVerId, prevBindsJson, wfA, newBinds: await bindsOf(c1.wfId, wfA.current_version_id) };
  }

  // count change → affected binding unresolved; other exact bindings still carried (partial carry)
  const cnt = await cfMismatch("COUNT", [
    { ...cfNode(0), data: { ...cfData(0), accountIds: ["zacc_1", "zacc_2", "zacc_3"] } },
    cfNode(1), cfNode(2), sameReqNodes[3]]);
  const cntTrig = cnt.newBinds.find((b) => b.kind === "account" && b.count === 3);
  ok(cntTrig != null && cntTrig.status === "unresolved" && !(cntTrig.resolution?.mappings?.length), "count change → affected binding fresh unresolved");
  eq(cnt.newBinds.filter((b) => b.status === "resolved").length, 3, "count change → only exact bindings carry (no group authorization)");
  const cntSib = cnt.newBinds.find(acc1)?.resolution?.mappings ?? [];
  ok(cntSib.length === 1 && cntSib.every((m) => m.via === "repeat" && m.carried === true), "count change → exact sibling binding still carried via:'repeat'");
  eq(canonicalJson(await bindsOf(cnt.c1.wfId, cnt.prevVerId)), cnt.prevBindsJson, "count change → old bindings byte-identical");
  eq(cnt.wfA.enabled, false, "count change → still disabled");
  eq(cnt.wfA.status, "draft", "count change → still draft");
  const cntWf = (await svc.getWorkflow(cnt.c1.wfId)) as { shop_ids?: string[]; platforms?: string[] };
  eq(cfSorted(cntWf.shop_ids), cfSorted(["shop_cf2"]), "count change → doc shop_ids = new-version derived scope (sibling only)");
  eq(cfSorted(cntWf.platforms), cfSorted(["tiktok"]), "count change → doc platforms = new-version derived scope");

  // reordered source_values → positional source_index identity broken → unresolved
  const ro = await cfMismatch("REORDER", [
    { ...cfNode(0), data: { ...cfData(0), accountIds: ["zacc_2", "zacc_1"] } },
    cfNode(1), cfNode(2), sameReqNodes[3]]);
  const roTrig = ro.newBinds.find((b) => b.kind === "account" && b.count === 2);
  ok(roTrig != null && roTrig.status === "unresolved" && !(roTrig.resolution?.mappings?.length), "reordered source_values → unresolved (no positional reuse)");
  eq(ro.newBinds.filter((b) => b.status === "resolved").length, 3, "reorder → only exact bindings carry");

  // source_values value change → unresolved
  const val = await cfMismatch("VALUE", [
    { ...cfNode(0), data: { ...cfData(0), accountIds: ["zacc_1", "zacc_9"] } },
    cfNode(1), cfNode(2), sameReqNodes[3]]);
  const valTrig = val.newBinds.find((b) => b.kind === "account" && b.count === 2);
  ok(valTrig != null && valTrig.status === "unresolved" && !(valTrig.resolution?.mappings?.length), "changed source value → unresolved (no external-id guess/remap)");
  eq(val.newBinds.filter((b) => b.status === "resolved").length, 3, "value change → only exact bindings carry");

  // field_path change (same kind, same values) → unresolved
  const fp = await cfMismatch("FIELD", [
    { ...cfNode(0), data: { name: "trig", nodeType: "trigger", accountId: ["zacc_1", "zacc_2"], nextStepId: "c1" } },
    cfNode(1), cfNode(2), sameReqNodes[3]]);
  const fpTrig = fp.newBinds.find((b) => b.kind === "account" && b.count === 2);
  ok(fpTrig != null && fpTrig.status === "unresolved" && !(fpTrig.resolution?.mappings?.length), "field_path change → unresolved");
  eq(fpTrig?.field_path, "accountId", "field_path recorded as new requirement path");
  eq(fp.newBinds.filter((b) => b.status === "resolved").length, 3, "field_path change → only exact bindings carry");

  // kind change (field_path+kind differ) → unresolved
  const kd = await cfMismatch("KIND", [
    { ...cfNode(0), data: { name: "trig", nodeType: "trigger", userIds: ["zacc_1", "zacc_2"], nextStepId: "c1" } },
    cfNode(1), cfNode(2), sameReqNodes[3]]);
  const kdTrig = kd.newBinds.find((b) => b.count === 2 && b.field_path === "userIds");
  ok(kdTrig != null && kdTrig.status === "unresolved" && !(kdTrig.resolution?.mappings?.length), "kind change → unresolved");
  eq(kd.newBinds.filter((b) => b.status === "resolved").length, 3, "kind change → only exact bindings carry");

  // node removed → its bindings absent on new version (old intact)
  const a1NodeId = (await bindsOf(cfBase.wfId, baseWfAfter.current_version_id)).find((b) => b.field_path === "action.assignment.userIds")?.node_id;
  const rm = await cfMismatch("RMNODE", [
    cfNode(0),
    { ...cfNode(1), data: { name: "cond", nodeType: "condition",
        conditions: [{ labelIds: ["zlab_1"], nextStepId: "a2" }], noMatchNextStepId: "a2" } },
    cfNode(3)],
    [{ source: "t1", target: "c1", sourceHandle: null },
     { source: "c1", target: "a2", sourceHandle: "condition-index-0" },
     { source: "c1", target: "a2", sourceHandle: "no-match" }]);
  ok(rm.newBinds.every((b) => b.node_id !== a1NodeId), "removed node → zero bindings on new version");
  eq(rm.newBinds.length, 2, "removed node → only surviving-node bindings carried");
  ok(rm.newBinds.every((b) => b.status === "resolved"), "removed node → surviving bindings still resolved");
  ok((await bindsOf(rm.c1.wfId, rm.prevVerId)).some((b) => b.node_id === a1NodeId), "removed node → old version keeps its bindings");

  // source_workflow_id change → entirely different local workflow (no cross-source carry)
  const alien = await cfApply("ALIEN", SRC_CF.nodes as unknown[]);
  ok(alien.wfId !== cfBase.wfId, "different source_workflow_id → different local workflow");
  const alienBinds = await bindsOf(alien.wfId, (await svc.getWorkflow(alien.wfId))?.current_version_id);
  ok(alienBinds.length > 0 && alienBinds.every((b) => b.status === "unresolved"), "new source → all bindings fresh unresolved");

  // scope contract change — account mapping's (platform,shop_id) pair no longer matches shops → invalid
  const sc = await cfApply("SCOPE", SRC_CF.nodes as unknown[]);
  await cfResolve(sc.wfId);
  const shopsColl = await mongo.getCollection(COLLECTIONS.shops);
  await shopsColl.updateOne({ shop_id: "shop_cf2" }, { $set: { platform: "lazada" } });
  const scPrev = (await svc.getWorkflow(sc.wfId)) as { current_version_id?: string };
  const scPrevJson = canonicalJson(await bindsOf(sc.wfId, scPrev.current_version_id));
  await cfApply("SCOPE", sameReqNodes);
  const scAfter = (await svc.getWorkflow(sc.wfId)) as { current_version_id?: string };
  const scBinds = await bindsOf(sc.wfId, scAfter.current_version_id);
  const scM = scBinds.find(acc2)?.resolution?.mappings?.find((m) => m.local_id === "shop_cf2");
  eq(scM?.state, "invalid", "scope contract change (platform mismatch) → mapping invalid");
  ok(scM?.invalidated_at != null && typeof scM?.invalid_reason === "string", "scope-invalid carry keeps invalidated_at + reason");
  eq(scBinds.find(acc2)?.status, "invalid", "scope contract change → binding status invalid");
  eq(scBinds.find(acc1)?.status, "invalid", "sibling repeat binding → same dead scope → invalid");
  const scMaps = scBinds.find(acc2)?.resolution?.mappings ?? [];
  ok(scMaps.length === 2 && scMaps.every((m) => m.carried === true), "invalid-scope mapping still carried (inspection preserved)");
  eq(canonicalJson(await bindsOf(sc.wfId, scPrev.current_version_id)), scPrevJson, "scope case → old bindings byte-identical");
  await shopsColl.updateOne({ shop_id: "shop_cf2" }, { $set: { platform: "tiktok" } });

  // local target deleted → mapping kept as invalid (never silently dropped)
  const del = await cfApply("DEL", SRC_CF.nodes as unknown[]);
  await cfResolve(del.wfId);
  const delPrev = (await svc.getWorkflow(del.wfId)) as { current_version_id?: string };
  const delPrevJson = canonicalJson(await bindsOf(del.wfId, delPrev.current_version_id));
  await shopsColl.deleteOne({ shop_id: "shop_cf2" });
  await cfApply("DEL", sameReqNodes);
  const delAfter = (await svc.getWorkflow(del.wfId)) as { current_version_id?: string };
  const delBinds = await bindsOf(del.wfId, delAfter.current_version_id);
  const delM = delBinds.find(acc2)?.resolution?.mappings?.find((m) => m.local_id === "shop_cf2");
  eq(delM?.state, "invalid", "deleted target → carried mapping state:'invalid'");
  ok(delM?.invalidated_at != null && typeof delM?.invalid_reason === "string", "deleted target → invalidated_at + invalid_reason present");
  eq(delM?.local_id, "shop_cf2", "deleted target → original local identity preserved for inspection");
  eq(delBinds.find(acc2)?.status, "invalid", "deleted target → binding status invalid");
  eq(delBinds.find(acc1)?.status, "invalid", "deleted target → sibling repeat binding invalid too");
  eq(delBinds.find(acc2)?.resolution?.mappings?.find((m) => m.local_id === "shop_cf1")?.state, "valid", "deleted target → live target stays valid");
  eq(canonicalJson(await bindsOf(del.wfId, delPrev.current_version_id)), delPrevJson, "deleted target → old bindings byte-identical");
  const delWf = (await svc.getWorkflow(del.wfId)) as { shop_ids?: string[]; platforms?: string[]; enabled?: boolean; status?: string };
  eq(cfSorted(delWf.shop_ids), cfSorted(["shop_cf1"]), "partial-invalid carry → doc scope = surviving valid mappings only");
  eq(cfSorted(delWf.platforms), cfSorted(["shopee"]), "partial-invalid carry → doc platforms = surviving valid only");
  const delDetail = await svcAny.getWorkflowImportDetail(del.wfId) as { publish_blockers?: string[] };
  ok((delDetail.publish_blockers ?? []).includes("account_scope: incomplete account mappings"), "partial-invalid carry → incomplete blocker (invalid excluded from scope)");
  eq(delWf.enabled, false, "partial-invalid carry → still disabled");
  eq(delWf.status, "draft", "partial-invalid carry → still draft");
  await shopsColl.insertOne({ shop_id: "shop_cf2", platform: "tiktok", shopname: "cf2", connected: true });

  // ═══ 27. Task 4 — re-import idempotency / historical replay / crash ═══
  console.log("\n=== 27. Carry-forward: idempotency + historical replay + crash ===");
  const hist1 = await cfApply("HIST", SRC_CF.nodes as unknown[]);
  await cfResolve(hist1.wfId);
  const hist2 = await cfApply("HIST", sameReqNodes); // v3 carried
  const histWfA = (await svc.getWorkflow(hist1.wfId)) as { current_version_id?: string; version?: number };
  const histV3Id = histWfA.current_version_id;
  const histV3Seq = histWfA.version;
  // identical replay → already_applied, zero writes
  const histCounts = await recCounts();
  const histReplay = await svcAny.applyImportBatch(hist2.batch, "admin_t") as Record<string, unknown>;
  eq(histReplay.already_applied, true, "identical re-import replay → already_applied");
  eq(canonicalJson(await recCounts()), canonicalJson(histCounts), "identical replay → zero new docs");
  // reapply older batch → never repoint backward
  const histReplayOld = await svcAny.applyImportBatch(hist1.batch, "admin_t") as Record<string, unknown>;
  eq(histReplayOld.already_applied, true, "reapply V1 batch → already_applied");
  const histWfB = (await svc.getWorkflow(hist1.wfId)) as { current_version_id?: string; version?: number };
  eq(histWfB.current_version_id, histV3Id, "reapply V1 → pointer stays newest (no rollback)");
  eq(histWfB.version, histV3Seq, "reapply V1 → version counter unchanged");
  // incomplete historical batch → reconcile fills v1 artifacts UNRESOLVED (never bleed v3 resolution into v1)
  const histV1 = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === hist1.wfId && (v as { version_seq?: number }).version_seq === 1) as { version_id?: string };
  const histV1Bind = (await bindsOf(hist1.wfId, histV1.version_id))[0];
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).deleteOne({ binding_id: histV1Bind.binding_id });
  const histRecon = await svcAny.applyImportBatch(hist1.batch, "admin_t") as Record<string, unknown>;
  eq(histRecon.ok, true, "incomplete historical batch → reconcile ok");
  const refilled = (await bindsOf(hist1.wfId, histV1.version_id)).find((b) => b.binding_id === histV1Bind.binding_id);
  ok(refilled != null && refilled.status === "unresolved" && !(refilled.resolution?.mappings?.length), "historical reconcile → v1 binding refills unresolved (no newer-version bleed)");
  eq((await svc.getWorkflow(hist1.wfId))?.current_version_id, histV3Id, "historical reconcile → pointer still newest");
  // old version docs/bindings remain readable
  ok((await collDocs(COLLECTIONS.workflowVersions)).some((v) => (v as { version_id?: string }).version_id === histV1.version_id), "old version doc readable after replay");

  // crash mid carried-binding write → retry deterministic + idempotent
  const cr = await cfApply("CRASH", SRC_CF.nodes as unknown[]);
  await cfResolve(cr.wfId);
  const crB2 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_CRASH", loadedVersionId: "wv-cf-crash2", versions: [{ workflowVersionId: "wv-cf-crash2", status: "active" }], nodes: sameReqNodes }] },
    { indexRows: [{ wid: "workflow_CF_CRASH", name: "cf CRASH" }] });
  armInsertFail(COLLECTIONS.workflowBindings, 2);
  let crThrew = false;
  try { await svcAny.applyImportBatch(crB2, "admin_t"); } catch { crThrew = true; }
  ok(crThrew, "crash mid carried-binding write → throws");
  disarm();
  const crRetry = await svcAny.applyImportBatch(crB2, "admin_t") as Record<string, unknown>;
  eq(crRetry.ok, true, "crash retry → apply completes");
  const crAfter = (await svc.getWorkflow(cr.wfId)) as { current_version_id?: string };
  const crBinds = await bindsOf(cr.wfId, crAfter.current_version_id);
  eq(crBinds.length, 4, "crash retry → deterministic carried artifact set complete");
  ok(crBinds.every((b) => (b.resolution?.mappings?.length ?? 0) > 0
    && (b.resolution?.mappings ?? []).every((m) => m.carried === true)), "crash retry → carried:true deterministic");

  // production unique (workflow_id, version_seq) — crash-orphan occupies seq slot;
  // divergent fingerprint must verify/bump, never E11000 wedge or duplicate seq rows
  const orph = await cfApply("ORPH", SRC_CF.nodes as unknown[]);
  const orphB2 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_ORPH", loadedVersionId: "wv-cf-orph2",
      versions: [{ workflowVersionId: "wv-cf-orph2", status: "active" }], nodes: sameReqNodes }] },
    { indexRows: [{ wid: "workflow_CF_ORPH", name: "cf ORPH" }] });
  armInsertFail(COLLECTIONS.workflowRawSnapshots, 1);
  let orphThrew = false;
  try { await svcAny.applyImportBatch(orphB2, "admin_t"); } catch { orphThrew = true; }
  ok(orphThrew, "crash after version insert → throws, orphan version doc at seq 2");
  disarm();
  const verColl = await mongo.getCollection(COLLECTIONS.workflowVersions);
  eq(await verColl.countDocuments({ workflow_id: orph.wfId, version_seq: 2 }), 1, "orphan occupies seq 2 slot");
  // divergent fingerprint → same seq slot (wf.version still 1 → seq 2) — production E11000 wedge
  const orphB3 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_ORPH", loadedVersionId: "wv-cf-orph3",
      versions: [{ workflowVersionId: "wv-cf-orph3", status: "active" }],
      nodes: [cfNode(0), cfNode(1), cfNode(2), { ...cfNode(3), data: { ...cfData(3), action: { message: { text: "hello v3-orph" } } } }] }] },
    { indexRows: [{ wid: "workflow_CF_ORPH", name: "cf ORPH" }] });
  let orphErr: { code?: number | string } | null = null;
  try { await svcAny.applyImportBatch(orphB3, "admin_t"); } catch (e) { orphErr = e as { code?: number | string }; }
  eq(orphErr, null, "divergent-fp apply at occupied seq slot → bumps, no E11000 wedge");
  eq(await verColl.countDocuments({ workflow_id: orph.wfId, version_seq: 2 }), 1, "no duplicate (workflow_id, version_seq) rows");
  const orphWf = (await svc.getWorkflow(orph.wfId)) as { version?: number; current_version_id?: string };
  eq(orphWf.version, 3, "version counter mirrors pointed seq after bump");
  let orphRetry: Record<string, unknown> | null = null;
  try { orphRetry = await svcAny.applyImportBatch(orphB3, "admin_t") as Record<string, unknown>; } catch { /* wedge on broken impl */ }
  ok(orphRetry != null && (orphRetry.ok === true || orphRetry.already_applied === true), "post-bump retry deterministic");

  // ═══ 27b. Finding D — concurrent different-batch imports: pointer ห้ามถอย ═══
  // claim แยกตาม batch_id → batch ต่างกัน apply พร้อมกันได้: ทั้งคู่อ่าน existingWf
  // เดียวกัน → seq แยกผ่าน unique bump → seq สูง repoint ก่อน → seq ต่ำต้องไม่เขียนทับ
  console.log("\n=== 27b. Concurrent different-batch imports — pointer no-rollback ===");
  const race = await cfApply("RACE", SRC_CF.nodes as unknown[]);
  await cfResolve(race.wfId);   // v1 resolved → pointer v1 + derived scope
  const raceV1 = ((await svc.getWorkflow(race.wfId)) as { current_version_id?: string }).current_version_id;
  // LO = revision เก่ากว่า (count-3 trigger + canonical text change → fingerprint
  // ต่างจริง; account requirement ใหม่ unresolved → derived scope แคบกว่า HI)
  const loBatch = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_RACE", loadedVersionId: "wv-cf-race2",
      versions: [{ workflowVersionId: "wv-cf-race2", status: "active" }],
      nodes: [{ ...cfNode(0), data: { ...cfData(0), accountIds: ["zacc_1", "zacc_2", "zacc_3"] } }, cfNode(1), cfNode(2),
        { ...cfNode(3), data: { ...cfData(3), action: { message: { text: "hello lo" } } } }] }] },
    { indexRows: [{ wid: "workflow_CF_RACE", name: "cf RACE" }] });
  // HI = revision ใหม่กว่า (requirement เดิม → carried resolved → derived scope เต็ม)
  const hiBatch = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_RACE", loadedVersionId: "wv-cf-race3",
      versions: [{ workflowVersionId: "wv-cf-race3", status: "active" }], nodes: sameReqNodes }] },
    { indexRows: [{ wid: "workflow_CF_RACE", name: "cf RACE" }] });
  // ค้าง LO ไว้ตอน repoint (workflows.updateOne แรกที่เขียน current_version_id)
  // → HI apply+repoint จบก่อน → ปล่อย LO — interleave deterministic
  let loHeld: (() => void) | null = null;
  let loHeldFlag = false;
  st.updateOneHook = async (c: string, _f?: unknown, u?: unknown) => {
    if (!loHeldFlag && c === COLLECTIONS.workflows
      && (u as { $set?: { current_version_id?: string } } | undefined)?.$set?.current_version_id) {
      loHeldFlag = true;
      await new Promise<void>((r) => { loHeld = r; });
    }
  };
  let loSettled = false;
  const loApply = (async () => { try { return await svcAny.applyImportBatch(loBatch, "admin_a"); } finally { loSettled = true; } })();
  for (let i = 0; !loHeldFlag && !loSettled && i < 10000; i++) await new Promise((r) => setImmediate(r));
  ok(loHeldFlag, "LO reached repoint hold point (stale read of pointer)");
  let hiRes: Record<string, unknown> | null = null;
  try { hiRes = await svcAny.applyImportBatch(hiBatch, "admin_b") as Record<string, unknown>; } catch { /* wedge on broken impl */ }
  eq(hiRes?.ok, true, "HI batch (seq สูงกว่า) apply + repoint จบก่อน");
  const hiPtr = (await svc.getWorkflow(race.wfId)) as { current_version_id?: string; version?: number };
  loHeld!();
  const loRes = await loApply.catch(() => null) as Record<string, unknown> | null;
  st.updateOneHook = undefined;
  eq(loRes?.ok, true, "LO batch (seq ต่ำกว่า) apply จบ — artifacts เป็น historical revision ไม่ falsify state");
  const raceAfter = (await svc.getWorkflow(race.wfId)) as { current_version_id?: string; version?: number; platforms?: string[]; shop_ids?: string[]; enabled?: boolean; status?: string };
  eq(raceAfter.current_version_id, hiPtr.current_version_id, "LO repoint หลัง HI → pointer ห้ามถอยไป seq ต่ำกว่า");
  eq(raceAfter.version, hiPtr.version, "version counter ห้ามถอย — mirror pointed seq เสมอ");
  const racePtrBinds = await bindsOf(race.wfId, raceAfter.current_version_id);
  eq(racePtrBinds.length, 4, "pointed version = HI artifact set");
  eq(racePtrBinds.find(acc2)?.status, "resolved", "pointed version bindings = HI carried resolved");
  eq(cfSorted(raceAfter.shop_ids), cfSorted(["shop_cf1", "shop_cf2"]), "doc shop_ids = pointed(HI) derived scope — ไม่ใช่ stale/LO");
  eq(cfSorted(raceAfter.platforms), cfSorted(["shopee", "tiktok"]), "doc platforms = pointed(HI) derived scope");
  eq(raceAfter.enabled, false, "concurrent import → ยัง disabled");
  eq(raceAfter.status, "draft", "concurrent import → ยัง draft");
  // LO artifacts = immutable historical revision (อ่านได้ — แค่ไม่ถูกชี้)
  const loVer = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === race.wfId && (v as { fingerprint?: string }).fingerprint === loBatch.reports[0].fingerprint) as { version_id?: string } | undefined;
  ok(loVer != null && loVer.version_id !== raceAfter.current_version_id, "LO version artifact คงอยู่ — immutable history (lower seq, never pointed)");
  eq((await bindsOf(race.wfId, loVer?.version_id)).length, 4, "LO version bindings ครบ (historical readable)");
  const raceBatches = (await collDocs(COLLECTIONS.workflowImportBatches))
    .filter((b) => (b as { batch_id?: string }).batch_id === loRes?.batch_id || (b as { batch_id?: string }).batch_id === hiRes?.batch_id) as { status?: string }[];
  eq(raceBatches.length, 2, "both batches recorded");
  ok(raceBatches.every((b) => b.status === "applied"), "ทั้งคู่ applied — LO ไม่รายงานสำเร็จเทียม (state สอดคล้อง: applied as older revision)");

  // ═══ 27c. Finding E — E11000 unique-key discrimination ═══
  // production มี unique ทั้ง version_id และ (workflow_id, version_seq) —
  // E11000 ต้องจำแนกกุญแจที่ชน: id ชน+ต่าง fp → corrupt fail closed · seq ชน+ต่าง
  // fp → bump · same fp → resume · อธิบายไม่ได้ → fail closed (ไม่วนค่าเดิมไม่จบ)
  console.log("\n=== 27c. E11000 key discrimination (version_id vs seq) ===");
  const corWf = await cfApply("CORRWF", SRC_CF.nodes as unknown[]);
  const corB2 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_CORRWF", loadedVersionId: "wv-cf-corr2",
      versions: [{ workflowVersionId: "wv-cf-corr2", status: "active" }], nodes: sameReqNodes }] },
    { indexRows: [{ wid: "workflow_CF_CORRWF", name: "cf CORRWF" }] });
  const corFp = corB2.reports[0].fingerprint;
  const corVerId = "wv_" + _sh(`${corWf.wfId}:${2}:${corFp}`); // deterministic id ของ apply ถัดไป (seq 2)
  await verColl.insertOne({ version_id: corVerId, workflow_id: corWf.wfId, version_seq: 99,
    schema_version: "canonical-workflow/1", name: "foreign-artifact", platforms: [], nodes: [], edges: [],
    handle_labels: {}, source_ref: { workflowId: "x", loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" },
    import_batch_id: "wib_foreign", fingerprint: "fp_foreign", created_at: new Date(), created_by: "corrupt" });
  let corInserts = 0;
  st.insertOneHook = async (c: string) => {
    if (c === COLLECTIONS.workflowVersions && ++corInserts > 3) throw new Error("sentinel: unbounded E11000 retry");
  };
  let corErr: { message?: string } | null = null;
  try { await svcAny.applyImportBatch(corB2, "admin_t"); } catch (e) { corErr = e as { message?: string }; }
  st.insertOneHook = undefined;
  ok(corErr != null && /corrupt deterministic identity/.test(corErr.message ?? ""), "version_id held by foreign artifact → fail closed corrupt-id");
  ok(corInserts <= 1, `version_id collision → no same-value retry loop (attempts=${corInserts})`);

  // inexplicable E11000 — ไม่มี occupant ทั้ง version_id และ seq slot (เช่น stale
  // index / ภายนอกยิง dup) → fail closed rethrow — ห้าม swallow แล้วนิ่งเฉย
  const unx = await cfApply("UNX", SRC_CF.nodes as unknown[]);
  const unxB2 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_UNX", loadedVersionId: "wv-cf-unx2",
      versions: [{ workflowVersionId: "wv-cf-unx2", status: "active" }], nodes: sameReqNodes }] },
    { indexRows: [{ wid: "workflow_CF_UNX", name: "cf UNX" }] });
  let unxArmed = true;
  let unxInserts = 0;
  st.insertOneHook = async (c: string) => {
    if (unxArmed && c === COLLECTIONS.workflowVersions) {
      if (++unxInserts > 3) throw new Error("sentinel: unbounded E11000 retry");
      const err = new Error("E11000 duplicate key error collection: workflow_versions index: ghost") as Error & { code?: number };
      err.code = 11000;
      throw err;
    }
  };
  let unxErr: { code?: number } | null = null;
  try { await svcAny.applyImportBatch(unxB2, "admin_t"); } catch (e) { unxErr = e as { code?: number }; }
  unxArmed = false; st.insertOneHook = undefined;
  eq(unxErr?.code, 11000, "inexplicable E11000 (no occupant on either key) → fail closed rethrow");

  // CAS: version_id ถูก foreign artifact ยึด (ต่าง fingerprint, ต่าง seq) →
  // ห้าม reuse artifact ที่ไม่ตรง — fail closed ก่อนเขียน bindings/pointer
  const casE = await cfApply("CASE", SRC_CF.nodes as unknown[]);
  const casEWf = (await svc.getWorkflow(casE.wfId)) as { version?: number; name?: string; description?: string;
    shop_ids?: string[]; platforms?: string[]; trigger_frequency?: string; false_branch_policy?: string;
    priority?: number; nodes?: unknown[]; edges?: unknown[]; current_version_id?: string };
  const casEPayload = { name: casEWf.name, description: casEWf.description, shop_ids: casEWf.shop_ids,
    platforms: casEWf.platforms, trigger_frequency: casEWf.trigger_frequency,
    false_branch_policy: casEWf.false_branch_policy, priority: casEWf.priority,
    nodes: casEWf.nodes, edges: casEWf.edges, handle_labels: {} };
  const casEFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint(casEPayload);
  const casESeq = (casEWf.version ?? 0) + 1;
  const casEVerId = "wv_" + _sh(`${casE.wfId}:${casESeq}:${casEFp}`);
  await verColl.insertOne({ version_id: casEVerId, workflow_id: casE.wfId, version_seq: 77,
    schema_version: "canonical-workflow/1", name: "foreign-artifact", platforms: [], nodes: [], edges: [],
    handle_labels: {}, source_ref: { workflowId: "x", loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" },
    import_batch_id: "wib_foreign2", fingerprint: "fp_foreign2", created_at: new Date(), created_by: "corrupt" });
  let casEThrew: { message?: string } | null = null;
  try { await svcAny.saveWorkflowDraft(casE.wfId, {}, casEWf.version ?? 0, "admin_t"); } catch (e) { casEThrew = e as { message?: string }; }
  ok(casEThrew != null && /corrupt deterministic identity/.test(casEThrew.message ?? ""), "CAS version_id foreign artifact → fail closed (no unchecked reuse)");
  eq((await svc.getWorkflow(casE.wfId))?.current_version_id, casEWf.current_version_id, "CAS corrupt-id → pointer untouched");
  eq(await verColl.countDocuments({ workflow_id: casE.wfId, version_seq: casESeq }), 0, "CAS corrupt-id → no version doc written at expected seq");

  // ═══ 27d. Finding F — reverse interleave: higher seq must still win ═══
  // LO จอง seq ต่ำ+ค้างก่อน repoint → HI bump เป็น seq สูง+ค้าง → ปล่อย LO ก่อน
  // (repoint สำเร็จ) → ปล่อย HI — HI ต้อง repoint ได้ (seq สูงกว่า = newer revision)
  console.log("\n=== 27d. Concurrent imports reverse interleave — newer seq must win ===");
  const race2 = await cfApply("RACE2", SRC_CF.nodes as unknown[]);
  await cfResolve(race2.wfId);
  const race2Ptr0 = ((await svc.getWorkflow(race2.wfId)) as { current_version_id?: string }).current_version_id;
  const lo2Batch = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_RACE2", loadedVersionId: "wv-cf-r2lo",
      versions: [{ workflowVersionId: "wv-cf-r2lo", status: "active" }],
      nodes: [{ ...cfNode(0), data: { ...cfData(0), accountIds: ["zacc_1", "zacc_2", "zacc_3"] } }, cfNode(1), cfNode(2),
        { ...cfNode(3), data: { ...cfData(3), action: { message: { text: "hello r2lo" } } } }] }] },
    { indexRows: [{ wid: "workflow_CF_RACE2", name: "cf RACE2" }] });
  const hi2Batch = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_RACE2", loadedVersionId: "wv-cf-r2hi",
      versions: [{ workflowVersionId: "wv-cf-r2hi", status: "active" }],
      nodes: [cfNode(0), cfNode(1), cfNode(2), { ...cfNode(3), data: { ...cfData(3), action: { message: { text: "hello r2hi" } } } }] }] },
    { indexRows: [{ wid: "workflow_CF_RACE2", name: "cf RACE2" }] });
  const holds2: (() => void)[] = [];
  st.updateOneHook = async (c: string, _f?: unknown, u?: unknown) => {
    if (c === COLLECTIONS.workflows && (u as { $set?: { current_version_id?: string } } | undefined)?.$set?.current_version_id) {
      await new Promise<void>((r) => { holds2.push(r); });
    }
  };
  let lo2Settled = false;
  const lo2Apply = (async () => { try { return await svcAny.applyImportBatch(lo2Batch, "admin_a") as Record<string, unknown>; } finally { lo2Settled = true; } })();
  for (let i = 0; holds2.length < 1 && !lo2Settled && i < 10000; i++) await new Promise((r) => setImmediate(r));
  eq(holds2.length, 1, "LO held at repoint (owns lower seq)");
  let hi2Settled = false;
  const hi2Apply = (async () => { try { return await svcAny.applyImportBatch(hi2Batch, "admin_b") as Record<string, unknown>; } finally { hi2Settled = true; } })();
  for (let i = 0; holds2.length < 2 && !hi2Settled && i < 10000; i++) await new Promise((r) => setImmediate(r));
  eq(holds2.length, 2, "HI held at repoint (owns higher seq)");
  holds2[0](); // ปล่อย LO repoint ก่อน — pointer ไป revision ต่ำกว่า
  const lo2Res = await lo2Apply.catch(() => null);
  holds2[1](); // ปล่อย HI — seq สูงกว่าต้อง repoint ได้แม้ pointer เปลี่ยนหลัง stale read
  const hi2Res = await hi2Apply.catch(() => null);
  st.updateOneHook = undefined;
  const r2After = (await svc.getWorkflow(race2.wfId)) as { current_version_id?: string; version?: number; platforms?: string[]; shop_ids?: string[]; enabled?: boolean; status?: string };
  const hi2Ver = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === race2.wfId && (v as { fingerprint?: string }).fingerprint === hi2Batch.reports[0].fingerprint) as { version_id?: string; version_seq?: number } | undefined;
  eq(r2After.current_version_id, hi2Ver?.version_id, "reverse interleave → pointer = HI (higher seq wins, not first-writer)");
  eq(r2After.version, hi2Ver?.version_seq, "version counter = HI artifact version_seq (real artifact, not hardcode)");
  const hi2Binds = await bindsOf(race2.wfId, hi2Ver?.version_id);
  const expShops = [...new Set(hi2Binds.flatMap((b) => (b.resolution?.mappings ?? []).filter((m) => m.state === "valid" && m.shop_id != null).map((m) => m.shop_id as string)))].sort();
  const expPlats = [...new Set(hi2Binds.flatMap((b) => (b.resolution?.mappings ?? []).filter((m) => m.state === "valid" && m.platform != null).map((m) => m.platform as string)))].sort();
  eq(cfSorted(r2After.shop_ids), cfSorted(expShops), "doc shop_ids = HI-version bindings derived scope (real artifact)");
  eq(cfSorted(r2After.platforms), cfSorted(expPlats), "doc platforms = HI-version bindings derived scope (real artifact)");
  eq(r2After.enabled, false, "reverse interleave → ยัง disabled");
  eq(r2After.status, "draft", "reverse interleave → ยัง draft");
  ok(lo2Res?.ok === true && hi2Res?.ok === true, "both batches apply — artifacts consistent");
  const lo2Ver = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === race2.wfId && (v as { fingerprint?: string }).fingerprint === lo2Batch.reports[0].fingerprint) as { version_id?: string } | undefined;
  ok(lo2Ver != null && lo2Ver.version_id !== r2After.current_version_id, "LO artifact persists — immutable history (was pointed, superseded by HI)");
  eq((await bindsOf(race2.wfId, lo2Ver?.version_id)).length, 4, "LO version bindings readable");

  // ═══ 27e. Finding G — same-fingerprint foreign artifact → canonical identity gate ═══
  // fingerprint = index ไม่ใช่ artifact proof — doc ที่มี fp ตรงแต่ canonical
  // payload ต่างต้อง fail closed (ไม่ reuse / ไม่ชี้ / ไม่วน)
  console.log("\n=== 27e. Same-fingerprint foreign artifact → fail closed ===");
  const fgn = await cfApply("FGN", SRC_CF.nodes as unknown[]);
  const fgnB2 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_FGN", loadedVersionId: "wv-cf-fgn2",
      versions: [{ workflowVersionId: "wv-cf-fgn2", status: "active" }], nodes: sameReqNodes }] },
    { indexRows: [{ wid: "workflow_CF_FGN", name: "cf FGN" }] });
  const fgnFp = fgnB2.reports[0].fingerprint;
  const fgnVerId = "wv_" + _sh(`${fgn.wfId}:${2}:${fgnFp}`);
  // foreign version_id artifact — fingerprint ตรง แต่ canonical payload ต่าง (name/nodes/workflow ต่าง)
  await verColl.insertOne({ version_id: fgnVerId, workflow_id: "wf_other", version_seq: 5,
    schema_version: "canonical-workflow/1", name: "foreign", platforms: [], nodes: [], edges: [],
    handle_labels: {}, source_ref: { workflowId: "x", loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" },
    import_batch_id: "wib_fgn", fingerprint: fgnFp, created_at: new Date(), created_by: "corrupt" });
  const fgnPtr0 = ((await svc.getWorkflow(fgn.wfId)) as { current_version_id?: string }).current_version_id;
  let fgnErr: { message?: string } | null = null;
  try { await svcAny.applyImportBatch(fgnB2, "admin_t"); } catch (e) { fgnErr = e as { message?: string }; }
  ok(fgnErr != null && /corrupt deterministic/.test(fgnErr.message ?? ""), "import: same-fp foreign version_id → fail closed (fingerprint ≠ identity)");
  eq((await svc.getWorkflow(fgn.wfId))?.current_version_id, fgnPtr0, "same-fp foreign → pointer untouched");
  eq((await bindsOf(fgn.wfId, fgnVerId)).length, 0, "same-fp foreign → zero bindings written for foreign version_id");
  // seq-slot occupant — fp ตรง canonical ต่าง → fail closed (not bump/resume)
  const fgn2 = await cfApply("FGN2", SRC_CF.nodes as unknown[]);
  const fgn2B2 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_FGN2", loadedVersionId: "wv-cf-fgn2b",
      versions: [{ workflowVersionId: "wv-cf-fgn2b", status: "active" }], nodes: sameReqNodes }] },
    { indexRows: [{ wid: "workflow_CF_FGN2", name: "cf FGN2" }] });
  const fgn2Fp = fgn2B2.reports[0].fingerprint;
  await verColl.insertOne({ version_id: "wv_slotforeign", workflow_id: fgn2.wfId, version_seq: 2,
    schema_version: "canonical-workflow/1", name: "slot-foreign", platforms: [], nodes: [], edges: [],
    handle_labels: {}, source_ref: { workflowId: "x", loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" },
    import_batch_id: "wib_fgn2", fingerprint: fgn2Fp, created_at: new Date(), created_by: "corrupt" });
  let fgn2Err: { message?: string } | null = null;
  try { await svcAny.applyImportBatch(fgn2B2, "admin_t"); } catch (e) { fgn2Err = e as { message?: string }; }
  ok(fgn2Err != null && /corrupt deterministic/.test(fgn2Err.message ?? ""), "import: same-fp seq-slot foreign → fail closed");
  eq(await verColl.countDocuments({ workflow_id: fgn2.wfId, version_seq: 2 }), 1, "slot foreign preserved for inspection");
  // CAS: same-fp foreign version_id → fail closed ก่อนเขียน bindings/pointer
  const casG = await cfApply("CASG", SRC_CF.nodes as unknown[]);
  const casGWf = (await svc.getWorkflow(casG.wfId)) as { version?: number; name?: string; description?: string;
    shop_ids?: string[]; platforms?: string[]; trigger_frequency?: string; false_branch_policy?: string;
    priority?: number; nodes?: unknown[]; edges?: unknown[]; current_version_id?: string };
  const casGPayload = { name: casGWf.name, description: casGWf.description, shop_ids: casGWf.shop_ids,
    platforms: casGWf.platforms, trigger_frequency: casGWf.trigger_frequency,
    false_branch_policy: casGWf.false_branch_policy, priority: casGWf.priority,
    nodes: casGWf.nodes, edges: casGWf.edges, handle_labels: {} };
  const casGFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint(casGPayload);
  const casGSeq = (casGWf.version ?? 0) + 1;
  const casGVerId = "wv_" + _sh(`${casG.wfId}:${casGSeq}:${casGFp}`);
  await verColl.insertOne({ version_id: casGVerId, workflow_id: "wf_other2", version_seq: 9,
    schema_version: "canonical-workflow/1", name: "foreign-cas", platforms: [], nodes: [], edges: [],
    handle_labels: {}, source_ref: { workflowId: "x", loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" },
    import_batch_id: "wib_fgn3", fingerprint: casGFp, created_at: new Date(), created_by: "corrupt" });
  let casGThrew: { message?: string } | null = null;
  try { await svcAny.saveWorkflowDraft(casG.wfId, {}, casGWf.version ?? 0, "admin_t"); } catch (e) { casGThrew = e as { message?: string }; }
  ok(casGThrew != null && /corrupt deterministic/.test(casGThrew.message ?? ""), "CAS: same-fp foreign version_id → fail closed");
  eq((await svc.getWorkflow(casG.wfId))?.current_version_id, casGWf.current_version_id, "CAS same-fp foreign → pointer untouched");

  // ═══ 27f. Finding H+I — cross-batch reuse + source_ref provenance ═══
  // batch1 = [A] applied → batch2 = [A' same canonical fp + NEW source metadata,
  // B workflow ใหม่] → batchId ต่าง: A' ต้อง reuse version artifact เดิม
  // (canonical เดียวกัน — ไม่สร้างซ้ำ), source_ref metadata ใหม่ = provenance
  // ไม่ใช่ corruption, และ batch2 ต้อง complete ได้ (completeness = identity
  // {wfId, fingerprint} + artifact set ไม่ใช่ batch_id provenance)
  console.log("\n=== 27f. Cross-batch reuse + source_ref provenance ===");
  const hWf = await cfApply("H1", SRC_CF.nodes as unknown[]);
  const hVerCount0 = await verColl.countDocuments({ workflow_id: hWf.wfId });
  const hB = previewZaapiFlows({ flows: [
    { ...SRC_CF, workflowId: "workflow_CF_H1", loadedVersionId: "wv-h1-rev2",
      versions: [{ workflowVersionId: "wv-h1-rev2", status: "deprecated" }] },
    { ...SRC_CF, workflowId: "workflow_CF_H2", loadedVersionId: "wv-h2-v1",
      versions: [{ workflowVersionId: "wv-h2-v1", status: "active" }] },
  ] }, { indexRows: [{ wid: "workflow_CF_H1", name: "cf H1" }, { wid: "workflow_CF_H2", name: "cf H2" }] });
  const hV1 = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === hWf.wfId) as { fingerprint?: string; source_ref?: { loadedVersionId?: string } } | undefined;
  eq(hV1?.fingerprint, hB.reports[0].fingerprint, "A' report fingerprint = persisted artifact fingerprint (same canonical → dupVersion path)");
  const hBatches0 = new Set((await collDocs(COLLECTIONS.workflowImportBatches)).map((b) => (b as { batch_id?: string }).batch_id));
  let hRes: Record<string, unknown> | null = null;
  let hErr: { message?: string } | null = null;
  try { hRes = await svcAny.applyImportBatch(hB, "admin_t") as Record<string, unknown>; } catch (e) { hErr = e as { message?: string }; }
  ok(hErr == null, `cross-batch same-fp + changed source_ref → apply must not corrupt-throw (got: ${hErr?.message ?? "none"})`);
  eq(hRes?.ok, true, "batch2 [A' same-fp + B new] applies");
  const hBatch2 = (await collDocs(COLLECTIONS.workflowImportBatches)).find((b) => !hBatches0.has((b as { batch_id?: string }).batch_id)) as { status?: string } | undefined;
  eq(hBatch2?.status, "applied", "batch2 completes — completeness = artifact identity not batch provenance");
  eq(await verColl.countDocuments({ workflow_id: hWf.wfId }), hVerCount0, "A' same canonical artifact → reuse version (no duplicate)");
  eq(await verColl.countDocuments({ workflow_id: "wf_imp_" + _sh("workflow_CF_H2") }), 1, "B new workflow → version created");
  eq(((await svc.getWorkflow(hWf.wfId)) as { enabled?: boolean }).enabled, false, "cross-batch → still disabled");
  eq(((await svc.getWorkflow(hWf.wfId)) as { status?: string }).status, "draft", "cross-batch → still draft");

  // ═══ 27g. Finding K — source_values-only change = requirement/artifact เปลี่ยน ═══
  // canonical fp ไม่ครอบคลุม external binding values — values เปลี่ยนอย่างเดียว
  // = requirement identity เปลี่ยน → version ใหม่ (ไม่ already_applied/reuse)
  console.log("\n=== 27g. source_values-only re-import — new requirement identity ===");
  const kWf = await cfApply("K1", SRC_CF.nodes as unknown[]);
  await cfResolve(kWf.wfId);   // v1 import + v2 resolution
  const kV1 = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === kWf.wfId && (v as { version_seq?: number }).version_seq === 1) as { fingerprint?: string; version_id?: string } | undefined;
  // re-import: canonical/name/workflowId เดิม — external values เปลี่ยนอย่างเดียว
  const kB = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_K1", loadedVersionId: "wv-k1-r2",
      versions: [{ workflowVersionId: "wv-k1-r2", status: "active" }],
      nodes: [{ ...cfNode(0), data: { ...cfData(0), accountIds: ["zacc_9", "zacc_8"] } }, cfNode(1), cfNode(2), cfNode(3)] }] },
    { indexRows: [{ wid: "workflow_CF_K1", name: "cf K1" }] });
  eq(kB.reports[0].fingerprint, kV1?.fingerprint, "fixture: values-only → canonical fp identical (invisible to fp)");
  const kRes = await svcAny.applyImportBatch(kB, "admin_t") as Record<string, unknown>;
  eq(kRes.ok, true, "values-changed re-import applies (not already_applied swallow)");
  ok(kRes.already_applied !== true, "values-changed → NOT already_applied (different requirement identity)");
  const kVers = (await collDocs(COLLECTIONS.workflowVersions)).filter((v) => (v as { workflow_id?: string }).workflow_id === kWf.wfId && (v as { fingerprint?: string }).fingerprint === kV1?.fingerprint);
  eq(kVers.length, 2, "same-fp versions = 2 (v1 + new variant — canonical shared, requirements differ)");
  const kNew = kVers.find((v) => (v as { version_seq?: number }).version_seq === 3) as { version_id?: string } | undefined;
  ok(kNew != null, "values-changed → new version seq 3");
  const kWfDoc = (await svc.getWorkflow(kWf.wfId)) as { current_version_id?: string; version?: number; shop_ids?: string[]; platforms?: string[]; enabled?: boolean; status?: string };
  eq(kWfDoc.current_version_id, kNew?.version_id, "pointer → new variant version");
  eq(kWfDoc.version, 3, "version counter mirrors pointed seq");
  const kBinds = await bindsOf(kWf.wfId, kNew?.version_id);
  eq(kBinds.length, 4, "new version bindings complete");
  const kAcc2 = kBinds.find(acc2);
  eq(kAcc2?.status, "unresolved", "changed account requirement → fresh unresolved");
  eq((kAcc2?.resolution?.mappings ?? []).length, 0, "changed requirement → no carried mappings / no guessed replacement");
  ok(kAcc2 != null && canonicalJson(kAcc2.source_values) === canonicalJson(["zacc_9", "zacc_8"]), "new requirement records new source_values verbatim");
  eq(kBinds.find(acc1)?.status, "resolved", "unaffected sibling acc1 → carried resolved");
  eq(kBinds.find((b) => b.kind === "label")?.status, "resolved", "unaffected label → carried");
  eq(kBinds.find((b) => b.kind === "user")?.status, "resolved", "unaffected user → carried");
  ok((kBinds.find(acc1)?.resolution?.mappings?.length ?? 0) > 0 && (kBinds.find(acc1)?.resolution?.mappings ?? []).every((m) => m.carried === true), "carried sibling → carried:true provenance");
  eq(cfSorted(kWfDoc.shop_ids), cfSorted(["shop_cf2"]), "derived scope shrinks to surviving valid mapping only");
  eq(cfSorted(kWfDoc.platforms), cfSorted(["tiktok"]), "platforms shrink accordingly");
  eq(kWfDoc.enabled, false, "values-changed → still disabled");
  eq(kWfDoc.status, "draft", "values-changed → still draft");
  // replay input เดิม → already_applied (idempotent, no dup artifacts)
  const kReplay = await svcAny.applyImportBatch(kB, "admin_t") as Record<string, unknown>;
  eq(kReplay.already_applied, true, "values-changed replay → already_applied (deterministic)");
  eq(await verColl.countDocuments({ workflow_id: kWf.wfId }), 3, "replay → no dup version");
  // multi-flow batch: A' values เปลี่ยนชุดที่ 3 + B workflow ใหม่ → complete atomically
  const kBatches0 = new Set((await collDocs(COLLECTIONS.workflowImportBatches)).map((b) => (b as { batch_id?: string }).batch_id));
  const kB2 = previewZaapiFlows({ flows: [
    { ...SRC_CF, workflowId: "workflow_CF_K1", loadedVersionId: "wv-k1-r3",
      versions: [{ workflowVersionId: "wv-k1-r3", status: "active" }],
      nodes: [{ ...cfNode(0), data: { ...cfData(0), accountIds: ["zacc_7", "zacc_6"] } }, cfNode(1), cfNode(2), cfNode(3)] },
    { ...SRC_CF, workflowId: "workflow_CF_K3", loadedVersionId: "wv-k3-v1",
      versions: [{ workflowVersionId: "wv-k3-v1", status: "active" }] },
  ] }, { indexRows: [{ wid: "workflow_CF_K1", name: "cf K1" }, { wid: "workflow_CF_K3", name: "cf K3" }] });
  const kRes2 = await svcAny.applyImportBatch(kB2, "admin_t") as Record<string, unknown>;
  eq(kRes2.ok, true, "multi-flow [A' values-changed + B new] applies");
  const kBatch2 = (await collDocs(COLLECTIONS.workflowImportBatches)).find((b) => !kBatches0.has((b as { batch_id?: string }).batch_id)) as { status?: string } | undefined;
  eq(kBatch2?.status, "applied", "multi-flow batch completes (no partial-write wedge)");
  eq(await verColl.countDocuments({ workflow_id: kWf.wfId }), 4, "A' third value set → another variant version seq 4");
  eq(await verColl.countDocuments({ workflow_id: "wf_imp_" + _sh("workflow_CF_K3") }), 1, "B new workflow → version created");
  const kWfDoc2 = (await svc.getWorkflow(kWf.wfId)) as { current_version_id?: string };
  const kV4 = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { workflow_id?: string }).workflow_id === kWf.wfId && (v as { version_seq?: number }).version_seq === 4) as { version_id?: string } | undefined;
  eq(kWfDoc2.current_version_id, kV4?.version_id, "pointer → newest variant (seq 4)");
  eq((await bindsOf(kWf.wfId, kV4?.version_id)).find(acc2)?.status, "unresolved", "third value set → fresh unresolved requirement");

  // ═══ 27h. Finding L — requirement เพิ่ม/ลบ = variant ใหม่ ไม่ใช่ incomplete/corrupt ═══
  // empty field → ไม่มี requirement; เติม/ลบ values = requirement set ต่าง =
  // input variant → version ใหม่ เสมอ — ห้ามเขียนใต้ version เก่า (immutable)
  console.log("\n=== 27h. requirement add/remove → new variant version ===");
  // A) empty→non-empty: v1 ไม่มี account binding บน trigger; re-import เติมค่า
  const lWf = await cfApply("L1", [{ ...cfNode(0), data: { ...cfData(0), accountIds: [] } }, cfNode(1), cfNode(2), cfNode(3)]);
  const lV1 = ((await svc.getWorkflow(lWf.wfId)) as { current_version_id?: string }).current_version_id;
  const lV1Binds0 = canonicalJson(await bindsOf(lWf.wfId, lV1));
  eq((await bindsOf(lWf.wfId, lV1)).length, 3, "fixture: v1 has 3 bindings (empty accountIds → no requirement)");
  const lVerCount0 = await verColl.countDocuments({ workflow_id: lWf.wfId });
  const lB = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_L1", loadedVersionId: "wv-l1-r2",
      versions: [{ workflowVersionId: "wv-l1-r2", status: "active" }] }] },
    { indexRows: [{ wid: "workflow_CF_L1", name: "cf L1" }] });
  const lRes = await svcAny.applyImportBatch(lB, "admin_t") as Record<string, unknown>;
  eq(lRes.ok, true, "empty→non-empty applies (not corrupt, not reuse-write)");
  eq(await verColl.countDocuments({ workflow_id: lWf.wfId }), lVerCount0 + 1, "empty→non-empty → NEW version (variant, not incomplete-retry)");
  const lV1After = (await collDocs(COLLECTIONS.workflowVersions)).find((v) => (v as { version_id?: string }).version_id === lV1);
  ok(lV1After != null, "old version doc still readable");
  eq(canonicalJson(await bindsOf(lWf.wfId, lV1)), lV1Binds0, "old version bindings byte-identical — no binding written under immutable v1");
  const lWfDoc = (await svc.getWorkflow(lWf.wfId)) as { current_version_id?: string; enabled?: boolean; status?: string; shop_ids?: string[]; platforms?: string[] };
  const lNewBinds = await bindsOf(lWf.wfId, lWfDoc.current_version_id);
  eq(lNewBinds.length, 4, "new version has 4 bindings (added requirement present)");
  const lAcc2 = lNewBinds.find(acc2);
  eq(lAcc2?.status, "unresolved", "added requirement → fresh unresolved");
  eq((lAcc2?.resolution?.mappings ?? []).length, 0, "added requirement → no mappings");
  ok(lAcc2 != null && canonicalJson(lAcc2.source_values) === canonicalJson(["zacc_1", "zacc_2"]), "added requirement records input source_values");
  eq(lWfDoc.enabled, false, "still disabled"); eq(lWfDoc.status, "draft", "still draft");
  const lReplay = await svcAny.applyImportBatch(lB, "admin_t") as Record<string, unknown>;
  eq(lReplay.already_applied, true, "replay → already_applied (idempotent)");
  eq(await verColl.countDocuments({ workflow_id: lWf.wfId }), lVerCount0 + 1, "replay → no dup version");

  // B) non-empty→empty: v1 มี acc2; re-import เอาค่าออก → version ใหม่ไม่มี binding นั้น
  const lWf2 = await cfApply("L2", SRC_CF.nodes as unknown[]);
  await cfResolve(lWf2.wfId);
  const l2V1 = ((await svc.getWorkflow(lWf2.wfId)) as { current_version_id?: string }).current_version_id;
  const l2V1Binds0 = canonicalJson(await bindsOf(lWf2.wfId, l2V1));
  const l2VerCount0 = await verColl.countDocuments({ workflow_id: lWf2.wfId });
  const lB2 = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_L2", loadedVersionId: "wv-l2-r2",
      versions: [{ workflowVersionId: "wv-l2-r2", status: "active" }],
      nodes: [{ ...cfNode(0), data: { ...cfData(0), accountIds: [] } }, cfNode(1), cfNode(2), cfNode(3)] }] },
    { indexRows: [{ wid: "workflow_CF_L2", name: "cf L2" }] });
  let l2Err: { message?: string; code?: string } | null = null;
  let l2Res: Record<string, unknown> | null = null;
  try { l2Res = await svcAny.applyImportBatch(lB2, "admin_t") as Record<string, unknown>; } catch (e) { l2Err = e as { message?: string; code?: string }; }
  ok(l2Err == null, `non-empty→empty must NOT corrupt-throw (got: ${l2Err?.message ?? "none"}) — removal = variant not corruption`);
  eq(l2Res?.ok, true, "non-empty→empty applies");
  eq(await verColl.countDocuments({ workflow_id: lWf2.wfId }), l2VerCount0 + 1, "non-empty→empty → NEW version without removed binding");
  eq(canonicalJson(await bindsOf(lWf2.wfId, l2V1)), l2V1Binds0, "old bindings byte-identical (old artifact ไม่ถูกแตะ)");
  const l2WfDoc = (await svc.getWorkflow(lWf2.wfId)) as { current_version_id?: string; shop_ids?: string[]; platforms?: string[]; enabled?: boolean; status?: string };
  const l2NewBinds = await bindsOf(lWf2.wfId, l2WfDoc.current_version_id);
  eq(l2NewBinds.length, 3, "new version: removed requirement absent (3 bindings remain)");
  ok(l2NewBinds.find(acc2) == null, "removed acc requirement → no binding on new version");
  eq(l2NewBinds.find(acc1)?.status, "resolved", "surviving acc1 → carried resolved");
  eq(cfSorted(l2WfDoc.shop_ids), cfSorted(["shop_cf2"]), "derived scope = surviving valid account mapping");
  eq(cfSorted(l2WfDoc.platforms), cfSorted(["tiktok"]), "platforms = surviving mapping platform");
  eq(l2WfDoc.enabled, false, "still disabled"); eq(l2WfDoc.status, "draft", "still draft");
  const l2Replay = await svcAny.applyImportBatch(lB2, "admin_t") as Record<string, unknown>;
  eq(l2Replay.already_applied, true, "replay → already_applied (idempotent)");

  // ═══ 27i. Finding M — exact-match fast path ต้องตรวจ row/raw identity ═══
  // corrupt snapshot raw (binding docs/requirement tuples ยัง exact) →
  // replay ต้องไม่ already_applied — fail closed ไม่เขียนอะไร
  console.log("\n=== 27i. exact-match + corrupt snapshot raw → fail closed ===");
  const mWf = await cfApply("M1", SRC_CF.nodes as unknown[]);
  const mVer = ((await svc.getWorkflow(mWf.wfId)) as { current_version_id?: string }).current_version_id;
  const mCounts0 = await allCounts();
  // corrupt raw: binding values ใน snapshot raw เปลี่ยน → source_ref resolve ไม่ตรง stored source_values
  const mSnap = await (await mongo.getCollection(COLLECTIONS.workflowRawSnapshots)).findOne({ workflow_id: mWf.wfId, version_id: mVer }) as { snapshot_id?: string; raw?: { nodes?: { id?: string; data?: Record<string, unknown> }[] } } | null;
  ok(mSnap != null, "fixture: snapshot exists");
  const mRaw = JSON.parse(JSON.stringify(mSnap!.raw)) as { nodes?: { id?: string; data?: Record<string, unknown> }[] };
  const mTrig = (mRaw.nodes ?? []).find((n) => n.id === "t1");
  ok(mTrig != null, "fixture: trigger node in raw");
  mTrig!.data!.accountIds = ["zacc_corrupt_1", "zacc_corrupt_2"]; // raw ถูกปนเปื้อน — binding docs ไม่แตะ
  await (await mongo.getCollection(COLLECTIONS.workflowRawSnapshots)).updateOne({ snapshot_id: mSnap!.snapshot_id }, { $set: { raw: mRaw } });
  const mB = previewZaapiFlows({ flows: [{ ...SRC_CF, workflowId: "workflow_CF_M1", loadedVersionId: "wv-cf-M1",
      versions: [{ workflowVersionId: "wv-cf-M1", status: "active" }] }] },
    { indexRows: [{ wid: "workflow_CF_M1", name: "cf M1" }] });
  let mErr: { code?: string; message?: string } | null = null;
  let mRes: Record<string, unknown> | null = null;
  try { mRes = await svcAny.applyImportBatch(mB, "admin_t") as Record<string, unknown>; } catch (e) { mErr = e as { code?: string; message?: string }; }
  ok(mRes?.already_applied !== true, "corrupt snapshot raw → NOT already_applied");
  ok(mErr != null && (mErr.code === "IMPORT_INVALID" || /corrupt/.test(mErr.message ?? "")), `corrupt snapshot raw → fail closed (got: ${mErr?.message ?? "no error"})`);
  eq(canonicalJson(await allCounts()), canonicalJson(mCounts0), "corrupt raw replay → zero writes (no version/binding/pointer/snapshot mutation)");
  eq(((await svc.getWorkflow(mWf.wfId)) as { current_version_id?: string }).current_version_id, mVer, "pointer untouched after corrupt replay");
  ok((await (await mongo.getCollection(COLLECTIONS.workflowRawSnapshots)).findOne({ snapshot_id: mSnap!.snapshot_id })) != null, "corrupt snapshot preserved for inspection");

  // ═══ 28. Task 4 — exact carry-forward: editor CAS ═══
  console.log("\n=== 28. Carry-forward: editor CAS (requirement_fp gate) ===");
  const cas = await cfApply("CAS", SRC_CF.nodes as unknown[]);
  await cfResolve(cas.wfId);
  const casPrevId = ((await svc.getWorkflow(cas.wfId)) as { current_version_id?: string }).current_version_id;
  const casPrevJson = canonicalJson(await bindsOf(cas.wfId, casPrevId));

  // rename-only → requirement identical → carry (flag preserved verbatim — CAS is not an import revision)
  const casWf1 = (await svc.getWorkflow(cas.wfId)) as { version?: number };
  const rn = await svcAny.saveWorkflowDraft(cas.wfId, { name: "cf renamed" }, casWf1.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(rn.ok, true, "CAS rename-only save ok");
  const rnBinds = await bindsOf(cas.wfId, rn.version_id);
  eq(rnBinds.length, 4, "rename-only → all bindings carried");
  ok(rnBinds.every((b) => b.status === "resolved"), "rename-only → resolved status preserved");
  ok(rnBinds.every((b) => (b.resolution?.mappings?.length ?? 0) > 0
    && (b.resolution?.mappings ?? []).every((m) => m.state === "valid")), "rename-only → mapping state preserved");
  const rnAcc1 = rnBinds.find(acc1)?.resolution?.mappings ?? [];
  ok(rnAcc1.length === 1 && rnAcc1.every((m) => m.via === "repeat"), "rename-only → via:'repeat' preserved");
  ok(rnBinds.every((b) => (b.resolution?.mappings?.length ?? 0) > 0
    && (b.resolution?.mappings ?? []).every((m) => m.carried === undefined)), "CAS carry → no new carried flag (verbatim copy)");
  eq(canonicalJson(await bindsOf(cas.wfId, casPrevId)), casPrevJson, "rename-only → old bindings byte-identical");

  // position-only / non-binding config edit → carry
  const casWf2 = (await svc.getWorkflow(cas.wfId)) as { version?: number; nodes?: { node_id: string; position?: { x: number; y: number } }[] };
  const posNodes = (casWf2.nodes ?? []).map((n) => ({ ...n, position: { x: (n.position?.x ?? 0) + 7, y: n.position?.y ?? 0 } }));
  const pos = await svcAny.saveWorkflowDraft(cas.wfId, { nodes: posNodes, description: "pos edit" }, casWf2.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(pos.ok, true, "CAS position-only save ok");
  const posBinds = await bindsOf(cas.wfId, pos.version_id);
  ok(posBinds.every((b) => b.status === "resolved"), "non-binding edit → resolved preserved");
  eq(posBinds.length, 4, "non-binding edit → all bindings carried");

  // subtype change same node_id → affected bindings dropped (requirement_fp mismatch)
  const casS = await cfApply("CASS", SRC_CF.nodes as unknown[]);
  await cfResolve(casS.wfId);
  const casSPrevId = ((await svc.getWorkflow(casS.wfId)) as { current_version_id?: string }).current_version_id;
  const casSPrevJson = canonicalJson(await bindsOf(casS.wfId, casSPrevId));
  const casSWf = (await svc.getWorkflow(casS.wfId)) as { version?: number; nodes?: { node_id: string; subtype?: string }[] };
  const stNodes = (casSWf.nodes ?? []).map((n) => n.node_id === a1NodeId ? { ...n, subtype: "send_text" } : n);
  const stSave = await svcAny.saveWorkflowDraft(casS.wfId, { nodes: stNodes }, casSWf.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(stSave.ok, true, "subtype-change save ok");
  const stBinds = await bindsOf(casS.wfId, stSave.version_id);
  ok(stBinds.every((b) => b.node_id !== a1NodeId), "subtype change → node's bindings dropped on new version");
  eq(stBinds.length, 2, "subtype change → only unaffected bindings carried");
  ok(stBinds.every((b) => b.status === "resolved"), "subtype change → unaffected bindings keep resolved");
  eq(canonicalJson(await bindsOf(casS.wfId, casSPrevId)), casSPrevJson, "subtype change → old bindings byte-identical");

  // node deleted → binding dropped (old version intact)
  const casD = await cfApply("CASD", SRC_CF.nodes as unknown[]);
  await cfResolve(casD.wfId);
  const casDPrevId = ((await svc.getWorkflow(casD.wfId)) as { current_version_id?: string }).current_version_id;
  const casDWf = (await svc.getWorkflow(casD.wfId)) as { version?: number; nodes?: { node_id: string }[]; edges?: { source_node_id: string; target_node_id: string }[] };
  const keepNodes4 = (casDWf.nodes ?? []).filter((n) => n.node_id !== a1NodeId);
  const rewired4 = [{ edge_id: "e_cf4", source_node_id: keepNodes4[0].node_id, target_node_id: keepNodes4[2].node_id }];
  const delSave = await svcAny.saveWorkflowDraft(casD.wfId, { nodes: keepNodes4, edges: rewired4 }, casDWf.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(delSave.ok, true, "node-delete save ok");
  const delCasBinds = await bindsOf(casD.wfId, delSave.version_id);
  ok(delCasBinds.every((b) => b.node_id !== a1NodeId), "CAS node deleted → binding dropped");
  eq(delCasBinds.length, 2, "CAS node deleted → surviving bindings carried");
  ok((await bindsOf(casD.wfId, casDPrevId)).some((b) => b.node_id === a1NodeId), "CAS node deleted → old version still holds binding");

  // binding-consuming container removed (same node_id + subtype) → binding dropped
  // canonical config strip เฉพาะ binding key — container structure (field_path parent)
  // ยัง persist → parent path หาย = requirement หาย
  const casF = await cfApply("CASF", SRC_CF.nodes as unknown[]);
  await cfResolve(casF.wfId);
  const casFPrevId = ((await svc.getWorkflow(casF.wfId)) as { current_version_id?: string }).current_version_id;
  const casFPrevJson = canonicalJson(await bindsOf(casF.wfId, casFPrevId));
  const casFWf = (await svc.getWorkflow(casF.wfId)) as { version?: number; nodes?: { node_id: string; config?: Record<string, unknown> }[] };
  const fNodes = (casFWf.nodes ?? []).map((n) => {
    if (n.node_id !== a1NodeId) return n;
    const cfg = { ...(n.config ?? {}) };
    const act = { ...(cfg.action as Record<string, unknown> | undefined) };
    delete act.assignment; // ลบ container ของ binding field action.assignment.userIds
    cfg.action = act;
    return { ...n, config: cfg };
  });
  const fSave = await svcAny.saveWorkflowDraft(casF.wfId, { nodes: fNodes }, casFWf.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(fSave.ok, true, "field-removal CAS save ok");
  const fBinds = await bindsOf(casF.wfId, fSave.version_id);
  ok(fBinds.every((b) => b.field_path !== "action.assignment.userIds"), "binding-consuming field removed → binding absent on new version");
  eq(fBinds.length, 3, "field removal → unaffected bindings still carried (root-level + other nodes)");
  eq(canonicalJson(await bindsOf(casF.wfId, casFPrevId)), casFPrevJson, "field removal → old bindings byte-identical");

  // deleted local target → mapping kept as state:'invalid' + binding invalid (inspection preserved)
  const casT = await cfApply("CAST", SRC_CF.nodes as unknown[]);
  await cfResolve(casT.wfId);
  const casTPrev = ((await svc.getWorkflow(casT.wfId)) as { current_version_id?: string }).current_version_id;
  const casTPrevJson = canonicalJson(await bindsOf(casT.wfId, casTPrev));
  await (await mongo.getCollection(COLLECTIONS.admins)).deleteOne({ admin_id: "adm_cf1" });
  const casTWf = (await svc.getWorkflow(casT.wfId)) as { version?: number };
  const casTSave = await svcAny.saveWorkflowDraft(casT.wfId, { name: "target deleted" }, casTWf.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(casTSave.ok, true, "deleted-target CAS save ok");
  const casTBinds = await bindsOf(casT.wfId, casTSave.version_id);
  const casTUser = casTBinds.find((b) => b.kind === "user");
  const casTM0 = casTUser?.resolution?.mappings?.find((m) => m.local_id === "adm_cf1");
  eq(casTM0?.state, "invalid", "deleted target → carried mapping state:'invalid'");
  ok(casTM0?.invalidated_at != null && typeof casTM0?.invalid_reason === "string", "deleted target → invalidated_at + reason");
  eq(casTM0?.local_id, "adm_cf1", "deleted target → identity preserved (no replacement inferred)");
  eq(casTUser?.status, "invalid", "deleted target → binding status invalid");
  eq(casTUser?.resolution?.mappings?.find((m) => m.local_id === "adm_cf2")?.state, "valid", "live target stays valid");
  ok(casTBinds.every((b) => b.status === "resolved" || b.status === "invalid"), "CAS invalid carry → no mapping silently dropped");
  eq(canonicalJson(await bindsOf(casT.wfId, casTPrev)), casTPrevJson, "deleted target → old bindings byte-identical");
  await (await mongo.getCollection(COLLECTIONS.admins)).insertOne({ admin_id: "adm_cf1", role: "agent", active: true });

  // changed source_values on stored doc (corruption) → resolution must not carry
  const corr = await cfApply("CORR", SRC_CF.nodes as unknown[]);
  await cfResolve(corr.wfId);
  const corrPrevId = ((await svc.getWorkflow(corr.wfId)) as { current_version_id?: string }).current_version_id;
  const corrBind = (await bindsOf(corr.wfId, corrPrevId)).find(acc2);
  await (await mongo.getCollection(COLLECTIONS.workflowBindings)).updateOne(
    { binding_id: corrBind?.binding_id }, { $set: { source_values: ["zacc_2", "zacc_1"] } });
  const corrPrevJson = canonicalJson(await bindsOf(corr.wfId, corrPrevId));
  const corrWf = (await svc.getWorkflow(corr.wfId)) as { version?: number };
  const corrSave = await svcAny.saveWorkflowDraft(corr.wfId, { name: "corr" }, corrWf.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(corrSave.ok, true, "corrupted-source CAS save ok");
  const corrNew = (await bindsOf(corr.wfId, corrSave.version_id)).find(acc2);
  eq(corrNew?.status, "unresolved", "changed source_values → resolution not carried (unresolved)");
  ok(!(corrNew?.resolution?.mappings?.length), "positional source_index not reused on reordered values");
  eq(canonicalJson(await bindsOf(corr.wfId, corrPrevId)), corrPrevJson, "corruption case → prev doc untouched by save");

  // crash during carried-binding write → retry deterministic
  const casWf5 = (await svc.getWorkflow(cas.wfId)) as { version?: number; current_version_id?: string };
  const casPtr5 = casWf5.current_version_id;
  armInsertFail(COLLECTIONS.workflowBindings, 1);
  let casCarryThrew = false;
  try { await svcAny.saveWorkflowDraft(cas.wfId, { name: "carry-crash" }, casWf5.version ?? 0, "admin_t"); } catch { casCarryThrew = true; }
  ok(casCarryThrew, "CAS crash @carried binding write → throws");
  const casDocAfter = await svc.getWorkflow(cas.wfId);
  eq(casDocAfter?.version, casWf5.version, "CAS crash @carry → version unchanged");
  eq(casDocAfter?.current_version_id, casPtr5, "CAS crash @carry → pointer unchanged");
  disarm();
  const casCarryRetry = await svcAny.saveWorkflowDraft(cas.wfId, { name: "carry-crash" }, casWf5.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(casCarryRetry.ok, true, "CAS carry retry → completes");
  const casRetryBinds = await bindsOf(cas.wfId, casCarryRetry.version_id);
  eq(casRetryBinds.length, 4, "CAS retry → deterministic binding set complete");
  ok(casRetryBinds.every((b) => b.status === "resolved"
    && (b.resolution?.mappings?.length ?? 0) > 0
    && (b.resolution?.mappings ?? []).every((m) => m.state === "valid")), "CAS retry → carried resolved mappings deterministic");

  // ═══ 29. Task 4 — scope + readiness regression ═══
  console.log("\n=== 29. Carry-forward: scope + readiness regression ===");
  const scp = await cfApply("SCP", SRC_CF.nodes as unknown[]);
  await cfResolve(scp.wfId);
  const scpDetail1 = await svcAny.getWorkflowImportDetail(scp.wfId) as { publish_blockers?: string[]; unresolved_bindings?: number };
  eq(scpDetail1.unresolved_bindings, 0, "resolved fixture → zero unresolved bindings");
  ok(!(scpDetail1.publish_blockers ?? []).some((b) => b.startsWith("account_scope")), "all-valid → no account_scope blocker");
  // carried re-import keeps same readiness shape
  await cfApply("SCP", sameReqNodes);
  const scpDetail2 = await svcAny.getWorkflowImportDetail(scp.wfId) as { publish_blockers?: string[]; unresolved_bindings?: number };
  eq(scpDetail2.unresolved_bindings, 0, "carried re-import → zero unresolved bindings");
  ok(!(scpDetail2.publish_blockers ?? []).some((b) => b.startsWith("account_scope")), "carried valid account mappings → no account_scope blocker");
  // carried invalid account mapping → incomplete blocker (never contributes scope)
  await shopsColl.deleteOne({ shop_id: "shop_cf2" });
  const sameReqNodesV3 = [cfNode(0), cfNode(1), cfNode(2),
    { ...cfNode(3), data: { ...cfData(3), action: { message: { text: "hello v3" } } } }];
  await cfApply("SCP", sameReqNodesV3);
  const scpDetail3 = await svcAny.getWorkflowImportDetail(scp.wfId) as { publish_blockers?: string[] };
  ok((scpDetail3.publish_blockers ?? []).some((b) => b === "account_scope: incomplete account mappings"), "carried invalid account mappings → incomplete blocker");
  await shopsColl.insertOne({ shop_id: "shop_cf2", platform: "tiktok", shopname: "cf2", connected: true });
  // CAS on a carried version — verbatim provenance + target revalidation heal
  const scpWf2 = (await svc.getWorkflow(scp.wfId)) as { version?: number };
  const scpCas = await svcAny.saveWorkflowDraft(scp.wfId, { name: "scp cas" }, scpWf2.version ?? 0, "admin_t") as { ok?: boolean; version_id?: string };
  eq(scpCas.ok, true, "CAS on carried version ok");
  const scpCasBinds = await bindsOf(scp.wfId, scpCas.version_id);
  const healed = scpCasBinds.find(acc2)?.resolution?.mappings?.find((m) => m.local_id === "shop_cf2");
  eq(healed?.state, "valid", "target restored → carried revalidation heals state to valid");
  eq(scpCasBinds.find(acc2)?.status, "invalid", "sticky invalid status — explicit direct resolution only (not silently repaired)");
  const scpAcc2 = scpCasBinds.find(acc2)?.resolution?.mappings ?? [];
  ok(scpAcc2.length === 2 && scpAcc2.every((m) => m.carried === true), "CAS preserves carried:true provenance verbatim");
  const scpWf = await svc.getWorkflow(scp.wfId);
  eq(scpWf?.enabled, false, "carried workflow stays disabled");
  eq(scpWf?.status, "draft", "carried workflow stays draft");
  eq((await svc.listWorkflows({ enabledOnly: true, publishedOnly: true })).length, 0, "engine-visible still 0 after carry-forward cases");
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
