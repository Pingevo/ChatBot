// Zaapi workflow import preview — pure, no-write.
// Zaapi JSON → sanitized raw snapshot (provenance, engine ไม่ใช้) → canonical
// draft (WorkflowNode/Edge shape เดิม) + dry-run report. External identities
// become unresolved bindings only — never local executable ids. No Mongo, no
// API, no env.

import type { WorkflowNode, WorkflowEdge, WorkflowNodeType } from "./graph";
import { validateWorkflowGraph } from "./graph";
import {
  getDefByZaapiType, getNodeDef, validateCanonicalDraft,
  type DraftValidation, type WorkflowPlatform,
} from "./nodeRegistry";

// ─── Deterministic fingerprint (isomorphic — no node:crypto) ─
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}
/** FNV-1a 64-bit hex — deterministic content fingerprint (ไม่ใช่ crypto hash) */
export function stableFingerprint(v: unknown): string {
  const s = canonicalize(v);
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return "fnv64-" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
export const canonicalJson = canonicalize;

function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

// ─── External-identity + step-ref key vocab (single owner) ──
// key ชื่อเดียวกันใน node data (ทุกระดับ) = external zaapi identity → binding
export const BINDING_KEYS: Record<string, string> = {
  accountIds: "account", accountId: "account",
  userIds: "user", userId: "user",
  adminIds: "user", adminId: "user",
  assigneeUserId: "user", creatorId: "user",
  teamIds: "team", teamId: "team",
  labelIds: "label", labelId: "label", label_ids: "label",
  ticketFieldIds: "ticket_field", ticketFieldId: "ticket_field", ticket_field_ids: "ticket_field",
  channelIds: "channel", channelId: "channel",
  shopIds: "shop", shopId: "shop",
};
// *StepId = zaapi intra-graph step reference (conditions[i].nextStepId,
// action.chatbot.escalationStepId, waitForReply.validReplyStepId, …)
const STEP_KEY = /stepid$/i;
// credential/secret-ish keys → redact ทั้งใน canonical config และ raw snapshot
const REDACT_VALUE = /url|webhook|token|secret|apikey|api_key|password/i;

export interface BindingRequirement {
  node_id: string;      // local canonical node id (zn_*)
  field_path: string;   // path ใน node data — "accountIds" | "action.assignment.teamIds" | "conditions[0].labelIds"
  kind: string;         // account|user|team|label|ticket_field|channel|shop|url
  count: number;        // จำนวน external id ที่ต้อง map
  source_ref: string;   // "nodes[<sourceNodeId>].data.<field_path>" — resolve ค่าจริงใน draft.raw
}

interface StepRef { srcNodeId: string; key: string; field_path: string; target: string; }

function containsUrl(v: unknown): boolean {
  if (typeof v === "string") return /^https?:\/\//.test(v);
  if (Array.isArray(v)) return v.some(containsUrl);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).some(containsUrl);
  return false;
}

/** strip external ids / step refs / credentials จาก node data ทุกระดับ → portable config */
function cleanConfigObject(
  obj: Record<string, unknown>, path: string,
  srcNodeId: string, nid: string,
  bindings: BindingRequirement[], stepRefs: StepRef[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (path === "") {
      if (k === "nodeType" || k === "subType") continue;
      if (k === "name") { out.label = v; continue; }
    }
    if (BINDING_KEYS[k]) {
      const n = Array.isArray(v) ? v.length : (v == null || v === "" ? 0 : 1);
      if (n > 0) bindings.push({ node_id: nid, field_path: p, kind: BINDING_KEYS[k], count: n, source_ref: `nodes[${srcNodeId}].data.${p}` });
      continue; // external ids → bindings (ค่าจริงอยู่ใน raw เท่านั้น)
    }
    if (STEP_KEY.test(k)) {
      if (v != null && v !== "") stepRefs.push({ srcNodeId, key: k, field_path: p, target: String(v) });
      continue; // graph refs → edges/provenance, ไม่คงใน config
    }
    if (REDACT_VALUE.test(k)) {
      if (containsUrl(v)) bindings.push({ node_id: nid, field_path: p, kind: "url", count: 1, source_ref: `nodes[${srcNodeId}].data.${p}` });
      out[k] = "[redacted]";
      continue;
    }
    out[k] = cleanConfigValue(v, p, srcNodeId, nid, bindings, stepRefs);
  }
  return out;
}
function cleanConfigValue(v: unknown, path: string, srcNodeId: string, nid: string, bindings: BindingRequirement[], stepRefs: StepRef[]): unknown {
  if (Array.isArray(v)) return v.map((x, i) => cleanConfigValue(x, `${path}[${i}]`, srcNodeId, nid, bindings, stepRefs));
  if (v && typeof v === "object") return cleanConfigObject(v as Record<string, unknown>, path, srcNodeId, nid, bindings, stepRefs);
  return v;
}

