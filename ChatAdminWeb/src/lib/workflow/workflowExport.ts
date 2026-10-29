// Workflow export — pure functions. 3 formats:
//   canonical  = lossless app backup (canonical-workflow/1) — graph/config/
//                bindings/provenance (raw snapshot — rebind data รอด round-trip);
//                executable config ไม่มี external ids (อยู่ใน raw เท่านั้น)
//   raw        = sanitized source snapshot + manifest (source identity สำหรับ
//                audit/rebind; id values → counts, credentials masked)
//   zaapi      = Zaapi-compatible projection (reverse-mapped fields only,
//                omitted fields listed explicitly — NOT lossless)
// Deterministic ordering + content fingerprint. No env/Mongo/network.

import type { WorkflowNode, WorkflowEdge } from "./graph";
import { getNodeDef } from "./nodeRegistry";
import { canonicalJson, stableFingerprint, provenanceSnapshot, type CanonicalDraft } from "./zaapiImport";

function sortNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  return [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id));
}
function sortEdges(edges: WorkflowEdge[]): WorkflowEdge[] {
  return [...edges].sort((a, b) => a.edge_id.localeCompare(b.edge_id));
}

// ─── Canonical export (lossless) ──────────────────────────
export function exportCanonical(draft: CanonicalDraft): { schema: string; fingerprint: string; workflow: object } {
  const workflow = {
    name: draft.name,
    source: draft.source,
    platforms: [...draft.platforms].sort(),
    nodes: sortNodes(draft.nodes),
    edges: sortEdges(draft.edges),
    handleLabels: Object.fromEntries(Object.entries(draft.handleLabels).sort(([a], [b]) => a.localeCompare(b))),
    bindings: draft.bindings,
    sourceRef: draft.sourceRef,
    // raw provenance ต้องอยู่ใน canonical — ไม่งั้น bindings[].source_ref ชี้ค่าที่หายไป
    // (external id values เก็บไว้เพื่อ rebind; credentials masked แล้วตอน import)
    raw: draft.raw ?? null,
  };
  return { schema: "canonical-workflow/1", fingerprint: stableFingerprint(workflow), workflow };
}

// ─── Raw source export (provenance snapshot — external ids kept for rebind,
//    credentials masked via provenanceSnapshot owner เดียวกับ import) ────────
const DROP_KEYS = new Set(["nodeText", "domNodeCount"]);

export interface RawSourceExport {
  schema: string;
  fingerprint: string;
  /** source identity สำหรับ audit/rebind — workflowId/versionId จริงของ Zaapi */
  manifest: { workflowId: string; loadedVersionId: string; name: string; nodeCount: number; edgeCount: number; bindingsTotal: number; sourceFingerprint: string };
  source: object;
}

export function exportRawSource(draft: CanonicalDraft): RawSourceExport {
  const src = (draft.raw && typeof draft.raw === "object" ? draft.raw : {}) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (DROP_KEYS.has(k)) continue;
    clean[k] = provenanceSnapshot(v);
  }
  clean._provenance = { exportedBy: "zaapi-workflow-foundation", originalKeys: Object.keys(src).sort() };
  const manifest = {
    workflowId: draft.sourceRef.workflowId,
    loadedVersionId: draft.sourceRef.loadedVersionId,
    name: draft.name,
    nodeCount: draft.nodes.length,
    edgeCount: draft.edges.length,
    bindingsTotal: draft.bindings.length,
    sourceFingerprint: draft.sourceRef.fingerprint,
  };
  return { schema: "zaapi-raw-sanitized/1", fingerprint: stableFingerprint(clean), manifest, source: clean };
}

// ─── Zaapi-compatible projection ──────────────────────────
export interface ZaapiExportResult {
  schema: string;
  fingerprint: string;
  flow: { nodes: object[]; edges: object[]; handles: Record<string, Record<string, string>> };
  omittedFields: string[];   // fields dropped because no tested reverse mapping exists
  unmappableNodes: string[]; // canonical types with no zaapi projection
}

export function exportZaapi(draft: CanonicalDraft): ZaapiExportResult {
  const omitted = new Set<string>(["bindings", "sourceRef", "platforms", "raw"]);
  const unmappable: string[] = [];
  const nodes = sortNodes(draft.nodes).map((n) => {
    const def = getNodeDef(n.subtype);
    const ztype = def?.zaapiTypes?.[0] || (def ? n.subtype : undefined);
    if (!ztype) { unmappable.push(n.node_id); }
    const nodeType = def?.family === "utility" ? (ztype === "delay" || ztype === "wfr" ? ztype : "utility") : def?.family;
    const { label, ...rest } = n.config;
    const data: Record<string, unknown> = { nodeType, subType: ztype, ...(label !== undefined ? { name: label } : {}), ...rest };
    return { id: n.node_id, type: ztype || n.subtype, position: n.position, data };
  });
  const edges = sortEdges(draft.edges).map((e) => ({
    source: e.source_node_id, target: e.target_node_id,
    sourceHandle: e.branch ?? null,
  }));
  const handles: Record<string, Record<string, string>> = {};
  for (const n of draft.nodes) if (draft.handleLabels[n.node_id]) handles[n.node_id] = draft.handleLabels[n.node_id];
  const flow = { nodes, edges, handles };
  return { schema: "zaapi-compatible/1", fingerprint: stableFingerprint(flow), flow, omittedFields: [...omitted].sort(), unmappableNodes: unmappable.sort() };
}

/** deterministic export bytes (canonical JSON — key-sorted) */
export function exportBytes(result: object): string {
  return canonicalJson(result);
}
