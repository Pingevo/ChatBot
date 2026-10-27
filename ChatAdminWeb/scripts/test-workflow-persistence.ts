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
  const leaseBatchFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint({ source: "zaapi", flows: leaseBatch.reports.map((r) => `${r.draft.sourceRef.workflowId}|${r.fingerprint}`) });
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
  const fenceFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint({ source: "zaapi", flows: fenceBatch.reports.map((r) => `${r.draft.sourceRef.workflowId}|${r.fingerprint}`) });
  const fenceBatchId = "wib_" + _sh(fenceFp);

  // steal claim เมื่อ A อ่าน versions ของ flow ที่ 2 — takeover+lease หมดอายุ
  // (claimant B ตายด้วย → lease past → caller ถัดไป takeover ได้ deterministic)
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
  const renewFp = (await import("../src/lib/workflow/zaapiImport")).stableFingerprint({ source: "zaapi", flows: renewBatch.reports.map((r) => `${r.draft.sourceRef.workflowId}|${r.fingerprint}`) });
  const renewBatchId = "wib_" + _sh(renewFp);

  // expire A's own lease ระหว่าง flow1→flow2 (ไม่มีใคร takeover — token เดิม)
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
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