/** provenance raw snapshot — เก็บ source ids/fields สำหรับ rebind/audit; mask เฉพาะ credential; engine ไม่อ่าน */
export function provenanceSnapshot(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(provenanceSnapshot);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACT_VALUE.test(k) ? "[redacted]" : provenanceSnapshot(val);
    }
    return out;
  }
  return v;
}

/** edge.branch ที่ step-ref key คาดว่าจะ map ไป (undefined = provenance back-ref ไม่ต้องมี forward edge) */
function expectedHandleFor(key: string, fieldPath: string): string | null | undefined {
  if (key === "sourceMsgStepId") return undefined; // ref ย้อนไป trigger — provenance
  const ci = fieldPath.match(/^conditions\[(\d+)\]\.nextStepId$/);
  if (ci) return `condition-index-${ci[1]}`;
  const bi = fieldPath.match(/buttons\[(\d+)\]\.nextStepId$/);
  if (bi) return `btn-template-condition-index-${bi[1]}`;
  const ri = fieldPath.match(/(?:^|\.)paths\[(\d+)\]\.nextStepId$/);
  if (ri) return `randomizer-path-${ri[1]}`;
  switch (key) {
    case "nextStepId": return null; // default output
    case "noMatchNextStepId": return "no-match";
    case "escalationStepId": return "ai-chatbot-escalate";
    case "timeoutStepId":
      return fieldPath.includes("chatbot") ? "ai-chatbot-timeout"
        : fieldPath.includes("buttonTemplate") ? "btn-template-expired" : "wfr-no-respond";
    case "timeExpiredStepId":
      return fieldPath.includes("buttonTemplate") ? "btn-template-expired" : "wfr-no-respond";
    case "noButtonClickStepId": return "btn-template-none-selected";
    case "validReplyStepId": return "wfr-success";
    case "retriesExpiredStepId": return "wfr-no-respond";
    default: return undefined; // unknown *StepId — verify-only
  }
}

// ─── Name resolution (all-flows.json ไม่มี name — join _index_data.json ด้วย workflowId exact) ──
export type NameStatus = "ok" | "provided" | "missing_index" | "missing_name" | "ambiguous";
export interface IndexRow { wid?: string; name?: string; stem?: string }
export function resolveFlowName(flow: Record<string, unknown>, opts: { name?: string; indexRows?: IndexRow[] } = {}): { name: string; status: NameStatus; warning?: string } {
  if (typeof opts.name === "string" && opts.name.trim()) return { name: opts.name.trim(), status: "provided" };
  const own = (flow.flow as { name?: unknown } | undefined)?.name;
  if (typeof own === "string" && own.trim()) return { name: own.trim(), status: "ok" };
  const wid = String(flow.workflowId || (flow.flow as { id?: unknown } | undefined)?.id || "");
  const generic = `Zaapi flow ${wid.slice(-8) || "import"}`;
  if (!opts.indexRows) return { name: generic, status: "missing_index", warning: "ไม่มี index file — ใช้ชื่อ generic (ส่ง _index_data.json มาด้วยเพื่อได้ชื่อจริง)" };
  const rows = opts.indexRows.filter((r) => r.wid === wid); // exact match เท่านั้น — stem similarity ไม่นับ
  if (rows.length === 0) return { name: generic, status: "missing_name", warning: `workflowId ไม่มีใน index rows — ใช้ชื่อ generic` };
  if (rows.length > 1) return { name: generic, status: "ambiguous", warning: `duplicate workflowId ×${rows.length} rows ใน index — ใช้ชื่อ generic` };
  const nm = String(rows[0].name || "").trim();
  if (!nm) return { name: generic, status: "missing_name", warning: "index row ไม่มี name" };
  return { name: nm, status: "ok" };
}

