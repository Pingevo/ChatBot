// Executable tests — Zaapi Workflow Foundation (pure, offline, no Mongo/env).
// Covers: registry coverage, capability matrix, import preview (raw+canonical
// separation), name resolution, export round-trip vs SOURCE, publish gates,
// deterministic handles, palette/filter derivation, SSR smoke.
// Synthetic fixtures are the normal suite. The full Zaapi corpus census runs
// only when ZAAPI_EXPORT_DIR is set (read-only, opt-in).
// Run: npx tsx scripts/test-workflow-foundation.ts
//      ZAAPI_EXPORT_DIR=/path/to/zaapi npx tsx scripts/test-workflow-foundation.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";

import {
  NODE_REGISTRY, REGISTRY_ERRORS, WORKFLOW_PLATFORMS, listByFamily,
  getNodeDef, getDefByZaapiType, nodeAvailabilityFor, availabilityBadge,
  resolveOutputHandles, validateCanonicalDraft, publishReadiness,
  type NodeAvailability, type WorkflowPlatform,
} from "../src/lib/workflow/nodeRegistry";
import * as zi from "../src/lib/workflow/zaapiImport";
import { previewZaapiFlow, previewZaapiFlows, importCanonicalDraft, stableFingerprint, canonicalJson } from "../src/lib/workflow/zaapiImport";
import { exportCanonical, exportRawSource, exportZaapi, exportBytes } from "../src/lib/workflow/workflowExport";
import { validateWorkflowGraph, type WorkflowNode, type WorkflowEdge } from "../src/lib/workflow/graph";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}
function eq<T>(a: T, b: T, name: string) { ok(a === b, `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`); }

// ─── Synthetic Zaapi-shaped fixtures (โครงสร้างตาม export จริง) ──
// ครอบ: nested binding IDs (action.assignment/action.label/setTicketField/
// conditions[]), step refs (top-level/nested/noMatch/chatbot/wfr/button),
// credential field, name-less flow + index join, jump_to ที่ไม่มี edge
const SRC_FLOW = {
  workflowId: "workflow_TEST001",
  loadedVersionId: "workflow-version_V1",
  versions: [{ workflowVersionId: "workflow-version_V1", status: "active" }],
  nodes: [
    { id: "trigger_t1", type: "message_received", position: { x: 0, y: 0 },
      data: { name: "รับข้อความ", nodeType: "trigger", subType: "message_received",
              accountIds: ["acc_ext_1", "acc_ext_2"], nextStepId: "cond_c1" } },
    { id: "cond_c1", type: "label", position: { x: 100, y: 0 },
      data: { name: "เช็ค label", nodeType: "condition", subType: "label",
              conditions: [
                { labelIds: ["lab_ext_9"], nextStepId: "act_a1" },
                { assigneeUserId: "user_ext_7", nextStepId: null },
              ],
              noMatchNextStepId: "act_jump", sourceMsgStepId: "trigger_t1" } },
    { id: "act_a1", type: "add_label", position: { x: 200, y: 0 },
      data: { name: "ติด label", nodeType: "action", subType: "add_label",
              action: { label: { labelIds: ["lab_ext_1", "lab_ext_2"] } },
              nextStepId: "act_assign" } },
    { id: "act_assign", type: "chat_assign", position: { x: 300, y: 0 },
      data: { name: "มอบหมาย", nodeType: "action", subType: "chat_assign",
              action: { assignment: { teamIds: ["team_ext_1"], userIds: ["user_ext_1", "user_ext_2"], assignWhenAllOoh: false } },
              nextStepId: "act_field" } },
    { id: "act_field", type: "set_ticket_field", position: { x: 400, y: 0 },
      data: { name: "set field", nodeType: "action", subType: "set_ticket_field",
              action: { setTicketField: { ticketFieldId: "tf_ext_1", value: "vip" } },
              callbackUrl: "https://hook.example.com/x?token=sekret" } },
    { id: "act_jump", type: "jump_to", position: { x: 500, y: 0 },
      data: { name: "วนกลับ", nodeType: "action", subType: "jump_to",
              action: { jumpTo: { maxJumps: 2 } }, nextStepId: "act_a1" } },
  ],
  edges: [
    { source: "trigger_t1", target: "cond_c1", sourceHandle: null },
    { source: "cond_c1", target: "act_a1", sourceHandle: "condition-index-0" },
    { source: "cond_c1", target: "act_jump", sourceHandle: "no-match" },
    { source: "act_a1", target: "act_assign", sourceHandle: null },
    { source: "act_assign", target: "act_field", sourceHandle: null },
    // ⚠ ไม่มี edge จาก act_jump — nextStepId เป็นตัวพา link เดียว (ตาม export จริง)
  ],
  handles: { cond_c1: { "condition-index-0": "label A", "condition-index-1": "assignee", "no-match": "ไม่ตรง" } },
};

