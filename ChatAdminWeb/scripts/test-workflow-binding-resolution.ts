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
//   team/ticket_field/url unresolvable · partial coverage → reject · repeat:true →
//   unsupported fail-closed · happy path → immutable version + version-scoped
//   resolved bindings (server-computed source_fp, via:"direct") + pointer+scope CAS
//   เดียว + audit หลัง commit · crash → deterministic artifacts retry ได้ · orphan
//   ไม่เป็น current · concurrent same expected_version → winner เดียว

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
  await expectReject("repeat:true → unsupported fail-closed", A.wfId,
    { ...A.req(), proposed: [{ ...A.req().proposed[1], repeat: true }] },
    (r) => ok(typeof r.validation === "string" && r.validation.includes("unsupported"), "repeat reject message names unsupported"));
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

  eq(resolveEvents().length, 1, "exactly one workflow.binding_resolve audit event");
  const ev = resolveEvents()[0] as { actor?: string; metadata?: Record<string, unknown> };
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

  // ═══ summary ═══
  const countsEnd = await allCounts();
  const totalWfs = (await collDocs(COLLECTIONS.workflows)).length;
  eq(countsEnd[COLLECTIONS.workflowRawSnapshots], totalWfs - 1, "raw snapshots = imported workflows only (resolution writes none; -1 legacy)");
}

main().then(() => {
  console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