// ─── Types ────────────────────────────────────────────────
export interface CanonicalDraft {
  name: string;
  source: "zaapi" | "local" | "canonical";
  status: "draft";
  enabled: false;
  platforms: WorkflowPlatform[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** node_id → { handleId: label } จาก source (round-trip evidence) */
  handleLabels: Record<string, Record<string, string>>;
  bindings: BindingRequirement[];
  /** provenance — source identity + revision + fingerprint; engine ไม่ใช้ */
  sourceRef: { workflowId: string; loadedVersionId: string; versionStatuses: string[]; sourceStatus: string; fingerprint: string };
  /** sanitized source payload — audit/rebind evidence เท่านั้น (credentials masked, external ids เก็บไว้) */
  raw?: unknown;
}

export interface ImportConflict { kind: string; flow: string; detail: string; }
export interface StepRefReport {
  resolved: number;      // ref ตรง edge เดิม handle เดียวกัน (redundant — strip ได้)
  synthesized: number;   // ref ที่ไม่มี edge → สร้าง edge ให้ (jump_to carrier)
  provenance: number;    // back-ref (sourceMsgStepId) — ไม่ต้องมี forward edge
  mismatched: number;    // ref target ถูกแต่ handle ขัดกัน — warning (ไม่นับ resolved)
}
export interface UnresolvedStepRef { node_id: string; field_path: string; }
export interface ImportPreviewReport {
  ok: boolean;
  flowKeyHash: string;
  name: string;
  nameStatus: NameStatus;
  status: "draft";
  source: "zaapi";
  fingerprint: string;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCounts: Record<string, number>;
  unsupportedTypes: { type: string; count: number }[];
  bindings: BindingRequirement[];
  stepRefs: StepRefReport;
  unresolvedStepRefs: UnresolvedStepRef[];
  mismatchedStepRefs: UnresolvedStepRef[];
  warnings: string[];
  conflicts: ImportConflict[];
  structural: { ok: boolean; errors: string[] };
  capability: DraftValidation;
  draft: CanonicalDraft;
}

export interface BatchImportReport {
  ok: boolean;
  flowCount: number;
  nodeCount: number;
  edgeCount: number;
  synthesizedEdges: number;   // jump_to carrier edges ที่ source ไม่มี edge แต่ nextStepId พา link
  reports: ImportPreviewReport[];
  conflicts: ImportConflict[];       // cross-flow (label chains / trigger overlap)
  unsupportedTypes: { type: string; count: number }[];
  bindingsTotal: number;
}

// ─── Node conversion ──────────────────────────────────────
const ZAAPI_FAMILY: Record<string, WorkflowNodeType> = {
  trigger: "trigger", condition: "condition", action: "action",
  delay: "wait", wfr: "wait", utility: "wait",
};

function convertFlow(flow: Record<string, unknown>, name: string, nameStatus: NameStatus): ImportPreviewReport {
  const warnings: string[] = [];
  const bindings: BindingRequirement[] = [];
  const stepRefs: StepRef[] = [];
  const typeCounts: Record<string, number> = {};
  const unsupportedCounts = new Map<string, number>();

  const srcNodes = Array.isArray(flow.nodes) ? flow.nodes as { id?: string; type?: string; position?: { x?: number; y?: number }; data?: Record<string, unknown> }[] : [];
  const srcEdges = Array.isArray(flow.edges) ? flow.edges as { source?: string; target?: string; sourceHandle?: string | null }[] : [];
  const srcHandles = (flow.handles && typeof flow.handles === "object" ? flow.handles : {}) as Record<string, Record<string, string>>;

  const idMap = new Map<string, string>();
  for (const n of srcNodes) if (n.id) idMap.set(n.id, "zn_" + shortHash(String(n.id)));

  const nodes: WorkflowNode[] = [];
  const handleLabels: Record<string, Record<string, string>> = {};
  for (const n of srcNodes) {
    const sid = String(n.id || "");
    const nid = idMap.get(sid) || "zn_" + shortHash(sid + nodes.length);
    const ztype = String(n.type || n.data?.subType || "unknown");
    typeCounts[ztype] = (typeCounts[ztype] || 0) + 1;
    const def = getDefByZaapiType(ztype);
    if (!def) {
      unsupportedCounts.set(ztype, (unsupportedCounts.get(ztype) || 0) + 1);
      warnings.push(`node ${nid}: type "${ztype}" ไม่มีใน registry`);
    }
    const data = (n.data || {}) as Record<string, unknown>;
    const config = cleanConfigObject(data, "", sid, nid, bindings, stepRefs);
    if (srcHandles[sid]) handleLabels[nid] = srcHandles[sid];
    nodes.push({
      node_id: nid,
      type: def ? def.editorType : (ZAAPI_FAMILY[String(data.nodeType)] || "action"),
      subtype: def ? def.type : ztype,
      config,
      position: { x: Number(n.position?.x) || 0, y: Number(n.position?.y) || 0 },
    });
  }

  const edges: WorkflowEdge[] = [];
  for (const e of srcEdges) {
    const s = idMap.get(String(e.source));
    const t = idMap.get(String(e.target));
    if (!s || !t) { warnings.push(`edge ${e.source}→${e.target} อ้าง node ที่ไม่มีใน flow`); continue; }
    edges.push({
      edge_id: "ze_" + shortHash(`${e.source}|${e.target}|${e.sourceHandle ?? ""}`),
      source_node_id: s,
      target_node_id: t,
      branch: e.sourceHandle == null ? undefined : String(e.sourceHandle),
    });
  }

  // step refs: redundant → resolved · ไม่มี edge → synthesize (jump_to carrier) · dangling → block
  const stepReport: StepRefReport = { resolved: 0, synthesized: 0, provenance: 0, mismatched: 0 };
  const unresolvedStepRefs: UnresolvedStepRef[] = [];
  const mismatchedStepRefs: UnresolvedStepRef[] = [];
  for (const r of stepRefs) {
    const nid = idMap.get(r.srcNodeId) || "zn_" + shortHash(r.srcNodeId);
    const localTarget = idMap.get(r.target);
    if (!localTarget) { unresolvedStepRefs.push({ node_id: nid, field_path: r.field_path }); continue; }
    const expected = expectedHandleFor(r.key, r.field_path);
    if (expected === undefined) { stepReport.provenance++; continue; }
    const match = edges.find((e) => e.source_node_id === nid && e.target_node_id === localTarget && (e.branch ?? null) === expected);
    if (match) { stepReport.resolved++; continue; }
    const anyEdge = edges.find((e) => e.source_node_id === nid && e.target_node_id === localTarget);
    if (anyEdge) {
      // link มีอยู่ แต่ handle ขัดกัน — ไม่ใช่ clean resolve: นับ mismatched + เตือนชัด + fail closed
      warnings.push(`node ${nid}: step ref ${r.field_path} คาด branch "${expected ?? "default"}" แต่ edge ใช้ "${anyEdge.branch ?? "default"}"`);
      mismatchedStepRefs.push({ node_id: nid, field_path: r.field_path });
      stepReport.mismatched++;
      continue;
    }
    edges.push({
      edge_id: "ze_" + shortHash(`${r.srcNodeId}|${r.target}|${expected ?? ""}|synth`),
      source_node_id: nid, target_node_id: localTarget,
      branch: expected ?? undefined,
    });
    stepReport.synthesized++;
  }

  const flowObj = (flow.flow && typeof flow.flow === "object" ? flow.flow : {}) as Record<string, unknown>;
  const versions = Array.isArray(flow.versions) ? flow.versions as { status?: string }[] : [];
  const draft: CanonicalDraft = {
    name, source: "zaapi", status: "draft", enabled: false,
    platforms: [],
    nodes, edges, handleLabels, bindings,
    sourceRef: {
      workflowId: String(flow.workflowId || flowObj.id || ""),
      loadedVersionId: String(flow.loadedVersionId || flowObj.active_version_id || ""),
      versionStatuses: versions.map((v) => String(v.status || "unknown")),
      sourceStatus: String(flowObj.status || ""),
      fingerprint: stableFingerprint({ nodes: srcNodes, edges: srcEdges }),
    },
    raw: provenanceSnapshot(flow),
  };

  const structural = validateWorkflowGraph({ nodes, edges });
  const capability = validateCanonicalDraft(nodes, edges, [], bindings);
  // step-ref anomalies = graph ไม่ตรง source → fail closed (per-ref error: local node_id + field_path, ไม่มี external ids)
  for (const d of unresolvedStepRefs) {
    capability.errors.push(`node ${d.node_id}: ${d.field_path} dangling step reference (target ไม่มีใน flow)`);
  }
  for (const m of mismatchedStepRefs) {
    capability.errors.push(`node ${m.node_id}: ${m.field_path} step ref branch ไม่ตรง source edge`);
  }
  if (unresolvedStepRefs.length || mismatchedStepRefs.length) capability.ok = false;
  const conflicts: ImportConflict[] = [];
  // overlapping trigger: trigger type เดียวกัน+accountIds overlap เช็คใน batch; ที่นี่ flag trigger+active-basic pairs ไว้
  return {
    ok: structural.ok && unresolvedStepRefs.length === 0 && mismatchedStepRefs.length === 0,
    flowKeyHash: "h_" + shortHash(String(flow.workflowId || flowObj.id || name)),
    name, nameStatus, status: "draft", source: "zaapi",
    fingerprint: stableFingerprint({ name, nodes, edges }),
    nodeCount: nodes.length, edgeCount: edges.length, nodeTypeCounts: typeCounts,
    unsupportedTypes: [...unsupportedCounts.entries()].map(([type, count]) => ({ type, count })),
    bindings, stepRefs: stepReport, unresolvedStepRefs, mismatchedStepRefs, warnings, conflicts, structural, capability, draft,
  };
}

// ─── Input shape detection ────────────────────────────────
function isFlowObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && Array.isArray((v as { nodes?: unknown }).nodes);
}