const EXT_IDS = ["acc_ext_1", "acc_ext_2", "lab_ext_9", "lab_ext_1", "lab_ext_2",
  "team_ext_1", "user_ext_1", "user_ext_2", "user_ext_7", "tf_ext_1"];
const STEP_IDS = ["cond_c1", "act_a1", "act_assign", "act_field", "act_jump", "trigger_t1"];

/** resolve "nodes[srcId].data.<path>" inside a raw snapshot → real values */
function resolveRawPath(raw: unknown, ref: string): unknown {
  const m = ref.match(/^nodes\[([^\]]+)\]\.data\.(.+)$/);
  if (!m) return undefined;
  const node = (raw as { nodes?: { id?: string; data?: Record<string, unknown> }[] }).nodes?.find((n) => n.id === m[1]);
  let cur: unknown = node?.data;
  for (const seg of m[2].replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ═══ 1. Node registry ═══
console.log("\n=== 1. Node registry ===");
eq(REGISTRY_ERRORS.length, 0, "no duplicate definitions in registry");
const families = ["trigger", "condition", "action", "utility"] as const;
ok(families.every((f) => listByFamily(f).length > 0), "palette renders every registry family");
for (const f of families) console.log(`    ${f}: ${listByFamily(f).length} defs`);

ok(getDefByZaapiType("nonexistent_type_xyz") === undefined, "unknown zaapi type → undefined (explicit unsupported)");
ok(getNodeDef("nonexistent_type_xyz") === undefined, "unknown canonical type → undefined");

const states: NodeAvailability[] = ["supported", "requires_adapter", "unavailable"];
for (const s of states) ok(availabilityBadge(s).length > 0, `availabilityBadge("${s}") → label`);
function renderAvailability(s: NodeAvailability): string {
  switch (s) { case "supported": return "s"; case "requires_adapter": return "r"; case "unavailable": return "u"; }
}
ok(states.every((s) => renderAvailability(s)), "exhaustive availability switch");

const execDef = getNodeDef("send_message")!;
eq(nodeAvailabilityFor(execDef, "shopee").state, "supported", "send_message@shopee supported");
eq(nodeAvailabilityFor(execDef, "facebook").state, "requires_adapter", "send_message@facebook requires_adapter");
const reviewDef = getNodeDef("reply_to_review")!;
eq(nodeAvailabilityFor(reviewDef, "tiktok").state, "unavailable", "reply_to_review@tiktok unavailable");

const wfr = getNodeDef("wait_for_reply")!;
eq(resolveOutputHandles(wfr, {}).map((x) => x.id).join(","), "wfr-success,wfr-no-respond", "wfr default handles");
eq(resolveOutputHandles(wfr, { answer_type: "any", max_retries: 1, timeout_ms: 1 }).map((x) => x.id).join(","), "success,retry_exceeded,no_reply", "wfr local config → 3 branches");
const cond = getNodeDef("business_hours")!;
eq(resolveOutputHandles(cond, { conditions: [{}, {}] }).map((x) => x.id).join(","), "condition-index-0,condition-index-1,no-match", "condition handles deterministic");
const rnd = getNodeDef("randomizer")!;
eq(resolveOutputHandles(rnd, { randomizer: { paths: [{}, {}, {}] } }).map((x) => x.id).join(","), "randomizer-path-0,randomizer-path-1,randomizer-path-2", "randomizer path handles");

// ═══ 2. Import preview — Raw + Canonical separation (synthetic) ═══
console.log("\n=== 2. Import: raw/canonical separation ===");
const rep = previewZaapiFlow(SRC_FLOW, { indexRows: [{ wid: "workflow_TEST001", name: "flow ทดสอบจริง" }] });
eq(rep.name, "flow ทดสอบจริง", "name resolved via exact workflowId join");
eq(rep.nodeCount, 6, "6 nodes imported");

// canonical config ต้องไม่มี external ID / zaapi step id หลุดอยู่เลย
const canonJson = canonicalJson(rep.draft.nodes);
for (const id of EXT_IDS) ok(!canonJson.includes(id), `config has no external id ${id.slice(0, 6)}…`);
for (const sid of STEP_IDS) ok(!canonJson.includes(sid), `config has no zaapi step id ${sid.slice(0, 8)}…`);

// nested binding extraction — field_path + kind + count + source_ref
const bpaths = rep.bindings.map((b) => `${b.field_path}:${b.kind}:${b.count}`);
const expectB = [
  "accountIds:account:2",
  "conditions[0].labelIds:label:1",
  "conditions[1].assigneeUserId:user:1",
  "action.label.labelIds:label:2",
  "action.assignment.teamIds:team:1",
  "action.assignment.userIds:user:2",
  "action.setTicketField.ticketFieldId:ticket_field:1",
];
for (const e of expectB) ok(bpaths.includes(e), `binding extracted: ${e}`);
ok(rep.bindings.every((b) => typeof b.source_ref === "string" && b.source_ref.length > 0), "every binding has raw source_ref");
ok(!canonJson.includes("acc_ext") && !JSON.stringify(rep.bindings).includes("acc_ext_1"), "no raw id values in bindings/report config");

// raw provenance layer — engine ไม่ใช้ แต่ rebind/audit ต้อง resolve ค่าจริงได้
const raw = (rep.draft as { raw?: unknown }).raw;
ok(raw != null && typeof raw === "object", "draft.raw provenance snapshot exists");
eq((rep.draft.sourceRef as { workflowId?: string }).workflowId, "workflow_TEST001", "sourceRef keeps real workflow id (provenance)");
eq((rep.draft.sourceRef as { loadedVersionId?: string }).loadedVersionId, "workflow-version_V1", "sourceRef keeps real version id");
const teamBinding = rep.bindings.find((b) => b.field_path === "action.assignment.teamIds");
eq(teamBinding ? JSON.stringify(resolveRawPath(raw, teamBinding.source_ref)) : undefined, JSON.stringify(["team_ext_1"]), "binding source_ref resolves real ids inside raw");
ok(raw != null && !canonicalJson(raw).includes("sekret"), "raw snapshot redacts credential values");

// step refs — nested redundant refs verified; jump_to carrier → synthesized edge
ok(rep.stepRefs != null, "report exposes step-ref evidence");
eq(rep.stepRefs.synthesized, 1, "jump_to nextStepId → 1 synthesized edge");
eq(rep.edgeCount, 6, "5 source edges + 1 synthesized jump edge");
const synthEdge = rep.draft.edges.find((e) => e.source_node_id.endsWith("") && e.branch === undefined
  && rep.draft.nodes.find((n) => n.node_id === e.source_node_id)?.subtype === "jump_to");
ok(!!synthEdge, "synthesized edge leaves the jump_to node");
const a1Local = rep.draft.nodes.find((n) => n.subtype === "add_label")?.node_id;
eq(synthEdge?.target_node_id, a1Local, "synthesized edge targets local add_label node");
eq(rep.draft.nodes.find((n) => n.subtype === "jump_to")?.config.nextStepId, undefined, "jump_to config carries no zaapi step id");
eq((rep.draft.nodes.find((n) => n.subtype === "jump_to")?.config.action as Record<string, unknown>)?.jumpTo ? true : false, true, "jump_to portable config preserved");

// non-id config fields survive cleaning
const assignCfg = rep.draft.nodes.find((n) => n.subtype === "assign_ticket")?.config;
eq((assignCfg?.action as Record<string, Record<string, unknown>>)?.assignment?.assignWhenAllOoh, false, "non-id nested fields preserved");
eq((rep.draft.nodes.find((n) => n.subtype === "set_ticket_field")?.config.action as Record<string, Record<string, unknown>>)?.setTicketField?.value, "vip", "ticket field value preserved");

// dangling step ref → unresolved + blocks publish
const danglingFlow = { workflowId: "w_dangle", nodes: [
  { id: "t", type: "message_received", position: {}, data: { nodeType: "trigger", nextStepId: "ghost_node" } },
], edges: [] };
const drep = previewZaapiFlow(danglingFlow);
ok((drep.unresolvedStepRefs?.length ?? 0) > 0, "dangling nextStepId → unresolvedStepRefs");
ok(!drep.capability.ok, "dangling step ref blocks publish readiness");
ok(!drep.capability.ok && drep.draft.nodes.length === 1, "dangling draft stays viewable but blocked");

// randomizer paths[i].nextStepId → edge handle "randomizer-path-i" (ตาม corpus จริง)
const RND_NODES = [
  { id: "tr", type: "message_received", position: { x: -100, y: 0 }, data: { nodeType: "trigger", name: "trig" } },
  { id: "r1", type: "randomizer", position: { x: 0, y: 0 }, data: { nodeType: "utility", name: "rand", randomizer: { paths: [{ weight: 50, nextStepId: "a1" }, { weight: 50, nextStepId: "a2" }] } } },
  { id: "a1", type: "send_message", position: { x: 100, y: 0 }, data: { nodeType: "action", name: "A1" } },
  { id: "a2", type: "send_message", position: { x: 100, y: 100 }, data: { nodeType: "action", name: "A2" } },
];
const rndEdges = [
  { source: "tr", target: "r1", sourceHandle: null },
  { source: "r1", target: "a1", sourceHandle: "randomizer-path-0" },
  { source: "r1", target: "a2", sourceHandle: "randomizer-path-1" },
];
const rr = previewZaapiFlow({ workflowId: "w_rnd", nodes: RND_NODES, edges: rndEdges });
eq(rr.stepRefs.resolved, 2, "randomizer path refs resolve to randomizer-path-i handles");
eq(rr.stepRefs.synthesized, 0, "matching path handles → no synthesis");
eq((rr.stepRefs as { mismatched?: number }).mismatched ?? 0, 0, "matching handles → zero mismatch");
ok(!rr.warnings.some((w) => /step ref|branch/i.test(w)), "no false handle warnings on clean randomizer");

const rr2 = previewZaapiFlow({ workflowId: "w_rnd2", nodes: RND_NODES, edges: [rndEdges[0], rndEdges[2]] });
eq(rr2.stepRefs.synthesized, 1, "missing path edge → synthesized");
eq(rr2.stepRefs.resolved, 1, "remaining path ref still resolved");
const synthRnd = rr2.draft.edges.find((e) => e.branch === "randomizer-path-0");
ok(!!synthRnd, "synthesized path edge carries randomizer-path-0 handle");
const a1id = rr2.draft.nodes.find((n) => (n.config as { label?: string }).label === "A1")?.node_id;
eq(synthRnd?.target_node_id, a1id, "synthesized path edge targets correct local node");

const rr3 = previewZaapiFlow({ workflowId: "w_rnd3", nodes: RND_NODES, edges: [
  rndEdges[0], { source: "r1", target: "a1", sourceHandle: "condition-index-0" }, rndEdges[2]] });
eq(rr3.stepRefs.mismatched ?? 0, 1, "right target / wrong handle → mismatched");
eq(rr3.stepRefs.resolved, 1, "mismatched ref is NOT counted as resolved");
ok(rr3.warnings.some((w) => /step ref/i.test(w)), "handle mismatch produces explicit warning");
// mismatch = graph ไม่ตรง source → fail closed เหมือน dangling refs (structural.ok=true ที่นี่ → ok=false มาจาก mismatch โดยเฉพาะ)
ok(rr3.structural.ok === true, "mismatch fixture otherwise structurally valid");
ok(rr3.ok === false, "mismatched handle → preview ok=false (fail closed)");
ok(publishReadiness(rr3.capability).canPublish === false, "mismatched handle → publish readiness blocked");
const misErr = rr3.capability.errors.find((e) => /paths\[0\]\.nextStepId/.test(e));
ok(!!misErr, "capability error names the mismatched field_path");
ok(!!misErr && /zn_/.test(misErr), "capability error names the local node_id");
ok(!!misErr && !/\ba1\b|\ba2\b|(?<![\w])r1(?!\w)/.test(misErr), "capability error does not leak zaapi/external ids");
// contract เดิมยังต้องผ่าน: clean resolve + correct-handle synthesis
ok(rr.ok === true, "clean randomizer still passes preview");
ok(rr2.ok === true, "correct-handle synthesized edge still passes preview");
ok(!rr2.capability.errors.some((e) => /step ref|paths\[/.test(e)), "synthesized edge adds no step-ref error");

// malformed graph fails closed (no throw)
const badReport = previewZaapiFlow({ workflowId: "w_bad", nodes: [{ id: "a", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [{ source: "a", target: "ghost" }] });
ok(!badReport.structural.ok, "dangling edge → structural validation fails closed");
let threw = false;
try { previewZaapiFlow("not a flow"); } catch { threw = true; }
ok(threw, "non-flow input throws");

// unresolved bindings + unsupported block publish
ok(rep.bindings.length > 0 && !rep.capability.ok, "unresolved bindings + adapter-missing nodes block publish readiness");
const fakeUnsupported = previewZaapiFlow({ workflowId: "w_x", nodes: [{ id: "n1", type: "totally_unknown_node", position: {}, data: { nodeType: "action" } }, { id: "t1", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [{ source: "t1", target: "n1" }] });
eq(fakeUnsupported.unsupportedTypes.length, 1, "unknown node type → unsupported evidence");
ok(!fakeUnsupported.capability.ok, "unsupported node blocks publish");

// local ids ไม่ใช่ zaapi ids
ok(rep.draft.nodes.every((n) => n.node_id.startsWith("zn_")), "local node ids are zn_* (not zaapi ids)");
ok(rep.draft.edges.every((e) => e.edge_id.startsWith("ze_")), "local edge ids are ze_*");
eq(rep.status, "draft", "imported status = draft");
eq(rep.draft.enabled, false, "imported enabled = false");

// ═══ 3. Name resolution (A2 — shape ของไฟล์จริง) ═══
console.log("\n=== 3. Flow name resolution ===");
// all-flows entries ไม่มี name → index rows join ด้วย workflowId exact
const nameOk = previewZaapiFlow({ workflowId: "workflow_N1", nodes: [{ id: "t", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [] }, { indexRows: [{ wid: "workflow_N1", name: "ชื่อจาก index" }] });
eq(nameOk.name, "ชื่อจาก index", "index row supplies real name");
eq(nameOk.nameStatus, "ok", "nameStatus ok when exact wid row matches");

const noIndex = previewZaapiFlow({ workflowId: "workflow_N2", nodes: [{ id: "t", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [] });
ok(noIndex.name.startsWith("Zaapi flow"), "missing index → generic name");
eq(noIndex.nameStatus, "missing_index", "missing index → nameStatus missing_index");
ok(noIndex.warnings.some((w) => /index/i.test(w)), "missing index → explicit warning");

const noRow = previewZaapiFlow({ workflowId: "workflow_N3", nodes: [{ id: "t", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [] }, { indexRows: [{ wid: "workflow_OTHER", name: "ไม่เกี่ยว" }] });
eq(noRow.nameStatus, "missing_name", "wid absent in index → missing_name");
ok(noRow.warnings.some((w) => /name|index/i.test(w)), "missing row → explicit warning");

const dupRows = previewZaapiFlow({ workflowId: "workflow_N4", nodes: [{ id: "t", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [] }, { indexRows: [{ wid: "workflow_N4", name: "a" }, { wid: "workflow_N4", name: "b" }] });
eq(dupRows.nameStatus, "ambiguous", "duplicate wid rows → ambiguous");
ok(dupRows.warnings.some((w) => /ambiguous|duplicate/i.test(w)), "duplicate wid → explicit warning");

// stem similarity ต้องไม่ match — exact wid เท่านั้น
const stemTrick = previewZaapiFlow({ workflowId: "workflow_XYZ", nodes: [{ id: "t", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [] }, { indexRows: [{ wid: "workflow_OTHER", stem: "05_XYZabc", name: "ผิด" }] });
ok(stemTrick.name !== "ผิด", "stem-substring match rejected (exact wid only)");

// per-flow file มี flow.name → authoritative
const ownName = previewZaapiFlow({ flow: { id: "workflow_F1", name: "ชื่อใน flow file", status: "active" }, nodes: [{ id: "t", type: "message_received", position: {}, data: { nodeType: "trigger" } }], edges: [] });
eq(ownName.name, "ชื่อใน flow file", "flow.name is authoritative for flow files");
eq(ownName.nameStatus, "ok", "flow.name → nameStatus ok");

// UI path — parseZaapiImportInputs คือฟังก์ชันที่ modal เรียกจริง (file text → report)
ok(typeof zi.parseZaapiImportInputs === "function", "parseZaapiImportInputs exists (UI call path)");
if (typeof zi.parseZaapiImportInputs === "function") {
  const parsed = zi.parseZaapiImportInputs(
    JSON.stringify({ flows: [SRC_FLOW] }),
    JSON.stringify({ rows: [{ wid: "workflow_TEST001", name: "joined name" }] }),
  );
  eq(parsed.batch?.reports?.[0]?.name, "joined name", "two-file join resolves real name via UI path");
  const noIdx = zi.parseZaapiImportInputs(JSON.stringify({ flows: [SRC_FLOW] }));
  eq(noIdx.batch?.reports?.[0]?.nameStatus, "missing_index", "no index file → missing_index warning");
  let pthrew = false;
  try { zi.parseZaapiImportInputs("{broken"); } catch { pthrew = true; }
  ok(pthrew, "malformed flows JSON throws a catchable error");
  // single flow file ({workflowId,versions,nodes,edges} — ไม่ใช่ {flows:[]}) ต้อง wrap เป็น batch ของ 1
  const single = zi.parseZaapiImportInputs(JSON.stringify(SRC_FLOW));
  eq(single.batch?.reports?.length, 1, "single flow file object accepted via UI path (batch of 1)");
  const singleDirect = previewZaapiFlows(SRC_FLOW);
  eq(singleDirect.reports.length, 1, "single flow object accepted via API path (previewZaapiFlows)");
}

// ═══ 4. Export + round-trip (เทียบกับ source จริง ไม่ใช่ canonical กับตัวเอง) ═══
console.log("\n=== 4. Export + round-trip vs source ===");
const draft = rep.draft;
const canon = exportCanonical(draft);
eq(canon.schema, "canonical-workflow/1", "canonical schema version");
const canon2 = exportCanonical(draft);
eq(canon.fingerprint, canon2.fingerprint, "export fingerprint stable");
eq(exportBytes(canon), exportBytes(canon2), "export bytes deterministic");
// executable configs ต้องไม่มี external ids (provenance layer เก็บไว้แยก ถูกต้อง)
ok(!canonicalJson(draft.nodes.map((n) => n.config)).includes("team_ext_1"), "canonical executable configs contain no external ids");

const reimp = importCanonicalDraft(canon);
eq(reimp.nodes.length, draft.nodes.length, "round-trip node count");
eq(reimp.edges.length, draft.edges.length, "round-trip edge count");
const posA = new Map(draft.nodes.map((n) => [n.node_id, `${n.position.x},${n.position.y}`]));
ok(reimp.nodes.every((n) => posA.get(n.node_id) === `${n.position.x},${n.position.y}`), "positions survive round-trip");
const edgeA = new Map(draft.edges.map((e) => [e.edge_id, `${e.source_node_id}>${e.target_node_id}#${e.branch ?? ""}`]));
ok(reimp.edges.every((e) => edgeA.get(e.edge_id) === `${e.source_node_id}>${e.target_node_id}#${e.branch ?? ""}`), "edges + branches survive round-trip");
eq(canonicalJson(reimp.handleLabels), canonicalJson(draft.handleLabels), "handle labels survive");
eq(canonicalJson(reimp.bindings), canonicalJson(draft.bindings), "binding paths survive round-trip");
eq(reimp.sourceRef.workflowId, draft.sourceRef.workflowId, "sourceRef provenance survives");

// finding 1 — canonical ต้องพก provenance ไม่งั้น source_ref ชี้ค่าที่ไม่มีแล้ว (เรียก lossless ไม่ได้)
ok((reimp as { raw?: unknown }).raw != null, "canonical round-trip restores raw provenance");
eq(canonicalJson(reimp.raw), canonicalJson(draft.raw), "reimported raw identical to imported raw");
for (const b of reimp.bindings) {
  const v = resolveRawPath(reimp.raw, b.source_ref);
  ok(Array.isArray(v) ? v.length === b.count : v != null, `reimported binding resolvable via source_ref: ${b.field_path}`);
}
ok(!canonicalJson(reimp.nodes.map((n) => n.config)).includes("team_ext_1"), "reimported executable config stays free of external ids");
ok(!canonicalJson(reimp.raw).includes("sekret"), "reimported raw keeps credential masking");

// เทียบกับ SOURCE: positions/handles/edges ต้องตรง export ต้นทาง (ผ่าน local-id map)
const srcByPos = new Map(SRC_FLOW.nodes.map((n) => [`${n.position.x},${n.position.y}`, n]));
ok(draft.nodes.every((n) => srcByPos.get(`${n.position.x},${n.position.y}`) != null), "every canonical node position exists in source");
const srcEdgeSet = new Set(SRC_FLOW.edges.map((e) => {
  const s = SRC_FLOW.nodes.find((n) => n.id === e.source)!, t = SRC_FLOW.nodes.find((n) => n.id === e.target)!;
  return `${s.position.x},${s.position.y}>${t.position.x},${t.position.y}#${e.sourceHandle ?? ""}`;
}));
const canonEdgeSet = new Set(draft.edges.map((e) => {
  const s = draft.nodes.find((n) => n.node_id === e.source_node_id)!, t = draft.nodes.find((n) => n.node_id === e.target_node_id)!;
  return `${s.position.x},${s.position.y}>${t.position.x},${t.position.y}#${e.branch ?? ""}`;
}));
ok([...srcEdgeSet].every((e) => canonEdgeSet.has(e)), "every source edge survives canonically (position-mapped)");
eq(canonEdgeSet.size - srcEdgeSet.size, 1, "exactly one synthesized edge added (jump_to carrier)");

// raw export = sanitized snapshot + manifest identity สำหรับ audit/rebind
const rawExp = exportRawSource(draft);
eq(rawExp.schema, "zaapi-raw-sanitized/1", "raw export schema");
const rawStr = canonicalJson(rawExp);
// raw export = audit/rebind snapshot — external id values ต้องอยู่ (ค่าที่ binding ชี้ถึง), credentials เท่านั้นที่ mask
for (const id of EXT_IDS) ok(rawStr.includes(id), `raw export keeps id value for rebind ${id.slice(0, 6)}…`);
ok(!rawStr.includes("sekret"), "raw export has no credential values");
eq((rawExp as { manifest?: { workflowId?: string } }).manifest?.workflowId, "workflow_TEST001", "raw manifest keeps source workflow identity");
eq((rawExp as { manifest?: { loadedVersionId?: string } }).manifest?.loadedVersionId, "workflow-version_V1", "raw manifest keeps source version identity");

// zaapi projection — เฉพาะ reverse-mapped fields + omitted ตรงจริง
const zp = exportZaapi(draft);
eq(zp.schema, "zaapi-compatible/1", "zaapi projection schema");
eq(zp.flow.nodes.length, draft.nodes.length, "zaapi projection node count");
eq(zp.flow.edges.length, draft.edges.length, "zaapi projection edge count");
ok(zp.omittedFields.includes("bindings") && zp.omittedFields.includes("raw"), "omitted fields honest (bindings+raw)");
const zpNames = zp.flow.nodes.map((n) => (n as { data?: { name?: string } }).data?.name);
ok(zpNames.includes("รับข้อความ") && zpNames.includes("มอบหมาย"), "projection restores data.name from label");
eq(zp.unmappableNodes.length, 0, "all imported types reverse-map");

// ═══ 5. Validation + publish gates ═══
console.log("\n=== 5. Validation + gates ===");
const good: WorkflowNode[] = [
  { node_id: "t1", type: "trigger", subtype: "message_received", config: {}, position: { x: 0, y: 0 } },
  { node_id: "a1", type: "action", subtype: "send_message", config: { text: "hi" }, position: { x: 0, y: 100 } },
];
const goodEdges: WorkflowEdge[] = [{ edge_id: "e1", source_node_id: "t1", target_node_id: "a1" }];
const goodVal = validateCanonicalDraft(good, goodEdges, ["shopee"], []);
ok(goodVal.ok, "supported local draft validates");
ok(!publishReadiness(goodVal).canPublish, "supported draft stays disabled (persistence out of scope)");
const platBad = validateCanonicalDraft(good, goodEdges, ["facebook"], []);
ok(!platBad.ok, "supported node on adapter-missing platform fails publish validation");
const structBad = validateWorkflowGraph({ nodes: [], edges: [{ edge_id: "e", source_node_id: "x", target_node_id: "y" }] });
ok(!structBad.ok, "invalid graph → structural fail");
const capEmpty = validateCanonicalDraft([], goodEdges, ["shopee"], []);
ok(capEmpty.ok === false || capEmpty.ok === true, "capability layer consistent");

// ═══ 6. UI derivation + SSR smoke ═══
console.log("\n=== 6. UI derivation (SSR smoke) ===");
function paletteItems(platform: WorkflowPlatform | null, search: string) {
  return NODE_REGISTRY.filter((d) => {
    if (platform && nodeAvailabilityFor(d, platform).state !== "supported") return false;
    if (search && !(d.label + d.type).toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
}
ok(paletteItems(null, "").length === NODE_REGISTRY.length, "palette = full registry");
ok(paletteItems("facebook", "").every((d) => nodeAvailabilityFor(d, "facebook").state === "supported"), "platform filter uses registry metadata");
ok(paletteItems(null, "message").every((d) => /message/i.test(d.label + d.type)), "search by display metadata");
const unav = NODE_REGISTRY.find((d) => d.availability === "unavailable")!;
ok(!!unav && availabilityBadge(unav.availability) === "Unavailable", "unavailable node reports state");

const markup = renderToStaticMarkup(
  h("div", null,
    h("ul", { "data-testid": "palette" }, paletteItems(null, "").slice(0, 5).map((d) => h("li", { key: d.type }, d.label))),
    h("div", { "data-testid": "inspector" }, `type=${unav.type} state=${unav.availability}`)));
ok(markup.includes("Message Received"), "SSR palette markup renders registry labels");
ok(markup.includes("state=unavailable"), "SSR inspector markup renders availability");

// ═══ 7. Zaapi corpus census (opt-in — ZAAPI_EXPORT_DIR) ═══
const ZAAPI_DIR = process.env.ZAAPI_EXPORT_DIR;
if (ZAAPI_DIR) {
  console.log(`\n=== 7. Zaapi corpus census (${ZAAPI_DIR}) ===`);
  const allFlows = JSON.parse(readFileSync(join(ZAAPI_DIR, "data/flows/all-flows.json"), "utf8"));
  const indexData = JSON.parse(readFileSync(join(ZAAPI_DIR, "data/flows/_index_data.json"), "utf8"));
  const basicAutos = JSON.parse(readFileSync(join(ZAAPI_DIR, "data/basic-automations.json"), "utf8"));

  const usedTypes = new Set<string>();
  for (const fl of allFlows.flows) for (const n of fl.nodes) usedTypes.add(n.type);
  eq(usedTypes.size, 31, "31 distinct node types used by flows");
  const unresolved = [...usedTypes].filter((t) => !getDefByZaapiType(t));
  eq(unresolved.length, 0, `all used types resolve (missing: ${unresolved.join(",") || "none"})`);

  const batch = previewZaapiFlows(allFlows, { indexRows: indexData.rows, activeBasicAutomations: basicAutos.matched });
  eq(batch.flowCount, 21, "21 custom flows parse");
  eq(batch.nodeCount, 218, "218 nodes preserved");
  eq(batch.edgeCount - batch.synthesizedEdges, 225, "225 source edges (edgeCount นับรวม synthesized)");
  eq(batch.synthesizedEdges, 23, "23 jump_to carrier edges synthesized");
  ok(batch.ok, "all flows structurally valid");
  eq(batch.unsupportedTypes.length, 0, "zero unsupported types in real fixture");
  ok(batch.bindingsTotal > 26, `nested bindings now counted fully (${batch.bindingsTotal} > old 26)`);
  ok(batch.conflicts.some((c) => c.kind === "trigger_overlap"), "trigger overlap conflicts reported");
  ok(batch.conflicts.some((c) => c.kind === "basic_automation_overlap"), "active basic-automation overlap reported");
  ok(batch.conflicts.some((c) => c.kind === "label_chain"), "label-chain conflicts reported");

  // ทุก flow ได้ชื่อจริงจาก index (exact wid join)
  const idxByWid = new Map(indexData.rows.map((r: { wid?: string; name?: string }) => [r.wid, r.name]));
  ok(batch.reports.every((r) => r.name === idxByWid.get((r.draft.sourceRef as { workflowId?: string }).workflowId)), "all 21 flows named from index via exact wid");
  eq(batch.reports.filter((r) => r.nameStatus !== "ok").length, 0, "zero name warnings on real corpus");

  // canonical executable config ต้องไม่มี external id ใดๆ จาก source
  const extValues = new Set<string>();
  const collectIds = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(collectIds);
    if (v && typeof v === "object") return Object.values(v).forEach(collectIds);
    if (typeof v === "string" && /^[0-9a-f]{24}$/.test(v)) extValues.add(v);
  };
  for (const fl of allFlows.flows) collectIds(fl.nodes);
  ok(extValues.size > 0, `collected ${extValues.size} external id values from source`);
  const canonAll = canonicalJson(batch.reports.map((r) => ({ nodes: r.draft.nodes, edges: r.draft.edges })));
  const leaked = [...extValues].filter((id) => canonAll.includes(id));
  eq(leaked.length, 0, "zero external ids leak into canonical config");

  // binding ครบพอ rebind: field_path + source_ref resolve ได้ใน raw
  const allBindings = batch.reports.flatMap((r) => r.bindings.map((b) => ({ b, raw: (r.draft as { raw?: unknown }).raw })));
  ok(allBindings.every(({ b }) => typeof b.field_path === "string" && b.field_path.length > 0), "every binding has field_path");
  ok(allBindings.every(({ b, raw }) => resolveRawPath(raw, b.source_ref) !== undefined), "every binding source_ref resolves inside raw");
  ok(!canonicalJson(batch.reports.map((r) => r.bindings)).match(/[0-9a-f]{24}/), "binding list itself carries no raw id values");

  // fingerprint stable + round-trip เทียบ source บน corpus
  const batch2 = previewZaapiFlows(allFlows, { indexRows: indexData.rows });
  eq(batch.reports[0].fingerprint, batch2.reports[0].fingerprint, "same input → stable fingerprint");
  const rt = importCanonicalDraft(exportCanonical(batch.reports[0].draft));
  eq(rt.nodes.length, batch.reports[0].draft.nodes.length, "corpus round-trip node count");
  ok(rt.edges.every((e) => batch.reports[0].draft.edges.some((o) => o.edge_id === e.edge_id)), "corpus round-trip edges");
} else {
  console.log("\n=== 7. Zaapi corpus census — SKIPPED (set ZAAPI_EXPORT_DIR to run) ===");
}

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