/** import preview สำหรับ flow เดียว (single flow object หรือ flow file JSON) */
export function previewZaapiFlow(flowJson: unknown, opts: { name?: string; indexRows?: IndexRow[] } = {}): ImportPreviewReport {
  if (!isFlowObj(flowJson)) {
    throw new Error("invalid zaapi flow JSON: expected object with nodes[]");
  }
  const nr = resolveFlowName(flowJson, opts);
  const report = convertFlow(flowJson, nr.name, nr.status);
  if (nr.warning) report.warnings.push(nr.warning);
  return report;
}

/** import preview สำหรับ all-flows.json ({source,count,flows:[]}) หรือ array */
export function previewZaapiFlows(input: unknown, opts: { indexRows?: IndexRow[]; activeBasicAutomations?: string[] } = {}): BatchImportReport {
  const flows = Array.isArray(input) ? input
    : (input && typeof input === "object" && Array.isArray((input as { flows?: unknown }).flows))
      ? (input as { flows: unknown[] }).flows : [];
  if (flows.length === 0) throw new Error("invalid zaapi export: no flows found");

  const reports = flows.map((f) => previewZaapiFlow(f, { indexRows: opts.indexRows }));
  const conflicts: ImportConflict[] = [];

  // cross-flow label chains: flow A add/remove label ↔ flow B label_added trigger
  const adds = new Map<string, string[]>(); // labelKey → [flowKey]  (key คือ count+flow ไม่ใช่ id — sanitized)
  const labelTrigFlows: { flowKey: string; name: string; hasAccounts: number }[] = [];
  reports.forEach((r, i) => {
    const f = flows[i] as { nodes?: { type?: string; data?: Record<string, unknown> }[] };
    const labelTrigger = (f.nodes || []).find((n) => n.type === "label_added");
    const labelActs = (f.nodes || []).filter((n) => n.type === "add_label" || n.type === "remove_label");
    if (labelTrigger) {
      labelTrigFlows.push({ flowKey: r.flowKeyHash, name: r.name, hasAccounts: 0 });
      for (const other of reports) {
        if (other.flowKeyHash === r.flowKeyHash) continue;
        const of = flows[reports.indexOf(other)] as { nodes?: { type?: string }[] };
        if ((of.nodes || []).some((n) => n.type === "add_label")) {
          conflicts.push({ kind: "label_chain", flow: r.name, detail: `flow "${other.name}" add_label อาจ trigger label_added ของ flow นี้` });
        }
      }
    }
    if (labelActs.length) adds.set(r.flowKeyHash, [r.name]);
    // overlapping triggers: trigger types เดียวกันหลาย flow
  });
  const trigByType = new Map<string, string[]>();
  reports.forEach((r, i) => {
    const f = flows[i] as { nodes?: { type?: string }[] };
    for (const n of f.nodes || []) {
      if ((n as { data?: { nodeType?: string } }).data?.nodeType === "trigger") {
        const t = String(n.type);
        trigByType.set(t, [...(trigByType.get(t) || []), r.name]);
      }
    }
  });
  for (const [t, names] of trigByType) {
    if (names.length > 1) conflicts.push({ kind: "trigger_overlap", flow: names.join(" | "), detail: `trigger "${t}" ใช้ใน ${names.length} flows` });
  }
  if (opts.activeBasicAutomations && opts.activeBasicAutomations.length > 0 && trigByType.has("message_received")) {
    conflicts.push({ kind: "basic_automation_overlap", flow: trigByType.get("message_received")!.join(" | "), detail: `มี basic automation active (${opts.activeBasicAutomations.join(",")}) อาจทำงานซ้อนกับ message_received flows` });
  }

  const unsupported = new Map<string, number>();
  let bindingsTotal = 0;
  for (const r of reports) {
    r.conflicts = conflicts.filter((c) => c.flow === r.name || c.flow.includes(r.name));
    bindingsTotal += r.bindings.length;
    for (const u of r.unsupportedTypes) unsupported.set(u.type, (unsupported.get(u.type) || 0) + u.count);
  }
  return {
    ok: reports.every((r) => r.ok),
    flowCount: reports.length,
    nodeCount: reports.reduce((s, r) => s + r.nodeCount, 0),
    edgeCount: reports.reduce((s, r) => s + r.edgeCount, 0),
    reports, conflicts,
    unsupportedTypes: [...unsupported.entries()].map(([type, count]) => ({ type, count })),
    bindingsTotal,
    synthesizedEdges: reports.reduce((s, r) => s + r.stepRefs.synthesized, 0),
  };
}

// ─── UI file-input path (modal เรียกฟังก์ชันนี้) ────────────
// flowsText = all-flows.json หรือ flow file · indexText = _index_data.json (optional)
export function parseZaapiImportInputs(flowsText: string, indexText?: string): { batch: BatchImportReport } {
  const flowsJson = JSON.parse(flowsText);
  let indexRows: IndexRow[] | undefined;
  if (indexText && indexText.trim()) {
    const idx: unknown = JSON.parse(indexText);
    indexRows = Array.isArray(idx) ? idx as IndexRow[] : (idx as { rows?: IndexRow[] }).rows;
    if (!Array.isArray(indexRows)) throw new Error("invalid index JSON: expected {rows:[]} or array");
  }
  return { batch: previewZaapiFlows(flowsJson, { indexRows }) };
}

// ─── Canonical draft re-import (round-trip) ───────────────
export function importCanonicalDraft(pkg: unknown): CanonicalDraft {
  const p = pkg as { schema?: string; workflow?: { name?: string; nodes?: WorkflowNode[]; edges?: WorkflowEdge[]; handleLabels?: Record<string, Record<string, string>>; bindings?: BindingRequirement[]; platforms?: WorkflowPlatform[]; sourceRef?: CanonicalDraft["sourceRef"]; raw?: unknown } };
  if (!p || p.schema !== "canonical-workflow/1" || !p.workflow || !Array.isArray(p.workflow.nodes) || !Array.isArray(p.workflow.edges)) {
    throw new Error("invalid canonical workflow package");
  }
  const wf = p.workflow;
  return {
    name: String(wf.name || "untitled"), source: "canonical", status: "draft", enabled: false,
    platforms: wf.platforms || [], nodes: wf.nodes!, edges: wf.edges!,
    handleLabels: wf.handleLabels || {}, bindings: wf.bindings || [],
    sourceRef: wf.sourceRef || { workflowId: "", loadedVersionId: "", versionStatuses: [], sourceStatus: "", fingerprint: "" },
    // raw provenance รอด round-trip — bindings[].source_ref resolve ได้หลัง reimport
    raw: wf.raw ?? undefined,
  };
}

export { getNodeDef };
